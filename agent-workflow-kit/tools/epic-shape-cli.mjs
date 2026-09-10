#!/usr/bin/env node
import { constants, openSync, closeSync, fstatSync, readdirSync, writeSync, ftruncateSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fail } from '../references/scripts/markdown-blocks.mjs';
import { isDirectRun } from './direct-run.mjs';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';
import { checkEpic } from './epic-shape.mjs';
import { checkClaims, sweepSiblings, judgeClose, STORE_PATH, QUEUE_PATH } from './epic-shape-ledger.mjs';
import { renderBrief, foldFindings } from './epic-shape-brief.mjs';

const EXIT = Object.freeze({ accept: 0, refuse: 1, usage: 2 });
const CHECK = '--check';
const BRIEF = '--review-brief';
const FOLD = '--fold';
const CLOSE = '--close';
const VERBS = Object.freeze([CHECK, BRIEF, FOLD, CLOSE]);
const HELP_FLAG = '--help';
const HELP_ARITY = 1;
const VERB_ARITY = 2;
const FIRST_LINE = 1;
const MARKDOWN_SUFFIX = '.md';
const PREFIX = 'epic-shape:';
const INFO = 'info';
const STORE_TO_PROJECT = '../../..';
const LANDED_BYTES = Buffer.from('landed');
const HELP = `Usage:
  node epic-shape-cli.mjs --check <epic>
  node epic-shape-cli.mjs --review-brief <epic>
  node epic-shape-cli.mjs --fold <findings-file>
  node epic-shape-cli.mjs --close <epic>
  node epic-shape-cli.mjs --help

Only --close writes: the epic header state becomes landed.
Exit codes: 0 accept, 1 refuse, 2 usage.`;

const parseArgv = (argv) => {
  if (argv.length === HELP_ARITY && argv[0] === HELP_FLAG) return { help: true };
  const [verb, path] = argv;
  if (argv.length !== VERB_ARITY || !VERBS.includes(verb) || !path || path.startsWith('-')) {
    throw fail(EXIT.usage, 'use --help alone, or exactly one verb followed by exactly one path that does not open with a dash');
  }
  return { verb, path: resolve(path) };
};
const makeFailure = (path, code, message) => Object.assign(fail(EXIT.refuse, message), { path, code });
const formatFinding = (finding, fallbackPath) => {
  const path = finding.path ?? fallbackPath;
  const prefix = `${path}: `;
  const message = finding.message.startsWith(prefix) ? finding.message.slice(prefix.length) : finding.message;
  return `${PREFIX} ${path}:${finding.line ?? FIRST_LINE}: ${finding.code}: ${message}`;
};
const printFindings = (findings, path, io) => {
  for (const finding of findings) (finding.severity === INFO ? io.log : io.error)(formatFinding(finding, path));
};
const printAccept = (verb, path, log) => log(`${PREFIX} accept ${verb} ${path}`);
const printSweep = (sweep, log) => log(`${PREFIX} sweep ${sweep.root}: epics read ${sweep.counts.epicsRead + FIRST_LINE}; entries skipped ${sweep.counts.skipped}`);
const describeRead = (result) => result.code ?? result.className ?? result.outcome;
const openWritable = (path, flags) => openSync(path, flags | constants.O_RDWR);
const readInput = (path, read, writable) => {
  const result = read(path, writable ? { keepFd: true, open: openWritable } : {});
  if (result.outcome !== 'ok') throw makeFailure(path, 'read', describeRead(result));
  return result;
};
const readDirectory = (root, read) => readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
  const name = entry.name;
  if (entry.isDirectory()) return { name, outcome: 'directory' };
  if (!name.endsWith(MARKDOWN_SUFFIX)) return { name, text: '' };
  const result = read(join(root, name));
  if (result.outcome === 'ok') return { name, text: result.content };
  if (result.outcome === 'foreign') return { name, outcome: 'non-regular', kind: result.className };
  return { name, outcome: 'unreadable', reason: describeRead(result) };
});
const readQueue = (path, read) => {
  if (!STORE_PATH.test(path)) return { outcome: 'unreadable', reason: 'epic is outside a project store' };
  const queuePath = resolve(dirname(path), STORE_TO_PROJECT, QUEUE_PATH);
  const result = read(queuePath);
  return result.outcome === 'ok' ? result.content : { outcome: result.outcome, reason: describeRead(result) };
};

