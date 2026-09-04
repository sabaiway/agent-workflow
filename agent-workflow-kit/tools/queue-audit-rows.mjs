#!/usr/bin/env node
// The STATUS GRAMMAR of a queue row: what one row says about its own state, and the literal evidence
// for saying it. The DOCUMENT pass — which rows exist, which section they live in, what the caps say
// — is queue-audit.mjs, and the argv/fs half is queue-audit-cli.mjs. Split at the seam the source-size
// practice asks for: a module you can hold whole is the unit of review.
//
// Five classes, and the boundaries between them are deliberately conservative, because the consumer
// of a `terminal` verdict is a DELETION:
//
//   live       no status marker decides otherwise — the default, and what a queue should hold.
//   terminal   the row is DEAD — done, closed, superseded, moot, declined: a marker in the TITLE, or
//              a marker OPENING a bold status line in the body (`**CLOSED 2026-07-20 …**`). The body
//              decides when the title is silent — the real shape of a row that was closed in place.
//   parked     the row is FROZEN, not dead: `PARKED` / `STOPPED` carry a stated resume condition, so
//              deleting one loses work that is only waiting. Reported, never deleted, never a refusal.
//   record     the row is not work at all: a TALLY counter or a SEQUENCING note.
//   ambiguous  the row declares two states, or names a status word outside a status position.
//              REPORTED, never auto-deleted.
//
// A terminal WORD in ordinary prose is NOT a status: rows routinely cite a sibling that was CLOSED or
// explain why something was CUT, and reading that as the row's own state would delete live work. Only
// the title and a bold status line are status positions.
//
// Pure string functions. No IO, no argv, no side effects on import. Dependency-free, Node >= 22.

import { nameOf } from './queue-row-name.mjs';

// The closed list the queue actually uses. `DONE` and `CLOSED` are the two fold-scope already knows
// (its CLOSED_MARKERS); the rest are the states this corpus grew on its own. The check mark is a
// marker in its own right because the file's DONE-entry convention leads with it.
export const TERMINAL_MARKERS = ['✅', 'DONE', 'CLOSED', 'RESOLVED', 'DECIDED', 'SUPERSEDED', 'MOOT', 'DECLINED'];

// FROZEN, not dead: each of these carries a stated condition under which the work resumes (measured:
// "costs nothing until one is adopted again", "do NOT open tranche 4", "do NOT schedule without
// recurring incidents"). They are classified apart precisely so a deletion pass cannot take them.
export const FROZEN_MARKERS = ['PARKED', 'STOPPED'];

// A title marker that declares the row still OPEN. Only these two: they are the ones the corpus
// writes deliberately, and a wider list would turn ordinary words into status.
export const LIVE_MARKERS = ['QUEUED', 'PENDING'];

// Not work: a counter and an ordering note. Read by POSITION like every other status — the head of
// the title, or the head of a ` — `-separated segment, and everywhere but the title head the marker
// owes a DATE adjacent to it, the form the counter is always written in.
export const RECORD_PREFIXES = ['TALLY', 'SEQUENCING'];

export const CLASSES = ['live', 'terminal', 'parked', 'record', 'ambiguous'];

// The classes that still carry work, and therefore still cost a reader attention: both caps judge
// exactly these.
export const CARRY_WORK = new Set(['live', 'parked', 'ambiguous']);

export const DEFAULTS = { maxRows: 60, maxRowLines: 12 };

