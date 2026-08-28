// orchestration-config.mjs — the schema / read / pure-transform core for the per-project
// orchestration config (docs/ai/orchestration.json). It is the SINGLE source of the config contract:
//
//   loadConfig / validateConfig / CONFIG_REL   — the strict-JSON reader the READ-ONLY surfaces share
//                                                (procedures.mjs re-exports CONFIG_REL; family-registry
//                                                + procedures import loadConfig from here).
//   parseOp / assertSlotRecipe                  — the TYPED op parser + the ONE slot/recipe validity
//                                                table the set-recipe writer AND procedures --override
//                                                both reuse (drift-guarded: one accept/reject table).
//   applySetOps / serializeConfig               — the PURE merge + the canonical (2-space, _README-first)
//                                                serializer the writer commits.
//   normalizeCanonical / refreshIfCanonical     — the PURE "replace IFF it matches a known prior
//                                                canonical, else preserve a customization" helper shared
//                                                by the _README refresh and the injected-slot refresh.
//
// This module performs NO filesystem WRITES — only reads (loadConfig). The single fs-writer lives in
// orchestration-write.mjs, which procedures.mjs never imports DIRECTLY (the pinned import-split
// rule). It has NO CLI while upgrade.md names it — hence the registered refusal at the foot of the
// file (direct-run.mjs), and no shebang. Fs-injectable, dependency-free, Node >= 22; nothing on import.

import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVITIES, SLOT_RECIPES } from './recipes.mjs';
import { refuseDirectRun } from './direct-run.mjs';
import { validateRoster } from './review-roster.mjs';
import {
  CANON_README,
  KNOWN_PRIOR_README,
  normalizeCanonical,
  refreshIfCanonical,
  refreshReadme,
} from './orchestration-readme.mjs';

export { CANON_README, KNOWN_PRIOR_README, normalizeCanonical, refreshIfCanonical, refreshReadme };

// The hand-editable / agent-writable, per-project config (strict JSON). cwd-relative — the error prefix
// uses this rel path so a user sees a path they can open, never an absolute temp/host path.
export const CONFIG_REL = 'docs/ai/orchestration.json';

// A tagged failure: a plain Error carrying the intended process exit code (2 usage / 1 config). Avoids
// a class (project rule) while letting a CLI main() map a throw to the right code in one place. Shared
// so procedures.mjs + set-recipe.mjs raise identically-typed errors.
export const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

const KNOWN_ACTIVITIES = () => Object.keys(ACTIVITIES).join(', ');

// ── the ONE slot/recipe validity table (shared accept/reject) ───────────────────────
// Both the set-recipe op parser and the procedures --override parser route through these, so the
// accept/reject decision can never drift between the two surfaces (one table, drift-guarded by tests).

// True iff `recipe` is valid for the (activity, slot) pair. Pure predicate; throws nothing.
export const recipeValidForSlot = (activity, slot, recipe) => {
  const slotType = ACTIVITIES[activity]?.slots?.[slot];
  if (!slotType) return false;
  return (SLOT_RECIPES[slotType] ?? []).includes(recipe);
};

// Assert (activity, slot) is a known slot of a known activity; return its recipe-TYPE. Loud (exit 2)
// on an unknown activity or an unknown slot — the shared "unknown slot" message both parsers emit.
export const assertSlot = (activity, slot, exitCode = 2) => {
  const activityDef = ACTIVITIES[activity];
  if (!activityDef) throw fail(exitCode, `unknown activity "${activity}" (known: ${KNOWN_ACTIVITIES()})`);
  const slotType = activityDef.slots[slot];
  if (!slotType) {
    throw fail(
      exitCode,
      `unknown slot "${slot}" for activity "${activity}" (${activity} slots: ${Object.keys(activityDef.slots).join(', ')})`,
    );
  }
  return slotType;
};

