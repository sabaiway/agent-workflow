import { createHash } from 'node:crypto';
import { escapeForDisplay } from './repo-lex.mjs';
import { SIGNALS, signalFor } from './review-rounds.mjs';
import { authoritativeFlowRecords, canonicalFlowDigest, flowRecordKey } from './flow-record.mjs';
import { isNonEmptyString, isPlainObject, refuse } from './flow-vocabulary.mjs';
import { isShipVerdict } from './core-evidence.mjs';

const sha256 = (value) => createHash('sha256').update(value, typeof value === 'string' ? 'utf8' : undefined).digest('hex');
const item = (text) => ({ text, digest: sha256(text) });
const linesOf = (payload) => String(payload).split('\n').map((line) => line.replace(/\r$/, ''));
const codexSchema = (payload) => {
  let decoded;
  try {
    decoded = JSON.parse(payload);
  } catch {
    return null;
  }
  const severities = ['blocker', 'major', 'minor', 'nit'];
  return isPlainObject(decoded)
    && ['ship', 'revise', 'rethink'].includes(decoded.verdict)
    && Array.isArray(decoded.findings)
    && decoded.findings.every((finding) => isPlainObject(finding) && severities.includes(finding.severity))
    ? decoded : null;
};

export const blockingItems = (backend, payload) => {
  if (backend === 'codex') {
    const decoded = codexSchema(payload);
    if (decoded) {
      const selected = decoded.findings.filter(({ severity }) => severity === 'blocker' || severity === 'major');
      if (!selected.every(({ issue }) => isNonEmptyString(issue))) return refuse('codex schema blocking item issue is empty or not a string');
      return { ok: true, mode: 'schema', items: selected.map(({ issue }) => item(issue)) };
    }
    return { ok: true, mode: 'text', items: linesOf(payload).filter((line) => /^\[(blocker|major)\](\s|$)/.test(line)).map(item) };
  }
  if (backend === 'agy') {
    const lines = linesOf(payload);
    const open = lines.findIndex((line) => /^### Blocking\s*$/.test(line));
    const close = lines.findIndex((line, index) => index > open && /^### /.test(line));
    const section = open < 0 ? [] : lines.slice(open + 1, close < 0 ? undefined : close);
    return { ok: true, mode: 'text', items: section.filter((line) => /^[0-9]+[.)]/.test(line)).map(item) };
  }
  return refuse(`cannot enumerate backend ${JSON.stringify(backend)} — no blocking-item vocabulary predicate`);
};

export const findingQuoted = (backend, findings, quote) => findings.includes(quote)
  || (backend === 'codex' && codexSchema(findings)?.findings.some(({ issue }) => issue === quote) === true);

const landed = (head, receipts) => head.dispatches
  .filter(({ receiptDigest }) => receiptDigest !== null)
  .map((entry) => ({ entry, receipt: receipts.get(entry.receiptDigest) }))
  .filter(({ receipt }) => receipt !== undefined);

export const roundsForSignal = (heads, receipts) => {
  const rounds = heads.map((head) => ({
    fingerprint: head.fingerprint,
    byBackend: Object.fromEntries(landed(head, receipts).map(({ entry, receipt }) => [entry.backend, receipt])),
  }));
  const backends = [...new Set((heads.length ? landed(heads.at(-1), receipts) : []).map(({ entry }) => entry.backend))];
  return {
    rounds,
    obligation: backends.length ? { backends, perBackend: true, minShip: backends.length } : null,
  };
};

const lossName = (read, expected) => {
  if (read?.outcome !== 'ok') return read?.outcome ?? 'error';
  return sha256(read.bytes) === expected ? null : 'swapped';
};
const quoteCovered = (ledger, digest) => ledger.some((entry) => entry.findingDigest === digest
  && (['folded', 'rejected', 'escalated'].includes(entry.action)
    || (entry.action === 'queued' && ['claim', 'proofKind', 'proofDigest'].every((key) => key in entry))));

export const capIssue = ({ heads, receipts, readManifest }) => {
  const { rounds, obligation } = roundsForSignal(heads, receipts);
  if (obligation === null) return { issue: null, advisories: [] };
  const signal = signalFor(rounds, obligation, '<artifact>');
  if (signal !== SIGNALS.CAP_REACHED && signal !== SIGNALS.CROSSOVER) return { issue: null, advisories: [] };
  const head = heads.at(-1);
  const ledger = head.dispositions;
  const advisories = [];
  const issues = [];
  const uncovered = [];
  for (const { entry, receipt } of landed(head, receipts)) {
    if (ledger.some((disposition) => disposition.action === 'custody-lost' && disposition.receiptDigest === entry.receiptDigest)) continue;
    const needsFallbackDisposition = !isShipVerdict(receipt.verdict) && ledger.length === 0;
    if (!Number.isInteger(receipt.blocking) || receipt.blocking < 0) {
      const why = `blocking ${JSON.stringify(receipt.blocking)} is not a non-negative integer for backend ${JSON.stringify(entry.backend)}`;
      advisories.push(`advisory: ${why}`);
      if (needsFallbackDisposition) issues.push(`enumeration fallback requires at least one disposition in round ${head.round}: ${why}`);
      continue;
    }
    if (receipt.blocking === 0) continue;
    const read = readManifest(entry.backend, entry.dispatchNonce);
    const loss = lossName(read, entry.findingManifestDigest);
    if (loss !== null) {
      const covered = ledger.some((d) => d.action === 'custody-lost' && d.receiptDigest === entry.receiptDigest);
      if (!covered) issues.push(`lost receipt ${entry.receiptDigest} (${loss}); recovery: round-land --dispose custody-lost --receipt ${entry.receiptDigest}`);
      continue;
    }
    const enumerated = blockingItems(entry.backend, read.manifest.findings);
    if (!enumerated.ok || enumerated.items.length !== receipt.blocking) {
      const why = !enumerated.ok ? enumerated.reason : `enumerated count ${enumerated.items.length} differs from blocking ${receipt.blocking} for backend ${JSON.stringify(entry.backend)}`;
      advisories.push(`advisory: ${why}`);
      if (ledger.length === 0) issues.push(`enumeration fallback requires at least one disposition in round ${head.round}: ${why}`);
      continue;
    }
    for (const found of enumerated.items) if (!quoteCovered(ledger, found.digest)) uncovered.push(found);
  }
  if (uncovered.length) {
    issues.push(`uncovered blocking items:\n${uncovered.map(({ digest, text }) => `${digest}  ${escapeForDisplay(text)}`).join('\n')}\nrecovery: round-land --dispose <folded|queued|rejected|escalated> --finding <the item text> on the SAME tree`);
  }
  return { issue: issues.length ? issues.join('\n') : null, advisories };
};

export const walkIssue = ({ records, planId, cycle, stepId, round, base, fingerprint }) => {
  if (round <= 1) return null;
  const coordinates = { kind: 'internal-attestation', planId, cycle, stepId, round: round - 1, base, fingerprint };
  const wanted = flowRecordKey(coordinates);
  const found = authoritativeFlowRecords(records).find((record) => flowRecordKey(record) === wanted);
  return found?.walk ? null
    : `round-open round ${round} requires an authoritative walk for round ${round - 1} at {planId=${planId}, cycle=${cycle}, stepId=${stepId}, round=${round - 1}, base=${base}, fingerprint=${fingerprint}}; recovery: internal-attestation ${planId} --walk <file> at the current tree, or --justification <text>`;
};

export const escalationIssue = ({ records, digest, planId, head }) => {
  const override = records.find((record) => record.kind === 'maintainer-override' && canonicalFlowDigest(record) === digest);
  if (!override) return { issue: `override digest ${digest} does not resolve to a maintainer-override`, dispatch: null };
  const chain = records.find((record) => record.kind === 'chain' && canonicalFlowDigest(record) === override.chainRecord);
  if (!chain || chain.planId !== planId) return { issue: `override ${digest} does not bind a chain record of plan ${planId}`, dispatch: null };
  const dispatch = head.dispatches.find(({ receiptDigest }) => receiptDigest === override.vetoReceiptDigest);
  return dispatch
    ? { issue: null, dispatch }
    : { issue: `override ${digest} does not bind a landed receipt of plan ${planId} round ${head.round}`, dispatch: null };
};

export const validateWalk = (walk, coverage) => {
  if (!isPlainObject(walk) || Object.keys(walk).some((key) => !['listVersion', 'rows'].includes(key)) || !Array.isArray(walk.rows)) return refuse('walk must be the closed {listVersion, rows} object');
  if (walk.listVersion !== coverage.listVersion) return refuse(`walk listVersion ${JSON.stringify(walk.listVersion)} does not match shipped listVersion ${coverage.listVersion}`);
  for (const [i, entry] of walk.rows.entries()) {
    if (!isPlainObject(entry) || Object.keys(entry).length !== 3 || !['id', 'class', 'checked'].every((key) => key in entry) || !isNonEmptyString(entry.id) || !isNonEmptyString(entry.class)) return refuse(`walk rows[${i}] must be the closed {id, class, checked} non-empty string object`);
    if (!isNonEmptyString(entry.checked)) return refuse(`walk checked for ${entry.id}:${entry.class} must be a non-empty string`);
  }
  const judged = coverage.rows.filter((row) => !row.deleted && !row.absent);
  for (const row of judged) {
    for (const classId of new Set([...row.tagged, ...row.present])) {
      if (!walk.rows.some((entry) => entry.id === row.id && entry.class === classId && isNonEmptyString(entry.checked))) return refuse(`walk is missing non-empty checked for ${row.id}:${classId}`);
    }
  }
  const uncovered = judged.flatMap((row) => row.present.filter((classId) => !row.tagged.includes(classId)).map((classId) => ({ id: row.id, class: classId })));
  return { ok: true, walk: { listVersion: coverage.listVersion, rows: walk.rows, uncovered } };
};
