#!/usr/bin/env node
// dispatch.mjs — the delegation ENGINE (delegation Plan 1, Phase 3; the writer verbs are Plan 2,
// Phase 2): the ONE human-facing surface over the record vocabulary (dispatch-record.mjs) and the
// ledger (dispatch-store.mjs). Eight verbs:
//
//   check <dispatch-file>  the D8 sub-task contract header, FORM-only, exit 0/1
//   register               the wave's PRE-REGISTRATION record (classes, pairing key, thresholds)
//   observe                one OBSERVATION record (the solo baseline / a self-reported datum)
//   open                   the DISPATCH record — every mint-time field COPIED from the header
//   return                 the RETURN record — the wrapper's exec receipt ABSORBED through this door
//   fold                   the FOLD record — the integration re-confirmation
//   degrade                the DEGRADE record — the recorded no-fold closure
//   aggregate [--wave]     the L0 deterministic report over ONE wave
//
// Why an engine at all: the funded metric — how much leverage a delegated sub-task actually buys —
// is unmeasurable while nothing records {dispatched → returned → folded}. The store records it; this
// surface is where a number enters the ledger by hand (a registration, an observation) and where the
// recorded threads are read back as a report. Delegated accounting is NEVER hand-appended: an
// `observation` carries only `solo-construction` and `self-reported` provenance, and the delegated
// per-class L is DERIVED here from terminal nonce threads (D7) — the writer verbs derive it from a
// wrapper-minted receipt and a git-side producer, never from a typed number.
//
// The WRITER verbs add no second legality door. The store's semantic preflight (dispatch-store.mjs)
// decides every cross-record rule under its lock; these verbs assemble a record, surface the store's
// refusals verbatim, and refuse ONLY what the store cannot see — the artifact a wrapper minted, the
// tree in front of them, and the flags a caller typed.
//
// The aggregator is deterministic exit-code/print, and it REFUSES rather than guessing: a wave with
// no pre-registration record, an OPEN thread in its scope, and an ambiguous wave selection each stop
// the computation by name. Acceptance is PRE-REGISTERED precisely so thresholds can never be chosen
// after the observations they judge; a computation that silently skipped an unfinished thread, or
// silently picked one of several waves, would give that back.
//
// Honest limits, stated where they bite:
//   • the contract checker is FORM-only BY NAME (D-R1-FORM-ONLY): fields present, grammars
//     respected. Whether the sub-task is BOUNDED, whether its design is DECIDED, and whether its
//     acceptance is ADEQUATE stay explicit orchestrator judgment fed by the retro loop.
//   • an observation is hand-recorded, so its magnitude is measured HERE: the scope names repository
//     objects and the numerator is their post-image bytes on disk at observation time. For the SOLO
//     baseline the denominator is that same number — the orchestrator authored every byte it also
//     integrated, so L = 1 EXACTLY, by construction, whatever the magnitude turns out to be; the
//     ratio is the only quantity acceptance ever consumes.
//   • acceptance aggregates the `wrapper-git` domain only (D6/R2). A self-reported observation and a
//     folded return whose bytes the wrapper could not prove are both RECORDED and PRINTED, and both
//     stay out of the mean — recorded-but-excluded, never a silent drop.
//   • the scope measurement classifies (no-follow lstat) and then reads; the pair is not race-free.
//     The scope is the orchestrator's OWN work tree and the result is a MAGNITUDE, never a store
//     identity, so a pathname race costs a wrong byte count, not a forged record.
//   • `return` never accounts GATE OUTPUT: the wrapper's EXIT trap removes its trace, so no
//     `gate-output` component is emitted in v1. The metric counts the returned change set only.
//   • a receipt is FORGEABLE, exactly like every record in this family. What the absorb door defends
//     against is a buggy or interrupted producer, not a hostile one.
//   • D10 stands as a bar, not a mechanism: at most ONE in-tree exec dispatch runs at a time, and
//     nothing here refuses a second one. A parallel-write story is not this plan's.
//
// Writer: appends to the delegation ledger through the store's lock-serialized append (the store's
// preflight is the single legality door — this module adds NO second validator). Never commits,
// never runs a subscription CLI, spawns nothing but git READS. Dependency-free, Node >= 22. No side
// effects on import (the isDirectRun idiom).

import { readFileSync, openSync, closeSync, realpathSync, readlinkSync, constants as fsConstants } from 'node:fs';
import { resolve, isAbsolute, sep, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  DELEGATION_SCHEMA_VERSION, STEP_CLASSES, OBSERVATION_PROVENANCE, RETURN_OUTCOMES,
  SESSION_ID_NULLABLE_OUTCOMES, checkDispatchContractForm, checkDispatchMintConsistency,
  contractDigest, canonicalDelegationDigest, computeNumerator, evaluateMetricEligibility,
  evaluateObservationEligibility,
} from './dispatch-record.mjs';
import {
  appendDelegationRecord, readDelegationStore, resolveDelegationStorePath, delegationThreadState,
  auditDelegationStoreSemantics, uncommittedStateFingerprint, DELEGATION_STORE_BASENAME,
} from './dispatch-store.mjs';
import { execReceiptBasename, execReportBasename, parseExecReceipt } from './exec-receipt.mjs';
import {
  enumerateReturnedObjects, computeReturnedDiff, assembleIntegrationBundle,
} from './exec-producer.mjs';
import { gitBuf, isTreeClean } from './core-evidence.mjs';
import { lstatNoFollowRead, describeNonRegular, readRegularFileNoFollow, readFileBytesNoFollow } from './fs-read-nofollow.mjs';
import { gitLine } from './flow-store-read.mjs';
import { lexicalRepoRelative } from './repo-lex.mjs';

const usageFail = (message) => Object.assign(new Error(message), { exitCode: 2 });

// The ONE contract sentence, doc-parity-bound into references/modes/dispatch.md: the FORM-only limit
// and the aggregator's refusals are what a reader must not be able to mis-learn from the mode doc.
export const DISPATCH_CONTRACT = 'the contract check is FORM-only — fields present, grammars respected, never boundedness, design-decidedness or acceptance adequacy — and `aggregate` REFUSES instead of computing acceptance for a wave with no pre-registration record, over an OPEN thread in scope, over a PRE-DISPATCH degrade that opens no thread, or across several waves with no `--wave`; the writer verbs add NO second legality door — the store\'s preflight is the only one, and its refusals travel verbatim — while `open` copies every mint-time field from the contract header and refuses a deadline below the wrapper cap plus the kill grace, `return` absorbs only a TERMINAL exec receipt whose backend, nonce and independently computed contractDigest match the dispatch it answers, and `fold` binds the CURRENT tree to the folded return\'s postTreeDigest, so a tree that moved between the two never folds';

// ── the flag surface (the CLI tests pin it against the D3 key sets) ────────────────────────────────
// flag → the record field it decides. The fields NOT on a flag are DERIVED and listed beside them,
// so "the surface mirrors the key set" is a set equality a test can compute rather than read.

export const REGISTER_FLAG_FIELDS = Object.freeze({
  '--wave': 'waveId',
  '--step-classes': 'stepClasses',
  '--pairing-key': 'pairingKey',
  '--min-per-class': 'minPerClass',
  '--mean-l-threshold': 'meanLThreshold',
  '--first-pass-num': 'firstPassNum',
  '--first-pass-den': 'firstPassDen',
});
export const REGISTER_DERIVED_FIELDS = Object.freeze(['timestamp']);

export const OBSERVE_FLAG_FIELDS = Object.freeze({
  '--wave': 'waveId',
  '--step-class': 'stepClass',
  '--scope': 'scope',
  '--plan': 'planId',
  '--phase': 'phase',
  '--provenance': 'metric.provenance',
  '--denominator-bytes': 'metric.denominatorBytes',
});
export const OBSERVE_DERIVED_FIELDS = Object.freeze(['timestamp']);

// The four writer verbs. Their key sets are larger than their flag surfaces on purpose: a delegated
// record is DERIVED — from the contract header, from the wrapper's receipt, from the tree — and the
// fields a caller may type are exactly the ones no artifact can supply. Three exported categories
// per verb (flag-decided · copied · derived) keep "the surface mirrors the key set" a set equality a
// test computes, and keep the INPUT flags that decide no field of their own visible rather than
// hidden inside the scanner.

export const OPEN_FLAG_FIELDS = Object.freeze({
  '--wave': 'waveId',
  '--backend': 'backend',
  '--rationale': 'rationale',
  '--retry-of': 'retryOf',
});
// COPIED from the contract header at mint and bound by contractDigest (D3): a dispatch that
// disagreed with the header it claims to carry is refused by checkDispatchMintConsistency.
export const OPEN_CONTRACT_FIELDS = Object.freeze(['nonce', 'stepClass', 'vehicle', 'deadlineS', 'retryIndex', 'retryCap']);
export const OPEN_DERIVED_FIELDS = Object.freeze(['contractDigest', 'preTreeDigest', 'baselineClean', 'timestamp']);
// Flags that carry NO record field: the header they read and the two operands the D8 floor is
// computed from. The kit never reads another package's default — both are explicit.
export const OPEN_INPUT_FLAGS = Object.freeze({
  '--contract': 'the dispatch file whose header every mint-time field is copied from',
  '--wrapper-cap-s': 'the wall-clock cap the wrapper will apply (the D8 floor)',
  '--kill-grace-s': 'the kill grace the wrapper will apply (the D8 floor)',
});

export const RETURN_FLAG_FIELDS = Object.freeze({
  '--nonce': 'nonce',
  '--outcome': 'outcome',
  '--exit-status': 'exitStatus',
});
export const RETURN_DERIVED_FIELDS = Object.freeze([
  'role', 'backend', 'contractDigest', 'preTreeDigest', 'postTreeDigest', 'diffDigest', 'diffLength',
  'reportDigest', 'reportLength', 'bundleDigest', 'bundleLength', 'metric', 'sessionId',
  'wrapperVersion', 'posture', 'timestamp',
]);
export const RETURN_INPUT_FLAGS = Object.freeze({
  '--no-receipt': 'absorb WITHOUT the terminal receipt (D5) — the reservation supplies the pre-spend fields',
});
const RETURN_BOOLEAN_FLAGS = new Set(['--no-receipt']);

export const FOLD_FLAG_FIELDS = Object.freeze({
  '--nonce': 'nonce',
  '--verdict': 'verdict',
});
export const FOLD_DERIVED_FIELDS = Object.freeze(['returnDigest', 'treeDigestAtFold', 'timestamp']);

export const DEGRADE_FLAG_FIELDS = Object.freeze({
  '--wave': 'waveId',
  '--nonce': 'nonce',
  '--step-class': 'stepClass',
  '--rationale': 'rationale',
});
export const DEGRADE_DERIVED_FIELDS = Object.freeze(['timestamp']);

// D4 — the closed override form. At `return` the wrapper's own outcome either STAYS itself or moves
// to one of the orchestrator-only judgments. `success` is not among them, so it is recordable only
// from a receipt that already says `success`; the record vocabulary's cross-field rules
// (dispatch-record.mjs) then cut the remaining incompatible pairs, and this form never restates them.
export const ORCHESTRATOR_OUTCOMES = Object.freeze(['contract-refusal', 'partial-edit', 'acceptance-failure', 'stale-return', 'store-failure']);
export const allowedRecordedOutcomes = (wrapperOutcome) =>
  [wrapperOutcome, ...ORCHESTRATOR_OUTCOMES.filter((o) => o !== wrapperOutcome)];

// The bytes a returned metric is proven from are git's, on both sides of the ratio — so a return
// this engine mints is always the wrapper-git domain. `self-reported` stays expressible in the
// vocabulary (a record the ledger accepts) but no writer here produces one.
const RETURN_PROVENANCE_HERE = 'wrapper-git';

// `--scope` is REPEATABLE — one repo-relative path per occurrence. No in-band separator is safe for
// POSIX paths (every byte but NUL and `/` is legal in a name), so a split on whitespace could not
// express `docs/my file.md` at all and, where the fragments happened to be real files, would measure
// the wrong set in silence. The record's `scope` field carries the canonical JSON array instead.
const REPEATABLE_NONE = new Set();
const OBSERVE_REPEATABLE = new Set(['--scope']);

// The pairing keys the AGGREGATOR actually implements. The schema types `pairingKey` as a free
// string so a future key is expressible, but a wave registered under a key the engine never honours
// would record a contract the computation does not follow — refused at both ends.
export const IMPLEMENTED_PAIRING_KEYS = Object.freeze(['stepClass']);

