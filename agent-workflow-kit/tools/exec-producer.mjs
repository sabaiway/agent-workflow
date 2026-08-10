// exec-producer.mjs — the GIT-side metric producer for an exec return (delegation Plan 2, Phase 1).
// It answers the two questions a return record cannot answer for itself: which objects the delegated
// run touched and how many bytes they represent, and what the canonical integration bundle is. It
// never writes, never appends and never spawns anything but git reads.
//
// dispatch-record.mjs:74-76 named this module before it existed: "the metric's byte domains are
// computed over STRUCTURED inputs handed in by a producer; the git-side producer is Plan 2, and it
// owns minting a stable objectId".
//
// ONE DOMAIN, THREE LAYERS (D7). The enumeration walks HEAD → index → worktree, exactly the layers
// the canonical payload concatenates — never the collapsed HEAD → worktree view. The difference is
// not academic: a staged change reverted in the worktree keeps its bytes in the payload (and so in
// the DENOMINATOR) while HEAD→worktree shows nothing at all, so the object would vanish from the
// NUMERATOR and the two halves of one ratio would describe different change sets. The diff bytes are
// computeFingerprintPayload's own bytes, imported rather than rebuilt.
//
// ONE OBJECT, ONE ENTRY. An object touched in both layers is a single entry, and its pre-image is
// always the HEAD blob — never the index blob: the numerator answers what the delegate could have
// spared the ORCHESTRATOR, measured against the dispatch baseline, and a metric-eligible dispatch
// starts from a clean tree where HEAD is that baseline.
//
// RENAMES ARE NOT RECONSTRUCTED, AND THAT IS THE DESIGN — a boundary, not an omission. git's OWN
// rename detection is consumed where git offers it (`--raw -M` sees a staged `git mv` within a layer),
// but a rename a delegate actually makes — the wrapper's git-write shim blocks every git write verb,
// so every one arrives as a tracked deletion plus an UNTRACKED creation — is accounted as exactly
// that: a deletion plus a creation.
//
// This module once matched those pairs by blob identity, and the machinery was SUBTRACTED after it
// produced silent-error edges in four consecutive review rounds: hashing that read through symlinks
// (and blocked forever on a symlink to a FIFO), abbreviated object names that never matched in a
// SHA-256 repository, source images taken from the wrong layer, attribute filters keyed to the
// destination path, a failed probe read as "not a candidate", link targets keyed through a lossy
// decode, and an ambiguity rule that could not see its own second key. Every one of those was a
// numerator that was WRONG WITHOUT ANYONE NOTICING — the worst failure mode an accounting path has.
// An identity heuristic buys accuracy on the ordinary refactor and pays for it in exactly that
// currency, so the trade was refused.
//
// The cost is stated with its DIRECTION, per case, because the direction is NOT the same in all of
// them — and a blanket "always optimistic" would be a false reassurance about an accounting number.
// Write O for the pre-image size:
//   • A PLAIN RENAME `a→b` emits `deleted pre:a (O)` + `new new:b (O)` = 2O against a recognised O.
//     OVER-counts, always.
//   • RENAME-THEN-EDIT emits `deleted pre:a (O)` + `new new:b (F')` = O+F' against a recognised O.
//     OVER-counts, always.
//   • RENAME-THEN-RECREATE is INDETERMINATE, and this is the one to be careful about. Moving `a` to
//     `b` and writing a fresh `a` of size F leaves git reporting a MODIFIED `a` beside an untracked
//     `b`, so the emission is `modified pre:a (O)` + `new new:b (O)` = 2O, against a recognised
//     O+F. The sign CROSSES at F = O: with F < O it over-counts, with F > O it UNDER-counts, and the
//     metric then reads pessimistic. There is no lane that could mark just this case ineligible —
//     the evidence is byte-identical to copying `a` to `b` and editing `a` (no git datum separates
//     them: the index stat cache would, but `ino` is legitimately zero under core.checkStat=minimal
//     and on Windows), so a predicate for it cannot be evaluated at this layer, and one broad enough
//     to catch it — any `modified` beside a `new` — would make most returns ineligible.
// Every object here is one git can PROVE: a tracked path with a recorded blob, or an untracked path
// that exists. Nothing is paired on a resemblance.
//
// CONFIG-HIDDEN PATHS ARE A STATED LIMIT, and the limit is the PAYLOAD's, not this module's. `git
// diff` honours `diff.ignoreSubmodules` and skips index entries carrying assume-unchanged or
// skip-worktree, so a path can be changed and stay invisible to both probes below. The kit already
// owns a probe that sees them — computeWorkingState (core-evidence.mjs:341) forces
// `--ignore-submodules=none` and folds in flaggedIndexLag — and `isTreeClean` consumes it, so a
// dispatch opened over such a tree records baselineClean:false and its return is metric-INELIGIBLE by
// name. What this module must NOT do is force those flags HERE: D7 binds the numerator to the byte
// domain of computeFingerprintPayload, which uses the same plain `git diff` — forcing them on one
// side only would let the numerator count objects the denominator cannot see, a worse failure than
// the blindness. Closing it for real means changing the shared payload, which is a Plan-1-frozen
// surface the review lane also consumes; that is queued as its own item, and Phase 2's `return` owns
// the return-time guard.
//
// IDENTITY CARRIES ITS DOMAIN (D6). `pre:<path>` for an object with a pre-image (keyed by the name it
// HAD) and `new:<path>` for a created one. The prefix is load-bearing: a rename a→b beside a
// re-created `a` would otherwise hand two objects one identity, and computeNumerator refuses a second
// size under an id it already counted — the whole return would be refused for an ordinary refactor.
//
// TYPE BEATS STATUS for the size rule; STATUS decides the identity domain. A gitlink contributes ZERO
// bytes deliberately — moving one costs this repository no bytes — but the zero belongs to the image
// actually COUNTED, not to the entry's kind: a regular file or a symlink REPLACED by a gitlink is
// still emitted as `submodule` (the type matrix is D6's) while keeping its real pre-image size, since
// paying it zero would drop a whole object's bytes out of the numerator on a type change. Every OTHER
// unknown size REFUSES — the fail-closed rule is never a silent zero.
//
// A TRANSIENT object (staged, then deleted from the worktree) counts its INDEX image once: the
// delegate authored those bytes, the payload carries them in both layers, and dropping them would
// credit the delegate with less than it wrote.
//
// Fail closed: outside a git work tree, on an unborn branch (no HEAD means no pre-image to attribute
// bytes against), on any git read that fails, and on any size it cannot establish.

