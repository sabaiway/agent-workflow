// atomic-write.mjs — the family's ONE hardened atomic-write core for kit writers that target a
// file under a project's docs/ai/. Extracted from orchestration-write.mjs (the only full
// implementation of the discipline, AD-042) and parameterized by (rel, body, stop identity) so
// BOTH consumers run the same guarded flow with zero drift:
//   • orchestration-write.mjs — docs/ai/orchestration.json (public API unchanged);
//   • seed-gates.mjs          — docs/ai/gates.json (the consent-gated seeder).
//
// The discipline (verbatim from the source implementation):
//   - DEPLOYMENT GATE first: refuse to scatter a file into a repo with no docs/ai/ — STOP loud.
//   - refuse a SYMLINKED leaf — a rename would silently replace the link target.
//   - guard the dst + the tmp sibling with assertContainedRealPath (fs-safe) — refuses a symlinked
//     docs/ or docs/ai/ PARENT, not just the leaf, and refuses any escape outside cwd.
//   - atomic: write a UNIQUE *.<rand>.tmp opened EXCLUSIVE-CREATE (wx), then rename over the dst.
//   - RE-CHECK the parent chain + the leaf immediately before the rename (TOCTOU).
//   - tmp cleaned up on any failure after its creation.
//   - LAST-WRITER-WINS: local, single-user; no cross-process lock (documented, not silently assumed).
//
// Dependency-free, Node >= 18. Every fs primitive is injectable (deps.*) so the guards are
// unit-testable. NEVER imported by a read-only module (procedures.mjs — pinned by an import guard).

import { lstatSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
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

// writeDocsAiFileAtomic(cwd, rel, body, deps, opts) → { writtenPath: rel } on success; THROWS the
// caller's typed STOP (via opts.stop) or a native fs error otherwise. `body` arrives pre-serialized
// (each consumer owns its canonical serialization).
export const writeDocsAiFileAtomic = (cwd, rel, body, deps = {}, opts = {}) => {
  const lstat = deps.lstat ?? lstatSync;
  const writeFile = deps.writeFile ?? writeFileSync;
  const rename = deps.rename ?? renameSync;
  const rm = deps.rm ?? ((p) => rmSync(p, { force: true }));
  const rand = deps.rand ?? (() => randomBytes(6).toString('hex'));
  const stop = opts.stop ?? defaultStop;
  const guard = (target) => assertContainedRealPath(cwd, target, { lstat });

  assertDocsAiDeployment(cwd, deps, { ...opts, rel });

  const dst = join(cwd, rel);
  // Refuse a symlinked leaf with a CLEAR message before the generic traversal guard fires (a rename
  // would silently replace the link rather than the file the user thinks they are editing).
  const leaf = lstatNoFollow(dst, lstat);
  if (leaf && leaf.isSymbolicLink()) {
    throw stop(`${rel} is a symlink — refusing to replace it (a write would clobber the link target)`);
  }
  // Guard the dst + a unique tmp SIBLING: refuses a symlinked docs/ or docs/ai/ parent, and any escape.
  guard(dst);
  const tmp = `${dst}.${rand()}.tmp`;
  guard(tmp);

  // Exclusive-create (wx): never clobber a leftover tmp (a stray collision is surfaced, not silently
  // overwritten). The random suffix makes a collision effectively impossible; wx makes it impossible-loud.
  writeFile(tmp, body, { encoding: 'utf8', flag: 'wx' });
  try {
    // TOCTOU re-check: the parent chain + the leaf may have changed since the pre-checks above.
    guard(dst);
    const leafAgain = lstatNoFollow(dst, lstat);
    if (leafAgain && leafAgain.isSymbolicLink()) {
      throw stop(`${rel} became a symlink — refusing to replace it`);
    }
    rename(tmp, dst);
  } catch (err) {
    rm(tmp); // never leave a temp file behind on failure
    throw err;
  }
  return { writtenPath: rel };
};
