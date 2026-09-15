import { hasPathOverlap } from './claim-relation.mjs';

const TASK_BRIEF = /^docs\/plans\/TASK-[^/]+-T[1-9][0-9]*\.md$/u;
const INVALID_SEGMENTS = Object.freeze(['', '.', '..', '.git']);
const HEAD_BASELINE = Object.freeze({ kind: 'head', treeOid: null });

export const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

export const readsTask = (dispatch) => Object.hasOwn(dispatch, 'task')
  ? { brief: dispatch.task.brief, files: [...dispatch.task.files] }
  : null;

export const validateTask = (task, baseKind) => {
  if (typeof task.brief !== 'string' || !TASK_BRIEF.test(task.brief)) {
    return { ok: false, reason: 'task-brief: expected docs/plans/TASK-<stem>-T<n>.md with a positive task number' };
  }
  if (!Array.isArray(task.files) || task.files.length === 0) {
    return { ok: false, reason: 'task-files: expected a non-empty array of paths' };
  }
  for (let index = 0; index < task.files.length; index += 1) {
    const path = task.files[index];
    if (typeof path !== 'string' || path.split('/').some((segment) => INVALID_SEGMENTS.includes(segment))) {
      return { ok: false, reason: 'task-files: expected normalized repo-relative paths without empty, dot or .git segments' };
    }
    if (index > 0 && byteOrder(task.files[index - 1], path) >= 0) {
      return { ok: false, reason: 'task-files: paths must be distinct and in byte order' };
    }
    if (task.files.slice(0, index).some((earlier) => hasPathOverlap(earlier, path))) {
      return { ok: false, reason: 'task-files: one path is a prefix of another' };
    }
  }
  if (baseKind === 'head') {
    return { ok: false, reason: 'task-base: a task requires a checkpoint baseline' };
  }
  return { ok: true };
};

export const readsInsideEpoch = (dispatch, head) => {
  if (head.state === 'unborn') return true;
  const instant = Date.parse(dispatch.timestamp);
  return Number.isFinite(instant) && Math.floor(instant / 1000) > head.seconds;
};

const collectClaims = (records, head, isTerminal) => {
  const claims = [];
  records.forEach((dispatch, index) => {
    if (dispatch.kind !== 'dispatch' || !readsInsideEpoch(dispatch, head)) return;
    const task = readsTask(dispatch);
    if (task === null) return;
    const later = records.slice(index + 1).filter((record) => record.nonce === dispatch.nonce);
    const folded = later.some((record) => record.kind === 'fold');
    if (!folded && later.some(isTerminal)) return;
    // Keep the baseline reader local to preserve the acyclic ledger boundary.
    const baseline = Object.hasOwn(dispatch, 'baseline') ? dispatch.baseline : HEAD_BASELINE;
    claims.push({
      nonce: dispatch.nonce, brief: task.brief, files: task.files,
      state: folded ? 'folded' : 'open', treeOid: baseline.treeOid,
    });
  });
  return claims;
};

export const claimedPaths = (records, treeOid, head, isTerminal) => [...new Set(
  collectClaims(records, head, isTerminal)
    .filter((claim) => claim.treeOid === treeOid)
    .flatMap((claim) => claim.files),
)].sort(byteOrder);

export const epochClaims = (records, head, isTerminal) => collectClaims(records, head, isTerminal)
  .map(({ nonce, brief, files, state }) => ({ nonce, brief, files, state }));