import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  gitBuf, computeFingerprintPayload, isBinaryFile, isNeverCommittableStat, resolveBase,
} from './core-evidence.mjs';
import { lstatNoFollowRead } from './fs-read-nofollow.mjs';
import { frameIntegrationBundle } from './dispatch-record.mjs';

const refuse = (reason) => ({ ok: false, reason });

const GITLINK_MODE = '160000';
const SYMLINK_MODE = '120000';
const ABSENT_MODE = '000000';
const SUBMODULE_BYTES = 0;

export const PRE_IMAGE_ID_PREFIX = 'pre:';
export const NEW_IMAGE_ID_PREFIX = 'new:';

const isAbsentSha = (sha) => sha === undefined || /^0+$/.test(sha);

// PATHS ARE BYTES, and this module keys objects BY path. A NUL-delimited stream decoded whole with
// toString('utf8') folds every invalid byte to U+FFFD, so two DISTINCT paths — `x\xfe.txt` and
// `x\xff.txt` — arrive as one string and therefore as one objectId: computeNumerator then either
// refuses the whole return under a duplicate id or counts one object where there were two. So every
// -z stream is split into BUFFER segments and each name is trusted only if it survives a byte
// round-trip; a name that does not is a REFUSAL, never a repaired string. (The same defense runs one
// module down at core-evidence.mjs:199-210 — this is the family's idiom, not a new invention.)
const splitZBytes = (buf) => {
  const out = [];
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== 0) continue;
    out.push(buf.subarray(start, i));
    start = i + 1;
  }
  if (start < buf.length) out.push(buf.subarray(start));
  return out;
};

