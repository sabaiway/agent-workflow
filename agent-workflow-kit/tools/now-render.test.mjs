import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { auditQueue } from './queue-audit.mjs';
import { parseLedger } from './plan-shape.mjs';

const loadRender = () => import('./now-render.mjs').catch(() => ({}));
const makePlanText = () => [
  '# Plan: render fixture',
  '',
  '## Goal and boundary',
  '',
  'Render facts.',
  '',
  '## Module ledger',
  '',
  'n01 | create | src/landed.mjs | Add landed | 40 | src/base.mjs:1',
  'n02 | modify | src/progress.mjs | Edit progress | 40 | src/base.mjs:1',
  'n03 | create | src/pending.mjs | [x] Claimed complete | 40 | src/base.mjs:1',
  'n04 | modify | docs/ai/state.md | Edit excluded state | n/a | docs/ai/base.md:1',
  'total: 10 → 14 lines',
  '',
  '## Verification',
  '',
  '- Verify.',
  '',
  '## Phase: Cleanup',
  '',
  '- Clean.',
  '',
  '## Next steps',
  '',
  '- Continue.',
  '',
].join('\n');
const makePlan = () => {
  const parsed = parseLedger(makePlanText());
  const evidence = [
    { path: 'src/landed.mjs', pathFact: { kind: 'regular', lines: 44 }, staged: false, unstaged: false, untracked: false, excluded: false },
    { path: 'src/progress.mjs', pathFact: { kind: 'regular', lines: 20 }, staged: false, unstaged: true, untracked: false, excluded: false },
    { path: 'src/pending.mjs', pathFact: { kind: 'absent', lines: 0 }, staged: false, unstaged: false, untracked: false, excluded: false },
    { path: 'docs/ai/state.md', pathFact: { kind: 'regular', lines: 20 }, staged: false, unstaged: false, untracked: false, excluded: true },
  ];
  return {
    path: 'docs/plans/render-fixture.md',
    parsed,
    parseError: null,
    rows: parsed.rows.map((row, index) => ({ row, raw: row.raw, evidence: evidence[index] })),
  };
};
const makeTree = () => ({
  fingerprint: 'tree-abc',
  clean: false,
  verdicts: [{ backend: 'codex', line: 'codex: ship for tree-abc' }],
  finalRun: { status: 'RED', gates: '1/2', fingerprintBefore: 'tree-abc', timestamp: '2026-09-05T12:00:00Z', coverage: 'coverage=certified' },
  redProofs: [{ path: 'src/landed.mjs', currency: 'current' }],
});
const makeQueue = () => auditQueue([
  '---',
  'title: queue fixture',
  '---',
  '',
  '- **Leading work item — id `LEAD-ID`, queued 2026-09-01.** Body.',
  '',
  '### Pending / backlog',
  '',
  '- **ONLY-ID — queued 2026-09-01.** Body.',
  '',
  '##  Pending / backlog ##',
  '',
  '### Active work',
  '',
  '- **Priority work item — id `PRIORITY-ID`, queued 2026-09-01.** Body.',
  '',
  '## History',
  '',
  '### Pending / backlog',
  '',
  '- **Archived work item — id `ARCHIVE-ID`, queued 2026-09-01.** Body.',
  '- **DONE 2026-09-01 — Retired work item — id `TERMINAL-ID`.** Closed.',
  '',
].join('\n'));
const makeFacts = (overrides = {}) => {
  const queue = makeQueue();
  return {
    plans: { entries: [makePlan()] },
    tree: makeTree(),
    queue: { path: 'docs/plans/queue.md', rows: queue.rows, counts: queue.counts, total: queue.total },
    campaign: { state: 'minted', maxLines: 400, maxLineBytes: 1000, roots: 5, recordedFiles: 7, aggregateLines: 3200 },
    ...overrides,
  };
};
const sumCounts = (buckets) => buckets.reduce((counts, bucket) => {
  for (const [klass, count] of Object.entries(bucket.counts)) counts[klass] = (counts[klass] ?? 0) + count;
  return counts;
}, {});

