import { bulletBlocks, isSweep } from './plan-shape.mjs';
import { canonicalHeading } from './queue-audit.mjs';
import { CARRY_WORK, CLASSES, leadMarkers, titleOf } from './queue-audit-rows.mjs';

export const NOW_STATUS = Object.freeze({
  LANDED: 'landed',
  IN_PROGRESS: 'in progress',
  PENDING: 'pending',
  UNJUDGED: 'unjudged',
});

export const NOW_ANNOTATION = Object.freeze({
  CLAIM: 'claim',
  ANOMALY: 'anomaly',
  RED_PROOF: 'red-proof',
});

const EVIDENCE_SOURCE = Object.freeze({
  PATH: 'path fact',
  CHANGED: 'changed set',
  EXCLUSION: 'exclusion fact',
});
const PHASE_PREFIX = '## Phase: ';
const PRIORITY_HEADING = canonicalHeading('## Pending / backlog');

export const isWithheld = (block) => typeof block?.withheld === 'string';
const CHECKED_TASK = /(?:^|\s)\[[xX]\](?:\s|$)/;

const getResponsibility = (raw) => String(raw ?? '').split(' | ')[3] ?? '';
const getJudgedProse = (raw) => titleOf([getResponsibility(raw)]).judged;

export const readProseClaim = (raw) => {
  const prose = getJudgedProse(raw);
  return CHECKED_TASK.test(prose) || leadMarkers(prose).length > 0 ? 'done' : null;
};

const getChangedDetail = ({ staged, unstaged, untracked }) => {
  const parts = [staged ? 'staged' : null, unstaged ? 'unstaged' : null, untracked ? 'untracked' : null].filter(Boolean);
  return parts.join(', ');
};

const getPathDecision = (row, evidence) => {
  const pathFact = evidence.pathFact;
  if (!pathFact) return { status: NOW_STATUS.UNJUDGED, detail: 'path fact unavailable', evidenceSource: EVIDENCE_SOURCE.PATH };
  const present = pathFact.kind !== 'absent';
  if (row.verb === 'create') {
    return { status: present ? NOW_STATUS.LANDED : NOW_STATUS.PENDING, detail: null, evidenceSource: EVIDENCE_SOURCE.PATH };
  }
  if (row.verb === 'delete') {
    return { status: present ? NOW_STATUS.PENDING : NOW_STATUS.LANDED, detail: null, evidenceSource: EVIDENCE_SOURCE.PATH };
  }
  if (!present) return { status: NOW_STATUS.PENDING, detail: 'post-state unmet', evidenceSource: EVIDENCE_SOURCE.PATH };
  return {
    status: NOW_STATUS.UNJUDGED,
    detail: evidence.excluded === true ? 'excluded from git here, no changed-set evidence' : 'no base-motion reader',
    evidenceSource: EVIDENCE_SOURCE.EXCLUSION,
  };
};

const getAnnotations = (row, evidence, status) => {
  const claim = readProseClaim(row.raw) && status !== NOW_STATUS.LANDED
    ? [{ kind: NOW_ANNOTATION.CLAIM, text: 'claimed done' }]
    : [];
  const overBudget = row.budgetLines && evidence.pathFact?.kind === 'regular' && evidence.pathFact.lines > row.budgetLines
    ? [{ kind: NOW_ANNOTATION.ANOMALY, text: `over budget ${evidence.pathFact.lines}/${row.budgetLines}` }]
    : [];
  const redProof = evidence.redProof
    ? [{ kind: NOW_ANNOTATION.RED_PROOF, text: evidence.redProof.currency ?? String(evidence.redProof) }]
    : [];
  return [...claim, ...overBudget, ...redProof];
};

// A set has no single post-state, so a sweep row is reduced only under modify: the verb refuses it before any evidence arm.
const SWEEP_VERB_REFUSAL = Object.freeze({ status: NOW_STATUS.UNJUDGED, detail: 'a sweep row is judged as a set only under modify', evidenceSource: EVIDENCE_SOURCE.PATH });

