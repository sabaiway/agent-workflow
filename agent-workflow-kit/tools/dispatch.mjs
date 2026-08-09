#!/usr/bin/env node
// dispatch.mjs — the delegation ENGINE (delegation Plan 1, Phase 3): the ONE human-facing surface
// over the record vocabulary (dispatch-record.mjs) and the ledger (dispatch-store.mjs). Four verbs:
//
//   check <dispatch-file>  the D8 sub-task contract header, FORM-only, exit 0/1
//   register               the wave's PRE-REGISTRATION record (classes, pairing key, thresholds)
//   observe                one OBSERVATION record (the solo baseline / a self-reported datum)
//   aggregate [--wave]     the L0 deterministic report over ONE wave
//
// Why an engine at all: the funded metric — how much leverage a delegated sub-task actually buys —
// is unmeasurable while nothing records {dispatched → returned → folded}. The store records it; this
// surface is where a number enters the ledger by hand (a registration, an observation) and where the
// recorded threads are read back as a report. Delegated accounting is NEVER hand-appended: an
// `observation` carries only `solo-construction` and `self-reported` provenance, and the delegated
// per-class L is DERIVED here from terminal nonce threads (D7).
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
//
// Writer: appends to the delegation ledger through the store's lock-serialized append (the store's
// preflight is the single legality door — this module adds NO second validator). Never commits,
// never runs a subscription CLI, spawns nothing. Dependency-free, Node >= 22. No side effects on
// import (the isDirectRun idiom).

import { readFileSync, openSync, closeSync, realpathSync, constants as fsConstants } from 'node:fs';
import { resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  DELEGATION_SCHEMA_VERSION, STEP_CLASSES, OBSERVATION_PROVENANCE,
  checkDispatchContractForm, computeNumerator, evaluateObservationEligibility,
} from './dispatch-record.mjs';
import {
  appendDelegationRecord, readDelegationStore, resolveDelegationStorePath, delegationThreadState,
  auditDelegationStoreSemantics,
} from './dispatch-store.mjs';
import { lstatNoFollowRead, describeNonRegular } from './fs-read-nofollow.mjs';
import { gitLine } from './flow-store-read.mjs';
import { lexicalRepoRelative } from './repo-lex.mjs';

const usageFail = (message) => Object.assign(new Error(message), { exitCode: 2 });

// The ONE contract sentence, doc-parity-bound into references/modes/dispatch.md: the FORM-only limit
// and the aggregator's refusals are what a reader must not be able to mis-learn from the mode doc.
export const DISPATCH_CONTRACT = 'the contract check is FORM-only — fields present, grammars respected, never boundedness, design-decidedness or acceptance adequacy — and `aggregate` REFUSES instead of computing acceptance for a wave with no pre-registration record, over an OPEN thread in scope, over a PRE-DISPATCH degrade that opens no thread, or across several waves with no `--wave`';

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
const parseArgs = (argv, flags, repeatable = REPEATABLE_NONE) => {
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
    const value = argv[i + 1];
    if (value === undefined) throw usageFail(`${token} needs a value`);
    if (repeatable.has(token)) (values[token] ??= []).push(value);
    else if (Object.hasOwn(values, token)) throw usageFail(`${token} was given twice — every flag carries exactly one value`);
    else values[token] = value;
    i += 1;
  }
  return { values, operands };
};

// Every verb accepts `--cwd` as an ordinary flag of its own scan — never as a pre-pass.
const scan = (argv, flagFields, baseCwd, repeatable) => {
  const { values, operands } = parseArgs(argv, { ...flagFields, [CWD_FLAG]: 'cwd' }, repeatable);
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
const asNumber = (flag, raw) => {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value)) throw usageFail(`${flag} must be a finite number (got "${raw}")`);
  return value;
};

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
  const { values, operands, cwd } = scan(argv, OBSERVE_FLAG_FIELDS, baseCwd, OBSERVE_REPEATABLE);
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
  const path = resolveDelegationStorePath(cwd, env);
  if (path === null) return { code: 1, stdout: '', stderr: 'dispatch aggregate: not inside a git work tree (and no AW_DELEGATION_STORE override) — there is no delegation store to read' };
  const store = readDelegationStore(path);
  if (store.readError !== undefined) return { code: 1, stdout: '', stderr: `dispatch aggregate: ${path} — ${store.readError}` };
  if (store.malformed > 0) {
    return { code: 1, stdout: '', stderr: `dispatch aggregate: ${path} carries ${store.malformed} malformed line(s) — a dropped line could hide a thread the computation must see (fail closed): ${store.malformedReasons.join('; ')}` };
  }
  // Legality is re-established BEFORE anything is counted, and by the store's own authority: a
  // ledger the append path would have refused is one this computation refuses too, naming the line
  // and quoting the store verbatim. Never a "legal prefix" — a ledger that stops making sense
  // mid-file is unexplained, not shorter.
  const audit = auditDelegationStoreSemantics({ records: store.records, recordLines: store.recordLines, storePath: path });
  if (!audit.ok) {
    return { code: 1, stdout: '', stderr: `dispatch aggregate: ${path} line ${audit.line} carries a record the append path would have REFUSED — ${audit.reason}` };
  }
  const selected = selectWave(store.records, values['--wave']);
  if (!selected.ok) return { code: 1, stdout: '', stderr: `dispatch aggregate: ${selected.reason}` };
  const aggregated = aggregateDelegationWave(store.records, selected.waveId);
  if (!aggregated.ok) return { code: 1, stdout: '', stderr: `dispatch aggregate: ${aggregated.reason}` };
  return { code: 0, stdout: renderAggregate(aggregated.report), stderr: '' };
};

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

const HELP = `dispatch — the delegation engine (agent-workflow family): the sub-task contract check, the
delegation ledger's hand-recorded records, and the L0 acceptance report.

Usage:
  node dispatch.mjs check <dispatch-file> [--cwd <dir>]
  node dispatch.mjs register --wave <id> --step-classes <c[,c...]>
                             --pairing-key ${IMPLEMENTED_PAIRING_KEYS.join('|')}
                             --min-per-class <n> --mean-l-threshold <x>
                             --first-pass-num <n> --first-pass-den <n> [--cwd <dir>]
  node dispatch.mjs observe --wave <id> --step-class <c> --scope <path> [--scope <path>...]
                            --plan <id> --phase <n> --provenance ${OBSERVATION_PROVENANCE.join('|')}
                            [--denominator-bytes <n>] [--cwd <dir>]
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

Never commits, never runs a subscription CLI, spawns nothing. Exit codes: 0 success; 1 a refusal
(store STOP verbatim, a form violation, an unreadable file); 2 usage.`;

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
    if (verb === 'aggregate') return runAggregate({ baseCwd, env, argv: rest });
    throw usageFail(`unknown verb: ${verb ?? '(none)'} — expected check | register | observe | aggregate (see --help)`);
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
