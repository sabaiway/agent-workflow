import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readlinkSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertContainedRealPath } from './fs-safe.mjs';
import { lstatNoFollowRead } from './fs-read-nofollow.mjs';

const KIT_OWNER = {
  name: 'agent-workflow-kit', prefix: '[agent-workflow-kit]', noun: 'kit home',
  rerun: 'npx @sabaiway/agent-workflow-kit@latest init',
};
const MEMORY_OWNER = {
  name: 'agent-workflow-memory', prefix: '[agent-workflow-memory]', noun: 'memory home',
  rerun: 'npx @sabaiway/agent-workflow-memory@latest init',
};
const guards = { assertContainedRealPath, lstatNoFollow: lstatNoFollowRead };
const LF = String.fromCharCode(10);
const KIT_SKILL = ['---', 'name: agent-workflow-kit', '---', ''].join(LF);
const CRLF_SKILL = KIT_SKILL.replace('kit', 'kit  ').split(LF).join(String.fromCharCode(13, 10));
const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLER = resolve(HERE, '..', 'bin', 'install.mjs');
const PAYLOAD = ['SKILL.md', 'references', 'tools', 'migrations', 'launchers'];
const PACKAGE_FILES = ['SKILL.md', 'references/a.md', 'references/sub/b.md', 'tools/x.mjs', 'tools/deep/y/z.mjs', 'migrations/README.md'];
const ORPHANS = ['references/planning.md', 'tools/methodology-slot.md', 'tools/deep/y/old.mjs', 'references/gone/deeper/c.md'];
const ORPHAN_A = 'references/a-orphan.md';
const ORPHAN_B = 'tools/b-orphan.mjs';
const PERMISSION_CASE = { skip: process.getuid?.() === 0 };
const state = { root: null };

before(() => { state.root = mkdtempSync(join(tmpdir(), 'payload-prune-')); });
after(() => rmSync(state.root, { recursive: true, force: true }));

