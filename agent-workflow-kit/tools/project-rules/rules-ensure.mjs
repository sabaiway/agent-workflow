// The upgrade op `rules`: it lays every registry theme's kit file, keeps the effective file a copy of
// the kit file where no local file exists, and names the merge an agent does where one does. It never
// writes a local file and never merges two texts. Contract: docs/ai/specs/kit/project-rules/rules-ensure.md.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeDocsAiFileAtomic, writeProjectFileCreateOnly } from '../atomic-write.mjs';
import { detectEngine, readEngineFragment, resolveEngineDir } from '../engine-source.mjs';
import { composeFailure, composeOutcome, tmpNote } from '../ensure-ops.mjs';
import { shellQuoteArg } from '../repo-lex.mjs';
import { digestOf, readRecord, readUnder } from './rules-check.mjs';
import { writeRecord } from './rules-record.mjs';
import { RULES_PRIORS, isKnownPrior } from './rules-priors.mjs';
import { RECORD_PATH, THEMES, themePaths } from './themes.mjs';

const OP = 'rules';
const ENGINE_INSTALL = 'npx @sabaiway/agent-workflow-engine@latest init';
const FILE_ROLES = ['kit', 'local', 'effective'];
const causeOf = (err) => String((err && err.message) || err);

// ── the survey: the template and every path read once, nothing written ───────────────────────────

const readTemplate = (readFile, path) => {
  try {
    return { bytes: Buffer.from(readFile(path)) };
  } catch (err) {
    return { error: causeOf(err) };
  }
};

// An engine-homed template: absent when no valid installed engine supplies it, else its bytes, else the
// read's error (a present template that cannot be read or is blank after trim).
const readEngineTemplate = (rel, deps) => {
  const { dir, source } = resolveEngineDir({ env: deps.env ?? process.env, home: deps.home ?? homedir() });
  if (!detectEngine(dir, { source, rel }).ok) return { absent: true };
  try {
    return { bytes: Buffer.from(readEngineFragment(dir, { source, rel })) };
  } catch (err) {
    return { error: causeOf(err) };
  }
};

const unsupplied = (theme, paths, kit) => {
  const fate = kit.outcome === 'absent' ? 'not laid' : 'left as it is';
  return `${paths.kit}: ${fate} — no installed engine supplies the ${theme.name} rules theme; install or refresh it with ${ENGINE_INSTALL}`;
};

const unreadable = (rel, read) => {
  if (read.outcome === 'foreign') {
    return composeFailure(OP, 'wrong-node-kind', `${rel}: ${read.code ?? `it is a ${read.className}, not a regular file`} — nothing was read or written; resolve it by hand, then re-run`);
  }
  if (read.outcome === 'ok' || read.outcome === 'absent') return null;
  return composeFailure(OP, 'unexpected-error', `${rel}: could not be read (${read.code ?? read.outcome}) — nothing was written`);
};

const survey = ({ themes, cwd, kitRoot, readFile, deps }) => {
  const surveyed = [];
  for (const theme of themes) {
    const paths = themePaths(theme.name);
    const fromEngine = theme.home === 'engine';
    const template = fromEngine ? readEngineTemplate(theme.template, deps) : readTemplate(readFile, join(kitRoot, theme.template));
    if (template.error !== undefined) {
      const remedy = fromEngine ? `the installed engine's template ${theme.template} could not be read, so nothing was written — ${template.error}`
        : `the bundled template ${theme.template} could not be read, so nothing was written — reinstall the kit. ${template.error}`;
      return { failure: composeFailure(OP, 'template-unreadable', `${paths.kit}: ${remedy}`) };
    }
    if (template.absent) {
      surveyed.push({ theme, unsupplied: unsupplied(theme, paths, readUnder(cwd, paths.kit, deps)) });
      continue;
    }
    const reads = Object.fromEntries(FILE_ROLES.map((role) => [role, readUnder(cwd, paths[role], deps)]));
    const failure = FILE_ROLES.map((role) => unreadable(paths[role], reads[role])).find(Boolean);
    if (failure) return { failure };
    surveyed.push({ theme, paths, template: template.bytes, reads });
  }
  const recordRead = readUnder(cwd, RECORD_PATH, deps);
  const failure = unreadable(RECORD_PATH, recordRead);
  return failure ? { failure } : { surveyed, record: readRecord(recordRead, themes) };
};

