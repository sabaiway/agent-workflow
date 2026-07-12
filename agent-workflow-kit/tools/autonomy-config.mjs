#!/usr/bin/env node
// autonomy-config.mjs — the schema / read / pure-transform core for the per-project autonomy policy
// (docs/ai/autonomy.json). It is the SINGLE source of the policy contract, mirroring
// orchestration-config.mjs structurally (AD-044):
//
//   loadAutonomy / validateAutonomy / AUTONOMY_REL — the strict-JSON reader the read-only surfaces
//                                                    share (the Claude render imports loadAutonomy).
//   parseAutonomyOp / assertAutonomyAssignment      — the TYPED op parser + the ONE section/key/value
//                                                    validity table the set-autonomy writer reuses
//                                                    (drift-guarded: one accept/reject grammar).
//   applyAutonomyOps / serializeAutonomy            — the PURE merge + the canonical (2-space,
//                                                    _README-first) serializer the writer commits.
//   resolveAutonomy                                 — the pure computed-defaults resolver (sparse →
//                                                    effective policy); the render + any future read
//                                                    surface share this ONE resolver.
//
// This module performs NO filesystem WRITES — only reads (loadAutonomy). The single fs-writer lives in
// autonomy-write.mjs, which no read-only module imports, so the read surface stays fs-write-free.
// Pure-where-possible (fs injectable), dependency-free, Node >= 18. No side effects on import.

import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVITIES } from './recipes.mjs';

// The hand-editable / agent-writable, per-project policy (strict JSON). cwd-relative — the error prefix
// uses this rel path so a user sees a path they can open, never an absolute temp/host path.
export const AUTONOMY_REL = 'docs/ai/autonomy.json';

// A tagged failure: a plain Error carrying the intended process exit code (2 usage / 1 config). Avoids
// a class (project rule) while letting a CLI main() map a throw to the right code in one place. Shared
// so set-autonomy.mjs raises identically-typed errors (mirrors orchestration-config.mjs `fail`).
export const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

// ── the grammar tables (Decision 5) — the ONE shared accept/reject data ──────────────
// Both validateAutonomy and parseAutonomyOp read THESE tables (never a second hand-copy), so the
// accept/reject decision can never drift between config-validation and the writer's op parser (pinned
// by the full-matrix drift test, the orchestration recipeValidForSlot precedent).

// The six red-lines split into command red-lines (commit/push/publish) and non-command red-lines
// (network/credentials/fs_outside_repo). Both take `ask` or `deny`; only the Decision-4 DEFAULT differs.
export const COMMAND_REDLINES = Object.freeze(['commit', 'push', 'publish']);
export const NONCOMMAND_REDLINES = Object.freeze(['network', 'credentials', 'fs_outside_repo']);
export const REDLINE_KEYS = Object.freeze([...COMMAND_REDLINES, ...NONCOMMAND_REDLINES]);
export const REDLINE_VALUES = Object.freeze(['ask', 'deny']);
// Decision 4 defaults: command red-lines default to `ask` (commit stays the human checkpoint), the
// non-command red-lines default to `deny` (network/credentials/fs escape are the conservative floor).
export const REDLINE_DEFAULTS = Object.freeze({
  commit: 'ask', push: 'ask', publish: 'ask',
  network: 'deny', credentials: 'deny', fs_outside_repo: 'deny',
});

// Per-activity autonomy level (Decision 2): `sandbox` ⇒ auto-allow + acceptEdits; `prompt` ⇒
// conservative prompting (sandbox still confines). An absent activity floors at `prompt` (Decision 5).
export const AUTONOMY_LEVELS = Object.freeze(['sandbox', 'prompt']);
export const DEFAULT_ACTIVITY_AUTONOMY = 'prompt';
export const ACTIVITY_KEY = 'autonomy';
export const REDLINES_SECTION = 'redlines';

const KNOWN_ACTIVITIES = () => Object.keys(ACTIVITIES).join(', ');
const KNOWN_SECTIONS = () => `${REDLINES_SECTION}, ${KNOWN_ACTIVITIES()}`;
const isJsonObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ── the ONE section/key/value validity grammar (shared accept/reject) ────────────────
// assignmentValid is the PURE predicate (mirror recipeValidForSlot) the full-matrix drift test pins;
// assertAutonomySlot / assertAutonomyAssignment are the LOUD assertions the op parser uses. All read
// the same tables above, so parseAutonomyOp and validateAutonomy can never disagree.

