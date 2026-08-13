// foreign-fixture.test.mjs — the foreign-project builder the advisor/census acceptance and the
// pre-publish candidate smoke both build their trees with.
//
// A fixture builder earns tests for one reason: every assertion made through it is only as true as
// the tree it actually wrote. A builder that silently staged nothing would make a census read zero
// and turn a REAL false-green regression into a green suite — the exact failure the fixture exists
// to catch, hidden by the fixture itself.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { buildForeignFixture, hermeticAdvisorDeps, FOREIGN_TEST_SCRIPT } from './foreign-fixture.mjs';

const teardowns = [];
after(() => { for (const t of teardowns) t(); });
const build = (options) => {
  const built = buildForeignFixture(options);
  teardowns.push(built.teardown);
  return built;
};
const tracked = (root) => {
  const r = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean);
};

describe('foreign-fixture — the tree it claims to have built is the tree on disk', () => {
  it('stages a TS-dominated tracked tree, a non-node--test script, and the returned counts match it', () => {
    const { root, census } = build({ tsFiles: 3, jsFiles: 1 });
    const files = tracked(root);
    assert.deepEqual(census, { assessable: 1, unsupported: 3 }, 'the counts a caller asserts on are the ones it asked for');
    assert.equal(files.filter((f) => f.endsWith('.ts')).length, 3);
    assert.equal(files.filter((f) => f.endsWith('.mjs')).length, 1);
    // STAGED, not merely written: `git ls-files` reads the INDEX, so an unstaged tree censuses as
    // empty and every dominance assertion built on it would be vacuous.
    assert.ok(files.includes('packages/app/src/mod0.ts'), `the sources are tracked: ${files.join(', ')}`);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.test, FOREIGN_TEST_SCRIPT);
    assert.doesNotMatch(pkg.scripts.test, /node --test/, 'a recognizable producer would defeat the fixture');
  });

  it('writes a gate declaration only when asked, and wraps the ENTRY ARRAY in the envelope', () => {
    const bare = build({ tsFiles: 1 });
    assert.equal(existsSync(join(bare.root, 'docs', 'ai', 'gates.json')), false, 'an undeclared project is a real state');
    const declared = build({ tsFiles: 1, gates: [{ id: 'suite', title: 'S', cmd: 'vitest run' }] });
    const parsed = JSON.parse(readFileSync(join(declared.root, 'docs', 'ai', 'gates.json'), 'utf8'));
    assert.deepEqual(parsed.gates.map((g) => g.id), ['suite'], 'the caller passes entries; the envelope is the builder\'s');
  });

  it('extraFiles land at their relative paths, creating parents, and are tracked too', () => {
    const { root } = build({ tsFiles: 1, extraFiles: { '.claude/hooks/h.mjs': '// placed\n' } });
    assert.equal(readFileSync(join(root, '.claude', 'hooks', 'h.mjs'), 'utf8'), '// placed\n');
    assert.ok(tracked(root).includes('.claude/hooks/h.mjs'));
  });

  it('a failure AFTER mkdtemp tears the tree down before rethrowing — no orphan temp repo', () => {
    // The one path nobody watches. Injected through the spawn seam so the failure is deterministic
    // rather than a real broken git.
    let created = null;
    assert.throws(
      () => buildForeignFixture({
        prefix: 'aw-foreign-fail-',
        spawn: (cmd, args, opts) => {
          created = opts.cwd;
          return { status: 1, stderr: 'injected git failure' };
        },
      }),
      /git init .* failed .*injected git failure/,
    );
    assert.ok(created, 'the builder really got as far as creating the tree');
    assert.equal(existsSync(created), false, 'and removed it on the way out');
  });

  it('hermeticAdvisorDeps keeps the HOST out — no placed wrappers, no real PATH, a fixture home', () => {
    const { root } = build({ tsFiles: 1 });
    const deps = hermeticAdvisorDeps(root);
    assert.equal(deps.findWrapper(), false, 'no bridge wrapper is ever "placed" for these runs');
    assert.equal(deps.home, root, 'and HOME is the fixture, so no machine-local config leaks in');
    assert.doesNotMatch(deps.env.PATH, /:/, 'a single nonexistent entry, never the caller\'s PATH');
  });
});
