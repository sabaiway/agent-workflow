// kit-folder.test.mjs — the kit's own folder scripts/agent-workflow taken away from every judgment by a
// fixed rule and named on every run, through the CLI on git fixtures and through the plan-time scope.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { hermeticGitEnv, withGitPath } from '../git-env.mjs';
import { main } from '../source-size-check.mjs';
import { makeTree, write, writeJson } from '../plan-shape-harness.test.mjs';

const loadConfig = () => import('../source-size-config.mjs');
const loadFacts = () => import('../plan-shape-facts.mjs');

const TMP = mkdtempSync(join(tmpdir(), 'aw-source-size-kit-folder-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const ENV = withGitPath(hermeticGitEnv(process.env, TMP));

const NL = String.fromCharCode(10);
const R = 'recorded by hand';
const KIT = 'scripts/agent-workflow';
const NOTE = 'source-size: NOTE';
const WARN = 'source-size: WARNING — ';
const KIT_NOTE = "source-size: NOTE — scripts/agent-workflow is the kit's own folder, so nothing in it is judged here; the kit's own repository judges its files";
const KIT_EMPTY = (root) => `source-size: NOTE — the declared root "${root}" matches no tracked file with a declared extension outside the kit's own folder scripts/agent-workflow`;
const PLAIN_EMPTY = (root) => `source-size: NOTE — the declared root "${root}" matches no tracked file with a declared extension`;
const KIT_ROOT_STOP = (root) => `"roots" declares "${root}", at or inside the kit's own folder scripts/agent-workflow — nothing in it is judged here, so declare a root outside it`;
const SCRIPTS_BAND = 'scripts: entries 22 is over the limit 20 but within its band (up to 22) — past 22 it stops';

const runGit = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
};
const lines = (n) => `x${NL}`.repeat(n);
const many = (dir, n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${dir}/f${i}.txt`, 'x']));
const writeTree = (cwd, files) => {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), body);
  }
};
const createProject = ({ files = {}, config = null, links = {} } = {}) => {
  const cwd = mkdtempSync(join(TMP, 'p'));
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  runGit(cwd, ['init', '-q', '-b', 'main']);
  writeTree(cwd, files);
  for (const [rel, target] of Object.entries(links)) symlinkSync(target, join(cwd, rel));
  if (config !== null) writeFileSync(configPath(cwd), JSON.stringify(config, null, 2));
  runGit(cwd, ['add', '-A']);
  return cwd;
};
const configPath = (cwd) => join(cwd, 'docs', 'ai', 'source-size.json');
const readBytes = (cwd) => readFileSync(configPath(cwd));
const readConfig = (cwd) => JSON.parse(readFileSync(configPath(cwd), 'utf8'));
const runCli = (cwd, ...args) => main([...args, '--cwd', cwd], { deps: { env: ENV } });
const showRun = (result) => `${result.stdout}${NL}${result.stderr}`;
const notesOf = (result) => result.stdout.split(NL).filter((line) => line.startsWith(NOTE));
const warningsOf = (result) => result.stdout.split(NL).filter((line) => line.startsWith(WARN)).map((line) => line.slice(WARN.length));

const AUTH = (over = {}) => ({ _README: 'fixture', schema: 2, roots: ['src'], exclude: [], extensions: ['.mjs'], ...over });
const MINTED = (root, lineCount, over = {}) => AUTH({ roots: [root], baseline: {}, aggregate: { [root]: { lines: lineCount, reason: R } }, ...over });
const LAYOUT = (roots, directories = {}) => ({
  layout: { roots: Object.fromEntries(Object.entries(roots).map(([root, files]) => [root, { files, reason: R }])), directories },
});
const KIT_TREE = { [`${KIT}/big.mjs`]: lines(441), [`${KIT}/wide.mjs`]: `${'x'.repeat(1001)}${NL}`, ...many(`${KIT}/many`, 23), [`${KIT}/a/b/c/d/e/f.txt`]: 'x' };
const KIT_LINK = { [`${KIT}/link.mjs`]: 'big.mjs' };
const SIBLINGS = { 'scripts/agent-workflow-x/a.mjs': lines(441), 'scripts/agent-workflowx.mjs': lines(441), ...many('scripts', 20) };

describe('spec:source-size/S51 every entry at or under the kit folder is taken away before anything is judged, under every root', () => {
  it('a present config records only the siblings beside the folder, its own name counted by nothing in scripts', () => {
    for (const [root, files] of [['.', 23], ['scripts', 22]]) {
      const cwd = createProject({ files: { ...KIT_TREE, ...SIBLINGS }, links: KIT_LINK, config: AUTH({ roots: [root] }) });
      const written = runCli(cwd, '--write-baseline', '--layout', '--reason', R);
      assert.equal(written.code, 0, `${root}:${NL}${showRun(written)}`);
      const record = readConfig(cwd);
      assert.deepEqual(Object.keys(record.baseline).sort(), ['scripts/agent-workflow-x/a.mjs', 'scripts/agent-workflowx.mjs'], root);
      assert.equal(record.aggregate[root].lines, 882, root);
      assert.equal(record.layout.roots[root].files, files, root);
      assert.deepEqual(record.layout.directories, {}, `${root}: scripts holds 22 entries without the folder, and nothing in the folder is recorded`);
      const check = runCli(cwd, '--check');
      assert.equal(check.code, 0, `${root}:${NL}${showRun(check)}`);
      assert.ok(!check.stdout.includes(`${KIT}/`), `${root}: nothing in the folder is named:${NL}${check.stdout}`);
    }
  });

  it('the absent config judges layout without the folder, so scripts within its band is the only warning', () => {
    const cwd = createProject({ files: { ...KIT_TREE, ...SIBLINGS }, links: KIT_LINK });
    const check = runCli(cwd, '--check');
    assert.deepEqual([check.code, warningsOf(check)], [0, [SCRIPTS_BAND]], showRun(check));
    const written = runCli(cwd, '--write-baseline', '--reason', R);
    assert.equal(written.code, 0, showRun(written));
    assert.deepEqual(readConfig(cwd).layout, { roots: { '.': { files: 22, reason: R } }, directories: {} });
  });

  it('the fixed path is the exported KIT_FOLDER_ROOT', async () => {
    const { KIT_FOLDER_ROOT } = await loadConfig();
    assert.equal(KIT_FOLDER_ROOT, KIT);
  });
});

describe('spec:source-size/S52 every run that judges the tree names the folder once, last of its not-judged lines', () => {
  const RECORDED = MINTED('src', 1, LAYOUT({ src: 1 }));
  const withFolder = (files) => [files, { ...files, [`${KIT}/tool.mjs`]: lines(1) }];
  const noLayout = (cwd) => `source-size: NOTE — ${configPath(cwd)} records no "layout", so entries per directory, depth and files per root are not judged; --write-baseline --layout --reason "<text>" starts it`;
  const noExtension = (cwd) => `source-size: NOTE — ${configPath(cwd)} declares no extension, so no file is judged on lines or bytes`;
  const absent = (cwd) => `source-size: NOTE — ${configPath(cwd)} is absent, so the kit's values judge layout alone and no file is judged on lines or bytes`;

  it('--check, --write-baseline and --override print it after every other note, the folder present or absent', () => {
    for (const files of withFolder({ 'src/a.mjs': lines(1) })) {
      for (const args of [['--check'], ['--write-baseline'], ['--override', 'depth', '--value', '6', '--reason', 'r']]) {
        const cwd = createProject({ files, config: RECORDED });
        const result = runCli(cwd, ...args);
        assert.deepEqual([result.code, notesOf(result)], [0, [KIT_NOTE]], `${args[0]}:${NL}${showRun(result)}`);
      }
      const plain = createProject({ files, config: MINTED('src', 1) });
      assert.deepEqual(notesOf(runCli(plain, '--check')), [noLayout(plain), KIT_NOTE]);
      const bare = createProject({ files, config: { _README: 'fixture', schema: 2, roots: ['src'], exclude: [], baseline: {}, aggregate: { src: { lines: 0, reason: R } } } });
      assert.deepEqual(notesOf(runCli(bare, '--check')), [noExtension(bare), noLayout(bare), KIT_NOTE]);
      const none = createProject({ files });
      assert.deepEqual(notesOf(runCli(none, '--check')), [absent(none), KIT_NOTE]);
      assert.deepEqual(notesOf(runCli(none, '--write-baseline', '--reason', R)), [absent(none), KIT_NOTE]);
    }
  });

  it('the schema-1 and unminted stops and --override on an absent config print no such line', () => {
    const files = { 'src/a.mjs': lines(1), [`${KIT}/tool.mjs`]: lines(1) };
    const schema1 = { _README: 'fixture', schema: 1, defaults: { maxLines: 400, maxLineBytes: 1000 }, roots: ['src'], exclude: [], extensions: ['.mjs'], baseline: {}, aggregate: { src: { lines: 1, reason: R } } };
    for (const [label, result] of [
      ['schema 1', runCli(createProject({ files, config: schema1 }), '--check')],
      ['unminted', runCli(createProject({ files, config: AUTH() }), '--check')],
      ['absent --override', runCli(createProject({ files }), '--override', 'depth', '--value', '6', '--reason', 'r')],
    ]) {
      assert.equal(result.code, 1, `${label}:${NL}${showRun(result)}`);
      assert.ok(!result.stdout.includes(KIT_NOTE), `${label}:${NL}${result.stdout}`);
    }
  });

  it('--help names the folder in its scope sentence and in its layout sentence', () => {
    const help = main(['--help']).stdout.replace(/\s+/g, ' ');
    const scope = help.slice(help.indexOf('Judges every in-scope file'), help.indexOf('Limits:'));
    assert.ok(scope.includes(KIT), `the scope sentence names ${KIT}:${NL}${scope}`);
    assert.ok(help.includes(`over every tracked entry under a declared root outside the kit's own folder ${KIT} plus the spec store`), help);
  });
});

