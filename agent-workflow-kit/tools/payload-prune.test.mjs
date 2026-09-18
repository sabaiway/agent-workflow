import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertContainedRealPath } from './fs-safe.mjs';
import { lstatNoFollowRead } from './fs-read-nofollow.mjs';

const loaded = await import('./payload-prune.mjs').catch(() => ({}));
const prunePayload = loaded.prunePayload ?? (() => {
  throw new Error('payload-prune.mjs is absent');
});
const readHomeOwner = loaded.readHomeOwner ?? (() => {
  throw new Error('readHomeOwner is absent');
});
const assertInstallableHome = loaded.assertInstallableHome ?? (() => {
  throw new Error('assertInstallableHome is absent');
});
const LF = String.fromCharCode(10);
const KIT_SKILL = ['---', 'name: agent-workflow-kit', '---', ''].join(LF);
const CRLF_SKILL = KIT_SKILL.replace('kit', 'kit  ').split(LF).join(String.fromCharCode(13, 10));
const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLER = resolve(HERE, '..', 'bin', 'install.mjs');
const PAYLOAD = ['SKILL.md', 'references', 'tools', 'migrations', 'launchers'];
const PACKAGE_FILES = [
  'SKILL.md', 'references/a.md', 'references/sub/b.md',
  'tools/x.mjs', 'tools/deep/y/z.mjs', 'migrations/README.md',
];
const ORPHANS = [
  'references/planning.md', 'tools/methodology-slot.md',
  'tools/deep/y/old.mjs', 'references/gone/deeper/c.md',
];
const ORPHAN_A = 'references/a-orphan.md';
const ORPHAN_B = 'tools/b-orphan.mjs';
const PERMISSION_CASE = { skip: process.getuid?.() === 0 };
const state = { root: null };

before(() => {
  state.root = mkdtempSync(join(tmpdir(), 'payload-prune-'));
});
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
  if (ok) {
    assert.equal(result.nonConvergence, null);
  } else {
    assert.equal(typeof result.nonConvergence, 'string');
    assert.ok(result.nonConvergence.includes('did not converge'));
  }
};
const assertUntouched = (root, path) => assert.equal(readFileSync(join(root, path), 'utf8'), path);
const assertPackageFiles = ({ home }) => PACKAGE_FILES.forEach((path) => assertUntouched(home, path));
const assertNoRemoval = (result) => assert.ok(result.lines.every((line) => !hasToken(line, 'removed')));

describe('spec:upgrade-delivery/S12 orphan removal at every depth', () => {
  const ownerCases = [
    ['absent home', (home) => rmSync(home, { recursive: true }), 'absent'],
    ['kit name', (home) => writeFixtureFile(home, 'SKILL.md', KIT_SKILL), 'kit'],
    ['CRLF and trailing spaces', (home) => writeFixtureFile(home, 'SKILL.md', CRLF_SKILL), 'kit'],
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
      prepare(home);
      assert.equal(readHomeOwner(home), expected);
    });
  }

  it('classifies a home that is a regular file as other', () => {
    const home = join(state.root, 'owner-file');
    writeFileSync(home, KIT_SKILL);
    assert.equal(readHomeOwner(home), 'other');
  });
  it('admits absent, empty and kit homes and refuses a foreign home', () => {
    const home = mkdtempSync(join(state.root, 'admission-'));
    assert.equal(assertInstallableHome(join(home, 'absent')), 'absent');
    assert.equal(assertInstallableHome(home), 'empty');
    writeFixtureFile(home, 'SKILL.md', KIT_SKILL);
    assert.equal(assertInstallableHome(home), 'kit');
    const foreign = mkdtempSync(join(state.root, 'foreign-'));
    writeFixtureFile(foreign, 'notes.md');
    assert.throws(() => assertInstallableHome(foreign), (error) => error instanceof Error && error.message.includes(`refusing to install into ${foreign}`));
  });
  it('refuses an existing folder that is not a kit home on every run', () => {
    const home = mkdtempSync(join(state.root, 'unproven-'));
    const paths = ['tools/build.sh', 'migrations/0001_init.sql'];
    paths.forEach((path) => writeFixtureFile(home, path));
    for (const run of [1, 2]) {
      const result = spawnSync(process.execPath, [
        INSTALLER, '--dir', home, '--no-launchers', '--no-engine', '--no-memory', '--no-bridges',
      ], { encoding: 'utf8' });
      assert.equal(result.error, undefined, `run ${run}`);
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.stderr.includes('refusing to install into '));
      paths.forEach((path) => assertUntouched(home, path));
      assert.equal(existsSync(join(home, 'SKILL.md')), false);
      assertNoRemoval({ lines: result.stdout.split(LF) });
    }
  });
  it('removes all four orphans and preserves the carried files and emptied directories', async () => {
    const fixture = createFixture();
    ORPHANS.forEach((path) => writeFixtureFile(fixture.home, path));
    const result = await prunePayload(fixture);
    assertResult(result, true);
    assert.ok(result.lines.filter((line) => hasToken(line, 'removed')).every((line) => line.endsWith('(not in the package)')));
    for (const path of ORPHANS) {
      assert.equal(existsSync(join(fixture.home, path)), false);
      assertReport(result, 'removed', path);
    }
    assertPackageFiles(fixture);
    assert.ok(lstatSync(join(fixture.home, 'references/gone')).isDirectory());
    assertReport(result, 'kept', 'references/gone');
  });
  it('reports nothing for an unmodified copy', async () => {
    const fixture = createFixture();
    const result = await prunePayload(fixture);
    assertResult(result, true);
    assert.deepEqual(result.lines, []);
    assertPackageFiles(fixture);
  });
  it('removes nothing on a second run', async () => {
    const fixture = createFixture();
    ORPHANS.forEach((path) => writeFixtureFile(fixture.home, path));
    assertResult(await prunePayload(fixture), true);
    const result = await prunePayload(fixture);
    assertResult(result, true);
    assertNoRemoval(result);
    assertPackageFiles(fixture);
  });
});

