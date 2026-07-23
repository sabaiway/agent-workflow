// F3 — `--include` preflight-identity binding: preflight captures each include root's
// {dev, ino, kind}; the copy door re-verifies a file root against it, a directory root gets a
// walk-start recheck, and EVERY include file crossing the door is proven, with both
// descriptors open, not to be the door-time queue. Special/erroring roots refuse pre-mutation.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeSync, constants as fsC, existsSync, fstatSync, linkSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import * as W from './worktrees.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-include-identity-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const PLAN_ARGS = ['--plan', 'docs/plans/SEED-PROMPT-x.md'];
const HEAD = '2222222222222222222222222222222222222222';
const CONTRACT = 'An --include source is copied only through the identity door: a file include must still match the identity preflight recorded (device, inode, kind), a directory include root is re-checked at walk start, and every copied file is proven, with both descriptors open, not to be the node that IS the door-time queue — an absent queue keeps the lexical guard alone, and anything unprovable stops the copy';

const makeGit = (main, { onAdd = null } = {}) => {
  const commonDir = join(main, '.git');
  const entries = [];
  const addCalls = [];
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const porcelain = () => [
    [`worktree ${main}`, `HEAD ${HEAD}`, 'branch refs/heads/main'],
    ...entries.map(({ path, branch }) => [`worktree ${path}`, `HEAD ${HEAD}`, `branch refs/heads/${branch}`]),
  ].map((fields) => fields.join('\0')).join('\0\0') + '\0\0';
  const git = (args) => {
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return ok(main);
    if (args[0] === 'rev-parse' && args.includes('--git-dir')) return ok(`${commonDir}\n`);
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return ok(`${commonDir}\n`);
    if (args[0] === 'rev-parse' && args.includes('HEAD')) return ok(`${HEAD}\n`);
    if (args[0] === 'check-ignore') return ok();
    if (args[0] === 'ls-tree') return ok();
    if (args[0] === 'ls-files') return ok();
    if ((args[0] === 'status' && args[1] === '--porcelain')
      || (args[0] === '--no-optional-locks' && args[1] === 'status' && args[2] === '--porcelain')) return ok();
    if (args[0] === 'worktree' && args[1] === 'list') return ok(porcelain());
    if (args[0] === 'worktree' && args[1] === 'add') {
      const branch = args[3];
      const requested = args[4];
      const canonical = join(realpathSync(dirname(requested)), basename(requested));
      mkdirSync(canonical, { recursive: true });
      entries.push({ path: canonical, branch });
      addCalls.push(canonical);
      if (onAdd) onAdd(canonical);
      return ok();
    }
    return { status: 128, stdout: '', stderr: `unexpected git call: ${args.join(' ')}` };
  };
  git.addCalls = addCalls;
  return git;
};

const makeRepo = (name) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  writeFileSync(join(main, 'AGENTS.md'), '# agents\n');
  mkdirSync(join(main, 'docs/ai'), { recursive: true });
  writeFileSync(join(main, 'docs/ai/gates.json'), JSON.stringify({ gates: [] }));
  mkdirSync(join(main, 'docs/plans'), { recursive: true });
  writeFileSync(join(main, 'docs/plans/SEED-PROMPT-x.md'), '# body\n');
  return realpathSync(main);
};

const queuePathOf = (main) => join(main, 'docs/plans', W.QUEUE_BASENAME);

const run = (main, argv, { git = null, deps = {} } = {}) => {
  const out = [];
  const err = [];
  const code = W.runCli(argv, {
    cwd: main,
    git: git ?? makeGit(main),
    log: (line) => out.push(line),
    logError: (line) => err.push(line),
    ...deps,
  });
  return { code, out, err, text: out.join('\n'), errText: err.join('\n') };
};

const provisionArgs = (slug, extra) => ['provision', slug, ...PLAN_ARGS, '--as', `feature-${slug}.md`, ...extra];
const wtDirOf = (main, slug) => join(dirname(main), `${basename(main)}--${slug}`);

const assertIdentityStop = (result, dst) => {
  assert.equal(result.code, W.EXIT.stop, `expected a STOP, got exit ${result.code}: ${result.errText}`);
  assert.ok(result.errText.includes(CONTRACT), `the STOP must emit the contract sentence, got: ${result.errText}`);
  assert.ok(!existsSync(dst), `the refused destination must not exist: ${dst}`);
};

