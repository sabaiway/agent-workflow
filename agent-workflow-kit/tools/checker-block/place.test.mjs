import { it } from 'node:test';
import assert from 'node:assert/strict';
import { judgeBlock } from '../checker-verdict/index.mjs';

const { placeFinding, escapeLineText } = await import('./place.mjs').catch(() => ({}));
const { composeCheckerBlock } = await import('./index.mjs').catch(() => ({}));

const CHECKER_NAME = 'demo-check';
const PROJECT_ROOT = '/r';
const FINDING_TEXT = 'the entry differs';
const BLOCK_OPTIONS = {
  name: CHECKER_NAME,
  root: PROJECT_ROOT,
  failed: 'declared entries differ',
  remedies: ['restore the declared entry'],
};
const PLACE_ROWS = [
  { label: 'relative path inside root', path: 'src/a.mjs',
    expected: { place: 'src/a.mjs', lead: '' } },
  { label: 'absolute path under root', path: '/r/src/a.mjs',
    expected: { place: 'src/a.mjs', lead: '' } },
  { label: 'absolute path outside root', path: '/outside/a.mjs',
    expected: { place: '/outside/a.mjs', lead: '' } },
  { label: 'root with trailing slash', root: '/r/', path: '/r/src/a.mjs',
    expected: { place: 'src/a.mjs', lead: '' } },
  { label: 'filesystem root', root: '/', path: '/x/y.mjs',
    expected: { place: 'x/y.mjs', lead: '' } },
  { label: 'positive line', path: 'src/a.mjs', line: 1,
    expected: { place: 'src/a.mjs:1', lead: '' } },
  { label: 'root itself without line', path: '/r',
    expected: { place: '.', lead: '' } },
  { label: 'backslash', path: 'src\\a.mjs',
    expected: { place: '.', lead: 'src\\a.mjs: ' } },
  { label: 'colon', path: 'src/a:b.mjs',
    expected: { place: '.', lead: 'src/a:b.mjs: ' } },
  { label: 'carriage return', path: 'src/a\rb.mjs',
    expected: { place: '.', lead: 'src/a\\rb.mjs: ' } },
  { label: 'line feed', path: 'src/a\nb.mjs',
    expected: { place: '.', lead: 'src/a\\nb.mjs: ' } },
  { label: 'leading space', path: ' a.mjs',
    expected: { place: '.', lead: '\\u0020a.mjs: ' } },
  { label: 'empty path', path: '',
    expected: { place: '.', lead: ': ' } },
  { label: 'current segment', path: 'src/./a.mjs',
    expected: { place: '.', lead: 'src/./a.mjs: ' } },
  { label: 'parent segment', path: 'src/../a.mjs',
    expected: { place: '.', lead: 'src/../a.mjs: ' } },
  { label: 'leading current segment', path: './a.mjs',
    expected: { place: '.', lead: './a.mjs: ' } },
  { label: 'doubled slash', path: 'src//a.mjs',
    expected: { place: '.', lead: 'src//a.mjs: ' } },
  { label: 'trailing slash', path: 'src/',
    expected: { place: '.', lead: 'src/: ' } },
  { label: 'root itself with line', path: '/r', line: 3,
    expected: { place: '.', lead: '/r:3: ' } },
  { label: 'checker name as path', path: CHECKER_NAME,
    expected: { place: '.', lead: `${CHECKER_NAME}: ` } },
  { label: 'relative form opens with space', path: '/r/ a.mjs',
    expected: { place: '.', lead: '/r/ a.mjs: ' } },
  { label: 'relative form is checker name', path: `/r/${CHECKER_NAME}`,
    expected: { place: '.', lead: `/r/${CHECKER_NAME}: ` } },
  { label: 'doubled slash immediately after root', path: '/r//x.mjs',
    expected: { place: '.', lead: '/r//x.mjs: ' } },
  { label: 'zero line', path: 'src/a.mjs', line: 0,
    expected: { place: '.', lead: 'src/a.mjs:0: ' } },
  { label: 'unsafe integer line', path: 'src/a.mjs', line: 1e21,
    expected: { place: '.', lead: 'src/a.mjs:1e+21: ' } },
  { label: 'fractional line', path: 'src/a.mjs', line: 1.5,
    expected: { place: '.', lead: 'src/a.mjs:1.5: ' } },
  { label: 'string line', path: 'src/a.mjs', line: '3',
    expected: { place: '.', lead: 'src/a.mjs:3: ' } },
  { label: 'non-string path', path: 17, expected: { place: '.' } },
  { label: 'place opens after line', path: 'src/a.mjs', line: 3,
    laterLines: ['src/a.mjs:3: anything'],
    expected: { place: '.', lead: 'src/a.mjs:3: ' } },
].map((row) => ({
  root: PROJECT_ROOT, name: CHECKER_NAME, line: undefined, laterLines: [], ...row,
}));

