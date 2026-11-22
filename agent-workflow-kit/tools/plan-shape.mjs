import { posix } from 'node:path';
import { tokenizeMarkdown } from '../references/scripts/shared/index.mjs';
import { SPEC_SCHEMA } from '../references/scripts/spec-schema/index.mjs';
import { unique } from './claim-relation.mjs';
import { checkStoryOwnership, PIN_FILE, PIN_VERBS } from './plan-shape-ownership.mjs';
import { AMENDMENT_LINE, checkRobustTags, relateAmendments } from './plan-structure/index.mjs';

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
const SECTION_CAPS = new Map([[PLAN_HEADINGS[0], 10], [PLAN_HEADINGS[1], 60], [PLAN_HEADINGS[2], 20]]);
const CLEANUP_NEXT_CAP = 10;
const ROW_ID = /^[A-Za-z0-9._-]+$/;
const VERBS = new Set(['create', 'modify', 'delete']);
const GLOB_BYTE = /[*?[{]/;
const SWEEP = Object.freeze({ verb: 'modify', count: /\(([1-9]\d*) files\)/, countCode: 'sweep-count' });
const AMENDMENT_CHECK = Object.freeze({ code: 'amendment-check', message: `remove ${AMENDMENT_LINE} before approval` });
const TOTAL_LINE = /^total:\s+(~?\d+)\s+→\s+(~?\d+)\s+lines(?:\s+.+)?$/;
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
const getSectionLines = (document, headingText) => {
  const heading = getHeading(document, headingText);
  return heading ? document.lines.slice(heading.index + 1, getSectionEnd(document, heading)) : [];
};
const getSectionSpan = (document, heading) => heading ? getSectionEnd(document, heading) - heading.index : 0;
const getBudget = (value) => {
  const parsed = /^\d+$/.test(value) ? Number(value) : null;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};
const getFigure = (value) => Number(String(value).replace(/^~/, ''));
export const getConcretePaths = (row, facts) => isSweep(row.path) ? facts.expansions?.[row.path] ?? [] : [row.path];
const isBudgetAmendment = (row, relation) => relation.budgets.has(row.path) && relation.entries.includes(row);
const getPathFact = (facts, path) => facts.pathFacts?.[path] ?? null;
const getAnchorPath = (anchor) => anchor.replace(/:[1-9]\d*$/, '');
const hasPathDefect = (path) => !(!path.includes('\\') &&
  path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'));
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
    raw: raw.replace(/\r$/u, ''),
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

const checkHeadings = (text, document, amendmentLines) => {
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
  const approvedLines = getLineCount(text) - amendmentLines.length;
  if (approvedLines > MAX_PLAN_LINES) findings.push(makeFinding(1, 'line-cap', `the plan has ${approvedLines} lines; the cap is ${MAX_PLAN_LINES}`));
  for (const [literal, cap] of SECTION_CAPS) {
    const heading = getHeading(document, literal);
    const span = getSectionSpan(document, heading);
    const approvedSpan = heading && literal === PLAN_HEADINGS[1]
      ? span - amendmentLines.filter((line) => line < getFindingLine(document, heading.index + span)).length : span;
    if (approvedSpan > cap) findings.push(makeFinding(getFindingLine(document, heading.index), 'section-cap', `${heading.text} spans ${approvedSpan} lines; the cap is ${cap}`));
  }
  const cleanupNext = getSectionSpan(document, getHeading(document, PLAN_HEADINGS[3])) + getSectionSpan(document, getHeading(document, PLAN_HEADINGS[4]));
  if (cleanupNext > CLEANUP_NEXT_CAP) findings.push(makeFinding(1, 'section-cap', `Cleanup and Next steps span ${cleanupNext} lines; their shared cap is ${CLEANUP_NEXT_CAP}`));
  return findings;
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

const checkLedgerStructure = (parsed, facts, relation) => {
  const validRows = parsed.rows.filter((row) => row.valid);
  const findings = [...relation.findings, ...checkRobustTags({ rows: validRows, facts, makeFinding })];
  const nonBlank = parsed.entries.filter((entry) => entry.raw.trim() !== '');
  const ledgerLines = new Set([...parsed.rows, ...(parsed.totals ?? [])].map(({ line }) => line));
  for (const entry of nonBlank) {
    if (entry.raw !== AMENDMENT_LINE && !ledgerLines.has(entry.line)) findings.push(makeFinding(entry.line, 'ledger-line', 'a ledger line must be a six-field row or the total line'));
  }
  const ids = new Map();
  for (const row of parsed.rows) {
    if (!row.valid) findings.push(makeFinding(row.line, 'row-grammar', 'the row must carry six valid fields and delete rows alone use — for budget and anchor', row.id));
    if (row === relation.approved[MAX_LEDGER_ROWS]) findings.push(makeFinding(row.line, 'row-cap', `the ledger has ${relation.approved.length} rows; the cap is ${MAX_LEDGER_ROWS}`));
    if (!row.id) continue;
    const prior = ids.get(row.id);
    if (prior) findings.push(makeFinding(row.line, 'duplicate-id', `${row.id} duplicates the row on line ${prior}`, row.id));
    else ids.set(row.id, row.line);
  }
  for (const row of validRows) {
    const countedBytes = Buffer.byteLength([row.id, row.verb, row.responsibility, row.budget].join(' | '), 'utf8');
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
  const ownerRows = validRows.filter((row) => !isBudgetAmendment(row, relation));
  const isApprovedPin = (row, path) => relation.approved.includes(row) && row.verb === 'modify' && row.path === path && posix.basename(path) === PIN_FILE;
  for (const row of ownerRows) {
    for (const path of getConcretePaths(row, facts)) {
      const prior = owners.get(path) ?? [];
      const conflicting = prior.find((owner) => !isApprovedPin(owner, path) || !isApprovedPin(row, path));
      if (conflicting) {
        findings.push(makeFinding(row.line, 'duplicate-path', `${path} is owned by both ${conflicting.id} and ${row.id}`, row.id));
      }
      owners.set(path, [...prior, row]);
    }
  }
  findings.push(...checkPinBindings(ownerRows, owners, facts, isApprovedPin));
  const last = nonBlank.at(-1);
  if (!parsed.total || (parsed.totals ?? []).length !== 1 || last?.line !== parsed.total?.line) {
    findings.push(makeFinding(last?.line ?? 1, 'total', 'the exact total line must be the last non-blank ledger line'));
  }
  const bullets = getVerificationBullets(parsed.document);
  if (bullets.length === 0) findings.push(makeFinding(getHeading(parsed.document, PLAN_HEADINGS[2]) ? getFindingLine(parsed.document, getHeading(parsed.document, PLAN_HEADINGS[2]).index) : 1, 'acceptance', 'Verification must carry at least one top-level - bullet'));
  if (!getSectionLines(parsed.document, PLAN_HEADINGS[0]).some((line) => line.includes(SPEC_SCHEMA.storePrefix) || SPEC_LINE.test(line))) {
    findings.push(makeFinding(getHeading(parsed.document, PLAN_HEADINGS[0]) ? getFindingLine(parsed.document, getHeading(parsed.document, PLAN_HEADINGS[0]).index) : 1, 'governing-spec', 'Goal and boundary must name a governing spec path or the adopted state'));
  }
  return findings;
};

export const resolveAnchorCandidates = (repoFiles, suffix, precedingPaths) => {
  if (repoFiles.includes(suffix)) return [suffix];
  const above = unique(precedingPaths.filter((path) => endsWithPath(path, suffix)));
  return above.length > 0 ? above : unique(repoFiles.filter((path) => endsWithPath(path, suffix)));
};

const getCurrentLines = (rows, facts, verbs) => unique(rows
  .filter((row) => row.valid && verbs.has(row.verb) && row.budget !== 'n/a')
  .flatMap((row) => getConcretePaths(row, facts)))
  .reduce((sum, path) => sum + (getPathFact(facts, path)?.lines ?? 0), 0);

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

const checkRowAuthoring = (row, paths, rows, facts, relation, findings, bullets) => {
  if (row.verb !== 'delete' && row.budgetLines !== null && !facts.capDeclared) {
    findings.push(makeFinding(row.line, 'cap-declaration', `${row.id} uses an integer budget but no source-size cap is declared; use n/a`, row.id));
  }
  for (const path of paths) {
    const pathFact = getPathFact(facts, path);
    if (!pathFact?.inScope) continue;
    if (row.budget === 'n/a') findings.push(makeFinding(row.line, 'source-budget', `${row.id} is in source scope and cannot use n/a`, row.id));
    if (row.verb === 'create' && !TEST_PATH.test(path)) {
      const hasEarlierTest = rows.some((prior) => prior.line < row.line && prior.valid && prior.verb !== 'delete' && TEST_PATH.test(prior.path));
      if (!hasEarlierTest) findings.push(makeFinding(row.line, 'red-first', `${row.id} needs a create or modify test row above it`, row.id));
    }
    if (!bullets) continue;
    const ceiling = row.verb === 'modify' && pathFact.recordedLines != null ? pathFact.recordedLines : facts.cap;
    if (row.budgetLines !== null && ceiling != null && row.budgetLines > ceiling && !hasRaiseBullet(bullets, row.path)) {
      findings.push(makeFinding(row.line, 'budget-cap', `${row.id} budget ${row.budgetLines} exceeds ${ceiling}; name a reasoned baseline raise for ${row.path}`, row.id));
    }
  }
  if (row.verb !== 'create' || (bullets && isBudgetAmendment(row, relation))) return;
  const pathFact = getPathFact(facts, row.path);
  if (pathFact?.shipped === true && pathFact.pinTest && !rows.some((candidate) => candidate.valid && candidate.verb === 'modify' &&
    candidate.path === pathFact.pinTest && !isBudgetAmendment(candidate, relation))) {
    findings.push(makeFinding(row.line, 'package-pin', `${row.id} ships but no modify row owns ${pathFact.pinTest}`, row.id));
  }
};

const checkAuthoring = (parsed, facts, relation, { entriesOnly = false } = {}) => {
  const findings = entriesOnly ? [] : parsed.entries.filter(({ raw }) => raw === AMENDMENT_LINE)
    .map(({ line }) => makeFinding(line, AMENDMENT_CHECK.code, AMENDMENT_CHECK.message));
  const bullets = entriesOnly ? null : getVerificationBullets(parsed.document);
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
    checkRowAuthoring(row, paths, parsed.rows, facts, relation, findings, bullets);
  }
  if (entriesOnly) return { findings, skips: [] };
  if (parsed.total) {
    const current = getCurrentLines(parsed.rows, facts, new Set(['modify', 'delete']));
    if (parsed.total.before !== current) findings.push(makeFinding(parsed.total.line, 'before-total', `before is ${parsed.total.before}; current counted paths sum to ${current}`));
  }
  return { findings, skips: parsed.rows.filter((row) => row.verb === 'create' && !isBudgetAmendment(row, relation)).flatMap((row) =>
    getPathFact(facts, row.path)?.pinSkip ? [`${row.id}: package pin skipped — ${getPathFact(facts, row.path).pinSkip}`] : []) };
};

const checkPostState = (parsed, facts, relation) => {
  const findings = [];
  for (const row of parsed.rows.filter((item) => item.valid && !isBudgetAmendment(item, relation))) {
    const paths = getConcretePaths(row, facts);
    findings.push(...checkSweepCount(row, paths.length));
    for (const path of paths) {
      const fact = getPathFact(facts, path);
      const expectedKind = row.verb === 'delete' ? 'absent' : 'regular';
      if (fact?.kind !== expectedKind) findings.push(makeFinding(row.line, 'post-kind', `${row.id} expects ${expectedKind}, observed ${fact?.kind ?? 'unknown'} at ${path}`, row.id));
      const budget = relation.budgets.get(path) ?? row.budgetLines;
      if (row.verb !== 'delete' && budget !== null && fact?.kind === 'regular' && fact.lines > budget) {
        findings.push(makeFinding(row.line, 'post-budget', `${path} has ${fact.lines} lines, above ${row.id} budget ${budget}`, row.id));
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
  const relation = relateAmendments({ parsed, facts, makeFinding, isSweep, getConcretePaths });
  const goal = getHeading(parsed.document, PLAN_HEADINGS[0]);
  const goalLines = goal ? getSectionLines(parsed.document, PLAN_HEADINGS[0])
    .map((text, offset) => ({ text, line: getFindingLine(parsed.document, goal.index + 1 + offset) })) : [];
  const structural = [...checkHeadings(String(text ?? ''), parsed.document, relation.amendmentLines), ...checkLedgerStructure(parsed, facts, relation),
    ...checkStoryOwnership({ rows: parsed.rows, goalLines, facts, getConcretePaths }).findings];
  const state = stateRules ? stateRules(parsed, facts, relation) : { findings: [], skips: [] };
  const findings = [...structural, ...state.findings].sort((left, right) => left.line - right.line);
  return { findings, skips: state.skips, parsed };
};

export const checkPlan = (text, facts) => judge(text, facts, checkAuthoring);
export const verifyPlan = (text, facts) => judge(text, facts, checkPostState);
export const checkPlanStructure = (text, facts) => judge(text, facts, null);
export const checkPlanEntries = (text, facts) => judge(text, facts, (parsed, entryFacts, relation) => checkAuthoring(parsed, entryFacts, relation, { entriesOnly: true }));

export const formatFindings = (result, label = 'plan') => {
  const lines = result.findings.length === 0
    ? [`plan-shape: ACCEPT — ${label}`]
    : [`plan-shape: REFUSE — ${label}`, ...result.findings.map((finding) =>
      `${label}:${finding.line}: ${finding.rowId ? `${finding.rowId}: ` : ''}${finding.code}: ${finding.message}`)];
  return [...lines, ...result.skips.map((skip) => `plan-shape: SKIP — ${skip}`)].join('\n');
};
