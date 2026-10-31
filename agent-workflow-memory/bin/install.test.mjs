import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, symlink, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, chmodSync, lstatSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertContainedRealPath, tildify, shouldAdviseAdrMigration, maybeAdviseAdrMigration } from './install.mjs';
const INSTALLER = join(dirname(fileURLToPath(import.meta.url)), 'install.mjs');
const MEMORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const spawnInstaller = (args, env = process.env) => {
  const result = spawnSync(process.execPath, [INSTALLER, ...args], { encoding: 'utf8', env });
  assert.equal(result.error, undefined);
  assert.equal(typeof result.status, 'number');
  return result;
};
const runInstaller = (target, extra = []) => spawnInstaller(['--dir', target, ...extra]);
const runInstallerWithEnv = (env) => spawnInstaller([], env);
const MEMORY_SKILL = '---\nname: agent-workflow-memory\n---\n';
const PERMISSION_CASE = { skip: process.getuid?.() === 0 };
const PAYLOAD = ['SKILL.md', 'README.md', 'CHANGELOG.md', 'LICENSE', 'capability.json', 'references', 'scripts', 'migrations'];
const state = { dir: null };
beforeEach(async () => { state.dir = await mkdtemp(join(tmpdir(), 'aw-memory-install-')); });
afterEach(async () => { await rm(state.dir, { recursive: true, force: true }); });
const createTarget = (name = 'target') => join(state.dir, name);
const withLockedOrphan = async (target, check) => {
  const locked = join(target, 'references/stale-dir');
  await mkdir(locked, { recursive: true });
  await writeFile(join(locked, 'orphan.md'), 'orphan');
  const mode = lstatSync(locked).mode;
  try {
    chmodSync(locked, 0o555);
    return await check();
  } finally {
    chmodSync(locked, mode);
  }
};
// Rewrite / read the installed substrate's frontmatter metadata.version — used to simulate "a newer
// substrate is already installed" (the stale-cache downgrade scenario). The installer reads this field.
const setInstalledVersion = async (target, v) => {
  const p = join(target, 'SKILL.md');
  const text = await readFile(p, 'utf8');
  await writeFile(p, text.replace(/version:\s*['"]?\d+\.\d+\.\d+['"]?/, `version: '${v}'`));
};
const getInstalledVersion = async (target) =>
  (await readFile(join(target, 'SKILL.md'), 'utf8')).match(/version:\s*['"]?(\d+\.\d+\.\d+)['"]?/)?.[1] ?? null;
const pkgVersion = async () => JSON.parse(await readFile(join(MEMORY_ROOT, 'package.json'), 'utf8')).version;

describe('memory installer — payload + symlink-traversal hardening', () => {
  it('installs the full enumerated payload (capability.json, LICENSE, stamp-takeover.mjs) and not the npm wrapper', () => {
    const target = join(state.dir, 'agent-workflow-memory');
    const res = runInstaller(target);
    assert.equal(res.status, 0, res.stderr);
    for (const f of [
      'SKILL.md', 'capability.json', 'LICENSE', 'README.md', 'CHANGELOG.md',
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
    const target = join(state.dir, 'target');
    const evil = join(state.dir, 'evil');
    await mkdir(target, { recursive: true });
    await mkdir(evil, { recursive: true });
    await writeFile(join(target, 'SKILL.md'), MEMORY_SKILL);
    await symlink(evil, join(target, 'references'));
    const res = runInstaller(target);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /symlink/i);
    assert.ok(!res.stderr.includes('refusing to install into'));
    assert.deepEqual(await readdir(evil), [], 'nothing should be written through the symlink');
  });
  it('refuses a DANGLING destination symlink (existsSync would have followed it to absent)', async () => {
    const target = join(state.dir, 'target');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'SKILL.md'), MEMORY_SKILL);
    // references -> a path that does not exist (dangling). copyFile through it would create
    // the file at the dangling target, outside `target`.
    await symlink(join(state.dir, 'nowhere'), join(target, 'references'));
    const res = runInstaller(target);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /symlink/i);
    assert.ok(!res.stderr.includes('refusing to install into'));
    assert.equal(existsSync(join(state.dir, 'nowhere')), false, 'dangling target must not be materialised');
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
  // The generic ADR-store-migration advisory (AD-051) fires EXACTLY on a major-crossing update into
  // the ADR-store major (2), and never on a fresh install, a same-major update, or a downgrade.
  it('shouldAdviseAdrMigration fires only when crossing UP through the ADR-store major', () => {
    assert.equal(shouldAdviseAdrMigration('1.12.0', '2.0.0'), true, '1.x → 2.0.0 crosses the major (advise)');
    assert.equal(shouldAdviseAdrMigration('1.12.0', '1.13.0'), false, 'a same-major update never advises');
    assert.equal(shouldAdviseAdrMigration('2.0.0', '2.1.0'), false, 'already on the new major — nothing to migrate');
    assert.equal(shouldAdviseAdrMigration('2.1.0', '2.0.0'), false, 'a downgrade never advises');
    assert.equal(shouldAdviseAdrMigration(null, '2.0.0'), false, 'a fresh install (no prior version) never advises');
  });
  it('maybeAdviseAdrMigration names the next upgrade on a major crossing, the refusal, and NEVER a kit or migration command', () => {
    const logs = [];
    maybeAdviseAdrMigration('1.12.0', '2.0.0', (m) => logs.push(m));
    assert.equal(logs.length, 1, 'a major crossing prints exactly one advisory');
    const advisory = logs[0].replace(/\s+/g, ' ');
    for (const phrase of ['retired the 3-tier ADR archive', '/agent-workflow-memory upgrade', 'your workflow toolkit', 'scripts/', 'refusal']) assert.ok(advisory.includes(phrase), `the advisory names: ${phrase}`);
    assert.doesNotMatch(advisory, /migrate-adr-store|agent-workflow-(?!memory\b)|migration command/, 'the memory advisory names no sibling package and no migration command (knows-nobody DAG)');
    logs.length = 0;
    maybeAdviseAdrMigration('2.0.0', '2.1.0', (m) => logs.push(m));
    assert.equal(logs.length, 0, 'a same-major update advises nothing');
  });
});

describe('memory installer — never-downgrade gate + cmp-keyed verbs (AD-034 contract, AD-038 fold)', () => {
  it('a no-op re-run (same version) states already-current + repair-on-rerun — no contradiction, no cache accusation', async () => {
    const target = join(state.dir, 'agent-workflow-memory');
    assert.equal(runInstaller(target).status, 0); // first install
    const again = runInstaller(target); // installed == running
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /refreshed the already-current substrate v/, 'the verb states the no-op, never "updated"');
    assert.match(again.stdout, /was already v/, 'the note fires — no-op detection preserved');
    assert.match(again.stdout, /expected a NEWER version/i, 'the @latest hint is conditional');
    assert.match(again.stdout, /@latest/);
    assert.doesNotMatch(again.stdout, /cache/i, 'no cache accusation — not observable without a network check');
    assert.doesNotMatch(again.stdout, /updated the substrate to/, 'verb and note must not contradict each other');
  });
  it('--allow-downgrade overrides the refusal and overwrites with the runner version', async () => {
    const target = join(state.dir, 'agent-workflow-memory');
    assert.equal(runInstaller(target).status, 0);
    await setInstalledVersion(target, '99.0.0');
    const res = runInstaller(target, ['--allow-downgrade']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(await getInstalledVersion(target), await pkgVersion());
    assert.match(res.stdout, /downgraded the substrate to v/, 'the verb states the downgrade plainly, never "updated"');
  });
  it('a legacy install with no version stamp still upgrades (no false downgrade, no crash)', async () => {
    const target = join(state.dir, 'agent-workflow-memory');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'SKILL.md'), '---\nname: agent-workflow-memory\n---\n# legacy stub\n');
    const res = runInstaller(target);
    assert.equal(res.status, 0, res.stderr);
    // cmp is null (no stamp → the prior version is unknowable), so the verb claims no transition.
    assert.match(res.stdout, /installed v/);
    assert.doesNotMatch(res.stdout, /updated the substrate to/, 'no update claim from an unknowable prior version');
  });
  it('reads the version under `metadata:`, never a top-level / nested decoy `version:`', async () => {
    // metadataVersion must read the DIRECT child of metadata: (0.0.1 → a normal upgrade), not a decoy
    // 99.0.0 top-level or 98.0.0 nested line (which a naive "first version:" read would wrongly refuse).
    const target = join(state.dir, 'agent-workflow-memory');
    await mkdir(target, { recursive: true });
    const decoy = [
      '---',
      "version: '99.0.0'", // top-level decoy (column 0)
      'name: agent-workflow-memory',
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
    assert.match(res.stdout, /updated the substrate to/);
  });
});

describe('spec:upgrade-delivery/S22 memory home admission and guard order', () => {
  it('refuses a foreign folder on every run without writing a byte', async () => {
    const target = createTarget();
    await mkdir(target);
    await writeFile(join(target, 'notes.md'), 'private notes');
    for (const run of [1, 2]) {
      const result = runInstaller(target);
      assert.equal(result.status, 1, `run ${run}: ${result.stderr}`);
      assert.ok(result.stderr.includes(`refusing to install into ${target}`));
      assert.ok(result.stderr.includes('agent-workflow-memory SKILL.md'));
      assert.equal(await readFile(join(target, 'notes.md'), 'utf8'), 'private notes');
      assert.equal(existsSync(join(target, 'SKILL.md')), false);
      assert.deepEqual(await readdir(target), ['notes.md']);
    }
  });
  it('refuses a symlinked TARGET root (no leak)', async () => {
    const root = createTarget();
    const real = root + '-real';
    await mkdir(real, { recursive: true });
    await symlink(real, root);
    const res = runInstaller(root);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /symlink/i);
    assert.ok(!res.stderr.includes('refusing to install into'));
    assert.deepEqual(await readdir(real), [], 'nothing should be written through the symlinked target');
  });
  it('refuses to downgrade when the installed substrate is NEWER, and writes nothing', async () => {
    const target = createTarget();
    assert.equal(runInstaller(target).status, 0);
    await setInstalledVersion(target, '99.0.0'); // pretend a newer substrate is already installed
    const res = runInstaller(target);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /refusing to downgrade/);
    assert.ok(!res.stderr.includes('refusing to install into'));
    assert.match(res.stderr, /@latest/);
    assert.equal(await getInstalledVersion(target), '99.0.0', 'newer install must be left untouched');
  });
  it('fails closed (does not silently treat as legacy) when an existing SKILL.md cannot be read', async () => {
    const target = createTarget();
    await mkdir(join(target, 'SKILL.md'), { recursive: true }); // a directory → EISDIR on read
    const res = runInstaller(target);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /cannot read the installed SKILL\.md/i);
    assert.ok(!res.stderr.includes('refusing to install into'));
  });
  it('admits and converges a partial memory home', async () => {
    const target = createTarget();
    await mkdir(join(target, 'references'), { recursive: true });
    await writeFile(join(target, 'SKILL.md'), MEMORY_SKILL);
    await writeFile(join(target, 'references/old.md'), 'old');
    const result = runInstaller(target);
    assert.equal(result.status, 0, result.stderr);
    for (const entry of PAYLOAD) assert.ok(existsSync(join(target, entry)), entry);
    assert.equal(existsSync(join(target, 'references/old.md')), false);
    assert.ok(result.stdout.split('\n').includes('[agent-workflow-memory] removed references/old.md (not in the package)'));
  });
  it('awaits the SKILL.md copy on its own before the other payload copies', async () => {
    const source = await readFile(INSTALLER, 'utf8');
    const first = source.indexOf('copyRecursive(resolve(PKG_ROOT,');
    assert.ok(first >= 0);
    const statement = source.slice(source.lastIndexOf('\n', first), source.indexOf(';', first) + 1);
    assert.match(statement, /^\s*await\s+copyRecursive\(\s*resolve\(PKG_ROOT,\s*'SKILL\.md'\)[^;]*\);\s*$/);
  });
});

describe('spec:upgrade-delivery/S23 memory payload convergence', () => {
  it('removes stale payload files and emptied trees once and leaves top-level notes', async () => {
    const target = createTarget();
    const fresh = runInstaller(target);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.doesNotMatch(fresh.stdout, /\bremoved\b/);
    const paths = ['references/scripts/archive-decisions.mjs', 'scripts/my-tool.sh', 'migrations/0.9.0-retired.md', 'references/stale-dir/deeper/x.md', 'notes.txt'];
    for (const path of paths) {
      await mkdir(dirname(join(target, path)), { recursive: true });
      await writeFile(join(target, path), path);
    }
    const result = runInstaller(target);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split('\n');
    for (const path of [...paths.slice(0, 4), 'references/stale-dir']) {
      assert.equal(existsSync(join(target, path)), false, path);
      assert.equal(lines.filter((line) => line === `[agent-workflow-memory] removed ${path} (not in the package)`).length, 1, path);
    }
    assert.ok(!lines.some((line) => /^\[agent-workflow-memory\] (removed|kept|failed) references\/stale-dir\/deeper[ :]/.test(line)));
    assert.equal(await readFile(join(target, 'notes.txt'), 'utf8'), 'notes.txt');
    assert.ok(!lines.some((line) => line.includes('notes.txt')));
    const again = runInstaller(target);
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /\bremoved\b/);
  });
  it('--help states removal and the admitted home kinds', () => {
    const result = spawnInstaller(['--help']);
    assert.equal(result.status, 0, result.stderr);
    const help = result.stdout.replace(/\s+/g, ' ');
    for (const phrase of ['removes what the package no longer carries', 'new or empty folder', 'existing memory home']) assert.ok(help.includes(phrase), phrase);
    assert.doesNotMatch(help, /\badditive\b/);
  });
});

