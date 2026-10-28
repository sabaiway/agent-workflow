// The kit block's finder, composer, judgement and templates. Contract: docs/ai/specs/kit/install/entry-pointers.md.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { CRLF, LF, expectedBlock, inject, makeEngine, reconcile, rules } from './engine-harness.test.mjs';

const START = '<!-- workflow:kit:start -->';
const END = '<!-- workflow:kit:end -->';
const BOM = '﻿';
const FENCE = '```';
const READ_LINE = 'Read `docs/ai/index.md` after this file; read `docs/ai/agent_rules.md` before any code change.';
const TEMPLATES = [['kit', '../../references/templates/AGENTS.md'], ['memory', '../../../agent-workflow-memory/references/templates/AGENTS.md']];
const readTemplate = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const doc = (...lines) => lines.join(LF) + LF;
const find = (text) => inject.findKitBlock(text);

describe('spec:entry-pointers/S1 the finder answers ok, absent or malformed by the marker lines alone', () => {
  const cells = [
    ['one block at the start', doc(START, 'body', END, 'after'), { state: 'ok', start: 1, end: 3 }],
    ['one block in the middle', doc('# Title', '', START, END, '', 'tail'), { state: 'ok', start: 3, end: 4 }],
    ['one block at the end', doc('# Title', START, 'body', END), { state: 'ok', start: 2, end: 4 }],
    ['CRLF lines', [START, 'body', END, ''].join(CRLF), { state: 'ok', start: 1, end: 3 }],
    ['trailing spaces and indentation', doc(`   ${START}  `, 'body', `\t${END} `), { state: 'ok', start: 1, end: 3 }],
    ['no marker line', doc('# Title', 'text'), { state: 'absent' }],
    ['two starts', doc(START, START, END), { state: 'malformed', lines: [1, 2, 3] }],
    ['two ends', doc(START, END, 'x', END), { state: 'malformed', lines: [1, 2, 4] }],
    ['a lone start', doc('a', START, 'b'), { state: 'malformed', lines: [2] }],
    ['a lone end', doc('a', END), { state: 'malformed', lines: [2] }],
    ['an end before the start', doc(END, 'x', START), { state: 'malformed', lines: [1, 3] }],
    ['markers inside a closed fence only', doc(FENCE, START, END, FENCE), { state: 'absent' }],
    ['a fenced pair beside the block', doc(FENCE, START, START, FENCE, START, END), { state: 'ok', start: 5, end: 6 }],
    ['a marker quoted in a line of other text', doc(`Keep ${START} here`, `and ${END} too`), { state: 'absent' }],
    ['an unclosed fence before the block', doc(FENCE, 'text', START, END), { state: 'ok', start: 3, end: 4 }],
    ['an unclosed fence inside the block', doc(START, FENCE, 'text', END), { state: 'ok', start: 1, end: 4 }],
    ['an unclosed fence after the block', doc(START, END, FENCE, 'text'), { state: 'ok', start: 1, end: 2 }],
  ];
  for (const [name, text, answer] of cells) it(name, () => assert.deepEqual(find(text), answer));
});

describe('spec:entry-pointers/S2 the composed block over an engine fixture', () => {
  it('opens with the precedence line and the read line, then the trimmed fragments and the themes table', async () => {
    const result = await reconcile(doc('# My project'));
    const block = expectedBlock();
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.after, `${block}${LF}${LF}${doc('# My project')}`);
    const lines = block.split(LF);
    assert.deepEqual([lines[0], lines[2], lines[4]], [START, rules.PRECEDENCE_LINE, READ_LINE]);
    assert.equal(lines.filter((line) => line.startsWith('| [`docs/ai/rules/effective/')).length, rules.THEMES.length);
    assert.ok(lines.slice(1, -1).every((line) => ![START, END].includes(line.trim())), 'no body line equals a marker');
  });
});

