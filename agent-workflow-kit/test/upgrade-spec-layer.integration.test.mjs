// upgrade-spec-layer.integration.test.mjs — the spec layer delivered to an EXISTING deployment, end
// to end: a project whose kit folder scripts/agent-workflow/ holds the deployed family (no reader, no
// store root, the deployed checker on an earlier body) runs the kit's ONE ensure command with
// --reconcile and gains the reader pair, a refreshed checker byte-equal to the bundle, and a rendered
// store root; then the REAL deployed pre-commit hook (the refreshed checker and its --check-index at
// their deployed paths, no suite) lets a seeded valid spec commit, and the navigator carries ONE
// collapsed specs/ row. Three variants pin the decided edges: a reader pair on earlier bodies (checker
// current) refreshes and the store then seeds, a legacy ADR layout is moved by the scripts ensure and
// still seeds (D-G; the deployment's git init and installer and the op's spawns GIT_-stripped, so a
// hook's GIT_DIR never takes the snapshot), a custom checker is replaced by the bundled body on the
// same plain run, the store root seeded behind it. The catalog names no file in the kit folder, so
// every earlier body is catalogued through the ops' deps.priors seam, keyed by manifest path.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { stripGitLocationEnv } from '../tools/git-env.mjs';
import { DEPLOYED_SCRIPTS, INSTALLER_REL } from '../tools/node-evidence.mjs';
import { SCRIPT_PRIORS, digestOf } from '../tools/script-priors.mjs';

const { main } = await import('../tools/ensure-configs.mjs').catch(() => ({}));

const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MEMORY = join(KIT_ROOT, '..', 'agent-workflow-memory');
const TEMPLATES = join(MEMORY, 'references', 'templates');
const PRIORS = join(KIT_ROOT, 'test', 'fixtures', 'script-priors');
// The pairs: the spec-schema module's deployed entries and the docs-size module's, by manifest path.
const pathsOf = (name) => DEPLOYED_SCRIPTS.filter(({ module }) => module === name).map(({ path }) => path);
const [READER, CHECKER] = [pathsOf('spec-schema'), pathsOf('docs-size')];
const READER_BODY = 'spec-schema/spec-schema.mjs';
const CHECKER_SUITE = 'docs-size/check-docs-size.test.mjs';
const STORE = join('docs', 'ai', 'specs', 'index.md');
const SKILL_HOME_ONLY = new Set(['AGENTS.md', 'adr-record.md', 'SPEC_TEMPLATE.md', 'specs']);
const VALID_SPEC = '---\ntype: spec\nlastUpdated: 2026-08-23\nscope: permanent\nstaleAfter: 90d\nowner: none\nmaxLines: 150\nkind: spec\nstatus: draft\nrevision: 1\n---\n\n# Spec: login\n\n## Contract\n\nc\n\n## Scenarios\n\n- S1 a :: test/login.test.mjs :: spec:login/S1\n\n## Out of scope\n\n- b\n\n## Module\n\n- src/login/\n';

const bundle = (path) => readFileSync(join(KIT_ROOT, 'references', 'scripts', ...path.split('/')), 'utf8');
const at = (project, path) => join(project, 'scripts', 'agent-workflow', ...path.split('/'));
// Compared as a boolean: a failed equality of two whole script bodies prints both.
const isBundled = (project, path) => readFileSync(at(project, path), 'utf8') === bundle(path);
const fixture = (version, name) => readFileSync(join(PRIORS, version, `${name}.txt`), 'utf8');
// The earlier body each pair file is deployed on, and the catalog rows that name them at their manifest paths.
const EARLIER = {
  [CHECKER[0]]: fixture('4.5.1', 'check-docs-size.mjs'),
  [READER_BODY]: fixture('4.6.0', 'spec-schema.mjs'),
  'spec-schema/index.mjs': '// an earlier spec-schema/index.mjs\n',
};
const READER_8_0_0 = fixture('8.0.0', 'spec-schema.mjs');
const PRIORS_SEAM = [...SCRIPT_PRIORS, ...[...Object.entries(EARLIER), [READER_BODY, READER_8_0_0]].map(([file, body]) => ({ file, digest: digestOf(body) }))];
const earlier = (path) => {
  assert.ok(path in EARLIER, `${path}: an earlier body is catalogued`);
  return EARLIER[path];
};
const strippedEnv = () => stripGitLocationEnv(process.env);
const GIT_IDENTITY = ['-c', 'user.name=probe', '-c', 'user.email=probe@example.com', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...args) => execFileSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8', stdio: 'pipe', env: strippedEnv() });
const readPriorChecker = () => fixture('7.0.0', 'check-docs-size.mjs');
const writeDoc = (project, name) => writeFileSync(join(project, 'docs', 'ai', `${name}.md`),
  `---\ntype: state\nlastUpdated: 2026-08-23\nscope: session\nstaleAfter: never\nowner: none\nmaxLines: 10\n---\n\n# ${name}\n`);
