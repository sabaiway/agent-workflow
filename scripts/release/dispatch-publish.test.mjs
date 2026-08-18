import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  REPO_ROOT,
  EXIT,
  parseArgs,
  loadGhToken,
  parseOriginRepo,
  readTagTemplate,
  runDispatch,
  newestChangelogEntry,
  RELEASE_STUB_MARKER,
  NPM_VERIFY_ATTEMPTS,
  fetchJsonDefault,
  ghApiDefault,
  renderVerifyOnlyCommand,
  VERIFY_TRANSPORT_DEADLINE_MS,
  selectRemoteRef,
  describeDestination,
  ANCESTRY,
  probeAncestry,
  renderHeadMismatch,
} from './dispatch-publish.mjs';
import { runGitProcess, runProcess } from './git-process.mjs';
import { buildReceipt, SMOKE_RECEIPT_BASENAME, SMOKE_RECEIPT_SCHEMA } from './smoke-candidate.mjs';
import { buildGateReceipt, GATE_RECEIPT_BASENAME, GATE_RECEIPT_SCHEMA } from './cross-version-gate.mjs';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const REAL_KIT_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'agent-workflow-kit', 'package.json'), 'utf8')).version;

// ── a scripted world: gh REST + git + npm registry, fully hermetic ─────────────────────
// Runs appear after a dispatch POST; each run completes on the next poll with the scripted
// conclusion. Time is virtual (every now() call advances it), sleep is instant.

