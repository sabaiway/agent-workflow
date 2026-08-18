// advisor-matrix.mjs — the advisor-matrix STRUCTURE check (delegation Plan 3, Phase 1), as a leaf.
//
// A doc-parity BINDING proves a token is somewhere in a file. Correspondence is a different claim,
// and it is the one this table needs: the dispatch mode doc's routing matrix must carry one row per
// registry row, in registry order, with every CELL equal. A reorder, a duplicate, a dropped row, a
// mis-bound vehicle and a drifted availability or returns cell all leave every token present — so a
// token check passes every one of them, which is exactly why this exists beside the bindings rather
// than as more of them.
//
// Its own module rather than more lines in doc-parity.mjs: the lint's identity is "a closed registry
// of value bindings plus the runner over them", and a table parser with its own refusal vocabulary is
// a second thing. Split, each is a file you can hold whole — and the parser gets its own test file.
//
// Read-only: never writes, never commits, spawns nothing. Node built-ins plus the advisor registry
// only. No side effects on import; no CLI (it is reached through doc-parity).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADVISOR_ROWS, ADVISOR_MATRIX_HEADER, ADVISOR_MATRIX_COLUMNS, renderAdvisorMatrix } from './dispatch-advisor.mjs';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const ADVISOR_MATRIX_DOC = 'references/modes/dispatch.md';

// The table is found through an ANCHORED surface, not by "the first header line anywhere". Header
// search alone is maskable in a way even an exactly-one rule does not close: a faithful copy of the
// table plus a canonical one whose HEADER drifted leaves exactly one matching header — the decoy's —
// and the check then reads the decoy and passes. The markers make the checked surface a property of
// the DOC, so a copy outside them can neither stand in for the table nor hide its drift, and a
// drifted header INSIDE them leaves the surface with zero headers and fails closed.
export const ADVISOR_MATRIX_BEGIN = '<!-- advisor-matrix:begin -->';
export const ADVISOR_MATRIX_END = '<!-- advisor-matrix:end -->';

export const readKitDoc = (rel) => readFileSync(resolve(KIT_ROOT, rel), 'utf8');

// Both line endings are ordinary here. Splitting on '\n' alone leaves a trailing '\r' on every line
// of a CRLF-authored doc, and the marker match survives it (it trims) while the exact header match
// does not — so the check would fail a CORRECT document while naming a drifted header. One split,
// before anything compares.
const splitLines = (text) => String(text).split(/\r?\n/);

const linesMatching = (lines, marker) => lines.flatMap((line, i) => (line.trim() === marker ? [i] : []));

// Only leading and trailing BLANK lines are dropped. Trimming the joined block with String.trim()
// would also eat significant edge whitespace INSIDE the first and last lines, which is drift the
// comparison is supposed to see.
const trimBlankEdges = (lines) => {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end);
};

// parseAdvisorMatrix(text) → { ok: true, lines, rows } | { ok: false, reason }. `lines` is the whole
// anchored block; `rows` are its class rows, parsed for the DIAGNOSIS only — the verdict is the
// whole-block comparison in checkMatrixStructure, so a deleted alignment rule, a rewritten harness
// lane and an extra row are all caught, none of which a class-row walk would ever see.
export const parseAdvisorMatrix = (text) => {
  const lines = splitLines(text);
  const begins = linesMatching(lines, ADVISOR_MATRIX_BEGIN);
  const ends = linesMatching(lines, ADVISOR_MATRIX_END);
  if (begins.length !== 1 || ends.length !== 1) {
    return { ok: false, reason: `the anchored matrix surface is not unique — found ${begins.length} "${ADVISOR_MATRIX_BEGIN}" and ${ends.length} "${ADVISOR_MATRIX_END}" (exactly one of each is required)` };
  }
  if (ends[0] < begins[0]) {
    return { ok: false, reason: 'the matrix end marker precedes its begin marker — the anchored surface is inverted' };
  }
  const surface = trimBlankEdges(lines.slice(begins[0] + 1, ends[0]));
  const headers = surface.filter((line) => line === ADVISOR_MATRIX_HEADER);
  if (headers.length !== 1) {
    return { ok: false, reason: `the anchored matrix surface carries ${headers.length} header line(s) equal to "${ADVISOR_MATRIX_HEADER}" — exactly one is required` };
  }
  const rows = [];
  for (const line of surface.slice(surface.indexOf(ADVISOR_MATRIX_HEADER) + 1)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    // Arity refuses OUTRIGHT rather than skipping the row: a row whose cell count disagrees with the
    // header's is malformed whatever it says, and skipping it would report the drift as a MISSING
    // class row — a true verdict reached through a misleading sentence.
    if (cells.length !== ADVISOR_MATRIX_COLUMNS.length) {
      return { ok: false, reason: `a matrix row carries ${cells.length} cell(s), the table has ${ADVISOR_MATRIX_COLUMNS.length} columns: ${line.trim()}` };
    }
    const classCell = /^`(.+)`$/.exec(cells[0]);
    // A row whose first cell is not a backticked class joins no CLASS comparison — the harness lane,
    // or an interloper. Neither escapes: the whole-block equality below sees every line.
    if (classCell === null) continue;
    rows.push(Object.fromEntries(ADVISOR_MATRIX_COLUMNS.map(({ key }, i) => [key, i === 0 ? classCell[1] : cells[i]])));
  }
  return { ok: true, lines: surface, rows };
};