const decodesExactly = (slice) => Buffer.from(slice.toString('utf8'), 'utf8').equals(slice);

const undecodablePath = (where, slice) => refuse(`git reported a path in ${where} whose bytes are not valid UTF-8 (${JSON.stringify(slice.toString('utf8'))}) — decoding it would fold DISTINCT paths onto ONE objectId and silently merge or drop an object, so the enumeration refuses rather than counting on a collapsed identity (fail closed)`);

const gitTop = (cwd) => {
  const buf = gitBuf(['rev-parse', '--show-toplevel'], cwd);
  return buf == null ? null : buf.toString('utf8').replace(/\r?\n$/, '');
};

const blobSize = (top, sha) => {
  const buf = gitBuf(['cat-file', '-s', sha], top);
  if (buf == null) return null;
  const size = Number(buf.toString('utf8').trim());
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
};

// The raw record grammar, one shape for both layers: ":<srcMode> <dstMode> <srcSha> <dstSha> <status>"
// followed by one path, or two when the status renames. The META field is ASCII by construction; only
// the PATH fields carry arbitrary bytes, so only they are round-trip checked.
const parseRawRecords = (buf, where) => {
  const fields = splitZBytes(buf);
  const records = [];
  const unparseable = () => refuse(`a git raw record in ${where} is unparseable — the enumeration refuses rather than skipping a touched object`);
  for (let i = 0; i < fields.length; i += 1) {
    const meta = fields[i].toString('utf8');
    if (meta === '' || meta[0] !== ':') continue;
    const parts = meta.slice(1).split(' ');
    if (parts.length < 5) return unparseable();
    const [srcMode, dstMode, srcSha, dstSha, statusField] = parts;
    const status = statusField[0];
    const renamed = status === 'R' || status === 'C';
    const first = fields[i + 1];
    const second = renamed ? fields[i + 2] : undefined;
    if (first === undefined || (renamed && second === undefined)) return unparseable();
    i += renamed ? 2 : 1;
    if (!decodesExactly(first)) return undecodablePath(where, first);
    if (renamed && !decodesExactly(second)) return undecodablePath(where, second);
    const srcPath = first.toString('utf8');
    records.push({
      srcMode, dstMode, srcSha, dstSha, status,
      srcPath,
      dstPath: renamed ? second.toString('utf8') : srcPath,
    });
  }
  return { ok: true, records };
};

// git's OWN notion of binary, asked per layer: --numstat prints "-" for both counts on a binary path.
// The record is `<added>TAB<deleted>TAB<path>` — split by the FIRST TWO tabs only, because a path may
// legally contain tabs of its own and a three-way split silently drops such a record, losing the
// binary marker and sizing the object by status instead of type. An INCOMPLETE record is refused, not
// skipped: a marker that could not be read is not a marker that is absent.
const binaryNames = (top, args, where) => {
  const buf = gitBuf(['diff', ...args, '--no-ext-diff', '--numstat', '-z', '-M'], top);
  return buf == null
    ? refuse('git could not read the numstat binary markers (fail closed)')
    : parseNumstatMarkers(buf, where);
};

