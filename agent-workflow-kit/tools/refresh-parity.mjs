// refresh-parity.mjs — the ONE bundle↔placed comparison walk, plus the POST-FAILURE parity reading
// of its result (feedback-hardening Plan 1 F3 / D3+D4).
//
// Two callers read the SAME walk for two different questions, so there is exactly one scanner:
//   • the refresh itself asks "what did my overwrite replace?" — it scans BEFORE copying, and an
//     absent placed file is a pure ADD (nothing local to lose), so it is not reported;
//   • the read-only degrade asks "does the placed tree still MATCH the bundle?" — it scans AFTER the
//     write was refused, and an absent placed file is exactly the drift a writable rerun repairs.
// The walk therefore reports FOUR buckets (drifted / unreadable / absent / conflicts) and each
// caller decides what they mean. A second scanner would be a second definition of "the same".
//
// Why the honesty bar (D4): the read-only skip line used to claim, unconditionally, that the tree
// "may be PARTIALLY updated" and that "any remaining drift persists" — two claims about post-state
// that nothing had checked. Every clause a line here composes binds to a state PROVEN this run: the
// verdict is computed from a real re-scan, and anything the re-scan could not read WITHHOLDS the calm
// claim (reported as could-not-verify) instead of being rendered as clean.
//
// The wrapper axis is part of the claim on purpose: the degrade returns before the caller's
// linkWrappers step, so a "nothing to repair" that only looked at files would be an unproven claim
// about a reconcile that never ran.
//
// Pure of process state and of the kit's own writers — a LEAF (fs is injected, nothing is imported
// from the caller). Read-only: never writes, never spawns. Dependency-free, Node >= 22.

import { join, resolve, relative, dirname, isAbsolute, sep } from 'node:path';

// The CLOSED parity verdict vocabulary — the three states the read-only skip line may report.
// doc-parity binds every value into the setup + upgrade mode contracts, so a doc that drops or
// renames an outcome fails a declared gate instead of describing a verdict the tool never emits.
export const PARITY = Object.freeze({
  clean: 'clean-parity',
  drifted: 'drifted',
  unverifiable: 'unverifiable',
});

// The recovery every read-only outcome points at: the in-session `setup` would hit the same read-only
// dir, so the only real repair is a writable session. Shared by the skip line and the (unchanged)
// version-behind failure line, so the two can never drift apart.
export const READONLY_RERUN_HINT = 're-run the refresh from a writable session (e.g. outside the read-only sandbox)';

// The mode a managed wrapper source carries — the ONE definition, imported by the link step that
// chmods it and by the parity check that reads it back. "Executable enough" is not parity: a rerun
// sets exactly this, so any other mode is a state the rerun would change.
export const WRAPPER_MODE = 0o755;

// lstat NO-FOLLOW, classified: the Stats object | 'absent' (ENOENT) | 'error' (any other fs failure).
// Never reads THROUGH the node — a symlinked placed path is a "could not compare", never a read of
// whatever it points at.
const probe = (path, fs) => {
  try {
    return fs.lstat(path);
  } catch (err) {
    return err && err.code === 'ENOENT' ? 'absent' : 'error';
  }
};

