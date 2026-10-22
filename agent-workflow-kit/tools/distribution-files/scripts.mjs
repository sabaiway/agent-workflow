// scripts.mjs — the upgrade's `scripts` op: every kit script of a deployment, the hook installer set
// included, kept current by the one rule. Each family file is surveyed by proof before any write:
// absent, current, prior (a body SCRIPT_PRIORS catalogs for its name) or edited. A prior is refreshed
// with no yes and a current one left; an absent or an edited one is a replace entry the one block names
// (replace-set.mjs), placed, or kept aside and replaced, only under the replace the user's yes starts.
// The installer set is written first; on an older ADR layout the decisions group is held back, the
// migration named. It never imports ensure-specs.mjs or ensure-configs.mjs: the CLI composes this op
// from the module's index, and ensure-specs.mjs takes its channel from there.
//
// Dependency-free, Node >= 22. Every fs primitive is injectable (deps.*). No side effects on import.

import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lstatNoFollow, writeContainedFileAtomic, writeProjectFileCreateOnly } from '../atomic-write.mjs';
import { composeFailure, composeOutcome, nodeEvidenceRefusal, probeSeedTarget, tmpNote } from '../ensure-ops.mjs';
import { surveyAdrLayoutStrict } from '../family-registry.mjs';
import { BUNDLED_SCRIPT_NAMES } from '../node-evidence.mjs';
import { CHECKER_PAIR, INSTALLER_SET, READER_PAIR, SCRIPT_PRIORS, classifyDeployedScript, digestOf } from '../script-priors.mjs';
import { keptAsidePath } from './kept-aside.mjs';

const OP = 'scripts';
const SCRIPTS_DIR = 'scripts';
const BUNDLED = ['references', 'scripts'];
// Where an edit meant to last goes: the installer's in the local hook file, every other file's beside it.
export const SCRIPT_CHANNEL = 'a script or suite of your own under its own name in scripts/, or a config the script reads';
export const LOCAL_HOOK_CHANNEL = 'the local hook file scripts/pre-commit.local, which the commit hook runs first';
// The family files whose bytes import or read archive-decisions.mjs, plus that file (the suite derives it).
export const DECISIONS_GROUP = Object.freeze(['archive-decisions.mjs', 'archive-decisions.test.mjs', 'archiver-structure.test.mjs']);
const OLD_ADR_LAYOUTS = new Set(['old', 'old-unrotated']);
const PAIRS = new Set([...READER_PAIR, ...CHECKER_PAIR]);
// The family in write order: the installer set, then every other bundled name in code-unit order.
const FAMILY = Object.freeze([...INSTALLER_SET, ...BUNDLED_SCRIPT_NAMES.filter((name) => !PAIRS.has(name) && !INSTALLER_SET.includes(name)).sort()]);

const causeOf = (err) => String((err && err.message) || err);
const relOf = (name) => `${SCRIPTS_DIR}/${name}`;
const kindOfDir = (st) => (st.isSymbolicLink() ? 'a symlink' : st.isFile() ? 'a regular file' : 'not a directory');
const wrongKind = (rel, kind) => composeFailure(OP, 'wrong-node-kind', `${rel}: exists but is ${kind} — nothing was read or written; resolve it by hand, then re-run`);

// ── the survey: the component first, then every family file by proof, nothing written ────────────

// → { refusal } | { notPlaced } | { files, layout, layoutError }. A family path of another node kind is
// judged before the component, so a linked family file never reads as not-placed.
const survey = ({ cwd, kitRoot, deps, read, lstat }) => {
  const dir = lstatNoFollow(join(cwd, SCRIPTS_DIR), lstat);
  if (dir === null) return { notPlaced: true };
  if (!dir.isDirectory() || dir.isSymbolicLink()) return { refusal: wrongKind(`${SCRIPTS_DIR}/`, kindOfDir(dir)) };
  const probes = FAMILY.map((name) => ({ name, rel: relOf(name), probe: probeSeedTarget(join(cwd, SCRIPTS_DIR, name), lstat) }));
  const wrong = probes.find((f) => f.probe.wrongKind);
  if (wrong) return { refusal: wrongKind(wrong.rel, wrong.probe.wrongKind) };
  if (!probes.some((f) => f.probe.present)) return { notPlaced: true };
  const files = [];
  for (const { name, rel, probe } of probes) {
    let bundle;
    try {
      bundle = read(join(kitRoot, ...BUNDLED, name));
    } catch (err) {
      return { refusal: composeFailure(OP, 'bundle-unreadable', `${rel}: the bundled script could not be read, so nothing was written — reinstall the kit. ${causeOf(err)}`) };
    }
    const bytes = probe.present ? read(join(cwd, rel)) : undefined;
    files.push({ name, rel, bundle, bytes, state: probe.present ? classifyDeployedScript(bytes, name, bundle, deps.priors ?? SCRIPT_PRIORS) : 'absent' });
  }
  try {
    return { files, layout: surveyAdrLayoutStrict(cwd, deps) };
  } catch (err) {
    return { files, layoutError: causeOf(err) };
  }
};

