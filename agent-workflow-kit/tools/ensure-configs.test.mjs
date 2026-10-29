// ensure-configs.test.mjs — the CLI contract of the ONE ensure command.
//
// The ops themselves are covered in ensure-ops.test.mjs. What is pinned HERE is everything the mode
// doc now relies on when it invokes this tool exactly once: --reconcile is required, --dry-run writes
// nothing at all, the ops run in a FIXED order, `--only <op>` narrows the run to exactly one of
// them, one op's failure never skips the rest, and the exit code says whether anything failed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from './ensure-configs.mjs';
import { DRY_RUN_TOKENS, ENSURE_OPS, RELAYED_ENSURE_TOKENS, WRITE_TOKENS } from './ensure-ops.mjs';
import { KIT_OWN_PATHS } from './known-footprint.mjs';
import { DEPLOYED_SCRIPTS } from './node-evidence.mjs';
import { CONFIG_REL } from './orchestration-config.mjs';

const withProject = (fn, { deploy = true, node = true } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'ensure-cli-'));
  try {
    if (deploy) mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
    if (node) writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// Every regular file under `dir`, as rel → bytes. "Wrote nothing" is asserted against this, not
// against a spot check of the files a test happened to think of.
const snapshot = (dir) => {
  const out = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(relative(dir, full), entry.isFile() ? readFileSync(full, 'utf8') : `<${entry.name}>`);
    }
  };
  walk(dir);
  return out;
};

const tokensOf = (stdout) =>
  stdout
    .split('\n')
    .map((line) => line.match(/^ {2}([a-z-]+): ([a-z-]+)$/))
    .filter(Boolean)
    .map(([, op, token]) => ({ op, token }));

const KIT = fileURLToPath(new URL('..', import.meta.url));
// The spec layer's pair files (the spec-schema and docs-size modules' deployed entries) at their bundled bodies in the
// kit folder, each manifest path in `edited` holding an edit of its own instead, beside an edited kit script.
const PAIR_FILES = DEPLOYED_SCRIPTS.filter(({ module }) => module === 'spec-schema' || module === 'docs-size');
const [CHECKER, READER, READER_INDEX] = ['docs-size/check-docs-size.mjs', 'spec-schema/spec-schema.mjs', 'spec-schema/index.mjs'];
const entryOf = (manifestPath) => DEPLOYED_SCRIPTS.find(({ path }) => path === manifestPath);
const KIT_SCRIPT = entryOf('archives/archive-caps.mjs');
const edit = (path) => `// my own ${path}\n`;
const withSpecLayer = (fn, edited = [CHECKER]) => withProject((dir) => {
  for (const { path, deployed, bundled } of [...PAIR_FILES, KIT_SCRIPT]) {
    mkdirSync(dirname(join(dir, deployed)), { recursive: true });
    writeFileSync(join(dir, deployed), [...edited, KIT_SCRIPT.path].includes(path) ? edit(path) : readFileSync(join(KIT, bundled)));
  }
  return fn(dir);
});
const FOOTER = '  part of this configuration run did NOT complete — the lines above name the cause, and what was and was not written.';
// What the retired replace step printed: its block, its command, a kept-aside copy, the user's yes.
const RETIRED = /user's yes|--replace-custom|\baside\b|replace (?:block|line)/;

