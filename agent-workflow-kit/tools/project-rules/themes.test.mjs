import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter } from '../../references/scripts/check-docs-size.mjs';
import { load, need } from './rules-harness.test.mjs';

const KIT_ROOT = new URL('../../', import.meta.url);
const TEMPLATE = new URL('references/rules/project-layout.md', KIT_ROOT);
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;

const ENTRY = {
  name: 'project-layout',
  template: 'references/rules/project-layout.md',
  readWhen: 'Creating, moving or naming a file, a module or a spec',
};

const PRESCRIPTIONS = [
  'A module is a directory', 'code', 'tests', 'mocks', 'fixtures', 'command-line entry',
  'Tests live inside the module',
  'index file', 'exports only what is used', 'Nothing outside reaches past the index',
  "No README repeats the module's spec",
  'Modules nest by meaning', 'slice', 'shared layer', 'never nest by technical layer',
  "A spec's path mirrors its module's path",
  'Old code keeps its place as a recorded exception', 'New and touched code follows',
];

const templateText = () => readFileSync(TEMPLATE, 'utf8');
const bodyLines = (text) => text.replace(FRONTMATTER_RE, '').split('\n');

describe('spec:project-rules/S1 THEMES holds exactly project-layout and themePaths derives its four paths', () => {
  it('THEMES is a frozen array of exactly one frozen entry equal to the project-layout entry', async () => {
    const THEMES = need(await load('./themes.mjs'), 'THEMES');
    assert.ok(Array.isArray(THEMES));
    assert.ok(Object.isFrozen(THEMES), 'THEMES is frozen');
    assert.equal(THEMES.length, 1);
    assert.ok(Object.isFrozen(THEMES[0]), 'the entry is frozen');
    assert.deepEqual({ ...THEMES[0] }, ENTRY);
  });

  it("the entry's template resolves to a regular file under the kit root", async () => {
    const THEMES = need(await load('./themes.mjs'), 'THEMES');
    const { template } = THEMES[0];
    assert.ok(!isAbsolute(template), 'the template path is relative to the kit root');
    const abs = fileURLToPath(new URL(template, KIT_ROOT));
    const rel = relative(fileURLToPath(KIT_ROOT), abs);
    assert.ok(rel !== '' && !rel.startsWith('..') && !isAbsolute(rel), `${template} stays under the kit root`);
    assert.ok(lstatSync(abs).isFile(), `${template} is a regular file`);
  });

  it("themePaths('project-layout') is a frozen record of its kit, local, effective and record paths", async () => {
    const themePaths = need(await load('./themes.mjs'), 'themePaths');
    const paths = themePaths('project-layout');
    assert.ok(Object.isFrozen(paths), 'the paths are frozen');
    assert.deepEqual({ ...paths }, {
      kit: 'docs/ai/rules/project-layout.md',
      local: 'docs/ai/rules/local/project-layout.md',
      effective: 'docs/ai/rules/effective/project-layout.md',
      record: 'docs/ai/rules/effective/sources.json',
    });
  });

  it('themePaths derives the same shape from any name, the record path shared', async () => {
    const themePaths = need(await load('./themes.mjs'), 'themePaths');
    const paths = themePaths('another-theme');
    assert.ok(Object.isFrozen(paths), 'the paths are frozen');
    assert.deepEqual({ ...paths }, {
      kit: 'docs/ai/rules/another-theme.md',
      local: 'docs/ai/rules/local/another-theme.md',
      effective: 'docs/ai/rules/effective/another-theme.md',
      record: 'docs/ai/rules/effective/sources.json',
    });
  });
});

describe('spec:project-rules/S2 the bundled project-layout template is keyless prose stating each prescription', () => {
  it('carries frontmatter', () => {
    const text = templateText();
    assert.match(text, FRONTMATTER_RE);
    assert.notEqual(parseFrontmatter(text), null);
  });

  it('holds at least two sections of plain prose: no fence, table or list line', () => {
    const lines = bodyLines(templateText());
    assert.ok(lines.filter((line) => line.startsWith('## ')).length >= 2, 'at least two ## sections');
    const shaped = lines.filter((line) => /^\s*(```|~~~|\||[-*+]\s|\d+[.)]\s)/.test(line));
    assert.deepEqual(shaped, [], 'no fence, table or list line');
  });

  it('holds no key line', () => {
    const keys = bodyLines(templateText()).filter((line) => /^\s*(?:[-*+]\s+)?[^\s:=]+[:=]/.test(line));
    assert.deepEqual(keys, [], 'no body line is a key');
  });

  it('holds no placeholder', () => {
    const text = templateText();
    for (const token of ['{{', '}}', '${']) assert.ok(!text.includes(token), `no ${token}`);
    assert.doesNotMatch(text, /<[A-Za-z][\w-]*>/, 'no <word> placeholder');
    assert.doesNotMatch(text, /\b(TODO|TBD|XXX)\b/, 'no TODO, TBD or XXX');
  });

  it('states every layout prescription of the themes part', () => {
    const body = bodyLines(templateText()).join('\n');
    const missing = PRESCRIPTIONS.filter((phrase) => !body.includes(phrase));
    assert.deepEqual(missing, [], 'every prescription phrase is present');
  });
});