describe('spec:source-size/S53 a declared root at or inside the kit folder is a config stop on every config', () => {
  it('exit 2 naming the root, with layout or without, minted, authored or schema 1, and a write leaves the config unchanged', () => {
    for (const root of [KIT, `${KIT}/tools`]) {
      const configs = [
        AUTH({ roots: [root] }),
        MINTED(root, 1),
        MINTED(root, 1, LAYOUT({ [root]: 1 })),
        { _README: 'fixture', schema: 1, defaults: { maxLines: 400, maxLineBytes: 1000 }, roots: [root], exclude: [], extensions: ['.mjs'] },
      ];
      for (const config of configs) {
        const cwd = createProject({ files: { [`${KIT}/tools/a.mjs`]: lines(1) }, config });
        const before = readBytes(cwd);
        for (const args of [['--check'], ['--write-baseline', '--reason', R]]) {
          const result = runCli(cwd, ...args);
          assert.equal(result.code, 2, `${root} ${args[0]}:${NL}${showRun(result)}`);
          assert.ok(result.stderr.includes(KIT_ROOT_STOP(root)), `${root} ${args[0]}:${NL}${showRun(result)}`);
        }
        assert.deepEqual(readBytes(cwd), before, `${root}: a config stop writes nothing`);
      }
    }
  });

  it('the roots scripts and . stay valid, and so does an exclude entry inside the folder', () => {
    const files = { 'scripts/b.mjs': lines(1), [`${KIT}/gen/a.mjs`]: lines(1) };
    for (const config of [AUTH({ roots: ['scripts'] }), AUTH({ roots: ['.'], exclude: [`${KIT}/gen`] })]) {
      const result = runCli(createProject({ files, config }), '--write-baseline', '--layout', '--reason', R);
      assert.equal(result.code, 0, `${config.roots[0]}:${NL}${showRun(result)}`);
    }
  });
});