it('spec:checker-block/S1 places findings over the closed state table', () => {
  assert.equal(typeof placeFinding, 'function');
  for (const row of PLACE_ROWS) {
    const actual = placeFinding(row);
    if (typeof row.path !== 'string') {
      assert.equal(actual.place, '.', row.label);
      assert.equal(typeof actual.lead, 'string', row.label);
      assert.equal(actual.lead.endsWith(': '), true, row.label);
    } else {
      assert.deepEqual(actual, row.expected, row.label);
    }
  }
});

it('spec:checker-block/S2 escapes line text and preserves composer refusals', () => {
  assert.equal(typeof escapeLineText, 'function');
  assert.equal(typeof composeCheckerBlock, 'function');
  const escapeRows = [
    ['a\rb\rc', 'a\\rb\\rc'],
    ['a\nb\nc', 'a\\nb\\nc'],
    ['  text', '\\u0020 text'],
    ['ordinary text', 'ordinary text'],
  ];
  for (const [text, expected] of escapeRows) {
    assert.equal(escapeLineText(text), expected, JSON.stringify(text));
  }
  const detail = ['detail stays as handed', '  detail keeps its own spaces'];
  const lines = composeCheckerBlock({
    ...BLOCK_OPTIONS,
    failed: ' failure\rnext\nlast',
    findings: [{ path: 'src/a.mjs', text: ' finding\rnext\nlast', detail }],
    remedies: [' remedy\rnext\nlast'],
    after: [' after\rnext\nlast'],
  });
  assert.deepEqual(lines, [
    `${CHECKER_NAME}: FAIL \u2014 \\u0020failure\\rnext\\nlast`,
    'src/a.mjs: \\u0020finding\\rnext\\nlast',
    '  detail stays as handed',
    '    detail keeps its own spaces',
    `${CHECKER_NAME}: REMEDY \u2014 \\u0020remedy\\rnext\\nlast`,
    ' after\\rnext\\nlast',
  ]);
  assert.deepEqual(detail, ['detail stays as handed', '  detail keeps its own spaces']);
  assert.throws(() => composeCheckerBlock({ ...BLOCK_OPTIONS, failed: '' }), TypeError);
  for (const path of ['src/a.mjs', 'src/a:b.mjs']) {
    for (const text of ['', undefined, 42]) {
      assert.throws(() => composeCheckerBlock({
        ...BLOCK_OPTIONS, findings: [{ path, text }],
      }), TypeError, `${path}, text ${String(text)}`);
    }
  }
  assert.throws(() => composeCheckerBlock({ ...BLOCK_OPTIONS, name: 'Bad Name' }), TypeError);
  assert.throws(() => composeCheckerBlock({ ...BLOCK_OPTIONS, remedies: [] }), TypeError);
});

it('spec:checker-block/S3 composes every state-table row in the judged block form', () => {
  assert.equal(typeof composeCheckerBlock, 'function');
  for (const row of PLACE_ROWS) {
    const lines = composeCheckerBlock({
      ...BLOCK_OPTIONS,
      name: row.name,
      root: row.root,
      findings: [
        { path: row.path, line: row.line, text: FINDING_TEXT, detail: ['entry detail'] },
        { path: 'src/ordinary.mjs', text: FINDING_TEXT },
      ],
      after: [...row.laterLines, 'Note: only declared entries were checked'],
    });
    const remedyIndex = lines.findIndex((line) => line.startsWith(`${row.name}: REMEDY \u2014 `));
    assert.ok(remedyIndex > 0, row.label);
    const findingLines = lines.slice(1, remedyIndex).filter((line) => !line.startsWith('  '));
    assert.equal(findingLines.length, 2, row.label);
    const places = findingLines.map((line) => line.slice(0, line.indexOf(': ')));
    assert.deepEqual(judgeBlock(lines.join('\n'), { name: row.name, places }), [], row.label);
  }
});
