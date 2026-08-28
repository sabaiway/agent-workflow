#!/usr/bin/env node
// Read-only recipe planner. The engine owns the narrative; carriers.mjs owns the activity/slot
// registry re-exported here. Pure planning functions never run a subscription CLI.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { settingsSnapshot, DEFAULT_BUNDLE_ROOT } from './bridge-settings-read.mjs';
import { isDirectRun } from './direct-run.mjs';
import {
  ACTIVITIES,
  POLICY_ACTIVITIES,
  SLOT_RECIPES,
  SUBAGENT_RECIPE,
  CARRY_ROLE,
  EXECUTOR_PROVIDER,
  SWITCH_DEFAULT,
  isSwitchSlot,
  withVehicle,
  vehicleDegradeReason,
  EXECUTOR_APPLY,
  safeLine,
  DISPLAY_ALIASES,
  BACKEND_PRIORITY,
} from './carriers.mjs';
import { surveyExecutorVehicle, surveyVehicle } from './cheap-agents-read.mjs';
import { obligationsOf } from './review-roster.mjs';
import { resolveRoster, activeLineCell, remedyFor } from './review-roster-resolve.mjs';
import { posturesByBackend } from './bridge-posture.mjs';
import {
  detectBackends,
  wrapperCmdFor,
  READY,
  NEEDS_SKILL,
  NEEDS_CLI,
  NEEDS_CREDENTIALS,
  DEGRADED,
} from './detect-backends.mjs';

export { ACTIVITIES, POLICY_ACTIVITIES, SLOT_RECIPES, isSwitchSlot, EXECUTOR_APPLY, safeLine, DISPLAY_ALIASES };

const [CODEX, AGY] = BACKEND_PRIORITY;

// Keyed by readiness-array provider name; executor is the only `carry` provider.
export const BACKEND_ROLES = {
  [CODEX]: ['execute', 'review'],
  [AGY]: ['review', 'probe'],
  [EXECUTOR_PROVIDER]: [CARRY_ROLE],
};

// Review obligations from the CONFIGURED activity's review recipe — the RAW config value, never
// the readiness-degraded one. The default preserves review-state and flow-check's backend set (#42).
export const requiredBackendsForConfiguredRecipe = ({ config, readiness = [], detectionFailed = false, activity = 'plan-execution' } = {}) => {
  if (!Object.hasOwn(ACTIVITIES, activity) || !Object.hasOwn(ACTIVITIES[activity].slots, 'review')) {
    throw new Error(`activity "${activity}" has no review slot`);
  }
  const configured = config?.[activity]?.review;
  const providers = Object.values(DISPLAY_ALIASES); // every review-capable backend, codex first
  if (configured == null && detectionFailed) {
    // No config + no readiness signal: the computed default is UNKNOWABLE — fail closed upstream.
    return { recipe: null, source: 'default', backends: [], minShip: 0, perBackend: false, unknowable: true };
  }
  if (Array.isArray(configured)) {
    return { ...obligationsOf(configured), source: 'config', unknowable: false };
  }
  // Role-filtered: a ready EXECUTOR vehicle is a carry provider, never a reviewer, so it must not
  // turn a silent review config into `reviewed`.
  const anyReady = readyProvidersOf('review', readiness).length >= 1;
  const recipe = configured ?? (anyReady ? 'reviewed' : 'solo');
  const source = configured != null ? 'config' : 'default';
  if (recipe === 'solo') return { recipe, source, backends: [], minShip: 0, perBackend: false, unknowable: false };
  if (recipe === 'council') return { recipe, source, backends: providers, minShip: 1, perBackend: true, unknowable: false };
  return { recipe, source, backends: providers, minShip: 1, perBackend: false, unknowable: false };
};

// Advisory metadata the detection object does not carry. cost/quota are drift-guarded against the
// manifests; agy's `health` (Issue-001) is invisible to detection — a caveat, not a readiness signal.
export const BACKEND_META = {
  [CODEX]: { cost: 'subscription', quota: { kind: 'subscription', finite: true } },
  [AGY]: {
    cost: 'subscription',
    quota: { kind: 'subscription', finite: true },
    health: 'Note: grounded agy-review gives a SOUND second opinion (it removes the stale-model/partial-diff false positives) — but the Antigravity service can still stall on substantive prompts (Issue-001), so keep reviews focused and prefer codex for large or latency-sensitive ones.',
  },
};

