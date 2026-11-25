import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { makeFixtureRepo } from '../../scripts/testing/fixture-repo.mjs';
import { stripGitLocationEnv } from './git-env.mjs';
import { writeApprovedPlan } from './plan-approval/approved-plan-harness.test.mjs';
import { basename, dirname, join } from 'node:path';
import { EXIT, loadWorktreesConfig, runCli, WORKTREES_STOP } from './worktrees.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-wt-delegated2-'));
const PLAN_ARGS = ['--plan', 'docs/plans/SEED-PROMPT-x.md'];
after(() => rmSync(TMP, { recursive: true, force: true }));

const fixtureGit = (args, cwd) => {
  const env = stripGitLocationEnv(process.env);
  delete env.NODE_TEST_CONTEXT;
  return spawnSync('git', args, { cwd, env, encoding: 'utf8' });
};
const sh = (args, cwd) => {
  const result = fixtureGit(args, cwd);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
};

const makeRepo = (name, headFiles = null) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  if (headFiles !== null) {
    makeFixtureRepo((args) => sh(args, main), main, ['-q', '-b', 'main']);
    sh(['config', 'user.email', 'coder-tools@proton.me'], main);
    sh(['config', 'user.name', 'coder-tool'], main);
    for (const [rel, body] of Object.entries(headFiles)) {
      mkdirSync(dirname(join(main, rel)), { recursive: true });
      writeFileSync(join(main, rel), body);
    }
    sh(['add', '-A'], main);
    sh(['commit', '-q', '-m', 'init'], main);
    writeFileSync(join(main, '.git/info/exclude'), ['/docs/ai/', '/docs/plans/', '/.claude/', '/AGENTS.md', '/CLAUDE.md', '/node_modules', '/.vscode/', ''].join('\n'));
  }
  writeFileSync(join(main, 'AGENTS.md'), '# agents\n');
  mkdirSync(join(main, 'docs/ai'), { recursive: true });
  writeFileSync(join(main, 'docs/ai/gates.json'), JSON.stringify({ gates: [] }));
  if (headFiles !== null) {
    writeApprovedPlan(main, PLAN_ARGS[1]);
  } else {
    mkdirSync(join(main, 'docs/plans'), { recursive: true });
    writeFileSync(join(main, PLAN_ARGS[1]), '# body\n');
  }
  return main;
};

const run = (argv, { cwd, deps = {} }) => {
  const out = [];
  const err = [];
  const code = runCli(argv, {
    cwd,
    git: deps.git ?? fixtureGit,
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
    const repo = makeRepo('resume-plan-main', {});
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
  // The manager evidence lives in the CHECKOUT (headFiles): the advice is about an install run
  // in the satellite, so what main's working tree happens to hold must not steer it.
  it('lets packageManager win over a conflicting lockfile', () => {
    const repo = makeRepo('manager-field-main', {
      'package.json': JSON.stringify({ packageManager: 'pnpm@9.15.0' }),
      'yarn.lock': 'fixture\n',
    });
    const { result, worktree } = provisionOk(repo, 'field', ['--install']);
    assert.equal(
      nodeModulesReport(result),
      `  node_modules: install it yourself (zero spawn): cd ${worktree} && pnpm install`,
    );
  });

  it('a dirty MAIN lockfile does not steer: advice follows the clean checkout', () => {
    const repo = makeRepo('dirty-main-lock-main', { 'package-lock.json': 'fixture\n' });
    writeFileSync(join(repo, 'package-lock.json'), 'fixture\n');
    writeFileSync(join(repo, 'yarn.lock'), 'fixture\n');
    const { result, worktree } = provisionOk(repo, 'dirtylock', ['--install']);
    assert.equal(
      nodeModulesReport(result),
      `  node_modules: install it yourself (zero spawn): cd ${worktree} && npm install`,
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
      const repo = makeRepo(`${name}-main`, Object.fromEntries(locks.map((lock) => [lock, 'fixture\n'])));
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
