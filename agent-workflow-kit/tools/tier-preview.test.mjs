import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITIES, SLOT_RECIPES, withVehicle } from './carriers.mjs';
import { TIER_TARGETS } from './reference-profile.mjs';
import { SEED_CONFIG, serializeConfig } from './orchestration-config.mjs';
import { composeReadiness, planRecipe, RECIPES } from './recipes.mjs';
import { failAt, makeProject, readinessOf, runOffer } from './tier-preview.test/harness.test.mjs';

const gaps = await import('./profile-gaps.mjs').catch(() => ({}));
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'tier-preview.mjs');
const LINEAGE = JSON.parse(readFileSync(join(HERE, '..', 'references', 'reference-profile.json'), 'utf8')).lineage;
const OTHER_LINEAGE = '2.0.0';
const CONFIG = 'docs/ai/orchestration.json';
const RECORD = 'docs/ai/profile-declines.json';
const STORE = 'docs/ai/epics';
const QUEUE = 'docs/plans/queue.md';
const IDS = ['epic-task-slots', 'epic-store-seeded', 'checker-gates-declared', 'named-queue-row-seed'];
const CHECKER_LINE = 'checker-gates-declared: undecidable — declaration-absent';
const WORDS = ['present', 'offered', 'declined', 'undecidable'];
const TARGETS = [['epic', 'author', ['subagent', 'solo']], ['epic', 'review', ['reviewed', 'solo']], ['task', 'author', ['subagent', 'solo']], ['task', 'execute', ['subagent', 'solo']]];
const SLOT_LINE_RE = /^ {2}([a-z-]+)\.([a-z]+) = ([a-z]+)((?: — [a-z]+ skipped: .+)*)$/;
const NONE_READY = {};
const ALL_READY = { codex: 'ready', agy: 'ready', executor: 'placed', author: 'placed' };
const seed = (extra = {}) => serializeConfig({ ...SEED_CONFIG, ...extra });
const record = (declined) => JSON.stringify({ schema: 1, declined }, null, 2) + '\n';
const EVERY_TARGET = { epic: { author: 'solo', review: 'solo' }, task: { author: 'solo', execute: 'solo' } };

// The kit's own rule, restated as the oracle: the first candidate planRecipe does not degrade wins.
const expectedSlot = (activity, slot, candidates, readinessDeps) => {
  const readiness = withVehicle(readinessDeps.detect(), readinessDeps.surveyVehicle());
  const skipped = [];
  for (const candidate of candidates) {
    const plan = planRecipe(candidate, readiness);
    if (!plan.degraded) return `  ${activity}.${slot} = ${candidate}${skipped.join('')}`;
    skipped.push(` — ${candidate} skipped: ${plan.degradation[0].reason}`);
  }
  throw new Error('no candidate resolved');
};
const entryLines = (lines) => lines.filter((line) => !line.startsWith(' '));
const entryOf = (lines, id) => entryLines(lines).find((line) => line.startsWith(`${id}: `));
const under = (lines, id) => {
  const start = lines.indexOf(entryOf(lines, id));
  assert.ok(start >= 0, `an entry line for ${id}`);
  const next = lines.findIndex((line, index) => index > start && !line.startsWith(' '));
  return lines.slice(start + 1, next < 0 ? lines.length : next);
};
const preview = async (options, readiness = NONE_READY) => {
  const { root } = makeProject(options);
  const run = await runOffer(root, [], readinessOf(readiness));
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.deepEqual(run.after, run.before, 'a preview writes zero bytes');
  return { root, run };
};
const bytesOf = (root, rel) => readFileSync(join(root, rel));
const childOf = (tree, name) => tree?.entries?.find(([entry]) => entry === name)?.[1] ?? null;
const configOf = (tree) => childOf(childOf(childOf(tree, 'docs'), 'ai'), 'orchestration.json');
const assertSkippedVehicle = (line, role, readiness) => {
  const vehicle = role === 'author' ? 'author' : 'executor';
  const parts = line.split(' — subagent skipped: ');
  assert.equal(parts.length, 2, line);
  const reason = parts[1];
  assert.ok(reason, line);
  assert.ok(reason.includes(`${vehicle} vehicle`), reason);
  assert.ok(!reason.includes(role === 'author' ? 'executor vehicle' : 'author vehicle'), reason);
  assert.ok(reason.includes('/agent-workflow-kit agents'), reason);
  const plan = planRecipe({ ...RECIPES.find((recipe) => recipe.id === 'subagent'), role }, readiness);
  assert.equal(reason, plan.degradation[0].reason);
};

