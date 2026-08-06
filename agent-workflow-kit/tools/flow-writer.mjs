#!/usr/bin/env node
// flow-writer.mjs — the flow-store writer CLI (flow-orchestration, Plan 3 Step 3.2 + Plan 4
// Phase 3). The explicit arm set is Decision 8: park / resume / complete / adoption / refresh /
// re-baseline / rerun-cause / down-mark / down-mark-up / down-mark-clear / degrade-justification /
// maintainer-override / consult-attestation / round-open / round-land / freeze / unfreeze /
// converged / internal-attestation — EVERY record class a flow refusal names as its recovery has a
// pasteable mint arm here, so an armed chain can never become unrecoverably red.
// The consult-attestation arm (Phase 4.2, Decision 8) binds {backend,
// nonce, findingDigest} FROM the wrapper-minted finding manifest — the digest is computed over the
// manifest's findings payload, never hand-supplied — while proposedFixDigest stays the EXPLICIT
// consult-time input (the digest of the proposed-fix payload the orchestrator submits).
//
// The round machinery (Plan 4 Phase 3, Decision 3 — writer arms only): ONE round record per
// round, REVISED under the round-ledger revision contract — `round-open` mints it (per-dispatch
// watermark + nonce, minted BEFORE any backend runs, #41), `round-land` revises it (receipt +
// manifest digests COMPUTED from the files beside the receipts store, never hand-supplied, plus
// the per-finding disposition ledger, #42/#13/#33). A fingerprint move never rides a revision —
// it always opens a NEW round (the revision contract keeps round.fingerprint immutable). Design
// caps are ENFORCED AT THESE ARMS, not at the store (the transition table allows the records):
// ROUND_HARD_MAX rounds per {cycle, stepId}, UNFREEZE_CAP post-freeze unfreezes per cycle, and no
// premature terminal (freeze/converged refuse over an unlanded-undegraded dispatch or a delivered
// non-ship receipt with an empty disposition ledger). Per Decision 8 every cap refusal is
// SELF-SERVABLE: the over-cap mint requires an explicit non-empty --justification INPUT — the
// chain shapes are closed (no justification field), so the durable trail is the over-cap record
// ITSELF (a round past the cap / a second unfreeze is structurally visible in the store) plus the
// echoed writer report the phase's commit ask quotes; the waste bound is the CAP, never the prose.
//
// Every arm computes its tree context (owner, base, fingerprint; cycle/round/commitEpoch from the
// chain walk) and appends through appendFlowRecord — the store's semantic preflight is the SINGLE
// legality door; this writer adds NO second validator, and an illegal transition surfaces the
// store's own refusal verbatim (#59). Chain arms refuse a FOREIGN worktree's chain by name (#57).
//
// write-plan-id adds the frontmatter planId line to a plan file, bound tight: the target must be
// an EXISTING regular file under docs/plans/ (lexically repo-relative, never a symlink), the
// write is contained-atomic, a file already carrying the SAME planId is an idempotent no-op, and
// a DIFFERENT existing planId refuses — chain identity never silently changes (#58). The adoption
// MINT itself stays read-only over the plan file.
//
// maintainer-override prints the FULL bound set it is about to record and requires the explicit
// --checkpoint-approved flag (#38) — without the flag the bound set still prints and nothing is
// written.
//
// Output is ENGLISH/structured (repo-artifact Hard Constraint); the agent localizes when
// narrating. Exit codes: 0 success (incl. the write-plan-id idempotent no-op); 2 usage; 1 refusal
// (a store STOP verbatim, a derivation failure, or the missing checkpoint flag). main(argv, ctx)
// → { code, stdout, stderr }; cwd / env / now are injectable. Dependency-free, Node >= 22. No
// side effects on import (the isDirectRun idiom).

import { readFileSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import {
  FLOW_SCHEMA_VERSION, CHAIN_KIND, canonicalFlowDigest, flowTreeIdentity,
  SAFE_NONCE_RE, findingManifestBasename, decodeFindingManifest,
} from './flow-record.mjs';
import {
  FLOW_STORE_STOP, resolveFlowStorePath, readFlowStore, deriveFlowOwner, walkChainState,
  appendFlowRecord, appendFlowRecordWithPreflight, mintAdoption, readPlanFrontmatterId,
  resolveRecordReference, priorChainTerminal,
} from './flow-store.mjs';
import { readFileBytesNoFollow, gitLine } from './flow-store-read.mjs';
import {
  resolveBase, computeTreeFingerprint, lexicalRepoRelative,
  resolveReceiptsPath, readReceipts, summarizeReviewReceiptsForTree,
  resolveEvidencePath, readEvidence, authoritativeOfKind,
  isRecognizedVerdict, isShipVerdict,
  REVIEW_RECEIPT_CLASS, classifyReviewReceiptForTree,
} from './core-evidence.mjs';
import { classifyDeltaChain, deltaCustodyIssue } from './flow-check.mjs';
import { loadConfig } from './orchestration-config.mjs';
import { computePlanAdoptionCoverage, plansInFlight, quoteReportName } from './review-state.mjs';
import { writeContainedFileAtomic, lstatNoFollow } from './atomic-write.mjs';

const usageFail = (message) => Object.assign(new Error(message), { exitCode: 2 });
const refuse = (message) => Object.assign(new Error(message), { exitCode: 1 });

const PLANS_DIR = 'docs/plans';
const HEX64_RE = /^[0-9a-f]{64}$/;

// ── shared derivation (reads only; legality stays the store preflight's) ────────────

const treeContext = (cwd) => {
  const owner = deriveFlowOwner(cwd);
  if (owner == null) throw refuse('not inside a git work tree — the writer derives owner/base/fingerprint from git (fail closed)');
  const fingerprint = computeTreeFingerprint(cwd);
  if (fingerprint == null) throw refuse('cannot compute the tree fingerprint — every flow record binds tree identity (fail closed)');
  return { owner, base: resolveBase(cwd), fingerprint };
};

const readStoreRecords = (cwd, env) => {
  const path = resolveFlowStorePath(cwd, env);
  if (path == null) throw refuse('not inside a git work tree (and no AW_FLOW_STORE override) — there is no flow store');
  const read = readFlowStore(path);
  if (read.readError) throw refuse(`the flow store is unreadable (${read.readError}) — fail closed`);
  if (read.malformed > 0) throw refuse(`the flow store carries ${read.malformed} malformed line(s) (${read.malformedReasons[0]}) — fail closed`);
  return read.records;
};

// The invoking worktree may only move its OWN chains (#57) — a foreign chain stays that
// worktree's business (the checker already treats it as advisory-only there).
const chainContext = (records, planId, owner) => {
  const chain = records.filter((r) => r.kind === CHAIN_KIND && r.planId === planId);
  if (chain.length === 0) {
    throw refuse(`plan "${planId}" has no chain in the flow store — adoption is a chain's first record (flow-writer adoption <plan-file>)`);
  }
  if (chain[0].owner !== owner) {
    throw refuse(`plan "${planId}"'s chain is owned by "${chain[0].owner}" (a foreign worktree) — chain records are minted from their own worktree only (#57)`);
  }
  return { chain, state: walkChainState(chain), commitEpoch: chain.reduce((m, r) => Math.max(m, r.commitEpoch), 0) };
};

const chainCommons = ({ planId, tree, state, commitEpoch, timestamp }) => ({
  schema: FLOW_SCHEMA_VERSION, kind: CHAIN_KIND, planId,
  cycle: state.cycle, round: state.round, commitEpoch,
  owner: tree.owner, base: tree.base, timestamp,
});

const activeDownMark = (records, backend) => {
  let active = null;
  for (const r of records) {
    if (r.kind === 'down-mark' && r.backend === backend) active = r;
    else if ((r.kind === 'down-mark-up' || r.kind === 'down-mark-clear') && r.backend === backend) active = null;
  }
  return active;
};

const overrideHeadDigest = (records, vetoReceiptDigest) => {
  let head = null;
  for (const r of records) {
    if (r.kind === 'maintainer-override' && r.vetoReceiptDigest === vetoReceiptDigest) head = r;
  }
  return head === null ? null : canonicalFlowDigest(head);
};

// ── flag parsing ────────────────────────────────────────────────────────────────────

// parseFlags(rest, spec) → { values, positionals }. spec: { '--flag': 'value' | 'boolean' | 'list' }
// — a 'list' flag repeats and collects an array (in argv order); the scalar kinds refuse a repeat.
// A literal `--` terminates flag parsing (every later token is a positional — the lane a
// leading-dash operand rides), and a value flag accepts the inline `--flag=value` form (the lane
// a leading-dash VALUE rides) — the checker's printed recoveries compose exactly these shapes.
const parseFlags = (rest, spec) => {
  const values = {};
  const positionals = [];
  let terminated = false;
  const set = (flag, value) => {
    const key = flag.slice(2);
    if (spec[flag] === 'list') {
      (values[key] ??= []).push(value);
      return;
    }
    if (values[key] !== undefined) throw usageFail(`duplicate flag: ${flag}`);
    values[key] = value;
  };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (terminated || !a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    if (a === '--') {
      terminated = true;
      continue;
    }
    const eq = a.indexOf('=');
    if (eq !== -1) {
      const flag = a.slice(0, eq);
      if (spec[flag] !== 'value' && spec[flag] !== 'list') throw usageFail(spec[flag] === 'boolean' ? `${flag} takes no value` : `unknown flag: ${flag}`);
      set(flag, a.slice(eq + 1));
      continue;
    }
    const kind = spec[a];
    if (kind === undefined) throw usageFail(`unknown flag: ${a}`);
    if (kind === 'boolean') set(a, true);
    else {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('--')) throw usageFail(`${a} requires a value (or use ${a}=<value>)`);
      set(a, v);
      i += 1;
    }
  }
  return { values, positionals };
};

const onePlanId = (positionals, arm) => {
  if (positionals.length !== 1) throw usageFail(`${arm} takes exactly one <planId> (got ${positionals.length})`);
  return positionals[0];
};

const requireValue = (values, flag, arm) => {
  const v = values[flag];
  if (v === undefined) throw usageFail(`${arm} requires --${flag}`);
  return v;
};

const requireDigest = (raw, flag) => {
  if (!HEX64_RE.test(raw)) throw usageFail(`--${flag} must be a 64-hex per-record canonical digest (got "${raw}")`);
  return raw;
};

