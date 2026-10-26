// ensure-ops.mjs — the upgrade ensure operations this module owns, one function each, behind one shared
// outcome shape; the leaves that import this module compose their outcomes through
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
//     atomic-write.mjs, so the seed never publishes over a file that appears between the probe and the
//     write: a template seed says `already-present`, and the orchestration op reads the file once more and
//     judges it as a present config.
//   • The DECISION lives where the note lives. The orchestration op asks orchestration-readme.mjs
//     (readmeState / withCurrentReadme) and writes every note but the current one current through
//     orchestration-write.mjs — the file's one writer. Nothing here re-derives either.
//   • Every token names a state this run PROVED. `already-present` follows a probe; `skipped-no-node-evidence`
//     names every Node probe that answered absent (the refusal the kit-script and spec-layer ensures
//     share, below; the kit scripts' rule — every kit script written with no question and no copy
//     kept — lives in distribution-files/scripts.mjs).
//   • A failed op is a non-zero signal, never a line that reads like success.
//
// Dependency-free, Node >= 22. Every fs primitive is injectable (deps.*). No side effects on import.

import { readFileSync, lstatSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { CONFIG_REL, SEED_CONFIG, loadConfig } from './orchestration-config.mjs';
import { NOTE_ROUTE, readmeState, withCurrentReadme } from './orchestration-readme.mjs';
import { seedConfig, writeConfig } from './orchestration-write.mjs';
import { lstatNoFollow, writeDocsAiFileAtomic } from './atomic-write.mjs';
import { GATES_REL } from './gates-declaration.mjs';
import { AUTONOMY_REL } from './autonomy-config.mjs';
import { VEHICLES_REL } from './vehicle-settings.mjs';
import { ENSURE_TOKENS, FAILURE_CAUSES } from './ensure-vocabulary.mjs';
import { NODE_EVIDENCE, describeNodeProbes, probeNodeEvidence } from './node-evidence.mjs';
import { classifyDeployedScript } from './script-priors.mjs';
import { parseFrontmatter } from '../references/scripts/check-docs-size.mjs';

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
  WRITE_TOKENS,
} from './ensure-vocabulary.mjs';

const SCRIPTS_DIR = 'scripts';
const VEHICLES_OP = 'vehicles';
const VEHICLES_TEMPLATE = 'vehicles.json';
const VEHICLES_NOUN = 'a vehicle settings declaration';

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

// ── orchestration.json — seed, or write the onboarding note current ──────────────────────────────

// The note is the kit's part of a shared file: every state but `current` is written current, every
// activity and slot kept, and only a differing note's line names where a note of one's own goes.
const NOTE_LINES = {
  absent: ['the onboarding note is absent and would be written', 'the onboarding note was absent and is now written'],
  prior: ['the onboarding note matches a previous canonical and would be refreshed', 'the onboarding note was refreshed to the current canonical'],
  differing: ['the current onboarding note would be written over a different one', 'the current onboarding note was written over a different one'],
};

