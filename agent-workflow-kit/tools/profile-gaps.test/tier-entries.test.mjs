import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED_CONFIG, serializeConfig } from '../orchestration-config.mjs';
import { buildInsertPreview } from '../rules-regions.mjs';
import { failAt, makeProject } from '../tier-preview.test/harness.test.mjs';

const loaded = await import('../profile-gaps.mjs').catch(() => ({}));
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = resolve(HERE, '..');
const MODULE = join(TOOLS, 'profile-gaps.mjs');
const TIER_TOOL = join(TOOLS, 'tier-preview.mjs');
const PROFILE_IDS = JSON.parse(readFileSync(join(TOOLS, '..', 'references', 'reference-profile.json'), 'utf8'))
  .items.map(({ id }) => id);
const IDS = ['story-sessions-section', 'epic-task-slots', 'epic-store-seeded'];
const CONFIG = 'docs/ai/orchestration.json';
const RECORD = 'docs/ai/profile-declines.json';
const STORE = 'docs/ai/epics';
const EVERY_TARGET = { epic: { author: 'solo', review: 'reviewed' }, task: { author: 'delegated', execute: 'subagent' } };
const CONTROL_BYTE = String.fromCharCode(1);
const INVALID_UTF8 = Buffer.from([0x7b, 0xa0, 0x7d]);
const seed = (extra = {}) => serializeConfig({ ...SEED_CONFIG, ...extra });
const entryOf = (id) => {
  const registry = loaded.PROFILE_GAPS;
  assert.ok(Array.isArray(registry), 'profile-gaps.mjs PROFILE_GAPS is absent');
  const entry = registry.find((candidate) => candidate.id === id);
  assert.ok(entry, `the registry carries ${id}`);
  return entry;
};
const readTierConfig = (...args) => {
  assert.equal(typeof loaded.readTierConfig, 'function', 'profile-gaps.mjs readTierConfig is absent');
  return loaded.readTierConfig(...args);
};
// Real reads through deps, each path recorded; readiness and writes throw if touched.
const observedDeps = (extra = {}) => {
  const paths = [];
  const touch = (name) => () => { throw new Error(`a detector called ${name}`); };
  const deps = {
    lstatSync: (path) => { paths.push(path); return lstatSync(path); },
    readFileSync: (path, ...rest) => { paths.push(path); return readFileSync(path, ...rest); },
    detect: touch('detect'), surveyVehicle: touch('surveyVehicle'), writeFile: touch('writeFile'), rename: touch('rename'),
    ...extra,
  };
  return { deps, paths };
};
const detectIn = (id, options, extraDeps = () => ({})) => {
  const { root } = makeProject(options);
  const { deps, paths } = observedDeps(extraDeps(root));
  const result = entryOf(id).detect({ root, deps });
  assert.ok(!(result instanceof Promise), 'detect answers synchronously');
  return { root, result, paths };
};
const assertVerdict = (result, verdict, reason) => {
  assert.deepEqual(result, reason === undefined ? { verdict } : { verdict, reason });
};