const entryOf = (f) => ({
  rel: f.rel,
  ...(f.state === 'absent' ? { absent: true } : { sha256: digestOf(f.bytes), bytes: f.bytes }),
  channel: f.name === INSTALLER_SET[0] ? LOCAL_HOOK_CHANNEL : SCRIPT_CHANNEL,
  hookRun: true,
});

// ── the lines (composed from what HAPPENED: each file's state and the fate of its write) ─────────

// A fate is `written`, `stood` (a bound absent file that appeared with the bundled body), `refused`
// (its write failed), or none: the run stopped before it, or, dry, would write it.
const PRIOR_FATES = { written: 'refreshed to the bundled one', refused: 'not refreshed; its write was refused (above)' };
const EDITED = "differs from every body this kit knows it shipped — left as it stands until the user's yes keeps it aside and replaces it (the block below)";
const ABSENT = "absent — the user's yes places the bundled body (the block below)";
const WAITS = "left as it stands; the user's yes is asked once the ADR-store layout reads";
const fileLine = (f, fate, { dryRun, keptOf }) => {
  if (f.state === 'prior') return `${f.rel}: matches a body an earlier release shipped — ${PRIOR_FATES[fate] ?? (dryRun ? 'would be refreshed to the bundled one' : 'not refreshed; the run stopped before it')}`;
  if (!keptOf) return `${f.rel}: ${f.state === 'absent' ? ABSENT : EDITED}`;
  if (f.state === 'absent') return `${f.rel}: ${{ written: "placed from the bundled scripts on the user's yes", stood: 'appeared while this run was placing it — the bundled body stands, nothing written' }[fate] ?? 'absent — not placed'}`;
  const kept = keptOf(f.rel);
  return `${f.rel}: ${fate === 'written' ? `carried an edit — kept aside at ${kept}, then replaced by the bundled body on the user's yes` : `carries an edit — not replaced${kept ? `; its copy kept aside at ${kept} stays` : ''}`}`;
};
const heldLine = (layout) => `${SCRIPTS_DIR}/: ${DECISIONS_GROUP.slice(0, -1).join(', ')} and ${DECISIONS_GROUP.at(-1)} are held back while this project is on the older ADR layout (${layout}) — run the opt-in /agent-workflow-kit migrate-adr-store (it previews, and never commits); the next upgrade judges them`;
const partialNote = (count) => (count > 0 ? [`the writes stopped PARTWAY — the ${count} file(s) named above were already written and are NOT rolled back`] : []);

// ── the writes ────────────────────────────────────────────────────────────────────────────────────

// One write per file in write order: a prior refreshed, a bound edit rewritten after its bytes are
// re-proven, a bound absent file written create-only. → { fates, notes, failure? }
const writeAll = ({ cwd, files, deps, read, bound }) => {
  const fates = new Map();
  const notes = [];
  for (const f of files) {
    if (f.state === 'custom' && digestOf(read(join(cwd, f.rel))) !== bound.get(f.rel)) {
      return { fates, notes, failure: ['race-unresolved', `${f.rel}: changed after this run read it — left as it stands and nothing further written`] };
    }
    let result;
    try {
      result = f.state === 'absent'
        ? writeProjectFileCreateOnly(cwd, f.rel, f.bundle, deps, { noun: 'a kit script' })
        : writeContainedFileAtomic(cwd, join(cwd, f.rel), f.bundle, deps, { label: f.rel });
    } catch (err) {
      fates.set(f.rel, 'refused');
      return { fates, notes, failure: ['write-refused', `${f.rel}: ${causeOf(err)}`] };
    }
    notes.push(...tmpNote(f.rel, result.tmpLeftBehind));
    if (f.state === 'absent' && !result.created) {
      if (classifyDeployedScript(read(join(cwd, f.rel)), f.name, f.bundle) !== 'current') {
        return { fates, notes, failure: ['race-unresolved', `${f.rel}: appeared while this run was placing it and does not carry the bundled body — nothing further written, re-run when the tree is settled`] };
      }
      fates.set(f.rel, 'stood');
    } else fates.set(f.rel, 'written');
  }
  return { fates, notes };
};

