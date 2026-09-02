#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { readShippedRobustnessLiterals, parseRobustTag } from './robustness-literals.mjs';
import { checkPlanStructure, formatFindings, isSweep } from './plan-shape.mjs';
import { expandSweepPaths } from './plan-shape-facts.mjs';
import { readFileBytesNoFollowCapped } from './fs-read-nofollow.mjs';
import { escapeForDisplay, lexicalRepoRelative } from './repo-lex.mjs';
import { isDirectRun } from './direct-run.mjs';

const PLAN_READ_CAP = 1_048_576;
const ROW_ID = /^[A-Za-z0-9._-]+$/u;
const SEARCHABLE_KINDS = new Set(['env', 'flag', 'ref', 'syscall', 'errno', 'argv']);
const SHIPPED_LIST_PATH = 'agent-workflow-kit/references/robustness-literals.json';
const USAGE = 'Usage: node robustness-brief.mjs --plan <plan> [--row <id>] [--coverage]';
const usage = (message) => Object.assign(new Error(message), { usage: true });
const isInside = (root, path) => path === root || path.startsWith(`${root}${sep}`);
const decodePlan = (bytes) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

const parseArgs = (argv, index = 0, state = { plan: null, row: null, coverage: false }) => {
  if (index === argv.length) {
    if (state.plan === null) throw usage('absent --plan');
    if (state.row !== null && state.coverage) throw usage('--row cannot be combined with --coverage');
    return state;
  }
  const flag = argv[index];
  if (flag === '--coverage') {
    if (state.coverage) throw usage('duplicate --coverage');
    return parseArgs(argv, index + 1, { ...state, coverage: true });
  }
  const key = flag === '--plan' ? 'plan' : flag === '--row' ? 'row' : null;
  const value = argv[index + 1];
  if (key === null) throw usage(`unknown argument ${flag}`);
  if (state[key] !== null) throw usage(`duplicate ${flag}`);
  if (value === undefined || value.startsWith('--') || value.length === 0) throw usage(`absent operand for ${flag}`);
  if (key === 'row' && !ROW_ID.test(value)) throw usage(`invalid --row ${value}`);
  return parseArgs(argv, index + 2, { ...state, [key]: value });
};

const renderClass = (entry) => [
  `- **${entry.id}** — ${entry.prove}`,
  ...entry.members.map((member) => `  - \`${member.literal}\` — ${member.note} (${member.source})`),
];

const isIdentifierByte = (byte) => (byte >= 0x30 && byte <= 0x39) ||
  (byte >= 0x41 && byte <= 0x5a) || byte === 0x5f || (byte >= 0x61 && byte <= 0x7a);
const hasBoundedLiteral = (bytes, literal) => {
  const token = Buffer.from(literal, 'utf8');
  const cursor = { from: 0 };
  while (cursor.from <= bytes.length - token.length) {
    const hit = bytes.indexOf(token, cursor.from);
    if (hit === -1) return false;
    const leftBounded = hit === 0 || !isIdentifierByte(bytes[hit - 1]);
    const rightBounded = literal.endsWith('_') || hit + token.length === bytes.length || !isIdentifierByte(bytes[hit + token.length]);
    if (leftBounded && rightBounded) return true;
    cursor.from = hit + 1;
  }
  return false;
};
export const isCoverageDocument = (path) => /\.(?:md|txt)$/u.test(path) || path === SHIPPED_LIST_PATH;
const describeReadOutcome = (read) => read.outcome === 'foreign'
  ? `non-regular ${read.className ?? 'file'}`
  : read.outcome === 'over-cap' ? `over-cap${read.cap ? ` (cap ${read.cap})` : ''}`
    : read.outcome === 'error' ? `error${read.code ? ` (${read.code})` : ''}` : String(read.outcome ?? 'unknown');
