#!/usr/bin/env node
// tier-preview.mjs — the offer of lineage step 4.0.0: one preview over the whole profile-gap
// registry; on an explicit yes (--apply) the absent epic and task slots and the epic store seed;
// on an explicit no (--decline) the decline record. Governing contract:
// docs/ai/specs/kit/tier/tier-offer/ (part tier-preview). main(argv, deps) returns, never exits,
// never asks; every read and write goes through deps.
import { linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertDocsAiDeployment, writeDocsAiFileAtomic, writeProjectFileCreateOnly } from './atomic-write.mjs';
import { safeLine } from './carriers.mjs';
import { isDirectRun } from './direct-run.mjs';
import { tmpNote } from './ensure-ops.mjs';
import { CANON_README, applySetOps, refreshReadme } from './orchestration-config.mjs';
import { writeConfig } from './orchestration-write.mjs';
import { PROFILE_GAPS, readTierConfig } from './profile-gaps.mjs';
import { composeReadiness, planRecipe } from './recipes.mjs';
import { TIER_TARGETS, isDeclineCurrent, readDeclines, readShippedProfile } from './reference-profile.mjs';

const LF = String.fromCharCode(10);
const ARGV_OFFSET = 2;
const EXIT_SUCCESS = 0;
const EXIT_REFUSAL = 1;
const EXIT_USAGE = 2;
const CWD_FLAG = '--cwd';
const APPLY_FLAG = '--apply';
const DECLINE_FLAG = '--decline';
const HELP_FLAGS = new Set(['--help', '-h']);
const MODE_FLAGS = new Set([APPLY_FLAG, DECLINE_FLAG]);
const SLOTS_ID = 'epic-task-slots';
const STORE_ID = 'epic-store-seeded';
const STORE_DIR = 'docs/ai/epics';
const STORE_SEED = 'docs/ai/epics/.gitkeep';
const CONFIG_WRITTEN = 'docs/ai/orchestration.json';
const DECLINES_REL = 'docs/ai/profile-declines.json';
const SCHEMA = 1;
const INDENT = '  ';
const WORDS = Object.freeze({
  present: 'present',
  offered: 'offered',
  declined: 'declined',
  undecidable: 'undecidable',
  applied: 'applied',
  recorded: 'recorded',
});
const ABSENT_VERDICT = 'absent';
const PRESENT_VERDICT = 'present';

export const OUTCOME_LINES = Object.freeze({
  entry: (id, word, detail) => `${id}: ${word}${detail ? ` — ${detail}` : ''}`,
  declinedAt: (lineage) => `at lineage ${lineage}`,
  applyLine: (command) => `${INDENT}apply: ${command}`,
  noCommand: () => `${INDENT}apply: no runnable command — the root or the kit path carries a control byte or a backtick`,
  slotValue: (activity, slot, value, skipped = []) => `${INDENT}${activity}.${slot} = ${value}`
    + skipped.map(({ candidate, reason }) => ` — ${candidate} skipped: ${reason}`).join(''),
  slotPresent: (activity, slot) => `${INDENT}${activity}.${slot}: present`,
  tmpLeft: (tmp) => tmpNote(STORE_SEED, tmp)[0],
  nothingOffered: () => 'nothing offered — nothing recorded',
  detectFailed: (cause) => `backend detection failed (${safeLine(cause)}) — every bridge is treated as not ready`,
  refusal: (name, detail) => `tier-preview: refused — ${name}${detail ? `: ${safeLine(detail)}` : ''}`,
  usage: (problem) => `usage: tier-preview.mjs --cwd DIR [--apply | --decline] — ${safeLine(problem)}`,
  help: () => [
    'tier-preview.mjs --cwd DIR [--apply | --decline]',
    'Previews every profile gap of the project in DIR; writes nothing by default.',
    '--apply writes the offered items: the absent epic and task settings and the epic store seed.',
    '--decline records every offered item as declined at the shipped profile lineage.',
    'Exit codes: 0 done, 1 one named refusal, 2 usage.',
  ].join(LF),
});

const result = (code, stdout = '', stderr = '') => ({ code, stdout, stderr });
const refuse = (name, detail) => result(EXIT_REFUSAL, '', OUTCOME_LINES.refusal(name, detail));
const causeOf = (error) => String(error?.message ?? error);

