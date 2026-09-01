#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { readShippedRobustnessLiterals, parseRobustTag } from './robustness-literals.mjs';
import { checkPlanStructure, formatFindings } from './plan-shape.mjs';
import { readFileBytesNoFollowCapped } from './fs-read-nofollow.mjs';
import { escapeForDisplay, lexicalRepoRelative } from './repo-lex.mjs';
import { isDirectRun } from './direct-run.mjs';

const PLAN_READ_CAP = 1_048_576;
const ROW_ID = /^[A-Za-z0-9._-]+$/u;
const USAGE = 'Usage: node robustness-brief.mjs --plan <plan> [--row <id>]';
const usage = (message) => Object.assign(new Error(message), { usage: true });
const isInside = (root, path) => path === root || path.startsWith(`${root}${sep}`);
const decodePlan = (bytes) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

const parseArgs = (argv, index = 0, state = { plan: null, row: null }) => {
  if (index === argv.length) {
    if (state.plan === null) throw usage('absent --plan');
    return state;
  }
  const flag = argv[index];
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
    return renderBrief(planText, list, { row: parsed.row, displayPath: parsed.plan });
  } catch (error) {
    return { code: 2, lines: [`robustness-brief: usage — ${escapeForDisplay(error.message)}`, USAGE] };
  }
};

if (isDirectRun(import.meta.url)) {
  const result = main();
  (result.code === 2 ? console.error : console.log)(result.lines.join('\n'));
  process.exitCode = result.code;
}
