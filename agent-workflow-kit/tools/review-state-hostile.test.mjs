// review-state-hostile.test.mjs — `review-state --check` under the hostile-git fixtures, and the
// six-state git location table pinned cell by cell (first-pass-quality plan 1). Red-first: a
// killed or absent git and a redirected location refuse (exit 1, the cause named) instead of
// passing as "not a git work tree"; the not-a-repository pass needs git's own answer.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from './review-state.mjs';
import { READY } from './detect-backends.mjs';
import { GIT_LOCATION_STATES, resolveGitLocation } from './git-env.mjs';
import { fixtures, makeRepo, skipWithoutGit } from './hostile-git-harness.test.mjs';

const detect = () => [{ name: 'codex-cli-bridge', readiness: READY }, { name: 'antigravity-cli-bridge', readiness: READY }];
const withFixture = (build, body) => {
  const f = build();
  try {
    return body(f);
  } finally {
    f.cleanup();
  }
};
// A council recipe and a plan in flight under the cwd, so --check reaches the tree arms.
const armed = (build) => () => {
  const f = build();
  mkdirSync(join(f.cwd, 'docs', 'ai'), { recursive: true });
  writeFileSync(join(f.cwd, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { execute: 'solo', review: 'council' } }));
  mkdirSync(join(f.cwd, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(f.cwd, 'docs', 'plans', 'plan.md'), '# plan\n');
  return f;
};
const check = (f, env = f.env) => main(['--check'], { cwd: f.cwd, env, detect });

describe('review-state --check under hostile git — RED-first', { skip: skipWithoutGit }, () => {
  it('a killed git refuses with the cause — never a "not a git work tree" pass', () => withFixture(armed(() => fixtures.killedGit(['rev-parse'])), (f) => {
    const r = check(f);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /the git location is error/u);
    assert.match(r.stdout, /SIGKILL/u);
    assert.doesNotMatch(r.stdout, /not a git work tree/u);
  }));
  it('a git diff killed by a signal under a healthy rev-parse refuses: the fingerprint is undecidable in a work tree', () => withFixture(armed(() => fixtures.killedGit(['diff'])), (f) => {
    const r = check(f);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /undecidable/u);
  }));
  it('an absent git refuses with the cause', () => withFixture(armed(fixtures.absentGit), (f) => {
    const r = check(f);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /the git location is error/u);
    assert.match(r.stdout, /ENOENT/u);
  }));
  it('a redirected GIT_DIR refuses naming the redirect and the variable — never another repository\'s verdict', () => withFixture(armed(fixtures.redirectedGitDir), (f) => {
    const r = check(f);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /the git location is redirected/u);
    assert.match(r.stdout, /GIT_DIR/u);
  }));
  it('a killed or absent git FROM A SUBDIRECTORY still refuses: an unanchored root never passes as no-plan', () => {
    for (const build of [() => fixtures.killedGit(['rev-parse']), fixtures.absentGit]) {
      withFixture(armed(build), (f) => {
        mkdirSync(join(f.cwd, 'sub'), { recursive: true });
        const r = main(['--check'], { cwd: join(f.cwd, 'sub'), env: f.env, detect });
        assert.equal(r.code, 1, r.stdout);
        assert.match(r.stdout, /the git location is error/u);
        assert.doesNotMatch(r.stdout, /no plan in flight/u);
      });
    }
  });
  it('a redirect judged FROM A SUBDIRECTORY still refuses: the plan anchor is the stripped discovery\'s top, never the bare cwd', () => withFixture(armed(fixtures.redirectedGitDir), (f) => {
    mkdirSync(join(f.cwd, 'sub'), { recursive: true });
    const r = main(['--check'], { cwd: join(f.cwd, 'sub'), env: f.env, detect });
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /the git location is redirected/u);
    assert.doesNotMatch(r.stdout, /no plan in flight/u, 'the subdirectory cwd never hides the root docs\\/plans');
  }));
  it('not-a-repository passes, and says it is git\'s own answer', () => withFixture(armed(fixtures.notARepository), (f) => {
    const r = check(f);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /not a git repository/u);
    assert.match(r.stdout, /git's own answer/u);
  }));
  it('env-only and no-work-tree (bare, inside .git) refuse by their state name', () => {
    for (const [state, build] of [['env-only', fixtures.envOnly], ['no-work-tree', fixtures.bare], ['no-work-tree', fixtures.insideGitDir]]) {
      withFixture(armed(build), (f) => {
        const r = check(f);
        assert.equal(r.code, 1, `${state}: ${r.stdout}`);
        assert.match(r.stdout, new RegExp(`the git location is ${state}`, 'u'));
      });
    }
  });
});

