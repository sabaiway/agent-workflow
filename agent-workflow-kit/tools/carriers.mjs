// carriers.mjs — the activity/slot registry plus the subagent carrier's readiness composition.
// ACTIVITIES + SLOT_RECIPES are the ONE table: recipes.mjs re-exports them, so no importer's path
// moves. The carrier half declares the `subagent` recipe, appends the executor vehicle to a
// readiness array as the single provider of the `carry` role, words the degrade a missing or
// unusable vehicle causes, and holds the dispatch-form wording every render prints (one source, a
// red line where it is a red line). Governing contract: docs/ai/specs/kit/carriers.md.
// Leaf — imports only the direct-run guard (recipes.mjs imports THIS), no fs, nothing on import.
import { refuseDirectRun } from './direct-run.mjs';

// The slot VALUE is the slot's TYPE; SLOT_RECIPES lists the values each type accepts. A `switch`
// slot is a flag, not a recipe: it resolves outside the recipe lattice and never degrades.
// `policy` marks an activity that is a SESSION with an autonomy level of its own; a routine chore
// runs inside such a session and carries none.
export const ACTIVITIES = {
  'plan-authoring': { slots: { author: 'carrier', review: 'review' }, policy: true },
  'plan-execution': { slots: { execute: 'execute', review: 'review' }, policy: true },
  routine: { slots: { carrier: 'carrier', parallel: 'switch' }, policy: false },
};

export const POLICY_ACTIVITIES = Object.fromEntries(
  Object.entries(ACTIVITIES).filter(([, activity]) => activity.policy),
);

export const SLOT_RECIPES = {
  review: ['solo', 'reviewed', 'council'],
  execute: ['solo', 'delegated', 'subagent'],
  carrier: ['solo', 'subagent'],
  switch: ['on', 'off'],
};

export const SWITCH_SLOT = 'switch';
export const SWITCH_DEFAULT = 'on';

const CODEX = 'codex-cli-bridge';
const AGY = 'antigravity-cli-bridge';

export const DISPLAY_ALIASES = Object.freeze({ [CODEX]: 'codex', [AGY]: 'agy' });
export const BACKEND_PRIORITY = Object.freeze([CODEX, AGY]);
export const REVIEW_CMD_ALIASES = Object.freeze({
  'codex-review': Object.freeze({ backend: CODEX, receiptId: 'codex' }),
  'agy-review': Object.freeze({ backend: AGY, receiptId: 'agy' }),
});
export const receiptIdOfCmd = (cmd) => REVIEW_CMD_ALIASES[cmd]?.receiptId ?? null;
export const LENS_VERDICTS = Object.freeze(['ship', 'ship with nits', 'revise', 'rethink']);

export const isSwitchSlot = (slotType) => slotType === SWITCH_SLOT;

export const CARRY_ROLE = 'carry';
export const EXECUTOR_PROVIDER = 'executor';

export const SUBAGENT_RECIPE = {
  id: 'subagent',
  title: 'Subagent',
  role: CARRY_ROLE,
  minBackends: 1,
  degradesTo: 'solo',
  summary:
    'a full-tool frontier subagent from the placed executor vehicle carries a bounded, file-disjoint slice; the orchestrator verifies it and commits.',
};

// The readiness tokens the planner judges on. Mirrored from detect-backends.mjs rather than
// imported: this module is the leaf the planner itself imports.
const READY = 'ready';
const MISSING = 'missing';

const VEHICLE_READY_STATES = ['placed', 'customized'];

// withVehicle(readiness, survey) → a NEW array carrying the executor as the ONE provider of `carry`.
// Every caller that hands readiness to the resolver composes it this way; a role-filtered readiness
// computation is what keeps a placed executor from counting as a ready reviewer.
export const withVehicle = (readiness = [], survey = null) => [
  ...readiness.filter((entry) => entry?.name !== EXECUTOR_PROVIDER),
  {
    name: EXECUTOR_PROVIDER,
    readiness: VEHICLE_READY_STATES.includes(survey?.state) ? READY : MISSING,
    vehicle: survey,
  },
];

export const EXECUTOR_APPLY = '/agent-workflow-kit agents';

