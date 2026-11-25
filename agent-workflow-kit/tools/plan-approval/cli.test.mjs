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
import { makeTree, planWith, write } from '../plan-shape-harness.test.mjs';
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
const readRecords = (root) => fs.readFileSync(recordPath(root), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
const writeRecords = (root, entries) => fs.writeFileSync(recordPath(root), entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
const essenceFile = (t, essence = ESSENCE) => {
  const scratch = makeTree('plan-approval-cli-essence');
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  write(scratch, 'essence.txt', essence);
  return join(scratch, 'essence.txt');
};
const recordArgs = (plan, file) => ['record', plan, '--essence-file', file];
const invoke = async (main, cwd, argv) => {
  const output = { stdout: '', stderr: '' };
  const status = await main(argv, {
    cwd,
    env: cleanEnv(),
    stdout: (chunk) => { output.stdout += chunk; },
    stderr: (chunk) => { output.stderr += chunk; },
  });
  return { status, ...output };
};
const raceRecord = (root, plan, file) => new Promise((resolve) => {
  execFile(process.execPath, [CLI, ...recordArgs(plan, file)], { cwd: root, env: cleanEnv(), encoding: 'utf8' },
    (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }));
});
const expect = (result, status, ...names) => {
  const output = result.stdout + result.stderr;
  assert.equal(result.status, status, output);
  for (const name of names) assert.ok(output.includes(name), output);
};
const expectNoMatch = (result, plan = PLAN) => {
  expect(result, 1, plan, 'record');
  assert.match(result.stdout + result.stderr, /plan-approval\/cli\.mjs\s+record\b/);
};
const putContract = (root, body = CONTRACT) => {
  assert.deepEqual(readSpecDocument(body, 'guide.md').errors, []);
  write(root, SPEC, body);
  write(root, PLAN, contractPlan());
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
    assert.match(fs.readFileSync(CLI, 'utf8'), /import\s*\{[^}]*\bcreateStoreAppendLane\b[^}]*\}\s*from\s*['"]\.\.\/store-append\.mjs['"]/);
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
});

describe('spec:plan-approval/S5 check command', () => {
  it('refuses absent record and empty store, then accepts the recorded plan and rejects an incorrect approval', async (t) => {
    const root = makeRepo(t);
    const { main } = await import('./cli.mjs');
    const check = (...extra) => invoke(main, root, ['check', PLAN, ...extra]);
    expectNoMatch(await check());
    fs.writeFileSync(recordPath(root), '');
    expectNoMatch(await check());
    writeApprovedPlan(root, PLAN);
    const [entry] = readRecords(root);
    expect(await check(), 0);
    expect(await check('--digest', entry.approval), 0);
    expectNoMatch(await check('--digest', 'f'.repeat(64)));
    write(root, PLAN, APPROVED_PLAN_BODY.replace('Keep the guide current.', 'Retire the guide.'));
    expectNoMatch(await check());
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
    expectNoMatch(await invoke(main, root, ['check', PLAN]));
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
    expectNoMatch(await invoke(main, root, ['check', RENAMED]), RENAMED);
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
    expectNoMatch(result);
    expect(result, 1, broken);
  });
});

it('spec:plan-approval/S7 executor stops unapproved slices before writes and preserves the slice list and authoring deliverable', () => {
  const path = 'agent-workflow-kit/references/agents/executor.md';
  const root = join(import.meta.dirname, '../../..');
  const body = fs.readFileSync(join(root, path), 'utf8');
  const previous = git(['show', `HEAD:${path}`], root);
  const sliceList = (text) => text.match(/^- \*\*One slice,[\s\S]*?(?=\n- )/m)?.[0];
  const authoringDeliverable = (text) => text.match(/A plan draft, a contract draft[\s\S]*?named file like\n  any other\./)?.[0];
  assert.ok(sliceList(previous));
  assert.ok(authoringDeliverable(previous));
  assert.equal(sliceList(body), sliceList(previous));
  assert.equal(authoringDeliverable(body), authoringDeliverable(previous));
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
    assert.match(source, /\bescapeForDisplay\b/);
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
