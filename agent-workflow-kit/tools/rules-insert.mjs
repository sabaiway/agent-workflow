#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeContainedFileAtomic } from './atomic-write.mjs';
import { isDirectRun } from './direct-run.mjs';
import { OUTCOME_LINES as LENS_OUTCOME_LINES } from './lens-region.mjs';
import {
  RULES_REGIONS, readTemplateSpan, planInsert, frontmatterMaxLines, decodeUtf8Strict,
} from './rules-regions.mjs';

const LF = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);
const BACKTICK = String.fromCharCode(96);
const JSON_RADIX = 16;
const JSON_ESCAPE_WIDTH = 4;
const JSON_ESCAPE_PAD = '0';
const FIRST_CODE_POINT = 0;
const ARGV_OFFSET = 2;
const UTF8 = 'utf8';
const ABSENT_CODE = 'ENOENT';
const EXIT_SUCCESS = 0;
const EXIT_REFUSAL = 1;
const EXIT_USAGE = 2;
const FLAG_PREFIX = '--';
const CWD_FLAG = '--cwd';
const APPLY_FLAG = '--apply';
const FLAGS = Object.freeze({ [CWD_FLAG]: 'cwd', [APPLY_FLAG]: 'apply' });
const TEMPLATE_CANON = 'template';
const REGIONS = RULES_REGIONS.filter(({ canon }) => canon === TEMPLATE_CANON);
const TARGET_RELATIVE = 'docs/ai/agent_rules.md';
const TEMPLATE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)), '..', 'references', 'templates', 'agent_rules.md',
);
const REINSTALL = 'npx @sabaiway/agent-workflow-kit@latest init';
const USAGE = 'usage: rules-insert.mjs --cwd <project> [--apply]';
const NON_REGULAR_CAUSE = 'Target is not a regular file';
const REFUSALS = Object.freeze({
  fileAbsent: 'file-absent',
  fileSymlink: 'file-symlink',
  fileUnreadable: 'file-unreadable',
  templateDefect: 'template',
  headingTwice: 'heading-twice',
  anchorAbsent: 'anchor-absent',
  capRefused: 'cap',
  writeFailed: 'write-failed',
});
const COMPOSERS = Object.fromEntries(Object.entries(REFUSALS).map(([key, name]) => [name, key]));
const DIAGNOSTIC_REFUSALS = new Set([
  REFUSALS.templateDefect, REFUSALS.fileUnreadable, REFUSALS.writeFailed,
]);
const UNICODE_UNSAFE_RANGE = BACKSLASH + 'u007f-' + BACKSLASH + 'u009f'
  + BACKSLASH + 'u2028' + BACKSLASH + 'u2029';
const LINE_UNSAFE = new RegExp('[' + UNICODE_UNSAFE_RANGE + ']', 'g');
const HUMAN_UNSAFE = new RegExp(
  '[' + BACKSLASH + 'u0000-' + BACKSLASH + 'u001f' + UNICODE_UNSAFE_RANGE + ']+', 'g',
);

const escapeUnsafe = (character) => BACKSLASH + 'u'
  + character.codePointAt(FIRST_CODE_POINT).toString(JSON_RADIX).padStart(JSON_ESCAPE_WIDTH, JSON_ESCAPE_PAD);
const renderOneLine = (value) => String(value).replace(HUMAN_UNSAFE, ' ');
const readCause = (error) => String(error?.message ?? error);
const makeResult = (code, stdout = '', stderr = '') => ({ code, stdout, stderr });

export const OUTCOME_LINES = Object.freeze({
  regionPresent: (id) => `${renderOneLine(id)}: present`,
  regionPlanned: (id) => `${renderOneLine(id)}: planned`,
  regionInserted: (id) => `${renderOneLine(id)}: inserted`,
  fileAbsent: (target) => `${renderOneLine(target)} is absent; the file is seeded at bootstrap.`,
  fileSymlink: (target) => `${renderOneLine(target)} is a symbolic link; no changes were made.`,
  fileUnreadable: (target) => `${renderOneLine(target)} cannot be read as a regular file; no changes were made.`,
  templateDefect: () => 'The bundled rules cannot be used; reinstall the kit with '
    + BACKTICK + REINSTALL + BACKTICK + '.',
  headingTwice: (label, target) => `The heading "${renderOneLine(label)}" occurs more than once in ${renderOneLine(target)}; no changes were made.`,
  anchorAbsent: (target) => `${renderOneLine(target)} has no numbered section in part 2 to insert after; no changes were made.`,
  capRefused: (target, count, cap) => `${renderOneLine(target)} would contain ${renderOneLine(count)} lines, exceeding its limit of ${renderOneLine(cap)}; trim the file and try again.`,
  writeFailed: (target) => `${renderOneLine(target)} could not be replaced; its contents were not changed.`,
  refusalLine: (name) => `[rules-insert] refusal=${renderOneLine(name)}`,
  errorDetail: (raw) => `[rules-insert] error=${JSON.stringify(String(raw)).replace(LINE_UNSAFE, escapeUnsafe)}`,
});

