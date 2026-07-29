import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// ── FLOW-VERSION-FLOORS — green characterization of the floor mechanics the flow rollout leans on ──
// The tolerate-first ordering (flow Plan 1) ships NO new floor and NO flow-aware floor test — the
// design places environment floors on the ARMING path (`set-flow`). What the rollout leans on today:
// every family version comparison rides THIS one leaf (so a future floor cannot fork the comparison
// semantics), and a floor built on it must guard the null "unknown" contract EXPLICITLY. Each
// consumer's own lane behavior is pinned in its own suite: the npx never-downgrade gate
// (install.test.mjs, stale-cache defenses), the bridge freshness probe (family-registry.test.mjs),
// the placed-bridge never-downgrade skip (setup-backends.test.mjs, INV-D), the harness capability
// floor (velocity-autonomy.test.mjs, credentials + probeHarnessVersion).
describe('semver-lite — the four version-floor consumers ride this ONE leaf (FLOW-VERSION-FLOORS)', () => {
  const CONSUMER_IMPORTS = [
    ['../bin/install.mjs', '../tools/semver-lite.mjs'],
    ['./family-registry.mjs', './semver-lite.mjs'],
    ['./setup-backends.mjs', './semver-lite.mjs'],
    ['./velocity-profile.mjs', './semver-lite.mjs'],
  ];

  it('each consumer imports compareSemver from semver-lite — one comparison semantics, never a second semver', () => {
    for (const [rel, specifier] of CONSUMER_IMPORTS) {
      const source = readFileSync(new URL(rel, import.meta.url), 'utf8');
      const importRe = new RegExp(`import \\{[^}]*\\bcompareSemver\\b[^}]*\\} from '${specifier.replaceAll('.', '\\.')}'`);
      assert.match(source, importRe, `${rel} must take compareSemver from the ONE shared leaf`);
    }
  });

  it('a floor comparison accepts the floor version itself and anything newer, refuses anything older', () => {
    const FLOOR = '2.1.187';
    assert.ok(compareSemver('2.1.187', FLOOR) >= 0, 'the floor itself meets the floor');
    assert.ok(compareSemver('2.1.188', FLOOR) >= 0, 'a newer patch meets the floor');
    assert.ok(compareSemver('3.0.0', FLOOR) >= 0, 'a newer major meets the floor');
    assert.equal(compareSemver('2.1.186', FLOOR) >= 0, false, 'an older version is below the floor');
  });

  it('a BARE `>= 0` floor fails OPEN on an unparseable side (null coerces to 0) — a floor must null-guard first', () => {
    // Characterization of the trap, not an endorsement: the shipped floors are safe today only
    // because their inputs are guaranteed parseable upstream (velocity's probeHarnessVersion is
    // STRICT_SEMVER_RE-strict; the installer null-guards before gating). The arming-path floor
    // (`set-flow`) must use the guarded shape below, never the bare relational.
    assert.equal(compareSemver('not-a-version', '1.0.0'), null);
    assert.equal(compareSemver('not-a-version', '1.0.0') >= 0, true, 'the trap: an unguarded floor accepts an UNKNOWN version');
    const meetsFloor = (version, floor) => {
      const cmp = compareSemver(version, floor);
      return cmp !== null && cmp >= 0;
    };
    assert.equal(meetsFloor('not-a-version', '1.0.0'), false, 'the guarded shape refuses an unknown version');
    assert.equal(meetsFloor('1.0.0', '1.0.0'), true);
    assert.equal(meetsFloor('0.9.9', '1.0.0'), false);
  });
});
