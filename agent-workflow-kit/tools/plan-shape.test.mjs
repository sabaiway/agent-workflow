import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { codes, planWith } from './plan-shape-harness.test.mjs';

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
    const { checkPlan } = await loadRules();
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
    const noBudget = checkPlan(planWith({ ledger: 'R4 | modify | src/a.mjs | update | n/a | src/a.mjs:1\ntotal: 0 → 0 lines' }), { ...facts, capDeclared: true });
    assert.ok(codes(noBudget).includes('source-budget'));
  });

  it('S4/S29 validates the one robust tag grammar and listed classes, leaving an untagged row unjudged (spec:robustness-literals/S4, spec:plan-review-loop/S29)', async () => {
    const { checkPlan } = await loadRules();
    const judge = (responsibility) => checkPlan(planWith({
      ledger: `R1 | modify | docs/readme.md | ${responsibility} | n/a | docs/readme.md:1\ntotal: 0 → 0 lines`,
    }), factsFor({ robustClasses: ['a'] }));
    for (const responsibility of [
      'prove robust:no-such-class', 'prove robust:', 'prove robust:a,', 'prove robust:a,a',
      'prove robust:Not-A-Slug', 'prove robust:a and robust:b',
    ]) assert.ok(codes(judge(responsibility)).includes('robust-class'), responsibility);
    assert.equal(codes(judge('prove robust:a')).includes('robust-class'), false);
    assert.equal(codes(judge('ordinary untagged row')).includes('robust-class'), false);
    assert.ok(codes(judge(`${'x'.repeat(190)} robust:a`)).includes('row-bytes'), 'the tag counts toward 200 bytes');
  });
});
