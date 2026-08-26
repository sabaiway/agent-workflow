#!/usr/bin/env node
// The backlog queue as a CLASSIFIED corpus, not a prose pile.
//
// `docs/plans/queue.md` is the one long-lived surface in this family with no type, cap, rotation or
// exit event: rows accumulate, a closed row stays listed because its 26 lines of measurements have
// nowhere else to live, and a heading can say one thing while its body says another. The file's own
// header already asked for the discipline in prose ("a DONE entry is <=5 lines") and it did not hold.
// This module is the half prose cannot do — it says, per row and with the literal evidence, whether
// the row is still WORK.
//
// Four classes, and the boundaries between them are deliberately conservative, because the consumer
// of a `terminal` verdict is a DELETION:
//
//   live       no status marker decides otherwise — the default, and what a queue should hold.
//   terminal   the row is DEAD — done, closed, superseded, moot, declined: a marker in the TITLE, or
//              a marker OPENING a bold status line in the body (`**CLOSED 2026-07-20 …**`). The body
//              decides when the title is silent — the real shape of a row that was closed in place.
//   parked     the row is FROZEN, not dead: `PARKED` / `STOPPED` carry a stated resume condition, so
//              deleting one loses work that is only waiting. Reported, never deleted, never a refusal.
//   record     the row is not work at all: a TALLY counter or a SEQUENCING note.
//   ambiguous  the row contradicts itself (a terminal AND a live marker in the title, or a bold
//              terminal body under an explicitly QUEUED title). REPORTED, never auto-deleted.
//
// A terminal WORD in ordinary prose is NOT a status: rows routinely cite a sibling that was CLOSED or
// explain why something was CUT, and reading that as the row's own state would delete live work. Only
// the title and a bold status line are status positions.
//
// Markdown is read through the family's ONE block model (references/scripts/markdown-blocks.mjs) and
// the ONE bullet scan the other queue reader uses (fold-scope.mjs) — fences, CRLF, indented headings
// and the backtick-info-string rule are THEIR problem, never a second hand-rolled grammar here. A
// document either of them refuses is a loud refusal, never a silent empty read.
//
// Pure string functions plus a thin CLI. Read-only: it reads the file it is pointed at and writes
// nothing. Dependency-free, Node >= 22. No side effects on import.


import { tokenizeMarkdown, fail } from '../references/scripts/markdown-blocks.mjs';
import { bulletBlocks } from './fold-scope.mjs';
import { CARRY_WORK, CLASSES, DEFAULTS, UNREAD_ITEM, classifyRow, titleOf } from './queue-audit-rows.mjs';

// The row grammar is re-exported so one import names the whole reader: the CLI, the tests and any
// consumer ask this module, and the split into a rules half stays an implementation detail.
export { CLASSES, DEFAULTS, TERMINAL_MARKERS, FROZEN_MARKERS, LIVE_MARKERS, RECORD_PREFIXES, classifyRow, leadMarkers } from './queue-audit-rows.mjs';