describe('spec:tier-offer/S1 the frozen targets resolve by the kit\'s one rule', () => {
  for (const [name, readiness, authorValue] of [
    ['nothing ready', NONE_READY, 'solo'],
    ['every provider ready', ALL_READY, 'subagent'],
    ['only the review bridge ready and the executor placed', { agy: 'ready', executor: 'placed' }, 'solo'],
    ['the execute bridge ready and both vehicles missing', { codex: 'ready' }, 'solo'],
    ['the vehicles unusable', { codex: 'needs-credentials', agy: 'degraded', executor: 'unusable', author: 'unusable' }, 'solo'],
  ]) {
    it(`resolves every absent slot over ${name}`, async () => {
      const deps = readinessOf(readiness);
      const { run } = await preview({ files: { [CONFIG]: seed() } }, readiness);
      const [authorLine, ...rest] = under(run.lines, 'epic-task-slots').slice(1);
      assert.equal(authorLine.split(' — ')[0], `  epic.author = ${authorValue}`);
      if (authorValue === 'solo') assertSkippedVehicle(authorLine, 'author', composeReadiness('/nowhere', deps));
      else assert.equal(authorLine, '  epic.author = subagent');
      assert.deepEqual(rest, TARGETS.slice(1).map(([activity, slot, candidates]) => expectedSlot(activity, slot, candidates, deps)));
    });
  }

  for (const [name, readiness, expectedLines, expectedConfig] of [
    ['executor alone', { executor: 'placed', author: 'missing' },
      ['  epic.author = solo', '  epic.review = reviewed', '  task.author = subagent', '  task.execute = subagent'],
      { epic: { author: 'solo', review: 'reviewed' }, task: { author: 'subagent', execute: 'subagent' } }],
    ['author alone', { executor: 'missing', author: 'placed' },
      ['  epic.author = subagent', '  epic.review = reviewed', '  task.author = solo', '  task.execute = solo'],
      { epic: { author: 'subagent', review: 'reviewed' }, task: { author: 'solo', execute: 'solo' } }],
  ]) {
    it(`offers and writes the resolved literal values with the ${name}, regardless of ready bridges for tasks`, async () => {
      const allBridges = { ...readiness, codex: 'ready', agy: 'ready' };
      const { root, run } = await preview({ files: { [CONFIG]: seed() } }, allBridges);
      const lines = under(run.lines, 'epic-task-slots').slice(1);
      assert.deepEqual(lines.map((line) => line.split(' — ')[0]), expectedLines);
      const composed = composeReadiness('/nowhere', readinessOf(allBridges));
      if (readiness.author === 'missing') assertSkippedVehicle(lines[0], 'author', composed);
      else for (const line of lines.slice(2)) assertSkippedVehicle(line, 'carry', composed);
      const vehicleOnly = await preview({ files: { [CONFIG]: seed() } }, readiness);
      assert.deepEqual(under(vehicleOnly.run.lines, 'epic-task-slots').slice(3), lines.slice(2));
      const applied = await runOffer(root, ['--apply'], readinessOf(allBridges));
      assert.equal(applied.code, 0, applied.stderr);
      assert.equal(entryOf(applied.lines, 'epic-task-slots'), 'epic-task-slots: applied');
      assert.deepEqual(under(applied.lines, 'epic-task-slots'), lines);
      const config = JSON.parse(bytesOf(root, CONFIG).toString());
      assert.deepEqual({ epic: config.epic, task: config.task }, expectedConfig);
    });
  }

  it('prints the floor with every skipped reason when nothing is ready', async () => {
    const { run } = await preview({ files: { [CONFIG]: seed() } });
    const slots = under(run.lines, 'epic-task-slots').slice(1).map((line) => line.match(SLOT_LINE_RE));
    assert.deepEqual(slots.map((match) => match[3]), ['solo', 'solo', 'solo', 'solo']);
    assert.match(slots[0][4], /^ — subagent skipped: .*author vehicle.*\/agent-workflow-kit agents/);
    for (const match of slots.slice(2)) assert.match(match[4], /^ — subagent skipped: .*executor vehicle.*\/agent-workflow-kit agents/);
  });

  it('prints the first candidate of each slot when every provider is ready, no ready bridge changing a task value', async () => {
    const { run } = await preview({ files: { [CONFIG]: seed() } }, ALL_READY);
    assert.deepEqual(under(run.lines, 'epic-task-slots').slice(1),
      ['  epic.author = subagent', '  epic.review = reviewed', '  task.author = subagent', '  task.execute = subagent']);
    const vehicleOnly = await preview({ files: { [CONFIG]: seed() } }, { executor: 'placed' });
    assert.deepEqual(under(vehicleOnly.run.lines, 'epic-task-slots').slice(3), under(run.lines, 'epic-task-slots').slice(3));
  });

  it('prints only values the slot type admits', async () => {
    assert.ok(Object.isFrozen(TIER_TARGETS));
    assert.deepEqual(TIER_TARGETS.map(({ activity, slot, candidates }) => [activity, slot, candidates]), TARGETS);
    for (const target of TIER_TARGETS) {
      const { activity, slot, candidates } = target;
      assert.ok(Object.isFrozen(target) && Object.isFrozen(candidates));
      for (const candidate of candidates) assert.ok(SLOT_RECIPES[ACTIVITIES[activity].slots[slot]].includes(candidate));
      if (activity === 'task') assert.ok(!candidates.includes('delegated'));
    }
    for (const readiness of [NONE_READY, ALL_READY, { codex: 'ready' }]) {
      const { run } = await preview({ files: { [CONFIG]: seed() } }, readiness);
      for (const line of under(run.lines, 'epic-task-slots').slice(1)) {
        const [, activity, slot, value] = line.match(SLOT_LINE_RE);
        assert.ok(SLOT_RECIPES[ACTIVITIES[activity].slots[slot]].includes(value), line);
      }
    }
  });
});

