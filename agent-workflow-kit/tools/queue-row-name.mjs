#!/usr/bin/env node
// The READABILITY judge of a backlog row: can the person who owns the queue read what the work is?
// The sibling question — is this row still WORK? — is queue-audit-rows.mjs, and the two never mix:
// this module classifies nothing and writes nothing. Governing contract:
// docs/ai/specs/kit/queue-row-name.md.
//
// Measured 2026-09-04 on this repo's own `## Pending / backlog`: 165 of 247 work-carrying rows
// failed this bar and 121 of those opened with the id itself, so every status answer named the work
// by machine ids the maintainer could not read. The fix is a rung, never a rule an agent remembers
// — the remembered rule is the discipline that already failed.
//
// Pure string functions. No IO, no argv, no side effects on import. Dependency-free, Node >= 22.

import { ROW_ID } from './feedback-record.mjs';

const IDENT = '[A-Za-z0-9_-]';
const PART = '[A-Z0-9]+';
const LETTERED = '(?=[A-Z0-9]*[A-Z])[A-Z0-9]+';

// AN ID IS A RUN THE ROW PRESENTS AS ONE — that is the whole rule, and it replaced "the first
// shouted kebab run anywhere", which was walked around from both sides at once: it cut a SENTENCE at
// its first shouted compound adjective (`… never a HAND-APPLY \`rm\` …` reported HAND-APPLY as the
// row's cross-reference key), and it matched NOTHING on the real ids this corpus writes, because one
// all-digit part killed the run — `UPGRADE-RUN-FEEDBACK-2026-08-18`, `FLOW-CHECK-64-HAS-NO-VALVE-…`
// and `AMEND-REACHES-FOR---NO-VERIFY` each handed the WHOLE title back as its "name", id included.
//
// TWO grammars, and the difference is who VOUCHES for the id:
//
//   MARKED   `id <ID>` — the row says so, so the id is exactly what a checked record may hand over:
//            feedback-record.mjs's ROW_ID, imported rather than restated. `FOO`, `TASK-123` and
//            `1-TASK` are ids here, and the kit's own row writer marks its ids for this reason.
//   UNMARKED a heuristic over a display title nobody validated, so it stays narrow: parts of
//            upper-case letters and digits joined by one or more hyphens (the corpus writes `---`),
//            the FIRST TWO parts each carrying a letter, the rest unconstrained. That is what keeps
//            `AD-133` a cross-reference inside a name rather than an id. A run SPANNING its whole
//            segment needs only its first part lettered — nothing precedes it that it could eat.
//
// And the POSITION is where a row PRESENTS an id: the head of a ` — `-separated segment, or before a
// colon with nothing but WHITESPACE AND PUNCTUATION ahead of it in that segment. Both guards are
// measured: an id read mid-sentence took a claim's own words (`Preserve id TASK-123 in output — id
// ROW-A` answered TASK-123 rather than the row's id), and a prefix that admitted digits cut
// `123 ROW-A: the claim remains readable` down to the name `123`. What survives is why
// `See also FIRST-TIME-CORRECTNESS: …` keeps its name while `[ ] ROW-A: the claim` still names `[ ]`.
const RUN = `${LETTERED}(?:-+${LETTERED})(?:-+${PART})*`;
const SPANNING = `${LETTERED}(?:-+${PART})+`;
const MARKED = `id(?![A-Za-z0-9_])\\s+(${ROW_ID})(?!${IDENT})`;
const SEGMENT_SPLIT = /\s+[—–]\s+/u;

// Each form says where the NAME is cut: at the segment's own start for a presented head, at the
// `id` word for a marked id mid-sentence, and at the RUN itself for the label form — a cut at the
// match start there would swallow the `[ ]` the checkbox row is named by.
const FORMS = [
  { re: new RegExp(`^(?:${MARKED}|(${SPANNING}))$`, 'du'), cut: () => 0 },
  { re: new RegExp(`^(?:${MARKED}|(${RUN})(?!${IDENT}))`, 'du'), cut: () => 0 },
  { re: new RegExp(`^[\\s\\p{P}\\p{S}]*?(?<!${IDENT})(${RUN})(?=:)`, 'du'), cut: (match) => match.indices[1][0] },
];

const CASED = /\p{Cased}/u;
const LOWERCASE = /\p{Lowercase}/u;
const LETTER = /\p{L}/u;
const HYPHENS = /^-+$/u;
const normalize = (value) => String(value).replace(/-/gu, ' ').replace(/\s+/gu, ' ').trim().toLowerCase();

