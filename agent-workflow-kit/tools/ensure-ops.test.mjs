// ensure-ops.test.mjs — the closed outcome vocabulary and the ONE ensure that also REFRESHES
// (docs/ai/orchestration.json). The three seed-if-missing ensures live in ensure-seeds.test.mjs.
//
// What these guard: the ops now WRITE into a deployed project, so every claim they print has to be
// one the run proved. The seed is create-only, the refresh only touches a note the kit itself
// shipped, and every fail-closed arm must write NOTHING and say so out loud.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The navigator ensure is reached through the module NAMESPACE, not a named import: a red-first
// contract has to LOAD against the pre-fix module and fail on the behaviour, not on the import.
import * as ensureOps from './ensure-ops.mjs';
import { composeFailure, composeOutcome, ensureOrchestration } from './ensure-ops.mjs';
import { CANON_README, CONFIG_REL, KNOWN_PRIOR_README } from './orchestration-config.mjs';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_REL = 'docs/ai/index.md';

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

// A deployed project with a real doc under docs/ai — the navigator ensure drives the bundled
// generator over it, so the tree has to be one the generator can actually render.
const DOC_BODY = '---\ntype: state\nlastUpdated: 2026-08-15\nscope: session\nstaleAfter: never\nowner: none\nmaxLines: 10\n---\n\n# a\n';
const withDocs = (fn, { packageJson = true } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'ensure-index-'));
  try {
    mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'ai', 'a.md'), DOC_BODY);
    if (packageJson) writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const runIndex = (dir, extra = {}) => ensureOps.ensureIndex({ cwd: dir, kitRoot: KIT_ROOT, ...extra });

