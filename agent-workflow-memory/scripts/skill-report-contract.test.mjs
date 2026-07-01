// Contract guard for the memory substrate's REPORT surface (the "humanize the deploy/version report"
// change, memory half). The internal `docs/ai` structure version (`.memory-version` = `LINEAGE_HEAD`)
// is un-actionable in the happy path; this static text-drift guard pins the acceptance invariants
// A1/A4/A5/A6 over the SKILL.md prose STRUCTURE (never a conversational-language string) so a future
// edit can't re-leak the number where it is inert, or drop it where it is actionable. Memory has NO
// status mode (the one intended kit↔memory asymmetry), so the number surfaces only at the STOP gate +
// on an explicit user ask. There is no runtime that "executes" SKILL.md prose, so this is the
// automatable half of "No changes without tests" for a prose-contract change.
//
// Lives under scripts/ so the repo gate's memory test glob (scripts/*.test.mjs) runs it; scripts/ is
// inside the package `files` whitelist, but this *.test.mjs is a dev-only guard (same pattern as the
// sibling stamp-takeover.test.mjs / standalone-bootstrap.test.mjs).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/ → package root
const memRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = readFileSync(resolve(memRoot, 'SKILL.md'), 'utf8');

const between = (text, from, to) => {
  const a = text.indexOf(from);
  assert.notEqual(a, -1, `SKILL.md is missing the anchor: "${from}"`);
  const b = to ? text.indexOf(to, a + from.length) : text.length;
  assert.notEqual(b, -1, `SKILL.md is missing the anchor: "${to}"`);
  return text.slice(a, b);
};
const flat = (s) => s.replace(/\s+/g, ' ');

const SEMVER = /\b\d+\.\d+\.\d+\b/;
const STAMP_PATH = /\.memory-version/;
const TWO_AXES_COMPARISON = /\bnpm\b/i;
const STRUCTURE_NAME = /docs\/ai` structure version/;

// ── Regions ────────────────────────────────────────────────────────────────
const upgrade = between(SKILL, '### Mode: upgrade', '## Version disclosure');
const equalHead = flat(between(upgrade, '**Then**, if the stamp **equals** the head', '3. Show the relevant'));
const stopGate = flat(between(upgrade, 'STOP and report immediately', 'Otherwise (stamp'));
const step7 = flat(between(upgrade, '7. **Re-stamp**', ''));
const disclosure = flat(between(SKILL, '## Version disclosure', '## Gotchas'));
const bootstrap = between(SKILL, '### Mode: bootstrap', '### Mode: upgrade');
const step11 = flat(between(bootstrap, '11. **Report & ask.**', '> **Delegated mode'));

describe('memory report contract — the happy path hides the docs/ai structure number (A1)', () => {
  it('the equal-head exit hides the number and distinguishes a writeful reconcile from a no-op', () => {
    assert.doesNotMatch(equalHead, SEMVER, 'no version number on the equal-head exit');
    assert.doesNotMatch(equalHead, STAMP_PATH, 'no .memory-version path on the happy-path exit');
    assert.doesNotMatch(equalHead, TWO_AXES_COMPARISON, 'no two-axes note on the equal-head exit');
    assert.doesNotMatch(equalHead, /deployment-lineage head/i);
    // A footprint move / config seed is a writeful change — not "no update needed".
    assert.match(equalHead, /changed something.{0,80}what changed/i, 'a writeful reconcile reports what changed');
    assert.match(equalHead, /nothing changed at all.{0,40}settings are already current/i,
      'only a pure no-op is framed "settings already current"');
  });
  it('the standalone bootstrap report does not surface a structure number', () => {
    assert.doesNotMatch(step11, SEMVER, 'bootstrap step 11 prints no version number');
    assert.doesNotMatch(step11, STAMP_PATH, 'bootstrap step 11 prints no stamp path');
    assert.match(step11, /no `docs\/ai` structure number/i, 'bootstrap step 11 explicitly states no structure number');
  });
});

describe('memory report contract — a migration that ran is described in human terms (A4)', () => {
  it('step 7 re-stamp reports in plain human terms and OMITS the raw number', () => {
    assert.match(step7, /plain human terms/i);
    assert.match(step7, /\bomit the raw structure number/i);
    assert.doesNotMatch(step7, /may omit the raw structure number/i, 'omission is mandatory, not optional');
    assert.match(step7, /atomic write.*mechanics unchanged/i, 'the atomic stamp-WRITE mechanics are preserved');
  });
});

describe('memory report contract — the STOP gate keeps the number + a plain two-axes note (A5)', () => {
  it('the never-downgrade STOP shows the number, the two-axes note, and never labels it "lineage head"', () => {
    assert.match(stopGate, STRUCTURE_NAME, 'the STOP shows the docs/ai structure version');
    assert.match(stopGate, /two-axes note/i);
    assert.match(stopGate, /never.{0,20}"?lineage head"?/i);
  });
});

describe('memory report contract — on-demand disclosure, no status mode, gotcha preserved (A6)', () => {
  it('Version disclosure names it "docs/ai structure version" and gates it to STOP + explicit ask', () => {
    assert.match(disclosure, STRUCTURE_NAME);
    assert.match(disclosure, /never.{0,4}"?lineage head"?/i, 'forbids the "lineage head" label');
    assert.match(disclosure, /no status mode/i, 'documents the no-status-mode asymmetry');
    assert.match(disclosure, /never-downgrade STOP/i, 'surface 1: the STOP gate');
    assert.match(disclosure, /user explicitly asks/i, 'surface 2: the explicit user ask');
    assert.match(disclosure, /read-only/i, 'the explicit ask is a read-only answer');
    assert.match(disclosure, /writes nothing/i, 'the explicit ask writes nothing (adds no mode)');
    assert.match(disclosure, TWO_AXES_COMPARISON, 'the plain two-axes note names the npm package number');
    assert.match(disclosure, /not.{0,4}a newer deployment/i);
  });

  it('memory adds NO status mode (the intended asymmetry)', () => {
    assert.doesNotMatch(SKILL, /Mode: status/, 'the memory substrate must not invent a status mode');
  });

  it('the "Stamp = lineage head, not package version" gotcha is preserved verbatim', () => {
    assert.match(SKILL, /\*\*Stamp = lineage head, not package version\.\*\*/,
      'the stamp-vs-package-version gotcha (mechanics) stays verbatim');
    assert.match(SKILL, /`\.memory-version` carries the \*\*deployment-lineage\s+head\*\*/,
      'the stamp-WRITE mechanics description is preserved');
  });
});