describe('spec:entry-pointers/S3 the pure judgement', () => {
  const block = () => expectedBlock();
  const other = () => block().replace('(fixture)', '(an older text)');
  const judge = (text, composed = block()) => inject.reconcileKitBlock(text, composed);
  const expect = (text, status, out, composed) => {
    const answer = judge(text, composed);
    assert.deepEqual([answer.status, answer.text], [status, out]);
  };

  it('a found block equal after normalizeCanonical is current, CRLF and trailing whitespace included', () => {
    const text = `intro${LF}${LF}${block()}${LF}${LF}outro${LF}`;
    expect(text, 'current', text);
    const crlf = text.split(LF).join(CRLF);
    expect(crlf, 'current', crlf);
    const spaced = text.replace(END, `${END}   `);
    expect(spaced, 'current', spaced);
  });

  it('any other body, an empty one included, is written with every byte outside the marker lines unchanged', () => {
    const above = `# Mine${LF}${LF}`;
    const below = `${LF}${LF}## Mine too${LF}`;
    expect(`${above}${other()}${below}`, 'written', `${above}${block()}${below}`);
    expect(`${above}${START}${LF}${END}${below}`, 'written', `${above}${block()}${below}`);
    const crlf = (text) => text.split(LF).join(CRLF);
    expect(crlf(`${above}${other()}${below}`), 'written', crlf(`${above}${block()}${below}`));
  });

  it('a leading byte-order mark stays first and is never part of the block', () => {
    expect(`${BOM}${block()}${LF}`, 'current', `${BOM}${block()}${LF}`);
    expect(`${BOM}${other()}${LF}`, 'written', `${BOM}${block()}${LF}`);
    expect(`${BOM}old${LF}`, 'inserted', `${BOM}${block()}${LF}${LF}old${LF}`);
  });

  it('an absent block is inserted at the start, one blank line before the old bytes, in the file newline form', () => {
    expect(`old${LF}`, 'inserted', `${block()}${LF}${LF}old${LF}`);
    expect(`old${CRLF}`, 'inserted', `${block().split(LF).join(CRLF)}${CRLF}${CRLF}old${CRLF}`);
  });

  it('a malformed state is refused with the text unchanged and the line numbers carried', () => {
    const text = doc('a', START, START, END);
    const answer = judge(text);
    assert.deepEqual([answer.status, answer.text, answer.lines], ['refused', text, [2, 3, 4]]);
  });
});

describe('spec:entry-pointers/S7 no line cap and nothing retired left', () => {
  it('a file of 400 lines and a file of one line each take the block', async () => {
    const long = doc(...Array.from({ length: 400 }, (_, index) => `line ${index + 1}`));
    for (const text of [long, `one line${LF}`]) {
      const result = await reconcile(text);
      assert.deepEqual([result.code, result.after], [0, `${expectedBlock()}${LF}${LF}${text}`]);
    }
  });

  it('the module exports no cap, slot, descriptor, anchor, empty pair, prior list or retired route', () => {
    const retired = /CAP|MARKER|DESCRIPTOR|ANCHOR|EMPTY_SLOT|KNOWN_PRIOR|POINTER_ROUTE|isFillCapRefusal|markerSlotEnsurable/u;
    assert.deepEqual(Object.keys(inject).filter((name) => retired.test(name)), []);
  });

  it('imports nothing of project-rules but its index, and migration-blocks.mjs imports nothing from it', () => {
    const imports = (rel) => [...readFileSync(new URL(rel, import.meta.url), 'utf8').matchAll(/from\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/gu)]
      .map((match) => match[1] ?? match[2]);
    assert.deepEqual(imports('../inject-methodology.mjs').filter((spec) => spec.includes('project-rules/')), ['./project-rules/index.mjs']);
    assert.deepEqual(imports('../migration-blocks.mjs').filter((spec) => spec.includes('inject-methodology')), []);
  });
});

describe('spec:entry-pointers/S8 the surface the lineage migration imports', () => {
  it('BLOCK_START, BLOCK_END and SKIP_PREFIX carry the contract values and findKitBlock is a function', () => {
    assert.deepEqual([inject.BLOCK_START, inject.BLOCK_END, inject.SKIP_PREFIX, typeof inject.findKitBlock],
      [START, END, 'Kit text not supplied by the installed engine:', 'function']);
  });

  it('findKitBlock finds a block the module wrote, with and without skip lines', async () => {
    for (const engine of [makeEngine(), makeEngine({ omit: ['orchestration', 'lens'] })]) {
      const result = await reconcile(doc('# Title', 'text'), { engine });
      const lines = result.after.split(LF);
      assert.deepEqual(find(result.after), { state: 'ok', start: lines.indexOf(START) + 1, end: lines.indexOf(END) + 1 });
    }
  });
});

describe('spec:entry-pointers/S9 the templates', () => {
  for (const [owner, rel] of TEMPLATES) {
    it(`the ${owner} AGENTS.md template carries no slot pair and no line-cap footer, and takes the block once`, async () => {
      const text = readTemplate(rel);
      assert.deepEqual(text.split(LF).filter((line) => /<!--\s*workflow:(methodology|orchestration|autonomy):/u.test(line)), []);
      assert.deepEqual(text.split(LF).filter((line) => /(≤|<=)\s*\d+\s*lines/u.test(line)), []);
      const first = await reconcile(text);
      assert.deepEqual([first.code, first.after], [0, `${expectedBlock()}${LF}${LF}${text}`]);
      const second = await reconcile(first.after, { path: first.path });
      assert.deepEqual([second.code, second.after], [0, first.after]);
    });
  }
});
