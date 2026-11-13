import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixtureRepo } from '../../scripts/testing/fixture-repo.mjs';
import { hermeticGitEnv } from './git-env.mjs';
import { buildRecommendations } from './recommendations.mjs';
import { shellQuoteArg } from './repo-lex.mjs';
import { SOURCE_SIZE_DEFAULTS } from './source-size-core.mjs';
import { EXPECTED_WORKFLOW_VERSION } from './velocity-profile.mjs';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const TOOL = join(TOOLS, 'source-size-check.mjs');
const TEMPORARY = mkdtempSync(join(tmpdir(), 'recommendations-size-reason-'));
after(() => rmSync(TEMPORARY, { recursive: true, force: true }));
const GIT_ENVIRONMENT = hermeticGitEnv(process.env, TEMPORARY);
for (const key of Object.keys(process.env)) {
  if (!Object.hasOwn(GIT_ENVIRONMENT, key)) delete process.env[key];
}
Object.assign(process.env, GIT_ENVIRONMENT);

const INITIAL_REASON = 'initial adoption';
const PLACEHOLDER = '<why this size is accepted>';
const REASON_AUTHOR_RECIPE = 'the reason is yours to write, with no question to the user: where you made the growth, say why this size is accepted; where an entry grew before this write (a half-written record, a raise after the schema move, a teammate\'s growth), write that it grew before this write and its cause was not recorded';
const NO_GATE = 'no source-size gate is declared \u2014 the gate matrix runs no size check, so no gate run stops a file beyond its limits';
const RECORD_KEPT = 'no source-size gate is declared \u2014 the size record is kept as it is; declaring the gate adds the size check to the gate matrix';
const ID_SQUATTER = 'a gate carries the source-size id but is not this checker \u2014 the gate matrix reads as running the size check while it runs none';
const AUTHORED = { schema: 2, roots: ['src'], exclude: [], extensions: ['.mjs'] };
const AGGREGATE = { src: { lines: 1, reason: 'existing record' } };
const LAYOUT = { roots: { src: { files: 1, reason: 'existing record' } }, directories: {} };
const MINTED = { ...AUTHORED, baseline: {}, aggregate: AGGREGATE, layout: LAYOUT };
const MINTED_SCHEMA1 = {
  ...AUTHORED, schema: 1, defaults: SOURCE_SIZE_DEFAULTS, baseline: {}, aggregate: AGGREGATE,
};
const LANES = {
  'source-size': 'chat',
  'source-size.unminted': 'chat',
  'source-size.schema-1': 'chat',
  'source-size.id-squatter': 'user',
  'source-size.layout': 'chat',
  'source-size.piles': 'chat',
  'source-size.adopted-elsewhere': 'chat',
};
const CONFIGURATIONS = [
  { label: 'absent', config: null, reason: INITIAL_REASON, detail: null },
  { label: 'authored without machine halves', config: AUTHORED, reason: INITIAL_REASON, detail: null },
  {
    label: 'incomplete with baseline only', config: { ...AUTHORED, baseline: {} },
    reason: PLACEHOLDER, detail: REASON_AUTHOR_RECIPE,
  },
  {
    label: 'incomplete with aggregate only', config: { ...AUTHORED, aggregate: AGGREGATE },
    reason: PLACEHOLDER, detail: REASON_AUTHOR_RECIPE,
  },
  {
    label: 'authored holding layout', config: { ...AUTHORED, layout: LAYOUT },
    reason: PLACEHOLDER, detail: REASON_AUTHOR_RECIPE,
  },
  { label: 'unreadable JSON', config: '{ not JSON', reason: INITIAL_REASON, detail: null },
  { label: 'minted schema 2', config: MINTED, reason: null, detail: REASON_AUTHOR_RECIPE },
];