const parseArgs = (argv) => {
  if (argv.length === 1 && HELP_FLAGS.has(argv[0])) return { help: true };
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === CWD_FLAG) {
      if (options.cwd !== undefined) return { problem: `${CWD_FLAG} given twice` };
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) return { problem: `${CWD_FLAG} needs a directory` };
      options.cwd = value;
      index += 1;
    } else if (MODE_FLAGS.has(flag)) {
      if (options[flag]) return { problem: `${flag} given twice` };
      options[flag] = true;
    } else {
      return { problem: `unknown argument ${flag}` };
    }
  }
  if (options.cwd === undefined) return { problem: `${CWD_FLAG} is required` };
  if (options[APPLY_FLAG] && options[DECLINE_FLAG]) return { problem: `${APPLY_FLAG} and ${DECLINE_FLAG} exclude each other` };
  return { cwd: options.cwd, apply: Boolean(options[APPLY_FLAG]), decline: Boolean(options[DECLINE_FLAG]) };
};

const withFs = (deps) => ({
  lstatSync, readFileSync, lstat: lstatSync, writeFile: writeFileSync, rename: renameSync, link: linkSync,
  rm: (path) => rmSync(path, { force: true }), mkdir: (path) => mkdirSync(path, { recursive: true }), ...deps,
});

// The resolution walk: the first candidate planRecipe reports not degraded wins; every candidate
// before it carries that plan's own first degrade reason.
// solo, every target's last candidate, is always satisfiable, so the find always answers.
const resolveTarget = ({ candidates }, readiness) => {
  const skipped = [];
  const value = candidates.find((candidate) => {
    const plan = planRecipe(candidate, readiness);
    if (plan.degraded) skipped.push({ candidate, reason: plan.degradation[0].reason });
    return !plan.degraded;
  });
  return { value, skipped };
};

const planSlots = (config, readiness) => TIER_TARGETS.map((target) => {
  const declared = Object.hasOwn(config[target.activity] ?? {}, target.slot);
  return declared ? { target, declared } : { target, declared, ...resolveTarget(target, readiness) };
});

const slotLines = (slots) => slots.map(({ target, declared, value, skipped }) => (declared
  ? OUTCOME_LINES.slotPresent(target.activity, target.slot)
  : OUTCOME_LINES.slotValue(target.activity, target.slot, value, skipped)));

const judgeEntries = (root, deps, profile, declined) => PROFILE_GAPS.map((entry) => {
  const detected = entry.detect({ root, deps });
  if (detected.verdict === PRESENT_VERDICT) return { entry, word: WORDS.present };
  if (detected.verdict !== ABSENT_VERDICT) return { entry, word: WORDS.undecidable, detail: detected.reason };
  if (isDeclineCurrent(declined, entry.id, profile.lineage)) {
    return { entry, word: WORDS.declined, detail: OUTCOME_LINES.declinedAt(declined[entry.id]) };
  }
  return { entry, word: WORDS.offered };
});

const renderEntry = ({ entry, word, detail }, root, slots) => {
  const lines = [OUTCOME_LINES.entry(entry.id, word, detail)];
  if (word === WORDS.offered) {
    const command = entry.apply(root);
    lines.push(command ? OUTCOME_LINES.applyLine(command) : OUTCOME_LINES.noCommand());
  }
  if (entry.id === SLOTS_ID && (word === WORDS.offered || word === WORDS.applied)) lines.push(...slotLines(slots));
  return lines;
};

const writeSlots = (root, config, slots, deps) => {
  const ops = slots.filter(({ declared }) => !declared).map(({ target, value }) => ({
    kind: 'set', activity: target.activity, slot: target.slot, recipe: value,
  }));
  const merged = applySetOps(config, ops, { seedReadme: CANON_README });
  writeConfig(root, refreshReadme(merged).config, deps);
};

const storeCreated = (root, deps) => {
  try {
    return deps.lstat(resolve(root, STORE_DIR)).isDirectory();
  } catch {
    return false;
  }
};

