// source-size-scope-hostile.test.mjs — enumerateIndex under the hostile-git fixtures (first-pass-
// quality plan 1). Red-first: a redirected location and a throwing spawn both refuse inside the
// existing enumeration-error class (exit 2, the configFail lane), naming the cause. Pinned: a held
// lock, the conflict stages, a signal and ENOENT keep their answers.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { enumerateIndex, resolveScope } from './source-size-scope.mjs';
import { SOURCE_SIZE_STOP } from './source-size-refusal.mjs';
import { fixtures, skipWithoutGit } from './hostile-git-harness.test.mjs';

// The spawn seam shape (cmd, args, opts), bound to a fixture env unless the caller names one (the
// location leaf names its own ambient and stripped envs).
const spawnUnder = (env) => (cmd, args, opts) => spawnSync(cmd, args, { ...opts, env: opts.env ?? env });
const withFixture = (build, body) => {
  const f = build();
  try {
    return body(f);
  } finally {
    f.cleanup();
  }
};
const CONFIG = { roots: ['.'], exclude: [], extensions: ['.txt'] };
const enumerationError = (pattern) => (err) => err.code === SOURCE_SIZE_STOP && err.exitCode === 2 && pattern.test(err.message);

describe('enumerateIndex under hostile git — RED-first classes', { skip: skipWithoutGit }, () => {
  it('a redirected GIT_DIR refuses in the enumeration-error class (exit 2), naming GIT_DIR and the state', () => withFixture(fixtures.redirectedGitDir, (f) => {
    assert.throws(() => enumerateIndex(f.cwd, { spawn: spawnUnder(f.env), env: f.env }), enumerationError(/redirected.*GIT_DIR/u));
  }));
  it('a throwing spawn refuses in the enumeration-error class (exit 2), never a raw throw', () => withFixture(fixtures.workTree, (f) => {
    assert.throws(() => enumerateIndex(f.cwd, { spawn: fixtures.throwingRunner().spawn, env: f.env }), enumerationError(/threw synchronously/u));
  }));
  it('every other non-work-tree location refuses by its own state name in the same class', () => {
    for (const [state, build] of [['not-a-repository', fixtures.notARepository], ['env-only', fixtures.envOnly], ['no-work-tree', fixtures.bare]]) {
      withFixture(build, (f) => {
        assert.throws(() => enumerateIndex(f.cwd, { spawn: spawnUnder(f.env), env: f.env }), enumerationError(new RegExp(state, 'u')), state);
      });
    }
  });
});

describe('enumerateIndex under hostile git — pinned classes', { skip: skipWithoutGit }, () => {
  it('a held index.lock: the read-only enumeration still answers', () => withFixture(fixtures.heldIndexLock, (f) => {
    assert.deepEqual(enumerateIndex(f.cwd, { spawn: spawnUnder(f.env), env: f.env }).map((e) => e.path.toString('utf8')), ['f.txt']);
  }));
  it('the conflict stages enumerate, and resolveScope refuses the unmerged index (exit 1)', () => withFixture(fixtures.unmerged, (f) => {
    const stages = enumerateIndex(f.cwd, { spawn: spawnUnder(f.env), env: f.env }).map((e) => e.stage);
    assert.deepEqual(stages, [1, 2, 3]);
    assert.throws(() => resolveScope(f.cwd, CONFIG, { spawn: spawnUnder(f.env), env: f.env }), (err) => err.code === SOURCE_SIZE_STOP && err.exitCode === 1 && /UNMERGED/u.test(err.message));
  }));
  it('a git killed by a signal refuses in the enumeration-error class', () => withFixture(() => fixtures.killedGit(['ls-files']), (f) => {
    assert.throws(() => enumerateIndex(f.cwd, { spawn: spawnUnder(f.env), env: f.env }), enumerationError(/could not be enumerated .*killed by SIGKILL/u));
  }));
  it('an absent git (ENOENT) refuses in the enumeration-error class', () => withFixture(fixtures.absentGit, (f) => {
    assert.throws(() => enumerateIndex(f.cwd, { spawn: spawnUnder(f.env), env: f.env }), enumerationError(/ENOENT/u));
  }));
  it('a hook-shaped env agrees and enumerates', () => withFixture(fixtures.hookShapedEnv, (f) => {
    assert.ok(enumerateIndex(f.cwd, { spawn: spawnUnder(f.env), env: f.env }).length >= 1);
  }));
  it('the enumeration spawn borrows the process PATH when the env names none, as the location probes do', () => withFixture(fixtures.workTree, (f) => {
    const seen = [];
    const spawn = (cmd, args, opts) => {
      if (args[0] === 'ls-files') seen.push(opts.env.PATH);
      return spawnSync(cmd, args, opts);
    };
    const { PATH, ...noPath } = f.env;
    assert.ok(PATH.length > 0);
    assert.deepEqual(enumerateIndex(f.cwd, { spawn, env: noPath }).map((e) => e.path.toString('utf8')), ['f.txt']);
    assert.deepEqual(seen, [process.env.PATH]);
  }));
});
