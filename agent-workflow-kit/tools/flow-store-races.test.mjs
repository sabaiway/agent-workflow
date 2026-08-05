import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync, symlinkSync, realpathSync, chmodSync, lstatSync, fstatSync, renameSync, openSync, closeSync, linkSync, appendFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import {
  FLOW_STORE_STOP, FLOW_LOCK_SUFFIX, FLOW_LOCK_WAIT_MS, FLOW_LOCK_POLL_MS,
  resolveFlowStorePath, resolveFlowLockPath, readFlowStore, appendFlowRecord,
} from './flow-store.mjs';
import { FLOW_SCHEMA_VERSION } from './flow-record.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-flow-races-'));
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
const TS = '2026-07-29T00:00:00.000Z';
const rerunCause = (attempt) => ({
  schema: FLOW_SCHEMA_VERSION, kind: 'rerun-cause', fingerprint: FP,
  cause: 'flaky fixture confirmed', attempt, base: BASE, timestamp: TS,
});

// A REAL child process per appender — the lock must serialize across processes, not within one.
const STORE_URL = pathToFileURL(join(import.meta.dirname, 'flow-store.mjs')).href;
const CHILD_SCRIPT = `import { appendFlowRecord } from ${JSON.stringify(STORE_URL)};\nappendFlowRecord({ record: JSON.parse(process.argv[1]) });`;
const childAppend = (cwd, record, env = {}) => new Promise((done) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT, JSON.stringify(record)], {
    cwd, env: { ...process.env, AW_FLOW_STORE: '', ...env },
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (code) => done({ code, stderr }));
});

const throwsStop = (fn, re) => assert.throws(fn, (err) => {
  assert.equal(err.code, FLOW_STORE_STOP, `expected a typed flow-store stop, got: ${err.message}`);
  assert.match(err.message, re);
  return true;
});

const holderLine = (over = {}) => JSON.stringify({ pid: process.pid, host: hostname(), startedAt: TS, ...over });
const TIGHT_KNOBS = { AW_FLOW_LOCK_WAIT_MS: '80', AW_FLOW_LOCK_POLL_MS: '10' };

describe('flow-store races — lock/CAS across real child processes', () => {
  it('N concurrent appenders from two worktrees of one repo all land — no lost update, no torn line', async () => {
    const root = makeRepo();
    const wt = addWorktree(root);
    const appends = Array.from({ length: 8 }, (_, i) => childAppend(i % 2 === 0 ? root : wt, rerunCause(`race-${i}`)));
    const results = await Promise.all(appends);
    for (const r of results) assert.equal(r.code, 0, `child append failed: ${r.stderr}`);
    const read = readFlowStore(resolveFlowStorePath(root, {}));
    assert.equal(read.malformed, 0, `torn or malformed lines: ${read.malformedReasons}`);
    assert.deepEqual(
      read.records.map((r) => r.attempt).sort(),
      Array.from({ length: 8 }, (_, i) => `race-${i}`).sort(),
      'every append must land exactly once — no lost update',
    );
    assert.ok(!existsSync(resolveFlowLockPath(resolveFlowStorePath(root, {}))), 'the lock is released after the contention drains');
  });

  it('the lock and store are pinned to ONE canonical path under an ancestor-symlink spelling', () => {
    const base = join(TMP, 'canon');
    mkdirSync(join(base, 'real', 'sub'), { recursive: true });
    symlinkSync(join(base, 'real'), join(base, 'grand'));
    const canonical = join(realpathSync(join(base, 'real')), 'sub', 'flow.jsonl');
    const viaLink = join(base, 'grand', 'sub', 'flow.jsonl');
    const seen = [];
    appendFlowRecord({
      record: rerunCause('canon-1'),
      env: { AW_FLOW_STORE: viaLink },
      deps: {
        writeFile: (p, body, opts) => { seen.push(String(p)); return writeFileSync(p, body, opts); },
        openLock: (p) => { seen.push(String(p)); return openSync(p, 'wx'); },
      },
    });
    assert.ok(seen.includes(`${canonical}.lock`), `the lock must be created at the CANONICAL path — a repointed ancestor could otherwise split lock and store (got: ${seen.join(', ')})`);
    assert.ok(seen.some((p) => p.startsWith(`${canonical}.`) && p.endsWith('.tmp')), `the store write must target the canonical path (got: ${seen.join(', ')})`);
    assert.deepEqual(readFlowStore(canonical).records.map((r) => r.attempt), ['canon-1']);
    assert.ok(!existsSync(`${canonical}.lock`), 'the canonical lock is released');
  });

  it('two ancestor-symlink spellings of one store contend on ONE canonical lock — concurrent appends all land clean', async () => {
    const base = join(TMP, 'canon-race');
    mkdirSync(join(base, 'real', 'sub'), { recursive: true });
    symlinkSync(join(base, 'real'), join(base, 'alias'));
    const spellings = [join(base, 'real', 'sub', 'flow.jsonl'), join(base, 'alias', 'sub', 'flow.jsonl')];
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => childAppend(TMP, rerunCause(`canon-race-${i}`), { AW_FLOW_STORE: spellings[i % 2] })));
    for (const r of results) assert.equal(r.code, 0, `child append failed: ${r.stderr}`);
    const read = readFlowStore(spellings[0]);
    assert.equal(read.malformed, 0, `torn or malformed lines: ${read.malformedReasons}`);
    assert.equal(read.records.length, 6, 'both spellings must funnel through one canonical store and lock');
  });

  it('two path aliases of one overridden store contend on ONE lock — concurrent appends all land clean', async () => {
    const dir = join(TMP, 'alias');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    const plain = join(dir, 'flow.jsonl');
    const alias = join(dir, 'sub', '..', 'flow.jsonl');
    assert.equal(resolveFlowLockPath(resolveFlowStorePath(TMP, { AW_FLOW_STORE: alias })), `${plain}.lock`);
    const appends = Array.from({ length: 8 }, (_, i) => childAppend(TMP, rerunCause(`alias-${i}`), { AW_FLOW_STORE: i % 2 === 0 ? plain : alias }));
    const results = await Promise.all(appends);
    for (const r of results) assert.equal(r.code, 0, `child append failed: ${r.stderr}`);
    const read = readFlowStore(plain);
    assert.equal(read.malformed, 0, `torn or malformed lines: ${read.malformedReasons}`);
    assert.equal(read.records.length, 8, 'both alias spellings must funnel through one store and one lock');
  });
});