const priorityIndex = (name) => {
  const i = BACKEND_PRIORITY.indexOf(name);
  return i === -1 ? BACKEND_PRIORITY.length : i;
};

// The five recipes, in lattice order. `degradesTo` is the next-weaker recipe when a recipe can't be
// satisfied; every chain terminates at Solo, which always is.
export const RECIPES = [
  {
    id: 'solo',
    title: 'Solo',
    role: null,
    minBackends: 0,
    degradesTo: null,
    summary: 'the orchestrator plans, executes, and self-reviews — no backend (always available; the floor).',
  },
  {
    id: 'reviewed',
    title: 'Reviewed',
    role: 'review',
    minBackends: 1,
    degradesTo: 'solo',
    summary: 'the orchestrator executes; one backend reviews the result (advisory). Prefers codex when both are ready.',
  },
  {
    id: 'council',
    title: 'Council',
    role: 'review',
    minBackends: 2,
    degradesTo: 'reviewed',
    summary: 'both backends review independently; the orchestrator synthesizes the two opinions.',
  },
  {
    id: 'delegated',
    title: 'Delegated',
    role: 'execute',
    minBackends: 1,
    degradesTo: 'solo',
    summary: 'the orchestrator hands a bounded execution sub-task to a backend (codex exec), then reviews the diff and commits.',
  },
  SUBAGENT_RECIPE,
];

const recipeById = (id) => RECIPES.find((r) => r.id === id);

// ── pure planner ───────────────────────────────────────────────────────────────

const providersOf = (role, detection) => detection.filter((b) => (BACKEND_ROLES[b.name] ?? []).includes(role));

// In deterministic priority order, so a dispatch never depends on detection emission order.
const readyProviderEntriesOf = (role, detection) =>
  providersOf(role, detection)
    .filter((b) => b.readiness === READY)
    .sort((a, b) => priorityIndex(a.name) - priorityIndex(b.name));

const readyProvidersOf = (role, detection) => readyProviderEntriesOf(role, detection).map((b) => b.name);

const isSatisfiable = (recipe, detection) =>
  recipe.role === null || readyProvidersOf(recipe.role, detection).length >= recipe.minBackends;

// Why a recipe can't run as-is — the specific not-ready providers and their readiness-derived reasons.
const degradeReason = (recipe, detection) => {
  const providers = providersOf(recipe.role, detection);
  if (providers.length === 0) {
    return `${recipe.title} needs a provider providing ${recipe.role}, but no provider provides it`;
  }
  const ready = providers.filter((b) => b.readiness === READY);
  const detail = providers
    .filter((b) => b.readiness !== READY)
    .map((b) => (b.name === EXECUTOR_PROVIDER
      ? vehicleDegradeReason(b.vehicle, EXECUTOR_APPLY)
      : `${DISPLAY_ALIASES[b.name] ?? b.name}: ${remedyFor({ readiness: b.readiness })}`))
    .join('; ');
  return `${recipe.title} needs ${recipe.minBackends} provider(s) providing ${recipe.role}, but only ${ready.length} ready${detail ? ` — ${detail}` : ''}`;
};

// Per-stage dispatch for an EFFECTIVE (already-satisfiable) recipe. The executor's step carries its
// vehicle state, so both renders can name it.
const dispatchFor = (recipe, detection) => {
  if (recipe.role === null) return [];
  return readyProviderEntriesOf(recipe.role, detection)
    .slice(0, recipe.minBackends)
    .map((b) => {
      const step = { role: recipe.role, backend: b.name, display: DISPLAY_ALIASES[b.name] ?? b.name };
      return b.vehicle ? { ...step, vehicle: b.vehicle.state } : step;
    });
};

const QUOTA_NOTE = "Prefer the cheapest model that fits the task; don't reach for a top-tier model by reflex.";
const COUNCIL_QUOTA_NOTE = "Council spends two backends' quota for one decision — reserve it for changes that justify the cost.";

