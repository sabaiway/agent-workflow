import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter } from '../../references/scripts/check-docs-size.mjs';
import { THEME_NAMES, load, need } from './rules-harness.test.mjs';

const KIT_ROOT = new URL('../../', import.meta.url);
const TEMPLATE = new URL('references/rules/project-layout.md', KIT_ROOT);
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;
const REPO_ROOT = new URL('../', KIT_ROOT);
const ENGINE_ROOT = new URL('agent-workflow-engine/', REPO_ROOT);
const SPEC_CANON = new URL('agent-workflow-engine/references/specs.md', REPO_ROOT);
const SLICED_BULLET = '- **Spec drives modular, feature-sliced architecture.**';
const ARCHITECTURE_TEMPLATES = ['agent-workflow-memory', 'agent-workflow-kit'].map((pkg) => `${pkg}/references/templates/architecture.md`);
const START = '**Start of every session**';
const BEFORE = '**Before any code change**';
const ENTRIES = THEME_NAMES.map((name) => ({ name, home: name === 'lens' ? 'engine' : 'kit', template: `references/rules/${name}.md`, readWhen: name === 'project-layout' ? START : BEFORE }));
const THEME_TEMPLATES = [
  ['project-layout', TEMPLATE],
  ['communication', new URL('references/rules/communication.md', KIT_ROOT)],
  ['story-sessions', new URL('references/rules/story-sessions.md', KIT_ROOT)],
  ['lens', new URL('references/rules/lens.md', ENGINE_ROOT)],
];
const NEW_KIT_THEMES = [
  ['communication', '# Communication', (body) => assert.ok(body.at(-1).startsWith('- **Two blocks for the user.**'), body.at(-1))],
  ['story-sessions', '# Story sessions', (body) => {
    assert.equal(body.length, 1, 'one body line');
    assert.ok(body[0].slice(body[0].lastIndexOf('. ') + 2).includes('only when it writes new tests or code'), body[0]);
  }],
];

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
// afterTitle(text) → the non-blank lines after the title line, the frontmatter stripped.
const afterTitle = (text) => {
  const lines = bodyLines(text);
  return lines.slice(lines.findIndex((line) => line.startsWith('# ')) + 1).filter((line) => line.trim() !== '');
};
const titleOf = (text) => bodyLines(text).find((line) => line.startsWith('# '));
const sectionProse = (text, heading) => text.split(`\n${heading}\n`)[1]?.split('\n## ')[0].split('\n').map((line) => line.trim()).filter(Boolean).join(' ');
const sliceBullet = (text) => {
  const start = text.indexOf(SLICED_BULLET);
  const end = text.indexOf('\n- **', start + SLICED_BULLET.length);
  return start === -1 ? '' : text.slice(start, end === -1 ? undefined : end);
};
const findLead = (text) => text.slice(text.indexOf('\n# Architecture\n')).split('\n').find((line) => line.startsWith('> '));
const loadEffective = async () => need(await load('./themes.mjs'), 'themePaths')('project-layout').effective;
const precedenceLine = async () => need(await load('./themes.mjs'), 'PRECEDENCE_LINE');

