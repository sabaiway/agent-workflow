// source-size-config.mjs — the practice's declaration: what docs/ai/source-size.json may say, which
// of its three states it is in, and how it is read back. Nothing here touches the tree.
//
//   • CONFIG STATES — ABSENT (no file) / AUTHORED (authored keys, machine keys absent) / MINTED
//     (machine keys present). A malformed or unknown-keyed config is a loud STOP (exit 2), never a
//     guess, and the template placeholders are REFUSED until replaced, so a printed authoring
//     template can never be pasted into an empty-green scope.
//   • A RECORDED size is debt, not permission: every entry carries a reason, and the reason lands
//     verbatim in the JSON, the commit message and the release CHANGELOG — so it is validated as the
//     single line those three surfaces can carry.
//
// Dependency-free, Node >= 22. No side effects on import.

import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { SOURCE_SIZE_CONFIG_REL, configFail, configPathFor } from './source-size-refusal.mjs';

export const SOURCE_SIZE_SCHEMA = 1;
export const SOURCE_SIZE_DEFAULTS = Object.freeze({ maxLines: 400, maxLineBytes: 1000 });
export const REASON_MAX_BYTES = 300;
// The reason a FIRST mint records: every value is new, so every value is a raise, and "this is what
// the tree already carried when the practice arrived" is the honest sentence for all of them.
export const INITIAL_ADOPTION_REASON = 'initial adoption';

export const AUTHORED_KEYS = Object.freeze(['_README', 'schema', 'defaults', 'roots', 'exclude', 'extensions']);
export const MACHINE_KEYS = Object.freeze(['baseline', 'aggregate']);
const ENTRY_KEYS = Object.freeze(['lines', 'maxLineBytes', 'reason']);

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
  // A root declared twice is not "overlapping itself" by the rule below (the rule compares distinct
  // values), yet it double-counts everywhere a root is ITERATED rather than keyed — the printed
  // delta most visibly, which is the durable record of a regeneration.
  const declaredRoots = new Set();
  for (const root of parsed.roots) {
    if (declaredRoots.has(root)) throw configFail(`"roots" declares "${root}" twice — a duplicated root double-counts its files wherever roots are iterated`);
    declaredRoots.add(root);
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

// loadSourceSizeConfig(cwd) → { state, path, config, parsed, text, missingMachineKeys }. The states:
// ABSENT (no file) / AUTHORED (no machine key) / INCOMPLETE (one machine key without the other — a
// hand-edited half) / MINTED (both). `config` is null only in the ABSENT state; every other state
// carries a fully validated config, INCOMPLETE included: the key that IS there is judged by the same
// rules as ever. `parsed` and `text` are the file as written — the writer copies the authored VALUES
// (and their order) from `parsed`, and compares its own bytes against `text` to know whether it
// actually changed anything.
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
  const present = MACHINE_KEYS.filter((key) => Object.hasOwn(parsed, key));
  // MINTED means the WHOLE machine half. A file carrying one machine key without the other is a
  // state no regenerator produces — it was hand-edited into it — so it is INCOMPLETE and routes to
  // the mint lane, which writes both. Refusing it as a config error would deadlock the only
  // self-service lane, because the regenerator reads its config through this very function.
  const state = present.length === MACHINE_KEYS.length ? 'minted' : present.length === 0 ? 'authored' : 'incomplete';
  return {
    state,
    path,
    config,
    parsed,
    text: raw,
    missingMachineKeys: MACHINE_KEYS.filter((key) => !present.includes(key)),
  };
};
