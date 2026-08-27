// spec-adoption.mjs — which of the four adoption states the feature-spec store is in, and whether the layer
// was declined. Contract: docs/ai/specs/kit/spec-adoption.md. The census and the per-document read are
// spec-check's own exported seam; this module walks nothing of its own. Read-only, Node >= 22.

import { join } from 'node:path';
import { SPEC_SCHEMA } from '../references/scripts/spec-schema.mjs';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';
import { probe as probePath, realpath as realpathOf, list as listDir } from './spec-check-cli.mjs';
import { walkStore, readClosure } from './spec-check.mjs';
import { ACKS_SPEC_ADOPTION_KEY, factFingerprint, readAckValue } from './ack-store.mjs';

export const ADOPTION = Object.freeze({
  NOT_ADOPTED: 'not-adopted',
  ADOPTING: 'adopting',
  ADOPTED: 'adopted',
  UNREADABLE: 'unreadable',
});
export const ADOPTION_STATES = Object.freeze(Object.values(ADOPTION));

export const STORE_DIR_REL = SPEC_SCHEMA.storePrefix.slice(0, -1);
export const SPEC_ADOPTION_LANE = 'spec-adoption';
export const DECLINE_FACT = `spec-adoption:declined:${SPEC_SCHEMA.storePrefix}`;

const CONTRACT_KIND = 'spec';
const LIVE = 'live';
const DRAFT = 'draft';
const RETIRED = 'retired';

const DEFAULT_IO = Object.freeze({ read: readRegularFileNoFollow, probe: probePath, realpath: realpathOf, list: listDir });

const verdict = (state, counts = { live: 0, draft: 0, retired: 0 }, reason = null) => Object.freeze({ state, ...counts, reason });

// surveySpecAdoption(root, deps) -> { state, live, draft, retired, reason }. `deps.io` overrides the four
// IO primitives (tests); every other answer comes from the store bytes through the one reader.
export const surveySpecAdoption = (root, deps = {}) => {
  const io = { ...DEFAULT_IO, ...(deps.io ?? {}) };
  const dirState = io.probe(join(root, STORE_DIR_REL));
  if (dirState === 'absent') return verdict(ADOPTION.NOT_ADOPTED);
  if (dirState !== 'dir') return verdict(ADOPTION.UNREADABLE, undefined, `${STORE_DIR_REL} is ${dirState === 'file' ? 'a file' : dirState}, not a directory`);
  const rootReal = io.realpath(root);
  if (rootReal === null) return verdict(ADOPTION.UNREADABLE, undefined, 'the project root does not resolve');
  const findings = [];
  const ctx = { io, at: (rel) => (rel === '' ? root : `${root}/${rel}`), rootReal, add: (rule, path, message) => findings.push({ rule, path, message }) };
  const closure = walkStore(ctx).map((path) => ({ path, roles: ['present'] }));
  const docs = findings.length === 0 ? readClosure(closure, ctx) : new Map();
  if (findings.length > 0) return verdict(ADOPTION.UNREADABLE, undefined, `${findings[0].path}: ${findings[0].message}`);
  const counts = { live: 0, draft: 0, retired: 0 };
  for (const doc of docs.values()) {
    if (doc.verdict?.kind !== CONTRACT_KIND) continue;
    if (doc.verdict.status === LIVE) counts.live += 1;
    else if (doc.verdict.status === DRAFT) counts.draft += 1;
    else if (doc.verdict.status === RETIRED) counts.retired += 1;
  }
  return verdict(counts.live > 0 ? ADOPTION.ADOPTED : ADOPTION.ADOPTING, counts);
};

export const declineFingerprint = () => factFingerprint(DECLINE_FACT);

// True when the store's decline is recorded; the guarded reader's refusals propagate to the caller.
export const readDeclineAck = (root, deps = {}) => readAckValue(root, deps, ACKS_SPEC_ADOPTION_KEY) === declineFingerprint();

const plural = (n, noun) => `${n} ${noun}`;

// The one status line body, per state (the caller prefixes its own label).
export const describeAdoption = ({ state, live, draft, reason }, { declined = false } = {}) => {
  const suffix = declined && state !== ADOPTION.ADOPTED ? ' — declined' : '';
  if (state === ADOPTION.NOT_ADOPTED) return `not adopted${suffix}`;
  if (state === ADOPTION.ADOPTING) return `adopting (${plural(draft, 'draft')})${suffix}`;
  if (state === ADOPTION.ADOPTED) return `adopted (${plural(live, 'live')}, ${plural(draft, 'draft')})`;
  return `could not be read — ${reason}`;
};
