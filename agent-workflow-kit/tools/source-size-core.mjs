// source-size-core.mjs — the PURE READ core of the source-size practice (D-18): the ONE import point
// for every surface that must ask about the practice without reaching a writer. It owns no logic but
// the layout setup's and the pile offer's bound forms, no write API, and spawns only a read-only git query, so the read-graph purity suite
// (test/read-graph-purity.test.mjs) stays true however the halves behind it move.
//
// The halves, each holding ONE rule set and each within the cap this practice declares:
//   • source-size-refusal.mjs  — the two exit classes, and the absolute config path every refusal names
//   • source-size-config.mjs   — the config file: its grammar, its four states, its reader
//   • source-size-scope.mjs    — which files are judged (D-6) and how big each one is (D-7)
//   • source-size-gate-cmd.mjs — whether a declared gate cmd IS this checker (the canonical matcher),
//                                and which of the three tool claims it makes when it is not
//   • source-size/index.mjs    — the door of the size check's module: the kit's limits and their
//                                lines, the band and the layout count, the recorded ratchet as data
//                                and the layout setup
//
// Re-export only, but for readLayoutSetup and readPileOffer: a consumer imports the practice, never a particular half, so
// a later split moves code without touching a single call site.

import { lstatSync, realpathSync } from 'node:fs';
import { readFileBytesNoFollowCapped } from './fs-read-nofollow.mjs';
import { INITIAL_ADOPTION_REASON, SOURCE_SIZE_SCHEMA, loadSourceSizeConfig, validateSourceSizeConfig } from './source-size-config.mjs';
import { judgeTree, stopsOf } from './source-size-judge.mjs';
import { isLineUnsafe, jsonForLine } from './source-size-refusal.mjs';
import { PILE_QUEUE_MAX_BYTES, layoutSetupOf, pileOfferOf } from './source-size/index.mjs';

export {
  SOURCE_SIZE_CONFIG_REL,
  SOURCE_SIZE_STOP,
  SOURCE_SIZE_WARNING_PREFIX,
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
  LAYOUT_KEY,
  MACHINE_KEYS,
  REASON_MAX_BYTES,
  SOURCE_SIZE_DEFAULTS,
  SOURCE_SIZE_SCHEMA,
  assertNoStoreRoot,
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
  KIT_LIMITS,
  SCHEMA1_REASON,
  SPEC_STORE_ROOT,
  applyOverride,
  bandOf,
  changesFor,
  isRaise,
  layoutCounts,
  layoutDefect,
  limitLines,
  limitsDefect,
  materialize,
  migrateSchema1,
  ownEntry,
  planRecord,
  projectLayout,
  resolveLimits,
  serialize,
  walkSpecStore,
  SETUP_ANSWERS,
  checkTargetOf,
  layoutSetupOf,
  PILE_ANSWERS,
  PILE_HELD,
  PILE_QUEUE_MAX_BYTES,
  PILE_QUEUE_REL,
  pileIdOf,
  pileOfferOf,
  pileRowOf,
  pilesOf,
  queueChecksOf,
  spliceLater,
} from './source-size/index.mjs';

export {
  SOURCE_SIZE_GATE_ID,
  SOURCE_SIZE_TOOL_PATH,
  classifySourceSizeGate,
  dqUnsafePath,
  matchesSourceSizeGate,
} from './source-size-gate-cmd.mjs';

// The claim vocabulary itself — a consumer naming an outcome imports the name, never a string
// literal it could misspell into a silently-never-true comparison.
export { CHECKER_CLAIM } from './checker-claim.mjs';

// readLayoutSetup(root, deps) → the layout setup's answer for a project, the one bound form the advisor
// and the git-hooks leaf ask: the loader, the tree judge and its stop filter, the absent config the
// check judges (schema 2 under the kit's values) and the reason the record's first entries take.
export const readLayoutSetup = (root, deps = {}) => layoutSetupOf(root, {
  loadSourceSizeConfig,
  judgeTree,
  stopsOf,
  absentConfig: validateSourceSizeConfig({ schema: SOURCE_SIZE_SCHEMA }),
  reason: INITIAL_ADOPTION_REASON,
}, deps);

// readPileOffer(root, declaration, deps) → the pile offer for a project, the one bound form the advisor
// and the writer ask: the loader, the capped no-follow queue read, realpath, lstat and the line rule.
// `declaration` is the caller's loadDeclaration answer, or { outcome: 'error', message } where it threw.
export const readPileOffer = (root, declaration, deps = {}) => pileOfferOf(root, {
  loadSourceSizeConfig,
  readQueue: (path) => readFileBytesNoFollowCapped(path, PILE_QUEUE_MAX_BYTES),
  realpath: realpathSync,
  lstat: lstatSync,
  isLineUnsafe,
  jsonForLine,
}, declaration, deps);