const refuse = (name, args = [], cause) => {
  const lines = [OUTCOME_LINES[COMPOSERS[name]](...args), OUTCOME_LINES.refusalLine(name)];
  if (DIAGNOSTIC_REFUSALS.has(name)) lines.push(OUTCOME_LINES.errorDetail(cause));
  return makeResult(EXIT_REFUSAL, '', lines.join(LF));
};

const parseArgs = (argv) => {
  const parsed = argv.reduce((state, argument) => {
    if (state.pending) {
      if (!argument || argument.startsWith(FLAG_PREFIX)) {
        throw new Error(`${state.pending} needs a value`);
      }
      return { options: { ...state.options, [FLAGS[state.pending]]: argument }, pending: null };
    }
    if (!Object.hasOwn(FLAGS, argument)) throw new Error(`unknown argument ${argument}`);
    const key = FLAGS[argument];
    if (Object.hasOwn(state.options, key)) throw new Error(`${argument} repeated`);
    if (argument === APPLY_FLAG) return { options: { ...state.options, apply: true }, pending: null };
    return { options: state.options, pending: argument };
  }, { options: {}, pending: null });
  if (parsed.pending) throw new Error(`${parsed.pending} needs a value`);
  if (!parsed.options.cwd) throw new Error(`${CWD_FLAG} is required`);
  return parsed.options;
};

const readTemplate = (deps) => {
  try {
    const read = deps.readFileSync ?? readFileSync;
    const text = read(deps.templatePath ?? TEMPLATE_PATH, UTF8);
    const spans = Object.fromEntries(REGIONS.map(({ id, headingRe }) => [
      id, readTemplateSpan(text, headingRe),
    ]));
    const defective = REGIONS.find(({ id }) => spans[id].defect);
    if (defective) {
      return { error: refuse(REFUSALS.templateDefect, [], `${defective.id}: ${spans[defective.id].defect}`) };
    }
    return { spans };
  } catch (error) {
    return { error: refuse(REFUSALS.templateDefect, [], readCause(error)) };
  }
};

const readDocument = (target, deps) => {
  const probe = deps.lstatSync ?? lstatSync;
  const read = deps.readFileSync ?? readFileSync;
  const status = (() => {
    try {
      return { stat: probe(target) };
    } catch (error) {
      const name = error?.code === ABSENT_CODE ? REFUSALS.fileAbsent : REFUSALS.fileUnreadable;
      return { error: refuse(name, [target], readCause(error)) };
    }
  })();
  if (status.error) return status;
  if (status.stat.isSymbolicLink()) return { error: refuse(REFUSALS.fileSymlink, [target]) };
  if (!status.stat.isFile()) {
    return { error: refuse(REFUSALS.fileUnreadable, [target], NON_REGULAR_CAUSE) };
  }
  try {
    return { text: decodeUtf8Strict(read(target)) };
  } catch (error) {
    return { error: refuse(REFUSALS.fileUnreadable, [target], readCause(error)) };
  }
};

const refusePlan = (plan, target) => {
  if (plan.refusal === REFUSALS.headingTwice) {
    const region = REGIONS.find(({ id }) => id === plan.region);
    return refuse(plan.refusal, [region.label, target]);
  }
  if (plan.refusal === REFUSALS.capRefused) return refuse(plan.refusal, [target, plan.count, plan.cap]);
  return refuse(plan.refusal, [target]);
};

const runInsert = (options, deps) => {
  const template = readTemplate(deps);
  if (template.error) return template.error;
  const root = resolve(options.cwd);
  const target = resolve(root, TARGET_RELATIVE);
  const document = readDocument(target, deps);
  if (document.error) return document.error;
  const cap = frontmatterMaxLines(document.text);
  const plan = planInsert({ text: document.text, spans: template.spans, cap });
  if (plan.refusal) return refusePlan(plan, target);
  const planned = new Set(plan.planned.map(({ id }) => id));
  const hasPlanned = Boolean(planned.size);
  if (options.apply && hasPlanned) {
    try {
      writeContainedFileAtomic(root, target, plan.text, {
        writeFile: deps.writeFile,
        rename: deps.rename,
        rm: deps.rm,
      });
    } catch (error) {
      return refuse(REFUSALS.writeFailed, [target], readCause(error));
    }
  }
  const composePlanned = options.apply ? OUTCOME_LINES.regionInserted : OUTCOME_LINES.regionPlanned;
  const stdout = REGIONS.map(({ id }) => (
    planned.has(id) ? composePlanned(id) : OUTCOME_LINES.regionPresent(id)
  )).join(LF);
  const stderr = hasPlanned && cap === null ? LENS_OUTCOME_LINES.capSkipNote() : '';
  return makeResult(EXIT_SUCCESS, stdout, stderr);
};

export const main = (argv, deps = {}) => {
  const parsed = (() => {
    try {
      return { options: parseArgs(argv) };
    } catch (error) {
      return { error: makeResult(EXIT_USAGE, '', OUTCOME_LINES.errorDetail(`${USAGE}; ${readCause(error)}`)) };
    }
  })();
  return parsed.error ?? runInsert(parsed.options, deps);
};

if (isDirectRun(import.meta.url)) {
  const result = await main(process.argv.slice(ARGV_OFFSET));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exitCode = result.code;
}
