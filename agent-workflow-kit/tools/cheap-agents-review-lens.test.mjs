import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENTS_DIR, WORKFLOW_STAMP, EXPECTED_WORKFLOW_VERSION, CHEAP_AGENTS_BUNDLE, CHEAP_AGENTS_VEHICLES,
  readBundledAgents, writeCheapAgents, formatResult, main,
} from './cheap-agents.mjs';
import { buildRecommendations, WHATS, ITEM_LINE_CAP } from './recommendations.mjs';

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
const lensRederiveWhat = () => need(WHATS['agents.lens-rederive'], 'WHATS[agents.lens-rederive]');

const LENS = 'review-lens.md';
const LENS_REL = `${AGENTS_DIR}/${LENS}`;
const EXECUTOR = 'executor.md';
const SWEEP = 'mechanical-sweep.md';
const DERIVED_LENS = 'review-lens-opus-xhigh.md';
const SETTINGS_REL = 'docs/ai/vehicles.json';
const CONFIG_REL = 'docs/ai/orchestration.json';
const REVIEW = { 'plan-execution': { review: ['review-lens:opus:xhigh'] } };
const CUSTOM_EXECUTOR = '---\nname: executor\ntools: Read, Bash\n---\nHand edit\n';
const LENS_LABEL = 're-derived — the earlier body was replaced; set its model and effort in docs/ai/vehicles.json';
const EXECUTOR_LABEL = 're-derived — a hand edit was replaced; set the model in docs/ai/vehicles.json';
const PLACE_ONLY_WHAT = '{n} bundled subagent vehicle(s) not placed (Claude Code) — {ro} read-only, {ex} the full-tool executor; the apply PREVIEWS first';
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
const agentsItem = (root) => buildRecommendations({ cwd: root, deps: advisorDeps(root) }).items.find((item) => item.key === 'agents');

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

it('re-derives a differing placed lens, keeps every other customized vehicle and prints the lens posture', () => {
  for (const [settings, posture] of [
    [undefined, { model: 'opus', effort: 'high', source: 'default' }],
    [settingsWith({ model: 'sonnet', effort: 'high' }), { model: 'sonnet', effort: 'high', source: 'file' }],
  ]) {
    const root = makeProject(settings, REVIEW);
    assert.deepEqual(readReviewLensPosture(root), { posture, reason: null });
    writeCheapAgents({ cwd: root, dryRun: false });
    const kept = { [SWEEP]: 'Customized sweep\n', [DERIVED_LENS]: 'Customized derived lens\n' };
    for (const [name, body] of Object.entries({ ...kept, [EXECUTOR]: CUSTOM_EXECUTOR, [LENS]: STALE })) {
      writeFileSync(agentPath(root, name), body);
    }
    for (const dryRun of [true, false]) {
      const result = writeCheapAgents({ cwd: root, dryRun });
      const actionOf = (name) => result.plan.find((item) => item.name === name).action;
      assert.equal(actionOf(LENS), 're-derive');
      assert.equal(actionOf(SWEEP), 'customized-preserved');
      assert.equal(actionOf(DERIVED_LENS), 'customized-preserved');
      assert.deepEqual(result.lensPosture, posture);
      assertPostureLine(result, posture);
      assert.equal(rowLine(result, LENS), `  - ${LENS_REL}: ${dryRun ? 'would re-derive' : LENS_LABEL}`);
      assert.equal(rowLine(result, EXECUTOR), `  - ${AGENTS_DIR}/${EXECUTOR}: ${dryRun ? 'would re-derive' : EXECUTOR_LABEL}`);
      const expected = dryRun ? STALE : withPosture(BUNDLED, posture.model, posture.effort);
      assert.equal(readFileSync(agentPath(root, LENS), 'utf8'), expected);
      for (const [name, body] of Object.entries(kept)) assert.equal(readFileSync(agentPath(root, name), 'utf8'), body);
    }
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

it('the agents offer counts the lens re-derive beside the placements and never the executor re-derive', () => {
  const root = makeProject();
  writeCheapAgents({ cwd: root, dryRun: false });
  const placed = Object.fromEntries(readdirSync(join(root, AGENTS_DIR)).map((name) => [name, readFileSync(agentPath(root, name), 'utf8')]));
  writeFileSync(agentPath(root, LENS), STALE);
  const lensOnly = agentsItem(root);
  assert.equal(lensOnly?.what, fill(lensRederiveWhat(), { n: 0, ro: 0, ex: 0 }));
  assert.equal(lensOnly.variant, 'agents');
  for (const name of [SWEEP, EXECUTOR]) rmSync(agentPath(root, name));
  assert.equal(agentsItem(root)?.what, fill(lensRederiveWhat(), { n: 2, ro: 1, ex: 1 }));
  for (const [name, body] of Object.entries(placed)) writeFileSync(agentPath(root, name), body);
  assert.equal(agentsItem(root), undefined);
  writeFileSync(agentPath(root, EXECUTOR), CUSTOM_EXECUTOR);
  assert.equal(agentsItem(root), undefined);
  rmSync(agentPath(root, SWEEP));
  assert.equal(WHATS.agents, PLACE_ONLY_WHAT);
  assert.equal(agentsItem(root)?.what, fill(PLACE_ONLY_WHAT, { n: 1, ro: 1, ex: 0 }));
});

it('every filled agents text stays within ITEM_LINE_CAP at every count the bundle can reach', () => {
  const lensWhat = lensRederiveWhat();
  for (const pattern of [/review-lens\.md/u, /docs\/ai\/vehicles\.json/u, /\{n\}/u, /\{ro\}/u, /\{ex\}/u]) assert.match(lensWhat, pattern);
  const total = readBundledAgents().length;
  for (const [template, max] of [[lensWhat, total - 1], [WHATS.agents, total]]) {
    for (let n = 0; n <= max; n += 1) {
      for (const ex of [0, 1].filter((count) => count <= n)) {
        const what = fill(template, { n, ro: n - ex, ex });
        assert.ok(what.length <= ITEM_LINE_CAP, `${what.length}: ${what}`);
        assert.doesNotMatch(what, /[{}\r\n]/u);
      }
    }
  }
});