describe('flow-store races — holder lanes', () => {
  it('a dead holder surfaces a LOUD named refusal with verbatim recovery — never a silent steal', () => {
    const dir = join(TMP, 'dead-holder');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const lock = resolveFlowLockPath(store);
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.equal(dead.status, 0);
    writeFileSync(lock, holderLine({ pid: dead.pid }));
    throwsStop(
      () => appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS } }),
      /DEAD process \(pid \d+.*\)[\s\S]*rm -- '/,
    );
    assert.ok(existsSync(lock), 'a dead holder is never silently stolen — recovery is the operator\'s explicit rm');
    assert.ok(!existsSync(store), 'nothing lands past an unacquired lock');
  });

  it('a live holder is waited only to the stated bound, then refused by name', () => {
    const dir = join(TMP, 'live-holder');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    writeFileSync(resolveFlowLockPath(store), holderLine());
    throwsStop(
      () => appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS } }),
      new RegExp(`still held by pid ${process.pid} .*after the full 80ms wait`),
    );
    assert.ok(existsSync(resolveFlowLockPath(store)), 'the live holder keeps its lock');
    assert.ok(!existsSync(store), 'nothing lands past an unacquired lock');
  });

  it('an unreadable, malformed, or schema-invalid holder refuses after the bound with the verbatim manual recovery', () => {
    const variants = ['', 'not json', '{}', JSON.stringify({ pid: 'x', host: '' })];
    variants.forEach((body, i) => {
      const dir = join(TMP, `bad-holder-${i}`);
      mkdirSync(dir, { recursive: true });
      const store = join(dir, 'flow.jsonl');
      const lock = resolveFlowLockPath(store);
      writeFileSync(lock, body);
      throwsStop(
        () => appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS } }),
        /UNREADABLE or malformed holder after the full 80ms wait[\s\S]*rm -- '/,
      );
      assert.ok(existsSync(lock), `variant ${i}: never silently stolen — recovery is the operator's explicit rm`);
    });
  });

  it('a released dead-holder lock retries the CAS instead of a false DEAD refusal — a normal race never loses an append', () => {
    const dir = join(TMP, 'dead-released');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const lock = resolveFlowLockPath(store);
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.equal(dead.status, 0);
    writeFileSync(lock, holderLine({ pid: dead.pid }));
    let lockCalls = 0;
    const record = rerunCause('a-1');
    appendFlowRecord({
      record,
      env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS },
      deps: {
        lstat: (p) => {
          if (p === lock) {
            lockCalls += 1;
            if (lockCalls === 2) {
              rmSync(lock, { force: true });
              throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            }
          }
          return lstatSync(p);
        },
      },
    });
    assert.ok(lockCalls >= 2, 'the DEAD verdict must re-verify the lock identity before refusing (the release custody check adds its own later call)');
    assert.deepEqual(readFlowStore(store).records.map((r) => r.attempt), ['a-1'], 'the append lands once the observed holder is gone');
    assert.ok(!existsSync(lock), 'the winning append releases its own lock');
  });

  it('a store swapped for another regular file under the lock refuses at the final rename — foreign bytes are never clobbered', () => {
    const dir = join(TMP, 'rename-guard');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    writeFileSync(store, `${JSON.stringify(rerunCause('a-1'))}\n`);
    // The foreign file pre-exists and MOVES onto the store path (rename keeps its inode) — a
    // delete-then-create fixture could be handed the recycled store inode and dodge the guard.
    const foreignSrc = join(dir, 'innocent.txt');
    writeFileSync(foreignSrc, 'precious foreign bytes\n');
    throwsStop(
      () => appendFlowRecord({
        record: rerunCause('a-2'),
        env: { AW_FLOW_STORE: store },
        deps: {
          writeFile: (p, body, opts) => {
            const result = writeFileSync(p, body, opts);
            if (String(p).endsWith('.tmp')) {
              rmSync(store, { force: true });
              renameSync(foreignSrc, store);
            }
            return result;
          },
        },
      }),
      /changed identity under the lock/,
    );
    assert.equal(readFileSync(store, 'utf8'), 'precious foreign bytes\n', 'the swapped-in file must never be clobbered by the rename');
    const residue = readdirSync(dir).filter((f) => f.includes('.tmp') || f.endsWith('.lock'));
    assert.deepEqual(residue, [], 'the refusal lane cleans its tmp and releases the lock');
  });

  it('lock churn cannot extend the wait past the bound — the deadline gates every retry', () => {
    const dir = join(TMP, 'churn');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    let clock = 0;
    let lockWrites = 0;
    const err = (() => {
      try {
        appendFlowRecord({
          record: rerunCause('a-1'),
          env: { AW_FLOW_STORE: store, AW_FLOW_LOCK_WAIT_MS: '50', AW_FLOW_LOCK_POLL_MS: '10' },
          deps: {
            now: () => { clock += 30; return clock; },
            openLock: (p) => {
              lockWrites += 1;
              if (lockWrites <= 5) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
              return openSync(p, 'wx');
            },
          },
        });
        return null;
      } catch (e) { return e; }
    })();
    assert.equal(err?.code, FLOW_STORE_STOP, 'churn must refuse at the bound, never acquire past it');
    assert.match(err.message, /could not be acquired within the 50ms wait/);
    assert.ok(!existsSync(store), 'nothing lands past a churn refusal');
  });

  it('an lstat failure during the dead-holder identity re-check is a typed STOP, never a silent retry', () => {
    const dir = join(TMP, 'identity-eacces');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const lock = resolveFlowLockPath(store);
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.equal(dead.status, 0);
    writeFileSync(lock, holderLine({ pid: dead.pid }));
    let lockCalls = 0;
    throwsStop(
      () => appendFlowRecord({
        record: rerunCause('a-1'),
        env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS },
        deps: {
          lstat: (p) => {
            if (p === lock) {
              lockCalls += 1;
              if (lockCalls === 2) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
            }
            return lstatSync(p);
          },
        },
      }),
      /cannot re-verify the flow-store lock identity .*EACCES/,
    );
    assert.ok(existsSync(lock), 'the unverifiable lock is never removed');
  });

  it('an lstat failure at the pre-rename leaf check is a typed STOP, never a blind rename', () => {
    const dir = join(TMP, 'rename-lstat-fail');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    writeFileSync(store, `${JSON.stringify(rerunCause('a-1'))}\n`);
    // Store-path lstat sequence: #1 the pre-write leaf gate, #2-5 the FROZEN atomic writer's own
    // checks (leaf, containment walk, TOCTOU re-walk, re-leaf — stable because the file is frozen),
    // #6 the pre-rename guard — the only wrapped one, the lane under test.
    let storeCalls = 0;
    throwsStop(
      () => appendFlowRecord({
        record: rerunCause('a-2'),
        env: { AW_FLOW_STORE: store },
        deps: {
          lstat: (p) => {
            if (p === store) {
              storeCalls += 1;
              if (storeCalls === 6) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
            }
            return lstatSync(p);
          },
        },
      }),
      /cannot verify the flow store leaf before the final rename .*EACCES/,
    );
    assert.equal(storeCalls, 6, 'the guard lane must be the one that fired');
    assert.equal(readFileSync(store, 'utf8'), `${JSON.stringify(rerunCause('a-1'))}\n`, 'an unverifiable leaf is never renamed over');
  });

  it('a hard link created during the append refuses at the pre-rename leaf check', () => {
    const dir = join(TMP, 'hardlink-during');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const original = `${JSON.stringify(rerunCause('a-1'))}\n`;
    writeFileSync(store, original);
    throwsStop(
      () => appendFlowRecord({
        record: rerunCause('a-2'),
        env: { AW_FLOW_STORE: store },
        deps: {
          writeFile: (p, body, opts) => {
            const result = writeFileSync(p, body, opts);
            if (String(p).endsWith('.tmp')) linkSync(store, join(dir, 'late-alias.jsonl'));
            return result;
          },
        },
      }),
      /has 2 hard links/,
    );
    assert.equal(readFileSync(store, 'utf8'), original, 'a store that grew a second link mid-append is never renamed over');
  });

  it('a same-inode in-place mutation of the store under the lock refuses at the final rename — stale bytes never clobber fresh ones', () => {
    const dir = join(TMP, 'inplace-mutation');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    writeFileSync(store, `${JSON.stringify(rerunCause('a-1'))}\n`);
    const inoBefore = lstatSync(store).ino;
    throwsStop(
      () => appendFlowRecord({
        record: rerunCause('a-2'),
        env: { AW_FLOW_STORE: store },
        deps: {
          writeFile: (p, body, opts) => {
            const result = writeFileSync(p, body, opts);
            if (String(p).endsWith('.tmp')) writeFileSync(store, 'freshly mutated bytes\n');
            return result;
          },
        },
      }),
      /content changed under the lock \(same-inode in-place mutation\)/,
    );
    const after = lstatSync(store);
    assert.equal(after.ino, inoBefore, 'the fixture must be a SAME-inode mutation — otherwise the identity guard would fire instead');
    assert.equal(readFileSync(store, 'utf8'), 'freshly mutated bytes\n', 'the mutated bytes stay on disk untouched');
    const residue = readdirSync(dir).filter((f) => f.includes('.tmp') || f.endsWith('.lock'));
    assert.deepEqual(residue, [], 'the refusal lane cleans its tmp and releases the lock');
  });

  it('a store with multiple hard links refuses — two path-derived locks would race one inode', () => {
    const dir = join(TMP, 'hardlink-store');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const original = `${JSON.stringify(rerunCause('a-1'))}\n`;
    writeFileSync(store, original);
    linkSync(store, join(dir, 'alias.jsonl'));
    throwsStop(
      () => appendFlowRecord({ record: rerunCause('a-2'), env: { AW_FLOW_STORE: store } }),
      /has 2 hard links/,
    );
    assert.equal(readFileSync(store, 'utf8'), original, 'nothing is written to a multi-link store');
    assert.ok(!existsSync(resolveFlowLockPath(store)), 'the refusal lane releases the lock');
  });

  it('a store grown in place under the lock refuses at the final rename — the comparison is bounded by the snapshot', () => {
    const dir = join(TMP, 'inplace-growth');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const original = `${JSON.stringify(rerunCause('a-1'))}\n`;
    writeFileSync(store, original);
    throwsStop(
      () => appendFlowRecord({
        record: rerunCause('a-2'),
        env: { AW_FLOW_STORE: store },
        deps: {
          writeFile: (p, body, opts) => {
            const result = writeFileSync(p, body, opts);
            if (String(p).endsWith('.tmp')) appendFileSync(store, 'grown tail\n');
            return result;
          },
        },
      }),
      /content changed under the lock \(same-inode in-place mutation\)/,
    );
    assert.equal(readFileSync(store, 'utf8'), `${original}grown tail\n`, 'the grown bytes stay on disk untouched');
  });

  it('a valid foreign-host holder stays a conservative unprobeable lane — bounded refusal without a removal instruction', () => {
    const dir = join(TMP, 'foreign-holder');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    writeFileSync(resolveFlowLockPath(store), holderLine({ host: 'some-other-host' }));
    const err = (() => {
      try {
        appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS } });
        return null;
      } catch (e) { return e; }
    })();
    assert.equal(err?.code, FLOW_STORE_STOP, 'the foreign-host holder must still refuse at the bound');
    assert.match(err.message, /unprobeable from/);
    assert.match(err.message, /after the full 80ms wait/);
    assert.ok(!err.message.includes('rm -- '), 'a foreign-host holder never gets a removal instruction — it may be live on its own host');
  });

  it('a FIFO at the lock path refuses by name instead of hanging the bounded wait', () => {
    const dir = join(TMP, 'fifo-lock');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const made = spawnSync('mkfifo', [resolveFlowLockPath(store)]);
    assert.equal(made.status, 0, 'mkfifo must succeed for this fixture');
    throwsStop(
      () => appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS } }),
      /flow-store lock .* is a FIFO, not a regular file[\s\S]*rm -- '/,
    );
    assert.ok(!existsSync(store), 'nothing lands past a foreign object at the lock path');
  });

  it('a FIFO at the store path refuses by name instead of hanging the append', () => {
    const dir = join(TMP, 'fifo-store');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const made = spawnSync('mkfifo', [store]);
    assert.equal(made.status, 0, 'mkfifo must succeed for this fixture');
    throwsStop(
      () => appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS } }),
      /flow store .* is a FIFO, not a regular file[\s\S]*rm -- '/,
    );
    assert.ok(!existsSync(resolveFlowLockPath(store)), 'no lock is left behind a refused foreign store object');
  });

  it('a symlink swapped in at the lock path during the wait refuses by name — the holder is never read through it', () => {
    const dir = join(TMP, 'swap-lock');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const lock = resolveFlowLockPath(store);
    writeFileSync(join(dir, 'target'), 'not json');
    writeFileSync(lock, holderLine());
    throwsStop(
      () => appendFlowRecord({
        record: rerunCause('a-1'),
        env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS },
        deps: { sleep: () => { rmSync(lock, { force: true }); symlinkSync(join(dir, 'target'), lock); } },
      }),
      /flow-store lock .* is a symlink, not a regular file/,
    );
    assert.ok(!existsSync(store), 'nothing lands past a swapped lock object');
  });

  it('a store swapped to a non-regular object during the wait refuses after acquisition — never read through', () => {
    const dir = join(TMP, 'swap-store');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const lock = resolveFlowLockPath(store);
    writeFileSync(lock, holderLine());
    throwsStop(
      () => appendFlowRecord({
        record: rerunCause('a-1'),
        env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS },
        deps: { sleep: () => { rmSync(lock, { force: true }); mkdirSync(store, { recursive: true }); } },
      }),
      /flow store .* is a directory, not a regular file[\s\S]*rmdir -- '/,
    );
    assert.ok(!existsSync(lock), 'the store-gate refusal lane still releases the lock');
  });

  it('the manual recovery quotes the lock path safely for the shell', () => {
    const dir = join(TMP, "evil $(touch pwned) `back` 'quote'");
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const lock = resolveFlowLockPath(store);
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.equal(dead.status, 0);
    writeFileSync(lock, holderLine({ pid: dead.pid }));
    const err = (() => {
      try {
        appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS } });
        return null;
      } catch (e) { return e; }
    })();
    assert.equal(err?.code, FLOW_STORE_STOP, 'the dead-holder refusal must fire');
    const expected = `rm -- '${lock.replaceAll("'", "'\\''")}'`;
    assert.ok(err.message.includes(expected), `the recovery must be the safely single-quoted form (expected ${expected}); got: ${err.message}`);
    assert.ok(!err.message.includes(`rm "${lock}"`), 'the shell-unsafe double-quoted interpolation is gone');
  });

  it('a holder released during the wait lets the append proceed', () => {
    const dir = join(TMP, 'released-holder');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const lock = resolveFlowLockPath(store);
    writeFileSync(lock, holderLine());
    const record = rerunCause('a-1');
    appendFlowRecord({
      record,
      env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS },
      deps: { sleep: () => rmSync(lock, { force: true }) },
    });
    const read = readFlowStore(store);
    assert.deepEqual(read.records.map((r) => r.attempt), ['a-1']);
    assert.ok(!existsSync(lock), 'the append releases its own lock');
  });

  it('the wait bound caps the sleep — poll larger than wait still refuses at the bound', () => {
    const dir = join(TMP, 'poll-over-wait');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    writeFileSync(resolveFlowLockPath(store), holderLine());
    const clock = { t: 0 };
    const sleeps = [];
    throwsStop(
      () => appendFlowRecord({
        record: rerunCause('a-1'),
        env: { AW_FLOW_STORE: store, AW_FLOW_LOCK_WAIT_MS: '50', AW_FLOW_LOCK_POLL_MS: '10000' },
        deps: { now: () => clock.t, sleep: (ms) => { sleeps.push(ms); clock.t += ms; } },
      }),
      /after the full 50ms wait/,
    );
    assert.deepEqual(sleeps, [50], 'the sleep is capped to the REMAINING wait, never the full poll — the bound is a hard ceiling');
  });

  it('the wait bound and poll cadence are named constants with env knobs — a malformed knob is refused', () => {
    assert.ok(Number.isInteger(FLOW_LOCK_WAIT_MS) && FLOW_LOCK_WAIT_MS > 0);
    assert.ok(Number.isInteger(FLOW_LOCK_POLL_MS) && FLOW_LOCK_POLL_MS > 0);
    const dir = join(TMP, 'bad-knob');
    mkdirSync(dir, { recursive: true });
    throwsStop(
      () => appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: join(dir, 'flow.jsonl'), AW_FLOW_LOCK_WAIT_MS: 'soon' } }),
      /AW_FLOW_LOCK_WAIT_MS must be a positive integer/,
    );
    assert.deepEqual(readdirSync(dir), [], 'a refused knob writes nothing');
  });

  it('a knob that overflows the safe-integer range is refused — the wait bound never becomes infinite', () => {
    const dir = join(TMP, 'overflow-knob');
    mkdirSync(dir, { recursive: true });
    for (const name of ['AW_FLOW_LOCK_WAIT_MS', 'AW_FLOW_LOCK_POLL_MS']) {
      throwsStop(
        () => appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: join(dir, 'flow.jsonl'), [name]: '9'.repeat(400) } }),
        new RegExp(`${name} must be a positive safe integer`),
      );
    }
    assert.deepEqual(readdirSync(dir), [], 'an overflowing knob writes nothing — checked before the lock is created');
  });
});

