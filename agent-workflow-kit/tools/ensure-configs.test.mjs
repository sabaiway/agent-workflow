// ensure-configs.test.mjs — the CLI contract of the ONE ensure command.
//
// The ops themselves are covered in ensure-ops.test.mjs. What is pinned HERE is everything the mode
// doc now relies on when it invokes this tool exactly once: --reconcile is required, --dry-run writes
// nothing at all, the ops run in a FIXED order, `--only <op>` narrows the run to exactly one of
// them, one op's failure never skips the rest, and the exit code says whether anything failed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

const BUNDLE = fileURLToPath(new URL('../references/scripts/', import.meta.url));
const INDEX_NOT_RUN = 'the navigator step did not run: a replace run runs it only after the spec layer succeeds';
const withCustomChecker = (fn) => withProject((dir) => {
  mkdirSync(join(dir, 'scripts'));
  for (const name of ['spec-schema.mjs', 'spec-schema.test.mjs', 'check-docs-size.mjs', 'check-docs-size.test.mjs']) {
    writeFileSync(join(dir, 'scripts', name), readFileSync(join(BUNDLE, name)));
  }
  writeFileSync(join(dir, 'scripts', 'check-docs-size.mjs'), '// my own checker\n');
  const preview = main(['--reconcile', '--only', 'specs', '--cwd', dir]);
  const digest = preview.stdout.match(/--replace-custom ([0-9a-f]{64})/)?.[1];
  return fn(dir, digest);
});

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
      assert.deepEqual(tokensOf(first.stdout).map((t) => t.token), ['seeded', 'seeded', 'seeded', 'seeded', 'not-placed', 'seeded', 'seeded', 'seeded', 'regenerated']);
      assert.equal(existsSync(join(dir, 'docs', 'ai', 'specs', 'index.md')), true, 'the spec store root landed');
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

