// Drift guard: the one-line backend-status contract across the three successful-exit points —
// bootstrap (step 11), the upgrade already-current exit (step 4), and the upgrade full-migration
// final report (step 8) — all pointing at ONE shared definition.
//
// The line is MACHINE-COMPOSED now (deterministic-first): the agent runs
// `tools/recipes.mjs --status-line` and pastes the single emitted line verbatim. SKILL.md carries
// only an explicitly-placeholder template — the realistic canonical example is GONE (a session once
// echoed it verbatim while the detector said both backends were ready: example contamination). This
// guard pins:
//   (1) the shared region names the composer invocation + the paste-verbatim instruction;
//   (2) the template is placeholder-only (no realistic alias+readiness pair anywhere in the region)
//       and appears exactly once in the whole SKILL.md (single source);
//   (3) composer⟷SKILL: every fixed skeleton fragment of composeStatusLine's output appears
//       verbatim in the region — DERIVED from the composer with sentinel variables (the AD-033
//       deep-equal shape), never a hand-copied string, and non-vacuous by construction;
//   (4) the honesty invariants + the composer-unavailable skip stay keyed on the AGENT HOST with a
//       stated reason (no silent skip);
//   (5) both upgrade exits + bootstrap still print the line.
// There is no runtime that "executes" SKILL.md prose, so this static text-drift guard is the
// automatable half of the "No changes without tests" Hard Constraint.
//
// Dev-only repo test (test/ is outside the package `files` whitelist — not shipped in the tarball).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeStatusLine, DISPLAY_ALIASES } from '../tools/recipes.mjs';

// agent-workflow-kit/test → agent-workflow-kit
const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = readFileSync(resolve(kitRoot, 'SKILL.md'), 'utf8');

// Slice the text between two headings (to = end-of-file when omitted).
const between = (text, from, to) => {
  const a = text.indexOf(from);
  assert.notEqual(a, -1, `SKILL.md is missing the heading: "${from}"`);
  const b = to ? text.indexOf(to, a + from.length) : text.length;
  assert.notEqual(b, -1, `SKILL.md is missing the heading: "${to}"`);
  return text.slice(a, b);
};

// Collapse all whitespace so assertions survive source re-wrapping (the contract wraps across lines).
const flat = (s) => s.replace(/\s+/g, ' ');

// The tight shared-definition region (the template + invariants live here, before the version block).
const shared = flat(between(SKILL, '### The one-line backend-status line', '### The version block + welcome mat'));
const bootstrap = flat(between(SKILL, '### Mode: bootstrap', '### Mode: upgrade'));
const upgrade = flat(between(SKILL, '### Mode: upgrade', '### Mode: backends'));

