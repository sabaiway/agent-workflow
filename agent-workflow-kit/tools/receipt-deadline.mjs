#!/usr/bin/env node
// receipt-deadline.mjs — the per-dispatch receipt-ARRIVAL deadline runner (flow-orchestration
// Plan 3 Phase 4, #41/#26/#50, P6/P18). It waits for ONE dispatched review to ANSWER, never for
// the review obligations to be satisfied — that is review-state --await's job. Satisfaction is
// ARRIVAL: a newline-terminated parseable receipt line from the dispatched backend starting
// at/after the watermark offset, or — PREFERRED whenever a dispatch nonce is supplied and its
// finding manifest exists — the nonce-matched manifest (the manifest is minted atomically BEFORE
// the receipt append, so its presence is the stronger dispatch-identity signal). "Receipt line" is
// decided POSITIVELY, by the minimal core below: a delegation-ledger line carries a `backend` too,
// and a review waiter waits for a REVIEW answer (D10).
//
// Watermark semantics (P6/P18, split by surface): the PERSISTED dispatch-ledger watermark stays
// the plain byte-length integer; THIS RUNNER additionally binds the receipts-file PREFIX
// IN-PROCESS at start (a hash of the bytes up to the watermark offset) — a shrunken file or a
// changed prefix refuses LOUDLY for the lifetime of the run, so a truncate-and-rewrite can never
// masquerade as arrival. Honest limit: the prefix binding is a runtime guard, never a persisted
// proof. Timeout fires ONLY when no receipt landed, and its wording names the watermark.
//
// Read-only: never writes, never commits, never runs a subscription CLI. The clock is injectable
// (ctx.now / ctx.sleep / ctx.pollMs) so hermetic tests never spend wall-clock. Dependency-free,
// Node >= 22. No side effects on import (the isDirectRun idiom).

import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { resolveReceiptsPath } from './core-evidence.mjs';
import { SAFE_NONCE_RE, findingManifestBasename, decodeFindingManifest } from './flow-record.mjs';
import { readFileBytesNoFollow } from './flow-store-read.mjs';

const usageFail = (message) => Object.assign(new Error(message), { exitCode: 2 });

export const DEFAULT_DEADLINE_TIMEOUT_S = 900;
export const DEADLINE_POLL_MS = 5000;

// The one contract sentence, doc-parity-bound into references/modes/receipt-deadline.md — the
// arrival-not-satisfaction split is the tool's identity and must not drift in the mode doc.
export const RECEIPT_DEADLINE_CONTRACT = 'satisfaction is receipt ARRIVAL past the watermark — a strictly-newer parseable REVIEW receipt line from the dispatched backend (or its nonce-matched finding manifest, preferred when present), never a delegation-ledger line that merely names the same backend — never obligation satisfaction';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// The receipts store and the delegation ledger are different files with different schemas, but both
// are JSONL beside the git dir and both carry a `backend` — so a ledger line reaching this store
// would satisfy a waiter that matched on the backend alone (D10). The rule is therefore POSITIVE,
// not a blacklist of foreign kinds: a blacklist goes stale the moment the other family grows a kind,
// and the two errors are not symmetric — an unrecognised line costs a TIMEOUT that names its
// watermark (loud), while a false ARRIVED answers a review dispatch with something that is not a
// review. This is the MINIMAL core every review receipt carries and no delegation record can: the
// kinds that carry `backend` (dispatch, return) have no `verdict`, and the kind that carries
// `verdict` (fold) has no `backend`. `fingerprint` must be PRESENT but may be null — an empty
// fingerprint is legal in some receipt modes, so requiring a value would refuse a real receipt.
const REVIEW_RECEIPT_SCHEMA = 1;

const isReviewReceiptLine = (parsed, backend) =>
  parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
  && parsed.schema === REVIEW_RECEIPT_SCHEMA
  && parsed.backend === backend
  && typeof parsed.artifact === 'string' && parsed.artifact.length > 0
  && typeof parsed.verdict === 'string' && parsed.verdict.length > 0
  && Object.hasOwn(parsed, 'fingerprint');

