#!/usr/bin/env node
// set-recipe.mjs — the WRITER for docs/ai/orchestration.json. The division of labor (AD-025): the AGENT
// turns plain language into explicit `--set <activity>.<slot>=<value>` / `--unset <activity>.<slot>`
// ops; the KIT does the deterministic validate → merge → preview → write. The kit ships NO NL parser
// (stays dependency-free + deterministic) and performs no `all`-magic — the agent expands "both review"
// into explicit per-activity ops (asking if scope is unclear).
//
// Posture: PREVIEW BY DEFAULT (dry-run); `--write` applies. It NEVER commits and NEVER runs a backend.
// It previews current→proposed for the CHANGED slots only, resolves the effective recipe vs LIVE backend
// readiness (degradation honesty on BOTH the preview and the --write path), and writes only via the
// hardened writeConfig (deployment gate; exclusive-create tmp+rename; symlink/TOCTOU-safe; last-writer-
// wins). A no-op set never writes and never spuriously seeds the _README. `--unset` returns a slot to its
// computed default, so reverting needs no hand-edit either. Hand-edit stays first-class — this is an
// OFFERED convenience, never a lock.
//
// Output is ENGLISH/structured (repo-artifact Hard Constraint); the agent localizes to the user's
// language when narrating. Exit codes: 0 success (an explicit recipe that gracefully degrades is still
// 0); 2 usage (bad/duplicate op, --write with zero ops); 1 config error (malformed/unreadable config)
// or a write STOP (no deployment / symlinked leaf). main(argv, ctx) → { code, stdout, stderr }; cwd /
// env / home / detect / surveyVehicle / fs are injectable for host-independent tests.
//
// It writes every slot of every activity in the registry (carriers.mjs, via recipes.mjs) — the
// carrier slots and the `routine.parallel` switch included — and resolves each preview against the
// SAME readiness the recipes advisor composes: detected backends plus the executor-vehicle survey.
//
// Dependency-free, Node >= 22. No side effects on import (the isDirectRun idiom).

import { readFileSync, lstatSync } from 'node:fs';
import { isDirectRun } from './direct-run.mjs';
import { settingsSnapshot } from './bridge-settings-read.mjs';
import { posturesByBackend } from './bridge-posture.mjs';
import { surveyVehicle } from './cheap-agents-read.mjs';
import { applyCheapAgentsCommand } from './cheap-agents.mjs';
import {
  ACTIVITIES,
  SLOT_RECIPES,
  EXECUTOR_APPLY,
  composeReadiness,
  resolveActivityRecipe,
  composeActiveRecipeLine,
} from './recipes.mjs';
import { loadAutonomy, resolveAutonomy } from './autonomy-config.mjs';
import {
  CONFIG_REL,
  fail,
  loadConfig,
  validateConfig,
  parseOp,
  applySetOps,
  serializeConfig,
  refreshReadme,
  CANON_README,
} from './orchestration-config.mjs';
import { writeConfig as writeConfigFs } from './orchestration-write.mjs';
import {
  applyReviewerOps,
  parseReviewerOp,
  persistedLensStems,
  renderRosterPreview,
  resolveReviewerRows,
  rosterJsonRows,
} from './set-recipe-roster.mjs';

// ── argument parsing (usage errors → exit 2) ────────────────────────────────────────

// Parse argv → { ops, write, json }. Fixed ops stay unique per slot; reviewer list ops accumulate.
// A `--write` with zero ops, an unknown flag, or a bad token → exit 2. Inline forms are accepted too.
const parseArgs = (argv) => {
  const ops = [];
  const fixed = new Set();
  const reviewer = new Set();
  let write = false;
  let json = false;
  const takeOp = (kind, tok) => {
    const reviewerKind = kind === 'add-reviewer' || kind === 'remove-reviewer';
    const form = reviewerKind ? '<activity>.review=<member>' : `<activity>.<slot>${kind === 'set' ? '=<value>' : ''}`;
    if (tok === undefined || tok.startsWith('--')) throw fail(2, `--${kind} requires ${form}`);
    const op = reviewerKind ? parseReviewerOp(kind, tok) : parseOp(kind, tok);
    const key = `${op.activity}.${op.slot}`;
    if (fixed.has(key) || (!reviewerKind && reviewer.has(key))) {
      throw fail(2, `duplicate op for "${key}" — --set/--unset name each activity.slot at most once and cannot mix with reviewer list ops`);
    }
    if (reviewerKind) reviewer.add(key);
    else fixed.add(key);
    ops.push(op);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--write') write = true;
    else if (a === '--set') { takeOp('set', argv[i + 1]); i += 1; }
    else if (a === '--unset') { takeOp('unset', argv[i + 1]); i += 1; }
    else if (a === '--add-reviewer') { takeOp('add-reviewer', argv[i + 1]); i += 1; }
    else if (a === '--remove-reviewer') { takeOp('remove-reviewer', argv[i + 1]); i += 1; }
    else if (a.startsWith('--set=')) takeOp('set', a.slice('--set='.length));
    else if (a.startsWith('--unset=')) takeOp('unset', a.slice('--unset='.length));
    else if (a.startsWith('--add-reviewer=')) takeOp('add-reviewer', a.slice('--add-reviewer='.length));
    else if (a.startsWith('--remove-reviewer=')) takeOp('remove-reviewer', a.slice('--remove-reviewer='.length));
    else if (a.startsWith('-')) throw fail(2, `unknown flag: ${a}`);
    else throw fail(2, `unexpected argument: ${a}`);
  }
  if (write && ops.length === 0) throw fail(2, 'nothing to write — pass at least one --set/--unset/--add-reviewer/--remove-reviewer (a bare --write is a no-op)');
  return { ops, write, json };
};

