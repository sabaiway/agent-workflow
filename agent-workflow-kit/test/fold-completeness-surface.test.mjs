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

// ── the SEGMENT surface (BUGFREE-2 / AD-048): every user-facing summary states the v4 contract ──

const gatesDoc = readFileSync(new URL('../references/modes/gates.md', import.meta.url), 'utf8');
const velocityDoc = readFileSync(new URL('../references/modes/velocity.md', import.meta.url), 'utf8');
const proceduresSrc = readFileSync(new URL('../tools/procedures.mjs', import.meta.url), 'utf8');

describe('segment surface (AD-048) — mode-refs, README, one-liners, advisor', () => {
  it('the review-ledger mode-ref documents the segment lifecycle, the v4 vocabulary, and --telemetry', () => {
    for (const token of ['segment', 'base', 'gate-run', 'size-cap', 'refuted', '--telemetry']) {
      assert.match(rlDoc, new RegExp(token), `review-ledger.md must document "${token}"`);
    }
    assert.match(rlDoc, /hard-max ceiling of 3 within one segment/, 'the per-segment hard-max wording');
    assert.match(rlDoc, /earned, never declared/, 'the commit-gated counter reset');
  });

  it('the fold-completeness mode-ref states the v3 segment custody contract', () => {
    assert.match(doc, /v3 run record/, 'the v3 record label');
    assert.match(doc, /close with its commit/, 'custody obligations close at the commit');
    assert.match(doc, /red-proof/, 'the cross-segment lane stays the recorded override');
  });

  it('the gates invariants line states the by-default boundary', () => {
    const invariantsLine = gatesDoc.split('\n').find((l) => l.startsWith('**Invariants:**'));
    assert.ok(invariantsLine, 'gates.md carries an Invariants line');
    assert.match(invariantsLine, /writes nothing by default/, 'the invariant states the by-default claim');
    assert.match(invariantsLine, /recordGateRun|sole writer/, 'the invariant names the delegated ledger write');
    assert.doesNotMatch(invariantsLine, /the runner writes nothing ·/, 'the unconditional claim is the pre-v4 contract');
  });

  it('the gates mode-ref + README row correct the writes-nothing claim to writes-nothing-by-default', () => {
    assert.match(gatesDoc, /writes nothing by default/i, 'gates.md must state the --record exception');
    assert.match(gatesDoc, /--record/, 'gates.md must document the flag');
    assert.match(gatesDoc, /sole writer|recordGateRun/, 'gates.md must name the delegation boundary');
    assert.match(readme, /writes nothing \*\*by default\*\*/, 'the README gates row must state the --record exception');
    assert.doesNotMatch(readme, /The runner writes nothing and never commits/, 'the unconditional writes-nothing claim is the pre-v4 contract');
  });

  it('the README review-ledger row states segments, gate-runs, refuted, size-cap, and telemetry', () => {
    for (const token of ['SEGMENT-scoped', 'gate-run', 'refuted', 'size-cap', '--telemetry']) {
      assert.match(readme, new RegExp(token), `the README must mention "${token}"`);
    }
  });

  it('the catalog one-liners state the segment contract', () => {
    const ledger = COMMANDS.find((c) => c.key === 'review-ledger');
    assert.match(ledger.oneLine, /SEGMENT/, 'the ledger one-liner names the segment scope');
    assert.match(ledger.oneLine, /refuted/, 'the ledger one-liner names the phantom lane');
    assert.match(ledger.oneLine, /--telemetry/, 'the ledger one-liner names the telemetry render');
    const fold = COMMANDS.find((c) => c.key === 'fold-completeness');
    assert.match(fold.oneLine, /SEGMENT-scoped/, 'the fold one-liner names the segment scope');
    const gates = COMMANDS.find((c) => c.key === 'gates');
    assert.match(gates.oneLine, /--record/, 'the gates one-liner names the recording flag');
    assert.match(gates.oneLine, /[Ww]rites nothing by default/, 'the gates one-liner keeps the honest default');
  });

  it('the velocity surface pins the auto-approvable run-gates form as the NO---record one (AD-040/AD-048)', () => {
    assert.match(velocityDoc, /`--record`.*forms all still prompt|--record.*never auto-approved/s, 'velocity.md must state --record stays explicit');
    // The EXACT auto-approvable byte-string is the backticked dispatch span — it must never grow --record.
    const exactSpans = [...velocityDoc.matchAll(/`([^`]*tools\/run-gates\.mjs[^`]*)`/g)].map((m) => m[1]);
    assert.ok(exactSpans.length >= 1, 'velocity.md documents the exact run-gates dispatch span');
    for (const span of exactSpans) assert.ok(!span.includes('--record'), `the exact byte-string must not carry --record (got: ${span})`);
  });

  it('the 1.39.0 changelog entries state the subset rule precisely', () => {
    // codex release R1: "--only never satisfies" oversells — a subset omitting only PROCESS gates
    // IS quality-green (the shipped carve-out). The claim must carry the non-process qualifier.
    const kitLog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
    const entry = kitLog.split('\n## ').find((s) => s.startsWith('1.39.0'));
    assert.ok(entry, 'the 1.39.0 entry exists');
    assert.match(entry, /subset that omits a declared non-process gate|subset omitting a declared non-process gate/, 'the kit entry qualifies the subset rule');
    const rootLog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
    const rootEntry = rootLog.split('\n## ').find((s) => s.includes('kit 1.39.0'));
    assert.ok(rootEntry, 'the root 1.39.0 entry exists');
    assert.match(rootEntry, /non-process/, 'the root entry qualifies the subset rule');
  });

  it('the procedures advisor renders gates-before-round + the segment wording for plan-execution', () => {
    assert.match(proceduresSrc, /run-gates --record BEFORE recording a round/, 'the advisor names the D5 order');
    assert.match(proceduresSrc, /per SEGMENT \(base = HEAD/, 'the advisor names the segment scope');
  });
});
