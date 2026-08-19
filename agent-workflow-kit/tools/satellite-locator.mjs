// satellite-locator.mjs — slug → satellite worktree, and the proof that the handoff found there IS
// that satellite's identity (delegation Plan 3, Phase 2).
//
// Extracted out of worktrees.mjs so BOTH modes can ask the question: `worktrees prompt` composes a
// satellite's cold-start prompt today, and the dispatch-side handoff-return rung — a later phase,
// not yet wired — will read what came back through this same leaf. That rung is a `dispatch` verb,
// so this leaf is what will keep the 3200-line worktrees tool out of the dispatch CLI's closure.
//
// READ-ONLY by construction: it writes nothing, spawns nothing, and — deliberately — CONTENT-READS
// nothing of its own. The git runner and the fs seams are INJECTED, so a caller decides what may
// run, and the content read arrives as `fs.readFileNoFollow(abs)` returning the family's structured
// outcome { bytes } | { absent } | { unsafe } | { error: code }. That is not fastidiousness: the ONE
// no-follow read door lives in worktrees.mjs, its single body is pinned there by a tripwire, and a
// second body here would be exactly the duplication that pin exists to prevent. `fs` is the shape
// worktrees.mjs builds: { lstat, readdir, realpath, readFileNoFollow }.
//
// Node built-ins plus two pure leaves. No side effects on import; no CLI. Dependency-free, Node >= 22.

import { join } from 'node:path';
import { PLANS_REL } from './plan-files.mjs';
import { stop, handoffBasename, parseProvisionRecord, displayValue } from './worktrees-record.mjs';

// Every refusal below is the worktrees STOP, unchanged — a caller that reached this leaf directly
// (the dispatch side does) must be able to recognize it without importing worktrees.mjs.
export { WORKTREES_STOP } from './worktrees-record.mjs';

export const DEFAULT_BRANCH_PREFIX = 'aw/';

export const parseWorktreeList = (text) => {
  const entries = [];
  let fields = [];
  const finishEntry = () => {
    if (fields.length === 0) return;
    const entry = { path: null, head: null, branch: null, detached: false, prunable: false, bare: false };
    for (const field of fields) {
      if (field.startsWith('worktree ')) entry.path = field.slice('worktree '.length);
      else if (field.startsWith('HEAD ')) entry.head = field.slice('HEAD '.length);
      else if (field.startsWith('branch ')) entry.branch = field.slice('branch '.length);
      else if (field === 'detached') entry.detached = true;
      else if (field === 'bare') entry.bare = true;
      else if (field === 'prunable' || field.startsWith('prunable ')) entry.prunable = true;
    }
    if (entry.path !== null) entries.push(entry);
    fields = [];
  };
  for (const field of String(text).split('\0')) {
    if (field === '') finishEntry();
    else fields.push(field);
  }
  finishEntry();
  return entries;
};

