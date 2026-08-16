#!/usr/bin/env node
// state-block-guard.mjs — the CONTINUATION-STALL detector, wired as a `Stop` hook.
//
// Why a hook and not a rule: every mechanised bar in this family gates FILES (the gate declaration,
// release-scan, doc-parity, the commit guard). The closing state block is CHAT output, which no gate
// can see — which is exactly why that contract recurred five times while file-level bars held.
//
// At Stop time the turn is ENDING. That single fact turns two closing shapes from "discouraged" into
// FALSE, so they can be judged mechanically:
//   * the "what I need from you" slot answering "nothing" — a stopped turn always needs a resume, so
//     the slot must NAME it. "Nothing needed" is honest only while work is actually running;
//   * a first-person promise of imminent work in the closing block — the turn is over, so the work
//     is not starting. This is the announce-and-stop shape.
// A promise GATED on something named (after your yes, when CI finishes) is honest and passes.
//
// The judgement is LEXICAL, and that is a layer with limits rather than a temporary weakness: it
// approximates "this condition gates that promise" by token order, and it can neither recognise a
// freshly invented wording for "nothing needed" nor parse a sentence. Where a rule to close one edge
// required a second classifier to decide what counts as a real ask, the rule was DELETED and its
// residual written down instead — twice. The mode contract lists every residual by name.
//
// ONE VOCABULARY, ENGLISH. The kit ships English markers and enumerates no other language: a
// language list would be a shipped guess about somebody else's dialogue, and it never stops growing.
// A deployment whose dialogue language is not English extends the arrays in ITS OWN placed copy —
// this file is copied into the project and self-contained, so that edit is local and survives an
// uninstalled kit. Until then such a deployment gets no detection, which the mode contract states.
//
// HONEST LIMIT, stated because it bounds what this can claim: a Stop hook cannot un-send the turn it
// judges. This is DETECTION — it converts a silent recurrence into a loud one. It never blocks, and
// every anomaly path exits 0: a hook that fires on every turn must not become the blocker or the
// noise. Self-contained by contract (a placed copy runs on machines without the kit): no imports
// beyond node built-ins, dependency-free, Node >= 22, no side effects on import.
//
// THE CHANNEL IS PART OF THE CONTRACT. At exit 0 a Stop hook's stderr reaches the debug log and
// nobody else; the one user-visible lane is JSON on stdout carrying `systemMessage`. So the warning
// rides that field — a guard warning down an invisible channel would be decoration. The blocking
// fields (`decision`, `continue`, `stopReason`, `hookSpecificOutput`) are deliberately never emitted:
// blocking the stop would re-enter the model on a message already sent to the reader.

import { pathToFileURL } from 'node:url';

export const HOOK_EVENT_NAME = 'Stop';
const EXIT_OK = 0;

// The three slots, matched on their LABEL and ANCHORED TO A LINE START. The anchor is not cosmetic:
// a message that DISCUSSES this contract — which the sessions this guard was built for do constantly
// — mentions the labels inline, and an unanchored match would judge that prose instead of the real
// closing block.
const LINE_LEAD = '^[ \\t\\-•]*';
const SLOT_PATTERNS = Object.freeze({
  now: new RegExp(`${LINE_LEAD}(?:now|where we are|state now)\\s*[:：]`, 'gim'),
  fromYou: new RegExp(`${LINE_LEAD}(?:what i need from you|from you)\\s*[:：]`, 'gim'),
  next: new RegExp(`${LINE_LEAD}(?:what(?:'s| is)? next|next)\\s*[:：]`, 'gim'),
});

// Quoted and fenced material is EXAMPLE text, not the turn's own closing block. Stripped before any
// label search — otherwise pasting the very specimen this guard catches would make the guard judge
// the paste. Emphasis marks are stripped after, so `**Now:**` still parses.
// Scanned line by line rather than matched as one regex: an UNCLOSED fence must run to the end of
// the message. A pattern that only removes CLOSED fences would take an unfinished example's labels
// for a real block — judging a demonstration as if it were the turn, which is precisely the mistake
// this stripper exists to prevent. A closing fence must be at least as long as its opener and carry
// nothing but whitespace after it.
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;
// The trailing `\r` is not an edge case: the text is split on `\n`, so on a CRLF host EVERY line
// ends in one. A close pattern that forbids it leaves every fence open, the stripper swallows the
// real closing block, and the guard goes blind on that whole platform — silently.
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t\r]*$/;
const closesFence = (line, open) => {
  const close = line.match(FENCE_CLOSE);
  return close !== null && close[1][0] === open[0] && close[1].length >= open.length;
};
// One pass, appending in place. A reduce that rebuilt the kept array per line was quadratic in the
// message length, and this hook runs on EVERY turn end under a documented 10-second timeout.
const stripFences = (text) => {
  const kept = [];
  const state = { open: null };
  for (const line of text.split('\n')) {
    if (state.open !== null) {
      if (closesFence(line, state.open)) state.open = null;
      continue;
    }
    const opened = line.match(FENCE_OPEN);
    if (opened === null) kept.push(line);
    else state.open = opened[1];
  }
  return kept.join('\n');
};

