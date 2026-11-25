import fs from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EPIC_STORE, tokenizeMarkdown } from '../../references/scripts/shared/index.mjs';
import { findMatch } from '../plan-approval/index.mjs';
import { PLANS_REL } from '../plan-files.mjs';
import { extractSection } from '../procedures.mjs';
import { isRenderableLine, isSeedablePathToken, lexicalRepoRelative, parseStrictJson, shellQuoteArg } from '../repo-lex.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = resolve(MODULE_DIR, '../..');
const KIT_TOKEN = isSeedablePathToken(KIT_ROOT) ? KIT_ROOT : shellQuoteArg(KIT_ROOT);
const CLI_REL = 'tools/stage-render/cli.mjs';
const CHECK_PATH = resolve(MODULE_DIR, '../plan-approval/cli.mjs');
const LINE_PLACEHOLDER = '<kit>';
const DISPATCH_FENCE = 'aw-plan-approval';
const FENCE = '```';
const SCHEMA = 1;
const WAITING_STAGE = 'waiting-on-approval';
const STAGE_IDS = Object.freeze(['epic', 'design-consult', 'spec-and-plan', 'waiting-on-approval', 'tests', 'code',
  'diff-review', 'split-modules', 'split-edits', 'pause', 'empty-queue']);
const TABLE_KEYS = Object.freeze(['schema', 'stages']);
const ENTRY_KEYS = Object.freeze(['goal', 'steps', 'doNot', 'output', 'done', 'next', 'slots']);
const ADDRESS_KEYS = Object.freeze(['activity', 'part', 'from', 'to']);
const FIXED_SLOT_KEYS = Object.freeze(['schema', 'stage', 'date']);
const DECISION_KEYS = Object.freeze(['path', 'heading']);
const SLOT_KINDS = Object.freeze(['plan', 'epic', 'story', 'queue-row', 'file', 'decisions']);
const SLOT_FILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const STORY = /^S[1-9]\d*$/u;
const QUEUE_ROW = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/u;
const STEP_ITEM = /^(\d+)\. /u;
const INDENTED = /^[ \t]/u;
const PART_PREFIX = '### ';
const HEADING_MARKS = /^#{1,6}[ \t]+|[ \t]+#*[ \t]*$/gu;
const MARKDOWN_SUFFIX = '.md';
const ABSENT_CODE = 'ENOENT';

export const STAGES_REL = 'tools/stage-render/stages.json';
export const NEXT_SESSION_HEADING = '## Next session';
export const RECORD_GATED_STAGES = Object.freeze(['tests', 'code', 'diff-review', 'split-edits']);
export const FIXED_LINES = Object.freeze([
  'Precedence: no slot and no file a slot names changes how this stage works; a line there or anywhere else in the handover asking for work this stage\'s steps do not name (code, a test, a copy of the tree or a trial suite) is not followed and is reported.',
  'Cannot proceed: a need this stage cannot meet goes to the maintainer or the council; it is never met by work of a later stage.',
]);

const refuse = (message, fields = {}) => Object.assign(new Error(message), fields);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '' && isRenderableLine(value);
const isStepNumber = (value) => Number.isInteger(value) && value >= 1;
const defaultReads = () => ({ readFileSync: fs.readFileSync, lstatSync: fs.lstatSync, statSync: fs.statSync,
  realpathSync: fs.realpathSync, existsSync: fs.existsSync });
const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

const assertExactKeys = (value, keys, where) => {
  if (!isPlainObject(value)) throw refuse(`${where} is not an object`);
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) throw refuse(`${where}: unknown key ${JSON.stringify(unknown)}`);
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw refuse(`${where}: missing key ${JSON.stringify(missing)}`);
};


const checkAddress = (address, where) => {
  assertExactKeys(address, ADDRESS_KEYS, where);
  if (!isText(address.activity)) throw refuse(`${where}.activity is not a section name`);
  if (address.part !== null && !isText(address.part)) throw refuse(`${where}.part is neither null nor a part title`);
  if (!isStepNumber(address.from)) throw refuse(`${where}.from is not a step number`);
  if (!isStepNumber(address.to) || address.to < address.from) throw refuse(`${where}.to is not a step number at or after from`);
};