describe('preflight-to-walk swap stops (file root identity, {dev, ino, kind})', () => {
  it('file swapped to a different regular file after preflight stops with no destination', () => {
    const main = makeRepo('swap-file');
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'approved\n');
    // The impostor exists BEFORE the original is replaced, so its inode is guaranteed distinct
    // (an unlink-then-write swap can silently reuse the freed inode and vacuously pass).
    const impostor = join(main, 'impostor.txt');
    const git = makeGit(main, { onAdd: () => { writeFileSync(impostor, 'impostor\n'); renameSync(impostor, inc); } });
    const result = run(main, provisionArgs('swapfile', ['--include', 'inc.txt']), { git });
    assertIdentityStop(result, join(wtDirOf(main, 'swapfile'), 'inc.txt'));
  });

  it('file swapped to a symlink after preflight stops with no destination', () => {
    const main = makeRepo('swap-link');
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'approved\n');
    writeFileSync(join(main, 'other.txt'), 'other\n');
    const git = makeGit(main, { onAdd: () => { unlinkSync(inc); symlinkSync('other.txt', inc); } });
    const result = run(main, provisionArgs('swaplink', ['--include', 'inc.txt']), { git });
    assertIdentityStop(result, join(wtDirOf(main, 'swaplink'), 'inc.txt'));
  });

  it('file swapped to a directory after preflight stops with no destination', () => {
    const main = makeRepo('swap-dir');
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'approved\n');
    const git = makeGit(main, {
      onAdd: () => { unlinkSync(inc); mkdirSync(inc); writeFileSync(join(inc, 'child.txt'), 'child\n'); },
    });
    const result = run(main, provisionArgs('swapdir', ['--include', 'inc.txt']), { git });
    assertIdentityStop(result, join(wtDirOf(main, 'swapdir'), 'inc.txt'));
  });

  it('file swapped to a special node after preflight stops with the contract sentence', () => {
    const main = makeRepo('swap-special');
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'approved\n');
    const incReal = realpathSync(inc);
    const phase = { walking: false };
    const special = { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false, dev: 7, ino: 7, mode: 0o060000 };
    const git = makeGit(main, { onAdd: () => { phase.walking = true; } });
    const result = run(main, provisionArgs('swapspecial', ['--include', 'inc.txt']), {
      git,
      deps: { lstat: (p) => (phase.walking && p === incReal ? special : lstatSync(p)) },
    });
    assertIdentityStop(result, join(wtDirOf(main, 'swapspecial'), 'inc.txt'));
  });

  it('dev-only identity mismatch at the door stops even when the walk-time probes agree', () => {
    const main = makeRepo('swap-dev');
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'approved\n');
    const incReal = realpathSync(inc);
    const phase = { walking: false };
    const fds = new Map();
    const liftDev = (st) => Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: st.dev + 1 });
    const git = makeGit(main, { onAdd: () => { phase.walking = true; } });
    const result = run(main, provisionArgs('swapdev', ['--include', 'inc.txt']), {
      git,
      deps: {
        lstat: (p) => {
          const st = lstatSync(p);
          return phase.walking && p === incReal ? liftDev(st) : st;
        },
        open: (p, flags, mode) => {
          const fd = openSync(p, flags, mode);
          if (phase.walking && p === incReal) fds.set(fd, true);
          return fd;
        },
        fstat: (fd) => {
          const st = fstatSync(fd);
          return fds.has(fd) ? liftDev(st) : st;
        },
      },
    });
    assertIdentityStop(result, join(wtDirOf(main, 'swapdev'), 'inc.txt'));
  });
});

describe('walk-window swaps in the door lane emit the contract', () => {
  it('walk-window-swap-emits-contract: a source replaced between walk lstat and open', () => {
    const main = makeRepo('walk-window-swap');
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'approved\n');
    const incReal = realpathSync(inc);
    const impostor = join(main, 'impostor.txt');
    writeFileSync(impostor, 'impostor\n');
    const swapped = { done: false };
    const result = run(main, provisionArgs('windowswap', ['--include', 'inc.txt']), {
      deps: {
        open: (p, flags, mode) => {
          if (p === incReal && !swapped.done) {
            swapped.done = true;
            renameSync(impostor, inc);
          }
          return openSync(p, flags, mode);
        },
      },
    });
    assertIdentityStop(result, join(wtDirOf(main, 'windowswap'), 'inc.txt'));
  });

  it('walk-window-vanish-emits-contract: a source unlinked between walk lstat and open', () => {
    const main = makeRepo('walk-window-vanish');
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'approved\n');
    const incReal = realpathSync(inc);
    const vanished = { done: false };
    const result = run(main, provisionArgs('windowvanish', ['--include', 'inc.txt']), {
      deps: {
        open: (p, flags, mode) => {
          if (p === incReal && !vanished.done) {
            vanished.done = true;
            unlinkSync(inc);
          }
          return openSync(p, flags, mode);
        },
      },
    });
    assertIdentityStop(result, join(wtDirOf(main, 'windowvanish'), 'inc.txt'));
  });
});

describe('the overlap predicate is platform-aware', () => {
  it('include-rels-overlap-platform-semantics (supersedes include-rels-overlap-normalizes-windows-separators)', () => {
    assert.equal(typeof W.includeRelsOverlap, 'function', 'the overlap predicate is exported');
    // POSIX semantics (separator injected explicitly, so this file also runs on a Windows host):
    // literal comparison — a backslash is a valid filename character and case is significant,
    // so neither may conflate distinct names into a false refusal.
    const posix = { separator: '/' };
    assert.equal(W.includeRelsOverlap('assets/inner.txt', 'assets', posix), true);
    assert.equal(W.includeRelsOverlap('assets', 'assets/inner.txt', posix), true);
    assert.equal(W.includeRelsOverlap('assets\\inner.txt', 'assets', posix), false, 'a literal-backslash name is not a nested path on POSIX');
    assert.equal(W.includeRelsOverlap('AGENTS.md', 'agents.md', posix), false, 'case stays significant on POSIX');
    assert.equal(W.includeRelsOverlap('assets-extra', 'assets', posix), false, 'a sibling prefix is not an overlap');
    // Windows semantics (injected separator): separators normalize and case folds — the
    // fail-closed direction for a refusal guard on a case-insensitive filesystem.
    const win = { separator: '\\' };
    assert.equal(W.includeRelsOverlap('assets\\inner.txt', 'assets', win), true);
    assert.equal(W.includeRelsOverlap('AGENTS.md', 'agents.md', win), true);
    assert.equal(W.includeRelsOverlap('.claude\\agents', '.claude', win), true);
    assert.equal(W.includeRelsOverlap('assets\\inner.txt', 'assets/inner.txt', win), true);
    assert.equal(W.includeRelsOverlap('assets-extra', 'assets', win), false);
  });
});