// The solo baseline counts each scope object's POST-IMAGE — the bytes on disk after the construction
// — which is exactly the `new` numerator rule (D6). No exec diff kind enumerates ranges, so a solo
// observation can never claim a partial object.
const SOLO_COMPONENT_KIND = 'new';

// Acceptance aggregates the git-provable domain only (D6/R2).
const ACCEPTANCE_PROVENANCE = 'wrapper-git';

// ── argument parsing ──────────────────────────────────────────────────────────────────────────────

const CWD_FLAG = '--cwd';
const HELP_FLAGS = new Set(['--help', '-h']);

// ONE left-to-right pass per verb: a flag consumes the NEXT token as its value, and that token is
// never examined again by anything else. A SECOND scanner over the same vector is the defect class
// itself — it reads a value as a control argument, so a scope path named `--help` silently printed
// help and wrote nothing, and a `--cwd` search stole whichever token followed the first match.
// Anything that is not a known flag is a positional operand; an unknown `--flag` refuses by name.
// A BOOLEAN flag consumes no token at all — it is present or it is not. It rides the same single
// pass rather than a pre-scan for exactly the reason above: a second look at the vector is how a
// flag's VALUE becomes someone else's control argument.
const parseArgs = (argv, flags, repeatable = REPEATABLE_NONE, booleans = REPEATABLE_NONE) => {
  const values = {};
  const operands = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!Object.hasOwn(flags, token)) {
      // A help token past the verb is an ORDINARY operand — its control meaning is scoped to the
      // first argument, so a file or path actually named `--help` stays reachable. Any other
      // unknown `--flag` still refuses by name.
      if (token.startsWith('--') && !HELP_FLAGS.has(token)) {
        throw usageFail(`unknown argument: ${token} — this verb's flags are ${Object.keys(flags).join(' ')}`);
      }
      operands.push(token);
      continue;
    }
    if (Object.hasOwn(values, token) && !repeatable.has(token)) {
      throw usageFail(`${token} was given twice — every flag carries exactly one value`);
    }
    if (booleans.has(token)) {
      values[token] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw usageFail(`${token} needs a value`);
    if (repeatable.has(token)) (values[token] ??= []).push(value);
    else values[token] = value;
    i += 1;
  }
  return { values, operands };
};

// Every verb accepts `--cwd` as an ordinary flag of its own scan — never as a pre-pass.
const scan = (argv, flagFields, baseCwd, { repeatable, booleans } = {}) => {
  const { values, operands } = parseArgs(argv, { ...flagFields, [CWD_FLAG]: 'cwd' }, repeatable, booleans);
  return { values, operands, cwd: values[CWD_FLAG] ?? baseCwd };
};

const refuseOperands = (verb, operands) => {
  if (operands.length > 0) throw usageFail(`unknown argument: ${operands[0]} — ${verb} takes flags only`);
};

const need = (values, flag) => {
  const value = values[flag];
  if (value === undefined) throw usageFail(`${flag} is required`);
  return value;
};

const INTEGER_RE = /^(?:0|[1-9][0-9]*)$/;
const asInteger = (flag, raw) => {
  if (!INTEGER_RE.test(raw)) throw usageFail(`${flag} must be a non-negative decimal integer (got "${raw}")`);
  const value = Number(raw);
  // Past the safe range an exact byte comparison is no longer possible, and the record vocabulary
  // refuses such a count — refuse it HERE, where the flag that carried it can be named.
  if (!Number.isSafeInteger(value)) throw usageFail(`${flag} leaves the safe-integer range (got "${raw}")`);
  return value;
};
const asPositiveInteger = (flag, raw) => {
  const value = asInteger(flag, raw);
  if (value < 1) throw usageFail(`${flag} must be at least 1 (got "${raw}")`);
  return value;
};
const asNumber = (flag, raw) => {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value)) throw usageFail(`${flag} must be a finite number (got "${raw}")`);
  return value;
};

const refusal = (verb, reason) => ({ code: 1, stdout: '', stderr: `dispatch ${verb}: ${reason}` });

// ── check: the D8 contract header, FORM only ──────────────────────────────────────────────────────

const runCheck = ({ argv, baseCwd }) => {
  const { operands, cwd } = scan(argv, {}, baseCwd);
  if (operands.length > 1) throw usageFail(`unknown argument: ${operands[1]}`);
  const file = operands[0];
  if (file === undefined) throw usageFail('check needs a dispatch file: node dispatch.mjs check <dispatch-file>');
  const path = isAbsolute(file) ? file : resolve(cwd, file);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { code: 1, stdout: '', stderr: `dispatch check: cannot read ${file} (${(err && err.code) || (err && err.message)})` };
  }
  const form = checkDispatchContractForm(text);
  if (!form.ok) return { code: 1, stdout: `dispatch check: FORM VIOLATION — ${form.reason}`, stderr: '' };
  const c = form.contract;
  return {
    code: 0,
    stdout: `dispatch check: FORM OK — nonce "${c.nonce}", step class "${c.stepClass}", vehicle ${c.vehicle.requested} → ${c.vehicle.selected}, deadline ${c.deadlineS}s, retry ${c.retry.index}/${c.retry.cap}\n  (${DISPATCH_CONTRACT})`,
    stderr: '',
  };
};

// ── register: the wave's pre-registration ─────────────────────────────────────────────────────────

const requireImplementedPairingKey = (pairingKey) => {
  if (!IMPLEMENTED_PAIRING_KEYS.includes(pairingKey)) {
    throw usageFail(`--pairing-key must be one of ${IMPLEMENTED_PAIRING_KEYS.join(' | ')} (got "${pairingKey}") — a wave registered under a key the aggregator does not honour would record a contract the computation never follows`);
  }
  return pairingKey;
};

const runRegister = ({ baseCwd, env, argv, now }) => {
  const { values, operands, cwd } = scan(argv, REGISTER_FLAG_FIELDS, baseCwd);
  refuseOperands('register', operands);
  const record = {
    schema: DELEGATION_SCHEMA_VERSION,
    kind: 'pre-registration',
    waveId: need(values, '--wave'),
    stepClasses: need(values, '--step-classes').split(',').filter((c) => c !== ''),
    pairingKey: requireImplementedPairingKey(need(values, '--pairing-key')),
    minPerClass: asInteger('--min-per-class', need(values, '--min-per-class')),
    meanLThreshold: asNumber('--mean-l-threshold', need(values, '--mean-l-threshold')),
    firstPassNum: asInteger('--first-pass-num', need(values, '--first-pass-num')),
    firstPassDen: asInteger('--first-pass-den', need(values, '--first-pass-den')),
    timestamp: now(),
  };
  const { writtenPath } = appendDelegationRecord({ cwd, record, env });
  return {
    code: 0,
    stdout: `dispatch register: wave "${record.waveId}" registered — classes ${record.stepClasses.join(' | ')} · pairing key ${record.pairingKey} · minimum ${record.minPerClass} per class · mean L >= ${record.meanLThreshold} · first pass >= ${record.firstPassNum}/${record.firstPassDen} → ${writtenPath}`,
    stderr: '',
  };
};

// ── observe: one hand-recorded observation ────────────────────────────────────────────────────────

const ratio = (value) => value.toFixed(3);

// L is printed ONLY where the metric is eligible: an ineligible metric has a NAMED reason and no
// ratio at all, and printing a number beside the name is how a silent zero gets read as a measurement.
const formatRatio = (metric) => (metric.eligible
  ? `L = ${ratio(metric.numeratorBytes / metric.denominatorBytes)} (${metric.numeratorBytes} B / ${metric.denominatorBytes} B)`
  : `L = n/a — INELIGIBLE (${metric.ineligibleReason})`);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The scope's anchor is the git TOP-LEVEL, never the caller's cwd: a recorded scope must name the
// same objects whoever runs the tool from wherever. `null` outside a work tree — a repo-relative
// domain with no repository has nothing to be relative TO, and falling back to cwd would be a
// second, incompatible semantics for the same field.
const resolveRepoRoot = (cwd) => {
  if (gitLine(['rev-parse', '--is-inside-work-tree'], cwd) !== 'true') return null;
  const top = gitLine(['rev-parse', '--show-toplevel'], cwd);
  return top === null ? null : realpathSync(top);
};