// True iff (section, key) is a known slot of the policy (redlines.<redline> | <activity>.autonomy).
export const slotValid = (section, key) => {
  if (section === REDLINES_SECTION) return REDLINE_KEYS.includes(key);
  if (ACTIVITIES[section]) return key === ACTIVITY_KEY;
  return false;
};

// Accepted values for a KNOWN slot: red-lines take ask|deny; an activity's autonomy takes sandbox|prompt.
export const acceptedValuesFor = (section) => (section === REDLINES_SECTION ? REDLINE_VALUES : AUTONOMY_LEVELS);

// True iff (section, key, value) is a fully-valid assignment. Pure predicate; throws nothing.
export const assignmentValid = (section, key, value) =>
  slotValid(section, key) && acceptedValuesFor(section).includes(value);

// Assert (section, key) is a known slot; return its kind ('redline' | 'activity'). Loud (exit 2 by
// default) with the shared "unknown section" / "unknown slot" message the op parser emits.
export const assertAutonomySlot = (section, key, exitCode = 2) => {
  if (section === REDLINES_SECTION) {
    if (!REDLINE_KEYS.includes(key)) {
      throw fail(exitCode, `unknown red-line "${key}" (known: ${REDLINE_KEYS.join(', ')})`);
    }
    return 'redline';
  }
  if (ACTIVITIES[section]) {
    if (key !== ACTIVITY_KEY) {
      throw fail(exitCode, `unknown key "${key}" for activity "${section}" (only: ${ACTIVITY_KEY})`);
    }
    return 'activity';
  }
  throw fail(exitCode, `unknown section "${section}" (known: ${KNOWN_SECTIONS()})`);
};

// Assert (section, key, value) is a fully-valid assignment — unknown section/key OR bad value → loud.
// Used by the set-autonomy op parser AND (with exitCode 1) by validateAutonomy, so they accept/reject
// in lockstep on ONE grammar. Returns the slot kind.
export const assertAutonomyAssignment = (section, key, value, exitCode = 2) => {
  const kind = assertAutonomySlot(section, key, exitCode);
  const accepted = acceptedValuesFor(section);
  if (typeof value !== 'string' || !accepted.includes(value)) {
    throw fail(exitCode, `invalid value "${value}" for ${section}.${key} (accepts: ${accepted.join(', ')})`);
  }
  return kind;
};

// ── the typed op parser (usage errors → exit 2) ─────────────────────────────────────
// The grammar is ALWAYS fully-qualified `<section>.<key>` — the writer never guesses a section. A bare
// `commit=ask` is rejected (name the section). No `all`-magic; the agent expands plain language into
// explicit per-key ops (asking if scope is unclear) — the set-recipe division of labor.

const parseQualified = (lhs, flag) => {
  const dot = lhs.indexOf('.');
  if (dot <= 0 || dot === lhs.length - 1) {
    throw fail(
      2,
      `${flag} must be fully-qualified <section>.<key> (got "${lhs}") — name the section, e.g. redlines.commit / plan-execution.autonomy`,
    );
  }
  return { section: lhs.slice(0, dot), key: lhs.slice(dot + 1) };
};

// parseAutonomyOp(kind, token) → a typed record:
//   kind 'set'   + token `<section>.<key>=<value>` → { kind:'set', section, key, value }
//   kind 'unset' + token `<section>.<key>`         → { kind:'unset', section, key }
// Every malformed token is a USAGE error (exit 2): a bare key (no section), an unknown section/key, a
// bad value, a missing value on --set, or a stray value on --unset.
export const parseAutonomyOp = (kind, token) => {
  if (kind === 'set') {
    const eq = token.indexOf('=');
    if (eq <= 0) throw fail(2, `--set must be <section>.<key>=<value> (got "${token}")`);
    const value = token.slice(eq + 1);
    if (!value) throw fail(2, `--set must be <section>.<key>=<value> (got "${token}")`);
    const { section, key } = parseQualified(token.slice(0, eq), '--set');
    assertAutonomyAssignment(section, key, value);
    return { kind: 'set', section, key, value };
  }
  if (token.includes('=')) throw fail(2, `--unset takes <section>.<key> without a value (got "${token}")`);
  const { section, key } = parseQualified(token, '--unset');
  assertAutonomySlot(section, key);
  return { kind: 'unset', section, key };
};