describe('spec:tier-offer/S13 the two gap entries', () => {
  it('join the registry after story-sessions-section in profile order, frozen and closed', () => {
    const registry = loaded.PROFILE_GAPS ?? [];
    assert.deepEqual(registry.map(({ id }) => id), [...IDS, 'checker-gates-declared', 'session-close-rules', 'named-queue-row-seed']);
    assert.deepEqual(IDS, PROFILE_IDS.filter((id) => IDS.includes(id)));
    for (const id of IDS.slice(1)) {
      const entry = entryOf(id);
      assert.ok(Object.isFrozen(entry));
      assert.deepEqual(Reflect.ownKeys(entry).sort(), ['apply', 'detect', 'id']);
    }
  });

  for (const id of IDS.slice(1)) {
    for (const [name, options, extraDeps] of [
      ['docs/ai absent', { docsAi: 'absent' }],
      ['docs/ai a symlink', { docsAi: 'symlink' }],
      ['docs/ai a regular file', { docsAi: 'file' }],
      ['a symlinked root', { link: 'root' }],
      ['a symlinked docs component', { link: 'docs' }],
      ['a failed lstat of the root', {}, (root) => failAt(root, 'lstatSync', '')],
      ['a failed lstat of docs', {}, (root) => failAt(root, 'lstatSync', 'docs')],
      ['a failed lstat of docs/ai', {}, (root) => failAt(root, 'lstatSync', 'docs/ai')],
    ]) {
      it(`${id} answers no-deployment for ${name}, probing neither config nor store`, () => {
        const files = { [CONFIG]: seed(EVERY_TARGET), [STORE]: { kind: 'directory' } };
        const { root, result, paths } = detectIn(id, { ...options, files }, extraDeps);
        assertVerdict(result, 'undecidable', 'no-deployment');
        assert.ok(!paths.some((path) => path.startsWith(join(root, CONFIG)) || path.startsWith(join(root, STORE))), paths.join(', '));
      });
    }
  }

  for (const [name, files, verdict, reason, extraDeps] of [
    ['all four slots declared', { [CONFIG]: seed(EVERY_TARGET) }, 'present'],
    ['a roster array among the four', { [CONFIG]: seed({ ...EVERY_TARGET, epic: { author: 'solo', review: ['review-lens'] } }) }, 'present'],
    ['three of the four declared', { [CONFIG]: seed({ ...EVERY_TARGET, task: { author: 'solo' } }) }, 'absent'],
    ['none declared', { [CONFIG]: seed() }, 'absent'],
    ['no config', {}, 'undecidable', 'config-absent'],
    ['a symlinked config', { [CONFIG]: { kind: 'symlink', text: seed(EVERY_TARGET) } }, 'undecidable', 'config-symlink'],
    ['a config directory', { [CONFIG]: { kind: 'directory' } }, 'undecidable', 'config-unreadable'],
    ['a config read failure', { [CONFIG]: seed() }, 'undecidable', 'config-unreadable', (root) => failAt(root, 'readFileSync', CONFIG)],
    ['config bytes that are not UTF-8', { [CONFIG]: INVALID_UTF8 }, 'undecidable', 'config-unreadable'],
    ['a config that is not JSON', { [CONFIG]: '{"epic":' }, 'undecidable', 'config-malformed'],
    ['a config loadConfig refuses', { [CONFIG]: JSON.stringify({ task: { execute: 'council' } }) }, 'undecidable', 'config-invalid'],
  ]) {
    it(`epic-task-slots answers ${verdict}${reason ? ` ${reason}` : ''} for ${name}`, () => {
      const { result } = detectIn('epic-task-slots', { files }, extraDeps);
      assertVerdict(result, verdict, reason);
    });
  }

  for (const [name, spec, verdict, reason, extraDeps] of [
    ['absent', undefined, 'absent'],
    ['an empty directory', { kind: 'directory' }, 'present'],
    ['a directory holding .gitkeep', { kind: 'directory', entries: ['.gitkeep'] }, 'present'],
    ['a regular file', '', 'undecidable', 'store-not-directory'],
    ['a symlink', { kind: 'symlink', text: '' }, 'undecidable', 'store-symlink'],
    ['refused at lstat', { kind: 'directory' }, 'undecidable', 'store-unreadable', (root) => failAt(root, 'lstatSync', STORE)],
  ]) {
    it(`epic-store-seeded answers ${verdict}${reason ? ` ${reason}` : ''} for a store that is ${name}`, () => {
      const { result } = detectIn('epic-store-seeded', { files: { [STORE]: spec } }, extraDeps);
      assertVerdict(result, verdict, reason);
    });
  }

  it('never reads the decline record or the readiness', () => {
    const files = { [CONFIG]: seed(), [RECORD]: JSON.stringify({ schema: 1, declined: { 'epic-task-slots': '4.0.0' } }) };
    for (const id of IDS.slice(1)) {
      const { root, result, paths } = detectIn(id, { files });
      assertVerdict(result, 'absent');
      assert.ok(!paths.includes(join(root, RECORD)), paths.join(', '));
    }
  });

  it('exports the one config probe: the accepted object or one closed reason', () => {
    const { root } = makeProject({ files: { [CONFIG]: seed(EVERY_TARGET) } });
    assert.deepEqual(readTierConfig(root, observedDeps().deps), { config: { ...SEED_CONFIG, ...EVERY_TARGET } });
    const { root: bare } = makeProject();
    assert.deepEqual(readTierConfig(bare, observedDeps().deps), { reason: 'config-absent' });
  });

  it('apply(root) is the builder\'s tier-preview line for both entries, empty when unsafe', () => {
    const root = '/projects/plain-root';
    for (const id of IDS.slice(1)) {
      assert.equal(entryOf(id).apply(root), buildInsertPreview(root, TIER_TOOL));
      assert.equal(entryOf(id).apply(root), `node ${TIER_TOOL} --cwd ${root}`);
      assert.equal(entryOf(id).apply(`${root}${CONTROL_BYTE}`), '');
    }
  });

  it('imports the target table from the reader and names no slot key of its own', () => {
    const source = readFileSync(MODULE, 'utf8');
    assert.match(source, /import\s*\{[^}]*\bTIER_TARGETS\b[^}]*\}\s*from\s*['"]\.\/reference-profile\.mjs['"]/);
    assert.doesNotMatch(source, /['"](?:author|review|execute)['"]/);
  });
});