describe('flow-store races — release custody (the lock removed is only ever OUR lock)', () => {
  it('a lock replaced under the append is left untouched and surfaces a typed violation — release never removes a foreign lock', () => {
    const dir = join(TMP, 'release-custody');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const lock = resolveFlowLockPath(store);
    // The foreign lock pre-exists and MOVES onto the lock path (rename keeps its inode) — our
    // released inode has no open fd and would otherwise be recycled into a false identity match.
    const foreignLock = join(dir, 'foreign-lock');
    writeFileSync(foreignLock, holderLine({ pid: 999999 }));
    const err = (() => {
      try {
        appendFlowRecord({
          record: rerunCause('a-1'),
          env: { AW_FLOW_STORE: store },
          deps: {
            writeFile: (p, body, opts) => {
              const result = writeFileSync(p, body, opts);
              if (String(p).endsWith('.tmp')) {
                rmSync(lock, { force: true });
                renameSync(foreignLock, lock);
              }
              return result;
            },
          },
        });
        return null;
      } catch (e) { return e; }
    })();
    assert.equal(err?.code, FLOW_STORE_STOP, 'a violated mutual exclusion must surface, never a silent foreign-lock removal');
    assert.match(err.message, /removed or replaced under this append/);
    assert.ok(existsSync(lock), 'the foreign lock stays on disk — it is not ours to remove');
    assert.deepEqual(readFlowStore(store).records.map((r) => r.attempt), ['a-1'], 'the append itself landed before the violation surfaced');
  });

  it('a lock replaced immediately after the winning CAS is caught at release — identity rides the winning fd, not the pathname', () => {
    const dir = join(TMP, 'post-cas-swap');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const lock = resolveFlowLockPath(store);
    const err = (() => {
      try {
        appendFlowRecord({
          record: rerunCause('a-1'),
          env: { AW_FLOW_STORE: store },
          deps: {
            openLock: (p) => {
              const fd = openSync(p, 'wx');
              rmSync(p, { force: true });
              writeFileSync(p, holderLine({ pid: 999999 }));
              return fd;
            },
          },
        });
        return null;
      } catch (e) { return e; }
    })();
    assert.equal(err?.code, FLOW_STORE_STOP);
    assert.match(err.message, /removed or replaced under this append/);
    assert.ok(existsSync(lock), 'the swapped-in lock survives — only the fd-identified lock is ever removed');
  });
});

