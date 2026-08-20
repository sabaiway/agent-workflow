// flow-store.mjs — the flow store's PUBLIC SURFACE (flow-orchestration, Phases 2-3): the 29 names
// every consumer of the store imports through this ONE path. No CLI, no logic, no side effects on
// import — this module is re-exports only.
//
// The store pins to the git COMMON dir because flow records must be shared across worktrees
// (#49/#57); appends are serialized by an exclusive-create lock file beside the store. Everything
// fails closed: bounded lock waits with named refusals per holder class, custody-checked release
// (only the inode the winning CAS fd proved is ever removed), fd-based no-follow reads, and a
// SEMANTIC append preflight on one captured snapshot — an illegal record never lands.
//
// LAYOUT (baseline-practices tranche 2): the read half stays in flow-store-read.mjs (it owns no
// write API, so read-only surfaces like the procedures advisor import it directly), and the
// flow-SPECIFIC write side lives in five leaves, imports running ONE way — mints → append → pure
// leaves → flow-record:
//   • flow-chain-state.mjs    — PURE: the chain-state walk + the generic reference validator (#63)
//   • flow-subset-budget.mjs  — PURE: the Decision-7/8 counting-context budget and its gate
//   • flow-append.mjs         — the ONE write door: the lane over store-append.mjs, the semantic
//                               preflight, the run-lock lanes, the locked subset-attempt factory
//   • flow-adoption-mint.mjs  — the adoption mint (#58)
//   • flow-delta-proof.mjs    — the bookkeeping-delta custody proof (#60)
// No leaf imports this facade — that edge would be the cycle test/read-graph-purity.test.mjs reds,
// and test/flow-store-layout.test.mjs pins the surface, the bindings, the caps and the direction.
//
// Declared residuals no dependency-free core-Node mechanism can close: the pathname lstat→rename
// and reread→rename windows (no flock/fcntl, no inode-conditional unlink or rename) and bind-mount
// aliasing. Records remain forgeable — a self-discipline mechanism in the git dir, not a security
// boundary.

export {
  FLOW_STORE_STOP, FLOW_STORE_BASENAME, FLOW_LOCK_SUFFIX,
  resolveFlowStorePath, resolveFlowLockPath, parseFlowStoreText, readFlowStore, deriveFlowOwner,
} from './flow-store-read.mjs';

export {
  priorChainTerminal, walkChainState, resolveRecordReference, isAuthoritativeReferenceTarget,
  validateOpenerReference,
} from './flow-chain-state.mjs';

export {
  SUBSET_ATTEMPT_MAX_REDS, SUBSET_ATTEMPT_DIAGNOSIS_REDS, subsetAttemptState, subsetExhaustionRemedy,
} from './flow-subset-budget.mjs';

export {
  FLOW_LOCK_WAIT_MS, FLOW_LOCK_POLL_MS, appendFlowRecord, appendFlowRecordWithPreflight,
  SUBSET_RUN_LOCK_INFIX, acquireSubsetRunLock, probeFlowAppendLock, appendSubsetAttempt,
} from './flow-append.mjs';

export { readPlanFrontmatterId, mintAdoption } from './flow-adoption-mint.mjs';

export { computeMaskedFingerprintPayload, mintBookkeepingDelta } from './flow-delta-proof.mjs';