// The quota reminder rides a subscription-BACKEND dispatch only: the executor vehicle spends no
// bridge quota, and its recipe is a frontier one, so the cheapest-model reminder would contradict it.
const notesFor = (recipe, dispatch) => {
  const notes = [];
  if (dispatch.some((d) => d.role !== CARRY_ROLE)) notes.push(QUOTA_NOTE);
  if (recipe.id === 'council') notes.push(COUNCIL_QUOTA_NOTE);
  if (dispatch.some((d) => d.backend === AGY) && BACKEND_META[AGY].health) notes.push(BACKEND_META[AGY].health);
  return notes;
};

// planRecipe → pure plan: walks the degradation chain, a stated reason per step, then dispatches.
export const planRecipe = (recipe, detection) => {
  const requested = typeof recipe === 'string' ? recipeById(recipe) : recipe;
  if (!requested) throw new Error(`unknown recipe: ${recipe}`);
  let current = requested;
  const degradation = [];
  while (!isSatisfiable(current, detection)) {
    const next = recipeById(current.degradesTo);
    degradation.push({ from: current.id, to: next.id, reason: degradeReason(current, detection) });
    current = next;
  }
  const dispatch = dispatchFor(current, detection);
  return {
    requested: requested.id,
    effective: current.id,
    degraded: current.id !== requested.id,
    degradation,
    dispatch,
    notes: notesFor(current, dispatch),
  };
};

// Rank = how close to ready, so the most actionable remedy surfaces first.
const READINESS_RANK = { [DEGRADED]: 3, [NEEDS_CREDENTIALS]: 2, [NEEDS_CLI]: 1, [NEEDS_SKILL]: 0 };
const READINESS_REMEDY = {
  [NEEDS_SKILL]: 'run /agent-workflow-kit setup',
  [NEEDS_CLI]: 'install its CLI',
  [NEEDS_CREDENTIALS]: 'sign in',
  [DEGRADED]: 'run /agent-workflow-kit setup (wrapper not on PATH)',
};

// recommendRecipe(detection) → { recipe, clause }, never blank: both ready → Council (Reviewed the
// everyday default); one → Reviewed; otherwise Solo plus the most actionable remedy. Pure.
export const recommendRecipe = (detection) => {
  const readyReview = readyProvidersOf('review', detection);
  if (readyReview.length >= 2) {
    return { recipe: 'council', clause: 'Council available, Reviewed the everyday default' };
  }
  if (readyReview.length === 1) {
    return { recipe: 'reviewed', clause: `Reviewed available (via ${DISPLAY_ALIASES[readyReview[0]]})` };
  }
  // Role-filtered: the executor vehicle unlocks no review recipe, so it never supplies the remedy.
  const present = providersOf('review', detection).filter((b) => b.readiness !== NEEDS_SKILL && b.readiness !== READY);
  if (present.length === 0) {
    return { recipe: 'solo', clause: 'Solo — run /agent-workflow-kit setup to add a backend' };
  }
  const best = [...present].sort(
    (a, b) => (READINESS_RANK[b.readiness] ?? -1) - (READINESS_RANK[a.readiness] ?? -1) || priorityIndex(a.name) - priorityIndex(b.name),
  )[0];
  const remedy = READINESS_REMEDY[best.readiness] ?? best.readiness;
  return { recipe: 'solo', clause: `Solo — ${DISPLAY_ALIASES[best.name] ?? best.name}: ${remedy} to unlock Reviewed` };
};

// ── activity procedures: per-slot recipe resolution ────────────────────────────────
// The computed default for a silent slot. NEVER Council (opt-in: it spends two backends' quota) and
// deliberately not recommendRecipe, which drives the status line rather than a per-slot default.
// Every non-review, non-switch slot floors at Solo, so placing the executor vehicle never flips a
// default. Readiness-aware, so a computed default is always satisfiable and never itself degrades.
const computedDefaultForSlot = (slotType, detection) => {
  if (slotType === 'review') return readyProvidersOf('review', detection).length >= 1 ? 'reviewed' : 'solo';
  if (isSwitchSlot(slotType)) return SWITCH_DEFAULT;
  return 'solo';
};

