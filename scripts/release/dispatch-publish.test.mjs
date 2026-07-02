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
  dirtyTree = '',
  localHead = SHA,
  remoteSha = SHA,
  extraRunsOnDispatch = 0, // simulate ambiguous correlation
  neverCreateRun = false,
  stallRuns = false,
} = {}) => {
  const calls = { dispatches: [], gitArgs: [], fetches: [] };
  const runs = [];
  let nextRunId = 100;
  let pendingRun = null;

  const ghApi = ({ method = 'GET', path, fields = {} }) => {
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

  it('package "all" → refused (Issue-007: one dispatch per package)', () => {
    assert.throws(() => parseArgs(['all']), (e) => e.exitCode === EXIT.usage && /"all" is refused/.test(e.message));
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
