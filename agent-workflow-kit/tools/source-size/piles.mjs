// piles.mjs — a queue row per recorded pile: the piles the layout record holds beyond the entries band,
// each pile's id and two-line row, the queue's own declared checks, the splice into the Later bucket and
// the closed answer the advisor's item and the writer both ask. It writes no file, spawns nothing and
// makes no fs call of its own: every read reaches it through the values its caller hands it.
//
// Dependency-free, Node >= 22. No side effects on import.

import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tokenizeMarkdown } from '../../references/scripts/shared/index.mjs';
import { auditQueue, canonicalHeading, checkQueue } from '../queue-audit.mjs';
import { parseArgv } from '../queue-audit-cli.mjs';
import { bandOf } from './layout.mjs';

export const PILE_ANSWERS = Object.freeze(['none', 'held', 'write']);
export const PILE_HELD = Object.freeze(['key', 'queue', 'bucket', 'check', 'refused']);
export const PILE_QUEUE_REL = 'docs/plans/queue.md';
export const PILE_QUEUE_MAX_BYTES = 8388608;

const QUEUE_CLI = 'queue-audit-cli.mjs';
const ABSENT_CAUSE = 'it is absent';
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const HELD_TEXT = {
  key: (key) => `a recorded pile's directory key holds a backtick or a byte a queue row cannot carry, so no pile row is offered: ${key}`,
  queue: (cause) => `${PILE_QUEUE_REL} cannot take the pile rows, so none is written: ${cause}`,
  bucket: (k) => `the pile rows go to the end of the one heading reading Later or opening with Later after its # run, and ${PILE_QUEUE_REL} holds ${k}`,
  check: (cause) => `the queue's own check in docs/ai/gates.json cannot judge the pile rows, so none is written: ${cause}`,
  refused: (problem, k) => `the queue's own check would refuse the queue with the ${k} pile row(s) added, so none is written: ${problem}`,
};
const held = (reason, ...args) => ({ answer: 'held', reason, text: HELD_TEXT[reason](...args) });

// pilesOf(loaded) → [{ key, entries, value }]: each directory of a minted schema-2 layout record whose
// recorded entries exceed the resolved entries-per-directory value plus its band, in the record's order.
export const pilesOf = (loaded) => {
  const config = loaded?.state === 'minted' ? loaded.config : null;
  if (config === null || config.schema !== 2 || config.layout === null) return [];
  const { value, tolerance } = config.limits['entries-per-directory'];
  return Object.entries(config.layout.directories)
    .filter(([, record]) => Object.hasOwn(record, 'entries') && record.entries > value + bandOf(value, tolerance))
    .map(([key, record]) => ({ key, entries: record.entries, value }));
};

// pileIdOf(key) → PILE-, the key's slug upper-cased, then the first 8 hex digits of its sha256.
export const pileIdOf = (key) => {
  const slug = key.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const hex = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 8).toUpperCase();
  return `PILE-${slug === '' ? '' : `${slug}-`}${hex}`;
};

// pileRowOf(pile) → the row's two lines, joined by one newline.
export const pileRowOf = ({ key, entries, value }) => [
  `- Plan the cleanup of the directory \`${key}\`, whose ${entries} entries the size check records over the limit of ${value}, so its files are laid out by meaning — id ${pileIdOf(key)}`,
  '  - recorded in docs/ai/source-size.json under "layout"."directories"; a regeneration lowers the record as the directory shrinks',
].join('\n');

