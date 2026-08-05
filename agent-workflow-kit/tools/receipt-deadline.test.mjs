// receipt-deadline.test.mjs — the receipt-ARRIVAL deadline runner (Plan 3 Phase 4.1, #41/#50,
// P6/P18): arrival past the watermark satisfies; an older line never does; the in-process prefix
// binding refuses a shrunken or rewritten store loudly; a malformed line never satisfies and never
// masks a later valid one; the nonce-matched manifest is the preferred correlation. The clock is
// injected so the suite spends zero wall-clock; the store rides the AW_REVIEW_RECEIPTS seam so no
// git repo is needed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, truncateSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openSync, closeSync } from 'node:fs';
import {
  runReceiptDeadline, main, DEFAULT_DEADLINE_TIMEOUT_S, RECEIPT_DEADLINE_CONTRACT,
} from './receipt-deadline.mjs';
import { FINDING_MANIFEST_PREFIX } from './flow-record.mjs';
import { readFileBytesNoFollow } from './flow-store-read.mjs';

const receiptLine = (backend) =>
  `${JSON.stringify({ schema: 1, artifact: 'code', fresh: true, fingerprint: 'a'.repeat(64), backend, verdict: 'ship', grounded: true, factsHash: null, wrapperVersion: '3.2.0', timestamp: '2026-08-05T12:00:00Z', probe: false, posture: { model: 'm', effort: 'e', tier: null } })}\n`;

const makeStore = (initial = '') => {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-deadline-'));
  const path = join(dir, 'receipts.jsonl');
  writeFileSync(path, initial);
  return { dir, path };
};

// A hermetic clock: now() reads a mutable tick; sleep() advances it and fires an optional side
// effect (the arrival-mid-wait lanes).
const fakeClock = (onSleep) => {
  const clock = { t: 0, slept: 0 };
  return {
    clock,
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; clock.slept += 1; if (onSleep) onSleep(clock.slept); },
    pollMs: 5000,
  };
};

const runAt = (store, { watermark, backend = 'codex', nonce = null, timeoutS = 60, onSleep } = {}) => {
  const { now, sleep, pollMs, clock } = fakeClock(onSleep);
  return runReceiptDeadline({
    backend, watermark, nonce, timeoutS,
    cwd: store.dir, env: { AW_REVIEW_RECEIPTS: store.path }, now, sleep, pollMs,
  }).then((r) => ({ ...r, slept: clock.slept }));
};

describe('receipt-deadline — arrival past the watermark', () => {
  it('a receipt line from the dispatched backend at/after the watermark satisfies (pinned: exit 0)', async () => {
    const prefix = receiptLine('agy');
    const store = makeStore(prefix);
    const watermark = Buffer.byteLength(prefix);
    appendFileSync(store.path, receiptLine('codex'));
    const r = await runAt(store, { watermark });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.slept, 0, 'already landed → arrived on the first poll, never sleeps');
    assert.match(r.stdout, /ARRIVED/);
    assert.match(r.stdout, new RegExp(`watermark offset ${watermark}`));
  });

  it('an OLDER line from that backend (before the watermark) never satisfies (pinned: TIMEOUT naming the watermark)', async () => {
    const prefix = receiptLine('codex');
    const store = makeStore(prefix);
    const watermark = Buffer.byteLength(prefix);
    const r = await runAt(store, { watermark, timeoutS: 10 });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /TIMEOUT after 10s/);
    assert.match(r.stderr, new RegExp(`watermark offset ${watermark}`), 'the timeout wording names the watermark');
  });

  it('append race: foreign-backend and junk appends never satisfy; the dispatched backend\'s line landing mid-wait does (pinned: 1 sleep)', async () => {
    const prefix = receiptLine('codex');
    const store = makeStore(prefix);
    const watermark = Buffer.byteLength(prefix);
    appendFileSync(store.path, receiptLine('agy'));
    const r = await runAt(store, {
      watermark,
      onSleep: (slept) => { if (slept === 1) appendFileSync(store.path, receiptLine('codex')); },
    });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.slept, 1, 'the foreign line did not satisfy; the own line landing on the tick did');
  });

  it('a MALFORMED line before a valid one: the junk never satisfies and never masks the valid line (pinned: exit 0)', async () => {
    const prefix = receiptLine('agy');
    const store = makeStore(prefix);
    const watermark = Buffer.byteLength(prefix);
    appendFileSync(store.path, 'this is not JSON\n');
    appendFileSync(store.path, receiptLine('codex'));
    const r = await runAt(store, { watermark });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /ARRIVED/);
  });

  it('a NON-newline-terminated line is not an arrival — the terminating newline is (pinned: 1 sleep)', async () => {
    const store = makeStore('');
    const partial = receiptLine('codex').slice(0, -1);
    appendFileSync(store.path, partial);
    const r = await runAt(store, {
      watermark: 0,
      onSleep: (slept) => { if (slept === 1) appendFileSync(store.path, '\n'); },
    });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.slept, 1, 'the partial append never read as a receipt; the completed line did');
  });

  it('an ABSENT receipts file under watermark 0 waits (no store yet is not an error) — arrival on its first line', async () => {
    const store = makeStore('');
    rmSync(store.path);
    const r = await runAt(store, {
      watermark: 0,
      onSleep: (slept) => { if (slept === 1) writeFileSync(store.path, receiptLine('codex')); },
    });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.slept, 1, 'the not-yet-existing store read as waiting, never a refusal');
  });

  it('a receipt landing only AT/after the deadline never flips the run to ARRIVED (deadline before readiness)', async () => {
    const store = makeStore('');
    const r = await runAt(store, {
      watermark: 0, timeoutS: 3,
      onSleep: () => appendFileSync(store.path, receiptLine('codex')),
    });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /TIMEOUT after 3s/);
  });
});

