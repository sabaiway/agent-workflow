import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { makeFixtureRepo } from '../../../scripts/testing/fixture-repo.mjs';
import { GIT_MAX_BUFFER, hermeticGitEnv, resolveGitLocation, stripGitLocationEnv } from '../git-env.mjs';
import { computeTreeFingerprint } from '../core-evidence.mjs';
import * as checker from '../coverage-check.mjs';
import { runCli, runGates, spawnGateViaBash, RESERVED_CAPABILITY_ENV } from '../run-gates.mjs';
import { runGuard } from '../commit-guard.mjs';

const declared = await import('./index.mjs').catch(() => ({}));
const TOOLS = fileURLToPath(new URL('../', import.meta.url));
const LIST = 'docs/ai/coverage-declared.json';
const PREFIX = 'coverage-check: declared list — ';
const DECLARED_ENV = 'AW_FINAL_ATTEST_DECLARED';
const ATTEST_NAMES = ['AW_FINAL_ATTEST_NONCE', 'AW_FINAL_ATTEST_FINGERPRINT', 'AW_FINAL_ATTEST_BASE', DECLARED_ENV];
const FIXTURE = 'copied-fixture.mjs';
const REASON = 'Copied to the git directory and tested there, never loaded at its repository path.';
const SOURCE = "import assert from 'node:assert/strict';\nassert.equal(2 + 2, 4);\n";
const PASS = 'coverage-check: PASS — every changed Node line is covered';
const GUARD_REFUSAL = 'commit-guard: REFUSED — the declared coverage list is not the one the final run bound (';
const CHECKER_REFUSAL = 'coverage-check: REFUSED — the declared coverage list is not the one the final run started with (';
const MOVED = 'the declared coverage list moved under the final run';
const CANONICAL = [
  { id: 'review-state', title: 'rs', cmd: `node "${join(TOOLS, 'review-state.mjs')}" --check` },
  { id: 'coverage-check', title: 'cc', cmd: `node "${join(TOOLS, 'coverage-check.mjs')}" --check` },
];
const UNIT_TESTS = { id: 'unit-tests', title: 'unit tests', cmd:
  `cp ${FIXTURE} "$AW_GIT_DIR/executed-fixture.mjs" && node "$AW_GIT_DIR/executed-fixture.mjs" && printf 'SF:%s/pending.mjs\\nDA:1,1\\nend_of_record\\n' "$PWD" > "$AW_LCOV_FILE"` };
