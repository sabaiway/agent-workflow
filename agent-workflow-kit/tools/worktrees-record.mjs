// worktrees-record.mjs — the worktrees handoff RECORD as a leaf (delegation Plan 3, Phase 2): the
// typed STOP, the exit codes, and the provision-record format (compose + parse).
//
// Extracted out of worktrees.mjs so a SECOND mode can read a satellite's record without importing
// the 3200-line worktrees tool — the satellite cold-start prompt does today, and the handoff-return
// rung will. worktrees.mjs re-exports every name below, so every existing import site and every
// asserted error `code` is unchanged.
//
// The move was byte-for-byte with ONE deliberate exception, stated rather than smuggled: the
// control-byte class was widened to cover C1 (U+0080-U+009F). That is a compatibility TIGHTENING —
// the record refuses strictly more than it did — taken because the same class now guards a second
// surface (the cold-start prompt, read in a terminal) and one class beats two that can drift. It is
// pinned by its own test rather than left to the extraction claim.
//
// A PURE leaf: Node built-ins only (it needs none), no fs, no git, no CLI, no side effects on
// import. Dependency-free, Node >= 22.

export const WORKTREES_STOP = 'WORKTREES_STOP';
export const stop = (message, fields = {}) =>
  Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'WorktreesStop', code: WORKTREES_STOP, ...fields });

export const EXIT = Object.freeze({ ok: 0, stop: 1, usage: 2 });
export const handoffBasename = (slug) => `handoff-${slug}.md`;

// The orientation facts a fresh satellite session cannot derive from its own checkout. They are
// CONSTANTS so the doc-parity registry can pin the mode doc to the exact strings the tool emits.
export const QUEUE_SHARED_RULE =
  'the series index is SHARED and lives ONLY in main: read it at the absolute path above, and never copy it into this worktree, because docs/plans is git-ignored and machine-local, so a copy silently diverges from what main and every other worktree are writing. This worktree never WRITES that file: reaching outside it is an fs_outside_repo action the autonomy policy denies by default. Put new findings in THIS handoff record instead — it is the channel that survives the landing, and main appends them to the index from here';

// The record is LINE-oriented and is parsed back for IDENTITY, so a value carrying a control byte
// is refused rather than written: a newline spills a second line the parser reads as a real field
// (`- include:` is exempt from the duplicate-identity STOP, and an `## …` spill truncates or bricks
// the whole section). Values reach here from the repo ROOT path and from --include, both of which
// may legally carry a newline on POSIX — so the guard is the only thing between them and a forged
// record. U+2028/U+2029 ride the same refusal: they are line terminators to the JS regex `.` but
// not to String.split('\n'), so such a value WRITES fine and is then silently DROPPED on read —
// a lost field with no error, which is the one outcome this codebase never allows.
// Fail closed: refuse to write, never sanitize silently.
// The class is built from a SOURCE STRING rather than a regex literal: the shipped-source guard
// forbids a stray control byte outright, and a string keeps the escapes visible to every scan.
// The range covers C1 (U+0080-U+009F) as well as C0: U+0085 is NEXT LINE and U+009B is the CSI
// introducer, and a value carrying either can forge a line VISUALLY in a terminal even where
// String.split('\n') never sees a break — which is the whole hazard, one surface further out.
const CONTROL_BYTE_CLASS = '[\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029]';
const RECORD_CONTROL_BYTE = new RegExp(CONTROL_BYTE_CLASS);
const CONTROL_BYTE_GLOBAL = new RegExp(CONTROL_BYTE_CLASS, 'g');

// The same class, exposed as a predicate for a consumer that RENDERS rather than writes: the
// cold-start prompt is line-oriented too, so a control byte in any value it interpolates forges a
// line there exactly as it would forge a field here. That consumer must not reuse `recordValue`
// itself — edge whitespace is a record-round-trip hazard, not a rendering one, and a worktree path
// with a trailing space is a legal thing to print.
export const hasControlByte = (value) => RECORD_CONTROL_BYTE.test(String(value));

// And the same class again, for the OTHER thing untrusted text does: a refusal MESSAGE naming the
// value it refused. A STOP is read in the same terminal the prompt is, and it is emitted at the one
// moment the value is known to be hostile — so a diagnostic never repeats such a value raw. Every
// member of the class renders as a visible escape instead of doing what it would do.
export const displayValue = (value) => String(value).replace(
  CONTROL_BYTE_GLOBAL,
  (ch) => `\\u${ch.codePointAt(0).toString(16).padStart(4, '0')}`,
);

export const recordValue = (name, value) => {
  const text = String(value);
  if (RECORD_CONTROL_BYTE.test(text)) {
    throw stop(`handoff record: the ${name} value carries a control character (newline/CR/NUL) — refusing to write a record whose fields could be forged by an injected line`);
  }
  // The parser `.trim()`s every value on read, and String.prototype.trim strips UNICODE whitespace
  // — so an edge space (a Unicode one is legal even in a git branch name) writes fine and reads
  // back as a DIFFERENT identity, stranding the worktree behind a record that no longer matches.
  if (text !== text.trim()) {
    throw stop(`handoff record: the ${name} value carries leading or trailing whitespace, which the record trims on read — the identity would change across a write→read round-trip: ${JSON.stringify(text)}`);
  }
  return text;
};

