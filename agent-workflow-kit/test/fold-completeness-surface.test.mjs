// fold-completeness-surface.test.mjs — the user-facing fold-completeness surface stays in step with
// the shipped behavior (BUGFREE-1 / AD-047, codex R3: an agent following a stale mode-ref folds the
// fix BEFORE observing red and lands in the no-receipt refusal). Test-as-spec over the mode-ref: the
// operational contract (the fold-time order, --red, the D4 knobs, quarantine, custody) must be
// documented in the SAME artifact set that ships the behavior.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMANDS } from '../tools/commands.mjs';

const doc = readFileSync(new URL('../references/modes/fold-completeness.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const rlDoc = readFileSync(new URL('../references/modes/review-ledger.md', import.meta.url), 'utf8');

describe('fold-completeness mode-ref — the observed-red operational contract', () => {
  it('the fold-completeness mode-ref documents the observed-red fold-time order', () => {
    // The order itself: red is observed BEFORE the fix is folded.
    assert.match(doc, /--red/, 'the --red verb must be documented');
    assert.match(doc, /observed[- ]red/i, 'the observed-red receipt vocabulary must appear');
    assert.match(doc, /BEFORE the fix/i, 'the doc must state that red is observed BEFORE the fix is applied');
    // The stale one-run claim must be gone.
    assert.doesNotMatch(doc, /probe each bound testId once/, 'the single-probe wording is the pre-v2 contract');
  });

  it('the mode-ref names the D4 knobs, quarantine, and custody', () => {
    assert.match(doc, /AW_FOLD_RERUNS/, 'the rerun knob must be documented');
    assert.match(doc, /AW_FOLD_PROBE_TIMEOUT_S/, 'the per-run probe timeout knob must be documented');
    assert.match(doc, /QUARANTINE/, 'the mixed/timeout quarantine verdict must be documented');
    assert.match(doc, /custody/i, 'the content-custody requirement must be documented');
  });

  it('both mode-refs document the override lanes (oracle-change / red-proof)', () => {
    assert.match(doc, /oracle-change/, 'the fold mode-ref must name the tamper override lane');
    assert.match(doc, /red-proof/, 'the fold mode-ref must name the red-proof waiver lane');
    assert.match(rlDoc, /override/, 'the review-ledger mode-ref must document the override verb');
    assert.match(rlDoc, /oracle-change/, 'the review-ledger mode-ref must name both scopes');
    assert.match(rlDoc, /red-proof/, 'the review-ledger mode-ref must name both scopes');
  });

  // codex R4 (BUGFREE-1 live loop): the README row and the catalog one-liners still sold the old
  // green-baseline-only contract — every user-facing summary states (or defers to) the v2 contract.
  it('the README fold-completeness row states the observed-red contract', () => {
    assert.match(readme, /observed-red/, 'the README must mention the observed-red receipt requirement');
    assert.doesNotMatch(readme, /resolves \+ starts GREEN/, 'the green-baseline-only wording is the pre-v2 contract');
    // codex R8: state the exceptions too — a summary that omits the shipped waiver lanes oversells.
    assert.match(readme, /red-proof/, 'the README must mention the red-proof waiver exception');
    assert.match(readme, /oracle-change/, 'the README must mention the oracle-change tamper override');
  });

  it('the catalog one-liners state the v2/v3 contracts', () => {
    const fold = COMMANDS.find((c) => c.key === 'fold-completeness');
    assert.match(fold.oneLine, /observed-red|seen failing/i, 'the fold one-liner must mention the red proof');
    assert.doesNotMatch(fold.oneLine, /starts green/, 'the starts-green wording is the pre-v2 contract');
    const ledger = COMMANDS.find((c) => c.key === 'review-ledger');
    assert.match(ledger.oneLine, /override/, 'the ledger one-liner must mention the override verb');
  });
});
