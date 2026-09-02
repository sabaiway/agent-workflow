import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalFlowDigest } from './flow-record.mjs';
import {
  blockingItems, capIssue, escalationIssue, findingQuoted, roundsForSignal, validateWalk, walkIssue,
} from './flow-round-gates.mjs';

const D = (pair) => pair.repeat(32);
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const CODEX_TEXT = '[blocker] first\r\n[major] second\r\n[minor] ignored\r\n[blockerish] ignored\r\n';
const SCHEMA = {
  verdict: 'revise',
  findings: [
    { severity: 'blocker', issue: 'schema first' },
    { severity: 'major', issue: 'schema second' },
    { severity: 'minor', issue: 'ignored' },
  ],
};
const AGY = '### Blocking\n1. agy first\n2) agy second\nplain ignored\n### Evidence\n3. too late\n';

const carrier = (backend, nonce, payload) => {
  const bytes = Buffer.from(JSON.stringify({ findings: payload }));
  return { bytes, manifest: { findings: payload }, backend, nonce, digest: sha(bytes) };
};
const receipt = (backend, verdict, blocking, fingerprint) => ({
  backend, verdict, blocking, fingerprint, durationS: 1, probe: false, artifactPath: 'artifact',
});
const dispatch = (backend, nonce, receiptDigest, findingManifestDigest) => ({
  backend, dispatchNonce: nonce, receiptDigest, findingManifestDigest,
});
const head = (round, fingerprint, dispatches, dispositions = []) => ({
  kind: 'chain', purpose: 'round', planId: 'plan-a', cycle: 1, stepId: 's1', round,
  fingerprint, base: D('aa'), dispatches, dispositions,
});
const tableReader = (table) => (backend, nonce) => table.get(`${backend}:${nonce}`) ?? { outcome: 'absent' };

