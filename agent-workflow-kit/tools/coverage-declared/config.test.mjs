import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { constants, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isLineUnsafe } from '../source-size-refusal.mjs';

const declared = await import('./index.mjs').catch(() => ({}));
const SHAPE = '{ "schema": 1, "_README"?: string, "entries": [{ "path": string, "reason": string }, ...] }';
const REASON = 'Copied to a temporary directory and tested there.';
const BYTES = Buffer.from('{ "schema": 1, "entries": [] }\n');
const HASH = createHash('sha256').update(BYTES).digest('hex');
const ABSENT = { state: 'absent' };
const REGULAR = { state: 'regular', bytes: BYTES, hash: HASH };
const UNREADABLE = { state: 'unreadable', defect: 'directory' };
const WITHOUT_NONBLOCK = Object.fromEntries(Object.entries(constants).filter(([name]) => name !== 'O_NONBLOCK'));
const CHILD_TIMEOUT = 3000;
const temporaryRoot = mkdtempSync(join(tmpdir(), 'coverage-declared-config-'));
after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

const makeDirectory = () => mkdtempSync(join(temporaryRoot, 'case-'));
const encodeList = (entries) => Buffer.from(JSON.stringify({ schema: 1, entries }));
const fixtureEnv = () => Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !name.startsWith('AW_') && name !== 'NODE_TEST_CONTEXT'));
const assertDefect = (result) => {
  assert.equal(typeof result.defect, 'string');
  assert.ok(result.defect.length > 0);
  assert.equal(isLineUnsafe(result.defect), false, result.defect);
};

