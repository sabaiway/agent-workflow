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
});
