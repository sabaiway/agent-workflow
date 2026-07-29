import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, readdirSync,
  openSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  FLOW_STORE_BASENAME, FLOW_STORE_STOP, FLOW_LOCK_SUFFIX,
  resolveFlowStorePath, resolveFlowLockPath, parseFlowStoreText, readFlowStore, appendFlowRecord,
} from './flow-store.mjs';
import { FLOW_SCHEMA_VERSION, canonicalFlowDigest } from './flow-record.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-flow-store-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

let seq = 0;
const makeRepo = () => {
  const root = join(TMP, `repo-${seq += 1}`);
  mkdirSync(root, { recursive: true });
  sh(['init', '-q', '-b', 'main'], root);
  sh(['config', 'user.email', 'coder-tools@proton.me'], root);
  sh(['config', 'user.name', 'coder-tool'], root);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  sh(['add', '-A'], root);
  sh(['commit', '-q', '-m', 'init'], root);
  return root;
};
const addWorktree = (root) => {
  const wt = join(TMP, `wt-${seq += 1}`);
  sh(['worktree', 'add', '-q', wt], root);
  return wt;
};

const BASE = 'ad'.repeat(20);
const FP = 'a1'.repeat(32);
const D = (pair) => pair.repeat(32);
const TS = '2026-07-29T00:00:00.000Z';
const TS2 = '2026-07-29T00:00:01.000Z';

const adoption = (over = {}) => ({
  schema: FLOW_SCHEMA_VERSION, kind: 'chain', purpose: 'adoption', planId: 'plan-a', cycle: 1,
  round: 0, commitEpoch: 0, owner: 'wt-main', base: BASE, timestamp: TS, stepId: null,
  fingerprint: FP, planLabel: 'Flow store core', createdAt: TS, planDigest: D('1a'), ...over,
});
const openerRound = (opensFrom, over = {}) => ({
  schema: FLOW_SCHEMA_VERSION, kind: 'chain', purpose: 'round', planId: 'plan-a', cycle: 1,
  round: 1, commitEpoch: 0, owner: 'wt-main', base: BASE, timestamp: TS2, stepId: 'step-1',
  fingerprint: FP, opensFrom, dispatches: [], dispositions: [], ...over,
});
const rerunCause = (attempt, over = {}) => ({
  schema: FLOW_SCHEMA_VERSION, kind: 'rerun-cause', fingerprint: FP,
  cause: 'flaky fixture confirmed', attempt, base: BASE, timestamp: TS, ...over,
});
const downMarkUp = (over = {}) => ({
  schema: FLOW_SCHEMA_VERSION, kind: 'down-mark-up', fingerprint: FP, backend: 'backend-a',
  target: D('4d'), base: BASE, timestamp: TS, ...over,
});

const throwsStop = (fn, re) => assert.throws(fn, (err) => {
  assert.equal(err.code, FLOW_STORE_STOP, `expected a typed flow-store stop, got: ${err.message}`);
  assert.match(err.message, re);
  return true;
});

