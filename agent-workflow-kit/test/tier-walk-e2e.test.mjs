import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATE, EPIC_KEYS, EPIC_TEMPLATE_TEXT, EPIC_VALUES, LF, MODULE, PLAN, QUEUE, TASK_KEYS,
  TASK_TEMPLATE_TEXT, TASK_VALUES, TEST, createGround, findSpans, listFiles, prepareSubstrate,
  probeEnvironment, renderLines, renderTemplate, snapshotTree, writeFixture } from './tier-walk-harness.test.mjs';

const KIT_SOURCE = fileURLToPath(new URL('../', import.meta.url));
const CR = String.fromCharCode(13);
const BACKTICK = String.fromCharCode(96);
const EPIC = 'docs/ai/epics/WALK-EPIC.md';
const BRIEF = 'docs/plans/TASK-greet-T1.md';
const RULES = 'docs/ai/agent_rules.md';
const COPIES = 'template-copies';
const STORY = 'Story: S1 of WALK-EPIC';
const STORY_ROW = '- S1 | Greet the reader | depends-on: none | owns: src/greet.mjs | shared: none | state: planned';
const MODULE_ROW = 'M1 | modify | src/greet.mjs | Greet the reader by name | n/a | src/greet.mjs:1';
const ACCEPTANCE = `- node --test ${TEST} :: exits 0`;
const AUTHORED = [EPIC, PLAN, BRIEF];
const STATES = ['bare', 'seeded'];
const TEMPLATES = [
  { name: 'EPIC_TEMPLATE.md', text: EPIC_TEMPLATE_TEXT, keys: EPIC_KEYS },
  { name: 'TASK_TEMPLATE.md', text: TASK_TEMPLATE_TEXT, keys: TASK_KEYS },
];
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
const renderPlan = () => renderLines([
  '# Plan: Greet the reader', '', '## Goal and boundary', STORY,
  'Outcome: greet the reader by name. Governing spec: not adopted. Non-goals: unrelated files.', '',
  '## Module ledger', MODULE_ROW, 'total: 0 → 0 lines', '', '## Verification',
  `- node --check ${MODULE} exits 0.`, '', '## Phase: Cleanup',
  '- Preserve the results and remove the temporary plan.', '', '## Next steps', '- None.',
]);
const removeSection = (text, heading) => {
  const lines = text.split(LF);
  const start = lines.indexOf(heading);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  if (start < 0 || end < 0) throw new Error(`${heading} is not a closed section`);
  return [...lines.slice(0, start), ...lines.slice(end)].join(LF);
};
const runWalk = (state) => {
  const ground = createGround();
  grounds.push(ground.root);
  const { project, kit, bin, run, tool, git } = ground;
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
  for (const [path, text] of [[EPIC, rendered.epic], [PLAN, renderPlan()], [BRIEF, rendered.brief]]) {
    writeFixture(join(project, path), text);
  }
  const walkStart = ground.records.length;
  tool('epic-check', 'epic-shape-cli.mjs', ['--check', EPIC]);
  tool('epic-review', 'epic-shape-cli.mjs', ['--review-brief', EPIC]);
  tool('plan-check', 'plan-shape-cli.mjs', ['--check', PLAN]);
  tool('mint', 'checkpoint.mjs', ['mint', '--plan', PLAN]);
  writeFixture(join(project, BRIEF), removeSection(rendered.brief, '## Negative cases'));
  tool('first-guess', 'task-brief.mjs', ['stamp', BRIEF]);
  writeFixture(join(project, BRIEF), rendered.brief);
  tool('stamp', 'task-brief.mjs', ['stamp', BRIEF]);
  tool('check', 'task-brief.mjs', ['check', BRIEF]);
  const beforeSolo = snapshotTree(project);
  const authored = Object.fromEntries(AUTHORED.map((path) => [path, readFileSync(join(project, path), 'utf8')]));
  writeFixture(join(project, MODULE), renderLines(["export const greet = (name) => 'Hello, ' + name;"]));
  writeFixture(join(project, TEST), renderLines([
    "import assert from 'node:assert/strict';", "import { greet } from './greet.mjs';",
    "assert.equal(greet('reader'), 'Hello, reader');",
  ]));
  const command = authored[BRIEF].split(LF).find((line) => line === ACCEPTANCE).slice(2).split(' :: ')[0];
  run('acceptance', '/bin/sh', ['-c', command]);
  tool('review', 'review-state.mjs', ['--check']);
  git('stage-files', ['add', TEST, MODULE]);
  git('commit-files', ['commit', '-q', '-m', 'Greet the reader by name']);
  tool('plan-verify', 'plan-shape-cli.mjs', ['--verify', PLAN]);
  tool('prune', 'checkpoint.mjs', ['prune', '--plan', PLAN]);
  tool('newest', 'checkpoint.mjs', ['newest', '--plan', PLAN]);
  tool('close-before-landing', 'epic-shape-cli.mjs', ['--close', EPIC]);
  const landed = readFileSync(join(project, EPIC), 'utf8').replace('state: planned', `state: landed ${DATE}`)
    .replace('## Acceptance' + LF, '## Acceptance' + LF + `Result line: ${DATE}` + LF);
  writeFixture(join(project, EPIC), landed);
  tool('close', 'epic-shape-cli.mjs', ['--close', EPIC]);
  const closedEpic = readFileSync(join(project, EPIC), 'utf8');
  tool('close-again', 'epic-shape-cli.mjs', ['--close', EPIC]);
  const reconcile = tool('reconcile', 'lens-region.mjs', ['reconcile', RULES]);
  const lines = reconcile.stdout.split(LF);
  const storyIndex = lines.findIndex((line) => line.includes('no "### 2.x. Story sessions"'));
  const offer = storyIndex < 0 ? '' : lines[storyIndex + 1] ?? '';
  const preview = offer.split(BACKTICK)[1] ?? '';
  run('offer-preview', '/bin/sh', ['-c', preview]);
  for (const { name } of TEMPLATES) writeFixture(join(project, COPIES, name), installed[name]);
  tool('epic-template-check', 'epic-shape-cli.mjs', ['--check', `${COPIES}/EPIC_TEMPLATE.md`]);
  tool('task-template-stamp', 'task-brief.mjs', ['stamp', `${COPIES}/TASK_TEMPLATE.md`]);
  return { ...ground, state, kitBefore, kitAfter: snapshotTree(kit), beforeAuthoring, beforeSolo,
    installed, rendered, authored, closedEpic, offer, preview, walk: ground.records.slice(walkStart) };
};
const getStep = (fixture, label) => fixture.records.find((record) => record.label === label);
const assertCode = (record, code) => assert.equal(record.code, code, `${record.label}: ${record.stderr || record.stdout}`);
const normalizeOutput = (text, root) => text.replaceAll(root, 'GROUND').replace(/[a-f0-9]{40,64}/g, 'OID');

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
    assert.deepEqual(fixtures.bare.walk.slice(0, EXPECTED.length).map(({ label }) => label),
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
    assert.equal(fixture.rendered.epic, renderTemplate(fixture.installed['EPIC_TEMPLATE.md'].toString('utf8'), EPIC_VALUES));
    assert.equal(fixture.authored[EPIC], fixture.rendered.epic);
    assertCode(getStep(fixture, 'epic-check'), 0);
    assert.deepEqual(findSpans(fixture.rendered.epic), []);
  });
});
describe('spec:tier-templates/S4 rendered brief stamped and checked with no span left', () => {
  for (const state of STATES) it(state, () => {
    const fixture = fixtures[state];
    assert.equal(fixture.rendered.brief, renderTemplate(fixture.installed['TASK_TEMPLATE.md'].toString('utf8'), TASK_VALUES));
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
    for (const label of ['epic-template-check', 'task-template-stamp']) {
      const record = getStep(fixture, label);
      assertCode(record, 1);
      assert.notEqual(record.stderr.trim(), '', label);
    }
    assert.doesNotMatch(getStep(fixture, 'task-template-stamp').stderr, /^(?:reads|no-checkpoint):/m);
  });
});
