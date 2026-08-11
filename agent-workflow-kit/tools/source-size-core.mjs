// source-size-core.mjs — the PURE READ core of the source-size practice (D-18). Config load +
// validation, the declared-scope and counting rules, and the canonical gate-cmd matcher. Imported by
// source-size-check.mjs (the CLI + writer half) and by the read surfaces that must ask about the
// practice without reaching a writer; it owns NO write API and spawns only a read-only git query, so
// the read-graph purity suite (test/read-graph-purity.test.mjs) stays true.
//
// The contracts this module owns, each pinned by a named test rather than by this comment:
//   • CONFIG STATES — ABSENT (no file) / AUTHORED (authored keys, machine keys absent) / MINTED
//     (machine keys present). A malformed or unknown-keyed config is a loud STOP (exit 2), never a
//     guess, and the template placeholders are REFUSED until replaced, so a printed authoring
//     template can never be pasted into an empty-green scope.
//   • SCOPE (D-6, fail-closed) — git-tracked files under a declared root carrying a declared
//     extension, minus the excluded path-segment prefixes. Symlinks and submodule gitlinks are
//     skipped BY KIND. An unmerged index, a non-UTF-8 in-scope FILENAME, an unverifiable in-scope
//     file and an empty declared scope are REFUSALS (exit 1); a failed enumeration is exit 2. The
//     enumeration is NUL-delimited and every path test runs on BYTES, so a tracked path carrying a
//     tab or a newline is judged byte-exactly instead of being mangled by line splitting.
//   • COUNTING (D-7) — lines, and the longest line in BYTES. Terminators never count, CR included.
//
// Dependency-free, Node >= 22. No side effects on import.

import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SOURCE_SIZE_CONFIG_REL = 'docs/ai/source-size.json';
export const SOURCE_SIZE_SCHEMA = 1;
export const SOURCE_SIZE_DEFAULTS = Object.freeze({ maxLines: 400, maxLineBytes: 1000 });
export const REASON_MAX_BYTES = 300;

// Every refusal names the config of the project it actually judged, absolute: with a foreign or
// relative --cwd a repo-relative name points at whatever directory the reader happens to be in.
export const configPathFor = (cwd) => resolve(cwd, 'docs', 'ai', 'source-size.json');

export const AUTHORED_KEYS = Object.freeze(['_README', 'schema', 'defaults', 'roots', 'exclude', 'extensions']);
export const MACHINE_KEYS = Object.freeze(['baseline', 'aggregate']);
const ENTRY_KEYS = Object.freeze(['lines', 'maxLineBytes', 'reason']);

export const SOURCE_SIZE_STOP = 'SOURCE_SIZE_STOP';
const stopWith = (exitCode) => (message) =>
  Object.assign(new Error(`[agent-workflow-kit] ${message}`), { code: SOURCE_SIZE_STOP, exitCode });
// exit 2 = the inputs are unusable (usage, config, enumeration); exit 1 = the tree is judged and refused.
export const configFail = stopWith(2);
export const scopeFail = stopWith(1);

const LF = 0x0a;
const CR = 0x0d;
const TAB = 0x09;
const SLASH = 0x2f;

// ── config validation ─────────────────────────────────────────────────────────────────────────────

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// A template placeholder — the authoring refusal prints angle-bracketed values on purpose so the
// printed file is INERT until a human replaces them; the validator is what makes that promise true.
const PLACEHOLDER_RE = /^<.*>$/;
const BAD_SEGMENTS = new Set(['', '.', '..']);

// Written by code point rather than as a regex class: a source file that carries literal control
// bytes reads as BINARY to every scanner in the family, which is the very class the tarball guard
// exists to catch.
const hasControlByte = (text) => [...text].some((ch) => {
  const code = ch.codePointAt(0);
  return code < 0x20 || code === 0x7f;
});

const declaredPathDefect = (value, what) => {
  if (typeof value !== 'string' || value.length === 0) return `${what} must be a non-empty string`;
  if (PLACEHOLDER_RE.test(value)) {
    return `${what} still carries the authoring placeholder ${value} — replace it with a real value; the practice never guesses its own scope`;
  }
  if (isAbsolute(value) || value.startsWith('/')) return `${what} "${value}" must be repo-relative, never absolute`;
  if (value.split('/').some((s) => BAD_SEGMENTS.has(s))) return `${what} "${value}" must carry no empty, "." or ".." path segment`;
  return null;
};