describe('spec:docs-navigator/S6 the replace run and its usage refusals', () => {
  it('--replace-custom is refused with --only specs, --only index, --dry-run and an empty value, nothing run', () => {
    withCustomChecker((dir, digest) => {
      const before = snapshot(dir);
      for (const [argv, message] of [
        [['--replace-custom', digest, '--only', 'specs'], /cannot be combined/],
        [['--replace-custom', digest, '--only', 'index'], /cannot be combined/],
        [['--replace-custom', digest, '--dry-run'], /cannot be combined/],
        [['--replace-custom', ''], /needs the digest/],
        [['--replace-custom='], /needs the digest/],
      ]) {
        const result = main(['--reconcile', ...argv, '--cwd', dir]);
        assert.equal(result.code, 2, result.stderr);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /^ensure-configs: /);
        assert.match(result.stderr, /--replace-custom/);
        assert.deepEqual(snapshot(dir), before);
        assert.match(result.stderr, message);
      }
    });
  });
  it('the matching digest runs specs with it and then index, and no other op', () => {
    withCustomChecker((dir, digest) => {
      const result = main(['--reconcile', '--replace-custom', digest, '--cwd', dir]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(digest, /^[0-9a-f]{64}$/);
      assert.deepEqual(tokensOf(result.stdout), [
        { op: 'specs', token: 'seeded' },
        { op: 'index', token: 'regenerated' },
      ]);
      assert.equal(result.stdout.split('\n')[0], 'ensure-configs (--reconcile, --replace-custom)');
      assert.deepEqual(readFileSync(join(dir, 'scripts', 'check-docs-size.mjs')), readFileSync(join(BUNDLE, 'check-docs-size.mjs')));
      assert.equal(existsSync(join(dir, CONFIG_REL)), false, 'the other ops never ran');
    });
  });
  it('a refused digest leaves the whole tree byte-identical and runs no index op', () => {
    withCustomChecker((dir) => {
      const before = snapshot(dir);
      assert.equal(existsSync(join(dir, 'docs', 'ai', 'index.md')), false);
      const result = main(['--reconcile', '--replace-custom', 'f'.repeat(64), '--cwd', dir]);
      assert.equal(result.code, 1, result.stderr);
      assert.deepEqual(snapshot(dir), before);
      assert.equal(existsSync(join(dir, 'docs', 'ai', 'index.md')), false);
      assert.match(result.stdout, /^ {2}specs: failed$/m);
      assert.doesNotMatch(result.stdout, /^ {2}index:/m);
      const specsBlock = result.stdout.split('\n\n')[0];
      const details = specsBlock.split('\n').filter((line) => line.startsWith('      '));
      assert.equal(details.at(-1), `      ${INDEX_NOT_RUN}`);
    });
  });
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

// The installer set: the hook installer and its two suites, refreshed as one by the scripts op. Imported
// dynamically, and the fixtures read lazily, so a tree without them fails each cell, never the load.
const { INSTALLER_SET = [] } = await import('./script-priors.mjs');
const KIT = fileURLToPath(new URL('../', import.meta.url));
const PRIOR_AT = { 'install-git-hooks.mjs': '4.0.0', 'install-git-hooks.test.mjs': '7.2.0', 'install-git-hooks-repo-exec.test.mjs': '4.0.0' };
const [SET, SEEDS] = [Object.keys(PRIOR_AT), ['archive-decisions.mjs', 'archive-decisions.test.mjs', 'markdown-blocks.mjs', 'markdown-blocks.test.mjs']];
const [prior, bundled] = [(name) => readFileSync(join(KIT, 'test', 'fixtures', 'script-priors', PRIOR_AT[name], `${name}.txt`)), (name) => readFileSync(join(BUNDLE, name))];
const setOf = (body, names = SET) => Object.fromEntries(names.map((name) => [name, body(name)]));
const put = (dir, bodies) => { mkdirSync(join(dir, 'scripts'), { recursive: true }); for (const [name, body] of Object.entries(bodies)) writeFileSync(join(dir, 'scripts', name), body); };
const scripts = (dir, ctx, ...flags) => main(['--reconcile', '--only', 'scripts', ...flags, '--cwd', dir], ctx);
const [details, memberLines] = [(stdout) => stdout.split('\n').filter((l) => l.startsWith('      ')).map((l) => l.slice(6)), (stdout) => details(stdout).filter((l) => l.startsWith('scripts/install-git-hooks'))];
const each = (text) => SET.map((name) => `scripts/${name}: ${text}`);
const SHIPPED = 'matches a body an earlier release shipped';
const [REFRESHED, CURRENT, WITHHELD] = [`${SHIPPED} — refreshed to the bundled one`, 'already the bundled body — nothing written', 'left as it stands because an edited member withholds the set'];
const CUSTOM = 'carries an edited body — preserved verbatim; an edited member withholds the set, so none of the three is refreshed';
const bytesAre = (dir, names, body) => { for (const n of names) assert.deepEqual(readFileSync(join(dir, 'scripts', n)), body(n), `${n} holds the expected body`); };
// One cell: the members (beside the four ADR files unless adr is false), a setup, one run of the op, its check.
const cell = (bodies, check, { adr = true, ctx, flags = [], setup = () => {}, node = true, same = false } = {}) => withProject((dir) => {
  if (bodies) put(dir, { ...(adr ? setOf(bundled, SEEDS) : {}), ...bodies });
  setup(dir);
  const [before, r] = [snapshot(dir), scripts(dir, typeof ctx === 'function' ? ctx(dir) : ctx, ...flags)];
  check(r, dir);
  if (same) assert.deepEqual(snapshot(dir), before, 'the tree is byte-identical');
}, { node });
// The exit, the token and the member lines exactly; any member line means one per INSTALLER_SET member, in order.
const expect = (r, token, code, members, label = '') => {
  assert.deepEqual({ code: r.code, tokens: tokensOf(r.stdout), members: memberLines(r.stdout) }, { code, tokens: [{ op: 'scripts', token }], members }, `${label}\n${r.stdout}`);
  if (members.length) assert.deepEqual(members.map((l) => l.slice('scripts/'.length, l.indexOf(': '))), [...INSTALLER_SET], label);
};
const fails = (r, opening, members = []) => { expect(r, 'failed', 1, members); assert.ok(details(r.stdout)[0]?.startsWith(opening), r.stdout); };

describe('spec:init-project/S65 the installer set refreshed and a real commit by proof', () => {
  // The GIT_ variables a hook hands its children would aim git at the outer repository, and an inherited
  // NODE_TEST_CONTEXT makes the hook's `node --test` skip every file and exit 0: every spawn drops them.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^git_/i.test(k) && k !== 'NODE_TEST_CONTEXT' && k !== 'NODE_V8_COVERAGE')), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const run = (dir, cmd, ...args) => {
    const r = spawnSync(cmd, args, { cwd: dir, env, encoding: 'utf8' }), out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.ok(!r.error && r.signal === null, `${cmd} ${args.join(' ')} did not run to an exit (${r.error?.code ?? r.signal}): ${out}`);
    return { status: r.status, out };
  };
  const ok = (dir, ...cmd) => { const { status, out } = run(dir, ...cmd); assert.equal(status, 0, out); };
  it('a prior set stops a real commit; the refresh makes the next one pass, both installer suites run', { timeout: 240_000 }, () => withProject((dir) => {
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'fixture@example.com'], ['config', 'user.name', 'fixture']]) ok(dir, 'git', ...args);
    put(dir, { ...setOf(bundled, readdirSync(BUNDLE).filter((n) => n.endsWith('.mjs'))), ...setOf(prior) });
    for (const [rel, type, title] of [['changelog.md', 'log', 'Changelog'], ['known_issues.md', 'issues', 'Known issues']]) writeFileSync(join(dir, 'docs', 'ai', rel), `---\ntype: ${type}\nmaxLines: 200\n---\n\n# ${title}\n`);
    for (const args of [['scripts/check-docs-size.mjs', '--write-index'], ['scripts/install-git-hooks.mjs']]) ok(dir, process.execPath, ...args);
    ok(dir, 'git', 'add', '-A');
    const one = run(dir, 'git', 'commit', '-q', '-m', 'one');
    assert.ok(one.status !== 0 && /(?:✖|not ok \d+ -) a LINKED WORKTREE installs at ITS OWN git-path hooks/.test(one.out), one.out);
    expect(scripts(dir), 'refreshed', 0, each(REFRESHED));
    bytesAre(dir, SET, bundled);
    ok(dir, 'git', 'add', '-A');
    const two = run(dir, 'git', 'commit', '-q', '-m', 'two');
    assert.equal(two.status, 0, two.out);
    for (const re of [/(?:✔|(?<!not )ok \d+ -) a LINKED WORKTREE installs at ITS OWN git-path hooks/, /(?:✔|(?<!not )ok \d+ -) install-git-hooks — the in-place installer under a GIT_DIR-pinned fixture/, /(?:\u2139|#) fail 0(?!\d)/]) assert.match(two.out, re, two.out);
    assert.doesNotMatch(two.out, /skipping running files/i);
  }));
});

describe('spec:init-project/S66 the set rule by its cells', () => {
  const unseeded = (r, dir) => { bytesAre(dir, SET, bundled); assert.deepEqual([SEEDS.filter((n) => existsSync(join(dir, 'scripts', n))), details(r.stdout).filter((l) => /nothing (was )?written/.test(l))], [[], []], 'no ADR file seeded, no line claims nothing was written'); };
  it('each member edited in turn withholds the set: customized-preserved, nothing written', () => {
    for (const edited of SET) cell({ ...setOf(prior), [edited]: '// my own\n' }, (r) => expect(r, 'customized-preserved', 0, SET.map((n) => `scripts/${n}: ${n === edited ? CUSTOM : WITHHELD}`), edited), { same: true });
  });
  it('a prior installer and one prior suite refresh; the absent suite stays absent, named on its line', () => cell(setOf(prior, SET.slice(0, 2)), (r, dir) => {
    expect(r, 'refreshed', 0, [...each(REFRESHED).slice(0, 2), `scripts/${SET[2]}: absent — not placed by this op`]);
    bytesAre(dir, SET.slice(0, 2), bundled);
    assert.equal(existsSync(join(dir, 'scripts', SET[2])), false, 'the absent suite stays absent');
  }));
  it('a bundled installer beside two prior suites: the suites refresh, the installer is already bundled', () => cell({ ...setOf(prior), [SET[0]]: bundled(SET[0]) }, (r, dir) => {
    expect(r, 'refreshed', 0, [each(CURRENT)[0], ...each(REFRESHED).slice(1)]);
    bytesAre(dir, SET, bundled);
  }));
  it('a legacy ADR monolith: the set refreshes, no ADR file seeded, never "nothing written"', () => cell(setOf(prior), (r, dir) => {
    expect(r, 'old-adr-layout-migration-instructed', 0, each(REFRESHED));
    assert.ok(details(r.stdout).some((l) => l.startsWith('scripts/: this project is still on the older ADR layout (old) — the ADR files were not seeded.')), r.stdout);
    unseeded(r, dir);
  }, { adr: false, setup: (dir) => { mkdirSync(join(dir, 'docs', 'ai', 'history')); writeFileSync(join(dir, 'docs', 'ai', 'history', 'decisions-archive.md'), '# archive\n'); } }));
  it('an unreadable ADR layout: failed, the set still refreshed with its lines, no ADR file seeded', () => cell(setOf(prior), (r, dir) => {
    fails(r, 'adr-layout-unverifiable — scripts/: the ADR-store layout could not be read, so the ADR files were not seeded', each(REFRESHED));
    assert.deepEqual(details(r.stdout).slice(1, 4), each(REFRESHED));
    unseeded(r, dir);
  }, { adr: false, ctx: { deps: { statPath: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } } } }));
});

