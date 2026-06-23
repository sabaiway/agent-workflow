import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, symlinkSync, chmodSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expandTilde,
  resolveDir,
  findOnPath,
  probeCredential,
  detectBackend,
  detectBackends,
  formatReport,
  guideFor,
  KNOWN_BACKENDS,
} from './detect-backends.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url)); // …/agent-workflow-kit/tools/ → repo root
const KIT = join(REPO, 'agent-workflow-kit');
const FIX = join(KIT, 'tools', 'manifest', 'fixtures');
const HOME = '/home/u';

// An ENOENT-typed error, matching the shape Node's fs throws (used to drive the wrapped probes).
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
const eacces = () => Object.assign(new Error('EACCES'), { code: 'EACCES' });

// ── pure helpers ─────────────────────────────────────────────────────────────

describe('expandTilde', () => {
  it('"~" → home', () => assert.equal(expandTilde('~', HOME), HOME));
  it('"~/x" → home/x', () => assert.equal(expandTilde('~/x/y', HOME), join(HOME, 'x/y')));
  it('absolute path untouched', () => assert.equal(expandTilde('/abs/path', HOME), '/abs/path'));
  it('relative path untouched', () => assert.equal(expandTilde('rel/path', HOME), 'rel/path'));
});

describe('resolveDir', () => {
  it('non-empty env wins, as-is', () => {
    assert.equal(resolveDir({ env: 'D', default: '~/d' }, { D: '/from/env' }, HOME), '/from/env');
  });
  it('empty-string env → default', () => {
    assert.equal(resolveDir({ env: 'D', default: '/d' }, { D: '' }, HOME), '/d');
  });
  it('null env name → default', () => {
    assert.equal(resolveDir({ env: null, default: '/d' }, {}, HOME), '/d');
  });
  it('default is tilde-expanded', () => {
    assert.equal(resolveDir({ env: 'D', default: '~/skills/x' }, {}, HOME), join(HOME, 'skills/x'));
  });
});

describe('findOnPath', () => {
  const linux = { platform: 'linux', getenv: { PATH: '/a:/b' }, realpath: (p) => p };

  it('present via posix exec-bit', () => {
    const r = findOnPath('codex', { ...linux, access: (p) => { if (p !== '/a/codex') throw enoent(); } });
    assert.equal(r.state, 'present');
    assert.equal(r.path, '/a/codex');
  });

  it('missing when absent everywhere', () => {
    const r = findOnPath('codex', { ...linux, access: () => { throw enoent(); } });
    assert.equal(r.state, 'missing');
    assert.equal(r.path, null);
  });

  it('found in the 2nd PATH dir', () => {
    const r = findOnPath('agy', { ...linux, access: (p) => { if (p !== '/b/agy') throw enoent(); } });
    assert.equal(r.state, 'present');
    assert.equal(r.path, '/b/agy');
  });

  it('Windows: matches via PATHEXT', () => {
    const r = findOnPath('codex', {
      platform: 'win32',
      getenv: { PATH: 'C:\\bin', PATHEXT: '.COM;.EXE;.CMD' },
      realpath: (p) => p,
      access: (p) => { if (!p.endsWith('codex.EXE')) throw enoent(); },
    });
    assert.equal(r.state, 'present');
    assert.ok(r.path.endsWith('codex.EXE'));
  });

  it('resolves a symlinked binary to its realpath (real fs)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awf-path-'));
    const target = join(dir, 'real-tool');
    const link = join(dir, 'linked-tool');
    writeFileSync(target, '#!/bin/sh\n');
    chmodSync(target, 0o755);
    symlinkSync(target, link);
    const r = findOnPath('linked-tool', { platform: 'linux', getenv: { PATH: dir } });
    assert.equal(r.state, 'present');
    assert.equal(r.path, target); // realpath followed the symlink
  });

  it('accessSync throwing EACCES → unknown (cannot confirm)', () => {
    const r = findOnPath('codex', { ...linux, access: () => { throw eacces(); } });
    assert.equal(r.state, 'unknown');
  });
});

