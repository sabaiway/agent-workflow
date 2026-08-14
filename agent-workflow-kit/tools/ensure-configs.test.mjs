// ensure-configs.test.mjs — the CLI contract of the ONE ensure command.
//
// The ops themselves are covered in ensure-ops.test.mjs. What is pinned HERE is everything the mode
// doc now relies on when it invokes this tool exactly once: --reconcile is required, --dry-run writes
// nothing at all, the four ops run in a FIXED order, one op's failure never skips the rest, and the
// exit code says whether anything failed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from './ensure-configs.mjs';
import { DRY_RUN_TOKENS, ENSURE_OPS, RELAYED_ENSURE_TOKENS, WRITE_TOKENS } from './ensure-ops.mjs';
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

  it('--help exits 0 and states the required flag', () => {
    const r = main(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /--reconcile/);
    assert.match(r.stdout, /CREATE-ONLY/);
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
  it('reports would-* for every absent file, and the tree is byte-identical after', () => {
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
      assert.deepEqual(tokensOf(first.stdout).map((t) => t.token), ['seeded', 'seeded', 'seeded', 'seeded']);
      const afterFirst = snapshot(dir);

      const second = main(['--reconcile'], { cwd: dir });
      assert.equal(second.code, 0);
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
  it('a malformed config fails its own op, the other three still run, and the exit is non-zero', () => {
    withProject((dir) => {
      writeFileSync(join(dir, CONFIG_REL), '{ not json');
      const r = main(['--reconcile'], { cwd: dir });
      assert.equal(r.code, 1);
      const tokens = tokensOf(r.stdout);
      assert.deepEqual(tokens, [
        { op: 'orchestration', token: 'malformed-preserved' },
        { op: 'gates', token: 'seeded' },
        { op: 'autonomy', token: 'seeded' },
        { op: 'scripts', token: 'seeded' },
      ]);
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
      assert.deepEqual(tokens.map((t) => t.token), ['seeded', 'failed', 'seeded', 'seeded']);
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
      assert.deepEqual(tokens.at(-1), { op: 'scripts', token: 'failed' });
      assert.match(r.stdout, /symlink/);
      assert.deepEqual(readdirSync(join(dir, 'elsewhere')), [], 'nothing was written through the link');
    });
  });
});