describe('now render', () => {
  // spec:now/S9
  it('folds queue rows by their full heading path, preserving leading and namesake archive buckets', async () => {
    const { toNowViewModel, renderNow } = await loadRender();
    assert.equal(typeof toNowViewModel, 'function');
    assert.equal(typeof renderNow, 'function');
    const facts = makeFacts();
    const vm = toNowViewModel(facts);
    assert.equal(vm.queue.buckets.length, 4);
    assert.equal(vm.queue.buckets[0].label, 'document');
    assert.equal(vm.queue.buckets[0].order, 'position');
    assert.equal(vm.queue.buckets[1].order, 'position');
    assert.equal(vm.queue.buckets[2].order, 'priority');
    assert.equal(vm.queue.buckets[3].order, 'position');
    assert.notEqual(vm.queue.buckets[1].label, vm.queue.buckets[3].label);
    assert.deepEqual(sumCounts(vm.queue.buckets), facts.queue.counts);
    const names = vm.queue.buckets.flatMap(({ rows }) => rows.map(({ name }) => name));
    assert.deepEqual(names, ['Leading work item', 'unnamed (line 9)', 'Priority work item', 'Archived work item']);
    const plain = renderNow(vm, { mode: 'plain', width: 80, color: false, ascii: false });
    assert.doesNotMatch(plain, /LEAD-ID|ONLY-ID|PRIORITY-ID|ARCHIVE-ID|TERMINAL-ID|Retired work item/);
    assert.match(plain, /archive · .*position 1/);
    assert.match(plain, /priority · .*priority 1/);
  });

  // spec:now/S10
  it('renders campaign states, evidence and annotations on every step, plus one-line withheld blocks', async () => {
    const { toNowViewModel, renderNow } = await loadRender();
    assert.equal(typeof toNowViewModel, 'function');
    const vm = toNowViewModel(makeFacts({ queue: { withheld: 'queue unreadable' } }));
    assert.deepEqual(vm.steps.entries[0].rows.map(({ status }) => status), ['landed', 'in progress', 'pending', 'unjudged']);
    for (const row of vm.steps.entries[0].rows) {
      assert.equal(typeof row.evidenceSource, 'string');
      assert.ok(Array.isArray(row.annotations));
    }
    assert.deepEqual(vm.queue, { withheld: 'queue unreadable' });
    const plain = renderNow(vm, { mode: 'plain', width: 80, color: false, ascii: false });
    assert.match(plain, /CAMPAIGN[\s\S]*state: minted[\s\S]*caps: 400 lines · 1000 bytes per line[\s\S]*roots: 5 · recorded files: 7 · aggregate lines: 3200/);
    assert.match(plain, /landed \[path fact\].*over budget 44\/40.*red-proof current/);
    assert.match(plain, /in progress: n02 · src\/progress\.mjs — in progress \[changed set\]/);
    assert.match(plain, /in progress \[changed set\]/);
    assert.match(plain, /pending \[path fact\].*claimed done/);
    assert.match(plain, /unjudged \[exclusion fact\].*excluded from git here/);
    assert.equal(plain.split('\n').filter((line) => line.includes('QUEUE — WITHHELD: queue unreadable')).length, 1);

    const absent = toNowViewModel(makeFacts({ campaign: { state: 'absent' } }));
    assert.match(renderNow(absent, { mode: 'plain', width: 80, color: false, ascii: true }), /CAMPAIGN[\s\S]*state: absent/);
    const ansi = renderNow(vm, { mode: 'ansi', width: 100, color: true, ascii: false });
    assert.match(ansi, /\u001b\[1mNOW\u001b\[0m/);
    assert.match(ansi, /✓.*landed/);
    assert.equal(renderNow(vm, { mode: 'json', width: 80, color: false, ascii: false }), '');
  });

  it('annotates a red-proof through the canonical path the facts carry, so a row spelled with a dot-slash still reads it', async () => {
    const { toNowViewModel, renderNow } = await loadRender();
    assert.equal(typeof toNowViewModel, 'function');
    const plan = makePlan();
    plan.rows[0] = { ...plan.rows[0], row: { ...plan.rows[0].row, path: './src/landed.mjs' } };
    const vm = toNowViewModel(makeFacts({ plans: { entries: [plan] } }));
    assert.ok(vm.steps.entries[0].rows[0].annotations.some(({ kind }) => kind === 'red-proof'));
    const plain = renderNow(vm, { mode: 'plain', width: 80, color: false, ascii: false });
    assert.match(plain, /n01 · \.\/src\/landed\.mjs — landed \[path fact\].*red-proof current/);
  });

  it('keeps the plan half of NOW when the tree is withheld, names the final run by its verdict, and drops the red-proof annotation with the tree', async () => {
    const { toNowViewModel, renderNow } = await loadRender();
    assert.equal(typeof toNowViewModel, 'function');
    const whole = renderNow(toNowViewModel(makeFacts()), { mode: 'plain', width: 80, color: false, ascii: true });
    assert.match(whole, /final run: RED 1\/2 gates \u00b7 tree-abc \u00b7 2026-09-05T12:00:00Z \u00b7 coverage=certified/);
    const vm = toNowViewModel(makeFacts({ tree: { withheld: 'the review receipts store is malformed or unreadable (1 malformed line)' } }));
    assert.equal(vm.now.plans[0].phase.name, 'ledger');
    assert.deepEqual(vm.now.tree, { withheld: 'the review receipts store is malformed or unreadable (1 malformed line)' });
    assert.deepEqual(vm.steps.entries[0].rows[0].annotations.map(({ kind }) => kind), ['anomaly']);
    const plain = renderNow(vm, { mode: 'plain', width: 80, color: false, ascii: true });
    assert.match(plain, /NOW\n {2}plan: docs\/plans\/render-fixture\.md\n {4}phase: ledger[\s\S]*\n {2}tree \u2014 WITHHELD: the review receipts store/);
    assert.doesNotMatch(plain, /NOW \u2014 WITHHELD|red-proof/);
  });

  it('keeps the tree half when the plans are withheld, and withholds NOW itself only when both halves are, naming every cause once', async () => {
    const { toNowViewModel, renderNow } = await loadRender();
    assert.equal(typeof toNowViewModel, 'function');
    const surface = { mode: 'plain', width: 80, color: false, ascii: true };
    const plansOut = toNowViewModel(makeFacts({ plans: { withheld: 'the plans in flight: no practice' } }));
    assert.deepEqual([plansOut.now.plans, plansOut.steps], [{ withheld: 'the plans in flight: no practice' }, { withheld: 'the plans in flight: no practice' }]);
    assert.equal(plansOut.now.tree.fingerprint, 'tree-abc');
    assert.match(renderNow(plansOut, surface), /NOW\n {2}plans \u2014 WITHHELD: the plans in flight: no practice\n {2}tree: tree-abc/);
    const both = toNowViewModel(makeFacts({ plans: { withheld: 'plans gone' }, tree: { withheld: 'tree gone' } }));
    assert.deepEqual(both.now, { withheld: 'plans gone \u00b7 tree gone' });
    const same = toNowViewModel(makeFacts({ plans: { withheld: 'not a git work tree' }, tree: { withheld: 'not a git work tree' } }));
    assert.deepEqual(same.now, { withheld: 'not a git work tree' });
  });

  it('renders a plan the facts could not parse as its cause in NOW and a withheld STEPS entry, never a pick', async () => {
    const { toNowViewModel, renderNow } = await loadRender();
    assert.equal(typeof toNowViewModel, 'function');
    const broken = { path: 'docs/plans/broken.md', parsed: null, parseError: 'no ledger here', rows: [], phases: [] };
    const vm = toNowViewModel(makeFacts({ plans: { entries: [makePlan(), broken] } }));
    assert.deepEqual(vm.now.plans.map(({ path }) => path), ['docs/plans/render-fixture.md', 'docs/plans/broken.md']);
    assert.equal(vm.now.plans[1].phase, null);
    const plain = renderNow(vm, { mode: 'plain', width: 80, color: false, ascii: true });
    assert.match(plain, /NOW[\s\S]*plan: docs\/plans\/broken\.md\n {4}\S+ could not parse: no ledger here/);
    assert.match(plain, /STEPS[\s\S]*plan: docs\/plans\/broken\.md\n {4}WITHHELD: no ledger here/);
  });
});
