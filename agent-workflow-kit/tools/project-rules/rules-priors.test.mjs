// Contract: docs/ai/specs/kit/project-rules/rules-priors.md;
// outgoing section replacement: docs/ai/specs/kit/tier/session-rules/index.md, S2.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { EXPECTED_ENGINE_NAME, LENS_THEME_REL } from '../engine-source.mjs';
import { KIT_ROOT, entryOf, load, makeEngine, makeProject, need, recordText, removeProject, sha } from './rules-harness.test.mjs';
import { THEMES, themePaths } from './themes.mjs';

const THEME = 'project-layout';
const LENS = 'lens';
const STORY_SESSIONS = 'story-sessions';
const LENS_RELEASE = '20.0.0';
const ENGINE_HOME = 'engine';
const ENGINE_ROOT = join(KIT_ROOT, '..', EXPECTED_ENGINE_NAME);
const fixtureOf = (theme, release) => new URL(`fixtures/${theme}/${release}.md`, import.meta.url);
const PRIOR_REFRESH = 'held the body an earlier release shipped — refreshed to the bundled template';
const PRIOR_BODY = Buffer.from('---\ntype: rules\n---\n\n# Project layout\n\nThe body an earlier release shipped.\n');
const CATALOG = Object.freeze([Object.freeze({ theme: THEME, release: '14.0.0', sha256: sha(PRIOR_BODY) })]);
const DIGEST_RE = /^[0-9a-f]{64}$/;
const SHIPPED_BODIES = Object.freeze({
  'project-layout': Object.freeze([
    'b79f19a9e0583f1e0619ee6aca06feb2c359b9655f1d260e87d8d5647bd1de19',
    'ec4ef10c05ba365e73df96d175042314ea120f3fe1c946fdd94d3d1237de8be9',
    'c5c814d61842358e97fdc4961fde74a208e37a1c91fa18a86e27661e7e91524a',
  ]),
  communication: Object.freeze([
    'ce0ebcab194b21fedd96c389daefb92be3cf2b5fe15f3c40b0485c32a2575e1f',
    '15200a1367f64610caf52780bf518499ce14444458c830f2682d216c6d95ca7b',
  ]),
  [LENS]: Object.freeze([
    'd0cd7c6f602710f3d292644f78d2e9ccf569b1ce9a9d00bcb2e9cfd831e18703',
    '051a5b66ec9851f59f4ab47f4667602278e356ea343e17c6e009a78b727faa1e',
  ]),
  [STORY_SESSIONS]: Object.freeze([
    '696fc850b04c91ed4fe6b5d370835c420163a729cef3803d57ed86b06bde6b49',
    '032823894725d9bea6e0e01c501deec0e52ec3c7460092b76d14edaefae4d446',
  ]),
});
const EXPECTED_PRIORS = [
  { theme: THEME, release: '14.37.0', sha256: SHIPPED_BODIES[THEME][0] },
  { theme: THEME, release: '19.4.0', sha256: SHIPPED_BODIES[THEME][1] },
  { theme: 'communication', release: '20.0.0', sha256: SHIPPED_BODIES.communication[0] },
  { theme: LENS, release: LENS_RELEASE, sha256: SHIPPED_BODIES[LENS][0] },
  { theme: STORY_SESSIONS, release: '20.0.0', sha256: SHIPPED_BODIES[STORY_SESSIONS][0] },
];
const OUTGOING_HEADINGS = { communication: '### 2.5. Communication (user-facing messages)', 'story-sessions': '### 2.7. Story sessions' };
const FIVE_SESSIONS = 'runs as five sessions';
const ONE_TASK = 'Inside the tests and code sessions it is one task per session.';

const priorsOf = () => load('./rules-priors.mjs');
const roots = [];
after(() => roots.forEach(removeProject));

const kitPath = (theme) => `docs/ai/rules/${theme}.md`;
const themeOf = (theme) => THEMES.find(({ name }) => name === theme);
const templateOf = (theme) => {
  const { home, template } = themeOf(theme);
  return readFileSync(home === ENGINE_HOME ? join(ENGINE_ROOT, LENS_THEME_REL) : join(KIT_ROOT, template), 'utf8');
};
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
  return { ...outcome, root, engineDir: engine.dir };
};
const replacedLine = (theme) => `${kitPath(theme)}: differs from every body this kit knows it shipped — replaced by the bundled template; a rule meant to last goes in docs/ai/rules/local/${theme}.md, where it wins`;