describe('spec:upgrade-delivery/S24 memory prune failure reporting', () => {
  for (const crossing of [false, true]) {
    it(`fails before next steps and preserves the ${crossing ? 'major-crossing advisory' : 'same-version note'}`, PERMISSION_CASE, async () => {
      const target = createTarget();
      assert.equal(runInstaller(target).status, 0);
      if (crossing) await setInstalledVersion(target, '1.0.0');
      await withLockedOrphan(target, () => {
        const result = runInstaller(target);
        assert.equal(result.status, 1, result.stderr);
        const lines = result.stdout.split('\n');
        const failed = lines.findIndex((line) => line.startsWith('[agent-workflow-memory] failed references/stale-dir/orphan.md: '));
        const nonConvergence = lines.findIndex((line) => line.includes('the memory home did not converge'));
        const note = lines.findIndex((line) => line.includes(crossing ? 'retired the 3-tier ADR archive' : 'was already v'));
        assert.ok(failed >= 0 && nonConvergence > failed && note > nonConvergence, result.stdout);
        assert.doesNotMatch(result.stdout, /^\[agent-workflow-memory\] (installed|updated the substrate to|refreshed the already-current substrate|downgraded the substrate to)/m);
        assert.ok(!result.stdout.includes('Next — open your agent'));
      });
    });
  }
  for (const route of ['--dir', 'env']) {
    it(`quotes the resolved home from ${route} in its recovery command`, PERMISSION_CASE, async () => {
      const target = createTarget("memory home's");
      assert.equal(runInstaller(target).status, 0);
      await withLockedOrphan(target, () => {
        const env = { ...process.env, AGENT_WORKFLOW_MEMORY_DIR: target };
        const result = route === '--dir' ? runInstaller(target) : runInstallerWithEnv(env);
        assert.equal(result.status, 1, result.stderr);
        const line = result.stdout.split('\n').find((entry) => entry.includes('did not converge'));
        assert.equal(typeof line, 'string', result.stdout);
        const command = line.split(' re-run ')[1];
        assert.equal(typeof command, 'string', line);
        const stub = spawnSync('bash', ['-c', `npx() { printf '%s\\n' "$@"; }; ${command}`], { encoding: 'utf8' });
        assert.equal(stub.error, undefined);
        assert.equal(typeof stub.status, 'number');
        assert.equal(stub.status, 0, stub.stderr);
        assert.deepEqual(stub.stdout.trimEnd().split('\n'), ['@sabaiway/agent-workflow-memory@latest', 'init', '--dir', resolve(target)]);
      });
    });
  }
});

describe('memory installer — module hygiene', () => {
  it('importing install.mjs runs nothing (main() is guarded by isDirectRun)', () => {
    const url = JSON.stringify(pathToFileURL(INSTALLER).href);
    const res = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `import(${url}).then(() => console.log('IMPORT_OK'));`],
      { encoding: 'utf8' },
    );
    assert.equal(res.error, undefined);
    assert.equal(typeof res.status, 'number');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /IMPORT_OK/);
    assert.doesNotMatch(res.stdout, /installed v|updated the substrate|refreshed the already-current substrate|downgraded the substrate/);
  });
});
