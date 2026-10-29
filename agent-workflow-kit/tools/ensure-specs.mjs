// ensure-specs.mjs — the SIXTH upgrade ensure: the spec layer (memory 4.6.0, AD-112) kept current on an
// EXISTING deployment. Its scripts are the reader pair (the deployed entries of the spec-schema module)
// and the checker pair (the docs-size module's), each at its deployed path in the kit folder
// scripts/agent-workflow/, with the bundled files they import; every other kit script is the scripts
// ensure's. They and one store root follow the scripts op's rule (distribution-files/): every file is
// surveyed by proof first, then on every plain run a prior body is refreshed and an edited one replaced
// in place, an absent one placed create-only and an absent store root seeded create-only, with no
// question and no copy kept; a current file is left. The writes run in a FIXED order:
//   1. the files the pairs import   scripts/agent-workflow/shared/... (dependencies first)
//   2. the reader pair              scripts/agent-workflow/spec-schema/...
//   3. the checker pair             scripts/agent-workflow/docs-size/check-docs-size.mjs
//   4. the store root               docs/ai/specs/index.md (placeholders rendered)
// Why the order: every file is written after the files it imports, so each pair file it leaves loads;
// the kit's bundled navigator generator collapses `specs/` into one row, while the project's pre-commit
// hook runs ITS deployed checker — an older one renders the store row by row and reds `--check-index`.
// So the checker is written before the spec store, and a write that fails stops every later one. The
// pair lines and the hook-run line are the scripts op's own, from the module's index. Each write is
// idempotent, so a stopped run converges on the next.
//
// Dependency-free, Node >= 22. Every fs primitive is injectable (deps.*). No side effects on import.

import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { lstatNoFollow, writeContainedFileAtomic, writeProjectFileCreateOnly } from './atomic-write.mjs';
import { DEPLOYED_SCRIPTS } from './node-evidence.mjs';
import { SCRIPT_PRIORS, classifyDeployedScript } from './script-priors.mjs';
import { bundledImportsOf, composeFailure, composeOutcome, dependenciesFirst, nodeEvidenceRefusal, probeSeedTarget, tmpNote } from './ensure-ops.mjs';
import { fileLine, hookLine } from './distribution-files/index.mjs';

const OP = 'specs';
const READER = DEPLOYED_SCRIPTS.filter((e) => e.module === 'spec-schema');
const CHECKER = DEPLOYED_SCRIPTS.filter((e) => e.module === 'docs-size');
const STORE_ROOT_REL = 'docs/ai/specs/index.md';
const STORE_ROOT_TEMPLATE = ['references', 'templates', 'specs', 'index.md'];
const DATE_PLACEHOLDER = '{{DATE}}';

const causeOf = (err) => String((err && err.message) || err);
const todayIso = () => new Date().toISOString().slice(0, 10);
const kindOfDir = (st) => (st.isSymbolicLink() ? 'a symlink' : st.isFile() ? 'a regular file' : 'not a directory');
const wrongKind = (rel, kind) => composeFailure(OP, 'wrong-node-kind', `${rel}: exists but is ${kind} — nothing was read or written; resolve it by hand, then re-run`);

// ── the survey: the pairs, the files they import and the store root classified, nothing written ───

// The bundled side: the pairs and their whole import closure in write order → { files } | { refusal }.
const readBundles = (kitRoot, read) => {
  const byPath = new Map();
  const queue = [...READER, ...CHECKER];
  for (const entry of queue) {
    if (byPath.has(entry.path)) continue;
    let bundle;
    try {
      bundle = read(join(kitRoot, entry.bundled));
    } catch (err) {
      return { refusal: composeFailure(OP, 'bundle-unreadable', `${entry.deployed}: the bundled script could not be read, so nothing was written — reinstall the kit. ${causeOf(err)}`) };
    }
    const imports = bundledImportsOf(entry.path, bundle);
    byPath.set(entry.path, { path: entry.path, rel: entry.deployed, bundle, imports });
    queue.push(...DEPLOYED_SCRIPTS.filter((e) => imports.includes(e.path)));
  }
  const of = (entries) => (path) => entries.some((e) => e.path === path);
  const group = (keep) => dependenciesFirst([...byPath.values()].filter((f) => keep(f.path)));
  return { files: [...group((p) => !of(READER)(p) && !of(CHECKER)(p)), ...group(of(READER)), ...group(of(CHECKER))] };
};

