import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { faultEnvironment, faultPhrase, readFaultMarks } from '../checker-verdict/fault-harness.test.mjs';

const { runScan, main, scanText, scanVersionPins } = await import('../release-scan.mjs').catch(() => ({}));
const { CHECKER_NAME, UNEXPECTED_REMEDY } = await import('./index.mjs').catch(() => ({}));
const { runCheckerTail } = await import('../checker-block/index.mjs').catch(() => ({}));
const { judgeBlock } = await import('../checker-verdict/index.mjs').catch(() => ({}));

const ENTRY = fileURLToPath(new URL('../release-scan.mjs', import.meta.url));
const NAME = 'release-scan';
const FAIL = `${NAME}: FAIL — `;
const REMEDY = `${NAME}: REMEDY — `;
const UNEXPECTED = `${FAIL}unexpected error: `;
const USAGE = 'usage: release-scan.mjs [--report] <path>...';
const CLEAN = '[release-scan] clean — no AI attribution or reviewer-round identity found.';
const TARGET_CLASS = 'mis-aimed target(s)';
const SCAN_CLASS = 'finding(s)';
const TARGET_REMEDY = {
  missing: 'the path does not exist — fix the target, or drop it from the target list',
  excluded: 'the target itself is excluded (directory names: node_modules, .git, plans, scan-fixtures; non-text or self-excluded files) — name the FILES to scan instead of the directory',
  empty: 'the target exists but holds no scannable text file — fix the target, or drop it from the target list',
};
const TRAILER = 'Co-' + 'Authored-By:';
const COAUTHOR = `${TRAILER} Example Maintainer <maintainer@example.com>`;
const REVIEWER = ['Co', 'dex', ' r', '1'].join('');
const PIN = `// ${['clau', 'de'].join('')} ${[2, 1, 185].join('.')}`;
const GLOB = 'optional-*.md';
const MISSING = 'missing.md';
const FOUND = 'found.md';
const CLEAN_TEXT = 'ordinary text\n';
const REPORT_MODES = [[], ['--report']];
const AS_ROOT = process.getuid?.() === 0;

const makeDirectory = (test) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'release-scan-red-')));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.doesNotMatch(dir, /[*?[\]]/);
  return dir;
};
const writeFixture = (dir, file, text = COAUTHOR) => writeFileSync(join(dir, file), text);
const writeLines = (lines) => `${lines.join('\n')}\n`;
const readLines = (stdout) => stdout.replace(/\n$/, '').split('\n');
const skipped = (path) => `[release-scan] skipped ${path} — no file matched this glob (an optional target, stated not silent).`;
const recordedMissing = (path) => `[release-scan] target ${path} contributed NO file (missing) — ${TARGET_REMEDY.missing}`;
const MISSING_COUNT = '[release-scan] 1 mis-aimed target(s) — this run proves nothing about them, so the clean verdict is refused.';