// ── the arms ────────────────────────────────────────────────────────────────────────

const buildPlanLaneRecord = ({ purpose, planId, cwd, env, timestamp }) => {
  const tree = treeContext(cwd);
  const { state, commitEpoch } = chainContext(readStoreRecords(cwd, env), planId, tree.owner);
  return { ...chainCommons({ planId, tree, state, commitEpoch, timestamp }), purpose, stepId: null, fingerprint: tree.fingerprint };
};

const buildRefreshRecord = ({ planId, cause, refreshedRecord, cwd, env, timestamp }) => {
  const tree = treeContext(cwd);
  const records = readStoreRecords(cwd, env);
  const { state, commitEpoch } = chainContext(records, planId, tree.owner);
  if (state.stepId == null) throw refuse(`plan "${planId}" has no open step — a refresh is a within-step re-attestation; open the step's round first`);
  const target = resolveRecordReference(records, refreshedRecord);
  if (target === undefined) throw refuse(`no record in the flow store digests to ${refreshedRecord.slice(0, 12)}… — a re-attestation binds an existing record`);
  return {
    ...chainCommons({ planId, tree, state, commitEpoch, timestamp }), purpose: 'refresh', stepId: state.stepId,
    fingerprintBefore: flowTreeIdentity(target).fingerprint, fingerprintAfter: tree.fingerprint, cause, refreshedRecord,
  };
};

const buildReBaselineRecord = ({ planId, cwd, env, timestamp }) => {
  const tree = treeContext(cwd);
  const records = readStoreRecords(cwd, env);
  const { chain, state, commitEpoch } = chainContext(records, planId, tree.owner);
  const recorded = chain[chain.length - 1].base;
  if (recorded == null) throw refuse(`plan "${planId}"'s recorded base is null (an unborn branch) — base motion from an unborn branch is not expressible as a re-baseline`);
  const stepId = state.mode === 'in-step' ? state.stepId
    : state.lastTerminal != null && state.lastTerminal.purpose !== 'adoption' ? state.lastTerminal.stepId
    : null;
  return { ...chainCommons({ planId, tree, state, commitEpoch, timestamp }), purpose: 're-baseline', stepId, fingerprint: tree.fingerprint, baseBefore: recorded };
};

const buildDownMarkFamilyRecord = ({ kind, backend, target, cwd, env, timestamp }) => {
  const tree = treeContext(cwd);
  const resolved = target ?? (() => {
    const active = activeDownMark(readStoreRecords(cwd, env), backend);
    if (active === null) throw refuse(`no ACTIVE down-mark for backend "${backend}" — up/clear supersede the backend's active mark; pass --target to name one explicitly`);
    return canonicalFlowDigest(active);
  })();
  return { schema: FLOW_SCHEMA_VERSION, kind, fingerprint: tree.fingerprint, backend, target: resolved, base: tree.base, timestamp };
};

// The justification's mark must be USABLE at mint time, whichever lane named it: it resolves to a
// down-mark of THIS backend, is not closed by a later up/clear, and its TTL window contains the
// new record's instant — a justification outside any of these can never satisfy the checker
// (#25/#39), so minting it would only strand a dead record in the append-only store.
const resolveUsableDownMark = ({ records, backend, explicit, timestamp }) => {
  const mark = explicit === undefined
    ? activeDownMark(records, backend)
    : records.findLast((r) => canonicalFlowDigest(r) === explicit) ?? null;
  if (mark === null) {
    throw refuse(explicit === undefined
      ? `no ACTIVE down-mark for backend "${backend}" — a justification rides a then-active mark (#25); mint the down-mark first`
      : `no record in the flow store digests to ${explicit.slice(0, 12)}… — a justification binds an existing down-mark (#25)`);
  }
  if (mark.kind !== 'down-mark' || mark.backend !== backend) {
    throw refuse(`the --down-mark digest resolves to a ${mark.kind} of backend "${mark.backend}" — a justification rides a down-mark of backend "${backend}" (#25)`);
  }
  const digest = canonicalFlowDigest(mark);
  const at = records.indexOf(mark);
  if (records.some((r, i) => i > at && (r.kind === 'down-mark-up' || r.kind === 'down-mark-clear') && r.target === digest)) {
    throw refuse(`the down-mark for backend "${backend}" is already closed by up/clear — a closed mark justifies nothing (#25)`);
  }
  if (!(Date.parse(timestamp) >= Date.parse(mark.timestamp) && Date.parse(timestamp) < Date.parse(mark.expiresAt))) {
    throw refuse(`the down-mark for backend "${backend}" is outside its active window at mint time (expires ${mark.expiresAt}) — close it (down-mark-clear) and mint a fresh mark; a justification outside the window can never satisfy (#25/#39)`);
  }
  return digest;
};

const buildDegradeJustificationRecord = ({ backend, downMark, degradeDigest, cwd, env, timestamp }) => {
  const tree = treeContext(cwd);
  const records = readStoreRecords(cwd, env);
  const mark = resolveUsableDownMark({ records, backend, explicit: downMark, timestamp });
  // The core store is ALWAYS read fail-closed and the authoritative degrade resolved — an
  // explicit --degrade-digest only VERIFIES that resolution (the --veto-receipt rule): an unknown
  // or foreign digest would mint a justification that can never close the refusal.
  const corePath = resolveEvidencePath(cwd, env);
  const coreRead = corePath == null ? { records: [] } : readEvidence(corePath);
  if (coreRead.readError || (coreRead.malformed ?? 0) > 0) {
    throw refuse(`the core evidence store is unreadable or malformed (${coreRead.readError ?? coreRead.malformedReasons[0]}) — cannot resolve the degrade record (fail closed)`);
  }
  const candidates = authoritativeOfKind(coreRead.records, 'degrade').filter((r) => r.backend === backend && r.fingerprint === tree.fingerprint);
  if (candidates.length === 0) {
    throw refuse(`no core degrade record for backend "${backend}" at the current tree — mint it first (core-evidence degrade), then justify it here`);
  }
  const degrade = canonicalFlowDigest(candidates[candidates.length - 1]);
  if (degradeDigest !== undefined && degradeDigest !== degrade) {
    throw refuse(`--degrade-digest ${degradeDigest.slice(0, 12)}… is not the authoritative core degrade of backend "${backend}" at the current tree (${degrade.slice(0, 12)}…) — a foreign digest never mints (#25)`);
  }
  return { schema: FLOW_SCHEMA_VERSION, kind: 'degrade-justification', fingerprint: tree.fingerprint, downMark: mark, degradeDigest: degrade, base: tree.base, timestamp };
};

const buildOverride = ({ planId, backend, vetoReceipt, chainRecord, cwd, env, timestamp }) => {
  const tree = treeContext(cwd);
  const records = readStoreRecords(cwd, env);
  const { chain } = chainContext(records, planId, tree.owner);
  // ONE resolution point: the backend's authoritative CURRENT-tree receipt. An explicit
  // --veto-receipt only VERIFIES it (an old, foreign-backend, or foreign-tree receipt never
  // mints), and only the recognized NEGATIVE class is overridable — decideCheck consults
  // overrides for exactly that class (#48/#56; unrecognized verdicts are never overridable).
  const receiptsPath = resolveReceiptsPath(cwd, env);
  const receiptsRead = receiptsPath == null ? { receipts: [], malformed: 0 } : readReceipts(receiptsPath);
  if (receiptsRead.readError) {
    throw refuse(`the receipts store is unreadable (${receiptsRead.readError}) — an override never binds a partially read store (fail closed)`);
  }
  if (receiptsRead.malformed > 0) {
    throw refuse(`the receipts store carries ${receiptsRead.malformed} malformed line(s) — an override never binds a partially read store (fail closed)`);
  }
  const receipts = receiptsRead.receipts;
  const current = summarizeReviewReceiptsForTree(receipts.filter((r) => r.backend === backend), tree.fingerprint);
  if (current.state !== 'current' || current.receipt == null) {
    throw refuse(`no current-tree review receipt of backend "${backend}" to override — the bound set pins the vetoing receipt's own tree (#56)`);
  }
  const vetoDigest = canonicalFlowDigest(current.receipt);
  if (vetoReceipt !== undefined && vetoReceipt !== vetoDigest) {
    throw refuse(`--veto-receipt ${vetoReceipt.slice(0, 12)}… is not the backend's authoritative CURRENT-tree receipt (${vetoDigest.slice(0, 12)}…) — an old, foreign-backend, or foreign-tree receipt never mints an override (#56)`);
  }
  const verdict = current.receipt.verdict;
  if (!(isRecognizedVerdict(verdict) && !isShipVerdict(verdict))) {
    throw refuse(`the current receipt verdict ${JSON.stringify(verdict)} of backend "${backend}" is not a recognized NEGATIVE — only the overridable veto class mints an override (#48/#56; unrecognized verdicts are never overridable)`);
  }
  if (chainRecord !== undefined && !chain.some((r) => canonicalFlowDigest(r) === chainRecord)) {
    throw refuse(`--chain-record ${chainRecord.slice(0, 12)}… does not resolve to a record of plan "${planId}"'s chain — an override never binds a foreign plan's chain from this arm (#56)`);
  }
  const record = {
    schema: FLOW_SCHEMA_VERSION, kind: 'maintainer-override', fingerprint: tree.fingerprint,
    vetoReceiptDigest: vetoDigest, backend, verdict,
    chainRecord: chainRecord ?? canonicalFlowDigest(chain[chain.length - 1]),
    supersedes: overrideHeadDigest(records, vetoDigest), base: tree.base, timestamp,
  };
  const boundSet = [
    'maintainer-override — the FULL bound set about to be recorded (#38/#56):',
    `  vetoReceiptDigest: ${record.vetoReceiptDigest}`,
    `  backend: ${record.backend}`,
    `  verdict: ${JSON.stringify(record.verdict)}`,
    `  base: ${record.base}`,
    `  fingerprint: ${record.fingerprint}`,
    `  chainRecord: ${record.chainRecord}`,
    `  supersedes: ${record.supersedes ?? 'null (the first override of this veto instance)'}`,
  ];
  return { record, boundSet };
};