// ── the decision per theme (pure over the survey) ────────────────────────────────────────────────

const classifyKit = (name, kit, template, priors) => {
  if (kit.outcome === 'absent') return 'absent';
  if (kit.bytes.equals(template)) return 'current';
  return isKnownPrior(name, kit.bytes, priors) ? 'prior' : 'other';
};

const planTheme = ({ theme, paths, template, reads }, record, priors) => {
  const { kit, local, effective } = reads;
  const kitState = classifyKit(theme.name, kit, template, priors);
  const kitWrite = { absent: 'seed', prior: 'refresh', other: 'refresh' }[kitState] ?? null;
  const entry = record.ok ? record.themes[theme.name] : undefined;
  const base = { name: theme.name, paths, kitState, kitBytes: template, kitWrite, effectiveWrite: null, recordWrite: false };
  if (local.outcome === 'ok') {
    const merged = entry !== undefined && effective.outcome === 'ok' && entry.kit === digestOf(template)
      && entry.local === digestOf(local.bytes) && entry.effective === digestOf(effective.bytes);
    return { ...base, mode: merged ? 'merged' : 'pending', localDigest: digestOf(local.bytes) };
  }
  const effectiveWrite = effective.outcome === 'absent' ? 'seed' : effective.bytes.equals(template) ? null : 'rebuild';
  const passed = { kit: digestOf(template), local: 'absent', effective: digestOf(template) };
  const recorded = entry !== undefined && entry.kit === passed.kit && entry.local === 'absent' && entry.effective === passed.effective;
  const droppedEdit = effectiveWrite === 'rebuild' && entry !== undefined && entry.effective !== digestOf(effective.bytes);
  return { ...base, mode: 'copy', effectiveWrite, recordWrite: effectiveWrite !== null || !recorded, passed, droppedEdit };
};

// ── the lines, composed from what happened ───────────────────────────────────────────────────────

const KIT_LINES = {
  absent: { written: 'created from the bundled template', stood: 'appeared while this run was creating it and holds the bundled template — it stands', would: 'absent — would be created from the bundled template' },
  prior: { written: 'held the body an earlier release shipped — refreshed to the bundled template', would: 'holds the body an earlier release shipped — would be refreshed to the bundled template' },
  other: { written: 'differs from every body this kit knows it shipped — replaced by the bundled template', would: 'differs from every body this kit knows it shipped — would be replaced by the bundled template' },
};
const kitLine = (plan, fate) => {
  const { kit, local } = plan.paths;
  if (plan.kitState === 'current') return `${kit}: already the bundled template — nothing written`;
  const lasting = plan.kitState === 'other' ? `; a rule meant to last goes in ${local}, where it wins` : '';
  return `${kit}: ${KIT_LINES[plan.kitState][fate]}${lasting}`;
};

const effectiveLine = (plan, fate) => {
  const { kit, local, effective } = plan.paths;
  const dropped = plan.droppedEdit ? `, dropping an edit made to it; edits belong in ${local}` : '';
  if (plan.effectiveWrite === null) return `${effective}: already the copy of ${kit} — nothing written`;
  if (plan.effectiveWrite === 'seed') {
    return `${effective}: ${{ written: `created as a copy of ${kit}`, stood: `appeared while this run was creating it and holds the copy of ${kit} — it stands`, would: `absent — would be created as a copy of ${kit}` }[fate]}`;
  }
  if (fate === 'would') return `${effective}: differs from ${kit} — would be rebuilt as its copy${dropped}`;
  return `${effective}: ${plan.droppedEdit ? `rebuilt as a copy of ${kit}${dropped}` : `rebuilt from ${kit}`}`;
};

