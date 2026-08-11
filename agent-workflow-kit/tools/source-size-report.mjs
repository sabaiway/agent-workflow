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
// Dependency-free, Node >= 22. No writes, no side effects on import.

import { configPathFor } from './source-size-refusal.mjs';
import { INITIAL_ADOPTION_REASON, SOURCE_SIZE_DEFAULTS, SOURCE_SIZE_SCHEMA } from './source-size-config.mjs';
import { SOURCE_SIZE_TOOL_PATH, dqUnsafePath } from './source-size-gate-cmd.mjs';
import { hasGrowth, hasLoweredRecord, isRaise } from './source-size-judge.mjs';

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
// same thing from any directory. `null` = withheld: a path that does not survive double-quoting must
// never be rendered into a command, because the command the shell would run is not the one printed.
const regenerator = (cwd, reason) => {
  if (dqUnsafePath(SOURCE_SIZE_TOOL_PATH) || dqUnsafePath(cwd)) return null;
  return `node "${SOURCE_SIZE_TOOL_PATH}" --write-baseline --cwd "${cwd}"${reason === undefined ? '' : ` --reason "${reason}"`}`;
};

const WITHHELD = 'source-size: no paste-ready command is printed — this project\'s path does not survive double-quoting, so a rendered command could run somewhere other than the project it names.';
const WITHHELD_LANE = 'Run the regenerator yourself with the working directory set to this project (source-size-check.mjs --write-baseline, plus --reason "<text>" for any raise), or record each size by hand below.';

const SPLIT_QUALITY_FOCUS = 'source-size: REVIEW FOCUS — a recorded size went DOWN or disappeared: check that this is real decomposition and not the same coupling spread across more files (paste this line into the review dispatch focus).';

export const absentRefusalLines = (cwd) => [
  `source-size: REFUSED — ${configPathFor(cwd)} is absent, so the scope of this practice is undeclared.`,
  'Scope is DECLARED, never guessed: the kit ships no default root list and no default file-type list, because a fixed one would silently exempt every unlisted language. Authoring this file is the ONE manual step of the practice.',
  'Create it with this content, replacing every placeholder value:',
  authoringTemplate(),
];

// Both not-yet-MINTED states route to the same lane — the regenerator writes the machine half — so
// they differ only in what they say happened: AUTHORED is the state a human creates, INCOMPLETE is a
// machine half no regenerator produces, which means the file was hand-edited into it.
export const unmintedRefusalLines = (cwd, { state, missing }) => {
  const command = regenerator(cwd, INITIAL_ADOPTION_REASON);
  return [
    state === 'incomplete'
      ? `source-size: REFUSED — ${configPathFor(cwd)} is INCOMPLETE: it carries a machine half no regenerator produces (missing ${missing.map((key) => `"${key}"`).join(', ')}), so the ratchet holds only part of this tree.`
      : `source-size: REFUSED — ${configPathFor(cwd)} is AUTHORED but not yet MINTED (it records no size yet), so there is nothing for the ratchet to hold.`,
    'Mint it — the regenerator records what this tree already carries; recording a value for the first time is a raise, so it takes a reason:',
    command === null ? `${WITHHELD} Run source-size-check.mjs --write-baseline --reason "${INITIAL_ADOPTION_REASON}" with the working directory set to this project.` : `  ${command}`,
  ];
};

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
    return `  ${JSON.stringify(rel)}: { ${[...parts, `"reason": "${GROWTH_REASON_PLACEHOLDER}"`].join(', ')} }`;
  });
};

const servableStep = (cwd, verdict) => {
  const growth = hasGrowth(verdict.findings);
  const entries = suggestedEntryLines(verdict);
  const command = regenerator(cwd, growth ? GROWTH_REASON_PLACEHOLDER : undefined);
  const byHand = entries.length === 0 ? [] : ['Or record each size by hand under "baseline" — the validator accepts exactly these bytes:', ...entries];
  if (command === null) return [WITHHELD, WITHHELD_LANE, ...entries];
  return [
    growth
      ? 'This regeneration RAISES a recorded value, so the reason is REQUIRED — it is recorded in the entry it raises, and it is what the commit message and the CHANGELOG restate:'
      : 'Nothing here grows — regenerate the record (no reason needed; shrinking is progress):',
    `  ${command}`,
    ...byHand,
  ];
};

export const checkReportLines = ({ cwd, verdict }) => {
  const lines = verdict.scope.emptyRoots.map(
    (rel) => `source-size: NOTE — the declared root "${rel}" matches no tracked file with a declared extension`);
  if (verdict.findings.length === 0) {
    lines.push(`source-size: PASS — ${verdict.scope.files.length} in-scope file(s) within the declared caps`);
    return lines;
  }
  lines.push(`source-size: FAIL — ${verdict.findings.length} finding(s) against ${configPathFor(cwd)}:`);
  for (const finding of verdict.findings) lines.push(`  ${FINDING_LINE[finding.kind](finding)}`);
  lines.push(...servableStep(cwd, verdict));
  if (hasLoweredRecord(verdict.findings)) lines.push(SPLIT_QUALITY_FOCUS);
  return lines;
};

// The delta is the DURABLE RECORD on a deployment whose docs/ai is git-hidden: it is what the commit
// message carries and what the release CHANGELOG restates. It is printed WHOLE — a refusal that
// showed only the raises would drop the tightens and removals riding the same regeneration from the
// record it promises, so the raises are MARKED instead of filtered.
export const deltaLines = (deltas) => deltas.map(
  ({ target, dimension, from, to }) =>
    `  ${target}: ${dimension} ${from ?? 'none'} → ${to ?? 'none'}${isRaise({ from, to }) ? ' (raise)' : ''}`);

export const reasonRequiredLines = (cwd, deltas) => {
  const command = regenerator(cwd, GROWTH_REASON_PLACEHOLDER);
  const raises = deltas.filter(isRaise).length;
  return [
    `source-size: REFUSED — this regeneration RAISES ${raises} recorded value(s), and a raise takes a reason (it lands verbatim in the entry it raises, in the commit message and in the CHANGELOG). The whole old→new it would write:`,
    ...deltaLines(deltas),
    command === null ? `${WITHHELD} ${WITHHELD_LANE}` : `  ${command}`,
  ];
};

// `changed` is decided by comparing the serialized bytes with the file's own — never by the delta
// count alone: completing a half-written machine record changes the file while raising nothing, and
// reporting that as "unchanged" would hide a write that happened.
export const writtenLines = ({ cwd, deltas, reason, changed }) => {
  if (!changed) return [`source-size: baseline unchanged — ${configPathFor(cwd)} already records this tree`];
  if (deltas.length === 0) return [`source-size: baseline rewritten — no recorded value changed; ${configPathFor(cwd)} was completed or re-serialized`];
  return [
    `source-size: baseline regenerated — ${deltas.length} change(s) in ${configPathFor(cwd)}:`,
    ...deltaLines(deltas),
    ...(reason === undefined ? [] : [`reason: ${reason}`]),
  ];
};