describe('usage — nothing writes without --reconcile', () => {
  it('a bare invocation is a usage error and leaves the tree alone', () => {
    withProject((dir) => {
      const before = snapshot(dir);
      const r = main([], { cwd: dir });
      assert.equal(r.code, 2);
      assert.match(r.stderr, /pass --reconcile/);
      assert.deepEqual(snapshot(dir), before);
    });
  });

  it('an unknown flag and a valueless --cwd are usage errors', () => {
    withProject((dir) => {
      assert.equal(main(['--reconcile', '--force'], { cwd: dir }).code, 2);
      assert.equal(main(['--reconcile', '--cwd'], { cwd: dir }).code, 2);
      assert.equal(main(['--reconcile', '--cwd', '--dry-run'], { cwd: dir }).code, 2);
    });
  });

  // An EMPTY --cwd= would resolve to the ambient directory: a writing CLI must never act on a
  // different project than the caller named, silently.
  for (const [label, argv] of [['--cwd=', ['--reconcile', '--cwd=']], ['--cwd ""', ['--reconcile', '--cwd', '']]]) {
    it(`an empty ${label} is a usage error, not the current directory`, () => {
      withProject((dir) => {
        const before = snapshot(dir);
        const r = main(argv, { cwd: dir });
        assert.equal(r.code, 2);
        assert.match(r.stderr, /--cwd needs a path argument/);
        assert.deepEqual(snapshot(dir), before);
      });
    });
  }

  it('--help exits 0, states the required flag and the scripts op on a declined project', () => {
    const r = main(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /--reconcile/);
    for (const re of [/CREATE-ONLY/, /declined the enforcement offer, its standing seed files are kept current/]) assert.match(r.stdout, re);
  });
});

describe('the deployment gate runs ONCE, before any op', () => {
  it('an undeployed project stops the whole run and writes nothing', () => {
    withProject((dir) => {
      const before = snapshot(dir);
      const r = main(['--reconcile'], { cwd: dir });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /no agent-workflow deployment here/);
      assert.equal(r.stdout, '', 'no op line may suggest an ensure ran');
      assert.deepEqual(snapshot(dir), before);
    }, { deploy: false });
  });
});

describe('--dry-run writes nothing and never emits a write token', () => {
  it('emits no write token for a bare project, and the tree is byte-identical after', () => {
    withProject((dir) => {
      const before = snapshot(dir);
      const r = main(['--reconcile', '--dry-run'], { cwd: dir });
      assert.equal(r.code, 0);
      const tokens = tokensOf(r.stdout);
      assert.deepEqual(tokens.map((t) => t.op), [...ENSURE_OPS]);
      for (const { op, token } of tokens) {
        assert.equal(WRITE_TOKENS.includes(token), false, `${op} reported the write token "${token}" under --dry-run`);
      }
      assert.deepEqual(snapshot(dir), before);
    });
  });
});

describe('the reconcile run', () => {
  it('seeds everything, then converges: the second run writes nothing and claims nothing', () => {
    withProject((dir) => {
      const first = main(['--reconcile'], { cwd: dir });
      assert.equal(first.code, 0);
      // The ops: the spec-layer ensure seeds the reader pair, the checker pair and the store root on a
      // bare tree, and the navigator is regenerated AFTER it (the store root is a docs/ai file).
      assert.deepEqual(tokensOf(first.stdout).map((t) => t.token), ['seeded', 'seeded', 'seeded', 'seeded', 'not-placed', 'not-placed', 'seeded', 'seeded', 'regenerated']);
      assert.equal(existsSync(join(dir, 'docs', 'ai', 'specs', 'index.md')), true, 'the spec store root landed');
      const afterFirst = snapshot(dir);

      const second = main(['--reconcile'], { cwd: dir });
      assert.equal(second.code, 0);
      assert.deepEqual(tokensOf(second.stdout)[5], { op: 'scripts', token: 'already-present' }, 'the seed files the spec layer placed are already the bundled body on the second run');
      for (const { op, token } of tokensOf(second.stdout)) {
        assert.equal(WRITE_TOKENS.includes(token), false, `${op} claimed "${token}" on an already-current tree`);
      }
      assert.deepEqual(snapshot(dir), afterFirst, 'a converged re-run is byte-identical');
    });
  });

  it('runs the ops in the FIXED order, every op reporting exactly one token line', () => {
    withProject((dir) => {
      const r = main(['--reconcile'], { cwd: dir });
      assert.deepEqual(tokensOf(r.stdout).map((t) => t.op), [...ENSURE_OPS]);
    });
  });

  it('spec:executor-vehicle/S6 — nine ops with executor fifth after vehicles, rules between specs and index, and --help says nine', () => {
    assert.equal(ENSURE_OPS.length, 9);
    assert.deepEqual([ENSURE_OPS[3], ENSURE_OPS[4]], ['vehicles', 'executor']);
    assert.deepEqual(ENSURE_OPS.slice(6), ['specs', 'rules', 'index']);
    withProject((dir) => {
      const r = main(['--reconcile'], { cwd: dir });
      const tokens = tokensOf(r.stdout);
      assert.equal(tokens.length, 9);
      assert.deepEqual(tokens.map((t) => t.op), [...ENSURE_OPS]);
      assert.deepEqual(tokens[4], { op: 'executor', token: 'not-placed' });
      assert.equal(r.code, 0, r.stderr);
    });
    const help = main(['--help']).stdout;
    const lines = help.split('\n');
    assert.match(lines[0], /\bnine\b/);
    const usage = lines.find((line) => line.includes('--reconcile') && line.includes('required'));
    assert.match(usage, /\bnine\b/);
    assert.ok(usage.includes(ENSURE_OPS.join(', ')));
    assert.doesNotMatch(help, /\beight\b/);
  });

  for (const [label, argvFor] of [
    ['--cwd=<dir>', (dir) => ['--reconcile', `--cwd=${dir}`]],
    ['--cwd <dir>', (dir) => ['--reconcile', '--cwd', dir]],
  ]) {
    it(`honours ${label} over the ambient cwd`, () => {
      withProject((dir) => {
        const r = main(argvFor(dir), { cwd: join(dir, 'nowhere') });
        assert.equal(r.code, 0);
        assert.equal(existsSync(join(dir, CONFIG_REL)), true);
      });
    });
  }
});

