import { posix } from 'node:path';
import { tokenizeMarkdown } from '../references/scripts/markdown-blocks.mjs';
import { parseHeader, checkEpic } from './epic-shape.mjs';
import { auditQueue } from './queue-audit.mjs';
import { hasPathOverlap, findReachable, listStories, unique } from './claim-relation.mjs';

const FIRST_LINE = 1;
const ERROR = 'error';
const INFO = 'info';
const OPEN = 'open';
const LANDED = 'landed';
const ABSENT = 'absent';
const EPIC = 'epic';
const OWN = 'owns';
const FRONT_DELIMITER = '---';
const CR_END = /\r$/;
const MARKDOWN_SUFFIX = '.md';
export const STORE_PATH = /^(?:(.*)\/)?docs\/ai\/epics\/([^/]+)\.md$/;
export const QUEUE_PATH = 'docs/plans/queue.md';
const TOKEN_EDGE = '[\\p{L}\\p{N}_-]';
const REGEX_BYTES = /[.*+?^${}()|[\]\\]/g;
const PARSE_REFUSALS = Object.freeze([1, 2]);
const makeFinding = (path, line, code, message, severity = ERROR) => ({ path, line, code, message: `${path}: ${message}`, severity });
const finishJudgement = (findings, data = {}) => ({ ...data, ok: !findings.some((finding) => finding.severity === ERROR), findings });
const nameFindings = (findings, path) => findings.map((finding) => makeFinding(path, finding.line, finding.code, finding.message));
const getIdentity = (story) => JSON.stringify([story.path, story.id]);

const readGraph = (epic, rows, stories) => {
  const graph = new Map(rows.map((row) => [row.id, row.dependsOn]));
  const byLine = new Map(stories.map((story) => [story.line, story.reachable]));
  const reachable = new Map(rows.map((row) => [row.id, byLine.get(row.line) ?? findReachable(graph, row.dependsOn)]));
  const unknowns = rows.flatMap((row) => row.dependsOn.filter((id) => !graph.has(id))
    .map((id) => makeFinding(epic.path, row.line, 'dependency-id', `${row.id} depends on absent story ${id}`)));
  const cyclic = rows.filter((row) => reachable.get(row.id).has(row.id));
  const groups = unique(cyclic.map((row) => JSON.stringify(cyclic.filter((other) =>
    reachable.get(row.id).has(other.id) && reachable.get(other.id).has(row.id)).map((other) => other.id))));
  const cycles = groups.map((group) => {
    const ids = JSON.parse(group);
    return makeFinding(epic.path, rows.find((row) => row.id === ids[0]).line, 'dependency-cycle', `dependency cycle includes ${ids.join(', ')}`);
  });
  return { reachable, findings: [...unknowns, ...cycles] };
};

const hasClaimOverlap = (left, right) => left.ground.some((a) => right.ground.some((b) => hasPathOverlap(a, b)));
const checkPair = (left, right) => {
  if (getIdentity(left) === getIdentity(right)) return [];
  const sameEpic = left.path === right.path;
  const ordered = sameEpic && (left.reachable.has(right.id) || right.reachable.has(left.id));
  return left.claims.flatMap((a) => right.claims.flatMap((b) => {
    if (!hasClaimOverlap(a, b)) return [];
    const owners = a.field === OWN && b.field === OWN;
    if (!owners && ordered) return [];
    const code = owners ? 'owns-overlap' : sameEpic ? 'shared-order' : 'shared-cross-epic';
    const severity = owners || sameEpic ? ERROR : INFO;
    const message = `${left.id} ${a.field} ${a.path} overlaps ${right.path} ${right.id} ${b.field} ${b.path}`;
    return [makeFinding(left.path, left.line, code, message, severity)];
  }));
};

export const checkClaims = (epics) => {
  const parsed = epics.map((epic) => {
    const rows = epic.rows;
    const stories = listStories([epic]);
    const graph = readGraph(epic, rows, stories);
    const findings = rows.filter((row) => !row.valid)
      .map((row) => makeFinding(epic.path, row.line, 'row-grammar', `${row.id} has invalid story fields or claim tokens`));
    return { stories: stories.filter((story) => story.state !== LANDED),
      findings: [...nameFindings(epic.findings, epic.path), ...findings, ...graph.findings] };
  });
  const stories = parsed.flatMap((epic) => epic.stories);
  const collisions = stories.flatMap((left, index) => stories.slice(index + FIRST_LINE).flatMap((right) => checkPair(left, right)));
  return finishJudgement([...parsed.flatMap((epic) => epic.findings), ...collisions]);
};