// A row is judged on the text it DECLARES, never on the text it QUOTES, and this is the ONE place
// that distinction is made. Every quotation this grammar can recognise is removed before any marker
// is looked for, and each is replaced by a SPACE so the tokens around it never become neighbours:
//
//   inline code  `` `DONE 2026-01-01` is parser input `` names a literal. Stripping the backticks and
//                keeping the text turned a row ABOUT the parser into a closed row — a deletion.
//   indented     a body line indented past the row's own continuation (2 spaces here, plus Markdown's
//   code block   4) is a code block, so `      **DONE 2026-02-01:** sample` is sample output, not this
//                row's status.
//
// A fenced region is handled one level up, by the block scan, and reaches here as a `gaps` boundary.
// What remains is deliberately NOT exhaustive: this is a hand-written reader over a corpus, so the
// residue is stated in the contract rather than guessed at, and the classes it can still misread are
// reported (`ambiguous`), never deleted.
const INLINE_CODE = /`[^`\n]*`/g;
const CODE_INDENT = /^\s{6,}\S/;
const quoteFree = (line) => String(line ?? '').replace(/\r/g, '').replace(INLINE_CODE, ' ');
const judgeable = (line) => (CODE_INDENT.test(String(line ?? '')) ? '' : quoteFree(line));

// The TITLE is the row's first bold span — `- **… — queued 2026-08-26.** prose` — and it ENDS where
// that span closes, even when it wraps over several lines. Both halves matter: taking the whole first
// line would read a sibling named in the prose after the title (`Its sibling was CLOSED …`) as this
// row's own status, and taking only the first line would lose the marker of a title that wraps — the
// common shape here, since a named row puts its id and `queued <date>` on the second line. A row with
// no bold span falls back to its first line.
export const titleOf = (blockLines, gaps = new Set()) => {
  // A title never closes ACROSS a code block: the fenced lines a row absorbs are elided from its
  // lines, so without this bound an opener above a fence and a `:**` below it become adjacent and a
  // title assembles itself out of two halves the document never joined.
  const upTo = [...gaps].filter((at) => at >= 0).sort((a, b) => a - b)[0];
  const reach = upTo === undefined ? blockLines.length : upTo + 1;
  const span = (render) => {
    const first = render(String(blockLines[0] ?? ''));
    const joined = blockLines.slice(0, reach).map(render).join('\n');
    const open = first.indexOf('**');
    const close = open === -1 ? -1 : joined.indexOf('**', open + 2);
    return {
      raw: close === -1 ? first : joined.slice(open + 2, close),
      endLine: close === -1 ? 0 : joined.slice(0, close).split('\n').length - 1,
    };
  };
  const flatten = (raw) => raw.replace(/^\s*[-*]\s+/, '').replace(/[*_]/g, '').replace(/\s+/g, ' ').trim();
  // TWO renderings of one title, and the split is the point. `text` is what a HUMAN reads in the
  // manifest, so it keeps every word the row wrote — eliding quoted code there turned readable titles
  // into gaps ("codex and") in the very document a deletion is driven by. `judged` is what the
  // MARKERS are looked for in, with quotations removed, so a row that names a literal is never
  // mistaken for a row that declares a state.
  const display = span((line) => String(line ?? '').replace(/\r/g, ''));
  const judged = span(quoteFree);
  const text = flatten(display.raw).replace(/`/g, '');
  const { name, id } = nameOf(nameSource(text));
  return { text, name, id, judged: flatten(judged.raw), endLine: display.endLine };
};

