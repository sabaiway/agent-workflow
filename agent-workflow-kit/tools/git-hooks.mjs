#!/usr/bin/env node
// git-hooks.mjs — the thin writer of the three git-hook items (`enforcement`, `commit-guard`,
// `hook-checks`): it copies the bundled scripts create-only, refreshes a known-prior installer, and
// spawns the project's own scripts/install-git-hooks.mjs, which decides the hook at the write. The leaf
// decides nothing about the hook: the danger check binds the copies and the installer bytes this dry run
// answers, never git's hooks dir. It is also the home of the one pre-commit reader, which the
// commit-guard and hook-checks applies run after the installer to verify the arm.
import { lstatSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeContainedFileAtomic, writeProjectFileCreateOnly } from './atomic-write.mjs';
import { BUNDLED_SCRIPT_NAMES, INSTALLER_REL, NODE_EVIDENCE_SCRIPTS, SCRIPTS_DIR } from './node-evidence.mjs';
import { shellQuoteArg } from './repo-lex.mjs';
import { GIT_MAX_BUFFER } from './git-env.mjs';
import { isDirectRun } from './direct-run.mjs';
import { classifyDeployedScript } from './script-priors.mjs';
import { checkRules } from './project-rules/index.mjs';
import { readLayoutSetup } from './source-size-core.mjs';

const TOOLS = dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_REL = SCRIPTS_DIR;
export { BUNDLED_SCRIPT_NAMES, INSTALLER_REL };
const bundleDir = (toolsDir) => join(toolsDir, '..', 'references', 'scripts');
const INSTALLER_NAME = 'install-git-hooks.mjs';

const EXIT_OK = 0;
const EXIT_INCOMPLETE = 1;
const EXIT_USAGE = 2;
const EXIT_REFUSED = 3;
const VARIANTS = ['enforcement', 'commit-guard', 'hook-checks'];
const USAGE = 'usage: git-hooks (--enforcement | --commit-guard | --hook-checks) [--cwd <root>] [--apply]';
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

// The absolute hooks dir git itself reports (a linked worktree's own, core.hooksPath), or null outside a git tree.
export const resolveGitHooksPath = (projectDir, env = process.env) => {
  const result = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: projectDir, env, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
  if (result.error || result.status !== 0) return null;
  return resolve(projectDir, result.stdout.toString('utf8').replace(/\r?\n$/, ''));
};

export const INSTALLER_MARKER_RE = /:install-git-hooks\.mjs$/m;
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Armed means the exact line the installer writes on the kit's own guard path; a commented or lookalike line is not.
export const canonicalGuardLineRe = (toolsDir = TOOLS) => new RegExp(`^node "${escapeRe(join(toolsDir, 'commit-guard.mjs'))}" --check$`, 'm');

