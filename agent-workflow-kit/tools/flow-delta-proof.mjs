// flow-delta-proof.mjs — the bookkeeping-delta custody proof (#60): the masked revert-and-recompute
// at mint time, its strict -z index/HEAD parsers, the diff-section mask, the ONE captured read set,
// computeMaskedFingerprintPayload and mintBookkeepingDelta. Split out of flow-store.mjs unchanged
// (baseline-practices tranche 2); the facade re-exports both public names.
//
// The computation only READS: the working tree is never mutated, and an unconfined delta never
// lands. Imports run ONE way: this leaf mints through the store's ONE append door
// (flow-append.mjs) and never reaches the flow-store.mjs facade or its sibling mint leaf — the
// one-line sha256Hex, HEX64_RE and the git buffer helper below are deliberate copies rather than
// sideways imports.

import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { lstatNoFollow } from './atomic-write.mjs';
import { FLOW_SCHEMA_VERSION, canonicalFlowDigest } from './flow-record.mjs';
import { isNeverCommittableStat, isBinaryFile, lexicalRepoRelative, resolveBase } from './core-evidence.mjs';
import { flowStoreStop, gitLine, describeNonRegular } from './flow-store-read.mjs';
import { appendFlowRecord } from './flow-append.mjs';

const stop = flowStoreStop;

const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const gitBuf = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
};
const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

const HEX64_RE = /^[0-9a-f]{64}$/;

// The supported pre-state model; everything else refuses BY NAME (fail closed): the delta lives in
// the WORKTREE layer of one plain-ASCII, non-binary, non-executable regular path. A tracked path
// must be CLEAN at the path before the delta (pre-change worktree bytes = its index entry), so the
// pre-state contributes NO unstaged diff section and the mask is pure section REMOVAL plus
// untracked-entry splicing — the recompute never regenerates git diff bytes, whose exact form this
// module cannot promise. Supported transitions: present→present, present→absent, absent→present.

const GIT_PLAIN_PATH_RE = /^[\x20-\x7e]+$/;
const pathNeedsGitQuoting = (rel) => !GIT_PLAIN_PATH_RE.test(rel) || rel.includes('"') || rel.includes('\\');
const bufferLooksBinary = (buf) => buf.subarray(0, 8192).includes(0);
const REGULAR_FILE_MODE = '100644';

const defaultRunGit = (args, dir) => spawnSync('git', args, { cwd: dir, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });

// The declared path enters git as a LITERAL pathspec and comes back through a strict -z parse:
// exactly one NUL-terminated record whose path field EQUALS the declared rel, full-octal mode,
// an OID of exactly 40 or 64 hex — a glob-capable name ([]*?) or a prefix-valid truncated answer
// can then never bind the proof to another file (fail closed on every mismatch).
const OID_PART = '(?:[0-9a-f]{40}|[0-9a-f]{64})';
const INDEX_META_RE = new RegExp(`^([0-7]{6}) (${OID_PART}) (\\d)$`);
const TREE_META_RE = new RegExp(`^([0-7]{6}) (\\w+) (${OID_PART})$`);

const parseZRecords = (stdout) => {
  const text = stdout.toString('utf8');
  if (text === '') return [];
  if (!text.endsWith('\0')) return null;
  return text.slice(0, -1).split('\0');
};

const splitZEntry = (entry, metaRe) => {
  const at = entry.indexOf('\t');
  if (at === -1) return null;
  const meta = metaRe.exec(entry.slice(0, at));
  return meta == null ? null : { meta, path: entry.slice(at + 1) };
};