const readSiblingHeader = (text, path) => {
  const lines = text.split('\n');
  if (lines[0].replace(CR_END, '') !== FRONT_DELIMITER) return { fields: null, findings: [] };
  const end = lines.findIndex((line, index) => index > 0 && line.replace(CR_END, '') === FRONT_DELIMITER);
  if (end < 0) return { fields: null, findings: [makeFinding(path, FIRST_LINE, 'sibling-header', 'frontmatter opens but never closes')] };
  try {
    const frontmatter = tokenizeMarkdown(`${lines.slice(0, end + FIRST_LINE).join('\n')}\n`, path).frontmatter;
    const { fields } = parseHeader(frontmatter);
    const valid = Object.keys(fields).length === end - FIRST_LINE;
    return valid ? { fields, findings: [] }
      : { fields: null, findings: [makeFinding(path, FIRST_LINE, 'sibling-header', 'frontmatter contains an unreadable or repeated field')] };
  } catch (error) {
    if (!PARSE_REFUSALS.includes(error.exitCode)) throw error;
    return { fields: null, findings: [makeFinding(path, FIRST_LINE, 'sibling-header', error.message)] };
  }
};
const readSibling = (entry, root) => {
  const skipped = { read: 0, skipped: FIRST_LINE, epics: [], findings: [] };
  if (entry.outcome === 'directory' || entry.kind === 'directory') return skipped;
  if (!entry.name.endsWith(MARKDOWN_SUFFIX)) return skipped;
  const path = posix.join(root, entry.name);
  if (typeof entry.text !== 'string' || entry.outcome) {
    return { read: 0, skipped: 0, epics: [], findings: [makeFinding(path, FIRST_LINE, 'sibling-read', `${entry.outcome ?? 'unreadable'}: ${entry.reason ?? entry.kind ?? 'no readable text'}`)] };
  }
  const header = readSiblingHeader(entry.text, path);
  if (header.findings.length) return { read: 0, skipped: 0, epics: [], findings: header.findings };
  if (header.fields?.type !== EPIC) return skipped;
  if (![OPEN, LANDED].includes(header.fields.state)) {
    return { read: 0, skipped: 0, epics: [], findings: [makeFinding(path, FIRST_LINE, 'sibling-state', 'epic state is missing or outside open and landed')] };
  }
  if (header.fields.state === LANDED) return { read: FIRST_LINE, skipped: 0, epics: [], findings: [], landedEpics: [entry.name.slice(0, -MARKDOWN_SUFFIX.length)] };
  const { epic, findings } = checkEpic(entry.text, path);
  return { read: FIRST_LINE, skipped: 0, epics: findings.length ? [] : [epic], findings: nameFindings(findings, path) };
};

export const sweepSiblings = (entries, root) => {
  if (!Array.isArray(entries)) {
    return finishJudgement([makeFinding(root, FIRST_LINE, 'sibling-read', 'the direct entry list is unreadable')], { root, epics: [], counts: { epicsRead: 0, skipped: 0 }, landedEpics: [] });
  }
  const results = entries.map((entry) => readSibling(entry, root));
  const epics = results.flatMap((result) => result.epics);
  return finishJudgement(results.flatMap((result) => result.findings), {
    root, epics, counts: { epicsRead: results.reduce((sum, result) => sum + result.read, 0), skipped: results.reduce((sum, result) => sum + result.skipped, 0) },
    landedEpics: results.flatMap((result) => result.landedEpics ?? []),
  });
};

const carriesToken = (title, id) => {
  const escaped = id.replace(REGEX_BYTES, '\\$&');
  return new RegExp(`(?<!${TOKEN_EDGE})${escaped}(?!${TOKEN_EDGE})`, 'u').test(title);
};
const describeQueue = (queue) => [queue?.outcome, queue?.reason].filter((part) => part !== undefined).join(': ')
  || (queue === null ? 'null' : typeof queue);
const checkQueueAbsence = (queue, path, id) => {
  if (typeof queue !== 'string') {
    if (queue?.outcome === ABSENT) return [];
    return [makeFinding(path, FIRST_LINE, 'queue-read', describeQueue(queue))];
  }
  try {
    const { rows } = auditQueue(queue, { label: path });
    return rows.filter((row) => row.id === id || carriesToken(row.title, id))
      .map((row) => makeFinding(path, row.line, 'close-queue', `queue row still stands for ${id}: ${row.title}`));
  } catch (error) {
    if (!PARSE_REFUSALS.includes(error.exitCode)) throw error;
    return [makeFinding(path, FIRST_LINE, 'queue-read', error.message)];
  }
};

export const judgeClose = ({ epic: text, path, queue, entries }) => {
  const checked = checkEpic(text, path);
  const epic = checked.epic;
  const base = { epic, stateRange: null };
  if (checked.findings.length) return finishJudgement(nameFindings(checked.findings, path), base);
  const store = STORE_PATH.exec(path);
  if (!store) return finishJudgement([makeFinding(path, FIRST_LINE, 'close-path', 'close requires docs/ai/epics/<ID>.md in a project store')], base);
  const root = store[1] === undefined ? '.' : store[1] || '/';
  const queuePath = posix.join(root, QUEUE_PATH);
  const sweep = sweepSiblings(entries, posix.dirname(path));
  const claims = checkClaims([epic, ...sweep.epics.filter((sibling) => sibling.path !== posix.normalize(path))]);
  const checks = [...sweep.findings, ...claims.findings];
  const data = { ...base, root, queuePath, sweep };
  if (!sweep.ok || !claims.ok) return finishJudgement(checks, data);
  const stories = epic.rows.filter((row) => row.state !== LANDED)
    .map((row) => makeFinding(path, row.line, 'close-stories', `${row.id} has not landed with a date`));
  const result = epic.result ? [] : [makeFinding(path, FIRST_LINE, 'close-result', 'Acceptance has no Result line with a bare date')];
  const state = epic.state === LANDED ? [makeFinding(path, FIRST_LINE, 'close-state', 'header state is already landed')] : [];
  const findings = [...checks, ...stories, ...result, ...state, ...checkQueueAbsence(queue, queuePath, epic.id)];
  const judged = finishJudgement(findings, data);
  return { ...judged, stateRange: judged.ok ? epic.stateRange : null };
};
