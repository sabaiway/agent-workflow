// labels.mjs — the frozen vocabulary LEAF of the status surface (Plan: One-init-freshness §4.2 B1).
//
// This module owns the internal↔public token vocabulary that used to live inline in
// family-registry.mjs: the manifestState constants, the internal→public state map, the visibility
// map, the short display names, and the no-leak forbidden-term set. It is a LEAF — it imports
// nothing from the family (only the language is here), so the import graph stays acyclic: nobody
// imports family-registry for vocabulary, and family-registry imports + re-exports the public subset
// it exported before (the 7 state constants + DISPLAY_NAMES), so every existing importer stays green.
//
// Pure data, no side effects, Node >= 18. Every export is frozen — this is a contract, not a mutable.

// ── manifestState values (internal; the detect-backends precedence, generalized to any member) ──────
// These are INTERNAL — they must never reach a user surface verbatim (mapped through STATE_PUBLIC
// first). The two surfaces are pinned separately; the no-leak guard (INTERNAL_RENDER_FORBIDDEN) keeps
// the internal literals out of the serialized envelope.
export const NOT_INSTALLED = 'not-installed';
export const UNSUPPORTED_SCHEMA = 'unsupported-schema';
export const INVALID_MANIFEST = 'invalid-manifest';
export const STUB = 'stub';
export const FOREIGN = 'foreign';
export const OK = 'ok';
// The marker could not be probed (a non-ENOENT fs error — EACCES/EIO). Surfaced explicitly instead of
// being masked as not-installed (no silent failure). NOTE: 'unknown' is ALSO a PUBLIC value — it is a
// bridge wrappers[].state ("couldn't check"), so it is deliberately EXCLUDED from the no-leak set.
export const UNKNOWN = 'unknown';

// internal manifestState → a STABLE, user-safe token. SKILL.md owns the value→plain-language phrasing;
// presentation.mjs owns the direct-CLI English phrasing. Deliberately NOT the internal literals
// (foreign/stub/…): those must never leak past this boundary.
export const STATE_PUBLIC = Object.freeze({
  [OK]: 'installed',
  [NOT_INSTALLED]: 'absent',
  [FOREIGN]: 'other-tool',
  [STUB]: 'placeholder',
  [INVALID_MANIFEST]: 'invalid',
  [UNSUPPORTED_SCHEMA]: 'unsupported',
  [UNKNOWN]: 'uncheckable',
});

// visibility: the THREE honest states from inferVisibility → user-safe words. Never the internal
// "hidden fence" / marker terms. ('hidden' here is the PUBLIC visibility word, not the internal fence.)
export const VISIBILITY_PUBLIC = Object.freeze({ visible: 'visible', hidden: 'hidden', ambiguous: 'unclear' });

// ── refresh freshness tokens (PUBLIC — the envelope's installed[].refresh.freshness) ────────────────
// The checked-vs-unknown signal the zero-behind verdict scopes itself with (INV-C): `behind:false`
// alone cannot distinguish "checked, current" from "could not be checked".
//   'current' / 'behind' — a freshness probe RAN and concluded (these two are the "checked" scope);
//   'unknown'            — a probe ran but could not conclude (INV-B: never collapsed to a claim
//                          in either direction);
//   'not-checked'        — no freshness probe exists for this member/state (e.g. the kit itself:
//                          its freshness is the npx installer's axis, never checked here).
export const FRESH_CURRENT = 'current';
export const FRESH_BEHIND = 'behind';
export const FRESH_UNKNOWN = 'unknown';
export const FRESH_NOT_CHECKED = 'not-checked';

// Short, user-facing labels for the version block (kit · memory · engine · codex-bridge · …), so the
// render is deterministic and the agent never invents a label.
export const DISPLAY_NAMES = Object.freeze({
  'agent-workflow-kit': 'kit',
  'agent-workflow-memory': 'memory',
  'agent-workflow-engine': 'engine',
  'codex-cli-bridge': 'codex-bridge',
  'antigravity-cli-bridge': 'antigravity-bridge',
});
export const displayOf = (name) => DISPLAY_NAMES[name] ?? name;

// ── the no-leak forbidden set (Plan §4.3 INV-4) ────────────────────────────────────────────────────
// The terms that must NEVER appear in the serialized buildEnvelope output (the agent reads the JSON
// directly, so the no-leak boundary is the envelope, not just the rendered text). The INV-4 test
// iterates this set over JSON.stringify(envelope). Deliberately EXCLUDES:
//   • 'unknown' — also a PUBLIC bridge wrappers[].state value (a `state:"unknown"` fixture must pass);
//   • 'ok'      — too generic to forbid as a substring, and not sensitive (its public form is 'installed').
// Sourced here as the ONE definition so the guard can't drift from a hand-copied list in the test.
export const INTERNAL_RENDER_FORBIDDEN = Object.freeze([
  // internal manifestState literals that must never reach a surface
  NOT_INSTALLED,
  UNSUPPORTED_SCHEMA,
  INVALID_MANIFEST,
  STUB,
  FOREIGN,
  // internal field names (the structural keys of the surveys, never the envelope)
  'manifestState',
  'hiddenFence',
  // the hidden-mode marker / fence jargon (the SKILL communication firewall) — never the public
  // visibility words ('hidden' / 'visible' / 'unclear'), only the internal compound terms + operations
  'hidden fence',
  'hidden-mode fence',
  'reconcile',
  'ensureSlot',
  // raw deployment-stamp FILENAMES (the envelope exposes member/display/version, never the file)
  '.workflow-version',
  '.memory-version',
]);
