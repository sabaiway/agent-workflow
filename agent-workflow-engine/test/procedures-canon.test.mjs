import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The engine is the canonical source for the activity PROCEDURES (the kit reads this canon live and
// renders it via the read-only `/agent-workflow-kit procedures <activity>`; it parses ONLY each
// section's `Slots:` line, drift-guarded against its activity table — never the steps). This test
// guards the shapes the kit relies on: the two `## <activity>` sections, each declaring its typed
// recipe slots; the binds to planning.md §§4/7/8 (without restating); the load-bearing "Delegated →
// dispatch first" phrasing + the universal commit rule; and that the canon stays GENERIC (no concrete
// project release-publishing bake-in — that is a project overlay, not engine canon).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROCEDURES = join(ROOT, 'references', 'procedures.md');
const METHODOLOGY_SLOT = join(ROOT, 'references', 'methodology-slot.md');

const procedures = readFileSync(PROCEDURES, 'utf8');

const contentLines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);

// Extract a `## <activity>` section (heading → next `## ` heading or EOF) — the same boundary the kit
// parser uses. Returns the section text including its heading.
const sectionOf = (text, activity) => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${activity}`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
};

// The first non-blank content line after the `## <activity>` heading must be the `Slots:` line.
const slotsLineOf = (section) => {
  const body = section.split('\n').slice(1); // drop the heading
  return body.map((l) => l.trim()).find((l) => l.length > 0) ?? '';
};

