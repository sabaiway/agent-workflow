import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EPIC_KEYS, EPIC_TEMPLATE_TEXT, EPIC_VALUES, LF, MODULE, MODULE_ROW, PLAN, QUEUE, TASK_KEYS,
  TASK_TEMPLATE_TEXT, TASK_VALUES, TEST, addResultLine, createGround, findSpans, landStory, listFiles, prepareSubstrate,
  probeEnvironment, removeSection, renderLines, renderPlan, renderTemplate, snapshotTree, writeFixture } from './tier-walk-harness.test.mjs';

const KIT_SOURCE = fileURLToPath(new URL('../', import.meta.url));
const CR = String.fromCharCode(13);
const BACKTICK = String.fromCharCode(96);
const EPIC = 'docs/ai/epics/WALK-EPIC.md';
const BRIEF = 'docs/plans/TASK-greet-T1.md';
const RULES = 'docs/ai/agent_rules.md';
const COPIES = 'template-copies';
const STORY_ROW = '- S1 | Greet the reader | depends-on: none | owns: src/greet.mjs | shared: none | state: planned';
const ACCEPTANCE = `- node --test ${TEST} :: exits 0`;
const AUTHORED = [EPIC, PLAN, BRIEF];
const STATES = ['bare', 'seeded'];
const TEMPLATES = [
  { name: 'EPIC_TEMPLATE.md', text: EPIC_TEMPLATE_TEXT, keys: EPIC_KEYS },
  { name: 'TASK_TEMPLATE.md', text: TASK_TEMPLATE_TEXT, keys: TASK_KEYS },
];
const GUIDED_STAGES = ['E1', 'S1', 'S2', 'S3', 'S4', 'S6', 'S7', 'S8', 'E4', 'E5'];
const GUIDED_STEPS = ['epic-check', 'epic-review', 'plan-check', 'mint', 'stamp', 'check', 'acceptance', 'review',
  'stage-files', 'commit-files', 'plan-verify', 'prune', 'close'];