describe('receipt-deadline — the in-process prefix binding (P6/P18)', () => {
  it('a file already SHORTER than the watermark refuses loudly at start (pinned: exit 1, no wait)', async () => {
    const store = makeStore('short\n');
    const r = await runAt(store, { watermark: 4096 });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.equal(r.slept, 0, 'the shrunken store refuses before any poll wait');
    assert.match(r.stderr, /below watermark offset 4096/);
  });

  it('a SYMLINKED receipts store refuses by class — store identity is never resolved through a link', async () => {
    const store = makeStore('');
    const real = join(store.dir, 'real-receipts.jsonl');
    writeFileSync(real, receiptLine('codex'));
    rmSync(store.path);
    symlinkSync(real, store.path);
    const r = await runAt(store, { watermark: 0 });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 1, 'a link-resolved store must never satisfy the arrival wait');
    assert.match(r.stderr, /symlink/);
  });

  it('a FIFO receipts store refuses FAST in a child run — the bounded waiter never blocks on open (watchdog-proven)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'receipt-deadline-fifo-'));
    const fifo = join(dir, 'receipts.jsonl');
    assert.equal(spawnSync('mkfifo', [fifo], { encoding: 'utf8' }).status, 0, 'mkfifo fixture');
    const script = fileURLToPath(new URL('./receipt-deadline.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [script, '--backend', 'codex', '--watermark', '0', '--timeout', '1'], {
      encoding: 'utf8', timeout: 5000, env: { ...process.env, AW_REVIEW_RECEIPTS: fifo },
    });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.signal, null, 'the child must refuse, never hang into the watchdog');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a regular file/);
  });

  it('an invalid-UTF-8 receipts store refuses by name — a byte-unstable store cannot carry a prefix binding (deliberate tightening)', async () => {
    const store = makeStore('');
    writeFileSync(store.path, Buffer.concat([Buffer.from('junk'), Buffer.from([0xff, 0xfe]), Buffer.from('\n'), Buffer.from(receiptLine('codex'))]));
    const r = await runAt(store, { watermark: 0 });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 1, 'invalid bytes never read as "just a junk line to skip"');
    assert.match(r.stderr, /UTF-8/);
  });

  it('a watermark OFF a line boundary refuses loudly at start — an unterminated pre-dispatch tail can never read as arrival', async () => {
    const partial = '{"schema":1,"backend":"agy"';
    const store = makeStore(partial);
    const watermark = Buffer.byteLength(partial);
    appendFileSync(store.path, receiptLine('codex'));
    const r = await runAt(store, { watermark });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 1, 'an appended receipt physically CONTINUES the malformed line — parsing the slice in isolation must never read as arrival');
    assert.equal(r.slept, 0, 'the boundary binds at start, beside the prefix binding');
    assert.match(r.stderr, /REFUSED/, 'the literal refusal state marker, like every other P6 lane');
    assert.match(r.stderr, /line boundary/);
  });

  it('TRUNCATION mid-run refuses loudly for the lifetime of the run (pinned: REFUSED, never a timeout)', async () => {
    const prefix = receiptLine('codex');
    const store = makeStore(prefix);
    const watermark = Buffer.byteLength(prefix);
    const r = await runAt(store, {
      watermark,
      onSleep: (slept) => { if (slept === 1) truncateSync(store.path, 3); },
    });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /REFUSED/);
    assert.match(r.stderr, /shrank below watermark offset/);
  });

  it('a PREFIX REWRITE at unchanged length refuses loudly — a truncate-and-rewrite can never masquerade as arrival (pinned: REFUSED)', async () => {
    const prefix = receiptLine('codex');
    const store = makeStore(prefix);
    const watermark = Buffer.byteLength(prefix);
    const rewritten = `${prefix.slice(0, -2)}X\n`;
    assert.equal(Buffer.byteLength(rewritten), watermark, 'the rewrite keeps the byte length — only the binding catches it');
    const r = await runAt(store, {
      watermark,
      onSleep: (slept) => { if (slept === 1) writeFileSync(store.path, rewritten + receiptLine('codex')); },
    });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /REFUSED/);
    assert.match(r.stderr, /REWRITTEN/, 'the refusal names the rewritten prefix, not a timeout');
  });

  it('the receipts file VANISHING under a positive watermark refuses loudly (pinned: REFUSED)', async () => {
    const prefix = receiptLine('codex');
    const store = makeStore(prefix);
    const watermark = Buffer.byteLength(prefix);
    const r = await runAt(store, {
      watermark,
      onSleep: (slept) => { if (slept === 1) rmSync(store.path); },
    });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /vanished below watermark offset/);
  });
});

