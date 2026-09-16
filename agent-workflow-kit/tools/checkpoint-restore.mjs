// restoreCheckpoint, restoreTaskThread — spec:checkpoint, spec:task-thread; docs/ai/specs/kit/checkpoint/restore.md
import { unlinkSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveTreeObject, snapshotScope, computeBasePayload } from './dispatch-baseline.mjs';
import { readDelegationLedger } from './dispatch-store-read.mjs';
import { isThreadTerminalRecord } from './dispatch-record.mjs';
import { readsTask, readsInsideEpoch, epochClaims } from './task-thread.mjs';
import { hasPathOverlap } from './claim-relation.mjs';
import { CHECKPOINT_REF_PREFIX, withRepository, readGit, readGitBytes, readCheckpointRefs,
  withTemporaryIndex, readScopeStat, writeSnapshot, findOpenCheckpointThread } from './checkpoint-core.mjs';

const REFUSE = 1;
const START = 0;
const NEXT = 1;
const LAST = -1;
const SLASH = '/';
const NUL = '\0';
const UTF8 = 'utf8';
const ROOT = '.';
const FORBIDDEN_SEGMENTS = ['', '.', '..', '.git'];
const ENTRY_PATTERN = /^([0-9]{6}) [^ ]+ [0-9a-f]+\t([\s\S]+)$/;
const SEQUENCE_REF_PATTERN = /^[^/]+\/(?:0|[1-9][0-9]*)$/;
const ALLOWED_MODES = ['100644', '100755', '120000'];
const LEDGER_ABSENT = 'absent';
const LEDGER_OK = 'ok';
const HEAD_ERROR = 'error';
const DISPATCH_KIND = 'dispatch';
const FOLD_KIND = 'fold';
const CHECKPOINT_KIND = 'checkpoint';
const FOLDED = 'folded';
const NONEMPTY_CODES = ['ENOTEMPTY', 'EEXIST'];
const NAMES = { scope: 'target-scope', ledger: 'ledger', open: 'open-thread', conflict: 'type-conflict',
  task: 'task-target', folded: 'task-folded' };
const ENCODING_ERROR = 'target tree paths are not lossless UTF-8';
const ENTRY_ERROR = 'unreadable target tree entry';
const UNREFERENCED_ERROR = 'no checkpoint sequence carries target';
const MISMATCH = 'checkpoint restore mismatch';
const GIT_ARGS = {
  resolve: ['rev-parse', '--verify'],
  entries: ['ls-tree', '-r', '-z'],
  read: ['read-tree'],
  checkout: ['checkout-index', '-a', '-f'],
  checkoutPaths: ['checkout-index', '-f', '--'],
};

const refuse = (reason) => ({ ok: false, code: REFUSE, reason });
const readTargetEntries = (context, target, files = null) => {
  const bytes = readGitBytes(context, [...GIT_ARGS.entries, target]);
  const text = bytes.toString(UTF8);
  if (!Buffer.from(text, UTF8).equals(bytes)) throw new Error(`${NAMES.scope}: ${ENCODING_ERROR}`);
  return text.split(NUL).filter(Boolean).map((entry) => {
    const parsed = ENTRY_PATTERN.exec(entry);
    if (parsed === null) throw new Error(`${NAMES.scope}: ${ENTRY_ERROR}`);
    const [, mode, path] = parsed;
    if (files !== null && !files.includes(path)) return null;
    if (!ALLOWED_MODES.includes(mode) || path.split(SLASH).some((segment) => FORBIDDEN_SEGMENTS.includes(segment))) {
      throw new Error(`${NAMES.scope}: ${path}`);
    }
    return path;
  }).filter((path) => path !== null);
};
const readHeldSet = (context, target) => {
  const refs = readCheckpointRefs(context).filter(({ ref }) => SEQUENCE_REF_PATTERN.test(ref.slice(CHECKPOINT_REF_PREFIX.length)));
  const sequences = new Set(refs.filter(({ oid }) => oid === target).map(({ ref }) => dirname(ref)));
  if (sequences.size === START) throw new Error(`${NAMES.scope}: ${UNREFERENCED_ERROR}: ${target}`);
  return new Set([target, ...refs.filter(({ ref }) => sequences.has(dirname(ref))).map(({ oid }) => oid)]);
};
const checkLedger = (context, held) => {
  const ledger = readDelegationLedger(context.cwd, context.env);
  if (ledger.state !== LEDGER_ABSENT && ledger.state !== LEDGER_OK) return refuse(`${NAMES.ledger}: ${ledger.reason}`);
  const open = findOpenCheckpointThread(ledger.records ?? [], held);
  return open === undefined ? { ok: true } : refuse(`${NAMES.open}: ${open.nonce}`);
};
const listParents = (path) => {
  const parts = path.split(SLASH).slice(START, LAST);
  return parts.map((part, index) => parts.slice(START, index + NEXT).join(SLASH));
};
const checkTypes = (context, paths) => {
  for (const path of paths) {
    for (const parent of listParents(path)) {
      const stat = readScopeStat(context, parent);
      if (stat === null) break;
      if (!stat.isDirectory()) return refuse(`${NAMES.conflict}: ${parent}: ${path}`);
    }
    if (readScopeStat(context, path)?.isDirectory()) return refuse(`${NAMES.conflict}: ${path}`);
  }
  return { ok: true };
};
const removeEmptyParents = (context, path) => {
  const parent = dirname(path);
  if (parent === ROOT) return;
  const stat = readScopeStat(context, parent);
  if (stat === null || !stat.isDirectory()) return;
  try {
    rmdirSync(join(context.top, parent));
  } catch (error) {
    if (!NONEMPTY_CODES.includes(error.code)) throw error;
    return;
  }
  removeEmptyParents(context, parent);
};
const removeExtras = (context, domain, targets) => {
  for (const path of domain) {
    if (targets.has(path) || path.split(SLASH).some((segment) => FORBIDDEN_SEGMENTS.includes(segment))) continue;
    if (!listParents(path).every((parent) => readScopeStat(context, parent)?.isDirectory())) continue;
    const stat = readScopeStat(context, path);
    if (stat === null || !(stat.isFile() || stat.isSymbolicLink())) continue;
    unlinkSync(join(context.top, path));
    removeEmptyParents(context, path);
  }
};