const extensionDefect = (value) => {
  if (typeof value !== 'string' || value.length === 0) return 'an "extensions" entry must be a non-empty string';
  if (PLACEHOLDER_RE.test(value)) {
    return `an "extensions" entry still carries the authoring placeholder ${value} — replace it with a real extension; the kit ships NO default file-type list, because a fixed one silently exempts every unlisted language`;
  }
  if (!value.startsWith('.') || value.length < 2 || value.includes('/')) {
    return `an "extensions" entry must look like ".mjs", got ${JSON.stringify(value)}`;
  }
  return null;
};

const positiveIntDefect = (value, what) =>
  Number.isSafeInteger(value) && value > 0 ? null : `${what} must be a positive integer, got ${JSON.stringify(value)}`;

const nonNegativeIntDefect = (value, what) =>
  Number.isSafeInteger(value) && value >= 0 ? null : `${what} must be a non-negative integer, got ${JSON.stringify(value)}`;

// A reason lands VERBATIM in the JSON entry, the commit message and the release CHANGELOG, so it is
// a single line under a byte cap — an empty, multiline or control-byte reason is refused (D-3a).
export const reasonDefect = (reason) => {
  if (typeof reason !== 'string' || reason.length === 0) return 'a reason must be a non-empty string';
  if (hasControlByte(reason)) {
    return 'a reason must be ONE line with no control bytes (it is copied verbatim into JSON, the commit message and the CHANGELOG)';
  }
  const bytes = Buffer.byteLength(reason, 'utf8');
  if (bytes > REASON_MAX_BYTES) return `a reason must be at most ${REASON_MAX_BYTES} UTF-8 bytes, got ${bytes}`;
  return null;
};

// Whole-segment prefix containment: "a/b" contains "a/b" and "a/b/c", never "a/bc".
export const segmentPrefixOf = (prefix, path) => path === prefix || path.startsWith(`${prefix}/`);

// `requiredDimensions: 'any'` — a per-file record may pin EITHER dimension or both, because only the
// dimension that actually violated should be recorded: an entry pinning a dimension that was never
// over the cap makes the ratchet refuse later changes nobody chose. `'lines'` — a root budget has
// exactly one dimension, so it is required there.
const validateEntryMap = (map, what, requiredDimensions, extra) => {
  if (!isPlainObject(map)) throw configFail(`"${what}" must be an object`);
  for (const [key, entry] of Object.entries(map)) {
    if (!isPlainObject(entry)) throw configFail(`"${what}"."${key}" must be an object`);
    const unknown = Object.keys(entry).filter((k) => !ENTRY_KEYS.includes(k));
    if (unknown.length > 0) throw configFail(`"${what}"."${key}" carries unknown key(s): ${unknown.join(', ')}`);
    for (const dimension of ['lines', 'maxLineBytes']) {
      if (!Object.hasOwn(entry, dimension)) continue;
      const defect = nonNegativeIntDefect(entry[dimension], `"${what}"."${key}".${dimension}`);
      if (defect) throw configFail(defect);
    }
    if (requiredDimensions === 'lines' && !Object.hasOwn(entry, 'lines')) {
      throw configFail(nonNegativeIntDefect(entry.lines, `"${what}"."${key}".lines`));
    }
    if (requiredDimensions === 'any' && !Object.hasOwn(entry, 'lines') && !Object.hasOwn(entry, 'maxLineBytes')) {
      throw configFail(`"${what}"."${key}" must record at least one of "lines" or "maxLineBytes" — an entry that pins no dimension records nothing`);
    }
    const reason = reasonDefect(entry.reason);
    if (reason) throw configFail(`"${what}"."${key}".reason: ${reason}`);
    if (extra) extra(key, entry);
  }
};