const makeWorld = ({
  conclusions = {}, // e.g. { 'memory:dry': 'success', 'kit:live': 'failure' }
  npmVersions = {}, // name → the version /latest reports
  releases = {}, // tag → { draft, assets: n }
  localVersions = {}, // package dir → the version its package.json carries (default: the real tree)
  changelogs = {}, // package dir → its CHANGELOG.md text (default: the real tree)
  dirtyTree = '',
  localHead = SHA,
  remoteSha = SHA,
  extraRunsOnDispatch = 0, // simulate ambiguous correlation
  neverCreateRun = false,
  stallRuns = false,
  ghAuthFails = false, // the auth preflight (`gh api user`) cannot authenticate
  ghUserTransport = false, // the auth preflight fails at the TRANSPORT layer (typed .transport)
  npmTransport = false, // the npm /latest lookup fails at the TRANSPORT layer (typed transportError)
  npmParseError = false, // the npm /latest lookup returns a reachable-but-unparseable body
  releaseTransport = false, // the GitHub Release lookup fails at the TRANSPORT layer (typed .transport)
  // The candidate-smoke receipt this world's git dir holds. Default = one that COVERS the candidate
  // (so every pre-existing row keeps testing what it was written to test); `null` = none on disk.
  smokeReceipt = undefined,
  // The cross-version gate receipt, same defaulting rule (Issue-016, the second receipt).
  crossVersionReceipt = undefined,
  // The two ancestry probes, which run on RAW process results. The defaults reproduce the world this
  // refusal was written in before AD-098: the remote tip is present locally AND an ancestor of HEAD,
  // i.e. a plain unpushed commit. Either may be given a raw result object instead, for the arms where
  // git returns no answer at all.
  remoteObject = 'present', // 'present' | 'tag' | 'unresolvable' | a raw {status, stdout, stderr, error, signal}
  remoteReaches = true, // merge-base --is-ancestor <peeled> <head> : true | false | a raw result
  headReached = false, // merge-base --is-ancestor <head> <peeled> : true | false | a raw result
  shallow = false, // rev-parse --is-shallow-repository : false | true | a raw result
  lsRemoteBody = null, // the whole `git ls-remote origin <ref>` stdout, when an arm needs an exact one
} = {}) => {
  const calls = { dispatches: [], gitArgs: [], gitRawArgs: [], fetches: [], fetchOpts: [], ghReqs: [] };
  const runs = [];
  let nextRunId = 100;
  let pendingRun = null;

  const ghApi = ({ method = 'GET', path, fields = {} } = {}, opts) => {
    calls.ghReqs.push({ path, opts });
    if (path === 'user') {
      if (ghUserTransport) throw Object.assign(new Error(typeof ghUserTransport === 'string' ? ghUserTransport : 'dial tcp: lookup api.github.com: no such host'), { transport: true });
      if (ghAuthFails === 'network') throw new Error('dial tcp: lookup api.github.com: no such host\nsecond line');
      if (ghAuthFails) throw new Error('gh: To get started with GitHub CLI, please run:  gh auth login\nsecond line');
      return { login: 'coder-tool' };
    }
    if (method === 'POST' && path.includes('/dispatches')) {
      const pkg = fields['inputs[package]'];
      const dry = fields['inputs[dry_run]'] === 'true';
      calls.dispatches.push({ pkg, dry, ref: fields.ref });
      if (!neverCreateRun) {
        const key = `${pkg}:${dry ? 'dry' : 'live'}`;
        for (let i = 0; i <= extraRunsOnDispatch; i += 1) {
          nextRunId += 1;
          runs.push({ id: nextRunId, head_sha: remoteSha, status: 'queued', key });
        }
        pendingRun = runs[runs.length - 1];
        pendingRun.conclusion = conclusions[key] ?? 'success';
      }
      return null;
    }
    if (path.includes('/actions/workflows/')) return { workflow_runs: runs.map((run) => ({ ...run })) };
    if (path.includes('/actions/runs/')) {
      const id = Number(path.split('/').pop());
      const run = runs.find((entry) => entry.id === id);
      if (!stallRuns) {
        run.status = 'completed';
      }
      return { id: run.id, status: run.status, conclusion: run.status === 'completed' ? run.conclusion : null, html_url: `https://runs/${id}` };
    }
    if (path.includes('/releases/tags/')) {
      if (releaseTransport) throw Object.assign(new Error('dial tcp: lookup api.github.com: no such host'), { transport: true });
      const tag = path.split('/releases/tags/')[1];
      const release = releases[tag];
      if (!release) return null;
      return { draft: release.draft ?? false, assets: Array.from({ length: release.assets ?? 1 }, (_, i) => ({ name: `asset${i}` })) };
    }
    throw new Error(`unscripted ghApi path: ${method} ${path}`);
  };

  const runGit = (args) => {
    calls.gitArgs.push(args.join(' '));
    const head = args.join(' ');
    if (head === 'remote get-url origin') return 'git@github.com:sabaiway/agent-workflow.git\n';
    if (head.startsWith('ls-remote')) {
      // ls-remote PATTERN-matches, so the fixture answers with the ref that was actually asked for;
      // `lsRemoteBody` overrides it wholesale for the ambiguity and malformed-line arms.
      const asked = args[2];
      return lsRemoteBody ?? `${remoteSha}\t${asked.startsWith('refs/') ? asked : `refs/heads/${asked}`}\n`;
    }
    if (head === 'status --porcelain') return dirtyTree;
    if (head === 'rev-parse HEAD') return `${localHead}\n`;
    if (head === 'rev-parse --absolute-git-dir') return `${join(REPO_ROOT, '.git')}\n`;
    throw new Error(`unscripted git: ${head}`);
  };

  // The raw-result lane (the lossless leaf in production). A result object is what the leaf returns;
  // returning a plain status here would let a test pass against a caller that never reads `error`.
  const rawResult = (status) => ({ status, stdout: '', stderr: '', error: null, signal: null });
  const runGitRaw = async (args, cwd) => {
    calls.gitRawArgs.push(args.join(' '));
    const line = args.join(' ');
    if (cwd !== REPO_ROOT) throw new Error(`the probes must run in the dispatch root, got ${cwd}`);
    // The guard's STDOUT is the peeled oid — 'present' peels to itself, 'tag' peels to the local
    // head (the annotated-tag shape ls-remote reports), and a raw result carries its own.
    if (line.startsWith('rev-parse --verify --quiet')) {
      if (typeof remoteObject === 'object') return remoteObject;
      if (remoteObject === 'unresolvable') return rawResult(1);
      return { status: 0, stdout: `${remoteObject === 'tag' ? localHead : remoteSha}\n`, stderr: '', error: null, signal: null };
    }
    // The two directions are DISTINCT scripted answers: a stub that returns one result for both is
    // exactly what let "behind" be reported as a divergence.
    if (line.startsWith('merge-base --is-ancestor') && args[3] === localHead) {
      return typeof remoteReaches === 'object' ? remoteReaches : rawResult(remoteReaches ? 0 : 1);
    }
    if (line.startsWith('merge-base --is-ancestor') && args[2] === localHead) {
      return typeof headReached === 'object' ? headReached : rawResult(headReached ? 0 : 1);
    }
    if (line === 'rev-parse --is-shallow-repository') {
      if (typeof shallow === 'object') return shallow;
      return { status: 0, stdout: `${shallow ? 'true' : 'false'}\n`, stderr: '', error: null, signal: null };
    }
    throw new Error(`unscripted raw git: ${line}`);
  };

  const receipt =
    smokeReceipt === undefined
      ? buildReceipt({
          kitVersion: localVersions['agent-workflow-kit'] ?? REAL_KIT_VERSION,
          headSha: localHead,
          dirty: false,
          packedFrom: 'repo',
          at: '2026-08-13T00:00:00.000Z',
        })
      : smokeReceipt;

  const gateReceipt =
    crossVersionReceipt === undefined
      ? buildGateReceipt({
          kitVersion: localVersions['agent-workflow-kit'] ?? REAL_KIT_VERSION,
          headSha: localHead,
          dirty: false,
          publishedVersion: '5.6.0',
          at: '2026-08-14T00:00:00.000Z',
        })
      : crossVersionReceipt;

  const fetchJson = async (url, opts) => {
    calls.fetches.push(url);
    calls.fetchOpts.push(opts);
    const name = decodeURIComponent(url.split('registry.npmjs.org/')[1].replace('/latest', '')).replace('%2F', '/');
    // npmTransport: true (all lookups) or a Set of names (per-package) — a typed transport failure.
    if (npmTransport === true || (npmTransport && typeof npmTransport.has === 'function' && npmTransport.has(name))) {
      return { transportError: 'dial tcp: registry.npmjs.org: no such host' };
    }
    if (npmParseError) return { parseError: 'Unexpected token < in JSON' };
    const version = npmVersions[name];
    return version ? { version } : { httpError: 404 };
  };

  const readFile = (path, enc) => {
    const str = String(path);
    if (str.endsWith(SMOKE_RECEIPT_BASENAME)) {
      if (receipt === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return JSON.stringify(receipt);
    }
    if (str.endsWith(GATE_RECEIPT_BASENAME)) {
      if (gateReceipt === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return JSON.stringify(gateReceipt);
    }
    if (str.endsWith('_publish-one.yml')) return readFileSync(join(REPO_ROOT, '.github/workflows/_publish-one.yml'), enc);
    const dirMatch = Object.keys(localVersions).find((dir) => str.endsWith(`${dir}/package.json`));
    if (dirMatch) return JSON.stringify({ name: `@sabaiway/${dirMatch}`, version: localVersions[dirMatch] });
    const changelogMatch = Object.keys(changelogs).find((dir) => str.endsWith(`${dir}/CHANGELOG.md`));
    if (changelogMatch) return changelogs[changelogMatch];
    return readFileSync(path, enc);
  };

  let clock = 0;
  const deps = {
    ghApi,
    runGit,
    runGitRaw,
    fetchJson,
    readFile,
    sleep: async () => {},
    now: () => {
      clock += 1000;
      return clock;
    },
    log: () => {},
    logError: (line) => calls.lastError = line,
    root: REPO_ROOT,
  };
  return { deps, calls };
};

// ── usage-level refusals (exit 2, nothing dispatched) ─────────────────────────────────

describe('parseArgs — ordering + safety refusals', () => {
  it('kit not last → refused', () => {
    assert.throws(() => parseArgs(['kit', 'memory']), (e) => e.exitCode === EXIT.usage && /kit must be LAST/.test(e.message));
  });

  it('"all" is accepted ALONE (one workflow run covers the family)', () => {
    const opts = parseArgs(['all']);
    assert.deepEqual(opts.packages, ['all']);
  });

  it('"all" mixed with named packages → refused (all must be alone)', () => {
    assert.throws(() => parseArgs(['all', 'kit']), (e) => e.exitCode === EXIT.usage && /"all" must be given ALONE/.test(e.message));
    assert.throws(() => parseArgs(['memory', 'all']), (e) => e.exitCode === EXIT.usage && /"all" must be given ALONE/.test(e.message));
  });

  it('--live all requires --expect for ALL THREE family packages', () => {
    assert.throws(
      () => parseArgs(['all', '--live', '--expect', 'kit=1.0.0', '--expect', 'engine=1.0.0']),
      (e) => e.exitCode === EXIT.usage && /missing: memory/.test(e.message),
    );
    const opts = parseArgs(['all', '--live', '--expect', 'memory=1.0.0', '--expect', 'engine=1.0.0', '--expect', 'kit=1.0.0']);
    assert.deepEqual(opts.packages, ['all']);
  });

  it('unknown / duplicate packages → refused', () => {
    assert.throws(() => parseArgs(['bridge']), (e) => e.exitCode === EXIT.usage);
    assert.throws(() => parseArgs(['memory', 'memory']), (e) => e.exitCode === EXIT.usage && /duplicate/.test(e.message));
  });

  it('--live without --expect for every package → refused', () => {
    assert.throws(
      () => parseArgs(['engine', 'kit', '--live', '--expect', 'kit=1.0.0']),
      (e) => e.exitCode === EXIT.usage && /missing: engine/.test(e.message),
    );
  });

  it('valid: engine memory kit with expectations, defaults filled', () => {
    const opts = parseArgs(['engine', 'memory', 'kit', '--expect', 'engine=1.0.0', '--expect', 'memory=1.0.0', '--expect', 'kit=1.0.0', '--live']);
    assert.deepEqual(opts.packages, ['engine', 'memory', 'kit']);
    assert.equal(opts.ref, 'main');
    assert.ok(opts.pollTimeoutS > 0);
  });
});

describe('tag derivation is READ from _publish-one.yml (never assumed)', () => {
  it('the real workflow file yields <dir>-v<version>', () => {
    const tagFor = readTagTemplate(readFileSync(join(REPO_ROOT, '.github/workflows/_publish-one.yml'), 'utf8'));
    assert.equal(tagFor('agent-workflow-kit', '1.27.0'), 'agent-workflow-kit-v1.27.0');
  });

  it('a workflow that stops deriving that tag → loud preflight failure', () => {
    assert.throws(() => readTagTemplate('name: x\n'), (e) => e.exitCode === EXIT.preflight && /no longer derives/.test(e.message));
  });

  it('parseOriginRepo handles ssh + https', () => {
    assert.equal(parseOriginRepo('git@github.com:sabaiway/agent-workflow.git'), 'sabaiway/agent-workflow');
    assert.equal(parseOriginRepo('https://github.com/sabaiway/agent-workflow'), 'sabaiway/agent-workflow');
  });
});

// ── Issue-007: the Release step's unchanged-package no-op branch (content invariants) ──
// The workflow branch itself can only be PROVEN by the next live publishing release (dry-run
// skips the Release step) — these pins hold the branch's SHAPE so a refactor cannot silently
// break invariant (a) "the no-op mutates nothing / downloads nothing" or (e) "a changed-but-
// unbumped package fails loudly" between now and that live proof.

describe('_publish-one.yml Release step — Issue-007 no-op branch invariants', () => {
  const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/_publish-one.yml'), 'utf8');
  const releaseStep = workflow.slice(workflow.indexOf('Create or repair the GitHub Release'));
  const stepLines = releaseStep.split('\n');
  const NOOP_MARKER = 'nothing to publish, nothing to repair';

  it('the no-op marker is a LIVE echo (not a comment) immediately followed by exit 0', () => {
    const markerLineIdx = stepLines.findIndex((line) => line.includes(NOOP_MARKER));
    assert.ok(markerLineIdx > -1, 'the no-op marker exists in the Release step');
    assert.ok(stepLines[markerLineIdx].trim().startsWith('echo'), 'the marker is a live echo, not a comment');
    const following = stepLines.slice(markerLineIdx + 1).map((line) => line.trim()).filter((line) => line !== '');
    assert.equal(following[0], 'exit 0', 'the stated no-op exits 0 right after the echo');
  });

  it('the no-op sits inside an already_published-conditioned branch', () => {
    const markerIdx = releaseStep.indexOf(NOOP_MARKER);
    const condIdx = releaseStep.indexOf(`if [ "\${{ steps.target.outputs.already_published }}" = "yes" ]`);
    assert.ok(condIdx > -1 && condIdx < markerIdx, 'the already_published condition precedes the no-op marker');
  });

  it('ordering: no-op marker BEFORE the repair-curl (dist.tarball) BEFORE the tag-move guard — invariant (a)', () => {
    const markerIdx = releaseStep.indexOf(NOOP_MARKER);
    const curlIdx = releaseStep.indexOf('dist.tarball');
    const guardIdx = releaseStep.indexOf('refusing to move it');
    assert.ok(markerIdx > -1 && curlIdx > -1 && guardIdx > -1, 'all three anchors exist');
    assert.ok(markerIdx < curlIdx, 'the no-op decision precedes the registry-tarball download — a no-op inserted after the download could never pass');
    assert.ok(curlIdx < guardIdx, 'the repair-curl still precedes the immutable-tag guard (existing shape preserved)');
  });

  it('the subtree comparison is WORKSPACE-ROOTED against an explicitly fetched tag commit', () => {
    const beforeMarker = releaseStep.slice(0, releaseStep.indexOf(NOOP_MARKER));
    assert.match(
      beforeMarker,
      /git -C "\$GITHUB_WORKSPACE" fetch --depth=1 origin "refs\/tags\/\$tag"/,
      'the shallow+tagless checkout fetches the tag commit explicitly',
    );
    assert.match(
      beforeMarker,
      /git -C "\$GITHUB_WORKSPACE" diff --quiet "\$noop_tag_sha" "\$GITHUB_SHA" -- "\$\{\{ inputs\.dir \}\}"/,
      'the diff runs from the workspace root with a root-relative pathspec (the working-directory trap)',
    );
  });

  it('a changed-but-unbumped package fails LOUDLY naming the package — invariant (e), never a silent success', () => {
    const markerIdx = releaseStep.indexOf(NOOP_MARKER);
    const refusalIdx = releaseStep.indexOf('CHANGED without a version bump');
    assert.ok(refusalIdx > markerIdx, 'the refusal is the else-arm of the same subtree decision');
    assert.ok(refusalIdx < releaseStep.indexOf('dist.tarball'), 'the refusal also precedes the repair path');
    const refusalLine = stepLines.find((line) => line.includes('CHANGED without a version bump'));
    assert.match(refusalLine, /::error::/, 'the refusal is a loud workflow error');
    assert.match(refusalLine, /\$\{\{ inputs\.dir \}\}/, 'the refusal names the offending package dir');
    const afterRefusal = stepLines.slice(stepLines.indexOf(refusalLine) + 1).map((line) => line.trim()).filter((line) => line !== '');
    assert.equal(afterRefusal[0], 'exit 1', 'the refusal exits non-zero');
  });
});

// ── flow-level invariants ──────────────────────────────────────────────────────────────

describe('runDispatch — dry-run phase gates the live phase', () => {
  it('happy path: all dry-runs first, then live in order, kit last; exit 0', async () => {
    const { deps, calls } = makeWorld({
      npmVersions: { '@sabaiway/agent-workflow-engine': '9.9.9', '@sabaiway/agent-workflow-kit': '9.9.8' },
      releases: { 'agent-workflow-engine-v9.9.9': { assets: 1 }, 'agent-workflow-kit-v9.9.8': { assets: 1 } },
      localVersions: { 'agent-workflow-engine': '9.9.9', 'agent-workflow-kit': '9.9.8' },
    });
    const code = await runDispatch(['engine', 'kit', '--live', '--expect', 'engine=9.9.9', '--expect', 'kit=9.9.8'], deps);
    assert.equal(code, EXIT.ok);
    assert.deepEqual(
      calls.dispatches.map((d) => `${d.pkg}:${d.dry ? 'dry' : 'live'}`),
      ['engine:dry', 'kit:dry', 'engine:live', 'kit:live'],
      'ALL dry-runs precede the FIRST live dispatch; order preserved; kit last',
    );
  });

  it('a failed dry-run (even the LAST) blocks EVERY live dispatch — never a partial release', async () => {
    const { deps, calls } = makeWorld({
      conclusions: { 'kit:dry': 'failure' },
      localVersions: { 'agent-workflow-engine': '1.0.0', 'agent-workflow-kit': '1.0.0' },
    });
    const code = await runDispatch(['engine', 'kit', '--live', '--expect', 'engine=1.0.0', '--expect', 'kit=1.0.0'], deps);
    assert.equal(code, EXIT.runFailed);
    assert.ok(calls.dispatches.every((d) => d.dry), `no live dispatch may happen: ${JSON.stringify(calls.dispatches)}`);
  });

  it('without --live only the dry-run phase runs', async () => {
    const { deps, calls } = makeWorld({});
    const code = await runDispatch(['memory'], deps);
    assert.equal(code, EXIT.ok);
    assert.deepEqual(calls.dispatches, [{ pkg: 'memory', dry: true, ref: 'main' }]);
  });
});

// ── the candidate-smoke preflight (Plan 2 Step 3.3) ───────────────────────────────────

describe('runDispatch — a kit-carrying dispatch needs a candidate smoke for THESE bytes', () => {
  const kitWorld = (overrides = {}) =>
    makeWorld({ localVersions: { 'agent-workflow-kit': '9.9.8', 'agent-workflow-engine': '9.9.9' }, ...overrides });

  it('no receipt at all → preflight refusal BEFORE any dispatch, dry-run included', async () => {
    const { deps, calls } = kitWorld({ smokeReceipt: null });
    const code = await runDispatch(['kit'], deps);
    assert.equal(code, EXIT.preflight);
    assert.deepEqual(calls.dispatches, [], 'the dry-run is what the release lane reads as publishable — it must not run either');
    assert.match(calls.lastError, /candidate smoke preflight: no candidate smoke receipt/);
    assert.match(calls.lastError, /smoke-candidate\.mjs/, 'the refusal carries the command that clears it');
  });

  it('a receipt for ANOTHER version or ANOTHER commit refuses, naming which', async () => {
    for (const [override, expected] of [
      [{ kitVersion: '1.0.0' }, /passed for kit 1\.0\.0/],
      [{ headSha: OTHER_SHA }, new RegExp(`passed at ${OTHER_SHA}`)],
    ]) {
      const receipt = buildReceipt({ kitVersion: '9.9.8', headSha: SHA, dirty: false, packedFrom: 'repo', at: 'x', ...override });
      const { deps, calls } = kitWorld({ smokeReceipt: receipt });
      assert.equal(await runDispatch(['kit'], deps), EXIT.preflight);
      assert.match(calls.lastError, expected);
      assert.deepEqual(calls.dispatches, []);
    }
  });

  it('a DIRTY-tree or hand-supplied receipt clears NO dispatch, dry-run included', async () => {
    // The dry-run's green is what the release lane reads as "the candidate is publishable", so both
    // rules about whether the smoked bytes ARE the candidate hold in both modes.
    for (const [override, expected] of [[{ dirty: true }, /DIRTY tree/], [{ packedFrom: 'supplied' }, /hand-supplied/]]) {
      const { deps, calls } = kitWorld({
        smokeReceipt: buildReceipt({ kitVersion: '9.9.8', headSha: SHA, dirty: false, packedFrom: 'repo', at: 'x', ...override }),
      });
      assert.equal(await runDispatch(['kit'], deps), EXIT.preflight);
      assert.match(calls.lastError, expected);
      assert.deepEqual(calls.dispatches, []);
    }
  });

  it('a dry-run whose LOCAL candidate is not the dispatched ref says so, and never claims it smoked those bytes', async () => {
    const { deps, calls } = kitWorld({
      localHead: OTHER_SHA,
      remoteSha: SHA,
      smokeReceipt: buildReceipt({ kitVersion: '9.9.8', headSha: OTHER_SHA, dirty: false, packedFrom: 'repo', at: 'x' }),
    });
    const lines = [];
    deps.log = (line) => lines.push(String(line));
    assert.equal(await runDispatch(['kit'], deps), EXIT.ok);
    const text = lines.join('\n');
    assert.match(text, new RegExp(`covers kit 9\\.9\\.8 at local HEAD ${OTHER_SHA}`));
    assert.match(text, new RegExp(`runs the REMOTE ref at ${SHA}`));
    assert.match(text, /says nothing about the dispatched bytes/);
    assert.deepEqual(calls.dispatches, [{ pkg: 'kit', dry: true, ref: 'main' }], 'the dry-run still runs — it is the CLAIM that is scoped, not the lane');
  });

  it('when the local candidate IS the dispatched ref the scope note is absent', async () => {
    const { deps } = kitWorld({});
    const lines = [];
    deps.log = (line) => lines.push(String(line));
    assert.equal(await runDispatch(['kit'], deps), EXIT.ok);
    assert.doesNotMatch(lines.join('\n'), /REMOTE ref/, 'there is nothing to scope when the two are the same commit');
  });

  it('a schema the dispatcher cannot read is a refusal, never a silent accept', async () => {
    const { deps, calls } = kitWorld({
      smokeReceipt: { ...buildReceipt({ kitVersion: '9.9.8', headSha: SHA, dirty: false, packedFrom: 'repo', at: 'x' }), schema: SMOKE_RECEIPT_SCHEMA + 1 },
    });
    assert.equal(await runDispatch(['kit'], deps), EXIT.preflight);
    assert.match(calls.lastError, /schema/);
  });

  it('`all` carries the kit, so it is gated the same way', async () => {
    const { deps, calls } = makeWorld({ smokeReceipt: null });
    assert.equal(await runDispatch(['all'], deps), EXIT.preflight);
    assert.deepEqual(calls.dispatches, []);
  });

  it('a dispatch that does NOT carry the kit is never gated — there is nothing to smoke', async () => {
    const { deps, calls } = makeWorld({ smokeReceipt: null });
    assert.equal(await runDispatch(['memory', 'engine'], deps), EXIT.ok);
    assert.deepEqual(calls.dispatches.map((d) => d.pkg), ['memory', 'engine']);
    assert.ok(!calls.gitArgs.includes('rev-parse --absolute-git-dir'), 'the receipt is not even looked for');
  });

  it('--verify-only performs zero dispatches, so it is never gated either', async () => {
    const { deps } = makeWorld({
      smokeReceipt: null,
      npmVersions: { '@sabaiway/agent-workflow-kit': '5.0.0' },
      releases: { 'agent-workflow-kit-v5.0.0': { assets: 1 } },
    });
    assert.equal(await runDispatch(['kit', '--verify-only', '--expect', 'kit=5.0.0'], deps), EXIT.ok);
  });

  it('a covering receipt is stated, and the flow proceeds', async () => {
    const { deps, calls } = kitWorld({});
    assert.equal(await runDispatch(['kit'], deps), EXIT.ok);
    assert.deepEqual(calls.dispatches, [{ pkg: 'kit', dry: true, ref: 'main' }]);
  });
});

// ── the cross-version gate preflight (Plan 3 Step 3.2 — Issue-016, the SECOND receipt) ─

describe('runDispatch — a kit-carrying dispatch needs a cross-version gate PASS for THESE bytes', () => {
  const kitWorld = (overrides = {}) =>
    makeWorld({ localVersions: { 'agent-workflow-kit': '9.9.8', 'agent-workflow-engine': '9.9.9' }, ...overrides });
  const covering = (over = {}) => ({
    ...buildGateReceipt({ kitVersion: '9.9.8', headSha: SHA, dirty: false, publishedVersion: '5.6.0', at: 'x' }),
    ...over,
  });

  it('no receipt at all → preflight refusal BEFORE any dispatch, dry-run included — the smoke alone clears nothing', async () => {
    const { deps, calls } = kitWorld({ crossVersionReceipt: null });
    const code = await runDispatch(['kit'], deps);
    assert.equal(code, EXIT.preflight);
    assert.deepEqual(calls.dispatches, [], 'the dry-run green is what the release lane reads as publishable — it must not run either');
    assert.match(calls.lastError, /cross-version gate preflight: no cross-version gate receipt/);
    assert.match(calls.lastError, /cross-version-gate\.mjs/, 'the refusal carries the command that clears it');
  });

  it('EVERY receipt field is validated — a positive and a negative case per field, never only the obvious three', async () => {
    // Positive per field: the covering receipt (every field right) dispatches, and so does one with
    // a DIFFERENT valid probed published version — that field is validated for FORM, not pinned.
    for (const receipt of [covering(), covering({ publishedVersion: '9.9.9' })]) {
      const { deps, calls } = kitWorld({ crossVersionReceipt: receipt });
      assert.equal(await runDispatch(['kit'], deps), EXIT.ok, calls.lastError);
    }
    const badRows = [
      [{ schema: GATE_RECEIPT_SCHEMA + 1 }, /schema/],
      [{ outcome: 'fail' }, /not a pass/],
      [{ kitVersion: '1.0.0' }, /passed for kit 1\.0\.0/],
      [{ headSha: OTHER_SHA }, new RegExp(`passed at ${OTHER_SHA}`)],
      [{ dirty: true }, /DIRTY tree/],
      [{ publishedVersion: 'latest' }, /malformed.*published/i],
      [{ publishedVersion: undefined }, /malformed.*published/i],
      [{ axes: undefined }, /schema-accept.*missing/],
      [{ axes: { 'schema-accept': 'pass', execution: 'pass' } }, /producer-recognition.*missing/],
      [{ axes: { 'schema-accept': 'pass', execution: 'fail', 'producer-recognition': 'pass' } }, /execution.*"fail"/],
    ];
    for (const [over, expected] of badRows) {
      const { deps, calls } = kitWorld({ crossVersionReceipt: covering(over) });
      assert.equal(await runDispatch(['kit'], deps), EXIT.preflight, `must refuse: ${JSON.stringify(over)}`);
      assert.match(calls.lastError, /cross-version gate preflight/);
      assert.match(calls.lastError, expected);
      assert.deepEqual(calls.dispatches, [], 'refused BEFORE any dispatch, the dry-run included');
    }
  });

  it('`all` carries the kit, so it is gated the same way', async () => {
    const { deps, calls } = makeWorld({ crossVersionReceipt: null });
    assert.equal(await runDispatch(['all'], deps), EXIT.preflight);
    assert.deepEqual(calls.dispatches, []);
  });

  it('a dispatch that does NOT carry the kit is never gated, and --verify-only performs zero dispatches', async () => {
    const named = makeWorld({ crossVersionReceipt: null });
    assert.equal(await runDispatch(['memory', 'engine'], named.deps), EXIT.ok);
    const verify = makeWorld({
      smokeReceipt: null,
      crossVersionReceipt: null,
      npmVersions: { '@sabaiway/agent-workflow-kit': '5.0.0' },
      releases: { 'agent-workflow-kit-v5.0.0': { assets: 1 } },
    });
    assert.equal(await runDispatch(['kit', '--verify-only', '--expect', 'kit=5.0.0'], verify.deps), EXIT.ok);
  });

  it('with BOTH receipts missing the candidate smoke is named first — the gate mirrors its wiring, second', async () => {
    const { deps, calls } = kitWorld({ smokeReceipt: null, crossVersionReceipt: null });
    assert.equal(await runDispatch(['kit'], deps), EXIT.preflight);
    assert.match(calls.lastError, /candidate smoke preflight/);
  });

  it('a covering receipt is stated in the log with the probed published version, and the flow proceeds', async () => {
    const { deps, calls } = kitWorld({});
    const lines = [];
    deps.log = (line) => lines.push(String(line));
    assert.equal(await runDispatch(['kit'], deps), EXIT.ok);
    assert.match(lines.join('\n'), /cross-version gate receipt covers kit 9\.9\.8.*published 5\.6\.0/);
    assert.deepEqual(calls.dispatches, [{ pkg: 'kit', dry: true, ref: 'main' }]);
  });
});

describe('runDispatch — the `all` flow (a 3-package family release = 2 workflow runs)', () => {
  const allWorld = () =>
    makeWorld({
      // kit is UNCHANGED this release: its expectation equals its current, already-published version.
      npmVersions: {
        '@sabaiway/agent-workflow-memory': '2.0.0',
        '@sabaiway/agent-workflow-engine': '2.1.0',
        '@sabaiway/agent-workflow-kit': '1.5.0',
      },
      releases: {
        'agent-workflow-memory-v2.0.0': { assets: 1 },
        'agent-workflow-engine-v2.1.0': { assets: 1 },
        'agent-workflow-kit-v1.5.0': { assets: 1 },
      },
      localVersions: { 'agent-workflow-memory': '2.0.0', 'agent-workflow-engine': '2.1.0', 'agent-workflow-kit': '1.5.0' },
    });

  it('dispatches exactly 2 runs (1 dry + 1 live), inputs[package]=all on both; verifies all 3 incl. the unchanged one', async () => {
    const { deps, calls } = allWorld();
    const code = await runDispatch(
      ['all', '--live', '--expect', 'memory=2.0.0', '--expect', 'engine=2.1.0', '--expect', 'kit=1.5.0'],
      deps,
    );
    assert.equal(code, EXIT.ok);
    assert.deepEqual(
      calls.dispatches,
      [
        { pkg: 'all', dry: true, ref: 'main' },
        { pkg: 'all', dry: false, ref: 'main' },
      ],
      'ONE dry-run dispatch then ONE live dispatch, the workflow receives package=all on both',
    );
    const verifiedNames = calls.fetches.map((url) => decodeURIComponent(url.split('registry.npmjs.org/')[1].replace('/latest', '')));
    assert.deepEqual(
      verifiedNames,
      ['@sabaiway/agent-workflow-memory', '@sabaiway/agent-workflow-engine', '@sabaiway/agent-workflow-kit'],
      'verifyPublished runs ×3 — the UNCHANGED kit is verified at its current version too',
    );
  });

  it('a failed all dry-run blocks the live dispatch entirely', async () => {
    const { deps, calls } = allWorld();
    const failing = makeWorld({
      conclusions: { 'all:dry': 'failure' },
      localVersions: { 'agent-workflow-memory': '2.0.0', 'agent-workflow-engine': '2.1.0', 'agent-workflow-kit': '1.5.0' },
    });
    const code = await runDispatch(
      ['all', '--live', '--expect', 'memory=2.0.0', '--expect', 'engine=2.1.0', '--expect', 'kit=1.5.0'],
      failing.deps,
    );
    assert.equal(code, EXIT.runFailed);
    assert.ok(failing.calls.dispatches.every((d) => d.dry), 'no live dispatch after a failed dry-run');
    assert.equal(calls.dispatches.length, 0, 'the fresh world stayed untouched (sanity)');
  });

  it('a stale --expect for ANY family package (incl. an unchanged one) blocks the live all before ANY dispatch', async () => {
    const { deps, calls } = allWorld();
    const code = await runDispatch(
      ['all', '--live', '--expect', 'memory=2.0.0', '--expect', 'engine=2.1.0', '--expect', 'kit=9.9.9'],
      deps,
    );
    assert.equal(code, EXIT.preflight);
    assert.match(calls.lastError, /stale expectation/);
    assert.deepEqual(calls.dispatches, []);
  });
});

describe('runDispatch — the RELEASE-STUB live-preflight gate (D4)', () => {
  const STUB_CHANGELOG = `# Changelog\n\n## 1.0.0 — ${RELEASE_STUB_MARKER} (bumped 2026-07-03 — replace with the real entry title)\n\n## 0.9.0 — Old\n\n- old\n`;

  it('a dispatched package whose CHANGELOG newest entry carries the stub → refused before ANY dispatch', async () => {
    const { deps, calls } = makeWorld({
      localVersions: { 'agent-workflow-memory': '1.0.0' },
      changelogs: { 'agent-workflow-memory': STUB_CHANGELOG },
    });
    const code = await runDispatch(['memory', '--live', '--expect', 'memory=1.0.0'], deps);
    assert.equal(code, EXIT.preflight);
    assert.match(calls.lastError, /CHANGELOG\.md newest entry still carries RELEASE-STUB/);
    assert.deepEqual(calls.dispatches, [], 'zero dispatches — the stub never reaches a live run');
  });

  it('a stub only in an OLDER entry does not block (the gate reads the NEWEST entry only)', async () => {
    const oldStub = `# Changelog\n\n## 1.0.0 — Real title\n\n- real\n\n## 0.9.0 — ${RELEASE_STUB_MARKER} historical\n\n- old\n`;
    const { deps } = makeWorld({
      npmVersions: { '@sabaiway/agent-workflow-memory': '1.0.0' },
      releases: { 'agent-workflow-memory-v1.0.0': { assets: 1 } },
      localVersions: { 'agent-workflow-memory': '1.0.0' },
      changelogs: { 'agent-workflow-memory': oldStub },
    });
    const code = await runDispatch(['memory', '--live', '--expect', 'memory=1.0.0'], deps);
    assert.equal(code, EXIT.ok);
  });

  it('a plain dry-run is NOT stub-gated (the gate is a live preflight)', async () => {
    const { deps } = makeWorld({ changelogs: { 'agent-workflow-memory': STUB_CHANGELOG } });
    const code = await runDispatch(['memory'], deps);
    assert.equal(code, EXIT.ok);
  });

  it('newestChangelogEntry isolates the first heading section', () => {
    assert.equal(newestChangelogEntry('# C\n\n## 2.0.0 — A\n\nbody\n\n## 1.0.0 — B\n'), '## 2.0.0 — A\n\nbody\n');
    assert.equal(newestChangelogEntry('# C\n\nno headings\n'), null);
  });
});

describe('--token-file — the flat token lane (INCIDENT 2026-07-21, second occurrence)', () => {
  it('parseArgs accepts --token-file <path> and requires its argument', () => {
    const opts = parseArgs(['all', '--token-file', '/secrets/x.pat']);
    assert.equal(opts.tokenFile, '/secrets/x.pat');
    assert.equal(parseArgs(['all']).tokenFile, null, 'absent flag stays null — env GH_TOKEN keeps working');
    assert.throws(() => parseArgs(['all', '--token-file']), (e) => e.exitCode === EXIT.usage && /--token-file requires/.test(e.message));
  });

  it('loadGhToken strips line endings (the documented tr -d semantics) and returns the token', () => {
    const token = loadGhToken('/secrets/x.pat', () => 'ghp_abc123\r\n');
    assert.equal(token, 'ghp_abc123');
    assert.equal(loadGhToken('/secrets/x.pat', () => '\nghp_two\n\n'), 'ghp_two', 'interior of a multi-line file collapses like tr -d');
  });

  it('an unreadable token file fails LOUD, naming the path and the lane', () => {
    assert.throws(
      () => loadGhToken('/secrets/absent.pat', () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
      (e) => e.exitCode === EXIT.usage && /--token-file/.test(e.message) && /\/secrets\/absent\.pat/.test(e.message) && /ENOENT/.test(e.message),
    );
  });

  it('an empty token file fails LOUD (an empty GH_TOKEN would earn gh\'s misleading auth error later)', () => {
    assert.throws(
      () => loadGhToken('/secrets/empty.pat', () => '\r\n\n'),
      (e) => e.exitCode === EXIT.usage && /empty/.test(e.message),
    );
  });

  it('runDispatch loads the token BEFORE the auth preflight and never logs its value', async () => {
    const priorToken = process.env.GH_TOKEN;
    try {
      delete process.env.GH_TOKEN;
      const { deps, calls } = makeWorld({ ghAuthFails: true });
      const seen = [];
      const ghApi = deps.ghApi;
      deps.ghApi = (...args) => {
        seen.push(process.env.GH_TOKEN);
        return ghApi(...args);
      };
      const realReadFile = deps.readFile;
      deps.readFile = (path, enc) => {
        if (path === '/secrets/x.pat') {
          assert.equal(enc, 'utf8');
          return 'ghp_secretvalue\n';
        }
        return realReadFile(path, enc);
      };
      const logged = [];
      deps.log = (line) => logged.push(line);
      await runDispatch(['memory', '--token-file', '/secrets/x.pat'], deps);
      assert.equal(seen[0], 'ghp_secretvalue', 'GH_TOKEN is set for the child gh calls before the first api use');
      const everything = [...logged, calls.lastError ?? ''].join('\n');
      assert.doesNotMatch(everything, /ghp_secretvalue/, 'the token value never reaches any output line');
    } finally {
      if (priorToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = priorToken;
    }
  });

  it('the auth-failure recovery now names the flat --token-file lane beside the export form', async () => {
    const { deps, calls } = makeWorld({ ghAuthFails: true });
    await runDispatch(['memory'], deps);
    assert.match(calls.lastError, /--token-file/, 'the recovery offers the lane that needs no env export');
  });
});

describe('runDispatch — GitHub auth preflight (the false-blocker fix)', () => {
  it('an unauthenticated gh fails LOUD before any dispatch, naming GH_TOKEN + env_commands.md', async () => {
    const { deps, calls } = makeWorld({ ghAuthFails: true });
    const code = await runDispatch(['memory'], deps);
    assert.equal(code, EXIT.preflight, 'auth failure is a preflight refusal, not a dispatch error');
    assert.equal(calls.dispatches.length, 0, 'NOTHING is dispatched when auth cannot be proven');
    assert.match(calls.lastError, /GH_TOKEN/, 'names the real auth mechanism');
    assert.match(calls.lastError, /env_commands\.md/, 'points at the documented recovery');
    assert.match(calls.lastError, /SKIPPED SETUP STEP|not a (publish )?blocker/i, 'reframes it as a skipped step, not a blocker');
  });

  it('the preflight runs for a plain dry-run too (every phase drives gh api)', async () => {
    const { deps, calls } = makeWorld({ ghAuthFails: true });
    const code = await runDispatch(['memory', '--expect', 'memory=1.0.0'], deps);
    assert.equal(code, EXIT.preflight);
    assert.equal(calls.dispatches.length, 0);
  });

  it('a NON-auth failure (network/outage) is NOT mislabeled a missing token — raw error preserved', async () => {
    const { deps, calls } = makeWorld({ ghAuthFails: 'network' });
    const code = await runDispatch(['memory'], deps);
    assert.equal(code, EXIT.preflight);
    assert.equal(calls.dispatches.length, 0);
    assert.match(calls.lastError, /could not be proven/, 'honest about uncertainty');
    assert.match(calls.lastError, /no such host/, 'preserves the raw failure');
    assert.doesNotMatch(calls.lastError, /SKIPPED SETUP STEP/, 'does not claim a skipped token for a network error');
  });

  it('the auth-failure message suppresses gh\'s RAW hint but keeps the project-specific correction', async () => {
    const { deps, calls } = makeWorld({ ghAuthFails: true });
    await runDispatch(['memory'], deps);
    // the raw gh line ("To get started… please run: gh auth login") must not surface…
    assert.doesNotMatch(calls.lastError, /To get started|please run/, 'the raw gh hint is suppressed');
    // …only the deliberate "NOT gh auth login" correction remains.
    assert.match(calls.lastError, /NOT `gh auth login`/, 'the project-specific correction stays');
  });
});

describe('runDispatch — live preflight refusals (before ANY dispatch)', () => {
  it('a dirty tree blocks live (exit 3, zero dispatches)', async () => {
    const { deps, calls } = makeWorld({ dirtyTree: ' M somefile\n', localVersions: { 'agent-workflow-memory': '1.0.0' } });
    const code = await runDispatch(['memory', '--live', '--expect', 'memory=1.0.0'], deps);
    assert.equal(code, EXIT.preflight);
    assert.deepEqual(calls.dispatches, []);
  });

  it('origin/<ref> ≠ local HEAD blocks live (exit 3, zero dispatches)', async () => {
    const { deps, calls } = makeWorld({ localHead: OTHER_SHA, localVersions: { 'agent-workflow-memory': '1.0.0' } });
    const code = await runDispatch(['memory', '--live', '--expect', 'memory=1.0.0'], deps);
    assert.equal(code, EXIT.preflight);
    assert.deepEqual(calls.dispatches, []);
  });

  it('a STALE --expect (≠ the local package.json version) blocks live before ANY dispatch', async () => {
    // The real repo tree is the fixture: agent-workflow-memory/package.json does not carry 0.0.1,
    // so the expectation is stale and must refuse with zero dispatches (never ship-then-fail).
    const { deps, calls } = makeWorld({});
    const code = await runDispatch(['memory', '--live', '--expect', 'memory=0.0.1'], deps);
    assert.equal(code, EXIT.preflight);
    assert.match(calls.lastError, /stale expectation/);
    assert.deepEqual(calls.dispatches, [], 'no dispatch after a stale expectation');
  });
});

describe('runDispatch — deterministic run correlation', () => {
  it('zero new runs inside the window → exit 5 (refuse, never guess)', async () => {
    const { deps } = makeWorld({ neverCreateRun: true });
    const code = await runDispatch(['memory'], deps);
    assert.equal(code, EXIT.correlation);
  });

  it('multiple new candidate runs → exit 5 (ambiguous)', async () => {
    const { deps } = makeWorld({ extraRunsOnDispatch: 1 });
    const code = await runDispatch(['memory'], deps);
    assert.equal(code, EXIT.correlation);
  });
});

describe('runDispatch — poll outcomes', () => {
  it('a run that never completes → exit 6 (poll timeout, bounded)', async () => {
    const { deps } = makeWorld({ stallRuns: true });
    const code = await runDispatch(['memory', '--poll-timeout', '1'], deps);
    assert.equal(code, EXIT.pollTimeout);
  });

  it('a run concluding failure → exit 7 with the run url', async () => {
    const { deps, calls } = makeWorld({ conclusions: { 'memory:dry': 'failure' } });
    const code = await runDispatch(['memory'], deps);
    assert.equal(code, EXIT.runFailed);
    assert.match(calls.lastError, /https:\/\/runs\//);
  });
});

describe('runDispatch — post-publish verification', () => {
  it('npm @latest never reaching the expected version → exit 8 after BOUNDED attempts', async () => {
    const { deps, calls } = makeWorld({
      npmVersions: { '@sabaiway/agent-workflow-memory': '0.0.1' },
      releases: { 'agent-workflow-memory-v1.0.0': { assets: 1 } },
      localVersions: { 'agent-workflow-memory': '1.0.0' },
    });
    const code = await runDispatch(['memory', '--live', '--expect', 'memory=1.0.0'], deps);
    assert.equal(code, EXIT.verify);
    assert.equal(calls.fetches.length, NPM_VERIFY_ATTEMPTS, 'retry is bounded');
  });

  it('a missing Release asset → exit 8 naming the tag', async () => {
    const { deps, calls } = makeWorld({
      npmVersions: { '@sabaiway/agent-workflow-memory': '1.0.0' },
      releases: { 'agent-workflow-memory-v1.0.0': { assets: 0 } },
      localVersions: { 'agent-workflow-memory': '1.0.0' },
    });
    const code = await runDispatch(['memory', '--live', '--expect', 'memory=1.0.0'], deps);
    assert.equal(code, EXIT.verify);
    assert.match(calls.lastError, /0 assets, expected exactly 1/);
  });

  it('a Release still in draft → exit 8', async () => {
    const { deps } = makeWorld({
      npmVersions: { '@sabaiway/agent-workflow-memory': '1.0.0' },
      releases: { 'agent-workflow-memory-v1.0.0': { draft: true, assets: 1 } },
      localVersions: { 'agent-workflow-memory': '1.0.0' },
    });
    const code = await runDispatch(['memory', '--live', '--expect', 'memory=1.0.0'], deps);
    assert.equal(code, EXIT.verify);
  });

  it('a gh api THROW on the Release fetch (404 propagation) → the precise exit 8, not the dispatch code', async () => {
    const { deps } = makeWorld({ npmVersions: { '@sabaiway/agent-workflow-memory': '1.0.0' }, localVersions: { 'agent-workflow-memory': '1.0.0' } });
    const inner = deps.ghApi;
    deps.ghApi = (req) => {
      if (req.path.includes('/releases/tags/')) throw Object.assign(new Error('gh api GET failed: 404'), { exitCode: EXIT.dispatch });
      return inner(req);
    };
    const code = await runDispatch(['memory', '--live', '--expect', 'memory=1.0.0'], deps);
    assert.equal(code, EXIT.verify, 'a failed Release lookup is a VERIFICATION failure');
  });
});

describe('exit codes are distinct per failure class', () => {
  it('dispatch/correlation/poll-timeout/verify/unreachable are five different codes', () => {
    assert.equal(new Set([EXIT.dispatch, EXIT.correlation, EXIT.pollTimeout, EXIT.verify, EXIT.unreachable]).size, 5);
  });
});

// ── DISPATCHER-NPM-VERIFY-SANDBOX (AD-056): typed transport → UNREACHABLE inconclusive + --verify-only ──

describe('T2a live concluded + UNREACHABLE npm verify → inconclusive (EXIT.unreachable) + recovery', () => {
  it('all: npm registry unreachable in-sandbox → inconclusive, publish itself concluded success', async () => {
    const { deps, calls } = makeWorld({
      npmTransport: true,
      localVersions: { 'agent-workflow-memory': '2.0.0', 'agent-workflow-engine': '2.1.0', 'agent-workflow-kit': '1.5.0' },
    });
    const code = await runDispatch(['all', '--live', '--expect', 'memory=2.0.0', '--expect', 'engine=2.1.0', '--expect', 'kit=1.5.0'], deps);
    assert.equal(code, EXIT.unreachable, 'the publish concluded; only the verify endpoint was unreachable');
    assert.ok(calls.dispatches.some((d) => !d.dry), 'the live dispatch actually ran (not a preflight refusal)');
    assert.match(calls.lastError, /INCONCLUSIVE/i);
    assert.match(calls.lastError, /concluded/i, 'names that the runs concluded success');
    assert.match(calls.lastError, /dial tcp|no such host|unreachable/i, 'names the unreachable endpoint cause');
    assert.match(calls.lastError, /--verify-only/, 'prints the verify-only recovery');
  });

  it('renderVerifyOnlyCommand is canonical for all three shapes (all · named list · explicit --repo)', () => {
    assert.equal(
      renderVerifyOnlyCommand(parseArgs(['all', '--expect', 'memory=2.0.0', '--expect', 'engine=2.1.0', '--expect', 'kit=1.5.0'])),
      'node scripts/release/dispatch-publish.mjs all --verify-only --expect memory=2.0.0 --expect engine=2.1.0 --expect kit=1.5.0',
    );
    assert.equal(
      renderVerifyOnlyCommand(parseArgs(['engine', 'kit', '--expect', 'engine=2.1.0', '--expect', 'kit=1.5.0'])),
      'node scripts/release/dispatch-publish.mjs engine kit --verify-only --expect engine=2.1.0 --expect kit=1.5.0',
    );
    assert.equal(
      renderVerifyOnlyCommand(parseArgs(['memory', '--repo', 'me/repo', '--expect', 'memory=2.0.0'])),
      'node scripts/release/dispatch-publish.mjs memory --verify-only --expect memory=2.0.0 --repo me/repo',
    );
  });
});

describe('T2b gh Release lookup transport failure at verify → the SAME inconclusive degrade', () => {
  it('never mislabels a transport failure as "missing Release"', async () => {
    const { deps, calls } = makeWorld({
      npmVersions: { '@sabaiway/agent-workflow-memory': '1.0.0' },
      releaseTransport: true,
      localVersions: { 'agent-workflow-memory': '1.0.0' },
    });
    const code = await runDispatch(['memory', '--live', '--expect', 'memory=1.0.0'], deps);
    assert.equal(code, EXIT.unreachable);
    assert.match(calls.lastError, /INCONCLUSIVE/i);
    assert.doesNotMatch(calls.lastError, /missing or still a draft|treating as missing/i, 'a transport failure is never "missing Release"');
  });
});

describe('T2c reachable verify failures stay LOUD (exit 8), never inconclusive', () => {
  it('a reachable version mismatch stays the bounded-retry path → exit 8', async () => {
    const { deps, calls } = makeWorld({
      npmVersions: { '@sabaiway/agent-workflow-memory': '0.0.1' },
      releases: { 'agent-workflow-memory-v1.0.0': { assets: 1 } },
      localVersions: { 'agent-workflow-memory': '1.0.0' },
    });
    const code = await runDispatch(['memory', '--live', '--expect', 'memory=1.0.0'], deps);
    assert.equal(code, EXIT.verify);
    assert.equal(calls.fetches.length, NPM_VERIFY_ATTEMPTS, 'a reachable mismatch retries to the bound (never short-circuits to unreachable)');
  });

  it('a reachable-but-malformed body (parse failure) is a LOUD verify failure, not unreachable', async () => {
    const { deps, calls } = makeWorld({ npmParseError: true, localVersions: { 'agent-workflow-memory': '1.0.0' } });
    const code = await runDispatch(['memory', '--live', '--expect', 'memory=1.0.0'], deps);
    assert.equal(code, EXIT.verify);
    assert.doesNotMatch(calls.lastError, /INCONCLUSIVE/i, 'a parse error is reachable — never inconclusive');
  });
});

describe('T2d --verify-only contract (D2)', () => {
  it('performs ZERO dispatches, no dry-run, skips the dispatch-only preflights (a reachable pkg → ok)', async () => {
    const { deps, calls } = makeWorld({
      npmVersions: { '@sabaiway/agent-workflow-memory': '1.0.0' },
      releases: { 'agent-workflow-memory-v1.0.0': { assets: 1 } },
      dirtyTree: ' M dirty\n', // would block --live; verify-only must SKIP the clean-tree gate
      localHead: OTHER_SHA, // would block --live; verify-only must SKIP ls-remote/head
    });
    const code = await runDispatch(['memory', '--verify-only', '--expect', 'memory=1.0.0'], deps);
    assert.equal(code, EXIT.ok, 'a reachable verified package → ok');
    assert.deepEqual(calls.dispatches, [], 'zero workflow dispatches in verify-only (no dry-run either)');
    assert.ok(!calls.gitArgs.some((a) => a.startsWith('ls-remote')), 'ls-remote (dispatch correlation) is skipped');
    assert.ok(!calls.gitArgs.some((a) => a === 'status --porcelain'), 'the clean-tree gate is skipped');
  });

  it('requires --expect for every verify target (like --live)', () => {
    assert.throws(() => parseArgs(['memory', '--verify-only']), (e) => e.exitCode === EXIT.usage && /--expect/.test(e.message));
    assert.throws(
      () => parseArgs(['all', '--verify-only', '--expect', 'memory=1.0.0', '--expect', 'engine=1.0.0']),
      (e) => e.exitCode === EXIT.usage && /missing: kit/.test(e.message),
    );
  });

  it('refuses --verify-only combined with --live (mutually exclusive)', () => {
    assert.throws(
      () => parseArgs(['memory', '--verify-only', '--live', '--expect', 'memory=1.0.0']),
      (e) => e.exitCode === EXIT.usage && /verify-only/i.test(e.message) && /live/i.test(e.message),
    );
  });

  it('a reachable verify failure in verify-only is still a LOUD exit 8', async () => {
    const { deps } = makeWorld({ npmVersions: { '@sabaiway/agent-workflow-memory': '0.0.1' } });
    const code = await runDispatch(['memory', '--verify-only', '--expect', 'memory=1.0.0'], deps);
    assert.equal(code, EXIT.verify);
  });

  it('an unreachable endpoint in verify-only is inconclusive (EXIT.unreachable)', async () => {
    const { deps } = makeWorld({ npmTransport: true });
    const code = await runDispatch(['memory', '--verify-only', '--expect', 'memory=1.0.0'], deps);
    assert.equal(code, EXIT.unreachable);
  });

  it('keeps the gh auth preflight; a TRANSPORT auth failure is INCONCLUSIVE in verify-only', async () => {
    const { deps, calls } = makeWorld({ ghUserTransport: true });
    const code = await runDispatch(['memory', '--verify-only', '--expect', 'memory=1.0.0'], deps);
    assert.equal(code, EXIT.unreachable, 'nothing conclusive was observed → inconclusive, not a red');
    assert.deepEqual(calls.dispatches, []);
  });

  it('an auth TRANSPORT failure stays a LOUD preflight red in live/dry', async () => {
    const { deps } = makeWorld({ ghUserTransport: true, localVersions: { 'agent-workflow-memory': '1.0.0' } });
    const code = await runDispatch(['memory'], deps); // dry-run
    assert.equal(code, EXIT.preflight, 'live/dry keep the loud auth preflight even for a transport failure');
  });

  it('an auth-shaped (401/login) failure is LOUD in EVERY mode incl. verify-only', async () => {
    const { deps } = makeWorld({ ghAuthFails: true });
    const code = await runDispatch(['memory', '--verify-only', '--expect', 'memory=1.0.0'], deps);
    assert.equal(code, EXIT.preflight, 'a 401/auth failure is never inconclusive');
  });
});

describe('T2e production adapters — typed transport classification (low-level injection)', () => {
  it('fetchJsonDefault types transport vs HTTP-status vs parse vs success', async () => {
    const dns = await fetchJsonDefault('https://x', { fetchImpl: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }); } });
    assert.ok(dns.transportError, 'a transport rejection is typed transportError');
    const http404 = await fetchJsonDefault('https://x', { fetchImpl: async () => ({ ok: false, status: 404 }) });
    assert.equal(http404.httpError, 404, 'an HTTP status is typed httpError (reachable), never transport');
    assert.ok(!http404.transportError);
    const malformed = await fetchJsonDefault('https://x', { fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } }) });
    assert.ok(malformed.parseError, 'a reachable-but-unparseable body (SyntaxError) is typed parseError, never transport');
    assert.ok(!malformed.transportError);
    const okRes = await fetchJsonDefault('https://x', { fetchImpl: async () => ({ ok: true, json: async () => ({ version: '9.9.9' }) }) });
    assert.equal(okRes.version, '9.9.9');
  });

  it('ghApiDefault keys on response-shape, not the exit code — DNS and HTTP-404 BOTH exit nonzero', () => {
    const dns = () => ghApiDefault({ path: 'repos/x/y/releases/tags/t' }, { spawnImpl: () => ({ status: 1, stdout: '', stderr: 'dial tcp: lookup api.github.com: no such host' }) });
    assert.throws(dns, (e) => e.transport === true, 'a gh transport failure (no HTTP response) is typed .transport');
    const notFound = () => ghApiDefault({ path: 'repos/x/y/releases/tags/t' }, { spawnImpl: () => ({ status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }) });
    assert.throws(notFound, (e) => !e.transport, 'a gh HTTP 404 (a status WAS observed) is reachable, never transport');
    const okRes = ghApiDefault({ path: 'repos/x/y/releases/tags/t' }, { spawnImpl: () => ({ status: 0, stdout: '{"draft":false,"assets":[]}' }) });
    assert.deepEqual(okRes, { draft: false, assets: [] });
  });
});