const REPO_TEMPLATE = { root: null };
after(() => { if (REPO_TEMPLATE.root) rmSync(REPO_TEMPLATE.root, { recursive: true, force: true }); });
const fixtureEnv = (home, extra = {}) => ({
  ...hermeticGitEnv(Object.fromEntries(Object.entries(stripGitLocationEnv(process.env))
    .filter(([name]) => !name.startsWith('AW_') && name !== 'NODE_TEST_CONTEXT')), home), ...extra,
});
const withEnv = (env, run) => {
  const ambient = process.env;
  try { process.env = env; return run(); } finally { process.env = ambient; }
};
const makeDirectory = (context) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'declared-final-')));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const runGit = (root, args) => {
  const result = spawnSync('git', args, { cwd: root, env: fixtureEnv(root), encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, `git ${args.join(' ')}: signal ${result.signal}`);
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
};
const buildTemplate = () => {
  if (REPO_TEMPLATE.root) return REPO_TEMPLATE.root;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'declared-final-template-')));
  try {
    makeFixtureRepo((args) => runGit(root, args), root, ['-q']);
    runGit(root, ['config', 'user.name', 'coder-tool']);
    runGit(root, ['config', 'user.email', 'coder-tools@proton.me']);
    mkdirSync(join(root, 'docs/ai'), { recursive: true });
    writeFileSync(join(root, 'docs/ai/orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'solo' } }));
    writeFileSync(join(root, 'docs/ai/gates.json'), JSON.stringify({ gates: [UNIT_TESTS, ...CANONICAL] }));
    writeFileSync(join(root, FIXTURE), SOURCE);
    runGit(root, ['add', '-A']);
    runGit(root, ['commit', '-qm', 'base']);
    REPO_TEMPLATE.root = root;
    return root;
  } finally { if (!REPO_TEMPLATE.root) rmSync(root, { recursive: true, force: true }); }
};
const withRepo = (context, run) => {
  const template = buildTemplate();
  const root = makeDirectory(context);
  cpSync(template, root, { recursive: true });
  writeFileSync(join(root, '.git/info/exclude'), `${LIST}\n`);
  writeFileSync(join(root, 'pending.mjs'), 'export const pending = 1;\n');
  runGit(root, ['add', '-A']);
  return withEnv(fixtureEnv(root), () => {
    const location = resolveGitLocation(root);
    assert.equal(location.state, 'work-tree', location.cause);
    assert.deepEqual([location.top, location.gitDir, location.commonDir], [root, join(root, '.git'), join(root, '.git')]);
    return run(root);
  });
};
const encodeList = (paths = [FIXTURE], reason = REASON) => Buffer.from(JSON.stringify({
  schema: 1, entries: paths.map((path) => ({ path, reason })),
}));
const writeList = (root, bytes = encodeList()) => writeFileSync(join(root, LIST), bytes);
const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const storeOf = (root) => join(root, '.git/agent-workflow-core-evidence.jsonl');
const finalRecords = (root) => existsSync(storeOf(root))
  ? readFileSync(storeOf(root), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
const latestFinal = (root) => finalRecords(root).filter((record) => record.kind === 'final').at(-1);
const runFinal = (root, extraEnv = {}, spawn = spawnGateViaBash) => {
  const output = [];
  const env = fixtureEnv(root, extraEnv);
  const code = withEnv(env, () => runCli(['--final', '--cwd', root], {
    env, spawn, log: (line) => output.push(String(line)), logError: (line) => output.push(String(line)),
  }));
  return { code, output: output.join('\n') };
};
const listLines = (output) => output.split('\n').filter((line) => line.startsWith(PREFIX));
const assertGreenFinal = (root, result) => {
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /\[run-gates\] status=ok\b/);
  assert.equal(latestFinal(root).status, 'green');
};
const assertGuardRefusal = (root) => {
  const result = runGuard({ cwd: root, env: fixtureEnv(root) });
  assert.equal(result.code, 1, result.lines.join('\n'));
  assert.equal(result.lines.length, 1);
  assert.ok(result.lines[0].startsWith(GUARD_REFUSAL), result.lines[0]);
};

it('a hand-written list permits a copied fixture and binds the guarded commit (spec:coverage-declared/S2)', (context) => withRepo(context, (root) => {
  writeFileSync(join(root, FIXTURE), `${SOURCE}export const added = 2;\n`);
  runGit(root, ['add', '-A']);
  const bytes = encodeList();
  writeList(root, bytes);
  const result = runFinal(root);
  assertGreenFinal(root, result);
  assert.ok(result.output.includes('coverage-check: PASS — 1 listed file(s) not judged; every other changed Node line is covered'));
  assert.deepEqual(listLines(result.output), [`${PREFIX}not judged, no executed line in the coverage data: ${FIXTURE} — ${REASON}`]);
  assert.equal(latestFinal(root).evidenceHashes.coverageDeclared, hashBytes(bytes));
  const guard = runGuard({ cwd: root, env: fixtureEnv(root) });
  assert.equal(guard.code, 0, guard.lines.join('\n'));
}));

it('no list preserves checker bytes, receipt fields and exit codes (spec:coverage-declared/S10)', (context) => withRepo(context, (root) => {
  const checkerOutput = [];
  const result = runFinal(root, {}, (command, cwd, env) => {
    const answer = spawnGateViaBash(command, cwd, env);
    if (command === CANONICAL[1].cmd) checkerOutput.push(String(answer.stdout));
    return answer;
  });
  assertGreenFinal(root, result);
  const lcov = readFileSync(join(root, '.git', checker.LCOV_BASENAME));
  assert.deepEqual(checkerOutput, [`coverage-check: lcov-sha256=${hashBytes(lcov)}\ncoverage-check: attested=yes\n${PASS}\n`]);
  assert.deepEqual(listLines(result.output), []);
  assert.doesNotMatch(checkerOutput.join(''), /coverage-declared/);
  assert.deepEqual(Object.keys(latestFinal(root).evidenceHashes).sort(), ['degrade', 'redProof']);
  assert.equal(runGuard({ cwd: root, env: fixtureEnv(root) }).code, 0);
}));

describe('every list line reaches the runner once (spec:coverage-declared/S12)', () => {
  const lines = [`${PREFIX}names no file of this tree: gone.mjs`,
    `${PREFIX}not judged, no executed line in the coverage data: ${FIXTURE} — ${REASON}`,
    `${PREFIX}did not apply, the coverage data shows an executed line: pending.mjs`,
    `${PREFIX}1 listed file(s) unchanged, not looked up`];
  const stdout = ['other output', lines[0], `  ${PREFIX}indented`, ...lines.slice(1), PASS, ''].join('\n');
  const runPlain = (root, command, status) => {
    const output = [];
    const results = runGates([{ id: 'cc', title: 'cc', cmd: command }], { cwd: root,
      spawn: () => ({ status, stdout, stderr: '' }), now: () => 0, log: (line) => output.push(line) });
    assert.equal(results[0].code, status);
    return output;
  };
  for (const form of ['canonical', 'tab', 'copy']) it(`a green plain ${form} checker echoes only prefix lines after PASS`, (context) => {
    const root = makeDirectory(context);
    const copy = join(root, 'coverage-check.mjs');
    if (form === 'copy') cpSync(join(TOOLS, 'coverage-check.mjs'), copy);
    const command = form === 'copy' ? `node "${copy}" --check`
      : form === 'tab' ? CANONICAL[1].cmd.replace('node ', 'node\t') : CANONICAL[1].cmd;
    assert.deepEqual(runPlain(root, command, 0), ['── cc — cc', '   PASS (0.0s)', ...lines]);
  });
  it('a red plain checker prints its whole output once', (context) => {
    assert.deepEqual(runPlain(makeDirectory(context), CANONICAL[1].cmd, 1),
      ['── cc — cc', '   FAIL exit=1 (0.0s)', stdout.slice(0, -1)]);
  });
  it('a real final checker prints every list line once', (context) => withRepo(context, (root) => {
    writeList(root, encodeList(['gone.mjs', FIXTURE, 'pending.mjs']));
    const result = runFinal(root);
    assertGreenFinal(root, result);
    assert.deepEqual(listLines(result.output), [lines[0], lines[2], lines[3]]);
  }));
});

describe('the guard refuses a moved ignored list at the same fingerprint (spec:coverage-declared/S13)', () => {
  for (const change of ['created', 'edited', 'deleted']) it(`the ignored list is ${change} after a green final`, (context) => withRepo(context, (root) => {
    if (change !== 'created') writeList(root);
    assertGreenFinal(root, runFinal(root));
    const before = computeTreeFingerprint(root);
    assert.match(before, /^[0-9a-f]{64}$/);
    if (change === 'deleted') rmSync(join(root, LIST));
    else writeList(root, encodeList([FIXTURE], 'A different reason.'));
    assert.equal(computeTreeFingerprint(root), before);
    assertGuardRefusal(root);
  }));
});

it('a bound two-entry list appears in the guard pass line (spec:coverage-declared/S14)', (context) => withRepo(context, (root) => {
  writeList(root, encodeList([FIXTURE, 'pending.mjs']));
  assertGreenFinal(root, runFinal(root));
  const guard = runGuard({ cwd: root, env: fixtureEnv(root) });
  assert.equal(guard.code, 0, guard.lines.join('\n'));
  assert.ok(guard.lines[0].includes(` — declared coverage list ${LIST} bound, 2 entr(ies)`), guard.lines[0]);
}));

it('an earlier receipt without the field stands only with no list (spec:coverage-declared/S15)', (context) => withRepo(context, (root) => {
  writeList(root);
  assertGreenFinal(root, runFinal(root));
  const records = finalRecords(root);
  delete records.findLast((record) => record.kind === 'final').evidenceHashes.coverageDeclared;
  writeFileSync(storeOf(root), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  rmSync(join(root, LIST));
  assert.equal(runGuard({ cwd: root, env: fixtureEnv(root) }).code, 0);
  writeList(root);
  assertGuardRefusal(root);
}));

it('a gate replacing the start list is refused by the checker (spec:coverage-declared/S16)', (context) => withRepo(context, (root) => {
  writeList(root);
  const replacement = encodeList([FIXTURE], 'Replaced during the unit-tests gate.').toString();
  const producer = { ...UNIT_TESTS, cmd: `printf '%s' '${replacement}' > '${LIST}' && ${UNIT_TESTS.cmd}` };
  writeFileSync(join(root, 'docs/ai/gates.json'), JSON.stringify({ gates: [producer, ...CANONICAL] }));
  runGit(root, ['add', '-A']);
  const result = runFinal(root);
  assert.notEqual(result.code, 0, result.output);
  assert.ok(result.output.split('\n').includes('coverage-check: attested=no'), result.output);
  assert.ok(result.output.split('\n').some((line) => line.startsWith(CHECKER_REFUSAL)), result.output);
  assert.equal(latestFinal(root).status, 'red');
}));

it('a list rewritten after the checker reddens the receipt (spec:coverage-declared/S17)', (context) => withRepo(context, (root) => {
  writeList(root);
  const checkerPassed = [];
  const result = runFinal(root, {}, (command, cwd, env) => {
    const answer = spawnGateViaBash(command, cwd, env);
    if (command === CANONICAL[1].cmd) {
      checkerPassed.push(answer.status);
      writeList(root, encodeList([FIXTURE], 'Replaced after the checker returned.'));
    }
    return answer;
  });
  assert.deepEqual(checkerPassed, [0]);
  assert.equal(result.code, 8, result.output);
  assert.equal(latestFinal(root).status, 'red');
  assert.equal(declared.DECLARED_MOVED_FAILURE, MOVED);
  assert.ok(latestFinal(root).integrityFailure.includes(MOVED));
}));

describe('one capability list governs every child environment (spec:coverage-declared/S19)', () => {
  it('the exported frozen list and the runner share exactly four names', () => {
    assert.equal(checker.ATTEST_DECLARED_ENV, DECLARED_ENV);
    assert.deepEqual(checker.ATTEST_ENV_VARS, ATTEST_NAMES);
    assert.equal(Object.isFrozen(checker.ATTEST_ENV_VARS), true);
    assert.equal(RESERVED_CAPABILITY_ENV, checker.ATTEST_ENV_VARS);
  });
  it('withoutAttestEnv removes the fourth name without mutating its input', () => {
    const env = { PATH: '/fixture/bin', ...Object.fromEntries(ATTEST_NAMES.map((name) => [name, 'host'])) };
    assert.deepEqual(checker.withoutAttestEnv(env), { PATH: '/fixture/bin' });
    assert.equal(env[DECLARED_ENV], 'host');
  });
  it('a real gate child receives no host-set declared attestation', (context) => {
    const root = makeDirectory(context);
    const result = withEnv(fixtureEnv(root, { [DECLARED_ENV]: 'host' }), () =>
      spawnGateViaBash(`"${process.execPath}" -p 'JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("AW_FINAL_ATTEST_"))))'`, root));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  });
  it('a real direct checker leaves none of the four names to its git child', (context) => {
    const root = makeDirectory(context);
    const seen = join(root, 'seen.txt');
    writeFileSync(join(root, 'git'), `#!/bin/sh\nprintf 'CALLED\\n' >> '${seen}'\nfor name in ${ATTEST_NAMES.join(' ')}; do\n  printenv "$name" >/dev/null && printf 'LEAKED:%s\\n' "$name" >> '${seen}'\ndone\nexit 1\n`, { mode: 0o755 });
    const env = fixtureEnv(root, { PATH: `${root}:${process.env.PATH}`,
      ...Object.fromEntries(ATTEST_NAMES.map((name) => [name, 'host'])) });
    const result = spawnSync(process.execPath, [join(TOOLS, 'coverage-check.mjs'), '--check', '--cwd', root],
      { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    const observed = readFileSync(seen, 'utf8');
    assert.match(observed, /CALLED/);
    assert.doesNotMatch(observed, /LEAKED:/);
  });
});

describe('final preflight refuses unreadable lists and redirected git (spec:coverage-declared/S20)', () => {
  for (const kind of ['FIFO', 'symlink', 'UTF-8']) it(`a ${kind} list refuses before final-start`, (context) => withRepo(context, (root) => {
    const path = join(root, LIST);
    if (kind === 'FIFO') {
      const result = spawnSync('mkfifo', [path], { env: fixtureEnv(root), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    } else if (kind === 'symlink') {
      const target = join(root, '.git/list-target.json');
      writeFileSync(target, encodeList());
      symlinkSync(target, path);
    } else writeFileSync(path, Buffer.from([0xff]));
    const result = runFinal(root);
    assert.equal(result.code, 8, result.output);
    assert.ok(result.output.includes(LIST), result.output);
    assert.ok(result.output.includes(kind), result.output);
    assert.equal(finalRecords(root).some((record) => record.kind === 'final-start'), false);
  }));
  it('GIT_DIR redirect refuses before deleting the foreign stale lcov', (context) => withRepo(context, (root) => {
    const foreign = makeDirectory(context);
    cpSync(buildTemplate(), foreign, { recursive: true });
    const stale = join(foreign, '.git', checker.LCOV_BASENAME);
    writeFileSync(stale, 'stale lcov must survive\n');
    const env = fixtureEnv(root, { GIT_DIR: join(foreign, '.git') });
    const location = resolveGitLocation(root, { env });
    assert.equal(location.state, 'redirected');
    const result = runFinal(root, { GIT_DIR: env.GIT_DIR });
    assert.equal(result.code, 1, result.output);
    assert.ok(result.output.includes(location.state), result.output);
    assert.equal(readFileSync(stale, 'utf8'), 'stale lcov must survive\n');
    assert.deepEqual(finalRecords(root), []);
    assert.deepEqual(finalRecords(foreign), []);
  }));
});
