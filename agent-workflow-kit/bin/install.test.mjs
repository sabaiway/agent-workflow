import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, symlink, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const INSTALLER = join(dirname(fileURLToPath(import.meta.url)), 'install.mjs');
const KIT_ROOT = dirname(dirname(INSTALLER));
// --no-launchers so the test never wires Codex/Devin on the host. `extra` appends flags (e.g. --force).
const runInstaller = (target, extra = []) =>
  spawnSync(process.execPath, [INSTALLER, '--dir', target, '--no-launchers', ...extra], { encoding: 'utf8' });

// Rewrite / read the installed skill's frontmatter version — used to simulate "a newer kit is already
// installed" (the stale-cache downgrade scenario). The installer reads exactly this field.
const setInstalledVersion = async (target, v) => {
  const p = join(target, 'SKILL.md');
  const text = await readFile(p, 'utf8');
  await writeFile(p, text.replace(/version:\s*['"]?\d+\.\d+\.\d+['"]?/, `version: '${v}'`));
};
const getInstalledVersion = async (target) =>
  (await readFile(join(target, 'SKILL.md'), 'utf8')).match(/version:\s*['"]?(\d+\.\d+\.\d+)['"]?/)?.[1] ?? null;
const pkgVersion = async () =>
  JSON.parse(await readFile(join(KIT_ROOT, 'package.json'), 'utf8')).version;

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

describe('kit installer — module hygiene', () => {
  it('importing install.mjs runs nothing (main() is guarded by isDirectRun)', () => {
    // `node -e` has no argv[1], so isDirectRun is false → importing must not run main()
    // (no FS writes, no exit). A child process keeps the assertion off the test runner's own state.
    const url = JSON.stringify(pathToFileURL(INSTALLER).href);
    const res = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `import(${url}).then(() => console.log('IMPORT_OK'));`],
      { encoding: 'utf8' },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /IMPORT_OK/);
    assert.doesNotMatch(res.stdout, /installed v|updated the kit/);
  });
});

describe('kit installer — stale-cache defenses (no network)', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aw-kit-stale-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a no-op re-run (same version) flags the likely npx cache and points at @latest', async () => {
    const target = join(dir, 'agent-workflow-kit');
    assert.equal(runInstaller(target).status, 0); // first install
    const again = runInstaller(target); // second run: installed == running
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /no version change/i);
    assert.match(again.stdout, /cache/i);
    assert.match(again.stdout, /@latest/);
  });

  it('refuses to downgrade when the installed kit is NEWER, and writes nothing', async () => {
    const target = join(dir, 'agent-workflow-kit');
    assert.equal(runInstaller(target).status, 0);
    await setInstalledVersion(target, '99.0.0'); // pretend a newer kit is already installed
    const res = runInstaller(target); // running version < installed → downgrade
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /downgrade/i);
    assert.match(res.stderr, /@latest/);
    assert.equal(await getInstalledVersion(target), '99.0.0', 'newer install must be left untouched');
  });

  it('--allow-downgrade overrides the refusal and overwrites with the runner version', async () => {
    const target = join(dir, 'agent-workflow-kit');
    assert.equal(runInstaller(target).status, 0);
    await setInstalledVersion(target, '99.0.0');
    const res = runInstaller(target, ['--allow-downgrade']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(await getInstalledVersion(target), await pkgVersion());
  });

  it('--force alone does NOT override the downgrade gate (the override is its own flag)', async () => {
    const target = join(dir, 'agent-workflow-kit');
    assert.equal(runInstaller(target).status, 0);
    await setInstalledVersion(target, '99.0.0');
    const res = runInstaller(target, ['--force']); // launcher-clobber flag, not the gate override
    assert.notEqual(res.status, 0, 'launcher --force must not silently clear the version gate');
    assert.equal(await getInstalledVersion(target), '99.0.0', 'newer install must be left untouched');
  });

  it('reads the version under `metadata:`, never a top-level / nested decoy `version:`', async () => {
    // A crafted SKILL.md whose REAL metadata.version (0.0.1) is OLDER than the runner, but with decoy
    // `version:` lines that are NEWER. A naive "first version: in frontmatter" read would see 99.0.0
    // and wrongly refuse; the correct read sees 0.0.1 → a normal upgrade (exit 0).
    const target = join(dir, 'agent-workflow-kit');
    await mkdir(target, { recursive: true });
    const decoy = [
      '---',
      "version: '99.0.0'", // top-level decoy (column 0)
      'name: agent-workflow-kit',
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
    assert.match(res.stdout, /updated the kit to/);
  });

  it('fails closed (does not silently treat as legacy) when an existing SKILL.md cannot be read', async () => {
    // SKILL.md present but unreadable (a directory → EISDIR on read). The gate must NOT be bypassed:
    // we refuse rather than overwrite a kit whose version we could not determine (no silent failure).
    const target = join(dir, 'agent-workflow-kit');
    await mkdir(join(target, 'SKILL.md'), { recursive: true });
    const res = runInstaller(target);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /cannot read the installed SKILL\.md/i);
  });

  it('a legacy install with no version stamp still upgrades (no false downgrade, no crash)', async () => {
    const target = join(dir, 'agent-workflow-kit');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'SKILL.md'), '---\nname: agent-workflow-kit\n---\n# legacy stub\n');
    const res = runInstaller(target);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /updated the kit to/);
  });
});

describe('kit installer — published tarball bundles the bridges', () => {
  it('npm pack ships bridges/<name>/ (the execution-backend skill mirrors)', () => {
    // The real `files` whitelist decides what publishes — assert against `npm pack`, not the source
    // tree, so a dropped `bridges/` entry in package.json fails here (not silently at install time).
    const res = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: KIT_ROOT, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr || res.error?.message);
    const paths = JSON.parse(res.stdout)[0].files.map((f) => f.path);
    assert.ok(paths.includes('bridges/codex-cli-bridge/SKILL.md'), 'codex bridge SKILL.md not packed');
    assert.ok(paths.includes('bridges/antigravity-cli-bridge/bin/agy.sh'), 'antigravity agy.sh not packed');
  });
});