describe('spec:project-rules/S1 THEMES holds the four themes in order and themePaths derives their four paths', () => {
  it('THEMES is a frozen array of exactly the four frozen entries with their home, template and read-when', async () => {
    const THEMES = need(await load('./themes.mjs'), 'THEMES');
    assert.ok(Array.isArray(THEMES));
    assert.ok(Object.isFrozen(THEMES), 'THEMES is frozen');
    assert.ok(THEMES.every((entry) => Object.isFrozen(entry)), 'every entry is frozen');
    assert.deepEqual(THEMES.map((entry) => ({ ...entry })), ENTRIES);
  });

  it("each kit-homed template resolves to a regular file under the kit root, the engine-homed one under the engine's", async () => {
    const THEMES = need(await load('./themes.mjs'), 'THEMES');
    for (const { template, home } of THEMES) {
      const root = home === 'engine' ? ENGINE_ROOT : KIT_ROOT;
      assert.ok(!isAbsolute(template), 'the template path is relative to its home');
      const abs = fileURLToPath(new URL(template, root));
      const rel = relative(fileURLToPath(root), abs);
      assert.ok(rel !== '' && !rel.startsWith('..') && !isAbsolute(rel), `${template} stays under its home`);
      assert.ok(lstatSync(abs).isFile(), `${home}: ${template} is a regular file`);
    }
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

describe('spec:project-rules/S2 the bundled project-layout template opens with the precedence line, then keyless prose stating each prescription', () => {
  it('carries frontmatter and PRECEDENCE_LINE as the first non-blank line after the title', async () => {
    const text = templateText();
    assert.match(text, FRONTMATTER_RE);
    assert.notEqual(parseFrontmatter(text), null);
    assert.equal(afterTitle(text)[0], await precedenceLine());
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

  it('states every layout prescription of the themes part, the spec section exactly its sentence', () => {
    const body = bodyLines(templateText()).join('\n');
    const missing = PRESCRIPTIONS.filter((phrase) => !body.includes(phrase));
    assert.deepEqual(missing, [], 'every prescription phrase is present');
    assert.equal(sectionProse(templateText(), '## The spec mirrors the module'), "Specs live in docs/ai/specs. A spec's path mirrors its module's path, so the name of one gives the place of the other.");
  });
});

describe('spec:project-rules/S26 the communication and story-sessions kit templates carry their outgoing section bodies under the precedence line', () => {
  for (const [name, title, bodyRule] of NEW_KIT_THEMES) {
    it(`references/rules/${name}.md: the frontmatter form, the title, PRECEDENCE_LINE, then the section body with no heading, number or kit path`, async () => {
      const text = readFileSync(new URL(`references/rules/${name}.md`, KIT_ROOT), 'utf8');
      const fields = parseFrontmatter(text);
      assert.ok(fields !== null && FRONTMATTER_RE.test(text), 'frontmatter');
      assert.deepEqual(Object.keys(fields).sort(), Object.keys(parseFrontmatter(templateText())).sort(), 'the keys of project-layout.md');
      assert.deepEqual([fields.type, fields.owner], ['rules', 'kit']);
      assert.match(fields.maxLines, /^[1-9][0-9]*$/);
      assert.equal(titleOf(text), title);
      const [first, ...body] = afterTitle(text);
      assert.equal(first, await precedenceLine());
      assert.ok(body.length > 0, 'a body after the precedence line');
      assert.deepEqual(body.filter((line) => line.startsWith('#')), [], 'the section heading is dropped');
      assert.deepEqual(body.filter((line) => /§ ?[0-9]|\b[0-9]+\.[0-9]+\.\s/.test(line)), [], 'no number names a section of another file');
      assert.deepEqual(body.filter((line) => /<kit>|\$\{CLAUDE_SKILL_DIR\}|agent-workflow-kit\/|references\//.test(line)), [], 'no kit path');
      bodyRule(body);
    });
  }
});

describe('spec:project-rules/S27 the precedence line opens every theme template and the kit block', () => {
  for (const [name, url] of THEME_TEMPLATES) {
    it(`${name}: the first non-blank line after the title is PRECEDENCE_LINE`, async () => {
      assert.equal(afterTitle(readFileSync(url, 'utf8'))[0], await precedenceLine());
    });
  }

  it("the kit block's first body line is PRECEDENCE_LINE, which names no workflow:kit marker", async () => {
    const PRECEDENCE_LINE = await precedenceLine();
    const THEMES = need(await load('./themes.mjs'), 'THEMES');
    const block = await import('../inject-methodology.mjs');
    const composed = need(block, 'composeKitBlock')({ fragments: { methodology: 'The methodology.', orchestration: 'The recipes.', autonomy: 'The policy.' }, themes: THEMES });
    const lines = composed.split('\n');
    const start = lines.findIndex((line) => line.trim() === need(block, 'BLOCK_START'));
    assert.ok(start >= 0, composed);
    assert.equal(lines.slice(start + 1).find((line) => line.trim() !== ''), PRECEDENCE_LINE);
    assert.equal(PRECEDENCE_LINE.includes('workflow:kit'), false);
    assert.equal(PRECEDENCE_LINE.includes('\n'), false, 'one line');
  });
});

describe('spec:project-rules/S36 the lens template lives only in the engine', () => {
  it('the kit ships no references/rules/lens.md and the engine ships no lens fragment or prior store', () => {
    assert.equal(existsSync(new URL('references/rules/lens.md', KIT_ROOT)), false, 'kit references/rules/lens.md');
    for (const rel of ['references/agent-rules-lens.md', 'references/agent-rules-lens-priors.md']) {
      assert.equal(existsSync(new URL(rel, ENGINE_ROOT)), false, rel);
    }
  });

  it('engine-source.mjs exports LENS_THEME_REL and no LENS_FRAGMENT_REL or LENS_PRIORS_REL', async () => {
    const source = await import('../engine-source.mjs');
    assert.equal(need(source, 'LENS_THEME_REL'), ENTRIES.find(({ name }) => name === 'lens').template);
    assert.deepEqual(['LENS_FRAGMENT_REL', 'LENS_PRIORS_REL'].filter((name) => name in source), []);
  });
});

describe('spec:project-rules/S33 the spec canon and both architecture templates hand the layout to the project-layout rules', () => {
  it('the feature-sliced bullet names the effective file as laid down in a kit deployment', async () => {
    const effective = await loadEffective();
    const bullet = sliceBullet(readFileSync(SPEC_CANON, 'utf8'));
    assert.ok(bullet.includes(effective), `the feature-sliced bullet names ${effective}`);
    assert.match(bullet, /in a kit deployment/i);
  });

  for (const path of ARCHITECTURE_TEMPLATES) {
    it(`${path} names the effective file and carries no layer section`, async () => {
      const effective = await loadEffective();
      const text = readFileSync(new URL(path, REPO_ROOT), 'utf8');
      assert.ok(text.includes(effective), `the template names ${effective}`);
      assert.match(text, /in a kit deployment/i);
      assert.doesNotMatch(text, /^## (?:Layers|Module Boundaries)\s*$/m, 'no Layers or Module Boundaries heading');
      assert.match(findLead(text) ?? '', /^> (?!.*\bLayers\b)/, 'a lead line after # Architecture, without the word Layers');
    });
  }
});