describe('spec:tier-offer/S2 the preview is the default and writes zero bytes', () => {
  it('prints one line per registry entry in registry order, each offered entry with its apply line', async () => {
    const { root, run } = await preview({ files: { [CONFIG]: seed() } }, ALL_READY);
    assert.deepEqual(entryLines(run.lines), ['epic-task-slots: offered', 'epic-store-seeded: offered', CHECKER_LINE, 'named-queue-row-seed: offered']);
    assert.equal(typeof gaps.buildInsertPreview, 'function', 'profile-gaps.mjs buildInsertPreview is absent');
    const apply = `  apply: ${gaps.buildInsertPreview(root, TOOL)}`;
    assert.equal(under(run.lines, 'epic-task-slots')[0], apply);
    assert.deepEqual(under(run.lines, 'epic-store-seeded'), [apply]);
    assert.deepEqual(under(run.lines, 'named-queue-row-seed'), [apply]);
  });

  it('carries exactly one closed verdict word per entry line', async () => {
    const { run } = await preview({ files: { [CONFIG]: seed() } });
    const entries = entryLines(run.lines);
    assert.deepEqual(entries.map((line) => line.split(': ')[0]), IDS);
    for (const line of entries) assert.ok(WORDS.includes(line.split(': ')[1].split(' — ')[0]), line);
  });

  it('says no runnable command for a root carrying a backtick', async () => {
    const { run } = await preview({ name: `pro${String.fromCharCode(96)}ject`, files: { [CONFIG]: seed() } });
    assert.equal(under(run.lines, 'epic-store-seeded')[0],
      '  apply: no runnable command — the root or the kit path carries a control byte or a backtick');
  });
});