// The reconcile-set walk: every bundle-owned node, classified by WHAT THE REFRESH COULD DO TO IT —
// not by whether this scanner could read it. The distinction is the whole point: "I could not compare
// this" and "the refresh cannot bring this to the required state" are different facts with different
// recoveries, and the earlier shape collapsed them.
//
// The writer's own policy decides the partition. copyTreeRefresh guards EVERY dest through
// assertContainedRealPath, whose walk includes the LEAF — so any placed symlink on a node in the
// reconcile-set is refused before the copy dispatch is even reached. Past that guard: a bundled
// symlink is ADDITIVE (created when the dest is absent, otherwise left alone — an explicit no-op, not
// a comparison), a bundled directory is mkdir -p (EEXIST over a file), a bundled file is copyFile
// (EISDIR over a directory; a device or FIFO may be WRITTEN INTO or block rather than be replaced).
// The BUNDLE read is our own shipped artifact — a failure there is a loud corrupt-kit error upstream
// (never swallowed here); only the PLACED read is caught. Buckets, each sorted:
//   drifted    — placed bytes differ from the bundle; a rerun overwrites them
//   absent     — the bundle ships it and the placed tree does not; a rerun creates it
//   conflicts  — a rerun cannot be GUARANTEED to converge this node under the writer's no-follow /
//                ownership policy (any placed symlink; an incompatible shape). Labeled with the cause
//   unreadable — a genuine read/stat error, and nothing else
// Plus `modes`: the placed mode of every node the walk actually reached as a regular file. It exists
// so the wrapper axis can judge a source's mode WITHOUT a second lstat of its own — a separate stat
// could traverse a symlinked ancestor this walk already refused, and produce a contradicting verdict.
export const scanBundleOwnedDrift = (bundleDir, skillDir, fs) => {
  const drifted = [];
  const unreadable = [];
  const absent = [];
  const conflicts = [];
  const modes = new Map();
  const refuse = (rel, cause) => conflicts.push(`${rel} (${cause})`);
  const walk = (rel) => {
    const src = join(bundleDir, rel);
    const dest = join(skillDir, rel);
    const st = fs.lstat(src);
    const placed = rel === '' ? null : probe(dest, fs);
    // The skill dir itself (rel '') is the caller's own inspected root — it proved that node is a real
    // directory before any of this ran. Every node BELOW it meets the containment guard first, and the
    // guard refuses a symlink at the leaf just as it does at an ancestor.
    if (placed === 'error') {
      unreadable.push(rel);
      return;
    }
    if (placed !== null && placed !== 'absent' && placed.isSymbolicLink()) {
      refuse(rel, 'a symlink is in the way');
      return;
    }
    if (st.isSymbolicLink()) {
      // ADDITIVE by contract: created when absent, otherwise left alone WITHOUT comparison. A node
      // left alone is outside every claim this scan makes — it is neither drift nor a finding.
      if (placed === 'absent') absent.push(rel);
      return;
    }
    if (st.isDirectory()) {
      if (placed !== null && placed !== 'absent' && !placed.isDirectory()) {
        refuse(rel, 'a non-directory is in the way');
        return;
      }
      const entries = fs.readdir(src);
      // An EMPTY bundled dir names nothing below it, so its absence would go unreported — record the
      // dir itself. A NON-empty one is already named by its children; recording it too would
      // double-report one absence.
      if (placed === 'absent' && entries.length === 0) absent.push(rel);
      for (const entry of entries) walk(rel ? join(rel, entry) : entry);
      return;
    }
    if (placed === 'absent') {
      absent.push(rel);
      return;
    }
    if (!placed.isFile()) {
      refuse(rel, 'a node of the wrong kind is in the way');
      return;
    }
    if (typeof placed.mode === 'number') modes.set(rel, placed.mode);
    const srcBytes = fs.readFile(src);
    const destBytes = (() => {
      try {
        return fs.readFile(dest);
      } catch {
        unreadable.push(rel);
        return null;
      }
    })();
    if (destBytes === null) return;
    if (!Buffer.from(srcBytes).equals(Buffer.from(destBytes))) drifted.push(rel);
  };
  walk('');
  return {
    drifted: drifted.sort(), unreadable: unreadable.sort(), absent: absent.sort(), conflicts: conflicts.sort(), modes,
  };
};

// A wrapper has TWO axes the link step touches — the LINK, which lives outside the bundle tree, and
// the SOURCE, which does not. Each outcome is `null` (nothing to say) or a `[bucketName, cause]`
// tuple the caller files under that bucket, labeled by axis: a wrapper broken on one axis and
// unknown on the other rides BOTH lists rather than losing a fact the re-scan proved.
const WRAPPER_CLEAN = null;

// The link: absent is repairable (the link step creates it); anything else standing there is a
// refusal (linkManaged replaces ONLY a symlink already pointing at our source). Never follows a
// foreign link — readlink, then a string compare against the SAME physical base the writer uses:
// linkWrappers canonicalises the bindir through realpath before linking, so a relative target read
// from a symlinked bindir must resolve against the real directory or the two would disagree. A
// realpath failure is could-not-verify with NO lexical fallback — falling back could call a foreign
// link ours.
const wrapperDstOutcome = (link, fs) => {
  const dstStat = probe(link.dst, fs);
  if (dstStat === 'error') return ['unverifiable', 'its link could not be read'];
  if (dstStat === 'absent') return ['drifted', 'not linked'];
  if (!dstStat.isSymbolicLink()) return ['conflicts', 'a non-symlink is in the way'];
  let target;
  try {
    target = fs.readlink(link.dst);
  } catch {
    return ['unverifiable', 'its link target could not be read'];
  }
  let resolved;
  if (isAbsolute(target)) resolved = target;
  else {
    try {
      resolved = resolve(fs.realpath(dirname(link.dst)), target);
    } catch {
      return ['unverifiable', 'its link directory could not be resolved'];
    }
  }
  return resolved === resolve(link.source) ? WRAPPER_CLEAN : ['conflicts', 'a foreign symlink is in the way'];
};

// The source is a BUNDLE-OWNED file (deriveLinks resolves it inside the skill dir and planFor proves
// the bundle ships it), so the reconcile-set walk already classified its existence and its shape and
// already named it if anything was wrong. This axis therefore owns exactly ONE fact the walk does not
// compare: the mode. A node the walk never reached — absent, refused, or unreadable — yields nothing
// here, so one broken file is never reported twice under two different names.
const wrapperSourceOutcome = (link, skillDir, modes) => {
  const rel = relative(skillDir, link.source).split(sep).join('/');
  if (!modes.has(rel)) return WRAPPER_CLEAN;
  return (modes.get(rel) & 0o7777) === WRAPPER_MODE ? WRAPPER_CLEAN : ['drifted', 'its source mode differs'];
};

