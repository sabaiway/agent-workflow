// composed-lines-scan.mjs — the L2 scanner leaf behind test/composed-lines-ux.test.mjs (split out
// so the guard file keeps the 400-line new-file cap). PURE: no imports, no fs — word lists in,
// scannable text out. The grammar decisions live here, in ONE place:
//
//   • a line's LEADING self-label/prefix is the machine-line channel — `[name]`, `name:`,
//     `name —`, `name (`, or a bare `name` line — stripped before scanning;
//   • a WHOLE-LINE `[name] key=value` machine line is exempt BY GRAMMAR (the `[run-gates]
//     status=…` channel), never by token-dropping;
//   • a backtick span is exempt ONLY when the WHOLE span matches a runnable command / flag /
//     KEY=VALUE / path grammar — a backticked bare word (`skipped-readonly`) is scanned;
//   • a whitespace token is exempt ONLY when PATH-shaped (leading / . ~ $, a dot-extension
//     segment, or a trailing /) or FLAG-shaped (leading -) — a slash-joined word pair
//     (`anchor/slot`) is scanned.

// Alarm words (L2 invariant a): allowed only in outcomes gated on a DETECTED abnormal condition.
export const ALARM_WORDS = ['PARTIALLY', 'incomplete', 'failed', 'broken', 'persists'];

// Internal tool/operation names + marker terminology (deploy-tail's closed examples plus the
// composer modules' own names). Regex fragments; `ensures?` covers the noun.
export const INTERNAL_NAMES = [
  'hide-footprint', 'lens-region', 'bridge-settings', 'setup-backends', 'ensure-configs',
  'refresh-parity', 'run-gates', 'doc-parity', 'migrate-gates',
  'reconcile', 'ensureSlot', 'inject', 'ensures?', 'markers?', 'slots?', 'fragments?', 'anchors?',
];

const NAME_ALT = INTERNAL_NAMES.join('|');
const LABEL_RE = new RegExp(`^\\s*(?:\\[(?:${NAME_ALT})\\]|(?:${NAME_ALT}):|(?:${NAME_ALT})(?= — |$| \\())`);

// A whole line of the `[tool] key=value` machine grammar (one bracketed label, one key=… payload).
// The value may carry anything — the machine channel is where raw diagnostics belong.
const MACHINE_LINE_RE = /^\s*\[[a-z][a-z-]*\] [a-z][A-Za-z0-9_-]*=/;

// The WHOLE-span grammars a backtick span may match to be exempt (a runnable thing, not prose).
const SPAN_EXEMPT = [
  /^--?[A-Za-z][A-Za-z0-9-]*(?:[= ]\S.*)?$/, // a flag, optionally with a value / operand tail
  /^[A-Z][A-Z0-9_]*=.*$/, // KEY=VALUE (env/settings keys are UPPER_SNAKE)
  /^(?:node|git|npx|npm|rm|ln)\b.*$/, // a runner invocation
  /^[/.~$]\S*$/, // an anchored path-ish operand
  /^\S*\.[a-z0-9]{1,5}(?:\/\S*)?$/i, // a dot-extension path segment
];
const spanExempt = (span) => SPAN_EXEMPT.some((re) => re.test(span));

// A whitespace token (edge punctuation stripped) is dropped only when it is path- or flag-shaped.
const edgeTrim = (token) => token.replace(/^[(«"'‘“]+/, '').replace(/[)»"'’”,.;:]+$/, '');
const tokenExempt = (token) => {
  const t = edgeTrim(token);
  if (t === '') return true;
  if (t.startsWith('-')) return true; // a flag
  if (/^[/.~$]/.test(t)) return true; // an anchored path
  if (t.endsWith('/')) return true; // a directory form
  if (/\.[a-z0-9]{1,5}([/):,;.]|$)/i.test(t)) return true; // a dot-extension segment
  return false;
};

// A raw command string (outside backticks) — stripped wholesale wherever it appears.
const COMMAND_RE = /\/agent-workflow-kit [a-z][a-z-]*|npx @sabaiway\/[a-z-]+@latest(?: init)?/g;

// scannable(line) → the human-sentence remainder of one composed line, ready for word-boundary
// scans. A whole-line machine-grammar line scans as EMPTY (exempt by grammar, not by dropping).
export const scannable = (line) => {
  if (MACHINE_LINE_RE.test(line)) return '';
  const withoutLabel = line.replace(LABEL_RE, '');
  const withoutSpans = withoutLabel.replace(/`([^`]*)`/g, (whole, span) => (spanExempt(span) ? ' ' : ` ${span} `));
  return withoutSpans
    .replace(COMMAND_RE, ' ')
    .split(/\s+/)
    .filter((token) => !tokenExempt(token))
    .join(' ');
};

// hits(line, words) → the members of `words` (regex fragments) present in the scannable remainder.
export const hits = (line, words) => {
  const text = scannable(line);
  return words.filter((word) => new RegExp(`\\b${word}\\b`, 'i').test(text));
};
