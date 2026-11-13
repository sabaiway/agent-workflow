import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { makeFixtureRepo } from '../../../scripts/testing/fixture-repo.mjs';
import { GIT_MAX_BUFFER, hermeticGitEnv, resolveGitLocation, stripGitLocationEnv } from '../git-env.mjs';
import { computeTreeFingerprint, resolveBase } from '../core-evidence.mjs';
import {
  main, commitmentFor, ATTEST_NONCE_ENV, ATTEST_FINGERPRINT_ENV, ATTEST_BASE_ENV,
} from '../coverage-check.mjs';
import { main as guardMain } from '../commit-guard.mjs';
import { runCli } from '../run-gates.mjs';
import { commandFor } from '../commands.mjs';
import { BINDINGS, checkParity } from '../doc-parity.mjs';
import { isLineUnsafe } from '../source-size-refusal.mjs';
import { judgeBlock } from '../checker-verdict/index.mjs';

const declared = await import('./index.mjs').catch(() => ({}));
const LIST = 'docs/ai/coverage-declared.json';
const PREFIX = 'coverage-check: declared list — ';
const DECLARED_ENV = 'AW_FINAL_ATTEST_DECLARED';
const SHAPE = '{ "schema": 1, "_README"?: string, "entries": [{ "path": string, "reason": string }, ...] }';
const FIXTURE = 'copied-fixture.mjs';
const SECOND_FIXTURE = 'second-fixture.mjs';
const STABLE = 'stable.mjs';
const COVERED = 'covered.mjs';
const REASON = 'Copied to a temporary directory and tested there.';
const SOURCE = 'export const first = 1;\nexport const second = 2;\nexport const third = 3;\n';
const SOURCE_LINES = [1, 2, 3];
const PASS = 'coverage-check: PASS — every changed Node line is covered';
const REPO_TEMPLATE = { root: null };
after(() => { if (REPO_TEMPLATE.root) rmSync(REPO_TEMPLATE.root, { recursive: true, force: true }); });

const fixtureEnv = (home, extra = {}) => ({
  ...hermeticGitEnv(Object.fromEntries(Object.entries(stripGitLocationEnv(process.env))
    .filter(([name]) => !name.startsWith('AW_') && name !== 'NODE_TEST_CONTEXT')), home),
  ...extra,
});
const runGit = (root, args) => {
  const result = spawnSync('git', args, {
    cwd: root, env: fixtureEnv(root), encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, `git ${args.join(' ')}: signal ${result.signal}`);
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
};
const buildTemplate = () => {
  if (REPO_TEMPLATE.root) return REPO_TEMPLATE.root;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'declared-checker-template-')));
  try {
    makeFixtureRepo((args) => runGit(root, args), root, ['-q']);
    runGit(root, ['config', 'user.name', 'coder-tool']);
    runGit(root, ['config', 'user.email', 'coder-tools@proton.me']);
    writeFileSync(join(root, '.gitignore'), `${LIST}\n`);
    writeFileSync(join(root, STABLE), SOURCE);
    runGit(root, ['add', '-A']);
    runGit(root, ['commit', '-qm', 'base']);
    REPO_TEMPLATE.root = root;
    return root;
  } finally {
    if (!REPO_TEMPLATE.root) rmSync(root, { recursive: true, force: true });
  }
};
const withRepo = (run) => {
  const template = buildTemplate();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'declared-checker-')));
  const ambient = process.env;
  try {
    cpSync(template, root, { recursive: true });
    process.env = fixtureEnv(root);
    const location = resolveGitLocation(root);
    assert.equal(location.state, 'work-tree', location.cause);
    assert.deepEqual([location.top, location.gitDir, location.commonDir], [root, join(root, '.git'), join(root, '.git')]);
    writeFileSync(join(root, FIXTURE), SOURCE);
    return run(root);
  } finally {
    process.env = ambient;
    rmSync(root, { recursive: true, force: true });
  }
};
const encodeList = (paths) => Buffer.from(JSON.stringify({ schema: 1,
  entries: paths.map((path) => ({ path, reason: REASON })) }));
const writeList = (root, bytes) => {
  mkdirSync(join(root, 'docs/ai'), { recursive: true });
  writeFileSync(join(root, LIST), bytes);
};
const lcovFor = (root, path, covered = SOURCE_LINES) =>
  `SF:${join(root, path)}\n${SOURCE_LINES.map((line) => `DA:${line},${covered.includes(line) ? 1 : 0}`).join('\n')}\nend_of_record\n`;
