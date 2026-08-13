// ensure-ops.test.mjs — the closed outcome vocabulary and the ONE ensure that also REFRESHES
// (docs/ai/orchestration.json). The three seed-if-missing ensures live in ensure-seeds.test.mjs.
//
// What these guard: the ops now WRITE into a deployed project, so every claim they print has to be
// one the run proved. The seed is create-only, the refresh only touches a note the kit itself
// shipped, and every fail-closed arm must write NOTHING and say so out loud.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeFailure, composeOutcome, ensureOrchestration } from './ensure-ops.mjs';
import { CANON_README, CONFIG_REL, KNOWN_PRIOR_README } from './orchestration-config.mjs';

// A deployed project: docs/ai present (the ensures' precondition) and a package.json.
const withProject = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'ensure-ops-'));
  try {
    mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const configOf = (dir) => JSON.parse(readFileSync(join(dir, CONFIG_REL), 'utf8'));

// The vocabulary is closed at RUNTIME, not by convention. If that door ever stopped refusing, an op
// could print a word the mode doc never taught — the exact defect both review backends raised.
describe('the closed vocabulary refuses an unlisted word', () => {
  it('an outcome token outside the closed set throws', () => {
    assert.throws(() => composeOutcome('gates', 'invented-token', ['x']), /the token vocabulary is closed/);
  });

  it('a failure cause outside the closed set throws', () => {
    assert.throws(() => composeFailure('gates', 'invented-cause', 'x'), /the cause vocabulary is closed/);
  });

  it('and both accept the words they do know', () => {
    assert.equal(composeOutcome('gates', 'seeded', ['x']).token, 'seeded');
    const failure = composeFailure('gates', 'template-unreadable', 'x');
    assert.equal(failure.token, 'failed');
    assert.equal(failure.lines[0], 'template-unreadable — x');
  });
});

describe('orchestration ensure — seed, or refresh ONLY a still-canonical note', () => {
  it('seeds an absent config, then reports already-current without writing again', () => {
    withProject((dir) => {
      const seeded = ensureOrchestration({ cwd: dir, deps: {} });
      assert.equal(seeded.token, 'seeded');
      assert.equal(seeded.failed, false);
      assert.equal(configOf(dir)._README, CANON_README);

      const before = readFileSync(join(dir, CONFIG_REL), 'utf8');
      const mtime = statSync(join(dir, CONFIG_REL)).mtimeMs;
      const again = ensureOrchestration({ cwd: dir, deps: {} });
      assert.equal(again.token, 'already-current');
      assert.equal(readFileSync(join(dir, CONFIG_REL), 'utf8'), before);
      assert.equal(statSync(join(dir, CONFIG_REL)).mtimeMs, mtime, 'a no-op ensure does not rewrite the file');
    });
  });

  it('refreshes a note that still matches a PREVIOUS canonical, keeping every activity/slot', () => {
    withProject((dir) => {
      writeFileSync(
        join(dir, CONFIG_REL),
        `${JSON.stringify({ _README: KNOWN_PRIOR_README[0], 'plan-execution': { review: 'council' } }, null, 2)}\n`,
      );
      const r = ensureOrchestration({ cwd: dir, deps: {} });
      assert.equal(r.token, 'note-refreshed');
      const after = configOf(dir);
      assert.equal(after._README, CANON_README);
      assert.deepEqual(after['plan-execution'], { review: 'council' }, 'the user\'s own recipe survives the note refresh');
    });
  });

  it('preserves a CUSTOMIZED note verbatim and writes nothing', () => {
    withProject((dir) => {
      const mine = { _README: 'my own note about this project', 'plan-authoring': { review: 'solo' } };
      const bytes = `${JSON.stringify(mine, null, 2)}\n`;
      writeFileSync(join(dir, CONFIG_REL), bytes);
      const r = ensureOrchestration({ cwd: dir, deps: {} });
      assert.equal(r.token, 'customized-preserved');
      assert.equal(readFileSync(join(dir, CONFIG_REL), 'utf8'), bytes, 'byte-for-byte');
    });
  });

  it('a MALFORMED config is preserved untouched, LOUD, and marked failed', () => {
    withProject((dir) => {
      const broken = '{ this is not json';
      writeFileSync(join(dir, CONFIG_REL), broken);
      const r = ensureOrchestration({ cwd: dir, deps: {} });
      assert.equal(r.token, 'malformed-preserved');
      assert.equal(r.failed, true, 'an unparseable config is a non-zero signal, never a quiet skip');
      assert.equal(readFileSync(join(dir, CONFIG_REL), 'utf8'), broken);
      assert.match(r.lines.join('\n'), /preserved untouched, nothing written/);
    });
  });

  // A symlink pointing at valid JSON PARSES — so without a kind probe the op would report
  // `already-current` over a file this ensure would refuse to write through.
  it('a SYMLINK where the config belongs fails loudly, without reading through it', () => {
    withProject((dir) => {
      writeFileSync(join(dir, 'elsewhere.json'), `${JSON.stringify({ _README: CANON_README }, null, 2)}\n`);
      symlinkSync(join(dir, 'elsewhere.json'), join(dir, CONFIG_REL));
      const r = ensureOrchestration({ cwd: dir, deps: {} });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^wrong-node-kind — .*a symlink/);
      assert.equal(r.failed, true);
    });
  });

  it('--dry-run reports would-seed and creates nothing', () => {
    withProject((dir) => {
      const r = ensureOrchestration({ cwd: dir, dryRun: true, deps: {} });
      assert.equal(r.token, 'would-seed');
      assert.equal(existsSync(join(dir, CONFIG_REL)), false);
    });
  });

  // The create-only race: the config appears between the probe and the write. The seed must NOT
  // clobber it, and the op must report what the file now IS rather than the write it did not do.
  it('a config that appears mid-seed survives, and the op reports the file it found', () => {
    withProject((dir) => {
      const mine = `${JSON.stringify({ _README: 'mine', 'plan-authoring': { review: 'solo' } }, null, 2)}\n`;
      let probes = 0;
      let publications = 0;
      const deps = {
        lstat: (p) => {
          // The op's FIRST TWO looks at the config — the kind probe and the reader's own lstat — see
          // an absent file, so the seed path is really entered; the writer then finds one there.
          // (The count matters: with only the first look absent, the reader would load the file and
          // the seed path this test exists for would never run.)
          if (p.endsWith('orchestration.json') && probes++ < 2) {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          }
          return statSync(p);
        },
        // A SPY on the create-only publication itself: counting lstat calls would only prove that
        // something looked again, and one more probe anywhere ahead of the writer would let the
        // ordinary path pass this test silently. The link IS the seed write.
        link: (from, to) => { publications += 1; return linkSync(from, to); },
      };
      writeFileSync(join(dir, CONFIG_REL), mine);
      const r = ensureOrchestration({ cwd: dir, deps });
      assert.equal(readFileSync(join(dir, CONFIG_REL), 'utf8'), mine, 'the file that appeared is untouched');
      assert.equal(r.token, 'customized-preserved', 'and the outcome describes THAT file, not the seed');
      assert.equal(publications, 1, 'the create-only publication was really attempted — this is the seed path, not the ordinary one');
    });
  });

  // The re-read after a create-only collision can fail on its own terms: the file is there, and
  // unreadable. That is the malformed-preserved lane, reached through the SEED path.
  it('a config that appears mid-seed and cannot be read is preserved, LOUD', () => {
    withProject((dir) => {
      let probes = 0;
      const deps = {
        lstat: (p) => {
          if (p.endsWith('orchestration.json') && probes++ < 2) {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          }
          return statSync(p);
        },
        // The file the seed collided with cannot be read at all — the re-read is the FIRST read of it.
        readFile: (p, enc) => {
          if (p.endsWith('orchestration.json')) throw Object.assign(new Error('EACCES: unreadable'), { code: 'EACCES' });
          return readFileSync(p, enc);
        },
      };
      writeFileSync(join(dir, CONFIG_REL), '{}\n');
      const r = ensureOrchestration({ cwd: dir, deps });
      assert.equal(r.token, 'malformed-preserved');
      assert.equal(r.failed, true);
      assert.match(r.lines[0], /appeared while this run was seeding it/);
    });
  });

  // The seed could not create the file AND nothing is there: the writer refuses at the link, rather
  // than reporting a preserved file it never saw.
  it('a seed whose destination is neither creatable nor present STOPs at the writer', () => {
    withProject((dir) => {
      const deps = {
        lstat: (p) => {
          if (p.endsWith('orchestration.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return statSync(p);
        },
        link: () => { throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); },
      };
      assert.throws(() => ensureOrchestration({ cwd: dir, deps }), /nothing is there now/);
    });
  });

  // And when the file DOES stand at the write, then vanishes before the re-read: the op reports an
  // unresolved race instead of describing a config it could not read.
  it('a config that appears at the write and vanishes before the re-read is a loud unresolved race', () => {
    withProject((dir) => {
      const fileStat = { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true };
      let linked = false;
      let recheckDone = false;
      const deps = {
        link: () => { linked = true; throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); },
        lstat: (p) => {
          if (!p.endsWith('orchestration.json')) return statSync(p);
          if (linked && !recheckDone) { recheckDone = true; return fileStat; } // the writer's re-check
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
      };
      const r = ensureOrchestration({ cwd: dir, deps });
      assert.equal(r.token, 'failed', 'an operational failure prints the ONE documented failure token');
      assert.match(r.lines[0], /^race-unresolved — /, 'and its line OPENS with the closed cause word');
      assert.equal(r.failed, true);
    });
  });

  // A file that VANISHES between the reader's lstat and its read is unreadable — but calling that
  // "malformed and preserved" would state two things the run never observed.
  it('a config that cannot be read AND is not there any more is a race, not malformed-preserved', () => {
    withProject((dir) => {
      let looks = 0;
      const deps = {
        // The kind probe and the reader's own lstat see a file; by the time the classification
        // probes again, it is gone. Every OTHER path answers from the real tree.
        lstat: (p) => {
          if (!p.endsWith('orchestration.json')) return statSync(p);
          if (looks++ > 1) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true };
        },
        readFile: () => { throw Object.assign(new Error('ENOENT: it vanished'), { code: 'ENOENT' }); },
      };
      const r = ensureOrchestration({ cwd: dir, deps });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^race-unresolved — /);
      assert.equal(existsSync(join(dir, CONFIG_REL)), false);
    });
  });
});
