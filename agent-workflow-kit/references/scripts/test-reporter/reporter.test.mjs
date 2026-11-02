// reporter.test.mjs — the kit test reporter: nested `node --test` runs over fixture files in a temporary
// directory, and direct drives of the generator over synthetic event streams (spec test-reporter).
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPORTER = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'reporter.mjs')).href;
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'test-reporter-')));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const TOTALS = /^tests (\d+) · pass (\d+) · fail (\d+) · cancelled (\d+) · skipped (\d+) · todo (\d+)$/;
const UNKNOWN = 'tests ? · pass ? · fail ? · cancelled ? · skipped ? · todo ?';

const RED = {
  'nested.test.mjs': [
    "import { describe, it } from 'node:test';",
    "import assert from 'node:assert/strict';",
    '',
    "describe('outer', () => {",
    "  describe('inner', () => {",
    "    it('compares', () => {",
    "      assert.equal('old text', 'new text');",
    '    });',
    '  });',
    '});',
  ],
  'kinds.test.mjs': [
    "import { it } from 'node:test';",
    '',
    "it('type error', () => { throw new TypeError('boom'); });",
    "it('slow', { timeout: 20 }, () => new Promise((done) => setTimeout(done, 200)));",
    "it('a string', () => { throw 'plain string'; });",
    "it('null', () => { throw null; });",
  ],
  'quiet.test.mjs': [
    "import { describe, it } from 'node:test';",
    '',
    "describe('parent', () => {",
    "  it('fails', () => { throw new Error('child broke'); });",
    '});',
    "it('times out over its child', { timeout: 30 }, async (t) => {",
    "  await t.test('child', () => new Promise((done) => setTimeout(done, 300)));",
    '});',
    "it('skipped', { skip: true }, () => { throw new Error('never ran'); });",
    "it('todo throws', { todo: true }, () => { throw new Error('todo broke'); });",
    "it('todo passes', { todo: true }, () => {});",
    "it('skips then throws', (t) => { t.skip(); throw new Error('after skip'); });",
    "it('passes', () => {});",
  ],
  'broken-import.test.mjs': ["import { missing } from './no-such-module.mjs';", 'missing();'],
  'syntax-error.test.mjs': ["import { it } from 'node:test';", '', "it('never runs', () => {", '  foo(', '});'],
  'noisy.test.mjs': [
    "import { it } from 'node:test';",
    '',
    "process.stderr.write('Warning: noise from the file\\n');",
    "it('top', () => { throw new Error('top broke'); });",
  ],
  'values.test.mjs': [
    "import { it } from 'node:test';",
    "import assert from 'node:assert/strict';",
    '',
    "const circular = { name: 'loop' };",
    'circular.self = circular;',
    '',
    "it('bigint', () => assert.equal(1n, 2n));",
    "it('circular', () => assert.deepEqual(circular, { name: 'loop' }));",
    "it('long', () => assert.equal('x'.repeat(2000), 'y'));",
  ],
  'frames.test.mjs': [
    "import { it } from 'node:test';",
    "import { readFileSync } from 'node:fs';",
    "import { explode } from './node_modules/helper/index.mjs';",
    "import { throwOutside } from '../outside/helper.mjs';",
    '',
    "it('a dependency throws', () => {",
    '  explode();',
    '});',
    "it('a file outside throws', () => {",
    '  throwOutside();',
    '});',
    "it('node throws', () => {",
    "  readFileSync('/no/such/file/anywhere');",
    '});',
  ],
};
const HELPERS = {
  'node_modules/helper/index.mjs': ["export const explode = () => { throw new Error('from a dependency'); };"],
  '../outside/helper.mjs': ["export const throwOutside = () => { throw new Error('from outside the project'); };"],
};
const GREEN = {
  'green.test.mjs': [
    "import { it } from 'node:test';",
    '',
    "it('passes', () => {});",
    "it('notes', (t) => { t.diagnostic('Note: written by the test'); });",
  ],
};
const LATE = {
  'late.test.mjs': [
    "import { it } from 'node:test';",
    '',
    "it('ends before its work', () => {",
    "  setTimeout(() => { throw new Error('late failure'); }, 10);",
    '});',
  ],
};

