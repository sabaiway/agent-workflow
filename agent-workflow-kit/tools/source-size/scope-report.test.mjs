import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { hermeticGitEnv } from '../git-env.mjs';
import { runGates } from '../run-gates.mjs';
import { guardedMain } from '../source-size-check.mjs';
import { SOURCE_SIZE_TOOL_PATH } from '../source-size-gate-cmd.mjs';
import { EXPECTED_WORKFLOW_VERSION } from '../velocity-profile.mjs';
import { configPath, createProject, makeLines, readBlock, runCli, runGit } from './cli-harness.test.mjs';

const REASON = 'These small fixtures keep the scope examples independently measurable.';
const KIT_NOTE = "source-size: NOTE — scripts/agent-workflow is the kit's own folder, so nothing in it is judged here; the kit's own repository judges its files";
const EXCLUDE_NOTE = 'source-size: NOTE — the "exclude" entry ';
const WARNING = 'source-size: WARNING — ';
const CONFIG_REMEDY = 'fix the size config or the git index error the verdict line names, then re-run';
const RAISE = 'This regeneration RAISES a recorded value, so the reason is REQUIRED — it is recorded in the entry it raises, and it is what the commit message and the CHANGELOG restate.';
const authored = (over = {}) => ({ schema: 2, roots: ['src'], extensions: ['.mjs'], exclude: ['src/gen'], ...over });
const minted = (over = {}) => ({ ...authored(), baseline: {}, aggregate: { src: { lines: 1, reason: REASON } }, ...over });
const layout = (root, files) => ({ roots: { [root]: { files, reason: REASON } }, directories: {} });
const note = (entry, count) => `${EXCLUDE_NOTE}"${entry}" leaves out ${count} tracked path(s) under the declared roots`;
const noMatch = (entry) => `${EXCLUDE_NOTE}"${entry}" leaves out nothing: an entry is a literal path prefix, never a pattern, and no tracked path carries it`;
const outsideRoots = (entry, count) => `${EXCLUDE_NOTE}"${entry}" leaves out nothing: an entry is a literal path prefix, never a pattern, and the ${count} tracked path(s) that carry it lie outside every declared root`;
const listing = (paths) => `${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` and ${paths.length - 3} more` : ''}`;
const untracked = (paths) => `${WARNING}${paths.length} path(s) this run would judge are untracked and not ignored, so the index-based scope did not include them: ${listing(paths)}`;
const differing = (paths) => `${WARNING}${paths.length} judged file(s) hold work-tree bytes that differ from the index, and the work tree's bytes are the ones measured: ${listing(paths)}`;
const linesOf = (result) => result.stdout.split('\n');
const warningsOf = (result) => linesOf(result).filter((line) => line.startsWith(WARNING));
const scopeWarnings = (result) => warningsOf(result).filter((line) => line.includes('untracked and not ignored') || line.includes('hold work-tree bytes'));
const assertRun = (result, code = 0) => assert.deepEqual([result.code, result.stderr], [code, ''], result.stdout);
const assertNotes = (result, expected) => {
  const notes = linesOf(result).filter((line) => line.startsWith('source-size: NOTE — '));
  assert.deepEqual(notes.filter((line) => line.startsWith(EXCLUDE_NOTE)), expected, result.stdout);
  assert.equal(notes.at(-1), KIT_NOTE, result.stdout);
  assert.equal(notes.filter((line) => line === KIT_NOTE).length, 1);
};
const bothWarnings = [untracked(['src/new.mjs']), differing(['src/a.mjs'])];
const withBothWarnings = (config = minted(), body = 'y\n') => {
  const cwd = createProject({ files: { 'src/a.mjs': body.replaceAll('y', 'x') }, config, store: { 'src/new.mjs': 'x\n' } });
  writeFileSync(join(cwd, 'src/a.mjs'), body);
  return cwd;
};
const assertWarningsBeforeRefusal = (result) => {
  assertRun(result, 1);
  assert.deepEqual(scopeWarnings(result), bothWarnings, result.stdout);
  const lines = linesOf(result);
  const refusal = lines.findIndex((line) => line.startsWith('source-size: ') && line.includes('REFUSED — '));
  assert.ok(refusal >= 0, result.stdout);
  for (const warning of bothWarnings) assert.ok(lines.indexOf(warning) < refusal, result.stdout);
};