// The effective recipe for ONE slot. Precedence: an explicit `override` (degrades LOUDLY, so the
// agent tells the user) > the `config` entry (graceful) > the computed default. Satisfiability and
// the lattice REUSE planRecipe — one source. Pure; never mutates.
export const resolveActivityRecipe = ({ config = {}, readiness = [], activity, slot, override, surveyLens, postures } = {}) => {
  const activityDef = ACTIVITIES[activity];
  if (!activityDef) throw new Error(`unknown activity: ${activity}`);
  const slotType = activityDef.slots[slot];
  if (!slotType) throw new Error(`unknown slot "${slot}" for activity "${activity}"`);

  const configured = config?.[activity]?.[slot];
  const requested = override ?? configured ?? computedDefaultForSlot(slotType, readiness);
  const source = override != null ? 'override' : configured != null ? 'config' : 'default';

  if (Array.isArray(requested)) {
    if (slotType !== 'review' || source !== 'config') {
      throw new Error(`invalid roster for ${slotType} slot of "${activity}"`);
    }
    const obligations = obligationsOf(requested);
    return {
      recipe: obligations.recipe,
      source,
      degradedFrom: null,
      reason: null,
      overrideUnsatisfied: false,
      roster: resolveRoster({ value: requested, readiness, surveyLens, postures }),
    };
  }

  // Defensive: the IO shell and the CLI validate first, so a stray value here is a programmer error
  // — surfaced loudly rather than silently coerced into a neighbour recipe.
  if (!(SLOT_RECIPES[slotType] ?? []).includes(requested)) {
    throw new Error(`invalid recipe "${requested}" for ${slotType} slot of "${activity}"`);
  }

  // A switch slot is a flag, not a recipe: it resolves outside the lattice and can never degrade.
  if (isSwitchSlot(slotType)) {
    return { recipe: requested, source, degradedFrom: null, reason: null, overrideUnsatisfied: false };
  }

  const plan = planRecipe(requested, readiness);
  const degraded = plan.degraded;
  return {
    recipe: plan.effective,
    source,
    degradedFrom: degraded ? requested : null,
    reason: degraded ? plan.degradation.map((d) => d.reason).join('; ') : null,
    overrideUnsatisfied: source === 'override' && degraded,
  };
};

// Configured posture from bundled manifest pins plus bridge settings; corruption returns null.
export const composeConfiguredPosture = (ctx = {}) => {
  try {
    const rows = posturesByBackend({ bundleRoot: ctx.bundleRoot ?? DEFAULT_BUNDLE_ROOT, settings: ctx.settings ?? { active: [] }, readFile: ctx.readFile ?? readFileSync });
    if (Object.values(rows).some((row) => row.state === 'unreadable')) return null;
    const parts = Object.entries(rows)
      .filter(([, row]) => row.state === 'valid')
      .map(([receiptId, row]) => `${receiptId} ${row.posture}`);
    return parts.length ? parts.join(' · ') : null;
  } catch {
    return null;
  }
};

// The bridge half of a readiness array: every backend-status render lists BRIDGES (the things
// `/agent-workflow-kit backends` sets up); the executor vehicle is a carrier, judged by the agents
// mode, and only the recipe lattice sees it.
export const bridgeEntries = (readiness) => readiness.filter((b) => b.name !== EXECUTOR_PROVIDER);

