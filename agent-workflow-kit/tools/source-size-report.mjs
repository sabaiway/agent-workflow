// source-size-report.mjs — the words a verdict is delivered in. Every refusal this practice prints
// must name the file, the actual value, the allowed value AND a step the reader can perform against
// THIS build — never a bare "too big" and never a command that does not exist yet.
//
// Two render contracts, honestly separated (D-3a):
//   • TIGHTEN — the tree shrank below what is recorded. Shrinking is progress, so the regenerator is
//     printed EXACTLY as it should be pasted; no reason is needed and none is asked for.
//   • GROWTH — the regeneration would RAISE a recorded value. The checker cannot invent the human's
//     reason, so the command is printed as a TEMPLATE carrying the placeholder, and the requirement
//     is stated rather than implied.
// The exception both share: on a project path that does not survive double-quoting, NO command is
// rendered (a rendered one could run somewhere else) — the parameters, the reason requirement and
// the manual lane are stated instead.
//
// The standing echo (D-17 U4) rides the same two renders: a PASS states the practice in one line, so
// the enforced path itself keeps the caps in front of the reader, and every refusal CLOSES with the
// canonical WHY sentence — a cap whose reason has to be looked up is a cap that reads as arbitrary.
//
// Dependency-free, Node >= 22. No writes, no side effects on import.

import { SOURCE_SIZE_WHY, configPathFor, escapeForLine, isLineUnsafe, jsonForLine } from './source-size-refusal.mjs';
import { INITIAL_ADOPTION_REASON, SOURCE_SIZE_DEFAULTS, SOURCE_SIZE_SCHEMA, practiceFacts } from './source-size-config.mjs';
import { SOURCE_SIZE_TOOL_PATH, dqUnsafePath } from './source-size-gate-cmd.mjs';
import { hasGrowth, hasLoweredRecord, isRaise } from './source-size-judge.mjs';

// The project directory is project-controlled too, so the path every refusal names enters its line
// escaped like any other such value. configPathFor itself stays literal — it also builds the real
// filesystem path the writer opens.
const namedConfig = (cwd) => escapeForLine(configPathFor(cwd));

export const GROWTH_REASON_PLACEHOLDER = '<why this size is accepted>';

// The authoring template (D-5): GENERIC, and INERT by construction — its roots/extensions carry
// placeholders the validator refuses, so it can never be pasted into an empty-green scope.
export const authoringTemplate = () => JSON.stringify({
  _README: 'Source-size practice: declared scope + thresholds + the recorded ratchet. Authored keys: schema, defaults, roots, exclude, extensions. Machine keys: baseline, aggregate — each recorded entry carries a reason, and a recorded size is debt, not permission. Strict JSON — unknown keys refused.',
  schema: SOURCE_SIZE_SCHEMA,
  defaults: { ...SOURCE_SIZE_DEFAULTS },
  roots: ['<a directory this practice covers>'],
  exclude: [],
  extensions: ['<.an-extension-this-practice-covers>'],
}, null, 2);

// A rendered command carries the RESOLVED tool path and an explicit quoted --cwd, so it means the
// same thing from any directory. It is WITHHELD on either of two grounds, and the render says WHICH
// one fired: a reader told their path "does not survive double-quoting" when it quotes perfectly
// goes off to fix the wrong thing. The grounds are made DISJOINT by testing line-safety FIRST — a
// newline satisfies both, and a path that cannot be printed at all is not a quoting question. The
// recovery lane is identical either way; only the diagnosis differs.
const WITHHELD_SHELL = 'source-size: no paste-ready command is printed — this project\'s path does not survive double-quoting, so a rendered command could run somewhere other than the project it names.';
const WITHHELD_LINE = 'source-size: no paste-ready command is printed — this project\'s path carries a character that cannot appear in a rendered line, and escaping it would change the path the shell receives.';
const WITHHELD_LANE = 'Run the regenerator yourself with the working directory set to this project (source-size-check.mjs --write-baseline, plus --reason "<text>" for any raise), or record each size by hand below.';

