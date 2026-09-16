import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const planning = readFileSync(new URL('../references/planning.md', import.meta.url), 'utf8');
const procedures = readFileSync(new URL('../references/procedures.md', import.meta.url), 'utf8');
const flatten = (text) => text.replace(/\s+/g, ' ');
const getSection = (text, name) => {
  const match = text.match(new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  assert.ok(match, `section ${name} exists`);
  return match[1];
};
const getStep = (section, number) => {
  const match = section.match(new RegExp(`^${number}\\. [\\s\\S]*?(?=^${number + 1}\\. )`, 'm'));
  assert.ok(match, `step ${number} has its next-step boundary`);
  return match[0];
};
const getHeldGroup = (step) => {
  const opening = 'when `execute` resolved to Delegated';
  const closing = 'what the delegate cannot reach.';
  const start = step.indexOf(opening);
  assert.notEqual(start, -1, 'held-session opening exists');
  const closingAt = step.indexOf(closing, start);
  assert.notEqual(closingAt, -1, 'held-session closing follows its opening');
  const end = closingAt + closing.length;
  return { text: step.slice(start, end), end };
};

describe('the task wave in the engine canon — spec:task-thread/S11', () => {
  const task = planning.match(/^## The task\n([\s\S]*?)^## The queue\n/m);
  assert.ok(task, 'The task is bounded by The queue');
  const section = flatten(task[1]);
  const execution = getSection(procedures, 'plan-execution');

  it('names the file-disjoint wave and its own codex session per task', () => {
    assert.match(section, /\bwave\b/);
    assert.match(section, /file-disjoint/);
    assert.ok(section.includes('dispatch open --checkpoint <oid> --task <brief>'));
    assert.ok(section.includes('own codex session'));
  });

  it('mints before a single task or the first execute of a wave', () => {
    assert.ok(section.includes("before a single task's execute dispatch, or before the first of a wave's"));
    assert.ok(!section.includes('Before every execute dispatch'));
  });

  it('places task restore after the whole-tree writer precondition and covers outside writers', () => {
    const precondition = section.indexOf('no other session writes in scope');
    const restore = section.indexOf('restore <oid> --nonce <n>');
    assert.notEqual(restore, -1, 'task restore names its nonce');
    assert.ok(precondition >= 0 && restore > precondition);
    assert.ok(section.includes("outside every open task's Files"));
  });

  it('binds Reads to Files inside the wave text', () => {
    assert.match(section.slice(section.indexOf('wave')), /\bReads\b[^.]*\bFiles\b/);
  });

  it('preserves the held-session sentence group byte for byte in step 5', () => {
    const group = getHeldGroup(getStep(execution, 5));
    assert.equal(Buffer.byteLength(group.text, 'utf8'), 725);
    assert.equal(createHash('sha256').update(group.text, 'utf8').digest('hex'),
      'eb7c556ad4ffdff2771150fe7696545bb20c64bd85e91236d31dc72e2624d60f');
  });

  it('places the task chain after the held-session group before red-proof in step 5', () => {
    const step5 = getStep(execution, 5);
    const group = getHeldGroup(step5);
    const redProof = step5.indexOf('`core-evidence red-proof`', group.end);
    assert.notEqual(redProof, -1, 'red-proof follows the held-session group');
    const chain = flatten(step5.slice(group.end, redProof));
    for (const pattern of [/\btask's chain\b/, /\bbrief\b/, /\buntasked\b/]) assert.match(chain, pattern);
  });

  it('keeps the execution slots first and numbered steps 1 through 8', () => {
    assert.equal(execution.trim().split('\n')[0], 'Slots: execute, review');
    assert.deepEqual([...execution.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1])),
      [1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
