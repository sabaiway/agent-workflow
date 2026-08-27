// ack-store.test.mjs — the one guarded reader, the closed lane registry and the fingerprint shape
// (docs/ai/specs/kit/ack-store.md). Dynamic import: the suite LOADS without the module under test.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const store = await import('./ack-store.mjs').catch(() => ({}));
const { ACKS_FILE, ACK_LANES, FINGERPRINT_LENGTH, factFingerprint, readAckValue } = store;
const { FINGERPRINT_PATTERN } = await import('./ack-write.mjs').catch(() => ({}));

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const deployed = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ack-store-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
  return dir;
};
const KEY = 'coverageDomainAck';

describe('readAckValue — the not-yet-acked states read null', () => {
  it('an absent store or an absent docs/ai reads null, and a recorded string at the key reads back (spec:ack-store/S1)', () => {
    const root = deployed();
    assert.equal(readAckValue(root, {}, KEY), null, 'absent store');
    writeFileSync(join(root, ACKS_FILE), JSON.stringify({ [KEY]: 'abcdef0123456789', other: 'kept' }));
    assert.equal(readAckValue(root, {}, KEY), 'abcdef0123456789');
    assert.equal(readAckValue(root, {}, 'sandboxLaneAck'), null, 'an unset key reads null');
    writeFileSync(join(root, ACKS_FILE), JSON.stringify({ [KEY]: 123 }));
    assert.equal(readAckValue(root, {}, KEY), null, 'a non-string value is tolerated as not acked');
    rmSync(join(root, 'docs'), { recursive: true, force: true });
    assert.equal(readAckValue(root, {}, KEY), null, 'absent docs/ai');
  });
});

describe('readAckValue — every unproven state throws (fail closed)', () => {
  it('a symlinked leaf, a directory where the file belongs and a malformed or non-object store all throw (spec:ack-store/S2)', () => {
    const linked = deployed();
    symlinkSync(join(linked, 'nowhere'), join(linked, ACKS_FILE));
    assert.throws(() => readAckValue(linked, {}, KEY), /symlink/i);
    const dir = deployed();
    mkdirSync(join(dir, ACKS_FILE));
    assert.throws(() => readAckValue(dir, {}, KEY), /not a regular file/);
    const malformed = deployed();
    writeFileSync(join(malformed, ACKS_FILE), '{ not json');
    assert.throws(() => readAckValue(malformed, {}, KEY), SyntaxError);
    const array = deployed();
    writeFileSync(join(array, ACKS_FILE), '[]');
    assert.throws(() => readAckValue(array, {}, KEY), /expected a JSON object/);
    const io = deployed();
    writeFileSync(join(io, ACKS_FILE), JSON.stringify({ [KEY]: 'abcdef0123456789' }));
    const eacces = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    assert.throws(() => readAckValue(io, { nofollow: { open: eacces } }, KEY), /cannot be read/, 'the leaf is read through the no-follow door');
    assert.equal(readAckValue(io, { readFile: eacces }, KEY), 'abcdef0123456789', 'a path-based readFile is no longer on the read path');
  });
});

describe('the fingerprint shape and the lane registry', () => {
  it('the fingerprint is the 16-hex sha256 prefix the writer accepts, and the lane registry maps every lane to a key (spec:ack-store/S3)', () => {
    const fp = factFingerprint('spec-adoption:declined:docs/ai/specs/');
    assert.equal(fp.length, FINGERPRINT_LENGTH);
    assert.match(fp, FINGERPRINT_PATTERN);
    assert.equal(fp, factFingerprint('spec-adoption:declined:docs/ai/specs/'), 'deterministic');
    assert.notEqual(fp, factFingerprint('another fact'));
    assert.ok(Object.isFrozen(ACK_LANES));
    assert.deepEqual(Object.keys(ACK_LANES).sort(), ['coverage-domain', 'sandbox-lane', 'source-size-copy', 'spec-adoption', 'worktrees-dir']);
    for (const key of Object.values(ACK_LANES)) assert.match(key, /^[a-z][A-Za-z]+Ack$/, key);
    assert.equal(new Set(Object.values(ACK_LANES)).size, Object.keys(ACK_LANES).length, 'no two lanes share a key');
  });
});
