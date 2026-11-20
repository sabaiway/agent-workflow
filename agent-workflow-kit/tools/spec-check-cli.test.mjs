import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ledgerOf, planWith, write } from './plan-shape-harness.test.mjs';

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
    expectVerdict(r);
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
  it('never TRIMS an op line: a whitespace-wrapped op refuses from a file exactly as it does from --op', async () => {
    const file = opsFile('ops-padded.list', `  modify=${LOGIN}\n`);
    const fromFile = await run(['--root', OK(), '--ops-file', file]);
    const fromFlag = await run(['--root', OK(), '--op', `  modify=${LOGIN}`]);
    assert.equal(fromFile.code, 2, fromFile.stdout);
    assert.equal(fromFlag.code, 2);
    assert.match(fromFile.stderr, /whitespace/);
    assert.match(fromFlag.stderr, /whitespace/);
  });
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
    expectVerdict(r);
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
    expectVerdict(await run(['--op', `modify=${LOGIN}`], { cwd: () => OK() }));
  });
  it('resolves a RELATIVE --root against the cwd, not against the tool directory', async () => {
    expectVerdict(await run(['--root', 'ok', '--op', `modify=${LOGIN}`], { cwd: () => dir }));
  });
  it('takes an ABSOLUTE --root as given, whatever the cwd', async () => {
    expectVerdict(await run(['--root', OK(), '--op', `modify=${LOGIN}`], { cwd: () => join(dir, 'orphan') }));
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
    expectVerdict(await run([`--root=${OK()}`, `--op=modify=${LOGIN}`]));
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

const STORE_ROOT = 'docs/ai/specs/index.md';
const RATES = 'docs/ai/specs/billing/rates.md';
const PLAN = 'docs/plans/revision.md';
const HOME = 'docs/plans/revision.specs';
const home = (path) => path.replace('docs/ai/specs', HOME);
const makePlanTree = () => {
  const root = mkdtempSync(join(dir, 'plan-'));
  cpSync(OK(), root, { recursive: true });
  const at = (path) => join(root, path);
  const put = (path, text) => write(root, path, text);
  const check = (...args) => run(['--root', root, ...args]);
  const plan = (...rows) => put(PLAN, planWith({ ledger: ledgerOf(rows.map(([verb, path], index) =>
    `T${index + 1} | ${verb} | ${path} | update the fixture | ${verb === 'delete' ? '— | —' : `n/a | ${path}:1`}`).join('\n')) }));
  return { at, put, check, plan, get: (path) => readFileSync(at(path), 'utf8'), judge: (...extra) => check('--plan', PLAN, ...extra) };
};
const expectVerdict = (result, code = 0, cause, path) => {
  const output = code === 2 ? result.stderr : result.stdout;
  assert.equal(result.code, code, result.stderr || result.stdout);
  if (code === 0) assert.match(output, /^spec-check: ACCEPT/);
  if (cause) assert.match(output, cause);
  if (path) assert.ok(output.includes(path), output);
};
const withLink = async (t, path, target, check) => {
  try { symlinkSync(target, path); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    t.diagnostic(`sandbox refused symlinkSync: ${error.code}: ${path}`);
    return;
  }
  try { await check(); } finally { rmSync(path); }
};
const withoutRead = async (t, path, check) => {
  if (process.getuid?.() === 0) { t.diagnostic(`root can read ${path} with mode 0`); return; }
  const mode = statSync(path).mode;
  const restore = () => chmodSync(path, mode);
  chmodSync(path, 0);
  t.after(restore);
  try { await check(); } finally { restore(); }
};

// spec:spec-check/S9
it('uses the in-flight shape verdict to cover drafts and reports plan read failures', async (t) => {
  const { at, put, check, plan, get } = makePlanTree();
  const pin = 'package-content.test.mjs';
  const bound = [['create', 'src/pending/index.mjs'], ['modify', pin], ['create', 'src/extra.mjs'], ['modify', pin], ['create', BILLING]];
  put('package.json', '{}');
  put(pin, '');
  put(BILLING, get(BILLING).replace('src/billing/', 'src/pending/'));
  const all = () => check('--all');
  plan(...bound);
  expectVerdict(await all());
  for (const rows of [[...bound, ['typo', 'other.md']], [...bound.slice(0, 2), ['modify', 'src/extra.mjs'], ...bound.slice(3)]]) {
    plan(...rows);
    expectVerdict(await all(), 1, /: module\b/, PLAN);
  }
  plan(...bound);
  for (const path of ['docs/plans', 'docs']) {
    const saved = at('saved');
    renameSync(at(path), saved);
    expectVerdict(await all(), path === 'docs' ? 2 : 1, path === 'docs' ? /store root/ : /: module\b/);
    for (const target of path === 'docs' ? [saved] : [saved, at('missing')]) {
      await withLink(t, at(path), target, async () => expectVerdict(await all(), 2, /symlink|symbolic link/i, path));
    }
    renameSync(saved, at(path));
  }
  for (const path of ['docs/plans', PLAN]) {
    await withoutRead(t, at(path), async () => expectVerdict(await all(), 2, /read|list|EACCES/i, path));
  }
});

// spec:spec-check/S10
it('judges store rows from the exact --plan operand and names usage errors', async () => {
  const { put, get, plan, check, judge, at } = makePlanTree();
  const navigator = 'docs/ai/specs/team/index.md';
  const root = get(STORE_ROOT) + '- [team](./team/index.md)\n';
  const child = root.replace(/> Up:.*\n/, '').replace(/(## Children\n)[\s\S]*/, '$1');
  put(navigator, child);
  put(STORE_ROOT, root);
  const navRow = ['create', navigator];
  const rootRow = ['modify', STORE_ROOT];
  for (const [rows, path, broken, rule] of [
    [[['create', BILLING], ['create', RATES], navRow]],
    [[navRow, rootRow], navigator, child + '- invalid child\n', /children-link\b/],
    [[rootRow], STORE_ROOT, root.replace('./login.md', './missing.md'), /: link\b/],
  ]) {
    plan(...rows);
    expectVerdict(await judge());
    if (!path) continue;
    const original = get(path);
    put(path, broken);
    expectVerdict(await judge(), 1, rule, path);
    put(path, original);
  }
  const valid = get(PLAN);
  for (const [body, cause] of [[valid.replace('# Plan:', '# Notes:'), /in.flight/i], [valid + '\n~~~\n', /block-model|fence/],
    [valid.replace('## Module ledger', '## Notes'), /ledger|headings/i], [valid.replace(' | modify | ', ' | typo | '), /row-grammar|six valid fields/], ...['docs/ai/specs/kit/**/*.{md,txt}', 'docs/**/*.md'].map((sweep) => [valid.replace(/T1 \| modify \| .*/, `T1 | modify | ${sweep} | update the fixture (2 files) | n/a | ${STORE_ROOT}:1`), /op-sweep — T1/])]) {
    put(PLAN, body);
    expectVerdict(await judge(), 2, cause, PLAN);
  }
  for (const verb of ['create', 'delete']) { plan([verb, STORE_ROOT]); expectVerdict(await judge(), 2, /store root|op-root/i); }
  put(PLAN, valid);
  expectVerdict(await check('--plan', `./${PLAN}`), 2, /spelling|repo.relative|docs\/plans\//i);
  for (const args of [['--all'], ['--op', `modify=${LOGIN}`], ['--ops-file', opsFile('plan-ops.list', `modify=${LOGIN}\n`)]]) {
    expectVerdict(await judge(...args), 2, /exclusive|combin|together/i, args[0]);
  }
  put(PLAN, planWith({ ledger: ledgerOf('T1 | create | src/extra.mjs | add the fixture | n/a | src/extra.mjs:1\nT2 | modify | **/package.json | bump the fixture (1 files) | n/a | src/extra.mjs:1') }));
  expectVerdict(await judge(), 0, /the plan names no store document/);
  expectVerdict(await check('--all'));
  rmSync(at(STORE_ROOT));
  expectVerdict(await judge(), 0, /the plan names no store document/);
  expectVerdict(await check('--all'), 2, /store root/);
});

// spec:spec-check/S11
it('overlays home revisions, proves store targets and checks the census before landing', async (t) => {
  const { at, put, get, plan, check, judge } = makePlanTree();
  const fees = 'docs/ai/specs/billing/fees.md';
  const ground = 'src/pending/index.mjs';
  const closed = 'docs/ai/specs/closed';
  const live = get(BILLING).replace('status: draft', 'status: live');
  const revision = live.replace('revision: 2', 'revision: 3').replace('src/billing/', 'src/pending/').replaceAll('rates', 'fees');
  const part = get(RATES).replace('# Part: rates', '# Part: fees');
  const rows = [['modify', BILLING], ['create', fees], ['create', ground]];
  const remove = ['delete', RATES];
  put(BILLING, live);
  put(home(BILLING), revision);
  put(home(fees), part);
  plan(...rows, remove);
  expectVerdict(await judge());
  expectVerdict(await check('--all'));
  plan(...rows);
  expectVerdict(await judge(), 1, /: unlisted-child\b/, RATES);
  plan(...rows, remove);
  for (const [path, bytes, rule, named] of [[home(BILLING), revision + '- [rates](./rates.md)\n', /: link\b/, BILLING],
    [home(BILLING), revision.replace('src/pending/', 'src/login/'), /: overlap\b/, LOGIN],
    [fees, part + '\nDifferent bytes.\n', /: revision-home\b/, fees], [`${HOME}/notes.txt`, 'foreign entry', /: revision-home\b/, 'notes.txt'], [home(BILLING), revision.replace('kind: spec', 'kind: index'), /: revision-home\b/, 'revision.specs/billing/'], [BILLING, live.replace('status: live', 'status: draft'), /: revision-home\b/, 'revision.specs/billing/']]) {
    const original = existsSync(at(path)) ? get(path) : null;
    put(path, bytes);
    expectVerdict(await judge(), 1, rule, named);
    if (original === null) rmSync(at(path)); else put(path, original);
  }
  for (const [path, rule] of [[HOME, 'revision-home'], [home(fees), 'revision-home'], [BILLING, 'revision-home'], [RATES, 'census'], [closed, 'census']]) {
    const saved = at('saved');
    if (path !== closed) renameSync(at(path), saved);
    if (path === BILLING) expectVerdict(await judge(), 1, /: revision-home\b/, BILLING);
    const target = path === closed ? join(OK(), 'docs/ai/specs/billing') : saved;
    await withLink(t, at(path), target, async () => expectVerdict(await judge(), 1, new RegExp(`: ${rule}\\b`), path));
    if (path !== closed) renameSync(saved, at(path));
  }
  mkdirSync(at(closed));
  for (const [path, rule] of [[closed, 'census'], [HOME, 'revision-home']]) {
    await withoutRead(t, at(path), async () => expectVerdict(await judge(), 1, new RegExp(`: ${rule}\\b`), path));
  }
  const retired = revision.replace('status: live', 'status: retired');
  for (const [path, bytes, all] of [[RATES, null], [ground, ''], [home(BILLING), retired], [fees, part], [BILLING, retired, true],
    [fees, null], [fees, part, true], [home(BILLING), null, true], [home(fees), null, true]]) {
    if (bytes === null) rmSync(at(path)); else put(path, bytes);
    expectVerdict(await judge());
    if (all) expectVerdict(await check('--all'));
  }
});