const quoted = (classes) => classes.map((c) => `\`${c}\``).join(', ');

// The DIAGNOSIS over the class rows, and the ORDER of its questions is the point. A POSITIONAL walk
// reads a deleted middle row as a corrupted step-class cell in the row that slid up behind it —
// technically a difference at that index, and a useless pointer for whoever has to fix the doc. So
// membership is settled first (duplicated / missing / unregistered), then ORDER, and only over rows
// that agree on both does a cell comparison run — where the first differing CELL is named, because
// "row 3 disagrees" leaves the reader to diff four columns by eye.
const rowDrift = (actual, expected) => {
  const actualClasses = actual.map((r) => r.stepClass);
  const expectedClasses = expected.map((r) => r.stepClass);

  const duplicated = actualClasses.filter((c, i) => actualClasses.indexOf(c) !== i);
  if (duplicated.length > 0) return `the advisor matrix names ${quoted([...new Set(duplicated)])} more than once — the registry has exactly one row per step class`;

  const missing = expectedClasses.filter((c) => !actualClasses.includes(c));
  if (missing.length > 0) return `the advisor matrix is missing ${missing.length} registry row(s): ${quoted(missing)}`;

  const unregistered = actualClasses.filter((c) => !expectedClasses.includes(c));
  if (unregistered.length > 0) return `the advisor matrix names ${unregistered.length} row(s) the registry does not: ${quoted(unregistered)}`;

  const outOfOrder = actualClasses.findIndex((c, i) => c !== expectedClasses[i]);
  if (outOfOrder !== -1) return `the advisor matrix is out of registry order — row ${outOfOrder + 1} is \`${actualClasses[outOfOrder]}\`, the registry has \`${expectedClasses[outOfOrder]}\``;

  for (const [i, row] of actual.entries()) {
    const e = expected[i];
    const differing = ADVISOR_MATRIX_COLUMNS.find(({ key }) => row[key] !== e[key]);
    if (differing !== undefined) {
      return `matrix row ${i + 1} (\`${row.stepClass}\`): the ${differing.label} cell reads "${row[differing.key]}", the registry has "${e[differing.key]}"`;
    }
  }
  return null;
};

// blockDrift(actual, expected) → null when the two blocks are IDENTICAL, else the first line that
// disagrees. It is the verdict and the fallback diagnosis in one: "the blocks are equal" is exactly
// "no line disagrees", so there is no second comparison to keep in step with this one — and the
// null return is the path every green run takes, not an unreachable defensive branch.
const blockDrift = (actual, expected) => {
  for (let i = 0; i < Math.max(actual.length, expected.length); i += 1) {
    if (actual[i] === expected[i]) continue;
    if (actual[i] === undefined) return `the anchored matrix is missing line ${i + 1}, which the canonical table renders as ${JSON.stringify(expected[i])}`;
    if (expected[i] === undefined) return `the anchored matrix carries an extra line ${i + 1}: ${JSON.stringify(actual[i])}`;
    return `matrix line ${i + 1} reads ${JSON.stringify(actual[i])}, the canonical table renders ${JSON.stringify(expected[i])}`;
  }
  return null;
};

// checkMatrixStructure(readText) → the same shape a doc-parity binding result carries, so the report,
// the --check line and the --json payload all render it through their existing paths. The VERDICT is
// whole-block equality against the canonical render: every way the doc's table can stop being the
// registry's table is one comparison, and the enumeration of those ways never has to be maintained.
export const checkMatrixStructure = (readText = readKitDoc) => {
  const rel = ADVISOR_MATRIX_DOC;
  const expected = ADVISOR_ROWS.map(({ stepClass, vehicle, availabilityNote, returns }) => ({ stepClass, vehicle, availabilityNote, returns }));
  let text;
  try {
    text = readText(rel);
  } catch (err) {
    return { constant: 'advisor-matrix-structure', files: [{ rel, ok: false, reason: `unreadable (${(err && err.code) || (err && err.message) || 'read failed'})` }], ok: false };
  }
  const parsed = parseAdvisorMatrix(text);
  if (parsed.ok === false) {
    return { constant: 'advisor-matrix-structure', files: [{ rel, ok: false, reason: parsed.reason }], ok: false };
  }
  // The VERDICT is the block comparison; the row walk only refines the MESSAGE when it can point at a
  // class row. A block difference the row walk cannot explain (the alignment rule, the harness lane,
  // an interloping row, whitespace) keeps the line-level pointer.
  const drift = blockDrift(parsed.lines, splitLines(renderAdvisorMatrix()));
  const reason = drift === null ? null : (rowDrift(parsed.rows, expected) ?? drift);
  return { constant: 'advisor-matrix-structure', files: [{ rel, ok: reason === null, reason }], ok: reason === null };
};
