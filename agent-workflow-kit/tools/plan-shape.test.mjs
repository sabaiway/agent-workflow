import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { codes, DEFAULT_ROW, ledgerOf, LEGACY_ROW, planWith } from './plan-shape-harness.test.mjs';
import { expandClaim } from './claim-relation.mjs';

const PIN_PATH = 'test/package-content.test.mjs';
const rules = await import('./plan-shape.mjs').catch(() => ({}));
const loadRules = async () => rules;

const factsFor = (overrides = {}) => {
  const facts = {
    pathFacts: {
      'docs/readme.md': { kind: 'regular', inScope: false, shipped: false, pinTest: null, contained: true },
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
    const pin = (id, verb = 'modify') => `${id} | ${verb} | ${PIN_PATH} | update the pin | docs/readme.md:1`;
    const remove = (id, path) => `${id} | delete | ${path} | remove it | \u2014`;
    const first = remove('D1', 'src/a.mjs');
    const second = remove('D2', 'src/b.mjs');
    const facts = factsFor({ pathFacts: Object.fromEntries(['src/a.mjs', 'src/b.mjs'].map((path) => [path, { shipped: true, pinTest: PIN_PATH }])) });
    const judge = (rows, input = facts) => checkPlanStructure(planWith({ ledger: rows.join('\n') }), input);
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
    const creates = [first, second].map((row) => row.replace('delete', 'create').replace('\u2014', 'docs/readme.md:1'));
    const sweep = 'SW | modify | test/*.test.mjs | update (2 files) | docs/readme.md:1';
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
    const regular = { kind: 'regular', contained: true, inScope: false };
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
          const rows = [target, ...creates].map((path, index) => `R${index + 1} | create | ${path} | add document | docs/readme.md:1`);
          const facts = factsFor({ pathFacts: { ...base.pathFacts, ...supportingFacts, ...pathFacts, [target]: fact }, otherPlanCreates });
          const ledger = rows.join('\n');
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

  it('verifyPlan bounds a sweep by its asserted count without judging path budgets', async () => {
    const { verifyPlan } = await loadRules();
    const files = ['src/a.mjs', 'src/b.mjs'];
    const pathFacts = Object.fromEntries(files.map((path) => [path, { kind: 'regular', lines: 10, inScope: true, contained: true }]));
    const facts = factsFor({ pathFacts, expansions: { 'src/*.mjs': files }, repoFiles: files });
    const legacy = verifyPlan(planWith({ ledger: 'R1 | modify | src/*.mjs | update (3 files) | 5 | src/a.mjs:1\ntotal: 20 → 5 lines' }), facts);
    assert.deepEqual(codes(legacy).filter((code) => ['post-budget', 'after-total'].includes(code)), []);
    const ledger = 'R1 | modify | src/*.mjs | update (3 files) | src/a.mjs:1';
    assert.deepEqual(codes(verifyPlan(planWith({ ledger }), facts)), ['sweep-count']);
  });

  it('S2 enforces the line, row, section and counted-row byte caps (spec:plan-review-loop/S2)', async () => {
    const { checkPlan } = await loadRules();
    const path = 'docs/' + 'p'.repeat(200) + '.md';
    const facts = factsFor({ pathFacts: { [path]: { kind: 'regular', contained: true } }, repoFiles: [path] });
    const atByteCap = '\u00e9'.repeat(93);
    const plan = (responsibility) => planWith({ ledger: ['  R1 ', ' modify ', path, ' ' + responsibility + ' ', path + ':1'].join(' | ') });
    assert.deepEqual(codes(checkPlan(plan(atByteCap), facts)), []);
    assert.deepEqual(codes(checkPlan(plan(atByteCap + 'x'), facts)), ['row-bytes']);
    const rows = Array.from({ length: 26 }, (_, index) => ['R' + index, 'modify', 'docs/file-' + index + '.md', 'edit', path + ':1'].join(' | '));
    assert.ok(codes(checkPlan(plan(atByteCap) + 'padding\n'.repeat(90), facts)).includes('line-cap'));
    assert.ok(codes(checkPlan(planWith({ ledger: rows.join('\n') }), facts)).includes('row-cap'));
    const tail = (bullets) => plan(atByteCap).replace('- Continue.\n', '- Continue.\n' + '- More.\n'.repeat(bullets));
    assert.deepEqual(checkPlan(tail(5), facts).findings, [], 'Cleanup and Next steps at exactly ten lines, newline-terminated');
    assert.ok(codes(checkPlan(tail(6), facts)).includes('section-cap'));
    assert.ok(codes(checkPlan(planWith({ ledger: rows[0], goal: Array.from({ length: 10 }, () => '- boundary').join('\n') }), facts)).includes('section-cap'));
  });

  it('S3 rejects malformed fields, verbs, delete dashes and duplicate ids (spec:plan-review-loop/S3)', async () => {
    const { checkPlan } = await loadRules();
    const regular = { kind: 'regular', contained: true };
    const facts = factsFor({ pathFacts: { 'docs/readme.md': regular, 'docs/guide.md': regular }, repoFiles: ['docs/readme.md', 'docs/guide.md'] });
    const valid = 'R1 | modify | docs/readme.md | edit it | docs/readme.md:1';
    const judge = (...rows) => codes(checkPlan(planWith({ ledger: rows.join('\n') }), facts));
    assert.deepEqual(judge(valid), []);
    for (const malformed of [valid.slice(0, valid.lastIndexOf(' | ')), valid.replace('modify', 'move'),
      valid.replace('modify', 'delete'), valid.replace('docs/readme.md:1', '—')]) {
      assert.deepEqual(judge(malformed), ['row-grammar'], malformed);
    }
    assert.deepEqual(judge(valid, 'R1 | modify | docs/guide.md | edit it | readme.md:1'), ['duplicate-id']);
  });

  it('S5 resolves an anchor by exact path, then prior component-aligned suffix candidates (spec:plan-review-loop/S5)', async () => {
    const { checkPlan } = await loadRules();
    const ledger = [
      'R1 | modify | docs/readme.md | edit | docs/readme.md:1',
      'R2 | modify | docs/guide.md | edit | readme.md:99',
    ].join('\n');
    const document = { kind: 'regular', inScope: false, contained: true, shipped: false, pinTest: null };
    const pathFacts = { 'docs/readme.md': document, 'docs/guide.md': document, 'other/item.md': document };
    const facts = factsFor({ pathFacts, repoFiles: ['docs/readme.md', 'docs/guide.md'] });
    assert.deepEqual(checkPlan(planWith({ ledger }), facts).findings, []);
    const missing = planWith({ ledger: ledger.replace('readme.md:99', 'missing.md:99') });
    assert.ok(codes(checkPlan(missing, facts)).includes('anchor'));
    const noPrior = [
      'R1 | modify | docs/guide.md | edit | docs/guide.md:1',
      'R2 | modify | other/item.md | edit | readme.md:99',
    ].join('\n');
    const ambiguous = factsFor({ pathFacts, repoFiles: ['docs/readme.md', 'docs/guide.md', 'other/readme.md'] });
    assert.ok(codes(checkPlan(planWith({ ledger: noPrior }), ambiguous)).includes('anchor'));
    assert.deepEqual(checkPlan(planWith({ ledger }), ambiguous).findings, [], 'a row above wins over the repository');
  });

  it('S6 requires a preceding test row for an in-scope source create (spec:plan-review-loop/S6)', async () => {
    const { checkPlan } = await loadRules();
    const source = { kind: 'absent', inScope: true, shipped: false, pinTest: null, contained: true };
    const test = { ...source };
    const withoutTest = 'R2 | create | src/new.mjs | export run | src/existing.mjs:1';
    const withTest = 'R1 | create | src/new.test.mjs | test run | src/existing.mjs:1\nR2 | create | src/new.mjs | export run | src/existing.mjs:1';
    const facts = factsFor({ pathFacts: { 'src/new.mjs': source, 'src/new.test.mjs': test, 'src/existing.mjs': { ...source, kind: 'regular' } }, repoFiles: ['src/existing.mjs'] });
    assert.ok(codes(checkPlan(planWith({ ledger: withoutTest }), facts)).includes('red-first'));
    assert.deepEqual(checkPlan(planWith({ ledger: withTest }), facts).findings, []);
  });

  it('S8 restricts sweeps and requires acceptance bullets plus a governing-spec line (spec:plan-review-loop/S8)', async () => {
    const { checkPlan } = await loadRules();
    const files = ['docs/a.md', 'docs/b.md'];
    const pathFacts = Object.fromEntries(files.map((path) => [path, { kind: 'regular', inScope: false, shipped: false, pinTest: null, contained: true }]));
    const facts = factsFor({ pathFacts, expansions: { 'docs/*.md': files }, repoFiles: files });
    const badSweep = 'R1 | create | docs/*.md | update all sites | docs/a.md:1';
    assert.ok(codes(checkPlan(planWith({ ledger: badSweep, goal: 'No contract.', verification: 'plain prose' }), facts)).includes('sweep'));
    assert.ok(codes(checkPlan(planWith({ ledger: badSweep, goal: 'No contract.', verification: 'plain prose' }), facts)).includes('acceptance'));
    assert.ok(codes(checkPlan(planWith({ ledger: badSweep, goal: 'No contract.', verification: 'plain prose' }), facts)).includes('governing-spec'));
  });

  it('S9 rejects uncontained and multiply-owned paths and wrong kinds without judging budgets (spec:plan-review-loop/S9)', async () => {
    const { checkPlan, verifyPlan, checkPlanStructure } = await loadRules();
    const source = { kind: 'absent', lines: 0, recordedLines: null, inScope: true, contained: true };
    const document = { kind: 'regular', lines: 20, inScope: false, contained: true };
    const facts = factsFor({
      capDeclared: false,
      pathFacts: { 'src/a.mjs': source, 'src/b.mjs': { ...source, kind: 'regular' }, 'docs/readme.md': document },
      expansions: { 'src/*.mjs': ['src/a.mjs'] },
      repoFiles: ['src/a.mjs', 'docs/readme.md'],
    });
    const oldLedger = [
      'R1 | modify | src/a.mjs | edit | n/a | src/a.mjs:1',
      'R2 | modify | docs/readme.md | edit | 500 | docs/readme.md:1',
      'R3 | modify | src/b.mjs | edit | 500 | src/a.mjs:1',
      'total: 0 → 0 lines',
    ].join('\n');
    const sizeCodes = ['cap-declaration', 'source-budget', 'budget-cap', 'before-total'];
    assert.deepEqual([false, true].map((capDeclared) => codes(checkPlan(planWith({ ledger: oldLedger }),
      { ...facts, capDeclared, pathFacts: { ...facts.pathFacts, 'src/a.mjs': { ...source, kind: 'regular' } } }))
      .filter((code) => sizeCodes.includes(code))), [[], []]);

    const ledger = [
      'R1 | modify | src/*.mjs | update (1 files) | src/a.mjs:1',
      'R2 | modify | src/a.mjs | update | src/a.mjs:1',
      'R3 | create | ../escape.mjs | export run | src/a.mjs:1',
    ].join('\n');
    const result = checkPlan(planWith({ ledger }), facts);
    for (const code of ['containment', 'duplicate-path', 'kind']) assert.ok(codes(result).includes(code), code);
    const spellings = ['/src/a.mjs', 'src//a.mjs', './src/a.mjs', 'src/./a.mjs', 'src/a.mjs/', '.', '..', '../escape.mjs', 'src\\a.mjs'];
    for (const judge of [checkPlan, verifyPlan, checkPlanStructure]) {
      for (const path of [...spellings, 'src/a.mjs', 'src/*.mjs']) {
        for (const [rowPath, anchor] of [[path, 'src/a.mjs'], ['src/a.mjs', path]]) {
          const ledger = ['R4', 'modify', rowPath, 'update (1 files)', anchor + ':1'].join(' | ');
          assert.equal(codes(judge(planWith({ ledger }), facts)).includes('containment'), spellings.includes(path), judge.name + ': ' + ledger);
        }
      }
    }
    const valid = ['R1 | modify | src/a.mjs | edit | src/a.mjs:1', 'R2 | modify | docs/readme.md | edit | docs/readme.md:1', 'R3 | modify | src/b.mjs | edit | src/a.mjs:1'];
    const regularFacts = { ...facts, pathFacts: { ...facts.pathFacts, 'src/a.mjs': { ...source, kind: 'regular', lines: 600 } } };
    assert.deepEqual(codes(checkPlan(planWith({ ledger: valid.join('\n') }), regularFacts)), []);
  });

  it('spec:plan-review-loop/S40 refuses retired ledger syntax by name in every judge', async () => {
    const { checkPlan, verifyPlan, checkPlanStructure } = await loadRules();
    const row = 'R1 | modify | docs/readme.md | update | docs/readme.md:1';
    for (const judge of [checkPlan, verifyPlan, checkPlanStructure]) {
      const inspect = (ledger, facts = factsFor()) => judge(planWith({ ledger }), facts);
      for (const [ledger, code, fix] of [
        [LEGACY_ROW, 'retired-size-field', /drop.*(?:fifth|size) field/i],
        [row + '\ntotal: 0 → 0 lines', 'retired-total-line', /\bdrop\b.*\b(?:it|line|total)\b/i],
        [row + '\n  total: a | b | c | d | e | f', 'retired-total-line', /\bdrop\b.*\b(?:it|line|total)\b/i],
      ]) {
        const { findings } = inspect(ledger);
        assert.deepEqual(findings.map((finding) => finding.code), [code], judge.name + ': ' + ledger);
        assert.match(findings[0].message, fix);
      }
      const deletion = 'R1 | delete | docs/readme.md | remove the document | —';
      const kind = judge === verifyPlan ? 'absent' : 'regular';
      assert.deepEqual(codes(inspect(deletion, factsFor({ pathFacts: { 'docs/readme.md': { kind, contained: true } } }))), []);
    }
  });

  it('spec:plan-structure/S6 judges amendment kinds, sweeps, caps, entry grammar and story ownership', async () => {
    const { checkPlan, verifyPlan, checkPlanStructure } = await loadRules();
    const row = (id, verb, path, responsibility = 'update') =>
      [id, verb, path, responsibility, verb === 'delete' ? '—' : 'src/a.mjs:1'].join(' | ');
    const buildPlan = (approved, entries = [], goal) => planWith({
      goal, ledger: [...approved, ...(entries.length ? ['amendments:', ...entries] : [])].join('\n'),
    });
    const files = ['src/a.mjs', 'src/b.mjs'];
    const sweepPath = 'src/*.mjs';
    const sweep = row('R1', 'modify', sweepPath, 'update (2 files)');
    const regular = { kind: 'regular', contained: true };
    const pathFacts = Object.fromEntries(files.map((path) => [path, regular]));
    const facts = factsFor({ pathFacts, repoFiles: files, expansions: { [sweepPath]: files } });
    const create = row('A1', 'create', files[1]);
    const amended = buildPlan([sweep], [create]);
    const crlf = amended.replaceAll('\n', '\r\n');
    const crlfAmendmentCheck = checkPlan(crlf, facts).findings.filter(({ code }) => code === 'amendment-check');
    const separatorLine = crlf.split('\r\n').indexOf('amendments:') + 1;
    assert.deepEqual(crlfAmendmentCheck.map(({ code, line }) => ({ code, line })), [{ code: 'amendment-check', line: separatorLine }]);
    assert.ok(codes(checkPlan(amended, facts)).includes('amendment-check'));
    const approved = Array.from({ length: 25 }, (_, index) => row('R' + index, 'modify', 'docs/approved-' + index + '.md'));
    const entries = Array.from({ length: 80 }, (_, index) => row('A' + index, 'modify', 'docs/entry-' + index + '.md'));
    for (const selected of [entries.slice(0, 1), entries]) {
      assert.deepEqual(codes(checkPlanStructure(buildPlan(approved, selected), facts)), []);
    }
    const beforeCreate = {
      ...facts, expansions: { [sweepPath]: [files[0]] }, pathFacts: { ...pathFacts, [files[1]]: { kind: 'absent', contained: true } },
    };
    for (const plan of [amended, buildPlan([sweep, create])]) {
      assert.deepEqual(codes(checkPlanStructure(plan, beforeCreate)), []);
      assert.deepEqual(checkPlanStructure(plan, facts).findings.map(({ code, rowId }) => [code, rowId]), [['duplicate-path', 'A1']]);
    }
    const wrongCount = buildPlan([sweep.replace('(2 files)', '(3 files)')]);
    assert.deepEqual(codes(checkPlan(wrongCount, facts)), ['sweep-count']);

    const stories = [['ALPHA', 'docs/owned.md'], ['BETA', 'docs/readme.md']].map(([epic, path]) => ({
      path: 'docs/ai/epics/' + epic + '.md', id: 'S1', line: 20, state: 'planned',
      claims: [{ field: 'owns', path, ground: expandClaim(path) }], reachable: new Set(),
    }));
    const goal = '- Spec: docs/ai/specs/example.md\nStory: S1 of BETA';
    const storyFacts = factsFor({ stories, landedEpics: [], storeRefusal: null });
    const approvedRow = row('R1', 'modify', 'docs/readme.md');
    const details = (result) => result.findings.map(({ code, rowId }) => [code, rowId]);
    assert.deepEqual(details(checkPlanStructure(buildPlan([approvedRow], [row('A1', 'modify', files[0], 'x'.repeat(201))]), facts)), [['row-bytes', 'A1']]);
    assert.deepEqual(details(checkPlanStructure(buildPlan([approvedRow], ['A1 | modify | src/a.mjs | update']), facts)), [['row-grammar', 'A1']]);
    assert.deepEqual(details(checkPlanStructure(buildPlan([approvedRow], [row('A1', 'modify', 'docs/owned.md')], goal), storyFacts)), [['story-owns', 'A1']]);
    for (const verb of ['create', 'modify', 'delete']) {
      const plan = buildPlan([row('R1', 'modify', files[0])], [row('A1', verb, files[1])]);
      for (const kind of ['regular', 'absent']) {
        const observed = { ...facts, pathFacts: { ...pathFacts, [files[1]]: { ...regular, kind } } };
        assert.deepEqual(details(verifyPlan(plan, observed)), kind === (verb === 'delete' ? 'absent' : 'regular') ? [] : [['post-kind', 'A1']]);
      }
    }
  });

  it('spec:plan-structure/S10 refuses every repeated amendment path, including package pins', async () => {
    const { checkPlanStructure } = await loadRules();
    const path = 'src/a.mjs';
    const sweepPath = 'src/*.mjs';
    const facts = factsFor({ expansions: { [sweepPath]: [path, 'src/b.mjs'], 'test/*.test.mjs': [PIN_PATH] } });
    const row = (id, verb, target, responsibility = 'update') =>
      [id, verb, target, responsibility, verb === 'delete' ? '—' : 'docs/readme.md:1'].join(' | ');
    const approved = row('R1', 'modify', 'docs/readme.md');
    const plan = (rows, entries) => planWith({ ledger: [...rows, 'amendments:', ...entries].join('\n') });
    const legacy = planWith({ ledger: ledgerOf([
      'R1 | modify | src/a.mjs | update | 100 | docs/readme.md:1',
      'amendments:',
      'A1 | modify | src/a.mjs | update | 150 | docs/readme.md:1',
    ].join('\n')) });
    assert.notDeepEqual(codes(checkPlanStructure(legacy, facts)), [], 'a higher size field cannot authorize a path amendment');
    for (const verb of ['create', 'modify', 'delete']) {
      assert.deepEqual(codes(checkPlanStructure(plan([approved], [row('A1', verb, 'docs/missed.md')]), facts)), []);
      for (const [rows, preceding, target] of [
        [[row('R1', 'modify', path)], [], path],
        [[row('R1', 'modify', sweepPath, 'update (2 files)')], [], path],
        [[approved], [row('A1', 'modify', path)], path],
        [[row('R1', 'modify', PIN_PATH)], [], PIN_PATH],
        [[row('R1', 'modify', 'test/*.test.mjs', 'update (1 files)')], [], PIN_PATH],
        [[approved], [row('A1', 'modify', PIN_PATH)], PIN_PATH],
      ]) {
        const result = checkPlanStructure(plan(rows, [...preceding, row('A2', verb, target)]), facts);
        assert.deepEqual(result.findings.map(({ code, rowId }) => [code, rowId]), [['duplicate-path', 'A2']], target + ' ' + verb);
      }
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