describe('receipt-deadline — nonce-manifest correlation (preferred when a manifest exists)', () => {
  const manifestFor = (store, backend, nonce, overrides = {}) => {
    const manifest = { schema: 1, backend, nonce, fingerprint: 'b'.repeat(64), findings: 'Verdict: ship\n', ...overrides };
    writeFileSync(join(store.dir, `${FINDING_MANIFEST_PREFIX}${backend}-${nonce}.json`), `${JSON.stringify(manifest)}\n`);
  };

  it('the {backend, nonce}-named manifest satisfies WITHOUT any receipt line (pinned: exit 0, names the manifest lane)', async () => {
    const store = makeStore('');
    manifestFor(store, 'codex', 'nx7');
    const r = await runAt(store, { watermark: 0, nonce: 'nx7' });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.slept, 0);
    assert.match(r.stdout, /nonce-matched finding manifest/);
  });

  it('a FIFO at the manifest path refuses FAST in a child run — the correlation never blocks (watchdog-proven)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'receipt-deadline-mfifo-'));
    const receipts = join(dir, 'receipts.jsonl');
    writeFileSync(receipts, '');
    assert.equal(spawnSync('mkfifo', [join(dir, `${FINDING_MANIFEST_PREFIX}codex-nx7.json`)], { encoding: 'utf8' }).status, 0, 'mkfifo fixture');
    const script = fileURLToPath(new URL('./receipt-deadline.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [script, '--backend', 'codex', '--watermark', '0', '--nonce', 'nx7', '--timeout', '1'], {
      encoding: 'utf8', timeout: 5000, env: { ...process.env, AW_REVIEW_RECEIPTS: receipts },
    });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.signal, null, 'the child must refuse, never hang into the watchdog');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a regular file/);
  });

  it('a MALFORMED manifest refuses loudly — it never proves arrival and never falls back silently (pinned: REFUSED)', async () => {
    const store = makeStore('');
    writeFileSync(join(store.dir, `${FINDING_MANIFEST_PREFIX}codex-nx7.json`), 'not json\n');
    const r = await runAt(store, { watermark: 0, nonce: 'nx7' });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /REFUSED/);
    assert.match(r.stderr, /not valid JSON/);
  });

  it('a manifest declaring a FOREIGN backend or nonce refuses loudly (pinned: REFUSED naming both identities)', async () => {
    const store = makeStore('');
    manifestFor(store, 'codex', 'nx7', { backend: 'agy' });
    const r = await runAt(store, { watermark: 0, nonce: 'nx7' });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /foreign manifest never proves this dispatch/);
  });

  it('a nonce-matched manifest never masks a REWRITTEN or TRUNCATED store — the prefix guard runs first (pinned: REFUSED)', async () => {
    const prefix = receiptLine('codex');
    const rewritten = `${prefix.slice(0, -2)}X\n`;
    const landManifest = (store) => manifestFor(store, 'codex', 'nx7');
    const rewriteStore = makeStore(prefix);
    const r1 = await runAt(rewriteStore, {
      watermark: Buffer.byteLength(prefix), nonce: 'nx7',
      onSleep: (slept) => { if (slept === 1) { writeFileSync(rewriteStore.path, rewritten); landManifest(rewriteStore); } },
    });
    rmSync(rewriteStore.dir, { recursive: true, force: true });
    assert.equal(r1.code, 1);
    assert.match(r1.stderr, /REWRITTEN/, 'the prefix guard fires BEFORE the manifest correlation — arrival never masks a rewrite');
    const truncStore = makeStore(prefix);
    const r2 = await runAt(truncStore, {
      watermark: Buffer.byteLength(prefix), nonce: 'nx7',
      onSleep: (slept) => { if (slept === 1) { truncateSync(truncStore.path, 3); landManifest(truncStore); } },
    });
    rmSync(truncStore.dir, { recursive: true, force: true });
    assert.equal(r2.code, 1);
    assert.match(r2.stderr, /shrank below watermark offset/, 'the shrink guard fires BEFORE the manifest correlation too');
  });

  it('a manifest carrying INVALID UTF-8 refuses by name — lossy decode never mutates the digest domain (pinned: REFUSED)', async () => {
    const store = makeStore('');
    const bytes = Buffer.concat([
      Buffer.from('{"schema":1,"backend":"codex","nonce":"nx7","fingerprint":null,"findings":"x'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('y"}'),
    ]);
    writeFileSync(join(store.dir, `${FINDING_MANIFEST_PREFIX}codex-nx7.json`), bytes);
    const r = await runAt(store, { watermark: 0, nonce: 'nx7' });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /REFUSED/);
    assert.match(r.stderr, /UTF-8/, 'invalid bytes refuse by name — never a U+FFFD-substituted arrival');
  });

  it('a findings string carrying a LONE SURROGATE (JSON-escaped) refuses by name — ill-formed UTF-16 never enters the digest domain', async () => {
    const store = makeStore('');
    writeFileSync(join(store.dir, `${FINDING_MANIFEST_PREFIX}codex-nx7.json`), '{"schema":1,"backend":"codex","nonce":"nx7","fingerprint":null,"findings":"x\\ud800y"}\n');
    const r = await runAt(store, { watermark: 0, nonce: 'nx7' });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /well-formed Unicode/, 'an escaped lone surrogate refuses — utf8 hashing would substitute U+FFFD');
  });

  it('a BOM-prefixed manifest refuses exactly as before — the fatal decoder preserves the BOM byte (characterization pin)', async () => {
    const store = makeStore('');
    writeFileSync(join(store.dir, `${FINDING_MANIFEST_PREFIX}codex-nx7.json`), Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"schema":1,"backend":"codex","nonce":"nx7","fingerprint":null,"findings":"ok"}\n'),
    ]));
    const r = await runAt(store, { watermark: 0, nonce: 'nx7' });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 1, 'ignoreBOM keeps the BOM in the text, so JSON.parse still refuses — no behavior widening');
    assert.match(r.stderr, /not valid JSON/);
  });

  it('a NON-REGULAR node at the manifest path (a directory) refuses by class — never a silent fall-through (pinned: REFUSED)', async () => {
    const store = makeStore('');
    mkdirSync(join(store.dir, `${FINDING_MANIFEST_PREFIX}codex-nx7.json`));
    const r = await runAt(store, { watermark: 0, nonce: 'nx7' });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /REFUSED/);
    assert.match(r.stderr, /is a directory, not a regular file/);
  });

  it('without the manifest the nonce lane falls back to the watermark scan (a receipt line still satisfies)', async () => {
    const store = makeStore('');
    appendFileSync(store.path, receiptLine('codex'));
    const r = await runAt(store, { watermark: 0, nonce: 'nx7' });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /receipt line from backend "codex"/);
  });

  it('an unsafe nonce refuses before any wait (usage exit 2 — the containment check)', async () => {
    const store = makeStore('');
    const r = await runAt(store, { watermark: 0, nonce: '../escape' });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /safe nonce grammar/);
  });
});