export const judgeRow = (row, evidence = {}) => {
  const changed = Boolean(evidence.staged || evidence.unstaged || evidence.untracked);
  const decision = isSweep(row.path) && row.verb !== 'modify'
    ? SWEEP_VERB_REFUSAL
    : changed
      ? { status: NOW_STATUS.IN_PROGRESS, detail: getChangedDetail(evidence), evidenceSource: EVIDENCE_SOURCE.CHANGED }
      : getPathDecision(row, evidence);
  return { row, ...decision, annotations: getAnnotations(row, evidence, decision.status) };
};

const getPhaseSteps = (parsed, heading) => {
  const document = parsed.document;
  const next = document.headings.find((candidate) => candidate.index > heading.index && candidate.level <= heading.level);
  const end = next?.index ?? document.lines.length;
  return bulletBlocks(document.lines, document.fencedLines, heading.index + 1, end).map((block) => ({
    name: block.lines.join(' ').replace(/^-\s+/, '').replace(/\s+/g, ' ').trim(),
    status: NOW_STATUS.UNJUDGED,
    detail: 'no evidence reader',
    evidenceSource: null,
    annotations: [],
  }));
};

const getMarkers = (name, steps) => {
  const currentIndex = steps.findIndex(({ status }) => status !== NOW_STATUS.LANDED && status !== NOW_STATUS.IN_PROGRESS);
  return {
    name,
    steps,
    inProgress: steps.filter(({ status }) => status === NOW_STATUS.IN_PROGRESS),
    current: currentIndex < 0 ? null : steps[currentIndex],
    next: currentIndex < 0 ? null : steps[currentIndex + 1] ?? null,
  };
};

export const derivePhase = (parsed, judged) => {
  const complete = judged.length > 0 && judged.every(({ status }) => status === NOW_STATUS.LANDED);
  if (!complete) return getMarkers('ledger', judged);
  const verification = parsed.document.headings.find(({ text }) => text === '## Verification');
  const heading = parsed.document.headings.find(({ index, text }) => index > verification.index && text.startsWith(PHASE_PREFIX));
  const steps = heading ? getPhaseSteps(parsed, heading) : [];
  return getMarkers(heading ? heading.text.slice(PHASE_PREFIX.length) : 'Cleanup', steps);
};

const getBucketKey = (buckets) => JSON.stringify(buckets ?? []);
const getBucketLabel = (buckets) => buckets.length === 0
  ? 'document'
  : buckets.map(({ text, line }) => `${text} (line ${line})`).join(' > ');
const isPriorityBucket = (buckets) => buckets.some(({ level, text }) => level === 2 && canonicalHeading(text) === PRIORITY_HEADING);
const getCounts = (rows) => Object.fromEntries(CLASSES.map((klass) => [klass, rows.filter((row) => row.klass === klass).length]));

export const foldQueue = (rows) => {
  const folded = rows.reduce((buckets, row) => {
    const path = row.buckets ?? [];
    const key = getBucketKey(path);
    const found = buckets.find((bucket) => bucket.key === key);
    const entry = {
      name: row.name || `unnamed (line ${row.line})`,
      line: row.line,
      klass: row.klass,
      evidence: row.evidence,
      position: (found?.rows.length ?? 0) + 1,
    };
    const entries = CARRY_WORK.has(row.klass) ? [...(found?.rows ?? []), entry] : found?.rows ?? [];
    return found
      ? buckets.map((bucket) => bucket.key === key ? { ...bucket, sourceRows: [...bucket.sourceRows, row], rows: entries } : bucket)
      : [...buckets, { key, path, label: getBucketLabel(path), order: isPriorityBucket(path) ? 'priority' : 'position', sourceRows: [row], rows: entries }];
  }, []);
  const buckets = folded.map(({ key, sourceRows, ...bucket }) => ({ ...bucket, counts: getCounts(sourceRows) }));
  return { buckets, counts: getCounts(rows), total: rows.length };
};