const readCoverageFile = (readRowFile, path) => {
  try {
    const read = readRowFile(path);
    if (read == null) return { outcome: 'error', code: 'empty read outcome' };
    if (read.outcome === 'ok' && !Buffer.isBuffer(read.bytes)) return { outcome: 'error', code: 'ok outcome carried no Buffer' };
    return read;
  } catch (error) {
    return { outcome: 'error', code: error?.code ?? error?.message ?? 'read threw' };
  }
};
export const computeRowCoverage = (planText, list, { expandRowPath, readRowFile }) => {
  const shape = checkPlanStructure(planText, {});
  const classes = new Set(list.classes.map(({ id }) => id));
  const entries = shape.parsed.rows.filter((entry) => entry.valid && !isCoverageDocument(entry.path));
  return entries.reduce((answer, entry) => {
    if (answer.refusal !== null) return answer;
    const robust = parseRobustTag(entry.responsibility);
    if (robust.refusal) return { ...answer, refusal: { id: entry.id, reason: robust.refusal } };
    const unknown = robust.classes.find((classId) => !classes.has(classId));
    if (unknown) return { ...answer, refusal: { id: entry.id, reason: `unknown class ${unknown}` } };
    const tagged = robust.classes;
    const emptyRow = { id: entry.id, path: entry.path, tagged, present: [], uncovered: [], absent: false, deleted: false };
    if (entry.verb === 'delete') {
      return { ...answer, rows: [...answer.rows, { ...emptyRow, deleted: true }] };
    }
    const paths = isSweep(entry.path) ? expandRowPath(entry.path) : [entry.path];
    const reads = paths.map((path) => ({ path, read: readCoverageFile(readRowFile, path) }));
    const refused = reads.find(({ read }) => !['ok', 'absent'].includes(read.outcome));
    if (refused) {
      return { ...answer, refusal: { id: entry.id, path: refused.path, outcome: describeReadOutcome(refused.read) } };
    }
    if (paths.length === 0 || reads.some(({ read }) => read.outcome === 'absent')) {
      return { ...answer, rows: [...answer.rows, { ...emptyRow, absent: true }] };
    }
    const matches = list.classes.flatMap((classEntry) => {
      const member = classEntry.members.find((candidate) => SEARCHABLE_KINDS.has(candidate.kind) &&
        reads.some(({ read }) => hasBoundedLiteral(read.bytes, candidate.literal)));
      return member ? [{ id: entry.id, classId: classEntry.id, literal: member.literal }] : [];
    });
    const present = matches.map(({ classId }) => classId);
    const uncovered = present.filter((classId) => !tagged.includes(classId));
    return {
      rows: [...answer.rows, { ...emptyRow, present, uncovered }],
      evidence: [...answer.evidence, ...matches.filter(({ classId }) => uncovered.includes(classId))],
      refusal: null,
    };
  }, { rows: [], evidence: [], refusal: null });
};

const renderCell = (value) => escapeForDisplay(value).replaceAll('|', '\\|');
export const renderCoverage = (rows, displayPath) => [
  `## Robustness coverage — ${escapeForDisplay(displayPath)}`,
  '| row | path | tagged | present | uncovered |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map((row) => row.deleted
    ? `| ${row.id} | ${renderCell(row.path)} | delete | — | — |`
    : row.absent ? `| ${row.id} | ${renderCell(row.path)} | absent | — | — |`
      : `| ${row.id} | ${renderCell(row.path)} | ${row.tagged.join(',') || '—'} | ${row.present.join(',') || '—'} | ${row.uncovered.join(',') || '—'} |`),
];

export const renderBrief = (planText, list, { row, displayPath }) => {
  const shape = checkPlanStructure(planText, {});
  if (shape.findings.length > 0) return { code: 1, lines: formatFindings(shape, escapeForDisplay(displayPath)).split('\n').map(escapeForDisplay) };
  const classes = new Map(list.classes.map((entry) => [entry.id, entry]));
  const rows = shape.parsed.rows.filter((entry) => entry.valid).map((entry) => ({
    ...entry,
    robust: parseRobustTag(entry.responsibility),
  }));
  const refused = rows.find((entry) => entry.robust.refusal || entry.robust.classes.some((classId) => !classes.has(classId)));
  if (refused) {
    const reason = refused.robust.refusal ?? `unknown class ${refused.robust.classes.find((classId) => !classes.has(classId))}`;
    return { code: 1, lines: [`robustness-brief: ${refused.id}: robust-class — ${reason}`] };
  }
  const selected = row === null ? rows.filter((entry) => entry.robust.classes.length > 0) : rows.filter((entry) => entry.id === row);
  if (row !== null && selected.length === 0) return { code: 1, lines: [`robustness-brief: ${row}: row is absent`] };
  if (row !== null && selected[0].robust.classes.length === 0) return { code: 1, lines: [`robustness-brief: ${row}: row is untagged`] };
  if (selected.length === 0) return { code: 0, lines: [`Robustness literals: ${escapeForDisplay(displayPath)} has no robust tags.`] };
  return {
    code: 0,
    lines: [
      `## Robustness literals — list version ${list.version} · ${escapeForDisplay(displayPath)}`,
      ...selected.flatMap((entry) => [
        '',
        `### ${entry.id} — ${escapeForDisplay(entry.path)}`,
        ...entry.robust.classes.flatMap((classId) => renderClass(classes.get(classId))),
      ]),
    ],
  };
};