const applyNoteRefresh = (cwd, config, dryRun, deps) => {
  const state = readmeState(config);
  if (state === 'current') return ok('orchestration', 'already-current', `${CONFIG_REL}: the onboarding note is the current canonical — nothing written`);
  const route = state === 'differing' ? `; ${NOTE_ROUTE}` : '';
  const [wouldBe, written] = NOTE_LINES[state].map((line) => `${CONFIG_REL}: ${line} (every recipe you set is kept)${route}`);
  if (dryRun) return ok('orchestration', 'would-refresh-note', wouldBe);
  writeConfig(cwd, withCurrentReadme(config), deps);
  return ok('orchestration', 'note-refreshed', written);
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
  // It appeared between the probe and the write. The seed published nothing over it; read it once
  // more and judge it as a present config, rather than claim the seed this run did not write.
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

// ── gates.json + autonomy.json + vehicles.json — seed-if-missing, existing file preserved byte-for-byte ───────

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

export const ensureVehicles = ({ cwd, kitRoot, dryRun = false, deps = {} }) =>
  seedFromTemplate({ op: VEHICLES_OP, rel: VEHICLES_REL, template: VEHICLES_TEMPLATE, noun: VEHICLES_NOUN, cwd, kitRoot, dryRun, deps });

// ── scripts/ — the Node-evidence refusal the script-placing ensures share ─────────────────────────

// The Node-evidence refusal every ensure that places Node scripts shares (contract: kit/node-evidence):
// null when Node provably runs here, else the ONE outcome the caller returns — a stated skip naming the
// probes that answered absent, or a fail-closed failure when a probe could not be read.
export const nodeEvidenceRefusal = (op, cwd, lstat) => {
  const evidence = probeNodeEvidence(cwd, lstat);
  if (evidence.state === NODE_EVIDENCE.UNREADABLE) {
    return loud(op, 'node-evidence-unverifiable', `${SCRIPTS_DIR}/: whether Node runs here could not be read (${evidence.error}), so nothing was written — resolve it by hand, then re-run`);
  }
  if (evidence.state === NODE_EVIDENCE.NONE) {
    return ok(op, 'skipped-no-node-evidence', `${SCRIPTS_DIR}/: no Node evidence in this tree — probed ${describeNodeProbes(evidence)}, no regular file present; the seeded pairs are Node enforcement, so nothing written`);
  }
  return null;
};

// ── docs/ai/index.md — the GENERATED navigator, regenerated when missing or stale ───────────────

// The only ensure whose target is generated rather than authored: nothing to seed from, and on the
// bundled path nothing to preserve — the bundled generator IS the writer, driven through its idempotent
// finalizer mode. Sync-over-async by the same precedent the ADR rotator uses (spawnSync the CLI):
// the ensure framework is synchronous, and a second index implementation here would be the drift
// the one-generator rule exists to prevent. Under a hook module that is not the bundled one, the
// project's own checker judges the navigator and a write it rejects is put back (spec docs-navigator).
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
const describeExitWithOutput = (result, subject = 'it') => `${subject} exited ${describeExit(result)}${bothStreams(result) ? `: ${bothStreams(result)}` : ''}`;

const HOOK_MODULES = ['check-docs-size.mjs', 'spec-schema.mjs'];
const KEPT_JUDGE = `the project's own checker (${SCRIPTS_DIR}/check-docs-size.mjs --check-index)`;
const KEPT_FITS = `in sync under ${KEPT_JUDGE} and within the maxLines it stamps`;
const KEPT_ROUTE = "the spec layer's write of the bundled modules the project's hook loads, then this step again";
const KEPT_PROBE_TIMEOUT_MS = 30_000;
const countLines = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
const readStampedCap = (text) => { const value = parseFrontmatter(text)?.maxLines; const cap = value ? Number(value) : NaN; return Number.isNaN(cap) ? undefined : cap; };

const surveyHookModule = (cwd, kitRoot, name, read, lstat) => {
  const rel = `${SCRIPTS_DIR}/${name}`;
  const probe = (() => { try { return probeSeedTarget(join(cwd, rel), lstat); } catch (err) { if (err?.code === 'ENOTDIR') return { present: false }; throw err; } })();
  if (probe.wrongKind || !probe.present) return { rel, state: probe.wrongKind ? 'wrong-kind' : 'absent', wrongKind: probe.wrongKind };
  const deployed = read(join(cwd, rel));
  try {
    return { rel, state: classifyDeployedScript(deployed, name, read(join(kitRoot, ...GENERATOR_PATH.slice(0, 2), name))) };
  } catch (err) {
    return { rel, state: 'bundle-unreadable', error: causeOf(err) };
  }
};

const judgeKept = ({ cwd, spawn, read, lstat, deps }) => {
  const result = spawn(process.execPath, [join(cwd, SCRIPTS_DIR, 'check-docs-size.mjs'), '--check-index'], { cwd, encoding: 'utf8', timeout: deps.keptProbeTimeoutMs ?? KEPT_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' });
  if (result.error) return { error: `${causeOf(result.error)}${result.signal ? `, killed on signal ${result.signal}` : ''}` };
  if (result.status !== 0) return { accepted: false, said: describeExitWithOutput(result), half: 'its index check' };
  const text = lstatNoFollow(join(cwd, INDEX_REL), lstat)?.isFile() ? String(read(join(cwd, INDEX_REL), 'utf8')) : null;
  const cap = text === null ? undefined : readStampedCap(text);
  if (cap !== undefined && countLines(text) <= Number(cap)) return { accepted: true };
  const why = text === null ? 'no navigator file stands' : cap === undefined ? 'the navigator stamps no maxLines' : `${countLines(text)} lines against the maxLines ${cap} it stamps`;
  return { accepted: false, said: describeExitWithOutput(result), half: `the cap it stamps (${why})` };
};

const removeIndexIfPresent = (cwd, deps) => {
  try {
    (deps.unlink ?? unlinkSync)(join(cwd, INDEX_REL));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
};

const putBackIndex = (cwd, found, deps) => {
  try {
    if (found !== null) writeDocsAiFileAtomic(cwd, INDEX_REL, found, deps, { noun: 'the navigator' });
    else removeIndexIfPresent(cwd, deps);
  } catch (err) {
    return causeOf(err);
  }
  return null;
};

const ensureKeptIndex = ({ cwd, drive, spawn, read, lstat, deps }) => {
  const judge = () => judgeKept({ cwd, spawn, read, lstat, deps });
  const reportUnanswered = (verdict, after) => loud('index', 'index-probe-failed', `${INDEX_REL}: ${KEPT_JUDGE} could not be launched or did not answer in time (${verdict.error}) — ${after}`);
  const first = judge();
  if (first.error) return reportUnanswered(first, 'nothing was written');
  if (first.accepted) return ok('index', 'already-current', `${INDEX_REL}: ${KEPT_FITS} — nothing written`);
  const found = lstatNoFollow(join(cwd, INDEX_REL), lstat) === null ? null : read(join(cwd, INDEX_REL));
  const restored = found === null ? 'the navigator was put back: found absent, it was removed again' : 'the navigator was put back byte for byte';
  const restoreThen = (failure, compose) => {
    const refused = putBackIndex(cwd, found, deps);
    return refused === null ? compose() : loud('index', 'write-refused', `${INDEX_REL}: putting the navigator back failed (${refused})${failure ? ` after ${failure}` : ''} — a navigator ${KEPT_JUDGE} rejects may stand; re-read it before re-running`);
  };
  const run = drive('--ensure-index');
  const refusal = String(run.stderr ?? '').match(ENSURE_INDEX_REFUSAL);
  if (run.error || run.status !== 0 || !String(run.stdout ?? '').match(ENSURE_INDEX_OUTCOME)) {
    const cause = run.error ? 'generator-unlaunchable' : run.status === 2 && refusal ? (refusal[1] === 'write-refused' ? 'write-refused' : 'index-probe-failed') : 'generator-failed';
    const what = run.error ? `the bundled generator could not be started (${causeOf(run.error)})` : describeExitWithOutput(run, 'the bundled generator');
    return restoreThen(what, () => loud('index', cause, `${INDEX_REL}: ${what} — ${restored}`));
  }
  let second;
  try { second = judge(); } catch (err) { return restoreThen(`the navigator could not be read back (${causeOf(err)})`, () => loud('index', 'unexpected-error', `${INDEX_REL}: the navigator could not be read back after the bundled write (${causeOf(err)}) — ${restored}`)); }
  if (second.error) return restoreThen(`${KEPT_JUDGE} could not answer (${second.error})`, () => reportUnanswered(second, restored));
  if (second.accepted) return ok('index', 'regenerated', `${INDEX_REL}: written by the bundled generator — ${KEPT_FITS}`);
  return restoreThen(null, () => ok('index', 'customized-preserved', `${INDEX_REL}: ${KEPT_JUDGE} rejected the bundled render on ${second.half} (${second.said}), and the navigator as found did not pass it either (${first.half}) — ${restored}. The route: ${KEPT_ROUTE}`));
};

const buildKeptDryRunNote = (hook) =>
  `a module the project's hook loads (${hook.filter((entry) => entry.state !== 'current').map((entry) => entry.rel).join(', ')}) is not the bundled one: unless the spec-layer step of this run first refreshes every such module, the real run judges the navigator by ${KEPT_JUDGE} and puts back a write it rejects`;

export const ensureIndex = ({ cwd, kitRoot, dryRun = false, deps = {} }) => {
  const lstat = deps.lstat ?? lstatSync;
  const read = deps.readFile ?? readFileSync;
  const spawn = deps.spawnSync ?? spawnSync;
  const generator = join(kitRoot, ...GENERATOR_PATH);
  const drive = (mode) => spawn(process.execPath, [generator, mode, `--root=${cwd}`], { encoding: 'utf8' });
  const unlaunchable = (result) =>
    loud('index', 'generator-unlaunchable', `${INDEX_REL}: the bundled generator could not be started, so nothing was probed or written — reinstall the kit. ${causeOf(result.error)}`);

  const probe = probeSeedTarget(join(cwd, INDEX_REL), lstat);
  if (probe.wrongKind) {
    return loud('index', 'wrong-node-kind', `${INDEX_REL}: exists but is ${probe.wrongKind} — the navigator is a generated file and this is not one; nothing was read or written, resolve it by hand and re-run`);
  }
  const hook = HOOK_MODULES.reduce((acc, name) => (acc[0]?.state === 'absent' || acc[0]?.wrongKind ? acc : [...acc, surveyHookModule(cwd, kitRoot, name, read, lstat)]), []);
  const wrong = hook.find((entry) => entry.state === 'wrong-kind');
  if (wrong) return loud('index', 'wrong-node-kind', `${wrong.rel}: exists but is ${wrong.wrongKind} — the project's hook loads it, so nothing was read or written; resolve it by hand and re-run`);
  const kept = hook[0].state !== 'absent' && !hook.every((entry) => entry.state === 'current');
  const unreadable = kept && hook.find((entry) => entry.state === 'bundle-unreadable');
  if (unreadable) return loud('index', 'bundle-unreadable', `${unreadable.rel}: the bundled module could not be read, so nothing was written — reinstall the kit. ${unreadable.error}`);
  if (kept && !dryRun) return ensureKeptIndex({ cwd, drive, spawn, read, lstat, deps });
  const dryNote = kept ? [buildKeptDryRunNote(hook)] : [];
  if (dryRun) {
    const check = drive('--check-index');
    if (check.error) return unlaunchable(check);
    const out = bothStreams(check);
    if (check.status === 0 && PROBE_FRESH.test(out)) return ok('index', 'already-current', `${INDEX_REL}: in sync with the source frontmatter — nothing would be written`, ...dryNote);
    if (check.status === 1 && PROBE_STALE.test(out)) return ok('index', 'would-regenerate', `${INDEX_REL}: missing or stale — would be written from the source frontmatter`, ...dryNote);
    return loud('index', 'index-probe-failed', `${INDEX_REL}: the freshness probe answered neither fresh nor stale (exited ${describeExit(check)}), so nothing was written. ${out}`, ...dryNote);
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

// The ops this module owns, by name. The CLI composes the full ENSURE_OPS table from these plus
// the leaves that import THIS module, which join the table in ensure-configs.mjs (so it cannot live here).
export const OWN_IMPLEMENTATIONS = Object.freeze({
  orchestration: ensureOrchestration,
  gates: ensureGates,
  autonomy: ensureAutonomy,
  vehicles: ensureVehicles,
  index: ensureIndex,
});
