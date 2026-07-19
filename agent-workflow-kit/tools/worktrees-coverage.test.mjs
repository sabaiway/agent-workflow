// worktrees-coverage.test.mjs — D3(d) top-ups: error branches of the read door and its callers.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, lstatSync, unlinkSync, realpathSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  EXIT, WORKTREES_STOP, runCli, loadWorktreesConfig, parseArgs, copyTreeIfMissing, handoffBasename,
} from './worktrees.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-wt-cov-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

const EXCLUDES = ['/docs/ai/', '/docs/plans/', '/.claude/', '/AGENTS.md', '/CLAUDE.md', '/node_modules', ''];

const makeRepo = (name, { excludes = EXCLUDES } = {}) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  sh(['init', '-q', '-b', 'main'], main);
  sh(['config', 'user.email', 'coder-tools@proton.me'], main);
  sh(['config', 'user.name', 'coder-tool'], main);
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  sh(['add', '-A'], main);
  sh(['commit', '-q', '-m', 'init'], main);
  writeFileSync(join(main, '.git/info/exclude'), excludes.join('\n'));
  writeFileSync(join(main, 'AGENTS.md'), '# agents\n');
  mkdirSync(join(main, 'docs/ai'), { recursive: true });
  writeFileSync(join(main, 'docs/ai/gates.json'), JSON.stringify({ gates: [] }));
  mkdirSync(join(main, 'docs/plans'), { recursive: true });
  writeFileSync(join(main, 'docs/plans/SEED-PROMPT-x.md'), '# body\n');
  return main;
};

const run = (argv, { cwd, deps = {} }) => {
  const out = [];
  const err = [];
  const code = runCli(argv, { cwd, log: (l) => out.push(l), logError: (l) => err.push(l), ...deps });
  return { code, out, err, text: out.join('\n'), errText: err.join('\n') };
};

const provisionOk = (repo, slug, extra = [], deps = {}) => {
  const r = run(['provision', slug, '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', `feature-${slug}.md`, ...extra], { cwd: repo, deps });
  assert.equal(r.code, EXIT.ok, r.errText);
  return join(dirname(repo), `${basename(repo)}--${slug}`);
};

describe('worktrees coverage — config door error branches', () => {
  it('a leaf lstat error is a typed unreadable STOP (door error outcome)', () => {
    const repo = makeRepo('cov-cfg-err');
    writeFileSync(join(repo, 'docs/ai/worktrees.json'), '{}');
    const leaf = join(repo, 'docs/ai/worktrees.json');
    assert.throws(
      () => loadWorktreesConfig(repo, {
        lstat: (p) => {
          if (p === leaf) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          return lstatSync(p);
        },
      }),
      (e) => e.code === WORKTREES_STOP && /unreadable \(EACCES\)/.test(e.message),
    );
  });
  it('a JSON array config is the must-be-object STOP', () => {
    const repo = makeRepo('cov-cfg-arr');
    writeFileSync(join(repo, 'docs/ai/worktrees.json'), '[]');
    assert.throws(
      () => loadWorktreesConfig(repo),
      (e) => e.code === WORKTREES_STOP && /must be a JSON object/.test(e.message),
    );
  });
});

