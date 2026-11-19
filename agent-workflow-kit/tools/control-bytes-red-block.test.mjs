import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixtures, makeRepo, skipWithoutGit } from './hostile-git-harness.test.mjs';

const { main, CONTROL_BYTES_GIT_ARGV, READ_CAP } = await import('./control-bytes.mjs').catch(() => ({}));
const { runCheckerTail } = await import('./checker-block/index.mjs').catch(() => ({}));
const { judgeBlock } = await import('./checker-verdict/index.mjs').catch(() => ({}));
const ENTRY = fileURLToPath(new URL('./control-bytes.mjs', import.meta.url));
const NAME = 'control-bytes';
const FAIL = `${NAME}: FAIL — `;
const REMEDY = `${NAME}: REMEDY — `;
const UNJUDGED = 'the work tree could not be judged';
const FINDINGS = 'control-byte finding(s)';
const NOT_JUDGED = 'path(s) not judged';
const NOUNS = [UNJUDGED, FINDINGS, NOT_JUDGED];
const RECORDED_USAGE = [
  'usage: node control-bytes.mjs [--check] [--cwd <dir>]',
  '  Refuses any raw C0 or DEL byte (TAB, LF, CR admitted) in the work tree: a path\'s name, a regular',
  '  file\'s content (unless its git attribute says binary or -diff) or a symlink\'s target string.',
  '  --cwd <dir>   anchor at that directory\'s work-tree root (default: the process cwd)',
  '  --check       the gate spelling; the plain run prints the same report and shares the exit table',
  '  exit 0 clean · 1 a finding or a refusal · 2 usage',
];

const withRepo = (body, files) => {
  const r = makeRepo('red-block', files);
  try {
    return body({ ...r, top: realpathSync(r.dir) });
  } finally {
    r.cleanup();
  }
};
const withFixture = (build, body) => {
  const f = build();
  try {
    return body(f);
  } finally {
    f.cleanup();
  }
};
const run = (r, deps = {}) => main(['--check'], { cwd: r.cwd, env: r.env, ...deps });
const failingQuery = (argv) => (cmd, args, opts) => (args.join(' ') === argv.join(' ')
  ? { status: 129, stdout: Buffer.alloc(0), stderr: Buffer.from('boom') }
  : spawnSync(cmd, args, opts));
