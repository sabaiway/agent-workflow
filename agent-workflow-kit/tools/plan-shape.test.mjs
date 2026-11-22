import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { codes, DEFAULT_ROW, ledgerOf, planWith } from './plan-shape-harness.test.mjs';
import { expandClaim } from './claim-relation.mjs';

const PIN_PATH = 'test/package-content.test.mjs';
const rules = await import('./plan-shape.mjs').catch(() => ({}));
const loadRules = async () => rules;

const factsFor = (overrides = {}) => {
  const facts = {
    capDeclared: true,
    cap: 400,
    pathFacts: {
      'docs/readme.md': { kind: 'regular', lines: 10, recordedLines: null, inScope: false, shipped: false, pinTest: null, contained: true },
    },
    expansions: {},
    repoFiles: ['docs/readme.md'],
    ...overrides,
  };
  return { ...facts, candidates: (suffix, preceding) => rules.resolveAnchorCandidates(facts.repoFiles, suffix, preceding) };
};

describe('plan-shape rules — structural and authoring state', () => {
  it('spec:plan-shape-ownership/S11 judges story ownership in every arm and leaves bare facts unjudged', async () => {
    const { checkPlan, verifyPlan, checkPlanStructure } = await loadRules();
    const facts = factsFor({ stories: [{ path: 'docs/ai/epics/ALPHA.md', id: 'S1', line: 20, state: 'planned',
      claims: [{ field: 'owns', path: 'docs/readme.md', ground: expandClaim('docs/readme.md') }], reachable: new Set() }],
      landedEpics: [], storeRefusal: null });
    for (const judge of [checkPlan, verifyPlan, checkPlanStructure]) {
      assert.deepEqual(codes(judge(planWith(), facts)), ['story-owns']);
      assert.deepEqual(codes(judge(planWith(), factsFor())), []);
      const text = '---\nowner: none\n---\n' + planWith({ goal: '- Spec: docs/ai/specs/example.md\nStory: S1 of ALPHA\nStory: S1 of ALPHA' });
      assert.deepEqual(judge(text, facts).findings.map(({ line, code }) => ({ line, code })), [{ line: 9, code: 'story-line' }]);
    }
  });

  it('spec:plan-review-loop/S34 binds every repeated modify pin to an untaken shipped row above it', async () => {
    const { checkPlanStructure } = await loadRules();
    const pin = (id, verb = 'modify') => `${id} | ${verb} | ${PIN_PATH} | update the pin | n/a | docs/readme.md:1`;
    const remove = (id, path) => `${id} | delete | ${path} | remove it | \u2014 | \u2014`;
    const first = remove('D1', 'src/a.mjs');
    const second = remove('D2', 'src/b.mjs');
    const facts = factsFor({ pathFacts: Object.fromEntries(['src/a.mjs', 'src/b.mjs'].map((path) => [path, { shipped: true, pinTest: PIN_PATH }])) });
    const judge = (rows, input = facts) => checkPlanStructure(planWith({ ledger: [...rows, 'total: 0 \u2192 0 lines'].join('\n') }), input);
    assert.deepEqual(codes(judge([pin('P1')])), []);
    const two = [first, second, pin('P1'), pin('P2')];
    assert.deepEqual(codes(judge(two)), []);
    assert.deepEqual(judge([...two, pin('P3')]).findings.map(({ code, rowId }) => ({ code, rowId })), [{ code: 'pin-unbound', rowId: 'P3' }]);
    assert.deepEqual(judge([pin('P1'), first, pin('P2'), second, pin('P3')]).findings.map(({ code, rowId }) => ({ code, rowId })), [{ code: 'pin-unbound', rowId: 'P1' }]);
    assert.ok(codes(judge([pin('P1', 'create'), pin('P2')])).includes('duplicate-path'));
    assert.deepEqual(codes(judge(two, {})), []);
    assert.deepEqual(codes(judge([pin('P1'), pin('P2')], {})), []);
    assert.deepEqual(codes(judge([pin('P1'), pin('P2')])), ['pin-unbound', 'pin-unbound']);
    assert.deepEqual(codes(judge(two, factsFor({ pathFacts: {} }))), ['pin-unbound', 'pin-unbound']);
    const countedFacts = factsFor({ pathFacts: { ...facts.pathFacts, [PIN_PATH]: { kind: 'regular', lines: 798, inScope: true } } });
    const counted = planWith({ ledger: [first, second, pin('P1').replace('n/a', '798'), pin('P2').replace('n/a', '798'),
      'total: 798 \u2192 798 lines'].join('\n') });
    assert.deepEqual([rules.checkPlan(counted, countedFacts), rules.verifyPlan(counted, countedFacts)]
      .map((result) => codes(result).filter((code) => ['before-total', 'after-total'].includes(code))), [[], []]);
    const creates = [first, second].map((row) => row.replace('delete', 'create').replace('\u2014 | \u2014', 'n/a | docs/readme.md:1'));
    const sweep = 'SW | modify | test/*.test.mjs | update (2 files) | n/a | docs/readme.md:1';
    assert.ok(codes(judge([...creates, sweep, pin('P1')], { ...facts, expansions: { 'test/*.test.mjs': [PIN_PATH, 'test/other.test.mjs'] } })).includes('duplicate-path'));
    const conflicted = judge([...creates, pin('P1'), sweep, pin('P3')],
      { ...facts, expansions: { 'test/*.test.mjs': [PIN_PATH, 'test/other.test.mjs'] } });
    assert.match(conflicted.findings.find((finding) => finding.rowId === 'P3').message, /owned by both SW and P3/);
  });

  describe('create rows on existing documents', () => {
    const draftPath = 'docs/ai/specs/example.md';
    const siblingPath = 'docs/ai/specs/another.md';
    const rootPath = 'docs/ai/specs/feature/index.md';
    const partPath = 'docs/ai/specs/feature/details.md';
    const indexPath = 'docs/ai/specs/index.md';
    const regular = { kind: 'regular', lines: 10, contained: true, inScope: false };
    const document = (kind, fields = {}) => ({
      ...regular, contract: { kind, status: null, children: [], parts: [], refused: false, ...fields },
    });
    const draft = document('spec', { status: 'draft' });
    const root = document('spec', { status: 'draft', parts: [partPath] });
    const part = document('part');
    const children = [draftPath, siblingPath];
    const index = document('index', { children });

    for (const { name, path, cases, supportingFacts = {} } of [
      { name: 'spec:plan-review-loop/S36 accepts the same plan draft and keeps kind for other existing create paths', path: draftPath, cases: [
        { state: 'refused draft', fact: document('spec', { status: 'draft', refused: true }) },
        { state: 'live spec', fact: document('spec', { status: 'live' }), cause: /a live spec/ },
        { state: 'retired spec', fact: document('spec', { status: 'retired' }) },
        { state: 'foreign node', fact: { ...regular, kind: 'other' } },
        { state: 'draft created by another plan', fact: draft, otherPlanCreates: [draftPath], cause: /another plan in flight creates it/ },
        { state: 'existing path outside the store', target: 'docs/guide.md', fact: regular },
        { state: 'draft created by this plan', fact: draft, accepts: true },
      ] },
      { name: 'accepts a listed part of a draft root this plan creates', path: partPath, supportingFacts: { [rootPath]: root }, cases: [
        { state: 'part unlisted by its root', fact: part, creates: [rootPath],
          pathFacts: { [rootPath]: document('spec', { status: 'draft', parts: ['docs/ai/specs/feature/other.md'] }) } },
        { state: 'root omitted from the plan', fact: part },
        { state: 'listed part of a draft root created here', fact: part, creates: [rootPath], accepts: true },
      ] },
      { name: 'accepts a navigator listing children all created by this plan', path: indexPath,
        supportingFacts: { [draftPath]: draft, [siblingPath]: draft }, cases: [
          { state: 'empty index', fact: document('index') },
          { state: 'one listed child omitted from the plan', fact: index, creates: [draftPath] },
          { state: 'all listed children created here', fact: index, creates: children, accepts: true },
        ] },
    ]) {
      it(name, async () => {
        const { checkPlan } = await loadRules();
        const base = factsFor();
        for (const { state, fact, target = path, creates = [], pathFacts = {}, otherPlanCreates = [], accepts = false, cause } of cases) {
          const rows = [target, ...creates].map((path, index) => `R${index + 1} | create | ${path} | add document | n/a | docs/readme.md:1`);
          const facts = factsFor({ pathFacts: { ...base.pathFacts, ...supportingFacts, ...pathFacts, [target]: fact }, otherPlanCreates });
          const ledger = [...rows, 'total: 0 → 0 lines'].join('\n');
          const { findings } = checkPlan(planWith({ ledger }), facts);
          const kind = findings.find(({ code, rowId }) => code === 'kind' && rowId === 'R1');
          assert.equal(Boolean(kind), !accepts, `${state}: expected ${accepts ? 'no kind finding' : 'a kind finding'} on R1`);
          if (cause) assert.match(kind.message, cause, `${state}: the kind finding names its cause`);
        }
      });
    }
  });

  it('S1 requires the title prefix and ordered skeleton, admitting phases only before Cleanup (spec:plan-review-loop/S1)', async () => {
    const { checkPlan, PLAN_HEADINGS, PLAN_TITLE_PREFIX } = await loadRules();
    assert.deepEqual(PLAN_HEADINGS, [
      '## Goal and boundary',
      '## Module ledger',
      '## Verification',
      '## Phase: Cleanup',
      '## Next steps',
    ]);
    assert.equal(PLAN_TITLE_PREFIX, '# Plan: ');
    assert.deepEqual(checkPlan(planWith({ phases: '\n## Phase: Release Publishing\n- Publish.\n' }), factsFor()).findings, []);
    assert.ok(codes(checkPlan(planWith().replace('# Plan: example', '# Plan: '), factsFor())).includes('title'));
    assert.ok(codes(checkPlan(planWith().replace('## Phase: Cleanup', '## Surprise'), factsFor())).includes('headings'));
    assert.ok(codes(checkPlan(planWith().replace('## Next steps', '## Phase: Late\n- Late.\n\n## Next steps'), factsFor())).includes('headings'));
    const swapped = planWith().replace('## Module ledger', '## Swap').replace('## Verification', '## Module ledger').replace('## Swap', '## Verification');
    assert.ok(codes(checkPlan(swapped, factsFor())).includes('headings'));
  });

  it('verifyPlan bounds a sweep by its asserted count and a path by its budget', async () => {
    const { verifyPlan } = await loadRules();
    const files = ['src/a.mjs', 'src/b.mjs'];
    const pathFacts = Object.fromEntries(files.map((path) => [path, { kind: 'regular', lines: 10, recordedLines: null, inScope: true, shipped: false, pinTest: null, contained: true }]));
    const facts = factsFor({ pathFacts, expansions: { 'src/*.mjs': files }, repoFiles: files });
    const result = verifyPlan(planWith({ ledger: 'R1 | modify | src/*.mjs | update (3 files) | 5 | src/a.mjs:1\ntotal: 20 → 20 lines' }), facts);
    assert.ok(codes(result).includes('sweep-count'));
    assert.ok(codes(result).includes('post-budget'));
    assert.ok(!codes(result).includes('after-total'));
  });

  it('S2 enforces the line, row, section and counted-row byte caps (spec:plan-review-loop/S2)', async () => {
    const { checkPlan } = await loadRules();
    const tooManyLines = `${planWith()}${'padding\n'.repeat(90)}`;
    const rows = Array.from({ length: 26 }, (_, index) => `R${index} | modify | docs/file-${index}.md | edit | n/a | docs/readme.md:1`).join('\n');
    const longResponsibility = 'x'.repeat(201);
    assert.ok(codes(checkPlan(tooManyLines, factsFor())).includes('line-cap'));
    assert.ok(codes(checkPlan(planWith({ goal: Array.from({ length: 10 }, () => '- boundary').join('\n') }), factsFor())).includes('section-cap'));
    assert.ok(codes(checkPlan(planWith({ ledger: `${rows}\ntotal: 0 → 0 lines` }), factsFor())).includes('row-cap'));
    assert.ok(codes(checkPlan(planWith({ ledger: `R1 | modify | docs/readme.md | ${longResponsibility} | n/a | docs/readme.md:1\ntotal: 10 → 10 lines` }), factsFor())).includes('row-bytes'));
    const tail = (bullets) => planWith().replace('- Continue.\n', `- Continue.\n${'- More.\n'.repeat(bullets)}`);
    assert.deepEqual(checkPlan(tail(5), factsFor()).findings, [], 'Cleanup and Next steps at exactly ten lines, newline-terminated');
    assert.ok(codes(checkPlan(tail(6), factsFor())).includes('section-cap'));
  });

  it('S3 rejects malformed fields, verbs, delete dashes and duplicate ids (spec:plan-review-loop/S3)', async () => {
    const { checkPlan } = await loadRules();
    const malformed = [
      'R1 | move | docs/readme.md | move it | n/a | docs/readme.md:1',
      'R1 | delete | docs/readme.md | remove it | n/a | docs/readme.md:1',
      'R1 | modify | docs/readme.md | edit it | — | —',
      'R1 | modify | docs/readme.md | edit it | n/a | docs/readme.md:1',
      'total: 20 → 10 lines',
    ].join('\n');
    const result = checkPlan(planWith({ ledger: malformed }), factsFor());
    assert.ok(codes(result).includes('row-grammar'));
    assert.ok(codes(result).includes('duplicate-id'));
    const guide = { kind: 'regular', lines: 5, recordedLines: null, inScope: false, shipped: false, pinTest: null, contained: true };
    const fiveFieldsAbove = 'R1 | modify | docs/readme.md | a forgotten anchor | n/a\nR2 | modify | docs/guide.md | edit | n/a | readme.md:1\ntotal: 0 → 0 lines';
    const facts = factsFor({ pathFacts: { ...factsFor().pathFacts, 'docs/guide.md': guide }, repoFiles: ['docs/readme.md', 'docs/guide.md'] });
    assert.deepEqual(codes(checkPlan(planWith({ ledger: fiveFieldsAbove }), facts)), ['row-grammar']);
  });

  it('S4 requires a final total whose before figure is the current counted sum (spec:plan-review-loop/S4)', async () => {
    const { checkPlan } = await loadRules();
    const wrong = planWith({ ledger: 'R1 | modify | docs/readme.md | edit | n/a | docs/readme.md:1\ntotal: 9 → 10 lines\nmore' });
    const reason = planWith({ ledger: 'R1 | modify | docs/readme.md | edit | n/a | docs/readme.md:1\ntotal: ~0 → ~12 lines (growth buys the parser)' });
    assert.ok(codes(checkPlan(wrong, factsFor())).includes('total'));
    assert.ok(codes(checkPlan(wrong, factsFor())).includes('before-total'));
    assert.deepEqual(checkPlan(reason, factsFor()).findings, []);
  });

  it('S5 resolves an anchor by exact path, then prior component-aligned suffix candidates (spec:plan-review-loop/S5)', async () => {
    const { checkPlan } = await loadRules();
    const ledger = [
      'R1 | modify | docs/readme.md | edit | n/a | docs/readme.md:1',
      'R2 | modify | docs/guide.md | edit | n/a | readme.md:99',
      'total: 0 → 0 lines',
    ].join('\n');
    const document = { kind: 'regular', lines: 5, inScope: false, contained: true, shipped: false, pinTest: null };
    const pathFacts = { 'docs/readme.md': { ...document, lines: 10 }, 'docs/guide.md': document, 'other/item.md': document };
    const facts = factsFor({ pathFacts, repoFiles: ['docs/readme.md', 'docs/guide.md'] });
    assert.deepEqual(checkPlan(planWith({ ledger }), facts).findings, []);
    const missing = planWith({ ledger: ledger.replace('readme.md:99', 'missing.md:99') });
    assert.ok(codes(checkPlan(missing, facts)).includes('anchor'));
    const noPrior = [
      'R1 | modify | docs/guide.md | edit | n/a | docs/guide.md:1',
      'R2 | modify | other/item.md | edit | n/a | readme.md:99',
      'total: 0 → 0 lines',
    ].join('\n');
    const ambiguous = factsFor({ pathFacts, repoFiles: ['docs/readme.md', 'docs/guide.md', 'other/readme.md'] });
    assert.ok(codes(checkPlan(planWith({ ledger: noPrior }), ambiguous)).includes('anchor'));
    assert.deepEqual(checkPlan(planWith({ ledger }), ambiguous).findings, [], 'a row above wins over the repository');
  });

  it('S6 requires a preceding test row for an in-scope source create (spec:plan-review-loop/S6)', async () => {
    const { checkPlan } = await loadRules();
    const source = { kind: 'absent', lines: 0, recordedLines: null, inScope: true, shipped: false, pinTest: null, contained: true };
    const test = { ...source };
    const withoutTest = 'R2 | create | src/new.mjs | export run | 100 | src/existing.mjs:1\ntotal: 0 → 100 lines';
    const withTest = 'R1 | create | src/new.test.mjs | test run | 100 | src/existing.mjs:1\nR2 | create | src/new.mjs | export run | 100 | src/existing.mjs:1\ntotal: 0 → 200 lines';
    const facts = factsFor({ pathFacts: { 'src/new.mjs': source, 'src/new.test.mjs': test, 'src/existing.mjs': { ...source, kind: 'regular', lines: 1 } }, repoFiles: ['src/existing.mjs'] });
    assert.ok(codes(checkPlan(planWith({ ledger: withoutTest }), facts)).includes('red-first'));
    assert.deepEqual(checkPlan(planWith({ ledger: withTest }), facts).findings, []);
  });

  it('S7 bounds in-scope budgets unless Verification declares the reasoned baseline raise (spec:plan-review-loop/S7)', async () => {
    const { checkPlan } = await loadRules();
    const row = 'R1 | modify | src/large.mjs | edit | 401 | src/large.mjs:1\ntotal: 300 → 401 lines';
    const pathFacts = { 'src/large.mjs': { kind: 'regular', lines: 300, recordedLines: 350, inScope: true, shipped: true, pinTest: 'test/package-content.test.mjs', contained: true } };
    const facts = factsFor({ cap: 400, pathFacts, repoFiles: ['src/large.mjs'] });
    assert.ok(codes(checkPlan(planWith({ ledger: row }), facts)).includes('budget-cap'));
    const created = { kind: 'absent', lines: 0, recordedLines: null, inScope: true, shipped: false, pinTest: null, contained: true };
    const createLedger = 'R0 | create | src/new.test.mjs | test it | 401 | src/large.mjs:1\ntotal: 0 → 401 lines';
    assert.ok(codes(checkPlan(planWith({ ledger: createLedger }), { ...facts, pathFacts: { ...pathFacts, 'src/new.test.mjs': created } })).includes('budget-cap'));
    const verification = '- `source-size-check.mjs --write-baseline --reason "growth"` names src/large.mjs and exits 0';
    assert.deepEqual(checkPlan(planWith({ ledger: row, verification }), facts).findings, []);
  });

  it('S8 restricts sweeps and requires acceptance bullets plus a governing-spec line (spec:plan-review-loop/S8)', async () => {
    const { checkPlan } = await loadRules();
    const files = ['docs/a.md', 'docs/b.md'];
    const pathFacts = Object.fromEntries(files.map((path) => [path, { kind: 'regular', lines: 1, inScope: false, shipped: false, pinTest: null, contained: true }]));
    const facts = factsFor({ pathFacts, expansions: { 'docs/*.md': files }, repoFiles: files });
    const badSweep = 'R1 | create | docs/*.md | update all sites | n/a | docs/a.md:1\ntotal: 2 → 2 lines';
    assert.ok(codes(checkPlan(planWith({ ledger: badSweep, goal: 'No contract.', verification: 'plain prose' }), facts)).includes('sweep'));
    assert.ok(codes(checkPlan(planWith({ ledger: badSweep, goal: 'No contract.', verification: 'plain prose' }), facts)).includes('acceptance'));
    assert.ok(codes(checkPlan(planWith({ ledger: badSweep, goal: 'No contract.', verification: 'plain prose' }), facts)).includes('governing-spec'));
  });

  it('S9 rejects uncontained and multiply-owned paths, wrong kinds and invalid cap states (spec:plan-review-loop/S9)', async () => {
    const { checkPlan, verifyPlan, checkPlanStructure } = await loadRules();
    const ledger = [
      'R1 | modify | src/*.mjs | update (1 files) | 10 | src/a.mjs:1',
      'R2 | modify | src/a.mjs | update | 10 | src/a.mjs:1',
      'R3 | create | ../escape.mjs | export run | 10 | src/a.mjs:1',
      'total: 2 → 20 lines',
    ].join('\n');
    const regular = { kind: 'absent', lines: 0, recordedLines: null, inScope: true, shipped: false, pinTest: null, contained: true };
    const facts = factsFor({
      capDeclared: false,
      pathFacts: { 'src/a.mjs': regular, '../escape.mjs': { ...regular, kind: 'absent', contained: false } },
      expansions: { 'src/*.mjs': ['src/a.mjs'] },
      repoFiles: ['src/a.mjs'],
    });
    const result = checkPlan(planWith({ ledger }), facts);
    assert.ok(codes(result).includes('containment'));
    assert.ok(codes(result).includes('duplicate-path'));
    assert.ok(codes(result).includes('kind'));
    assert.ok(codes(result).includes('cap-declaration'));
    const badAnchor = checkPlan(planWith({ ledger: 'R4 | modify | src/a.mjs | update | 10 | ../outside.mjs:1\ntotal: 0 → 10 lines' }), facts);
    assert.ok(codes(badAnchor).includes('containment'));
    const spellings = ['/src/a.mjs', 'src//a.mjs', './src/a.mjs', 'src/./a.mjs', 'src/a.mjs/', '.', '..', '../escape.mjs', 'src\\a.mjs'];
    for (const judge of [checkPlan, verifyPlan, checkPlanStructure]) {
      for (const path of [...spellings, 'src/a.mjs', 'src/*.mjs']) {
        for (const [rowPath, anchor] of [[path, 'src/a.mjs'], ['src/a.mjs', path]]) {
          const text = planWith({ ledger: `R4 | modify | ${rowPath} | update (1 files) | n/a | ${anchor}:1\ntotal: 0 \u2192 0 lines` });
          assert.equal(codes(judge(text, facts)).includes('containment'), spellings.includes(path), `${judge.name}: ${rowPath} | ${anchor}`);
        }
      }
    }
    const noBudget = checkPlan(planWith({ ledger: 'R4 | modify | src/a.mjs | update | n/a | src/a.mjs:1\ntotal: 0 → 0 lines' }), { ...facts, capDeclared: true });
    assert.ok(codes(noBudget).includes('source-budget'));
  });

  it('spec:plan-structure/S6 judges amendment budgets, pins, sweeps, caps, entry grammar and story ownership', async () => {
    const { checkPlan, verifyPlan, checkPlanStructure } = await loadRules();
    const row = (id, verb, path, budget, responsibility = 'update') => `${id} | ${verb} | ${path} | ${responsibility} | ${budget} | src/a.mjs:1`;
    const buildPlan = (approved, entries = [], total, goal) => planWith({
      goal, ledger: ledgerOf([...approved, ...(entries.length ? ['amendments:', ...entries] : [])].join('\n'), total),
    });
    const files = ['src/a.mjs', 'src/b.mjs'];
    const sweepPath = 'src/*.mjs';
    const sweep = row('R1', 'modify', sweepPath, 100, 'update (2 files)');
    const regularFile = { kind: 'regular', lines: 120 };
    const pathFacts = Object.fromEntries(files.map((path) => [path, regularFile]));
    const facts = factsFor({ pathFacts, repoFiles: files, expansions: { [sweepPath]: files } });
    const amendment = row('A1', 'modify', files[0], 150);
    const literalPlan = buildPlan([row('R1', 'modify', files[0], 100)], [amendment], 'total: 120 → 150 lines');
    const verifySweep = verifyPlan(buildPlan([sweep], [amendment], 'total: 240 → 250 lines'), facts);
    const pin = row('P1', 'modify', PIN_PATH, 100);
    const shipped = files.map((path, index) => row(`C${index + 1}`, 'create', path, 100));
    const pinFacts = factsFor({ pathFacts: Object.fromEntries(files.map((path) => [path, { shipped: true, pinTest: PIN_PATH }])) });
    const pinAmendment = checkPlanStructure(buildPlan([shipped[0], pin], [row('A1', 'modify', PIN_PATH, 150)]), pinFacts);
    const equalPin = checkPlanStructure(buildPlan([...shipped, pin], [row('A1', 'modify', PIN_PATH, 100)]), pinFacts);
    const create = row('A1', 'create', 'src/c.mjs', 150);
    const createFacts = factsFor({ pathFacts: { [files[0]]: regularFile, 'src/c.mjs': regularFile }, expansions: { [sweepPath]: [files[0], 'src/c.mjs'] } });
    const createEntry = checkPlanStructure(buildPlan([sweep], [create]), createFacts);
    const createRow = checkPlanStructure(buildPlan([sweep, create]), createFacts);
    const wrongCount = checkPlan(buildPlan([sweep.replace('(2 files)', '(3 files)')], [], 'total: 240 → 240 lines'), facts);
    const approved = Array.from({ length: 25 }, (_, index) => row(`R${index}`, 'modify', `docs/approved-${index}.md`, 'n/a'));
    const entries = Array.from({ length: 80 }, (_, index) => row(`A${index}`, 'modify', `docs/entry-${index}.md`, 'n/a'));
    const longEntry = checkPlanStructure(buildPlan([DEFAULT_ROW], [row('A1', 'modify', files[0], 150, 'x'.repeat(201))]), facts);
    const shortEntry = checkPlanStructure(buildPlan([DEFAULT_ROW], ['A1 | modify | src/a.mjs | update | 150']), facts);
    const stories = [['ALPHA', 'docs/owned.md'], ['BETA', 'docs/readme.md']].map(([epic, path]) => ({
      path: `docs/ai/epics/${epic}.md`, id: 'S1', line: 20, state: 'planned',
      claims: [{ field: 'owns', path, ground: expandClaim(path) }], reachable: new Set(),
    }));
    const storyPlan = buildPlan([DEFAULT_ROW], [row('A1', 'modify', 'docs/owned.md', 'n/a')], undefined,
      '- Spec: docs/ai/specs/example.md\nStory: S1 of BETA');
    const storyEntry = checkPlanStructure(storyPlan, factsFor({ stories, landedEpics: [], storeRefusal: null }));
    const relevantCodes = (result, ...relevant) => codes(result).filter((code) => code === 'ledger-line' || relevant.includes(code));
    assert.deepEqual({
      literalStructure: relevantCodes(checkPlanStructure(literalPlan, facts), 'duplicate-path'),
      literalBudget: relevantCodes(verifyPlan(literalPlan, facts), 'post-budget'),
      sweepBudget: relevantCodes(verifySweep, 'duplicate-path', 'post-budget'),
      pinAmendment: relevantCodes(pinAmendment, 'pin-unbound', 'duplicate-path'),
      equalPin: relevantCodes(equalPin, 'pin-unbound', 'duplicate-path'),
      createEntry: relevantCodes(createEntry, 'duplicate-path'),
      createRow: relevantCodes(createRow, 'duplicate-path'),
      wrongCount: relevantCodes(wrongCount, 'sweep-count'),
      amendmentCheck: relevantCodes(checkPlan(literalPlan, facts), 'amendment-check'),
      crlfAmendmentCheck: relevantCodes(checkPlan(literalPlan.replaceAll('\n', '\r\n'), facts), 'amendment-check'),
      rowCap: relevantCodes(checkPlanStructure(buildPlan(approved, entries.slice(0, 1)), facts), 'row-cap'),
      lineCaps: relevantCodes(checkPlanStructure(buildPlan(approved, entries), facts), 'section-cap', 'line-cap'),
      longEntry: relevantCodes(longEntry, 'row-bytes'),
      shortEntry: relevantCodes(shortEntry, 'row-grammar'),
      storyEntry: relevantCodes(storyEntry, 'story-owns'),
    }, {
      literalStructure: [], literalBudget: [], sweepBudget: ['post-budget'], pinAmendment: [],
      equalPin: ['duplicate-path'], createEntry: ['duplicate-path'], createRow: ['duplicate-path'],
      wrongCount: ['sweep-count'], amendmentCheck: ['amendment-check'], crlfAmendmentCheck: ['amendment-check'], rowCap: [], lineCaps: [],
      longEntry: ['row-bytes'], shortEntry: ['row-grammar'], storyEntry: ['story-owns'],
    });
    const budgetFinding = verifySweep.findings.find(({ code }) => code === 'post-budget');
    assert.deepEqual(files.filter((path) => budgetFinding.message.includes(path)), ['src/b.mjs']);
    for (const [result, code] of [[equalPin, 'duplicate-path'], [createEntry, 'duplicate-path'], [longEntry, 'row-bytes'],
      [shortEntry, 'row-grammar'], [storyEntry, 'story-owns']]) {
      assert.equal(result.findings.find((finding) => finding.code === code).rowId, 'A1', code);
    }
  });

  it('S4/S29 judges robust tags in all three judges and reads the class list only for tagged plans (spec:robustness-literals/S4, spec:plan-review-loop/S29)', async () => {
    const { checkPlan, verifyPlan, checkPlanStructure } = await loadRules();
    const buildPlan = (responsibility) => planWith({ ledger: ledgerOf(DEFAULT_ROW.replace('keep the document current', responsibility)) });
    const facts = factsFor({ robustClasses: ['a'] });
    const untagged = buildPlan('ordinary untagged row');
    const unreadList = new Error('read robustClasses on an untagged plan');
    const untaggedFacts = Object.defineProperty(factsFor(), 'robustClasses', { enumerable: true, get() { throw unreadList; } });
    const tags = ['robust:no-such-class', 'robust:', 'robust:a,', 'robust:a,a', 'robust:Not-A-Slug', 'robust:a and robust:b'];
    const atByteCap = 'x'.repeat(180);
    const judges = { checkPlan, verifyPlan, checkPlanStructure };
    const verdicts = Object.entries(judges).map(([name, judge]) => {
      const verdict = {
        name, missedRefusals: tags.filter((tag) => !codes(judge(buildPlan(`prove ${tag}`), facts)).includes('robust-class')),
        listedClass: codes(judge(buildPlan('prove robust:a'), facts)), untaggedRow: codes(judge(untagged, facts)),
        rowBytes: [atByteCap, `${atByteCap} robust:a`].map((text) => codes(judge(buildPlan(text), facts))),
      };
      try {
        return { ...verdict, unreadList: codes(judge(untagged, untaggedFacts)) };
      } catch (error) {
        assert.equal(error, unreadList);
        return { ...verdict, unreadList: error.message };
      }
    });
    assert.deepEqual(verdicts, Object.keys(judges).map((name) => ({
      name, missedRefusals: [], listedClass: [], rowBytes: [[], ['row-bytes']], untaggedRow: [], unreadList: [],
    })));
  });
});
