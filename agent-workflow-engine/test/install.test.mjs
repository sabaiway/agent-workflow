import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, symlink, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertContainedRealPath, tildify } from '../bin/install.mjs';

const INSTALLER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'install.mjs');
const ENGINE_ROOT = dirname(dirname(INSTALLER));
// `extra` appends flags (e.g. --allow-downgrade) for the never-downgrade gate tests.
const runInstaller = (target, extra = []) =>
  spawnSync(process.execPath, [INSTALLER, '--dir', target, ...extra], { encoding: 'utf8' });

// Rewrite / read the installed canon's frontmatter metadata.version — used to simulate "a newer canon
// is already installed" (the stale-cache downgrade scenario). The installer reads exactly this field.
const setInstalledVersion = async (target, v) => {
  const p = join(target, 'SKILL.md');
  const text = await readFile(p, 'utf8');
  await writeFile(p, text.replace(/version:\s*['"]?\d+\.\d+\.\d+['"]?/, `version: '${v}'`));
};
const getInstalledVersion = async (target) =>
  (await readFile(join(target, 'SKILL.md'), 'utf8')).match(/version:\s*['"]?(\d+\.\d+\.\d+)['"]?/)?.[1] ?? null;
const pkgVersion = async () => JSON.parse(await readFile(join(ENGINE_ROOT, 'package.json'), 'utf8')).version;

describe('engine installer — payload + symlink-traversal hardening', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aw-engine-install-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('installs the full enumerated payload (capability.json, LICENSE, methodology canon) and not the npm wrapper', () => {
    const target = join(dir, 'agent-workflow-engine');
    const res = runInstaller(target);
    assert.equal(res.status, 0, res.stderr);
    for (const f of [
      'SKILL.md',
      'capability.json',
      'LICENSE',
      'README.md',
      'CHANGELOG.md',
      'references/planning.md',
      'references/methodology-slot.md',
      'references/orchestration.md',
      'references/orchestration-slot.md',
      'references/autonomy-slot.md',
      'references/procedures.md',
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

describe('engine installer — never-downgrade gate (D3 / AD-012, no network)', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aw-engine-stale-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a no-op re-run (same version) states already-current + repair-on-rerun — no contradiction, no cache accusation', async () => {
    const target = join(dir, 'agent-workflow-engine');
    assert.equal(runInstaller(target).status, 0); // first install
    const again = runInstaller(target); // installed == running
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /refreshed the already-current canon v/, 'the verb states the no-op, never "updated"');
    assert.match(again.stdout, /was already v/, 'the note fires — no-op detection preserved');
    assert.match(again.stdout, /expected a NEWER version/i, 'the @latest hint is conditional');
    assert.match(again.stdout, /@latest/);
    assert.doesNotMatch(again.stdout, /cache/i, 'no cache accusation — not observable without a network check');
    assert.doesNotMatch(again.stdout, /updated the canon to/, 'verb and note must not contradict each other');
  });

  it('refuses to downgrade when the installed canon is NEWER, and writes nothing', async () => {
    const target = join(dir, 'agent-workflow-engine');
    assert.equal(runInstaller(target).status, 0);
    await setInstalledVersion(target, '99.0.0'); // pretend a newer canon is already installed
    const res = runInstaller(target);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /downgrade/i);
    assert.match(res.stderr, /@latest/);
    assert.equal(await getInstalledVersion(target), '99.0.0', 'newer install must be left untouched');
  });

  it('--allow-downgrade overrides the refusal and overwrites with the runner version', async () => {
    const target = join(dir, 'agent-workflow-engine');
    assert.equal(runInstaller(target).status, 0);
    await setInstalledVersion(target, '99.0.0');
    const res = runInstaller(target, ['--allow-downgrade']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(await getInstalledVersion(target), await pkgVersion());
    assert.match(res.stdout, /downgraded the canon to v/, 'the verb states the downgrade plainly, never "updated"');
  });

  it('fails closed (does not silently treat as legacy) when an existing SKILL.md cannot be read', async () => {
    const target = join(dir, 'agent-workflow-engine');
    await mkdir(join(target, 'SKILL.md'), { recursive: true }); // a directory → EISDIR on read
    const res = runInstaller(target);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /cannot read the installed SKILL\.md/i);
  });

  it('a legacy install with no version stamp still upgrades (no false downgrade, no crash)', async () => {
    const target = join(dir, 'agent-workflow-engine');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'SKILL.md'), '---\nname: agent-workflow-engine\n---\n# legacy stub\n');
    const res = runInstaller(target);
    assert.equal(res.status, 0, res.stderr);
    // cmp is null (no stamp → the prior version is unknowable), so the verb claims no transition.
    assert.match(res.stdout, /installed v/);
    assert.doesNotMatch(res.stdout, /updated the canon to/, 'no update claim from an unknowable prior version');
  });

  it('reads the version under `metadata:`, never a top-level / nested decoy `version:`', async () => {
    // metadataVersion must read the DIRECT child of metadata: (0.0.1 → a normal upgrade), not a decoy
    // 99.0.0 top-level or 98.0.0 nested line (which a naive "first version:" read would wrongly refuse).
    const target = join(dir, 'agent-workflow-engine');
    await mkdir(target, { recursive: true });
    const decoy = [
      '---',
      "version: '99.0.0'", // top-level decoy (column 0)
      'name: agent-workflow-engine',
      'metadata:',
      '  nested:',
      "    version: '98.0.0'", // deeper-nested decoy
      "  version: '0.0.1'", // the authoritative direct child
      '---',
      '# decoy',
      '',
    ].join('\n');
    await writeFile(join(target, 'SKILL.md'), decoy);
    const res = runInstaller(target);
    assert.equal(res.status, 0, `expected a normal upgrade (read 0.0.1), got: ${res.stderr}`);
    assert.match(res.stdout, /updated the canon to/);
  });
});

describe('engine installer — Issue-004 regressions (exported helpers, in-process)', () => {
  it('assertContainedRealPath accepts a contained child literally named "..foo"', () => {
    const root = join(tmpdir(), 'aw-contain-root');
    // rel is "..foo" — a real child, NOT a "../" escape. Must not throw.
    assert.doesNotThrow(() => assertContainedRealPath(root, join(root, '..foo')));
  });

  it('assertContainedRealPath rejects a true `../` escape', () => {
    const root = join(tmpdir(), 'aw-contain-root');
    assert.throws(() => assertContainedRealPath(root, join(root, '..', 'escape')), /outside the target dir/);
  });

  it('tildify collapses only a LEADING homedir, never a mid-path occurrence', () => {
    assert.equal(tildify(`${homedir()}${sep}skills${sep}x`), `~${sep}skills${sep}x`, 'leading home → ~');
    const midPath = `${sep}tmp${homedir()}${sep}x`; // homedir appears mid-path
    assert.equal(tildify(midPath), midPath, 'a mid-path home occurrence is left untouched');
  });
});

describe('engine installer — module hygiene', () => {
  it('importing install.mjs runs nothing (main() is guarded by isDirectRun)', () => {
    const url = JSON.stringify(pathToFileURL(INSTALLER).href);
    const res = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `import(${url}).then(() => console.log('IMPORT_OK'));`],
      { encoding: 'utf8' },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /IMPORT_OK/);
    assert.doesNotMatch(res.stdout, /installed v|updated the canon/);
  });
});
