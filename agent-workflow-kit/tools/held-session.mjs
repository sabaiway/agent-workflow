import { escapeForDisplay, isRenderableLine, shellQuoteArg } from './repo-lex.mjs';
import { wrapperCmdFor } from './detect-backends.mjs';
import { DISPLAY_ALIASES } from './recipes.mjs';
import { readsBaseline, TERMINAL_RETURN_OUTCOMES } from './dispatch-record.mjs';
import { readsInsideEpoch, readsTask } from './task-thread.mjs';

const CODE_STEP = 'code';
const FOLD_KIND = 'fold';
const RETURN_KIND = 'return';
const DEGRADE_KIND = 'degrade';
const EXECUTE_BACKEND = 'codex-cli-bridge';
const UNPOPULATED_HELD_ID = '<held id>';

export const HELD_RECEIPT_BACKEND = DISPLAY_ALIASES[EXECUTE_BACKEND];
export const HELD_EXECUTE_WRAPPER = wrapperCmdFor(EXECUTE_BACKEND, 'execute');

const updatesThread = (threads, nonce, update) =>
  threads.map((thread) => (thread.nonce === nonce ? { ...thread, ...update } : thread));

const findsDispatch = (dispatches, nonce) => dispatches.find((dispatch) => dispatch.nonce === nonce) ?? null;
const findsReturn = (returns, nonce) => returns.find((returned) => returned.nonce === nonce) ?? null;
const hasCoveredReplacement = (returned, degrades) =>
  degrades.some((degrade) => degrade.fingerprint === returned.postTreeDigest);
const expectsSession = (dispatch, baseKind) => dispatch.baselineClean === false || baseKind === 'checkpoint';
const collectsRetryChainNonces = (dispatches, nonce, collected = new Set()) => {
  if (nonce === null || collected.has(nonce)) return collected;
  const next = new Set(collected).add(nonce);
  return collectsRetryChainNonces(dispatches, findsDispatch(dispatches, nonce)?.retryOf ?? null, next);
};

const accumulatesFacts = (degrades) => (state, record) => {
  if (record.kind === 'dispatch' && state.epochNonces.has(record.nonce)) {
    const expectedId = state.heldId;
    const baseKind = readsBaseline(record).kind;
    return {
      ...state,
      dispatches: [...state.dispatches, record],
      threads: [...state.threads, { nonce: record.nonce, expectedId, actualId: null, status: 'OPEN', baseKind }],
      open: expectsSession(record, baseKind) ? [...state.open, { nonce: record.nonce, expectedId }] : state.open,
    };
  }
  if (record.kind === RETURN_KIND && state.epochNonces.has(record.nonce)) {
    const dispatch = findsDispatch(state.dispatches, record.nonce);
    if (dispatch === null) return state;
    const baseKind = readsBaseline(dispatch).kind;
    const expectedId = state.threads.find((thread) => thread.nonce === record.nonce)?.expectedId ?? null;
    const status = record.sessionId === null ? 'FAILED'
      : expectedId === null ? 'FIRST'
      : dispatch.retryOf !== null || record.sessionId === expectedId ? 'CONTINUED'
        : 'SUBSTITUTED';
    const substitution = status === 'SUBSTITUTED' && expectsSession(dispatch, baseKind)
      && (baseKind === 'checkpoint' ? !TERMINAL_RETURN_OUTCOMES.includes(record.outcome) : !hasCoveredReplacement(record, degrades))
      ? {
        nonce: record.nonce, expectedId, actualId: record.sessionId,
        postTreeDigest: record.postTreeDigest, folded: false, baseKind,
      }
      : null;
    return {
      ...state,
      returns: [...state.returns, record],
      threads: updatesThread(state.threads, record.nonce, { actualId: record.sessionId, status }),
      open: state.open.filter((thread) => thread.nonce !== record.nonce),
      substitutions: substitution === null
        ? state.substitutions
        : [...state.substitutions, substitution],
    };
  }
  if (record.kind === FOLD_KIND && state.epochNonces.has(record.nonce)) {
    const dispatch = findsDispatch(state.dispatches, record.nonce);
    const returned = findsReturn(state.returns, record.nonce);
    if (dispatch === null || returned === null || returned.sessionId === null) return state;
    const establishes = state.heldId === null;
    const retries = dispatch.retryOf !== null;
    const replaces = readsBaseline(dispatch).kind === 'head' && returned.sessionId !== state.heldId && hasCoveredReplacement(returned, degrades);
    const retryChain = retries ? collectsRetryChainNonces(state.dispatches, dispatch.retryOf) : new Set();
    const foldedSubstitutions = state.substitutions.map((substitution) =>
      (substitution.nonce === record.nonce ? { ...substitution, folded: true } : substitution));
    const substitutions = retries
      ? foldedSubstitutions.filter((substitution) => !retryChain.has(substitution.nonce))
      : foldedSubstitutions;
    if (establishes || retries || replaces) return { ...state, heldId: returned.sessionId, substitutions };
    return { ...state, substitutions };
  }
  if (record.kind === DEGRADE_KIND && state.epochNonces.has(record.nonce)
    && state.substitutions.some((substitution) => substitution.nonce === record.nonce && substitution.baseKind === 'checkpoint')) {
    return { ...state, heldId: null, substitutions: state.substitutions.filter((substitution) => substitution.nonce !== record.nonce) };
  }
  return state;
};

