import { SPEC_SCHEMA } from '../../references/scripts/spec-schema/index.mjs';
import { tokenizeMarkdown } from '../../references/scripts/shared/index.mjs';
import { canonicalFlowDigest } from '../flow-record-identity.mjs';
import { isHex64, isPlainObject } from '../flow-vocabulary.mjs';
import { PLAN_HEADINGS, isSweep, makeFinding, parseLedger } from '../plan-shape.mjs';
import { relateAmendments } from '../plan-structure/index.mjs';
import { lexicalRepoRelative, parseStrictJson } from '../repo-lex.mjs';
import { parseRobustTag } from '../robustness-literals.mjs';

export const APPROVAL_RECORD_BASENAME = 'agent-workflow-plan-approvals.jsonl';

const SCHEMA = 1;
const ENTRY_KEYS = Object.freeze(['schema', 'plan', 'date', 'planDigest', 'contractsDigest', 'contracts', 'essence', 'from', 'approval']);
const ORIGINS = new Set(['approval', 'provision']);
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const SCENARIOS_HEADING = '## Scenarios';
const SCENARIO_SEPARATOR = ' :: ';
const SCENARIO_LINE = /^- S\d+ /u;
const REWRITTEN_KEYS = new Set([...SPEC_SCHEMA.rootOwnedKeys, 'lastUpdated']);
const LINE_ENDING = '\n';
const CLAIM_FIELDS = ['owns', 'shared'];
const [GOAL_HEADING, , VERIFICATION_HEADING] = PLAN_HEADINGS;

const normalizeLineEndings = (text) => text.replaceAll('\r\n', LINE_ENDING);

const getSectionBounds = (document, headingText) => {
  const heading = document.headings.find(({ text }) => text === headingText);
  if (!heading) return null;
  const next = document.headings.find(({ index, level }) => index > heading.index && level <= heading.level);
  return [heading.index + 1, next?.index ?? document.lines.length];
};

const readSection = (document, headingText) => document.lines.slice(...getSectionBounds(document, headingText)).join(LINE_ENDING);

const removeRobustTag = (responsibility) => {
  const { classes } = parseRobustTag(responsibility);
  if (!classes?.length) return responsibility;
  return responsibility.replace(`robust:${classes.join(',')}`, '').trim();
};

export const approvedParts = (text, verdict) => {
  if (!verdict?.accepted) return null;
  const parsed = parseLedger(normalizeLineEndings(text));
  const { approved } = relateAmendments({ parsed, makeFinding, isSweep });
  return {
    goal: readSection(parsed.document, GOAL_HEADING),
    rows: approved.map(({ verb, path, responsibility }) => ({ verb, path, responsibility: removeRobustTag(responsibility) })),
    verification: readSection(parsed.document, VERIFICATION_HEADING),
    ...(verdict.story ? { claims: Object.fromEntries(CLAIM_FIELDS.map((field) => [field,
      verdict.story.claims.filter((claim) => claim.field === field).map(({ path }) => path).sort()])) } : {}),
  };
};

export const digestPlan = (text, verdict) => {
  const parts = approvedParts(text, verdict);
  return parts === null ? null : canonicalFlowDigest(parts);
};

export const digestContract = (text) => {
  const document = tokenizeMarkdown(normalizeLineEndings(text));
  const frontmatter = document.frontmatter.split(LINE_ENDING)
    .filter((line) => !REWRITTEN_KEYS.has(line.split(':', 1)[0])).join(LINE_ENDING);
  const bounds = getSectionBounds(document, SCENARIOS_HEADING);
  const lines = document.lines.map((line, index) => {
    if (!bounds || index < bounds[0] || index >= bounds[1] || !SCENARIO_LINE.test(line) || document.fencedLines.has(index)) return line;
    const separator = line.indexOf(SCENARIO_SEPARATOR);
    return separator === -1 ? line : line.slice(0, separator);
  });
  return canonicalFlowDigest(frontmatter + lines.join(LINE_ENDING));
};

const digestApproval = ({ planDigest, contractsDigest, essence }) => canonicalFlowDigest({ planDigest, contractsDigest, essence });

export const composeEntry = ({ plan, date, planDigest, contractsDigest, contracts, essence, from = 'approval' }) => ({
  schema: SCHEMA, plan, date, planDigest, contractsDigest, contracts: [...contracts].sort(), essence, from,
  approval: digestApproval({ planDigest, contractsDigest, essence }),
});

const isContractPath = (path) => lexicalRepoRelative(path).ok && path.startsWith(SPEC_SCHEMA.storePrefix);
const isEntry = (entry) => isPlainObject(entry)
  && Object.keys(entry).length === ENTRY_KEYS.length && ENTRY_KEYS.every((key) => Object.hasOwn(entry, key))
  && entry.schema === SCHEMA && lexicalRepoRelative(entry.plan).ok
  && typeof entry.date === 'string' && DATE.test(entry.date)
  && isHex64(entry.planDigest) && isHex64(entry.contractsDigest)
  && Array.isArray(entry.contracts) && entry.contracts.every((path, index) => isContractPath(path) && (index === 0 || entry.contracts[index - 1] < path))
  && typeof entry.essence === 'string' && entry.essence.trim() !== '' && ORIGINS.has(entry.from)
  && isHex64(entry.approval) && entry.approval === digestApproval(entry);

const parseLine = (line, index) => {
  try {
    const entry = parseStrictJson(line);
    if (isEntry(entry)) return { entry };
  } catch {
    return { malformedLine: index + 1, reason: `line ${index + 1}: invalid JSON` };
  }
  return { malformedLine: index + 1, reason: `line ${index + 1}: invalid approval entry` };
};

export const parseEntries = (text) => {
  const lines = text.split(LINE_ENDING);
  const parsed = (lines.at(-1) === '' ? lines.slice(0, -1) : lines).map(parseLine);
  const invalid = parsed.filter(({ malformedLine }) => malformedLine !== undefined);
  return {
    entries: parsed.filter(({ entry }) => entry !== undefined).map(({ entry }) => entry),
    malformedLines: invalid.map(({ malformedLine }) => malformedLine),
    malformedReasons: invalid.map(({ reason }) => reason),
  };
};

export const findMatch = (entries, { planDigest, contractsDigest, approval } = {}) => entries.find((entry) =>
  entry.planDigest === planDigest && (approval === undefined || entry.approval === approval)
  && (entry.from === 'provision' || entry.contractsDigest === contractsDigest)) ?? null;