// A word-boundary match that survives punctuation the corpus writes (`— CLOSED 2026-08-21 ·`), and
// that never fires inside a longer word (`UNDECIDED`, `PARKED-ish`). The HYPHEN is a boundary that
// does NOT count: every row id here is a kebab slug, so `IS-A-CLOSED-LIST` carries the word CLOSED as
// part of a NAME, and reading that as the row's own status would delete live work (measured — it was
// the only false positive in the 272-row corpus). The check mark is not a word character, so it is
// matched literally.
//
// CASE is asymmetric, and the asymmetry is measured, not stylistic. A real status here is SHOUTED
// (`QUEUED` · `DONE` · `CLOSED` · `PARKED`), while the same words in lower case are ordinary prose:
// matching terminal markers case-insensitively flipped EIGHT live rows to terminal in one pass —
// "(decided 2026-07-22)", "…is DEFERRED until resolved", "the class gets asked for … done" — every
// one a false positive, every one a deletion. Live markers are the opposite: the corpus writes
// `queued 2026-08-26` in lower case, so a case-sensitive live marker never fires and the
// contradiction arm that PROTECTS a row goes dead. So: terminal and frozen are case-sensitive, live
// is not. The cost of the split is a non-standard lower-case dead row staying `live` — visible, and
// far cheaper than deleting work.
// ONE identifier-aware boundary, used by every marker test here: a marker glued to any identifier
// character — letter, DIGIT, underscore or hyphen — belongs to a NAME, not to a status. Measured
// misses when it was letters-and-hyphen only: `DONE2-STATE-IS-UNREACHABLE` and
// `CLOSED_LOOP-DESIGN-IS-UNDOCUMENTED` are live rows named after the thing they fix.
// A TOP-LEVEL list item the row grammar does not take: a `*` or `+` bullet — with content or EMPTY,
// since an empty one still opens a list whose indented content the audit would then never judge — or
// a `-` with nothing after it. Indented items are nested content of a row and are read as its body.
export const UNREAD_ITEM = /^(?:[*+](?:\s+\S|\s*$)|-\s*$)/;

const IDENT = '[A-Za-z0-9_-]';
const wordMatches = (text, marker, { anyCase = false } = {}) =>
  Array.from(String(text).matchAll(new RegExp(`(?<!${IDENT})${marker}(?!${IDENT})`, anyCase ? 'giu' : 'gu')));
const carries = (text, marker, { anyCase = false } = {}) =>
  /^[A-Za-z]+$/.test(marker)
    ? wordMatches(text, marker, { anyCase }).length > 0
    : text.includes(marker);

const markersIn = (text, list, options) => list.filter((marker) => carries(text, marker, options));

// A BOLD status line: `**CLOSED 2026-07-20 (…):** the story`. Anchored at the start of the line
// (indent allowed) so a bold phrase mid-sentence is never a status, and requiring the marker to open
// the bold span so `**Fix (small canon change):**` cannot become one.
// A bold status may WRAP: the opener sits on one line and the `:**` on the next — two rows of the
// live corpus are written that way, and a per-line matcher called both of them live, which is a
// false GREEN from the gate that authorises deletions. So the span is read across continuation
// lines, bounded so a `**` that never closes cannot swallow the rest of the row.
const BOLD_OPEN = /^\s*\*\*\s*(.*)$/;
const BOLD_SPAN_LINES = 4;

