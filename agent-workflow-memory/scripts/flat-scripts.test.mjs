import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFamily } from '../references/scripts/family.mjs';

const SKILL_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BUNDLE = join(SKILL_ROOT, 'references/scripts');
const KIT_FOLDER = 'scripts/agent-workflow';
const DEPLOYED = readFamily(BUNDLE).filter((entry) => entry.role === 'deployed');
const BY_NAME = new Map(DEPLOYED.map(({ path }) => [basename(path), path]));
const BODY_NAMES = [...BY_NAME.keys()].filter((name) => !['run.mjs', 'index.mjs', 'project-root.mjs'].includes(name));
const FLAT_COUNT = 25;
const FLAT_NAME = 'archive-caps.mjs';
const EDITED_SUITE = 'archive-caps.test.mjs';
const CURRENT_STORE = { status: 0, stdout: 'already-current\n', stderr: '' };
const OUTSIDE = { status: 128, stdout: '', stderr: '' };
const INSIDE = { status: 0, stdout: 'true\n', stderr: '' };
const OUTSIDE_LINE = /(?:not|outside|no) (?:a )?(?:git )?work tree/i;
const tempDirs = [];
const makeRoot = () => { const root = mkdtempSync(join(tmpdir(), 'memory-flat-')); tempDirs.push(root); return root; };
afterEach(() => { for (const root of tempDirs.splice(0)) rmSync(root, { recursive: true, force: true }); });
const putFile = (root, path, body = '') => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); };
const readBody = (name) => readFileSync(join(BUNDLE, BY_NAME.get(name)), 'utf8');
const makeProject = ({ command = true, all = false } = {}) => {
  const root = makeRoot();
  putFile(root, 'package.json', '{}\n');
  if (command) putFile(root, `${KIT_FOLDER}/run.mjs`, readBody('run.mjs'));
  if (all) for (const { path } of DEPLOYED) putFile(root, `${KIT_FOLDER}/${path}`, readFileSync(join(BUNDLE, path)));
  return root;
};
const makeError = (code) => Object.assign(new Error(code), { code });
const makeGit = (root, { tree = OUTSIDE, visibility = OUTSIDE } = {}, calls = []) => (command, args, options) => {
  calls.push(args);
  assert.equal(command, 'git'); assert.equal(options.cwd, root);
  assert.deepEqual(Object.keys(options.env).filter((key) => /^GIT_/i.test(key) || key === 'NODE_TEST_CONTEXT'), []);
  assert.ok(!args.some((arg) => ['add', 'rm', 'update-index', 'commit'].includes(arg)));
  if (args.join(' ') === 'rev-parse --is-inside-work-tree') return typeof tree === 'function' ? tree() : tree;
  if (args.join(' ') === `check-ignore -q ${KIT_FOLDER}`) return typeof visibility === 'function' ? visibility() : visibility;
  if (args.join(' ') === 'rev-parse --git-path hooks') return OUTSIDE;
  assert.fail(`unexpected git question: ${args.join(' ')}`);
};
const findFlatLines = (result, name = FLAT_NAME) => result.lines.filter((line) => line.startsWith(`scripts/${name}`));
const assertFlatLine = (result, name, phrase) => assert.ok(findFlatLines(result, name).some((line) => phrase.test(line)), result.lines.join('\n'));
const findSuiteLines = (result) => result.lines.filter((line) => line.includes('node --test scripts/'));
const findCommitLines = (result) => result.lines.filter((line) => line.includes('package.json') && /one change/.test(line));
const assertNoAfterLines = (result) => {
  assert.deepEqual(findSuiteLines(result), []);
  assert.ok(!result.lines.some((line) => /git grep|could not be confirmed/.test(line) || OUTSIDE_LINE.test(line)));
};
const makeEnv = (home) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key) && key !== 'NODE_TEST_CONTEXT')),
  HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', LC_ALL: 'C',
});
const UNANSWERABLE = [
  ['ENOENT', { error: makeError('ENOENT'), status: null }],
  ['EACCES', { error: makeError('EACCES'), status: null }],
  ['EPERM', { error: makeError('EPERM'), status: null }],
  ['signal', { signal: 'SIGTERM', status: null }], ['status 2', { status: 2 }],
];
const GIT_UNANSWERABLE = [...UNANSWERABLE, ['synchronous throw', () => { throw makeError('ENOENT'); }]];

