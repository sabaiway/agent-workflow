// scripts.mjs — the upgrade's `scripts` op: every kit script of a deployment, the hook installer set
// included, kept current by the one rule. Each family file is surveyed by proof before any write:
// absent, current, prior (a body SCRIPT_PRIORS catalogs for its name) or edited. On every plain run a
// prior is refreshed, an edited one replaced in place and an absent one placed create-only, with no
// question and no copy kept; a current one is left. The installer set is written first; on an older
// ADR layout the decisions group is held back, the migration named. It never imports ensure-specs.mjs
// or ensure-configs.mjs: the CLI composes this op from the module's index, and ensure-specs.mjs takes
// its channel from there.
//
// Dependency-free, Node >= 22. Every fs primitive is injectable (deps.*). No side effects on import.

import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lstatNoFollow, writeContainedFileAtomic, writeProjectFileCreateOnly } from '../atomic-write.mjs';
import { composeFailure, composeOutcome, nodeEvidenceRefusal, probeSeedTarget, tmpNote } from '../ensure-ops.mjs';
import { surveyAdrLayoutStrict } from '../family-registry.mjs';
import { BUNDLED_SCRIPT_NAMES } from '../node-evidence.mjs';
import { CHECKER_PAIR, INSTALLER_SET, READER_PAIR, SCRIPT_PRIORS, classifyDeployedScript } from '../script-priors.mjs';

const OP = 'scripts';
const SCRIPTS_DIR = 'scripts';
const BUNDLED = ['references', 'scripts'];
// Where an edit meant to last goes: the installer's in the local hook file, every other file's beside it.
export const SCRIPT_CHANNEL = 'a script or suite of your own under its own name in scripts/, or a config the script reads';
export const LOCAL_HOOK_CHANNEL = 'the local hook file scripts/pre-commit.local, which the commit hook runs first';
// The family files whose bytes import or read archive-decisions.mjs, plus that file (the suite derives it).
export const DECISIONS_GROUP = Object.freeze(['archive-decisions.mjs', 'archive-decisions.test.mjs', 'archiver-structure.test.mjs']);
// The family files memory copies on Node evidence alone, accepted or not (the suite derives them).
export const SEED_NAMES = Object.freeze(['_expect-shim.mjs', 'archive-decisions.mjs', 'archive-decisions.test.mjs', 'markdown-blocks.mjs']);
const OLD_ADR_LAYOUTS = new Set(['old', 'old-unrotated']);
const PAIRS = new Set([...READER_PAIR, ...CHECKER_PAIR]);
// The family in write order: the installer set, then every other bundled name in code-unit order.
const FAMILY = Object.freeze([...INSTALLER_SET, ...BUNDLED_SCRIPT_NAMES.filter((name) => !PAIRS.has(name) && !INSTALLER_SET.includes(name)).sort()]);
const LOCAL_IMPORT = /(?:from|import)\s*\(?\s*'\.\/([^']+)'/g;

const causeOf = (err) => String((err && err.message) || err);
const relOf = (name) => `${SCRIPTS_DIR}/${name}`;
const kindOfDir = (st) => (st.isSymbolicLink() ? 'a symlink' : st.isFile() ? 'a regular file' : 'not a directory');
const wrongKind = (rel, kind) => composeFailure(OP, 'wrong-node-kind', `${rel}: exists but is ${kind} — nothing was read or written; resolve it by hand, then re-run`);

// ── the survey: the component first, then every family file by proof, nothing written ────────────

// The seed files a run of a component that is not accepted judges: each standing one, and every seed
// file reached from one through its bundled `./` imports, so every seed file the run leaves loads.
const seedClosure = (standing, bundleOf) => {
  const reached = new Set(standing);
  for (const name of reached) for (const [, dep] of bundleOf(name).toString('utf8').matchAll(LOCAL_IMPORT)) if (SEED_NAMES.includes(dep)) reached.add(dep);
  return reached;
};

