// ensure-specs.mjs — the SIXTH upgrade ensure: the spec layer (memory 4.6.0, AD-112) delivered to an
// EXISTING deployment on an equal-head upgrade. Four deployed scripts and one store root, written in
// a FIXED order the measured coupling dictates:
//   1. the reader pair   scripts/spec-schema.mjs + .test.mjs      — created when absent; since 2a
//      also REFRESHED when the deployed bytes are a body a release shipped (script-priors.mjs), a
//      custom body preserved verbatim (brief D1 shipped it create-only; the 4.6.x bodies joining the
//      catalog is what keeps those deployments out of the stranded-custom cell);
//   2. the checker pair  scripts/check-docs-size.mjs + .test.mjs  — the same prior-refresh lane, and
//      only behind a reader pair this run leaves byte-current;
//   3. the store root    docs/ai/specs/index.md                   — seeded (placeholders rendered)
//      only once both pairs are current.
// Why the order: the kit's bundled navigator generator collapses `specs/` into one row, while the
// project's pre-commit hook runs ITS deployed checker — an older one renders the store row by row and
// reds `--check-index`. A store root seeded behind a stale checker breaks the hook, so the store is
// the LAST write and admits only behind a checker this run has proven current.
//
// The state table (enumerate by PROOF, never by exclusion): every file is classified into exactly one
// of current | prior | custom | absent | wrong-kind before anything is written, each write admits
// through ONE conjunction of those facts (decideWrites), and every other cell is a stated refusal —
// a custom file of either pair preserves itself AND withholds every write that depends on it. Writes
// run in order and each is idempotent, so a run that stopped partway converges on the next run.
//
// Dependency-free, Node >= 22. Every fs primitive is injectable (deps.*). No side effects on import.

import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { writeContainedFileAtomic, writeProjectFileCreateOnly } from './atomic-write.mjs';
import { classifyDeployedScript } from './script-priors.mjs';
import { composeFailure, composeOutcome, nodeEvidenceRefusal, probeSeedTarget, tmpNote } from './ensure-ops.mjs';

const OP = 'specs';
const SCRIPTS_DIR = 'scripts';
const BUNDLED_SCRIPTS = ['references', 'scripts'];
const STORE_ROOT_REL = 'docs/ai/specs/index.md';
const STORE_ROOT_TEMPLATE = ['references', 'templates', 'specs', 'index.md'];
const DATE_PLACEHOLDER = '{{DATE}}';
// Explicit pairs, deliberately NOT aliased to the catalog's PRIOR_FILES (which spans both): each
// file is surveyed exactly once. Exported so the suite pins pairs-union === catalog domain.
export const READER_PAIR = Object.freeze(['spec-schema.mjs', 'spec-schema.test.mjs']);
export const CHECKER_PAIR = Object.freeze(['check-docs-size.mjs', 'check-docs-size.test.mjs']);

const ok = (token, lines) => composeOutcome(OP, token, lines, false);
const loud = (cause, ...lines) => composeFailure(OP, cause, ...lines);
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

// ── the decision: which writes the survey admits (pure over the survey) ───────────────────────────

// Reader seeds are create-only and always admitted. A REFRESH overwrites bytes, so it runs only
// inside a pair whose every file is proven refreshable (current | prior | absent) — one custom file
// withholds its whole pair; the checker lane (its seeds included) and the store additionally wait
// for a reader pair this run leaves byte-current (seeded + refreshed = current).
const PAIR_ELIGIBLE = new Set(['current', 'prior', 'absent']);