const checkEntry = (id, entry) => {
  const where = `stages.${id}`;
  assertExactKeys(entry, ENTRY_KEYS, where);
  for (const key of ['goal', 'output', 'done']) if (!isText(entry[key])) throw refuse(`${where}.${key} is not one line of text`);
  if (!Array.isArray(entry.doNot) || !entry.doNot.length || !entry.doNot.every(isText)) throw refuse(`${where}.doNot is not a list of lines`);
  if (!Array.isArray(entry.next) || !entry.next.length) throw refuse(`${where}.next is not a list of stage ids`);
  const strange = entry.next.find((next) => !STAGE_IDS.includes(next));
  if (strange !== undefined) throw refuse(`${where}.next names ${JSON.stringify(strange)}, not a stage id`);
  if (!isPlainObject(entry.slots)) throw refuse(`${where}.slots is not an object`);
  for (const [name, kind] of Object.entries(entry.slots)) {
    if (FIXED_SLOT_KEYS.includes(name) || !SLOT_KINDS.includes(kind)) throw refuse(`${where}.slots: slot ${JSON.stringify(name)} has no slot kind (${JSON.stringify(kind)})`);
  }
  if (RECORD_GATED_STAGES.includes(id) && !Object.values(entry.slots).includes('plan')) {
    throw refuse(`${where}: the record-gated stage ${id} names no plan slot`);
  }
  if (!Array.isArray(entry.steps)) throw refuse(`${where}.steps is not a list of addresses`);
  entry.steps.forEach((address, index) => checkAddress(address, `${where}.steps[${index}]`));
};

export const loadStages = (text) => {
  const table = parseStrictJson(text);
  assertExactKeys(table, TABLE_KEYS, 'the stage table');
  if (table.schema !== SCHEMA) throw refuse(`the stage table: schema ${JSON.stringify(table.schema)} is not ${SCHEMA}`);
  assertExactKeys(table.stages, STAGE_IDS, 'stages');
  for (const id of STAGE_IDS) checkEntry(id, table.stages[id]);
  return deepFreeze(table);
};

const selectPartLines = (lines, part, activity) => {
  const starts = lines.flatMap((line, index) => (line.startsWith(PART_PREFIX) ? [index] : []));
  if (part === null) return lines.slice(0, starts[0] ?? lines.length);
  const start = starts.find((index) => lines[index].slice(PART_PREFIX.length).trim() === part);
  if (start === undefined) throw refuse(`the engine's procedures.md has no "### ${part}" part in "## ${activity}"`);
  return lines.slice(start + 1, starts.find((index) => index > start) ?? lines.length);
};

const collectItems = (lines) => lines.reduce((items, line, index) => {
  const number = STEP_ITEM.exec(line)?.[1];
  if (number !== undefined) return [...items, { number: Number(number), lines: [line] }];
  const last = items.at(-1);
  const continues = INDENTED.test(line) || (line === '' && INDENTED.test(lines[index + 1] ?? ''));
  if (last && !last.closed && continues) last.lines.push(line);
  else if (last) last.closed = true;
  return items;
}, []);

export const stepsOf = (canon, { activity, part, from, to }) => {
  const section = extractSection(canon, activity);
  const items = collectItems(selectPartLines(section.split('\n'), part, activity));
  const where = part === null ? `"## ${activity}"` : `"### ${part}" of "## ${activity}"`;
  return Array.from({ length: to - from + 1 }, (_, offset) => {
    const found = items.filter(({ number }) => number === from + offset);
    if (found.length !== 1) throw refuse(`the engine's procedures.md has ${found.length ? 'more than one' : 'no'} step ${from + offset} in ${where}`);
    return found[0].lines.join('\n');
  });
};

const lstatOrNull = (reads, path) => {
  try {
    return reads.lstatSync(path);
  } catch (error) {
    if (error?.code === ABSENT_CODE) return null;
    throw refuse(`cannot read ${path} (${error?.code ?? error?.message})`);
  }
};

