import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENTS_DIR, WORKFLOW_STAMP, EXPECTED_WORKFLOW_VERSION, CHEAP_AGENTS_BUNDLE, CHEAP_AGENTS_VEHICLES,
  readBundledAgents, writeCheapAgents, formatResult, main,
} from './cheap-agents.mjs';
import { buildRecommendations, WHATS, ITEM_LINE_CAP } from './recommendations.mjs';
import { applySlot } from './write-lanes.mjs';

const read = await import('./cheap-agents-read.mjs').catch(() => ({}));
const vehicleSettings = await import('./vehicle-settings.mjs').catch(() => ({}));
const need = (value, name) => {
  if (value === undefined) throw new Error(`absent: ${name}`);
  return value;
};
const reviewLensTemplate = (...args) => need(read.reviewLensTemplate, 'reviewLensTemplate')(...args);
const readReviewLensPosture = (...args) => need(read.readReviewLensPosture, 'readReviewLensPosture')(...args);
const lensVehicle = () => need(read.REVIEW_LENS_VEHICLE, 'REVIEW_LENS_VEHICLE');
const lensDefaults = () => need(vehicleSettings.REVIEW_LENS_DEFAULTS, 'REVIEW_LENS_DEFAULTS');

const TOOLS = dirname(fileURLToPath(import.meta.url));
const LENS = 'review-lens.md';
const LENS_REL = `${AGENTS_DIR}/${LENS}`;
const EXECUTOR = 'executor.md';
const SWEEP = 'mechanical-sweep.md';
const DERIVED_LENS = 'review-lens-opus-xhigh.md';
const SETTINGS_REL = 'docs/ai/vehicles.json';
const CONFIG_REL = 'docs/ai/orchestration.json';
const REVIEW = { 'plan-execution': { review: ['review-lens:opus:xhigh'] } };
const CUSTOM_EXECUTOR = '---\nname: executor\ntools: Read, Bash\n---\nHand edit\n';
const derivedLine = (verb) => `differs from the body derived from the vehicle settings — ${verb} with that body; its model and effort are set in docs/ai/vehicles.json`;
const PLACE_ONLY_WHAT = '{n} bundled subagent vehicle(s) not placed (Claude Code) — {ro} read-only, {ex} the full-tool executor; the apply PREVIEWS first';
const KIT_WHAT = '{n} kit agent file(s) in .claude/agents/ not current — each is written with the body the kit writes for it, with no question';
const settingsWith = (lens) => JSON.stringify({
  executor: { model: 'sonnet', effort: 'medium', fallback: 'opus' }, ...(lens ? { 'review-lens': lens } : {}),
});
const BUNDLED = readBundledAgents().find((item) => item.name === LENS).content;
const withPosture = (body, model, effort) =>
  body.replace(/^model:.*$/mu, `model: ${model}`).replace(/^effort:.*$/mu, `effort: ${effort}`);
const STALE = withPosture(BUNDLED, 'sonnet', 'low');
const lineOf = (body, key) => body.match(new RegExp(`^${key}: (.*)$`, 'mu'))?.[1];
const fill = (template, values) => template.replace(/\{([A-Za-z]+)\}/gu, (_, key) => String(values[key]));

const roots = [];
const makeProject = (settings, review = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'cheap-agents-review-lens-'));
  roots.push(root);
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  writeFileSync(join(root, WORKFLOW_STAMP), `${EXPECTED_WORKFLOW_VERSION}\n`);
  writeFileSync(join(root, CONFIG_REL), JSON.stringify(review));
  if (settings !== undefined) writeFileSync(join(root, SETTINGS_REL), settings);
  return root;
};
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const agentPath = (root, name) => join(root, AGENTS_DIR, name);
const runMain = (argv) => {
  const output = [];
  const errors = [];
  const exit = main(argv, { log: (line) => output.push(line), errlog: (line) => errors.push(line) });
  return { exit, output, errors };
};
const rowLine = (result, name) => formatResult(result).split('\n').find((line) => line.startsWith(`  - ${AGENTS_DIR}/${name}:`));
const assertPostureLine = (result, { model, effort, source }) => {
  const lines = formatResult(result).split('\n');
  const at = lines.findIndex((line) => line.startsWith('executor posture:'));
  assert.ok(at >= 0);
  assert.equal(lines[at + 1], `review-lens posture: model=${model} effort=${effort} (source: ${source}) — set in docs/ai/vehicles.json`);
  assert.equal(lines.filter((line) => line.startsWith('review-lens posture:')).length, 1);
};
const advisorDeps = (root) => ({
  findWrapper: () => false,
  env: { PATH: '/nonexistent-path-for-tests' },
  getenv: { PATH: '/nonexistent-path-for-tests' },
  home: root,
  takeCensus: () => ({
    counts: { assessable: 3, unsupported: 0, 'out-of-domain': 1, 'excluded-test': 0 },
    unsupportedExtensions: [], verdict: 'within-domain', total: 4,
  }),
});
// The agents key of one advisor run: its items and its stated skips.
const agentsKey = (root, extra = {}) => {
  const built = buildRecommendations({ cwd: root, deps: { ...advisorDeps(root), ...extra } });
  return [built.items.filter((item) => item.key === 'agents'), built.skips.filter((skip) => skip.key === 'agents')];
};
const slotOf = (variant, root) => applySlot(variant, { toolsDir: TOOLS, root, env: {}, home: root, platform: 'linux' });
const plannedRels = (root) => writeCheapAgents({ cwd: root, dryRun: true }).plan.filter((item) => ['place', 're-derive'].includes(item.action)).map((item) => item.rel);