describe('probeCredential', () => {
  const entry = (over = {}) => ({ credential: { env: 'CRED', default: '~/.codex', file: 'auth.json', ...over } });

  it('present when the marker file is a real file (env override honoured)', () => {
    const r = probeCredential(entry(), { getenv: { CRED: '/cdir' }, home: HOME, exists: () => true, stat: () => ({ isFile: () => true }) });
    assert.equal(r.state, 'present');
    assert.equal(r.path, '/cdir/auth.json');
  });

  it('absent → missing', () => {
    const r = probeCredential(entry(), { getenv: {}, home: HOME, exists: () => false });
    assert.equal(r.state, 'missing');
    assert.equal(r.path, join(HOME, '.codex/auth.json')); // env unset → tilde default
  });

  it('statSync throwing a non-ENOENT error → unknown', () => {
    const r = probeCredential(entry(), { getenv: {}, home: HOME, exists: () => true, stat: () => { throw eacces(); } });
    assert.equal(r.state, 'unknown');
  });

  it('credential.env:null uses the (tilde-expanded) default', () => {
    const r = probeCredential(entry({ env: null, default: '~/.gemini/antigravity-cli', file: 'tok' }), {
      getenv: {}, home: HOME, exists: () => true, stat: () => ({ isFile: () => true }),
    });
    assert.equal(r.state, 'present');
    assert.equal(r.path, join(HOME, '.gemini/antigravity-cli/tok'));
  });

  it('never counts a directory as a present credential', () => {
    const r = probeCredential(entry(), { getenv: { CRED: '/cdir' }, home: HOME, exists: () => true, stat: () => ({ isFile: () => false }) });
    assert.equal(r.state, 'missing');
  });
});

// ── detectBackend: manifestState precedence ──────────────────────────────────

// Build an entry whose installed-marker is `capability.json` so a fixture without a SKILL.md still
// registers as "installed", letting the validator branch decide the state.
const entryAt = (dir, over = {}) => ({
  name: 'codex-cli-bridge',
  installed: { env: 'X_DIR', default: dir, file: 'capability.json' },
  bin: 'codex',
  credential: { env: null, default: '/no/such/dir', file: 'auth.json' },
  setupUrl: 'https://example.test/setup',
  setupPathLocal: 'setup/README.md',
  ...over,
});

// All readiness inputs present, so manifestState is the only variable under test.
const allPresentDeps = {
  getenv: {},
  probeCli: () => ({ bin: 'codex', state: 'present', path: '/usr/bin/codex' }),
  probeCredentials: () => ({ state: 'present', path: '/c/auth.json' }),
  probeWrapper: (cmd) => ({ name: cmd, state: 'present' }),
};

describe('detectBackend — manifestState precedence', () => {
  it('not-installed when the marker file is absent', () => {
    const empty = mkdtempSync(join(tmpdir(), 'awf-empty-'));
    const d = detectBackend(entryAt(empty), allPresentDeps);
    assert.equal(d.manifestState, 'not-installed');
    assert.equal(d.skillDir, null);
    assert.equal(d.readiness, 'needs-skill');
  });

  it('unsupported-schema (fixtures/unknown-schema)', () => {
    const d = detectBackend(entryAt(join(FIX, 'unknown-schema')), allPresentDeps);
    assert.equal(d.manifestState, 'unsupported-schema');
  });

  it('invalid-manifest (fixtures/malformed-json)', () => {
    const d = detectBackend(entryAt(join(FIX, 'malformed-json')), allPresentDeps);
    assert.equal(d.manifestState, 'invalid-manifest');
  });

  it('stub (fixtures/stub — available:false)', () => {
    const d = detectBackend(entryAt(join(FIX, 'stub')), allPresentDeps);
    assert.equal(d.manifestState, 'stub');
  });

  it('foreign (valid, but a memory-substrate, not this backend)', () => {
    const d = detectBackend(entryAt(join(REPO, 'agent-workflow-memory')), allPresentDeps);
    assert.equal(d.manifestState, 'foreign');
    assert.match(d.manifestReason, /memory-substrate/);
  });

  it('ok (the real codex-cli-bridge dir, marker = SKILL.md)', () => {
    const d = detectBackend(
      entryAt(join(REPO, 'codex-cli-bridge'), { installed: { env: 'X_DIR', default: join(REPO, 'codex-cli-bridge'), file: 'SKILL.md' } }),
      allPresentDeps,
    );
    assert.equal(d.manifestState, 'ok');
    assert.deepEqual(d.wrappers.map((w) => w.name).sort(), ['codex-exec', 'codex-review']);
    assert.equal(d.setupHint.local, 'setup/README.md'); // installed AND setup/README.md exists
  });
});

