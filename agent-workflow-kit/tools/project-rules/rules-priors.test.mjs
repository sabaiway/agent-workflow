// The prior catalog: frozen, the 14.37.0 and 19.4.0 bodies its two entries, its one question over a given catalog,
// every entry's body on disk; the new themes have no prior, so the op replaces any other body of theirs.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { KIT_ROOT, load, makeEngine, makeProject, need, removeProject, sha } from './rules-harness.test.mjs';
import { THEMES } from './themes.mjs';

const THEME = 'project-layout';
const PRIOR_BODY = Buffer.from('---\ntype: rules\n---\n\n# Project layout\n\nThe body an earlier release shipped.\n');
const CATALOG = Object.freeze([Object.freeze({ theme: THEME, release: '14.0.0', sha256: sha(PRIOR_BODY) })]);
const DIGEST_RE = /^[0-9a-f]{64}$/;
const SHIPPED_BODIES = Object.freeze([
  'b79f19a9e0583f1e0619ee6aca06feb2c359b9655f1d260e87d8d5647bd1de19',
  'ec4ef10c05ba365e73df96d175042314ea120f3fe1c946fdd94d3d1237de8be9',
  'c5c814d61842358e97fdc4961fde74a208e37a1c91fa18a86e27661e7e91524a',
]);
const FIXTURES = ['14.37.0', '19.4.0'].map((release) => new URL(`fixtures/project-layout/${release}.md`, import.meta.url));
const TEMPLATE = new URL('../../references/rules/project-layout.md', import.meta.url);
const OUTGOING_HEADINGS = { communication: '### 2.5. Communication (user-facing messages)', 'story-sessions': '### 2.7. Story sessions' };
const FIVE_SESSIONS = 'runs as five sessions';
const ONE_TASK = 'Inside the tests and code sessions it is one task per session.';

const priorsOf = () => load('./rules-priors.mjs');
const roots = [];
after(() => roots.forEach(removeProject));

const kitPath = (theme) => `docs/ai/rules/${theme}.md`;
const templateOf = (theme) => readFileSync(join(KIT_ROOT, 'references', 'rules', `${theme}.md`), 'utf8');
// The section body the template carries, its frontmatter, title and precedence line dropped.
const sectionBody = (text) => {
  const lines = text.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  const title = lines.findIndex((line) => line.startsWith('# '));
  const precedence = lines.findIndex((line, index) => index > title && line.trim() !== '');
  return lines.slice(precedence + 1).join('\n').replace(/^\n+/, '');
};
// ensureOver(files) → the op's lines and the root after one run over the real kit and a complete engine fixture.
const ensureOver = async (files) => {
  const ensureRules = need(await load('./rules-ensure.mjs'), 'ensureRules');
  const engine = makeEngine();
  const root = makeProject(files);
  roots.push(root, engine.dir, engine.home);
  const outcome = ensureRules({ cwd: root, kitRoot: KIT_ROOT, deps: { env: engine.env, home: engine.home } });
  return { ...outcome, root };
};
const replacedLine = (theme) => `${kitPath(theme)}: differs from every body this kit knows it shipped — replaced by the bundled template; a rule meant to last goes in docs/ai/rules/local/${theme}.md, where it wins`;

