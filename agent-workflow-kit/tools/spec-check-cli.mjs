#!/usr/bin/env node
// The CLI half of the structural checker: argv and fs, no rule (the rules are spec-check.mjs and
// spec-check-ops.mjs). The change source is EXPLICIT and never git — a session states what it did.
//
//   node spec-check-cli.mjs --op modify=docs/ai/specs/login.md [--op ...] [--root <dir>]
//   node spec-check-cli.mjs --ops-file docs/plans/spec-ops.list
//   node spec-check-cli.mjs --all
//
// `--op` and `--ops-file` UNION and dedup by identity; `--all` is exclusive of both. The register
// `--ops-file` names is session scratch, and it is never defaulted: guessing which file states the
// change set would attest a post-state nobody declared (the fold-scope --queue precedent). A named
// register that does not exist is usage, not an empty change set.
//
// The leaf read is the family's descriptor-bound no-follow door (fs-read-nofollow.mjs) — a pathname
// swapped after the probe cannot change the bytes judged. Read-only, records nothing: ADVISORY, so
// a skipped or late call is indistinguishable from one that ran.
//
// Exit codes: 0 ACCEPT; 1 one or more findings; 2 usage — a missing/unknown flag, a bad op, an
// unreadable register, a --root that is not a directory, or an --all run with no store root.
// Dependency-free, Node >= 22.

import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDirectRun } from './direct-run.mjs';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';
import { SPEC_OPS_GRAMMAR, parseSpecOps } from './spec-check-ops.mjs';
import { checkSpecs } from './spec-check.mjs';

const { verbs, separator, storePrefix } = SPEC_OPS_GRAMMAR;

const HELP = `spec-check — judge the feature-spec store against what this session says it changed.

Usage:
  node spec-check-cli.mjs [--root <dir>] --op <op> [--op <op> ...]
  node spec-check-cli.mjs [--root <dir>] --ops-file <file>
  node spec-check-cli.mjs [--root <dir>] --all

An op is one of ${verbs.slice(0, -1).map((v) => `${v}=<path>`).join(' | ')} | rename=<old>${separator}<new>, and every
path is a POSIX repo-relative .md document inside ${storePrefix} whose segments are kebab slugs.
Nothing is normalized away and the store root is never an op target, so one document has exactly
one accepted spelling.

  --op        repeatable; unions --ops-file and dedups by identity.
  --ops-file  one op per line; blank lines and # comments parse away. Never defaulted — name the
              register this session wrote (e.g. docs/plans/spec-ops.list).
  --all       judge the WHOLE store instead: reachability (unlisted child vs orphan), acyclicity,
              store-wide slug uniqueness and module overlap. Exclusive of both op sources.
  --root      the repo root the paths are relative to (default: the process cwd).

The check is advisory — nothing records that it ran, so a skipped or late call is indistinguishable
from one made before the edit.

Exit codes: 0 ACCEPT; 1 findings; 2 usage (bad flag or op, unreadable register, bad --root).`;

const FLAGS = ['op', 'ops-file', 'all', 'root'];
const REPEATABLE = ['op'];
const BOOLEAN = ['all'];

const parseArgs = (argv) => {
  const opts = { op: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') ? arg.slice(2, eq === -1 ? undefined : eq) : null;
    if (!name || !FLAGS.includes(name)) throw new Error(`unexpected argument "${arg}" (flags: ${FLAGS.map((f) => `--${f}`).join(', ')})`);
    if (BOOLEAN.includes(name)) {
      if (eq !== -1) throw new Error(`--${name} takes no value`);
      opts[name] = true;
      continue;
    }
    let value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1);
    if (eq === -1) i += 1;
    if (value === undefined || (eq === -1 && value.startsWith('--'))) throw new Error(`--${name} requires a value`);
    if (REPEATABLE.includes(name)) opts[name].push(value);
    else opts[name] = value;
  }
  return opts;
};

// The probe: a fail-closed lstat CLASSIFICATION, never a boolean. A symlink is its own state (it is
// never followed to decide what sits at a path), and anything that cannot be stat-ed at all is
// "unreadable" rather than "absent" — the two lead to different verdicts and must not collapse.
export const probe = (path) => {
  try {
    const st = lstatSync(path);
    return st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'unreadable';
  } catch (err) {
    return err && err.code === 'ENOENT' ? 'absent' : 'unreadable';
  }
};

export const realpath = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

export const list = (path) => {
  try {
    return readdirSync(path);
  } catch {
    return null;
  }
};

// A LINE ENDING is not content: the split takes CRLF as well as LF, so a register saved on Windows
// reads like one saved anywhere else. Blank and `#` lines parse away; every OTHER line is handed on
// UNTRIMMED, because trimming here would let the file lane accept a spelling the --op lane refuses —
// exactly the alias the frozen grammar denies. The ops parser refuses that whitespace out loud.
const opsFileLines = (text) => text.split(/\r?\n/).filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));

// main(argv, deps) -> { code, stdout, stderr }. Never calls process.exit itself (the direct-run
// guard does), and never reads anything the caller did not point it at.
export const main = (argv, deps = {}) => {
  if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
  const read = deps.readFileSync ?? readFileSync;
  const cwd = deps.cwd ?? (() => process.cwd());
  const usage = (message) => ({ code: 2, stdout: '', stderr: `spec-check: ${message}` });
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    return usage(err.message);
  }
  if (opts.all && (opts.op.length > 0 || opts['ops-file'])) {
    return usage('--all judges the whole store and is exclusive of --op and --ops-file — run one lane or the other');
  }
  const root = resolve(cwd(), opts.root ?? '.');
  if (probe(root) !== 'dir') return usage(`--root "${opts.root ?? cwd()}" is not a directory`);
  let specs = [...opts.op];
  if (opts['ops-file']) {
    const register = resolve(cwd(), opts['ops-file']);
    try {
      specs = [...specs, ...opsFileLines(read(register, 'utf8'))];
    } catch (err) {
      return usage(`--ops-file "${opts['ops-file']}" is unreadable — ${(err && err.message) || err}`);
    }
  }
  let ops = [];
  if (!opts.all) {
    const parsed = parseSpecOps(specs);
    if (parsed.errors.length > 0) {
      return usage(parsed.errors.map((e) => `${e.code} — ${e.message}`).join('\nspec-check: '));
    }
    ops = parsed.ops;
  }
  const decided = checkSpecs({ root, ops, all: Boolean(opts.all) }, { read: readRegularFileNoFollow, probe, realpath, list });
  return { code: decided.exit, stdout: decided.lines.join('\n'), stderr: '' };
};

if (isDirectRun(import.meta.url)) {
  const result = main(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.code);
}
