import { it } from 'node:test';
import assert from 'node:assert/strict';
import { EPIC_SECTIONS, parseEpic } from './epic-shape.mjs';
import { listStories } from './claim-relation.mjs';
import { checkPlanStructure, isSweep, parseLedger } from './plan-shape.mjs';
import { codes, ledgerOf, makeOtherPlan, planWith } from './plan-shape-harness.test.mjs';

const SOURCE = 'agent-workflow-kit/tools/x.mjs';
const PIN = 'agent-workflow-kit/test/package-content.test.mjs';
const STORY = 'Story: S1 of ALPHA';
const DATE = '2026-09-10';
const CONCRETE_PATHS = [SOURCE, 'agent-workflow-kit/tools/x.test.mjs', 'agent-workflow-kit/tools/x.test/case.mjs'];
const heldBy = (id = 'S2', epic = 'ALPHA', overrides = {}) => makeOtherPlan({ story: { epic, id }, ...overrides });
const waitFor = (plan) => `wait for ${plan.identity}'s Cleanup`;
const ORDER = 'declare a transitive depends-on order between the stories';
const NARROW = 'narrow the claim if the story does not need the path';
const ownershipStep = (plan) => `${waitFor(plan)}, or carry the change in ${plan.story.epic} ${plan.story.id} (revise its plan; the yes is asked again)`;
const sharedStep = (plan, storyless) => `${waitFor(plan)}, or ${storyless ? 'name the story that carries the file' : ORDER}`;
const makeEpic = (stories = [{}], id = 'ALPHA') => {
  const ledger = stories.map((story, index) => {
    const row = { owns: 'none', shared: 'none', dependsOn: 'none', state: 'planned', ...story };
    return `- S${index + 1} | Boundary | depends-on: ${row.dependsOn} | owns: ${row.owns} | shared: ${row.shared} | state: ${row.state}`;
  }).join('\n');
  const bodies = ['Keep boundaries visible.', 'Keep work separate.', 'No implementation choices.', 'The boundary is observable.',
    'docs/ai/specs/kit/example.md', ledger, `Row ${id} in Now`];
  return parseEpic(['---', 'type: epic', `lastUpdated: ${DATE}`, 'scope: permanent', 'staleAfter: 90d', 'owner: none',
    'maxLines: 60', 'state: open', '---', '# Epic: Boundary',
    ...EPIC_SECTIONS.flatMap((heading, index) => [heading, bodies[index]])].join('\n'), `docs/ai/epics/${id}.md`);
};
const factsFor = (stories = [{ owns: SOURCE }], extra = {}) => ({
  stories: listStories([makeEpic(stories)]), landedEpics: [], storeRefusal: null, pathFacts: {}, ...extra,
});
const makeRow = (path = SOURCE, verb = 'modify', id = 'R1') =>
  `${id} | ${verb} | ${path} | Keep the boundary | ${verb === 'delete' ? '\u2014' : 'docs/readme.md:1'}`;
const loadRules = async () => {
  const rules = await import('./plan-shape-ownership.mjs').catch((error) => {
    assert.equal(error.code, 'ERR_MODULE_NOT_FOUND');
    return {};
  });
  assert.equal(typeof rules.checkStoryOwnership, 'function', 'the ownership leaf must export checkStoryOwnership');
  return rules;
};
const makeInput = (facts, goal, ledger, front = '') => {
  const { rows, document } = parseLedger(front + planWith({ goal, ledger: ledgerOf(ledger) }));
  const start = document.headings.find((heading) => heading.text === '## Goal and boundary').index;
  const end = document.headings.find((heading) => heading.text === '## Module ledger').index;
  const goalLines = document.lines.slice(start + 1, end).map((text, offset) => ({ text, line: document.frontLines + start + offset + 2 }));
  return { rows, goalLines, facts, getConcretePaths: (row, inputFacts) => isSweep(row.path) ? inputFacts.expansions?.[row.path] ?? [] : [row.path] };
};
const judge = async (facts = factsFor(), goal = STORY, ledger = makeRow()) => {
  const { checkStoryOwnership } = await loadRules();
  const result = checkStoryOwnership(makeInput(facts, goal, ledger));
  assert.deepEqual(result.findings.map((finding) => finding.line), result.findings.map((finding) => finding.line).sort((a, b) => a - b));
  for (const finding of result.findings) {
    assert.deepEqual(Object.keys(finding).sort(), ['code', 'line', 'message', 'rowId']);
    assert.ok(Number.isInteger(finding.line) && finding.line > 0 && finding.message.length > 0);
  }
  return result;
};