describe('flow-store — path resolution (common dir + AW_FLOW_STORE seam)', () => {
  it('the main tree and a linked worktree resolve ONE absolute store path in the common git dir', () => {
    const root = makeRepo();
    const wt = addWorktree(root);
    const fromMain = resolveFlowStorePath(root, {});
    const fromLinked = resolveFlowStorePath(wt, {});
    assert.ok(isAbsolute(fromMain), 'the resolved store path must be absolute');
    assert.ok(fromMain.endsWith(FLOW_STORE_BASENAME));
    assert.equal(fromLinked, fromMain, 'flow records must be shared ACROSS worktrees — one common-dir store');
  });

  it('outside a git work tree the resolved path is null (no override)', () => {
    const dir = join(TMP, 'no-repo');
    mkdirSync(dir, { recursive: true });
    assert.equal(resolveFlowStorePath(dir, {}), null);
  });

  it('a bare repository resolves null — the store exists only where a work tree does', () => {
    const bare = join(TMP, 'bare-repo.git');
    sh(['init', '--bare', '-q', bare], TMP);
    assert.equal(resolveFlowStorePath(bare, {}), null, 'a bare repo has a common dir but NO work tree — is-inside-work-tree gates the resolution');
  });

  it('a relative AW_FLOW_STORE is refused loudly from ANY cwd — two cwds must never resolve different stores from one override', () => {
    const root = makeRepo();
    const wt = addWorktree(root);
    for (const cwd of [root, wt]) {
      throwsStop(() => resolveFlowStorePath(cwd, { AW_FLOW_STORE: 'rel/flow.jsonl' }), /AW_FLOW_STORE must be an ABSOLUTE path/);
    }
  });

  it('an absolute AW_FLOW_STORE is normalized — alias spellings resolve ONE store and ONE derived lock', () => {
    const dir = join(TMP, 'ovr');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    const plain = join(dir, 'flow.jsonl');
    const alias = join(dir, 'sub', '..', 'flow.jsonl');
    const resolvedPlain = resolveFlowStorePath(TMP, { AW_FLOW_STORE: plain });
    const resolvedAlias = resolveFlowStorePath(TMP, { AW_FLOW_STORE: alias });
    assert.equal(resolvedPlain, plain);
    assert.equal(resolvedAlias, plain);
    assert.equal(resolveFlowLockPath(resolvedAlias), resolveFlowLockPath(resolvedPlain));
  });

  it('AW_FLOW_STORE works outside a git tree — the override carries its lock with it', () => {
    const bare = join(TMP, 'no-repo-ovr');
    mkdirSync(bare, { recursive: true });
    const target = join(bare, 'flow.jsonl');
    assert.equal(resolveFlowStorePath(bare, { AW_FLOW_STORE: target }), target);
    assert.equal(resolveFlowLockPath(target), `${target}${FLOW_LOCK_SUFFIX}`);
  });

  it('an AW_FLOW_STORE ending with a path separator is refused loudly — a store is a file', () => {
    for (const value of [`${join(TMP, 'ovr-slash', 'flow.jsonl')}/`, '/']) {
      throwsStop(() => resolveFlowStorePath(TMP, { AW_FLOW_STORE: value }), /must not end with a path separator/);
    }
  });

  it('the lock path is derived from the resolved store path as a sibling', () => {
    assert.equal(resolveFlowLockPath('/x/agent-workflow-flow.jsonl'), `/x/agent-workflow-flow.jsonl${FLOW_LOCK_SUFFIX}`);
  });
});

