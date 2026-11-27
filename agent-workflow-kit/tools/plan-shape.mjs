import { posix } from 'node:path';
import { tokenizeMarkdown } from '../references/scripts/shared/index.mjs';
import { SPEC_SCHEMA } from '../references/scripts/spec-schema/index.mjs';
import { unique } from './claim-relation.mjs';
import { checkStoryOwnership, PIN_FILE, PIN_VERBS } from './plan-shape-ownership.mjs';
import { AMENDMENT_LINE, checkRobustTags, relateAmendments } from './plan-structure/index.mjs';
import { escapeForLine } from './source-size-refusal.mjs';

export const PLAN_TITLE_PREFIX = '# Plan: ';
export const ONE_PLAN_LABEL = 'One plan: ';
export const PLAN_HEADINGS = Object.freeze([
  '## Goal and boundary',
  '## Module ledger',
  '## Verification',
  '## Phase: Cleanup',
  '## Next steps',
]);
export const RETIRED_FORM_CODES = Object.freeze({ sizeField: 'retired-size-field', totalLine: 'retired-total-line' });

const MAX_PLAN_LINES = 100;
const MAX_LEDGER_ROWS = 45;
const MAX_ROW_BYTES = 200;
const SECTION_CAPS = new Map([[PLAN_HEADINGS[0], 10], [PLAN_HEADINGS[1], 60], [PLAN_HEADINGS[2], 20]]);
const CLEANUP_NEXT_CAP = 10;
const CLEANUP_NEXT = 'Cleanup and Next steps';
const PLAN_QUESTION = 'is every part of this plan needed, does its work belong in one plan, and is the plan logical and optimal? ' +
  `If so, say why on one line "${ONE_PLAN_LABEL}<why>" in Goal and boundary; if not, cut what is not needed or split it by task ` +
  'along independently verifiable boundaries, never to fit the count';