// The `[from, to)` body-line window a `--section` names: it opens after that heading and closes at
// the next heading of the SAME level or higher, so a level-3 subheading stays inside. An absent
// section is a named refusal — auditing the whole file when the caller asked for one section would
// report rows the caller never meant to judge, and a deletion would follow.
// `frontLines` is not decoration: every line number this module reports is a FILE line, frontmatter
// included (the row manifest already adds it), so a refusal that named body-relative lines would send
// a reader to the wrong place in the very file it is refusing.
// ATX allows an optional CLOSING run of `#`, so `## Pending ##` and `## Pending` are the SAME
// heading. Comparing raw text made them two: the audit took one, and every row under the other left
// the domain silently — a section full of dead rows reported as zero rows and exit 0.
const canonicalHeading = (text) =>
  String(text ?? '')
    .replace(/\r/g, '')
    .replace(/\s+#+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

const sectionWindow = (headings, lines, section, frontLines = 0) => {
  if (!section) return { from: 0, to: lines.length };
  const wanted = canonicalHeading(section);
  const matches = headings.filter((heading) => canonicalHeading(heading.text) === wanted);
  // A usage error, not a document refusal: what is wrong is the ARGUMENT, and the CLI contract
  // promises 2 for that. AMBIGUITY refuses on the same footing as absence: taking the first of two
  // same-named headings would leave every row under the second one outside the audit — invisible to
  // the caps, absent from the report a deletion is driven by, and silently so.
  if (matches.length === 0) throw fail(2, `no section heading "${wanted}" in the queue — the audit refuses to guess its domain.`);
  if (matches.length > 1) {
    throw fail(2, `${matches.length} section headings read "${wanted}" (lines ${matches.map((h) => frontLines + h.index + 1).join(', ')}) — the audit refuses to pick one and leave the rest unjudged.`);
  }
  const [open] = matches;
  const next = headings.find((heading) => heading.index > open.index && heading.level <= open.level);
  return { from: open.index + 1, to: next ? next.index : lines.length };
};

// auditQueue(text, { section, label }) -> { rows, counts }. Each row carries its 1-based FILE line
// (frontmatter included), the title as written, its class and the literal evidence for that class.
export const auditQueue = (text, { section = null, label = 'the queue' } = {}) => {
  const { lines, headings, fencedLines, frontLines } = tokenizeMarkdown(String(text ?? ''), label);
  const { from, to } = sectionWindow(headings, lines, section, frontLines);
  // A fence CONTINUES a queue row rather than ending it, and the cap judges the row's PHYSICAL span.
  // Both halves are the same defect: a row carrying a code block reported one line and hid whatever
  // followed the fence — its length from the cap, and a closure from the classifier.
  // A list item this grammar cannot read is a REFUSAL, never a silence. `*` and `+` open a list in
  // every Markdown dialect and a bare `-` is an empty item; none of them is a row here, and dropping
  // them made a section of dead work report "0 rows" and exit 0 — a gate answering about a domain it
  // never looked at. The queue writes `-` rows; anything else is corrected by hand, not guessed at.
  for (let index = from; index < to; index += 1) {
    if (fencedLines.has(index) || !UNREAD_ITEM.test(lines[index])) continue;
    throw fail(2, `line ${frontLines + index + 1} opens a list item this audit does not read ("${lines[index].trim().slice(0, 40)}") — a queue row is a "- " bullet, and judging around this one would report a domain that was never looked at.`);
  }
  const rows = bulletBlocks(lines, fencedLines, from, to, { fenceContinues: true }).map((block) => {
    const { klass, evidence } = classifyRow(block.lines, block.gaps);
    return {
      line: frontLines + block.start + 1,
      lines: block.span,
      title: titleOf(block.lines, block.gaps).text,
      klass,
      evidence,
    };
  });
  const counts = Object.fromEntries(CLASSES.map((klass) => [klass, rows.filter((row) => row.klass === klass).length]));
  return { rows, counts, total: rows.length };
};

// checkQueue(text, options) -> { ok, problems, notes }. A problem is a REFUSAL and every one of them
// names a location: the family's bar is locations, never counts. An ambiguous row is a NOTE — it is
// exactly the case a human must settle, and failing on it would make the cap unpassable by anyone
// who did not already know the answer.
export const checkQueue = (text, options = {}) => {
  const { maxRows = DEFAULTS.maxRows, maxRowLines = DEFAULTS.maxRowLines, label = 'the queue' } = options;
  const { rows, counts, total } = auditQueue(text, { section: options.section ?? null, label });
  const problems = [];
  const notes = [];

  for (const row of rows) {
    if (row.klass === 'terminal' || row.klass === 'record') {
      problems.push(
        `${label}:${row.line}: a ${row.klass} row is still listed (${row.evidence}) — its story belongs to the ` +
          `ADR or the changelog, and the row leaves the queue in the same commit: ${row.title.slice(0, 80)}`,
      );
    }
    if (row.klass === 'ambiguous') {
      notes.push(`${label}:${row.line}: ambiguous (${row.evidence}) — settle it by hand: ${row.title.slice(0, 80)}`);
    }
    if (row.klass === 'parked') {
      notes.push(`${label}:${row.line}: parked (${row.evidence}) — frozen, not dead: ${row.title.slice(0, 80)}`);
    }
    if (CARRY_WORK.has(row.klass) && row.lines > maxRowLines) {
      problems.push(
        `${label}:${row.line}: the row is ${row.lines} lines, over the ${maxRowLines}-line cap — a row names the ` +
          `work; the measurements belong to a record or an ADR: ${row.title.slice(0, 80)}`,
      );
    }
  }

  // Both caps count EVERY row that still carries work, frozen and ambiguous included. Counting only
  // `live` would let the queue grow without limit through the Frozen bucket — moving a row there, or
  // leaving it self-contradicting, would buy room the cap is there to deny.
  const working = rows.filter((row) => CARRY_WORK.has(row.klass)).length;
  if (working > maxRows) {
    problems.push(
      `${label}: ${working} rows carry work, over the ${maxRows}-row cap — a backlog nobody can read is a dump. ` +
        'Close, delete or fold rows before filing another.',
    );
  }

  return { ok: problems.length === 0, problems, notes, counts, total };
};

// One tab-separated line per row: line, class, row-length, title. Deterministic and stable, so it can
// be diffed between runs and used as the manifest a deletion is driven by.
export const formatReport = (audit, { label = 'the queue' } = {}) => {
  const head = [
    `# queue-audit — ${label}`,
    `# ${audit.total} rows: ${CLASSES.map((klass) => `${audit.counts[klass]} ${klass}`).join(' · ')}`,
    '# line\tclass\tlines\ttitle\tevidence',
  ];
  const body = audit.rows.map((row) => [row.line, row.klass, row.lines, row.title, row.evidence].join('\t'));
  return [...head, ...body].join('\n');
};
