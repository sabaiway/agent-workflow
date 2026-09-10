import { tokenizeMarkdown } from '../references/scripts/markdown-blocks.mjs';
import { bulletBlocks, getLineCount, unique } from './plan-shape.mjs';

export const EPIC_SECTIONS = Object.freeze([
  '## Intent', '## Value', '## Non-goals', '## Acceptance', '## Specs', '## Stories ledger', '## Queue',
]);
const [INTENT, , , ACCEPTANCE, , LEDGER, QUEUE] = EPIC_SECTIONS;
const HEADER_KEYS = Object.freeze(['type', 'lastUpdated', 'scope', 'staleAfter', 'owner', 'maxLines', 'state']);
const HEADER_STATES = Object.freeze(['open', 'landed']);
const STORY_STATES = Object.freeze(['planned', 'in-flight']);
const MAX_LINES = 60;
const MAX_ROW_BYTES = 200;
const FIELD_COUNT = 6;
const FIRST_LINE = 1;
const HEADER_TAIL_LINES = 2;
const MARKDOWN_REFUSAL = 1;
const FIELD_SEPARATOR = ' | ';
const NONE = 'none';
const EPIC_TYPE = 'epic';
const TITLE_PREFIX = '# Epic: ';
const RESULT_PREFIX = 'Result line:';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_SUFFIX = 'T00:00:00.000Z';
const STORY_ID = /^S[1-9]\d*$/;
const DEPENDENCIES = /^depends-on: (none|S[1-9]\d*(?:, S[1-9]\d*)*)$/;
const CLAIM_FIELD = /^(owns|shared): (.+)$/;
const CLAIM_FORBIDDEN = /[\s`()\*?\[\]{}|:#]/;
const STATE_FIELD = /^state: (planned|in-flight|landed (\d{4}-\d{2}-\d{2}))$/;
const HEADER_FIELD = /^([A-Za-z][A-Za-z0-9]*):([ \t]*)(.*?)[ \t]*\r?$/;
const QUEUE_LINE = /^Row (\S+) in (\S(?:.*\S)?)$/;
const RESULT_LINE = /^Result line: (\d{4}-\d{2}-\d{2})$/;
const PLAN_PATH = /docs\/plans\/([^\s`()[\]{}<>|,:;"']+\.md)(?=$|[\s`()[\]{}<>|,:;"'.!?])/g;
const QUEUE_NAME = 'queue.md';
const FENCE_LINE = /^\s*(?:`{3,}[^`]*|~{3,}.*)$/;
const BACKTICK_RUN = /`+/g;
const CITATION = /[^\s`()[\]{}<>|:;,"'!?]+[./][^\s`()[\]{}<>|:;,"'!?]+:\d+(?![\dA-Za-z_])/;
const TOP_BULLET = /^-\s+\S/;
const BULLET_PREFIX = /^-\s+/;
const INDENTED_LINE = /^\s+\S/;
const MARKDOWN_ERROR_LINE = /:(\d+):/;
const makeFinding = (line, code, message) => ({ line, code, message });
const getFileLine = (document, index) => document.frontLines + index + FIRST_LINE;
const getSection = (epic, heading) => epic.sections.find((section) => section.heading === heading);
const getNonBlank = (entries) => entries.filter((entry) => entry.raw.trim() !== '');
const getEntries = (document, start, end) => document.lines.slice(start, end).map((raw, offset) => ({
  raw, index: start + offset, line: getFileLine(document, start + offset),
}));
export const isEpicDate = (value) => {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}${DATE_TIME_SUFFIX}`);
  return Number.isFinite(date.getTime()) && date.toISOString() === `${value}${DATE_TIME_SUFFIX}`;
};

export const findCitation = (line) => {
  const match = CITATION.exec(line);
  return match ? { text: match[0], index: match.index, end: match.index + match[0].length } : null;
};

const hasBacktickSpan = (line) => {
  const runs = [...line.matchAll(BACKTICK_RUN)];
  return runs.some((opening, index) => runs.slice(index + FIRST_LINE).some((closing) => closing[0].length === opening[0].length));
};

export const judgeAltitude = (line) => {
  const form = FENCE_LINE.test(line) ? 'fence' : hasBacktickSpan(line) ? 'backtick' : findCitation(line) ? 'citation' : null;
  return { below: form !== null, form };
};

const isClaim = (token) => {
  if (!token || token === NONE || token.startsWith('/') || CLAIM_FORBIDDEN.test(token)) return false;
  const segments = token.replace(/\/$/, '').split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
};
const parseClaims = (field, name) => {
  const match = CLAIM_FIELD.exec(field ?? '');
  if (!match || match[1] !== name) return null;
  if (match[2] === NONE) return [];
  const claims = match[2].split(',').map((claim) => claim.trim());
  return claims.every(isClaim) ? claims : null;
};

export const parseStoryRow = (blockLines) => {
  const lines = blockLines.map((line) => line.replace(/\r$/, ''));
  const raw = lines[0] ?? '';
  const parts = raw.replace(BULLET_PREFIX, '').split(FIELD_SEPARATOR).map((part) => part.trim());
  const [id, name, dependencyField, ownsField, sharedField, stateField] = parts;
  const dependencies = DEPENDENCIES.exec(dependencyField ?? '');
  const owns = parseClaims(ownsField, 'owns');
  const shared = parseClaims(sharedField, 'shared');
  const stateMatch = STATE_FIELD.exec(stateField ?? '');
  const date = stateMatch?.[2] ?? null;
  const state = date ? 'landed' : stateMatch?.[1] ?? null;
  const bodyLines = lines.slice(FIRST_LINE);
  const body = bodyLines.join('\n').trimEnd();
  const outsideClaims = [id, name, dependencyField, stateField].join(FIELD_SEPARATOR);
  const countedBytes = Buffer.byteLength(outsideClaims + (body ? `\n${body}` : ''), 'utf8');
  const valid = TOP_BULLET.test(raw) && parts.length === FIELD_COUNT && STORY_ID.test(id ?? '') && Boolean(name)
    && Boolean(dependencies) && owns !== null && shared !== null
    && (STORY_STATES.includes(state) || (state === 'landed' && isEpicDate(date)))
    && bodyLines.every((line) => line.trim() === '' || INDENTED_LINE.test(line));
  return {
    raw, id: id ?? null, name: name ?? null, valid, countedBytes, body, bodyLines,
    dependsOn: dependencies ? (dependencies[1] === NONE ? [] : unique(dependencies[1].split(', '))) : [],
    owns: owns ?? [], shared: shared ?? [], state, date,
    altitudeLine: parts.length === FIELD_COUNT ? outsideClaims : raw,
  };
};

export const parseHeader = (frontmatter) => {
  const lines = frontmatter.split('\n');
  const entries = lines.slice(FIRST_LINE, -HEADER_TAIL_LINES).map((raw, index) => {
    const match = HEADER_FIELD.exec(raw);
    const prefix = lines.slice(0, index + FIRST_LINE).join('\n') + '\n';
    const start = match ? Buffer.byteLength(prefix + `${match[1]}:${match[2]}`, 'utf8') : null;
    return { key: match?.[1], value: match?.[3], line: index + FIRST_LINE + FIRST_LINE,
      range: match ? { start, end: start + Buffer.byteLength(match[3], 'utf8') } : null };
  });
  const fields = Object.fromEntries(entries.filter((entry) => entry.key).map((entry) => [entry.key, entry.value]));
  const findings = entries.flatMap((entry) => !entry.key || !HEADER_KEYS.includes(entry.key) || entry.value === ''
    ? [makeFinding(entry.line, 'frontmatter', 'frontmatter must contain only the seven non-empty epic fields')] : []);
  for (const key of HEADER_KEYS) {
    if (entries.filter((entry) => entry.key === key).length !== FIRST_LINE) {
      findings.push(makeFinding(FIRST_LINE, 'frontmatter', `frontmatter must carry ${key} exactly once`));
    }
  }
  if (fields.type !== EPIC_TYPE) findings.push(makeFinding(FIRST_LINE, 'frontmatter', 'type must be epic'));
  if (fields.maxLines !== String(MAX_LINES)) findings.push(makeFinding(FIRST_LINE, 'max-lines', `maxLines is frozen at ${MAX_LINES}`));
  if (!HEADER_STATES.includes(fields.state)) findings.push(makeFinding(FIRST_LINE, 'header-state', 'header state must be open or landed'));
  const states = entries.filter((entry) => entry.key === 'state');
  return { fields, stateRange: states.length === FIRST_LINE ? states[0].range : null, findings };
};

const parseSections = (document, titleHeading) => document.headings.filter((heading) => heading !== titleHeading).map((heading, index, headings) => {
  const end = headings[index + FIRST_LINE]?.index ?? document.lines.length;
  const lines = document.lines.slice(heading.index + FIRST_LINE, end);
  const raw = document.lines.slice(heading.index, end).join('\n');
  return { heading: heading.text, index: heading.index, line: getFileLine(document, heading.index), end, lines,
    text: raw + (end < document.lines.length ? '\n' : ''), entries: getEntries(document, heading.index + FIRST_LINE, end) };
});

export const parseEpic = (text, path) => {
  const source = String(text ?? '');
  const epicPath = String(path ?? '');
  const id = epicPath.split('/').at(-1).replace(/\.md$/, '');
  const base = { text: source, path: epicPath, id, title: null, fields: {}, state: null, stateRange: null,
    sections: [], rows: [], queue: null, result: null, resultLines: [], ledgerEntries: [], document: null, findings: [] };
  try {
    const document = tokenizeMarkdown(source, epicPath);
    const header = parseHeader(document.frontmatter);
    const titleHeading = document.headings.find((heading) => heading.level === FIRST_LINE && heading.text.startsWith(TITLE_PREFIX));
    const sections = parseSections(document, titleHeading);
    const ledger = sections.find((section) => section.heading === LEDGER);
    const blocks = ledger ? bulletBlocks(document.lines, document.fencedLines, ledger.index + FIRST_LINE, ledger.end) : [];
    const rows = blocks.map((block) => ({ ...parseStoryRow(block.lines), index: block.start,
      line: getFileLine(document, block.start), span: block.span }));
    const queueEntries = getNonBlank(sections.find((section) => section.heading === QUEUE)?.entries ?? []);
    const queueMatch = queueEntries.length === FIRST_LINE ? QUEUE_LINE.exec(queueEntries[0].raw.trim()) : null;
    const resultLines = (sections.find((section) => section.heading === ACCEPTANCE)?.entries ?? [])
      .filter((entry) => entry.raw.trim().startsWith(RESULT_PREFIX));
    const resultMatch = resultLines.length === FIRST_LINE ? RESULT_LINE.exec(resultLines[0].raw.trim()) : null;
    return {
      ...base, ...header, document, titleHeading, title: titleHeading?.text.slice(TITLE_PREFIX.length).trim() ?? null,
      state: header.fields.state ?? null, sections, rows, ledgerEntries: ledger?.entries ?? [], resultLines,
      queue: queueMatch ? { id: queueMatch[1], bucket: queueMatch[2], line: queueEntries[0].line } : null,
      result: resultMatch && isEpicDate(resultMatch[1]) ? { date: resultMatch[1], line: resultLines[0].line } : null,
    };
  } catch (error) {
    if (error.exitCode !== MARKDOWN_REFUSAL) throw error;
    return { ...base, findings: [makeFinding(Number(MARKDOWN_ERROR_LINE.exec(error.message)?.[1] ?? FIRST_LINE), 'markdown', error.message)] };
  }
};

const checkSections = (epic) => {
  const { document, titleHeading, sections } = epic;
  const findings = [];
  if (!epic.title || document.headings[0] !== titleHeading) {
    findings.push(makeFinding(titleHeading ? getFileLine(document, titleHeading.index) : FIRST_LINE, 'title', `the first heading must be ${TITLE_PREFIX}<title>`));
  }
  if (sections.length !== EPIC_SECTIONS.length || sections.some((section, index) => section.heading !== EPIC_SECTIONS[index])) {
    findings.push(makeFinding(sections[0]?.line ?? FIRST_LINE, 'headings', 'the seven epic sections must appear exactly once in their literal order, with no other headings'));
  }
  const intent = getSection(epic, INTENT);
  const outside = getEntries(document, 0, intent?.index ?? document.lines.length)
    .filter((entry) => entry.index !== titleHeading?.index && entry.raw.trim() !== '');
  for (const entry of outside) findings.push(makeFinding(entry.line, 'outside-section', 'every non-blank body line after the title must lie inside a section'));
  return findings;
};

const checkClosedLines = (epic) => {
  const findings = [];
  if (!epic.queue || epic.queue.id !== epic.id) {
    findings.push(makeFinding(getSection(epic, QUEUE)?.line ?? FIRST_LINE, 'queue', `Queue must hold exactly one line: Row ${epic.id} in <bucket>`));
  }
  if (epic.resultLines.length > FIRST_LINE || (epic.resultLines.length === FIRST_LINE && !epic.result)) {
    findings.push(makeFinding(epic.resultLines[0].line, 'result-line', 'Acceptance admits at most one Result line: YYYY-MM-DD with a date and nothing else'));
  }
  return findings;
};

const checkRows = (epic) => {
  const findings = [];
  if (epic.rows.length === 0) findings.push(makeFinding(getSection(epic, LEDGER)?.line ?? FIRST_LINE, 'empty-ledger', 'the ledger must carry at least S1'));
  const covered = new Set(epic.rows.flatMap((row) => Array.from({ length: row.span }, (_, offset) => row.index + offset)));
  for (const entry of getNonBlank(epic.ledgerEntries)) {
    if (!covered.has(entry.index)) findings.push(makeFinding(entry.line, 'ledger-line', 'ledger content must belong to a top-level story bullet'));
  }
  for (const [index, row] of epic.rows.entries()) {
    if (!row.valid) findings.push(makeFinding(row.line, 'row-grammar', 'a story must carry the six ordered fields, canonical claims and a valid state'));
    if (row.id !== `S${index + FIRST_LINE}`) findings.push(makeFinding(row.line, 'story-ids', 'story ids must run contiguously from S1'));
    if (row.countedBytes > MAX_ROW_BYTES) findings.push(makeFinding(row.line, 'row-bytes', `${row.id} has ${row.countedBytes} bytes outside owns and shared; the cap is ${MAX_ROW_BYTES}`));
  }
  return findings;
};

const checkAltitude = (epic) => {
  const rowLines = new Map(epic.rows.map((row) => [row.index, row.altitudeLine]));
  return epic.document.lines.flatMap((line, index) => {
    const judgement = judgeAltitude(rowLines.get(index) ?? line);
    return judgement.below ? [makeFinding(getFileLine(epic.document, index), 'altitude', `${judgement.form} is below concept altitude`)] : [];
  });
};
const checkPlanPaths = (text) => text.split('\n').flatMap((line, index) => [...line.matchAll(PLAN_PATH)]
  .filter((match) => match[1] !== QUEUE_NAME)
  .map((match) => makeFinding(index + FIRST_LINE, 'plan-path', `${match[0]} is ephemeral; only docs/plans/queue.md may be stored`)));

export const checkEpic = (text, path) => {
  const epic = parseEpic(text, path);
  const capFindings = getLineCount(epic.text) > MAX_LINES
    ? [makeFinding(FIRST_LINE, 'line-cap', `the epic has ${getLineCount(epic.text)} lines; the cap is ${MAX_LINES}`)] : [];
  const shapeFindings = epic.document ? [...checkSections(epic), ...checkClosedLines(epic), ...checkRows(epic), ...checkAltitude(epic)] : [];
  return { findings: [...epic.findings, ...capFindings, ...checkPlanPaths(epic.text), ...shapeFindings], epic };
};