describe('spec:project-rules/S24 RULES_PRIORS is a frozen catalog of the 14.37.0 and 19.4.0 bodies and isKnownPrior answers over the given catalog', () => {
  it('RULES_PRIORS is a frozen list of exactly the project-layout 14.37.0 and 19.4.0 entries', async () => {
    const RULES_PRIORS = need(await priorsOf(), 'RULES_PRIORS');
    assert.ok(Array.isArray(RULES_PRIORS), 'RULES_PRIORS is a list');
    assert.ok(Object.isFrozen(RULES_PRIORS), 'RULES_PRIORS is frozen');
    assert.deepEqual(RULES_PRIORS.map((entry) => ({ ...entry })), [
      { theme: THEME, release: '14.37.0', sha256: SHIPPED_BODIES[0] },
      { theme: THEME, release: '19.4.0', sha256: SHIPPED_BODIES[1] },
    ]);
  });

  it('the default catalog knows both fixture bodies and not the current template', async () => {
    const isKnownPrior = need(await priorsOf(), 'isKnownPrior');
    for (const fixture of FIXTURES) assert.equal(isKnownPrior(THEME, readFileSync(fixture)), true, `${fixture.pathname} is a known prior`);
    assert.equal(isKnownPrior(THEME, readFileSync(TEMPLATE)), false, 'the current template is no prior');
  });

  it('the literal shipped digests are the catalog digests plus the current template digest', async () => {
    const RULES_PRIORS = need(await priorsOf(), 'RULES_PRIORS');
    assert.deepEqual([...RULES_PRIORS.map((entry) => entry.sha256), sha(readFileSync(TEMPLATE))], SHIPPED_BODIES);
  });

  it('isKnownPrior is true exactly for the bytes of an entry of the given theme', async () => {
    const isKnownPrior = need(await priorsOf(), 'isKnownPrior');
    assert.equal(isKnownPrior(THEME, PRIOR_BODY, CATALOG), true);
    assert.equal(isKnownPrior('other-theme', PRIOR_BODY, CATALOG), false, 'another theme with the same digest');
    assert.equal(isKnownPrior(THEME, Buffer.from('other bytes\n'), CATALOG), false, 'other bytes');
    assert.equal(isKnownPrior(THEME, PRIOR_BODY), false, 'the default catalog');
  });

  it('every entry is a frozen theme, release and digest whose fixture body hashes to it', async () => {
    const RULES_PRIORS = need(await priorsOf(), 'RULES_PRIORS');
    const names = THEMES.map((theme) => theme.name);
    for (const entry of RULES_PRIORS) {
      const label = `${entry.theme} ${entry.release}`;
      assert.ok(Object.isFrozen(entry), `${label} is frozen`);
      assert.deepEqual(Object.keys(entry).sort(), ['release', 'sha256', 'theme'], `${label} keys`);
      assert.ok(names.includes(entry.theme), `${label} names a registry theme`);
      assert.match(entry.sha256, DIGEST_RE, `${label} digest is 64 lowercase hex`);
      const body = readFileSync(new URL(`fixtures/${entry.theme}/${entry.release}.md`, import.meta.url));
      assert.equal(sha(body), entry.sha256, `${label} fixture body hashes to its digest`);
    }
  });
});

describe('spec:session-rules/S2 no prior for the new themes: a deployed body of theirs is replaced naming its local file', () => {
  for (const theme of Object.keys(OUTGOING_HEADINGS)) {
    for (const [what, body] of [
      ['the outgoing section body', () => `${OUTGOING_HEADINGS[theme]}\n${sectionBody(templateOf(theme))}`],
      ['a body of its own', () => `# ${theme}\n\nMy own rule.\n`],
    ]) {
      it(`${kitPath(theme)} holding ${what} is replaced by its template, the line naming its local file`, async () => {
        assert.deepEqual(need(await priorsOf(), 'RULES_PRIORS').filter((entry) => entry.theme === theme), [], 'no prior entry');
        const run = await ensureOver({ [kitPath(theme)]: body() });
        assert.ok(run.lines.includes(replacedLine(theme)), run.lines.join('\n'));
        assert.equal(readFileSync(join(run.root, kitPath(theme)), 'utf8'), templateOf(theme));
      });
    }
  }
});

describe('spec:story-flow/S6 the section priors retire: no shipped file carries them, and a deployed story-sessions file holding one is replaced', () => {
  const shippedFiles = (dir) => readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(?:mjs|md)$/.test(entry.name) && !entry.name.includes('.test.') && entry.name !== 'CHANGELOG.md')
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !/[/](?:node_modules|fixtures|test|\.[^/]+|[^/]+\.test)[/]/.test(path));

  it('no kit or engine file ships the five-session body or the one-task-per-session sentence', () => {
    const files = [KIT_ROOT, join(KIT_ROOT, '..', 'agent-workflow-engine')].flatMap(shippedFiles);
    assert.ok(files.some((path) => path.endsWith('rules-priors.mjs')), 'the walk reaches the kit tools');
    const carrying = files.filter((path) => {
      const text = readFileSync(path, 'utf8');
      return text.includes(FIVE_SESSIONS) || text.includes('it is one task per session');
    });
    assert.deepEqual(carrying, []);
  });

  for (const [what, edit] of [
    ['the five-session body', (text) => text.replace('runs as four sessions', FIVE_SESSIONS)],
    ['the one-task-per-session sentence', (text) => `${text.trimEnd()} ${ONE_TASK}\n`],
  ]) {
    it(`docs/ai/rules/story-sessions.md holding ${what} is replaced by the four-session template`, async () => {
      const template = templateOf('story-sessions');
      const deployed = edit(template);
      assert.notEqual(deployed, template, 'the fixture differs from the template');
      const run = await ensureOver({ [kitPath('story-sessions')]: deployed });
      assert.ok(run.lines.includes(replacedLine('story-sessions')), run.lines.join('\n'));
      assert.equal(readFileSync(join(run.root, kitPath('story-sessions')), 'utf8'), template);
    });
  }
});
