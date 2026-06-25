import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, symlink, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { engineInstallArgv, installEngine, ENGINE_PACKAGE } from './install.mjs';

const INSTALLER = join(dirname(fileURLToPath(import.meta.url)), 'install.mjs');
const KIT_ROOT = dirname(dirname(INSTALLER));
// --no-launchers so the test never wires Codex/Devin on the host; --no-engine so a full install never
// spawns a real `npx … agent-workflow-engine init` (network + a write to the real engine dir). The
// dedicated engine-step tests cover that path in-process / via a deliberately-broken PATH. `extra`
// appends flags (e.g. --force, --allow-downgrade).
const runInstaller = (target, extra = []) =>
  spawnSync(process.execPath, [INSTALLER, '--dir', target, '--no-launchers', '--no-engine', ...extra], { encoding: 'utf8' });

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

  it('removes retired mirror files an older install left behind (single source of truth on upgrade)', async () => {
    const target = join(dir, 'agent-workflow-kit');
    // Seed a pre-3D install carrying the now-retired bundled mirror files.
    await mkdir(join(target, 'references'), { recursive: true });
    await mkdir(join(target, 'tools'), { recursive: true });
    await writeFile(join(target, 'references', 'planning.md'), 'stale mirror\n');
    await writeFile(join(target, 'tools', 'methodology-slot.md'), 'stale mirror\n');
    const res = runInstaller(target);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(existsSync(join(target, 'references', 'planning.md')), false, 'retired references/planning.md removed');
    assert.equal(existsSync(join(target, 'tools', 'methodology-slot.md')), false, 'retired tools/methodology-slot.md removed');
    assert.ok(existsSync(join(target, 'SKILL.md')), 'the real payload is still installed');
    assert.ok(existsSync(join(target, 'references', 'contracts.md')), 'non-retired references/ content survives');
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

describe('kit installer — runs through the npx bin symlink', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aw-kit-symlink-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('main() runs when invoked through a symlink (the node_modules/.bin shim npx uses)', async () => {
    // npx never runs bin/install.mjs by its real path — it runs node_modules/.bin/agent-workflow-kit,
    // a symlink to it. Node resolves import.meta.url to the REAL file but leaves argv[1] as the symlink,
    // so a string compare of the two makes isDirectRun false and main() silently no-ops. Reproduce that
    // exact invocation: run the installer via a symlink and assert it actually installed (visible output
    // + payload on disk). A regression here means `npx … init` goes quiet again.
    const shim = join(dir, 'agent-workflow-kit'); // stands in for node_modules/.bin/<name>
    await symlink(INSTALLER, shim);
    const target = join(dir, 'home', 'agent-workflow-kit');
    const res = spawnSync(process.execPath, [shim, '--dir', target, '--no-launchers', '--no-engine'], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /installed v|updated the kit/);
    assert.ok(existsSync(join(target, 'SKILL.md')), 'install through the symlink must write the payload');
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

describe('kit installer — mandatory engine install dispatch (Plan 3D, in-process, no network)', () => {
  it('engineInstallArgv: `npx @…/engine@latest init` on POSIX, `npx.cmd` on win32, no shell:true', () => {
    const posix = engineInstallArgv('linux');
    assert.equal(posix.command, 'npx');
    assert.deepEqual(posix.args, [`${ENGINE_PACKAGE}@latest`, 'init']);
    assert.equal(posix.options.shell, undefined, 'must not spawn through a shell');
    assert.equal(engineInstallArgv('darwin').command, 'npx');
    assert.equal(engineInstallArgv('win32').command, 'npx.cmd');
  });

  it('installEngine: first attempt succeeds → ok, runner called once (no retry)', () => {
    let calls = 0;
    const res = installEngine('linux', () => {
      calls += 1;
      return { status: 0 };
    });
    assert.deepEqual(res, { ok: true });
    assert.equal(calls, 1);
  });

  const NO_SLEEP = { sleep: () => {} }; // skip the real backoff so the suite never actually waits

  it('installEngine: fail once then succeed → backoff + retried exactly once, ends ok (D1)', () => {
    let calls = 0;
    let slept = 0;
    const res = installEngine('linux', () => {
      calls += 1;
      return { status: calls === 1 ? 1 : 0 };
    }, { sleep: () => { slept += 1; } });
    assert.deepEqual(res, { ok: true });
    assert.equal(calls, 2);
    assert.equal(slept, 1, 'backoff runs exactly once, before the single retry');
  });

  it('installEngine: fails twice → not ok (D1 hard-failure outcome), no third attempt', () => {
    let calls = 0;
    const res = installEngine('linux', () => {
      calls += 1;
      return { status: 1 };
    }, NO_SLEEP);
    assert.deepEqual(res, { ok: false });
    assert.equal(calls, 2);
  });

  it('installEngine: a spawn error (npx not found) counts as a failure', () => {
    const res = installEngine('linux', () => ({ status: null, error: new Error('spawn npx ENOENT') }), NO_SLEEP);
    assert.deepEqual(res, { ok: false });
  });

  it('installEngine: hands the runner the exact descriptor (command/args/options, no shell)', () => {
    let received;
    installEngine('win32', (d) => {
      received = d;
      return { status: 0 };
    });
    assert.equal(received.command, 'npx.cmd');
    assert.deepEqual(received.args, [`${ENGINE_PACKAGE}@latest`, 'init']);
    assert.equal(received.options.shell, undefined);
  });
});

describe('kit installer — mandatory engine install (subprocess)', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aw-kit-engine-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('--no-engine skips the engine install and prints the live-read STOP note (exit 0)', () => {
    const target = join(dir, 'agent-workflow-kit'); // runInstaller appends --no-engine by default
    const res = runInstaller(target);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /--no-engine: skipped installing the methodology engine/);
    assert.match(res.stdout, /@latest init/);
    assert.match(res.stdout, /installed v|updated the kit/, 'the kit itself still installs');
  });

  it('D1: when `npx` cannot run (both attempts fail) → nonzero exit, recommendations, success block NOT printed first', async () => {
    // Force both engine-install attempts to fail deterministically WITHOUT network: run a real install
    // (no --no-engine) with an empty PATH so `npx` resolves to ENOENT. The kit copy + the version gate
    // do not need PATH; only the engine spawn does. This exercises the D1 loud-error + nonzero exit.
    const target = join(dir, 'agent-workflow-kit');
    const emptyBin = join(dir, 'emptybin');
    await mkdir(emptyBin, { recursive: true });
    const res = spawnSync(process.execPath, [INSTALLER, '--dir', target, '--no-launchers'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: emptyBin },
    });
    assert.notEqual(res.status, 0, 'an engine-install failure must exit nonzero');
    assert.match(res.stderr, /FAILED to install the methodology engine/);
    assert.match(res.stderr, /@latest init/, 'recommends the manual engine install');
    assert.match(res.stderr, /--no-engine/, 'recommends the opt-out');
    assert.doesNotMatch(res.stdout, /Next — open your agent/, 'must NOT claim success before the engine failed');
    assert.ok(existsSync(join(target, 'SKILL.md')), 'the kit itself is still on disk (recovery is one step)');
  });
});

describe('kit installer — published tarball bundles the bridges + the live-read tool', () => {
  it('npm pack ships bridges/<name>/ and tools/engine-source.mjs', () => {
    // The real `files` whitelist decides what publishes — assert against `npm pack`, not the source
    // tree, so a dropped `bridges/` entry in package.json fails here (not silently at install time).
    const res = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: KIT_ROOT, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr || res.error?.message);
    const paths = JSON.parse(res.stdout)[0].files.map((f) => f.path);
    assert.ok(paths.includes('bridges/codex-cli-bridge/SKILL.md'), 'codex bridge SKILL.md not packed');
    assert.ok(paths.includes('bridges/antigravity-cli-bridge/bin/agy.sh'), 'antigravity agy.sh not packed');
    assert.ok(paths.includes('tools/engine-source.mjs'), 'the live-read resolver must ship in the tarball');
    // The retired mirror must NOT ship — the whole point of Plan 3D is one source of truth.
    assert.ok(!paths.includes('tools/methodology-slot.md'), 'retired mirror tools/methodology-slot.md must not be packed');
    assert.ok(!paths.includes('references/planning.md'), 'retired mirror references/planning.md must not be packed');
  });
});