// ── detectBackend: readiness matrix (over an `ok` manifest) ───────────────────

const okEntry = entryAt(join(REPO, 'codex-cli-bridge'), {
  installed: { env: 'X_DIR', default: join(REPO, 'codex-cli-bridge'), file: 'SKILL.md' },
});

describe('detectBackend — readiness over an ok manifest', () => {
  it('ready when cli + credentials + every wrapper present', () => {
    assert.equal(detectBackend(okEntry, allPresentDeps).readiness, 'ready');
  });

  it('needs-cli when the CLI is missing', () => {
    const d = detectBackend(okEntry, { ...allPresentDeps, probeCli: () => ({ bin: 'codex', state: 'missing', path: null }) });
    assert.equal(d.readiness, 'needs-cli');
  });

  it('needs-cli when the CLI is unknown (unknown never counts as present)', () => {
    const d = detectBackend(okEntry, { ...allPresentDeps, probeCli: () => ({ bin: 'codex', state: 'unknown', path: null }) });
    assert.equal(d.readiness, 'needs-cli');
  });

  it('needs-credentials when the credential marker is missing', () => {
    const d = detectBackend(okEntry, { ...allPresentDeps, probeCredentials: () => ({ state: 'missing', path: '/c/auth.json' }) });
    assert.equal(d.readiness, 'needs-credentials');
  });

  it('degraded when a wrapper is missing from PATH', () => {
    const d = detectBackend(okEntry, {
      ...allPresentDeps,
      probeWrapper: (cmd) => ({ name: cmd, state: cmd === 'codex-review' ? 'missing' : 'present' }),
    });
    assert.equal(d.readiness, 'degraded');
  });

  it('needs-skill dominates even when cli + credentials are present', () => {
    const empty = mkdtempSync(join(tmpdir(), 'awf-empty2-'));
    const d = detectBackend(entryAt(empty), allPresentDeps);
    assert.equal(d.readiness, 'needs-skill');
  });
});

// ── registry drift guard ─────────────────────────────────────────────────────

const readManifest = (dir) => JSON.parse(readFileSync(join(dir, 'capability.json'), 'utf8'));

// Every top-level in-repo dir with a kind:execution-backend manifest, discovered fresh from disk.
const inRepoBackends = () =>
  readdirSync(REPO, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(REPO, e.name, 'capability.json')))
    .filter((e) => readManifest(join(REPO, e.name)).kind === 'execution-backend')
    .map((e) => e.name);

