// The finding-scope rule as a checker — the half prose cannot do (the engine canon: procedures.md,
// plan-execution step 5). A finding NAMES the invariant its fix enforces BEFORE the edit; WHERE that
// invariant already lives decides the disposition, and this module REFUSES a claim whose reference
// does not resolve:
//
//   in-scope       the claim matches WITHIN ONE acceptance bullet of the plan -> fold here.
//   new-invariant  the claim matches NO acceptance bullet AND one OPEN queue row carries the claim in
//                  its invariant field and all five fields (invariant, origin as file:line, narrow
//                  fix, proof, residual exposure) with that exposure declared NOT live -> the narrow
//                  fix ships now, only the generalization defers.
//   blocking       no correct narrow fix exists -> the phase does not close; there is no queue arm.
//
// Markdown is read through the family's ONE block model (references/scripts/markdown-blocks.mjs, the
// module the archivers already read through): fenced regions, ATX headings at 0-3 columns of indent,
// CRLF and the backtick-info-string rule are ITS problem, not a second hand-rolled grammar here. A
// document it refuses is a loud refusal, never a silent empty read.
//
// ADVISORY in this slice: nothing records that it ran, so a skipped or late call is
// indistinguishable from a pre-edit declaration. A fingerprint-bound receipt a gate reads is next.
//
// Pure string functions - every input is text; the CLI half (fold-scope-cli.mjs) owns the fs.
// Dependency-free, Node >= 22.

import { tokenizeMarkdown } from '../references/scripts/markdown-blocks.mjs';
import { PLAN_HEADINGS, bulletBlocks } from './plan-shape.mjs';

export { bulletBlocks };

export const CLASSES = ['in-scope', 'new-invariant', 'blocking'];
export const ROW_FIELDS = ['invariant', 'origin', 'narrow fix', 'proof', 'residual exposure'];
export const ACCEPTANCE_HEADING = PLAN_HEADINGS[2];
// The canon says a deferral row carries "the origin `file:line`". Anchored at the start of the value
// and a POSITIVE line number, so "file.mjs:12junk" and "file.mjs:0" are not one; trailing context
// after the token is fine, because the canon asks the row to CARRY a file:line, not to carry nothing
// else.
const ORIGIN_SHAPE = /^\S+:[1-9]\d*(\s|$)/;
// A closed row is not a live deferral. Narrow on purpose: the row TITLE carrying one of these
// literals refuses fail-closed; the general per-project status grammar is queued, not guessed here.
const CLOSED_MARKERS = ['DONE', 'CLOSED'];
const ORIGIN_MISSING = 'origin (the canon requires a file:line)';

