#!/usr/bin/env node
// Recipe planner — the pure brain behind the read-only `/agent-workflow-kit recipes` advisor.
//
// A "recipe" is a NAMED orchestration pattern over the family's optional execution-backends (the
// subscription-CLI bridges: codex-cli-bridge → `codex`, antigravity-cli-bridge → `agy`), composed
// into the plan → execute → review flow. The ENGINE owns the canonical narrative
// (agent-workflow-engine/references/orchestration.md — the when/why, kept in lockstep by the
// recipe-name parity guard in recipes.test.mjs); this module owns the EXECUTABLE dispatch: given a
// recipe + the read-only detector's view of the environment, which backend does which role, how it
// degrades when a backend isn't ready, and the advisory quota/health notes.
//
// Invariants (the backends/status posture): pure (no fs/network/CLI in planRecipe/recommendRecipe),
// read-only, NEVER runs a subscription CLI. The kit only surfaces/selects/plans a recipe — the
// orchestrator (the main agent) executes it via the bridge skills and always makes the single commit;
// a backend is advisory or delegated, never autonomous. Dependency-free, Node >= 18.

import { pathToFileURL } from 'node:url';
import {
  detectBackends,
  READY,
  NEEDS_SKILL,
  NEEDS_CLI,
  NEEDS_CREDENTIALS,
  DEGRADED,
} from './detect-backends.mjs';

const CODEX = 'codex-cli-bridge';
const AGY = 'antigravity-cli-bridge';

// The manifest-name → human-alias map (the detector emits manifest names; humans say codex/agy).
export const DISPLAY_ALIASES = { [CODEX]: 'codex', [AGY]: 'agy' };

// The backend → role table, keyed by the manifest name the detector emits (status.name) — NOT the
// display alias. Drift-guarded against each bridge capability.json `provides[]` (recipes.test.mjs).
export const BACKEND_ROLES = {
  [CODEX]: ['execute', 'review'],
  [AGY]: ['review', 'probe'],
};

// Advisory metadata the DETECTION object does not carry (it has no cost/quota — those live only in
// capability.json). cost/quota are drift-guarded against the manifests; the agy `health` advisory is
// static project knowledge (Issue-001: the Antigravity service can stall on substantive prompts —
// invisible to file-presence detection, so it is NOT a readiness signal, only a standing caveat).
export const BACKEND_META = {
  [CODEX]: { cost: 'subscription', quota: { kind: 'subscription', finite: true } },
  [AGY]: {
    cost: 'subscription',
    quota: { kind: 'subscription', finite: true },
    health: 'Note: grounded agy-review gives a SOUND second opinion (it removes the stale-model/partial-diff false positives) — but the Antigravity service can still stall on substantive prompts (Issue-001), so keep reviews focused and prefer codex for large or latency-sensitive ones.',
  },
};

// Deterministic tie-break order: codex before agy. agy is a sound grounded reviewer now, but codex is
// the more reliable default for substantive reviews (agy carries the standing service-stall caveat above).
const BACKEND_PRIORITY = [CODEX, AGY];
const priorityIndex = (name) => {
  const i = BACKEND_PRIORITY.indexOf(name);
  return i === -1 ? BACKEND_PRIORITY.length : i;
};

// The four recipes, in lattice order. `role` is the backend role a recipe needs (null = Solo, no
// backend); `minBackends` is how many READY providers it needs; `degradesTo` is the next-weaker
// recipe when it can't be satisfied (the chain terminates at Solo, which is always satisfiable).
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
];

const recipeById = (id) => RECIPES.find((r) => r.id === id);

// The human reason a non-ready readiness yields (read-only file-presence remedies — never a claim
// about whether the backend's service is responsive).
const READINESS_REASON = {
  [NEEDS_SKILL]: 'bridge skill not installed — run /agent-workflow-kit setup',
  [NEEDS_CLI]: 'the CLI is not installed',
  [NEEDS_CREDENTIALS]: 'not signed in (credentials missing)',
  [DEGRADED]: 'wrapper not on PATH — run /agent-workflow-kit setup',
};

// ── pure planner ───────────────────────────────────────────────────────────────

// Backends (ready or not) whose role table includes `role`.
const providersOf = (role, detection) => detection.filter((b) => (BACKEND_ROLES[b.name] ?? []).includes(role));