describe('worktrees coverage — copy error branches', () => {
  it('a source lstat error is the copy-failed-reading STOP', () => {
    const wt = join(TMP, 'cov-copy-err-wt');
    mkdirSync(wt, { recursive: true });
    const src = join(TMP, 'cov-copy-err-src.txt');
    writeFileSync(src, 'x\n');
    assert.throws(
      () => copyTreeIfMissing({
        srcAbs: src,
        dstAbs: join(wt, 'f.txt'),
        wtRoot: wt,
        rel: 'f.txt',
        deps: {
          lstat: (p) => {
            if (p === src) throw Object.assign(new Error('EIO'), { code: 'EIO' });
            return lstatSync(p);
          },
        },
      }),
      (e) => e.code === WORKTREES_STOP && /copy failed \(EIO\) reading/.test(e.message),
    );
  });
  it('a destination stat error during cleanup composes both errors', () => {
    const wt = join(TMP, 'cov-cleanup-stat-wt');
    mkdirSync(wt, { recursive: true });
    const src = join(TMP, 'cov-cleanup-stat-src.txt');
    writeFileSync(src, 'x\n');
    const dst = join(wt, 'f.txt');
    let copyFailed = false;
    assert.throws(
      () => copyTreeIfMissing({
        srcAbs: src,
        dstAbs: dst,
        wtRoot: wt,
        rel: 'f.txt',
        deps: {
          copyFile: () => {
            copyFailed = true;
            throw Object.assign(new Error('io'), { code: 'EIO' });
          },
          lstat: (p) => {
            if (copyFailed && p === dst) throw Object.assign(new Error('denied'), { code: 'EACCES' });
            return lstatSync(p);
          },
        },
      }),
      (e) => e.code === WORKTREES_STOP
        && /cleanup failed \(EACCES\)/.test(e.message)
        && /untrusted destination remains/.test(e.message),
    );
  });
  it('a source swapped during the copy is the mid-copy STOP', () => {
    const wt = join(TMP, 'cov-copy-swap-wt');
    mkdirSync(wt, { recursive: true });
    const src = join(TMP, 'cov-copy-swap-src.txt');
    writeFileSync(src, 'x\n');
    const lie = { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false, mode: 0o644 };
    let n = 0;
    assert.throws(
      () => copyTreeIfMissing({
        srcAbs: src,
        dstAbs: join(wt, 'f.txt'),
        wtRoot: wt,
        rel: 'f.txt',
        deps: {
          lstat: (p) => {
            if (p === src) {
              n += 1;
              if (n >= 2) return lie;
            }
            return lstatSync(p);
          },
        },
      }),
      (e) => e.code === WORKTREES_STOP && /changed mid-copy/.test(e.message),
    );
  });
});

describe('worktrees coverage — handoff door STOPs on resume', () => {
  it('a handoff-named directory is the resume nonRegular STOP', () => {
    const repo = makeRepo('cov-h-dir');
    const wt = provisionOk(repo, 'alpha');
    const handoffPath = join(wt, 'docs/plans', handoffBasename('alpha'));
    unlinkSync(handoffPath);
    mkdirSync(handoffPath);
    const r = run(['provision', 'alpha', '--resume', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-alpha.md'], { cwd: repo });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /not regular file/);
  });
  it('a handoff turning non-regular at the stub write is a typed STOP (race arm)', () => {
    const repo = makeRepo('cov-h-stub');
    const wt = provisionOk(repo, 'alpha');
    const handoffPath = join(wt, 'docs/plans', handoffBasename('alpha'));
    const lie = { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false };
    let n = 0;
    const r = run(['provision', 'alpha', '--resume', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-alpha.md'], {
      cwd: repo,
      deps: {
        lstat: (p) => {
          if (p === handoffPath) {
            n += 1;
            if (n >= 3) return lie;
          }
          return lstatSync(p);
        },
      },
    });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /not readable as a regular file/);
  });
  it('a handoff turning non-regular at the record write is a typed STOP (race arm)', () => {
    const repo = makeRepo('cov-h-rec');
    const wt = provisionOk(repo, 'alpha');
    const handoffPath = join(wt, 'docs/plans', handoffBasename('alpha'));
    const lie = { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false };
    let n = 0;
    const r = run(['provision', 'alpha', '--resume', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-alpha.md'], {
      cwd: repo,
      deps: {
        lstat: (p) => {
          if (p === handoffPath) {
            n += 1;
            if (n >= 4) return lie;
          }
          return lstatSync(p);
        },
      },
    });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /not readable as a regular file/);
  });
});

describe('worktrees coverage — node_modules degrade branches', () => {
  it('an unresolvable main node_modules prints the install lane', () => {
    const repo = makeRepo('cov-nm-unres');
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    const nm = join(repo, 'node_modules');
    const r = run(['provision', 'alpha', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-alpha.md'], {
      cwd: repo,
      deps: {
        realpath: (p) => {
          if (p === nm) throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' });
          return realpathSync(p);
        },
      },
    });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.match(r.text, /node_modules: main's is unresolvable/);
  });
  it('a failing symlink call prints the symlink-failed lane', () => {
    const repo = makeRepo('cov-nm-link');
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    const r = run(['provision', 'alpha', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-alpha.md'], {
      cwd: repo,
      deps: { symlink: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } },
    });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.match(r.text, /node_modules: symlink failed \(EPERM\)/);
  });
});