// `--only <op>` exists so a mode doc can re-run ONE operation at the point where it is authoritative
// (the late navigator finalizer) without re-running the whole reconcile. Its refusals are usage
// errors: a run that cannot be narrowed as asked must write nothing at all.
describe('--only <op> narrows the run to exactly one operation', () => {
  it('runs the selected op and no other, with reconcile semantics unchanged', () => {
    withProject((dir) => {
      const r = main(['--reconcile', '--only', 'index'], { cwd: dir });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(tokensOf(r.stdout).map((t) => t.op), ['index']);
      assert.equal(existsSync(join(dir, 'docs', 'ai', 'index.md')), true);
      assert.equal(existsSync(join(dir, CONFIG_REL)), false, 'the ops that were not selected never ran');
    });
  });

  it('--only specs runs the spec-layer ensure alone (the refresh lane a custom checker is told about)', () => {
    withProject((dir) => {
      const r = main(['--reconcile', '--only', 'specs'], { cwd: dir });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(tokensOf(r.stdout), [{ op: 'specs', token: 'seeded' }]);
      assert.equal(existsSync(join(dir, entryOf(READER).deployed)), true);
      assert.equal(existsSync(join(dir, 'docs', 'ai', 'index.md')), false, 'the navigator op did not run');
    });
  });

  it('honours --dry-run for the selected op', () => {
    withProject((dir) => {
      const before = snapshot(dir);
      const r = main(['--reconcile', '--only', 'index', '--dry-run'], { cwd: dir });
      assert.equal(r.code, 0);
      assert.deepEqual(tokensOf(r.stdout).map((t) => t.token), ['would-regenerate']);
      assert.deepEqual(snapshot(dir), before);
    });
  });

  it('an unknown op is a usage error and writes nothing', () => {
    withProject((dir) => {
      const before = snapshot(dir);
      const r = main(['--reconcile', '--only', 'navigator'], { cwd: dir });
      assert.equal(r.code, 2);
      assert.match(r.stderr, /navigator/);
      assert.deepEqual(snapshot(dir), before);
    });
  });

  for (const [label, argv] of [
    ['a missing value', ['--reconcile', '--only']],
    ['a value that reads as another flag', ['--reconcile', '--only', '--dry-run']],
    ['a repeated flag', ['--reconcile', '--only', 'index', '--only', 'gates']],
  ]) {
    it(`${label} is a usage error and writes nothing`, () => {
      withProject((dir) => {
        const before = snapshot(dir);
        const r = main(argv, { cwd: dir });
        assert.equal(r.code, 2);
        assert.notEqual(r.stderr, '');
        assert.deepEqual(snapshot(dir), before);
      });
    });
  }
});

