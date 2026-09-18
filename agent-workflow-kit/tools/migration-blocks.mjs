#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS_MD_CAP } from './inject-methodology.mjs';
import { writeContainedFileAtomic } from './atomic-write.mjs';
import { isDirectRun } from './direct-run.mjs';

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;
const ANCHOR = '## 🧭 Memory Map';
const TEMPLATE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'references', 'templates', 'AGENTS.md');
const REINSTALL = 'npx @sabaiway/agent-workflow-kit@latest init';
const BLOCKS = [
  { name: 'communication', heading: '## 🗣️ Communication language', flag: 'language', placeholder: '{{COMM_LANGUAGE}}' },
  { name: 'attribution', heading: '## ✍️ Attribution', flag: 'attribution', placeholder: '{{AGENT_ATTRIBUTION}}' },
];
const FLAGS = ['--cwd', '--language', '--attribution', '--apply'];
const USAGE = 'usage: migration-blocks.mjs --cwd <project> [--language <text>] [--attribution on|off] [--apply]';
const CONTROL_BYTES = /[\x00-\x1f\x7f\u2028\u2029]/u;

const makeResult = (code, stdout = '', stderr = '') => ({ code, stdout, stderr });
const renderDetail = (detail) => String(detail).replace(/[\r\n\u2028\u2029]+/gu, ' ');
const refuse = (name, detail) => makeResult(1, '', detail ? `${name}: ${renderDetail(detail)}` : name);
const countLines = (text) => text.split(LF).length - Number(text.endsWith(LF));
const findHeadings = (lines, heading) => lines.flatMap((line, index) => line.trimEnd() === heading ? [index] : []);

const parseArgs = (argv) => {
  const parsed = argv.reduce((state, argument) => {
    if (state.pending) {
      if (argument.startsWith('--')) throw new Error(`${state.pending} needs a value`);
      return { options: { ...state.options, [state.pending.slice(2)]: argument }, pending: null };
    }
    if (!FLAGS.includes(argument)) throw new Error(`unknown argument ${argument}`);
    const key = argument.slice(2);
    if (Object.hasOwn(state.options, key)) throw new Error(`${argument} repeated`);
    if (argument === '--apply') return { options: { ...state.options, apply: true }, pending: null };
    return { options: state.options, pending: argument };
  }, { options: {}, pending: null });
  if (parsed.pending) throw new Error(`${parsed.pending} needs a value`);
  if (!parsed.options.cwd) throw new Error('--cwd is required');
  return parsed.options;
};

const checkAnswers = ({ language, attribution }) => {
  if (language !== undefined && (!language.trim() || CONTROL_BYTES.test(language))) {
    return refuse('language', 'provide one nonempty line without control bytes');
  }
  if (attribution !== undefined && !['on', 'off'].includes(attribution)) {
    return refuse('attribution', 'expected on or off');
  }
  return null;
};

const extractSpans = (template) => {
  const lines = template.split(CRLF).join(LF).split(LF);
  return BLOCKS.map((block) => {
    const headings = findHeadings(lines, block.heading);
    if (headings.length !== 1) throw new Error(`${block.name} heading must occur once`);
    const start = headings[0];
    const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
    const span = next < 0 ? lines.slice(start).join(LF) : lines.slice(start, next).join(LF) + LF;
    if (span.split(block.placeholder).length !== 2) {
      throw new Error(`${block.name} placeholder must occur once in its span`);
    }
    return { ...block, span };
  });
};

const readTemplate = (path, deps) => {
  try {
    const read = deps.readFileSync ?? readFileSync;
    return { spans: extractSpans(read(path, 'utf8')) };
  } catch (error) {
    return { error: refuse('template', `${error.message}; run ${REINSTALL}`) };
  }
};

const readDocument = (path, deps) => {
  const probe = deps.lstatSync ?? lstatSync;
  const read = deps.readFileSync ?? readFileSync;
  const status = (() => {
    try {
      return { stat: probe(path) };
    } catch (error) {
      const name = error.code === 'ENOENT' ? 'file-absent' : 'file-unreadable';
      return { error: refuse(name, error.message) };
    }
  })();
  if (status.error) return status;
  if (status.stat.isSymbolicLink()) return { error: refuse('file-symlink', path) };
  if (!status.stat.isFile()) return { error: refuse('file-unreadable', `${path} is not a regular file`) };
  try {
    return { text: read(path, 'utf8') };
  } catch (error) {
    return { error: refuse('file-unreadable', error.message) };
  }
};

