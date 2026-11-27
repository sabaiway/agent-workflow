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
import { makeTree, planWith, UNREADABLE_PLAN_BYTES, write, writeJson } from '../plan-shape-harness.test.mjs';
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
const run = (root, argv, env = cleanEnv()) => {
  const result = spawnSync(process.execPath, [CLI, ...argv], { cwd: root, env, encoding: 'utf8' });
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
const invoke = async (main, root, argv, io = {}) => {
  const output = { stdout: '', stderr: '' };
  const status = await main(argv, {
    cwd: root, env: cleanEnv(), ...io,
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
const STAGE_RECORD = 'agent-workflow-stage.json';
const NO_CODE_STAGE = 'pause';
const gitDirOf = (root) => git(['rev-parse', '--absolute-git-dir'], root).trim();
const stageRecordPath = (root) => join(gitDirOf(root), STAGE_RECORD);
const readStageRecord = (root) => JSON.parse(fs.readFileSync(stageRecordPath(root), 'utf8'));
const stageRecord = (stage, writes, slotFile = SLOT) => ({ schema: 1, stage, slotFile, writes });

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
      assert.match(outputOf(refused), /story-store/);
      assert.doesNotMatch(outputOf(refused), /plan-approval\/cli\.mjs\s+record\b|waiting-on-approval/);
      assertNoTemplate(refused, stage, FIXED_LINES);
      assert.deepEqual(fs.readFileSync(recordPath(root)), recorded);
      assert.deepEqual(fs.readFileSync(join(root, SLOT)), slotBytes);
      write(root, EPIC, EPIC_BODY);
      const unreadable = `${PLANS_REL}/unreadable.md`;
      write(root, unreadable, UNREADABLE_PLAN_BYTES);
      const cannotRead = run(root, [SLOT]);
      expect(cannotRead, 1);
      assert.ok(outputOf(cannotRead).includes(unreadable), outputOf(cannotRead));
      assertNoTemplate(cannotRead, stage, FIXED_LINES);
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
  const START_HEADER = 'the start prompt, shown to the user unchanged:';
  const START_COMMAND_PREFIX = 'To start: run';
  const ONE_SLOT_NAME = 'next-session.json';
  const OTHER_SLOT = `${PLANS_REL}/other-session.json`;
  const RENDER_LINE = 'node <kit>/tools/stage-render/cli.mjs ' + shellQuoteArg(SLOT);
  const assertPrintsNoneOfTheSix = (result, label = '') => {
    const lines = outputOf(result).split('\n');
    assert.ok(!lines.includes(START_HEADER) && !lines.includes(RENDER_LINE), `${label}: ${outputOf(result)}`);
    assert.ok(!lines.some((line) => line.startsWith(START_COMMAND_PREFIX)), `${label}: ${outputOf(result)}`);
    assert.ok(!result.stdout.includes(SLOT), `${label}: ${result.stdout}`);
  };
  const grantAny = (root) => {
    writeSlots(root, GATED[0]);
    expect(run(root, [SLOT]), 0);
  };
  const recordBytesOf = (root) => (fs.existsSync(stageRecordPath(root)) ? fs.readFileSync(stageRecordPath(root)) : null);

  for (const stage of GATED) {
    it(stage, (t) => {
      const root = makeRepo(t);
      const args = writerArgs(stage);
      const before = run(root, args);
      assertBeforeApproval(before);
      assertPrintsNoneOfTheSix(before, 'before the approval');
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
      assert.ok(after.stdout.split('\n').includes(START_HEADER), after.stdout);
      expect(run(root, [SLOT]), 0);
      const slotBytes = fs.readFileSync(join(root, SLOT));
      breakEpic(root);
      const refused = run(root, args);
      expect(refused, 1);
      assert.ok(outputOf(refused).includes(EPIC), outputOf(refused));
      assertPrintsNoneOfTheSix(refused, 'a refused structure');
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
    const bodyFile = `${PLANS_REL}/slot-body.json`;
    fs.renameSync(join(root, SLOT), join(root, bodyFile));
    fs.symlinkSync(join(root, bodyFile), join(root, SLOT));
    const linkResult = run(root, writerArgs(stage));
    assert.notEqual(linkResult.status, 0, outputOf(linkResult));
    assert.ok(outputOf(linkResult).includes(SLOT), outputOf(linkResult));
    const renderLink = run(root, [SLOT]);
    assert.notEqual(renderLink.status, 0, outputOf(renderLink));
    assert.ok(outputOf(renderLink).includes(SLOT), outputOf(renderLink));
    assert.ok(fs.lstatSync(join(root, SLOT)).isSymbolicLink());
    assert.deepEqual(fs.readFileSync(join(root, bodyFile)), original);
  });
  it('the retired --epic, --story and --file are unknown arguments: usage at exit 2, nothing written, and the usage line names none of them', (t) => {
    const root = makeRepo(t);
    const filesBefore = projectFiles(root);
    const retired = [['--epic', EPIC], ['--story', STORY], ['--file', NOTES]];
    for (const [flag, value] of retired) {
      for (const stage of ['pause', GATED[0]]) {
        const result = run(root, ['--write', SLOT, '--stage', stage, ...(stage === 'pause' ? [] : ['--plan', PLAN]), flag, value]);
        expect(result, 2);
        const usage = result.stderr.split('\n').find((line) => line.startsWith('Usage: '));
        assert.ok(usage, outputOf(result));
        const synopsis = usage.slice(0, usage.indexOf(' — '));
        assert.ok(synopsis.includes('--queue-row') && synopsis.includes('--decisions'), synopsis);
        for (const [name] of retired) assert.ok(!synopsis.includes(name), synopsis);
        assert.deepEqual(projectFiles(root), filesBefore, `${stage} ${flag}`);
        assert.equal(fs.existsSync(stageRecordPath(root)), false, `${stage} ${flag}`);
      }
    }
  });
  it('in a main tree --write prints exactly the written line, the render line, the render command, the header and the start prompt, in a linked tree the first three alone', async (t) => {
    const { composeRenderLine, composeRenderCommand, composeStartPrompt, loadStages } = await import('./index.mjs');
    const stagesTable = loadStages(fs.readFileSync(new URL('./stages.json', import.meta.url), 'utf8'));
    const root = makeRepo(t);
    const assertPrinted = (cwd, stage, withPrompt) => {
      const result = run(cwd, writerArgs(stage));
      expect(result, 0);
      const lines = result.stdout.split('\n');
      const slots = JSON.parse(fs.readFileSync(join(cwd, SLOT), 'utf8'));
      const prompt = withPrompt ? composeStartPrompt({ slotFile: SLOT, slots, table: stagesTable }).split('\n') : [];
      assert.equal(prompt.length, withPrompt ? 2 : 0, prompt.join('\n'));
      assert.ok(lines[0].includes(SLOT), result.stdout);
      assert.deepEqual(lines.slice(1), [composeRenderLine(SLOT), composeRenderCommand(SLOT), ...(withPrompt ? [START_HEADER, ...prompt] : []), ''], `${stage}: ${result.stdout}`);
    };
    assertPrinted(root, NO_CODE_STAGE, true);
    assertPrinted(root, 'waiting-on-approval', true);
    recordApproval(root, PLAN);
    assertPrinted(root, GATED[0], true);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      'commit', '--allow-empty', '--no-verify', '-q', '-m', 'fixture'], root);
    const linkedParent = makeTree('stage-render-linked-write');
    t.after(() => fs.rmSync(linkedParent, { recursive: true, force: true }));
    const linked = join(linkedParent, 'tree');
    git(['worktree', 'add', '-q', '--detach', linked], root);
    fs.mkdirSync(join(linked, PLANS_REL), { recursive: true });
    assertPrinted(linked, NO_CODE_STAGE, false);
  });
  it('composes every printed line before the write: a kit root holding a backtick refuses naming it, writes no slot file, prints none of the six lines and leaves the record', (t) => {
    const root = makeRepo(t);
    const scratch = makeTree('stage-render-kit-copy');
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const copyRoot = join(scratch, 'kit`tick');
    fs.cpSync(KIT, copyRoot, { recursive: true });
    recordApproval(root, PLAN);
    grantAny(root);
    fs.rmSync(join(root, SLOT));
    const recordBefore = recordBytesOf(root);
    const result = spawnSync(process.execPath, [join(copyRoot, 'tools/stage-render/cli.mjs'), ...writerArgs(NO_CODE_STAGE)], { cwd: root, env: cleanEnv(), encoding: 'utf8' });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, outputOf(result));
    assert.ok(outputOf(result).includes(copyRoot), outputOf(result));
    assert.equal(fs.existsSync(join(root, SLOT)), false);
    assertPrintsNoneOfTheSix(result, 'a kit root holding a backtick');
    assert.deepEqual(recordBytesOf(root), recordBefore);
    assert.deepEqual(readStageRecord(root), stageRecord(GATED[0], 'any'));
  });
  it('beside a valid docs/plans/next-session.json a render of another name exits 1 and records authoring naming the one slot file, and a --write to another name exits 1 and leaves the record', (t) => {
    const root = makeRepo(t);
    recordApproval(root, PLAN);
    grantAny(root);
    fs.copyFileSync(join(root, SLOT), join(root, OTHER_SLOT));
    const rendered = run(root, [OTHER_SLOT]);
    expect(rendered, 1);
    assert.ok(outputOf(rendered).includes(ONE_SLOT_NAME), outputOf(rendered));
    assert.deepEqual(readStageRecord(root), stageRecord(null, 'authoring'));
    fs.rmSync(join(root, OTHER_SLOT));
    grantAny(root);
    const recordBefore = recordBytesOf(root);
    const written = run(root, ['--write', OTHER_SLOT, '--stage', NO_CODE_STAGE]);
    expect(written, 1);
    assert.equal(fs.existsSync(join(root, OTHER_SLOT)), false);
    assert.deepEqual(recordBytesOf(root), recordBefore);
    assert.deepEqual(readStageRecord(root), stageRecord(GATED[0], 'any'));
  });
  it('a non-gated --write whose record write fails exits 2 with no slot file, and one whose slot write fails after the record keeps the earlier slot file and the authoring record and prints no start prompt', (t) => {
    const root = makeRepo(t);
    fs.mkdirSync(stageRecordPath(root));
    const recordFailed = run(root, writerArgs(NO_CODE_STAGE));
    expect(recordFailed, 2);
    assert.ok(outputOf(recordFailed).includes(STAGE_RECORD), outputOf(recordFailed));
    assert.equal(fs.existsSync(join(root, SLOT)), false);
    fs.rmdirSync(stageRecordPath(root));
    recordApproval(root, PLAN);
    grantAny(root);
    const earlier = fs.readFileSync(join(root, SLOT));
    fs.chmodSync(join(root, PLANS_REL), 0o555);
    const slotFailed = (() => {
      try {
        return run(root, writerArgs(NO_CODE_STAGE));
      } finally {
        fs.chmodSync(join(root, PLANS_REL), 0o755);
      }
    })();
    expect(slotFailed, 2);
    assert.deepEqual(fs.readFileSync(join(root, SLOT)), earlier);
    assert.deepEqual(readStageRecord(root), stageRecord(NO_CODE_STAGE, 'authoring'));
    assertPrintsNoneOfTheSix(slotFailed, 'a failed slot write');
  });
});

