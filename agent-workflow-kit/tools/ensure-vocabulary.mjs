// ensure-vocabulary.mjs — the CLOSED vocabulary of the upgrade ensures: which operations exist, which
// outcome tokens they may print, which cause words may open a failure line, and which of those the
// mode doc teaches.
//
// It is a PURE LEAF (no imports at all) for one reason: the read-only doc-parity lint binds the
// relayed token set into `references/modes/upgrade.md`, and reading a vocabulary must never drag the
// ensure implementation — and through it the orchestration WRITER and the atomic-write core — into a
// read-only tool's import graph. Vocabulary here, behaviour in ensure-ops.mjs.

// The FIXED order the CLI runs them in — the order references/modes/upgrade.md already prescribed.
// `specs` sits after `scripts` (its reader pair is a scripts/ seed too) and BEFORE `index`: the store
// root it seeds is a docs/ai file the navigator must count.
export const ENSURE_OPS = Object.freeze(['orchestration', 'gates', 'autonomy', 'scripts', 'specs', 'index']);

// Tokens that assert a WRITE happened. --dry-run may never emit one of these (the CLI's contract test
// walks this set), and each has exactly one `would-` counterpart below. `refreshed` is the spec-layer
// ensure's pair refresh (reader or checker) — a deployed script on a body a release shipped,
// rewritten to the bundled one (a custom body is never refreshed).
export const WRITE_TOKENS = Object.freeze(['seeded', 'note-refreshed', 'refreshed', 'regenerated']);
export const DRY_RUN_TOKENS = Object.freeze(['would-seed', 'would-refresh-note', 'would-refresh', 'would-regenerate']);

// The CLOSED outcome vocabulary. Closed at RUNTIME, not by convention: composing an outcome with a
// token outside this list throws, so an op cannot quietly invent a word the mode doc has never heard
// of and the caller has no idea how to relay. EVERY operational failure prints the ONE token
// `failed` and names its CAUSE at the head of its detail line — a specific token would read as
// vocabulary the mode doc never taught (both review backends found exactly that).
export const ENSURE_TOKENS = Object.freeze([
  ...WRITE_TOKENS,
  ...DRY_RUN_TOKENS,
  'already-current',
  'already-present',
  'customized-preserved',
  'malformed-preserved',
  'skipped-no-node',
  'old-adr-layout-migration-instructed',
  'failed',
]);

// The closed CAUSE set — the word that opens a `failed` line. Closed for the same reason the tokens
// are: the doc promises "a failed line names its cause", and this is that list. `unexpected-error`
// is the honest cause for a throw nobody planned for: the failure is still named, never bare.
export const FAILURE_CAUSES = Object.freeze([
  'race-unresolved',
  'template-unreadable',
  'bundle-unreadable',
  'adr-layout-unverifiable',
  'wrong-node-kind',
  'write-refused',
  'unexpected-error',
  // The navigator ensure drives a SEPARATE PROCESS (the bundled generator), so its failures split by
  // how far that process got: it never launched · it launched and did not succeed · the freshness
  // probe itself could not answer · it claimed a regeneration the re-probe still finds stale. Only
  // the first and third are provably pre-mutation; the other two DISCLOSE a possible partial write.
  'generator-unlaunchable',
  'generator-failed',
  'index-probe-failed',
  'index-stale-after-write',
]);

// The causes the mode doc must TEACH, so an agent relaying a `failed` line knows every word that can
// open one. Bound into references/modes/upgrade.md by doc-parity — the executable half of "a failed
// line names its cause": a cause the tool can print but the doc never named fails the lint.
export const RELAYED_FAILURE_CAUSES = FAILURE_CAUSES;

// The subset references/modes/upgrade.md enumerates, so the agent relaying an upgrade knows every
// outcome by name. doc-parity binds each of these into that doc: a reworded doc that drops one fails
// the check instead of silently teaching an outcome set the tool no longer has. The dry-run pair is
// deliberately outside it — upgrade never runs the preview.
export const RELAYED_ENSURE_TOKENS = Object.freeze([
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
]);

// The four files the enforcement-script ensure seeds (AD-051's ADR cascade + the tokenizer it needs).
// Seed nothing else: the other tokenizer-era tests red beside an OLD archiver.
export const SEED_SCRIPTS = Object.freeze([
  'archive-decisions.mjs',
  'archive-decisions.test.mjs',
  'markdown-blocks.mjs',
  'markdown-blocks.test.mjs',
]);
