import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { EXIT, loadWorktreesConfig, runCli, WORKTREES_STOP } from './worktrees.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-wt-delegated2-'));
const PLAN_ARGS = ['--plan', 'docs/plans/SEED-PROMPT-x.md'];
const REPO_GITS = new Map();
const HEAD = '2222222222222222222222222222222222222222';

after(() => rmSync(TMP, { recursive: true, force: true }));

const makeGit = (main) => {
  const commonDir = join(main, '.git');
  const entries = [];
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const porcelain = () => [
    `worktree ${main}`, `HEAD ${HEAD}`, 'branch refs/heads/main', '',
    ...entries.flatMap(({ path, branch }) => [`worktree ${path}`, `HEAD ${HEAD}`, `branch refs/heads/${branch}`, '']),
  ].join('\n');
  return (args) => {
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return ok(main);
    if (args[0] === 'rev-parse' && args.includes('--git-dir')) return ok(`${commonDir}\n`);
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return ok(`${commonDir}\n`);
    if (args[0] === 'rev-parse' && args.includes('HEAD')) return ok(`${HEAD}\n`);
    if (args[0] === 'check-ignore') return ok();
    if (args[0] === 'ls-files') return ok();
    if (args[0] === 'status' && args[1] === '--porcelain') return ok();
    if (args[0] === 'worktree' && args[1] === 'list') return ok(porcelain());
    if (args[0] === 'worktree' && args[1] === 'add') {
      const branch = args[3];
      const requested = args[4];
      const canonical = join(realpathSync(dirname(requested)), basename(requested));
      mkdirSync(canonical, { recursive: true });
      entries.push({ path: canonical, branch });
      return ok();
    }
    return { status: 128, stdout: '', stderr: `unexpected git call: ${args.join(' ')}` };
  };
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
  REPO_GITS.set(main, makeGit(main));
  return main;
};

const run = (argv, { cwd, deps = {} }) => {
  const out = [];
  const err = [];
  const code = runCli(argv, {
    cwd,
    git: deps.git ?? REPO_GITS.get(cwd),
    log: (line) => out.push(line),
    logError: (line) => err.push(line),
    ...deps,
  });
  return { code, out, err, text: out.join('\n'), errText: err.join('\n') };
};

const provision = (repo, slug, extra = [], deps = {}) => {
  const result = run(['provision', slug, ...PLAN_ARGS, '--as', `feature-${slug}.md`, ...extra], { cwd: repo, deps });
  return { result, worktree: join(dirname(repo), `${basename(repo)}--${slug}`) };
};

const provisionOk = (repo, slug, extra = [], deps = {}) => {
  const outcome = provision(repo, slug, extra, deps);
  assert.equal(outcome.result.code, EXIT.ok, outcome.result.errText);
  return outcome;
};

const nodeModulesReport = (result) => result.out.find((line) => line.startsWith('  node_modules:'));

describe('delegated2 finding 1 — the read door binds lstat identity to the descriptor', () => {
  it('rejects a regular-file replacement whose descriptor dev/ino differs from the injected lstat', () => {
    const repo = makeRepo('read-identity-main');
    const config = join(repo, 'docs/ai/worktrees.json');
    const original = join(repo, 'docs/ai/worktrees-original.json');
    const replacement = join(repo, 'docs/ai/worktrees-replacement.json');
    const swaps = [];
    writeFileSync(config, JSON.stringify({ parentDir: 'trusted' }));
    writeFileSync(replacement, JSON.stringify({ parentDir: 'attacker' }));
    const observed = (() => {
      try {
        return {
          value: loadWorktreesConfig(repo, {
            lstat: (path) => {
              if (path !== config || swaps.length > 0) return lstatSync(path);
              const before = lstatSync(path);
              renameSync(path, original);
              renameSync(replacement, path);
              swaps.push(path);
              return before;
            },
          }),
          error: null,
        };
      } catch (error) {
        return { value: null, error: { code: error.code, message: error.message } };
      }
    })();
    assert.deepEqual(observed, {
      value: null,
      error: {
        code: WORKTREES_STOP,
        message: '[agent-workflow-kit] docs/ai/worktrees.json is not a regular file — refusing to read it',
      },
    });
  });
});