// Every read rides the kit's ONE race-free reader (flow-store-read's no-follow/non-block
// discipline): store identity is never resolved through a link, a FIFO can never block the
// bounded wait, and an invalid-UTF-8 store refuses (a byte-unstable store cannot carry a prefix
// binding). → { bytes } | { bytes: null } (absent) | { refuse: reason }.
const readBytesOrRefuse = (path, io, label) => {
  const r = readFileBytesNoFollow(path, io);
  if (r.outcome === 'ok') return { bytes: r.bytes };
  if (r.outcome === 'absent') return { bytes: null };
  if (r.outcome === 'foreign') return { refuse: `${label} at ${path} is a ${r.className}, not a regular file — never followed, never read (fail closed)` };
  return { refuse: `${label} at ${path} is unreadable (${r.code}) — fail closed` };
};

// One poll over the bound state → { state: 'waiting' | 'satisfied' | 'refused', reason }.
// Refusals are TERMINAL for the run (P6: the prefix binding refuses for the run's lifetime).
// Order is load-bearing: STORE INTEGRITY first (the P6 guarantee is unconditional — a manifest
// landing after a truncate/rewrite must never mask it), the manifest correlation second, the
// tail line scan last. An absent store under watermark 0 is not an integrity violation (no store
// yet; the prefix below offset 0 is vacuously intact), so a present manifest still satisfies it.
export const pollArrival = ({ path, watermark, prefixHash, backend, nonce = null, manifestPath, io = {} }) => {
  const store = readBytesOrRefuse(path, io, 'the receipts store');
  if (store.refuse !== undefined) return { state: 'refused', reason: store.refuse };
  const bytes = store.bytes;
  if (bytes == null && watermark > 0) {
    return { state: 'refused', reason: `the receipts file vanished below watermark offset ${watermark} (${path}) — a shrunken store refuses loudly for the lifetime of this run (P6)` };
  }
  if (bytes != null) {
    if (bytes.byteLength < watermark) {
      return { state: 'refused', reason: `the receipts file shrank below watermark offset ${watermark} (${bytes.byteLength} bytes at ${path}) — a shrunken store refuses loudly for the lifetime of this run (P6)` };
    }
    if (sha256(bytes.subarray(0, watermark)) !== prefixHash) {
      return { state: 'refused', reason: `the receipts-file prefix below watermark offset ${watermark} was REWRITTEN (${path}) — a truncate-and-rewrite can never masquerade as arrival; this run refuses for its lifetime (P6)` };
    }
  }
  if (manifestPath != null) {
    const m = readBytesOrRefuse(manifestPath, io, 'the finding manifest');
    if (m.refuse !== undefined) return { state: 'refused', reason: m.refuse };
    if (m.bytes != null) {
      const decoded = decodeFindingManifest(m.bytes);
      if (!decoded.ok) return { state: 'refused', reason: `the finding manifest at ${manifestPath} is malformed — ${decoded.reason} — a malformed manifest never proves arrival` };
      const manifest = decoded.manifest;
      if (manifest.backend !== backend || (nonce != null && manifest.nonce !== nonce)) {
        return { state: 'refused', reason: `the finding manifest at ${manifestPath} declares {backend "${manifest.backend}", nonce "${manifest.nonce}"}, not the awaited {backend "${backend}", nonce "${nonce}"} — a foreign manifest never proves this dispatch (fail closed)` };
      }
      return { state: 'satisfied', reason: `the nonce-matched finding manifest landed (${manifestPath}) — dispatch-identity correlation (preferred over the watermark scan)` };
    }
  }
  if (bytes == null) {
    return { state: 'waiting', reason: `no receipt line from backend "${backend}" has arrived past watermark offset ${watermark} yet (${path} does not exist yet)` };
  }
  // Only COMPLETE (newline-terminated) lines count — a partial in-flight append is not a receipt.
  const tail = bytes.subarray(watermark).toString('utf8');
  const lastNewline = tail.lastIndexOf('\n');
  const complete = lastNewline === -1 ? [] : tail.slice(0, lastNewline).split('\n');
  for (const line of complete) {
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a malformed line never satisfies — and never masks a later valid one
    }
    if (isReviewReceiptLine(parsed, backend)) {
      return { state: 'satisfied', reason: `a receipt line from backend "${backend}" arrived past watermark offset ${watermark} (${path})` };
    }
  }
  return { state: 'waiting', reason: `no receipt line from backend "${backend}" has arrived past watermark offset ${watermark} yet (${path})` };
};