// → { refusal } | { notPlaced } | { files, accepted, layout, layoutError }. A family path of another node
// kind is judged before the component, so a linked family file never reads as not-placed.
const survey = ({ cwd, kitRoot, deps, read, lstat }) => {
  const dir = lstatNoFollow(join(cwd, SCRIPTS_DIR), lstat);
  if (dir === null) return { notPlaced: true };
  if (!dir.isDirectory() || dir.isSymbolicLink()) return { refusal: wrongKind(`${SCRIPTS_DIR}/`, kindOfDir(dir)) };
  const probes = FAMILY.map((name) => ({ name, rel: relOf(name), probe: probeSeedTarget(join(cwd, SCRIPTS_DIR, name), lstat) }));
  const wrong = probes.find((f) => f.probe.wrongKind);
  if (wrong) return { refusal: wrongKind(wrong.rel, wrong.probe.wrongKind) };
  if (!probes.some((f) => f.probe.present)) return { notPlaced: true };
  const accepted = probes.some((f) => f.probe.present && !SEED_NAMES.includes(f.name));
  const bundles = new Map();
  for (const { name, rel } of probes) {
    try {
      bundles.set(name, read(join(kitRoot, ...BUNDLED, name)));
    } catch (err) {
      return { refusal: composeFailure(OP, 'bundle-unreadable', `${rel}: the bundled script could not be read, so nothing was written — reinstall the kit. ${causeOf(err)}`) };
    }
  }
  const judged = accepted ? new Set(FAMILY) : seedClosure(probes.filter((f) => f.probe.present).map((f) => f.name), (name) => bundles.get(name));
  const files = probes.filter((f) => judged.has(f.name)).map(({ name, rel, probe }) => {
    const bytes = probe.present ? read(join(cwd, rel)) : undefined;
    return { name, rel, bundle: bundles.get(name), state: probe.present ? classifyDeployedScript(bytes, name, bundles.get(name), deps.priors ?? SCRIPT_PRIORS) : 'absent' };
  });
  try {
    return { files, accepted, layout: surveyAdrLayoutStrict(cwd, deps) };
  } catch (err) {
    return { files, accepted, layoutError: causeOf(err) };
  }
};

// ── the lines (composed from what HAPPENED: each file's state and the fate of its write) ─────────

// A fate is `written`, `stood` (an absent file that appeared with the bundled body), `refused` (its
// write failed), or none: the run stopped before it, or, dry, would write it.
const VERBS = { prior: ['refreshed', 'refreshed to the bundled one'], custom: ['replaced', 'replaced by the bundled body'], absent: ['placed', 'placed from the bundled scripts'] };
const HEADS = { prior: 'matches a body an earlier release shipped', custom: 'differs from every body this kit knows it shipped', absent: 'absent' };
const fileLine = (f, fate, dryRun) => {
  if (fate === 'stood') return `${f.rel}: appeared while this run was placing it — the bundled body stands, nothing written`;
  const [verb, done] = VERBS[f.state];
  const tail = fate === 'written' ? done : dryRun ? `would be ${done}` : `not ${verb}; ${fate === 'refused' ? 'its write was refused (above)' : 'the run stopped before it'}`;
  return `${f.rel}: ${HEADS[f.state]} — ${tail}${f.state === 'custom' ? `; an edit meant to last goes in ${f.name === INSTALLER_SET[0] ? LOCAL_HOOK_CHANNEL : SCRIPT_CHANNEL}` : ''}`;
};
const heldLine = (layout) => `${SCRIPTS_DIR}/: ${DECISIONS_GROUP.slice(0, -1).join(', ')} and ${DECISIONS_GROUP.at(-1)} are held back while this project is on the older ADR layout (${layout}) — run the opt-in /agent-workflow-kit migrate-adr-store (it previews, and never commits); the next upgrade judges them`;
const NOT_ACCEPTED = `${SCRIPTS_DIR}/: the enforcement scripts were not accepted in this project, so no other kit script is placed`;
// The hook-run line, once after the file lines of a run that wrote (or, dry, would write) a file.
const hookLine = (accepted, dryRun) => (accepted
  ? (dryRun ? 'the commit hook runs the files named above, so writing them may stop the next commit' : 'the commit hook runs the files written above, so they may stop the next commit')
  : (dryRun ? 'if a commit hook runs the files named above, writing them may stop the next commit' : 'if a commit hook runs the files written above, they may stop the next commit'));