export const scanWrapperParity = (links, fs, { skillDir, modes }) => {
  const out = { drifted: [], conflicts: [], unverifiable: [] };
  for (const link of links ?? []) {
    for (const outcome of [wrapperDstOutcome(link, fs), wrapperSourceOutcome(link, skillDir, modes)]) {
      if (outcome === WRAPPER_CLEAN) continue;
      const [bucket, cause] = outcome;
      out[bucket].push(`wrapper ${link.cmd} (${cause})`);
    }
  }
  return { drifted: out.drifted.sort(), conflicts: out.conflicts.sort(), unverifiable: out.unverifiable.sort() };
};

// The ONE verdict the line is composed from. `clean-parity` requires EVERY list empty — any node the
// re-scan could not compare withholds the calm claim rather than being counted as equal. `drifted` is
// the headline whenever something is provably wrong (repairable or refused): a proven break outranks
// an unknown, and the line still names every list, so no proven fact is collapsed into another.
export const parityVerdict = ({ scan, wrappers }) => {
  const drifted = [...scan.drifted, ...scan.absent, ...wrappers.drifted].sort();
  const conflicts = [...scan.conflicts, ...wrappers.conflicts].sort();
  const unverifiable = [...scan.unreadable, ...wrappers.unverifiable].sort();
  const broken = drifted.length > 0 || conflicts.length > 0;
  const state = broken ? PARITY.drifted : unverifiable.length > 0 ? PARITY.unverifiable : PARITY.clean;
  return { state, drifted, conflicts, unverifiable };
};

// The verdict a caller reports when the re-scan itself could not run (a corrupt/unreadable bundle,
// any fs failure raised out of the walk). Could-not-verify is the honest floor — never a false clean.
export const unverifiableParity = (item) => ({ state: PARITY.unverifiable, drifted: [], conflicts: [], unverifiable: [item] });

const count = (items) => `${items.length} item(s)`;

// The read-only skip line (outcome `skipped-readonly`, exit 0 — the stated skip). Two clauses are
// proven by the caller before it composes: the versions are KNOWN equal, and the failure was tagged
// at a WRITE boundary. Every remaining clause comes from the verdict — no clause without its check,
// and every item the verdict carries is NAMED (a count alone would not tell the user what to look at).
export const readonlySkipLine = (name, version, verdict) => {
  const head = `  ${name}: already current${version ? ` (v${version})` : ''} — the file re-sync could not write: ` +
    'the skills directory is read-only this session.';
  if (verdict.state === PARITY.clean) {
    // The claim is scoped to what the refresh MANAGES, and it names each checked axis rather than
    // generalising: a rerun would still rewrite byte-equal files (so "nothing would change" would be
    // false), a placed-only extra is preserved and never in scope, and an additive node the writer
    // leaves alone is outside the comparison by contract.
    return `${head} A read-only re-scan found no refresh-managed difference to repair: every file the ` +
      'refresh would overwrite already matches, every node it would add is present, and every wrapper ' +
      'link and source mode is in place.';
  }
  // One sentence per non-empty list, each carrying the recovery that actually applies to it: the
  // writable rerun REPAIRS the drifted set, and REFUSES the conflicting set — one blanket "re-run to
  // repair" over both would promise a repair that never happens.
  const said = [];
  if (verdict.drifted.length > 0) {
    said.push(`A read-only re-scan found ${count(verdict.drifted)} still differing from the bundled copy: ` +
      `${verdict.drifted.join(', ')} — ${READONLY_RERUN_HINT} to repair.`);
  }
  if (verdict.conflicts.length > 0) {
    said.push(`${said.length > 0 ? 'It also found' : 'A read-only re-scan found'} ${count(verdict.conflicts)} a ` +
      `writable rerun would REFUSE rather than repair: ${verdict.conflicts.join(', ')} — resolve each by hand, ` +
      'then re-run the refresh.');
  }
  if (verdict.unverifiable.length > 0) {
    // The unknown-need clause and its recovery ride EVERY unverifiable outcome, not only the one
    // that happens to open the line: a reader who already saw a drift sentence would otherwise be
    // left with a list of names and no statement of what is unknown about them or what to do.
    const lead = said.length > 0 ? 'It could not verify a further' : 'A read-only re-scan could NOT verify';
    said.push(`${lead} ${count(verdict.unverifiable)}: ${verdict.unverifiable.join(', ')} — whether those ` +
      `still need repair is unknown; ${READONLY_RERUN_HINT}.`);
  }
  return `${head} ${said.join(' ')}`;
};