describe('review-state --check under hostile git — pinned', { skip: skipWithoutGit }, () => {
  it('a solo recipe needs no receipt, so git\'s state never decides it: the killed-git fixture passes as solo', () => withFixture(() => fixtures.killedGit(['rev-parse']), (f) => {
    mkdirSync(join(f.cwd, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(f.cwd, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'solo' } }));
    const r = check(f);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /recipe is solo/u);
  }));
  it('a hook-shaped env agrees: the check answers as under the plain env', () => withFixture(armed(fixtures.hookShapedEnv), (f) => {
    const hooked = check(f);
    const plain = check(f, f.a.env);
    assert.equal(hooked.code, plain.code);
    assert.doesNotMatch(hooked.stdout, /the git location is/u);
  }));
  it('a redirected cause carrying a newline-bearing repository path stays ONE report line, escaped', { skip: process.platform === 'win32' ? 'POSIX-only fixture (a newline in a path)' : false }, () => {
    const a = armed(fixtures.workTree)();
    const b = makeRepo('new\nline');
    try {
      const r = main(['--check'], { cwd: a.cwd, env: { ...a.env, GIT_DIR: join(b.dir, '.git') }, detect });
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stdout, /the git location is redirected/u);
      assert.doesNotMatch(r.stdout, /new\nline/u, 'the raw newline never reaches the one-line report');
      assert.match(r.stdout, /new\\u000aline/u, 'the path is escaped in place');
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
  it('a store path carrying a control byte is escaped in the plain report, never emitted raw', { skip: process.platform === 'win32' ? 'POSIX-only fixture (a control byte in a path)' : false }, () => {
    const f = armed(() => makeRepo('ctl\x01x'))();
    try {
      const r = main([], { cwd: f.cwd, env: f.env, detect });
      assert.equal(r.stdout.includes('\x01'), false, 'the raw byte never reaches the report');
      assert.match(r.stdout, /receipts: .*ctl\\u0001x/u, 'the receipts path is escaped in place');
    } finally {
      f.cleanup();
    }
  });
  it('an unmerged index still reaches the receipt arms (the fingerprint answers)', () => withFixture(armed(fixtures.unmerged), (f) => {
    const r = check(f);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /receipt/u);
    assert.doesNotMatch(r.stdout, /the git location is|undecidable/u);
  }));
});

