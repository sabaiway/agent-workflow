import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFamily } from '../references/scripts/family.mjs';
import { KIT_COMMANDS, KIT_COMMAND_PATH } from '../references/scripts/run.mjs';

const MAGIC_MARKER = '# agent-workflow:install-git-hooks.mjs';
const SKILL_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BUNDLE = join(SKILL_ROOT, 'references/scripts');
const KIT = posix.dirname(KIT_COMMAND_PATH);
const INSTALLER = KIT_COMMANDS['install-git-hooks'];
const ROTATOR = KIT_COMMANDS['archive-decisions'];
const SWITCH = `node ${KIT_COMMAND_PATH} install-git-hooks`;
const DOCS_LINE = `node ${KIT_COMMAND_PATH} docs-size`;
const MANAGED = `#!/bin/sh\n${MAGIC_MARKER}\nnode scripts/check-docs-size.mjs\n`;
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const ENTRIES = readFamily(BUNDLE).filter((entry) => entry.role === 'deployed');
const DEPLOYED = ENTRIES.map((entry) => entry.path);
const FAMILY = ENTRIES.filter((entry) => !['spec-schema', 'docs-size'].includes(entry.module) && entry.path !== 'run.mjs');
const readBundled = (path) => readFileSync(join(BUNDLE, path));
const readImports = (path) => [...readBundled(path).toString().matchAll(IMPORT)].map((match) => posix.join(posix.dirname(path), match[1]));
const SPEC = new Set(ENTRIES.filter((entry) => ['spec-schema', 'docs-size'].includes(entry.module) || entry.path === 'run.mjs').map((entry) => entry.path));
for (const path of SPEC) for (const dependency of readImports(path)) if (DEPLOYED.includes(dependency)) SPEC.add(dependency);
const DECLINED = [...new Set([...SPEC, ...FAMILY.filter((entry) => entry.seed).map((entry) => entry.path)])];
const ROOTS = [];
afterEach(() => { for (const path of ROOTS.splice(0)) rmSync(path, { recursive: true, force: true }); });
const createTree = (node = true) => {
  const cwd = mkdtempSync(join(tmpdir(), 'memory-kit-folder-'));
  ROOTS.push(cwd);
  if (node) writeFileSync(join(cwd, 'package.json'), '{}\n');
  return cwd;
};
const put = (cwd, path, body) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), body); };
const seed = (cwd, paths = DEPLOYED) => { for (const path of paths) put(cwd, `${KIT}/${path}`, readBundled(path)); };
const snapshot = (cwd, at = cwd, output = {}) => {
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    const path = join(at, entry.name), name = relative(cwd, path);
    output[name] = entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? ['link', readlinkSync(path)] : ['file', readFileSync(path, 'base64')];
    if (entry.isDirectory()) snapshot(cwd, path, output);
  }
  return output;
};
const assertBodies = (cwd, paths) => {
  const files = Object.entries(snapshot(join(cwd, KIT))).filter(([, value]) => Array.isArray(value)).map(([path]) => path.split(sep).join('/'));
  assert.deepEqual(files.sort(), [...paths].sort());
  for (const path of paths) assert.ok(readFileSync(join(cwd, KIT, path)).equals(readBundled(path)), path);
};
const fail = (code) => Object.assign(new Error(code), { code });
const answerOutsideGit = () => ({ status: 128, stdout: '', stderr: '' });
const answerSuccessfulStore = () => ({ status: 0, stdout: 'already-current\n', stderr: '' });
const run = async (cwd, options = {}) => {
  const { runKitFolder } = await import('./kit-folder.mjs').catch(() => ({}));
  assert.equal(typeof runKitFolder, 'function', 'kit-folder.mjs must export runKitFolder');
  return runKitFolder({ cwd, skillRoot: SKILL_ROOT, ...options, deps: { git: answerOutsideGit, spawnSync: answerSuccessfulStore, ...options.deps } });
};
const formatLines = (result) => result.lines.join('\n');
const getFileLines = (result) => result.lines.filter((line) => DEPLOYED.some((path) => line.startsWith(`${KIT}/${path}:`)));
const assertNoSpawn = () => assert.fail('the rotator must not spawn');
const assertFlat = (cwd) => assert.ok(readFileSync(join(cwd, 'scripts/archive-caps.mjs')).equals(readBundled('archives/archive-caps.mjs')));
const putFlat = (cwd) => put(cwd, 'scripts/archive-caps.mjs', readBundled('archives/archive-caps.mjs'));
const createChildEnv = (home) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key) && key !== 'NODE_TEST_CONTEXT')),
  HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', LC_ALL: 'C',
});
const createGitRunner = (cwd, hooks, answer = { status: 0, stdout: `${hooks}\n`, stderr: '' }, calls = []) => (command, args, options) => {
  assert.equal(command, 'git');
  assert.equal(options.cwd, cwd);
  assert.ok(options.env && !Object.keys(options.env).some((key) => /^GIT_/i.test(key)), 'git questions drop every GIT_ key');
  calls.push(args);
  if (args.join(' ') === 'rev-parse --is-inside-work-tree') return { status: 0, stdout: 'true\n', stderr: '' };
  if (args.join(' ') === 'check-ignore -q scripts/agent-workflow') return { status: 1, stdout: '', stderr: '' };
  if (args.join(' ') === 'rev-parse --git-path hooks') return typeof answer === 'function' ? answer() : answer;
  assert.fail(`unexpected git question: ${args.join(' ')}`);
};
const getHookLines = (result) => result.lines.filter((line) => line.includes(SWITCH) || line.includes(`${KIT}/${INSTALLER}`) && !line.startsWith(`${KIT}/${INSTALLER}:`));
const FLAT_RUNNABLE = ['archive-caps.mjs', 'archive-changelog.mjs', 'archive-decisions.mjs', 'archive-issues.mjs', 'check-docs-size.mjs', 'install-git-hooks.mjs', 'markdown-blocks.mjs', 'migrate-gates.mjs', 'spec-schema.mjs'];
const isSkipLine = (line) => line.includes('package.json') && FLAT_RUNNABLE.every((name) => line.includes(name));