describe('directory include root recheck at walk start', () => {
  it('include-root-preflight-identity-rechecked-at-walk-start: swapped directory root stops', () => {
    const main = makeRepo('swap-dirroot');
    const dir = join(main, 'assets');
    mkdirSync(dir);
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    const fresh = join(main, 'assets-fresh');
    const git = makeGit(main, {
      onAdd: () => {
        mkdirSync(fresh);
        writeFileSync(join(fresh, 'a.txt'), 'impostor\n');
        rmSync(dir, { recursive: true });
        renameSync(fresh, dir);
      },
    });
    const result = run(main, provisionArgs('dirroot', ['--include', 'assets']), { git });
    assertIdentityStop(result, join(wtDirOf(main, 'dirroot'), 'assets'));
  });
});

describe('door-time queue identity refusal', () => {
  it('include-source-is-door-time-queue-inode-refuses: a hardlink of the queue never copies', () => {
    const main = makeRepo('queue-hardlink');
    const queue = queuePathOf(main);
    writeFileSync(queue, '# queue\n');
    const inc = join(main, 'inc-hard.txt');
    linkSync(queue, inc);
    const result = run(main, provisionArgs('qhard', ['--include', 'inc-hard.txt']));
    assertIdentityStop(result, join(wtDirOf(main, 'qhard'), 'inc-hard.txt'));
  });

  it('queue-swapped-to-unrelated-inode-does-not-block-copy (a preflight-cached identity would refuse)', () => {
    const main = makeRepo('queue-unrelated');
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'payload\n');
    const queue = queuePathOf(main);
    // The queue IS the source at preflight time — an implementation caching the preflight queue
    // identity refuses here; only a door-time read sees the swapped, unrelated node and copies.
    linkSync(realpathSync(inc), queue);
    const git = makeGit(main, { onAdd: () => { unlinkSync(queue); writeFileSync(queue, '# reborn queue\n'); } });
    const result = run(main, provisionArgs('qunrel', ['--include', 'inc.txt']), { git });
    assert.equal(result.code, W.EXIT.ok, result.errText);
    assert.equal(readFileSync(join(wtDirOf(main, 'qunrel'), 'inc.txt'), 'utf8'), 'payload\n');
  });

  it('queue-swap-between-child-door-crossings-refuses-second', () => {
    const main = makeRepo('queue-childswap');
    const queue = queuePathOf(main);
    writeFileSync(queue, '# queue\n');
    const dir = join(main, 'assets');
    mkdirSync(dir);
    writeFileSync(join(dir, 'a.txt'), 'first\n');
    writeFileSync(join(dir, 'b.txt'), 'second\n');
    const dirReal = realpathSync(dir);
    const bReal = join(dirReal, 'b.txt');
    const result = run(main, provisionArgs('qchild', ['--include', 'assets']), {
      deps: {
        readdir: (p) => (p === dirReal ? ['a.txt', 'b.txt'] : readdirSync(p)),
        open: (p, flags, mode) => {
          if (p === bReal) {
            unlinkSync(queue);
            linkSync(bReal, queue);
          }
          return openSync(p, flags, mode);
        },
      },
    });
    const wt = wtDirOf(main, 'qchild');
    assert.equal(result.code, W.EXIT.stop, `expected a STOP on the second child: ${result.errText}`);
    assert.ok(result.errText.includes(CONTRACT), `the STOP must emit the contract sentence, got: ${result.errText}`);
    assert.equal(readFileSync(join(wt, 'assets/a.txt'), 'utf8'), 'first\n', 'the first child copies before the swap');
    assert.ok(!existsSync(join(wt, 'assets/b.txt')), 'the second child must be refused');
  });

  it('queue-absent-at-first-crossing-present-at-second-refuses (absence is never cached)', () => {
    const main = makeRepo('queue-appears');
    const queue = queuePathOf(main);
    const dir = join(main, 'assets');
    mkdirSync(dir);
    writeFileSync(join(dir, 'a.txt'), 'first\n');
    writeFileSync(join(dir, 'b.txt'), 'second\n');
    const dirReal = realpathSync(dir);
    const bReal = join(dirReal, 'b.txt');
    const result = run(main, provisionArgs('qappears', ['--include', 'assets']), {
      deps: {
        readdir: (p) => (p === dirReal ? ['a.txt', 'b.txt'] : readdirSync(p)),
        open: (p, flags, mode) => {
          if (p === bReal && !existsSync(queue)) linkSync(bReal, queue);
          return openSync(p, flags, mode);
        },
      },
    });
    const wt = wtDirOf(main, 'qappears');
    assert.equal(result.code, W.EXIT.stop, `expected a STOP on the second child: ${result.errText}`);
    assert.ok(result.errText.includes(CONTRACT), `the STOP must emit the contract sentence, got: ${result.errText}`);
    assert.equal(readFileSync(join(wt, 'assets/a.txt'), 'utf8'), 'first\n');
    assert.ok(!existsSync(join(wt, 'assets/b.txt')));
  });

  it('queue-absent-at-preflight-rechecked-at-door: a queue born after preflight still refuses', () => {
    const main = makeRepo('queue-born');
    const queue = queuePathOf(main);
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'payload\n');
    const incReal = realpathSync(inc);
    const git = makeGit(main, { onAdd: () => linkSync(incReal, queue) });
    const result = run(main, provisionArgs('qborn', ['--include', 'inc.txt']), { git });
    assertIdentityStop(result, join(wtDirOf(main, 'qborn'), 'inc.txt'));
  });

  it('queue-absent-at-door-keeps-lexical-guard: no queue anywhere, the copy proceeds', () => {
    const main = makeRepo('queue-absent');
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'payload\n');
    const result = run(main, provisionArgs('qabsent', ['--include', 'inc.txt']));
    assert.equal(result.code, W.EXIT.ok, result.errText);
    assert.equal(readFileSync(join(wtDirOf(main, 'qabsent'), 'inc.txt'), 'utf8'), 'payload\n');
  });

  it('queue-unreadable-at-door-stops (open failure injected, fail-closed)', () => {
    const main = makeRepo('queue-eacces');
    const queue = queuePathOf(main);
    writeFileSync(queue, '# queue\n');
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'payload\n');
    const result = run(main, provisionArgs('qeacces', ['--include', 'inc.txt']), {
      deps: {
        open: (p, flags, mode) => {
          if (p === queue) throw Object.assign(new Error('injected'), { code: 'EACCES' });
          return openSync(p, flags, mode);
        },
      },
    });
    assertIdentityStop(result, join(wtDirOf(main, 'qeacces'), 'inc.txt'));
  });

  it('queue-fstat-error-at-door-stops (fstat failure injected separately, fail-closed)', () => {
    const main = makeRepo('queue-efstat');
    const queue = queuePathOf(main);
    writeFileSync(queue, '# queue\n');
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'payload\n');
    const queueFds = new Set();
    const result = run(main, provisionArgs('qefstat', ['--include', 'inc.txt']), {
      deps: {
        open: (p, flags, mode) => {
          const fd = openSync(p, flags, mode);
          if (p === queue) queueFds.add(fd);
          return fd;
        },
        fstat: (fd) => {
          if (queueFds.has(fd)) throw Object.assign(new Error('injected'), { code: 'EIO' });
          return fstatSync(fd);
        },
      },
    });
    assertIdentityStop(result, join(wtDirOf(main, 'qefstat'), 'inc.txt'));
  });

  it('queue-non-regular-at-door-stops: directory-shaped queue', () => {
    const main = makeRepo('queue-dirshape');
    mkdirSync(queuePathOf(main));
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'payload\n');
    const result = run(main, provisionArgs('qdirshape', ['--include', 'inc.txt']));
    assertIdentityStop(result, join(wtDirOf(main, 'qdirshape'), 'inc.txt'));
  });

  it('queue-non-regular-at-door-stops: FIFO-shaped queue through the non-blocking open spy', () => {
    const main = makeRepo('queue-fifo');
    const queue = queuePathOf(main);
    writeFileSync(queue, 'stand-in for a FIFO node\n');
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'payload\n');
    const queueFds = new Set();
    // The flags are RECORDED, never asserted inside the spy — an assertion thrown in the
    // injected open would be swallowed by the door's fail-closed catch and fake the very STOP
    // this arm expects.
    const queueOpenFlags = [];
    const result = run(main, provisionArgs('qfifo', ['--include', 'inc.txt']), {
      deps: {
        open: (p, flags, mode) => {
          const fd = openSync(p, flags, mode);
          if (p === queue) {
            queueOpenFlags.push(flags);
            queueFds.add(fd);
          }
          return fd;
        },
        fstat: (fd) => {
          const st = fstatSync(fd);
          if (queueFds.has(fd)) {
            return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { isFile: () => false, isFIFO: () => true });
          }
          return st;
        },
      },
    });
    assertIdentityStop(result, join(wtDirOf(main, 'qfifo'), 'inc.txt'));
    assert.ok(queueOpenFlags.length > 0, 'the door opened the queue');
    assert.ok(queueOpenFlags.every((flags) => (flags & fsC.O_NONBLOCK) !== 0), 'every queue open carries O_NONBLOCK — a real FIFO would block forever without it');
  });

  it('symlinked-queue-identity-uses-canonical-target', () => {
    const main = makeRepo('queue-linked');
    const target = join(main, 'docs/plans/queue-store.md');
    writeFileSync(target, '# real queue content\n');
    symlinkSync('queue-store.md', queuePathOf(main));
    const inc = join(main, 'inc-hard.txt');
    linkSync(target, inc);
    const result = run(main, provisionArgs('qlinked', ['--include', 'inc-hard.txt']));
    assertIdentityStop(result, join(wtDirOf(main, 'qlinked'), 'inc-hard.txt'));
  });

  it('queue-retarget-inside-door-open-window-refuses (identity is read at descriptor-open time)', () => {
    const main = makeRepo('queue-retarget');
    const innocent = join(main, 'docs/plans/innocent.md');
    writeFileSync(innocent, '# innocent\n');
    const queue = queuePathOf(main);
    symlinkSync('innocent.md', queue);
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'payload\n');
    const incReal = realpathSync(inc);
    const result = run(main, provisionArgs('qretarget', ['--include', 'inc.txt']), {
      deps: {
        open: (p, flags, mode) => {
          if (p === queue) {
            unlinkSync(queue);
            symlinkSync(incReal, queue);
          }
          return openSync(p, flags, mode);
        },
      },
    });
    assertIdentityStop(result, join(wtDirOf(main, 'qretarget'), 'inc.txt'));
  });

  it('queue-born-as-source-hardlink-after-absent-lstat-refuses (absence is proven at open, not lstat)', () => {
    const main = makeRepo('queue-birth-window');
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'payload\n');
    const incReal = realpathSync(inc);
    const queue = queuePathOf(main);
    linkSync(incReal, queue);
    const lied = { done: false };
    const result = run(main, provisionArgs('qbirth', ['--include', 'inc.txt']), {
      deps: {
        lstat: (p) => {
          if (p === queue && !lied.done) {
            lied.done = true;
            throw Object.assign(new Error('injected'), { code: 'ENOENT' });
          }
          return lstatSync(p);
        },
      },
    });
    assertIdentityStop(result, join(wtDirOf(main, 'qbirth'), 'inc.txt'));
  });

  it('dangling-queue-stops (a dangling symlink is not plain absence)', () => {
    const main = makeRepo('queue-dangling');
    symlinkSync('never-exists.md', queuePathOf(main));
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'payload\n');
    const result = run(main, provisionArgs('qdangling', ['--include', 'inc.txt']));
    assertIdentityStop(result, join(wtDirOf(main, 'qdangling'), 'inc.txt'));
  });

  it('door-closes-queue-descriptor-exactly-once on the happy and the refusal path', () => {
    const happyMain = makeRepo('queue-close-happy');
    writeFileSync(queuePathOf(happyMain), '# queue\n');
    writeFileSync(join(happyMain, 'inc.txt'), 'payload\n');
    const traceCloses = () => {
      const state = { queueFds: new Set(), closes: 0 };
      return {
        state,
        deps: {
          open: (p, flags, mode) => {
            const fd = openSync(p, flags, mode);
            if (basename(p) === W.QUEUE_BASENAME) state.queueFds.add(fd);
            return fd;
          },
          close: (fd) => {
            if (state.queueFds.has(fd)) {
              state.queueFds.delete(fd);
              state.closes += 1;
            }
            return closeSync(fd);
          },
        },
      };
    };
    const happy = traceCloses();
    const happyResult = run(happyMain, provisionArgs('qclosehappy', ['--include', 'inc.txt']), { deps: happy.deps });
    assert.equal(happyResult.code, W.EXIT.ok, happyResult.errText);
    assert.equal(happy.state.closes, 1, 'the happy path closes the queue descriptor exactly once');
    assert.equal(happy.state.queueFds.size, 0, 'no queue descriptor stays open');

    const refuseMain = makeRepo('queue-close-refuse');
    const refuseQueue = queuePathOf(refuseMain);
    writeFileSync(refuseQueue, '# queue\n');
    const refuseInc = join(refuseMain, 'inc-hard.txt');
    linkSync(refuseQueue, refuseInc);
    const refuse = traceCloses();
    const refuseResult = run(refuseMain, provisionArgs('qcloserefuse', ['--include', 'inc-hard.txt']), { deps: refuse.deps });
    assert.equal(refuseResult.code, W.EXIT.stop);
    assert.equal(refuse.state.closes, 1, 'the refusal path closes the queue descriptor exactly once');
    assert.equal(refuse.state.queueFds.size, 0);
  });

  it('a queue refusal composed with a close failure surfaces both causes', () => {
    const main = makeRepo('queue-refuse-close');
    const queue = queuePathOf(main);
    writeFileSync(queue, '# queue\n');
    const inc = join(main, 'inc-hard.txt');
    linkSync(queue, inc);
    const queueFds = new Set();
    const result = run(main, provisionArgs('qrefuseclose', ['--include', 'inc-hard.txt']), {
      deps: {
        open: (p, flags, mode) => {
          const fd = openSync(p, flags, mode);
          if (p === queue) queueFds.add(fd);
          return fd;
        },
        close: (fd) => {
          if (queueFds.has(fd)) throw Object.assign(new Error('injected'), { code: 'EIO' });
          return closeSync(fd);
        },
      },
    });
    assert.equal(result.code, W.EXIT.stop);
    assert.ok(result.errText.includes('the source IS the door-time queue'), `the refusal cause survives: ${result.errText}`);
    assert.ok(result.errText.includes('failed to close'), `the close failure is not dropped: ${result.errText}`);
    assert.ok(!existsSync(join(wtDirOf(main, 'qrefuseclose'), 'inc-hard.txt')));
  });

  it('a queue-close error surfaces without destination residue', () => {
    const main = makeRepo('queue-close-error');
    const queue = queuePathOf(main);
    writeFileSync(queue, '# queue\n');
    writeFileSync(join(main, 'inc.txt'), 'payload\n');
    const queueFds = new Set();
    const result = run(main, provisionArgs('qcloseerr', ['--include', 'inc.txt']), {
      deps: {
        open: (p, flags, mode) => {
          const fd = openSync(p, flags, mode);
          if (p === queue) queueFds.add(fd);
          return fd;
        },
        close: (fd) => {
          if (queueFds.has(fd)) throw Object.assign(new Error('injected'), { code: 'EIO' });
          return closeSync(fd);
        },
      },
    });
    assert.equal(result.code, W.EXIT.stop, `a queue-close failure must surface: ${result.errText}`);
    assert.ok(!existsSync(join(wtDirOf(main, 'qcloseerr'), 'inc.txt')), 'no destination residue after a close error');
  });
});