// Exported as a TEST SEAM, and only for that: both refusals below guard against output git does not
// produce on demand — a record short of its two separators, and a rename record that promises two
// path segments and carries fewer. They are the fail-closed arms of this reader, so they are pinned
// directly rather than left as unreachable prose.
export const parseNumstatMarkers = (buf, where) => {
  const fields = splitZBytes(buf);
  const names = new Set();
  const TAB = 0x09;
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i];
    if (record.length === 0) continue;
    const firstTab = record.indexOf(TAB);
    const secondTab = firstTab === -1 ? -1 : record.indexOf(TAB, firstTab + 1);
    if (firstTab === -1 || secondTab === -1) {
      return refuse(`a git numstat record in ${where} carries fewer than the two separators its grammar requires (${JSON.stringify(record.toString('utf8'))}) — the enumeration refuses rather than skipping a marker it could not read`);
    }
    const added = record.subarray(0, firstTab).toString('utf8');
    const deleted = record.subarray(firstTab + 1, secondTab).toString('utf8');
    const isBinary = added === '-' && deleted === '-';
    const pathSlice = record.subarray(secondTab + 1);
    // A rename leaves the path field EMPTY and follows with two separate NUL-terminated names. A
    // record that promises them and does not carry them is REFUSED, not skipped — the same rule the
    // incomplete-record arm above states, and skipping it would drop a marker while claiming to read
    // every one.
    let slices;
    if (pathSlice.length === 0) {
      const from = fields[i + 1];
      const to = fields[i + 2];
      i += 2;
      if (from === undefined || to === undefined) {
        return refuse(`a git numstat rename record in ${where} is missing the path segments its grammar promises — the enumeration refuses rather than skipping a marker it could not read`);
      }
      slices = [from, to];
    } else {
      slices = [pathSlice];
    }
    for (const slice of slices) {
      if (!decodesExactly(slice)) return undecodablePath(where, slice);
      if (isBinary) names.add(slice.toString('utf8'));
    }
  }
  return { ok: true, names };
};

// ── the object model ──────────────────────────────────────────────────────────────────────────────
// One record per touched object: where it came from in HEAD, where it ended up, and every name it
// wore in between (the names the binary oracle and the type probes are asked about).

const makeObject = ({ headPath, headSha, headMode }) => ({
  headPath, headSha, headMode,
  finalPath: null, finalMode: ABSENT_MODE, finalSource: null,
  indexPath: null, indexSha: null, indexMode: ABSENT_MODE,
  names: new Set([headPath].filter(Boolean)),
});

const kindForModes = (modes) => {
  if (modes.includes(GITLINK_MODE)) return 'submodule';
  if (modes.includes(SYMLINK_MODE)) return 'symlink';
  return null;
};

const buildObjects = (staged, unstaged) => {
  const objects = [];
  // HEAD → index. A staged record's DESTINATION name is how the unstaged layer will refer to it.
  const byIndexPath = new Map();
  for (const r of staged) {
    const hasHead = !isAbsentSha(r.srcSha) && r.srcMode !== ABSENT_MODE;
    const object = makeObject({
      headPath: hasHead ? r.srcPath : null,
      headSha: hasHead ? r.srcSha : null,
      headMode: hasHead ? r.srcMode : ABSENT_MODE,
    });
    if (r.status !== 'D') {
      object.finalPath = r.dstPath;
      object.finalMode = r.dstMode;
      object.finalSource = 'index';
      object.indexPath = r.dstPath;
      object.indexSha = r.dstSha;
      object.indexMode = r.dstMode;
      object.names.add(r.dstPath);
      byIndexPath.set(r.dstPath, object);
    }
    objects.push(object);
  }
  // index → worktree. A path absent from the staged layer is unchanged there, so its index blob IS
  // its HEAD blob and the object enters the model here.
  for (const r of unstaged) {
    const known = byIndexPath.get(r.srcPath);
    const object = known ?? makeObject({ headPath: r.srcPath, headSha: r.srcSha, headMode: r.srcMode });
    if (known === undefined) {
      object.indexPath = r.srcPath;
      object.indexSha = r.srcSha;
      object.indexMode = r.srcMode;
      objects.push(object);
    }
    object.names.add(r.srcPath);
    if (r.status === 'D') {
      object.finalPath = null;
      object.finalMode = ABSENT_MODE;
      object.finalSource = null;
    } else {
      object.finalPath = r.dstPath;
      object.finalMode = r.dstMode;
      object.finalSource = 'worktree';
      object.names.add(r.dstPath);
    }
  }
  return objects;
};

