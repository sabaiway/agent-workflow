import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAMILY_DIRS } from '../release/version-sync.mjs';
import { line } from '../../agent-workflow-kit/tools/sandbox-masks-harness.test.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT_ROOT = resolve(HERE, '..', '..');
const PROBES = ['user', 'root', 'copy'];
const PASSING_OUTCOMES = ['EROFS', 'EROFS', 'ok'];
const OUTCOMES = ['ok', 'EROFS', 'EACCES', 'ENOENT', 'signal SIGKILL', 'spawn ENOENT', undefined];
const CI_ARGUMENTS = [
  'agent-workflow-memory/{scripts,bin}/*.test.mjs',
  "'agent-workflow-memory/references/scripts/**/*.test.mjs'",
  'agent-workflow-kit/{tools,tools/manifest,tools/services,tools/project-rules,tools/source-size,tools/checker-verdict,bin}/*.test.mjs',
  "'agent-workflow-kit/references/scripts/**/*.test.mjs'",
  'agent-workflow-kit/tools/*.test/*.test.mjs',
  'agent-workflow-kit/test/*.test.mjs',
  'agent-workflow-engine/test/*.test.mjs',
  'antigravity-cli-bridge/bin/*.test.mjs',
  'codex-cli-bridge/bin/*.test.mjs',
  'typesafe-jev-bridge/bin/*.test.mjs',
  'scripts/release/*.test.mjs',
  'scripts/sync-mirrors.test.mjs',
  'scripts/check-ascii-letters.test.mjs',
  'scripts/suite-parity.test.mjs',
  'scripts/suite-parity-reporter.test.mjs',
  'scripts/suite-parity-branches.test.mjs',
];
const PUBLISH_RUN = `set -euo pipefail
if [ "\${{ inputs.dir }}" = "agent-workflow-kit" ]; then
  node --test tools/*.test.mjs tools/manifest/*.test.mjs tools/services/*.test.mjs tools/project-rules/*.test.mjs tools/source-size/*.test.mjs tools/checker-verdict/*.test.mjs tools/*.test/*.test.mjs 'references/scripts/**/*.test.mjs' bin/*.test.mjs test/*.test.mjs bridges/*/bin/*.test.mjs
elif [ "\${{ inputs.dir }}" = "agent-workflow-engine" ]; then
  node --test test/*.test.mjs
else
  node --test scripts/*.test.mjs bin/*.test.mjs 'references/scripts/**/*.test.mjs'
fi
`;

const buildSealPlan = (root) => FAMILY_DIRS.flatMap((dir) => {
  const point = join(root, dir);
  return [['sudo', 'mount', '--bind', point, point], ['sudo', 'mount', '-o', 'remount,bind,ro', point]];
});
const buildMountTable = (points) => points.map((point, index) =>
  line(index + 1, 0, '8:1', '/', point.replaceAll(' ', '\\040'))).join('\n');
const buildProbeResults = (dir, outcomes) => PROBES.flatMap((probe, index) =>
  outcomes[index] === undefined ? [] : [{ dir, probe, outcome: outcomes[index] }]);
const assertFailures = (answer, expected) => {
  assert.equal(answer.ok, expected.length === 0);
  assert.equal(answer.failures.length, expected.length);
  for (const [dir, probe] of expected) {
    assert.equal(answer.failures.filter((failure) => failure.includes(dir) && failure.includes(probe)).length, 1,
      `failure must name ${dir} and ${probe}`);
  }
};
const readJob = (source, name) => {
  const jobs = [...source.matchAll(/^  ([\w-]+):\n/gmu)];
  const index = jobs.findIndex((job) => job[1] === name);
  assert.ok(index >= 0, `job ${name} exists`);
  return source.slice(jobs[index].index, jobs[index + 1]?.index);
};
const readSteps = (job) => {
  const starts = [...job.matchAll(/^      - [^\n]*/gmu)];
  return starts.map((start, index) => job.slice(start.index, starts[index + 1]?.index));
};
const readRun = (step) => {
  const run = /^        run: ([^\n]*)\n/gmu.exec(step);
  if (!run) return '';
  if (run[1] !== '|') return `${run[1]}\n`;
  const body = /^(?: {10}[^\n]*\n)+/u.exec(step.slice(run.index + run[0].length))?.[0] ?? '';
  return body.replace(/^ {10}/gmu, '');
};
const findStep = (steps, predicate, label) => {
  const matches = steps.flatMap((step, index) => predicate(readRun(step)) ? [index] : []);
  assert.equal(matches.length, 1, `exactly one ${label} step`);
  return matches[0];
};