describe('flow-store races — acquire and release descriptor failures', () => {
  it('a stamp failure after the winning CAS is a typed STOP — ownership stays unproven, nothing is removed', () => {
    const dir = join(TMP, 'stamp-fail');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ro.txt'), '');
    throwsStop(
      () => appendFlowRecord({
        record: rerunCause('a-1'),
        env: { AW_FLOW_STORE: join(dir, 'flow.jsonl') },
        deps: { openLock: () => openSync(join(dir, 'ro.txt'), 'r') },
      }),
      /cannot stamp or verify the just-created flow-store lock .*EBADF/,
    );
    assert.deepEqual(readdirSync(dir), ['ro.txt'], 'an unstamped acquisition writes nothing');
  });

  it('an lstat failure at release is a typed STOP and the lock stays in place', () => {
    const dir = join(TMP, 'release-lstat-fail');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const lock = resolveFlowLockPath(store);
    let lockCalls = 0;
    const err = (() => {
      try {
        appendFlowRecord({
          record: rerunCause('a-1'),
          env: { AW_FLOW_STORE: store },
          deps: {
            lstat: (p) => {
              if (p === lock) {
                lockCalls += 1;
                if (lockCalls === 2) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
              }
              return lstatSync(p);
            },
          },
        });
        return null;
      } catch (e) { return e; }
    })();
    assert.equal(err?.code, FLOW_STORE_STOP);
    assert.match(err.message, /cannot verify the flow-store lock before release .*EACCES/);
    assert.ok(existsSync(lock), 'an unverifiable lock is left in place');
    assert.deepEqual(readFlowStore(store).records.map((r) => r.attempt), ['a-1'], 'the body itself landed');
  });

  it('a close failure at release surfaces alone and rides visibly on a prior release issue', () => {
    // A real closed-fd fixture is unreliable under the test runner (its threadpool can reopen the
    // freed fd number mid-append) — the injectable close seam is the deterministic form.
    const failingClose = () => { throw Object.assign(new Error('EBADF'), { code: 'EBADF' }); };
    const aloneDir = join(TMP, 'close-fail-alone');
    mkdirSync(aloneDir, { recursive: true });
    const aloneErr = (() => {
      try {
        appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: join(aloneDir, 'flow.jsonl') }, deps: { close: failingClose } });
        return null;
      } catch (e) { return e; }
    })();
    assert.equal(aloneErr?.code, FLOW_STORE_STOP);
    assert.match(aloneErr.message, /cannot close the flow-store lock descriptor at release .*EBADF/);
    assert.deepEqual(readFlowStore(join(aloneDir, 'flow.jsonl')).records.map((r) => r.attempt), ['a-1'], 'the body itself landed');

    const ridingDir = join(TMP, 'close-fail-riding');
    mkdirSync(ridingDir, { recursive: true });
    const ridingErr = (() => {
      try {
        appendFlowRecord({
          record: rerunCause('a-1'),
          env: { AW_FLOW_STORE: join(ridingDir, 'flow.jsonl') },
          deps: { close: failingClose, rm: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } },
        });
        return null;
      } catch (e) { return e; }
    })();
    assert.match(ridingErr?.message ?? '', /cannot remove the flow-store lock at release/, 'the removal failure stays primary');
    assert.match(ridingErr?.closeFailure ?? '', /cannot close the flow-store lock descriptor/, 'the close failure rides along, never lost');
  });
});