describe('spec:upgrade-delivery/S13 preserved objects and payload boundaries', () => {
  it('keeps and reports an empty uncarried directory', async () => {
    const fixture = createFixture();
    mkdirSync(join(fixture.home, 'tools/userdir'));
    const result = await prunePayload(fixture);
    assertResult(result, true);
    assert.ok(lstatSync(join(fixture.home, 'tools/userdir')).isDirectory());
    assertReport(result, 'kept', 'tools/userdir');
  });
  it('keeps a symlink without touching its outside target', async () => {
    const fixture = createFixture();
    const outside = mkdtempSync(join(state.root, 'outside-'));
    writeFixtureFile(outside, 'secret.txt');
    const link = join(fixture.home, 'tools/link');
    symlinkSync(outside, link);
    const result = await prunePayload(fixture);
    assertResult(result, true);
    assertReport(result, 'kept', 'tools/link');
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), outside);
    assertUntouched(outside, 'secret.txt');
  });
  it('does not report or change files beside the payload roots', async () => {
    const fixture = createFixture();
    const paths = ['runtime.json', '.cache/x'];
    paths.forEach((path) => writeFixtureFile(fixture.home, path));
    const result = await prunePayload(fixture);
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
    const result = await prunePayload(fixture);
    assertResult(result, true);
    assert.equal(existsSync(join(fixture.home, path)), false);
    assertReport(result, 'removed', path);
  });
});

describe('spec:upgrade-delivery/S14 partial packages and enumeration failures', () => {
  it('leaves the home untouched and reports nothing when the package root is absent', async () => {
    const fixture = createFixture();
    const packageRoot = join(dirname(fixture.packageRoot), 'absent-package');
    const path = 'references/orphan.md';
    writeFixtureFile(fixture.home, path);
    const result = await prunePayload({ ...fixture, packageRoot });
    assertResult(result, true);
    assert.deepEqual(result.lines, []);
    assertUntouched(fixture.home, path);
  });
  it('reports failure without removing the orphan when the package root is a regular file', async () => {
    const fixture = createFixture();
    const packageRoot = writeFixtureFile(dirname(fixture.packageRoot), 'package-file');
    const path = 'references/orphan.md';
    writeFixtureFile(fixture.home, path);
    const result = await prunePayload({ ...fixture, packageRoot });
    assertResult(result, false);
    assert.ok(result.lines.length > 0);
    assert.ok(result.lines.every((line) => hasToken(line, 'failed')));
    assertUntouched(fixture.home, path);
  });
  it('leaves a subtree absent from the package untouched and unreported', async () => {
    const fixture = createFixture();
    const path = 'launchers/old.sh';
    writeFixtureFile(fixture.home, path);
    const result = await prunePayload(fixture);
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
    const result = await prunePayload(fixture);
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
        const result = await prunePayload(fixture);
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
      if (kind === 'file') {
        writeFixtureFile(fixture.home, path);
      } else {
        mkdirSync(join(fixture.home, path));
      }
      writeFixtureFile(fixture.home, 'references/orphan.md');
      const result = await prunePayload(fixture);
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

describe('spec:upgrade-delivery/S15 removal failures and installer exit', () => {
  const cells = [
    { name: 'unlink failure', primitive: 'unlinkSync', message: 'unlink boom' },
    { name: 'containment refusal', primitive: 'assertContainedRealPath', message: 'contained boom' },
    { name: 're-probe error', primitive: 'lstatNoFollowRead', message: 'probe boom' },
    { name: 'non-file re-probe', primitive: 'lstatNoFollowRead', value: { isFile: () => false } },
    { name: 'absent re-probe', primitive: 'lstatNoFollowRead', value: null },
  ];
  for (const cell of cells) {
    it(`continues to B after A's ${cell.name}`, async () => {
      const fixture = createFixture();
      const target = writeFixtureFile(fixture.home, ORPHAN_A);
      writeFixtureFile(fixture.home, ORPHAN_B);
      const unlinkCalls = [];
      const primitives = {
        assertContainedRealPath,
        lstatNoFollowRead,
        unlinkSync: (path) => {
          unlinkCalls.push(path);
          return unlinkSync(path);
        },
      };
      const deps = {
        ...primitives,
        [cell.primitive]: (...args) => {
          const path = cell.primitive === 'assertContainedRealPath' ? args[1] : args[0];
          if (path !== target) {
            return primitives[cell.primitive](...args);
          }
          if (cell.message) {
            throw new Error(cell.message);
          }
          return cell.value;
        },
      };
      const result = await prunePayload(fixture, deps);
      const ok = cell.value === null;
      assertResult(result, ok);
      assertUntouched(fixture.home, ORPHAN_A);
      assert.equal(existsSync(join(fixture.home, ORPHAN_B)), false);
      assertReport(result, 'removed', ORPHAN_B);
      assert.ok(unlinkCalls.includes(join(fixture.home, ORPHAN_B)));
      if (!ok) {
        const line = assertReport(result, 'failed', ORPHAN_A);
        if (cell.message) {
          assert.ok(line.includes(cell.message));
        } else {
          const cause = line.replace(/^\[[^\]]+\]\s*/, '').replace(ORPHAN_A, '').replace(/\bfailed\b/, '');
          assert.match(cause, /[a-zA-Z]/);
        }
      }
      if (cell.primitive !== 'unlinkSync') {
        assert.ok(!unlinkCalls.includes(target));
      }
      assertPackageFiles(fixture);
    });
  }
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