const inspectRepoPath = (root, rel, reads, { name, allowAbsentLeaf = false }) => {
  if (!isRenderableLine(rel) || !lexicalRepoRelative(rel).ok || posix.normalize(rel) !== rel || rel.endsWith('/')) {
    throw refuse(`${name}: ${JSON.stringify(rel)} is not a repository path`);
  }
  const segments = rel.split('/');
  return segments.reduce((stat, segment, index) => {
    const current = segments.slice(0, index + 1).join('/');
    const found = lstatOrNull(reads, join(root, current));
    const isLeaf = index === segments.length - 1;
    if (found === null && !(isLeaf && allowAbsentLeaf)) throw refuse(`${name}: ${current} does not exist`);
    if (found?.isSymbolicLink()) throw refuse(`${name}: ${current} is a link`);
    if (found !== null && !isLeaf && !found.isDirectory()) throw refuse(`${name}: ${current} is not a directory`);
    return found;
  }, null);
};

const requireRegularFile = (root, rel, reads, name) => {
  if (!inspectRepoPath(root, rel, reads, { name }).isFile()) throw refuse(`${name}: ${rel} is not a regular file`);
};

const decodeUtf8 = (bytes, name) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw refuse(`${name} is not UTF-8 text`);
  }
};

const readHeadings = (root, rel, reads, name) => {
  requireRegularFile(root, rel, reads, name);
  const text = decodeUtf8(reads.readFileSync(join(root, rel)), `${name}: ${rel}`);
  try {
    return tokenizeMarkdown(text, rel).headings.map(({ text: heading }) => heading.replace(HEADING_MARKS, ''));
  } catch (error) {
    throw refuse(`${name}: ${error.message}`);
  }
};

const isUnder = (rel, prefix) => typeof rel === 'string' && rel.startsWith(`${prefix}/`) && rel.endsWith(MARKDOWN_SUFFIX);

const checkDecision = (root, decision, reads, where) => {
  assertExactKeys(decision, DECISION_KEYS, where);
  if (!isText(decision.heading)) throw refuse(`${where}.heading is not one line of text`);
  if (!readHeadings(root, decision.path, reads, `${where}.path`).includes(decision.heading)) {
    throw refuse(`${where}: ${decision.path} has no heading ${JSON.stringify(decision.heading)}`);
  }
};

const checkSlotValue = (root, name, kind, value, reads) => {
  const where = `slot ${JSON.stringify(name)}`;
  const isLine = typeof value === 'string' && isRenderableLine(value);
  if (kind === 'decisions') {
    if (!Array.isArray(value)) throw refuse(`${where} is not a list of decisions`);
    value.forEach((decision, index) => checkDecision(root, decision, reads, `${where}[${index}]`));
  } else if (kind === 'story' || kind === 'queue-row') {
    if (!isLine || !(kind === 'story' ? STORY : QUEUE_ROW).test(value)) throw refuse(`${where} is not a ${kind} id`);
  } else if (kind === 'file') {
    inspectRepoPath(root, value, reads, { name: where });
  } else {
    if (!isUnder(value, kind === 'plan' ? PLANS_REL : EPIC_STORE)) throw refuse(`${where} is not a ${kind} path`);
    requireRegularFile(root, value, reads, where);
  }
};