// The ONE {backend, nonce}-named manifest resolver the manifest-consuming arms share
// (consult-attestation, round-land): compose the containment-checked name, read it through the
// kit's race-free no-follow reader (a binding never rides a link, a FIFO can never block the
// mint, a foreign node refuses by class — the wrapper mints regular files only), decode
// fail-closed, and verify the declared identity — each arm maps the typed outcome to its own
// refusal wording.
const readManifestDecoded = ({ receiptsPath, backend, nonce }) => {
  const basename = findingManifestBasename(backend, nonce);
  if (basename == null) return { outcome: 'unsafe' };
  const path = join(dirname(receiptsPath), basename);
  const read = readFileBytesNoFollow(path);
  if (read.outcome === 'absent') return { outcome: 'absent', path };
  if (read.outcome === 'foreign') return { outcome: 'foreign', path, className: read.className };
  if (read.outcome !== 'ok') return { outcome: 'error', path, code: read.code };
  const decoded = decodeFindingManifest(read.bytes);
  if (!decoded.ok) return { outcome: 'malformed', path, reason: decoded.reason };
  if (decoded.manifest.backend !== backend || decoded.manifest.nonce !== nonce) {
    return { outcome: 'foreign-identity', path, manifest: decoded.manifest };
  }
  return { outcome: 'ok', path, bytes: read.bytes, manifest: decoded.manifest };
};

const requireReceiptsPath = (cwd, env, why) => {
  const receiptsPath = resolveReceiptsPath(cwd, env);
  if (receiptsPath == null) throw refuse(`the receipts path is unresolvable (no git dir and no AW_REVIEW_RECEIPTS) — ${why} (fail closed)`);
  return receiptsPath;
};

// The consult-attestation arm reads the {backend, nonce}-named finding manifest beside the
// receipts file fail-closed: findingDigest is COMPUTED from the manifest's findings payload
// (form-provable binding — a hand-supplied digest could name findings nobody delivered), and the
// record binds the open step's {cycle, stepId, round} from the chain walk.
const buildConsultAttestation = ({ planId, backend, nonce, proposedFixDigest, cwd, env, timestamp }) => {
  if (!SAFE_NONCE_RE.test(nonce)) throw usageFail(`--nonce must satisfy the safe nonce grammar ([A-Za-z0-9._-]{1,64}) — got ${JSON.stringify(nonce)}`);
  const tree = treeContext(cwd);
  const records = readStoreRecords(cwd, env);
  const { state } = chainContext(records, planId, tree.owner);
  if (state.stepId == null) throw refuse(`plan "${planId}" has no open step — a consult-attestation binds an open step's round; open the step's round first`);
  const receiptsPath = requireReceiptsPath(cwd, env, 'the finding manifest lives beside the receipts file');
  const m = readManifestDecoded({ receiptsPath, backend, nonce });
  if (m.outcome === 'unsafe') {
    throw refuse(`no manifest name composes for {backend ${JSON.stringify(backend)}, nonce ${JSON.stringify(nonce)}} under the safe grammar — an unsafe token never resolves a manifest (fail closed)`);
  }
  if (m.outcome === 'absent') {
    throw refuse(`no readable finding manifest for {backend "${backend}", nonce "${nonce}"} at ${m.path} (ENOENT) — the wrapper mints it on a nonce-supplied dispatch; a consult binds a real manifest (fail closed)`);
  }
  if (m.outcome === 'foreign') {
    throw refuse(`the finding manifest at ${m.path} is a ${m.className}, not a regular file — an attestation never binds through a symlink or a FIFO (fail closed)`);
  }
  if (m.outcome === 'error') {
    throw refuse(`the finding manifest at ${m.path} is unreadable (${m.code}) — fail closed`);
  }
  if (m.outcome === 'malformed') throw refuse(`the finding manifest at ${m.path} is malformed — ${m.reason} — it never mints a consult-attestation`);
  if (m.outcome === 'foreign-identity') {
    throw refuse(`the finding manifest at ${m.path} declares {backend "${m.manifest.backend}", nonce "${m.manifest.nonce}"} — a foreign-identity manifest never mints a consult-attestation (fail closed)`);
  }
  return {
    schema: FLOW_SCHEMA_VERSION, kind: 'consult-attestation', fingerprint: tree.fingerprint,
    backend, nonce, planId, cycle: state.cycle, stepId: state.stepId, round: state.round,
    findingDigest: createHash('sha256').update(m.manifest.findings, 'utf8').digest('hex'),
    proposedFixDigest, base: tree.base, timestamp,
  };
};

// ── the round machinery (Plan 4 Phase 3 — Decision 3: writer arms only) ──────────────

// Design §2 caps, enforced AT THE ARMS (the transition table allows the records; the store stays
// the single legality door for TRANSITIONS): HARD_MAX council rounds per {cycle, stepId}, one
// post-freeze unfreeze per cycle, and the redesign valve at 2 cycles per plan (--new-cycle
// reopens a converged step in the next cycle — round-1 fold F3). Per Decision 8 an over-cap
// mint is SELF-SERVABLE — it requires an explicit non-empty --justification input, never a
// human wait-state.
export const ROUND_HARD_MAX = 3;
export const UNFREEZE_CAP = 1;
export const REDESIGN_CYCLE_CAP = 2;

const shellQuote = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
const RECEIPT_DEADLINE_TOOL = join(dirname(fileURLToPath(import.meta.url)), 'receipt-deadline.mjs');

// Decision 8: the cap refusal names the recorded-justification lane; a justification INSIDE the
// cap refuses too (fail closed — an input that binds nothing is never silently dropped, the
// subset-attempt diagnosis discipline).
const gateCapJustification = ({ justification, overCap, refusal }) => {
  if (!overCap) {
    if (justification !== undefined) throw usageFail('--justification rides only an over-cap mint (Decision 8) — inside the cap it binds nothing; drop it');
    return null;
  }
  if (typeof justification !== 'string' || justification.length === 0) {
    throw refuse(`${refusal}; the over-cap mint requires an explicit non-empty --justification <text> (Decision 8 — recorded and self-servable, never a wait-for-maintainer)`);
  }
  return justification;
};

// The receipts store, read ONCE through the race-free no-follow reader → { path, bytes | null }.
const readReceiptsBytesFailClosed = (cwd, env, why) => {
  const path = requireReceiptsPath(cwd, env, why);
  const read = readFileBytesNoFollow(path);
  if (read.outcome === 'absent') return { path, bytes: null };
  if (read.outcome === 'foreign') throw refuse(`the receipts store at ${path} is a ${read.className}, not a regular file — never followed, never read (fail closed)`);
  if (read.outcome !== 'ok') throw refuse(`the receipts store at ${path} is unreadable (${read.code}) — fail closed`);
  return { path, bytes: read.bytes };
};

// Complete (newline-terminated) JSONL lines with their byte offsets. ANY malformed complete line
// refuses — a round binding never rides a partially readable store (the maintainer-override
// precedent). A trailing unterminated fragment is an in-flight append, not a line — it never
// binds and never refuses.
const parseReceiptLines = (bytes, path) => {
  const lines = [];
  let offset = 0;
  for (;;) {
    const nl = bytes.indexOf(0x0a, offset);
    if (nl === -1) break;
    const raw = bytes.subarray(offset, nl).toString('utf8');
    if (raw.trim() !== '') {
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch { parsed = null; }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw refuse(`the receipts store at ${path} carries a malformed line at byte ${offset} — a round binding never rides a partially readable store (fail closed)`);
      }
      lines.push({ offset, record: parsed });
    }
    offset = nl + 1;
  }
  return lines;
};

// The latest (authoritative) revision of each round index of one step's {cycle, stepId}.
const stepRoundHeads = (chain, cycle, stepId) => {
  const byRound = new Map();
  for (const r of chain) {
    if (r.purpose === 'round' && r.cycle === cycle && r.stepId === stepId) byRound.set(r.round, r);
  }
  return [...byRound.values()];
};

// The authoritative core degrade set — the core store reads fail-closed.
const coreDegradeRecords = (cwd, env) => {
  const corePath = resolveEvidencePath(cwd, env);
  const read = corePath == null ? { records: [] } : readEvidence(corePath);
  if (read.readError || (read.malformed ?? 0) > 0) {
    throw refuse(`the core evidence store is unreadable or malformed (${read.readError ?? read.malformedReasons[0]}) — cannot resolve degrade coverage for pending dispatches (fail closed)`);
  }
  return authoritativeOfKind(read.records, 'degrade');
};

const isCanonicalInstant = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

// F1/B3 (round-1 folds): a pending dispatch is exempt only through the design's degradation
// lane — an authoritative core degrade at {backend, the round's dispatched tree} PLUS a
// mint-time-valid flow degrade-justification binding that degrade at the ROUND's {base,
// fingerprint} (#25 exactness, mirrored raw-side). The scan is RAW over mint-time prefixes —
// the {downMark}-keyed authoritative selection would let a later justification on the same
// sticky mark evict an earlier round's exemption (B3). A bare core degrade never exempts alone
// (the core record carries no base field to bind).
const hasJustifiedDegradeAt = ({ flowRecords, degrades, backend, round }) => {
  const digests = new Set(degrades
    .filter((r) => r.backend === backend && r.fingerprint === round.fingerprint)
    .map((r) => canonicalFlowDigest(r)));
  if (digests.size === 0) return false;
  return flowRecords.some((j, at) => {
    if (j.kind !== 'degrade-justification' || !digests.has(j.degradeDigest)) return false;
    if (j.base !== round.base || j.fingerprint !== round.fingerprint) return false;
    if (!isCanonicalInstant(j.timestamp)) return false;
    const prefix = flowRecords.slice(0, at);
    const mark = resolveRecordReference(prefix, j.downMark);
    if (mark === undefined || mark.kind !== 'down-mark' || mark.backend !== backend) return false;
    if (prefix.some((c) => (c.kind === 'down-mark-up' || c.kind === 'down-mark-clear') && c.target === j.downMark)) return false;
    return Date.parse(j.timestamp) >= Date.parse(mark.timestamp) && Date.parse(j.timestamp) < Date.parse(mark.expiresAt);
  });
};

const openStepState = (state, planId, verb) => {
  if (!(state.mode === 'in-step' && !state.parked && !state.completed)) {
    throw refuse(`plan "${planId}" has no open step — ${verb}`);
  }
};

