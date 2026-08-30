import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decideCheck } from './review-state.mjs';
import { buildThread } from './delegation-harness.test.mjs';

const SOURCE = readFileSync(fileURLToPath(new URL('./commit-guard.mjs', import.meta.url)), 'utf8');

const substitutedFacts = () => {
  const records = buildThread({
    dispatch: { nonce: 'substituted', baselineClean: false },
    returned: { sessionId: 'session-new' },
  });
  return {
    state: 'ok',
    heldId: 'session-held',
    folds: 1,
    threads: records,
    open: [],
    substitution: { nonce: 'substituted', expectedId: 'session-held', actualId: 'session-new' },
  };
};

const reviewState = (heldSession) => ({
  heldSession,
  obligations: { recipe: 'solo', source: 'config', unknowable: false },
  flowArmed: false,
  flowBrokenReason: null,
  malformed: 0,
  evidenceUnavailable: false,
  evidenceMalformed: 0,
  evidenceReadError: null,
  receiptsReadError: null,
});

describe('commit-guard held-session composition — spec:held-session/S7', () => {
  it('strips the delegation producer seam with the other three seams', () => {
    const existing = [
      'delete reviewEnv.AW_REVIEW_RECEIPTS;',
      'delete reviewEnv.AW_CORE_EVIDENCE;',
      'delete reviewEnv.AW_FLOW_STORE;',
    ];
    for (const line of existing) assert.ok(SOURCE.includes(line), line);
    assert.ok(SOURCE.includes('delete reviewEnv.AW_DELEGATION_STORE;'), 'a poisoned AW_DELEGATION_STORE must never redirect the guard');
    assert.equal(SOURCE.match(/delete reviewEnv\.AW_DELEGATION_STORE;/gu)?.length, 1);
    assert.match(SOURCE, /four producer seams are stripped:\s*\n\/\/\s+receipts\/evidence\/flow-store\/delegation-store/u);
    assert.match(SOURCE, /receipts\/evidence\/flow-store\/delegation-store seams stripped/u);
  });

  it('inherits the review-state substitution reason verbatim', () => {
    const review = decideCheck(reviewState(substitutedFacts()));
    assert.equal(review.code, 1);
    assert.match(review.reason, /substituted.*session-held.*session-new/u);
    assert.ok(SOURCE.includes('the review obligations are not satisfied: ${review.reason}'), 'the guard must interpolate the review reason without rewording it');
  });

  it('inherits a fail-closed ledger reason verbatim', () => {
    const reason = 'line 2: malformed delegation ledger';
    const review = decideCheck(reviewState({
      state: 'error', cause: 'ledger', reason, heldId: null, folds: 0, substitution: null, threads: [], open: [],
    }));
    assert.equal(review.reason, reason);
    assert.ok(SOURCE.includes('${review.reason}'));
  });
});