// The read is no-follow on the LEAF (a symlinked leaf is already refused by name above; O_NOFOLLOW
// makes a swap between the classification and the read fail loudly rather than counting another
// object's bytes). Honest limit: classify-then-read is not race-free, and it is not meant to be —
// the scope is the orchestrator's OWN work tree and the result is a MAGNITUDE, never a store
// identity, so a pathname race costs a wrong byte count, not a forged record.
const readObjectBytes = (path) => {
  const fd = openSync(path, (fsConstants.O_RDONLY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
};

// One scope object → one numerator entry. Refuses by NAME on anything it cannot count honestly: a
// path escaping the repo LEXICALLY, an absent path, a non-regular path (a symlinked leaf included —
// following one would count another object's bytes under this name), and a path whose REAL location
// is outside the repository. The last one is the case the lexical rule alone cannot see: it rejects
// `../x` while accepting `link/x`, where `link` is an ancestor symlink pointing out of the tree.
// The identity is the CANONICAL repo-relative path taken from the verified real path — not a content
// hash. The solo domain has no rename lineage for a content id to protect, and a content id would
// let one object read between two measurements look like TWO objects instead of refusing as the
// producer contradiction it is ("one identity, one size"). Two equal-byte files at different paths
// are two objects and count twice; one path reached twice (a second listing, an in-repo ancestor
// symlink) is one object and counts once.
const measureObject = (root, rel) => {
  const lexical = lexicalRepoRelative(rel);
  if (!lexical.ok) return { ok: false, reason: `scope path "${rel}": ${lexical.reason}` };
  const path = resolve(root, rel);
  const stat = lstatNoFollowRead(path);
  if (stat === null) return { ok: false, reason: `scope path "${rel}" does not exist — an observation counts objects that are actually there (fail closed)` };
  if (!stat.isFile()) return { ok: false, reason: `scope path "${rel}" is a ${describeNonRegular(stat)}, not a regular file — the scope names repository objects (fail closed)` };
  const real = realpathSync(path);
  if (!real.startsWith(`${root}${sep}`)) {
    return { ok: false, reason: `scope path "${rel}" resolves to ${real}, which leaves the repository at ${root} — an ancestor symlink is not a way out of the scope domain (fail closed)` };
  }
  const canonical = real.slice(root.length + 1);
  const bytes = readObjectBytes(path);
  return { ok: true, entry: { kind: SOLO_COMPONENT_KIND, path: canonical, objectId: canonical, postImageBytes: bytes.length } };
};

// One repo-relative path per `--scope` occurrence, in the order given. The measured CANONICAL paths
// become the record's `scope` as a canonical JSON array, so what was measured and what is written
// down are the same statement — and a path carrying a space says so unambiguously.
const measureScope = (root, paths) => {
  const entries = [];
  for (const rel of paths) {
    const measured = measureObject(root, rel);
    if (!measured.ok) return measured;
    entries.push(measured.entry);
  }
  const numerator = computeNumerator(entries);
  return numerator.ok
    ? { ...numerator, scope: JSON.stringify(entries.map((e) => e.path)) }
    : { ok: false, reason: numerator.reason };
};

const runObserve = ({ baseCwd, env, argv, now }) => {
  const { values, operands, cwd } = scan(argv, OBSERVE_FLAG_FIELDS, baseCwd, { repeatable: OBSERVE_REPEATABLE });
  refuseOperands('observe', operands);
  const provenance = need(values, '--provenance');
  if (!OBSERVATION_PROVENANCE.includes(provenance)) {
    throw usageFail(`--provenance must be one of ${OBSERVATION_PROVENANCE.join(' | ')} (got "${provenance}") — delegated accounting is DERIVED from nonce threads, never hand-appended`);
  }
  const paths = need(values, '--scope');
  const root = resolveRepoRoot(cwd);
  if (root === null) {
    return { code: 1, stdout: '', stderr: 'dispatch observe: not inside a git work tree — a scope names REPOSITORY objects, so without a repository there is nothing its paths are relative to (fail closed)' };
  }
  const measured = measureScope(root, paths);
  if (!measured.ok) return { code: 1, stdout: '', stderr: `dispatch observe: ${measured.reason}` };
  // The SOLO baseline's denominator is its own numerator: the orchestrator authored every byte it
  // also integrated, so L = 1 by construction and no caller may type that number. A self-reported
  // observation states the integration cost it claims — and is excluded from acceptance downstream.
  const solo = provenance === 'solo-construction';
  if (solo && values['--denominator-bytes'] !== undefined) {
    throw usageFail('--denominator-bytes is refused for --provenance solo-construction — the solo denominator IS the measured numerator (L = 1 by construction)');
  }
  const denominatorBytes = solo
    ? measured.numeratorBytes
    : asInteger('--denominator-bytes', need(values, '--denominator-bytes'));
  const eligibility = evaluateObservationEligibility({ numeratorBytes: measured.numeratorBytes, denominatorBytes });
  const record = {
    schema: DELEGATION_SCHEMA_VERSION,
    kind: 'observation',
    waveId: need(values, '--wave'),
    stepClass: need(values, '--step-class'),
    scope: measured.scope,
    metric: {
      numeratorBytes: measured.numeratorBytes,
      denominatorBytes,
      components: measured.components,
      provenance,
      eligible: eligibility.eligible,
      ineligibleReason: eligibility.ineligibleReason,
    },
    planId: need(values, '--plan'),
    phase: asInteger('--phase', need(values, '--phase')),
    timestamp: now(),
  };
  const { writtenPath } = appendDelegationRecord({ cwd, record, env });
  // DISTINCT objects, not scope entries: the numerator dedups on the canonical path, so counting
  // entries would report two objects where one was counted — the echo must agree with the number.
  const objects = new Set(record.metric.components.map((c) => c.objectId)).size;
  return {
    code: 0,
    stdout: `dispatch observe: recorded a ${provenance} observation in wave "${record.waveId}" — class ${record.stepClass} · plan ${record.planId} phase ${record.phase} · ${formatRatio(record.metric)} · ${objects} object(s) → ${writtenPath}`,
    stderr: '',
  };
};

// ── the shared ledger read: legality re-established BEFORE any verb computes over it (D14) ────────

// The append path refuses a malformed LINE, but nothing replayed a semantically illegal PREFIX that
// some other producer wrote — and a verb computing over such a ledger inherits its lie. So every
// verb that DERIVES anything from the store (`return`, `fold`, `degrade`, `aggregate`) reads it
// through this one door, which replays the store's own preflight in file order and stops at the
// first record the append path would have refused, naming its physical line.
//
// `open` deliberately has no read-side audit: it derives nothing from the ledger. Its retry and wave
// rules are evaluated by the store, on the snapshot under the lock, which is the only place they can
// be decided without a race.
const readLegalLedger = (cwd, env) => {
  const path = resolveDelegationStorePath(cwd, env);
  if (path === null) {
    return { ok: false, reason: 'not inside a git work tree (and no AW_DELEGATION_STORE override) — there is no delegation store to read' };
  }
  const store = readDelegationStore(path);
  if (store.readError !== undefined) return { ok: false, reason: `${path} — ${store.readError}` };
  if (store.malformed > 0) {
    return { ok: false, reason: `${path} carries ${store.malformed} malformed line(s) — a dropped line could hide a thread the computation must see (fail closed): ${store.malformedReasons.join('; ')}` };
  }
  const audit = auditDelegationStoreSemantics({ records: store.records, recordLines: store.recordLines, storePath: path });
  if (!audit.ok) {
    return { ok: false, reason: `${path} line ${audit.line} carries a record the append path would have REFUSED — ${audit.reason}` };
  }
  // The receipt artifacts live BESIDE the ledger — one resolution, so the kit reads exactly where
  // the wrapper writes (the bash mirror of this path is the bridge's, in Phase 3).
  return { ok: true, path, dir: dirname(path), records: store.records };
};

// ── open: the DISPATCH record ─────────────────────────────────────────────────────────────────────

const runOpen = ({ baseCwd, env, argv, now }) => {
  const { values, operands, cwd } = scan(argv, { ...OPEN_FLAG_FIELDS, ...OPEN_INPUT_FLAGS }, baseCwd);
  refuseOperands('open', operands);
  const file = need(values, '--contract');
  // Both operands are EXPLICIT: the kit never reads another package's default, because a cap it
  // guessed would put a floor nobody agreed to under a deadline the ledger then enforces.
  const capS = asPositiveInteger('--wrapper-cap-s', need(values, '--wrapper-cap-s'));
  const killGraceS = asInteger('--kill-grace-s', need(values, '--kill-grace-s'));
  const path = isAbsolute(file) ? file : resolve(cwd, file);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return refusal('open', `cannot read ${file} (${(err && err.code) || (err && err.message)})`);
  }
  const form = checkDispatchContractForm(text);
  if (!form.ok) return refusal('open', `FORM VIOLATION — ${form.reason}`);
  const contract = form.contract;
  // D8's floor, checked BEFORE anything is written: a dispatch whose deadline expires before its own
  // wrapper can be capped and killed could never honour the terminal-exit rule — the waiter would
  // report an expiry while the run was still legitimately alive, and no writer slot would be free.
  const floorS = capS + killGraceS;
  if (contract.deadlineS < floorS) {
    return refusal('open', `the contract's deadlineS ${contract.deadlineS} is below the wrapper cap ${capS} plus the kill grace ${killGraceS} (${floorS}) — a dispatch that cannot be capped inside its own deadline can never honour the terminal-exit rule; nothing was written`);
  }
  // The baseline is probed BEFORE the fingerprint, because it is the one that can answer "there is
  // no repository here" as a NAMED refusal — the fingerprint's own answer to that is a thrown STOP,
  // and a verb should refuse in its own words before another module has to. Not decidable is never
  // CLEAN: baselineClean:false is what makes the eventual return honestly ineligible, and guessing
  // true would let an unattributable metric into the acceptance number.
  const baselineClean = isTreeClean(cwd);
  if (baselineClean === null) {
    return refusal('open', 'the working state could not be probed, so the baseline is undecidable — a dispatch never records a guessed baseline, and outside a git work tree there is no tree to fingerprint either (fail closed); nothing was written');
  }
  const top = resolveRepoRoot(cwd);
  if (top === null) return refusal('open', 'not inside a git work tree — a dispatch is opened against a repository (fail closed); nothing was written');
  const placed = canonicalStoreRefusal(cwd, env);
  if (placed !== null) return refusal('open', `${placed}; nothing was written`);
  // ONE nonce, ONE artifact pair — checked PRE-SPEND, which is also where the wrapper's own
  // no-clobber reservation will refuse from its side. An artifact that already exists for this
  // {backend, nonce} was minted by something else, and absorbing it later would answer this dispatch
  // with another run's evidence.
  const leftover = existingArtifactRefusal(dirname(resolveDelegationStorePath(cwd, env)), need(values, '--backend'), contract.nonce);
  if (leftover !== null) return refusal('open', `${leftover}; nothing was written`);
  // The baseline is a RECORDED CLAIM about this tree, so it is refused before it is made: a tree that
  // conceals a change reports CLEAN to `isTreeClean` and then hands the concealed change to the
  // delegate's account at return time. `open` is where that lie is cheapest to catch.
  const honest = hiddenFromPlainDiff(cwd, top);
  if (!honest.ok) return refusal('open', `${honest.reason}; nothing was written`);
  const preTreeDigest = uncommittedStateFingerprint(cwd);
  const record = {
    schema: DELEGATION_SCHEMA_VERSION,
    kind: 'dispatch',
    waveId: need(values, '--wave'),
    nonce: contract.nonce,
    stepClass: contract.stepClass,
    vehicle: { requested: contract.vehicle.requested, selected: contract.vehicle.selected },
    backend: need(values, '--backend'),
    contractDigest: contractDigest(contract),
    preTreeDigest,
    baselineClean,
    deadlineS: contract.deadlineS,
    retryOf: values['--retry-of'] ?? null,
    retryIndex: contract.retry.index,
    retryCap: contract.retry.cap,
    rationale: need(values, '--rationale'),
    timestamp: now(),
  };
  // D3's binding, run as the last act before the append: contractDigest binds the copy, and every
  // mint-time field is compared against the header it was copied from rather than trusted.
  const mint = checkDispatchMintConsistency(contract, record);
  if (!mint.ok) return refusal('open', mint.reason);
  // The placement check is REPEATED here, immediately before the write. A check-then-write pair is
  // not atomic, so this NARROWS the window in which the resolved store could be replaced under us
  // rather than closing it — which is the honest bound of this module's stated posture: it defends
  // against a buggy or interrupted producer, never against a racing adversary.
  const stillPlaced = canonicalStoreRefusal(cwd, env);
  if (stillPlaced !== null) return refusal('open', `${stillPlaced}; nothing was written`);
  const { writtenPath } = appendDelegationRecord({ cwd, record, env });
  return {
    code: 0,
    stdout: `dispatch open: thread "${record.nonce}" opened in wave "${record.waveId}" — class ${record.stepClass} · backend ${record.backend} · vehicle ${record.vehicle.requested} → ${record.vehicle.selected} · deadline ${record.deadlineS}s (floor ${floorS}s) · retry ${record.retryIndex}/${record.retryCap} · baseline ${baselineClean ? 'CLEAN' : 'DIRTY — the return will be metric-INELIGIBLE (dirty-baseline)'} → ${writtenPath}`,
    stderr: '',
  };
};

// ── return: the wrapper's exec receipt, ABSORBED ──────────────────────────────────────────────────

// The return-time guard the Phase-1 council required. `git diff` SKIPS index entries carrying
// assume-unchanged or skip-worktree and honours diff.ignoreSubmodules, so a path can be CHANGED and
// invisible to BOTH halves of the ratio at once — the producer's enumeration and the canonical
// payload the denominator is framed from run the same plain probes. The kit already owns a probe
// that sees them (computeWorkingState forces --ignore-submodules=none and folds in flaggedIndexLag),
// so the absorb door compares the two views and refuses the DIFFERENCE by name.
//
// It is deliberately NOT a producer fix: D7 binds the numerator to computeFingerprintPayload's byte
// domain, and forcing the flags on one side only would let the numerator count objects the
// denominator cannot see — a worse failure than the blindness. The payload-side fix is queued as its
// own frozen-shared-surface change.
//
// The untracked section is excluded from the comparison because BOTH views read it with the same
// `ls-files --others --exclude-standard` probe: there is no divergence there to find. Both sides
// also decode path bytes identically, so an exotic name cannot make the two disagree by decoding
// alone — and if it ever did, the answer would be a refusal, never a wrong number.
// A tree can LIE about itself in two independent ways, and neither is decidable by comparing two
// views that share the same blindness. So this asks two questions of its own, and every door that
// measures or binds a tree (`open`, `return`, `fold`) asks them before it does anything else.
//
// (a) INDEX BITS, fail closed on their PRESENCE. `git ls-files -v` tags an assume-unchanged entry
// lowercase and a skip-worktree entry `S`, and the second one is the sharp case: a MISSING
// skip-worktree path is an ordinary sparse checkout to every probe this kit owns — probed live, the
// deletion of a materialized skip-worktree file is invisible to `computeWorkingState`, to the plain
// diff, to the tree fingerprint AND to the producer's enumeration. Nothing can compare its way to
// that, so the BIT is refused rather than its effect. It bites hardest at `open`: set the bit, delete
// the file, open (a FALSE clean baseline is recorded), then clear the bit — and the return credits the
// delegate with a deletion it never made. Refusing any tag but `H` also refuses an unmerged index,
// which is honest for a measurement.
//
// (b) The --ignore-submodules axis, PER SIDE and on BYTES. Against the UNION of the two name lists a
// path visible on one side masks its own hidden state on the other; against DECODED names two
// distinct paths collapse into one (`h\xff.txt` and a real `h�.txt` decode identically, so one
// hidden path hides behind one visible path). Segments therefore stay raw and only a reversible
// latin1 key indexes the set. The staged side needs only this axis: probed live, `git diff --cached`
// lists assume-unchanged and skip-worktree entries unchanged, because those bits gate the WORKTREE
// comparison and the index-vs-HEAD comparison never consults them.
//
// Exported as a TEST SEAM as well: the fail-closed arms guard against a git that cannot answer at
// all, which no fixture can produce from inside a healthy repository.

// canonicalizeExisting(path) → { ok, real } | { ok: false, code, at }. Resolves through symlinks by
// walking up to the nearest EXISTING ancestor and re-joining the lexical tail, so a directory that
// has not been created yet is still judged. ENOENT is the ONLY error that walks: every other errno
// (EACCES, EIO, ELOOP) fails closed, because a path this kit cannot resolve is not a path it may
// approve.
const canonicalizeExisting = (start) => {
  let current = resolve(start);
  const tail = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return { ok: true, real: tail.length === 0 ? real : join(real, ...[...tail].reverse()) };
    } catch (err) {
      const code = (err && err.code) || (err && err.message) || 'realpath failed';
      if (code !== 'ENOENT') return { ok: false, code, at: current };
      const parent = dirname(current);
      if (parent === current) return { ok: false, code: 'no existing ancestor', at: current };
      tail.push(basename(current));
      current = parent;
    }
  }
};