describe('flow-store races — release removal failures', () => {
  it('a triple failure keeps every error visible — body primary, removal riding, close riding beside it', () => {
    const dir = join(TMP, 'triple-fail');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    writeFileSync(store, 'not json\n');
    const err = (() => {
      try {
        appendFlowRecord({
          record: rerunCause('a-1'),
          env: { AW_FLOW_STORE: store },
          deps: {
            rm: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
            close: () => { throw Object.assign(new Error('EBADF'), { code: 'EBADF' }); },
          },
        });
        return null;
      } catch (e) { return e; }
    })();
    assert.match(err?.message ?? '', /refusing to append to a flow store carrying/, 'the body failure stays primary');
    assert.match(err?.releaseViolation ?? '', /cannot remove the flow-store lock at release/, 'the removal failure rides along');
    assert.match(err?.releaseCloseFailure ?? '', /cannot close the flow-store lock descriptor/, 'the close failure is never silently dropped');
  });

  it('a removal failure at release is a typed STOP that never masks the body outcome', () => {
    const cleanDir = join(TMP, 'rm-fail-clean');
    mkdirSync(cleanDir, { recursive: true });
    const cleanStore = join(cleanDir, 'flow.jsonl');
    const failingRm = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    const cleanErr = (() => {
      try {
        appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: cleanStore }, deps: { rm: failingRm } });
        return null;
      } catch (e) { return e; }
    })();
    assert.equal(cleanErr?.code, FLOW_STORE_STOP, 'an rm failure must surface as a typed STOP, never a raw fs error');
    assert.match(cleanErr.message, /cannot remove the flow-store lock at release .*EACCES/);
    assert.deepEqual(readFlowStore(cleanStore).records.map((r) => r.attempt), ['a-1'], 'the body itself landed');

    const bodyDir = join(TMP, 'rm-fail-body');
    mkdirSync(bodyDir, { recursive: true });
    const bodyStore = join(bodyDir, 'flow.jsonl');
    writeFileSync(bodyStore, 'not json\n');
    const bodyErr = (() => {
      try {
        appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: bodyStore }, deps: { rm: failingRm } });
        return null;
      } catch (e) { return e; }
    })();
    assert.match(bodyErr?.message ?? '', /refusing to append to a flow store carrying/, 'the body failure stays primary');
    assert.match(bodyErr?.releaseViolation ?? '', /cannot remove the flow-store lock at release/, 'the release failure rides along visibly, never lost');
  });
});

