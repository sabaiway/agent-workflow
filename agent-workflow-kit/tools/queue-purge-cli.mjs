#!/usr/bin/env node
import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fail } from '../references/scripts/markdown-blocks.mjs';
import { isDirectRun } from './direct-run.mjs';
import { EXIT, appendBlock, readArchive } from './queue-purge-archive.mjs';
import { snapshotQueue, checkPurge } from './queue-purge.mjs';

const VERBS = ['snapshot', '--check'];
const OPTIONS = new Map([['--section', 'section'], ['--archive', 'archive']]);
const HELP_FLAGS = ['--help', '-h'];
const HELP = `Usage:
  node queue-purge-cli.mjs snapshot <queue-file> --section <heading> --archive <file>
  node queue-purge-cli.mjs --check <queue-file> --section <heading> --archive <file>

snapshot appends the section bytes and row index; --check verifies the purge without writing.
Exit codes: 0 accept, 1 refuse, 2 usage. --help or -h must be the whole invocation.`;

const parseArgv = (argv) => {
  if (argv.length === 1 && HELP_FLAGS.includes(argv[0])) return { help: true };
  const options = {};
  const state = { index: 0 };
  const readValue = (flag) => {
    const value = argv[state.index + 1];
    if (!value || value.startsWith('-') || VERBS.includes(value)) throw fail(EXIT.usage, `${flag} takes a value`);
    state.index += 1;
    return value;
  };
  while (state.index < argv.length) {
    const arg = argv[state.index];
    if (VERBS.includes(arg)) {
      if (options.verb) throw fail(EXIT.usage, 'name exactly one verb: snapshot or --check');
      options.verb = arg;
      options.queuePath = readValue(arg);
    } else if (OPTIONS.has(arg)) {
      const field = OPTIONS.get(arg);
      if (Object.hasOwn(options, field)) throw fail(EXIT.usage, `${arg} was given twice`);
      options[field] = readValue(arg);
    } else if (HELP_FLAGS.includes(arg)) throw fail(EXIT.usage, '--help is answered only as the whole invocation');
    else throw fail(EXIT.usage, `unknown argument ${JSON.stringify(arg)}`);
    state.index += 1;
  }
  if (!options.verb) throw fail(EXIT.usage, 'exactly one verb is required: snapshot or --check');
  for (const [flag, field] of OPTIONS) if (!options[field]) throw fail(EXIT.usage, `${flag} is required`);
  return options;
};

const readRegular = (path, read) => {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw fail(EXIT.usage, `${path}: not a regular file`);
    return read(descriptor, stats);
  } finally { closeSync(descriptor); }
};

const readFiles = ({ queuePath, archive, verb }) => {
  const queueReal = realpathSync(queuePath);
  const queue = readRegular(queueReal, (descriptor, stats) => ({ bytes: readFileSync(descriptor), stats }));
  if (!statSync(dirname(archive)).isDirectory()) throw fail(EXIT.usage, `${archive}: parent is not a directory`);
  const archiveReal = (() => {
    try { return realpathSync(archive); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  })();
  if (resolve(queuePath) === resolve(archive) || queueReal === archiveReal) {
    throw fail(EXIT.usage, `${archive}: archive resolves to the queue ${queuePath}`);
  }
  const archiveBytes = (() => {
    try {
      return readRegular(archive, (descriptor, stats) => {
        if (stats.dev === queue.stats.dev && stats.ino === queue.stats.ino) {
          throw fail(EXIT.usage, `${archive}: archive is a hard link to the queue ${queuePath}`);
        }
        return readFileSync(descriptor);
      });
    } catch (error) {
      if (error.code === 'ENOENT' && verb === 'snapshot') return Buffer.alloc(0);
      throw error;
    }
  })();
  if (!archiveBytes.length && verb === '--check') throw fail(EXIT.usage, `${archive}: empty archive`);
  return { queueBytes: queue.bytes, archiveBytes };
};

export const main = (argv, { log = console.log, error = console.error } = {}) => {
  const state = { fallback: EXIT.usage, options: null };
  try {
    const options = parseArgv(argv);
    state.options = options;
    if (options.help) { log(HELP); return EXIT.accept; }
    const inputs = readFiles(options);
    const args = { ...options, ...inputs, date: new Date().toISOString().split('T')[0] };
    const result = options.verb === 'snapshot' ? snapshotQueue(args) : checkPurge(args);
    for (const problem of result.problems) error(problem);
    if (!result.ok) return EXIT.refuse;
    if (options.verb === 'snapshot') {
      state.fallback = EXIT.refuse;
      appendBlock(options.archive, result.block);
      const [block] = readArchive(result.block).blocks;
      for (const note of result.notes) error(note);
      log(`${options.archive}: ${block.rowCount} rows, ${block.sectionBytes.length} section bytes (${block.section})`);
    } else log(`accept: ${options.section}; archive ${options.archive}`);
    return EXIT.accept;
  } catch (err) {
    const paths = state.options ? `${state.options.queuePath}; archive ${state.options.archive}: ` : '';
    error(`${paths}${err.message}`);
    return [EXIT.refuse, EXIT.usage].includes(err.exitCode) ? err.exitCode : state.fallback;
  }
};

if (isDirectRun(import.meta.url)) process.exitCode = main(process.argv.slice(2));
