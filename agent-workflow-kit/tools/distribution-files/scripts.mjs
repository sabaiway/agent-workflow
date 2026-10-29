// scripts.mjs — the upgrade's `scripts` op: every kit script of a deployment, the hook installer
// included, kept current by the one rule in the kit folder scripts/agent-workflow/. The family is the
// manifest's deployed entries (node-evidence.mjs) less the spec layer's modules. Each family file is
// surveyed by proof before any write: absent, current, prior (a body the catalog lists for its manifest
// path) or edited. On every plain run a prior is refreshed, an edited one replaced in place and an
// absent one placed create-only, with no question and no copy kept; a current one is left. The
// installer is written first, then every file after the family files it imports; after the last write
// the project's own rotator brings the ADR store current (`--ensure-current`). It never imports
// ensure-specs.mjs or ensure-configs.mjs: the CLI composes this op from the module's index, and
// ensure-specs.mjs takes its channel and its lines from there.
//
// Dependency-free, Node >= 22. Every fs primitive and the spawn are injectable (deps.*). No side effects on import.

import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { lstatNoFollow, writeContainedFileAtomic, writeProjectFileCreateOnly } from '../atomic-write.mjs';
import { bundledImportsOf, composeFailure, composeOutcome, dependenciesFirst, nodeEvidenceRefusal, probeSeedTarget, tmpNote } from '../ensure-ops.mjs';
import { DEPLOYED_SCRIPTS, INSTALLER_REL, KIT_SCRIPTS_DIR, SCRIPTS_DIR } from '../node-evidence.mjs';
import { SCRIPT_PRIORS, classifyDeployedScript } from '../script-priors.mjs';
import { VEHICLES_REL } from '../vehicle-settings.mjs';

const OP = 'scripts';
// Where an edit meant to last goes: the installer's in the local hook file, every other file's beside it.
export const SCRIPT_CHANNEL = 'a script or suite of your own under its own name in scripts/, or a config the script reads';
export const LOCAL_HOOK_CHANNEL = 'the local hook file scripts/pre-commit.local, which the commit hook runs first';
export const VEHICLE_CHANNEL = VEHICLES_REL;
export const AGENT_CHANNEL = '.claude/agents/<name>.local.md with a name: of its own';
export const HOOK_CHANNEL = '.claude/hooks/<name>.local.mjs';
// The manifest paths a run of a component that is not accepted may judge: the rotator and what it loads.
export const SEED_NAMES = Object.freeze(DEPLOYED_SCRIPTS.filter((e) => e.seed).map((e) => e.path));
const ROTATOR = 'archives/archive-decisions.mjs';
// The family: every deployed entry outside the specs op's modules, in manifest order.
const FAMILY = DEPLOYED_SCRIPTS.filter((e) => e.module !== 'spec-schema' && e.module !== 'docs-size');
const FOLDERS = [...new Set([SCRIPTS_DIR, KIT_SCRIPTS_DIR, ...FAMILY.map((e) => posix.dirname(e.deployed))])];

const causeOf = (err) => String((err && err.message) || err);
const kindOfDir = (st) => (st.isSymbolicLink() ? 'a symlink' : st.isFile() ? 'a regular file' : 'not a directory');
const wrongKind = (rel, kind) => composeFailure(OP, 'wrong-node-kind', `${rel}: exists but is ${kind} — nothing was read or written; resolve it by hand, then re-run`);

// ── the survey: the component first, then every family file by proof, nothing written ────────────

// The installer first (it imports nothing), then each file after every family file it imports.
const inWriteOrder = (files) => [...files.filter((f) => f.rel === INSTALLER_REL), ...dependenciesFirst(files.filter((f) => f.rel !== INSTALLER_REL))];

// The seed files a run of a component that is not accepted judges: each standing one, and every seed
// file reached from one through bundled relative imports, so every seed file the run leaves loads.
const seedClosure = (standing, byPath) => {
  const reached = new Set(standing);
  for (const path of reached) for (const dep of byPath.get(path).imports) if (SEED_NAMES.includes(dep) && byPath.has(dep)) reached.add(dep);
  return reached;
};

