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
  removeTreeManaged,
  unlinkManaged,
  MANAGED_LINK_CONFLICT,
  isReadonlyWriteBoundary,
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

  it('Issue-004: accepts a contained child literally named "..foo", still rejects a true ".." segment', () => {
    // rel "..foo" is a real child, NOT a "../" escape — the old `rel.startsWith('..')` wrongly rejected it.
    assert.doesNotThrow(() => assertContainedRealPath(dir, join(dir, '..foo')));
    assert.throws(() => assertContainedRealPath(dir, join(dir, '..', 'escape')), /outside/);
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

// ── copyTreeRefresh — read-only write-boundary tagging (REFRESH-EROFS-HONESTY / AD-056) ──
// A destination-side write failure of the read-only class (EROFS/EACCES/EPERM) at one of the three
// write primitives is TAGGED (err.readonlyWriteBoundary) so the refresh-only driver can classify an
// equal-version repair-on-rerun that cannot write as a STATED skip — never a false red. A READ-side
// failure, a source-side copyFile failure, or a non-read-only errno is NEVER tagged (it stays loud).
describe('copyTreeRefresh — read-only write-boundary tagging', () => {
  const errno = (code) => () => { throw Object.assign(new Error(`${code}: injected`), { code }); };
  const catchErr = (fn) => { try { fn(); return null; } catch (e) { return e; } };

  const fileSrcDest = () => {
    const src = join(dir, 'src.txt');
    const root = join(dir, 'dest');
    mkdirSync(root);
    writeFileSync(src, 'payload');
    return { src, root, dest: join(root, 'f.txt') };
  };

  for (const code of ['EROFS', 'EACCES', 'EPERM']) {
    it(`copyFile ${code} with a READABLE source → tagged (destination-side), original errno preserved`, () => {
      const { src, root, dest } = fileSrcDest();
      const err = catchErr(() => copyTreeRefresh(src, dest, root, { copyFile: errno(code) }));
      assert.ok(err, 'the copy threw');
      assert.equal(err.code, code, 'the original errno is preserved (never message-matched)');
      assert.equal(err.readonlyWriteBoundary, true, `${code} at the copyFile write boundary with a readable source is tagged`);
    });
  }

  it('copyFile EACCES with an UNREADABLE source → NOT tagged (source-side stays loud)', () => {
    const { src, root, dest } = fileSrcDest();
    const err = catchErr(() => copyTreeRefresh(src, dest, root, {
      copyFile: errno('EACCES'),
      readFile: () => { throw Object.assign(new Error('EACCES: src unreadable'), { code: 'EACCES' }); },
    }));
    assert.ok(err);
    assert.notEqual(err.readonlyWriteBoundary, true, 'an unreadable source is a source-side failure, never a write-boundary skip');
  });

  it('EROFS is destination-side by nature — copyFile EROFS never probes/needs the source', () => {
    const { src, root, dest } = fileSrcDest();
    let probed = false;
    const err = catchErr(() => copyTreeRefresh(src, dest, root, {
      copyFile: errno('EROFS'),
      readFile: () => { probed = true; throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    }));
    assert.equal(err.readonlyWriteBoundary, true, 'EROFS tags regardless of source readability');
    assert.equal(probed, false, 'a read-only-filesystem error needs no source-side disambiguation');
  });

  it('mkdir EROFS (a nested dir tree) → tagged (mkdir writes only the dest)', () => {
    const src = join(dir, 'src');
    const root = join(dir, 'dest');
    mkdirSync(join(src, 'a'), { recursive: true });
    writeFileSync(join(src, 'a', 'deep.txt'), 'D');
    mkdirSync(root);
    const err = catchErr(() => copyTreeRefresh(src, join(root, 'src'), root, { mkdir: errno('EROFS') }));
    assert.equal(err.readonlyWriteBoundary, true);
  });

  it('symlink EROFS (mirroring a symlink src to an absent dest) → tagged (symlink writes only the dest)', () => {
    const root = join(dir, 'dest');
    mkdirSync(root);
    const linkSrc = join(dir, 'link');
    symlinkSync(join(dir, 'target'), linkSrc);
    const err = catchErr(() => copyTreeRefresh(linkSrc, join(root, 'f'), root, { symlink: errno('EROFS') }));
    assert.equal(err.readonlyWriteBoundary, true);
  });

  it('a NON-read-only errno (EIO) at a write is NOT tagged (a real I/O failure stays loud)', () => {
    const { src, root, dest } = fileSrcDest();
    const err = catchErr(() => copyTreeRefresh(src, dest, root, { copyFile: errno('EIO') }));
    assert.notEqual(err.readonlyWriteBoundary, true);
  });

  it('a READ-side EROFS (readdir) is NOT tagged (only the write primitives carry the tag)', () => {
    const src = join(dir, 'src');
    const root = join(dir, 'dest');
    mkdirSync(src);
    writeFileSync(join(src, 'x.txt'), 'x');
    mkdirSync(root);
    // mkdir(dest) succeeds (real), then readdir(src) throws EROFS — a read, never tagged.
    const err = catchErr(() => copyTreeRefresh(src, join(root, 'src'), root, { readdir: errno('EROFS') }));
    assert.ok(err);
    assert.notEqual(err.readonlyWriteBoundary, true, 'a read-side EROFS must stay a loud failure');
  });

  it('isReadonlyWriteBoundary reflects the tag (and is false for a bare/plain error)', () => {
    const { src, root, dest } = fileSrcDest();
    const tagged = catchErr(() => copyTreeRefresh(src, dest, root, { copyFile: errno('EROFS') }));
    assert.equal(isReadonlyWriteBoundary(tagged), true);
    assert.equal(isReadonlyWriteBoundary(new Error('plain')), false);
    assert.equal(isReadonlyWriteBoundary(null), false);
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

// ── removeTreeManaged ───────────────────────────────────────────────────────────

describe('removeTreeManaged', () => {
  it('recursively removes a managed dir tree', () => {
    const root = join(dir, 'skills');
    const skill = join(root, 'agent-workflow-kit');
    mkdirSync(join(skill, 'tools'), { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), 'x');
    writeFileSync(join(skill, 'tools', 'a.mjs'), 'y');
    const result = removeTreeManaged(skill, root);
    assert.equal(result, 'removed');
    assert.equal(existsSync(skill), false);
    assert.equal(existsSync(root), true); // only the target went, not the parent
  });

  it('is a no-op when the target is already absent', () => {
    const root = join(dir, 'skills');
    mkdirSync(root);
    assert.equal(removeTreeManaged(join(root, 'gone'), root), 'noop');
  });

  it('STOPs on a symlinked target (never follows + deletes through it)', () => {
    const root = join(dir, 'skills');
    const real = join(dir, 'real-skill');
    mkdirSync(root);
    mkdirSync(real);
    writeFileSync(join(real, 'keep.txt'), 'keep');
    symlinkSync(real, join(root, 'agent-workflow-kit')); // the skill dir is a symlink
    assert.throws(() => removeTreeManaged(join(root, 'agent-workflow-kit'), root), /symlink/i);
    assert.equal(existsSync(join(real, 'keep.txt')), true); // the target it pointed at is untouched
  });

  it('removes a symlink ENTRY inside the tree without touching what it points at', () => {
    const root = join(dir, 'skills');
    const skill = join(root, 'agent-workflow-kit');
    const outside = join(dir, 'outside');
    mkdirSync(skill, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, 'precious.txt'), 'precious');
    symlinkSync(outside, join(skill, 'link-to-outside')); // an internal symlink
    removeTreeManaged(skill, root);
    assert.equal(existsSync(skill), false);
    assert.equal(existsSync(join(outside, 'precious.txt')), true); // never recursed through the link
  });

  it('refuses a target outside the root', () => {
    const root = join(dir, 'skills');
    mkdirSync(root);
    assert.throws(() => removeTreeManaged(join(dir, 'elsewhere'), root), /outside/);
  });

  it('rm is injectable (no real deletion when injected)', () => {
    const root = join(dir, 'skills');
    const skill = join(root, 'agent-workflow-kit');
    mkdirSync(skill, { recursive: true });
    let removed = null;
    const result = removeTreeManaged(skill, root, { rm: (p) => { removed = p; } });
    assert.equal(result, 'removed');
    assert.equal(removed, skill);
    assert.equal(existsSync(skill), true); // the injected rm did nothing
  });
});

// ── unlinkManaged ───────────────────────────────────────────────────────────────

describe('unlinkManaged', () => {
  const makeSrc = () => {
    const src = join(dir, 'src.sh');
    writeFileSync(src, '#!/bin/sh\n');
    return src;
  };

  it('unlinks a symlink that points at our source', () => {
    const src = makeSrc();
    const root = join(dir, 'bin');
    mkdirSync(root);
    const dest = join(root, 'cmd');
    symlinkSync(src, dest);
    const result = unlinkManaged(dest, src, root);
    assert.equal(result, 'unlinked');
    assert.equal(existsSync(dest), false);
    assert.equal(existsSync(src), true); // the source it pointed at is untouched
  });

  it('is a no-op when the dest is absent', () => {
    const src = makeSrc();
    const root = join(dir, 'bin');
    mkdirSync(root);
    assert.equal(unlinkManaged(join(root, 'cmd'), src, root), 'noop');
  });

  it('STOPs on a non-symlink dest (typed ManagedLinkConflict)', () => {
    const src = makeSrc();
    const root = join(dir, 'bin');
    mkdirSync(root);
    const dest = join(root, 'cmd');
    writeFileSync(dest, 'someone-elses-file');
    assert.throws(() => unlinkManaged(dest, src, root), (err) => err.code === MANAGED_LINK_CONFLICT);
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
    assert.throws(() => unlinkManaged(dest, src, root), (err) => err.code === MANAGED_LINK_CONFLICT);
    assert.equal(readlinkSync(dest), foreign); // untouched
  });

  it('removes a dangling symlink that still textually points at our source', () => {
    const src = join(dir, 'src.sh'); // never created → the link is dangling
    const root = join(dir, 'bin');
    mkdirSync(root);
    const dest = join(root, 'cmd');
    symlinkSync(src, dest);
    assert.equal(unlinkManaged(dest, src, root), 'unlinked');
    assert.equal(lstatSync(root).isDirectory(), true);
    assert.equal(existsSync(dest), false);
  });

  it('unlink is injectable', () => {
    const src = makeSrc();
    const root = join(dir, 'bin');
    mkdirSync(root);
    const dest = join(root, 'cmd');
    symlinkSync(src, dest);
    let unlinked = null;
    const result = unlinkManaged(dest, src, root, { unlink: (p) => { unlinked = p; } });
    assert.equal(result, 'unlinked');
    assert.equal(unlinked, dest);
    assert.equal(existsSync(dest), true); // the injected unlink did nothing
  });
});