it('spec:plan-shape-ownership/S1 binds one story line and names duplicate, unknown and landed identities', async () => {
  const { readStoryLine, checkStoryOwnership } = await loadRules();
  const input = makeInput(factsFor(), ` ${STORY} \n${STORY}`, makeRow(), '---\nowner: none\n---\n');
  const parsed = readStoryLine(input.goalLines);
  assert.deepEqual(parsed.story, { id: 'S1', epic: 'ALPHA', line: 7 });
  assert.deepEqual(parsed.findings, [{ line: 8, code: 'story-line', message: 'the plan names its story with one line', rowId: null }]);
  assert.deepEqual(codes(checkStoryOwnership(input)), ['story-line']);
  assert.deepEqual(codes(await judge()), []);
  for (const [goal, name] of [['Story: S1 of MISSING', 'MISSING'], ['Story: S99 of ALPHA', 'S99']]) {
    const result = await judge(factsFor(), goal, makeRow('free.mjs'));
    assert.deepEqual(codes(result), ['story-unknown']); assert.ok(result.findings[0].message.includes(name));
  }
  assert.deepEqual(codes(await judge(factsFor([], { landedEpics: ['ALPHA'] }))), ['story-epic-landed']);
  assert.deepEqual(readStoryLine(['Story: S0 of ALPHA', 'Story: S01 of ALPHA', 'Story: S1 of A/B', 'Story: S1 of A B']
    .map((text) => ({ text, line: 1 }))), { story: null, findings: [] });
});

it('spec:plan-shape-ownership/S2 storyless plans meet running claims but not planned claims', async () => {
  assert.deepEqual(codes(await judge(factsFor([{ owns: SOURCE }], { otherPlans: [heldBy('S1')] }), '', makeRow('free.mjs'))), []);
  for (const field of ['owns', 'shared']) {
    const plan = heldBy('S1', 'BETA');
    const stories = listStories([makeEpic([{ [field]: SOURCE }], 'BETA')]);
    assert.deepEqual(codes(await judge(factsFor([], { stories, otherPlans: [] }), '')), []);
    const result = await judge(factsFor([], { stories, otherPlans: [plan] }), '');
    assert.deepEqual(codes(result), [field === 'owns' ? 'story-owns' : 'story-shared']);
    assert.equal(result.findings[0].rowId, 'R1'); assert.ok(result.findings[0].message.includes(SOURCE));
    assert.ok(result.findings[0].message.endsWith(field === 'shared' ? sharedStep(plan, true) : ownershipStep(plan)));
  }
});

it('spec:plan-shape-ownership/S3 refuses another owner while landed stories and epics are free ground', async () => {
  const plan = heldBy();
  const otherPlans = [plan];
  assert.deepEqual(codes(await judge(factsFor([{}, { owns: SOURCE }], { otherPlans: [] }))), []);
  const result = await judge(factsFor([{}, { owns: SOURCE }], { otherPlans }));
  assert.deepEqual(codes(result), ['story-owns']);
  assert.ok(result.findings[0].message.endsWith(ownershipStep(plan)));
  assert.deepEqual(codes(await judge(factsFor([{}, { owns: SOURCE, state: `landed ${DATE}` }], { otherPlans }))), []);
  assert.deepEqual(codes(await judge(factsFor([{}], { landedEpics: ['OLD'] }))), []);
  const covered = factsFor([{}, { owns: SOURCE }], { otherPlans });
  for (const path of CONCRETE_PATHS.slice(1)) {
    assert.deepEqual(codes(await judge(covered, STORY, makeRow(path))), ['story-owns']);
  }
});

it('spec:plan-shape-ownership/S4 requires shared order transitively in either direction within an epic only', async () => {
  const plan = heldBy();
  const result = await judge(factsFor([{}, { shared: SOURCE }], { otherPlans: [plan] }));
  assert.deepEqual(codes(result), ['story-shared']);
  assert.ok(result.findings[0].message.endsWith(sharedStep(plan, false)));
  for (const rows of [[{ dependsOn: 'S2' }, { dependsOn: 'S3', state: `landed ${DATE}` }, { shared: SOURCE }],
    [{}, { dependsOn: 'S1' }, { shared: SOURCE, dependsOn: 'S2' }]]) {
    assert.deepEqual(codes(await judge(factsFor(rows, { otherPlans: [heldBy('S3')] }))), []);
  }
  assert.deepEqual(codes(await judge(factsFor([], { stories: listStories([makeEpic([{}]), makeEpic([{ shared: SOURCE }], 'BETA')]), otherPlans: [heldBy('S1', 'BETA')] }))), []);
});

