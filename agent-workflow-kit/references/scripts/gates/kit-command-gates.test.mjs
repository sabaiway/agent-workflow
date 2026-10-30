import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, appendFileSync, writeFileSync, readFileSync, chmodSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFamily } from '../family.mjs';

const TREE = dirname(dirname(fileURLToPath(import.meta.url)));
const KIT = 'scripts/agent-workflow';
const COMMAND = `node ${KIT}/run.mjs`;
const TARGETS = {
  'docs-size': 'docs-size/check-docs-size.mjs',
  'archive-changelog': 'archives/archive-changelog.mjs',
  'archive-issues': 'archives/archive-issues.mjs',
  'archive-decisions': 'archives/archive-decisions.mjs',
  'install-git-hooks': 'git-hooks/install-git-hooks.mjs',
};
const flatOf = (name) => `scripts/${TARGETS[name].split('/').pop()}`;
const plan = async (...args) => (await import('./kit-command-gates.mjs')).planKitCommandGates(...args);

const temps = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
const at = (root, path) => join(root, ...path.split('/'));

const currentProject = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-command-gates-')));
  temps.push(root);
  for (const { path } of readFamily(TREE).filter((entry) => entry.role === 'deployed')) {
    mkdirSync(dirname(at(root, `${KIT}/${path}`)), { recursive: true });
    copyFileSync(at(TREE, path), at(root, `${KIT}/${path}`));
  }
  return root;
};
const gate = (id, cmd) => ({ id, title: `the ${id} gate`, cmd, extra: { kept: true } });
const answered = async (gates, root) => {
  const given = structuredClone(gates);
  const result = await plan(gates, root);
  assert.deepEqual(gates, given, 'the gates given are never changed');
  return result;
};

describe('spec:kit-command/S6 a matched gate over a current kit folder is switched to the command', () => {
  it('the deployed target or an absent flat file, bare, ./ or double-quoted, with zero or more -- flags, takes two parameters', async () => {
    assert.equal((await import('./kit-command-gates.mjs')).planKitCommandGates.length, 2);
    const root = currentProject();
    const forms = [
      [(path) => path, ''],
      [(path) => `./${path}`, ' --check'],
      [(path) => `"${path}"`, ' --check --check-index'],
    ];
    const gates = [gate('lint', 'npm run lint')];
    const expected = [gates[0]];
    const switched = [];
    for (const name of Object.keys(TARGETS)) {
      for (const [form, flags] of forms) {
        for (const [kind, path] of [['deployed', `${KIT}/${TARGETS[name]}`], ['flat', flatOf(name)]]) {
          const one = gate(`${name}-${kind}-${gates.length}`, `node ${form(path)}${flags}`);
          gates.push(one);
          expected.push({ ...one, cmd: `${COMMAND} ${name}${flags}` });
          switched.push({ id: one.id, cmd: `${COMMAND} ${name}${flags}`, was: one.cmd });
        }
      }
    }
    gates.push(gate('tail', 'npm test'));
    expected.push(gates.at(-1));
    const result = await answered(gates, root);
    assert.deepEqual(result.gates, expected, 'each keeps its id, every other field and its place');
    assert.deepEqual(result.switched, switched);
    assert.deepEqual([result.withheld, result.repoints], [[], []]);
  });

  it('any standing flat node keeps its gate and repoint beside another name whose absent flat file switches', async () => {
    for (const kind of ['kit body', 'other bytes', 'link', 'dangling link', 'directory']) {
      const root = currentProject();
      const flat = at(root, flatOf('archive-issues'));
      if (kind === 'kit body') copyFileSync(at(TREE, TARGETS['archive-issues']), flat);
      if (kind === 'other bytes') writeFileSync(flat, 'project-owned bytes\n');
      if (kind === 'link') symlinkSync(at(root, `${KIT}/${TARGETS['archive-issues']}`), flat);
      if (kind === 'dangling link') symlinkSync(at(root, 'missing.mjs'), flat);
      if (kind === 'directory') mkdirSync(flat);
      const gates = [gate('docs', 'node scripts/check-docs-size.mjs --check-index'), gate('issues', 'node scripts/archive-issues.mjs --check')];
      const result = await answered(gates, root);
      assert.deepEqual(result.repoints, [{ id: 'issues', repoint: `${COMMAND} archive-issues` }], kind);
      assert.deepEqual(result.gates, [{ ...gates[0], cmd: `${COMMAND} docs-size --check-index` }, gates[1]], kind);
      assert.deepEqual(result.switched, [{ id: 'docs', cmd: `${COMMAND} docs-size --check-index`, was: gates[0].cmd }], kind);
      assert.deepEqual(result.withheld, [], kind);
    }
  });
});

