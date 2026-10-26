// The Memory Map row of each theme in a deployed AGENTS.md: a pure text leaf that reads and writes
// nothing; inject-methodology.mjs reconcile calls it and stays the file's one writer.
// Contract: docs/ai/specs/kit/project-rules/memory-map-row.md.

import { THEMES, themePaths } from './themes.mjs';

// The row texts a release shipped, append-only: a release that changes a row's text first appends
// the outgoing one here.
export const MEMORY_MAP_PRIOR_ROWS = Object.freeze([]);

// The route the reconcile's row note names when it wrote a row with other text.
export const ROW_ROUTE = 'a row of your own goes on a line of its own, its first cell a path of your own';

const ANCHOR_PATH = 'docs/ai/agent_rules.md';
const opening = (path) => `| [\`${path}\`](./${path}) |`;
const rowOf = (theme) => {
  const { effective } = themePaths(theme.name);
  return `${opening(effective)} ${theme.readWhen} | Only through \`/agent-workflow-kit rules\` |`;
};

// The lines of a text, each keeping its own ending, so joining them gives the text back byte for byte.
const splitLines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const bodyOf = (line) => line.replace(/\r?\n$/, '');
const endingOf = (line) => line.slice(bodyOf(line).length);
// A table line that does not close its last cell goes on over the next line.
const isWhole = (line) => bodyOf(line).trimEnd().endsWith('|');
// One whole row: at least four | that no backslash escapes, the last of them closing the line.
const isOneRow = (line) => {
  const body = bodyOf(line).trimEnd();
  return (body.match(/(?<!\\)\|/g) ?? []).length >= 4 && /(?<!\\)\|$/.test(body);
};

// placeAfter(lines, i, row) → the lines with row on the line after i, taking line i's ending.
const placeAfter = (lines, i, row) => {
  const ending = endingOf(lines[i]);
  if (ending !== '') return lines.toSpliced(i + 1, 0, `${row}${ending}`);
  return lines.toSpliced(i, 1, `${lines[i]}\n`, row);
};

// reconcileMemoryMapRows(text, { maxLines, priors }) → { text, outcomes }: one outcome
// { theme, status, note } per registry theme in registry order, status inserted, kept, refreshed,
// written or skipped; a skipped theme changes no byte and its note names the reason.
export const reconcileMemoryMapRows = (text, { maxLines, priors = MEMORY_MAP_PRIOR_ROWS } = {}) => {
  let lines = splitLines(text);
  let last = -1;
  const outcomes = [];
  for (const theme of THEMES) {
    const row = rowOf(theme);
    const path = themePaths(theme.name).effective;
    const answer = (status, note = '') => outcomes.push({ theme: theme.name, status, note });
    const found = lines.flatMap((line, i) => (line.startsWith(opening(path)) ? [i] : []));
    if (found.length > 1) {
      answer('skipped', `the Memory Map has more than one ${path} row — none of them was changed`);
      continue;
    }
    if (found.length === 1) {
      const at = found[0];
      const body = bodyOf(lines[at]);
      if (!isOneRow(lines[at])) answer('skipped', `the ${path} row does not close its cells on one line — left as it stands`);
      else if (body === row) answer('kept');
      else {
        lines = lines.with(at, `${row}${endingOf(lines[at])}`);
        answer(priors.includes(body) ? 'refreshed' : 'written');
      }
      continue;
    }
    const anchor = last !== -1 ? last : lines.findIndex((line) => line.startsWith(opening(ANCHOR_PATH)));
    if (anchor === -1) answer('skipped', `the Memory Map has no ${ANCHOR_PATH} row to place it after`);
    else if (!isWhole(lines[anchor])) answer('skipped', `the Memory Map's ${ANCHOR_PATH} row spans more than one line`);
    else if (maxLines != null && lines.length + 1 > maxLines) {
      answer('skipped', `adding it would take the file past its ${maxLines}-line limit`);
    } else {
      lines = placeAfter(lines, anchor, row);
      last = anchor + 1;
      answer('inserted');
    }
  }
  return { text: lines.join(''), outcomes };
};