// ── policy validation (config errors → exit 1) ──────────────────────────────────────

// Validate a parsed autonomy.json object against the Decision-5 grammar. Strict: an unknown top-level
// key, an unknown red-line, an unknown activity/key, or a bad value is an error. All keys optional
// (sparse). An optional "_README" string key is allowed + ignored. Never a silent fallback — every
// rejection is a loud `path: reason` (exit 1). Returns the config on success.
export const validateAutonomy = (config) => {
  if (!isJsonObject(config)) {
    throw fail(1, `${AUTONOMY_REL}: must be a JSON object (red-lines + per-activity autonomy)`);
  }
  for (const [key, val] of Object.entries(config)) {
    if (key === '_README') {
      if (typeof val !== 'string') throw fail(1, `${AUTONOMY_REL}: "_README" must be a string`);
      continue;
    }
    if (key === REDLINES_SECTION) {
      if (!isJsonObject(val)) throw fail(1, `${AUTONOMY_REL}: "${REDLINES_SECTION}" must be a JSON object of red-line → ask|deny`);
      for (const [rk, rv] of Object.entries(val)) {
        try {
          assertAutonomyAssignment(REDLINES_SECTION, rk, rv, 1);
        } catch (err) {
          throw fail(1, `${AUTONOMY_REL}: ${err.message}`);
        }
      }
      continue;
    }
    if (ACTIVITIES[key]) {
      if (!isJsonObject(val)) throw fail(1, `${AUTONOMY_REL}: activity "${key}" must be a JSON object of { ${ACTIVITY_KEY}: sandbox|prompt }`);
      for (const [ak, av] of Object.entries(val)) {
        try {
          assertAutonomyAssignment(key, ak, av, 1);
        } catch (err) {
          throw fail(1, `${AUTONOMY_REL}: ${err.message}`);
        }
      }
      continue;
    }
    throw fail(1, `${AUTONOMY_REL}: unknown top-level key "${key}" (known: _README, ${KNOWN_SECTIONS()})`);
  }
  return config;
};

// ── policy IO (config errors → exit 1) ──────────────────────────────────────────────