// → { command, withheld }: exactly one of the two is non-null.
const regenerator = (cwd, reason) => {
  const paths = [SOURCE_SIZE_TOOL_PATH, cwd];
  if (paths.some(isLineUnsafe)) return { command: null, withheld: WITHHELD_LINE };
  if (paths.some(dqUnsafePath)) return { command: null, withheld: WITHHELD_SHELL };
  return { command: `node "${SOURCE_SIZE_TOOL_PATH}" --write-baseline --cwd "${cwd}"${reason === undefined ? '' : ` --reason "${reason}"`}`, withheld: null };
};

const SPLIT_QUALITY_FOCUS = 'source-size: REVIEW FOCUS — a recorded size went DOWN or disappeared: check that this is real decomposition and not the same coupling spread across more files (paste this line into the review dispatch focus).';

// Every refusal THIS module renders closes with the canonical WHY. The two thrown classes do not
// carry it — the exit-1 scope refusals (an unverifiable in-scope source file, a non-UTF-8 path, an
// unmerged index, an empty declared scope) and the exit-2 config, usage and enumeration errors: both
// are about a tree the practice could not judge at all, where a sentence about module size explains
// nothing.
const WHY_LINE = `source-size: WHY — ${SOURCE_SIZE_WHY}`;
const refusal = (lines) => [...lines, WHY_LINE];

// The standing summary (D-17 U4) — one line, from the CONFIG alone. There is no headroom to report:
// the ratchet refuses actual > recorded and actual < recorded alike, so a recorded aggregate is EXACT
// by construction, and saying that is the honest form of "how much room is left". Reached only on a
// MINTED config (a check refuses every other state before it renders anything).
const practiceLine = (config) => {
  const facts = practiceFacts(config);
  return `source-size: practice — caps ${facts.maxLines} lines · ${facts.maxLineBytes} bytes per line over ${facts.roots} declared root(s) · ${facts.recordedFiles} file(s) carry a recorded size (debt, not permission) · aggregate ${facts.aggregateLines} line(s), EXACT: growth takes a reasoned bump, never free headroom.`;
};

export const absentRefusalLines = (cwd) => refusal([
  `source-size: REFUSED — ${namedConfig(cwd)} is absent, so the scope of this practice is undeclared.`,
  'Scope is DECLARED, never guessed: the kit ships no default root list and no default file-type list, because a fixed one would silently exempt every unlisted language. Authoring this file is the ONE manual step of the practice.',
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
});

const FINDING_LINE = Object.freeze({
  'over-default': (f) => `${f.rel}: ${f.dimension} ${f.actual} exceeds the declared default ${f.allowed}`,
  grew: (f) => `${f.rel}: ${f.dimension} ${f.actual} exceeds its recorded baseline ${f.recorded} — recorded debt is not permission to grow`,
  stale: (f) => `${f.rel}: ${f.dimension} ${f.actual} is under the recorded ${f.recorded} — the baseline is STALE, tighten it`,
  'record-obsolete': (f) => `${f.rel}: ${f.dimension} ${f.actual} no longer exceeds the declared default ${f.allowed} — the record must go`,
  'entry-gone': (f) => `${f.rel}: recorded in "baseline" but no longer in scope — split, renamed or deleted; the record must go`,
  'aggregate-grew': (f) => `${f.root}: aggregate lines ${f.actual} exceeds the recorded budget ${f.recorded} — splitting a file buys no aggregate headroom`,
  'aggregate-stale': (f) => `${f.root}: aggregate lines ${f.actual} is under the recorded budget ${f.recorded} — the budget is STALE, tighten it`,
  'aggregate-unrecorded': (f) => `${f.root}: declared root carries NO recorded aggregate budget (${f.actual} lines measured) — the record must mirror the declared roots exactly`,
  'aggregate-root-gone': (f) => `${f.root}: recorded in "aggregate" but no longer a declared root — the record must mirror the declared roots exactly`,
});