it('spec:plan-shape-ownership/S5 binds own claims identically for planned, in-flight and landed rows', async () => {
  for (const state of ['planned', 'in-flight', `landed ${DATE}`]) {
    for (const held of [true, false]) {
      const facts = factsFor([{ owns: SOURCE, state }], { otherPlans: [heldBy('S1', 'ALPHA', { held })], pathFacts: { [SOURCE]: { inScope: true } } });
      assert.deepEqual(codes(await judge(facts)), []);
      assert.deepEqual(checkPlanStructure(planWith({ goal: `Spec: not adopted.\n${STORY}`, ledger: makeRow() }), facts).story, facts.stories[0]);
    }
  }
});

it('spec:plan-shape-ownership/S6 requires own cover only for paths in the declared practice', async () => {
  for (const inScope of [true, false]) {
    const result = await judge(factsFor([{}], { pathFacts: { [SOURCE]: { inScope } } }));
    assert.deepEqual(codes(result), inScope ? ['story-scope'] : []);
    if (inScope) assert.ok(result.findings[0].message.endsWith("claim the path in ALPHA S1's row"));
  }
  assert.deepEqual(codes(await judge(factsFor([{ shared: SOURCE }], { pathFacts: { [SOURCE]: { inScope: true } } }))), []);
});

it('spec:plan-shape-ownership/S7 keeps collisions without a practice and admits out-of-extension ground', async () => {
  const noPractice = { pathFacts: { [SOURCE]: { inScope: false } }, otherPlans: [heldBy()] };
  assert.deepEqual(codes(await judge(factsFor([{}], noPractice))), []);
  assert.deepEqual(codes(await judge(factsFor([{}, { owns: SOURCE }], noPractice))), ['story-owns']);
  assert.deepEqual(codes(await judge(factsFor([{}], { capDeclared: true, pathFacts: { 'data.json': { inScope: false } } }), STORY, makeRow('data.json'))), []);
});

it('spec:plan-shape-ownership/S8 covers the package pin through a claimed shipped create or delete only', async () => {
  const facts = factsFor([{ owns: SOURCE }], { pathFacts: { [SOURCE]: { inScope: true, shipped: true, pinTest: PIN }, [PIN]: { inScope: true } } });
  for (const verb of ['create', 'delete']) assert.deepEqual(codes(await judge(facts, STORY, `${makeRow(SOURCE, verb)}\n${makeRow(PIN, 'modify', 'R2')}`)), []);
  for (const ledger of [makeRow(PIN), `${makeRow()}\n${makeRow(PIN, 'modify', 'R2')}`]) assert.deepEqual(codes(await judge(facts, STORY, ledger)), ['story-scope']);
  for (const extra of [{ shipped: false, pinTest: PIN }, { shipped: true, pinTest: 'other/package-content.test.mjs' }]) {
    assert.deepEqual(codes(await judge({ ...facts, pathFacts: { ...facts.pathFacts, [SOURCE]: extra } }, STORY,
      `${makeRow(SOURCE, 'create')}\n${makeRow(PIN, 'modify', 'R2')}`)), ['story-scope']);
  }
});

it('canonicalizes concrete paths, expands sweeps and skips invalid rows', async () => {
  const facts = factsFor([{}, { owns: SOURCE }], { otherPlans: [heldBy()] });
  for (const path of [`./${SOURCE}`, SOURCE.replace('/tools/', '//tools/')]) assert.deepEqual(codes(await judge(facts, STORY, makeRow(path))), ['story-owns']);
  assert.deepEqual(codes(await judge({ ...facts, expansions: { 'tools/*.mjs': [SOURCE, 'free.mjs'] } }, STORY, makeRow('tools/*.mjs'))), ['story-owns']);
  assert.deepEqual(codes(await judge(facts, STORY, makeRow(SOURCE, 'move'))), []);
  assert.deepEqual(codes(await judge(facts, 'Story: S1 of MISSING')), ['story-unknown', 'story-owns']);
});

it('refuses a named unreadable store for both storied and storyless plans', async () => {
  for (const goal of [STORY, '']) {
    assert.deepEqual((await judge(factsFor([], { storeRefusal: 'docs/ai/epics: symlink' }), goal)).findings,
      [{ line: 1, code: 'story-store', message: 'docs/ai/epics: symlink', rowId: null }]);
  }
});

it('leaves bare facts unjudged while retaining story-line grammar findings', async () => {
  assert.deepEqual(codes(await judge({}, STORY)), []);
  assert.deepEqual(codes(await judge({}, `${STORY}\n${STORY}`)), ['story-line']);
});