// Load + validate the policy from <cwd>/docs/ai/autonomy.json. Absent FILE → computed defaults (NOT an
// error): { config: null, source: 'none' }. Malformed JSON / schema-invalid / unreadable → loud
// `path: reason` (exit 1). lstat (NOT existsSync) so a DANGLING SYMLINK reads as present and its later
// read failure surfaces loudly — never silently treated as absent (no-silent-failures Hard Constraint).
export const loadAutonomy = (cwd, readFile = readFileSync, lstat = lstatSync) => {
  const full = join(cwd, AUTONOMY_REL);
  try {
    lstat(full);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { config: null, source: 'none' };
    throw fail(1, `${AUTONOMY_REL}: unreadable (${(err && err.code) || (err && err.message) || err})`);
  }
  let raw;
  try {
    raw = readFile(full, 'utf8');
  } catch (err) {
    throw fail(1, `${AUTONOMY_REL}: unreadable (${(err && err.code) || (err && err.message) || err})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw fail(1, `${AUTONOMY_REL}: malformed JSON (${err.message})`);
  }
  return { config: validateAutonomy(parsed), source: AUTONOMY_REL };
};

// ── the pure computed-defaults resolver ─────────────────────────────────────────────

// resolveAutonomy(config) → the effective policy: every red-line resolved to its config value or its
// Decision-4 default; every ACTIVITIES entry resolved to its config autonomy or `prompt`. The render +
// any future read surface share THIS resolver, so a sparse policy always yields one full effective
// policy (no key ever undefined). Pure; accepts null (absent file → all defaults).
export const resolveAutonomy = (config) => {
  const cfg = isJsonObject(config) ? config : {};
  const rl = isJsonObject(cfg[REDLINES_SECTION]) ? cfg[REDLINES_SECTION] : {};
  const redlines = {};
  for (const k of REDLINE_KEYS) redlines[k] = rl[k] ?? REDLINE_DEFAULTS[k];
  const activities = {};
  for (const a of Object.keys(ACTIVITIES)) {
    const entry = isJsonObject(cfg[a]) ? cfg[a] : {};
    activities[a] = { [ACTIVITY_KEY]: entry[ACTIVITY_KEY] ?? DEFAULT_ACTIVITY_AUTONOMY };
  }
  return { redlines, activities };
};

// isSparseSeedConfig(config) → true when the policy file is STRUCTURALLY the deploy seed: meta keys
// only (`_README` today) — no red-lines section, no activity entry. Seed detection must be
// structural, never resolved-equality: an EXPLICIT policy that declares exactly the default values
// is a real DECLARATION (its render — the red-line ask rules included — must not be suppressed as
// "just the seed"), while the seed declares nothing (codex, Segment B closing). Shared by every
// autonomy read surface (advisor / recipes / procedures / grounding) so the four can never diverge.
export const isSparseSeedConfig = (config) =>
  isJsonObject(config) && Object.keys(config).every((k) => k.startsWith('_'));

// ── pure merge + canonical serialization ────────────────────────────────────────────

// A pure deep-equal over the JSON-ish policy shape (plain objects + string values). Used only for the
// "did anything actually change?" decision (no-op detection + seed-on-change), never for output.
const deepEqual = (a, b) => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
};

// applyAutonomyOps(current, ops, { seedReadme }) → the merged policy. PURE: deep-clones `current` (or
// {}), applies each set/unset, preserves `_README` + every untouched section/key, drops a section that
// an unset empties (sparse), then re-runs validateAutonomy (loud on invalid — defensive; the op parser
// pre-validates). When (and ONLY when) the merge CHANGES the policy, `_README` is absent, and
// `seedReadme` is supplied, the canonical note is seeded — so a no-op set never spuriously seeds it.
export const applyAutonomyOps = (current, ops, { seedReadme = null } = {}) => {
  const base = current == null ? {} : structuredClone(current);
  const next = structuredClone(base);
  for (const op of ops) {
    if (op.kind === 'set') {
      next[op.section] = { ...(next[op.section] ?? {}) };
      next[op.section][op.key] = op.value;
    } else if (next[op.section] && op.key in next[op.section]) {
      const rest = { ...next[op.section] };
      delete rest[op.key];
      if (Object.keys(rest).length === 0) delete next[op.section];
      else next[op.section] = rest;
    }
  }
  validateAutonomy(next);
  const changed = !deepEqual(next, base);
  if (changed && seedReadme != null && next._README === undefined) next._README = seedReadme;
  return next;
};

// serializeAutonomy(config) → strict JSON, 2-space, trailing newline, `_README` FIRST (explicitly, so
// the onboarding note never sinks below the policy). This is the canonical on-disk form: a touched
// write normalizes to it (content-preserving, NOT byte-preserving of arbitrary hand-formatting).
export const serializeAutonomy = (config) => {
  const ordered = {};
  if (config._README !== undefined) ordered._README = config._README;
  for (const [k, v] of Object.entries(config)) {
    if (k !== '_README') ordered[k] = v;
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
};

// ── the canonical seed (Decision 5) ──────────────────────────────────────────────────
// AUTONOMY_README is the onboarding note; SEED_AUTONOMY is the Decision-5 fixture the set-autonomy
// WRITER seeds (opinionated sandbox levels) and the config tests copy/validate verbatim. DISTINCT
// from the Plan-4 deploy template `references/templates/autonomy.json` (bootstrap/upgrade ensure):
// that seed is SPARSE — `_README` only, defaults-equivalent by the template-parity pin
// (resolveAutonomy(template) ≡ resolveAutonomy(null)) — so deploying it never changes behavior.
export const AUTONOMY_README =
  'Per-project autonomy policy: red-lines (always) + per-activity autonomy level. Hand-editable; or ' +
  'use the set-autonomy writer (previews, then writes valid JSON). Strict JSON — no comments.';

export const SEED_AUTONOMY = {
  _README: AUTONOMY_README,
  redlines: {
    commit: 'ask', push: 'ask', publish: 'ask',
    network: 'deny', credentials: 'deny', fs_outside_repo: 'deny',
  },
  'plan-authoring': { autonomy: 'sandbox' },
  'plan-execution': { autonomy: 'sandbox' },
};
