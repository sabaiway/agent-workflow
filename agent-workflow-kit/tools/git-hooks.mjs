#!/usr/bin/env node
// git-hooks.mjs — the thin writer of the two git-hook items (`enforcement`, `commit-guard`): it copies
// the bundled scripts create-only and spawns the project's own scripts/install-git-hooks.mjs, which
// decides the hook at the write. The leaf decides nothing about the hook: the danger check binds the
// copies and the installer bytes this dry run answers, never git's hooks dir.
import { lstatSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeProjectFileCreateOnly } from './atomic-write.mjs';
import { NODE_EVIDENCE_SCRIPTS } from './node-evidence.mjs';
import { shellQuoteArg } from './repo-lex.mjs';
import { isDirectRun } from './direct-run.mjs';

const TOOLS = dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_REL = 'scripts';
export const INSTALLER_REL = 'scripts/install-git-hooks.mjs';
const bundleDir = (toolsDir) => join(toolsDir, '..', 'references', 'scripts');
export const BUNDLED_SCRIPT_NAMES = Object.freeze(readdirSync(bundleDir(TOOLS)).filter((name) => name.endsWith('.mjs')).sort());

const EXIT_OK = 0;
const EXIT_INCOMPLETE = 1;
const EXIT_USAGE = 2;
const EXIT_REFUSED = 3;
const USAGE = 'usage: git-hooks (--enforcement | --commit-guard) [--cwd <root>] [--apply]';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const usageError = (message) => Object.assign(new Error(message), { exitCode: EXIT_USAGE });
const refusal = (message) => Object.assign(new Error(message), { exitCode: EXIT_REFUSED });