const writeLcov = (root, text) => writeFileSync(join(root, '.git/agent-workflow-lcov.info'), text);
const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const recordStart = (root, handed) => {
  const nonce = '0123456789abcdef';
  const fingerprint = computeTreeFingerprint(root);
  const base = resolveBase(root);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(base);
  writeFileSync(join(root, '.git/agent-workflow-core-evidence.jsonl'), `${JSON.stringify({
    schema: 1, kind: 'final-start', fingerprint,
    attempt: commitmentFor(nonce, fingerprint, base), timestamp: '2026-11-12T00:00:00Z',
  })}\n`);
  return fixtureEnv(root, {
    [ATTEST_NONCE_ENV]: nonce, [ATTEST_FINGERPRINT_ENV]: fingerprint, [ATTEST_BASE_ENV]: base,
    ...(handed === undefined ? {} : { [DECLARED_ENV]: handed }),
  });
};
const check = (root, env = fixtureEnv(root)) => main(['--check', '--cwd', root], { env });
const outputLines = (result) => result.stdout.split('\n');
const listLines = (result) => outputLines(result).filter((line) => line.startsWith(PREFIX));
const assertMachineLines = (result, attested) => {
  assert.equal(result.stderr, '');
  assert.deepEqual(outputLines(result).filter((line) => line.startsWith('coverage-check: attested=')),
    [`coverage-check: attested=${attested}`]);
  assert.equal(outputLines(result).filter((line) => /^coverage-check: lcov-sha256=([0-9a-f]{64}|none)$/.test(line)).length, 1);
};

it('an unlisted copied fixture keeps the absent-from-coverage failure (spec:coverage-declared/S3)', () => withRepo((root) => {
  writeLcov(root, lcovFor(root, STABLE));
  const result = check(root, recordStart(root, 'none'));
  assert.equal(result.code, 1, result.stdout);
  assertMachineLines(result, 'yes');
  assert.deepEqual(outputLines(result).filter((line) => line.startsWith(`${FIXTURE}: `)),
    [`${FIXTURE}: absent from coverage — the suite never executed this changed file`]);
  assert.deepEqual(judgeBlock(result.stdout, { name: 'coverage-check', places: [FIXTURE] }), []);
  assert.doesNotMatch(result.stdout, /^coverage-check: FAIL — uncovered\/unattributed changed Node lines:/m);
  assert.doesNotMatch(result.stdout, /^  |REFUSED|coverage-check: PASS/m);
  assert.equal(outputLines(result).some((line) => line.includes('coverage-declared') || line.startsWith(PREFIX)), false);
}));

it('a listed fixture executed in place fails its uncovered changed lines (spec:coverage-declared/S4)', () => withRepo((root) => {
  const bytes = encodeList([FIXTURE]);
  writeList(root, bytes);
  writeLcov(root, lcovFor(root, FIXTURE, [1]));
  const result = check(root, recordStart(root, hashBytes(bytes)));
  assert.equal(result.code, 1, result.stdout);
  assertMachineLines(result, 'yes');
  const places = [2, 3].map((line) => `${FIXTURE}:${line}`);
  assert.deepEqual(outputLines(result).filter((line) => line.startsWith(`${FIXTURE}:`) && /:\d+: .+/.test(line))
    .map((line) => line.split(': ')[0]), places);
  assert.deepEqual(judgeBlock(result.stdout, { name: 'coverage-check', places }), []);
  assert.doesNotMatch(result.stdout, /^coverage-check: FAIL — uncovered\/unattributed changed Node lines:/m);
  assert.doesNotMatch(result.stdout, /^  |REFUSED|coverage-check: PASS/m);
  assert.deepEqual(listLines(result), [`${PREFIX}did not apply, the coverage data shows an executed line: ${FIXTURE}`]);
  assert.ok(outputLines(result).indexOf(listLines(result)[0]) > outputLines(result)
    .findLastIndex((line) => line.startsWith('coverage-check: REMEDY — ')));
}));