describe('spec:standalone-scripts/S7 survey and Node evidence', () => {
  for (const enforcement of [false, true]) it(`refuses unsafe paths and unreadable bundles with enforcement=${enforcement}`, async () => {
    const rows = [['scripts', 'link'], ['scripts', 'file'], [KIT, 'link'], [KIT, 'file'],
      [`${KIT}/archives`, 'link'], [`${KIT}/archives`, 'file'], [`${KIT}/${ROTATOR}`, 'link'], [`${KIT}/${ROTATOR}`, 'directory'], ['bundle', 'unreadable']];
    for (const [path, kind] of rows) {
      const cwd = createTree(!enforcement), target = path === 'bundle' ? join(BUNDLE, ROTATOR) : join(cwd, path);
      if (kind !== 'unreadable') {
        mkdirSync(dirname(target), { recursive: true });
        if (kind === 'link') { const elsewhere = join(cwd, 'elsewhere'); mkdirSync(elsewhere); symlinkSync(elsewhere, target); }
        else if (kind === 'directory') mkdirSync(target);
        else writeFileSync(target, 'wrong kind\n');
      }
      const before = snapshot(cwd);
      const result = await run(cwd, { enforcement, deps: { spawnSync: assertNoSpawn, readFile: (file, ...args) => {
        if (kind === 'unreadable' && String(file) === target) throw fail('EACCES');
        return readFileSync(file, ...args);
      } } });
      assert.equal(result.exitCode, 1, `${path} ${kind}`);
      assert.ok(result.lines.some((line) => line.includes(path === 'bundle' ? target : path)), formatLines(result));
      if (kind === 'unreadable') assert.match(formatLines(result), /EACCES/);
      assert.deepEqual(snapshot(cwd), before);
    }
  });
  it('an unreadable package.json probe stops without writes', async () => {
    const cwd = createTree(), before = snapshot(cwd);
    const result = await run(cwd, { deps: { spawnSync: assertNoSpawn, lstat: (file, ...args) => {
      if (String(file) === join(cwd, 'package.json')) throw fail('EACCES');
      return lstatSync(file, ...args);
    } } });
    assert.equal(result.exitCode, 1); assert.match(formatLines(result), /package\.json/); assert.match(formatLines(result), /EACCES/);
    assert.deepEqual(snapshot(cwd), before);
  });
  it('no evidence skips empty and wrong-kind trees and reports either pending archive', async () => {
    for (const archive of [null, 'decisions-archive.md', 'decisions-archive-early.md']) {
      const cwd = createTree(false);
      if (archive) { mkdirSync(join(cwd, 'scripts/install-git-hooks.mjs'), { recursive: true }); put(cwd, `docs/ai/history/${archive}`, 'retired\n'); }
      const before = snapshot(cwd), result = await run(cwd, { deps: { spawnSync: assertNoSpawn } });
      const skip = result.lines.filter(isSkipLine);
      assert.equal(result.exitCode, 0); assert.equal(skip.length, 1);
      const { NODE_EVIDENCE_PROBES } = await import('./kit-folder.mjs').catch(() => ({}));
      const runnable = NODE_EVIDENCE_PROBES.filter((path) => path.startsWith('scripts/') && !path.startsWith(`${KIT}/`));
      assert.equal(runnable.length, 9);
      for (const path of runnable) assert.ok(skip[0].includes(path), path);
      if (archive) assert.ok(result.lines.some((line) => line.includes(`docs/ai/history/${archive}`)));
      if (archive) assert.match(skip[0], /scripts\/install-git-hooks\.mjs.{0,40}directory/, 'the wrong kind is named in the skip line');
      assert.deepEqual(snapshot(cwd), before);
    }
  });
  it('enforcement bypasses package.json probing and writes an empty project', async () => {
    const cwd = createTree(false), calls = [];
    const result = await run(cwd, { enforcement: true, deps: { lstat: (file, ...args) => { calls.push(String(file)); return lstatSync(file, ...args); } } });
    assert.equal(result.exitCode, 0); assert.ok(!calls.includes(join(cwd, 'package.json')));
    assert.ok(!result.lines.some(isSkipLine)); assertBodies(cwd, DEPLOYED);
  });
  it('main rejects usage without touching files and relays runKitFolder lines and exitCode', async () => {
    const { main } = await import('./kit-folder.mjs').catch(() => ({}));
    assert.equal(typeof main, 'function', 'kit-folder.mjs must export main');
    const usageTree = createTree();
    for (const argv of [[], ['--project'], ['--unknown'], ['--project', usageTree, '--unknown']]) {
      const before = snapshot(usageTree), stderr = [];
      const deps = { writeFile: assertNoSpawn, mkdir: assertNoSpawn, rename: assertNoSpawn, unlink: assertNoSpawn, spawnSync: assertNoSpawn, git: assertNoSpawn };
      assert.equal(await main(argv, { stdout: { write: assertNoSpawn }, stderr: { write: (line) => stderr.push(line) }, deps }), 2);
      assert.ok(stderr.join('').length > 0); assert.deepEqual(snapshot(usageTree), before);
    }
    const cwd = createTree(), stdout = [], before = snapshot(cwd), deps = { git: answerOutsideGit, spawnSync: assertNoSpawn };
    const expected = await run(cwd, { dryRun: true, deps });
    assert.equal(await main(['--project', cwd, '--dry-run'], { stdout: { write: (line) => stdout.push(line) }, stderr: { write: assertNoSpawn }, deps }), expected.exitCode);
    assert.deepEqual(stdout.join('').split('\n').filter(Boolean), expected.lines); assert.deepEqual(snapshot(cwd), before);
  });
  it('the CLI runs through a symlinked skill home', () => {
    const cwd = createTree(), link = join(createTree(false), 'skill');
    symlinkSync(SKILL_ROOT, link);
    const result = spawnSync(process.execPath, [join(link, 'scripts/kit-folder.mjs')], { cwd, env: createChildEnv(cwd), encoding: 'utf8' });
    assert.equal(result.status, 2, `${result.error?.code ?? ''} ${result.stdout}`); assert.match(result.stderr, /--project/);
  });
});