// Assert (activity, slot, recipe) is valid — unknown activity/slot OR invalid-recipe-for-slot → loud.
// Used by the set-recipe op parser AND the procedures --override parser, so they accept/reject in
// lockstep. `exitCode` is 2 for both CLIs (usage error); validateConfig reuses it with exitCode 1.
export const assertSlotRecipe = (activity, slot, recipe, exitCode = 2) => {
  const slotType = assertSlot(activity, slot, exitCode);
  if (!(SLOT_RECIPES[slotType] ?? []).includes(recipe)) {
    throw fail(
      exitCode,
      `invalid value "${recipe}" for ${slotType} slot of "${activity}" (${slotType} accepts: ${SLOT_RECIPES[slotType].join(', ')})`,
    );
  }
  return slotType;
};

// ── the typed op parser (usage errors → exit 2) ─────────────────────────────────────
// The grammar is ALWAYS fully-qualified `<activity>.<slot>` — the writer never guesses an activity. A
// bare `review=council` is rejected (name the activity). The kit performs no `all`-magic; the agent
// expands plain language like "both review" into explicit per-activity ops (asking if scope is unclear).

const parseQualified = (lhs, flag) => {
  const dot = lhs.indexOf('.');
  if (dot <= 0 || dot === lhs.length - 1) {
    throw fail(
      2,
      `${flag} must be fully-qualified <activity>.<slot> (got "${lhs}") — name the activity, e.g. plan-authoring.review / plan-execution.review`,
    );
  }
  return { activity: lhs.slice(0, dot), slot: lhs.slice(dot + 1) };
};

// parseOp(kind, token) → a typed record:
//   kind 'set'   + token `<activity>.<slot>=<recipe>` → { kind:'set', activity, slot, recipe }
//   kind 'unset' + token `<activity>.<slot>`          → { kind:'unset', activity, slot }
// Every malformed token is a USAGE error (exit 2): a bare recipe (no activity), an unknown activity /
// slot, an invalid recipe-for-slot, a missing recipe on --set, or a stray recipe on --unset.
export const parseOp = (kind, token) => {
  if (kind === 'set') {
    const eq = token.indexOf('=');
    if (eq <= 0) throw fail(2, `--set must be <activity>.<slot>=<value> (got "${token}")`);
    const recipe = token.slice(eq + 1);
    if (!recipe) throw fail(2, `--set must be <activity>.<slot>=<value> (got "${token}")`);
    const { activity, slot } = parseQualified(token.slice(0, eq), '--set');
    assertSlotRecipe(activity, slot, recipe);
    return { kind: 'set', activity, slot, recipe };
  }
  if (token.includes('=')) throw fail(2, `--unset takes <activity>.<slot> without a value (got "${token}")`);
  const { activity, slot } = parseQualified(token, '--unset');
  assertSlot(activity, slot);
  return { kind: 'unset', activity, slot };
};

// ── config validation (config errors → exit 1) ──────────────────────────────────────

// The accepted `flow` schema version — the SINGLE source both the acceptance check and the refusal
// message use; future flow-aware releases IMPORT this constant, never re-type it. The wire value is
// pinned NUMERIC (the string form is a named refusal case).
export const FLOW_SCHEMA_VERSION = 1;

// The honest lagging-kit contract sentence: what a kit WITHOUT the flow branch does when it meets
// a `flow` block, and what the now-armed `set-flow` floor can and cannot reach. doc-parity binds
// it VERBATIM into the procedures and set-flow mode docs, so the admission can never be reworded
// away: no in-config floor protects a reader that dies on the unknown key itself.
export const FLOW_LAGGING_KIT_CONTRACT =
  'a kit predating the `"flow"` key that reads a config carrying one fails this config load loudly (exit `1`, reddening its full gate matrix); the `set-flow` arming path now enforces the declared `kitMinVersion` floor with a null-guarded comparison (an unparseable version never passes), while tolerate-first ordering remains the only protection for readers older than the `"flow"` key itself — no in-config floor can reach a kit that dies on the unknown key';