// WHICH LEDGER the three tree-binding verbs may use: the CANONICAL one, exactly —
// `<git common dir>/agent-workflow-delegation.jsonl`. The `AW_DELEGATION_STORE` seam takes any
// absolute path, which is right for a reader and wrong for a writer that MEASURES the tree it writes
// into. Three separate failures collapse into this one equality:
//   • a store inside the work tree is carried by the payload AND enumerated as an object, so the
//     metric counts its own bookkeeping as delegated work — and the append that follows
//     `postTreeDigest` moves the tree, so every later fold drifts by construction (probed);
//   • a store belonging to ANOTHER repository would measure this tree against a foreign thread,
//     since the frozen record schema binds no worktree identity;
//   • two ledgers in ONE git dir would share artifact names, which are a function of
//     {backend, nonce} alone — so a return could absorb the neighbouring ledger's receipt.
// Containment inside the git dir closed the first two and NOT the third; equality closes all three
// and removes a rule rather than adding one. One repository, one delegation ledger — which is what
// resolving to the git COMMON dir already meant. `register`, `observe` and `aggregate` keep the
// unrestricted override: they bind no tree.
//
// STATED RESIDUAL, and it is a real one: two LINKED WORKTREES of the same repository share that one
// canonical ledger by design, so this rule cannot separate them. Opening in one linked worktree and
// returning or folding in another measures the wrong tree, and the frozen record schema carries no
// worktree identity to bind it with (`preTreeDigest` is copied, not recomputed; the nonce is opaque).
// That case is FORBIDDEN by the D10 one-writer bar and is named here rather than mechanized.
const canonicalStoreRefusal = (cwd, env) => {
  const storePath = resolveDelegationStorePath(cwd, env);
  if (storePath === null) return null; // the "no work tree" refusal belongs to the caller, by name
  const commonDir = gitLine(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (commonDir === null) return 'the git common dir could not be resolved — a measured dispatch is never written to a ledger this kit cannot place (fail closed)';
  const store = canonicalizeExisting(dirname(storePath));
  const home = canonicalizeExisting(commonDir);
  // FAIL CLOSED on an unresolvable path, never lexically. The lexical fallback belongs to
  // `isEntryPoint`, where an unresolvable side can only make a comparison FAIL; here it would make a
  // check PASS — a store lexically inside the git dir but really outside it (an escaping symlink)
  // would be admitted the moment a transient EACCES/EIO hid its real location. Same construct,
  // opposite polarity, opposite safety.
  for (const probed of [store, home]) {
    if (!probed.ok) return `the path ${probed.at} could not be canonicalized (${probed.code}) — a store this kit cannot place is never bound to a tree (fail closed)`;
  }
  if (store.real !== home.real || basename(storePath) !== DELEGATION_STORE_BASENAME) {
    return `the delegation store resolves to ${storePath}, which is not this repository's CANONICAL ledger (${join(home.real, DELEGATION_STORE_BASENAME)}) — a tree-binding verb uses that one and no other: a store inside the work tree is measured as part of the change set it is supposed to be measuring, a store in another repository would measure this tree against a foreign thread, and a SECOND ledger in this git dir would share artifact names with the first, since they are a function of {backend, nonce} alone; drop the AW_DELEGATION_STORE override (register, observe and aggregate still honour it)`;
  }
  return null;
};

// A symlink's TARGET is read by the shared payload with `readlink` as a STRING, so bytes that are not
// valid UTF-8 are gone before any framing question arises — probed, two links whose targets are the
// single bytes 0xff and 0xfe produce the SAME payload and the SAME enumeration, so swapping one for
// the other after a return is invisible to the fold. Until the payload reads targets as bytes (queued
// with the framing migration), such a link is refused: this is not a fourth blind CLASS, it is the
// narrow case where the payload provably cannot follow one object's bytes.
// ENOENT is the ONLY error that means "there is nothing to check here" — a deleted link, whose bytes
// ride the diff exactly. EVERY other errno refuses, EINVAL emphatically included: the producer labels
// an object `symlink` when ANY layer carries mode 120000, so a committed symlink REPLACED by a binary
// regular file is a `symlink` entry whose readlink answers EINVAL — and skipping it would walk that
// object past the content-blind refusal as well, which never sees a `binary` kind that was never
// emitted. Two guards, and the type change falls between them unless this one fails closed.
// `io.readlink` is a TEST SEAM for the errno arms a fixture cannot produce on demand.
const symlinkTargetRefusal = (top, entries, io = {}) => {
  const readlink = io.readlink ?? ((path) => readlinkSync(path, { encoding: 'buffer' }));
  const lost = [];
  for (const entry of entries) {
    if (entry.kind !== 'symlink') continue;
    let target;
    try {
      target = readlink(join(top, entry.path));
    } catch (err) {
      const code = (err && err.code) || (err && err.message) || 'readlink failed';
      if (code === 'ENOENT') continue;
      return `the symlink "${entry.path}" could not be read (${code}) — an unreadable link is a FAILED probe, not an absent one, and a path the producer labelled a symlink while readlink refuses it is a TYPE CHANGE whose new bytes no guard here can see (fail closed)`;
    }
    if (!Buffer.from(target.toString('utf8'), 'utf8').equals(target)) lost.push(`${entry.path} -> 0x${target.toString('hex')}`);
  }
  if (lost.length === 0) return null;
  return `${lost.length} symlink target(s) are not valid UTF-8 (${lost.join(', ')}) — the shared payload reads a target as a STRING, so those bytes are folded to U+FFFD before the digest is taken and a later change of target moves nothing at all; this lane is fail-closed for them until the payload reads targets as bytes`;
};

// NUL-delimited git output, kept as BUFFER segments — a decoded split cannot be undone.
const zSegments = (buf) => {
  const out = [];
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== 0) continue;
    if (i > start) out.push(buf.subarray(start, i));
    start = i + 1;
  }
  if (start < buf.length) out.push(buf.subarray(start));
  return out;
};

// A path is SHOWN as text only where its bytes are exactly that text; otherwise as hex. A message
// that echoed raw invalid bytes would be one more place a path loses its identity.
const showPath = (bytes) => {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : `<non-UTF-8 path 0x${bytes.toString('hex')}>`;
};

const LS_FILES_CACHED_TAG = 'H';

export const hiddenFromPlainDiff = (cwd, top) => {
  const probe = (args) => {
    const buf = gitBuf(args, top);
    return buf == null ? null : zSegments(buf);
  };
  const indexEntries = probe(['ls-files', '-v', '-z']);
  const plainStaged = probe(['diff', '--cached', '--name-only', '-z', '--no-ext-diff']);
  const plainUnstaged = probe(['diff', '--name-only', '-z', '--no-ext-diff']);
  const forcedStaged = probe(['diff', '--cached', '--name-only', '-z', '--no-ext-diff', '--ignore-submodules=none']);
  const forcedUnstaged = probe(['diff', '--name-only', '-z', '--no-ext-diff', '--ignore-submodules=none']);
  if ([indexEntries, plainStaged, plainUnstaged, forcedStaged, forcedUnstaged].some((r) => r === null)) {
    return { ok: false, reason: 'a git probe of the change set could not be read — a tree this kit cannot describe is never measured (fail closed)' };
  }
  // `<tag><space><path>` per segment; the tag is one ASCII byte by the format's own grammar.
  const flagged = indexEntries
    .filter((seg) => seg.length > 2 && String.fromCharCode(seg[0]) !== LS_FILES_CACHED_TAG)
    .map((seg) => `${String.fromCharCode(seg[0])} ${showPath(seg.subarray(2))}`);
  if (flagged.length > 0) {
    return { ok: false, reason: `${flagged.length} index entr(ies) carry a tag other than "${LS_FILES_CACHED_TAG}" (${flagged.join('; ')}) — an assume-unchanged or skip-worktree entry makes the index lie about the worktree, and the sharpest case is invisible to EVERY probe this kit owns: deleting a materialized skip-worktree file changes no diff, no fingerprint and no enumeration, so a delegated measurement over such a tree is not honest at all; clear the bits (git update-index --no-assume-unchanged / --no-skip-worktree) and try again` };
  }
  const key = (seg) => seg.toString('latin1');
  const missing = (forced, plain) => {
    const seen = new Set(plain.map(key));
    return forced.filter((seg) => !seen.has(key(seg)));
  };
  const hiddenStaged = missing(forcedStaged, plainStaged);
  const hiddenUnstaged = missing(forcedUnstaged, plainUnstaged);
  const count = hiddenStaged.length + hiddenUnstaged.length;
  if (count === 0) return { ok: true };
  // A path hidden on BOTH sides is two facts, not one — the index lies and the worktree lies — so it
  // is counted and named twice, under the side that hid it.
  const where = [
    hiddenStaged.length > 0 ? `staged: ${hiddenStaged.map(showPath).join(', ')}` : null,
    hiddenUnstaged.length > 0 ? `unstaged: ${hiddenUnstaged.map(showPath).join(', ')}` : null,
  ].filter((part) => part !== null).join('; ');
  return { ok: false, reason: `${count} changed path(s) are HIDDEN from the plain git diff this metric is computed over (${where}) — an ignore-submodules setting keeps them out of BOTH the numerator and the denominator, so the recorded bytes would describe a change set that is not the one on disk; clear the diff config and try again` };
};

// THE CONTENT-BLIND CLASSES, and the line between them and the merely ambiguous ones.
//
// For three kinds the payload carries NO CONTENT AT ALL, so their bytes can move underneath a digest
// that cannot follow them — all three probed live:
//   • `binary` — the payload holds `untracked-binary:<path>`, and a tracked binary's diff is the one
//     line "Binary files … differ". Neither a same-size mutation nor a SIZE change moves the digest.
//   • `non-regular` — `untracked-nonregular:<path>`, a name and nothing else.
//   • `submodule` — the first transition to dirty moves the digest (the superproject line gains
//     "-dirty") and NOTHING after it does: a second, different nested edit and a whole new nested
//     file both leave the digest unchanged.
// For those, `fold`'s binding would accept bytes nobody returned while the numerator counts a size
// re-read at return time. Documenting that would leave a promise knowingly false, so the capability
// is SUBTRACTED: a change set carrying one is refused, by name, at both doors.
//
// Regular-file content and a symlink's TARGET are deliberately NOT here. They are present in the
// payload — only unframed, so adjacent entries can alias each other (the residual named in the mode
// doc and in --help). Subtracting them would refuse `new` and `symlink`, which is every delegated
// change set there is, and the lane would measure nothing at all.
//
// Restoring the three means changing `computeFingerprintPayload` — a Plan-1 frozen surface the
// REVIEW lane also binds — which is queued, not done here.
export const CONTENT_BLIND_KINDS = Object.freeze(['binary', 'non-regular', 'submodule']);

// Per class, and precisely: the submodule arm is CONSERVATIVE, not a claim about every submodule. A
// clean staged gitlink replacement carries exact OIDs in the payload; it is the nested state of an
// already-DIRTY one that becomes invisible, and no cheap probe separates the two at this door.
const CONTENT_BLIND_WHY = {
  binary: 'the payload holds its name only, so neither its content nor its size reaches the digest',
  'non-regular': 'the payload holds its name only',
  submodule: 'refused conservatively: a clean pointer change does carry its OIDs, but once the submodule is dirty the payload records nothing further about its nested state',
};

export const contentBlindRefusal = (entries) => {
  const blind = entries.filter((e) => CONTENT_BLIND_KINDS.includes(e.kind));
  if (blind.length === 0) return null;
  const listed = blind.map((e) => `${e.kind} ${e.path} (${CONTENT_BLIND_WHY[e.kind]})`).join('; ');
  return `the change set carries ${blind.length} object(s) whose CONTENT never enters the uncommitted-state payload (${listed}) — their bytes can move under a tree digest that cannot follow them, so the numerator would count a size the fold's binding cannot re-confirm. This lane is fail-closed for them until the shared payload can carry their content (a frozen surface the review lane binds too): keep such objects out of a measured dispatch, or close the thread with degrade`;
};

