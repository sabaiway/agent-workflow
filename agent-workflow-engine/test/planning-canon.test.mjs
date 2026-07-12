import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLANNING = join(ROOT, 'references', 'planning.md');

const planning = readFileSync(PLANNING, 'utf8');

const sectionOf = (text, headingPattern) => {
  const match = text.match(headingPattern);
  if (!match) return '';
  const rest = text.slice(match.index);
  const next = rest.slice(match[0].length).search(/\n## /);
  return next === -1 ? rest : rest.slice(0, match[0].length + next);
};

describe('planning.md — right-altitude/code-grounded canon', () => {
  it('carries §9 with all three discipline elements', () => {
    assert.match(planning, /^## 9\..*right-altitude.*code-grounded folds/im);

    const section9 = sectionOf(planning, /^## 9\..*$/im);
    assert.match(section9, /altitude/i);
    assert.match(section9, /invariant/i);
    assert.match(section9, /acceptance/i);
    assert.match(section9, /fold by code/i);
    assert.match(section9, /`file:line`/);
    assert.match(section9, /convergence/i);
    assert.match(section9, /raise/i);
    assert.match(section9, /Execute/);
  });

  it('adds the code-grounded §8 self-review bullet', () => {
    const section8 = sectionOf(planning, /^## 8\..*$/im);

    assert.match(section8, /file:line/);
    assert.match(section8, /altitude/i);
  });

  // AD-038: the optional Decisions-(locked) home for review-settled, executor-binding decisions —
  // one §7 structure row + one §8 checklist mention (grounding.mjs extracts the section by this
  // exact heading, so the heading string is load-bearing).
  it('carries the optional §7 "Decisions (locked)" row + its §8 checklist mention (AD-038)', () => {
    // §7's skeleton lives inside a code fence whose lines start with `## `, so sectionOf would
    // truncate it — pin the exact row line on the whole document instead (the heading string is
    // load-bearing: grounding.mjs extracts the section by trimmed-line equality).
    assert.match(planning, /^## Decisions \(locked\)\s+← optional: .*re-litigate/m, 'the §7 skeleton row: exact heading, optional, executor-binding');
    assert.ok(
      planning.indexOf('## Decisions (locked)') > planning.indexOf('## Approach             ←'),
      'the row sits after Approach in the §7 skeleton',
    );
    const section8 = sectionOf(planning, /^## 8\..*$/im);
    assert.match(section8, /Decisions \(locked\)/, 'the §8 checklist routes settled decisions there');
    assert.match(section8, /never re-litigated/i, 'binding for the executor');
  });

  // A1 (process-fidelity): §6 is the home of the plan-then-execute boundary, so the
  // ExitPlanMode-≠-execute clause + the §6↔Definition-of-Done disambiguation are pinned here (NOT §9,
  // so A1 is intentionally not a lens-mirror token — see lens-mirror.test.mjs).
  it('carries the §6 ExitPlanMode-≠-execute boundary (A1)', () => {
    const section6 = sectionOf(planning, /^## 6\..*$/im);
    assert.match(section6, /ExitPlanMode/);
    assert.match(section6, /authoriz/i);
    assert.match(section6, /plan-execution/);
    assert.match(section6, /deliberate/i);
    // Pin the load-bearing SEMANTICS, not just the keywords — so the clause can't keep the words while
    // losing "authorizes the plan only / not a licence to execute / emit the cold-start prompt".
    assert.match(section6, /PLAN only/);
    assert.match(section6, /cold-start execution prompt/i);
    assert.match(section6, /licence to execute|license to execute|not a licence|not a license/i);
  });

  // A3 + B4–B7 (convergence bar + regression-free editing): the §9-native review/fold disciplines,
  // pinned by their distinctive cross-all-four tokens (same strings lens-mirror.test.mjs pins).
  it('carries the §9 convergence-bar + regression-free invariants (A3, B4–B7)', () => {
    const section9 = sectionOf(planning, /^## 9\..*$/im);
    assert.match(section9, /0 blockers \+ 0 majors/i); // A3 convergence bar
    assert.match(section9, /test-as-spec/i); // B4
    assert.match(section9, /no code-mechanics/i); // B5
    assert.match(section9, /at the diff/i); // B6
    assert.match(section9, /characterize-first/i); // B7
    // B5 sharpening (checked-vs-unchecked boundary) — same two strings lens-mirror.test.mjs pins.
    assert.match(section9, /checked syntax/i); // checked = asserted by the plan's own Verification
    assert.match(section9, /logic-bearing/i); // un-run, logic-bearing syntax never lives in plan prose
  });

  // Review-loop economics (M2/M3/M4/M5-b): the round cap + crossover already lived in §9 but were
  // token-unguarded here; the backend-divergence stop, the thin-plan/diff-review carve-out, and the
  // self-consistency fold discipline are the new §9-native tokens. Same strings lens-mirror.test.mjs pins.
  it('carries the §9 review-loop-economics tokens (round cap, crossover, divergence, diff-review, self-consistency)', () => {
    const section9 = sectionOf(planning, /^## 9\..*$/im);
    assert.match(section9, /≤2 rounds/); // architecture round cap
    assert.match(section9, /crossover/i); // the crossover stop
    assert.match(section9, /backend divergence/i); // M3 — divergence IS the crossover
    assert.match(section9, /diff-review/i); // M5-b — thin plan + diff-review for all-mechanics/prose-only
    assert.match(section9, /self-consistency/i); // M4 — self-consistency read before every re-review
  });

  // AD-046: §9 names the review-round LEDGER as the plan-execution computed instrument for the
  // crossover-stop (point, don't restate — the exit contract's single home stays the tool header),
  // and states the same tally + classification discipline for plan-authoring neutrally.
  it('carries the §9 ledger naming (the plan-execution computed instrument) + the classification vocabulary', () => {
    const section9 = sectionOf(planning, /^## 9\..*$/im);
    assert.match(section9, /review-ledger/); // the computed instrument, named
    // The SCOPE semantics, not just token co-presence: the ledger is pinned as plan-execution-scoped,
    // so a future edit widening it to plan-authoring cannot stay green.
    assert.match(section9, /ledger itself is plan-execution-scoped/, '§9 pins the plan-execution-only scope');
    for (const token of ['fixable-bug', 'inherent-layer-residual', 'escalate']) {
      assert.ok(section9.includes(token), `§9 carries the classification token "${token}"`);
    }
  });

  // AD-044 Plan 4: the trailing §10 — autonomy at the plan checkpoints. Appended, never
  // renumbering; the checkpoints are FIXED and the policy only changes the texture between them.
  it('carries the trailing §10 autonomy-at-checkpoints canon (AD-044 Plan 4)', () => {
    const flat = sectionOf(planning, /^## 10\..*$/im).replace(/\s+/g, ' ');
    assert.match(flat, /Autonomy at the plan checkpoints/i);
    assert.match(flat, /fixed points the autonomy policy never moves/i, 'the checkpoints never move');
    assert.match(flat, /orchestration\.md.*§7/, 'points at the orchestration §7 policy canon, never restates it');
    assert.match(flat, /Read the policy at session start/i, 'the read-at-start clause');
    assert.match(flat, /computed defaults ARE the policy/i, 'absent-file semantics');
    assert.match(flat, /never needs to restate the policy/i, 'a plan never restates per-project configuration');
    assert.match(flat, /explicit ask, never a silent widening/i, 'a departure from the level is an explicit ask');
  });
});