// A span never reaches ACROSS a code block. The fenced lines a row absorbs are elided from its
// lines, so without the gap set an opener above a fence and a `:**` below it become adjacent and
// assemble into one claim that the document never made.
const boldSpanAt = (blockLines, index, gaps = new Set()) => {
  const first = BOLD_OPEN.exec(judgeable(blockLines[index]));
  if (!first) return null;
  let span = first[1];
  for (let step = 0; step < BOLD_SPAN_LINES; step += 1) {
    const close = span.indexOf('**');
    if (close !== -1) return span.slice(0, close).replace(/:\s*$/, '');
    const next = blockLines[index + step + 1];
    if (next === undefined || gaps.has(index + step)) return null;
    span += ` ${judgeable(next).trim()}`;
  }
  return null;
};
// The marker must OPEN the bold span, as a WHOLE token. A QUALIFIED closure closes a PART of the row,
// not the row: `**PART (2) IS CLOSED …**`, `**SECOND FACE CLOSED …**`, `**+ bare-lane DECIDED …**`,
// `**DISPOSITION DECIDED …**` all leave work behind, and five of the six body-decided rows in the live
// corpus were exactly that shape. The token boundary matters too — `**CLOSED-loop design:**` is a
// subheading about a loop, not a closure. A bare check mark with no word after it (`**✅ 2026-08-20:**`)
// IS a status: the corpus leads its done entries with it.
const LEAD_WORD = new RegExp(`^([A-Za-z]+)(?!${IDENT})`);
const DATE = /^\d{4}-\d{2}-\d{2}/;
// A real status carries its DATE, and that is measured, not stylistic: across the 272-row corpus the
// status forms are `DONE 2026-08-21 ·`, `CLOSED 2026-07-20 (…)`, `SUPERSEDED 2026-08-21 by the row
// above`, `PARKED 2026-08-21 by AD-105`, `RESOLVED 2026-08-25 —`; the same words in prose never do —
// `STOPPED. That is`, `PARKED rather than`, `RESOLVED; the npm-pack`, `SUPERSEDED by a`. Requiring
// the date is what keeps a row NAMED after the machinery it fixes (`CLOSED STATUS PARSER DROPS ROWS`,
// `**DONE criteria:**`) out of the deletion set. A marker without one is not ignored — it makes the
// row `ambiguous`, for a human.
// The date is ADJACENT to the marker. A 40-character window of arbitrary text between the two was
// measured wrong: `**DONE criteria due 2026-09-01:**` — a live row stating when its criteria are due
// — read as a closure, and this verdict authorises a DELETION. The only gap the corpus actually
// writes is a SECOND shouted status word introduced by `+`: `DONE + SHIPPED 2026-07-09`,
// `DONE + PUBLISHED 2026-08-25` (measured — those three rows and nothing else in 6900 lines). So the
// gap is exactly that, never prose: a `+` must introduce every extra word, which is what keeps
// `DONE criteria due <date>` and `DONE CRITERIA <date>` out of the deletion set.
const DATED_STATUS = /^(?:\s*\+\s*[A-Z][A-Z-]*)*\s*\d{4}-\d{2}-\d{2}/;

// The markers OPENING a span, as whole tokens. A leading check mark alone declares NOTHING: the
// corpus writes `**✅ ENTRY GATE OPEN:**` for a live gate, so the mark must be followed by a terminal
// word or by a date — the form its done entries actually use (`**✅ 2026-08-20 (AD-100):**`).
// `requireDate: false` answers the WEAKER question — does this span OPEN with a status word at all —
// which is what separates "no status here" from "a status word with no date beside it". The second
// is not silence: it is a row a human has to settle.
export const leadMarkers = (span, list = TERMINAL_MARKERS, { requireDate = true, anyCase = false } = {}) => {
  let rest = String(span).replace(/\r/g, '').trimStart();
  const tick = rest.startsWith('✅');
  if (tick) rest = rest.slice(1).trimStart();
  const word = LEAD_WORD.exec(rest);
  // The tick joins the answer only when the LIST being asked about carries it. Prepending it to a
  // frozen, live or RECORD answer named the wrong marker in the evidence a deletion is read from.
  const named = word ? list.filter((m) => anyCase ? m.toLowerCase() === word[1].toLowerCase() : m === word[1]) : [];
  const withTick = (found) => (tick && list.includes('✅') ? ['✅', ...found] : found);
  if (named.length && (!requireDate || DATED_STATUS.test(rest.slice(word[1].length)))) {
    return withTick(named);
  }
  // A BARE check mark declares nothing on its own — the corpus writes `**✅ ENTRY GATE OPEN …**` for
  // a LIVE gate — so it counts only in its DATED form, and the weaker question never takes it.
  // Measured: dropping that guard turned three live rows into ambiguous, this one among them.
  if (!named.length && tick && list.includes('✅') && requireDate && DATE.test(rest)) return ['✅'];
  return [];
};

