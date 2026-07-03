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
} = {}) => {
  const calls = { dispatches: [], gitArgs: [], fetches: [] };
  const runs = [];
  let nextRunId = 100;
  let pendingRun = null;

  const ghApi = ({ method = 'GET', path, fields = {} }) => {
    if (path === 'user') {
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

  const fetchJson = async (url) => {
    calls.fetches.push(url);
    const name = decodeURIComponent(url.split('registry.npmjs.org/')[1].replace('/latest', '')).replace('%2F', '/');
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
  it('dispatch/correlation/poll-timeout/verify are four different codes', () => {
    assert.equal(new Set([EXIT.dispatch, EXIT.correlation, EXIT.pollTimeout, EXIT.verify]).size, 4);
  });
});
