import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITIES, SLOT_RECIPES, withVehicle } from './carriers.mjs';
import { SEED_CONFIG, serializeConfig } from './orchestration-config.mjs';
import { planRecipe } from './recipes.mjs';
import { buildInsertPreview } from './rules-regions.mjs';
import { failAt, makeProject, readinessOf, runOffer } from './tier-preview.test/harness.test.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'tier-preview.mjs');
const RULES_TOOL = join(HERE, 'rules-insert.mjs');
const LINEAGE = JSON.parse(readFileSync(join(HERE, '..', 'references', 'reference-profile.json'), 'utf8')).lineage;
const OTHER_LINEAGE = '2.0.0';
const CONFIG = 'docs/ai/orchestration.json';
const RECORD = 'docs/ai/profile-declines.json';
const STORE = 'docs/ai/epics';
const RULES = 'docs/ai/agent_rules.md';
const QUEUE = 'docs/plans/queue.md';
const IDS = ['story-sessions-section', 'epic-task-slots', 'epic-store-seeded', 'checker-gates-declared', 'session-close-rules',
  'named-queue-row-seed'];
const CHECKER_LINE = 'checker-gates-declared: undecidable — declaration-absent';
const WORDS = ['present', 'offered', 'declined', 'undecidable'];
const TARGETS = [['epic', 'author', ['subagent', 'solo']], ['epic', 'review', ['reviewed', 'solo']],
  ['task', 'author', ['delegated', 'subagent', 'solo']], ['task', 'execute', ['delegated', 'subagent', 'solo']]];
const SLOT_LINE_RE = /^ {2}([a-z-]+)\.([a-z]+) = ([a-z]+)((?: — [a-z]+ skipped: .+)*)$/;
const NONE_READY = {};
const ALL_READY = { codex: 'ready', agy: 'ready', executor: 'placed' };
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

describe('spec:tier-offer/S1 the frozen targets resolve by the kit\'s one rule', () => {
  for (const [name, readiness] of [
    ['nothing ready', NONE_READY],
    ['every provider ready', ALL_READY],
    ['only the review bridge ready and the vehicle placed', { agy: 'ready', executor: 'placed' }],
    ['the execute bridge ready and the vehicle missing', { codex: 'ready' }],
    ['the vehicle unusable', { codex: 'needs-credentials', agy: 'degraded', executor: 'unusable' }],
  ]) {
    it(`resolves every absent slot over ${name}`, async () => {
      const deps = readinessOf(readiness);
      const { run } = await preview({ files: { [CONFIG]: seed() } }, readiness);
      const expected = TARGETS.map(([activity, slot, candidates]) => expectedSlot(activity, slot, candidates, deps));
      assert.deepEqual(under(run.lines, 'epic-task-slots').slice(1), expected);
    });
  }

  it('prints the floor with every skipped reason when nothing is ready', async () => {
    const { run } = await preview({ files: { [CONFIG]: seed() } });
    const slots = under(run.lines, 'epic-task-slots').slice(1).map((line) => line.match(SLOT_LINE_RE));
    assert.deepEqual(slots.map((match) => match[3]), ['solo', 'solo', 'solo', 'solo']);
    assert.match(slots[0][4], /^ — subagent skipped: .*\/agent-workflow-kit agents/);
    assert.match(slots[2][4], /^ — delegated skipped: .+ — subagent skipped: .*\/agent-workflow-kit agents/);
  });

  it('prints the first candidate of each slot when every provider is ready', async () => {
    const { run } = await preview({ files: { [CONFIG]: seed() } }, ALL_READY);
    assert.deepEqual(under(run.lines, 'epic-task-slots').slice(1),
      ['  epic.author = subagent', '  epic.review = reviewed', '  task.author = delegated', '  task.execute = delegated']);
  });

  it('prints only values the slot type admits', async () => {
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
    assert.deepEqual(entryLines(run.lines), ['story-sessions-section: present', 'epic-task-slots: offered', 'epic-store-seeded: offered', CHECKER_LINE,
      'session-close-rules: present', 'named-queue-row-seed: offered']);
    const apply = `  apply: ${buildInsertPreview(root, TOOL)}`;
    assert.equal(under(run.lines, 'epic-task-slots')[0], apply);
    assert.deepEqual(under(run.lines, 'epic-store-seeded'), [apply]);
    assert.deepEqual(under(run.lines, 'named-queue-row-seed'), [apply]);
    assert.deepEqual(under(run.lines, 'session-close-rules'), []);
    assert.deepEqual(under(run.lines, 'story-sessions-section'), []);
  });

  it('follows an offered story-sessions entry with the insert preview', async () => {
    const rules = readFileSync(join(HERE, '..', 'references', 'templates', 'agent_rules.md'), 'utf8');
    const { root, run } = await preview({ files: { [CONFIG]: seed(EVERY_TARGET), [STORE]: { kind: 'directory' }, [QUEUE]: '# Queue\n',
      [RULES]: rules.replace(/### 2\.7\. Story sessions\n.*\n\n/, '') } });
    assert.deepEqual(run.lines, ['story-sessions-section: offered', `  apply: ${buildInsertPreview(root, RULES_TOOL)}`,
      'epic-task-slots: present', 'epic-store-seeded: present', CHECKER_LINE,
      'session-close-rules: undecidable — story-sessions-absent', 'named-queue-row-seed: present']);
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
  it('reports every slot present and never rewrites the config when all four are declared', async () => {
    const minified = JSON.stringify({ ...SEED_CONFIG, ...EVERY_TARGET });
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
      ['  epic.author = subagent', '  epic.review: present', '  task.author: present', '  task.execute = delegated']);
    const applied = await runOffer(root, ['--apply'], readinessOf(ALL_READY));
    assert.equal(applied.code, 0, applied.stderr);
    const expected = { ...SEED_CONFIG, epic: { review: ['review-lens'], author: 'subagent' }, task: { author: 'solo', execute: 'delegated' } };
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
    assert.deepEqual(entryLines(run.lines).slice(1), ['epic-task-slots: present', 'epic-store-seeded: present', CHECKER_LINE,
      'session-close-rules: present', 'named-queue-row-seed: present']);
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
    const deps = { detect: () => [], surveyVehicle: survey };
    assert.deepEqual(under(run.lines, 'epic-task-slots').slice(1),
      TARGETS.map(([activity, slot, candidates]) => expectedSlot(activity, slot, candidates, deps)));
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
