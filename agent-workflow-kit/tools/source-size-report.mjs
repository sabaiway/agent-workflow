// source-size-report.mjs — the words a verdict is delivered in. Every refusal this practice prints
// must name the file, the actual value, the allowed value AND a step the reader can perform against
// THIS build — never a bare "too big" and never a command that does not exist yet.
//
// Two render contracts, honestly separated (D-3a): a TIGHTEN warns, the tree shrank below its
// record, and prints the regenerator EXACTLY as it should be pasted, no reason asked; a GROWTH stops,
// the regeneration would RAISE a value, and prints the command as a TEMPLATE carrying the reason
// placeholder, the requirement stated. The exception both share: on a project path that does not
// survive double-quoting, NO command is rendered (a rendered one could run somewhere else) — the
// parameters, the reason requirement and the manual lane are stated instead.
//
// The standing echo (D-17 U4) rides the same two renders: a PASS states the practice in one line, so
// the enforced path itself keeps the caps in front of the reader, and every refusal CLOSES with the
// canonical WHY sentence — a cap whose reason has to be looked up is a cap that reads as arbitrary.
//
// Dependency-free, Node >= 22. No writes, no side effects on import.

import { SOURCE_SIZE_CONFIG_REL, SOURCE_SIZE_WARNING_PREFIX, SOURCE_SIZE_WHY, configPathFor, escapeForLine, isLineUnsafe, jsonForLine } from './source-size-refusal.mjs';
import { INITIAL_ADOPTION_REASON, SOURCE_SIZE_SCHEMA, practiceFacts } from './source-size-config.mjs';
import { SOURCE_SIZE_TOOL_PATH, dqUnsafePath } from './source-size-gate-cmd.mjs';
import { hasLoweredRecord, stopsOf, warningsOf } from './source-size-judge.mjs';
import { isRaise, limitLines } from './source-size/index.mjs';

// The project directory is project-controlled too, so the path every refusal names enters its line
// escaped like any other such value. configPathFor itself stays literal — it also builds the real
// filesystem path the writer opens.
const namedConfig = (cwd) => escapeForLine(configPathFor(cwd));

export const GROWTH_REASON_PLACEHOLDER = '<why this size is accepted>';

// The `_README` the kit's schema-1 template carried, frozen: the move replaces a `_README` byte-equal
// to it with the schema-2 text and carries any other verbatim.
export const SCHEMA1_TEMPLATE_README = 'Source-size practice: declared scope + thresholds + the recorded ratchet. Authored keys: schema, defaults, roots, exclude, extensions. Machine keys: baseline, aggregate — each recorded entry carries a reason, and a recorded size is debt, not permission. Strict JSON — unknown keys refused.';
export const TEMPLATE_README = 'Source-size practice: declared scope + the recorded ratchet; the limits are the kit\'s, kept in its code. Authored keys: schema, roots, exclude, extensions, limits (a project\'s reasoned overrides of a kit limit). Machine keys: baseline, aggregate, layout — each recorded entry carries a reason, and a recorded size is debt, not permission. Strict JSON — unknown keys refused.';
export const TEMPLATE_READMES = Object.freeze({ schema1: SCHEMA1_TEMPLATE_README, schema2: TEMPLATE_README });

// The authoring template (D-5): GENERIC, and INERT by construction — its roots/extensions carry
// placeholders the validator refuses, so it can never be pasted into an empty-green scope.
export const authoringTemplate = () => JSON.stringify({
  _README: TEMPLATE_README,
  schema: SOURCE_SIZE_SCHEMA,
  roots: ['<a directory this practice covers>'],
  exclude: [],
  extensions: ['<.an-extension-this-practice-covers>'],
}, null, 2);

// The five limits every run that reaches a resolved config states, from the module's one function.
export const statedLimitLines = (config) =>
  limitLines(config.limits, { escape: escapeForLine, recorded: config.layout !== null }).map((line) => `source-size: ${line}`);