// ── effective-recipe resolution per op (degradation honesty) ────────────────────────

// The readiness EVERY resolution here runs against: the detected bridges plus the executor-vehicle
// survey, composed by the one helper the recipes CLI uses. Detection is a SECONDARY input — a bridge
// detector throw must NOT block the write (the config write is readiness-independent) and must not
// cost the CARRIER either: the hook warns, the bridge half floors at not-ready, the vehicle survives.
const composeReadinessOrWarn = (cwd, deps, warnings) =>
  composeReadiness(cwd, {
    ...deps,
    onDetectError: (err) => warnings.push(
      `backend detection failed (${(err && err.message) || err}) — treating every bridge as not ready; recipes needing a bridge degrade to solo (the executor vehicle is unaffected).`,
    ),
  });

// A single op's before/after value + the effective recipe it resolves to here (vs live readiness).
// `to` is null for an unset (falls to the computed default). degradedFrom/reason carry the honesty.
const resolveOp = (op, current, after, readiness) => {
  const from = current?.[op.activity]?.[op.slot] ?? null;
  const to = after?.[op.activity]?.[op.slot] ?? null;
  const r = resolveActivityRecipe({ config: after ?? {}, readiness, activity: op.activity, slot: op.slot });
  return { activity: op.activity, slot: op.slot, from, to, effective: r.recipe, degradedFrom: r.degradedFrom, reason: r.reason };
};

// ── rendering (ENGLISH; the agent localizes) ────────────────────────────────────────

const valueLabel = (v) => (v == null ? '(computed default)' : v);

const effectiveLine = (e) =>
  e.degradedFrom
    ? `effective here: ${e.effective} (requested ${e.degradedFrom} → degraded: ${e.reason})`
    : `effective here: ${e.effective}`;

const formatHuman = ({ changed, unchanged, warnings, willWrite, wrote, fileBody, activeLine, agentsApply, persistedLenses }) => {
  const lines = [];
  if (wrote) lines.push(`wrote ${CONFIG_REL}`);
  else if (changed.length) lines.push(`set-recipe — preview (nothing written; re-run with --write to apply)`);
  for (const e of changed) {
    if (Array.isArray(e.roster)) {
      lines.push(renderRosterPreview(e, { agentsApply, wrote, persistedLenses }));
      continue;
    }
    lines.push(`  ${e.activity}.${e.slot}: ${valueLabel(e.from)} → ${valueLabel(e.to)}`);
    lines.push(`      ↳ ${effectiveLine(e)}`);
  }
  for (const e of unchanged) lines.push(Array.isArray(e.roster)
    ? renderRosterPreview(e, { agentsApply, wrote, persistedLenses })
    : `  ${e.activity}.${e.slot}: already ${valueLabel(e.from)} (no change)`);
  for (const w of warnings) lines.push(`  ⚠ ${w}`);
  if (wrote && fileBody) lines.push('', `${CONFIG_REL} now reads:`, fileBody.replace(/\n$/, ''));
  // The post-write discovery echo (AD-038): after every successful write, paste the freshly composed
  // active-recipe line verbatim + the one-line handover reminder — the writer is the ONE surface that
  // changes the config, so the change is never announced anywhere else.
  if (wrote && activeLine) {
    lines.push('', activeLine, `refresh the "Active recipes:" slot line in docs/ai/handover.md with the line above.`);
  }
  if (!wrote) {
    if (!changed.length) lines.push('  no changes — nothing to write.');
    else if (willWrite) lines.push('', `would write ${CONFIG_REL} — re-run with --write to apply.`);
  }
  return lines.join('\n');
};