describe('malformed lists fail even without lcov (spec:coverage-declared/S7)', () => {
  const entry = { path: FIXTURE, reason: REASON };
  const cases = [
    ['not JSON', '{broken', 'JSON'],
    ['a JSON array', '[]', null],
    ['an unknown key', JSON.stringify({ schema: 1, entries: [], unexpected: true }), 'unexpected'],
    ['schema 2', JSON.stringify({ schema: 2, entries: [] }), 'schema'],
    ['an entry that is not an object', JSON.stringify({ schema: 1, entries: [null] }), 'entries'],
    ['an entry with an extra key', JSON.stringify({ schema: 1, entries: [{ ...entry, unexpected: true }] }), 'unexpected'],
  ];
  for (const [name, bytes, keyword] of cases) it(name, () => withRepo((root) => {
    writeList(root, bytes);
    const result = check(root);
    assert.equal(result.code, 1, result.stdout);
    assert.equal(result.stderr, '');
    const failures = outputLines(result).filter((line) => line.startsWith('coverage-check: FAIL'));
    assert.equal(failures.length, 1, result.stdout);
    assert.ok(!failures[0].startsWith(`coverage-check: FAIL — ${LIST}:`), failures[0]);
    const findings = outputLines(result).filter((line) => line.startsWith(`${LIST}: `));
    assert.equal(findings.length, 1, result.stdout);
    const defect = findings[0].slice(`${LIST}: `.length);
    assert.deepEqual(judgeBlock(result.stdout, { name: 'coverage-check', places: [LIST] }), []);
    assert.equal(defect, declared.parseDeclaredList(Buffer.from(bytes)).defect);
    assert.ok(defect.length > 0);
    assert.equal(isLineUnsafe(defect), false);
    if (keyword) assert.ok(defect.toLowerCase().includes(keyword.toLowerCase()), defect);
    assert.ok(defect.includes(SHAPE), defect);
    assertMachineLines(result, 'no');
    assert.doesNotMatch(result.stdout, /^  |REFUSED|coverage-check: PASS/m);
    assert.deepEqual(listLines(result), []);
    assert.match(result.stdout, /skipped-no-lcov/);
  }));
});

describe('the pass line counts applied entries (spec:coverage-declared/S11)', () => {
  it('two applied entries name 2 and every other changed Node line', () => withRepo((root) => {
    writeFileSync(join(root, SECOND_FIXTURE), SOURCE);
    writeFileSync(join(root, COVERED), SOURCE);
    const bytes = encodeList([FIXTURE, SECOND_FIXTURE]);
    writeList(root, bytes);
    writeLcov(root, lcovFor(root, COVERED));
    const result = check(root, recordStart(root, hashBytes(bytes)));
    assert.equal(result.code, 0, result.stdout);
    assertMachineLines(result, 'yes');
    assert.deepEqual(listLines(result), [FIXTURE, SECOND_FIXTURE]
      .map((path) => `${PREFIX}not judged, no executed line in the coverage data: ${path} — ${REASON}`));
    assert.deepEqual(outputLines(result).filter((line) => line.startsWith('coverage-check: PASS')),
      ['coverage-check: PASS — 2 listed file(s) not judged; every other changed Node line is covered']);
  }));
  it('an unchanged entry leaves the existing pass line', () => withRepo((root) => {
    const bytes = encodeList([STABLE]);
    writeList(root, bytes);
    writeLcov(root, lcovFor(root, FIXTURE));
    const result = check(root, recordStart(root, hashBytes(bytes)));
    assert.equal(result.code, 0, result.stdout);
    assertMachineLines(result, 'yes');
    assert.deepEqual(listLines(result), [`${PREFIX}1 listed file(s) unchanged, not looked up`]);
    assert.deepEqual(outputLines(result).filter((line) => line.startsWith('coverage-check: PASS')), [PASS]);
  }));
});