const DIGEST = new RegExp('^task-brief digest sha256:[a-f0-9]{64}' + LF + '$');
const CHECKPOINT = new RegExp('^checkpoint greet/0 [a-f0-9]{40,64}' + LF + '$');
const EXPECTED = [
  ['epic-check', 0, 'stdout', /accept --check/],
  ['epic-review', 0, 'stdout', /^# Epic review: WALK-EPIC [(]open[)]/],
  ['plan-check', 0, 'stdout', /plan-shape: ACCEPT — docs[/]plans[/]greet[.]md/],
  ['mint', 0, 'stdout', CHECKPOINT],
  ['first-guess', 1, 'stderr', /^shape:/],
  ['stamp', 0, 'stdout', DIGEST],
  ['check', 0, 'stdout', DIGEST],
  ['acceptance', 0],
  ['review', 0, 'stdout', /PASS.*solo.*no receipt/],
  ['stage-files', 0],
  ['commit-files', 0],
  ['plan-verify', 0, 'stdout', /plan-shape: ACCEPT/],
  ['prune', 0],
  ['newest', 1, 'stderr', /^no-checkpoint/],
  ['close-before-landing', 1],
  ['close', 0, 'stdout', /accept --close/],
  ['close-again', 1, 'stderr', /close-state/],
];
const fixtures = {};
const grounds = [];
const stageOf = ({ envelope }) => {
  const [entry] = envelope.entries;
  return entry.stories.length ? entry.stories[0] : entry;
};
const runWalk = (state) => {
  const ground = createGround(grounds);
  const { project, kit, bin, env, run, tool, shell, guide } = ground;
  probeEnvironment(ground);
  run('install', join(bin, 'node'), [join(KIT_SOURCE, 'bin/install.mjs'), '--dir', kit,
    '--no-launchers', '--no-engine', '--no-memory', '--no-bridges']);
  const kitBefore = snapshotTree(kit);
  const installed = Object.fromEntries(TEMPLATES.map(({ name }) =>
    [name, readFileSync(join(kit, 'references/authoring', name))]));
  const rendered = { epic: renderTemplate(installed['EPIC_TEMPLATE.md'].toString('utf8'), EPIC_VALUES),
    brief: renderTemplate(installed['TASK_TEMPLATE.md'].toString('utf8'), TASK_VALUES) };
  prepareSubstrate(ground, state);
  const beforeAuthoring = snapshotTree(project);
  const walkStart = ground.records.length;
  const guided = [];
  const solo = {};
  const author = {
    epic: () => writeFixture(join(project, EPIC), rendered.epic),
    plan: () => writeFixture(join(project, PLAN), renderPlan()),
    brief: () => {
      writeFixture(join(project, BRIEF), removeSection(rendered.brief, '## Negative cases'));
      tool('first-guess', 'task-brief.mjs', ['stamp', BRIEF]);
      writeFixture(join(project, BRIEF), rendered.brief);
    },
    files: () => {
      solo.beforeSolo = snapshotTree(project);
      solo.authored = Object.fromEntries(AUTHORED.map((path) => [path, readFileSync(join(project, path), 'utf8')]));
      writeFixture(join(project, MODULE), renderLines(["export const greet = (name) => 'Hello, ' + name;"]));
      writeFixture(join(project, TEST), renderLines([
        "import assert from 'node:assert/strict';", "import { greet } from './greet.mjs';",
        "assert.equal(greet('reader'), 'Hello, reader');",
      ]));
    },
    landing: () => writeFixture(join(project, EPIC), landStory(readFileSync(join(project, EPIC), 'utf8'))),
    result: () => writeFixture(join(project, EPIC), addResultLine(readFileSync(join(project, EPIC), 'utf8'))),
  };
  const walkStage = (stage, steps, fact) => {
    const read = guide(stage);
    const current = stageOf(read);
    if (current.stage !== stage) throw new Error(`the guide stands at ${current.stage}, the walk expects ${stage}`);
    const taken = [];
    const shellLine = (label, item, kinds) => {
      if (!kinds.includes(item?.kind) || item.command === null) throw new Error(`${stage}: ${label} is not a printed ${kinds} line`);
      taken.push({ label, command: item.command });
      shell(label, item.command);
    };
    if (fact) shellLine(fact, read.envelope.entries[0].fact, ['fact']);
    steps.forEach((step, index) => {
      const item = current.actions[index];
      if (typeof step === 'string') shellLine(step, item, ['run']);
      else if (item?.kind !== 'write') throw new Error(`${stage}: action ${index + 1} is not a write`);
      else step();
    });
    guided.push({ stage, lines: read.lines, taken });
  };
  walkStage('E1', [author.epic]);
  walkStage('S1', ['epic-review', author.plan], 'epic-check');
  walkStage('S2', ['plan-check', 'mint']);
  walkStage('S3', [author.brief]);
  walkStage('S4', ['stamp']);
  walkStage('S6', ['check', author.files, 'acceptance', 'review', 'stage-files', 'commit-files']);
  walkStage('S7', ['plan-verify', 'prune']);
  tool('newest', 'checkpoint.mjs', ['newest', '--plan', PLAN]);
  tool('close-before-landing', 'epic-shape-cli.mjs', ['--close', EPIC]);
  walkStage('S8', [author.landing]);
  walkStage('E4', [author.result, 'close']);
  const closedEpic = readFileSync(join(project, EPIC), 'utf8');
  tool('close-again', 'epic-shape-cli.mjs', ['--close', EPIC]);
  walkStage('E5', []);
  const reconcile = tool('reconcile', 'lens-region.mjs', ['reconcile', RULES]);
  const lines = reconcile.stdout.split(LF);
  const storyIndex = lines.findIndex((line) => line.includes('no "### 2.x. Story sessions"'));
  const offer = storyIndex < 0 ? '' : lines[storyIndex + 1] ?? '';
  const preview = offer.split(BACKTICK)[1] ?? '';
  run('offer-preview', '/bin/sh', ['-c', preview]);
  for (const { name } of TEMPLATES) writeFixture(join(project, COPIES, name), installed[name]);
  const copyChecks = Object.fromEntries([['epic-template-check', 'epic-shape-cli.mjs', '--check', `${COPIES}/EPIC_TEMPLATE.md`],
    ['task-template-stamp', 'task-brief.mjs', 'stamp', `${COPIES}/TASK_TEMPLATE.md`]].map(([label, name, ...args]) =>
    [label, spawnSync(join(bin, 'node'), [join(kit, 'tools', name), ...args], { cwd: project, env, encoding: 'utf8' })]));
  return { ...ground, state, kitBefore, kitAfter: snapshotTree(kit), beforeAuthoring, ...solo, guided, copyChecks,
    installed, rendered, closedEpic, offer, preview, walk: ground.records.slice(walkStart) };
};
const getStep = (fixture, label) => fixture.records.find((record) => record.label === label);
const assertCode = (record, code) => assert.equal(record.code, code, `${record.label}: ${record.stderr || record.stdout}`);
const normalizeOutput = (text, root) => text.replaceAll(root, 'GROUND').replace(/[a-f0-9]{40,64}/g, 'OID')
  .replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}/g, 'DAY');
const isGuideRecord = ({ label }) => label.startsWith('guide-');

