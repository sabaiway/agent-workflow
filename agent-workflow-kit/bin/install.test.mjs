import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, symlink, readdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  engineInstallArgv,
  installEngine,
  ENGINE_PACKAGE,
  memoryInstallArgv,
  installMemory,
  MEMORY_PACKAGE,
  cascadePlan,
  readMemberVersionSafe,
} from './install.mjs';
import { FAMILY_MEMBERS } from '../tools/family-members.mjs';

const INSTALLER = join(dirname(fileURLToPath(import.meta.url)), 'install.mjs');
const KIT_ROOT = dirname(dirname(INSTALLER));
// --no-launchers so the test never wires Codex/Devin on the host; --no-engine + --no-memory so a full
// install never spawns a real `npx … (engine|memory) init` (network + a write to the real skill dir).
// The dedicated cascade tests cover those paths in-process / via a stubbed `npx` on a sanitized PATH.
// `extra` appends flags (e.g. --force, --allow-downgrade).
const runInstaller = (target, extra = []) =>
  spawnSync(process.execPath, [INSTALLER, '--dir', target, '--no-launchers', '--no-engine', '--no-memory', ...extra], { encoding: 'utf8' });

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
    const res = spawnSync(process.execPath, [shim, '--dir', target, '--no-launchers', '--no-engine', '--no-memory'], { encoding: 'utf8' });
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
    // --no-memory keeps this focused on the engine's FATAL path (the memory-first ordering has its own
    // dedicated test below); without it the empty-PATH memory spawn would add a second 1.5s backoff.
    const res = spawnSync(process.execPath, [INSTALLER, '--dir', target, '--no-launchers', '--no-memory'], {
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

describe('kit installer — memory cascade dispatch (Plan A, in-process, no network)', () => {
  it('memoryInstallArgv: `npx @…/memory@latest init` on POSIX, `npx.cmd` on win32, no shell:true', () => {
    const posix = memoryInstallArgv('linux');
    assert.equal(posix.command, 'npx');
    assert.deepEqual(posix.args, [`${MEMORY_PACKAGE}@latest`, 'init']);
    assert.equal(posix.options.shell, undefined, 'must not spawn through a shell');
    assert.equal(memoryInstallArgv('darwin').command, 'npx');
    assert.equal(memoryInstallArgv('win32').command, 'npx.cmd');
  });

  const NO_SLEEP = { sleep: () => {} };

  it('installMemory: first attempt succeeds → ok, runner called once (no retry)', () => {
    let calls = 0;
    const res = installMemory('linux', () => {
      calls += 1;
      return { status: 0 };
    });
    assert.deepEqual(res, { ok: true });
    assert.equal(calls, 1);
  });

  it('installMemory: fails twice → not ok, retried exactly once (mirrors the engine D1 policy)', () => {
    let calls = 0;
    const res = installMemory('linux', () => {
      calls += 1;
      return { status: 1 };
    }, NO_SLEEP);
    assert.deepEqual(res, { ok: false });
    assert.equal(calls, 2);
  });

  it('installMemory: a spawn error (npx not found) counts as a failure', () => {
    const res = installMemory('linux', () => ({ status: null, error: new Error('spawn npx ENOENT') }), NO_SLEEP);
    assert.deepEqual(res, { ok: false });
  });

  it('cascadePlan: refreshes exactly the npm core members, non-fatal (memory) before fatal (engine), DERIVED from FAMILY_MEMBERS', () => {
    const plan = cascadePlan();
    assert.deepEqual(plan.map((p) => p.name), ['agent-workflow-memory', 'agent-workflow-engine']);
    assert.deepEqual(plan.map((p) => p.npm), [MEMORY_PACKAGE, ENGINE_PACKAGE]);
    assert.deepEqual(plan.map((p) => p.fatal), [false, true], 'non-fatal first, then the fatal engine');
    assert.equal(plan.filter((p) => p.fatal).length, 1, 'exactly one fatal member (the engine)');
    // The cascade membership is the registry's npm core, minus the kit (this runner) + the bridges
    // (placed by setup): a second literal set could drift, so pin the derivation, not a copy.
    const derived = FAMILY_MEMBERS.filter((m) => m.npm && m.kind !== 'execution-backend' && m.name !== 'agent-workflow-kit');
    assert.deepEqual(new Set(plan.map((p) => p.name)), new Set(derived.map((m) => m.name)));
  });

  describe('readMemberVersionSafe — crash-proof on-disk version read for the degraded warning', () => {
    let dir;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'aw-kit-memver-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('an ABSENT skill dir → null (no SKILL.md, nothing to compare)', async () => {
      assert.equal(await readMemberVersionSafe(join(dir, 'nope')), null);
    });

    it('a valid SKILL.md → its metadata.version', async () => {
      const ok = join(dir, 'okmem');
      await mkdir(ok, { recursive: true });
      await writeFile(join(ok, 'SKILL.md'), "---\nname: agent-workflow-memory\nmetadata:\n  version: '1.3.0'\n---\n# mem\n");
      assert.equal(await readMemberVersionSafe(ok), '1.3.0');
    });

    it('an UNREADABLE SKILL.md (a directory → EISDIR) → null, never a throw (warning stays best-effort)', async () => {
      const bad = join(dir, 'badmem');
      await mkdir(join(bad, 'SKILL.md'), { recursive: true });
      assert.equal(await readMemberVersionSafe(bad), null, 'an unreadable SKILL.md must be swallowed, not escalated to fatal');
    });
  });
});

