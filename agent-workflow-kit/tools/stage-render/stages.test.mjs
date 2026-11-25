import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { ENGINE_ENV, PROCEDURES_FRAGMENT_REL, readEngineFragment, resolveEngineDir } from '../engine-source.mjs';
import { stripGitLocationEnv } from '../git-env.mjs';
import { PLANS_REL } from '../plan-files.mjs';
import { extractSection } from '../procedures.mjs';
import { makeTree, write, writeJson } from '../plan-shape-harness.test.mjs';

const KIT = resolve(import.meta.dirname, '../..');
const ENGINE = resolve(KIT, '../agent-workflow-engine');
const TABLE = new URL('./stages.json', import.meta.url);
const SLOT = `${PLANS_REL}/next-session.json`;
const PLAN = `${PLANS_REL}/guide.md`;
const EPIC = 'docs/ai/epics/GUIDE.md';
const NOTES = `${PLANS_REL}/notes.md`;
const GATED = ['tests', 'code', 'diff-review', 'split-edits'];
const address = (activity, from, to = from, part = null) => ({ activity, part, from, to });
const ADDRESSES = {
  epic: [address('epic', 1, 6)],
  'design-consult': [address('epic', 1, 4, 'Design consult')],
  'spec-and-plan': [address('plan-authoring', 1, 5)],
  'waiting-on-approval': [address('plan-authoring', 6)],
  tests: [address('plan-execution', 1, 4)],
  code: [address('plan-execution', 1, 4)],
  'diff-review': [address('plan-execution', 5, 8)],
  'split-modules': [address('plan-execution', 1, 2, 'Split')],
  'split-edits': [address('plan-execution', 3, 4, 'Split')],
  pause: [],
  'empty-queue': [],
};
const IDS = Object.keys(ADDRESSES);
const fixture = () => ({
  schema: 1,
  stages: Object.fromEntries(Object.entries(ADDRESSES).map(([id, steps]) => [id, {
    goal: 'Keep the guide current.', steps: structuredClone(steps), doNot: ['Publish.'],
    output: 'A guide.', done: 'The guide is current.', next: IDS.slice(),
    slots: GATED.includes(id) ? { plan: 'plan' } : {},
  }])),
});
const loadRealTable = (loadStages) => loadStages(fs.readFileSync(TABLE, 'utf8'));
const readCanon = () => {
  const { dir, source } = resolveEngineDir({ env: { [ENGINE_ENV]: ENGINE } });
  return readEngineFragment(dir, { source, rel: PROCEDURES_FRAGMENT_REL });
};
const makeRoot = (t, prefix) => {
  const root = makeTree(prefix);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
const writeSlot = (root, stage, table) => {
  write(root, PLAN, '# Guide\n');
  write(root, EPIC, '# Epic: Guide\n');
  write(root, NOTES, '## Decisions\nKeep the scope.\n');
  const values = { plan: PLAN, epic: EPIC, story: 'S1', 'queue-row': 'GUIDE', file: NOTES, decisions: [{ path: NOTES, heading: 'Decisions' }] };
  const slots = Object.fromEntries(Object.entries(table.stages[stage].slots).map(([name, kind]) => [name, values[kind]]));
  writeJson(root, SLOT, { schema: 1, stage, date: '2026-11-25', ...slots });
};
const run = (root, engine = ENGINE, kit = KIT) => {
  const env = stripGitLocationEnv(process.env);
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [join(kit, 'tools/stage-render/cli.mjs'), SLOT],
    { cwd: root, env: { ...env, [ENGINE_ENV]: engine }, encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
};
const expectCannotRender = (result, name, stage, table, fixedLines) => {
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.ok(output.includes(name), output);
  assert.match(output, /upgrade/i);
  for (const fragment of [...fixedLines, table.stages[stage].goal]) assert.ok(!output.includes(fragment), output);
};
const makeEngine = (t, canon) => {
  const engine = makeRoot(t, 'stage-render-engine');
  for (const file of ['capability.json', 'SKILL.md']) fs.copyFileSync(join(ENGINE, file), join(engine, file));
  if (canon === undefined) fs.mkdirSync(join(engine, PROCEDURES_FRAGMENT_REL), { recursive: true });
  else write(engine, PROCEDURES_FRAGMENT_REL, canon);
  return engine;
};

describe('spec:stage-render/S5 strict stage table and live engine addresses', () => {
  it('loads only the eleven stage ids, exact keys and addresses and pins the four gated stages', async () => {
    const { loadStages, RECORD_GATED_STAGES, STAGES_REL } = await import('./index.mjs');
    const table = loadRealTable(loadStages);
    assert.equal(resolve(KIT, STAGES_REL), fs.realpathSync(TABLE));
    assert.deepEqual(Object.keys(table).sort(), ['schema', 'stages']);
    assert.equal(table.schema, 1);
    assert.deepEqual(Object.keys(table.stages).sort(), IDS.slice().sort());
    assert.deepEqual([...RECORD_GATED_STAGES].sort(), GATED.slice().sort());
    for (const [id, entry] of Object.entries(table.stages)) {
      assert.deepEqual(Object.keys(entry).sort(), ['doNot', 'done', 'goal', 'next', 'output', 'slots', 'steps']);
      assert.deepEqual(entry.steps, ADDRESSES[id], id);
      if (GATED.includes(id)) assert.ok(Object.values(entry.slots).includes('plan'), id);
      assert.ok(entry.next.every((next) => IDS.includes(next)), id);
    }
    for (const id of ['pause', 'empty-queue']) {
      assert.deepEqual(table.stages[id].next.slice().sort(), IDS.slice().sort());
      assert.match(table.stages[id].goal, /wait/i);
    }
    const split = table.stages['split-edits'].doNot.join('\n');
    assert.match(split, /new logic/i);
    assert.match(split, /new (?:test )?case/i);
    for (const key of ['goal', 'doNot', 'output', 'done']) assert.notDeepEqual(table.stages.tests[key], table.stages.code[key], key);
  });

  for (const id of IDS) {
    it(`resolves ${id} against the sibling engine override`, async () => {
      const { loadStages, stepsOf } = await import('./index.mjs');
      const entry = loadRealTable(loadStages).stages[id];
      const canon = readCanon();
      assert.deepEqual(entry.steps, ADDRESSES[id]);
      for (const step of entry.steps) {
        const items = stepsOf(canon, step);
        const [section, ...parts] = extractSection(canon, step.activity).split(/^### /m);
        const part = step.part === null ? section : parts.find((text) => text.startsWith(step.part + '\n'));
        assert.ok(part, `${step.activity}: ${step.part}`);
        assert.deepEqual(items.map((item) => Number(/^(\d+)\. /.exec(item)?.[1])),
          Array.from({ length: step.to - step.from + 1 }, (_, index) => step.from + index));
        for (const item of items) assert.ok(part.includes(item), item);
      }
    });
  }

  it('refuses unknown, missing, repeated and mistyped keys throughout the strict table', async () => {
    const { loadStages } = await import('./index.mjs');
    const valid = fixture();
    assert.deepEqual(loadStages(JSON.stringify(valid)), valid);
    const cases = [
      ['schema', (table) => { table.schema = 2; }],
      ['schema', (table) => { delete table.schema; }],
      ['stages', (table) => { table.stages = []; }],
      ['extra', (table) => { table.extra = true; }],
      ['epic', (table) => { delete table.stages.epic; }],
      ['unknown', (table) => { table.stages.unknown = table.stages.epic; }],
      ['gated', (table) => { table.stages.tests.gated = true; }],
      ['plan', (table) => { table.stages.tests.slots = {}; }],
      ['plan', (table) => { delete table.stages.code.slots.plan; }],
      ['goal', (table) => { delete table.stages.epic.goal; }],
      ['goal', (table) => { table.stages.epic.goal = ['Goal']; }],
      ['doNot', (table) => { table.stages.epic.doNot = 'Publish.'; }],
      ['output', (table) => { table.stages.epic.output = null; }],
      ['done', (table) => { table.stages.epic.done = false; }],
      ['next', (table) => { table.stages.epic.next = 'pause'; }],
      ['unknown', (table) => { table.stages.epic.next = ['unknown']; }],
      ['slots', (table) => { table.stages.epic.slots = []; }],
      ['file', (table) => { table.stages.epic.slots = { file: 'free-text' }; }],
      ['steps', (table) => { table.stages.epic.steps = {}; }],
      ['activity', (table) => { delete table.stages.epic.steps[0].activity; }],
      ['part', (table) => { table.stages.epic.steps[0].part = 1; }],
      ['from', (table) => { table.stages.epic.steps[0].from = '1'; }],
      ['to', (table) => { table.stages.epic.steps[0].to = 0; }],
      ['extra', (table) => { table.stages.epic.steps[0].extra = true; }],
    ];
    for (const [name, mutate] of cases) {
      const table = fixture();
      mutate(table);
      assert.throws(() => loadStages(JSON.stringify(table)), new RegExp(name), JSON.stringify(table));
    }
    const raw = JSON.stringify(valid);
    for (const [name, duplicate] of [
      ['schema', raw.replace('"schema":1', '"schema":1,"schema":1')],
      ['epic', raw.replace('"epic":', `"epic":${JSON.stringify(valid.stages.epic)},"epic":`)],
      ['goal', raw.replace('"goal":', '"goal":"Repeated.","goal":')],
      ['part', raw.replace('"part":null', '"part":null,"part":null')],
      ['plan', raw.replace('"plan":"plan"', '"plan":"plan","plan":"plan"')],
    ]) assert.throws(() => loadStages(duplicate), new RegExp(name));
  });

  it('names the absent engine section, part and step and an unreadable engine at exit 2 without a template', async (t) => {
    const { loadStages, FIXED_LINES } = await import('./index.mjs');
    const table = loadRealTable(loadStages);
    const canon = readCanon();
    const root = makeRoot(t, 'stage-render-refusal');
    for (const [stage, malformed, name] of [
      ['epic', canon.replace(/^## epic$/m, '## other'), 'epic'],
      ['design-consult', canon.replace(/^### Design consult$/m, '### Other'), 'Design consult'],
      ['epic', canon.replace(/^6\. \*\*Land\*\*/m, '9. **Land**'), '6'],
      ['epic', undefined, PROCEDURES_FRAGMENT_REL],
    ]) {
      const engine = makeEngine(t, malformed);
      writeSlot(root, stage, table);
      expectCannotRender(run(root, engine), name, stage, table, FIXED_LINES);
    }
  });

  it('refuses a defect in an unselected stage before printing any template at exit 2', async (t) => {
    const { loadStages, FIXED_LINES } = await import('./index.mjs');
    const table = loadRealTable(loadStages);
    const root = makeRoot(t, 'stage-render-table-refusal');
    const kit = join(root, 'kit');
    fs.cpSync(KIT, kit, { recursive: true });
    const stage = 'pause';
    writeSlot(root, stage, table);
    const broken = structuredClone(table);
    broken.stages.tests.gated = true;
    writeJson(kit, 'tools/stage-render/stages.json', broken);
    expectCannotRender(run(root, ENGINE, kit), 'gated', stage, table, FIXED_LINES);
  });
});
