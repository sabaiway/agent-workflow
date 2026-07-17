#!/usr/bin/env node
// orchestration-write.mjs — the ONLY filesystem WRITER for docs/ai/orchestration.json. It is imported
// by the set-recipe writer alone; procedures.mjs never imports it, so "the read-only procedures advisor
// can never reach a writer" is a STRUCTURAL invariant (an import-split test pins it), not just an
// assertion. Splitting the writer out of the schema/read module keeps the read surface fs-write-free.
//
// The hardened write flow (deployment gate → symlink STOPs → containment guard → exclusive-create
// tmp + rename with a TOCTOU re-check → tmp cleanup; LAST-WRITER-WINS, documented) lives in the
// shared atomic-write core (tools/atomic-write.mjs, extracted from this module — AD-042) and is
// consumed here with this module's own STOP identity, so the public API + error contract are
// unchanged (this file's tests pin them, characterize-first).
//
// Dependency-free, Node >= 22. Every fs primitive is injectable (deps.*) so the guards are unit-testable.

import { CONFIG_REL, serializeConfig } from './orchestration-config.mjs';
import { writeDocsAiFileAtomic } from './atomic-write.mjs';

// A typed STOP — a deliberate refusal we surface (deployment gate / symlinked leaf), distinct from a
// native fs error. `Object.assign(new Error(), { code })`, the codebase's typed-error idiom (no classes).
export const ORCH_WRITE_STOP = 'ORCH_WRITE_STOP';
const stop = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'OrchWriteStop', code: ORCH_WRITE_STOP });

// writeConfig(cwd, config, deps) → { writtenPath } on success; THROWS a typed STOP (no deployment /
// symlinked leaf) or a native fs error otherwise. The tmp is cleaned up on any failure after its
// creation. config is serialized canonically (serializeConfig: 2-space, _README-first, trailing NL).
export const writeConfig = (cwd, config, deps = {}) =>
  writeDocsAiFileAtomic(cwd, CONFIG_REL, serializeConfig(config), deps, { stop, noun: 'a config' });