// ── the closed flow schema-1 surface (P20) — ONE literal fixture for BOTH consumers ─────
// The structural validator below and the set-flow arming path (Phase 3) walk the SAME closed key
// set; a drift-guarded named test validates the literal fixture. Shape-only here (#31): every
// environment floor (tracked-ness, symlink/dir classes, the kit min-version comparison) lives
// exclusively on the arming path.

export const FLOW_SCHEMA_1_KEYS = Object.freeze([
  'schema', 'preset', 'candidates', 'councilRounds', 'debtQueue', 'convergenceSummary',
  'debtQueueExcluded', 'convergenceSummaryExcluded', 'pregateExclude', 'kitMinVersion',
]);
export const FLOW_PRESET_VALUES = Object.freeze(['council', 'reviewed', 'internal-only']);
export const FLOW_CANDIDATE_CLASSES = Object.freeze(['review', 'execution']);
// The arming path (set-flow, Phase 3) compares kitMinVersion via the null-guarded semver shape
// characterized in the FLOW-VERSION-FLOORS block of semver-lite.test.mjs (Decision 6).
export const FLOW_MIN_VERSION_COMPARISON = 'semver-lite null-guarded comparison (FLOW-VERSION-FLOORS characterization)';
export const FLOW_SCHEMA_1_FIXTURE = Object.freeze({
  schema: FLOW_SCHEMA_VERSION,
  preset: 'council',
  candidates: Object.freeze([
    Object.freeze({ name: 'codex', class: 'review' }),
    Object.freeze({ name: 'agy', class: 'review' }),
  ]),
  councilRounds: 3,
  debtQueue: 'docs/debt.md',
  convergenceSummary: 'docs/convergence.md',
  debtQueueExcluded: false,
  convergenceSummaryExcluded: false,
  pregateExclude: Object.freeze([]),
  kitMinVersion: '5.1.0',
});

// The per-key STRUCTURAL checks of the schema-1 flow block (P7/P20) — shape only, loud
// `path: reason`; every environment floor lives on the set-flow arming path (#31). A failure
// message, or null when the value fits the key's shape.
const flowKeyFailure = (key, value) => {
  if (key === 'preset') {
    return FLOW_PRESET_VALUES.includes(value) ? null : `must be one of ${FLOW_PRESET_VALUES.join(' | ')} (got ${JSON.stringify(value)})`;
  }
  if (key === 'candidates') {
    if (!Array.isArray(value)) return 'must be an array of typed { name, class } objects (#30)';
    for (const c of value) {
      if (c === null || typeof c !== 'object' || Array.isArray(c)) return 'must hold only { name, class } objects';
      const stray = Object.keys(c).find((k) => k !== 'name' && k !== 'class');
      if (stray !== undefined) return `candidate objects carry exactly { name, class } — unknown field "${stray}"`;
      if (typeof c.name !== 'string' || c.name === '') return 'every candidate name must be a non-empty string';
      if (!FLOW_CANDIDATE_CLASSES.includes(c.class)) return `every candidate class must be one of ${FLOW_CANDIDATE_CLASSES.join(' | ')} (got ${JSON.stringify(c.class)})`;
    }
    return null;
  }
  if (key === 'councilRounds') {
    return Number.isInteger(value) && value >= 1 ? null : `must be a positive integer — the #45 refresh-cap source (got ${JSON.stringify(value)})`;
  }
  if (key === 'debtQueue' || key === 'convergenceSummary') {
    return typeof value === 'string' && value.length > 0 ? null : `must be a non-empty repo-relative path string (got ${JSON.stringify(value)})`;
  }
  if (key === 'debtQueueExcluded' || key === 'convergenceSummaryExcluded') {
    return typeof value === 'boolean' ? null : `must be a boolean (the declared-excluded form, #31/#37; got ${JSON.stringify(value)})`;
  }
  if (key === 'pregateExclude') {
    if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && id.length > 0)) {
      return `must be an array of non-empty gate-id strings (#47; got ${JSON.stringify(value)})`;
    }
    return new Set(value).size === value.length ? null : 'must not carry duplicate gate ids (#47)';
  }
  if (key === 'kitMinVersion') {
    return typeof value === 'string' && value.length > 0 ? null : `must be a non-empty version string — the #54 floor, compared on the arming path via the ${FLOW_MIN_VERSION_COMPARISON} (got ${JSON.stringify(value)})`;
  }
  return null; // schema — checked before the key walk
};