describe('flow-store races — the lock releases on EVERY failure lane', () => {
  it('a validation refusal releases the lock (duplicate and malformed-store lanes)', () => {
    const dir = join(TMP, 'lane-validation');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const record = rerunCause('a-1');
    appendFlowRecord({ record, env: { AW_FLOW_STORE: store } });
    throwsStop(() => appendFlowRecord({ record, env: { AW_FLOW_STORE: store } }), /replayed line/);
    assert.ok(!existsSync(resolveFlowLockPath(store)), 'the duplicate lane must release the lock');
    writeFileSync(store, 'not json\n');
    throwsStop(() => appendFlowRecord({ record: rerunCause('a-2'), env: { AW_FLOW_STORE: store } }), /malformed line/);
    assert.ok(!existsSync(resolveFlowLockPath(store)), 'the malformed-store lane must release the lock');
  });

  it('a read failure releases the lock', () => {
    const dir = join(TMP, 'lane-read');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    writeFileSync(store, `${JSON.stringify(rerunCause('a-0'))}\n`);
    chmodSync(store, 0o000);
    try {
      throwsStop(
        () => appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: store } }),
        /cannot read the flow store before appending/,
      );
    } finally {
      chmodSync(store, 0o644);
    }
    assert.ok(!existsSync(resolveFlowLockPath(store)), 'the read-failure lane must release the lock');
  });

  it('a write failure releases the lock and leaves the store unchanged', () => {
    const dir = join(TMP, 'lane-write');
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const prior = `${JSON.stringify(rerunCause('a-1'))}\n`;
    writeFileSync(store, prior);
    assert.throws(
      () => appendFlowRecord({
        record: rerunCause('a-2'),
        env: { AW_FLOW_STORE: store },
        deps: {
          writeFile: (p, body, opts) => {
            if (String(p).endsWith(FLOW_LOCK_SUFFIX)) return writeFileSync(p, body, opts);
            throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
          },
        },
      }),
      /disk full/,
    );
    assert.ok(!existsSync(resolveFlowLockPath(store)), 'the write-failure lane must release the lock');
    assert.equal(readFileSync(store, 'utf8'), prior, 'a failed write leaves the store bytes untouched');
  });
});