const ONE_PLAN_TWICE = 'keep only one reason line in Goal and boundary';
const ONE_PLAN_UNNEEDED = 'drop the reason line when the plan keeps every signal';
const ROW_ID = /^[A-Za-z0-9._-]+$/;
const VERBS = new Set(['create', 'modify', 'delete']);
const GLOB_BYTE = /[*?[{]/;
const SWEEP = Object.freeze({ verb: 'modify', count: /\(([1-9]\d*) files\)/, countCode: 'sweep-count' });
const AMENDMENT_CHECK = Object.freeze({ code: 'amendment-check', message: `remove ${AMENDMENT_LINE} before approval` });
const TOTAL_PREFIX = 'total:';
const ROW_SEPARATOR = ' | ';
const ROW_FIELDS = 5;
const SPEC_LINE = /(?:^|\W)(?:not adopted|adopting|nothing spec-covered touched)(?:\W|$)/;
const TEST_PATH = /(?:^|\/)\S+\.test\.[^/]+$/;
const EXTENSION_PHASE = /^## Phase: (?!Cleanup\s*$)\S(?:.*\S)?$/;
const BULLET = /^-\s+\S/;

export const getLineCount = (text) => text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
export const isSweep = (path) => GLOB_BYTE.test(path);
const endsWithPath = (path, suffix) => path === suffix || path.endsWith(`/${suffix}`);
export { unique } from './claim-relation.mjs';
const getFindingLine = (document, index) => document.frontLines + index + 1;
export const makeFinding = (line, code, message, rowId = null) => ({ line, code, message, rowId });
const getHeading = (document, text) => document.headings.find((heading) => heading.text === text);
const getNextSection = (document, heading) => document.headings.find((item) => item.index > heading.index && item.level <= 2);
const getBodyEnd = (document) => document.lines.length - (document.lines.at(-1) === '' ? 1 : 0);
const getSectionEnd = (document, heading) => getNextSection(document, heading)?.index ?? getBodyEnd(document);
const getGoalLines = (document) => {
  const goal = getHeading(document, PLAN_HEADINGS[0]);
  if (!goal) return [];
  const start = goal.index + 1;
  return document.lines.slice(start, getSectionEnd(document, goal)).map((text, offset) => {
    const index = start + offset;
    const reason = text.startsWith(ONE_PLAN_LABEL) && !document.fencedLines.has(index)
      ? text.slice(ONE_PLAN_LABEL.length).replace(/\r$/u, '') : '';
    return { text, line: getFindingLine(document, index), reason: reason.trim() ? reason : null };
  });
};
const getSectionSpan = (document, heading) => heading ? getSectionEnd(document, heading) - heading.index : 0;
export const getConcretePaths = (row, facts) => isSweep(row.path) ? facts.expansions?.[row.path] ?? [] : [row.path];
const getPathFact = (facts, path) => facts.pathFacts?.[path] ?? null;
const getAnchorPath = (anchor) => anchor.replace(/:[1-9]\d*$/, '');
const hasPathDefect = (path) => !(!path.includes('\\') &&
  path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'));
const isRetiredTotal = (raw) => raw.trim().startsWith(TOTAL_PREFIX);

// fenceContinues (queue-audit's reader): only a NESTED fence continues an open bullet — a column-0
// fence is a document block and closes it; `gaps` records where an absorbed run sat, so no reader
// joins text from both sides of a code block into one claim.
export const bulletBlocks = (lines, fencedLines, from, to, { fenceContinues = false } = {}) => {
  const indexes = Array.from({ length: Math.max(0, to - from) }, (_, offset) => from + offset);
  const reduced = indexes.reduce((state, index) => {
    if (fencedLines.has(index)) {
      const absorbing = state.absorbing ?? Boolean(fenceContinues && state.current && /^\s+\S/.test(lines[index]));
      if (!absorbing) return { blocks: state.current ? [...state.blocks, state.current] : state.blocks, current: null, absorbing };
      const gaps = new Set([...state.current.gaps, state.current.lines.length - 1]);
      return { blocks: state.blocks, current: { ...state.current, span: state.current.span + 1, gaps }, absorbing };
    }
    const line = lines[index];
    if (BULLET.test(line)) {
      return {
        blocks: state.current ? [...state.blocks, state.current] : state.blocks,
        current: { start: index, lines: [line], span: 1, gaps: new Set() },
        absorbing: null,
      };
    }
    if (state.current && (line.trim() === '' || /^\s+\S/.test(line))) {
      return { blocks: state.blocks, current: { ...state.current, lines: [...state.current.lines, line], span: state.current.span + 1 }, absorbing: null };
    }
    return { blocks: state.current ? [...state.blocks, state.current] : state.blocks, current: null, absorbing: null };
  }, { blocks: [], current: null, absorbing: null });
  return reduced.current ? [...reduced.blocks, reduced.current] : reduced.blocks;
};

const parseRow = (raw, line) => {
  const parts = raw.split(ROW_SEPARATOR).map((part) => part.trim());
  if (parts.length !== ROW_FIELDS) {
    return { raw, line, valid: false, id: parts[0] || null, retiredSizeField: parts.length === ROW_FIELDS + 1 };
  }
  const [id, verb, path, responsibility, anchor] = parts;
  const anchorValid = verb === 'delete' ? anchor === '—' : anchor !== '—' && anchor.length > 0;
  const valid = ROW_ID.test(id) && VERBS.has(verb) && path.length > 0 && responsibility.length > 0 && anchorValid;
  return {
    raw,
    line,
    valid,
    id,
    verb,
    path,
    responsibility,
    anchor,
    anchorPath: anchor === '—' ? null : getAnchorPath(anchor),
  };
};

export const parseLedger = (text, suppliedDocument = null) => {
  const document = suppliedDocument ?? tokenizeMarkdown(String(text ?? ''), 'the plan');
  const start = getHeading(document, PLAN_HEADINGS[1]);
  const end = getHeading(document, PLAN_HEADINGS[2]);
  if (!start || !end || end.index <= start.index) return { rows: [], entries: [], document };
  const entries = document.lines.slice(start.index + 1, end.index).map((raw, offset) => ({
    raw: raw.replace(/\r$/u, ''),
    index: start.index + 1 + offset,
    line: getFindingLine(document, start.index + 1 + offset),
  }));
  const rows = entries.filter(({ raw }) => raw.includes(ROW_SEPARATOR) && !isRetiredTotal(raw))
    .map(({ raw, line }) => parseRow(raw, line));
  return { rows, entries, document };
};

const hasVerificationBullet = (document) => {
  const heading = getHeading(document, PLAN_HEADINGS[2]);
  return heading && bulletBlocks(document.lines, document.fencedLines, heading.index + 1, getSectionEnd(document, heading)).length > 0;
};

const checkHeadings = (document) => {
  const findings = [];
  const first = document.headings[0];
  if (!first || first.level !== 1 || !first.text.startsWith(PLAN_TITLE_PREFIX) || first.text.slice(PLAN_TITLE_PREFIX.length).trim() === '') {
    findings.push(makeFinding(first ? getFindingLine(document, first.index) : 1, 'title', `the first heading must open with "${PLAN_TITLE_PREFIX}" and a non-empty title`));
  }
  const secondLevel = document.headings.filter((heading) => heading.level === 2);
  for (const literal of PLAN_HEADINGS) {
    const matches = secondLevel.filter((heading) => heading.text === literal);
    if (matches.length !== 1) findings.push(makeFinding(matches[0] ? getFindingLine(document, matches[0].index) : 1, 'headings', `${literal} must appear exactly once`));
  }
  const positions = PLAN_HEADINGS.map((literal) => secondLevel.findIndex((heading) => heading.text === literal));
  if (positions.every((position) => position >= 0) && positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
    findings.push(makeFinding(1, 'headings', 'the five plan sections must keep their literal order'));
  }
  for (const heading of secondLevel) {
    if (PLAN_HEADINGS.includes(heading.text)) continue;
    const verification = positions[2];
    const cleanup = positions[3];
    const position = secondLevel.indexOf(heading);
    if (!EXTENSION_PHASE.test(heading.text) || verification < 0 || cleanup < 0 || position <= verification || position >= cleanup) {
      findings.push(makeFinding(getFindingLine(document, heading.index), 'headings', `${heading.text} is not an admitted extension phase between Verification and Cleanup`));
    }
  }
  return findings;
};

const getCountsPastSignals = (text, document, { approved, amendmentLines }, soleReason) => {
  const lines = getLineCount(text) - amendmentLines.length - Number(Boolean(soleReason));
  const counts = [{ name: 'lines', value: lines, signal: MAX_PLAN_LINES, line: 1, code: 'line-cap', subject: `the plan has ${lines} lines` }];
  for (const [literal, signal] of SECTION_CAPS) {
    const heading = getHeading(document, literal);
    if (!heading) continue;
    const span = getSectionSpan(document, heading);
    const uncounted = literal === PLAN_HEADINGS[1]
      ? amendmentLines.filter((line) => line < getFindingLine(document, heading.index + span)).length
      : Number(literal === PLAN_HEADINGS[0] && Boolean(soleReason));
    const value = span - uncounted;
    counts.push({ name: literal, value, signal, line: getFindingLine(document, heading.index),
      code: 'section-cap', subject: `${literal} spans ${value} lines` });
  }
  const cleanupNext = getSectionSpan(document, getHeading(document, PLAN_HEADINGS[3])) + getSectionSpan(document, getHeading(document, PLAN_HEADINGS[4]));
  counts.push({ name: CLEANUP_NEXT, value: cleanupNext, signal: CLEANUP_NEXT_CAP, line: 1,
    code: 'section-cap', subject: `${CLEANUP_NEXT} span ${cleanupNext} lines` });
  const excessRow = approved[MAX_LEDGER_ROWS];
  if (excessRow) counts.push({ name: 'rows', value: approved.length, signal: MAX_LEDGER_ROWS, line: excessRow.line,
    rowId: excessRow.id, code: 'row-cap', subject: `the ledger has ${approved.length} rows` });
  return counts.filter(({ value, signal }) => value > signal);
};

const makeCountFinding = ({ line, code, subject, signal, rowId }) =>
  makeFinding(line, code, `${subject}, past its signal of ${signal} — ${PLAN_QUESTION}`, rowId);

const checkPlanCounts = (text, document, relation, reasons, authoring) => {
  const [first, second] = reasons;
  const soleReason = second ? null : first;
  const counts = getCountsPastSignals(text, document, relation, soleReason);
  if (soleReason && counts.length > 0) return { findings: [], notes: [{ counts, reason: soleReason.reason }] };
  const findings = counts.map(makeCountFinding);
  if (second) findings.push(makeFinding(second.line, 'one-plan-twice', ONE_PLAN_TWICE));
  if (soleReason && authoring) findings.push(makeFinding(soleReason.line, 'one-plan-unneeded', ONE_PLAN_UNNEEDED));
  return { findings, notes: [] };
};

const checkPinBindings = (rows, owners, facts, isApprovedPin) => {
  if (!Object.hasOwn(facts, 'pathFacts')) return [];
  return [...owners].flatMap(([path, group]) => {
    const pins = group.filter((row) => isApprovedPin(row, path));
    if (pins.length < 2) return [];
    const taken = new Set();
    return pins.flatMap((pin) => {
      const above = rows.slice(0, rows.indexOf(pin)).findLast((row) => PIN_VERBS.has(row.verb) && !taken.has(row) &&
        getPathFact(facts, row.path)?.shipped === true && getPathFact(facts, row.path)?.pinTest === path);
      if (above) { taken.add(above); return []; }
      return [makeFinding(pin.line, 'pin-unbound', `${pin.id} is a repeated pin row with no untaken shipped create or delete above it`, pin.id)];
    });
  });
};

const checkLedgerStructure = (parsed, facts, relation, goalLines) => {
  const validRows = parsed.rows.filter((row) => row.valid);
  const findings = [...relation.findings, ...checkRobustTags({ rows: validRows, facts, makeFinding })];
  const nonBlank = parsed.entries.filter((entry) => entry.raw.trim() !== '');
  const rowLines = new Set(parsed.rows.map(({ line }) => line));
  for (const entry of nonBlank) {
    if (isRetiredTotal(entry.raw)) findings.push(makeFinding(entry.line, RETIRED_FORM_CODES.totalLine,'the total line is retired: drop it'));
    else if (entry.raw !== AMENDMENT_LINE && !rowLines.has(entry.line)) findings.push(makeFinding(entry.line, 'ledger-line', 'a ledger line must be a five-field row or the amendment line'));
  }
  const ids = new Map();
  for (const row of parsed.rows) {
    if (row.retiredSizeField) findings.push(makeFinding(row.line, RETIRED_FORM_CODES.sizeField,'the size field is retired: drop the fifth field, or remove a ` | ` inside the responsibility', row.id));
    else if (!row.valid) findings.push(makeFinding(row.line, 'row-grammar', 'the row must carry five valid fields and delete rows alone use — for the anchor', row.id));
    if (!row.id) continue;
    const prior = ids.get(row.id);
    if (prior) findings.push(makeFinding(row.line, 'duplicate-id', `${row.id} duplicates the row on line ${prior}`, row.id));
    else ids.set(row.id, row.line);
  }
  for (const row of validRows) {
    const countedBytes = Buffer.byteLength([row.id, row.verb, row.responsibility].join(ROW_SEPARATOR), 'utf8');
    if (countedBytes > MAX_ROW_BYTES) findings.push(makeFinding(row.line, 'row-bytes', `${row.id} has ${countedBytes} counted bytes; the cap is ${MAX_ROW_BYTES}`, row.id));
    const contained = !hasPathDefect(row.path) && getPathFact(facts, row.path)?.contained !== false;
    if (!contained) findings.push(makeFinding(row.line, 'containment', `${row.id} path must be a contained repo-relative POSIX path`, row.id));
    const anchorContained = row.anchorPath === null || (!hasPathDefect(row.anchorPath) && getPathFact(facts, row.anchorPath)?.contained !== false);
    if (!anchorContained) findings.push(makeFinding(row.line, 'containment', `${row.id} anchor must be a contained repo-relative POSIX path`, row.id));
    if (isSweep(row.path) && (row.verb !== SWEEP.verb || !SWEEP.count.test(row.responsibility))) {
      findings.push(makeFinding(row.line, 'sweep', `${row.id} sweep must use modify and assert its count as (N files)`, row.id));
    }
  }
  const owners = new Map();
  const isApprovedPin = (row, path) => relation.approved.includes(row) && row.verb === 'modify' && row.path === path && posix.basename(path) === PIN_FILE;
  for (const row of validRows) {
    for (const path of getConcretePaths(row, facts)) {
      const prior = owners.get(path) ?? [];
      const conflicting = prior.find((owner) => !isApprovedPin(owner, path) || !isApprovedPin(row, path));
      if (conflicting) {
        findings.push(makeFinding(row.line, 'duplicate-path', `${path} is owned by both ${conflicting.id} and ${row.id}`, row.id));
      }
      owners.set(path, [...prior, row]);
    }
  }
  findings.push(...checkPinBindings(validRows, owners, facts, isApprovedPin));
  if (!hasVerificationBullet(parsed.document)) findings.push(makeFinding(getHeading(parsed.document, PLAN_HEADINGS[2]) ? getFindingLine(parsed.document, getHeading(parsed.document, PLAN_HEADINGS[2]).index) : 1, 'acceptance', 'Verification must carry at least one top-level - bullet'));
  if (!goalLines.some(({ text, reason }) => reason === null && (text.includes(SPEC_SCHEMA.storePrefix) || SPEC_LINE.test(text)))) {
    findings.push(makeFinding(getHeading(parsed.document, PLAN_HEADINGS[0]) ? getFindingLine(parsed.document, getHeading(parsed.document, PLAN_HEADINGS[0]).index) : 1, 'governing-spec', 'Goal and boundary must name a governing spec path or the adopted state'));
  }
  return findings;
};

export const resolveAnchorCandidates = (repoFiles, suffix, precedingPaths) => {
  if (repoFiles.includes(suffix)) return [suffix];
  const above = unique(precedingPaths.filter((path) => endsWithPath(path, suffix)));
  return above.length > 0 ? above : unique(repoFiles.filter((path) => endsWithPath(path, suffix)));
};

const getContractRefusal = (row, path, observed, rows, facts) => {
  if (row.verb !== 'create' || path !== row.path || observed !== 'regular' || !path.startsWith(SPEC_SCHEMA.storePrefix) || !path.endsWith('.md') || hasPathDefect(path)) return '';
  const contract = getPathFact(facts, path)?.contract;
  if (!contract || contract.refused) return ': the spec reader refuses it';
  if (facts.otherPlanCreates?.includes(path)) return ': another plan in flight creates it';
  if (contract.kind === 'spec') return contract.status === 'draft' ? null : `: a ${contract.status} spec`;
  const creates = (target) => rows.some((candidate) => candidate.valid && candidate.verb === 'create' && candidate.path === target);
  if (contract.kind === 'index') return !contract.children?.length ? ': an index that lists no child' : contract.children.every(creates) ? null : ': an index listing a child the plan does not create';
  const rootPath = posix.join(posix.dirname(path), SPEC_SCHEMA.navigatorFile);
  const root = getPathFact(facts, rootPath)?.contract;
  const listed = creates(rootPath) && root?.kind === 'spec' && root.status === 'draft' && !root.refused && root.parts?.includes(path) === true;
  return contract.kind !== 'part' ? `: a ${contract.kind} document` : listed ? null : ': a part its draft root does not list, or of another root';
};

const checkSweepCount = (row, count, { authoring = false } = {}) => {
  if (!isSweep(row.path)) return [];
  const expected = Number(SWEEP.count.exec(row.responsibility)?.[1]);
  if (count === expected || (authoring && (!count || row.verb !== SWEEP.verb || Number.isNaN(expected)))) return [];
  return [makeFinding(row.line, SWEEP.countCode, `${row.id} expected ${expected} files and resolves to ${count}`, row.id)];
};

const checkRowAuthoring = (row, paths, rows, facts, findings) => {
  for (const path of paths) {
    const pathFact = getPathFact(facts, path);
    if (pathFact?.inScope && row.verb === 'create' && !TEST_PATH.test(path)) {
      const hasEarlierTest = rows.some((prior) => prior.line < row.line && prior.valid && prior.verb !== 'delete' && TEST_PATH.test(prior.path));
      if (!hasEarlierTest) findings.push(makeFinding(row.line, 'red-first', `${row.id} needs a create or modify test row above it`, row.id));
    }
  }
  if (row.verb !== 'create') return;
  const pathFact = getPathFact(facts, row.path);
  if (pathFact?.shipped === true && pathFact.pinTest && !rows.some((candidate) => candidate.valid && candidate.verb === 'modify' &&
    candidate.path === pathFact.pinTest)) {
    findings.push(makeFinding(row.line, 'package-pin', `${row.id} ships but no modify row owns ${pathFact.pinTest}`, row.id));
  }
};

const checkAuthoring = (parsed, facts, relation, { entriesOnly = false } = {}) => {
  const findings = entriesOnly ? [] : parsed.entries.filter(({ raw }) => raw === AMENDMENT_LINE)
    .map(({ line }) => makeFinding(line, AMENDMENT_CHECK.code, AMENDMENT_CHECK.message));
  for (const row of (entriesOnly ? relation.entries : parsed.rows).filter((item) => item.valid)) {
    const paths = getConcretePaths(row, facts);
    if (!entriesOnly) {
      const expectedKind = row.verb === 'create' ? 'absent' : 'regular';
      if (paths.length === 0 && isSweep(row.path)) findings.push(makeFinding(row.line, 'kind', `${row.id} sweep resolves to no regular path`, row.id));
      findings.push(...checkSweepCount(row, paths.length, { authoring: true }));
      for (const path of paths) {
        const observed = getPathFact(facts, path)?.kind ?? 'unknown';
        const cause = observed === expectedKind ? null : getContractRefusal(row, path, observed, parsed.rows, facts);
        if (cause !== null) findings.push(makeFinding(row.line, 'kind', `${row.id} expects ${expectedKind}, observed ${observed} at ${path}${cause}`, row.id));
      }
      if (row.anchorPath) {
        const candidates = hasPathDefect(row.anchorPath) ? [] : facts.candidates(row.anchorPath,
          parsed.rows.slice(0, parsed.rows.indexOf(row)).filter((prior) => prior.valid).flatMap((prior) => getConcretePaths(prior, facts)));
        if (candidates && candidates.length !== 1) findings.push(makeFinding(row.line, 'anchor', `${row.id} anchor resolves to ${candidates.length} candidates; make it unique`, row.id));
      }
    }
    checkRowAuthoring(row, paths, parsed.rows, facts, findings);
  }
  if (entriesOnly) return { findings, skips: [] };
  return { findings, skips: parsed.rows.filter((row) => row.verb === 'create').flatMap((row) =>
    getPathFact(facts, row.path)?.pinSkip ? [`${row.id}: package pin skipped — ${getPathFact(facts, row.path).pinSkip}`] : []) };
};

const checkPostState = (parsed, facts) => {
  const findings = [];
  for (const row of parsed.rows.filter((item) => item.valid)) {
    const paths = getConcretePaths(row, facts);
    findings.push(...checkSweepCount(row, paths.length));
    for (const path of paths) {
      const fact = getPathFact(facts, path);
      const expectedKind = row.verb === 'delete' ? 'absent' : 'regular';
      if (fact?.kind !== expectedKind) findings.push(makeFinding(row.line, 'post-kind', `${row.id} expects ${expectedKind}, observed ${fact?.kind ?? 'unknown'} at ${path}`, row.id));
    }
  }
  return { findings, skips: [] };
};

const parseForJudge = (text) => {
  try {
    return { parsed: parseLedger(text), error: null };
  } catch (error) {
    return { parsed: null, error };
  }
};

const judge = (text, facts, stateRules) => {
  const parsedResult = parseForJudge(text);
  if (parsedResult.error) {
    const line = Number(/:(\d+):/.exec(parsedResult.error.message)?.[1] ?? 1);
    return { findings: [makeFinding(line, 'block-model', parsedResult.error.message)], skips: [], parsed: null, story: null };
  }
  const parsed = parsedResult.parsed;
  const relation = relateAmendments({ parsed, makeFinding, isSweep });
  const goalLines = getGoalLines(parsed.document);
  const reasons = goalLines.filter(({ reason }) => reason !== null);
  const counts = checkPlanCounts(String(text ?? ''), parsed.document, relation, reasons, stateRules === checkAuthoring);
  const ownership = checkStoryOwnership({ rows: parsed.rows, goalLines, facts, getConcretePaths });
  const structural = [...checkHeadings(parsed.document), ...counts.findings, ...checkLedgerStructure(parsed, facts, relation, goalLines),
    ...ownership.findings];
  const state = stateRules ? stateRules(parsed, facts, relation) : { findings: [], skips: [] };
  const findings = [...structural, ...state.findings].sort((left, right) => left.line - right.line);
  return { findings, skips: state.skips, parsed, story: ownership.story, ...(counts.notes.length ? { notes: counts.notes } : {}) };
};

export const checkPlan = (text, facts) => judge(text, facts, checkAuthoring);
export const verifyPlan = (text, facts) => judge(text, facts, checkPostState);
export const checkPlanStructure = (text, facts) => judge(text, facts, null);
export const checkPlanEntries = (text, facts) => judge(text, facts, (parsed, entryFacts, relation) => checkAuthoring(parsed, entryFacts, relation, { entriesOnly: true }));

const formatOnePlanNote = ({ counts, reason }) => {
  const lifted = counts.map(({ name, value, signal }) => `${name} ${value} of ${signal}`).join(', ');
  return `plan-shape: NOTE — one plan past its signals (${lifted}): ${escapeForLine(reason)}`;
};

export const formatFindings = (result, label = 'plan') => {
  const lines = result.findings.length === 0
    ? [`plan-shape: ACCEPT — ${label}`]
    : [`plan-shape: REFUSE — ${label}`, ...result.findings.map((finding) =>
      `${label}:${finding.line}: ${finding.rowId ? `${finding.rowId}: ` : ''}${finding.code}: ${finding.message}`)];
  return [...lines, ...(result.notes ?? []).map(formatOnePlanNote),
    ...result.skips.map((skip) => `plan-shape: SKIP — ${skip}`)].join('\n');
};
