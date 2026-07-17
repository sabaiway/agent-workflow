// atomic-write.test.mjs — the NEW out-of-tree host-config core (bridges 2.3.0). The docs/ai path is
// proven by orchestration-write.test.mjs + gates-init.test.mjs (both consumers of the same core after
// the refactor); here we prove the host-config gate + the root-parameterized guards: dir create-if-
// absent, symlink/non-dir dir refusal, containment (no escape), symlinked-leaf refusal, and the TOCTOU
// re-check + tmp cleanup. Guards are exercised via injected deps (no real ~/.config touched).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHostConfigFileAtomic, writeContainedFileAtomic, assertDocsAiDeployment, ATOMIC_WRITE_STOP } from './atomic-write.mjs';

const isStop = (e) => e && e.code === ATOMIC_WRITE_STOP;
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
const fakeStat = (kind) => ({
  isSymbolicLink: () => kind === 'symlink',
  isDirectory: () => kind === 'dir',
  isFile: () => kind === 'file',
});

let tmp;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'awf-aw-')); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('writeHostConfigFileAtomic — real fs', () => {
  it('creates the dir if absent and writes the file atomically', () => {
    const dir = join(tmp, 'agent-workflow');
    const { writtenPath } = writeHostConfigFileAtomic(dir, 'bridge-settings.conf', 'KEY=v\n');
    assert.equal(writtenPath, join(dir, 'bridge-settings.conf'));
    assert.equal(readFileSync(writtenPath, 'utf8'), 'KEY=v\n');
    assert.equal(statSync(dir).isDirectory(), true);
  });

  it('refuses a SYMLINKED host dir (would write outside where the user thinks)', () => {
    const real = join(tmp, 'real');
    mkdirSync(real);
    const dir = join(tmp, 'link');
    symlinkSync(real, dir);
    assert.throws(() => writeHostConfigFileAtomic(dir, 'x.conf', 'body\n'), isStop);
    assert.equal(existsSync(join(real, 'x.conf')), false, 'nothing written through the symlink');
  });

  it('refuses a symlinked LEAF (a rename would clobber the link target)', () => {
    const dir = join(tmp, 'agent-workflow');
    mkdirSync(dir);
    const target = join(tmp, 'target.conf');
    writeFileSync(target, 'original\n');
    symlinkSync(target, join(dir, 'bridge-settings.conf'));
    assert.throws(() => writeHostConfigFileAtomic(dir, 'bridge-settings.conf', 'new\n'), isStop);
    assert.equal(readFileSync(target, 'utf8'), 'original\n', 'the link target is untouched');
  });
});

describe('host-config gate — injected deps', () => {
  const noopFs = () => ({ mkdir: () => {}, writeFile: () => {}, rename: () => {}, rm: () => {} });

  it('a non-directory dir → STOP (never writes through it)', () => {
    const deps = { ...noopFs(), lstat: () => fakeStat('file') };
    assert.throws(() => writeHostConfigFileAtomic('/some/dir', 'x.conf', 'b', deps), (e) => isStop(e) && /not a directory/.test(e.message));
  });

  it('a symlinked dir → STOP', () => {
    const deps = { ...noopFs(), lstat: (p) => (p === '/d' ? fakeStat('symlink') : (() => { throw enoent(); })()) };
    assert.throws(() => writeHostConfigFileAtomic('/d', 'x.conf', 'b', deps), (e) => isStop(e) && /symlink/.test(e.message));
  });
});