describe('flow-store races — the DEAD re-verify binds through the HELD fd (FLOW-LOCK-HOLDER-FD-RECHECK)', () => {
  const deadHolderLock = (dirName) => {
    const dir = join(TMP, dirName);
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    const lock = resolveFlowLockPath(store);
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.equal(dead.status, 0);
    writeFileSync(lock, holderLine({ pid: dead.pid }));
    return { store, lock };
  };

  it('a lock released under the re-verify while the pathname claims the SAME {dev, ino} is retried, never refused as DEAD', () => {
    const { store, lock } = deadHolderLock('recycle-retry');
    const observed = lstatSync(lock);
    let lockCalls = 0;
    const record = rerunCause('a-1');
    appendFlowRecord({
      record,
      env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS },
      deps: {
        lstat: (p) => {
          if (p === lock) {
            lockCalls += 1;
            if (lockCalls === 2) {
              // The window: the dead holder's lock is released DURING the re-verify and the
              // pathname claims an inode with the same {dev, ino} — the recycled-identity lie a
              // closed-fd re-verify cannot see through. The held fd proves the unlink (nlink 0).
              rmSync(lock, { force: true });
              return observed;
            }
          }
          return lstatSync(p);
        },
      },
    });
    assert.equal(lockCalls >= 2, true, 'the re-verify lane must have fired');
    assert.deepEqual(readFlowStore(store).records.map((r) => r.attempt), ['a-1'], 'the recycled lock is retried and the append lands');
    assert.ok(!existsSync(lock), 'the winning append releases its own lock');
  });

  it('a recycled lock re-stamped by a LIVE holder refuses as still-held, never as DEAD with an rm instruction', () => {
    const { store, lock } = deadHolderLock('recycle-live');
    const observed = lstatSync(lock);
    let lockCalls = 0;
    const err = (() => {
      try {
        appendFlowRecord({
          record: rerunCause('a-1'),
          env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS },
          deps: {
            lstat: (p) => {
              if (p === lock) {
                lockCalls += 1;
                if (lockCalls === 2) {
                  rmSync(lock, { force: true });
                  writeFileSync(lock, holderLine());
                  return observed;
                }
              }
              return lstatSync(p);
            },
          },
        });
        return null;
      } catch (e) { return e; }
    })();
    assert.equal(err?.code, FLOW_STORE_STOP);
    assert.match(err.message, new RegExp(`still held by pid ${process.pid} .*after the full 80ms wait`));
    assert.ok(!err.message.includes('DEAD'), 'a re-stamped live lock is never mis-bound as DEAD');
    assert.ok(!err.message.includes('rm -- '), 'no removal instruction is ever printed against a possibly-live lock');
    assert.ok(existsSync(lock), 'the live holder keeps its lock');
  });

  it('an fstat failure on the held descriptor during the re-verify is a typed STOP, never a guessed verdict', () => {
    const { store, lock } = deadHolderLock('recheck-fstat-fail');
    let fstatCalls = 0;
    throwsStop(
      () => appendFlowRecord({
        record: rerunCause('a-1'),
        env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS },
        deps: {
          holderIo: {
            // call 1 is the holder read's own post-open fstat; call 2 is the re-verify through
            // the HELD descriptor — the lane under test.
            fstat: (fd) => {
              fstatCalls += 1;
              if (fstatCalls === 2) throw Object.assign(new Error('EIO'), { code: 'EIO' });
              return fstatSync(fd);
            },
          },
        },
      }),
      /cannot re-verify the flow-store lock through its held descriptor .*EIO/,
    );
    assert.equal(fstatCalls, 2, 'the re-verify fstat must be the one that fired');
    assert.ok(existsSync(lock), 'the unverifiable lock is never removed');
  });
});