it('spec:fixture-isolation/S7 seal and restore plans cover exactly the family mounts', async () => {
  const { planSeal, planRestore, main } = await import('./package-seal.mjs');
  const root = '/checkout with space';
  const points = FAMILY_DIRS.map((dir) => join(root, dir));
  assert.deepEqual(planSeal(root), buildSealPlan(root));
  const fullTable = buildMountTable([root, points[2], '/unrelated', ...points.slice(0, 2),
    join(root, 'agent-workflow-kit-old'), ...points.slice(3)]);
  const fullOrder = [points[2], ...points.slice(0, 2), ...points.slice(3)];
  assert.deepEqual(planRestore(root, fullTable), fullOrder.toReversed().map((point) => ['sudo', 'umount', point]));
  const partial = [points[1], points[0]];
  assert.deepEqual(planRestore(root, buildMountTable(partial)),
    partial.toReversed().map((point) => ['sudo', 'umount', point]));
  assert.deepEqual(planRestore(root, buildMountTable([points[0], points[0]])),
    [['sudo', 'umount', points[0]], ['sudo', 'umount', points[0]]]);
  const restoredTable = buildMountTable([root, '/unrelated', join(root, 'agent-workflow-kit-old')]);
  assert.deepEqual(planRestore(root, restoredTable), []);
  assert.deepEqual(planRestore(root, restoredTable), []);
  const calls = [];
  assert.equal(await main(['seal'], (args) => { calls.push(args); return { status: 0 }; }), 0);
  assert.deepEqual(calls, planSeal(CHECKOUT_ROOT));
  assert.deepEqual(calls, buildSealPlan(CHECKOUT_ROOT));
  const failingCalls = [];
  assert.equal(await main(['seal'], (args) => {
    failingCalls.push(args);
    return { status: failingCalls.length === 2 ? 1 : 0 };
  }), 1);
  assert.deepEqual(failingCalls, buildSealPlan(CHECKOUT_ROOT).slice(0, 2));
});

it('spec:fixture-isolation/S8 the complete self-check table accepts only proven read-only mounts and writable copies', async () => {
  const { judgeSealProbes } = await import('./package-seal.mjs');
  const dir = '/checkout/package-one';
  const rows = OUTCOMES.flatMap((user) => OUTCOMES.flatMap((root) => OUTCOMES.map((copy) => [user, root, copy])));
  assert.equal(rows.length, 343);
  for (const outcomes of rows) {
    const expected = PROBES.flatMap((probe, index) =>
      outcomes[index] === PASSING_OUTCOMES[index] ? [] : [[dir, probe]]);
    assertFailures(judgeSealProbes([dir], buildProbeResults(dir, outcomes)), expected);
  }
  const otherDir = '/checkout/package-two';
  const passing = buildProbeResults(dir, PASSING_OUTCOMES);
  assertFailures(judgeSealProbes([dir, otherDir], [
    ...passing, ...buildProbeResults(otherDir, ['EROFS', 'ENOENT', 'ok']),
  ]), [[otherDir, 'root']]);
  assertFailures(judgeSealProbes([dir, otherDir], [
    ...passing, passing[0], ...buildProbeResults(otherDir, PASSING_OUTCOMES),
  ]), [[dir, 'user']]);
  assertFailures(judgeSealProbes([dir, otherDir], passing), PROBES.map((probe) => [otherDir, probe]));
});