// Under the replace the op's own survey must yield exactly the entries the yes bound.
const sameEntries = (own, bound) =>
  own.length === bound.length && own.every((e) => bound.some((b) => b.rel === e.rel && Boolean(b.absent) === Boolean(e.absent) && (e.absent || b.sha256 === e.sha256)));

// ── the unreadable layout: the installer set alone kept current, the op failed with no entry ─────

const layoutRefusal = ({ cwd, files, layoutError, dryRun, deps, read }) => {
  const set = files.filter((f) => INSTALLER_SET.includes(f.name) && f.state !== 'current');
  const priors = set.filter((f) => f.state === 'prior');
  const { fates, notes, failure } = dryRun ? { fates: new Map(), notes: [] } : writeAll({ cwd, files: priors, deps, read });
  const lines = set.map((f) => (f.state === 'prior' ? fileLine(f, fates.get(f.rel), { dryRun }) : `${f.rel}: ${WAITS}`));
  const written = [...fates.values()].filter((fate) => fate === 'written').length;
  if (failure) return composeFailure(OP, failure[0], failure[1], ...lines, ...notes, ...partialNote(written));
  return composeFailure(OP, 'adr-layout-unverifiable', `${SCRIPTS_DIR}/: the ADR-store layout could not be read (${layoutError}), so the other kit scripts wait for the layout`, ...lines, ...notes);
};

// ── the op ────────────────────────────────────────────────────────────────────────────────────────

export const ensureScripts = ({ cwd, kitRoot, dryRun = false, deps = {}, replace }) => {
  const lstat = deps.lstat ?? lstatSync;
  const read = deps.readFile ?? readFileSync;
  const refusal = nodeEvidenceRefusal(OP, cwd, lstat);
  if (refusal) return refusal;
  const found = survey({ cwd, kitRoot, deps, read, lstat });
  if (found.refusal) return found.refusal;
  if (found.notPlaced) return composeOutcome(OP, 'not-placed', [`${SCRIPTS_DIR}/: no kit script stands in it, so none is placed`], false);
  if (found.layoutError !== undefined) return layoutRefusal({ cwd, ...found, dryRun, deps, read });

  // The survey completed: its entries ride every outcome from here on, a failed one included.
  const held = OLD_ADR_LAYOUTS.has(found.layout);
  const live = found.files.filter((f) => !(held && DECISIONS_GROUP.includes(f.name)));
  const entries = live.filter((f) => f.state === 'absent' || f.state === 'custom').map(entryOf);
  const bound = replace ? new Map(replace.entries.map((e) => [e.rel, e.sha256])) : null;
  const keptOf = bound && ((rel) => (bound.get(rel) ? keptAsidePath(replace.digest, rel) : ''));
  const linesOf = (fates) => [
    ...live.filter((f) => f.state !== 'current').map((f) => fileLine(f, fates.get(f.rel), { dryRun, keptOf })),
    ...(live.some((f) => f.state === 'current') ? [`${SCRIPTS_DIR}/: ${live.filter((f) => f.state === 'current').length} other kit scripts are already the bundled body — nothing written`] : []),
    ...(held ? [heldLine(found.layout)] : []),
  ];
  const ok = (token, lines) => ({ ...composeOutcome(OP, token, lines, false), entries });
  const loud = (cause, ...lines) => ({ ...composeFailure(OP, cause, ...lines), entries });
  if (bound && !sameEntries(entries, replace.entries)) {
    return loud('race-unresolved', 'the kit scripts to place or replace are not the set the yes was given for (another set or other bytes), so nothing was written', ...linesOf(new Map()));
  }
  const due = live.filter((f) => f.state === 'prior' || (bound && (f.state === 'custom' || f.state === 'absent')));
  const tokenOf = (fates) => {
    const landed = (state) => due.some((f) => f.state === state && fates.get(f.rel) === 'written');
    if (held) return 'old-adr-layout-migration-instructed';
    if (!bound && entries.length > 0) return 'pending';
    if (landed('absent')) return 'seeded';
    if (dryRun ? due.length > 0 : landed('prior') || landed('custom')) return dryRun ? 'would-refresh' : 'refreshed';
    return 'already-present';
  };
  if (dryRun) return ok(tokenOf(new Map()), linesOf(new Map()));
  const { fates, notes, failure } = writeAll({ cwd, files: due, deps, read, bound });
  if (failure) {
    const written = [...fates.values()].filter((fate) => fate === 'written').length;
    return loud(failure[0], failure[1], ...linesOf(fates), ...notes, ...partialNote(written));
  }
  return ok(tokenOf(fates), [...linesOf(fates), ...notes]);
};
