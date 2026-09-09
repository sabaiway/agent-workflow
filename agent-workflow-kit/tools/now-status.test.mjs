import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLedger } from './plan-shape.mjs';

const loadStatus = () => import('./now-status.mjs').catch(() => ({}));
const makeRow = (overrides = {}) => {
  const row = {
    id: 'n01',
    verb: 'create',
    path: 'src/new.mjs',
    responsibility: 'Build the reader.',
    budgetLines: 40,
    ...overrides,
  };
  return { ...row, raw: overrides.raw ?? `${row.id} | ${row.verb} | ${row.path} | ${row.responsibility} | 40 | src/anchor.mjs:1` };
};
const makeEvidence = (overrides = {}) => ({
  pathFact: { kind: 'absent', lines: 0 },
  staged: false,
  unstaged: false,
  untracked: false,
  excluded: false,
  ...overrides,
});
const makePlan = () => parseLedger([
  '# Plan: fixture',
  '',
  '## Goal and boundary',
  '',
  'Goal.',
  '',
  '## Module ledger',
  '',
  'n01 | create | src/a.mjs | Add A | 40 | src/base.mjs:1',
  'n02 | modify | src/b.mjs | Change B | 40 | src/base.mjs:1',
  'n03 | delete | src/c.mjs | Remove C | — | —',
  'total: 3 → 3 lines',
  '',
  '## Verification',
  '',
  '- Verify.',
  '',
  '## Phase: Release Publishing',
  '',
  '- Publish packages.',
  '- Verify publication.',
  '',
  '## Phase: Cleanup',
  '',
  '- Clean state.',
  '',
  '## Next steps',
  '',
  '- Continue.',
  '',
].join('\n'));

