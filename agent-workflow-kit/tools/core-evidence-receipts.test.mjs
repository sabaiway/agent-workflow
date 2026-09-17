import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readReceipts, isShipVerdict, classifyReviewReceiptForTree, summarizeReviewReceiptsForTree, describeMissingReviewAttestation,
} from './core-evidence-receipts.mjs';

// ── the review-domain primitives (owned here since the DAG inversion) ─────────────────────────────

// spec:core-evidence/S2
describe('the closed verdict vocabulary — type-strict, never coerced', () => {
  it('a non-string verdict never coerces into the closed vocabulary', () => {
    assert.equal(isShipVerdict(['ship']), false, 'String([\'ship\']) === \'ship\' — coercion must never admit an array');
    assert.equal(isShipVerdict({ toString: () => 'ship' }), false);
    assert.equal(isShipVerdict(0), false);
    assert.equal(isShipVerdict('ship'), true);
    const fp = 'f'.repeat(64);
    const arrayVerdict = { schema: 1, artifact: 'code', fresh: true, fingerprint: fp, backend: 'codex', verdict: ['ship'], grounded: true, probe: false, posture: { model: 'm' }, timestamp: 't' };
    assert.equal(classifyReviewReceiptForTree(arrayVerdict, fp), 'unrecognized-verdict');
  });

  it('the verdict arm precedes grounding: ungrounded plus unknown classifies unrecognized-verdict', () => {
    const fp = 'f'.repeat(64);
    const receipt = { schema: 1, artifact: 'code', fresh: true, fingerprint: fp, backend: 'codex', verdict: 'unknown', grounded: false, probe: false, posture: { model: 'm' }, timestamp: 't' };
    assert.equal(classifyReviewReceiptForTree(receipt, fp), 'unrecognized-verdict', 'grounding never reclassifies an unrecognized verdict');
    const ungroundedRevise = { ...receipt, verdict: 'revise' };
    assert.equal(classifyReviewReceiptForTree(ungroundedRevise, fp), 'ungrounded', 'a RECOGNIZED verdict without grounding stays ungrounded (not a veto)');
  });
});

// ── the D5 posture marker (strip Phase 4) — the probe-marker twin ─────────────────────────────────
describe('the D5 posture marker — absent/empty/invalid never attest, fail closed', () => {
  const fp = 'f'.repeat(64);
  const base = { schema: 1, artifact: 'code', fresh: true, fingerprint: fp, backend: 'codex', verdict: 'ship', grounded: true, probe: false, timestamp: 't' };

  it('ABSENT posture → posture-unmarked (silence is not a declaration; pre-D5 receipts stop satisfying)', () => {
    assert.equal(classifyReviewReceiptForTree(base, fp), 'posture-unmarked');
  });

  it('EMPTY or INVALID posture shapes → malformed-posture, never attesting', () => {
    for (const posture of [{}, null, 'gpt-5.6-sol', 42, [], { model: '' }, { model: 42 }, { model: 'm', effort: '' }, { model: 'm', effort: 7 }, { model: 'm', tier: 0 }, { model: 'm', tier: '' }]) {
      assert.equal(classifyReviewReceiptForTree({ ...base, posture }, fp), 'malformed-posture', `posture=${JSON.stringify(posture)}`);
    }
  });

  it('a VALID posture attests: {model} alone (agy) and {model, effort, tier|null} (codex)', () => {
    assert.equal(classifyReviewReceiptForTree({ ...base, posture: { model: 'Gemini 3.1 Pro (High)' } }, fp), 'attesting');
    assert.equal(classifyReviewReceiptForTree({ ...base, posture: { model: 'gpt-5.6-sol', effort: 'xhigh', tier: null } }, fp), 'attesting');
    assert.equal(classifyReviewReceiptForTree({ ...base, posture: { model: 'gpt-5.6-sol', effort: 'xhigh', tier: 'priority' } }, fp), 'attesting');
  });

  it('order is load-bearing: after the probe arms, BEFORE the verdict arm', () => {
    assert.equal(classifyReviewReceiptForTree({ ...base, probe: true }, fp), 'probe', 'a posture-less probe still classifies probe');
    assert.equal(classifyReviewReceiptForTree({ ...base, verdict: 'unknown' }, fp), 'posture-unmarked', 'the posture arm precedes the verdict arm');
  });

  it('summarize lands posture-rejected receipts in the rejected state with a stated posture reason', () => {
    const s = summarizeReviewReceiptsForTree([base, { ...base, posture: {} }], fp);
    assert.equal(s.state, 'rejected');
    assert.match(describeMissingReviewAttestation(s), /posture/);
  });
});