const recordLine = (plan, fate, replacing) => {
  const { effective } = plan.paths;
  if (!plan.recordWrite) return `${RECORD_PATH}: already records what ${effective} was built from — nothing written`;
  const would = fate === 'would';
  if (replacing !== null) {
    return `${RECORD_PATH}: ${would ? 'is' : 'was'} unreadable (${replacing}) — ${would ? 'would be replaced' : 'replaced'} by a record of what ${effective} ${would ? 'is' : 'was'} built from`;
  }
  return `${RECORD_PATH}: ${would ? `would record what ${effective} is built from` : `records what ${effective} was built from`}`;
};

const mergeLine = ({ plan, kitRoot, cwd, dryRun }) => {
  const { kit, local, effective } = plan.paths;
  const cli = shellQuoteArg(join(kitRoot, 'tools', 'project-rules', 'rules-cli.mjs'));
  const command = `node ${cli} --record --theme ${plan.name} --kit ${digestOf(plan.kitBytes)} --local ${plan.localDigest} --effective <the sha256 of the merged file> --cwd ${shellQuoteArg(cwd)}`;
  const holds = dryRun && plan.kitWrite !== null ? ` — this command holds once the real run has written ${kit}` : '';
  return `merge needed — merge ${kit} and ${local} into ${effective}: by meaning, the local file wins a conflict, each rule appears once, only the final meaning is written, with no mark of where a rule came from, the frontmatter is kept, and the user is shown what changed; then record it: ${command}${holds}`;
};

const themeLines = ({ plan, fateOf, kitRoot, cwd, dryRun, replacing }) => {
  const lines = [kitLine(plan, fateOf(plan, 'kit'))];
  if (plan.mode === 'pending') lines.push(mergeLine({ plan, kitRoot, cwd, dryRun }));
  if (plan.mode === 'merged') lines.push(`${plan.paths.effective}: already the recorded merge of ${plan.paths.kit} and ${plan.paths.local} — nothing written`);
  if (plan.mode === 'copy') lines.push(effectiveLine(plan, fateOf(plan, 'effective')), recordLine(plan, fateOf(plan, 'record'), replacing));
  return lines;
};

// ── the token: one per run, the first that holds ─────────────────────────────────────────────────

const DRY = { seeded: 'would-seed', refreshed: 'would-refresh', regenerated: 'would-regenerate' };
const tokenOf = (plans, wrote, dryRun) => {
  if (plans.some((plan) => plan.mode === 'pending')) return 'pending';
  const token = (word) => (dryRun ? DRY[word] : word);
  if (plans.some((plan) => plan.kitWrite === 'seed' && wrote(plan, 'kit'))) return token('seeded');
  if (plans.some((plan) => plan.kitWrite === 'refresh' && wrote(plan, 'kit'))) return token('refreshed');
  if (plans.some((plan) => wrote(plan, 'effective') || wrote(plan, 'record'))) return token('regenerated');
  return 'already-current';
};

// ── the writes, in order; the first that fails stops the run ─────────────────────────────────────

const writtenNote = (written) => (written.length > 0 ? `already written by this run and not rolled back: ${written.join(', ')}` : 'nothing was written before it');
const RACE = 'appeared while this run was creating it and does not hold the bytes this run carried — something is writing there underneath this run; nothing further written, re-run when the tree is settled';
const NOUN = { noun: 'a project rules file' };

const writeOne = ({ cwd, rel, body, kind, deps }) => (kind === 'seed'
  ? writeProjectFileCreateOnly(cwd, rel, body, deps, NOUN)
  : writeDocsAiFileAtomic(cwd, rel, body, deps, NOUN));