describe('spec:standalone-scripts/S10 removal after the store and with the command standing', () => {
  it('exports a frozen 25-name catalog and frozen file/digest rows', async () => {
    const { FLAT_NAMES, FLAT_BODIES } = await import('./flat-scripts.mjs').catch(() => ({}));
    assert.ok(Array.isArray(FLAT_NAMES)); assert.ok(Object.isFrozen(FLAT_NAMES));
    assert.equal(FLAT_NAMES.length, FLAT_COUNT); assert.equal(new Set(FLAT_NAMES).size, FLAT_COUNT);
    assert.ok(FLAT_NAMES.every((name) => typeof name === 'string' && basename(name) === name));
    assert.ok(Array.isArray(FLAT_BODIES) && FLAT_BODIES.length > 0 && Object.isFrozen(FLAT_BODIES));
    for (const row of FLAT_BODIES) {
      assert.ok(Object.isFrozen(row)); assert.deepEqual(Object.keys(row).sort(), ['digest', 'file']);
      assert.ok(FLAT_NAMES.includes(row.file)); assert.match(row.digest, /^[a-f0-9]{64}$/i);
    }
  });
  for (const name of BODY_NAMES) for (const crlf of [false, true]) it(`removes the deployed-entry body of ${name}, CRLF=${crlf}`, async () => {
    const { retireFlat } = await import('./flat-scripts.mjs').catch(() => ({}));
    const cwd = makeProject(), body = readBody(name);
    putFile(cwd, `scripts/${name}`, crlf ? body.replaceAll('\n', '\r\n') : body);
    putFile(cwd, `${KIT_FOLDER}/${BY_NAME.get(name)}`);
    const result = await retireFlat({ cwd, skillRoot: SKILL_ROOT, deps: { git: makeGit(cwd) } });
    assert.deepEqual(result.removed, [name]); assertFlatLine(result, name, /removed/);
    assert.equal(existsSync(join(cwd, `scripts/${name}`)), false);
  });
  for (const state of ['replacement absent', 'replacement link', 'command absent', 'command link', 'edited', 'link', 'directory', 'EACCES', 'EPERM', 'ENOENT']) {
    it(`leaves the flat file for ${state} and resumes a failed unlink`, async () => {
      const { retireFlat } = await import('./flat-scripts.mjs').catch(() => ({}));
      const cwd = makeProject({ command: !state.startsWith('command') }), target = join(cwd, 'scripts', FLAT_NAME);
      const replacement = `${KIT_FOLDER}/${BY_NAME.get(FLAT_NAME)}`;
      putFile(cwd, `scripts/${FLAT_NAME}`, readBody(FLAT_NAME));
      if (!state.startsWith('replacement')) putFile(cwd, replacement);
      if (state === 'replacement link') { mkdirSync(dirname(join(cwd, replacement)), { recursive: true }); symlinkSync(target, join(cwd, replacement)); }
      if (state === 'command link') symlinkSync(target, join(cwd, KIT_FOLDER, 'run.mjs'));
      if (state === 'edited') putFile(cwd, `scripts/${FLAT_NAME}`, `${readBody(FLAT_NAME)}\n// local change\n`);
      if (['link', 'directory'].includes(state)) { unlinkSync(target); if (state === 'link') symlinkSync(join(cwd, 'package.json'), target); else mkdirSync(target); }
      const deps = { git: makeGit(cwd),
        readFile: (path, ...args) => { if (String(path) === target && state === 'EACCES') throw makeError(state); return readFileSync(path, ...args); },
        unlink: (path) => { if (String(path) === target && ['EPERM', 'ENOENT'].includes(state)) throw makeError(state); return unlinkSync(path); },
      };
      const before = lstatSync(target).isFile() ? readFileSync(target) : null;
      const result = await retireFlat({ cwd, skillRoot: SKILL_ROOT, deps });
      assert.deepEqual(result.removed, []); assert.ok(lstatSync(target)); assertNoAfterLines(result);
      if (before) assert.deepEqual(readFileSync(target), before);
      if (state === 'link') assert.ok(lstatSync(target).isSymbolicLink());
      if (state === 'directory') assert.ok(lstatSync(target).isDirectory());
      if (state === 'ENOENT') assert.deepEqual(findFlatLines(result), []);
      else if (state.startsWith('command')) assert.ok(!result.lines.some((line) => /removed/.test(line)));
      else if (state.startsWith('replacement')) {
        assertFlatLine(result, FLAT_NAME, /kept/);
        assert.ok(findFlatLines(result).some((line) => line.includes(replacement)));
      } else assertFlatLine(result, FLAT_NAME, new RegExp(state === 'edited' ? "not the kit's" : state === 'link' ? 'link' : state));
      if (state === 'EPERM') {
        const next = await retireFlat({ cwd, skillRoot: SKILL_ROOT, deps: { git: makeGit(cwd) } });
        assert.deepEqual(next.removed, [FLAT_NAME]); assertFlatLine(next, FLAT_NAME, /removed/); assert.equal(existsSync(target), false);
      }
    });
  }
  it('without run.mjs every bundled flat file stays even with its replacement standing', async () => {
    const { retireFlat } = await import('./flat-scripts.mjs').catch(() => ({}));
    const cwd = makeProject({ command: false });
    for (const name of BODY_NAMES) { putFile(cwd, `scripts/${name}`, readBody(name)); putFile(cwd, `${KIT_FOLDER}/${BY_NAME.get(name)}`); }
    const result = await retireFlat({ cwd, skillRoot: SKILL_ROOT, deps: { git: makeGit(cwd) } });
    assert.deepEqual(result.removed, []); assertNoAfterLines(result);
    for (const name of BODY_NAMES) assert.equal(readFileSync(join(cwd, 'scripts', name), 'utf8'), readBody(name));
  });
  for (const [standing, placed] of [
    [true, []], [false, ['run.mjs', BY_NAME.get(FLAT_NAME)]], [false, ['run.mjs']], [false, [BY_NAME.get(FLAT_NAME)]],
  ]) it(`dry run with standing=${standing}, placed=${placed.join(',') || 'none'} never unlinks`, async () => {
    const { retireFlat } = await import('./flat-scripts.mjs').catch(() => ({}));
    const cwd = makeProject({ command: standing }), body = readBody(FLAT_NAME), replacement = `${KIT_FOLDER}/${BY_NAME.get(FLAT_NAME)}`;
    putFile(cwd, `scripts/${FLAT_NAME}`, body);
    if (standing) putFile(cwd, replacement);
    const result = await retireFlat({ cwd, skillRoot: SKILL_ROOT, dryRun: true,
      placed: placed.map((path) => `${KIT_FOLDER}/${path}`),
      deps: { git: makeGit(cwd), unlink: () => assert.fail('dry run unlinked a file'), writeFile: () => assert.fail('dry run wrote a file') } });
    const wouldRemove = standing || placed.includes('run.mjs') && placed.includes(BY_NAME.get(FLAT_NAME));
    assert.deepEqual(result.removed, wouldRemove ? [FLAT_NAME] : []);
    if (wouldRemove) assertFlatLine(result, FLAT_NAME, /would be removed/);
    else if (placed.includes('run.mjs')) assertFlatLine(result, FLAT_NAME, /kept/);
    if (!wouldRemove) {
      if (placed.includes('run.mjs')) assert.ok(findFlatLines(result).some((line) => line.includes(replacement)));
      else assert.ok(!result.lines.some((line) => /would be removed/.test(line)));
      assertNoAfterLines(result);
    }
    assert.equal(readFileSync(join(cwd, 'scripts', FLAT_NAME), 'utf8'), body);
    if (!standing) { assert.equal(existsSync(join(cwd, replacement)), false); assert.equal(existsSync(join(cwd, KIT_FOLDER, 'run.mjs')), false); }
  });
  for (const [name, answer] of [['exit 1', { status: 1 }], ...UNANSWERABLE, ['synchronous throw', null]]) it(`a store ${name} prevents removal`, async () => {
    const { runKitFolder } = await import('./kit-folder.mjs').catch(() => ({}));
    const cwd = makeProject({ all: true }), body = readBody(FLAT_NAME), calls = [];
    putFile(cwd, `scripts/${FLAT_NAME}`, body);
    const result = await runKitFolder({ cwd, skillRoot: SKILL_ROOT, deps: { git: makeGit(cwd, {}, calls),
      spawnSync: () => { if (answer === null) throw makeError('ENOENT'); return { stdout: '', stderr: '', ...answer }; },
      unlink: () => assert.fail('removal after failed store'),
    } });
    assert.ok([1, 3].includes(result.exitCode)); assert.equal(readFileSync(join(cwd, 'scripts', FLAT_NAME), 'utf8'), body);
    assert.ok(result.lines.some((line) => /ADR store|--ensure-current/.test(line))); assert.deepEqual(findSuiteLines(result), []);
  });
  it('removes only after the writes and successful store, with no git write', async () => {
    const { runKitFolder } = await import('./kit-folder.mjs').catch(() => ({}));
    const cwd = makeProject({ command: false }), events = [], calls = [];
    putFile(cwd, `scripts/${FLAT_NAME}`, readBody(FLAT_NAME));
    const result = await runKitFolder({ cwd, skillRoot: SKILL_ROOT, enforcement: true, deps: {
      git: makeGit(cwd, {}, calls), writeFile: (...args) => { events.push('write'); return writeFileSync(...args); },
      spawnSync: () => { events.push('store'); return CURRENT_STORE; },
      unlink: (path) => { if (String(path) === join(cwd, 'scripts', FLAT_NAME)) events.push('remove'); return unlinkSync(path); },
    } });
    assert.equal(result.exitCode, 0); assertFlatLine(result, FLAT_NAME, /removed/);
    assert.ok(events.includes('write') && events.indexOf('store') > events.lastIndexOf('write'));
    assert.ok(events.indexOf('remove') > events.indexOf('store')); assert.ok(calls.length > 0);
  });
});

