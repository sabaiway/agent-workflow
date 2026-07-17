#!/usr/bin/env node
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
// orchestration-write.mjs, which procedures.mjs never imports, so "procedures never reaches a writer"
// is structurally true. Pure-where-possible (fs injectable), dependency-free, Node >= 22. No side
// effects on import.

import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVITIES, SLOT_RECIPES } from './recipes.mjs';

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
      `invalid recipe "${recipe}" for ${slotType} slot of "${activity}" (${slotType} accepts: ${SLOT_RECIPES[slotType].join(', ')})`,
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
    if (eq <= 0) throw fail(2, `--set must be <activity>.<slot>=<recipe> (got "${token}")`);
    const recipe = token.slice(eq + 1);
    if (!recipe) throw fail(2, `--set must be <activity>.<slot>=<recipe> (got "${token}")`);
    const { activity, slot } = parseQualified(token.slice(0, eq), '--set');
    assertSlotRecipe(activity, slot, recipe);
    return { kind: 'set', activity, slot, recipe };
  }
  if (token.includes('=')) throw fail(2, `--unset takes <activity>.<slot> without a recipe (got "${token}")`);
  const { activity, slot } = parseQualified(token, '--unset');
  assertSlot(activity, slot);
  return { kind: 'unset', activity, slot };
};

// ── config validation (config errors → exit 1) ──────────────────────────────────────

// Validate a parsed orchestration.json object against the schema. Strict: an unknown top-level
// activity, an unknown slot for an activity, or a recipe invalid-for-slot is an error. All slots are
// optional. An optional "_README" string key is allowed + ignored (self-documentation). Never a silent
// fallback — every rejection is a loud `path: reason` (exit 1). Returns the config on success.
export const validateConfig = (config) => {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw fail(1, `${CONFIG_REL}: must be a JSON object of activity → { slot: recipe }`);
  }
  for (const [key, val] of Object.entries(config)) {
    if (key === '_README') {
      if (typeof val !== 'string') throw fail(1, `${CONFIG_REL}: "_README" must be a string`);
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
      if (typeof recipe !== 'string' || !(SLOT_RECIPES[slotType] ?? []).includes(recipe)) {
        throw fail(
          1,
          `${CONFIG_REL}: invalid recipe "${recipe}" for ${slotType} slot of "${key}" (${slotType} accepts: ${SLOT_RECIPES[slotType].join(', ')})`,
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

// ── canonical-refresh (shared by the _README refresh + the injected-slot refresh) ───
// normalizeCanonical: trim + LF-normalize (handles the CRLF / trailing-whitespace trap) so a byte-noisy
// copy of a canonical string still matches. refreshIfCanonical: replace `current` with `next` IFF it
// normalize-equals ANY known prior canonical; otherwise return `current` UNCHANGED (preserve a
// customization). Pure; no fs. Used for the orchestration `_README` and the two injected pointers.

export const normalizeCanonical = (s) => String(s).replace(/\r\n/g, '\n').trim();

export const refreshIfCanonical = (current, knownPriorCanonicals, next) => {
  const cur = normalizeCanonical(current);
  return knownPriorCanonicals.some((prior) => normalizeCanonical(prior) === cur) ? next : current;
};

// ── canonical `_README` (drift-guarded, append-only known-prior set) ─────────────────
// CANON_README is the CURRENT onboarding note — what the templates ship + what a refresh installs. It
// frames hand-edit as a still-available option AND points at the set-recipe writer (no "never written
// for you"). KNOWN_PRIOR_README is the APPEND-ONLY set of every PREVIOUS canonical note: any release
// that changes CANON_README must FIRST append the outgoing string here, so an immediately-previous
// deployment still normalize-matches and gets refreshed (a customized note never matches → preserved).
export const CANON_README =
  "Per-project orchestration config: the recipe used at each step (slot) of each named activity. " +
  "Easiest: tell the agent in plain language and run the `set-recipe` writer — it interprets your intent, " +
  "previews the change, and writes valid JSON for you. You can still hand-edit this file directly whenever you " +
  "prefer; that option never goes away. Each activity is configured independently (e.g. plan-authoring, " +
  "plan-execution), and so is each slot within it. A slot's value is a recipe: a 'review' slot accepts " +
  "solo | reviewed | council (you self-review / one backend reviews / both review and you synthesize); an " +
  "'execute' slot accepts solo | delegated (you implement / a backend runs a bounded sub-task). The default " +
  "below is 'solo' everywhere — no execution backend required. Raise a slot to reviewed or council for a second " +
  "opinion, or to delegated to hand off execution; those need an execution backend set up first. Remove a slot's " +
  "line (or run `set-recipe --unset <activity>.<slot>`) to fall back to the computed default (reviewed when a " +
  "review backend is ready, otherwise solo). Run the read-only procedures advisor to see an activity's steps " +
  "plus the recipe resolved for your environment. Strict JSON — no comments.";

export const KNOWN_PRIOR_README = [
  // v1 (pre-set-recipe) — the "Hand-edit this file — it is never written for you" note. APPEND-ONLY.
  "Per-project orchestration config: the recipe used at each step (slot) of each named activity. Hand-edit this file — it is never written for you. Each activity is configured independently (e.g. plan-authoring, plan-execution), and so is each slot within it. A slot's value is a recipe: a 'review' slot accepts solo | reviewed | council (you self-review / one backend reviews / both review and you synthesize); an 'execute' slot accepts solo | delegated (you implement / a backend runs a bounded sub-task). The default below is 'solo' everywhere — no execution backend required. Raise a slot to reviewed or council for a second opinion, or to delegated to hand off execution; those need an execution backend set up first. Remove a slot's line to fall back to the computed default (reviewed when a review backend is ready, otherwise solo). Run the read-only procedures advisor to see an activity's steps plus the recipe resolved for your environment, and pass a per-run override to change one slot just once. Strict JSON — no comments.",
];

// refreshReadme(config) → { config, changed }: refresh ONLY the `_README` value when it normalize-
// matches a known prior canonical (preserve a customized note untouched); seed it when absent. The
// stamp-independent config-ensure (kit fallback + memory delegated upgrade paths) uses this so an
// install-base deployment gains the new note without a migration file — never clobbering a customization.
export const refreshReadme = (config) => {
  if (config == null || typeof config !== 'object' || Array.isArray(config)) {
    return { config, changed: false };
  }
  const had = config._README;
  const nextReadme = had === undefined ? CANON_README : refreshIfCanonical(had, KNOWN_PRIOR_README, CANON_README);
  if (nextReadme === had) return { config, changed: false };
  const next = { _README: nextReadme };
  for (const [k, v] of Object.entries(config)) {
    if (k !== '_README') next[k] = v;
  }
  return { config: next, changed: true };
};

// The canonical seed file body (what `init` deploys + what serializeConfig round-trips byte-identically).
export const SEED_CONFIG = { _README: CANON_README, 'plan-authoring': { review: 'solo' }, 'plan-execution': { execute: 'solo', review: 'solo' } };