const BLOCKQUOTE_LINE = /^[ \t]*>.*$/gm;
const EMPHASIS_MARKS = /[*_`]/g;
// A model writes "What's next" and "I'll" with a typographic apostrophe far more often than with the
// ASCII one, so matching only ASCII made every label and every promise marker fail silently on
// ordinary output. U+02BC rides as an escape because it is a modifier LETTER, and this family's
// sources carry no non-ASCII letter; the escaped class matches exactly the same characters.
const APOSTROPHES = /[’‘\u02bc‛]/g;
const toProse = (text) => stripFences(text)
  .replace(BLOCKQUOTE_LINE, '')
  .replace(EMPHASIS_MARKS, '')
  .replace(APOSTROPHES, "'");

// A "nothing" answer, judged ONLY over the slot's FIRST CLAUSE — the answer proper. A slot that
// names a real ask and then adds "nothing else is needed" is honest and must stay passing, or the
// contract becomes unwritable. A dot ends a clause only before whitespace or the end of the slot:
// `README.md` is a file name, and treating its dot as a sentence end both hid banned forms behind a
// short prefix and split honest sentences in half. There is no character cap — a cap decides where
// an answer ends by counting, and a long preamble would carry a banned form past it unseen.
const CLAUSE_END = /;|[.!?](?=\s|$)/;
const openingAnswer = (slot) => {
  const at = slot.search(CLAUSE_END);
  return at === -1 ? slot : slot.slice(0, at);
};
// A rule excusing "…, nothing else is needed" was built, tightened twice, and then DELETED. Every
// version let a banned answer through behind some harmless prefix, and the next version would have
// needed an "is this a real ask" recogniser — a second lexical classifier with its own edge set. The
// residual is stated instead of coded: a comma-joined qualifier IS flagged, and the writer's fix is
// a clause break, which the first-clause rule already passes.

const NOTHING_FORMS = Object.freeze([
  'nothing',
  'none',
  'n/a',
  'no action',
  'no need',
  'not needed',
  'not required',
]);

// -- the "what is happening NOW" slot is not a report of what was DONE ----------------------------
// The third judgeable shape. The three slots answer three different questions; when the now-slot
// opens with finished work, the reader's one question — what is running — is buried behind a
// summary they can already read in the message body above.
// Judged by TOKEN ORDER, the technique the promise/gate rule uses: a COMPLETION marker standing
// BEFORE the first CURRENCY marker means the running fact was buried. Two consequences are
// deliberate — a slot with NO currency marker is never judged here (nothing running is a legitimate
// state, and whether that is honest is the from-you slot's question), and a slot that LEADS with
// what is running passes whatever it adds afterwards.
// Stated residual, in this file's own style: a CURRENT state phrased with a COMPLETION MARKER
// ("the work is closed, waiting on your call" — `closed` is in the list below) is flagged, and the
// writer's fix is to phrase the state rather than the transition. Telling that from a real
// completion report needs a classifier this layer lacks. The specimen is deliberately one the list
// really carries: a residual written with a word the code does not match would document a false
// positive that cannot happen, which is worse than no residual at all.
const COMPLETION_FORMS = Object.freeze([
  'done', 'completed', 'finished', 'closed', 'landed', 'shipped', 'merged', 'published',
  'committed', 'fixed', 'added', 'removed', 'updated', 'recorded', 'measured', 'marked',
  'verified', 'ran', 'wrote',
  "i've", 'i have',
]);

// Running STATE only, never a time-deictic. "now" is the slot's own label, so accepting it as a
// currency marker would put one at position 0 of nearly every slot and every completion after it
// would read as honest — one word defeating the whole rule. A marker that names WHEN rather than
// WHAT-IS-HAPPENING cannot carry this judgement.
const CURRENCY_FORMS = Object.freeze([
  'running', 'in progress', 'waiting', 'awaiting', 'pending', 'is up', 'under way', 'underway',
  'in flight', 'blocked on',
]);

// First-person promises of imminent work. Present tense counts: at Stop it describes work that is
// NOT running.
// The markers are pronoun+modal or pronoun+verb, so they cannot tell "I'll start" from "I'll wait".
// Waiting is not work: it is what a turn that ENDS actually does, and it needs no gate to be honest.
// So a modal followed by a waiting verb is excluded rather than the modal being dropped — dropping
// it would need an open-ended list of every action verb English can put after it.
const WAITING_CONTINUATIONS = Object.freeze([
  "i'll wait", 'i will wait', "i'll be waiting", "i'll stand by", 'i will stand by',
  "i'll hold", 'i will hold', "i'll stay", 'i will stay', "i'll remain", 'i will remain',
]);

const PROMISE_FORMS = Object.freeze([
  "i'll", 'i will', "i'm going to", 'i am going to', "i'm starting", "i'm taking",
  'i start', 'i begin', 'i take', 'i move on', 'next i',
]);

// A gate the promise may depend on. What is actually checked is TOKEN ORDER inside one segment: a
// gate is treated as excusing a promise when it appears in the same segment and earlier in it. That
// is a lexical approximation of dependency, not dependency itself, and it carries two named
// residuals — an honest TRAILING gate ("I'll take it when you say so") is flagged, and a gate
// belonging to an earlier comma-clause ("if the test fails I'll report, and now I start the next
// class") wrongly excuses a promise that follows it. Both are accepted limits of a lexical layer,
// documented in the mode contract.
const CONDITIONAL_FORMS = Object.freeze([
  'after', 'when', 'if', 'as soon as', 'once', 'upon', 'pending',
]);

// Segment boundaries for the promise/gate rule. Deliberately NOT the comma: "if you agree, I'll take
// the class" is one honest thought, and splitting it would flag the shape the rule exists to permit.
const PROMISE_SEGMENT_BREAK = /;|\n|[.!?](?=\s|$)/;

// Word-bounded matching, Unicode-aware. The markers are English but the TEXT is the project's
// dialogue language, which need not be ASCII, and JavaScript's `\b` is ASCII-only: under it every
// non-ASCII letter reads as a word break, so an English marker sitting inside a non-ASCII word would
// match as if it stood alone. The Unicode class costs nothing and keeps that door shut; on the
// English side it is what stops `none` matching inside `nonexistent`.
const WORD_CHAR = '\\p{L}\\p{N}';
const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const boundedPattern = (phrase) => new RegExp(
  `(?<![${WORD_CHAR}])${escapeForRegExp(phrase)}(?![${WORD_CHAR}])`,
  'iu',
);
const firstMatchAt = (haystack, needles) => needles.reduce((best, needle) => {
  const at = haystack.search(boundedPattern(needle));
  if (at === -1) return best;
  return best === -1 ? at : Math.min(best, at);
}, -1);
const containsAny = (haystack, needles) => firstMatchAt(haystack, needles) !== -1;

// Nearly every English completion marker doubles as an ADJECTIVE, which the Russian verbs this rule
// was first written against did not: "the updated test suite is running" is an honest now-slot that
// leads with the running fact, and reading `updated` there as a completion report would flag it. A
// marker sitting directly after a DETERMINER is attributive — it modifies the noun after it instead
// of reporting a transition — so it is not counted.
// Residual, stated: this also loses a completion phrased attributively ("the finished council, the
// matrix is running" passes). That trade is deliberate. A false flag on a correct slot is noise from
// a hook that fires on EVERY turn, and noise is the failure this file is most careful to avoid; a
// missed marginal shape is not.
const DETERMINERS = Object.freeze(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'its', 'my', 'our', 'your', 'their']);
const AFTER_DETERMINER = new RegExp(`(?:^|[^${WORD_CHAR}])(?:${DETERMINERS.join('|')})[ \\t]+$`, 'iu');
const matchesIn = (haystack, needle) => [...haystack.matchAll(new RegExp(boundedPattern(needle).source, 'giu'))]
  .map((match) => match.index);
const firstReportedAt = (haystack, needles) => needles.reduce((best, needle) => {
  const at = matchesIn(haystack, needle).find((index) => !AFTER_DETERMINER.test(haystack.slice(0, index)));
  if (at === undefined) return best;
  return best === -1 ? at : Math.min(best, at);
}, -1);

const normalise = (value) => (typeof value === 'string'
  ? value.replace(EMPHASIS_MARKS, '').replace(APOSTROPHES, "'").toLowerCase()
  : '');

const SLOT_COUNT = Object.keys(SLOT_PATTERNS).length;

const collectLabels = (prose) => Object.entries(SLOT_PATTERNS)
  .flatMap(([slot, pattern]) => [...prose.matchAll(pattern)]
    .map((match) => ({ slot, start: match.index, bodyAt: match.index + match[0].length })))
  .sort((a, b) => a.start - b.start);

// Labels are grouped into candidate BLOCKS rather than picked per slot: picking each slot's last
// occurrence independently splices a trailing incomplete block onto an earlier one and fabricates a
// block nobody wrote. A repeated slot abandons the candidate and RESTARTS it at that label, because
// the repeat is itself the plausible first label of a new block.
const groupLabels = (labels) => labels.reduce((state, label) => {
  const candidate = state.current.some((held) => held.slot === label.slot) ? [label] : [...state.current, label];
  return candidate.length === SLOT_COUNT
    ? { current: [], completed: candidate }
    : { current: candidate, completed: state.completed };
}, { current: [], completed: null });

// findStateBlock(text) -> { now, fromYou, next } or null. The LAST STARTED candidate decides: if the
// message ends mid-block, the turn did not end on a block at all, and falling back to an earlier
// complete one would judge text the turn already moved past.
export const findStateBlock = (text) => {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const prose = toProse(text);
  const { current, completed } = groupLabels(collectLabels(prose));
  if (current.length > 0 || completed === null) return null;
  const block = {};
  completed.forEach((entry, index) => {
    const end = index + 1 < completed.length ? completed[index + 1].start : prose.length;
    block[entry.slot] = prose.slice(entry.bodyAt, end).trim();
  });
  return block;
};

// decideStop({ closingText, requireBlock }) -> { ok, reasons }. Never throws: junk input decides
// "no block", which is a reportable state rather than a crash. An ABSENT block is reported only
// under `requireBlock`: this kit does not mandate the three-part block, so warning about its absence
// by default would fire on nearly every turn of a project that never adopted it — noise, from a hook
// that runs on every single turn.
export const decideStop = (options) => {
  const { closingText, requireBlock = false } = options ?? {};
  const block = findStateBlock(closingText);
  if (block === null) {
    return requireBlock
      ? {
        ok: false,
        reasons: ['no state block: the closing message must end with "now / what I need from you / what\'s next"'],
      }
      : { ok: true, reasons: [] };
  }
  const reasons = [];
  const answer = openingAnswer(normalise(block.fromYou));
  if (answer.trim() === '' || containsAny(answer, NOTHING_FORMS)) {
    reasons.push(
      'from-you slot answers "nothing": the turn is ENDING, so a resume from the maintainer IS required — name the real unblocker instead',
    );
  }
  if (buriesTheRunningFact(normalise(block.now))) {
    reasons.push(
      'the now-slot reports finished work before it names what is running — "now" is the state at this instant; move what you completed into the message body above the block',
    );
  }
  if (hasUngatedPromise(normalise(block.next))) {
    reasons.push(
      'announce-and-stop: the what-next slot promises imminent first-person work while the turn ends — either do it in this turn, or state what the work waits on',
    );
  }
  return { ok: reasons.length === 0, reasons };
};

const buriesTheRunningFact = (nowSlot) => {
  const currencyAt = firstMatchAt(nowSlot, CURRENCY_FORMS);
  if (currencyAt === -1) return false;
  const completionAt = firstReportedAt(nowSlot, COMPLETION_FORMS);
  return completionAt !== -1 && completionAt < currencyAt;
};

const hasUngatedPromise = (nextSlot) => nextSlot.split(PROMISE_SEGMENT_BREAK).some((segment) => {
  const promiseAt = firstMatchAt(segment, PROMISE_FORMS);
  if (promiseAt === -1) return false;
  if (containsAny(segment, WAITING_CONTINUATIONS)) return false;
  const gateAt = firstMatchAt(segment, CONDITIONAL_FORMS);
  return !(gateAt !== -1 && gateAt < promiseAt);
});

// "Exit 0 on every path" and "say nothing on every path" are DIFFERENT promises, and only the first
// was ever earned. A guard that cannot see the turn is BLIND, which is a real failure, and this
// family forbids silent ones — so a failure is reported like any other finding. Having nothing to
// judge is not a failure and stays silent: a hook that fires every turn would otherwise warn every
// turn on a host that simply delivers no closing text.
// A FAILURE and a FINDING are different claims and must not share a headline: reporting "the closing
// state block is defective" when no block was ever read would blame the writer for the guard's own
// blindness.
export const FAILURE = 'failure';
export const FINDING = 'finding';
const guardFailure = (detail) => ({ ok: false, kind: FAILURE, reasons: [detail] });

const parsePayload = (rawInput) => {
  try {
    return { input: JSON.parse(rawInput) };
  } catch (error) {
    return { error: `the Stop payload could not be parsed as JSON (${error.message})` };
  }
};

// An ABSENT field means the host delivers nothing (silent, above). A PRESENT field of the wrong type
// is a CORRUPT payload and is reported — the two are only indistinguishable if you never look.
//
// `last_assistant_message` is the ONLY source. A transcript fallback was built and then DELETED: the
// transcript file is written asynchronously, so a lagging one can END on the previous turn's
// assistant entry with nothing after it, and no tail check can tell that apart from the current
// turn. A fallback that can be confidently wrong about WHICH TURN it read is worse than no fallback,
// because being confidently wrong is the one failure a detector must not have. A host that does not
// deliver the field therefore gets no detection — stated in the mode contract, and silent rather
// than warning on every single turn.
//
// An EMPTY string is delivered text, not an absent one: a turn that ended with no prose really did
// end without a closing block, and `--require-block` should be able to say so.
// runHook(raw, {requireBlock}) -> a decision, or null when there is genuinely nothing to judge.
// Never throws.
export const runHook = (rawInput, deps) => {
  const requireBlock = (deps ?? {}).requireBlock === true;
  const parsed = parsePayload(rawInput);
  if (parsed.error !== undefined) return guardFailure(parsed.error);
  const input = parsed.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return guardFailure('the Stop payload is not a JSON object');
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'last_assistant_message')) return null;
  const delivered = input.last_assistant_message;
  if (typeof delivered !== 'string') {
    return guardFailure(`the payload's last_assistant_message is ${delivered === null ? 'null' : typeof delivered}, not a string`);
  }
  return decideStop({ closingText: delivered, requireBlock });
};