const readIndexEntry = (top, rel, runGit) => {
  const out = runGit(['ls-files', '-s', '-z', '--', `:(literal)${rel}`], top);
  if (out.error || out.status !== 0) throw stop(`cannot read the index entry of ${rel} (git ls-files failed) — refusing to mint (fail closed)`);
  const recordsZ = parseZRecords(out.stdout);
  if (recordsZ == null) throw stop(`cannot parse the index entry of ${rel} (unterminated git ls-files output) — refusing to mint (fail closed)`);
  if (recordsZ.length === 0) return null;
  const entry = splitZEntry(recordsZ[0], INDEX_META_RE);
  if (recordsZ.length > 1 || entry == null || entry.meta[3] !== '0' || entry.path !== rel) {
    throw stop(`the declared path ${rel} carries an unmerged or unparseable index entry — an unsupported pre-state class (fail closed)`);
  }
  return { mode: entry.meta[1], sha: entry.meta[2] };
};

// An absent HEAD layer is PROVEN unborn, never assumed: rev-parse must answer with EXACTLY the
// clean verify-miss status (1) AND HEAD must still resolve as a symbolic ref; any operational
// fault fails closed. "No entry" is ONLY an empty ls-tree stdout — a non-empty answer must parse
// as exactly one entry line, else the repository is at fault (a false custody proof otherwise).
const GIT_VERIFY_MISS_STATUS = 1;
const readHeadEntry = (top, rel, runGit) => {
  const probe = runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], top);
  if (probe.error || probe.status !== 0) {
    const verifyMiss = !probe.error && probe.status === GIT_VERIFY_MISS_STATUS;
    const sym = verifyMiss ? runGit(['symbolic-ref', '--quiet', 'HEAD'], top) : null;
    if (sym == null || sym.error || sym.status !== 0) {
      throw stop('cannot decide the HEAD state (git rev-parse --verify HEAD did not answer with a clean verify miss, or symbolic-ref HEAD failed) — refusing to mint (fail closed)');
    }
    return null;
  }
  const out = runGit(['ls-tree', '-z', 'HEAD', '--', `:(literal)${rel}`], top);
  if (out.error || out.status !== 0) throw stop(`cannot read the HEAD entry of ${rel} (git ls-tree failed with an existing HEAD) — refusing to mint (fail closed)`);
  const recordsZ = parseZRecords(out.stdout);
  if (recordsZ == null) throw stop(`cannot parse the HEAD entry of ${rel} (unterminated git ls-tree output) — refusing to mint (fail closed)`);
  if (recordsZ.length === 0) return null;
  const entry = splitZEntry(recordsZ[0], TREE_META_RE);
  if (recordsZ.length > 1 || entry == null || entry.path !== rel) {
    throw stop(`cannot parse the HEAD entry of ${rel} (unexpected git ls-tree output) — refusing to mint (fail closed)`);
  }
  if (entry.meta[2] !== 'blob') {
    throw stop(`the HEAD entry of ${rel} is a ${entry.meta[2]}, not a blob — an unsupported pre-state class (fail closed)`);
  }
  return { mode: entry.meta[1], sha: entry.meta[3] };
};

const readBlob = (top, sha, runGit) => {
  const out = runGit(['cat-file', 'blob', sha], top);
  if (out.error || out.status !== 0) throw stop(`cannot read blob ${sha} from the object store — refusing to mint (fail closed)`);
  return out.stdout;
};

// Byte-level removal of ONE file's section from a git diff buffer. Hunk lines start with
// [ +\-\\@], so a line starting "diff --git " is always a section header; the declared path is
// plain-ASCII by refusal, so its header is these exact bytes. No section = a no-op mask.
const DIFF_SECTION_START = Buffer.from('\ndiff --git ');
const removeDiffSection = (buf, rel) => {
  const header = Buffer.from(`diff --git a/${rel} b/${rel}\n`);
  let at = -1;
  if (buf.subarray(0, header.length).equals(header)) at = 0;
  else {
    const i = buf.indexOf(Buffer.concat([Buffer.from('\n'), header]));
    if (i !== -1) at = i + 1;
  }
  if (at === -1) return buf;
  const next = buf.indexOf(DIFF_SECTION_START, at + header.length - 1);
  const end = next === -1 ? buf.length : next + 1;
  return Buffer.concat([buf.subarray(0, at), buf.subarray(end)]);
};

