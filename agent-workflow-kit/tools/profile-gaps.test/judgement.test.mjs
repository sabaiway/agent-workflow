// judgement.test.mjs — the one verdict-and-decline judgement over the profile-gap registry and the offer
// that renders it (docs/ai/specs/kit/tier/gap-screen/, part profile-gaps-judgement). Red first: the module
// is imported dynamically; every fixture is built in its cell.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTCOME_LINES } from '../tier-preview.mjs';
import { makeProject, readinessOf, runOffer } from '../tier-preview.test/harness.test.mjs';

const loaded = await import('../profile-gaps.mjs').catch(() => ({}));
const TOOLS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OFFER_SOURCE = readFileSync(join(TOOLS, 'tier-preview.mjs'), 'utf8');
const TEMPLATE = readFileSync(join(TOOLS, '..', 'references', 'templates', 'agent_rules.md'), 'utf8');
const STORYLESS = TEMPLATE.replace('### 2.7. Story sessions', '### 2.7. Session notes');
const RULES = 'docs/ai/agent_rules.md';
const DECLINES = 'docs/ai/profile-declines.json';
const LINEAGE = '4.0.0';
const OTHER_LINEAGE = '3.0.0';
const SENTENCE = 'no runnable command — the root or the kit path carries a control byte or a backtick';
const STATES = { present: 'present', offered: 'offered', declined: 'declined', undecidable: 'undecidable' };
const IDS = ['story-sessions-section', 'epic-task-slots', 'epic-store-seeded', 'checker-gates-declared', 'session-close-rules', 'named-queue-row-seed'];
const EXPORTS = ['GAP_STATES', 'NO_COMMAND_SENTENCE', 'PROFILE_GAPS', 'STORY_REGION_ABSENT', 'judgeProfileGaps', 'readQueueSeed', 'readTierConfig'];
const MIXED = { 'docs/ai/orchestration.json': '{}\n', 'docs/ai/gates.json': '{"gates":[]}\n', 'docs/plans': 'not a directory' };

const judge = (options) => (loaded.judgeProfileGaps ?? (() => { throw new Error('judgeProfileGaps is absent'); }))(options);
const fsError = (code) => Object.assign(new Error(`${code}: injected`), { code });
// Real reads through deps, each path recorded; a path in `failing` throws EIO from readFileSync.
const observedDeps = (failing = []) => {
  const paths = [];
  const deps = {
    lstatSync: (path, ...rest) => { paths.push(path); return lstatSync(path, ...rest); },
    readFileSync: (path, ...rest) => {
      paths.push(path);
      if (failing.includes(path)) throw fsError('EIO');
      return readFileSync(path, ...rest);
    },
  };
  return { deps, paths };
};
const judgeIn = (files, declined, lineage = LINEAGE) => {
  const { root } = makeProject({ files });
  const { deps, paths } = observedDeps();
  const judged = judge({ root, deps, lineage, declined });
  assert.ok(Array.isArray(judged), 'the judgement answers an array synchronously');
  return { root, judged, paths };
};
const stateOf = (judged, id) => judged.find(({ entry }) => entry.id === id);
const flatten = (judged) => judged.map(({ entry, ...rest }) => ({ id: entry.id, ...rest }));

