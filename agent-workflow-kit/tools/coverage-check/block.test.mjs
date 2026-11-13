import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs, { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { computeTreeFingerprint, resolveBase } from '../core-evidence.mjs';
import { makeFixtureRepo } from '../../../scripts/testing/fixture-repo.mjs';
import { faultEnvironment, readFaultMarks } from '../checker-verdict/fault-harness.test.mjs';
import { GIT_MAX_BUFFER, hermeticGitEnv, stripGitLocationEnv } from '../git-env.mjs';

const { main, LCOV_BASENAME, commitmentFor, ATTEST_NONCE_ENV, ATTEST_FINGERPRINT_ENV, ATTEST_BASE_ENV, ATTEST_DECLARED_ENV } = await import('../coverage-check.mjs').catch(() => ({}));
const { runCheckerTail } = await import('../checker-block/index.mjs').catch(() => ({}));
const { judgeBlock } = await import('../checker-verdict/index.mjs').catch(() => ({}));
const ENTRY = fileURLToPath(new URL('../coverage-check.mjs', import.meta.url));
const NAME = 'coverage-check';
const FAIL = `${NAME}: FAIL \u2014 `;
const REMEDY = `${NAME}: REMEDY \u2014 `;
const DIGEST = `${NAME}: lcov-sha256=`;
const ATTESTED = `${NAME}: attested=`;
const NO_VERDICT = `${NAME}: NO VERDICT \u2014 `;
const LIST = 'docs/ai/coverage-declared.json';
const LIST_PREFIX = `${NAME}: declared list \u2014 `;
const REASON = 'Copied elsewhere for testing.';
const SOURCE = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n';
const SOURCE_LINES = [1, 2, 3];
const CLASSES = ['declared list', 'lcov file', 'uncovered', 'red-proof', 'evidence store', 'attestation context'];
const NO_CONTEXT = `${NO_VERDICT}no final-run attestation context \u2014 a verdict is issued only inside the run that owns the lcov (run-gates.mjs --final); findings below are informational`;
const NO_BYTES = `${NO_VERDICT}no lcov bytes were read at the checked path, so no verdict could be issued \u2014 a run that read nothing certifies nothing; if no gate produces the file, declare a coverage PRODUCER beside the checker (references/modes/gates.md names the exact form)`;
const TEMPLATE = { root: null };
after(() => { if (TEMPLATE.root) rmSync(TEMPLATE.root, { recursive: true, force: true }); });
const fixtureEnv = (root, extra = {}) => ({
  ...hermeticGitEnv(Object.fromEntries(Object.entries(stripGitLocationEnv(process.env))
    .filter(([key]) => !key.startsWith('AW_') && key !== 'NODE_TEST_CONTEXT')), root), ...extra,
});
const runGit = (root, args) => {
  const result = spawnSync('git', args, { cwd: root, env: fixtureEnv(root), encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
};
const tempDirectory = (test) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coverage-block-')));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const makeRepo = (test) => {
  if (!TEMPLATE.root) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'coverage-block-template-')));
    try {
      makeFixtureRepo((args) => runGit(root, args), root, ['-q']);
      runGit(root, ['config', 'user.name', 'coder-tool']);
      runGit(root, ['config', 'user.email', 'coder-tools@proton.me']);
      writeFileSync(join(root, '.gitignore'), `${LIST}\n`);
      writeFileSync(join(root, 'base.txt'), 'base\n');
      runGit(root, ['add', '-A']);
      runGit(root, ['commit', '-qm', 'base']);
      TEMPLATE.root = root;
    } finally { if (!TEMPLATE.root) rmSync(root, { recursive: true, force: true }); }
  }
  const root = tempDirectory(test);
  cpSync(TEMPLATE.root, root, { recursive: true });
  writeFileSync(join(root, 'lib.mjs'), SOURCE);
  const ambient = process.env;
  process.env = fixtureEnv(root);
  test.after(() => { process.env = ambient; });
  return root;
};
const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const lcovFor = (root, covered = SOURCE_LINES, file = 'lib.mjs') =>
  `SF:${join(root, file)}\n${SOURCE_LINES.map((line) => `DA:${line},${covered.includes(line) ? 1 : 0}`).join('\n')}\nend_of_record\n`;