describe('spec:distribution-files/S3 nothing under .agent-workflow', () => {
  it("a plain, a dry and an --only specs run each leave an earlier release's kept-aside folder byte-identical and create none where it is absent; KIT_OWN_PATHS carries no path under it", () => {
    for (const flags of [[], ['--dry-run'], ['--only', 'specs']]) {
      withSpecLayer((dir) => {
        const [reserved, kept] = [join(dir, '.agent-workflow'), join(dir, '.agent-workflow', 'kept-aside', '0123456789abcdef', 'scripts')];
        mkdirSync(kept, { recursive: true });
        writeFileSync(join(reserved, '.gitignore'), '*\n');
        writeFileSync(join(kept, 'check-docs-size.mjs'), edit('check-docs-size.mjs'));
        const before = snapshot(reserved), r = main(['--reconcile', ...flags, '--cwd', dir]);
        assert.deepEqual([r.code, snapshot(reserved)], [0, before], `${flags.join(' ')}\n${r.stdout}`);
      }, [CHECKER, READER_INDEX]);
      withSpecLayer((dir) => {
        const r = main(['--reconcile', ...flags, '--cwd', dir]);
        assert.deepEqual([r.code, existsSync(join(dir, '.agent-workflow'))], [0, false], `${flags.join(' ')}\n${r.stdout}`);
      });
    }
    assert.deepEqual(KIT_OWN_PATHS.filter((path) => /^\/?\.agent-workflow(\/|$)/.test(path)), []);
  });
});

describe('spec:distribution-files/S8 no replace block and no replace command; --replace-custom is an unknown argument', () => {
  const refusing = (dir) => ({ deps: { writeFile: (p, ...rest) => { if (String(p).startsWith(join(dir, 'scripts'))) throw Object.assign(new Error('EACCES: refused'), { code: 'EACCES' }); return writeFileSync(p, ...rest); } } });
  for (const [label, flags, failing] of [['a plain run', [], false], ['a dry run', ['--dry-run'], false], ['an --only specs run', ['--only', 'specs'], false], ['a run whose ops fail', [], true]]) {
    it(`${label} over edited pair files beside an edited kit script: no replace block or command, the failure footer only when an op failed`, () => withSpecLayer((dir) => {
      const r = main(['--reconcile', ...flags, '--cwd', dir], failing ? refusing(dir) : {}), lines = r.stdout.split('\n');
      assert.deepEqual({ code: r.code, retired: lines.filter((l) => RETIRED.test(l)), footers: lines.filter((l) => l === FOOTER).length, last: lines.at(-1) === FOOTER }, { code: failing ? 1 : 0, retired: [], footers: failing ? 1 : 0, last: failing }, r.stdout);
    }, [CHECKER, READER_INDEX]));
  }
  it('--replace-custom <digest> and --replace-custom=x: the usage refusal unknown argument naming the flag, exit 2, nothing run', () => withSpecLayer((dir) => {
    const before = snapshot(dir);
    for (const [argv, named] of [[['--replace-custom', '0'.repeat(64)], '--replace-custom'], [['--replace-custom=x'], '--replace-custom=x']]) {
      const r = main(['--reconcile', ...argv, '--cwd', dir]);
      assert.deepEqual({ code: r.code, stdout: r.stdout, stderr: r.stderr, tree: snapshot(dir) }, { code: 2, stdout: '', stderr: `ensure-configs: unknown argument: ${named}`, tree: before }, argv.join(' '));
    }
  }));
});

