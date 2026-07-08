// single-test-format.test.mjs — result-format strategy for the single-test probe (BUGFREE-3, AD-049).
// Invariant across every format: resolvable = matched>0 (a zero-match / tests="0" is NEVER green),
// and a missing result file is unresolvable, never a stale re-read green.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseProbeOutput, parseJunitXml, parseProbeResult, resolveBoundArgv, runRedProbe } from './fold-completeness-run.mjs';
import { readResults } from './fold-completeness.mjs';

// ── parseJunitXml ────────────────────────────────────────────────────────────────────────────────

describe('parseJunitXml — resolvable=matched>0, <skipped> excluded, failure/error → red', () => {
  const suite = (cases) => `<testsuites><testsuite>${cases}</testsuite></testsuites>`;
  it('all-pass testcases → resolvable + green', () => {
    const r = parseJunitXml({ resultText: suite('<testcase name="a"/><testcase name="b"></testcase>') });
    assert.deepEqual(r, { resolvable: true, executed: 2, baselineGreen: true });
  });
  it('<failure> or <error> → red (report authoritative, exit code irrelevant)', () => {
    assert.equal(parseJunitXml({ resultText: suite('<testcase name="a"><failure message="x"/></testcase>') }).baselineGreen, false);
    assert.equal(parseJunitXml({ resultText: suite('<testcase name="a"><error/></testcase>') }).baselineGreen, false);
  });
  it('tests="0" / empty report → unresolvable, never green', () => {
    assert.deepEqual(parseJunitXml({ resultText: '<testsuites tests="0"></testsuites>' }), { resolvable: false, executed: 0, baselineGreen: false });
    assert.deepEqual(parseJunitXml({ resultText: '' }), { resolvable: false, executed: 0, baselineGreen: false });
  });
  it('a <skipped> testcase is excluded from executed', () => {
    const r = parseJunitXml({ resultText: suite('<testcase name="a"><skipped/></testcase>') });
    assert.deepEqual(r, { resolvable: false, executed: 0, baselineGreen: false });
  });
  it('skipped beside a real pass → resolvable green on the one executed case', () => {
    const r = parseJunitXml({ resultText: suite('<testcase name="s"><skipped/></testcase><testcase name="a"/>') });
    assert.deepEqual(r, { resolvable: true, executed: 1, baselineGreen: true });
  });
  it('fail-closed: CDATA containing literal "<skipped" does not drop a failing testcase', () => {
    const xml = '<testsuites><testcase name="a"/><testcase name="b"><system-out><![CDATA[expected <skipped/> node]]></system-out><failure message="boom"/></testcase></testsuites>';
    assert.equal(parseJunitXml({ resultText: xml }).baselineGreen, false, 'a real <failure> must never read green because CDATA mentions <skipped');
  });
  it('fail-closed: "</testcase>" inside CDATA does not truncate the match or hide a trailing <failure>', () => {
    const xml = '<testsuites><testcase name="a"/><testcase name="b"><system-out><![CDATA[dumped </testcase> marker]]></system-out><failure/></testcase></testsuites>';
    assert.equal(parseJunitXml({ resultText: xml }).baselineGreen, false, 'a </testcase> inside CDATA must not desync the parser and hide the failure');
  });
  it('an XML comment mentioning <failure> does not fabricate a failure', () => {
    const xml = '<testsuites><!-- a <failure> note --><testcase name="a"/></testsuites>';
    assert.equal(parseJunitXml({ resultText: xml }).baselineGreen, true);
  });
});

// ── parseProbeResult dispatch (tap-stdout / tap-file / junit-xml) ─────────────────────────────────

describe('parseProbeResult — format dispatch + missing-file freshness guard', () => {
  const okTap = 'TAP version 13\nok 1 - real test\n1..1\n# fail 0\n';
  const redTap = 'TAP version 13\nnot ok 1 - real test\n1..1\n# fail 1\n';
  const zeroTap = 'TAP version 13\nok 1 - somefile.mjs\n1..1\n'; // only the file wrapper, no matched test
  it('tap-stdout dispatches to the stdout parser', () => {
    assert.equal(parseProbeResult({ format: 'tap-stdout', stdout: okTap, code: 0, fileArg: 'somefile.mjs' }).baselineGreen, true);
  });
  it('tap-file parses the result text; green / red / zero-match honoured', () => {
    assert.equal(parseProbeResult({ format: 'tap-file', resultText: okTap, code: 0, fileArg: 'somefile.mjs' }).baselineGreen, true);
    assert.equal(parseProbeResult({ format: 'tap-file', resultText: redTap, code: 1, fileArg: 'somefile.mjs' }).baselineGreen, false);
    assert.deepEqual(parseProbeResult({ format: 'tap-file', resultText: zeroTap, code: 0, fileArg: 'somefile.mjs' }), { resolvable: false, executed: 0, baselineGreen: false });
  });
  it('fail-closed: `not ok` but exit 0 and no `# fail N` still reads red', () => {
    const sneaky = 'ok 1 - a\nnot ok 2 - b\n1..2\n';
    assert.equal(parseProbeResult({ format: 'tap-file', resultText: sneaky, code: 0, fileArg: 'f.mjs' }).baselineGreen, false);
  });
  it('junit-xml dispatches to the JUnit parser', () => {
    assert.equal(parseProbeResult({ format: 'junit-xml', resultText: '<testsuites><testcase name="a"/></testsuites>', code: 0, fileArg: 'f' }).baselineGreen, true);
  });
  it('junit-xml also requires exit 0 — all-pass report + nonzero exit reads red (symmetric with tap-file)', () => {
    const allPass = '<testsuites><testcase name="a"/></testsuites>';
    assert.equal(parseProbeResult({ format: 'junit-xml', resultText: allPass, code: 1, fileArg: 'f' }).baselineGreen, false);
    assert.equal(parseProbeResult({ format: 'junit-xml', resultText: allPass, code: 0, fileArg: 'f' }).baselineGreen, true);
  });
  it('file-based format with an unwritten result file (resultText null) → unresolvable', () => {
    for (const format of ['tap-file', 'junit-xml']) {
      assert.deepEqual(parseProbeResult({ format, resultText: null, code: 0, fileArg: 'f' }), { resolvable: false, executed: 0, baselineGreen: false });
    }
  });
});