// A STATUS sits at the head of the title or at the head of one of its segments — `✅ DONE 2026-…`,
// `A-ROW — ✅ CLOSED 2026-…`, `SUPERSEDED 2026-… by the row above`. A marker anywhere else is a
// MENTION: `THE CLOSED state drops live work` is a defect report about closed state, not a closed
// row, and deleting it would take live work. ONLY the documented separators split a segment — the
// spaced dash family the corpus writes its status after. A bare hyphen would cut every kebab id into
// pieces; a bracket or a colon would make `(CLOSED is an input)` and `note: DONE is a token` into
// status heads, which is a row ABOUT status words being deleted for containing them.
const SEGMENT_SPLIT = /\s+[—–]\s+/;
const statusMarkersIn = (title, list, options) => [
  ...new Set(
    String(title)
      .split(SEGMENT_SPLIT)
      .flatMap((segment) => leadMarkers(segment, list, options)),
  ),
];

// The NAME is what remains after the row's own STATUS declarations, and this is where the two
// grammars meet: the readability judge owns the sentence, this module owns the status vocabulary, so
// the drop happens HERE rather than by restating four marker lists in a second home. Every LEADING
// ` — `-segment that OPENS with a status word is removed before the name is cut — measured on the
// live corpus, `PARKED 2026-08-21 by AD-105 (…) — QUEUED 2026-08-20 — B — A-PLAN-REVIEW-…` was
// passing the readability bar with its own PARKED declaration as the row's "name", which is the
// exact class of unreadable row the bar exists for. The date is not required here: the question is
// only whether a human reading the head of that segment meets a status word instead of a name.
// Stated residual: the segments are judged on the DISPLAY text, so a QUOTED status word opening a
// segment drops it too — a stricter name, never a missed one.
// The CASE asymmetry is the classifier's own and it holds here too: terminal, frozen and record
// words are SHOUTED, live words are not. Reading all four case-insensitively deleted the name of a
// row that opens with an ordinary verb — `Tally the remaining broken gates — ROW-A` lost its whole
// name to a `TALLY` that was never there. And the remainder is returned as a SLICE of the display
// title, never re-joined from the split parts: re-joining rewrote every en dash the row wrote into
// an em dash, so the "name" stopped being the bytes a human is shown.
const SHOUTED_STATUS = [...TERMINAL_MARKERS, ...FROZEN_MARKERS, ...RECORD_PREFIXES];
const opensWithStatus = (segment) =>
  leadMarkers(segment, SHOUTED_STATUS, { requireDate: false }).length > 0
  // The DATED bare tick is a status the weaker question cannot see — that arm is guarded by
  // `requireDate` — and it was the one form of status this drop still left inside a name:
  // `✅ 2026-08-20 — PARKED 2026-08-21 by AD-105 — A-ROW` was named by its own status text and
  // passed the bar with no finding at all, which is the blocker this drop exists to close.
  || leadMarkers(segment, TERMINAL_MARKERS).length > 0
  || leadMarkers(segment, LIVE_MARKERS, { requireDate: false, anyCase: true }).length > 0;
const nameSource = (title) => {
  const text = String(title);
  let at = 0;
  for (const segment of text.split(SEGMENT_SPLIT)) {
    const start = text.indexOf(segment, at);
    if (!opensWithStatus(segment)) return text.slice(start);
    at = start + segment.length;
  }
  return '';
};

const datedMarkersIn = (title, list, options) => list.filter((marker) =>
  wordMatches(title, marker, options).some((match) => DATED_STATUS.test(String(title).slice(match.index + match[0].length))),
);

const boldStatusMarkers = (blockLines, from, { list = TERMINAL_MARKERS, gaps, ...options } = {}) => {
  for (let offset = from + 1; offset < blockLines.length; offset += 1) {
    const span = boldSpanAt(blockLines, offset, gaps);
    if (span === null) continue;
    const found = leadMarkers(span, list, options);
    if (found.length) return { markers: found, offset };
  }
  return null;
};

const evidenceOf = (parts) => parts.filter(Boolean).join(' + ');