describe('door-lane proof failures emit the contract, never a generic copy error', () => {
  it('nested-file-include-refusal-leaves-no-directory-residue', () => {
    const main = makeRepo('nested-residue');
    const queue = queuePathOf(main);
    writeFileSync(queue, '# queue\n');
    mkdirSync(join(main, 'docs/notes'), { recursive: true });
    const inc = join(main, 'docs/notes/inc-hard.txt');
    linkSync(queue, inc);
    const result = run(main, provisionArgs('nestres', ['--include', 'docs/notes/inc-hard.txt']));
    const wt = wtDirOf(main, 'nestres');
    assert.equal(result.code, W.EXIT.stop, `the nested include must refuse: ${result.errText}`);
    assert.ok(result.errText.includes(CONTRACT));
    assert.ok(!existsSync(join(wt, 'docs/notes')), 'the fresh parent-directory chain is never created for a refused leaf');
  });

  it('door-lane-identity-probe-errors-emit-contract (walk lstat / open / fstat)', () => {
    const scenarios = [
      ['probe-lstat', (state, incReal) => ({
        lstat: (p) => {
          if (state.walking && p === incReal) throw Object.assign(new Error('injected'), { code: 'EIO' });
          return lstatSync(p);
        },
      })],
      ['probe-open', (state, incReal) => ({
        open: (p, flags, mode) => {
          if (state.walking && p === incReal) throw Object.assign(new Error('injected'), { code: 'EACCES' });
          return openSync(p, flags, mode);
        },
      })],
      ['probe-fstat', (state, incReal) => {
        const sourceFds = new Set();
        return {
          open: (p, flags, mode) => {
            const fd = openSync(p, flags, mode);
            if (state.walking && p === incReal) sourceFds.add(fd);
            return fd;
          },
          fstat: (fd) => {
            if (sourceFds.has(fd)) throw Object.assign(new Error('injected'), { code: 'EIO' });
            return fstatSync(fd);
          },
        };
      }],
    ];
    for (const [name, makeDeps] of scenarios) {
      const main = makeRepo(`door-${name}`);
      const inc = join(main, 'inc.txt');
      writeFileSync(inc, 'payload\n');
      const incReal = realpathSync(inc);
      const state = { walking: false };
      const git = makeGit(main, { onAdd: () => { state.walking = true; } });
      const result = run(main, provisionArgs(name, ['--include', 'inc.txt']), { git, deps: makeDeps(state, incReal) });
      assertIdentityStop(result, join(wtDirOf(main, name), 'inc.txt'));
    }
  });

  it('point-of-use-queue-guard-errors-emit-contract', () => {
    const main = makeRepo('pou-guard');
    writeFileSync(queuePathOf(main), '# queue\n');
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'payload\n');
    const queue = queuePathOf(main);
    const state = { walking: false };
    const git = makeGit(main, { onAdd: () => { state.walking = true; } });
    const result = run(main, provisionArgs('pouguard', ['--include', 'inc.txt']), {
      git,
      deps: {
        realpath: (p) => {
          if (state.walking && p === queue) throw Object.assign(new Error('injected'), { code: 'EACCES' });
          return realpathSync(p);
        },
      },
    });
    assertIdentityStop(result, join(wtDirOf(main, 'pouguard'), 'inc.txt'));
  });
});