export const decideWrites = ({ reader, checker, store }) => {
  const readerEligible = reader.every((f) => PAIR_ELIGIBLE.has(f.state));
  const checkerEligible = readerEligible && checker.every((f) => PAIR_ELIGIBLE.has(f.state));
  const writes = [];
  for (const f of reader) {
    if (f.state === 'absent') writes.push({ kind: 'seed', file: f });
    if (readerEligible && f.state === 'prior') writes.push({ kind: 'refresh', file: f });
  }
  if (checkerEligible) {
    for (const f of checker) {
      if (f.state === 'absent') writes.push({ kind: 'seed', file: f });
      if (f.state === 'prior') writes.push({ kind: 'refresh', file: f });
    }
  }
  if (checkerEligible && store.state === 'absent') writes.push({ kind: 'store' });
  return { writes, withheld: !checkerEligible };
};

// ── the lines (composed from what HAPPENED, never from what was planned) ──────────────────────────

// Every file's line is a function of its surveyed state and the FATE of its write this run:
// `written` · `stood` (lost the create-only race to the bundled body) · `would` (dry run) ·
// `withheld` (a custom file in the pair) · `stopped` (the run failed before reaching it) · `none`
// (no write was admitted or needed). A line never claims a write that did not happen.
const LEFT_FOR = { withheld: 'it waits on the pair named above', stopped: 'the run stopped before it' };
const SCRIPT_LINES = {
  current: () => 'already the bundled body — nothing written',
  custom: () => "carries a body this kit did not ship as current — preserved verbatim; the writes that depend on it wait until the pair matches the bundled scripts (copy them by hand from the kit's references/scripts/ when convenient, then re-run the upgrade)",
  absent: (fate) => ({
    written: 'copied from the bundled scripts',
    stood: 'appeared while this run was seeding it — the bundled body stands',
    would: 'absent — would be copied from the bundled scripts',
  })[fate] ?? `absent — not copied${fate === 'withheld' ? ' this run' : ''}; ${LEFT_FOR[fate]}`,
  prior: (fate) => `matches a body an earlier release shipped — ${({
    written: 'refreshed to the bundled one',
    would: 'would be refreshed to the bundled one',
  })[fate] ?? `left as is; ${LEFT_FOR[fate]}`}`,
};
const scriptLine = (f, fate) => `${f.rel}: ${SCRIPT_LINES[f.state](fate)}`;
const STORE_LINES = {
  present: 'already present — preserved byte-for-byte, nothing written',
  written: "created from the bundled template (today's date rendered)",
  stood: 'appeared while this run was seeding it — the existing file stands',
  would: 'absent — would be created from the bundled template',
  withheld: "not seeded — an older or edited checker renders the spec store row by row and reds the hook's index check, so the store root waits for a current checker pair",
  stopped: 'absent — not created; the run stopped before it',
};
const storeLine = (store, fate) => `${STORE_ROOT_REL}: ${STORE_LINES[store.state === 'present' ? 'present' : fate]}`;
const relOf = (write) => (write.kind === 'store' ? STORE_ROOT_REL : write.file.rel);

// The fate of every path for the lines: a write that ran carries its result, an admitted write the
// run never reached is `stopped`, and a path with no admitted write is `withheld` behind a custom
// file or `none` when nothing was needed.
const fateOf = (rel, { writes, fates, withheld, stopped }) => {
  if (fates.has(rel)) return fates.get(rel);
  if (writes.some((w) => relOf(w) === rel)) return stopped ? 'stopped' : 'would';
  return withheld ? 'withheld' : 'none';
};
const composeLines = ({ reader, checker, store, writes, fates, withheld, stopped }) => {
  const fate = (rel) => fateOf(rel, { writes, fates, withheld, stopped });
  const lines = [...reader, ...checker].map((f) => scriptLine(f, fate(f.rel)));
  const storeFate = fate(STORE_ROOT_REL);
  if (store.state === 'present' || storeFate !== 'none') lines.push(storeLine(store, storeFate));
  return lines;
};

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

