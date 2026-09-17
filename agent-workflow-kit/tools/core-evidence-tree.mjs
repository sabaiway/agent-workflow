// core-evidence-tree.mjs — the git runners, the base, the tree fingerprint and the working state; the contract is the header of core-evidence.mjs.

import { readFileSync, lstatSync, readlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { GIT_MAX_BUFFER, resolveGitLocation, withGitPath } from './git-env.mjs';

const gitRaw = (args, cwd) => spawnSync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });

// Exported so a consumer computing over the SAME domain (the exec metric producer) reads git through
// this one runner instead of growing a second spawnSync wrapper with its own buffer bound.
export const gitBuf = (args, cwd) => {
  const r = gitRaw(args, cwd);
  if (r.error || r.status !== 0) return null;
  return r.stdout;
};

export const gitLine = (args, cwd) => {
  const buf = gitBuf(args, cwd);
  return buf == null ? null : buf.toString('utf8').replace(/\r?\n$/, '');
};

// resolveBase(cwd) → the current HEAD commit sha, or null on an unborn branch / outside a git tree.
export const resolveBase = (cwd) => gitLine(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd);

// First 8 KiB contain a NUL byte → binary (git's own heuristic; mirrors the wrappers' is_binary
// bash twin). An unreadable path reads as text (the fail-safe arm — the payload walk then surfaces
// its own read failure).
export const isBinaryFile = (path) => {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, 8192, 0);
    return buf.subarray(0, n).includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

// The never-committable untracked stat classes: character/block devices, FIFOs, sockets — excluded
// from the ENTIRE review domain (fingerprint payload, clean check); lstat-keyed because a lying
// dirent is exactly how sandbox masks surface.
export const isNeverCommittableStat = (stat) =>
  stat != null &&
  (stat.isCharacterDevice() || stat.isBlockDevice() || stat.isFIFO() || stat.isSocket());