const runGit = (cwd, arguments_) => {
  const result = spawnSync('git', arguments_, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${arguments_.join(' ')}: ${result.stderr}`);
};
const hermeticDeps = (root) => ({
  findWrapper: () => false, home: root,
  env: GIT_ENVIRONMENT, getenv: { PATH: '/nonexistent-path-for-tests' },
});
const createProject = ({ config, gate = 'none', queue = false }) => {
  const root = mkdtempSync(join(TEMPORARY, 'project with spaces-'));
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  mkdirSync(join(root, 'src'));
  makeFixtureRepo((arguments_) => runGit(root, arguments_), root, ['-q', '-b', 'main']);
  writeFileSync(join(root, 'src', 'entry.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'reason-fixture', scripts: {} }));
  writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), `${EXPECTED_WORKFLOW_VERSION}\n`);
  if (config !== null) {
    writeFileSync(join(root, 'docs', 'ai', 'source-size.json'),
      typeof config === 'string' ? config : JSON.stringify(config));
  }
  if (gate !== 'none') {
    const checker = gate === 'elsewhere' ? join(root, 'vendor', 'source-size-check.mjs') : TOOL;
    if (gate === 'elsewhere') {
      mkdirSync(dirname(checker), { recursive: true });
      writeFileSync(checker, 'export {};\n');
    }
    const cmd = gate === 'squatter' ? 'true' : `node "${checker}" --check`;
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({
      gates: [{ id: 'source-size', title: 'Source size', cmd }],
    }));
  }
  if (queue) {
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'queue.md'), '# Queue\n\n### Later\n');
  }
  runGit(root, ['add', '-A']);
  return root;
};
const readRecommendations = (root) => buildRecommendations({ cwd: root, deps: hermeticDeps(root) });
const requireItem = (report, variant) => {
  const item = report.items.find((entry) => entry.variant === variant);
  assert.ok(item, `${variant} must render; skips: ${JSON.stringify(report.skips)}`);
  return item;
};
const commandLine = (root, mode, reason = null) =>
  `node ${shellQuoteArg(TOOL)} ${mode}${reason === null ? '' : ` --reason "${reason}"`} --cwd ${shellQuoteArg(root)}`;
const assertIdentity = (item) => {
  assert.equal(item.key, 'source-size');
  assert.ok(Object.hasOwn(LANES, item.variant), `unexpected variant ${item.variant}`);
  assert.equal(item.lane, LANES[item.variant], item.variant);
  assert.equal(item.check, null, `${item.variant} keeps its current writer lane`);
};
const assertWriters = (report, root, { gate = 'none', reason = null } = {}) => {
  const items = report.items.filter((entry) => entry.key.startsWith('source-size'));
  assert.ok(items.length > 0, 'the fixture renders a source-size item');
  for (const item of items) {
    assertIdentity(item);
    if (item.variant === 'source-size') assert.equal(item.apply, commandLine(root, '--adopt', reason));
    if (item.variant === 'source-size.unminted') {
      assert.equal(item.apply, commandLine(root, gate === 'elsewhere' ? '--write-baseline' : '--adopt', reason));
    }
    if (item.variant === 'source-size.schema-1') assert.equal(item.apply, commandLine(root, '--write-baseline'));
    if (item.variant === 'source-size.layout') {
      const arguments_ = ['--write-baseline', '--layout', '--reason', INITIAL_REASON].map(shellQuoteArg).join(' ');
      assert.equal(item.apply, `node ${shellQuoteArg(TOOL)} ${arguments_} --cwd ${shellQuoteArg(root)}`);
    }
    if (item.variant === 'source-size.piles') {
      assert.equal(item.apply,
        `node ${shellQuoteArg(join(TOOLS, 'source-size/piles-cli.mjs'))} --write --cwd ${shellQuoteArg(root)}`);
    }
    if (item.variant === 'source-size.adopted-elsewhere') {
      const prefix = `node ${shellQuoteArg(join(TOOLS, 'ack-write.mjs'))} --lane source-size-copy --fingerprint `;
      assert.ok(item.apply.startsWith(prefix), item.apply);
      const fingerprint = item.apply.slice(prefix.length, prefix.length + 16);
      assert.match(fingerprint, /^[0-9a-f]{16}$/);
      assert.equal(item.apply, `${prefix}${fingerprint} --cwd ${shellQuoteArg(root)}`);
    }
    if (item.variant === 'source-size.id-squatter') {
      assert.equal(item.apply, `your own step \u2014 in docs/ai/gates.json rename the "source-size" gate to an id of its own, or repoint its cmd at node "${TOOL}" --check, then run /agent-workflow-kit recommendations`);
    }
  }
};
const assertMeasuredWording = (report) => {
  const items = report.items.filter((entry) => entry.key.startsWith('source-size'));
  assert.ok(items.length > 0, 'the fixture renders a source-size item');
  for (const item of items) assert.doesNotMatch(item.what, /unmeasured/i, item.variant);
};

describe('spec:source-size/S65 the advisor states the gate facts and leaves the reason to its author', () => {
  for (const state of CONFIGURATIONS) {
    it(`no gate / ${state.label} / text reason recipe and identity`, () => {
      const root = createProject(state);
      const report = readRecommendations(root);
      const item = requireItem(report, 'source-size');
      for (const entry of report.items.filter((entry) => entry.key.startsWith('source-size'))) assertIdentity(entry);
      assert.deepEqual([item.what, item.apply, item.detail], [
        state.reason === null ? RECORD_KEPT : NO_GATE,
        commandLine(root, '--adopt', state.reason), state.detail,
      ]);
      assertWriters(report, root, state);
      assertMeasuredWording(report);
    });
  }

  for (const gate of ['canonical', 'elsewhere']) {
    for (const state of CONFIGURATIONS.filter((entry) =>
      entry.config !== null && typeof entry.config !== 'string' && entry.reason !== null)) {
      it(`${gate} gate / ${state.label} / mint reason recipe and identity`, () => {
        const root = createProject({ ...state, gate });
        const report = readRecommendations(root);
        const item = requireItem(report, 'source-size.unminted');
        assertIdentity(item);
        assert.deepEqual([item.apply, item.detail], [
          commandLine(root, gate === 'canonical' ? '--adopt' : '--write-baseline', state.reason), state.detail,
        ]);
        assertWriters(report, root, { ...state, gate });
        assertMeasuredWording(report);
      });
    }
  }

  it('minted schema 1 / exact reason author recipe', () => {
    const root = createProject({ config: MINTED_SCHEMA1 });
    const report = readRecommendations(root);
    const item = requireItem(report, 'source-size.schema-1');
    assertWriters(report, root);
    assert.equal(item.detail, REASON_AUTHOR_RECIPE);
    assertMeasuredWording(report);
  });

  it('id squatter / exact what', () => {
    const root = createProject({ config: AUTHORED, gate: 'squatter' });
    const report = readRecommendations(root);
    const item = requireItem(report, 'source-size.id-squatter');
    assertWriters(report, root);
    assert.equal(item.what, ID_SQUATTER);
    assertMeasuredWording(report);
  });

  const remainingVariants = [
    {
      label: 'layout not started', config: { ...AUTHORED, baseline: {}, aggregate: AGGREGATE },
      gate: 'canonical', variant: 'source-size.layout',
    },
    {
      label: 'recorded pile', queue: true, gate: 'canonical', variant: 'source-size.piles',
      config: { ...MINTED, layout: { ...LAYOUT, directories: { src: { entries: 23, reason: 'existing pile' } } } },
    },
    { label: 'adopted elsewhere', config: MINTED, gate: 'elsewhere', variant: 'source-size.adopted-elsewhere' },
  ];
  for (const state of remainingVariants) {
    it(`${state.label} / existing variants lanes and writers`, () => {
      const root = createProject(state);
      const report = readRecommendations(root);
      requireItem(report, state.variant);
      assertWriters(report, root, state);
      assertMeasuredWording(report);
    });
  }
});
