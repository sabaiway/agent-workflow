import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync,
  rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAMILY_DIRS } from '../release/version-sync.mjs';

const CENSUS_CLI = fileURLToPath(new URL('./package-census.mjs', import.meta.url));
const ONE_HOUR = 60 * 60 * 1000;
const CHILD_TIMEOUT = 10_000;
const EMPTY_DIFF = { added: [], removed: [], changed: [] };
const CHANGES = [
  ['added file', "fs.writeFileSync(path('added.txt'), 'new');",
    { added: ['added.txt'], changed: [''] }],
  ['removed file', "fs.unlinkSync(path('file.txt'));",
    { removed: ['file.txt'], changed: [''] }],
  ['changed file', "fs.writeFileSync(path('file.txt'), 'changed');", { changed: ['file.txt'] }],
  ['file turned into a directory', "fs.unlinkSync(path('file.txt')); fs.mkdirSync(path('file.txt'));",
    { changed: ['', 'file.txt'] }],
  ['mode change', "fs.chmodSync(path('file.txt'), 0o600);", { changed: ['file.txt'] }],
  ['same-content rewrite', "fs.writeFileSync(path('file.txt'), 'original');", { changed: ['file.txt'] }],
  ['ignored file', "fs.writeFileSync(path('ignored.txt'), 'ignored');",
    { added: ['ignored.txt'], changed: [''] }],
  ['file under node_modules', "fs.writeFileSync(path('node_modules/added.txt'), 'ignored');",
    { added: ['node_modules/added.txt'], changed: ['node_modules'] }],
  ['create then remove in an existing subdirectory',
    "fs.writeFileSync(path('nested/transient.txt'), 'temporary'); fs.unlinkSync(path('nested/transient.txt'));",
    { changed: ['nested'] }],
  ['create then remove directly in the package directory',
    "fs.writeFileSync(path('transient.txt'), 'temporary'); fs.unlinkSync(path('transient.txt'));",
    { changed: [''] }],
  ['new directory with a file',
    "fs.mkdirSync(path('new')); fs.writeFileSync(path('new/file.txt'), 'new');",
    { added: ['new', 'new/file.txt'], changed: [''] }],
];

const ageTree = (path, time) => {
  if (lstatSync(path).isSymbolicLink()) {
    lutimesSync(path, time, time);
    return;
  }
  if (lstatSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) ageTree(join(path, entry), time);
  }
  utimesSync(path, time, time);
};

const makeFixture = (context) => {
  const root = mkdtempSync(join(tmpdir(), 'aw-package-census-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of FAMILY_DIRS) {
    const packageRoot = join(root, directory);
    mkdirSync(join(packageRoot, 'nested'), { recursive: true });
    mkdirSync(join(packageRoot, 'node_modules'));
    writeFileSync(join(packageRoot, 'file.txt'), 'original');
    chmodSync(join(packageRoot, 'file.txt'), 0o644);
    writeFileSync(join(packageRoot, 'nested', 'file.txt'), 'nested');
    writeFileSync(join(packageRoot, 'node_modules', 'file.txt'), 'dependency');
    writeFileSync(join(packageRoot, '.gitignore'), 'ignored.txt\nnode_modules/\n');
    symlinkSync('file.txt', join(packageRoot, 'link'));
  }
  mkdirSync(join(root, '.test-repos'));
  mkdirSync(join(root, 'copy'));
  ageTree(root, new Date(Date.now() - ONE_HOUR));
  return root;
};

const buildCommand = (root, directory, script) => ['-e', `
  const fs = require('node:fs');
  const { join } = require('node:path');
  const root = process.argv[1];
  const packageRoot = join(root, process.argv[2]);
  const path = (relative) => join(packageRoot, relative);
  ${script}
`, root, directory];

const runNode = (args) => {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: CHILD_TIMEOUT });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
};

const runCensus = (root, directory, script) => runNode([
  CENSUS_CLI, '--root', root, '--', process.execPath, ...buildCommand(root, directory, script),
]);

