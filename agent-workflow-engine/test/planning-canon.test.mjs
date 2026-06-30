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
  });
});