// Validate a parsed orchestration.json object against the schema. Strict: an unknown top-level
// activity, an unknown slot for an activity, or a recipe invalid-for-slot is an error. All slots are
// optional. An optional "_README" string key is allowed + ignored (self-documentation). The
// versioned "flow" object key validates against the FULL structural schema-1 surface (closed key
// set + per-key shapes — P7/P20); deep environment floors stay on the set-flow arming path (#31).
// Never a silent fallback — every rejection is a loud `path: reason` (exit 1). Returns the config on success.
export const validateConfig = (config) => {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw fail(1, `${CONFIG_REL}: must be a JSON object of activity → { slot: recipe }`);
  }
  for (const [key, val] of Object.entries(config)) {
    if (key === '_README') {
      if (typeof val !== 'string') throw fail(1, `${CONFIG_REL}: "_README" must be a string`);
      continue;
    }
    if (key === 'flow') {
      if (val === null || typeof val !== 'object' || Array.isArray(val)) {
        throw fail(1, `${CONFIG_REL}: "flow" must be a JSON object carrying { "schema": ${FLOW_SCHEMA_VERSION} }`);
      }
      if (val.schema !== FLOW_SCHEMA_VERSION) {
        const got = 'schema' in val ? JSON.stringify(val.schema) : 'absent';
        throw fail(1, `${CONFIG_REL}: "flow".schema must be the number ${FLOW_SCHEMA_VERSION} (got ${got})`);
      }
      for (const [flowKey, flowValue] of Object.entries(val)) {
        if (!FLOW_SCHEMA_1_KEYS.includes(flowKey)) {
          throw fail(1, `${CONFIG_REL}: "flow" carries unknown key "${flowKey}" — the schema-1 key set is closed (${FLOW_SCHEMA_1_KEYS.join(', ')})`);
        }
        const failure = flowKeyFailure(flowKey, flowValue);
        if (failure !== null) throw fail(1, `${CONFIG_REL}: "flow".${flowKey} ${failure}`);
      }
      continue;
    }
    const activityDef = ACTIVITIES[key];
    if (!activityDef) {
      throw fail(1, `${CONFIG_REL}: unknown activity "${key}" (known: ${KNOWN_ACTIVITIES()})`);
    }
    if (val === null || typeof val !== 'object' || Array.isArray(val)) {
      throw fail(1, `${CONFIG_REL}: activity "${key}" must be a JSON object of slot → recipe`);
    }
    for (const [slot, recipe] of Object.entries(val)) {
      const slotType = activityDef.slots[slot];
      if (!slotType) {
        throw fail(
          1,
          `${CONFIG_REL}: unknown slot "${slot}" for activity "${key}" (${key} slots: ${Object.keys(activityDef.slots).join(', ')})`,
        );
      }
      if (Array.isArray(recipe) && slotType === 'review') {
        try {
          validateRoster(recipe);
        } catch (error) {
          throw fail(1, `${CONFIG_REL}: invalid review roster for "${key}.${slot}" (${error.message})`);
        }
        continue;
      }
      if (typeof recipe !== 'string' || !(SLOT_RECIPES[slotType] ?? []).includes(recipe)) {
        throw fail(
          1,
          `${CONFIG_REL}: invalid value ${JSON.stringify(recipe)} for ${slotType} slot of "${key}" (${slotType} accepts: ${SLOT_RECIPES[slotType].join(', ')})`,
        );
      }
    }
  }
  return config;
};

