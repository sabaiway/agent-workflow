#!/usr/bin/env node
// review-ledger-write.mjs — the SOLE filesystem WRITER for the review-round ledger (AD-045). It is
// the write half of the family read/write split (mirrors orchestration-config.mjs /
// orchestration-write.mjs): review-ledger.mjs (schema + read + decideStop + --check) is read-only and
// NEVER imports this module; an import-split test pins that. This module imports the read core the
// OTHER direction (the schema + decideStop + the tolerant reader) and appends records through the
// shared hardened atomic-write core (tools/atomic-write.mjs — exclusive-create tmp + rename, TOCTOU
// re-check, symlink STOPs). The ledger lives in the git dir (uncommittable by construction).
//
// Two record kinds, one JSONL ledger:
//   recordRound   — one review round: per-backend counts + verdict + degraded, finding-origin tally,
//                   findings[]. Binds to the canonical tree fingerprint. THE TEETH (Decision 5):
//                   REFUSES (typed STOP) while decideStop on the existing records is `triage-required`
//                   (an unclassified surviving blocking finding at/after the cap), and refuses ANY
//                   round beyond the hard-max ceiling unconditionally. Integrity binding (Decision 7):
//                   each NON-degraded backend needs a grounded code receipt for the current tree, so a
//                   round cannot be recorded for a tree no bridge reviewed.
//   recordTriage  — the classification that BREAKS the deadlock: each surviving blocking finding
//                   classified fixable-bug / inherent-layer-residual / escalate. No teeth (a triage is
//                   exactly what lets the next round proceed), no receipt binding (it reviews nothing).
//
// HONEST residual (stated, accepted — like review-state's): the ledger attests a review occurred; it
// does NOT prove the recorded COUNTS are truthful nor that a self-reported `degraded:true` is real.
// A self-discipline mechanism against silent process drift, not a security boundary.
//
// Dependency-free, Node >= 18. Every fs primitive is injectable (deps.*) so the guards are unit-
// testable. No side effects on import (the isDirectRun idiom).

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeContainedFileAtomic } from './atomic-write.mjs';
import { computeTreeFingerprint, readReceipts, resolveReceiptsPath } from './review-state.mjs';
import {
  REVIEW_CAP,
  SCHEMA_VERSION,
  resolveLedgerPath,
  readLedger,
  filterLoopRecords,
  roundSequenceIntact,
  decideStop,
  validateRecord,
} from './review-ledger.mjs';

// The absolute WRITER ceiling (Decision 5): hard-max lives ONLY here — it is NOT a decideStop input.
// Even a fully-classified resolved-residual loop cannot reach a round beyond this.
export const HARD_MAX = 3;
const DEFAULT_ACTIVITY = 'plan-execution';

// A typed STOP — a deliberate refusal we surface (the teeth / a malformed record / a missing
// receipt), distinct from a native fs error. The codebase's typed-error idiom (no classes).
export const LEDGER_WRITE_STOP = 'LEDGER_WRITE_STOP';
const stop = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'LedgerWriteStop', code: LEDGER_WRITE_STOP });

// A tagged usage failure (exit 2) for the CLI parser.
const usageFail = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { exitCode: 2 });

const isoNow = () => new Date().toISOString();

// ── the append primitive (whole-file read → add one JSONL line → atomic rewrite) ────────────────
// The ledger is a git-dir JSONL, never a docs/ai file, so the append reads the current file, adds the
// new line in memory, and rewrites through the contained-write core (root = the ledger file's dir).
const appendRecord = (ledgerPath, record, deps = {}) => {
  const readFile = deps.readFile ?? readFileSync;
  let existing = '';
  try {
    existing = readFile(ledgerPath, 'utf8');
  } catch (err) {
    // Only a truly-absent file starts from empty. A non-ENOENT read failure (EACCES/EIO) must NOT be
    // treated as "no file" — rewriting from empty would DESTROY the existing ledger (codex R1).
    if (err && err.code === 'ENOENT') existing = '';
    else throw stop(`cannot read the ledger before appending (${(err && err.code) || (err && err.message) || err}) — refusing to overwrite it (fail closed)`);
  }
  const prefix = existing === '' ? '' : existing.endsWith('\n') ? existing : `${existing}\n`;
  const body = `${prefix}${JSON.stringify(record)}\n`;
  const root = dirname(ledgerPath);
  writeContainedFileAtomic(root, ledgerPath, body, deps, { stop, label: ledgerPath });
  return { writtenPath: ledgerPath, record };
};

