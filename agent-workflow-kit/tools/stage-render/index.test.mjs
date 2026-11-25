import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ENGINE_ENV, PROCEDURES_FRAGMENT_REL, readEngineFragment, resolveEngineDir } from '../engine-source.mjs';
import { PLANS_REL } from '../plan-files.mjs';
import { extractSection } from '../procedures.mjs';
import { isSeedablePathToken, shellQuoteArg } from '../repo-lex.mjs';
import { makeTree, write } from '../plan-shape-harness.test.mjs';

const DOOR = new URL('./index.mjs', import.meta.url);
const KIT = resolve(import.meta.dirname, '../..');
const ENGINE = resolve(KIT, '../agent-workflow-engine');
const SLOT = `${PLANS_REL}/next-session.json`;
const PLAN = `${PLANS_REL}/guide.md`;
const EPIC = 'docs/ai/epics/GUIDE.md';
const NOTES = `${PLANS_REL}/notes.md`;
const DATE = '2026-11-25';
const VALUES = {
  plan: PLAN, epic: EPIC, story: 'S1', 'queue-row': 'GUIDE-1', file: NOTES,
  decisions: [{ path: NOTES, heading: 'Decisions' }],
};
const SLOT_KINDS = Object.fromEntries(Object.keys(VALUES).map((kind) => [kind, kind]));
const UNGATED = ['epic', 'design-consult', 'spec-and-plan', 'waiting-on-approval', 'split-modules', 'pause', 'empty-queue'];
const NO_CODE = UNGATED.slice(0, 5);
const makeRoot = (t) => {
  const root = makeTree('stage-render-door');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, PLAN, '# Guide\n');
  write(root, EPIC, '# Epic: Guide\n');
  write(root, NOTES, '## Decisions\nKeep the scope.\n');
  return root;
};
const reads = { readFileSync: fs.readFileSync, lstatSync: fs.lstatSync, statSync: fs.statSync, realpathSync: fs.realpathSync, existsSync: fs.existsSync };
const withInjectedReads = (t, operation) => {
  const effects = [];
  const forbid = (name) => () => { effects.push(name); throw new Error(name); };
  for (const name of ['readFileSync', 'lstatSync', 'statSync', 'realpathSync', 'existsSync', 'readdirSync',
    'writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'rmSync']) t.mock.method(fs, name, forbid(name));
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) t.mock.method(childProcess, name, forbid(name));
  syncBuiltinESMExports();
  try {
    return operation();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.deepEqual(effects, []);
  }
};
const getSlots = (stage, kinds) => ({
  schema: 1, stage, date: DATE,
  ...Object.fromEntries(Object.entries(kinds).map(([name, kind]) => [name, VALUES[kind]])),
});
const expectedSteps = (canon, { activity, part, from, to }) => {
  const section = extractSection(canon, activity);
  const [whole, ...parts] = section.split(/^### /m);
  const text = part === null ? whole : parts.find((body) => body.startsWith(part + '\n'));
  assert.ok(text, `${activity}: missing part ${part}`);
  const items = [...text.matchAll(/^(\d+)\. [^\n]*(?:\n(?:[ \t]+[^\n]*|(?=\n[ \t])))*$/gm)]
    .filter(([, number]) => Number(number) >= from && Number(number) <= to);
  assert.deepEqual(items.map(([, number]) => Number(number)), Array.from({ length: to - from + 1 }, (_, index) => from + index));
  return items.map(([item]) => item);
};

it('spec:stage-render/S1 exports the read-only door and reuses the owning modules without import effects', async (t) => {
  const source = fs.readFileSync(DOOR, 'utf8');
  const imports = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)];
  for (const [name, owner] of [
    ['PLANS_REL', '../plan-files.mjs'], ['shellQuoteArg', '../repo-lex.mjs'],
    ['isSeedablePathToken', '../repo-lex.mjs'], ['extractSection', '../procedures.mjs'],
    ['findMatch', '../plan-approval/index.mjs'],
  ]) assert.ok(imports.some(([, names, path]) => path === owner && new RegExp(`\\b${name}\\b`).test(names)), name);
  const effects = [];
  const isLoaderRead = (stack) => /node:internal\/modules\//.test(stack)
    && !stack.split('\n').some((frame) => frame.includes('file://') && !frame.includes(import.meta.url));
  const forbid = (name, original = () => {}) => function (...args) {
    if (isLoaderRead(new Error().stack)) return original.apply(this, args);
    effects.push(name);
    throw new Error(name);
  };
  const forbidOn = (owner, name) => t.mock.method(owner, name, forbid(name, owner[name]));
  for (const name of ['readFileSync', 'readFile', 'openSync', 'open', 'readdirSync', 'readdir', 'statSync', 'lstatSync',
    'existsSync', 'writeFileSync', 'writeFile', 'appendFileSync', 'mkdirSync', 'renameSync', 'rmSync']) forbidOn(fs, name);
  for (const name of ['readFile', 'open', 'readdir', 'writeFile', 'appendFile', 'mkdir', 'rename', 'rm']) forbidOn(fs.promises, name);
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) forbidOn(childProcess, name);
  t.mock.method(process.stdout, 'write', forbid('stdout'));
  t.mock.method(process.stderr, 'write', forbid('stderr'));
  syncBuiltinESMExports();
  try {
    const door = await import(DOOR.href + '?effects');
    assert.deepEqual(Object.keys(door).sort(), [
      'FIXED_LINES', 'NEXT_SESSION_HEADING', 'RECORD_GATED_STAGES', 'STAGES_REL', 'composeDispatchPart',
      'composeRenderCommand', 'composeRenderLine', 'loadStages', 'renderStage', 'stepsOf', 'validateSlots',
    ]);
    assert.equal(door.NEXT_SESSION_HEADING, '## Next session');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(effects, []);
});