describe('directory include partial-subtree semantics', () => {
  it('directory-include-stop-preserves-copied-siblings-and-omits-refused-leaf', () => {
    const main = makeRepo('partial-subtree');
    const queue = queuePathOf(main);
    writeFileSync(queue, '# queue\n');
    const dir = join(main, 'assets');
    mkdirSync(dir);
    writeFileSync(join(dir, 'a.txt'), 'first\n');
    writeFileSync(join(dir, 'b.txt'), 'second\n');
    const dirReal = realpathSync(dir);
    const bReal = join(dirReal, 'b.txt');
    const wt = wtDirOf(main, 'partial');
    const refusedDst = join(wt, 'assets/b.txt');
    const destinationTouches = [];
    const result = run(main, provisionArgs('partial', ['--include', 'assets']), {
      deps: {
        readdir: (p) => (p === dirReal ? ['a.txt', 'b.txt'] : readdirSync(p)),
        open: (p, flags, mode) => {
          if (p === bReal) {
            unlinkSync(queue);
            linkSync(bReal, queue);
          }
          if (p === refusedDst) destinationTouches.push(['open', p]);
          return openSync(p, flags, mode);
        },
        mkdirPlain: (p, opts) => {
          if (p === refusedDst) destinationTouches.push(['mkdir', p]);
          return mkdirSync(p, opts);
        },
      },
    });
    assert.equal(result.code, W.EXIT.stop);
    assert.equal(readFileSync(join(wt, 'assets/a.txt'), 'utf8'), 'first\n', 'the copied sibling survives');
    assert.ok(!existsSync(refusedDst));
    assert.deepEqual(destinationTouches, [], 'the refused leaf destination is never opened or created');
  });
});

