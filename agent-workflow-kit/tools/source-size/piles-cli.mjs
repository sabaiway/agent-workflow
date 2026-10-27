#!/usr/bin/env node
// piles-cli.mjs — the writer of the pile rows: one queue row per recorded pile that has none, at the end
// of the queue's Later bucket, written only when the queue's own declared check and the readback accept
// it. The answer is the read core's readPileOffer, asked once; this file owns argv, the one atomic write
// and the lines. Nothing in the read graph imports it.
//
// Exit codes: 0 rows written, or every pile already has its row; 1 the offer is held, or the atomic
// write is refused, the queue byte-unchanged; 2 usage or config error, writing nothing.
//
// Dependency-free, Node >= 22.

import { join, resolve } from 'node:path';
import { writeContainedFileAtomic } from '../atomic-write.mjs';
import { isDirectRun } from '../direct-run.mjs';
import { loadDeclaration } from '../gates-declaration.mjs';
import { PILE_QUEUE_REL, readPileOffer } from '../source-size-core.mjs';

const HELP = `piles-cli — one queue row per recorded pile (agent-workflow-kit).

Usage:
  node piles-cli.mjs --write [--cwd <dir>]
  node piles-cli.mjs --help

--write  adds one two-line row per directory the layout record of docs/ai/source-size.json holds
         beyond its entries band and no queue row names by its id, at the end of the one heading of
         ${PILE_QUEUE_REL} reading Later or opening with Later and a space; nothing is written
         when the queue's own check in docs/ai/gates.json would refuse the result or the rows would
         not read back.
--cwd    the project root (default: the current directory).

Exit codes: 0 written, or nothing to write; 1 held or refused, nothing written; 2 usage or config error.`;

const usage = (message) => ({ code: 2, stdout: '', stderr: `piles-cli: ${message} (see --help)` });

// The argv: --write once, --cwd <dir> at most once, nothing else; --help only as the whole argv.
const parse = (argv) => {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  let write = false;
  let cwd;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write' && !write) write = true;
    else if (arg === '--cwd' && cwd === undefined && argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) {
      cwd = argv[index + 1];
      index += 1;
    } else return { error: `unexpected argument ${JSON.stringify(arg)}` };
  }
  return write ? { cwd } : { error: '--write is the one mode' };
};

// The declaration as the offer takes it: the loader's answer, or its error.
const declarationOf = (root, deps) => {
  try {
    return loadDeclaration(root, deps);
  } catch (err) {
    return { outcome: 'error', message: err.message };
  }
};

export const main = (argv, ctx = {}) => {
  const options = parse(argv);
  if (options.help) return { code: 0, stdout: HELP, stderr: '' };
  if (options.error !== undefined) return usage(options.error);
  const deps = ctx.deps ?? {};
  const root = resolve(ctx.cwd ?? process.cwd(), options.cwd ?? '.');
  let offer;
  try {
    offer = readPileOffer(root, declarationOf(root, deps), deps);
  } catch (err) {
    return { code: 2, stdout: '', stderr: `piles-cli: ${err.message}` };
  }
  if (offer.answer === 'none') return { code: 0, stdout: 'every recorded pile has its queue row — nothing to write', stderr: '' };
  if (offer.answer === 'held') return { code: 1, stdout: '', stderr: offer.text };
  try {
    writeContainedFileAtomic(root, join(root, PILE_QUEUE_REL), offer.text, deps, { label: PILE_QUEUE_REL });
  } catch (err) {
    return { code: 1, stdout: '', stderr: `piles-cli: the write of ${PILE_QUEUE_REL} was refused — ${err.message}` };
  }
  const queued = offer.piles.map(({ id, key }) => `queued: ${id} — ${key}`);
  return { code: 0, stdout: [...queued, `wrote ${offer.rows.length} row(s) to ${PILE_QUEUE_REL}`].join('\n'), stderr: '' };
};

if (isDirectRun(import.meta.url)) {
  const result = main(process.argv.slice(2));
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.code;
}
