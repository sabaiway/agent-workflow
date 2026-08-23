// ensure-ops.mjs — FIVE of the upgrade ensure operations, one function each, behind one shared
// outcome shape; the sixth (the spec-layer ensure, ensure-specs.mjs) composes its outcomes through
// the same door and probes exported below. The CLI that orders and runs them is ensure-configs.mjs —
// it owns the op table, so the import graph stays acyclic; this module owns what each ensure DOES
// and, more importantly, what it is allowed to CLAIM.
//
// Why they became code at all: `references/modes/upgrade.md` prescribed each of them as prose an agent
// was expected to carry out by hand ("create it from the template if missing", "copy the pair from
// references/scripts/ if missing"). A prescribed state-changing operation with no runnable command is
// a step that silently varies per session — the feedback item this phase answers.
//
// The invariants every op holds (they are what the tests pin):
//   • CREATE-ONLY seeds. A seed never clobbers: the write is the link-based create-only arm of
//     atomic-write.mjs, so a file that appears between the probe and the write survives byte-for-byte
//     and the op says `already-present` rather than reporting a write it did not do.
//   • The DECISION lives where it already lived. The orchestration `_README` refresh asks
//     orchestration-config.mjs (refreshReadme / the known-prior canonical set) and writes through
//     orchestration-write.mjs — the file's one writer. Nothing here re-derives either.
//   • Every token names a state this run PROVED. `already-present` follows a probe; `skipped-no-node`
//     names the missing package.json; an ADR-layout read that fails is `adr-layout-unverifiable` and
//     writes NOTHING (the STRICT survey, fail-closed — the lenient status wrapper reads an unreadable
//     tree as `none`, which here would mean seeding a rotator beside a store nobody could inspect).
//   • A failed op is a non-zero signal, never a line that reads like success.
//
// Dependency-free, Node >= 22. Every fs primitive is injectable (deps.*). No side effects on import.

import { readFileSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { CANON_README, CONFIG_REL, SEED_CONFIG, loadConfig, normalizeCanonical, refreshReadme } from './orchestration-config.mjs';
import { seedConfig, writeConfig } from './orchestration-write.mjs';
import { lstatNoFollow, writeDocsAiFileAtomic, writeProjectFileCreateOnly } from './atomic-write.mjs';
import { GATES_REL } from './gates-declaration.mjs';
import { AUTONOMY_REL } from './autonomy-config.mjs';
import { surveyAdrLayoutStrict } from './family-registry.mjs';
import { ENSURE_TOKENS, FAILURE_CAUSES, SEED_SCRIPTS } from './ensure-vocabulary.mjs';

// The closed vocabulary lives in its own PURE leaf so the read-only doc-parity lint can bind the
// relayed token set without importing this module's writer graph. Re-exported here because every
// consumer of the ops also speaks the vocabulary.
export {
  ENSURE_OPS,
  ENSURE_TOKENS,
  DRY_RUN_TOKENS,
  FAILURE_CAUSES,
  RELAYED_ENSURE_TOKENS,
  RELAYED_FAILURE_CAUSES,
  SEED_SCRIPTS,
  WRITE_TOKENS,
} from './ensure-vocabulary.mjs';

const PACKAGE_JSON = 'package.json';
const SCRIPTS_DIR = 'scripts';

const outcome = (op, token, lines, failed = false) => {
  if (!ENSURE_TOKENS.includes(token)) {
    throw new Error(`[agent-workflow-kit] unknown ensure outcome "${token}" — the token vocabulary is closed`);
  }
  return { op, token, failed, lines };
};
const ok = (op, token, ...lines) => outcome(op, token, lines, false);
// A LOUD failure the doc gives its OWN token (today: malformed-preserved — the file is preserved, and
// that is exactly what the reader must be told).
const loudToken = (op, token, ...lines) => outcome(op, token, lines, true);
// Every other LOUD failure: the token is always `failed`, the closed cause word opens the first line.
const loud = (op, cause, ...lines) => {
  if (!FAILURE_CAUSES.includes(cause)) {
    throw new Error(`[agent-workflow-kit] unknown ensure failure cause "${cause}" — the cause vocabulary is closed`);
  }
  return outcome(op, 'failed', [`${cause} — ${lines[0]}`, ...lines.slice(1)], true);
};

// The closed-vocabulary DOOR, exported as a seam so the refusal itself is testable: EVERY outcome in
// this module is composed through one of these two, and a word outside the closed sets throws here
// instead of reaching a caller that has no idea how to relay it.
export const composeOutcome = outcome;
export const composeFailure = loud;

const causeOf = (err) => String((err && err.message) || err);

// The CLI's catch-all, here rather than there so EVERY outcome in the system — including the one
// nobody planned for — is composed through the closed vocabulary. A throw that reached here is
// `unexpected-error`: the cause word is still one of the closed set, and the thrown message follows
// it (a bare `${op}: …` line would be the one failure in the system that names no cause).
export const failedOutcome = (op, err) => loud(op, 'unexpected-error', `${op}: ${causeOf(err)}`);

// `already-present` must mean a FILE is there. An lstat that merely finds SOMETHING would let a
// directory or a symlink named gates.json report a green ensure while the declaration the project
// needs does not exist — an exit 0 proving nothing (both review backends found this).
const NODE_KIND = (st) => (st.isSymbolicLink() ? 'a symlink' : st.isDirectory() ? 'a directory' : 'not a regular file');
export const probeSeedTarget = (abs, lstat) => {
  const st = lstatNoFollow(abs, lstat);
  if (st === null) return { present: false };
  return st.isFile() ? { present: true } : { present: true, wrongKind: NODE_KIND(st) };
};

// A leftover temp file never fails a completed write, and is never silent either.
export const tmpNote = (rel, tmpLeftBehind) =>
  (tmpLeftBehind ? [`${rel}: the write stands, but its temp file could not be removed — delete it by hand: ${tmpLeftBehind}`] : []);

// ── 1. orchestration.json — seed, or refresh ONLY a still-canonical onboarding note ────────────────

// Which no-change outcome is it? refreshReadme returns `changed: false` for two very different trees:
// a note that already IS the current canonical, and a note the user rewrote. Reporting both as
// "already current" would claim the second is something it is not.
const unchangedNoteToken = (config) =>
  normalizeCanonical(config?._README ?? '') === normalizeCanonical(CANON_README) ? 'already-current' : 'customized-preserved';

const applyNoteRefresh = (cwd, config, dryRun, deps) => {
  const { config: next, changed } = refreshReadme(config);
  if (!changed) {
    const token = unchangedNoteToken(config);
    return ok(
      'orchestration',
      token,
      token === 'already-current'
        ? `${CONFIG_REL}: the onboarding note is the current canonical — nothing written`
        : `${CONFIG_REL}: the onboarding note carries your own wording — preserved verbatim, nothing written`,
    );
  }
  if (dryRun) return ok('orchestration', 'would-refresh-note', `${CONFIG_REL}: the onboarding note matches a previous canonical and would be refreshed (every recipe you set is kept)`);
  writeConfig(cwd, next, deps);
  return ok('orchestration', 'note-refreshed', `${CONFIG_REL}: the onboarding note was refreshed to the current canonical (every recipe you set is kept)`);
};

// A load failure is not automatically "malformed": a file that VANISHED between the reader's own
// lstat and its read surfaces as unreadable, and calling that preserved-and-malformed would state
// two things this run did not observe. Probe once more and classify by what is there NOW.
const loadFailureOutcome = (cwd, err, lstat, whenSeeding) => {
  if (lstatNoFollow(join(cwd, CONFIG_REL), lstat) === null) {
    return loud('orchestration', 'race-unresolved', `${CONFIG_REL}: could not be read and is not there now — something is creating and removing it underneath this run; nothing written, re-run when the tree is settled`);
  }
  const where = whenSeeding ? 'appeared while this run was seeding it, and ' : '';
  return loudToken('orchestration', 'malformed-preserved', `${CONFIG_REL}: ${where}could not be read as the config it must be — preserved untouched, nothing written. ${causeOf(err)}`);
};

export const ensureOrchestration = ({ cwd, dryRun = false, deps = {} }) => {
  const read = deps.readFile ?? readFileSync;
  const lstat = deps.lstat ?? lstatSync;
  // The KIND comes before the content: a symlink pointing at valid JSON parses fine and would report
  // `already-current` over a file this ensure would refuse to write through — an exit 0 that proves
  // nothing about the config the project actually has.
  const kind = probeSeedTarget(join(cwd, CONFIG_REL), lstat);
  if (kind.wrongKind) {
    return loud('orchestration', 'wrong-node-kind', `${CONFIG_REL}: exists but is ${kind.wrongKind} — nothing was read or written; resolve it by hand, then re-run`);
  }
  let loaded;
  try {
    loaded = loadConfig(cwd, read, lstat);
  } catch (err) {
    // Malformed / unreadable: preserved untouched, and LOUD — clobbering a file we cannot parse would
    // destroy hand-authored configuration to fix a note.
    return loadFailureOutcome(cwd, err, lstat, false);
  }
  if (loaded.config !== null) return applyNoteRefresh(cwd, loaded.config, dryRun, deps);
  if (dryRun) return ok('orchestration', 'would-seed', `${CONFIG_REL}: absent — would be created from the canonical seed`);

  const { created, tmpLeftBehind } = seedConfig(cwd, SEED_CONFIG, deps);
  const seedNote = tmpNote(CONFIG_REL, tmpLeftBehind);
  if (created) return ok('orchestration', 'seeded', `${CONFIG_REL}: created from the canonical seed`, ...seedNote);
  // It appeared between the probe and the write. Nothing was overwritten; read it once more and
  // report what it now IS, rather than a claim about the file we did not write.
  let second;
  try {
    second = loadConfig(cwd, read, lstat);
  } catch (err) {
    return loadFailureOutcome(cwd, err, lstat, true);
  }
  if (second.config === null) {
    return loud('orchestration', 'race-unresolved', `${CONFIG_REL}: something is creating and removing this file underneath this run — nothing written; re-run when the tree is settled`, ...seedNote);
  }
  const refreshed = applyNoteRefresh(cwd, second.config, dryRun, deps);
  return { ...refreshed, lines: [...refreshed.lines, ...seedNote] };
};

// ── 2/3. gates.json + autonomy.json — seed-if-missing, existing file preserved byte-for-byte ───────

const seedFromTemplate = ({ op, rel, template, noun, cwd, kitRoot, dryRun, deps }) => {
  const lstat = deps.lstat ?? lstatSync;
  const read = deps.readFile ?? readFileSync;
  const probe = probeSeedTarget(join(cwd, rel), lstat);
  if (probe.wrongKind) {
    return loud(op, 'wrong-node-kind', `${rel}: exists but is ${probe.wrongKind} — nothing was written, and this is NOT a usable declaration; resolve it by hand, then re-run`);
  }
  if (probe.present) return ok(op, 'already-present', `${rel}: already present — preserved byte-for-byte, nothing written`);
  if (dryRun) return ok(op, 'would-seed', `${rel}: absent — would be created from the bundled template`);
  let body;
  try {
    body = String(read(join(kitRoot, 'references', 'templates', template), 'utf8'));
  } catch (err) {
    return loud(op, 'template-unreadable', `${rel}: the bundled template could not be read, so nothing was written — reinstall the kit. ${causeOf(err)}`);
  }
  const { created, tmpLeftBehind } = writeDocsAiFileAtomic(cwd, rel, body, deps, { noun, createOnly: true });
  return created
    ? ok(op, 'seeded', `${rel}: created from the bundled template`, ...tmpNote(rel, tmpLeftBehind))
    : ok(op, 'already-present', `${rel}: appeared while this run was seeding it — the existing file stands, byte-for-byte`, ...tmpNote(rel, tmpLeftBehind));
};

export const ensureGates = ({ cwd, kitRoot, dryRun = false, deps = {} }) =>
  seedFromTemplate({ op: 'gates', rel: GATES_REL, template: 'gates.json', noun: 'a gate declaration', cwd, kitRoot, dryRun, deps });

export const ensureAutonomy = ({ cwd, kitRoot, dryRun = false, deps = {} }) =>
  seedFromTemplate({ op: 'autonomy', rel: AUTONOMY_REL, template: 'autonomy.json', noun: 'an autonomy policy', cwd, kitRoot, dryRun, deps });

// ── 4. scripts/ — the ADR-cascade enforcement pairs, detect-first ──────────────────────────────────

// A project with no package.json at its root is not where Node enforcement scripts belong. Stated,
// never silent: the token names the evidence, and the three config ensures still run.
export const isNodeProject = (cwd, lstat) => lstatNoFollow(join(cwd, PACKAGE_JSON), lstat) !== null;

const OLD_ADR_LAYOUTS = new Set(['old', 'old-unrotated']);

// The scripts ensure copies file by file, so a failure PARTWAY leaves earlier copies in place. Saying
// so is the difference between a failure the reader can act on and one they read as "nothing happened"
// — the CLI's summary therefore claims nothing about writes, and this line states the truth per op.
const partialNote = (lines) => {
  const copied = lines.filter((line) => line.includes(': copied from the bundled scripts')).length;
  return copied > 0 ? [`the copying stopped PARTWAY — the ${copied} file(s) named above were already copied and are NOT rolled back`] : [];
};

export const ensureScripts = ({ cwd, kitRoot, dryRun = false, deps = {} }) => {
  const lstat = deps.lstat ?? lstatSync;
  const read = deps.readFile ?? readFileSync;
  if (!isNodeProject(cwd, lstat)) {
    return ok('scripts', 'skipped-no-node', `${SCRIPTS_DIR}/: no ${PACKAGE_JSON} at the project root — the seeded pairs are Node enforcement; nothing written`);
  }
  let layout;
  try {
    layout = surveyAdrLayoutStrict(cwd, deps);
  } catch (err) {
    return loud('scripts', 'adr-layout-unverifiable', `${SCRIPTS_DIR}/: the ADR-store layout could not be read, so nothing was written — a rotator seeded beside an un-migrated store reds the ADR gate. ${causeOf(err)}`);
  }
  if (OLD_ADR_LAYOUTS.has(layout)) {
    return ok(
      'scripts',
      'old-adr-layout-migration-instructed',
      `${SCRIPTS_DIR}/: this project is still on the older ADR layout (${layout}) — nothing written. Run the opt-in /agent-workflow-kit migrate-adr-store (it previews, and never commits); the seed lands on the next upgrade.`,
    );
  }
  const lines = [];
  let anyCreated = false;
  for (const name of SEED_SCRIPTS) {
    const rel = `${SCRIPTS_DIR}/${name}`;
    const probe = probeSeedTarget(join(cwd, SCRIPTS_DIR, name), lstat);
    if (probe.wrongKind) {
      return loud('scripts', 'wrong-node-kind', `${rel}: exists but is ${probe.wrongKind} — that is not the enforcement script this run places`, ...lines, ...partialNote(lines));
    }
    if (probe.present) {
      lines.push(`${rel}: already present — preserved, never overwritten`);
      continue;
    }
    if (dryRun) {
      lines.push(`${rel}: absent — would be copied from the bundled scripts`);
      continue;
    }
    let body;
    try {
      body = String(read(join(kitRoot, 'references', 'scripts', name), 'utf8'));
    } catch (err) {
      return loud('scripts', 'bundle-unreadable', `${rel}: the bundled script could not be read — reinstall the kit. ${causeOf(err)}`, ...lines, ...partialNote(lines));
    }
    // The WRITE is caught here, not by the CLI's catch-all: a throw that escapes this loop would take
    // the accumulated lines with it, and the run would report a failure without saying which files it
    // had already copied.
    let result;
    try {
      result = writeProjectFileCreateOnly(cwd, rel, body, deps, { noun: 'a seeded enforcement script' });
    } catch (err) {
      return loud('scripts', 'write-refused', `${rel}: ${causeOf(err)}`, ...lines, ...partialNote(lines));
    }
    anyCreated = anyCreated || result.created;
    lines.push(result.created ? `${rel}: copied from the bundled scripts` : `${rel}: appeared while this run was seeding it — the existing file stands`);
    lines.push(...tmpNote(rel, result.tmpLeftBehind));
  }
  if (dryRun) {
    const wouldSeed = lines.some((line) => line.includes('would be copied'));
    return outcome('scripts', wouldSeed ? 'would-seed' : 'already-present', lines, false);
  }
  return outcome('scripts', anyCreated ? 'seeded' : 'already-present', lines, false);
};

// ── 5. docs/ai/index.md — the GENERATED navigator, regenerated when missing or stale ───────────────

// The only ensure whose target is generated rather than authored: there is nothing to preserve, and
// nothing to seed from either — the bundled generator IS the writer, driven through its idempotent
// finalizer mode. Sync-over-async by the same precedent the ADR rotator uses (spawnSync the CLI):
// the ensure framework is synchronous, and a second index implementation here would be the drift
// the one-generator rule exists to prevent.
const INDEX_REL = 'docs/ai/index.md';
const GENERATOR_PATH = ['references', 'scripts', 'check-docs-size.mjs'];
const ENSURE_INDEX_OUTCOME = /^ensure-index: (regenerated|already-current)\b/m;
const ENSURE_INDEX_REFUSAL = /^ensure-index: (write-refused|probe-failed)\b/m;
// The probe has no machine line, so its two ANSWERS are matched against the canonical sentences it
// composes — anchored, not a loose substring: a failure that merely CONTAINS "is stale" (a path, an
// error quoting the checker's own advice) would otherwise pass for a stale verdict and fail OPEN.
const PROBE_FRESH = /^\[check-docs-size\] OK — .+ is in sync with source frontmatter\./m;
const PROBE_STALE = /^\[check-docs-size\] FAIL: .+ is stale \(out of sync with source frontmatter\)\./m;
// Only the LAUNCH and the pre-write probe are provably zero-write. Once the generator has run, a
// failure must say that a write may already have landed — the reader's next step depends on it.
const MAY_HAVE_WRITTEN = 'the navigator may already have been written — re-read it before re-running';

const describeExit = (result) => (result.signal ? `on signal ${result.signal}` : `with code ${result.status}`);
const bothStreams = (result) => `${String(result.stdout ?? '')}${String(result.stderr ?? '')}`.trim();

export const ensureIndex = ({ cwd, kitRoot, dryRun = false, deps = {} }) => {
  const lstat = deps.lstat ?? lstatSync;
  const spawn = deps.spawnSync ?? spawnSync;
  const generator = join(kitRoot, ...GENERATOR_PATH);
  const drive = (mode) => spawn(process.execPath, [generator, mode, `--root=${cwd}`], { encoding: 'utf8' });
  const unlaunchable = (result) =>
    loud('index', 'generator-unlaunchable', `${INDEX_REL}: the bundled generator could not be started, so nothing was probed or written — reinstall the kit. ${causeOf(result.error)}`);

  const probe = probeSeedTarget(join(cwd, INDEX_REL), lstat);
  if (probe.wrongKind) {
    return loud('index', 'wrong-node-kind', `${INDEX_REL}: exists but is ${probe.wrongKind} — the navigator is a generated file and this is not one; nothing was read or written, resolve it by hand and re-run`);
  }

  if (dryRun) {
    const check = drive('--check-index');
    if (check.error) return unlaunchable(check);
    const out = bothStreams(check);
    if (check.status === 0 && PROBE_FRESH.test(out)) return ok('index', 'already-current', `${INDEX_REL}: in sync with the source frontmatter — nothing would be written`);
    if (check.status === 1 && PROBE_STALE.test(out)) return ok('index', 'would-regenerate', `${INDEX_REL}: missing or stale — would be written from the source frontmatter`);
    return loud('index', 'index-probe-failed', `${INDEX_REL}: the freshness probe answered neither fresh nor stale (exited ${describeExit(check)}), so nothing was written. ${out}`);
  }

  const run = drive('--ensure-index');
  if (run.error) return unlaunchable(run);
  const outcome = String(run.stdout ?? '').match(ENSURE_INDEX_OUTCOME);
  const refusal = String(run.stderr ?? '').match(ENSURE_INDEX_REFUSAL);
  if (run.status === 2 && refusal) {
    // The generator's OWN closed refusals: a write it would not publish, and a probe that could not
    // answer. Each keeps its identity here rather than collapsing into "the generator failed".
    const cause = refusal[1] === 'write-refused' ? 'write-refused' : 'index-probe-failed';
    return loud('index', cause, `${INDEX_REL}: ${bothStreams(run)}`);
  }
  if (run.status !== 0 || !outcome) {
    return loud('index', 'generator-failed', `${INDEX_REL}: the generator exited ${describeExit(run)} without a recognized outcome line — ${MAY_HAVE_WRITTEN}. ${bothStreams(run)}`);
  }
  if (outcome[1] === 'already-current') return ok('index', 'already-current', `${INDEX_REL}: in sync with the source frontmatter — nothing written`);

  // A claimed regeneration is not a verified one: re-probe, so `regenerated` names a state this run
  // PROVED rather than a line the generator printed. The verdict is read from the probe's own two
  // ANSWERS — an exit code alone would turn a probe that merely FAILED (exit 1 on an unreadable
  // tree) into a false "still stale after the write".
  const verify = drive('--check-index');
  const verdict = verify.error ? '' : bothStreams(verify);
  if (!verify.error && verify.status === 0 && PROBE_FRESH.test(verdict)) {
    return ok('index', 'regenerated', `${INDEX_REL}: written from the source frontmatter — the navigator is in sync again`);
  }
  if (!verify.error && verify.status === 1 && PROBE_STALE.test(verdict)) {
    return loud('index', 'index-stale-after-write', `${INDEX_REL}: the generator reported a regeneration, but the re-probe still reads the navigator as missing or stale — ${MAY_HAVE_WRITTEN}. ${verdict}`);
  }
  return loud('index', 'index-probe-failed', `${INDEX_REL}: the generator reported a regeneration, but the verifying probe answered neither fresh nor stale — ${MAY_HAVE_WRITTEN}. ${verify.error ? causeOf(verify.error) : verdict}`);
};

// The five ops this module owns, by name. The CLI composes the full ENSURE_OPS table from these plus
// the spec-layer ensure (ensure-specs.mjs imports THIS module, so the table cannot live here).
export const OWN_IMPLEMENTATIONS = Object.freeze({
  orchestration: ensureOrchestration,
  gates: ensureGates,
  autonomy: ensureAutonomy,
  scripts: ensureScripts,
  index: ensureIndex,
});