// ── entry construction ────────────────────────────────────────────────────────────────────────────

const sizeRefusal = (kind, path) => refuse(`cannot establish the size of the ${kind} path "${path}" — the enumeration refuses rather than counting an unknown as zero (fail closed)`);

const entryForObject = (top, object, binary, lstat) => {
  const hasPreImage = object.headPath !== null;
  // An object with no pre-image is identified by the name it was ADDED under: the index is the first
  // place it existed, and a later filesystem move must not re-key it (a transient object, which ends
  // nowhere at all, has only that name to begin with).
  const identityPath = hasPreImage ? object.headPath : (object.indexPath ?? object.finalPath);
  const objectId = `${hasPreImage ? PRE_IMAGE_ID_PREFIX : NEW_IMAGE_ID_PREFIX}${identityPath}`;
  const path = object.finalPath ?? object.headPath ?? object.indexPath;
  const typeKind = kindForModes([object.headMode, object.indexMode, object.finalMode])
    ?? ([...object.names].some((n) => binary.has(n)) ? 'binary' : null);

  if (typeKind !== null) {
    // The COUNTED image decides the size, even when the emitted kind comes from another layer. A
    // gitlink in ANY layer makes the kind `submodule` (TYPE beats STATUS, D6) — but a regular file
    // REPLACED by a gitlink is still counted at its HEAD blob, and paying it the submodule's
    // deliberate zero would drop a whole object's bytes out of the numerator on a type change. Zero
    // belongs to a counted image that is ITSELF a gitlink: that is the case where the move costs this
    // repository no bytes.
    const countedMode = hasPreImage
      ? object.headMode
      : (object.finalSource === 'worktree' ? object.finalMode : object.indexMode);
    if (countedMode === GITLINK_MODE) return { ok: true, entry: { kind: typeKind, path, objectId, sizeBytes: SUBMODULE_BYTES } };
    const size = hasPreImage
      ? blobSize(top, object.headSha)
      : (object.finalSource === 'worktree' ? lstat(join(top, object.finalPath))?.size ?? null : blobSize(top, object.indexSha));
    if (size == null) return sizeRefusal(typeKind, path);
    return { ok: true, entry: { kind: typeKind, path, objectId, sizeBytes: size } };
  }

  if (!hasPreImage) {
    const size = object.finalSource === 'worktree'
      ? lstat(join(top, object.finalPath))?.size ?? null
      : blobSize(top, object.indexSha);
    if (size == null) return sizeRefusal('created', path);
    return { ok: true, entry: { kind: 'new', path, objectId, postImageBytes: size } };
  }

  const preImageBytes = blobSize(top, object.headSha);
  if (preImageBytes == null) return sizeRefusal('pre-image of', identityPath);
  if (object.finalPath === null) return { ok: true, entry: { kind: 'deleted', path, objectId, preImageBytes } };
  if (object.finalPath !== object.headPath) {
    return { ok: true, entry: { kind: 'renamed', path: object.finalPath, objectId, preImageBytes, fromPath: object.headPath } };
  }
  return { ok: true, entry: { kind: 'modified', path, objectId, preImageBytes } };
};

const entryForUntracked = (top, rel, lstat) => {
  const full = join(top, rel);
  const stat = lstat(full);
  if (isNeverCommittableStat(stat)) return { ok: true, entry: null };
  const objectId = `${NEW_IMAGE_ID_PREFIX}${rel}`;
  if (stat == null || !stat.isFile()) {
    return stat != null && stat.isSymbolicLink()
      ? { ok: true, entry: { kind: 'symlink', path: rel, objectId, sizeBytes: stat.size } }
      : { ok: true, entry: { kind: 'non-regular', path: rel, objectId, sizeBytes: 0 } };
  }
  return isBinaryFile(full)
    ? { ok: true, entry: { kind: 'binary', path: rel, objectId, sizeBytes: stat.size } }
    : { ok: true, entry: { kind: 'new', path: rel, objectId, postImageBytes: stat.size } };
};