// ── recordRound (the teeth + the integrity binding) ─────────────────────────────────────────────

// recordRound({ cwd, env, loop, activity, round, origins, backends, findings, timestamp }, deps) →
// { writtenPath, record }. THROWS a typed STOP (the teeth / a malformed record / a missing receipt)
// or a native fs error. Every fs edge + the fingerprint is injectable for hermetic tests.
export const recordRound = (params, deps = {}) => {
  const { cwd = process.cwd(), env = process.env, loop, activity = DEFAULT_ACTIVITY, round, origins, backends, findings, timestamp } = params;
  const ledgerPath = deps.ledgerPath ?? resolveLedgerPath(cwd, env);
  if (ledgerPath == null) throw stop('cannot resolve the ledger path — not a git work tree and AW_REVIEW_LEDGER is unset');
  if (!(Number.isInteger(round) && round >= 1)) throw stop(`round must be an integer >= 1 (got ${round})`);
  // The hard-max ceiling: refuse ANY round beyond it, independent of triage state (Decision 5).
  if (round > HARD_MAX) {
    throw stop(`refusing to record round ${round}: beyond the hard-max ceiling of ${HARD_MAX} rounds — the loop must converge or the surviving finding must escalate, never another round`);
  }

  const fingerprint = deps.computeFingerprint ? deps.computeFingerprint(cwd) : computeTreeFingerprint(cwd);

  // The teeth: refuse a new round WHILE decideStop on the existing records is triage-required. Once
  // the surviving blocking finding is classified (recordTriage), decideStop is no longer
  // triage-required and the next round is permitted (a fixable-bug classification permits the fix
  // round — no deadlock). triage-required is fingerprint/backend-independent, so a minimal decideStop
  // suffices here.
  const { records, malformed, malformedReasons, readError } = readLedger(ledgerPath, deps.readFile);
  // Fail CLOSED before the teeth: a ledger the reader could not fully trust (an unreadable file, or
  // malformed lines the reader dropped) could make decideStop miss a triage-required round and fail
  // the teeth OPEN (codex R1). Refuse to append until the ledger is sound.
  if (readError) throw stop(`cannot read the existing ledger (${readError}) — refusing to append (fail closed)`);
  if (malformed > 0) throw stop(`the existing ledger has ${malformed} malformed line(s) — refusing to append until they are fixed (fail closed): ${malformedReasons.join('; ')}`);
  const existingLoop = filterLoopRecords(records, { activity, loop });
  // Sequence integrity + sequentiality (codex R2+R3): the EXISTING rounds must already be exactly
  // 1..n (never trust a hand-corrupted [2]/[1,1]/[2,1] to compute "latest"), AND the incoming round
  // must be exactly the next (n+1). A duplicate, decreasing, or gapped round would let a fabricated
  // "later" round become the latest that decideStop reads, bypassing the "latest round" teeth.
  const priorRounds = existingLoop.filter((r) => r.kind === 'round').map((r) => r.round);
  if (!roundSequenceIntact(existingLoop)) {
    throw stop(`refusing to append to loop "${loop}": its recorded round sequence is corrupt (${priorRounds.join(',') || 'empty'}, not 1..n) — fix the ledger by hand before recording another round`);
  }
  const nextRound = priorRounds.length + 1;
  if (round !== nextRound) {
    throw stop(`refusing to record round ${round}: rounds must be sequential — the next round for loop "${loop}" is ${nextRound} (a duplicate, out-of-order, or gapped round would corrupt the crossover computation)`);
  }
  const pre = decideStop(existingLoop, { cap: REVIEW_CAP });
  if (pre.state === 'triage-required') {
    throw stop(`refusing to record a new round while triage is required — ${pre.reason}. Classify the surviving blocking finding(s) with the "classify" command first (a fixable-bug classification permits the fix round).`);
  }

  const record = { schema: SCHEMA_VERSION, loop, activity, kind: 'round', round, fingerprint, origins, backends, findings, timestamp: timestamp ?? isoNow() };
  const v = validateRecord(record);
  if (!v.ok) throw stop(`refusing to record a malformed round: ${v.reason}`);

  // Integrity binding: each NON-degraded backend needs a grounded code receipt for this tree — a
  // round cannot be recorded for a tree no bridge reviewed. A degraded backend minted no receipt.
  const receiptsPath = deps.receiptsPath ?? resolveReceiptsPath(cwd, env);
  const { receipts } = receiptsPath ? readReceipts(receiptsPath, deps.readFile) : { receipts: [] };
  for (const b of backends) {
    if (b.degraded) continue;
    const own = receipts.filter(
      (r) => r.backend === b.backend && r.fingerprint === fingerprint && r.artifact === 'code' && r.fresh === true && r.grounded === true,
    );
    if (own.length === 0) {
      throw stop(`refusing to record a round for ${b.backend}: no grounded code receipt for the current tree — run its review wrapper (codex-review code / agy-review code --facts @f) first, or mark the backend degraded with a reason`);
    }
  }

  return appendRecord(ledgerPath, record, deps);
};