describe('flow-store races — the held holder descriptor closes on EVERY exit lane (P28)', () => {
  const countingIo = () => {
    const counts = { opens: 0, closes: 0 };
    const io = {
      open: (...args) => { counts.opens += 1; return openSync(...args); },
      close: (fd) => { counts.closes += 1; return closeSync(fd); },
    };
    return { counts, io };
  };
  const lockFixture = (dirName, body) => {
    const dir = join(TMP, dirName);
    mkdirSync(dir, { recursive: true });
    const store = join(dir, 'flow.jsonl');
    writeFileSync(resolveFlowLockPath(store), body);
    return store;
  };

  it('the dead-refusal lane holds the holder fd through the verdict and closes it', () => {
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.equal(dead.status, 0);
    const store = lockFixture('fd-lane-dead', holderLine({ pid: dead.pid }));
    const { counts, io } = countingIo();
    throwsStop(
      () => appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS }, deps: { holderIo: io } }),
      /DEAD process/,
    );
    assert.ok(counts.opens >= 1, 'the holder read must ride the held-fd lane');
    assert.equal(counts.closes, counts.opens, 'every held holder descriptor closes');
  });

  it('the recycled-retry lane closes the held fd before retrying', () => {
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.equal(dead.status, 0);
    const store = lockFixture('fd-lane-recycle', holderLine({ pid: dead.pid }));
    const lock = resolveFlowLockPath(store);
    const observed = lstatSync(lock);
    const { counts, io } = countingIo();
    let lockCalls = 0;
    appendFlowRecord({
      record: rerunCause('a-1'),
      env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS },
      deps: {
        holderIo: io,
        lstat: (p) => {
          if (p === lock) {
            lockCalls += 1;
            if (lockCalls === 2) {
              rmSync(lock, { force: true });
              return observed;
            }
          }
          return lstatSync(p);
        },
      },
    });
    assert.ok(counts.opens >= 1, 'the holder read must ride the held-fd lane');
    assert.equal(counts.closes, counts.opens, 'the retry lane never leaks the held descriptor');
  });

  it('the malformed-holder lane closes the held fd on every poll iteration', () => {
    const store = lockFixture('fd-lane-malformed', 'not json');
    const { counts, io } = countingIo();
    throwsStop(
      () => appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS }, deps: { holderIo: io } }),
      /UNREADABLE or malformed holder/,
    );
    assert.ok(counts.opens >= 1, 'the holder read must ride the held-fd lane');
    assert.equal(counts.closes, counts.opens, 'the malformed-holder lane never leaks the held descriptor');
  });

  it('the live-holder deadline lane closes the held fd of every poll read', () => {
    const store = lockFixture('fd-lane-deadline', holderLine());
    const { counts, io } = countingIo();
    throwsStop(
      () => appendFlowRecord({ record: rerunCause('a-1'), env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS }, deps: { holderIo: io } }),
      /still held by pid/,
    );
    assert.ok(counts.opens >= 2, 'the wait loop re-reads the holder — each read holds a descriptor');
    assert.equal(counts.closes, counts.opens, 'the deadline lane never leaks a held descriptor');
  });

  it('a holder-descriptor close failure is a typed STOP, never a silent leak', () => {
    const store = lockFixture('fd-close-fail', holderLine());
    throwsStop(
      () => appendFlowRecord({
        record: rerunCause('a-1'),
        env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS },
        deps: { holderIo: { close: () => { throw Object.assign(new Error('EBADF'), { code: 'EBADF' }); } } },
      }),
      /cannot close the held flow-store holder descriptor .*EBADF/,
    );
  });

  it('a reader-internal close failure on the early error lane is the typed custody STOP, never a raw error', () => {
    const store = lockFixture('fd-reader-close-fail', holderLine());
    const err = (() => {
      try {
        appendFlowRecord({
          record: rerunCause('a-1'),
          env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS },
          deps: {
            holderIo: {
              fstat: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
              close: () => { throw Object.assign(new Error('EBADF'), { code: 'EBADF' }); },
            },
          },
        });
        return null;
      } catch (e) { return e; }
    })();
    assert.equal(err?.code, FLOW_STORE_STOP, `the custody failure must surface as the typed STOP, got: ${err?.code} — ${err?.message}`);
    assert.match(err.message, /read\/close custody failed/);
  });

  it('a close failure never masks the DEAD refusal — it rides as holderCloseFailure', () => {
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.equal(dead.status, 0);
    const store = lockFixture('fd-close-fail-dead', holderLine({ pid: dead.pid }));
    const err = (() => {
      try {
        appendFlowRecord({
          record: rerunCause('a-1'),
          env: { AW_FLOW_STORE: store, ...TIGHT_KNOBS },
          deps: { holderIo: { close: () => { throw Object.assign(new Error('EBADF'), { code: 'EBADF' }); } } },
        });
        return null;
      } catch (e) { return e; }
    })();
    assert.equal(err?.code, FLOW_STORE_STOP);
    assert.match(err.message, /DEAD process/, 'the DEAD refusal stays primary');
    assert.match(err.holderCloseFailure ?? '', /cannot close the held flow-store holder descriptor/, 'the close failure rides along, never lost');
  });
});