// The ONE completeness walk (F2/F6 folds) — string issue or null; runs BOTH lock-free (the
// early named refusal) and as the under-lock preflight on the locked snapshot (the snapshot
// decides — a concurrent revision can never slip a stale terminal or a stranding round
// through). `onlyRound` narrows round-open's re-check to the current round; terminals walk the
// whole step. Honest limit: the disposition floor proves FORM (>= 1 recorded disposition on a
// delivering round), never semantic per-finding completeness — the manifest carries findings as
// ONE string.
const stepCompletenessIssue = ({ flowRecords, chain, cycle, stepId, onlyRound = null, label, cwd, env }) => {
  const heads = stepRoundHeads(chain, cycle, stepId).filter((r) => onlyRound == null || r.round === onlyRound);
  let degrades = null;
  for (const round of heads) {
    for (const e of round.dispatches) {
      if (e.receiptDigest !== null) continue;
      degrades ??= coreDegradeRecords(cwd, env);
      if (hasJustifiedDegradeAt({ flowRecords, degrades, backend: e.backend, round })) continue;
      return `${label}: pending dispatch {backend "${e.backend}", nonce "${e.dispatchNonce}"} of round ${round.round} has no landed binding and no JUSTIFIED core degrade at its dispatched tree (${round.fingerprint.slice(0, 12)}…) — land the arrival (flow-writer round-land), or record the failure through the degradation lane: core-evidence degrade, then flow-writer down-mark + degrade-justification at the round's tree (#25; a bare degrade is not base-bound and never exempts alone)`;
    }
  }
  const landedEntries = heads.flatMap((round) => round.dispatches.filter((e) => e.receiptDigest !== null).map((e) => ({ round, e })));
  if (landedEntries.length === 0) return null;
  const { path: receiptsPath, bytes } = readReceiptsBytesFailClosed(cwd, env, `${label} resolves the landed receipts' verdicts`);
  const byDigest = new Map();
  for (const l of bytes == null ? [] : parseReceiptLines(bytes, receiptsPath)) byDigest.set(canonicalFlowDigest(l.record), l.record);
  for (const { round, e } of landedEntries) {
    const receipt = byDigest.get(e.receiptDigest);
    if (receipt === undefined) {
      return `the landed receipt of dispatch {backend "${e.backend}", nonce "${e.dispatchNonce}"} (round ${round.round}) no longer resolves in the receipts store — a terminal never rides an unresolvable binding (fail closed); inspect ${receiptsPath}`;
    }
    if (!isRecognizedVerdict(receipt.verdict)) {
      return `the landed receipt of backend "${e.backend}" (round ${round.round}) carries the unrecognized verdict ${JSON.stringify(receipt.verdict)} — an unknown verdict never rides a terminal (fail closed)`;
    }
    if (!isShipVerdict(receipt.verdict) && round.dispositions.length === 0) {
      return `${label}: the landed receipt of backend "${e.backend}" (round ${round.round}, verdict ${JSON.stringify(receipt.verdict)}) delivered findings and the round's disposition ledger is EMPTY — land each finding's disposition first (flow-writer round-land --dispose folded|queued|rejected …)`;
    }
  }
  return null;
};

// F7/B1/B2 (round-1 folds): a terminal binds the CURRENT tree, so a fingerprint move since the
// last round must be the design's ONE sanctioned post-review move — the declared bookkeeping-
// delta chain (+ refresh re-attestations), classified by the checker's own classifier with its
// exact parameter names (B1), and ANCHORED: every link delta and its attesting refresh must sit
// strictly after the last authoritative round head in raw order (B2 — a pre-round chain never
// re-certifies a later identical move). Anything else refuses naming the new-round recovery.
const terminalMoveIssue = ({ flowRecords, chain, cycle, stepId, tree, cwd }) => {
  const heads = stepRoundHeads(chain, cycle, stepId);
  if (heads.length === 0) return null;
  const lastHead = heads.reduce((a, b) => (a.round > b.round ? a : b));
  if (tree.fingerprint === lastHead.fingerprint) return null;
  const top = gitLine(['rev-parse', '--show-toplevel'], cwd) ?? cwd;
  let config;
  try {
    config = loadConfig(top).config;
  } catch (err) {
    return `the tree moved after round ${lastHead.round} and the orchestration config cannot be loaded (${(err && err.message) || err}) — the move classification fails closed; fix the config or open a NEW round on the moved tree`;
  }
  const flow = config?.flow;
  const chainClass = classifyDeltaChain({
    records: flowRecords,
    fromFingerprint: lastHead.fingerprint,
    toFingerprint: tree.fingerprint,
    declaredPaths: [flow?.debtQueue, flow?.convergenceSummary].filter((p) => typeof p === 'string'),
    refreshCap: flow?.councilRounds ?? null,
  });
  if (chainClass.classification !== 'current') {
    return `the tree moved after round ${lastHead.round} (${lastHead.fingerprint.slice(0, 12)}… → ${tree.fingerprint.slice(0, 12)}…) and the move is not a declared bookkeeping-delta chain (${chainClass.reason}) — reviews are contextual: land the declared deltas + refresh, or open a NEW round on the moved tree`;
  }
  const anchor = flowRecords.indexOf(lastHead);
  for (const d of chainClass.links) {
    // G2 (round-2 fold): the checker's custody predicate applies to every anchored link — a
    // store-valid delta with a forged proof never carries a terminal (the gate-time walk alone
    // would let the terminal land first and red only later).
    const custody = deltaCustodyIssue(d);
    if (custody !== null) {
      return `the delta chain carrying the move rides an unproven custody proof (bookkeeping-delta at ${d.path}: ${custody}) — a forged link never carries a terminal; open a NEW round on the moved tree`;
    }
    const at = flowRecords.indexOf(d);
    const digest = canonicalFlowDigest(d);
    const refreshAt = flowRecords.findIndex((s, j) => j > at && s.kind === CHAIN_KIND && s.purpose === 'refresh'
      && s.refreshedRecord === digest && s.fingerprintBefore === d.fingerprintAfter);
    if (at <= anchor || refreshAt <= anchor) {
      return `the delta chain carrying the move is not anchored after the last round head — a pre-round chain never re-certifies a later identical move (fail closed); open a NEW round on the moved tree`;
    }
  }
  return null;
};

// round-open — the PRE-DISPATCH half (#41): the round record is minted BEFORE any backend runs,
// carrying one dispatch-ledger entry per backend {dispatchBase = the round's base, the
// receipts-file byte-length watermark, a fresh nonce}; receipt/manifest digests stay null until
// round-land. A boundary invocation opens the step (opensFrom = the chain's prior terminal); an
// in-step invocation opens the NEXT round (a fingerprint move never rides a revision).
const buildRoundOpen = ({ planId, stepId, backends, newCycle, justification, cwd, env, timestamp }) => {
  // The backend list is judged BEFORE any store read — a usage-shaped input never surfaces as a
  // state-dependent refusal.
  const seen = new Set();
  for (const backend of backends) {
    if (!SAFE_NONCE_RE.test(backend)) throw usageFail(`--backend must satisfy the safe token grammar ([A-Za-z0-9._-]{1,64}) — got ${JSON.stringify(backend)}`);
    if (seen.has(backend)) throw usageFail(`duplicate --backend "${backend}" — one dispatch per backend per round (a re-dispatch opens a new round)`);
    seen.add(backend);
  }
  const tree = treeContext(cwd);
  const records = readStoreRecords(cwd, env);
  const { chain, state, commitEpoch } = chainContext(records, planId, tree.owner);
  const inStep = state.mode === 'in-step' && !state.parked && !state.completed;
  if (newCycle && inStep) throw usageFail('--new-cycle opens at a step boundary only — an open step continues through its own rounds');
  // The in-step guard re-runs on the LOCKED snapshot too (M6) — this closure is the preflight.
  const roundOpenGuard = (flowRecords) => {
    const lockedChain = flowRecords.filter((r) => r.kind === CHAIN_KIND && r.planId === planId);
    const lockedState = walkChainState(lockedChain);
    if (!(lockedState.mode === 'in-step' && !lockedState.parked && !lockedState.completed)) return;
    // The dead-end guard (F2 extended): after round N+1 opens, round N can never be revised
    // again (the round index only increases within a step), so an unlanded-unjustified dispatch
    // OR an undispositioned non-ship round there would make the step permanently unterminable.
    const issue = stepCompletenessIssue({
      flowRecords, chain: lockedChain, cycle: lockedState.cycle, stepId: lockedState.stepId,
      onlyRound: lockedState.round, label: `round-open refuses — a NEW round would strand round ${lockedState.round}`, cwd, env,
    });
    if (issue != null) throw refuse(issue);
  };
  let target;
  if (inStep) {
    if (stepId !== undefined && stepId !== state.stepId) {
      throw usageFail(`--step "${stepId}" does not match the open step "${state.stepId}" — an in-step round-open derives its step from the chain walk`);
    }
    target = { stepId: state.stepId, round: state.round + 1, opensFrom: null, cycle: state.cycle };
    roundOpenGuard(records);
  } else {
    if (stepId === undefined) throw usageFail('round-open at a step boundary requires --step <stepId> (the step this round opens)');
    const prior = priorChainTerminal(chain);
    if (prior == null) throw refuse(`plan "${planId}" has no prior terminal to open from — the chain is broken (fail closed)`);
    target = { stepId, round: 1, opensFrom: canonicalFlowDigest(prior), cycle: newCycle ? state.cycle + 1 : state.cycle };
  }
  const existingRounds = new Set(
    chain.filter((r) => r.purpose === 'round' && r.cycle === target.cycle && r.stepId === target.stepId).map((r) => r.round),
  );
  const roundOverCap = !existingRounds.has(target.round) && existingRounds.size >= ROUND_HARD_MAX;
  const valveOverCap = target.cycle > REDESIGN_CYCLE_CAP;
  const recordedJustification = gateCapJustification({
    justification,
    overCap: roundOverCap || valveOverCap,
    refusal: roundOverCap
      ? `round ${target.round} of step "${target.stepId}" (cycle ${target.cycle}) exceeds HARD_MAX ${ROUND_HARD_MAX} rounds per cycle (design §2)`
      : `cycle ${target.cycle} passes the redesign valve (capped at ${REDESIGN_CYCLE_CAP} cycles per plan, design §2)`,
  });
  const { path: receiptsPath, bytes } = readReceiptsBytesFailClosed(cwd, env, 'the dispatch watermark is the receipts-file byte length');
  const watermark = bytes == null ? 0 : bytes.byteLength;
  // The receipt-deadline boundary rule, applied at MINT time: a watermark on an unterminated tail
  // would let an appended receipt physically continue that malformed line.
  if (watermark > 0 && bytes[watermark - 1] !== 0x0a) {
    throw refuse(`the receipts store at ${receiptsPath} ends in an unterminated line — a watermark minted here could never be awaited (the receipt-deadline line-boundary rule); repair the store tail first (fail closed)`);
  }
  const dispatches = backends.map((backend) => ({
    backend, dispatchBase: tree.base, receiptWatermark: watermark,
    dispatchNonce: randomBytes(16).toString('hex'),
    receiptDigest: null, findingManifestDigest: null,
  }));
  const record = {
    ...chainCommons({ planId, tree, state, commitEpoch, timestamp }),
    cycle: target.cycle, round: target.round, purpose: 'round', stepId: target.stepId,
    fingerprint: tree.fingerprint, opensFrom: target.opensFrom, dispatches, dispositions: [],
  };
  return { record, justification: recordedJustification, preflight: roundOpenGuard };
};