describe('spec:kit-command/S7 proof of a current kit folder is judged per name', () => {
  const replaceWithLink = (path) => (root, twin) => { rmSync(at(root, path), { recursive: true, force: true }); symlinkSync(at(twin, path), at(root, path)); };
  const replaceWithDirectory = (path) => (root) => { rmSync(at(root, path)); mkdirSync(at(root, path)); };
  const remove = (path) => (root) => rmSync(at(root, path));
  const edit = (path) => (root) => appendFileSync(at(root, path), '// changed by hand\n');
  const unreadable = (path) => (root) => chmodSync(at(root, path), 0o000);
  const PERMISSION_CASE = { skip: process.getuid?.() === 0 };
  const CASES = [
    ['scripts/ a link to an identical kit elsewhere', replaceWithLink('scripts'), 'scripts'],
    ['the kit folder a link to an identical one elsewhere', replaceWithLink(KIT), KIT],
    ['a module folder a link to an identical one elsewhere', replaceWithLink(`${KIT}/docs-size`), `${KIT}/docs-size`],
    ['run.mjs absent', remove(`${KIT}/run.mjs`), `${KIT}/run.mjs`],
    ['the name\'s target absent', remove(`${KIT}/docs-size/check-docs-size.mjs`), `${KIT}/docs-size/check-docs-size.mjs`],
    ['a file the target loads a link to an identical file elsewhere', replaceWithLink(`${KIT}/shared/index.mjs`), `${KIT}/shared/index.mjs`],
    ['a deployed entry a directory', replaceWithDirectory(`${KIT}/spec-schema/index.mjs`), `${KIT}/spec-schema/index.mjs`],
    ['run.mjs not byte-equal', edit(`${KIT}/run.mjs`), `${KIT}/run.mjs`],
    ['the name\'s target not byte-equal', edit(`${KIT}/docs-size/check-docs-size.mjs`), `${KIT}/docs-size/check-docs-size.mjs`],
    ['a file the target loads not byte-equal', edit(`${KIT}/shared/project-root.mjs`), `${KIT}/shared/project-root.mjs`],
    ['a deployed entry that cannot be read', unreadable(`${KIT}/shared/project-root.mjs`), `${KIT}/shared/project-root.mjs`, PERMISSION_CASE],
  ];
  for (const [path, kind, change] of [
    ['run.mjs', 'a link', replaceWithLink], ['run.mjs', 'a directory', replaceWithDirectory],
    [TARGETS['docs-size'], 'a link', replaceWithLink], [TARGETS['docs-size'], 'a directory', replaceWithDirectory],
    ['shared/project-root.mjs', 'absent', remove], ['shared/project-root.mjs', 'a link', replaceWithLink],
    ['shared/project-root.mjs', 'a directory', replaceWithDirectory],
  ]) {
    CASES.push([`${path} ${kind}`, change(`${KIT}/${path}`), `${KIT}/${path}`]);
  }
  const gates = [gate('docs', `node ${KIT}/docs-size/check-docs-size.mjs --check-index`), gate('flat', 'node scripts/check-docs-size.mjs --check')];

  for (const [what, defect, path, options = {}] of CASES) {
    it(`${what}: every matched gate is kept as declared and named with ${path}`, options, async () => {
      const [root, twin] = [currentProject(), currentProject()];
      const control = await answered([gates[0]], root);
      assert.deepEqual(control.switched.map(({ id }) => id), ['docs'], 'a current kit folder switches the deployed target');
      defect(root, twin);
      const result = await answered(gates, root);
      assert.deepEqual(result.gates, gates);
      assert.deepEqual([result.switched, result.repoints], [[], []], 'no switch and no repoint while the kit folder is not current');
      assert.deepEqual(result.withheld, [{ id: 'docs', path }, { id: 'flat', path }]);
    });
  }

  it('only run.mjs, the docs-size module and its imports switch docs-size while an archive gate is withheld', async () => {
    const root = currentProject();
    for (const module of ['archives', 'git-hooks']) rmSync(at(root, `${KIT}/${module}`), { recursive: true });
    const docs = gates[0];
    const archive = gate('archive', `node ${KIT}/archives/archive-issues.mjs --check`);
    const result = await answered([docs, archive], root);
    assert.deepEqual(result.switched, [{ id: docs.id, cmd: `${COMMAND} docs-size --check-index`, was: docs.cmd }]);
    assert.deepEqual(result.gates, [{ ...docs, cmd: `${COMMAND} docs-size --check-index` }, archive]);
    assert.deepEqual(result.repoints, []);
    assert.equal(result.withheld.length, 1);
    assert.equal(result.withheld[0].id, archive.id);
    assert.ok(result.withheld[0].path.startsWith(`${KIT}/archives`));
    const kept = await answered([gate('elsewhere', 'node scripts/elsewhere/check-docs-size.mjs')], root);
    assert.deepEqual(kept.repoints, [{ id: 'elsewhere', repoint: `${COMMAND} docs-size` }]);
  });

  it('the migration prints one warning line per matched gate naming that path, no SWITCH and no REPOINT, in the preview and after --apply', async () => {
    const { main } = await import('./migrate-gates.mjs');
    const root = currentProject();
    const kitTools = mkdtempSync(join(tmpdir(), 'kit-command-gates-tools-'));
    temps.push(kitTools);
    writeFileSync(join(kitTools, 'coverage-check.mjs'), '// the installed checker\n');
    mkdirSync(at(root, 'docs/ai'), { recursive: true });
    const declared = `${JSON.stringify({ gates: [...gates, gate('lint', 'npm run lint')] }, null, 2)}\n`;
    writeFileSync(at(root, 'docs/ai/gates.json'), declared);
    edit(`${KIT}/shared/project-root.mjs`)(root);
    for (const tail of [[], ['--apply']]) {
      const out = [];
      const io = { log: (line) => out.push(String(line)), error: (line) => out.push(String(line)) };
      assert.equal(main(['--cwd', root, '--kit-tools', kitTools, ...tail], io), 0);
      const lines = out.join('\n').split('\n');
      const warned = lines.filter((line) => line.includes('runs a kit check, but the kit folder is not current'));
      assert.deepEqual(warned.map((line) => line.trim().split(' ')[1]), ['docs', 'flat'], `${tail}: one line per matched gate\n${out.join('\n')}`);
      for (const line of warned) assert.ok(line.includes(`(${KIT}/shared/project-root.mjs)`), line);
      assert.deepEqual(lines.filter((line) => /^\s*(SWITCH|REPOINT)\b/.test(line)), [], `${tail}: no SWITCH and no REPOINT line`);
      assert.equal(readFileSync(at(root, 'docs/ai/gates.json'), 'utf8'), declared, `${tail}: the declaration is unchanged`);
    }
  });
});

