import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// CLI suite for the structural checker: argv, the two op sources and their union, the --all
// exclusion, the --root resolution and a real subprocess smoke over the committed fixture stores.
// The rules themselves are the core suite's; this file pins only the edges around them.
//
// Reached by DYNAMIC import inside each case, like the core suite: a static import of an absent
// module makes the suite unresolvable, and an unresolvable suite cannot be OBSERVED red.
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'spec-check-cli.mjs');
const FIXTURES = join(HERE, '..', 'test', 'fixtures', 'spec-check');
const load = () => import('./spec-check-cli.mjs');
const run = async (argv, deps) => (await load()).main(argv, deps);

const LOGIN = 'docs/ai/specs/login.md';
const BILLING = 'docs/ai/specs/billing/index.md';

let dir;
let hidden;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'spec-check-cli-'));
  hidden = join(dir, '.claude', 'skills', 'agent-workflow-kit', 'worktree');
  mkdirSync(hidden, { recursive: true });
  cpSync(join(FIXTURES, 'store-ok'), join(dir, 'ok'), { recursive: true });
  cpSync(join(FIXTURES, 'store-unlisted'), join(dir, 'unlisted'), { recursive: true });
  cpSync(join(FIXTURES, 'store-orphan'), join(dir, 'orphan'), { recursive: true });
  cpSync(join(FIXTURES, 'store-ok'), hidden, { recursive: true });
});
after(() => rmSync(dir, { recursive: true, force: true }));

const OK = () => join(dir, 'ok');
const opsFile = (name, text) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

describe('spec-check-cli — the op sources: --op, --ops-file, their union, and the empty source', () => {
  it('accepts a clean session lane from --op alone (exit 0, the verdict on stdout)', async () => {
    const r = await run(['--root', OK(), '--op', `modify=${LOGIN}`]);
    assert.equal(r.code, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /^spec-check: ACCEPT/);
    assert.equal(r.stderr, '');
  });

  it('takes --op repeatedly and unions it with --ops-file, deduping by identity', async () => {
    const file = opsFile('ops-union.list', `modify=${LOGIN}\nmodify=${BILLING}\n`);
    const r = await run(['--root', OK(), '--op', `modify=${LOGIN}`, '--op', `modify=${BILLING}`, '--ops-file', file]);
    assert.equal(r.code, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /3 document\(s\)/, 'two leaves and their ONE shared listing parent, each judged once');
  });

  it('parses blank lines and # comments away, and refuses a file that is only those', async () => {
    const file = opsFile('ops-comments.list', `# the session register\n\nmodify=${LOGIN}\n   \n# trailing note\n`);
    const r = await run(['--root', OK(), '--ops-file', file]);
    assert.equal(r.code, 0, r.stderr || r.stdout);
    const empty = await run(['--root', OK(), '--ops-file', opsFile('ops-empty.list', '# nothing\n\n')]);
    assert.equal(empty.code, 2);
    assert.match(empty.stderr, /op-empty|no op/);
  });

  // The two op sources must accept exactly the same strings. Trimming file lines would give one
  // document a second spelling that only the file lane accepts — the alias the grammar denies.
  it('never TRIMS an op line: a whitespace-wrapped op refuses from a file exactly as it does from --op', async () => {
    const file = opsFile('ops-padded.list', `  modify=${LOGIN}\n`);
    const fromFile = await run(['--root', OK(), '--ops-file', file]);
    const fromFlag = await run(['--root', OK(), '--op', `  modify=${LOGIN}`]);
    assert.equal(fromFile.code, 2, fromFile.stdout);
    assert.equal(fromFlag.code, 2);
    assert.match(fromFile.stderr, /whitespace/);
    assert.match(fromFlag.stderr, /whitespace/);
  });

  // A line ending is not content. Refusing whitespace INSIDE an op is the frozen grammar; refusing a
  // register because it was saved with CRLF would make the main lane unusable on Windows.
  it('reads a CRLF register exactly like an LF one — the line ending never becomes part of an op', async () => {
    const file = opsFile('ops-crlf.list', `# the session register\r\nmodify=${LOGIN}\r\n\r\nmodify=${BILLING}\r\n`);
    const r = await run(['--root', OK(), '--ops-file', file]);
    assert.equal(r.code, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /3 document\(s\)/);
  });

  it('refuses a named-but-missing --ops-file as usage, naming the path (exit 2)', async () => {
    const r = await run(['--root', OK(), '--ops-file', join(dir, 'no-such.list')]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /no-such\.list/);
    assert.match(r.stderr, /unreadable|not readable/);
  });

  // spec:spec-check/S4
  it('refuses an empty op source with no --all (exit 2) — there is no "judge everything" default', async () => {
    const r = await run(['--root', OK()]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--op|--ops-file|--all/);
  });

  it('relays a grammar refusal from the ops parser as usage, one line per bad op (exit 2)', async () => {
    const r = await run(['--root', OK(), '--op', 'add=docs/other/x.md', '--op', 'nope=docs/ai/specs/x.md']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /op-target/);
    assert.match(r.stderr, /op-grammar/);
    assert.equal(r.stdout, '', 'a refused argv never produces a verdict');
  });

  it('refuses the store root as an op target and a self-rename (exit 2)', async () => {
    for (const spec of ['remove=docs/ai/specs/index.md', `rename=${LOGIN}:${LOGIN}`]) {
      const r = await run(['--root', OK(), '--op', spec]);
      assert.equal(r.code, 2, spec);
      assert.match(r.stderr, /op-root|op-role/);
    }
  });
});

