// template-region-parity.test.mjs — the AD-038 discovery-line template guard: the §1.1 session-start
// region of the kit and memory `agent_rules.md` templates, and the "Active recipes:" handover slot
// line of the kit and memory `handover.md` templates, stay BYTE-IDENTICAL across the two packages
// (the two templates deliberately diverge elsewhere — §1.3/§5 — so the whole-file parity guard
// cannot cover these regions). Both regions stay PATH-NEUTRAL: the memory substrate names no sibling
// skill (AD-019 knows-nobody DAG), so `/agent-workflow-kit` never appears in either template region —
// the kit-command convenience lives only in the kit SKILL/README and a project's own dogfood files.
// The Communication and Story sessions texts live in the kit's two rules themes, never in a rules
// template. Non-vacuity: an injected divergence must be caught by the same extractor + comparator.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_TEMPLATES = join(HERE, '..', 'references', 'templates');
const KIT_THEMES = join(HERE, '..', 'references', 'rules');
const MEMORY_TEMPLATES = join(HERE, '..', '..', 'agent-workflow-memory', 'references', 'templates');
const LF = String.fromCharCode(10);
const RULES_FILE = 'agent_rules.md';
const SESSION_CLOSE_LEAD = '- **Two blocks for the user.**';
const TASK_PHRASE = 'only when it writes new tests or code';
const KIT_PATH_RE = /agent-workflow-kit|<kit>|tools\//;
const FOR_THE_USER = '## For the user';
const LABELS = ['**What was done, and for what:**', '**What is next, and why:**'];
const PLACEHOLDER_RE = /\{\{|TODO|<[a-z]/i;
const RETIRED_SECTION_RE = /^#+ .*\b(?:Communication|Story sessions|Planning, review)/;
// The literal Story sessions canon, copied byte for byte from the story-flow contract's flow-steps
// part, split at its em dashes so no source line passes the line cap.
const STORY_CANON = [
  "A story ",
  " one row of an epic's ledger, carried by one plan ",
  " runs as four sessions, each step in them giving one checked result: **spec and plan** (every contract the story creates or revises and the plan's ledger beside them, checked by the spec gate, the plan-shape gate and one review of at most two rounds that reads both, then the plan's approval), **tests** (only tests, each new one failing for the reason its scenario or acceptance bullet states, or on the absence of a name the plan adds, imported inside the test; no code and no prototype), **code** (code until the tests and the pre-review gates pass; a wrong test is changed only back to what its scenario states), and **diff review, release and record** (every committable output, tracked records included, staged first, the review of the staged diff in at most two rounds, the final gates and the release where the story ships one, then the plan's Phase: Cleanup). Tests and code never share a session. A storyless plan runs the same four. **Exception ",
  " a split:** moving code and its existing cases into modules, with no new logic and no new case, is one session: a short spec (the Module list), the split, the diff review, the release, Cleanup. A bridge executor gets a task only when it writes new tests or code, from one prompt of the orchestrator; a file the orchestrator already wrote is laid down by the orchestrator, never relayed through a bridge.",
].join(String.fromCharCode(8212));

const read = (root, name) => readFileSync(join(root, name), 'utf8');

// A kit theme template: frontmatter, its title, PRECEDENCE_LINE, then the body's non-blank lines.
const themeBody = async (name) => {
  const { PRECEDENCE_LINE } = await import('../tools/project-rules/index.mjs');
  assert.equal(typeof PRECEDENCE_LINE, 'string', 'the project-rules index exports PRECEDENCE_LINE');
  const lines = read(KIT_THEMES, `${name}.md`).split(LF);
  assert.equal(lines[0], '---', `${name}: the theme opens with frontmatter`);
  const rest = lines.slice(lines.indexOf('---', 1) + 1).filter((line) => line.trim() !== '');
  assert.equal(rest[1], PRECEDENCE_LINE, `${name}: PRECEDENCE_LINE follows the title`);
  return rest.slice(2);
};
const retiredSections = (text) => text.split(LF).filter((line) => RETIRED_SECTION_RE.test(line));

// The §1.1 region: its heading line through (exclusive) the next `### ` heading.
const extractSessionStartRegion = (text) => {
  const heading = '### 1.1. Start of Session';
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, 'the §1.1 heading exists');
  const next = text.indexOf('### ', start + heading.length);
  return text.slice(start, next === -1 ? text.length : next);
};

// The handover slot: the single line starting `**Active recipes:**`.
const extractActiveRecipesLine = (text) => {
  const lines = text.split('\n').filter((l) => l.startsWith('**Active recipes:**'));
  assert.equal(lines.length, 1, 'exactly one "**Active recipes:**" slot line');
  return lines[0];
};

describe('agent_rules.md §1.1 — kit and memory template regions are byte-identical', () => {
  const kit = extractSessionStartRegion(read(KIT_TEMPLATES, 'agent_rules.md'));
  const memory = extractSessionStartRegion(read(MEMORY_TEMPLATES, 'agent_rules.md'));

  it('the two §1.1 regions match byte-for-byte', () => {
    assert.equal(kit, memory, 'kit and memory agent_rules.md §1.1 regions have drifted — edit both in the same change');
  });

  it('the region carries the orchestration.json discovery step, before the pick-a-task step', () => {
    assert.match(kit, /orchestration\.json/);
    assert.match(kit, /CONFIGURED orchestration recipes/);
    assert.ok(
      kit.indexOf('orchestration.json') < kit.indexOf('active_plan.md'),
      'the config is read BEFORE a task is picked',
    );
    assert.match(kit, /silent recipe downgrade/);
  });

  it('the region is path-neutral in BOTH templates (no sibling-skill mention)', () => {
    for (const region of [kit, memory]) {
      assert.ok(!region.includes('agent-workflow-kit'), 'template §1.1 never names the kit');
      assert.ok(!region.includes('--active-line'), 'template §1.1 never names the kit flag');
    }
  });

  it('non-vacuous: an injected divergence is caught by the same extractor + comparator', () => {
    const mutated = read(KIT_TEMPLATES, 'agent_rules.md').replace('orchestration.json', 'orchestration.json5');
    assert.notEqual(extractSessionStartRegion(mutated), memory, 'the guard detects a one-byte region divergence');
  });
});

describe('the communication theme carries the plain-language bar (the AD-061 communication contract)', () => {
  it('references/rules/communication.md carries every plain-language token', async () => {
    const body = (await themeBody('communication')).join(LF);
    for (const token of [
      'Plain language',
      'plain words of the dialogue language',
      'transliterated English jargon is banned',
      'NAME of a thing',
      'glossed in plain words',
      'plain English stays plain',
    ]) {
      assert.ok(body.includes(token), `the communication theme is missing the plain-language token "${token}"`);
    }
  });
});

describe('spec:session-rules/S1 the two rules in their themes, and no rules template carries their sections', () => {
  it('the communication theme body ends with the Two blocks for the user bullet, once', async () => {
    const body = await themeBody('communication');
    assert.ok(body.at(-1).startsWith(SESSION_CLOSE_LEAD), body.at(-1));
    assert.equal(body.filter((line) => line.includes('Two blocks for the user')).length, 1);
  });

  it('the story-sessions theme body line ends with the bridge-executor sentence', async () => {
    const [line] = await themeBody('story-sessions');
    assert.match(line.slice(line.lastIndexOf('. ') + 2), new RegExp(TASK_PHRASE), 'the body does not end with the bridge-executor sentence');
    assert.equal(line.split(TASK_PHRASE).length, 2);
  });

  it('the story-sessions theme carries, after its title and the precedence line, exactly the literal canon, and neither rules template carries a Story sessions section; the guard reads nothing under the project docs spec:story-flow/S5', async () => {
    assert.deepEqual(await themeBody('story-sessions'), [STORY_CANON], 'S5: the story-sessions theme body is not the four-session canon');
    for (const root of [KIT_TEMPLATES, MEMORY_TEMPLATES]) assert.deepEqual(read(root, RULES_FILE).split(LF).filter((line) => /^#+ .*Story sessions/.test(line)), [], root);
    assert.doesNotMatch(readFileSync(fileURLToPath(import.meta.url), 'utf8'), new RegExp(['docs', 'ai'].join('/')));
  });

  it('neither theme names a kit path', async () => {
    for (const name of ['communication', 'story-sessions']) assert.doesNotMatch((await themeBody(name)).join(LF), KIT_PATH_RE, name);
  });

  it('neither the kit nor the memory rules template carries a Communication, a Story sessions or a planning-review invariants section', () => {
    for (const root of [KIT_TEMPLATES, MEMORY_TEMPLATES]) assert.deepEqual(retiredSections(read(root, RULES_FILE)), [], root);
  });

  it('non-vacuous: a section heading put back into a template copy is caught (injected)', () => {
    const doctored = `${read(KIT_TEMPLATES, RULES_FILE)}${LF}### 2.5. Communication (user-facing messages)${LF}`;
    assert.equal(retiredSections(doctored).length >= 1, true);
  });
});

describe('spec:session-rules/S4 the handover section and the changelog field in both templates', () => {
  for (const [label, root] of [['kit', KIT_TEMPLATES], ['memory', MEMORY_TEMPLATES]]) {
    it(`the handover carries the section once, after the Active recipes line and before the last-session block: ${label}`, () => {
      const lines = read(root, 'handover.md').split(LF);
      const start = lines.indexOf(FOR_THE_USER);
      assert.equal(lines.filter((line) => line === FOR_THE_USER).length, 1);
      assert.ok(lines.findIndex((line) => line.startsWith('**Active recipes:**')) < start);
      assert.ok(start < lines.indexOf('## What was done last session'));
      const section = lines.slice(start + 1, lines.findIndex((line, index) => index > start && line.startsWith('## ')));
      const at = LABELS.map((label) => section.indexOf(label));
      assert.deepEqual(LABELS.map((label) => section.filter((line) => line === label).length), [1, 1]);
      assert.ok(at[0] < at[1], 'the labels stand in order');
      for (const [index, from] of at.entries()) {
        const text = section.slice(from + 1, index === 0 ? at[1] : undefined).filter((line) => line.trim() !== '');
        assert.equal(text.length, 1, LABELS[index]);
        assert.ok(text[0].startsWith('- '), text[0]);
        assert.doesNotMatch(text[0], PLACEHOLDER_RE);
      }
    });

    it(`the changelog entry carries the For the user field line after Goal and no such heading: ${label}`, () => {
      const lines = read(root, 'changelog.md').split(LF);
      const field = lines.findIndex((line) => line.startsWith('**For the user:** '));
      assert.equal(lines.filter((line) => line.startsWith('**For the user:**')).length, 1);
      assert.ok(lines.findIndex((line) => line.startsWith('**Goal:**')) < field);
      assert.ok(field < lines.findIndex((line) => line.startsWith('**Changes:**')));
      assert.ok(!lines.some((line) => /^#+ .*For the user/.test(line)));
    });
  }

  it('the kit mirrors of both templates are byte-identical to the memory originals', () => {
    for (const name of ['handover.md', 'changelog.md']) {
      assert.ok(readFileSync(join(KIT_TEMPLATES, name)).equals(readFileSync(join(MEMORY_TEMPLATES, name))), name);
    }
  });
});

describe('handover.md "Active recipes:" slot — kit and memory template lines are byte-identical', () => {
  const kitFile = read(KIT_TEMPLATES, 'handover.md');
  const memoryFile = read(MEMORY_TEMPLATES, 'handover.md');
  const kit = extractActiveRecipesLine(kitFile);
  const memory = extractActiveRecipesLine(memoryFile);

  it('the two slot lines match byte-for-byte', () => {
    assert.equal(kit, memory, 'kit and memory handover.md "Active recipes:" slot lines have drifted — edit both in the same change');
  });

  it('the slot points at the config and demands a refresh-on-change (path-neutral)', () => {
    assert.match(kit, /orchestration\.json/);
    assert.match(kit, /refresh/);
    assert.ok(!kit.includes('agent-workflow-kit'), 'the template slot line never names the kit');
  });

  it('non-vacuous: an injected divergence is caught by the same extractor + comparator', () => {
    const mutated = kitFile.replace('**Active recipes:**', '**Active recipes:** DRIFTED —');
    assert.notEqual(extractActiveRecipesLine(mutated), memory, 'the guard detects a slot-line divergence');
  });
});