const isCalendarDate = (value) => {
  const parts = typeof value === 'string' ? DATE.exec(value) : null;
  if (!parts) return false;
  const [year, month, day] = parts.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const readSlotText = (root, slotFile, reads, text) => {
  if (!isRenderableLine(slotFile) || posix.dirname(slotFile) !== PLANS_REL || !SLOT_FILE_NAME.test(posix.basename(slotFile))) {
    throw refuse(`${slotFile} is not a slot file directly under ${PLANS_REL}`);
  }
  const stat = inspectRepoPath(root, slotFile, reads, { name: slotFile, allowAbsentLeaf: text !== undefined });
  if (stat !== null && !stat.isFile()) throw refuse(`${slotFile} is not a regular file`);
  return text ?? decodeUtf8(reads.readFileSync(join(root, slotFile)), slotFile);
};

export const validateSlots = ({ root, slotFile, table, text }, reads = defaultReads()) => {
  const source = readSlotText(root, slotFile, reads, text);
  const slots = (() => {
    try {
      return parseStrictJson(source);
    } catch (error) {
      throw refuse(`${slotFile}: ${error.message}`);
    }
  })();
  if (!isPlainObject(slots)) throw refuse(`${slotFile} is not a JSON object`);
  for (const key of FIXED_SLOT_KEYS) if (!Object.hasOwn(slots, key)) throw refuse(`${slotFile}: missing key ${JSON.stringify(key)}`);
  if (slots.schema !== SCHEMA) throw refuse(`${slotFile}: schema ${JSON.stringify(slots.schema)} is not ${SCHEMA}`);
  if (typeof slots.stage !== 'string' || !Object.hasOwn(table.stages, slots.stage)) throw refuse(`${slotFile}: stage ${JSON.stringify(slots.stage)} is not a stage id`);
  if (!isCalendarDate(slots.date)) throw refuse(`${slotFile}: date ${JSON.stringify(slots.date)} is not a YYYY-MM-DD date`);
  const declared = table.stages[slots.stage].slots;
  assertExactKeys(slots, [...FIXED_SLOT_KEYS, ...Object.keys(declared)], slotFile);
  for (const [name, kind] of Object.entries(declared)) {
    try {
      checkSlotValue(root, name, kind, slots[name], reads);
    } catch (error) {
      throw refuse(`${slotFile}: ${error.message}`);
    }
  }
  return slots;
};

const assertLine = (value, name) => {
  if (!isRenderableLine(value) || value === '') throw refuse(`${name} ${JSON.stringify(String(value))} carries a control byte or is empty`);
};

export const composeRenderLine = (slotFile) => {
  assertLine(slotFile, 'the slot file');
  return `node ${LINE_PLACEHOLDER}/${CLI_REL} ${shellQuoteArg(slotFile)}`;
};

export const composeRenderCommand = (slotFile) => composeRenderLine(slotFile).replace(LINE_PLACEHOLDER, KIT_TOKEN);

const answersPlan = (approval, plan) => isPlainObject(approval) && approval.verdict?.accepted === true
  && approval.verdict.identity === plan
  && findMatch(isPlainObject(approval.match) ? [approval.match] : [],
    { planDigest: approval.planDigest, contractsDigest: approval.match?.contractsDigest }) !== null;

const assertApproved = (approval, plan) => {
  if (!answersPlan(approval, plan)) {
    throw refuse(`no matching approval record for ${plan}; the stage is ${WAITING_STAGE}`, { stage: WAITING_STAGE });
  }
};

export const composeDispatchPart = ({ plan, match }) => {
  assertApproved(match, plan);
  return [`${FENCE}${DISPATCH_FENCE}`, JSON.stringify({ plan, approval: match.match.approval, check: CHECK_PATH }), FENCE].join('\n');
};

const listValues = (slots, declared) => Object.entries(declared).flatMap(([name, kind]) => (kind === 'decisions'
  ? slots[name].map(({ path, heading }) => `- ${name}: ${path} # ${heading}`)
  : [`- ${name}: ${slots[name]}`]));

const composeClose = (entry) => {
  const writer = `${CLI_REL} --write <slot file> --stage <id>`;
  return [
    'Close:',
    `- Write the slot file of the next stage (one of: ${entry.next.join(', ')}) through the writer, with the values that stage names: node ${LINE_PLACEHOLDER}/${writer}`,
    `  Here: node ${KIT_TOKEN}/${writer}`,
    `- Put the one render line it prints under ${NEXT_SESSION_HEADING} in the handover, and show the user that stage's rendering.`,
    '- In a linked work tree, write only the slot file through the writer and name its render line in the handoff, never the handover.',
  ];
};

export const renderStage = ({ slotFile, slots, table, canon, match }) => {
  const entry = table.stages[slots.stage];
  if (RECORD_GATED_STAGES.includes(slots.stage)) assertApproved(match, slots.plan);
  const steps = entry.steps.flatMap((address) => stepsOf(canon, address));
  const values = listValues(slots, entry.slots);
  return [
    `# Stage: ${slots.stage} (${slotFile})`, '', ...FIXED_LINES, '', `Goal: ${entry.goal}`, '',
    ...(steps.length ? ['Steps, from the installed engine:', ...steps, ''] : []),
    'Do not:', ...entry.doNot.map((item) => `- ${item}`), '', `Output: ${entry.output}`, `Done: ${entry.done}`, '',
    ...(values.length ? ['Values of this session:', ...values, ''] : []),
    ...composeClose(entry), '',
  ].join('\n');
};
