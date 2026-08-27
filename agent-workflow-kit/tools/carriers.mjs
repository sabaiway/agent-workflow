// carriers.mjs — the activity/slot registry plus the subagent carrier's readiness composition.
// ACTIVITIES + SLOT_RECIPES are the ONE table: recipes.mjs re-exports them, so no importer's path
// moves. The carrier half declares the `subagent` recipe, appends the executor vehicle to a
// readiness array as the single provider of the `carry` role, and words the degrade a missing or
// unusable vehicle causes. Governing contract: docs/ai/specs/kit/carriers.md.
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
const oneLine = (text) => String(text ?? '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
  .replace(/[·()=]/gu, ' ')
  .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, ' ')
  .trim();

export const vehicleDegradeReason = (survey, applyHint = EXECUTOR_APPLY) => {
  const state = survey?.state ?? MISSING;
  const reason = oneLine(survey?.reason);
  const detail = reason ? ` (${reason})` : '';
  const remedy = state === 'unusable'
    ? `fix or remove ${oneLine(survey?.rel) || '.claude/agents/executor.md'}, then place it with: ${applyHint}`
    : `place it with: ${applyHint}`;
  return `the executor vehicle is ${state}${detail} — ${remedy}`;
};

refuseDirectRun(import.meta.url);