describe('spec:init-project/S67 the dry run and the quiet cells', () => {
  it('--dry-run beside a prior set: would-refresh per member, the tree byte-identical', () => cell(setOf(prior), (r) => expect(r, 'would-refresh', 0, each(`${SHIPPED} — would be refreshed to the bundled one`)), { flags: ['--dry-run'], same: true }));
  it('a prior set beside absent ADR files: seeded, with the refreshed and the copied lines', () => cell(setOf(prior), (r) => {
    expect(r, 'seeded', 0, each(REFRESHED));
    assert.deepEqual(details(r.stdout).filter((l) => l.endsWith(': copied from the bundled scripts')), SEEDS.map((seed) => `scripts/${seed}: copied from the bundled scripts`));
  }, { adr: false }));
  it('a current set: already-present, one already-bundled line per member, nothing written', () => cell(setOf(bundled), (r) => expect(r, 'already-present', 0, each(CURRENT)), { same: true }));
  const [paths, spy] = [[], { deps: { readFile: (p, ...rest) => { paths.push(String(p)); return readFileSync(p, ...rest); } } }];
  it('no member present: no set line, and no bundled member is read', () => cell({}, (r) => {
    expect(r, 'already-present', 0, []);
    assert.deepEqual([r.stdout.includes('install-git-hooks'), paths.filter((p) => p.includes('install-git-hooks'))], [false, []], 'no line names a member, no member body was read');
  }, { ctx: spy }));
  it('no Node evidence: skipped-no-node-evidence, no set line, nothing written', () => cell(null, (r) => expect(r, 'skipped-no-node-evidence', 0, []), { node: false, same: true }));
});

