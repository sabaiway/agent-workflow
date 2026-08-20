// flow-store-read.mjs — the read half of the flow store (flow-orchestration, Plan 3 Phase 3):
// common-dir path resolution, the fail-closed reader, the race-free no-follow file read, and the
// canonical owning-worktree identity. This module OWNS no write API: the append surface and the
// lock/CAS discipline live in flow-append.mjs; flow-store.mjs re-exports the EIGHT store-surface
// names below (never everything here), and the procedures advisor imports ONLY this module.
// The no-follow read primitive lives in the fs-read-nofollow.mjs LEAF (re-exported here under the
// same idiom); the transitive read graph is pinned write-module-free and acyclic by
// test/read-graph-purity.test.mjs (FLOW-READ-GRAPH-PURITY).
//
// No CLI, no side effects on import, no fs WRITES of any kind. Dependency-free, Node >= 22.

import { join, isAbsolute, normalize, basename, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateFlowRecord, authoritativeFlowRecords } from './flow-record.mjs';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';

export { lstatNoFollowRead, describeNonRegular, readRegularFileNoFollow, readFileBytesNoFollow } from './fs-read-nofollow.mjs';

export const FLOW_STORE_STOP = 'FLOW_STORE_STOP';
// The ONE typed-STOP factory for the store's read AND write halves (the write leaves import it).
export const flowStoreStop = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'FlowStoreStop', code: FLOW_STORE_STOP });

export const FLOW_STORE_BASENAME = 'agent-workflow-flow.jsonl';
export const FLOW_LOCK_SUFFIX = '.lock';

const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const gitBuf = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
};
export const gitLine = (args, cwd) => {
  const buf = gitBuf(args, cwd);
  return buf == null ? null : buf.toString('utf8').replace(/\r?\n$/, '');
};

// ── path resolution (common dir + the AW_FLOW_STORE producer seam) ────────────────────────────────

// resolveFlowStorePath(cwd, env) → the ABSOLUTE store path, or null outside a git WORK tree.
// is-inside-work-tree gates explicitly (--git-common-dir also succeeds in a bare repo, and the
// probe prints "false" WITH exit 0, so the STRING is compared). AW_FLOW_STORE must be absolute —
// a relative override would resolve a different store from each cwd.
export const resolveFlowStorePath = (cwd, env = process.env) => {
  if (env.AW_FLOW_STORE) {
    if (!isAbsolute(env.AW_FLOW_STORE)) {
      throw flowStoreStop(`AW_FLOW_STORE must be an ABSOLUTE path (got "${env.AW_FLOW_STORE}") — a relative override resolves a different store from each worktree/cwd (fail closed)`);
    }
    const normalized = normalize(env.AW_FLOW_STORE);
    // A trailing separator survives normalize() but not the appender's basename/join — refuse the fork.
    if (normalized.endsWith(sep) || normalized.endsWith('/')) {
      throw flowStoreStop(`AW_FLOW_STORE must not end with a path separator (got "${env.AW_FLOW_STORE}") — a store is a file, not a directory (fail closed)`);
    }
    return normalized;
  }
  if (gitLine(['rev-parse', '--is-inside-work-tree'], cwd) !== 'true') return null;
  const commonDir = gitLine(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return commonDir == null ? null : join(commonDir, FLOW_STORE_BASENAME);
};

// The lock is a SIBLING derived from the resolved store path — one store, one lock, everywhere.
export const resolveFlowLockPath = (storePath) => `${storePath}${FLOW_LOCK_SUFFIX}`;

// ── the canonical owning-worktree identity (#49) ──────────────────────────────────────────────────

// STABLE and git-derived, never caller-supplied and never the raw path: the main tree is "main"
// (a repo-root relocation keeps it); a linked worktree is "worktree:<admin-dir name>" — the
// <common>/worktrees/<name> admin dir survives both a path-alias invocation (git canonicalizes)
// and `git worktree move` (the admin dir is not renamed), so relocation cannot silently turn an
// own open chain into foreign advisory. Null outside a git work tree.
export const deriveFlowOwner = (cwd) => {
  if (gitLine(['rev-parse', '--is-inside-work-tree'], cwd) !== 'true') return null;
  const gitDir = gitLine(['rev-parse', '--path-format=absolute', '--git-dir'], cwd);
  const commonDir = gitLine(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (gitDir == null || commonDir == null) return null;
  return gitDir === commonDir ? 'main' : `worktree:${basename(gitDir)}`;
};

// ── the fail-closed reader ────────────────────────────────────────────────────────────────────────

// parseFlowStoreText(raw) → { records, authoritative, malformed, malformedReasons }. Both views on
// every result: `records` is RAW file order (the only view ordering checks may consume, #65),
// `authoritative` is the latest-per-key selection (#22).
export const parseFlowStoreText = (raw) => {
  const records = [];
  const malformedReasons = [];
  const lines = String(raw).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      malformedReasons.push(`line ${i + 1}: invalid JSON`);
      continue;
    }
    const v = validateFlowRecord(parsed);
    if (v.ok) records.push(parsed);
    else malformedReasons.push(`line ${i + 1}: ${v.reason}`);
  }
  return { records, authoritative: authoritativeFlowRecords(records), malformed: malformedReasons.length, malformedReasons };
};

// readFlowStore(path, io?) → { records, authoritative, malformed, malformedReasons, readError? }.
// Absent → empty (no records yet is not an error); any other failure → readError, and consumers
// fail closed on malformed > 0 or readError. A dangling symlink must NOT read as an empty store —
// that would be a fail-open for the checker.
export const readFlowStore = (path, io = {}) => {
  const empty = () => ({ records: [], authoritative: [], malformed: 0, malformedReasons: [] });
  const read = readRegularFileNoFollow(path, io);
  if (read.outcome === 'absent') return empty();
  if (read.outcome === 'foreign') return { ...empty(), readError: `the store is a ${read.className}, not a regular file — refusing to read it (fail closed)` };
  if (read.outcome === 'error') return { ...empty(), readError: read.code };
  return parseFlowStoreText(read.content);
};
