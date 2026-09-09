import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { buildSummaryState, isTreeClean } from './core-evidence.mjs';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';
import { resolveGitLocation } from './git-env.mjs';
import { auditQueue } from './queue-audit.mjs';
import { loadSourceSizeConfig, practiceFacts } from './source-size-config.mjs';
import { gatherPlanFacts, readSummaryFacts } from './now-plan-facts.mjs';
import { isWithheld } from './now-status.mjs';

const QUEUE_REL = 'docs/plans/queue.md';
const BLOCKS = Object.freeze(['plans', 'tree', 'queue', 'campaign']);

const attempt = (label, read) => {
  try {
    return read();
  } catch (error) {
    return { withheld: `${label}: ${error?.message ?? error}` };
  }
};

const readQueueFacts = (cwd, deps) => {
  const read = readRegularFileNoFollow(join(cwd, QUEUE_REL), deps.io ?? {});
  if (read.outcome !== 'ok') throw new Error(`${QUEUE_REL} is not a readable regular file (${read.className ?? read.code ?? read.outcome})`);
  const { rows, counts, total } = auditQueue(read.content, { label: QUEUE_REL });
  return { path: QUEUE_REL, rows, counts, total };
};

// The practice is opt-in: an absent declaration is a rendered STATE, only an unreadable one is withheld.
const readCampaignFacts = (cwd, deps) => {
  const loaded = loadSourceSizeConfig(cwd, deps);
  return loaded.state === 'absent' ? { state: loaded.state } : { state: loaded.state, ...practiceFacts(loaded.config) };
};

// A store the summary cannot trust never attests: the tree is withheld with the store's own cause.
const describeUntrustedStore = (summary) => {
  if (summary.evidenceUnavailable) return `the core-evidence store is malformed or unreadable (${summary.storeReadError ?? `${summary.storeMalformed} malformed line(s)`})`;
  if (summary.receiptsUnavailable) return `the review receipts store is malformed or unreadable (${summary.receiptsReadError ?? `${summary.receiptsMalformed} malformed line(s)`})`;
  return null;
};

const toTreeFacts = (summary, clean) => {
  const untrusted = describeUntrustedStore(summary);
  if (untrusted) return { withheld: untrusted };
  const { redProofs, receipts } = readSummaryFacts(summary);
  return { fingerprint: summary.fingerprint, clean, verdicts: receipts.verdicts, finalRun: receipts.finalRun, redProofs };
};

export const gatherNowFacts = ({ cwd, env: given = process.env, deps = {} }) => {
  // Every reader honouring an env argument spawns under this one: a plain `git diff` rewrites .git/index without the flag.
  const env = { ...given, GIT_OPTIONAL_LOCKS: '0' };
  const location = resolveGitLocation(cwd, { spawn: deps.spawn ?? spawnSync, env });
  if (location.state !== 'work-tree') {
    const withheld = `${cwd} is not a git work tree (${location.state}: ${location.cause})`;
    return Object.fromEntries(BLOCKS.map((block) => [block, { withheld }]));
  }
  const root = location.top;
  const summary = attempt('the evidence summary', () => deps.summary ?? buildSummaryState({ cwd: root, env }));
  return {
    plans: attempt('the plans in flight', () => ({
      entries: gatherPlanFacts({ cwd: root, env, deps }).plans,
    })),
    tree: isWithheld(summary) ? summary : attempt('the tree state', () => toTreeFacts(summary, isTreeClean(root, { env }))),
    queue: attempt('the queue', () => readQueueFacts(root, deps)),
    campaign: attempt('the practice', () => readCampaignFacts(root, deps)),
  };
};