// validateSourceSizeConfig(parsed) → the normalized config. THROWS configFail (exit 2) on anything it
// cannot judge — an unknown key included, because a typo'd key would otherwise disarm a rule.
export const validateSourceSizeConfig = (parsed) => {
  if (!isPlainObject(parsed)) throw configFail(`${SOURCE_SIZE_CONFIG_REL} must contain a JSON object`);
  const known = new Set([...AUTHORED_KEYS, ...MACHINE_KEYS]);
  const unknown = Object.keys(parsed).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw configFail(`${SOURCE_SIZE_CONFIG_REL} carries unknown key(s): ${unknown.join(', ')} — known keys are ${[...known].join(', ')}`);
  }
  if (parsed.schema !== SOURCE_SIZE_SCHEMA) {
    throw configFail(`"schema" must be ${SOURCE_SIZE_SCHEMA}, got ${JSON.stringify(parsed.schema)}`);
  }
  if (!isPlainObject(parsed.defaults)) throw configFail('"defaults" must be an object carrying maxLines and maxLineBytes');
  const unknownDefaults = Object.keys(parsed.defaults).filter((k) => !['maxLines', 'maxLineBytes'].includes(k));
  if (unknownDefaults.length > 0) throw configFail(`"defaults" carries unknown key(s): ${unknownDefaults.join(', ')}`);
  for (const key of ['maxLines', 'maxLineBytes']) {
    const defect = positiveIntDefect(parsed.defaults[key], `"defaults".${key}`);
    if (defect) throw configFail(defect);
  }
  for (const key of ['roots', 'extensions']) {
    if (!Array.isArray(parsed[key]) || parsed[key].length === 0) {
      throw configFail(`"${key}" must be a non-empty array — scope is DECLARED, never guessed, so an empty "${key}" is a misdeclaration rather than an empty green`);
    }
    for (const value of parsed[key]) {
      const defect = key === 'roots' ? declaredPathDefect(value, 'a "roots" entry') : extensionDefect(value);
      if (defect) throw configFail(defect);
    }
  }
  for (const outer of parsed.roots) {
    for (const inner of parsed.roots) {
      if (outer !== inner && segmentPrefixOf(outer, inner)) {
        throw configFail(`"roots" entries overlap: "${inner}" sits inside "${outer}" — an overlapping root double-counts its files in the aggregate`);
      }
    }
  }
  if (Object.hasOwn(parsed, 'exclude')) {
    if (!Array.isArray(parsed.exclude)) throw configFail('"exclude" must be an array of literal path prefixes');
    for (const value of parsed.exclude) {
      const defect = declaredPathDefect(value, 'an "exclude" entry');
      if (defect) throw configFail(defect);
    }
  }
  if (Object.hasOwn(parsed, 'baseline')) {
    validateEntryMap(parsed.baseline, 'baseline', 'any', (key) => {
      const defect = declaredPathDefect(key, 'a "baseline" key');
      if (defect) throw configFail(defect);
    });
  }
  if (Object.hasOwn(parsed, 'aggregate')) {
    validateEntryMap(parsed.aggregate, 'aggregate', 'lines', (key, entry) => {
      if (Object.hasOwn(entry, 'maxLineBytes')) {
        throw configFail(`"aggregate"."${key}" carries maxLineBytes — the aggregate budgets LINES only; summing per-file longest-line bytes has no meaning as a budget`);
      }
    });
  }
  return {
    schema: parsed.schema,
    defaults: { ...parsed.defaults },
    roots: [...parsed.roots],
    exclude: Object.hasOwn(parsed, 'exclude') ? [...parsed.exclude] : [],
    extensions: [...parsed.extensions],
    baseline: Object.hasOwn(parsed, 'baseline') ? { ...parsed.baseline } : null,
    aggregate: Object.hasOwn(parsed, 'aggregate') ? { ...parsed.aggregate } : null,
  };
};

