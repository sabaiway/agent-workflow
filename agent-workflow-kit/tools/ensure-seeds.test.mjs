// ensure-seeds.test.mjs — the three SEED-if-missing ensures: gates.json, autonomy.json, and the
// enforcement-script pairs. The orchestration ensure (the only one that also REFRESHES) and the
// closed-vocabulary door live in ensure-ops.test.mjs; the split keeps each file inside the declared
// source-size cap.
//
// What these guard: a seed never clobbers, `already-present` means a REGULAR FILE really is there,
// and every failure states what it had already written — a per-file loop can stop partway.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureAutonomy, ensureGates, ensureScripts, SEED_SCRIPTS } from './ensure-ops.mjs';
import { GATES_REL } from './gates-declaration.mjs';
import { AUTONOMY_REL } from './autonomy-config.mjs';

const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// A deployed Node project: docs/ai present (the ensures' precondition) and a package.json, so the
// enforcement-script arm is in scope unless a test removes it.
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

const readIf = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

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

describe('enforcement-script ensure — ADR layout FIRST, then seed-if-missing', () => {
  const scriptPath = (dir, name) => join(dir, 'scripts', name);

  it('seeds all four pairs on a clean layout, and preserves them on the re-run', () => {
    withProject((dir) => {
      const r = ensureScripts({ cwd: dir, kitRoot: KIT_ROOT, deps: {} });
      assert.equal(r.token, 'seeded');
      for (const name of SEED_SCRIPTS) {
        assert.equal(
          readFileSync(scriptPath(dir, name), 'utf8'),
          readFileSync(join(KIT_ROOT, 'references', 'scripts', name), 'utf8'),
          `${name} is the bundled copy`,
        );
      }
      const mine = '// my own archiver\n';
      writeFileSync(scriptPath(dir, SEED_SCRIPTS[0]), mine);
      const again = ensureScripts({ cwd: dir, kitRoot: KIT_ROOT, deps: {} });
      assert.equal(again.token, 'already-present');
      assert.equal(readFileSync(scriptPath(dir, SEED_SCRIPTS[0]), 'utf8'), mine, 'an existing script is never overwritten');
    });
  });

  it('an OLD ADR-store layout is INSTRUCTED, never seeded', () => {
    withProject((dir) => {
      mkdirSync(join(dir, 'docs', 'ai', 'history'), { recursive: true });
      writeFileSync(join(dir, 'docs', 'ai', 'history', 'decisions-archive.md'), '# archive\n');
      const r = ensureScripts({ cwd: dir, kitRoot: KIT_ROOT, deps: {} });
      assert.equal(r.token, 'old-adr-layout-migration-instructed');
      assert.equal(r.failed, false, 'an instructed migration is a stated outcome, not a failure');
      assert.match(r.lines.join('\n'), /migrate-adr-store/);
      assert.equal(existsSync(join(dir, 'scripts')), false, 'nothing was written');
    });
  });

  it('an UNREADABLE ADR layout fails closed — no script writes on a read error', () => {
    withProject((dir) => {
      const deps = { statPath: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } };
      const r = ensureScripts({ cwd: dir, kitRoot: KIT_ROOT, deps });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^adr-layout-unverifiable — /);
      assert.equal(r.failed, true);
      assert.equal(existsSync(join(dir, 'scripts')), false);
    });
  });

  // spec:node-evidence/S6 — the skip names what it probed, a deployed kit script is evidence enough,
  // and a probe that cannot be read writes nothing.
  it('a project with NO Node evidence is a stated skip naming every probe', () => {
    withProject((dir) => {
      const r = ensureScripts({ cwd: dir, kitRoot: KIT_ROOT, deps: {} });
      assert.equal(r.token, 'skipped-no-node-evidence');
      assert.equal(r.failed, false);
      assert.equal(existsSync(join(dir, 'scripts')), false);
      assert.match(r.lines.join('\n'), /probed package\.json and the kit-seeded scripts\/ files \(archive-caps\.mjs, .*spec-schema\.mjs\), no regular file present/);
    }, { node: false });
  });

  it('a deployed kit script WITHOUT a package.json is Node evidence — the pairs seed', () => {
    withProject((dir) => {
      mkdirSync(join(dir, 'scripts'));
      writeFileSync(scriptPath(dir, 'check-docs-size.mjs'), '// deployed by a bootstrap\n');
      const r = ensureScripts({ cwd: dir, kitRoot: KIT_ROOT, deps: {} });
      assert.equal(r.token, 'seeded', r.lines.join('\n'));
      for (const name of SEED_SCRIPTS) assert.equal(existsSync(scriptPath(dir, name)), true, `${name} landed`);
    }, { node: false });
  });

  it('an UNREADABLE Node probe fails closed — nothing is written', () => {
    withProject((dir) => {
      const deps = { lstat: (p) => { if (p.endsWith('package.json')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return lstatSync(p); } };
      const r = ensureScripts({ cwd: dir, kitRoot: KIT_ROOT, deps });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^node-evidence-unverifiable — scripts\/: whether Node runs here could not be read \(EACCES on package\.json\)/);
      assert.equal(existsSync(join(dir, 'scripts')), false);
    }, { node: false });
  });

  it('--dry-run names what it would copy and copies nothing', () => {
    withProject((dir) => {
      const r = ensureScripts({ cwd: dir, kitRoot: KIT_ROOT, dryRun: true, deps: {} });
      assert.equal(r.token, 'would-seed');
      assert.equal(existsSync(join(dir, 'scripts')), false);
      assert.equal(r.lines.length, SEED_SCRIPTS.length);
    });
  });

  it('an unreadable bundled script stops that op with the files it already named', () => {
    withProject((dir) => {
      const deps = {
        readFile: (p, enc) => {
          if (p.startsWith(join(KIT_ROOT, 'references', 'scripts'))) throw new Error('EACCES: bundle unreadable');
          return readFileSync(p, enc);
        },
      };
      const r = ensureScripts({ cwd: dir, kitRoot: KIT_ROOT, deps });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^bundle-unreadable — /);
      assert.equal(r.failed, true);
      assert.equal(readIf(scriptPath(dir, SEED_SCRIPTS[0])), null);
    });
  });

  it('a DIRECTORY where a seeded script belongs fails loudly, naming the kind', () => {
    withProject((dir) => {
      mkdirSync(join(dir, 'scripts', SEED_SCRIPTS[0]), { recursive: true });
      const r = ensureScripts({ cwd: dir, kitRoot: KIT_ROOT, deps: {} });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^wrong-node-kind — .*a directory/);
    });
  });

  // A WRITE that is refused mid-loop must not take the accumulated lines with it: the run has to say
  // which files it had already copied.
  it('a write refused after the first copy keeps the lines it had, and says it stopped partway', () => {
    withProject((dir) => {
      let writes = 0;
      const deps = {
        link: (from, to) => {
          if (writes++ === 0) return linkSync(from, to);
          throw Object.assign(new Error('EPERM: refused'), { code: 'EPERM' });
        },
      };
      const r = ensureScripts({ cwd: dir, kitRoot: KIT_ROOT, deps });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^write-refused — /);
      assert.equal(existsSync(scriptPath(dir, SEED_SCRIPTS[0])), true, 'the first copy really landed');
      assert.match(r.lines.join('\n'), /stopped PARTWAY — the 1 file\(s\) named above were already copied/);
    });
  });

  // A per-file loop that fails PARTWAY has already written files. The op says so, so nobody reads
  // "failed" as "nothing happened".
  it('a bundle read that fails after the first copy names what already landed', () => {
    withProject((dir) => {
      const deps = {
        readFile: (p, enc) => {
          if (p.endsWith(SEED_SCRIPTS[1])) throw new Error('EACCES: bundle unreadable');
          return readFileSync(p, enc);
        },
      };
      const r = ensureScripts({ cwd: dir, kitRoot: KIT_ROOT, deps });
      assert.equal(r.token, 'failed');
      assert.equal(existsSync(scriptPath(dir, SEED_SCRIPTS[0])), true, 'the first copy really landed');
      assert.match(r.lines.join('\n'), /stopped PARTWAY — the 1 file\(s\) named above were already copied/);
    });
  });
});