describe('spec:source-size/S66 exclusion notes explain the paths left out of each judged run', () => {
  for (const args of [
    ['--check'],
    ['--write-baseline', '--reason', REASON],
    ['--override', 'lines-per-file', '--value', '500', '--reason', REASON],
  ]) {
    it(`${args[0]} counts every mode and extension by segment, with overlapping entries in declared order`, () => {
      const cwd = createProject({
        files: { 'src/a.mjs': 'x\n', 'src/generated/x.mjs': 'x\n', 'src/gen/readme.md': 'x', 'src/gen/deep/a.txt': 'x' },
        config: minted({ exclude: ['src/gen/deep', 'src/gen'], aggregate: { src: { lines: 2, reason: REASON } } }),
      });
      symlinkSync('../a.mjs', join(cwd, 'src/gen/link'));
      runGit(cwd, ['add', 'src/gen/link']);
      const result = runCli(cwd, ...args);
      assertRun(result);
      assertNotes(result, [note('src/gen/deep', 1), note('src/gen', 3)]);
    });
  }

  it('an empty exclude prints no exclusion note', () => {
    const cwd = createProject({ files: { 'src/a.mjs': 'x\n' }, config: minted({ exclude: [] }) });
    const result = runCli(cwd, '--check');
    assertRun(result);
    assertNotes(result, []);
  });

  for (const [label, entry, files, expected] of [
    ['no tracked path carries the entry', 'src/missing', {}, noMatch('src/missing')],
    ['every carried tracked path lies outside the roots', 'tools/x', { 'tools/x/a.mjs': 'x', 'tools/x/b.txt': 'x' }, outsideRoots('tools/x', 2)],
  ]) {
    it(label, () => {
      const cwd = createProject({ files: { 'src/a.mjs': 'x\n', ...files }, config: minted({ exclude: [entry] }) });
      const result = runCli(cwd, '--check');
      assertRun(result);
      assertNotes(result, [expected]);
    });
  }

  it('an entry inside the kit folder counts its paths before the folder is taken away', () => {
    const entry = 'scripts/agent-workflow/x';
    const cwd = createProject({
      files: { 'src/a.mjs': 'x\n', [`${entry}/a.mjs`]: 'x', [`${entry}/readme.md`]: 'x' },
      config: minted({ roots: ['.'], exclude: [entry], aggregate: { '.': { lines: 1, reason: REASON } } }),
    });
    const result = runCli(cwd, '--check');
    assertRun(result);
    assertNotes(result, [note(entry, 2)]);
  });

  it('notes leave a green exit and its warning count unchanged', () => {
    const cwd = createProject({ files: { 'src/a.mjs': 'x\n', 'src/gen/a.mjs': 'x' }, config: minted() });
    const result = runCli(cwd, '--check');
    assertRun(result);
    assert.deepEqual(warningsOf(result), []);
    assert.ok(linesOf(result).includes('source-size: PASS — 1 in-scope file(s) within the declared caps'), result.stdout);
    assertNotes(result, [note('src/gen', 1)]);
  });
});

