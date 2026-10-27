// The Memory Map row of each theme: derived from the registry, placed after the agent_rules row, kept, refreshed, written or skipped.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { load, need } from './rules-harness.test.mjs';

const LF = '\n';
const CRLF = '\r\n';
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"`])([^'"`\n]+)\1/g;
const SHIPPED_ROWS = Object.freeze([
  '| [`docs/ai/rules/effective/project-layout.md`](./docs/ai/rules/effective/project-layout.md) | Creating, moving or naming a file, a module or a spec | Only through `/agent-workflow-kit rules` |',
  '| [`docs/ai/rules/effective/project-layout.md`](./docs/ai/rules/effective/project-layout.md) | **Start of every session** | Only through `/agent-workflow-kit rules` |',
]);
const ANCHOR = '| [`docs/ai/agent_rules.md`](./docs/ai/agent_rules.md) | **Before any code change** | Protocol changes |';
const HEAD_LINES = Object.freeze([
  '# Project',
  '',
  '| File | Read When... | Update When... |',
  '|------|--------------|----------------|',
  '| [`docs/ai/handover.md`](./docs/ai/handover.md) | **Start of every session** | End of session |',
]);
const TAIL_LINES = Object.freeze(['| [`docs/ai/changelog.md`](./docs/ai/changelog.md) | Reviewing history | After each session |', '', '## Next']);
const NO_ANCHOR = 'the Memory Map has no docs/ai/agent_rules.md row to place it after';
const SPLIT_ANCHOR = "the Memory Map's docs/ai/agent_rules.md row spans more than one line";
const BACKSLASH = String.fromCharCode(92);

const openRow = (path) => '| [`' + path + '`](./' + path + ') |';
// A row of the theme's path cell with other text, a user edit.
const otherRow = (themePaths, theme) => openRow(themePaths(theme.name).effective) + ' My own words | Edit by hand |';
const buildRow = (themePaths, theme) =>
  openRow(themePaths(theme.name).effective) + ' ' + theme.readWhen + ' | Only through `/agent-workflow-kit rules` |';
const joinLines = (lines, eol = LF) => lines.map((line) => line + eol).join('');
const countLines = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
const mapWith = (middle, eol = LF) => joinLines([...HEAD_LINES, ...middle, ...TAIL_LINES], eol);

// loadLeaf() → the leaf's call (its absence the first throw) and the registry it derives the rows from.
const loadLeaf = async () => {
  const reconcile = need(await load('./memory-map-row.mjs'), 'reconcileMemoryMapRows');
  const themes = await load('./themes.mjs');
  const THEMES = need(themes, 'THEMES');
  const themePaths = need(themes, 'themePaths');
  return { reconcile, THEMES, themePaths, rows: THEMES.map((theme) => buildRow(themePaths, theme)) };
};
const answerAll = (THEMES, status, note = '') => THEMES.map((theme) => ({ theme: theme.name, status, note }));

describe('spec:project-rules/S26 each theme row is derived from the registry and inserted after the agent_rules row with its ending', () => {
  it('inserts the derived three-cell row on the line right after the agent_rules row, LF', async () => {
    const { reconcile, THEMES, themePaths, rows } = await loadLeaf();
    const result = reconcile(mapWith([ANCHOR]), { maxLines: 100 });
    assert.equal(result.text, mapWith([ANCHOR, ...rows]));
    assert.deepEqual(result.outcomes, answerAll(THEMES, 'inserted'));
    for (const [i, theme] of THEMES.entries()) {
      assert.ok(rows[i].startsWith('| [`' + themePaths(theme.name).effective + '`](./'), 'the path cell links the effective file');
      assert.match(rows[i], /^\| \S.* \| \S.* \| \S.* \|$/);
    }
  });

  it('gives a CRLF text the row with CRLF and leaves no lone LF anywhere', async () => {
    const { reconcile, THEMES, rows } = await loadLeaf();
    const result = reconcile(mapWith([ANCHOR], CRLF), { maxLines: 100 });
    assert.equal(result.text, mapWith([ANCHOR, ...rows], CRLF));
    assert.doesNotMatch(result.text, /(^|[^\r])\n/);
    assert.deepEqual(result.outcomes, answerAll(THEMES, 'inserted'));
  });

  it('puts the row on its own line after an agent_rules row that ends the text with no newline', async () => {
    const { reconcile, THEMES, rows } = await loadLeaf();
    const result = reconcile(ANCHOR, { maxLines: 100 });
    assert.equal(result.text, [ANCHOR, ...rows].join(LF));
    assert.deepEqual(result.outcomes, answerAll(THEMES, 'inserted'));
  });

  it('takes only the text, needs no effective file, and imports only ./themes.mjs', async () => {
    const source = readFileSync(new URL('./memory-map-row.mjs', import.meta.url), 'utf8');
    assert.deepEqual([...source.matchAll(SPECIFIER)].map((m) => m[2]), ['./themes.mjs']);
    const { reconcile, THEMES, rows } = await loadLeaf();
    const result = reconcile(joinLines([ANCHOR]), { maxLines: 100 });
    assert.equal(result.text, joinLines([ANCHOR, ...rows]));
    assert.deepEqual(result.outcomes, answerAll(THEMES, 'inserted'));
  });
});

describe('spec:project-rules/S27 a present current row is kept, a prior refreshed, and the prior list is frozen with the 14.39.0 row', () => {
  it('keeps a present current row byte for byte, also above the anchor', async () => {
    const { reconcile, THEMES, rows } = await loadLeaf();
    for (const text of [mapWith([ANCHOR, ...rows]), joinLines([...rows, ...HEAD_LINES, ANCHOR, ...TAIL_LINES])]) {
      const result = reconcile(text, { maxLines: 100 });
      assert.equal(result.text, text);
      assert.deepEqual(result.outcomes, answerAll(THEMES, 'kept'));
    }
  });

  it('refreshes a row equal to an injected prior in place, its ending and the line count kept', async () => {
    const { reconcile, THEMES, themePaths, rows } = await loadLeaf();
    const priors = THEMES.map((theme) => openRow(themePaths(theme.name).effective) + ' An older read-when | Only through `/agent-workflow-kit rules` |');
    for (const eol of [LF, CRLF]) {
      const text = mapWith([ANCHOR, ...priors], eol);
      const result = reconcile(text, { maxLines: 100, priors });
      assert.equal(result.text, mapWith([ANCHOR, ...rows], eol));
      assert.equal(countLines(result.text), countLines(text));
      assert.deepEqual(result.outcomes, answerAll(THEMES, 'refreshed'));
    }
    const above = joinLines([...priors, ANCHOR]);
    assert.equal(reconcile(above, { maxLines: 100, priors }).text, joinLines([...rows, ANCHOR]));
  });

  it('holds MEMORY_MAP_PRIOR_ROWS frozen with exactly the 14.39.0 row, and every shipped row text is a prior or the current row', async () => {
    const { reconcile, THEMES } = await loadLeaf();
    const MEMORY_MAP_PRIOR_ROWS = need(await load('./memory-map-row.mjs'), 'MEMORY_MAP_PRIOR_ROWS');
    assert.ok(Object.isFrozen(MEMORY_MAP_PRIOR_ROWS), 'MEMORY_MAP_PRIOR_ROWS is frozen');
    assert.deepEqual(MEMORY_MAP_PRIOR_ROWS, [SHIPPED_ROWS[0]]);
    const inserted = reconcile(joinLines([ANCHOR]), { maxLines: 100 }).text.split(LF).slice(1, 1 + THEMES.length);
    assert.deepEqual(SHIPPED_ROWS, [...MEMORY_MAP_PRIOR_ROWS, ...inserted]);
  });
});

describe('spec:project-rules/S28 the three skip reasons leave the text byte for byte and neither a refresh nor a write at the cap is skipped', () => {
  it('skips with its note when the Memory Map has no agent_rules row', async () => {
    const { reconcile, THEMES } = await loadLeaf();
    const text = mapWith([]);
    const result = reconcile(text, { maxLines: 100 });
    assert.equal(result.text, text);
    assert.deepEqual(result.outcomes, answerAll(THEMES, 'skipped', NO_ANCHOR));
  });

  it('skips with its note when the agent_rules row spans two lines', async () => {
    const { reconcile, THEMES } = await loadLeaf();
    const text = mapWith(['| [`docs/ai/agent_rules.md`](./docs/ai/agent_rules.md) | **Before any code change**', '  | Protocol changes |']);
    const result = reconcile(text, { maxLines: 100 });
    assert.equal(result.text, text);
    assert.deepEqual(result.outcomes, answerAll(THEMES, 'skipped', SPLIT_ANCHOR));
  });

  it('skips an insert past maxLines with the limit note and inserts one landing exactly at maxLines', async () => {
    const { reconcile, THEMES, rows } = await loadLeaf();
    const text = joinLines(['| File | Read When... | Update When... |', '|------|--------------|----------------|', ANCHOR, '## Next']);
    assert.equal(countLines(text), 4);
    const past = reconcile(text, { maxLines: 4 });
    assert.equal(past.text, text);
    assert.deepEqual(past.outcomes, answerAll(THEMES, 'skipped', 'adding it would take the file past its 4-line limit'));
    const at = reconcile(text, { maxLines: 4 + THEMES.length });
    assert.equal(at.text, joinLines(['| File | Read When... | Update When... |', '|------|--------------|----------------|', ANCHOR, ...rows, '## Next']));
    assert.equal(countLines(at.text), 4 + THEMES.length);
    assert.deepEqual(at.outcomes, answerAll(THEMES, 'inserted'));
  });

  it('refreshes a prior row and writes a row with other text on a text already at maxLines, never skipping either', async () => {
    const { reconcile, THEMES, themePaths, rows } = await loadLeaf();
    const priors = THEMES.map((theme) => openRow(themePaths(theme.name).effective) + ' An older read-when | Only through `/agent-workflow-kit rules` |');
    const text = joinLines(['| File | Read When... | Update When... |', ANCHOR, ...priors]);
    const result = reconcile(text, { maxLines: countLines(text), priors });
    assert.equal(result.text, joinLines(['| File | Read When... | Update When... |', ANCHOR, ...rows]));
    assert.deepEqual(result.outcomes, answerAll(THEMES, 'refreshed'));
    const other = joinLines(['| File | Read When... | Update When... |', ANCHOR, ...THEMES.map((theme) => otherRow(themePaths, theme))]);
    const written = reconcile(other, { maxLines: countLines(other) });
    assert.deepEqual([written.text, written.outcomes], [joinLines(['| File | Read When... | Update When... |', ANCHOR, ...rows]), answerAll(THEMES, 'written')]);
  });
});

describe('spec:project-rules/S35 a theme row with other text on one whole line is written in place with the current text', () => {
  it('names the route in ROW_ROUTE', async () => {
    const ROW_ROUTE = need(await load('./memory-map-row.mjs'), 'ROW_ROUTE');
    assert.equal(ROW_ROUTE, 'a row of your own goes on a line of its own, its first cell a path of your own');
  });

  it('writes a user edit in place, its ending, its position and the line count kept, LF and CRLF, also above the anchor', async () => {
    const { reconcile, THEMES, themePaths, rows } = await loadLeaf();
    const edited = THEMES.map((theme) => otherRow(themePaths, theme));
    for (const eol of [LF, CRLF]) {
      const pairs = [[mapWith([ANCHOR, ...edited], eol), mapWith([ANCHOR, ...rows], eol)],
        [joinLines([...edited, ...HEAD_LINES, ANCHOR, ...TAIL_LINES], eol), joinLines([...rows, ...HEAD_LINES, ANCHOR, ...TAIL_LINES], eol)]];
      for (const [text, expected] of pairs) {
        const result = reconcile(text, { maxLines: 100 });
        assert.deepEqual([result.text, countLines(result.text)], [expected, countLines(text)]);
        assert.deepEqual(result.outcomes, answerAll(THEMES, 'written'));
      }
    }
  });

  it('writes it in a file with no docs/ai/agent_rules.md row', async () => {
    const { reconcile, THEMES, themePaths, rows } = await loadLeaf();
    const result = reconcile(mapWith(THEMES.map((theme) => otherRow(themePaths, theme))), { maxLines: 100 });
    assert.deepEqual([result.text, result.outcomes], [mapWith(rows), answerAll(THEMES, 'written')]);
  });
});

describe('spec:project-rules/S36 a theme path cell opening two or more lines is skipped, none of them changed', () => {
  it('skips two current rows, a current row beside other text, and rows of two and of three cells, the text byte for byte', async () => {
    const { reconcile, THEMES, themePaths, rows } = await loadLeaf();
    const opening = (theme) => openRow(themePaths(theme.name).effective);
    const doubles = [THEMES.flatMap((theme, i) => [rows[i], rows[i]]), THEMES.flatMap((theme, i) => [rows[i], otherRow(themePaths, theme)]),
      THEMES.flatMap((theme) => [opening(theme) + ' two cells |', opening(theme) + ' three | cells |'])];
    for (const lines of doubles) {
      const text = mapWith([ANCHOR, ...lines]);
      const result = reconcile(text, { maxLines: 100 });
      assert.equal(result.text, text);
      const note = (theme) => 'the Memory Map has more than one ' + themePaths(theme.name).effective + ' row — none of them was changed';
      assert.deepEqual(result.outcomes, THEMES.map((theme) => ({ theme: theme.name, status: 'skipped', note: note(theme) })));
    }
  });
});

describe('spec:project-rules/S37 a theme row that does not close its cells on one line is skipped, a whole row of five cells written', () => {
  it('skips a row broken after its path cell or its read-when cell, a last | a backslash escapes and a last cell no | closes', async () => {
    const { reconcile, THEMES, themePaths } = await loadLeaf();
    const opening = (theme) => openRow(themePaths(theme.name).effective);
    const RULES_CELL = 'Only through `/agent-workflow-kit rules`';
    const shapes = [(theme) => [opening(theme), '  ' + theme.readWhen + ' | ' + RULES_CELL + ' |'],
      (theme) => [opening(theme) + ' ' + theme.readWhen + ' |', '  ' + RULES_CELL + ' |'],
      (theme) => [opening(theme) + ' ' + theme.readWhen + ' | ' + RULES_CELL + ' | trailing ' + BACKSLASH + '|'],
      (theme) => [opening(theme) + ' ' + theme.readWhen + ' | ' + RULES_CELL]];
    for (const shape of shapes) {
      const text = mapWith([ANCHOR, ...THEMES.flatMap(shape)]);
      const result = reconcile(text, { maxLines: 100 });
      assert.equal(result.text, text);
      const note = (theme) => 'the ' + themePaths(theme.name).effective + ' row does not close its cells on one line — left as it stands';
      assert.deepEqual(result.outcomes, THEMES.map((theme) => ({ theme: theme.name, status: 'skipped', note: note(theme) })));
    }
  });

  it('writes a whole row carrying a fifth cell with the current text', async () => {
    const { reconcile, THEMES, themePaths, rows } = await loadLeaf();
    const fifth = THEMES.map((theme) => openRow(themePaths(theme.name).effective) + ' a | b | c | d |');
    const result = reconcile(mapWith([ANCHOR, ...fifth]), { maxLines: 100 });
    assert.deepEqual([result.text, result.outcomes], [mapWith([ANCHOR, ...rows]), answerAll(THEMES, 'written')]);
  });
});
