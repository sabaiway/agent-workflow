// queue-entry.test.mjs — the named-queue-row-seed gap entry (docs/ai/specs/kit/tier/session-rules/,
// part session-gaps). Red first: the registry is imported dynamically, so each cell fails at its
// first lookup of the entry, after its fixture ran for real.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInsertPreview } from '../rules-regions.mjs';
import { makeProject } from '../tier-preview.test/harness.test.mjs';

const loaded = await import('../profile-gaps.mjs').catch(() => ({}));
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = resolve(HERE, '..');
const TIER_TOOL = join(TOOLS, 'tier-preview.mjs');
const SEED = join(TOOLS, '..', 'references', 'authoring', 'QUEUE_TEMPLATE.md');
const PROFILE_IDS = JSON.parse(readFileSync(join(TOOLS, '..', 'references', 'reference-profile.json'), 'utf8'))
  .items.map(({ id }) => id);
const ID = 'named-queue-row-seed';
const REGISTRY = ['story-sessions-section', 'epic-task-slots', 'epic-store-seeded', 'checker-gates-declared',
  'session-close-rules', ID];
const PLANS = 'docs/plans';
const QUEUE = 'docs/plans/queue.md';
const entryOf = (id = ID) => {
  const entry = (loaded.PROFILE_GAPS ?? []).find((candidate) => candidate.id === id);
  assert.ok(entry, `the registry carries ${id}`);
  return entry;
};
const fsError = (code) => Object.assign(new Error(`${code}: injected`), { code });
// Real reads through deps, each call recorded in order; readiness and writes throw if touched.
// failLstat and failRead map a project-relative path (or the seed) to the error code it throws.
const observedDeps = (root, { failLstat = {}, failRead = {} } = {}) => {
  const calls = [];
  const touch = (name) => () => { throw new Error(`the detector called ${name}`); };
  const codeFor = (table, path) => Object.entries(table).find(([rel]) => resolve(root, rel) === path || rel === path)?.[1];
  const deps = {
    lstatSync: (path) => {
      calls.push(['lstatSync', path]);
      const code = codeFor(failLstat, path);
      if (code) throw fsError(code);
      return lstatSync(path);
    },
    readFileSync: (path, ...rest) => {
      calls.push(['readFileSync', path]);
      const code = codeFor(failRead, path);
      if (code) throw fsError(code);
      return readFileSync(path, ...rest);
    },
    detect: touch('detect'), surveyVehicle: touch('surveyVehicle'), writeFile: touch('writeFile'), rename: touch('rename'),
    mkdir: touch('mkdir'), link: touch('link'),
  };
  return { deps, calls };
};
const detectIn = (options, failures) => {
  const { root } = makeProject(options);
  const { deps, calls } = observedDeps(root, failures);
  const result = entryOf().detect({ root, deps });
  assert.ok(!(result instanceof Promise), 'detect answers synchronously');
  return { root, result, calls };
};
const undecidable = (reason) => ({ verdict: 'undecidable', reason });

describe('spec:session-rules/S13 the named-queue-row-seed gap entry', () => {
  it('follows checker-gates-declared and session-close-rules in registry and profile order, frozen and closed', () => {
    assert.deepEqual((loaded.PROFILE_GAPS ?? []).map(({ id }) => id), REGISTRY);
    assert.deepEqual(REGISTRY, PROFILE_IDS.filter((id) => REGISTRY.includes(id)));
    for (const id of ['session-close-rules', ID]) {
      const entry = entryOf(id);
      assert.ok(Object.isFrozen(entry), id);
      assert.deepEqual(Reflect.ownKeys(entry).sort(), ['apply', 'detect', 'id']);
    }
  });

  for (const [name, options, failures] of [
    ['docs/ai absent', { docsAi: 'absent' }],
    ['docs/ai a symlink', { docsAi: 'symlink' }],
    ['docs/ai a regular file', { docsAi: 'file' }],
    ['a symlinked root', { link: 'root' }],
    ['a symlinked docs component', { link: 'docs' }],
    ['a failed lstat of docs', {}, { failLstat: { docs: 'EIO' } }],
  ]) {
    it(`answers undecidable no-deployment for ${name}`, () => {
      assert.deepEqual(detectIn(options, failures).result, undecidable('no-deployment'));
    });
  }

  for (const [name, files, failures] of [
    ['docs/plans absent', {}],
    ['docs/plans an ENOTDIR answer', {}, { failLstat: { [PLANS]: 'ENOTDIR' } }],
    ['docs/plans a directory with no queue', { [PLANS]: { kind: 'directory' } }],
  ]) {
    it(`answers absent for ${name}, reading the installed seed first`, () => {
      const { result, calls } = detectIn({ files }, failures);
      assert.deepEqual(result, { verdict: 'absent' });
      assert.deepEqual(calls.at(-1), ['readFileSync', SEED]);
    });
  }

  for (const [reason, files, failures] of [
    ['plans-symlink', { [PLANS]: { kind: 'symlink', text: 'a file outside' } }],
    ['plans-not-directory', { [PLANS]: 'not a directory' }],
    ['plans-unreadable', { [PLANS]: { kind: 'directory' } }, { failLstat: { [PLANS]: 'EACCES' } }],
    ['queue-symlink', { [QUEUE]: { kind: 'symlink', text: '# Queue\n' } }],
    ['queue-not-regular', { [QUEUE]: { kind: 'directory' } }],
    ['queue-unreadable', { [QUEUE]: '# Queue\n' }, { failLstat: { [QUEUE]: 'EACCES' } }],
  ]) {
    it(`answers undecidable ${reason} and reads no seed`, () => {
      const { result, calls } = detectIn({ files }, failures);
      assert.deepEqual(result, undecidable(reason));
      assert.ok(!calls.some(([, path]) => path === SEED), 'the seed is read only on an absent arm');
    });
  }

  for (const [name, text] of [['a queue with no row', '# Queue\n\n## Queue\n\n### Now\n'], ['a queue whose rows are not named', '# Q\n\n- a note\n'], ['an empty file', '']]) {
    it(`answers present for ${name}, whatever its rows`, () => {
      assert.deepEqual(detectIn({ files: { [QUEUE]: text } }).result, { verdict: 'present' });
    });
  }

  for (const [name, files] of [['no docs/plans', {}], ['docs/plans with no queue', { [PLANS]: { kind: 'directory' } }]]) {
    it(`answers seed-unreadable for ${name} when the installed seed cannot be read`, () => {
      assert.deepEqual(detectIn({ files }, { failRead: { [SEED]: 'EACCES' } }).result, undecidable('seed-unreadable'));
    });
  }

  it('answers present for an existing queue whatever the seed', () => {
    const { result } = detectIn({ files: { [QUEUE]: '# Queue\n' } }, { failRead: { [SEED]: 'EACCES' } });
    assert.deepEqual(result, { verdict: 'present' });
  });

  it('probes docs/plans and then queue.md no-follow through deps', () => {
    const { root, calls } = detectIn({ files: { [QUEUE]: '# Queue\n' } });
    const probed = calls.filter(([name]) => name === 'lstatSync').map(([, path]) => path);
    assert.deepEqual(probed.slice(-2), [resolve(root, PLANS), resolve(root, QUEUE)]);
  });

  it('applies the tier preview line, the empty answer in the no-command cell', () => {
    const { root } = makeProject();
    assert.equal(entryOf().apply(root), buildInsertPreview(root, TIER_TOOL));
    const { root: backtick } = makeProject({ name: `pro${String.fromCharCode(96)}ject` });
    assert.equal(entryOf().apply(backtick), '');
  });
});