describe('spec:source-size/S54 a record at or under the kit folder is a gone record', () => {
  it('a baseline key and a layout.directories key under it warn, exit 0, and the regeneration removes both with no reason', () => {
    const config = MINTED('.', 1, {
      baseline: { [`${KIT}/big.mjs`]: { lines: 500, reason: R } },
      ...LAYOUT({ '.': 2 }, { [KIT]: { entries: 30, reason: R } }),
    });
    const cwd = createProject({ files: { 'src/a.mjs': lines(1), [`${KIT}/big.mjs`]: lines(500), ...many(KIT, 29) }, config });
    const check = runCli(cwd, '--check');
    assert.equal(check.code, 0, showRun(check));
    for (const text of [
      `${KIT}/big.mjs: recorded in "baseline" but no longer in scope — split, renamed or deleted; the regeneration removes it`,
      `${KIT}: recorded in "layout"."directories" but no directory the run judges — the regeneration removes it`,
    ]) assert.ok(warningsOf(check).includes(text), `expected the warning «${text}»:${NL}${check.stdout}`);
    const written = runCli(cwd, '--write-baseline');
    assert.equal(written.code, 0, showRun(written));
    const record = readConfig(cwd);
    assert.deepEqual([record.baseline, record.layout.directories], [{}, {}]);
  });
});