// The stream is a parameter so the read path itself is exercisable, not just its caller.
export const readStdin = async (stream = process.stdin) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

const FINDING_HEADER = 'state-block-guard — the closing state block is defective (CONTINUATION-STALL):';
const FAILURE_HEADER = 'state-block-guard — this turn was NOT judged; the guard could not see it:';
const formatWarning = (decision) => [
  decision.kind === FAILURE ? FAILURE_HEADER : FINDING_HEADER,
  ...decision.reasons.map((reason) => `• ${reason}`),
].join('\n');

// The ONE flag. A misspelling must never be read as "run in the default mode": that would silently
// downgrade the strictness the user deliberately opted into, which is the failure an opt-in must not
// have. So an unrecognised argument refuses the turn's judgement LOUDLY — and still exits 0.
export const REQUIRE_BLOCK_FLAG = '--require-block';
export const parseArgs = (argv = []) => ({
  requireBlock: argv.includes(REQUIRE_BLOCK_FLAG),
  unknown: argv.filter((arg) => arg !== REQUIRE_BLOCK_FLAG),
});

export const main = async ({
  argv = process.argv.slice(2),
  readInput = readStdin,
  write = (line) => process.stdout.write(line),
} = {}) => {
  // Exit 0 on EVERY path, always. This guard reports; it is never the thing that stops a session.
  try {
    const { requireBlock, unknown } = parseArgs(argv);
    if (unknown.length > 0) {
      write(`${JSON.stringify({
        systemMessage: `state-block-guard: unrecognised argument ${unknown.join(' ')} — refusing to judge this turn rather than silently falling back to the default mode; ${REQUIRE_BLOCK_FLAG} is the only argument accepted`,
      })}\n`);
      return EXIT_OK;
    }
    const decision = runHook(await readInput(), { requireBlock });
    if (decision !== null && decision.ok === false) {
      write(`${JSON.stringify({ systemMessage: formatWarning(decision) })}\n`);
    }
  } catch (error) {
    // Never silent, never fatal: the failure is reported and the exit code stays 0.
    try {
      write(`${JSON.stringify({
        systemMessage: formatWarning({ kind: FAILURE, reasons: [error?.message ?? String(error)] }),
      })}\n`);
    } catch {
      // The reporting channel itself is gone; there is nowhere left to report it to.
    }
  }
  return EXIT_OK;
};

// `process.exitCode`, never `process.exit()`: an immediate exit can truncate a pending stdout write
// to a pipe, and that single warning is the entire product of this hook.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main().then((code) => { process.exitCode = code; });
