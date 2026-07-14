// gate-hook-core-parity.test.mjs — drift-guard: the PreToolUse hook's BAKED constants must stay
// byte-identical to the velocity-profile.mjs exports they copy. The hook is self-contained by
// contract (a placed file cannot import the kit), so the copy is structural — this test is the
// mechanism that makes it safe: edit either side alone and the suite goes red.
//
// Non-vacuous by construction: `deepStrictEqual` on the full frozen structures — any injected
// divergence (an added/removed/reworded entry on either side) fails.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RUNTIME_RESIDUAL_FORMS, UNIVERSAL_READONLY_ALLOWLIST } from '../tools/velocity-profile.mjs';
import { RESIDUAL_FORMS, SEEDED_READONLY_CORE } from '../references/hooks/gate-approve.mjs';

describe('gate hook ↔ velocity-profile constant parity', () => {
  it('the baked seeded read-only core ≡ UNIVERSAL_READONLY_ALLOWLIST', () => {
    assert.deepStrictEqual([...SEEDED_READONLY_CORE], [...UNIVERSAL_READONLY_ALLOWLIST]);
  });

  it('the baked residual forms ≡ RUNTIME_RESIDUAL_FORMS', () => {
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(RESIDUAL_FORMS)),
      JSON.parse(JSON.stringify(RUNTIME_RESIDUAL_FORMS)),
    );
  });

  it('the bash-5.3 funsub openers + the line-continuation forms are present on BOTH sides (AD-055 Part II) — a simultaneous revert goes red', () => {
    // deepStrictEqual above catches a ONE-sided drift; this pins the extensions themselves so removing
    // them from both copies at once still fails.
    for (const forms of [RUNTIME_RESIDUAL_FORMS.commandSubstitutions, RESIDUAL_FORMS.commandSubstitutions]) {
      for (const opener of ['${ ', '${\t', '${\n', '${\r', '${|']) {
        assert.ok(forms.includes(opener), `commandSubstitutions must include the funsub opener ${JSON.stringify(opener)}`);
      }
    }
    for (const forms of [RUNTIME_RESIDUAL_FORMS.lineContinuations, RESIDUAL_FORMS.lineContinuations]) {
      for (const form of ['\\\n', '\\\r']) {
        assert.ok(forms.includes(form), `lineContinuations must include the splice form ${JSON.stringify(form)}`);
      }
    }
  });

  it('both sides are frozen (a runtime mutation cannot widen either set)', () => {
    for (const value of [
      UNIVERSAL_READONLY_ALLOWLIST,
      SEEDED_READONLY_CORE,
      RUNTIME_RESIDUAL_FORMS,
      RESIDUAL_FORMS,
      ...Object.values(RUNTIME_RESIDUAL_FORMS),
      ...Object.values(RESIDUAL_FORMS),
    ]) {
      assert.equal(Object.isFrozen(value), true);
    }
  });
});