// Each folder on the way, lstat-ed without following a link: → { refusal } | { notPlaced } | {}.
const surveyFolders = (cwd, lstat) => {
  for (const rel of FOLDERS) {
    const st = lstatNoFollow(join(cwd, rel), lstat);
    if (st === null && (rel === SCRIPTS_DIR || rel === KIT_SCRIPTS_DIR)) return { notPlaced: true };
    if (st !== null && (!st.isDirectory() || st.isSymbolicLink())) return { refusal: wrongKind(`${rel}/`, kindOfDir(st)) };
  }
  return {};
};

// → { refusal } | { notPlaced } | { files, accepted }. A family path of another node kind is judged
// before the component, so a linked family file never reads as not-placed.
const survey = ({ cwd, kitRoot, deps, read, lstat }) => {
  const folders = surveyFolders(cwd, lstat);
  if (folders.refusal || folders.notPlaced) return folders;
  const probes = FAMILY.map((e) => ({ path: e.path, rel: e.deployed, bundled: e.bundled, probe: probeSeedTarget(join(cwd, e.deployed), lstat) }));
  const wrong = probes.find((f) => f.probe.wrongKind);
  if (wrong) return { refusal: wrongKind(wrong.rel, wrong.probe.wrongKind) };
  if (!probes.some((f) => f.probe.present)) return { notPlaced: true };
  const accepted = probes.some((f) => f.probe.present && !SEED_NAMES.includes(f.path));
  const byPath = new Map();
  for (const f of probes) {
    try {
      const bundle = read(join(kitRoot, f.bundled));
      byPath.set(f.path, { ...f, bundle, imports: bundledImportsOf(f.path, bundle) });
    } catch (err) {
      return { refusal: composeFailure(OP, 'bundle-unreadable', `${f.rel}: the bundled script could not be read, so nothing was written — reinstall the kit. ${causeOf(err)}`) };
    }
  }
  const judged = accepted ? new Set(byPath.keys()) : seedClosure(probes.filter((f) => f.probe.present).map((f) => f.path), byPath);
  const files = inWriteOrder([...byPath.values()]).filter((f) => judged.has(f.path)).map(({ path, rel, bundle, probe }) => {
    const bytes = probe.present ? read(join(cwd, rel)) : undefined;
    return { path, rel, bundle, state: probe.present ? classifyDeployedScript(bytes, path, bundle, deps.priors ?? SCRIPT_PRIORS) : 'absent' };
  });
  return { files, accepted };
};

// ── the lines (composed from what HAPPENED: each file's state and the fate of its write) ─────────

// A fate is `written`, `stood` (an absent file that appeared with the bundled body), `refused` (its
// write failed), or none: the run stopped before it, or, dry, would write it. The spec layer's pair
// lines are these too, through the module's index.
const VERBS = { prior: ['refreshed', 'refreshed to the bundled one'], custom: ['replaced', 'replaced by the bundled body'], absent: ['placed', 'placed from the bundled scripts'], derived: ['written', 'written with that body'], agent: ['written', 'written with that body'], hook: ['written', 'written with that body'] };
const HEADS = { prior: 'matches a body an earlier release shipped', custom: 'differs from every body this kit knows it shipped', absent: 'absent', derived: 'differs from the body derived from the vehicle settings', agent: 'differs from the body the kit writes for it', hook: 'differs from the body the kit writes for it' };
const channelOf = (f) => (f.state === 'derived' ? `; its model and effort are set in ${VEHICLE_CHANNEL}`
  : f.state === 'agent' ? `; a vehicle of your own goes in ${AGENT_CHANNEL}`
  : f.state === 'hook' ? `; a hook of your own goes in ${HOOK_CHANNEL}`
  : f.state === 'custom' ? `; an edit meant to last goes in ${f.rel === INSTALLER_REL ? LOCAL_HOOK_CHANNEL : SCRIPT_CHANNEL}` : '');
