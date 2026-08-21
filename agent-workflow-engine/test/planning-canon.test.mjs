import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const planning = readFileSync(join(ROOT, 'references', 'planning.md'), 'utf8');
const flat = planning.replace(/\s+/g, ' ');

// Pins the FEW rules a plan cannot lose, never the wording around them. The prior version asserted
// ~40 sentences, which made every past clause undeletable — that is why the canon reached 152 lines
// and produced a 690-line plan for a 587-line change. A rule earns a pin here only when its loss
// would let a plan grow again.
describe('planning.md — the plan shape', () => {
  it('caps the plan by BOTH lines and bytes, and budgets its three sections', () => {
    assert.match(flat, /capped at \*\*100 lines and 8000 bytes\*\*/, 'a line cap alone is paid off with longer lines');
    for (const [heading, budget] of [['Goal and boundary', 10], ['Module ledger', 60], ['Verification', 20]]) {
      assert.match(flat, new RegExp(`\\*\\*${heading}\\*\\* \\(${budget} lines\\)`), `${heading} carries its budget`);
    }
    assert.match(flat, /never by document size/, 'an over-cap plan splits on verifiable boundaries, not on length');
  });

  it('pins the literal headings tooling extracts by exact match — the skeleton lines ARE the bare headings', () => {
    assert.match(flat, /headings are LITERAL/);
    // A plan copied from the skeleton must pass an exact-match extractor as copied: no annotation,
    // budget or arrow may ride on a heading line.
    const skeleton = planning.split('```')[1].trim().split('\n');
    assert.deepEqual(skeleton, [
      '# Plan: <title>',
      '## Goal and boundary',
      '## Module ledger',
      '## Verification',
      '## Phase: Cleanup',
      '## Next steps',
    ]);
  });

  it('makes the ledger decide layout before any file exists, and bounds the row itself', () => {
    assert.match(flat, /check-id/, 'a row carries the id its one validator checks');
    assert.match(flat, /create\|modify\|delete/, 'a deletion row is expressible');
    assert.match(flat, /≤200 bytes per row/, 'the row cannot absorb the complexity the cap removed');
    assert.match(flat, /never an invented number/, 'a project without a declared cap gets no hallucinated limit');
  });

  it('budgets the TOTAL, not only each file — the growth loophole', () => {
    assert.match(flat, /total: <before> → <after> lines/);
    assert.match(flat, /the per-file budget cannot see that/, 'states WHY a per-file cap is not enough');
    assert.match(flat, /Growth is allowed only with a stated reason/);
  });

  it('gives a wide mechanical change one legal row instead of a split', () => {
    assert.match(flat, /A SWEEP is one row/);
    assert.match(flat, /costs more prose than the sweep/, 'states why splitting a sweep is the worse option');
  });

  it('validates the ledger with ONE command, not an assertion per row', () => {
    assert.match(flat, /validated by ONE command/);
    assert.match(flat, /Per-row assertions in prose are the repetition/);
  });

  it('makes the rows the steps — no second execution model', () => {
    assert.match(flat, /The rows ARE the steps/);
    assert.match(flat, /no separate step\/phase numbering/);
  });

  it('owes a create row its exported surface — the one thing not derivable from the checkout', () => {
    assert.match(flat, /exported surface/);
    assert.match(flat, /cannot be derived from it/);
  });

  it('keeps review subtractive and un-run logic out of plan prose', () => {
    assert.match(flat, /Review asks what to cut, not what is missing/);
    assert.match(flat, /deleting at least as many lower-value lines/);
    assert.match(flat, /prose has no checker/);
  });

  it('keeps plan files ephemeral, never committed, and always cleaned up', () => {
    assert.match(flat, /never committed/);
    assert.match(flat, /Every plan ends with `## Phase: Cleanup`/);
  });
});