const runWrites = ({ plans, cwd, deps, fates, notes }) => {
  const written = [];
  const stop = (cause, line) => ({ failure: composeFailure(OP, cause, `${line} — ${writtenNote(written)}`, ...notes) });
  for (const plan of plans) {
    const steps = [
      plan.kitWrite && { role: 'kit', kind: plan.kitWrite },
      plan.effectiveWrite && { role: 'effective', kind: plan.effectiveWrite },
    ].filter(Boolean);
    for (const { role, kind } of steps) {
      const rel = plan.paths[role];
      const result = (() => {
        try {
          return { ok: writeOne({ cwd, rel, body: plan.kitBytes, kind, deps }) };
        } catch (err) {
          return { error: causeOf(err) };
        }
      })();
      if (result.error !== undefined) return stop('write-refused', `${rel}: ${result.error}`);
      notes.push(...tmpNote(rel, result.ok.tmpLeftBehind));
      if (!result.ok.created) {
        const now = readUnder(cwd, rel, deps);
        if (now.outcome !== 'ok' || !now.bytes.equals(plan.kitBytes)) return stop('race-unresolved', `${rel}: ${RACE}`);
      }
      if (result.ok.created) written.push(rel);
      fates.set(`${plan.name}:${role}`, result.ok.created ? 'written' : 'stood');
    }
    if (plan.recordWrite) {
      const recorded = writeRecord(cwd, plan.name, plan.passed, deps);
      if (!recorded.ok && recorded.condition === 'write') return stop('write-refused', `${RECORD_PATH}: ${recorded.message}`);
      if (!recorded.ok) {
        return stop('race-unresolved', `${RECORD_PATH}: the record could not vouch for the files (${recorded.condition}: ${recorded.message}), so they changed underneath this run; nothing further written, re-run when the tree is settled`);
      }
      written.push(RECORD_PATH);
      fates.set(`${plan.name}:record`, 'written');
    }
  }
  return {};
};

// ensureRules({ cwd, kitRoot, dryRun?, deps? }) → one outcome of the closed vocabulary for every theme.
export const ensureRules = ({ cwd, kitRoot, dryRun = false, deps = {} }) => {
  const themes = deps.themes ?? THEMES;
  const surveyed = survey({ themes, cwd, kitRoot, readFile: deps.readFile ?? readFileSync, deps });
  if (surveyed.failure) return surveyed.failure;
  const priors = deps.priors ?? RULES_PRIORS;
  const steps = surveyed.surveyed.map((one) => (one.unsupplied ? one : { plan: planTheme(one, surveyed.record, priors) }));
  const plans = steps.filter((step) => step.plan).map((step) => step.plan);
  const firstRecordWrite = plans.find((plan) => plan.recordWrite);
  const replacing = (plan) => (plan === firstRecordWrite && !surveyed.record.ok ? surveyed.record.reason : null);
  const fates = new Map();
  const notes = [];
  const fateOf = (plan, role) => fates.get(`${plan.name}:${role}`) ?? 'would';
  const lines = () => steps.flatMap(({ plan, unsupplied: line }) => (plan
    ? themeLines({ plan, fateOf, kitRoot, cwd, dryRun, replacing: replacing(plan) })
    : [line]));
  if (dryRun) {
    const wouldWrite = (plan, role) => (role === 'kit' ? plan.kitWrite !== null : role === 'effective' ? plan.effectiveWrite !== null : plan.recordWrite);
    return composeOutcome(OP, tokenOf(plans, wouldWrite, true), lines(), false);
  }
  const stopped = runWrites({ plans, cwd, deps, fates, notes });
  if (stopped.failure) return stopped.failure;
  const wrote = (plan, role) => fates.get(`${plan.name}:${role}`) === 'written';
  return composeOutcome(OP, tokenOf(plans, wrote, false), [...lines(), ...notes], false);
};