describe('spec:tier-offer/S3 never over a declared slot', () => {
  it('reports every slot present and never rewrites the config when all four are declared, a delegated task slot kept', async () => {
    const minified = JSON.stringify({ ...SEED_CONFIG, ...EVERY_TARGET, task: { author: 'delegated', execute: 'delegated' } });
    const { root } = makeProject({ files: { [CONFIG]: minified } });
    const run = await runOffer(root, ['--apply'], readinessOf(ALL_READY));
    assert.equal(run.code, 0, run.stderr);
    assert.equal(entryOf(run.lines, 'epic-task-slots'), 'epic-task-slots: present');
    assert.deepEqual(under(run.lines, 'epic-task-slots'), []);
    assert.equal(bytesOf(root, CONFIG).toString(), minified);
  });

  it('offers and writes only the two absent slots, a roster array kept, the file reformatted', async () => {
    const declared = { epic: { review: ['review-lens'] }, task: { author: 'solo' } };
    const minified = JSON.stringify({ ...SEED_CONFIG, ...declared });
    const { root, run } = await preview({ files: { [CONFIG]: minified } }, ALL_READY);
    assert.deepEqual(under(run.lines, 'epic-task-slots').slice(1),
      ['  epic.author = subagent', '  epic.review: present', '  task.author: present', '  task.execute = subagent']);
    const applied = await runOffer(root, ['--apply'], readinessOf(ALL_READY));
    assert.equal(applied.code, 0, applied.stderr);
    const expected = { ...SEED_CONFIG, epic: { review: ['review-lens'], author: 'subagent' }, task: { author: 'solo', execute: 'subagent' } };
    assert.equal(bytesOf(root, CONFIG).toString(), serializeConfig(expected));
  });
});

describe('spec:tier-offer/S7 a decline is current while its lineage is the shipped one', () => {
  it('reports a current decline, writes nothing for it on apply, and never re-records it', async () => {
    const declines = record({ 'epic-task-slots': LINEAGE });
    const { root, run } = await preview({ files: { [CONFIG]: seed(), [RECORD]: declines } });
    assert.equal(entryOf(run.lines, 'epic-task-slots'), `epic-task-slots: declined — at lineage ${LINEAGE}`);
    assert.deepEqual(under(run.lines, 'epic-task-slots'), []);
    const configBefore = bytesOf(root, CONFIG);
    const applied = await runOffer(root, ['--apply'], readinessOf(NONE_READY));
    assert.equal(applied.code, 0, applied.stderr);
    assert.deepEqual(bytesOf(root, CONFIG), configBefore);
    assert.deepEqual(bytesOf(root, RECORD).toString(), declines);
    const declined = await runOffer(root, ['--decline'], readinessOf(NONE_READY));
    assert.equal(declined.code, 0, declined.stderr);
    assert.deepEqual(bytesOf(root, RECORD).toString(), declines);
  });

  it('re-offers an item declined at another lineage', async () => {
    const { run } = await preview({ files: { [CONFIG]: seed(), [RECORD]: record({ 'epic-store-seeded': OTHER_LINEAGE }) } });
    assert.equal(entryOf(run.lines, 'epic-store-seeded'), 'epic-store-seeded: offered');
  });

  it('reports a present item present whatever the record holds', async () => {
    const declines = record({ 'epic-task-slots': LINEAGE, 'epic-store-seeded': LINEAGE });
    const { run } = await preview({ files: { [CONFIG]: seed(EVERY_TARGET), [STORE]: { kind: 'directory' }, [QUEUE]: '# Queue\n', [RECORD]: declines } });
    assert.deepEqual(entryLines(run.lines), ['epic-task-slots: present', 'epic-store-seeded: present', CHECKER_LINE, 'named-queue-row-seed: present']);
  });
});

