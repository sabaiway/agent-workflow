import { fileURLToPath } from 'node:url';

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const CRLF = CR + LF;
const BACKSLASH = String.fromCharCode(92);
const FRONTMATTER_BOUNDARY = '---';
const STRUCTURAL_HEADING_RE = /^#{2,3} /;
const NUMBERED_HEADING_RE = /^### 2[.]([0-9]+)[.]/;
const NUMBERED_HEADING_PREFIX = '### 2.';
const MAX_LINES_RE = new RegExp('^maxLines:' + BACKSLASH + 's*([0-9]+)' + BACKSLASH + 's*$');
const TEMPLATE_CANON = 'template';
const HEADING_COUNT_DEFECT = 'heading-count';
const HEADING_TWICE_REFUSAL = 'heading-twice';
const ANCHOR_ABSENT_REFUSAL = 'anchor-absent';
const CAP_REFUSAL = 'cap';
const SINGLE_HEADING = 1;
const NOT_FOUND = -1;
const UTF8_LABEL = 'utf-8';
const UTF8_ENCODING = 'utf8';
const ROUND_TRIP_MESSAGE = 'the bytes read do not survive a UTF-8 round trip';
const BOM_CHAR = String.fromCharCode(65279);
const INSERT_PATH = fileURLToPath(new URL('./rules-insert.mjs', import.meta.url));
const COMMAND_UNSAFE_RE = /[\u0000-\u001f\u007f`]/;
const SHELL_PLAIN_RE = /^[A-Za-z0-9_./-]+$/;
const SINGLE_QUOTE = "'";
const QUOTE_ESCAPE = "'\\''";

// Append the OUTGOING canon here in the same release that changes the template
// §2.5 or §2.7 region — the fragment-or-prior reconcile depends on it.
const COMMS_PRIOR_PRE_AD054 = `### 2.x. Communication (user-facing messages)
Apply this as part of §2 before any user-facing summary:
- **Deliver the artifact IN the message** — paste the prompt / diff / version / command inline; never "see §X / open the file / run it and you'll see" as a *substitute* for showing what was asked.
- **Lead with the result**, then the details; show exactly what was asked — no deflection, no "almost done" when the ask was the finished thing.
- **No condescension, no filler.** Own a miss plainly and fix it in the same message.
- **Large artifact (≈>100 lines):** deliver a real summary or the key excerpt inline **and** link the file — never flood the reader with a 2000-line paste, never hide the answer behind a bare pointer.`;
const COMMS_PRIOR_AD054 = `${COMMS_PRIOR_PRE_AD054}
- **Live host/session facts are tool-composed only.** Any claim about the current host or session state (prompts fired, sandbox scope, whether a bypass was needed, network reachability, approval counts) must trace to **live tool output** from **this session**; a memory/handover snapshot is **context, never report facts**, and a claim with no live signal is **omitted or explicitly marked unverified** — never asserted from recollection.`;
const COMMS_PRIOR_PLAIN_LANGUAGE = `### 2.x. Communication (user-facing messages)
Apply this as part of §2 before any user-facing summary:
- **Plain language.** User-facing narration is short, clear, plain words of the dialogue language; when the dialogue language is not English, transliterated English jargon is banned — an English term survives only as the NAME of a thing (a flag / command / file / test), glossed in plain words when helpful; plain English stays plain for English-dialogue users.
- **Deliver the artifact IN the message** — paste the prompt / diff / version / command inline; never "see §X / open the file / run it and you'll see" as a *substitute* for showing what was asked.
- **Lead with the result**, then the details; show exactly what was asked — no deflection, no "almost done" when the ask was the finished thing.
- **No condescension, no filler.** Own a miss plainly and fix it in the same message.
- **Large artifact (≈>100 lines):** deliver a real summary or the key excerpt inline **and** link the file — never flood the reader with a 2000-line paste, never hide the answer behind a bare pointer.
- **Live host/session facts are tool-composed only.** Any claim about the current host or session state (prompts fired, sandbox scope, whether a bypass was needed, network reachability, approval counts) must trace to **live tool output** from **this session**; a memory/handover snapshot is **context, never report facts**, and a claim with no live signal is **omitted or explicitly marked unverified** — never asserted from recollection.`;
const COMMS_PRIOR_STATE_BLOCK = `${COMMS_PRIOR_PLAIN_LANGUAGE}
- **The closing state block answers three DIFFERENT questions.** Close a user-facing message with three labelled slots — *now* · *what I need from you* · *what's next*. The slot LABELS stay ENGLISH — an English label is what lets a state-block checker FIND the block and its slots at all; everything written INTO a slot is in the project's dialogue language; when that language is not English, the checker's English phrase sets do not judge those values. **Now** = the state at this instant: what is RUNNING, or what the work is stopped on. It is **never a report of finished work** — what you completed goes in the message BODY, above the block. **From you** = the real unblocker, named; a turn that is ENDING always has one. **Next** = what follows. A *now* slot that opens with what was completed buries the one fact the reader opened the message for, and the three slots collapse into one restatement.`;
const COMMS_PRIOR_SKIP_FINDING = `${COMMS_PRIOR_STATE_BLOCK}
- **A skip that contradicts the tree is a finding.** A tool-composed \`skipped-*\` line whose stated reason the observed tree disproves (a "no Node" skip beside deployed Node scripts) is raised as a FINDING in the report, never pasted as a neutral outcome — and a tool may not emit a skip whose reason it could itself disprove.`;
const COMMS_PRIORS = [
  COMMS_PRIOR_PRE_AD054, COMMS_PRIOR_AD054, COMMS_PRIOR_PLAIN_LANGUAGE, COMMS_PRIOR_STATE_BLOCK, COMMS_PRIOR_SKIP_FINDING,
];
const STORY_PRIOR_FIVE_SESSIONS = `### 2.x. Story sessions
A story — one row of an epic's ledger, carried by one plan — runs as five sessions, each ending at its own review checkpoint: **spec** (the contract under \`docs/ai/specs/\`, drafted and reviewed on the \`plan-authoring\` recipe), **plan** (the ledger, same recipe), **tests** (one task per ledger row, red first), **code** (one task per row, to green), and **diff review, release and record** (the review of the staged tree on the \`plan-execution\` recipe, the release where the story ships one, then the changelog and handover entries and the plan's Phase: Cleanup). Tests and code never share a session, and a spec and its plan never share one either. A storyless plan runs the same five. **Exception — a split:** moving code and its existing cases into modules, with no new logic and no new case, is one session: a short spec (the Module list), the split, the diff review, the release, Cleanup.`;

export const RULES_REGIONS = Object.freeze([
  Object.freeze({
    id: 'communication',
    headingRe: /^### 2[.]([0-9]+)[.] Communication [(]user-facing messages[)]/,
    label: '### 2.x. Communication (user-facing messages)',
    canon: TEMPLATE_CANON,
    priors: COMMS_PRIORS,
  }),
  Object.freeze({
    id: 'story-sessions',
    headingRe: /^### 2[.]([0-9]+)[.] Story sessions/,
    label: '### 2.x. Story sessions',
    canon: TEMPLATE_CANON,
    priors: [STORY_PRIOR_FIVE_SESSIONS],
  }),
  Object.freeze({
    id: 'lens',
    headingRe: /^### 2[.]([0-9]+)[.] Planning, review & process-fidelity/,
    label: '### 2.x. Planning, review & process-fidelity invariants',
    canon: 'engine',
    priors: [],
  }),
]);
const TEMPLATE_REGIONS = RULES_REGIONS.filter(({ canon }) => canon === TEMPLATE_CANON);

const stripCr = (line) => (line.endsWith(CR) ? line.slice(0, -1) : line);
const isBoundary = (line) => line === FRONTMATTER_BOUNDARY || STRUCTURAL_HEADING_RE.test(line);
const lineCount = (text) => text.split(LF).length - (text.endsWith(LF) ? 1 : 0);
const findHeadings = (lines, headingRe) => lines.flatMap((line, index) => {
  const match = stripCr(line).match(headingRe);
  return match ? [{ index, number: match[1] }] : [];
});
const regionEnd = (lines, start) => {
  const afterHeading = start + 1;
  const boundary = lines.slice(afterHeading).findIndex((line) => isBoundary(stripCr(line)));
  return boundary === NOT_FOUND ? lines.length : afterHeading + boundary;
};

export const extractRegionBy = (text, headingRe) => {
  const lines = String(text).split(LF);
  const headings = findHeadings(lines, headingRe);
  const count = headings.length;
  if (count === 0) return { found: false, count: 0 };
  const { index: start, number } = headings[0];
  const end = regionEnd(lines, start);
  const regionLines = lines.slice(start, end).map(stripCr);
  const bodyEnd = regionLines.findLastIndex((line) => line.trim() !== '') + 1;
  const body = regionLines.slice(0, bodyEnd).join(LF);
  return { found: true, count, start, end, number, body };
};

export const readTemplateSpan = (text, headingRe) => {
  const region = extractRegionBy(text, headingRe);
  if (region.count !== SINGLE_HEADING) return { defect: HEADING_COUNT_DEFECT };
  const span = String(text).split(LF).slice(region.start, region.end).map(stripCr).join(LF);
  return { span, number: region.number };
};

// A reader that will WRITE the whole document back must not decode leniently: readFileSync(path,
// 'utf8') turns an invalid byte into U+FFFD, and the rewrite would carry that substitution into
// bytes nobody asked to change. The guarantee the callers need is not "the decoder is strict" but
// "re-encoding gives back the bytes we read" — so it is asserted, not reasoned about: any decoder
// asymmetry (a substitution, a stripped byte-order mark) fails here rather than in the written file.
// Bytes in, text out, or one throw the caller answers by its own name.
export const decodeUtf8Strict = (bytes) => {
  const text = new TextDecoder(UTF8_LABEL, { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!Buffer.from(text, UTF8_ENCODING).equals(bytes)) throw new Error(ROUND_TRIP_MESSAGE);
  return text;
};

// The decoded text KEEPS a leading byte-order mark, because the writer must give the bytes back
// exactly; a structural reader must therefore look past it, or a file that declares maxLines reads
// as one that declares none. Only judgement skips it — never the text any offset is computed over.
export const frontmatterMaxLines = (text) => {
  const lines = String(text).split(LF).map(stripCr);
  const opening = lines[0]?.startsWith(BOM_CHAR) ? lines[0].slice(BOM_CHAR.length) : lines[0];
  if (opening !== FRONTMATTER_BOUNDARY) return null;
  for (const line of lines.slice(1)) {
    if (line === FRONTMATTER_BOUNDARY) return null;
    const match = line.match(MAX_LINES_RE);
    if (match) return Number(match[1]);
  }
  return null;
};

export const exceedsCap = (text, cap) => {
  const count = lineCount(text);
  const skipped = cap === null;
  return { over: !skipped && count > cap, count, skipped };
};

export const planInsert = ({ text, spans, cap }) => {
  const regions = TEMPLATE_REGIONS.map(({ id, headingRe }) => ({
    id,
    region: extractRegionBy(text, headingRe),
  }));
  const doubled = regions.find(({ region }) => region.count > SINGLE_HEADING);
  if (doubled) return { refusal: HEADING_TWICE_REFUSAL, region: doubled.id };
  const missing = regions.filter(({ region }) => !region.found);
  if (missing.length === 0) return { planned: [], text };
  const lines = text.split(LF);
  const headings = findHeadings(lines, NUMBERED_HEADING_RE);
  if (headings.length === 0) return { refusal: ANCHOR_ABSENT_REFUSAL };
  const insertAt = regionEnd(lines, headings.at(-1).index);
  const highestNumber = Math.max(...headings.map(({ number }) => Number(number)));
  const planned = missing.map(({ id }, index) => ({
    id,
    number: String(highestNumber + index + 1),
    insertAt,
  }));
  const newline = text.includes(CRLF) ? CRLF : LF;
  const offset = insertAt === lines.length
    ? text.length
    : lines.slice(0, insertAt).reduce((length, line) => length + line.length + LF.length, 0);
  const prefix = offset === text.length && !text.endsWith(LF) ? newline : '';
  const inserted = planned.map(({ id, number }) => {
    const bound = spans[id].span.replace(NUMBERED_HEADING_RE, NUMBERED_HEADING_PREFIX + number + '.');
    return bound.split(LF).map(stripCr).join(newline) + newline;
  }).join('');
  const resultText = text.slice(0, offset) + prefix + inserted + text.slice(offset);
  const decision = exceedsCap(resultText, cap);
  if (decision.over) return { refusal: CAP_REFUSAL, count: decision.count, cap };
  return { planned, text: resultText };
};

const shellWord = (path) => SHELL_PLAIN_RE.test(path)
  ? path
  : SINGLE_QUOTE + path.split(SINGLE_QUOTE).join(QUOTE_ESCAPE) + SINGLE_QUOTE;

export const buildInsertPreview = (root, insertPath = INSERT_PATH) => {
  if ([root, insertPath].some((path) => COMMAND_UNSAFE_RE.test(path))) return '';
  return 'node ' + shellWord(insertPath) + ' --cwd ' + shellWord(root);
};