describe('spec:standalone-scripts/S8 component and writes', () => {
  it('a declined project gets exactly the spec closure and every seed', async () => {
    const cwd = createTree(), result = await run(cwd);
    assert.deepEqual([DEPLOYED.length, SPEC.size, DECLINED.length], [12, 7, 8]);
    assert.equal(result.exitCode, 0); assertBodies(cwd, DECLINED);
    assert.equal(result.lines.filter((line) => /not accepted/.test(line)).length, 1);
  });
  it('enforcement, each regular nonseed family file and a regular flat installer accept; a linked flat installer declines', async () => {
    for (const proof of ['enforcement', 'flat', 'linked-flat', ...FAMILY.filter((entry) => !entry.seed).map((entry) => entry.path)]) {
      const cwd = createTree(), accepted = proof !== 'linked-flat';
      if (proof === 'flat') put(cwd, 'scripts/install-git-hooks.mjs', 'old installer\n');
      else if (proof === 'linked-flat') { mkdirSync(join(cwd, 'scripts')); symlinkSync(join(cwd, 'package.json'), join(cwd, 'scripts/install-git-hooks.mjs')); }
      else if (proof !== 'enforcement') put(cwd, `${KIT}/${proof}`, 'edited\n');
      const result = await run(cwd, { enforcement: proof === 'enforcement' });
      assert.equal(result.exitCode, 0, proof); assertBodies(cwd, accepted ? DEPLOYED : DECLINED);
      assert.equal(result.lines.filter((line) => /not accepted/.test(line)).length, accepted ? 0 : 1);
      assert.equal(result.lines.filter((line) => /accepted/.test(line)).length, 1);
    }
  });
  it('writes the installer first, then imports before importers; reports replacements, placements and current count', async () => {
    const cwd = createTree(), current = ROTATOR;
    seed(cwd, [current]); put(cwd, `${KIT}/${INSTALLER}`, 'edited\n');
    const result = await run(cwd), lines = getFileLines(result);
    assert.equal(result.exitCode, 0); assertBodies(cwd, DEPLOYED);
    assert.ok(lines[0].startsWith(`${KIT}/${INSTALLER}:`) && lines[0].includes('written over'));
    for (const path of DEPLOYED.filter((path) => path !== current && path !== INSTALLER)) assert.ok(lines.some((line) => line.startsWith(`${KIT}/${path}:`) && line.includes('placed')), path);
    const position = (path) => lines.findIndex((line) => line.startsWith(`${KIT}/${path}:`));
    for (const path of DEPLOYED.filter((path) => path !== current)) for (const dependency of readImports(path).filter((path) => DEPLOYED.includes(path))) assert.ok(dependency === current || position(dependency) < position(path), `${dependency} before ${path}`);
    const remaining = new Set(DEPLOYED.filter((path) => path !== current && path !== INSTALLER)), order = [INSTALLER];
    while (remaining.size) {
      const next = [...remaining].sort().find((path) => readImports(path).every((dependency) => !remaining.has(dependency)));
      assert.ok(next, 'bundled imports contain no cycle'); order.push(next); remaining.delete(next);
    }
    assert.deepEqual(lines.map((line) => DEPLOYED.find((path) => line.startsWith(`${KIT}/${path}:`))), order);
    assert.ok(!lines.some((line) => line.startsWith(`${KIT}/${current}:`)));
    assert.ok(result.lines.some((line) => /\b1\b/.test(line) && /current|already/.test(line)));
  });
  it('overwrites atomically through an exclusive sibling and rename', async () => {
    const cwd = createTree(), events = []; seed(cwd); put(cwd, `${KIT}/${INSTALLER}`, 'edited\n');
    const target = join(cwd, KIT, INSTALLER);
    const result = await run(cwd, { deps: {
      writeFile: (path, body, options) => { assert.notEqual(String(path), target); assert.equal(dirname(String(path)), dirname(target)); assert.equal(options?.flag, 'wx'); events.push(['write', String(path)]); return writeFileSync(path, body, options); },
      rename: (from, to) => { assert.equal(String(to), target); assert.ok(readFileSync(from).equals(readBundled(INSTALLER))); assert.equal(readFileSync(target, 'utf8'), 'edited\n'); events.push(['rename', String(from)]); return renameSync(from, to); },
    } });
    assert.equal(result.exitCode, 0); assert.deepEqual(events.map(([kind]) => kind), ['write', 'rename']);
    assert.equal(events[0][1], events[1][1]); assertBodies(cwd, DEPLOYED);
  });
  it('an EEXIST on an exclusive sibling never clobbers its owner or the deployed file', async () => {
    const cwd = createTree(), occupied = []; seed(cwd); put(cwd, `${KIT}/${INSTALLER}`, 'edited\n'); putFlat(cwd);
    const target = join(cwd, KIT, INSTALLER);
    const result = await run(cwd, { deps: { spawnSync: assertNoSpawn, writeFile: (path, body, options) => {
      assert.notEqual(String(path), target); assert.equal(options?.flag, 'wx');
      writeFileSync(path, 'occupied\n', { flag: 'wx' }); occupied.push(String(path));
      return writeFileSync(path, body, options);
    } } });
    assert.equal(result.exitCode, 1); assert.match(formatLines(result), /EEXIST/); assertFlat(cwd);
    assert.equal(readFileSync(target, 'utf8'), 'edited\n'); assert.equal(occupied.length, 1);
    assert.equal(readFileSync(occupied[0], 'utf8'), 'occupied\n');
  });
  for (const cleanup of [null, 'EPERM']) it(`a refused rename removes its sibling or names it, cleanup=${cleanup}`, async () => {
    const cwd = createTree(), siblings = []; seed(cwd); put(cwd, `${KIT}/${INSTALLER}`, 'edited\n');
    const result = await run(cwd, { deps: { spawnSync: assertNoSpawn,
      rename: (from) => { siblings.push(String(from)); throw fail('EACCES'); },
      unlink: (path) => { if (cleanup && siblings.includes(String(path))) throw fail(cleanup); return unlinkSync(path); } } });
    assert.equal(result.exitCode, cleanup ? 3 : 1); assert.match(formatLines(result), /EACCES/);
    assert.equal(readFileSync(join(cwd, KIT, INSTALLER), 'utf8'), 'edited\n'); assert.equal(siblings.length, 1);
    assert.equal(Boolean(lstatSync(siblings[0], { throwIfNoEntry: false })), Boolean(cleanup));
    if (cleanup) assert.ok(formatLines(result).includes(relative(cwd, siblings[0])), formatLines(result));
  });
  for (const [body, later, code] of [['bundle', false, 0], ['other', false, 1], ['other', true, 3]]) it(`create-only race body=${body} later=${later} exits ${code}`, async () => {
    const cwd = createTree(), targetPath = later ? ROTATOR : INSTALLER, target = join(cwd, KIT, targetPath), calls = [];
    const racedBody = body === 'bundle' ? readBundled(targetPath) : Buffer.from('racing bytes\n');
    const result = await run(cwd, { enforcement: true, deps: { spawnSync: code ? assertNoSpawn : answerSuccessfulStore, writeFile: (path, bytes, options) => {
      if (!calls.includes('race') && dirname(String(path)) === dirname(target)) { put(cwd, `${KIT}/${targetPath}`, racedBody); calls.push('race'); }
      calls.push(String(path)); return writeFileSync(path, bytes, options);
    } } });
    assert.equal(result.exitCode, code); assert.ok(calls.includes('race')); assert.ok(readFileSync(target).equals(racedBody));
    if (code === 0) { assertBodies(cwd, DEPLOYED); assert.ok(result.lines.some((line) => line.includes(`${KIT}/${targetPath}`) && /bundled|current|stands/.test(line))); }
    else { assert.ok(formatLines(result).includes(`${KIT}/${targetPath}`)); if (later) assert.ok(getFileLines(result).some((line) => line.startsWith(`${KIT}/${INSTALLER}:`) && line.includes('placed'))); }
  });
  it('a partway EACCES names landed files, leaves the flat file and spawns nothing', async () => {
    const cwd = createTree(), completed = [], attempts = []; putFlat(cwd);
    const result = await run(cwd, { enforcement: true, deps: { spawnSync: assertNoSpawn, writeFile: (path, body, options) => {
      attempts.push(String(path));
      if (String(path).startsWith(join(cwd, KIT, 'archives') + sep)) throw fail('EACCES');
      return writeFileSync(path, body, options);
    }, rename: (from, to) => { renameSync(from, to); completed.push(relative(cwd, to)); } } });
    assert.equal(result.exitCode, 3); assert.match(formatLines(result), /EACCES/); assertFlat(cwd);
    assert.equal(attempts.findIndex((path) => path.startsWith(join(cwd, KIT, 'archives') + sep)), attempts.length - 1, 'no write follows the refused one');
    const landed = DEPLOYED.filter((path) => lstatSync(join(cwd, KIT, path), { throwIfNoEntry: false })?.isFile());
    assert.ok(landed.includes(INSTALLER));
    for (const path of landed) { assert.ok(readFileSync(join(cwd, KIT, path)).equals(readBundled(path))); assert.ok(getFileLines(result).some((line) => line.startsWith(`${KIT}/${path}:`) && /placed|written over/.test(line))); }
    for (const path of completed) assert.ok(formatLines(result).includes(path));
  });
  it('dry runs write nothing and print one would line per noncurrent file', async () => {
    for (const enforcement of [false, true]) {
      const cwd = createTree(); seed(cwd, [ROTATOR]);
      const before = snapshot(cwd), result = await run(cwd, { enforcement, dryRun: true, deps: { writeFile: assertNoSpawn, spawnSync: assertNoSpawn } });
      assert.equal(result.exitCode, 0); assert.deepEqual(snapshot(cwd), before);
      assert.equal(getFileLines(result).length, (enforcement ? DEPLOYED : DECLINED).length - 1);
      assert.ok(getFileLines(result).every((line) => /would/.test(line)));
    }
  });
});

