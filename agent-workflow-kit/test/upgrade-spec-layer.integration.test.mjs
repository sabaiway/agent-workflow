// upgrade-spec-layer.integration.test.mjs — the spec layer delivered to an EXISTING deployment, end
// to end: a project bootstrapped on the memory 4.5.x bytes (no reader, no store root, the deployed
// checker on a shipped prior) runs the kit's ONE ensure command with --reconcile and gains the reader
// pair, a refreshed checker pair byte-equal to the bundle, and a rendered store root; then the REAL
// deployed pre-commit hook (the refreshed checker + --check-index + the deployed test suite) lets a
// seeded valid spec commit, and the navigator carries ONE collapsed specs/ row. Three variants pin
// the decided edges: a 4.6.x deployment's reader pair (2a: on the 4.6.0 bodies, checker current)
// refreshes and the store then seeds, a legacy ADR layout is moved by the scripts ensure and still seeds
// (D-G; the deployment's git init and installer and the op's spawns GIT_-stripped, so a hook's GIT_DIR never takes the snapshot), a custom checker
// is replaced by the bundled body on the same plain run, the store root seeded behind it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { stripGitLocationEnv } from '../tools/git-env.mjs';

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
// Compared as a boolean: a failed equality of two whole script bodies prints both.
const isBundled = (project, name) => readFileSync(join(project, 'scripts', name), 'utf8') === bundle(name);
const PRIOR_DIR = {
  'check-docs-size.mjs': '4.5.1',
  'check-docs-size.test.mjs': '4.0.0',
  'spec-schema.mjs': '4.6.0',
  'spec-schema.test.mjs': '4.6.0',
};
const prior = (name) => readFileSync(join(PRIORS, PRIOR_DIR[name], `${name}.txt`), 'utf8');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
const readPriorChecker = () => readFileSync(join(PRIORS, '7.0.0', 'check-docs-size.mjs.txt'), 'utf8');
const writeDoc = (project, name) => writeFileSync(join(project, 'docs', 'ai', `${name}.md`),
  `---\ntype: state\nlastUpdated: 2026-08-23\nscope: session\nstaleAfter: never\nowner: none\nmaxLines: 10\n---\n\n# ${name}\n`);