describe('spec:tier-offer/S8 each config state answers by its one closed name', () => {
  const valid = seed();
  for (const [reason, files, extraDeps] of [
    ['config-absent', {}],
    ['config-symlink', { [CONFIG]: { kind: 'symlink', text: valid } }],
    ['config-unreadable', { [CONFIG]: { kind: 'directory' } }],
    ['config-unreadable', { [CONFIG]: valid }, (root) => failAt(root, 'readFileSync', CONFIG)],
    ['config-malformed', { [CONFIG]: '{ "plan-authoring": ' }],
    ['config-invalid', { [CONFIG]: JSON.stringify({ epic: { author: 'council' } }) }],
  ]) {
    it(`answers ${reason}${extraDeps ? ' for a failed read' : ''}, and still seeds an offered store`, async () => {
      const { root } = makeProject({ files });
      const deps = { ...readinessOf(ALL_READY), ...(extraDeps ? extraDeps(root) : {}) };
      const run = await runOffer(root, [], deps);
      assert.equal(run.code, 0, run.stderr);
      assert.equal(entryOf(run.lines, 'epic-task-slots'), `epic-task-slots: undecidable — ${reason}`);
      assert.deepEqual(under(run.lines, 'epic-task-slots'), []);
      assert.equal(entryOf(run.lines, 'epic-store-seeded'), 'epic-store-seeded: offered');
      const applied = await runOffer(root, ['--apply'], deps);
      assert.equal(applied.code, 0, applied.stderr);
      assert.equal(entryOf(applied.lines, 'epic-store-seeded'), 'epic-store-seeded: applied');
      assert.deepEqual(configOf(applied.after), configOf(applied.before), 'the config is never written');
    });
  }

  it('treats every bridge as not ready on a detection failure and names it once', async () => {
    const readiness = { executor: 'placed', detectError: 'detector exploded' };
    const { run } = await preview({ files: { [CONFIG]: seed() } }, readiness);
    assert.equal(run.lines.filter((line) => line.includes('detector exploded')).length, 1);
    const survey = readinessOf(readiness).surveyVehicle;
    const deps = { ...readinessOf(readiness), detect: () => [], surveyVehicle: survey };
    const [authorLine, ...rest] = under(run.lines, 'epic-task-slots').slice(1);
    assert.match(authorLine, /^  epic\.author = solo — subagent skipped: /);
    assertSkippedVehicle(authorLine, 'author', composeReadiness('/nowhere', deps));
    assert.deepEqual(rest, TARGETS.slice(1).map(([activity, slot, candidates]) => expectedSlot(activity, slot, candidates, deps)));
  });
});

describe('spec:tier-offer/S9 each store state', () => {
  for (const [name, spec, expected, extraDeps] of [
    ['absent', undefined, 'epic-store-seeded: offered'],
    ['an empty directory', { kind: 'directory' }, 'epic-store-seeded: present'],
    ['a directory holding .gitkeep', { kind: 'directory', entries: ['.gitkeep'] }, 'epic-store-seeded: present'],
    ['a regular file', 'not a directory', 'epic-store-seeded: undecidable — store-not-directory'],
    ['a symlink', { kind: 'symlink', text: '' }, 'epic-store-seeded: undecidable — store-symlink'],
    ['refused at lstat', { kind: 'directory' }, 'epic-store-seeded: undecidable — store-unreadable', (root) => failAt(root, 'lstatSync', STORE)],
  ]) {
    it(`answers a store that is ${name}`, async () => {
      const { root } = makeProject({ files: { [CONFIG]: seed(EVERY_TARGET), [STORE]: spec } });
      const run = await runOffer(root, [], { ...readinessOf(NONE_READY), ...(extraDeps ? extraDeps(root) : {}) });
      assert.equal(run.code, 0, run.stderr);
      assert.equal(entryOf(run.lines, 'epic-store-seeded'), expected);
      assert.deepEqual(run.after, run.before);
    });
  }
});
