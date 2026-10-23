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
import { createHash } from 'node:crypto';
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

const BUNDLE = fileURLToPath(new URL('../references/scripts/', import.meta.url));
const INDEX_NOT_RUN = 'the navigator step did not run: a replace run runs it only after every step it re-runs succeeds';
// The spec layer at its bundled bodies, each name in `edited` holding an edit of its own instead, beside an edited kit script.
const edit = (name) => `// my own ${name}\n`;
const CAPS = join('scripts', 'archive-caps.mjs');
const withSpecLayer = (fn, edited = ['check-docs-size.mjs']) => withProject((dir) => {
  mkdirSync(join(dir, 'scripts'));
  for (const name of ['spec-schema.mjs', 'spec-schema.test.mjs', 'check-docs-size.mjs', 'check-docs-size.test.mjs', 'archive-caps.mjs']) writeFileSync(join(dir, 'scripts', name), [...edited, 'archive-caps.mjs'].includes(name) ? edit(name) : readFileSync(join(BUNDLE, name)));
  return fn(dir);
});
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const DIGEST = sha256(`scripts/check-docs-size.mjs ${sha256(edit('check-docs-size.mjs'))}`);
const digestOf = (stdout) => stdout.match(/--replace-custom ([0-9a-f]{64})/)?.[1];
const blockOf = (stdout) => stdout.split('\n').filter((l) => /^ {2}\S/.test(l) && !/^ {2}(?:[a-z-]+: [a-z-]+$|part of this configuration run did NOT complete)/.test(l));

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
      assert.deepEqual(tokensOf(second.stdout)[5], { op: 'scripts', token: 'not-placed' }, 'no kit script stands in scripts/ on the second run either');
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
      assert.equal(existsSync(join(dir, 'scripts', 'spec-schema.mjs')), true);
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

