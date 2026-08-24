// upgrade-spec-layer.integration.test.mjs — the spec layer delivered to an EXISTING deployment, end
// to end: a project bootstrapped on the memory 4.5.x bytes (no reader, no store root, the deployed
// checker on a shipped prior) runs the kit's ONE ensure command with --reconcile and gains the reader
// pair, a refreshed checker pair byte-equal to the bundle, and a rendered store root; then the REAL
// deployed pre-commit hook (the refreshed checker + --check-index + the deployed test suite) lets a
// seeded valid spec commit, and the navigator carries ONE collapsed specs/ row. Three variants pin
// the decided edges: a 4.6.x deployment's reader pair (2a: on the 4.6.0 bodies, checker current)
// refreshes and the store then seeds, the legacy ADR layout still seeds (D-G), a custom checker is
// preserved with no store root (D-E).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const { main } = await import('../tools/ensure-configs.mjs').catch(() => ({}));

const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MEMORY = join(KIT_ROOT, '..', 'agent-workflow-memory');
const TEMPLATES = join(MEMORY, 'references', 'templates');
const BUNDLE = join(KIT_ROOT, 'references', 'scripts');
const PRIORS = join(KIT_ROOT, 'test', 'fixtures', 'script-priors');
const READER = ['spec-schema.mjs', 'spec-schema.test.mjs'];
const CHECKER = ['check-docs-size.mjs', 'check-docs-size.test.mjs'];
const STORE = join('docs', 'ai', 'specs', 'index.md');
const SKILL_HOME_ONLY = new Set(['AGENTS.md', 'adr-record.md', 'SPEC_TEMPLATE.md', 'specs']);
const VALID_SPEC = '---\ntype: spec\nlastUpdated: 2026-08-23\nscope: permanent\nstaleAfter: 90d\nowner: none\nmaxLines: 150\nkind: spec\nstatus: draft\nrevision: 1\n---\n\n# Spec: login\n\n## Contract\n\nc\n\n## Scenarios\n\n- S1 a :: test/login.test.mjs :: spec:login/S1\n\n## Out of scope\n\n- b\n\n## Module\n\n- src/login/\n';

const bundle = (name) => readFileSync(join(BUNDLE, name), 'utf8');
const PRIOR_DIR = {
  'check-docs-size.mjs': '4.5.1',
  'check-docs-size.test.mjs': '4.0.0',
  'spec-schema.mjs': '4.6.0',
  'spec-schema.test.mjs': '4.6.0',
};
const prior = (name) => readFileSync(join(PRIORS, PRIOR_DIR[name], `${name}.txt`), 'utf8');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });

// A deployment the way memory 4.5.x left it: the current docs/ai templates minus the spec store,
// every enforcement script minus the reader pair, the checker pair on the 4.5.1..4.5.4 bytes, a real
// git checkout with the deployed hook installed and the base committed.
const deploy = ({ checker = 'prior', reader = 'absent', legacyAdr = false } = {}) => {
  const project = mkdtempSync(join(tmpdir(), 'upgrade-spec-layer-'));
  cpSync(join(TEMPLATES, 'AGENTS.md'), join(project, 'AGENTS.md'));
  writeFileSync(join(project, 'package.json'), '{"name":"fixture"}\n');
  const docsAi = join(project, 'docs', 'ai');
  mkdirSync(docsAi, { recursive: true });
  for (const entry of readdirSync(TEMPLATES)) {
    if (!SKILL_HOME_ONLY.has(entry)) cpSync(join(TEMPLATES, entry), join(docsAi, entry), { recursive: true });
  }
  if (legacyAdr) {
    mkdirSync(join(docsAi, 'history'), { recursive: true });
    writeFileSync(join(docsAi, 'history', 'decisions-archive.md'), '# old monolith\n');
  }
  const scripts = join(project, 'scripts');
  mkdirSync(scripts);
  for (const name of readdirSync(BUNDLE)) {
    if (READER.includes(name)) {
      if (reader === 'prior') writeFileSync(join(scripts, name), prior(name));
      continue;
    }
    writeFileSync(join(scripts, name), CHECKER.includes(name) ? (checker === 'prior' ? prior(name) : checker === 'current' ? bundle(name) : '// my own checker\n') : bundle(name));
  }
  git(project, 'init', '-q');
  execFileSync(process.execPath, [join(scripts, 'install-git-hooks.mjs')], { cwd: project, stdio: 'pipe' });
  return project;
};
const withDeployment = (opts, fn) => {
  const project = deploy(opts);
  try {
    return fn(project);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
};
const tokensOf = (stdout) => Object.fromEntries(stdout.split('\n').map((l) => l.match(/^ {2}([a-z]+): ([a-z-]+)$/)).filter(Boolean).map(([, op, token]) => [op, token]));
const reconcile = (project) => main(['--reconcile', '--cwd', project], { kitRoot: KIT_ROOT });

describe('the spec layer reaches an existing deployment on --reconcile (the 4.5.x and 4.6.x lines end to end)', () => {
  it('seeds the reader pair, refreshes the prior checker pair, renders the store root; the real hook commits a seeded spec; ONE specs/ row', () => {
    withDeployment({}, (project) => {
      assert.equal(existsSync(join(project, STORE)), false, 'no store root before the upgrade');
      const r = reconcile(project);
      assert.equal(r.code, 0, r.stdout);
      const tokens = tokensOf(r.stdout);
      assert.equal(tokens.specs, 'seeded', r.stdout);
      assert.equal(tokens.index, 'regenerated', 'the navigator is regenerated AFTER the store root landed');
      for (const name of [...READER, ...CHECKER]) {
        assert.equal(readFileSync(join(project, 'scripts', name), 'utf8'), bundle(name), `${name} is the bundled body`);
      }
      const root = readFileSync(join(project, STORE), 'utf8');
      assert.match(root, /^kind: index$/m);
      assert.equal(root.includes('{{'), false, 'every placeholder rendered');

      // A second run claims nothing and changes nothing.
      const again = reconcile(project);
      assert.equal(again.code, 0, again.stdout);
      assert.equal(tokensOf(again.stdout).specs, 'already-present');

      // The deployed hook: the refreshed checker + its --check-index + the deployed test suite, over a
      // seeded valid spec. The navigator is regenerated by the DEPLOYED checker, the one the hook runs.
      writeFileSync(join(project, 'docs', 'ai', 'specs', 'login.md'), VALID_SPEC);
      execFileSync(process.execPath, [join(project, 'scripts', 'check-docs-size.mjs'), '--write-index', `--root=${project}`], { cwd: project, stdio: 'pipe' });
      const navigator = readFileSync(join(project, 'docs', 'ai', 'index.md'), 'utf8');
      const rows = navigator.split('\n').filter((line) => line.includes('](./specs/index.md)'));
      assert.equal(rows.length, 1, 'exactly one specs/ row');
      assert.match(rows[0], /\| 1 specs \| 0 parts · 1 indexes \|/);
      assert.equal(navigator.includes('specs/login.md'), false, 'the spec itself is collapsed');
      git(project, 'add', '-A');
      const commit = spawnSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed'], { cwd: project, encoding: 'utf8' });
      assert.equal(commit.status, 0, `the deployed pre-commit hook refused the seeded spec:\n${commit.stdout}\n${commit.stderr}`);
    });
  });

  it('a 4.6.x deployment (reader pair on the 4.6.0 bodies, checker already current) upgrades WHOLE: reader refreshed, store seeded, the real hook commits', () => {
    withDeployment({ reader: 'prior', checker: 'current' }, (project) => {
      const r = reconcile(project);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(tokensOf(r.stdout).specs, 'seeded', r.stdout);
      assert.match(r.stdout, /spec-schema\.mjs: matches a body an earlier release shipped — refreshed to the bundled one/);
      for (const name of [...READER, ...CHECKER]) {
        assert.equal(readFileSync(join(project, 'scripts', name), 'utf8'), bundle(name), `${name} is the bundled body`);
      }
      assert.ok(existsSync(join(project, STORE)));
      execFileSync(process.execPath, [join(project, 'scripts', 'check-docs-size.mjs'), '--write-index', `--root=${project}`], { cwd: project, stdio: 'pipe' });
      git(project, 'add', '-A');
      const commit = spawnSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'upgrade'], { cwd: project, encoding: 'utf8' });
      assert.equal(commit.status, 0, `the deployed pre-commit hook refused the upgraded tree:\n${commit.stdout}\n${commit.stderr}`);
    });
  });

  it('the legacy ADR layout instructs the scripts ensure but still gains the spec layer (D-G: no ADR-layout dependency)', () => {
    withDeployment({ legacyAdr: true }, (project) => {
      const r = reconcile(project);
      const tokens = tokensOf(r.stdout);
      assert.equal(tokens.scripts, 'old-adr-layout-migration-instructed');
      assert.equal(tokens.specs, 'seeded', r.stdout);
      assert.ok(existsSync(join(project, STORE)));
      assert.equal(readFileSync(join(project, 'scripts', CHECKER[0]), 'utf8'), bundle(CHECKER[0]));
    });
  });

  it('a custom checker is preserved verbatim, the reader pair still lands (so the token is seeded), and NO store root is seeded behind it (D-E)', () => {
    withDeployment({ checker: 'custom' }, (project) => {
      const r = reconcile(project);
      assert.equal(r.code, 0, r.stdout);
      const tokens = tokensOf(r.stdout);
      assert.equal(tokens.specs, 'seeded', r.stdout);
      for (const name of CHECKER) assert.equal(readFileSync(join(project, 'scripts', name), 'utf8'), '// my own checker\n', `${name} verbatim`);
      for (const name of READER) assert.equal(readFileSync(join(project, 'scripts', name), 'utf8'), bundle(name), `${name} seeded (create-only, nothing depends on it)`);
      assert.equal(existsSync(join(project, 'docs', 'ai', 'specs')), false, 'no store root, no store dir');
      assert.match(r.stdout, /preserved verbatim/);
      assert.match(r.stdout, /references\/scripts\/ when convenient/);
      assert.match(r.stdout, /index\.md: not seeded/);
      // The second run writes nothing behind the custom pair: now the token says so.
      assert.equal(tokensOf(reconcile(project).stdout).specs, 'customized-preserved');
    });
  });
});