describe('KNOWN_BACKENDS — drift guard against the in-repo manifests', () => {
  it('set equality: registry names == in-repo execution-backend dirs', () => {
    const onDisk = inRepoBackends().sort();
    const registry = KNOWN_BACKENDS.map((b) => b.name).sort();
    assert.deepEqual(registry, onDisk);
  });

  it('the methodology-engine is NOT counted as a backend', () => {
    assert.ok(!KNOWN_BACKENDS.some((b) => b.name === 'agent-workflow-engine'));
    assert.equal(readManifest(join(REPO, 'agent-workflow-engine')).kind, 'methodology-engine');
  });

  it('registry names are unique', () => {
    const names = KNOWN_BACKENDS.map((b) => b.name);
    assert.equal(new Set(names).size, names.length);
  });

  it('each entry.installed matches the real manifest detect.installed', () => {
    for (const entry of KNOWN_BACKENDS) {
      const real = readManifest(join(REPO, entry.name)).detect.installed;
      assert.equal(entry.installed.env, real.env, `${entry.name} env`);
      assert.equal(entry.installed.default, real.default, `${entry.name} default`);
      assert.equal(entry.installed.file, real.file, `${entry.name} file`);
    }
  });

  it('each entry.setupPathLocal exists in the repo', () => {
    for (const entry of KNOWN_BACKENDS) {
      assert.ok(existsSync(join(REPO, entry.name, entry.setupPathLocal)), `${entry.name}/${entry.setupPathLocal}`);
    }
  });
});

// ── formatReport ─────────────────────────────────────────────────────────────

const readyStatus = {
  name: 'codex-cli-bridge',
  manifestState: 'ok',
  manifestReason: 'ok',
  skillDir: '/skills/codex-cli-bridge',
  cli: { bin: 'codex', state: 'present', path: '/usr/bin/codex' },
  credentials: { state: 'present', path: '/home/u/.codex/auth.json' },
  wrappers: [{ name: 'codex-exec', state: 'present' }, { name: 'codex-review', state: 'present' }],
  readiness: 'ready',
  setupHint: { local: 'setup/README.md', url: 'https://example.test/codex' },
};
const needsSkillStatus = {
  name: 'antigravity-cli-bridge',
  manifestState: 'not-installed',
  manifestReason: 'not installed',
  skillDir: null,
  cli: { bin: 'agy', state: 'present', path: '/home/u/.local/bin/agy' },
  credentials: { state: 'present', path: '/home/u/.gemini/antigravity-cli/antigravity-oauth-token' },
  wrappers: [],
  readiness: 'needs-skill',
  setupHint: { url: 'https://example.test/agy' },
};

describe('formatReport', () => {
  const out = formatReport([readyStatus, needsSkillStatus]);

  it('never says "authenticated" or "authed" (credentials = file presence, not a live login)', () => {
    const low = out.toLowerCase();
    assert.ok(!low.includes('authenticated'));
    assert.ok(!low.includes('authed'));
  });

  it('uses the word "credentials"', () => assert.ok(out.toLowerCase().includes('credentials')));

  it('shows the ready backend as ready', () => {
    assert.match(out, /codex-cli-bridge.*ready/s);
  });

  it('a needs-skill backend (CLI + creds present) says install the bridge + points at the setup URL', () => {
    assert.match(out, /needs-skill/);
    assert.match(out, /install the bridge/);
    assert.match(out, /https:\/\/example\.test\/agy/);
  });
});

describe('detectBackends — live shape on this machine', () => {
  it('returns one status per registry entry with all data-model keys', () => {
    const statuses = detectBackends();
    assert.equal(statuses.length, KNOWN_BACKENDS.length);
    for (const s of statuses) {
      for (const key of ['name', 'manifestState', 'manifestReason', 'cli', 'credentials', 'wrappers', 'readiness', 'setupHint']) {
        assert.ok(key in s, `${s.name} missing ${key}`);
      }
      assert.ok(['present', 'missing', 'unknown'].includes(s.cli.state));
      assert.ok(['present', 'missing', 'unknown'].includes(s.credentials.state));
    }
  });
});

// ── guideFor (axis-aware manual steps) ────────────────────────────────────────

// A status with all axes satisfied; override per-case to drive each axis independently.
const okStatus = (over = {}) => ({
  name: 'codex-cli-bridge',
  manifestState: 'ok',
  manifestReason: 'ok',
  skillDir: '/skills/codex-cli-bridge',
  cli: { bin: 'codex', state: 'present', path: '/usr/bin/codex' },
  credentials: { state: 'present', path: '/home/u/.codex/auth.json' },
  wrappers: [{ name: 'codex-exec', state: 'present' }, { name: 'codex-review', state: 'present' }],
  readiness: 'ready',
  setupHint: { local: 'setup/README.md', url: 'https://example.test/codex' },
  ...over,
});