// A survey reason may quote a file the user wrote; it is collapsed to one safe line before it rides
// the one-line render contracts: no escape sequences, control bytes or line breaks, and none of the
// characters those renders use as cell structure (the separator, parentheses, the equals sign).
export const safeLine = (text) => String(text ?? '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
  .replace(/[·()=]/gu, ' ')
  .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, ' ')
  .trim();

export const vehicleDegradeReason = (survey, applyHint = EXECUTOR_APPLY) => {
  const state = survey?.state ?? MISSING;
  const reason = safeLine(survey?.reason);
  const detail = reason ? ` (${reason})` : '';
  const remedy = state === 'unusable'
    ? `fix or remove ${safeLine(survey?.rel) || '.claude/agents/executor.md'}, then place it with: ${applyHint}`
    : `place it with: ${applyHint}`;
  return `the executor vehicle is ${state}${detail} — ${remedy}`;
};

// ── the dispatch form: the ONE wording source every render prints ───────────────────
// Pure constants. `procedures.mjs` prints them for a slot resolved to `subagent`; the wording is a
// red line, so a render composes these strings and never re-words one.

// The slice noun is per ACTIVITY — what a bounded slice IS differs for execution, authoring and a
// routine chore, while the four dispatch lines below are shared by all three.
export const SLICE_BY_ACTIVITY = {
  'plan-authoring': 'a slice is a brief naming the goal, the governing spec(s) and the ledger constraints; the subagent drafts the plan or the contract from it, and the orchestrator reviews the draft as its own',
  'plan-execution': 'a slice is a set of file-disjoint ledger rows; wording is copied verbatim where wording is a red line',
  routine: "a slice is a bounded mechanical task; a read-only one (a sweep, gate triage) rides its placed read-only vehicle, or is carried solo with a stated reason when that vehicle is absent; a write-capable one (a regeneration, a fixture build) rides the executor; the changelog stays the orchestrator's",
};

export const VEHICLE_STATE_TOKEN = '<state>';

export const DISPATCH_LINES = [
  `dispatch: the executor vehicle (.claude/agents/executor.md — ${VEHICLE_STATE_TOKEN}), in the background`,
  'the orchestrator verifies every returned slice by running its suites itself',
  'the subagent is never told to commit, never a review backend, never a bridge substitute',
  'honest limit: a Claude Code lane — on a host that cannot dispatch the vehicle, follow this form by hand and say so',
];

export const PARALLEL_SOLO_NOTE = '(no effect while the carrier is solo)';

export const PARALLEL_LINES = {
  on: 'parallel: on — file-disjoint slices dispatch concurrently',
  off: 'parallel: off — one slice at a time',
};

// The slot TYPES a subagent can carry — computed from the one value table, never a second list.
export const SUBAGENT_SLOT_TYPES = Object.entries(SLOT_RECIPES)
  .filter(([, values]) => values.includes(SUBAGENT_RECIPE.id))
  .map(([slotType]) => slotType);

// dispatchForm({ activity, slot, state }) → the lines a `subagent`-resolved slot renders: the
// activity's slice sentence, then the four shared lines with the surveyed vehicle state filled in.
// A slot whose type cannot hold `subagent` (a review slot) and an unknown activity render nothing.
export const dispatchForm = ({ activity, slot, state } = {}) => {
  const slice = SLICE_BY_ACTIVITY[activity];
  const slotType = ACTIVITIES[activity]?.slots?.[slot];
  if (!slice || !SUBAGENT_SLOT_TYPES.includes(slotType)) return [];
  return [slice, ...DISPATCH_LINES.map((line) => line.replace(VEHICLE_STATE_TOKEN, state ?? MISSING))];
};

// parallelLine({ value, carrier }) → the `routine` switch line. The concurrency claim is TRUE only
// while the effective carrier is `subagent`; under a solo carrier the flag states its own inertness.
export const parallelLine = ({ value, carrier } = {}) => {
  const inert = carrier !== SUBAGENT_RECIPE.id ? ` ${PARALLEL_SOLO_NOTE}` : '';
  if (value === 'on') return inert ? `parallel: on${inert}` : PARALLEL_LINES.on;
  return `${PARALLEL_LINES.off}${inert}`;
};

refuseDirectRun(import.meta.url);