// ── config IO (config errors → exit 1) ──────────────────────────────────────────────

// Load + validate the config from <cwd>/docs/ai/orchestration.json. Absent FILE → computed defaults
// (NOT an error): { config: null, source: 'none' }. Malformed JSON / schema-invalid / unreadable →
// loud `path: reason` (exit 1). The read-only status survey + procedures + the set-recipe writer all
// reuse THIS reader — one strict-JSON + loud-on-malformed contract, no second drifting implementation.
export const loadConfig = (cwd, readFile = readFileSync, lstat = lstatSync) => {
  const full = join(cwd, CONFIG_REL);
  // Distinguish a TRULY-absent config (no entry at all → computed defaults) from a present-but-
  // unreadable one (a directory, a DANGLING SYMLINK, a permission error → loud exit 1). lstat does NOT
  // follow the link, so a dangling symlink reads as "present" here and its later read failure surfaces
  // loudly — never silently treated as absent (no-silent-failures Hard Constraint).
  try {
    lstat(full);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { config: null, source: 'none' };
    throw fail(1, `${CONFIG_REL}: unreadable (${(err && err.code) || (err && err.message) || err})`);
  }
  let raw;
  try {
    raw = readFile(full, 'utf8');
  } catch (err) {
    throw fail(1, `${CONFIG_REL}: unreadable (${(err && err.code) || (err && err.message) || err})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw fail(1, `${CONFIG_REL}: malformed JSON (${err.message})`);
  }
  return { config: validateConfig(parsed), source: CONFIG_REL };
};

// ── pure merge + canonical serialization ────────────────────────────────────────────

// A pure deep-equal over the JSON-ish config shape (plain objects + string values). Used only for the
// "did anything actually change?" decision (no-op detection + seed-on-change), never for output.
const deepEqual = (a, b) => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
};

// applySetOps(currentConfig, ops, { seedReadme }) → the merged config. PURE: deep-clones `current`
// (or {}), applies each set/unset, preserves `_README` + every untouched activity/slot, drops an
// activity that an unset empties (sparse), then re-runs validateConfig (loud on invalid — defensive;
// the op parser pre-validates). When (and ONLY when) the merge CHANGES the config, `_README` is absent,
// and `seedReadme` is supplied, the canonical note is seeded — so a no-op set never spuriously seeds it.
export const applySetOps = (currentConfig, ops, { seedReadme = null } = {}) => {
  const base = currentConfig == null ? {} : structuredClone(currentConfig);
  const next = structuredClone(base);
  for (const op of ops) {
    if (op.kind === 'set') {
      next[op.activity] = { ...(next[op.activity] ?? {}) };
      next[op.activity][op.slot] = op.recipe;
    } else {
      if (next[op.activity] && op.slot in next[op.activity]) {
        const rest = { ...next[op.activity] };
        delete rest[op.slot];
        if (Object.keys(rest).length === 0) delete next[op.activity];
        else next[op.activity] = rest;
      }
    }
  }
  validateConfig(next);
  const changed = !deepEqual(next, base);
  if (changed && seedReadme != null && next._README === undefined) next._README = seedReadme;
  return next;
};

// serializeConfig(config) → strict JSON, 2-space, trailing newline, `_README` FIRST (explicitly, so the
// onboarding note never sinks below the activities). This is the canonical on-disk form: a touched
// write normalizes to it (content-preserving, NOT byte-preserving of arbitrary hand-formatting).
export const serializeConfig = (config) => {
  const ordered = {};
  if (config._README !== undefined) ordered._README = config._README;
  for (const [k, v] of Object.entries(config)) {
    if (k !== '_README') ordered[k] = v;
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
};

// The canonical seed file body (what `init` deploys + what serializeConfig round-trips byte-identically).
export const SEED_CONFIG = { _README: CANON_README, 'plan-authoring': { review: 'solo' }, 'plan-execution': { execute: 'solo', review: 'solo' } };

refuseDirectRun(import.meta.url);