describe('spec:distribution-files/S9 one plain run through the command', () => {
  it('writes the edited pair files to the bundled bytes, prints the specs line, then the index line, exit 0; a second plain run writes nothing, specs already-present', () => withSpecLayer((dir) => {
    const r = main(['--reconcile', '--cwd', dir]), ops = tokensOf(r.stdout);
    const replaced = ({ deployed }) => r.stdout.includes(`\n      ${deployed}: differs from every body this kit knows it shipped — replaced by the bundled body; an edit meant to last goes in `);
    const edited = [CHECKER, READER].map(entryOf);
    assert.deepEqual({ code: r.code, specs: ops.find((t) => t.op === 'specs')?.token, order: ops.map((t) => t.op).filter((op) => op === 'specs' || op === 'index'), lines: edited.map(replaced),
      bundled: edited.map(({ deployed, bundled }) => readFileSync(join(dir, deployed), 'utf8') === readFileSync(join(KIT, bundled), 'utf8')) }, { code: 0, specs: 'seeded', order: ['specs', 'index'], lines: [true, true], bundled: [true, true] }, r.stdout);
    const after = snapshot(dir), again = main(['--reconcile', '--cwd', dir]);
    assert.deepEqual([again.code, tokensOf(again.stdout).find((t) => t.op === 'specs')?.token, snapshot(dir)], [0, 'already-present', after], again.stdout);
  }, [CHECKER, READER]));
});

// The CLI entry itself: everything above calls main() in-process, so the guarded entry block — the
// half that actually decides an exit code for a real invocation — would otherwise ship unexercised.
describe('the CLI entry (a spawned process)', () => {
  const TOOL = fileURLToPath(new URL('./ensure-configs.mjs', import.meta.url));
  const run = (args, cwd) => spawnSync(process.execPath, [TOOL, ...args], { cwd, encoding: 'utf8' });

  it('--help exits 0 through the process', () => {
    const r = run(['--help'], tmpdir());
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--reconcile/);
  });

  it('a bare invocation exits 2 and says so on stderr', () => {
    const r = run([], tmpdir());
    assert.equal(r.status, 2);
    assert.match(r.stderr, /pass --reconcile/);
  });

  it('a real --reconcile run seeds the named project and exits 0', () => {
    withProject((dir) => {
      const r = run(['--reconcile', '--cwd', dir], tmpdir());
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /orchestration: seeded/);
      assert.equal(existsSync(join(dir, CONFIG_REL)), true);
    });
  });

  it('--only index runs the one op through the process', () => {
    withProject((dir) => {
      const r = run(['--reconcile', '--only', 'index', '--cwd', dir], tmpdir());
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /index: regenerated/);
      assert.equal(/orchestration:/.test(r.stdout), false, 'no other op ran');
    });
  });

  it('--only with an unknown op exits 2 through the process', () => {
    withProject((dir) => {
      const r = run(['--reconcile', '--only', 'navigator', '--cwd', dir], tmpdir());
      assert.equal(r.status, 2);
      assert.match(r.stderr, /navigator/);
    });
  });
});

// The mode doc enumerates the outcome tokens for the agent that relays them. A token the CLI can
// print but the doc never taught is the drift this guard exists to catch — it is what both review
// backends found in round 1, and the reason every operational failure now prints `failed` with its
// cause in the line below it.
describe('the CLI can only print tokens the mode doc teaches', () => {
  const documented = new Set([...RELAYED_ENSURE_TOKENS, ...DRY_RUN_TOKENS]);
  const scenarios = {
    'a clean seed': (dir) => main(['--reconcile'], { cwd: dir }),
    'a converged re-run': (dir) => { main(['--reconcile'], { cwd: dir }); return main(['--reconcile'], { cwd: dir }); },
    'a dry run': (dir) => main(['--reconcile', '--dry-run'], { cwd: dir }),
    'a malformed config': (dir) => {
      writeFileSync(join(dir, CONFIG_REL), '{ not json');
      return main(['--reconcile'], { cwd: dir });
    },
    'an op that throws': (dir) => {
      mkdirSync(join(dir, 'elsewhere'));
      symlinkSync(join(dir, 'elsewhere'), join(dir, 'scripts'));
      return main(['--reconcile'], { cwd: dir });
    },
    'a wrong node kind': (dir) => {
      mkdirSync(join(dir, 'docs', 'ai', 'gates.json'), { recursive: true });
      return main(['--reconcile'], { cwd: dir });
    },
    'a No-Node project': (dir) => main(['--reconcile'], { cwd: dir }),
  };

  for (const [label, run] of Object.entries(scenarios)) {
    it(`${label}: every printed token is documented`, () => {
      withProject((dir) => {
        const r = run(dir);
        const tokens = tokensOf(r.stdout);
        assert.ok(tokens.length > 0, 'the scenario must actually print op lines');
        for (const { op, token } of tokens) {
          assert.equal(documented.has(token), true, `${op} printed "${token}", which references/modes/upgrade.md does not teach`);
        }
      }, { node: label !== 'a No-Node project' });
    });
  }
});