const writeAll = (fd, bytes, position, path, offset = 0) => {
  if (offset === bytes.length) return;
  const written = writeSync(fd, bytes, offset, bytes.length - offset, position + offset);
  if (written <= 0) throw makeFailure(path, 'write', 'the descriptor write made no progress');
  writeAll(fd, bytes, position, path, offset + written);
};
const writeState = (input, range, path) => {
  const stats = fstatSync(input.fd);
  if (stats.nlink !== FIRST_LINE) throw makeFailure(path, 'hardlink', 'close refuses a file with a second hard link');
  if (!stats.isFile() || stats.dev !== input.dev || stats.ino !== input.ino || stats.size !== input.bytes.length) throw makeFailure(path, 'changed-file', 'the held file changed after the check');
  const suffix = Buffer.concat([LANDED_BYTES, input.bytes.subarray(range.end)]);
  writeAll(input.fd, suffix, range.start, path);
  ftruncateSync(input.fd, range.start + suffix.length);
};
const runFold = (input, path, io) => {
  const result = foldFindings(input.content);
  io.log(`${PREFIX} kept (${result.counts.kept})`);
  for (const entry of result.kept) io.log(`${entry.line}: ${entry.text}`);
  io.log(`${PREFIX} discarded (${result.counts.discarded})`);
  for (const entry of result.discarded) io.log(`${entry.line}: ${entry.reason} (line ${entry.reasonLine})\n${entry.text}`);
  io.log(`${PREFIX} outside (${result.counts.outside})`);
  for (const line of result.outside) io.log(`${line.line}: ${line.text}`);
  printFindings(result.findings, path, io);
  if (!result.ok) return EXIT.refuse;
  printAccept(FOLD, path, io.log);
  return EXIT.accept;
};
const runEpic = (verb, input, path, io) => {
  const entries = readDirectory(dirname(path), io.read).filter((entry) => entry.name !== basename(path));
  const shape = checkEpic(input.content, path);
  const sweep = sweepSiblings(entries, dirname(path));
  const claims = shape.findings.length === 0 && sweep.ok
    ? checkClaims([shape.epic, ...sweep.epics]) : { findings: [] };
  const findings = [...shape.findings, ...sweep.findings, ...claims.findings];
  const output = verb === BRIEF ? { ...io, log: io.error } : io;
  printSweep(sweep, output.log);
  if (findings.some((finding) => finding.severity !== INFO)) {
    printFindings(findings, path, output);
    return EXIT.refuse;
  }
  if (verb === CLOSE) {
    const closed = judgeClose({ epic: input.content, path, queue: readQueue(path, io.read), entries });
    printFindings(closed.findings, path, io);
    if (!closed.ok) return EXIT.refuse;
    writeState(input, closed.stateRange, path);
  } else {
    printFindings(findings, path, output);
    if (verb === BRIEF) {
      const brief = renderBrief(input.content, path);
      if (typeof brief !== 'string') { printFindings(brief.findings, path, output); return EXIT.refuse; }
      io.log(brief.slice(0, -FIRST_LINE));
    }
  }
  printAccept(verb, path, output.log);
  return EXIT.accept;
};

export const main = (argv, { log = console.log, error = console.error, read = readRegularFileNoFollow } = {}) => {
  try {
    const options = parseArgv(argv);
    if (options.help) { log(HELP); return EXIT.accept; }
    const input = readInput(options.path, read, options.verb === CLOSE);
    try {
      const io = { log, error, read };
      return options.verb === FOLD ? runFold(input, options.path, io) : runEpic(options.verb, input, options.path, io);
    } finally {
      if (input.fd !== undefined) closeSync(input.fd);
    }
  } catch (failure) {
    error(formatFinding({ path: failure.path, line: FIRST_LINE, code: failure.code ?? 'usage', message: failure.message }, argv[1] ?? 'invocation'));
    return failure.exitCode === EXIT.usage ? EXIT.usage : EXIT.refuse;
  }
};

if (isDirectRun(import.meta.url)) process.exitCode = main(process.argv.slice(VERB_ARITY));