describe('pre-mutation include overlap refusals (doorless-lane bypass is closed before git mutates)', () => {
  it('include-overlapping-provision-set-path-refused-at-preflight', () => {
    const main = makeRepo('overlap-footprint');
    const git = makeGit(main);
    const result = run(main, provisionArgs('ovlfoot', ['--include', 'AGENTS.md']), { git });
    assert.equal(result.code, W.EXIT.stop, `a footprint overlap must refuse: ${result.errText}`);
    assert.deepEqual(git.addCalls, [], 'the refusal must land BEFORE git worktree add');
  });

  it('include-overlapping-seed-plan-refused-at-preflight (and the handoff rel)', () => {
    const main = makeRepo('overlap-seed');
    writeFileSync(join(main, 'docs/plans/feature-ovlseed.md'), '# body\n');
    const seedGit = makeGit(main);
    const seedResult = run(main, provisionArgs('ovlseed', ['--include', 'docs/plans/feature-ovlseed.md']), { git: seedGit });
    assert.equal(seedResult.code, W.EXIT.stop, `a seed-destination overlap must refuse: ${seedResult.errText}`);
    assert.deepEqual(seedGit.addCalls, []);

    writeFileSync(join(main, 'docs/plans/handoff-ovlseed.md'), '# decoy\n');
    const handoffGit = makeGit(main);
    const handoffResult = run(main, provisionArgs('ovlseed', ['--include', 'docs/plans/handoff-ovlseed.md']), { git: handoffGit });
    assert.equal(handoffResult.code, W.EXIT.stop, `a handoff overlap must refuse: ${handoffResult.errText}`);
    assert.deepEqual(handoffGit.addCalls, []);
  });

  it('ancestor-child-include-roots-refused-at-preflight (both orders and the exact duplicate)', () => {
    const main = makeRepo('overlap-nested');
    const dir = join(main, 'assets');
    mkdirSync(dir);
    writeFileSync(join(dir, 'inner.txt'), 'inner\n');
    for (const pair of [
      ['--include', 'assets', '--include', 'assets/inner.txt'],
      ['--include', 'assets/inner.txt', '--include', 'assets'],
      ['--include', 'assets', '--include', 'assets'],
    ]) {
      const git = makeGit(main);
      const result = run(main, provisionArgs('ovlnest', pair), { git });
      assert.equal(result.code, W.EXIT.stop, `overlapping include roots must refuse (${pair.join(' ')}): ${result.errText}`);
      assert.deepEqual(git.addCalls, []);
    }
  });

  it('inode-reuse-within-window-is-an-accepted-residual (characterize: a point-in-time inode proof)', () => {
    const main = makeRepo('inode-reuse');
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'approved\n');
    const incReal = realpathSync(inc);
    const approved = lstatSync(incReal);
    const impostor = join(main, 'impostor.txt');
    const phase = { walking: false };
    const fds = new Set();
    const wearApprovedIdentity = (st) => Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: approved.dev, ino: approved.ino });
    const git = makeGit(main, { onAdd: () => { phase.walking = true; writeFileSync(impostor, 'impostor at a reused inode\n'); renameSync(impostor, inc); } });
    const result = run(main, provisionArgs('inodereuse', ['--include', 'inc.txt']), {
      git,
      deps: {
        lstat: (p) => {
          const st = lstatSync(p);
          return phase.walking && p === incReal ? wearApprovedIdentity(st) : st;
        },
        open: (p, flags, mode) => {
          const fd = openSync(p, flags, mode);
          if (phase.walking && p === incReal) fds.add(fd);
          return fd;
        },
        fstat: (fd) => {
          const st = fstatSync(fd);
          return fds.has(fd) ? wearApprovedIdentity(st) : st;
        },
      },
    });
    assert.equal(result.code, W.EXIT.ok, result.errText);
    assert.equal(readFileSync(join(wtDirOf(main, 'inodereuse'), 'inc.txt'), 'utf8'), 'impostor at a reused inode\n',
      'a node recreated at the same {device, inode} within the window passes — inherent to a point-in-time inode proof');
  });

  it('fresh-provision-include-destination-preexists-stops (aliasing the comparator missed is caught at the door)', () => {
    for (const [name, srcKind] of [['alias-file', 'file'], ['alias-dir', 'directory']]) {
      const main = makeRepo(`fresh-preexist-${name}`);
      const inc = join(main, srcKind === 'file' ? 'inc.txt' : 'assets');
      if (srcKind === 'file') {
        writeFileSync(inc, 'payload\n');
      } else {
        mkdirSync(inc);
        writeFileSync(join(inc, 'a.txt'), 'a\n');
      }
      const rel = srcKind === 'file' ? 'inc.txt' : 'assets';
      const wt = wtDirOf(main, name);
      const dstRoot = join(wt, rel);
      const aliasStat = srcKind === 'file'
        ? { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, dev: 9, ino: 9, mode: 0o100644 }
        : { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false, dev: 9, ino: 9, mode: 0o040755 };
      const result = run(main, provisionArgs(name, ['--include', rel]), {
        deps: {
          lstat: (p) => (p === dstRoot ? aliasStat : lstatSync(p)),
        },
      });
      assert.equal(result.code, W.EXIT.stop, `a pre-existing include destination on a FRESH provision must refuse (${name}): ${result.errText}`);
      assert.ok(result.errText.includes(CONTRACT), `the STOP carries the contract (${name}): ${result.errText}`);
      assert.ok(result.errText.includes('inspect the unexpected destination'), `the STOP carries the surgical recovery, never a blind --resume steer (${name}): ${result.errText}`);
    }
  });

  it('fresh-provision-existing-nested-directory-destination-stops', () => {
    const main = makeRepo('fresh-nested-dir');
    const dir = join(main, 'assets');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub/deep.txt'), 'deep\n');
    const wt = wtDirOf(main, 'freshnest');
    const nestedDst = join(wt, 'assets/sub');
    const aliasDirStat = { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false, dev: 9, ino: 9, mode: 0o040755 };
    const result = run(main, provisionArgs('freshnest', ['--include', 'assets']), {
      deps: {
        lstat: (p) => (p === nestedDst ? aliasDirStat : lstatSync(p)),
      },
    });
    assert.equal(result.code, W.EXIT.stop, `an existing nested directory destination must refuse on fresh: ${result.errText}`);
    assert.ok(result.errText.includes(CONTRACT));
    assert.ok(result.errText.includes('inspect the unexpected destination'), `the nested STOP carries the surgical recovery too: ${result.errText}`);
    assert.ok(!existsSync(join(wt, 'assets/sub/deep.txt')), 'nothing is copied into the pre-existing directory');
  });

  it('copy-failure-with-both-close-failures-names-each-descriptor', () => {
    const main = makeRepo('both-close-fail');
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'payload\n');
    const incReal = realpathSync(inc);
    const wt = wtDirOf(main, 'bothclose');
    const doorFds = new Set();
    const result = run(main, provisionArgs('bothclose', ['--include', 'inc.txt']), {
      deps: {
        open: (p, flags, mode) => {
          const fd = openSync(p, flags, mode);
          if (p === incReal || p === join(wt, 'inc.txt')) doorFds.add(fd);
          return fd;
        },
        read: (fd, ...rest) => {
          if (doorFds.has(fd)) throw Object.assign(new Error('injected'), { code: 'EIO' });
          return readSync(fd, ...rest);
        },
        close: (fd) => {
          if (doorFds.has(fd)) throw Object.assign(new Error('injected'), { code: 'EBADF' });
          return closeSync(fd);
        },
      },
    });
    assert.equal(result.code, W.EXIT.stop);
    assert.ok(result.errText.includes('destination descriptor failed to close'), `the destination close failure is named: ${result.errText}`);
    assert.ok(result.errText.includes('source descriptor failed to close'), `the source close failure is named too: ${result.errText}`);
  });

  it('refusal-with-source-close-failure-surfaces-both', () => {
    const main = makeRepo('refuse-srcclose');
    const queue = queuePathOf(main);
    writeFileSync(queue, '# queue\n');
    const inc = join(main, 'inc-hard.txt');
    linkSync(queue, inc);
    const incReal = realpathSync(inc);
    const sourceFds = new Set();
    const result = run(main, provisionArgs('refsrcclose', ['--include', 'inc-hard.txt']), {
      deps: {
        open: (p, flags, mode) => {
          const fd = openSync(p, flags, mode);
          if (p === incReal) sourceFds.add(fd);
          return fd;
        },
        close: (fd) => {
          if (sourceFds.has(fd)) throw Object.assign(new Error('injected'), { code: 'EIO' });
          return closeSync(fd);
        },
      },
    });
    assert.equal(result.code, W.EXIT.stop);
    assert.ok(result.errText.includes('the source IS the door-time queue'), `the refusal cause survives: ${result.errText}`);
    assert.ok(result.errText.includes('source descriptor failed to close'), `the source-close failure is not dropped: ${result.errText}`);
  });

  it('resume-kept-include-destination-stays (the stated residual: the door proves only what THIS run copies)', () => {
    const main = makeRepo('resume-kept');
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'original\n');
    const git = makeGit(main);
    const first = run(main, provisionArgs('reskept', ['--include', 'inc.txt']), { git });
    assert.equal(first.code, W.EXIT.ok, first.errText);
    const impostor = join(main, 'impostor.txt');
    writeFileSync(impostor, 'replaced later\n');
    renameSync(impostor, inc);
    const resumed = run(main, provisionArgs('reskept', ['--include', 'inc.txt', '--resume']), { git });
    assert.equal(resumed.code, W.EXIT.ok, resumed.errText);
    assert.equal(readFileSync(join(wtDirOf(main, 'reskept'), 'inc.txt'), 'utf8'), 'original\n', 'the prior copy is kept, never re-copied');
  });
});