// ── the delivery marker (D8/D8b) — the posture-marker twin, scoped to backend=agy ─────────────────
// classifyReviewReceiptForTree deliberately ignores wrapperVersion, so a receipt minted by the OLD
// --add-dir offload at an unchanged fingerprint would still classify ATTESTING — and that lane was
// observed returning a confident fabrication. An agy code receipt therefore SELF-DECLARES how the
// change set was delivered; silence is not a declaration. The requirement is PRESENT-and-valid,
// never a particular value (both `inline` and `fed` attest), and it is scoped to agy — codex
// receipt semantics are untouched.
describe('the delivery marker (D8b) — agy code receipts declare HOW the change set arrived', () => {
  const fp = 'f'.repeat(64);
  const agy = { schema: 1, artifact: 'code', fresh: true, fingerprint: fp, backend: 'agy', verdict: 'ship', grounded: true, probe: false, posture: { model: 'Gemini 3.1 Pro (High)' }, timestamp: 't' };
  const codex = { ...agy, backend: 'codex', posture: { model: 'gpt-5.6-sol', effort: 'xhigh', tier: null } };

  it('OLD agy receipt (no marker) → delivery-unmarked, never attesting', () => {
    assert.equal(classifyReviewReceiptForTree(agy, fp), 'delivery-unmarked');
  });

  it('NEW agy inline and NEW agy fed both attest — present and valid, never a particular value', () => {
    assert.equal(classifyReviewReceiptForTree({ ...agy, delivery: 'inline' }, fp), 'attesting');
    assert.equal(classifyReviewReceiptForTree({ ...agy, delivery: 'fed' }, fp), 'attesting');
  });

  it('a MALFORMED delivery declaration → malformed-delivery, never attesting', () => {
    for (const delivery of [null, '', 42, [], {}, ['fed'], 'FED', 'a fed lane', ' fed', 'fed\n']) {
      assert.equal(classifyReviewReceiptForTree({ ...agy, delivery }, fp), 'malformed-delivery', `delivery=${JSON.stringify(delivery)}`);
    }
  });

  it('CODEX receipt semantics are untouched — no marker required, a stray one never rejects', () => {
    assert.equal(classifyReviewReceiptForTree(codex, fp), 'attesting', 'codex without a delivery field still attests');
    assert.equal(classifyReviewReceiptForTree({ ...codex, delivery: 'inline' }, fp), 'attesting');
  });

  // Order is load-bearing in the OTHER direction: the delivery arm runs LAST, so it can only ever
  // intercept a receipt that would otherwise be ATTESTING. Placing it earlier pulled delivery-less
  // `unrecognized-verdict` / `ungrounded` receipts out of the latest-normal selection, which let an
  // EARLIER ship survive a LATER bad receipt — the selection-first doctrine, silently broken.
  it('order is load-bearing: the delivery arm runs LAST, after verdict and grounding', () => {
    assert.equal(classifyReviewReceiptForTree({ ...agy, probe: true }, fp), 'probe', 'a marker-less probe still classifies probe');
    assert.equal(classifyReviewReceiptForTree({ ...agy, posture: {} }, fp), 'malformed-posture', 'the posture arm still precedes it');
    assert.equal(classifyReviewReceiptForTree({ ...agy, verdict: 'unknown' }, fp), 'unrecognized-verdict', 'an unrecognized verdict outranks a missing delivery');
    assert.equal(classifyReviewReceiptForTree({ ...agy, grounded: false }, fp), 'ungrounded', 'ungrounded outranks a missing delivery');
  });

  // The exact regression the ordering exists to prevent, at the level where it bites: SELECTION.
  it('a LATER delivery-less bad receipt still vetoes an EARLIER good one (selection-first holds)', () => {
    const good = { ...agy, delivery: 'fed', verdict: 'ship' };
    const laterUnknown = summarizeReviewReceiptsForTree([good, { ...agy, verdict: 'unknown' }], fp);
    assert.equal(laterUnknown.state, 'unrecognized-verdict', 'the later unknown-verdict receipt is the one judged');
    const laterUngrounded = summarizeReviewReceiptsForTree([good, { ...agy, grounded: false, verdict: 'rework' }], fp);
    assert.equal(laterUngrounded.state, 'ungrounded', 'the later ungrounded receipt is the one judged');
  });

  it('summarize reports the class as its OWN reason — never mislabelled as probe', () => {
    const s = summarizeReviewReceiptsForTree([agy, { ...agy, delivery: 7 }], fp);
    assert.equal(s.state, 'rejected');
    assert.equal(s.deliveryRejected, 2, 'both the unmarked and the malformed receipt are counted');
    assert.equal(s.probeExcluded, 0, 'a delivery rejection is never counted as a probe');
    const why = describeMissingReviewAttestation(s);
    assert.match(why, /delivery/, 'the reason names the delivery class');
    assert.doesNotMatch(why, /probe review never attests/, 'never the probe sentence');
    assert.match(why, /re-run/, 'the stated recovery is to re-run the review');
  });

  it('a fresh fed receipt beside an old unmarked one attests (the latest normal receipt wins)', () => {
    const s = summarizeReviewReceiptsForTree([agy, { ...agy, delivery: 'fed' }], fp);
    assert.equal(s.state, 'current');
    assert.equal(s.deliveryRejected, 1);
  });
});

describe('review-domain primitives — the defensive arms of the canonical payload walk', () => {
  it('readReceipts: a valid-JSON line that is not a receipt object counts malformed (the else arm)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-evidence-recmal-'));
    const path = join(dir, 'receipts.jsonl');
    writeFileSync(path, '{"noBackendField":1}\n"just a string"\n');
    const r = readReceipts(path);
    assert.deepEqual([r.receipts.length, r.malformed], [0, 2]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('readReceipts: a SYMLINKED receipts path surfaces readError, never content (RECEIPTS-READER-NOFOLLOW)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-evidence-reclink-'));
    writeFileSync(join(dir, 'real.jsonl'), `${JSON.stringify({ backend: 'codex' })}\n`);
    symlinkSync('real.jsonl', join(dir, 'receipts.jsonl'));
    const r = readReceipts(join(dir, 'receipts.jsonl'));
    assert.match(r.readError ?? '', /symlink/, 'the no-follow read names the foreign leaf class');
    assert.equal(r.receipts.length, 0, 'a symlinked store never reads as receipts');
    rmSync(dir, { recursive: true, force: true });
  });

  it('readReceipts: a non-ENOENT open failure surfaces its code as readError (the error outcome, injected io)', () => {
    const eacces = () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
    const r = readReceipts('/any/receipts.jsonl', { open: eacces });
    assert.equal(r.readError, 'EACCES');
    assert.equal(r.receipts.length, 0);
  });
});