// One untracked entry's payload chunks, branch-for-branch the frozen core's discipline
// (computeFingerprintPayload) — the NULL-mask parity test pins the byte equality.
const untrackedEntryChunks = (top, rel, lstat) => {
  const full = join(top, rel);
  let stat = null;
  try {
    stat = lstat(full);
  } catch {
    stat = null;
  }
  if (isNeverCommittableStat(stat)) return [];
  if (stat?.isSymbolicLink()) {
    let target = '?';
    try {
      target = readlinkSync(full);
    } catch {
      target = '?';
    }
    return [Buffer.from(`untracked-symlink:${rel} -> ${target}\n`)];
  }
  if (!stat?.isFile()) return [Buffer.from(`untracked-nonregular:${rel}\n`)];
  if (isBinaryFile(full)) return [Buffer.from(`untracked-binary:${rel}\n`)];
  return [Buffer.from(`untracked:${rel}\n`), readFileSync(full)];
};

// ONE captured read set — every assembly over it (masked and unmasked) binds the SAME tree
// snapshot, so a tree move between two independent snapshots can never be certified. The three
// git reads themselves are separate processes; that window is the frozen core's own inherent
// residual and stays declared, not closed.
const captureFingerprintPieces = (cwd, { lstat = lstatSync } = {}) => {
  const top = gitLine(['rev-parse', '--show-toplevel'], cwd);
  if (top == null) return null;
  const staged = gitBuf(['diff', '--cached', '--no-ext-diff'], top);
  const unstaged = gitBuf(['diff', '--no-ext-diff'], top);
  const untrackedZ = gitBuf(['ls-files', '--others', '--exclude-standard', '-z'], top);
  if (staged == null || unstaged == null || untrackedZ == null) return null;
  const entries = untrackedZ.toString('utf8').split('\0').filter(Boolean)
    .map((rel) => ({ rel, chunks: untrackedEntryChunks(top, rel, lstat) }));
  return { staged, unstaged, entries };
};

// mask: null = the exact frozen-core payload; { layer: 'diff', rel } removes the path's unstaged
// section (its pre-state section is EMPTY by the clean-at-path rule); { layer: 'untracked', rel,
// insert, preBytes } splices the untracked entry (git emits ls-files sorted by path bytes).
const assembleMaskedPayload = (pieces, mask) => {
  const unstaged = mask?.layer === 'diff' ? removeDiffSection(pieces.unstaged, mask.rel) : pieces.unstaged;
  let entries = pieces.entries;
  if (mask?.layer === 'untracked') {
    entries = entries.filter((e) => e.rel !== mask.rel);
    if (mask.insert) {
      const at = entries.findIndex((e) => e.rel > mask.rel);
      entries = [...entries];
      entries.splice(at === -1 ? entries.length : at, 0, { rel: mask.rel, chunks: [Buffer.from(`untracked:${mask.rel}\n`), mask.preBytes] });
    }
  }
  return Buffer.concat([pieces.staged, unstaged, ...entries.flatMap((e) => e.chunks)]);
};

export const computeMaskedFingerprintPayload = (cwd, mask = null, fsx) => {
  const pieces = captureFingerprintPieces(cwd, fsx);
  return pieces == null ? null : assembleMaskedPayload(pieces, mask);
};

