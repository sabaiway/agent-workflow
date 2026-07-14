// fs-safe.mjs — pure, dependency-injectable filesystem-safety primitives shared by the kit installer
// (bin/install.mjs) and the backend linker (tools/setup-backends.mjs). Importing this module has NO
// side effects: it runs nothing. Every fs primitive is injectable via `deps.*` so the guards are
// unit-testable without touching the real filesystem; the defaults are Node's SYNC fs (matching the
// tools/ detector style). Dependency-free, Node >= 18.
//
// Five primitives:
//   assertContainedRealPath — refuse to write through/into a symlink, or to a dest outside a root.
//   copyTreeRefresh         — recursive copy that OVERWRITES regular files (refresh), SKIPS a symlink
//                             whose dest already exists (additive), and guards every dest component.
//   linkManaged             — create/keep ONLY a symlink we own; STOP (typed ManagedLinkConflict) on
//                             a foreign symlink or a non-symlink dest; refuse a symlinked source.
//   removeTreeManaged       — the inverse of copyTreeRefresh: recursively remove a dir/file ONLY when
//                             it (and its path) is not reached through a symlink and stays within root.
//   unlinkManaged           — the inverse of linkManaged: remove ONLY a symlink whose target is ours;
//                             STOP (typed ManagedLinkConflict) on a foreign symlink or a non-symlink.

import {
  lstatSync, existsSync, mkdirSync, readdirSync, copyFileSync, readlinkSync, symlinkSync,
  rmSync, unlinkSync, readFileSync,
} from 'node:fs';
import { dirname, join, resolve, relative, sep, isAbsolute } from 'node:path';

// A managed-link conflict is a distinct, expected outcome (a foreign/non-symlink dest we refuse to
// clobber) — callers branch on `.code`. Modelled as a tagged Error (no classes — §agent_rules 2.3),
// the same `Object.assign(new Error(), { code })` idiom the codebase already uses for typed errors.
export const MANAGED_LINK_CONFLICT = 'MANAGED_LINK_CONFLICT';
const managedLinkConflict = (message, fields = {}) =>
  Object.assign(new Error(`[agent-workflow-kit] ${message}`), {
    name: 'ManagedLinkConflict',
    code: MANAGED_LINK_CONFLICT,
    ...fields,
  });

// lstat without following symlinks; null when absent. A non-ENOENT fs error (EACCES/EIO) must NOT
// fail open (be read as "not a symlink") — it propagates so the guard can never be bypassed.
const lstatNoFollow = (path, lstat) => {
  try {
    return lstat(path);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
};

// Symlink-traversal guard: refuse to write *through* any symlink at or above `dest` within `root`
// (root / intermediate dir / leaf, including a dangling one), or to a dest outside `root`.
export const assertContainedRealPath = (root, dest, deps = {}) => {
  const lstat = deps.lstat ?? lstatSync;
  const ln = (p) => lstatNoFollow(p, lstat);
  const rel = relative(root, dest);
  // A true escape is `..` exactly or a `..`-prefixed PATH SEGMENT (`../x`) — NOT any string starting
  // with the two chars "..": a legitimately-contained child literally named `..foo` has rel `..foo`,
  // which the old `rel.startsWith('..')` wrongly rejected (Issue-004 — same fix as the engine/memory installers).
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`[agent-workflow-kit] refusing to write outside the target dir: ${dest}`);
  }
  if (ln(root)?.isSymbolicLink()) {
    throw new Error(`[agent-workflow-kit] refusing to install into a symlinked target dir: ${root}`);
  }
  const walk = (acc, part) => {
    const cur = join(acc, part);
    if (ln(cur)?.isSymbolicLink()) {
      throw new Error(`[agent-workflow-kit] refusing to write through a symlink at ${cur} (would escape ${root}).`);
    }
    return cur;
  };
  rel.split(sep).filter(Boolean).reduce(walk, root);
};