// The shared bytes reader (consult-required balance pin): the polling consumer must never leak a
// descriptor, whatever the outcome — and a close failure is an ERROR outcome, never a swallow.
describe('readFileBytesNoFollow — open/close balance (the polling consumer never leaks)', () => {
  it('successful opens equal closes across ok / foreign / absent outcomes; a close failure fails closed', () => {
    const store = makeStore('payload\n');
    let opens = 0;
    let closes = 0;
    const io = {
      open: (...a) => { const fd = openSync(...a); opens += 1; return fd; },
      close: (fd) => { closes += 1; return closeSync(fd); },
    };
    const ok = readFileBytesNoFollow(store.path, io);
    assert.equal(ok.outcome, 'ok');
    assert.equal(ok.bytes.toString('utf8'), 'payload\n');
    assert.equal(readFileBytesNoFollow(store.dir, io).outcome, 'foreign', 'a directory refuses by class');
    assert.equal(readFileBytesNoFollow(join(store.dir, 'absent'), io).outcome, 'absent');
    assert.equal(opens, closes, `every successful open is closed (${opens} opens, ${closes} closes)`);
    const failingClose = {
      open: (...a) => openSync(...a),
      close: (fd) => { closeSync(fd); throw Object.assign(new Error('EIO'), { code: 'EIO' }); },
    };
    const failed = readFileBytesNoFollow(store.path, failingClose);
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(failed.outcome, 'error', 'a close failure is never swallowed');
    assert.match(failed.code, /close failed/);
  });
});