describe('backend-status line — machine-composed, paste-verbatim (deterministic-first)', () => {
  it('names the composer invocation and the paste-verbatim instruction once, in the shared region', () => {
    assert.match(shared, /tools\/recipes\.mjs --status-line/, 'names the composer flag');
    assert.match(shared, /paste its single emitted line verbatim/i, 'the paste-verbatim instruction');
    assert.match(shared, /composes nothing factual/i, 'the agent composes nothing factual');
    assert.ok(!shared.includes('tools/detect-backends.mjs'), 'the agent no longer drives the raw detector here');
  });

  it('carries a placeholder-only template, exactly once in the whole SKILL.md', () => {
    assert.match(shared, /never copy this example/i, 'the template is explicitly a placeholder');
    const TEMPLATE = /backends: <alias>/g;
    const occurrences = (flat(SKILL).match(TEMPLATE) ?? []).length;
    assert.equal(occurrences, 1, `the placeholder template must appear exactly once (single source), found ${occurrences}`);
    // Non-vacuous: the template line is made of <placeholder> tokens, not real values.
    const placeholders = (shared.match(/<[^>]+>/g) ?? []).length;
    assert.ok(placeholders >= 4, `expected >=4 <placeholder> tokens in the region, found ${placeholders}`);
  });

  it('the region contains NO realistic alias+readiness example to contaminate a session (the closed defect class)', () => {
    for (const alias of Object.values(DISPLAY_ALIASES)) {
      assert.ok(!new RegExp(`${alias} [✓✗]`).test(shared), `realistic example leaks: "${alias} ✓/✗ …"`);
    }
    assert.ok(!/antigravity [✓✗]/.test(shared), 'the old canonical example ("antigravity ✗ …") must stay gone');
    assert.ok(!/[✓✗] (ready|needs-|degraded)/.test(shared), 'no glyph+readiness pair outside a placeholder');
  });

  it('composer⟷SKILL: every fixed skeleton fragment of composeStatusLine appears in the template (AD-033 deep-equal shape)', () => {
    // Derive the fixed skeleton FROM the composer, never a hand-copied string: compose with sentinel
    // variables, strip them (and the alias/glyph variables) out — what remains is the fixed skeleton
    // the SKILL template must carry verbatim.
    const detection = [
      { name: 'codex-cli-bridge', readiness: 'SENTINEL_R1' },
      { name: 'antigravity-cli-bridge', readiness: 'SENTINEL_R2' },
    ];
    const line = composeStatusLine(detection, { clause: 'SENTINEL_CLAUSE' });
    const variables = ['SENTINEL_R1', 'SENTINEL_R2', 'SENTINEL_CLAUSE', ...Object.values(DISPLAY_ALIASES), '✓', '✗'];
    const fragments = variables
      .reduce((parts, v) => parts.flatMap((p) => p.split(v)), [line])
      .map((f) => f.trim())
      .filter((f) => f.length >= 3);
    assert.ok(fragments.length >= 3, 'the skeleton derivation is non-vacuous');
    for (const fragment of fragments) {
      assert.ok(shared.includes(fragment), `SKILL template misses the composer skeleton fragment "${fragment}"`);
    }
    // Both glyphs the composer can emit are named inside the template's placeholder.
    assert.ok(shared.includes('✓') && shared.includes('✗'), 'the template names both readiness glyphs');
  });

  it('the recipes clause is appended after the backends pointer and is never blank', () => {
    assert.match(shared, /recipes:/, 'the appended clause is prefixed "recipes:"');
    assert.match(shared, /\/agent-workflow-kit recipes/, 'the clause routes to the read-only recipes surface');
    assert.match(shared, /never blank/i);
    assert.match(shared, /Solo/, 'the none-installed recommendation names Solo');
    assert.match(shared, /\/agent-workflow-kit setup/, 'the none-installed recommendation points at setup');
    assert.match(shared, /recommendRecipe/, 'the clause source is the tool, named');
  });

  it('pins the read-only / non-blocking invariants', () => {
    assert.match(shared, /read-only/i);
    assert.match(shared, /never blocks the commit gate/i);
    assert.match(shared, /never runs a subscription CLI/i);
    assert.match(shared, /in-agent .backends. mode/i, 'the pointer is the in-agent backends mode');
    assert.match(shared, /never a network fetch/i);
  });

  it('pins the no-silent-failure fallback, keyed on the AGENT HOST (not the project Node runtime)', () => {
    assert.match(shared, /agent host/i, 'the runner is the agent host, not the target project');
    assert.match(shared, /not.{0,6}the project has no Node runtime/i, 'explicitly excludes the wrong condition');
    assert.match(shared, /never a silent skip/i, 'a skip is always reported');
    assert.match(shared, /reason/i, 'the skip states a concrete reason');
  });

  it('every successful upgrade exit prints the backend-status line', () => {
    const hits = (upgrade.match(/backend-status line/g) ?? []).length;
    assert.ok(hits >= 2, `expected the backend-status line at the two upgrade exits (>=2), found ${hits}`);
    // The already-current exit is a real success report, not a bare short-circuit stop.
    assert.match(upgrade, /Equal-head exit — a real successful-exit report/);
    // The full-migration final report prints it before the commit gate.
    assert.match(upgrade, /Re-stamp.*backend-status line.*ask before committing/);
  });

  it('bootstrap step 11 prints the same backend-status line (shared contract)', () => {
    assert.match(bootstrap, /backend-status line/);
  });
});
