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
// a backend is advisory or delegated, never autonomous. Dependency-free, Node >= 22.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// The host-level bridge-settings snapshot (fact-only, best-effort). READ-ONLY core only — never the
// writer — so this read-only advisor never pulls in the atomic-write core.
import { settingsSnapshot, DEFAULT_BUNDLE_ROOT } from './bridge-settings-read.mjs';
import {
  detectBackends,
  wrapperCmdFor,
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
// composeConfiguredPosture(ctx) → the CONFIGURED dispatch posture (strip-the-kit D5), rendered
// from the bundled manifests' VALIDATED posture pins overlaid with the ACTIVE bridge-settings —
// today only the codex tier knob (bridge-settings stays model/effort-free by design, so this
// surface can never carry a settings-file model claim). Returns null when NO bundled bridge
// declares a posture block (a pre-D5 bundle keeps every surface byte-identical). Best-effort:
// a corrupt bundle degrades to null — the posture segment is a footer fact, never a gate.
export const composeConfiguredPosture = (ctx = {}) => {
  try {
    const bundleRoot = ctx.bundleRoot ?? DEFAULT_BUNDLE_ROOT;
    const read = ctx.readFile ?? readFileSync;
    const parts = [];
    for (const name of BACKEND_PRIORITY) {
      let manifest;
      try {
        manifest = JSON.parse(String(read(join(bundleRoot, name, 'capability.json'), 'utf8')));
      } catch {
        return null; // an unreadable/corrupt manifest is CORRUPTION — a partial posture would lie
      }
      if (!Object.hasOwn(manifest, 'posture')) continue; // a pre-D5 bridge — legitimate absence
      const posture = manifest.posture;
      // The FULL closed shape (the validator/receipt-predicate twin): a present-but-invalid
      // block nulls the WHOLE render — fail closed to silence, never a partial/mangled line.
      const invalid =
        posture === null || typeof posture !== 'object' || Array.isArray(posture) ||
        typeof posture.model !== 'string' || posture.model.length === 0 ||
        (Object.hasOwn(posture, 'effort') && (typeof posture.effort !== 'string' || posture.effort.length === 0)) ||
        (Object.hasOwn(posture, 'tier') && posture.tier !== null && (typeof posture.tier !== 'string' || posture.tier.length === 0)) ||
        Object.keys(posture).some((k) => !['model', 'effort', 'tier'].includes(k));
      if (invalid) return null;
      const seg = [`model=${posture.model}`];
      if (Object.hasOwn(posture, 'effort')) seg.push(`effort=${posture.effort}`);
      if (Object.hasOwn(posture, 'tier')) {
        const knob = (ctx.settings?.active ?? []).find((s) => s.key === 'CODEX_SERVICE_TIER' && s.bridge === name);
        seg.push(knob ? `tier=${knob.value} (bridge-settings)` : `tier=${posture.tier ?? 'standard'}`);
      }
      parts.push(`${DISPLAY_ALIASES[name] ?? name} ${seg.join(' ')}`);
    }
    return parts.length ? parts.join(' · ') : null;
  } catch {
    return null;
  }
};

export const composeStatusLine = (detection, recommendation, settings = null, autonomy = null, posture = null) => {
  const backends = [...detection]
    .sort((a, b) => priorityIndex(a.name) - priorityIndex(b.name))
    .map((b) => `${DISPLAY_ALIASES[b.name] ?? b.name} ${b.readiness === READY ? '✓' : '✗'} ${b.readiness}`)
    .join(' · ');
  const base = `backends: ${backends} — run /agent-workflow-kit backends · recipes: ${recommendation.clause} — see /agent-workflow-kit recipes`;
  // Fact-only suffix, ONLY when a bridge knob is actively set (env/file, non-default). Omitted otherwise,
  // so the default line is byte-identical to before. A raw env value may (D3) carry newlines/control
  // chars — collapse them to a single space so the "exactly one line" backend-status contract holds.
  const oneLine = (s) => String(s).replace(/[\s]+/g, ' ').trim();
  const active = settings?.active ?? [];
  const suffix = active.length ? ` · settings: ${active.map((s) => `${oneLine(s.key)}=${oneLine(s.value)}`).join(' · ')}` : '';
  // The autonomy segment (AD-044 Plan 4): rendered ONLY when the caller supplies the computed
  // facts (composeAutonomyFacts) — an omitted param keeps the line byte-identical (the settings-
  // suffix precedent). Fact-only: effective per-activity levels + the render-sync state; an absent
  // policy says "computed defaults" honestly; a malformed policy surfaces LOUDLY, never omitted.
  const autonomySegment = autonomy == null ? '' : ` · autonomy: ${oneLine(formatAutonomySegment(autonomy))}`;
  // The D5 posture segment: rendered ONLY when the caller supplies the composed pins-derived
  // posture (composeConfiguredPosture) — an omitted/null param keeps the line byte-identical.
  const postureSegment = posture == null ? '' : ` · posture: ${oneLine(posture)}`;
  return base + suffix + autonomySegment + postureSegment;
};

// The one-segment autonomy renderer behind composeStatusLine's 4th param.
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

// composeAutonomyFacts(cwd) → the fact object the status/active lines render (AD-044 Plan 4):
// { source, redlines, activities, renderState } or { error }. Lazy imports — autonomy-config
// statically imports THIS module (ACTIVITIES) and velocity-profile is heavy, so both load at call
// time only (the loadConfig precedent). Never throws: a malformed policy becomes { error } so the
// one-line surfaces render it loudly instead of dying.
// The policy lives at the PROJECT root; the report-footer invokes the paste surfaces without
// --cwd, so a subdirectory shell must still find it. Nearest-.git walk-up (dir or worktree file),
// fs-only — this advisor stays spawn-free; no repo found → the cwd itself (fixture behavior).
const projectTopOf = (cwd) => {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
};

export const composeAutonomyFacts = async (cwd) => {
  try {
    const root = projectTopOf(cwd);
    const { loadAutonomy, resolveAutonomy, isSparseSeedConfig } = await import('./autonomy-config.mjs');
    const { config, source } = loadAutonomy(root);
    const resolved = resolveAutonomy(config);
    if (source === 'none') return { source, redlines: resolved.redlines, activities: resolved.activities, renderState: null };
    // The STRUCTURAL seed (_README only) is a fresh-deployment NORMAL — treating it as "declared"
    // would report "render DRIFT" on every fresh upgrade (codex, Segment B). An EXPLICIT policy
    // declaring the default values is a real declaration — its render state IS computed
    // (structural detection, codex Segment B closing).
    if (isSparseSeedConfig(config)) {
      return { source, defaultsEquivalent: true, redlines: resolved.redlines, activities: resolved.activities, renderState: null };
    }
    let renderState;
    try {
      const { checkAutonomyProfile } = await import('./velocity-profile.mjs');
      renderState = checkAutonomyProfile({ cwd: root }).inSync
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

// composeActiveRecipeLine({ config, source }, detection) → ONE line rendering the CONFIGURED recipe of
// every activity/slot (resolved via resolveActivityRecipe: config entry, else computed default), each
// with its source label, its degradation stated, and its dispatched wrapper set — explicitly labeled
// "configured" and contrasted with the readiness-RECOMMENDED recipe (which composeStatusLine shows and
// which is NOT what runs). This is the machine-composed sibling of composeStatusLine (AD-034): the
// session-start checklist + the handover "Active recipes:" slot paste it verbatim, so no agent composes
// the configured-recipe facts by hand. `{ config, source }` is exactly what loadConfig returns (source
// 'none' when no config file exists). Always exactly one line: no part may carry a newline (pinned).
export const composeActiveRecipeLine = ({ config, source } = {}, detection, autonomy = null) => {
  const cells = [];
  for (const [activity, def] of Object.entries(ACTIVITIES)) {
    // The per-activity autonomy level rides each cell when the caller supplies the facts (AD-044
    // Plan 4) — an omitted param keeps the line byte-identical (the composeStatusLine precedent).
    const level = autonomy?.activities?.[activity]?.autonomy;
    const auto = level ? `; autonomy ${level}` : '';
    for (const slot of Object.keys(def.slots)) {
      const r = resolveActivityRecipe({ config: config ?? {}, readiness: detection, activity, slot });
      const { dispatch } = planRecipe(r.recipe, detection);
      const wrappers = dispatch.map((d) => wrapperCmdFor(d.backend, d.role)).filter(Boolean);
      const srcLabel = r.source === 'config' ? 'configured' : 'computed default';
      const head = r.degradedFrom
        ? `${activity}.${slot} = ${r.degradedFrom} (${srcLabel}; degrades here to ${r.recipe} — ${r.reason}${auto})`
        : `${activity}.${slot} = ${r.recipe} (${srcLabel}${auto})`;
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
  // A MALFORMED policy must surface LOUDLY on this paste surface too — silently rendering cells
  // without levels would hide the required STOP signal (codex R1, Segment B). One line always.
  const malformed = autonomy?.error
    ? ` · autonomy: MALFORMED policy — ${String(autonomy.error).replace(/[\s]+/g, ' ').trim()}`
    : '';
  return `active recipes (${origin}): ${cells.join(' · ')} — the configured recipes above are what runs; readiness-recommended here: ${rec.recipe} (informational)${malformed}`;
};

// ── report + CLI ─────────────────────────────────────────────────────────────────

// The structured report behind `--json` — the recipes, the recommendation, a plan per recipe, and
// (additive) the pasteable one-line backend status composed from the same detection.
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
    // The SAME autonomy facts the --status-line surface renders — the --json envelope must never
    // expose a stale machine-composed status line (codex R1, Segment B).
    statusLine: composeStatusLine(detection, recommendation, settings, autonomy, posture),
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
// args into the multi-line human render; with `--status-line` / `--active-line` (whose output is
// pasted as fact) a mistyped flag masquerading as a mode would be a silent failure, so the parse is
// strict now.
const KNOWN_ARGS = new Set(['--help', '-h', '--json', '--status-line', '--active-line']);
const EXCLUSIVE_ARGS = ['--json', '--status-line', '--active-line']; // each owns stdout whole

const main = async (argv) => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`recipes — read-only orchestration-recipe advisor for the agent-workflow family.

Usage:
  node recipes.mjs [--json | --status-line | --active-line]

Lists the four recipes (Solo / Reviewed / Council / Delegated) and, from the read-only backend
detector, plans + recommends one for the current environment. --status-line prints exactly ONE
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
  const detection = detectBackends();
  if (argv.includes('--active-line')) {
    // Lazy import: orchestration-config.mjs statically imports this module (ACTIVITIES/SLOT_RECIPES),
    // so the config reader is pulled in at run time only — no static import cycle.
    const { loadConfig } = await import('./orchestration-config.mjs');
    try {
      console.log(composeActiveRecipeLine(loadConfig(process.cwd()), detection, await composeAutonomyFacts(process.cwd())));
    } catch (err) {
      console.error(`[agent-workflow-kit] ${err.message}`);
      return err.exitCode ?? 1;
    }
  } else if (argv.includes('--status-line')) {
    const snapshot = settingsSnapshot();
    console.log(composeStatusLine(detection, recommendRecipe(detection), snapshot, await composeAutonomyFacts(process.cwd()), composeConfiguredPosture({ settings: snapshot })));
  } else if (argv.includes('--json')) {
    const snapshot = settingsSnapshot();
    console.log(JSON.stringify(buildReport(detection, snapshot, await composeAutonomyFacts(process.cwd()), composeConfiguredPosture({ settings: snapshot })), null, 2));
  }
  else console.log(formatRecipes(detection));
  return 0;
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
// Natural exit via process.exitCode — never process.exit inside the async main (it would drop buffered
// stdio writes on piped stderr), and never a TOP-LEVEL await here: orchestration-config.mjs statically
// imports this module, so awaiting the dynamic import during our own evaluation would deadlock the cycle.
if (isDirectRun) {
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