describe('spec:init-project/S68 the failure cells', () => {
  const LAST = `scripts/${SET[2]}`;
  for (const [kind, place] of [['a symlink', (dir) => symlinkSync(join(dir, 'elsewhere.txt'), join(dir, LAST))], ['a directory', (dir) => mkdirSync(join(dir, LAST))]]) {
    it(`the last member ${kind}: wrong-node-kind naming it, nothing written, a link target untouched`, () => cell(setOf(prior, SET.slice(0, 2)), (r, dir) => {
      fails(r, `wrong-node-kind — ${LAST}: exists but is ${kind}`);
      bytesAre(dir, SET.slice(0, 2), prior);
    }, { same: true, setup: (dir) => { writeFileSync(join(dir, 'elsewhere.txt'), 'the link target\n'); place(dir); } }));
  }
  it('the last bundled member unreadable: bundle-unreadable naming it, nothing written', () => cell(setOf(prior), (r) => fails(r, `bundle-unreadable — ${LAST}: the bundled script could not be read`), { same: true, setup: (dir) => put(join(dir, 'kit', 'references'), setOf(bundled, SET.slice(0, 2))), ctx: (dir) => ({ kitRoot: join(dir, 'kit') }) }));
  const refuseSecond = ((n = 0) => ({ deps: { rename: (from, to) => { n += 1; if (n === 2) throw Object.assign(new Error('EACCES: refused'), { code: 'EACCES' }); return renameSync(from, to); } } }))();
  it('a write refused at the second replace: write-refused, the installer refreshed and not rolled back', () => cell(setOf(prior), (r, dir) => {
    fails(r, `write-refused — scripts/${SET[1]}: EACCES: refused`, [each(REFRESHED)[0], each(`${SHIPPED} — not refreshed; its write was refused (above)`)[1], each(`${SHIPPED} — not refreshed; the run stopped before it`)[2]]);
    bytesAre(dir, SET, (n) => (n === SET[0] ? bundled(n) : prior(n)));
    assert.ok(details(r.stdout).includes('the copying stopped PARTWAY — the 1 file(s) named above were already copied and are NOT rolled back'), r.stdout);
    assert.deepEqual(readdirSync(join(dir, 'scripts')).filter((n) => n.endsWith('.tmp')), [], 'no temp file left');
  }, { ctx: refuseSecond }));
});

