import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANDIDATE_STATES, isDeployed, judgeCheckerGates } from './checker-gates-read.mjs';
import { CONFIG_REL, validateConfig } from './orchestration-config.mjs';
import { TIER_TARGETS } from './reference-profile.mjs';
import {
  RULES_REGIONS,
  extractRegionBy,
  readTemplateSpan,
  planInsert,
  frontmatterMaxLines,
  decodeUtf8Strict,
  buildInsertPreview,
} from './rules-regions.mjs';

const GAP_ID = 'story-sessions-section';
const SLOTS_ID = 'epic-task-slots';
const STORE_ID = 'epic-store-seeded';
const STORE_PATH = 'docs/ai/epics';
const CHECKER_GATES_ID = 'checker-gates-declared';
const TIER_PREVIEW_PATH = fileURLToPath(new URL('./tier-preview.mjs', import.meta.url));
const CHECKER_GATES_PATH = fileURLToPath(new URL('./checker-gates.mjs', import.meta.url));
const UNDECIDED_STATES = [CANDIDATE_STATES.idTaken, CANDIDATE_STATES.probeUnreadable, CANDIDATE_STATES.withheld];
const STORY_ID = 'story-sessions';
const TEMPLATE_CANON = 'template';
const ENCODING = 'utf8';
const MISSING_FILE_CODE = 'ENOENT';
const SINGLE_HEADING = 1;
const TARGET_PATH = 'docs/ai/agent_rules.md';
const TEMPLATE_PATH = fileURLToPath(new URL('../references/templates/agent_rules.md', import.meta.url));
const VERDICTS = Object.freeze({
  present: 'present',
  absent: 'absent',
  undecidable: 'undecidable',
});
const REASONS = Object.freeze({
  template: 'template',
  fileAbsent: 'file-absent',
  fileSymlink: 'file-symlink',
  fileUnreadable: 'file-unreadable',
  noDeployment: 'no-deployment',
  configAbsent: 'config-absent',
  configSymlink: 'config-symlink',
  configUnreadable: 'config-unreadable',
  configMalformed: 'config-malformed',
  configInvalid: 'config-invalid',
  storeNotDirectory: 'store-not-directory',
  storeSymlink: 'store-symlink',
  storeUnreadable: 'store-unreadable',
});
const TEMPLATE_REGIONS = RULES_REGIONS.filter(({ canon }) => canon === TEMPLATE_CANON);
const STORY_REGION = RULES_REGIONS.find(({ id }) => id === STORY_ID);

const reportUndecidable = (reason) => ({ verdict: VERDICTS.undecidable, reason });

const readSpans = (deps) => {
  try {
    const template = deps.readFileSync(TEMPLATE_PATH, ENCODING);
    const entries = TEMPLATE_REGIONS.map(({ id, headingRe }) => [
      id, readTemplateSpan(template, headingRe),
    ]);
    const spans = Object.fromEntries(entries);
    if (Object.values(spans).some(({ defect }) => defect)) {
      return reportUndecidable(REASONS.template);
    }
    return { spans };
  } catch {
    return reportUndecidable(REASONS.template);
  }
};

const readTarget = (root, deps) => {
  const target = resolve(root, TARGET_PATH);
  try {
    const stat = deps.lstatSync(target);
    if (stat.isSymbolicLink()) return reportUndecidable(REASONS.fileSymlink);
    if (!stat.isFile()) return reportUndecidable(REASONS.fileUnreadable);
  } catch (error) {
    const reason = error?.code === MISSING_FILE_CODE ? REASONS.fileAbsent : REASONS.fileUnreadable;
    return reportUndecidable(reason);
  }
  try {
    return { text: decodeUtf8Strict(deps.readFileSync(target)) };
  } catch {
    return reportUndecidable(REASONS.fileUnreadable);
  }
};

const detectStorySessions = ({ root, deps }) => {
  const template = readSpans(deps);
  if (template.verdict) return template;
  const target = readTarget(root, deps);
  if (target.verdict) return target;
  const { text } = target;
  if (extractRegionBy(text, STORY_REGION.headingRe).count === SINGLE_HEADING) {
    return { verdict: VERDICTS.present };
  }
  const result = planInsert({ text, spans: template.spans, cap: frontmatterMaxLines(text) });
  if (result.refusal) return reportUndecidable(result.refusal);
  return { verdict: VERDICTS.absent };
};

const parseConfig = (bytes) => {
  let parsed;
  try {
    parsed = JSON.parse(decodeUtf8Strict(bytes));
  } catch (error) {
    return error instanceof SyntaxError ? { reason: REASONS.configMalformed } : { reason: REASONS.configUnreadable };
  }
  try {
    return { config: validateConfig(parsed) };
  } catch {
    return { reason: REASONS.configInvalid };
  }
};

export const readTierConfig = (root, deps) => {
  const path = resolve(root, CONFIG_REL);
  try {
    const stat = deps.lstatSync(path);
    if (stat.isSymbolicLink()) return { reason: REASONS.configSymlink };
    if (!stat.isFile()) return { reason: REASONS.configUnreadable };
  } catch (error) {
    return { reason: error?.code === MISSING_FILE_CODE ? REASONS.configAbsent : REASONS.configUnreadable };
  }
  let bytes;
  try {
    bytes = deps.readFileSync(path);
  } catch {
    return { reason: REASONS.configUnreadable };
  }
  return parseConfig(bytes);
};

const detectSlots = ({ root, deps }) => {
  if (!isDeployed(root, deps)) return reportUndecidable(REASONS.noDeployment);
  const read = readTierConfig(root, deps);
  if (read.reason) return reportUndecidable(read.reason);
  const declared = TIER_TARGETS.every(({ activity, slot }) => Object.hasOwn(read.config[activity] ?? {}, slot));
  return { verdict: declared ? VERDICTS.present : VERDICTS.absent };
};

const detectStore = ({ root, deps }) => {
  if (!isDeployed(root, deps)) return reportUndecidable(REASONS.noDeployment);
  let stat;
  try {
    stat = deps.lstatSync(resolve(root, STORE_PATH));
  } catch (error) {
    if (error?.code === MISSING_FILE_CODE) return { verdict: VERDICTS.absent };
    return reportUndecidable(REASONS.storeUnreadable);
  }
  if (stat.isSymbolicLink()) return reportUndecidable(REASONS.storeSymlink);
  if (!stat.isDirectory()) return reportUndecidable(REASONS.storeNotDirectory);
  return { verdict: VERDICTS.present };
};

const detectCheckerGates = ({ root, deps }) => {
  const judged = judgeCheckerGates(root, deps);
  if (judged.refusal) return reportUndecidable(judged.refusal);
  if (judged.candidates.some(({ state }) => state === CANDIDATE_STATES.offered)) return { verdict: VERDICTS.absent };
  const undecided = judged.candidates.find(({ state }) => UNDECIDED_STATES.includes(state));
  return undecided ? reportUndecidable(undecided.state) : { verdict: VERDICTS.present };
};

const tierPreview = (root) => buildInsertPreview(root, TIER_PREVIEW_PATH);

export const PROFILE_GAPS = Object.freeze([
  Object.freeze({ id: GAP_ID, detect: detectStorySessions, apply: (root) => buildInsertPreview(root) }),
  Object.freeze({ id: SLOTS_ID, detect: detectSlots, apply: tierPreview }),
  Object.freeze({ id: STORE_ID, detect: detectStore, apply: tierPreview }),
  Object.freeze({ id: CHECKER_GATES_ID, detect: detectCheckerGates, apply: (root) => buildInsertPreview(root, CHECKER_GATES_PATH) }),
]);
