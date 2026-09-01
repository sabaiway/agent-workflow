// worktree-handoff-return.mjs — the handoff-return rung (delegation Plan 3, Phase 3): deliver a
// landed satellite's return, prove its destination, and derive its observation when the change set
// allows one. A `dispatch` verb, so the ledger's ownership invariant holds unchanged; the satellite
// is located through the shared locator leaf, which is what keeps the 3200-line worktrees tool out
// of the dispatch CLI's import closure.
//
// What the rung DOES, in order: locate the satellite and prove the handoff identity there · read
// the handoff's raw bytes through the family's no-follow reader and RE-PARSE the record from those
// same bytes (one byte source for the proof, the delivery and the digest — a record swapped between
// the identity read and the delivery read refuses) · require prepared-tree AND prepared-head and
// re-attest BOTH against MAIN (D8: after a commit the clean index reproduces the committed tree, so
// a tree comparison alone cannot close the window) · deliver every user-owned fragment byte
// verbatim with its boundaries and byte lengths, naming the MAIN-owned destinations (D15) · print
// the proof (the handoff digest and both OIDs — the printed proof, not ledger fields: the closed
// observation key set carries no artifact digest, an ACCEPTED limitation, D11) · print the
// after-the-fold order (D9) · and append the observation ONLY when the prepared change set lies
// wholly inside the observation domain (D10) — a deletion, a rename's absent old side, a symlink,
// a submodule, a mode-only change, a path whose name is not valid UTF-8, and every other
// unrepresentable form are a NAMED non-record with exit 0, never a partial number. The numerator is
// the ATTESTED tree's blob bytes (git cat-file over the diff-tree entries' new OIDs, fail-closed on
// every answer) — never the disk, which an unstaged edit after the prepare moves silently. The
// attestation is REPEATED immediately before EITHER answer (the house pre-append idiom: it NARROWS
// the race window rather than closing it — this family defends against a buggy or interrupted
// producer, never a racing adversary). The fold itself stays orchestrator judgment: the rung
// delivers and claims nothing about whether it happened.
//
// Writer: appends only through the store's single legality door (appendDelegationRecord — D5, the
// store's refusals travel verbatim). Never commits; spawns git reads plus `git write-tree`, which
// may write a tree object into the odb and moves no ref — the same probe land itself uses. Every
// foreign path it prints renders control-byte-safe (displayValue / a hex form), because its output
// is read in a terminal. Dependency-free, Node >= 22. No CLI (dispatch.mjs owns the verb); no side
// effects on import.

import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { findSatelliteEntry, readSatelliteIdentity, WORKTREES_STOP } from './satellite-locator.mjs';
import { locateProvisionRecordSection, parseProvisionRecord, displayValue } from './worktrees-record.mjs';
import { readFileBytesNoFollow } from './fs-read-nofollow.mjs';
import { computeNumerator } from './dispatch-record.mjs';
import { resolveRepoRoot, formatRatio, buildObservationRecord } from './observation-builder.mjs';
import { appendDelegationRecord, DELEGATION_STORE_STOP } from './dispatch-store.mjs';
import { GIT_MAX_BUFFER } from './git-env.mjs';

// The worktrees slug grammar, repeated here so the CLI can refuse a malformed slug as USAGE before
// any probe echoes it — the locator's own refusal interpolates the slug into a terminal message.
export const HANDOFF_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// D9, doc-parity-bound into references/modes/worktrees.md: a fold is new code, so gates that ran
// before it attest a tree that no longer exists. The re-attestation is a COMMAND, not advice.
export const AFTER_FOLD_ORDER = 'a fold landed AFTER the gates leaves those gates STALE — the order is fold → re-stage (git add) → the configured review → run-gates --final (the receipt is minted over the CURRENT post-fold staged tree) → commit-guard --check (the final re-attestation) → the commit ask';

// The prepared change set rides the worktrees stream class (D9's taxonomy), and its provenance is
// self-reported by construction: the denominator is the handoff byte count, a number no wrapper
// proved — recorded, printed, and excluded from acceptance downstream.
const STEP_CLASS = 'worktree-stream';
const PROVENANCE = 'self-reported';
const REGULAR_MODES = new Set(['100644', '100755']);
const RECORD_HEADING = '## Provision record';

const defaultGit = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: GIT_MAX_BUFFER });
  return {
    status: r.error ? -1 : r.status,
    stdout: r.stdout ?? '',
    stderr: r.error ? String(r.error.message) : (r.stderr ?? ''),
  };
};