// Read-only write-boundary tagging (REFRESH-EROFS-HONESTY / AD-056). A DESTINATION-side write failure
// of the read-only class is TAGGED (err.readonlyWriteBoundary) so the refresh-only driver can classify
// an equal-version repair-on-rerun that cannot write as a STATED skip — never a false red. The tag is
// applied ONLY around the three write primitives, so a READ-side failure (bundle read / dir listing)
// is never absorbed: the degrade classifies at the write boundary, not by a broad err.code sniff over
// the whole copy. EROFS is destination-side by nature; mkdir/symlink write only the dest; an
// EACCES/EPERM at copyFile (which also READS the source) is destination-provable ONLY when the source
// is readable — else it is a source-side read failure that must stay loud.
const READONLY_WRITE_ERRNOS = new Set(['EROFS', 'EACCES', 'EPERM']);
export const isReadonlyWriteBoundary = (err) => Boolean(err && err.readonlyWriteBoundary);
const throwTaggedReadonly = (err, primitive, src, readFile) => {
  if (err && READONLY_WRITE_ERRNOS.has(err.code)) {
    let destinationSide = err.code === 'EROFS' || primitive !== 'copyFile';
    if (!destinationSide) {
      try { readFile(src); destinationSide = true; } catch { destinationSide = false; }
    }
    if (destinationSide) err.readonlyWriteBoundary = true;
  }
  throw err;
};

// Recursive refresh copy. Guards every dest via assertContainedRealPath first, then:
//   symlink src   → additive: skip if dest exists, else mirror the link target.
//   directory src → mkdir -p dest, recurse.
//   regular file  → mkdir -p parent, copyFile (OVERWRITE = refresh to the bundled version).
export const copyTreeRefresh = (src, dest, root, deps = {}) => {
  const lstat = deps.lstat ?? lstatSync;
  const exists = deps.exists ?? existsSync;
  const mkdir = deps.mkdir ?? ((p) => mkdirSync(p, { recursive: true }));
  const readdir = deps.readdir ?? readdirSync;
  const copyFile = deps.copyFile ?? copyFileSync;
  const readlink = deps.readlink ?? readlinkSync;
  const symlink = deps.symlink ?? symlinkSync;
  const readFile = deps.readFile ?? readFileSync;

  assertContainedRealPath(root, dest, deps);
  const stat = lstat(src);
  if (stat.isSymbolicLink()) {
    if (exists(dest)) return;
    const target = readlink(src); // read-side (a readlink failure is never tagged as a write boundary)
    try { symlink(target, dest); } catch (err) { throwTaggedReadonly(err, 'symlink', src, readFile); }
  } else if (stat.isDirectory()) {
    try { mkdir(dest); } catch (err) { throwTaggedReadonly(err, 'mkdir', src, readFile); }
    for (const entry of readdir(src)) {
      copyTreeRefresh(join(src, entry), join(dest, entry), root, deps);
    }
  } else {
    try { mkdir(dirname(dest)); } catch (err) { throwTaggedReadonly(err, 'mkdir', src, readFile); }
    try { copyFile(src, dest); } catch (err) { throwTaggedReadonly(err, 'copyFile', src, readFile); }
  }
};