describe('spec:standalone-scripts/S11 follow-up lines and the project git location', () => {
  for (const [name, tree] of [['inside', INSIDE], ['outside', OUTSIDE], ['empty answer', { status: 0, stdout: '' }], ...GIT_UNANSWERABLE]) {
    it(`prints suite lines once and the ${name} work-tree answer after removal`, async () => {
      const { retireFlat, FLAT_NAMES } = await import('./flat-scripts.mjs').catch(() => ({}));
      const cwd = makeProject(), replacement = `${KIT_FOLDER}/${BY_NAME.get(FLAT_NAME)}`;
      putFile(cwd, replacement); putFile(cwd, `scripts/${FLAT_NAME}`, readBody(FLAT_NAME));
      for (const suite of ['user.test.mjs', EDITED_SUITE, 'nested/user.test.mjs']) putFile(cwd, `scripts/${suite}`, '// local suite\n');
      mkdirSync(join(cwd, 'scripts/directory.test.mjs')); symlinkSync(join(cwd, 'package.json'), join(cwd, 'scripts/link.test.mjs'));
      const deps = { git: makeGit(cwd, { tree }) }, result = await retireFlat({ cwd, skillRoot: SKILL_ROOT, deps });
      assertFlatLine(result, EDITED_SUITE, /not the kit's/);
      assert.equal(findSuiteLines(result).length, 2);
      for (const suite of ['user.test.mjs', EDITED_SUITE]) {
        const lines = findSuiteLines(result).filter((line) => line.includes(`node --test scripts/${suite}`));
        assert.equal(lines.length, 1); assert.ok(lines[0].includes('scripts/pre-commit.local'));
      }
      const grep = result.lines.filter((line) => line.includes('git grep -n -F --untracked'));
      assert.equal(grep.length, name === 'inside' ? 1 : 0);
      assert.equal(result.lines.filter((line) => /hooks dir/.test(line) && /ignored files/.test(line)).length, name === 'inside' ? 1 : 0);
      if (name === 'inside') {
        for (const flat of FLAT_NAMES) assert.ok(grep[0].includes(flat));
        assert.ok(grep[0].includes("':!scripts/agent-workflow'"));
      } else if (name === 'outside') assert.equal(result.lines.filter((line) => OUTSIDE_LINE.test(line)).length, 1);
      else {
        assert.equal(result.lines.filter((line) => /work tree/.test(line) && /could not be confirmed/.test(line)).length, 1);
        assert.ok(!result.lines.some((line) => OUTSIDE_LINE.test(line)));
      }
      assert.equal(existsSync(join(cwd, 'scripts', FLAT_NAME)), false);
      assertNoAfterLines(await retireFlat({ cwd, skillRoot: SKILL_ROOT, deps }));
    });
  }
  for (const action of ['place', 'remove', 'both', 'idle']) for (const [visibility, answer] of [
    ['visible', { status: 1 }], ['hidden', { status: 0 }], ['exit 128', OUTSIDE], ...GIT_UNANSWERABLE,
  ]) it(`${action}, check-ignore ${visibility}: prints only a justified commit-together line`, async () => {
    const { runKitFolder } = await import('./kit-folder.mjs').catch(() => ({}));
    const cwd = makeProject({ all: ['remove', 'idle'].includes(action) }), removed = ['archive-caps.mjs', 'spec-schema.mjs'];
    if (['remove', 'both'].includes(action)) for (const name of removed) putFile(cwd, `scripts/${name}`, readBody(name));
    const deps = { spawnSync: () => CURRENT_STORE, git: makeGit(cwd, { visibility: answer }) };
    const result = await runKitFolder({ cwd, skillRoot: SKILL_ROOT, enforcement: true, deps });
    assert.equal(result.exitCode, 0);
    const lines = findCommitLines(result);
    assert.equal(lines.length, visibility === 'visible' && action !== 'idle' ? 1 : 0, result.lines.join('\n'));
    if (lines.length) {
      for (const fact of [`${KIT_FOLDER}/`, 'package.json', 'one change', 'merge', 'branch']) assert.ok(lines[0].includes(fact));
      if (['remove', 'both'].includes(action)) for (const name of removed) assert.ok(lines[0].includes(`scripts/${name}`));
      assert.ok(!lines[0].includes('docs/ai/gates.json'));
    }
    const next = await runKitFolder({ cwd, skillRoot: SKILL_ROOT, enforcement: true, deps });
    assert.equal(next.exitCode, 0); assert.deepEqual(findCommitLines(next), []); assert.deepEqual(findSuiteLines(next), []);
  });
  it('the flat module leaves the commit-together line to runKitFolder', async () => {
    const { retireFlat } = await import('./flat-scripts.mjs').catch(() => ({}));
    const cwd = makeProject({ all: true });
    putFile(cwd, `scripts/${FLAT_NAME}`, readBody(FLAT_NAME));
    const result = await retireFlat({ cwd, skillRoot: SKILL_ROOT, deps: { git: makeGit(cwd, { visibility: { status: 1 } }) } });
    assert.deepEqual(result.removed, [FLAT_NAME]); assert.deepEqual(findCommitLines(result), []);
  });
  for (const visible of [false, true]) it(`dry run previews the commit-together line only when visible=${visible}`, async () => {
    const { runKitFolder } = await import('./kit-folder.mjs').catch(() => ({}));
    const cwd = makeProject({ command: false }), body = readBody(FLAT_NAME);
    putFile(cwd, `scripts/${FLAT_NAME}`, body);
    const result = await runKitFolder({ cwd, skillRoot: SKILL_ROOT, dryRun: true, enforcement: true, deps: {
      git: makeGit(cwd, { visibility: { status: visible ? 1 : 0 } }),
      spawnSync: () => assert.fail('dry run spawned the store'), writeFile: () => assert.fail('dry run wrote'), unlink: () => assert.fail('dry run unlinked'),
    } });
    assert.equal(result.exitCode, 0); assertFlatLine(result, FLAT_NAME, /would be removed/);
    assert.equal(findCommitLines(result).length, visible ? 1 : 0);
    if (visible) assert.ok(findCommitLines(result)[0].includes(`scripts/${FLAT_NAME}`));
    assert.equal(readFileSync(join(cwd, 'scripts', FLAT_NAME), 'utf8'), body); assert.equal(existsSync(join(cwd, KIT_FOLDER)), false);
  });
  it('REAL git: an ambient GIT_DIR for another repository cannot answer for a project outside git', () => {
    const cwd = makeProject({ all: true }), other = makeRoot(), home = makeRoot(), env = makeEnv(home);
    const initialized = spawnSync('git', ['init', '-q'], { cwd: other, env, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    putFile(cwd, `scripts/${FLAT_NAME}`, readBody(FLAT_NAME));
    const result = spawnSync(process.execPath, [join(SKILL_ROOT, 'scripts/kit-folder.mjs'), '--project', cwd], {
      cwd, env: { ...env, GIT_DIR: join(other, '.git') }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.filter((line) => OUTSIDE_LINE.test(line)).length, 1);
    assert.ok(!lines.some((line) => line.includes('git grep -n -F --untracked')));
    assert.deepEqual(findCommitLines({ lines }), []); assert.equal(existsSync(join(cwd, 'scripts', FLAT_NAME)), false);
  });
});
