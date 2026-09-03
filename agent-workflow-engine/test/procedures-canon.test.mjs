import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The engine is the canonical source for the activity PROCEDURES (the kit reads this canon live and
// renders it via the read-only `/agent-workflow-kit procedures <activity>`; it parses ONLY each
// section's `Slots:` line, drift-guarded against its activity table — never the steps). This test
// guards the shapes the kit relies on: the two `## <activity>` sections, each declaring its typed
// recipe slots; the binds to planning.md by NAMED anchor (without restating); the load-bearing "Delegated →
// dispatch first" phrasing + the universal commit rule; and that the canon stays GENERIC (no concrete
// project release-publishing bake-in — that is a project overlay, not engine canon).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROCEDURES = join(ROOT, 'references', 'procedures.md');
const METHODOLOGY_SLOT = join(ROOT, 'references', 'methodology-slot.md');
const MAX_PROCEDURES_TO_PLANNING_RATIO = 1.45;
const HELD_SESSION_SENTENCE_GROUP = Object.freeze({ start: 'when `execute` resolved to Delegated', end: 'what the delegate cannot reach.', maxBytes: 726 });
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

  it('declares all four activities as their own `## <activity>` section', () => {
    for (const activity of ['plan-authoring', 'plan-execution', 'routine', 'feedback-triage']) {
      assert.ok(sectionOf(procedures, activity), `has a ## ${activity} section`);
    }
  });

  it('plan-authoring declares `Slots: author, fold, review` as its first content line', () => {
    assert.equal(slotsLineOf(sectionOf(procedures, 'plan-authoring')), 'Slots: author, fold, review');
  });

  it('plan-execution declares `Slots: execute, review` as its first content line', () => {
    assert.equal(slotsLineOf(sectionOf(procedures, 'plan-execution')), 'Slots: execute, review');
  });

  // planning.md is bound by HEADING, never by section number: a number dangles the moment a section
  // is deleted (§6–§9 once pointed at sections that no longer existed). Every anchor this canon
  // names must be a live `## ` heading in planning.md.
  it('binds to planning.md by named anchor — every anchor is a live heading, no numbered pointer', () => {
    const planning = readFileSync(join(ROOT, 'references', 'planning.md'), 'utf8');
    const headings = planning.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim());
    const flat = procedures.replace(/\s+/g, ' '); // an anchor may wrap across a markdown line
    for (const anchor of ['Module ledger', 'What gets cut', 'Un-run syntax never ships in prose', 'The plan must read cold', "Cleanup, and the plan's own life"]) {
      assert.ok(flat.includes(`*${anchor}*`), `names the planning.md anchor *${anchor}*`);
      assert.ok(headings.includes(anchor), `planning.md still carries the heading "${anchor}"`);
    }
    assert.doesNotMatch(flat, /planning\.md\)? ?§/, 'no numbered pointer into planning.md');
    // "Without restating": neither the retired vocabulary nor the ledger row grammar is re-defined here.
    assert.ok(!procedures.includes('Substep'), 'does not restate the Plan→Phase→Step→Substep vocabulary');
    assert.ok(!procedures.includes('<check-id>'), 'does not restate the planning.md ledger row grammar');
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

  it('pins the round render as the plan-authoring verdict source; plan-execution names no render (spec:plan-review-loop/S18)', () => {
    const authoring = stepOf(sectionOf(procedures, 'plan-authoring'), 5).replace(/\s+/g, ' ');
    const verdict = authoring.indexOf('READ its verdict half from the round render');
    const tally = authoring.indexOf("append the orchestrator's finding-origin tally");
    assert.ok(verdict >= 0 && tally > verdict, 'plan-authoring §5 reads the verdict half from the round render, then appends the tally');
    assert.doesNotMatch(stepOf(sectionOf(procedures, 'plan-execution'), 5), /round render|review-rounds/i, 'a code receipt carries no artifact path, so plan-execution names no render');
  });

  // The finding-scope rule (the fold channel): a finding NAMES the invariant its fix enforces
  // BEFORE the edit, and WHERE that invariant already lives decides the disposition. Pinned in the
  // plan-execution review STEP only — plan-authoring settles boundaries and has no shipped behaviour
  // to call a live defect in, so the queue and blocking arms mean nothing there. Both directions,
  // like the AD-046 ledger pointer below: neither a silent deletion nor a scope-creeping copy into
  // plan-authoring survives with tests green. (`stepOf` is declared below — the callback runs after
  // the describe body, so the anchor stays with the per-round emission it belongs to.)
  it('the plan-execution review STEP (5) carries the finding-scope rule + the two round bars; plan-authoring carries none', () => {
    const step5 = stepOf(sectionOf(procedures, 'plan-execution'), 5).replace(/\s+/g, ' ');
    assert.match(step5, /\*\*Finding scope\*\*/, 'the rule is named');
    assert.match(step5, /NAMES the invariant its fix enforces, BEFORE the edit/, 'the decision is pre-edit, not post-hoc');
    assert.match(step5, /\*\*fold here\*\*/, 'the in-scope arm');
    assert.match(step5, /\*\*narrow fix\*\* for the found site ships now/, 'the deferral arm ships the narrow fix first');
    assert.match(step5, /ONLY the generalization is queued/, 'only the generalization defers');
    for (const field of ['the invariant', 'the origin `file:line`', 'the narrow fix', 'its proof', 'a residual exposure declared NOT live']) {
      assert.ok(step5.includes(field), `a deferral row carries the field "${field}"`);
    }
    assert.match(step5, /\*\*blocking\*\* — the phase does not close, and it is never queued/, 'the blocking arm is never a queue row');
    assert.match(step5, /changes a WRITE\/REMOVE decision or is a false statement in shipped text/, 'bar 1 — what counts as a finding');
    assert.match(step5, /repeat finding in one subarea routes to SUBTRACTION, not a fourth patch/, 'bar 2 — a repeat subtracts');
    const auth = sectionOf(procedures, 'plan-authoring').replace(/\s+/g, ' ');
    for (const token of ['Finding scope', 'WRITE/REMOVE', 'SUBTRACTION']) {
      assert.ok(!auth.includes(token), `plan-authoring must not carry "${token}" — the rule is plan-execution-scoped`);
    }
  });

  // The activity-aware LEDGER pointer (AD-046): the review-round ledger is plan-EXECUTION-scoped
  // (AD-045), so the canon points at it from the plan-execution review step ONLY — the plan-authoring
  // step keeps the tally + the triage classification vocabulary with NO tool pointer. Pinned in BOTH
  // directions so neither a silent deletion nor a scope-creeping copy into plan-authoring survives.
  // Extract numbered step N of a section (the "N. **…**" line up to the next "M. " line) — the
  // ledger pointer must live in the REVIEW step itself, not merely somewhere in the section.
  const stepOf = (section, n) => {
    const lines = section.split('\n');
    const start = lines.findIndex((l) => new RegExp(`^${n}\\. `).test(l));
    assert.notEqual(start, -1, `numbered step ${n} exists`);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^\d+\. /.test(lines[i])) { end = i; break; }
    }
    return lines.slice(start, end).join('\n');
  };

  it('the plan-execution review STEP (5) names the D3 instruments (incl. commit-guard --check); plan-authoring never does', () => {
    const execStep5 = stepOf(sectionOf(procedures, 'plan-execution'), 5);
    for (const token of ['core-evidence red-proof', 'core-evidence\n   degrade', 'run-gates --final', 'commit-guard --check']) {
      assert.ok(execStep5.includes(token), `plan-execution step 5 names "${token.replace(/\s+/g, ' ')}"`);
    }
    const auth = sectionOf(procedures, 'plan-authoring');
    assert.ok(!auth.includes('run-gates --final'), 'plan-authoring must not point at the plan-execution loop instruments');
    assert.ok(!auth.includes('review-ledger'), 'the retired ledger is never named');
  });

  it('spec:held-session/S6 pins the held-session sentence group in plan-execution step 5', () => {
    const execution = sectionOf(procedures, 'plan-execution');
    const step5 = stepOf(execution, 5).replace(/\s+/g, ' ');
    for (const token of [
      'codex-exec --resume <held id> --nonce <nonce> <fold-brief>',
      "the session the first FOLDED delegated dispatch's exec receipt minted",
      "never an earlier failed or unfolded run", "held until the row's commit",
      'a nonce-less run mints no receipt',
      'a fresh session for a fold is a forbidden substitution',
      'a retry of a failed thread',
      'a recorded execute degrade',
      'runs the suites', 'verifies the returned diff', 're-mints the red-proofs', 'owns the commit',
      'folds by hand only what the delegate cannot reach',
    ]) assert.ok(step5.includes(token), token);
    assert.equal(slotsLineOf(execution), 'Slots: execute, review');
    assert.deepEqual([...execution.matchAll(/^(\d+)\. /gmu)].map((match) => Number(match[1])), [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('plan-execution pins coverage-to-brief order and the walk/cap round gates', () => {
    const execution = sectionOf(procedures, 'plan-execution');
    const step2 = stepOf(execution, 2).replace(/\s+/g, ' ');
    const positions = ['--coverage', 'tags', 'plan-shape --check', 'generated robustness-literals block'].map((token) => step2.indexOf(token));
    assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])), `coverage order: ${positions.join(' < ')}`);
    assert.ok(step2.indexOf('Otherwise implement directly.') < step2.indexOf('The dispatch brief'), 'direct implementation precedes the dispatch brief');
    const step5 = stepOf(execution, 5).replace(/\s+/g, ' ');
    for (const token of ['--walk', 'every fold owes a walk', 'cap reached', 'crossover', 'round table', 'never a tool', 'custody-lost', 'escalated', '--claim']) assert.ok(step5.includes(token), `step 5 carries ${token}`);
  });

  // D-17 U2 — the upfront-knowledge rung: the layout is decided while the plan is drafted, not
  // discovered when a gate refuses a written file. The rung itself (path, responsibility, budget from
  // the declared cap or `n/a`) is the planning.md Module ledger; the Draft step points at it.
  it('canon-authoring-carries-decomposition-rung: the Module ledger decides layout + budget before any file exists (plan-authoring only)', () => {
    const section = sectionOf(procedures, 'plan-authoring');
    const draft = stepOf(section, 2).replace(/\s+/g, ' ');
    assert.match(draft, /\*Module ledger\*/, 'the Draft step points at the ledger');
    assert.match(draft, /before any file exists/, 'the layout is a plan-time decision');
    assert.match(draft, /a size gate is only the backstop/, 'the cap is the backstop, never the teacher');
    assert.match(stepOf(section, 3).replace(/\s+/g, ' '), /\*What gets cut\*/, 'the Self-review step applies the subtraction rubric');
    // The layout is a PLAN-time decision: plan-execution must not grow a rival copy of the rung.
    assert.ok(!/Module ledger/.test(sectionOf(procedures, 'plan-execution')), 'the rung lives in plan-authoring only');
  });

  it('BOTH review steps (5) carry the triage classification vocabulary', () => {
    for (const activity of ['plan-authoring', 'plan-execution']) {
      const step5 = stepOf(sectionOf(procedures, activity), 5);
      for (const token of ['fixable-bug', 'inherent-layer-residual', 'escalate']) {
        assert.ok(step5.includes(token), `${activity} step 5 carries the classification token "${token}"`);
      }
    }
  });

  it('plan-authoring step 3 opens with the readers sweep before its existing checks', () => {
    const step3 = stepOf(sectionOf(procedures, 'plan-authoring'), 3).replace(/\s+/g, ' ');
    assert.match(step3, /^3\. \*\*Self-review\*\* — run the \*\*readers sweep before the first review\*\*/u);
    for (const token of ['config key', 'registry entry', 'exported constant', 'receipt field', 'canon sentence', 'ledger row', 'stated non-goal', 'unchanged']) {
      assert.ok(step3.includes(token), `readers sweep names ${token}`);
    }
  });

  it('both step 5s put ASK, WAIT and READ before the fold edit', () => {
    for (const activity of ['plan-authoring', 'plan-execution']) {
      const step5 = stepOf(sectionOf(procedures, activity), 5).replace(/\s+/g, ' ');
      for (const token of ['raised by a **review member**', 'ASK', 'WAIT', 'READ', 'accepted or corrected', 'folded directly']) assert.ok(step5.includes(token), `${activity} names ${token}`);
      if (activity === 'plan-authoring') {
        for (const token of ['`agy-review --continue --decided @f` for agy', '`codex-review plan <consult-brief>` for codex', 'a fresh re-dispatch of the same lens vehicle for a lens member']) assert.ok(step5.includes(token), `the consult form carries ${token}`);
      }
      assert.ok(step5.indexOf('ASK') < step5.indexOf('WAIT') && step5.indexOf('WAIT') < step5.indexOf('READ') && step5.indexOf('READ') < step5.indexOf('accepted or corrected'), `${activity} consult order`);
    }
  });

  it('the authoring fold carrier is explicit, and execution carries the armed attestation sequence', () => {
    const authoring = stepOf(sectionOf(procedures, 'plan-authoring'), 5).replace(/\s+/g, ' ');
    for (const token of ['resolved `fold` carrier', 'Solo', 'Subagent', "round's findings with their dispositions", 'self-consistency read']) assert.ok(authoring.includes(token), `authoring fold names ${token}`);
    const execution = stepOf(sectionOf(procedures, 'plan-execution'), 5).replace(/\s+/g, ' ');
    for (const token of ['ARMED flow', 'a **bridge-raised** finding', 'round is open', 'nonce', 'flow-writer consult-attestation', '--proposed-fix-digest', 'then edit', 'A **lens-raised** finding instead re-dispatches the lens without a nonce']) assert.ok(execution.includes(token), `armed sequence names ${token}`);
    const lensBranch = execution.slice(execution.indexOf('A **lens-raised** finding'));
    assert.ok(!lensBranch.includes('consult-attestation') && lensBranch.includes('no attestation'), 'the lens branch mints nothing');
  });

  // Cost lanes (cost-tiered execution): the kit advisor renders an unconditional cost-lane block
  // that PARAPHRASES orchestration.md §5 — pin the same distinctive tokens in the CANON here
  // (the kit side pins them in the advisor output, procedures.test.mjs), so the paraphrase and
  // the canon cannot silently drift apart.
  it('the orchestration.md §5 canon carries the cost-lane tokens the kit advisor paraphrases', () => {
    const orchestration = readFileSync(join(ROOT, 'references', 'orchestration.md'), 'utf8');
    // The last five are the D7 prompt-economy invariants (REC-UX-REWORK) — one distinctive token
    // per invariant, pinned on all three surfaces (canon here · kit advisor · lens fragment).
    for (const token of [
      'cheapest adequate executor', 'no named guardrail', 'L0', 'L1', 'L2', 'L3', 'red lines never move',
      'forbidden lane downgrade', 'plain pipeline per call', 'vehicle mandate a host cannot satisfy',
      'stay at the frontier lane', 'no deterministic gate classifies a dispatch',
      // writer economy (AD-054; strip-the-kit rewording) + sandbox lanes (host-diff +
      // nested-sandbox honesty)
      'unbatched writer scatter', 'host-diff', 'nested inside a harness sandbox',
    ]) {
      assert.ok(orchestration.includes(token), `orchestration.md carries the "${token}" canon token`);
    }
  });

  // Terse process-fidelity pointers: A1 (the ExitPlanMode approval boundary) in plan-authoring
  // step 6; A2 (recipe fidelity → orchestration.md §4) in the review steps.
  it('carries the terse A1 (ExitPlanMode) + A2 (recipe-fidelity) process-fidelity pointers', () => {
    assert.match(procedures, /ExitPlanMode/, 'names the ExitPlanMode boundary (A1)');
    assert.match(procedures, /recipe fidelity/i, 'names recipe fidelity (A2)');
    assert.match(procedures, /every round/i, 'A2 — every named backend every round');
  });

  it('pins the review lens inside both activity sections; the plan-prose rubric judges plans only', () => {
    const planAuthoring = sectionOf(procedures, 'plan-authoring');
    const planExecution = sectionOf(procedures, 'plan-execution');

    for (const section of [planAuthoring, planExecution]) {
      assert.match(section, /fold by code/i, 'section carries the fold-by-code lens');
      assert.match(section, /planning\.md/, 'section references planning.md');
    }
    assert.match(planAuthoring, /\*What gets cut\*/, 'plan-authoring applies the planning.md subtraction rubric');
    // "What gets cut" deletes plan PROSE a verifier can do without; applied to a diff it would invite
    // deleting implementation because Verification would catch it. Execution judges the change
    // against its ledger row and the plan's Verification instead.
    assert.doesNotMatch(planExecution, /What gets cut/, 'the plan-prose rubric never judges a code change');
    assert.match(planExecution, /ledger row/, 'execution self-review is bound to the ledger row');
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
    // Rows are the steps, but Cleanup is a PHASE, not a row: plan-execution must close with the
    // project-declared stages and then Phase: Cleanup, in that order, or neither is guaranteed to run.
    const closing = stepOf(sectionOf(procedures, 'plan-execution'), 8);
    const atStages = closing.indexOf('workflow:methodology');
    const atCleanup = closing.indexOf('Phase: Cleanup');
    assert.ok(atStages !== -1 && atCleanup !== -1 && atStages < atCleanup, 'plan-execution closes with the project stages, then Phase: Cleanup');
    // Post-row mutations are not exempt from the loop: they run as rows, through the same steps.
    assert.match(closing, /rows of their own/, 'the project stages and Cleanup run as rows of their own');
    assert.match(closing, /each through steps 1.7/, 'each such row passes steps 1–7 (review, gates, commit boundary)');
    assert.ok(!/release-engineering/.test(procedures), 'no concrete release-engineering skill bake-in');
    assert.ok(!/release-marketing/.test(procedures), 'no concrete release-marketing skill bake-in');
    assert.ok(!/Phase:\s*Release Publishing/i.test(procedures), 'no mandatory Release-Publishing phase bake-in');
  });
  it('is terse — stays within a bounded margin of the planning.md canon it binds to', () => {
    const planning = readFileSync(join(ROOT, 'references', 'planning.md'), 'utf8');
    const start = procedures.indexOf(HELD_SESSION_SENTENCE_GROUP.start);
    assert.notEqual(start, -1, 'the held-session sentence group keeps its opening anchor');
    const end = procedures.indexOf(HELD_SESSION_SENTENCE_GROUP.end, start);
    assert.notEqual(end, -1, 'the held-session sentence group keeps its closing anchor');
    const sentenceGroup = procedures.slice(start, end + HELD_SESSION_SENTENCE_GROUP.end.length);
    assert.ok(Buffer.byteLength(sentenceGroup, 'utf8') < HELD_SESSION_SENTENCE_GROUP.maxBytes, 'the held-session sentence group stays under its own byte cap');
    assert.ok(procedures.length - sentenceGroup.length < planning.length * MAX_PROCEDURES_TO_PLANNING_RATIO, 'the procedures canon stays a terse pointer, not a restatement of planning.md');
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

  it('tells the agent to READ the autonomy policy at the same session-start moment (AD-044 Plan 4)', () => {
    const flat = procedures.replace(/\s+/g, ' ');
    assert.match(flat, /Read the \*\*autonomy policy\*\* the same way and at the same moment/i, 'the autonomy read-at-start clause');
    assert.match(procedures, /docs\/ai\/autonomy\.json/, 'names the policy file to read');
    assert.match(flat, /computed defaults ARE the policy/i, 'absent-file semantics stated');
    assert.match(flat, /malformed\s+→ STOP loudly, never guess/i, 'malformed is a loud STOP');
    assert.match(procedures, /set-autonomy/, 'points at the set-autonomy writer');
    assert.match(flat, /orchestration\.md.*§7/, 'points at the §7 policy canon, never restates it');
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

  it('spec:carriers/S10 — the carrier slots reach the steps: the author carrier drafts, the subagent branch rides beside Delegated', () => {
    const draft = stepOf(sectionOf(procedures, 'plan-authoring'), 2).replace(/\s+/g, ' ');
    assert.match(draft, /The resolved `author` carrier drafts/, 'the Draft step resolves the author carrier');
    assert.match(draft, /Solo: the orchestrator writes it/, 'the Solo arm writes the plan itself');
    assert.match(draft, /Subagent: the orchestrator writes a BRIEF/, 'the Subagent arm starts from a brief');
    assert.match(draft, /goal, governing specs, ledger\s+constraints, files/, 'what the brief carries');
    assert.match(draft, /drafts the plan and any `create` \/ `modify` spec row from it/, 'the subagent drafts the plan and its spec rows');
    assert.match(draft, /reviews the draft as its own before step 3/, 'the orchestrator owns the draft it accepts');
    const dispatch = stepOf(sectionOf(procedures, 'plan-execution'), 2).replace(/\s+/g, ' ');
    assert.match(dispatch, /\*\*If `execute` resolved to Subagent\*\*, split the ledger into file-disjoint slices/, 'the subagent branch splits the ledger');
    assert.match(dispatch, /exact wording where wording is a red line/, 'wording is copied where it is a red line');
    assert.match(dispatch, /the executor vehicle in the background/, 'the dispatch is backgrounded');
    assert.match(dispatch, /verify every returned slice by running its suites yourself before step 3/, 'the orchestrator verifies every returned slice');
  });

  it('S8 pins the generated robustness block in the plan-execution dispatch brief (spec:robustness-literals/S8)', () => {
    const dispatch = stepOf(sectionOf(procedures, 'plan-execution'), 2).replace(/\s+/g, ' ');
    assert.ok(dispatch.includes('The dispatch brief — Delegated or Subagent — carries the generated robustness-literals block for every tagged row.'));
  });

  it('the routine activity declares `Slots: carrier, parallel` and carries its five steps', () => {
    const routine = sectionOf(procedures, 'routine');
    assert.equal(slotsLineOf(routine), 'Slots: carrier, parallel');
    const flat = routine.replace(/\s+/g, ' ');
    assert.match(flat, /1\. \*\*Name the chore and its slices\*\*/, 'step 1 names the chore and its slices');
    assert.match(flat, /each slice bounded and file-disjoint/, 'the slices are bounded and file-disjoint');
    assert.match(flat, /2\. \*\*Resolve the recipe\*\* — `carrier` and `parallel` from `docs\/ai\/orchestration\.json` \+ readiness/, 'step 2 resolves both slots');
    assert.match(flat, /`--override <slot>=<value>` per run/, 'the per-run override');
    assert.match(flat, /3\. \*\*Carry it\*\* — Solo: the orchestrator does it\. Subagent classifies each slice: read-only \(a sweep, gate triage\) rides its placed read-only vehicle, or is carried Solo with a stated reason when that vehicle is absent; write-capable \(a regeneration, a fixture build\) rides the executor\./, 'step 3 picks the vehicle by the slice class, never the executor for read-only work');
    assert.match(flat, /never the changelog/, 'the changelog stays the orchestrator\'s');
    assert.match(flat, /concurrently when `parallel` is on/, 'the parallel switch drives concurrency');
    assert.match(flat, /4\. \*\*Verify\*\* — every returned slice, by running its suites yourself/, 'step 4 verifies every returned slice');
    assert.match(flat, /5\. \*\*The commit boundary is unchanged\*\* — when an accepted slice changed the tree, the orchestrator alone commits; a read-only chore has no commit boundary; a carrier never commits/, 'step 5 keeps the commit boundary, and a read-only chore has none');
  });

  describe('feedback-triage canon [spec:feedback-triage/S12]', () => {
    it('carries the review-only six-step procedure and its completion rule', () => {
      const section = sectionOf(procedures, 'feedback-triage');
      assert.equal(slotsLineOf(section), 'Slots: review');
      assert.deepEqual([...section.matchAll(/^(\d+)\. /gmu)].map((match) => Number(match[1])), [1, 2, 3, 4, 5, 6]);
      for (const [number, token] of ['Record', 'Verify', 'Check', 'review {recipe}', 'Rows', 'Fold'].entries()) assert.ok(stepOf(section, number + 1).includes(token), `step ${number + 1} names ${token}`);
      const done = contentLines(section).find((line) => line.includes('Definition of Done')) ?? '';
      for (const token of ['a checked record', 'its rows in the queue', 'the ratchet moved by exactly the rows rendered']) assert.ok(done.includes(token), `Definition of Done names ${token}`);
      for (const token of ['--check <record>', '--excerpts', '--rows <record>', 'queue-audit --check']) assert.ok(section.includes(token), `section names ${token}`);
      assert.doesNotMatch(section, /docs\/|agent-workflow-kit\/|agent-workflow-engine\//u, 'the canon stays project-neutral');
    });
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