// round-land — the POST-ARRIVAL half (#42/#13/#33): revises the open round IN PLACE. Arrival
// selection rides the receipt-deadline watermark discipline (complete lines past the persisted
// offset; the prefix hash stays that runner's in-process guard, never a persisted proof): exactly
// ONE non-probe receipt line of the dispatched backend must sit past the watermark — none keeps
// the dispatch pending, more is an ambiguous newer set and refuses. Both digests are COMPUTED
// from the files (receipt line → canonical digest; manifest bytes → sha256) and land together;
// a foreign-tree receipt, a missing/malformed/symlinked manifest, or a foreign-identity manifest
// refuses the binding. A --dispose input appends ONE disposition entry whose findingDigest is the
// sha256 of the QUOTED finding text, verified a SUBSTRING of a landed manifest's findings payload.
const buildRoundLand = ({ planId, dispose, cwd, env, timestamp }) => {
  const tree = treeContext(cwd);
  const records = readStoreRecords(cwd, env);
  const { chain, state } = chainContext(records, planId, tree.owner);
  openStepState(state, planId, 'round-land revises the open step\'s round; open it first (flow-writer round-open)');
  const head = stepRoundHeads(chain, state.cycle, state.stepId).find((r) => r.round === state.round);
  if (head == null) throw refuse(`plan "${planId}" has no round record at the open context (cycle ${state.cycle}, step "${state.stepId}", round ${state.round}) — the chain is broken (fail closed)`);
  const { path: receiptsPath, bytes } = readReceiptsBytesFailClosed(cwd, env, 'round-land binds arrivals from the receipts store');
  const lines = bytes == null ? [] : parseReceiptLines(bytes, receiptsPath);
  const landed = [];
  const pending = [];
  const dispatches = head.dispatches.map((entry) => {
    if (entry.receiptDigest !== null) return entry;
    const length = bytes == null ? 0 : bytes.byteLength;
    if (length < entry.receiptWatermark) {
      throw refuse(`the receipts store shrank below watermark offset ${entry.receiptWatermark} (${length} bytes at ${receiptsPath}) — a shrunken store never binds an arrival (fail closed)`);
    }
    if (entry.receiptWatermark > 0 && bytes[entry.receiptWatermark - 1] !== 0x0a) {
      throw refuse(`watermark offset ${entry.receiptWatermark} does not sit on a line boundary (${receiptsPath}) — the pre-dispatch tail was unterminated, so an appended receipt physically continues that malformed line; a binding never rides it (fail closed)`);
    }
    // F4/m7 + G1 (round-1/2 folds): candidates are CODE-artifact, fresh, non-probe lines of the
    // dispatched backend carrying THIS dispatch's EXACT nonce (the wrapper stamps AW_REVIEW_NONCE
    // into the receipt — dispatch identity end-to-end; a nonce-less or foreign-nonce line is
    // never this dispatch's answer, so a delayed receipt of a degraded dispatch or another
    // plan's dispatch can never cross-bind). The ONE candidate then rides the canonical
    // attesting-receipt classification: only ATTESTING binds; NOT_CURRENT here means a
    // fingerprint mismatch (artifact/freshness pre-screened); every other class is a DEFECTIVE
    // answer from OUR dispatch and refuses loudly with the justified-degrade recovery (M4).
    const matches = lines.filter((l) => l.offset >= entry.receiptWatermark && l.record.backend === entry.backend
      && l.record.nonce === entry.dispatchNonce
      && l.record.artifact === 'code' && l.record.fresh === true && l.record.probe !== true);
    if (matches.length === 0) {
      pending.push(entry);
      return entry;
    }
    if (matches.length > 1) {
      throw refuse(`${matches.length} receipt lines from backend "${entry.backend}" sit past watermark offset ${entry.receiptWatermark} — an ambiguous newer set never binds a dispatch (fail closed); inspect ${receiptsPath}`);
    }
    const receipt = matches[0].record;
    const cls = classifyReviewReceiptForTree(receipt, head.fingerprint);
    if (cls === REVIEW_RECEIPT_CLASS.NOT_CURRENT) {
      throw refuse(`the arrived receipt of backend "${entry.backend}" attests fingerprint ${String(receipt.fingerprint).slice(0, 12)}…, not the round's dispatched tree (${head.fingerprint.slice(0, 12)}…) — a foreign-tree receipt never binds this round (fail closed)`);
    }
    if (cls !== REVIEW_RECEIPT_CLASS.ATTESTING) {
      throw refuse(`the arrived answer of backend "${entry.backend}" is a non-attesting receipt (class "${cls}") — a defective answer never binds a dispatch (fail closed); recovery: record the failure (core-evidence degrade, then flow-writer down-mark + degrade-justification at the round's tree), then open a NEW round to re-dispatch`);
    }
    const m = readManifestDecoded({ receiptsPath, backend: entry.backend, nonce: entry.dispatchNonce });
    if (m.outcome === 'absent') {
      throw refuse(`the receipt of backend "${entry.backend}" arrived but its finding manifest is missing at ${m.path} — the wrapper mints the manifest BEFORE the receipt append, so an arrived receipt without one never binds (fail closed)`);
    }
    if (m.outcome === 'foreign') {
      throw refuse(`the finding manifest at ${m.path} is a ${m.className}, not a regular file — a binding never rides a symlink or a FIFO (fail closed)`);
    }
    if (m.outcome === 'error') throw refuse(`the finding manifest at ${m.path} is unreadable (${m.code}) — fail closed`);
    if (m.outcome === 'malformed') throw refuse(`the finding manifest at ${m.path} is malformed — ${m.reason} — it never binds a dispatch`);
    if (m.outcome === 'foreign-identity') {
      throw refuse(`the finding manifest at ${m.path} declares {backend "${m.manifest.backend}", nonce "${m.manifest.nonce}"} — a foreign-identity manifest never binds this dispatch (fail closed)`);
    }
    if (m.outcome !== 'ok') throw refuse(`no manifest name composes for the dispatch nonce — the ledger entry is corrupt (fail closed)`);
    if (m.manifest.fingerprint !== null && m.manifest.fingerprint !== head.fingerprint) {
      throw refuse(`the finding manifest at ${m.path} attests fingerprint ${m.manifest.fingerprint.slice(0, 12)}…, not the round's dispatched tree (${head.fingerprint.slice(0, 12)}…) — a foreign-tree manifest never binds this round (fail closed)`);
    }
    landed.push({ backend: entry.backend, nonce: entry.dispatchNonce });
    return {
      ...entry,
      receiptDigest: canonicalFlowDigest(receipt),
      findingManifestDigest: createHash('sha256').update(m.bytes).digest('hex'),
    };
  });
  let dispositions = head.dispositions;
  let disposed = null;
  if (dispose != null) {
    const findingDigest = createHash('sha256').update(dispose.finding, 'utf8').digest('hex');
    const carriers = dispatches.filter((e) => e.receiptDigest !== null);
    if (carriers.length === 0) throw refuse('no landed dispatch carries a finding manifest yet — a disposition binds a delivered finding of a landed round (fail closed)');
    // F5 (round-1 fold): every carrier's manifest is re-read and its byte digest MUST equal the
    // LEDGER's findingManifestDigest — a manifest swapped after landing never carries a
    // disposition, however well its payload matches the quote.
    const payloads = carriers.map((e) => {
      const m = readManifestDecoded({ receiptsPath, backend: e.backend, nonce: e.dispatchNonce });
      if (m.outcome !== 'ok') {
        throw refuse(`the landed manifest for {backend "${e.backend}", nonce "${e.dispatchNonce}"} is no longer cleanly readable (${m.outcome}) — a disposition binds live manifest custody (fail closed)`);
      }
      if (createHash('sha256').update(m.bytes).digest('hex') !== e.findingManifestDigest) {
        throw refuse(`the manifest at ${m.path} no longer matches the landed findingManifestDigest — a swapped manifest never carries a disposition (fail closed)`);
      }
      return m.manifest.findings;
    });
    if (!payloads.some((findings) => findings.includes(dispose.finding))) {
      throw refuse('the quoted finding is not a substring of any landed finding-manifest payload of this round — a disposition binds a real delivered finding, verbatim (fail closed)');
    }
    const entry = (() => {
      if (dispose.action === 'folded') {
        // The fold's proof must RESOLVE (the consult-attestation precedent — an unverified digest
        // could name a proof nobody minted): consult-attestation in the flow store, red-proof in
        // the core store.
        if (dispose.proofKind === 'consult-attestation') {
          const target = records.findLast((r) => r.kind === 'consult-attestation' && canonicalFlowDigest(r) === dispose.proofDigest);
          if (target === undefined) throw refuse(`--proof-digest ${dispose.proofDigest.slice(0, 12)}… does not resolve to a consult-attestation in the flow store — a fold's proof binds an existing record (fail closed)`);
        } else {
          const corePath = resolveEvidencePath(cwd, env);
          const coreRead = corePath == null ? { records: [] } : readEvidence(corePath);
          if (coreRead.readError || (coreRead.malformed ?? 0) > 0) {
            throw refuse(`the core evidence store is unreadable or malformed (${coreRead.readError ?? coreRead.malformedReasons[0]}) — cannot resolve the red-proof (fail closed)`);
          }
          if (!coreRead.records.some((r) => r.kind === 'red-proof' && canonicalFlowDigest(r) === dispose.proofDigest)) {
            throw refuse(`--proof-digest ${dispose.proofDigest.slice(0, 12)}… does not resolve to a red-proof in the core evidence store — a fold's proof binds an existing record (fail closed)`);
          }
        }
        return { findingDigest, action: 'folded', proofKind: dispose.proofKind, proofDigest: dispose.proofDigest };
      }
      if (dispose.action === 'queued') {
        // Honest limit: the debt entry's {id, digest} are form-checked only — no debt-file reader
        // exists to resolve them; the checker's declared-path lane owns the file itself.
        return { findingDigest, action: 'queued', debtId: dispose.debtId, debtDigest: dispose.debtDigest };
      }
      return { findingDigest, action: 'rejected', reason: dispose.reason };
    })();
    dispositions = [...head.dispositions, entry];
    disposed = { action: dispose.action, findingDigest };
  }
  if (landed.length === 0 && disposed == null) {
    throw refuse(`nothing to land — no pending dispatch has an arrived receipt (${pending.length} still pending) and no --dispose was given; a no-op revision never mints`);
  }
  // A revision re-states its round: every identity field rides the head verbatim (the store's
  // revision contract pins opensFrom/base/fingerprint/commitEpoch byte-equal), only the ledgers
  // and the timestamp move.
  return { record: { ...head, dispatches, dispositions, timestamp }, landed, pending, disposed };
};