const project = (name, files) => {
  const dir = join(ROOT, name);
  for (const [path, lines] of Object.entries(files)) {
    mkdirSync(dirname(resolve(dir, path)), { recursive: true });
    writeFileSync(resolve(dir, path), `${lines.join('\n')}\n`);
  }
  return dir;
};

// One nested run with the reporter, NODE_TEST_CONTEXT and NODE_V8_COVERAGE removed: its exit status and its stdout lines.
const nodeTest = (dir, files, flags = []) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_V8_COVERAGE;
  const args = ['--test', ...flags, `--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout', ...files];
  const result = spawnSync(process.execPath, args, { cwd: dir, env, encoding: 'utf8' });
  const lines = result.stdout.replace(/\n$/, '').split('\n');
  assert.ok(Number(TOTALS.exec(lines.at(-1))?.[1]) > 0, `the nested run's tests ran:\n${result.stdout}${result.stderr}`);
  return { status: result.status, lines };
};
const runs = new Map();
const runOnce = (name, files, flags = []) => {
  const key = `${name} ${flags.join(' ')}`;
  if (!runs.has(key)) runs.set(key, nodeTest(project(name, files), Object.keys(files), flags));
  return runs.get(key);
};
const redRun = () => {
  project('red', HELPERS);
  return runOnce('red', RED);
};
const takesIsolationFlag = () => spawnSync(process.execPath, ['--test-isolation=none', '--eval', '0']).status === 0;

const blocksOf = (lines) => lines.reduce((blocks, line) => {
  if (line.startsWith('FAIL ')) return [...blocks, [line]];
  return line.startsWith('  ') && blocks.length ? [...blocks.slice(0, -1), [...blocks.at(-1), line]] : blocks;
}, []);
const block = (lines, head) => blocksOf(lines).find(([first]) => (typeof head === 'string' ? first === head : head.test(first)))
  ?? assert.fail(`no block headed ${head}:\n${lines.join('\n')}`);

const DRIVE_FILE = join(process.cwd(), 'drive.test.mjs');
const counts = (values) => Object.entries(values).map(([key, value]) => ({ type: 'test:diagnostic', data: { nesting: 0, message: `${key} ${value}` } }));
const GREEN_COUNTS = { tests: 1, suites: 0, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0, duration_ms: 2.5 };
const totalsOf = ({ tests, pass, fail, cancelled, skipped, todo }) => `tests ${tests} · pass ${pass} · fail ${fail} · cancelled ${cancelled} · skipped ${skipped} · todo ${todo}`;
const own = (message) => ({ type: 'test:diagnostic', data: { file: DRIVE_FILE, line: 3, nesting: 0, message } });
const summary = (success, file) => ({ type: 'test:summary', data: { file, success, counts: {} } });
const failure = (error, extra = {}) => ({ type: 'test:fail', data: { name: 'case', nesting: 0, file: DRIVE_FILE, line: 3, details: { error }, ...extra } });
const unreadable = () => ({
  get message() { throw new Error('no message'); },
  toString() { throw new Error('no string'); },
  [Symbol.toPrimitive]() { throw new Error('no primitive'); },
});

// The generator over a synthetic stream that ends, or throws `streamError` after its events: its output lines.
const drive = async (reporter, events, ...streamError) => {
  const exitCode = process.exitCode;
  const source = (async function* () {
    yield* events;
    if (streamError.length) throw streamError[0];
  })();
  const chunks = [];
  for await (const chunk of reporter(source)) chunks.push(chunk);
  assert.equal(process.exitCode, exitCode, 'the reporter sets no exit code');
  return chunks.join('').replace(/\n$/, '').split('\n');
};
const RENDER = /^reporter: an event could not be rendered \(.+\)$/;

describe('spec:test-reporter/S1 an assertion failure in a nested suite prints its block', () => {
  it('the file and line, the path through both suites, the cause, expected and actual, and the code line', async () => {
    await import('./reporter.mjs');
    const lines = block(redRun().lines, 'FAIL nested.test.mjs:6 outer > inner > compares');
    assert.deepEqual(lines.slice(0, 4), [
      'FAIL nested.test.mjs:6 outer > inner > compares',
      '  testCodeFailure: AssertionError: Expected values to be strictly equal:',
      "  expected: 'new text'",
      "  actual:   'old text'",
    ]);
    assert.match(lines[4] ?? '', /^ {2}at nested\.test\.mjs:7:\d+ {2}assert\.equal\('old text', 'new text'\);$/);
    assert.equal(lines.length, 5, lines.join('\n'));
  });
});