// Each folder on the way to a pair file or a file it imports, lstat-ed without following a link → a refusal or null.
const folderRefusal = (cwd, files, lstat) => {
  const folders = new Set(files.flatMap((f) => f.rel.split('/').slice(0, -1).map((_, at, parts) => parts.slice(0, at + 1).join('/'))));
  for (const rel of folders) {
    const st = lstatNoFollow(join(cwd, rel), lstat);
    if (st !== null && (!st.isDirectory() || st.isSymbolicLink())) return wrongKind(`${rel}/`, kindOfDir(st));
  }
  return null;
};

// One deployed script → its state against the bundled body, by the catalog seam keyed by manifest path.
const surveyScript = (cwd, f, deps, read, lstat) => {
  const probe = probeSeedTarget(join(cwd, f.rel), lstat);
  if (probe.wrongKind) return { ...f, state: 'wrong-kind', wrongKind: probe.wrongKind };
  if (!probe.present) return { ...f, state: 'absent' };
  return { ...f, state: classifyDeployedScript(read(join(cwd, f.rel)), f.path, f.bundle, deps.priors ?? SCRIPT_PRIORS) };
};

const surveyStoreRoot = (cwd, lstat) => {
  const probe = probeSeedTarget(join(cwd, STORE_ROOT_REL), lstat);
  if (probe.wrongKind) return { rel: STORE_ROOT_REL, state: 'wrong-kind', wrongKind: probe.wrongKind };
  return { rel: STORE_ROOT_REL, state: probe.present ? 'present' : 'absent' };
};

// ── the lines (composed from what HAPPENED: each file's state and the fate of its write) ─────────

// A fate is `written`, `stood` (a create-only write that found the path taken: a pair file with the
// bundled body, or a store root as found), `refused` (its write failed), or none: the run stopped
// before it, or, dry, would write it. A pair file that is not current takes the scripts op's line.
const CURRENT = 'already the bundled body — nothing written';
const STORE_LINES = {
  present: 'already present — preserved byte-for-byte, nothing written',
  written: "created from the bundled template (today's date rendered)",
  stood: 'appeared while this run was seeding it — the existing file stands',
  would: 'absent — would be created from the bundled template',
  stopped: 'absent — not created',
};
const composeLines = ({ files, store, fates, dryRun }) => [
  ...files.map((f) => (f.state === 'current' ? `${f.rel}: ${CURRENT}` : fileLine(f, fates.get(f.rel), dryRun))),
  `${STORE_ROOT_REL}: ${STORE_LINES[store.state === 'present' ? 'present' : fates.get(STORE_ROOT_REL) ?? (dryRun ? 'would' : 'stopped')]}`,
];

// A per-file loop can stop partway; the run says which files already landed — never "nothing happened".
const partialNote = (count) =>
  (count > 0 ? [`the writes stopped PARTWAY — the ${count} file(s) named above were already written and are NOT rolled back`] : []);

// ── the ensure ────────────────────────────────────────────────────────────────────────────────────

// The store body is read and rendered BEFORE the first write, so a missing or unrenderable template
// refuses with nothing written.
const renderStoreRoot = (kitRoot, read, today) => {
  const body = String(read(join(kitRoot, ...STORE_ROOT_TEMPLATE), 'utf8')).replaceAll(DATE_PLACEHOLDER, today);
  if (body.includes('{{')) throw new Error('the bundled template carries a placeholder this kit cannot render — reinstall the kit');
  return body;
};