describe('spec:distribution-files/S8 one replace block over the specs entries after every op line, and its usage refusals', () => {
  const refusing = (dir) => ({ deps: { writeFile: (p, ...rest) => { if (String(p).startsWith(join(dir, 'scripts'))) throw Object.assign(new Error('EACCES: refused'), { code: 'EACCES' }); return writeFileSync(p, ...rest); } } });
  for (const [label, flags, failing] of [['a plain run', [], false], ['a dry run', ['--dry-run'], false], ['an --only specs run', ['--only', 'specs'], false], ['a run whose scripts op fails', [], true]]) {
    it(`${label}: one block after every op line and before any failure footer, its digest binding the specs entries, the edited kit script no line of it; none over empty entries`, () => withSpecLayer((dir) => {
      const r = main(['--reconcile', ...flags, '--cwd', dir], failing ? refusing(dir) : {}), lines = r.stdout.split('\n');
      const at = lines.findLastIndex((l) => /^ {2}[a-z-]+: [a-z-]+$|^ {6}/.test(l)) + 1, end = (lines.indexOf('', at + 1) + 1 || lines.length + 1) - 1, [block, tail] = [lines.slice(at + 1, end), lines.slice(end)];
      assert.deepEqual({ code: r.code, gap: lines[at], block: block.length, commands: lines.filter((l) => l.includes('--replace-custom')).length, tail: tail.length, footer: tail[1]?.startsWith('  part of this configuration run did NOT complete'), scripts: tokensOf(r.stdout).find((t) => t.op === 'scripts')?.token }, { code: failing ? 1 : 0, gap: '', block: 2, commands: 1, tail: failing ? 2 : 0, footer: failing || undefined, scripts: failing ? 'failed' : flags.length === 0 ? 'seeded' : flags[0] === '--dry-run' ? 'would-seed' : undefined }, r.stdout);
      assert.deepEqual([block[0].startsWith("  scripts/check-docs-size.mjs: carries an edit — on the user's yes it is kept aside at "), block[1].startsWith("  only on the user's yes, keep aside and replace the files named above: node ") && block[1].includes(` --replace-custom ${DIGEST} --cwd `), readFileSync(join(dir, CAPS), 'utf8')], [true, true, label === 'a plain run' ? readFileSync(join(BUNDLE, 'archive-caps.mjs'), 'utf8') : edit('archive-caps.mjs')], `the block over the specs entry; the scripts op writes the edited kit script, a dry, --only specs or failed run leaves it\n${r.stdout}`);
      if (!failing) withSpecLayer((current) => assert.deepEqual(blockOf(main(['--reconcile', ...flags, '--cwd', current]).stdout), [], 'every spec-layer script current, a kit script edited: no block'), []);
    }));
  }
  it('a refused specs survey, a throw included, adds no entry and prints no block, on a plain and an --only specs run', () => {
    const throwing = (dir) => ({ deps: { lstat: (p, ...rest) => { if (String(p) === join(dir, 'scripts', 'spec-schema.mjs')) throw Object.assign(new Error('EACCES: unreadable'), { code: 'EACCES' }); return lstatSync(p, ...rest); } } });
    const linked = (dir) => { rmSync(join(dir, 'scripts', 'spec-schema.mjs')); symlinkSync(join(dir, 'package.json'), join(dir, 'scripts', 'spec-schema.mjs')); return {}; };
    for (const [opening, ctxOf] of [['wrong-node-kind — scripts/spec-schema.mjs: exists but is a symlink', linked], ['unexpected-error — specs: EACCES: unreadable', throwing]]) {
      for (const flags of [[], ['--only', 'specs']]) withSpecLayer((dir) => {
        const r = main(['--reconcile', ...flags, '--cwd', dir], ctxOf(dir)), lines = r.stdout.split('\n');
        assert.deepEqual({ code: r.code, refused: lines[lines.indexOf('  specs: failed') + 1]?.startsWith(`      ${opening}`), block: blockOf(r.stdout) }, { code: 1, refused: true, block: [] }, `${flags.join(' ')}\n${r.stdout}`);
      });
    }
  });
  it('--only scripts prints no block: the scripts op writes the edited kit script and the specs op is not surveyed', () => withSpecLayer((dir) => {
    const r = main(['--reconcile', '--only', 'scripts', '--cwd', dir]);
    assert.deepEqual({ code: r.code, ops: tokensOf(r.stdout).map((t) => t.op), block: blockOf(r.stdout), caps: readFileSync(join(dir, CAPS), 'utf8') }, { code: 0, ops: ['scripts'], block: [], caps: readFileSync(join(BUNDLE, 'archive-caps.mjs'), 'utf8') }, r.stdout);
  }));
  it('--replace-custom with --only, with --dry-run, with an empty value or given twice: usage exit 2, nothing run; the --only refusal names the spec layer, then the navigator', () => withSpecLayer((dir) => {
    const [before, R] = [snapshot(dir), '--replace-custom'];
    for (const argv of [[R, DIGEST, '--only', 'specs'], [R, DIGEST, '--only', 'scripts'], [R, DIGEST, '--dry-run'], [R, ''], [`${R}=`], [R, DIGEST, `${R}=${DIGEST}`]]) {
      const r = main(['--reconcile', ...argv, '--cwd', dir]);
      assert.deepEqual({ code: r.code, stdout: r.stdout, opening: r.stderr.startsWith('ensure-configs: '), names: r.stderr.includes(R), tree: snapshot(dir) }, { code: 2, stdout: '', opening: true, names: true, tree: before }, argv.join(' '));
      if (argv.includes('--only')) assert.equal(r.stderr.trimEnd(), 'ensure-configs: --replace-custom runs the spec layer, then the navigator, so it cannot be combined with --only — nothing was run');
    }
  }));
});

