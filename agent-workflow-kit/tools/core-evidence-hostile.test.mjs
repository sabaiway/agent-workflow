// core-evidence-hostile.test.mjs — the fingerprint payload and the working state under every
// hostile-git fixture (first-pass-quality plan 1). Red-first on the measured classes: a redirected
// location (null, never another repository's bytes), a throwing runner (null, never a raw stack),
// the duplicated unmerged path. GREEN classes are pinned, not fixed; the two DEFERRED classes are
// pinned as today's behaviour with the plan-3 flip in the title.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { computeFingerprintPayload, computeTreeFingerprint, computeWorkingState, runRedProof } from './core-evidence.mjs';
import { GIT_MAX_BUFFER } from './git-env.mjs';
import { fixtures, skipWithoutGit } from './hostile-git-harness.test.mjs';

// The consumers' seams: the runGit shape (args, dir, input, env) plus the ambient env the location
// is judged under — a consumer's spawns and its location check must read the SAME env.
const runnerUnder = (env) => (args, dir, input, override) => spawnSync('git', args, { cwd: dir, input, env: override ?? env, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
const under = (env) => ({ runGit: runnerUnder(env), env });
const withFixture = (build, body) => {
  const f = build();
  try {
    return body(f);
  } finally {
    f.cleanup();
  }
};
// process.env is the AMBIENT env the default runner reads; a test that sets a variable there
// restores it in `finally`, and node:test runs a file's tests one at a time.
const withAmbient = (vars, body) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

describe('core-evidence under hostile git — RED-first classes', { skip: skipWithoutGit }, () => {
  it('a redirected GIT_DIR in the AMBIENT env: the payload, the fingerprint and the working state are null, never another repository\'s bytes', () => withFixture(fixtures.redirectedGitDir, (f) => {
    withAmbient({ GIT_DIR: f.env.GIT_DIR }, () => {
      assert.equal(computeFingerprintPayload(f.cwd), null);
      assert.equal(computeTreeFingerprint(f.cwd), null);
      assert.equal(computeWorkingState(f.cwd), null);
    });
  }));
  it('a redirected GIT_DIR through the seams: the payload and the working state are null', () => withFixture(fixtures.redirectedGitDir, (f) => {
    assert.equal(computeFingerprintPayload(f.cwd, under(f.env)), null);
    assert.equal(computeWorkingState(f.cwd, under(f.env)), null);
  }));
  it('a throwing runner: the payload and the working state are null, never a raw stack', () => withFixture(fixtures.workTree, (f) => {
    const { runGit } = fixtures.throwingRunner();
    assert.equal(computeFingerprintPayload(f.cwd, { runGit, env: f.env }), null);
    assert.equal(computeWorkingState(f.cwd, { runGit, env: f.env }), null);
  }));
  it('an unmerged index: unstagedPaths names the conflicted path ONCE', () => withFixture(fixtures.unmerged, (f) => {
    const state = computeWorkingState(f.cwd, under(f.env));
    assert.notEqual(state, null);
    assert.deepEqual(state.unstagedPaths, [f.path]);
    assert.equal(state.stagedDirty, true, 'the conflicted index is dirty');
  }));
  it('runRedProof under a redirected AMBIENT env refuses BEFORE any observation runs — the fingerprint stop, never the resolver', () => withFixture(fixtures.redirectedGitDir, (f) => {
    withAmbient({ GIT_DIR: f.env.GIT_DIR }, () => {
      assert.throws(() => runRedProof({ cwd: f.cwd, testId: 'no-such.test.mjs#never runs' }), /cannot compute the tree fingerprint/u, 'the pre-run stop fires before probeBound could even report the file unresolvable');
    });
  }));
  it('a poisoned HOST moves the answer under its own env and none under the hermetic env — the seams carry the env', () => withFixture(fixtures.poisonedHost, (f) => {
    const payloadUnder = (env) => computeFingerprintPayload(f.cwd, under(env));
    assert.ok(payloadUnder(f.env).toString('utf8').includes(`untracked:${f.path}\n`), 'the hermetic env sees the untracked file');
    assert.equal(payloadUnder(f.poisonedEnv).toString('utf8').includes(`untracked:${f.path}\n`), false, 'the host excludes file hides it — the poison is real');
  }));
});

describe('core-evidence under hostile git — GREEN classes pinned, not fixed', { skip: skipWithoutGit }, () => {
  const payloadUnder = (f) => computeFingerprintPayload(f.cwd, under(f.env));
  it('status.showUntrackedFiles=no: the untracked file still rides the payload (ls-files --others, never status)', () => withFixture(fixtures.showUntrackedNo, (f) => {
    assert.ok(payloadUnder(f).toString('utf8').includes(`untracked:${f.path}\n`));
  }));
  it('core.autocrlf=true with a CRLF blob: the tree is clean and the payload is stable across runs', () => withFixture(fixtures.autocrlf, (f) => {
    assert.equal(payloadUnder(f).length, 0, 'a clean tree emits no bytes');
    assert.ok(payloadUnder(f).equals(payloadUnder(f)));
  }));
  it('a held index.lock: the read-only payload and working state still answer', () => withFixture(fixtures.heldIndexLock, (f) => {
    assert.notEqual(payloadUnder(f), null);
    assert.deepEqual(computeWorkingState(f.cwd, under(f.env)).unstagedPaths, []);
  }));
  it('a partially written file: the payload carries the bytes as they are', () => withFixture(fixtures.partialWrite, (f) => {
    const payload = payloadUnder(f);
    assert.notEqual(payload, null);
    assert.ok(payload.toString('latin1').includes(`--- a/${f.path}`));
  }));
  it('a stopped git am: the comparison is unchanged (the sequencer refusal is release-run\'s)', () => withFixture(fixtures.stoppedAm, (f) => withFixture(fixtures.workTree, (plain) => {
    assert.ok(payloadUnder(f).equals(payloadUnder(plain)), 'the same clean comparison as a repository with no sequencer state');
  })));
  it('a conflicted merge: the fingerprint answers and the working state is dirty', () => withFixture(fixtures.unmerged, (f) => {
    assert.match(computeTreeFingerprint(f.cwd, under(f.env)), /^[0-9a-f]{64}$/u);
    assert.equal(computeWorkingState(f.cwd, under(f.env)).stagedDirty, true);
  }));
  it('a hook-shaped env agrees and passes: the payload answers under it', () => withFixture(fixtures.hookShapedEnv, (f) => {
    assert.notEqual(payloadUnder(f), null);
  }));
});

describe('core-evidence under hostile git — DEFERRED classes pinned as today\'s behaviour', { skip: skipWithoutGit }, () => {
  it('textconv (plan 3 flips it with --no-textconv): today two different staged contents hash identically', () => withFixture(fixtures.textconv, (f) => {
    const first = computeTreeFingerprint(f.cwd, under(f.env));
    f.a.write(f.path, 'v3\n');
    f.a.must(['add', f.path]);
    const second = computeTreeFingerprint(f.cwd, under(f.env));
    assert.equal(first, second, 'the textconv-blanked diff cannot tell v2 from v3');
  }));
  it('diff.ignoreSubmodules=all (plan 3 flips it with --ignore-submodules=none): today a staged gitlink beside a visible change leaves the fingerprint put', () => withFixture(fixtures.ignoreSubmodulesAll, (f) => {
    const withGitlink = computeTreeFingerprint(f.cwd, under(f.env));
    f.a.must(['reset', '-q', '--', 'sub']);
    const withoutGitlink = computeTreeFingerprint(f.cwd, under(f.env));
    assert.equal(withGitlink, withoutGitlink, 'the hidden gitlink never entered the payload');
    assert.equal(computeWorkingState(f.cwd, under(f.env)).stagedDirty, true, 'the visible change is still staged');
    assert.ok(f.a.git(['diff', '--cached', '--name-only', '--ignore-submodules=none']).stdout.toString('utf8').includes('f.txt'));
  }));
});
