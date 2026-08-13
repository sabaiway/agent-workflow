// atomic-write.mjs — the family's ONE hardened atomic-write core for kit writers. Extracted from
// orchestration-write.mjs (the only full implementation of the discipline, AD-042) and parameterized
// by (containment ROOT, absolute target, body, stop identity) so every consumer runs the same guarded
// flow with zero drift:
//   • writeDocsAiFileAtomic  — a file under a project's docs/ai/ (deployment-gated to cwd):
//       orchestration-write.mjs → docs/ai/orchestration.json; gates-init.mjs → docs/ai/gates.json.
//   • writeHostConfigFileAtomic — a file under a host config dir OUTSIDE any project tree
//       (bridges 2.3.0, D6): ${XDG_CONFIG_HOME:-~/.config}/agent-workflow/bridge-settings.conf. The
//       host dir is CREATED if absent (a host config SHOULD materialize), unlike the docs/ai gate
//       which REFUSES an absent deployment.
//   • writeProjectFileCreateOnly — a SEED under a project subdirectory (the ensure CLI's enforcement
//       scripts): the parent dir is created + verified, and the write is create-only.
//
// The discipline (verbatim from the source implementation) — writeContainedFileAtomic(root, dst, …):
//   - a per-consumer GATE runs first (deployment gate for docs/ai; create+verify for the host dir).
//   - refuse a SYMLINKED leaf — a rename would silently replace the link target.
//   - guard the dst + the tmp sibling with assertContainedRealPath (fs-safe) — refuses a symlinked
//     PARENT component inside `root`, not just the leaf, and refuses any escape outside `root`.
//   - atomic: write a UNIQUE *.<rand>.tmp opened EXCLUSIVE-CREATE (wx), then rename over the dst.
//   - RE-CHECK the parent chain + the leaf immediately before the rename (TOCTOU).
//   - tmp cleaned up on any failure after its creation.
//   - LAST-WRITER-WINS: local, single-user; no cross-process lock (documented, not silently assumed).
//
// `opts.createOnly` swaps the LAST step only: `link(tmp, dst)` instead of `rename(tmp, dst)`. A rename
// replaces whatever is there — correct for a refresh, wrong for a SEED, where a file that appeared
// between the probe and the write must survive. link() is the primitive that both keeps the content
// atomic and fails EEXIST instead of clobbering; the caller learns which happened from `created`,
// never from a second probe (which would be the same race again). A filesystem that cannot hard-link
// surfaces its own error — there is no silent fallback to a clobbering write.
//
// Dependency-free, Node >= 22. Every fs primitive is injectable (deps.*) so the guards are
// unit-testable. NEVER imported by a read-only module (procedures.mjs — pinned by an import guard).

import { lstatSync, writeFileSync, renameSync, linkSync, rmSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { assertContainedRealPath } from './fs-safe.mjs';

export const ATOMIC_WRITE_STOP = 'ATOMIC_WRITE_STOP';
const defaultStop = (message) =>
  Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'AtomicWriteStop', code: ATOMIC_WRITE_STOP });