it('spec:review-roster/S17 the bundled review lens frontmatter carries REVIEW_LENS_DEFAULTS', () => {
  assert.deepEqual({ ...lensDefaults() }, { model: 'opus', effort: 'high' });
  assert.ok(Object.isFrozen(lensDefaults()));
  assert.equal(lineOf(BUNDLED, 'model'), lensDefaults().model);
  assert.equal(lineOf(BUNDLED, 'effort'), lensDefaults().effort);
});

it('derives the lens body from the bundled bytes with exactly the model and effort lines replaced', () => {
  assert.equal(lensVehicle(), LENS);
  const custom = reviewLensTemplate({ model: 'sonnet', effort: 'medium', source: 'file' });
  assert.deepEqual(custom, { name: LENS, content: withPosture(BUNDLED, 'sonnet', 'medium'), rederive: true });
  const before = BUNDLED.split('\n');
  const after = custom.content.split('\n');
  assert.equal(after.length, before.length);
  assert.deepEqual(before.flatMap((line, index) => (line === after[index] ? [] : [after[index]])), ['model: sonnet', 'effort: medium']);
  assert.match(custom.content, /^name: review-lens$/mu);
  assert.deepEqual(reviewLensTemplate({ ...lensDefaults(), source: 'default' }), { name: LENS, content: BUNDLED, rederive: true });
  const bundleDir = join(makeProject(), 'bundle');
  mkdirSync(bundleDir);
  writeFileSync(join(bundleDir, 'other.md'), 'Other template\n');
  assert.throws(() => reviewLensTemplate(lensDefaults(), { bundleDir }), { code: CHEAP_AGENTS_BUNDLE });
});

it('writes a differing placed lens with the derived line, every differing cheap vehicle and derived lens too, and prints the lens posture', () => {
  for (const [settings, posture] of [
    [undefined, { model: 'opus', effort: 'high', source: 'default' }],
    [settingsWith({ model: 'sonnet', effort: 'high' }), { model: 'sonnet', effort: 'high', source: 'file' }],
  ]) {
    const root = makeProject(settings, REVIEW);
    assert.deepEqual(readReviewLensPosture(root), { posture, reason: null });
    writeCheapAgents({ cwd: root, dryRun: false });
    const bodies = Object.fromEntries(writeCheapAgents({ cwd: root, dryRun: true }).plan.map((item) => [item.name, item.content]));
    const older = { [SWEEP]: 'Customized sweep\n', [DERIVED_LENS]: 'Customized derived lens\n', [EXECUTOR]: CUSTOM_EXECUTOR, [LENS]: STALE };
    for (const [name, body] of Object.entries(older)) writeFileSync(agentPath(root, name), body);
    for (const dryRun of [true, false]) {
      const result = writeCheapAgents({ cwd: root, dryRun });
      assert.deepEqual(Object.keys(older).map((name) => result.plan.find((item) => item.name === name).action), Object.keys(older).map(() => 're-derive'));
      assert.deepEqual(result.lensPosture, posture);
      assertPostureLine(result, posture);
      for (const name of [LENS, EXECUTOR]) assert.equal(rowLine(result, name), `  - ${AGENTS_DIR}/${name}: ${derivedLine(dryRun ? 'would be written' : 'written')}`);
      for (const name of Object.keys(older)) assert.equal(readFileSync(agentPath(root, name), 'utf8'), dryRun ? older[name] : bodies[name], name);
    }
    assert.equal(bodies[LENS], withPosture(BUNDLED, posture.model, posture.effort));
  }
});

it('stops the writer on a malformed review-lens section with nothing placed', () => {
  const root = makeProject(settingsWith({ model: 'opus\ntools: Bash', effort: 'high' }));
  mkdirSync(join(root, AGENTS_DIR), { recursive: true });
  writeFileSync(agentPath(root, LENS), STALE);
  const reason = 'docs/ai/vehicles.json: review-lens.model must be a bare token — the agents writer cannot derive the executor and review-lens vehicles — nothing is placed';
  for (const dryRun of [true, false]) {
    assert.throws(() => writeCheapAgents({ cwd: root, dryRun }), (error) => {
      assert.equal(error.code, CHEAP_AGENTS_VEHICLES);
      assert.ok(error.message.endsWith(reason), error.message);
      return true;
    });
    const { exit, output, errors } = runMain([dryRun ? '--dry-run' : '--apply', '--cwd', root]);
    assert.equal(exit, 1);
    assert.deepEqual(output, []);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].endsWith(reason), errors[0]);
    assert.deepEqual(readdirSync(join(root, AGENTS_DIR)), [LENS]);
    assert.equal(readFileSync(agentPath(root, LENS), 'utf8'), STALE);
  }
});