const GENERATOR = join(KIT_ROOT, 'references', 'scripts', 'check-docs-size.mjs');
const KJ = "the project's own checker (scripts/check-docs-size.mjs --check-index)";
const FOUND_BYTES = 'found bytes\n';
const REJECTING_CHECKER = '// rejects every navigator\nprocess.exit(1);\n';
const ACCEPTING_CHECKER = '// accepts every navigator\n';
const TRAPPING_CHECKER = "process.on('SIGTERM', () => {});\nsetTimeout(() => {}, 20000);\n";
const COUNTING_CHECKER = "import { existsSync, writeFileSync } from 'node:fs';\nif (!existsSync('first-ran')) { writeFileSync('first-ran', ''); process.exit(1); }\n" + TRAPPING_CHECKER;
const withKept = (setup, fn) => withDocs((dir) => {
  mkdirSync(join(dir, 'scripts'));
  for (const name of ['check-docs-size.mjs', 'check-docs-size.test.mjs', 'spec-schema.mjs', 'spec-schema.test.mjs']) {
    writeFileSync(join(dir, 'scripts', name), readFileSync(join(KIT_ROOT, 'references', 'scripts', name)));
  }
  writeFileSync(join(dir, 'docs', 'ai', 'b.md'), DOC_BODY);
  setup(dir);
  return fn(dir);
});
const spySpawn = (answer = () => undefined) => {
  const calls = [];
  return {
    calls,
    spawnSync: (cmd, args, options) => {
      calls.push(args);
      return answer(args) ?? spawnSync(cmd, args, options);
    },
  };
};
const snapshotFiles = (dir, rel = '') => new Map(
  readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = join(rel, entry.name);
    return entry.isDirectory() ? [...snapshotFiles(dir, path)] : [[path, readFileSync(join(dir, path))]];
  }),
);
const writeChecker = (dir, body) => writeFileSync(join(dir, 'scripts', 'check-docs-size.mjs'), body);
const readPriorChecker = () => readFileSync(join(KIT_ROOT, 'test', 'fixtures', 'script-priors', '7.0.0', 'check-docs-size.mjs.txt'));
const setRejected = (dir, found = true) => {
  writeChecker(dir, REJECTING_CHECKER);
  if (found) writeFileSync(join(dir, INDEX_REL), FOUND_BYTES);
};
const spyBrokenGenerator = (dir) => spySpawn((args) => {
  if (args[0] !== GENERATOR) return undefined;
  writeFileSync(join(dir, INDEX_REL), 'garbage\n');
  return { status: 3, stdout: '', stderr: 'boom\n' };
});
const refusePutBack = (op) => () => {
  throw Object.assign(new Error(`EACCES: permission denied, ${op}`), { code: 'EACCES' });
};
const assertPutBackFailure = (r) => {
  assert.equal(r.token, 'failed');
  assert.equal(r.failed, true);
  assert.match(r.lines[0], /^write-refused — docs\/ai\/index\.md: putting the navigator back failed \(/);
  assert.match(r.lines[0], /may stand/);
  assert.doesNotMatch(r.lines[0], /was put back/);
};

describe('spec:docs-navigator/S7 a hook module that is not the bundled one puts the navigator under the project\'s checker', () => {
  it('a navigator the kept probe accepts is already-current, with no write and no bundled launch', () => {
    for (const variant of ['reader', 'prior', 'accepting', 'tab']) {
      withKept((dir) => {
        assert.equal(runIndex(dir).token, 'regenerated');
        if (variant === 'reader') {
          const path = join(dir, 'scripts', 'spec-schema.mjs');
          writeFileSync(path, readFileSync(path, 'utf8') + '// mine\n');
        } else writeChecker(dir, variant === 'prior' ? readPriorChecker() : ACCEPTING_CHECKER);
        if (variant === 'tab') writeFileSync(join(dir, INDEX_REL), readFileSync(join(dir, INDEX_REL), 'utf8').replace(/^maxLines: /m, `maxLines:${String.fromCharCode(9)}`));
      }, (dir) => {
        const before = readFileSync(join(dir, INDEX_REL));
        const spy = spySpawn();
        const r = runIndex(dir, { deps: { spawnSync: spy.spawnSync } });
        assert.equal(r.token, 'already-current', variant);
        assert.equal(r.lines[0], `docs/ai/index.md: in sync under ${KJ} and within the maxLines it stamps — nothing written`, variant);
        assert.equal(spy.calls.some((args) => args[0] === GENERATOR), false, variant);
        assert.deepEqual(readFileSync(join(dir, INDEX_REL)), before, variant);
      });
    }
  });
  it('exit 0 over a navigator past its own stamp is rejected, written by the bundled generator and regenerated once accepted', () => {
    withKept((dir) => {
      writeChecker(dir, ACCEPTING_CHECKER);
      writeFileSync(join(dir, INDEX_REL), '---\nmaxLines: 2\n---\nx\ny\n');
    }, (dir) => {
      const spy = spySpawn();
      const r = runIndex(dir, { deps: { spawnSync: spy.spawnSync } });
      assert.ok(spy.calls.some((args) => args[0] === GENERATOR && args[1] === '--ensure-index'));
      assert.equal(r.token, 'regenerated');
      assert.equal(r.lines[0], `docs/ai/index.md: written by the bundled generator — in sync under ${KJ} and within the maxLines it stamps`);
    });
  });
  it('a rejected write is put back byte for byte as customized-preserved, the run not failed', () => {
    withKept(setRejected, (dir) => {
      const r = runIndex(dir);
      assert.equal(r.token, 'customized-preserved');
      assert.equal(r.failed, false);
      assert.equal(readFileSync(join(dir, INDEX_REL), 'utf8'), FOUND_BYTES);
      assert.equal(r.lines[0], `docs/ai/index.md: ${KJ} rejected the bundled render on its index check (it exited with code 1), and the navigator as found did not pass it either (its index check) — the navigator was put back byte for byte. The route: the replace line printed for the spec layer (scripts/check-docs-size.mjs), run on the user's yes`);
    });
  });
  it('an absent navigator is removed again; a prior checker\'s route is the refresh, or the replace behind an edited file', () => {
    for (const edited of [false, true]) {
      withKept((dir) => {
        writeChecker(dir, readPriorChecker());
        if (edited) writeFileSync(join(dir, 'scripts', 'check-docs-size.test.mjs'), '// mine\n');
        for (let n = 0; n < 85; n += 1) writeFileSync(join(dir, 'docs', 'ai', `extra-${n}.md`), DOC_BODY);
      }, (dir) => {
        const r = runIndex(dir);
        assert.equal(r.token, 'customized-preserved');
        assert.equal(existsSync(join(dir, INDEX_REL)), false);
        assert.match(r.lines[0], /found absent, it was removed again/);
        assert.ok(r.lines[0].endsWith(edited ? "The route: the replace line printed for the spec layer (scripts/check-docs-size.test.mjs), run on the user's yes" : "The route: the spec layer's refresh of the modules the project's hook loads, then this step again"), edited);
      });
    }
  });
  it('a generator failure after the launch puts back and keeps its cause', () => {
    withKept(setRejected, (dir) => {
      const spy = spyBrokenGenerator(dir);
      const r = runIndex(dir, { deps: { spawnSync: spy.spawnSync } });
      assert.equal(r.token, 'failed');
      assert.equal(r.lines[0], 'generator-failed — docs/ai/index.md: the bundled generator exited with code 3: boom — the navigator was put back byte for byte');
      assert.equal(readFileSync(join(dir, INDEX_REL), 'utf8'), FOUND_BYTES);
    });
  });
  it('a put-back that fails is write-refused and never says it put back', () => {
    for (const found of [true, false]) {
      withKept((dir) => setRejected(dir, found), (dir) => {
        const op = found ? 'rename' : 'unlink';
        assertPutBackFailure(runIndex(dir, { deps: { [op]: refusePutBack(op) } }));
      });
    }
  });
  it('a put-back that fails after a generator failure or a timed-out second probe names that failure first', () => {
    for (const timeout of [false, true]) {
      withKept((dir) => {
        setRejected(dir);
        if (timeout) writeChecker(dir, COUNTING_CHECKER);
      }, (dir) => {
        const spy = timeout ? spySpawn() : spyBrokenGenerator(dir);
        const r = runIndex(dir, { deps: { spawnSync: spy.spawnSync, rename: refusePutBack('rename'), keptProbeTimeoutMs: 500 } });
        assertPutBackFailure(r);
        assert.ok(r.lines[0].includes(timeout ? `after ${KJ} could not answer (` : 'after the bundled generator exited with code 3: boom'));
      });
    }
  });
  it('a kept probe that cannot launch is index-probe-failed with nothing written and no bundled launch', () => {
    withKept(setRejected, (dir) => {
      const before = snapshotFiles(dir);
      const spy = spySpawn((args) => args[0].startsWith(join(dir, 'scripts'))
        ? { error: new Error('spawn EACCES'), status: null, stdout: '', stderr: '' } : undefined);
      const r = runIndex(dir, { deps: { spawnSync: spy.spawnSync } });
      assert.equal(r.token, 'failed');
      assert.equal(r.lines[0], `index-probe-failed — docs/ai/index.md: ${KJ} could not be launched or did not answer in time (spawn EACCES) — nothing was written`);
      assert.equal(spy.calls.some((args) => args[0] === GENERATOR), false);
      assert.deepEqual(snapshotFiles(dir), before);
    });
  });
  it('a checker that traps SIGTERM and outlasts the timeout is killed and index-probe-failed', () => {
    withKept((dir) => writeChecker(dir, TRAPPING_CHECKER), (dir) => {
      const before = snapshotFiles(dir);
      const start = Date.now();
      const r = runIndex(dir, { deps: { keptProbeTimeoutMs: 500 } });
      assert.ok(Date.now() - start < 10000);
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^index-probe-failed — /);
      assert.match(r.lines[0], /ETIMEDOUT/);
      assert.match(r.lines[0], /killed on signal SIGKILL/);
      assert.ok(r.lines[0].endsWith('— nothing was written'));
      assert.deepEqual(snapshotFiles(dir), before);
    });
  });
  it('a second probe that times out is index-probe-failed after the put-back', () => {
    withKept((dir) => {
      setRejected(dir);
      writeChecker(dir, COUNTING_CHECKER);
    }, (dir) => {
      const r = runIndex(dir, { deps: { keptProbeTimeoutMs: 500 } });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^index-probe-failed — /);
      assert.match(r.lines[0], /ETIMEDOUT/);
      assert.ok(r.lines[0].endsWith('— the navigator was put back byte for byte'));
      assert.equal(readFileSync(join(dir, INDEX_REL), 'utf8'), FOUND_BYTES);
    });
  });
  it('a navigator that cannot be read back after the bundled write is put back as unexpected-error', () => {
    withKept((dir) => {
      setRejected(dir);
      writeChecker(dir, "import { existsSync, writeFileSync } from 'node:fs';\nif (!existsSync('first-ran')) { writeFileSync('first-ran', ''); process.exit(1); }\n");
    }, (dir) => {
      let launched = false;
      const spy = spySpawn((args) => { launched ||= args[0] === GENERATOR; });
      const readFile = (path, ...rest) => (launched && path === join(dir, INDEX_REL) ? refusePutBack('open')() : readFileSync(path, ...rest));
      const r = runIndex(dir, { deps: { spawnSync: spy.spawnSync, readFile } });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^unexpected-error — docs\/ai\/index\.md: the navigator could not be read back after the bundled write \(EACCES/);
      assert.ok(r.lines[0].endsWith('— the navigator was put back byte for byte'));
      assert.equal(readFileSync(join(dir, INDEX_REL), 'utf8'), FOUND_BYTES);
    });
  });
  it('the dry run launches no project code and says the real run judges by the project\'s checker', () => {
    withKept((dir) => writeChecker(dir, "import { writeFileSync } from 'node:fs';\nwriteFileSync('stub-ran', '');\nprocess.exit(1);\n"), (dir) => {
      const r = runIndex(dir, { dryRun: true });
      assert.equal(existsSync(join(dir, 'stub-ran')), false);
      assert.equal(r.lines.at(-1), `a module the project's hook loads (scripts/check-docs-size.mjs) is not the bundled one: unless the spec-layer step of this run first refreshes every such module, the real run judges the navigator by ${KJ} and puts back a write it rejects`);
    });
  });
  it('a custom test file alone, and an absent checker beside any reader or a root scripts file, keep today\'s path', () => {
    for (const variant of ['test', 'absent', 'reader-dir', 'scripts-file']) {
      withKept((dir) => {
        const path = join(dir, 'scripts', variant === 'test' ? 'check-docs-size.test.mjs' : 'check-docs-size.mjs');
        if (variant === 'test') writeFileSync(path, readFileSync(path, 'utf8') + '// mine\n');
        else rmSync(path);
        if (variant === 'reader-dir') {
          rmSync(join(dir, 'scripts', 'spec-schema.mjs'));
          mkdirSync(join(dir, 'scripts', 'spec-schema.mjs'));
        }
        if (variant === 'scripts-file') {
          rmSync(join(dir, 'scripts'), { recursive: true, force: true });
          writeFileSync(join(dir, 'scripts'), '');
        }
      }, (dir) => {
        const spy = spySpawn();
        const r = runIndex(dir, { deps: { spawnSync: spy.spawnSync } });
        assert.equal(spy.calls.some((args) => args[0].startsWith(join(dir, 'scripts'))), false, variant);
        assert.equal(r.token, 'regenerated', variant);
        assert.equal(r.lines[0], 'docs/ai/index.md: written from the source frontmatter — the navigator is in sync again', variant);
      });
    }
  });
  it('an unreadable bundled module is bundle-unreadable with nothing written', () => withKept((dir) => writeChecker(dir, REJECTING_CHECKER), (dir) => {
    const before = snapshotFiles(dir);
    const r = runIndex(dir, { deps: { readFile: (path, ...rest) => (path === GENERATOR ? refusePutBack('open')() : readFileSync(path, ...rest)) } });
    assert.equal(r.token, 'failed');
    assert.match(r.lines[0], /^bundle-unreadable — scripts\/check-docs-size\.mjs: the bundled module could not be read, so nothing was written — reinstall the kit\. EACCES/);
    assert.deepEqual(snapshotFiles(dir), before);
  }));
  it('a hook module that is a directory is wrong-node-kind with nothing written, whatever the reader beside it', () => {
    for (const name of ['spec-schema.mjs', 'check-docs-size.mjs']) {
      withKept((dir) => {
        rmSync(join(dir, 'scripts', name));
        mkdirSync(join(dir, 'scripts', name));
      }, (dir) => {
        const before = snapshotFiles(dir);
        const r = runIndex(dir, { deps: { readFile: (path, ...rest) => (path === join(dir, 'scripts', 'spec-schema.mjs') ? refusePutBack('open')() : readFileSync(path, ...rest)) } });
        assert.equal(r.token, 'failed', name);
        assert.equal(r.lines[0], `wrong-node-kind — scripts/${name}: exists but is a directory — the project's hook loads it, so nothing was read or written; resolve it by hand and re-run`);
        assert.deepEqual(snapshotFiles(dir), before, name);
      });
    }
  });
});

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