describe('pre-mutation include root refusals', () => {
  it('special-include-root-refused-at-preflight: no worktree is created', () => {
    const main = makeRepo('root-special');
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'payload\n');
    const incReal = realpathSync(inc);
    const special = { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false, dev: 7, ino: 7, mode: 0o060000 };
    const git = makeGit(main);
    const result = run(main, provisionArgs('rootspecial', ['--include', 'inc.txt']), {
      git,
      deps: { lstat: (p) => (p === incReal ? special : lstatSync(p)) },
    });
    assert.equal(result.code, W.EXIT.stop, `a special include root must refuse: ${result.errText}`);
    assert.deepEqual(git.addCalls, [], 'the refusal must land BEFORE git worktree add');
  });

  it('include-root-identity-probe-error-stops-at-preflight: no worktree is created', () => {
    const main = makeRepo('root-probe-error');
    const inc = join(main, 'inc.txt');
    writeFileSync(inc, 'payload\n');
    const incReal = realpathSync(inc);
    const git = makeGit(main);
    const result = run(main, provisionArgs('rootprobe', ['--include', 'inc.txt']), {
      git,
      deps: {
        lstat: (p) => {
          if (p === incReal) throw Object.assign(new Error('injected'), { code: 'EIO' });
          return lstatSync(p);
        },
      },
    });
    assert.equal(result.code, W.EXIT.stop, `an identity-probe error must refuse: ${result.errText}`);
    assert.deepEqual(git.addCalls, [], 'the refusal must land BEFORE git worktree add');
  });
});

