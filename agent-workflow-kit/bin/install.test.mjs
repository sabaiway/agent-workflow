import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, symlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALLER = join(dirname(fileURLToPath(import.meta.url)), 'install.mjs');
// --no-launchers so the test never wires Codex/Devin on the host.
const runInstaller = (target) =>
  spawnSync(process.execPath, [INSTALLER, '--dir', target, '--no-launchers'], { encoding: 'utf8' });

describe('kit installer — payload + symlink-traversal hardening', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aw-kit-install-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('installs the critical payload (capability.json + tools/ + references/) and not the npm wrapper', () => {
    const target = join(dir, 'agent-workflow-kit');
    const res = runInstaller(target);
    assert.equal(res.status, 0, res.stderr);
    for (const f of ['SKILL.md', 'capability.json', 'tools/manifest/validate.mjs', 'tools/delegation.mjs', 'references']) {
      assert.ok(existsSync(join(target, f)), `missing installed entry: ${f}`);
    }
    assert.equal(existsSync(join(target, 'bin/install.mjs')), false);
  });

  it('refuses to write through a symlinked INTERMEDIATE dest component (no leak)', async () => {
    const target = join(dir, 'target');
    const evil = join(dir, 'evil');
    await mkdir(target, { recursive: true });
    await mkdir(evil, { recursive: true });
    await symlink(evil, join(target, 'references'));
    const res = runInstaller(target);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /symlink/i);
    assert.deepEqual(await readdir(evil), []);
  });

  it('refuses a DANGLING destination symlink', async () => {
    const target = join(dir, 'target');
    await mkdir(target, { recursive: true });
    await symlink(join(dir, 'nowhere'), join(target, 'references'));
    const res = runInstaller(target);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /symlink/i);
    assert.equal(existsSync(join(dir, 'nowhere')), false);
  });

  it('refuses a symlinked TARGET root (no leak)', async () => {
    const real = join(dir, 'real');
    const root = join(dir, 'root');
    await mkdir(real, { recursive: true });
    await symlink(real, root);
    const res = runInstaller(root);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /symlink/i);
    assert.deepEqual(await readdir(real), []);
  });
});