// lstat without following symlinks; null when absent. A non-ENOENT error propagates (never fail open).
export const lstatNoFollow = (path, lstat = lstatSync) => {
  try {
    return lstat(path);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
};

// Deployment gate — never scatter a file into a non-deployed repo. lstat, NOT existsSync:
// existsSync FOLLOWS a symlink, so a DANGLING `docs/ai` symlink would read as "absent" and
// mislabel a broken/symlinked deployment as "no deployment". lstat the leaf instead: a true
// ENOENT → no deployment (STOP, run init); a symlink or non-directory → STOP loud.
// `noun` names what the caller writes ("a config" / "a gate declaration") so each consumer's STOP
// message stays exactly as its own tests pinned it.
export const assertDocsAiDeployment = (cwd, deps = {}, opts = {}) => {
  const lstat = deps.lstat ?? lstatSync;
  const stop = opts.stop ?? defaultStop;
  const noun = opts.noun ?? 'a file';
  const rel = opts.rel ?? 'under docs/ai';
  const docsAi = join(cwd, 'docs', 'ai');
  // Parent-chain preflight (AD-052, Issue-011 residual 3): refuse a symlinked cwd ROOT or a
  // symlinked `docs` PARENT before any read — the walk the write path already enforces
  // (writeContainedFileAtomic), aligned onto the gate every consumer runs first. The walk covers
  // the PARENT chain only (the linkManaged precedent, fs-safe.mjs): the docs/ai LEAF keeps the
  // dedicated checks below, whose exact STOP messages each consumer's tests pin. ENOENT-safe —
  // an absent component is a no-op walk, so a brand-new project still reaches the normal
  // "no deployment" STOP below. The walk throws a plain Error; re-throw as the CALLER's typed
  // stop so every consumer's `.code` contract holds.
  try {
    assertContainedRealPath(cwd, join(cwd, 'docs'), { lstat });
  } catch (err) {
    throw stop(String(err?.message ?? err).replace(/^\[agent-workflow-kit\] /, ''));
  }
  const docsAiStat = lstatNoFollow(docsAi, lstat);
  if (docsAiStat === null) {
    throw stop(`no agent-workflow deployment here (docs/ai is absent) — run init/bootstrap before writing ${rel}`);
  }
  if (docsAiStat.isSymbolicLink()) {
    throw stop(`docs/ai is a symlink — refusing to write ${noun} through it (run init/bootstrap in a real deployment)`);
  }
  if (!docsAiStat.isDirectory()) {
    throw stop(`docs/ai exists but is not a directory — refusing to write ${rel}`);
  }
};

// Creatable-dir gate — CREATE the dir if absent (a host config / a project's scripts dir SHOULD
// materialize on first write, the opposite of the docs/ai deployment gate), then refuse a symlinked /
// non-directory dir we would write THROUGH (a rename into a symlinked dir would land outside where the
// user thinks). `noun` names what the caller writes so each consumer's STOP message stays exactly as
// its own tests pinned it.
export const assertCreatableDirSafe = (dir, deps = {}, opts = {}) => {
  const lstat = deps.lstat ?? lstatSync;
  const mkdir = deps.mkdir ?? ((p) => mkdirSync(p, { recursive: true }));
  const stop = opts.stop ?? defaultStop;
  const noun = opts.noun ?? 'a host config file';
  mkdir(dir);
  const st = lstatNoFollow(dir, lstat);
  if (st === null) throw stop(`could not create the host config dir: ${dir}`);
  if (st.isSymbolicLink()) throw stop(`${dir} is a symlink — refusing to write ${noun} through it`);
  if (!st.isDirectory()) throw stop(`${dir} exists but is not a directory — refusing to write ${noun}`);
};

// The hardened atomic flow, parameterized by containment ROOT + an already-passed gate. `dst` is the
// ABSOLUTE target under `root`; `opts.label` names it in a symlink-refusal message; `opts.createOnly`
// makes the last step a no-clobber link (above). Returns { writtenPath: dst, created, tmpLeftBehind }
// — `created` is false ONLY under createOnly, when a regular file already stood there, and
// `tmpLeftBehind` names the temp file when the post-publication cleanup failed (the write STANDS;
// the leftover is reported, never swallowed). THROWS the caller's typed STOP (opts.stop) or a native
// fs error.
export const writeContainedFileAtomic = (root, dst, body, deps = {}, opts = {}) => {
  const lstat = deps.lstat ?? lstatSync;
  const writeFile = deps.writeFile ?? writeFileSync;
  const rename = deps.rename ?? renameSync;
  const link = deps.link ?? linkSync;
  const rm = deps.rm ?? ((p) => rmSync(p, { force: true }));
  const rand = deps.rand ?? (() => randomBytes(6).toString('hex'));
  const stop = opts.stop ?? defaultStop;
  const label = opts.label ?? dst;
  const guard = (target) => assertContainedRealPath(root, target, { lstat });

  // Refuse a symlinked leaf with a CLEAR message before the generic traversal guard fires (a rename
  // would silently replace the link rather than the file the user thinks they are editing).
  const leaf = lstatNoFollow(dst, lstat);
  if (leaf && leaf.isSymbolicLink()) {
    throw stop(`${label} is a symlink — refusing to replace it (a write would clobber the link target)`);
  }
  // Guard the dst + a unique tmp SIBLING: refuses a symlinked parent component inside root, and any escape.
  guard(dst);
  const tmp = `${dst}.${rand()}.tmp`;
  guard(tmp);

  // Exclusive-create (wx): never clobber a leftover tmp (a stray collision is surfaced, not silently
  // overwritten). The random suffix makes a collision effectively impossible; wx makes it impossible-loud.
  writeFile(tmp, body, { encoding: 'utf8', flag: 'wx' });
  let created = true;
  let tmpLeftBehind = null;
  try {
    // TOCTOU re-check: the parent chain + the leaf may have changed since the pre-checks above.
    guard(dst);
    const leafAgain = lstatNoFollow(dst, lstat);
    if (leafAgain && leafAgain.isSymbolicLink()) {
      throw stop(`${label} became a symlink — refusing to replace it`);
    }
    if (opts.createOnly) {
      try {
        link(tmp, dst);
      } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err;
        // EEXIST is not proof that a REGULAR FILE stands there. Re-check no-follow: a symlink that
        // appeared inside the race window meets the same refusal as one that was there all along, a
        // non-file is refused rather than reported as a preserved seed, and a dst that is already
        // gone again is a loud conflict — never a silent "it was already there".
        const raced = lstatNoFollow(dst, lstat);
        if (raced === null) throw stop(`${label} could not be created, and nothing is there now — something is creating and removing it underneath this write; re-run when the tree is settled`);
        if (raced.isSymbolicLink()) throw stop(`${label} became a symlink — refusing to seed through it`);
        if (!raced.isFile()) throw stop(`${label} exists but is not a regular file — refusing to seed through it`);
        created = false; // it appeared under us — the existing file stands, byte-for-byte
      }
      // The publication is DONE (or the dst already stood): dropping our tmp name may not turn a
      // completed write into a failure. A cleanup that fails is reported instead — never swallowed.
      try {
        rm(tmp);
      } catch {
        tmpLeftBehind = tmp;
      }
    } else {
      rename(tmp, dst);
    }
  } catch (err) {
    rm(tmp); // never leave a temp file behind on failure
    throw err;
  }
  return { writtenPath: dst, created, tmpLeftBehind };
};