const qualifyDiff = (directory, expected) => Object.fromEntries(
  Object.keys(EMPTY_DIFF).map((kind) => [kind, (expected[kind] ?? [])
    .map((path) => path ? `${directory}/${path}` : directory).sort()]),
);

describe('spec:fixture-isolation/S10 the package census names mutations and preserves command status', () => {
  it('compareCensus leaves an untouched tree empty', async (context) => {
    const { takeCensus, compareCensus } = await import('./package-census.mjs');
    const root = makeFixture(context);
    assert.deepEqual(compareCensus(takeCensus(root, FAMILY_DIRS), takeCensus(root, FAMILY_DIRS)), EMPTY_DIFF);
  });

  for (const [name, script, expected] of CHANGES) {
    it(`compareCensus classifies ${name}`, async (context) => {
      const { takeCensus, compareCensus } = await import('./package-census.mjs');
      for (const directory of FAMILY_DIRS) {
        const root = makeFixture(context);
        const before = takeCensus(root, FAMILY_DIRS);
        const command = runNode(buildCommand(root, directory, script));
        assert.equal(command.status, 0, command.stderr);
        assert.deepEqual(compareCensus(before, takeCensus(root, FAMILY_DIRS)), qualifyDiff(directory, expected));
      }
    });

    it(`CLI rejects and names ${name}`, (context) => {
      for (const directory of FAMILY_DIRS) {
        const root = makeFixture(context);
        const result = runCensus(root, directory, script);
        assert.equal(result.status, 1, result.stderr);
        for (const path of Object.values(qualifyDiff(directory, expected)).flat()) {
          assert.ok(result.stderr.includes(path), `stderr must name ${path}: ${result.stderr}`);
        }
      }
    });
  }

  for (const status of [0, 7]) {
    it(`CLI preserves unchanged command status ${status}`, (context) => {
      const root = makeFixture(context);
      const result = runCensus(root, FAMILY_DIRS[0], `process.exit(${status});`);
      assert.equal(result.status, status, result.stderr);
    });
  }

  it('CLI permits copying a package and writing and removing inside the copy', (context) => {
    const root = makeFixture(context);
    const result = runCensus(root, FAMILY_DIRS[0], `
      const copy = join(root, 'copy', 'package');
      fs.cpSync(packageRoot, copy, { recursive: true });
      fs.writeFileSync(join(copy, 'transient.txt'), 'temporary');
      fs.unlinkSync(join(copy, 'transient.txt'));
    `);
    assert.equal(result.status, 0, result.stderr);
  });

  it('main refuses bad arguments, names an absent package directory the command makes, and fails on a root that is a file', async (context) => {
    const { main } = await import('./package-census.mjs');
    const errors = context.mock.method(console, 'error', () => {});
    for (const argv of [[], ['x'], ['--'], ['--root', '--', 'true']]) assert.equal(main(argv), 2);
    const root = makeFixture(context);
    const absent = join(root, FAMILY_DIRS[0]);
    rmSync(absent, { recursive: true });
    assert.equal(main(['--root', root, '--', process.execPath, '-e', '']), 0);
    assert.equal(main(['--root', root, '--', process.execPath, '-e', `require('node:fs').mkdirSync(${JSON.stringify(absent)})`]), 1);
    assert.ok(errors.mock.calls.some((call) => call.arguments[0] === `package-census: added ${FAMILY_DIRS[0]}`));
    writeFileSync(join(root, 'not-a-directory'), 'file');
    assert.equal(main(['--root', join(root, 'not-a-directory'), '--', process.execPath, '-e', '']), 1);
    assert.match(errors.mock.calls.at(-1).arguments[0], /ENOTDIR/);
  });

  it('CLI permits writes under .test-repos', (context) => {
    const root = makeFixture(context);
    const result = runCensus(root, FAMILY_DIRS[0],
      "fs.writeFileSync(join(root, '.test-repos', 'fixture.txt'), 'fixture');");
    assert.equal(result.status, 0, result.stderr);
  });
});