// runReceiptDeadline({ backend, watermark, nonce?, timeoutS, cwd, env, … }) → { code, stdout, stderr }.
export const runReceiptDeadline = async ({
  backend, watermark, nonce = null, timeoutS = DEFAULT_DEADLINE_TIMEOUT_S,
  cwd = process.cwd(), env = process.env,
  now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs = DEADLINE_POLL_MS, io = {},
}) => {
  const path = resolveReceiptsPath(cwd, env);
  if (path == null) {
    return { code: 1, stdout: '', stderr: 'receipt-deadline: not inside a git work tree (and no AW_REVIEW_RECEIPTS override) — there is no receipts file to watch' };
  }
  let manifestPath = null;
  if (nonce != null) {
    const basename = findingManifestBasename(backend, nonce);
    if (basename == null) {
      return { code: 2, stdout: '', stderr: 'receipt-deadline: --nonce (and the backend name) must satisfy the safe nonce grammar ([A-Za-z0-9._-]{1,64}) — an unsafe token never composes a manifest name' };
    }
    manifestPath = join(dirname(path), basename);
  }
  // Bind the prefix IN-PROCESS at start (P6/P18): the bytes up to the watermark offset are hashed
  // once; every poll re-verifies them. A file already shorter than the watermark refuses at start.
  const start0 = readBytesOrRefuse(path, io, 'the receipts store');
  if (start0.refuse !== undefined) return { code: 1, stdout: '', stderr: `receipt-deadline: REFUSED — ${start0.refuse}` };
  const startBytes = start0.bytes;
  const startLength = startBytes == null ? 0 : startBytes.byteLength;
  if (startLength < watermark) {
    return { code: 1, stdout: '', stderr: `receipt-deadline: the receipts file is ${startLength} bytes, below watermark offset ${watermark} (${path}) — the watermark was minted on a longer file, so the store shrank; refusing loudly (P6)` };
  }
  // The watermark must sit on a JSONL line boundary: with an UNTERMINATED pre-dispatch tail an
  // appended receipt physically CONTINUES that malformed line, yet the isolated tail slice would
  // parse — so the boundary binds at start beside the prefix (the hash then freezes it).
  if (watermark > 0 && startBytes[watermark - 1] !== 0x0a) {
    return { code: 1, stdout: '', stderr: `receipt-deadline: REFUSED — watermark offset ${watermark} does not sit on a line boundary (the byte before it is not a newline): the pre-dispatch store tail is unterminated, and an appended receipt would physically continue that malformed line; re-mint the watermark on a newline-terminated store (${path})` };
  }
  const prefixHash = sha256(startBytes == null ? Buffer.alloc(0) : startBytes.subarray(0, watermark));
  const timeoutMs = timeoutS * 1000;
  const start = now();
  let lastReason = `no receipt line from backend "${backend}" has arrived past watermark offset ${watermark} yet (${path})`;
  for (;;) {
    // Deadline BEFORE readiness (the --await discipline): a receipt landing at/after the deadline
    // never flips the run to ARRIVED, and each sleep is bounded to the remaining time.
    const elapsed = now() - start;
    if (elapsed >= timeoutMs) {
      return { code: 1, stdout: '', stderr: `receipt-deadline: TIMEOUT after ${timeoutS}s — ${lastReason}; no receipt landed past watermark offset ${watermark}` };
    }
    const poll = pollArrival({ path, watermark, prefixHash, backend, nonce, manifestPath, io });
    if (poll.state === 'satisfied') return { code: 0, stdout: `receipt-deadline: ARRIVED — ${poll.reason}`, stderr: '' };
    if (poll.state === 'refused') return { code: 1, stdout: '', stderr: `receipt-deadline: REFUSED — ${poll.reason}` };
    lastReason = poll.reason;
    await sleep(Math.min(pollMs, timeoutMs - elapsed));
  }
};

