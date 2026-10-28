import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANDIDATE_STATES, isDeployed, judgeCheckerGates } from './checker-gates-read.mjs';
import { CONFIG_REL, validateConfig } from './orchestration-config.mjs';
import { TIER_TARGETS, isDeclineCurrent } from './reference-profile.mjs';

const SLOTS_ID = 'epic-task-slots';
const STORE_ID = 'epic-store-seeded';
const STORE_PATH = 'docs/ai/epics';
const CHECKER_GATES_ID = 'checker-gates-declared';
const QUEUE_SEED_ID = 'named-queue-row-seed';
const PLANS_PATH = 'docs/plans';
const QUEUE_PATH = 'docs/plans/queue.md';
const QUEUE_SEED_PATH = fileURLToPath(new URL('../references/authoring/QUEUE_TEMPLATE.md', import.meta.url));
const ABSENT_ARM_CODES = new Set(['ENOENT', 'ENOTDIR']);
const TIER_PREVIEW_PATH = fileURLToPath(new URL('./tier-preview.mjs', import.meta.url));
const CHECKER_GATES_PATH = fileURLToPath(new URL('./checker-gates.mjs', import.meta.url));
const UNDECIDED_STATES = [CANDIDATE_STATES.idTaken, CANDIDATE_STATES.probeUnreadable, CANDIDATE_STATES.withheld];
const MISSING_FILE_CODE = 'ENOENT';
const UTF8_LABEL = 'utf-8';
const UTF8_ENCODING = 'utf8';
const ROUND_TRIP_MESSAGE = 'the bytes read do not survive a UTF-8 round trip';
const COMMAND_UNSAFE_RE = /[\u0000-\u001f\u007f`]/;
const SHELL_PLAIN_RE = /^[A-Za-z0-9_./-]+$/;
const SINGLE_QUOTE = "'";
const QUOTE_ESCAPE = "'\\''";
const VERDICTS = Object.freeze({
  present: 'present',
  absent: 'absent',
  undecidable: 'undecidable',
});
const REASONS = Object.freeze({
  noDeployment: 'no-deployment',
  configAbsent: 'config-absent',
  configSymlink: 'config-symlink',
  configUnreadable: 'config-unreadable',
  configMalformed: 'config-malformed',
  configInvalid: 'config-invalid',
  storeNotDirectory: 'store-not-directory',
  storeSymlink: 'store-symlink',
  storeUnreadable: 'store-unreadable',
  plansSymlink: 'plans-symlink',
  plansNotDirectory: 'plans-not-directory',
  plansUnreadable: 'plans-unreadable',
  queueSymlink: 'queue-symlink',
  queueNotRegular: 'queue-not-regular',
  queueUnreadable: 'queue-unreadable',
  seedUnreadable: 'seed-unreadable',
});

const reportUndecidable = (reason) => ({ verdict: VERDICTS.undecidable, reason });

// The bytes as text when they survive a strict UTF-8 round trip; a leading byte-order mark is kept.
export const decodeUtf8Strict = (bytes) => {
  const text = new TextDecoder(UTF8_LABEL, { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!Buffer.from(text, UTF8_ENCODING).equals(bytes)) throw new Error(ROUND_TRIP_MESSAGE);
  return text;
};

const shellWord = (path) => (SHELL_PLAIN_RE.test(path)
  ? path
  : SINGLE_QUOTE + path.split(SINGLE_QUOTE).join(QUOTE_ESCAPE) + SINGLE_QUOTE);

// The node line an entry's apply prints, or '' when the root or the tool path carries an unsafe byte.
export const buildInsertPreview = (root, toolPath) => {
  if ([root, toolPath].some((path) => COMMAND_UNSAFE_RE.test(path))) return '';
  return 'node ' + shellWord(toolPath) + ' --cwd ' + shellWord(root);
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

export const readQueueSeed = (deps) => {
  try {
    return { bytes: deps.readFileSync(QUEUE_SEED_PATH) };
  } catch {
    return { reason: REASONS.seedUnreadable };
  }
};

const absentUnlessSeedUnreadable = (deps) => {
  const seed = readQueueSeed(deps);
  return seed.reason ? reportUndecidable(seed.reason) : { verdict: VERDICTS.absent };
};

const detectQueueSeed = ({ root, deps }) => {
  if (!isDeployed(root, deps)) return reportUndecidable(REASONS.noDeployment);
  let plans;
  try {
    plans = deps.lstatSync(resolve(root, PLANS_PATH));
  } catch (error) {
    return ABSENT_ARM_CODES.has(error?.code) ? absentUnlessSeedUnreadable(deps) : reportUndecidable(REASONS.plansUnreadable);
  }
  if (plans.isSymbolicLink()) return reportUndecidable(REASONS.plansSymlink);
  if (!plans.isDirectory()) return reportUndecidable(REASONS.plansNotDirectory);
  let queue;
  try {
    queue = deps.lstatSync(resolve(root, QUEUE_PATH));
  } catch (error) {
    return error?.code === MISSING_FILE_CODE ? absentUnlessSeedUnreadable(deps) : reportUndecidable(REASONS.queueUnreadable);
  }
  if (queue.isSymbolicLink()) return reportUndecidable(REASONS.queueSymlink);
  return queue.isFile() ? { verdict: VERDICTS.present } : reportUndecidable(REASONS.queueNotRegular);
};

const tierPreview = (root) => buildInsertPreview(root, TIER_PREVIEW_PATH);

export const PROFILE_GAPS = Object.freeze([
  Object.freeze({ id: SLOTS_ID, detect: detectSlots, apply: tierPreview }),
  Object.freeze({ id: STORE_ID, detect: detectStore, apply: tierPreview }),
  Object.freeze({ id: CHECKER_GATES_ID, detect: detectCheckerGates, apply: (root) => buildInsertPreview(root, CHECKER_GATES_PATH) }),
  Object.freeze({ id: QUEUE_SEED_ID, detect: detectQueueSeed, apply: tierPreview }),
]);

export const GAP_STATES = Object.freeze({
  present: 'present',
  offered: 'offered',
  declined: 'declined',
  undecidable: 'undecidable',
});

export const NO_COMMAND_SENTENCE = 'no runnable command — the root or the kit path carries a control byte or a backtick';

export const judgeProfileGaps = ({ root, deps, lineage, declined }) => PROFILE_GAPS.map((entry) => {
  const detected = entry.detect({ root, deps });
  if (detected.verdict === VERDICTS.present) return { entry, state: GAP_STATES.present };
  if (detected.verdict !== VERDICTS.absent) return { entry, state: GAP_STATES.undecidable, reason: detected.reason };
  if (isDeclineCurrent(declined, entry.id, lineage)) {
    return { entry, state: GAP_STATES.declined, lineage: declined[entry.id] };
  }
  return { entry, state: GAP_STATES.offered };
});