describe('delegated2 finding 2 — resume plan compatibility is a zero-write preflight', () => {
  it('allows no plan or the exact seed, but rejects a different --as before the writability probe', () => {
    const repo = makeRepo('resume-plan-main');
    const { worktree } = provisionOk(repo, 'guard');
    const exact = run(['provision', 'guard', '--resume', ...PLAN_ARGS, '--as', 'feature-guard.md'], { cwd: repo });
    rmSync(join(worktree, 'docs/plans/feature-guard.md'));
    const absent = run(['provision', 'guard', '--resume', ...PLAN_ARGS, '--as', 'feature-guard.md'], { cwd: repo });
    const probeWrites = [];
    const mismatch = run(['provision', 'guard', '--resume', ...PLAN_ARGS, '--as', 'feature-other.md'], {
      cwd: repo,
      deps: {
        mkdirPlain: (path) => {
          probeWrites.push(path);
          mkdirSync(path);
        },
      },
    });
    assert.deepEqual(
      {
        exactCode: exact.code,
        absentCode: absent.code,
        mismatchCode: mismatch.code,
        mismatchError: mismatch.errText,
        probeWrites: probeWrites.length,
        extraPlanExists: existsSync(join(worktree, 'docs/plans/feature-other.md')),
      },
      {
        exactCode: EXIT.ok,
        absentCode: EXIT.ok,
        mismatchCode: EXIT.stop,
        mismatchError: '[worktrees] [agent-workflow-kit] --resume plan mismatch: found [feature-guard.md], expected [feature-other.md] or no in-flight plan — re-run with --as feature-guard.md, or remove the existing plan by hand',
        probeWrites: 0,
        extraPlanExists: false,
      },
    );
  });
});

describe('delegated2 finding 3 — install advice follows one unambiguous package manager', () => {
  it('lets packageManager win over a conflicting lockfile', () => {
    const repo = makeRepo('manager-field-main');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.15.0' }));
    writeFileSync(join(repo, 'yarn.lock'), 'fixture\n');
    const { result, worktree } = provisionOk(repo, 'field', ['--install']);
    assert.equal(
      nodeModulesReport(result),
      `  node_modules: install it yourself (zero spawn): cd ${worktree} && pnpm install`,
    );
  });

  it('maps one lockfile, keeps the npm default for none, neutral for several', () => {
    const cases = [
      { name: 'lock-npm', locks: ['package-lock.json'], expected: 'npm install' },
      { name: 'lock-pnpm', locks: ['pnpm-lock.yaml'], expected: 'pnpm install' },
      { name: 'lock-yarn', locks: ['yarn.lock'], expected: 'yarn install' },
      { name: 'lock-bun-binary', locks: ['bun.lockb'], expected: 'bun install' },
      { name: 'lock-bun-text', locks: ['bun.lock'], expected: 'bun install' },
      { name: 'lock-ambiguous', locks: ['package-lock.json', 'yarn.lock'], expected: null },
      { name: 'lock-none', locks: [], expected: 'npm install' },
    ];
    const actual = cases.map(({ name, locks, expected }) => {
      const repo = makeRepo(`${name}-main`);
      for (const lock of locks) writeFileSync(join(repo, lock), 'fixture\n');
      const { result, worktree } = provisionOk(repo, name, ['--install']);
      return {
        name,
        report: nodeModulesReport(result),
        expected: expected === null
          ? '  node_modules: install command not printed — package manager is ambiguous or unknown; install dependencies in the worktree by hand'
          : `  node_modules: install it yourself (zero spawn): cd ${worktree} && ${expected}`,
      };
    });
    assert.deepEqual(
      actual.map(({ name, report }) => ({ name, report })),
      actual.map(({ name, expected }) => ({ name, report: expected })),
    );
  });
});