const lockedOpen = (suffix) => ({
  open: (path, flags) => {
    if (String(path).endsWith(suffix)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return openSync(path, flags);
  },
});
const placeOf = (line) => line.slice(0, line.indexOf(': '));
const readBlock = (result, classes, places, counts = []) => {
  const text = result.lines.join('\n');
  assert.equal(result.code, 1, text);
  const lines = text.split('\n');
  assert.ok(lines[0].startsWith(FAIL), text);
  assert.equal(lines.filter((line) => line.startsWith(FAIL)).length, 1, text);
  assert.doesNotMatch(text, /control-bytes: REFUSED/u);
  for (const noun of NOUNS) assert.equal(lines[0].split(noun).length - 1, classes.includes(noun) ? 1 : 0, lines[0]);
  assert.deepEqual([...classes].sort((a, b) => lines[0].indexOf(a) - lines[0].indexOf(b)), classes);
  assert.deepEqual(lines[0].match(/\b\d+\b/gu) ?? [], counts.map(String), lines[0]);
  const firstRemedy = lines.findIndex((line) => line.startsWith(REMEDY));
  assert.ok(firstRemedy > 1, text);
  const findings = lines.slice(1, firstRemedy);
  assert.deepEqual(findings.map(placeOf), places, text);
  const remedies = lines.filter((line) => line.startsWith(REMEDY));
  assert.equal(remedies.length, classes.length, text);
  assert.deepEqual(lines.slice(firstRemedy, firstRemedy + remedies.length), remedies);
  assert.deepEqual(judgeBlock(text, { name: NAME, places }), []);
  return { verdict: lines[0], findings, remedies, after: lines.slice(firstRemedy + remedies.length) };
};
const readUnjudged = (result, message) => {
  const block = readBlock(result, [UNJUDGED], ['.']);
  assert.equal(block.verdict, `${FAIL}${UNJUDGED}`);
  if (message instanceof RegExp) assert.match(block.findings[0], message);
  else assert.equal(block.findings[0], `.: ${message}`);
  assert.deepEqual(block.after, []);
  return block.remedies[0];
};

describe('spec:control-bytes/S8 the red classes through main over temp repositories', { skip: skipWithoutGit }, () => {
  it('each state of the work tree not judged is one finding at . and one remedy line, nothing after', () => {
    const remedies = [];
    withFixture(fixtures.notARepository, (f) => remedies.push(readUnjudged(main(['--check'], { cwd: f.cwd, env: f.env }), /^\.: the git location is not-a-repository — /u)));
    withRepo((r) => {
      for (const argv of CONTROL_BYTES_GIT_ARGV) {
        remedies.push(readUnjudged(run(r, { spawn: failingQuery(argv) }), `git ${argv.join(' ')} exited 129 (boom)`));
      }
    });
    withFixture(fixtures.unmerged, (f) => remedies.push(readUnjudged(run(f), 'the git index is UNMERGED (3 conflict-stage entr(ies)) — resolve the conflict, then re-run')));
    withRepo((r) => {
      r.must(['rm', '-q', 'f.txt']);
      r.must(['commit', '-qm', 'empty']);
      remedies.push(readUnjudged(run(r), `the domain is EMPTY — no tracked and no untracked-not-ignored path under ${r.top}`));
    });
    assert.equal(remedies.length, 8);
    assert.equal(new Set(remedies).size, 1, 'one class, one remedy');
  });

  it('control-byte findings and paths not judged, alone and together, in order with the report after them', () => withRepo((r) => {
    r.write('.gitattributes', '*.bin binary\n');
    r.write('blob.bin', 'x\0y');
    r.write('gone.txt', 'g\n');
    r.must(['add', '-A']);
    r.must(['commit', '-qm', 'paths']);
    const report = (findingCount) => [
      `${NAME}: work tree ${r.top}`,
      new RegExp(`^paths judged: \\d+ · skipped by attribute: 1 · skipped by kind: 0 · findings: ${findingCount}$`, 'u'),
      'skipped by attribute: blob.bin',
    ];
    const readAfter = (after, findingCount) => {
      const [workTree, counts, skipped] = report(findingCount);
      assert.equal(after.length, 3, after.join('\n'));
      assert.equal(after[0], workTree);
      assert.match(after[1], counts);
      assert.equal(after[2], skipped);
    };
    r.write('n.txt', 'a\0');
    const bytes = readBlock(run(r), [FINDINGS], ['n.txt'], [1]);
    assert.deepEqual(bytes.findings, ['n.txt: content offset 1: 0x00']);
    assert.deepEqual(bytes.remedies, [`${REMEDY}rename each path whose name contains a refused byte, retarget each symlink whose target contains a refused byte, replace every refused byte in text content with an escape in source, and mark any affected binary file binary in .gitattributes, then re-run`]);
    readAfter(bytes.after, 1);
    rmSync(join(r.dir, 'n.txt'));
    rmSync(join(r.dir, 'gone.txt'));
    r.write('locked.txt', 'l\n');
    writeFileSync(join(r.dir, 'big.txt'), Buffer.alloc(READ_CAP + 1, 0x61));
    const io = lockedOpen('/locked.txt');
    const paths = readBlock(run(r, { io }), [NOT_JUDGED], ['big.txt', 'gone.txt', 'locked.txt'], [3]);
    assert.match(paths.findings[0], new RegExp(`^big\\.txt: over the read cap \\(${READ_CAP} bytes\\)`, 'u'));
    assert.match(paths.findings[1], /^gone\.txt: absent \(tracked but missing from the work tree/u);
    assert.equal(paths.findings[2], 'locked.txt: unreadable (EACCES)');
    readAfter(paths.after, 0);
    r.write('n.txt', 'a\0');
    const both = readBlock(run(r, { io }), [FINDINGS, NOT_JUDGED], ['n.txt', 'big.txt', 'gone.txt', 'locked.txt'], [1, 3]);
    assert.deepEqual(both.findings, [...bytes.findings, ...paths.findings]);
    assert.deepEqual(both.remedies, [...bytes.remedies, ...paths.remedies]);
    assert.notEqual(bytes.remedies[0], paths.remedies[0]);
    readAfter(both.after, 1);
  }));

  it('a surface holding two refused bytes is one finding carrying (+1 more), counted once', () => withRepo((r) => {
    r.write('x.txt', 'a\x01b\x02c');
    const block = readBlock(run(r), [FINDINGS], ['x.txt'], [1]);
    assert.deepEqual(block.findings, ['x.txt: content offset 1: 0x01 (+1 more)']);
    assert.match(block.after[1], /· findings: 1$/u);
  }));

  it('hostile tracked names stand at . with the rendered path leading the text', () => withRepo((r) => {
    const block = readBlock(run(r), [FINDINGS], ['.', '.', '.', '.', '.', '.', '.', 'plain.txt', '.'], [9]);
    assert.deepEqual(block.findings, [
      '.: \\u0020lead.txt: content offset 1: 0x00',
      '.: a:b.txt: content offset 1: 0x00',
      '.: back\\\\slash.txt: content offset 1: 0x00',
      '.: control-bytes: content offset 1: 0x00',
      '.: na\\u{1}me.txt: name offset 2: 0x01',
      '.: na\\u{1}me.txt: content offset 1: 0x00',
      '.: paths judged: content offset 1: 0x00',
      'plain.txt: content offset 1: 0x00',
      '.: skipped by attribute: content offset 1: 0x00',
    ]);
    assert.equal(block.after.at(-1), 'skipped by attribute: blob.bin');
  }, Object.fromEntries([
    ['.gitattributes', '*.bin binary\n'], ['blob.bin', 'x\0'], [' lead.txt', 'x\0'], ['a:b.txt', 'x\0'],
    ['back\\slash.txt', 'x\0'], [NAME, 'x\0'], ['na\x01me.txt', 'x\0'], ['paths judged', 'x\0'],
    ['plain.txt', 'x\0'], ['skipped by attribute', 'x\0'],
  ])));
});

describe('spec:control-bytes/S9 the command line spawned', { skip: skipWithoutGit }, () => {
  const cli = (args, r) => {
    const result = spawnSync(process.execPath, [ENTRY, ...args], { cwd: r.cwd, env: r.env, encoding: 'utf8', windowsHide: true });
    assert.equal(result.error, undefined);
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  it('a usage refusal prints its verdict line and the usage text on stdout, nothing on stderr, exit 2', () => withRepo((r) => {
    const file = join(r.top, 'f.txt');
    const missing = join(r.top, 'missing');
    for (const [args, failed] of [
      [['--bogus'], 'unknown argument: --bogus'],
      [['--cwd'], '--cwd needs a directory'],
      [['--cwd', file], `--cwd ${file} is not a directory`],
      [['--cwd', missing], `--cwd ${missing}: ENOENT`],
      [['--bo\ngus'], 'unknown argument: --bo\\u{a}gus'],
      [[' --bogus'], 'unknown argument:  --bogus'],
    ]) {
      assert.deepEqual(cli(args, r), { code: 2, stderr: '', stdout: `${[`${FAIL}${failed}`, ...RECORDED_USAGE].join('\n')}\n` }, JSON.stringify(args));
    }
  }));

  it('a red run prints its block on stdout and nothing on stderr', () => withRepo((r) => {
    r.write('n.txt', 'a\0');
    const result = cli(['--check'], r);
    assert.deepEqual([result.code, result.stderr], [1, '']);
    readBlock({ code: result.code, lines: result.stdout.replace(/\n$/u, '').split('\n') }, [FINDINGS], ['n.txt'], [1]);
  }));

  it('an error main does not answer for is the guard\'s block through runCheckerTail', () => withRepo((r) => {
    const spawn = (cmd, args, opts) => (args.join(' ') === 'ls-files -s -z' ? undefined : spawnSync(cmd, args, opts));
    const writes = [];
    const errors = [];
    const host = { stdout: { write: (text) => writes.push(text) }, stderr: { write: (text) => errors.push(text) } };
    const remedy = 'fix the cause the stack below names, then re-run';
    const code = runCheckerTail({ name: NAME, exitCode: 1, remedy }, () => run(r, { spawn }), host);
    assert.deepEqual([code, host.exitCode, errors, writes.length], [1, 1, [], 1]);
    const lines = writes[0].replace(/\n$/u, '').split('\n');
    assert.match(lines[0], /^control-bytes: FAIL — unexpected error: Cannot read properties of undefined \(reading 'error'\)$/u);
    assert.equal(lines[1], `${REMEDY}${remedy}`);
    assert.match(lines[2], /^TypeError: Cannot read properties of undefined/u);
    assert.ok(lines.slice(3).length > 0 && lines.slice(3).every((line) => line.startsWith('    at ')), writes[0]);
  }));

  it('a clean run, plain and under --check, prints the report recorded from d2aef65, exit 0', () => withRepo((r) => {
    r.write('.gitattributes', '*.bin binary\n');
    r.write('blob.bin', 'x\0y');
    const recorded = `control-bytes: work tree ${r.top}\npaths judged: 3 · skipped by attribute: 1 · skipped by kind: 0 · findings: 0\nskipped by attribute: blob.bin\n`;
    for (const args of [[], ['--check']]) assert.deepEqual(cli(args, r), { code: 0, stderr: '', stdout: recorded });
  }));
});
