import assert from 'node:assert/strict';
import childProcess, { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { makeFixtureRepo } from '../../../scripts/testing/fixture-repo.mjs';
import { SPEC_SCHEMA, readSpecDocument } from '../../references/scripts/spec-schema/index.mjs';
import { RECEIPTS_BASENAME } from '../core-evidence-receipts.mjs';
import { canonicalFlowDigest } from '../flow-record-identity.mjs';
import { stripGitLocationEnv } from '../git-env.mjs';
import { judgePlan, readPlanDocument } from '../plan-shape-facts.mjs';
import { buildStoryEpic, makeOtherPlan, makeTree, planWith, write } from '../plan-shape-harness.test.mjs';
import { escapeForDisplay } from '../repo-lex.mjs';
import { getRevisionHomePath } from '../spec-check-ops.mjs';
import {
  APPROVED_PLAN_BODY, CONTRACT, FRONTMATTER, SPEC, contractPlan, recordApproval, writeApprovedPlan,
} from './approved-plan-harness.test.mjs';

const CLI = join(import.meta.dirname, 'cli.mjs');
const PLAN = 'docs/plans/guide.md';
const RENAMED = 'docs/plans/renamed.md';
const NAVIGATOR = SPEC_SCHEMA.storePrefix + SPEC_SCHEMA.navigatorFile;
const BASENAME = 'agent-workflow-plan-approvals.jsonl';
const ESSENCE = 'Keep the guide current.\n';
const RECORD_KEYS = ['schema', 'plan', 'date', 'planDigest', 'contractsDigest', 'contracts', 'essence', 'from', 'approval'].sort();
const HEX = /^[a-f0-9]{64}$/;
const RECORD_COMMAND = /plan-approval\/cli\.mjs\s+record\b/;
const NEW_YES_STEP = /new yes.*plan-approval\/cli\.mjs\s+record\b/s;
const outputOf = (result) => result.stdout + result.stderr;
const NAV_BODY = `${FRONTMATTER}maxLines: 80
kind: index
---
# Specs

${SPEC_SCHEMA.upLinkLine}

## Children
- [guide](./guide.md)
`;
const NAV_ROW = `R3 | modify | ${NAVIGATOR} | update the listing | ${SPEC}:1`;
const cleanEnv = () => {
  const env = stripGitLocationEnv(process.env);
  delete env.NODE_TEST_CONTEXT;
  delete env.AW_REVIEW_RECEIPTS;
  return env;
};
const git = (argv, cwd) => {
  const result = spawnSync('git', argv, { cwd, env: cleanEnv(), encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
};
const makeRoot = (t) => {
  const root = makeTree('plan-approval-cli');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'docs/readme.md', 'Guide.\n');
  write(root, PLAN, APPROVED_PLAN_BODY);
  return root;
};
const makeRepo = (t, initArgs = []) => makeFixtureRepo((argv) => git(argv), makeRoot(t), initArgs);
const recordPath = (root) => {
  const receipt = join(git(['rev-parse', '--absolute-git-dir'], root).trimEnd(), RECEIPTS_BASENAME);
  return join(dirname(receipt), BASENAME);
};
const readRecords = (root, path = recordPath(root)) => fs.readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
const writeRecords = (root, entries) => fs.writeFileSync(recordPath(root), entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
const essenceFile = (t, essence = ESSENCE) => {
  const scratch = makeTree('plan-approval-cli-essence');
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  write(scratch, 'essence.txt', essence);
  return join(scratch, 'essence.txt');
};
const recordArgs = (plan, file) => ['record', plan, '--essence-file', file];
const invoke = async (main, cwd, argv, env = cleanEnv()) => {
  const output = { stdout: '', stderr: '' };
  const status = await main(argv, {
    cwd,
    env,
    stdout: (chunk) => { output.stdout += chunk; },
    stderr: (chunk) => { output.stderr += chunk; },
  });
  return { status, ...output };
};
const commandsFor = (main, root, file, env = cleanEnv()) => ({
  record: (plan = PLAN) => invoke(main, root, recordArgs(plan, file), env),
  check: (plan = PLAN, ...args) => invoke(main, root, ['check', plan, ...args], env),
});
const raceRecord = (root, plan, file) => new Promise((resolve) => {
  execFile(process.execPath, [CLI, ...recordArgs(plan, file)], { cwd: root, env: cleanEnv(), encoding: 'utf8' },
    (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }));
});
const expect = (result, status, ...names) => {
  const output = outputOf(result);
  assert.equal(result.status, status, output);
  for (const name of names) assert.ok(output.includes(name), output);
};
const expectNoMatch = (result, plan = PLAN) => {
  expect(result, 1, plan, 'record');
  assert.match(outputOf(result), RECORD_COMMAND);
};
const expectNoEntryStep = (result, plan = PLAN) => {
  expectNoMatch(result, plan);
  assert.match(outputOf(result), /--essence-file/);
  assert.match(outputOf(result), /new yes/i);
};
const expectChangedContract = (result, plan = PLAN) => {
  expectNoMatch(result, plan);
  assert.match(outputOf(result), NEW_YES_STEP);
};
const expectWrongApproval = (result, approved) => {
  expect(result, 1, approved, 'dispatch part');
  assert.doesNotMatch(outputOf(result), RECORD_COMMAND);
};
const putContract = (root, body = CONTRACT) => {
  assert.deepEqual(readSpecDocument(body, 'guide.md').errors, []);
  write(root, SPEC, body);
  write(root, PLAN, contractPlan());
};
const EPIC_PATH = 'docs/ai/epics/ALPHA.md';
const CLAIM_PATH = 'docs/readme.md';
const STORY_PATH = 'docs/story/guide.md';
const STORY_GOAL = 'Spec: not adopted.\nStory: S1 of ALPHA';
const getStoryPlan = (path = STORY_PATH) => planWith({ goal: STORY_GOAL, ledger: `R1 | modify | ${path} | update the story | ${path}:1` });
const putClaimPlans = (root, field = 'owns', claim = CLAIM_PATH) => {
  write(root, EPIC_PATH, buildStoryEpic(claim, field));
  write(root, STORY_PATH, 'Story document.\n');
  write(root, RENAMED, getStoryPlan());
};
const expectStart = (result, held, step) => {
  expect(result, 1, held, step);
  assert.doesNotMatch(outputOf(result), RECORD_COMMAND);
};
const getEntry = async (root, plan, { legacy = false, from = 'approval' } = {}) => {
  const { approvedParts, composeEntry, digestPlan } = await import('./index.mjs');
  const verdict = judgePlan(root, readPlanDocument(root, plan));
  assert.equal(verdict.accepted, true, JSON.stringify(verdict.result.findings));
  const { goal, rows, verification } = approvedParts(verdict.text, verdict);
  const planDigest = legacy ? canonicalFlowDigest({ goal, rows, verification }) : digestPlan(verdict.text, verdict);
  return composeEntry({ plan, date: '2026-11-24', planDigest, contractsDigest: canonicalFlowDigest([]), contracts: [], essence: ESSENCE, from });
};

describe('spec:plan-approval/S4 record command', () => {
  it('appends exactly the strict nine fields beside review receipts and preserves the essence bytes', (t) => {
    const gitDirectory = makeTree('plan-approval-git-dir');
    t.after(() => fs.rmSync(gitDirectory, { recursive: true, force: true }));
    const root = makeRepo(t, ['--separate-git-dir', gitDirectory]);
    const essence = '  Caf\u00e9 \u8a08\u753b\r\n\n';
    recordApproval(root, PLAN, { essence });
    const [entry, ...extra] = readRecords(root);
    assert.deepEqual(extra, []);
    assert.deepEqual(Object.keys(entry).sort(), RECORD_KEYS);
    assert.equal(entry.schema, 1);
    assert.equal(entry.plan, PLAN);
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(entry.planDigest, HEX);
    assert.match(entry.contractsDigest, HEX);
    assert.deepEqual(entry.contracts, []);
    assert.equal(entry.contractsDigest, canonicalFlowDigest([]));
    assert.equal(entry.essence, essence);
    assert.equal(entry.from, 'approval');
    assert.equal(entry.approval, canonicalFlowDigest({ planDigest: entry.planDigest, contractsDigest: entry.contractsDigest, essence }));
    assert.equal(dirname(recordPath(root)), gitDirectory);
    assert.ok(!fs.existsSync(join(root, 'docs/plans', BASENAME)));
    assert.match(fs.readFileSync(join(import.meta.dirname, 'record.mjs'), 'utf8'), /import\s*\{[^}]*\bcreateStoreAppendLane\b[^}]*\}\s*from\s*['"]\.\.\/store-append\.mjs['"]/);
  });

  it('does not write a repeated approval and plan on the same or another date', (t) => {
    const root = makeRepo(t);
    recordApproval(root, PLAN, { essence: ESSENCE });
    const path = recordPath(root);
    const initial = fs.readFileSync(path, 'utf8');
    recordApproval(root, PLAN, { essence: ESSENCE });
    assert.equal(fs.readFileSync(path, 'utf8'), initial);
    const [entry] = readRecords(root);
    writeRecords(root, [{ ...entry, date: '2000-01-01' }]);
    const older = fs.readFileSync(path, 'utf8');
    recordApproval(root, PLAN, { essence: ESSENCE });
    assert.equal(fs.readFileSync(path, 'utf8'), older);
  });

  it('serializes two concurrent identical records and exits zero for both', async (t) => {
    const root = makeRepo(t);
    const file = essenceFile(t);
    const results = await Promise.all([raceRecord(root, PLAN, file), raceRecord(root, PLAN, file)]);
    results.forEach((result) => expect(result, 0));
    assert.equal(readRecords(root).length, 1);
  });

  it('records the same approval under a renamed plan and the new path matches', async (t) => {
    const root = makeRepo(t);
    const { main } = await import('./cli.mjs');
    recordApproval(root, PLAN, { essence: ESSENCE });
    fs.renameSync(join(root, PLAN), join(root, RENAMED));
    recordApproval(root, RENAMED, { essence: ESSENCE });
    const entries = readRecords(root);
    assert.deepEqual(entries.map(({ plan }) => plan), [PLAN, RENAMED]);
    assert.equal(entries[0].approval, entries[1].approval);
    expect(await invoke(main, root, ['check', RENAMED, '--digest', entries[1].approval]), 0);
  });

  it('keeps both distinct plans recorded concurrently', async (t) => {
    const root = makeRepo(t);
    const file = essenceFile(t);
    write(root, RENAMED, APPROVED_PLAN_BODY.replace('Keep the guide current.', 'Improve the guide.'));
    const results = await Promise.all([raceRecord(root, PLAN, file), raceRecord(root, RENAMED, file)]);
    results.forEach((result) => expect(result, 0));
    const entries = readRecords(root);
    assert.deepEqual(entries.map(({ plan }) => plan).sort(), [PLAN, RENAMED].sort());
    assert.notEqual(entries[0].approval, entries[1].approval);
  });

  it('refuses a plan without approved parts and unreadable or refused contracts at exit one', async (t) => {
    const root = makeRepo(t);
    const { main } = await import('./cli.mjs');
    const args = recordArgs(PLAN, essenceFile(t));
    write(root, PLAN, APPROVED_PLAN_BODY.replace('## Verification', '## Missing verification'));
    expect(await invoke(main, root, args), 1, PLAN);
    write(root, PLAN, contractPlan());
    expect(await invoke(main, root, args), 1, SPEC);
    write(root, SPEC, CONTRACT.replace('## Scenarios', '## Missing scenarios'));
    expect(await invoke(main, root, args), 1, SPEC);
    assert.ok(!fs.existsSync(recordPath(root)));
  });

  it('reports unreadable plan, unreadable essence and empty or blank essence at exit two', async (t) => {
    const root = makeRepo(t);
    const { main } = await import('./cli.mjs');
    const missing = 'docs/plans/missing.md';
    expect(await invoke(main, root, recordArgs(missing, essenceFile(t))), 2, missing);
    const absentEssence = join(root, 'absent.txt');
    expect(await invoke(main, root, recordArgs(PLAN, absentEssence)), 2, absentEssence);
    for (const text of ['', ' \t\n\r\n']) {
      const file = essenceFile(t, text);
      expect(await invoke(main, root, recordArgs(PLAN, file)), 2, file);
    }
    assert.ok(!fs.existsSync(recordPath(root)));
  });

  it('reports no git directory at exit two', async (t) => {
    const { main } = await import('./cli.mjs');
    const root = makeRoot(t);
    const result = await invoke(main, root, recordArgs(PLAN, essenceFile(t)));
    expect(result, 2);
    assert.match(result.stdout + result.stderr, /git (?:dir|repository|work tree)/i);
  });

  it('reports a record the store cannot write at exit two and writes nothing', { skip: process.getuid?.() === 0 ? 'root writes a read-only directory' : false }, async (t) => {
    const root = makeRepo(t);
    const { main } = await import('./cli.mjs');
    const gitDirectory = dirname(recordPath(root));
    const args = recordArgs(PLAN, essenceFile(t));
    fs.chmodSync(gitDirectory, 0o555);
    const result = await invoke(main, root, args).finally(() => fs.chmodSync(gitDirectory, 0o755));
    expect(result, 2, PLAN);
    assert.ok(!fs.existsSync(recordPath(root)));
  });

  it('appendApproval refuses an entry that is not an approval record at exit two and writes nothing', async (t) => {
    const root = makeRepo(t);
    const { appendApproval } = await import('./index.mjs');
    const result = appendApproval({ cwd: root, env: cleanEnv(), entry: { schema: 1, plan: PLAN } });
    assert.equal(result.exitCode, 2, JSON.stringify(result));
    assert.match(result.reason, /malformed/);
    assert.ok(!fs.existsSync(recordPath(root)));
  });
});

describe('spec:plan-approval/S5 check command', () => {
  it('refuses absent record and empty store, then accepts the recorded plan and rejects an incorrect approval', async (t) => {
    const root = makeRepo(t);
    const { main } = await import('./cli.mjs');
    const check = (...extra) => invoke(main, root, ['check', PLAN, ...extra]);
    expectNoEntryStep(await check());
    fs.writeFileSync(recordPath(root), '');
    expectNoEntryStep(await check());
    writeApprovedPlan(root, PLAN);
    const [entry] = readRecords(root);
    expect(await check(), 0);
    expect(await check('--digest', entry.approval), 0);
    const wrong = await check('--digest', 'f'.repeat(64));
    expectWrongApproval(wrong, entry.approval);
    write(root, PLAN, APPROVED_PLAN_BODY.replace('Keep the guide current.', 'Retire the guide.'));
    expectNoEntryStep(await check());
  });

  it('excludes navigator rows from the contracts and refuses a contract changed after approval', async (t) => {
    const root = makeRepo(t);
    const { main } = await import('./cli.mjs');
    const { digestContract } = await import('./index.mjs');
    putContract(root);
    assert.deepEqual(readSpecDocument(NAV_BODY, SPEC_SCHEMA.navigatorFile).errors, []);
    write(root, NAVIGATOR, NAV_BODY);
    write(root, PLAN, contractPlan(NAV_ROW));
    recordApproval(root, PLAN);
    const [entry] = readRecords(root);
    assert.deepEqual(entry.contracts, [SPEC]);
    assert.equal(entry.contractsDigest, canonicalFlowDigest([[SPEC, digestContract(CONTRACT)]]));
    write(root, NAVIGATOR, NAV_BODY.replace('# Specs', '# Contracts'));
    expect(await invoke(main, root, ['check', PLAN]), 0);
    write(root, SPEC, CONTRACT.replace('Keep the guide current.', 'Retire the guide.'));
    const changed = await invoke(main, root, ['check', PLAN]);
    expectChangedContract(changed);
  });

  it('uses the recorded plan revision home before the store even when the plan is renamed', async (t) => {
    const root = makeRepo(t);
    const { main } = await import('./cli.mjs');
    const { digestContract } = await import('./index.mjs');
    putContract(root, CONTRACT.replace('status: draft', 'status: live'));
    const revision = CONTRACT.replace('Keep the guide current.', 'Improve the guide.').replace('revision: 1', 'revision: 2');
    const homePath = getRevisionHomePath(PLAN, SPEC);
    write(root, homePath, revision);
    recordApproval(root, PLAN);
    const [entry] = readRecords(root);
    assert.deepEqual(entry.contracts, [SPEC]);
    assert.equal(entry.contractsDigest, canonicalFlowDigest([[SPEC, digestContract(revision)]]));
    fs.renameSync(join(root, PLAN), join(root, RENAMED));
    write(root, getRevisionHomePath(RENAMED, SPEC), CONTRACT);
    expect(await invoke(main, root, ['check', RENAMED]), 0);
    write(root, homePath, revision.replace('Improve the guide.', 'Retire the guide.'));
    const changed = await invoke(main, root, ['check', RENAMED]);
    expectChangedContract(changed, RENAMED);
  });

  it('names a malformed line and never lets an entry with extra keys match', async (t) => {
    const root = makeRepo(t);
    const { main } = await import('./cli.mjs');
    recordApproval(root, PLAN);
    const [entry] = readRecords(root);
    const twice = JSON.stringify(entry).replace(`"plan":${JSON.stringify(entry.plan)}`, `"plan":${JSON.stringify(entry.plan)},"plan":${JSON.stringify(entry.plan)}`);
    assert.notEqual(twice, JSON.stringify(entry));
    for (const line of [JSON.stringify({ ...entry, extra: true }), JSON.stringify({ ...entry, schema: '1' }), 'not JSON', twice]) {
      fs.writeFileSync(recordPath(root), line + '\n');
      const result = await invoke(main, root, ['check', PLAN]);
      expectNoMatch(result);
      assert.match(result.stdout + result.stderr, /(?:line\s+1\b|:1\b)/i);
    }
  });

  it('refuses unchanged plan bytes when the live structure verdict changes', async (t) => {
    const root = makeRepo(t);
    const { main } = await import('./cli.mjs');
    recordApproval(root, PLAN);
    expect(await invoke(main, root, ['check', PLAN]), 0);
    const broken = 'docs/ai/epics/BROKEN.md';
    write(root, broken, '---\ntype: epic\n---\n# Epic: Incomplete\n');
    assert.equal(fs.readFileSync(join(root, PLAN), 'utf8'), APPROVED_PLAN_BODY);
    assert.equal(judgePlan(root, readPlanDocument(root, PLAN)).accepted, false);
    const result = await invoke(main, root, ['check', PLAN]);
    expect(result, 1, broken, 'story-store');
    assert.doesNotMatch(outputOf(result), RECORD_COMMAND);
  });
});

it('spec:plan-approval/S12 first recorded yes wins, including twins and locked preflight', async (t) => {
  const { main } = await import('./cli.mjs');
  const { appendApproval } = await import('./index.mjs');
  const file = essenceFile(t);
  const record = (root, plan, env) => commandsFor(main, root, file, env).record(plan);
  const check = (root, plan, env) => commandsFor(main, root, file, env).check(plan);
  for (const field of ['owns', 'shared']) {
    for (const [first, second] of [[PLAN, RENAMED], [RENAMED, PLAN]]) {
      const root = makeRepo(t);
      putClaimPlans(root, field);
      const body = fs.readFileSync(join(root, first));
      const directory = join(root, 'receipts');
      fs.mkdirSync(directory);
      const overridePath = join(directory, BASENAME);
      const env = { ...cleanEnv(), AW_REVIEW_RECEIPTS: join(directory, RECEIPTS_BASENAME) };
      for (const plan of [first, second]) {
        const draft = await check(root, plan, env);
        expectNoMatch(draft, plan);
        assert.doesNotMatch(outputOf(draft), /story-owns|story-shared/);
      }
      expect(await record(root, first, env), 0);
      const step = first === PLAN ? 'narrow the claim if the story does not need the path' :
        field === 'owns' ? 'carry the change in ALPHA S1 (revise its plan; the yes is asked again)' : 'name the story that carries the file';
      expectStart(await record(root, second, env), first, `wait for ${first}'s Cleanup, or ${step}`);
      assert.equal(readRecords(root, overridePath).length, 1);
      assert.ok(!fs.existsSync(recordPath(root)));
      fs.rmSync(join(root, first));
      expect(await record(root, second, env), 0);
      assert.equal(readRecords(root, overridePath).length, 2);
      fs.writeFileSync(join(root, first), body);
      expectStart(await record(root, RENAMED, env), PLAN, "wait for " + PLAN + "'s Cleanup");
    }
  }
  for (const twin of [false, true]) {
    const root = makeRepo(t);
    putClaimPlans(root);
    const competitor = await getEntry(root, PLAN);
    const candidate = await getEntry(root, RENAMED);
    const inserted = twin ? [competitor, candidate] : [competitor];
    const lock = recordPath(root) + '.lock';
    const open = fs.openSync;
    const attempts = [];
    t.mock.method(fs, 'openSync', (path, flags, ...args) => {
      if (path === lock && flags === 'wx') {
        attempts.push(path);
        writeRecords(root, inserted);
      }
      return open(path, flags, ...args);
    });
    syncBuiltinESMExports();
    try {
      expectStart(await record(root, RENAMED), PLAN, `wait for ${PLAN}'s Cleanup`);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(attempts.length, 1);
    assert.deepEqual(readRecords(root), inserted);
  }
  const racing = makeRepo(t);
  putClaimPlans(racing);
  const races = await Promise.all([raceRecord(racing, PLAN, file), raceRecord(racing, RENAMED, file)]);
  assert.ok(races.some(({ status }) => status === 0));
  assert.ok(races.every(({ status }) => status === 0 || status === 1));
  const checks = await Promise.all([check(racing, PLAN), check(racing, RENAMED)]);
  assert.ok(checks.filter(({ status }) => status === 0).length <= 1);

  const same = makeRepo(t);
  putClaimPlans(same);
  const copy = getStoryPlan();
  write(same, PLAN, copy);
  expect(await record(same, RENAMED), 0);
  expect(await check(same, PLAN), 0);
  expect(await check(same, RENAMED), 0);
  write(same, PLAN, getStoryPlan(CLAIM_PATH));
  const heldStep = `carry the change in ${RENAMED} (revise it; the yes is asked again)`;
  expectStart(await record(same, PLAN), RENAMED, heldStep);
  const restored = await getEntry(same, PLAN);
  writeRecords(same, [...readRecords(same), restored]);
  for (const [plan, other] of [[PLAN, RENAMED], [RENAMED, PLAN]]) {
    expectStart(await check(same, plan), other, `carry the change in ${other} (revise it; the yes is asked again)`);
  }
  const door = makeRepo(t);
  putClaimPlans(door);
  const candidate = await getEntry(door, RENAMED);
  expect(await record(door, PLAN), 0);
  const previous = readRecords(door);
  assert.equal(appendApproval({ cwd: door, env: cleanEnv(), entry: candidate }).exitCode, 2);
  assert.deepEqual(readRecords(door), previous);
  const own = judgePlan(door, readPlanDocument(door, RENAMED)).story;
  const otherPlans = [makeOtherPlan({ identity: PLAN, digest: previous[0].planDigest, paths: [CLAIM_PATH] })];
  const carried = { ...candidate, from: 'provision' };
  assert.equal(appendApproval({ cwd: door, env: cleanEnv(), entry: carried, start: { own, otherPlans } }).exitCode, 0);
  assert.deepEqual(readRecords(door), [...previous, carried]);
  const carriedCopy = { ...carried, plan: 'docs/plans/carried-copy.md' };
  assert.equal(appendApproval({ cwd: door, env: cleanEnv(), entry: carriedCopy }).exitCode, 0);
  assert.deepEqual(readRecords(door), [...previous, carried, carriedCopy]);
  fs.rmSync(recordPath(door));
  fs.mkdirSync(recordPath(door));
  expect(await record(door, PLAN), 2, BASENAME);
  expect(await check(door, PLAN), 2, BASENAME);
  const flaky = makeRepo(t);
  putClaimPlans(flaky);
  expect(await record(flaky, RENAMED), 0);
  writeRecords(flaky, [...readRecords(flaky), await getEntry(flaky, PLAN)]);
  const held = readRecords(flaky);
  const spawn = childProcess.spawnSync;
  for (const run of [check, record]) {
    const faults = [];
    t.mock.method(childProcess, 'spawnSync', (command, argv, ...rest) => {
      if (faults.length || command !== 'git' || argv?.[0] !== 'rev-parse' || argv[1] !== '--absolute-git-dir') return spawn(command, argv, ...rest);
      faults.push(argv);
      return { status: 128, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    });
    syncBuiltinESMExports();
    try {
      expect(await run(flaky, PLAN), 2, 'no git directory');
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(faults.length, 1);
  }
  assert.deepEqual(readRecords(flaky), held);
  const flakyRecord = recordPath(flaky);
  const open = fs.openSync;
  const reads = [];
  t.mock.method(fs, 'openSync', (path, ...args) => {
    if (path === flakyRecord) reads.push(path);
    return open(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    expect(await check(flaky, PLAN), 1, 'story-owns');
    expect(await check(flaky, RENAMED), 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(reads.length, 2);
});

it('spec:plan-approval/S13 checks running claims at record and check, including amendments and renames', async (t) => {
  const { main } = await import('./cli.mjs');
  const root = makeRepo(t);
  const file = essenceFile(t);
  const { record, check } = commandsFor(main, root, file);
  putClaimPlans(root);
  expect(await record(PLAN), 0);
  expect(await check(PLAN), 0);
  for (const cross of [false, true]) {
    const separate = makeRepo(t);
    putClaimPlans(separate, 'shared');
    const otherStory = cross ? 'Story: S1 of BETA' : 'Story: S2 of ALPHA';
    const epic = buildStoryEpic(CLAIM_PATH, 'shared');
    if (cross) write(separate, 'docs/ai/epics/BETA.md', epic.replace('Row ALPHA', 'Row BETA'));
    else write(separate, EPIC_PATH, epic.replace('## Queue', `- S2 | Follow-up | depends-on: S1 | owns: none | shared: ${CLAIM_PATH} | state: planned\n## Queue`));
    write(separate, PLAN, getStoryPlan(CLAIM_PATH).replace('Story: S1 of ALPHA', otherStory));
    const calls = commandsFor(main, separate, file);
    for (const plan of [RENAMED, PLAN]) expect(await calls.record(plan), 0);
    for (const plan of [RENAMED, PLAN]) expect(await calls.check(plan), 0);
  }
  fs.rmSync(join(root, PLAN));
  expect(await record(RENAMED), 0);
  expect(await check(RENAMED), 0);
  write(root, PLAN, APPROVED_PLAN_BODY);
  const step = `wait for ${RENAMED}'s Cleanup, or carry the change in ALPHA S1 (revise its plan; the yes is asked again)`;
  for (const body of [APPROVED_PLAN_BODY, planWith({ ledger: `R1 | modify | ${STORY_PATH} | update | ${STORY_PATH}:1\namendments:\nA1 | modify | ${CLAIM_PATH} | update | ${CLAIM_PATH}:1` })]) {
    write(root, PLAN, body);
    for (const result of [await record(PLAN), await check(PLAN)]) {
      expectStart(result, RENAMED, step);
      assert.match(outputOf(result), /story-owns/);
    }
  }
  const moved = 'docs/plans/moved.md';
  fs.renameSync(join(root, RENAMED), join(root, moved));
  expect(await check(moved), 0);
  expectStart(await check(PLAN), moved, `wait for ${moved}'s Cleanup`);
  fs.renameSync(join(root, moved), join(root, RENAMED));
  write(root, RENAMED, getStoryPlan().replace('update the story', 'revise the story'));
  write(root, PLAN, APPROVED_PLAN_BODY);
  expect(await check(PLAN), 0);
});

it('spec:plan-approval/S14 re-records changed claims from the same essence and restores the earlier digest', async (t) => {
  const { main } = await import('./cli.mjs');
  const root = makeRepo(t);
  const file = essenceFile(t);
  const { record, check } = commandsFor(main, root, file);
  putClaimPlans(root, 'owns', STORY_PATH);
  expect(await record(PLAN), 0);
  const legacy = await getEntry(root, RENAMED, { legacy: true });
  writeRecords(root, [...readRecords(root), legacy]);
  expectNoEntryStep(await check(RENAMED), RENAMED);
  expect(await record(RENAMED), 0);
  expect(await check(RENAMED), 0);
  const initial = readRecords(root).at(-1);
  const widened = 'docs/';
  write(root, EPIC_PATH, buildStoryEpic(widened));
  expectNoEntryStep(await check(RENAMED), RENAMED);
  expectStart(await record(RENAMED), PLAN, `wait for ${PLAN}'s Cleanup`);
  assert.equal(readRecords(root).at(-1).approval, initial.approval);
  const separateClaim = 'docs/story/';
  write(root, EPIC_PATH, buildStoryEpic(separateClaim));
  expectNoEntryStep(await check(RENAMED), RENAMED);
  expect(await record(RENAMED), 0);
  expect(await check(RENAMED), 0);
  const widenedEntry = readRecords(root).at(-1);
  assert.notEqual(widenedEntry.planDigest, initial.planDigest);
  assert.equal(widenedEntry.essence, initial.essence);
  const amendmentPath = 'docs/appendix.md';
  write(root, amendmentPath, 'Appendix.\n');
  const expanded = `${separateClaim}, ${amendmentPath}`;
  write(root, EPIC_PATH, buildStoryEpic(expanded));
  write(root, RENAMED, getStoryPlan().replace('## Verification', `amendments:\nA1 | modify | ${amendmentPath} | update appendix | ${STORY_PATH}:1\n\n## Verification`));
  expectNoEntryStep(await check(RENAMED), RENAMED);
  expect(await record(RENAMED), 0);
  expect(await check(RENAMED), 0);
  assert.notEqual(readRecords(root).at(-1).planDigest, initial.planDigest);
  assert.notEqual(readRecords(root).at(-1).planDigest, widenedEntry.planDigest);
  assert.equal(readRecords(root).at(-1).essence, initial.essence);
  write(root, RENAMED, getStoryPlan());
  write(root, EPIC_PATH, buildStoryEpic(STORY_PATH));
  expect(await check(RENAMED, '--digest', initial.approval), 0);
  expect(await check(PLAN), 0);
});

it('spec:plan-approval/S15 refused lines carry only the step for their cause', async (t) => {
  const { main } = await import('./cli.mjs');
  const root = makeRepo(t);
  const file = essenceFile(t);
  const { record, check } = commandsFor(main, root, file);
  putContract(root);
  expectNoEntryStep(await check());
  expect(await record(), 0);
  const [accepted] = readRecords(root);
  const wrong = await check(PLAN, '--digest', 'f'.repeat(64));
  expectWrongApproval(wrong, accepted.approval);
  write(root, SPEC, CONTRACT.replace('Keep the guide current.', 'Retire the guide.'));
  const changed = await check();
  expectChangedContract(changed);
  for (const body of [null, 'not a contract']) {
    if (body === null) fs.rmSync(join(root, SPEC));
    else write(root, SPEC, body);
    for (const result of [await record(), await check()]) {
      expect(result, 1, SPEC);
      assert.match(outputOf(result), /fix/i);
      assert.doesNotMatch(outputOf(result), RECORD_COMMAND);
    }
  }
  write(root, SPEC, CONTRACT);
  write(root, EPIC_PATH, '---\ntype: epic\n---\n# Broken\n');
  const structure = await check();
  expect(structure, 1, EPIC_PATH, 'story-store');
  assert.doesNotMatch(outputOf(structure), RECORD_COMMAND);
  fs.rmSync(join(root, EPIC_PATH));
  putClaimPlans(root);
  write(root, PLAN, APPROVED_PLAN_BODY);
  recordApproval(root, RENAMED);
  expectStart(await record(), RENAMED, `wait for ${RENAMED}'s Cleanup`);
});

it('spec:plan-approval/S7 executor stops unapproved slices before writes and preserves the slice list', () => {
  const path = 'agent-workflow-kit/references/agents/executor.md';
  const root = join(import.meta.dirname, '../../..');
  const body = fs.readFileSync(join(root, path), 'utf8');
  const previous = git(['show', `HEAD:${path}`], root);
  const sliceList = (text) => text.match(/^- \*\*One slice,[\s\S]*?(?=\n- )/m)?.[0];
  assert.ok(sliceList(previous));
  assert.equal(sliceList(body), sliceList(previous));
  const stop = body.split(/\n(?=- )/).find((bullet) => /dispatch part|aw-plan-approval/.test(bullet));
  assert.ok(stop, 'missing the dispatch approval stop');
  for (const fact of [
    /code or test slice/i, /(?:only|must|requires?)[^.]*brief[^.]*(?:dispatch part|aw-plan-approval)/i,
    /render(?:ed|er)/i, /before any write/i, /check command/i,
    /\bplan\b/, /\bapproval\b/, /(?:non-zero|exit but 0|exit other than 0|exit[^.]*not 0)/i,
    /brief[^.]*plan[^.]*block[^.]*plan/i, /(?:neither|no)[^.]*approved row[^.]*amendment entry[^.]*cover/i,
    /sweep[^.]*concrete paths/i, /(?:stop|refuse)/i, /routine or task slice/i, /kit command/i, /generat/i,
    /(?:hand-writ|hand writ)[^.]*source[^.]*test/i, /outside/i,
  ]) assert.match(stop.replace(/\s+/g, ' '), fact);
});

describe('spec:plan-approval/S10 IO seam', () => {
  it('returns usage without a read or process exit and uses the exported outcome table', async (t) => {
    const { main, OUTCOME_LINES } = await import('./cli.mjs');
    assert.ok(OUTCOME_LINES && Object.keys(OUTCOME_LINES).length > 0);
    const source = fs.readFileSync(CLI, 'utf8');
    assert.match(fs.readFileSync(join(import.meta.dirname, 'record.mjs'), 'utf8'), /\bescapeForDisplay\b/);
    assert.match(source, /\bisDirectRun\b/);
    assert.match(source, /\bOUTCOME_LINES\s*(?:\.|\[)/);
    assert.doesNotMatch(source, /\b(?:stdout|stderr)\s*\(\s*['"`][A-Za-z]/);
    const root = makeRoot(t);
    const calls = [];
    const forbid = (name) => () => { calls.push(name); throw new Error(name); };
    for (const name of ['readFileSync', 'openSync', 'readdirSync', 'lstatSync', 'statSync']) t.mock.method(fs, name, forbid(name));
    t.mock.method(childProcess, 'spawnSync', forbid('spawnSync'));
    t.mock.method(process, 'exit', forbid('process.exit'));
    syncBuiltinESMExports();
    try {
      for (const args of [[], ['other'], ['record', PLAN], ['record', PLAN, '--essence-file'], ['check', PLAN, '--digest'], ['check', PLAN, '--unknown']]) {
        const result = await invoke(main, root, args);
        expect(result, 2);
        assert.match(result.stdout + result.stderr, /usage/i);
      }
      const { readApproval } = await import('./cli.mjs');
      for (const operands of [{ plan: '' }, { plan: '-x' }, { plan: PLAN, approval: 'not-hex' }]) {
        assert.equal(readApproval({ cwd: root, ...operands }).exitCode, 2, JSON.stringify(operands));
      }
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.deepEqual(calls, []);
  });

  it('escapes displayed operand values without emitting embedded control characters', async (t) => {
    const { main } = await import('./cli.mjs');
    const root = makeRoot(t);
    const missing = 'docs/plans/line\nbreak.md';
    const result = await invoke(main, root, recordArgs(missing, essenceFile(t)));
    expect(result, 2, escapeForDisplay(missing));
    assert.doesNotMatch((result.stdout + result.stderr).replaceAll('\n', ''), /\p{Cc}/u);
    assert.ok(!(result.stdout + result.stderr).includes(missing));
  });
});