describe('procedures.md — canonical activity-procedures reference', () => {
  it('exists and carries real content', () => {
    assert.ok(procedures.length > 500, 'the procedures canon must carry real content');
  });

  it('declares both v1 activities as their own `## <activity>` section', () => {
    assert.ok(sectionOf(procedures, 'plan-authoring'), 'has a ## plan-authoring section');
    assert.ok(sectionOf(procedures, 'plan-execution'), 'has a ## plan-execution section');
  });

  it('plan-authoring declares `Slots: review` as its first content line', () => {
    assert.equal(slotsLineOf(sectionOf(procedures, 'plan-authoring')), 'Slots: review');
  });

  it('plan-execution declares `Slots: execute, review` as its first content line', () => {
    assert.equal(slotsLineOf(sectionOf(procedures, 'plan-execution')), 'Slots: execute, review');
  });

  it('binds to planning.md §§4/7/8 (the structure, self-review, and Cleanup canon) without restating', () => {
    assert.match(procedures, /planning\.md/, 'points at the plan-lifecycle canon');
    for (const sec of ['§7', '§8', '§4']) {
      assert.ok(procedures.includes(sec), `binds to planning.md ${sec}`);
    }
    // "Without restating": it must NOT re-define the plan vocabulary (planning.md §1) nor re-enumerate
    // the §7 document structure inline (a pure pointer to §7 is the contract; an inline section list is
    // drift risk). The §7 enumeration is recognisable by its tail trio Critical files → Reuse →
    // Verification appearing together.
    assert.ok(!procedures.includes('Substep'), 'does not restate the Plan→Phase→Step→Substep vocabulary');
    assert.ok(
      !/Critical files[^]*Reuse[^]*Verification/.test(procedures),
      'does not re-enumerate the planning.md §7 document structure inline (points at §7, never restates it)',
    );
  });

  // Set-1 coverage (Phase 3 consistency invariant): every cross-all-four regression-free / convergence
  // token must live in the procedures region (`## plan-authoring` onward) — the same region
  // lens-mirror.test.mjs scopes — so the kit drift guard's per-region check passes here too.
  it('lands the cross-all-four regression-free + convergence tokens in the procedures region (Set-1)', () => {
    const start = procedures.indexOf('## plan-authoring');
    assert.notEqual(start, -1, 'has a plan-authoring region');
    const region = procedures.slice(start).toLowerCase();
    for (const token of [
      '0 blockers + 0 majors', 'test-as-spec', 'no code-mechanics', 'at the diff', 'characterize-first',
      // Review-loop economics (M2/M3/M4/M5-b) — the same five lens-mirror.test.mjs now pins in all four regions.
      '≤2 rounds', 'crossover', 'backend divergence', 'diff-review', 'self-consistency',
      // Checked-vs-unchecked boundary (the §9 B5 sharpening) — same two strings lens-mirror.test.mjs pins.
      'checked syntax', 'logic-bearing',
    ]) {
      assert.ok(region.includes(token), `procedures region carries the "${token}" token`);
    }
  });

  // M6 (queue.md third leg — advisor + procedures.md canon step + a token guard): the required per-round
  // structured emission {round N · finding-origin tally · per-backend verdict} is pinned in the per-round
  // loop point of BOTH activities so the canon step cannot be silently deleted from EITHER section, nor
  // any one of its three fields dropped, with tests green. (M6 is not §9-native, so it is a Set-2 template
  // token in lens-mirror.test.mjs, not a cross-all-four Set-1 one.)
  it('pins the M6 per-round emission (round N · finding-origin · per-backend verdict) in BOTH activity sections', () => {
    for (const activity of ['plan-authoring', 'plan-execution']) {
      const section = sectionOf(procedures, activity);
      assert.match(section, /round N/, `${activity} §5 requires the per-round emission (round N)`);
      assert.match(section, /finding-origin/i, `${activity} §5 emits a finding-origin tally`);
      assert.match(section, /per-backend verdict/i, `${activity} §5 emits a per-backend verdict`);
    }
  });

  // Cost lanes (cost-tiered execution): the kit advisor renders an unconditional cost-lane block
  // that PARAPHRASES orchestration.md §5 — pin the same distinctive tokens in the CANON here
  // (the kit side pins them in the advisor output, procedures.test.mjs), so the paraphrase and
  // the canon cannot silently drift apart.
  it('the orchestration.md §5 canon carries the cost-lane tokens the kit advisor paraphrases', () => {
    const orchestration = readFileSync(join(ROOT, 'references', 'orchestration.md'), 'utf8');
    for (const token of ['cheapest adequate executor', 'no named guardrail', 'L0', 'L1', 'L2', 'L3', 'red lines never move']) {
      assert.ok(orchestration.includes(token), `orchestration.md carries the "${token}" canon token`);
    }
  });

  // Terse process-fidelity pointers: A1 (ExitPlanMode boundary → planning.md §6) in plan-authoring
  // step 6; A2 (recipe fidelity → orchestration.md §4) in the review steps.
  it('carries the terse A1 (ExitPlanMode) + A2 (recipe-fidelity) process-fidelity pointers', () => {
    assert.match(procedures, /ExitPlanMode/, 'names the ExitPlanMode boundary (A1)');
    assert.match(procedures, /recipe fidelity/i, 'names recipe fidelity (A2)');
    assert.match(procedures, /every round/i, 'A2 — every named backend every round');
  });

  it('pins the §9 review lens inside both activity sections', () => {
    const planAuthoring = sectionOf(procedures, 'plan-authoring');
    const planExecution = sectionOf(procedures, 'plan-execution');

    for (const section of [planAuthoring, planExecution]) {
      assert.match(section, /fold by code/i, 'section carries the fold-by-code lens');
      assert.match(section, /planning\.md/, 'section references planning.md');
      assert.match(section, /§9/, 'section references planning.md §9');
    }
  });

  it('carries the load-bearing "Delegated → dispatch first" phrasing', () => {
    assert.match(
      procedures,
      /Delegated[^]*?dispatch execution FIRST/i,
      'plan-execution dispatches a Delegated execution before integrating',
    );
  });

  it('states the commit rule as a commit-BOUNDARY rule (not every activity commits; a backend never commits)', () => {
    const flat = procedures.replace(/\s+/g, ' ').toLowerCase();
    assert.match(flat, /when an activity has a commit boundary, the orchestrator owns that commit/, 'the rule is conditional on a commit boundary');
    assert.match(flat, /never commits/, 'a backend never commits');
    // plan-authoring must NOT push toward committing the plan — it ends at approval, plans never committed.
    // (the flat text keeps markdown emphasis, e.g. "ends at **approval**", so match tolerantly.)
    assert.match(flat, /ends at \*?\*?approval/, 'plan-authoring produces no commit (ends at approval)');
    assert.match(flat, /plans are ephemeral, never committed/, 'plans are ephemeral and never committed');
    assert.match(procedures, /orchestration\.md/, 'cross-references the commit-rule canon');
  });

  it('stays GENERIC — no concrete project release-publishing bake-in', () => {
    // The generic deferral phrase ("project-declared release/publishing … per the workflow:methodology
    // slot") is REQUIRED; the concrete enforcement (skill names, a mandatory Release-Publishing phase)
    // is a project overlay and must NOT appear in the engine canon.
    assert.match(procedures, /workflow:methodology/, 'defers project stages to the methodology slot');
    assert.ok(!/release-engineering/.test(procedures), 'no concrete release-engineering skill bake-in');
    assert.ok(!/release-marketing/.test(procedures), 'no concrete release-marketing skill bake-in');
    assert.ok(!/Phase:\s*Release Publishing/i.test(procedures), 'no mandatory Release-Publishing phase bake-in');
  });

  it('is terse — stays smaller than the planning.md canon it binds to (points, not restates)', () => {
    const planning = readFileSync(join(ROOT, 'references', 'planning.md'), 'utf8');
    assert.ok(
      procedures.length < planning.length,
      'the procedures canon stays a terse pointer, not a restatement of planning.md',
    );
  });

  // AD-025 — durable session behavior pinned in the live-read canon (so a future canon edit can't
  // silently drop them): read-at-start, the plan-authoring Definition of Done, and the communication
  // contract. The engine canon stays GENERIC (the "no project bake-in" test above still holds).
  it('tells the agent to READ the orchestration preference at session start', () => {
    const flat = procedures.replace(/\s+/g, ' ');
    assert.match(flat, /at the start of a planning or execution session, read/i, 'a read-at-start clause');
    assert.match(procedures, /docs\/ai\/orchestration\.json/, 'names the config to read');
    assert.match(procedures, /set-recipe/, 'points at the set-recipe writer');
  });

  it('pins the plan-authoring Definition of Done (plan + next-session execution prompt, unprompted)', () => {
    const flat = procedures.replace(/\s+/g, ' ');
    assert.match(flat, /Definition of Done/i);
    assert.match(flat, /execution prompt to begin the next session/i, 'requires a next-session prompt');
    assert.match(flat, /without the user asking/i, 'unprompted');
  });

  it('pins the communication contract (deliver the artifact inline; never a bare pointer as a substitute)', () => {
    const flat = procedures.replace(/\s+/g, ' ');
    assert.match(flat, /Communication contract/i);
    assert.match(flat, /delivers the artifact \*\*inline\*\*/, 'deliver the artifact inline');
    assert.match(procedures, /see §X/, 'names the banned bare-pointer anti-pattern');
  });
});

