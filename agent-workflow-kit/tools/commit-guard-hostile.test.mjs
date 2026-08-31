// commit-guard-hostile.test.mjs — runGuard under the hostile-git fixtures (first-pass-quality
// plan 1). Red-first: a redirected location refuses naming GIT_DIR; a killed or absent git and
// every other non-work-tree state refuse by name (measured pre-fix: a clean fixture PASSED as a
// content-free commit because the guard read git under the process env, not the caller's); the
// unmerged path is named once. Pinned: a stopped am changes nothing, a hook-shaped env passes the
// location arm — with or without an explicit, agreeing GIT_DIR.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runGuard } from './commit-guard.mjs';
import { fixtures, skipWithoutGit } from './hostile-git-harness.test.mjs';

const withFixture = (build, body) => {
  const f = build();
  try {
    return body(f);
  } finally {
    f.cleanup();
  }
};
const guard = (f, env = f.env) => runGuard({ cwd: f.cwd, env });
// The fingerprint hex differs per repository; everything else in a refusal must not.
const shape = (result) => ({ code: result.code, lines: result.lines.map((line) => line.replace(/[0-9a-f]{12}…/gu, '<fingerprint>')) });

describe('commit-guard under hostile git — RED-first', { skip: skipWithoutGit }, () => {
  it('a redirected GIT_DIR refuses, naming the redirect and GIT_DIR — never another repository\'s verdict', () => withFixture(fixtures.redirectedGitDir, (f) => {
    const result = guard(f);
    assert.equal(result.code, 1);
    assert.match(result.lines[0], /^commit-guard: REFUSED — the git location is redirected/u);
    assert.match(result.lines[0], /GIT_DIR/u);
  }));
  it('a killed git refuses (exit 1) naming the signal — never a content-free PASS', () => withFixture(() => fixtures.killedGit(['rev-parse']), (f) => {
    const result = guard(f);
    assert.equal(result.code, 1);
    assert.match(result.lines[0], /^commit-guard: REFUSED — the git location is error/u);
    assert.match(result.lines[0], /SIGKILL/u);
  }));
  it('an absent git refuses (exit 1) naming ENOENT', () => withFixture(fixtures.absentGit, (f) => {
    const result = guard(f);
    assert.equal(result.code, 1);
    assert.match(result.lines[0], /the git location is error/u);
    assert.match(result.lines[0], /ENOENT/u);
  }));
  it('an unmerged index refuses: the index does not carry the whole working tree, the conflicted path named ONCE', () => withFixture(fixtures.unmerged, (f) => {
    const result = guard(f);
    assert.equal(result.code, 1);
    assert.match(result.lines[0], /REFUSED/u);
    assert.ok(result.lines[0].includes(f.path), 'the conflicted path is named');
    assert.equal(result.lines[0].split(f.path).length, 2, 'named once');
  }));
  it('every other non-work-tree location refuses by its own state name', () => {
    for (const [state, build] of [['not-a-repository', fixtures.notARepository], ['env-only', fixtures.envOnly], ['no-work-tree', fixtures.bare], ['no-work-tree', fixtures.insideGitDir]]) {
      withFixture(build, (f) => {
        const result = guard(f);
        assert.equal(result.code, 1, state);
        assert.match(result.lines[0], new RegExp(`the git location is ${state}`, 'u'));
      });
    }
  });
});

describe('commit-guard under hostile git — pinned', { skip: skipWithoutGit }, () => {
  it('a stopped git am is unchanged: the same answer as a repository with no sequencer state', () => withFixture(fixtures.stoppedAm, (f) => withFixture(fixtures.workTree, (plain) => {
    assert.deepEqual(shape(guard(f)), shape(guard(plain)));
  })));
  it('a hook-shaped env passes the location arm, with or without an explicit agreeing GIT_DIR', () => {
    for (const only of [false, true]) {
      withFixture(() => fixtures.hookShapedEnv({ only }), (f) => {
        const plain = shape(guard(f, f.a.env));
        assert.doesNotMatch(plain.lines[0], /the git location is/u, 'the plain env is never a location refusal');
        assert.deepEqual(shape(guard(f)), plain, `the hook env (--only ${only}) answers as the plain env does`);
        assert.deepEqual(shape(guard(f, { ...f.env, GIT_DIR: join(f.cwd, '.git') })), plain, 'an explicit GIT_DIR that agrees is no redirect');
      });
    }
  });
});