describe('spec-check-cli — --all is EXCLUSIVE and judges the whole store', () => {
  it('accepts a clean store under --all alone (exit 0)', async () => {
    const r = await run(['--root', OK(), '--all']);
    assert.equal(r.code, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /^spec-check: ACCEPT/);
  });

  // spec:spec-check/S5
  it('refuses --all mixed with either op source (exit 2)', async () => {
    for (const extra of [['--op', `modify=${LOGIN}`], ['--ops-file', opsFile('ops-mixed.list', `modify=${LOGIN}\n`)]]) {
      const r = await run(['--root', OK(), '--all', ...extra]);
      assert.equal(r.code, 2, extra.join(' '));
      assert.match(r.stderr, /--all/);
      assert.match(r.stderr, /exclusive/);
    }
  });

  it('finds the unlisted child and the orphan in their fixture stores (exit 1, one finding each)', async () => {
    const unlisted = await run(['--root', join(dir, 'unlisted'), '--all']);
    assert.equal(unlisted.code, 1);
    assert.match(unlisted.stdout, /unlisted-child/);
    assert.ok(!unlisted.stdout.includes('orphan'), 'an unlisted child is not reported as an orphan');
    const orphan = await run(['--root', join(dir, 'orphan'), '--all']);
    assert.equal(orphan.code, 1);
    assert.match(orphan.stdout, /orphan/);
  });

  it('refuses an --all run whose store root is absent (exit 2), never an empty clean report', async () => {
    const r = await run(['--root', dir, '--all']);
    assert.equal(r.code, 2);
    assert.match(`${r.stdout}${r.stderr}`, /store root/);
  });
});

describe('spec-check-cli — the --root triple: default, relative and absolute', () => {
  it('defaults --root to the process cwd (the run-gates resolution)', async () => {
    const r = await run(['--op', `modify=${LOGIN}`], { cwd: () => OK() });
    assert.equal(r.code, 0, r.stderr || r.stdout);
  });

  it('resolves a RELATIVE --root against the cwd, not against the tool directory', async () => {
    const r = await run(['--root', 'ok', '--op', `modify=${LOGIN}`], { cwd: () => dir });
    assert.equal(r.code, 0, r.stderr || r.stdout);
  });

  it('takes an ABSOLUTE --root as given, whatever the cwd', async () => {
    const r = await run(['--root', OK(), '--op', `modify=${LOGIN}`], { cwd: () => join(dir, 'orphan') });
    assert.equal(r.code, 0, r.stderr || r.stdout);
  });

  it('refuses a --root that is not a directory (exit 2)', async () => {
    const r = await run(['--root', join(OK(), LOGIN), '--all']);
    assert.equal(r.code, 2);
    assert.match(`${r.stdout}${r.stderr}`, /--root/);
  });
});

