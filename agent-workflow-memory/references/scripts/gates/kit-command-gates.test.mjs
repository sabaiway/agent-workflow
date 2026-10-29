// kit-command-gates.test.mjs — the gate migration's reading of a kit-check gate (spec kit-command S6-S8), on temp
// projects whose kit folder is a copy of this tree's deployed entries. planKitCommandGates(gates, projectDir,
// kitScripts) answers { gates, switched, withheld, repoints }: the resulting gates, each switch as { id, cmd, was },
// each gate kept for a kit folder that is not current as { id, path } (the first failing path, relative to the
// project, POSIX), and each repoint line as { id, repoint }. It never changes the gates it is given.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, appendFileSync, writeFileSync, readFileSync, chmodSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFamily } from '../family.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TREE = dirname(HERE);
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

// A project whose kit folder holds every deployed entry of the manifest, byte-equal to this tree's.
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
const answered = async (gates, root, kitScripts = []) => {
  const given = structuredClone(gates);
  const result = await plan(gates, root, kitScripts);
  assert.deepEqual(gates, given, 'the gates given are never changed');
  return result;
};

describe('spec:kit-command/S6 a matched gate over a current kit folder is switched to the command', () => {
  it('the deployed target or a flat file named by --kit-script, bare, ./ or double-quoted, with zero or more -- flags', async () => {
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
    const result = await answered(gates, root, Object.keys(TARGETS).map(flatOf));
    assert.deepEqual(result.gates, expected, 'each keeps its id, every other field and its place');
    assert.deepEqual(result.switched, switched);
    assert.deepEqual([result.withheld, result.repoints], [[], []]);
  });

  it('a flat gate not named by --kit-script is untouched and gets its repoint line, beside a named one that switches', async () => {
    const root = currentProject();
    const gates = [gate('docs', 'node scripts/check-docs-size.mjs --check-index'), gate('issues', 'node scripts/archive-issues.mjs --check')];
    const alone = await answered(gates, root);
    assert.deepEqual([alone.gates, alone.switched, alone.withheld], [gates, [], []]);
    assert.deepEqual(alone.repoints, [{ id: 'docs', repoint: `${COMMAND} docs-size` }, { id: 'issues', repoint: `${COMMAND} archive-issues` }]);
    const named = await answered(gates, root, ['scripts/check-docs-size.mjs']);
    assert.deepEqual(named.gates, [{ ...gates[0], cmd: `${COMMAND} docs-size --check-index` }, gates[1]]);
    assert.deepEqual(named.switched, [{ id: 'docs', cmd: `${COMMAND} docs-size --check-index`, was: gates[0].cmd }]);
    assert.deepEqual(named.repoints, [{ id: 'issues', repoint: `${COMMAND} archive-issues` }]);
  });
});

describe('spec:kit-command/S7 a kit folder that is not current switches nothing and repoints nothing', () => {
  // [the case, the one defect laid on a current project (given an identical current project elsewhere), the path named]
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
    ['a deployed entry the target does not load not byte-equal', edit(`${KIT}/archives/archive-caps.mjs`), `${KIT}/archives/archive-caps.mjs`],
    ['a deployed entry that cannot be read', unreadable(`${KIT}/shared/project-root.mjs`), `${KIT}/shared/project-root.mjs`, PERMISSION_CASE],
  ];
  const gates = [
    gate('docs', `node ${KIT}/docs-size/check-docs-size.mjs --check-index`),
    gate('flat', 'node scripts/archive-changelog.mjs --check'),
    gate('other', 'node scripts/archives/archive-issues.mjs --check'),
  ];

  for (const [what, defect, path, options = {}] of CASES) {
    it(`${what}: every matched gate is kept as declared and named with ${path}`, options, async () => {
      const [root, twin] = [currentProject(), currentProject()];
      const control = await answered(gates, root, ['scripts/archive-changelog.mjs']);
      assert.deepEqual(control.switched.map(({ id }) => id), ['docs', 'flat'], 'the positive control: a current kit folder switches both');
      defect(root, twin);
      const result = await answered(gates, root, ['scripts/archive-changelog.mjs']);
      assert.deepEqual(result.gates, gates);
      assert.deepEqual([result.switched, result.repoints], [[], []], 'no switch and no repoint while the kit folder is not current');
      assert.deepEqual(result.withheld, [{ id: 'docs', path }, { id: 'flat', path }]);
    });
  }

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
      assert.equal(main(['--cwd', root, '--kit-tools', kitTools, '--kit-script', 'scripts/archive-changelog.mjs', ...tail], io), 0);
      const lines = out.join('\n').split('\n');
      const warned = lines.filter((line) => line.includes('runs a kit check, but the kit folder is not current'));
      assert.deepEqual(warned.map((line) => line.trim().split(' ')[1]), ['docs', 'flat'], `${tail}: one line per matched gate\n${out.join('\n')}`);
      for (const line of warned) assert.ok(line.includes(`(${KIT}/shared/project-root.mjs)`), line);
      assert.deepEqual(lines.filter((line) => /^\s*(SWITCH|REPOINT)\b/.test(line)), [], `${tail}: no SWITCH and no REPOINT line`);
      assert.equal(readFileSync(at(root, 'docs/ai/gates.json'), 'utf8'), declared, `${tail}: the declaration is unchanged`);
    }
  });
});

describe('spec:kit-command/S8 any other form is kept untouched and named once per path token of a target', () => {
  it('another form, an absolute path, a non-flag argument or an inadmissible token, a compound line, bare or quoted, and the command beside an old path', async () => {
    const root = currentProject();
    const named = [
      [gate('absolute', `node ${root}/${KIT}/docs-size/check-docs-size.mjs`), ['docs-size']],
      [gate('positional', `node ${KIT}/archives/archive-changelog.mjs check`), ['archive-changelog']],
      [gate('inadmissible', `node ${KIT}/archives/archive-issues.mjs --check$X`), ['archive-issues']],
      [gate('elsewhere', 'node scripts/archives/archive-decisions.mjs --check'), ['archive-decisions']],
      [gate('hooks', 'node ../scripts/agent-workflow/git-hooks/install-git-hooks.mjs'), ['install-git-hooks']],
      [gate('compound', 'node scripts/check-docs-size.mjs && node scripts/archive-issues.mjs --check'), ['docs-size', 'archive-issues']],
      [gate('quoted', `node "scripts/check-docs-size.mjs" --check-index && node "${KIT}/archives/archive-changelog.mjs" --check`), ['docs-size', 'archive-changelog']],
      [gate('mixed', `${COMMAND} docs-size && node scripts/archive-decisions.mjs --check`), ['archive-decisions']],
    ];
    const silent = [
      gate('contains', 'node scripts/my-check-docs-size.mjs && node scripts/check-docs-size.mjs.bak'),
      gate('beneath', 'node scripts/check-docs-size.mjs/x.mjs'),
      gate('command', `${COMMAND} archive-issues --check`),
      gate('none', 'npm test'),
    ];
    const gates = [...named.map(([one]) => one), ...silent];
    const result = await answered(gates, root, Object.keys(TARGETS).map(flatOf));
    assert.deepEqual([result.gates, result.switched, result.withheld], [gates, [], []], 'nothing is rewritten');
    assert.deepEqual(result.repoints, named.flatMap(([one, names]) => names.map((name) => ({ id: one.id, repoint: `${COMMAND} ${name}` }))));
  });
});
