import { join, isAbsolute, normalize, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  validateDelegationRecord, canonicalDelegationDigest, allowedSuccessorKinds,
  isThreadTerminalRecord,
} from './dispatch-record.mjs';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';

export const DELEGATION_STORE_STOP = 'DELEGATION_STORE_STOP';
export const delegationStoreStop = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'DelegationStoreStop', code: DELEGATION_STORE_STOP });
const stop = delegationStoreStop;

export const DELEGATION_STORE_BASENAME = 'agent-workflow-delegation.jsonl';
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

const runGit = (args, cwd, spawn = spawnSync) => spawn('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
const readGitLine = (args, cwd, spawn) => {
  const result = runGit(args, cwd, spawn);
  return result.error || result.status !== 0 ? null : result.stdout.toString('utf8').replace(/\r?\n$/, '');
};

export const resolveDelegationStorePath = (cwd, env = process.env) => {
  if (env.AW_DELEGATION_STORE) {
    if (!isAbsolute(env.AW_DELEGATION_STORE)) {
      throw stop(`AW_DELEGATION_STORE must be an ABSOLUTE path (got "${env.AW_DELEGATION_STORE}") — a relative override resolves a different ledger from each worktree/cwd (fail closed)`);
    }
    const normalized = normalize(env.AW_DELEGATION_STORE);
    if (normalized.endsWith(sep) || normalized.endsWith('/')) {
      throw stop(`AW_DELEGATION_STORE must not end with a path separator (got "${env.AW_DELEGATION_STORE}") — a store is a file, not a directory (fail closed)`);
    }
    return normalized;
  }
  if (readGitLine(['rev-parse', '--is-inside-work-tree'], cwd) !== 'true') return null;
  const commonDir = readGitLine(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return commonDir == null ? null : join(commonDir, DELEGATION_STORE_BASENAME);
};

const parseDelegationLine = (line, index) => {
  if (line.trim() === '') return { empty: true };
  try {
    const record = JSON.parse(line);
    const verdict = validateDelegationRecord(record);
    return verdict.ok
      ? { record, recordLine: index + 1 }
      : { reason: `line ${index + 1}: ${verdict.reason}` };
  } catch {
    return { reason: `line ${index + 1}: invalid JSON` };
  }
};

export const parseDelegationStoreText = (raw) => {
  const parsed = String(raw).split('\n').map(parseDelegationLine);
  const records = parsed.filter((item) => item.record !== undefined).map((item) => item.record);
  const recordLines = parsed.filter((item) => item.recordLine !== undefined).map((item) => item.recordLine);
  const malformedReasons = parsed.filter((item) => item.reason !== undefined).map((item) => item.reason);
  return { records, recordLines, malformed: malformedReasons.length, malformedReasons };
};

const emptyRead = (outcome) => ({ outcome, records: [], recordLines: [], malformed: 0, malformedReasons: [] });

export const readDelegationStore = (path, io = {}) => {
  const read = readRegularFileNoFollow(path, io);
  if (read.outcome === 'absent') return emptyRead('absent');
  if (read.outcome === 'foreign') {
    const reason = `the store is a ${read.className}, not a regular file — refusing to read it (fail closed)`;
    return { ...emptyRead('error'), reason, readError: reason };
  }
  if (read.outcome === 'error') return { ...emptyRead('error'), reason: read.code, readError: read.code };
  const parsed = parseDelegationStoreText(read.content);
  return parsed.malformed > 0
    ? { outcome: 'error', reason: parsed.malformedReasons[0], ...parsed }
    : { outcome: 'ok', ...parsed };
};

const describeGitFailure = (result) => {
  if (result.error) return result.error.code ?? result.error.message;
  const stderr = result.stderr?.toString('utf8').trim() ?? '';
  if (stderr !== '') return stderr;
  if (result.signal) return `signal ${result.signal}`;
  return `exit ${result.status}`;
};

export const readHeadInstant = (cwd, spawn = spawnSync) => {
  const inside = runGit(['rev-parse', '--is-inside-work-tree'], cwd, spawn);
  if (inside.error || inside.status !== 0 || inside.stdout.toString('utf8').trim() !== 'true') {
    return { state: 'error', reason: `cannot resolve the git work tree (${describeGitFailure(inside)})` };
  }
  const head = runGit(['log', '-1', '--format=%ct'], cwd, spawn);
  const raw = head.error || head.status !== 0 ? null : head.stdout.toString('utf8').trim();
  if (raw !== null && /^\d+$/.test(raw)) return { state: 'ok', seconds: Number(raw) };
  const status = runGit(['status', '--porcelain=v2', '--branch', '--untracked-files=no'], cwd, spawn);
  if (!status.error && status.status === 0 && status.stdout.toString('utf8').split(/\r?\n/u).includes('# branch.oid (initial)')) {
    return { state: 'unborn' };
  }
  return { state: 'error', reason: `cannot read HEAD committer time (${describeGitFailure(head)})` };
};

const THREAD_KINDS = ['dispatch', 'return', 'fold', 'degrade'];

export const delegationThreadState = (records, nonce) => {
  const thread = records.filter((record) => THREAD_KINDS.includes(record.kind) && record.nonce === nonce);
  const last = thread.at(-1) ?? null;
  const dispatch = thread.find((record) => record.kind === 'dispatch') ?? null;
  const terminal = last !== null && isThreadTerminalRecord(last);
  return {
    records: thread,
    dispatch,
    return: thread.find((record) => record.kind === 'return') ?? null,
    closure: thread.find((record) => record.kind === 'fold' || record.kind === 'degrade') ?? null,
    last,
    terminal,
    open: dispatch !== null && !terminal,
  };
};

const findRetryChainOrigin = (records, current, seen = new Set([current.nonce])) => {
  if (current.retryOf === null) return current;
  const prior = records.find((record) => record.kind === 'dispatch' && record.nonce === current.retryOf);
  if (prior === undefined || seen.has(prior.nonce)) return current;
  return findRetryChainOrigin(records, prior, new Set([...seen, prior.nonce]));
};

const describeClosure = (last) =>
  last.kind === 'fold' ? 'its fold'
    : last.kind === 'degrade' ? 'its recorded degrade'
      : `a terminal return (outcome "${last.outcome}")`;

const WAVE_SCOPED_KINDS = ['dispatch', 'observation', 'degrade'];

export const delegationSemanticPreflight = ({ records, snapshot, storePath }) => {
  const digest = canonicalDelegationDigest(snapshot);
  if (records.some((record) => canonicalDelegationDigest(record) === digest)) {
    throw stop(`refusing a canonical duplicate: ${storePath} already carries this exact record (${digest.slice(0, 12)}…), however its keys are ordered — a genuine new record carries new content or a new timestamp; nothing was written`);
  }
  const registration = records.find((record) => record.kind === 'pre-registration' && record.waveId === snapshot.waveId);
  if (snapshot.kind === 'pre-registration' && registration !== undefined) {
    throw stop(`refusing a second pre-registration: the wave "${snapshot.waveId}" is already registered and a registration is IMMUTABLE per wave — thresholds a wave was registered under can never move under its own observations; nothing was written`);
  }
  if (WAVE_SCOPED_KINDS.includes(snapshot.kind)) {
    if (registration === undefined) {
      throw stop(`refusing a ${snapshot.kind} that names the UNREGISTERED wave "${snapshot.waveId}" — acceptance is PRE-REGISTERED before the first observation it will count, so the thresholds can never be chosen after the fact; register the wave first; nothing was written`);
    }
    if (!registration.stepClasses.includes(snapshot.stepClass)) {
      throw stop(`refusing a ${snapshot.kind}: step class "${snapshot.stepClass}" is not among the classes wave "${snapshot.waveId}" registered (${registration.stepClasses.join(' | ')}) — the registered set IS the acceptance set; nothing was written`);
    }
  }
  const nonce = typeof snapshot.nonce === 'string' ? snapshot.nonce : null;
  if (nonce === null) return;
  const state = delegationThreadState(records, nonce);
  if (snapshot.kind === 'dispatch') {
    if (state.dispatch !== null) {
      throw stop(`refusing a duplicate dispatch: nonce "${nonce}" already carries a dispatch — a nonce IS the thread identity and is minted once; nothing was written`);
    }
    if (snapshot.retryOf !== null) {
      const prior = delegationThreadState(records, snapshot.retryOf);
      if (prior.dispatch === null) {
        throw stop(`refusing a retry: no dispatch for nonce "${snapshot.retryOf}" is in the store — a retry names the thread it retries; nothing was written`);
      }
      const successor = records.find((record) => record.kind === 'dispatch' && record.retryOf === snapshot.retryOf);
      if (successor !== undefined) {
        throw stop(`refusing a retry: thread "${snapshot.retryOf}" already has the retry successor "${successor.nonce}" — a thread is retried at most ONCE, or the recorded cap would bound only the chain's depth while its branching stayed free; nothing was written`);
      }
      if (!prior.terminal) {
        throw stop(`refusing a retry: thread "${snapshot.retryOf}" is still OPEN — a thread is retried only after it closed (a success or acceptance-failure return stays live until its fold or degrade); nothing was written`);
      }
      if (prior.last.kind === 'fold') {
        throw stop(`refusing a retry: thread "${snapshot.retryOf}" was closed by its fold — folding accepts the attempt into the tree, so a folded thread is never a retry origin whatever its return's outcome was; open a NEW thread instead; nothing was written`);
      }
      if (snapshot.retryIndex !== prior.dispatch.retryIndex + 1) {
        throw stop(`refusing a retry: retryIndex ${snapshot.retryIndex} must be ${prior.dispatch.retryIndex + 1} — a retry increments its origin's index by exactly one, so the chain length is the index; nothing was written`);
      }
      if (snapshot.waveId !== prior.dispatch.waveId) {
        throw stop(`refusing a retry: it names wave "${snapshot.waveId}" but its retry origin "${snapshot.retryOf}" was dispatched in wave "${prior.dispatch.waveId}" — a retry stays in its origin's wave, or one thread would count in two acceptance sets; nothing was written`);
      }
      if (snapshot.stepClass !== prior.dispatch.stepClass) {
        throw stop(`refusing a retry: it declares step class "${snapshot.stepClass}" but its retry origin "${snapshot.retryOf}" was dispatched as "${prior.dispatch.stepClass}" — the pairing key is the step class, so a chain that changes it mid-way would split one attempt's accounting across two classes; nothing was written`);
      }
      const origin = findRetryChainOrigin(records, prior.dispatch);
      if (snapshot.retryIndex > origin.retryCap) {
        throw stop(`refusing a retry: retryIndex ${snapshot.retryIndex} exceeds the retryCap ${origin.retryCap} recorded on the thread's ORIGIN dispatch ("${origin.nonce}") — a fresh contract never manufactures a fresh retry budget; nothing was written`);
      }
      if (prior.return !== null && prior.return.outcome === 'contract-refusal' && snapshot.contractDigest === prior.dispatch.contractDigest) {
        throw stop(`refusing a retry: it retries a contract-refusal thread and must carry a DIFFERENT contractDigest — an unchanged contract would only be refused again, and a retry loop on one contract is exactly what the cap exists to prevent; nothing was written`);
      }
    }
    return;
  }
  if (state.dispatch === null) {
    throw stop(`refusing a ${snapshot.kind}: no dispatch for nonce "${nonce}" is in the store — a thread opens with its dispatch, and a record that binds to nothing is never absorbed; nothing was written`);
  }
  if (snapshot.kind === 'return' && state.return !== null) {
    throw stop(`refusing a second return: nonce "${nonce}" already carries a return (outcome "${state.return.outcome}") — one dispatch answers exactly once, so a stale return never lands; nothing was written`);
  }
  const allowed = allowedSuccessorKinds(state.last);
  if (!allowed.includes(snapshot.kind)) {
    throw stop(state.terminal
      ? `refusing a ${snapshot.kind}: thread "${nonce}" is already closed by ${describeClosure(state.last)} — a closed thread never absorbs another record; nothing was written`
      : `refusing a ${snapshot.kind}: nonce "${nonce}" carries no return to fold — the thread's last record is a ${state.last.kind}, whose only legal successors are ${allowed.join(' | ')}; nothing was written`);
  }
  if (snapshot.kind === 'return') {
    for (const field of ['backend', 'contractDigest', 'preTreeDigest']) {
      if (snapshot[field] !== state.dispatch[field]) {
        throw stop(`refusing a return: ${field} "${snapshot[field]}" does not equal its dispatch's "${state.dispatch[field]}" — a return is bound to the dispatch it answers by nonce AND by identity; nothing was written`);
      }
    }
    if (state.dispatch.baselineClean === false && snapshot.metric.eligible) {
      throw stop(`refusing a return: its dispatch recorded baselineClean:false, so the metric is INELIGIBLE — the uncommitted-state fingerprint is blind to the index↔worktree split, so a dirty baseline cannot attribute bytes to this dispatch (D5); record eligible:false with ineligibleReason "dirty-baseline" (or the stricter reason this return's own fields substantiate); nothing was written`);
    }
    if (state.dispatch.baselineClean !== false && snapshot.metric.ineligibleReason === 'dirty-baseline') {
      throw stop(`refusing a return: it claims ineligibleReason "dirty-baseline" while its dispatch recorded baselineClean:true — the override is unsubstantiated, and only the dispatch decides that fact; nothing was written`);
    }
  }
  if (snapshot.kind === 'degrade') {
    for (const field of ['waveId', 'stepClass']) {
      if (snapshot[field] !== state.dispatch[field]) {
        throw stop(`refusing a degrade: ${field} "${snapshot[field]}" does not equal its dispatch's "${state.dispatch[field]}" — a thread is closed inside the wave and step class it was dispatched in; nothing was written`);
      }
    }
  }
  if (snapshot.kind === 'fold') {
    const target = records.find((record) => canonicalDelegationDigest(record) === snapshot.returnDigest);
    if (target === undefined) {
      throw stop(`refusing a fold: returnDigest ${snapshot.returnDigest.slice(0, 12)}… matches no record in the store — a fold binds an EXISTING return by its canonical digest; nothing was written`);
    }
    if (target.kind !== 'return') {
      throw stop(`refusing a fold: returnDigest resolves to a ${target.kind} record, not a return — a fold folds a return; nothing was written`);
    }
    if (target.nonce !== nonce) {
      throw stop(`refusing a fold: returnDigest resolves to the return of nonce "${target.nonce}", not this fold's "${nonce}" — a fold never reaches across threads; nothing was written`);
    }
    if (snapshot.treeDigestAtFold !== target.postTreeDigest) {
      throw stop(`refusing a fold: treeDigestAtFold ${snapshot.treeDigestAtFold.slice(0, 12)}… does not equal the folded return's postTreeDigest ${target.postTreeDigest.slice(0, 12)}… — the tree moved between the return and the fold, so what was folded is not what was returned; nothing was written`);
    }
  }
};

export const auditDelegationStoreSemantics = ({ records = [], recordLines = [], storePath = '(store)' } = {}) =>
  records.reduce((verdict, record, index) => {
    if (!verdict.ok) return verdict;
    try {
      delegationSemanticPreflight({ records: records.slice(0, index), snapshot: record, storePath });
      return verdict;
    } catch (error) {
      return { ok: false, line: recordLines[index] ?? index + 1, reason: error.message };
    }
  }, { ok: true });

export const readDelegationLedger = (cwd, env, deps = {}) => {
  try {
    const {
      resolveStore = resolveDelegationStorePath,
      readStore = readDelegationStore,
      audit = auditDelegationStoreSemantics,
      readHead = readHeadInstant,
    } = deps;
    const storePath = resolveStore(cwd, env);
    if (storePath === null) return { state: 'error', reason: 'the delegation ledger path is unresolvable (fail closed)' };
    const read = readStore(storePath);
    if (read.outcome === 'absent') return { state: 'absent' };
    if (read.outcome === 'error' || read.readError != null || read.malformed > 0) {
      return { state: 'error', reason: read.reason ?? read.readError ?? read.malformedReasons[0] };
    }
    const audited = audit({ records: read.records, recordLines: read.recordLines, storePath });
    if (!audited.ok) return { state: 'error', reason: `line ${audited.line}: ${audited.reason}` };
    return { state: 'ok', records: read.records, head: readHead(cwd) };
  } catch (error) {
    return { state: 'error', reason: error.message };
  }
};