describe('T2f verify continuation + mixed outcomes (D3b)', () => {
  it('named list: an UNREACHABLE verify does NOT abort the next dispatch; inconclusive-only → inconclusive exit', async () => {
    const { deps, calls } = makeWorld({
      npmTransport: new Set(['@sabaiway/agent-workflow-memory']), // memory unreachable, engine reachable
      npmVersions: { '@sabaiway/agent-workflow-engine': '2.1.0' },
      releases: { 'agent-workflow-engine-v2.1.0': { assets: 1 } },
      localVersions: { 'agent-workflow-memory': '2.0.0', 'agent-workflow-engine': '2.1.0' },
    });
    const code = await runDispatch(['memory', 'engine', '--live', '--expect', 'memory=2.0.0', '--expect', 'engine=2.1.0'], deps);
    assert.equal(code, EXIT.unreachable, 'inconclusive-only → inconclusive exit');
    assert.deepEqual(
      calls.dispatches.filter((d) => !d.dry).map((d) => d.pkg),
      ['memory', 'engine'],
      'engine was STILL dispatched after memory verify was unreachable',
    );
    assert.match(calls.lastError, /--verify-only/, 'the recovery is printed');
  });

  it('all mode: remaining verifies STILL run after an unreachable; a later REACHABLE-RED dominates (exit 8)', async () => {
    const { deps, calls } = makeWorld({
      npmTransport: new Set(['@sabaiway/agent-workflow-memory']), // memory unreachable...
      npmVersions: { '@sabaiway/agent-workflow-engine': '9.9.9', '@sabaiway/agent-workflow-kit': '1.5.0' }, // engine wrong (red), kit ok
      releases: { 'agent-workflow-kit-v1.5.0': { assets: 1 } },
      localVersions: { 'agent-workflow-memory': '2.0.0', 'agent-workflow-engine': '2.1.0', 'agent-workflow-kit': '1.5.0' },
    });
    const code = await runDispatch(['all', '--live', '--expect', 'memory=2.0.0', '--expect', 'engine=2.1.0', '--expect', 'kit=1.5.0'], deps);
    assert.equal(code, EXIT.verify, 'a reachable-verify red dominates the inconclusive code');
    const verifiedNames = calls.fetches.map((u) => decodeURIComponent(u.split('registry.npmjs.org/')[1].replace('/latest', '')));
    assert.ok(verifiedNames.includes('@sabaiway/agent-workflow-kit'), 'kit was STILL verified after memory unreachable + engine red');
    assert.match(calls.lastError, /INCONCLUSIVE/i, 'the message still enumerates the inconclusive memory');
    assert.match(calls.lastError, /--verify-only/, 'and the recovery');
  });
});