const writeAt = (project, path, body) => {
  mkdirSync(dirname(at(project, path)), { recursive: true });
  writeFileSync(at(project, path), body);
};
const stateBody = (path, state) => (state === 'prior' ? earlier(path) : state === 'current' ? bundle(path) : '// my own checker\n');

// A deployment the kit folder holds: the current docs/ai templates minus the spec store, every
// deployed family file minus the reader pair, the checker on an earlier body, a real git checkout
// with the hook its installer writes.
const deploy = ({ checker = 'prior', reader = 'absent', legacyAdr = false, bodies = {}, extraDocs = 0 } = {}) => {
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
  for (const { path } of DEPLOYED_SCRIPTS) {
    if (READER.includes(path) && reader === 'absent' && !(path in bodies)) continue;
    const state = READER.includes(path) ? reader : CHECKER.includes(path) ? checker : 'current';
    writeAt(project, path, bodies[path] ?? stateBody(path, state));
  }
  execFileSync('git', ['init', '-q'], { cwd: project, stdio: 'pipe', env: strippedEnv() });
  execFileSync(process.execPath, [join(project, INSTALLER_REL)], { cwd: project, stdio: 'pipe', env: strippedEnv() });
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
const reconcile = (project, deps = {}) => main(['--reconcile', '--cwd', project], { kitRoot: KIT_ROOT, deps: { priors: PRIORS_SEAM, ...deps } });
const seam = (cmd, args, options) => spawnSync(cmd, args, { ...options, env: strippedEnv() });
const checkDeployedDocs = (project, ...args) => {
  const result = spawnSync(process.execPath, [join('scripts', 'agent-workflow', ...CHECKER[0].split('/')), ...args], { cwd: project, encoding: 'utf8' });
  assert.equal(result.status, 0, `the deployed checker ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
};
const commitDeployment = (project, message = 'upgrade') => {
  git(project, 'add', '-A');
  const commit = spawnSync('git', [...GIT_IDENTITY, 'commit', '-q', '-m', message], { cwd: project, encoding: 'utf8', env: strippedEnv() });
  assert.equal(commit.status, 0, `the deployed pre-commit hook refused the upgraded tree:\n${commit.stdout}\n${commit.stderr}`);
};

describe('the spec layer reaches an existing deployment on --reconcile (earlier pair bodies end to end)', () => {
  it('seeds the reader pair, refreshes the prior checker, renders the store root; the real hook commits a seeded spec; ONE specs/ row', () => {
    withDeployment({}, (project) => {
      assert.equal(existsSync(join(project, STORE)), false, 'no store root before the upgrade');
      const r = reconcile(project);
      assert.equal(r.code, 0, r.stdout);
      const tokens = tokensOf(r.stdout);
      assert.equal(tokens.specs, 'seeded', r.stdout);
      assert.equal(tokens.index, 'regenerated', 'the navigator is regenerated AFTER the store root landed');
      for (const path of [...READER, ...CHECKER]) {
        assert.equal(readFileSync(at(project, path), 'utf8'), bundle(path), `${path} is the bundled body`);
      }
      const root = readFileSync(join(project, STORE), 'utf8');
      assert.match(root, /^kind: index$/m);
      assert.equal(root.includes('{{'), false, 'every placeholder rendered');

      // A second run claims nothing and changes nothing.
      const again = reconcile(project);
      assert.equal(again.code, 0, again.stdout);
      assert.equal(tokensOf(again.stdout).specs, 'already-present');

      // The deployed hook: the refreshed checker and its --check-index at their deployed paths, over a
      // seeded valid spec. The navigator is regenerated by the DEPLOYED checker, the one the hook runs.
      writeFileSync(join(project, 'docs', 'ai', 'specs', 'login.md'), VALID_SPEC);
      checkDeployedDocs(project, '--write-index');
      const navigator = readFileSync(join(project, 'docs', 'ai', 'index.md'), 'utf8');
      const rows = navigator.split('\n').filter((line) => line.includes('](./specs/index.md)'));
      assert.equal(rows.length, 1, 'exactly one specs/ row');
      assert.match(rows[0], /\| 1 specs \| 0 parts · 1 indexes \|/);
      assert.equal(navigator.includes('specs/login.md'), false, 'the spec itself is collapsed');
      commitDeployment(project, 'seed');
    });
  });

  it('a deployment on the 8.0.0 reader body is refreshed by one plain run, and its navigator counts a store-root index of 31 children', () => {
    withDeployment({ checker: 'current', reader: 'prior', bodies: { [READER_BODY]: READER_8_0_0 } }, (project) => {
      const r = reconcile(project);
      assert.equal(r.code, 0, r.stdout);
      for (const path of READER) assert.ok(r.stdout.includes(`scripts/agent-workflow/${path}: matches a body an earlier release shipped — refreshed to the bundled one`), `${path}\n${r.stdout}`);
      assert.deepEqual(READER.filter((path) => !isBundled(project, path)), [], 'the reader pair is the bundled bodies');
      const children = Array.from({ length: 31 }, (_, i) => `- [c${i + 1}](./c${i + 1}.md)`);
      writeFileSync(join(project, STORE), `${readFileSync(join(project, STORE), 'utf8')}${children.join('\n')}\n`);
      checkDeployedDocs(project, '--write-index');
      const navigator = readFileSync(join(project, 'docs', 'ai', 'index.md'), 'utf8');
      const rows = navigator.split('\n').filter((line) => line.includes('specs/'));
      assert.equal(rows.length, 1, `exactly one specs/ row\n${rows.join('\n')}`);
      assert.match(rows[0], /\| 0 specs \| 0 parts · 1 indexes \|/, 'the 31-children store root reads clean and is counted');
    });
  });

  it('a reader pair on earlier bodies, checker already current, upgrades WHOLE: reader refreshed, store seeded, the real hook commits', () => {
    withDeployment({ reader: 'prior', checker: 'current' }, (project) => {
      const r = reconcile(project);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(tokensOf(r.stdout).specs, 'seeded', r.stdout);
      assert.match(r.stdout, /spec-schema\/spec-schema\.mjs: matches a body an earlier release shipped — refreshed to the bundled one/);
      for (const path of [...READER, ...CHECKER]) {
        assert.equal(readFileSync(at(project, path), 'utf8'), bundle(path), `${path} is the bundled body`);
      }
      assert.ok(existsSync(join(project, STORE)));
      checkDeployedDocs(project, '--write-index');
      commitDeployment(project);
    });
  });

  it('a legacy ADR layout: the scripts ensure refreshes and moves the store, and the spec layer still seeds (D-G: no ADR-layout dependency)', () => {
    withDeployment({ legacyAdr: true }, (project) => {
      const r = reconcile(project, { spawnSync: seam });
      const tokens = tokensOf(r.stdout);
      assert.deepEqual([r.code, tokens.scripts, tokens.specs, r.stdout.includes('ADR store: brought-current: migrated')], [0, 'refreshed', 'seeded', true], r.stdout);
      const rotator = join('scripts', 'agent-workflow', 'archives', 'archive-decisions.mjs');
      assert.deepEqual([existsSync(join(project, 'docs', 'ai', 'history', 'decisions-archive.md')), seam(process.execPath, [rotator, '--check'], { cwd: project }).status, readdirSync(join(project, '.git')).some((name) => name.startsWith('agent-workflow-adr-migration-snapshot-'))], [false, 0, true], r.stdout);
      assert.ok(existsSync(join(project, STORE)));
      assert.equal(readFileSync(at(project, CHECKER[0]), 'utf8'), bundle(CHECKER[0]));
    });
  });

  it('a custom checker is replaced by the bundled body on the plain run, its line naming where an edit meant to last goes, and the store root is seeded behind it', () => {
    withDeployment({ checker: 'custom' }, (project) => {
      const r = reconcile(project);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(tokensOf(r.stdout).specs, 'seeded', r.stdout);
      assert.deepEqual([...READER, ...CHECKER].filter((path) => !isBundled(project, path)), [], 'every pair file is the bundled body');
      assert.ok(existsSync(join(project, STORE)), 'the store root is seeded');
      for (const path of CHECKER) assert.ok(r.stdout.includes(`scripts/agent-workflow/${path}: differs from every body this kit knows it shipped — replaced by the bundled body; an edit meant to last goes in `), path);
      assert.doesNotMatch(r.stdout, /by hand|--replace-custom|user's yes/);
      // The second run writes nothing: the pairs are current.
      assert.equal(tokensOf(reconcile(project).stdout).specs, 'already-present');
    });
  });
});

describe('spec:docs-navigator/S6 the hook commits after one plain run', () => {
  it('a project past 80 lines on a checker whose render differs is written current by one plain run and commits', () => {
    withDeployment({ bodies: { [CHECKER[0]]: `${readPriorChecker()}// edited\n` }, extraDocs: 90 }, (project) => {
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
    withDeployment({ reader: 'current', checker: 'current' }, (project) => {
      checkDeployedDocs(project, '--write-index');
      writeAt(project, CHECKER[0], earlier(CHECKER[0]));
      writeAt(project, CHECKER_SUITE, `${bundle(CHECKER_SUITE)}// mine\n`);
      writeDoc(project, 'added');
      const r = reconcile(project);
      assert.equal(r.code, 0, r.stdout);
      assert.deepEqual(CHECKER.filter((path) => !isBundled(project, path)), [], 'the checker is the bundled body');
      checkDeployedDocs(project, '--check-index');
      commitDeployment(project);
    });
  });
});