export const listWorktrees = (git, cwd) => {
  const r = git(['worktree', 'list', '--porcelain', '-z'], cwd);
  if (r.status !== 0) throw stop(`git worktree list failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return parseWorktreeList(r.stdout);
};

export const classifyNodeNoFollow = (path, fs) => {
  const node = (() => {
    try {
      return { stat: fs.lstat(path) };
    } catch (error) {
      return error?.code === 'ENOENT'
        ? { stat: null }
        : { error: error?.code ?? 'fs error' };
    }
  })();
  if (node.error) return { kind: 'error', error: node.error };
  if (node.stat === null) return { kind: 'absent' };
  if (!node.stat.isSymbolicLink()) {
    if (node.stat.isDirectory()) return { kind: 'plain-directory', stat: node.stat };
    if (node.stat.isFile()) return { kind: 'regular-file', stat: node.stat };
    return { kind: 'special', stat: node.stat };
  }
  const realPath = (() => {
    try {
      return { path: fs.realpath(path) };
    } catch (error) {
      return { error: error?.code ?? 'fs error' };
    }
  })();
  if (realPath.error) return { kind: 'symlink-unresolvable', error: realPath.error };
  const target = (() => {
    try {
      return { stat: fs.lstat(realPath.path) };
    } catch (error) {
      return { error: error?.code ?? 'fs error' };
    }
  })();
  if (target.error) return { kind: 'symlink-unresolvable', error: target.error };
  if (target.stat.isDirectory()) return { kind: 'symlink-to-directory', realPath: realPath.path, stat: node.stat };
  if (target.stat.isFile()) return { kind: 'symlink-to-file', realPath: realPath.path, stat: node.stat };
  return { kind: 'symlink-to-special', realPath: realPath.path, stat: node.stat };
};

// Whole-chain no-follow: the worktree root, docs, and docs/plans must be plain directories;
// handoff candidates count ONLY as regular files. states: ok | absent | unreadable.
// ANY stat failure (not just readdir) renders honestly — list must never crash on a bad node.
export const scanPlansDir = ({ wtRoot, fs }) => {
  if (classifyNodeNoFollow(wtRoot, fs).kind !== 'plain-directory') return { state: 'unreadable' };
  const docs = classifyNodeNoFollow(join(wtRoot, 'docs'), fs);
  if (docs.kind === 'absent') return { state: 'absent' };
  if (docs.kind !== 'plain-directory') return { state: 'unreadable' };
  const plans = classifyNodeNoFollow(join(wtRoot, PLANS_REL), fs);
  if (plans.kind === 'absent') return { state: 'absent' };
  if (plans.kind !== 'plain-directory') return { state: 'unreadable' };
  let names;
  try {
    names = fs.readdir(join(wtRoot, PLANS_REL));
  } catch {
    return { state: 'unreadable' };
  }
  const handoffs = [];
  const nonRegular = [];
  for (const n of names) {
    if (!/^handoff-.+\.md$/.test(n)) continue;
    const cand = classifyNodeNoFollow(join(wtRoot, PLANS_REL, n), fs);
    if (cand.kind !== 'regular-file') nonRegular.push(n);
    else handoffs.push(n);
  }
  return { state: 'ok', handoffs, nonRegular };
};

export const branchNameOf = (entry) => entry.branch?.replace(/^refs\/heads\//, '') ?? null;

export const findSatelliteEntry = ({ root, slug, branch, git, fs }) => {
  const entries = listWorktrees(git, root).slice(1);
  const exactHandoff = [];
  for (const entry of entries) {
    if (entry.prunable) continue;
    const scan = scanPlansDir({ wtRoot: entry.path, fs });
    if (scan.state === 'ok' && scan.handoffs.includes(handoffBasename(slug))) exactHandoff.push(entry);
  }
  if (exactHandoff.length > 1) {
    throw stop(`multiple worktrees carry ${handoffBasename(slug)} — cleanup the duplicate identity before continuing`);
  }
  if (branch !== null) {
    const byBranch = entries.filter((entry) => entry.branch === `refs/heads/${branch}`);
    if (byBranch.length > 1) throw stop(`multiple worktrees claim branch ${branch}`);
    if (byBranch.length === 1) return byBranch[0];
  }
  if (exactHandoff.length === 1) return exactHandoff[0];
  const fallback = entries.filter((entry) => entry.branch === `refs/heads/${DEFAULT_BRANCH_PREFIX}${slug}`);
  if (fallback.length === 1) return fallback[0];
  throw stop(`no registered satellite worktree for ${slug}`);
};

export const readSatelliteIdentity = ({ entry, slug, expectedBranch, fs, abandon = false }) => {
  const name = handoffBasename(slug);
  const scan = scanPlansDir({ wtRoot: entry.path, fs });
  if (scan.state === 'ok' && scan.nonRegular.includes(name)) {
    throw stop(`handoff identity mismatch: ${name} is not a regular file`);
  }
  if (scan.state !== 'ok' || !scan.handoffs.includes(name)) {
    if (abandon) throw stop(`${name} is absent — force deletion is forbidden without the handoff identity`);
    throw stop(`handoff identity mismatch: expected ${name} in the satellite`);
  }
  // Every value below reaches a terminal, and every one of them is foreign: the names come from a
  // directory listing, the record fields from a hand-editable file. They render ESCAPED — the guard
  // that refuses them for the prompt must not be undone by the message that reports them.
  if (scan.handoffs.length !== 1) {
    throw stop(`handoff identity mismatch: expected exactly ${name}, found [${scan.handoffs.map(displayValue).join(', ')}]`);
  }
  const leaf = fs.readFileNoFollow(join(entry.path, PLANS_REL, name));
  if (!leaf.bytes) throw stop(`handoff identity mismatch: ${name} is not readable as a regular file`);
  const record = parseProvisionRecord(String(leaf.bytes));
  const liveBranch = branchNameOf(entry);
  const wantedBranch = expectedBranch ?? liveBranch;
  if (record.slug !== slug || record.branch !== wantedBranch || liveBranch !== wantedBranch) {
    throw stop(
      `handoff identity mismatch: expected slug ${slug} and branch ${displayValue(wantedBranch)}; ` +
      `record has slug ${record.slug === null ? '(missing)' : displayValue(record.slug)} and branch ${record.branch === null ? '(missing)' : displayValue(record.branch)}, ` +
      `live branch ${liveBranch === null ? '(detached)' : displayValue(liveBranch)}`,
    );
  }
  return { record, path: join(entry.path, PLANS_REL, name), branch: wantedBranch };
};