describe('T2g verify-stage transport deadlines (D3a)', () => {
  it('fetchJsonDefault: a hanging fetch hits the deadline → transportError (never a hang)', async () => {
    const hangingFetch = (url, { signal } = {}) => new Promise((_, reject) => {
      if (signal) signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const res = await fetchJsonDefault('https://x', { deadlineMs: 5, fetchImpl: hangingFetch });
    assert.ok(res.transportError, 'a hung fetch is bounded → transportError');
    assert.match(res.transportError, /timeout/i);
  });

  it('ghApiDefault: a spawn timeout (SIGTERM/ETIMEDOUT) classifies as transport (never a hang)', () => {
    const timedOutSpawn = () => ({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' });
    assert.throws(() => ghApiDefault({ path: 'repos/x/y/releases/tags/t' }, { deadlineMs: 5, spawnImpl: timedOutSpawn }), (e) => e.transport === true);
  });

  it('every verify-stage lookup carries a transport deadline; the retry loop has a finite total bound', async () => {
    const { deps, calls } = makeWorld({
      npmVersions: { '@sabaiway/agent-workflow-memory': '1.0.0' },
      releases: { 'agent-workflow-memory-v1.0.0': { assets: 1 } },
    });
    await runDispatch(['memory', '--verify-only', '--expect', 'memory=1.0.0'], deps);
    assert.ok(calls.fetchOpts.length > 0 && calls.fetchOpts.every((o) => o && o.deadlineMs > 0), 'every npm fetch carries a transport deadline');
    const releaseReq = calls.ghReqs.find((r) => r.path.includes('/releases/tags/'));
    assert.ok(releaseReq && releaseReq.opts && releaseReq.opts.deadlineMs > 0, 'the gh Release lookup carries a transport deadline');
    assert.ok(Number.isFinite(NPM_VERIFY_ATTEMPTS * VERIFY_TRANSPORT_DEADLINE_MS) && VERIFY_TRANSPORT_DEADLINE_MS > 0, 'the retry loop has a finite total transport bound');
  });
});

// ── R2 folds (first-round review majors on dispatch-publish.mjs, RED-first) ─────────────
describe('R2 folds — first-round review majors on the dispatcher', () => {
  it('R2-M1 verify-only auth preflight carries a transport deadline', async () => {
    const { deps, calls } = makeWorld({
      npmVersions: { '@sabaiway/agent-workflow-memory': '1.0.0' },
      releases: { 'agent-workflow-memory-v1.0.0': { assets: 1 } },
    });
    await runDispatch(['memory', '--verify-only', '--expect', 'memory=1.0.0'], deps);
    const userReq = calls.ghReqs.find((r) => r.path === 'user');
    assert.ok(userReq, 'the auth preflight was called');
    assert.ok(userReq.opts && userReq.opts.deadlineMs > 0, 'the verify-only auth preflight passes a transport deadline (cannot hang)');
  });

  it('R2-M2 transport classification keys on absent HTTP status', () => {
    // A nonzero gh with NO observed HTTP status is a TRANSPORT failure regardless of the error phrasing —
    // never a narrow allowlist of error strings (a connection-reset / x509 failure has no status).
    const reset = () => ghApiDefault({ path: 'x' }, { spawnImpl: () => ({ status: 1, stdout: '', stderr: 'connection reset by peer' }) });
    assert.throws(reset, (e) => e.transport === true, 'connection-reset (no HTTP status) is transport, not a false loud red');
    const x509 = () => ghApiDefault({ path: 'x' }, { spawnImpl: () => ({ status: 1, stdout: '', stderr: 'x509: certificate signed by unknown authority' }) });
    assert.throws(x509, (e) => e.transport === true, 'x509 (no HTTP status) is transport');
    const notFound = () => ghApiDefault({ path: 'x' }, { spawnImpl: () => ({ status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }) });
    assert.throws(notFound, (e) => e.transport !== true, 'an observed HTTP status is reachable, never transport');
  });

  it('R2-M3 a local gh spawn error is loud not unreachable', () => {
    const enoent = () => ghApiDefault({ path: 'x' }, { spawnImpl: () => ({ error: Object.assign(new Error('spawnSync gh ENOENT'), { code: 'ENOENT' }), status: null }) });
    assert.throws(enoent, (e) => e.transport !== true, 'gh-not-found is a LOCAL error, never a network transport failure (would falsely say UNREACHABLE)');
  });

  it('R2-M4 a reachable verify red stops the named-list dispatch', async () => {
    const { deps, calls } = makeWorld({
      npmVersions: { '@sabaiway/agent-workflow-memory': '0.0.1' }, // memory published WRONG version → reachable red
      localVersions: { 'agent-workflow-memory': '2.0.0', 'agent-workflow-engine': '2.1.0' },
    });
    const code = await runDispatch(['memory', 'engine', '--live', '--expect', 'memory=2.0.0', '--expect', 'engine=2.1.0'], deps);
    assert.equal(code, EXIT.verify);
    assert.deepEqual(
      calls.dispatches.filter((d) => !d.dry).map((d) => d.pkg),
      ['memory'],
      'engine is NOT dispatched after memory verify failed — a reachable red stops the named flow (continuation was for inconclusive only)',
    );
  });

  it('R2-M5 a dispatch failure finalizes with accumulated outcomes', async () => {
    const { deps, calls } = makeWorld({
      npmTransport: new Set(['@sabaiway/agent-workflow-memory']), // memory verify UNREACHABLE (accumulated)
      conclusions: { 'engine:live': 'failure' }, // engine LIVE dispatch then fails
      localVersions: { 'agent-workflow-memory': '2.0.0', 'agent-workflow-engine': '2.1.0' },
    });
    const code = await runDispatch(['memory', 'engine', '--live', '--expect', 'memory=2.0.0', '--expect', 'engine=2.1.0'], deps);
    assert.equal(code, EXIT.runFailed, 'the dispatch-failure exit code dominates and is preserved');
    assert.match(calls.lastError, /memory/, 'the accumulated inconclusive is enumerated, never lost to the outer catch');
    assert.match(calls.lastError, /--verify-only/, 'the --verify-only recovery is preserved');
  });

  it('R2-M6 verify-only finalizer wording never claims publish', async () => {
    const logs = [];
    const { deps } = makeWorld({
      npmVersions: { '@sabaiway/agent-workflow-memory': '1.0.0' },
      releases: { 'agent-workflow-memory-v1.0.0': { assets: 1 } },
    });
    deps.log = (line) => logs.push(line);
    const code = await runDispatch(['memory', '--verify-only', '--expect', 'memory=1.0.0'], deps);
    assert.equal(code, EXIT.ok);
    const text = logs.join('\n');
    assert.doesNotMatch(text, /published|publish concluded/i, 'verify-only never claims a publish it did not perform');
    assert.match(text, /verif/i, 'it states the verify result');
  });
});

// ── R3 folds (second-round review majors on the dispatcher, RED-first) ──────────────────
describe('R3 folds — second-round review majors on the dispatcher', () => {
  it('R3-B recovery command lists only inconclusive packages', async () => {
    // named list [memory, engine, kit]: memory verify UNREACHABLE, engine LIVE dispatch then FAILS,
    // kit never dispatched. The recovery must re-verify ONLY memory (published + inconclusive) — listing
    // engine/kit (un-published tail) would guarantee false verify-reds on the re-run.
    const { deps, calls } = makeWorld({
      npmTransport: new Set(['@sabaiway/agent-workflow-memory']),
      conclusions: { 'engine:live': 'failure' },
      localVersions: { 'agent-workflow-memory': '2.0.0', 'agent-workflow-engine': '2.1.0', 'agent-workflow-kit': '1.5.0' },
    });
    const code = await runDispatch(['memory', 'engine', 'kit', '--live', '--expect', 'memory=2.0.0', '--expect', 'engine=2.1.0', '--expect', 'kit=1.5.0'], deps);
    assert.equal(code, EXIT.runFailed);
    const recovery = calls.lastError.match(/dispatch-publish\.mjs [^\n·]*--verify-only[^\n·]*/);
    assert.ok(recovery, 'a --verify-only recovery command is printed');
    assert.match(recovery[0], /memory --verify-only --expect memory=2\.0\.0/, 'lists memory (the published + inconclusive package)');
    assert.doesNotMatch(recovery[0], /\bengine\b|\bkit\b/, 'never lists the un-published tail packages');
  });

  it('R3-C a --repo with shell metacharacters is rejected', () => {
    for (const bad of ['me/repo;echo evil', 'me/repo && evil', 'me/repo`evil`', 'me/$(evil)', 'me repo', 'me/repo|cat']) {
      assert.throws(
        () => parseArgs(['memory', '--repo', bad, '--verify-only', '--expect', 'memory=1.0.0']),
        (e) => e.exitCode === EXIT.usage,
        `rejects --repo "${bad}" (it is rendered into a copy-paste recovery command)`,
      );
    }
    const ok = parseArgs(['memory', '--repo', 'sabaiway/agent-workflow', '--verify-only', '--expect', 'memory=1.0.0']);
    assert.equal(ok.repo, 'sabaiway/agent-workflow', 'a plain owner/name is accepted');
  });

  it('R4-A a transport error whose message merely contains auth is inconclusive not an auth red', async () => {
    // x509 "…unknown authority" / a DNS error is a TYPED transport failure — a broad /auth/ substring
    // match must never mislabel it an auth red (exit 3) instead of the verify-only inconclusive (exit 9).
    const { deps, calls } = makeWorld({ ghUserTransport: 'x509: certificate signed by unknown authority' });
    const code = await runDispatch(['memory', '--verify-only', '--expect', 'memory=1.0.0'], deps);
    assert.equal(code, EXIT.unreachable, 'a typed transport error is never mislabeled auth by a broad substring');
    assert.doesNotMatch(calls.lastError, /SKIPPED SETUP STEP|GH_TOKEN/, 'not the auth recovery message');
  });

  it('R4-B the auth-preflight transport inconclusive prints the canonical --verify-only recovery command', async () => {
    const { deps, calls } = makeWorld({ ghUserTransport: true });
    const code = await runDispatch(['memory', '--verify-only', '--expect', 'memory=1.0.0'], deps);
    assert.equal(code, EXIT.unreachable);
    assert.match(calls.lastError, /node scripts\/release\/dispatch-publish\.mjs memory --verify-only --expect memory=1\.0\.0/, 'the exact recovery command with target + --expect');
  });

  it('R3-D fetchJsonDefault classifies a mid-body abort or stream failure as transport not parseError', async () => {
    // res.json() rejecting AFTER headers — the deadline fired mid-body (AbortError), or the body stream
    // dropped — is a TRANSPORT failure, never a false reachable parseError (exit 8). Only a genuine
    // malformed body (SyntaxError) stays parseError.
    const abort = await fetchJsonDefault('https://x', { deadlineMs: 5, fetchImpl: async () => ({ ok: true, json: async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); } }) });
    assert.ok(abort.transportError, 'a mid-body abort is transport, not a malformed-body parseError');
    assert.ok(!abort.parseError);
    const streamDrop = await fetchJsonDefault('https://x', { fetchImpl: async () => ({ ok: true, json: async () => { throw Object.assign(new Error('terminated'), { code: 'UND_ERR_SOCKET' }); } }) });
    assert.ok(streamDrop.transportError, 'a body-stream drop after headers is transport');
    const malformed = await fetchJsonDefault('https://x', { fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } }) });
    assert.ok(malformed.parseError, 'a genuine JSON SyntaxError stays parseError (reachable red)');
    assert.ok(!malformed.transportError);
  });
});

