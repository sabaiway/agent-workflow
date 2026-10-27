// script-priors.test.mjs — the append-only catalog of shipped enforcement-script bodies, verified
// EXHAUSTIVELY against the fixture bytes: every catalog digest is the sha256 of its fixture and every
// fixture on disk has a catalog row, so neither side can drift behind the other. Then the three
// classification arms over real bytes (the bundle, every fixture, one flipped byte), and the 8.3.0
// installer set by proof: refreshed by ensureScripts, and its hook against the bundled one in a temp git project.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hermeticGitEnv } from './git-env.mjs';
import { BUNDLED_SCRIPT_NAMES } from './node-evidence.mjs';

const { SCRIPT_PRIORS, PRIOR_FILES, READER_PAIR, CHECKER_PAIR, INSTALLER_SET, classifyDeployedScript, digestOf } = await import('./script-priors.mjs').catch(() => ({}));
const { ensureScripts } = await import('./distribution-files/index.mjs').catch(() => ({}));

const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(KIT_ROOT, 'test', 'fixtures', 'script-priors');
const BUNDLE = join(KIT_ROOT, 'references', 'scripts');
// The append-only pin, INDEPENDENT of the module: every row the catalog has ever carried, as a
// literal, held as an immutable PREFIX of SCRIPT_PRIORS. A count alone would let a row and its
// fixture be replaced together — the digests would still agree — and a shipped body would silently
// become "custom" on every deployment that carries it. A release that changes ANY PRIOR_FILES member
// appends the outgoing body's row HERE too; a row is never edited or removed.
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
const CATALOG_ROWS = FROZEN_PRIORS.length;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixturePath = (row) => join(FIXTURES, row.firstShipped, `${row.file}.txt`);
const bundleBytes = (file) => readFileSync(join(BUNDLE, file));

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
    const onDisk = [];
    for (const version of readdirSync(FIXTURES)) {
      for (const name of readdirSync(join(FIXTURES, version))) onDisk.push(`${version}/${name}`);
    }
    const catalogued = SCRIPT_PRIORS.map((row) => `${row.firstShipped}/${row.file}.txt`);
    assert.deepEqual(onDisk.sort(), catalogued.sort());
    assert.equal(new Set(catalogued).size, catalogued.length, 'no row is listed twice');
  });

  it('no prior digest is the bundled body — the outgoing body is appended only once it has changed', () => {
    for (const file of PRIOR_FILES) {
      const current = sha256(bundleBytes(file));
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
    for (const row of SCRIPT_PRIORS) {
      assert.equal(classifyDeployedScript(readFileSync(fixturePath(row)), row.file, bundleBytes(row.file)), 'prior', fixturePath(row));
    }
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

describe('spec:distribution-files/S23 the catalog: every bundled name, the spec-layer pairs and the installer set', () => {
  const SET = ['install-git-hooks.mjs', 'install-git-hooks.test.mjs', 'install-git-hooks-repo-exec.test.mjs'];
  // The scripts family in its write order, as a literal independent of the module.
  const FAMILY = [...SET, '_expect-shim.mjs', 'archive-caps.mjs', 'archive-caps.test.mjs', 'archive-changelog.mjs', 'archive-changelog.test.mjs',
    'archive-conservation.test.mjs', 'archive-decisions.mjs', 'archive-decisions.test.mjs', 'archive-issues.mjs', 'archive-issues.test.mjs',
    'archiver-structure.test.mjs', 'check-docs-size-cli.test.mjs', 'check-docs-size-ensure.test.mjs', 'markdown-blocks.mjs',
    'markdown-blocks.test.mjs', 'migrate-gates-branches.test.mjs', 'migrate-gates.mjs', 'migrate-gates.test.mjs'];
  const rowsOf = (from, to) => FROZEN_PRIORS.slice(from, to).map(([file, firstShipped, lastShipped, digest]) => ({ file, firstShipped, lastShipped, digest }));
  const [suiteRows, setRows] = [rowsOf(13, 16), rowsOf(16, 19)];
  const inTemp = (cell) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'script-priors-'))); try { cell(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };
  // Every child drops each inherited GIT_ variable and runs on the project's own hermetic config; one that
  // never started or was killed fails the cell outright.
  const spawnChecked = (command, args, cwd) => {
    const r = spawnSync(command, args, { cwd, env: hermeticGitEnv(process.env, cwd), encoding: 'utf8' });
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
  it("PRIOR_FILES is every bundled name, READER_PAIR and CHECKER_PAIR the bundled names outside the scripts family, INSTALLER_SET the installer then its two suites, each frozen; the six set rows carry their fixture's sha256 and classify prior, the bundled members current", () => {
    assert.ok(Object.isFrozen(PRIOR_FILES), 'PRIOR_FILES is a frozen export');
    assert.deepEqual([...PRIOR_FILES], [...BUNDLED_SCRIPT_NAMES], 'PRIOR_FILES is every bundled name');
    for (const pair of [READER_PAIR, CHECKER_PAIR]) assert.ok(Array.isArray(pair) && Object.isFrozen(pair), 'each pair is a frozen export of script-priors.mjs');
    assert.deepEqual([[...READER_PAIR], [...CHECKER_PAIR]], [['spec-schema.mjs', 'spec-schema.test.mjs'], ['check-docs-size.mjs', 'check-docs-size.test.mjs']]);
    const pairs = [...READER_PAIR, ...CHECKER_PAIR];
    for (const file of pairs) assert.ok(BUNDLED_SCRIPT_NAMES.includes(file), `${file} is bundled`);
    assert.deepEqual(pairs.sort(), BUNDLED_SCRIPT_NAMES.filter((file) => !FAMILY.includes(file)), 'the pairs are the bundled names outside the scripts family');
    assert.ok(Object.isFrozen(INSTALLER_SET), 'INSTALLER_SET is a frozen export');
    assert.deepEqual([...INSTALLER_SET], SET);
    assert.equal(SCRIPT_PRIORS[12].file, 'install-git-hooks.mjs');
    assert.deepEqual(SCRIPT_PRIORS.slice(13, 19).map((row) => ({ ...row })), [...suiteRows, ...setRows], 'the three suite rows, then one 8.3.0 row per member');
    assert.deepEqual(setRows.map((row) => row.file), [...INSTALLER_SET]);
    for (const row of [...suiteRows, ...setRows]) {
      const body = readFileSync(fixturePath(row));
      assert.ok(Buffer.isBuffer(body), 'the fixture is read as bytes, never decoded');
      assert.equal(sha256(body), row.digest, fixturePath(row));
      assert.equal(classifyDeployedScript(body, row.file, bundleBytes(row.file)), 'prior', fixturePath(row));
    }
    for (const file of SET) assert.equal(classifyDeployedScript(bundleBytes(file), file, bundleBytes(file)), 'current', file);
  });
  it('ensureScripts of the index refreshes a component carrying the three 8.3.0 bodies and places every absent family file, token seeded; the 8.3.0 installer writes the bundled hook less the comment and local lines, and the bundled one over its guarded hook keeps the guard and adds them', () => {
    assert.equal(typeof ensureScripts, 'function', 'distribution-files/index.mjs exports ensureScripts');
    inTemp((dir) => {
      writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}');
      mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
      mkdirSync(join(dir, 'scripts'));
      for (const row of setRows) writeFileSync(join(dir, 'scripts', row.file), readFileSync(fixturePath(row)));
      const r = ensureScripts({ cwd: dir, kitRoot: KIT_ROOT });
      // The other family files are absent, so the one plain run places them beside the refreshed set.
      assert.deepEqual({ token: r.token, failed: r.failed, entries: 'entries' in r }, { token: 'seeded', failed: false, entries: false }, (r.lines ?? []).join('\n'));
      assert.deepEqual(r.lines.slice(0, 3), SET.map((file) => `scripts/${file}: matches a body an earlier release shipped — refreshed to the bundled one`));
      // By digest: a failed deepEqual of two Buffers diffs them byte per line and takes gigabytes.
      for (const file of FAMILY) assert.equal(sha256(readFileSync(join(dir, 'scripts', file))), sha256(bundleBytes(file)), `${file} holds the bundled bytes`);
    });
    inTemp((root) => {
      spawnChecked('git', ['init', '-q'], root);
      mkdirSync(join(root, 'scripts'));
      writeFileSync(join(root, 'guard.mjs'), '// a stand-in commit-guard tool\n');
      const hook = join(resolve(root, spawnChecked('git', ['rev-parse', '--git-path', 'hooks'], root).stdout.trim()), 'pre-commit');
      const install = (body, ...args) => {
        writeFileSync(join(root, 'scripts', SET[0]), body);
        spawnChecked(process.execPath, [join(root, 'scripts', SET[0]), ...args], root);
        return readFileSync(hook, 'utf8');
      };
      const [fixture, bundled] = [readFileSync(fixturePath(setRows[0])), bundleBytes(SET[0])];
      const [h0, g0] = [install(fixture), install(fixture, '--commit-guard', 'guard.mjs')];
      rmSync(hook);
      const [h1, g1] = [install(bundled), install(bundled, '--commit-guard', 'guard.mjs')];
      assert.equal(lessLocal(h1, 'flagless'), h0, 'flagless: the bundled hook less the two lines is the 8.3.0 hook');
      assert.equal(lessLocal(g1, '--commit-guard'), g0, '--commit-guard: the bundled hook less the two lines is the 8.3.0 hook');
      writeFileSync(hook, g0);
      assert.equal(install(bundled), g1, 'flagless over the 8.3.0 guarded hook keeps the guard line and adds the two lines');
    });
  });
});