describe('spec:distribution-files/S9 the replace run through the command', () => {
  const run = (dir, digest, ctx) => main(['--reconcile', '--replace-custom', digest, '--cwd', dir], ctx);
  const failed = (r, opening) => { const lines = r.stdout.split('\n'); assert.deepEqual({ code: r.code, tokens: tokensOf(r.stdout), opens: lines[lines.indexOf('  specs: failed') + 1]?.startsWith(`      ${opening}`), block: blockOf(r.stdout) }, { code: 1, tokens: [{ op: 'specs', token: 'failed' }], opens: true, block: [] }, r.stdout); };
  it('a matching digest keeps each edit at its named path with its bytes, replaces it and runs index: specs, then index, no scripts line, no block; a second run of the line changes nothing', () => withSpecLayer((dir) => {
    const plain = main(['--reconcile', '--dry-run', '--cwd', dir]).stdout, kept = [...plain.matchAll(/^ {2}(\S+): carries an edit — on the user's yes it is kept aside at (\S+), then/gm)], r = run(dir, digestOf(plain));
    assert.deepEqual({ code: r.code, tokens: tokensOf(r.stdout), banner: r.stdout.split('\n')[0], block: blockOf(r.stdout), caps: readFileSync(join(dir, CAPS), 'utf8'), config: existsSync(join(dir, CONFIG_REL)) }, { code: 0, tokens: [{ op: 'specs', token: 'seeded' }, { op: 'index', token: 'regenerated' }], banner: 'ensure-configs (--reconcile, --replace-custom)', block: [], caps: edit('archive-caps.mjs'), config: false }, r.stdout);
    assert.deepEqual(kept.map(([, rel, at]) => [rel, readFileSync(join(dir, at), 'utf8'), readFileSync(join(dir, rel), 'utf8')]), ['check-docs-size.mjs', 'spec-schema.mjs'].map((name) => [`scripts/${name}`, edit(name), readFileSync(join(BUNDLE, name), 'utf8')]), 'each edit kept at its named path with its bytes, the bundled body in place');
    const after = snapshot(dir);
    assert.deepEqual([run(dir, digestOf(plain)).code, snapshot(dir)], [0, after], 'a second run of the line changes nothing');
  }, ['check-docs-size.mjs', 'spec-schema.mjs']));
  it('a differing digest: the tree byte-identical, exit 1, no index line, the failed specs line ends on the navigator step, a fresh block', () => withSpecLayer((dir) => {
    const [before, r] = [snapshot(dir), run(dir, 'f'.repeat(64))];
    assert.deepEqual({ code: r.code, tokens: tokensOf(r.stdout), tree: snapshot(dir), digest: digestOf(r.stdout), block: blockOf(r.stdout).length, last: r.stdout.split('\n\n')[0].split('\n').filter((l) => l.startsWith('      ')).at(-1) }, { code: 1, tokens: [{ op: 'specs', token: 'failed' }], tree: before, digest: DIGEST, block: 2, last: `      ${INDEX_NOT_RUN}` }, r.stdout);
  }));
  it('a keep-aside failure: write-refused, the edit unchanged, no block and no replace command', () => withSpecLayer((dir) => {
    mkdirSync(join(dir, '.agent-workflow'));
    writeFileSync(join(dir, '.agent-workflow', '.gitignore'), '!kept-aside/\n');
    failed(run(dir, DIGEST), 'write-refused — .agent-workflow/.gitignore: holds other bytes');
    assert.equal(readFileSync(join(dir, 'scripts', 'check-docs-size.mjs'), 'utf8'), edit('check-docs-size.mjs'));
  }));
  it('a per-file failure: a bound file changed before its own write, race-unresolved, no block and no replace command', () => withSpecLayer((dir) => {
    const [scripts, digest] = [join(dir, 'scripts'), digestOf(main(['--reconcile', '--dry-run', '--cwd', dir]).stdout)];
    const writeFile = ((moved = false) => (p, body, opts) => { if (!moved && String(p).startsWith(scripts)) { moved = true; writeFileSync(join(scripts, 'check-docs-size.test.mjs'), '// changed\n'); } return writeFileSync(p, body, opts); })();
    failed(run(dir, digest, { deps: { writeFile } }), 'race-unresolved — scripts/check-docs-size.test.mjs: changed after this run read it');
  }, ['check-docs-size.mjs', 'check-docs-size.test.mjs']));
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
