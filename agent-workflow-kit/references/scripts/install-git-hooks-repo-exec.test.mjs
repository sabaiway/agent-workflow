// install-git-hooks-repo-exec.test.mjs — the SIBLING installer executed IN PLACE (no deploy
// copy): GIT_DIR pins every git answer to a fixture repo, so the run exercises this tree's own
// file — the D3(d) changed-line check reads real executions of the shipped bytes, while the
// deploy-copy suite (install-git-hooks.test.mjs) keeps the consumer-shaped behavior pins. Every
// branch of the installer runs from here: fresh install, the guard arm/carry/disable/conflict
// lanes, the unmanaged refusal, the up-to-date short-circuit, and the not-a-git-checkout skip.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLER = join(HERE, 'install-git-hooks.mjs');

const mkRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'hooks-repo-exec-'));
  spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
  writeFileSync(join(root, 'guard.mjs'), '// a stand-in commit-guard tool\n');
  return { root, gitDir: join(root, '.git') };
};

// The installer anchors its git queries at its OWN parent dir — GIT_DIR overrides that anchor to
// the fixture repo, so running the in-place file NEVER touches this tree's hooks.
const runAt = (gitDir, args = []) =>
  spawnSync('node', [INSTALLER, ...args], { encoding: 'utf8', env: { ...process.env, GIT_DIR: gitDir } });

const hookOf = ({ gitDir }) => readFileSync(join(gitDir, 'hooks', 'pre-commit'), 'utf8');

describe('install-git-hooks — the in-place installer under a GIT_DIR-pinned fixture', () => {
  it('installs the managed hook, is idempotent, and refuses an UNMANAGED hook', () => {
    const fx = mkRepo();
    assert.equal(runAt(fx.gitDir).status, 0);
    assert.match(hookOf(fx), /:install-git-hooks\.mjs/, 'the managed marker is written');
    const again = runAt(fx.gitDir);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /already up to date/);
    writeFileSync(join(fx.gitDir, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    const refused = runAt(fx.gitDir);
    assert.equal(refused.status, 1, 'an unmanaged hook is never overwritten');
    assert.match(refused.stderr, /Refusing to overwrite/);
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('the guard lanes: arm (absolute path) → carry on flagless re-run → consented disable', () => {
    const fx = mkRepo();
    assert.equal(runAt(fx.gitDir, ['--commit-guard', join(fx.root, 'guard.mjs')]).status, 0);
    assert.match(hookOf(fx), /guard\.mjs" --check/);
    assert.equal(runAt(fx.gitDir).status, 0, 'the flagless re-run keeps the armed line');
    assert.match(hookOf(fx), /guard\.mjs" --check/);
    assert.equal(runAt(fx.gitDir, ['--no-commit-guard']).status, 0);
    assert.doesNotMatch(hookOf(fx), /" --check$/m);
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('the guard refusals: both flags (usage), a bare flag (usage), a missing path, a duplicated line', () => {
    const fx = mkRepo();
    assert.equal(runAt(fx.gitDir, ['--commit-guard', join(fx.root, 'guard.mjs'), '--no-commit-guard']).status, 2);
    assert.equal(runAt(fx.gitDir, ['--commit-guard']).status, 2, '--commit-guard without a path is a usage error');
    assert.equal(runAt(fx.gitDir, ['--commit-guard', join(fx.root, 'no-such.mjs')]).status, 1, 'a nonexistent guard path refuses');
    assert.equal(runAt(fx.gitDir, ['--commit-guard', join(fx.root, 'guard.mjs')]).status, 0);
    const armed = hookOf(fx);
    const guardLine = armed.split('\n').find((l) => /" --check$/.test(l));
    writeFileSync(join(fx.gitDir, 'hooks', 'pre-commit'), `${armed}${guardLine}\n`);
    const dup = runAt(fx.gitDir);
    assert.equal(dup.status, 1, 'two guard lines are ambiguous — fail closed');
    assert.match(dup.stderr, /commit-guard --check lines/);
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('outside a git checkout the installer SKIPS loudly and writes nothing', () => {
    const nowhere = mkdtempSync(join(tmpdir(), 'hooks-repo-exec-nogit-'));
    const r = runAt(join(nowhere, 'absent-git-dir'));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /skipping \(not a git checkout\)/);
    assert.equal(existsSync(join(nowhere, 'absent-git-dir')), false, 'nothing was created');
    rmSync(nowhere, { recursive: true, force: true });
  });
});
