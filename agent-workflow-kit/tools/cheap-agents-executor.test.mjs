import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AGENTS_DIR, CLAUDE_DIR, EXECUTOR_VEHICLE_REL, WORKFLOW_STAMP, EXPECTED_WORKFLOW_VERSION,
  CHEAP_AGENTS_BUNDLE, CHEAP_AGENTS_SYMLINK, preflightCheapAgents, readBundledAgents,
  surveyExecutorVehicle, writeCheapAgents, formatResult, main,
} from './cheap-agents.mjs';

const loaded = await import('./cheap-agents-read.mjs').catch(() => ({}));
const absent = () => { throw new Error('absent'); };
const readExecutorPosture = loaded.readExecutorPosture ?? absent;
const executorVehicleSpec = loaded.executorVehicleSpec ?? absent;
const deriveExecutorBody = loaded.deriveExecutorBody ?? absent;
const executorTemplate = loaded.executorTemplate ?? absent;
const CHEAP_AGENTS_VEHICLES = loaded.CHEAP_AGENTS_VEHICLES ?? absent;
const SETTINGS_REL = 'docs/ai/vehicles.json';
const CONFIG_REL = 'docs/ai/orchestration.json';
const EXECUTOR_NAME = 'executor.md';
const DEFAULT_POSTURE = { model: 'opus', effort: 'high', fallback: 'sonnet', source: 'default' };
const FILE_POSTURE = { model: 'sonnet', effort: 'medium', fallback: 'opus', source: 'file' };
const SETTINGS = JSON.stringify({ executor: { model: 'sonnet', effort: 'medium', fallback: 'opus' } });
const MALFORMED = '{ not json';
const CUSTOM = '---\nname: executor\ntools: Read, Bash\n---\nHand edit\n';
const INVALID = 'Hand edit without frontmatter\n';
const LENS_NAME = 'review-lens-opus-xhigh.md';
const REVIEW = { 'plan-execution': { review: ['review-lens:opus:xhigh'] } };
const roots = [];
const makeProject = (settings, review = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'cheap-agents-executor-'));
  roots.push(root);
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  writeFileSync(join(root, WORKFLOW_STAMP), `${EXPECTED_WORKFLOW_VERSION}\n`);
  writeFileSync(join(root, CONFIG_REL), JSON.stringify(review));
  if (settings !== undefined) writeFileSync(join(root, SETTINGS_REL), settings);
  return root;
};
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const placeExecutor = (root, content) => {
  mkdirSync(join(root, AGENTS_DIR), { recursive: true });
  writeFileSync(join(root, EXECUTOR_VEHICLE_REL), content);
};
const readExecutor = (root) => readFileSync(join(root, EXECUTOR_VEHICLE_REL), 'utf8');
const findExecutor = (result) => result.plan.find((item) => item.name === EXECUTOR_NAME);
const splitWords = (value) => String(value).match(/[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*/gu) ?? [];
const assertWords = (actual, expected) => {
  const words = splitWords(actual);
  for (const word of splitWords(expected)) assert.ok(words.includes(word), `missing word ${word}: ${actual}`);
};
const assertSettingsReason = (actual, expected) => {
  assert.match(actual, /\bdocs\/ai\/vehicles\.json\b/u);
  assertWords(actual, expected);
};
const traceReads = (overrides = {}) => {
  const events = [];
  return { events, deps: {
    lstat: (path) => { events.push(`lstat:${path}`); return (overrides.lstat ?? lstatSync)(path); },
    readFile: (path, encoding) => { events.push(`read:${path}`); return (overrides.readFile ?? readFileSync)(path, encoding); },
  } };
};
const denyPath = (target, fallback) => (path, ...args) => {
  if (path === target) throw Object.assign(new Error('denied'), { code: 'EACCES' });
  return fallback(path, ...args);
};
const assertPostureReport = (result, posture) => {
  assert.deepEqual(result.posture, posture);
  const lines = formatResult(result).split('\n');
  const postureLines = lines.filter((line) => /^executor posture:/u.test(line));
  assert.equal(postureLines.length, 1);
  const executorLine = lines.findIndex((line) => /^executor is\b/u.test(line));
  assert.ok(executorLine >= 0 && lines.indexOf(postureLines[0]) > executorLine);
  for (const key of ['model', 'effort', 'fallback']) assert.match(postureLines[0], new RegExp(`\\b${key}=${posture[key]}\\b`, 'u'));
  assert.match(postureLines[0], new RegExp(`\\(source: ${posture.source}\\)`, 'u'));
  assertSettingsReason(postureLines[0], 'set in');
};

it('spec:executor-vehicle/S1 derives only the model and effort from the resolved posture', () => {
  for (const [settings, expectedPosture] of [[undefined, DEFAULT_POSTURE], [SETTINGS, FILE_POSTURE]]) {
    const root = makeProject(settings);
    const answer = readExecutorPosture(root);
    assert.deepEqual(answer, { posture: expectedPosture, reason: null });
    const { posture } = answer;
    const bundled = readBundledAgents().find((item) => item.name === EXECUTOR_NAME).content;
    const expected = bundled.replace(/^model:.*$/mu, `model: ${posture.model}`).replace(/^effort:.*$/mu, `effort: ${posture.effort}`);
    assert.deepEqual(executorVehicleSpec(posture), {
      stem: 'executor', template: 'executor', model: posture.model, effort: posture.effort, tools: 'full', derived: true,
    });
    const body = deriveExecutorBody(bundled, posture);
    assert.equal(body, expected);
    assert.match(body, /^name: executor$/mu);
    assert.doesNotMatch(body, /^fallback:/mu);
    if (settings === undefined) assert.equal(body, bundled);
    assert.deepEqual(executorTemplate(posture), { name: EXECUTOR_NAME, content: expected, rederive: true });
    const bundleDir = join(root, 'bundle');
    mkdirSync(bundleDir);
    writeFileSync(join(bundleDir, 'other.md'), 'Other template\n');
    assert.throws(() => executorTemplate(posture, { bundleDir }), { code: CHEAP_AGENTS_BUNDLE });
  }
  const unreadable = readExecutorPosture(makeProject(MALFORMED));
  assert.equal(unreadable.posture, null);
  assertSettingsReason(unreadable.reason, 'unreadable');
});

it('spec:executor-vehicle/S2 surveys directories before settings and derived bytes', () => {
  for (const settings of [undefined, SETTINGS]) {
    const root = makeProject(settings);
    const { posture } = readExecutorPosture(root);
    assert.deepEqual(surveyExecutorVehicle(root), { state: 'missing', reason: null, rel: EXECUTOR_VEHICLE_REL });
    placeExecutor(root, executorTemplate(posture).content);
    const { events, deps } = traceReads();
    assert.deepEqual(surveyExecutorVehicle(root, deps), { state: 'placed', reason: null, rel: EXECUTOR_VEHICLE_REL });
    assert.deepEqual(events.slice(0, 3), [CLAUDE_DIR, AGENTS_DIR, SETTINGS_REL].map((rel) => `lstat:${join(root, rel)}`));
    const placedRead = events.indexOf(`read:${join(root, EXECUTOR_VEHICLE_REL)}`);
    const settingsEvent = events.indexOf(`${settings === undefined ? 'lstat' : 'read'}:${join(root, SETTINGS_REL)}`);
    assert.ok(settingsEvent >= 0 && placedRead > settingsEvent);
    for (const content of [CUSTOM, CUSTOM.replace('tools: Read, Bash\n', '')]) {
      placeExecutor(root, content);
      assert.deepEqual(surveyExecutorVehicle(root), { state: 'customized', reason: null, rel: EXECUTOR_VEHICLE_REL });
    }
  }
  for (const ancestor of [CLAUDE_DIR, AGENTS_DIR]) {
    for (const kind of ['symlink', 'file']) {
      const root = makeProject(MALFORMED);
      const blocked = join(root, ancestor);
      mkdirSync(dirname(blocked), { recursive: true });
      if (kind === 'symlink') {
        const target = join(root, 'linked');
        mkdirSync(target);
        symlinkSync(target, blocked, 'dir');
      } else writeFileSync(blocked, 'Not a directory\n');
      const { events, deps } = traceReads();
      const answer = surveyExecutorVehicle(root, deps);
      assert.equal(answer.state, 'unusable');
      assert.throws(() => preflightCheapAgents({ cwd: root }), (error) => {
        assert.equal(error.code, CHEAP_AGENTS_SYMLINK);
        assert.deepEqual(splitWords(answer.reason), splitWords(error.message));
        return true;
      });
      const ancestors = ancestor === CLAUDE_DIR ? [CLAUDE_DIR] : [CLAUDE_DIR, AGENTS_DIR];
      assert.deepEqual(events, ancestors.map((rel) => `lstat:${join(root, rel)}`));
    }
  }
  for (const failure of ['json', 'read']) {
    for (const content of [null, CUSTOM]) {
      const root = makeProject(failure === 'json' ? MALFORMED : SETTINGS);
      if (content !== null) placeExecutor(root, content);
      const overrides = failure === 'read' ? { readFile: denyPath(join(root, SETTINGS_REL), readFileSync) } : {};
      const expected = readExecutorPosture(root, overrides);
      assert.equal(expected.posture, null);
      const { events, deps } = traceReads(overrides);
      const answer = surveyExecutorVehicle(root, deps);
      assert.equal(answer.state, 'unusable');
      assert.equal(answer.rel, SETTINGS_REL);
      assertSettingsReason(answer.reason, expected.reason);
      assert.deepEqual(splitWords(answer.reason), splitWords(expected.reason));
      assert.equal(events.some((event) => event === `read:${join(root, EXECUTOR_VEHICLE_REL)}`), false);
    }
  }
});

it('spec:executor-vehicle/S3 places and re-derives executor while preserving other templates', () => {
  for (const settings of [undefined, SETTINGS]) {
    const root = makeProject(settings);
    const { posture } = readExecutorPosture(root);
    const template = executorTemplate(posture);
    const preview = writeCheapAgents({ cwd: root, dryRun: true });
    assert.equal(findExecutor(preview).action, 'place');
    assert.equal(preview.wrote, false);
    assert.equal(existsSync(join(root, AGENTS_DIR)), false);
    assertPostureReport(preview, posture);
    const applied = writeCheapAgents({ cwd: root, dryRun: false });
    assert.equal(findExecutor(applied).action, 'place');
    assert.equal(applied.wrote, true);
    assert.equal(readExecutor(root), template.content);
    assertPostureReport(applied, posture);
    const unchanged = writeCheapAgents({ cwd: root, dryRun: false });
    assert.equal(findExecutor(unchanged).action, 'already-current');
    assert.equal(unchanged.wrote, false);
    for (const content of [CUSTOM, INVALID]) {
      placeExecutor(root, content);
      const planned = findExecutor(preflightCheapAgents({ cwd: root, derived: [template] }));
      assert.equal(planned.action, 're-derive');
      assert.equal(planned.existing, content);
      const dryRun = writeCheapAgents({ cwd: root, dryRun: true });
      assert.equal(findExecutor(dryRun).action, 're-derive');
      assert.equal(findExecutor(dryRun).existing, content);
      assert.equal(dryRun.wrote, false);
      assert.equal(readExecutor(root), content);
      const previewLines = formatResult(dryRun).split('\n');
      assertWords(previewLines.find((line) => line.startsWith(`  - ${EXECUTOR_VEHICLE_REL}:`)), 'would re-derive');
      assert.ok(previewLines.some((line) => /^to apply, run exactly: node\b/u.test(line)));
      assert.ok(dryRun.plan.filter((item) => item.name !== EXECUTOR_NAME).every((item) => item.action === 'already-current'));
      const rewritten = writeCheapAgents({ cwd: root, dryRun: false });
      assert.equal(findExecutor(rewritten).action, 're-derive');
      assert.equal(rewritten.wrote, true);
      assert.equal(readExecutor(root), template.content);
      const reportLine = formatResult(rewritten).split('\n').find((line) => line.startsWith(`  - ${EXECUTOR_VEHICLE_REL}:`));
      assertWords(reportLine, 're-derived hand edit replaced');
      assertSettingsReason(reportLine, 'set model');
    }
  }
  const root = makeProject(SETTINGS, REVIEW);
  const { posture } = readExecutorPosture(root);
  const seeded = writeCheapAgents({ cwd: root, dryRun: false });
  const others = seeded.plan.filter((item) => item.name !== EXECUTOR_NAME);
  const bundledNames = readBundledAgents().filter((item) => item.name !== EXECUTOR_NAME).map((item) => item.name);
  assert.deepEqual(others.map((item) => item.name).sort(), [...bundledNames, LENS_NAME].sort());
  const lens = others.find((item) => item.name === LENS_NAME);
  assert.match(lens.content, /^model: opus$/mu);
  assert.match(lens.content, /^effort: xhigh$/mu);
  for (const item of others) writeFileSync(item.abs, `Customized ${item.name}\n`);
  placeExecutor(root, CUSTOM);
  for (const dryRun of [true, false]) {
    const result = writeCheapAgents({ cwd: root, dryRun });
    assert.equal(findExecutor(result).action, 're-derive');
    assert.equal(result.plan.filter((item) => item.name === EXECUTOR_NAME).length, 1);
    assert.equal(result.plan.findIndex((item) => item.name === EXECUTOR_NAME), readBundledAgents().findIndex((item) => item.name === EXECUTOR_NAME));
    for (const item of others) {
      assert.equal(result.plan.find((row) => row.name === item.name).action, 'customized-preserved');
      assert.equal(readFileSync(item.abs, 'utf8'), `Customized ${item.name}\n`);
    }
    assert.equal(readExecutor(root), dryRun ? CUSTOM : executorTemplate(posture).content);
  }
  {
    const project = makeProject(SETTINGS);
    const shared = join(project, 'shared.md');
    const { posture } = readExecutorPosture(project);
    mkdirSync(join(project, AGENTS_DIR), { recursive: true });
    writeFileSync(shared, CUSTOM);
    linkSync(shared, join(project, EXECUTOR_VEHICLE_REL));
    assert.equal(findExecutor(writeCheapAgents({ cwd: project, dryRun: false })).action, 're-derive');
    assert.equal(readExecutor(project), executorTemplate(posture).content);
    assert.equal(readFileSync(shared, 'utf8'), CUSTOM);
  }
  for (const kind of ['symlink', 'directory', 'read']) {
    const project = makeProject(SETTINGS);
    placeExecutor(project, CUSTOM);
    const target = join(project, EXECUTOR_VEHICLE_REL);
    const kept = join(project, 'kept.md');
    writeFileSync(kept, CUSTOM);
    if (kind !== 'read') rmSync(target);
    if (kind === 'symlink') symlinkSync(kept, target);
    if (kind === 'directory') mkdirSync(target);
    const writes = [];
    const deps = {
      mkdir: (...args) => writes.push(args), writeFile: (...args) => writes.push(args),
      ...(kind === 'read' ? { readFile: denyPath(target, readFileSync) } : {}),
    };
    for (const dryRun of [true, false]) {
      assert.throws(() => writeCheapAgents({ cwd: project, dryRun }, deps), {
        code: kind === 'read' ? 'EACCES' : CHEAP_AGENTS_SYMLINK,
      });
      assert.deepEqual(writes, []);
      assert.equal(readFileSync(kept, 'utf8'), CUSTOM);
      if (kind === 'read') assert.equal(readExecutor(project), CUSTOM);
      else assert.equal(kind === 'symlink' ? lstatSync(target).isSymbolicLink() : lstatSync(target).isDirectory(), true);
    }
  }
});

it('spec:executor-vehicle/S4 refuses unreadable settings before any placement', () => {
  for (const failure of ['json', 'read', 'lstat']) {
    const root = makeProject(failure === 'json' ? MALFORMED : SETTINGS);
    readExecutorPosture(root);
    assert.equal(CHEAP_AGENTS_VEHICLES, 'CHEAP_AGENTS_VEHICLES');
    const writes = [];
    const deps = {
      mkdir: (...args) => writes.push(['mkdir', ...args]),
      writeFile: (...args) => writes.push(['writeFile', ...args]),
      ...(failure === 'read' ? { readFile: denyPath(join(root, SETTINGS_REL), readFileSync) } : {}),
      ...(failure === 'lstat' ? { lstat: denyPath(join(root, SETTINGS_REL), lstatSync) } : {}),
    };
    const expected = readExecutorPosture(root, deps);
    assert.equal(expected.posture, null);
    for (const brokenConfig of [false, true]) {
      if (brokenConfig) writeFileSync(join(root, CONFIG_REL), MALFORMED);
      for (const dryRun of [true, false]) {
        assert.throws(() => writeCheapAgents({ cwd: root, dryRun }, deps), (error) => {
          assert.equal(error.code, CHEAP_AGENTS_VEHICLES);
          assert.equal(error.exitCode, 1);
          assertSettingsReason(error.message, expected.reason);
          return true;
        });
        const output = [];
        const errors = [];
        const exit = main([dryRun ? '--dry-run' : '--apply', '--cwd', root], {
          ...deps, log: (line) => output.push(line), errlog: (line) => errors.push(line),
        });
        assert.equal(exit, 1);
        assert.deepEqual(output, []);
        assert.equal(errors.length, 1);
        assertSettingsReason(errors[0], expected.reason);
        assert.deepEqual(writes, []);
        assert.equal(existsSync(join(root, AGENTS_DIR)), false);
      }
    }
  }
});