export const composeStatusLine = (detection, recommendation, settings = null, autonomy = null, posture = null) => {
  const backends = bridgeEntries(detection)
    .sort((a, b) => priorityIndex(a.name) - priorityIndex(b.name))
    .map((b) => `${DISPLAY_ALIASES[b.name] ?? b.name} ${b.readiness === READY ? '✓' : '✗'} ${b.readiness}`)
    .join(' · ');
  const base = `backends: ${backends} — run /agent-workflow-kit backends · recipes: ${recommendation.clause} — see /agent-workflow-kit recipes`;
  // A raw env value may carry newlines/control chars — collapse them so the one-line contract holds.
  const oneLine = (s) => String(s).replace(/[\s]+/g, ' ').trim();
  const active = settings?.active ?? [];
  // A RETIRED knob renders as retired: hiding the user's line would be a silent deletion, reading it
  // as active would claim a capability the wrapper no longer has.
  const suffix = active.length ? ` · settings: ${active.map((s) => `${oneLine(s.key)}=${oneLine(s.value)}${s.retired ? ' (RETIRED — arms nothing)' : ''}`).join(' · ')}` : '';
  // Each optional segment renders ONLY when its facts are supplied; an omitted param changes nothing.
  const autonomySegment = autonomy == null ? '' : ` · autonomy: ${oneLine(formatAutonomySegment(autonomy))}`;
  const postureSegment = posture == null ? '' : ` · posture: ${oneLine(posture)}`;
  return base + suffix + autonomySegment + postureSegment;
};

const formatAutonomySegment = (a) => {
  if (a.error) return `MALFORMED policy — ${a.error}`;
  const levels = Object.entries(a.activities ?? {}).map(([k, v]) => `${k}=${v.autonomy}`).join(', ');
  const state = a.source === 'none'
    ? 'computed defaults — no policy file; declare with /agent-workflow-kit set-autonomy'
    : a.defaultsEquivalent
      ? 'declared, defaults-equivalent — computed defaults apply; declare levels with /agent-workflow-kit set-autonomy'
      : `declared; render ${a.renderState}`;
  return `${levels} (${state})`;
};

// The policy lives at the PROJECT root and the paste surfaces run without --cwd, so a subdirectory
// shell must still find it. Fs-only: this advisor stays spawn-free.
const projectTopOf = (cwd) => {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
};

// The facts the status/active lines render. Lazy imports: autonomy-config statically imports THIS
// module. Never throws — a malformed policy becomes { error }, rendered loudly. `deps` is the probe seam.
export const composeAutonomyFacts = async (cwd, deps = {}) => {
  try {
    const root = projectTopOf(cwd);
    const { loadAutonomy, resolveAutonomy, isSparseSeedConfig } = await import('./autonomy-config.mjs');
    const { config, source } = loadAutonomy(root);
    const resolved = resolveAutonomy(config);
    if (source === 'none') return { source, redlines: resolved.redlines, activities: resolved.activities, renderState: null };
    // The structural seed is a fresh-deployment NORMAL: reading it as "declared" would report
    // "render DRIFT" on every fresh upgrade.
    if (isSparseSeedConfig(config)) {
      return { source, defaultsEquivalent: true, redlines: resolved.redlines, activities: resolved.activities, renderState: null };
    }
    let renderState;
    try {
      const { checkAutonomyProfile } = await import('./velocity-profile.mjs');
      renderState = checkAutonomyProfile({ cwd: root }, deps).inSync
        ? 'in sync'
        : 'DRIFT — re-run the velocity --autonomy render';
    } catch (err) {
      renderState = `unchecked (${err?.message ?? err})`;
    }
    return { source, redlines: resolved.redlines, activities: resolved.activities, renderState };
  } catch (err) {
    return { error: err?.message ?? String(err) };
  }
};

// ── the one-line ACTIVE-recipe line (the discovery line — configured, never recommended) ───────────