const relationCases = [
  { name: 'unheld', held: false },
  { name: 'same story', same: true, start: true },
  { name: 'storyless', storyless: true, start: true },
  { name: 'landed', landed: true, start: true },
  { name: 'landed ordered', landed: true, ordered: true, startOwns: true },
  { name: 'landed cross epic', landed: true, cross: true, startOwns: true },
  { name: 'cross epic', cross: true, owns: true },
  { name: 'ordered', ordered: true, owns: true },
  { name: 'unordered', owns: true, shared: true },
];
const makeRelation = (scenario, field, direction) => {
  const claim = { [field]: SOURCE };
  const own = direction === 'B' || scenario.same ? claim : {};
  const other = { ...(direction === 'A' ? claim : {}), ...(scenario.landed ? { state: `landed ${DATE}` } : {}) };
  const stories = listStories(scenario.cross ?
    [makeEpic([own]), makeEpic([other], 'BETA')] :
    [makeEpic([{ ...own, ...(scenario.ordered ? { dependsOn: 'S2' } : {}) }, other])]);
  const otherPlan = makeOtherPlan({
    held: scenario.held ?? true,
    story: scenario.storyless ? null : { epic: scenario.cross ? 'BETA' : 'ALPHA', id: scenario.same || scenario.cross ? 'S1' : 'S2' },
    paths: scenario.same ? [] : [SOURCE],
  });
  return { stories, otherPlan, facts: factsFor([], { stories, otherPlans: [otherPlan] }) };
};

it('spec:plan-shape-ownership/S13 direction A walks the state table for rows, amendments and sweeps', async () => {
  const sweep = 'agent-workflow-kit/tools/*.mjs';
  const ledgers = [
    { ledger: makeRow(), rowId: 'R1' },
    { ledger: `${makeRow('free.mjs')}\namendments:\n${makeRow(SOURCE, 'modify', 'A1')}`, rowId: 'A1' },
    { ledger: makeRow(sweep).replace('Keep the boundary', 'Keep the boundary (1 files)'), rowId: 'R1' },
  ];
  for (const scenario of relationCases) {
    for (const field of ['owns', 'shared']) {
      const { facts, otherPlan } = makeRelation(scenario, field, 'A');
      for (const { ledger, rowId } of ledgers) {
        const result = await judge({ ...facts, expansions: { [sweep]: [SOURCE] } }, STORY, ledger);
        assert.deepEqual(codes(result), scenario[field] ? [`story-${field}`] : [], `${scenario.name}: ${field}`);
        if (scenario[field]) {
          assert.equal(result.findings[0].rowId, rowId);
          assert.ok(result.findings[0].message.endsWith(field === 'owns' ? ownershipStep(otherPlan) : sharedStep(otherPlan, false)));
        }
      }
    }
  }
  const { facts, otherPlan } = makeRelation(relationCases.at(-1), 'shared', 'A');
  const result = await judge(facts, '');
  assert.deepEqual(codes(result), ['story-shared']);
  assert.ok(result.findings[0].message.endsWith(sharedStep(otherPlan, true)));
});

it('spec:plan-shape-ownership/S14 direction B walks held rows and the one-plan-per-story rule', async () => {
  const { checkStoryStart } = await loadRules();
  assert.equal(typeof checkStoryStart, 'function');
  for (const scenario of relationCases) {
    for (const field of ['owns', 'shared']) {
      const { stories, otherPlan } = makeRelation(scenario, field, 'B');
      const input = { own: stories[0], stories, otherPlans: [otherPlan] };
      const wait = scenario.start || scenario[field] || (scenario.startOwns && field === 'owns');
      const step = `${waitFor(otherPlan)}, or ${NARROW}${field === 'shared' && !scenario.storyless && !scenario.cross ? `, or ${ORDER}` : ''}`;
      for (const path of CONCRETE_PATHS) {
        const message = scenario.same ? `ALPHA S1 is held by ${otherPlan.identity}; carry the change in ${otherPlan.identity} (revise it; the yes is asked again)` :
          `ALPHA S1 ${field} ${SOURCE} meets ${otherPlan.identity} path ${path}; ${step}`;
        const plans = [{ ...otherPlan, paths: scenario.same ? [] : [path] }];
        assert.deepEqual(checkStoryStart({ ...input, otherPlans: plans }).waits, wait ? [{ plan: otherPlan.identity, message }] : [], `${scenario.name}: ${field}: ${path}`);
      }
      assert.deepEqual(checkStoryStart({ ...input, own: null }).waits, []);
    }
  }
});