describe('kit installer — memory cascade (subprocess, stubbed npx, no network)', { skip: process.platform === 'win32' }, () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aw-kit-cascade-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // A stub `npx` on PATH that records each invocation's joined args to NPX_LOG and exits per-package:
  // a member whose package name contains "memory"/"engine" exits with MEM_EXIT/ENG_EXIT (default 0).
  // No network, no real install — it only records + returns a status, exercising the cascade's spawn
  // descriptors, order, and per-member (degraded vs fatal) policy.
  const stubNpx = async () => {
    const binDir = join(dir, 'bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, 'npx'),
      ['#!/bin/sh', 'printf "%s\\n" "$*" >> "$NPX_LOG"', 'case "$1" in', '  *memory*) exit "${MEM_EXIT:-0}" ;;', '  *engine*) exit "${ENG_EXIT:-0}" ;;', 'esac', 'exit 0', ''].join('\n'),
    );
    await chmod(join(binDir, 'npx'), 0o755);
    return binDir;
  };
  const runCascade = (binDir, target, { env = {}, extra = [] } = {}) =>
    spawnSync(process.execPath, [INSTALLER, '--dir', target, '--no-launchers', ...extra], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: binDir, // ONLY the stub npx — no real npx, no network
        NPX_LOG: join(dir, 'npx.log'),
        HOME: join(dir, 'home'),
        AGENT_WORKFLOW_MEMORY_DIR: join(dir, 'mem'), // sanitized: the degraded warning never reads real home
        AGENT_WORKFLOW_ENGINE_DIR: join(dir, 'eng'),
        ...env,
      },
    });
  const recordedCalls = async () => (await readFile(join(dir, 'npx.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean);

  it('a normal init refreshes memory THEN engine — @latest, in order, matching the derived cascade plan (clean success)', async () => {
    const binDir = await stubNpx();
    const target = join(dir, 'agent-workflow-kit');
    const res = runCascade(binDir, target); // both exit 0
    assert.equal(res.status, 0, res.stderr);
    const calls = await recordedCalls();
    assert.deepEqual(calls, [`${MEMORY_PACKAGE}@latest init`, `${ENGINE_PACKAGE}@latest init`], 'memory first, then engine, both @latest');
    assert.deepEqual(calls, cascadePlan().map((m) => `${m.npm}@latest init`), 'attempted spawn set === the derived cascade plan');
    assert.match(res.stdout, /memory substrate refreshed/);
    assert.match(res.stdout, /Next — open your agent/, 'a clean cascade ends on the success block');
    assert.doesNotMatch(res.stderr, /could not refresh the memory/, 'no degraded warning on the clean path');
  });

  it('--no-memory skips the memory spawn (skip note, NOT a STOP) while the engine still runs', async () => {
    const binDir = await stubNpx();
    const target = join(dir, 'agent-workflow-kit');
    const res = runCascade(binDir, target, { extra: ['--no-memory'] });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(await recordedCalls(), [`${ENGINE_PACKAGE}@latest init`], 'memory NOT spawned under --no-memory; engine still runs');
    assert.match(res.stdout, /--no-memory: skipped refreshing the memory substrate/);
    assert.doesNotMatch(res.stdout, /STOP/, 'a skipped memory refresh is never the engine-style hard STOP');
  });

  it('DEGRADED success: a memory failure → exit 0 + the success block + a loud warning with the recovery command (absent on-disk branch)', async () => {
    const binDir = await stubNpx();
    const target = join(dir, 'agent-workflow-kit');
    const res = runCascade(binDir, target, { env: { MEM_EXIT: '1' } }); // memory fails twice, engine ok
    assert.equal(res.status, 0, `a degraded memory refresh must stay exit 0: ${res.stderr}`);
    assert.match(res.stderr, /could not refresh the memory substrate/);
    assert.match(res.stderr, /agent-workflow-memory@latest init/, 'the warning names the exact recovery command');
    assert.match(res.stderr, /not found on disk/, 'the sanitized memory dir is absent → the crash-proof read reports it');
    assert.match(res.stdout, /Next — open your agent/, 'degraded is still a success — the success block prints');
    const calls = await recordedCalls();
    assert.equal(calls.filter((c) => c.includes('memory')).length, 2, 'memory was attempted twice (attempt + retry)');
    assert.equal(calls.filter((c) => c.includes('engine')).length, 1, 'the engine still ran after the degraded memory');
  });

  it('DEGRADED success: a memory failure with a PRESENT-but-stale install reports its on-disk version (resolveMemoryTarget env path)', async () => {
    const binDir = await stubNpx();
    const target = join(dir, 'agent-workflow-kit');
    // Pre-write a valid memory SKILL.md into the sanitized AGENT_WORKFLOW_MEMORY_DIR so the crash-proof
    // read finds a version (the common real-world degraded path: stale-but-present memory + npm blip).
    await mkdir(join(dir, 'mem'), { recursive: true });
    await writeFile(join(dir, 'mem', 'SKILL.md'), "---\nname: agent-workflow-memory\nmetadata:\n  version: '1.2.3'\n---\n# mem\n");
    const res = runCascade(binDir, target, { env: { MEM_EXIT: '1' } });
    assert.equal(res.status, 0, `a degraded memory refresh must stay exit 0: ${res.stderr}`);
    assert.match(res.stderr, /could not refresh the memory substrate \(on disk: v1\.2\.3\)/, 'reports the on-disk version from the env-resolved memory dir');
    assert.match(res.stderr, /agent-workflow-memory@latest init/, 'still names the recovery command');
    assert.match(res.stdout, /Next — open your agent/, 'still a success');
  });

  it('engine-hard-fail-still-ran-memory-FIRST: a fatal engine failure exits nonzero, but memory was attempted before it', async () => {
    const binDir = await stubNpx();
    const target = join(dir, 'agent-workflow-kit');
    const res = runCascade(binDir, target, { env: { ENG_EXIT: '1' } }); // memory ok, engine fails twice
    assert.notEqual(res.status, 0, 'a fatal engine failure exits nonzero');
    const calls = await recordedCalls();
    assert.ok(calls[0].includes('memory'), 'memory ran FIRST, before the fatal engine (non-fatal-before-fatal)');
    assert.match(res.stderr, /FAILED to install the methodology engine/);
    assert.doesNotMatch(res.stdout, /Next — open your agent/, 'must NOT claim success after the engine failed');
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
