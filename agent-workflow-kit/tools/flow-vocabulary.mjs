// flow-vocabulary.mjs — the CLOSED flow-record vocabulary (kinds, purposes, terminal lanes, the
// design seed assignment, the allowed-transition table) plus the five shared form bindings every
// validator states its refusals in: HEX64_RE, isPlainObject, isNonEmptyString, isHex64 and refuse.
// Split out of flow-record.mjs unchanged (baseline-practices tranche 3), which now re-exports the
// ten public names here; the five shared bindings stay OFF that surface (plan D3) — the leaves that
// need them import this module, so the record family's named grammars have exactly one home and no
// copy can drift.
//
// The LOWEST leaf of the family and pure form: no filesystem, no git, no CLI, no side effects on
// import, and orchestration-config.mjs (the schema version) is its only tools sibling. Imports run
// ONE way — the shape, identity, legality and manifest leaves compose this module; nothing here
// reaches back up to the facade.

import { FLOW_SCHEMA_VERSION } from './orchestration-config.mjs';

export { FLOW_SCHEMA_VERSION };

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

// ── the closed vocabulary ─────────────────────────────────────────────────────────────────────────

export const CHAIN_KIND = 'chain';
export const CHAIN_PURPOSES = deepFreeze(['adoption', 'round', 'refresh', 're-baseline', 'freeze', 'unfreeze', 'park', 'resume', 'converged', 'complete']);
export const STEP_SCOPED_PURPOSES = deepFreeze(['round', 'refresh', 're-baseline', 'freeze', 'unfreeze', 'converged']);
export const PLAN_LANE_PURPOSES = deepFreeze(['adoption', 'park', 'resume', 'complete']);
export const GLOBAL_KINDS = deepFreeze(['internal-attestation', 'down-mark', 'down-mark-up', 'down-mark-clear', 'degrade-justification', 'rerun-cause', 'bookkeeping-delta', 'maintainer-override', 'consult-attestation', 'subset-attempt']);
export const FLOW_KINDS = deepFreeze([CHAIN_KIND, ...GLOBAL_KINDS]);

// Reserved lane-typed terminals (#16): converged terminates a CYCLE (its step's sequence), complete
// terminates the PLAN. Park is a resumable suspension, never a terminal (#59).
export const TERMINAL_LANES = deepFreeze({ converged: 'cycle', complete: 'plan' });

// Design §5 seed member → family assignment; the drift-guard test binds this map to the verbatim
// seed list on one side and to the shipped CHAIN_PURPOSES/GLOBAL_KINDS on the other.
export const DESIGN_SEED_ASSIGNMENT = deepFreeze({
  adoption: { family: 'chain', purpose: 'adoption' },
  'round-chain': { family: 'chain', purpose: 'round' },
  refresh: { family: 'chain', purpose: 'refresh' },
  're-baseline': { family: 'chain', purpose: 're-baseline' },
  unfreeze: { family: 'chain', purpose: 'unfreeze' },
  freeze: { family: 'chain', purpose: 'freeze' },
  converged: { family: 'chain', purpose: 'converged' },
  park: { family: 'chain', purpose: 'park' },
  resume: { family: 'chain', purpose: 'resume' },
  complete: { family: 'chain', purpose: 'complete' },
  'internal-attestation': { family: 'global', kind: 'internal-attestation' },
  'down-mark': { family: 'global', kind: 'down-mark' },
  'down-mark up': { family: 'global', kind: 'down-mark-up' },
  'down-mark clear': { family: 'global', kind: 'down-mark-clear' },
  'degrade-justification': { family: 'global', kind: 'degrade-justification' },
  'rerun-cause': { family: 'global', kind: 'rerun-cause' },
  'bookkeeping-delta': { family: 'global', kind: 'bookkeeping-delta' },
  'maintainer-override': { family: 'global', kind: 'maintainer-override' },
  'consult-attestation': { family: 'global', kind: 'consult-attestation' },
});

// The allowed-transition table — an exported frozen structure, never prose. Within a step:
// converged ends the sequence (only the unfreeze lane reopens it, and only in its own cycle);
// freeze admits only unfreeze/converged. Plan lane: park admits only resume (and both preserve the
// pre-park cycle/round); complete admits nothing; adoption is only ever the chain's first record.
// The boundary lane (between steps): the opener round, the unfreeze reopen, and a re-baseline for
// disjoint base motion that reopens nothing. The cross-step edge (the opener's prior-terminal
// reference) is enforced by validateChainSequence, distinct from the within-step successor rule.
export const ALLOWED_TRANSITIONS = deepFreeze({
  stepOpening: 'round',
  withinStep: {
    round: ['round', 'refresh', 're-baseline', 'freeze', 'converged'],
    refresh: ['round', 'refresh', 're-baseline', 'freeze', 'converged'],
    're-baseline': ['round', 'refresh', 're-baseline', 'freeze', 'converged'],
    freeze: ['unfreeze', 'converged'],
    unfreeze: ['round', 'refresh', 're-baseline', 'freeze', 'converged'],
    converged: ['unfreeze'],
  },
  planLane: {
    adoption: ['round', 'park', 'complete'],
    park: ['resume'],
    resume: ['round', 'park', 'complete'],
    complete: [],
  },
  boundary: ['round', 'unfreeze', 're-baseline'],
});

// ── the shared form bindings (D3) — the record family's named grammars, off the public surface ────

export const HEX64_RE = /^[0-9a-f]{64}$/;
export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
export const isHex64 = (v) => typeof v === 'string' && HEX64_RE.test(v);

export const refuse = (reason) => ({ ok: false, reason });