describe('spec:stage-render/S14 the render records its stage in the git directory', () => {
  const KEPT = 'kept\n';

  it('every render first records authoring with a null stage, so a refusal of the table, the slot file, the approval match or the engine leaves it over an earlier any', async (t) => {
    const { main } = await import('./cli.mjs');
    const { FIXED_LINES } = await import('./index.mjs');
    const root = makeRepo(t);
    recordApproval(root, PLAN);
    const grantAny = () => {
      writeSlots(root, GATED[0]);
      write(root, EPIC, EPIC_BODY);
      expect(run(root, [SLOT]), 0);
      assert.deepEqual(readStageRecord(root), stageRecord(GATED[0], 'any'));
    };
    const refusals = [
      ['the table', 2, () => invoke(main, root, [SLOT], { stagesPath: join(root, 'absent-stages.json') })],
      ['the slot file', 1, () => {
        writeJson(root, SLOT, { schema: 1, stage: 'unknown-stage', date: DATE });
        return run(root, [SLOT]);
      }],
      ['the approval match', 1, () => {
        breakEpic(root);
        return run(root, [SLOT]);
      }],
      ['the engine', 2, () => run(root, [SLOT], { ...cleanEnv(), [ENGINE_ENV]: join(root, 'absent-engine') })],
    ];
    for (const [input, status, refuse] of refusals) {
      grantAny();
      const result = await refuse();
      assert.equal(result.status, status, `${input}: ${outputOf(result)}`);
      assertNoTemplate(result, GATED[0], FIXED_LINES);
      assert.deepEqual(readStageRecord(root), stageRecord(null, 'authoring'), input);
    }
  });
  it('a composed record-gated rendering whose match holds records any, every other composed rendering authoring with its stage, in exactly the four keys', async (t) => {
    const root = makeRepo(t);
    const renderAndRead = (stage) => {
      writeSlots(root, stage);
      expect(run(root, [SLOT]), 0);
      return readStageRecord(root);
    };
    const others = Object.keys(table()).filter((stage) => !GATED.includes(stage));
    for (const stage of others) assert.deepEqual(renderAndRead(stage), stageRecord(stage, 'authoring'), stage);
    const { composeStageRecord } = await import('./index.mjs');
    assert.equal(fs.readFileSync(stageRecordPath(root), 'utf8'), composeStageRecord({ stage: others.at(-1), slotFile: SLOT, writes: 'authoring' }));
    recordApproval(root, PLAN);
    for (const stage of GATED) assert.deepEqual(renderAndRead(stage), stageRecord(stage, 'any'), stage);
    assert.equal(fs.readFileSync(stageRecordPath(root), 'utf8'), composeStageRecord({ stage: GATED.at(-1), slotFile: SLOT, writes: 'any' }));
  });
  it('--write of a stage outside RECORD_GATED_STAGES records authoring with its stage, while --write of a record-gated stage, a refused --write and --dispatch leave the record', (t) => {
    const root = makeRepo(t);
    recordApproval(root, PLAN);
    writeSlots(root, GATED[0]);
    expect(run(root, [SLOT]), 0);
    const granted = fs.readFileSync(stageRecordPath(root));
    for (const argv of [writerArgs(GATED[1]), ['--dispatch', PLAN]]) {
      expect(run(root, argv), 0);
      assert.deepEqual(fs.readFileSync(stageRecordPath(root)), granted, argv.join(' '));
    }
    expect(run(root, ['--write', SLOT, '--stage', NO_CODE_STAGE, '--plan', PLAN]), 1);
    assert.deepEqual(fs.readFileSync(stageRecordPath(root)), granted, 'a refused --write');
    expect(run(root, ['--write', SLOT, '--stage', NO_CODE_STAGE]), 0);
    assert.deepEqual(readStageRecord(root), stageRecord(NO_CODE_STAGE, 'authoring'));
  });
  it('the record lands in the git directory --absolute-git-dir answers whatever AW_REVIEW_RECEIPTS or an ambient GIT_DIR names, one per work tree, and with no git directory nothing is recorded and the stage renders', (t) => {
    const root = makeRepo(t);
    const receipts = makeTree('stage-record-receipts');
    const other = makeFixtureRepo((argv) => git(argv), makeTree('stage-record-other'));
    const linkedParent = makeTree('stage-record-linked');
    for (const dir of [receipts, other, linkedParent]) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    writeSlots(root, NO_CODE_STAGE);
    const seams = [
      ['AW_REVIEW_RECEIPTS', { AW_REVIEW_RECEIPTS: join(receipts, 'agent-workflow-review-receipts.jsonl') }],
      ['GIT_DIR', { GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other }],
    ];
    for (const [seam, seamEnv] of seams) {
      fs.rmSync(stageRecordPath(root), { force: true });
      expect(run(root, [SLOT], { ...cleanEnv(), ...seamEnv }), 0);
      assert.deepEqual(readStageRecord(root), stageRecord(NO_CODE_STAGE, 'authoring'), seam);
      assert.deepEqual(fs.readdirSync(receipts), [], seam);
      assert.equal(fs.existsSync(join(gitDirOf(other), STAGE_RECORD)), false, seam);
    }
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      'commit', '--allow-empty', '--no-verify', '-q', '-m', 'fixture'], root);
    const linked = join(linkedParent, 'tree');
    git(['worktree', 'add', '-q', '--detach', linked], root);
    writeJson(linked, SLOT, { schema: 1, stage: NO_CODE_STAGE, date: DATE });
    fs.rmSync(stageRecordPath(root), { force: true });
    expect(run(linked, [SLOT]), 0);
    assert.notEqual(gitDirOf(linked), gitDirOf(root));
    assert.deepEqual(readStageRecord(linked), stageRecord(NO_CODE_STAGE, 'authoring'));
    assert.equal(fs.existsSync(stageRecordPath(root)), false);
    const bare = makeRoot(t);
    const probe = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: bare, env: cleanEnv(), encoding: 'utf8' });
    assert.notEqual(probe.status, 0, 'the fixture reaches no git directory');
    writeSlots(bare, NO_CODE_STAGE);
    const rendered = run(bare, [SLOT]);
    expect(rendered, 0);
    assert.ok(rendered.stdout.includes(table()[NO_CODE_STAGE].goal), rendered.stdout);
    assert.deepEqual(fs.readdirSync(bare, { recursive: true }).filter((path) => path.endsWith(STAGE_RECORD)), []);
  });
  it('a failed record write exits 2 naming the record and prints no template, and a link at the record path is never written through', async (t) => {
    const { FIXED_LINES } = await import('./index.mjs');
    const root = makeRepo(t);
    const outside = makeTree('stage-record-target');
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    writeSlots(root, NO_CODE_STAGE);
    const gitDir = gitDirOf(root);
    const recordFile = join(gitDir, STAGE_RECORD);
    const target = join(outside, 'target.json');
    fs.writeFileSync(target, KEPT);
    const assertFailed = (result, state) => {
      assert.equal(result.status, 2, `${state}: ${outputOf(result)}`);
      assert.ok(outputOf(result).includes(STAGE_RECORD), `${state}: ${outputOf(result)}`);
      assertNoTemplate(result, NO_CODE_STAGE, FIXED_LINES);
    };
    fs.mkdirSync(recordFile);
    assertFailed(run(root, [SLOT]), 'a directory at the record path');
    fs.rmdirSync(recordFile);
    fs.symlinkSync(target, recordFile);
    assertFailed(run(root, [SLOT]), 'a link at the record path');
    assert.ok(fs.lstatSync(recordFile).isSymbolicLink());
    assert.equal(fs.readFileSync(target, 'utf8'), KEPT);
    fs.rmSync(recordFile);
    fs.chmodSync(gitDir, 0o555);
    const unwritable = (() => {
      try {
        return run(root, [SLOT]);
      } finally {
        fs.chmodSync(gitDir, 0o755);
      }
    })();
    assertFailed(unwritable, 'an unwritable git directory');
    assert.equal(fs.existsSync(recordFile), false);
  });
});