describe('coverage-declared config', () => {
  it('exports exactly the thirteen names through the door', async () => {
    assert.deepEqual(Object.keys(await import('./index.mjs')).sort(), [
      'COVERAGE_DECLARED_REL', 'DECLARED_LINE_PREFIX', 'DECLARED_REASON_MAX_BYTES',
      'DECLARED_MOVED_FAILURE', 'resolveDeclaredListPath', 'readDeclaredList', 'parseDeclaredList',
      'judgeDeclaredList', 'declaredPassLine', 'declaredStartRefusal', 'declaredAttestValue',
      'compareDeclaredAttest', 'checkDeclaredBinding',
    ].sort());
  });

  it('fixes the constants and resolves the list beneath the supplied top', () => {
    const { COVERAGE_DECLARED_REL, DECLARED_REASON_MAX_BYTES, DECLARED_LINE_PREFIX,
      DECLARED_MOVED_FAILURE, resolveDeclaredListPath } = declared;
    assert.equal(COVERAGE_DECLARED_REL, 'docs/ai/coverage-declared.json');
    assert.equal(DECLARED_REASON_MAX_BYTES, 300);
    assert.equal(DECLARED_LINE_PREFIX, 'coverage-check: declared list — ');
    assert.equal(DECLARED_MOVED_FAILURE, 'the declared coverage list moved under the final run');
    assert.equal(resolveDeclaredListPath(temporaryRoot), join(temporaryRoot, COVERAGE_DECLARED_REL));
  });

  it('reads an absent path as absent', () => {
    const { readDeclaredList } = declared;
    assert.deepEqual(readDeclaredList(join(makeDirectory(), 'missing.json')), ABSENT);
  });

  it('reads regular bytes unchanged and hashes exactly those bytes', () => {
    const { readDeclaredList } = declared;
    const path = join(makeDirectory(), 'list.json');
    writeFileSync(path, BYTES);
    const read = readDeclaredList(path);
    assert.deepEqual(read, REGULAR);
    assert.ok(Buffer.isBuffer(read.bytes));
    assert.match(read.hash, /^[0-9a-f]{64}$/);
  });

  for (const [kind, prepare, cause] of [
    ['symlink', (path) => {
      writeFileSync(`${path}.target`, BYTES);
      symlinkSync(`${path}.target`, path);
    }, /symlink/i],
    ['directory', (path) => mkdirSync(path), /directory/i],
    ['invalid UTF-8', (path) => writeFileSync(path, Buffer.from([0xff])), /UTF-8/i],
  ]) {
    it(`reads a ${kind} as unreadable and names its cause`, () => {
      const { readDeclaredList } = declared;
      const path = join(makeDirectory(), 'list.json');
      prepare(path);
      const read = readDeclaredList(path);
      assert.equal(read.state, 'unreadable');
      assertDefect(read);
      assert.match(read.defect, cause);
    });
  }

  it('reads a FIFO as unreadable without blocking', () => {
    const { readDeclaredList } = declared;
    assert.equal(typeof readDeclaredList, 'function');
    const path = join(makeDirectory(), 'list.json');
    const made = spawnSync('mkfifo', [path], { encoding: 'utf8', env: fixtureEnv(), timeout: CHILD_TIMEOUT });
    assert.equal(made.error, undefined);
    assert.equal(made.status, 0, made.stderr);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const declared = await import(${JSON.stringify(new URL('./index.mjs', import.meta.url).href)});
      process.stdout.write(JSON.stringify(declared.readDeclaredList(process.argv[1])));
    `, path], { encoding: 'utf8', env: fixtureEnv(), timeout: CHILD_TIMEOUT, killSignal: 'SIGKILL' });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
    const read = JSON.parse(child.stdout);
    assert.equal(read.state, 'unreadable');
    assertDefect(read);
    assert.match(read.defect, /FIFO/);
  });

  it('reads again after a rewrite instead of caching a hash', () => {
    const { readDeclaredList } = declared;
    const path = join(makeDirectory(), 'list.json');
    writeFileSync(path, BYTES);
    const firstRead = readDeclaredList(path);
    const replacement = Buffer.from('{"schema":1,"entries":[]}');
    writeFileSync(path, replacement);
    const secondRead = readDeclaredList(path);
    assert.deepEqual(firstRead, REGULAR);
    assert.deepEqual(secondRead, { state: 'regular', bytes: replacement,
      hash: createHash('sha256').update(replacement).digest('hex') });
    assert.notEqual(firstRead.hash, secondRead.hash);
  });

  it('keeps an absent path absent without O_NONBLOCK', () => {
    const { readDeclaredList } = declared;
    assert.deepEqual(readDeclaredList(join(makeDirectory(), 'missing.json'),
      { constants: WITHOUT_NONBLOCK }), ABSENT);
  });

  it('refuses a present regular file without O_NONBLOCK', () => {
    const { readDeclaredList } = declared;
    const path = join(makeDirectory(), 'list.json');
    writeFileSync(path, BYTES);
    const read = readDeclaredList(path, { constants: WITHOUT_NONBLOCK });
    assert.equal(read.state, 'unreadable');
    assertDefect(read);
    assert.match(read.defect, /O_NONBLOCK/);
  });

  it('ends the read as absent only on an lstat answering ENOENT; any other lstat answer goes on to the read', () => {
    const { readDeclaredList } = declared;
    const path = join(makeDirectory(), 'list.json');
    writeFileSync(path, BYTES);
    const observed = [];
    const lstatThrowing = (code) => (suppliedPath) => {
      observed.push(suppliedPath);
      throw Object.assign(new Error(code), { code });
    };
    assert.deepEqual(readDeclaredList(path, { lstat: lstatThrowing('ENOENT') }), ABSENT);
    assert.deepEqual(readDeclaredList(path, { lstat: lstatThrowing('EACCES') }), REGULAR);
    assert.deepEqual(observed, [path, path]);
  });

  it('accepts only the declared JSON shape and prints that shape for every shape defect', () => {
    const { parseDeclaredList } = declared;
    const entry = { path: 'src/fixture.mjs', reason: REASON };
    for (const [value, entries] of [
      [{ schema: 1, entries: [] }, []],
      [{ schema: 1, _README: 'Exact paths only.', entries: [] }, []],
      [{ schema: 1, entries: [entry] }, [entry]],
    ]) assert.deepEqual(parseDeclaredList(Buffer.from(JSON.stringify(value))), { ok: true, entries });
    for (const value of [
      'not JSON', '[]', 'null',
      ...[
        { schema: 2, entries: [] }, { schema: '1', entries: [] },
        { schema: 1 }, { schema: 1, entries: {} }, { schema: 1, entries: [], extra: true },
        { schema: 1, entries: [null] }, { schema: 1, entries: [[]] },
        { schema: 1, entries: [{ path: entry.path }] },
        { schema: 1, entries: [{ ...entry, extra: true }] },
        { schema: 1, _README: 1, entries: [] },
      ].map((value) => JSON.stringify(value)),
    ]) {
      const result = parseDeclaredList(Buffer.from(value));
      assert.equal(result.ok, false, value);
      assertDefect(result);
      assert.ok(result.defect.includes(SHAPE), result.defect);
    }
  });

  it('spec:coverage-declared/S8 accepts literal path bytes and refuses every malformed path', () => {
    const { parseDeclaredList } = declared;
    const accepted = ['src/[id]/x.mjs', 'a*b.mjs', 'plain.js', 'plain.cjs'];
    const entries = accepted.map((path) => ({ path, reason: REASON }));
    assert.deepEqual(parseDeclaredList(encodeList(entries)), { ok: true, entries });
    for (const path of [
      '', null, 1, 'a\u0001b.mjs', 'a\\b.mjs', '/a.mjs', 'a//b.mjs',
      'a/./b.mjs', 'a/../b.mjs', 'a\ud800.mjs', 'a\u007fb.mjs', 'a\u0085b.mjs',
      'a\u2028b.mjs', 'a\u2029b.mjs', 'x.test.mjs', 'x.ts', 'README.md',
    ]) {
      const result = parseDeclaredList(encodeList([{ path, reason: REASON }]));
      assert.equal(result.ok, false, JSON.stringify(path));
      assertDefect(result);
    }
    const duplicate = { path: 'src/[id]/x.mjs', reason: 'A different reason.' };
    const result = parseDeclaredList(encodeList([...entries, duplicate]));
    assert.equal(result.ok, false);
    assertDefect(result);
  });

  it('requires a nonblank safe reason of at most 300 UTF-8 bytes', () => {
    const { parseDeclaredList } = declared;
    const boundary = '\u00e9'.repeat(150);
    assert.equal(Buffer.byteLength(boundary, 'utf8'), 300);
    const entry = { path: 'fixture.mjs', reason: boundary };
    assert.deepEqual(parseDeclaredList(encodeList([entry])), { ok: true, entries: [entry] });
    for (const reason of ['', '   ', `${boundary}a`, 'first\nsecond', 1, null, '\ud800', '\u007f', '\u2028']) {
      const result = parseDeclaredList(encodeList([{ ...entry, reason }]));
      assert.equal(result.ok, false, JSON.stringify(reason));
      assertDefect(result);
      assert.match(result.defect, /reason/i);
    }
  });

  it('maps absent regular and unreadable reads to their attestation values', () => {
    const { declaredAttestValue } = declared;
    for (const [read, expected] of [[ABSENT, 'none'], [REGULAR, HASH], [UNREADABLE, null]]) {
      assert.equal(declaredAttestValue(read), expected);
    }
  });

  it('accepts exactly the two attestation cells and refuses every other cell', () => {
    const { compareDeclaredAttest } = declared;
    for (const [handed, read] of [['none', ABSENT], [HASH, REGULAR]]) {
      assert.deepEqual(compareDeclaredAttest(handed, read), { accepted: true });
    }
    for (const read of [ABSENT, REGULAR, UNREADABLE]) {
      for (const handed of [undefined, null, false, 1, [], {}, '', 'bad', HASH.toUpperCase(), '0'.repeat(63),
        '0'.repeat(65), 'none', HASH, '0'.repeat(64)]) {
        if ((handed === 'none' && read === ABSENT) || (handed === HASH && read === REGULAR)) continue;
        const result = compareDeclaredAttest(handed, read);
        assert.deepEqual(Object.keys(result).sort(), ['accepted', 'handed', 'read']);
        assert.equal(result.accepted, false);
        assert.equal(typeof result.handed, 'string');
        assert.equal(typeof result.read, 'string');
        assert.ok(result.handed.length > 0);
        assert.ok(result.read.length > 0);
        assert.equal(isLineUnsafe(result.handed), false);
        assert.equal(isLineUnsafe(result.read), false);
      }
    }
  });
});