const countsHeldFolds = (records, epochNonces, heldId) => {
  if (heldId === null) return 0;
  return records.filter((record) => {
    if (record.kind !== FOLD_KIND || !epochNonces.has(record.nonce)) return false;
    return records.find((candidate) => candidate.kind === RETURN_KIND && candidate.nonce === record.nonce)?.sessionId === heldId;
  }).length;
};

const judgeChain = (records, dispatches, degrades) => {
  const epochNonces = new Set(dispatches.map((dispatch) => dispatch.nonce));
  const initial = { epochNonces, dispatches: [], returns: [], heldId: null, substitutions: [], threads: [], open: [] };
  const accumulated = records.reduce(accumulatesFacts(degrades), initial);
  return {
    state: 'ok',
    heldId: accumulated.heldId,
    folds: countsHeldFolds(records, epochNonces, accumulated.heldId),
    substitution: accumulated.substitutions[0] ?? null,
    threads: accumulated.threads.map((thread) => ({
      ...thread, substituted: accumulated.substitutions.some((substitution) => substitution.nonce === thread.nonce),
    })),
    open: accumulated.open,
  };
};

export const judgeHeldSession = (records, { head, backend, degrades = [] }) => {
  if (head.state === 'error') {
    return { state: 'error', cause: 'head', reason: head.reason, heldId: null, folds: 0, substitution: null, threads: [], open: [] };
  }
  const dispatches = records.filter((record) =>
    record.kind === 'dispatch'
    && record.stepClass === CODE_STEP
    && record.backend === backend
    && readsInsideEpoch(record, head));
  if (!dispatches.some((dispatch) => readsTask(dispatch) !== null)) return judgeChain(records, dispatches, degrades);
  const groups = new Map();
  for (const dispatch of dispatches) {
    const key = readsTask(dispatch)?.brief ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(dispatch);
  }
  const reports = new Map([...groups].map(([key, entries]) => {
    const nonces = new Set(entries.map((dispatch) => dispatch.nonce));
    return [key, judgeChain(records.filter((record) => nonces.has(record.nonce)), entries, degrades)];
  }));
  const untasked = reports.get(null);
  const threads = new Map([...reports].flatMap(([chainKey, report]) =>
    report.threads.map((thread) => [thread.nonce, { ...thread, chainKey }])));
  const substitutions = new Map([...reports.values()]
    .filter((report) => report.substitution !== null)
    .map((report) => [report.substitution.nonce, report.substitution]));
  const firstReturn = records.find((record) => record.kind === RETURN_KIND && substitutions.has(record.nonce));
  return {
    state: 'ok',
    heldId: untasked?.heldId ?? null,
    folds: untasked?.folds ?? 0,
    substitution: firstReturn === undefined ? null : substitutions.get(firstReturn.nonce),
    threads: dispatches.map((dispatch) => threads.get(dispatch.nonce)),
    open: untasked?.open ?? [],
    chains: [...reports].map(([key, { heldId, folds, open }]) => ({ key, heldId, folds, open })),
  };
};

export const threadVerdict = (facts, nonce) => facts.threads.find((thread) => thread.nonce === nonce) ?? null;