describe('spec:test-reporter/S2 the cause line of each failure kind', () => {
  it('a TypeError, a timeout, a thrown string and a thrown null', async () => {
    await import('./reporter.mjs');
    const { lines } = redRun();
    const typeError = block(lines, 'FAIL kinds.test.mjs:3 type error');
    assert.equal(typeError[1], '  testCodeFailure: TypeError: boom');
    assert.deepEqual(typeError.filter((line) => /^ {2}(expected|actual):/.test(line)), [], 'no expected or actual line');
    assert.match(typeError[2] ?? '', /^ {2}at kinds\.test\.mjs:3:\d+ {2}it\('type error'/);
    assert.match(block(lines, 'FAIL kinds.test.mjs:4 slow')[1] ?? '', /^ {2}testTimeoutFailure: \S/);
    assert.deepEqual(block(lines, 'FAIL kinds.test.mjs:5 a string'), ['FAIL kinds.test.mjs:5 a string', '  testCodeFailure: plain string']);
    assert.equal(block(lines, 'FAIL kinds.test.mjs:6 null')[1], '  testCodeFailure: Error: null');
  });
});

describe('spec:test-reporter/S3 what prints no block, and the exit codes', () => {
  it('a subtestsFailed parent, a cancelledByParent child, skipped and todo tests print nothing; the red run exits 1', async () => {
    await import('./reporter.mjs');
    const { status, lines } = redRun();
    assert.equal(status, 1);
    const heads = blocksOf(lines).map(([head]) => head).filter((head) => head.startsWith('FAIL quiet.test.mjs:'));
    assert.deepEqual(heads, ['FAIL quiet.test.mjs:4 parent > fails', 'FAIL quiet.test.mjs:6 times out over its child']);
    for (const word of ['never ran', 'todo broke', 'after skip', 'did not finish']) {
      assert.deepEqual(lines.filter((line) => line.includes(word)), [], `nothing prints ${word}`);
    }
  });

  it('a green run prints the totals line alone and exits 0', async () => {
    await import('./reporter.mjs');
    assert.deepEqual(runOnce('green', GREEN), { status: 0, lines: ['tests 2 · pass 2 · fail 0 · cancelled 0 · skipped 0 · todo 0'] });
  });
});

describe('spec:test-reporter/S4 a file that fails to load prints the error head of its own standard error', () => {
  it('a missing import and a syntax error, each a file-level block; a top-level failure prints no stderr line', async () => {
    await import('./reporter.mjs');
    const { lines } = redRun();
    const missing = block(lines, /^FAIL broken-import\.test\.mjs:(1|\?) broken-import\.test\.mjs$/);
    assert.equal(missing[1], '  testCodeFailure: test failed');
    assert.match(missing.at(-1), /^ {2}stderr: Error \[ERR_MODULE_NOT_FOUND\]: Cannot find module /);
    const syntax = block(lines, /^FAIL syntax-error\.test\.mjs:(1|\?) syntax-error\.test\.mjs$/);
    assert.match(syntax.at(-1), /^ {2}stderr: SyntaxError: /);
    for (const one of [missing, syntax]) assert.equal(one.filter((line) => line.startsWith('  stderr: ')).length, 1, one.join('\n'));
    const top = block(lines, 'FAIL noisy.test.mjs:4 top');
    assert.equal(top[1], '  testCodeFailure: Error: top broke');
    assert.deepEqual(top.filter((line) => line.startsWith('  stderr:')), [], 'a top-level test is no file-level failure');
  });

  it("driven directly: its own file's error head under a relative path, else the first non-blank line, else no line", async () => {
    const { default: reporter } = await import('./reporter.mjs');
    const LOAD = 'load.test.mjs';
    const chunk = (message, file = LOAD) => ({ type: 'test:stderr', data: { file, message } });
    const loadFailure = (extra = {}) => failure({ failureType: 'testCodeFailure', cause: 'test failed' }, { name: LOAD, file: join(process.cwd(), LOAD), line: 1, ...extra });
    const head = [`FAIL ${LOAD}:1 ${LOAD}`, '  testCodeFailure: test failed'];
    const missing = "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/x/no-such-module.mjs'";
    assert.deepEqual(await drive(reporter, [chunk('TypeError: written by another file\n', 'other.test.mjs'),
      chunk('    at ModuleLoader.resolve (node:internal/modules/esm/loader:1:1)\n'), chunk(`${missing}\n`), loadFailure()]),
      [...head, `  stderr: ${missing}`, UNKNOWN]);
    assert.deepEqual(await drive(reporter, [chunk('\n  \n'), chunk('  plain words of the file\n'), chunk('more words\n'), loadFailure()]),
      [...head, '  stderr: plain words of the file', UNKNOWN]);
    assert.deepEqual(await drive(reporter, [chunk('\n'), chunk('   \n'), loadFailure()]), [...head, UNKNOWN], 'blank chunks only');
    const outer = { type: 'test:start', data: { name: 'outer', nesting: 0, file: join(process.cwd(), LOAD) } };
    assert.deepEqual(await drive(reporter, [outer, chunk('Error: boom\n'), loadFailure({ nesting: 1 })]),
      [`FAIL ${LOAD}:1 outer > ${LOAD}`, head[1], UNKNOWN], 'a nested failure');
    assert.deepEqual(await drive(reporter, [chunk('Error: boom\n'), loadFailure({ name: 'a test' })]),
      [`FAIL ${LOAD}:1 a test`, head[1], UNKNOWN], 'a failure not named after its file');
  });
});

describe('spec:test-reporter/S5 values the plain printer cannot print', () => {
  it('a BigInt, a circular object and a value longer than the cap each print one line', async () => {
    await import('./reporter.mjs');
    const { lines } = redRun();
    assert.deepEqual(block(lines, 'FAIL values.test.mjs:7 bigint').slice(2, 4), ['  expected: 2n', '  actual:   1n']);
    const circular = block(lines, 'FAIL values.test.mjs:8 circular');
    assert.equal(circular[2], "  expected: { name: 'loop' }");
    assert.match(circular[3] ?? '', /^ {2}actual: {3}.*\[Circular \*1\]/);
    const long = block(lines, 'FAIL values.test.mjs:9 long');
    assert.equal(long[2], "  expected: 'y'");
    const value = (long[3] ?? '').replace(/^ {2}actual: {3}/, '');
    assert.equal(value.length, 501, value);
    assert.ok(value.startsWith(`'${'x'.repeat(400)}`) && value.endsWith('…'), value);
  });

  it('driven directly: a cause owning both values prints both exact lines; one owned, or both inherited, prints neither', async () => {
    const { default: reporter } = await import('./reporter.mjs');
    const circular = { name: 'loop' };
    circular.self = circular;
    const valued = (values, inherited = {}) => failure({ failureType: 'testCodeFailure',
      cause: Object.assign(Object.create(inherited), { name: 'AssertionError', message: 'differ' }, values) });
    const head = ['FAIL drive.test.mjs:3 case', '  testCodeFailure: AssertionError: differ'];
    assert.deepEqual(await drive(reporter, [valued({ expected: 2n, actual: 1n })]), [...head, '  expected: 2n', '  actual:   1n', UNKNOWN]);
    assert.deepEqual(await drive(reporter, [valued({ expected: { name: 'loop' }, actual: circular })]),
      [...head, "  expected: { name: 'loop' }", "  actual:   <ref *1> { name: 'loop', self: [Circular *1] }", UNKNOWN]);
    assert.deepEqual(await drive(reporter, [valued({ expected: 'y', actual: 'x'.repeat(2000) })]),
      [...head, "  expected: 'y'", `  actual:   '${'x'.repeat(499)}…`, UNKNOWN]);
    for (const values of [{ expected: 1 }, { actual: 2 }]) {
      assert.deepEqual(await drive(reporter, [valued(values)]), [...head, UNKNOWN], `owns only ${Object.keys(values)}`);
    }
    assert.deepEqual(await drive(reporter, [valued({}, { expected: 1, actual: 2 })]), [...head, UNKNOWN], 'both inherited');
  });
});

describe('spec:test-reporter/S6 malformed events and a failing stream never throw', () => {
  it('a null event and an event with no data print at most one reporter line each, and the next event is read', async () => {
    const { default: reporter } = await import('./reporter.mjs');
    for (const malformed of [null, { type: 'test:fail' }, { type: 'test:start' }]) {
      const lines = await drive(reporter, [malformed, ...counts(GREEN_COUNTS)]);
      assert.equal(lines.at(-1), totalsOf(GREEN_COUNTS), lines.join('\n'));
      assert.ok(lines.length <= 2 && lines.slice(0, -1).every((line) => RENDER.test(line)), lines.join('\n'));
    }
  });

  it('a cause whose message getter throws prints one reporter line, an unreadable error its fallback', async () => {
    const { default: reporter } = await import('./reporter.mjs');
    const broken = failure({ failureType: 'testCodeFailure', cause: { get message() { throw new Error('getter broke\nsecond line'); } } });
    assert.deepEqual(await drive(reporter, [broken, ...counts(GREEN_COUNTS)]),
      ['reporter: an event could not be rendered (getter broke)', totalsOf(GREEN_COUNTS)]);
    const worse = failure({ failureType: 'testCodeFailure', cause: { get message() { throw unreadable(); } } });
    assert.deepEqual(await drive(reporter, [worse]), ['reporter: an event could not be rendered (an unreadable error)', UNKNOWN]);
  });

  it('a stream that throws prints its reporter line, then the totals line', async () => {
    const { default: reporter } = await import('./reporter.mjs');
    assert.deepEqual(await drive(reporter, counts(GREEN_COUNTS), new Error('stream broke\nsecond line')),
      ['reporter: the event stream ended with an error (stream broke)', totalsOf(GREEN_COUNTS)]);
    assert.deepEqual(await drive(reporter, [], unreadable()), ['reporter: the event stream ended with an error (an unreadable error)', UNKNOWN]);
  });
});

describe('spec:test-reporter/S7 the totals come from the closing diagnostics that carry no file', () => {
  it("a test's own diagnostic with a file never moves them, and a missing count prints a question mark", async () => {
    const { default: reporter } = await import('./reporter.mjs');
    const withoutTodo = { tests: 3, suites: 1, pass: 3, fail: 0, cancelled: 0, skipped: 0, duration_ms: 1.5 };
    assert.deepEqual(await drive(reporter, [own('tests 99'), ...counts(withoutTodo), own('fail 7')]),
      ['tests 3 · pass 3 · fail 0 · cancelled 0 · skipped 0 · todo ?']);
  });
});

describe('spec:test-reporter/S8 the code line is the first frame inside the working directory', () => {
  it('real frames under node_modules, outside the project and in node internals are skipped', async () => {
    await import('./reporter.mjs');
    const { lines } = redRun();
    for (const [head, at] of [['FAIL frames.test.mjs:6 a dependency throws', /^ {2}at frames\.test\.mjs:7:\d+ {2}explode\(\);$/],
      ['FAIL frames.test.mjs:9 a file outside throws', /^ {2}at frames\.test\.mjs:10:\d+ {2}throwOutside\(\);$/],
      ['FAIL frames.test.mjs:12 node throws', /^ {2}at frames\.test\.mjs:13:\d+ {2}readFileSync\('\/no\/such\/file\/anywhere'\);$/]]) {
      assert.deepEqual(block(lines, head).filter((line) => line.startsWith('  at ')).map((line) => at.test(line)), [true], head);
    }
  });

  it('an unreadable source prints the location alone; no qualifying frame prints no code line', async () => {
    const { default: reporter } = await import('./reporter.mjs');
    const cwd = process.cwd();
    const gone = join('no-such-dir-of-the-reporter-suite', 'missing.test.mjs');
    const cause = (message, frames) => failure({ failureType: 'testCodeFailure', cause: { name: 'Error', message, stack: [`Error: ${message}`, ...frames].join('\n') } });
    const skipped = [
      '    at Object.readFileSync (node:fs:441:20)',
      `    at dependency (${join(cwd, 'node_modules', 'dep', 'index.mjs')}:2:3)`,
      `    at outside (${join(dirname(cwd), 'outside-the-project.mjs')}:4:5)`,
      `    at sibling (${join(`${cwd}-sibling`, 'near.mjs')}:5:5)`,
      '    at relative (lib/relative.mjs:9:9)',
    ];
    assert.deepEqual(await drive(reporter, [cause('deep', [...skipped, `    at TestContext.<anonymous> (${pathToFileURL(join(cwd, gone)).href}:6:7)`])]),
      ['FAIL drive.test.mjs:3 case', '  testCodeFailure: Error: deep', `  at ${gone}:6:7`, UNKNOWN]);
    assert.deepEqual(await drive(reporter, [cause('shallow', skipped)]), ['FAIL drive.test.mjs:3 case', '  testCodeFailure: Error: shallow', UNKNOWN]);
  });
});

describe('spec:test-reporter/S10 a red run never reads green', () => {
  it('a test whose asynchronous work throws after it ended prints the diagnostic line and exits 1, under each isolation', async (t) => {
    await import('./reporter.mjs');
    const isolated = runOnce('late', LATE);
    assert.equal(isolated.status, 1, isolated.lines.join('\n'));
    const at = isolated.lines.findIndex((line) => /^diagnostic: .*late failure/.test(line));
    assert.ok(at >= 0 && at < isolated.lines.length - 1, isolated.lines.join('\n'));
    if (!takesIsolationFlag()) return t.skip('this Node takes no --test-isolation flag');
    const shared = runOnce('late', LATE, ['--test-isolation=none']);
    assert.equal(shared.status, 1, shared.lines.join('\n'));
    assert.equal(shared.lines.length, 2, shared.lines.join('\n'));
    assert.match(shared.lines[0], /^diagnostic: .*late failure/);
  });

  it("a real green run whose test writes its own diagnostic prints the totals line alone", async () => {
    await import('./reporter.mjs');
    const alone = { status: 0, lines: ['tests 2 · pass 2 · fail 0 · cancelled 0 · skipped 0 · todo 0'] };
    assert.deepEqual(runOnce('green', GREEN), alone);
    if (takesIsolationFlag()) assert.deepEqual(runOnce('green', GREEN, ['--test-isolation=none']), alone);
  });

  it("a failing closing summary, or failing counts with none, prints a test's own diagnostic line", async () => {
    const { default: reporter } = await import('./reporter.mjs');
    assert.deepEqual(await drive(reporter, [own('Note: own words'), ...counts(GREEN_COUNTS), summary(false)]),
      ['diagnostic: Note: own words', totalsOf(GREEN_COUNTS)]);
    for (const red of [{ ...GREEN_COUNTS, fail: 1 }, { ...GREEN_COUNTS, cancelled: 1 }]) {
      assert.deepEqual(await drive(reporter, [own('Note: own words'), ...counts(red)]), ['diagnostic: Note: own words', totalsOf(red)]);
    }
  });

  it('a failing summary with no failure event prints the no-failure line; a green verdict prints the totals alone', async () => {
    const { default: reporter } = await import('./reporter.mjs');
    const noFailure = ['reporter: the run failed and no test reported a failure', totalsOf(GREEN_COUNTS)];
    assert.deepEqual(await drive(reporter, [...counts(GREEN_COUNTS), summary(false)]), noFailure);
    const todoFailure = failure({ failureType: 'testCodeFailure', cause: new Error('todo broke') }, { todo: true });
    assert.deepEqual(await drive(reporter, [todoFailure, ...counts(GREEN_COUNTS), summary(false)]), noFailure);
    assert.deepEqual(await drive(reporter, [own('Note: own words'), ...counts(GREEN_COUNTS)]), [totalsOf(GREEN_COUNTS)]);
    assert.deepEqual(await drive(reporter, [own('Note: own words'), summary(false, DRIVE_FILE), ...counts(GREEN_COUNTS), summary(true)]), [totalsOf(GREEN_COUNTS)]);
    const redCounts = { ...GREEN_COUNTS, fail: 1 };
    assert.deepEqual(await drive(reporter, [own('Note: own words'), ...counts(redCounts), summary(true)]), [totalsOf(redCounts)]);
  });
});
