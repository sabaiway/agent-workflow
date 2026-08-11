// source-size-core.mjs — the PURE READ core of the source-size practice (D-18): the ONE import point
// for every surface that must ask about the practice without reaching a writer. It owns no logic and
// no write API, and spawns only a read-only git query, so the read-graph purity suite
// (test/read-graph-purity.test.mjs) stays true however the halves behind it move.
//
// The halves, each holding ONE rule set and each within the cap this practice declares:
//   • source-size-refusal.mjs  — the two exit classes, and the absolute config path every refusal names
//   • source-size-config.mjs   — the config file: its grammar, its four states, its reader
//   • source-size-scope.mjs    — which files are judged (D-6) and how big each one is (D-7)
//   • source-size-gate-cmd.mjs — whether a declared gate cmd IS this checker (the canonical matcher)
//
// Re-export only: a consumer imports the practice, never a particular half, so a later split moves
// code without touching a single call site.

export {
  SOURCE_SIZE_CONFIG_REL,
  SOURCE_SIZE_STOP,
  SOURCE_SIZE_WHY,
  configFail,
  configPathFor,
  escapeForLine,
  isLineUnsafe,
  jsonForLine,
  scopeFail,
} from './source-size-refusal.mjs';

export {
  AUTHORED_KEYS,
  INITIAL_ADOPTION_REASON,
  MACHINE_KEYS,
  REASON_MAX_BYTES,
  SOURCE_SIZE_DEFAULTS,
  SOURCE_SIZE_SCHEMA,
  loadSourceSizeConfig,
  practiceFacts,
  reasonDefect,
  segmentPrefixOf,
  validateSourceSizeConfig,
} from './source-size-config.mjs';

export {
  countBytes,
  enumerateIndex,
  measureFile,
  resolveScope,
} from './source-size-scope.mjs';

export {
  SOURCE_SIZE_GATE_ID,
  SOURCE_SIZE_TOOL_PATH,
  dqUnsafePath,
  matchesSourceSizeGate,
} from './source-size-gate-cmd.mjs';