describe('one op failing never skips the rest', () => {
  it('a malformed config fails its own op, the others still run, and the exit is non-zero', () => {
    withProject((dir) => {
      writeFileSync(join(dir, CONFIG_REL), '{ not json');
      const r = main(['--reconcile'], { cwd: dir });
      assert.equal(r.code, 1);
      const tokens = tokensOf(r.stdout);
      const expected = ['malformed-preserved', 'seeded', 'seeded', 'seeded', 'not-placed', 'not-placed', 'seeded', 'seeded', 'regenerated'];
      assert.deepEqual(tokens, ['orchestration', 'gates', 'autonomy', 'vehicles', 'executor', 'scripts', 'specs', 'rules', 'index'].map((op, i) => ({ op, token: expected[i] })));
      assert.match(r.stdout, /part of this configuration run did NOT complete/);
      assert.doesNotMatch(r.stdout, /nothing was written for those/, 'the summary claims nothing about what landed — an op can stop partway');
      assert.equal(readFileSync(join(dir, CONFIG_REL), 'utf8'), '{ not json');
    });
  });

  // The catch-all is the ONE failure nobody planned for — it still opens with a closed cause word,
  // so no line in the system names no cause.
  it('a throw the ops never anticipated is reported as unexpected-error, and the rest still run', () => {
    withProject((dir) => {
      const deps = {
        lstat: (p) => {
          if (p.endsWith('gates.json')) throw Object.assign(new Error('EACCES: unreadable'), { code: 'EACCES' });
          return lstatSync(p);
        },
      };
      const r = main(['--reconcile'], { cwd: dir, deps });
      assert.equal(r.code, 1);
      const tokens = tokensOf(r.stdout);
      assert.deepEqual(tokens.map((t) => t.token), ['seeded', 'failed', 'seeded', 'seeded', 'not-placed', 'not-placed', 'seeded', 'seeded', 'regenerated']);
      assert.match(r.stdout, /unexpected-error — gates: /);
    });
  });

  it('an unexpected STOP inside an op becomes THAT op\'s failed line, not a crash', () => {
    withProject((dir) => {
      // A symlinked scripts/ is a write we refuse to make THROUGH a link — the op throws, and the CLI
      // has to turn that into one failed line while the config ensures still land.
      mkdirSync(join(dir, 'elsewhere'));
      symlinkSync(join(dir, 'elsewhere'), join(dir, 'scripts'));
      const r = main(['--reconcile'], { cwd: dir });
      assert.equal(r.code, 1);
      const tokens = tokensOf(r.stdout);
      assert.deepEqual(tokens.slice(0, 3).map((t) => t.token), ['seeded', 'seeded', 'seeded']);
      assert.deepEqual(tokens.find((t) => t.op === 'scripts'), { op: 'scripts', token: 'failed' });
      assert.deepEqual(tokens.find((t) => t.op === 'specs'), { op: 'specs', token: 'failed' }, 'the spec-layer seeds refuse the same link');
      assert.match(r.stdout, /symlink/);
      assert.deepEqual(readdirSync(join(dir, 'elsewhere')), [], 'nothing was written through the link');
    });
  });
});
