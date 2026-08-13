// source-size-gate-cmd.mjs — whether a declared gate cmd IS this checker, and — when it is not —
// WHICH of the three claims it makes instead. The shape, admissibility and realpath screens live in
// checker-claim.mjs (the ONE home, twinned into the standalone migration); this module owns only
// the binding to THIS tool. Mirrors the SHAPE of the review-dependent matcher
// (gates-declaration.mjs) without joining either of its arrays: this gate is neither a final core
// check nor review-dependent.
//
// Dependency-free, Node >= 22. No side effects on import.

import { fileURLToPath } from 'node:url';
import { CHECKER_CLAIM, checkerClaimTool, classifyCheckerClaim, dqUnsafePath } from './checker-claim.mjs';

export { dqUnsafePath };

export const SOURCE_SIZE_GATE_ID = 'source-size';
export const SOURCE_SIZE_TOOL_PATH = fileURLToPath(new URL('./source-size-check.mjs', import.meta.url));

const SOURCE_SIZE_TOOL = checkerClaimTool('source-size-check.mjs', SOURCE_SIZE_TOOL_PATH);

// The three-outcome read: `canonical` (this copy), `tool-elsewhere` (the same invocation shape
// resolving to another real copy of the checker — a vendored deployment, not an absence), or
// `not-the-tool`.
export const classifySourceSizeGate = (cmd, projectDir) => classifyCheckerClaim(SOURCE_SIZE_TOOL, cmd, projectDir);

// The boolean surface every existing consumer already asks through — "is this gate MY checker?" —
// kept exactly as narrow as it was: only the canonical claim answers yes.
export const matchesSourceSizeGate = (cmd, projectDir) => classifySourceSizeGate(cmd, projectDir) === CHECKER_CLAIM.CANONICAL;
