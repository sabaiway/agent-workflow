// The kit block command over engine fixtures. Contract: docs/ai/specs/kit/install/entry-pointers.md.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs, { readFileSync, readdirSync, statSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import {
  INSTALL, LF, NO_ENGINE, PARTS, expectedBlock, inject, makeEngine, noteLine, reconcile, skipLine, tempDir,
} from './engine-harness.test.mjs';

const KIT = new URL('../../', import.meta.url);
const START = '<!-- workflow:kit:start -->';
const END = '<!-- workflow:kit:end -->';
const BLOCK_ROUTE = "text of your own goes outside the two workflow:kit comment lines; a change to a kit rule goes in its theme's file under docs/ai/rules/local/";
const RETIRED_WORD = /(^|[^a-z])(custom|customized|edited|preserved|verbatim|kept)([^a-z]|$)/iu;
const STOP = '[inject-methodology] reconcile STOP — methodology engine not found/invalid';
const doc = (...lines) => lines.join(LF) + LF;
const linesOf = (result) => `${result.stdout}${result.stderr}`.split(LF).filter(Boolean);
const differing = () => expectedBlock({ texts: { methodology: '> An older methodology text.' } });

describe('spec:entry-pointers/S4 the command over an engine fixture', () => {
  it('BLOCK_ROUTE carries the contract words', () => assert.equal(inject.BLOCK_ROUTE, BLOCK_ROUTE));

  it('a file with no marker line gains the block at its start, and a second run writes nothing', async () => {
    const text = doc('# My project', '', 'Text of mine.');
    const first = await reconcile(text);
    assert.deepEqual([first.code, first.after, linesOf(first)],
      [0, `${expectedBlock()}${LF}${LF}${text}`, [`[inject-methodology] kit block: added at the start of the file; ${BLOCK_ROUTE}.`]]);
    const inode = statSync(first.path).ino;
    const second = await reconcile(first.after, { path: first.path });
    assert.deepEqual([second.code, linesOf(second), second.after, statSync(first.path).ino],
      [0, ['[inject-methodology] kit block: already current — nothing to do (zero-diff).'], first.after, inode]);
  });

  it('a differing block after other text is written, the text above and below byte-identical', async () => {
    const above = doc('# My project', '', 'Text of mine.', '');
    const below = doc('', '## More of mine');
    const result = await reconcile(`${above}${differing()}${LF}${below}`);
    assert.deepEqual([result.code, result.after, linesOf(result)],
      [0, `${above}${expectedBlock()}${LF}${below}`, [`[inject-methodology] kit block: written with the current kit text; ${BLOCK_ROUTE}.`]]);
  });

  it('a malformed file exits 1 naming every marker line and the route, the file byte-identical', async () => {
    const text = doc('# My project', START, 'x', START, END);
    const result = await reconcile(text);
    const refusal = '[inject-methodology] kit block refused — the workflow:kit comment lines must be exactly one start line before one end line ' +
      `(found on lines 2, 4, 5); fix them, then re-run; ${BLOCK_ROUTE}.`;
    assert.deepEqual([result.code, linesOf(result), result.after], [1, [refusal], text]);
  });

  it('no line of any run says custom, customized, edited, preserved, verbatim or kept', async () => {
    const runs = await Promise.all([doc('a'), `${differing()}${LF}`, doc(START, START)].map((text) => reconcile(text)));
    assert.deepEqual(runs.flatMap(linesOf).filter((line) => RETIRED_WORD.test(line)), []);
  });
});

