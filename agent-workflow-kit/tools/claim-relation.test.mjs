import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseEpic } from './epic-shape.mjs';

const OPEN_PATH = 'docs/ai/epics/OPEN.md';
const LANDED_PATH = 'docs/ai/epics/LANDED.md';
const EPIC_TEXT = `---
type: epic
lastUpdated: 2026-09-10
scope: permanent
staleAfter: 90d
owner: none
maxLines: 60
state: open
---
# Epic: Claim boundaries
## Intent
Keep ownership visible.
## Value
Keep work separate.
## Non-goals
No implementation choices.
## Acceptance
The boundary is observable.
## Specs
docs/ai/specs/kit/example.md
## Stories ledger
- S1 | First | depends-on: none | owns: tools/foo.mjs | shared: docs/ | state: planned
- S2 | Second | depends-on: S1 | owns: none | shared: tools/bar.mjs | state: landed 2026-09-10
- S3 | Third | depends-on: S2 | owns: tools/third/ | shared: none | state: in-flight
- S4 | Invalid | depends-on: S3 | owns: bad*claim | shared: none | state: planned
## Queue
Row OPEN in Now
`;
const loadRules = async () => {
  const rules = await import('./claim-relation.mjs').catch((error) => {
    assert.equal(error.code, 'ERR_MODULE_NOT_FOUND');
    return {};
  });
  assert.equal(typeof rules.listStories, 'function', 'the claim leaf must export listStories');
  return rules;
};

it('cuts overlap at slash boundaries in both directions and ignores a trailing slash', async () => {
  const { hasPathOverlap } = await loadRules();
  for (const [left, right, expected] of [
    ['tools/queue.mjs', 'tools/queue-audit.mjs', false],
    ['tools/queue/', 'tools/queue-audit/a.mjs', false],
    ['tools/queue/', 'tools/queue/a.mjs', true],
    ['tools/queue', 'tools/queue/a.mjs', true],
    ['tools/queue/', 'tools/queue', true],
  ]) {
    assert.equal(hasPathOverlap(left, right), expected);
    assert.equal(hasPathOverlap(right, left), expected);
  }
});

it('expands source claims to co-located tests and leaves test and extensionless paths alone', async () => {
  const { expandClaim } = await loadRules();
  assert.deepEqual(expandClaim('tools/foo.mjs'), ['tools/foo.mjs', 'tools/foo.test.mjs', 'tools/foo.test/']);
  for (const path of ['tools/foo.test.mjs', 'tools/foo.test/', 'tools/foo', 'tools/foo/']) {
    assert.deepEqual(expandClaim(path), [path]);
  }
});

it('walks transitive dependencies in either direction and terminates on cycles', async () => {
  const { findReachable } = await loadRules();
  const forward = new Map([['S1', []], ['S2', ['S1']], ['S3', ['S2']]]);
  const backward = new Map([['S1', ['S2']], ['S2', ['S3']], ['S3', []]]);
  assert.deepEqual(findReachable(forward, forward.get('S3')), new Set(['S2', 'S1']));
  assert.deepEqual(findReachable(backward, backward.get('S1')), new Set(['S2', 'S3']));
  assert.deepEqual(findReachable(new Map([['S1', ['S2']], ['S2', ['S1']]]), ['S2']), new Set(['S2', 'S1']));
  const visited = new Set(['S1']);
  assert.deepEqual(findReachable(forward, ['S2', 'S2', 'S99'], visited), new Set(['S1', 'S2', 'S99']));
  assert.deepEqual(visited, new Set(['S1']));
});

it('keeps first occurrences when removing duplicates', async () => {
  const { unique } = await loadRules();
  assert.deepEqual(unique(['S2', 'S1', 'S2', 'S3', 'S1']), ['S2', 'S1', 'S3']);
  assert.deepEqual(unique([]), []);
});

it('lists valid open-epic rows in order including landed rows with claims and reachability', async () => {
  const { listStories } = await loadRules();
  const open = parseEpic(EPIC_TEXT, OPEN_PATH);
  const landed = parseEpic(EPIC_TEXT.replace('state: open', 'state: landed'), LANDED_PATH);
  const before = structuredClone([open, landed]);
  assert.deepEqual(open.rows.map((row) => row.valid), [true, true, true, false]);
  const [first, second, third] = open.rows;
  const expected = [
    { path: OPEN_PATH, id: 'S1', line: first.line, state: 'planned', reachable: new Set(), claims: [
      { field: 'owns', path: 'tools/foo.mjs', ground: ['tools/foo.mjs', 'tools/foo.test.mjs', 'tools/foo.test/'] },
      { field: 'shared', path: 'docs/', ground: ['docs/'] },
    ] },
    { path: OPEN_PATH, id: 'S2', line: second.line, state: 'landed', reachable: new Set(['S1']), claims: [
      { field: 'shared', path: 'tools/bar.mjs', ground: ['tools/bar.mjs', 'tools/bar.test.mjs', 'tools/bar.test/'] },
    ] },
    { path: OPEN_PATH, id: 'S3', line: third.line, state: 'in-flight', reachable: new Set(['S2', 'S1']), claims: [
      { field: 'owns', path: 'tools/third/', ground: ['tools/third/'] },
    ] },
  ];
  assert.deepEqual(listStories([open, landed]), expected);
  assert.deepEqual(listStories([open, landed, open]), [...expected, ...expected]);
  assert.deepEqual(listStories([]), []);
  assert.deepEqual([open, landed], before);
});