// ── recordTriage (the deadlock-breaker — no teeth, no receipt binding) ──────────────────────────

// recordTriage({ cwd, env, loop, activity, round, classifications, timestamp }, deps) →
// { writtenPath, record }. Appends the classification of the round's surviving blocking findings.
export const recordTriage = (params, deps = {}) => {
  const { cwd = process.cwd(), env = process.env, loop, activity = DEFAULT_ACTIVITY, round, classifications, timestamp } = params;
  const ledgerPath = deps.ledgerPath ?? resolveLedgerPath(cwd, env);
  if (ledgerPath == null) throw stop('cannot resolve the ledger path — not a git work tree and AW_REVIEW_LEDGER is unset');
  if (!(Number.isInteger(round) && round >= 1)) throw stop(`round must be an integer >= 1 (got ${round})`);
  const fingerprint = deps.computeFingerprint ? deps.computeFingerprint(cwd) : computeTreeFingerprint(cwd);
  // Normalize each classification: testId "defaults null" (Decision 8), note defaults to '' — an
  // absent optional field is FILLED, never rejected as malformed (agy R3). A non-array is left as-is
  // for validateRecord to reject with a typed STOP (never a raw .map TypeError).
  const normalized = Array.isArray(classifications) ? classifications.map((c) => ({ ...c, testId: c?.testId ?? null, note: c?.note ?? '' })) : classifications;
  const record = { schema: SCHEMA_VERSION, loop, activity, kind: 'triage', round, fingerprint, classifications: normalized, timestamp: timestamp ?? isoNow() };
  const v = validateRecord(record);
  if (!v.ok) throw stop(`refusing to record a malformed triage: ${v.reason}`);

  // Bind the triage to a REAL round: the referenced round must exist and every classified findingKey
  // must be a surviving blocking finding (blocker or major) of THAT round — a classification for a
  // nonexistent/future round, or for a key the round never raised, must not satisfy resolved-residual
  // downstream (codex R1). Fail CLOSED on an unreadable / malformed ledger.
  const { records, malformed, malformedReasons, readError } = readLedger(ledgerPath, deps.readFile);
  if (readError) throw stop(`cannot read the existing ledger (${readError}) — refusing to append (fail closed)`);
  if (malformed > 0) throw stop(`the existing ledger has ${malformed} malformed line(s) — refusing to append until they are fixed (fail closed): ${malformedReasons.join('; ')}`);
  const loopRecords = filterLoopRecords(records, { activity, loop });
  if (!roundSequenceIntact(loopRecords)) throw stop(`refusing to classify loop "${loop}": its recorded round sequence is corrupt (not 1..n) — fix the ledger by hand first`);
  const targetRound = loopRecords.find((r) => r.kind === 'round' && r.round === round);
  if (!targetRound) throw stop(`refusing to classify round ${round} of loop "${loop}": no such recorded round — classify a round that exists`);
  const survivingKeys = new Set(targetRound.findings.filter((f) => f.severity === 'blocker' || f.severity === 'major').map((f) => f.findingKey));
  for (const c of classifications) {
    if (!survivingKeys.has(c.findingKey)) throw stop(`refusing to classify "${c.findingKey}": it is not a surviving blocking finding of round ${round} (classify only that round's blockers/majors)`);
  }

  return appendRecord(ledgerPath, record, deps);
};