// nameOf(title) -> { name, id }. The title handed in is the DISPLAY text queue-audit already
// renders — every word the row wrote, its backticks stripped — with its leading STATUS segments
// already removed by the parser that owns the status vocabulary. Never the judged text, whose
// elided quotations would leave a HOLE where a quoted word stood and report an absent name for a
// row that reads perfectly. The boundary is stated POSITIVELY, by the id: ` — ` is the STATUS
// grammar's segment separator, not a name boundary, so a name that carries one keeps it whole, and
// a title that puts its id outside the bold span is named by that span entire.
export const nameOf = (title) => {
  const display = String(title ?? '').trim();
  let at = 0;
  for (const text of display.split(SEGMENT_SPLIT)) {
    const start = display.indexOf(text, at);
    at = start + text.length;
    for (const form of FORMS) {
      const match = form.re.exec(text);
      if (!match) continue;
      const name = display.slice(0, start + form.cut(match)).trimEnd().replace(/(?:\s*[—–-]+)+$/u, '').trimEnd();
      return { name, id: match[1] ?? match[2] };
    }
  }
  return { name: display, id: null };
};

// ONE word list, and every clause below reads it. A hyphen-joined RUN is one word — `row-is-unreadable`
// is a slug, `fix---the---bug` is the same slug, and `2026-08-21` is one date rather than three
// numbers — while punctuation is no word at all, so the `[ ]` the kit's own row writer renders no
// longer supplies two of the three words the bar asks for. Word segmentation is the platform's
// (`Intl.Segmenter`, a JS built-in — this module stays dependency-free).
const WORDS = new Intl.Segmenter(undefined, { granularity: 'word' });
export const wordsOf = (text) => {
  const parts = [...WORDS.segment(String(text))];
  const words = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (!parts[index].isWordLike) continue;
    let back = index - 1;
    while (back >= 0 && HYPHENS.test(parts[back].segment)) back -= 1;
    if (back >= 0 && back < index - 1 && parts[back].isWordLike && words.length) {
      words[words.length - 1] += parts.slice(back + 1, index + 1).map((part) => part.segment).join('');
      continue;
    }
    words.push(parts[index].segment);
  }
  return words;
};

// A name is a SENTENCE, and that ONE invariant is the whole bar — never a table of shapes, because
// a table is walked around, and each earlier draft was: the slug written back in lower case walked
// around all four shapes the first draft enumerated; a dated parenthetical walked around a clause
// that asked the whole name for one lower-case letter anywhere; and "no cased character" as the
// signal for a caseless SCRIPT let a name of pure punctuation, digits or emoji (`[ ]`, `123`,
// `2026-09-04`) through as a sentence. So:
//
//   a name CARRIES A LETTER — asked of every name, and the one clause a caseless script also meets;
//   a name that carries CASE is three or more words, one of its first three CASED words carrying a
//   lower-case letter.
//
// Binding the two counting clauses to case is what makes the verdict DETERMINISTIC rather than a
// function of the host's word-segmentation data: a caseless writing system writes no spaces to
// count and has no case to shout with, so neither is asked of it. Reading the SHOUTED clause off the
// first three CASED words (not the first three words) is what lets a Japanese sentence carry an
// English acronym without being called shouted.
export const nameFindings = (name, id) => {
  const text = String(name ?? '').trim();
  if (text === '') return [{ cause: 'absent', message: 'The row has no name before its id.' }];
  const findings = [];
  const words = wordsOf(text);
  if (!words.some((word) => LETTER.test(word))) {
    findings.push({ cause: 'no-letter', message: 'The name carries no letter, so it names nothing.' });
  }
  if (CASED.test(text) && words.length < 3) {
    findings.push({ cause: 'too-few-words', message: 'The name is fewer than three words.' });
  }
  // The acronym exemption is for a MIXED-SCRIPT name — a caseless sentence carrying an English
  // acronym — so it is spent only where caseless letter words actually exist. Skipping the clause
  // on "fewer than three cased words" alone let `API 123 456` and `API GATE 2` through as sentences.
  const cased = words.filter((word) => CASED.test(word));
  const caseless = words.filter((word) => LETTER.test(word) && !CASED.test(word));
  const exempt = caseless.length > 0 && cased.length < 3;
  if (cased.length > 0 && !exempt && !cased.slice(0, 3).some((word) => LOWERCASE.test(word))) {
    findings.push({ cause: 'shouted', message: 'None of the name\'s leading cased words carries a lower-case letter.' });
  }
  if (id !== null && normalize(text) === normalize(id)) {
    findings.push({ cause: 'restates-the-id', message: 'The name only restates its id.' });
  }
  return findings;
};