describe("spec:distribution-files/S12 an earlier release's kept-aside folder stays out of git and the hook commits", () => {
  it('edited pair files beside the folder and its ignore file: one plain run writes them to the bundled bytes, git lists nothing under the folder, it stays byte-identical, the commit passes', () => {
    withDeployment({ reader: 'current', bodies: { [CHECKER[0]]: `${readPriorChecker()}// edited\n`, [READER_BODY]: `${bundle(READER_BODY)}// mine\n` } }, (project) => {
      const reserved = join(project, '.agent-workflow');
      mkdirSync(join(reserved, 'kept-aside', '0123456789abcdef', 'scripts'), { recursive: true });
      writeFileSync(join(reserved, '.gitignore'), '*\n');
      writeFileSync(join(reserved, 'kept-aside', '0123456789abcdef', 'scripts', 'check-docs-size.mjs'), '// an edit an earlier release kept aside\n');
      const folder = () => readdirSync(reserved, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => [join(entry.parentPath, entry.name), readFileSync(join(entry.parentPath, entry.name), 'utf8')]).sort();
      const before = folder();
      const r = reconcile(project);
      assert.equal(r.code, 0, r.stdout);
      assert.deepEqual([...READER, ...CHECKER].filter((path) => !isBundled(project, path)), [], 'the pair files are the bundled bodies');
      const status = git(project, 'status', '--porcelain', '--untracked-files=all');
      assert.deepEqual([status.split('\n').some((line) => line.includes('.agent-workflow')), folder()], [false, before], status);
      commitDeployment(project);
    });
  });
});