// An OPTIONAL field is omitted when absent, never rendered as "null": a record written by an
// earlier kit is re-composed from its PARSED form at every refresh (land --prepare), so a field
// that kit never wrote must survive the round-trip as absence, not as a literal null string.
export const optionalField = (name, value) => (value == null ? [] : [`- ${name}: ${recordValue(name, value)}`]);

export const composeProvisionRecordSection = ({ slug, branch, includes, nodeModules, vscode, install = null, sharedQueue = null, landing = null, prepared = null }) => [
  '## Provision record',
  '',
  `- slug: ${recordValue('slug', slug)}`,
  `- branch: ${recordValue('branch', branch)}`,
  ...(includes.length === 0 ? ['- include: (none)'] : includes.map((p) => `- include: ${recordValue('include', p)}`)),
  `- node_modules: ${recordValue('node_modules', nodeModules)}`,
  `- vscode-settings: ${recordValue('vscode-settings', vscode)}`,
  ...optionalField('install', install),
  ...optionalField('shared-queue', sharedQueue),
  ...optionalField('landing', landing),
  ...optionalField('prepared-tree', prepared),
  '',
  // The rule says "at the absolute path above", so it ships only WITH that path: a record from an
  // earlier kit carries no shared-queue field, and a rule pointing at nothing is worse than silence.
  ...(sharedQueue == null ? [] : [QUEUE_SHARED_RULE, '']),
].join('\n');

// The `landing` value's shape, in ONE place: the record composes it and the cold-start prompt
// measures a divergence against it, so a drifting join would report a stale record on every
// prompt for a MAIN that never moved.
export const composeLandingValue = ({ rule, command }) => `${rule} — ${command}`;

export const composeHandoffStub = (fields) => [
  `# Handoff — ${fields.slug}`,
  '',
  'provisioned, nothing done yet',
  '',
  composeProvisionRecordSection(fields),
].join('\n');

const ATX_SECTION_HEADING = /^ {0,3}#{1,2} /;

// Exactly the characters a JS `.` will not cross, which is what makes a field line unmatchable
// rather than merely odd. Built from a source string for the same reason the class above is.
const VANISHING_CLASS = '[\\r\\u2028\\u2029]';
const VANISHING_IN_FIELD = new RegExp(VANISHING_CLASS);
const VANISHING_GLOBAL = new RegExp(VANISHING_CLASS, 'g');

export const locateProvisionRecordSection = (text) => {
  const source = String(text);
  const lines = [...source.matchAll(/.*(?:\r?\n|$)/g)].filter((match) => match[0] !== '');
  const headings = lines.filter((match) => match[0].replace(/\r?\n$/, '').trim() === '## Provision record');
  if (headings.length === 0) throw stop('handoff record: missing required "## Provision record" section');
  if (headings.length > 1) throw stop('handoff record: multiple "## Provision record" sections — the record is ambiguous');
  const start = headings[0].index;
  const nextHeading = lines.find((match) => match.index > start && ATX_SECTION_HEADING.test(match[0].replace(/\r?\n$/, '')));
  return { source, start, end: nextHeading?.index ?? source.length };
};

// ONLY the required section is parsed, so decoy fields elsewhere cannot hijack identity.
// Duplicated single-valued fields are ambiguous identity → typed STOP, never last-wins.
export const parseProvisionRecord = (text) => {
  const section = locateProvisionRecordSection(text);
  const scan = section.source.slice(section.start, section.end).split('\n').slice(1);
  const record = { slug: null, branch: null, includes: [], nodeModules: null, vscode: null, install: null, sharedQueue: null, landing: null, prepared: null };
  const single = {
    slug: 'slug', branch: 'branch', node_modules: 'nodeModules',
    'vscode-settings': 'vscode', 'prepared-tree': 'prepared',
    install: 'install', 'shared-queue': 'sharedQueue', landing: 'landing',
  };
  const seen = new Set();
  for (const line of scan) {
    // The three bytes `.` cannot cross are refused, never skipped: with CR, U+2028 or U+2029 inside
    // a value the match below FAILS, so the field reads back as ABSENT — and absence is a legitimate
    // state (an older kit never wrote the field), which makes the loss silent and lets a consumer
    // report "nothing diverged" about a value it never saw. Every other control byte is matched and
    // carried through, where the WRITE guard and the render guard each refuse it in their own terms.
    if (VANISHING_IN_FIELD.test(line) && /^\s*- [a-z_-]+:/.test(line.replace(VANISHING_GLOBAL, ''))) {
      throw stop(`handoff record: a field line carries a character the record grammar cannot represent, so the field would silently read back as absent: ${displayValue(line)}`);
    }
    const m = line.match(/^- ([a-z_-]+): (.*)$/);
    if (!m) continue;
    const value = m[2].trim();
    if (m[1] === 'include') {
      if (value !== '(none)') record.includes.push(value);
      continue;
    }
    const key = single[m[1]];
    if (!key) continue;
    if (seen.has(m[1])) throw stop(`handoff record: duplicate "${m[1]}" field — the record is ambiguous`);
    seen.add(m[1]);
    record[key] = value;
  }
  return record;
};