const nodeAt = (path, lstat) => {
  try {
    return lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};
const isPlainDir = (node) => node !== null && node.isDirectory() && !node.isSymbolicLink();
const isFile = (node) => node !== null && node.isFile() && !node.isSymbolicLink();

// The dry run: what the apply copies and the installer it runs, with the bytes of each.
export const planGitHooks = ({ root, variant, toolsDir = TOOLS, lstat = lstatSync, readFile = readFileSync }) => {
  const scripts = join(root, SCRIPTS_REL);
  const scriptsNode = nodeAt(scripts, lstat);
  if (scriptsNode !== null && !isPlainDir(scriptsNode)) throw refusal(`${scripts} is not a plain directory`);
  const kinds = new Map();
  const names = variant === 'enforcement' ? BUNDLED_SCRIPT_NAMES : [INSTALLER_REL.slice(SCRIPTS_REL.length + 1)];
  for (const name of scriptsNode === null ? [] : names) {
    const path = join(scripts, name);
    const node = nodeAt(path, lstat);
    if (node !== null && !isFile(node)) throw refusal(`${path} is not a regular file`);
    kinds.set(name, node === null ? 'absent' : 'file');
  }
  const installer = join(root, INSTALLER_REL);
  const deployed = NODE_EVIDENCE_SCRIPTS.some((name) => kinds.get(name) === 'file');
  const copies = variant === 'enforcement' && !deployed ? BUNDLED_SCRIPT_NAMES.map((name) => {
    if (kinds.get(name) === 'file') return { name, path: join(scripts, name), action: 'kept' };
    return { name, path: join(scripts, name), action: 'created', bytes: readFile(join(bundleDir(toolsDir), name)) };
  }) : [];
  const placed = copies.find(({ path, action }) => path === installer && action === 'created');
  if (!placed && !isFile(nodeAt(installer, lstat))) throw refusal(`${installer} is absent — nothing here places the hook installer`);
  const guard = variant === 'commit-guard' ? ['--commit-guard', join(toolsDir, 'commit-guard.mjs')] : [];
  return {
    root,
    variant,
    scriptsCreated: scriptsNode === null,
    copies,
    runs: { argv: ['node', installer, ...guard], shown: ['node', INSTALLER_REL, ...guard], bytes: placed ? placed.bytes : readFile(installer) },
  };
};

export const formatPlan = (plan) => [
  ...plan.copies.map(({ name, action, bytes }) => `copy: ${SCRIPTS_REL}/${name} ${action}${action === 'created' ? ` sha256:${sha(bytes)}` : ''}`),
  `runs: ${plan.runs.shown.map(shellQuoteArg).join(' ')} sha256:${sha(plan.runs.bytes)}`,
];

// Removes exactly the files this run created, then scripts/ when this run created it and it is empty;
// every path it cannot remove is answered for the caller to name.
const rollBack = (plan, created, io) => {
  const scripts = join(plan.root, SCRIPTS_REL);
  const left = [];
  const dirNow = () => nodeAt(scripts, io.lstat);
  for (const path of created) {
    const dir = dirNow();
    const node = nodeAt(path, io.lstat);
    if (!isPlainDir(dir) || dir.ino !== created.dirIno || !isFile(node)) {
      left.push(path);
      continue;
    }
    try {
      io.unlink(path);
    } catch {
      left.push(path);
    }
  }
  if (plan.scriptsCreated && created.dirIno !== undefined) {
    const dir = dirNow();
    let empty = false;
    try {
      empty = isPlainDir(dir) && dir.ino === created.dirIno && io.readdir(scripts).length === 0;
    } catch {
      empty = false;
    }
    if (empty) {
      try {
        io.rmdir(scripts);
      } catch {
        left.push(scripts);
      }
    } else if (!isPlainDir(dir) || dir.ino !== created.dirIno) left.push(scripts);
  }
  return left;
};

export const applyGitHooks = (plan, io = {}) => {
  const resolved = { lstat: lstatSync, unlink: unlinkSync, rmdir: rmdirSync, readdir: readdirSync, env: process.env,
    log: console.log, error: console.error, writeFile: writeProjectFileCreateOnly,
    spawn: (argv, options) => spawnSync(argv[0], argv.slice(1), options), ...io };
  const created = [];
  const leftovers = [];
  const fail = (lines) => {
    for (const line of lines) resolved.error(line);
    for (const path of [...rollBack(plan, created, resolved), ...leftovers]) resolved.error(`not removed: ${path}`);
    return EXIT_INCOMPLETE;
  };
  const scripts = join(plan.root, SCRIPTS_REL);
  const noteDir = () => {
    const dir = nodeAt(scripts, resolved.lstat);
    if (created.dirIno === undefined && isPlainDir(dir)) created.dirIno = dir.ino;
  };
  for (const copy of plan.copies.filter(({ action }) => action === 'created')) {
    let result;
    try {
      result = resolved.writeFile(plan.root, `${SCRIPTS_REL}/${copy.name}`, copy.bytes);
    } catch (error) {
      noteDir();
      return fail([error?.message ?? String(error)]);
    }
    noteDir();
    if (result.tmpLeftBehind) leftovers.push(result.tmpLeftBehind);
    if (!result.created) return fail([`${copy.path} appeared after the check — the file found there stands`]);
    created.push(copy.path);
  }
  const child = resolved.spawn(plan.runs.argv, { cwd: plan.root, env: resolved.env, stdio: 'inherit' });
  if (child.status !== 0) return fail([`installer exited ${child.status ?? child.signal ?? child.error?.code}`]);
  for (const path of leftovers) resolved.error(`not removed: ${path}`);
  return EXIT_OK;
};

export const parseArgs = (argv) => {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const args = { apply: false, cwd: undefined, variants: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--apply') args.apply = true;
    else if (flag === '--enforcement' || flag === '--commit-guard') args.variants.push(flag.slice(2));
    else if (flag === '--cwd') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) throw usageError('--cwd takes a value');
      args.cwd = value;
      index += 1;
    } else throw usageError(`unknown argument: ${flag}`);
  }
  if (args.variants.length !== 1) throw usageError('pass exactly one of --enforcement and --commit-guard');
  return { help: false, apply: args.apply, cwd: args.cwd, variant: args.variants[0] };
};

export const main = (argv, io = {}) => {
  const resolved = { log: console.log, error: console.error, cwd: process.cwd(), toolsDir: TOOLS, ...io };
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) {
      resolved.log(USAGE);
      return EXIT_OK;
    }
    args.root = resolve(resolved.cwd, args.cwd ?? '.');
    if (!statSync(args.root, { throwIfNoEntry: false })?.isDirectory()) throw usageError(`--cwd is not a directory: ${args.root}`);
  } catch (error) {
    resolved.error(error.message);
    resolved.error(USAGE);
    return EXIT_USAGE;
  }
  let plan;
  try {
    plan = planGitHooks({ root: args.root, variant: args.variant, toolsDir: resolved.toolsDir });
  } catch (error) {
    resolved.error(error.message);
    return EXIT_REFUSED;
  }
  if (!args.apply) {
    for (const line of formatPlan(plan)) resolved.log(line);
    return EXIT_OK;
  }
  return applyGitHooks(plan, resolved);
};

if (isDirectRun(import.meta.url)) process.exitCode = main(process.argv.slice(2));
