import assert from 'node:assert/strict';
import { test } from 'node:test';

const pathCase = ['docs/ai/specs/', 'docs-ai/specs/', 'docs/ai-specs/', 'docs/ai/specs-'];
const embeddedCases = [
  ['.', 'a.b', 'axb'],
  ['*', 'a*b', 'axb', 'aaab'],
  ['+', 'x+y', 'xzy', 'xxy'],
  ['?', 'a?b', 'axb', 'ab'],
  ['^', '^top', 'xtop', 'top'],
  ['$', '$HOME', 'xHOME', 'HOME'],
  ['{', 'a{b', 'axb'],
  ['}', 'a}b', 'axb'],
  ['(', '(1)', 'x1)', '1'],
  [')', 'a)b', 'axb'],
  ['|', 'a|b', 'axb', 'a', 'b'],
  ['[', '[draft]', 'xdraft]', 'd'],
  [']', 'a]b', 'axb'],
  ['\\', 'c:\\dir', 'c:xdir', 'c:1ir'],
  ['/', ...pathCase],
];
const syntaxCharacters = embeddedCases.map(([character]) => character).join('');
const allCharactersCase = [
  syntaxCharacters,
  ...Array.from(syntaxCharacters, (_, index) =>
    `${syntaxCharacters.slice(0, index)}x${syntaxCharacters.slice(index + 1)}`),
];

test('repo-lex exports escapeRegExp as a function', async () => {
  const { escapeRegExp } = await import('./repo-lex.mjs');
  assert.equal(typeof escapeRegExp, 'function');
});

test('escapeRegExp makes each syntax character literal alone and within a value', async () => {
  const { escapeRegExp } = await import('./repo-lex.mjs');
  const literalCases = embeddedCases.flatMap(([character, ...embeddedCase]) => [
    [character, 'x', ''],
    embeddedCase,
  ]);
  for (const [value, ...differentValues] of [...literalCases, allCharactersCase]) {
    const pattern = new RegExp(`^${escapeRegExp(value)}$`);
    assert.match(value, pattern);
    for (const differentValue of differentValues) {
      assert.doesNotMatch(differentValue, pattern);
    }
  }
});

test('escapeRegExp produces exact matches under the u flag', async () => {
  const { escapeRegExp } = await import('./repo-lex.mjs');
  for (const [value, differentValue] of [allCharactersCase, pathCase]) {
    const pattern = new RegExp(`^${escapeRegExp(value)}$`, 'u');
    assert.match(value, pattern);
    assert.doesNotMatch(differentValue, pattern);
  }
});
