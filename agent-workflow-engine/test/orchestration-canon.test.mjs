import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The engine is the canonical NARRATIVE source for the orchestration recipes (the kit owns the
// executable dispatch in tools/recipes.mjs and pins these files by a cross-package parity guard).
// These tests guard the two shapes the kit relies on: the bounded one-line slot fragment (injected
// into a deployed AGENTS.md, so it must stay one marker-free line under the cap budget) and the full
// reference (must name all four recipe ids so the parity guard and a reader both find them).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLOT = join(ROOT, 'references', 'orchestration-slot.md');
const REFERENCE = join(ROOT, 'references', 'orchestration.md');

const RECIPE_IDS = ['solo', 'reviewed', 'council', 'delegated'];

// A `## <n>. <heading>` section: the heading line through the line before the next `## ` (or EOF).
const sectionFrom = (text, headingRe) => {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => headingRe.test(line));
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
};

// A "content line" is a non-blank line; the slot must be exactly one (the cap budget has no room for
// more — the kit injects it verbatim between the orchestration markers).
const contentLines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);

describe('engine orchestration-slot.md — bounded one-line fragment', () => {
  const slot = readFileSync(SLOT, 'utf8');

  it('exists and is non-empty', () => {
    assert.ok(slot.trim().length > 0, 'the orchestration slot fragment must not be empty');
  });

  it('is exactly one content line', () => {
    assert.equal(contentLines(slot).length, 1, 'the slot fragment must be exactly one content line');
  });

  it('carries no marker text (the kit frames it with the markers, the fragment must not)', () => {
    assert.ok(!slot.includes('<!--'), 'the fragment must not contain an HTML comment / marker');
    assert.ok(!slot.includes('workflow:orchestration'), 'the fragment must not contain the slot marker name');
  });

  it('routes through the in-project /agent-workflow-kit recipes surface, not the engine-internal reference', () => {
    assert.match(slot, /\/agent-workflow-kit recipes/, 'the slot must point at the in-project recipes surface');
    assert.ok(!slot.includes('references/orchestration.md'), 'the slot must never point at the engine-internal reference (absent from a user project)');
  });

  it('names all four recipes', () => {
    const lower = slot.toLowerCase();
    for (const id of RECIPE_IDS) assert.ok(lower.includes(id), `the slot fragment names the "${id}" recipe`);
  });

  it('carries the §1.6a read-at-start clause (read orchestration.json; set it with set-recipe)', () => {
    assert.match(slot, /docs\/ai\/orchestration\.json/, 'points at the per-project config to read at session start');
    assert.match(slot, /\/agent-workflow-kit set-recipe/, 'names the set-recipe writer');
  });
});

describe('engine orchestration.md — canonical recipe reference', () => {
  const reference = readFileSync(REFERENCE, 'utf8');

  it('exists and is non-trivial', () => {
    assert.ok(reference.length > 500, 'the canonical reference must carry real content');
  });

  it('names all four recipe ids verbatim (the kit parity guard reads them here)', () => {
    const lower = reference.toLowerCase();
    for (const id of RECIPE_IDS) assert.ok(lower.includes(id), `the reference names the "${id}" recipe`);
  });

  it('cross-references the plan lifecycle without duplicating it', () => {
    assert.match(reference, /planning\.md/, 'the reference points at the plan lifecycle canon');
  });

  // A2 (recipe fidelity): orchestration.md is A2's canon home. §4 already defines the
  // unavailable-backend degrade; this pins the CONVERSE — every backend a READY recipe names runs
  // every round, and quietly dropping a ready backend is a forbidden silent downgrade.
  it('pins the §4 recipe-fidelity invariant (A2) — every ready backend runs every round', () => {
    const section4 = sectionFrom(reference, /^## 4\. /);
    assert.ok(section4.length > 0, 'the reference has a §4 section');
    assert.match(section4, /fidelity/i, '§4 names the recipe-fidelity invariant');
    assert.match(section4, /every round/i, '§4 requires every ready backend every round');
    assert.match(section4, /forbidden/i, 'dropping a ready backend is forbidden');
    // Pin the load-bearing SEMANTICS — §4 must keep "ready" backend, the Council case, and the
    // quiet-drop-is-a-breach phrasing, not just the keywords.
    assert.match(section4, /ready/i, '§4 distinguishes a READY backend (vs an unavailable degrade)');
    assert.match(section4, /Council/, '§4 names the Council case it forbids downgrading');
    assert.match(section4, /skipping a ready backend/i, '§4 names the forbidden act — skipping a ready backend');
    assert.match(section4, /quietly drop/i, '§4 pins that a quietly-dropped ready backend is the breach');
  });

  // M3 (backend-divergence stop-signal): §4 pins that running every backend every round CONVERGES at
  // 0/0, but when backends DIVERGE (one ships while another keeps revising mechanics) the divergence IS
  // the crossover — resolve at altitude, bounding the ROUNDS, never dropping a ready backend within one.
  it('pins the §4 backend-divergence crossover stop (M3) — bounds rounds, not backends', () => {
    const section4 = sectionFrom(reference, /^## 4\. /);
    assert.match(section4, /backend divergence/i, '§4 names backend divergence as the stop signal');
    assert.match(section4, /crossover/i, '§4 pins that divergence IS the crossover');
    assert.match(section4, /altitude/i, '§4 resolves divergence at altitude');
    assert.match(section4, /0 blockers \+ 0 majors/i, '§4 reconciles with the A3 convergence bar');
  });

  // §5 disambiguation: the quota/health guard must not read as licence to drop a ready backend.
  it('disambiguates §5 so the quota guard is not a licence to drop a ready backend', () => {
    const section5 = sectionFrom(reference, /^## 5\. /);
    assert.match(section5, /licence|license/i, '§5 explicitly disclaims the drop-a-ready-backend reading');
    assert.match(section5, /ready backend mid-Council/i, '§5 pins the specific mid-Council drop it disclaims');
  });

  // Cost lanes (cost-tiered execution): §5 owns the lane vocabulary — the four lanes, the
  // cheapest-adequate-executor rule, the no-guardrail-no-move rule, the red-line list, asymmetric
  // pairing, and the incident-repair default. Generic altitude: the L0 examples are the family's
  // own generic surfaces (the gate runner, the rotation checks), never project publish steps.
  it('pins the §5 cost-lane vocabulary — L0..L3 + the two routing rules', () => {
    const section5 = sectionFrom(reference, /^## 5\. /);
    for (const lane of ['L0', 'L1', 'L2', 'L3']) {
      assert.ok(section5.includes(lane), `§5 defines lane ${lane}`);
    }
    assert.match(section5, /cheapest adequate executor/i, '§5 states the routing rule');
    assert.match(section5, /no named guardrail does not move down/i, '§5 states the no-guardrail-no-move rule');
    assert.match(section5, /red lines never move down/i, '§5 carries the red-line list');
    assert.match(section5, /approval asks \(commit \/ push \/ publish/i, 'approval gates are a named red line');
    assert.match(section5, /asymmetric pairing/i, '§5 names the cheap-drafts/verified composition');
    assert.match(section5, /salvage recorded state first/i, '§5 carries the incident-repair down-lane default');
    assert.match(section5, /gates\.json/, 'the L0 example names the generic gate-declaration surface');
    assert.ok(!/dispatch-publish|smoke-init|version-sync/.test(section5), 'canon stays generic — no project publish mechanics');
  });
});