const buildJson = ({ changed, unchanged, warnings, writtenPath, noop, activeLine }) => ({
  changed: rosterJsonRows(changed, true),
  unchanged: rosterJsonRows(unchanged, false),
  writtenPath: writtenPath ?? null,
  noop,
  warnings,
  // ADDITIVE: the machine-composed active-recipe line, present only after a successful write (the
  // human render pastes the same line) — the output stays one parseable JSON object either way.
  activeLine: activeLine ?? null,
});

// The writable surface, rendered FROM the registry — never re-typed as literals, so an activity, a
// slot or an accepted value added to the table shows up in the help (and in the doc that quotes it).
const ACTIVITY_LINES = Object.entries(ACTIVITIES)
  .map(([activity, def]) => `  ${activity} → ${Object.keys(def.slots).join(', ')}`)
  .join('\n');

const VALUE_LINES = Object.entries(SLOT_RECIPES)
  .map(([slotType, values]) => `  ${slotType} slots accept ${values.join(' | ')}`)
  .join('\n');

const QUALIFIED_SLOTS = Object.entries(ACTIVITIES)
  .flatMap(([activity, def]) => Object.keys(def.slots).map((slot) => `${activity}.${slot}`))
  .join(', ');

const HELP = `set-recipe — write the per-project orchestration config (docs/ai/orchestration.json).

Usage:
  node set-recipe.mjs [--set <activity>.<slot>=<value>]... [--unset <activity>.<slot>]...
                      [--add-reviewer <activity>.review=<member>]...
                      [--remove-reviewer <activity>.review=<member>]... [--write] [--json]

  --set    <activity>.<slot>=<value>   pin a value (fully-qualified; e.g. plan-authoring.review=council)
  --unset  <activity>.<slot>            return a slot to its computed default
  --add-reviewer <activity>.review=<member>     append a reviewer (same-slot ops accumulate in argv order)
  --remove-reviewer <activity>.review=<member>  remove a reviewer (same-slot ops accumulate in argv order)
  --write                               apply the change (default: preview only — writes nothing)
  --json                                machine-readable output
  --help, -h                            this help

Activities and their slots:
${ACTIVITY_LINES}

Accepted values per slot type:
${VALUE_LINES}

A carrier slot set to subagent needs the executor vehicle placed in this project — ${EXECUTOR_APPLY};
without it the slot resolves to solo with the reason stated. routine.parallel is a flag, not a
recipe: it never degrades.

Previews by default; --write applies via an atomic, symlink/TOCTOU-safe write behind a deployment gate.
Config writer only: it NEVER runs a backend and NEVER commits. Hand-editing the file stays fully supported.

Exit codes: 0 success (an explicit recipe that gracefully degrades is still 0);
            2 usage (bad/duplicate op, or --write with no ops);
            1 config error (malformed/unreadable config) or a write STOP (no deployment / symlinked leaf).`;

// ── main ────────────────────────────────────────────────────────────────────────────