describe('spec:project-rules/S24 RULES_PRIORS is a frozen catalog of exactly five entries including story-sessions 20.0.0 and isKnownPrior answers per theme over the given catalog', () => {
  it('RULES_PRIORS is a frozen list of exactly five entries in order: project-layout 14.37.0, project-layout 19.4.0, communication 20.0.0, lens 20.0.0 and story-sessions 20.0.0', async () => {
    const RULES_PRIORS = need(await priorsOf(), 'RULES_PRIORS');
    assert.ok(Array.isArray(RULES_PRIORS), 'RULES_PRIORS is a list');
    assert.ok(Object.isFrozen(RULES_PRIORS), 'RULES_PRIORS is frozen');
    assert.deepEqual(RULES_PRIORS.map((entry) => ({ ...entry })), EXPECTED_PRIORS);
  });

  it('the default catalog knows every expected fixture body under its theme and no catalogued current template', async () => {
    const isKnownPrior = need(await priorsOf(), 'isKnownPrior');
    for (const { theme, release } of EXPECTED_PRIORS) {
      const fixture = fixtureOf(theme, release);
      assert.equal(isKnownPrior(theme, readFileSync(fixture)), true, `${fixture.pathname} is a known prior`);
    }
    for (const theme of Object.keys(SHIPPED_BODIES)) assert.equal(isKnownPrior(theme, templateOf(theme)), false, `${theme}: the current template is no prior`);
  });

  it("per theme the literal shipped digests are that theme's catalog digests in order plus its current template digest", async () => {
    const RULES_PRIORS = need(await priorsOf(), 'RULES_PRIORS');
    for (const [theme, digests] of Object.entries(SHIPPED_BODIES)) {
      const priors = RULES_PRIORS.filter((entry) => entry.theme === theme).map((entry) => entry.sha256);
      assert.deepEqual([...priors, sha(templateOf(theme))], digests, theme);
    }
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
      const body = readFileSync(fixtureOf(entry.theme, entry.release));
      assert.equal(sha(body), entry.sha256, `${label} fixture body hashes to its digest`);
    }
  });

  it('refreshes deployed lens 20.0.0 and its recorded effective copy from the engine template', async () => {
    const prior = readFileSync(fixtureOf(LENS, LENS_RELEASE));
    const { kit, effective, record } = themePaths(LENS);
    const run = await ensureOver({
      [kit]: prior,
      [effective]: prior,
      [record]: recordText({ [LENS]: entryOf({ kit: prior, effective: prior }) }),
    });
    const template = readFileSync(join(run.engineDir, themeOf(LENS).template));
    assert.notDeepEqual(template, prior);
    const line = run.lines.find((line) => line.startsWith(`${kit}:`));
    assert.equal(line, `${kit}: ${PRIOR_REFRESH}`, line);
    assert.deepEqual(readFileSync(join(run.root, kit)), template);
    assert.deepEqual(readFileSync(join(run.root, effective)), template);
    const { themes } = JSON.parse(readFileSync(join(run.root, record), 'utf8'));
    assert.deepEqual(themes[LENS], entryOf({ kit: template, effective: template }));
  });
});

describe('spec:session-rules/S2 no prior for the outgoing sections: one story-sessions and one communication 20.0.0 entry, other bodies replaced naming their local file', () => {
  for (const theme of Object.keys(OUTGOING_HEADINGS)) {
    it(`${kitPath(theme)} holding the 20.0.0 template is refreshed without a line naming its local file`, async () => {
      const prior = readFileSync(fixtureOf(theme, '20.0.0'));
      const template = Buffer.from(templateOf(theme));
      assert.notDeepEqual(prior, template);
      const run = await ensureOver({ [kitPath(theme)]: prior });
      assert.ok(run.lines.includes(`${kitPath(theme)}: ${PRIOR_REFRESH}`), run.lines.join('\n'));
      assert.ok(!run.lines.some((line) => line.includes(themePaths(theme).local)), run.lines.join('\n'));
      assert.deepEqual(readFileSync(join(run.root, kitPath(theme))), template);
    });
    for (const [what, body] of [
      ['the outgoing section body', () => `${OUTGOING_HEADINGS[theme]}\n${sectionBody(templateOf(theme))}`],
      ['a body of its own', () => `# ${theme}\n\nMy own rule.\n`],
    ]) {
      it(`${kitPath(theme)} holding ${what} is replaced by its template, the line naming its local file`, async () => {
        assert.deepEqual(need(await priorsOf(), 'RULES_PRIORS').filter((entry) => entry.theme === theme), EXPECTED_PRIORS.filter((entry) => entry.theme === theme), `${theme}: expected prior entries`);
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
    const files = [KIT_ROOT, ENGINE_ROOT].flatMap(shippedFiles);
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
