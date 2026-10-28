import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENSURE_OPS, WRITE_TOKENS, DRY_RUN_TOKENS, ENSURE_TOKENS, RELAYED_ENSURE_TOKENS } from './ensure-vocabulary.mjs';
import { EXECUTOR_VEHICLE_REL, EXPECTED_WORKFLOW_VERSION, readBundledAgents } from './cheap-agents-read.mjs';

const loaded = await import('./ensure-executor.mjs').catch(() => ({}));
const absent = () => { throw new Error('absent'); };
const ensureExecutor = loaded.ensureExecutor ?? absent;
const EXECUTOR_OP = loaded.EXECUTOR_OP ?? absent;
const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS_REL = 'docs/ai/vehicles.json';
const AGENTS_DIR = '.claude/agents';
const SETTINGS = JSON.stringify({ executor: { model: 'sonnet', effort: 'medium', fallback: 'opus' } });
const MALFORMED = '{ not json';
const CUSTOM = '---\nname: executor\nmodel: hand-edit\neffort: low\n---\nKeep until re-derived\n';
const roots = [];
const opening = {};
const deriveExpected = (settings) => {
  const bundled = readBundledAgents().find((item) => item.name === 'executor.md').content;
  return settings === undefined ? bundled : bundled.replace(/^model:.*$/mu, 'model: sonnet').replace(/^effort:.*$/mu, 'effort: medium');
};
const makeProject = (settings, body) => {
  const cwd = mkdtempSync(join(tmpdir(), 'ensure-executor-'));
  roots.push(cwd);
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  if (settings !== undefined) writeFileSync(join(cwd, SETTINGS_REL), settings);
  if (body !== undefined) {
    mkdirSync(join(cwd, AGENTS_DIR), { recursive: true });
    writeFileSync(join(cwd, EXECUTOR_VEHICLE_REL), body);
  }
  return cwd;
};
const snapshot = (cwd) => {
  const entries = new Map();
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      entries.set(relative(cwd, path), entry.isDirectory() ? ['directory'] : entry.isSymbolicLink()
        ? ['symlink', readlinkSync(path)] : ['file', readFileSync(path)]);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(cwd);
  return entries;
};
const placeWrongNode = (cwd, rel, kind) => {
  const path = join(cwd, rel);
  mkdirSync(dirname(path), { recursive: true });
  if (kind === 'directory') mkdirSync(path);
  const target = kind === 'symlink' ? join(cwd, 'link-target') : kind === 'directory' ? join(path, 'keep') : path;
  writeFileSync(target, CUSTOM);
  if (kind === 'symlink') symlinkSync(target, path);
};
const assertTerms = (text, terms) => {
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    assert.match(text, new RegExp(`(?<![\\w./-])${escaped}(?![\\w./-])`, 'u'));
  }
};
const assertOutcome = (answer, token, cause, terms = []) => {
  assert.equal(answer.op, 'executor');
  assert.equal(answer.token, token);
  assert.equal(answer.failed, token === 'failed');
  assert.ok(Array.isArray(answer.lines) && answer.lines.length > 0);
  for (const line of answer.lines) assert.equal(typeof line, 'string');
  if (cause) assert.equal(answer.lines[0].slice(0, cause.length + ' — '.length), `${cause} — `);
  assertTerms(answer.lines.join('\n'), terms);
};
const runUnchanged = (cwd, dryRun, token, cause, terms, extra = {}) => {
  const before = snapshot(cwd);
  const answer = ensureExecutor({ cwd, kitRoot: KIT_ROOT, dryRun, ...extra });
  assertOutcome(answer, token, cause, terms);
  assert.deepEqual(snapshot(cwd), before);
};
const denyRead = (target, calls, error, fallback) => (path, ...args) => {
  if (path === target) { calls.push(path); throw error; }
  return fallback(path, ...args);
};