// ONE line rendering the CONFIGURED recipe of every activity/slot with its source, degradation and
// dispatched wrappers — contrasted with the readiness-RECOMMENDED recipe, which is NOT what runs.
// The session-start checklist and the handover "Active recipes:" slot paste it verbatim.
export const composeActiveRecipeLine = ({ config, source } = {}, detection, autonomy = null, rosterDeps = null) => {
  const cells = [];
  for (const [activity, def] of Object.entries(ACTIVITIES)) {
    const level = autonomy?.activities?.[activity]?.autonomy;
    const auto = level ? `; autonomy ${level}` : '';
    for (const [slot, slotType] of Object.entries(def.slots)) {
      const r = resolveActivityRecipe({
        config: config ?? {}, readiness: detection, activity, slot,
        surveyLens: rosterDeps?.surveyLens, postures: rosterDeps?.postures,
      });
      const dispatch = isSwitchSlot(slotType) || r.roster ? [] : planRecipe(r.recipe, detection).dispatch;
      const wrappers = dispatch.map((d) => wrapperCmdFor(d.backend, d.role)).filter(Boolean);
      const srcLabel = r.source === 'config' ? 'configured' : 'computed default';
      const renderedValue = r.roster
        ? activeLineCell(r.roster, { states: rosterDeps !== null })
        : r.recipe;
      const head = r.degradedFrom
        ? `${activity}.${slot} = ${r.degradedFrom} (${srcLabel}; degrades here to ${r.recipe} — ${r.reason}${auto})`
        : `${activity}.${slot} = ${renderedValue} (${srcLabel}${isSwitchSlot(slotType) ? '; switch' : ''}${auto})`;
      const suffix =
        wrappers.length >= 2
          ? ` → every backend every round: ${wrappers.join(' + ')}`
          : wrappers.length === 1
            ? ` → ${wrappers[0]}`
            : '';
      cells.push(`${head}${suffix}`);
    }
  }
  const rec = recommendRecipe(detection);
  const origin = source === 'none' || config == null ? 'no config file — computed defaults apply' : `from ${source}`;
  // A MALFORMED policy surfaces LOUDLY here too: rendering cells without levels would hide the STOP.
  const malformed = autonomy?.error
    ? ` · autonomy: MALFORMED policy — ${String(autonomy.error).replace(/[\s]+/g, ' ').trim()}`
    : '';
  return `active recipes (${origin}): ${cells.join(' · ')} — the configured orchestration values above are what runs; readiness-recommended here: ${rec.recipe} (informational)${malformed}`;
};

// ── report + CLI ─────────────────────────────────────────────────────────────────

// The structured report behind `--json`, incl. the same one-line status the --status-line mode emits.
export const buildReport = (detection, settings = null, autonomy = null, posture = null) => {
  const recommendation = recommendRecipe(detection);
  return {
    recipes: RECIPES.map(({ id, title, role, minBackends, degradesTo, summary }) => ({
      id,
      title,
      role,
      minBackends,
      degradesTo,
      summary,
    })),
    recommendation,
    plans: RECIPES.map((r) => planRecipe(r.id, detection)),
    // The --json envelope must never expose a status line staler than the --status-line surface.
    statusLine: composeStatusLine(detection, recommendation, settings, autonomy, posture),
  };
};

// Deterministic human advisor text: the recipes, the recommendation, and the per-recipe plan here.
export const formatRecipes = (detection) => {
  const lines = [
    'agent-workflow orchestration recipes (read-only — the orchestrator executes via the bridge skills or the executor vehicle and always commits)',
    '',
  ];
  for (const r of RECIPES) lines.push(`  ${r.title} (${r.id}) — ${r.summary}`);
  const rec = recommendRecipe(detection);
  lines.push('', `recommended here: ${rec.recipe} — ${rec.clause}`, '', 'plan for the current environment:');
  for (const r of RECIPES) {
    const p = planRecipe(r.id, detection);
    const arrow = p.degraded ? ` → ${p.effective}` : '';
    const who = p.dispatch.length
      ? p.dispatch.map((d) => `${d.display} ${d.role}${d.vehicle ? ` (vehicle ${d.vehicle})` : ''}`).join(', ')
      : 'orchestrator only';
    lines.push(`  ${r.title}${arrow}: ${who}`);
    for (const step of p.degradation) lines.push(`      ↳ ${step.reason}`);
    for (const note of p.notes) lines.push(`      • ${note}`);
  }
  return lines.join('\n');
};

// Closed argv vocabulary: the mode outputs are pasted as fact, so a mistyped flag masquerading as a
// mode would be a silent failure.
const KNOWN_ARGS = new Set(['--help', '-h', '--json', '--status-line', '--active-line']);
const EXCLUSIVE_ARGS = ['--json', '--status-line', '--active-line']; // each owns stdout whole

