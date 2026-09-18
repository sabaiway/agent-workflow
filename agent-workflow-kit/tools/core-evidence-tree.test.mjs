import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isBinaryFile, computeFingerprintPayload } from './core-evidence-tree.mjs';
import { makeRepo } from './core-evidence-harness.test.mjs';

// spec:core-evidence/S1
describe('review-domain primitives — the defensive arms of the canonical payload walk', () => {
  it('isBinaryFile: NUL bytes → binary; text → false; an unreadable read (EISDIR) → false via the catch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-evidence-bin-'));
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0x61, 0x00, 0x62]));
    writeFileSync(join(dir, 'text.txt'), 'plain text\n');
    assert.equal(isBinaryFile(join(dir, 'bin.dat')), true);
    assert.equal(isBinaryFile(join(dir, 'text.txt')), false);
    assert.equal(isBinaryFile(dir), false, 'a directory read fails (EISDIR) — the fail-safe arm reads as text');
    rmSync(dir, { recursive: true, force: true });
  });

  it('computeFingerprintPayload: a THROWING lstat keeps the path as a name-only nonregular note (vanished path)', () => {
    const { root } = makeRepo();
    writeFileSync(join(root, 'ghosty.txt'), 'untracked\n');
    const throwingLstat = (p) => {
      if (p.endsWith('ghosty.txt')) throw new Error('vanished');
      return lstatSync(p);
    };
    const payload = computeFingerprintPayload(root, { lstat: throwingLstat });
    assert.match(payload.toString('utf8'), /untracked-nonregular:ghosty\.txt/);
    rmSync(root, { recursive: true, force: true });
  });

  it('computeFingerprintPayload: a lying symlink stat whose readlink fails rides as "-> ?" (never a crash)', () => {
    const { root } = makeRepo();
    writeFileSync(join(root, 'fake-link.txt'), 'a regular file the stat calls a symlink\n');
    const lyingLstat = (p) => {
      const real = lstatSync(p);
      if (!p.endsWith('fake-link.txt')) return real;
      return { ...real, isFile: () => false, isSymbolicLink: () => true, isCharacterDevice: () => false, isBlockDevice: () => false, isFIFO: () => false, isSocket: () => false, isDirectory: () => false };
    };
    const payload = computeFingerprintPayload(root, { lstat: lyingLstat });
    assert.match(payload.toString('utf8'), /untracked-symlink:fake-link\.txt -> \?/);
    rmSync(root, { recursive: true, force: true });
  });
});
