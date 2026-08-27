// ack-store.mjs — the family-owned neutral acknowledgement store: its path, its closed lane->key registry,
// the one fact fingerprint and the one guarded reader. Contract: docs/ai/specs/kit/ack-store.md.
// A READ-ONLY leaf (the writer is ack-write.mjs). Dependency-free, Node >= 22; no side effects on import.

import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { assertContainedRealPath } from './fs-safe.mjs';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';

export const ACKS_FILE = 'docs/ai/acks.json';
export const ACKS_LANE_KEY = 'sandboxLaneAck';
export const ACKS_WORKTREES_DIR_KEY = 'worktreesDirAck';
export const ACKS_COVERAGE_DOMAIN_KEY = 'coverageDomainAck';
export const ACKS_SOURCE_SIZE_COPY_KEY = 'sourceSizeCopyAck';
export const ACKS_SPEC_ADOPTION_KEY = 'specAdoptionAck';

// The CLOSED-WORLD ack-lane registry: the lane name an advisor item renders on the writer's command line ->
// the store key that writer sets. A lane the registry does not name is a usage refusal at the writer.
export const ACK_LANES = Object.freeze({
  'sandbox-lane': ACKS_LANE_KEY,
  'worktrees-dir': ACKS_WORKTREES_DIR_KEY,
  'coverage-domain': ACKS_COVERAGE_DOMAIN_KEY,
  'source-size-copy': ACKS_SOURCE_SIZE_COPY_KEY,
  'spec-adoption': ACKS_SPEC_ADOPTION_KEY,
});

export const FINGERPRINT_LENGTH = 16;

// The one fingerprint over an acknowledged FACT (a canonical string the caller composed).
export const factFingerprint = (fact) => createHash('sha256').update(fact).digest('hex').slice(0, FINGERPRINT_LENGTH);

// readAckValue(root, deps, key) -> the recorded string at `key`, or null for the not-yet-acked states
// (an absent file or docs/ai, a non-string value). The path chain is guarded no-follow and the leaf is
// read descriptor-bound (`deps.nofollow` injects that door), so a leaf swapped after the guard cannot
// change the bytes read. A symlinked ancestor/leaf, an escape, a non-regular target, an IO error, a
// malformed or non-object store all THROW (the caller's stated-skip lane).
export const readAckValue = (root, deps = {}, ackKey) => {
  const lstat = deps.lstat ?? lstatSync;
  const absPath = join(root, ACKS_FILE);
  try {
    assertContainedRealPath(root, absPath, { lstat });
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  const read = readRegularFileNoFollow(absPath, deps.nofollow ?? {});
  if (read.outcome === 'absent') return null;
  if (read.outcome === 'foreign') throw new Error(`${ACKS_FILE} is a ${read.className}, not a regular file — refusing to read it`);
  if (read.outcome !== 'ok') throw new Error(`${ACKS_FILE} cannot be read (${read.code})`);
  const parsed = JSON.parse(read.content);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${ACKS_FILE}: expected a JSON object`);
  }
  const value = parsed[ackKey];
  return typeof value === 'string' ? value : null;
};
