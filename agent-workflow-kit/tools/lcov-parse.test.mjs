// Spec for the dependency-free LCOV parser (BUGFREE-3, AD-049).
// Covers path normalization (relative/./-prefixed/absolute-in-repo all canonicalize equal; outside-tree
// dropped), fail-closed parsing (malformed DA never marks a line covered), and uncovered-changed derivation.
// An injected identity `canon` keeps keys deterministic without touching the filesystem; the real
// realpath-backed canon is exercised by the integration case.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLcov, lcovCoveredMap, uncoveredChangedFromLcov } from './lcov.mjs';

const ID = { canon: (p) => p };
const ROOT = '/repo';

describe('parseLcov — SF/DA/end_of_record only', () => {
  it('maps DA hits per file section', () => {
    const lcov = ['SF:tools/a.mjs', 'DA:1,5', 'DA:2,0', 'DA:3,1', 'end_of_record'].join('\n');
    const m = parseLcov(lcov);
    assert.deepEqual([...m.get('tools/a.mjs').entries()], [[1, 5], [2, 0], [3, 1]]);
  });
  it('ignores non-SF/DA records (FN/FNDA/BRDA/LF/LH)', () => {
    const lcov = ['SF:x.mjs', 'FN:1,foo', 'FNDA:2,foo', 'BRDA:1,0,0,1', 'LF:3', 'LH:2', 'DA:1,1', 'end_of_record'].join('\n');
    assert.deepEqual([...parseLcov(lcov).get('x.mjs').entries()], [[1, 1]]);
  });
  it('merges duplicate DA and repeated sections by MAX hits', () => {
    const lcov = ['SF:x.mjs', 'DA:1,0', 'DA:1,3', 'end_of_record', 'SF:x.mjs', 'DA:1,0', 'end_of_record'].join('\n');
    assert.equal(parseLcov(lcov).get('x.mjs').get(1), 3);
  });
  it('fail-closed: a DA with a non-integer LINE is skipped, never marks a line covered', () => {
    const lcov = ['SF:x.mjs', 'DA:abc,5', 'DA:3,4', 'end_of_record'].join('\n');
    const m = parseLcov(lcov).get('x.mjs');
    assert.equal(m.has(1), false);
    assert.equal(m.get(3), 4);
  });
  it('fail-closed: a valid LINE with a malformed hit count records UNCOVERED (0), never omitted-green', () => {
    // STRICT /^\d+$/: `1abc`/`2.5` are the fail-open traps — parseInt would return 1/2 → falsely covered.
    const m = parseLcov(['SF:x.mjs', 'DA:2,xyz', 'DA:42,', 'DA:5,1abc', 'DA:6,2.5', 'DA:3,4', 'end_of_record'].join('\n')).get('x.mjs');
    for (const line of [2, 42, 5, 6]) assert.equal(m.get(line), 0, `DA line ${line} with a malformed hit count reads UNCOVERED (fail-closed)`);
    assert.equal(m.get(3), 4, 'a well-formed DA:3,4 still reads covered');
    const map = lcovCoveredMap(['SF:tools/a.mjs', 'DA:10,3', 'DA:42,', 'DA:5,1abc', 'end_of_record'].join('\n'), ROOT, ID);
    assert.deepEqual(uncoveredChangedFromLcov(map, '/repo/tools/a.mjs', [10, 42, 5]), [5, 42]);
  });
  it('tolerates CRLF and a checksum third field', () => {
    const lcov = ['SF:x.mjs\r', 'DA:1,2,f00dcafe\r', 'end_of_record\r'].join('\n');
    assert.equal(parseLcov(lcov).get('x.mjs').get(1), 2);
  });
  it('an empty SF path resets the section — its DA lines record nothing', () => {
    const m = parseLcov('SF:\nDA:1,1\nend_of_record\nSF:x.mjs\nDA:2,1\nend_of_record');
    assert.equal(m.has(''), false);
    assert.equal(m.get('x.mjs').get(2), 1);
  });
});

describe('lcovCoveredMap — the default realpath canon (no injected dep)', () => {
  it('resolves an existing SF via realpath and falls back to the lexical path for a missing one', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lcov-canon-')));
    writeFileSync(join(dir, 'a.mjs'), 'x');
    // a.mjs exists → realpathSync; gone.mjs does not → the catch returns the lexical path (still in-tree).
    const m = lcovCoveredMap('SF:a.mjs\nDA:1,1\nend_of_record\nSF:gone.mjs\nDA:1,1\nend_of_record', dir);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(m.has(join(dir, 'a.mjs')), true);
    assert.equal(m.has(join(dir, 'gone.mjs')), true);
  });
});

describe('lcovCoveredMap — SF path normalization (same key space as the V8 map)', () => {
  it('relative, ./-prefixed, and absolute-in-repo SF all key to the same canonical-abs path', () => {
    for (const sf of ['tools/a.mjs', './tools/a.mjs', '/repo/tools/a.mjs']) {
      const m = lcovCoveredMap(`SF:${sf}\nDA:1,1\nend_of_record`, ROOT, ID);
      assert.ok(m.has('/repo/tools/a.mjs'), `SF "${sf}" keys to /repo/tools/a.mjs`);
    }
  });
  it('an outside-tree SF is dropped, never trusted as coverage', () => {
    const m = lcovCoveredMap(['SF:/etc/passwd', 'DA:1,1', 'end_of_record', 'SF:../sibling/x.mjs', 'DA:1,1', 'end_of_record'].join('\n'), ROOT, ID);
    assert.equal(m.size, 0);
  });
  it('keeps an in-repo SF beside a dropped outside one', () => {
    const m = lcovCoveredMap(['SF:tools/a.mjs', 'DA:1,1', 'end_of_record', 'SF:/etc/x', 'DA:1,1', 'end_of_record'].join('\n'), ROOT, ID);
    assert.deepEqual([...m.keys()], ['/repo/tools/a.mjs']);
  });
});

describe('uncoveredChangedFromLcov — 0-hit uncovered / >0 covered / no-DA skip / absent → RED', () => {
  const map = lcovCoveredMap(['SF:tools/a.mjs', 'DA:1,3', 'DA:2,0', 'DA:4,0', 'end_of_record'].join('\n'), ROOT, ID);
  const KEY = '/repo/tools/a.mjs';
  it('a 0-hit changed line is uncovered; a >0-hit changed line is covered', () => {
    assert.deepEqual(uncoveredChangedFromLcov(map, KEY, [1, 2]), [2]);
  });
  it('a changed line with no DA entry (non-executable) is never flagged', () => {
    assert.deepEqual(uncoveredChangedFromLcov(map, KEY, [1, 3]), []);
  });
  it('multiple uncovered lines come back sorted and de-duplicated', () => {
    assert.deepEqual(uncoveredChangedFromLcov(map, KEY, [4, 2, 4]), [2, 4]);
  });
  it('a file absent from the LCOV returns null (caller records a file-level RED)', () => {
    assert.equal(uncoveredChangedFromLcov(map, '/repo/tools/missing.mjs', [1]), null);
  });
});
