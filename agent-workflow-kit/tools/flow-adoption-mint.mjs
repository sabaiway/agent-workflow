// flow-adoption-mint.mjs — the adoption mint (#58): the frontmatter planId reader and mintAdoption,
// which binds a plan's chain identity to {frontmatter planId, plan content digest} and lands the
// chain's FIRST record. Split out of flow-store.mjs unchanged (baseline-practices tranche 2); the
// facade re-exports both names.
//
// The plan file is READ, never written. Imports run ONE way: this leaf mints through the store's
// ONE append door (flow-append.mjs) and never reaches the flow-store.mjs facade or its sibling mint
// leaf — the one-line sha256Hex below is a deliberate copy rather than a sideways import.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FLOW_SCHEMA_VERSION, CHAIN_KIND, canonicalFlowDigest } from './flow-record.mjs';
import { resolveBase, computeTreeFingerprint } from './core-evidence.mjs';
import { flowStoreStop, resolveFlowStorePath, readFlowStore, deriveFlowOwner } from './flow-store-read.mjs';
import { appendFlowRecord } from './flow-append.mjs';

const stop = flowStoreStop;
const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

const PLAN_ID_FRONTMATTER_HINT = 'planId: <your-stable-plan-id>';

// Identity binds only a CLOSED leading frontmatter block — an unterminated block never yields an
// id; CRLF is normalized per line so line endings never fork chain identity.
export const readPlanFrontmatterId = (text) => {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  if (lines[0]?.trim() !== '---') return null;
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (close === -1) return null;
  for (const line of lines.slice(1, close)) {
    const m = /^planId:[ \t]*(\S+)[ \t]*$/.exec(line);
    if (m) return m[1];
  }
  return null;
};

export const mintAdoption = ({ cwd = process.cwd(), env = process.env, deps = {}, planPath, planLabel, cycle = 1, commitEpoch = 0, timestamp = new Date().toISOString() } = {}) => {
  const owner = deriveFlowOwner(cwd);
  if (owner == null) throw stop('not inside a git work tree — the adoption mint derives the owning worktree and the tree fingerprint from git (fail closed)');
  let planBytes;
  try {
    planBytes = readFileSync(resolve(cwd, planPath));
  } catch (err) {
    throw stop(`cannot read the plan file ${planPath} (${(err && err.code) || (err && err.message) || err}) — the adoption mint READS an existing plan file (fail closed)`);
  }
  const planId = readPlanFrontmatterId(planBytes.toString('utf8'));
  if (planId == null) {
    throw stop(`the plan file ${planPath} carries no frontmatter planId — plan filenames are never chain identity. Add this line inside a leading "---" frontmatter block:\n${PLAN_ID_FRONTMATTER_HINT}\nand re-run; the plan file is never written by this mint (fail closed)`);
  }
  const planDigest = sha256Hex(planBytes);
  // A pre-append read purely for the NAMED refusal: the locked append would refuse a second
  // adoption anyway, but only this comparison can surface whether the plan content still matches.
  const resolved = resolveFlowStorePath(cwd, env);
  const adopted = resolved == null ? undefined : readFlowStore(resolved).records
    .find((r) => r.kind === CHAIN_KIND && r.purpose === 'adoption' && r.planId === planId);
  if (adopted !== undefined) {
    throw stop(adopted.planDigest === planDigest
      ? `plan "${planId}" is already adopted (content digest unchanged — a rename never resets chain identity); adoption is only ever the chain's first record`
      : `plan "${planId}" is already adopted and the plan file content no longer matches its adoption record (recorded ${adopted.planDigest.slice(0, 12)}…, current ${planDigest.slice(0, 12)}…) — re-adopting edited plan content is refused; the digest mismatch is surfaced, never silent`);
  }
  const fingerprint = computeTreeFingerprint(cwd);
  if (fingerprint == null) throw stop('cannot compute the tree fingerprint — the adoption record binds {base, fingerprint} (fail closed)');
  const record = {
    schema: FLOW_SCHEMA_VERSION, kind: CHAIN_KIND, purpose: 'adoption', planId, cycle, round: 0,
    commitEpoch, owner, base: resolveBase(cwd), timestamp, stepId: null, fingerprint,
    planLabel: planLabel ?? planId, createdAt: timestamp, planDigest,
  };
  const { writtenPath } = appendFlowRecord({ cwd, record, env, deps });
  return { writtenPath, record, digest: canonicalFlowDigest(record) };
};
