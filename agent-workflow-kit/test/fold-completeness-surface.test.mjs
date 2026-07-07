// fold-completeness-surface.test.mjs — the user-facing fold-completeness surface stays in step with
// the shipped behavior (BUGFREE-1 / AD-047, codex R3: an agent following a stale mode-ref folds the
// fix BEFORE observing red and lands in the no-receipt refusal). Test-as-spec over the mode-ref: the
// operational contract (the fold-time order, --red, the D4 knobs, quarantine, custody) must be
// documented in the SAME artifact set that ships the behavior.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = readFileSync(new URL('../references/modes/fold-completeness.md', import.meta.url), 'utf8');

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
});