describe('spec:executor-vehicle/S5', () => {
  beforeEach(() => {
    opening.cwd = makeProject(undefined, deriveExpected());
    opening.before = snapshot(opening.cwd);
  });
  afterEach(() => {
    try { assert.deepEqual(snapshot(opening.cwd), opening.before); }
    finally { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); }
  });
  it('cell 0 refuses unsafe ancestors before reading settings or executor', () => {
    ensureExecutor({ cwd: opening.cwd, kitRoot: KIT_ROOT, dryRun: true });
    for (const [rel, kind] of [['.claude', 'symlink'], [AGENTS_DIR, 'file']]) {
      const cwd = makeProject(MALFORMED);
      placeWrongNode(cwd, rel, kind);
      const reads = [];
      const deps = { readFile: (path, encoding) => { reads.push(path); return readFileSync(path, encoding); } };
      for (const dryRun of [true, false]) runUnchanged(cwd, dryRun, 'failed', 'wrong-node-kind', [rel, kind === 'file' ? 'directory' : kind], { deps });
      assert.deepEqual(reads, []);
    }
  });
  it('cell 1 refuses a symlink or directory at the executor path', () => {
    ensureExecutor({ cwd: opening.cwd, kitRoot: KIT_ROOT, dryRun: true });
    for (const settings of [SETTINGS, MALFORMED]) for (const kind of ['symlink', 'directory']) {
      const cwd = makeProject(settings);
      placeWrongNode(cwd, EXECUTOR_VEHICLE_REL, kind);
      for (const dryRun of [true, false]) runUnchanged(cwd, dryRun, 'failed', 'wrong-node-kind', [EXECUTOR_VEHICLE_REL, kind, 'nothing', 'written']);
    }
  });
  it('cell 2 leaves an absent executor unplaced even with malformed settings', () => {
    ensureExecutor({ cwd: opening.cwd, kitRoot: KIT_ROOT, dryRun: true });
    for (const settings of [undefined, SETTINGS, MALFORMED]) {
      const cwd = makeProject(settings);
      for (const dryRun of [true, false]) runUnchanged(cwd, dryRun, 'not-placed', null, [EXECUTOR_VEHICLE_REL, 'not', 'placed', 'nothing', 'written']);
      assert.equal(existsSync(join(cwd, AGENTS_DIR)), false);
    }
  });
  it('cell 3 refuses malformed and unreadable settings', () => {
    ensureExecutor({ cwd: opening.cwd, kitRoot: KIT_ROOT, dryRun: true });
    for (const failure of ['json', 'read']) {
      const cwd = makeProject(failure === 'json' ? MALFORMED : SETTINGS, CUSTOM);
      const calls = [];
      const error = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      const deps = failure === 'read' ? { readFile: denyRead(join(cwd, SETTINGS_REL), calls, error, readFileSync) } : {};
      const terms = [SETTINGS_REL, 'unreadable', 'nothing', 'written', ...(failure === 'read' ? ['EACCES'] : [])];
      for (const dryRun of [true, false]) runUnchanged(cwd, dryRun, 'failed', 'vehicle-settings-unreadable', terms, { deps });
      if (failure === 'read') assert.equal(calls.length, 2);
    }
  });
  it('cell 4 refuses a bundle without the executor template', () => {
    ensureExecutor({ cwd: opening.cwd, kitRoot: KIT_ROOT, dryRun: true });
    const cwd = makeProject(SETTINGS, CUSTOM);
    const kitRoot = makeProject();
    const bundleDir = join(kitRoot, 'references', 'agents');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, 'other.md'), 'Other template\n');
    const before = snapshot(kitRoot);
    for (const dryRun of [true, false]) runUnchanged(cwd, dryRun, 'failed', 'bundle-unreadable', [EXECUTOR_VEHICLE_REL, 'executor.md', 'missing'], { kitRoot });
    assert.deepEqual(snapshot(kitRoot), before);
  });
  it('cell 5 recognizes the current derived body for either posture', () => {
    ensureExecutor({ cwd: opening.cwd, kitRoot: KIT_ROOT, dryRun: true });
    for (const settings of [undefined, SETTINGS]) {
      const cwd = makeProject(settings, deriveExpected(settings));
      const fields = settings === undefined ? ['model=opus', 'effort=high', 'default'] : ['model=sonnet', 'effort=medium', 'file'];
      for (const dryRun of [true, false]) runUnchanged(cwd, dryRun, 'already-current', null, [EXECUTOR_VEHICLE_REL, SETTINGS_REL, 'source', ...fields, 'nothing', 'written']);
    }
  });
  it('cell 6 answers pending on preview and run without writing or renaming', (t) => {
    ensureExecutor({ cwd: opening.cwd, kitRoot: KIT_ROOT, dryRun: true });
    for (const settings of [undefined, SETTINGS]) {
      const cwd = makeProject(settings, CUSTOM);
      const target = join(cwd, EXECUTOR_VEHICLE_REL);
      const deps = {
        rename: t.mock.fn(() => assert.fail('pending must not rename')),
        writeFile: t.mock.fn(() => assert.fail('pending must not write')),
      };
      for (const dryRun of [true, false]) {
        runUnchanged(cwd, dryRun, 'pending', null,
          [EXECUTOR_VEHICLE_REL, SETTINGS_REL, 'agents', 'nothing', 'written'], { deps });
        assert.deepEqual(readFileSync(target), Buffer.from(CUSTOM));
      }
      assert.equal(deps.rename.mock.callCount(), 0);
      assert.equal(deps.writeFile.mock.callCount(), 0);
    }
  });
  it('cell 7 propagates ancestor and executor probe and read errors without writing', () => {
    ensureExecutor({ cwd: opening.cwd, kitRoot: KIT_ROOT, dryRun: true });
    for (const [name, fallback, rel] of [
      ['lstat', lstatSync, '.claude'], ['lstat', lstatSync, AGENTS_DIR],
      ['lstat', lstatSync, EXECUTOR_VEHICLE_REL], ['readFile', readFileSync, EXECUTOR_VEHICLE_REL],
    ]) {
      const cwd = makeProject(SETTINGS, CUSTOM);
      const calls = [];
      const injectedError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      const deps = { [name]: denyRead(join(cwd, rel), calls, injectedError, fallback) };
      for (const dryRun of [true, false]) {
        const before = snapshot(cwd);
        assert.throws(() => ensureExecutor({ cwd, kitRoot: KIT_ROOT, dryRun, deps }), (error) => error === injectedError);
        assert.deepEqual(snapshot(cwd), before);
        assert.equal(readFileSync(join(cwd, EXECUTOR_VEHICLE_REL), 'utf8'), CUSTOM);
      }
      assert.equal(calls.length, 2);
    }
  });
  it('owns the fifth slot and the matching write and preview tokens', () => {
    typeof EXECUTOR_OP === 'function' ? EXECUTOR_OP() : EXECUTOR_OP;
    assert.equal(EXECUTOR_OP, 'executor');
    assert.equal(ENSURE_OPS[4], 'executor');
    assert.equal(ENSURE_OPS[3], 'vehicles');
    for (const tokens of [WRITE_TOKENS, DRY_RUN_TOKENS]) {
      assert.equal(tokens.includes('re-derived'), false);
      assert.equal(tokens.includes('would-re-derive'), false);
    }
    for (const tokens of [ENSURE_TOKENS, RELAYED_ENSURE_TOKENS]) assert.ok(tokens.includes('pending'));
  });
});

