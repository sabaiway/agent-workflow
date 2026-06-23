import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync, readFileSync, existsSync, lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertContainedRealPath,
  copyTreeRefresh,
  linkManaged,
  MANAGED_LINK_CONFLICT,
} from './fs-safe.mjs';

// All three primitives are SYNC and operate on real tmp dirs here (the symlink behaviours are
// fiddly enough that real fs is the honest test). The out-of-root case needs no fs at all.
let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awf-fs-safe-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── assertContainedRealPath ───────────────────────────────────────────────────

describe('assertContainedRealPath', () => {
  it('rejects a dest outside the root (no fs needed — the relative check fires first)', () => {
    assert.throws(() => assertContainedRealPath('/root', '/root/../etc/passwd'), /outside/);
    assert.throws(() => assertContainedRealPath('/root', '/etc/passwd'), /outside/);
  });

  it('rejects writing INTO a symlinked root', () => {
    const real = join(dir, 'real');
    const root = join(dir, 'root');
    mkdirSync(real);
    symlinkSync(real, root);
    assert.throws(() => assertContainedRealPath(root, join(root, 'x')), /symlink/i);
  });

  it('rejects writing THROUGH a symlinked intermediate component', () => {
    const root = join(dir, 'root');
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(root);
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, 'sub'));
    assert.throws(() => assertContainedRealPath(root, join(root, 'sub', 'file')), /symlink/i);
  });

  it('rejects a symlinked leaf dest', () => {
    const root = join(dir, 'root');
    mkdirSync(root);
    symlinkSync(join(dir, 'target'), join(root, 'leaf'));
    assert.throws(() => assertContainedRealPath(root, join(root, 'leaf')), /symlink/i);
  });

  it('accepts a clean dest within the root', () => {
    const root = join(dir, 'root');
    mkdirSync(root);
    assert.doesNotThrow(() => assertContainedRealPath(root, join(root, 'a', 'b', 'c')));
  });

  it('lstat is injectable (closes the install.mjs injectability gap)', () => {
    let seen = 0;
    const lstat = (p) => { seen += 1; return { isSymbolicLink: () => false }; };
    assert.doesNotThrow(() => assertContainedRealPath('/root', '/root/a/b', { lstat }));
    assert.ok(seen > 0, 'the injected lstat was used');
  });
});

// ── copyTreeRefresh ───────────────────────────────────────────────────────────

describe('copyTreeRefresh', () => {
  it('overwrites an existing regular file (refresh)', () => {
    const root = join(dir, 'dest');
    mkdirSync(root);
    const src = join(dir, 'src.txt');
    const dest = join(root, 'f.txt');
    writeFileSync(src, 'new');
    writeFileSync(dest, 'old');
    copyTreeRefresh(src, dest, root);
    assert.equal(readFileSync(dest, 'utf8'), 'new');
  });

  it('copies a nested directory tree', () => {
    const src = join(dir, 'src');
    const root = join(dir, 'dest');
    mkdirSync(join(src, 'a'), { recursive: true });
    writeFileSync(join(src, 'top.txt'), 'T');
    writeFileSync(join(src, 'a', 'deep.txt'), 'D');
    mkdirSync(root);
    copyTreeRefresh(src, join(root, 'src'), root);
    assert.equal(readFileSync(join(root, 'src', 'top.txt'), 'utf8'), 'T');
    assert.equal(readFileSync(join(root, 'src', 'a', 'deep.txt'), 'utf8'), 'D');
  });

  it('skips a symlink whose dest already exists (additive — never replace)', () => {
    const root = join(dir, 'dest');
    mkdirSync(root);
    const linkSrc = join(dir, 'link');
    symlinkSync(join(dir, 'whatever'), linkSrc); // src IS a symlink
    const dest = join(root, 'f');
    writeFileSync(dest, 'keep');
    copyTreeRefresh(linkSrc, dest, root);
    assert.equal(readFileSync(dest, 'utf8'), 'keep'); // untouched
    assert.equal(lstatSync(dest).isSymbolicLink(), false);
  });

  it('STOPs on a symlinked dest component (never writes through it)', () => {
    const root = join(dir, 'root');
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(root);
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, 'sub'));
    const src = join(dir, 's.txt');
    writeFileSync(src, 'x');
    assert.throws(() => copyTreeRefresh(src, join(root, 'sub', 'f.txt'), root), /symlink/i);
    assert.equal(existsSync(join(elsewhere, 'f.txt')), false); // no leak
  });
});

// ── linkManaged ───────────────────────────────────────────────────────────────

describe('linkManaged', () => {
  const makeSrc = () => {
    const src = join(dir, 'src.sh');
    writeFileSync(src, '#!/bin/sh\n');
    return src;
  };

  it('creates a symlink when the dest is absent', () => {
    const src = makeSrc();
    const root = join(dir, 'bin');
    mkdirSync(root);
    const dest = join(root, 'cmd');
    const result = linkManaged(src, dest, root);
    assert.equal(result, 'linked');
    assert.equal(lstatSync(dest).isSymbolicLink(), true);
    assert.equal(readlinkSync(dest), src);
  });

  it('creates the parent bindir if absent (mkdir -p)', () => {
    const src = makeSrc();
    const root = join(dir, 'base');
    mkdirSync(root);
    const dest = join(root, 'newbin', 'cmd');
    linkManaged(src, dest, root);
    assert.equal(readlinkSync(dest), src);
  });

  it('is idempotent — a second call is a no-op', () => {
    const src = makeSrc();
    const root = join(dir, 'bin');
    mkdirSync(root);
    const dest = join(root, 'cmd');
    linkManaged(src, dest, root);
    const again = linkManaged(src, dest, root);
    assert.equal(again, 'noop');
    assert.equal(readlinkSync(dest), src);
  });

  it('STOPs on a non-symlink dest (typed ManagedLinkConflict)', () => {
    const src = makeSrc();
    const root = join(dir, 'bin');
    mkdirSync(root);
    const dest = join(root, 'cmd');
    writeFileSync(dest, 'someone-elses-file');
    assert.throws(() => linkManaged(src, dest, root), (err) => err.code === MANAGED_LINK_CONFLICT);
    assert.equal(readFileSync(dest, 'utf8'), 'someone-elses-file'); // untouched
  });

  it('STOPs on a foreign symlink (points elsewhere)', () => {
    const src = makeSrc();
    const root = join(dir, 'bin');
    mkdirSync(root);
    const dest = join(root, 'cmd');
    const foreign = join(dir, 'foreign.sh');
    writeFileSync(foreign, '#!/bin/sh\n');
    symlinkSync(foreign, dest);
    assert.throws(() => linkManaged(src, dest, root), (err) => err.code === MANAGED_LINK_CONFLICT);
    assert.equal(readlinkSync(dest), foreign); // untouched
  });

  it('refuses a symlinked source (never links through a symlink)', () => {
    const realSrc = makeSrc();
    const linkSrc = join(dir, 'link.sh');
    symlinkSync(realSrc, linkSrc);
    const root = join(dir, 'bin');
    mkdirSync(root);
    assert.throws(() => linkManaged(linkSrc, join(root, 'cmd'), root), /symlink/i);
  });

  it('refuses a non-regular-file source (e.g. a directory)', () => {
    const srcDir = join(dir, 'src-dir');
    mkdirSync(srcDir);
    const root = join(dir, 'bin');
    mkdirSync(root);
    assert.throws(() => linkManaged(srcDir, join(root, 'cmd'), root), /regular file/i);
  });
});
