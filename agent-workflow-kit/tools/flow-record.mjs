// flow-record.mjs — the CLOSED flow-record vocabulary's PUBLIC SURFACE (flow-orchestration,
// Phase 1): the 29 names every consumer of the record family imports through this ONE path. Pure
// form: no filesystem, no git, no CLI, no side effects on import — and no logic, this module is
// re-exports only. The store IO (flow-store.mjs) and the checker (flow-check.mjs) consume these
// predicates; nothing here reads or writes a store.
//
// The vocabulary is seeded VERBATIM from the flow design §5 closed kind set and fixed BEFORE any
// reader/writer exists; every seed member is ASSIGNED to a family (DESIGN_SEED_ASSIGNMENT, bound by
// the drift-guard test), the chain family carrying ONE record kind keyed
// {planId, cycle, stepId, round, purpose} and the store-global kinds each their own shape and
// supersession key. Fail-closed in BOTH directions: unknown schema, unknown kind, unknown purpose,
// a missing field, a malformed field, and an unknown EXTRA field are all refusals — the per-record
// canonical digest is the record's identity, so a stray key would fork it.
//
// Reference domain (#63): every inter-record reference is the per-record canonical digest — sha256
// over the canonical (recursively key-sorted, byte-layout-independent) serialization of ONE record,
// with NO trailing newline; multi-record framing belongs to stores, never to this primitive.
//
// Honest residuals: reference RESOLUTION against a real store (forged / mismatched / superseded
// targets, adoption content-digest binding) lands with flow-store/flow-check; this family resolves
// references only inside an in-memory record list and validates form, per-chain sequence legality,
// and selection. Records remain forgeable — a self-discipline mechanism, not a security boundary.
//
// LAYOUT (baseline-practices tranche 3): the code lives in five leaves, imports running ONE way —
// legality → shape and identity → vocabulary, with the manifest leaf beside them:
//   • flow-vocabulary.mjs       — the closed kind/purpose sets, the terminal lanes, the seed
//                                 assignment, the transition table, and (off this surface) the five
//                                 shared form bindings every validator states its refusals in
//   • flow-record-shape.mjs     — the closed per-kind field shapes and validateFlowRecord
//   • flow-record-identity.mjs  — keys, latest-per-key selection, tree identity (#21), the
//                                 canonical digest (#63), the Decision-7 digests, the projection
//   • flow-legality.mjs         — the two raw-order legality walks over an in-memory list
//   • flow-finding-manifest.mjs — the wrapper finding manifest (P24) and its fatal-UTF-8 decoder
// No leaf imports this facade — that edge would be the cycle test/read-graph-purity.test.mjs reds,
// and test/flow-record-layout.test.mjs pins the surface, the bindings, the caps and the direction.

export {
  FLOW_SCHEMA_VERSION, CHAIN_KIND, CHAIN_PURPOSES, STEP_SCOPED_PURPOSES, PLAN_LANE_PURPOSES,
  GLOBAL_KINDS, FLOW_KINDS, TERMINAL_LANES, DESIGN_SEED_ASSIGNMENT, ALLOWED_TRANSITIONS,
} from './flow-vocabulary.mjs';

export { SUBSET_ATTEMPT_DIAGNOSIS_FROM, validateFlowRecord } from './flow-record-shape.mjs';

export {
  flowRecordKey, authoritativeFlowRecords, isTransitionShaped, flowTreeIdentity,
  flowCanonicalSerialization, canonicalFlowDigest, subsetFoldBatchDigest, subsetGateIdsDigest,
  ownerScopedFlowProjection, flowProjectionHash,
} from './flow-record-identity.mjs';

export { validateChainSequence, validateSupersessions } from './flow-legality.mjs';

export {
  SAFE_NONCE_RE, FINDING_MANIFEST_PREFIX, findingManifestBasename, validateFindingManifest,
  decodeFindingManifest,
} from './flow-finding-manifest.mjs';