// The one safe shell representation of an armed path, the installer's rule: on win32 its separators
// made `/`; null when a byte would not name the file inside the hook's double quotes.
export const safeHookPath = (path, platform = process.platform) => {
  const shown = platform === 'win32' ? path.replaceAll('\\', '/') : path;
  return /["$`\\\r\n]/.test(shown) ? null : shown;
};

// The two role-tagged lines, in hook order: the flag that arms each and the kit tool it runs.
const ROLES = Object.freeze([
  { key: 'rules', role: 'rules-check', flag: '--rules-check', tool: (toolsDir) => join(toolsDir, 'project-rules', 'rules-cli.mjs') },
  { key: 'layout', role: 'layout-check', flag: '--layout-check', tool: (toolsDir) => join(toolsDir, 'source-size-check.mjs') },
]);
const roleLineRe = ({ role, tool }, toolsDir, platform) => {
  const path = safeHookPath(tool(toolsDir), platform);
  return path === null ? /(?!)/ : new RegExp(`^node "${escapeRe(path)}" --check # ${role}$`, 'm');
};
export const canonicalRulesLineRe = (toolsDir = TOOLS, platform = process.platform) => roleLineRe(ROLES[0], toolsDir, platform);
export const canonicalLayoutLineRe = (toolsDir = TOOLS, platform = process.platform) => roleLineRe(ROLES[1], toolsDir, platform);
const CANONICAL = { rules: canonicalRulesLineRe, layout: canonicalLayoutLineRe };

// Each role's arm, and whether an uncommented line ending in its role comment runs another path.
const roleStates = (hook, toolsDir, platform) => Object.fromEntries(ROLES.flatMap(({ key, role }) => {
  const canonical = CANONICAL[key](toolsDir, platform);
  const lines = hook === null ? [] : hook.split('\n').filter((line) => !line.trimStart().startsWith('#') && line.endsWith(`# ${role}`));
  return [[`${key}Armed`, hook !== null && canonical.test(hook)], [`${key}Foreign`, lines.some((line) => !canonical.test(line))]];
}));

// The one reader of git's pre-commit: whose hook it is, and which canonical lines arm it.
export const readPreCommitState = (root, deps = {}) => {
  const unarmed = (fields) => ({ ...fields, armed: false, ...roleStates(null) });
  const hooksPath = (deps.gitHooksPath ?? resolveGitHooksPath)(root, deps.env);
  if (hooksPath === null) return unarmed({ state: 'no-hooks-dir' });
  const path = join(hooksPath, 'pre-commit');
  let hook;
  try {
    (deps.lstat ?? lstatSync)(path);
    hook = String((deps.readFile ?? readFileSync)(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return unarmed({ state: 'absent' });
    return unarmed({ state: 'unreadable', code: error?.code ?? String(error?.message ?? error), path });
  }
  return { state: INSTALLER_MARKER_RE.test(hook) ? 'managed' : 'unmanaged', armed: canonicalGuardLineRe(deps.toolsDir).test(hook),
    ...roleStates(hook, deps.toolsDir ?? TOOLS, deps.platform) };
};

// The two read-only answers the hook-checks dry run and the advisor's probe ask, on the tree on disk.
export const hookCheckAnswers = (root, deps = {}) => {
  const verdicts = (deps.checkRules ?? checkRules)(root, deps);
  const setup = (deps.readLayoutSetup ?? readLayoutSetup)(root, deps);
  return {
    rules: { armable: verdicts.every(({ verdict }) => verdict === 'current'),
      why: verdicts.filter(({ verdict }) => verdict !== 'current').map(({ theme, verdict }) => `${theme}: ${verdict}`).join(', ') },
    layout: { armable: setup.answer === 'armable', why: `the layout setup answers ${setup.answer}${setup.reason ? ` (${setup.reason})` : ''}`, setup },
  };
};

// The roles a hook-checks apply passes: each armable and unarmed, or standing on another path.
export const plannedRoles = (answers, hook) => ROLES.filter(({ key }) =>
  (answers[key].armable && !hook[`${key}Armed`]) || hook[`${key}Foreign`]);

// The kit's tools path in the one safe representation, or the refusal naming it.
export const unsafeToolsPath = (toolsDir, platform) => (ROLES.some(({ tool }) => safeHookPath(tool(toolsDir), platform) === null)
  ? `the kit's tools path ${toolsDir} carries ", $, a backtick, a backslash, CR or LF — a hook line would not run the file it names` : null);

// hook-checks: the lines it arms, from the two answers and the hook, and a refresh of a known-prior installer.
const planHookChecks = ({ root, toolsDir, installer, scriptsNode, kinds, readFile, deps }) => {
  if (!isPlainDir(scriptsNode) || kinds.get(INSTALLER_NAME) !== 'file') throw refusal(`${installer} is absent — nothing here places the hook installer`);
  const unsafe = unsafeToolsPath(toolsDir, deps.platform);
  if (unsafe !== null) throw refusal(unsafe);
  const hook = readPreCommitState(root, { toolsDir, platform: deps.platform, gitHooksPath: deps.gitHooksPath });
  if (hook.state === 'unreadable') throw refusal(`${hook.path} is unreadable (${hook.code}) — the pre-commit hook cannot be judged`);
  if (hook.state === 'no-hooks-dir') throw refusal('nothing to plan — git reports no hooks dir here (not a git checkout), so there is no hook to arm');
  const answers = hookCheckAnswers(root, deps);
  const roles = plannedRoles(answers, hook);
  if (roles.length === 0) {
    throw refusal(`nothing to plan — ${ROLES.map(({ key, role }) => `the ${role} line: ${hook[`${key}Armed`] ? 'armed' : `not armable (${answers[key].why})`}`).join('; ')}`);
  }
  const deployed = readFile(installer);
  const bundled = readFile(join(bundleDir(toolsDir), INSTALLER_NAME));
  const refresh = classifyDeployedScript(deployed, INSTALLER_NAME, bundled) === 'prior' ? { path: installer, bytes: bundled, replaces: deployed } : null;
  const flags = roles.flatMap(({ flag, tool }) => [flag, tool(toolsDir)]);
  return { root, variant: 'hook-checks', scriptsCreated: false, copies: [], refresh, roles: roles.map(({ key }) => key),
    runs: { argv: ['node', installer, ...flags], shown: ['node', INSTALLER_REL, ...flags], bytes: refresh ? bundled : deployed } };
};

// The dry run: what the apply copies and the installer it runs, with the bytes of each.
export const planGitHooks = ({ root, variant, toolsDir = TOOLS, lstat = lstatSync, readFile = readFileSync, ...deps }) => {
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
  if (variant === 'hook-checks') return planHookChecks({ root, toolsDir, installer, scriptsNode, kinds, readFile, deps });
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
  ...(plan.refresh ? [`refresh: ${INSTALLER_REL} sha256:${sha(plan.refresh.bytes)} — replaces sha256:${sha(plan.refresh.replaces)}`] : []),
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

// The hook's bytes, null when absent; undefined when it cannot be read, which never compares equal.
const hookBytes = (path, readFile) => {
  try {
    return readFile(path);
  } catch (error) {
    return error?.code === 'ENOENT' ? null : undefined;
  }
};
const sameHook = (left, right) => left !== undefined && right !== undefined && (left === null ? right === null : right !== null && left.equals(right));

// hook-checks at the write: the refresh, the spawn, the re-read of every passed line; on a failed outcome
// the prior installer comes back exactly when the hook still holds the bytes it held before the spawn.
const applyHookChecks = (plan, resolved) => {
  const hooksDir = resolveGitHooksPath(plan.root, resolved.env);
  const preCommit = hooksDir === null ? null : join(hooksDir, 'pre-commit');
  const before = preCommit === null ? null : hookBytes(preCommit, resolved.readFile);
  const replace = (bytes) => resolved.replaceFile(plan.root, plan.runs.argv[1], bytes, {}, { label: INSTALLER_REL });
  if (plan.refresh) {
    try {
      replace(plan.refresh.bytes);
    } catch (error) {
      resolved.error(error?.message ?? String(error));
      return EXIT_INCOMPLETE;
    }
  }
  const child = resolved.spawn(plan.runs.argv, { cwd: plan.root, env: resolved.env, stdio: 'inherit' });
  const hook = readPreCommitState(plan.root, { env: resolved.env, toolsDir: resolved.toolsDir, platform: resolved.platform, gitHooksPath: () => hooksDir });
  const failure = child.status !== 0 ? `installer exited ${child.status ?? child.signal ?? child.error?.code}`
    : hook.state === 'no-hooks-dir' ? null
      : hook.state === 'unreadable' ? `${preCommit} is unreadable (${hook.code}) after the installer exited 0`
        : ROLES.filter(({ key }) => plan.roles.includes(key)).map(({ key, role, flag }) => (!hook[`${key}Armed`]
          ? `${preCommit} carries no ${role} line after the installer exited 0 — an installer older than the arm ignores ${flag}; refreshing ${INSTALLER_REL} from the kit's references/scripts/ copy is your own step`
          : hook[`${key}Foreign`] ? `${preCommit} still carries a ${role} line on a path other than this kit's after the installer exited 0` : null)).find(Boolean) ?? null;
  if (failure === null) return EXIT_OK;
  resolved.error(failure);
  if (!plan.refresh) return EXIT_INCOMPLETE;
  if (!sameHook(before, preCommit === null ? null : hookBytes(preCommit, resolved.readFile))) {
    resolved.error(`${INSTALLER_REL} keeps the refreshed bytes: ${preCommit} no longer holds what it held before the installer ran, or cannot be read, and the prior body would drop the new lines at its next run`);
    return EXIT_INCOMPLETE;
  }
  try {
    replace(plan.refresh.replaces);
  } catch (error) {
    resolved.error(`not restored: ${INSTALLER_REL} (${error?.message ?? error})`);
  }
  return EXIT_INCOMPLETE;
};

export const applyGitHooks = (plan, io = {}) => {
  const resolved = { lstat: lstatSync, unlink: unlinkSync, rmdir: rmdirSync, readdir: readdirSync, env: process.env,
    log: console.log, error: console.error, writeFile: writeProjectFileCreateOnly, toolsDir: TOOLS, readFile: readFileSync,
    replaceFile: writeContainedFileAtomic, platform: process.platform,
    spawn: (argv, options) => spawnSync(argv[0], argv.slice(1), options), ...io };
  if (plan.variant === 'hook-checks') return applyHookChecks(plan, resolved);
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
  if (plan.variant !== 'commit-guard') return EXIT_OK;
  // An installer older than the arm ignores --commit-guard and still exits 0, so the arm is read back under its env.
  const hooksDir = resolveGitHooksPath(plan.root, resolved.env);
  const hook = readPreCommitState(plan.root, { env: resolved.env, toolsDir: resolved.toolsDir, gitHooksPath: () => hooksDir });
  if (hook.state === 'no-hooks-dir' || hook.armed) return EXIT_OK;
  const path = join(hooksDir, 'pre-commit');
  resolved.error(hook.state === 'unreadable' ? `${path} is unreadable (${hook.code}) after the installer exited 0`
    : `${path} carries no commit-guard line after the installer exited 0 — an installer older than the arm ignores --commit-guard; refreshing ${INSTALLER_REL} from the kit's references/scripts/ copy is your own step`);
  return EXIT_INCOMPLETE;
};

export const parseArgs = (argv) => {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const args = { apply: false, cwd: undefined, variants: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--apply') args.apply = true;
    else if (flag.startsWith('--') && VARIANTS.includes(flag.slice(2))) args.variants.push(flag.slice(2));
    else if (flag === '--cwd') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) throw usageError('--cwd takes a value');
      args.cwd = value;
      index += 1;
    } else throw usageError(`unknown argument: ${flag}`);
  }
  if (args.variants.length !== 1) throw usageError('pass exactly one of --enforcement, --commit-guard and --hook-checks');
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