export const normalize = (s) => String(s ?? '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();
const contains = (haystack, needle) => normalize(haystack).toLowerCase().includes(needle);


// extractAcceptance(planText) -> the top-level bullets under `## Verification`, each collapsed to one
// line. Per the planning canon those bullets ARE the acceptance criteria and they are the WHOLE list.
// ONE heading recognizer decides both ends: the section opens on the block model's `## Verification`
// heading and closes at the next heading of level 1 or 2, so a level-3 subheading stays INSIDE (which
// is what "in this section" means) and a 4-space line, being an indented code block rather than a
// heading, neither opens nor closes it. A Verification with no bullets declares NO criteria.
export const extractAcceptance = (planText) => {
  const { lines, headings, fencedLines } = tokenizeMarkdown(String(planText ?? ''), 'the plan');
  const open = headings.find((heading) => heading.text.trim() === ACCEPTANCE_HEADING);
  if (!open) return [];
  const next = headings.find((heading) => heading.index > open.index && heading.level <= 2);
  return bulletBlocks(lines, fencedLines, open.index + 1, next ? next.index : lines.length)
    .map((block) => normalize(block.lines.join('\n').replace(/^-\s+/, '')))
    .filter(Boolean);
};

// ONE question per pattern: this one asks whether the line CARRIES a label, never whether the value
// behind it is any good. Requiring a non-empty value here made an empty repeat invisible, so a row
// could repeat a label and still be admitted; the value is judged downstream, where "" is missing.
const FIELD_LINE = new RegExp(`^\\s*(?:[-*]\\s+)?(${ROW_FIELDS.map((f) => f.replace(' ', '\\s+')).join('|')})\\s*:\\s*(.*)$`, 'i');

// The labelled fields of one row, folding CONTINUATION lines into the value they belong to (a wrapped
// invariant read to its first line only would refuse a legitimate deferral). A REPEATED label is
// recorded and REFUSED, never resolved by keeping the first value: a row saying "not live" and then
// "live" would otherwise be accepted as not-live, which is the contradiction this fails closed on.
const parseFields = (block) => {
  const values = {};
  let open = null;
  for (const line of block.split('\n')) {
    const match = line.match(FIELD_LINE);
    if (match) {
      open = match[1].toLowerCase().replace(/\s+/g, ' ');
      values[open] = [...(values[open] ?? []), match[2].trim()];
    } else if (open && /^\s+\S/.test(line) && !/^-\s+\S/.test(line.trim())) {
      values[open][values[open].length - 1] += ` ${line.trim()}`;
    } else {
      open = null;
    }
  }
  const fields = {};
  for (const label of ROW_FIELDS) fields[label] = values[label]?.[0] ?? null;
  return { fields, values, duplicates: ROW_FIELDS.filter((label) => (values[label] ?? []).length > 1) };
};

// The disposition a residual exposure declares. Exactly TWO forms declare the negative: "not live"
// and "not-live", each a standalone token on both sides — so "not--live", "not - live",
// "not-live-ish" and "maybe-not-live" declare nothing. EVERY not-live span is removed before the
// positive is looked for, malformed ones included: the `live` inside a botched negative is not a
// declaration of the positive, and reading it as one would route the author to blocking over a row
// that only needs re-wording. A standalone bare `live` then decides, and a row carrying both a
// declared negative and a real positive is a contradiction that fails closed as live.
const NEGATIVE_SPAN = /(?<![-\w])not[\s-]*live(?![-\w])/g;
const DECLARED_NEGATIVE = /(?<![-\w])not(?:\s+|-)live(?![-\w])/;
const LIVE_TOKEN = /(?<![-\w])live(?![-\w])/;
const exposureOf = (value) => {
  const text = String(value ?? '').toLowerCase();
  const declaredNegative = DECLARED_NEGATIVE.test(text);
  if (LIVE_TOKEN.test(text.replace(NEGATIVE_SPAN, ' '))) return 'live';
  return declaredNegative ? 'not-live' : null;
};

const topLevelRows = (queueText) => {
  const { lines, fencedLines } = tokenizeMarkdown(String(queueText ?? ''), 'the queue');
  return bulletBlocks(lines, fencedLines, 0, lines.length).map((block) => block.lines.join('\n'));
};

const EMPTY_ROW = () => ({ found: false, matches: 0, fields: {}, missing: [...ROW_FIELDS], duplicates: [], exposure: null, closed: null, claimInInvariant: false });

// findDebtRow(queueText, claim) -> the ONE queue row FOR this invariant, its fields and its
// disposition. Discovery prefers the row whose INVARIANT field carries the claim; the whole-block
// match is only the fallback, and it exists so a row that carries the claim but no invariant field is
// still FOUND and its missing field can be named. Zero and several matches are both "not found" with
// the count: a deferral names ONE row, and guessing which is the unresolved reference this refuses.
export const findDebtRow = (queueText, claim) => {
  const needle = normalize(claim).toLowerCase();
  if (!needle) return EMPTY_ROW();
  const rows = topLevelRows(queueText).map((block) => ({ block, ...parseFields(block.replace(/\r$/gm, '')) }));
  // EVERY recorded value of `invariant` is a candidate key, not just the first: a claim sitting in a
  // repeated label would otherwise be invisible here and resolve to some OTHER row.
  const owns = (r) => (r.values.invariant ?? []).some((v) => contains(v, needle));
  const byInvariant = rows.filter(owns);
  const hits = byInvariant.length ? byInvariant : rows.filter((r) => contains(r.block, needle));
  // A candidate that repeats a label cannot be reasoned about at all, so the refusal comes BEFORE the
  // row is resolved — ahead of the ambiguity count and ahead of every field judgement.
  const broken = [...new Set(hits.flatMap((r) => r.duplicates))];
  if (broken.length) return { ...EMPTY_ROW(), matches: hits.length, duplicates: broken };
  if (hits.length !== 1) return { ...EMPTY_ROW(), matches: hits.length };
  const { block, fields, duplicates } = hits[0];
  const missing = ROW_FIELDS.filter((label) => !fields[label]);
  if (fields.origin && !ORIGIN_SHAPE.test(fields.origin)) missing.push(ORIGIN_MISSING);
  return {
    found: true,
    matches: 1,
    block,
    fields,
    missing,
    duplicates,
    exposure: exposureOf(fields['residual exposure']),
    closed: CLOSED_MARKERS.find((marker) => block.split('\n')[0].includes(marker)) ?? null,
    claimInInvariant: owns(hits[0]),
  };
};

const verdict = (kind, code, exit, claim, lines) => ({
  verdict: kind,
  code,
  exit,
  lines: [`fold-scope: ${kind} ${code}${claim ? ` — "${claim}"` : ''}`, ...lines],
});
const accept = (code, claim, lines) => verdict('ACCEPT', code, 0, claim, lines);
const refuse = (code, claim, lines, exit = 1) => verdict('REFUSE', code, exit, claim, lines);

const FIVE_FIELDS = ROW_FIELDS.join(', ');

// A document read is the ONE place a throw is expected: the block model REFUSES an unclosed fence and
// an ambiguous leading `---` rather than guessing, and its message names the file and line.
const read = (fn) => {
  try {
    return { value: fn() };
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
};
const unreadable = (claim, message) => refuse('document-unreadable', claim, [
  `  ${message}`,
  '  a document that cannot be read as markdown is never guessed around — fix it, then re-run.',
], 2);

// decideFoldScope({ cls, claim, planText, queueText }) -> { verdict, code, exit, lines }.
// Exit 0 for every ACCEPT, 1 for every matrix REFUSE, 2 for a refusal about the ARGUMENTS themselves
// (an unknown or absent class, an absent claim, an unreadable document) - the CLI prints the lines
// and returns the code.
export const decideFoldScope = ({ cls, claim, planText, queueText } = {}) => {
  const claimText = normalize(claim);
  if (!CLASSES.includes(cls)) {
    return refuse('class-unknown', typeof cls === 'string' ? cls : '', [
      `  --class must be one of: ${CLASSES.join(', ')} — there is no default arm.`,
      '  name the invariant the fix would enforce, then say where it already lives.',
    ], 2);
  }
  if (!claimText) {
    return refuse('claim-absent', '', [
      '  --claim carries the invariant the fix would enforce, as a literal.',
      '  a finding with no named invariant has no scope to decide.',
    ], 2);
  }
  if (cls === 'blocking') {
    return accept('blocking', claimText, [
      '  no correct narrow fix exists, so the phase does not close.',
      '  there is no deferral arm here: fix it in this phase, or the phase stays open.',
    ]);
  }
  const criteria = read(() => extractAcceptance(planText));
  if (criteria.error) return unreadable(claimText, criteria.error);
  const acceptance = criteria.value;
  const needle = claimText.toLowerCase();
  const matched = acceptance.find((bullet) => contains(bullet, needle)) ?? null;
  if (cls === 'in-scope') {
    return matched
      ? accept('in-scope', claimText, [
          `  matched acceptance bullet: ${matched}`,
          '  fold here: the invariant is already required by this plan. Fold the finding as a red->green test and re-review.',
        ])
      : refuse('in-scope-unmatched', claimText, [
          `  no acceptance bullet of the plan carries this literal (${acceptance.length} bullet(s) read).`,
          '  the lane: ship the NARROW fix for the found site (red first, then green); the generalization defers only as',
          `  --class new-invariant, once a queue row carries ${FIVE_FIELDS}. With no correct narrow fix, --class blocking.`,
        ]);
  }
  if (matched) {
    return refuse('new-invariant-already-accepted', claimText, [
      `  the invariant IS an acceptance bullet: ${matched}`,
      '  route to the fold arm: --class in-scope. Already-required work is never a deferral.',
    ]);
  }
  const found = read(() => findDebtRow(queueText, claimText));
  if (found.error) return unreadable(claimText, found.error);
  const row = found.value;
  if (row.duplicates.length) {
    return refuse('new-invariant-row-duplicate-field', claimText, [
      `  a candidate queue row declares more than once: ${row.duplicates.join(', ')}.`,
      '  a repeated label is not resolved by keeping the first value — a row that says both "not live"',
      '  and "live" declares a contradiction, and a claim hidden in a repeat would resolve to another row.',
      '  Delete the duplicate so the row states ONE value per field.',
    ]);
  }
  if (row.matches > 1) {
    return refuse('new-invariant-row-ambiguous', claimText, [
      `  ${row.matches} queue rows carry this literal — a deferral names ONE row.`,
      '  narrow the claim to the invariant statement of the row you mean.',
    ]);
  }
  if (!row.found) {
    return refuse('new-invariant-row-absent', claimText, [
      '  no queue row carries this literal.',
      `  a deferral owes a row carrying all five fields: ${FIVE_FIELDS}, that exposure declared NOT live.`,
      '  if the exposure IS live, this is not a deferral at all — it is --class blocking.',
    ]);
  }
  if (row.closed) {
    return refuse('new-invariant-row-closed', claimText, [
      `  the queue row title carries "${row.closed}" — a closed row is not a live deferral.`,
      '  re-open that row, or write a new one for the invariant this finding names.',
    ]);
  }
  if (row.missing.length) {
    return refuse('new-invariant-row-incomplete', claimText, [
      `  the queue row is missing: ${row.missing.join(', ')}.`,
      '  a row short of a field is a note, not a deferral — write the field, then re-run.',
    ]);
  }
  if (!row.claimInInvariant) {
    return refuse('new-invariant-claim-not-invariant', claimText, [
      `  the row carries this literal, but NOT in its invariant field: ${row.fields.invariant}`,
      '  a deferral is keyed on the invariant the row states — quote that, or write the row this finding needs.',
    ]);
  }
  if (row.exposure === 'live') {
    return refuse('new-invariant-exposure-live', claimText, [
      `  the residual exposure is declared LIVE: ${row.fields['residual exposure']}`,
      '  a live defect in shipped behaviour is never deferred — route to --class blocking.',
    ]);
  }
  if (row.exposure === null) {
    return refuse('new-invariant-exposure-undeclared', claimText, [
      `  the residual exposure declares neither "live" nor "not live": ${row.fields['residual exposure']}`,
      '  silence is not a declaration — state the disposition in the row.',
    ]);
  }
  const accepted = accept('new-invariant', claimText, [
    `  the queue row carries all five fields and declares its residual exposure NOT live: ${row.fields.origin}`,
    '  the narrow fix ships in this phase; ONLY the generalization defers.',
  ]);
  const terminator = row.block.includes('\r\n') ? '\r\n' : '\n';
  const block = row.block.replace(/(?:\r?\n[ \t]*)+$/, terminator);
  accepted.row = { firstLine: block.split('\n')[0].replace(/\r$/, ''), block };
  return accepted;
};