describe('guideFor — axis-aware manual steps', () => {
  it('returns [] when the backend is ready', () => {
    assert.deepEqual(guideFor(okStatus()), []);
  });

  it('returns [] for a degraded backend (wrappers are the linker\'s job, not a manual step)', () => {
    const s = okStatus({ readiness: 'degraded', wrappers: [{ name: 'codex-exec', state: 'missing' }] });
    assert.deepEqual(guideFor(s), []);
  });

  it('returns BOTH cli and credentials steps when both are missing (multiple simultaneous)', () => {
    const s = okStatus({
      cli: { bin: 'codex', state: 'missing', path: null },
      credentials: { state: 'missing', path: '/c/auth.json' },
    });
    const needs = guideFor(s).map((g) => g.need);
    assert.deepEqual(needs, ['cli', 'credentials']);
  });

  it('credentials step carries the canonical loginCmd + verifyCmd from the registry', () => {
    const s = okStatus({ credentials: { state: 'missing', path: '/c/auth.json' } });
    const step = guideFor(s).find((g) => g.need === 'credentials');
    assert.match(step.hint, /codex login/);
    assert.match(step.hint, /codex login status/);
  });

  it('cli step references the setup README (no duplicated install channels)', () => {
    const s = okStatus({ cli: { bin: 'codex', state: 'missing', path: null } });
    const step = guideFor(s).find((g) => g.need === 'cli');
    assert.match(step.hint, /codex-cli-bridge\/setup\/README\.md/);
  });

  it('manifestState not-installed → a placeable bundled-skill hint (+ any cli/creds owed)', () => {
    const s = okStatus({ manifestState: 'not-installed', skillDir: null });
    const skill = guideFor(s).find((g) => g.need === 'skill');
    assert.ok(skill, 'expected a skill step');
    assert.match(skill.hint, /bundled bridge skill/);
    assert.match(skill.hint, /setup codex-cli-bridge/);
  });

  it('manifestState foreign/stub → a STOP hint (never auto-overwritten)', () => {
    for (const state of ['foreign', 'stub', 'invalid-manifest', 'unsupported-schema', 'unknown']) {
      const skill = guideFor(okStatus({ manifestState: state })).find((g) => g.need === 'skill');
      assert.ok(skill, `expected a skill step for ${state}`);
      assert.match(skill.hint, /STOP/);
      assert.match(skill.hint, new RegExp(state.replace(/[-]/g, '\\$&')));
    }
  });

  it('every step is {need, hint} with a non-empty hint', () => {
    const s = okStatus({
      manifestState: 'not-installed',
      skillDir: null,
      cli: { bin: 'codex', state: 'missing', path: null },
      credentials: { state: 'missing', path: '/c/auth.json' },
    });
    const steps = guideFor(s);
    assert.equal(steps.length, 3);
    for (const step of steps) {
      assert.ok(typeof step.need === 'string' && step.need.length > 0);
      assert.ok(typeof step.hint === 'string' && step.hint.length > 0);
    }
  });
});

describe('KNOWN_BACKENDS — each entry exposes a guide', () => {
  it('guide carries setupRef + loginCmd + verifyCmd (non-empty strings)', () => {
    for (const entry of KNOWN_BACKENDS) {
      assert.ok(entry.guide, `${entry.name} missing guide`);
      for (const key of ['setupRef', 'loginCmd', 'verifyCmd']) {
        assert.ok(
          typeof entry.guide[key] === 'string' && entry.guide[key].length > 0,
          `${entry.name}.guide.${key} must be a non-empty string`,
        );
      }
    }
  });

  it('guide.setupRef points at a real file in the repo', () => {
    for (const entry of KNOWN_BACKENDS) {
      assert.ok(existsSync(join(REPO, entry.guide.setupRef)), `${entry.guide.setupRef} (${entry.name})`);
    }
  });
});