// The suggested entry is the WHOLE projected record, not the dimensions that happen to have changed:
// an entry printed from the findings alone would drop a recorded dimension that stayed put, and
// pasting it would fail the very next check. The projection already carries exactly the dimensions
// that violate the declared defaults and nothing else.
const suggestedEntryLines = (verdict) => {
  const rels = [...new Set(verdict.findings.filter((f) => f.kind === 'over-default' || f.kind === 'grew').map((f) => f.rel))];
  return rels.map((rel) => {
    const parts = Object.entries(verdict.projected.get(rel)).map(([dimension, value]) => `"${dimension}": ${value}`);
    return `  ${jsonForLine(rel)}: { ${[...parts, `"reason": "${GROWTH_REASON_PLACEHOLDER}"`].join(', ')} }`;
  });
};

const servableStep = (cwd, verdict) => {
  const growth = hasGrowth(verdict.findings);
  const entries = suggestedEntryLines(verdict);
  const { command, withheld } = regenerator(cwd, growth ? GROWTH_REASON_PLACEHOLDER : undefined);
  const byHand = entries.length === 0 ? [] : ['Or record each size by hand under "baseline" — the validator accepts exactly these bytes:', ...entries];
  if (command === null) return [withheld, WITHHELD_LANE, ...entries];
  return [
    growth
      ? 'This regeneration RAISES a recorded value, so the reason is REQUIRED — it is recorded in the entry it raises, and it is what the commit message and the CHANGELOG restate:'
      : 'Nothing here grows — regenerate the record (no reason needed; shrinking is progress):',
    `  ${command}`,
    ...byHand,
  ];
};

export const checkReportLines = ({ cwd, config, verdict }) => {
  const lines = verdict.scope.emptyRoots.map(
    (rel) => `source-size: NOTE — the declared root "${escapeForLine(rel)}" matches no tracked file with a declared extension`);
  if (verdict.findings.length === 0) {
    lines.push(`source-size: PASS — ${verdict.scope.files.length} in-scope file(s) within the declared caps`, practiceLine(config));
    return lines;
  }
  lines.push(`source-size: FAIL — ${verdict.findings.length} finding(s) against ${namedConfig(cwd)}:`);
  for (const finding of verdict.findings) lines.push(`  ${FINDING_LINE[finding.kind](lineSafeFinding(finding))}`);
  lines.push(...servableStep(cwd, verdict));
  if (hasLoweredRecord(verdict.findings)) lines.push(SPLIT_QUALITY_FOCUS);
  return refusal(lines);
};

// The delta is the DURABLE RECORD on a deployment whose docs/ai is git-hidden: it is what the commit
// message carries and what the release CHANGELOG restates. It is printed WHOLE — a refusal that
// showed only the raises would drop the tightens and removals riding the same regeneration from the
// record it promises, so the raises are MARKED instead of filtered.
export const deltaLines = (deltas) => deltas.map(
  ({ target, dimension, from, to }) =>
    `  ${escapeForLine(target)}: ${dimension} ${from ?? 'none'} → ${to ?? 'none'}${isRaise({ from, to }) ? ' (raise)' : ''}`);

export const reasonRequiredLines = (cwd, deltas) => {
  const { command, withheld } = regenerator(cwd, GROWTH_REASON_PLACEHOLDER);
  const raises = deltas.filter(isRaise).length;
  return refusal([
    `source-size: REFUSED — this regeneration RAISES ${raises} recorded value(s), and a raise takes a reason (it lands verbatim in the entry it raises, in the commit message and in the CHANGELOG). The whole old→new it would write:`,
    ...deltaLines(deltas),
    command === null ? `${withheld} ${WITHHELD_LANE}` : `  ${command}`,
  ]);
};

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