// freeze / converged — the step terminals, gated on COMPLETENESS + the sanctioned-move rule
// (no premature terminal): every dispatch of the step's rounds landed or justified-degraded at
// its dispatched tree; every landed non-ship receipt rides a round with a non-empty disposition
// ledger; the tree either sits at the last round's fingerprint or reached it through an
// ANCHORED declared bookkeeping-delta chain. Both walks re-run on the LOCKED snapshot (F6) —
// the returned preflight is the last word.
const buildStepTerminal = ({ purpose, planId, cwd, env, timestamp }) => {
  const tree = treeContext(cwd);
  const records = readStoreRecords(cwd, env);
  const { chain, state, commitEpoch } = chainContext(records, planId, tree.owner);
  openStepState(state, planId, `${purpose} terminates an open step's sequence`);
  const terminalGuard = (flowRecords) => {
    const lockedChain = flowRecords.filter((r) => r.kind === CHAIN_KIND && r.planId === planId);
    const lockedState = walkChainState(lockedChain);
    if (!(lockedState.mode === 'in-step' && !lockedState.parked && !lockedState.completed)) return;
    const issue = stepCompletenessIssue({
      flowRecords, chain: lockedChain, cycle: lockedState.cycle, stepId: lockedState.stepId,
      label: `${purpose} refuses — no premature terminal`, cwd, env,
    }) ?? terminalMoveIssue({
      flowRecords, chain: lockedChain, cycle: lockedState.cycle, stepId: lockedState.stepId, tree, cwd,
    });
    if (issue != null) throw refuse(issue);
  };
  terminalGuard(records);
  return {
    record: { ...chainCommons({ planId, tree, state, commitEpoch, timestamp }), purpose, stepId: state.stepId, fingerprint: tree.fingerprint },
    preflight: terminalGuard,
  };
};

// unfreeze — reopens the frozen step (in-step, after freeze) or the just-converged step (at the
// boundary); the store owns transition legality. Cap: UNFREEZE_CAP per cycle (design §2 Phase 4 —
// the post-freeze checkpoint), self-servable per Decision 8.
const buildUnfreeze = ({ planId, justification, cwd, env, timestamp }) => {
  const tree = treeContext(cwd);
  const records = readStoreRecords(cwd, env);
  const { chain, state, commitEpoch } = chainContext(records, planId, tree.owner);
  const inStep = state.mode === 'in-step' && !state.parked && !state.completed;
  const target = inStep
    ? { stepId: state.stepId, round: state.round, cycle: state.cycle }
    : state.lastTerminal != null && state.lastTerminal.purpose === 'converged'
      ? { stepId: state.lastTerminal.stepId, round: state.lastTerminal.round, cycle: state.lastTerminal.cycle }
      : null;
  if (target == null) throw refuse(`plan "${planId}" has nothing to unfreeze — unfreeze reopens the frozen step or the just-converged terminal`);
  const priorUnfreezes = chain.filter((r) => r.purpose === 'unfreeze' && r.cycle === target.cycle).length;
  const recordedJustification = gateCapJustification({
    justification,
    overCap: priorUnfreezes >= UNFREEZE_CAP,
    refusal: `a further unfreeze in cycle ${target.cycle} passes the design checkpoint (post-freeze cap: ${UNFREEZE_CAP} unfreeze per cycle, design §2 Phase 4)`,
  });
  return {
    record: {
      ...chainCommons({ planId, tree, state, commitEpoch, timestamp }),
      cycle: target.cycle, round: target.round, purpose: 'unfreeze', stepId: target.stepId, fingerprint: tree.fingerprint,
    },
    justification: recordedJustification,
  };
};

// internal-attestation (#28) — gated on the #68 arming predicate: EVERY in-flight plan must be
// covered by an adopted chain (frontmatter planId + content digest + owner, the ONE coverage
// predicate review-state's internal-only floor consumes) — an uncovered plan is a refusal naming
// the file, never a relaxation.
const buildInternalAttestation = ({ planId, lenses, degraded, model, effort, tier, authority, cwd, env, timestamp, ctx }) => {
  const tree = treeContext(cwd);
  const records = readStoreRecords(cwd, env);
  const { state } = chainContext(records, planId, tree.owner);
  openStepState(state, planId, 'an internal-attestation binds an open step\'s round (#28); open the step\'s round first');
  const root = gitLine(['rev-parse', '--show-toplevel'], cwd) ?? cwd;
  const coverage = computePlanAdoptionCoverage({
    root, plans: plansInFlight(root), records, owner: tree.owner,
    readFile: ctx.readFileSync ?? readFileSync,
  });
  const uncovered = coverage.filter((p) => !p.covered);
  if (uncovered.length > 0) {
    throw refuse(`internal-attestation refuses (#68): ${uncovered.map((p) => `plan ${quoteReportName(p.plan)} — ${p.reason}`).join('; ')} — an uncovered in-flight plan is a refusal, never a relaxation`);
  }
  return {
    schema: FLOW_SCHEMA_VERSION, kind: 'internal-attestation', fingerprint: tree.fingerprint,
    planId, stepId: state.stepId, cycle: state.cycle, round: state.round,
    lenses, degraded, posture: { model, effort: effort ?? null, tier: tier ?? null }, authority,
    base: tree.base, timestamp,
  };
};

// ── write-plan-id (#58 — bounded frontmatter write; the mint itself stays read-only) ─

// Pure composer: insert the planId line into an existing closed leading frontmatter block, or
// prepend a fresh block. The round-trip guard re-reads the RESULT through the adoption mint's own
// parser (injectable so the compose-vs-parse drift contract is testable) — an id the mint would
// not read back is never written.
export const composePlanIdFrontmatter = (text, planId, parse = readPlanFrontmatterId) => {
  const lines = text.split('\n');
  const hasClosedBlock = lines[0]?.trim() === '---' && lines.findIndex((line, i) => i > 0 && line.trim() === '---') > 0;
  const next = hasClosedBlock
    ? [lines[0], `planId: ${planId}`, ...lines.slice(1)].join('\n')
    : `---\nplanId: ${planId}\n---\n${text}`;
  if (parse(next) !== planId) {
    throw refuse(`the composed frontmatter does not round-trip to planId "${planId}" — refusing to write an id the adoption mint would not read (fail closed)`);
  }
  return next;
};

const writePlanId = ({ planPath, planId, cwd, ctx }) => {
  if (!/^\S+$/.test(planId)) throw usageFail(`--plan-id must be a single non-whitespace token (got ${JSON.stringify(planId)})`);
  const lex = lexicalRepoRelative(planPath);
  if (!lex.ok) throw refuse(`the plan path must be lexically repo-relative — ${lex.reason} (fail closed)`);
  // A backslash byte is refused before ANY lstat/read: on Windows it is a separator the raw
  // checks below do not judge, so "docs/plans/..\\…" would resolve outside the plans dir there.
  if (planPath.includes('\\')) {
    throw refuse(`the plan path "${planPath}" carries a backslash — forward-slash is the only separator write-plan-id judges (fail closed)`);
  }
  // lexicalRepoRelative NORMALIZES interior dot segments — a "docs/plans/../…" spelling would pass
  // a raw prefix check while resolving outside the plans dir, so segments are refused explicitly.
  if (planPath.split('/').some((s) => s === '..' || s === '.' || s === '')) {
    throw refuse(`the plan path must be a plain forward-slash path without "." or ".." segments (got "${planPath}") — write-plan-id is bounded to ${PLANS_DIR}/ lexically`);
  }
  if (!planPath.startsWith(`${PLANS_DIR}/`)) throw refuse(`the plan path must live under ${PLANS_DIR}/ (got "${planPath}") — write-plan-id is bounded to the plans dir`);
  const full = join(cwd, planPath);
  const lstat = ctx.lstatSync ?? lstatSync;
  const st = lstatNoFollow(full, lstat);
  if (st == null) throw refuse(`${planPath} does not exist — write-plan-id targets an EXISTING regular plan file (the id write never creates plans)`);
  if (st.isSymbolicLink()) throw refuse(`${planPath} is a symlink — refusing to write plan identity through a link (fail closed)`);
  if (!st.isFile()) throw refuse(`${planPath} is not a regular file — refusing (fail closed)`);
  const readFile = ctx.readFileSync ?? readFileSync;
  // Fatal decode (BOM preserved as U+FEFF): a lossy 'utf8' read would fold invalid bytes to
  // U+FFFD and the atomic rewrite below would then corrupt the original body irreversibly.
  const bytes = readFile(full);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw refuse(`${planPath} is not valid UTF-8 — a rewrite would corrupt the original bytes (fail closed)`);
  }
  const existing = readPlanFrontmatterId(text);
  if (existing === planId) return { noop: true, message: `${planPath} already carries planId "${planId}" — idempotent no-op; nothing written` };
  if (existing !== null) {
    throw refuse(`${planPath} already carries planId "${existing}" — a DIFFERENT id refuses: chain identity never silently changes (#58)`);
  }
  const next = composePlanIdFrontmatter(text, planId);
  writeContainedFileAtomic(join(cwd, PLANS_DIR), full, next, ctx, { stop: refuse, label: planPath });
  return { noop: false, message: `wrote planId "${planId}" into ${planPath} (contained-atomic); the adoption mint reads exactly this frontmatter line` };
};