// classifyRow(blockLines) -> { klass, evidence }. The order of the arms IS the rule: a
// contradiction is judged before the state it contradicts, and `live` is what survives when nothing
// else decided. A RECORD is a state like any other and is reduced with the rest: returning it early
// made `QUEUED 2026-09-04 — TALLY 2026-09-04 — A-ROW` a deletable `record` while the row said it was
// open, and hid a `DONE …` beside a `TALLY …` behind a single verdict.
export const classifyRow = (blockLines, gaps) => {
  const { judged: title, endLine } = titleOf(blockLines, gaps);
  // The prefix must be a whole token: `TALLYING-FAILURES-HAS-NO-RUNG` and `SEQUENCING-BUG-IN-THE-
  // DISPATCHER` are work, and a bare `startsWith` would have the checker demand their deletion.
  const records = String(title)
    .split(SEGMENT_SPLIT)
    .flatMap((segment, index) => leadMarkers(segment, RECORD_PREFIXES, { requireDate: index !== 0 })
      .map((prefix) => ({ prefix, index, tick: segment.trimStart().startsWith('✅') })));
  const [record] = records;

  // EVERY status of every class is gathered BEFORE anything is decided. Deciding as they were found
  // made two states unreachable: a frozen title returned before the contradiction arms could see a
  // live marker beside it, so `PARKED … — QUEUED …` read as simply parked, and the body was scanned
  // for terminal markers only, so a dated `**PARKED 2026-08-21 …**` closing a row in place was not a
  // state at all.
  const titleFrozen = statusMarkersIn(title, FROZEN_MARKERS);
  const titleTerminal = statusMarkersIn(title, TERMINAL_MARKERS);
  const bodyTerminalAt = boldStatusMarkers(blockLines, endLine, { gaps });
  // Narrowing the live reading to a status POSITION may never move a row INTO a deletable class.
  // The narrow reading is what lets `Rows still pending a rename — A-ROW — PARKED 2026-09-04` be
  // parked instead of ambiguous; applied to the same name beside a dated `DONE`, it deleted the
  // contradiction and handed the row to a purge. So wherever the row already declares a TERMINAL or
  // a RECORD state, the wide reading — a live word anywhere in the title, in any case — is added
  // back: there it can only ever ADD ambiguity, and this grammar errs toward keeping a row.
  const deletable = Boolean(titleTerminal.length || record || bodyTerminalAt);
  const titleLive = [...new Set([
    ...statusMarkersIn(title, LIVE_MARKERS, { anyCase: true, requireDate: false }),
    ...datedMarkersIn(title, LIVE_MARKERS, { anyCase: true }),
    ...(deletable ? markersIn(title, LIVE_MARKERS, { anyCase: true }) : []),
  ])];
  const bodyTerminal = bodyTerminalAt;
  const bodyFrozen = boldStatusMarkers(blockLines, endLine, { gaps, list: FROZEN_MARKERS });
  // The body declares LIVE too, and leaving it out of the table was the dangerous half: a row whose
  // body said `**QUEUED 2026-08-20:**` and then `**CLOSED 2026-01-01:**` was read as simply closed —
  // a contradiction handed to a deletion as a verdict. A live marker never needs its date here (the
  // corpus writes `queued` in lower case, and the arm that reads it PROTECTS the row).
  const bodyLive = boldStatusMarkers(blockLines, endLine, { gaps, list: LIVE_MARKERS, requireDate: false });
  // A marker the title carries somewhere OTHER than a status head. It cannot decide the row, and it
  // cannot be ignored either — a human settles it. The check mark STAYS in this path, and the
  // asymmetry with the body side is measured, not an oversight: in a TITLE the corpus writes
  // `✅ Plan 3 / 3 — …` as a done marker (ten such rows), so dropping it turned ten reported rows
  // silent; in a BOLD BODY span it writes `**✅ ENTRY GATE OPEN …**` for a gate that OPENED. Same
  // glyph, two positions, two meanings — and the position is what this module already reads.
  // A tick OPENING the record's own segment is consumed by that status exactly as a terminal status
  // consumes its own: without this, `A-ROW — ✅ TALLY 2026-09-04` took the mention arm and became
  // `ambiguous`, dropping the record refusal the row had always earned. It consumes THAT tick and no
  // other, counted rather than assumed: suppressing every tick in the title made
  // `✅ Plan 3 / 3 — a readable name — ✅ TALLY 2026-09-04` a DELETABLE record while one of its two
  // done markers had nothing to do with the counter. Counting the ticks EVERY record segment
  // consumes is what keeps `✅ TALLY 2026-09-04 — ✅ SEQUENCING 2026-09-04` the record it is.
  const ticks = (String(title).match(/✅/gu) ?? []).length;
  const consumed = records.filter((sighting) => sighting.tick).length;
  const mentioned = markersIn(title, [...TERMINAL_MARKERS, ...FROZEN_MARKERS]).filter(
    (marker) => !titleTerminal.includes(marker) && !titleFrozen.includes(marker)
      && !(marker === '✅' && consumed > 0 && ticks <= consumed),
  );
  if (!titleTerminal.length && !titleFrozen.length && mentioned.length) {
    return { klass: 'ambiguous', evidence: `title mentions ${mentioned.join(', ')} outside a status position` };
  }
  // A row that declares two states declares none: it is REPORTED, and a human settles it. The title
  // and the body are read into ONE table and reduced by CLASS, never by position — an earlier version
  // let the title's own state hide the body's, so a terminal title above a `**PARKED <date>:**` body
  // stayed terminal and kept authorising a deletion while the row declared two things. Two sightings
  // of the SAME class are one state (a title and a body that agree do not contradict).
  const sightings = [
    record && {
      klass: 'record',
      evidence: `${record.index === 0 ? 'title' : `title segment ${record.index + 1}`} opens with ${record.prefix}`,
    },
    titleTerminal.length && { klass: 'terminal', evidence: `title: ${titleTerminal.join(', ')}` },
    titleFrozen.length && { klass: 'parked', evidence: `title: ${titleFrozen.join(', ')}` },
    titleLive.length && { klass: 'live', evidence: `title: ${titleLive.join(', ')}` },
    bodyTerminal && { klass: 'terminal', evidence: `body +${bodyTerminal.offset}: ${bodyTerminal.markers.join(', ')}` },
    bodyFrozen && { klass: 'parked', evidence: `body +${bodyFrozen.offset}: ${bodyFrozen.markers.join(', ')}` },
    bodyLive && { klass: 'live', evidence: `body +${bodyLive.offset}: ${bodyLive.markers.join(', ')}` },
  ].filter(Boolean);
  const declared = [...new Set(sightings.map((s) => s.klass))];
  if (declared.length > 1) return { klass: 'ambiguous', evidence: evidenceOf(sightings.map((s) => s.evidence)) };
  if (declared.length === 1 && declared[0] !== 'live') {
    return { klass: declared[0], evidence: evidenceOf(sightings.map((s) => s.evidence)) };
  }

  // A bold body span that OPENS with a status word but carries no date beside it is the residue of
  // the date rule, and silence is the wrong answer for it: `**DONE criteria due 2026-09-01:**` used
  // to be read as a closure, and the fix must not turn it into "nothing to see". It is REPORTED as
  // ambiguous — visible to a human, never deletable by a machine. Measured: with the bare-check-mark
  // guard in place, zero rows in the live 314-row corpus and zero in the 62-row purge archive take
  // this arm, so it closes a door without moving a single existing verdict.
  const undated = boldStatusMarkers(blockLines, endLine, { gaps, requireDate: false })
    ?? boldStatusMarkers(blockLines, endLine, { gaps, list: FROZEN_MARKERS, requireDate: false });
  if (undated) {
    return {
      klass: 'ambiguous',
      evidence: `body +${undated.offset}: ${undated.markers.join(', ')} with no date beside it`,
    };
  }

  return { klass: 'live', evidence: 'no status marker' };
};
