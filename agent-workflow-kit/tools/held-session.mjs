import { escapeForDisplay, isRenderableLine, shellQuoteArg } from './repo-lex.mjs';
import { wrapperCmdFor } from './detect-backends.mjs';
import { DISPLAY_ALIASES } from './recipes.mjs';

const CODE_STEP = 'code';
const FOLD_KIND = 'fold';
const RETURN_KIND = 'return';
const EXECUTE_BACKEND = 'codex-cli-bridge';
const UNPOPULATED_HELD_ID = '<held id>';

export const HELD_RECEIPT_BACKEND = DISPLAY_ALIASES[EXECUTE_BACKEND];
export const HELD_EXECUTE_WRAPPER = wrapperCmdFor(EXECUTE_BACKEND, 'execute');

const readsInsideEpoch = (dispatch, head) => {
  if (head.state === 'unborn') return true;
  const instant = Date.parse(dispatch.timestamp);
  return Number.isFinite(instant) && Math.floor(instant / 1000) > head.seconds;
};

const updatesThread = (threads, nonce, update) =>
  threads.map((thread) => (thread.nonce === nonce ? { ...thread, ...update } : thread));

const findsDispatch = (dispatches, nonce) => dispatches.find((dispatch) => dispatch.nonce === nonce) ?? null;
const findsReturn = (returns, nonce) => returns.find((returned) => returned.nonce === nonce) ?? null;
const hasCoveredReplacement = (returned, degrades) =>
  degrades.some((degrade) => degrade.fingerprint === returned.postTreeDigest);
const collectsRetryChainNonces = (dispatches, nonce, collected = new Set()) => {
  if (nonce === null || collected.has(nonce)) return collected;
  const next = new Set(collected).add(nonce);
  return collectsRetryChainNonces(dispatches, findsDispatch(dispatches, nonce)?.retryOf ?? null, next);
};

const accumulatesFacts = (degrades) => (state, record) => {
  if (record.kind === 'dispatch' && state.epochNonces.has(record.nonce)) {
    const expectedId = state.heldId;
    return {
      ...state,
      dispatches: [...state.dispatches, record],
      threads: [...state.threads, { nonce: record.nonce, expectedId, actualId: null, status: 'OPEN' }],
      open: record.baselineClean === false ? [...state.open, { nonce: record.nonce, expectedId }] : state.open,
    };
  }
  if (record.kind === RETURN_KIND && state.epochNonces.has(record.nonce)) {
    const dispatch = findsDispatch(state.dispatches, record.nonce);
    if (dispatch === null) return state;
    const expectedId = state.threads.find((thread) => thread.nonce === record.nonce)?.expectedId ?? null;
    const status = record.sessionId === null ? 'FAILED'
      : expectedId === null ? 'FIRST'
      : dispatch.retryOf !== null || record.sessionId === expectedId ? 'CONTINUED'
        : 'SUBSTITUTED';
    const substitution = status === 'SUBSTITUTED' && dispatch.baselineClean === false
      && !hasCoveredReplacement(record, degrades)
      ? {
        nonce: record.nonce, expectedId, actualId: record.sessionId,
        postTreeDigest: record.postTreeDigest, folded: false,
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
    const replaces = returned.sessionId !== state.heldId && hasCoveredReplacement(returned, degrades);
    const retryChain = retries ? collectsRetryChainNonces(state.dispatches, dispatch.retryOf) : new Set();
    const foldedSubstitutions = state.substitutions.map((substitution) =>
      (substitution.nonce === record.nonce ? { ...substitution, folded: true } : substitution));
    const substitutions = retries
      ? foldedSubstitutions.filter((substitution) => !retryChain.has(substitution.nonce))
      : foldedSubstitutions;
    if (establishes || retries || replaces) return { ...state, heldId: returned.sessionId, substitutions };
    return { ...state, substitutions };
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

export const judgeHeldSession = (records, { head, backend, degrades = [] }) => {
  if (head.state === 'error') {
    return { state: 'error', cause: 'head', reason: head.reason, heldId: null, folds: 0, substitution: null, threads: [], open: [] };
  }
  const dispatches = records.filter((record) =>
    record.kind === 'dispatch'
    && record.stepClass === CODE_STEP
    && record.backend === backend
    && readsInsideEpoch(record, head));
  const epochNonces = new Set(dispatches.map((dispatch) => dispatch.nonce));
  const initial = { epochNonces, dispatches: [], returns: [], heldId: null, substitutions: [], threads: [], open: [] };
  const accumulated = records.reduce(accumulatesFacts(degrades), initial);
  return {
    state: 'ok',
    heldId: accumulated.heldId,
    folds: countsHeldFolds(records, epochNonces, accumulated.heldId),
    substitution: accumulated.substitutions[0] ?? null,
    threads: accumulated.threads,
    open: accumulated.open,
  };
};

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
  if (facts.heldId === null) return { code: 0, reason: 'no folded code thread in the commit epoch carries a session yet', line: 'held session: none' };
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

export const foldLaneLines = (facts) => {
  const caveat = describesLaneCaveat(facts);
  const heldId = caveat === null ? shellQuoteArg(facts.heldId) : UNPOPULATED_HELD_ID;
  const lines = [
    'Fold lane (execute = delegated) — a fold rides the delegate\'s HELD session:',
    `  run:  ${HELD_EXECUTE_WRAPPER} --resume ${heldId} --nonce <nonce> <fold-brief>`,
    '  the fold brief is a dispatch file carrying the finding and the accepted fold; dispatch open precedes the run, then dispatch return and fold follow it',
    '  the orchestrator runs the suites, verifies the returned diff, re-mints the red-proofs and owns the commit',
    '  a fresh session is a forbidden substitution; a retry of a failed thread or a recorded execute degrade is the exception; the wrapper sidecar is never read',
  ];
  return caveat === null ? lines : [...lines, `  caveat: ${caveat}`];
};
