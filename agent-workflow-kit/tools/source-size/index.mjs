// index.mjs — the door of the size check's module: every kit module outside tools/source-size/
// reaches it through this file alone.

export {
  KIT_LIMITS,
  SCHEMA1_REASON,
  applyOverride,
  limitLines,
  limitsDefect,
  migrateSchema1,
  resolveLimits,
} from './limits.mjs';

export {
  SPEC_STORE_ROOT,
  bandOf,
  layoutCounts,
  layoutDefect,
  walkSpecStore,
} from './layout.mjs';

export {
  changesFor,
  isRaise,
  materialize,
  ownEntry,
  planRecord,
  projectLayout,
  serialize,
} from './record.mjs';

export {
  SETUP_ANSWERS,
  checkTargetOf,
  layoutSetupOf,
} from './setup.mjs';