export const judgeLedger = (ledger, { backend, degrades = [] }) => {
  if (ledger.state === 'absent') {
    return { state: 'absent', heldId: null, folds: 0, substitution: null, threads: [], open: [] };
  }
  if (ledger.state === 'error') {
    return { state: 'error', cause: 'ledger', reason: ledger.reason, heldId: null, folds: 0, substitution: null, threads: [], open: [] };
  }
  return judgeHeldSession(ledger.records, { head: ledger.head, backend, degrades });
};

export const decideHeldSession = (facts) => {
  if (facts.state === 'absent') {
    const reason = 'no delegation ledger was recorded';
    return { code: 0, reason, line: `held session: none — ${reason}` };
  }
  if (facts.state === 'error') {
    return { code: 1, reason: facts.reason, line: `held session: unavailable — ${facts.reason}` };
  }
  if (facts.substitution !== null) {
    const { nonce, expectedId, actualId } = facts.substitution;
    const reason = `delegated code thread "${nonce}" substituted held session "${escapeForDisplay(expectedId)}" with "${escapeForDisplay(actualId)}"`;
    return { code: 1, reason, line: `held session: SUBSTITUTED — ${reason}` };
  }
  if (facts.chains !== undefined) {
    const entries = facts.chains.map(({ key, heldId, folds }) =>
      `${key === null ? 'untasked' : escapeForDisplay(key)}: ${heldId === null ? 'none' : escapeForDisplay(heldId)} (${folds})`);
    return { code: 0, reason: 'task chains have no unresolved substitution', line: `held sessions: ${facts.chains.length} chain(s) — ${entries.join(' · ')}` };
  }
  if (facts.heldId === null) return { code: 0, reason: 'no held session stands: no folded code thread established one in this commit epoch, or the last one was withdrawn by a checkpoint thread\'s ledger degrade', line: 'held session: none' };
  const heldId = escapeForDisplay(facts.heldId);
  return { code: 0, reason: `held session "${heldId}" is continuous`, line: `held session: ${heldId} — ${facts.folds} fold(s) rode it` };
};

const describesLaneCaveat = (facts) => {
  if (facts.state === 'absent') return decideHeldSession(facts).reason;
  if (facts.state === 'error') return decideHeldSession(facts).reason;
  if (facts.substitution !== null) return decideHeldSession(facts).reason;
  if (facts.heldId === null) return decideHeldSession(facts).reason;
  if (!isRenderableLine(facts.heldId)) return 'the held session id cannot be rendered on one command line';
  return null;
};

const chainLaneLines = (facts, chain) => {
  const substitution = facts.threads.find((thread) => thread.chainKey === chain.key && thread.substituted) ?? null;
  const caveat = describesLaneCaveat({ state: facts.state, heldId: chain.heldId, substitution });
  const task = chain.key === null ? '' : `  (task ${escapeForDisplay(chain.key)})`;
  if (caveat !== null) return [`  caveat: ${caveat}${task}`];
  return [`  run:  ${HELD_EXECUTE_WRAPPER} --resume ${shellQuoteArg(chain.heldId)} --nonce <nonce> <fold-brief>${task}`];
};

export const foldLaneLines = (facts) => {
  const lines = [
    'Fold lane (execute = delegated) — a fold rides the delegate\'s HELD session:',
    '  the fold brief is a dispatch file carrying the finding and the accepted fold; dispatch open precedes the run, then dispatch return and fold follow it',
    '  the orchestrator runs the suites, verifies the returned diff, re-mints the red-proofs and owns the commit',
    '  a fresh session is a forbidden substitution; a retry of a failed thread or, for a head base, a recorded execute degrade is the exception (a checkpoint thread\'s substitution closes by its ledger degrade); the wrapper sidecar is never read',
  ];
  if (facts.chains !== undefined) return [...lines, ...facts.chains.flatMap((chain) => chainLaneLines(facts, chain))];
  const caveat = describesLaneCaveat(facts);
  const heldId = caveat === null ? shellQuoteArg(facts.heldId) : UNPOPULATED_HELD_ID;
  lines.splice(1, 0, `  run:  ${HELD_EXECUTE_WRAPPER} --resume ${heldId} --nonce <nonce> <fold-brief>`);
  return caveat === null ? lines : [...lines, `  caveat: ${caveat}`];
};