describe('spec:entry-pointers/S5 the skip lines', () => {
  for (const part of PARTS.filter((one) => one.name)) {
    it(`an engine without the ${part.id} fragment writes one skip line in its place and one note line`, async () => {
      const result = await reconcile(doc('# Mine'), { engine: makeEngine({ omit: [part.id] }) });
      assert.deepEqual([result.code, result.after], [0, `${expectedBlock({ omit: [part.id] })}${LF}${LF}${doc('# Mine')}`]);
      assert.equal(result.after.split(LF).filter((line) => line.startsWith(inject.SKIP_PREFIX)).length, 1);
      assert.equal(result.after.includes(skipLine(part.name)), true);
      assert.deepEqual(linesOf(result).filter((line) => line.includes('note:')), [noteLine(part.name)]);
    });
  }

  it('an engine without the lens theme drops its row, writes the skip line after the table, and a complete engine fills both', async () => {
    const lacking = await reconcile(doc('# Mine'), { engine: makeEngine({ omit: ['lens', 'autonomy'] }) });
    const block = lacking.after.split(LF);
    assert.equal(block.some((line) => line.includes('docs/ai/rules/effective/lens.md')), false);
    assert.equal(block[block.indexOf(skipLine('the lens rules theme')) - 2].startsWith('| '), true, 'the skip line follows the table');
    assert.deepEqual(linesOf(lacking).filter((line) => line.includes('note:')), [noteLine('the autonomy policy'), noteLine('the lens rules theme')]);
    const complete = await reconcile(lacking.after, { path: lacking.path });
    assert.deepEqual([complete.code, complete.after], [0, `${expectedBlock()}${LF}${LF}${doc('# Mine')}`]);
    assert.equal(complete.after.includes(String(inject.SKIP_PREFIX)), false);
  });
});

describe('spec:entry-pointers/S6 an absent or invalid engine is a STOP', () => {
  const files = () => [doc('# Mine'), `${expectedBlock()}${LF}${LF}${doc('# Mine')}`, `${differing()}${LF}`];
  const stops = (result, text) => {
    assert.deepEqual([result.code, result.after, result.stdout], [1, text, '']);
    assert.equal(result.stderr.startsWith(STOP), true, result.stderr);
    assert.equal(result.stderr.includes(INSTALL), true, result.stderr);
  };

  it('an absent and an invalid engine STOP over a markerless, a current and a differing file', async () => {
    for (const engine of [NO_ENGINE, makeEngine({ kind: 'not-an-engine' })]) {
      for (const text of files()) stops(await reconcile(text, { engine }), text);
    }
  });

  it('a fragment blank after trim and a present fragment that cannot be read STOP naming its path', async (t) => {
    const cells = [
      [{ files: { [PARTS[0].file]: `  ${LF}${LF}` } }, PARTS[0].file],
      [{ files: { [PARTS[2].file]: LF } }, PARTS[2].file],
      ...(process.getuid?.() === 0 ? [] : [[{ unreadable: [PARTS[1].file] }, PARTS[1].file]]),
    ];
    if (cells.length === 2) t.diagnostic('running as root: the unreadable cell is not reachable');
    for (const [options, rel] of cells) {
      const text = doc('# Mine');
      const result = await reconcile(text, { engine: makeEngine(options) });
      stops(result, text);
      assert.equal(result.stderr.includes(rel), true, result.stderr);
    }
  });
});

describe('spec:entry-pointers/S10 one atomic write', () => {
  it('a failed rename rejects with its error, leaves the target byte-identical and no temporary file', async (t) => {
    const failure = Object.assign(new Error('rename refused'), { code: 'EACCES' });
    const refuse = () => { throw failure; };
    t.mock.method(fs.promises, 'rename', async () => refuse());
    t.mock.method(fs, 'renameSync', refuse);
    t.mock.method(fs, 'rename', (from, to, done) => done(failure));
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const text = doc('# Mine');
    const path = join(tempDir('kit-block-rename-'), 'AGENTS.md');
    await assert.rejects(reconcile(text, { path }), failure);
    assert.deepEqual([readFileSync(path, 'utf8'), readdirSync(join(path, '..'))], [text, ['AGENTS.md']]);
  });

  it('a run that writes leaves no temporary file beside the target', async () => {
    const result = await reconcile(doc('# Mine'));
    assert.deepEqual([result.code, result.names], [0, ['AGENTS.md']]);
  });
});

