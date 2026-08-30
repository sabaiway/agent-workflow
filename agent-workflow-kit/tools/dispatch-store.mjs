// dispatch-store.mjs - the delegation-ledger public facade and append lane.
// The read half lives in dispatch-store-read.mjs so read-only consumers never reach this writer.

import { computeTreeFingerprint } from './core-evidence.mjs';
import { validateDelegationRecord } from './dispatch-record.mjs';
import {
  delegationStoreStop,
  resolveDelegationStorePath,
  parseDelegationStoreText,
  delegationSemanticPreflight,
} from './dispatch-store-read.mjs';
import { createStoreAppendLane } from './store-append.mjs';

export {
  DELEGATION_STORE_STOP,
  delegationStoreStop,
  DELEGATION_STORE_BASENAME,
  resolveDelegationStorePath,
  parseDelegationStoreText,
  readDelegationStore,
  readHeadInstant,
  delegationThreadState,
  auditDelegationStoreSemantics,
} from './dispatch-store-read.mjs';

const stop = delegationStoreStop;

export const DELEGATION_LOCK_SUFFIX = '.lock';
export const resolveDelegationLockPath = (storePath) => `${storePath}${DELEGATION_LOCK_SUFFIX}`;

export const UNCOMMITTED_STATE_FINGERPRINT = 'the uncommitted-state fingerprint';

export const uncommittedStateFingerprint = (cwd = process.cwd(), fsx) => {
  const fingerprint = computeTreeFingerprint(cwd, fsx);
  if (fingerprint == null) {
    throw stop(`cannot compute ${UNCOMMITTED_STATE_FINGERPRINT} — not inside a git work tree (or a git probe failed); a record never carries a null tree digest (fail closed)`);
  }
  return fingerprint;
};

const delegationAppendLane = createStoreAppendLane({
  nouns: { store: 'delegation store', adj: 'delegation-store', record: 'delegation record' },
  envNames: { store: 'AW_DELEGATION_STORE', waitKnob: 'AW_DELEGATION_LOCK_WAIT_MS', pollKnob: 'AW_DELEGATION_LOCK_POLL_MS' },
  stop,
  resolveStorePath: resolveDelegationStorePath,
  resolveLockPath: resolveDelegationLockPath,
  validateRecord: validateDelegationRecord,
  parseStoreText: parseDelegationStoreText,
});

export const appendDelegationRecord = ({ cwd = process.cwd(), record, env = process.env, deps = {} } = {}) => {
  const { line, snapshot } = delegationAppendLane.captureRecordSnapshot(record);
  return delegationAppendLane.appendResolvedRecord({
    cwd, env, deps, preflight: delegationSemanticPreflight, makeRecord: () => ({ line, snapshot }),
  });
};
