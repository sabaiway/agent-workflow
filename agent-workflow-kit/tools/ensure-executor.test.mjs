import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENSURE_OPS, WRITE_TOKENS, DRY_RUN_TOKENS } from './ensure-vocabulary.mjs';
import { EXECUTOR_VEHICLE_REL, readBundledAgents } from './cheap-agents-read.mjs';

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
  it('cell 6 previews and applies re-derivation and preserves bytes when rename fails', () => {
    ensureExecutor({ cwd: opening.cwd, kitRoot: KIT_ROOT, dryRun: true });
    for (const settings of [undefined, SETTINGS]) {
      const cwd = makeProject(settings, CUSTOM);
      const target = join(cwd, EXECUTOR_VEHICLE_REL);
      runUnchanged(cwd, true, 'would-re-derive', null, [EXECUTOR_VEHICLE_REL, SETTINGS_REL, 'would', 'rewritten']);
      const expected = snapshot(cwd);
      const body = deriveExpected(settings);
      expected.set(EXECUTOR_VEHICLE_REL, ['file', Buffer.from(body)]);
      const answer = ensureExecutor({ cwd, kitRoot: KIT_ROOT, dryRun: false });
      const fields = settings === undefined ? ['model=opus', 'effort=high'] : ['model=sonnet', 'effort=medium'];
      assertOutcome(answer, 're-derived', null, [EXECUTOR_VEHICLE_REL, SETTINGS_REL, 'hand', 'edit', 'replaced', ...fields]);
      assert.deepEqual(readFileSync(target), Buffer.from(body));
      assert.deepEqual(snapshot(cwd), expected);
      writeFileSync(target, CUSTOM);
      const renames = [];
      const deps = { rename: (from, to) => { renames.push([from, to]); throw Object.assign(new Error('EROFS'), { code: 'EROFS' }); } };
      runUnchanged(cwd, false, 'failed', 'write-refused', [EXECUTOR_VEHICLE_REL, 'EROFS'], { deps });
      assert.equal(renames.length, 1);
      assert.equal(renames[0][1], target);
      assert.equal(readFileSync(target, 'utf8'), CUSTOM);
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
    const index = WRITE_TOKENS.indexOf('re-derived');
    assert.ok(index >= 0);
    assert.equal(DRY_RUN_TOKENS[index], 'would-re-derive');
  });
});