describe('spec:entry-pointers/S11 the shipped text names the kit block written current and the route', () => {
  const KEEP_SUBJECT = /(^|[^a-z])blocks?([^a-z]|$)/iu;
  const KEEP_WORD = /(^|[^a-z])(preserved|verbatim|untouched|never overwritten|as you wrote|kept)([^a-z]|$)/iu;
  const RETIRED = /\bpointer slots?\b|\banchor sentence\b|\b100(-| )lines?\b|(≤|<=)\s*100\b|Memory Map rows?|lens-region|rules-insert/iu;
  const flat = (text) => text.replace(/\*\*|`/gu, '').replace(/\s+/gu, ' ');
  const read = (rel) => readFileSync(new URL(rel, KIT), 'utf8');
  const between = (text, from, to, where) => {
    const start = text.indexOf(from);
    const end = text.indexOf(to, start + from.length);
    assert.ok(start !== -1 && end !== -1, `${where}: no slice from ${from} to ${to}`);
    return text.slice(start, end);
  };
  const slices = () => {
    const upgrade = read('references/modes/upgrade.md');
    const handoff = read('references/shared/composition-handoff.md').split(LF + LF).filter((part) => /^\*\*[^\n]*kit block/iu.test(part));
    assert.equal(handoff.length, 1, 'composition-handoff.md: one paragraph led by the kit block');
    const memory = read('../agent-workflow-memory/SKILL.md');
    const upgradeMode = memory.slice(memory.indexOf('### Mode: upgrade'));
    return {
      row: upgrade.split(LF).find((line) => line.trimStart().startsWith('1. `entry-block`')) ?? '',
      block: between(upgrade, '**`entry-block` —', '**`footprint` —', 'upgrade.md entry-block block'),
      handoff: handoff[0],
      contracts: between(`${read('references/contracts.md')}${LF}## `, `${LF}## Reserved names and channels${LF}`, `${LF}## `, 'contracts.md'),
      skill: between(upgradeMode, `${LF}6. `, `${LF}7. `, 'memory SKILL.md step 6'),
    };
  };
  const keptClauses = (name, text) => flat(text).split(/;|[.?!](?=\s|$)|·/u)
    .map((part) => part.replace(/no copy kept/giu, ' ').trim())
    .filter((part) => KEEP_SUBJECT.test(part) && KEEP_WORD.test(part) && !(name === 'skill' && /byte for byte/iu.test(part)));

  it('each slice names the block between its two workflow:kit comment lines, written with no question and no copy kept, and the route', () => {
    const missing = Object.entries(slices()).flatMap(([name, text]) => ['kit block', 'workflow:kit', 'no question', 'no copy kept', BLOCK_ROUTE]
      .filter((words) => !flat(text).toLowerCase().includes(words.toLowerCase())).map((words) => `${name}: ${words}`));
    assert.deepEqual(missing, []);
  });

  it('no slice names a pointer slot, an anchor sentence, a line cap, a theme row, lens-region or rules-insert', () => {
    assert.deepEqual(Object.entries(slices()).filter(([, text]) => RETIRED.test(flat(text))).map(([name, text]) => `${name}: ${flat(text).match(RETIRED)[0]}`), []);
  });

  it('no clause pairs the block with a word that keeps it', () => {
    assert.deepEqual(Object.entries(slices()).flatMap(([name, text]) => keptClauses(name, text).map((part) => `${name}: ${part}`)), []);
  });
});

describe('spec:carriers/S18 the six-activity methodology text reaches a deployment through the kit block', () => {
  const six = readFileSync(new URL('../agent-workflow-engine/references/methodology-slot.md', KIT), 'utf8').trim();
  const four = six.replace('(plan-authoring, plan-execution, routine, feedback-triage, epic, task)', '(plan-authoring, plan-execution, routine, feedback-triage)');

  it('a block holding the four-activity text and one holding any other text are written with the six-activity fragment', async () => {
    const engine = makeEngine({ files: { [PARTS[0].file]: `${six}${LF}` } });
    for (const old of [four, '> Some other methodology text.']) {
      const result = await reconcile(`${expectedBlock({ texts: { methodology: old } })}${LF}`, { engine });
      assert.deepEqual([result.code, result.after], [0, `${expectedBlock({ texts: { methodology: six } })}${LF}`]);
    }
  });

  it('no slot prior list remains in the kit', () => {
    const tools = new URL('tools/', KIT);
    const holders = readdirSync(tools).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
      .filter((name) => /KNOWN_PRIOR_(METHODOLOGY|ORCH|AUTONOMY)_SLOT/u.test(readFileSync(new URL(name, tools), 'utf8')));
    assert.deepEqual(holders, []);
  });
});
