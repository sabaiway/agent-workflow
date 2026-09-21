import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_SOURCE = fileURLToPath(new URL('../', import.meta.url));
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const BACKTICK = String.fromCharCode(96);
const DATE = '2026-09-21';
const EPIC = 'docs/ai/epics/WALK-EPIC.md';
const PLAN = 'docs/plans/greet.md';
const BRIEF = 'docs/plans/TASK-greet-T1.md';
const MODULE = 'src/greet.mjs';
const TEST = 'src/greet.test.mjs';
const RULES = 'docs/ai/agent_rules.md';
const CONFIG = 'docs/ai/orchestration.json';
const QUEUE = 'docs/plans/queue.md';
const STORY = 'Story: S1 of WALK-EPIC';
const STORY_ROW = '- S1 | Greet the reader | depends-on: none | owns: src/greet.mjs | shared: none | state: planned';
const MODULE_ROW = 'M1 | modify | src/greet.mjs | Greet the reader by name | n/a | src/greet.mjs:1';
const ACCEPTANCE = `- node --test ${TEST} :: exits 0`;
const AUTHORED = [EPIC, PLAN, BRIEF];
const STATES = ['bare', 'seeded'];
const QUEUE_TEXT = ['# Queue', '', '## Now', ''].join(LF);
const NEGATIVE = ['## Negative cases', '- empty name :: remains a string'];
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
const renderLines = (lines) => lines.join(LF) + LF;
const writeFixture = (path, bytes) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
};
const snapshotTree = (root, relative = '') => Object.fromEntries(
  readdirSync(join(root, relative)).sort().filter((name) => relative || name !== '.git').flatMap((name) => {
    const path = join(relative, name);
    const absolute = join(root, path);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return [[path, { kind: 'link', target: readlinkSync(absolute) }]];
    if (stat.isFile()) return [[path, { kind: 'file', bytes: readFileSync(absolute) }]];
    if (stat.isDirectory()) return [[path, { kind: 'directory' }], ...Object.entries(snapshotTree(root, path))];
    throw new Error(`Unexpected fixture entry: ${absolute}`);
  }),
);
const listFiles = (tree) => Object.keys(tree).filter((path) => tree[path].kind === 'file').sort();
const removeStorySpan = (text) => {
  const lines = text.split(LF);
  const start = lines.findIndex((line) => /^### 2[.][0-9]+[.] Story sessions/.test(line));
  if (start < 0) throw new Error('Story sessions template heading is absent');
  const end = lines.findIndex((line, index) => index > start && /^(---$|## |### )/.test(line));
  return [...lines.slice(0, start), ...lines.slice(end < 0 ? lines.length : end)].join(LF);
};
const renderEpic = () => renderLines([
  '---', 'type: epic', `lastUpdated: ${DATE}`, 'scope: permanent', 'staleAfter: 90d',
  'owner: none', 'maxLines: 60', 'state: open', '---', '', '# Epic: Greet the reader', '',
  '## Intent', 'Greet the reader by name.', '', '## Value', 'The reader receives a personal greeting.', '',
  '## Non-goals', 'No other messages.', '', '## Acceptance', 'The reader receives the greeting.', '',
  '## Specs', 'none', '', '## Stories ledger', STORY_ROW, '', '## Queue', 'Row WALK-EPIC in Now',
]);
const renderPlan = () => renderLines([
  '# Plan: Greet the reader', '', '## Goal and boundary', STORY,
  'Outcome: greet the reader by name. Governing spec: not adopted. Non-goals: unrelated files.', '',
  '## Module ledger', MODULE_ROW, 'total: 0 → 0 lines', '', '## Verification',
  `- node --check ${MODULE} exits 0.`, '', '## Phase: Cleanup',
  '- Preserve the results and remove the temporary plan.', '', '## Next steps', '- None.',
]);
const renderBrief = (firstGuess = false) => renderLines([
  '# Task: Greet the reader', STORY, '', '## Slice', `Plan: ${PLAN}`, 'Row: M1',
  'Grouping: test, impl', 'Files:', `- ${TEST} :: test`, `- ${MODULE} :: impl`, '',
  '## Reads', `- ${PLAN}`, '', '## Acceptance', ACCEPTANCE, '',
  ...(firstGuess ? [] : [...NEGATIVE, '']), '## Budget', `- ${TEST} :: 100`, `- ${MODULE} :: 100`,
]);
const createGround = () => {
  const root = mkdtempSync(join(tmpdir(), 'tier-walk-'));
  grounds.push(root);
  const [home, project, bin, temporary] = ['home', 'project', 'bin', 'tmp'].map((name) => join(root, name));
  for (const path of [home, project, bin, temporary]) mkdirSync(path);
  const gitPath = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  symlinkSync(process.execPath, join(bin, 'node'));
  symlinkSync(gitPath, join(bin, 'git'));
  const kit = join(home, '.claude/skills/agent-workflow-kit');
  const env = { HOME: home, PATH: bin, TMPDIR: temporary };
  const records = [];
  const toolLabels = new Set();
  const run = (label, command, args, cwd = project) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
    const record = { label, code: result.status, stdout: result.stdout ?? '',
      stderr: (result.stderr ?? '') + (result.error ? result.error.message : '') };
    records.push(record);
    return record;
  };
  const tool = (label, name, args) => {
    toolLabels.add(label);
    return run(label, join(bin, 'node'), [join(kit, 'tools', name), ...args]);
  };
  const git = (label, args) => run(label, join(bin, 'git'), args);
  return { root, home, project, bin, kit, env, records, toolLabels, run, tool, git };
};
const probeEnvironment = (ground) => {
  const fakeBin = join(ground.root, 'fake-bin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'codex'), renderLines(['#!/bin/sh', 'exit 0']), { mode: 0o755 });
  const pollution = { AGENT_WORKFLOW_ENGINE_DIR: fakeBin, CODEX_CLI_BRIDGE_DIR: fakeBin,
    TIER_WALK_UNRELATED: 'must not reach the child', PATH: fakeBin + ':' + (process.env.PATH ?? '') };
  const saved = Object.fromEntries(Object.keys(pollution).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, pollution);
    ground.run('environment', join(ground.bin, 'node'), ['-e', 'process.stdout.write(JSON.stringify(process.env))']);
    for (const name of ['codex', 'node', 'git']) ground.run(`find-${name}`, '/bin/sh', ['-c', `command -v ${name}`]);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};
const prepareSubstrate = (ground, state) => {
  const { project, kit, git } = ground;
  git('init', ['init', '-q', '-b', 'main']);
  git('email', ['config', 'user.email', 'coder-tools@proton.me']);
  git('name', ['config', 'user.name', 'coder-tool']);
  writeFixture(join(project, MODULE), renderLines(["export const greet = () => 'Hello';"]));
  writeFixture(join(project, 'package.json'), renderLines(['{"name":"walk-project","private":true,"type":"module"}']));
  for (const name of ['orchestration.json', 'gates.json', 'agent_rules.md']) {
    const bytes = readFileSync(join(kit, 'references/templates', name));
    writeFixture(join(project, 'docs/ai', name), name === 'agent_rules.md' ? removeStorySpan(bytes.toString('utf8')) : bytes);
  }
  if (state === 'seeded') {
    const config = readFileSync(join(project, CONFIG), 'utf8');
    const seed = ', "epic": { "author": "solo", "review": "solo" }, "task": { "author": "solo", "execute": "solo" }';
    const closing = config.lastIndexOf('}');
    writeFixture(join(project, CONFIG), config.slice(0, closing) + seed + config.slice(closing));
    mkdirSync(join(project, 'docs/ai/epics'));
    writeFixture(join(project, QUEUE), QUEUE_TEXT);
  }
  git('stage-substrate', ['add', '-A']);
  git('commit-substrate', ['commit', '-q', '-m', 'Create greeting substrate']);
};
const runWalk = (state) => {
  const ground = createGround();
  const { project, kit, bin, run, tool, git } = ground;
  probeEnvironment(ground);
  run('install', join(bin, 'node'), [join(KIT_SOURCE, 'bin/install.mjs'), '--dir', kit,
    '--no-launchers', '--no-engine', '--no-memory', '--no-bridges']);
  const kitBefore = snapshotTree(kit);
  prepareSubstrate(ground, state);
  const beforeAuthoring = snapshotTree(project);
  for (const [path, text] of [[EPIC, renderEpic()], [PLAN, renderPlan()], [BRIEF, renderBrief()]]) {
    writeFixture(join(project, path), text);
  }
  const walkStart = ground.records.length;
  tool('epic-check', 'epic-shape-cli.mjs', ['--check', EPIC]);
  tool('epic-review', 'epic-shape-cli.mjs', ['--review-brief', EPIC]);
  tool('plan-check', 'plan-shape-cli.mjs', ['--check', PLAN]);
  tool('mint', 'checkpoint.mjs', ['mint', '--plan', PLAN]);
  writeFixture(join(project, BRIEF), renderBrief(true));
  tool('first-guess', 'task-brief.mjs', ['stamp', BRIEF]);
  writeFixture(join(project, BRIEF), renderBrief());
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
  return { ...ground, state, kitBefore, kitAfter: snapshotTree(kit), beforeAuthoring, beforeSolo,
    authored, closedEpic, offer, preview, walk: ground.records.slice(walkStart) };
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
    const { beforeAuthoring, beforeSolo, authored } = fixtures[state];
    const original = listFiles(beforeAuthoring);
    const current = listFiles(beforeSolo);
    assert.deepEqual(current.filter((path) => !original.includes(path)), [...AUTHORED].sort());
    assert.deepEqual(original.filter((path) => !current.includes(path)), []);
    for (const path of original) assert.deepEqual(beforeSolo[path], beforeAuthoring[path], path);
    assert.equal(authored[EPIC], renderEpic());
    assert.equal(authored[PLAN], renderPlan());
    assert.ok(authored[BRIEF].startsWith(renderBrief().trimEnd() + LF));
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