// ── resolveBoundArgv — {resultPath} plumbing + env-over-profile precedence ─────────────────────────

describe('resolveBoundArgv — precedence (env > profile > default) + {resultPath}', () => {
  it('profile argv used when no env override, with {file}/{pattern}/{resultPath} substituted', () => {
    const fn = resolveBoundArgv({}, { singleTest: { argv: ['runner', '-t', '{pattern}', '-o', '{resultPath}', '{file}'] } });
    assert.deepEqual(fn('/abs/f.mjs', 'pat', '/tmp/r.xml'), ['runner', '-t', 'pat', '-o', '/tmp/r.xml', '/abs/f.mjs']);
  });
  it('AW_FOLD_BOUND_CMD env wins over the profile argv', () => {
    const fn = resolveBoundArgv({ AW_FOLD_BOUND_CMD: '["env","{file}","{pattern}"]' }, { singleTest: { argv: ['profile', '{file}', '{pattern}'] } });
    assert.deepEqual(fn('/f', 'p'), ['env', '/f', 'p']);
  });
  it('built-in node:test default when neither env nor profile is set', () => {
    const fn = resolveBoundArgv({}, null);
    assert.deepEqual(fn('/f', 'p'), ['node', '--test', '--test-reporter', 'tap', '--test-name-pattern=p', '/f']);
  });
  it('a `$` in a substituted value stays literal', () => {
    const fn = resolveBoundArgv({}, { singleTest: { argv: ['r', '{pattern}', '{file}'] } });
    assert.deepEqual(fn('/f', 'a$1b'), ['r', 'a$1b', '/f']);
  });
});

// ── end-to-end: a junit-xml profile drives the --red probe ─────────────────────────────────────────

// Fake runner: `node junit-probe.mjs <pattern> <resultPath>` writes a JUnit report —
// "failing" → a failure, "nomatch" → tests="0", anything else → one pass.
const JUNIT_PROBE = [
  "import { writeFileSync } from 'node:fs';",
  'const [, , pattern, resultPath] = process.argv;',
  "const xml = pattern === 'nomatch' ? '<testsuites tests=\"0\"></testsuites>'",
  "  : pattern === 'failing' ? '<testsuites><testsuite><testcase name=\"t\"><failure/></testcase></testsuite></testsuites>'",
  "  : '<testsuites><testsuite><testcase name=\"t\"></testcase></testsuite></testsuites>';",
  'writeFileSync(resultPath, xml);',
  'process.exit(0);',
].join('\n');

const fixtureEnv = (root) => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AW_')) delete env[k];
  return { ...env, AW_REVIEW_LEDGER: join(root, '.git', 'rl.jsonl'), AW_FOLD_RESULTS: join(root, '.git', 'fc.jsonl'), AW_FOLD_RERUNS: '2' };
};

const makeJunitRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'fold-junit-'));
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'p@e.com');
  g('config', 'user.name', 'p');
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'junit-probe.mjs'), JUNIT_PROBE);
  writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [{ id: 'unit-tests', title: 't', cmd: 'true' }] }));
  writeFileSync(join(root, 'docs', 'ai', 'verification-profile.json'), JSON.stringify({
    schema: 1,
    singleTest: { argv: ['node', '{file}', '{pattern}', '{resultPath}'], resultFormat: 'junit-xml' },
  }));
  writeFileSync(join(root, 'docs', 'plans', 'queue.md'), '# queue\n');
  writeFileSync(join(root, 'docs', 'plans', 'active-plan.md'), '# plan\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  return { root };
};

describe('junit-xml profile end-to-end — --red reads the JUnit report per format', () => {
  it('an N/N red junit result mints an observed-red receipt', () => {
    const { root } = makeJunitRepo();
    const { record } = runRedProbe({ cwd: root, env: fixtureEnv(root), testId: 'junit-probe.mjs#failing' });
    const { records } = readResults(join(root, '.git', 'fc.jsonl'));
    rmSync(root, { recursive: true, force: true });
    assert.equal(record.kind, 'red-probe');
    assert.equal(record.reds, 2);
    assert.equal(records.length, 1);
  });
  it('an all-green junit result → --red refuses (observed GREEN), nothing written', () => {
    const { root } = makeJunitRepo();
    assert.throws(() => runRedProbe({ cwd: root, env: fixtureEnv(root), testId: 'junit-probe.mjs#passing' }), /observed GREEN/);
    const { records } = readResults(join(root, '.git', 'fc.jsonl'));
    rmSync(root, { recursive: true, force: true });
    assert.equal(records.length, 0);
  });
  it('a tests="0" junit result → --red refuses (unresolvable, never green)', () => {
    const { root } = makeJunitRepo();
    assert.throws(() => runRedProbe({ cwd: root, env: fixtureEnv(root), testId: 'junit-probe.mjs#nomatch' }), /unresolvable/i);
    rmSync(root, { recursive: true, force: true });
  });
});