// The navigator is the one ensure whose target is a GENERATED artifact: it is regenerated whenever
// it is missing or stale, never preserved as authored content — and every failure has to say
// whether a write may already have landed.
describe('index ensure — the navigator is materialized, never preserved', () => {
  it('regenerates an absent navigator, and the generator agrees it is in sync', () => {
    withDocs((dir) => {
      const r = runIndex(dir);
      assert.equal(r.token, 'regenerated');
      assert.equal(r.failed, false);
      assert.ok(existsSync(join(dir, INDEX_REL)));
      const verify = runIndex(dir);
      assert.equal(verify.token, 'already-current');
    });
  });

  it('reports already-current on a second run, byte-identical', () => {
    withDocs((dir) => {
      runIndex(dir);
      const before = readFileSync(join(dir, INDEX_REL), 'utf8');
      const r = runIndex(dir);
      assert.equal(r.token, 'already-current');
      assert.equal(readFileSync(join(dir, INDEX_REL), 'utf8'), before);
    });
  });

  it('regenerates a STALE navigator (a doc was added under it)', () => {
    withDocs((dir) => {
      runIndex(dir);
      writeFileSync(join(dir, 'docs', 'ai', 'b.md'), DOC_BODY);
      const r = runIndex(dir);
      assert.equal(r.token, 'regenerated');
      assert.match(readFileSync(join(dir, INDEX_REL), 'utf8'), /b\.md/);
    });
  });

  it('a SYMLINK where the navigator belongs fails loudly, writing nothing', () => {
    withDocs((dir) => {
      writeFileSync(join(dir, 'elsewhere.md'), '# elsewhere\n');
      symlinkSync(join(dir, 'elsewhere.md'), join(dir, INDEX_REL));
      const r = runIndex(dir);
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^wrong-node-kind — .*a symlink/);
      assert.equal(readFileSync(join(dir, 'elsewhere.md'), 'utf8'), '# elsewhere\n');
    });
  });

  it('a project with no package.json is still given its navigator (the generator runs from the kit)', () => {
    withDocs((dir) => {
      const r = runIndex(dir);
      assert.equal(r.token, 'regenerated');
      assert.ok(existsSync(join(dir, INDEX_REL)));
    }, { packageJson: false });
  });

  it('--dry-run reports would-regenerate and writes nothing', () => {
    withDocs((dir) => {
      const r = runIndex(dir, { dryRun: true });
      assert.equal(r.token, 'would-regenerate');
      assert.equal(existsSync(join(dir, INDEX_REL)), false);
    });
  });

  it('a generator that never LAUNCHES fails with zero writes', () => {
    withDocs((dir) => {
      const deps = { spawnSync: () => ({ error: new Error('spawn ENOENT'), status: null, stdout: '', stderr: '' }) };
      const r = runIndex(dir, { deps });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^generator-unlaunchable — /);
      assert.equal(existsSync(join(dir, INDEX_REL)), false, 'a launch failure happens BEFORE any write');
    });
  });

  it('a generator that launched and exited non-zero fails, DISCLOSING a possible partial write', () => {
    withDocs((dir) => {
      const deps = { spawnSync: () => ({ status: 3, stdout: '', stderr: 'boom\n' }) };
      const r = runIndex(dir, { deps });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^generator-failed — /);
      assert.match(r.lines.join('\n'), /may already have been written|may already have landed/);
    });
  });

  it('the generator\'s OWN refusal is relayed as write-refused, not as a generic failure', () => {
    withDocs((dir) => {
      const deps = {
        spawnSync: () => ({ status: 2, stdout: '', stderr: 'ensure-index: write-refused — docs/ai is a symlink\n' }),
      };
      const r = runIndex(dir, { deps });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^write-refused — /);
      assert.match(r.lines[0], /symlink/, 'the generator\'s own reason rides through');
    });
  });

  it('a verifying probe that cannot answer fails as index-probe-failed, DISCLOSING the write', () => {
    withDocs((dir) => {
      const deps = {
        spawnSync: (_cmd, args) =>
          args.some((a) => a === '--ensure-index')
            ? { status: 0, stdout: 'ensure-index: regenerated — docs/ai/index.md\n', stderr: '' }
            : { error: new Error('spawn EAGAIN'), status: null, stdout: '', stderr: '' },
      };
      const r = runIndex(dir, { deps });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^index-probe-failed — /);
      assert.match(r.lines.join('\n'), /may already have been written/);
    });
  });

  // An exit code alone is not an ANSWER: `--check-index` exits 1 both when the navigator is stale
  // and when the probe itself could not read the tree. Reading only the code would report the
  // second as "still stale after the write" — a claim this run never observed.
  it('a probe that exits 1 without ANSWERING stale is index-probe-failed, never a false stale', () => {
    withDocs((dir) => {
      const deps = {
        spawnSync: (_cmd, args) =>
          args.some((a) => a === '--ensure-index')
            ? { status: 0, stdout: 'ensure-index: regenerated — docs/ai/index.md\n', stderr: '' }
            : { status: 1, stdout: '', stderr: 'EACCES: permission denied, scandir docs/ai\n' },
      };
      const r = runIndex(dir, { deps });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^index-probe-failed — /);
      assert.equal(/index-stale-after-write/.test(r.lines.join('\n')), false, 'an unanswered probe is never reported as stale');
    });
  });

  it('a probe that exits 0 without ANSWERING fresh is index-probe-failed too', () => {
    withDocs((dir) => {
      const deps = {
        spawnSync: (_cmd, args) =>
          args.some((a) => a === '--ensure-index')
            ? { status: 0, stdout: 'ensure-index: regenerated — docs/ai/index.md\n', stderr: '' }
            : { status: 0, stdout: '', stderr: '' },
      };
      const r = runIndex(dir, { deps });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^index-probe-failed — /);
    });
  });

  // The probe answers in prose, so the match must be the canonical SENTENCE. A failure that merely
  // mentions the words would otherwise pass for a verdict — a fail-OPEN in the one place that
  // decides whether a write is still owed.
  it('a failure that merely CONTAINS the stale words is not a stale ANSWER', () => {
    withDocs((dir) => {
      const deps = {
        spawnSync: (_cmd, args) =>
          args.some((a) => a === '--check-index')
            ? { status: 1, stdout: '', stderr: 'EACCES: cannot read /x/is stale/docs/ai — run --write-index if it is stale\n' }
            : { status: 0, stdout: 'ensure-index: regenerated — docs/ai/index.md\n', stderr: '' },
      };
      const written = runIndex(dir, { deps });
      assert.equal(written.token, 'failed');
      assert.match(written.lines[0], /^index-probe-failed — /, 'a message that quotes the words is not the verdict');

      const previewed = runIndex(dir, { dryRun: true, deps });
      assert.equal(previewed.token, 'failed');
      assert.match(previewed.lines[0], /^index-probe-failed — /, 'and the dry-run arm reads it the same way');
    });
  });

  it('the generator\'s own probe-failed refusal keeps its identity', () => {
    withDocs((dir) => {
      const deps = {
        spawnSync: () => ({ status: 2, stdout: '', stderr: 'ensure-index: probe-failed — /x/docs/ai/index.md: EACCES\n' }),
      };
      const r = runIndex(dir, { deps });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^index-probe-failed — /);
    });
  });

  it('a regeneration the re-probe still finds stale fails, DISCLOSING the write that landed', () => {
    withDocs((dir) => {
      const deps = {
        spawnSync: (_cmd, args) =>
          args.some((a) => a === '--ensure-index')
            ? { status: 0, stdout: 'ensure-index: regenerated — docs/ai/index.md\n', stderr: '' }
            : { status: 1, stdout: '', stderr: '[check-docs-size] FAIL: docs/ai/index.md is stale (out of sync with source frontmatter).\n' },
      };
      const r = runIndex(dir, { deps });
      assert.equal(r.token, 'failed');
      assert.match(r.lines[0], /^index-stale-after-write — /);
      assert.match(r.lines.join('\n'), /may already have been written|may already have landed/);
    });
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
