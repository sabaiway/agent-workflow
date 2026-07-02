import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSemver, compareSemver } from './semver-lite.mjs';

describe('parseSemver — leading x.y.z only', () => {
  it('parses a plain semver into numeric triples', () => {
    assert.deepEqual(parseSemver('1.2.3'), [1, 2, 3]);
    assert.deepEqual(parseSemver('0.0.0'), [0, 0, 0]);
    assert.deepEqual(parseSemver('10.20.30'), [10, 20, 30]);
  });

  it('trims whitespace and ignores a prerelease/build tail (leading match)', () => {
    assert.deepEqual(parseSemver(' 1.2.3\n'), [1, 2, 3]);
    assert.deepEqual(parseSemver('1.2.3-rc.1'), [1, 2, 3]);
    assert.deepEqual(parseSemver('1.2.3+build.7'), [1, 2, 3]);
  });

  it('returns null on anything unparseable (the load-bearing "unknown" contract)', () => {
    for (const bad of ['1.2', 'v1.2.3', 'abc', '', null, undefined, 42, {}]) {
      assert.equal(parseSemver(bad), null, `parseSemver(${JSON.stringify(bad)}) must be null`);
    }
  });
});

describe('compareSemver — -1 | 0 | 1, null when either side is unparseable', () => {
  it('orders by major, then minor, then patch', () => {
    assert.equal(compareSemver('1.0.0', '2.0.0'), -1);
    assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
    assert.equal(compareSemver('1.1.0', '1.2.0'), -1);
    assert.equal(compareSemver('1.2.1', '1.2.0'), 1);
    assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
  });

  it('compares numerically, never lexicographically (1.10.0 > 1.9.0)', () => {
    assert.equal(compareSemver('1.10.0', '1.9.0'), 1);
    assert.equal(compareSemver('1.9.0', '1.10.0'), -1);
  });

  it('returns null when EITHER side is unparseable — never a false ordering claim (INV-B)', () => {
    assert.equal(compareSemver('abc', '1.0.0'), null);
    assert.equal(compareSemver('1.0.0', null), null);
    assert.equal(compareSemver(undefined, undefined), null);
  });
});
