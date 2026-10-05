import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The story flow in the canon: seven checked steps in four sessions; review on the spec with the plan's
// ledger, on the staged diff and on the epic by the lens.
const REFERENCES = join(dirname(fileURLToPath(import.meta.url)), '..', 'references');
const LF = String.fromCharCode(10);
const read = (name) => readFileSync(join(REFERENCES, name), 'utf8').replace(/\r\n/g, LF);
const flatten = (text) => text.replace(/\s+/g, ' ').trim();
const [planning, procedures] = ['planning.md', 'procedures.md'].map(read);
const STEPS = ['Epic', 'Spec', 'Plan', 'Tests', 'Code', 'Diff review', 'Release and record'];
const FIELDS = ['result:', 'maker:', 'check:', 'cost:'];
const SESSIONS = /four sessions[^.]*spec and plan[^.]*tests[^.]*code[^.]*diff review, release and record/i;
const TWO_ROUNDS = new RegExp(`two rounds|${String.fromCharCode(8804)}2 rounds`);

// A section: the lines under its heading up to the next heading of the same level outside a fence.
const sectionOf = (text, heading, scenario) => {
  const lines = text.split(LF);
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `${scenario}: ${heading} is absent`);
  const fenced = lines.map((line, index) => lines.slice(0, index).filter((l) => l.startsWith('```')).length % 2 === 1);
  const end = lines.findIndex((line, index) => index > start && !fenced[index] && line.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? undefined : end).join(LF);
};
// A bullet: its `- ` line and the lines that continue it, up to a blank line.
const bulletsOf = (section) => section.split(/\n(?=- )/)
  .filter((chunk) => chunk.startsWith('- ')).map((chunk) => flatten(chunk.split(/\n\s*\n/)[0]));
const stepBullet = (name, scenario) => {
  const found = bulletsOf(sectionOf(planning, '## The story flow', scenario)).filter((bullet) => bullet.startsWith(`- **${name}**`));
  assert.equal(found.length, 1, `${scenario}: one bullet of the story flow names the ${name} step`);
  return found[0];
};
// A numbered step: its `N. ` line and the indented lines that continue it.
const stepOf = (section, number) => {
  const lines = section.split(LF);
  const start = lines.findIndex((line) => line.startsWith(`${number}. `));
  assert.notEqual(start, -1, `S3: plan-authoring step ${number} is absent`);
  const end = lines.findIndex((line, index) => index > start && line.trim() !== '' && !line.startsWith(' '));
  return flatten(lines.slice(start, end === -1 ? undefined : end).join(LF));
};

describe('spec:story-flow/S1 planning.md names the seven steps and the four sessions', () => {
  it('gives every step its result, maker, one check and cost, in flow order, and runs them as four sessions', () => {
    const section = sectionOf(planning, '## The story flow', 'S1');
    const at = STEPS.map((name) => {
      const bullet = stepBullet(name, 'S1').toLowerCase();
      for (const field of FIELDS) assert.ok(bullet.includes(field), `S1: the ${name} step names its ${field.slice(0, -1)}`);
      return section.indexOf(`- **${name}**`);
    });
    assert.deepEqual([...at].sort((a, b) => a - b), at, 'S1: the seven steps stand in flow order');
    assert.match(flatten(section), SESSIONS, 'S1: the section names the four sessions');
  });

  it('names the bridge members, counts repair runs and leaves only machine-local records after the diff review', () => {
    const intro = flatten(sectionOf(planning, '## The story flow', 'S1').split(LF + '- ')[0]);
    assert.match(intro, /"Bridges" are the bridge members a recipe names/, 'S1: a lens member counts as a bridge');
    for (const name of ['Tests', 'Code']) assert.match(stepBullet(name, 'S1'), /plus every repair run that reaches a CLI/, `S1: the ${name} cost leaves out repair runs`);
    assert.match(stepBullet('Diff review', 'S1'), /tracked records[)] staged before it/, 'S1: tracked records are not staged before the diff review');
    const release = stepBullet('Release and record', 'S1');
    assert.match(release, /machine-local records[^.]*none of them changing what the review judged/, 'S1: Release and record keeps more than the machine-local records');
    assert.doesNotMatch(release, /the session records/, 'S1: Release and record still makes the session records');
  });
});