// What a run does not judge is said once, before its warnings: no extension, no config, no layout.
export const notJudgedLines = (cwd, { absent, config, layout }) => {
  if (absent) return [`source-size: NOTE — ${namedConfig(cwd)} is absent, so the kit's values judge layout alone and no file is judged on lines or bytes`];
  return [
    ...(config.extensions.length === 0 ? [`source-size: NOTE — ${namedConfig(cwd)} declares no extension, so no file is judged on lines or bytes`] : []),
    ...(layout ? [] : [`source-size: NOTE — ${namedConfig(cwd)} records no "layout", so entries per directory, depth and files per root are not judged; --write-baseline --layout --reason "<text>" starts it`]),
  ];
};

// A rendered command carries the RESOLVED tool path and an explicit quoted --cwd, so it means the
// same thing from any directory. It is WITHHELD on either of two grounds, and the render says WHICH
// one fired: a reader told their path "does not survive double-quoting" when it quotes perfectly
// goes off to fix the wrong thing. The grounds are made DISJOINT by testing line-safety FIRST — a
// newline satisfies both, and a path that cannot be printed at all is not a quoting question. The
// recovery lane is identical either way; only the diagnosis differs.
const WITHHELD_SHELL = 'source-size: no paste-ready command is printed — this project\'s path does not survive double-quoting, so a rendered command could run somewhere other than the project it names.';
const WITHHELD_LINE = 'source-size: no paste-ready command is printed — this project\'s path carries a character that cannot appear in a rendered line, and escaping it would change the path the shell receives.';
// The withheld fallback is the reader's ONLY remaining instruction, so it has to be the instruction
// for what they were actually doing. Sending an adoption to the regenerator would leave them with a
// record and no gate — half an adoption, handed over as the way out — so the lane is per MODE.
const WITHHELD_LANE = 'Run the regenerator yourself with the working directory set to this project (source-size-check.mjs --write-baseline, plus --reason "<text>" for any raise), or record each size by hand below.';
const WITHHELD_ADOPT_LANE = `Run source-size-check.mjs --adopt --reason "${INITIAL_ADOPTION_REASON}" yourself, with the working directory set to this project — it mints the record and declares the gate in one step.`;

// → { command, withheld }: exactly one of the two is non-null. ONE renderer for every mode this tool
// prints, so a withhold can never apply to some of its own commands and not others.
const rendered = (cwd, mode, reason) => {
  const paths = [SOURCE_SIZE_TOOL_PATH, cwd];
  if (paths.some(isLineUnsafe)) return { command: null, withheld: WITHHELD_LINE };
  if (paths.some(dqUnsafePath)) return { command: null, withheld: WITHHELD_SHELL };
  return { command: `node "${SOURCE_SIZE_TOOL_PATH}" ${mode} --cwd "${cwd}"${reason === undefined ? '' : ` --reason "${reason}"`}`, withheld: null };
};
const regenerator = (cwd, reason, layout = false) => rendered(cwd, layout ? '--write-baseline --layout' : '--write-baseline', reason);

const SPLIT_QUALITY_FOCUS = 'source-size: REVIEW FOCUS — a recorded size went DOWN or disappeared: check that this is real decomposition and not the same coupling spread across more files (paste this line into the review dispatch focus).';

// Every refusal THIS module renders closes with the canonical WHY. The two thrown classes do not
// carry it — the exit-1 scope refusals (an unverifiable in-scope source file, a non-UTF-8 path, an
// unmerged index, an empty declared scope) and the exit-2 config, usage and enumeration errors: both
// are about a tree the practice could not judge at all, where a sentence about module size explains
// nothing.
const WHY_LINE = `source-size: WHY — ${SOURCE_SIZE_WHY}`;
const refusal = (lines) => [...lines, WHY_LINE];

// The standing summary (D-17 U4) — one line, from the CONFIG alone, on a MINTED config only: an
// absent one records nothing to summarize.
const practiceLine = (config) => {
  const facts = practiceFacts(config);
  return `source-size: practice — caps ${facts.maxLines} lines · ${facts.maxLineBytes} bytes per line over ${facts.roots} declared root(s) · ${facts.recordedFiles} file(s) carry a recorded size (debt, not permission) · aggregate ${facts.aggregateLines} line(s): growth past a record takes a reasoned bump, and a record above the tree or gone warns until the regeneration lowers or removes it.`;
};