export const restoreCheckpoint = (cwd, oid, io = {}) => withRepository(cwd, io, (context) => {
  const tree = resolveTreeObject(context.top, oid, context.io);
  if (!tree.ok) return refuse(tree.reason);
  const target = readGit(context, [...GIT_ARGS.resolve, oid]);
  const entries = readTargetEntries(context, target);
  const scope = snapshotScope(context.top, { baseTreeOid: target }, context.io);
  if (!scope.ok) return refuse(scope.reason);
  const domain = new Set(scope.paths);
  const outside = entries.find((path) => !domain.has(path));
  if (outside !== undefined) return refuse(`${NAMES.scope}: ${outside}`);
  const held = readHeldSet(context, target);
  const ledger = checkLedger(context, held);
  if (!ledger.ok) return ledger;
  const types = checkTypes(context, entries);
  if (!types.ok) return types;
  withTemporaryIndex(context.env, (env) => {
    readGit(context, [...GIT_ARGS.read, target], env);
    readGit(context, GIT_ARGS.checkout, env);
  });
  removeExtras(context, scope.paths, new Set(entries));
  const snapshot = writeSnapshot(context, target);
  if (!snapshot.ok) return snapshot;
  return snapshot.oid === target ? { ok: true, target, proof: snapshot.oid }
    : refuse(`${MISMATCH}: ${target} ${snapshot.oid}`);
});

export const restoreTaskThread = (cwd, oid, nonce, io = {}) => withRepository(cwd, io, (context) => {
  const tree = resolveTreeObject(context.top, oid, context.io);
  if (!tree.ok) return refuse(tree.reason);
  const target = readGit(context, [...GIT_ARGS.resolve, oid]);
  const ledger = readDelegationLedger(context.cwd, context.env);
  if (ledger.state !== LEDGER_OK) return refuse(`${NAMES.ledger}: ${ledger.reason ?? ledger.state}`);
  if (ledger.head.state === HEAD_ERROR) return refuse(`${NAMES.ledger}: ${ledger.head.reason}`);
  const { records, head } = ledger;
  const index = records.findIndex((record) => record.kind === DISPATCH_KIND && record.nonce === nonce);
  if (index === LAST) return refuse(`${NAMES.task}: ${nonce}`);
  const dispatch = records[index];
  const task = readsTask(dispatch);
  if (task === null) return refuse(`${NAMES.task}: ${nonce}`);
  const later = records.slice(index + NEXT).filter((record) => record.nonce === nonce);
  if (!later.some(isThreadTerminalRecord)) return refuse(`${NAMES.open}: ${nonce}`);
  if (later.some((record) => record.kind === FOLD_KIND)) return refuse(`${NAMES.folded}: ${nonce}`);
  if (dispatch.baseline.treeOid !== target) return refuse(`${NAMES.task}: ${nonce}: ${target}`);
  const scope = snapshotScope(context.top, { baseTreeOid: target }, context.io);
  if (!scope.ok) return refuse(scope.reason);
  const paths = scope.paths.filter((path) => task.files.includes(path));
  const domain = new Set(paths);
  for (const claim of epochClaims(records, head, isThreadTerminalRecord)) {
    if (claim.nonce === nonce || !claim.files.some((file) => paths.some((path) => hasPathOverlap(file, path)))) continue;
    return refuse(`${claim.state === FOLDED ? NAMES.folded : NAMES.open}: ${claim.nonce}`);
  }
  const untasked = records.filter((record) => record.kind !== DISPATCH_KIND || readsTask(record) === null);
  const folded = untasked.find((record, position) => record.kind === DISPATCH_KIND && readsInsideEpoch(record, head)
    && untasked.slice(position + NEXT).some((successor) => successor.nonce === record.nonce && successor.kind === FOLD_KIND));
  if (folded !== undefined) return refuse(`${NAMES.folded}: ${folded.nonce}`);
  const held = readHeldSet(context, target);
  const open = findOpenCheckpointThread(untasked, held);
  if (open !== undefined) return refuse(`${NAMES.open}: ${open.nonce}`);
  const entries = readTargetEntries(context, target, task.files);
  const outside = entries.find((path) => !domain.has(path));
  if (outside !== undefined) return refuse(`${NAMES.scope}: ${outside}`);
  const types = checkTypes(context, entries);
  if (!types.ok) return types;
  withTemporaryIndex(context.env, (env) => {
    readGit(context, [...GIT_ARGS.read, target], env);
    if (entries.length > START) readGit(context, [...GIT_ARGS.checkoutPaths, ...entries], env);
  });
  removeExtras(context, paths, new Set(entries));
  const proof = computeBasePayload(context.top, { kind: CHECKPOINT_KIND, treeOid: target }, context.io, task.files);
  return proof !== null && proof.length === START ? { ok: true, target, nonce } : refuse(MISMATCH);
});
