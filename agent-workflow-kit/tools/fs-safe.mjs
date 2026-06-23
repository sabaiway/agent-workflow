// fs-safe.mjs — pure, dependency-injectable filesystem-safety primitives shared by the kit installer
// (bin/install.mjs) and the backend linker (tools/setup-backends.mjs). Importing this module has NO
// side effects: it runs nothing. Every fs primitive is injectable via `deps.*` so the guards are
// unit-testable without touching the real filesystem; the defaults are Node's SYNC fs (matching the
// tools/ detector style). Dependency-free, Node >= 18.
//
// Three primitives:
//   assertContainedRealPath — refuse to write through/into a symlink, or to a dest outside a root.
//   copyTreeRefresh         — recursive copy that OVERWRITES regular files (refresh), SKIPS a symlink
//                             whose dest already exists (additive), and guards every dest component.
//   linkManaged             — create/keep ONLY a symlink we own; STOP (typed ManagedLinkConflict) on
//                             a foreign symlink or a non-symlink dest; refuse a symlinked source.

import {
  lstatSync, existsSync, mkdirSync, readdirSync, copyFileSync, readlinkSync, symlinkSync,
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
  if (rel.startsWith('..') || isAbsolute(rel)) {
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

  assertContainedRealPath(root, dest, deps);
  const stat = lstat(src);
  if (stat.isSymbolicLink()) {
    if (exists(dest)) return;
    symlink(readlink(src), dest);
  } else if (stat.isDirectory()) {
    mkdir(dest);
    for (const entry of readdir(src)) {
      copyTreeRefresh(join(src, entry), join(dest, entry), root, deps);
    }
  } else {
    mkdir(dirname(dest));
    copyFile(src, dest);
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