// enumerateReturnedObjects(cwd, io?) → { ok: true, entries } | { ok: false, reason }. The entries are
// the STRUCTURED input computeNumerator consumes; this module never computes the numerator itself, so
// the closed vocabulary stays the single authority on what a component is. `io.lstat` and
// `io.untracked` are TEST SEAMS for the arms git cannot be made to produce on demand (an unstatable
// path, a never-committable class); an injected lstat returning undefined falls through to the real one.
export const enumerateReturnedObjects = (cwd = process.cwd(), io = {}) => {
  const top = gitTop(cwd);
  if (top == null) return refuse('not inside a git work tree — an exec return is enumerated against a repository (fail closed)');
  if (resolveBase(top) == null) {
    return refuse('the branch is unborn (no HEAD) — there is no pre-image to attribute delegated bytes against (fail closed)');
  }
  // ABSENT and UNREADABLE are different answers. ENOENT means the path vanished between `ls-files`
  // and the stat, which the payload itself records name-only — mirroring it keeps numerator and
  // denominator over ONE object set. Every OTHER errno (EACCES, EIO, ENOTDIR, ELOOP on a parent) is
  // a FAILED PROBE, and a failed probe recorded as a zero-byte non-regular would be an accounting
  // number nobody could tell was wrong. So the failure is captured and the whole enumeration refuses
  // with the path and the code; this module's contract is a refusal OBJECT, never a throw.
  let probeFailure = null;
  const lstat = (path) => {
    try {
      const injected = io.lstat?.(path);
      return injected === undefined ? lstatNoFollowRead(path) : injected;
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      probeFailure ??= { path: String(path), code: err?.code ?? err?.message ?? 'lstat failed' };
      return null;
    }
  };
  const refusedProbe = () => (probeFailure === null
    ? null
    : refuse(`could not stat "${probeFailure.path}" (${probeFailure.code}) — an unreadable path is a FAILED probe, not an absent one, and counting it as a zero-byte non-regular would put a number nobody can check into the numerator (fail closed)`));
  // --no-abbrev: the raw format ABBREVIATES object names by default, and these names are handed
  // straight to `cat-file -s` to size an image. A full name is read so the value never depends on an
  // abbreviation staying unique in this repository, nor on the repository's object format —
  // `--abbrev=40` is NOT the same instruction, since in a SHA-256 repository it truncates the 64-hex
  // name to 40.
  const stagedRaw = gitBuf(['diff', '--cached', '--raw', '-z', '-M', '--no-abbrev', '--no-ext-diff'], top);
  const unstagedRaw = gitBuf(['diff', '--raw', '-z', '-M', '--no-abbrev', '--no-ext-diff'], top);
  if (stagedRaw == null || unstagedRaw == null) return refuse('git could not read the tracked change set (fail closed)');
  const staged = parseRawRecords(stagedRaw, 'the staged change set');
  if (!staged.ok) return staged;
  const unstaged = parseRawRecords(unstagedRaw, 'the unstaged change set');
  if (!unstaged.ok) return unstaged;
  const stagedBinary = binaryNames(top, ['--cached'], 'the staged binary markers');
  if (!stagedBinary.ok) return stagedBinary;
  const unstagedBinary = binaryNames(top, [], 'the unstaged binary markers');
  if (!unstagedBinary.ok) return unstagedBinary;
  const binary = new Set([...stagedBinary.names, ...unstagedBinary.names]);
  let untracked = io.untracked?.();
  if (untracked === undefined) {
    const buf = gitBuf(['ls-files', '--others', '--exclude-standard', '-z'], top);
    if (buf == null) return refuse('git could not read the untracked section (fail closed)');
    const slices = splitZBytes(buf).filter((slice) => slice.length > 0);
    const undecodable = slices.find((slice) => !decodesExactly(slice));
    if (undecodable !== undefined) return undecodablePath('the untracked section', undecodable);
    untracked = slices.map((slice) => slice.toString('utf8'));
  }

  // Tracked objects and untracked paths are enumerated INDEPENDENTLY: nothing here pairs a deletion
  // with a creation, so no path is ever consumed by another object's identity.
  const objects = buildObjects(staged.records, unstaged.records);
  const entries = [];
  for (const object of objects) {
    const built = entryForObject(top, object, binary, lstat);
    // A recorded probe failure OUTRANKS whatever refusal the entry builder produced: a null size from
    // an unreadable path would otherwise surface as "cannot establish the size", losing the path and
    // the errno this module promised to name.
    if (!built.ok) return refusedProbe() ?? built;
    entries.push(built.entry);
  }
  for (const rel of untracked) {
    const built = entryForUntracked(top, rel, lstat);
    // A recorded probe failure OUTRANKS whatever refusal the entry builder produced: a null size from
    // an unreadable path would otherwise surface as "cannot establish the size", losing the path and
    // the errno this module promised to name.
    if (!built.ok) return refusedProbe() ?? built;
    if (built.entry !== null) entries.push(built.entry);
  }
  // Checked LAST and over the whole walk: a failed stat anywhere refuses the entire enumeration, so
  // no partially-honest entry list can escape on the strength of the paths that happened to work.
  return refusedProbe() ?? { ok: true, entries };
};