// The BYTES twin, for the one probe whose output can carry non-UTF-8 path names: a decoded split
// cannot be undone, so the diff-tree answer stays a Buffer until each token is proven decodable.
const defaultGitBuf = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, windowsHide: true, maxBuffer: GIT_MAX_BUFFER });
  return {
    status: r.error ? -1 : r.status,
    stdout: r.stdout ?? Buffer.alloc(0),
    stderr: r.error ? String(r.error.message) : String(r.stderr ?? ''),
  };
};

const stop = (message) => Object.assign(new Error(message), { code: WORKTREES_STOP });

const gitRead = (git, args, cwd, label) => {
  const r = git(args, cwd);
  if (r.status !== 0) throw stop(`${label}: ${(r.stderr || r.stdout).trim() || `git exited ${r.status}`}`);
  return r.stdout;
};

// The dispatch-side no-follow read outcome, mapped onto the leaf shape the locator's injected fs
// seam expects ({ bytes } | { absent } | { unsafe } | { error }). A MAPPING over the family reader,
// never a second read-door body — the one no-follow body stays fs-read-nofollow.mjs.
export const leafReadOutcome = (r) => {
  if (r.outcome === 'ok') return { bytes: r.bytes };
  if (r.outcome === 'absent') return { absent: true };
  if (r.outcome === 'foreign') return { unsafe: true };
  return { error: r.code };
};

const defaultFs = () => ({
  lstat: lstatSync,
  readdir: readdirSync,
  realpath: realpathSync,
  readFileNoFollow: (abs) => leafReadOutcome(readFileBytesNoFollow(abs)),
});

// NUL-split that keeps every segment and, on the Buffer lane, proves each token's decodability by
// a byte round-trip — a token that does not round-trip keeps its hex identity instead of a lossy
// string, so a non-UTF-8 path can neither alias another path nor forge a printed line.
const splitNul = (input) => {
  if (typeof input === 'string') return input.split('\0').map((text) => ({ text, ok: true, hex: null }));
  const out = [];
  let start = 0;
  for (let i = 0; i <= input.length; i += 1) {
    if (i !== input.length && input[i] !== 0) continue;
    const seg = input.subarray(start, i);
    const text = seg.toString('utf8');
    const ok = Buffer.from(text, 'utf8').equals(seg);
    out.push({ text, ok, hex: ok ? null : seg.toString('hex') });
    start = i + 1;
  }
  return out;
};

const shownToken = (t) => (t.ok ? displayValue(t.text) : `<non-UTF-8 path 0x${t.hex}>`);

// `git diff-tree -r -z -M` raw grammar, parsed STRICTLY: one meta token
// `:<oldmode> <newmode> <oldsha> <newsha> <status>`, then the path token — two path tokens (old,
// new) for a rename or copy. EVERY non-empty token outside that grammar REFUSES — a malformed
// colon-prefixed meta, a stray token where a meta belongs, and a missing or empty path token
// alike: a skipped entry would record a partial numerator in silence, which is the one outcome
// the fail-closed contract forbids. Only the empty tokens the -z terminator produces are skipped.
const META_RE = /^:([0-7]{5,6}) ([0-7]{5,6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z][0-9]*)$/;

export const parsePreparedChangeSet = (input) => {
  const tokens = splitNul(input);
  const entries = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.ok && t.text === '') continue;
    const m = t.ok ? t.text.match(META_RE) : null;
    if (m === null) {
      throw stop(`cannot parse the prepared change set — malformed diff-tree metadata: ${shownToken(t)}`);
    }
    const [, oldMode, newMode, oldSha, newSha, status] = m;
    const takePath = (what) => {
      const p = tokens[i + 1];
      if (p === undefined || (p.ok && p.text === '')) {
        throw stop(`cannot parse the prepared change set — missing path token (${what}) after ${displayValue(t.text)}`);
      }
      i += 1;
      return p;
    };
    if (status[0] === 'R' || status[0] === 'C') {
      const oldP = takePath('the rename/copy old side');
      const newP = takePath('the rename/copy new side');
      entries.push({
        oldMode, newMode, oldSha, newSha, status,
        oldPath: oldP.text, oldPathUtf8Ok: oldP.ok, oldPathDisplay: shownToken(oldP),
        path: newP.text, pathUtf8Ok: newP.ok, pathDisplay: shownToken(newP),
      });
    } else {
      const p = takePath('the entry path');
      entries.push({ oldMode, newMode, oldSha, newSha, status, path: p.text, pathUtf8Ok: p.ok, pathDisplay: shownToken(p) });
    }
  }
  return entries;
};