describe("spec:story-flow/S2 the plan is checked by plan-shape, the spec review's reading of its ledger and the approval; review runs on the spec with the ledger, the staged diff and the epic by the lens", () => {
  it("makes plan-shape, the spec review's reading of the ledger and the approval the plan check, with no rounds or sessions of its own", () => {
    const shape = flatten(sectionOf(planning, '## Shape', 'S2'));
    assert.doesNotMatch(shape, /plan[- ]review/i, 'S2: Shape names a plan review');
    assert.match(shape, /approval/, 'S2: Shape runs plan-shape before the approval');
    assert.doesNotMatch(flatten(planning), /plan[- ]review/i, 'S2: planning.md names a plan review');
    const plan = stepBullet('Plan', 'S2');
    for (const [reason, pattern] of [['the plan-shape gate', /plan-shape/], ["the spec review's reading of the ledger", /\bspec review\b[^.]*\bledger\b|\bledger\b[^.]*\bspec review\b/i], ["the maintainer's approval", /approval/], ['no rounds or sessions of its own', /\bno rounds or sessions of its own\b/i]]) assert.match(plan, pattern, `S2: the plan step lacks ${reason}`);
    assert.doesNotMatch(plan, /\bno review\b|\bnever reviewed\b/i, 'S2: the plan step still says the plan is never read by a review');
  });

  it('puts review on the spec with the ledger, on the staged diff and on the epic by the lens', () => {
    assert.match(stepBullet('Spec', 'S2'), /check:[^.]*review[^.]*\bledger\b/i, "S2: the spec step is not checked by a review that reads the plan's ledger");
    assert.match(stepBullet('Diff review', 'S2'), /staged diff/, 'S2: the diff review reads the staged diff');
    assert.match(stepBullet('Epic', 'S2'), /check:[^.]*\blens\b/i, 'S2: the epic is not reviewed by the lens');
    const cold = flatten(sectionOf(planning, '## The plan must read cold', 'S2'));
    assert.doesNotMatch(cold, /never on the plan/i, 'S2: the cold read still keeps review off the plan');
    assert.match(cold, /\bledger\b/, "S2: the cold read does not put the plan's ledger in the spec review");
  });
});

describe("spec:story-flow/S3 plan-authoring reviews the spec, every contract the story revises and the plan's ledger in the same rounds", () => {
  const authoring = sectionOf(procedures, '## plan-authoring', 'S3');
  it("step 4 reviews the spec, every contract the story revises and the plan's ledger in the same rounds, at most two", () => {
    const step = stepOf(authoring, 4);
    for (const [reason, pattern] of [['the spec', /\bspec\b/], ['every contract the story revises', /every contract the story (creates or )?revises/], ["the plan's ledger", /\bplan's ledger\b/],
      ["the plan's ledger in the same rounds", /\bsame rounds\b/], ['at most two rounds', TWO_ROUNDS]]) assert.match(step, pattern, `S3: step 4 does not review ${reason}`);
    assert.doesNotMatch(step, /never the plan|plan is never reviewed/i, 'S3: step 4 still keeps the plan out of the review');
  });

  it('step 6 presents the plan folded with the spec after plan-shape --check', () => {
    const step = stepOf(authoring, 6);
    assert.match(step, /\bfolded with (the|its) spec\b/, 'S3: step 6 does not present the plan folded with the spec');
    assert.match(step, /plan-shape(-cli\.mjs)? --check/, 'S3: step 6 runs plan-shape --check');
    assert.doesNotMatch(step, /never reviewed/i, 'S3: step 6 still says the plan is never reviewed');
  });
});