const HELP = `receipt-deadline — the per-dispatch receipt-ARRIVAL deadline runner (flow-orchestration).

Usage:
  node receipt-deadline.mjs --backend <name> --watermark <bytes> [--nonce <nonce>] [--timeout <s>]
  (every flag also accepts the inline --flag=<value> form — the lane a leading-dash value rides)

Waits for ONE dispatched review to ANSWER: ${RECEIPT_DEADLINE_CONTRACT}.
The watermark is the receipts-file byte length minted BEFORE the dispatch (the round dispatch
ledger's receiptWatermark); the runner binds the file prefix below that offset IN-PROCESS at
start — a shrunken file or a rewritten prefix refuses loudly for the lifetime of the run (a
runtime guard, never a persisted proof) — and a positive watermark must sit on a LINE BOUNDARY
(an unterminated pre-dispatch tail refuses loudly at start: an appended receipt would
physically continue that malformed line). With --nonce, the {backend, nonce}-named finding
manifest beside the receipts file is the PREFERRED arrival signal (it is minted atomically
before the receipt append). Timeout (default ${DEFAULT_DEADLINE_TIMEOUT_S}s) fires only when no
receipt landed, and names the watermark.

Read-only: never writes, never commits, never runs a subscription CLI.
Exit codes: 0 arrived; 1 timeout or a loud refusal (shrunken/rewritten store, malformed manifest); 2 usage.`;

export const main = async (argv, ctx = {}) => {
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    // ONE single-pass parse: every known flag takes exactly one value and appears at most ONCE
    // (a silently-ignored duplicate would let `--backend a --backend b` wait on the wrong
    // backend); the inline `--flag=<value>` form is the lane a grammar-legal leading-dash value
    // rides, and duplicate detection is CANONICAL on the flag name across both forms.
    const known = new Set(['--backend', '--watermark', '--nonce', '--timeout']);
    const values = {};
    for (let i = 0; i < argv.length; i += 1) {
      const token = argv[i];
      const eq = token.indexOf('=');
      const flag = eq === -1 ? token : token.slice(0, eq);
      if (!known.has(flag)) throw usageFail(`unknown argument: ${flag}`);
      if (Object.hasOwn(values, flag)) throw usageFail(`duplicate flag: ${flag} — every flag is given at most once, whichever form it rides`);
      if (eq !== -1) {
        values[flag] = token.slice(eq + 1);
        continue;
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw usageFail(`${flag} requires a value (or use ${flag}=<value> for a leading-dash value)`);
      values[flag] = value;
      i += 1;
    }
    const backend = values['--backend'] ?? null;
    if (backend == null) throw usageFail('--backend <name> is required (the dispatched backend whose receipt is awaited)');
    // The backend is a FILTER TOKEN over receipt lines and (with --nonce) a manifest-name half —
    // an empty/control/non-ASCII value can match no honest backend, so waiting on it never helps.
    if (!SAFE_NONCE_RE.test(backend)) throw usageFail('--backend must satisfy the safe ASCII token grammar ([A-Za-z0-9._-]{1,64})');
    const watermarkRaw = values['--watermark'] ?? null;
    // Both numeric flags are SAFE-INTEGER-bounded: an all-digits overflow value would coerce to a
    // huge float/Infinity and silently unbound the run (the timeout bound divides by 1000 because
    // timeoutS * 1000 must itself stay a safe integer).
    if (watermarkRaw == null || !/^\d+$/.test(watermarkRaw) || !Number.isSafeInteger(Number(watermarkRaw))) {
      throw usageFail('--watermark requires the non-negative safe integer byte offset minted before dispatch');
    }
    const timeoutRaw = values['--timeout'] ?? null;
    const timeoutMax = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
    if (timeoutRaw != null && (!/^\d+$/.test(timeoutRaw) || Number(timeoutRaw) < 1 || Number(timeoutRaw) > timeoutMax)) {
      throw usageFail(`--timeout requires a positive safe integer number of seconds (at most ${timeoutMax})`);
    }
    return await runReceiptDeadline({
      backend,
      watermark: Number(watermarkRaw),
      nonce: values['--nonce'] ?? null,
      timeoutS: timeoutRaw == null ? DEFAULT_DEADLINE_TIMEOUT_S : Number(timeoutRaw),
      cwd: ctx.cwd ?? process.cwd(),
      env: ctx.env ?? process.env,
      now: ctx.now, sleep: ctx.sleep, pollMs: ctx.pollMs, io: ctx.io,
    });
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `receipt-deadline: ${err.message}` };
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main(process.argv.slice(2)).then((r) => {
    if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
    if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
    process.exitCode = r.code;
  });
}
