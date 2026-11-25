import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { makeFixtureRepo } from '../../../scripts/testing/fixture-repo.mjs';
import { ENGINE_ENV } from '../engine-source.mjs';
import { checkEpic, EPIC_SECTIONS } from '../epic-shape.mjs';
import { stripGitLocationEnv } from '../git-env.mjs';
import { PLANS_REL } from '../plan-files.mjs';
import { judgePlan, readPlanDocument } from '../plan-shape-facts.mjs';
import { makeTree, planWith, write, writeJson } from '../plan-shape-harness.test.mjs';
import { escapeForDisplay, isSeedablePathToken, shellQuoteArg } from '../repo-lex.mjs';
import { APPROVED_PLAN_BODY, recordApproval } from '../plan-approval/approved-plan-harness.test.mjs';

const CLI = join(import.meta.dirname, 'cli.mjs');
const KIT = resolve(import.meta.dirname, '../..');
const ENGINE = resolve(KIT, '../agent-workflow-engine');
const CHECK = join(KIT, 'tools/plan-approval/cli.mjs');
const PLAN = `${PLANS_REL}/guide.md`;
const SLOT = `${PLANS_REL}/next-session.json`;
const EPIC = 'docs/ai/epics/GUIDE.md';
const STORY = 'S1';
const NOTES = `${PLANS_REL}/notes.md`;
const DATE = '2026-11-25';
const GATED = ['tests', 'code', 'diff-review', 'split-edits'];
const BODY = planWith({ goal: 'Spec: not adopted. Keep the guide current.\nStory: S1 of GUIDE' });
const EPIC_BODY = ['---', 'type: epic', `lastUpdated: ${DATE}`, 'scope: permanent', 'staleAfter: 90d', 'owner: none',
  'maxLines: 60', 'state: open', '---', '# Epic: Guide',
  ...EPIC_SECTIONS.flatMap((heading, index) => [heading, [
    'Keep the guide current.', 'Keep the boundary visible.', 'No publication.', 'The guide is current.', 'No store adopted.',
    '- S1 | Guide | depends-on: none | owns: docs/readme.md | shared: none | state: planned', 'Row GUIDE in Now',
  ][index]])].join('\n') + '\n';
