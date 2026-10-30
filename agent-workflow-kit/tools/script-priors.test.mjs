import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hermeticGitEnv } from './git-env.mjs';
import { DEPLOYED_SCRIPTS } from './node-evidence.mjs';
import { KIT_LIMITS } from './source-size/index.mjs';

const scriptPriors = await import('./script-priors.mjs').catch(() => ({}));
const { SCRIPT_PRIORS, PRIOR_FILES, READER_PAIR, CHECKER_PAIR, INSTALLER_SET, classifyDeployedScript, digestOf } = scriptPriors;
const { ensureScripts } = await import('./distribution-files/index.mjs').catch(() => ({}));

const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(KIT_ROOT, 'test', 'fixtures', 'script-priors');
const BUNDLE = join(KIT_ROOT, 'references', 'scripts');
const FROZEN_PRIORS = [
  ['check-docs-size.mjs', '4.0.0', '4.3.0', '84fb3673b034d4b2ba5bedf4a3e47899f98da3971c17902d1f2a548d07dc53bf'],
  ['check-docs-size.mjs', '4.4.0', '4.5.0', '7a5cd7f98571c3248d0378623172e9c60073b8d8761bce7a95c263f99bfb3a42'],
  ['check-docs-size.mjs', '4.5.1', '4.5.4', 'fef3555b14a5ade46071bac18bd6dfc87daec39dd63ce1f7965864c3e51558d9'],
  ['check-docs-size.test.mjs', '4.0.0', '4.5.4', '88fbb3d7f097d74771b7c5d9ad99fcd58b274ae33f391e1ff01f4b138b9236cd'],
  ['spec-schema.mjs', '4.6.0', '4.6.1', 'f8ee23d81e90fd4225ca4ece288cba41982c4430290bc6d033f5ca18d2d283f4'],
  ['spec-schema.test.mjs', '4.6.0', '4.6.1', 'a12d6d3f5d32c6dabdee7e15af7d2ab15a0ced37515d1844fe0951f60cddbc99'],
  ['spec-schema.mjs', '4.7.0', '4.7.0', '40b5b038d5ec5ed53c327c6d269d22fe5fa2bed99ae711fbf84306ad047be452'],
  ['spec-schema.test.mjs', '4.7.0', '4.7.0', 'fde896419924223e54cfcabfdb1ef5807df5386fac700ed7c1463b6e7f81501b'],
  ['check-docs-size.mjs', '4.6.0', '6.0.0', '22d020c3668cdbfb4cbc1f67a8a85b2baa2d0c4956808a50626d37409e81ab38'],
  ['spec-schema.mjs', '5.0.0', '7.2.1', '6a7d1e836c158baab5a412a1ad76d34891934dc28c88486c264a4b5d46f5892a'],
  ['spec-schema.test.mjs', '5.0.0', '7.2.1', '698564d7283281be1826019d214df475bb876687915de086818d8f5ece0e0336'],
  ['check-docs-size.mjs', '7.0.0', '8.1.5', '0cf90ae2cbfc809847574a8c71a6b1322c783359740b08e0ff179f0d9d04dffc'],
  ['install-git-hooks.mjs', '4.0.0', '8.2.1', '4c4010153cd3a9ca556f34d567d9985cff5c6e1b5ec3087ed7805e5c98f6f918'],
  ['install-git-hooks.test.mjs', '4.0.0', '7.1.2', '9603c4dec823d4de8b7b603563d98acb836c0f430565ef8b56c31db4aea4829b'],
  ['install-git-hooks.test.mjs', '7.2.0', '8.2.1', 'b57d6b2004ef1967034d9ad8d1f1db0a3b4972c6284bb8c79dea6900dcec0b69'],
  ['install-git-hooks-repo-exec.test.mjs', '4.0.0', '8.2.1', 'f12584b062cfa337f09f21b8d4d096549eaecc08242ee264e6f0b98226605464'],
  ['install-git-hooks.mjs', '8.3.0', '8.3.0', 'aa21b3dcbfc48ea1db7a33ed5a5c8cf30d911b266386b67159288cd12d28bc38'],
  ['install-git-hooks.test.mjs', '8.3.0', '8.3.0', '058ac6de4dd5f83c4f09c8afd72ef2bfda365a9aea55bddd0089ce89a4e941e2'],
  ['install-git-hooks-repo-exec.test.mjs', '8.3.0', '8.3.0', 'd5a3253fa0cd088733b927f2a7187c6484298f11dec48f6f63953e380b071c9a'],
  ['archive-decisions.mjs', '8.1.3', '8.4.0', '2e1c378fe8a395440dc17a712643a549487e87f958f9d6ec5922dced876421ad'],
  ['spec-schema.mjs', '8.0.0', '8.6.3', '238e9a0ab3839f56b9f488b8c3232e8289c90d9808c772864dd5a95405b8488c'],
  ['spec-schema.test.mjs', '8.0.0', '8.6.3', '192661dd459c130004b2639d506676ee023fb24e862aad09656adc8c1418af04'],
];
const CATALOG_ROWS = 45;
const LAST_FLAT_RELEASE = '1af99af';
const LAST_FLAT_VERSION = '9.0.0';
const OTHER_BYTES = Buffer.from('not a shipped script body\n');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixturePath = (row) => join(FIXTURES, row.firstShipped, `${row.file}.txt`);
const readFixtures = () => readdirSync(FIXTURES).flatMap((firstShipped) => readdirSync(join(FIXTURES, firstShipped))
  .map((name) => ({ file: name.replace(/\.txt$/, ''), firstShipped })));