// D10 — the observation domain accepts only PRESENT REGULAR files, so every form without a
// measurable post-image is OUTSIDE it, each by its own name. A mode-only change is its own rule:
// it has no measurable byte change at all. A path whose NAME is not valid UTF-8 cannot be carried
// by the record's string domain, so it is out too. A regular BINARY file is INSIDE — its bytes are
// read like any other. `path` in the answer is always DISPLAY-SAFE; the raw path and the new blob
// OID ride only the inside answer, where the measurement needs them.
export const classifyPreparedEntry = (e) => {
  const shown = e.pathDisplay ?? displayValue(e.path);
  if (e.pathUtf8Ok === false || e.oldPathUtf8Ok === false) {
    return { inside: false, form: 'a path whose name is not valid UTF-8', path: e.pathUtf8Ok === false ? shown : e.oldPathDisplay };
  }
  if (e.status[0] === 'D') return { inside: false, form: 'a deletion', path: shown };
  if (e.status[0] === 'R') return { inside: false, form: "a rename's absent old side", path: e.oldPathDisplay ?? displayValue(e.oldPath) };
  if (e.newMode === '160000' || e.oldMode === '160000') return { inside: false, form: 'a submodule', path: shown };
  if (e.newMode === '120000' || e.oldMode === '120000') return { inside: false, form: 'a symlink', path: shown };
  if (e.status[0] === 'M' && e.oldSha === e.newSha) return { inside: false, form: 'a mode-only change', path: shown };
  if ((e.status[0] === 'A' || e.status[0] === 'M') && REGULAR_MODES.has(e.newMode)) {
    return { inside: true, path: e.path, sha: e.newSha, shown };
  }
  return { inside: false, form: `an unrepresentable form (git status ${e.status})`, path: shown };
};

// The numerator's byte source is the ATTESTED tree itself, and every cat-file answer is validated
// fail-closed: a missing object, a non-blob object and a non-numeric or unsafe size each refuse by
// name — a guessed size would put an unverifiable number into a record whose whole point is that
// its scope was attested.
const blobSize = (git, root, sha, shown) => {
  const type = gitRead(git, ['cat-file', '-t', sha], root, `cannot size the prepared blob ${sha} (${shown})`).trim();
  if (type !== 'blob') {
    throw stop(`the prepared change set entry ${shown} names object ${sha}, which is a ${type}, not a blob — the attested post-image is unmeasurable (fail closed); nothing was appended`);
  }
  const raw = gitRead(git, ['cat-file', '-s', sha], root, `cannot size the prepared blob ${sha} (${shown})`).trim();
  const size = Number(raw);
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(size)) {
    throw stop(`git cat-file -s answered "${displayValue(raw)}" for ${sha} (${shown}), which is not a byte count this record can carry (fail closed); nothing was appended`);
  }
  return size;
};

// One user-owned fragment, byte verbatim between its two boundary lines: the byte length on the
// opening boundary is what makes the delivery VERIFIABLE rather than asserted — a fragment can
// itself carry a line imitating a boundary, and the stated length pins where it really ends.
const fragmentBlock = (index, where, fragment) => [
  `--- fragment ${index}: ${where} — ${Buffer.byteLength(fragment)} bytes ---`,
  `${fragment}${fragment.endsWith('\n') || fragment === '' ? '' : '\n'}--- end fragment ${index} ---`,
].join('\n');

const refusal = (reason) => ({ code: 1, stdout: '', stderr: `dispatch handoff-return: ${reason}` });

