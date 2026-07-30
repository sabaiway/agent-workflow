import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, readdirSync,
  openSync, unlinkSync, chmodSync, lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  FLOW_STORE_BASENAME, FLOW_STORE_STOP, FLOW_LOCK_SUFFIX,
  resolveFlowStorePath, resolveFlowLockPath, parseFlowStoreText, readFlowStore, appendFlowRecord,
  mintBookkeepingDelta, computeMaskedFingerprintPayload,
} from './flow-store.mjs';
import { FLOW_SCHEMA_VERSION, canonicalFlowDigest } from './flow-record.mjs';
import { computeTreeFingerprint, computeFingerprintPayload } from './core-evidence.mjs';

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

describe('flow-store — bookkeeping-delta custody proof (masked revert-and-recompute at mint time)', () => {
  const sha256hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

  it('an untracked create (absent→present) mints with a proven confinement and persists the proof payload', () => {
    const root = makeRepo();
    const fpBefore = computeTreeFingerprint(root);
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'log.md'), 'delta v1\n');
    const { record, digest } = mintBookkeepingDelta({ cwd: root, env: {}, path: 'notes/log.md', fingerprintBefore: fpBefore, preContent: null });
    assert.equal(record.kind, 'bookkeeping-delta');
    assert.equal(record.path, 'notes/log.md');
    assert.equal(record.fingerprintBefore, fpBefore);
    assert.equal(record.fingerprintAfter, computeTreeFingerprint(root));
    assert.equal(record.contentDigest, sha256hex('delta v1\n'));
    assert.deepEqual(record.custodyProof, {
      preClass: 'absent', tracked: false, headDigest: null, indexDigest: null,
      worktreeDigest: null, maskedFingerprint: fpBefore,
    });
    assert.equal(digest, canonicalFlowDigest(record));
    assert.deepEqual(readFlowStore(resolveFlowStorePath(root, {})).records, [record]);
  });

  it('an untracked edit (present→present) and an untracked delete (present→absent) both mint with proofs', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'scratch.md'), 'v1\n');
    const fp1 = computeTreeFingerprint(root);
    writeFileSync(join(root, 'scratch.md'), 'v2\n');
    const edit = mintBookkeepingDelta({ cwd: root, env: {}, path: 'scratch.md', fingerprintBefore: fp1, preContent: 'v1\n' });
    assert.equal(edit.record.custodyProof.preClass, 'present');
    assert.equal(edit.record.custodyProof.worktreeDigest, sha256hex('v1\n'));
    assert.equal(edit.record.custodyProof.maskedFingerprint, fp1);
    assert.equal(edit.record.contentDigest, sha256hex('v2\n'));
    const fp2 = computeTreeFingerprint(root);
    unlinkSync(join(root, 'scratch.md'));
    const del = mintBookkeepingDelta({ cwd: root, env: {}, path: 'scratch.md', fingerprintBefore: fp2, preContent: 'v2\n' });
    assert.equal(del.record.contentDigest, null, 'the path lands absent — contentDigest is null');
    assert.equal(del.record.custodyProof.worktreeDigest, sha256hex('v2\n'));
    assert.equal(del.record.custodyProof.maskedFingerprint, fp2);
  });

  it('a tracked unstaged edit (present→present) mints — the pre-state equals the index entry (clean-at-path)', () => {
    const root = makeRepo();
    const fpBefore = computeTreeFingerprint(root);
    writeFileSync(join(root, 'base.txt'), 'base EDITED\n');
    const { record } = mintBookkeepingDelta({ cwd: root, env: {}, path: 'base.txt', fingerprintBefore: fpBefore, preContent: 'base\n' });
    assert.equal(record.custodyProof.tracked, true);
    assert.equal(record.custodyProof.headDigest, sha256hex('base\n'));
    assert.equal(record.custodyProof.indexDigest, sha256hex('base\n'));
    assert.equal(record.custodyProof.worktreeDigest, sha256hex('base\n'));
    assert.equal(record.custodyProof.maskedFingerprint, fpBefore);
  });

  it('window-constant staged and untracked noise stays inside the proof — only the declared path may move', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'staged.txt'), 'staged change\n');
    sh(['add', 'staged.txt'], root);
    writeFileSync(join(root, 'noise.md'), 'constant untracked noise\n');
    const fpBefore = computeTreeFingerprint(root);
    writeFileSync(join(root, 'base.txt'), 'edited under noise\n');
    const { record } = mintBookkeepingDelta({ cwd: root, env: {}, path: 'base.txt', fingerprintBefore: fpBefore, preContent: 'base\n' });
    assert.equal(record.custodyProof.maskedFingerprint, fpBefore);
    assert.equal(record.fingerprintAfter, computeTreeFingerprint(root));
  });

  it('an unconfined delta refuses to mint — nothing lands', () => {
    const root = makeRepo();
    const fpBefore = computeTreeFingerprint(root);
    writeFileSync(join(root, 'a.md'), 'a\n');
    writeFileSync(join(root, 'b.md'), 'b\n');
    throwsStop(
      () => mintBookkeepingDelta({ cwd: root, env: {}, path: 'a.md', fingerprintBefore: fpBefore, preContent: null }),
      /NOT confined to the declared path/,
    );
    assert.equal(readFlowStore(resolveFlowStorePath(root, {})).records.length, 0);
  });

  it('the custody proof computation leaves the working tree untouched', () => {
    const root = makeRepo();
    const fpBefore = computeTreeFingerprint(root);
    writeFileSync(join(root, 'a.md'), 'a\n');
    const payloadBefore = computeFingerprintPayload(root);
    mintBookkeepingDelta({ cwd: root, env: {}, path: 'a.md', fingerprintBefore: fpBefore, preContent: null });
    assert.ok(payloadBefore.equals(computeFingerprintPayload(root)), 'the whole review-domain payload is byte-identical after the mint');
    assert.equal(readFileSync(join(root, 'a.md'), 'utf8'), 'a\n');
  });

  it('an unsupported pre-state class refuses to mint by name', () => {
    const root = makeRepo();
    const fpBefore = computeTreeFingerprint(root);
    symlinkSync('base.txt', join(root, 'link.md'));
    throwsStop(
      () => mintBookkeepingDelta({ cwd: root, env: {}, path: 'link.md', fingerprintBefore: fpBefore, preContent: null }),
      /symlink.*unsupported pre-state class/,
    );
    unlinkSync(join(root, 'link.md'));
    writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 0, 2]));
    throwsStop(
      () => mintBookkeepingDelta({ cwd: root, env: {}, path: 'bin.dat', fingerprintBefore: fpBefore, preContent: null }),
      /binary.*unsupported pre-state class/,
    );
    unlinkSync(join(root, 'bin.dat'));
    throwsStop(
      () => mintBookkeepingDelta({ cwd: root, env: {}, path: 'gone.dat', fingerprintBefore: fpBefore, preContent: Buffer.from([1, 0, 2]) }),
      /binary.*unsupported pre-state class/,
    );
    writeFileSync(join(root, 'exec.sh'), 'echo run\n');
    chmodSync(join(root, 'exec.sh'), 0o755);
    throwsStop(
      () => mintBookkeepingDelta({ cwd: root, env: {}, path: 'exec.sh', fingerprintBefore: fpBefore, preContent: null }),
      /executable mode.*unsupported pre-state class/,
    );
    unlinkSync(join(root, 'exec.sh'));
    mkdirSync(join(root, 'adir'));
    throwsStop(
      () => mintBookkeepingDelta({ cwd: root, env: {}, path: 'adir', fingerprintBefore: fpBefore, preContent: null }),
      /is a directory — an unsupported pre-state class/,
    );
    rmSync(join(root, 'adir'), { recursive: true });
    throwsStop(
      () => mintBookkeepingDelta({ cwd: root, env: {}, path: 'base.txt', fingerprintBefore: fpBefore, preContent: 'never what the index held\n' }),
      /dirty pre-state.*unsupported pre-state class/,
    );
    throwsStop(
      () => mintBookkeepingDelta({ cwd: root, env: {}, path: 'ghost.md', fingerprintBefore: fpBefore, preContent: null }),
      /absent→absent.*unsupported/,
    );
    throwsStop(
      () => mintBookkeepingDelta({ cwd: root, env: {}, path: 'quo"te.md', fingerprintBefore: fpBefore, preContent: null }),
      /diff-header quoting.*unsupported pre-state class/,
    );
    throwsStop(
      () => mintBookkeepingDelta({ cwd: root, env: {}, path: '/abs/route.md', fingerprintBefore: fpBefore, preContent: null }),
      /repo-relative/,
    );
    assert.equal(readFlowStore(resolveFlowStorePath(root, {})).records.length, 0, 'no refused class ever lands');
  });

  it('a malformed fingerprintBefore is refused before any tree work', () => {
    throwsStop(
      () => mintBookkeepingDelta({ cwd: TMP, env: {}, path: 'x.md', fingerprintBefore: 'nope', preContent: null }),
      /fingerprintBefore must be the 64-hex PRE-DELTA tree fingerprint/,
    );
  });

  it('an unmerged index entry at the declared path refuses by name', () => {
    const root = makeRepo();
    sh(['checkout', '-q', '-b', 'side'], root);
    writeFileSync(join(root, 'base.txt'), 'side\n');
    sh(['add', '-A'], root);
    sh(['commit', '-q', '-m', 'side'], root);
    sh(['checkout', '-q', 'main'], root);
    writeFileSync(join(root, 'base.txt'), 'main2\n');
    sh(['add', '-A'], root);
    sh(['commit', '-q', '-m', 'main2'], root);
    const merge = spawnSync('git', ['merge', 'side'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(merge.status, 0, 'the fixture needs a real conflict');
    throwsStop(
      () => mintBookkeepingDelta({ cwd: root, env: {}, path: 'base.txt', fingerprintBefore: computeTreeFingerprint(root), preContent: 'main2\n' }),
      /unmerged or unparseable index entry/,
    );
  });

  it('a non-100644 index mode refuses even when the worktree mode is plain', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'tool.sh'), 'echo run\n');
    chmodSync(join(root, 'tool.sh'), 0o755);
    sh(['add', 'tool.sh'], root);
    sh(['commit', '-q', '-m', 'exec'], root);
    chmodSync(join(root, 'tool.sh'), 0o644);
    const fpBefore = computeTreeFingerprint(root);
    throwsStop(
      () => mintBookkeepingDelta({ cwd: root, env: {}, path: 'tool.sh', fingerprintBefore: fpBefore, preContent: 'echo run\n' }),
      /carries mode 100755 .*unsupported pre-state class/,
    );
  });

  it('a staged deletion (HEAD entry without an index entry) refuses by name', () => {
    const root = makeRepo();
    sh(['rm', '--cached', '-q', 'base.txt'], root);
    const fpBefore = computeTreeFingerprint(root);
    throwsStop(
      () => mintBookkeepingDelta({ cwd: root, env: {}, path: 'base.txt', fingerprintBefore: fpBefore, preContent: 'base\n' }),
      /HEAD entry but no index entry \(a staged deletion\)/,
    );
  });

  it('a tracked path with a declared-absent pre-state refuses as a dirty pre-state', () => {
    const root = makeRepo();
    const fpBefore = computeTreeFingerprint(root);
    throwsStop(
      () => mintBookkeepingDelta({ cwd: root, env: {}, path: 'base.txt', fingerprintBefore: fpBefore, preContent: null }),
      /tracked while its pre-change worktree state is absent/,
    );
  });

  it('an ls-tree failure with an existing HEAD refuses by name — never read as an unborn HEAD', () => {
    const root = makeRepo();
    const fpBefore = computeTreeFingerprint(root);
    writeFileSync(join(root, 'fresh.md'), 'f\n');
    const realRun = (args, dir) => spawnSync('git', args, { cwd: dir, windowsHide: true });
    throwsStop(
      () => mintBookkeepingDelta({
        cwd: root, env: {}, path: 'fresh.md', fingerprintBefore: fpBefore, preContent: null,
        deps: { runGit: (args, dir) => (args[0] === 'ls-tree' ? { status: 128 } : realRun(args, dir)) },
      }),
      /cannot read the HEAD entry .*existing HEAD.*fail closed/,
    );
  });

  it('a rev-parse failure that is not the exact verify-miss refuses — unborn is proven, never assumed', () => {
    const root = makeRepo();
    const fpBefore = computeTreeFingerprint(root);
    writeFileSync(join(root, 'fresh3.md'), 'f\n');
    const realRun = (args, dir) => spawnSync('git', args, { cwd: dir, windowsHide: true });
    throwsStop(
      () => mintBookkeepingDelta({
        cwd: root, env: {}, path: 'fresh3.md', fingerprintBefore: fpBefore, preContent: null,
        deps: { runGit: (args, dir) => (args[0] === 'rev-parse' ? { status: 128 } : realRun(args, dir)) },
      }),
      /cannot decide the HEAD state/,
    );
  });

  it('unparseable non-empty ls-tree output refuses — never read as "no HEAD entry"', () => {
    const root = makeRepo();
    const fpBefore = computeTreeFingerprint(root);
    writeFileSync(join(root, 'fresh4.md'), 'f\n');
    const realRun = (args, dir) => spawnSync('git', args, { cwd: dir, windowsHide: true });
    throwsStop(
      () => mintBookkeepingDelta({
        cwd: root, env: {}, path: 'fresh4.md', fingerprintBefore: fpBefore, preContent: null,
        deps: { runGit: (args, dir) => (args[0] === 'ls-tree' ? { status: 0, stdout: Buffer.from('garbage output\n') } : realRun(args, dir)) },
      }),
      /cannot parse the HEAD entry/,
    );
  });

  it('a declared-path mutation during the capture refuses — contentDigest and the payload bind ONE post-state', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'noise.md'), 'n\n');
    const fpBefore = computeTreeFingerprint(root);
    writeFileSync(join(root, 'base.txt'), 'edited v1\n');
    const realRun = (args, dir) => spawnSync('git', args, { cwd: dir, windowsHide: true });
    let fired = false;
    throwsStop(
      () => mintBookkeepingDelta({
        cwd: root, env: {}, path: 'base.txt', fingerprintBefore: fpBefore, preContent: 'base\n',
        deps: {
          runGit: (args, dir) => {
            if (!fired && args[0] === 'cat-file') {
              fired = true;
              writeFileSync(join(root, 'base.txt'), 'edited v2 mutated\n');
            }
            return realRun(args, dir);
          },
        },
      }),
      /moved under the mint/,
    );
  });

  it('an undecidable HEAD state (rev-parse and symbolic-ref both failing) refuses by name', () => {
    const root = makeRepo();
    const fpBefore = computeTreeFingerprint(root);
    writeFileSync(join(root, 'fresh2.md'), 'f\n');
    const realRun = (args, dir) => spawnSync('git', args, { cwd: dir, windowsHide: true });
    throwsStop(
      () => mintBookkeepingDelta({
        cwd: root, env: {}, path: 'fresh2.md', fingerprintBefore: fpBefore, preContent: null,
        deps: { runGit: (args, dir) => (args[0] === 'rev-parse' || args[0] === 'symbolic-ref' ? { status: 128 } : realRun(args, dir)) },
      }),
      /cannot decide the HEAD state/,
    );
  });

  it('an unborn HEAD is a legitimately absent HEAD layer — the mint proceeds', () => {
    const root = join(TMP, 'unborn-head-repo');
    mkdirSync(root, { recursive: true });
    sh(['init', '-q', '-b', 'main'], root);
    sh(['config', 'user.email', 'coder-tools@proton.me'], root);
    sh(['config', 'user.name', 'coder-tool'], root);
    const fpBefore = computeTreeFingerprint(root);
    writeFileSync(join(root, 'first.md'), 'x\n');
    const { record } = mintBookkeepingDelta({ cwd: root, env: {}, path: 'first.md', fingerprintBefore: fpBefore, preContent: null });
    assert.equal(record.base, null);
    assert.equal(record.custodyProof.headDigest, null);
    assert.equal(record.custodyProof.tracked, false);
  });

  it('fingerprintAfter derives from the SAME captured read set as the masked recompute — a mid-mint tree move is never certified', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'noise.md'), 'n\n');
    const fpBefore = computeTreeFingerprint(root);
    writeFileSync(join(root, 'declared.md'), 'd\n');
    let fired = false;
    const hookedLstat = (p) => {
      if (!fired && p.endsWith('noise.md')) {
        fired = true;
        writeFileSync(join(root, 'side.md'), 's\n');
      }
      return lstatSync(p);
    };
    const { record } = mintBookkeepingDelta({
      cwd: root, env: {}, path: 'declared.md', fingerprintBefore: fpBefore, preContent: null,
      deps: { lstat: hookedLstat },
    });
    assert.equal(fired, true, 'the fixture must have raced the mint');
    unlinkSync(join(root, 'side.md'));
    assert.equal(record.fingerprintAfter, computeTreeFingerprint(root), 'the certified after-fingerprint binds the snapshot the proof was computed from — never a later tree');
  });

  it('a glob-shaped declared path never binds another file — the layer probes use literal pathspecs', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'ab.md'), 'tracked target\n');
    sh(['add', '-A'], root);
    sh(['commit', '-q', '-m', 'ab'], root);
    const fpBefore = computeTreeFingerprint(root);
    writeFileSync(join(root, 'a[b].md'), 'glob decoy\n');
    const { record } = mintBookkeepingDelta({ cwd: root, env: {}, path: 'a[b].md', fingerprintBefore: fpBefore, preContent: null });
    assert.equal(record.custodyProof.tracked, false, 'the declared path is untracked — a glob match on ab.md must not bind its layers');
    assert.equal(record.custodyProof.indexDigest, null);
    assert.equal(record.custodyProof.maskedFingerprint, fpBefore);
  });

  it('a prefix-valid but unterminated or garbage-suffixed probe answer refuses — the -z parse is strict', () => {
    const root = makeRepo();
    const fpBefore = computeTreeFingerprint(root);
    writeFileSync(join(root, 'fresh5.md'), 'f\n');
    const realRun = (args, dir) => spawnSync('git', args, { cwd: dir, windowsHide: true });
    const sha = 'ab'.repeat(20);
    const inject = (stdout) => ({ runGit: (args, dir) => (args[0] === 'ls-tree' ? { status: 0, stdout: Buffer.from(stdout) } : realRun(args, dir)) });
    throwsStop(
      () => mintBookkeepingDelta({ cwd: root, env: {}, path: 'fresh5.md', fingerprintBefore: fpBefore, preContent: null, deps: inject(`100644 blob ${sha}\tfresh5.md`) }),
      /cannot parse the HEAD entry/,
    );
    throwsStop(
      () => mintBookkeepingDelta({ cwd: root, env: {}, path: 'fresh5.md', fingerprintBefore: fpBefore, preContent: null, deps: inject(`100644 blob ${sha}\tfresh5.md\0garbage\0`) }),
      /cannot parse the HEAD entry/,
    );
  });

  it('an undecidable ignore state is a named refusal (fail closed)', () => {
    const root = makeRepo();
    const fpBefore = computeTreeFingerprint(root);
    writeFileSync(join(root, 'fresh.md'), 'f\n');
    throwsStop(
      () => mintBookkeepingDelta({
        cwd: root, env: {}, path: 'fresh.md', fingerprintBefore: fpBefore, preContent: null,
        deps: { runGit: (args, dir) => (args[0] === 'check-ignore' ? { status: 128 } : spawnSync('git', args, { cwd: dir, windowsHide: true })) },
      }),
      /cannot decide the ignore state/,
    );
  });

  it('the diff-section mask removes a mid-buffer section byte-exactly — a real revert reproduces it', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'zzz.txt'), 'z1\n');
    sh(['add', '-A'], root);
    sh(['commit', '-q', '-m', 'two tracked'], root);
    writeFileSync(join(root, 'base.txt'), 'base moved\n');
    writeFileSync(join(root, 'zzz.txt'), 'z2\n');
    const masked = computeMaskedFingerprintPayload(root, { layer: 'diff', rel: 'zzz.txt' });
    writeFileSync(join(root, 'zzz.txt'), 'z1\n');
    assert.ok(masked.equals(computeFingerprintPayload(root)), 'masking zzz.txt must equal actually reverting zzz.txt');
  });

  it('the untracked complement branches mirror the frozen core under an injected lstat', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'probe.md'), 'p\n');
    const symlinkStat = {
      isCharacterDevice: () => false, isBlockDevice: () => false, isFIFO: () => false, isSocket: () => false,
      isSymbolicLink: () => true, isFile: () => false,
    };
    const asSymlink = computeMaskedFingerprintPayload(root, null, { lstat: () => symlinkStat });
    assert.ok(asSymlink.includes('untracked-symlink:probe.md -> ?'), 'an unreadable link target degrades to "?" exactly like the core');
    const asUnstattable = computeMaskedFingerprintPayload(root, null, { lstat: () => { throw new Error('gone'); } });
    assert.ok(asUnstattable.includes('untracked-nonregular:probe.md'), 'an unstattable entry lands as nonregular exactly like the core');
  });

  it('editing a glob-shadowed IGNORED path mints fingerprint-neutrally — check-ignore consults the rules, never the index', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'feature-a.md'), 'tracked neighbor\n');
    writeFileSync(join(root, '.gitignore'), 'feature-\\[a\\].md\n');
    sh(['add', '-A'], root);
    sh(['commit', '-q', '-m', 'neighbor + ignore rule'], root);
    writeFileSync(join(root, 'feature-[a].md'), 'v1\n');
    const fpBefore = computeTreeFingerprint(root);
    writeFileSync(join(root, 'feature-[a].md'), 'v2 edited\n');
    const { record } = mintBookkeepingDelta({ cwd: root, env: {}, path: 'feature-[a].md', fingerprintBefore: fpBefore, preContent: 'v1\n' });
    assert.equal(record.fingerprintAfter, fpBefore, 'an ignored path never moves the fingerprint — a tracked glob neighbor must not flip the ignore answer');
    assert.equal(record.custodyProof.maskedFingerprint, fpBefore);
  });

  it('a non-blob HEAD entry refuses by name', () => {
    const root = makeRepo();
    const fpBefore = computeTreeFingerprint(root);
    writeFileSync(join(root, 'fresh6.md'), 'f\n');
    const realRun = (args, dir) => spawnSync('git', args, { cwd: dir, windowsHide: true });
    const sha = 'cd'.repeat(20);
    throwsStop(
      () => mintBookkeepingDelta({
        cwd: root, env: {}, path: 'fresh6.md', fingerprintBefore: fpBefore, preContent: null,
        deps: { runGit: (args, dir) => (args[0] === 'ls-tree' ? { status: 0, stdout: Buffer.from(`040000 tree ${sha}\tfresh6.md\0`) } : realRun(args, dir)) },
      }),
      /not a blob — an unsupported pre-state class/,
    );
  });

  it('a delta on a git-ignored path mints fingerprint-neutrally — the ignored layer is outside the review domain', () => {
    const root = makeRepo();
    writeFileSync(join(root, '.gitignore'), 'private/\n');
    sh(['add', '-A'], root);
    sh(['commit', '-q', '-m', 'ignore private'], root);
    const fpBefore = computeTreeFingerprint(root);
    mkdirSync(join(root, 'private'));
    writeFileSync(join(root, 'private', 'notes.md'), 'hidden bookkeeping\n');
    const { record } = mintBookkeepingDelta({ cwd: root, env: {}, path: 'private/notes.md', fingerprintBefore: fpBefore, preContent: null });
    assert.equal(record.fingerprintAfter, fpBefore, 'an ignored path never moves the fingerprint');
    assert.equal(record.custodyProof.maskedFingerprint, fpBefore);
  });

  it('the masked recompute with a NULL mask reproduces the frozen core payload byte-for-byte (parity)', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'tracked2.txt'), 't2\n');
    sh(['add', '-A'], root);
    sh(['commit', '-q', '-m', 'more'], root);
    writeFileSync(join(root, 'tracked2.txt'), 't2 unstaged\n');
    writeFileSync(join(root, 'base.txt'), 'base staged\n');
    sh(['add', 'base.txt'], root);
    writeFileSync(join(root, 'untracked.md'), 'u\n');
    writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 0, 2]));
    symlinkSync('base.txt', join(root, 'sym.lnk'));
    const mine = computeMaskedFingerprintPayload(root, null);
    const core = computeFingerprintPayload(root);
    assert.ok(Buffer.isBuffer(mine) && mine.length > 0, 'the fixture must exercise a non-empty payload');
    assert.ok(mine.equals(core), 'a NULL mask must be byte-identical to the frozen core payload — the two disciplines cannot drift');
    assert.equal(sha256hex(mine), computeTreeFingerprint(root));
  });
});
