#!/usr/bin/env node
// flow-writer.mjs — the flow-store writer CLI (flow-orchestration, Plan 3 Step 3.2). The explicit
// arm set is Decision 8: park / resume / complete / adoption / refresh / re-baseline /
// rerun-cause / down-mark / down-mark-up / down-mark-clear / degrade-justification /
// maintainer-override / consult-attestation — EVERY record class a Plan-3 refusal names as its
// recovery has a pasteable mint arm here, so an armed chain can never become unrecoverably red.
// (round / freeze / unfreeze / converged / internal-attestation minting rides Plan 4 with the
// dogfood round machinery.) The consult-attestation arm (Phase 4.2, Decision 8) binds {backend,
// nonce, findingDigest} FROM the wrapper-minted finding manifest — the digest is computed over the
// manifest's findings payload, never hand-supplied — while proposedFixDigest stays the EXPLICIT
// consult-time input (the digest of the proposed-fix payload the orchestrator submits).
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
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import {
  FLOW_SCHEMA_VERSION, CHAIN_KIND, canonicalFlowDigest, flowTreeIdentity,
  SAFE_NONCE_RE, findingManifestBasename, decodeFindingManifest,
} from './flow-record.mjs';
import {
  FLOW_STORE_STOP, resolveFlowStorePath, readFlowStore, deriveFlowOwner, walkChainState,
  appendFlowRecord, mintAdoption, readPlanFrontmatterId, resolveRecordReference,
} from './flow-store.mjs';
import { readFileBytesNoFollow } from './flow-store-read.mjs';
import {
  resolveBase, computeTreeFingerprint, lexicalRepoRelative,
  resolveReceiptsPath, readReceipts, summarizeReviewReceiptsForTree,
  resolveEvidencePath, readEvidence, authoritativeOfKind,
  isRecognizedVerdict, isShipVerdict,
} from './core-evidence.mjs';
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

// parseFlags(rest, spec) → { values, positionals }. spec: { '--flag': 'value' | 'boolean' }.
// A literal `--` terminates flag parsing (every later token is a positional — the lane a
// leading-dash operand rides), and a value flag accepts the inline `--flag=value` form (the lane
// a leading-dash VALUE rides) — the checker's printed recoveries compose exactly these shapes.
const parseFlags = (rest, spec) => {
  const values = {};
  const positionals = [];
  let terminated = false;
  const set = (flag, value) => {
    if (values[flag.slice(2)] !== undefined) throw usageFail(`duplicate flag: ${flag}`);
    values[flag.slice(2)] = value;
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
      if (spec[flag] !== 'value') throw usageFail(spec[flag] === 'boolean' ? `${flag} takes no value` : `unknown flag: ${flag}`);
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
  const receiptsPath = resolveReceiptsPath(cwd, env);
  if (receiptsPath == null) throw refuse('the receipts path is unresolvable (no git dir and no AW_REVIEW_RECEIPTS) — the finding manifest lives beside the receipts file (fail closed)');
  const basename = findingManifestBasename(backend, nonce);
  if (basename == null) throw refuse(`no manifest name composes for {backend ${JSON.stringify(backend)}, nonce ${JSON.stringify(nonce)}} under the safe grammar — an unsafe token never resolves a manifest (fail closed)`);
  const manifestPath = join(dirname(receiptsPath), basename);
  // The kit's ONE race-free reader: an attestation never binds through a link, a FIFO can never
  // block the mint, and a foreign node refuses by class (the wrapper mints regular files only).
  const read = readFileBytesNoFollow(manifestPath);
  if (read.outcome === 'absent') {
    throw refuse(`no readable finding manifest for {backend "${backend}", nonce "${nonce}"} at ${manifestPath} (ENOENT) — the wrapper mints it on a nonce-supplied dispatch; a consult binds a real manifest (fail closed)`);
  }
  if (read.outcome === 'foreign') {
    throw refuse(`the finding manifest at ${manifestPath} is a ${read.className}, not a regular file — an attestation never binds through a symlink or a FIFO (fail closed)`);
  }
  if (read.outcome !== 'ok') {
    throw refuse(`the finding manifest at ${manifestPath} is unreadable (${read.code}) — fail closed`);
  }
  const decoded = decodeFindingManifest(read.bytes);
  if (!decoded.ok) throw refuse(`the finding manifest at ${manifestPath} is malformed — ${decoded.reason} — it never mints a consult-attestation`);
  const manifest = decoded.manifest;
  if (manifest.backend !== backend || manifest.nonce !== nonce) {
    throw refuse(`the finding manifest at ${manifestPath} declares {backend "${manifest.backend}", nonce "${manifest.nonce}"} — a foreign-identity manifest never mints a consult-attestation (fail closed)`);
  }
  return {
    schema: FLOW_SCHEMA_VERSION, kind: 'consult-attestation', fingerprint: tree.fingerprint,
    backend, nonce, planId, cycle: state.cycle, stepId: state.stepId, round: state.round,
    findingDigest: createHash('sha256').update(manifest.findings, 'utf8').digest('hex'),
    proposedFixDigest, base: tree.base, timestamp,
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

const ARMS = ['park', 'resume', 'complete', 'adoption', 'refresh', 're-baseline', 'rerun-cause', 'down-mark', 'down-mark-up', 'down-mark-clear', 'degrade-justification', 'maintainer-override', 'consult-attestation', 'write-plan-id'];

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
  node flow-writer.mjs write-plan-id <plan-file> --plan-id <id>

Operand shapes: a positional may follow a literal -- and a value flag accepts --flag=<value>
(the lanes a leading-dash operand rides; printed recoveries compose exactly these shapes).
Every arm computes its tree context (owner, base, fingerprint; cycle/round from the chain walk)
and appends through the lock-serialized store append — an illegal transition surfaces the store's
own refusal verbatim; the writer adds NO second validator. Chain arms refuse a foreign worktree's
chain (#57). maintainer-override prints its FULL bound set and requires --checkpoint-approved
(#38). write-plan-id is bounded to an existing regular file under ${PLANS_DIR}/ (same-id
idempotent, different-id refuses, contained-atomic; #58).

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