export const ensureSpecs = ({ cwd, kitRoot, dryRun = false, deps = {} }) => {
  const lstat = deps.lstat ?? lstatSync;
  const read = deps.readFile ?? readFileSync;
  const refusal = nodeEvidenceRefusal(OP, cwd, lstat);
  if (refusal) return refusal;
  const survey = (name) => surveyScript({ cwd, kitRoot, name, read, lstat });
  const reader = READER_PAIR.map(survey);
  const checker = CHECKER_PAIR.map(survey);
  const store = surveyStoreRoot(cwd, lstat);
  for (const f of [...reader, ...checker]) {
    if (f.state === 'bundle-unreadable') return loud('bundle-unreadable', `${f.rel}: the bundled script could not be read, so nothing was written — reinstall the kit. ${f.error}`);
  }
  for (const f of [...reader, ...checker, store]) {
    if (f.state === 'wrong-kind') return loud('wrong-node-kind', `${f.rel}: exists but is ${f.wrongKind} — nothing was read or written; resolve it by hand, then re-run`);
  }

  const { writes, withheld } = decideWrites({ reader, checker, store });
  const kinds = new Set(writes.map((w) => w.kind));
  // ONE token by precedence — a write that happened (or, dry, would happen) always outranks the
  // preserved-custom report, which names a run that wrote nothing behind an edited pair.
  const tokenFor = (seeded, refreshed) => {
    if (seeded) return dryRun ? 'would-seed' : 'seeded';
    if (refreshed) return dryRun ? 'would-refresh' : 'refreshed';
    return withheld ? 'customized-preserved' : 'already-present';
  };
  const fates = new Map();
  const linesNow = (stopped) => composeLines({ reader, checker, store, writes, fates, withheld, stopped });
  const writtenCount = () => [...fates.values()].filter((fate) => fate === 'written').length;
  if (dryRun) return ok(tokenFor(kinds.has('seed') || kinds.has('store'), kinds.has('refresh')), linesNow(false));

  let storeBody = null;
  if (kinds.has('store')) {
    try {
      storeBody = renderStoreRoot(kitRoot, read, deps.today ?? todayIso());
    } catch (err) {
      return loud('template-unreadable', `${STORE_ROOT_REL}: ${causeOf(err)}`, ...linesNow(true));
    }
  }
  const writeOne = ({ kind, file }) => {
    if (kind === 'store') return writeProjectFileCreateOnly(cwd, STORE_ROOT_REL, storeBody, deps, { noun: 'the spec store root' });
    if (kind === 'seed') return writeProjectFileCreateOnly(cwd, file.rel, String(file.bundle), deps, { noun: 'a seeded spec-layer script' });
    return writeContainedFileAtomic(cwd, join(cwd, file.rel), String(file.bundle), deps, { label: file.rel });
  };
  // A seed that lost the create-only race is re-PROVEN before anything that depends on it runs: the
  // file that appeared must carry the bundled body, or the tree is changing underneath this run.
  const stoodCurrent = ({ kind, file }) => kind === 'store' || classifyDeployedScript(read(join(cwd, file.rel)), file.name, file.bundle) === 'current';
  const notes = [];
  for (const write of writes) {
    const rel = relOf(write);
    let result;
    try {
      result = writeOne(write);
    } catch (err) {
      return loud('write-refused', `${rel}: ${causeOf(err)}`, ...linesNow(true), ...notes, ...partialNote(writtenCount()));
    }
    if (write.kind !== 'refresh' && !result.created && !stoodCurrent(write)) {
      return loud('race-unresolved', `${rel}: appeared while this run was seeding it and does not carry the bundled body — something is writing there underneath this run; nothing further written, re-run when the tree is settled`, ...linesNow(true), ...notes, ...partialNote(writtenCount()));
    }
    fates.set(rel, write.kind !== 'refresh' && !result.created ? 'stood' : 'written');
    notes.push(...tmpNote(rel, result.tmpLeftBehind));
  }
  const landed = (kind) => writes.some((w) => w.kind === kind && fates.get(relOf(w)) === 'written');
  return ok(tokenFor(landed('seed') || landed('store'), landed('refresh')), [...linesNow(false), ...notes]);
};
