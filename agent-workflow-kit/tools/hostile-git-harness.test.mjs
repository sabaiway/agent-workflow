// hostile-git-harness.test.mjs — real-git fixtures under a hermetic env, one per MEASURED class
// (first-pass-quality plan 1). A consumer suite imports the fixture it needs and judges its own
// module against it; this file proves every fixture against git itself FIRST, so a consumer
// assertion can never pass on a fixture that does not do what its name says. Under tools/ (not
// test/) so the coverage arm sees it. Without git on PATH every real-git test skips BY NAME.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { GIT_MAX_BUFFER, hermeticGitEnv, stripGitLocationEnv } from './git-env.mjs';

// The real git, resolved ONCE from the process PATH: the shims below embed it, and every fixture
// call bypasses the shim by using it directly.
export const REAL_GIT = (() => {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, 'git');
    try {
      accessSync(candidate, constants.X_OK);
      if (spawnSync(candidate, ['--version'], { windowsHide: true }).status === 0) return candidate;
    } catch { /* not this dir */ }
  }
  return null;
})();
export const skipWithoutGit = REAL_GIT === null ? 'git is not on PATH — every real-git fixture skips by name' : false;

const IDENTITY = ['-c', 'user.name=hostile', '-c', 'user.email=hostile@test.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];
const scratch = (label) => mkdtempSync(join(tmpdir(), `hostile-git-${label}-`));

// makeRepo(label, files) → a committed repository under its own HOME, every git call hermetic.
export const makeRepo = (label, files = { 'f.txt': 'one\n' }) => {
  const home = scratch(label);
  const dir = join(home, 'repo');
  mkdirSync(dir);
  const env = hermeticGitEnv(process.env, home);
  const git = (args, opts = {}) => spawnSync(REAL_GIT, [...IDENTITY, ...args], { cwd: opts.cwd ?? dir, env: opts.env ?? env, input: opts.input, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
  const must = (args, opts) => {
    const r = git(args, opts);
    assert.equal(r.status, 0, `fixture git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.toString('utf8').trim();
  };
  const write = (rel, content) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };
  must(['init', '-q']);
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  must(['add', '-A']);
  must(['commit', '-qm', 'base']);
  return { home, dir, cwd: dir, env, git, must, write, cleanup: () => rmSync(home, { recursive: true, force: true }) };
};

const both = (a, b) => () => { a.cleanup(); b.cleanup(); };

// A `git` on PATH that dies by SIGKILL on the named verbs and passes every other call to the real
// git — "a git diff killed by a signal under a healthy rev-parse" is kill(['diff']).
const shimDir = (label, killed) => {
  const dir = scratch(`${label}-shim`);
  if (killed !== null) {
    writeFileSync(join(dir, 'git'), `#!/bin/sh\nverb=\nfor a in "$@"; do case "$a" in -*) ;; *) verb="$a"; break ;; esac; done\ncase " ${killed.join(' ')} " in *" $verb "*) kill -KILL $$ ;; esac\nexec "${REAL_GIT}" "$@"\n`, { mode: 0o755 });
  }
  return dir;
};

// The location table's cells and the measured classes, each returning { cwd, env, cleanup, … }.
export const fixtures = {
  workTree: () => makeRepo('work-tree'),
  notARepository: () => {
    const home = scratch('not-a-repository');
    const cwd = join(home, 'empty');
    mkdirSync(cwd);
    return { home, cwd, env: hermeticGitEnv(process.env, home), cleanup: () => rmSync(home, { recursive: true, force: true }) };
  },
  redirectedGitDir: () => {
    const a = makeRepo('redirect-a');
    const b = makeRepo('redirect-b');
    return { a, b, cwd: a.dir, env: { ...a.env, GIT_DIR: join(b.dir, '.git') }, cleanup: both(a, b) };
  },
  workTreeAtSecondTree: () => {
    const a = makeRepo('second-tree');
    const second = join(a.home, 'second');
    mkdirSync(second);
    return { a, second, cwd: a.dir, env: { ...a.env, GIT_DIR: join(a.dir, '.git'), GIT_WORK_TREE: second }, cleanup: a.cleanup };
  },
  commonDirAtSecondRepo: () => {
    const a = makeRepo('common-a');
    const b = makeRepo('common-b');
    return { a, b, cwd: a.dir, env: { ...a.env, GIT_COMMON_DIR: join(b.dir, '.git') }, cleanup: both(a, b) };
  },
  envOnly: () => {
    const a = makeRepo('env-only');
    const outside = join(a.home, 'outside');
    mkdirSync(outside);
    return { a, cwd: outside, env: { ...a.env, GIT_DIR: join(a.dir, '.git') }, cleanup: a.cleanup };
  },
  bare: () => {
    const home = scratch('bare');
    const cwd = join(home, 'bare.git');
    const env = hermeticGitEnv(process.env, home);
    assert.equal(spawnSync(REAL_GIT, [...IDENTITY, 'init', '-q', '--bare', cwd], { env, windowsHide: true }).status, 0);
    return { home, cwd, env, cleanup: () => rmSync(home, { recursive: true, force: true }) };
  },
  insideGitDir: () => {
    const a = makeRepo('inside-git-dir');
    return { a, cwd: join(a.dir, '.git'), env: a.env, cleanup: a.cleanup };
  },
  // The env a pre-commit hook really runs under, captured from a hook that dumps it: the GIT_
  // variables git exports (GIT_INDEX_FILE, GIT_PREFIX, GIT_CONFIG_PARAMETERS, GIT_EXEC_PATH, …)
  // layered over the hermetic env. `only: true` captures the `--only` form, whose GIT_INDEX_FILE is
  // a TEMPORARY index git deletes after the hook — the hook copies it so a consumer run later sees
  // the index the hook saw (the variable then names the copy, absolute).
  hookShapedEnv: ({ only = false } = {}) => {
    const a = makeRepo('hook-env');
    const dump = join(a.home, 'hook-env.txt');
    const indexCopy = join(a.home, 'hook-index');
    writeFileSync(join(a.dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nenv > "$HOOK_ENV_OUT"\ncp "$GIT_INDEX_FILE" "$HOOK_INDEX_OUT"\nexit 1\n', { mode: 0o755 });
    a.write('hooked.txt', 'hooked\n');
    a.must(['add', 'hooked.txt']);
    const r = a.git(['commit', '-qm', 'hooked', ...(only ? ['--only', 'hooked.txt'] : [])], { env: { ...a.env, HOOK_ENV_OUT: dump, HOOK_INDEX_OUT: indexCopy } });
    assert.equal(r.status, 1, `the dumping hook refuses the commit: ${r.stderr}`);
    const hookVars = Object.fromEntries(readFileSync(dump, 'utf8').split('\n').filter((line) => line.startsWith('GIT_')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    if (only) hookVars.GIT_INDEX_FILE = indexCopy;
    return { a, cwd: a.dir, env: { ...a.env, ...hookVars }, hookVars, cleanup: a.cleanup };
  },
  killedGit: (verbs = ['rev-parse']) => {
    const a = makeRepo('killed');
    const shim = shimDir('killed', verbs);
    return { a, cwd: a.dir, env: { ...a.env, PATH: `${shim}${delimiter}${a.env.PATH}` }, cleanup: () => { a.cleanup(); rmSync(shim, { recursive: true, force: true }); } };
  },
  absentGit: () => {
    const a = makeRepo('absent');
    const empty = shimDir('absent', null);
    return { a, cwd: a.dir, env: { ...a.env, PATH: empty }, cleanup: () => { a.cleanup(); rmSync(empty, { recursive: true, force: true }); } };
  },
  // No git at all: a runner that throws synchronously, in both seam shapes the consumers take.
  throwingRunner: () => ({
    spawn: () => { throw new Error('the runner threw synchronously'); },
    runGit: () => { throw new Error('the runner threw synchronously'); },
  }),
  unmerged: () => {
    const a = makeRepo('unmerged');
    a.must(['checkout', '-q', '-b', 'side']);
    a.write('f.txt', 'side\n');
    a.must(['commit', '-qam', 'side']);
    a.must(['checkout', '-q', 'main']);
    a.write('f.txt', 'main\n');
    a.must(['commit', '-qam', 'main']);
    assert.equal(a.git(['merge', 'side']).status, 1, 'the merge conflicts');
    return { a, cwd: a.dir, env: a.env, path: 'f.txt', cleanup: a.cleanup };
  },
  showUntrackedNo: () => {
    const a = makeRepo('show-untracked-no');
    a.must(['config', 'status.showUntrackedFiles', 'no']);
    a.write('untracked.txt', 'u\n');
    return { a, cwd: a.dir, env: a.env, path: 'untracked.txt', cleanup: a.cleanup };
  },
  autocrlf: () => {
    const a = makeRepo('autocrlf');
    a.must(['config', 'core.autocrlf', 'true']);
    a.write('crlf.txt', 'a\r\nb\r\n');
    a.must(['add', 'crlf.txt']);
    a.must(['commit', '-qm', 'crlf']);
    return { a, cwd: a.dir, env: a.env, path: 'crlf.txt', cleanup: a.cleanup };
  },
  heldIndexLock: () => {
    const a = makeRepo('index-lock');
    writeFileSync(join(a.dir, '.git', 'index.lock'), '');
    return { a, cwd: a.dir, env: a.env, cleanup: a.cleanup };
  },
  // A file caught mid-write: an unstaged edit whose last UTF-8 sequence is incomplete.
  partialWrite: () => {
    const a = makeRepo('partial');
    writeFileSync(join(a.dir, 'f.txt'), Buffer.from([0x6f, 0x6b, 0x0a, 0xe2, 0x82]));
    return { a, cwd: a.dir, env: a.env, path: 'f.txt', cleanup: a.cleanup };
  },
  stoppedAm: () => {
    const a = makeRepo('stopped-am');
    const patch = 'From 0 Mon Sep 17 00:00:00 2001\nFrom: hostile <hostile@test.invalid>\nSubject: [PATCH] does not apply\n\n---\n f.txt | 2 +-\n\ndiff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-not the committed line\n+x\n';
    assert.notEqual(a.git(['am'], { input: patch }).status, 0, 'the patch does not apply, so am stops');
    return { a, cwd: a.dir, env: a.env, cleanup: a.cleanup };
  },
  stoppedRebase: () => {
    const a = makeRepo('stopped-rebase');
    a.must(['checkout', '-q', '-b', 'side']);
    a.write('f.txt', 'side\n');
    a.must(['commit', '-qam', 'side']);
    a.must(['checkout', '-q', 'main']);
    a.write('f.txt', 'main\n');
    a.must(['commit', '-qam', 'main']);
    a.must(['checkout', '-q', 'side']);
    assert.notEqual(a.git(['rebase', '--merge', 'main']).status, 0, 'the merge-backend rebase stops on the conflict');
    return { a, cwd: a.dir, env: a.env, path: 'f.txt', cleanup: a.cleanup };
  },
  textconv: () => {
    const a = makeRepo('textconv', { 's.secret': 'v1\n', '.gitattributes': 's.secret diff=blank\n' });
    a.must(['config', 'diff.blank.textconv', 'true']);
    a.write('s.secret', 'v2\n');
    a.must(['add', 's.secret']);
    return { a, cwd: a.dir, env: a.env, path: 's.secret', cleanup: a.cleanup };
  },
  ignoreSubmodulesAll: () => {
    const a = makeRepo('ignore-submodules');
    const sub = makeRepo('submodule');
    a.must(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.dir, 'sub']);
    a.must(['commit', '-qm', 'submodule']);
    a.must(['commit', '--allow-empty', '-qm', 'bump'], { cwd: join(a.dir, 'sub') });
    a.must(['config', 'diff.ignoreSubmodules', 'all']);
    a.must(['add', 'sub']);
    a.write('f.txt', 'visible\n');
    a.must(['add', 'f.txt']);
    return { a, cwd: a.dir, env: a.env, cleanup: both(a, sub) };
  },
  // A host whose global config excludes *.txt, whose global attributes mark everything binary and
  // whose locale is foreign — and the same repository under the hermetic env.
  poisonedHost: () => {
    const a = makeRepo('poisoned');
    a.write('note.txt', 'n\n');
    const poison = join(a.home, 'poison');
    mkdirSync(join(poison, 'git'), { recursive: true });
    writeFileSync(join(poison, '.gitconfig'), `[core]\n\texcludesFile = ${join(poison, 'excludes')}\n`);
    writeFileSync(join(poison, 'excludes'), '*.txt\n');
    writeFileSync(join(poison, 'git', 'attributes'), '* binary\n');
    const poisonedEnv = { ...stripGitLocationEnv(process.env), HOME: poison, XDG_CONFIG_HOME: poison, LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8' };
    return { a, cwd: a.dir, env: a.env, poisonedEnv, path: 'note.txt', cleanup: a.cleanup };
  },
};

const withFixture = (build, body) => {
  const f = build();
  try {
    body(f);
  } finally {
    f.cleanup();
  }
};
const revParse = (f, args, env = f.env) => spawnSync(REAL_GIT, ['rev-parse', ...args], { cwd: f.cwd, env: { ...env, LC_ALL: 'C' }, encoding: 'utf8', windowsHide: true });

describe('hostile-git-harness — every fixture is asserted against git itself', { skip: skipWithoutGit }, () => {
  it('a redirected GIT_DIR: git answers the OTHER repository from the first one\'s work tree', () => withFixture(fixtures.redirectedGitDir, (f) => {
    assert.equal(revParse(f, ['--absolute-git-dir']).stdout.trim(), join(f.b.dir, '.git'));
    assert.equal(revParse(f, ['--absolute-git-dir'], f.a.env).stdout.trim(), join(f.a.dir, '.git'), 'without the variable git answers the first');
  }));
  it('GIT_WORK_TREE at a second tree with the same git dir: git names the second tree as the top', () => withFixture(fixtures.workTreeAtSecondTree, (f) => {
    assert.equal(revParse(f, ['--show-toplevel']).stdout.trim(), f.second);
    assert.equal(revParse(f, ['--absolute-git-dir']).stdout.trim(), join(f.a.dir, '.git'));
  }));
  it('GIT_COMMON_DIR at a second repository: git names the second common dir', () => withFixture(fixtures.commonDirAtSecondRepo, (f) => {
    assert.equal(revParse(f, ['--git-common-dir']).stdout.trim(), join(f.b.dir, '.git'));
  }));
  it('env-only: the ambient GIT_DIR reaches a repository the cwd discovery does not', () => withFixture(fixtures.envOnly, (f) => {
    assert.equal(revParse(f, ['--absolute-git-dir']).status, 0);
    const stripped = revParse(f, ['--absolute-git-dir'], stripGitLocationEnv(f.env));
    assert.equal(stripped.status, 128);
    assert.match(stripped.stderr, /not a git repository/u);
  }));
  it('not-a-repository: git exits 128 with its own answer', () => withFixture(fixtures.notARepository, (f) => {
    const r = revParse(f, ['--absolute-git-dir']);
    assert.equal(r.status, 128);
    assert.match(r.stderr, /not a git repository/u);
  }));
  it('a bare repository and a cwd inside .git: the git dir answers, --show-toplevel refuses', () => {
    for (const build of [fixtures.bare, fixtures.insideGitDir]) {
      withFixture(build, (f) => {
        assert.equal(revParse(f, ['--absolute-git-dir']).status, 0);
        const top = revParse(f, ['--show-toplevel']);
        assert.equal(top.status, 128);
        assert.match(top.stderr, /must be run in a work tree/u);
      });
    }
  });
  it('the hook-shaped env is what a real pre-commit hook ran under, and git still names the same location', () => {
    for (const only of [false, true]) {
      withFixture(() => fixtures.hookShapedEnv({ only }), (f) => {
        assert.ok(Object.hasOwn(f.hookVars, 'GIT_INDEX_FILE'), `the hook saw GIT_INDEX_FILE (--only ${only})`);
        assert.ok(Object.hasOwn(f.hookVars, 'GIT_PREFIX'));
        assert.ok(Object.hasOwn(f.hookVars, 'GIT_EXEC_PATH'));
        assert.ok(Object.hasOwn(f.hookVars, 'GIT_CONFIG_PARAMETERS'));
        assert.equal(Object.hasOwn(f.hookVars, 'GIT_DIR'), false, 'measured: this git does not export GIT_DIR to the hook');
        assert.equal(revParse(f, ['--show-toplevel']).stdout.trim(), f.a.dir);
      });
    }
  });
  it('a killed git: the named verb dies by SIGKILL, every other verb answers', () => withFixture(() => fixtures.killedGit(['diff']), (f) => {
    const diff = spawnSync('git', ['diff', '--quiet'], { cwd: f.cwd, env: f.env, windowsHide: true });
    assert.equal(diff.signal, 'SIGKILL');
    assert.equal(diff.status, null);
    assert.equal(spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: f.cwd, env: f.env, windowsHide: true }).status, 0);
  }));
  it('an absent git: the spawn fails with ENOENT', () => withFixture(fixtures.absentGit, (f) => {
    assert.equal(spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: f.cwd, env: f.env, windowsHide: true }).error?.code, 'ENOENT');
  }));
  it('an unmerged index: three stages for the path, and git diff names it TWICE', () => withFixture(fixtures.unmerged, (f) => {
    const stages = f.a.must(['ls-files', '-s', 'f.txt']).split('\n').map((line) => line.split(/\s+/u)[2]);
    assert.deepEqual(stages, ['1', '2', '3']);
    assert.deepEqual(f.a.must(['diff', '--name-only', '-z']).split('\0').filter(Boolean), ['f.txt', 'f.txt'], 'measured on git 2.43: the conflicted path is listed once per unmerged side');
  }));
  it('status.showUntrackedFiles=no hides the file from status but not from ls-files --others', () => withFixture(fixtures.showUntrackedNo, (f) => {
    assert.equal(f.a.must(['status', '--porcelain']).includes('untracked.txt'), false);
    assert.equal(f.a.must(['ls-files', '--others', '--exclude-standard']), 'untracked.txt');
  }));
  it('core.autocrlf=true: the work tree holds CRLF, the blob holds LF, the diff is clean', () => withFixture(fixtures.autocrlf, (f) => {
    assert.ok(readFileSync(join(f.cwd, 'crlf.txt')).includes('\r\n'));
    assert.equal(f.a.must(['cat-file', '-p', 'HEAD:crlf.txt']).includes('\r'), false);
    assert.equal(f.a.git(['diff', '--quiet']).status, 0);
  }));
  it('a held index.lock: a write refuses, a read still answers', () => withFixture(fixtures.heldIndexLock, (f) => {
    const add = f.a.git(['add', '-A']);
    assert.notEqual(add.status, 0);
    assert.match(add.stderr.toString('utf8'), /index\.lock/u);
    assert.equal(f.a.git(['ls-files', '-z']).status, 0);
  }));
  it('a partially written file: git sees an unstaged change whose bytes end mid-sequence', () => withFixture(fixtures.partialWrite, (f) => {
    assert.equal(f.a.must(['diff', '--name-only']), 'f.txt');
    assert.deepEqual([...readFileSync(join(f.cwd, 'f.txt')).subarray(-2)], [0xe2, 0x82]);
  }));
  it('a stopped git am: the sequencer state is on disk and the tree is otherwise clean', () => withFixture(fixtures.stoppedAm, (f) => {
    assert.ok(existsSync(join(f.cwd, '.git', 'rebase-apply')));
    assert.equal(f.a.git(['diff', '--quiet']).status, 0);
    assert.equal(f.a.git(['diff', '--cached', '--quiet']).status, 0);
  }));
  it('a stopped merge-backend rebase leaves its directory, REBASE_HEAD and the conflicted path', () => withFixture(fixtures.stoppedRebase, (f) => {
    assert.equal(lstatSync(join(f.cwd, '.git', 'rebase-merge')).isDirectory(), true);
    assert.equal(f.a.git(['rev-parse', '-q', '--verify', 'REBASE_HEAD']).status, 0);
    assert.match(f.a.must(['status', '--porcelain']), /^UU f\.txt$/mu);
  }));
  it('textconv: --no-ext-diff leaves textconv ON, so the staged change shows no content; --no-textconv shows it', () => withFixture(fixtures.textconv, (f) => {
    assert.equal(f.a.must(['diff', '--cached', '--no-ext-diff']).includes('+v2'), false);
    assert.ok(f.a.must(['diff', '--cached', '--no-textconv']).includes('+v2'));
  }));
  it('diff.ignoreSubmodules=all: the staged gitlink vanishes from the diff while the visible change stays', () => withFixture(fixtures.ignoreSubmodulesAll, (f) => {
    const names = f.a.must(['diff', '--cached', '--name-only']).split('\n');
    assert.deepEqual(names, ['f.txt']);
    assert.deepEqual(f.a.must(['diff', '--cached', '--name-only', '--ignore-submodules=none']).split('\n').sort(), ['f.txt', 'sub']);
  }));
  it('a poisoned host moves the answers under its own env and none under the hermetic env', () => withFixture(fixtures.poisonedHost, (f) => {
    const others = (env) => spawnSync(REAL_GIT, ['ls-files', '--others', '--exclude-standard'], { cwd: f.cwd, env, encoding: 'utf8', windowsHide: true }).stdout.trim();
    const attr = (env) => spawnSync(REAL_GIT, ['check-attr', 'binary', 'f.txt'], { cwd: f.cwd, env, encoding: 'utf8', windowsHide: true }).stdout.trim();
    assert.equal(others(f.poisonedEnv), '', 'the host excludes file hides the untracked file');
    assert.equal(others(f.env), 'note.txt', 'the hermetic env does not');
    assert.match(attr(f.poisonedEnv), /: binary: set$/u, 'the host attributes file marks it binary');
    assert.match(attr(f.env), /: binary: unspecified$/u, 'the hermetic env pins attributes to the repository');
  }));
});
