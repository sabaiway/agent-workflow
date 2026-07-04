import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEED_GATES_STOP,
  TRUST_CHAIN_DISCLOSURE,
  detectPackageManager,
  kebabIdOf,
  deriveScriptEntries,
  reviewStateCandidate,
  buildOffer,
  formatPreview,
  applySeed,
  main,
} from './seed-gates.mjs';
import { loadDeclaration, validateDeclaration } from './run-gates.mjs';
import { KIT_WRITER_PREVIEW_TOOLS, UNIVERSAL_READONLY_ALLOWLIST } from './velocity-profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATES_REL = join('docs', 'ai', 'gates.json');

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'seed-gates-'));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

// A full project fixture: docs/ai + stamp + package.json (+ optional lockfile / config / gates).
const mkProject = ({ scripts = {}, lockfile, packageManager, config, gates, stamp = '1.3.0' } = {}) => {
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

// ── derivation invariants (LOCKED in the plan) ────────────────────────────────────────

describe('seed-gates — derivation: warn-flagged candidates NEVER enter the offer', () => {
  it('release/publish/deploy/push/version/commit/tag + pre/post hooks are excluded, not offered-with-a-warning', () => {
    mkProject({ scripts: {
      test: 'node --test', 'release:npm': 'npm publish', deploy: 'x', push: 'x', version: 'x',
      commit: 'git-cz', tag: 'x', prepublishOnly: 'x', postinstall: 'x', publish: 'x',
    } });
    const entries = deriveScriptEntries(cwd);
    assert.deepEqual(entries.map((e) => e.id), ['test'], 'only the terminating non-warn script survives');
  });
});

describe('seed-gates — derivation: only TERMINATING verification classes are offered', () => {
  it('test/lint/type-check/build classes are offered; dev/start/watch/serve/preview and formatter write-mode are not', () => {
    mkProject({ scripts: {
      test: 'node --test', 'test:unit': 'x', lint: 'x', typecheck: 'x', 'type-check': 'x', build: 'x', 'build:prod': 'x',
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
    assert.deepEqual(entries.map((e) => e.cmd), ['npm run test']);
  });

  it('a WATCH/SERVE body never enters the offer — the terminating contract screens bodies too (vitest --watch, vite build --watch)', () => {
    mkProject({ scripts: {
      test: 'vitest --watch',
      build: 'vite build --watch',
      'test:ci': 'vitest run',
      lint: 'eslint . --serve', // pathological, still a non-terminating body flag
      typecheck: 'tsc -p .',
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
      typecheck: 'tsc -p .',
    } });
    const ids = deriveScriptEntries(cwd).map((e) => e.id).sort();
    assert.deepEqual(ids, ['test-real', 'typecheck'], 'dangerous body tokens disqualify regardless of the clean name');
  });

  it('non-terminating tokens are screened in ANY name segment and as BARE body subcommands (build:preview → vite preview)', () => {
    mkProject({ scripts: {
      'build:preview': 'vite preview',
      'test:serve': 'serve report',
      'lint:dev': 'eslint .',
      build: 'vite preview', // terminating name, bare non-terminating body subcommand
      'build:prod': 'vite build',
      test: 'node --test',
    } });
    const ids = deriveScriptEntries(cwd).map((e) => e.id).sort();
    assert.deepEqual(ids, ['build-prod', 'test'], 'mid-name segments and bare body words both disqualify');
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
      build: 'tsc -p .',
      'lint:ci': 'eslint .',
    } });
    const ids = deriveScriptEntries(cwd).map((e) => e.id).sort();
    assert.deepEqual(ids, ['build', 'lint-ci'], 'only the verifiably terminating, non-mutating entries survive');
  });
});

describe('seed-gates — derivation: package-manager-aware commands (never hardcoded npm run)', () => {
  it('pnpm-lock.yaml → pnpm run; yarn.lock → yarn run; default npm run; packageManager field wins', () => {
    mkProject({ scripts: { test: 'x' }, lockfile: 'pnpm-lock.yaml' });
    assert.equal(detectPackageManager(cwd), 'pnpm');
    assert.equal(deriveScriptEntries(cwd)[0].cmd, 'pnpm run test');
    rmSync(join(cwd, 'pnpm-lock.yaml'));
    writeFileSync(join(cwd, 'yarn.lock'), '');
    assert.equal(deriveScriptEntries(cwd)[0].cmd, 'yarn run test');
    rmSync(join(cwd, 'yarn.lock'));
    assert.equal(deriveScriptEntries(cwd)[0].cmd, 'npm run test');
  });

  it('the package.json packageManager field beats the lockfile probe', () => {
    mkProject({ scripts: { test: 'x' }, lockfile: 'yarn.lock', packageManager: 'pnpm@9.0.0' });
    assert.equal(detectPackageManager(cwd), 'pnpm');
  });
});

describe('seed-gates — derivation: kebab-case ids that pass the runner validator', () => {
  it('build:prod → build-prod; every derived entry validates as a full declaration', () => {
    assert.equal(kebabIdOf('build:prod'), 'build-prod');
    assert.equal(kebabIdOf('Test_E2E'), 'test-e2e');
    mkProject({ scripts: { 'build:prod': 'x', 'test.integration': 'x', lint: 'x' } });
    const entries = deriveScriptEntries(cwd);
    assert.deepEqual(validateDeclaration({ gates: entries }), entries, 'the derived entries ARE a valid declaration');
  });
});

// ── the review-state candidate (locked decision) ─────────────────────────────────────

describe('seed-gates — the review-state candidate keys on the slot the checker enforces', () => {
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

// ── preview (dry-run) behavior ────────────────────────────────────────────────────────

describe('seed-gates — preview is the default and writes NOTHING', () => {
  it('dry-run leaves an existing gates.json byte-identical and prints the derived entries + the trust-chain disclosure', () => {
    mkProject({ scripts: { test: 'x' }, gates: { _README: 'mine', gates: [{ id: 'own', title: 'Own', cmd: 'true' }] } });
    const before = gatesRaw();
    const io = quiet();
    const code = main(['--cwd', cwd], io);
    assert.equal(code, 0);
    assert.equal(gatesRaw(), before, 'dry-run must be byte-identical');
    const text = io.out.join('\n');
    assert.match(text, /npm run test/, 'the preview names the derived cmd');
    assert.ok(text.includes(TRUST_CHAIN_DISCLOSURE), 'the preview carries the trust-chain disclosure');
    assert.match(text, /auto-approves byte-exact declared gate commands/, 'the hook implication is stated');
    assert.match(text, /two separate yeses/, 'the two-consent boundary is stated');
    // The consent step must print a RUNNABLE apply command (this tool has no bin and no mode token).
    assert.match(text, /node "[^"]*seed-gates\.mjs" --cwd "[^"]*" --apply/, 'the apply hint is the real invocation');
    assert.doesNotMatch(text, /(^|\s)seed-gates --apply/, 'never a bare non-runnable seed-gates command');
  });

  it('a dry-run with --only prints an apply hint carrying EXACTLY those --only flags (the hint never widens the previewed consent)', () => {
    mkProject({ scripts: { test: 'x', lint: 'x' } });
    const io = quiet();
    assert.equal(main(['--cwd', cwd, '--only', 'test'], io), 0);
    const text = io.out.join('\n');
    assert.match(text, /--apply --only test(\s|$)/, 'the hint carries the previewed subset');
    assert.doesNotMatch(text, /--only lint/, 'nothing outside the previewed subset');
    assert.doesNotMatch(text, /\[--only <id>\]/, 'no generic placeholder when the subset is explicit');
  });

  it('a cwd with double-quote-unsafe metacharacters gets a SAFE generic apply hint, never a broken quoted command', () => {
    const evil = mkdtempSync(join(tmpdir(), 'seed-gates-$evil-'));
    try {
      mkdirSync(join(evil, 'docs', 'ai'), { recursive: true });
      writeFileSync(join(evil, 'docs', 'ai', '.workflow-version'), '1.3.0\n');
      writeFileSync(join(evil, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
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
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
    const io = quiet();
    const code = main(['--cwd', cwd], io);
    assert.equal(code, 1, 'no docs/ai → precondition STOP even on dry-run');
    assert.match(io.out.join('\n'), /docs\/ai/, 'the STOP names the missing deployment');
  });
});

// ── apply behavior (append-only, consented subset, atomic discipline) ─────────────────

describe('seed-gates — --apply appends exactly the consented entries', () => {
  it('appends the --only subset after the existing entries; existing entries stay unmodified; result validates', () => {
    const own = { id: 'own', title: 'Own', cmd: 'true' };
    mkProject({ scripts: { test: 'x', lint: 'x', build: 'x' }, gates: { _README: 'mine', gates: [own] } });
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
    mkProject({ scripts: { test: 'x' } });
    const io = quiet();
    const code = main(['--cwd', cwd, '--apply'], io);
    assert.equal(code, 0, io.out.join('\n'));
    const parsed = JSON.parse(gatesRaw());
    assert.equal(typeof parsed._README, 'string', 'the seeded file carries the template _README');
    assert.deepEqual(loadDeclaration(cwd).gates.map((g) => g.id), ['test']);
  });

  it('an id collision is REFUSED loudly; the file stays byte-identical', () => {
    mkProject({ scripts: { test: 'x' }, gates: { gates: [{ id: 'test', title: 'Mine', cmd: 'true' }] } });
    const before = gatesRaw();
    const io = quiet();
    const code = main(['--cwd', cwd, '--apply'], io);
    assert.equal(code, 1, 'a collision is a precondition failure');
    assert.match(io.out.join('\n'), /collision|already declared/i);
    assert.equal(gatesRaw(), before, 'the declaration is untouched on refusal');
  });

  it('a MALFORMED existing declaration is a STOP — never written over', () => {
    mkProject({ scripts: { test: 'x' }, gates: '{ not json' });
    const before = gatesRaw();
    const io = quiet();
    assert.equal(main(['--cwd', cwd, '--apply'], io), 1);
    assert.equal(gatesRaw(), before);
  });

  it('the stamp gate holds on --apply ONLY: a missing/foreign stamp blocks apply but not the preview', () => {
    mkProject({ scripts: { test: 'x' }, stamp: '9.9.9' });
    const io = quiet();
    assert.equal(main(['--cwd', cwd], io), 0, 'preview works on any deployment');
    assert.equal(main(['--cwd', cwd, '--apply'], quiet()), 1, 'apply is deployment-stamp-gated');
  });

  it('a SYMLINKED gates.json leaf is a STOP — the link target is untouched (the atomic-core discipline)', () => {
    mkProject({ scripts: { test: 'x' } });
    const target = join(cwd, 'elsewhere.json');
    writeFileSync(target, 'SECRET');
    symlinkSync(target, join(cwd, GATES_REL));
    const io = quiet();
    assert.equal(main(['--cwd', cwd, '--apply'], io), 1);
    assert.match(io.out.join('\n'), /symlink/);
    assert.equal(readFileSync(target, 'utf8'), 'SECRET');
  });

  it('--only with an unknown id is a usage error (exit 2), nothing written', () => {
    mkProject({ scripts: { test: 'x' }, gates: { gates: [] } });
    const before = gatesRaw();
    assert.equal(main(['--cwd', cwd, '--apply', '--only', 'nope'], quiet()), 2);
    assert.equal(gatesRaw(), before);
  });

  it('mixed --dry-run --apply is a usage error (exit 2) — a consent-gated writer never lets the later flag win silently', () => {
    mkProject({ scripts: { test: 'x' } });
    const io = quiet();
    assert.equal(main(['--cwd', cwd, '--dry-run', '--apply'], io), 2);
    assert.equal(main(['--cwd', cwd, '--apply', '--dry-run'], quiet()), 2, 'order must not matter');
    assert.match(io.out.join('\n'), /--dry-run.*--apply|--apply.*--dry-run/, 'the error names the conflict');
    assert.equal(readdirSync(join(cwd, 'docs', 'ai')).includes('gates.json'), false, 'nothing written on the conflict');
  });

  it('--only typos are loud in BOTH paths: dry-run rejects too, and an empty offer never masks the typo', () => {
    mkProject({ scripts: { test: 'x' } });
    const dry = quiet();
    assert.equal(main(['--cwd', cwd, '--only', 'nope'], dry), 2, 'a dry-run --only typo is a usage error, never a silent filter');
    assert.match(dry.out.join('\n'), /nope/, 'the error names the unknown id');
    assert.match(dry.out.join('\n'), /offered/i, 'the error lists what IS offered');
    // An empty offer + a --only typo must fail as usage, not return the silent "nothing to offer".
    mkdirSync(join(cwd, 'empty', 'docs', 'ai'), { recursive: true });
    writeFileSync(join(cwd, 'empty', 'docs', 'ai', '.workflow-version'), '1.3.0\n');
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

describe('seed-gates — import direction + tier absence (structural)', () => {
  it('run-gates.mjs (the runner) never imports the seeder — the seeder imports the validator, not the reverse', () => {
    const src = readFileSync(join(HERE, 'run-gates.mjs'), 'utf8');
    assert.ok(!/from\s+['"][^'"]*seed-gates/.test(src), 'run-gates.mjs must not import seed-gates (the runner WRITES NOTHING)');
  });

  it('procedures.mjs (read-only advisor) never imports the seeder nor the atomic-write core', () => {
    const src = readFileSync(join(HERE, 'procedures.mjs'), 'utf8');
    for (const mod of ['seed-gates', 'atomic-write']) {
      assert.ok(
        !new RegExp(`from\\s+['"][^'"]*${mod}`).test(src) && !new RegExp(`import\\(\\s*['"][^'"]*${mod}`).test(src),
        `procedures.mjs must not import ${mod} (read-only invariant)`,
      );
    }
  });

  it('the seeder is OUTSIDE every velocity tier — a consent-per-run writer is never pre-approved', () => {
    for (const rel of KIT_WRITER_PREVIEW_TOOLS) {
      assert.ok(!rel.includes('seed-gates'), `seed-gates must not be in KIT_WRITER_PREVIEW_TOOLS (found ${rel})`);
    }
    for (const entry of UNIVERSAL_READONLY_ALLOWLIST) {
      assert.ok(!String(entry).includes('seed-gates'), `seed-gates must not appear in the core allowlist (${entry})`);
    }
  });

  it('the offer composes script entries + the conditional review-state candidate (buildOffer)', () => {
    mkProject({ scripts: { test: 'x' }, config: { 'plan-execution': { review: 'council' } } });
    const offer = buildOffer(cwd);
    assert.deepEqual(offer.entries.map((e) => e.id), ['test', 'review-state']);
    const preview = formatPreview(offer);
    assert.ok(preview.includes(TRUST_CHAIN_DISCLOSURE));
  });
});