// The git runner seam the tree computations share — (args, dir, input, env) — and its guard: a
// runner that THROWS answers as a failed spawn (measured: a raw stack out of a fingerprint).
const defaultRunGit = (args, dir, input, env) => spawnSync('git', args, { cwd: dir, input, env: withGitPath(env ?? process.env), maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
const guardedRunner = (runGit, env) => (args, dir, input, override) => {
  try { return runGit(args, dir, input, override ?? env); } catch (err) { return { error: err, status: null, signal: null, stdout: Buffer.alloc(0), stderr: '' }; }
};
const stdoutOf = (r) => (r.error || r.status !== 0 ? null : r.stdout);
// Only a work-tree location is computed over (git-env's table under the runner's own env) — a redirecting GIT_DIR never hashes another repository in silence.
const locateWorkTree = (cwd, run, env) => {
  const location = resolveGitLocation(cwd, { spawn: (cmd, args, opts) => run(args, opts.cwd, undefined, opts.env), env });
  return location.state === 'work-tree' ? location.top : null;
};

// The canonical payload bytes: staged diff + unstaged diff + the untracked-not-ignored section —
// byte-identical to the wrappers' emit_fingerprint_payload, emitted from the work-tree ROOT. Null on
// every location but a work tree. lstat is injectable ONLY for the never-committable filter tests.
export const FINGERPRINT_CACHED_DIFF_ARGV = Object.freeze(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none']);
export const FINGERPRINT_UNSTAGED_DIFF_ARGV = Object.freeze(['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none']);
export const computeFingerprintPayload = (cwd, { lstat = lstatSync, runGit = null, env = process.env } = {}) => {
  const run = guardedRunner(runGit ?? defaultRunGit, env);
  const top = locateWorkTree(cwd, run, env);
  if (top == null) return null;
  const buf = (args) => stdoutOf(run(args, top));
  const staged = buf(FINGERPRINT_CACHED_DIFF_ARGV);
  const unstaged = buf(FINGERPRINT_UNSTAGED_DIFF_ARGV);
  const untrackedZ = buf(['ls-files', '--others', '--exclude-standard', '-z']);
  if (staged == null || unstaged == null || untrackedZ == null) return null;
  const chunks = [staged, unstaged];
  for (const rel of untrackedZ.toString('utf8').split('\0').filter(Boolean)) {
    const full = join(top, rel);
    let stat = null;
    try {
      stat = lstat(full);
    } catch {
      stat = null;
    }
    if (isNeverCommittableStat(stat)) continue;
    if (stat?.isSymbolicLink()) {
      let target = '?';
      try {
        target = readlinkSync(full);
      } catch {
        target = '?';
      }
      chunks.push(Buffer.from(`untracked-symlink:${rel} -> ${target}\n`));
    } else if (!stat?.isFile()) {
      chunks.push(Buffer.from(`untracked-nonregular:${rel}\n`));
    } else if (isBinaryFile(full)) {
      chunks.push(Buffer.from(`untracked-binary:${rel}\n`));
    } else {
      chunks.push(Buffer.from(`untracked:${rel}\n`));
      chunks.push(readFileSync(full));
    }
  }
  return Buffer.concat(chunks);
};

// sha256 hex of the canonical payload, or null outside a git work tree.
export const computeTreeFingerprint = (cwd, fsx) => {
  const payload = computeFingerprintPayload(cwd, fsx);
  return payload == null ? null : createHash('sha256').update(payload).digest('hex');
};

// The fingerprint of a CONTENT-FREE payload — a clean work tree emits no bytes at all, so this ONE
// value is shared by every clean moment of every repository. It therefore identifies no working
// state and correlates to no base: evidence found at it was minted by some other clean moment,
// possibly at another base, and can decide nothing in either direction. Two situations reach it,
// and only the INDEX tells them apart (never the payload): an empty commit, where the index equals
// HEAD and no byte enters the repository, and staged content the payload cannot see — a gitlink
// hidden from `git diff` by an ignore configuration. Read by the consumers that correlate a
// fingerprint to a base (flow-check-rungs.mjs #65) and by commit-guard's two content-free lanes.
export const CONTENT_FREE_FINGERPRINT = createHash('sha256').update(Buffer.alloc(0)).digest('hex');

// The index↔worktree split the fingerprint deliberately CANNOT see: the payload above concatenates
// the staged and unstaged diffs, so against an otherwise-empty index a hunk moving into the index
// leaves it byte-identical — while `git commit` builds the commit from the INDEX alone. This is the
// ONE computation of that split; isTreeClean and the commit guard's index-lag arm both read it, so
// they can never disagree about what "the index carries the verified tree" means. Submodule paths
// are separated because a root-level `git add -A` cannot reach a submodule's own worktree, so they
// need their own recovery. Anchored at the work-tree ROOT (ls-files is cwd-scoped); null when not
// decidable — every consumer treats that as fail-closed, never as clean.
const LS_FILES_TAG_SKIP_WORKTREE = 'S';
const GITLINK_MODE = '160000';
const SYMLINK_MODE = '120000';
const EXECUTABLE_MODE = '100755';
const OWNER_EXECUTE_BIT = 0o100;
// `ls-files -v` lowercases the tag for assume-unchanged; skip-worktree is `S`, and an entry
// carrying BOTH bits prints lowercase `s` (live-pinned by test). The skip test is therefore
// case-INSENSITIVE — a case-sensitive one would lose skip-worktree on such an entry and turn a
// legitimate sparse checkout into an endless refusal.
const isAssumeUnchangedTag = (tag) => tag >= 'a' && tag <= 'z';
const isSkipWorktreeTag = (tag) => tag.toUpperCase() === LS_FILES_TAG_SKIP_WORKTREE;

// `git diff` SKIPS index entries carrying skip-worktree or assume-unchanged, so such a path can
// hold worktree bytes the gates read while `git commit` takes the stale INDEX blob — the same
// capture blindness one layer down, and invisible to the plain probe. Those entries are therefore
// compared DIRECTLY against the worktree. A MISSING skip-worktree path is an ordinary sparse
// checkout and never a lag; a missing assume-unchanged path is one. Gitlinks belong to the
// submodule lane. Any probe that cannot answer counts the path as lagging (fail-safe).
const flaggedIndexLag = (top, runGit, lstat, readlink) => {
  const buf = (args) => {
    const r = runGit(args, top);
    return r.error || r.status !== 0 ? null : r.stdout;
  };
  const splitZ = (b) => b.toString('utf8').split('\0').filter(Boolean);
  // Git emits raw path BYTES. Decoding to UTF-8 first turns a name carrying invalid bytes into a
  // DIFFERENT path, whose lstat then answers ENOENT — which for a skip-worktree entry reads as a
  // de-materialised sparse path and lets a stale index walk through. So each record keeps its
  // original slice and a name that does not survive a byte round-trip is lagging by construction.
  const splitZBytes = (b) => {
    const out = [];
    let start = 0;
    for (let i = 0; i < b.length; i += 1) {
      if (b[i] !== 0) continue;
      if (i > start) out.push(b.subarray(start, i));
      start = i + 1;
    }
    if (start < b.length) out.push(b.subarray(start));
    return out;
  };
  const decodesExactly = (slice) => Buffer.from(slice.toString('utf8'), 'utf8').equals(slice);
  const taggedZ = buf(['ls-files', '-v', '-z']);
  if (taggedZ == null) return null;
  // The two bits are INDEPENDENT — an entry can carry both (which is what lowercases the `S`), so
  // they travel as a pair and the recovery clears whichever are actually set.
  const flagged = splitZBytes(taggedZ)
    .map((record) => {
      const tag = record.subarray(0, 1).toString('utf8');
      const pathBytes = record.subarray(2);
      return {
        rel: pathBytes.toString('utf8'),
        pathBytes,
        exactName: decodesExactly(pathBytes),
        skipWorktree: isSkipWorktreeTag(tag),
        assumeUnchanged: isAssumeUnchangedTag(tag),
      };
    })
    .filter(({ skipWorktree, assumeUnchanged }) => skipWorktree || assumeUnchanged);
  if (flagged.length === 0) return { paths: [], submodules: [], flagged: [] };
  const stagedZ = buf(['ls-files', '-s', '-z']);
  if (stagedZ == null) return null;
  const entries = new Map();
  for (const line of splitZ(stagedZ)) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const [mode, oid] = line.slice(0, tab).split(' ');
    entries.set(line.slice(tab + 1), { mode, oid });
  }
  // `git diff` honours core.fileMode; mirroring it keeps a false-mode host (WSL, network mounts)
  // from reading every executable bit as a lag. Exit 1 is the only "unset" (git's default is true);
  // any other failure leaves the comparison undecidable rather than guessing.
  const boolConfig = (key) => {
    const r = runGit(['config', '--type=bool', '--get', key], top);
    if (r.error || (r.status !== 0 && r.status !== 1)) return null; // undecidable — never guessed
    return r.status === 1 || r.stdout.toString('utf8').trim() !== 'false'; // exit 1 = unset = git's default true
  };
  const honoursFileMode = boolConfig('core.fileMode');
  // On a host without symlink support git materialises a symlink as a REGULAR FILE holding the
  // target bytes; demanding a real link there would refuse forever.
  const materialisesSymlinks = boolConfig('core.symlinks');
  if (honoursFileMode === null || materialisesSymlinks === null) return null;
  const lagging = [];
  const laggingSubmodules = [];
  const laggingFlags = [];
  for (const { rel, pathBytes, exactName, skipWorktree, assumeUnchanged } of flagged) {
    const entry = entries.get(rel);
    if (entry === undefined) continue;
    const isGitlink = entry.mode === GITLINK_MODE;
    // Every path this loop reports needs its index bits cleared before ANY staging command can
    // pick it up — `git add -A` alone is a recovery that silently does nothing here.
    const lag = () => {
      (isGitlink ? laggingSubmodules : lagging).push(rel);
      laggingFlags.push({ rel, skipWorktree, assumeUnchanged, exactName });
    };
    // Probed by RAW BYTES, never by the decoded name: a lossy decode addresses a DIFFERENT path,
    // and answering ENOENT for it would either wave a stale index through or — worse — call a
    // legitimately absent sparse entry "lagging", whose prescribed bit-clear plus `git add -A`
    // would then stage its DELETION.
    const absPath = Buffer.concat([Buffer.from(top), Buffer.from(sep), pathBytes]);
    let stat = null;
    let absent = false;
    try {
      stat = lstat(absPath);
    } catch (err) {
      // ONLY a genuine absence is the sparse-checkout case; EACCES / EIO leave the path unproven,
      // and an unproven path can never be waved through as "not materialised".
      absent = err != null && err.code === 'ENOENT';
    }
    if (stat === null) {
      if (!absent || !skipWorktree) lag();
      continue;
    }
    if (!exactName) {
      // Materialised, but the name cannot be addressed through an argv string, so it can never be
      // PROVEN current — fail-safe. Absence was already decided above, on the real bytes.
      lag();
      continue;
    }
    // A flagged GITLINK is hidden from `git diff` too, so the submodule lane would never see it —
    // and it is deliberately NOT proven current here. Three consecutive review rounds each found a
    // new way for a nested probe to answer "clean" wrongly (inherited superproject GIT_*, status
    // config blindness, the submodule's OWN flagged entries, a symlink standing in for the
    // directory). The set was not shrinking, so the verdict is REDUCTION rather than another patch:
    // a materialised flagged gitlink LAGS by construction. It is a refusal, never an endless one —
    // the printed recovery (clear the bit, then git add -A) converges, and an UNflagged submodule
    // is unaffected because the ordinary --ignore-submodules=none probe still judges it.
    if (isGitlink) {
      lag();
      continue;
    }
    if (entry.mode === SYMLINK_MODE && !stat.isSymbolicLink() && !materialisesSymlinks) {
      // The placeholder file's RAW bytes are the stored target — no filters ever apply to a link.
      const placeholder = runGit(['hash-object', '--no-filters', '-t', 'blob', '--', join(top, rel)], top);
      if (placeholder.error || placeholder.status !== 0 || placeholder.stdout.toString('utf8').trim() !== entry.oid) lag();
      continue;
    }
    if (entry.mode === SYMLINK_MODE || stat.isSymbolicLink()) {
      if (entry.mode !== SYMLINK_MODE || !stat.isSymbolicLink()) {
        lag();
        continue;
      }
      let target = null;
      try {
        target = readlink(join(top, rel));
      } catch {
        target = null;
      }
      if (target === null) {
        lag(); // an unreadable link can never be proven current — fail-safe
        continue;
      }
      const hashed = runGit(['hash-object', '-t', 'blob', '--stdin'], top, target);
      if (hashed.error || hashed.status !== 0 || hashed.stdout.toString('utf8').trim() !== entry.oid) lag();
      continue;
    }
    if (!stat.isFile()) {
      lag();
      continue;
    }
    // Git canonicalises the executable mode on the OWNER bit alone — a file with only group/other
    // exec set is still `100644` to git, so testing 0o111 would call a stale index current.
    if (honoursFileMode && (entry.mode === EXECUTABLE_MODE) !== ((stat.mode & OWNER_EXECUTE_BIT) !== 0)) {
      lag();
      continue;
    }
    const hashed = runGit(['hash-object', '--path', rel, '--', join(top, rel)], top);
    if (hashed.error || hashed.status !== 0 || hashed.stdout.toString('utf8').trim() !== entry.oid) lag();
  }
  return { paths: lagging, submodules: laggingSubmodules, flagged: laggingFlags };
};

export const computeWorkingState = (cwd, { lstat = lstatSync, readlink = readlinkSync, runGit = null, env = process.env } = {}) => {
  const run = guardedRunner(runGit ?? defaultRunGit, env);
  const top = locateWorkTree(cwd, run, env);
  if (top == null) return null;
  // `--ignore-submodules=none` on the staged probe too: a config-hidden STAGED gitlink would
  // otherwise make stagedDirty false, and isTreeClean would call such a tree clean.
  const staged = run(['diff', '--cached', '--quiet', '--ignore-submodules=none'], top);
  // ONLY 0 or 1 is a usable answer: a signal-killed probe reports status null, which the old
  // `> 1` guard let through as "nothing staged" — a fail-OPEN the whole arm cannot afford.
  if (staged.error || (staged.status !== 0 && staged.status !== 1)) return null;
  const buf = (args) => stdoutOf(run(args, top));
  // The FULL probe forces submodules back in: diff.ignoreSubmodules / submodule.<n>.ignore would
  // otherwise erase a dirty submodule from the comparison entirely.
  const changedZ = buf(['diff', '--name-only', '-z', '--ignore-submodules=none']);
  const plainZ = buf(['diff', '--name-only', '-z', '--ignore-submodules=all']);
  const untrackedZ = buf(['ls-files', '--others', '--exclude-standard', '-z']);
  if (changedZ == null || plainZ == null || untrackedZ == null) return null;
  const split = (b) => b.toString('utf8').split('\0').filter(Boolean);
  const changed = [...new Set(split(changedZ))]; // an unmerged path is listed once per conflict side
  const plain = new Set(split(plainZ));
  const flagged = flaggedIndexLag(top, run, lstat, readlink);
  if (flagged == null) return null;
  const unstaged = changed.filter((rel) => plain.has(rel));
  const submodules = changed.filter((rel) => !plain.has(rel));
  return {
    stagedDirty: staged.status === 1,
    unstagedPaths: [...unstaged, ...flagged.paths.filter((rel) => !unstaged.includes(rel))],
    unstagedSubmodulePaths: [...submodules, ...flagged.submodules.filter((rel) => !submodules.includes(rel))],
    // Which lagging paths carry index bits, and which — `git add -A` cannot restage these at all.
    flaggedPaths: flagged.flagged,
    untrackedPaths: split(untrackedZ).filter((rel) => {
      try {
        return !isNeverCommittableStat(lstat(join(top, rel)));
      } catch {
        return true;
      }
    }),
  };
};

// Clean = nothing staged, nothing unstaged, no REVIEWABLE untracked-not-ignored paths — the same
// never-committable filter as the fingerprint, so the two can never disagree about a masks-only
// tree. Null when not decidable.
export const isTreeClean = (cwd, fsx) => {
  const state = computeWorkingState(cwd, fsx);
  if (state == null) return null;
  return (
    !state.stagedDirty &&
    state.unstagedPaths.length === 0 &&
    state.unstagedSubmodulePaths.length === 0 &&
    state.untrackedPaths.length === 0
  );
};