describe('the agents key by its state table (spec:carriers/S26)', () => {
  it("not accepted with a planned place renders the agents offer with today's texts", () => {
    const root = makeProject();
    mkdirSync(join(root, AGENTS_DIR), { recursive: true });
    writeFileSync(agentPath(root, 'doc-research.md'), 'own vehicle\n');
    const [[item, ...more], skips] = agentsKey(root);
    const follow = `hidden-mode deployments only: after the --apply the preview prints, run node ${join(TOOLS, 'hide-footprint.mjs')} --dir ${root} --reconcile so the placed .claude/agents/ stays invisible to git status`;
    assert.deepEqual([item.variant, item.lane, item.what, item.detail, item.apply, more, skips], ['agents', 'harness', fill(PLACE_ONLY_WHAT, { n: 5, ro: 4, ex: 1 }), follow, slotOf('agents', root).apply, [], []]);
  });

  it('accepted with a planned place or re-derive renders agents.not-current: lane kit, its count, every planned file, the executor included, no hidden-mode follow-up', () => {
    for (const older of [[EXECUTOR], [EXECUTOR, LENS, SWEEP, DERIVED_LENS]]) {
      const root = makeProject(settingsWith({ model: 'sonnet', effort: 'high' }), REVIEW);
      writeCheapAgents({ cwd: root, dryRun: false });
      if (older.length === 1) rmSync(agentPath(root, EXECUTOR));
      else for (const name of older) writeFileSync(agentPath(root, name), 'an earlier body\n');
      const planned = plannedRels(root);
      const [[item, ...more], skips] = agentsKey(root);
      assert.equal(item?.variant, 'agents.not-current', JSON.stringify(item));
      const slot = slotOf('agents.not-current', root);
      assert.deepEqual([item?.variant, item?.lane, item?.what, item?.detail, item?.check, item?.apply, more, skips],
        ['agents.not-current', 'kit', fill(KIT_WHAT, { n: planned.length }), `writes: ${planned.join(', ')}`, slot.check, slot.apply, [], []]);
      assert.deepEqual(older.map((name) => planned.includes(`${AGENTS_DIR}/${name}`)), older.map(() => true));
    }
  });

  it('a throw is one stated skip naming it, a character device at a kit agent path among them; a stale stamp beside a planned item the upgrade-first skip; nothing planned renders nothing', () => {
    const root = makeProject(undefined, REVIEW);
    writeCheapAgents({ cwd: root, dryRun: false });
    const device = agentPath(root, 'gate-triage.md');
    const kinds = ['isCharacterDevice', 'isBlockDevice', 'isFIFO', 'isSocket', 'isSymbolicLink', 'isDirectory', 'isFile'];
    const lstat = (path, ...rest) => (path === device ? Object.fromEntries(kinds.map((kind) => [kind, () => kind === 'isCharacterDevice'])) : lstatSync(path, ...rest));
    const answers = [agentsKey(root), agentsKey(root, { lstat })];
    rmSync(agentPath(root, DERIVED_LENS));
    symlinkSync(join(root, CONFIG_REL), agentPath(root, DERIVED_LENS));
    answers.push(agentsKey(root));
    rmSync(agentPath(root, DERIVED_LENS));
    writeFileSync(join(root, WORKFLOW_STAMP), '0.0.1\n');
    answers.push(agentsKey(root));
    writeCheapAgents({ cwd: root, dryRun: false }, { readFile: (path, ...rest) => (path === join(root, WORKFLOW_STAMP) ? `${EXPECTED_WORKFLOW_VERSION}\n` : readFileSync(path, ...rest)) });
    answers.push(agentsKey(root));
    const named = [null, /\.claude\/agents\/gate-triage\.md/u, /\.claude\/agents\/review-lens-opus-xhigh\.md/u, /run \/agent-workflow-kit upgrade first/u, null];
    assert.deepEqual(answers.map(([items, skips]) => [items.length, skips.length]), named.map((pattern) => [0, pattern ? 1 : 0]));
    named.forEach((pattern, index) => pattern && assert.match(answers[index][1][0].reason, pattern));
  });

  it('every filled agents text stays within ITEM_LINE_CAP at every count, and agents.lens-rederive is no WHATS key', () => {
    assert.deepEqual([WHATS['agents.not-current'], WHATS.agents, Object.hasOwn(WHATS, 'agents.lens-rederive')], [KIT_WHAT, PLACE_ONLY_WHAT, false]);
    const total = readBundledAgents().length;
    const fills = [...[0, 1, 9, 10, 99, 100, 999].map((n) => fill(KIT_WHAT, { n })),
      ...Array.from({ length: total + 1 }, (_, n) => [0, 1].filter((ex) => ex <= n).map((ex) => fill(PLACE_ONLY_WHAT, { n, ro: n - ex, ex }))).flat()];
    assert.deepEqual(fills.filter((what) => what.length > ITEM_LINE_CAP || /[{}\r\n]/u.test(what)), []);
  });
});