// ── AD-098: the head-mismatch refusal names WHICH mismatch ────────────────────────────
// Every row here is RED against the pre-fix function, which had ONE message for all of these
// states: "the approved release commit must be pushed first". On a branch that cannot fast-forward
// that sentence is not merely late, it is wrong guidance — a plain push cannot succeed.

describe('AD-098 — the live preflight names WHICH mismatch it observed', () => {
  const liveArgs = ['memory', '--live', '--expect', 'memory=1.0.0'];
  const liveWorld = (extra) => makeWorld({ localHead: OTHER_SHA, localVersions: { 'agent-workflow-memory': '1.0.0' }, ...extra });
  const GUARD = `rev-parse --verify --quiet ${SHA}^{commit}`;
  const REACHES = `merge-base --is-ancestor ${SHA} ${OTHER_SHA}`;
  const REACHED = `merge-base --is-ancestor ${OTHER_SHA} ${SHA}`;
  const COMPLETE = 'rev-parse --is-shallow-repository';

  it('every probe addresses the CAPTURED head oid — never the mutable HEAD', async () => {
    // RED against: `merge-base --is-ancestor <sha> HEAD`. A concurrent checkout between two probes
    // would classify a commit the refusal does not name, and the operator would act on the wrong one.
    const { deps, calls } = liveWorld({ remoteReaches: false, headReached: true });
    assert.equal(await runDispatch(liveArgs, deps), EXIT.preflight);
    assert.deepEqual(calls.gitRawArgs, [GUARD, REACHES, REACHED]);
    assert.ok(!calls.gitRawArgs.some((line) => line.split(' ').includes('HEAD')), 'no probe re-reads HEAD');
  });

  it('the remote tip IS an ancestor of HEAD — the unchanged "must be pushed first" message', async () => {
    // RED against: a fix that rewrites every arm and loses the one case where pushing IS the remedy.
    const { deps, calls } = liveWorld({});
    assert.equal(await runDispatch(liveArgs, deps), EXIT.preflight);
    assert.match(calls.lastError, /the approved release commit must be pushed first/);
    assert.ok(!/DIVERGED|preflight-remote/.test(calls.lastError), 'an unpushed commit is not sent to step 1');
    assert.deepEqual(calls.gitRawArgs, [GUARD, REACHES], 'the object guard runs first, and one positive answer ends it');
    assert.deepEqual(calls.dispatches, []);
  });

  it('the reported id PEELS to the local head — an annotated tag, not an unpushed commit', async () => {
    // RED against: discarding the guard's stdout. `ls-remote` reports the object a ref points AT,
    // which for an annotated tag is the tag object; classifying the tag id as a commit makes the
    // refusal say a commit is unpushed when the remote already carries exactly this commit.
    const { deps, calls } = liveWorld({ remoteObject: 'tag' });
    assert.equal(await runDispatch(liveArgs, deps), EXIT.preflight);
    assert.match(calls.lastError, /RESOLVES TO the local HEAD/);
    assert.match(calls.lastError, /mismatch is one of ref\n?\s*TYPE/);
    assert.ok(!/must be pushed first|DIVERGED/.test(calls.lastError), 'nothing is unpushed here');
    assert.deepEqual(calls.gitRawArgs, [GUARD], 'once the peeled oid IS the head, there is no ancestry left to probe');
    assert.deepEqual(calls.dispatches, [], 'the refusal and the exit code are unchanged — only the reason is honest');
  });

  it('the PEELED oid, not the reported id, is what the ancestry probes receive', async () => {
    // RED against: probing the tag object. merge-base peels its arguments today, but the refusal
    // would still be reasoning about an id it never verified is a commit.
    const peeled = 'c'.repeat(40);
    const { deps, calls } = liveWorld({
      remoteObject: { status: 0, stdout: `${peeled}\n`, stderr: '', error: null, signal: null },
      remoteReaches: false,
      headReached: false,
    });
    assert.equal(await runDispatch(liveArgs, deps), EXIT.preflight);
    assert.deepEqual(calls.gitRawArgs, [
      GUARD,
      `merge-base --is-ancestor ${peeled} ${OTHER_SHA}`,
      `merge-base --is-ancestor ${OTHER_SHA} ${peeled}`,
      COMPLETE,
    ]);
  });

  it('a guard that answers 0 with something that is not an object id is undetermined', async () => {
    // RED against: trusting stdout blindly and then feeding a non-oid into merge-base.
    const { deps, calls } = liveWorld({ remoteObject: { status: 0, stdout: 'not-an-oid\n', stderr: '', error: null, signal: null } });
    assert.equal(await runDispatch(liveArgs, deps), EXIT.preflight);
    assert.match(calls.lastError, /which is not one object id of this repository's width/);
    assert.deepEqual(calls.gitRawArgs, [GUARD], 'a non-oid is never handed to merge-base as an operand');
  });

  it('a guard that answers 0 with an EMPTY or MULTI-LINE body is undetermined too', async () => {
    // RED against: `firstLine(stdout)`, which would silently take the first of several ids.
    for (const stdout of ['', '\n', `${SHA}\n${OTHER_SHA}\n`, `${'a'.repeat(39)}\n`, `\n${SHA}\n`, `${SHA}\n\n`, ` ${SHA}\n`, `${SHA}`]) {
      const { deps, calls } = liveWorld({ remoteObject: { status: 0, stdout, stderr: '', error: null, signal: null } });
      assert.equal(await runDispatch(liveArgs, deps), EXIT.preflight, JSON.stringify(stdout));
      if (stdout === `${SHA}`) {
        // The ONE accepted shape besides `<oid>\n`: git's own output when nothing appended a newline.
        assert.match(calls.lastError, /must be pushed first/, 'a bare <oid> with no trailing newline is the same answer');
      } else {
        assert.match(calls.lastError, /which is not one object id of this repository's width/, JSON.stringify(stdout));
        assert.deepEqual(calls.gitRawArgs, [GUARD], JSON.stringify(stdout));
      }
    }
  });

  it('HEAD is contained in the remote tip — BEHIND, and it is not called a divergence', async () => {
    // RED against: reading exit 1 from ONE direction as a fork. A branch that is merely behind
    // answers exit 1 there too, and calling that a DIVERGENCE is the same false claim in a new place.
    const { deps, calls } = liveWorld({ remoteReaches: false, headReached: true });
    assert.equal(await runDispatch(liveArgs, deps), EXIT.preflight);
    assert.match(calls.lastError, /the remote is AHEAD of this branch/);
    assert.match(calls.lastError, /node scripts\/release\/preflight-remote\.mjs --ref 'main'/);
    assert.ok(!/DIVERGED|must be pushed first/.test(calls.lastError), 'behind is neither a fork nor an unpushed commit');
    assert.deepEqual(calls.gitRawArgs, [GUARD, REACHES, REACHED], 'the reverse probe is what separates behind from a fork');
    assert.deepEqual(calls.dispatches, []);
  });

  it('neither commit reaches the other, in a WHOLE repository — a DIVERGENCE, named as one', async () => {
    // RED against: the pre-fix single message, which told the operator to push a branch that cannot.
    const { deps, calls } = liveWorld({ remoteReaches: false, headReached: false });
    assert.equal(await runDispatch(liveArgs, deps), EXIT.preflight);
    assert.match(calls.lastError, /neither commit reaches the other/);
    assert.match(calls.lastError, /has DIVERGED/);
    assert.match(calls.lastError, /node scripts\/release\/preflight-remote\.mjs --ref 'main'/);
    assert.ok(!/must be pushed first/.test(calls.lastError), 'pushing is NOT the remedy here — saying so was the AD-098 defect');
    assert.deepEqual(calls.gitRawArgs, [GUARD, REACHES, REACHED, COMPLETE], 'the completeness of the graph is checked before the verdict');
    assert.deepEqual(calls.dispatches, []);
  });

  it('the same two answers in a SHALLOW clone are their OWN outcome, not a broken probe', async () => {
    // RED against: claiming a fork from two exit-1 answers; and against filing shallow under the
    // process-failure arm, whose text tells the operator to re-run "once git answers" — git DID
    // answer, and the answer was that this question cannot be settled here.
    const { deps, calls } = liveWorld({ remoteReaches: false, headReached: false, shallow: true });
    assert.equal(await runDispatch(liveArgs, deps), EXIT.preflight);
    assert.match(calls.lastError, /this repository is SHALLOW/);
    assert.match(calls.lastError, /not a broken probe — git answered/);
    assert.ok(!/has DIVERGED/.test(calls.lastError), 'a truncated graph is not evidence of a fork');
    assert.ok(!/could NOT be determined|once git answers/.test(calls.lastError), 'shallow is not filed as an unanswered probe');
    // The deepen command this arm hands the operator is bound to the remote, exactly as the sibling
    // refusal in preflight-remote is: the two scripts print the same remedy for the same condition,
    // and a bare form would resolve through the branch's configured remote instead. RED against a
    // bare `git fetch --unshallow` in either emitter.
    assert.match(calls.lastError, /git fetch --unshallow origin\b/);
    assert.ok(!/git fetch --unshallow(?! origin\b)/.test(calls.lastError), 'no unbound deepen form is printed');
    assert.deepEqual(calls.gitRawArgs, [GUARD, REACHES, REACHED, COMPLETE]);
  });

  it('the shallowness answer is read EXACTLY — padding or extra lines never become a verdict', async () => {
    // RED against: `firstLine(stdout)` or `.trim()`. Either accepts `false ` and `false\nnoise`, so a
    // malformed body becomes a confident DIVERGENCE here while preflight-remote refuses the same
    // bytes — the two scripts disagreeing about the one question that gates a force-push remedy.
    for (const stdout of ['perhaps\n', 'false ', ' false\n', 'false\nnoise\n', 'true\ntrue\n', '', '\n', 'FALSE\n']) {
      const { deps, calls } = liveWorld({ remoteReaches: false, headReached: false, shallow: { status: 0, stdout, stderr: '', error: null, signal: null } });
      assert.equal(await runDispatch(liveArgs, deps), EXIT.preflight, JSON.stringify(stdout));
      assert.match(calls.lastError, /when asked whether this repository is shallow/, JSON.stringify(stdout));
      assert.ok(!/has DIVERGED|is SHALLOW/.test(calls.lastError), `${JSON.stringify(stdout)} is not a verdict`);
    }
    // And the two shapes git actually prints ARE answers, with or without the newline.
    for (const [stdout, expected] of [['false\n', /has DIVERGED/], ['false', /has DIVERGED/], ['true\n', /is SHALLOW/], ['true', /is SHALLOW/]]) {
      const { deps, calls } = liveWorld({ remoteReaches: false, headReached: false, shallow: { status: 0, stdout, stderr: '', error: null, signal: null } });
      assert.equal(await runDispatch(liveArgs, deps), EXIT.preflight, JSON.stringify(stdout));
      assert.match(calls.lastError, expected, JSON.stringify(stdout));
    }
  });

  it('the remote tip does not resolve to a commit here — the observation, and nothing beyond it', async () => {
    // RED against: an unguarded `merge-base --is-ancestor`, which on an unresolvable object dies with
    // exit 128 `fatal: Not a valid commit name`; and against promising that a fetch settles it, when
    // exit 1 here equally covers an object that EXISTS and is simply not a commit.
    const { deps, calls } = liveWorld({ remoteObject: 'unresolvable' });
    assert.equal(await runDispatch(liveArgs, deps), EXIT.preflight);
    assert.deepEqual(calls.gitRawArgs, [GUARD], 'no ancestry probe is ever reached');
    assert.match(calls.lastError, /does not resolve to a commit in this clone/);
    assert.match(calls.lastError, /nothing here says WHY/);
    assert.ok(!/the remote moved|object database/.test(calls.lastError), 'the stronger claim was never observed');
    assert.ok(!/fatal:/.test(calls.lastError), "git's own crash text never becomes the operator's diagnosis");
    assert.deepEqual(calls.dispatches, []);
  });

  it('exactly two arms omit the step-1 pointer, and a TAG ancestor is not one of them', async () => {
    // RED against: excluding the whole ancestor arm. Only two states have nothing for step 1 to add —
    // a branch tip that is simply unpushed, and an id that already peels to HEAD. A tag whose commit
    // is an ancestor still needs step 1, because this script deliberately prescribes nothing for it.
    const branchAncestor = liveWorld({});
    assert.equal(await runDispatch(liveArgs, branchAncestor.deps), EXIT.preflight);
    assert.ok(!/preflight-remote\.mjs/.test(branchAncestor.calls.lastError), 'a plain unpushed branch is not sent to step 1');

    const peelsToHead = liveWorld({ remoteObject: 'tag' });
    assert.equal(await runDispatch(liveArgs, peelsToHead.deps), EXIT.preflight);
    assert.ok(!/preflight-remote\.mjs/.test(peelsToHead.calls.lastError), 'an id that already peels to HEAD is not sent to step 1');

    const tagAncestor = liveWorld({ lsRemoteBody: `${SHA}\trefs/tags/v9.9.9\n` });
    assert.equal(await runDispatch([...liveArgs, '--ref', 'v9.9.9'], tagAncestor.deps), EXIT.preflight);
    assert.match(tagAncestor.calls.lastError, /preflight-remote\.mjs --ref 'v9\.9\.9'/, 'a tag ancestor IS sent to step 1');
  });

  it('no arm promises what step 1 will conclude — it says what step 1 IS', async () => {
    // RED against: "for the counts and the remedies it names". The dispatcher accepts refs the
    // preflight refuses outright, so for those the promised counts never arrive.
    for (const world of [
      { remoteReaches: false, headReached: true },
      { remoteReaches: false, headReached: false },
      { remoteReaches: false, headReached: false, shallow: true },
      { remoteObject: 'unresolvable' },
      { remoteObject: { status: 2, stdout: '', stderr: 'boom\n', error: null, signal: null } },
    ]) {
      const { deps, calls } = liveWorld(world);
      assert.equal(await runDispatch(liveArgs, deps), EXIT.preflight);
      assert.match(calls.lastError, /the first check of the\n?\s*release procedure/);
      assert.match(calls.lastError, /refuses a repository or a ref it cannot verify/);
      assert.ok(!/for the counts/.test(calls.lastError), 'counts are not promised to a ref step 1 may refuse');
      // And it must not promise a FETCH either: step 1 refuses a shallow repository before its
      // network act, so the two scripts would contradict each other exactly where it matters.
      assert.ok(!/it fetches and/.test(calls.lastError), 'no arm promises step 1 will fetch');
    }
  });

  it('EVERY non-answer shape at EVERY probe position is undetermined — with its own cause', async () => {
    // RED against: guarding only the first probe (a later 128 read as a fork), and against a table
    // that runs one shape everywhere and calls that positional coverage. `status: 1` is included
    // deliberately: it is an ANSWER for the three ancestry probes and a NON-answer for shallowness.
    const shapes = [
      { label: 'exit 2', res: { status: 2, stdout: '', stderr: 'usage: git\n', error: null, signal: null }, cause: /git exited with status 2: usage: git/ },
      { label: 'exit 129', res: { status: 129, stdout: '', stderr: '', error: null, signal: null }, cause: /git exited with status 129/ },
      { label: 'exit 128', res: { status: 128, stdout: '', stderr: 'fatal: bad object\n', error: null, signal: null }, cause: /git exited with status 128: fatal: bad object/ },
      { label: 'no status', res: { status: null, stdout: '', stderr: '', error: null, signal: null }, cause: /git exited with no status/ },
      { label: 'killed', res: { status: null, stdout: '', stderr: '', error: null, signal: 'SIGKILL' }, cause: /git was killed by SIGKILL/ },
      { label: 'never spawned', res: { status: null, stdout: '', stderr: '', error: new Error('spawn git ENOENT'), signal: null }, cause: /git could not be run: spawn git ENOENT/ },
      { label: 'exit 0 but killed', res: { status: 0, stdout: '', stderr: '', error: null, signal: 'SIGTERM' }, cause: /git was killed by SIGTERM/ },
    ];
    const positions = [
      { label: 'object guard', world: (res) => ({ remoteObject: res }), seen: [GUARD] },
      { label: 'forward probe', world: (res) => ({ remoteReaches: res }), seen: [GUARD, REACHES] },
      { label: 'reverse probe', world: (res) => ({ remoteReaches: false, headReached: res }), seen: [GUARD, REACHES, REACHED] },
      { label: 'shallowness probe', world: (res) => ({ remoteReaches: false, headReached: false, shallow: res }), seen: [GUARD, REACHES, REACHED, COMPLETE] },
    ];
    for (const position of positions) {
      for (const shape of shapes) {
        const where = `${shape.label} at the ${position.label}`;
        const { deps, calls } = liveWorld(position.world(shape.res));
        assert.equal(await runDispatch(liveArgs, deps), EXIT.preflight, where);
        assert.match(calls.lastError, /relationship could NOT be determined/, where);
        assert.match(calls.lastError, shape.cause, where);
        assert.ok(!/DIVERGED|AHEAD of this branch|must be pushed first|SHALLOW/.test(calls.lastError), `${where}: no verdict is invented`);
        assert.deepEqual(calls.gitRawArgs, position.seen, `${where}: the run stops at the probe that did not answer`);
        assert.deepEqual(calls.dispatches, [], where);
      }
    }
    // The one shape whose meaning DEPENDS on position: exit 1 answers the three ancestry probes and
    // is a non-answer only for shallowness.
    const one = { status: 1, stdout: '', stderr: '', error: null, signal: null };
    const { deps, calls } = liveWorld({ remoteReaches: false, headReached: false, shallow: one });
    assert.equal(await runDispatch(liveArgs, deps), EXIT.preflight);
    assert.match(calls.lastError, /relationship could NOT be determined/);
    assert.match(calls.lastError, /git exited with status 1/);
    assert.ok(!/has DIVERGED/.test(calls.lastError), 'an exit-1 shallowness answer is not permission to call it a fork');
  });

  it('the printed remedy survives a shell as ONE argument — no nested operator can run', async () => {
    // RED against: `--ref ${ref}` in the template. The dispatcher accepts ref names the preflight
    // refuses, so `release;uname` would paste as TWO commands and run the second one before
    // preflight-remote ever got the chance to refuse it. String matching alone would not prove this:
    // the quoted form is handed to a real shell, which must return the ref verbatim as one word.
    for (const ref of ['release;uname', 'release&touch x', 'release$(id)', "it's-a-ref", 'a b c']) {
      const { deps, calls } = liveWorld({ remoteReaches: false, headReached: false });
      assert.equal(await runDispatch([...liveArgs, '--ref', ref], deps), EXIT.preflight);
      const quoted = calls.lastError.match(/--ref (('([^']|'\\'')*'))/)[1];
      const roundTrip = execFileSync('sh', ['-c', `printf %s ${quoted}`], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(roundTrip, ref, `${ref} must come back out of a shell byte-identical`);
    }
  });

  it('a ref carrying a TAB makes the ls-remote line unparseable, and that refuses', async () => {
    // A real ref name cannot contain a tab, so a line with three fields is not a ref this run can
    // identify. RED against: splitting on /\s/ and taking token 0, which reads such a line happily.
    const { deps, calls } = liveWorld({ lsRemoteBody: `${SHA}\trefs/heads/a\tb\n` });
    assert.equal(await runDispatch([...liveArgs, '--ref', 'a\tb'], deps), EXIT.preflight);
    assert.match(calls.lastError, /returned a line this run cannot parse/);
    assert.deepEqual(calls.gitRawArgs, [], 'nothing is probed about a ref this run could not identify');
  });

  it('the refusal carries the ref the release DISPATCHES with, not a hardcoded main', async () => {
    // RED against: a step-1 command line pasted as a literal — it would send the operator to verify
    // a branch this release never publishes from.
    const { deps, calls } = liveWorld({ remoteReaches: false, headReached: false });
    assert.equal(await runDispatch([...liveArgs, '--ref', 'release-2026-08'], deps), EXIT.preflight);
    assert.match(calls.lastError, /--ref 'release-2026-08'/);
  });

  it('the destination is chosen by EXACT refname — ls-remote pattern-matching never decides it', async () => {
    // RED against: `lsRemote.split(/\s/)[0]`. `ls-remote origin main` also matches refs/tags/main and
    // refs/heads/foo/main, so the first token is a ref chosen by output ordering — and every later
    // comparison, including the one that lets a live dispatch proceed, would be about that ref.
    assert.deepEqual(
      selectRemoteRef(`${OTHER_SHA}\trefs/heads/foo/main\n${SHA}\trefs/heads/main\n`, 'main'),
      { oid: SHA, name: 'refs/heads/main', error: null },
      'a suffix match never wins over the exact one, whatever the order',
    );
    assert.deepEqual(
      selectRemoteRef(`${SHA}\trefs/tags/v1\n${OTHER_SHA}\trefs/tags/v1^{}\n`, 'v1'),
      { oid: SHA, name: 'refs/tags/v1', error: null },
      'a peeled tag line is not the ref that was asked for',
    );
    assert.equal(selectRemoteRef(`${SHA}\trefs/heads/main\n${OTHER_SHA}\trefs/tags/main\n`, 'main').error?.includes('AMBIGUOUS'), true, 'a branch/tag collision is refused, not resolved');
    assert.match(selectRemoteRef(`${SHA}\trefs/heads/foo/main\n`, 'main').error, /no exact refs\/heads\/main or refs\/tags\/main/);
    assert.match(selectRemoteRef('', 'main').error, /no exact/);
    assert.match(selectRemoteRef(`${SHA} refs/heads/main\n`, 'main').error, /cannot parse/, 'the separator is a TAB; a space-separated line is not this format');
    assert.match(selectRemoteRef(`zzzz\trefs/heads/main\n`, 'main').error, /cannot parse/);
    assert.deepEqual(
      selectRemoteRef(`${SHA}\trefs/heads/main\n`, 'refs/heads/main'),
      { oid: SHA, name: 'refs/heads/main', error: null },
      'a full ref is taken as written',
    );
    assert.deepEqual(selectRemoteRef(`${SHA}\tHEAD\n${OTHER_SHA}\trefs/heads/main\n`, 'main'), { oid: OTHER_SHA, name: 'refs/heads/main', error: null }, 'a HEAD line is present in real output and is not the branch');
    // A `^{}` entry is a projection of a ref, not a ref: no request may select one.
    assert.match(selectRemoteRef(`${SHA}\trefs/tags/v1\n${OTHER_SHA}\trefs/tags/v1^{}\n`, 'v1^{}').error, /no exact/, 'a short peeled request selects nothing');
    assert.match(selectRemoteRef(`${SHA}\trefs/tags/v1^{}\n`, 'refs/tags/v1^{}').error, /no exact/, 'a full peeled request selects nothing either');
    // Blank lines: '' is zero rows (a ref that matched nothing), anything else blank is malformed.
    assert.match(selectRemoteRef('', 'main').error, /no exact/, 'empty stdout is a ref that matched nothing');
    for (const body of ['\n', `\n${SHA}\trefs/heads/main\n`, `${SHA}\trefs/heads/main\n\n`, `${SHA}\trefs/heads/main\n\n${OTHER_SHA}\trefs/tags/x\n`]) {
      assert.match(selectRemoteRef(body, 'main').error, /cannot parse/, `${JSON.stringify(body)} is malformed, not silently skipped`);
    }
    assert.equal(selectRemoteRef(`${SHA}\trefs/heads/main`, 'main').oid, SHA, 'a body with no trailing newline is still one row');
  });

  it('an ambiguous or unidentifiable ls-remote answer refuses before ANY probe', async () => {
    // RED against: classifying against a sha whose ref this run could not name.
    const { deps, calls } = liveWorld({ lsRemoteBody: `${SHA}\trefs/heads/main\n${OTHER_SHA}\trefs/tags/main\n` });
    assert.equal(await runDispatch(liveArgs, deps), EXIT.preflight);
    assert.match(calls.lastError, /AMBIGUOUS/);
    assert.match(calls.lastError, /refusing before ANY dispatch/);
    assert.deepEqual(calls.gitRawArgs, [], 'no ancestry is probed about a ref this run refused to identify');
    assert.deepEqual(calls.dispatches, []);
  });

  it('the push prescription is earned by a BRANCH — a tag ref gets the observation only', async () => {
    // RED against: "the approved release commit must be pushed first" printed for a tag. Pushing a
    // branch does not move a tag, so that sentence is advice which cannot work.
    const { deps, calls } = liveWorld({ lsRemoteBody: `${SHA}\trefs/tags/v9.9.9\n` });
    assert.equal(await runDispatch([...liveArgs, '--ref', 'v9.9.9'], deps), EXIT.preflight);
    assert.match(calls.lastError, /refs\/tags\/v9\.9\.9 on origin is at/);
    assert.match(calls.lastError, /resolves to an ancestor of HEAD/);
    assert.match(calls.lastError, /is not a branch, so no push is prescribed/);
    assert.ok(!/must be pushed first/.test(calls.lastError), 'no push is prescribed for a ref a push cannot move');
    assert.match(calls.lastError, /preflight-remote\.mjs --ref 'v9\.9\.9'/);
  });

  it('a FULL tag ref does not earn the push prescription either', async () => {
    // RED against: `remoteRef === ref`, my own round-3 shortcut. `--ref refs/tags/v1` selects
    // refs/tags/v1, the two compare equal, and the branch advice fires for a ref no push can move.
    const { deps, calls } = liveWorld({ lsRemoteBody: `${SHA}\trefs/tags/v1\n` });
    assert.equal(await runDispatch([...liveArgs, '--ref', 'refs/tags/v1'], deps), EXIT.preflight);
    assert.match(calls.lastError, /is not a branch, so no push is prescribed/);
    assert.ok(!/must be pushed first/.test(calls.lastError));
  });

  it('a FULL branch ref does earn it', async () => {
    const { deps, calls } = liveWorld({ lsRemoteBody: `${SHA}\trefs/heads/main\n` });
    assert.equal(await runDispatch([...liveArgs, '--ref', 'refs/heads/main'], deps), EXIT.preflight);
    assert.match(calls.lastError, /the approved release commit must be pushed first/);
  });

  it('a BRANCH ref keeps the exact original sentence', async () => {
    // RED against: a fold that hedges the one case where the old wording was right.
    const { deps, calls } = liveWorld({});
    assert.equal(await runDispatch(liveArgs, deps), EXIT.preflight);
    assert.match(calls.lastError, /the approved release commit must be pushed first/);
    assert.ok(!/NOT a branch/.test(calls.lastError));
  });

  it('EVERY ref-type-dependent claim comes from ONE predicate — no arm decides it alone', async () => {
    // RED against: patching arms one at a time. Two rounds found the same assumption in two different
    // arms; this asserts the property for all of them at once, so a new arm cannot repeat it.
    const render = (state, remoteRef) => renderHeadMismatch({ ref: 'x', remoteRef, expectedSha: SHA, localHead: OTHER_SHA, ancestry: { state, cause: 'git exited with status 7' } });
    for (const state of [ANCESTRY.ancestor, ANCESTRY.behind, ANCESTRY.diverged]) {
      const asTag = render(state, 'refs/tags/v1');
      assert.ok(!/requires an explicitly forced update|must be pushed first/.test(asTag), `${state}: no push-shaped claim for a tag`);
      assert.match(asTag, /is not a branch, so no push is prescribed/, `${state}: it says why`);
      assert.ok(!/this branch/.test(asTag), `${state}: a tag is not called a branch`);
      const asBranch = render(state, 'refs/heads/main');
      assert.ok(/must be pushed first|requires an explicitly forced update/.test(asBranch), `${state}: a branch keeps its push-shaped claim`);
    }
  });

  it('the label is built from the SELECTED refname, so it never names a path that does not exist', async () => {
    // RED against: `origin/${ref}` glued from the operand — `--ref refs/heads/main` printed
    // `origin/refs/heads/main`, which is not a thing.
    assert.deepEqual(describeDestination('refs/heads/main'), { branch: true, label: 'origin/main', subject: 'this branch' });
    assert.deepEqual(describeDestination('refs/heads/release/2026-08'), { branch: true, label: 'origin/release/2026-08', subject: 'this branch' });
    assert.deepEqual(describeDestination('refs/tags/v1'), { branch: false, label: 'refs/tags/v1 on origin', subject: 'the selected ref' });
    assert.deepEqual(describeDestination('refs/notes/commits'), { branch: false, label: 'refs/notes/commits on origin', subject: 'the selected ref' });
    assert.deepEqual(describeDestination('HEAD'), { branch: false, label: 'HEAD on origin', subject: 'the selected ref' });
    // And the renderer REQUIRES it: defaulting would silently restore the branch assumption.
    assert.throws(() => renderHeadMismatch({ ref: 'main', remoteRef: null, expectedSha: SHA, localHead: OTHER_SHA, ancestry: { state: ANCESTRY.ancestor, cause: null } }), /requires the selected refname/);
    assert.throws(() => renderHeadMismatch({ ref: 'main', remoteRef: '', expectedSha: SHA, localHead: OTHER_SHA, ancestry: { state: ANCESTRY.ancestor, cause: null } }), /requires the selected refname/);
  });

  it('the header invariant and the refusal text say the same thing (tracked surfaces only)', async () => {
    // RED against: the pre-fix header, which described ANY mismatch as an unpushed commit — the
    // wording that made the wrong message look correct to every later reader.
    // The hidden release-cycle SKILL.md is deliberately NOT bound here: it is absent from a clean
    // checkout, so this test could only bind it behind a skip, and a skip destroys the guarantee.
    const source = readFileSync(join(REPO_ROOT, 'scripts', 'release', 'dispatch-publish.mjs'), 'utf8');
    const header = source.slice(0, source.indexOf('\nimport '));
    // Every header assertion runs on the NORMALISED text: a claim split across a `\n//` boundary
    // would otherwise pass or fail for a typographic reason rather than for what it says.
    const flatten = (text) => text.split('\n').map((line) => line.replace(/^\s*\/\/ ?/, '')).join(' ').replace(/\s+/g, ' ');
    const flat = flatten(header);
    const render = (state, cause = null, remoteRef = 'refs/heads/main') => renderHeadMismatch({ ref: 'main', remoteRef, expectedSha: SHA, localHead: OTHER_SHA, ancestry: { state, cause } });
    const pairs = [
      { header: /ancestor of HEAD is an UNPUSHED commit \(push it\) — and ONLY for a branch/, message: /must be pushed first/, state: ANCESTRY.ancestor },
      { header: /annotated tag|peels/i, message: /RESOLVES TO the local HEAD/, state: ANCESTRY.resolvesToHead },
      { header: /behind/i, message: /AHEAD of this branch/, state: ANCESTRY.behind },
      { header: /diverg/i, message: /DIVERGED/, state: ANCESTRY.diverged },
      { header: /shallow/i, message: /is SHALLOW/, state: ANCESTRY.shallow },
      { header: /does not resolve to a commit/i, message: /does not resolve to a commit/, state: ANCESTRY.unresolvable },
      { header: /undetermined/i, message: /could NOT be determined/, state: ANCESTRY.undetermined },
    ];
    for (const pair of pairs) {
      assert.match(flat, pair.header, `the header names the ${pair.state} case`);
      assert.match(render(pair.state, 'git exited with status 7'), pair.message, `the ${pair.state} message says it`);
    }
    assert.match(flat, /preflight-remote\.mjs/, 'the header names the step-1 script the messages send the operator to');
    // The tag rendering must carry no push instruction at all — the header's qualifier above is only
    // half the guarantee; this is the other half.
    const tagRendering = renderHeadMismatch({ ref: 'v1', remoteRef: 'refs/tags/v1', expectedSha: SHA, localHead: OTHER_SHA, ancestry: { state: ANCESTRY.ancestor, cause: null } });
    assert.ok(!/must be pushed first|requires an explicitly forced update/.test(tagRendering), 'and the tag rendering carries no push instruction');
    // The PUBLIC wording must not promise what step 1 will conclude either. A header is the contract
    // a reader trusts before running anything, so green arm-tests beside a promising header would
    // still leave the false claim standing where it is read most.
    const preflightSource = readFileSync(join(REPO_ROOT, 'scripts', 'release', 'preflight-remote.mjs'), 'utf8');
    // NORMALISED before matching: a promise split across a `\n//` line wrap would otherwise pass an
    // assertion for a purely typographic reason, which is worse than having no assertion at all.
    const surfaces = [
      ['the dispatcher header', flat],
      ['the preflight header', flatten(preflightSource.slice(0, preflightSource.indexOf('\nimport ')))],
    ];
    for (const [name, text] of surfaces) {
      for (const promise of [/without a fetch/i, /for the counts/i, /fetches and answers/i, /points here for the counts/i]) {
        assert.ok(!promise.test(text), `${name} must not promise a classification (${promise})`);
      }
    }
    // The normaliser itself is pinned: without this, a broken normaliser would make every promise
    // check above pass silently — the same failure shape the assertion was written to end.
    assert.ok(flatten('// for\n// the counts').includes('for the counts'), 'a phrase split across a line wrap is visible after normalisation');
    for (const state of [ANCESTRY.behind, ANCESTRY.diverged, ANCESTRY.shallow, ANCESTRY.unresolvable, ANCESTRY.undetermined]) {
      assert.match(render(state, 'git exited with status 7'), /preflight-remote\.mjs --ref 'main'/, `the ${state} arm points at step 1`);
    }
  });
});

// ── the probe arms against REAL git ───────────────────────────────────────────────────
// A stub can only prove the mapping. Every assumption that CAUSED this fix — exit 1 as an answer,
// 128 on an unresolvable object, exit 1 in one direction meaning nothing on its own — was found by
// running git, so the arms are proven against git itself.
//
// The graph is BUILT here, never borrowed from the checkout: CI clones at depth 1
// (actions/checkout with no fetch-depth), so `HEAD~1` does not resolve there and any test reading
// this repository's own history would be red in CI and green locally — the worst of both. The
// environment is scrubbed for the same reason: an inherited GIT_DIR / GIT_WORK_TREE / GIT_CONFIG_*
// / GIT_CONFIG_PARAMETERS / GIT_DEFAULT_HASH, or a global hooks path, would silently point these
// commands at another repository, inject config, or change the object format under the fixture.

// An ALLOW-list, not a deny-list: every inherited GIT_* is dropped and only the four this fixture
// controls are put back. A deny-list is a guess about which variables git honours — and the list of
// GIT_* knobs (GIT_TEMPLATE_DIR, GIT_CONFIG_PARAMETERS, GIT_DEFAULT_HASH, GIT_ALTERNATE_* …) grows
// with git, so a fixture built on one is only hermetic until the next release.
export const hermeticGitEnv = (source) => {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
};

const HERMETIC_GIT_ENV = hermeticGitEnv(process.env);

const buildGitGraph = () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-ancestry-repo-'));
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=preflight-test', '-c', 'user.email=preflight@test.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'init.defaultBranch=main',
    '-c', 'core.hooksPath=/dev/null', ...args,
  ], { cwd: dir, encoding: 'utf8', env: HERMETIC_GIT_ENV, timeout: 30_000 }).trim();
  git('init', '--quiet');
  git('commit', '--allow-empty', '--quiet', '-m', 'A');
  const shaA = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '--quiet', '-m', 'B');
  const shaB = git('rev-parse', 'HEAD');
  git('checkout', '--quiet', '-b', 'fork', shaA);
  git('commit', '--allow-empty', '--quiet', '-m', 'C');
  const shaC = git('rev-parse', 'HEAD'); // a real fork: C and B share only A
  git('checkout', '--quiet', 'main');
  // The object-id width is READ from the graph, never assumed: a host defaulting to sha256 would
  // otherwise turn every hardcoded 40-character fixture into a silent mismatch.
  return { dir, git, shaA, shaB, shaC, width: shaA.length, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

describe('AD-098 — the ancestry probes, answered by real git on a graph this test builds', () => {
  const realGit = (args, cwd) => runGitProcess(args, { cwd, env: HERMETIC_GIT_ENV });

  it('the fixture environment drops EVERY inherited GIT_ variable, not a listed few', async () => {
    // RED against: a deny-list. A hostile GIT_TEMPLATE_DIR or GIT_CONFIG_PARAMETERS would otherwise
    // reach the fixture and change the repository these arms are reasoning about.
    const hostile = { PATH: '/bin', HOME: '/home/x', GIT_DIR: '/evil/.git', GIT_TEMPLATE_DIR: '/evil/tpl', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_DEFAULT_HASH: 'sha256' };
    const scrubbed = hermeticGitEnv(hostile);
    assert.equal(scrubbed.PATH, '/bin', 'the non-git environment survives');
    assert.equal(scrubbed.HOME, '/home/x');
    const survivors = Object.keys(scrubbed).filter((key) => key.startsWith('GIT_')).sort();
    assert.deepEqual(survivors, ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_SYSTEM', 'GIT_TERMINAL_PROMPT'], 'only the four this fixture controls');
  });

  it('the remote tip is an ancestor of HEAD — exit 0 from the forward probe ends it', async () => {
    const graph = buildGitGraph();
    try {
      assert.deepEqual(await probeAncestry(realGit, graph.shaA, graph.shaB, graph.dir), { state: ANCESTRY.ancestor, cause: null });
    } finally {
      graph.cleanup();
    }
  });

  it('an ANNOTATED TAG on the head — the reported id peels to the head, and real git proves it', async () => {
    // ls-remote reports the tag OBJECT for an annotated tag, so this is the id the dispatcher would
    // compare: different from the head, yet naming the very same commit.
    const graph = buildGitGraph();
    try {
      graph.git('tag', '-a', 'v-test', '-m', 'annotated', graph.shaB);
      const tagObject = graph.git('rev-parse', 'v-test');
      assert.notEqual(tagObject, graph.shaB, 'the fixture really is an annotated tag, not a lightweight one');
      assert.deepEqual(await probeAncestry(realGit, tagObject, graph.shaB, graph.dir), { state: ANCESTRY.resolvesToHead, cause: null });
    } finally {
      graph.cleanup();
    }
  });

  it('HEAD is behind the remote tip — real git answers exit 1 forward and exit 0 in reverse', async () => {
    // This is the pair a single-direction probe called a DIVERGENCE. Real git says otherwise.
    const graph = buildGitGraph();
    try {
      assert.deepEqual(await probeAncestry(realGit, graph.shaB, graph.shaA, graph.dir), { state: ANCESTRY.behind, cause: null });
    } finally {
      graph.cleanup();
    }
  });

  it('a genuine fork — exit 1 in BOTH directions, on a graph git itself reports as whole', async () => {
    const graph = buildGitGraph();
    try {
      assert.deepEqual(await probeAncestry(realGit, graph.shaC, graph.shaB, graph.dir), { state: ANCESTRY.diverged, cause: null });
      const complete = await runGitProcess(['rev-parse', '--is-shallow-repository'], { cwd: graph.dir, env: HERMETIC_GIT_ENV });
      assert.equal(complete.stdout.trim(), 'false', 'the verdict above rests on git calling this graph complete');
    } finally {
      graph.cleanup();
    }
  });

  it('a REAL shallow clone reports itself shallow — the predicate the divergence verdict rests on', async () => {
    // What this proves is the PREDICATE against real git, not a manufactured false-divergence graph:
    // a depth-1 clone answers "true" where the full fixture answers "false". The classification rule
    // that consumes the predicate is pinned by the stub arm above.
    const graph = buildGitGraph();
    const clone = mkdtempSync(join(tmpdir(), 'aw-ancestry-shallow-'));
    try {
      execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${graph.dir}`, clone], { encoding: 'utf8', env: HERMETIC_GIT_ENV, timeout: 60_000 });
      const complete = await runGitProcess(['rev-parse', '--is-shallow-repository'], { cwd: clone, env: HERMETIC_GIT_ENV });
      assert.equal(complete.status, 0);
      assert.equal(complete.stdout.trim(), 'true');
    } finally {
      rmSync(clone, { recursive: true, force: true });
      graph.cleanup();
    }
  });

  it('exit 1 from the object guard — a well-formed sha this repository cannot resolve', async () => {
    // This is the arm that makes exit 1 an ANSWER: the throwing runGit would raise here, and an
    // exception cannot carry "does not resolve to a commit".
    const graph = buildGitGraph();
    try {
      const absent = 'f'.repeat(graph.width);
      assert.deepEqual(await probeAncestry(realGit, absent, graph.shaB, graph.dir), { state: ANCESTRY.unresolvable, cause: null });
    } finally {
      graph.cleanup();
    }
  });

  it('exit 1 from the object guard again — an object that EXISTS but is not a commit', async () => {
    // The case `cat-file -e` would wrongly pass, which is why the guard peels with ^{commit}.
    const graph = buildGitGraph();
    try {
      writeFileSync(join(graph.dir, 'blob.txt'), 'not a commit\n');
      const blob = graph.git('hash-object', '-w', 'blob.txt');
      assert.equal(blob.length, graph.width, 'the fixture wrote a real object of this graphid width');
      assert.deepEqual(await probeAncestry(realGit, blob, graph.shaB, graph.dir), { state: ANCESTRY.unresolvable, cause: null });
    } finally {
      graph.cleanup();
    }
  });

  it('a real exit 128 — git run where there is no repository', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'aw-ancestry-bare-'));
    try {
      const out = await probeAncestry(realGit, 'f'.repeat(40), 'b'.repeat(40), outside);
      assert.equal(out.state, ANCESTRY.undetermined, '128 is not a verdict');
      assert.match(out.cause, /git exited with status 128/);
      assert.match(out.cause, /not a git repository/, "git's own reason survives, unparaphrased");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a real execution error — the binary does not exist, so nothing was answered', async () => {
    const missing = (args, cwd) => runProcess('aw-no-such-binary-8f3c', args, { cwd, deadlineMs: 5_000 });
    const out = await probeAncestry(missing, 'f'.repeat(40), 'b'.repeat(40), REPO_ROOT);
    assert.equal(out.state, ANCESTRY.undetermined);
    // The errno is the PLATFORM's, not ours — measured ENOENT on a plain host and EACCES under this
    // project's sandbox — so the assertion binds what the leaf guarantees: a spawn that never became
    // a process reaches the caller as a named cause, never as a silent verdict.
    assert.match(out.cause, /git could not be run: spawn aw-no-such-binary-8f3c E[A-Z]+/);
  });
});
