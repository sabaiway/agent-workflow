import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The engine is the canonical NARRATIVE source for the orchestration recipes (the kit owns the
// executable dispatch in tools/recipes.mjs and pins these files by a cross-package parity guard).
// These tests guard the two shapes the kit relies on: the bounded one-line slot fragment (injected
// into a deployed AGENTS.md, so it must stay one marker-free line under the cap budget) and the full
// reference (must name all five recipe ids so the parity guard and a reader both find them).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLOT = join(ROOT, 'references', 'orchestration-slot.md');
const REFERENCE = join(ROOT, 'references', 'orchestration.md');

const RECIPE_IDS = ['solo', 'reviewed', 'council', 'delegated', 'subagent'];

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

  it('names all five recipes', () => {
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

  it('names all five recipe ids verbatim (the kit parity guard reads them here)', () => {
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

  // Sandbox lanes (AD-044 Plan 4, D4): §5 carries the surface classification + the two driving
  // rules the kit's procedures advisor paraphrases at its point of use (both sides pinned).
  it('pins the §5 sandbox-lane note — surface classification + the two driving rules (AD-044 Plan 4)', () => {
    const flat = sectionFrom(reference, /^## 5\. /).replace(/\s+/g, ' ');
    assert.match(flat, /Sandbox lanes/, '§5 names the sandbox-lane split');
    assert.match(flat, /sandbox-safe/i, 'the L0 surfaces are classified sandbox-safe');
    assert.match(flat, /genuinely unsandboxed/i, 'the bridge wrappers are classified honestly (network)');
    assert.match(flat, /COMMAND-SHAPE dependent/, 'npm-cache commands are shape-classified, never blanket-moved');
    assert.match(flat, /move ONLY the failing command out of the sandbox, never its class/i, 'driving rule 1');
    assert.match(flat, /BATCH consecutive unsandboxed calls/i, 'driving rule 2');
  });

  // §7 (AD-044 Plan 4): checkpoint-bounded autonomy — appended, never renumbering earlier sections.
  it('carries the trailing §7 checkpoint-bounded-autonomy canon (AD-044 Plan 4)', () => {
    const section7 = sectionFrom(reference, /^## 7\. /);
    const flat = section7.replace(/\s+/g, ' ');
    assert.match(flat, /Checkpoint-bounded autonomy/i, 'the §7 heading names the policy');
    assert.match(flat, /docs\/ai\/autonomy\.json/, 'names the per-project policy file');
    assert.match(flat, /computed defaults ARE the policy/i, 'the absent-file semantics are pinned');
    assert.match(flat, /malformed.*STOP/i, 'a malformed policy is a loud STOP, never guessed around');
    assert.match(flat, /sandbox is the floor, not the permission/i, 'sandbox-as-floor is pinned');
    assert.match(flat, /delegated backends the policy is informational/i, 'the informational-for-backends honesty note');
    assert.match(flat, /set-autonomy/, 'routes to the policy writer');
    assert.match(flat, /red-line commands keep their asks at every level/i, 'red-lines never move');
  });

  it('\u00a71 names WHO carries a step \u2014 the orchestrator, a bridge backend, or a subagent from the placed vehicle', () => {
    const flat1 = sectionFrom(reference, /^## 1\. /).replace(/\s+/g, ' ');
    assert.match(flat1, /who carries a step/i, '\u00a71 opens on the carrier, not on the backend alone');
    assert.match(flat1, /the \*\*orchestrator\*\* itself \(Solo\)/, 'the orchestrator is a carrier');
    assert.match(flat1, /a \*\*bridge backend\*\* \(Reviewed \/ Council \/ Delegated\)/, 'a bridge backend is a carrier');
    assert.match(flat1, /\*\*full-tool frontier subagent\*\* dispatched from the placed executor vehicle \(Subagent\)/, 'a subagent is a carrier');
    assert.match(flat1, /every other carrier is \*\*advisory or delegated, never autonomous, and never commits\*\*/, 'the carrier bar replaces the backend-only bar');
  });

  it('spec:carriers/S9 \u2014 \u00a72 lists Subagent as the fifth recipe with its load-bearing limits', () => {
    const flat2 = sectionFrom(reference, /^## 2\. /).replace(/\s+/g, ' ');
    assert.match(flat2, /\*\*Subagent\*\* \(`subagent`\)/, '\u00a72 carries the Subagent row with its id');
    assert.match(flat2, /bounded, file-disjoint\*\* slice/, 'the slice is bounded and file-disjoint');
    assert.match(flat2, /full-tool frontier subagent/, 'the carrier is a full-tool frontier subagent');
    assert.match(flat2, /verifies the returned slice by running its suites/, 'the orchestrator verifies by running the suites');
    assert.match(flat2, /the folds, the gates, the release documents, the asks and the \*\*one commit\*\*/, 'what the orchestrator keeps');
    assert.match(flat2, /never a review backend/, 'never a review backend');
    assert.match(flat2, /never a bridge substitute/, 'never a bridge substitute');
    assert.match(flat2, /never told to commit/, 'never told to commit');
    assert.match(flat2, /\*\*degrades to Solo\*\*/, 'degrades to Solo');
  });

  it('the Subagent readiness is the vehicle FILE \u2014 \u00a74 degrades it to Solo, \u00a75 refuses to claim the host', () => {
    const flat4 = sectionFrom(reference, /^## 4\. /).replace(/\s+/g, ' ');
    assert.match(flat4, /\*\*Subagent \u2192 Solo\.\*\* The executor vehicle is `missing` or `unusable`/, '\u00a74 carries the Subagent degrade with its reason');
    assert.match(flat4, /`\.claude\/agents\/executor\.md`/, '\u00a74 names the vehicle file readiness is read from');
    const flat5 = sectionFrom(reference, /^## 5\. /).replace(/\s+/g, ' ');
    assert.match(flat5, /Subagent carrier is a Claude Code lane/, '\u00a75 states the lane honestly');
    assert.match(flat5, /readiness is the vehicle FILE, never the host/, 'readiness is the file, never the host');
    assert.match(flat5, /instruction the orchestrator follows by hand/, 'an undispatchable host makes the render an instruction');
    assert.match(flat5, /never reported as a subagent dispatch/, 'and it is never reported as a dispatch');
  });

  it('the retired backend-only wording cannot return (the \u00a72 heading, the \u00a76 commit sentence)', () => {
    assert.ok(!reference.includes('## 2. The four recipes'), '\u00a72 is the five-recipe table, never the four-recipe one');
    const flat = reference.replace(/\s+/g, ' ');
    assert.ok(!flat.includes('No recipe makes a backend write to the repo or create a commit.'), '\u00a76 bounds every carrier, not the backend alone');
    assert.ok(!flat.includes('a backend never writes to the repo at all'), '\u00a76 never claims a delegated backend does not edit \u2014 it edits in its sandbox');
    assert.ok(flat.includes('No recipe lets a carrier commit or perform a git write: a review backend reads and returns findings; a delegated backend edits inside its own sandbox and returns a diff the orchestrator reviews; a subagent edits only the files its brief names \u2014 and the orchestrator alone stages and commits.'), '\u00a76 states the three carriers and the one committer');
    assert.ok(flat.includes('spends no bridge quota (it runs on the host\u2019s own model and consumes that model\u2019s quota and cost)') || flat.includes("spends no bridge quota (it runs on the host's own model and consumes that model's quota and cost)"), '\u00a71 names the executor\u2019s real cost');
    assert.ok(!flat.includes('spends no subscription quota'), 'the executor is never claimed free');
    assert.ok(flat.includes('A routine slice is classified first: a read-only one rides a placed read-only vehicle (or is carried Solo with a stated reason when that vehicle is absent); a write-capable one rides the executor.'), '§2 never sends read-only work to the executor');
    assert.ok(flat.includes('a customized file is kept; an unusable path must be fixed or removed first, then placed'), '§4 states what the apply command does and does not repair');
    assert.ok(!flat.includes('puts the vehicle back'), 'the apply command is never claimed to repair an unusable path');
  });
});
