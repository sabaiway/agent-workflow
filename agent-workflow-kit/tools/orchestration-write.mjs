#!/usr/bin/env node
// orchestration-write.mjs — the ONLY filesystem WRITER for docs/ai/orchestration.json. It is imported
// by the set-recipe writer alone; procedures.mjs never imports it, so "the read-only procedures advisor
// can never reach a writer" is a STRUCTURAL invariant (an import-split test pins it), not just an
// assertion. Splitting the writer out of the schema/read module keeps the read surface fs-write-free.
//
// writeConfig is hardened (mirrors the setup-backends posture):
//   - DEPLOYMENT GATE first: refuse to scatter a config into a repo with no docs/ai/ — STOP loud,
//     pointing at init/bootstrap (a config without a deployment is meaningless + surprising).
//   - refuse a SYMLINKED leaf (orchestration.json itself a symlink) — a rename would silently replace
//     the link target.
//   - guard the dst + the tmp sibling with assertContainedRealPath (fs-safe) — refuses a symlinked
//     docs/ or docs/ai/ PARENT, not just the leaf, and refuses any escape outside cwd.
//   - atomic: write a UNIQUE *.json.<rand>.tmp opened EXCLUSIVE-CREATE (wx), then rename over the dst.
//   - RE-CHECK the parent chain + the leaf immediately before the rename (TOCTOU).
//   - LAST-WRITER-WINS: local, single-user; no cross-process lock (documented, not silently assumed).
//
// Dependency-free, Node >= 18. Every fs primitive is injectable (deps.*) so the guards are unit-testable.

import { lstatSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { assertContainedRealPath } from './fs-safe.mjs';
import { CONFIG_REL, serializeConfig } from './orchestration-config.mjs';

// A typed STOP — a deliberate refusal we surface (deployment gate / symlinked leaf), distinct from a
// native fs error. `Object.assign(new Error(), { code })`, the codebase's typed-error idiom (no classes).
export const ORCH_WRITE_STOP = 'ORCH_WRITE_STOP';
const stop = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'OrchWriteStop', code: ORCH_WRITE_STOP });

// lstat without following symlinks; null when absent. A non-ENOENT error propagates (never fail open).
const lstatNoFollow = (path, lstat) => {
  try {
    return lstat(path);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
};

// writeConfig(cwd, config, deps) → { writtenPath } on success; THROWS a typed STOP (no deployment /
// symlinked leaf) or a native fs error otherwise. The tmp is cleaned up on any failure after its
// creation. config is serialized canonically (serializeConfig: 2-space, _README-first, trailing NL).
export const writeConfig = (cwd, config, deps = {}) => {
  const lstat = deps.lstat ?? lstatSync;
  const writeFile = deps.writeFile ?? writeFileSync;
  const rename = deps.rename ?? renameSync;
  const rm = deps.rm ?? ((p) => rmSync(p, { force: true }));
  const rand = deps.rand ?? (() => randomBytes(6).toString('hex'));
  const guard = (target) => assertContainedRealPath(cwd, target, { lstat });

  // Deployment gate — never scatter a config into a non-deployed repo (mirror velocity / setup). lstat,
  // NOT existsSync: existsSync FOLLOWS a symlink, so a DANGLING `docs/ai` symlink would read as "absent"
  // and mislabel a broken/symlinked deployment as "no deployment". lstat the leaf instead: a true ENOENT
  // → no deployment (STOP, run init); a symlink or non-directory → STOP loud (never write through it).
  const docsAi = join(cwd, 'docs', 'ai');
  const docsAiStat = lstatNoFollow(docsAi, lstat);
  if (docsAiStat === null) {
    throw stop(`no agent-workflow deployment here (docs/ai is absent) — run init/bootstrap before writing ${CONFIG_REL}`);
  }
  if (docsAiStat.isSymbolicLink()) {
    throw stop(`docs/ai is a symlink — refusing to write a config through it (run init/bootstrap in a real deployment)`);
  }
  if (!docsAiStat.isDirectory()) {
    throw stop(`docs/ai exists but is not a directory — refusing to write ${CONFIG_REL}`);
  }

  const dst = join(cwd, CONFIG_REL);
  // Refuse a symlinked leaf with a CLEAR message before the generic traversal guard fires (a rename
  // would silently replace the link rather than the file the user thinks they are editing).
  const leaf = lstatNoFollow(dst, lstat);
  if (leaf && leaf.isSymbolicLink()) {
    throw stop(`${CONFIG_REL} is a symlink — refusing to replace it (a write would clobber the link target)`);
  }
  // Guard the dst + a unique tmp SIBLING: refuses a symlinked docs/ or docs/ai/ parent, and any escape.
  guard(dst);
  const tmp = `${dst}.${rand()}.tmp`;
  guard(tmp);

  const body = serializeConfig(config);
  // Exclusive-create (wx): never clobber a leftover tmp (a stray collision is surfaced, not silently
  // overwritten). The random suffix makes a collision effectively impossible; wx makes it impossible-loud.
  writeFile(tmp, body, { encoding: 'utf8', flag: 'wx' });
  try {
    // TOCTOU re-check: the parent chain + the leaf may have changed since the pre-checks above.
    guard(dst);
    const leafAgain = lstatNoFollow(dst, lstat);
    if (leafAgain && leafAgain.isSymbolicLink()) {
      throw stop(`${CONFIG_REL} became a symlink — refusing to replace it`);
    }
    rename(tmp, dst);
  } catch (err) {
    rm(tmp); // never leave a temp file behind on failure
    throw err;
  }
  return { writtenPath: CONFIG_REL };
};
