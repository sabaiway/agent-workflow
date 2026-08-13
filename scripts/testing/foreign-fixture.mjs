// foreign-fixture.mjs — a FOREIGN project on disk: a tracked tree dominated by TypeScript, a `test`
// script no producer grammar can express, and whatever gate declaration the caller hands it.
//
// Why a BUILDER and not a checked-in tree (D7): the census reads TRACKED files, and a nested
// checked-in repo cannot be tracked by the repo containing it — a fixture committed under this tree
// would be invisible to `git ls-files` run inside itself, so every dominance assertion would read
// zero. The builder therefore creates a real temp repo, writes the sources, and stages them; the
// index is what `git ls-files` lists, so no commit (and no git identity) is needed.
//
// Why it lives HERE and not beside the suites that use it: Node's coverage excludes everything under
// a `test/` directory, loaded or not — so a fixture module placed there could never be covered, and
// the changed-line checker would red on it forever. Under `scripts/` it is an ordinary audited
// module, which is also the right shape for its second consumer: the pre-publish candidate smoke is
// a release-lane script, not a test.
//
// This module imports NO `node:test`: the advisor/census suites use it, and so does that smoke run,
// which happens outside any test runner. It returns a `teardown` the caller registers (an `after`
// hook in a suite, a `finally` in a script) so temp trees never accumulate.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXPECTED_WORKFLOW_VERSION } from '../../agent-workflow-kit/tools/velocity-profile.mjs';

// A runner the closed producer world CANNOT express — that is the whole point of the fixture. It
// must not be a `node --test` form, or the project would have a producer the kit can recognize and
// the third outcomes it exists to exercise would never fire.
export const FOREIGN_TEST_SCRIPT = 'vitest run --coverage';

const git = (cwd, args, spawn) => {
  const r = spawn('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr ?? r.error?.message}`);
};

// buildForeignFixture(options) → { root, teardown, census: { assessable, unsupported } }.
//
// The two counts are RETURNED, not merely produced, because every dominance assertion is arithmetic
// about them: the census verdict fires on STRICT dominance, so `tsFiles > jsFiles` is the narrow
// tree, `tsFiles === jsFiles` is the tie that must stay silent, and `jsFiles > tsFiles` is the
// ordinary JS project whose existing arms must stay byte-unchanged. A caller asserting on a number
// it did not choose is a fixture bug waiting to be read as a product bug.
//
// Everything else the builder writes is `out-of-domain` by classification (package.json, the
// deployment stamp, gates.json), so it can never move a dominance edge.
//
// A failure ANYWHERE after mkdtemp tears the tree down before rethrowing: a builder that leaves a
// temp repo behind on the one path nobody watches is how a suite starts filling a disk.
export const buildForeignFixture = ({
  gates,
  tsFiles = 3,
  jsFiles = 0,
  testScript = FOREIGN_TEST_SCRIPT,
  extraFiles = {},
  prefix = 'aw-foreign-',
  spawn = spawnSync,
} = {}) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const teardown = () => rmSync(root, { recursive: true, force: true });
  try {
    git(root, ['init', '-q', '-b', 'main'], spawn);
    const srcDir = join(root, 'packages', 'app', 'src');
    mkdirSync(srcDir, { recursive: true });
    for (let i = 0; i < tsFiles; i += 1) {
      writeFileSync(join(srcDir, `mod${i}.ts`), `export const mod${i} = (): number => ${i};\n`);
    }
    for (let i = 0; i < jsFiles; i += 1) {
      writeFileSync(join(srcDir, `mod${i}.mjs`), `export const mod${i} = () => ${i};\n`);
    }
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), `${EXPECTED_WORKFLOW_VERSION}\n`);
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'foreign-fixture', private: true, scripts: { test: testScript } }, null, 2)}\n`,
    );
    // `gates` is the ENTRY ARRAY, not the whole file: the declaration's envelope is the schema's
    // business, and a caller repeating `{ gates: [...] }` at every site is one typo away from a
    // fixture that tests the validator's rejection path instead of the arm it meant to reach.
    if (gates !== undefined) {
      writeFileSync(join(root, 'docs', 'ai', 'gates.json'), `${JSON.stringify({ gates }, null, 2)}\n`);
    }
    for (const [rel, body] of Object.entries(extraFiles)) {
      const abs = join(root, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, body);
    }
    git(root, ['add', '-A'], spawn);
  } catch (err) {
    teardown();
    throw err;
  }
  return { root, teardown, census: { assessable: jsFiles, unsupported: tsFiles } };
};

// The advisor reads the HOST as well as the project — a placed bridge wrapper, a real HOME, the
// caller's PATH all reach probes this fixture says nothing about. These deps keep every OTHER item
// off the report so an assertion about one item is an assertion about one item.
export const hermeticAdvisorDeps = (root) => ({
  findWrapper: () => false,
  env: { PATH: '/nonexistent-path-for-tests' },
  getenv: { PATH: '/nonexistent-path-for-tests' },
  home: root,
});