// READY providers of `role`, in deterministic priority order (codex before agy) → an array of names.
const readyProvidersOf = (role, detection) =>
  providersOf(role, detection)
    .filter((b) => b.readiness === READY)
    .sort((a, b) => priorityIndex(a.name) - priorityIndex(b.name))
    .map((b) => b.name);

// Availability = readiness === READY, full stop. A recipe is satisfiable iff it needs no backend OR
// enough READY providers of its role exist.
const isSatisfiable = (recipe, detection) =>
  recipe.role === null || readyProvidersOf(recipe.role, detection).length >= recipe.minBackends;

// Why a recipe can't run as-is — the specific not-ready providers and their readiness-derived reasons.
const degradeReason = (recipe, detection) => {
  const providers = providersOf(recipe.role, detection);
  if (providers.length === 0) {
    return `${recipe.title} needs a backend providing ${recipe.role}, but no backend provides it`;
  }
  const ready = providers.filter((b) => b.readiness === READY);
  const detail = providers
    .filter((b) => b.readiness !== READY)
    .map((b) => `${DISPLAY_ALIASES[b.name] ?? b.name}: ${READINESS_REASON[b.readiness] ?? b.readiness}`)
    .join('; ');
  return `${recipe.title} needs ${recipe.minBackends} backend(s) providing ${recipe.role}, but only ${ready.length} ready${detail ? ` — ${detail}` : ''}`;
};

// Per-stage dispatch for an EFFECTIVE (already-satisfiable) recipe: the first `minBackends` READY
// providers, in priority order. Solo dispatches nothing (the orchestrator does it all).
const dispatchFor = (recipe, detection) => {
  if (recipe.role === null) return [];
  return readyProvidersOf(recipe.role, detection)
    .slice(0, recipe.minBackends)
    .map((name) => ({ role: recipe.role, backend: name, display: DISPLAY_ALIASES[name] }));
};

const QUOTA_NOTE = "Prefer the cheapest model that fits the task; don't reach for a top-tier model by reflex.";
const COUNCIL_QUOTA_NOTE = "Council spends two backends' quota for one decision — reserve it for changes that justify the cost.";

// Advisory notes for an effective recipe: a quota reminder when any backend is dispatched, the
// two-quota caveat for Council, and the agy health advisory whenever the dispatch actually uses agy.
const notesFor = (recipe, dispatch) => {
  const notes = [];
  if (dispatch.length > 0) notes.push(QUOTA_NOTE);
  if (recipe.id === 'council') notes.push(COUNCIL_QUOTA_NOTE);
  if (dispatch.some((d) => d.backend === AGY) && BACKEND_META[AGY].health) notes.push(BACKEND_META[AGY].health);
  return notes;
};

// planRecipe(recipe, detection) → pure plan. `recipe` is a recipe id or descriptor. Walks the
// degradation chain (with a stated reason per step) until a satisfiable recipe is reached, then emits
// the per-stage dispatch + advisory notes. Deterministic; never mutates the detection input.
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

// How close to ready a non-ready backend is — used to surface the most-actionable remedy first.
const READINESS_RANK = { [DEGRADED]: 3, [NEEDS_CREDENTIALS]: 2, [NEEDS_CLI]: 1, [NEEDS_SKILL]: 0 };
const READINESS_REMEDY = {
  [NEEDS_SKILL]: 'run /agent-workflow-kit setup',
  [NEEDS_CLI]: 'install its CLI',
  [NEEDS_CREDENTIALS]: 'sign in',
  [DEGRADED]: 'run /agent-workflow-kit setup (wrapper not on PATH)',
};