// Pre-spend: neither artifact name may be taken before the dispatch that will own it exists. The
// names are a function of {backend, nonce} alone, so a leftover pair — from a rotated ledger, a
// hand-run wrapper, an interrupted cycle — would be absorbed later as this thread's own evidence.
const existingArtifactRefusal = (dir, backend, nonce) => {
  const taken = [execReceiptBasename(backend, nonce), execReportBasename(backend, nonce)]
    .filter((name) => name !== null && lstatNoFollowRead(join(dir, name)) !== null);
  if (taken.length === 0) return null;
  return `${taken.length} exec artifact(s) for {backend "${backend}", nonce "${nonce}"} already exist beside the ledger (${taken.join(', ')}) — those names are a function of that pair ALONE, so whatever wrote them would be absorbed as this dispatch's own evidence; remove them, or mint the sub-task under a fresh nonce`;
};

// The two artifacts the wrapper minted, read through the store's own no-follow reader.
const readReceiptArtifact = (dir, backend, nonce) => {
  // Neither token can be unsafe here: the record vocabulary pins BOTH to the shared safe grammar and
  // the ledger audit re-established that every record in the store passed it, so the basename is
  // always buildable at this point.
  const path = join(dir, execReceiptBasename(backend, nonce));
  const read = readRegularFileNoFollow(path);
  if (read.outcome === 'absent') {
    // NOT a --no-receipt recovery: that lane reads THIS path, so it would refuse identically. With no
    // artifact at all the wrapper proved nothing about the run — not even that it started — and the
    // only honest closure is a recorded degrade.
    return { ok: false, reason: `no exec receipt at ${path} — a return is built from the artifact the wrapper minted, never from a tree alone, and with no reservation there either nothing about this run is knowable (--no-receipt reads the same path and would refuse the same way); close the thread with degrade` };
  }
  if (read.outcome === 'foreign') return { ok: false, reason: `the exec receipt at ${path} is a ${read.className}, not a regular file — refusing to read it (fail closed)` };
  if (read.outcome === 'error') return { ok: false, reason: `the exec receipt at ${path} could not be read (${read.code}) — fail closed` };
  const parsed = parseExecReceipt(read.content);
  return parsed.ok ? { ok: true, receipt: parsed.receipt, path } : { ok: false, reason: `the exec receipt at ${path} is REFUSED — ${parsed.reason}` };
};

const readReportArtifact = (dir, backend, nonce) => {
  const path = join(dir, execReportBasename(backend, nonce));
  const read = readFileBytesNoFollow(path);
  if (read.outcome === 'absent') return { ok: true, path, bytes: null };
  if (read.outcome === 'foreign') return { ok: false, reason: `the exec report at ${path} is a ${read.className}, not a regular file — refusing to read it (fail closed)` };
  // ABSENT and UNREADABLE are different answers, the same distinction the producer draws: an absent
  // report is a lane (report-if-present, D5), an unreadable one is a failed probe.
  if (read.outcome === 'error') return { ok: false, reason: `the exec report at ${path} could not be read (${read.code}) — an unreadable report is a FAILED probe, not an absent one (fail closed)` };
  return { ok: true, path, bytes: read.bytes };
};

const EMPTY_REPORT = Buffer.alloc(0);

// treeDriftRefusal(opening, closing) → the reason, or null. Exported as a TEST SEAM, and only for
// that: a tree that moves BETWEEN two git reads inside one call cannot be produced on demand from a
// fixture, so the arm that catches it is pinned directly rather than left as unreachable prose.
export const treeDriftRefusal = (openingDigest, closingDigest) => (openingDigest === closingDigest
  ? null
  : `the tree moved WHILE the return was being computed (${openingDigest.slice(0, 12)}… → ${closingDigest.slice(0, 12)}…) — the enumeration and the diff would then describe two different change sets, and the record would bind a postTreeDigest neither of them saw; nothing was written, so leave the tree alone and return again`);

const runReturn = ({ baseCwd, env, argv, now }) => {
  const { values, operands, cwd } = scan(argv, { ...RETURN_FLAG_FIELDS, ...RETURN_INPUT_FLAGS }, baseCwd, { booleans: RETURN_BOOLEAN_FLAGS });
  refuseOperands('return', operands);
  const nonce = need(values, '--nonce');
  const noReceipt = values['--no-receipt'] === true;
  // The exit status is the RECEIPT's fact wherever a receipt exists — a hand-typed one beside it
  // would let the ledger disagree with the run it claims to record.
  if (!noReceipt && values['--exit-status'] !== undefined) {
    throw usageFail('--exit-status belongs to the --no-receipt lane — a terminal receipt already records the status the run actually exited with');
  }
  // The preconditions read in order: a repository, then a ledger this verb is ALLOWED to bind a tree
  // against, then a legal ledger, then the thread, then the artifacts, then the tree itself.
  const top = resolveRepoRoot(cwd);
  if (top === null) {
    return refusal('return', 'not inside a git work tree — a return is enumerated against a repository (fail closed)');
  }
  const placed = canonicalStoreRefusal(cwd, env);
  if (placed !== null) return refusal('return', `${placed}; nothing was written`);
  const ledger = readLegalLedger(cwd, env);
  if (!ledger.ok) return refusal('return', ledger.reason);
  const state = delegationThreadState(ledger.records, nonce);
  if (state.dispatch === null) {
    return refusal('return', `no dispatch for nonce "${nonce}" is in the store — a return answers the dispatch that opened its thread, and a record that binds to nothing is never absorbed; nothing was written`);
  }
  const dispatch = state.dispatch;
  const artifact = readReceiptArtifact(ledger.dir, dispatch.backend, nonce);
  if (!artifact.ok) return refusal('return', artifact.reason);
  const receipt = artifact.receipt;
  // The terminal-exit rule AT THE ABSORB DOOR: a reservation says the run was minted, never that it
  // finished. `await` treats the same artifact as "keep waiting"; here it is a SUPERVISION question,
  // because absorbing it would record an outcome nobody observed.
  if (!noReceipt && receipt.state === 'reserved') {
    return refusal('return', `the exec receipt at ${artifact.path} is still RESERVED — the run holds the nonce but has published no terminal receipt, so nothing is known about how it ended. This is a SUPERVISION question, not a timeout: wait for the run (dispatch await), or, once you have established what happened to it, absorb the reservation with --no-receipt --exit-status <n> --outcome <o>; nothing was written`);
  }
  // …and the same rule from the other side. `--no-receipt` absorbs a RESERVATION; over a TERMINAL
  // artifact it would let a hand-stated outcome and exit status overwrite ones the run actually
  // proved, skip the report verification entirely, and null a real session id — a recorded lie built
  // out of a recovery lane. The artifact decides which lane applies, not the caller.
  if (noReceipt && receipt.state === 'terminal') {
    return refusal('return', `--no-receipt absorbs a RESERVATION, and the artifact at ${artifact.path} is TERMINAL: the run published its exit status, its session id and its report digest, so a hand-stated outcome here would discard proven facts and skip the report check. Absorb it on the ordinary lane (drop --no-receipt); if the terminal receipt itself is not to be trusted, close the thread with degrade instead; nothing was written`);
  }
  // {backend, nonce} live in the artifact's NAME and in its BODY. A body disagreeing with the name
  // is a receipt minted for another dispatch, and the correlation would otherwise pass on the
  // strength of a filename this side composed itself.
  if (receipt.backend !== dispatch.backend || receipt.nonce !== nonce) {
    return refusal('return', `the exec receipt names {backend "${receipt.backend}", nonce "${receipt.nonce}"} but answers the dispatch {backend "${dispatch.backend}", nonce "${nonce}"} — a receipt is bound to its dispatch by identity, not by the filename it was found under; nothing was written`);
  }
  // D2 — the wrapper computed this digest INDEPENDENTLY, from the dispatch file it was actually
  // handed. Without it the correlation would compare the dispatch record against values derived from
  // itself, and a run that executed a DIFFERENT contract would correlate cleanly.
  if (receipt.contractDigest !== dispatch.contractDigest) {
    return refusal('return', `the exec receipt's contractDigest ${receipt.contractDigest.slice(0, 12)}… does not equal the dispatch's ${dispatch.contractDigest.slice(0, 12)}… — the run executed a DIFFERENT contract than the one this thread opened; nothing was written`);
  }
  // D8, the two halves of the deadline. The cap the run ACTUALLY applied is a pre-spend fact, so it
  // is checked on either lane; the timestamp is the artifact's own, and the message names which
  // state it came from so a `--no-receipt` refusal cannot be read as a terminal one.
  if (receipt.capS + receipt.killGraceS > dispatch.deadlineS) {
    return refusal('return', `the exec receipt applied capS ${receipt.capS} plus killGraceS ${receipt.killGraceS} (${receipt.capS + receipt.killGraceS}) against the dispatch's recorded deadlineS ${dispatch.deadlineS} — the run could outlive the deadline this thread was opened under; nothing was written`);
  }
  // The window is CLOSED at both ends, inclusive. Only the upper bound existed at first, so a receipt
  // minted BEFORE this dispatch was absorbed as its answer — and artifact basenames are a function of
  // {backend, nonce} alone, so a second ledger in the same directory could absorb the first's
  // terminal artifact. A run cannot answer a dispatch that had not happened yet.
  const openedAt = Date.parse(dispatch.timestamp);
  const deadlineAt = openedAt + dispatch.deadlineS * 1000;
  const stampedAt = Date.parse(receipt.timestamp);
  if (stampedAt < openedAt) {
    return refusal('return', `the ${receipt.state} exec receipt is stamped ${receipt.timestamp}, BEFORE this dispatch was opened (${dispatch.timestamp}) — a run cannot answer a dispatch that did not exist yet, and artifact names are a function of {backend, nonce} alone, so an older artifact for the same pair is another thread's; nothing was written`);
  }
  if (stampedAt > deadlineAt) {
    return refusal('return', `the ${receipt.state} exec receipt is stamped ${receipt.timestamp}, past this dispatch's absolute deadline (${dispatch.timestamp} + ${dispatch.deadlineS}s = ${new Date(deadlineAt).toISOString()}) — a LATE return; the deadline is measured from the dispatch record, not from whenever the wrapper happened to start; nothing was written`);
  }
  const report = readReportArtifact(ledger.dir, dispatch.backend, nonce);
  if (!report.ok) return refusal('return', report.reason);
  // D1's publication order, verified rather than trusted: the report is written atomically FIRST and
  // the terminal receipt replaces the reservation LAST, so a TERMINAL artifact always has a complete
  // report behind it. On the --no-receipt lane the semantics are report-IF-PRESENT: an absent report
  // records reportLength 0 and the metric is then ineligible by the existing name `empty-report`, so
  // a failed REPORT write and a failed TERMINAL write stay two separately named lanes.
  if (!noReceipt) {
    if (report.bytes === null) {
      return refusal('return', `the terminal exec receipt declares a report of ${receipt.reportLength} byte(s) but no report artifact is at ${report.path} — the report is published BEFORE the receipt replaces the reservation, so a terminal receipt with no report behind it is a state no completed run mints; nothing was written`);
    }
    const digest = sha256(report.bytes);
    if (digest !== receipt.reportDigest || report.bytes.length !== receipt.reportLength) {
      return refusal('return', `the report at ${report.path} (${report.bytes.length} bytes, ${digest.slice(0, 12)}…) contradicts the terminal receipt (${receipt.reportLength} bytes, ${receipt.reportDigest.slice(0, 12)}…) — the artifact changed after the run published it; nothing was written`);
    }
  }
  const reportBytes = report.bytes ?? EMPTY_REPORT;
  const outcome = resolveReturnOutcome(values, receipt, noReceipt);
  const exitStatus = noReceipt
    ? asInteger('--exit-status', need(values, '--exit-status'))
    : receipt.exitStatus;
  const hidden = hiddenFromPlainDiff(cwd, top);
  if (!hidden.ok) return refusal('return', hidden.reason);
  // The enumeration and the payload are two walks of one tree, so the pair is BRACKETED: the
  // fingerprint is taken before the walks and the payload's own digest is compared against it after.
  // A tree that moved between them would hand the numerator one change set and the denominator
  // another, and the record would bind a postTreeDigest neither of them describes.
  const openingDigest = uncommittedStateFingerprint(cwd);
  const enumerated = enumerateReturnedObjects(cwd);
  if (!enumerated.ok) return refusal('return', enumerated.reason);
  const opaque = contentBlindRefusal(enumerated.entries);
  if (opaque !== null) return refusal('return', `${opaque}; nothing was written`);
  const lostTarget = symlinkTargetRefusal(top, enumerated.entries);
  if (lostTarget !== null) return refusal('return', `${lostTarget}; nothing was written`);
  const produced = computeReturnedDiff(cwd);
  if (!produced.ok) return refusal('return', produced.reason);
  // The payload IS the diff and its digest IS the uncommitted-state fingerprint — one computation,
  // so diffDigest and postTreeDigest are equal by construction rather than by coincidence.
  const postTreeDigest = sha256(produced.diff);
  const drift = treeDriftRefusal(openingDigest, postTreeDigest);
  if (drift !== null) return refusal('return', drift);
  // The fail-closed arm of a producer contradiction (one objectId claimed at two sizes). The
  // enumeration is this kit's own and emits one entry per object, so nothing here can reach it —
  // the vocabulary stays the authority on what a component is, and its refusal is surfaced whole.
  const numerator = computeNumerator(enumerated.entries);
  if (!numerator.ok) return refusal('return', numerator.reason);
  const { bundleDigest, bundleLength } = assembleIntegrationBundle(produced.diff, reportBytes);
  // The LOCALLY provable name wins outright, exactly as the record validator pins it: `dirty-baseline`
  // is the store-verified override and may only apply where the return's OWN fields leave the metric
  // eligible, so it can never stand in for a reason a reader could have checked.
  const local = evaluateMetricEligibility({
    baselineClean: true,
    numeratorBytes: numerator.numeratorBytes,
    diffLength: produced.diff.length,
    reportLength: reportBytes.length,
    bundleLength,
  });
  const ineligibleReason = local.ineligibleReason ?? (dispatch.baselineClean ? null : 'dirty-baseline');
  const record = {
    schema: DELEGATION_SCHEMA_VERSION,
    kind: 'return',
    role: 'execute',
    backend: dispatch.backend,
    nonce,
    contractDigest: dispatch.contractDigest,
    preTreeDigest: dispatch.preTreeDigest,
    postTreeDigest,
    diffDigest: postTreeDigest,
    diffLength: produced.diff.length,
    reportDigest: sha256(reportBytes),
    reportLength: reportBytes.length,
    bundleDigest,
    bundleLength,
    metric: {
      numeratorBytes: numerator.numeratorBytes,
      denominatorBytes: bundleLength,
      components: numerator.components,
      provenance: RETURN_PROVENANCE_HERE,
      eligible: ineligibleReason === null,
      ineligibleReason,
    },
    outcome,
    exitStatus,
    sessionId: noReceipt ? null : receipt.sessionId,
    wrapperVersion: receipt.wrapperVersion,
    posture: { model: receipt.posture.model, effort: receipt.posture.effort, tier: receipt.posture.tier },
    timestamp: now(),
  };
  // The placement check is REPEATED here, immediately before the write. A check-then-write pair is
  // not atomic, so this NARROWS the window in which the resolved store could be replaced under us
  // rather than closing it — which is the honest bound of this module's stated posture: it defends
  // against a buggy or interrupted producer, never against a racing adversary.
  const stillPlaced = canonicalStoreRefusal(cwd, env);
  if (stillPlaced !== null) return refusal('return', `${stillPlaced}; nothing was written`);
  const { writtenPath } = appendDelegationRecord({ cwd, record, env });
  const objects = new Set(record.metric.components.map((c) => c.objectId)).size;
  return {
    code: 0,
    stdout: `dispatch return: thread "${nonce}" answered — outcome ${outcome}${noReceipt ? ' (absorbed from the RESERVATION, --no-receipt)' : ''} · exit ${exitStatus} · session ${record.sessionId ?? 'none'} · ${objects} object(s) · ${formatRatio(record.metric)} → ${writtenPath}`,
    stderr: '',
  };
};

