// Drift guard: the one-line backend-status contract must stay present and consistent across the
// three successful-exit points — bootstrap (step 11), the upgrade already-current exit (step 4),
// and the upgrade full-migration final report (step 8) — all pointing at ONE shared definition.
// It pins the honesty-critical invariants (read-only, never blocks the commit gate, never runs a
// subscription CLI) and the no-silent-failure fallback (detector unavailable → skip WITH a stated
// reason, keyed on "the agent host can't run it", NOT "the project has no Node runtime"), so a
// future SKILL.md edit can't quietly drop the line from an exit or weaken the contract. There is no
// runtime that "executes" SKILL.md prose, so this static text-drift guard is the automatable half of
// the "No changes without tests" Hard Constraint (same pattern as readme-structure / methodology-mirror).
//
// Dev-only repo test (test/ is outside the package `files` whitelist — not shipped in the tarball).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// The canonical one-line summary — the single source of truth lives in the shared block.
const CANONICAL = /backends: codex .* — run \/agent-workflow-kit backends/;

describe('upgrade backend-status — shared one-line contract (drift guard)', () => {
  const shared = flat(between(SKILL, '### The one-line backend-status line', '### Mode: bootstrap'));
  const bootstrap = flat(between(SKILL, '### Mode: bootstrap', '### Mode: upgrade'));
  const upgrade = flat(between(SKILL, '### Mode: upgrade', '### Mode: backends'));

  it('defines the detector, the canonical format, and the pointer once', () => {
    assert.match(shared, /tools\/detect-backends\.mjs/, 'names the backend detector script');
    assert.match(shared, CANONICAL, 'shows the canonical one-line format + the `backends` pointer');
    // Single source of truth: the canonical line appears exactly once in the whole SKILL.md.
    const occurrences = (SKILL.match(new RegExp(CANONICAL.source, 'g')) ?? []).length;
    assert.equal(occurrences, 1, `the canonical backend line must appear once (single source), found ${occurrences}`);
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