export const main = (argv = process.argv.slice(2), deps = {}) => {
  try {
    const parsed = parseArgs(argv);
    const cwd = deps.cwd ?? process.cwd();
    const realpath = deps.realpath ?? realpathSync;
    const cwdReal = realpath(cwd);
    if (!isAbsolute(parsed.plan) && !lexicalRepoRelative(parsed.plan).ok) throw usage(`uncontained --plan ${parsed.plan}`);
    const planPath = resolve(cwd, parsed.plan);
    let planReal;
    try {
      planReal = realpath(planPath);
    } catch (error) {
      if (error?.code === 'ENOENT') throw usage(`absent --plan ${parsed.plan}`);
      throw usage(`unreadable --plan ${parsed.plan} (${error?.code ?? error.message})`);
    }
    if (!isInside(cwdReal, planReal)) throw usage(`uncontained --plan ${parsed.plan}`);
    const read = (deps.readPlan ?? readFileBytesNoFollowCapped)(planPath, PLAN_READ_CAP);
    if (read.outcome !== 'ok') {
      const outcome = read.outcome === 'foreign' ? `non-regular ${read.className ?? 'file'}` : read.outcome;
      throw usage(`${outcome} --plan ${parsed.plan}${read.cap ? ` (cap ${read.cap})` : ''}`);
    }
    let planText;
    try {
      planText = decodePlan(read.bytes);
    } catch {
      throw usage(`malformed-utf8 --plan ${parsed.plan}`);
    }
    const list = (deps.readList ?? readShippedRobustnessLiterals)();
    const brief = renderBrief(planText, list, { row: parsed.row, displayPath: parsed.plan });
    if (!parsed.coverage || checkPlanStructure(planText, {}).findings.length > 0) return brief;
    const sweepPaths = checkPlanStructure(planText, {}).parsed.rows
      .filter((entry) => entry.valid && isSweep(entry.path) && !isCoverageDocument(entry.path))
      .map((entry) => entry.path);
    const expansions = deps.expandRowPath === undefined && sweepPaths.length > 0 ? expandSweepPaths(cwd, sweepPaths) : null;
    const coverage = computeRowCoverage(planText, list, {
      expandRowPath: deps.expandRowPath ?? ((path) => expansions[path] ?? []),
      readRowFile: deps.readRowFile ?? ((path) => readFileBytesNoFollowCapped(resolve(cwd, path), PLAN_READ_CAP)),
    });
    if (coverage.refusal) {
      const { id, path, outcome, reason } = coverage.refusal;
      throw usage(reason === undefined ? `${id}: ${escapeForDisplay(path)} — ${outcome}` : `${id}: robust-class — ${reason}`);
    }
    const lines = [...renderCoverage(coverage.rows, parsed.plan), ...coverage.evidence.map(({ id, classId, literal }) => `${id}:${classId}:${literal}`)];
    return { code: coverage.evidence.length > 0 ? 1 : 0, lines };
  } catch (error) {
    return { code: 2, lines: [`robustness-brief: usage — ${escapeForDisplay(error.message)}`, USAGE] };
  }
};

if (isDirectRun(import.meta.url)) {
  const result = main();
  (result.code === 2 ? console.error : console.log)(result.lines.join('\n'));
  process.exitCode = result.code;
}