describe('happy include copies stay byte-identical (characterize-first)', () => {
  it('happy-include-copy-byte-identical: file form beside a present, unrelated queue', () => {
    const main = makeRepo('happy-file');
    writeFileSync(queuePathOf(main), '# queue\n');
    writeFileSync(join(main, 'inc.txt'), 'exact bytes é\n');
    const result = run(main, provisionArgs('happyfile', ['--include', 'inc.txt']));
    assert.equal(result.code, W.EXIT.ok, result.errText);
    assert.equal(readFileSync(join(wtDirOf(main, 'happyfile'), 'inc.txt'), 'utf8'), 'exact bytes é\n');
  });

  it('happy-include-copy-byte-identical: directory form with a deeply nested child', () => {
    const main = makeRepo('happy-dir');
    writeFileSync(queuePathOf(main), '# queue\n');
    const deepDir = join(main, 'assets/a/b/c');
    mkdirSync(deepDir, { recursive: true });
    writeFileSync(join(main, 'assets/top.txt'), 'top\n');
    writeFileSync(join(deepDir, 'deep.txt'), 'deep payload\n');
    const result = run(main, provisionArgs('happydir', ['--include', 'assets']));
    assert.equal(result.code, W.EXIT.ok, result.errText);
    const wt = wtDirOf(main, 'happydir');
    assert.equal(readFileSync(join(wt, 'assets/top.txt'), 'utf8'), 'top\n');
    assert.equal(readFileSync(join(wt, 'assets/a/b/c/deep.txt'), 'utf8'), 'deep payload\n');
  });
});

describe('the contract sentence is exported and emitted', () => {
  it('include-identity-stop-emits-contract: the constant matches the doc token and rides a STOP', () => {
    assert.equal(W.INCLUDE_IDENTITY_RULE, CONTRACT, 'the exported constant is the doc-parity token');
    const main = makeRepo('contract-emit');
    const queue = queuePathOf(main);
    writeFileSync(queue, '# queue\n');
    const inc = join(main, 'inc-hard.txt');
    linkSync(queue, inc);
    const result = run(main, provisionArgs('contract', ['--include', 'inc-hard.txt']));
    assert.equal(result.code, W.EXIT.stop);
    assert.ok(result.errText.includes(W.INCLUDE_IDENTITY_RULE), 'the STOP surface emits the exported constant');
  });
});