// ── main ────────────────────────────────────────────────────────────────────────────

const ARMS = ['park', 'resume', 'complete', 'adoption', 'refresh', 're-baseline', 'rerun-cause', 'down-mark', 'down-mark-up', 'down-mark-clear', 'degrade-justification', 'maintainer-override', 'consult-attestation', 'round-open', 'round-land', 'freeze', 'unfreeze', 'converged', 'internal-attestation', 'write-plan-id'];

const HELP = `flow-writer — the explicit flow-store writer (flow-orchestration; the store preflight is the single legality door).

Usage:
  node flow-writer.mjs park <planId>
  node flow-writer.mjs resume <planId>
  node flow-writer.mjs complete <planId>
  node flow-writer.mjs adoption <plan-file> [--label <label>] [--cycle <n>]
  node flow-writer.mjs refresh <planId> --cause <text> --refreshed-record <digest>
  node flow-writer.mjs re-baseline <planId>
  node flow-writer.mjs rerun-cause --attempt <id> --cause <text>
  node flow-writer.mjs down-mark --backend <name> --reason <text> --expires-at <UTC ISO instant>
  node flow-writer.mjs down-mark-up --backend <name> [--target <digest>]
  node flow-writer.mjs down-mark-clear --backend <name> [--target <digest>]
  node flow-writer.mjs degrade-justification --backend <name> [--down-mark <digest>] [--degrade-digest <digest>]
  node flow-writer.mjs maintainer-override <planId> --backend <name> --checkpoint-approved [--veto-receipt <digest>] [--chain-record <digest>]
  node flow-writer.mjs consult-attestation <planId> --backend <name> --nonce <nonce> --proposed-fix-digest <digest>
  node flow-writer.mjs round-open <planId> --backend <name> [--backend <name> ...] [--step <stepId>] [--new-cycle] [--justification <text>]
  node flow-writer.mjs round-land <planId> [--dispose folded --finding <quote> --proof-kind consult-attestation|red-proof --proof-digest <digest>]
  node flow-writer.mjs round-land <planId> [--dispose queued --finding <quote> --debt-id <id> --debt-digest <digest>]
  node flow-writer.mjs round-land <planId> [--dispose rejected --finding <quote> --reason <text>]
  node flow-writer.mjs freeze <planId>
  node flow-writer.mjs unfreeze <planId> [--justification <text>]
  node flow-writer.mjs converged <planId>
  node flow-writer.mjs internal-attestation <planId> --lens <name> [--lens <name> ...] [--degraded <backend> ...] --model <model> [--effort <effort>] [--tier <tier>] --authority <text>
  node flow-writer.mjs write-plan-id <plan-file> --plan-id <id>

Operand shapes: a positional may follow a literal -- and a value flag accepts --flag=<value>
(the lanes a leading-dash operand rides; printed recoveries compose exactly these shapes).
Every arm computes its tree context (owner, base, fingerprint; cycle/round from the chain walk)
and appends through the lock-serialized store append — an illegal transition surfaces the store's
own refusal verbatim; the writer adds NO second validator. Chain arms refuse a foreign worktree's
chain (#57). maintainer-override prints its FULL bound set and requires --checkpoint-approved
(#38). write-plan-id is bounded to an existing regular file under ${PLANS_DIR}/ (same-id
idempotent, different-id refuses, contained-atomic; #58).

The round lifecycle (Plan 4 Phase 3): ONE record per round, revised in place — round-open mints
the pre-dispatch half (a fresh nonce + the receipts-file byte-length watermark per --backend,
BEFORE any backend runs; stdout prints one "dispatch backend=<b> nonce=<n> watermark=<w>" line
per dispatch — export the nonce as AW_REVIEW_NONCE on the bridge dispatch and hand the pair to
receipt-deadline); round-land binds arrivals (ONLY the canonical ATTESTING receipt class binds —
a defective answer refuses naming its class and the justified-degrade recovery; receipt +
manifest digests computed FROM the files; one revision per invocation, dispositions append via
--dispose with the manifest byte digest re-verified against the ledger). A fingerprint move
always opens a NEW round; --new-cycle reopens a converged step in the next cycle. Caps enforced
at the arms (Decision 8 — every refusal self-servable, never a human wait-state): HARD_MAX
${ROUND_HARD_MAX} rounds per {cycle, step}, ${UNFREEZE_CAP} post-freeze unfreeze per cycle, and
the redesign valve at ${REDESIGN_CYCLE_CAP} cycles per plan — an over-cap mint requires
--justification <text> (echoed in the report; the over-cap record itself is the durable trail).
freeze/converged refuse over an unlanded unjustified dispatch, a delivering round with an empty
disposition ledger, or an unsanctioned fingerprint move (only an anchored declared
bookkeeping-delta chain + refresh carries a terminal across a move); the completeness walks
re-run on the LOCKED store snapshot at append time. internal-attestation refuses while ANY
in-flight plan lacks an adopted chain, naming the file (#68).

Exit codes: 0 success; 2 usage; 1 refusal (store STOP verbatim / derivation failure / missing checkpoint flag).`;