// Create/keep ONLY a symlink we own. `src` must be a real regular file (never a symlink); `dest`
// must stay within `root`. Outcomes: 'linked' (created), 'noop' (already points at our src), or a
// thrown ManagedLinkConflict (a non-symlink, or a symlink pointing elsewhere — never clobbered).
export const linkManaged = (src, dest, root, deps = {}) => {
  const lstat = deps.lstat ?? lstatSync;
  const mkdir = deps.mkdir ?? ((p) => mkdirSync(p, { recursive: true }));
  const readlink = deps.readlink ?? readlinkSync;
  const symlink = deps.symlink ?? symlinkSync;

  const srcStat = lstat(src);
  if (srcStat.isSymbolicLink()) {
    throw new Error(`[agent-workflow-kit] refusing to link a symlinked source (would escape our ownership): ${src}`);
  }
  if (!srcStat.isFile()) {
    throw new Error(`[agent-workflow-kit] link source is not a regular file: ${src}`);
  }

  // Guard the PARENT chain (root + intermediate dirs), not the leaf: managing the leaf symlink is
  // exactly this function's job, so it inspects the leaf itself rather than letting the traversal
  // guard reject every symlinked dest. `dirname(dest)` within `root` ⇒ `dest` within `root` too.
  assertContainedRealPath(root, dirname(dest), deps);
  const existing = lstatNoFollow(dest, lstat);
  if (existing === null) {
    mkdir(dirname(dest));
    symlink(src, dest);
    return 'linked';
  }
  if (!existing.isSymbolicLink()) {
    throw managedLinkConflict(`refusing to replace a non-symlink at ${dest}`, { dest, found: 'file' });
  }
  const target = readlink(dest);
  const resolvedTarget = isAbsolute(target) ? target : resolve(dirname(dest), target);
  if (resolvedTarget === resolve(src)) return 'noop';
  throw managedLinkConflict(
    `refusing to replace a foreign symlink at ${dest} (points at ${target}, not our ${src})`,
    { dest, expected: src, found: target },
  );
};

// Recursively remove a managed dir/file — the inverse of copyTreeRefresh. `assertContainedRealPath`
// guards `target` first: it refuses a `target` outside `root`, and refuses when `root`, any
// intermediate component, OR `target` itself is a symlink — so we never delete *through* or *at* a
// symlink (a symlinked skill dir is a STOP, not a follow-and-delete). A recursive `rm` does NOT
// follow symlinks *inside* the tree (Node unlinks a symlink entry rather than recursing into its
// target), so an internal symlink is removed safely without touching what it points at. Outcomes:
// 'removed', or 'noop' when the target is already absent. Dependency-injected (lstat / rm).
export const removeTreeManaged = (target, root, deps = {}) => {
  const lstat = deps.lstat ?? lstatSync;
  const rm = deps.rm ?? ((p) => rmSync(p, { recursive: true, force: true }));
  assertContainedRealPath(root, target, deps);
  if (lstatNoFollow(target, lstat) === null) return 'noop';
  rm(target);
  return 'removed';
};

// Remove ONLY a symlink we own — the inverse of linkManaged. Guards the PARENT chain (root +
// intermediate dirs) the same way linkManaged does (the leaf IS the managed symlink, so it is
// inspected, not traversal-rejected). Outcomes: 'unlinked' (a symlink whose resolved target is our
// `expectedSrc` — including a dangling-but-ours link), 'noop' (dest absent), or a thrown
// ManagedLinkConflict (a non-symlink, or a symlink pointing elsewhere — never removed).
export const unlinkManaged = (dest, expectedSrc, root, deps = {}) => {
  const lstat = deps.lstat ?? lstatSync;
  const readlink = deps.readlink ?? readlinkSync;
  const unlink = deps.unlink ?? unlinkSync;

  assertContainedRealPath(root, dirname(dest), deps);
  const existing = lstatNoFollow(dest, lstat);
  if (existing === null) return 'noop';
  if (!existing.isSymbolicLink()) {
    throw managedLinkConflict(`refusing to remove a non-symlink at ${dest}`, { dest, found: 'file' });
  }
  const target = readlink(dest);
  const resolvedTarget = isAbsolute(target) ? target : resolve(dirname(dest), target);
  if (resolvedTarget !== resolve(expectedSrc)) {
    throw managedLinkConflict(
      `refusing to remove a foreign symlink at ${dest} (points at ${target}, not our ${expectedSrc})`,
      { dest, expected: expectedSrc, found: target },
    );
  }
  unlink(dest);
  return 'unlinked';
};