before(() => {
  for (const state of STATES) fixtures[state] = runWalk(state);
});
after(() => {
  for (const root of grounds) rmSync(root, { recursive: true, force: true });
});

describe('spec:tier-walk/S1 isolated ground', () => {
  for (const state of STATES) it(state, () => {
    const fixture = fixtures[state];
    assertCode(getStep(fixture, 'install'), 0);
    assertCode(getStep(fixture, 'environment'), 0);
    assert.deepEqual(JSON.parse(getStep(fixture, 'environment').stdout), fixture.env);
    assert.notEqual(getStep(fixture, 'find-codex').code, 0);
    for (const name of ['node', 'git']) assertCode(getStep(fixture, `find-${name}`), 0);
    for (const label of ['init', 'email', 'name', 'stage-substrate', 'commit-substrate']) assertCode(getStep(fixture, label), 0);
  });
});
describe('spec:tier-walk/S2 bare walk named answers', () => {
  it('keeps the required step order', () => {
    assert.deepEqual(fixtures.bare.walk.filter((record) => !isGuideRecord(record)).slice(0, EXPECTED.length).map(({ label }) => label),
      EXPECTED.map(([label]) => label));
  });
  for (const [label, code, channel, pattern] of EXPECTED) it(label, () => {
    const record = getStep(fixtures.bare, label);
    assertCode(record, code);
    if (pattern) assert.match(record[channel], pattern);
  });
  it('keeps the digest equal and lands the epic header', () => {
    assert.equal(getStep(fixtures.bare, 'stamp').stdout, getStep(fixtures.bare, 'check').stdout);
    assert.ok(fixtures.bare.closedEpic.split(LF).includes('state: landed'));
  });
});
describe('spec:tier-walk/S3 seeded walk matches bare', () => {
  it('compares every label and exit code', () => {
    const select = (fixture) => fixture.records.map(({ label, code }) => ({ label, code }));
    assert.deepEqual(select(fixtures.seeded), select(fixtures.bare));
  });
  it('compares only installed tool output after root and object normalization', () => {
    const select = (fixture) => fixture.walk.filter(({ label }) => fixture.toolLabels.has(label))
      .map(({ label, stdout, stderr }) => ({ label,
        stdout: normalizeOutput(stdout, fixture.root), stderr: normalizeOutput(stderr, fixture.root) }));
    assert.deepEqual(select(fixtures.seeded), select(fixtures.bare));
  });
});
describe('spec:tier-walk/S4 three authored work-tree files', () => {
  for (const state of STATES) it(state, () => {
    const { beforeAuthoring, beforeSolo, authored, rendered } = fixtures[state];
    const original = listFiles(beforeAuthoring);
    const current = listFiles(beforeSolo);
    assert.deepEqual(current.filter((path) => !original.includes(path)), [...AUTHORED].sort());
    assert.deepEqual(original.filter((path) => !current.includes(path)), []);
    for (const path of original) assert.deepEqual(beforeSolo[path], beforeAuthoring[path], path);
    assert.equal(authored[EPIC], rendered.epic);
    assert.equal(authored[PLAN], renderPlan());
    assert.ok(authored[BRIEF].startsWith(rendered.brief));
    assert.ok(authored[EPIC].includes(STORY_ROW));
    assert.ok(authored[PLAN].includes(MODULE_ROW));
    assert.ok(authored[BRIEF].includes(ACCEPTANCE));
  });
});
describe('spec:tier-walk/S5 pre-landing close names only unmet conditions', () => {
  for (const state of STATES) it(state, () => {
    const record = getStep(fixtures[state], 'close-before-landing');
    assertCode(record, 1);
    assert.match(record.stderr, /close-stories/);
    assert.match(record.stderr, /close-result/);
    if (state === 'bare') assert.doesNotMatch(record.stderr, /queue-read|close-queue/);
  });
});
describe('spec:tier-walk/S6 first guess names the absent section', () => {
  for (const state of STATES) it(state, () => {
    const record = getStep(fixtures[state], 'first-guess');
    assertCode(record, 1);
    assert.equal(record.stdout, '');
    assert.equal(record.stderr.split(LF).length, 2);
    assert.ok(record.stderr.endsWith(LF));
    assert.ok(!record.stderr.includes(CR));
    assert.ok(record.stderr.startsWith('shape: '));
    assert.ok(record.stderr.includes('## Negative cases'));
    assert.ok(record.stderr.includes('absent'));
  });
});
describe('spec:tier-walk/S7 preserves the home and optional state', () => {
  for (const state of STATES) it(state, () => {
    const fixture = fixtures[state];
    assert.deepEqual(fixture.kitAfter, fixture.kitBefore);
    for (const path of ['.git/agent-workflow-review-receipts.jsonl', '.git/agent-workflow-delegation.jsonl', '.claude/agents']) {
      assert.equal(lstatSync(join(fixture.project, path), { throwIfNoEntry: false }), undefined, path);
    }
    if (state === 'bare') assert.equal(lstatSync(join(fixture.project, QUEUE), { throwIfNoEntry: false }), undefined);
    else assert.deepEqual(readFileSync(join(fixture.project, QUEUE)), fixture.beforeAuthoring[QUEUE].bytes);
  });
});
describe('spec:tier-walk/S8 story offer survives the lens stop and runs', () => {
  for (const state of STATES) {
    it(`${state}: offer`, () => {
      const fixture = fixtures[state];
      const reconcile = getStep(fixture, 'reconcile');
      assertCode(reconcile, 1);
      assert.match(reconcile.stderr, /STOP/);
      assert.match(reconcile.stdout, /Communication section already current/);
      assert.ok(fixture.offer.includes('note:'));
      assert.ok(fixture.preview.length > 0);
      assertCode(getStep(fixture, 'offer-preview'), 0);
      assert.match(getStep(fixture, 'offer-preview').stdout, /story-sessions: planned/);
    });
    it(`${state}: no unresolved placeholders`, () => {
      for (const record of fixtures[state].records) {
        assert.doesNotMatch(record.stdout + record.stderr, /<kit>|<project>/, record.label);
      }
    });
  }
});
describe('spec:tier-templates/S2 installed templates equal the pinned texts', () => {
  for (const { name, text, keys } of TEMPLATES) it(name, () => {
    for (const state of STATES) assert.deepEqual(fixtures[state].installed[name], Buffer.from(text), `${state}: ${name}`);
    assert.deepEqual([...new Set(findSpans(text))].sort(), [...keys].sort());
  });
});
describe('spec:tier-templates/S3 rendered epic accepted with no span left', () => {
  for (const state of STATES) it(state, () => {
    const fixture = fixtures[state];
    assert.equal(fixture.authored[EPIC], fixture.rendered.epic);
    assertCode(getStep(fixture, 'epic-check'), 0);
    assert.deepEqual(findSpans(fixture.rendered.epic), []);
  });
});
describe('spec:tier-templates/S4 rendered brief stamped and checked with no span left', () => {
  for (const state of STATES) it(state, () => {
    const fixture = fixtures[state];
    assert.ok(fixture.authored[BRIEF].startsWith(fixture.rendered.brief));
    for (const label of ['stamp', 'check']) assert.match(getStep(fixture, label).stdout, DIGEST, label);
    assert.equal(getStep(fixture, 'stamp').stdout, getStep(fixture, 'check').stdout);
    assert.deepEqual(findSpans(fixture.rendered.brief), []);
  });
});
describe('spec:tier-templates/S5 unedited template copies refuse', () => {
  for (const state of STATES) it(state, () => {
    const fixture = fixtures[state];
    for (const { name } of TEMPLATES) {
      assert.deepEqual(readFileSync(join(fixture.project, COPIES, name)), fixture.installed[name], name);
    }
    for (const [label, result] of Object.entries(fixture.copyChecks)) {
      assert.equal(result.status, 1, label);
      assert.notEqual(result.stderr.trim(), '', label);
    }
    assert.doesNotMatch(fixture.copyChecks['task-template-stamp'].stderr, /^(?:reads|no-checkpoint):/m);
  });
});
describe('spec:tier-guide/S6 the walk is driven by the guide', () => {
  for (const state of STATES) it(`${state}: every tool step but the refusal cells is a printed guide line`, () => {
    const { guided } = fixtures[state];
    assert.deepEqual(guided.map(({ stage }) => stage), GUIDED_STAGES);
    assert.deepEqual(guided.flatMap(({ taken }) => taken.map(({ label }) => label)), GUIDED_STEPS);
    for (const { stage, lines, taken } of guided) {
      for (const { label, command } of taken) assert.ok(lines.includes(command), `${stage} ${label}: ${command}`);
    }
    for (const label of GUIDED_STEPS) assertCode(getStep(fixtures[state], label), 0);
  });
  it('both states see the same guide lines, E1 one cause and one mkdir line', () => {
    const select = (fixture) => fixture.guided.map(({ lines }) => normalizeOutput(lines.join(LF), fixture.root));
    assert.deepEqual(select(fixtures.seeded), select(fixtures.bare));
    for (const state of STATES) {
      const [first] = fixtures[state].guided;
      assert.ok(first.lines.includes('  no epic file in docs/ai/epics'), state);
      assert.ok(first.lines.includes('mkdir -p docs/ai/epics'), state);
    }
  });
});