describe('spec-check-cli — argv edges and help', () => {
  it('refuses an unknown flag, a flag with no value and a positional argument (exit 2)', async () => {
    for (const argv of [['--nope', 'x'], ['--root'], ['stray']]) {
      const r = await run(argv);
      assert.equal(r.code, 2, argv.join(' '));
      assert.match(r.stderr, /^spec-check: /);
    }
  });

  it('accepts the --flag=value spelling', async () => {
    const r = await run([`--root=${OK()}`, `--op=modify=${LOGIN}`]);
    assert.equal(r.code, 0, r.stderr || r.stdout);
  });

  it('--help and -h print the usage, name every flag and both lanes, exit 0', async () => {
    for (const flag of ['--help', '-h']) {
      const r = await run([flag]);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /Usage:/);
      for (const token of ['--op', '--ops-file', '--all', '--root', 'add', 'modify', 'remove', 'rename', 'advisory']) {
        assert.ok(r.stdout.includes(token), `${flag} names "${token}"`);
      }
      assert.equal(r.stderr, '');
    }
  });

  it('--help wins over an otherwise invalid argv (a user asking for help is never lectured)', async () => {
    const r = await run(['--nope', '--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage:/);
  });

  it('main() never exits the process — every arm returns { code, stdout, stderr }', async () => {
    for (const argv of [['--help'], ['--root', OK(), '--all'], ['--nope']]) {
      const r = await run(argv);
      assert.deepEqual(Object.keys(r).sort(), ['code', 'stderr', 'stdout']);
      assert.equal(typeof r.code, 'number');
    }
  });
});

describe('spec-check-cli — every path it prints is repo-relative (hidden-mode identical)', () => {
  it('reports the SAME bytes for the same store under a visible root and a hidden-mode one', async () => {
    const visible = await run(['--root', OK(), '--op', `modify=${LOGIN}`]);
    const inHidden = await run(['--root', hidden, '--op', `modify=${LOGIN}`]);
    assert.equal(visible.code, inHidden.code);
    assert.equal(visible.stdout, inHidden.stdout, 'no absolute path leaks into the report');
  });

  it('names findings by their repo-relative path, never by an absolute one', async () => {
    const r = await run(['--root', join(dir, 'unlisted'), '--all']);
    assert.match(r.stdout, /docs\/ai\/specs\/login\.md/);
    assert.ok(!r.stdout.includes(dir), 'the temp root never appears in the report');
  });
});

describe('spec-check-cli — the IO door: a fail-closed CLASSIFICATION, never a boolean', () => {
  it('probe names each state, and anything it cannot stat is "unreadable" rather than "absent"', async () => {
    const { probe, realpath, list } = await load();
    const link = join(dir, 'a-symlink');
    if (!existsSync(link)) symlinkSync(join(OK(), LOGIN), link);
    assert.equal(probe(OK()), 'dir');
    assert.equal(probe(join(OK(), LOGIN)), 'file');
    assert.equal(probe(join(dir, 'no-such-thing')), 'absent');
    assert.equal(probe(link), 'symlink', 'a symlink is its own state — it is never followed to decide what sits at a path');
    assert.equal(probe(join(OK(), LOGIN, 'through-a-file')), 'unreadable', 'ENOTDIR is not absence');
    assert.equal(realpath(join(dir, 'no-such-thing')), null);
    assert.equal(realpath(OK()), realpathSync(OK()));
    assert.equal(list(join(OK(), LOGIN)), null, 'a listing of something that is not a directory is null, never a throw');
    assert.ok(list(OK()).includes('docs'));
  });
});

describe('spec-check-cli — subprocess smoke (the pasted command really runs)', () => {
  const smoke = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

  it('ACCEPT exits 0 in a real process, over the real filesystem', () => {
    const r = smoke(['--root', join(FIXTURES, 'store-ok'), '--all']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ACCEPT/);
  });

  it('REFUSE exits 1 in a real process', () => {
    const r = smoke(['--root', join(FIXTURES, 'store-unlisted'), '--all']);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /unlisted-child/);
  });

  it('a usage refusal exits 2 in a real process, on stderr', () => {
    const r = smoke(['--root', join(FIXTURES, 'store-ok'), '--op', 'add=docs/other/x.md']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /spec-check: /);
  });

  it('--help exits 0 in a real process', () => {
    const r = smoke(['--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Usage:/);
  });
});