const DEPLOYED_BY_NAME = new Map(DEPLOYED_SCRIPTS.map((entry) => [posix.basename(entry.path), entry]));
const deployedBundleBytes = (file) => DEPLOYED_BY_NAME.has(file) ? readFileSync(join(KIT_ROOT, DEPLOYED_BY_NAME.get(file).bundled)) : OTHER_BYTES;
const { readFamily } = await import('../references/scripts/family.mjs').catch(() => ({}));
const MANIFEST_PATH = new Map((readFamily?.(BUNDLE) ?? []).map((entry) => [posix.basename(entry.path), entry.path]));
const bundleBytes = (file) => readFileSync(join(BUNDLE, MANIFEST_PATH.get(file) ?? file));

describe('SCRIPT_PRIORS — the catalog and its fixtures agree both ways', () => {
  it('carries the frozen row count, frozen rows, and a 64-hex digest per row', () => {
    assert.ok(Object.isFrozen(SCRIPT_PRIORS));
    assert.equal(SCRIPT_PRIORS.length, CATALOG_ROWS);
    for (const row of SCRIPT_PRIORS) {
      assert.ok(Object.isFrozen(row), row.file);
      assert.deepEqual(Object.keys(row).sort(), ['digest', 'file', 'firstShipped', 'lastShipped']);
      assert.match(row.digest, /^[0-9a-f]{64}$/, `${row.file} ${row.firstShipped}`);
      assert.ok(PRIOR_FILES.includes(row.file), `${row.file} is a refreshable script`);
    }
  });

  it('the frozen rows are an immutable PREFIX of the catalog — a row is only ever appended', () => {
    assert.ok(SCRIPT_PRIORS.length >= FROZEN_PRIORS.length, 'a shipped row was dropped');
    FROZEN_PRIORS.forEach(([file, firstShipped, lastShipped, digest], i) => {
      assert.deepEqual({ ...SCRIPT_PRIORS[i] }, { file, firstShipped, lastShipped, digest }, `row ${i} (${firstShipped}/${file}) was edited or moved`);
    });
  });

  it('every catalog digest is the sha256 of its fixture body', () => {
    for (const row of SCRIPT_PRIORS) {
      assert.equal(sha256(readFileSync(fixturePath(row))), row.digest, `${row.firstShipped}/${row.file}.txt`);
    }
  });

  it('every fixture on disk has exactly one catalog row', () => {
    const onDisk = readFixtures().map((row) => `${row.firstShipped}/${row.file}.txt`);
    const catalogued = SCRIPT_PRIORS.map((row) => `${row.firstShipped}/${row.file}.txt`);
    assert.deepEqual(onDisk.sort(), catalogued.sort());
    assert.equal(new Set(catalogued).size, catalogued.length, 'no row is listed twice');
  });

  it('no prior digest is the bundled body — the outgoing body is appended only once it has changed', () => {
    for (const file of DEPLOYED_BY_NAME.keys()) {
      const current = sha256(deployedBundleBytes(file));
      for (const row of SCRIPT_PRIORS.filter((r) => r.file === file)) {
        assert.notEqual(row.digest, current, `${row.firstShipped}/${file} is the current bundle`);
      }
    }
  });
});