const runCommand = (args, cwd, extra = {}) => {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [ENTRY, ...args], { cwd, env, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};
const captureConsole = (test, run) => {
  const log = test.mock.method(console, 'log', () => {});
  const error = test.mock.method(console, 'error', () => {});
  try {
    const answer = run();
    const logs = log.mock.calls.map(({ arguments: args }) => format(...args));
    return { answer, logs, errors: error.mock.calls.map(({ arguments: args }) => format(...args)) };
  } finally {
    log.mock.restore();
    error.mock.restore();
  }
};
const scan = (test, args, dir) => {
  assert.equal(typeof runScan, 'function', 'runScan export');
  const { answer, logs, errors } = captureConsole(test, () => runScan(args, dir));
  assert.deepEqual([logs, errors], [[], []]);
  return answer;
};
const readBlock = ({ code, lines }, classes, places, after = []) => {
  assert.equal(code, 1);
  const [verdict] = lines;
  assert.ok(verdict.startsWith(FAIL), verdict);
  assert.equal(lines.filter((line) => line.startsWith(FAIL)).length, 1);
  const nouns = classes.map(([noun]) => noun);
  for (const noun of [TARGET_CLASS, SCAN_CLASS]) {
    assert.equal(verdict.split(noun).length - 1, nouns.includes(noun) ? 1 : 0, verdict);
  }
  assert.deepEqual([...nouns].sort((a, b) => verdict.indexOf(a) - verdict.indexOf(b)), nouns);
  const counts = [...verdict.matchAll(/\b\d+\b/g)];
  assert.deepEqual(verdict.match(/\b\d+\b/g), classes.map(([, count]) => String(count)));
  for (const [index, noun] of nouns.entries()) {
    const start = verdict.indexOf(noun);
    assert.ok(counts[index].index < start && start < (counts[index + 1]?.index ?? verdict.length), verdict);
  }
  const firstRemedy = lines.findIndex((line) => line.startsWith(REMEDY));
  assert.ok(firstRemedy > 1, lines.join('\n'));
  const findings = lines.slice(1, firstRemedy);
  const ownPlaces = findings.map((line) => line.slice(0, line.indexOf(': ')));
  assert.deepEqual(ownPlaces, places);
  const remedies = lines.filter((line) => line.startsWith(REMEDY));
  assert.equal(remedies.length, classes.length);
  assert.ok(remedies.every((line) => line.length > REMEDY.length && line[REMEDY.length] !== ' '));
  assert.deepEqual(lines.slice(firstRemedy), [...remedies, ...after]);
  assert.deepEqual(judgeBlock(lines.join('\n'), { name: NAME, places: ownPlaces }), []);
  return { findings, remedies };
};
const checkFinding = (line, prefix, kind, detail) => {
  assert.ok(line.startsWith(prefix), line);
  const text = line.slice(prefix.length);
  const match = new RegExp(`\\b${kind}\\b`).exec(text);
  assert.ok(match, line);
  assert.ok(text.includes(detail, match.index + kind.length), line);
};

it('spec:release-scan/S1 groups missing, excluded and empty targets', (test) => {
  const dir = makeDirectory(test);
  mkdirSync(join(dir, 'plans'));
  mkdirSync(join(dir, 'empty'));
  const targets = [MISSING, 'plans', 'empty'];
  const block = readBlock(scan(test, [...targets, GLOB], dir), [[TARGET_CLASS, 3]], targets, [skipped(join(dir, GLOB))]);
  for (const [index, status] of ['missing', 'excluded', 'empty'].entries()) {
    checkFinding(block.findings[index], `${targets[index]}: `, status, TARGET_REMEDY[status]);
  }
});

it('spec:release-scan/S2 places all scan findings in scan order', (test) => {
  const dir = makeDirectory(test);
  const outside = join(makeDirectory(test), 'outside.md');
  const pinFile = 'tools/pin.md';
  mkdirSync(join(dir, dirname(pinFile)));
  const fixtures = [
    ['attribution.md', `${CLEAN_TEXT}${COAUTHOR}`], ['reviewer.md', REVIEWER], [pinFile, PIN],
    ['double.md', `${COAUTHOR} ${REVIEWER}`], [outside, COAUTHOR],
  ];
  const findings = fixtures.flatMap(([target, text]) => {
    const path = resolve(dir, target);
    writeFileSync(path, text);
    return [...scanText(text), ...scanVersionPins(text, path)].map((finding) => ({ target, ...finding }));
  });
  assert.deepEqual(findings.map(({ kind, line }) => [kind, line]), [
    ['attribution', 2], ['reviewer-identity', 1], ['version-pin', 1],
    ['attribution', 1], ['reviewer-identity', 1], ['attribution', 1],
  ]);
  const places = findings.map(({ target, line }) => `${target}:${line}`);
  const block = readBlock(scan(test, fixtures.map(([target]) => target), dir), [[SCAN_CLASS, 6]], places);
  assert.deepEqual(block.remedies, [`${REMEDY}remove each attribution, reviewer identity, and hardcoded version claim above, then re-run`]);
  for (const [index, { kind, detail }] of findings.entries()) {
    checkFinding(block.findings[index], `${places[index]}: `, kind, detail);
  }
});

it('spec:release-scan/S3 orders the two classes and leaves the skip last', (test) => {
  const dir = makeDirectory(test);
  writeFixture(dir, FOUND);
  const targetClass = [TARGET_CLASS, 1];
  const scanClass = [SCAN_CLASS, 1];
  const scanPlace = `${FOUND}:1`;
  const target = readBlock(scan(test, [MISSING], dir), [targetClass], [MISSING]);
  const finding = readBlock(scan(test, [FOUND], dir), [scanClass], [scanPlace]);
  const combined = readBlock(scan(test, [FOUND, GLOB, MISSING], dir), [targetClass, scanClass],
    [MISSING, scanPlace], [skipped(join(dir, GLOB))]);
  assert.notEqual(target.remedies[0], finding.remedies[0]);
  assert.deepEqual(combined.findings, [...target.findings, ...finding.findings]);
  assert.deepEqual(combined.remedies, [...target.remedies, ...finding.remedies]);
});

it('a relative working directory places a finding inside it relative to it', (test) => {
  const dir = makeDirectory(test);
  writeFixture(dir, FOUND);
  readBlock(scan(test, [FOUND], relative(process.cwd(), dir) || '.'), [[SCAN_CLASS, 1]], [`${FOUND}:1`]);
});

const checkUsage = ([verdict = '', ...rest]) => {
  assert.ok(verdict.startsWith(FAIL) && verdict.length > FAIL.length, verdict);
  assert.deepEqual(rest, [USAGE]);
};
describe('spec:release-scan/S4 usage refusals and option-like paths', () => {
  for (const args of REPORT_MODES) it(`CLI with ${args[0] ?? 'no arguments'}`, (test) => {
    const result = runCommand(args, makeDirectory(test));
    assert.deepEqual([result.code, result.stderr], [2, '']);
    checkUsage(readLines(result.stdout));
    assert.ok(result.stdout.endsWith('\n'));
  });
  it('main with no arguments', (test) => {
    const { answer, logs, errors } = captureConsole(test, () => main([]));
    assert.deepEqual([answer, errors], [2, []]);
    checkUsage(logs);
    assert.equal(writeLines(logs), runCommand([], makeDirectory(test)).stdout);
  });
  it('an unknown option is a missing target', (test) => {
    const target = '--unknown';
    const { code, stdout, stderr } = runCommand([target], makeDirectory(test));
    assert.equal(stderr, '');
    const block = readBlock({ code, lines: readLines(stdout) }, [[TARGET_CLASS, 1]], [target]);
    checkFinding(block.findings[0], `${target}: `, 'missing', TARGET_REMEDY.missing);
  });
});

const withFsFault = (test, path, fault, run) => {
  const original = fs.readFileSync;
  const mocked = test.mock.method(fs, 'readFileSync', (candidate, ...args) => {
    if (candidate === path) throw fault;
    return original(candidate, ...args);
  });
  syncBuiltinESMExports();
  try { return run(); } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
};
const checkGuard = ({ code, stdout, stderr }) => {
  assert.equal(code, 1, stdout);
  const [verdict, remedy, error, ...stack] = readLines(stdout);
  assert.ok(verdict.startsWith(UNEXPECTED), stdout || stderr);
  assert.equal(stderr, '');
  assert.equal(remedy, `${REMEDY}${UNEXPECTED_REMEDY}`);
  assert.match(error, /^Error: /);
  assert.ok(stack.length > 0);
  for (const frame of stack) assert.match(frame, /^    at /);
  return verdict;
};
const checkCensusFault = (dir, args, point) => {
  const marks = join(dir, 'fault-marks');
  const result = runCommand(args, dir, faultEnvironment({ point, entry: ENTRY, marks }));
  assert.ok(readFaultMarks(marks).includes(ENTRY));
  assert.ok(checkGuard(result).includes(faultPhrase(point)), result.stdout);
  assert.doesNotMatch(result.stdout, /^\[release-scan\]/m);
};
const makeScanTarget = (dir) => {
  mkdirSync(join(dir, 'files'));
  writeFixture(dir, 'files/clean.md', CLEAN_TEXT);
  return 'files';
};
describe('spec:release-scan/S5 errors reach the guard before any scan output', () => {
  for (const flags of REPORT_MODES) it(`tail read fault ${flags[0] ?? 'without --report'}`, (test) => {
    const dir = makeDirectory(test);
    const unreadable = 'unreadable.md';
    writeFixture(dir, FOUND);
    writeFixture(dir, unreadable, CLEAN_TEXT);
    const path = join(dir, unreadable);
    const fault = Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES' });
    const writes = [];
    const stderr = [];
    const host = { stdout: { write: (text) => writes.push(text) }, stderr: { write: (text) => stderr.push(text) } };
    assert.equal(CHECKER_NAME, NAME);
    assert.equal(typeof runScan, 'function', 'runScan export');
    const { answer, logs, errors } = captureConsole(test, () => withFsFault(test, path, fault, () =>
      runCheckerTail({ name: CHECKER_NAME, exitCode: 1, remedy: UNEXPECTED_REMEDY },
        () => runScan([...flags, FOUND, unreadable], dir), host)));
    assert.deepEqual([answer, host.exitCode, stderr, logs, errors], [1, 1, [], [], []]);
    assert.deepEqual(writes, [writeLines([
      `${UNEXPECTED}${fault.message.split('\n')[0]}`, `${REMEDY}${UNEXPECTED_REMEDY}`, ...fault.stack.split('\n'),
    ])]);
  });
  for (const point of ['read', 'stat', 'list']) it(`CLI census ${point} fault`, (test) => {
    const dir = makeDirectory(test);
    checkCensusFault(dir, [makeScanTarget(dir)], point);
  });
  for (const flags of REPORT_MODES) it(`CLI read fault beside skip and missing ${flags[0] ?? 'without --report'}`, (test) => {
    const dir = makeDirectory(test);
    checkCensusFault(dir, [...flags, GLOB, MISSING, makeScanTarget(dir)], 'read');
  });
});

describe('spec:release-scan/S6 preserves the recorded exit-zero output', () => {
  it('--report with skip, missing target and finding', (test) => {
    const dir = makeDirectory(test);
    writeFixture(dir, FOUND, `${COAUTHOR}\n`);
    const stdout = writeLines([
      skipped(join(dir, GLOB)), recordedMissing(join(dir, MISSING)),
      `[attribution] ${join(dir, FOUND)}:1 — co-author trailer: "${TRAILER}"`,
      '', MISSING_COUNT, '', '[release-scan] 1 finding(s).',
    ]);
    assert.deepEqual(runCommand(['--report', MISSING, GLOB, FOUND], dir), { code: 0, stdout, stderr: '' });
  });
  it('clean scan with a skip', (test) => {
    const dir = makeDirectory(test);
    writeFixture(dir, 'clean.md', CLEAN_TEXT);
    const stdout = writeLines([skipped(join(dir, GLOB)), CLEAN]);
    assert.deepEqual(runCommand(['clean.md', GLOB], dir), { code: 0, stdout, stderr: '' });
  });
});

it('spec:release-scan/S7 places hostile paths at the project', (test) => {
  const dir = makeDirectory(test);
  const files = [' lead.md', 'back\\slash.md', NAME, 'plain.md'];
  for (const file of files) writeFixture(dir, file);
  const block = readBlock(scan(test, ['a:b', ...files], dir), [[TARGET_CLASS, 1], [SCAN_CLASS, 4]],
    ['.', '.', '.', '.', 'plain.md:1']);
  checkFinding(block.findings[0], `.: ${join(dir, 'a:b')}: `, 'missing', TARGET_REMEDY.missing);
  const { kind, detail } = scanText(COAUTHOR)[0];
  const prefixes = [...[' lead.md', 'back\\slash.md', NAME].map((file) => `.: ${join(dir, file)}:1: `), 'plain.md:1: '];
  for (const [index, prefix] of prefixes.entries()) checkFinding(block.findings[index + 1], prefix, kind, detail);
});

const checkStatGuard = (dir, target, failingPath, errorCode) => {
  const results = REPORT_MODES.map((flags) => runCommand([...flags, target], dir));
  assert.throws(() => statSync(join(dir, failingPath)), (error) => {
    assert.equal(error.code, errorCode);
    for (const result of results) assert.equal(checkGuard(result), `${UNEXPECTED}${error.message.split('\n')[0]}`);
    return true;
  });
};
describe('spec:release-scan/S8 distinguishes unreadable targets from absent targets', () => {
  for (const [shape, file] of [['glob-shaped', 'absent*.md'], ['plain', 'absent.md']]) {
    it(`${shape} self-pointing symlink`, (test) => {
      const dir = makeDirectory(test);
      symlinkSync(file, join(dir, file));
      checkStatGuard(dir, file, file, 'ELOOP');
    });
    it(`${shape} target under a regular file`, (test) => {
      const dir = makeDirectory(test);
      writeFixture(dir, 'parent', CLEAN_TEXT);
      const target = join('parent', file);
      checkStatGuard(dir, target, target, 'ENOTDIR');
    });
    it(`${shape} target under a directory without search permission`,
      { skip: AS_ROOT && 'search permission does not bind root' }, (test) => {
        const dir = makeDirectory(test);
        const closed = join(dir, 'closed');
        mkdirSync(closed, 0o700);
        try {
          chmodSync(closed, 0o600);
          const target = join('closed', file);
          checkStatGuard(dir, target, target, 'EACCES');
        } finally {
          chmodSync(closed, 0o700);
        }
      });
    for (const flags of REPORT_MODES) for (const symlink of [false, true]) {
      const name = `${shape} ${symlink ? 'dangling symlink' : 'absent target'} ${flags[0] ?? 'without --report'}`;
      it(name, (test) => {
        const dir = makeDirectory(test);
        mkdirSync(join(dir, 'searchable'));
        const target = join('searchable', file);
        const path = join(dir, target);
        if (symlink) symlinkSync('uncreated.md', path);
        const result = runCommand([...flags, target], dir);
        if (shape === 'glob-shaped' || flags.length) {
          const stdout = writeLines(shape === 'glob-shaped' ? [skipped(path), CLEAN] : [recordedMissing(path), '', MISSING_COUNT]);
          assert.deepEqual(result, { code: 0, stdout, stderr: '' });
        } else {
          assert.equal(result.stderr, '');
          const block = readBlock({ code: result.code, lines: readLines(result.stdout) }, [[TARGET_CLASS, 1]], [target]);
          checkFinding(block.findings[0], `${target}: `, 'missing', TARGET_REMEDY.missing);
          assert.doesNotMatch(result.stdout, /^\[release-scan\]/m);
        }
      });
    }
  }
  it('directory containing a dangling symlink', (test) => {
    const dir = makeDirectory(test);
    mkdirSync(join(dir, 'links'));
    const target = join('links', 'dangling.md');
    symlinkSync('absent.md', join(dir, target));
    checkStatGuard(dir, 'links', target, 'ENOENT');
  });
});
