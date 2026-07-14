#!/usr/bin/env node
// ack-write.mjs — the consent-gated writer for the family-owned neutral ack store
// (docs/ai/acks.json, AD-055 Part I). The upgrade Recommendations `sandbox-lane` item renders THIS
// tool's PREVIEW one-liner; the preview prints the exact `--apply` command; the agent runs `--apply`
// only after the mode doc's §3 informed-consent confirmation. It records a NEUTRAL recipe fingerprint
// acknowledgement — never a security key; the kit never writes sandbox network/filesystem allowances.
//
// Family writer discipline (velocity / orchestration-write / gate-hook), verbatim:
//   • preview-then-mutate — `--dry-run` is the DEFAULT and writes nothing; `--apply` writes;
//   • deployment-gated — REFUSES an absent docs/ai with a named recovery pointer (run init/bootstrap);
//   • creates docs/ai/acks.json (and nothing else) if absent;
//   • merge-preserve — every existing key (a hand-authored `_README`, future sibling acks) is kept;
//     only the `sandboxLaneAck` key is set;
//   • symlink / non-regular target → STOP (never write through a link or clobber a device/dir);
//   • fail-closed on malformed existing JSON (never overwrite an unparseable store);
//   • atomic — exclusive-create *.tmp + rename (no partial-write state); last-writer-wins;
//   • never commits.
//
// Dependency-free beyond the kit's own atomic-write core + the shared ack constants, Node >= 18. No
// side effects on import (the isDirectRun idiom).

import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ACKS_FILE, ACKS_LANE_KEY } from './recommendations.mjs';
import { assertDocsAiDeployment, writeDocsAiFileAtomic, lstatNoFollow } from './atomic-write.mjs';
import { shellQuoteArg } from './review-state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ACK_WRITE_TOOL = join(HERE, 'ack-write.mjs');

const ERROR_PREFIX = '[agent-workflow-kit]';
const EXIT_OK = 0;
const EXIT_PRECONDITION = 1;
const EXIT_USAGE = 2;
const JSON_INDENT = 2;
// The recipeFingerprint shape (recommendations.mjs: sha256 hex sliced to 16) — a fail-closed guard so
// the store never records a malformed or injected value.
export const FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/u;

export const ACK_WRITE_STOP = 'ACK_WRITE_STOP';
export const stop = (message) =>
  Object.assign(new Error(`${ERROR_PREFIX} ${message}`), { name: 'AckWriteStop', code: ACK_WRITE_STOP, exitCode: EXIT_PRECONDITION });
const usageFail = (message) => Object.assign(new Error(message), { exitCode: EXIT_USAGE });

const q = shellQuoteArg;

