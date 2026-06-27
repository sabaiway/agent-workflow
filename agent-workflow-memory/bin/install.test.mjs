import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, symlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertContainedRealPath, tildify } from './install.mjs';

const INSTALLER = join(dirname(fileURLToPath(import.meta.url)), 'install.mjs');
const runInstaller = (target) => spawnSync(process.execPath, [INSTALLER, '--dir', target], { encoding: 'utf8' });

describe('memory installer — payload + symlink-traversal hardening', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aw-memory-install-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('installs the full enumerated payload (capability.json, LICENSE, stamp-takeover.mjs) and not the npm wrapper', () => {
    const target = join(dir, 'agent-workflow-memory');
    const res = runInstaller(target);
    assert.equal(res.status, 0, res.stderr);
    for (const f of [
      'SKILL.md',
      'capability.json',
      'LICENSE',
      'README.md',
      'CHANGELOG.md',
      'scripts/stamp-takeover.mjs',
      'references/contracts.md',
      'references/templates/AGENTS.md',
      'references/templates/orchestration.json',
      'migrations/legacy-stamp-takeover.md',
    ]) {
      assert.ok(existsSync(join(target, f)), `missing installed entry: ${f}`);
    }
    assert.equal(existsSync(join(target, 'bin/install.mjs')), false, 'the npm wrapper must not be copied into the skill dir');
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
    assert.deepEqual(await readdir(evil), [], 'nothing should be written through the symlink');
  });

  it('refuses a DANGLING destination symlink (existsSync would have followed it to absent)', async () => {
    const target = join(dir, 'target');
    await mkdir(target, { recursive: true });
    // references -> a path that does not exist (dangling). copyFile through it would create
    // the file at the dangling target, outside `target`.
    await symlink(join(dir, 'nowhere'), join(target, 'references'));
    const res = runInstaller(target);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /symlink/i);
    assert.equal(existsSync(join(dir, 'nowhere')), false, 'dangling target must not be materialised');
  });

  it('refuses a symlinked TARGET root (no leak)', async () => {
    const real = join(dir, 'real');
    const root = join(dir, 'root');
    await mkdir(real, { recursive: true });
    await symlink(real, root);
    const res = runInstaller(root);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /symlink/i);
    assert.deepEqual(await readdir(real), [], 'nothing should be written through the symlinked target');
  });
});

describe('memory installer — Issue-004 regressions (exported helpers, in-process)', () => {
  it('assertContainedRealPath accepts a contained child literally named "..foo"', () => {
    const root = join(tmpdir(), 'aw-mem-contain-root');
    assert.doesNotThrow(() => assertContainedRealPath(root, join(root, '..foo')));
  });

  it('assertContainedRealPath rejects a true `../` escape', () => {
    const root = join(tmpdir(), 'aw-mem-contain-root');
    assert.throws(() => assertContainedRealPath(root, join(root, '..', 'escape')), /outside the target dir/);
  });

  it('tildify collapses only a LEADING homedir, never a mid-path occurrence', () => {
    assert.equal(tildify(`${homedir()}${sep}skills${sep}x`), `~${sep}skills${sep}x`, 'leading home → ~');
    const midPath = `${sep}tmp${homedir()}${sep}x`;
    assert.equal(tildify(midPath), midPath, 'a mid-path home occurrence is left untouched');
  });
});

describe('memory installer — module hygiene', () => {
  it('importing install.mjs runs nothing (main() is guarded by isDirectRun)', () => {
    const url = JSON.stringify(pathToFileURL(INSTALLER).href);
    const res = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `import(${url}).then(() => console.log('IMPORT_OK'));`],
      { encoding: 'utf8' },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /IMPORT_OK/);
    assert.doesNotMatch(res.stdout, /installed v|updated the substrate/);
  });
});
