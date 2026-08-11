// source-size-refusal.mjs — how the source-size practice STOPS, and what every stop must name. The
// leaf every other half reads, so a refusal raised deep in the scope walk carries the same contract
// as one raised by the config reader:
//   • exit 2 — the INPUTS are unusable (usage, a malformed config, a failed enumeration); the
//     practice could not judge anything, and no step it could name would change that.
//   • exit 1 — the practice REFUSED: a violation, a stale record, an unverifiable in-scope source
//     file, or a declared state the reader must move on (an absent or unminted config). Every one of
//     these carries a step the reader can perform.
//   • every refusal names the config of the project it ACTUALLY judged, absolute: under a foreign or
//     relative --cwd a repo-relative name points at whatever directory the reader happens to be in.
//   • the WHY rides the RENDERED refusals only — the ones the report composes (absent / unminted /
//     check-FAIL / reason-required). The thrown exit-1 scope refusals (an unverifiable in-scope
//     source file, a non-UTF-8 path, an unmerged index, an empty declared scope) and the exit-2
//     config, usage and enumeration errors do NOT carry it: a sentence about module size explains
//     nothing about a tree that could not be judged at all. That same sentence is what every other
//     surface speaking for the practice quotes (D-17), so it lives here, in the leaf every half
//     already reads: a practice explained in three slightly different sentences is three practices.
//
// Dependency-free, Node >= 22. No side effects on import.

import { resolve } from 'node:path';

export const SOURCE_SIZE_CONFIG_REL = 'docs/ai/source-size.json';

// Quoted VERBATIM by every surface that explains the practice: the plan-time render, the checker's
// rendered refusals, the constraints row a grounded review payload carries. The checker's GREEN line
// states the practice's FACTS instead — caps, recorded count, aggregate — and never this sentence.
export const SOURCE_SIZE_WHY = 'A module you can hold whole is the unit of review, test pairing and safe edit; the caps turn size drift into recorded, reasoned debt instead of invisible growth.';

export const configPathFor = (cwd) => resolve(cwd, 'docs', 'ai', 'source-size.json');

export const SOURCE_SIZE_STOP = 'SOURCE_SIZE_STOP';

// ── the line-safety boundary ───────────────────────────────────────────────────────
// ONE definition of what may never reach a rendered line — C0, DEL, C1, the two Unicode line
// separators, and a LONE surrogate — and every consumer DERIVED from it. The set is stated once
// because the alternative was demonstrated across review rounds: each surface guarded part of it,
// and each partial guard read as complete until a different character walked through it.
//
// The lone surrogate is here for a reason the others are not: it does not break a line, it breaks
// IDENTITY. Written as UTF-8 it becomes the replacement character, byte for byte identical to a
// name that really contains one — so two different names would print the same, which is the exact
// property the escaping exists to prevent. A valid PAIR is an ordinary character and is untouched.
//
// Three consumers, three jobs:
//   • escapeForLine — a value going into PROSE. Reversible: the backslash is escaped too, so a real
//     newline and a name that literally spells its escape can never render as the same string.
//   • jsonForLine   — a value going into the PASTEABLE suggestion, which must stay valid JSON a
//     human copies back into the config. JSON.stringify already escapes C0, the backslash and lone
//     surrogates, so only DEL/C1/separators survive it; escaping exactly those cannot double-escape
//     anything, and the result still JSON.parses back to the original name.
//   • isLineUnsafe  — the predicate, for the two values no escaper may touch: a reason (copied
//     VERBATIM into three different files, so it is refused at the door instead — and a
//     non-well-formed one could not land verbatim anywhere) and a rendered command (escapes would
//     change the path the shell receives, so the command is withheld).
const LINE_UNSAFE_CLASS = '\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029';
const LONE_SURROGATE = '[\\ud800-\\udbff](?![\\udc00-\\udfff])|(?<![\\ud800-\\udbff])[\\udc00-\\udfff]';
const UNSAFE = new RegExp(`[${LINE_UNSAFE_CLASS}]|${LONE_SURROGATE}`, 'g');
const ESCAPED = new RegExp(`[\\\\${LINE_UNSAFE_CLASS}]|${LONE_SURROGATE}`, 'g');
const asEscape = (ch) => `\\u${ch.codePointAt(0).toString(16).padStart(4, '0')}`;

export const isLineUnsafe = (text) => new RegExp(`[${LINE_UNSAFE_CLASS}]|${LONE_SURROGATE}`).test(String(text));
export const escapeForLine = (text) => String(text).replace(ESCAPED, (ch) => (ch === '\\' ? '\\\\' : asEscape(ch)));
export const jsonForLine = (value) => JSON.stringify(value).replace(UNSAFE, asEscape);

const stopWith = (exitCode) => (message) =>
  Object.assign(new Error(`[agent-workflow-kit] ${escapeForLine(message)}`), { code: SOURCE_SIZE_STOP, exitCode });

export const configFail = stopWith(2);
export const scopeFail = stopWith(1);