const writeFixtureFile = (root, path, content = path) => {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
};
const createFixture = () => {
  const directory = mkdtempSync(join(state.root, 'case-'));
  const packageRoot = join(directory, 'package');
  const home = join(directory, 'home');
  PACKAGE_FILES.forEach((path) => writeFixtureFile(packageRoot, path));
  cpSync(packageRoot, home, { recursive: true });
  return { packageRoot, home, payload: PAYLOAD };
};
const hasToken = (line, token) => line.split(/[^a-z-]+/).includes(token);
const hasPath = (line, path) => {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-zA-Z0-9_./-])${escaped}($|[^a-zA-Z0-9_./-])`).test(line);
};
const assertReport = (result, token, path) => {
  const lines = result.lines.filter((line) => hasToken(line, token) && hasPath(line, path));
  assert.equal(lines.length, 1, JSON.stringify(result.lines));
  return lines[0];
};
const assertResult = (result, ok) => {
  assert.equal(result.ok, ok);
  assert.ok(Array.isArray(result.lines));
  result.lines.forEach((line) => assert.equal(typeof line, 'string'));
  const hasFailure = result.lines.some((line) => hasToken(line, 'failed') || hasToken(line, 'kind-mismatch'));
  assert.equal(result.ok, !hasFailure);
  assert.equal(result.nonConvergence === null, ok);
  if (!ok) assert.match(result.nonConvergence, /did not converge/);
};
const assertUntouched = (root, path) => assert.equal(readFileSync(join(root, path), 'utf8'), path);
const assertPackageFiles = ({ home }) => PACKAGE_FILES.forEach((path) => assertUntouched(home, path));
const assertNoRemoval = (result) => assert.ok(result.lines.every((line) => !hasToken(line, 'removed')));

for (const [label, url] of [
  ['copy', new URL('./payload-prune.mjs', import.meta.url)],
  ['canon', new URL('../../agent-workflow-memory/bin/payload-prune.mjs', import.meta.url)],
]) {
  const loaded = await import(url).catch(() => ({}));
  const prunePayload = loaded.prunePayload ?? (() => { throw new Error('prunePayload is absent'); });
  const readHomeOwner = loaded.readHomeOwner ?? (() => { throw new Error('readHomeOwner is absent'); });
  const assertInstallableHome = loaded.assertInstallableHome ?? (() => { throw new Error('assertInstallableHome is absent'); });
  describe(`spec:upgrade-delivery/S12 ${label} orphan removal at every depth`, () => {
    const ownerCases = [
      ['absent home', (home) => rmSync(home, { recursive: true }), 'absent'],
      ['kit name', (home) => writeFixtureFile(home, 'SKILL.md', KIT_SKILL), 'owned'],
      ['CRLF and trailing spaces', (home) => writeFixtureFile(home, 'SKILL.md', CRLF_SKILL), 'owned'],
      ['missing SKILL.md', (home) => writeFixtureFile(home, 'notes.md', 'notes'), 'other'],
      ['empty directory', (home) => home, 'empty'],
      ['another skill', (home) => writeFixtureFile(home, 'SKILL.md', KIT_SKILL.replace('agent-workflow-kit', 'other')), 'other'],
      ['name after frontmatter', (home) => writeFixtureFile(home, 'SKILL.md', ['---', '---', 'name: agent-workflow-kit'].join(LF)), 'other'],
      ['no frontmatter', (home) => writeFixtureFile(home, 'SKILL.md', 'name: agent-workflow-kit'), 'other'],
      ['unterminated frontmatter', (home) => writeFixtureFile(home, 'SKILL.md', ['---', 'name: agent-workflow-kit'].join(LF)), 'other'],
      ['symlink', (home) => symlinkSync(writeFixtureFile(home, 'owner.md', KIT_SKILL), join(home, 'SKILL.md')), 'other'],
      ['directory', (home) => mkdirSync(join(home, 'SKILL.md')), 'other'],
      ['unreadable', (home) => writeFileSync(join(home, 'SKILL.md'), KIT_SKILL, { mode: 0o000 }), 'other', PERMISSION_CASE],
    ];
    for (const [name, prepare, expected, options = {}] of ownerCases) {
      it(`classifies home ownership: ${name}`, options, () => {
        const home = mkdtempSync(join(state.root, 'owner-'));
        try {
          prepare(home);
          assert.equal(readHomeOwner(home, KIT_OWNER), expected);
        } finally {
          if (name === 'unreadable') chmodSync(join(home, 'SKILL.md'), 0o644);
        }
      });
    }

    it('classifies a home that is a regular file as other', () => {
      const home = join(mkdtempSync(join(state.root, 'file-')), 'owner-file');
      writeFileSync(home, KIT_SKILL);
      assert.equal(readHomeOwner(home, KIT_OWNER), 'other');
    });
    it('admits absent, empty and kit homes and refuses a foreign home', () => {
      const home = mkdtempSync(join(state.root, 'admission-'));
      assert.equal(assertInstallableHome(join(home, 'absent'), KIT_OWNER), 'absent');
      assert.equal(assertInstallableHome(home, KIT_OWNER), 'empty');
      writeFixtureFile(home, 'SKILL.md', KIT_SKILL);
      assert.equal(assertInstallableHome(home, KIT_OWNER), 'owned');
      const foreign = mkdtempSync(join(state.root, 'foreign-'));
      writeFixtureFile(foreign, 'notes.md');
      assert.throws(() => assertInstallableHome(foreign, KIT_OWNER), (error) => error instanceof Error && error.message.includes(`refusing to install into ${foreign}`));
    });
    it('removes all four orphans and the emptied directories and preserves the carried files', async () => {
      const fixture = createFixture();
      ORPHANS.forEach((path) => writeFixtureFile(fixture.home, path));
      const result = await prunePayload({ ...fixture, owner: KIT_OWNER }, guards);
      assertResult(result, true);
      assert.ok(result.lines.filter((line) => hasToken(line, 'removed')).every((line) => line.endsWith('(not in the package)')));
      for (const path of ORPHANS) {
        assert.equal(existsSync(join(fixture.home, path)), false);
        assertReport(result, 'removed', path);
      }
      assertPackageFiles(fixture);
      assert.equal(existsSync(join(fixture.home, 'references/gone')), false);
      assertReport(result, 'removed', 'references/gone');
    });
    it('reports nothing for an unmodified copy', async () => {
      const fixture = createFixture();
      const result = await prunePayload({ ...fixture, owner: KIT_OWNER }, guards);
      assertResult(result, true);
      assert.deepEqual(result.lines, []);
      assertPackageFiles(fixture);
    });
    it('removes nothing on a second run', async () => {
      const fixture = createFixture();
      ORPHANS.forEach((path) => writeFixtureFile(fixture.home, path));
      assertResult(await prunePayload({ ...fixture, owner: KIT_OWNER }, guards), true);
      const result = await prunePayload({ ...fixture, owner: KIT_OWNER }, guards);
      assertResult(result, true);
      assertNoRemoval(result);
      assertPackageFiles(fixture);
    });
  });

  describe(`spec:upgrade-delivery/S13 ${label} preserved objects and payload boundaries`, () => {
    it('removes an empty uncarried directory tree with one line for its top directory and none on the next run', async () => {
      const fixture = createFixture();
      const tops = ['tools/userdir', 'tools/userdir2'];
      ['tools/userdir/a/b', 'tools/userdir2'].forEach((path) => mkdirSync(join(fixture.home, path), { recursive: true }));
      const result = await prunePayload({ ...fixture, owner: KIT_OWNER }, guards);
      assertResult(result, true);
      tops.forEach((path) => assert.equal(existsSync(join(fixture.home, path)), false));
      assert.deepEqual(result.lines, tops.map((path) => assertReport(result, 'removed', path)));
      assert.deepEqual((await prunePayload({ ...fixture, owner: KIT_OWNER }, guards)).lines, []);
    });
    it('keeps a symlink untouched and its directory with one kept line, and removes the empty child', async () => {
      const fixture = createFixture();
      const outside = mkdtempSync(join(state.root, 'outside-'));
      writeFixtureFile(outside, 'secret.txt');
      const link = join(fixture.home, 'tools/holder/link');
      mkdirSync(join(fixture.home, 'tools/holder/empty'), { recursive: true });
      symlinkSync(outside, link);
      for (const run of [1, 2]) {
        const result = await prunePayload({ ...fixture, owner: KIT_OWNER }, guards);
        assertResult(result, true);
        assert.equal(result.lines.length, 2, `run ${run}`);
        assert.ok(assertReport(result, 'kept', 'tools/holder').includes('still holds an entry'));
        assertReport(result, 'kept', 'tools/holder/link');
        assert.equal(existsSync(join(fixture.home, 'tools/holder/empty')), false);
        assert.equal(readlinkSync(link), outside);
        assertUntouched(outside, 'secret.txt');
      }
    });
    const directoryCells = [
      { name: 'an absent directory is no failure', primitive: 'lstatNoFollow', value: null, ok: true },
      { name: 'a path no longer a real directory fails', primitive: 'lstatNoFollow', value: { isDirectory: () => false } },
      { name: 'an rmdir error fails', primitive: 'rmdirSync', message: 'rmdir boom' },
      { name: 'a directory gone before its rmdir is no failure', primitive: 'rmdirSync', message: 'gone', code: 'ENOENT', ok: true },
      { name: 'a platform answering EEXIST keeps it with no failure', primitive: 'rmdirSync', message: 'full', code: 'EEXIST', ok: true, kept: true },
      { name: 'a containment refusal fails', primitive: 'assertContainedRealPath', message: 'contained boom' },
    ];
    for (const cell of directoryCells) {
      it(`emptied directory: ${cell.name}`, async () => {
        const fixture = createFixture();
        const directory = join(fixture.home, 'tools/emptied');
        writeFixtureFile(fixture.home, 'tools/emptied/x.mjs');
        const real = { ...guards, rmdirSync };
        const result = await prunePayload({ ...fixture, owner: KIT_OWNER }, {
          ...guards,
          [cell.primitive]: (...args) => {
            if (args[cell.primitive === 'assertContainedRealPath' ? 1 : 0] !== directory) return real[cell.primitive](...args);
            if (cell.message) throw Object.assign(new Error(cell.message), { code: cell.code });
            return cell.value;
          },
        });
        const ok = cell.ok === true;
        assertResult(result, ok);
        assertReport(result, 'removed', 'tools/emptied/x.mjs');
        const lines = result.lines.filter((line) => hasPath(line, 'tools/emptied'));
        const expected = cell.kept ? 'kept' : ok ? null : 'failed';
        assert.deepEqual(lines, expected ? [assertReport(result, expected, 'tools/emptied')] : []);
        assert.ok(ok || lines[0].includes(cell.message ?? 'no longer a real directory'));
        assert.ok(lstatSync(directory).isDirectory());
      });
    }
    it('does not report or change files beside the payload roots', async () => {
      const fixture = createFixture();
      const paths = ['runtime.json', '.cache/x'];
      paths.forEach((path) => writeFixtureFile(fixture.home, path));
      const result = await prunePayload({ ...fixture, owner: KIT_OWNER }, guards);
      assertResult(result, true);
      for (const path of paths) {
        assertUntouched(fixture.home, path);
        assert.ok(result.lines.every((line) => !line.includes(path)));
      }
    });
    it('removes a user file inside a carried subtree', async () => {
      const fixture = createFixture();
      const path = 'references/my-notes.md';
      writeFixtureFile(fixture.home, path);
      const result = await prunePayload({ ...fixture, owner: KIT_OWNER }, guards);
      assertResult(result, true);
      assert.equal(existsSync(join(fixture.home, path)), false);
      assertReport(result, 'removed', path);
    });
  });

  describe(`spec:upgrade-delivery/S14 ${label} partial packages and enumeration failures`, () => {
    it('leaves the home untouched and reports nothing when the package root is absent', async () => {
      const fixture = createFixture();
      const packageRoot = join(dirname(fixture.packageRoot), 'absent-package');
      const path = 'references/orphan.md';
      writeFixtureFile(fixture.home, path);
      const result = await prunePayload({ ...fixture, packageRoot, owner: KIT_OWNER }, guards);
      assertResult(result, true);
      assert.deepEqual(result.lines, []);
      assertUntouched(fixture.home, path);
    });
    it('reports failure without removing the orphan when the package root is a regular file', async () => {
      const fixture = createFixture();
      const packageRoot = writeFixtureFile(dirname(fixture.packageRoot), 'package-file');
      const path = 'references/orphan.md';
      writeFixtureFile(fixture.home, path);
      const result = await prunePayload({ ...fixture, packageRoot, owner: KIT_OWNER }, guards);
      assertResult(result, false);
      assert.ok(result.lines.length > 0);
      assert.ok(result.lines.every((line) => hasToken(line, 'failed')));
      assertUntouched(fixture.home, path);
    });
    it('leaves a subtree absent from the package untouched and unreported', async () => {
      const fixture = createFixture();
      const path = 'launchers/old.sh';
      writeFixtureFile(fixture.home, path);
      const result = await prunePayload({ ...fixture, owner: KIT_OWNER }, guards);
      assertResult(result, true);
      assertUntouched(fixture.home, path);
      assert.ok(result.lines.every((line) => !line.includes('launchers')));
    });
    it('does not prune a subtree whose package has no regular file', async () => {
      const fixture = createFixture();
      unlinkSync(join(fixture.packageRoot, 'migrations/README.md'));
      mkdirSync(join(fixture.packageRoot, 'migrations/empty'));
      const path = 'migrations/1.0.0-x.md';
      writeFixtureFile(fixture.home, path);
      const result = await prunePayload({ ...fixture, owner: KIT_OWNER }, guards);
      assertResult(result, true);
      assertUntouched(fixture.home, path);
      assertUntouched(fixture.home, 'migrations/README.md');
      assert.ok(result.lines.every((line) => !line.includes('migrations')));
    });
    for (const [side, path] of [['home', 'tools/locked'], ['packageRoot', 'references/locked']]) {
      it(`removes nothing when ${side} enumeration fails`, PERMISSION_CASE, async () => {
        const fixture = createFixture();
        writeFixtureFile(fixture.home, 'references/orphan.md');
        const locked = join(fixture[side], path);
        mkdirSync(locked);
        const mode = lstatSync(locked).mode;
        try {
          chmodSync(locked, 0o000);
          const result = await prunePayload({ ...fixture, owner: KIT_OWNER }, guards);
          assertResult(result, false);
          assert.ok(result.lines.some((line) => hasToken(line, 'failed')));
          assertNoRemoval(result);
          assertUntouched(fixture.home, 'references/orphan.md');
          assertPackageFiles(fixture);
        } finally {
          chmodSync(locked, mode);
        }
      });
    }
    for (const kind of ['file', 'directory']) {
      it(`removes nothing when a home ${kind} occupies a carried symlink path`, async () => {
        const fixture = createFixture();
        const path = 'tools/link.mjs';
        symlinkSync('x.mjs', join(fixture.packageRoot, path));
        if (kind === 'file') writeFixtureFile(fixture.home, path);
        else mkdirSync(join(fixture.home, path));
        writeFixtureFile(fixture.home, 'references/orphan.md');
        const result = await prunePayload({ ...fixture, owner: KIT_OWNER }, guards);
        assertResult(result, false);
        const line = assertReport(result, 'kind-mismatch', path);
        assert.ok(hasToken(line, kind));
        assert.ok(hasToken(line, 'symlink'));
        assertNoRemoval(result);
        assertUntouched(fixture.home, 'references/orphan.md');
        assertPackageFiles(fixture);
        assert.equal(lstatSync(join(fixture.home, path)).isDirectory(), kind === 'directory');
      });
    }
  });

  describe(`spec:upgrade-delivery/S15 ${label} removal failures and installer exit`, () => {
    const cells = [
      { name: 'unlink failure', primitive: 'unlinkSync', message: 'unlink boom' },
      { name: 'containment refusal', primitive: 'assertContainedRealPath', message: 'contained boom' },
      { name: 're-probe error', primitive: 'lstatNoFollow', message: 'probe boom' },
      { name: 'non-file re-probe', primitive: 'lstatNoFollow', value: { isFile: () => false } },
      { name: 'absent re-probe', primitive: 'lstatNoFollow', value: null },
    ];
    for (const cell of cells) {
      it(`continues to B after A's ${cell.name}`, async () => {
        const fixture = createFixture();
        const target = writeFixtureFile(fixture.home, ORPHAN_A);
        writeFixtureFile(fixture.home, ORPHAN_B);
        const unlinkCalls = [];
        const primitives = {
          ...guards,
          unlinkSync: (path) => { unlinkCalls.push(path); return unlinkSync(path); },
        };
        const deps = {
          ...primitives,
          [cell.primitive]: (...args) => {
            const path = cell.primitive === 'assertContainedRealPath' ? args[1] : args[0];
            if (path !== target) return primitives[cell.primitive](...args);
            if (cell.message) throw new Error(cell.message);
            return cell.value;
          },
        };
        const result = await prunePayload({ ...fixture, owner: KIT_OWNER }, deps);
        const ok = cell.value === null;
        assertResult(result, ok);
        assertUntouched(fixture.home, ORPHAN_A);
        assert.equal(existsSync(join(fixture.home, ORPHAN_B)), false);
        assertReport(result, 'removed', ORPHAN_B);
        assert.ok(unlinkCalls.includes(join(fixture.home, ORPHAN_B)));
        if (!ok) {
          const line = assertReport(result, 'failed', ORPHAN_A);
          const cause = line.replace(/^\[[^\]]+\]\s*/, '').replace(ORPHAN_A, '').replace(/\bfailed\b/, '');
          if (cell.message) assert.ok(line.includes(cell.message));
          else assert.match(cause, /[a-zA-Z]/);
        }
        if (cell.primitive !== 'unlinkSync') assert.ok(!unlinkCalls.includes(target));
        assertPackageFiles(fixture);
      });
    }
  });
  describe(`spec:upgrade-delivery/S21 ${label} package-free module and owner lines`, () => {
    it('imports only node built-ins and names no package', () => {
      const source = readFileSync(url, 'utf8');
      const imports = [...source.matchAll(/\bimport(?:\s+[^'";]+?\s+from\s*|\s*\(\s*)['"]([^'"]+)['"]/g)];
      for (const [, specifier] of imports) assert.ok(specifier.startsWith('node:'), specifier);
      assert.doesNotMatch(source, /agent-workflow|@sabaiway/);
    });
    it('preserves every kit line byte for byte and composes memory lines from its owner', async () => {
      const fixture = createFixture();
      assert.throws(() => assertInstallableHome(fixture.home, KIT_OWNER), { message: `[agent-workflow-kit] refusing to install into ${fixture.home}: it is not empty and holds no agent-workflow-kit SKILL.md; choose a new or empty folder, or an existing kit home` });
      writeFixtureFile(fixture.home, 'references/old.md');
      mkdirSync(join(fixture.home, 'tools/holder'), { recursive: true });
      symlinkSync('missing', join(fixture.home, 'tools/holder/link'));
      const result = await prunePayload({ ...fixture, owner: KIT_OWNER }, guards);
      assert.equal(assertReport(result, 'removed', 'references/old.md'), '[agent-workflow-kit] removed references/old.md (not in the package)');
      assert.equal(assertReport(result, 'kept', 'tools/holder/link'), '[agent-workflow-kit] kept tools/holder/link (a symlink the package does not carry — yours to remove by hand)');
      assert.equal(assertReport(result, 'kept', 'tools/holder'), '[agent-workflow-kit] kept tools/holder (a directory the package does not carry that still holds an entry)');
      symlinkSync('x.mjs', join(fixture.packageRoot, 'tools/link.mjs'));
      writeFixtureFile(fixture.home, 'tools/link.mjs');
      const mismatch = await prunePayload({ ...fixture, owner: KIT_OWNER }, guards);
      assert.equal(assertReport(mismatch, 'kind-mismatch', 'tools/link.mjs'), '[agent-workflow-kit] kind-mismatch tools/link.mjs: the home holds a file, the package a symlink');
      unlinkSync(join(fixture.home, 'tools/link.mjs'));
      writeFixtureFile(fixture.home, 'references/old.md');
      const failureGuards = { ...guards, unlinkSync: () => { throw new Error('unlink boom'); } };
      const failed = await prunePayload({ ...fixture, owner: KIT_OWNER }, failureGuards);
      assert.equal(assertReport(failed, 'failed', 'references/old.md'), '[agent-workflow-kit] failed references/old.md: unlink boom');
      assert.equal(failed.nonConvergence, '[agent-workflow-kit] the kit home did not converge to the package (see the lines above) — fix them, then re-run npx @sabaiway/agent-workflow-kit@latest init');
      const memory = await prunePayload({ ...fixture, owner: MEMORY_OWNER }, guards);
      assert.equal(assertReport(memory, 'removed', 'references/old.md'), '[agent-workflow-memory] removed references/old.md (not in the package)');
      writeFixtureFile(fixture.home, 'references/old.md');
      const memoryFailure = await prunePayload({ ...fixture, owner: MEMORY_OWNER }, failureGuards);
      assert.equal(memoryFailure.nonConvergence, '[agent-workflow-memory] the memory home did not converge to the package (see the lines above) — fix them, then re-run npx @sabaiway/agent-workflow-memory@latest init');
    });
    it('reads the owner name from the record it is handed', () => {
      const home = mkdtempSync(join(state.root, 'memory-owner-'));
      writeFixtureFile(home, 'SKILL.md', KIT_SKILL);
      assert.equal(readHomeOwner(home, MEMORY_OWNER), 'other');
      assert.throws(() => assertInstallableHome(home, MEMORY_OWNER), { message: `[agent-workflow-memory] refusing to install into ${home}: it is not empty and holds no agent-workflow-memory SKILL.md; choose a new or empty folder, or an existing memory home` });
      writeFixtureFile(home, 'SKILL.md', KIT_SKILL.replace('agent-workflow-kit', 'agent-workflow-memory'));
      assert.equal(readHomeOwner(home, MEMORY_OWNER), 'owned');
      assert.equal(readHomeOwner(home, KIT_OWNER), 'other');
    });
  });
}

describe('the kit installer admission (S12)', () => {
  it('refuses an existing folder that is not a kit home on every run', () => {
    const home = mkdtempSync(join(state.root, 'unproven-'));
    const paths = ['tools/build.sh', 'migrations/0001_init.sql'];
    paths.forEach((path) => writeFixtureFile(home, path));
    for (const run of [1, 2]) {
      const result = spawnSync(process.execPath, [
        INSTALLER, '--dir', home, '--no-launchers', '--no-engine', '--no-memory', '--no-bridges',
      ], { encoding: 'utf8' });
      assert.equal(result.error, undefined, `run ${run}`);
      assert.equal(typeof result.status, 'number');
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.stderr.includes('refusing to install into '));
      paths.forEach((path) => assertUntouched(home, path));
      assert.equal(existsSync(join(home, 'SKILL.md')), false);
      assertNoRemoval({ lines: result.stdout.split(LF) });
    }
  });
});

describe('the kit installer exit (S15)', () => {
  it('defers a failed exit until later steps and suppresses the success verb', PERMISSION_CASE, () => {
    const home = mkdtempSync(join(state.root, 'install-'));
    writeFixtureFile(home, 'SKILL.md', KIT_SKILL);
    const orphan = 'tools/stale-dir/orphan.mjs';
    writeFixtureFile(home, orphan);
    const locked = join(home, 'tools/stale-dir');
    const mode = lstatSync(locked).mode;
    try {
      chmodSync(locked, 0o555);
      const result = spawnSync(process.execPath, [
        INSTALLER, '--dir', home, '--no-launchers', '--no-engine', '--no-memory', '--no-bridges',
      ], { encoding: 'utf8' });
      assert.equal(result.error, undefined);
      assert.equal(typeof result.status, 'number');
      assert.notEqual(result.status, 0, result.stdout);
      const verb = /^\[agent-workflow-kit\] (installed|updated the kit to|refreshed the already-current kit|downgraded the kit to)/m;
      assert.doesNotMatch(result.stdout, verb);
      const lines = result.stdout.split(String.fromCharCode(10));
      const failureIndex = lines.findIndex((line) => line.includes('did not converge'));
      const launcherIndex = lines.findIndex((line) => line.includes('--no-launchers: skipped'));
      assert.ok(failureIndex >= 0, result.stdout);
      assert.ok(launcherIndex > failureIndex, result.stdout);
      assertUntouched(home, orphan);
    } finally {
      chmodSync(locked, mode);
    }
  });
});

it('spec:upgrade-delivery/S16 installer imports and calls the prune after copying', () => {
  const source = readFileSync(INSTALLER, 'utf8');
  assert.ok(!source.includes('RETIRED_PATHS'));
  assert.match(source, /import\s*\{[^}]*\bprunePayload\b[^}]*\}\s*from\s*['"]\.\.\/tools\/payload-prune\.mjs['"]/);
  const copyIndex = source.indexOf('copyTreeRefresh(resolve(PKG_ROOT');
  const pruneIndex = source.indexOf('prunePayload(');
  assert.ok(copyIndex >= 0);
  assert.ok(pruneIndex > copyIndex);
});

describe('the kit installer recovery command (S21)', () => {
  for (const route of ['--dir', 'env', 'default']) {
    it(`quotes the resolved home for ${route}`, PERMISSION_CASE, () => {
      const base = mkdtempSync(join(state.root, 'recovery-'));
      const home = route === 'default' ? join(base, '.claude/skills/agent-workflow-kit') : join(base, "kit home's");
      writeFixtureFile(home, 'SKILL.md', KIT_SKILL);
      writeFixtureFile(home, 'tools/stale-dir/orphan.mjs');
      const locked = join(home, 'tools/stale-dir');
      const mode = lstatSync(locked).mode;
      const env = { ...process.env };
      delete env.AGENT_WORKFLOW_KIT_DIR;
      if (route === 'env') env.AGENT_WORKFLOW_KIT_DIR = home;
      if (route === 'default') env.HOME = base;
      try {
        chmodSync(locked, 0o555);
        const result = spawnSync(process.execPath, [
          INSTALLER, ...(route === '--dir' ? ['--dir', home] : []),
          '--no-launchers', '--no-engine', '--no-memory', '--no-bridges',
        ], { encoding: 'utf8', env });
        assert.equal(result.error, undefined);
        assert.equal(typeof result.status, 'number');
        assert.equal(result.status, 1, result.stderr);
        const line = result.stdout.split(LF).find((entry) => entry.includes('did not converge'));
        assert.equal(typeof line, 'string', result.stdout);
        if (route === 'default') {
          assert.equal(line, '[agent-workflow-kit] the kit home did not converge to the package (see the lines above) — fix them, then re-run npx @sabaiway/agent-workflow-kit@latest init');
        } else {
          const command = line.split(' re-run ')[1];
          assert.equal(typeof command, 'string', line);
          const stub = spawnSync('bash', ['-c', `npx() { printf '%s\\n' "$@"; }; ${command}`], { encoding: 'utf8' });
          assert.equal(stub.error, undefined);
          assert.equal(typeof stub.status, 'number');
          assert.equal(stub.status, 0, stub.stderr);
          assert.deepEqual(stub.stdout.trimEnd().split(LF), ['@sabaiway/agent-workflow-kit@latest', 'init', '--dir', resolve(home)]);
        }
      } finally {
        chmodSync(locked, mode);
      }
    });
  }
});
