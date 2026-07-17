// install-git-hooks.test.mjs — spec for the pre-commit installer (strip-the-kit round-1 folds):
// the hooks path comes from git plumbing (a linked worktree resolves ITS OWN hooks path, never a
// hardcoded `.git/hooks`), and an armed commit-guard line SURVIVES a flagless re-run (exactly one
// strictly-parsed canonical guard line carries forward; --no-commit-guard is the only consented
// disable; both flags together are a usage error; a duplicated guard line fails closed).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLER_SRC = join(HERE, 'install-git-hooks.mjs');

// The installer anchors ROOT at <its dir>/.. — deploy it into a fixture's scripts/ like a consumer.
const mkProject = () => {
  const root = mkdtempSync(join(tmpdir(), 'install-hooks-'));
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'p@e');
  g('config', 'user.name', 'p');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(INSTALLER_SRC, join(root, 'scripts', 'install-git-hooks.mjs'));
  writeFileSync(join(root, 'guard.mjs'), '// a stand-in commit-guard tool\n');
  writeFileSync(join(root, 'base.txt'), 'base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  return { root, g };
};

const runInstaller = (root, args = []) =>
  spawnSync('node', [join(root, 'scripts', 'install-git-hooks.mjs'), ...args], { cwd: root, encoding: 'utf8' });

const hooksPathOf = (root) => {
  const r = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, encoding: 'utf8' });
  return resolve(root, r.stdout.trim());
};

describe('install-git-hooks — the hooks path comes from git plumbing (C7)', () => {
  it('a normal repo installs at the git-path hooks location', () => {
    const { root } = mkProject();
    const r = runInstaller(root);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(hooksPathOf(root), 'pre-commit')), 'the hook lands where git says hooks live');
    rmSync(root, { recursive: true, force: true });
  });

  it('a LINKED WORKTREE installs at ITS OWN git-path hooks (never a hardcoded <worktree>/.git/hooks)', () => {
    const { root, g } = mkProject();
    const wt = join(root, '..', `wt-${Date.now() % 1e6}`);
    g('worktree', 'add', '-q', wt);
    mkdirSync(join(wt, 'scripts'), { recursive: true });
    cpSync(INSTALLER_SRC, join(wt, 'scripts', 'install-git-hooks.mjs'));
    const r = runInstaller(wt);
    assert.equal(r.status, 0, r.stderr);
    const expected = join(hooksPathOf(wt), 'pre-commit');
    assert.ok(existsSync(expected), `the worktree hook lands at git's own answer (${expected})`);
    assert.ok(!existsSync(join(wt, '.git', 'hooks', 'pre-commit')), 'never a literal <worktree>/.git/hooks (a worktree .git is a FILE)');
    rmSync(wt, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
});

describe('install-git-hooks — the commit-guard arm persists (C8)', () => {
  it('an armed guard SURVIVES a later flagless re-run (carried forward from the managed hook)', () => {
    const { root } = mkProject();
    assert.equal(runInstaller(root, ['--commit-guard', 'guard.mjs']).status, 0);
    const armed = readFileSync(join(hooksPathOf(root), 'pre-commit'), 'utf8');
    assert.match(armed, /guard\.mjs" --check/, 'the guard line is written armed');
    assert.equal(runInstaller(root).status, 0, 'the flagless canonical re-run succeeds');
    const after = readFileSync(join(hooksPathOf(root), 'pre-commit'), 'utf8');
    assert.match(after, /guard\.mjs" --check/, 'the armed guard line survives a flagless re-run');
    rmSync(root, { recursive: true, force: true });
  });

  it('--no-commit-guard is the ONLY consented disable; combining both flags is a usage error', () => {
    const { root } = mkProject();
    assert.equal(runInstaller(root, ['--commit-guard', 'guard.mjs']).status, 0);
    assert.equal(runInstaller(root, ['--no-commit-guard']).status, 0);
    const after = readFileSync(join(hooksPathOf(root), 'pre-commit'), 'utf8');
    assert.doesNotMatch(after, /" --check$/m, 'the guard line is removed on the explicit disable');
    const both = runInstaller(root, ['--commit-guard', 'guard.mjs', '--no-commit-guard']);
    assert.equal(both.status, 2, 'both flags together are a usage error, never an order-dependent pick');
    rmSync(root, { recursive: true, force: true });
  });

  it('a DUPLICATED/malformed guard line in the managed hook fails CLOSED on a flagless re-run', () => {
    const { root } = mkProject();
    assert.equal(runInstaller(root, ['--commit-guard', 'guard.mjs']).status, 0);
    const hookPath = join(hooksPathOf(root), 'pre-commit');
    const armed = readFileSync(hookPath, 'utf8');
    const guardLine = armed.split('\n').find((l) => /" --check$/.test(l));
    writeFileSync(hookPath, `${armed}${guardLine}\n`); // duplicate the guard line
    const r = runInstaller(root);
    assert.equal(r.status, 1, 'two guard lines are ambiguous — fail closed, never guess');
    assert.match(r.stderr, /guard/i);
    rmSync(root, { recursive: true, force: true });
  });
});