// recommendRecipe(detection) → { recipe, clause }. Never blank: both ready → Council (Reviewed the
// everyday default); one ready → Reviewed; none installed → Solo + a setup pointer; a backend
// present-but-not-ready → Solo with that backend's specific remedy. Pure.
export const recommendRecipe = (detection) => {
  const readyReview = readyProvidersOf('review', detection);
  if (readyReview.length >= 2) {
    return { recipe: 'council', clause: 'Council available, Reviewed the everyday default' };
  }
  if (readyReview.length === 1) {
    return { recipe: 'reviewed', clause: `Reviewed available (via ${DISPLAY_ALIASES[readyReview[0]]})` };
  }
  // No ready reviewer → Solo. Say how to unlock more: a present-but-not-ready backend names its
  // remedy; nothing installed names the setup pointer.
  const present = detection.filter((b) => b.readiness !== NEEDS_SKILL && b.readiness !== READY);
  if (present.length === 0) {
    return { recipe: 'solo', clause: 'Solo — run /agent-workflow-kit setup to add a backend' };
  }
  // Rank by how close to ready; break ties with the SAME codex-before-agy priority the dispatch path
  // uses (priorityIndex) so the recommendation is deterministic regardless of detection emission order.
  const best = [...present].sort(
    (a, b) => (READINESS_RANK[b.readiness] ?? -1) - (READINESS_RANK[a.readiness] ?? -1) || priorityIndex(a.name) - priorityIndex(b.name),
  )[0];
  const remedy = READINESS_REMEDY[best.readiness] ?? best.readiness;
  return { recipe: 'solo', clause: `Solo — ${DISPLAY_ALIASES[best.name] ?? best.name}: ${remedy} to unlock Reviewed` };
};

// ── activity procedures: per-slot recipe resolution ────────────────────────────────

// The named activities and their typed recipe slots — the EXECUTABLE mirror of the engine canon
// (agent-workflow-engine/references/procedures.md). Drift-guarded against that canon's `Slots:` lines
// (recipes.test.mjs): the activity ids and each section's slot set must match this table. The slot
// VALUE is the slot's recipe-TYPE (used to look up which recipes are valid for it, SLOT_RECIPES); in
// v1 each slot's key equals its type, but the indirection keeps a future renamed slot expressible.
export const ACTIVITIES = {
  'plan-authoring': { slots: { review: 'review' } },
  'plan-execution': { slots: { execute: 'execute', review: 'review' } },
};

// Which recipes are valid in each slot type. `review` composes a review DEPTH (Solo / Reviewed /
// Council); `execute` composes Solo / Delegated (delegation is opt-in). A recipe outside its slot's
// list is a config error (the IO shell) or a usage error (an --override) — never silently coerced.
export const SLOT_RECIPES = {
  review: ['solo', 'reviewed', 'council'],
  execute: ['solo', 'delegated'],
};

// The computed default for a slot when the config is silent (no file, or no entry for this slot).
// review → Reviewed when ANY review-capable backend is `ready`, else Solo (NEVER Council — Council is
// opt-in; it spends two backends' quota). execute → Solo (Delegated is opt-in only). Readiness-aware,
// so a computed default is always satisfiable and never itself degrades. Deliberately NOT
// recommendRecipe (which returns Council when both are ready — that drives the status line, not a
// per-slot default).
const computedDefaultForSlot = (slotType, detection) => {
  if (slotType === 'review') return readyProvidersOf('review', detection).length >= 1 ? 'reviewed' : 'solo';
  return 'solo'; // execute (and any future opt-in slot) floors at Solo
};

