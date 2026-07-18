// install-retry-delay.test.mjs — red-first pins for the retry-backoff resolver (Phase-5 council
// R1: codex M1 / agy B1 — `Number(env ?? '')` read an UNSET variable as `Number('') === 0` and
// silently zeroed the shipped 1500ms default for every production user). Colocated separately:
// install.test.mjs is a parity-surviving file whose test points are frozen. The resolver is
// imported dynamically so each fixture fails on its OWN assertion against the pre-fix tree.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const installer = await import('./install.mjs').catch(() => null);
const resolveRetryDelayMs = installer?.resolveRetryDelayMs;

describe('resolveRetryDelayMs — the AW_INSTALL_RETRY_DELAY_MS test seam never weakens production', () => {
  it('UNSET env → the shipped 1500 default (the R1 bug pin)', () => {
    assert.equal(resolveRetryDelayMs?.({}), 1500);
  });
  it('EMPTY string → 1500 (explicitly empty is unset, never zero)', () => {
    assert.equal(resolveRetryDelayMs?.({ AW_INSTALL_RETRY_DELAY_MS: '' }), 1500);
  });
  it("'0' → 0 (the cascade suite's zeroed wait stays reachable)", () => {
    assert.equal(resolveRetryDelayMs?.({ AW_INSTALL_RETRY_DELAY_MS: '0' }), 0);
  });
  it("'750' → 750 (an explicit finite override applies)", () => {
    assert.equal(resolveRetryDelayMs?.({ AW_INSTALL_RETRY_DELAY_MS: '750' }), 750);
  });
  it("malformed 'abc' → 1500 (never NaN, never a disabled wait)", () => {
    assert.equal(resolveRetryDelayMs?.({ AW_INSTALL_RETRY_DELAY_MS: 'abc' }), 1500);
  });
  it("negative '-5' → 1500", () => {
    assert.equal(resolveRetryDelayMs?.({ AW_INSTALL_RETRY_DELAY_MS: '-5' }), 1500);
  });
});
