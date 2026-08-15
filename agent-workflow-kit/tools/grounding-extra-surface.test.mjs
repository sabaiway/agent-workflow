// grounding-extra-surface.test.mjs — the --extra unmappable-repo fail-closed arm. Lives in its
// OWN file: the round-1 red-proof records bind grounding.test.mjs bytes (custody), and this arm
// is only constructible with a PATH-front git stub, minted after those proofs froze.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from './grounding.mjs';

describe('grounding --extra — a mappable toplevel with an unmappable git dir refuses @file reads (fail closed)', () => {
  it('rev-parse --absolute-git-dir failing inside a real repo is a loud STOP, nothing emitted', () => {
    const root = mkdtempSync(join(tmpdir(), 'grounding-gitdir-arm-'));
    writeFileSync(join(root, 'AGENTS.md'), '# P\n\n## 🚫 Hard Constraints\n\nx\n');
    const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
    assert.equal(g('init', '-q').status, 0);
    const extra = join(root, 'facts.md');
    writeFileSync(extra, 'live fact\n');
    // A PATH-front git stub: passthrough for every query except the git-dir ones — the only
    // constructible route to a repo whose toplevel resolves while its git dir does not.
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    assert.ok(realGit, 'a real git must be resolvable for the stub passthrough');
    const stubDir = mkdtempSync(join(tmpdir(), 'grounding-git-stub-'));
    writeFileSync(
      join(stubDir, 'git'),
      `#!/usr/bin/env bash\nfor a in "$@"; do [[ "$a" == "--absolute-git-dir" ]] && exit 1; done\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );
    const savedPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${savedPath}`;
    let r;
    try {
      r = main(['--constraints', '--extra', `@${extra}`], { cwd: root, env: {} });
    } finally {
      process.env.PATH = savedPath;
      rmSync(stubDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--extra cannot resolve the git dir \(git rev-parse --absolute-git-dir failed\)/);
    assert.equal(r.stdout, '', 'nothing is emitted on the fail-closed arm');
  });
});

describe('grounding --extra — round-2 council folds (ambient GIT_* scrub, leaf no-follow, worktree gitfile)', () => {
  it('ambient GIT_DIR pointing at a FOREIGN repo cannot mis-anchor the git-dir carve-out (R2-1)', () => {
    const repoA = mkdtempSync(join(tmpdir(), 'grounding-gitenv-a-'));
    const repoB = mkdtempSync(join(tmpdir(), 'grounding-gitenv-b-'));
    const g = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
    assert.equal(g(repoA, 'init', '-q').status, 0);
    assert.equal(g(repoB, 'init', '-q').status, 0);
    writeFileSync(join(repoA, '.git', 'sneak.md'), 'repo A internals\n');
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(repoB, '.git');
    let r;
    try {
      r = main(['--extra', `@${join(repoA, '.git', 'sneak.md')}`], { cwd: repoA, env: {} });
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
    }
    assert.equal(r.code, 1);
    assert.match(r.stderr, /inside the git dir/);
    assert.doesNotMatch(r.stdout, /repo A internals/, 'the ambient override never routes internals into the payload');
  });

  it('a symlink LEAF refuses even when its target is an admitted regular file (R2-2)', () => {
    const root = mkdtempSync(join(tmpdir(), 'grounding-symleaf-'));
    writeFileSync(join(root, 'target.md'), 'sym target\n');
    symlinkSync(join(root, 'target.md'), join(root, 'link.md'));
    const r = main(['--extra', `@${join(root, 'link.md')}`], { cwd: root, env: {} });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not a regular file \(symlink\)/);
    assert.doesNotMatch(r.stdout, /sym target/);
  });

  it('a linked worktree .git GITFILE refuses — repository metadata never enters the payload (R2-3)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'grounding-wtrepo-'));
    const g = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
    assert.equal(g(repo, 'init', '-q').status, 0);
    g(repo, 'config', 'user.email', 'p@e');
    g(repo, 'config', 'user.name', 'p');
    writeFileSync(join(repo, 'f.txt'), 'x\n');
    g(repo, 'add', '-A');
    assert.equal(g(repo, 'commit', '-qm', 'base').status, 0);
    const wtHome = mkdtempSync(join(tmpdir(), 'grounding-wt-'));
    const wt = join(wtHome, 'wt');
    const added = g(repo, 'worktree', 'add', '-q', wt);
    assert.equal(added.status, 0, added.stderr);
    const r = main(['--extra', `@${join(wt, '.git')}`], { cwd: wt, env: {} });
    rmSync(wtHome, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /inside the git dir/);
    assert.doesNotMatch(r.stdout, /gitdir:/, 'the gitfile bytes never reach the payload');
  });
});