// The narrow sh subset a gate cmd is read by: bare tokens, or one quoted run each, separated by spaces.
const TOKEN = `[^"\\\\$\`;&|<>()*?\\[\\]{}~#' \\t\\n]+|'[^']*'|"[^"\\\\$\`]*"`;
const CMD_FORM = new RegExp(`^ *(?:(?:${TOKEN})(?: +(?:${TOKEN}))*)? *$`);
const shTokens = (cmd) => {
  if (!CMD_FORM.test(cmd)) return null;
  return [...cmd.matchAll(new RegExp(TOKEN, 'g'))].map(([token]) => (/^['"]/.test(token) ? token.slice(1, -1) : token));
};
const basenameOf = (path) => path.split('/').at(-1);

// queueChecksOf(declaration, root) → { checks: [{ id, path, options }] } | { cause }: the --check gates
// of a loaded declaration whose cmd carries queue-audit-cli.mjs, each read by the sh subset and the
// audit's own parseArgv, its path resolved from the root.
export const queueChecksOf = (declaration, root) => {
  if (declaration.outcome === 'error') return { cause: declaration.message };
  if (declaration.outcome !== 'loaded') return { checks: [] };
  const checks = [];
  for (const { id, cmd } of declaration.gates.filter((gate) => gate.cmd.includes(QUEUE_CLI))) {
    const tokens = shTokens(cmd);
    if (tokens === null || tokens[0] !== 'node' || tokens.length < 2 || basenameOf(tokens[1]) !== QUEUE_CLI) {
      return { cause: `gate ${id} is outside the sh form the advisor reads` };
    }
    let options;
    try {
      options = parseArgv(tokens.slice(2));
    } catch (err) {
      return { cause: `gate ${id}: ${err.message}` };
    }
    if (options.mode === 'check') checks.push({ id, path: resolve(root, options.path), options });
  }
  return { checks };
};

// The headings of a text with their 1-based file lines, frontmatter included.
const headingsOf = (text) => {
  const { headings, frontLines } = tokenizeMarkdown(text, PILE_QUEUE_REL);
  return headings.map((heading) => ({ ...heading, line: frontLines + heading.index + 1 }));
};
const isLater = ({ text }) => {
  const bare = canonicalHeading(text.replace(/^ {0,3}#{1,6}[ \t]+/, ''));
  return bare === 'Later' || bare.startsWith('Later ');
};
const isBlank = (line) => line.trim() === '';

// The bucket's span in file lines: its heading's index and the index of the next heading, or the end.
const bucketSpan = (text, line) => {
  const next = headingsOf(text).find((heading) => heading.line > line);
  return { at: line - 1, end: next === undefined ? text.split('\n').length : next.line - 1, closes: next === undefined };
};

// spliceLater(text, line, rows) → the text with each row at the end of the bucket whose heading is the
// 1-based file line `line`: its trailing blank lines dropped, one blank line before each row and one
// before the next heading; a bucket that closes the file ends it with one newline.
export const spliceLater = (text, line, rows) => {
  const lines = text.split('\n');
  const { at, end, closes } = bucketSpan(text, line);
  const body = lines.slice(at + 1, end);
  while (body.length > 0 && isBlank(body.at(-1))) body.pop();
  const added = rows.flatMap((row) => ['', ...row.split('\n')]);
  const head = [...lines.slice(0, at + 1), ...body, ...added];
  return closes ? `${head.join('\n')}\n` : [...head, '', ...lines.slice(end)].join('\n');
};

// The queue as read, or the cause it cannot take the rows: the lstat walk the writer's containment check
// makes, then the capped no-follow read, the fatal decode, the CR rule and the audit.
const readQueueText = (root, reads) => {
  const parts = PILE_QUEUE_REL.split('/');
  for (let depth = 0; depth <= parts.length; depth += 1) {
    const rel = depth === 0 ? '.' : parts.slice(0, depth).join('/');
    let stat;
    try {
      stat = reads.lstat(depth === 0 ? root : join(root, rel));
    } catch (err) {
      return { cause: err?.code === 'ENOENT' ? ABSENT_CAUSE : String(err?.code ?? err?.message ?? err) };
    }
    if (stat.isSymbolicLink()) return { cause: `${rel} is a symlink` };
  }
  const read = reads.readQueue(join(root, PILE_QUEUE_REL));
  if (read.outcome === 'absent') return { cause: ABSENT_CAUSE };
  if (read.outcome === 'foreign') return { cause: read.className === 'symlink' ? `${PILE_QUEUE_REL} is a symlink` : 'not a regular file' };
  if (read.outcome === 'over-cap') return { cause: `over ${PILE_QUEUE_MAX_BYTES} bytes` };
  if (read.outcome !== 'ok') return { cause: String(read.code) };
  let text;
  try {
    text = FATAL_UTF8.decode(read.bytes);
  } catch {
    return { cause: 'invalid UTF-8' };
  }
  if (text.includes('\r')) return { cause: 'carries CR line endings' };
  try {
    return { text, audit: auditQueue(text, { label: PILE_QUEUE_REL }) };
  } catch (err) {
    return { cause: err.message };
  }
};

// What the composed text fails to carry back, or null: each new id on exactly one live row with no name
// finding whose last bucket is the Later heading, and no byte moved outside the bucket's tail.
const readbackDefect = (text, composed, line, piles, rows) => {
  const before = text.split('\n');
  const after = composed.split('\n');
  const { at, end, closes } = bucketSpan(text, line);
  let keep = end;
  while (keep > at + 1 && isBlank(before[keep - 1])) keep -= 1;
  const tail = closes ? [] : before.slice(end);
  const middle = after.slice(keep, after.length - tail.length);
  const rowLines = new Set(rows.flatMap((row) => row.split('\n')));
  if (after.slice(0, keep).join('\n') !== before.slice(0, keep).join('\n') || after.slice(after.length - tail.length).join('\n') !== tail.join('\n')
    || after.length - tail.length < keep || !middle.every((entry) => isBlank(entry) || rowLines.has(entry))) {
    return 'a byte outside the bucket\'s end would move';
  }
  let audit;
  try {
    audit = auditQueue(composed, { label: PILE_QUEUE_REL });
  } catch (err) {
    return err.message;
  }
  for (const { id } of piles) {
    const carried = audit.rows.filter((row) => row.id === id);
    if (carried.length !== 1) return `${id} is carried by ${carried.length} rows`;
    const [row] = carried;
    if (row.klass !== 'live') return `${id} reads as ${row.klass}`;
    if (row.nameFindings.length > 0) return `${id} has a name finding (${row.nameFindings[0].cause})`;
    if (row.buckets.at(-1)?.line !== line) return `${id} does not sit in the Later bucket`;
  }
  return null;
};

// The first problem a check finds over a text, as { thrown } or { problem }, or null when it accepts.
const judge = (check, text) => {
  try {
    const result = checkQueue(text, { ...check.options, label: PILE_QUEUE_REL });
    return result.ok ? null : { problem: result.problems[0] };
  } catch (err) {
    return { thrown: `gate ${check.id}: ${err.message}` };
  }
};

// pileOfferOf(root, reads, declaration, deps) → { answer: 'none' } | { answer: 'held', reason, text } |
// { answer: 'write', piles, rows, text }. `reads` carries loadSourceSizeConfig, readQueue, realpath,
// lstat, isLineUnsafe and jsonForLine; `declaration` is the gates declaration's answer, or its error.
export const pileOfferOf = (root, reads, declaration, deps = {}) => {
  const piles = pilesOf(reads.loadSourceSizeConfig(root, deps));
  if (piles.length === 0) return { answer: 'none' };
  const unsafe = piles.find(({ key }) => key.includes('`') || reads.isLineUnsafe(key));
  if (unsafe !== undefined) return held('key', reads.jsonForLine(unsafe.key));
  const queue = readQueueText(root, reads);
  if (queue.cause !== undefined) return held('queue', queue.cause);
  const { text, audit } = queue;
  const named = new Set(audit.rows.map((row) => row.id));
  const left = piles.map((pile) => ({ ...pile, id: pileIdOf(pile.key) })).filter(({ id }) => !named.has(id));
  if (left.length === 0) return { answer: 'none' };
  const later = headingsOf(text).filter(isLater);
  if (later.length !== 1) return held('bucket', later.length);
  const found = queueChecksOf(declaration, root);
  if (found.cause !== undefined) return held('check', found.cause);
  const queuePath = join(root, PILE_QUEUE_REL);
  const realOf = (path) => {
    try { return reads.realpath(path); } catch { return null; }
  };
  const queueReal = realOf(queuePath);
  const checks = found.checks.filter((check) => queueReal !== null && realOf(check.path) === queueReal);
  for (const check of checks) {
    const verdict = judge(check, text);
    if (verdict?.thrown !== undefined) return held('check', verdict.thrown);
    if (verdict !== null) return held('queue', `it already fails its own check: ${verdict.problem}`);
  }
  const rows = left.map(pileRowOf);
  const composed = (deps.spliceLater ?? spliceLater)(text, later[0].line, rows);
  if (Buffer.byteLength(composed, 'utf8') > PILE_QUEUE_MAX_BYTES) return held('queue', `over ${PILE_QUEUE_MAX_BYTES} bytes once the rows are added`);
  for (const check of checks) {
    const verdict = judge(check, composed);
    if (verdict?.thrown !== undefined) return held('check', verdict.thrown);
    if (verdict !== null) return held('refused', verdict.problem, rows.length);
  }
  const defect = readbackDefect(text, composed, later[0].line, left, rows);
  if (defect !== null) return held('queue', `the rows would not read back in the Later bucket: ${defect}`);
  return { answer: 'write', piles: left, rows, text: composed };
};