// T7 unit cases (Decision 5): the deployment gate walks the PARENT chain (cwd root + the docs
// component) before any read, re-throwing the fs-safe walk error as the CALLER's typed stop — a
// bare Error would break each consumer's `.code` contract. The docs/ai LEAF keeps its existing
// checks and messages; an ABSENT docs/ai stays the normal "no deployment" STOP (ENOENT-safe walk).
describe('assertDocsAiDeployment — parent-chain preflight (Decision 5)', () => {
  const callerStop = (message) => Object.assign(new Error(message), { code: 'CALLER_STOP' });

  it('a symlinked cwd ROOT throws the CALLER typed stop, before any read', () => {
    const lstat = (p) => (p === '/proj' ? fakeStat('symlink') : (() => { throw enoent(); })());
    assert.throws(
      () => assertDocsAiDeployment('/proj', { lstat }, { stop: callerStop }),
      (e) => e.code === 'CALLER_STOP' && /symlink/.test(e.message),
    );
  });

  it('a symlinked INTERMEDIATE docs component throws the CALLER typed stop naming it', () => {
    const lstat = (p) => {
      if (p === '/proj') return fakeStat('dir');
      if (p === join('/proj', 'docs')) return fakeStat('symlink');
      throw enoent();
    };
    assert.throws(
      () => assertDocsAiDeployment('/proj', { lstat }, { stop: callerStop }),
      (e) => e.code === 'CALLER_STOP' && /docs/.test(e.message) && /symlink/.test(e.message),
    );
  });

  it('contained happy path: real dirs all the way down → no throw', () => {
    const lstat = () => fakeStat('dir');
    assertDocsAiDeployment('/proj', { lstat }, { stop: callerStop });
  });

  it('T7b: an ABSENT docs/ai (brand-new project) yields the EXISTING no-deployment STOP, never a symlink STOP', () => {
    const lstat = (p) => (p === '/proj' ? fakeStat('dir') : (() => { throw enoent(); })());
    assert.throws(
      () => assertDocsAiDeployment('/proj', { lstat }, { stop: callerStop }),
      (e) => e.code === 'CALLER_STOP' && /docs\/ai is absent/.test(e.message) && !/symlink/.test(e.message),
    );
  });
});

describe('writeContainedFileAtomic — root-parameterized guards', () => {
  it('refuses a dst that ESCAPES the containment root', () => {
    const deps = { lstat: () => { throw enoent(); }, writeFile: () => {}, rename: () => {}, rm: () => {} };
    assert.throws(
      () => writeContainedFileAtomic('/root', '/root/../etc/evil', 'b', deps),
      /refusing to write outside the target dir/,
    );
  });

  it('TOCTOU: a leaf that BECOMES a symlink between the pre-check and the rename → STOP + tmp cleaned up', () => {
    const root = '/root';
    const dst = '/root/bridge-settings.conf';
    let dstLstats = 0;
    const removed = [];
    const written = [];
    const lstat = (p) => {
      if (p === root) return fakeStat('dir');
      if (p === dst) {
        dstLstats += 1;
        if (dstLstats >= 4) return fakeStat('symlink'); // flips right at the final leaf re-check
        throw enoent();
      }
      throw enoent(); // tmp absent
    };
    const deps = {
      lstat,
      writeFile: (p) => written.push(p),
      rename: () => { throw new Error('rename must not run once the leaf turned into a symlink'); },
      rm: (p) => removed.push(p),
      rand: () => 'fixed',
    };
    assert.throws(() => writeContainedFileAtomic(root, dst, 'b', deps), (e) => isStop(e) && /became a symlink/.test(e.message));
    assert.equal(written.length, 1, 'the tmp was created');
    assert.deepEqual(removed, written, 'and cleaned up on the TOCTOU failure — never left behind');
  });

  it('a rename failure cleans up the tmp and rethrows the native error', () => {
    const root = '/root';
    const dst = '/root/x.conf';
    const removed = [];
    const deps = {
      lstat: (p) => (p === root ? fakeStat('dir') : (() => { throw enoent(); })()),
      writeFile: () => {},
      rename: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); },
      rm: (p) => removed.push(p),
      rand: () => 'fixed',
    };
    assert.throws(() => writeContainedFileAtomic(root, dst, 'b', deps), /EIO/);
    assert.deepEqual(removed, ['/root/x.conf.fixed.tmp'], 'the tmp is removed on any post-create failure');
  });
});