// D4 — the recorded outcome is the wrapper's, or an orchestrator judgment from the closed override
// form. The `--no-receipt` lane has no wrapper outcome to keep, so it REQUIRES one and admits only
// the outcomes a null sessionId is legal under (dispatch-record.mjs) — which is what makes
// `partial-edit` and `stale-return` inexpressible there by name.
const resolveReturnOutcome = (values, receipt, noReceipt) => {
  const requested = values['--outcome'];
  if (requested !== undefined && !RETURN_OUTCOMES.includes(requested)) {
    throw usageFail(`--outcome must be one of ${RETURN_OUTCOMES.join(' | ')} (got "${requested}")`);
  }
  if (noReceipt) {
    if (requested === undefined) {
      throw usageFail(`--outcome is required with --no-receipt — the reservation proves nothing about how the run ended, so the outcome is an orchestrator judgment and is stated, never inferred (one of ${SESSION_ID_NULLABLE_OUTCOMES.join(' | ')})`);
    }
    if (!SESSION_ID_NULLABLE_OUTCOMES.includes(requested)) {
      throw usageFail(`--outcome "${requested}" is outside the --no-receipt set ${SESSION_ID_NULLABLE_OUTCOMES.join(' | ')} — this lane records no session id, and an outcome that requires one is not expressible from a reservation`);
    }
    return requested;
  }
  if (requested === undefined) return receipt.outcome;
  const allowed = allowedRecordedOutcomes(receipt.outcome);
  if (!allowed.includes(requested)) {
    throw usageFail(`--outcome "${requested}" may not be recorded over a receipt that says "${receipt.outcome}" — a wrapper outcome either stays itself or moves to an orchestrator judgment (${ORCHESTRATOR_OUTCOMES.join(' | ')}), and "success" is recordable only from a receipt that already says success`);
  }
  return requested;
};

// ── fold: the integration re-confirmation ─────────────────────────────────────────────────────────

const runFold = ({ baseCwd, env, argv, now }) => {
  const { values, operands, cwd } = scan(argv, FOLD_FLAG_FIELDS, baseCwd);
  refuseOperands('fold', operands);
  const nonce = need(values, '--nonce');
  const verdict = need(values, '--verdict');
  const top = resolveRepoRoot(cwd);
  if (top === null) {
    return refusal('fold', 'not inside a git work tree — a fold re-confirms the tree it is folding (fail closed); nothing was written');
  }
  const placed = canonicalStoreRefusal(cwd, env);
  if (placed !== null) return refusal('fold', `${placed}; nothing was written`);
  const ledger = readLegalLedger(cwd, env);
  if (!ledger.ok) return refusal('fold', ledger.reason);
  const state = delegationThreadState(ledger.records, nonce);
  if (state.dispatch === null) {
    return refusal('fold', `no dispatch for nonce "${nonce}" is in the store — a fold closes a thread that was opened; nothing was written`);
  }
  if (state.return === null) {
    return refusal('fold', `nonce "${nonce}" carries no return to fold — a fold folds a RETURN, and the thread's last record is a ${state.last.kind}; nothing was written`);
  }
  // THE SAME hidden-path guard the absorb door runs, and for a sharper reason: `treeDigestAtFold` is
  // computed from the very payload that is blind to these paths, so a change made behind an index bit
  // between the return and the fold leaves the digest EQUAL and the fold would accept bytes nobody
  // returned. The digest cannot catch what the payload cannot see; this guard is what does.
  const hidden = hiddenFromPlainDiff(cwd, top);
  if (!hidden.ok) return refusal('fold', `${hidden.reason}; nothing was written`);
  // …and the same subtraction: an object the payload holds by name alone can be mutated between the
  // return and the fold without moving the digest this fold is about to bind. The enumeration runs
  // here for that one question — the fold computes no metric of its own.
  const enumerated = enumerateReturnedObjects(cwd);
  if (!enumerated.ok) return refusal('fold', enumerated.reason);
  const opaque = contentBlindRefusal(enumerated.entries);
  if (opaque !== null) return refusal('fold', `${opaque}; nothing was written`);
  const lostTarget = symlinkTargetRefusal(top, enumerated.entries);
  if (lostTarget !== null) return refusal('fold', `${lostTarget}; nothing was written`);
  // WHAT THIS BINDING IS, exactly: EQUALITY OF THE VISIBLE UNFRAMED PAYLOAD between the return and
  // the fold — never an identity of the tree, and the difference is not academic. The payload is an
  // unframed concatenation, so two DIFFERENT trees can produce the same bytes: probed live, one file
  // containing the line `untracked:two.txt` yields the same fingerprint as a tree of two files, and a
  // symlink target can imitate the marker that opens the next untracked entry. It also carries no
  // git-relevant mode, so making an untracked file executable moves nothing at all. Those are stated
  // residual limits of a Plan-1 frozen surface the review lane binds too, queued as its own item —
  // not defects of this verb, and not something this verb may quietly claim away.
  //
  // Within that domain the binding does its job: a tree whose payload moved between the return and
  // the fold refuses, and the recovery is a fresh dispatch. Staging usually moves the payload — every
  // change set carrying an untracked path does — which is why the fold precedes `git add -A` (D16).
  // The one shape it does not move is a tracked-only change passing from the worktree into a CLEAN
  // index: the payload concatenates the staged and unstaged diffs, so those bytes are identical
  // either side of `git add` (the fingerprint's stated blindness to the index↔worktree split). The
  // fold is honest there — identical payload bytes, identical content — so the rule is "the fold
  // precedes staging", never "staging refuses the fold by construction".
  const treeDigestAtFold = uncommittedStateFingerprint(cwd);
  const record = {
    schema: DELEGATION_SCHEMA_VERSION,
    kind: 'fold',
    nonce,
    returnDigest: canonicalDelegationDigest(state.return),
    treeDigestAtFold,
    verdict,
    timestamp: now(),
  };
  // The placement check is REPEATED here, immediately before the write. A check-then-write pair is
  // not atomic, so this NARROWS the window in which the resolved store could be replaced under us
  // rather than closing it — which is the honest bound of this module's stated posture: it defends
  // against a buggy or interrupted producer, never against a racing adversary.
  const stillPlaced = canonicalStoreRefusal(cwd, env);
  if (stillPlaced !== null) return refusal('fold', `${stillPlaced}; nothing was written`);
  const { writtenPath } = appendDelegationRecord({ cwd, record, env });
  return {
    code: 0,
    stdout: `dispatch fold: thread "${nonce}" folded and CLOSED — return outcome ${state.return.outcome} · tree ${treeDigestAtFold.slice(0, 12)}… · ${formatRatio(state.return.metric)} → ${writtenPath}`,
    stderr: '',
  };
};

// ── degrade: the recorded no-fold closure ─────────────────────────────────────────────────────────

const runDegrade = ({ baseCwd, env, argv, now }) => {
  const { values, operands, cwd } = scan(argv, DEGRADE_FLAG_FIELDS, baseCwd);
  refuseOperands('degrade', operands);
  const ledger = readLegalLedger(cwd, env);
  if (!ledger.ok) return refusal('degrade', ledger.reason);
  const nonce = values['--nonce'] ?? null;
  const record = {
    schema: DELEGATION_SCHEMA_VERSION,
    kind: 'degrade',
    waveId: need(values, '--wave'),
    nonce,
    stepClass: need(values, '--step-class'),
    rationale: need(values, '--rationale'),
    timestamp: now(),
  };
  const { writtenPath } = appendDelegationRecord({ cwd, record, env });
  // The PRE-DISPATCH form's consequence is stated where it is recorded, not discovered later: it
  // opens no nonce thread, so `aggregate` REFUSES the whole wave until the wave's counting unit is
  // decided. That is a live cost of writing this record, and it is said on the line that writes it.
  const consequence = nonce === null
    ? ' — a PRE-DISPATCH refusal: it opens NO nonce thread, so `aggregate` will REFUSE this wave by name until the wave\'s counting unit is decided'
    : ' and CLOSED the thread';
  return {
    code: 0,
    stdout: `dispatch degrade: recorded in wave "${record.waveId}"${consequence} — class ${record.stepClass}${nonce === null ? '' : ` · nonce ${nonce}`} · "${record.rationale}" → ${writtenPath}`,
    stderr: '',
  };
};