describe('flow-round-gates — pure round obligations', () => {
  it('hashes blocking items using each wrapper vocabulary and layout', () => {
    const text = blockingItems('codex', CODEX_TEXT);
    assert.deepEqual(text, { ok: true, mode: 'text', items: [
      { text: '[blocker] first', digest: sha('[blocker] first') },
      { text: '[major] second', digest: sha('[major] second') },
    ] });
    const compact = blockingItems('codex', JSON.stringify(SCHEMA));
    const pretty = blockingItems('codex', JSON.stringify(SCHEMA, null, 2));
    assert.equal(compact.mode, 'schema');
    assert.deepEqual(pretty, compact, 'JSON layout never changes an item digest');
    assert.deepEqual(blockingItems('agy', AGY).items.map(({ text }) => text), ['1. agy first', '2) agy second']);
    assert.deepEqual(blockingItems('other', 'x').ok, false);
    const special = 'quoted "issue" with \\ and\na newline';
    const specialSchema = JSON.stringify({ verdict: 'revise', findings: [{ severity: 'major', issue: special }] });
    assert.equal(specialSchema.includes(special), false);
    assert.equal(findingQuoted('codex', specialSchema, special), true);
    assert.equal(findingQuoted('codex', CODEX_TEXT, '[major] second'), true);
    assert.match(blockingItems('codex', JSON.stringify({ verdict: 'revise', findings: [{ severity: 'blocker', issue: '' }] })).reason, /issue is empty or not a string/);
  });

  it('judges latest-head items, fallback, custody, and signals (spec:plan-review-loop/S31)', () => {
    const c1 = carrier('codex', 'c1', CODEX_TEXT);
    const c2 = carrier('codex', 'c2', CODEX_TEXT);
    const a1 = carrier('agy', 'a1', AGY);
    const a2 = carrier('agy', 'a2', AGY);
    const receipts = new Map([
      [D('01'), receipt('codex', 'revise', 2, D('11'))], [D('02'), receipt('agy', 'ship', 0, D('11'))],
      [D('03'), receipt('codex', 'revise', 2, D('12'))], [D('04'), receipt('agy', 'ship', 0, D('12'))],
    ]);
    const heads = [
      head(1, D('11'), [dispatch('codex', 'c1', D('01'), c1.digest), dispatch('agy', 'a1', D('02'), a1.digest)]),
      head(2, D('12'), [dispatch('codex', 'c2', D('03'), c2.digest), dispatch('agy', 'a2', D('04'), a2.digest)]),
    ];
    const table = new Map([['codex:c1', { outcome: 'ok', ...c1 }], ['codex:c2', { outcome: 'ok', ...c2 }], ['agy:a1', { outcome: 'ok', ...a1 }], ['agy:a2', { outcome: 'ok', ...a2 }]]);
    const uncovered = capIssue({ heads, receipts, readManifest: tableReader(table) });
    assert.match(uncovered.issue, new RegExp(`${sha('[blocker] first')}  \\[blocker\\] first`));
    assert.match(uncovered.issue, /round-land --dispose .* --finding .*SAME tree/);
    heads[1].dispositions = blockingItems('codex', CODEX_TEXT).items.map(({ digest }) => ({ findingDigest: digest, action: 'rejected', reason: 'not a defect' }));
    assert.deepEqual(capIssue({ heads, receipts, readManifest: tableReader(table) }), { issue: null, advisories: [] });
    receipts.get(D('03')).blocking = 3;
    assert.match(capIssue({ heads, receipts, readManifest: tableReader(table) }).advisories[0], /enumerated count 2 differs from blocking 3/);
    receipts.get(D('03')).blocking = undefined;
    assert.match(capIssue({ heads, receipts, readManifest: tableReader(table) }).advisories[0], /not a non-negative integer/);
    heads[1].dispositions = [];
    assert.match(capIssue({ heads, receipts, readManifest: tableReader(table) }).issue, /at least one disposition/);
    receipts.get(D('03')).blocking = 2;
    heads[1].dispositions = blockingItems('codex', CODEX_TEXT).items.map(({ digest }) => ({ findingDigest: digest, action: 'rejected', reason: 'not a defect' }));
    assert.equal(roundsForSignal(heads, receipts).rounds.length, 2);
    assert.deepEqual(roundsForSignal(heads, receipts).obligation, { backends: ['codex', 'agy'], perBackend: true, minShip: 2 });
    assert.equal(roundsForSignal([head(1, D('11'), [])], receipts).obligation, null);

    const unknownBytes = Buffer.from(JSON.stringify({ findings: 'opaque' }));
    const unknownReceipts = new Map([[D('05'), receipt('mystery', 'revise', 1, D('11'))], [D('06'), receipt('mystery', 'revise', 1, D('12'))]]);
    const unknownHeads = [head(1, D('11'), [dispatch('mystery', 'm1', D('05'), sha(unknownBytes))]), head(2, D('12'), [dispatch('mystery', 'm2', D('06'), sha(unknownBytes))], [{ findingDigest: D('77'), action: 'rejected', reason: 'fallback' }])];
    const unknownRead = () => ({ outcome: 'ok', bytes: unknownBytes, manifest: { findings: 'opaque' } });
    const advisory = capIssue({ heads: unknownHeads, receipts: unknownReceipts, readManifest: unknownRead });
    assert.equal(advisory.issue, null);
    assert.match(advisory.advisories[0], /cannot enumerate backend "mystery"/);
    unknownHeads[1].dispositions = [];
    assert.match(capIssue({ heads: unknownHeads, receipts: unknownReceipts, readManifest: unknownRead }).issue, /at least one disposition/);
    unknownReceipts.get(D('06')).blocking = 2;
    assert.match(capIssue({ heads: unknownHeads, receipts: unknownReceipts, readManifest: unknownRead }).advisories[0], /cannot enumerate|count/);
    unknownReceipts.get(D('05')).verdict = 'ship';
    unknownReceipts.get(D('06')).verdict = 'ship';
    const shipEnumeration = capIssue({ heads: unknownHeads, receipts: unknownReceipts, readManifest: unknownRead });
    assert.match(shipEnumeration.issue, /at least one disposition/);
    unknownHeads[1].dispositions = [{ findingDigest: D('77'), action: 'rejected', reason: 'fallback' }];
    assert.deepEqual(capIssue({ heads: unknownHeads, receipts: unknownReceipts, readManifest: unknownRead }), { issue: null, advisories: [shipEnumeration.advisories[0]] });

    const emptyPayload = JSON.stringify({ verdict: 'revise', findings: [{ severity: 'blocker', issue: '' }] });
    const emptyCarrier = carrier('codex', 'empty', emptyPayload);
    const emptyReceipts = new Map([[D('09'), receipt('codex', 'revise', 1, D('11'))], [D('0a'), receipt('codex', 'revise', 1, D('12'))]]);
    const emptyHeads = [head(1, D('11'), [dispatch('codex', 'old', D('09'), emptyCarrier.digest)]), head(2, D('12'), [dispatch('codex', 'empty', D('0a'), emptyCarrier.digest)])];
    const emptyFallback = capIssue({ heads: emptyHeads, receipts: emptyReceipts, readManifest: () => ({ outcome: 'ok', ...emptyCarrier }) });
    assert.match(emptyFallback.advisories[0], /issue is empty or not a string/);
    assert.match(emptyFallback.issue, /at least one disposition/);

    const shipReceipts = new Map([[D('07'), receipt('codex', 'ship', 2, D('11'))], [D('08'), receipt('codex', 'ship', 2, D('12'))]]);
    const shipHeads = [head(1, D('11'), [dispatch('codex', 'c1', D('07'), c1.digest)]), head(2, D('12'), [dispatch('codex', 'c2', D('08'), c2.digest)])];
    assert.match(capIssue({ heads: shipHeads, receipts: shipReceipts, readManifest: tableReader(table) }).issue, /\[blocker\] first/);
    shipReceipts.get(D('08')).blocking = undefined;
    const unreadableShip = capIssue({ heads: shipHeads, receipts: shipReceipts, readManifest: tableReader(table) });
    assert.equal(unreadableShip.issue, null);
    assert.match(unreadableShip.advisories[0], /not a non-negative integer/);

    for (const outcome of ['absent', 'malformed']) {
      table.set('codex:c2', { outcome });
      assert.match(capIssue({ heads, receipts, readManifest: tableReader(table) }).issue, new RegExp(`custody-lost --receipt ${D('03')}`));
    }
    heads[1].dispositions = [{ action: 'custody-lost', receiptDigest: D('03'), findingManifestDigest: c2.digest, reason: 'malformed' }];
    assert.equal(capIssue({ heads, receipts, readManifest: tableReader(table) }).issue, null, 'custody-lost covers the receipt; advisory fallback does not');
    table.set('codex:c2', { outcome: 'ok', ...c2 });
    assert.equal(capIssue({ heads, receipts, readManifest: tableReader(table) }).issue, null, 'a recorded loss is never re-judged after restoration');
    table.set('codex:c2', { outcome: 'ok', ...c2, bytes: Buffer.from('swapped') });
    heads[1].dispositions = [];
    assert.match(capIssue({ heads, receipts, readManifest: tableReader(table) }).issue, /swapped/);
    heads[1].dispatches = [];
    assert.equal(capIssue({ heads, receipts, readManifest: tableReader(table) }).issue, null, 'an empty latest landed set has no opinion');
  });

  it('requires the preceding round walk at the exact coordinates', () => {
    const args = { planId: 'plan-a', cycle: 1, stepId: 's1', round: 2, base: D('aa'), fingerprint: D('11') };
    assert.equal(walkIssue({ records: [], ...args }).includes('round 1'), true);
    assert.equal(walkIssue({ records: [], ...args, round: 1 }), null);
    const attestation = { kind: 'internal-attestation', ...args, round: 1, walk: { listVersion: 2, rows: [], uncovered: [] } };
    assert.equal(walkIssue({ records: [attestation], ...args }), null);
    assert.match(walkIssue({ records: [{ ...attestation, round: 0 }], ...args }), /round 1/);
  });

  it('resolves an override to this plan and round, and validates a coverage walk', () => {
    const s1Head = head(1, D('11'), [dispatch('codex', 'c1', D('01'), D('02'))]);
    const s2Head = { ...head(1, D('12'), [dispatch('codex', 'c2', D('03'), D('04'))]), stepId: 's2' };
    const override = { kind: 'maintainer-override', vetoReceiptDigest: D('03'), chainRecord: canonicalFlowDigest(s2Head) };
    const digest = canonicalFlowDigest(override);
    const records = [s1Head, s2Head, override];
    assert.match(escalationIssue({ records, digest, planId: 'plan-a', head: s1Head }).issue, /round 1/);
    assert.equal(escalationIssue({ records, digest, planId: 'plan-a', head: s2Head }).dispatch.backend, 'codex');
    assert.match(escalationIssue({ records, digest: D('ff'), planId: 'plan-a', head: s1Head }).issue, /not resolve/);
    const foreign = { ...s2Head, planId: 'foreign' };
    const foreignOverride = { ...override, chainRecord: canonicalFlowDigest(foreign) };
    assert.match(escalationIssue({ records: [foreign, foreignOverride], digest: canonicalFlowDigest(foreignOverride), planId: 'plan-a', head: s2Head }).issue, /plan-a/);

    const coverage = { listVersion: 2, rows: [{ id: 'R1', tagged: ['a'], present: ['b'], uncovered: ['b'], absent: false, deleted: false }] };
    const entries = [{ id: 'R1', class: 'a', checked: 'yes' }, { id: 'R1', class: 'b', checked: 'yes' }, { id: 'extra', class: 'x', checked: 'ignored' }];
    assert.deepEqual(validateWalk({ listVersion: 2, rows: entries }, coverage), { ok: true, walk: { listVersion: 2, rows: entries, uncovered: [{ id: 'R1', class: 'b' }] } });
    assert.match(validateWalk({ listVersion: 999, rows: entries }, coverage).reason, /listVersion/);
    assert.match(validateWalk({ listVersion: 2, rows: entries.slice(0, 1) }, coverage).reason, /R1:b/);
    assert.match(validateWalk({ listVersion: 2, rows: [{ ...entries[0], checked: '' }, entries[1]] }, coverage).reason, /R1:a/);
  });
});
