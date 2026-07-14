import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPO_ROOT,
  EXIT,
  parseArgs,
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
} from './dispatch-publish.mjs';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

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
} = {}) => {
  const calls = { dispatches: [], gitArgs: [], fetches: [], fetchOpts: [], ghReqs: [] };
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
    if (head.startsWith('ls-remote')) return `${remoteSha}\trefs/heads/main\n`;
    if (head === 'status --porcelain') return dirtyTree;
    if (head === 'rev-parse HEAD') return `${localHead}\n`;
    throw new Error(`unscripted git: ${head}`);
  };

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