export const main = (argv, ctx = {}) => {
  const cwd = ctx.cwd ?? process.cwd();
  const readinessDeps = { detect: ctx.detect, surveyVehicle: ctx.surveyVehicle };
  const readFile = ctx.readFileSync ?? readFileSync;
  const lstat = ctx.lstatSync ?? lstatSync;
  const writeConfig = ctx.writeConfig ?? writeConfigFs;
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    const { ops, write, json } = parseArgs(argv);

    // Load the current config first (loadConfig throws fail(1) loud on malformed/unreadable — a write
    // never clobbers an unparseable file; the message points the agent at the parse error to help fix it).
    const { config: current, source } = loadConfig(cwd, readFile, lstat);

    // No ops + no --write → show the current config + a hint (read-only; nothing changes).
    if (ops.length === 0) {
      if (json) {
        return { code: 0, stdout: JSON.stringify(buildJson({ changed: [], unchanged: [], warnings: [], writtenPath: null, noop: true }), null, 2), stderr: '' };
      }
      const shown = current == null ? `(no ${CONFIG_REL} yet — computed defaults apply)` : serializeConfig(current).replace(/\n$/, '');
      const hint = `\nPass --set <activity>.<slot>=<value> (preview) then --write to apply. Activities/slots: ${QUALIFIED_SLOTS}.`;
      return { code: 0, stdout: `${source === 'none' ? '' : `${CONFIG_REL}:\n`}${shown}${hint}`, stderr: '' };
    }

    // The merged config, then the _README refresh: a note that normalize-matches a KNOWN PRIOR canonical
    // is replaced by the current one on a touched write, while a customized note stays untouched.
    const render = { agentsApply: applyCheapAgentsCommand(cwd), persistedLenses: persistedLensStems(current) };
    const warnings = [];
    const readiness = composeReadinessOrWarn(cwd, readinessDeps, warnings);
    const reviewerOps = ops.filter((op) => op.kind === 'add-reviewer' || op.kind === 'remove-reviewer');
    const fixedOps = ops.filter((op) => op.kind === 'set' || op.kind === 'unset');
    const fixedAfter = fixedOps.length
      ? applySetOps(current, fixedOps, { seedReadme: CANON_README })
      : current;
    const defaults = Object.fromEntries(reviewerOps.map((op) => [
      `${op.activity}.${op.slot}`,
      resolveActivityRecipe({ config: {}, readiness, activity: op.activity, slot: op.slot }).recipe,
    ]));
    const reviewerResult = applyReviewerOps(fixedAfter, reviewerOps, { defaults, seedReadme: CANON_README });
    const after = refreshReadme(reviewerResult.config ?? {}).config;
    const surveyLens = ctx.surveyLens ?? ((spec) => surveyVehicle(cwd, spec, ctx));
    const hasRoster = reviewerOps.length > 0 || Object.values(after).some((activity) => Array.isArray(activity?.review));
    const settings = hasRoster ? settingsSnapshot({
      getenv: ctx.env, home: ctx.home, readFile: ctx.readFileSync, lstat: ctx.lstatSync,
    }) : null;
    const postures = ctx.postures ?? (hasRoster ? posturesByBackend({ settings }) : {});
    const reviewerRows = resolveReviewerRows(reviewerResult.rows, { readiness, surveyLens, postures })
      .map((row) => {
        const resolved = resolveActivityRecipe({
          config: after, readiness, activity: row.activity, slot: row.slot, surveyLens, postures,
        });
        return { ...row, effective: resolved.recipe, degradedFrom: null, reason: null };
      });
    const resolved = [
      ...fixedOps.map((op) => resolveOp(op, current, after, readiness)),
      ...reviewerRows,
    ];
    const changed = resolved.filter((e) => e.from !== e.to);
    const unchanged = resolved.filter((e) => e.from === e.to);
    const noop = changed.length === 0;

    if (!write) {
      const stdout = json
        ? JSON.stringify(buildJson({ changed, unchanged, warnings, writtenPath: null, noop }), null, 2)
        : formatHuman({ changed, unchanged, warnings, willWrite: !noop, wrote: false, ...render });
      return { code: 0, stdout, stderr: '' };
    }

    // --write. A no-op never writes (idempotent; never re-seeds the _README).
    if (noop) {
      const stdout = json
        ? JSON.stringify(buildJson({ changed, unchanged, warnings, writtenPath: null, noop: true }), null, 2)
        : formatHuman({ changed, unchanged, warnings, willWrite: false, wrote: false, ...render });
      return { code: 0, stdout, stderr: '' };
    }

    validateConfig(after); // defensive re-validate immediately before the write
    const { writtenPath } = writeConfig(cwd, after, ctx);
    const fileBody = serializeConfig(after);
    // The echoed handover line carries the SAME autonomy levels recipes --active-line renders —
    // sync facts (no render-check needed for the cells; Segment B). A malformed policy
    // surfaces loudly through the line's own MALFORMED segment.
    const autonomyFacts = (() => {
      try {
        const { config: autonomyConfig, source } = loadAutonomy(cwd, ctx.readFileSync ?? readFileSync, ctx.lstatSync ?? lstatSync);
        return { source, ...resolveAutonomy(autonomyConfig) };
      } catch (err) {
        return { error: (err && err.message) || String(err) };
      }
    })();
    const activeLine = composeActiveRecipeLine(
      { config: after, source: CONFIG_REL }, readiness, autonomyFacts, { surveyLens, postures },
    );
    const stdout = json
      ? JSON.stringify(buildJson({ changed, unchanged, warnings, writtenPath, noop: false, activeLine }), null, 2)
      : formatHuman({ changed, unchanged, warnings, wrote: true, fileBody, activeLine, ...render });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `set-recipe: ${err.message}` };
  }
};

if (isDirectRun(import.meta.url)) {
  const r = main(process.argv.slice(2));
  if (r.stdout) console.log(r.stdout);
  if (r.stderr) console.error(r.stderr);
  process.exit(r.code);
}