// computeReturnedDiff(cwd) → the canonical uncommitted-state payload BYTES, or a refusal. This is the
// diff half of the integration bundle, and it is the very payload computeTreeFingerprint digests — so
// the bytes the denominator counts and the digest the records bind describe one state. It refuses
// where the enumeration refuses: one entry point may not answer for a tree the other rejects. That
// sentence used to hold only for the two SHARED preconditions below, which let an AMBIGUOUS rename
// refuse the enumeration while the diff still handed back bytes — so the enumeration is run here and
// its refusal surfaced verbatim. One extra pass, once per return, never in a loop.
export const computeReturnedDiff = (cwd = process.cwd(), io = {}) => {
  const top = gitTop(cwd);
  if (top == null) return refuse('not inside a git work tree — there is no returned diff to compute (fail closed)');
  if (resolveBase(top) == null) {
    return refuse('the branch is unborn (no HEAD) — there is no pre-image to attribute delegated bytes against (fail closed)');
  }
  const enumerated = enumerateReturnedObjects(cwd, io);
  if (!enumerated.ok) return enumerated;
  // The payload builder guards its lstat but reads untracked file BYTES unguarded, so an unreadable
  // or vanishing untracked file throws out of it. This entry point promises a refusal object, and a
  // caller that framed a bundle around a thrown read would have no bytes and no reason either.
  let payload;
  try {
    payload = computeFingerprintPayload(cwd);
  } catch (err) {
    return refuse(`the canonical payload could not be read (${err?.code ?? err?.message ?? 'read failed'}) — the returned diff is refused rather than framed around a partial read (fail closed)`);
  }
  return payload == null
    ? refuse('the canonical payload could not be computed (fail closed)')
    : { ok: true, diff: payload };
};

// assembleIntegrationBundle(diff, report) → the framed bundle with its digest and length. The framing
// itself belongs to the vocabulary; this only carries the two parts to it and hashes the result.
export const assembleIntegrationBundle = (diff, report) => {
  const bundle = frameIntegrationBundle(diff, report);
  return {
    bundle,
    bundleDigest: createHash('sha256').update(bundle).digest('hex'),
    bundleLength: bundle.length,
  };
};