// handoffReturn({ cwd, slug, waveId, planId, phase, env, now, deps }) → { code, stdout, stderr }.
// Exported so every branch is reachable in-process (D14); dispatch.mjs owns the flag surface.
export const handoffReturn = ({ cwd, slug, waveId, planId, phase, env = process.env, now = () => new Date().toISOString(), deps = {} }) => {
  const git = deps.git ?? defaultGit;
  const gitBuf = deps.gitBuf ?? defaultGitBuf;
  const fs = deps.fs ?? defaultFs();
  const readBytes = deps.readBytes ?? readFileBytesNoFollow;
  try {
    const root = resolveRepoRoot(cwd);
    if (root === null) return refusal('not inside a git work tree — the rung attests MAIN\'s index and HEAD, and there is neither here (fail closed); nothing was appended');
    // D8's MAIN-side guard, repeated from the worktrees lanes: two linked worktrees share one git
    // common dir, so run from a satellite this rung would attest the WRONG tree.
    const gitDir = gitRead(git, ['rev-parse', '--path-format=absolute', '--git-dir'], root, 'cannot resolve the git dir').trim();
    const commonDir = gitRead(git, ['rev-parse', '--path-format=absolute', '--git-common-dir'], root, 'cannot resolve the git common dir').trim();
    if (gitDir !== commonDir) {
      return refusal(`run this from the MAIN worktree: the git dir is not the git common dir (git dir ${gitDir}, common ${commonDir}), so this cwd is inside a linked worktree, where the shared common dir would let the rung attest the wrong tree; nothing was appended`);
    }
    const entry = findSatelliteEntry({ root, slug, branch: null, git, fs });
    const identity = readSatelliteIdentity({ entry, slug, fs });
    const raw = readBytes(identity.path);
    if (raw.outcome !== 'ok') {
      return refusal(`the handoff at ${displayValue(identity.path)} could not be read for delivery (${raw.outcome === 'error' ? raw.code : raw.outcome}) — a delivery is the raw bytes or nothing (fail closed); nothing was appended`);
    }
    // ONE byte source: the record the proof attests is RE-PARSED from the very bytes the delivery
    // prints and the digest binds — the identity read (which proved slug/branch/uniqueness) stays
    // the locator's, and a handoff swapped between the two reads refuses here by the disagreement.
    const text = raw.bytes.toString('utf8');
    const record = parseProvisionRecord(text);
    if (record.slug !== slug || record.branch !== identity.branch) {
      return refusal(`the delivered bytes disagree with the proven identity — the delivery read parsed slug ${record.slug === null ? '(missing)' : displayValue(record.slug)} and branch ${record.branch === null ? '(missing)' : displayValue(record.branch)}, while the identity read proved slug ${slug} on branch ${displayValue(identity.branch)}; the handoff changed between the two reads (fail closed); nothing was appended`);
    }
    if (record.prepared === null) {
      return refusal(`the handoff record for "${slug}" carries no prepared-tree — nothing has been landed onto MAIN yet: run land --prepare from MAIN first; nothing was appended`);
    }
    if (record.preparedHead === null) {
      return refusal(`the handoff record for "${slug}" carries no prepared-head (a record written by an earlier kit records only the prepared tree) — re-run land --prepare, which records MAIN's HEAD beside prepared-tree; nothing was appended`);
    }
    const stagedTree = gitRead(git, ['write-tree'], root, 'git write-tree failed').trim();
    if (stagedTree !== record.prepared) {
      return refusal(`the staged write-tree ${stagedTree} does not equal the recorded prepared-tree ${record.prepared} — MAIN's index moved since land --prepare, so the prepared change set on record is not the one in front of this rung: re-run land --prepare; nothing was appended`);
    }
    const liveHead = gitRead(git, ['rev-parse', 'HEAD'], root, 'cannot resolve MAIN HEAD').trim();
    if (liveHead !== record.preparedHead) {
      return refusal(`MAIN's HEAD ${liveHead} is not the recorded prepared-head ${record.preparedHead}, even though the staged write-tree still matches — a clean post-commit index reproduces the committed tree, so the prepared change set was already committed and there is nothing left to attest; a new landing takes a fresh land --prepare; nothing was appended`);
    }
    // The final re-attestation, run immediately before EITHER answer: the derivation between the
    // first attestation and the answer reads the index and HEAD again, so the answer's proof must
    // be re-established at the last moment — the house pre-append idiom, which NARROWS the window
    // rather than closing it. Tree and HEAD refuse separately, so the operator knows what moved.
    const finalAttest = () => {
      // Its OWN probe failures are late refusals too: they answer through the same string lane the
      // drift does, so the caller's withDelivery keeps the round-3 contract on this arm as well —
      // an unanswerable re-attestation loses the proof, never the delivery.
      try {
        const tree = gitRead(git, ['write-tree'], root, 'git write-tree failed').trim();
        if (tree !== record.prepared) {
          return `MAIN's staged write-tree moved while the return was being computed (${record.prepared} → ${tree}) — the delivered proof would be stale; settle MAIN and re-run; nothing was appended`;
        }
        const head = gitRead(git, ['rev-parse', 'HEAD'], root, 'cannot resolve MAIN HEAD').trim();
        if (head !== record.preparedHead) {
          return `MAIN's HEAD moved while the return was being computed (${record.preparedHead} → ${head}) — the delivered proof would be stale; nothing was appended`;
        }
        return null;
      } catch (err) {
        if (err?.code !== WORKTREES_STOP) throw err;
        return err.message;
      }
    };
    // Delivery (D15): everything outside the `## Provision record` section is user-owned — the
    // same boundary the record refresh preserves, located on the same fatally-decoded text the
    // record was parsed from (the reader refuses invalid UTF-8, so string slicing is byte-faithful).
    // The delivery is a FACT the moment the attested handoff bytes are in hand: every later refusal
    // — a diff-tree failure, a parser or cat-file refusal, a re-attestation drift — keeps it on
    // stdout, because erasing the return channel over a measurement failure would invert the rung's
    // own order (deliver → prove → count). The PROOF line, by contrast, prints only after the FINAL
    // re-attestation has held: it claims "attested" and "unchanged", and printed any earlier the
    // claim could be stale.
    const section = locateProvisionRecordSection(text);
    const delivery = [
      `dispatch handoff-return: satellite "${slug}" at ${displayValue(entry.path)} · handoff ${displayValue(identity.path)}`,
      `delivery — the user-owned handoff content, byte verbatim (everything outside "${RECORD_HEADING}"):`,
      fragmentBlock(1, `before "${RECORD_HEADING}"`, text.slice(0, section.start)),
      fragmentBlock(2, `after the "${RECORD_HEADING}" section`, text.slice(section.end)),
      'destinations (MAIN-owned): findings → docs/plans/queue.md · decisions and session records → the docs/ai records. The fold stays orchestrator judgment — this rung delivers and claims nothing about whether it happened.',
    ];
    const withDelivery = (reason) => ({ code: 1, stdout: delivery.join('\n'), stderr: `dispatch handoff-return: ${reason}` });
    const proofLines = [
      `proof — handoff sha256 ${createHash('sha256').update(raw.bytes).digest('hex')} over ${raw.bytes.length} bytes · prepared-tree ${record.prepared} = the staged write-tree (attested) · prepared-head ${record.preparedHead} = MAIN HEAD (unchanged)`,
      `next: ${AFTER_FOLD_ORDER}`,
    ];
    // D10: the change set is classified WHOLE before anything is measured — no partial scope is
    // ever recorded, and the first out-of-domain form names the non-record.
    let classified;
    let numerator = null;
    try {
      const answered = gitBuf(['diff-tree', '-r', '-z', '-M', record.preparedHead, record.prepared], root);
      if (answered.status !== 0) {
        return withDelivery(`cannot enumerate the prepared change set: ${answered.stderr.trim() || `git exited ${answered.status}`}; nothing was appended`);
      }
      classified = parsePreparedChangeSet(answered.stdout).map(classifyPreparedEntry);
      if (classified.every((c) => c.inside)) {
        const computed = computeNumerator(classified.map((c) => ({
          kind: 'new', path: c.path, objectId: c.path, postImageBytes: blobSize(git, root, c.sha, c.shown),
        })));
        if (!computed.ok) return withDelivery(`${computed.reason}; nothing was appended`);
        numerator = computed;
      }
    } catch (err) {
      if (err?.code !== WORKTREES_STOP) throw err;
      return withDelivery(err.message);
    }
    const outside = classified.find((c) => !c.inside);
    if (outside !== undefined) {
      const drifted = finalAttest();
      if (drifted !== null) return withDelivery(drifted);
      return {
        code: 0,
        stdout: [...delivery, ...proofLines, `observation: NOT RECORDED — ${outside.form} at ${outside.path} is outside the observation domain`].join('\n'),
        stderr: '',
      };
    }
    const observation = buildObservationRecord({
      waveId,
      stepClass: STEP_CLASS,
      measured: { numeratorBytes: numerator.numeratorBytes, components: numerator.components, scope: JSON.stringify(classified.map((c) => c.path)) },
      provenance: PROVENANCE,
      denominatorBytes: raw.bytes.length,
      planId,
      phase,
      timestamp: now(),
    });
    const drifted = finalAttest();
    if (drifted !== null) return withDelivery(drifted);
    // The single legality door (D5): a store refusal travels verbatim, with the delivery and the
    // proof above already printed — the observation failed to land, the return did not.
    try {
      const { writtenPath } = appendDelegationRecord({ cwd: root, record: observation, env });
      const objects = new Set(observation.metric.components.map((c) => c.objectId)).size;
      return {
        code: 0,
        stdout: [...delivery, ...proofLines, `observation: RECORDED — ${PROVENANCE} · class ${STEP_CLASS} · plan ${planId} phase ${phase} · ${formatRatio(observation.metric)} · ${objects} object(s) · scope ${displayValue(observation.scope)} → ${displayValue(writtenPath)}`].join('\n'),
        stderr: '',
      };
    } catch (err) {
      if (err?.code !== DELEGATION_STORE_STOP) throw err;
      return { code: 1, stdout: [...delivery, ...proofLines].join('\n'), stderr: `dispatch handoff-return: ${err.message}` };
    }
  } catch (err) {
    return refusal(err?.message ?? String(err));
  }
};