// loadSourceSizeConfig(cwd) → { state: 'absent' | 'authored' | 'minted', path, config }. `config` is
// null only in the ABSENT state; both other states carry a fully validated config.
export const loadSourceSizeConfig = (cwd, deps = {}) => {
  const read = deps.readFile ?? readFileSync;
  const path = configPathFor(cwd);
  let raw;
  try {
    raw = read(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'absent', path, config: null };
    throw configFail(`${path} could not be read (${err.message})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw configFail(`${path} is not valid JSON (${err.message}) — fix it by hand; a malformed config is a STOP, never a guess`);
  }
  const config = validateSourceSizeConfig(parsed);
  const state = MACHINE_KEYS.some((k) => Object.hasOwn(parsed, k)) ? 'minted' : 'authored';
  return { state, path, config };
};

// ── scope (D-6) ───────────────────────────────────────────────────────────────────────────────────

const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const SYMLINK_MODE = '120000';
const GITLINK_MODE = '160000';

// Raw bytes in, raw bytes out: `ls-files -s -z` emits mode, object and stage, then a TAB, then the
// path, then a NUL — and the path half is never decoded before it has been matched, so a name
// carrying a tab or a newline survives intact (splitting on lines would mangle it).
const parseIndexEntries = (buf) => {
  const entries = [];
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0, start);
    if (end === -1) end = buf.length;
    const record = buf.subarray(start, end);
    const tab = record.indexOf(TAB);
    if (tab !== -1) {
      const head = record.subarray(0, tab).toString('utf8').split(' ');
      entries.push({ mode: head[0], stage: Number(head[2]), path: record.subarray(tab + 1) });
    }
    start = end + 1;
  }
  return entries;
};

// A path whose bytes are not valid UTF-8 round-trips to something DIFFERENT (the replacement char is
// lossy) — that is the whole test, and it is exact.
const decodeStrict = (buf) => {
  const text = buf.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buf) ? text : null;
};

const bufSegmentPrefix = (path, prefix) =>
  path.length >= prefix.length &&
  path.subarray(0, prefix.length).equals(prefix) &&
  (path.length === prefix.length || path[prefix.length] === SLASH);

const bufEndsWith = (path, suffix) =>
  path.length >= suffix.length && path.subarray(path.length - suffix.length).equals(suffix);

export const enumerateIndex = (cwd, deps = {}) => {
  const spawn = deps.spawn ?? spawnSync;
  const result = spawn('git', ['ls-files', '-s', '-z'], { cwd, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
  if (result.error || result.status !== 0) {
    const why = result.error ? result.error.message : `git exited ${result.status}`;
    throw configFail(`the git index could not be enumerated in ${cwd} (${why}) — the declared scope is unknown, so nothing is judged`);
  }
  return parseIndexEntries(result.stdout);
};

// resolveScope(cwd, config) → { files: [rel…] sorted, perRoot: Map<root, [rel…]>, emptyRoots: [root…] }.
// Every exclusion is BY RULE (root / extension / exclude prefix) or BY KIND (symlink, gitlink); an
// in-scope path that cannot be addressed losslessly is a refusal, never a quiet skip.
export const resolveScope = (cwd, config, deps = {}) => {
  const entries = enumerateIndex(cwd, deps);
  const unmerged = entries.filter((e) => e.stage !== 0);
  if (unmerged.length > 0) {
    throw scopeFail(`the git index is UNMERGED (${unmerged.length} conflict-stage entr(ies)) — an ambiguous index cannot be judged; resolve the conflict, then re-run`);
  }
  const roots = config.roots.map((rel) => ({ rel, buf: Buffer.from(rel, 'utf8') }));
  const excludes = config.exclude.map((rel) => Buffer.from(rel, 'utf8'));
  const extensions = config.extensions.map((ext) => Buffer.from(ext, 'utf8'));
  const perRoot = new Map(config.roots.map((rel) => [rel, []]));
  const files = [];
  for (const entry of entries) {
    const root = roots.find((r) => bufSegmentPrefix(entry.path, r.buf));
    if (!root) continue;
    if (!extensions.some((ext) => bufEndsWith(entry.path, ext))) continue;
    if (excludes.some((ex) => bufSegmentPrefix(entry.path, ex))) continue;
    if (entry.mode === SYMLINK_MODE || entry.mode === GITLINK_MODE) continue;
    const rel = decodeStrict(entry.path);
    if (rel === null) {
      throw scopeFail(`an in-scope tracked path's NAME is not valid UTF-8 (bytes ${entry.path.toString('hex')}) — it cannot be addressed losslessly, so nothing is judged; rename it, or add its prefix to "exclude" in ${configPathFor(cwd)}`);
    }
    files.push(rel);
    perRoot.get(root.rel).push(rel);
  }
  if (files.length === 0) {
    throw scopeFail(`the declared scope matches ZERO tracked files (roots: ${config.roots.join(', ')}; extensions: ${config.extensions.join(', ')}) — an empty scope is a misdeclaration, never an empty green; either widen "roots" / "extensions" in ${configPathFor(cwd)}, or track a file the declared scope covers`);
  }
  files.sort();
  for (const list of perRoot.values()) list.sort();
  return { files, perRoot, emptyRoots: [...perRoot].filter(([, list]) => list.length === 0).map(([rel]) => rel) };
};

// ── counting (D-7) ────────────────────────────────────────────────────────────────────────────────

