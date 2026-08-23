// upgrade-runlist.mjs — the ORDERED registry of the upgrade step-3 operations: the ONE home for
// their identity (stable id · exact command · consent gate · relayed outcome vocabulary).
//
// references/modes/upgrade.md step 3 opens with a checklist rendered from these entries — the
// structure test (test/upgrade-runlist.test.mjs) binds checklist rows ↔ entries: same backticked
// ids, same order, each row carrying its registry command and naming its outcomes — and the future
// reconcile driver reads its item tokens from here (queue row UPGRADE-RECONCILE-DRIVER).
//
// A PURE LEAF with zero imports (the ensure-vocabulary.mjs pattern): reading operation identity
// must never drag an operation's implementation — and through it the writers — into a read-only
// consumer's import graph. The `configs` outcomes are a literal copy of RELAYED_ENSURE_TOKENS
// (ensure-vocabulary.mjs stays the owner); the structure test asserts the copy never drifts.
//
// `consent` is null for an operation the agent runs outright, else the ONE consent gate the mode
// doc teaches for it. `outcomes` is the vocabulary the doc names for relaying that operation's
// result — for `configs` the closed ensure tokens, elsewhere the doc's own outcome words.

const entry = (id, command, consent, outcomes) =>
  Object.freeze({ id, command, consent, outcomes: Object.freeze(outcomes) });

export const UPGRADE_RUNLIST = Object.freeze([
  entry(
    'pointers',
    'node ${CLAUDE_SKILL_DIR}/tools/inject-methodology.mjs reconcile <project>/AGENTS.md',
    null,
    ['added', 'already present', 'skipped', 'STOP'],
  ),
  entry(
    'footprint',
    'node ${CLAUDE_SKILL_DIR}/tools/hide-footprint.mjs --dir <project> --reconcile --dry-run',
    'ambiguous → ask the user which it is; hidden → the conditional re-run without --dry-run (surfaced paths ask per bootstrap step 9)',
    ['visible', 'ambiguous', 'hidden'],
  ),
  entry(
    'configs',
    'node ${CLAUDE_SKILL_DIR}/tools/ensure-configs.mjs --reconcile --cwd <project>',
    null,
    [
      'seeded',
      'note-refreshed',
      'refreshed',
      'regenerated',
      'already-current',
      'customized-preserved',
      'malformed-preserved',
      'already-present',
      'skipped-no-node',
      'old-adr-layout-migration-instructed',
      'failed',
    ],
  ),
  entry(
    'gates-migration',
    'node ${CLAUDE_SKILL_DIR}/references/scripts/migrate-gates.mjs --kit-tools ${CLAUDE_SKILL_DIR}/tools --cwd <project>',
    'preview first — apply only on an explicit yes, re-run with --apply',
    ['preview', 'INERT', 'CUSTOMIZED'],
  ),
  entry(
    'bridges',
    'node ${CLAUDE_SKILL_DIR}/tools/setup-backends.mjs --refresh-placed',
    null,
    [
      'refreshed',
      'already current',
      'skipped',
      'not placed',
      'newer than the bundle',
      'unsupported host',
      'skipped-readonly',
      'could not refresh',
    ],
  ),
  entry(
    'lens',
    'node ${CLAUDE_SKILL_DIR}/tools/lens-region.mjs reconcile <project>/docs/ai/agent_rules.md',
    null,
    [
      'refreshed',
      'already current',
      'custom edit preserved',
      'file absent',
      'engine too old',
      'over the line cap — refused',
      'section absent — noted',
      'STOP',
    ],
  ),
  entry(
    'bridge-settings',
    'node ${CLAUDE_SKILL_DIR}/tools/bridge-settings.mjs --reconcile',
    null,
    ['ok', 'absent', 'flagged', 'duplicates', 'unusable'],
  ),
]);