// writeDocsAiFileAtomic(cwd, rel, body, deps, opts) → { writtenPath: rel, created } on success;
// THROWS the caller's typed STOP (via opts.stop) or a native fs error otherwise. `body` arrives
// pre-serialized (each consumer owns its canonical serialization). Thin wrapper over the core: gate =
// deployment gate, root = cwd, target = cwd/rel; the label + return stay `rel` so its public API is
// unchanged (`created` is additive — always true unless the caller asked for createOnly).
export const writeDocsAiFileAtomic = (cwd, rel, body, deps = {}, opts = {}) => {
  assertDocsAiDeployment(cwd, deps, { ...opts, rel });
  const dst = join(cwd, rel);
  const { created, tmpLeftBehind } = writeContainedFileAtomic(cwd, dst, body, deps, { ...opts, label: rel });
  return { writtenPath: rel, created, tmpLeftBehind };
};

// writeHostConfigFileAtomic(dir, filename, body, deps, opts) → { writtenPath: dir/filename }. Gate =
// create+verify the host dir; root = that dir; target = dir/filename. For the out-of-tree host config
// surface (bridge-settings.conf) that no project deployment owns.
export const writeHostConfigFileAtomic = (dir, filename, body, deps = {}, opts = {}) => {
  assertCreatableDirSafe(dir, deps, opts);
  const dst = join(dir, filename);
  return writeContainedFileAtomic(dir, dst, body, deps, { ...opts, label: opts.label ?? dst });
};

// writeProjectFileCreateOnly(root, rel, body, deps, opts) → { writtenPath: rel, created }. Gate =
// create+verify the target's PARENT dir inside the project (a symlinked `scripts/` is a STOP, not a
// write through it); root = the project dir; the write is create-only, so an existing file is left
// exactly as it is and `created` says so.
export const writeProjectFileCreateOnly = (root, rel, body, deps = {}, opts = {}) => {
  const dst = join(root, rel);
  assertCreatableDirSafe(dirname(dst), deps, opts);
  const { created, tmpLeftBehind } = writeContainedFileAtomic(root, dst, body, deps, { ...opts, createOnly: true, label: rel });
  return { writtenPath: rel, created, tmpLeftBehind };
};