describe('spec:gap-screen/S1 the one judgement over the registry', () => {
  it('answers one element per registry entry, in registry order, carrying the entry itself', () => {
    const { judged } = judgeIn(MIXED, undefined);
    assert.equal(judged.length, IDS.length);
    judged.forEach(({ entry }, index) => assert.equal(entry, loaded.PROFILE_GAPS[index], IDS[index]));
    assert.deepEqual(judged.map(({ entry }) => entry.id), IDS);
  });

  it('answers each state with the strict key set: lineage only when declined, reason only when undecidable', () => {
    const declined = {
      'story-sessions-section': LINEAGE, 'epic-task-slots': OTHER_LINEAGE, 'epic-store-seeded': LINEAGE, 'named-queue-row-seed': LINEAGE,
    };
    const { judged } = judgeIn(MIXED, declined);
    assert.deepEqual(flatten(judged), [
      { id: 'story-sessions-section', state: 'present' },
      { id: 'epic-task-slots', state: 'offered' },
      { id: 'epic-store-seeded', state: 'declined', lineage: LINEAGE },
      { id: 'checker-gates-declared', state: 'offered' },
      { id: 'session-close-rules', state: 'present' },
      { id: 'named-queue-row-seed', state: 'undecidable', reason: 'plans-not-directory' },
    ]);
    const keySets = judged.map((item) => Object.keys(item).sort().join());
    assert.deepEqual(keySets, ['entry,state', 'entry,state', 'entry,lineage,state', 'entry,state', 'entry,state', 'entry,reason,state']);
  });

  for (const [name, declined, expected] of [
    ['an absent record', undefined, { state: 'offered' }],
    ['a current decline', { 'epic-store-seeded': LINEAGE }, { state: 'declined', lineage: LINEAGE }],
    ['a decline at another lineage', { 'epic-store-seeded': OTHER_LINEAGE }, { state: 'offered' }],
    ['a record that does not carry the id', { 'epic-task-slots': LINEAGE }, { state: 'offered' }],
    ['an empty record', {}, { state: 'offered' }],
  ]) {
    it(`answers ${expected.state} for an absent entry under ${name}`, () => {
      const { judged } = judgeIn(MIXED, declined);
      assert.deepEqual(flatten(judged).find(({ id }) => id === 'epic-store-seeded'), { id: 'epic-store-seeded', ...expected });
    });
  }

  it('answers present whatever the record holds, and a recorded lineage the given one does not match is offered', () => {
    const everything = Object.fromEntries(IDS.map((id) => [id, LINEAGE]));
    const { judged } = judgeIn({}, everything);
    assert.equal(stateOf(judged, 'session-close-rules').state, 'present');
    assert.equal(stateOf(judged, 'story-sessions-section').state, 'present');
    const later = judgeIn(MIXED, { 'epic-store-seeded': LINEAGE }, '5.0.0').judged;
    assert.equal(stateOf(later, 'epic-store-seeded').state, 'offered');
  });

  it('reads every detector read through deps and never reads the profile or the record itself', () => {
    const { root, paths } = judgeIn(MIXED, {});
    for (const rel of [RULES, 'docs/ai/orchestration.json', 'docs/ai/epics', 'docs/plans']) {
      assert.ok(paths.includes(resolve(root, rel)), rel);
    }
    assert.deepEqual(paths.filter((path) => path.endsWith(DECLINES) || path.endsWith('reference-profile.json')), []);
    const { root: failed } = makeProject({ files: MIXED });
    const { deps } = observedDeps([resolve(failed, RULES)]);
    const judged = judge({ root: failed, deps, lineage: LINEAGE, declined: undefined });
    assert.deepEqual(flatten(judged).filter(({ id }) => id.endsWith('-section') || id.endsWith('-rules')), [
      { id: 'story-sessions-section', state: 'undecidable', reason: 'file-unreadable' },
      { id: 'session-close-rules', state: 'undecidable', reason: 'file-unreadable' },
    ]);
  });

  it('exports the state table, the sentence and the story-region reason, and nothing else is added', () => {
    assert.deepEqual(Object.keys(loaded).sort(), EXPORTS);
    assert.ok(Object.isFrozen(loaded.GAP_STATES));
    assert.deepEqual({ ...loaded.GAP_STATES }, STATES);
    assert.equal(loaded.NO_COMMAND_SENTENCE, SENTENCE);
    const { judged } = judgeIn({ [RULES]: STORYLESS }, undefined);
    assert.equal(stateOf(judged, 'session-close-rules').reason, loaded.STORY_REGION_ABSENT);
    assert.equal(loaded.STORY_REGION_ABSENT, 'story-sessions-absent');
  });
});

describe('spec:gap-screen/S2 the offer renders the one judgement', () => {
  const entryLines = (lines) => lines.filter((line) => IDS.some((id) => line.startsWith(`${id}: `)));
  const expectedLines = (judged) => judged.map(({ entry, state, lineage, reason }) => {
    if (state === STATES.declined) return `${entry.id}: declined — ${OUTCOME_LINES.declinedAt(lineage)}`;
    return reason === undefined ? `${entry.id}: ${state}` : `${entry.id}: undecidable — ${reason}`;
  });

  it('prints one line per judged entry, every state included, for the preview and the decline', async () => {
    const declined = { 'epic-store-seeded': LINEAGE, 'epic-task-slots': OTHER_LINEAGE };
    const files = { ...MIXED, [DECLINES]: JSON.stringify({ schema: 1, declined }) };
    const { root } = makeProject({ files });
    const judged = judge({ root, deps: observedDeps().deps, lineage: LINEAGE, declined });
    assert.deepEqual(new Set(judged.map(({ state }) => state)), new Set(Object.values(STATES)));
    const preview = await runOffer(root, [], readinessOf());
    assert.equal(preview.code, 0, preview.stderr);
    assert.deepEqual(entryLines(preview.lines), expectedLines(judged));
    const decline = await runOffer(root, ['--decline'], readinessOf());
    assert.equal(decline.code, 0, decline.stderr);
    const recorded = expectedLines(judged).map((line) => line.replace(/: offered$/, ': recorded'));
    assert.deepEqual(entryLines(decline.lines), recorded);
  });

  it('composes the no-command line from the shared sentence', () => {
    assert.equal(OUTCOME_LINES.noCommand(), `  apply: ${loaded.NO_COMMAND_SENTENCE}`);
  });

  it('carries no second judgement in the offer source', () => {
    const words = OFFER_SOURCE.match(/const WORDS = Object\.freeze\(\{([^}]*)\}\)/);
    assert.ok(words, 'tier-preview.mjs declares WORDS');
    const values = [...words[1].matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);
    assert.deepEqual(values, ['applied', 'recorded']);
    assert.match(OFFER_SOURCE, /import \{[^}]*\bjudgeProfileGaps\b[^}]*\} from '\.\/profile-gaps\.mjs'/);
    assert.equal(OFFER_SOURCE.match(/\bjudgeProfileGaps\(/g)?.length, 1);
    for (const absent of [/\bisDeclineCurrent\b/, /\.detect\(/, /\bPROFILE_GAPS\b/]) assert.doesNotMatch(OFFER_SOURCE, absent);
    assert.equal(OFFER_SOURCE.includes(SENTENCE), false, 'the sentence lives once, in profile-gaps.mjs');
  });
});