describe('classifyDeployedScript — current | prior | custom over real bytes', () => {
  it('the bundled pair classifies current', () => {
    for (const file of PRIOR_FILES) {
      assert.equal(classifyDeployedScript(bundleBytes(file), file, bundleBytes(file)), 'current', file);
    }
  });

  it('every fixture body classifies prior', () => {
    const fixtures = readFixtures();
    assert.deepEqual(fixtures.map((row) => [fixturePath(row), classifyDeployedScript(readFileSync(fixturePath(row)), row.file, deployedBundleBytes(row.file))]),
      fixtures.map((row) => [fixturePath(row), 'prior']));
  });

  it('one flipped byte in a prior body classifies custom, and so does a file the catalog never lists', () => {
    const row = SCRIPT_PRIORS[0];
    const flipped = Buffer.from(readFileSync(fixturePath(row)));
    flipped[0] = flipped[0] ^ 0x01;
    assert.equal(classifyDeployedScript(flipped, row.file, bundleBytes(row.file)), 'custom');
    assert.equal(classifyDeployedScript(Buffer.from('// mine\n'), 'spec-schema.mjs', bundleBytes('spec-schema.mjs')), 'custom');
    assert.equal(classifyDeployedScript(bundleBytes('spec-schema.mjs'), 'spec-schema.mjs', bundleBytes('spec-schema.mjs')), 'current');
  });

  it('digestOf is the sha256 hex of the bytes', () => {
    assert.equal(digestOf(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('spec:docs-navigator/S3 the outgoing checker body is a prior, the deployed test is not', () => {
  const [file, firstShipped, lastShipped, digest] = FROZEN_PRIORS[11];
  const row = { file, firstShipped, lastShipped, digest };
  const readFixture = () => readFileSync(fixturePath(row));
  it("the 7.0.0 to 8.1.5 row is the twelfth and its digest is the fixture's sha256", () => {
    assert.deepEqual({ ...SCRIPT_PRIORS[11] }, row);
    assert.equal(sha256(readFixture()), digest);
  });
  it('the fixture classifies prior against the bundled checker', () => {
    assert.equal(classifyDeployedScript(readFixture(), file, bundleBytes(file)), 'prior');
  });
  it('the bundled check-docs-size.test.mjs classifies current', () => {
    const testFile = 'check-docs-size.test.mjs';
    assert.equal(classifyDeployedScript(bundleBytes(testFile), testFile, bundleBytes(testFile)), 'current');
  });
});

describe('spec:init-project/S59 the known-prior catalog carries the hook installer', () => {
  const INSTALLER = 'install-git-hooks.mjs';
  const rowOf = (rows = (SCRIPT_PRIORS ?? []).filter((r) => r.file === INSTALLER && r.firstShipped === '4.0.0')) => {
    assert.equal(rows.length, 1, 'the installer has exactly one 4.0.0 catalog row');
    return rows[0];
  };
  const fixtureBytes = () => readFileSync(fixturePath(rowOf()));
  it('PRIOR_FILES carries install-git-hooks.mjs and SCRIPT_PRIORS its 4.0.0 row, the thirteenth, 4.0.0 to 8.2.1', () => {
    assert.ok(PRIOR_FILES.includes(INSTALLER), 'the installer is a refreshable script');
    const [file, firstShipped, lastShipped, digest] = FROZEN_PRIORS[12];
    assert.equal(SCRIPT_PRIORS.indexOf(rowOf()), 12);
    assert.deepEqual([rowOf().firstShipped, rowOf().lastShipped], ['4.0.0', '8.2.1']);
    assert.deepEqual({ ...rowOf() }, { file, firstShipped, lastShipped, digest });
  });
  it("its digest is the sha256 of its fixture's raw bytes, which classify prior against the bundled installer", () => {
    const body = fixtureBytes();
    assert.ok(Buffer.isBuffer(body), 'the fixture is read as bytes, never decoded');
    assert.equal(sha256(body), rowOf().digest);
    assert.equal(classifyDeployedScript(body, INSTALLER, bundleBytes(INSTALLER)), 'prior');
  });
  it('the bundled installer classifies current and one flipped byte custom, even two a lossy decode folds to U+FFFD', () => {
    const bundled = bundleBytes(INSTALLER);
    assert.equal(classifyDeployedScript(bundled, INSTALLER, bundled), 'current');
    const flips = [0x80, 0x81].map((bit) => { const f = Buffer.from(fixtureBytes()); f[f.length - 1] ^= bit; return f; });
    for (const f of flips) assert.equal(classifyDeployedScript(f, INSTALLER, bundled), 'custom');
    assert.equal(flips[0].toString('utf8'), flips[1].toString('utf8'), 'both invalid bytes decode to the same U+FFFD text');
    assert.notEqual(digestOf(flips[0]), digestOf(flips[1]), 'the digests stay distinct over the bytes');
  });
});

describe('spec:distribution-files/S23 the catalog: the flat names, the spec-layer pairs, the installer set and an installer in the kit folder', () => {
  const SET = ['install-git-hooks.mjs', 'install-git-hooks.test.mjs', 'install-git-hooks-repo-exec.test.mjs'];
  // The 25 flat names the kit placed in scripts/ before revision 17 of distribution-files, as a literal independent of the module.
  const FLAT = Object.freeze(['_expect-shim.mjs', 'archive-caps.mjs', 'archive-caps.test.mjs', 'archive-changelog.mjs', 'archive-changelog.test.mjs',
    'archive-conservation.test.mjs', 'archive-decisions.mjs', 'archive-decisions.test.mjs', 'archive-issues.mjs', 'archive-issues.test.mjs',
    'archiver-structure.test.mjs', 'check-docs-size-cli.test.mjs', 'check-docs-size-ensure.test.mjs', 'check-docs-size.mjs', 'check-docs-size.test.mjs',
    'install-git-hooks-repo-exec.test.mjs', 'install-git-hooks.mjs', 'install-git-hooks.test.mjs', 'markdown-blocks.mjs', 'markdown-blocks.test.mjs',
    'migrate-gates-branches.test.mjs', 'migrate-gates.mjs', 'migrate-gates.test.mjs', 'spec-schema.mjs', 'spec-schema.test.mjs']);
  const rowsOf = (from, to) => FROZEN_PRIORS.slice(from, to).map(([file, firstShipped, lastShipped, digest]) => ({ file, firstShipped, lastShipped, digest }));
  const [suiteRows, setRows] = [rowsOf(13, 16), rowsOf(16, 19)];
  const inTemp = (cell) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'script-priors-'))); try { cell(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };
  const spawnChecked = (command, args, cwd, encoding = 'utf8') => {
    const { NODE_TEST_CONTEXT, ...env } = hermeticGitEnv(process.env, cwd);
    const r = spawnSync(command, args, { cwd, env, encoding });
    assert.ok(!r.error && r.signal === null, `${command} ${args.join(' ')} did not run to an exit (${r.error?.code ?? r.signal})`);
    assert.equal(r.status, 0, `${command} ${args.join(' ')}: ${r.stdout}${r.stderr}`);
    return r;
  };
  const LOCAL = 'if [ -f scripts/pre-commit.local ]; then bash scripts/pre-commit.local; fi';
  // The hook less its comment and local lines, once they are proven to sit right after `set -e`.
  const lessLocal = (hook, label) => {
    const lines = hook.split('\n');
    const at = lines.indexOf('set -e');
    const comments = lines.filter((l) => l.startsWith('# ') && l.includes('scripts/pre-commit.local'));
    assert.deepEqual([at >= 0, comments.length, comments[0] === lines[at + 1], lines[at + 2]], [true, 1, true, LOCAL], `${label}: one comment line naming scripts/pre-commit.local, then the local line, right after set -e\n${hook}`);
    lines.splice(at + 1, 2);
    return lines.join('\n');
  };
  it('appends exactly the 23 last-flat bodies after the frozen prefix, with fixture folders, digests and lastShipped 9.0.0', () => {
    assert.deepEqual(Object.keys(scriptPriors).sort(), ['CHECKER_PAIR', 'INSTALLER_SET', 'PRIOR_FILES', 'READER_PAIR', 'SCRIPT_PRIORS', 'classifyDeployedScript', 'digestOf']);
    for (const folder of [FIXTURES, ...readdirSync(FIXTURES).map((version) => join(FIXTURES, version))]) {
      assert.ok(readdirSync(folder).length <= KIT_LIMITS['entries-per-directory'].value, folder);
    }
    const fixtures = readFixtures();
    const current = [];
    const expected = FLAT.flatMap((file) => {
      const canon = spawnChecked('git', ['show', `${LAST_FLAT_RELEASE}:agent-workflow-memory/references/scripts/${file}`], KIT_ROOT, null).stdout;
      const mirror = spawnChecked('git', ['show', `${LAST_FLAT_RELEASE}:agent-workflow-kit/references/scripts/${file}`], KIT_ROOT, null).stdout;
      assert.ok(canon.equals(mirror), `${file}: the kit mirror equals the canon's raw bytes`);
      if (DEPLOYED_BY_NAME.has(file) && canon.equals(deployedBundleBytes(file))) {
        current.push(file);
        assert.deepEqual(SCRIPT_PRIORS.filter((row) => row.file === file && row.digest === sha256(canon)), [], `${file}: no row for the bundled body`);
        assert.deepEqual(fixtures.filter((row) => row.file === file && sha256(readFileSync(fixturePath(row))) === sha256(canon)), [], `${file}: no fixture for the bundled body`);
        return [];
      }
      const matches = fixtures.filter((row) => row.file === file && readFileSync(fixturePath(row)).equals(canon));
      assert.equal(matches.length, 1, `${file}: exactly one fixture equals the canon's raw bytes`);
      const row = { ...matches[0], lastShipped: LAST_FLAT_VERSION, digest: sha256(canon) };
      assert.equal(classifyDeployedScript(canon, `scripts/${file}`, OTHER_BYTES), 'custom', 'the classifier consults only the given name');
      return [row];
    });
    assert.deepEqual(current.sort(), ['markdown-blocks.mjs', 'spec-schema.mjs']);
    assert.equal(expected.length, CATALOG_ROWS - FROZEN_PRIORS.length);
    const sortRows = (rows) => [...rows].sort((left, right) => left.file.localeCompare(right.file));
    assert.deepEqual(sortRows(SCRIPT_PRIORS.slice(FROZEN_PRIORS.length)), sortRows(expected));
  });
  it("PRIOR_FILES is frozen and the 25 flat names, none of them a bundled file any longer; READER_PAIR, CHECKER_PAIR and INSTALLER_SET frozen flat names; the installer set's rows carry their fixture's sha256", () => {
    assert.ok(Object.isFrozen(PRIOR_FILES), 'PRIOR_FILES is a frozen export');
    assert.deepEqual([...PRIOR_FILES], [...FLAT], 'PRIOR_FILES is the 25 flat names');
    assert.deepEqual(FLAT.filter((file) => existsSync(join(BUNDLE, file))), [], 'no flat name is a file of the bundle, which is laid out by meaning');
    for (const pair of [READER_PAIR, CHECKER_PAIR]) assert.ok(Array.isArray(pair) && Object.isFrozen(pair), 'each pair is a frozen export of script-priors.mjs');
    assert.deepEqual([[...READER_PAIR], [...CHECKER_PAIR]], [['spec-schema.mjs', 'spec-schema.test.mjs'], ['check-docs-size.mjs', 'check-docs-size.test.mjs']]);
    assert.ok(Object.isFrozen(INSTALLER_SET), 'INSTALLER_SET is a frozen export');
    assert.deepEqual([...INSTALLER_SET], SET);
    assert.deepEqual(SCRIPT_PRIORS.slice(12, 19).map((row) => ({ ...row })), [...rowsOf(12, 13), ...suiteRows, ...setRows], 'the 4.0.0 installer row, the three suite rows, then one 8.3.0 row per member');
    assert.deepEqual(setRows.map((row) => row.file), [...INSTALLER_SET]);
    for (const row of [...rowsOf(12, 13), ...suiteRows, ...setRows]) {
      const body = readFileSync(fixturePath(row));
      assert.ok(Buffer.isBuffer(body), 'the fixture is read as bytes, never decoded');
      assert.equal(sha256(body), row.digest, fixturePath(row));
    }
  });
  it('ensureScripts over a kit folder whose installer carries the 8.3.0 body classifies it edited, never prior, and writes the bundled bytes; no catalog row names a file of the kit folder', async () => {
    assert.equal(typeof ensureScripts, 'function', 'distribution-files/index.mjs exports ensureScripts');
    const [{ INSTALLER_REL, KIT_SCRIPTS_DIR }, manifest] = await Promise.all([import('./node-evidence.mjs'), import('../references/scripts/family.mjs').catch((error) => ({ error }))]);
    inTemp((dir) => {
      writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}');
      mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
      mkdirSync(dirname(join(dir, INSTALLER_REL)), { recursive: true });
      writeFileSync(join(dir, INSTALLER_REL), readFileSync(fixturePath(setRows[0])));
      const r = ensureScripts({ cwd: dir, kitRoot: KIT_ROOT });
      const replaced = `${INSTALLER_REL}: differs from every body this kit knows it shipped — replaced by the bundled body; an edit meant to last goes in the local hook file scripts/pre-commit.local, which the commit hook runs first`;
      assert.deepEqual({ failed: r.failed, first: r.lines?.[0], prior: (r.lines ?? []).filter((l) => l.includes('matches a body an earlier release shipped')) }, { failed: false, first: replaced, prior: [] }, (r.lines ?? []).join('\n'));
      assert.equal(typeof manifest.readFamily, 'function', `references/scripts/family.mjs exports readFamily ${manifest.error ?? ''}`);
      // By digest: a failed deepEqual of two Buffers diffs them byte per line and takes gigabytes.
      assert.equal(sha256(readFileSync(join(dir, INSTALLER_REL))), sha256(bundleBytes(posix.relative(KIT_SCRIPTS_DIR, INSTALLER_REL))), 'the installer holds the bundled bytes');
      const kitFiles = manifest.readFamily(BUNDLE).flatMap((entry) => [entry.path, `${KIT_SCRIPTS_DIR}/${entry.path}`]);
      assert.deepEqual(SCRIPT_PRIORS.filter((row) => kitFiles.includes(row.file)), [], 'the catalog names no file in the kit folder');
    });
  });
  it('the bundled installer run flagless from the kit folder over the hook the 8.3.0 installer wrote with --commit-guard keeps the guard line, writes the name-free marker and adds the comment and local lines', async () => {
    const { INSTALLER_REL, KIT_SCRIPTS_DIR } = await import('./node-evidence.mjs');
    assert.equal(typeof KIT_SCRIPTS_DIR, 'string', 'node-evidence.mjs exports KIT_SCRIPTS_DIR');
    inTemp((root) => {
      spawnChecked('git', ['init', '-q'], root);
      writeFileSync(join(root, 'package.json'), '{"name":"fixture"}');
      writeFileSync(join(root, 'guard.mjs'), '// a stand-in commit-guard tool\n');
      const hook = join(resolve(root, spawnChecked('git', ['rev-parse', '--git-path', 'hooks'], root).stdout.trim()), 'pre-commit');
      mkdirSync(join(root, 'scripts'));
      writeFileSync(join(root, 'scripts', SET[0]), readFileSync(fixturePath(setRows[0])));
      spawnChecked(process.execPath, [join(root, 'scripts', SET[0]), '--commit-guard', 'guard.mjs'], root);
      const guarded = readFileSync(hook, 'utf8'), guard = guarded.split('\n').filter((l) => /^node "[^"]+" --check$/.test(l));
      assert.deepEqual([guard.length, guarded.split('\n').includes('# fixture:install-git-hooks.mjs'), guarded.includes(LOCAL)], [1, true, false], `the 8.3.0 hook: one guard line, the named marker, no local line\n${guarded}`);
      mkdirSync(dirname(join(root, INSTALLER_REL)), { recursive: true });
      writeFileSync(join(root, INSTALLER_REL), bundleBytes(posix.relative(KIT_SCRIPTS_DIR, INSTALLER_REL)));
      spawnChecked(process.execPath, [join(root, INSTALLER_REL)], root);
      const written = readFileSync(hook, 'utf8'), lines = written.split('\n');
      assert.deepEqual([lines.includes(guard[0]), lines.includes('# agent-workflow:install-git-hooks.mjs'), lines.includes('# fixture:install-git-hooks.mjs')], [true, true, false], `the guard kept, the name-free marker in place of the named one\n${written}`);
      lessLocal(written, 'flagless over the 8.3.0 guarded hook');
    });
  });
});