describe('the checker binds the declared attestation with a nonce (spec:coverage-declared/S18)', () => {
  const cases = [
    ['the fourth variable is missing', false, undefined],
    ['the fourth variable is xyz', false, 'xyz'],
    ['the fourth variable is 63 hex characters', false, 'a'.repeat(63)],
    ['the fourth variable is upper-case hex', false, 'A'.repeat(64)],
    ['none is handed beside a list', true, 'none'],
    ['a hash is handed beside no list', false, 'a'.repeat(64)],
  ];
  for (const [name, present, handed] of cases) it(name, () => withRepo((root) => {
    if (present) writeList(root, encodeList([]));
    writeLcov(root, lcovFor(root, FIXTURE));
    const result = check(root, recordStart(root, handed));
    assert.equal(result.code, 1, result.stdout);
    assertMachineLines(result, 'no');
    const displayedHanded = handed === undefined ? 'no value' : handed === 'none' ? 'none'
      : /^[0-9a-f]{64}$/.test(handed) ? handed.slice(0, 12) : 'a malformed value';
    const displayedRead = present ? hashBytes(encodeList([])).slice(0, 12) : 'none';
    assert.deepEqual(outputLines(result).filter((line) => line.startsWith('.: ')),
      [`.: the declared coverage list is not the one the final run started with (${displayedHanded} handed, ${displayedRead} read); re-run run-gates.mjs --final`]);
    assert.deepEqual(judgeBlock(result.stdout, { name: 'coverage-check', places: ['.'] }), []);
    assert.doesNotMatch(result.stdout, /^  |REFUSED/m);
    assert.equal(outputLines(result).some((line) => line.startsWith('coverage-check: PASS')), false);
  }));
  for (const present of [false, true]) it(present ? 'the matching list hash attests' : 'none beside no list attests', () => withRepo((root) => {
    const bytes = encodeList([]);
    if (present) writeList(root, bytes);
    writeLcov(root, lcovFor(root, FIXTURE));
    const result = check(root, recordStart(root, present ? hashBytes(bytes) : 'none'));
    assert.equal(result.code, 0, result.stdout);
    assertMachineLines(result, 'yes');
    assert.deepEqual(outputLines(result).filter((line) => line.startsWith('coverage-check: PASS')), [PASS]);
  }));
  it('without a nonce garbage is ignored exactly as an omitted variable', () => withRepo((root) => {
    writeList(root, encodeList([FIXTURE]));
    writeLcov(root, lcovFor(root, STABLE));
    const baseline = check(root);
    const garbage = check(root, fixtureEnv(root, { [DECLARED_ENV]: 'garbage' }));
    assert.deepEqual(garbage, baseline);
    assert.equal(garbage.code, 0, garbage.stdout);
    assertMachineLines(garbage, 'no');
    assert.deepEqual(listLines(garbage), [`${PREFIX}not judged, no executed line in the coverage data: ${FIXTURE} — ${REASON}`]);
    assert.equal(outputLines(garbage).some((line) => line.startsWith('coverage-check: PASS')), false);
  }));
});

describe('checker texts and the path binding stay current (spec:coverage-declared/S21)', () => {
  for (const [name, help] of [['checker', main], ['guard', guardMain]]) it(`${name} help names the list`, () => {
    const result = help(['--help'], { env: fixtureEnv(tmpdir()) });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.includes(LIST), result.stdout);
  });
  it('runner usage names the list', () => {
    const lines = [];
    const code = runCli(['--help'], { env: fixtureEnv(tmpdir()), log: (line) => lines.push(line) });
    assert.equal(code, 0);
    assert.ok(lines.join('\n').includes(LIST), lines.join('\n'));
  });
  for (const mode of ['coverage-check', 'gates', 'commit-guard']) it(`${mode} mode names the backticked list path`, () => {
    const text = readFileSync(new URL(`../../references/modes/${mode}.md`, import.meta.url), 'utf8');
    assert.ok(text.includes(`\`${LIST}\``), text);
  });
  it('the coverage-check command catalog entry says not judged', () => {
    assert.ok(commandFor('coverage-check').oneLine.includes('not judged'));
  });
  it('coverage-declared-rel binds the live path in all three modes and checkParity accepts it', () => {
    const binding = BINDINGS.find((item) => item.constant === 'coverage-declared-rel');
    assert.ok(binding, 'coverage-declared-rel binding exists');
    const { COVERAGE_DECLARED_REL } = declared;
    assert.equal(COVERAGE_DECLARED_REL, LIST);
    assert.equal(binding.value, COVERAGE_DECLARED_REL);
    assert.equal(binding.token, `\`${LIST}\``);
    assert.deepEqual([...binding.files].sort(), ['commit-guard', 'coverage-check', 'gates']
      .map((mode) => `references/modes/${mode}.md`));
    const results = checkParity([binding]);
    assert.equal(results.length, 1);
    assert.equal(results[0].constant, 'coverage-declared-rel');
    assert.equal(results[0].ok, true, JSON.stringify(results[0]));
    assert.equal(results[0].files.length, 3);
    assert.ok(results[0].files.every((file) => file.ok));
  });
});