// The readiness array EVERY mode composes: the detected backends plus the executor vehicle as the
// one carry provider. Two independent axes: the vehicle is surveyed first, and a bridge detector
// failure reaches `deps.onDetectError` exactly once (default: a loud stderr line) while the
// vehicle's readiness survives it — so a caller's fail-closed state for bridges never masks the
// carrier, and the reverse. `deps` is also the seam a test injects a fake survey or detector through.
export const composeReadiness = (cwd, deps = {}) => {
  const survey = (deps.surveyVehicle ?? surveyExecutorVehicle)(cwd, deps);
  let detection = [];
  try {
    detection = (deps.detect ?? detectBackends)();
  } catch (err) {
    (deps.onDetectError ?? ((e) => console.error(`[agent-workflow-kit] backend detection failed: ${e.message}`)))(err);
  }
  return withVehicle(detection, survey);
};

const main = async (argv, deps = {}) => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`recipes — read-only orchestration-recipe advisor for the agent-workflow family.

Usage:
  node recipes.mjs [--json | --status-line | --active-line]

Lists the five recipes (Solo / Reviewed / Council / Delegated / Subagent) and, from the read-only
backend detector plus the executor-vehicle survey, plans + recommends one for the current
environment. --status-line prints exactly ONE
line — the machine-composed backend-status summary the bootstrap/upgrade reports paste verbatim
(incl. the per-activity autonomy segment: effective levels + render-sync state, honest
computed-defaults wording when no policy file exists). --active-line prints exactly ONE line — the
CONFIGURED recipe per activity/slot, resolved from the per-project docs/ai/orchestration.json (read
from the current directory) + live readiness, with degradation stated and each activity's autonomy
level beside its cells; paste it verbatim at session start / into the handover "Active recipes:" slot.
--json emits the structured report (incl. the same line as \`statusLine\`); the three are mutually
exclusive. Detection only — never writes, never commits, never runs a subscription CLI.`);
    return;
  }
  const unknown = argv.find((a) => !KNOWN_ARGS.has(a));
  if (unknown !== undefined) {
    console.error(`[agent-workflow-kit] unknown argument: ${unknown}`);
    return 1;
  }
  const exclusive = EXCLUSIVE_ARGS.filter((a) => argv.includes(a));
  if (exclusive.length > 1) {
    console.error(`[agent-workflow-kit] ${exclusive.join(' and ')} are mutually exclusive — pick one output`);
    return 1;
  }
  const cwd = process.cwd();
  const readiness = composeReadiness(cwd, deps);
  if (argv.includes('--active-line')) {
    // Lazy: orchestration-config.mjs statically imports this module — no static cycle.
    const { loadConfig } = await import('./orchestration-config.mjs');
    try {
      const snapshot = settingsSnapshot();
      const surveyLens = deps.surveyLens ?? ((spec) => surveyVehicle(cwd, spec, deps));
      console.log(composeActiveRecipeLine(
        loadConfig(cwd), readiness, await composeAutonomyFacts(cwd),
        { surveyLens, postures: posturesByBackend({ settings: snapshot }) },
      ));
    } catch (err) {
      console.error(`[agent-workflow-kit] ${err.message}`);
      return err.exitCode ?? 1;
    }
  } else if (argv.includes('--status-line')) {
    const snapshot = settingsSnapshot();
    console.log(composeStatusLine(readiness, recommendRecipe(readiness), snapshot, await composeAutonomyFacts(cwd), composeConfiguredPosture({ settings: snapshot })));
  } else if (argv.includes('--json')) {
    const snapshot = settingsSnapshot();
    console.log(JSON.stringify(buildReport(readiness, snapshot, await composeAutonomyFacts(cwd), composeConfiguredPosture({ settings: snapshot })), null, 2));
  }
  else console.log(formatRecipes(readiness));
  return 0;
};

// Natural exit via process.exitCode — never process.exit inside the async main (it would drop
// buffered stdio on piped stderr), and never a TOP-LEVEL await (that would deadlock the import cycle).
if (isDirectRun(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code ?? 0;
    },
    (err) => {
      console.error(`[agent-workflow-kit] ${(err && err.message) || err}`);
      process.exitCode = 1;
    },
  );
}