describe('spec:stage-render/S3 renders ungated stages verbatim without an approval record', () => {
  for (const stage of UNGATED) {
    it(stage, async (t) => {
      const { loadStages, renderStage, FIXED_LINES } = await import(DOOR.href);
      const root = makeRoot(t);
      const table = loadStages(fs.readFileSync(new URL('./stages.json', import.meta.url), 'utf8'));
      const entry = table.stages[stage];
      const slots = getSlots(stage, entry.slots);
      write(root, SLOT, JSON.stringify(slots));
      const { dir, source } = resolveEngineDir({ env: { [ENGINE_ENV]: ENGINE } });
      const canon = readEngineFragment(dir, { source, rel: PROCEDURES_FRAGMENT_REL });
      const rendered = withInjectedReads(t, () => renderStage({ root, slotFile: SLOT, slots, table, canon, match: null }, reads));
      assert.equal(typeof rendered, 'string');
      assert.equal(FIXED_LINES.length, 2);
      for (const line of FIXED_LINES) assert.ok(rendered.split('\n').includes(line), line);
      const [precedence, cannotProceed] = FIXED_LINES;
      for (const fact of [/slot/i, /file/i, /handover/i, /other|else/i, /stage/i, /report/i, /not follow|never follow|ignored|ignore|refus/i,
        /code/i, /test/i, /copy/i, /trial suite/i]) assert.match(precedence, fact);
      for (const fact of [/need/i, /maintainer/i, /council/i, /later stage/i, /not|never/i]) assert.match(cannotProceed, fact);
      const steps = entry.steps.flatMap((address) => expectedSteps(canon, address));
      const fragments = [...FIXED_LINES, entry.goal, ...steps, ...entry.doNot, entry.output, entry.done];
      const endOfDone = fragments.reduce((offset, fragment) => {
        const start = rendered.indexOf(fragment, offset);
        assert.ok(start >= offset, `missing or out of order: ${fragment}`);
        return start + fragment.length;
      }, 0);
      assert.match(rendered.split('\n')[0], new RegExp(stage.replaceAll('-', '[- ]'), 'i'));
      assert.deepEqual([...rendered.matchAll(/^\d+\. /gm)].map((match) => match[0]), steps.map((step) => /^\d+\. /.exec(step)[0]));
      const tail = rendered.slice(endOfDone);
      for (const value of Object.values(slots).slice(3)) {
        for (const item of Array.isArray(value) ? value.flatMap(({ path, heading }) => [path, heading]) : [value]) assert.ok(tail.includes(item), item);
      }
      for (const next of entry.next) assert.ok(tail.includes(next), next);
      assert.match(tail, /## Next session/);
      assert.match(tail, /--write/);
      assert.match(tail, /node <kit>\/tools\/stage-render\/cli\.mjs/);
      const kit = isSeedablePathToken(KIT) ? KIT : shellQuoteArg(KIT);
      assert.ok(tail.includes(`node ${kit}/tools/stage-render/cli.mjs`), tail);
      if (NO_CODE.includes(stage)) {
        for (const fact of [/writ[^\n]*code/i, /writ[^\n]*test/i, /cop[^\n]*tree/i, /trial suite/i]) assert.match(entry.doNot.join('\n'), fact);
      }
    });
  }
  it('the door itself refuses a record-gated stage given no matching approval, naming waiting-on-approval', async () => {
    const { loadStages, renderStage } = await import(DOOR.href);
    const table = loadStages(fs.readFileSync(new URL('./stages.json', import.meta.url), 'utf8'));
    const slots = { schema: 1, stage: 'tests', date: DATE, plan: PLAN };
    for (const match of [null, { exitCode: 1, verdict: { accepted: true, identity: PLAN }, match: null }]) {
      assert.throws(() => renderStage({ slotFile: SLOT, slots, table, canon: '', match }), /waiting-on-approval/);
    }
  });
});

describe('spec:stage-render/S11 validates the slot file and every declared kind', () => {
  const validate = async (t) => {
    const { loadStages, validateSlots } = await import(DOOR.href);
    const root = makeRoot(t);
    const realTable = loadStages(fs.readFileSync(new URL('./stages.json', import.meta.url), 'utf8'));
    const table = { ...realTable, stages: { ...realTable.stages, epic: { ...realTable.stages.epic, slots: SLOT_KINDS } } };
    const slots = getSlots('epic', SLOT_KINDS);
    const check = (value, path = SLOT, raw = JSON.stringify(value)) => {
      write(root, path, raw);
      return withInjectedReads(t, () => validateSlots({ root, slotFile: path, table }, reads));
    };
    return { root, slots, check, validateSlots, table };
  };
  it('accepts only the declared values and the directly placed regular UTF-8 JSON file', async (t) => {
    const { slots, check } = await validate(t);
    assert.deepEqual(check(slots), slots);
    assert.deepEqual(check({ ...slots, decisions: [] }), { ...slots, decisions: [] });
    assert.deepEqual(check({ ...slots, file: PLANS_REL }), { ...slots, file: PLANS_REL });
    for (const [raw, name] of [
      [JSON.stringify(slots).replace('"schema":1', '"schema":1,"schema":1'), 'schema'],
      [Buffer.from([0xff, 0xfe]), 'next-session.json'],
    ]) assert.throws(() => check(slots, SLOT, raw), new RegExp(name));
    assert.throws(() => check(slots, `${PLANS_REL}/nested/next-session.json`), /next-session\.json/);
    assert.throws(() => check(slots, `${PLANS_REL}/next-session.txt`), /next-session\.txt/);
    assert.throws(() => check(slots, `${PLANS_REL}/not a slug.json`), /not a slug\.json/);
  });
  it('names unknown, missing, mistyped and control-bearing fields', async (t) => {
    const { root, slots, check } = await validate(t);
    const fenced = `${PLANS_REL}/fenced.md`;
    write(root, fenced, '## Decisions\n```\nan unclosed fence\n');
    assert.throws(() => check({ ...slots, decisions: [{ path: fenced, heading: 'Decisions' }] }), /fenced\.md/);
    for (const name of Object.keys(slots)) {
      const missing = { ...slots };
      delete missing[name];
      assert.throws(() => check(missing), new RegExp(name));
    }
    for (const [patch, name] of [
      [{ extra: 'text' }, 'extra'], [{ schema: 2 }, 'schema'], [{ stage: 'unknown' }, 'unknown'],
      [{ date: '2026-02-30' }, 'date'], [{ plan: NOTES + '.txt' }, 'plan'], [{ epic: PLAN }, 'epic'],
      [{ story: 'S0' }, 'story'], [{ 'queue-row': 'lower-case' }, 'queue-row'], [{ file: 'missing.md' }, 'file'],
      [{ decisions: 'free text' }, 'decisions'], [{ decisions: [{ path: NOTES, heading: 'Decisions', extra: true }] }, 'extra'],
      [{ story: 'S1\u0001' }, 'story'], [{ decisions: [{ path: NOTES, heading: 'Decisions\n' }] }, 'heading'],
      [{ decisions: [{ path: NOTES, heading: 'Absent' }] }, 'Absent'],
    ]) assert.throws(() => check({ ...slots, ...patch }), new RegExp(name), JSON.stringify(patch));
    const gated = { schema: 1, stage: 'tests', date: DATE, plan: PLAN };
    assert.deepEqual(check(gated), gated);
    assert.throws(() => check({ ...gated, stage: ['tests'] }), /stage/);
  });
  it('refuses traversals, absolute paths and links even when their targets exist', async (t) => {
    const { root, slots, check, validateSlots, table } = await validate(t);
    const outside = makeTree('stage-render-outside');
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    write(outside, 'outside.md', '## Decisions\n');
    for (const file of [join(outside, 'outside.md'), `../${outside.split('/').at(-1)}/outside.md`]) {
      assert.throws(() => check({ ...slots, file }), /file/);
    }
    const linked = `${PLANS_REL}/linked.md`;
    fs.symlinkSync(join(root, PLAN), join(root, linked));
    assert.throws(() => check({ ...slots, plan: linked }), /linked\.md|plan/);
    fs.symlinkSync(join(root, PLANS_REL), join(root, 'linked'));
    assert.throws(() => check({ ...slots, file: 'linked/guide.md' }), /linked|file/);
    check(slots);
    const linkedSlot = `${PLANS_REL}/linked.json`;
    fs.symlinkSync(join(root, SLOT), join(root, linkedSlot));
    assert.throws(() => withInjectedReads(t, () => validateSlots({ root, slotFile: linkedSlot, table }, reads)), /linked\.json/);
  });
});

describe('spec:stage-render/S12 composes the portable line and location-specific command', () => {
  it('quotes the slot operand and refuses control bytes in both composers', async () => {
    const { composeRenderLine, composeRenderCommand } = await import(DOOR.href);
    for (const slot of [SLOT, `${PLANS_REL}/a b's.json`]) {
      const expected = 'node <kit>/tools/stage-render/cli.mjs ' + shellQuoteArg(slot);
      assert.equal(composeRenderLine(slot), expected);
      const kit = isSeedablePathToken(KIT) ? KIT : shellQuoteArg(KIT);
      assert.equal(composeRenderCommand(slot), expected.replace('<kit>', kit));
    }
    for (const byte of ['\n', '\r', '\u0001', '\u007f']) {
      assert.throws(() => composeRenderLine(SLOT + byte));
      assert.throws(() => composeRenderCommand(SLOT + byte));
    }
  });
  it('keeps the line byte-equal when the kit root requires quoting', async (t) => {
    const { composeRenderLine } = await import(DOOR.href);
    const scratch = makeTree('stage-render-relocated');
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const kit = join(scratch, "kit with space's");
    fs.cpSync(KIT, kit, { recursive: true });
    const relocated = await import(pathToFileURL(join(kit, 'tools/stage-render/index.mjs')).href);
    const expected = 'node <kit>/tools/stage-render/cli.mjs ' + shellQuoteArg(SLOT);
    assert.equal(composeRenderLine(SLOT), expected);
    assert.equal(relocated.composeRenderLine(SLOT), expected);
    assert.equal(isSeedablePathToken(kit), false);
    assert.equal(relocated.composeRenderCommand(SLOT), expected.replace('<kit>', shellQuoteArg(kit)));
  });
});