describe('spec:source-size/S67 reports work-tree paths the index does not hold without stopping the run', () => {
  for (const [label, path] of [
    ['a declared extension counts without layout', 'src/new.mjs'],
    ['an undeclared extension does not count without layout', 'src/notes.txt'],
    ['an ignored path does not count', 'src/ignored.mjs'],
    ['an excluded path does not count', 'src/gen/x.mjs'],
    ['a path outside the roots does not count', 'other/x.mjs'],
  ]) {
    it(label, () => {
      const cwd = createProject({
        files: { 'src/a.mjs': 'x\n', '.gitignore': 'src/ignored.mjs\n' }, config: minted(),
        store: { 'src/new.mjs': 'x\n', [path]: 'x\n' },
      });
      const result = runCli(cwd, '--check');
      assertRun(result);
      assert.deepEqual(scopeWarnings(result), [untracked(['src/new.mjs'])], label);
    });
  }

  for (const [label, config] of [
    ['layout counts an undeclared extension', minted({ layout: layout('src', 1) })],
    ['an absent config counts an undeclared extension through layout', null],
  ]) {
    it(label, () => {
      const cwd = createProject({ files: { 'src/a.mjs': 'x\n' }, config, store: { 'src/notes.txt': 'x' } });
      const result = runCli(cwd, '--check');
      assertRun(result);
      assert.deepEqual(scopeWarnings(result), [untracked(['src/notes.txt'])], label);
    });
  }

  for (const [label, path, expected] of [
    ['a declared extension in the spec store counts', 'docs/ai/specs/x.mjs', ['docs/ai/specs/x.mjs', 'src/new.mjs']],
    ['an undeclared extension in the spec store does not count', 'docs/ai/specs/x.md', ['src/new.mjs']],
    ['a path in the kit folder never counts', 'scripts/agent-workflow/x.mjs', ['src/new.mjs']],
  ]) {
    it(label, () => {
      const config = minted({ roots: ['.'], aggregate: { '.': { lines: 1, reason: REASON } }, layout: layout('.', 2) });
      const cwd = createProject({ files: { 'src/a.mjs': 'x\n' }, config, store: { 'src/new.mjs': 'x', [path]: 'x' } });
      const result = runCli(cwd, '--check');
      assertRun(result);
      assert.deepEqual(scopeWarnings(result), [untracked(expected)], label);
    });
  }

  for (const [label, path, body, intent, executable, expected] of [
    ['an unstaged content edit counts', 'src/b.mjs', 'y\n', false, false, ['src/a.mjs', 'src/b.mjs']],
    ['intent-to-add counts', 'src/intent.mjs', 'x\n', true, false, ['src/a.mjs', 'src/intent.mjs']],
    ['empty intent-to-add counts', 'src/intent.mjs', '', true, false, ['src/a.mjs', 'src/intent.mjs']],
    ['an unmeasured content edit does not count', 'src/notes.txt', 'y\n', false, false, ['src/a.mjs']],
    ['a mode-only change does not count', 'src/b.mjs', 'x\n', false, true, ['src/a.mjs']],
    ['a mode and content change counts', 'src/b.mjs', 'y\n', false, true, ['src/a.mjs', 'src/b.mjs']],
  ]) {
    it(label, () => {
      const count = intent && body !== '' ? 3 : 2;
      const cwd = createProject({
        files: { 'src/a.mjs': 'x\n', 'src/b.mjs': 'x\n', 'src/notes.txt': 'x\n' },
        config: minted({ aggregate: { src: { lines: count, reason: REASON } } }),
      });
      writeFileSync(join(cwd, 'src/a.mjs'), 'y\n');
      writeFileSync(join(cwd, path), body);
      if (intent) runGit(cwd, ['add', '-N', path]);
      if (executable) chmodSync(join(cwd, path), 0o755);
      const result = runCli(cwd, '--check');
      assertRun(result);
      assert.deepEqual(scopeWarnings(result), [differing(expected)], label);
    });
  }

  for (const names of [['e', 'd', 'c', 'b', 'a'], ['c', 'a', 'b']]) {
    it(`${names.length} untracked paths list the first three in path order with only the actual remainder`, () => {
      const clean = createProject({ files: { 'src/a.mjs': 'x\n' }, config: minted() });
      const zero = runCli(clean, '--check');
      assertRun(zero);
      assert.deepEqual(scopeWarnings(zero), [], 'zero paths print neither warning');
      const paths = names.map((name) => `src/${name}.mjs`);
      const cwd = createProject({ files: { 'src/tracked.mjs': 'x\n' }, config: minted(), store: Object.fromEntries(paths.map((path) => [path, 'x'])) });
      const result = runCli(cwd, '--check');
      assertRun(result);
      assert.deepEqual(scopeWarnings(result), [untracked(paths.toSorted())]);
    });
  }

  it('both warnings leave the check green and enter its PASS warning count', () => {
    const result = runCli(withBothWarnings(), '--check');
    assertRun(result);
    assert.deepEqual(warningsOf(result), bothWarnings);
    const lines = linesOf(result);
    const pass = 'source-size: PASS with 2 warning(s) — 1 in-scope file(s) judged and nothing beyond a band or a record; each warning above repeats on every run until it is settled';
    assert.ok(lines.includes(pass), result.stdout);
    assert.ok(lines.indexOf(KIT_NOTE) < lines.indexOf(bothWarnings[0]));
    assert.ok(lines.indexOf(bothWarnings[1]) < lines.indexOf(pass));
  });

  it('a stopped check prints both warnings after its notes and before the raise sentence', () => {
    const config = minted({ aggregate: { src: { lines: 441, reason: REASON } } });
    const result = runCli(withBothWarnings(config, 'y\n'.repeat(441)), '--check');
    assertRun(result, 1);
    const block = readBlock(result.stdout);
    assert.match(block.verdict, /1 finding\(s\) against /);
    assert.deepEqual(block.after.filter((line) => line.startsWith(WARNING)), bothWarnings);
    assert.ok(block.after.includes(KIT_NOTE), result.stdout);
    assert.ok(block.after.indexOf(KIT_NOTE) < block.after.indexOf(bothWarnings[0]));
    for (const warning of bothWarnings) assert.ok(block.after.indexOf(warning) < block.after.indexOf(RAISE));
  });

  it('a successful baseline write retains both standing warnings', () => {
    const result = runCli(withBothWarnings(), '--write-baseline', '--reason', REASON);
    assertRun(result);
    assert.deepEqual(warningsOf(result), bothWarnings);
  });

  it('a baseline raise without a reason prints both warnings before refusing', () => {
    const cwd = withBothWarnings(minted({ aggregate: { src: { lines: 441, reason: REASON } } }), 'y\n'.repeat(441));
    const before = readFileSync(configPath(cwd));
    assertWarningsBeforeRefusal(runCli(cwd, '--write-baseline'));
    assert.deepEqual(readFileSync(configPath(cwd)), before);
  });

  it('an override of an outgrown record prints both warnings once before refusing and changes no config byte', () => {
    const cwd = withBothWarnings(minted(), 'y\ny\n');
    const before = readFileSync(configPath(cwd));
    const result = runCli(cwd, '--override', 'lines-per-file', '--value', '500', '--reason', REASON);
    assertWarningsBeforeRefusal(result);
    assert.deepEqual(readFileSync(configPath(cwd)), before);
  });

  it('adoption recognizes a green minted record without printing either warning of its check', () => {
    const cwd = createProject({
      files: { 'src/a.mjs': 'x\n', 'docs/ai/.workflow-version': `${EXPECTED_WORKFLOW_VERSION}\n` },
      config: minted(), store: { 'src/new.mjs': 'x' },
    });
    writeFileSync(join(cwd, 'src/a.mjs'), 'y\n');
    const result = runCli(cwd, '--adopt');
    assertRun(result);
    assert.deepEqual(scopeWarnings(result), []);
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'docs/ai/gates.json'), 'utf8')).gates.map((gate) => gate.id), ['source-size']);
  });

  it('adoption of an authored config prints the untracked warning among its mint standing warnings', () => {
    const cwd = createProject({
      files: { 'src/a.mjs': 'x\n', 'docs/ai/.workflow-version': `${EXPECTED_WORKFLOW_VERSION}\n` },
      config: authored(), store: { 'src/new.mjs': 'x' },
    });
    const result = runCli(cwd, '--adopt', '--reason', REASON);
    assertRun(result);
    assert.deepEqual(warningsOf(result), [untracked(['src/new.mjs'])]);
  });

  it('the real gate runner echoes both WARNING lines after PASS and no exclusion NOTE', () => {
    const gates = [{ id: 'source-size', title: 'Source size', cmd: `node "${SOURCE_SIZE_TOOL_PATH}" --check` }];
    const cwd = createProject({
      files: { 'src/a.mjs': 'x\n', 'src/gen/a.mjs': 'x', 'docs/ai/gates.json': JSON.stringify({ gates }) },
      config: minted(), store: { 'src/new.mjs': 'x' },
    });
    writeFileSync(join(cwd, 'src/a.mjs'), 'y\n');
    const log = [];
    const declaration = JSON.parse(readFileSync(join(cwd, 'docs/ai/gates.json'), 'utf8'));
    const results = runGates(declaration.gates, {
      cwd, log: (line) => log.push(line),
      spawn: (command, directory) => spawnSync('bash', ['-c', command], { cwd: directory, encoding: 'utf8', env: hermeticGitEnv(process.env, directory) }),
    });
    assert.equal(results.every((result) => result.ok), true, log.join('\n'));
    assert.deepEqual(log.filter((line) => line.startsWith(WARNING)), bothWarnings);
    const pass = log.findIndex((line) => /^\s+PASS /.test(line));
    assert.ok(pass >= 0, log.join('\n'));
    for (const warning of bothWarnings) assert.ok(log.indexOf(warning) > pass);
    assert.equal(log.some((line) => line.includes('source-size: NOTE — ')), false);
  });

  it('a line-ending conversion git reports unchanged does not count', () => {
    const cwd = createProject({ files: { 'src/a.mjs': 'x\n' }, config: minted({ aggregate: { src: { lines: 2, reason: REASON } } }) });
    runGit(cwd, ['config', 'core.autocrlf', 'true']);
    writeFileSync(join(cwd, 'src/b.mjs'), 'x\r\n');
    runGit(cwd, ['add', 'src/b.mjs']);
    const result = runCli(cwd, '--check');
    assertRun(result);
    assert.deepEqual(scopeWarnings(result), []);
  });

  it('a gitlink whose submodule git dir is gone leaves the check green', () => {
    const cwd = createProject({ files: { 'src/a.mjs': 'x\n' }, config: minted() });
    runGit(cwd, ['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},sub`]);
    mkdirSync(join(cwd, 'sub'));
    writeFileSync(join(cwd, 'sub', '.git'), 'gitdir: ../.git/modules/sub\n');
    const result = runCli(cwd, '--check');
    assertRun(result);
    assert.deepEqual(scopeWarnings(result), []);
  });

  it('a failed work-tree query is an enumeration error with exit 2, never a green count of zero', () => {
    const cwd = createProject({ files: { 'src/a.mjs': makeLines(1) }, config: minted() });
    const spawn = (command, args, options) => {
      const location = args[0] === 'rev-parse' && args.length === 2 && ['--absolute-git-dir', '--git-common-dir', '--show-toplevel'].includes(args[1]);
      const index = JSON.stringify(args) === JSON.stringify(['ls-files', '-s', '-z']);
      return command !== 'git' || location || index ? spawnSync(command, args, options) : { status: 128, stdout: '', stderr: 'fatal: fixture' };
    };
    const result = guardedMain(['--check', '--cwd', cwd], { deps: { spawn } });
    assertRun(result, 2);
    const block = readBlock(result.stdout);
    assert.notEqual(block.verdict, null, result.stdout);
    assert.deepEqual(block.remedies, [CONFIG_REMEDY]);
    assert.deepEqual(block.findings, []);
    assert.doesNotMatch(result.stdout, /source-size: PASS/);
  });
});