describe('flow-store — the fail-closed reader', () => {
  it('an absent store reads as empty — no records yet is not an error', () => {
    const read = readFlowStore(join(TMP, 'never-written.jsonl'));
    assert.deepEqual(read, { records: [], authoritative: [], malformed: 0, malformedReasons: [] });
  });

  it('the reader exposes the authoritative latest-per-key view beside raw file order', () => {
    const path = join(TMP, 'both-views.jsonl');
    const first = rerunCause('a-1');
    const unrelated = rerunCause('a-2');
    const superseding = rerunCause('a-1', { cause: 'second observation' });
    writeFileSync(path, [first, unrelated, superseding].map((r) => JSON.stringify(r)).join('\n'));
    const read = readFlowStore(path);
    assert.equal(read.malformed, 0);
    assert.deepEqual(read.records.map((r) => r.attempt), ['a-1', 'a-2', 'a-1'], 'raw file order keeps BOTH versions');
    assert.deepEqual(read.authoritative.map((r) => r.attempt), ['a-2', 'a-1'], 'authoritative keeps the latest per key, in file order of latest appearance');
    assert.equal(read.authoritative[1].cause, 'second observation', 'the later record supersedes its key');
  });

  it('valid lines parse into records in file order', () => {
    const path = join(TMP, 'valid.jsonl');
    writeFileSync(path, `${JSON.stringify(rerunCause('a-1'))}\n${JSON.stringify(rerunCause('a-2'))}\n`);
    const read = readFlowStore(path);
    assert.equal(read.malformed, 0);
    assert.deepEqual(read.records.map((r) => r.attempt), ['a-1', 'a-2']);
  });

  it('malformed lines are counted with reasons and never silently dropped', () => {
    const path = join(TMP, 'mixed.jsonl');
    const unknownKind = JSON.stringify({ ...rerunCause('a-1'), kind: 'mystery' });
    writeFileSync(path, `not json\n${unknownKind}\n${JSON.stringify(rerunCause('a-2'))}\n\n`);
    const read = readFlowStore(path);
    assert.equal(read.records.length, 1);
    assert.equal(read.malformed, 2);
    assert.match(read.malformedReasons[0], /line 1: invalid JSON/);
    assert.match(read.malformedReasons[1], /line 2: unknown kind/);
  });

  it('a non-ENOENT read failure is surfaced as readError, never an empty success', () => {
    const asDir = join(TMP, 'store-as-dir');
    mkdirSync(asDir, { recursive: true });
    const read = readFlowStore(asDir);
    assert.equal(read.records.length, 0);
    assert.deepEqual(read.authoritative, [], 'the readError branch still carries both (empty) views');
    assert.ok(read.readError, 'a directory in place of the store must surface a readError');
  });

  it('a dangling symlink in place of the store is a readError, never an empty store', () => {
    const dir = join(TMP, 'reader-symlink');
    mkdirSync(dir, { recursive: true });
    const dangling = join(dir, 'dangling.jsonl');
    symlinkSync(join(dir, 'nowhere'), dangling);
    const readDangling = readFlowStore(dangling);
    assert.ok(readDangling.readError, 'a dangling symlink must surface a readError — an "empty store" here is a fail-open for the checker');
    assert.match(readDangling.readError, /symlink/);
    assert.deepEqual(readDangling.records, []);
    writeFileSync(join(dir, 'real.jsonl'), `${JSON.stringify(rerunCause('a-1'))}\n`);
    const live = join(dir, 'live.jsonl');
    symlinkSync(join(dir, 'real.jsonl'), live);
    const readLive = readFlowStore(live);
    assert.ok(readLive.readError, 'a LIVE symlink also refuses — the writer never writes through one, so a symlinked store is foreign by construction');
    assert.deepEqual(readLive.records, []);
  });

  it('the reader never accepts bytes read through a swapped-in symlink — the descriptor, not the path, is the source of truth', () => {
    const dir = join(TMP, 'reader-swap');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const foreign = join(dir, 'foreign.jsonl');
    writeFileSync(store, `${JSON.stringify(rerunCause('genuine-1'))}\n`);
    writeFileSync(foreign, `${JSON.stringify(rerunCause('foreign-1'))}\n`);
    let swapped = false;
    const read = readFlowStore(store, {
      open: (p, flags) => {
        const fd = openSync(p, flags);
        rmSync(store, { force: true });
        symlinkSync(foreign, store);
        swapped = true;
        return fd;
      },
    });
    assert.ok(swapped, 'the carrier must actually exercise the swap');
    assert.ok(!read.records.some((r) => r.attempt === 'foreign-1'), 'foreign bytes behind a swapped-in symlink must never be accepted as the store');
    assert.equal(read.readError, undefined);
    assert.deepEqual(read.records.map((r) => r.attempt), ['genuine-1'], 'the descriptor pins the original inode — the swapped pathname is irrelevant');
  });

  it('invalid UTF-8 in the store is a readError, never a silent U+FFFD rewrite', () => {
    const path = join(TMP, 'bad-utf8.jsonl');
    const buf = Buffer.from(`${JSON.stringify(rerunCause('a-1'))}\n`, 'utf8');
    buf[buf.indexOf(Buffer.from('flaky'))] = 0xff;
    writeFileSync(path, buf);
    const read = readFlowStore(path);
    assert.match(read.readError ?? '', /invalid UTF-8/, 'a lossy decode would silently fork the record digest identity');
    assert.deepEqual(read.records, []);
  });

  it('a platform without a usable O_NONBLOCK fails closed before any open — a FIFO could block forever', () => {
    let opened = false;
    const read = readFlowStore(join(TMP, 'never.jsonl'), {
      constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000, O_NONBLOCK: 0 },
      open: () => { opened = true; return 3; },
    });
    assert.match(read.readError ?? '', /O_NONBLOCK/);
    assert.equal(opened, false, 'nothing may be opened without a non-blocking flag');
  });

  it('without O_NOFOLLOW the portable lane classifies by lstat first and binds the open to the observed inode', () => {
    const regular = (dev, ino) => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, isFIFO: () => false, dev, ino });
    const io = (fstatStat) => ({
      constants: { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 0x800 },
      lstat: () => regular(1, 42),
      open: () => 7,
      fstat: () => fstatStat,
      readFile: () => Buffer.from(`${JSON.stringify(rerunCause('a-1'))}\n`),
      close: () => {},
    });
    const swapped = readFlowStore(join(TMP, 'portable.jsonl'), io(regular(1, 43)));
    assert.match(swapped.readError ?? '', /changed identity between lstat and open/);
    const clean = readFlowStore(join(TMP, 'portable.jsonl'), io(regular(1, 42)));
    assert.equal(clean.readError, undefined);
    assert.deepEqual(clean.records.map((r) => r.attempt), ['a-1']);
  });

  it('an open failure on a non-regular leaf classifies via lstat without reading — sockets and devices refuse by name', () => {
    const nonRegularStat = { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false, isFIFO: () => false };
    const read = readFlowStore(join(TMP, 'socketish.jsonl'), {
      open: () => { throw Object.assign(new Error('ENXIO'), { code: 'ENXIO' }); },
      lstat: () => nonRegularStat,
    });
    assert.match(read.readError, /non-regular file/);
    assert.deepEqual(read.records, []);
  });

  it('a BOM-prefixed store is malformed, never silently accepted and rewritten without its BOM', () => {
    const path = join(TMP, 'bom.jsonl');
    writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${JSON.stringify(rerunCause('a-1'))}\n`)]));
    const read = readFlowStore(path);
    assert.equal(read.malformed, 1, 'the BOM byte belongs to line 1 — it must surface as malformed, not vanish in the decode');
    assert.match(read.malformedReasons[0], /line 1: invalid JSON/);
    assert.deepEqual(read.records, []);
  });

  it('a FIFO in place of the store is a readError, never a hang', () => {
    const dir = join(TMP, 'reader-fifo');
    mkdirSync(dir, { recursive: true });
    const fifo = join(dir, 'fifo.jsonl');
    const made = spawnSync('mkfifo', [fifo]);
    assert.equal(made.status, 0, 'mkfifo must succeed for this fixture');
    const read = readFlowStore(fifo);
    assert.ok(read.readError, 'a FIFO must surface a readError — an unguarded read would block forever');
    assert.match(read.readError, /FIFO/);
    assert.deepEqual(read.records, []);
  });

  it('parseFlowStoreText skips blank lines only', () => {
    const parsed = parseFlowStoreText(`\n${JSON.stringify(rerunCause('a-1'))}\n  \n`);
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.malformed, 0);
  });
});

describe('flow-store — append: validate-before-write, semantic preflight, atomic transition', () => {
  it('a valid record appends atomically and the lock is released — no tmp or lock file remains', () => {
    const root = makeRepo();
    const record = adoption();
    const { writtenPath } = appendFlowRecord({ cwd: root, record, env: {} });
    assert.equal(writtenPath, resolveFlowStorePath(root, {}));
    assert.equal(readFileSync(writtenPath, 'utf8'), `${JSON.stringify(record)}\n`);
    const siblings = readdirSync(dirname(writtenPath));
    assert.ok(!siblings.some((f) => f.includes('.tmp')), `no tmp residue: ${siblings}`);
    assert.ok(!siblings.includes(`${FLOW_STORE_BASENAME}${FLOW_LOCK_SUFFIX}`), 'the lock must be released after a successful append');
  });

  it('appends from the main tree and a linked worktree land in ONE store', () => {
    const root = makeRepo();
    const wt = addWorktree(root);
    appendFlowRecord({ cwd: root, record: rerunCause('a-main'), env: {} });
    appendFlowRecord({ cwd: wt, record: rerunCause('a-linked'), env: {} });
    const read = readFlowStore(resolveFlowStorePath(root, {}));
    assert.equal(read.malformed, 0);
    assert.deepEqual(read.records.map((r) => r.attempt), ['a-main', 'a-linked']);
  });

  it('a malformed record is refused before any write', () => {
    const dir = join(TMP, 'append-malformed');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    throwsStop(
      () => appendFlowRecord({ record: { kind: 'mystery' }, env: { AW_FLOW_STORE: store } }),
      /refusing to write a malformed flow record/,
    );
    assert.deepEqual(readdirSync(dir), [], 'nothing may be written — no store, no lock, no tmp');
  });

  it('appending to a store carrying malformed lines is refused — fail closed in both directions', () => {
    const dir = join(TMP, 'append-poisoned');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    writeFileSync(store, 'not json\n');
    throwsStop(
      () => appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: store } }),
      /refusing to append to a flow store carrying 1 malformed line/,
    );
    assert.equal(readFileSync(store, 'utf8'), 'not json\n', 'the poisoned store stays untouched');
  });

  it('a byte-identical replayed line is refused as a duplicate', () => {
    const dir = join(TMP, 'append-replay');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const record = rerunCause('a-1');
    appendFlowRecord({ record, env: { AW_FLOW_STORE: store } });
    throwsStop(
      () => appendFlowRecord({ record, env: { AW_FLOW_STORE: store } }),
      /byte-identical replayed line/,
    );
    assert.equal(readFileSync(store, 'utf8'), `${JSON.stringify(record)}\n`);
  });

  it('a prefix without a trailing newline is repaired, not corrupted', () => {
    const dir = join(TMP, 'append-no-newline');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    writeFileSync(store, JSON.stringify(rerunCause('a-1')));
    appendFlowRecord({ record: rerunCause('a-2'), env: { AW_FLOW_STORE: store } });
    const read = readFlowStore(store);
    assert.equal(read.malformed, 0);
    assert.deepEqual(read.records.map((r) => r.attempt), ['a-1', 'a-2']);
  });

  it('an illegal chain transition never lands — a second adoption is refused', () => {
    const dir = join(TMP, 'append-chain');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    appendFlowRecord({ record: adoption(), env: { AW_FLOW_STORE: store } });
    throwsStop(
      () => appendFlowRecord({ record: adoption({ timestamp: TS2 }), env: { AW_FLOW_STORE: store } }),
      /refusing an illegal chain record: .*adoption is only ever the chain's first record/,
    );
    assert.equal(readFlowStore(store).records.length, 1, 'the illegal record never lands');
  });

  it('a chain never opens without adoption — a round into an empty chain is refused', () => {
    const dir = join(TMP, 'append-no-adoption');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    throwsStop(
      () => appendFlowRecord({ record: openerRound(D('2b')), env: { AW_FLOW_STORE: store } }),
      /refusing an illegal chain record: .*starts at adoption/,
    );
    assert.equal(readFlowStore(store).records.length, 0);
  });

  it('a step-opening round without the prior-terminal reference is refused; with it, it lands', () => {
    const dir = join(TMP, 'append-opener');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const first = adoption();
    appendFlowRecord({ record: first, env: { AW_FLOW_STORE: store } });
    throwsStop(
      () => appendFlowRecord({ record: openerRound(null), env: { AW_FLOW_STORE: store } }),
      /refusing an illegal chain record: .*must carry the prior-terminal reference/,
    );
    appendFlowRecord({ record: openerRound(canonicalFlowDigest(first)), env: { AW_FLOW_STORE: store } });
    assert.equal(readFlowStore(store).records.length, 2);
  });

  it('an illegal supersession never lands — an up targeting no active down-mark is refused', () => {
    const dir = join(TMP, 'append-supersession');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    throwsStop(
      () => appendFlowRecord({ record: downMarkUp(), env: { AW_FLOW_STORE: store } }),
      /refusing an illegal supersession/,
    );
    assert.equal(readFlowStore(store).records.length, 0);
  });

  it('a store whose EXISTING records already violate semantic legality refuses further appends by name', () => {
    const dir = join(TMP, 'append-pre-broken');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    writeFileSync(store, `${JSON.stringify(downMarkUp())}\n`);
    throwsStop(
      () => appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: store } }),
      /existing records already violate supersession legality/,
    );
    assert.equal(readFlowStore(store).records.length, 1, 'the pre-broken store stays untouched');
  });

  it('a store whose EXISTING chain is already illegal refuses a further chain append by name', () => {
    const dir = join(TMP, 'append-pre-broken-chain');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    writeFileSync(store, `${JSON.stringify(openerRound(D('2b')))}\n`);
    throwsStop(
      () => appendFlowRecord({ record: adoption({ timestamp: TS2 }), env: { AW_FLOW_STORE: store } }),
      /existing chain for plan "plan-a" is already illegal/,
    );
  });

  it('a symlinked store leaf refuses pre-write', () => {
    const dir = join(TMP, 'symlink-leaf');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'real.jsonl'), '');
    const store = join(dir, 'flow.jsonl');
    symlinkSync(join(dir, 'real.jsonl'), store);
    throwsStop(
      () => appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: store } }),
      /symlink/,
    );
    assert.equal(readFileSync(join(dir, 'real.jsonl'), 'utf8'), '', 'the symlink target stays untouched');
  });

  it('a symlinked parent dir refuses pre-write', () => {
    const real = join(TMP, 'symlink-parent-real');
    mkdirSync(real, { recursive: true });
    const linked = join(TMP, 'symlink-parent-link');
    symlinkSync(real, linked);
    throwsStop(
      () => appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: join(linked, 'flow.jsonl') } }),
      /symlink/,
    );
    assert.deepEqual(readdirSync(real), [], 'nothing may be written through the symlinked parent');
  });

  it('a symlinked lock path refuses pre-write', () => {
    const dir = join(TMP, 'symlink-lock');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'elsewhere'), '');
    const store = join(dir, 'flow.jsonl');
    symlinkSync(join(dir, 'elsewhere'), resolveFlowLockPath(store));
    throwsStop(
      () => appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: store } }),
      /lock.*symlink|symlink/,
    );
    assert.ok(!readdirSync(dir).includes('flow.jsonl'), 'nothing may be written beside a symlinked lock');
  });

  it('a missing store parent dir is a named lock-creation refusal, never a silent mkdir', () => {
    throwsStop(
      () => appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: join(TMP, 'no-such-dir', 'flow.jsonl') } }),
      /cannot create the flow-store lock .*ENOENT.* — the store's parent dir must exist and be writable/,
    );
  });

  it('a record whose inherited toJSON forges the serialization is refused — the validated snapshot IS the written line', () => {
    const dir = join(TMP, 'append-tojson');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const rec = Object.assign(Object.create({ toJSON() { return { ...this, forged: 1 }; } }), rerunCause('a-1'));
    throwsStop(
      () => appendFlowRecord({ record: rec, env: { AW_FLOW_STORE: store } }),
      /refusing to write a malformed flow record: .*"forged"/,
    );
    assert.deepEqual(readdirSync(dir), [], 'the poison line never lands — the store its own reader would reject is never written');
  });

  it('an unserializable record is a named refusal — a circular reference cannot reach the store', () => {
    const dir = join(TMP, 'append-circular');
    mkdirSync(dir, { recursive: true });
    const rec = { ...rerunCause('a-1') };
    rec.cause = rec;
    throwsStop(
      () => appendFlowRecord({ record: rec, env: { AW_FLOW_STORE: join(dir, 'flow.jsonl') } }),
      /cannot capture a canonical serialization of the record/,
    );
    assert.deepEqual(readdirSync(dir), [], 'nothing may be written for an unserializable record');
  });

  it('a getter that mutates between validation and serialization cannot fork the written bytes', () => {
    const dir = join(TMP, 'append-getter');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    let reads = 0;
    const rec = { ...rerunCause('a-1') };
    Object.defineProperty(rec, 'attempt', { enumerable: true, get() { reads += 1; return reads === 1 ? 'a-1' : 123; } });
    appendFlowRecord({ record: rec, env: { AW_FLOW_STORE: store } });
    const read = readFlowStore(store);
    assert.equal(read.malformed, 0, 'the written bytes must be exactly what validated — a second getter read can never fork them');
    assert.deepEqual(read.records.map((r) => r.attempt), ['a-1']);
  });

  it('appending outside a git tree without an override is a named refusal', () => {
    const bare = join(TMP, 'append-no-repo');
    mkdirSync(bare, { recursive: true });
    throwsStop(
      () => appendFlowRecord({ cwd: bare, record: rerunCause('a-1'), env: {} }),
      /not inside a git work tree/,
    );
  });
});