const runApply = (root, deps, judged, slots, config) => {
  const byId = new Map(judged.map((item) => [item.entry.id, item]));
  const extra = [];
  const made = [];
  if (byId.get(SLOTS_ID)?.word === WORDS.offered) {
    try {
      writeSlots(root, config, slots, deps);
    } catch (error) {
      return { refusal: refuse('write-failed', causeOf(error)) };
    }
    made.push(`${CONFIG_WRITTEN} written`);
    byId.set(SLOTS_ID, { ...byId.get(SLOTS_ID), word: WORDS.applied });
  }
  if (byId.get(STORE_ID)?.word === WORDS.offered) {
    let seeded;
    try {
      seeded = writeProjectFileCreateOnly(root, STORE_SEED, '', deps, { noun: 'the epic store seed' });
    } catch (error) {
      if (storeCreated(root, deps)) made.push(`${STORE_DIR} created`);
      return { refusal: refuse('write-failed', [...made, causeOf(error)].join('; ')) };
    }
    byId.set(STORE_ID, { ...byId.get(STORE_ID), word: seeded.created ? WORDS.applied : WORDS.present });
    if (seeded.tmpLeftBehind) extra.push(OUTCOME_LINES.tmpLeft(seeded.tmpLeftBehind));
  }
  return { judged: judged.map((item) => byId.get(item.entry.id)), extra };
};

const serializeDeclines = (declined) => {
  const sorted = Object.fromEntries(Object.keys(declined).sort().map((id) => [id, declined[id]]));
  return `${JSON.stringify({ schema: SCHEMA, declined: sorted }, null, 2)}${LF}`;
};

const runDecline = (root, deps, judged, profile, declined) => {
  const offered = judged.filter(({ word }) => word === WORDS.offered);
  if (offered.length === 0) return { judged, extra: [OUTCOME_LINES.nothingOffered()] };
  const merged = { ...(declined ?? {}) };
  for (const { entry } of offered) merged[entry.id] = profile.lineage;
  try {
    writeDocsAiFileAtomic(root, DECLINES_REL, serializeDeclines(merged), deps, { noun: 'the decline record' });
  } catch (error) {
    return { refusal: refuse('write-failed', causeOf(error)) };
  }
  return {
    judged: judged.map((item) => (item.word === WORDS.offered ? { ...item, word: WORDS.recorded } : item)),
    extra: [],
  };
};

const runOffer = (options, given) => {
  const deps = withFs(given);
  const root = resolve(options.cwd);
  try {
    assertDocsAiDeployment(root, deps);
  } catch (error) {
    return refuse('no-deployment', causeOf(error));
  }
  const shipped = readShippedProfile(deps);
  if (shipped.refusal) return refuse(shipped.refusal);
  const record = readDeclines(root, deps);
  if (record.refusal) return refuse(record.refusal);
  const notes = [];
  const readiness = composeReadiness(root, {
    ...deps, onDetectError: (error) => notes.push(OUTCOME_LINES.detectFailed(causeOf(error))),
  });
  const judged = judgeEntries(root, deps, shipped.profile, record.declined);
  const offersSlots = judged.some(({ entry, word }) => entry.id === SLOTS_ID && word === WORDS.offered);
  const config = offersSlots ? readTierConfig(root, deps).config : null;
  const slots = offersSlots ? planSlots(config, readiness) : [];
  let outcome = { judged, extra: [] };
  if (options.apply) outcome = runApply(root, deps, judged, slots, config);
  if (options.decline) outcome = runDecline(root, deps, judged, shipped.profile, record.declined);
  if (outcome.refusal) return outcome.refusal;
  const lines = [...notes, ...outcome.judged.flatMap((item) => renderEntry(item, root, slots)), ...outcome.extra];
  return result(EXIT_SUCCESS, lines.join(LF));
};

export const main = (argv, deps = {}) => {
  const parsed = parseArgs(argv);
  if (parsed.help) return result(EXIT_SUCCESS, OUTCOME_LINES.help());
  if (parsed.problem) return result(EXIT_USAGE, '', OUTCOME_LINES.usage(parsed.problem));
  return runOffer(parsed, deps);
};

if (isDirectRun(import.meta.url)) {
  const outcome = main(process.argv.slice(ARGV_OFFSET));
  if (outcome.stdout) console.log(outcome.stdout);
  if (outcome.stderr) console.error(outcome.stderr);
  process.exitCode = outcome.code;
}