const lcovPath = (root) => join(root, '.git', LCOV_BASENAME);
const writeLcov = (root, bytes = lcovFor(root)) => writeFileSync(lcovPath(root), bytes);
const storeOf = (root) => join(root, '.git/agent-workflow-core-evidence.jsonl');
const writeRecords = (root, records) => writeFileSync(storeOf(root), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
const redProofRecord = (root, file = 'lib.test.mjs', fileHash = 'a'.repeat(64)) => ({
  schema: 1, kind: 'red-proof', testId: `${file}#pinned case`, file, fileHash, runs: 1, reds: 1,
  base: resolveBase(root), fingerprint: 'b'.repeat(64), timestamp: '2026-11-13T00:00:00Z',
});
const writeList = (root, bytes) => {
  mkdirSync(join(root, 'docs/ai'), { recursive: true });
  writeFileSync(join(root, LIST), bytes);
};
const recordStart = (root, records = [], declared = 'none') => {
  const nonce = 'coverage-block-nonce';
  const fingerprint = computeTreeFingerprint(root);
  const base = resolveBase(root) ?? '';
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  writeRecords(root, [...records, { schema: 1, kind: 'final-start', fingerprint,
    attempt: commitmentFor(nonce, fingerprint, base), timestamp: '2026-11-13T00:00:00Z' }]);
  return fixtureEnv(root, { [ATTEST_NONCE_ENV]: nonce, [ATTEST_FINGERPRINT_ENV]: fingerprint,
    [ATTEST_BASE_ENV]: base, [ATTEST_DECLARED_ENV]: declared });
};
const check = (root, env = fixtureEnv(root)) => main(['--check', '--cwd', root], { env });
const runCommand = (args, cwd = tmpdir(), extra = {}) => {
  const result = spawnSync('node', [ENTRY, ...args], { cwd, env: fixtureEnv(cwd, extra), encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};
const linesOf = (stdout) => stdout.replace(/\n$/, '').split('\n');
const readBlock = (result, classes, places) => {
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.stderr, '');
  const lines = linesOf(result.stdout);
  assert.ok(lines[0].startsWith(FAIL), result.stdout);
  assert.equal(lines.filter((line) => line.startsWith(FAIL)).length, 1);
  assert.doesNotMatch(result.stdout, /\bREFUSED\b/);
  for (const noun of CLASSES) assert.equal(lines[0].split(noun).length - 1, classes.includes(noun) ? 1 : 0, lines[0]);
  assert.deepEqual([...classes].sort((a, b) => lines[0].indexOf(a) - lines[0].indexOf(b)), classes);
  const firstRemedy = lines.findIndex((line) => line.startsWith(REMEDY));
  assert.ok(firstRemedy > 1, result.stdout);
  const findings = lines.slice(1, firstRemedy);
  for (const line of findings) assert.ok(line.indexOf(': ') >= 0 && line.slice(line.indexOf(': ') + 2).length > 0, line);
  const ownPlaces = findings.map((line) => line.slice(0, line.indexOf(': ')));
  assert.deepEqual(ownPlaces, places);
  const remedies = lines.filter((line) => line.startsWith(REMEDY));
  assert.equal(remedies.length, classes.length);
  assert.deepEqual(lines.slice(firstRemedy, firstRemedy + remedies.length), remedies);
  const after = lines.slice(firstRemedy + remedies.length);
  assert.ok(after[0].startsWith(DIGEST));
  for (const prefix of [DIGEST, ATTESTED]) {
    assert.equal(lines.filter((line) => line.startsWith(prefix)).length, 1);
    assert.equal(after.filter((line) => line.startsWith(prefix)).length, 1);
  }
  assert.match(after[0], /^coverage-check: lcov-sha256=(?:[0-9a-f]{64}|none)$/);
  assert.match(after.find((line) => line.startsWith(ATTESTED)), /^coverage-check: attested=(?:yes|no)$/);
  assert.deepEqual(judgeBlock(result.stdout, { name: NAME, places: ownPlaces }), []);
  return { verdict: lines[0], findings, remedies, after };
};
const withFsFault = (test, method, path, fault, run) => {
  const original = fs[method];
  const mocked = test.mock.method(fs, method, (candidate, ...args) => {
    if (candidate === path) throw fault;
    return original(candidate, ...args);
  });
  syncBuiltinESMExports();
  try { return run(); } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
};

describe('spec:coverage-check/S1 each red class alone', () => {
  const cases = [
    ['malformed declared list', 0, [LIST]], ['tracked listed link', 0, ['linked.mjs']],
    ['lcov directory', 1, ['.git/agent-workflow-lcov.info']],
    ['lcov status EACCES', 1, ['.git/agent-workflow-lcov.info']],
    ['lcov status without code', 1, ['.git/agent-workflow-lcov.info']],
    ['relative AW_LCOV_FILE directory', 1], ['relative AW_CORE_EVIDENCE directory', 4],
    ['absent changed file', 2, ['lib.mjs']], ['uncovered changed line', 2, ['lib.mjs:2']],
    ['deleted bound test', 3, ['lib.test.mjs']],
    ['malformed evidence store', 4, ['.git/agent-workflow-core-evidence.jsonl']],
    ['another fingerprint', 5, ['.']],
  ];
  for (const [name, classIndex, places] of cases) it(name, (test) => {
    const root = makeRepo(test);
    writeLcov(root);
    const env = fixtureEnv(root);
    if (name === 'malformed declared list') writeList(root, '{broken');
    if (name === 'tracked listed link') {
      symlinkSync('base.txt', join(root, 'linked.mjs'));
      runGit(root, ['add', 'linked.mjs']);
      writeList(root, JSON.stringify({ schema: 1, entries: [{ path: 'linked.mjs', reason: REASON }] }));
    }
    if (name === 'lcov directory') { rmSync(lcovPath(root)); mkdirSync(lcovPath(root)); }
    if (name === 'absent changed file') writeLcov(root, lcovFor(root, SOURCE_LINES, 'other.mjs'));
    if (name === 'uncovered changed line') writeLcov(root, lcovFor(root, [1, 3]));
    if (name === 'deleted bound test') {
      writeFileSync(join(root, 'lib.test.mjs'), SOURCE);
      writeRecords(root, [redProofRecord(root, 'lib.test.mjs', hashBytes(SOURCE))]);
      rmSync(join(root, 'lib.test.mjs'));
    }
    if (name === 'malformed evidence store') writeFileSync(storeOf(root), 'not JSON\n');
    const external = name.startsWith('relative ') ? tempDirectory(test) : null;
    if (external) mkdirSync(join(external, 'directory'));
    const result = (() => {
      if (name.startsWith('relative ')) {
        const variable = name.includes('AW_LCOV_FILE') ? 'AW_LCOV_FILE' : 'AW_CORE_EVIDENCE';
        return runCommand(['--check', '--cwd', root], external, { [variable]: 'directory' });
      }
      if (name.startsWith('lcov status')) {
        const fault = name.endsWith('EACCES') ? Object.assign(new Error('denied'), { code: 'EACCES' }) : new Error('status failed without code');
        return withFsFault(test, 'lstatSync', lcovPath(root), fault, () => check(root, env));
      }
      return check(root, name === 'another fingerprint'
        ? { ...recordStart(root), [ATTEST_FINGERPRINT_ENV]: 'a'.repeat(64) } : env);
    })();
    const expectedPlaces = places ?? [join(external, 'directory')];
    const block = readBlock(result, [CLASSES[classIndex]], expectedPlaces);
    if (name === 'malformed declared list') { assert.match(block.findings[0], /JSON/); assert.doesNotMatch(block.findings[0], /FAIL \u2014/); }
    if (name === 'tracked listed link') assert.equal(block.findings[0], `linked.mjs: listed in ${LIST} but not a regular file`);
    if (name.startsWith('lcov status')) assert.ok(block.findings[0].includes(name.endsWith('EACCES') ? 'EACCES' : 'status failed without code'));
    if (name === 'deleted bound test') { assert.match(block.findings[0], /lib\.test\.mjs#pinned case/); assert.match(block.findings[0], /deleted|does not exist/); }
    if (name === 'malformed evidence store') assert.match(block.findings[0], /malformed/);
    if (classIndex === 2 || classIndex === 3) assert.match(block.verdict, /\b1\b/);
    if (name === 'another fingerprint') {
      assert.ok(block.after.at(-1).startsWith(ATTESTED));
      assert.equal(block.after.some((line) => line.startsWith(NO_VERDICT)), false);
    }
  });
});

describe('spec:coverage-check/S2 composes two classes in order', () => {
  for (const pair of ['uncovered and red-proof', 'declared list and uncovered']) it(pair, (test) => {
    const root = makeRepo(test);
    const declared = pair.startsWith('declared');
    const first = declared ? CLASSES[0] : CLASSES[2];
    const second = declared ? CLASSES[2] : CLASSES[3];
    const coverageBytes = declared ? lcovFor(root, SOURCE_LINES, 'other.mjs') : lcovFor(root, [1, 3]);
    const coveragePlace = declared ? 'lib.mjs' : 'lib.mjs:2';
    writeLcov(root, declared ? lcovFor(root) : coverageBytes);
    if (declared) writeList(root, '{broken');
    const firstAlone = readBlock(check(root), [first], [declared ? LIST : coveragePlace]);
    if (declared) rmSync(join(root, LIST));
    writeLcov(root, declared ? coverageBytes : lcovFor(root));
    if (!declared) writeRecords(root, [redProofRecord(root)]);
    const secondAlone = readBlock(check(root), [second], [declared ? coveragePlace : 'lib.test.mjs']);
    if (declared) writeList(root, '{broken');
    writeLcov(root, coverageBytes);
    const combined = readBlock(check(root), [first, second], declared ? [LIST, coveragePlace] : [coveragePlace, 'lib.test.mjs']);
    assert.deepEqual(combined.verdict.match(/\b\d+\b/g), declared ? ['1'] : ['1', '1']);
    assert.deepEqual(combined.findings, [...firstAlone.findings, ...secondAlone.findings]);
    assert.deepEqual(combined.remedies, [...firstAlone.remedies, ...secondAlone.remedies]);
  });
});

it('spec:coverage-check/S3 preserves after-line order and withheld verdict texts', (test) => {
  const root = makeRepo(test);
  writeFileSync(join(root, 'hook.sh'), '#!/bin/sh\n');
  writeFileSync(join(root, 'copied.mjs'), SOURCE);
  const list = JSON.stringify({ schema: 1, entries: [{ path: 'copied.mjs', reason: REASON }] });
  writeList(root, list);
  const greenTest = "import { test } from 'node:test';\ntest('pinned case', () => {});\n";
  writeFileSync(join(root, 'lib.test.mjs'), greenTest);
  const record = redProofRecord(root, 'lib.test.mjs', hashBytes(greenTest));
  writeLcov(root, lcovFor(root, [1, 3]));
  const env = { ...recordStart(root, [record], hashBytes(list)), AW_CORE_EVIDENCE_RERUNS: '1' };
  const block = readBlock(check(root, env), [CLASSES[2]], ['lib.mjs:2']);
  assert.equal(block.after.length, 5);
  assert.ok(block.after[0].startsWith(DIGEST));
  assert.match(block.after[1], /out-of-domain.*hook\.sh/);
  assert.equal(block.after[2], `${LIST_PREFIX}not judged, no executed line in the coverage data: copied.mjs \u2014 ${REASON}`);
  assert.equal(block.after[3], `${NAME}: 1 red-proof record(s) verified green N/N with custody intact`);
  assert.equal(block.after[4], `${ATTESTED}yes`);
  const plain = readBlock(check(root, fixtureEnv(root, { AW_CORE_EVIDENCE_RERUNS: '1' })), [CLASSES[2]], ['lib.mjs:2']);
  assert.ok(plain.after.at(-1).startsWith(NO_VERDICT));
  assert.match(plain.after.at(-1), /\babove\b/);
  assert.doesNotMatch(plain.after.at(-1), /\bbelow\b/);
  rmSync(lcovPath(root));
  rmSync(join(root, 'lib.test.mjs'));
  const noBytes = readBlock(check(root, recordStart(root, [record], hashBytes(list))), [CLASSES[3]], ['lib.test.mjs']);
  assert.equal(noBytes.after.at(-1), NO_BYTES);
  rmSync(storeOf(root));
  writeLcov(root, lcovFor(root) + lcovFor(root, SOURCE_LINES, 'copied.mjs'));
  const green = check(root);
  assert.deepEqual([green.code, green.stderr, linesOf(green.stdout).at(-1)], [0, '', NO_CONTEXT]);
});

it('spec:coverage-check/S4 usage refusals print only verdict and help usage', () => {
  const help = runCommand(['--help']);
  assert.deepEqual([help.code, help.stderr], [0, '']);
  const helpLines = linesOf(help.stdout);
  const start = helpLines.indexOf('Usage:');
  assert.ok(start >= 0);
  const usage = helpLines.slice(start, helpLines.indexOf('', start));
  for (const args of [['--cwd'], ['--mystery'], ['--mystery\nnext']]) {
    const result = runCommand(args);
    assert.deepEqual([result.code, result.stderr], [2, '']);
    const lines = linesOf(result.stdout);
    assert.ok(lines[0].startsWith(FAIL));
    assert.ok(lines[0].includes(args[0] === '--cwd' ? '--cwd' : JSON.stringify(args[0])));
    assert.deepEqual(lines.slice(1), usage);
    assert.ok(result.stdout.endsWith('\n'));
  }
  assert.deepEqual(runCommand(['--help', '--mystery']), help);
});

describe('spec:coverage-check/S5 unexpected errors have a guarded stdout block', () => {
  it('guards the failed lcov read through the tail', (test) => {
    const root = makeRepo(test);
    writeLcov(root);
    const fault = Object.assign(new Error(`EACCES: permission denied, open '${lcovPath(root)}'`), { code: 'EACCES' });
    const writes = [];
    const errors = [];
    const host = { stdout: { write: (text) => writes.push(text) }, stderr: { write: (text) => errors.push(text) } };
    const remedy = 'restore read access to the checked lcov file';
    const code = withFsFault(test, 'readFileSync', lcovPath(root), fault, () =>
      runCheckerTail({ name: NAME, exitCode: 1, remedy }, () => check(root), host));
    assert.deepEqual([code, host.exitCode, errors, writes.length], [1, 1, [], 1]);
    assert.deepEqual(linesOf(writes[0]), [`${FAIL}unexpected error: ${fault.message.split('\n')[0]}`, `${REMEDY}${remedy}`, ...fault.stack.split('\n')]);
    assert.doesNotMatch(writes[0], /^coverage-check: (?:lcov-sha256|attested)=/m);
  });
  it('guards the census read fault through the command line', (test) => {
    const root = makeRepo(test);
    writeLcov(root);
    const marks = join(tempDirectory(test), 'marks');
    const result = runCommand(['--check', '--cwd', root], root, faultEnvironment({ point: 'read', entry: ENTRY, marks }));
    assert.deepEqual([result.code, result.stderr], [1, '']);
    const lines = linesOf(result.stdout);
    assert.ok(lines[0].startsWith(`${FAIL}unexpected error: `));
    assert.ok(lines[0].includes('checker-verdict fault at read'));
    assert.ok(lines[1].startsWith(REMEDY));
    assert.doesNotMatch(result.stdout, /^coverage-check: (?:lcov-sha256|attested)=/m);
    assert.ok(readFaultMarks(marks).includes(ENTRY));
  });
});

const RECORDED_HELP = `coverage-check \u2014 the D3(c)+(d) final-run checker (agent-workflow family).

Usage:
  node coverage-check.mjs --check [--cwd <dir>]

Reads the FIXED kit-owned lcov file (<git dir>/agent-workflow-lcov.info; AW_LCOV_FILE overrides \u2014
produced by the declared unit-tests gate cmd's --experimental-test-coverage lcov reporters and
deleted fresh by run-gates --final), lists uncovered CHANGED executable Node lines file:line,
lists changed out-of-domain files (the coverage claim is narrowed to Node lines), and VERIFIES
every current-base red-proof record: bound test present, content hash unchanged, green N/N
(AW_CORE_EVIDENCE_RERUNS, default 3), pre-fix fingerprint differing from the current tree.
An absent lcov file (ENOENT) is a LOUD skipped-no-lcov (exit 0 \u2014 NO coverage check ran, stated).
Any other lcov status failure, a symlinked lcov path, an uncovered line, a broken red-proof
obligation, or a malformed evidence store fails (exit 1).
A changed file listed in docs/ai/coverage-declared.json (one { path, reason } entry per file nothing
runs at its repository path) with no executed line in the lcov read is not judged; it and every
other list line print on every run. An unreadable or malformed list fails (exit 1); with a context
the list must be the one the final run started with (AW_FINAL_ATTEST_DECLARED), else REFUSED.

A coverage VERDICT is issued ONLY inside the run that owns the artifact's lifetime: run-gates
--final deletes the lcov before any gate spawns and hands this checker an attestation context
(a nonce whose one-way commitment over {nonce, fingerprint, base} is the final-start attempt id).
One anchored machine line rides every run: coverage-check: attested=<yes|no>. It states whether a
coverage VERDICT was ISSUED \u2014 pass OR fail \u2014 never that coverage passed.
  attested=yes \u2192 a verdict was issued over the lcov BYTES this run read (a failing one still
                 exits 1); the predicate is the consumed digest, never the skip flag.
  attested=no  \u2192 NO VERDICT: no handshake, or no lcov bytes were read at all (an absent file or a
                 refused path \u2014 nothing read, nothing certified). Withholding a verdict never
                 changes an exit code: an absent lcov stays exit 0, a refused non-regular path
                 keeps its own fail-closed exit 1, and uncovered lines still exit 1. Findings are
                 still printed; run-gates carries the withheld verdict as coverage=not-run.
  REFUSED (exit 1) \u2192 the context describes another tree or another declared list, or matches no recorded attempt.
Residual, stated: ownership of the fixed path is CONVENTION, not enforcement \u2014 a concurrent writer
to it can still place foreign evidence (queued as LCOV-EXCLUSIVE-OWNERSHIP).

Sandbox-safe: no network; writes nothing; spawns read-only git queries and the bound-test
probes (node --test, shell-free) \u2014 the D4 sandbox lane. The attestation variables are consumed and
removed from this process's environment before anything spawns, so no child inherits the capability.
Read-only. Exit codes: 0 pass / no-verdict / skipped-loud; 1 fail or REFUSED; 2 usage.
`;

it('spec:coverage-check/S6 preserves the recorded green command-line runs', (test) => {
  const root = makeRepo(test);
  const bytes = lcovFor(root);
  writeLcov(root, bytes);
  const machine = `${DIGEST}${hashBytes(bytes)}\n`;
  const expectGreen = (result, stdout) => assert.deepEqual(result, { code: 0, stderr: '', stdout });
  expectGreen(runCommand(['--check', '--cwd', root], root, recordStart(root)),
    `${machine}${ATTESTED}yes\n${NAME}: PASS \u2014 every changed Node line is covered\n`);
  expectGreen(runCommand(['--check', '--cwd', root]), `${machine}${ATTESTED}no\n${NO_CONTEXT}\n`);
  rmSync(lcovPath(root));
  expectGreen(runCommand(['--check', '--cwd', root]), `${DIGEST}none\n${NAME}: skipped-no-lcov: no lcov file at ${realpathSync(root)}/.git/agent-workflow-lcov.info \u2014 NO coverage check ran (produce it via the declared unit-tests gate cmd's lcov reporters)\n${ATTESTED}no\n${NO_CONTEXT}\n`);
  const outside = tempDirectory(test);
  expectGreen(runCommand(['--check', '--cwd', outside], outside, { GIT_CEILING_DIRECTORIES: tmpdir() }), `${NAME}: not a git work tree \u2014 nothing to check\n`);
  const help = runCommand(['--help']);
  assert.deepEqual([help.code, help.stderr], [0, '']);
  const baseline = linesOf(RECORDED_HELP);
  const groups = [[baseline.findIndex((line) => line.startsWith('other list line')), 2],
    [baseline.findIndex((line) => line.startsWith('  REFUSED')), 1], [baseline.length - 1, 1]];
  const pattern = baseline.map((line, index) => groups.some(([start]) => index === start) ? '(?:[^\n]*\n)+'
    : groups.some(([start, length]) => index > start && index < start + length) ? ''
      : `${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`).join('');
  assert.match(help.stdout, new RegExp(`^${pattern}$`));
  assert.doesNotMatch(help.stdout, /REFUSED/);
  assert.ok(help.stdout.includes('attestation context refused'));
  assert.ok(help.stdout.endsWith('\n') && !help.stdout.endsWith('\n\n'));
});

it('spec:coverage-check/S7 places hostile paths at the project with their path leading', (test) => {
  const root = makeRepo(test);
  const hostile = [' lead.mjs', 'a:b.mjs', 'back\\slash.mjs'];
  for (const file of hostile) writeFileSync(join(root, file), SOURCE);
  writeLcov(root, lcovFor(root, [1, 3]));
  const bound = ['x:y.test.mjs', NAME];
  writeRecords(root, bound.map((file) => redProofRecord(root, file)));
  const block = readBlock(check(root), [CLASSES[2], CLASSES[3]], ['.', '.', '.', 'lib.mjs:2', '.', '.']);
  for (const [index, path] of hostile.entries()) {
    assert.ok(block.findings[index].startsWith(`.: ${path.replace(/^ /, '\\u0020')}: `), block.findings[index]);
  }
  assert.ok(block.findings[3].startsWith('lib.mjs:2: '));
  for (const [index, path] of bound.entries()) assert.ok(block.findings[index + 4].startsWith(`.: ${path}: `));
  assert.deepEqual(block.verdict.match(/\b\d+\b/g), ['4', '2']);
});
