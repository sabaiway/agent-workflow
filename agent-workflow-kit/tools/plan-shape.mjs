import { tokenizeMarkdown } from '../references/scripts/markdown-blocks.mjs';
import { parseRobustTag } from './robustness-literals.mjs';

export const PLAN_TITLE_PREFIX = '# Plan: ';
export const PLAN_HEADINGS = Object.freeze([
  '## Goal and boundary',
  '## Module ledger',
  '## Verification',
  '## Phase: Cleanup',
  '## Next steps',
]);

const MAX_PLAN_LINES = 100;
const MAX_LEDGER_ROWS = 25;
const MAX_ROW_BYTES = 200;
const SECTION_CAPS = Object.freeze({
  '## Goal and boundary': 10,
  '## Module ledger': 60,
  '## Verification': 20,
});
const CLEANUP_NEXT_CAP = 10;
const ROW_ID = /^[A-Za-z0-9._-]+$/;
const VERBS = new Set(['create', 'modify', 'delete']);
const GLOB_BYTE = /[*?[{]/;
const TOTAL_LINE = /^total:\s+(~?\d+)\s+→\s+(~?\d+)\s+lines(?:\s+.+)?$/;
const SPEC_LINE = /docs\/ai\/specs\/|(?:^|\W)(?:not adopted|adopting|nothing spec-covered touched)(?:\W|$)/;
const TEST_PATH = /(?:^|\/)\S+\.test\.[^/]+$/;
const EXTENSION_PHASE = /^## Phase: (?!Cleanup\s*$)\S(?:.*\S)?$/;
const BULLET = /^-\s+\S/;

export const getLineCount = (text) => text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
export const isSweep = (path) => GLOB_BYTE.test(path);
const endsWithPath = (path, suffix) => path === suffix || path.endsWith(`/${suffix}`);
export const unique = (items) => [...new Set(items)];
const getFindingLine = (document, index) => document.frontLines + index + 1;
const makeFinding = (line, code, message, rowId = null) => ({ line, code, message, rowId });
const getHeading = (document, text) => document.headings.find((heading) => heading.text === text);
const getNextSection = (document, heading) => document.headings.find((item) => item.index > heading.index && item.level <= 2);
const getBodyEnd = (document) => document.lines.length - (document.lines.at(-1) === '' ? 1 : 0);
const getSectionEnd = (document, heading) => getNextSection(document, heading)?.index ?? getBodyEnd(document);
const getSectionLines = (document, headingText) => {
  const heading = getHeading(document, headingText);
  return heading ? document.lines.slice(heading.index + 1, getSectionEnd(document, heading)) : [];
};
const getSectionSpan = (document, headingText) => {
  const heading = getHeading(document, headingText);
  return heading ? getSectionEnd(document, heading) - heading.index : 0;
};
const getBudget = (value) => {
  const parsed = /^\d+$/.test(value) ? Number(value) : null;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};
const getFigure = (value) => Number(String(value).replace(/^~/, ''));
const getConcretePaths = (row, facts) => isSweep(row.path) ? facts.expansions?.[row.path] ?? [] : [row.path];
const getPathFact = (facts, path) => facts.pathFacts?.[path] ?? null;
const getAnchorPath = (anchor) => anchor.replace(/:[1-9]\d*$/, '');
const hasPathDefect = (path) => path.startsWith('/') || path.includes('\\') || path.split('/').includes('..');
const hasRaiseBullet = (verificationBullets, path) => verificationBullets.some((bullet) =>
  bullet.includes('--write-baseline') && bullet.includes('--reason') && bullet.includes(path));

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
  const parts = raw.split(' | ').map((part) => part.trim());
  if (parts.length !== 6) return { raw, line, valid: false, id: parts[0] || null };
  const [id, verb, path, responsibility, budget, anchor] = parts;
  const budgetValid = budget === 'n/a' || budget === '—' || getBudget(budget) !== null;
  const deleteValid = verb === 'delete'
    ? budget === '—' && anchor === '—'
    : budget !== '—' && anchor !== '—' && anchor.length > 0;
  const valid = ROW_ID.test(id) && VERBS.has(verb) && path.length > 0 && responsibility.length > 0 && budgetValid && deleteValid;
  return {
    raw,
    line,
    valid,
    id,
    verb,
    path,
    responsibility,
    budget,
    budgetLines: getBudget(budget),
    anchor,
    anchorPath: anchor === '—' ? null : getAnchorPath(anchor),
  };
};

export const parseLedger = (text, suppliedDocument = null) => {
  const document = suppliedDocument ?? tokenizeMarkdown(String(text ?? ''), 'the plan');
  const start = getHeading(document, PLAN_HEADINGS[1]);
  const end = getHeading(document, PLAN_HEADINGS[2]);
  if (!start || !end || end.index <= start.index) return { rows: [], total: null, entries: [], document };
  const entries = document.lines.slice(start.index + 1, end.index).map((raw, offset) => ({
    raw,
    index: start.index + 1 + offset,
    line: getFindingLine(document, start.index + 1 + offset),
  }));
  const rows = entries.filter((entry) => entry.raw.includes(' | ')).map((entry) => parseRow(entry.raw, entry.line));
  const totals = entries.filter((entry) => entry.raw.trim().startsWith('total:'));
  const totalMatch = totals.length === 1 ? TOTAL_LINE.exec(totals[0].raw.trim()) : null;
  const total = totalMatch ? {
    line: totals[0].line,
    beforeRaw: totalMatch[1],
    afterRaw: totalMatch[2],
    before: getFigure(totalMatch[1]),
    after: getFigure(totalMatch[2]),
  } : null;
  return { rows, total, totals, entries, document };
};

const getVerificationBullets = (document) => {
  const heading = getHeading(document, PLAN_HEADINGS[2]);
  if (!heading) return [];
  return bulletBlocks(document.lines, document.fencedLines, heading.index + 1, getSectionEnd(document, heading))
    .map((block) => block.lines.join('\n').replace(/^\-\s+/, '').replace(/\s+/g, ' ').trim());
};

const checkHeadings = (text, document) => {
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
  if (getLineCount(text) > MAX_PLAN_LINES) findings.push(makeFinding(1, 'line-cap', `the plan has ${getLineCount(text)} lines; the cap is ${MAX_PLAN_LINES}`));
  for (const [heading, cap] of Object.entries(SECTION_CAPS)) {
    const span = getSectionSpan(document, heading);
    if (span > cap) findings.push(makeFinding(getFindingLine(document, getHeading(document, heading).index), 'section-cap', `${heading} spans ${span} lines; the cap is ${cap}`));
  }
  const cleanupNext = getSectionSpan(document, PLAN_HEADINGS[3]) + getSectionSpan(document, PLAN_HEADINGS[4]);
  if (cleanupNext > CLEANUP_NEXT_CAP) findings.push(makeFinding(1, 'section-cap', `Cleanup and Next steps span ${cleanupNext} lines; their shared cap is ${CLEANUP_NEXT_CAP}`));
  return findings;
};

const checkLedgerStructure = (parsed, facts) => {
  const findings = [];
  const nonBlank = parsed.entries.filter((entry) => entry.raw.trim() !== '');
  const rowLines = new Set(parsed.rows.map((row) => row.line));
  const totalLines = new Set((parsed.totals ?? []).map((total) => total.line));
  for (const entry of nonBlank) {
    if (!rowLines.has(entry.line) && !totalLines.has(entry.line)) findings.push(makeFinding(entry.line, 'ledger-line', 'a ledger line must be a six-field row or the total line'));
  }
  for (const row of parsed.rows) {
    if (!row.valid) findings.push(makeFinding(row.line, 'row-grammar', 'the row must carry six valid fields and delete rows alone use — for budget and anchor', row.id));
  }
  if (parsed.rows.length > MAX_LEDGER_ROWS) findings.push(makeFinding(parsed.rows[MAX_LEDGER_ROWS].line, 'row-cap', `the ledger has ${parsed.rows.length} rows; the cap is ${MAX_LEDGER_ROWS}`));
  const ids = new Map();
  for (const row of parsed.rows.filter((item) => item.id)) {
    const prior = ids.get(row.id);
    if (prior) findings.push(makeFinding(row.line, 'duplicate-id', `${row.id} duplicates the row on line ${prior}`, row.id));
    else ids.set(row.id, row.line);
  }
  for (const row of parsed.rows.filter((item) => item.valid)) {
    const countedBytes = Buffer.byteLength([row.id, row.verb, row.responsibility, row.budget].join(' | '), 'utf8');
    if (countedBytes > MAX_ROW_BYTES) findings.push(makeFinding(row.line, 'row-bytes', `${row.id} has ${countedBytes} counted bytes; the cap is ${MAX_ROW_BYTES}`, row.id));
    const contained = !hasPathDefect(row.path) && getPathFact(facts, row.path)?.contained !== false;
    if (!contained) findings.push(makeFinding(row.line, 'containment', `${row.id} path must be a contained repo-relative POSIX path`, row.id));
    const anchorContained = row.anchorPath === null || (!hasPathDefect(row.anchorPath) && getPathFact(facts, row.anchorPath)?.contained !== false);
    if (!anchorContained) findings.push(makeFinding(row.line, 'containment', `${row.id} anchor must be a contained repo-relative POSIX path`, row.id));
    if (isSweep(row.path) && (row.verb !== 'modify' || !/\([1-9]\d* files\)/.test(row.responsibility))) {
      findings.push(makeFinding(row.line, 'sweep', `${row.id} sweep must use modify and assert its count as (N files)`, row.id));
    }
  }
  const owners = new Map();
  for (const row of parsed.rows.filter((item) => item.valid)) {
    for (const path of getConcretePaths(row, facts)) {
      const prior = owners.get(path);
      if (prior) findings.push(makeFinding(row.line, 'duplicate-path', `${path} is owned by both ${prior} and ${row.id}`, row.id));
      else owners.set(path, row.id);
    }
  }
  const last = nonBlank.at(-1);
  if (!parsed.total || (parsed.totals ?? []).length !== 1 || last?.line !== parsed.total?.line) {
    findings.push(makeFinding(last?.line ?? 1, 'total', 'the exact total line must be the last non-blank ledger line'));
  }
  const bullets = getVerificationBullets(parsed.document);
  if (bullets.length === 0) findings.push(makeFinding(getHeading(parsed.document, PLAN_HEADINGS[2]) ? getFindingLine(parsed.document, getHeading(parsed.document, PLAN_HEADINGS[2]).index) : 1, 'acceptance', 'Verification must carry at least one top-level - bullet'));
  if (!getSectionLines(parsed.document, PLAN_HEADINGS[0]).some((line) => SPEC_LINE.test(line))) {
    findings.push(makeFinding(getHeading(parsed.document, PLAN_HEADINGS[0]) ? getFindingLine(parsed.document, getHeading(parsed.document, PLAN_HEADINGS[0]).index) : 1, 'governing-spec', 'Goal and boundary must name a governing spec path or the adopted state'));
  }
  return findings;
};

export const resolveAnchorCandidates = (repoFiles, suffix, precedingPaths) => {
  if (repoFiles.includes(suffix)) return [suffix];
  const above = unique(precedingPaths.filter((path) => endsWithPath(path, suffix)));
  return above.length > 0 ? above : unique(repoFiles.filter((path) => endsWithPath(path, suffix)));
};

const getAnchorCandidates = (row, preceding, facts) => {
  const suffix = row.anchorPath;
  if (!suffix || hasPathDefect(suffix)) return [];
  const precedingPaths = preceding.filter((item) => item.valid).flatMap((item) => getConcretePaths(item, facts));
  return facts.candidates(suffix, precedingPaths);
};

const getCurrentLines = (rows, facts, verbs) => rows
  .filter((row) => row.valid && verbs.has(row.verb) && row.budget !== 'n/a')
  .flatMap((row) => getConcretePaths(row, facts))
  .reduce((sum, path) => sum + (getPathFact(facts, path)?.lines ?? 0), 0);

const checkAuthoring = (parsed, facts) => {
  const findings = [];
  const bullets = getVerificationBullets(parsed.document);
  const robustClasses = new Set(facts.robustClasses ?? []);
  for (const [index, row] of parsed.rows.entries()) {
    if (!row.valid) continue;
    const robust = parseRobustTag(row.responsibility);
    const unknownRobustClass = robust.classes?.find((classId) => !robustClasses.has(classId));
    if (robust.refusal || unknownRobustClass !== undefined) {
      const reason = robust.refusal ? `tag grammar refused ${robust.refusal}` : `class ${unknownRobustClass} is not in the shipped list`;
      findings.push(makeFinding(row.line, 'robust-class', `${row.id} robust tag: ${reason}`, row.id));
    }
    const paths = getConcretePaths(row, facts);
    const expectedKind = row.verb === 'create' ? 'absent' : 'regular';
    if (paths.length === 0 && isSweep(row.path)) findings.push(makeFinding(row.line, 'kind', `${row.id} sweep resolves to no regular path`, row.id));
    for (const path of paths) {
      const observed = getPathFact(facts, path)?.kind ?? 'unknown';
      if (observed !== expectedKind) findings.push(makeFinding(row.line, 'kind', `${row.id} expects ${expectedKind}, observed ${observed} at ${path}`, row.id));
    }
    const anchorCandidates = row.anchorPath ? getAnchorCandidates(row, parsed.rows.slice(0, index), facts) : null;
    if (anchorCandidates && anchorCandidates.length !== 1) {
      const count = anchorCandidates.length;
      findings.push(makeFinding(row.line, 'anchor', `${row.id} anchor resolves to ${count} candidates; make it unique`, row.id));
    }
    if (row.verb !== 'delete' && row.budgetLines !== null && !facts.capDeclared) {
      findings.push(makeFinding(row.line, 'cap-declaration', `${row.id} uses an integer budget but no source-size cap is declared; use n/a`, row.id));
    }
    for (const path of paths) {
      const pathFact = getPathFact(facts, path);
      if (!pathFact?.inScope) continue;
      if (row.budget === 'n/a') findings.push(makeFinding(row.line, 'source-budget', `${row.id} is in source scope and cannot use n/a`, row.id));
      if (row.verb === 'create' && !TEST_PATH.test(path)) {
        const hasEarlierTest = parsed.rows.slice(0, index).some((prior) => prior.valid && ['create', 'modify'].includes(prior.verb) && TEST_PATH.test(prior.path));
        if (!hasEarlierTest) findings.push(makeFinding(row.line, 'red-first', `${row.id} needs a create or modify test row above it`, row.id));
      }
      const ceiling = row.verb === 'modify' && pathFact.recordedLines != null ? pathFact.recordedLines : facts.cap;
      if (row.budgetLines !== null && ceiling != null && row.budgetLines > ceiling && !hasRaiseBullet(bullets, row.path)) {
        findings.push(makeFinding(row.line, 'budget-cap', `${row.id} budget ${row.budgetLines} exceeds ${ceiling}; name a reasoned baseline raise for ${row.path}`, row.id));
      }
    }
    if (row.verb === 'create') {
      const pathFact = getPathFact(facts, row.path);
      if (pathFact?.shipped === true && pathFact.pinTest && !parsed.rows.some((candidate) => candidate.valid && candidate.verb === 'modify' && candidate.path === pathFact.pinTest)) {
        findings.push(makeFinding(row.line, 'package-pin', `${row.id} ships but no modify row owns ${pathFact.pinTest}`, row.id));
      }
    }
  }
  if (parsed.total) {
    const current = getCurrentLines(parsed.rows, facts, new Set(['modify', 'delete']));
    if (parsed.total.before !== current) findings.push(makeFinding(parsed.total.line, 'before-total', `before is ${parsed.total.before}; current counted paths sum to ${current}`));
  }
  return { findings, skips: parsed.rows.filter((row) => row.verb === 'create').flatMap((row) =>
    getPathFact(facts, row.path)?.pinSkip ? [`${row.id}: package pin skipped — ${getPathFact(facts, row.path).pinSkip}`] : []) };
};

const checkPostState = (parsed, facts) => {
  const findings = [];
  for (const row of parsed.rows.filter((item) => item.valid)) {
    const paths = getConcretePaths(row, facts);
    if (isSweep(row.path)) {
      const expected = Number(/\(([1-9]\d*) files\)/.exec(row.responsibility)?.[1]);
      if (paths.length === 0 || paths.length !== expected) findings.push(makeFinding(row.line, 'sweep-count', `${row.id} expected ${expected} files and resolves to ${paths.length}`, row.id));
    }
    for (const path of paths) {
      const fact = getPathFact(facts, path);
      const expectedKind = row.verb === 'delete' ? 'absent' : 'regular';
      if (fact?.kind !== expectedKind) findings.push(makeFinding(row.line, 'post-kind', `${row.id} expects ${expectedKind}, observed ${fact?.kind ?? 'unknown'} at ${path}`, row.id));
      if (row.verb !== 'delete' && row.budgetLines !== null && fact?.kind === 'regular' && fact.lines > row.budgetLines) {
        findings.push(makeFinding(row.line, 'post-budget', `${path} has ${fact.lines} lines, above ${row.id} budget ${row.budgetLines}`, row.id));
      }
    }
  }
  if (parsed.total) {
    const current = getCurrentLines(parsed.rows, facts, new Set(['create', 'modify']));
    if (parsed.total.after < current) findings.push(makeFinding(parsed.total.line, 'after-total', `after is ${parsed.total.after}; counted paths sum to ${current}`));
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
    return { findings: [makeFinding(line, 'block-model', parsedResult.error.message)], skips: [], parsed: null };
  }
  const parsed = parsedResult.parsed;
  const structural = [...checkHeadings(String(text ?? ''), parsed.document), ...checkLedgerStructure(parsed, facts)];
  const state = stateRules ? stateRules(parsed, facts) : { findings: [], skips: [] };
  const findings = [...structural, ...state.findings].map((finding, index) => ({ ...finding, order: index }))
    .sort((left, right) => left.line - right.line || left.order - right.order)
    .map(({ order, ...finding }) => finding);
  return { findings, skips: state.skips, parsed };
};

export const checkPlan = (text, facts) => judge(text, facts, checkAuthoring);
export const verifyPlan = (text, facts) => judge(text, facts, checkPostState);
export const checkPlanStructure = (text, facts) => judge(text, facts, null);

export const formatFindings = (result, label = 'plan') => {
  const lines = result.findings.length === 0
    ? [`plan-shape: ACCEPT — ${label}`]
    : [`plan-shape: REFUSE — ${label}`, ...result.findings.map((finding) =>
      `${label}:${finding.line}: ${finding.rowId ? `${finding.rowId}: ` : ''}${finding.code}: ${finding.message}`)];
  return [...lines, ...result.skips.map((skip) => `plan-shape: SKIP — ${skip}`)].join('\n');
};