it('the check command probes each directory under its root and names every failed probe', async (t) => {
  const { main } = await import('./package-seal.mjs');
  const root = mkdtempSync(join(tmpdir(), 'aw-package-seal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const [missing, ...present] = FAMILY_DIRS;
  for (const dir of present) {
    mkdirSync(join(root, dir));
    writeFileSync(join(root, dir, 'file.txt'), 'original');
  }
  const errors = t.mock.method(console, 'error', () => {});
  const calls = [];
  assert.equal(main(['check'], (args) => { calls.push(args); return { status: 0, stdout: 'EROFS\n' }; }, root), 1);
  assert.deepEqual(calls.map((args) => dirname(args.at(-1))), FAMILY_DIRS.map((dir) => join(root, dir)));
  const messages = errors.mock.calls.map((call) => call.arguments[0]);
  const expected = [[missing, 'user'], [missing, 'copy'], ...present.map((dir) => [dir, 'user'])];
  assert.equal(messages.length, expected.length, messages.join('\n'));
  for (const [dir, probe] of expected) {
    assert.ok(messages.some((message) => message.includes(join(root, dir)) && message.includes(`${probe} expected`)), `${dir} ${probe}`);
  }
  for (const dir of present) assert.deepEqual(readdirSync(join(root, dir)), ['file.txt']);
});

it('the command refuses bad arguments, fails on a runner error and restores nothing unmounted', async (t) => {
  const { main } = await import('./package-seal.mjs');
  const errors = t.mock.method(console, 'error', () => {});
  for (const argv of [[], ['seal', 'check'], ['unseal']]) assert.equal(main(argv, () => assert.fail('no run')), 2);
  assert.equal(main(['seal'], () => { throw new Error('runner broke'); }), 1);
  assert.ok(errors.mock.calls.at(-1).arguments[0].includes('runner broke'));
  const unsealed = mkdtempSync(join(tmpdir(), 'aw-unsealed-'));
  t.after(() => rmSync(unsealed, { recursive: true, force: true }));
  assert.equal(main(['restore'], () => assert.fail('no mount to restore'), unsealed), 0);
});

it('spec:fixture-isolation/S9 both workflows surround the unchanged test step with seal, check and always restore', () => {
  for (const [file, jobName] of [['ci.yml', 'test'], ['_publish-one.yml', 'publish']]) {
    const job = readJob(readFileSync(join(CHECKOUT_ROOT, '.github', 'workflows', file), 'utf8'), jobName);
    const steps = readSteps(job);
    const findSealCommand = (command) => findStep(steps,
      (run) => run.split('\n').some((text) => text.trim() === `node scripts/testing/package-seal.mjs ${command}`), command);
    const seal = findSealCommand('seal');
    const check = findSealCommand('check');
    const test = findStep(steps, (run) => /^\s*node --test\b/mu.test(run), 'node --test');
    const restore = findSealCommand('restore');
    assert.deepEqual([seal, check, test, restore], [seal, seal + 1, seal + 2, seal + 3], file);
    for (const index of [seal, check, restore]) {
      assert.match(steps[index], /^        working-directory: \$\{\{ github.workspace \}\}$/mu, file);
    }
    for (const index of [seal, check]) {
      assert.doesNotMatch(steps[index], /^        (?:if|continue-on-error):/mu, file);
    }
    assert.match(steps[restore], /^        if: always\(\)$/mu, file);
    assert.doesNotMatch(steps[test], /^        working-directory:/mu, file);
    const beforeSteps = job.slice(0, job.indexOf('    steps:'));
    if (file === 'ci.yml') {
      assert.doesNotMatch(beforeSteps, /^    defaults:/mu);
      const argumentsList = readRun(steps[test]).replaceAll('\\\n', ' ').trim().split(/\s+/u).slice(2);
      for (const argument of [...CI_ARGUMENTS, 'scripts/testing/fixture-scopes.test.mjs',
        'scripts/testing/package-seal.test.mjs', 'scripts/testing/package-census.test.mjs']) {
        assert.ok(argumentsList.includes(argument), `ci.yml keeps ${argument}`);
      }
    } else {
      assert.match(beforeSteps, /^    defaults:\n      run:\n        working-directory: \$\{\{ inputs.dir \}\}$/mu);
      assert.equal(readRun(steps[test]), PUBLISH_RUN);
    }
  }
});