// ── CLI (record / classify) ──────────────────────────────────────────────────────────────────────

const HELP = `review-ledger-write — the review-round ledger WRITER (agent-workflow family, AD-045).

Usage:
  node review-ledger-write.mjs record   --json '<round-payload>'   [--cwd <dir>]
  node review-ledger-write.mjs classify --json '<triage-payload>'  [--cwd <dir>]

record   appends one review round. The JSON payload carries { loop, round, origins, backends,
         findings } (activity defaults to plan-execution; timestamp defaults to now). REFUSES while
         triage is required, beyond the hard-max ceiling of ${HARD_MAX} rounds, or when a non-degraded
         backend lacks a grounded code receipt for the current tree.
classify appends one triage record. The JSON payload carries { loop, round, classifications } (each
         { findingKey, class, accepted, testId, note }). This is what permits the next round.

The read-only checker is a SEPARATE tool: node review-ledger.mjs --check / --status / --json.
Exit codes: 0 written; 1 a typed STOP (teeth / malformed / missing receipt / fs error); 2 usage.`;

const parseArgs = (argv) => {
  const opts = { cwd: undefined, json: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--cwd') {
      opts.cwd = argv[i + 1];
      if (opts.cwd === undefined) throw usageFail('--cwd needs a directory');
      i += 1;
    } else if (a === '--json') {
      opts.json = argv[i + 1];
      if (opts.json === undefined) throw usageFail('--json needs a JSON payload');
      i += 1;
    } else {
      throw usageFail(`unknown argument: ${a}`);
    }
  }
  return opts;
};

const parsePayload = (json) => {
  if (json === undefined) throw usageFail('a --json payload is required');
  try {
    return JSON.parse(json);
  } catch (err) {
    throw usageFail(`--json is not valid JSON (${err.message})`);
  }
};

export const main = (argv, ctx = {}) => {
  const cwd0 = ctx.cwd ?? process.cwd();
  const env = ctx.env ?? process.env;
  try {
    if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) return { code: argv.length === 0 ? 2 : 0, stdout: HELP, stderr: '' };
    const sub = argv[0];
    if (sub !== 'record' && sub !== 'classify') throw usageFail(`unknown subcommand "${sub}" (expected: record | classify)`);
    const opts = parseArgs(argv.slice(1));
    const payload = parsePayload(opts.json);
    const cwd = opts.cwd ?? cwd0;
    const result =
      sub === 'record'
        ? recordRound({ cwd, env, ...payload })
        : recordTriage({ cwd, env, ...payload });
    return { code: 0, stdout: `review-ledger-write: recorded a ${result.record.kind} for loop "${result.record.loop}" round ${result.record.round} → ${result.writtenPath}`, stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `review-ledger-write: ${err.message}` };
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const r = main(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
}