// ── aggregate: the L0 report over ONE wave ────────────────────────────────────────────────────────

const WAVE_BEARING_KINDS = ['pre-registration', 'dispatch', 'observation', 'degrade'];

// Every wave the store mentions — never only the registered ones, so a wave whose registration is
// missing is still SELECTED and then refused by name (an unregistered wave must be loud, not absent).
export const wavesInStore = (records) =>
  [...new Set(records.filter((r) => WAVE_BEARING_KINDS.includes(r.kind)).map((r) => r.waveId))];

export const selectWave = (records, requested) => {
  const waves = wavesInStore(records);
  if (requested !== undefined) {
    return waves.includes(requested)
      ? { ok: true, waveId: requested }
      : { ok: false, reason: `no record in the delegation store names the wave "${requested}" — there is nothing to aggregate` };
  }
  if (waves.length === 0) return { ok: false, reason: 'the delegation store carries no wave — register one first (dispatch.mjs register --wave <id> …)' };
  if (waves.length > 1) {
    return { ok: false, reason: `several waves are present (${waves.join(', ')}) and no --wave was given — the selection is AMBIGUOUS, and acceptance is never computed over a guessed scope` };
  }
  return { ok: true, waveId: waves[0] };
};

// The closure a thread contributing NO leverage is reported under. D7 grants a metric contribution
// to a folded SUCCESS only: a folded acceptance-failure is the orchestrator paying for the same work
// a second time (the §7 fold-fix), so its bytes are not leverage — but the thread happened, so it
// takes the zero row by its own name rather than vanishing.
const zeroLabel = (last, ret) => (last.kind === 'fold'
  ? `folded ${ret.outcome} — the fold-fix is not leverage`
  : last.kind === 'degrade' ? 'degrade-closed' : `failure-terminal (${last.outcome})`);

// One nonce thread → its row in the D7 inclusion table. A thread reaches here only after the OPEN
// check, so `state.last` is its closure.
const classifyThread = (dispatch, state) => {
  const row = { nonce: dispatch.nonce, stepClass: dispatch.stepClass, retryIndex: dispatch.retryIndex };
  const ret = state.return;
  const foldedSuccess = state.last.kind === 'fold' && ret.outcome === 'success';
  if (!foldedSuccess) {
    // Failure-terminal, degrade-closed, or a folded non-success: IN n at L = 0 — a delegation that
    // cost a dispatch and yielded nothing usable is a real zero, never an absence. The bytes it DID
    // consume stay in the byte-weighted secondary's denominator.
    const denominatorBytes = ret === null ? 0 : ret.metric.denominatorBytes;
    return { ...row, inN: true, L: 0, numeratorBytes: 0, denominatorBytes, firstPass: false, disposition: zeroLabel(state.last, ret) };
  }
  const metric = ret.metric;
  const accepted = metric.eligible && metric.provenance === ACCEPTANCE_PROVENANCE;
  // A retryIndex-0 thread reaching FOLDED SUCCESS is the first pass — including one whose metric is
  // not acceptance-grade: the attempt landed, only its bytes are unprovable.
  const firstPass = dispatch.retryIndex === 0;
  const excluded = metric.eligible ? `provenance ${metric.provenance}` : metric.ineligibleReason;
  return {
    ...row,
    inN: accepted,
    L: accepted ? metric.numeratorBytes / metric.denominatorBytes : null,
    numeratorBytes: accepted ? metric.numeratorBytes : 0,
    denominatorBytes: accepted ? metric.denominatorBytes : 0,
    firstPass,
    disposition: accepted ? 'folded success' : `folded success, EXCLUDED from the mean (${excluded})`,
  };
};

const summarizeClass = (stepClass, threads, registration) => {
  const inClass = threads.filter((t) => t.stepClass === stepClass);
  const counted = inClass.filter((t) => t.inN);
  // BigInt accumulation: each byte count is a safe integer on its own, but their SUM need not be,
  // and a rounded total would quietly move the ratio it feeds. The conversion happens once, at the
  // division that produces the printed value.
  const sumNumerator = counted.reduce((sum, t) => sum + BigInt(t.numeratorBytes), 0n);
  const sumDenominator = counted.reduce((sum, t) => sum + BigInt(t.denominatorBytes), 0n);
  // The first-pass rate is per CHAIN, so its denominator is the retryIndex-0 threads: counting a
  // retry as its own attempt would report one piece of work twice.
  const origins = inClass.filter((t) => t.retryIndex === 0);
  return {
    stepClass,
    threads: inClass,
    n: counted.length,
    computed: counted.length >= registration.minPerClass,
    meanL: counted.length === 0 ? null : counted.reduce((sum, t) => sum + t.L, 0) / counted.length,
    byteWeightedL: sumDenominator === 0n ? null : Number(sumNumerator) / Number(sumDenominator),
    firstPassNum: origins.filter((t) => t.firstPass).length,
    firstPassDen: origins.length,
  };
};

export const aggregateDelegationWave = (records, waveId) => {
  const registrationAt = records.findIndex((r) => r.kind === 'pre-registration' && r.waveId === waveId);
  if (registrationAt === -1) {
    return { ok: false, reason: `wave "${waveId}" carries NO pre-registration record — acceptance is PRE-REGISTERED before the first observation it counts, so a wave without one is never aggregated` };
  }
  const firstAt = records.findIndex((r) => WAVE_BEARING_KINDS.includes(r.kind) && r.waveId === waveId);
  if (firstAt !== registrationAt) {
    return { ok: false, reason: `wave "${waveId}" carries a ${records[firstAt].kind} record BEFORE its pre-registration — the registration precedes every record it will count, or the thresholds were chosen after the fact` };
  }
  const registration = records[registrationAt];
  // The read-side half of the pairing-key rule: the store can be hand-written, so the registration
  // is re-checked here rather than trusted because `register` screened the flag.
  if (!IMPLEMENTED_PAIRING_KEYS.includes(registration.pairingKey)) {
    return { ok: false, reason: `wave "${waveId}" is registered under pairing key "${registration.pairingKey}", which this aggregator does not implement (${IMPLEMENTED_PAIRING_KEYS.join(' | ')}) — computing under a different key than the wave recorded would answer a question nobody registered` };
  }
  // A pre-dispatch degrade (nonce null) is a RECORDED refusal to delegate that opens no nonce
  // thread. Counting it would silently widen `n` from D7's terminal THREADS to attempts; printing
  // it uncounted would let repeated pre-dispatch failures cost the numbers nothing. Neither is this
  // plan's call to make, so the computation refuses and says which record stopped it.
  const preDispatch = records.find((r) => r.kind === 'degrade' && r.waveId === waveId && r.nonce === null);
  if (preDispatch !== undefined) {
    return { ok: false, reason: `wave "${waveId}" carries a PRE-DISPATCH degrade (class ${preDispatch.stepClass}, "${preDispatch.rationale}") — it opens no nonce thread, so it is neither a terminal thread D7 can count nor a record this computation may ignore; the acceptance computation REFUSES until the wave's counting unit is decided` };
  }
  const threads = [];
  for (const dispatch of records.filter((r) => r.kind === 'dispatch' && r.waveId === waveId)) {
    const state = delegationThreadState(records, dispatch.nonce);
    if (state.open) {
      return { ok: false, reason: `thread "${dispatch.nonce}" (class ${dispatch.stepClass}) is OPEN — the acceptance computation REFUSES over an incomplete wave; close it with a fold or a recorded degrade first` };
    }
    threads.push(classifyThread(dispatch, state));
  }
  return {
    ok: true,
    report: {
      waveId,
      registration,
      classes: registration.stepClasses.map((c) => summarizeClass(c, threads, registration)),
      observations: records.filter((r) => r.kind === 'observation' && r.waveId === waveId),
    },
  };
};

// ── rendering ─────────────────────────────────────────────────────────────────────────────────────

// A solo-construction row is the recorded BASELINE; a self-reported row is observational only. Both
// stay out of the acceptance number (which aggregates the wrapper-git domain), and saying so on the
// row is what keeps a reader from adding them into it.
const observationLine = (record) => {
  const role = record.metric.provenance === 'solo-construction' ? 'baseline' : 'observational only, EXCLUDED from acceptance';
  return `    ${record.metric.provenance} · class ${record.stepClass} · plan ${record.planId} phase ${record.phase} · ${formatRatio(record.metric)} · ${role}\n      scope: ${record.scope}`;
};

const classLines = (summary, registration) => {
  const lines = [`  class "${summary.stepClass}" — ${summary.threads.length} delegated thread(s):`];
  for (const t of summary.threads) lines.push(`    ${t.nonce} · retry ${t.retryIndex} · ${t.disposition}${t.inN ? ` · L = ${ratio(t.L)}` : ''}`);
  const firstPass = summary.firstPassDen === 0 ? 'n/a' : ratio(summary.firstPassNum / summary.firstPassDen);
  if (!summary.computed) {
    lines.push(`  acceptance, class "${summary.stepClass}": NOT COMPUTED — n = ${summary.n} is below the registered minimum ${registration.minPerClass} (insufficient)`);
    return lines;
  }
  const meanMet = summary.meanL >= registration.meanLThreshold ? 'MET' : 'NOT MET';
  // The rate comparison is EXACT: cross-multiplying in Number rounds once a product leaves the safe
  // range, and a rounded product can report MET for a rate that is not met. BigInt costs nothing
  // here and never touches the record schema (the stored values stay JSON numbers).
  const firstPassMet = BigInt(summary.firstPassNum) * BigInt(registration.firstPassDen)
    >= BigInt(registration.firstPassNum) * BigInt(summary.firstPassDen) ? 'MET' : 'NOT MET';
  lines.push(
    `  acceptance, class "${summary.stepClass}": COMPUTED — PILOT evidence (n = ${summary.n})`,
    `    mean L = ${ratio(summary.meanL)} (threshold ${registration.meanLThreshold}) — ${meanMet}`,
    `    byte-weighted L = ${summary.byteWeightedL === null ? 'n/a' : ratio(summary.byteWeightedL)} (SECONDARY)`,
    `    first pass = ${summary.firstPassNum}/${summary.firstPassDen} = ${firstPass} (threshold ${registration.firstPassNum}/${registration.firstPassDen}) — ${firstPassMet}`,
  );
  return lines;
};

export const renderAggregate = (report) => {
  const r = report.registration;
  const lines = [
    `delegation aggregate — wave "${report.waveId}"`,
    `  registered ${r.timestamp} — classes ${r.stepClasses.join(' | ')} · pairing key ${r.pairingKey} · minimum ${r.minPerClass} per class · mean L >= ${r.meanLThreshold} · first pass >= ${r.firstPassNum}/${r.firstPassDen}`,
    `  observations — recorded context, never part of the acceptance number:`,
    ...(report.observations.length === 0 ? ['    (none)'] : report.observations.map(observationLine)),
  ];
  for (const summary of report.classes) lines.push(...classLines(summary, r));
  return lines.join('\n');
};

const runAggregate = ({ baseCwd, env, argv }) => {
  const { values, operands, cwd } = scan(argv, { '--wave': 'waveId' }, baseCwd);
  refuseOperands('aggregate', operands);
  // Legality is re-established BEFORE anything is counted, and by the store's own authority — the
  // ONE door every read-dependent verb shares. Never a "legal prefix": a ledger that stops making
  // sense mid-file is unexplained, not shorter.
  const ledger = readLegalLedger(cwd, env);
  if (!ledger.ok) return refusal('aggregate', ledger.reason);
  const selected = selectWave(ledger.records, values['--wave']);
  if (!selected.ok) return refusal('aggregate', selected.reason);
  const aggregated = aggregateDelegationWave(ledger.records, selected.waveId);
  if (!aggregated.ok) return refusal('aggregate', aggregated.reason);
  return { code: 0, stdout: renderAggregate(aggregated.report), stderr: '' };
};

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