// One write per due path in write order: a prior refreshed and an edit replaced by the atomic write,
// an absent script and the store root written create-only. → { fates, notes, failure? }
const writeAll = ({ cwd, due, storeBody, deps, read }) => {
  const fates = new Map();
  const notes = [];
  for (const f of due) {
    const isStore = f.rel === STORE_ROOT_REL;
    let result;
    try {
      result = isStore ? writeProjectFileCreateOnly(cwd, f.rel, storeBody, deps, { noun: 'the spec store root' })
        : f.state === 'absent' ? writeProjectFileCreateOnly(cwd, f.rel, f.bundle, deps, { noun: 'a seeded spec-layer script' })
        : writeContainedFileAtomic(cwd, join(cwd, f.rel), f.bundle, deps, { label: f.rel });
    } catch (err) {
      if (!isStore) fates.set(f.rel, 'refused');
      return { fates, notes, failure: ['write-refused', `${f.rel}: ${causeOf(err)}`] };
    }
    notes.push(...tmpNote(f.rel, result.tmpLeftBehind));
    const stood = f.state === 'absent' && !result.created;
    if (stood && !isStore && classifyDeployedScript(read(join(cwd, f.rel)), f.path, f.bundle) !== 'current') {
      fates.set(f.rel, 'refused');
      return { fates, notes, failure: ['race-unresolved', `${f.rel}: appeared while this run was placing it and does not carry the bundled body — nothing further written, re-run when the tree is settled`] };
    }
    fates.set(f.rel, stood ? 'stood' : 'written');
  }
  return { fates, notes };
};

export const ensureSpecs = ({ cwd, kitRoot, dryRun = false, deps = {} }) => {
  const lstat = deps.lstat ?? lstatSync;
  const read = deps.readFile ?? readFileSync;
  const refusal = nodeEvidenceRefusal(OP, cwd, lstat);
  if (refusal) return refusal;
  const bundled = readBundles(kitRoot, read);
  if (bundled.refusal) return bundled.refusal;
  const folders = folderRefusal(cwd, bundled.files, lstat);
  if (folders) return folders;
  const files = bundled.files.map((f) => surveyScript(cwd, f, deps, read, lstat));
  const store = surveyStoreRoot(cwd, lstat);
  for (const f of [...files, store]) {
    if (f.state === 'wrong-kind') return wrongKind(f.rel, f.wrongKind);
  }

  const due = [...files.filter((f) => f.state !== 'current'), ...(store.state === 'absent' ? [store] : [])];
  const seeds = (fs) => fs.some((f) => f.state === 'absent');
  const refreshes = (fs) => fs.some((f) => f.state === 'prior' || f.state === 'custom');
  if (dryRun) {
    const token = seeds(due) ? 'would-seed' : refreshes(due) ? 'would-refresh' : 'already-present';
    return composeOutcome(OP, token, [...composeLines({ files, store, fates: new Map(), dryRun }), ...(due.length > 0 ? [hookLine(false, true)] : [])], false);
  }

  let storeBody = null;
  if (store.state === 'absent') {
    try {
      storeBody = renderStoreRoot(kitRoot, read, deps.today ?? todayIso());
    } catch (err) {
      return composeFailure(OP, 'template-unreadable', `${STORE_ROOT_REL}: ${causeOf(err)}`, ...composeLines({ files, store, fates: new Map(), dryRun }));
    }
  }
  const { fates, notes, failure } = writeAll({ cwd, due, storeBody, deps, read });
  const written = due.filter((f) => fates.get(f.rel) === 'written');
  const lines = [...composeLines({ files, store, fates, dryRun }), ...(written.length > 0 ? [hookLine(false, false)] : []), ...notes];
  if (failure) return composeFailure(OP, failure[0], failure[1], ...lines, ...partialNote(written.length));
  return composeOutcome(OP, seeds(written) ? 'seeded' : refreshes(written) ? 'refreshed' : 'already-present', lines, false);
};
