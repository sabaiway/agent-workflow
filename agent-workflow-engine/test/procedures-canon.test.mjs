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

// Extract a section's main steps or the named part within its `## ` boundary.
const sectionOf = (text, activity, part = null) => {
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
  const [main, ...parts] = lines.slice(start, end).join('\n').split(/\n(?=### )/);
  return part === null ? main : parts.find((body) => body.split('\n')[0] === `### ${part}`) ?? null;
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

  it('declares all six activities as their own `## <activity>` section', () => {
    for (const activity of ['plan-authoring', 'plan-execution', 'routine', 'feedback-triage', 'epic', 'task']) {
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
    for (const anchor of ['Module ledger', 'What gets cut', 'Un-run syntax never ships in prose', 'The plan must read cold', "Cleanup, and the plan's own life", 'The epic', 'The task']) {
      assert.ok(flat.includes(`*${anchor}*`), `names the planning.md anchor *${anchor}*`);
      assert.ok(headings.includes(anchor), `planning.md still carries the heading "${anchor}"`);
    }
    assert.doesNotMatch(flat, /planning\.md\)? ?§/, 'no numbered pointer into planning.md');
    // "Without restating": neither the retired vocabulary nor the ledger row grammar is re-defined here.
    assert.ok(!procedures.includes('Substep'), 'does not restate the Plan→Phase→Step→Substep vocabulary');
    assert.ok(!procedures.includes('<check-id>'), 'does not restate the planning.md ledger row grammar');
  });

  // Set-1 coverage (Phase 3 consistency invariant): every cross-all-four regression-free / convergence
  // token must live in the procedures region (`## plan-authoring` onward), as it lives in the lens theme
  // (lens-fragment.test.mjs pins the theme's tokens).
  it('lands the cross-all-four regression-free + convergence tokens in the procedures region (Set-1)', () => {
    const start = procedures.indexOf('## plan-authoring');
    assert.notEqual(start, -1, 'has a plan-authoring region');
    const region = procedures.slice(start).toLowerCase();
    for (const token of [
      '0 blockers + 0 majors', 'test-as-spec', 'no code-mechanics', 'at the diff', 'characterize-first',
      // Review-loop economics (M2/M3/M4/M5-b) — the same five the lens theme carries.
      '≤2 rounds', 'crossover', 'backend divergence', 'diff-review', 'self-consistency',
      // Checked-vs-unchecked boundary (the §9 B5 sharpening) — the same two strings the lens theme carries.
      'checked syntax', 'logic-bearing',
    ]) {
      assert.ok(region.includes(token), `procedures region carries the "${token}" token`);
    }
  });

  // M6 (queue.md third leg — advisor + procedures.md canon step + a token guard): the required per-round
  // structured emission {round N · finding-origin tally · per-backend verdict} is pinned in the per-round
  // loop point of BOTH activities so the canon step cannot be silently deleted from EITHER section, nor
  // any one of its three fields dropped, with tests green. (M6 is not §9-native, so it is a Set-2 lens
  // token, not a cross-all-four Set-1 one.)
  it('pins the M6 per-round emission (round N · finding-origin · per-backend verdict) in BOTH activity sections', () => {
    for (const activity of ['plan-authoring', 'plan-execution']) {
      const section = sectionOf(procedures, activity);
      assert.match(section, /round N/, `${activity} §5 requires the per-round emission (round N)`);
      assert.match(section, /finding-origin/i, `${activity} §5 emits a finding-origin tally`);
      assert.match(section, /per-backend verdict/i, `${activity} §5 emits a per-backend verdict`);
    }
  });

  // The finding-scope rule is plan-execution-only; `stepOf` is declared below.
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

  it('pins the walk-around and second-case sentences in only their owning activity', () => {
    const walk = 'The review brief of EVERY member (bridge focus, agy `--facts`, the lens brief) carries the walk-around lens: for every check bullet of each governing spec, name the invariant it proves and one state that walks around it; a named state rewrites the spec BEFORE code, as a `modify` row of the plan.';
    const bar2 = 'a repeat finding in one subarea routes to SUBTRACTION, not a fourth patch.';
    const second = 'When the repeat finding named by bar 2 is a second case against the same check bullet, the fold proposes the REPLACEMENT invariant — the closing clause — never an added case, and its consult asks for it.';
    const authoring = sectionOf(procedures, 'plan-authoring');
    const execution = sectionOf(procedures, 'plan-execution');
    assert.ok(stepOf(authoring, 4).replace(/\s+/g, ' ').includes(walk));
    assert.ok(!authoring.includes(second));
    const step5 = stepOf(execution, 5).replace(/\s+/g, ' ');
    assert.ok(step5.includes(bar2));
    assert.ok(step5.includes(second));
    assert.ok(step5.indexOf(second) > step5.indexOf(bar2), 'the second-case sentence follows bar 2 inside step 5');
    assert.ok(!execution.includes(walk));
  });

  // Extract numbered step N of a section (the "N. **…**" line up to the next "M. " line) — a review
  // rule must live in the REVIEW step itself, not merely somewhere in the section.
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

  it('the plan-execution review STEP (5) names the degrade record and the final-gate instruments (incl. commit-guard --check); plan-authoring never does', () => {
    const execStep5 = stepOf(sectionOf(procedures, 'plan-execution'), 5).replace(/\s+/g, ' ');
    for (const token of ['core-evidence degrade', 'run-gates --final', 'commit-guard --check']) assert.ok(execStep5.includes(token), `plan-execution step 5 names "${token}"`);
    const auth = sectionOf(procedures, 'plan-authoring');
    assert.ok(!auth.includes('run-gates --final') && !auth.includes('review-ledger'), 'plan-authoring points at neither the plan-execution loop instruments nor the retired ledger');
  });

  it('spec:held-session/S6 pins that plan-execution step 5 names no held id, no substitution and no fold brief', () => {
    const execution = sectionOf(procedures, 'plan-execution');
    const step5 = stepOf(execution, 5).replace(/\s+/g, ' ');
    const start = step5.indexOf(HELD_SESSION_SENTENCE_GROUP.start);
    const end = step5.indexOf(HELD_SESSION_SENTENCE_GROUP.end, start);
    assert.ok(start !== -1 && end !== -1, 'S6: step 5 keeps the group between its two anchors');
    const group = step5.slice(start, end + HELD_SESSION_SENTENCE_GROUP.end.length);
    for (const [name, pattern] of [['a held id', /held id/i], ['a substitution', /substitution/i], ['<fold-brief>', /<fold-brief>/], ["a hold until the row's commit", /held until the row's commit/]]) {
      assert.doesNotMatch(step5, pattern, `S6: step 5 still names ${name}`);
    }
    for (const token of ['--resume', 'runs the suites', 'owns the commit']) assert.ok(group.includes(token), `S6: the fold group lost ${token}`);
    assert.equal(slotsLineOf(execution), 'Slots: execute, review');
    assert.deepEqual([...execution.matchAll(/^(\d+)\. /gmu)].map((match) => Number(match[1])), [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('spec:plan-structure/S9 plan-execution pins coverage-to-brief order and review amendments, and planning caps the approved part and defines amendments', () => {
    const execution = sectionOf(procedures, 'plan-execution');
    const step2 = stepOf(execution, 2).replace(/\s+/g, ' ');
    const structureCommand = 'plan-structure/cli.mjs';
    const positions = ['--coverage', 'fix the tags', `${structureCommand} <plan>`, 'generated robustness-literals block'].map((token) => step2.indexOf(token));
    assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])), `coverage, tags, structure command, block order: ${positions.join(' < ')}`);
    assert.ok(step2.indexOf('Otherwise implement directly.') < step2.indexOf('The dispatch brief'), 'direct implementation precedes the dispatch brief');
    assert.doesNotMatch(step2, /plan-shape --check/);
    const step5 = stepOf(execution, 5).replace(/\s+/g, ' ');
    assert.match(step5, /before each diff-review or re-check brief\b.*?`node <kit>\/tools\/plan-structure\/cli\.mjs <plan>` exits 0/i);
    assert.match(step5, /\blists every amendment entry it prints\b/);
    const planning = readFileSync(join(ROOT, 'references', 'planning.md'), 'utf8');
    const shape = sectionOf(planning, 'Shape').replace(/\s+/g, ' '); assert.match(shape, /A plan's approved part is capped at \*\*100 lines and at most 45 ledger rows\*\*/); assert.doesNotMatch(shape, /The whole file is capped at/);
    const amendmentParagraphs = sectionOf(planning.slice(planning.lastIndexOf('\n## Module ledger\n')), 'Module ledger').split(/\n\s*\n/).filter((paragraph) => paragraph.includes('`amendments:`'));
    assert.equal(amendmentParagraphs.length, 1, 'Module ledger has exactly one `amendments:` paragraph');
    const amendment = amendmentParagraphs[0].replace(/\s+/g, ' ');
    assert.ok(amendment.includes(`${structureCommand} <plan>`));
    assert.match(amendment, /\breturn\w* to the spec review\b/i);
    assert.match(amendment, /\bno new (?:approval|yes)\b/i);
    assert.doesNotMatch(amendment, /\b(?:budgets?|(?:size|tolerance) bands?|rais(?:e[sd]?|ing))\b|--write-baseline/i);
  });

  it('spec:plan-review-loop/S48 plan-authoring checks the exact plan before each review brief and approval and carries the current note', () => {
    const authoring = sectionOf(procedures, 'plan-authoring');
    const review = stepOf(authoring, 4).replace(/\s+/g, ' ');
    const approval = stepOf(authoring, 6).replace(/\s+/g, ' ');
    assert.match(approval, /plan-shape-cli\.mjs --check <plan>.*?\bpresent\w*\b/i, 'step 6 checks the exact plan before presenting it');
    assert.match(review, /plan-shape-cli\.mjs --check <plan>.*?\bbrief\b/i, 'step 4 names the exact-plan check before its brief');
    assert.match(review, /\bbefore\b[^.]*\b(?:each|every)\b[^.]*\bbrief\b/i, 'the check precedes each review brief');

    const printedNote = /\b(?=[^.!?]*\b(?:carr\w*|includ\w*|present\w*)\b)(?=[^.!?]*\bprint\w*\b)[^.!?]*\bnote\b/i;
    assert.match(review, printedNote, 'the brief carries the note printed by its check');
    assert.match(approval, printedNote, 'the approval carries the note printed by its check');
    const dropsEarlierNote = /\b(?=[^.!?]*\bdrop\w*\b)(?=[^.!?]*\bearlier\b)(?=[^.!?]*\bnote\b)[^.!?]*\bprint\w* (?:none|nothing|no note)\b/i;
    assert.match(review, dropsEarlierNote, 'step 4 drops an earlier note when its check prints none');
    assert.match(approval, dropsEarlierNote, 'step 6 drops an earlier note when its check prints none');
  });

  it('spec:story-flow/S22 Draft decides layout before implementation code and judges size at the diff', () => {
    const section = sectionOf(procedures, 'plan-authoring');
    const draft = stepOf(section, 2).replace(/\s+/g, ' ');
    assert.match(draft, /\*Module ledger\*/, 'the Draft step points at the ledger');
    assert.match(stepOf(section, 3).replace(/\s+/g, ' '), /\*What gets cut\*/, 'the Self-review step applies the subtraction rubric');
    assert.doesNotMatch(sectionOf(procedures, 'plan-execution'), /Module ledger/, 'the layout rule lives in plan-authoring');
    assert.match(draft, /\*Module ledger\*[^.]*\b(?:decides|determines|sets|settles)\b[^.]*\blayout\b[^.]*\bbefore any implementation code is written\b/i);
    assert.match(draft, /\b(?:judg\w*[^.]*\bsize|size\b[^.]*\bjudg\w*)\b[^.]*\bat the diff\b/i);
    assert.match(draft, /\bnever in a plan\b/i);
    assert.doesNotMatch(draft, /\b(?:budgets?|backstops?)\b/i);
  });

  it('plan-authoring step 3 opens with the readers sweep before its existing checks', () => {
    const step3 = stepOf(sectionOf(procedures, 'plan-authoring'), 3).replace(/\s+/g, ' ');
    assert.match(step3, /^3\. \*\*Self-review\*\* — run the \*\*readers sweep before the first review\*\*/u);
    for (const token of ['config key', 'registry entry', 'exported constant', 'receipt field', 'canon sentence', 'ledger row', 'stated non-goal', 'unchanged']) {
      assert.ok(step3.includes(token), `readers sweep names ${token}`);
    }
  });

  it('both step 5s ASK each raising member ONE ask per round, WAIT and READ before the fold edit, with no armed sequence or round render (spec:plan-review-loop/S18)', () => {
    for (const activity of ['plan-authoring', 'plan-execution']) {
      const step5 = stepOf(sectionOf(procedures, activity), 5).replace(/\s+/g, ' ');
      for (const token of ['raised by a **review member**', 'ASK', 'WAIT', 'READ', 'accepted or corrected', 'folded directly']) assert.ok(step5.includes(token), `${activity} names ${token}`);
      if (activity === 'plan-authoring') {
        for (const [reason, pattern] of [['one ask per member', /\bONE ask\b/i], ['one ask per round', /\bper round\b/i], ["all of that member's findings with their proposed folds", /\ball\b[^.]*\bfindings\b[^.]*\bproposed folds\b/i]]) assert.match(step5, pattern, `the fold ask is not ${reason}`);
        for (const token of ['`agy-review --continue --decided @f` for agy', '`codex-review plan <consult-brief>` for codex', 'a fresh re-dispatch of the same lens vehicle for a lens member']) assert.ok(step5.includes(token), `the consult form carries ${token}`);
        for (const token of ['resolved `fold` carrier', 'Solo', 'Subagent', "round's findings with their dispositions", 'self-consistency read']) assert.ok(step5.includes(token), `the explicit authoring fold carrier names ${token}`);
      }
      assert.ok(step5.indexOf('ASK') < step5.indexOf('WAIT') && step5.indexOf('WAIT') < step5.indexOf('READ') && step5.indexOf('READ') < step5.indexOf('accepted or corrected'), `${activity} consult order`);
      for (const token of ['round render', 'review-rounds', 'ARMED flow', 'consult-attestation', 'internal-attestation', '--proposed-fix-digest', 'round-open']) assert.ok(!step5.includes(token), `${activity} step 5 still names the round render or the armed sequence (${token})`);
    }
  });

  // Cost lanes (cost-tiered execution): the kit advisor renders an unconditional cost-lane block
  // that PARAPHRASES orchestration.md §5 — pin the same distinctive tokens in the CANON here
  // (the kit side pins them in the advisor output, procedures.test.mjs), so the paraphrase and
  // the canon cannot silently drift apart.
  it('the orchestration.md §5 canon carries the cost-lane tokens the kit advisor paraphrases', () => {
    const orchestration = readFileSync(join(ROOT, 'references', 'orchestration.md'), 'utf8');
    // The last five are the D7 prompt-economy invariants (REC-UX-REWORK) — one distinctive token
    // per invariant, pinned on all three surfaces (canon here · kit advisor · lens theme).
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
    // The generic deferral phrase ("project-declared release/publishing … outside the workflow:kit block")
    // is REQUIRED, the retired slot named nowhere; the concrete enforcement (skill names, a mandatory
    // Release-Publishing phase) is a project overlay and must NOT appear in the engine canon.
    assert.deepEqual([/outside the `workflow:kit`\s+block/.test(procedures), /workflow:methodology/.test(procedures)], [true, false], 'defers project stages to the project text outside the kit block, never the retired slot');
    // Rows are the steps, but Cleanup is a PHASE, not a row: plan-execution must close with the
    // project-declared stages and then Phase: Cleanup, in that order, or neither is guaranteed to run.
    const closing = stepOf(sectionOf(procedures, 'plan-execution'), 8);
    const atStages = closing.indexOf('workflow:kit');
    const atCleanup = closing.indexOf('Phase: Cleanup');
    assert.ok(atStages !== -1 && atCleanup !== -1 && atStages < atCleanup, 'plan-execution closes with the project stages, then Phase: Cleanup');
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

  describe('spec:stage-render/S8 the start recovery, new parts, recorded approval and dispatch part', () => {
    it('the start renders the next-session line and names every recovery trigger', () => {
      const start = procedures.split(/^## /m)[0].replace(/\s+/g, ' ');
      assert.match(start, /\brender\w*\b[^.]*\bnext[- ]session\b|\bnext[- ]session\b[^.]*\brender\w*\b/i);
      for (const phrase of [
        /\brecover\w*\b/i, /\b(?:no|absent|missing)\b[^.;]*\b(?:section|Next session)\b/i, /\bfree[- ]text\b/i,
        /\bslot file\b[^.]*\b(?:absent|missing)\b/i, /\bslot file\b[^.]*\brefus\w*\b/i,
        /\brecord-gated\b[^.]*\b(?:no matching record|no record match\w*|record does not match)\b/i,
        /\b(?:another|different|wrong) plan\b/i, /\b(?:another|different|wrong) (?:plan(?: or| and) (?:another )?)?stage\b/i,
      ]) assert.match(start, phrase);
    });

    it('the recovery writes waiting-on-approval without a matching record, tests by default with a match, and the named stage otherwise', () => {
      const start = procedures.split(/^## /m)[0].replace(/\s+/g, ' ');
      assert.match(start, /\bwaiting-on-approval\b[^.]*\b(?:no matching record|no record match\w*|without a match)\b|\b(?:no matching record|no record match\w*|without a match)\b[^.]*\bwaiting-on-approval\b/i);
      assert.match(start, /\b(?:matching record|record matches|with a match)\b[^.]*\btests\b|\btests\b[^.]*\b(?:matching record|record matches|with a match)\b/i);
      assert.match(start, /\btests\b[^.]*\b(?:none|no stage|default)\b|\b(?:none|no stage|default)\b[^.]*\btests\b/i);
      assert.match(start, /\b(?:not record-gated|non-record-gated)\b[^.]*\b(?:as named|named stage|opened for)\b/i);
      assert.match(start, /\b(?:no plan|name[s]? no plan)\b[^.]*\b(?:as named|named stage|opened for)\b/i);
      assert.match(start, /\bwriter\b|--write\b/i);
      assert.match(start, /\b(?:never|not)\b[^.]*\boverwrite\w*\b/i);
      assert.match(start, /\bempty-queue\b[^.]*\b(?:user|maintainer)\b[^.]*\bno work\b|\b(?:user|maintainer)\b[^.]*\bno work\b[^.]*\bempty-queue\b/i);
    });

    for (const [activity, part] of [['epic', 'Design consult'], ['plan-execution', 'Split']]) {
      it(`${activity} contains the ${part} part with steps 1–4 and no Slots line`, () => {
        const body = sectionOf(procedures, activity, part);
        assert.ok(body, `### ${part} inside ## ${activity}`);
        assert.deepEqual([...body.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1])), [1, 2, 3, 4]);
        assert.doesNotMatch(body, /^\s*Slots:/m);
        assert.deepEqual([...procedures.matchAll(/^## (.+)$/gm)].map((match) => match[1]), ['plan-authoring', 'plan-execution', 'routine', 'feedback-triage', 'epic', 'task']);
      });
    }

    it('authoring steps 2 and 3 name the scenario instead of writing a test before approval and sweep by name and value', () => {
      const draft = flatStep('plan-authoring', 2);
      assert.match(draft, /\b(?:no|never|not)\b[^.]*\btest\b[^.]*\bapproval\b|\bbefore (?:the )?approval\b[^.]*\b(?:no|never|not)\b[^.]*\btest\b/i);
      assert.match(draft, /\bfold\w*\b[^.]*\bscenario\b|\bscenario\b[^.]*\bfold\w*\b/i);
      const sweep = flatStep('plan-authoring', 3);
      assert.match(sweep, /by (?:its )?name and by (?:its )?value/i);
      assert.match(sweep, /(?:bounded|limited|only|every reader)[^.]*\b(?:search|instrument|tool)\b[^.]*\b(?:lists?|returns?|finds?)\b/i);
    });

    it('authoring step 6 presents the essence and records the yes; Definition of Done names the record and next-session line', () => {
      const approval = flatStep('plan-authoring', 6);
      assert.match(approval, /\b(?:present|show)\w*\b[^.]*\bessence\b/i);
      assert.match(approval, /\byes\b.*plan-approval\/cli\.mjs record\b|plan-approval\/cli\.mjs record\b.*\byes\b/i);
      const done = sectionOf(procedures, 'plan-authoring').split('Definition of Done')[1] ?? '';
      for (const phrase of [/approval record/i, /next-session line/i, /without the user asking/i, /Phase: Cleanup/]) assert.match(done, phrase);
    });

    for (const [activity, step, prompt] of [['plan-execution', 2, 'brief'], ['plan-execution', 5, 'fold prompt'], ['task', 1, 'prompt']]) {
      it(`${activity} step ${step} carries the dispatch part in its ${prompt}`, () => {
        assert.match(flatStep(activity, step), /aw-plan-approval|stage-render\/cli\.mjs --dispatch\b/);
      });
    }
  });

  it('pins the communication contract (deliver the artifact inline; never a bare pointer as a substitute)', () => {
    const flat = procedures.replace(/\s+/g, ' ');
    assert.match(flat, /Communication contract/i);
    assert.match(flat, /delivers the artifact \*\*inline\*\*/, 'deliver the artifact inline');
    assert.match(procedures, /see §X/, 'names the banned bare-pointer anti-pattern');
  });

  describe('spec:carriers/S10 — the author slots dispatch the author vehicle under the agent-list condition', () => {
    const assertAuthorDispatch = (arm) => {
      assert.match(arm, /\bauthor vehicle\b/i, 'the author vehicle carries the authoring slice');
      assert.match(arm, /orchestration\.md[^.]*§4|§4[^.]*orchestration\.md/i, 'the dispatch points to orchestration.md §4');
      assert.match(arm, /\bcondition\b|\bagent[- ]list\b/i, 'the reference is to the agent-list condition');
    };

    it('plan-authoring step 2 drafts the plan and spec rows on the author vehicle; the execution branch rides beside Delegated', () => {
      const draft = stepOf(sectionOf(procedures, 'plan-authoring'), 2).replace(/\s+/g, ' ');
      assert.match(draft, /The resolved `author` carrier drafts/, 'the Draft step resolves the author carrier');
      assert.match(draft, /Solo: the orchestrator writes it/, 'the Solo arm writes the plan itself');
      assert.match(draft, /Subagent: the orchestrator writes a BRIEF/, 'the Subagent arm starts from a brief');
      assert.match(draft, /goal, governing specs, ledger\s+constraints, files/, 'what the brief carries');
      assert.match(draft, /drafts the plan and any `create` \/ `modify` spec row from it/, 'the author vehicle drafts the plan and its spec rows');
      assertAuthorDispatch(draft.split('Subagent:')[1] ?? '');
      assert.match(draft, /reviews the draft as its own before step 3/, 'the orchestrator owns the draft it accepts');
      const dispatch = stepOf(sectionOf(procedures, 'plan-execution'), 2).replace(/\s+/g, ' ');
      assert.match(dispatch, /\*\*If `execute` resolved to Subagent\*\*, split the ledger into file-disjoint slices/, 'the subagent branch splits the ledger');
      assert.match(dispatch, /exact wording where wording is a red line/, 'wording is copied where it is a red line');
      assert.match(dispatch, /the executor vehicle in the background/, 'the dispatch is backgrounded');
      assert.match(dispatch, /verify every returned slice by running its suites yourself before step 3/, 'the orchestrator verifies every returned slice');
    });

    it('plan-authoring step 5 folds the round on the author vehicle', () => {
      const fold = stepOf(sectionOf(procedures, 'plan-authoring'), 5).replace(/\s+/g, ' ');
      const arm = (fold.split('Subagent:')[1] ?? '').split('CLEAN')[0];
      assert.match(arm, /round's findings with their dispositions/, 'the slice is the round and its dispositions');
      assertAuthorDispatch(arm);
    });

    it('epic step 2 drafts from the brief on the author vehicle', () => {
      const draft = stepOf(sectionOf(procedures, 'epic'), 2).replace(/\s+/g, ' ');
      const arm = draft.split('Subagent:')[1] ?? '';
      assert.match(arm, /the orchestrator writes the brief of step 1/, 'the orchestrator supplies the brief');
      assertAuthorDispatch(arm);
    });
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

  describe('epic and task canon (spec:carriers/S17)', () => {
    it('task carries its slots and the four steps Prompt, Execute, Verify, Return, with no retired tool and no held session (spec:carriers/S21)', () => {
      const section = sectionOf(procedures, 'task'); assert.ok(section, 'has a ## task section');
      assert.equal(slotsLineOf(section), 'Slots: author, execute'); assert.deepEqual([...section.matchAll(/^(\d+)\. /gmu)].map((match) => Number(match[1])), [1, 2, 3, 4], 'S21: task has four steps');
      for (const [number, token] of ['Prompt', 'Execute', 'Verify', 'Return'].entries()) assert.ok(stepOf(section, number + 1).replace(/\s+/g, ' ').includes(`**${token}**`), `S21: step ${number + 1} names ${token}`);
      const flat = section.replace(/\s+/g, ' '); const ret = stepOf(section, 4).replace(/\s+/g, ' ');
      for (const token of ['*The task*', 'no commit boundary', "row's tests"]) assert.ok(flat.includes(token), `S21: task names ${token}`);
      for (const [name, pattern] of [['checkpoint', /checkpoint/i], ['task-brief', /task-brief/], ['stamp', /\bstamp\b/], ['dispatch open', /dispatch open/], ['--dispatch', /--dispatch\b/], ['a held session', /held[- ]session/i], ["a brief's chain", /chain/]]) assert.doesNotMatch(flat, pattern, `S21: task still names ${name}`);
      for (const token of ['--resume', 'exec receipt']) assert.ok(ret.includes(token), `S21: Return folds on the run's receipt session (${token})`);
    });
    it('keeps epic and task after feedback-triage and project-neutral', () => {
      assert.deepEqual([...procedures.matchAll(/^## (.+)$/gmu)].map((match) => match[1]).slice(-3), ['feedback-triage', 'epic', 'task']);
      for (const activity of ['epic', 'task']) {
        const section = sectionOf(procedures, activity); assert.ok(section, `has a ## ${activity} section`);
        assert.doesNotMatch(section, /docs\/|agent-workflow-kit\/|agent-workflow-engine\//u, `${activity} stays project-neutral`);
      }
    });
    it('plan-execution step 2 names each prompt and each run of a row carried as tasks and keeps the row boundary', () => {
      const section = sectionOf(procedures, 'plan-execution'); assert.ok(section, 'has a ## plan-execution section');
      const step2 = stepOf(section, 2).replace(/\s+/g, ' ');
      for (const token of ['When a row is carried as tasks', 'each prompt and each run']) assert.ok(step2.includes(token), `S17: step 2 names ${token}`);
      assert.ok(!step2.includes('each brief'), 'S17: step 2 still carries each brief');
    });
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

  // story-flow's review-loop part: one fold ask per member per round, the raiser's re-read of a
  // last-round fold, the re-check of a moved staged tree, one commit after the diff review.
  const flatStep = (activity, n) => stepOf(sectionOf(procedures, activity), n).replace(/\s+/g, ' ');
  const holds = (text, scenario, present, absent = []) => {
    for (const [reason, pattern] of present) assert.match(text, pattern, `${scenario}: ${reason}`);
    for (const [reason, pattern] of absent) assert.doesNotMatch(text, pattern, `${scenario}: ${reason}`);
  };
  const LAST_ROUND_RE_READ = ['a fold of the last round is not re-read', /\blast round\b[^.]*\bre-read\b|\bre-read\b[^.]*\blast round\b/i];
  it('spec:story-flow/S11 plan-authoring step 5 reads round two over the folded artifact, has a last-round fold re-read by its raiser or sent to the maintainer, and names no third round, round render or cap triage', () => holds(flatStep('plan-authoring', 5), 'S11', [
    ['step 5 names no round two', /\bround two\b|\bsecond round\b|\bround 2\b/i], ['round two does not read the folded artifact', /\bfolded (artifact|spec)\b/i],
    ['round two does not read the decided register', /\bdecided register\b/i], ["round two does not read each fold's diff", /\bfold's diff\b|\bfold diffs?\b|\bdiff of each fold\b/i], LAST_ROUND_RE_READ,
    ['the re-read is not by the member that raised the finding', /\bre-reads?\b[^.]*\b(raiser|member that raised it|that member)\b|\b(raiser|member that raised it|that member)\b[^.]*\bre-reads?\b/i],
    ['an unresolved fold does not go to the maintainer', /\bmaintainer\b/], ['resolving at altitude is not such a fold', /\bat altitude\b[^.]*\bfold\b/i], ['step 5 allows a third round', /\bno third round\b/i],
  ], [['step 5 still names the round render', /round render|review-rounds/i], ['step 5 still carries the cap triage', /fixable-bug|inherent-layer-residual|\*\*escalate\*\*/]]));

  it('spec:story-flow/S12 plan-execution step 5 reviews the staged diff with the fold ask, the last-round re-read and a re-check of a moved tree by every member, and names no armed sequence, walk, flow disposition or red-proof record', () => {
    holds(flatStep('plan-execution', 5), 'S12', [
      ["step 5 does not review the story's staged diff", /\bstaged diff\b/], ['step 5 does not apply the fold ask', /\bfold ask\b|\bONE ask\b/i], LAST_ROUND_RE_READ,
      ['the re-check is not of a tree that moves', /\bre-check[^.]*\bmov(es|ed)\b|\bmov(es|ed)\b[^.]*\bre-check/i],
      ['the re-check is not run by every member, the lens included', /re-check[^.]*\bevery member\b[^.]*\blens\b|\bevery member\b[^.]*\blens\b[^.]*re-check/i], ['the brief does not list every test changed since the recorded tree', /`git diff --cached --name-only <recorded tree>`/], ["the brief does not carry each test's text before and after, its scenario line and its red run", /\btext before and after, its scenario line and its red run\b/],
    ], [['step 5 still names an armed sequence', /ARMED flow|consult-attestation|internal-attestation|--proposed-fix-digest|round-open/], ['step 5 still owes a walk', /--walk\b|owes a walk/],
      ['step 5 still names a flow disposition', /custody-lost|`queued`|`escalated`|`rejected`|cap reached/], ['step 5 still names a red-proof record', /core-evidence red-proof|red-proofs/]]);
  }); // S12's unchanged step numbers and Slots line: the held-session S6 cell above

  it("spec:story-flow/S13 plan-execution runs steps 1-4 per row and steps 5-7 once on the staged diff, no row commits, and step 8's stages write before step 5", () => {
    holds(procedures.replace(/\s+/g, ' '), 'S13', [], [['plan-execution still commits per ledger row', /commits per ledger row|Each ledger row is one logical commit/i]]);
    holds(sectionOf(procedures, 'plan-execution').replace(/\s+/g, ' '), 'S13', [['steps 1-4 do not run per row', /steps 1 (to|–|-) ?4[^.]*\bper row\b/i], ['steps 5-7 do not run once on the staged diff', /steps 5 (to|–|-) ?7[^.]*\bonce\b[^.]*\bstaged diff\b/i]]);
    holds(flatStep('plan-execution', 2), 'S13', [], [["step 2 still keeps the row's commit", /\bcommit\b/]]);
    holds(flatStep('plan-execution', 8), 'S13', [["step 8's stages do not write their outputs before step 5", /\bbefore step 5\b/]], [['step 8 still runs its stages through steps 1-7', /each through steps 1.7/]]);
  });

  it('spec:story-flow/S15 the epic keeps Brief, Draft, Check, the review, Fold (at most two rounds) and Land, the review one lens over the rendered brief whatever its slot resolves to', () => {
    const section = sectionOf(procedures, 'epic');
    assert.equal(slotsLineOf(section), 'Slots: author, review', 'S15: the Slots line changed');
    assert.deepEqual([...section.matchAll(/^(\d+)\. /gmu)].map((match) => Number(match[1])), [1, 2, 3, 4, 5, 6], 'S15: the epic lost a step');
    for (const [number, token] of ['Brief', 'Draft', 'Check', 'review', 'Fold', 'Land'].entries()) assert.ok(flatStep('epic', number + 1).includes(token), `S15: step ${number + 1} names ${token}`);
    for (const token of ['*The epic*', 'no commit boundary of its own', 'epic-shape-cli --check <epic>', 'epic-shape-cli --review-brief <epic>', 'never the file', 'epic-shape-cli --fold', 'At most two rounds', '--close']) assert.ok(section.replace(/\s+/g, ' ').includes(token), `S15: epic names ${token}`);
    holds(flatStep('epic', 4), 'S15', [['the epic review is not one lens', /\b(one|a single) review[- ]lens\b|\b(the|a) lens alone\b/i], ['the lens review depends on what the review slot resolves to', /\bwhatever `?(epic\.)?review`? resolves to\b/]],
      [['step 4 still hands the brief to a bridge or to every member', /a bridge in plan mode|pays them|every member/]]);
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
    assert.ok(!slot.includes('workflow:'), 'the fragment must not contain a workflow marker name');
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

  it('names all six activities in order', () => {
    assert.ok(slot.replace(/\s+/g, ' ').includes('(plan-authoring, plan-execution, routine, feedback-triage, epic, task)'), 'the slot names all six activities in order');
  });

  it('carries the §1.9 communication-contract clause', () => {
    assert.match(slot, /Communication/, 'the methodology slot carries the Communication clause');
    assert.match(slot, /inline/, 'the clause says deliver the artifact inline');
  });
});