// countBytes(buf) → { lines, maxLineBytes }. A terminator never counts (the CR of a CRLF included);
// a last line with no final newline still counts; an empty file is 0 lines.
export const countBytes = (buf) => {
  let lines = 0;
  let maxLineBytes = 0;
  let start = 0;
  const widen = (from, to) => {
    lines += 1;
    if (to - from > maxLineBytes) maxLineBytes = to - from;
  };
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== LF) continue;
    widen(start, i > start && buf[i - 1] === CR ? i - 1 : i);
    start = i + 1;
  }
  if (start < buf.length) widen(start, buf.length);
  return { lines, maxLineBytes };
};

// measureFile(cwd, rel) → { lines, maxLineBytes }. The judged bytes are the WORKTREE bytes of an
// index-visible path; an in-scope file the checker cannot verify is exit 1 naming the exclude lane,
// never a silent or green skip.
export const measureFile = (cwd, rel, deps = {}) => {
  const read = deps.readFile ?? readFileSync;
  let buf;
  try {
    buf = read(join(cwd, rel));
  } catch (err) {
    throw scopeFail(`${rel}: in-scope but unverifiable (${err.message}) — a file the checker cannot read is never a silent skip; fix it, or add its prefix to "exclude" in ${configPathFor(cwd)}`);
  }
  if (decodeStrict(buf) === null) {
    throw scopeFail(`${rel}: in-scope but not valid UTF-8 — its size cannot be judged; add its prefix to "exclude" in ${configPathFor(cwd)}`);
  }
  return countBytes(buf);
};

// ── the canonical gate-cmd matcher ────────────────────────────────────────────────────────────────

// Mirrors the SHAPE of the review-dependent matcher (gates-declaration.mjs) without joining either of
// its arrays: this gate is neither a final core check nor review-dependent. STRICT full command —
// `node` + ONE (quoted or bare) path token + the exact basename + ` --check` + END — and the token
// must realpath-resolve to THIS kit's own checker, so an id squatter never matches.
//
// Separators are PLAIN SPACES, not \s: a newline between the tokens is not a command a runner would
// execute as written. The token is screened by the rules of the quoting it actually carries, because
// the two halves are interpreted differently and a single screen would be wrong for one of them:
//   • QUOTED — double quotes survive most bytes, so only what breaks OUT of them is refused.
//   • BARE   — anything the shell may split, expand or glob makes the executed command different
//              from the string, so a bare token is admitted only from a known-safe alphabet.
// Either way the point is the same: a path that resolves literally here while the shell would read
// it differently must never be called canonical, or the matcher certifies a command that never runs.
export const dqUnsafePath = (text) => [...text].some((ch) => {
  const code = ch.codePointAt(0);
  return ch === '"' || ch === '$' || code === 96 || code === 92 || code === 13 || code === 10;
});

// Stated as the bytes the shell ACTS on, not as an alphabet of blessed ones: an allow-list refuses
// perfectly ordinary paths (`@`, `+`, `,`, `%`, `=`, anything non-ASCII) that the shell passes
// through verbatim, and refusing a command that really is canonical is its own defect. Whitespace
// and ASCII control bytes are refused too — a bare token cannot contain them and still be one token.
const SHELL_ACTIVE_BARE = new Set([...'"\'\\$|&;<>(){}[]*?!#~^`']);
const bareTokenSafe = (text) => text.length > 0 && ![...text].some((ch) => {
  const code = ch.codePointAt(0);
  return code <= 0x20 || code === 0x7f || SHELL_ACTIVE_BARE.has(ch);
});

const CHECK_CMD_RE = /^node +(?:"((?:[^"]*[/\\])?source-size-check\.mjs)"|((?:[^\s"]*[/\\])?source-size-check\.mjs)) +--check$/;
export const SOURCE_SIZE_GATE_ID = 'source-size';
export const SOURCE_SIZE_TOOL_PATH = fileURLToPath(new URL('./source-size-check.mjs', import.meta.url));

export const matchesSourceSizeGate = (cmd, projectDir) => {
  if (typeof cmd !== 'string') return false;
  const match = CHECK_CMD_RE.exec(cmd.trim());
  if (!match) return false;
  const token = match[1] ?? match[2];
  const admissible = match[1] !== undefined ? !dqUnsafePath(token) : bareTokenSafe(token);
  if (!admissible) return false;
  const abs = isAbsolute(token) ? token : join(projectDir, token);
  try {
    return realpathSync(abs) === realpathSync(SOURCE_SIZE_TOOL_PATH);
  } catch {
    return false; // unresolvable → never canonical (fail closed)
  }
};