const HELP = `dispatch — the delegation engine (agent-workflow family): the sub-task contract check, the
delegation ledger's hand-recorded records, the four writer verbs that put a delegated thread on the
record, and the L0 acceptance report.

Usage:
  node dispatch.mjs check <dispatch-file> [--cwd <dir>]
  node dispatch.mjs register --wave <id> --step-classes <c[,c...]>
                             --pairing-key ${IMPLEMENTED_PAIRING_KEYS.join('|')}
                             --min-per-class <n> --mean-l-threshold <x>
                             --first-pass-num <n> --first-pass-den <n> [--cwd <dir>]
  node dispatch.mjs observe --wave <id> --step-class <c> --scope <path> [--scope <path>...]
                            --plan <id> --phase <n> --provenance ${OBSERVATION_PROVENANCE.join('|')}
                            [--denominator-bytes <n>] [--cwd <dir>]
  node dispatch.mjs open --contract <dispatch-file> --wave <id> --backend <name>
                         --rationale <text> --wrapper-cap-s <n> --kill-grace-s <n>
                         [--retry-of <nonce>] [--cwd <dir>]
  node dispatch.mjs return --nonce <n> [--outcome <o>]
                           [--no-receipt --exit-status <n>] [--cwd <dir>]
  node dispatch.mjs fold --nonce <n> --verdict <text> [--cwd <dir>]
  node dispatch.mjs degrade --wave <id> --step-class <c> --rationale <text>
                            [--nonce <n>] [--cwd <dir>]
  node dispatch.mjs aggregate [--wave <id>] [--cwd <dir>]

check reads the ONE \`\`\`aw-dispatch-contract fenced block in the dispatch file and validates its
FORM: ${DISPATCH_CONTRACT}. Exit 0 form-valid; 1 names the FIRST violated field.

register appends the wave's PRE-REGISTRATION record (immutable per wave: a second one refuses).
observe appends ONE observation — provenance ${OBSERVATION_PROVENANCE.join(' or ')} only, since
delegated accounting is DERIVED from nonce threads and is never hand-appended. The numerator is the
post-image bytes of the objects the scope names; solo-construction takes the same number as its
denominator (L = 1 by construction, so --denominator-bytes is refused), self-reported states its own.
--scope is REPEATABLE, one repo-relative path per occurrence (no separator is safe inside a POSIX
path), anchored at the git TOP-LEVEL so a recorded scope names the same objects from any cwd; the
record carries the measured canonical paths as a JSON-encoded array of canonical repo-relative paths,
carried in the schema's string field. An object's identity IS its canonical path, so two equal-byte
files count twice while one path reached twice counts once. Outside a work tree, for a path whose
REAL location leaves the repository (an ancestor symlink included), and for an absent or non-regular
path, observe refuses by name. Stated exception to "L = 1 by construction": a solo scope that
measures ZERO bytes has no ratio at all and is recorded INELIGIBLE by name (zero-denominator), never
as L = 1.

open appends the DISPATCH record that opens a thread. Every mint-time field — nonce, step class,
vehicle, deadline, retry index and cap — is COPIED from the contract header and bound by
contractDigest; the tree is fingerprinted (preTreeDigest) and probed for a CLEAN baseline, and a
dirty one is recorded, which makes the eventual return metric-INELIGIBLE by name. It REFUSES a
deadlineS below --wrapper-cap-s plus --kill-grace-s (both explicit — the kit never reads another
package's default), REFUSES a tree that conceals a change (below), and surfaces every retry and wave
refusal from the store verbatim.

THE LEDGER a tree-binding verb uses is the CANONICAL one, exactly: <git common dir>/
agent-workflow-delegation.jsonl. A store inside the work tree is measured as part of the change set
it is supposed to be measuring; a store in another repository would measure this tree against a
foreign thread; a SECOND ledger in this git dir would share artifact names with the first, since
those are a function of {backend, nonce} alone. register, observe and aggregate keep the
unrestricted AW_DELEGATION_STORE override — they bind no tree. open additionally refuses pre-spend
when either artifact name for its {backend, nonce} is already taken.

A CONCEALING TREE is refused at every door that measures or binds one (open, return, fold), because
the recorded baseline, the counted bytes and the folded identity are all claims about a tree that is
telling the truth. Two arms: any index entry whose ls-files tag is not "H" refuses on the BIT's
presence — deleting a materialized skip-worktree file is invisible to every probe this kit owns, so
its effect cannot be compared for — and a per-side, BYTE-keyed comparison of the forced against the
plain diff refuses a path an ignore-submodules setting hides. Both name the path; the recovery is
git update-index --no-assume-unchanged / --no-skip-worktree, or clearing the diff config.

return absorbs the wrapper's exec receipt beside the ledger and appends the RETURN record. It reads
the TERMINAL receipt (a RESERVED one is a supervision question, never a timeout), checks the
receipt's independently computed contractDigest, its {backend, nonce}, its capS+killGraceS against
the recorded deadlineS and its timestamp against the ABSOLUTE deadline (the dispatch's timestamp plus
deadlineS), re-verifies the report's digest and length, refuses a change set HIDDEN from the plain
git diff the metric is computed over (assume-unchanged, skip-worktree, ignore-submodules), and then
enumerates the returned objects and frames the canonical integration bundle — bracketed by the tree
fingerprint, so a tree that moves mid-computation refuses instead of mixing two change sets.
--outcome records an orchestrator judgment under the closed override form: a wrapper outcome either
stays itself or moves to ${ORCHESTRATOR_OUTCOMES.join(' | ')}, and "success" is recordable only from
a receipt that already says success. --no-receipt is the recovery lane, and it absorbs a RESERVATION
ONLY — over a TERMINAL artifact it refuses, because a hand-stated outcome there would discard an exit
status, a session id and a report digest the run actually proved. It builds the return from the
reservation (wrapperVersion and posture, never hand-typed) plus the tree, REQUIRES --exit-status and
an --outcome from ${SESSION_ID_NULLABLE_OUTCOMES.join(' | ')}, and reads the report IF PRESENT — an
absent one records length 0 and the metric is then ineligible by name: empty-report where there IS a
diff, and no-op-diff where the tree is unchanged too, since the eligibility rule names the diff
first. With no artifact at all there is no honest return: close the thread with degrade.

fold appends the integration re-confirmation and CLOSES the thread. It runs the same hidden-path
guard as return — a change made behind an index bit leaves the tree digest EQUAL, so the digest alone
cannot catch it — then computes the CURRENT tree digest, which the store binds to the folded return's
postTreeDigest. What that binding IS, exactly: equality of the VISIBLE UNFRAMED PAYLOAD, never an
identity of the tree. The payload is an unframed concatenation, so two different trees can produce
the same bytes (a file's content or a symlink's target can imitate the marker line that opens the
next untracked entry), and it carries no git-relevant mode, so making an untracked file executable
moves nothing. Those residuals belong to a frozen shared surface and are queued, not claimed away
here. Within that domain a tree whose payload moved refuses, and the recovery is a fresh dispatch,
never a fold. Staging usually moves the payload (every change set carrying an untracked path does),
so the fold precedes git add. The one shape staging does NOT move is a tracked-only change passing
into a CLEAN index — the payload concatenates the staged and unstaged diffs, so those bytes are
identical either side of git add. The fold stays honest there (same bytes, same content), which is
why the rule is "fold before staging", not "staging refuses the fold".

degrade appends the recorded no-fold closure, threaded (with --nonce) or PRE-DISPATCH (without). The
pre-dispatch form opens no nonce thread, so aggregate REFUSES the whole wave by name once one is
recorded — stated here because it is a live cost of writing that record.

aggregate reports ONE wave: the registered thresholds, every observation (context, never acceptance),
and per registered step class the delegated threads with the D7 inclusion table applied — a folded
success with an eligible wrapper-git metric contributes its L; a folded success whose metric is
ineligible or self-reported is EXCLUDED from the mean and from n while still counting in the
first-pass rate; a failure-terminal thread, a degrade-closed one, and a folded acceptance-failure
(the fold-fix is the orchestrator paying twice, so its bytes are not leverage) are each in n at
L = 0 and are never a first pass. The first-pass rate is per retry CHAIN — its denominator is the
retryIndex-0 threads — and its threshold comparison is exact. Below the registered
minimum acceptance is NOT computed (insufficient); at or above it is computed and labeled PILOT.
It REFUSES by name, never guesses: a wave with no pre-registration record; a registration that does
not PRECEDE its wave's records; a registration naming a pairing key this aggregator does not
implement; an OPEN thread in scope; a PRE-DISPATCH degrade (nonce null), which opens no thread and so
is neither countable nor ignorable; several waves present with no --wave; and a malformed or
unreadable store.

Step classes (D9): ${STEP_CLASSES.join(' | ')}.
Store: <git common dir>/agent-workflow-delegation.jsonl (AW_DELEGATION_STORE overrides, absolute
only) — separate from the review receipts and the flow store, appended under its own lock.

Exec artifacts (open/return): the wrapper's receipt and report are read from the STORE's own
directory, named agent-workflow-exec-receipt-<backendLength>-<backend>-<nonce>.json and
agent-workflow-exec-report-<backendLength>-<backend>-<nonce>.txt. Honest v1 limits: gate output is
never accounted (the wrapper's exit trap removes its trace, so no gate-output component is emitted);
a change set carrying a BINARY, non-regular or SUBMODULE object is REFUSED, because the shared
payload carries no content for those — a binary by name only, a submodule nothing beyond its first
dirty transition — so their bytes can move under a digest that cannot follow them, and the lane is
fail-closed for them until that frozen payload can carry it. STATED RESIDUALS on what it does accept:
the payload is UNFRAMED, so a file's content or a symlink's target can imitate the marker line that
opens the next untracked entry and two different trees can share one fingerprint, and no
git-relevant MODE is carried, so making an untracked file executable moves nothing — both are queued
against the payload, not claimed away here. A receipt is forgeable exactly like every record here;
and D10 stands as a BAR, not a mechanism — at most one in-tree exec dispatch at a time, and nothing
refuses a second.

Never commits, never runs a subscription CLI, spawns nothing but git READS. Exit codes: 0 success;
1 a refusal (store STOP verbatim, a form violation, an unreadable file, a supervision question); 2
usage.`;

export const main = (argv, ctx = {}) => {
  const env = ctx.env ?? process.env;
  const now = ctx.now ?? (() => new Date().toISOString());
  try {
    // Help is the FIRST argument or nothing: past the verb, `--help` is an ordinary operand or an
    // already-claimed flag value, so `check --help` reads a file by that name rather than turning a
    // write that was asked for into a silent exit 0.
    if (HELP_FLAGS.has(argv[0])) return { code: 0, stdout: HELP, stderr: '' };
    const [verb, ...rest] = argv;
    const baseCwd = ctx.cwd ?? process.cwd();
    if (verb === 'check') return runCheck({ argv: rest, baseCwd });
    if (verb === 'register') return runRegister({ baseCwd, env, argv: rest, now });
    if (verb === 'observe') return runObserve({ baseCwd, env, argv: rest, now });
    if (verb === 'open') return runOpen({ baseCwd, env, argv: rest, now });
    if (verb === 'return') return runReturn({ baseCwd, env, argv: rest, now });
    if (verb === 'fold') return runFold({ baseCwd, env, argv: rest, now });
    if (verb === 'degrade') return runDegrade({ baseCwd, env, argv: rest, now });
    if (verb === 'aggregate') return runAggregate({ baseCwd, env, argv: rest });
    throw usageFail(`unknown verb: ${verb ?? '(none)'} — expected check | register | observe | open | return | fold | degrade | aggregate (see --help)`);
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `dispatch: ${err.message}` };
  }
};

// runCli(argv, io) → the exit code, after writing main()'s streams. EXPORTED so the process-facing
// lane is exercised IN-PROCESS: a spawned child's executed lines never reach the coverage map, so a
// CLI whose only entry is a spawn ships an unmeasured tail.
export const runCli = (argv, io = {}) => {
  const r = main(argv, io.ctx);
  if (r.stdout) (io.stdout ?? process.stdout).write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) (io.stderr ?? process.stderr).write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  return r.code;
};

// isEntryPoint(entry, moduleFile, realpath) — "did the process start THIS module?", decided by REAL
// PATH rather than by comparing URL strings. The kit is reached through managed symlinks (the
// documented Codex skill install links the wrappers onto PATH), and Node reports the entry as the
// symlink while a module knows itself by its real path — so a string comparison makes the CLI exit
// 0 having silently done nothing. An unresolvable side falls back to its lexical resolve, so a
// deleted entry can never make the module claim a process it did not start.
export const isEntryPoint = (entry, moduleFile, realpath = realpathSync) => {
  if (typeof entry !== 'string' || entry === '') return false;
  const real = (p) => { try { return realpath(p); } catch { return resolve(p); } };
  return real(entry) === real(moduleFile);
};

if (isEntryPoint(process.argv[1], fileURLToPath(import.meta.url))) process.exitCode = runCli(process.argv.slice(2));