const partialNote = (count) => (count > 0 ? [`the writes stopped PARTWAY — the ${count} file(s) named above were already written and are NOT rolled back`] : []);

// ── the writes ────────────────────────────────────────────────────────────────────────────────────

// One write per file in write order: a prior refreshed and an edit replaced by the atomic write, an
// absent file written create-only. → { fates, notes, failure? }
const writeAll = ({ cwd, files, deps, read }) => {
  const fates = new Map();
  const notes = [];
  for (const f of files) {
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
        fates.set(f.rel, 'refused');
        return { fates, notes, failure: ['race-unresolved', `${f.rel}: appeared while this run was placing it and does not carry the bundled body — nothing further written, re-run when the tree is settled`] };
      }
      fates.set(f.rel, 'stood');
    } else fates.set(f.rel, 'written');
  }
  return { fates, notes };
};

// One run over the files it is handed: every one that is not current written in order, its lines,
// then the hook-run line once when a file was (or, dry, would be) written.
const writeRun = ({ cwd, files, accepted, dryRun, deps, read }) => {
  const due = files.filter((f) => f.state !== 'current');
  const { fates, notes, failure } = dryRun ? { fates: new Map(), notes: [] } : writeAll({ cwd, files: due, deps, read });
  const written = due.filter((f) => fates.get(f.rel) === 'written');
  const hook = (dryRun ? due.length > 0 : written.length > 0) ? [hookLine(accepted, dryRun)] : [];
  return { due, fates, failure, written, lines: due.map((f) => fileLine(f, fates.get(f.rel), dryRun)), tail: [...hook, ...notes, ...(failure ? partialNote(written.length) : [])] };
};

// ── the op ────────────────────────────────────────────────────────────────────────────────────────

export const ensureScripts = ({ cwd, kitRoot, dryRun = false, deps = {} }) => {
  const lstat = deps.lstat ?? lstatSync;
  const read = deps.readFile ?? readFileSync;
  const refusal = nodeEvidenceRefusal(OP, cwd, lstat);
  if (refusal) return refusal;
  const found = survey({ cwd, kitRoot, deps, read, lstat });
  if (found.refusal) return found.refusal;
  if (found.notPlaced) return composeOutcome(OP, 'not-placed', [`${SCRIPTS_DIR}/: no kit script stands in it, so none is placed`], false);
  const { files, accepted } = found;
  const declined = accepted ? [] : [NOT_ACCEPTED];

  // An unreadable layout: on an accepted component the installer set alone is kept current.
  if (found.layoutError !== undefined) {
    const layoutLine = `${SCRIPTS_DIR}/: the ADR-store layout could not be read (${found.layoutError}), so the other kit scripts wait for the layout`;
    const set = accepted ? files.filter((f) => INSTALLER_SET.includes(f.name)) : [];
    const r = writeRun({ cwd, files: set, accepted, dryRun, deps, read });
    if (r.failure) return composeFailure(OP, r.failure[0], r.failure[1], ...r.lines, layoutLine, ...r.tail);
    return composeFailure(OP, 'adr-layout-unverifiable', layoutLine, ...r.lines, ...r.tail);
  }

  const held = OLD_ADR_LAYOUTS.has(found.layout);
  const live = files.filter((f) => !(held && DECISIONS_GROUP.includes(f.name)));
  const current = live.filter((f) => f.state === 'current').length;
  const r = writeRun({ cwd, files: live, accepted, dryRun, deps, read });
  const body = [...r.lines, ...(current > 0 ? [`${SCRIPTS_DIR}/: ${current} other kit scripts are already the bundled body — nothing written`] : []), ...(held ? [heldLine(found.layout)] : []), ...declined];
  if (r.failure) return composeFailure(OP, r.failure[0], r.failure[1], ...body, ...r.tail);
  const landed = (state) => (dryRun ? r.due : r.written).some((f) => f.state === state);
  const token = held ? 'old-adr-layout-migration-instructed'
    : landed('absent') ? (dryRun ? 'would-seed' : 'seeded')
      : landed('prior') || landed('custom') ? (dryRun ? 'would-refresh' : 'refreshed') : 'already-present';
  return composeOutcome(OP, token, [...body, ...r.tail], false);
};