export const fileLine = (f, fate, dryRun) => {
  if (fate === 'stood') return `${f.rel}: appeared while this run was placing it — the bundled body stands, nothing written`;
  const [verb, done] = VERBS[f.state];
  const tail = fate === 'written' ? done : dryRun ? `would be ${done}` : `not ${verb}; ${fate === 'refused' ? 'its write was refused (above)' : 'the run stopped before it'}`;
  return `${f.rel}: ${HEADS[f.state]} — ${tail}${channelOf(f)}`;
};
const NOT_ACCEPTED = `${KIT_SCRIPTS_DIR}/: the enforcement scripts were not accepted in this project, so no other kit script is placed`;
// The hook-run line, once after the file lines of a run that wrote (or, dry, would write) a file.
export const hookLine = (accepted, dryRun) => (accepted
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
      if (classifyDeployedScript(read(join(cwd, f.rel)), f.path, f.bundle) !== 'current') {
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

// ── the ADR store, after the writes ───────────────────────────────────────────────────────────────

// The rotator the run just left on the bundled body brings the store current; its output is relayed
// keyed on its contracted summary, the last standard output line.
const STORE = 'ADR store: ';
const ROTATOR_REL = `${KIT_SCRIPTS_DIR}/${ROTATOR}`;
const ENSURE = `${ROTATOR_REL} --ensure-current`;
const WOULD_STORE = `${STORE}${ENSURE} would run after the writes, bringing the store current or writing nothing when it already is`;
const outputLines = (text) => String(text ?? '').split(/\r?\n/).filter((line) => line !== '');
// A runner that throws before it returns a result ended with that error, as a result carrying one.
const spawnOutcome = (spawn, args, opts) => {
  try {
    return spawn(process.execPath, args, opts) ?? { error: new Error('the spawn returned no result') };
  } catch (error) {
    return { error };
  }
};
// → { brought, lines, failure? }
const runStore = (cwd, deps) => {
  const r = spawnOutcome(deps.spawnSync ?? spawnSync, [join(cwd, ROTATOR_REL), '--ensure-current'], { cwd, encoding: 'utf8' });
  const [out, err] = [outputLines(r.stdout), outputLines(r.stderr)];
  const ended = r.error ? `ended with an error (${causeOf(r.error)})` : r.signal ? `was killed by signal ${r.signal}` : r.status !== 0 ? `exited with code ${r.status}` : null;
  if (ended) return { failure: `${ENSURE} ${ended} — the ADR store was not confirmed current`, lines: [...err, ...out].map((line) => STORE + line) };
  const brought = (out.at(-1) ?? '').startsWith('brought-current:');
  return { brought, lines: [...(brought ? out : []), ...err].map((line) => STORE + line) };
};

// ── the op ────────────────────────────────────────────────────────────────────────────────────────

export const ensureScripts = ({ cwd, kitRoot, dryRun = false, deps = {} }) => {
  const lstat = deps.lstat ?? lstatSync;
  const read = deps.readFile ?? readFileSync;
  const refusal = nodeEvidenceRefusal(OP, cwd, lstat);
  if (refusal) return refusal;
  const found = survey({ cwd, kitRoot, deps, read, lstat });
  if (found.refusal) return found.refusal;
  if (found.notPlaced) return composeOutcome(OP, 'not-placed', [`${KIT_SCRIPTS_DIR}/: no kit script stands in it, so none is placed`], false);
  const { files, accepted } = found;
  const current = files.filter((f) => f.state === 'current').length;
  const r = writeRun({ cwd, files, accepted, dryRun, deps, read });
  const body = [...r.lines, ...(current > 0 ? [`${KIT_SCRIPTS_DIR}/: ${current} other kit scripts are already the bundled body — nothing written`] : []), ...(accepted ? [] : [NOT_ACCEPTED])];
  if (r.failure) return composeFailure(OP, r.failure[0], r.failure[1], ...body, ...r.tail);
  const rotator = files.some((f) => f.path === ROTATOR);
  const store = !rotator ? { lines: [] } : dryRun ? { lines: [WOULD_STORE] } : runStore(cwd, deps);
  if (store.failure) return composeFailure(OP, 'adr-store-not-current', store.failure, ...body, ...r.tail, ...store.lines);
  const landed = (state) => (dryRun ? r.due : r.written).some((f) => f.state === state);
  const token = landed('absent') ? (dryRun ? 'would-seed' : 'seeded')
    : landed('prior') || landed('custom') || store.brought ? (dryRun ? 'would-refresh' : 'refreshed') : 'already-present';
  return composeOutcome(OP, token, [...body, ...r.tail, ...store.lines], false);
};