describe('spec:kit-command/S8 any other form is kept untouched and named once per whole target filename', () => {
  it('another form, an absolute path, a non-flag argument or an inadmissible token, a compound line, bare or quoted, and the command beside an old path', async () => {
    const root = currentProject();
    const named = [
      [gate('absolute', `node ${root}/scripts/check-docs-size.mjs`), ['docs-size']],
      [gate('positional', 'node scripts/archive-changelog.mjs check'), ['archive-changelog']],
      [gate('inadmissible', 'node scripts/archive-issues.mjs --check$X'), ['archive-issues']],
      [gate('elsewhere', 'node scripts/archives/archive-decisions.mjs --check'), ['archive-decisions']],
      [gate('hooks', 'node ../scripts/git-hooks/install-git-hooks.mjs'), ['install-git-hooks']],
      [gate('compound', 'node scripts/check-docs-size.mjs && node scripts/archive-issues.mjs --check'), ['docs-size', 'archive-issues']],
      [gate('quoted', 'node "scripts/check-docs-size.mjs" --check-index && node "scripts/archive-changelog.mjs" --check'), ['docs-size', 'archive-changelog']],
      [gate('single-quoted', "node 'scripts/check-docs-size.mjs' && node 'scripts/archive-issues.mjs' --check"), ['docs-size', 'archive-issues']],
      [gate('twice', 'node scripts/check-docs-size.mjs && node scripts/check-docs-size.mjs --check-index'), ['docs-size', 'docs-size']],
      [gate('mixed', `${COMMAND} docs-size && node scripts/archive-decisions.mjs --check`), ['archive-decisions']],
    ];
    const silent = [
      gate('contains', 'node scripts/my-check-docs-size.mjs && node scripts/check-docs-size.mjs.bak'),
      gate('beneath', 'node scripts/check-docs-size.mjs/x.mjs'),
      gate('command', `${COMMAND} archive-issues --check`),
      gate('none', 'npm test'),
      gate('deployed', `node "${KIT}/${TARGETS['docs-size']}" check && node '${KIT}/${TARGETS['archive-issues']}' --check`),
      ...['a', '1', '.', '_', '-'].map((prefix) => gate(`prefix-${prefix}`, `node ${prefix}check-docs-size.mjs`)),
    ];
    const gates = [...named.map(([one]) => one), ...silent];
    const result = await answered(gates, root);
    assert.deepEqual([result.gates, result.switched, result.withheld], [gates, [], []], 'nothing is rewritten');
    assert.deepEqual(result.repoints, named.flatMap(([one, names]) => names.map((name) => ({ id: one.id, repoint: `${COMMAND} ${name}` }))));
  });
  for (const [form, cmd] of [
    [';', 'node scripts/check-docs-size.mjs;'], ['&&', 'node scripts/check-docs-size.mjs&&echo ok'],
    ['|', 'node scripts/check-docs-size.mjs|cat'], ['>', 'node scripts/check-docs-size.mjs>out'],
    [')', 'node scripts/check-docs-size.mjs)'], ['(', '(node scripts/check-docs-size.mjs)'],
  ]) {
    it(`a filename glued to ${form} is kept and gets its repoint`, async () => {
      const gates = [gate('glued', cmd)];
      const result = await answered(gates, currentProject());
      assert.deepEqual([result.gates, result.switched, result.withheld], [gates, [], []]);
      assert.deepEqual(result.repoints, [{ id: 'glued', repoint: `${COMMAND} docs-size` }]);
    });
  }
});
