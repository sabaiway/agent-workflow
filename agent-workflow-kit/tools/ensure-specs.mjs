// ensure-specs.mjs — the SIXTH upgrade ensure: the spec layer (memory 4.6.0, AD-112) kept current on an
// EXISTING deployment. Four deployed scripts (the pairs script-priors.mjs names; every other kit script
// is the scripts ensure's) and one store root, by the scripts op's rule (distribution-files/): every
// file is surveyed by proof first, then on every plain run a prior body is refreshed and an edited one
// replaced in place, an absent one placed create-only and an absent store root seeded create-only, with
// no question and no copy kept; a current file is left. The writes run in a FIXED order:
//   1. the reader pair   scripts/spec-schema.mjs + .test.mjs
//   2. the checker pair  scripts/check-docs-size.mjs + .test.mjs
//   3. the store root    docs/ai/specs/index.md (placeholders rendered)
// Why the order: the kit's bundled navigator generator collapses `specs/` into one row, while the
// project's pre-commit hook runs ITS deployed checker — an older one renders the store row by row and
// reds `--check-index`. So the checker is written before the spec store, and a write that fails stops
// every later one. The pair lines and the hook-run line are the scripts op's own, from the module's
// index. Each write is idempotent, so a stopped run converges on the next.
//
// Dependency-free, Node >= 22. Every fs primitive is injectable (deps.*). No side effects on import.

import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { writeContainedFileAtomic, writeProjectFileCreateOnly } from './atomic-write.mjs';
import { CHECKER_PAIR, READER_PAIR, classifyDeployedScript } from './script-priors.mjs';
import { composeFailure, composeOutcome, nodeEvidenceRefusal, probeSeedTarget, tmpNote } from './ensure-ops.mjs';
import { fileLine, hookLine } from './distribution-files/index.mjs';

const OP = 'specs';
const SCRIPTS_DIR = 'scripts';
const BUNDLED_SCRIPTS = ['references', 'scripts'];
const STORE_ROOT_REL = 'docs/ai/specs/index.md';
const STORE_ROOT_TEMPLATE = ['references', 'templates', 'specs', 'index.md'];
const DATE_PLACEHOLDER = '{{DATE}}';

const causeOf = (err) => String((err && err.message) || err);
const todayIso = () => new Date().toISOString().slice(0, 10);

// ── the survey: five paths classified, nothing written ────────────────────────────────────────────

// One deployed script → { rel, name, state, bundle }; `wrongKind` carries the node kind for the
// refusal, `prior`/`custom` come from the catalog classifier against the bundled body.
const surveyScript = ({ cwd, kitRoot, name, read, lstat }) => {
  const rel = `${SCRIPTS_DIR}/${name}`;
  let bundle;
  try {
    bundle = read(join(kitRoot, ...BUNDLED_SCRIPTS, name));
  } catch (err) {
    return { rel, name, state: 'bundle-unreadable', error: causeOf(err) };
  }
  const probe = probeSeedTarget(join(cwd, SCRIPTS_DIR, name), lstat);
  if (probe.wrongKind) return { rel, name, state: 'wrong-kind', wrongKind: probe.wrongKind, bundle };
  if (!probe.present) return { rel, name, state: 'absent', bundle };
  return { rel, name, state: classifyDeployedScript(read(join(cwd, SCRIPTS_DIR, name)), name, bundle), bundle };
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
// an absent pair file and the store root written create-only. → { fates, notes, failure? }
const writeAll = ({ cwd, due, storeBody, deps, read }) => {
  const fates = new Map();
  const notes = [];
  for (const f of due) {
    const isStore = f.rel === STORE_ROOT_REL;
    let result;
    try {
      result = isStore ? writeProjectFileCreateOnly(cwd, f.rel, storeBody, deps, { noun: 'the spec store root' })
        : f.state === 'absent' ? writeProjectFileCreateOnly(cwd, f.rel, String(f.bundle), deps, { noun: 'a seeded spec-layer script' })
        : writeContainedFileAtomic(cwd, join(cwd, f.rel), String(f.bundle), deps, { label: f.rel });
    } catch (err) {
      if (!isStore) fates.set(f.rel, 'refused');
      return { fates, notes, failure: ['write-refused', `${f.rel}: ${causeOf(err)}`] };
    }
    notes.push(...tmpNote(f.rel, result.tmpLeftBehind));
    const stood = f.state === 'absent' && !result.created;
    if (stood && !isStore && classifyDeployedScript(read(join(cwd, f.rel)), f.name, f.bundle) !== 'current') {
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
  const survey = (name) => surveyScript({ cwd, kitRoot, name, read, lstat });
  const files = [...READER_PAIR.map(survey), ...CHECKER_PAIR.map(survey)];
  const store = surveyStoreRoot(cwd, lstat);
  for (const f of files) {
    if (f.state === 'bundle-unreadable') return composeFailure(OP, 'bundle-unreadable', `${f.rel}: the bundled script could not be read, so nothing was written — reinstall the kit. ${f.error}`);
  }
  for (const f of [...files, store]) {
    if (f.state === 'wrong-kind') return composeFailure(OP, 'wrong-node-kind', `${f.rel}: exists but is ${f.wrongKind} — nothing was read or written; resolve it by hand, then re-run`);
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