describe("spec:init-project/S70 shipped text of the set's refresh", () => {
  const [text, header] = [(...rel) => readFileSync(join(KIT, ...rel), 'utf8'), (src) => src.slice(0, src.indexOf('\nimport '))];
  const has = (body, yes, no = []) => { for (const p of yes) assert.ok(body.includes(p), `missing: ${p}`); for (const p of no) assert.equal(body.includes(p), false, `claims: ${p}`); };
  it("upgrade.md: the scripts token list and the enforcement-script paragraph name the set's refresh", () => {
    const doc = text('references', 'modes', 'upgrade.md'), at = doc.indexOf('**What the enforcement-script ensure does.**');
    has(doc.slice(doc.indexOf('scripts → ')).split(';')[0], ['`refreshed`', '`customized-preserved`']);
    has(at === -1 ? '' : doc.slice(at, doc.indexOf('\n', at)), ['the hook installer and its two suites are refreshed together', 'whatever its ADR layout', 'an edited member keeps all three', 'an absent one is never seeded',
      'the `enforcement` check line and apply, by the consent route', 'no ADR file is seeded', 'no ADR file seeded', "the set's refresh lines stand"], ['writes NOTHING', 'writing nothing']);
  });
  it("the ensure-ops.mjs header names the set's refresh and claims no write-nothing", () => has(header(text('tools', 'ensure-ops.mjs')), ["installer set's refresh runs before and independent of that read"], ['writes NOTHING', 'wrote nothing']));
  it("ensure-configs.mjs: its header table's scripts row and --help name the set's refresh", () => {
    const rows = header(text('tools', 'ensure-configs.mjs')).split('\n'), at = rows.findIndex((l) => /^\/\/ {3}scripts /.test(l));
    has(at === -1 ? '' : rows.slice(at, at + 2).join('\n'), ['the hook installer and its two suites refreshed as one set']);
    has(main(['--help']).stdout, ['refreshes the hook installer with its two suites']);
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
      assert.deepEqual(tokens, [
        { op: 'orchestration', token: 'malformed-preserved' },
        { op: 'gates', token: 'seeded' },
        { op: 'autonomy', token: 'seeded' },
        { op: 'vehicles', token: 'seeded' },
        { op: 'executor', token: 'not-placed' },
        { op: 'scripts', token: 'seeded' },
        { op: 'specs', token: 'seeded' },
        { op: 'rules', token: 'seeded' },
        { op: 'index', token: 'regenerated' },
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
      assert.deepEqual(tokens.map((t) => t.token), ['seeded', 'failed', 'seeded', 'seeded', 'not-placed', 'seeded', 'seeded', 'seeded', 'regenerated']);
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
