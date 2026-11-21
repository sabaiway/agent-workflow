#!/usr/bin/env node
// The CLI half of the structural checker: argv and fs, no rule (the rules are spec-check.mjs and
// spec-check-ops.mjs). The change source is EXPLICIT and never git — a session states what it did.
//
//   node spec-check-cli.mjs --op modify=docs/ai/specs/login.md [--op ...] [--root <dir>]
//   node spec-check-cli.mjs --ops-file docs/plans/spec-ops.list
//   node spec-check-cli.mjs --plan docs/plans/<name>.md [--root <dir>]
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

import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, posix, relative, resolve, sep } from 'node:path';
import { readSpecDocument } from '../references/scripts/spec-schema/index.mjs';
import { dirCovers } from './declared-paths.mjs';
import { isDirectRun } from './direct-run.mjs';
import { describeNonRegular, lstatNoFollowRead, readRegularFileNoFollow } from './fs-read-nofollow.mjs';
import { PLANS_REL } from './plan-files.mjs';
import { expandSweepPaths, isSweep, readPlansInFlight } from './plan-shape-facts.mjs';
import { SPEC_OPS_GRAMMAR, getRevisionHomePath, getRevisionStorePath, listingParentOf, parsePlanSpecOps, parseSpecOps } from './spec-check-ops.mjs';
import { checkSpecs } from './spec-check.mjs';

const { verbs, separator, storePrefix, storeRoot, suffix } = SPEC_OPS_GRAMMAR;

const HELP = `spec-check — judge the feature-spec store against what this session says it changed.

Usage:
  node spec-check-cli.mjs [--root <dir>] --op <op> [--op <op> ...]
  node spec-check-cli.mjs [--root <dir>] --ops-file <file>
  node spec-check-cli.mjs [--root <dir>] --plan docs/plans/<name>.md
  node spec-check-cli.mjs [--root <dir>] --all

An op is one of ${verbs.slice(0, -1).map((v) => `${v}=<path>`).join(' | ')} | rename=<old>${separator}<new>, and every
path is a POSIX repo-relative .md document inside ${storePrefix} whose segments are kebab slugs.
Nothing is normalized away and the store root is never an --op or --ops-file target (--plan judges
it by a modify row), so one document has exactly one accepted spelling.

  --op        repeatable; unions --ops-file and dedups by identity.
  --ops-file  one op per line; blank lines and # comments parse away. Never defaulted — name the
              register this session wrote (e.g. docs/plans/spec-ops.list).
  --plan      judge the named in-flight plan's store rows and revisions. Exclusive of --op, --ops-file and --all.
  --all       judge the WHOLE store instead: reachability (unlisted child vs orphan), acyclicity,
              store-wide slug uniqueness and module overlap. Exclusive of --op, --ops-file and --plan.
  --root      the repo root the paths are relative to (default: the process cwd).

The check is advisory — nothing records that it ran, so a skipped or late call is indistinguishable
from one made before the edit.

Exit codes: 0 ACCEPT; 1 findings; 2 usage (bad flag or op, unreadable register, bad --root).`;

const FLAGS = ['op', 'ops-file', 'plan', 'all', 'root'];
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
    if (name === 'plan' && opts.plan !== undefined) throw new Error('--plan takes exactly one plan');
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

const causeOf = (error) => error?.code ?? error?.message ?? String(error);
const pathError = (path, message) => Object.assign(new Error(message), { path });
const readContent = (path) => {
  const { outcome, code, className, content } = readRegularFileNoFollow(path);
  if (outcome !== 'ok') throw pathError(path, `cannot read (${code ?? className ?? (outcome === 'absent' ? 'ENOENT' : outcome)})`);
  return content;
};
const isPlanSpelling = (path) => path === `${PLANS_REL}/${posix.basename(path)}` &&
  path.endsWith(suffix) && posix.basename(path).length > suffix.length && !/[\\\0]/.test(path);
const repoPath = (root, path) => relative(root, path).split(sep).join('/');

