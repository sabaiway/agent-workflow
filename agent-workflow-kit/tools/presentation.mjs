// presentation.mjs — the frozen ENGLISH/neutral vocabulary the direct-CLI renderers use to draw the
// four status blocks (members · bridges · project deploy/visibility · settings). Plan §4.2.
//
// This is the DIRECT-CLI surface only (`node tools/family-registry.mjs` in a terminal). The
// agent-mediated surface (`/agent-workflow-kit status`) consumes the `--json` envelope and localizes
// in the user's language per SKILL.md §4.4 — it never reads this file. Keeping the vocabulary here (a
// frozen leaf) means the renderers carry no inline strings and the phrasing is pinned by tests.
//
// Pure data, no side effects, Node >= 18. Every export frozen.

// public state token (STATE_PUBLIC value) → the direct-CLI English phrase. `installed` is null because
// an installed member shows its VERSION, not a phrase (the renderer special-cases it). Mirrors the
// SKILL.md value→plain-language map so the two surfaces stay semantically aligned.
export const STATE_PHRASING = Object.freeze({
  installed: null, // → show the version instead
  absent: 'not installed',
  'other-tool': 'a different tool occupies that skill slot',
  placeholder: 'a placeholder, not a working install',
  invalid: "installed but its manifest didn't validate",
  unsupported: 'installed but its manifest schema is too new for this kit',
  uncheckable: "couldn't be checked (a permission error)",
});

// public visibility (VISIBILITY_PUBLIC value) → phrase. Never the internal "fence"/marker terms.
export const VISIBILITY_PHRASING = Object.freeze({
  visible: 'visible (tracked)',
  hidden: 'hidden (git-ignored, local-only)',
  unclear: 'unclear (uncommitted or partially set up)',
});

// Block titles. `project` is a function of the resolved dir.
export const BLOCK_TITLES = Object.freeze({
  members: 'agent-workflow family — installed members (skill axis)',
  bridges: 'execution backends (host)',
  project: (dir) => `project deployment (${dir})`,
  settings: 'settings',
});

// Per-area settings row labels (the left column of the settings block).
export const SETTINGS_LABELS = Object.freeze({
  recipes: 'recipes',
  attribution: 'attribution',
  velocity: 'velocity',
  agents: 'cheap agents',
  hook: 'gate hook',
});

// Glyph sets — Unicode for a capable terminal, an ASCII fallback for a narrow / Windows-legacy one.
// The renderer picks one set by the resolved surface's `ascii` flag (surface.mjs).
export const GLYPHS = Object.freeze({
  unicode: Object.freeze({ note: '↳', present: '✓', missing: '✗', unknown: '?', bullet: '•' }),
  ascii: Object.freeze({ note: '->', present: '+', missing: 'x', unknown: '?', bullet: '*' }),
});
export const glyphsFor = (ascii) => (ascii ? GLYPHS.ascii : GLYPHS.unicode);

// The "no deployment here" line for an undeployed project.
export const NO_DEPLOYMENT = 'no agent-workflow deployment detected here (no docs/ai, no version stamp).';