// §3.2 (engine) — the methodology slot fragment gained the procedures auto-discovery clause. It must
// stay a bounded ONE-line, marker-free fragment (the kit frames it with the markers) that routes to the
// in-project /agent-workflow-kit procedures surface (NOT the engine-internal procedures.md).
describe('methodology-slot.md — bounded fragment carries the procedures route', () => {
  const slot = readFileSync(METHODOLOGY_SLOT, 'utf8');

  it('is exactly one content line', () => {
    assert.equal(contentLines(slot).length, 1, 'the methodology slot fragment must be exactly one content line');
  });

  it('carries no marker text (the kit frames it with the markers, the fragment must not)', () => {
    assert.ok(!slot.includes('<!--'), 'the fragment must not contain an HTML comment / marker');
    assert.ok(!slot.includes('workflow:methodology'), 'the fragment must not contain the slot marker name');
  });

  it('routes to the in-project /agent-workflow-kit procedures surface (auto-discovery clause)', () => {
    assert.match(slot, /\/agent-workflow-kit procedures/, 'the slot must route to the in-project procedures advisor');
    assert.ok(!slot.includes('references/procedures.md'), 'the slot must never point at the engine-internal canon (absent from a user project)');
  });

  it('names both v1 activities so a reader knows which activities have procedures', () => {
    for (const activity of ['plan-authoring', 'plan-execution']) {
      assert.ok(slot.includes(activity), `the slot names the "${activity}" activity`);
    }
  });

  it('carries the §1.9 communication-contract clause (the canonical-refresh signature)', () => {
    assert.match(slot, /Communication/, 'the methodology slot carries the Communication clause');
    assert.match(slot, /inline/, 'the clause says deliver the artifact inline');
  });
});