export const main = (argv, ctx = {}) => {
  const cwd = ctx.cwd ?? process.cwd();
  const env = ctx.env ?? process.env;
  const timestamp = ctx.now ? ctx.now() : new Date().toISOString();
  try {
    // Help binds the FIRST token only — a later '--help' byte may be a legal operand value.
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return { code: 0, stdout: HELP, stderr: '' };
    const arm = argv[0];
    if (!ARMS.includes(arm)) throw usageFail(`unknown arm "${arm}" (known: ${ARMS.join(', ')})`);
    const rest = argv.slice(1);

    if (arm === 'write-plan-id') {
      const { values, positionals } = parseFlags(rest, { '--plan-id': 'value' });
      if (positionals.length !== 1) throw usageFail('write-plan-id takes exactly one <plan-file>');
      const r = writePlanId({ planPath: positionals[0], planId: requireValue(values, 'plan-id', 'write-plan-id'), cwd, ctx });
      return { code: 0, stdout: `flow-writer: ${r.message}`, stderr: '' };
    }

    if (arm === 'adoption') {
      const { values, positionals } = parseFlags(rest, { '--label': 'value', '--cycle': 'value' });
      if (positionals.length !== 1) throw usageFail('adoption takes exactly one <plan-file>');
      const cycle = values.cycle === undefined ? 1 : Number(values.cycle);
      if (!Number.isInteger(cycle) || cycle < 1) throw usageFail(`--cycle must be a positive integer (got "${values.cycle}")`);
      const minted = mintAdoption({ cwd, env, planPath: positionals[0], planLabel: values.label, cycle, timestamp });
      return { code: 0, stdout: `flow-writer: appended chain/adoption for plan "${minted.record.planId}" — digest ${minted.digest}\n  store: ${minted.writtenPath}`, stderr: '' };
    }

    if (arm === 'round-open') {
      const { values, positionals } = parseFlags(rest, { '--backend': 'list', '--step': 'value', '--new-cycle': 'boolean', '--justification': 'value' });
      const planId = onePlanId(positionals, arm);
      if (!Array.isArray(values.backend) || values.backend.length === 0) {
        throw usageFail('round-open requires at least one --backend <name> (the dispatch set is minted BEFORE any backend runs, #41)');
      }
      const built = buildRoundOpen({
        planId, stepId: values.step, backends: values.backend,
        newCycle: values['new-cycle'] === true, justification: values.justification, cwd, env, timestamp,
      });
      const appended = appendFlowRecordWithPreflight({ cwd, record: built.record, env, deps: ctx.storeDeps ?? {}, preflight: built.preflight });
      const r = appended.record;
      const lines = [
        `flow-writer: appended chain/round (open) for plan "${planId}" — step "${r.stepId}" cycle ${r.cycle} round ${r.round} — digest ${canonicalFlowDigest(r)}`,
        `  store: ${appended.writtenPath}`,
        ...(built.justification != null ? [`  justification (Decision 8, over-cap mint — the record above is the durable trail): ${built.justification}`] : []),
        ...r.dispatches.flatMap((d) => [
          `  dispatch backend=${d.backend} nonce=${d.dispatchNonce} watermark=${d.receiptWatermark}`,
          `    dispatch with AW_REVIEW_NONCE=${d.dispatchNonce} so the wrapper mints the {backend, nonce}-named finding manifest`,
          `    await (pasteable): node ${shellQuote(RECEIPT_DEADLINE_TOOL)} --backend=${d.backend} --watermark=${d.receiptWatermark} --nonce=${d.dispatchNonce}`,
        ]),
      ];
      return { code: 0, stdout: lines.join('\n'), stderr: '' };
    }

    if (arm === 'round-land') {
      const { values, positionals } = parseFlags(rest, { '--dispose': 'value', '--finding': 'value', '--proof-kind': 'value', '--proof-digest': 'value', '--debt-id': 'value', '--debt-digest': 'value', '--reason': 'value' });
      const planId = onePlanId(positionals, arm);
      const dispose = (() => {
        if (values.dispose === undefined) {
          const stray = ['finding', 'proof-kind', 'proof-digest', 'debt-id', 'debt-digest', 'reason'].find((f) => values[f] !== undefined);
          if (stray !== undefined) throw usageFail(`--${stray} rides only a --dispose invocation`);
          return null;
        }
        const action = values.dispose;
        if (!['folded', 'queued', 'rejected'].includes(action)) throw usageFail(`--dispose must be folded | queued | rejected (got "${action}")`);
        // G3 (round-2 fold): a flag of another disposition branch refuses as usage BEFORE any
        // required-value error — an incompatible input is named, never silently dropped.
        const branchFlags = { folded: ['proof-kind', 'proof-digest'], queued: ['debt-id', 'debt-digest'], rejected: ['reason'] };
        const allowedFlags = new Set(branchFlags[action]);
        const strayFlag = ['proof-kind', 'proof-digest', 'debt-id', 'debt-digest', 'reason'].find((f) => values[f] !== undefined && !allowedFlags.has(f));
        if (strayFlag !== undefined) {
          throw usageFail(`--${strayFlag} does not ride --dispose ${action} — the ${action} arm takes exactly {--finding, ${branchFlags[action].map((f) => `--${f}`).join(', ')}}`);
        }
        const finding = requireValue(values, 'finding', arm);
        // An empty quote must never reach the substring check — '' is a substring of EVERYTHING.
        if (finding.length === 0) throw usageFail('--finding must be the non-empty quoted finding text (verbatim from the delivered manifest)');
        if (action === 'folded') {
          const proofKind = requireValue(values, 'proof-kind', arm);
          if (proofKind !== 'consult-attestation' && proofKind !== 'red-proof') throw usageFail(`--proof-kind must be consult-attestation | red-proof (got "${proofKind}")`);
          return { action, finding, proofKind, proofDigest: requireDigest(requireValue(values, 'proof-digest', arm), 'proof-digest') };
        }
        if (action === 'queued') {
          return { action, finding, debtId: requireValue(values, 'debt-id', arm), debtDigest: requireDigest(requireValue(values, 'debt-digest', arm), 'debt-digest') };
        }
        return { action, finding, reason: requireValue(values, 'reason', arm) };
      })();
      const built = buildRoundLand({ planId, dispose, cwd, env, timestamp });
      const appended = appendFlowRecord({ cwd, record: built.record, env });
      const lines = [
        `flow-writer: revised chain/round for plan "${planId}" — step "${built.record.stepId}" cycle ${built.record.cycle} round ${built.record.round} — digest ${canonicalFlowDigest(appended.record)}`,
        `  store: ${appended.writtenPath}`,
        ...built.landed.map((l) => `  landed backend=${l.backend} nonce=${l.nonce}`),
        ...built.pending.map((p) => `  pending backend=${p.backend} nonce=${p.dispatchNonce} watermark=${p.receiptWatermark}`),
        ...(built.disposed != null ? [`  disposition ${built.disposed.action} findingDigest=${built.disposed.findingDigest}`] : []),
      ];
      return { code: 0, stdout: lines.join('\n'), stderr: '' };
    }

    if (arm === 'freeze' || arm === 'converged') {
      const { positionals } = parseFlags(rest, {});
      const built = buildStepTerminal({ purpose: arm, planId: onePlanId(positionals, arm), cwd, env, timestamp });
      const appended = appendFlowRecordWithPreflight({ cwd, record: built.record, env, deps: ctx.storeDeps ?? {}, preflight: built.preflight });
      return { code: 0, stdout: `flow-writer: appended chain/${arm} for plan "${built.record.planId}" — digest ${canonicalFlowDigest(appended.record)}\n  store: ${appended.writtenPath}`, stderr: '' };
    }

    if (arm === 'unfreeze') {
      const { values, positionals } = parseFlags(rest, { '--justification': 'value' });
      const built = buildUnfreeze({ planId: onePlanId(positionals, arm), justification: values.justification, cwd, env, timestamp });
      const appended = appendFlowRecord({ cwd, record: built.record, env });
      const lines = [
        `flow-writer: appended chain/unfreeze for plan "${built.record.planId}" — digest ${canonicalFlowDigest(appended.record)}`,
        `  store: ${appended.writtenPath}`,
        ...(built.justification != null ? [`  justification (Decision 8, over-cap mint — the record above is the durable trail): ${built.justification}`] : []),
      ];
      return { code: 0, stdout: lines.join('\n'), stderr: '' };
    }

    const record = (() => {
      if (arm === 'park' || arm === 'resume' || arm === 'complete') {
        const { positionals } = parseFlags(rest, {});
        return buildPlanLaneRecord({ purpose: arm, planId: onePlanId(positionals, arm), cwd, env, timestamp });
      }
      if (arm === 'refresh') {
        const { values, positionals } = parseFlags(rest, { '--cause': 'value', '--refreshed-record': 'value' });
        return buildRefreshRecord({
          planId: onePlanId(positionals, arm), cause: requireValue(values, 'cause', arm),
          refreshedRecord: requireDigest(requireValue(values, 'refreshed-record', arm), 'refreshed-record'), cwd, env, timestamp,
        });
      }
      if (arm === 're-baseline') {
        const { positionals } = parseFlags(rest, {});
        return buildReBaselineRecord({ planId: onePlanId(positionals, arm), cwd, env, timestamp });
      }
      if (arm === 'rerun-cause') {
        const { values, positionals } = parseFlags(rest, { '--attempt': 'value', '--cause': 'value' });
        if (positionals.length > 0) throw usageFail(`rerun-cause takes flags only (unexpected "${positionals[0]}")`);
        const tree = treeContext(cwd);
        return {
          schema: FLOW_SCHEMA_VERSION, kind: 'rerun-cause', fingerprint: tree.fingerprint,
          cause: requireValue(values, 'cause', arm), attempt: requireValue(values, 'attempt', arm), base: tree.base, timestamp,
        };
      }
      if (arm === 'down-mark') {
        const { values, positionals } = parseFlags(rest, { '--backend': 'value', '--reason': 'value', '--expires-at': 'value' });
        if (positionals.length > 0) throw usageFail(`down-mark takes flags only (unexpected "${positionals[0]}")`);
        const tree = treeContext(cwd);
        return {
          schema: FLOW_SCHEMA_VERSION, kind: 'down-mark', fingerprint: tree.fingerprint,
          backend: requireValue(values, 'backend', arm), reason: requireValue(values, 'reason', arm),
          expiresAt: requireValue(values, 'expires-at', arm), base: tree.base, timestamp,
        };
      }
      if (arm === 'down-mark-up' || arm === 'down-mark-clear') {
        const { values, positionals } = parseFlags(rest, { '--backend': 'value', '--target': 'value' });
        if (positionals.length > 0) throw usageFail(`${arm} takes flags only (unexpected "${positionals[0]}")`);
        return buildDownMarkFamilyRecord({
          kind: arm, backend: requireValue(values, 'backend', arm),
          target: values.target === undefined ? undefined : requireDigest(values.target, 'target'), cwd, env, timestamp,
        });
      }
      if (arm === 'degrade-justification') {
        const { values, positionals } = parseFlags(rest, { '--backend': 'value', '--down-mark': 'value', '--degrade-digest': 'value' });
        if (positionals.length > 0) throw usageFail(`degrade-justification takes flags only (unexpected "${positionals[0]}")`);
        return buildDegradeJustificationRecord({
          backend: requireValue(values, 'backend', arm),
          downMark: values['down-mark'] === undefined ? undefined : requireDigest(values['down-mark'], 'down-mark'),
          degradeDigest: values['degrade-digest'] === undefined ? undefined : requireDigest(values['degrade-digest'], 'degrade-digest'),
          cwd, env, timestamp,
        });
      }
      if (arm === 'consult-attestation') {
        const { values, positionals } = parseFlags(rest, { '--backend': 'value', '--nonce': 'value', '--proposed-fix-digest': 'value' });
        return buildConsultAttestation({
          planId: onePlanId(positionals, arm), backend: requireValue(values, 'backend', arm),
          nonce: requireValue(values, 'nonce', arm),
          proposedFixDigest: requireDigest(requireValue(values, 'proposed-fix-digest', arm), 'proposed-fix-digest'),
          cwd, env, timestamp,
        });
      }
      if (arm === 'internal-attestation') {
        const { values, positionals } = parseFlags(rest, { '--lens': 'list', '--degraded': 'list', '--model': 'value', '--effort': 'value', '--tier': 'value', '--authority': 'value' });
        if (!Array.isArray(values.lens) || values.lens.length === 0) {
          throw usageFail('internal-attestation requires at least one --lens <name> (the required-lens set, #28)');
        }
        return buildInternalAttestation({
          planId: onePlanId(positionals, arm), lenses: values.lens, degraded: values.degraded ?? [],
          model: requireValue(values, 'model', arm), effort: values.effort, tier: values.tier,
          authority: requireValue(values, 'authority', arm), cwd, env, timestamp, ctx,
        });
      }
      return null; // maintainer-override — handled below (it prints its bound set first)
    })();

    if (arm === 'maintainer-override') {
      const { values, positionals } = parseFlags(rest, { '--backend': 'value', '--checkpoint-approved': 'boolean', '--veto-receipt': 'value', '--chain-record': 'value' });
      const built = buildOverride({
        planId: onePlanId(positionals, arm), backend: requireValue(values, 'backend', arm),
        vetoReceipt: values['veto-receipt'] === undefined ? undefined : requireDigest(values['veto-receipt'], 'veto-receipt'),
        chainRecord: values['chain-record'] === undefined ? undefined : requireDigest(values['chain-record'], 'chain-record'),
        cwd, env, timestamp,
      });
      if (values['checkpoint-approved'] !== true) {
        return {
          code: 1,
          stdout: built.boundSet.join('\n'),
          stderr: 'flow-writer: maintainer-override requires the explicit --checkpoint-approved flag (#38) — the bound set above is what a checkpoint-approved re-run would record; nothing was written',
        };
      }
      const appended = appendFlowRecord({ cwd, record: built.record, env });
      return {
        code: 0,
        stdout: [...built.boundSet, `flow-writer: appended maintainer-override — digest ${canonicalFlowDigest(appended.record)}`, `  store: ${appended.writtenPath}`].join('\n'),
        stderr: '',
      };
    }

    const appended = appendFlowRecord({ cwd, record, env });
    const label = record.kind === CHAIN_KIND ? `chain/${record.purpose} for plan "${record.planId}"` : record.kind;
    return { code: 0, stdout: `flow-writer: appended ${label} — digest ${canonicalFlowDigest(appended.record)}\n  store: ${appended.writtenPath}`, stderr: '' };
  } catch (err) {
    // A store STOP passes through byte-verbatim (the "surfaces the store's own refusal
    // verbatim" contract); the flow-writer prefix marks only WRITER-owned failures.
    return { code: err.exitCode ?? 1, stdout: '', stderr: err.code === FLOW_STORE_STOP ? err.message : `flow-writer: ${err.message}` };
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const r = main(process.argv.slice(2));
  if (r.stdout) console.log(r.stdout);
  if (r.stderr) console.error(r.stderr);
  process.exit(r.code);
}