const classifyBlock = (block, lines, answers, newline) => {
  const headings = findHeadings(lines, block.heading);
  const answer = answers[block.flag];
  if (headings.length > 1) return { error: refuse('heading-twice', block.name) };
  if (headings.length === 1) {
    return { ...block, state: 'present', index: headings[0], ignored: answer !== undefined };
  }
  if (answer === undefined) return { ...block, state: 'needs' };
  const body = block.span.split(block.placeholder).join(answer).split(LF).join(newline);
  return { ...block, state: 'planned', body };
};

const renderBlock = (block, applied) => {
  if (block.state === 'present') return `${block.name}: present${block.ignored ? '; answer ignored' : ''}`;
  if (block.state === 'needs') return `${block.name}: needs --${block.flag}`;
  return `${block.name}: ${applied ? 'inserted' : 'planned'}`;
};

const insertBlocks = (text, lines, blocks) => {
  const planned = blocks.filter((block) => block.state === 'planned');
  if (planned.length === 0) return { body: text };
  const anchors = lines.flatMap((line, index) => line.replace(/\r$/u, '') === ANCHOR ? [index] : []);
  if (anchors.length === 0) return { error: refuse('anchor-absent', ANCHOR) };
  if (anchors.length !== 1) return { error: refuse('anchor-repeated', ANCHOR) };
  const total = countLines(text) + planned.reduce((count, block) => count + countLines(block.body), 0);
  if (total > AGENTS_MD_CAP) {
    return { error: refuse('cap', `${total} lines exceed ${AGENTS_MD_CAP}; trim AGENTS.md and re-run`) };
  }
  const anchor = anchors[0];
  const attribution = blocks.find((block) => block.name === 'attribution');
  const insertions = planned.map((block) => ({
    ...block,
    index: block.name === 'communication' && attribution.state === 'present' && attribution.index < anchor
      ? attribution.index : anchor,
  }));
  const body = lines.map((line, index) => {
    const prefix = insertions.filter((block) => block.index === index).map((block) => block.body).join('');
    return prefix + line;
  }).join(LF);
  return { body };
};

export const planBlocks = ({ text, spans, language, attribution, apply = false }) => {
  const lines = text.split(LF);
  const newline = text.includes(CRLF) ? CRLF : LF;
  const blocks = spans.map((block) => classifyBlock(block, lines, { language, attribution }, newline));
  const refused = blocks.find((block) => block.error);
  if (refused) return { result: refused.error, write: false };
  const insertion = insertBlocks(text, lines, blocks);
  if (insertion.error) return { result: insertion.error, write: false };
  const missing = blocks.some((block) => block.state === 'needs');
  const write = apply && !missing && blocks.some((block) => block.state === 'planned');
  const stdout = blocks.map((block) => renderBlock(block, write)).join(LF);
  const result = apply && missing ? makeResult(1, stdout, 'answer-missing') : makeResult(0, stdout);
  return { result, write, body: insertion.body };
};

const runBlocks = (options, deps) => {
  const invalid = checkAnswers(options);
  if (invalid) return invalid;
  const template = readTemplate(deps.templatePath ?? TEMPLATE_PATH, deps);
  if (template.error) return template.error;
  const root = resolve(options.cwd);
  const destination = resolve(root, 'AGENTS.md');
  const document = readDocument(destination, deps);
  if (document.error) return document.error;
  const plan = planBlocks({ ...options, text: document.text, spans: template.spans });
  if (plan.write) {
    try {
      writeContainedFileAtomic(root, destination, plan.body, {
        writeFile: deps.writeFile,
        rename: deps.rename,
        rm: deps.rm,
      });
    } catch (error) {
      return refuse('write-failed', error.message);
    }
  }
  return plan.result;
};

export const main = (argv, deps = {}) => {
  const parsed = (() => {
    try {
      return { options: parseArgs(argv) };
    } catch (error) {
      return { error: makeResult(2, '', `${USAGE}; ${renderDetail(error.message)}`) };
    }
  })();
  return parsed.error ?? runBlocks(parsed.options, deps);
};

if (isDirectRun(import.meta.url)) {
  const result = await main(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.code);
}