describe('worktrees coverage — vscode degrade branches', () => {
  it('an unreadable main settings file is skipped with the code', () => {
    const repo = makeRepo('cov-vs-err', { excludes: [...EXCLUDES.slice(0, -1), '/.vscode/', ''] });
    mkdirSync(join(repo, '.vscode'), { recursive: true });
    writeFileSync(join(repo, '.vscode/settings.json'), '{}');
    const settings = join(repo, '.vscode/settings.json');
    const r = run(['provision', 'alpha', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-alpha.md'], {
      cwd: repo,
      deps: {
        lstat: (p) => {
          if (p === settings) throw Object.assign(new Error('EIO'), { code: 'EIO' });
          return lstatSync(p);
        },
      },
    });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.match(r.text, /settings\.json is unreadable \(EIO\) — skipped/);
  });
  it('a non-JSON main settings file is skipped as not a JSON object', () => {
    const repo = makeRepo('cov-vs-bad', { excludes: [...EXCLUDES.slice(0, -1), '/.vscode/', ''] });
    mkdirSync(join(repo, '.vscode'), { recursive: true });
    writeFileSync(join(repo, '.vscode/settings.json'), 'not json');
    const r = run(['provision', 'alpha', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-alpha.md'], { cwd: repo });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.match(r.text, /settings\.json is not a JSON object — skipped/);
  });
});

describe('worktrees coverage — install-advice and late-net defensive branches', () => {
  it('a lockfile lstat error degrades to the neutral install advice', () => {
    const repo = makeRepo('cov-lock-err');
    const denied = join(repo, 'package-lock.json');
    const r = run(['provision', 'alpha', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-alpha.md', '--install'], {
      cwd: repo,
      deps: {
        lstat: (p) => {
          if (p === denied) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          return lstatSync(p);
        },
      },
    });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.match(r.text, /install command not printed — package manager is ambiguous or unknown/);
  });
  it('a plan appearing after the resume preflight still trips the late exactly-one net', () => {
    const repo = makeRepo('cov-late-net');
    const wt = provisionOk(repo, 'alpha');
    const plansDir = join(wt, 'docs/plans');
    let plansReads = 0;
    const r = run(['provision', 'alpha', '--resume', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-alpha.md'], {
      cwd: repo,
      deps: {
        readdir: (p, opts) => {
          const names = readdirSync(p, opts);
          if (p === plansDir) {
            plansReads += 1;
            if (plansReads >= 3) {
              const extra = typeof names[0] === 'string' || names.length === 0
                ? 'feature-extra.md'
                : { name: 'feature-extra.md', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
              return [...names, extra];
            }
          }
          return names;
        },
      },
    });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /EXACTLY ONE in-flight plan/);
  });
});

describe('worktrees coverage — remaining honest lanes', () => {
  it('an invalid-JSON worktree gates.json renders capability-unknown on resume', () => {
    const repo = makeRepo('cov-gates-bad');
    const wt = provisionOk(repo, 'alpha');
    writeFileSync(join(wt, 'docs/ai/gates.json'), 'nope');
    const r = run(['provision', 'alpha', '--resume', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-alpha.md'], { cwd: repo });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.match(r.text, /gates\.json: unreadable at the worktree — final-capability unknown/);
  });
  it('list without linked worktrees says so and exits ok', () => {
    const repo = makeRepo('cov-list-none');
    const r = run(['list'], { cwd: repo });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.match(r.text, /no linked worktrees/);
  });
  it('a second positional is the unexpected-argument usage STOP', () => {
    assert.throws(
      () => parseArgs(['provision', 'a', 'extra']),
      (e) => e.code === WORKTREES_STOP && /unexpected argument/.test(e.message),
    );
  });
});