export const absentRefusalLines = (cwd) => refusal([
  `source-size: REFUSED — ${namedConfig(cwd)} is absent, so the scope of this practice is undeclared.`,
  'Scope is DECLARED, never guessed: the kit ships no default file-type list, because a fixed one would silently exempt every unlisted language.',
  'Create it with this content, replacing every placeholder value:',
  authoringTemplate(),
]);

// Both not-yet-MINTED states route to the same lane — the regenerator writes the machine half — so
// they differ only in what they say happened: AUTHORED is the state a human creates, INCOMPLETE is a
// machine half no regenerator produces, which means the file was hand-edited into it.
export const unmintedRefusalLines = (cwd, { state, missing }) => {
  const { command, withheld } = regenerator(cwd, INITIAL_ADOPTION_REASON);
  return refusal([
    state === 'incomplete'
      ? `source-size: REFUSED — ${namedConfig(cwd)} is INCOMPLETE: it carries a machine half no regenerator produces (missing ${missing.map((key) => `"${key}"`).join(', ')}), so the ratchet holds only part of this tree.`
      : `source-size: REFUSED — ${namedConfig(cwd)} is AUTHORED but not yet MINTED (it records no size yet), so there is nothing for the ratchet to hold.`,
    'Mint it — the regenerator records what this tree already carries; recording a value for the first time is a raise, so it takes a reason:',
    command === null ? `${withheld} Run source-size-check.mjs --write-baseline --reason "${INITIAL_ADOPTION_REASON}" with the working directory set to this project.` : `  ${command}`,
  ]);
};

// Every finding names a path or a root the PROJECT chose, and each one crosses the line-safety
// boundary ONCE — in lineSafeFinding, before any branch sees it. Nine branches each remembering to
// escape would be nine chances to forget, and the tenth branch nobody has written yet would start
// out forgetting; here a branch cannot render an unsafe value even if it tries. The PASTEABLE
// suggestion goes through the boundary's JSON consumer instead — same set, different serialization,
// because those are bytes a human copies back into the config.
const lineSafeFinding = (finding) => ({
  ...finding,
  ...(finding.rel === undefined ? {} : { rel: escapeForLine(finding.rel) }),
  ...(finding.root === undefined ? {} : { root: escapeForLine(finding.root) }),
  ...(finding.dir === undefined ? {} : { dir: escapeForLine(finding.dir) }),
});

const BAND = (f) => `over the limit ${f.allowed} but within its band (up to ${f.ceiling})`;

// A stop: the regeneration would raise.
const FINDING_LINE = Object.freeze({
  'over-default': (f) => `${f.rel}: ${f.dimension} ${f.actual} exceeds the declared default ${f.allowed} beyond its band (up to ${f.ceiling})`,
  grew: (f) => `${f.rel}: ${f.dimension} ${f.actual} exceeds its recorded baseline ${f.recorded} — recorded debt is not permission to grow`,
  'aggregate-grew': (f) => `${f.root}: aggregate lines ${f.actual} exceeds the recorded budget ${f.recorded} — splitting a file buys no aggregate headroom`,
  'aggregate-unrecorded': (f) => `${f.root}: declared root carries NO recorded aggregate budget (${f.actual} lines measured) — the record must mirror the declared roots exactly`,
  'root-unrecorded': (f) => `${f.root}: judged root carries NO recorded files count (${f.actual} files measured) — the layout record must mirror the judged roots exactly`,
  'root-grew': (f) => `${f.root}: files ${f.actual} exceeds its recorded ${f.recorded} beyond its band (up to ${f.ceiling})`,
  'dir-over': (f) => `${f.dir}: ${f.dimension} ${f.actual} exceeds the limit ${f.allowed} beyond its band (up to ${f.ceiling})`,
  'dir-grew': (f) => `${f.dir}: ${f.dimension} ${f.actual} exceeds its recorded ${f.recorded} — recorded debt is not permission to grow`,
});