// A deployment the way memory 4.5.x left it: the current docs/ai templates minus the spec store,
// every enforcement script minus the reader pair, the checker pair on the 4.5.1..4.5.4 bytes, a real
// git checkout with the deployed hook installed and the base committed.
const deploy = ({ checker = 'prior', reader = 'absent', legacyAdr = false, checkerBody, checkerTestBody, extraDocs = 0 } = {}) => {
  const project = mkdtempSync(join(tmpdir(), 'upgrade-spec-layer-'));
  cpSync(join(TEMPLATES, 'AGENTS.md'), join(project, 'AGENTS.md'));
  writeFileSync(join(project, 'package.json'), '{"name":"fixture"}\n');
  const docsAi = join(project, 'docs', 'ai');
  mkdirSync(docsAi, { recursive: true });
  for (const entry of readdirSync(TEMPLATES)) {
    if (!SKILL_HOME_ONLY.has(entry)) cpSync(join(TEMPLATES, entry), join(docsAi, entry), { recursive: true });
  }
  for (const name of Array.from({ length: extraDocs }, (_, index) => `d${String(index).padStart(2, '0')}`)) {
    writeDoc(project, name);
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
      if (reader === 'current') writeFileSync(join(scripts, name), bundle(name));
      continue;
    }
    const body = name === CHECKER[0] ? checkerBody : name === CHECKER[1] ? checkerTestBody : undefined;
    writeFileSync(join(scripts, name), body ?? (CHECKER.includes(name) ? (checker === 'prior' ? prior(name) : checker === 'current' ? bundle(name) : '// my own checker\n') : bundle(name)));
  }
  execFileSync('git', ['init', '-q'], { cwd: project, stdio: 'pipe', env: stripGitLocationEnv(process.env) });
  execFileSync(process.execPath, [join(scripts, 'install-git-hooks.mjs')], { cwd: project, stdio: 'pipe', env: stripGitLocationEnv(process.env) });
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
const seam = (cmd, args, options) => spawnSync(cmd, args, { ...options, env: stripGitLocationEnv(process.env) });
const checkDeployedDocs = (project, ...args) => {
  const result = spawnSync(process.execPath, ['scripts/check-docs-size.mjs', ...args], { cwd: project, encoding: 'utf8' });
  assert.equal(result.status, 0, `the deployed checker ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
};
const commitDeployment = (project) => {
  git(project, 'add', '-A');
  const commit = spawnSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'upgrade'], { cwd: project, encoding: 'utf8' });
  assert.equal(commit.status, 0, `the deployed pre-commit hook refused the upgraded tree:\n${commit.stdout}\n${commit.stderr}`);
};

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

  it('a legacy ADR layout: the scripts ensure refreshes and moves the store, and the spec layer still seeds (D-G: no ADR-layout dependency)', () => {
    withDeployment({ legacyAdr: true }, (project) => {
      const r = main(['--reconcile', '--cwd', project], { kitRoot: KIT_ROOT, deps: { spawnSync: seam } });
      const tokens = tokensOf(r.stdout);
      assert.deepEqual([r.code, tokens.scripts, tokens.specs, r.stdout.includes('ADR store: brought-current: migrated')], [0, 'refreshed', 'seeded', true], r.stdout);
      assert.deepEqual([existsSync(join(project, 'docs', 'ai', 'history', 'decisions-archive.md')), seam(process.execPath, ['scripts/archive-decisions.mjs', '--check'], { cwd: project }).status, readdirSync(join(project, '.git')).some((name) => name.startsWith('agent-workflow-adr-migration-snapshot-'))], [false, 0, true], r.stdout);
      assert.ok(existsSync(join(project, STORE)));
      assert.equal(readFileSync(join(project, 'scripts', CHECKER[0]), 'utf8'), bundle(CHECKER[0]));
    });
  });

  it('a custom checker pair is replaced by the bundled bodies on the plain run, its lines naming where an edit meant to last goes, and the store root is seeded behind it', () => {
    withDeployment({ checker: 'custom' }, (project) => {
      const r = reconcile(project);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(tokensOf(r.stdout).specs, 'seeded', r.stdout);
      assert.deepEqual([...READER, ...CHECKER].filter((name) => !isBundled(project, name)), [], 'every pair file is the bundled body');
      assert.ok(existsSync(join(project, STORE)), 'the store root is seeded');
      for (const name of CHECKER) assert.ok(r.stdout.includes(`scripts/${name}: differs from every body this kit knows it shipped — replaced by the bundled body; an edit meant to last goes in `), name);
      assert.doesNotMatch(r.stdout, /by hand|--replace-custom|user's yes/);
      // The second run writes nothing: the pairs are current.
      assert.equal(tokensOf(reconcile(project).stdout).specs, 'already-present');
    });
  });
});

describe('spec:docs-navigator/S6 the hook commits after one plain run', () => {
  it('a project past 80 lines on a checker whose render differs is written current by one plain run and commits', () => {
    withDeployment({
      checkerBody: `${readPriorChecker()}// edited\n`,
      checkerTestBody: bundle(CHECKER[1]),
      extraDocs: 90,
    }, (project) => {
      const r = reconcile(project);
      assert.equal(r.code, 0, r.stdout);
      assert.deepEqual([tokensOf(r.stdout).index, isBundled(project, CHECKER[0]), r.stdout.includes('--replace-custom')], ['regenerated', true, false], r.stdout);
      const navigator = readFileSync(join(project, 'docs', 'ai', 'index.md'), 'utf8');
      assert.ok(navigator.trimEnd().split('\n').length > 80, 'the navigator exercises the cap past 80 lines');
      checkDeployedDocs(project);
      checkDeployedDocs(project, '--check-index');
      commitDeployment(project);
    });
  });

  it('a prior checker beside a custom test file whose docs change in the upgrade commits after one plain run', () => {
    withDeployment({ reader: 'current', checkerBody: readPriorChecker(), checkerTestBody: `${bundle(CHECKER[1])}// mine\n` }, (project) => {
      checkDeployedDocs(project, '--write-index');
      writeDoc(project, 'added');
      const r = reconcile(project);
      assert.equal(r.code, 0, r.stdout);
      assert.deepEqual(CHECKER.filter((name) => !isBundled(project, name)), [], 'the checker pair is the bundled bodies');
      checkDeployedDocs(project, '--check-index');
      commitDeployment(project);
    });
  });
});

describe("spec:distribution-files/S12 an earlier release's kept-aside folder stays out of git and the hook commits", () => {
  it('edited pair files beside the folder and its ignore file: one plain run writes them to the bundled bytes, git lists nothing under the folder, it stays byte-identical, the commit passes', () => {
    withDeployment({ checkerBody: `${readPriorChecker()}// edited\n`, checkerTestBody: `${bundle(CHECKER[1])}// mine\n` }, (project) => {
      const reserved = join(project, '.agent-workflow');
      mkdirSync(join(reserved, 'kept-aside', '0123456789abcdef', 'scripts'), { recursive: true });
      writeFileSync(join(reserved, '.gitignore'), '*\n');
      writeFileSync(join(reserved, 'kept-aside', '0123456789abcdef', 'scripts', CHECKER[0]), '// an edit an earlier release kept aside\n');
      const folder = () => readdirSync(reserved, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => [join(entry.parentPath, entry.name), readFileSync(join(entry.parentPath, entry.name), 'utf8')]).sort();
      const before = folder();
      const r = reconcile(project);
      assert.equal(r.code, 0, r.stdout);
      assert.deepEqual(CHECKER.filter((name) => !isBundled(project, name)), [], 'the checker pair is the bundled bodies');
      const status = git(project, 'status', '--porcelain', '--untracked-files=all');
      assert.deepEqual([status.split('\n').some((line) => line.includes('.agent-workflow')), folder()], [false, before], status);
      commitDeployment(project);
    });
  });
});