// mintBookkeepingDelta: the FULL pre-state arrives as EXPLICIT inputs (pre-change worktree bytes +
// the presence class; tracked-ness derives from the window-constant HEAD/index layers) — never
// reconstructed from ambient git state. The computation only READS: the working tree is never
// mutated. The mint refuses unless the masked recompute reproduces fingerprintBefore — an
// unconfined delta never lands; the proof payload persists so the checker can verify a PROVEN
// mint against a bare declaration.
export const mintBookkeepingDelta = ({ cwd = process.cwd(), env = process.env, deps = {}, path: rel, fingerprintBefore, preContent = null, timestamp = new Date().toISOString() } = {}) => {
  if (typeof fingerprintBefore !== 'string' || !HEX64_RE.test(fingerprintBefore)) {
    throw stop('fingerprintBefore must be the 64-hex PRE-DELTA tree fingerprint — the proof compares the masked recompute against it (fail closed)');
  }
  const lex = lexicalRepoRelative(rel);
  if (!lex.ok) throw stop(`the declared path must be lexically repo-relative — ${lex.reason} (fail closed)`);
  if (pathNeedsGitQuoting(rel)) {
    throw stop(`the declared path "${rel}" needs git diff-header quoting — an unsupported pre-state class (the masked recompute matches plain header bytes only; fail closed)`);
  }
  const top = gitLine(['rev-parse', '--show-toplevel'], cwd);
  if (top == null) throw stop('not inside a git work tree — the custody proof has no meaning outside the fingerprint domain; refusing to mint');
  const preBytes = preContent == null ? null : Buffer.from(preContent);
  if (preBytes !== null && bufferLooksBinary(preBytes)) {
    throw stop(`the pre-change bytes of ${rel} carry binary content — an unsupported pre-state class (fail closed)`);
  }
  const full = join(top, rel);
  const st = lstatNoFollow(full, deps.lstat ?? lstatSync);
  if (st?.isSymbolicLink()) throw stop(`the declared path ${rel} is a symlink — an unsupported pre-state class (fail closed)`);
  if (st && !st.isFile()) throw stop(`the declared path ${rel} is a ${describeNonRegular(st)} — an unsupported pre-state class (fail closed)`);
  if (st && (st.mode & 0o111) !== 0) throw stop(`the declared path ${rel} carries an executable mode — an unsupported pre-state class (mode motion cannot be expressed; fail closed)`);
  const nowBytes = st ? readFileSync(full) : null;
  if (nowBytes !== null && bufferLooksBinary(nowBytes)) {
    throw stop(`the declared path ${rel} carries binary content — an unsupported pre-state class (fail closed)`);
  }
  const preClass = preBytes === null ? 'absent' : 'present';
  if (preClass === 'absent' && nowBytes === null) {
    throw stop('the absent→absent transition is unsupported — supported: present→present, present→absent, absent→present (fail closed)');
  }
  const runGit = deps.runGit ?? defaultRunGit;
  const index = readIndexEntry(top, rel, runGit);
  const head = readHeadEntry(top, rel, runGit);
  for (const [layer, entry] of [['index', index], ['HEAD', head]]) {
    if (entry && entry.mode !== REGULAR_FILE_MODE) {
      throw stop(`the ${layer} entry of ${rel} carries mode ${entry.mode} — an unsupported pre-state class (only plain ${REGULAR_FILE_MODE} regular files are expressible; fail closed)`);
    }
  }
  if (index == null && head != null) {
    throw stop(`the declared path ${rel} has a HEAD entry but no index entry (a staged deletion) — an unsupported pre-state class (fail closed)`);
  }
  const tracked = index != null || head != null;
  const headBytes = head == null ? null : readBlob(top, head.sha, runGit);
  const indexBytes = index == null ? null : readBlob(top, index.sha, runGit);
  let mask;
  if (tracked) {
    if (preClass === 'absent') {
      throw stop(`the declared path ${rel} is tracked while its pre-change worktree state is absent — a dirty pre-state at the declared path is an unsupported pre-state class (the masked proof covers a clean-at-path pre-state only; fail closed)`);
    }
    if (!preBytes.equals(indexBytes)) {
      throw stop(`the declared path ${rel} has a dirty pre-state (the pre-change worktree bytes do not equal the index entry) — an unsupported pre-state class (the masked proof covers a clean-at-path pre-state only; fail closed)`);
    }
    mask = { layer: 'diff', rel };
  } else {
    // --no-index: the ignore ANSWER must come from the rules alone — with the index consulted, a
    // tracked glob neighbor (feature-a.md vs the literal feature-[a].md) flips the answer and a
    // genuinely ignored path would spuriously refuse to mint.
    const ig = runGit(['check-ignore', '-q', '--no-index', '--', rel], top);
    if (ig.error || (ig.status !== 0 && ig.status !== 1)) {
      throw stop(`cannot decide the ignore state of ${rel} (git check-ignore failed) — refusing to mint (fail closed)`);
    }
    // An ignored path is outside the fingerprint domain in BOTH states — the mask is a no-op there.
    // Honest limit: an untracked path's MODE is likewise invisible to the frozen payload in both
    // states (an entry is name + bytes only) — untracked mode motion is neither expressible nor
    // claimed; only the CURRENT tree's non-plain modes refuse by name above.
    mask = { layer: 'untracked', rel, insert: preClass === 'present' && ig.status !== 0, preBytes };
  }
  const pieces = captureFingerprintPieces(cwd, deps);
  if (pieces == null) throw stop('cannot capture the fingerprint read set (a git probe failed) — refusing to mint (fail closed)');
  // Bracket: the declared path must still be EXACTLY what the class checks and contentDigest
  // observed — the no-follow class checks repeat first, then presence + bytes must match, so the
  // digest and the captured payload can never bind two different post-states.
  const stAfter = lstatNoFollow(full, deps.lstat ?? lstatSync);
  if (stAfter?.isSymbolicLink()) throw stop(`the declared path ${rel} is a symlink — an unsupported pre-state class (fail closed)`);
  if (stAfter && !stAfter.isFile()) throw stop(`the declared path ${rel} is a ${describeNonRegular(stAfter)} — an unsupported pre-state class (fail closed)`);
  if (stAfter && (stAfter.mode & 0o111) !== 0) throw stop(`the declared path ${rel} carries an executable mode — an unsupported pre-state class (mode motion cannot be expressed; fail closed)`);
  const bytesAfter = stAfter ? readFileSync(full) : null;
  const declaredMoved = (stAfter == null) !== (nowBytes === null)
    || (nowBytes !== null && bytesAfter !== null && !bytesAfter.equals(nowBytes));
  if (declaredMoved) {
    throw stop(`the declared path ${rel} moved under the mint (its bytes or presence changed during the capture) — contentDigest and the captured payload must bind ONE post-state; retry on a quiescent tree (fail closed)`);
  }
  const maskedFingerprint = sha256Hex(assembleMaskedPayload(pieces, mask));
  if (maskedFingerprint !== fingerprintBefore) {
    throw stop(`the delta is NOT confined to the declared path ${rel} — the masked revert-and-recompute (${maskedFingerprint.slice(0, 12)}…) does not reproduce fingerprintBefore (${fingerprintBefore.slice(0, 12)}…); something else moved in the window (fail closed)`);
  }
  // Both fingerprints derive from the ONE captured read set — a tree move between two independent
  // snapshots can never be certified as a confined delta.
  const fingerprintAfter = sha256Hex(assembleMaskedPayload(pieces, null));
  const record = {
    schema: FLOW_SCHEMA_VERSION, kind: 'bookkeeping-delta', fingerprintBefore, fingerprintAfter,
    path: rel, contentDigest: nowBytes === null ? null : sha256Hex(nowBytes),
    custodyProof: {
      preClass, tracked,
      headDigest: headBytes === null ? null : sha256Hex(headBytes),
      indexDigest: indexBytes === null ? null : sha256Hex(indexBytes),
      worktreeDigest: preBytes === null ? null : sha256Hex(preBytes),
      maskedFingerprint,
    },
    base: resolveBase(cwd), timestamp,
  };
  const { writtenPath } = appendFlowRecord({ cwd, record, env, deps });
  return { writtenPath, record, digest: canonicalFlowDigest(record) };
};