// A warning: printed on every run, exit 0, until the value or its record comes back within its limit.
const WARNING_LINE = Object.freeze({
  'within-band': (f) => `${f.rel}: ${f.dimension} ${f.actual} is ${BAND(f)} — no record is kept; past ${f.ceiling} it stops`,
  stale: (f) => `${f.rel}: ${f.dimension} ${f.actual} is under the recorded ${f.recorded} — the regeneration lowers it`,
  'record-obsolete': (f) => `${f.rel}: ${f.dimension} ${f.actual} is within its band (up to ${f.ceiling}), so its record is obsolete — the regeneration removes it`,
  'entry-gone': (f) => `${f.rel}: recorded in "baseline" but no longer in scope — split, renamed or deleted; the regeneration removes it`,
  'aggregate-stale': (f) => `${f.root}: aggregate lines ${f.actual} is under the recorded budget ${f.recorded} — the regeneration lowers it`,
  'aggregate-root-gone': (f) => `${f.root}: recorded in "aggregate" but no longer a declared root — the regeneration removes it`,
  'root-band': (f) => `${f.root}: files ${f.actual} is over its recorded ${f.recorded} but within its band (up to ${f.ceiling}) — past ${f.ceiling} it stops`,
  'root-stale': (f) => `${f.root}: files ${f.actual} is under the recorded ${f.recorded} — the regeneration lowers it`,
  'root-gone': (f) => `${f.root}: recorded in "layout"."roots" but no longer a judged root — the regeneration removes it`,
  'dir-band': (f) => `${f.dir}: ${f.dimension} ${f.actual} is ${BAND(f)} — past ${f.ceiling} it stops`,
  'dir-stale': (f) => `${f.dir}: ${f.dimension} ${f.actual} is under the recorded ${f.recorded} — the regeneration lowers it`,
  'dir-obsolete': (f) => (f.actual > f.ceiling ? `${f.dir}: its depth record ${f.recorded} no longer sits on the shallowest directory beyond the depth band — the regeneration removes it` : `${f.dir}: ${f.dimension} ${f.actual} is within its band (up to ${f.ceiling}), so its record is obsolete — the regeneration removes it`),
  'dir-gone': (f) => `${f.dir}: recorded in "layout"."directories" but no directory the run judges — the regeneration removes it`,
});

export const warningLines = (findings) =>
  findings.map((finding) => `${SOURCE_SIZE_WARNING_PREFIX}${WARNING_LINE[finding.kind](lineSafeFinding(finding))}`);

// The suggested entry is the WHOLE projected record, not the dimensions that happen to have changed:
// an entry printed from the findings alone would drop a recorded dimension that stayed put, and
// pasting it would fail the very next check. The projection already carries exactly the dimensions
// beyond their band and nothing else.
const suggestedEntryLines = (verdict) => {
  const rels = [...new Set(verdict.findings.filter((f) => f.kind === 'over-default' || f.kind === 'grew').map((f) => f.rel))];
  return rels.map((rel) => {
    const parts = Object.entries(verdict.projected.get(rel)).map(([dimension, value]) => `"${dimension}": ${value}`);
    return `  ${jsonForLine(rel)}: { ${[...parts, `"reason": "${GROWTH_REASON_PLACEHOLDER}"`].join(', ')} }`;
  });
};

// A stop is a raise, so its regeneration always takes the reason.
const servableStep = (cwd, verdict) => {
  const entries = suggestedEntryLines(verdict);
  const { command, withheld } = regenerator(cwd, GROWTH_REASON_PLACEHOLDER);
  const byHand = entries.length === 0 ? [] : ['Or record each size by hand under "baseline" — the validator accepts exactly these bytes:', ...entries];
  if (command === null) return [withheld, WITHHELD_LANE, ...entries];
  return [
    'This regeneration RAISES a recorded value, so the reason is REQUIRED — it is recorded in the entry it raises, and it is what the commit message and the CHANGELOG restate:',
    `  ${command}`,
    ...byHand,
  ];
};