describe('receipt-deadline — CLI grammar', () => {
  it('--help carries the contract sentence and the default timeout', async () => {
    const r = await main(['--help'], {});
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes(RECEIPT_DEADLINE_CONTRACT), 'the mode-doc-bound contract sentence renders in HELP');
    assert.match(r.stdout, new RegExp(`default ${DEFAULT_DEADLINE_TIMEOUT_S}s`));
  });

  it('usage refusals: unknown argument, missing --backend, malformed --watermark, malformed --timeout (all exit 2)', async () => {
    assert.equal((await main(['--frobnicate'], {})).code, 2);
    assert.equal((await main(['--watermark', '0'], {})).code, 2);
    assert.equal((await main(['--backend', 'codex', '--watermark', 'x'], {})).code, 2);
    assert.equal((await main(['--backend', 'codex', '--watermark', '0', '--timeout', '0'], {})).code, 2);
  });

  it('--backend must satisfy the safe token grammar — empty, control-byte, non-ASCII and over-length refuse; the 64-char boundary passes', async () => {
    const attempt = async (backend) => {
      const store = makeStore('');
      const { now, sleep, pollMs } = fakeClock();
      const r = await main(['--backend', backend, '--watermark', '0', '--timeout', '5'], { cwd: store.dir, env: { AW_REVIEW_RECEIPTS: store.path }, now, sleep, pollMs });
      rmSync(store.dir, { recursive: true, force: true });
      return r;
    };
    for (const bad of ['', 'a\u0001b', 'cé1', 'x'.repeat(65)]) {
      const r = await attempt(bad);
      assert.equal(r.code, 2, `${JSON.stringify(bad)} can match no honest backend — waiting on it is never useful`);
      assert.match(r.stderr, /safe ASCII token grammar/);
    }
    const boundary = await attempt('x'.repeat(64));
    assert.equal(boundary.code, 1, 'the 64-char boundary is INSIDE the grammar — the wait proceeds to its timeout, never a usage refusal');
    assert.match(boundary.stderr, /TIMEOUT/);
  });

  it('a grammar-legal leading-dash nonce rides the inline --nonce=<value> form; the bare form still refuses as a missing value', async () => {
    const store = makeStore('');
    const { now, sleep, pollMs } = fakeClock();
    const inline = await main(['--backend', 'codex', '--watermark', '0', '--nonce=--x', '--timeout', '5'], { cwd: store.dir, env: { AW_REVIEW_RECEIPTS: store.path }, now, sleep, pollMs });
    assert.equal(inline.code, 1, 'the inline form passes the parser — the wait proceeds to its honest timeout');
    assert.match(inline.stderr, /TIMEOUT/);
    const clock2 = fakeClock();
    const bare = await main(['--backend', 'codex', '--watermark', '0', '--nonce', '--x', '--timeout', '5'], { cwd: store.dir, env: { AW_REVIEW_RECEIPTS: store.path }, now: clock2.now, sleep: clock2.sleep, pollMs: clock2.pollMs });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(bare.code, 2, 'a bare leading-dash value still reads as a flag — the inline form is the lane');
    assert.match(bare.stderr, /requires a value/);
  });

  it('a REPEATED flag refuses as usage naming the duplicate — the first value never silently wins, whichever form it rides', async () => {
    const store = makeStore(receiptLine('codex'));
    const r = await main(['--backend', 'codex', '--backend', 'agy', '--watermark', '0'], { cwd: store.dir, env: { AW_REVIEW_RECEIPTS: store.path } });
    assert.equal(r.code, 2, 'a duplicated --backend must never silently wait on the first one');
    assert.match(r.stderr, /duplicate/);
    const mixed = await main(['--backend=codex', '--backend', 'agy', '--watermark', '0'], { cwd: store.dir, env: { AW_REVIEW_RECEIPTS: store.path } });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(mixed.code, 2, 'duplicate detection is CANONICAL on the flag name across both forms');
    assert.match(mixed.stderr, /duplicate/);
  });

  it('an ALL-INLINE invocation parses — every known flag honors the --flag=<value> form', async () => {
    const line = receiptLine('codex');
    const store = makeStore(line);
    const r = await main([`--backend=codex`, '--watermark=0', '--timeout=5'], { cwd: store.dir, env: { AW_REVIEW_RECEIPTS: store.path } });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /ARRIVED/);
  });

  it('an all-digits OVERFLOW value never becomes Infinity — unsafe-integer --watermark and --timeout refuse as usage (exit 2)', async () => {
    const store = makeStore(receiptLine('codex'));
    const huge = '9'.repeat(400);
    const env = { AW_REVIEW_RECEIPTS: store.path };
    const wm = await main(['--backend', 'codex', '--watermark', huge], { cwd: store.dir, env });
    assert.equal(wm.code, 2, 'an overflowing watermark is a usage refusal, never an Infinity offset');
    assert.match(wm.stderr, /safe integer/);
    const to = await main(['--backend', 'codex', '--watermark', '0', '--timeout', huge], { cwd: store.dir, env });
    rmSync(store.dir, { recursive: true, force: true });
    assert.equal(to.code, 2, 'an overflowing timeout is a usage refusal, never an unbounded wait');
    assert.match(to.stderr, /safe integer/);
  });

  it('outside a git tree with no receipts override the run refuses loudly (exit 1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'receipt-deadline-nogit-'));
    const r = await main(['--backend', 'codex', '--watermark', '0', '--timeout', '1'], { cwd: dir, env: {} });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not inside a git work tree/);
  });

  it('CLI entry (isDirectRun): --help exits 0 through the spawned process', () => {
    const script = fileURLToPath(new URL('./receipt-deadline.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /receipt-deadline — the per-dispatch receipt-ARRIVAL deadline runner/);
  });
});
