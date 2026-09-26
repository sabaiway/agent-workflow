import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInsertPreview } from '../rules-regions.mjs';
import { KIT_TOOLS, failAt, makeProject } from '../checker-gates.test/harness.test.mjs';

const loaded = await import('../profile-gaps.mjs').catch(() => ({}));
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = resolve(HERE, '..');
const MODULE = join(TOOLS, 'profile-gaps.mjs');
const VERB = join(TOOLS, 'checker-gates.mjs');
const ID = 'checker-gates-declared';
const IDS = ['story-sessions-section', 'epic-task-slots', 'epic-store-seeded', ID, 'session-close-rules', 'named-queue-row-seed'];
const PROBED = { git: { kind: 'directory' }, storeRoot: '# Specs\n', scope: '{}\n' };
const PLAN_SHAPE = { id: 'mine', title: 't', cmd: `node "${KIT_TOOLS['plan-shape']}" --check --in-flight` };
const entryOf = () => {
  const entry = (loaded.PROFILE_GAPS ?? []).find(({ id }) => id === ID);
  assert.ok(entry, `the registry carries ${ID}`);
  return entry;
};
// Real reads through deps, each lstat path recorded; readiness and writes throw if touched.
const observedDeps = (extra = {}) => {
  const paths = [];
  const touch = (name) => () => { throw new Error(`the detector called ${name}`); };
  const deps = {
    lstatSync: (path) => { paths.push(path); return lstatSync(path); },
    readFileSync,
    detect: touch('detect'), surveyVehicle: touch('surveyVehicle'), writeFile: touch('writeFile'), rename: touch('rename'),
    ...extra,
  };
  return { deps, paths };
};
const detectIn = (options, extraDeps = () => ({})) => {
  const { root, base } = makeProject(options);
  const { deps, paths } = observedDeps(extraDeps(root, base));
  const result = entryOf().detect({ root, deps });
  assert.ok(!(result instanceof Promise), 'detect answers synchronously');
  return { root, result, paths };
};

describe('spec:checker-gates/S14 the checker-gates-declared gap entry', () => {
  it('joins the registry after epic-store-seeded, frozen and closed', () => {
    assert.deepEqual((loaded.PROFILE_GAPS ?? []).map(({ id }) => id), IDS);
    const entry = entryOf();
    assert.ok(Object.isFrozen(entry));
    assert.deepEqual(Reflect.ownKeys(entry).sort(), ['apply', 'detect', 'id']);
  });

  it('answers undecidable no-deployment first, whatever the declaration holds', () => {
    for (const docsAi of ['absent', 'symlink', 'file']) {
      assert.deepEqual(detectIn({ docsAi }).result, { verdict: 'undecidable', reason: 'no-deployment' }, docsAi);
    }
    const failed = detectIn({ ...PROBED, gates: [] }, (root) => failAt(root, 'lstatSync', 'docs', 'EIO'));
    assert.deepEqual(failed.result, { verdict: 'undecidable', reason: 'no-deployment' });
  });

  it('answers undecidable with the declaration state as the reason', () => {
    assert.deepEqual(detectIn(PROBED).result, { verdict: 'undecidable', reason: 'declaration-absent' });
    assert.deepEqual(detectIn({ ...PROBED, gates: '{' }).result, { verdict: 'undecidable', reason: 'declaration-malformed' });
  });

  it('answers absent only when at least one candidate is offered, id-taken beside it included', () => {
    assert.deepEqual(detectIn({ gates: [] }).result, { verdict: 'absent' });
    const taken = detectIn({ ...PROBED, gates: [{ id: 'control-bytes', title: 't', cmd: 'npm run bytes' }] });
    assert.deepEqual(taken.result, { verdict: 'absent' });
  });

  it('answers present when nothing is offered and nothing is id-taken, probe-unreadable or withheld', () => {
    const { result } = detectIn({ gates: [PLAN_SHAPE] });
    assert.deepEqual(result, { verdict: 'present' });
    assert.ok(!Object.hasOwn(result, 'reason'));
  });

  it('answers undecidable with the state word of the first such candidate in table order', () => {
    const takenFirst = detectIn(
      { storeRoot: '# Specs\n', gates: [{ id: 'control-bytes', title: 't', cmd: 'npm run bytes' }, PLAN_SHAPE] },
      (root) => failAt(root, 'lstatSync', 'docs/ai/specs/index.md', 'EACCES'),
    );
    assert.deepEqual(takenFirst.result, { verdict: 'undecidable', reason: 'id-taken' });
    const unreadable = detectIn({ gates: [PLAN_SHAPE] }, (root) => failAt(root, 'lstatSync', '.git', 'EACCES'));
    assert.deepEqual(unreadable.result, { verdict: 'undecidable', reason: 'probe-unreadable' });
    const withheld = detectIn({ gates: [] }, (root, base) => ({ kitToolsDir: join(base, 'kit"tools') }));
    assert.deepEqual(withheld.result, { verdict: 'undecidable', reason: 'withheld' });
  });

  it('reads the probes through deps', () => {
    const { root, paths } = detectIn({ ...PROBED, gates: [] });
    for (const rel of ['.git', 'docs/ai/specs/index.md', 'docs/ai/spec-coverage.json']) {
      assert.ok(paths.includes(resolve(root, rel)), rel);
    }
  });

  it('applies the builder preview line for checker-gates.mjs, the empty answer in the no-command cell', () => {
    const { root } = makeProject({ gates: [] });
    assert.equal(entryOf().apply(root), buildInsertPreview(root, VERB));
    const { root: backtick } = makeProject({ gates: [], name: `pro${String.fromCharCode(96)}ject` });
    assert.equal(entryOf().apply(backtick), '');
  });

  it('imports the read leaf and never the verb', () => {
    const source = readFileSync(MODULE, 'utf8');
    assert.match(source, /from '\.\/checker-gates-read\.mjs'/);
    assert.doesNotMatch(source, /from '\.\/checker-gates\.mjs'/);
  });
});
