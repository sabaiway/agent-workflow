#!/usr/bin/env node
// autonomy-write.mjs — the ONLY filesystem WRITER for docs/ai/autonomy.json. It is imported by the
// set-autonomy writer alone; no read-only module (autonomy-config.mjs, velocity-profile.mjs's read
// path) imports it, so "a read-only surface can never reach a writer" is a STRUCTURAL invariant (an
// import-split test pins it), not just an assertion. Splitting the writer out of the schema/read module
// keeps the read surface fs-write-free — the orchestration-write.mjs precedent (AD-044).
//
// The hardened write flow (deployment gate → symlink STOPs → containment guard → exclusive-create tmp
// + rename with a TOCTOU re-check → tmp cleanup; LAST-WRITER-WINS) lives in the shared atomic-write
// core (tools/atomic-write.mjs, AD-042) and is consumed here with this module's own STOP identity, so
// the public API + error contract are its own (this file's tests pin them).
//
// Dependency-free, Node >= 18. Every fs primitive is injectable (deps.*) so the guards are unit-testable.

import { AUTONOMY_REL, serializeAutonomy } from './autonomy-config.mjs';
import { writeDocsAiFileAtomic } from './atomic-write.mjs';

// A typed STOP — a deliberate refusal we surface (deployment gate / symlinked leaf), distinct from a
// native fs error. `Object.assign(new Error(), { code })`, the codebase's typed-error idiom (no classes).
export const AUTONOMY_WRITE_STOP = 'AUTONOMY_WRITE_STOP';
const stop = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'AutonomyWriteStop', code: AUTONOMY_WRITE_STOP });

// writeAutonomy(cwd, config, deps) → { writtenPath } on success; THROWS a typed STOP (no deployment /
// symlinked leaf) or a native fs error otherwise. The tmp is cleaned up on any failure after its
// creation. config is serialized canonically (serializeAutonomy: 2-space, _README-first, trailing NL).
export const writeAutonomy = (cwd, config, deps = {}) =>
  writeDocsAiFileAtomic(cwd, AUTONOMY_REL, serializeAutonomy(config), deps, { stop, noun: 'a policy' });