const proveRevisionHome = (root, home, ops, files) => {
  const homePath = resolve(root, home);
  const status = lstatNoFollowRead(homePath);
  if (status === null) return;
  const rootReal = realpathSync(root);
  const roles = new Map(ops.map(({ verb, target }) => [target, verb]));
  const proveDirectory = (path, status) => {
    if (!status.isDirectory()) throw pathError(path, `expected a plain directory, found ${describeNonRegular(status)}`);
    if (!dirCovers(root, path) || !dirCovers(rootReal, realpathSync(path))) throw pathError(path, 'directory resolves outside the root');
  };
  const proveParents = (path) => {
    if (path === root) return;
    proveParents(dirname(path));
    proveDirectory(path, lstatSync(path));
  };
  const readStore = (rel, allowAbsent = false) => {
    const path = resolve(root, rel);
    proveParents(dirname(path));
    const status = lstatNoFollowRead(path);
    if (status === null && allowAbsent) return null;
    if (!status?.isFile()) throw pathError(path, `expected a regular store document, found ${status === null ? 'ENOENT' : describeNonRegular(status)}`);
    const content = readContent(path);
    return { ...readSpecDocument(content, rel.slice(storePrefix.length)), content };
  };
  const admit = (path) => {
    const rel = getRevisionStorePath(home, repoPath(root, path));
    const role = roles.get(rel);
    if (rel === storeRoot || (role !== 'modify' && role !== 'add')) throw pathError(path, 'no eligible store row for this home file');
    const content = readContent(path);
    const { kind } = readSpecDocument(content, rel.slice(storePrefix.length));
    const parent = listingParentOf(rel);
    if (role === 'add' ? kind !== 'part' || roles.get(parent) !== 'modify' : kind !== 'spec' && kind !== 'part') {
      throw pathError(path, 'expected a contract revision or a new part beside a root the plan modifies');
    }
    const stored = readStore(rel, role === 'add');
    if (role === 'modify' && stored.kind !== kind) throw pathError(resolve(root, rel), 'the store document and its revision must have the same kind');
    if (role === 'add' && stored !== null && stored.content !== content) throw pathError(resolve(root, rel), 'store and home bytes differ');
    const contract = kind === 'part' ? readStore(parent) : stored;
    const isLandedCopy = (target, document) => {
      const source = resolve(root, home, target.slice(storePrefix.length));
      return lstatNoFollowRead(source)?.isFile() === true && readContent(source) === document.content;
    };
    const landed = stored?.content === content || isLandedCopy(kind === 'part' ? parent : rel, contract);
    if (contract.kind !== 'spec' || (contract.status !== 'live' && !landed) ||
      (role === 'modify' && kind === 'part' && !contract.structure?.parts.some(({ target }) => target === `./${basename(rel)}`))) {
      throw pathError(path, 'the home document must revise or belong to a live contract in the store');
    }
    files.set(rel, path);
  };
  const walk = (path, status) => {
    proveDirectory(path, status);
    for (const name of readdirSync(path)) {
      const entry = resolve(path, name);
      const status = lstatSync(entry);
      if (status.isDirectory()) walk(entry, status);
      else if (status.isFile()) admit(entry);
      else throw pathError(entry, `expected a plain directory or regular file, found ${describeNonRegular(status)}`);
    }
  };
  proveParents(dirname(homePath));
  walk(homePath, status);
};

const storeIO = { read: readRegularFileNoFollow, probe, realpath, list };
const overlayStore = (root, files, ops) => {
  const revisions = new Map([...files].map(([path, source]) => [resolve(root, path), source]));
  const deleted = new Set(ops.filter(({ verb }) => verb === 'remove').map(({ target }) => resolve(root, target)));
  const additions = new Map();
  for (const path of revisions.keys()) {
    const parent = dirname(path);
    additions.set(parent, [...(additions.get(parent) ?? []), basename(path)]);
  }
  const sourceOf = (path) => revisions.get(resolve(path)) ?? path;
  const removed = (path) => deleted.has(resolve(path)) && probe(path) === 'file';
  return {
    read: (path) => removed(path) ? { outcome: 'absent' } : readRegularFileNoFollow(sourceOf(path)),
    probe: (path) => removed(path) ? 'absent' : probe(sourceOf(path)),
    realpath: (path) => removed(path) ? null : realpath(sourceOf(path)),
    list: (path) => {
      const names = list(path);
      if (names === null) return null;
      return [...new Set([...names, ...(additions.get(resolve(path)) ?? [])])].filter((name) => !removed(resolve(path, name)));
    },
  };
};