describe('spec:standalone-scripts/S9 ADR store process outcomes', () => {
  it('spawns the project rotator once after the last write and relays both streams', async () => {
    const cwd = createTree(), events = [], calls = [];
    const result = await run(cwd, { enforcement: true, deps: {
      writeFile: (...args) => { events.push('write'); return writeFileSync(...args); },
      spawnSync: (command, args, options) => { events.push('spawn'); calls.push([command, args, options.cwd]); assertBodies(cwd, DEPLOYED); return { status: 0, stdout: 'out one\nout two\n', stderr: 'err one\n' }; },
    } });
    assert.equal(result.exitCode, 0); assert.deepEqual(calls, [[process.execPath, [join(cwd, KIT, ROTATOR), '--ensure-current'], cwd]]);
    assert.equal(events.at(-1), 'spawn'); assert.ok(events.slice(0, -1).includes('write'));
    assert.deepEqual(result.lines.filter((line) => line.startsWith('ADR store: ')).sort(), ['ADR store: out one', 'ADR store: out two', 'ADR store: err one'].sort());
  });
  for (const changed of [false, true]) it(`failed spawn outcomes preserve files with prior writes=${changed}`, async () => {
    const outcomes = [
      ['exit 1', { status: 1 }, changed ? 3 : 1], ['exit 3', { status: 3 }, 3], ['signal', { status: null, signal: 'SIGTERM' }, 3],
      ...['ENOENT', 'EACCES', 'EPERM'].map((code) => [code, { status: null, error: fail(code) }, changed ? 3 : 1]),
      ['synchronous throw', () => { throw fail('ENOENT'); }, changed ? 3 : 1],
    ];
    for (const [label, answer, exitCode] of outcomes) {
      const cwd = createTree(); assert.equal((await run(cwd, { enforcement: true })).exitCode, 0); putFlat(cwd);
      if (changed) put(cwd, `${KIT}/${INSTALLER}`, 'edited\n');
      const before = snapshot(cwd), result = await run(cwd, { deps: { spawnSync: typeof answer === 'function' ? answer : () => ({ stdout: 'store out\n', stderr: 'store err\n', ...answer }) } });
      assert.equal(result.exitCode, exitCode, label); assertFlat(cwd); assertBodies(cwd, DEPLOYED);
      if (!changed) assert.deepEqual(snapshot(cwd), before);
      if (typeof answer !== 'function') for (const line of ['ADR store: store out', 'ADR store: store err']) assert.ok(result.lines.includes(line), formatLines(result));
      assert.match(formatLines(result), answer.signal ? /SIGTERM/ : answer.error || typeof answer === 'function' ? /ENOENT|EACCES|EPERM/ : new RegExp(`\\b${answer.status}\\b`));
      if (changed) assert.ok(getFileLines(result).some((line) => line.startsWith(`${KIT}/${INSTALLER}:`) && line.includes('written over')));
    }
  });
  it('dry run prints the one would-run ADR store line and spawns nothing', async () => {
    const cwd = createTree(), before = snapshot(cwd), result = await run(cwd, { dryRun: true, deps: { spawnSync: assertNoSpawn } });
    const lines = result.lines.filter((line) => line.startsWith('ADR store: '));
    assert.equal(result.exitCode, 0); assert.equal(lines.length, 1); assert.match(lines[0], /would/); assert.ok(lines[0].includes('--ensure-current')); assert.deepEqual(snapshot(cwd), before);
  });
});