describe('spec:carriers/S27 the executor ensure names the advisor agents item and claims no route', () => {
  afterEach(() => {
    while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
  });
  it('the not-placed and pending lines name the agents item, their tokens unchanged and nothing written', () => {
    const lines = {};
    for (const [token, body] of [['not-placed', undefined], ['pending', CUSTOM]]) {
      const cwd = makeProject(SETTINGS, body);
      for (const dryRun of [true, false]) runUnchanged(cwd, dryRun, token, null, []);
      lines[token] = ensureExecutor({ cwd, kitRoot: KIT_ROOT, dryRun: true }).lines;
    }
    assert.deepEqual(lines, {
      'not-placed': [`${EXECUTOR_VEHICLE_REL}: not placed — nothing written; the advisor's agents item places it`],
      pending: [`${EXECUTOR_VEHICLE_REL}: differs from the body derived from ${SETTINGS_REL} — nothing written; the advisor's agents item writes the derived body`],
    });
  });
  it('recommendations.mjs names no executorBodyDiffers', () => {
    assert.equal(/\bexecutorBodyDiffers\b/u.test(readFileSync(join(KIT_ROOT, 'tools', 'recommendations.mjs'), 'utf8')), false);
  });
});

describe('spec:init-project/S51 configs finish over a differing executor', () => {
  afterEach(() => {
    while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
  });
  it('cell 6 keeps executorBodyDiffers of the read core, no advisor probe calls it, and the ensure imports no atomic write', () => {
    const tools = join(KIT_ROOT, 'tools');
    const source = readFileSync(join(tools, 'ensure-executor.mjs'), 'utf8');
    assert.match(source, /import\s*\{[^}]*\bexecutorBodyDiffers\b[^}]*\}\s*from\s*['"]\.\/cheap-agents-read\.mjs['"]/u);
    assert.doesNotMatch(source, /import[^;]*atomic-write/u);
    assert.equal(/\bexecutorBodyDiffers\b/u.test(readFileSync(join(tools, 'recommendations.mjs'), 'utf8')), false, 'no advisor probe calls it');
    const declarations = readdirSync(tools).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
      .filter((name) => /\b(?:const|function)\s+executorBodyDiffers\b/u.test(readFileSync(join(tools, name), 'utf8')));
    assert.deepEqual(declarations, ['cheap-agents-read.mjs']);
    assert.match(readFileSync(join(tools, declarations[0]), 'utf8'), /export const executorBodyDiffers\b/u);
  });
  for (const state of ['absent', 'symlink', 'directory', 'malformed', 'unreadable', 'custom', 'derived', 'read-error']) {
    it(`executorBodyDiffers judges ${state} without writing`, async () => {
      const cwd = makeProject(state === 'malformed' ? MALFORMED : SETTINGS);
      if (['symlink', 'directory'].includes(state)) placeWrongNode(cwd, EXECUTOR_VEHICLE_REL, state);
      else if (state !== 'absent') {
        mkdirSync(join(cwd, AGENTS_DIR), { recursive: true });
        writeFileSync(join(cwd, EXECUTOR_VEHICLE_REL), state === 'derived' ? deriveExpected(SETTINGS) : CUSTOM);
      }
      const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      const target = join(cwd, state === 'unreadable' ? SETTINGS_REL : EXECUTOR_VEHICLE_REL);
      const deps = ['unreadable', 'read-error'].includes(state)
        ? { readFile: denyRead(target, [], denied, readFileSync) } : {};
      const before = snapshot(cwd);
      const loaded = await import('./cheap-agents-read.mjs');
      const executorBodyDiffers = loaded.executorBodyDiffers ?? (() => { throw new Error('executorBodyDiffers is absent'); });
      if (state === 'read-error') assert.throws(() => executorBodyDiffers(cwd, deps), denied);
      else assert.equal(executorBodyDiffers(cwd, deps), state === 'custom');
      assert.deepEqual(snapshot(cwd), before);
    });
  }
  it('keeps all other configs tokens and renders both the agents kit item and the global-footprint item', async () => {
    const { main } = await import('./ensure-configs.mjs');
    const { buildRecommendations, formatRecommendations } = await import('./recommendations.mjs');
    const cwd = makeProject();
    const home = makeProject();
    const run = (body) => {
      rmSync(cwd, { recursive: true, force: true });
      mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
      writeFileSync(join(cwd, 'package.json'), '{"name":"fixture"}\n');
      writeFileSync(join(cwd, 'docs/ai/.workflow-version'), EXPECTED_WORKFLOW_VERSION);
      writeFileSync(join(cwd, SETTINGS_REL), SETTINGS);
      if (body !== undefined) {
        mkdirSync(join(cwd, AGENTS_DIR), { recursive: true });
        writeFileSync(join(cwd, EXECUTOR_VEHICLE_REL), body);
      }
      return main(['--reconcile', '--cwd', cwd], { kitRoot: KIT_ROOT });
    };
    const tokensOf = (stdout) => stdout.split('\n').map((line) => line.match(/^ {2}([a-z-]+): ([a-z-]+)$/u))
      .filter(Boolean).map(([, op, token]) => ({ op, token }));
    const baseline = run();
    const differing = run(CUSTOM);
    assert.equal(baseline.code, 0, baseline.stderr);
    assert.equal(differing.code, 0, differing.stderr);
    const tokens = tokensOf(differing.stdout);
    assert.deepEqual(tokens.map(({ op }) => op), ENSURE_OPS);
    assert.deepEqual(tokens.find(({ op }) => op === 'executor'), { op: 'executor', token: 'pending' });
    assert.deepEqual(tokens.filter(({ op }) => op !== 'executor'), tokensOf(baseline.stdout).filter(({ op }) => op !== 'executor'));
    assert.deepEqual(readFileSync(join(cwd, EXECUTOR_VEHICLE_REL)), Buffer.from(CUSTOM));
    const deps = {
      home,
      planGlobalRemoval: () => ({ source: '/h/.gitignore_global', before: 'x', after: '', removedLines: ['x'] }),
    };
    const result = buildRecommendations({ cwd, deps });
    const differingItem = result.items.find((item) => item.variant === 'agents.not-current');
    const globalItem = result.items.find((item) => item.key === 'footprint-global');
    assert.ok(differingItem?.detail.includes(EXECUTOR_VEHICLE_REL), JSON.stringify(result.skips));
    assert.ok(globalItem, JSON.stringify(result.skips));
    const rendered = formatRecommendations(result);
    assert.ok(rendered.includes(differingItem.what));
    assert.ok(rendered.includes(globalItem.what));
  });
});