describe('now status rules', () => {
  // spec:now/S1
  it('holds status to path, verb and evidence while a contradicted checked claim stays an annotation', async () => {
    const { NOW_STATUS, NOW_ANNOTATION, judgeRow } = await loadStatus();
    assert.equal(typeof judgeRow, 'function');
    assert.deepEqual(Object.values(NOW_STATUS), ['landed', 'in progress', 'pending', 'unjudged']);
    assert.deepEqual(Object.values(NOW_ANNOTATION), ['claim', 'anomaly', 'red-proof']);
    const cases = [
      [makeRow(), makeEvidence({ pathFact: { kind: 'regular', lines: 20 } }), 'landed'],
      [makeRow({ verb: 'modify' }), makeEvidence({ pathFact: { kind: 'regular', lines: 20 }, staged: true }), 'in progress'],
      [makeRow(), makeEvidence(), 'pending'],
      [makeRow({ verb: 'modify' }), makeEvidence({ pathFact: { kind: 'regular', lines: 20 } }), 'unjudged'],
    ];
    for (const [row, evidence, expected] of cases) {
      const edited = makeRow({ id: row.id, verb: row.verb, path: row.path, budgetLines: row.budgetLines, responsibility: 'Rewrite every responsibility word.' });
      assert.deepEqual([judgeRow(row, evidence).status, judgeRow(edited, evidence).status], [expected, expected]);
    }
    const claimed = judgeRow(makeRow({ responsibility: '[x] Declared complete.' }), makeEvidence());
    assert.equal(claimed.status, 'pending');
    assert.equal(claimed.evidenceSource, 'path fact');
    assert.deepEqual(claimed.annotations, [{ kind: 'claim', text: 'claimed done' }]);
  });

  // spec:now/S2
  it('does not read a quoted terminal marker as a claim or move the evidence-derived status', async () => {
    const { readProseClaim, judgeRow } = await loadStatus();
    assert.equal(typeof readProseClaim, 'function');
    const responsibility = 'Treat `DONE 2026-01-01` as parser input.';
    const row = makeRow({ verb: 'modify', responsibility, path: 'src/parser.mjs' });
    assert.equal(readProseClaim(row.raw), null);
    assert.equal(readProseClaim(makeRow({ responsibility: 'DONE 2026-01-01 — complete.' }).raw), 'done');
    const judged = judgeRow(row, makeEvidence({ pathFact: { kind: 'regular', lines: 20 }, unstaged: true }));
    assert.equal(judged.status, 'in progress');
    assert.deepEqual(judged.annotations, []);
  });

  // spec:now/S3
  it('reduces the changed set in order and covers every arm-3 path-fact cell', async () => {
    const { judgeRow } = await loadStatus();
    assert.equal(typeof judgeRow, 'function');
    const cells = [
      ['create', 'regular', 'landed'],
      ['modify', 'regular', 'unjudged'],
      ['delete', 'regular', 'pending'],
      ['create', 'absent', 'pending'],
      ['modify', 'absent', 'pending'],
      ['delete', 'absent', 'landed'],
    ];
    for (const [verb, kind, expected] of cells) {
      const judged = judgeRow(makeRow({ verb }), makeEvidence({ pathFact: { kind, lines: 20 } }));
      assert.equal(judged.status, expected, `${verb}/${kind}`);
    }
    const both = judgeRow(makeRow({ verb: 'modify' }), makeEvidence({ pathFact: { kind: 'regular', lines: 20 }, staged: true, unstaged: true }));
    assert.equal(both.status, 'in progress');
    assert.equal(both.detail, 'staged, unstaged');
    const editedTest = judgeRow(makeRow({ verb: 'create', path: 'src/new.test.mjs' }), makeEvidence({ pathFact: { kind: 'regular', lines: 20 }, unstaged: true }));
    assert.equal(editedTest.status, 'in progress');
    assert.equal(editedTest.evidenceSource, 'changed set');
    const sweep = judgeRow(makeRow({ verb: 'modify', path: 'src/**' }), makeEvidence({ pathFact: { kind: 'sweep', members: 3 } }));
    assert.deepEqual([sweep.status, sweep.detail], ['unjudged', 'no base-motion reader']);
    const offGrammar = judgeRow(makeRow({ verb: 'create', path: 'src/**' }), makeEvidence({ pathFact: { kind: 'sweep', members: 3 } }));
    assert.deepEqual([offGrammar.status, offGrammar.detail], ['unjudged', 'a sweep row is judged as a set only under modify']);
    const offGrammarStaged = judgeRow(makeRow({ verb: 'create', path: 'src/**' }), makeEvidence({ pathFact: { kind: 'sweep', members: 3 }, staged: true }));
    assert.deepEqual([offGrammarStaged.status, offGrammarStaged.detail, offGrammarStaged.evidenceSource], ['unjudged', 'a sweep row is judged as a set only under modify', 'path fact']);
  });

  // spec:now/S4
  it('keeps a clean present modify row unjudged and names the missing fact', async () => {
    const { judgeRow } = await loadStatus();
    assert.equal(typeof judgeRow, 'function');
    const row = makeRow({ verb: 'modify', path: 'docs/ai/state.md' });
    const cases = [
      [true, 'excluded from git here, no changed-set evidence'],
      [false, 'no base-motion reader'],
    ];
    for (const [excluded, detail] of cases) {
      const judged = judgeRow(row, makeEvidence({ pathFact: { kind: 'regular', lines: 20 }, excluded }));
      assert.equal(judged.status, 'unjudged');
      assert.notEqual(judged.status, 'landed');
      assert.equal(judged.detail, detail);
      assert.equal(judged.evidenceSource, 'exclusion fact');
    }
  });

  // spec:now/S5
  it('derives ledger markers, then advances a landed ledger to unjudged phase bullets', async () => {
    const { NOW_STATUS, derivePhase } = await loadStatus();
    assert.equal(typeof derivePhase, 'function');
    const parsed = makePlan();
    const statuses = ['in progress', 'pending', 'in progress'];
    const judged = parsed.rows.map((row, index) => ({ row, status: statuses[index], evidenceSource: 'changed set', annotations: [] }));
    const ledger = derivePhase(parsed, judged);
    assert.equal(ledger.name, 'ledger');
    assert.deepEqual(ledger.inProgress.map(({ row }) => row.id), ['n01', 'n03']);
    assert.equal(ledger.current.row.id, 'n02');
    assert.equal(ledger.next.row.id, 'n03');

    const empty = derivePhase(parsed, []);
    assert.deepEqual([empty.name, empty.current, empty.next], ['ledger', null, null]);
    const landed = derivePhase(parsed, parsed.rows.map((row) => ({ row, status: 'landed', evidenceSource: 'path fact', annotations: [] })));
    assert.equal(landed.name, 'Release Publishing');
    assert.deepEqual(landed.steps.map(({ status }) => status), [NOW_STATUS.UNJUDGED, NOW_STATUS.UNJUDGED]);
    assert.equal(landed.current.name, 'Publish packages.');
    assert.equal(landed.next.name, 'Verify publication.');
  });
});