// Read + parse the existing store (already known to be a regular file). ENOENT (a TOCTOU vanish) is
// treated as absent; malformed JSON / a non-object root FAILS CLOSED — never overwrite an unparseable
// store.
const readExistingStore = (absPath, deps) => {
  const readFile = deps.readFile ?? readFileSync;
  let text;
  try {
    text = readFile(absPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    throw stop(`cannot read ${ACKS_FILE} (${err?.code ?? err?.message}) — refusing to overwrite it`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw stop(`${ACKS_FILE} is not valid JSON — refusing to overwrite it (fix or delete it, then re-run)`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw stop(`${ACKS_FILE} is not a JSON object — refusing to overwrite it`);
  }
  return parsed;
};

// Target gate: a symlinked / non-regular acks.json is a STOP (checked BEFORE any read so a FIFO can
// never block the reader). Returns { existed, existing } — the merge base.
const preflightTarget = (absPath, deps) => {
  const lstat = deps.lstat ?? lstatSync;
  const st = lstatNoFollow(absPath, lstat);
  if (st === null) return { existed: false, existing: {} };
  if (st.isSymbolicLink()) throw stop(`${ACKS_FILE} is a symlink — refusing to write through it`);
  if (!st.isFile()) throw stop(`${ACKS_FILE} exists but is not a regular file — refusing to touch it`);
  return { existed: true, existing: readExistingStore(absPath, deps) };
};

// Pure preflight (both dry-run and apply). Validates the fingerprint, refuses an absent deployment,
// gates the target, and computes the merge — no writes.
export const planAckWrite = ({ cwd, fingerprint }, deps = {}) => {
  // typeof BEFORE RegExp.test — .test() coerces its arg to a string, so a number or a single-element
  // array of 16 hex chars would otherwise pass the guard and be written as a non-string ack the
  // reader then ignores.
  if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) {
    throw usageFail(`--fingerprint must be a 16-char lowercase hex fingerprint (got ${JSON.stringify(fingerprint ?? null)})`);
  }
  const root = resolve(cwd);
  assertDocsAiDeployment(root, deps, { stop, noun: 'the neutral sandbox-lane ack', rel: ACKS_FILE });
  const absPath = join(root, ACKS_FILE);
  const { existed, existing } = preflightTarget(absPath, deps);
  const alreadyAcked = existing[ACKS_LANE_KEY] === fingerprint;
  const merged = { ...existing, [ACKS_LANE_KEY]: fingerprint };
  const otherKeys = Object.keys(existing).filter((k) => k !== ACKS_LANE_KEY);
  return { root, absPath, fingerprint, existed, existing, merged, alreadyAcked, otherKeys };
};

export const writeAck = ({ cwd, fingerprint, dryRun = true } = {}, deps = {}) => {
  const plan = planAckWrite({ cwd, fingerprint }, deps);
  if (dryRun) return { wrote: false, dryRun: true, ...plan };
  const body = `${JSON.stringify(plan.merged, null, JSON_INDENT)}\n`;
  writeDocsAiFileAtomic(plan.root, ACKS_FILE, body, deps, { stop, noun: 'the neutral sandbox-lane ack' });
  return { wrote: true, dryRun: false, ...plan };
};

// ── report ──────────────────────────────────────────────────────────────────────────────
export const applyCommand = (root, fingerprint) =>
  `node ${q(ACK_WRITE_TOOL)} --fingerprint ${fingerprint} --cwd ${q(root)} --apply`;

export const formatResult = (result) => {
  const merge = result.otherKeys.length > 0 ? ` (merge-preserving ${result.otherKeys.length} existing key(s))` : '';
  if (result.dryRun) {
    if (result.alreadyAcked) {
      return [
        `agent-workflow ack — DRY RUN: ${ACKS_FILE} already records this recipe fingerprint (${result.fingerprint}) — nothing to do.`,
      ].join('\n');
    }
    return [
      `agent-workflow ack — DRY RUN (no changes; re-run with --apply)`,
      `  - would ${result.existed ? 'set' : 'create'} ${ACKS_FILE} "${ACKS_LANE_KEY}" = "${result.fingerprint}"${merge}`,
      `  - this is a NEUTRAL recipe acknowledgement, never a security key.`,
      `  to apply: ${applyCommand(result.root, result.fingerprint)}`,
    ].join('\n');
  }
  return [
    `agent-workflow ack — APPLY`,
    `  - ${ACKS_FILE}: "${ACKS_LANE_KEY}" = "${result.fingerprint}"${merge}`,
  ].join('\n');
};

// ── CLI ─────────────────────────────────────────────────────────────────────────────────
const USAGE = `usage: ack-write --fingerprint <16-hex> [--dry-run | --apply] [--cwd <dir>] [--help]

Records the NEUTRAL sandbox-lane recipe acknowledgement into ${ACKS_FILE} (the family-owned ack
store — no host settings validator guards it). Default is --dry-run (a preview; writes nothing) and
prints the exact --apply command. --apply merges "${ACKS_LANE_KEY}" into ${ACKS_FILE}, preserving
every existing key. Refuses an absent docs/ai deployment; never a security key; never commits.`;

export const parseArgs = (argv) => {
  const opts = { fingerprint: undefined, dryRunFlag: false, apply: false, cwd: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--dry-run') opts.dryRunFlag = true;
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '--fingerprint') {
      i += 1;
      if (argv[i] === undefined || argv[i].startsWith('-')) throw usageFail('--fingerprint needs a value');
      opts.fingerprint = argv[i];
    } else if (arg === '--cwd') {
      i += 1;
      if (argv[i] === undefined || argv[i].startsWith('-')) throw usageFail('--cwd needs a directory argument');
      opts.cwd = argv[i];
    } else {
      throw usageFail(`unknown argument: ${arg}`);
    }
  }
  if (opts.dryRunFlag && opts.apply) throw usageFail('--dry-run and --apply cannot be used together');
  return { help: opts.help, fingerprint: opts.fingerprint, dryRun: !opts.apply, cwd: opts.cwd };
};

export const main = (argv = process.argv.slice(2), deps = {}) => {
  const log = deps.log ?? console.log;
  const errlog = deps.errlog ?? console.error;
  try {
    const args = parseArgs(argv);
    if (args.help) {
      log(USAGE);
      return EXIT_OK;
    }
    const result = writeAck({ cwd: args.cwd ?? deps.cwd ?? process.cwd(), fingerprint: args.fingerprint, dryRun: args.dryRun }, deps);
    log(formatResult(result));
    return EXIT_OK;
  } catch (err) {
    errlog(err?.message ?? String(err));
    if (err?.exitCode === EXIT_USAGE) errlog(USAGE);
    return err?.exitCode ?? EXIT_PRECONDITION;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exit(main(process.argv.slice(2)));