describe('spec:standalone-scripts/S12 hook advice and repository location', () => {
  it('every git question strips case-insensitive GIT_ variables and keeps the fixture home and PATH', async () => {
    const cwd = createTree(), hooks = createTree(false), home = createTree(false), calls = [];
    const hostile = Object.fromEntries(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_CONFIG_PARAMETERS', 'GIT_EXEC_PATH', 'gIt_Custom'].map((key) => [key, join(home, key)]));
    const overrides = { ...hostile, HOME: home, XDG_CONFIG_HOME: home, LC_ALL: 'C', PATH: process.env.PATH ?? '' };
    const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    put(hooks, 'pre-commit', MANAGED);
    try {
      Object.assign(process.env, overrides);
      const git = createGitRunner(cwd, hooks, undefined, calls);
      const result = await run(cwd, { enforcement: true, deps: { git: (command, args, options) => {
        for (const key of ['HOME', 'XDG_CONFIG_HOME', 'LC_ALL', 'PATH']) assert.equal(options.env[key], overrides[key]);
        return git(command, args, options);
      } } });
      assert.equal(result.exitCode, 0); assert.ok(formatLines(result).includes(SWITCH));
      for (const question of ['rev-parse --is-inside-work-tree', 'check-ignore -q scripts/agent-workflow', 'rev-parse --git-path hooks']) assert.ok(calls.some((args) => args.join(' ') === question));
    } finally {
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  it('managed hooks switch after accepted writes or dry runs, and decline names the missing installer', async () => {
    assert.match(MANAGED, /:install-git-hooks\.mjs$/m);
    for (const [enforcement, dryRun] of [[true, false], [false, false], [true, true]]) {
      const cwd = createTree(), hooks = createTree(false); put(hooks, 'pre-commit', MANAGED);
      const before = snapshot(hooks), result = await run(cwd, { enforcement, dryRun, deps: { git: createGitRunner(cwd, hooks) } });
      assert.equal(result.exitCode, 0); assert.equal(getHookLines(result).length, 1);
      assert.ok(getHookLines(result)[0].includes(enforcement ? SWITCH : `${KIT}/${INSTALLER}`)); assert.deepEqual(snapshot(hooks), before);
      if (enforcement && !dryRun) for (const path of [INSTALLER, 'run.mjs', ...Object.values(KIT_COMMANDS)]) assert.ok(lstatSync(join(cwd, KIT, path)).isFile());
    }
  });
  it('unmanaged, already switched, absent and outside-git hooks yield no hook advice', async () => {
    for (const [body, outside] of [['#!/bin/sh\ncustom\n', false], ['#!/bin/sh\n# x:install-git-hooks.mjs\r extra\nnode scripts/check-docs-size.mjs\n', false], [`${MANAGED}${DOCS_LINE}\n`, false], [null, false], [MANAGED, true], [MANAGED, 'hooks-128']]) {
      const cwd = createTree(), hooks = createTree(false); if (body) put(hooks, 'pre-commit', body);
      const git = outside === true ? answerOutsideGit : createGitRunner(cwd, hooks, outside === 'hooks-128' ? answerOutsideGit() : undefined);
      const before = snapshot(hooks), result = await run(cwd, { enforcement: true, deps: { git } });
      assert.equal(result.exitCode, 0); assert.deepEqual(getHookLines(result), []); assert.deepEqual(snapshot(hooks), before);
      if (outside) assert.ok(!result.lines.some((line) => /could not be confirmed/.test(line)), formatLines(result));
    }
  });
  it('unanswerable hooks-dir questions report uncertainty on initial and current runs', async () => {
    for (const answer of [{ error: fail('ENOENT') }, { status: null, signal: 'SIGTERM' }, { status: 2 }, { status: 0, stdout: '' }, () => { throw fail('EPERM'); }]) {
      const cwd = createTree(), hooks = createTree(false), calls = []; put(hooks, 'pre-commit', MANAGED);
      const before = snapshot(hooks);
      for (const repeat of [false, true]) {
        const result = await run(cwd, { enforcement: true, deps: { git: createGitRunner(cwd, hooks, answer, calls) } });
        assert.equal(result.exitCode, 0); assert.ok(result.lines.some((line) => /could not be confirmed/.test(line) && /hooks/.test(line)), formatLines(result));
        assert.deepEqual(getHookLines(result), []); assert.deepEqual(snapshot(hooks), before);
        if (repeat) assert.deepEqual(getFileLines(result), []);
      }
      assert.equal(calls.filter((args) => args.join(' ') === 'rev-parse --git-path hooks').length, 2);
    }
  });
  it('real git: an ambient GIT_DIR cannot redirect CLI hook advice or writes', async () => {
    const cwd = createTree(), other = createTree(false), home = createTree(false), env = createChildEnv(home);
    for (const project of [cwd, other]) {
      const initialized = spawnSync('git', ['init', '-q', project], { cwd: project, env, encoding: 'utf8' });
      assert.equal(initialized.status, 0, `real git init: ${initialized.error?.code ?? ''} ${initialized.stderr ?? ''}`);
    }
    for (const [question, suffix] of [['--absolute-git-dir', '.git'], ['--git-common-dir', '.git'], ['--show-toplevel', '']]) {
      const identities = [env, { ...env, GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other }].map((childEnv) => {
        const answer = spawnSync('git', ['rev-parse', question], { cwd, env: childEnv, encoding: 'utf8' });
        assert.equal(answer.status, 0, answer.stderr); return resolve(cwd, answer.stdout.trim());
      });
      assert.deepEqual(identities, [join(cwd, suffix), join(other, suffix)], question);
    }
    put(cwd, '.git/hooks/pre-commit', MANAGED); seed(cwd);
    const before = snapshot(other), hookBefore = readFileSync(join(cwd, '.git/hooks/pre-commit'));
    const cli = spawnSync(process.execPath, [join(SKILL_ROOT, 'scripts/kit-folder.mjs'), '--project', cwd], { cwd, env: { ...env, GIT_DIR: join(other, '.git') }, encoding: 'utf8' });
    assert.equal(cli.status, 0, `${cli.error?.code ?? ''} ${cli.stderr}`); assert.ok(cli.stdout.includes(SWITCH), cli.stdout);
    assert.ok(readFileSync(join(cwd, '.git/hooks/pre-commit')).equals(hookBefore)); assert.deepEqual(snapshot(other), before);
  });
});
