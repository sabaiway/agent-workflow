import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { failAt, makeProject } from '../checker-gates.test/harness.test.mjs';

const loaded = await import('../checker-gates-read.mjs').catch(() => ({}));
const STORE_ROOT = 'docs/ai/specs/index.md';
const SCOPE = 'docs/ai/spec-coverage.json';
const REGULAR = '# a regular file\n';
const GITFILE = 'gitdir: /elsewhere/.git/worktrees/project\n';
const SYMLINK = { kind: 'symlink', text: REGULAR };
const DIRECTORY = { kind: 'directory' };

// stateIn(id, options, extraDeps) → the { state, detail } one candidate answers over a project
// holding an empty declaration and the given placements.
const stateIn = (id, options = {}, extraDeps = () => ({})) => {
  const judge = loaded.judgeCheckerGates ?? (() => { throw new Error('checker-gates-read.mjs judgeCheckerGates is absent'); });
  const { root } = makeProject({ gates: [], ...options });
  const judged = judge(root, extraDeps(root));
  assert.ok(Array.isArray(judged.candidates), JSON.stringify(judged));
  const { state, detail } = judged.candidates.find((candidate) => candidate.id === id);
  return { state, detail };
};

describe('spec:checker-gates/S3 each candidate is offered only over a state where its checker runs', () => {
  describe('control-bytes: a .git directory or a regular gitfile at the root', () => {
    it('is offered over a .git directory and over a regular gitfile', () => {
      assert.equal(stateIn('control-bytes', { git: DIRECTORY }).state, 'offered');
      assert.equal(stateIn('control-bytes', { git: GITFILE }).state, 'offered');
    });

    it('is not-applicable without a .git, over a symlinked .git, and on ENOTDIR', () => {
      assert.equal(stateIn('control-bytes').state, 'not-applicable');
      assert.equal(stateIn('control-bytes', { git: SYMLINK }).state, 'not-applicable');
      assert.equal(stateIn('control-bytes', {}, (root) => failAt(root, 'lstatSync', '.git', 'ENOTDIR')).state, 'not-applicable');
    });

    it('is probe-unreadable on any other lstat failure, naming the path and the code', () => {
      const { state, detail } = stateIn('control-bytes', { git: DIRECTORY }, (root) => failAt(root, 'lstatSync', '.git', 'EACCES'));
      assert.equal(state, 'probe-unreadable');
      assert.match(detail, /\.git/);
      assert.match(detail, /\bEACCES\b/);
    });
  });

  describe('plan-shape: any deployment', () => {
    it('is offered on a bare deployment with no docs/plans and no .git', () => {
      assert.equal(stateIn('plan-shape').state, 'offered');
    });
  });

  describe('spec-check: a regular docs/ai/specs/index.md', () => {
    it('is offered over a regular store root', () => {
      assert.equal(stateIn('spec-check', { storeRoot: REGULAR }).state, 'offered');
    });

    it('is not-applicable when the store root is absent, a symlink, a directory, or under a regular file', () => {
      assert.equal(stateIn('spec-check').state, 'not-applicable');
      assert.equal(stateIn('spec-check', { storeRoot: SYMLINK }).state, 'not-applicable');
      assert.equal(stateIn('spec-check', { storeRoot: DIRECTORY }).state, 'not-applicable');
      assert.equal(stateIn('spec-check', { files: { 'docs/ai/specs': REGULAR } }).state, 'not-applicable');
    });

    it('is probe-unreadable on an lstat failure other than ENOENT and ENOTDIR', () => {
      assert.equal(stateIn('spec-check', { storeRoot: REGULAR }, (root) => failAt(root, 'lstatSync', STORE_ROOT, 'EIO')).state, 'probe-unreadable');
    });
  });

  describe('spec-coverage: a regular docs/ai/spec-coverage.json beside a regular store root', () => {
    it('is offered over the scope and the store root', () => {
      assert.equal(stateIn('spec-coverage', { scope: '{}\n', storeRoot: REGULAR }).state, 'offered');
    });

    it('is not-applicable over the scope alone or the store root alone', () => {
      assert.equal(stateIn('spec-coverage', { scope: '{}\n' }).state, 'not-applicable');
      assert.equal(stateIn('spec-coverage', { storeRoot: REGULAR }).state, 'not-applicable');
    });

    it('is not-applicable over a symlinked or a directory scope', () => {
      assert.equal(stateIn('spec-coverage', { scope: SYMLINK, storeRoot: REGULAR }).state, 'not-applicable');
      assert.equal(stateIn('spec-coverage', { scope: DIRECTORY, storeRoot: REGULAR }).state, 'not-applicable');
    });

    it('is probe-unreadable when either half fails to lstat, distinct from absent', () => {
      const scopeFailed = stateIn('spec-coverage', { scope: '{}\n', storeRoot: REGULAR }, (root) => failAt(root, 'lstatSync', SCOPE, 'EACCES'));
      assert.equal(scopeFailed.state, 'probe-unreadable');
      assert.match(scopeFailed.detail, /spec-coverage\.json/);
      const storeFailed = stateIn('spec-coverage', { scope: '{}\n' }, (root) => failAt(root, 'lstatSync', STORE_ROOT, 'EIO'));
      assert.equal(storeFailed.state, 'probe-unreadable');
      assert.notEqual(storeFailed.state, stateIn('spec-coverage', { scope: '{}\n' }).state);
    });
  });
});