const VALUES = { plan: PLAN, epic: EPIC, story: STORY, 'queue-row': 'GUIDE', file: NOTES, decisions: [{ path: NOTES, heading: 'Decisions' }] };
const cleanEnv = () => {
  const env = stripGitLocationEnv(process.env);
  delete env.NODE_TEST_CONTEXT;
  return { ...env, [ENGINE_ENV]: ENGINE };
};
const git = (argv, cwd) => {
  const result = spawnSync('git', argv, { cwd, env: cleanEnv(), encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
};
const makeRoot = (t) => {
  assert.deepEqual(checkEpic(EPIC_BODY, EPIC).findings, []);
  const root = makeTree('stage-render-cli');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'docs/readme.md', 'Guide.\n');
  write(root, PLAN, BODY);
  write(root, EPIC, EPIC_BODY);
  write(root, NOTES, '## Decisions\nKeep the scope.\n');
  return root;
};
const makeRepo = (t) => {
  const root = makeFixtureRepo((argv) => git(argv), makeRoot(t));
  assert.equal(judgePlan(root, readPlanDocument(root, PLAN)).accepted, true);
  return root;
};
const run = (root, argv) => {
  const result = spawnSync(process.execPath, [CLI, ...argv], { cwd: root, env: cleanEnv(), encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
};
const outputOf = (result) => result.stdout + result.stderr;
const expect = (result, status) => assert.equal(result.status, status, outputOf(result));
const table = () => JSON.parse(fs.readFileSync(new URL('./stages.json', import.meta.url), 'utf8')).stages;
const slotsFor = (stage, stages = table()) => Object.fromEntries(Object.entries(stages[stage].slots).map(([name, kind]) => [name, VALUES[kind]]));
const writeSlots = (root, stage) => writeJson(root, SLOT, { schema: 1, stage, date: DATE, ...slotsFor(stage) });
const recordPath = (root) => join(root, '.git', 'agent-workflow-plan-approvals.jsonl');
const breakEpic = (root) => {
  write(root, EPIC, EPIC_BODY.replace('## Stories ledger', '## Broken ledger'));
  assert.equal(fs.readFileSync(join(root, PLAN), 'utf8'), BODY);
  assert.equal(judgePlan(root, readPlanDocument(root, PLAN)).accepted, false);
};
const assertBeforeApproval = (result) => {
  expect(result, 1);
  assert.ok(outputOf(result).includes(PLAN), outputOf(result));
  assert.match(outputOf(result), /plan-approval\/cli\.mjs\s+record\b/);
};
const assertNoTemplate = (result, stage, fixedLines) => {
  for (const fragment of [table()[stage].goal, ...fixedLines]) assert.ok(!outputOf(result).includes(fragment), outputOf(result));
};
const invoke = async (main, root, argv) => {
  const output = { stdout: '', stderr: '' };
  const status = await main(argv, {
    cwd: root, env: cleanEnv(),
    stdout: (chunk) => { output.stdout += chunk; },
    stderr: (chunk) => { output.stderr += chunk; },
  });
  return { status, ...output };
};
const writerArgs = (stage) => [
  '--write', SLOT, '--stage', stage,
  ...Object.entries(slotsFor(stage)).flatMap(([name, value]) => (name === 'decisions'
    ? value.flatMap(({ path, heading }) => ['--decisions', `${path}#${heading}`])
    : [`--${name}`, value])),
];
const today = () => {
  const date = new Date();
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
};
const projectFiles = (root) => Object.fromEntries(fs.readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => relative(root, join(entry.parentPath, entry.name)))
  .filter((path) => !path.startsWith('.git/'))
  .sort()
  .map((path) => [path, fs.readFileSync(join(root, path), 'utf8')]));

describe('spec:stage-render/S2 record-gated rendering checks the live structure', () => {
  for (const stage of GATED) {
    it(stage, async (t) => {
      const root = makeRepo(t);
      const { FIXED_LINES } = await import('./index.mjs');
      writeSlots(root, stage);
      const before = run(root, [SLOT]);
      assertBeforeApproval(before);
      assert.match(outputOf(before), /waiting-on-approval/);
      assertNoTemplate(before, stage, FIXED_LINES);
      recordApproval(root, PLAN);
      const after = run(root, [SLOT]);
      expect(after, 0);
      for (const fragment of [table()[stage].goal, ...FIXED_LINES]) assert.ok(after.stdout.includes(fragment), after.stdout);
      const recorded = fs.readFileSync(recordPath(root));
      const slotBytes = fs.readFileSync(join(root, SLOT));
      breakEpic(root);
      const refused = run(root, [SLOT]);
      expect(refused, 1);
      assert.ok(outputOf(refused).includes(EPIC), outputOf(refused));
      assertNoTemplate(refused, stage, FIXED_LINES);
      assert.deepEqual(fs.readFileSync(recordPath(root)), recorded);
      assert.deepEqual(fs.readFileSync(join(root, SLOT)), slotBytes);
    });
  }
});

describe('spec:stage-render/S4 dispatch part checks the live structure', () => {
  it('prints exactly one approval block only for a matching record', (t) => {
    const root = makeRepo(t);
    const dispatch = () => run(root, ['--dispatch', PLAN]);
    const before = dispatch();
    assertBeforeApproval(before);
    assert.doesNotMatch(outputOf(before), /^```aw-plan-approval$/m);
    recordApproval(root, PLAN);
    const record = fs.readFileSync(recordPath(root), 'utf8');
    const { approval } = JSON.parse(record.trimEnd());
    const after = dispatch();
    expect(after, 0);
    const blocks = [...after.stdout.matchAll(/^```aw-plan-approval\n([\s\S]*?)\n```$/gm)];
    assert.equal(blocks.length, 1, after.stdout);
    assert.equal(after.stdout.match(/^```aw-plan-approval$/gm)?.length, 1);
    assert.match(approval, /^[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(blocks[0][1]), { plan: PLAN, approval, check: CHECK });
    assert.ok(fs.statSync(CHECK).isFile());
    breakEpic(root);
    const refused = dispatch();
    expect(refused, 1);
    assert.ok(outputOf(refused).includes(EPIC), outputOf(refused));
    assert.doesNotMatch(outputOf(refused), /^```aw-plan-approval$/m);
    assert.equal(fs.readFileSync(recordPath(root), 'utf8'), record);
  });
});

describe('spec:stage-render/S6 CLI IO seam', () => {
  it('cannot render from an unreadable or refused stage table, exit 2 naming it, and writes nothing', async (t) => {
    const { main } = await import('./cli.mjs');
    const root = makeRepo(t);
    writeSlots(root, 'pause');
    const refused = join(root, 'refused-stages.json');
    fs.writeFileSync(refused, '{}\n');
    for (const stagesPath of [join(root, 'absent-stages.json'), refused]) {
      for (const argv of [[SLOT], ['--write', `${PLANS_REL}/other.json`, '--stage', 'pause']]) {
        const output = { stdout: '', stderr: '' };
        const status = main(argv, {
          cwd: root, env: cleanEnv(), stagesPath,
          stdout: (chunk) => { output.stdout += chunk; }, stderr: (chunk) => { output.stderr += chunk; },
        });
        assert.equal(status, 2, output.stderr);
        assert.match(output.stderr, /stages\.json/);
        assert.ok(!fs.existsSync(join(root, PLANS_REL, 'other.json')));
      }
    }
  });
  it('uses the outcome table and returns usage without reads or process exit', async (t) => {
    const { main, OUTCOME_LINES } = await import('./cli.mjs');
    assert.ok(OUTCOME_LINES && Object.keys(OUTCOME_LINES).length > 0);
    const source = fs.readFileSync(CLI, 'utf8');
    assert.match(source, /\bescapeForDisplay\b/);
    assert.match(source, /\bisDirectRun\b/);
    assert.match(source, /\bOUTCOME_LINES\s*(?:\.|\[)/);
    assert.doesNotMatch(source, /\b(?:stdout|stderr)\s*\(\s*['"`][A-Za-z]/);
    const root = makeRoot(t);
    const calls = [];
    const forbid = (name) => () => { calls.push(name); throw new Error(name); };
    for (const name of ['readFileSync', 'openSync', 'readdirSync', 'lstatSync', 'statSync', 'existsSync']) t.mock.method(fs, name, forbid(name));
    for (const name of ['readFile', 'open', 'readdir', 'lstat', 'stat']) t.mock.method(fs.promises, name, forbid(name));
    t.mock.method(childProcess, 'spawnSync', forbid('spawnSync'));
    t.mock.method(process, 'exit', forbid('process.exit'));
    syncBuiltinESMExports();
    try {
      for (const argv of [[], ['--unknown'], [SLOT, SLOT], ['--dispatch'], ['--dispatch', PLAN, SLOT],
        ['--write', SLOT], ['--write', SLOT, '--stage'], ['--write', SLOT, '--stage', 'pause', '--unknown']]) {
        const result = await invoke(main, root, argv);
        expect(result, 2);
        assert.match(outputOf(result), /usage/i);
      }
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.deepEqual(calls, []);
  });
  it('escapes values in refused output without carrying their control bytes', async (t) => {
    const { main } = await import('./cli.mjs');
    const root = makeRoot(t);
    const operand = `${PLANS_REL}/line\nbreak.json`;
    const result = await invoke(main, root, [operand]);
    expect(result, 2);
    assert.ok(outputOf(result).includes(escapeForDisplay(operand)), outputOf(result));
    assert.doesNotMatch(outputOf(result).replaceAll('\n', ''), /\p{Cc}/u);
  });
});

describe('spec:stage-render/S13 writes only validated slots after the live approval check', () => {
  for (const stage of GATED) {
    it(stage, (t) => {
      const root = makeRepo(t);
      const args = writerArgs(stage);
      const before = run(root, args);
      assertBeforeApproval(before);
      assert.ok(!fs.existsSync(join(root, SLOT)));
      recordApproval(root, PLAN);
      const record = fs.readFileSync(recordPath(root));
      const date = today();
      const filesBefore = projectFiles(root);
      const after = run(root, args);
      expect(after, 0);
      const slots = JSON.parse(fs.readFileSync(join(root, SLOT), 'utf8'));
      assert.ok([date, today()].includes(slots.date), slots.date);
      assert.deepEqual(slots, { schema: 1, stage, date: slots.date, ...slotsFor(stage) });
      assert.deepEqual(projectFiles(root), { ...filesBefore, [SLOT]: fs.readFileSync(join(root, SLOT), 'utf8') });
      const line = 'node <kit>/tools/stage-render/cli.mjs ' + shellQuoteArg(SLOT);
      const command = line.replace('<kit>', isSeedablePathToken(KIT) ? KIT : shellQuoteArg(KIT));
      assert.ok(after.stdout.split('\n').includes(line), after.stdout);
      assert.ok(after.stdout.split('\n').includes(command), after.stdout);
      expect(run(root, [SLOT]), 0);
      const slotBytes = fs.readFileSync(join(root, SLOT));
      breakEpic(root);
      const refused = run(root, args);
      expect(refused, 1);
      assert.ok(outputOf(refused).includes(EPIC), outputOf(refused));
      assert.deepEqual(fs.readFileSync(join(root, SLOT)), slotBytes);
      assert.deepEqual(fs.readFileSync(recordPath(root)), record);
    });
  }
  it('writes a rendering slot file from --plan alone for a plan with no Story line at every stage naming a plan', (t) => {
    const root = makeRepo(t);
    const stages = table();
    const planStages = Object.keys(stages).filter((id) => Object.values(stages[id].slots).includes('plan'));
    assert.ok(planStages.includes('waiting-on-approval'), planStages.join(', '));
    fs.rmSync(join(root, EPIC));
    write(root, PLAN, APPROVED_PLAN_BODY);
    const writeAndRender = (stage) => {
      expect(run(root, ['--write', SLOT, '--stage', stage, '--plan', PLAN]), 0);
      const slots = JSON.parse(fs.readFileSync(join(root, SLOT), 'utf8'));
      assert.deepEqual(slots, { schema: 1, stage, date: slots.date, plan: PLAN });
      expect(run(root, [SLOT]), 0);
    };
    planStages.filter((stage) => !GATED.includes(stage)).forEach(writeAndRender);
    recordApproval(root, PLAN);
    planStages.filter((stage) => GATED.includes(stage)).forEach(writeAndRender);
  });
  it('writes the decisions and queue-row slots of a stage that names them, and refuses an unknown flag or a failed write', async (t) => {
    const { main } = await import('./cli.mjs');
    const root = makeRepo(t);
    const stage = Object.keys(table()).find((id) => Object.values(table()[id].slots).includes('decisions'));
    const argv = ['--write', SLOT, '--stage', stage, '--queue-row', VALUES['queue-row'], '--decisions', `${NOTES}#Decisions`];
    expect(await invoke(main, root, argv), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(join(root, SLOT), 'utf8')).decisions, [{ path: NOTES, heading: 'Decisions' }]);
    const unknown = await invoke(main, root, [...argv, '--bogus', 'x']);
    expect(unknown, 2);
    assert.match(outputOf(unknown), /known flags/);
    fs.rmSync(join(root, SLOT));
    fs.chmodSync(join(root, PLANS_REL), 0o555);
    const failed = await (async () => {
      try {
        return await invoke(main, root, argv);
      } finally {
        fs.chmodSync(join(root, PLANS_REL), 0o755);
      }
    })();
    expect(failed, 2);
    assert.ok(outputOf(failed).includes(SLOT), outputOf(failed));
    assert.ok(!fs.existsSync(join(root, SLOT)));
  });
  it('uses the atomic writer and applies render validation before replacing a slot file', async (t) => {
    const { main } = await import('./cli.mjs');
    assert.equal(typeof main, 'function');
    assert.match(fs.readFileSync(CLI, 'utf8'), /from\s*['"]\.\.\/atomic-write\.mjs['"]/);
    const root = makeRepo(t);
    recordApproval(root, PLAN);
    const stage = GATED[0];
    writeSlots(root, stage);
    const original = fs.readFileSync(join(root, SLOT));
    const result = run(root, writerArgs(stage).map((value) => value === PLAN ? '../outside.md' : value));
    assert.notEqual(result.status, 0, outputOf(result));
    assert.match(outputOf(result), /plan|outside\.md/);
    assert.deepEqual(fs.readFileSync(join(root, SLOT)), original);
    const linked = `${PLANS_REL}/linked.json`;
    fs.symlinkSync(join(root, SLOT), join(root, linked));
    const linkResult = run(root, writerArgs(stage).map((value) => value === SLOT ? linked : value));
    assert.notEqual(linkResult.status, 0, outputOf(linkResult));
    assert.ok(outputOf(linkResult).includes(linked), outputOf(linkResult));
    const renderLink = run(root, [linked]);
    assert.notEqual(renderLink.status, 0, outputOf(renderLink));
    assert.ok(outputOf(renderLink).includes(linked), outputOf(renderLink));
    assert.ok(fs.lstatSync(join(root, linked)).isSymbolicLink());
    assert.deepEqual(fs.readFileSync(join(root, SLOT)), original);
  });
});