const showVerdict = ({ exit: code, lines }) => {
  const output = lines.join('\n');
  return code === 2 ? { code, stdout: '', stderr: output } : { code, stdout: output, stderr: '' };
};

// main(argv, deps) -> { code, stdout, stderr }. Never calls process.exit itself (the direct-run
// guard does), and never reads anything the caller did not point it at.
export const main = (argv, deps = {}) => {
  if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
  const read = deps.readFileSync ?? readContent;
  const cwd = deps.cwd ?? (() => process.cwd());
  const usage = (message) => ({ code: 2, stdout: '', stderr: `spec-check: ${message}` });
  try {
    const opts = parseArgs(argv);
    return checkArgs(opts, cwd(), read, usage);
  } catch (err) {
    return usage(err?.message ?? causeOf(err));
  }
};

const checkArgs = (opts, workingDir, read, usage) => {
  const planLane = opts.plan !== undefined;
  if (planLane && (opts.all || opts.op.length > 0 || opts['ops-file'] !== undefined)) {
    return usage('--plan is exclusive of --all, --op and --ops-file');
  }
  if (planLane && !isPlanSpelling(opts.plan)) return usage(`--plan "${opts.plan}" must use the spelling ${PLANS_REL}/<name>${suffix} relative to --root`);
  if (opts.all && (opts.op.length > 0 || opts['ops-file'])) {
    return usage('--all judges the whole store and is exclusive of --op and --ops-file — run one lane or the other');
  }
  const root = resolve(workingDir, opts.root ?? '.');
  if (probe(root) !== 'dir') return usage(`--root "${opts.root ?? workingDir}" is not a directory`);
  const readPlans = () => readPlansInFlight(root).plans;
  const plans = planLane ? readPlans() : undefined;
  const plan = plans?.find(({ identity }) => identity === opts.plan);
  if (planLane && !plan) return usage(`${opts.plan} is not an in-flight plan`);
  if (plan && !plan.accepted) return usage(plan.result.findings
    .map(({ line, code, message }) => `${plan.identity}:${line}: ${code} — ${message}`).join('\nspec-check: '));
  let specs = [...opts.op];
  if (opts['ops-file']) {
    const register = resolve(workingDir, opts['ops-file']);
    try {
      specs = [...specs, ...opsFileLines(read(register, 'utf8'))];
    } catch (err) {
      return usage(`--ops-file "${opts['ops-file']}" is unreadable — ${causeOf(err)}`);
    }
  }
  let ops = [];
  if (!opts.all) {
    const parsed = plan ? parsePlanSpecOps(plan.rows, isSweep, (sweep) => expandSweepPaths(root, [sweep])[sweep]) : parseSpecOps(specs);
    if (parsed.errors.length > 0) {
      return usage(parsed.errors.map((e) => `${plan ? `${plan.identity}: ` : ''}${e.code} — ${e.message}`).join('\nspec-check: '));
    }
    ops = parsed.ops;
  }
  if (plan) return checkPlan(root, plan.identity, ops, plans);
  return showVerdict(checkSpecs({ root, ops, all: Boolean(opts.all), plans: readPlans }, storeIO));
};

const checkPlan = (root, plan, ops, plans) => {
  const homePath = getRevisionHomePath(plan);
  const files = new Map();
  try {
    proveRevisionHome(root, homePath, ops, files);
  } catch (err) {
    const path = err?.path ? repoPath(root, err.path) : homePath;
    return { code: 1, stdout: `spec-check: REFUSE — revision home\n  ${path}: revision-home — ${causeOf(err)}`, stderr: '' };
  }
  if (ops.length === 0) return { code: 0, stdout: 'spec-check: ACCEPT — the plan names no store document', stderr: '' };
  const home = { plan, paths: [...files.keys()] };
  return showVerdict(checkSpecs({ root, ops, plans, home }, overlayStore(root, files, ops)));
};

if (isDirectRun(import.meta.url)) {
  const result = main(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.code);
}