describe('the git location table — pinned cell by cell', { skip: skipWithoutGit }, () => {
  // spec:control-bytes/S7
  const locate = (f, deps = {}) => resolveGitLocation(f.cwd, { env: f.env, ...deps });
  it('work-tree: the three realpath identities agree — the plain env, a hook-shaped env (plain and --only), an explicit agreeing GIT_DIR', () => {
    withFixture(fixtures.workTree, (f) => {
      const loc = locate(f);
      assert.equal(loc.state, 'work-tree');
      assert.equal(loc.top, f.cwd);
      assert.equal(loc.gitDir, join(f.cwd, '.git'));
      assert.equal(loc.commonDir, join(f.cwd, '.git'));
      assert.equal(locate(f, { env: { ...f.env, GIT_DIR: join(f.cwd, '.git') } }).state, 'work-tree');
    });
    for (const only of [false, true]) withFixture(() => fixtures.hookShapedEnv({ only }), (f) => assert.equal(locate(f).state, 'work-tree', `--only ${only}`));
  });
  it('not-a-repository: git\'s own not-a-git-repository answer under both discoveries', () => withFixture(fixtures.notARepository, (f) => {
    const loc = locate(f);
    assert.equal(loc.state, 'not-a-repository');
    assert.match(loc.cause, /not a git repository/u);
  }));
  it('error: ENOENT, a synchronous throw, a signal, an unresolvable realpath, another non-zero exit and an unparsable answer — each an answer, never a throw', () => {
    withFixture(fixtures.absentGit, (f) => assert.match(locate(f).cause, /ENOENT/u));
    withFixture(fixtures.absentGit, (f) => assert.equal(locate(f).state, 'error'));
    withFixture(() => fixtures.killedGit(['rev-parse']), (f) => {
      const loc = locate(f);
      assert.equal(loc.state, 'error');
      assert.match(loc.cause, /SIGKILL/u);
    });
    withFixture(fixtures.workTree, (f) => {
      const thrown = locate(f, { spawn: fixtures.throwingRunner().spawn });
      assert.equal(thrown.state, 'error');
      assert.match(thrown.cause, /threw synchronously/u);
      const unresolvable = locate(f, { realpath: () => { throw Object.assign(new Error('loop'), { code: 'ELOOP' }); } });
      assert.equal(unresolvable.state, 'error');
      assert.match(unresolvable.cause, /cannot be resolved \(ELOOP\)/u);
      const nonZero = locate(f, { spawn: () => ({ status: 3, stdout: '', stderr: 'weird' }) });
      assert.equal(nonZero.state, 'error');
      assert.match(nonZero.cause, /exited 3 \(weird\)/u);
      const unparsable = locate(f, { spawn: () => ({ status: 0, stdout: '\n', stderr: '' }) });
      assert.equal(unparsable.state, 'error');
      assert.match(unparsable.cause, /answered nothing/u);
      const nothing = locate(f, { spawn: () => undefined });
      assert.equal(nothing.state, 'error');
    });
  });
  it('redirected: GIT_DIR at another repository, GIT_WORK_TREE at a second tree with the same git dir, GIT_COMMON_DIR at a second repository — and the reverse of env-only', () => {
    withFixture(fixtures.redirectedGitDir, (f) => {
      const loc = locate(f);
      assert.equal(loc.state, 'redirected');
      assert.match(loc.cause, /the git dir differs/u);
      assert.match(loc.cause, /GIT_DIR/u);
    });
    withFixture(fixtures.workTreeAtSecondTree, (f) => {
      const loc = locate(f);
      assert.equal(loc.state, 'redirected');
      assert.match(loc.cause, /the work-tree top differs/u);
    });
    withFixture(fixtures.commonDirAtSecondRepo, (f) => {
      const loc = locate(f);
      assert.equal(loc.state, 'redirected');
      assert.match(loc.cause, /the common dir differs/u);
    });
    withFixture(fixtures.workTree, (f) => {
      const loc = locate(f, { env: { ...f.env, GIT_DIR: join(f.home, 'nowhere') } });
      assert.equal(loc.state, 'redirected', 'the ambient env reaches no repository while the cwd discovery does');
      assert.match(loc.cause, /reaches no repository/u);
    });
  });
  it('no-work-tree: a bare repository and a cwd inside .git — the git dir agrees, git names no work tree', () => {
    for (const build of [fixtures.bare, fixtures.insideGitDir]) {
      withFixture(build, (f) => {
        const loc = locate(f);
        assert.equal(loc.state, 'no-work-tree');
        assert.match(loc.cause, /must be run in a work tree/u);
      });
    }
  });
  it('an ASYMMETRIC no-work-tree — the ambient env names none while cwd reaches one — is redirected; no-work-tree needs both probes to agree', () => withFixture(fixtures.workTree, (f) => {
    const spawn = (cmd, args, opts) => (args[1] === '--show-toplevel' && opts.env.GIT_MARK === '1'
      ? { status: 128, stdout: '', stderr: 'fatal: this operation must be run in a work tree' }
      : spawnSync(cmd, args, opts));
    const loc = resolveGitLocation(f.cwd, { env: { ...f.env, GIT_MARK: '1' }, spawn });
    assert.equal(loc.state, 'redirected');
    assert.match(loc.cause, /names no work tree .* while the discovery from .* reaches one/u);
  }));
  it('env-only: the ambient env reaches a repository the stripped discovery does not', () => withFixture(fixtures.envOnly, (f) => {
    const loc = locate(f);
    assert.equal(loc.state, 'env-only');
    assert.match(loc.cause, /reaches no repository/u);
  }));
  it('the table is closed: every fixture answers one of the six states, and only work-tree carries a top', () => {
    for (const build of [fixtures.workTree, fixtures.notARepository, fixtures.redirectedGitDir, fixtures.workTreeAtSecondTree, fixtures.commonDirAtSecondRepo, fixtures.envOnly, fixtures.bare, fixtures.insideGitDir, fixtures.absentGit]) {
      withFixture(build, (f) => {
        const loc = locate(f);
        assert.ok(GIT_LOCATION_STATES.includes(loc.state), loc.state);
        assert.equal(loc.top !== null, loc.state === 'work-tree');
      });
    }
  });
});
