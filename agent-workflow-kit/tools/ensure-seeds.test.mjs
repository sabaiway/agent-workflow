// ensure-seeds.test.mjs — the two SEED-if-missing ensures, gates.json and autonomy.json, and the
// Node-evidence refusal the kit-script ensure opens with. The orchestration ensure (the only one that
// also REFRESHES) and the closed-vocabulary door live in ensure-ops.test.mjs; the split keeps each file
// inside the declared source-size cap.
//
// What these guard: a seed never clobbers, `already-present` means a REGULAR FILE really is there,
// and every failure states its cause.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureAutonomy, ensureGates } from './ensure-ops.mjs';
import { GATES_REL } from './gates-declaration.mjs';
import { AUTONOMY_REL } from './autonomy-config.mjs';

const { ensureScripts } = await import('./distribution-files/index.mjs').catch(() => ({}));
const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// A deployed Node project: docs/ai present (the ensures' precondition) and a package.json.
const withProject = (fn, { node = true } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'ensure-seeds-'));
  try {
    mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
    if (node) writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('gates + autonomy ensures — seed-if-missing, existing files untouched', () => {
  for (const [label, run, rel] of [
    ['gates', ensureGates, GATES_REL],
    ['autonomy', ensureAutonomy, AUTONOMY_REL],
  ]) {
    it(`${label}: seeds from the bundled template, then preserves what it seeded`, () => {
      withProject((dir) => {
        const r = run({ cwd: dir, kitRoot: KIT_ROOT, deps: {} });
        assert.equal(r.token, 'seeded');
        const seeded = readFileSync(join(dir, rel), 'utf8');
        assert.equal(seeded, readFileSync(join(KIT_ROOT, 'references', 'templates', rel.split('/').pop()), 'utf8'));
        const again = run({ cwd: dir, kitRoot: KIT_ROOT, deps: {} });
        assert.equal(again.token, 'already-present');
        assert.equal(readFileSync(join(dir, rel), 'utf8'), seeded);
      });
    });

    it(`${label}: an AUTHORED file is preserved byte-for-byte (never refreshed in place)`, () => {
      withProject((dir) => {
        const authored = '{"_README":"mine","gates":[{"id":"x","title":"X","cmd":"true"}]}\n';
        writeFileSync(join(dir, rel), authored);
        const r = run({ cwd: dir, kitRoot: KIT_ROOT, deps: {} });
        assert.equal(r.token, 'already-present');
        assert.equal(readFileSync(join(dir, rel), 'utf8'), authored);
      });
    });

    it(`${label}: --dry-run writes nothing`, () => {
      withProject((dir) => {
        const r = run({ cwd: dir, kitRoot: KIT_ROOT, dryRun: true, deps: {} });
        assert.equal(r.token, 'would-seed');
        assert.equal(existsSync(join(dir, rel)), false);
      });
    });

    it(`${label}: an unreadable bundled template fails loudly and writes nothing`, () => {
      withProject((dir) => {
        const deps = {
          readFile: (p, enc) => {
            if (p.startsWith(join(KIT_ROOT, 'references', 'templates'))) throw new Error('EACCES: bundle unreadable');
            return readFileSync(p, enc);
          },
        };
        const r = run({ cwd: dir, kitRoot: KIT_ROOT, deps });
        assert.equal(r.token, 'failed');
        assert.match(r.lines[0], /^template-unreadable — /);
        assert.equal(r.failed, true);
        assert.equal(existsSync(join(dir, rel)), false);
      });
    });

    // `already-present` has to mean a FILE is there: an lstat that merely finds SOMETHING would let a
    // directory named gates.json report a green ensure over a declaration that does not exist.
    it(`${label}: a DIRECTORY where the file belongs fails loudly — never "already present"`, () => {
      withProject((dir) => {
        mkdirSync(join(dir, rel), { recursive: true });
        const r = run({ cwd: dir, kitRoot: KIT_ROOT, deps: {} });
        assert.equal(r.token, 'failed');
        assert.match(r.lines[0], /^wrong-node-kind — .*a directory/);
        assert.equal(r.failed, true);
      });
    });

    it(`${label}: a SYMLINK where the file belongs fails loudly too`, () => {
      withProject((dir) => {
        writeFileSync(join(dir, 'elsewhere.json'), '{}\n');
        symlinkSync(join(dir, 'elsewhere.json'), join(dir, rel));
        const r = run({ cwd: dir, kitRoot: KIT_ROOT, deps: {} });
        assert.equal(r.token, 'failed');
        assert.match(r.lines[0], /^wrong-node-kind — .*a symlink/);
      });
    });
  }
});

describe('spec:node-evidence/S6 the scripts ensure proceeds on a deployed script, skips with the new token on none, fails closed on unreadable', () => {
  const run = (dir, deps = {}) => ensureScripts?.({ cwd: dir, kitRoot: KIT_ROOT, deps });
  it('no Node evidence: skipped-no-node-evidence naming every probe, nothing written', () => withProject((dir) => {
    const r = run(dir);
    assert.deepEqual([r?.token, r?.failed, existsSync(join(dir, 'scripts'))], ['skipped-no-node-evidence', false, false]);
    assert.match(r.lines.join('\n'), /probed package\.json and the kit-seeded scripts\/ files \(archive-caps\.mjs, .*spec-schema\.mjs\), no regular file present/);
  }, { node: false }));
  it('a deployed kit script without a package.json is Node evidence: the op places every other kit script, token seeded, no entries field', async () => {
    // The kit folder's family: the manifest's deployed entries less the spec layer's modules, at their deployed paths.
    const { DEPLOYED_SCRIPTS } = await import('./node-evidence.mjs');
    const family = DEPLOYED_SCRIPTS.filter((e) => e.module !== 'spec-schema' && e.module !== 'docs-size');
    const caps = family.find((e) => e.path === 'archives/archive-caps.mjs');
    withProject((dir) => {
      mkdirSync(dirname(join(dir, caps.deployed)), { recursive: true });
      writeFileSync(join(dir, caps.deployed), readFileSync(join(KIT_ROOT, caps.bundled)));
      const r = run(dir), at = (e) => join(dir, e.deployed);
      assert.deepEqual([r?.token, r?.failed, 'entries' in (r ?? {}), family.filter((e) => !existsSync(at(e)) || !readFileSync(at(e)).equals(readFileSync(join(KIT_ROOT, e.bundled)))).map((e) => e.path)], ['seeded', false, false, []], r?.lines?.join('\n'));
    }, { node: false });
  });
  it('an unreadable Node probe fails closed: node-evidence-unverifiable, nothing written', () => withProject((dir) => {
    const r = run(dir, { lstat: (p) => { if (p.endsWith('package.json')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return lstatSync(p); } });
    assert.match(r?.lines?.[0] ?? '', /^node-evidence-unverifiable — scripts\/: whether Node runs here could not be read \(EACCES on package\.json\)/);
    assert.deepEqual([r.token, existsSync(join(dir, 'scripts'))], ['failed', false]);
  }, { node: false }));
});