// resolveActivityRecipe({ config, readiness, activity, slot, override }) → the effective recipe for ONE
// slot of an activity, with graceful-vs-loud degradation. Precedence: an explicit `override` (degrades
// LOUDLY — overrideUnsatisfied, so the agent tells the user) > the `config` entry (degrades gracefully)
// > the computed default (graceful; readiness-aware so it never degrades). Satisfiability + the
// degradation lattice REUSE planRecipe (Council → Reviewed → Solo; Delegated → Solo) — the single source
// of the recipe lattice. `readiness` is the detector array ([{ name, readiness }]). Pure; never mutates.
export const resolveActivityRecipe = ({ config = {}, readiness = [], activity, slot, override } = {}) => {
  const activityDef = ACTIVITIES[activity];
  if (!activityDef) throw new Error(`unknown activity: ${activity}`);
  const slotType = activityDef.slots[slot];
  if (!slotType) throw new Error(`unknown slot "${slot}" for activity "${activity}"`);

  const configured = config?.[activity]?.[slot];
  const requested = override ?? configured ?? computedDefaultForSlot(slotType, readiness);
  const source = override != null ? 'override' : configured != null ? 'config' : 'default';

  // Defensive: the IO shell (config) and CLI (override) validate recipe-for-slot first; a stray value
  // here is a programmer error, surfaced loudly rather than silently coerced into a neighbour recipe.
  if (!(SLOT_RECIPES[slotType] ?? []).includes(requested)) {
    throw new Error(`invalid recipe "${requested}" for ${slotType} slot of "${activity}"`);
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

// ── the one-line backend status (deterministic-first: the tool speaks, the agent pastes) ───────────

// composeStatusLine(detection, recommendation) → the ENTIRE one-line backend-status summary the
// bootstrap/upgrade report footers print. Machine-composed so the agent pastes it verbatim and
// composes NOTHING factual (this closes the realistic-example contamination class: a session once
// echoed SKILL.md's canonical example while the detector said otherwise). Display names come from
// DISPLAY_ALIASES — the ONE alias table the recommendation clause already uses; ordering is the
// deterministic BACKEND_PRIORITY (codex before agy), independent of detection emission order.
// Always exactly one line: no part may carry a newline (pinned by tests).
export const composeStatusLine = (detection, recommendation) => {
  const backends = [...detection]
    .sort((a, b) => priorityIndex(a.name) - priorityIndex(b.name))
    .map((b) => `${DISPLAY_ALIASES[b.name] ?? b.name} ${b.readiness === READY ? '✓' : '✗'} ${b.readiness}`)
    .join(' · ');
  return `backends: ${backends} — run /agent-workflow-kit backends · recipes: ${recommendation.clause} — see /agent-workflow-kit recipes`;
};

// ── report + CLI ─────────────────────────────────────────────────────────────────

// The structured report behind `--json` — the recipes, the recommendation, a plan per recipe, and
// (additive) the pasteable one-line backend status composed from the same detection.
export const buildReport = (detection) => {
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
    statusLine: composeStatusLine(detection, recommendation),
  };
};

// formatRecipes(detection) → deterministic human advisor text: the four recipes, the recommendation,
// and the per-recipe plan for the current environment (degradation reasons + dispatch + notes).
export const formatRecipes = (detection) => {
  const lines = [
    'agent-workflow orchestration recipes (read-only — the orchestrator executes via the bridge skills and always commits)',
    '',
  ];
  for (const r of RECIPES) lines.push(`  ${r.title} (${r.id}) — ${r.summary}`);
  const rec = recommendRecipe(detection);
  lines.push('', `recommended here: ${rec.recipe} — ${rec.clause}`, '', 'plan for the current environment:');
  for (const r of RECIPES) {
    const p = planRecipe(r.id, detection);
    const arrow = p.degraded ? ` → ${p.effective}` : '';
    const who = p.dispatch.length ? p.dispatch.map((d) => `${d.display} ${d.role}`).join(', ') : 'orchestrator only';
    lines.push(`  ${r.title}${arrow}: ${who}`);
    for (const step of p.degradation) lines.push(`      ↳ ${step.reason}`);
    for (const note of p.notes) lines.push(`      • ${note}`);
  }
  return lines.join('\n');
};

// The full argv vocabulary — anything else rejects LOUDLY. The old parse silently routed unknown
// args into the multi-line human render; with `--status-line` (whose output is pasted as fact) a
// mistyped flag masquerading as a mode would be a silent failure, so the parse is strict now.
const KNOWN_ARGS = new Set(['--help', '-h', '--json', '--status-line']);

const main = (argv) => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`recipes — read-only orchestration-recipe advisor for the agent-workflow family.

Usage:
  node recipes.mjs [--json | --status-line]

Lists the four recipes (Solo / Reviewed / Council / Delegated) and, from the read-only backend
detector, plans + recommends one for the current environment. --status-line prints exactly ONE
line — the machine-composed backend-status summary the bootstrap/upgrade reports paste verbatim.
--json emits the structured report (incl. the same line as \`statusLine\`); the two are mutually
exclusive. Detection only — never writes, never commits, never runs a subscription CLI.`);
    return;
  }
  const unknown = argv.find((a) => !KNOWN_ARGS.has(a));
  if (unknown !== undefined) {
    console.error(`[agent-workflow-kit] unknown argument: ${unknown}`);
    process.exit(1);
  }
  if (argv.includes('--json') && argv.includes('--status-line')) {
    console.error('[agent-workflow-kit] --json and --status-line are mutually exclusive — pick one output');
    process.exit(1);
  }
  const detection = detectBackends();
  if (argv.includes('--status-line')) console.log(composeStatusLine(detection, recommendRecipe(detection)));
  else if (argv.includes('--json')) console.log(JSON.stringify(buildReport(detection), null, 2));
  else console.log(formatRecipes(detection));
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main(process.argv.slice(2));
