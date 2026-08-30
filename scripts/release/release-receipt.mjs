import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INCONCLUSIVE_EXIT, STAGES } from './release-stages.mjs';
import { isRenderableLine, shellQuoteArg } from '../../agent-workflow-kit/tools/repo-lex.mjs';

export const RELEASE_RUN_RECEIPT_BASENAME = 'agent-workflow-release-run.json';
export const RELEASE_RUN_LOCK_BASENAME = 'agent-workflow-release-run.lock';
export const RECEIPT_SCHEMA = 1;
export const FINGERPRINT_VERSION = 'v1';

const STATUS = Object.freeze({ pending: 'pending', running: 'running', pass: 'pass', fail: 'fail' });
const STATUS_VALUES = Object.freeze(Object.values(STATUS));
const ROOT_FIELDS = Object.freeze(['schema', 'head', 'ref', 'expect', 'tokenFile', 'smoke', 'approved', 'invocations', 'stages']);
const STAGE_FIELDS = Object.freeze(['name', 'status', 'exit', 'startedAt', 'durationS']);
const OPTIONAL_STAGE_FIELDS = Object.freeze(['provenBy', 'dispatched', 'inconclusive', 'resumable']);
const EXPECT_KEYS = Object.freeze(['memory', 'engine', 'kit']);
const SMOKE_KINDS = Object.freeze(['line', 'file']);
const SEMVER = /^\d+\.\d+\.\d+$/u;
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const REF_FORBIDDEN = /(?:^refs\/|^\/|(?:^|\/)\.|\s|\.\.|@\{|[~^:?*\[\\\]]|\/\/|[./]$|\.lock(?:\/|$))/u;
export const hasValidRef = (ref) => isRenderableLine(ref) && ref.length > 0 && shellQuoteArg(ref) === ref && ref !== '@' && !ref.startsWith('-') && !REF_FORBIDDEN.test(ref);
const LIVE_STAGE = 'live';
const VERIFY_STAGE = 'verify';
const COMMIT_FORM = 'commit';
const PREFLIGHT_FORM = 'preflight-remote';

export const receiptPath = (commonDir) => join(commonDir, RELEASE_RUN_RECEIPT_BASENAME);
export const lockPath = (commonDir) => join(commonDir, RELEASE_RUN_LOCK_BASENAME);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasExactKeys = (value, required, optional = []) => {
  const keys = Object.keys(value);
  return required.every((key) => hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
};

const freezeSmoke = (smoke) => Object.freeze(smoke.map((entry) => Object.freeze({ kind: entry.kind, value: entry.value })));
const buildStage = (name, source = {}) => {
  const stage = {
    name,
    status: source.status ?? STATUS.pending,
    exit: source.exit ?? null,
    startedAt: source.startedAt ?? null,
    durationS: source.durationS ?? null,
  };
  for (const field of OPTIONAL_STAGE_FIELDS) if (hasOwn(source, field)) stage[field] = source[field];
  return Object.freeze(stage);
};

export const buildReceipt = ({ head, ref, expect, tokenFile, smoke, approved, invocations, stages = [] }) => {
  const stageByName = new Map(stages.map((stage) => [stage.name, stage]));
  return Object.freeze({
    schema: RECEIPT_SCHEMA,
    head,
    ref,
    expect: Object.freeze(Object.fromEntries(EXPECT_KEYS.map((key) => [key, expect[key]]))),
    tokenFile,
    smoke: freezeSmoke(smoke),
    approved,
    invocations,
    stages: Object.freeze(STAGES.map((name) => buildStage(name, stageByName.get(name)))),
  });
};

const validateStage = (stage, expectedName) => {
  if (!isObject(stage) || !hasExactKeys(stage, STAGE_FIELDS, OPTIONAL_STAGE_FIELDS)) return `stage ${expectedName} has an invalid shape`;
  if (stage.name !== expectedName) return `expected stage ${expectedName}, saw ${stage.name}`;
  if (!STATUS_VALUES.includes(stage.status)) return `stage ${stage.name} has unknown status ${stage.status}`;
  if (!(stage.exit === null || Number.isInteger(stage.exit))) return `stage ${stage.name} has an invalid exit`;
  if (!(stage.startedAt === null || typeof stage.startedAt === 'string')) return `stage ${stage.name} has an invalid startedAt`;
  if (!(stage.durationS === null || (typeof stage.durationS === 'number' && Number.isFinite(stage.durationS)))) return `stage ${stage.name} has an invalid durationS`;
  if (hasOwn(stage, 'provenBy') && (stage.name !== LIVE_STAGE || stage.status !== STATUS.pass || stage.provenBy !== VERIFY_STAGE)) return `stage ${stage.name} has an invalid provenBy`;
  if (hasOwn(stage, 'dispatched') && (stage.name !== LIVE_STAGE || stage.status !== STATUS.fail || stage.dispatched !== 'unknown')) return `stage ${stage.name} has an invalid dispatched state`;
  if (hasOwn(stage, 'inconclusive') && (stage.name !== VERIFY_STAGE || stage.status !== STATUS.pass || stage.inconclusive !== true)) return `stage ${stage.name} has an invalid inconclusive state`;
  if (hasOwn(stage, 'resumable') && (stage.status !== STATUS.fail || stage.resumable !== true)) return `stage ${stage.name} has an invalid resumable state`;
  if (stage.name === LIVE_STAGE && stage.status === STATUS.fail && hasOwn(stage, 'dispatched') === hasOwn(stage, 'resumable')) return 'a failed live must carry exactly one of dispatched or resumable';
  if (stage.status === STATUS.pass && stage.exit !== 0 && !hasOwn(stage, 'provenBy') && !((stage.name === LIVE_STAGE || stage.name === VERIFY_STAGE) && stage.exit === INCONCLUSIVE_EXIT)) return `stage ${stage.name} passed with exit ${stage.exit}`;
  if (stage.name === VERIFY_STAGE && stage.status === STATUS.pass && hasOwn(stage, 'inconclusive') !== (stage.exit === INCONCLUSIVE_EXIT)) return 'a passed verify carries inconclusive exactly on exit 9';
  return null;
};

const validateSequence = (stages) => {
  const first = stages.findIndex(({ status }) => status !== STATUS.pass);
  if (first < 0) return null;
  const head = stages[first];
  const verifyMayRun = head.name === LIVE_STAGE && head.dispatched === 'unknown';
  const later = stages.slice(first + 1).find((stage) => !(stage.status === STATUS.pending || (verifyMayRun && stage.name === VERIFY_STAGE && stage.status !== STATUS.pass)));
  return later === undefined ? null : `stage ${later.name} is ${later.status} after ${head.name} (${head.status})`;
};

const validateReceipt = (receipt) => {
  if (!isObject(receipt) || !hasExactKeys(receipt, ROOT_FIELDS)) return 'the root shape is malformed';
  if (receipt.schema !== RECEIPT_SCHEMA) return `schema ${receipt.schema} is not supported`;
  if (typeof receipt.head !== 'string' || !GIT_OID.test(receipt.head)) return 'head is not a git object id';
  if (!hasValidRef(receipt.ref)) return 'ref is malformed';
  if (!isObject(receipt.expect) || !hasExactKeys(receipt.expect, EXPECT_KEYS) || EXPECT_KEYS.some((key) => typeof receipt.expect[key] !== 'string' || !SEMVER.test(receipt.expect[key]))) return 'expect is malformed';
  if (!isRenderableLine(receipt.tokenFile) || typeof receipt.approved !== 'string' || !SHA256_HEX.test(receipt.approved)) return 'tokenFile or approved is malformed';
  if (!Number.isInteger(receipt.invocations) || receipt.invocations < 1) return 'invocations is malformed';
  if (!Array.isArray(receipt.smoke) || receipt.smoke.some((entry) => !isObject(entry) || !hasExactKeys(entry, ['kind', 'value']) || !SMOKE_KINDS.includes(entry.kind) || !isRenderableLine(entry.value))) return 'smoke is malformed';
  if (!Array.isArray(receipt.stages) || receipt.stages.length !== STAGES.length) return 'the stage table length is malformed';
  return receipt.stages.map((stage, index) => validateStage(stage, STAGES[index])).find((violation) => violation !== null) ?? validateSequence(receipt.stages);
};

const normalizeStage = (stage) => stage.status === STATUS.running
  ? { ...stage, status: STATUS.fail, ...(stage.name === LIVE_STAGE ? { dispatched: 'unknown' } : { resumable: true }) }
  : stage;

export const readReceipt = (path, readFile = readFileSync) => {
  try {
    const parsed = JSON.parse(String(readFile(path, 'utf8')));
    const violation = validateReceipt(parsed);
    if (violation !== null) return { refusal: `release receipt ${path} is malformed: ${violation}` };
    return { receipt: buildReceipt({ ...parsed, stages: parsed.stages.map(normalizeStage) }) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { receipt: null };
    return { refusal: `release receipt ${path} cannot be read: ${error?.code ? `${error.code}: ` : ''}${error.message}` };
  }
};

const convertToBuffer = (value) => Buffer.isBuffer(value) ? value : Buffer.from(value);
const frameValue = (value) => {
  const bytes = convertToBuffer(value);
  return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes]);
};
const serializeSmoke = ({ kind, value }) => `${kind}:${value}`;

export const fingerprint = ({ head, porcelain, cachedDiff, messageBytes, ref, expect, smoke, tokenFile }) => {
  const fields = [
    head,
    porcelain,
    cachedDiff,
    messageBytes,
    ref,
    ...EXPECT_KEYS.map((key) => expect[key]),
    String(smoke.length),
    ...smoke.map(serializeSmoke),
    tokenFile,
  ];
  const payload = Buffer.concat([Buffer.from(FINGERPRINT_VERSION), ...fields.map(frameValue)]);
  return createHash('sha256').update(payload).digest('hex');
};

const readLive = (receipt) => receipt?.stages.find(({ name }) => name === LIVE_STAGE) ?? null;
const hasUnknownLive = (receipt) => {
  const live = readLive(receipt);
  return live?.status === STATUS.running || live?.dispatched === 'unknown';
};
const hasPassedLive = (receipt) => readLive(receipt)?.status === STATUS.pass;
const hasEqualExpect = (left, right) => EXPECT_KEYS.every((key) => left?.[key] === right?.[key]);
const findFirstIncomplete = (receipt) => receipt.stages.find(({ status }) => status !== STATUS.pass) ?? null;
const readLastPassed = (receipt) => receipt.stages.filter(({ status }) => status === STATUS.pass).at(-1)?.name ?? 'none';
const describeUnresolved = (receipt) =>
  `run node scripts/release/release-run.mjs --from verify at ${receipt.head} first on a clean tree; otherwise adjudicate the unresolved live by hand and remove the receipt`;
const describePublished = (receipt) => `the same expected release already passed live as recorded at ${receipt.head}`;
const describeNothingToCommit = () =>
  'nothing to commit; if HEAD is the release commit made or rebased by hand, start with --from preflight-remote';

const STAGED_ONLY_LINE = /^[MADRCT] /u;
export const stagedOnlyViolation = (porcelain) => {
  const lines = porcelain.split('\n').filter((line) => line !== '');
  if (lines.length === 0) return 'nothing is staged';
  const offending = lines.find((line) => !STAGED_ONLY_LINE.test(line));
  return offending === undefined ? null : `the tree carries a change outside the index, refused before commit: ${offending}`;
};
export const commitProofViolation = ({ parents, tree, expectedParent, expectedTree }) =>
  parents.length === 1 && parents[0] === expectedParent && tree === expectedTree
    ? null
    : `the commit does not carry the approved index: parents ${parents.join(' ')} (approved ${expectedParent}), tree ${tree} (approved ${expectedTree})`;

export const startViolation = ({ receipt, head, dirty, expect, form }) => {
  if (hasUnknownLive(receipt)) return describeUnresolved(receipt);
  const samePublished = receipt !== null && hasEqualExpect(receipt.expect, expect) && hasPassedLive(receipt);
  if (form === PREFLIGHT_FORM) {
    if (dirty) return 'the receipt-free --from preflight-remote START requires a clean tree';
    if (receipt?.head === head) return `a release receipt already exists at HEAD ${head}`;
    return samePublished ? describePublished(receipt) : null;
  }
  if (form !== COMMIT_FORM) return `unknown START form ${form}`;
  if (dirty) return samePublished ? describePublished(receipt) : null;
  if (receipt?.head === head) {
    const incomplete = findFirstIncomplete(receipt);
    return incomplete === null ? `already released at HEAD ${head}` : `resume the release with --from ${incomplete.name}`;
  }
  if (receipt !== null) return `stale receipt at ${receipt.head} (last passed stage: ${readLastPassed(receipt)}); ${describeNothingToCommit()}`;
  return describeNothingToCommit();
};

export const resumeViolation = ({ receipt, head, from }) => {
  if (receipt === null) return `cannot resume without a receipt at HEAD ${head}`;
  if (receipt.head !== head) return `receipt belongs to another HEAD ${receipt.head}, not ${head}`;
  const fromIndex = STAGES.indexOf(from);
  if (fromIndex <= STAGES.indexOf(COMMIT_FORM)) return `stage ${from} cannot be resumed`;
  const live = readLive(receipt);
  const liveIndex = STAGES.indexOf(LIVE_STAGE);
  if (fromIndex <= liveIndex && (live.status === STATUS.pass || hasUnknownLive(receipt))) {
    return hasUnknownLive(receipt)
      ? `live dispatch is unresolved; resume with --from verify`
      : `the publish was already dispatched; --from ${from} would dispatch it twice`;
  }
  if (hasUnknownLive(receipt) && from !== VERIFY_STAGE) return `live dispatch is unresolved; resume with --from verify`;
  const priorViolation = receipt.stages.slice(0, fromIndex).find((stage) =>
    stage.status !== STATUS.pass && !(from === VERIFY_STAGE && stage.name === LIVE_STAGE && hasUnknownLive(receipt)));
  return priorViolation ? `stage ${priorViolation.name} is not pass before --from ${from}` : null;
};