describe('spec:source-size/S55 a scope matching only inside the kit folder is no refusal', () => {
  it('it judges no line, judges layout as before, exits by its findings and names each such root in its empty-root note', () => {
    const config = AUTH({
      roots: ['scripts', 'lib'],
      baseline: {},
      aggregate: { scripts: { lines: 0, reason: R }, lib: { lines: 0, reason: R } },
      ...LAYOUT({ scripts: 22, lib: 1 }),
    });
    const cwd = createProject({ files: { [`${KIT}/a.mjs`]: lines(441), ...many('scripts/wide', 22), 'lib/readme.txt': 'x' }, config });
    const check = runCli(cwd, '--check');
    assert.equal(check.code, 0, showRun(check));
    assert.deepEqual(notesOf(check), [KIT_NOTE, KIT_EMPTY('scripts'), PLAIN_EMPTY('lib')], showRun(check));
    assert.ok(warningsOf(check).includes('scripts/wide: entries 22 is over the limit 20 but within its band (up to 22) — past 22 it stops'), check.stdout);
  });

  it('a scope matching no tracked file at all, the kit folder included, still refuses as an empty scope', () => {
    const cwd = createProject({ files: { 'lib/readme.txt': 'x', [`${KIT}/a.txt`]: 'x' }, config: MINTED('.', 0) });
    const check = runCli(cwd, '--check');
    assert.equal(check.code, 1, showRun(check));
    assert.ok(check.stderr.includes('the declared scope matches ZERO tracked files'), showRun(check));
  });
});

describe('spec:source-size/S56 the plan-time scope takes the kit folder away by the same rule as the check', () => {
  it('a path under scripts/agent-workflow is out of the source scope while its look-alike siblings stay in, under . and under scripts', async (t) => {
    const { buildFacts } = await loadFacts();
    const paths = [`${KIT}/a.mjs`, `${KIT}/deep/b.mjs`, 'scripts/agent-workflow-x/a.mjs', 'scripts/agent-workflowx.mjs'];
    for (const declaration of [{ schema: 2, extensions: ['.mjs'] }, { schema: 2, roots: ['scripts'], extensions: ['.mjs'] }]) {
      const root = makeTree('source-size-kit-folder');
      t.after(() => rmSync(root, { recursive: true, force: true }));
      writeJson(root, 'docs/ai/source-size.json', declaration);
      for (const path of paths) write(root, path, 'source\n');
      const facts = buildFacts(root, { paths });
      assert.deepEqual(paths.map((path) => facts.pathFacts[path].inScope), [false, false, true, true], JSON.stringify(declaration));
    }
  });
});
