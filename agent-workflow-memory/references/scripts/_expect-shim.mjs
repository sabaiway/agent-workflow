// Minimal dependency-free `expect` shim mapping the Vitest matchers used by the
// kernel's *.test.mjs onto node:assert, so the suite runs under `node --test` with
// zero dependencies. Supports only the matchers these tests use.
import assert from 'node:assert/strict';

const has = (actual, expected) => {
  if (typeof actual === 'string') return actual.includes(expected);
  if (Array.isArray(actual)) return actual.includes(expected);
  return false;
};

const matchers = (actual, negate) => ({
  toBe: (expected) =>
    negate ? assert.notStrictEqual(actual, expected) : assert.strictEqual(actual, expected),
  toEqual: (expected) =>
    negate ? assert.notDeepStrictEqual(actual, expected) : assert.deepStrictEqual(actual, expected),
  toContain: (expected) =>
    assert.ok(
      negate ? !has(actual, expected) : has(actual, expected),
      `expected ${JSON.stringify(actual)} ${negate ? 'not ' : ''}to contain ${JSON.stringify(expected)}`,
    ),
  toMatch: (re) => (negate ? assert.doesNotMatch(actual, re) : assert.match(actual, re)),
  toHaveLength: (n) =>
    negate ? assert.notStrictEqual(actual.length, n) : assert.strictEqual(actual.length, n),
  toBeNull: () => (negate ? assert.notStrictEqual(actual, null) : assert.strictEqual(actual, null)),
  toBeInstanceOf: (Ctor) =>
    assert.ok(
      negate ? !(actual instanceof Ctor) : actual instanceof Ctor,
      `expected value ${negate ? 'not ' : ''}to be instance of ${Ctor.name}`,
    ),
  toBeGreaterThan: (n) =>
    assert.ok(negate ? !(actual > n) : actual > n, `expected ${actual} ${negate ? 'not ' : ''}> ${n}`),
  toBeLessThan: (n) =>
    assert.ok(negate ? !(actual < n) : actual < n, `expected ${actual} ${negate ? 'not ' : ''}< ${n}`),
});

export const expect = (actual) => {
  const api = matchers(actual, false);
  api.not = matchers(actual, true);
  return api;
};