// A lowered or removed record warns with the paste-ready regeneration, which needs no reason.
const tightenLine = (cwd) => {
  const { command, withheld } = regenerator(cwd);
  return `${SOURCE_SIZE_WARNING_PREFIX}a record above is lower or gone, so regenerating lowers or removes it with no reason: ${command ?? `${withheld} ${WITHHELD_LANE}`}`;
};

// The order every check prints: its notes, its warnings, then the green line or its stops.
export const checkReportLines = ({ cwd, config, verdict, absent = false }) => {
  const lines = verdict.scope.emptyRoots.map(
    (rel) => `source-size: NOTE — the declared root "${escapeForLine(rel)}" matches no tracked file with a declared extension`);
  const stops = stopsOf(verdict.findings);
  const warnings = warningsOf(verdict.findings);
  lines.push(...warningLines(warnings));
  const lowered = hasLoweredRecord(warnings);
  if (stops.length === 0) {
    if (lowered) lines.push(tightenLine(cwd), SPLIT_QUALITY_FOCUS);
    lines.push(warnings.length === 0
      ? `source-size: PASS — ${verdict.scope.files.length} in-scope file(s) within the declared caps`
      : `source-size: PASS with ${warnings.length} warning(s) — ${verdict.scope.files.length} in-scope file(s) judged and nothing beyond a band or a record; each warning above repeats on every run until it is settled`);
    return absent ? lines : [...lines, practiceLine(config)];
  }
  lines.push(`source-size: FAIL — ${stops.length} finding(s) ${absent ? `under the kit's values (${namedConfig(cwd)} is absent)` : `against ${namedConfig(cwd)}`}:`);
  for (const finding of stops) lines.push(`  ${FINDING_LINE[finding.kind](lineSafeFinding(finding))}`);
  lines.push(...servableStep(cwd, verdict));
  if (lowered) lines.push(SPLIT_QUALITY_FOCUS);
  return refusal(lines);
};

// The delta is the DURABLE RECORD on a deployment whose docs/ai is git-hidden: it is what the commit
// message carries and what the release CHANGELOG restates. It is printed WHOLE — a refusal that
// showed only the raises would drop the tightens and removals riding the same regeneration from the
// record it promises, so the raises are MARKED instead of filtered.
export const deltaLines = (deltas) => deltas.map(
  ({ target, dimension, from, to }) =>
    `  ${escapeForLine(target)}: ${dimension} ${from ?? 'none'} → ${to ?? 'none'}${isRaise({ from, to }) ? ' (raise)' : ''}`);

// A run that starts the layout record says so in the command it prints, or pasting it would not.
export const reasonRequiredLines = (cwd, deltas, { layout = false } = {}) => {
  const { command, withheld } = regenerator(cwd, GROWTH_REASON_PLACEHOLDER, layout);
  const raises = deltas.filter(isRaise).length;
  return refusal([
    `source-size: REFUSED — this regeneration RAISES ${raises} recorded value(s), and a raise takes a reason (it lands verbatim in the entry it raises, in the commit message and in the CHANGELOG). The whole old→new it would write:`,
    ...deltaLines(deltas),
    command === null ? `${withheld} ${WITHHELD_LANE}` : `  ${command}`,
  ]);
};

// ── schema 1 and --override ───────────────────────────────────────────────────────────────────────

// The check no longer judges schema 1: it names the one move, which the writer makes in its one write.
export const schema1StopLines = (cwd) => {
  const { command, withheld } = regenerator(cwd);
  return refusal([
    `source-size: STOPPED — ${namedConfig(cwd)} is schema 1, which the check no longer judges; --write-baseline moves it to schema 2 in its one write (a raise riding it still takes --reason): ${command ?? `${withheld} Run source-size-check.mjs --write-baseline with the working directory set to this project.`}`,
  ]);
};

// Claims only what holds of every written file.
export const schema1MovedLines = (cwd) => [
  `source-size: ${namedConfig(cwd)} moved from schema 1 to schema 2 in this write.`,
];

// The record must hold before an override is written, so its reason never lands on drift it did not
// cause: the lead line says so, and the reason-required refusal names that drift's own lane.
export const overrideOutgrownLines = (cwd, deltas) => [
  `source-size: --override REFUSED — the record in ${namedConfig(cwd)} no longer holds for this tree before this change, so that drift takes --write-baseline --reason first; nothing was written.`,
  ...reasonRequiredLines(cwd, deltas),
];

// Names the id and the reason, never a value or tolerance: the limit lines state what is judged.
export const overrideWrittenLines = ({ cwd, id, removed, reason }) => [
  removed
    ? `source-size: ${id} follows the kit's numbers in ${namedConfig(cwd)} — reason: ${escapeForLine(reason)}`
    : `source-size: override of ${id} written in ${namedConfig(cwd)} — reason: ${escapeForLine(reason)}`,
];

export const overrideUnchangedLines = (cwd, id) => [
  `source-size: ${id} — ${namedConfig(cwd)} already holds this, so nothing was written`,
];

// ── --adopt (D-16) ────────────────────────────────────────────────────────────────────────────────
// The verb touches TWO files, so it reports the two halves separately, ALWAYS. A failure in the
// second must never read as a failure of the first: a reader told only "adopt failed" would re-run a
// mint that already succeeded, or hand-write a record that is already on disk. Every line below
// therefore names what WAS done before what was not.

// ABSENT config: authoring the scope is the EXPECTED first step of adoption, not a failure — the
// template and the WHY are the ones the --override refusal prints, never a second wording.
export const adoptAbsentRefusalLines = (cwd) => {
  const { command, withheld } = rendered(cwd, '--adopt', INITIAL_ADOPTION_REASON);
  return refusal([
    `source-size: --adopt REFUSED — ${namedConfig(cwd)} is absent, so this practice has no declared scope yet.`,
    'Reaching it here is EXPECTED, not a failure: adoption needs a declared scope, and the kit ships no default file-type list, because a fixed one would silently exempt every unlisted language.',
    'Create it with this content, replacing every placeholder value:',
    authoringTemplate(),
    'Then re-run this same verb — it mints the record and declares the gate in one step:',
    command === null ? `${withheld} ${WITHHELD_ADOPT_LANE}` : `  ${command}`,
  ]);
};

// Byte-identity cannot tell a recognition from a regeneration that rewrote the same bytes, and the
// two differ exactly when the tree has moved — so the run SAYS which one it did.
export const recordRecognizedLines = (cwd) => [
  `source-size: the record in ${namedConfig(cwd)} already holds for this tree — recognized, not regenerated (adoption never rewrites a minted record).`,
];

// The record the tree outgrew. The checker's own refusal has already printed the numbers and the
// reasoned lane; this line adds the ONE thing that refusal cannot know — that a gate was on its way
// in and did not land, so nothing was half-armed.
export const recordNoLongerHoldsLines = (rel) => [
  `source-size: --adopt STOPPED before declaring — the ${escapeForLine(rel)} gate was NOT declared, because the recorded sizes above no longer hold and the gate would refuse on every run.`,
  'Settle the record with its own reason first (the command above), then re-run --adopt: the settled record is recognized and only the gate is declared.',
];

export const gateAlreadyDeclaredLines = (rel) => [
  `source-size: the ${escapeForLine(rel)} gate is already declared — nothing to declare; --adopt converged.`,
];

export const gateDeclaredLines = (rel, id) => [
  `source-size: gate "${escapeForLine(id)}" declared in ${escapeForLine(rel)} — the practice now runs with the matrix.`,
];

// The PARTIAL outcome, and the reason it is not simply an error: the record IS minted and the tree
// IS judgeable — only the declaration step was refused, and a re-run converges from here without
// re-doing the mint.
export const gateRefusedLines = (rel, message) => refusal([
  `source-size: --adopt INCOMPLETE — the record was minted, the gate was NOT declared in ${escapeForLine(rel)}.`,
  `  ${escapeForLine(message)}`,
  'Fix what the line above names and re-run the same verb: the minted record is recognized, so the re-run only declares the gate.',
]);

// `changed` is decided by comparing the serialized bytes with the file's own — never by the delta
// count alone: completing a half-written machine record changes the file while raising nothing, and
// reporting that as "unchanged" would hide a write that happened.
export const writtenLines = ({ cwd, deltas, reason, changed }) => {
  if (!changed) return [`source-size: baseline unchanged — ${namedConfig(cwd)} already records this tree`];
  if (deltas.length === 0) return [`source-size: baseline rewritten — no recorded value changed; ${namedConfig(cwd)} was completed or re-serialized`];
  return [
    `source-size: baseline regenerated — ${deltas.length} change(s) in ${namedConfig(cwd)}:`,
    ...deltaLines(deltas),
    ...(reason === undefined ? [] : [`reason: ${reason}`]),
  ];
};

// ── --help ────────────────────────────────────────────────────────────────────────────────────────

export const HELP = `source-size-check — the declared source-size practice (agent-workflow family).

Usage:
  node source-size-check.mjs --check [--cwd <project-root>]
  node source-size-check.mjs --write-baseline [--layout] [--reason "<text>"] [--cwd <project-root>]
  node source-size-check.mjs --adopt [--reason "<text>"] [--cwd <project-root>]
  node source-size-check.mjs --override <id> [--value <n>] [--tolerance <p>] --reason "<text>" [--cwd <project-root>]
  node source-size-check.mjs --override <id> --kit-default --reason "<text>" [--cwd <project-root>]

Judges every in-scope file against ${SOURCE_SIZE_CONFIG_REL} (schema ${SOURCE_SIZE_SCHEMA}): git-tracked files
under a declared root carrying a declared extension, minus the excluded path-segment prefixes. An
absent "roots" is the one root ".", every tracked path; a config declaring no extension judges no
file, and every check says so. With the config absent the check judges layout alone under the
kit's values. Symlinks and submodule gitlinks are skipped by kind; an unmerged index, a non-UTF-8
in-scope path, an unverifiable in-scope file and an empty declared scope are refusals.

Limits: the kit's own five, kept in its code, each with a tolerance; the config holds only a
project's reasoned overrides under "limits". A value at or under its limit is clean, above it within
the band ceil(value x tolerance / 100) a WARNING printed on every run (exit 0), and beyond the band a
stop unless a record holds it. Every --check, --write-baseline and --override run that resolves the
config and ends in no usage, config, enumeration or scope error states all five limits with value,
tolerance and source, then what it does not judge, then its warnings, then its stops.

Counting: lines, and the longest line in BYTES. A terminator never counts (the CR of a CRLF
included); a last line with no final newline still counts; an empty file is 0 lines. Layout: the
entries of each directory, its depth below its root, and the files of each root — every tracked
entry under a declared root, plus the spec store docs/ai/specs walked from disk.

A recorded entry is DEBT: a finding stops exactly when the regeneration would raise it, and a record
above the tree or gone warns until the regeneration lowers or removes it. Each declared root carries
the same exact ratchet over its summed lines.

--write-baseline regenerates the machine keys (baseline, aggregate, and layout where it is judged)
from the tree; on an absent config it writes a schema-2 one. --layout starts the layout record on a
present config that has none. The authored keys keep their values and their order; the file is
canonically serialized. A regeneration that RAISES any recorded value needs --reason; the string is
recorded in the entry it raised. A pure tighten needs none. A schema-1 config is moved to schema 2 in
the same write; --check stops on one until it is.

--adopt is the ONE-line adoption: it mints the record and declares the source-size gate (and NOTHING
else) in docs/ai/gates.json. It is idempotent on an already-adopted project. With the config absent
it refuses with the exact file to author. A refused declaration exits nonzero and reports both
halves: what was minted and what was not declared.

--override writes one override of a kit limit (lines-per-file, bytes-per-line, entries-per-directory,
depth: --value and/or --tolerance; files-per-root: --tolerance only), or with --kit-default removes
it; an option left out keeps the limit's current value or tolerance, and --reason is mandatory. It
runs only once regenerating the record under the current limits would raise nothing, and
regenerates the record in the same write.

Exit codes: 0 green, warnings included; 1 a stop or a refusal; 2 usage, config or enumeration error.`;
