import { closeSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { checkApply } from './apply-danger-check.mjs';
import { resolveGitHooksPath } from './commit-guard.mjs';
import { dirCovers } from './declared-paths.mjs';
import { isDirectRun } from './direct-run.mjs';
import { GIT_MAX_BUFFER, stripGitLocationEnv } from './git-env.mjs';
import { preflightInit } from './init-preflight.mjs';
import { buildRecommendations, hostFacts } from './recommendations.mjs';
import { compareSemver } from './semver-lite.mjs';
import { EXPECTED_WORKFLOW_VERSION } from './velocity-profile.mjs';
import { LANE_HARNESS, VARIANT_LANES, consoleArgv, isEnvDependent, isProtectedPath, laneOf, writesOf } from './write-lanes.mjs';

const INSIDE_LINE = 'you are inside an agent; run this in your own terminal';
const APPLY_PROMPT = 'apply? y/N: ';
const RUN_NONE = 'y applies every preview above (a sudo install asks once more on its own line); run none of their commands yourself';
const RESTART_LINE = 'restart the agent from this folder: init changed its configuration';
const SETTINGS = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json', '.git/config'];
const FILE_DIRS = ['.claude/agents', '.claude/hooks'];
// The record key whose state is the sorted *.json names of its directory, so a created file is a change.
const JSON_NAMES = '*.json';
const DANGLING = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);
const INSTALL_VARIANT = 'sandbox-provision.installable';
const DEFAULT_IO = { lstat: lstatSync, stat: statSync, readlink: readlinkSync, readFile: readFileSync, readdir: readdirSync,
  openSync, closeSync, geteuid: process.geteuid };
const isYes = (answer) => answer === 'y' || answer === 'Y';

const readStat = (path, io) => {
  try {
    return io.lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
};

export const findProject = ({ cwd, lstat = lstatSync }) => {
  const candidates = [];
  const visit = (root) => {
    const io = { lstat };
    if (readStat(join(root, 'docs/ai'), io)?.isDirectory()) {
      const shape = readStat(join(root, 'docs/ai/.workflow-version'), io) ? 'stamped' : 'pre-versioned';
      candidates.push({ root, shape });
    }
    const parent = dirname(root);
    if (!readStat(join(root, '.git'), io) && parent !== root) visit(parent);
  };
  visit(resolve(cwd));
  return { candidates };
};

const readEntries = (dir, io) => readStat(dir, io)?.isDirectory() ? io.readdir(dir).sort() : [];
const collectPaths = ({ root, home, hooksDir }, io) => {
  const paths = [join(home, '.claude/settings.json')];
  if (root === null) return paths;
  const docs = join(root, 'docs/ai');
  paths.push(...SETTINGS.map((path) => join(root, path)), join(docs, '.workflow-version'), join(docs, JSON_NAMES));
  for (const dir of [...FILE_DIRS.map((path) => join(root, path)), hooksDir]) {
    paths.push(dir, ...readEntries(dir, io).map((name) => join(dir, name)));
  }
  paths.push(...readEntries(docs, io).filter((name) => name.endsWith('.json')).map((name) => join(docs, name)));
  return paths;
};

const fileState = (path, io) => `file:${Buffer.from(io.readFile(path)).toString('hex')}`;
const otherState = (stat) => `other:${stat.mode}:${stat.rdev}`;
const entryState = (path, io) => {
  const stat = io.lstat(path);
  if (stat.isDirectory()) return 'directory';
  if (stat.isSymbolicLink()) return `link:${io.readlink(path)}`;
  return stat.isFile() ? fileState(path, io) : otherState(stat);
};
// A directory reads as its sorted entries with each entry's own state, one level deep, so a changed file in it is a change.
const statState = (path, stat, io) => {
  if (stat.isDirectory()) return `directory:${JSON.stringify(io.readdir(path).sort().map((name) => [name, entryState(join(path, name), io)]))}`;
  return stat.isFile() ? fileState(path, io) : otherState(stat);
};
const followedState = (path, io) => {
  try {
    return statState(path, io.stat(path), io);
  } catch (error) {
    if (DANGLING.has(error.code)) return 'absent';
    throw error;
  }
};
const readState = (path, io) => {
  if (basename(path) === JSON_NAMES) {
    const names = readStat(dirname(path), io)?.isDirectory() ? io.readdir(dirname(path)).filter((name) => name.endsWith('.json')) : null;
    return names === null ? 'absent' : `names:${JSON.stringify(names.sort())}`;
  }
  const stat = readStat(path, io);
  if (stat === null) return 'absent';
  if (stat.isSymbolicLink()) return `link:${io.readlink(path)}:${followedState(path, io)}`;
  return statState(path, stat, io);
};
const readStateOrElse = (path, io, onError) => {
  try {
    return readState(path, io);
  } catch (error) {
    return onError(error);
  }
};
const stateOf = (path, io) => readStateOrElse(path, io, (error) => {
  throw new Error(`${path} could not be read: ${error.code ?? error.message}`);
});
const recordPaths = (paths, io) => new Map([...new Set(paths)].map((path) => [path, stateOf(path, io)]));
const findChanged = (record, io) => [...record].find(([path, state]) =>
  readStateOrElse(path, io, () => null) !== state)?.[0];
// After an apply a path that cannot be read is recorded as such, so the next comparison stops the batch on it.
const refreshState = (path, io) => readStateOrElse(path, io, (error) => `unreadable:${error.code ?? error.message}`);
const DIRECTORY = 'directory:';
const entriesOf = (state) => (state === 'absent' ? [] : JSON.parse(state.slice(DIRECTORY.length)));
// A recorded parent moves only by the written entry, so an entry created or removed beside it still stops the batch.
const refreshParent = (record, path, io) => {
  const [parent, name, current] = [dirname(path), basename(path), refreshState(dirname(path), io)];
  const recorded = record.get(parent);
  if (!(recorded === 'absent' || recorded.startsWith(DIRECTORY)) || !current.startsWith(DIRECTORY)) return;
  const merged = [...entriesOf(recorded).filter(([entry]) => entry !== name), ...entriesOf(current).filter(([entry]) => entry === name)];
  record.set(parent, DIRECTORY + JSON.stringify(merged.sort(([a], [b]) => (a < b ? -1 : 1))));
};
const refreshWrites = (record, paths, io) => {
  for (const path of paths) {
    record.set(path, refreshState(path, io));
    if (record.has(dirname(path))) refreshParent(record, path, io);
    if (readStat(path, io)?.isDirectory()) {
      for (const watched of record.keys()) {
        if (watched.startsWith(path + sep)) record.set(watched, refreshState(watched, io));
      }
      for (const child of readEntries(path, io).map((name) => join(path, name))) record.set(child, refreshState(child, io));
    }
  }
};

const findMasks = (paths, facts, io, print) => {
  const masks = new Set();
  const root = facts.root ?? facts.cwd;
  for (const path of new Set(paths)) {
    if (!isProtectedPath(path, { root, home: facts.home, hooksDir: join(root, '.git/hooks') })) continue;
    const stat = readStat(path, io);
    if (!stat?.isFile() || stat.size !== 0 || (stat.mode & 0o222) !== 0) continue;
    masks.add(path);
    print(`${path}: an empty read-only file — a running agent command's mask (run init again once it ends) or litter a sandbox left (remove it, then run init again)`);
  }
  return masks;
};

const launch = async (context, argv, stdio) => {
  try {
    const result = await context.spawn(argv, { cwd: context.facts.root ?? context.cwd, env: context.spawnEnv, stdio });
    if (!result || typeof result !== 'object') return { status: null, stdout: '', stderr: 'empty answer', valid: false };
    return {
      status: result.status ?? null,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? result.error?.message ?? result.signal ?? ''),
      valid: typeof result.status === 'number' && !result.error && !result.signal,
    };
  } catch (error) {
    return { status: null, stdout: '', stderr: String(error.code ?? error.message ?? error), valid: false };
  }
};

// Outside a project only the host-scoped variants reach the queue: an apply-only one or one judged over a claude dir.
const reachesQueue = (variant, facts) => {
  if (facts.root !== null) return true;
  const argv = consoleArgv(variant, facts);
  return Boolean(argv) && (argv.preview === null || argv.preview.includes('--claude-dir'));
};
const isMasked = (variant, context) => (writesOf(variant, context.facts) ?? [])
  .some((write) => [...context.masks].some((mask) => dirCovers(write, mask)));

const getQueue = async (context) => {
  context.items = (await context.recommend(context.facts.root, { keySet: context.keySet })).items;
  return context.items.filter(({ variant }) => reachesQueue(variant, context.facts) && !isMasked(variant, context));
};

const printNotPending = (context) => {
  const variants = Object.keys(VARIANT_LANES).filter(isEnvDependent);
  const keys = new Set();
  for (const variant of variants) {
    const key = variant.split('.')[0];
    if (keys.has(key)) continue;
    keys.add(key);
    if (!reachesQueue(variant, context.facts) || context.items.some((item) => item.key === key)) continue;
    const preview = consoleArgv(variant, context.facts)?.preview;
    const index = preview?.indexOf('--claude-dir') ?? -1;
    const judged = index < 0 ? '' : ` (judged ${preview[index + 1]})`;
    context.print(`not pending in this console: ${key}${judged}`);
  }
};

const printNote = (context, key) => {
  const lines = String(context.io.readFile(join(context.facts.toolsDir, '../references/modes/recommendations.md'), 'utf8')).split('\n');
  const start = lines.findIndex((line) => line.startsWith(`- \`${key}\` — `));
  if (start < 0) return;
  const end = lines.findIndex((line, index) => index > start && !line.startsWith(' ') && !line.startsWith('\t'));
  for (const line of lines.slice(start, end < 0 ? lines.length : end)) context.print(line);
};

const previewQueue = async (context, queue) => {
  const batch = [];
  for (const item of queue) {
    const argv = consoleArgv(item.variant, context.facts);
    if (!argv?.preview) continue;
    context.print(`preview: ${item.variant}`);
    const result = await launch(context, argv.preview, 'pipe');
    const success = result.valid && (result.status === 0 || (result.status === 3 && result.stdout.includes('status=missing-binaries')));
    if (!success) {
      context.print(`preview refused (exit ${result.status}): ${item.variant}`);
      if (result.stdout) context.print(result.stdout);
      if (result.stderr) context.print(result.stderr);
      continue;
    }
    context.print(result.stdout);
    const tuple = result.stdout.match(/--apply\s+(\S+)/)?.[1];
    const facts = { ...context.facts, tuple };
    if (laneOf(item.variant) === LANE_HARNESS) {
      try {
        const { lines, refused } = context.checkApply(item.variant, facts, {});
        for (const line of lines) context.print(line);
        if (refused.length > 0) throw new Error(refused.map(({ key }) => key).join(', '));
      } catch (error) {
        context.print(`not applied: ${item.variant} — the danger check refused: ${error.message}`);
        continue;
      }
    }
    batch.push({ ...item, applyArgv: consoleArgv(item.variant, facts).apply, writes: writesOf(item.variant, facts) });
    printNote(context, item.key);
  }
  for (const item of queue.filter(({ variant }) => consoleArgv(variant, context.facts) === null)) {
    context.print(`listed, not applied here: ${item.variant} — ${item.what}`);
  }
  return batch;
};

const isConfiguration = (path, root) => root !== null && (
  SETTINGS.slice(0, 3).some((rel) => path === join(root, rel))
  || ['.claude/agents', '.claude/hooks'].some((rel) => path === join(root, rel) || path.startsWith(join(root, rel) + sep))
);

// The record is the state the first preview reads: taken before any preview, compared before each apply.
const takeRecord = (context, queue) => {
  const previewable = queue.filter(({ variant }) => consoleArgv(variant, context.facts)?.preview);
  if (previewable.length === 0) return new Map();
  const paths = [...collectPaths(context.facts, context.io), ...previewable.flatMap(({ variant }) => writesOf(variant, context.facts))];
  try {
    return recordPaths(paths, context.io);
  } catch (error) {
    for (const item of previewable) context.print(`not applied: ${item.variant} — ${error.message}`);
    return null;
  }
};

const runPass = async (context, queue) => {
  const record = takeRecord(context, queue);
  if (record === null) return { code: 1, successes: 0, variants: [] };
  const batch = await previewQueue(context, queue);
  if (batch.length === 0) return { code: 0, successes: 0, variants: [] };
  const before = new Map(record);
  const outcome = { code: 0, successes: 0, variants: batch.map((item) => item.variant) };
  context.print(RUN_NONE);
  if (!isYes(await context.terminal.ask(APPLY_PROMPT))) return outcome;
  for (const [index, item] of batch.entries()) {
    if (item.variant === INSTALL_VARIANT && !isYes(await context.terminal.ask('the sandbox install may ask for your sudo password: y runs it, Enter skips: '))) continue;
    const changed = findChanged(record, context.io);
    if (changed) {
      for (const later of batch.slice(index)) context.print(`not applied: ${later.variant} — ${changed} changed outside this batch`);
      outcome.code = 1;
      break;
    }
    const result = await launch(context, item.applyArgv, ['inherit', 'pipe', 'inherit']);
    if (result.stdout) context.print(result.stdout);
    const success = result.valid && (result.status === 0 || (result.status === 5 && result.stdout.includes('install completed')));
    if (!success) {
      context.print(`apply failed (exit ${result.status}): ${item.variant}`);
      if (result.stderr) context.print(result.stderr);
      for (const later of batch.slice(index + 1)) context.print(`not applied: ${later.variant} — an earlier apply failed`);
      outcome.code = 1;
      break;
    }
    outcome.successes += 1;
    refreshWrites(record, item.writes, context.io);
  }
  if (outcome.successes > 0) {
    const afterPaths = [...collectPaths(context.facts, context.io), ...record.keys()];
    context.restart ||= afterPaths.some((path) => isConfiguration(path, context.facts.root)
      && refreshState(path, context.io) !== (before.get(path) ?? 'absent'));
  }
  return outcome;
};

const selectRoot = async (context) => {
  const { candidates } = findProject({ cwd: context.cwd, lstat: context.io.lstat });
  if (candidates.length === 0) {
    context.print('no agent-workflow project here — run /agent-workflow-kit upgrade in your agent from that project, or deploy it there first: its yes applies the project items');
    return { root: null };
  }
  if (candidates.length === 1) return candidates[0];
  candidates.forEach(({ root }, index) => context.print(`  ${index + 1}. ${root}`));
  const answer = await context.terminal.ask(`which project? 1-${candidates.length}, Enter skips: `);
  return candidates.find((_, index) => String(index + 1) === answer) ?? null;
};

const gateStamp = (candidate, context) => {
  if (candidate.root === null) return null;
  const stamp = (() => {
    try {
      return String(context.io.readFile(join(candidate.root, 'docs/ai/.workflow-version'), 'utf8')).trim();
    } catch {
      return null;
    }
  })();
  if (candidate.shape === 'stamped' && stamp === EXPECTED_WORKFLOW_VERSION) return candidate.root;
  if (compareSemver(stamp, EXPECTED_WORKFLOW_VERSION) === 1) {
    context.print(`this project's stamp ${stamp} is ahead of this kit's lineage ${EXPECTED_WORKFLOW_VERSION} — update the kit, then init again`);
  } else {
    context.print('run /agent-workflow-kit upgrade in your agent: its yes applies the items');
  }
  return null;
};

export const runInitProject = async (deps) => {
  const { terminal } = deps;
  if (terminal.isTTY !== true) {
    terminal.print("project step skipped: no terminal — run init in a console from the project's folder");
    return { code: 0 };
  }
  const io = { ...DEFAULT_IO, ...deps.io };
  const print = (line) => terminal.print(line);
  if (!preflightInit({ ...deps, root: null, io }).ok) {
    print(INSIDE_LINE);
    return { code: 0 };
  }
  const spawnEnv = stripGitLocationEnv(deps.env);
  const context = { ...deps, checkApply: deps.checkApply ?? checkApply, io, print, spawnEnv, masks: new Set(), keySet: false, restart: false };
  const candidate = await selectRoot(context);
  if (candidate === null) return { code: 0 };
  if (!preflightInit({ ...deps, root: candidate.root, io }).ok) {
    print(INSIDE_LINE);
    return { code: 0 };
  }
  const root = gateStamp(candidate, context);
  // The hooks dir git itself reports (a linked worktree's or core.hooksPath), as the advisor reads it.
  const hooksDir = root === null ? null : (deps.gitHooksPath ?? resolveGitHooksPath)(root) ?? join(root, '.git/hooks');
  context.facts = { toolsDir: deps.toolsDir, root, env: deps.env, home: deps.home, platform: deps.platform, tuple: undefined, hooksDir };
  context.recommend ??= (root, facts) => buildRecommendations({ cwd: root ?? deps.cwd,
    deps: { ...io, env: deps.env, getenv: deps.env, home: deps.home, platform: deps.platform,
      jevHost: { ...hostFacts(), home: deps.home, platform: deps.platform }, ...facts } });
  const queue = await getQueue(context);
  const maskPaths = [...collectPaths(context.facts, io), ...queue.flatMap(({ variant }) => writesOf(variant, context.facts) ?? [])];
  context.masks = findMasks(maskPaths, { ...context.facts, cwd: deps.cwd }, io, print);
  const state = { queue: queue.filter(({ variant }) => !isMasked(variant, context)) };
  for (const item of state.queue.filter(({ variant }) => consoleArgv(variant, context.facts)?.preview === null)) {
    print(item.what);
    print(`it writes: ${writesOf(item.variant, context.facts).join(', ')}`);
    printNote(context, item.key);
    if (!isYes(await terminal.ask('y runs its command on this terminal, Enter skips: '))) continue;
    const result = await launch(context, consoleArgv(item.variant, context.facts).apply, 'inherit');
    if (result.valid && result.status === 0) {
      context.keySet = true;
      state.queue = await getQueue(context);
    }
  }
  state.queue = state.queue.filter(({ variant }) => consoleArgv(variant, context.facts)?.preview !== null);
  printNotPending(context);
  const first = await runPass(context, state.queue);
  const outcome = { code: first.code };
  if (first.code === 0 && first.successes > 0) {
    const next = (await getQueue(context)).filter(({ variant }) => !first.variants.includes(variant) && consoleArgv(variant, context.facts)?.preview);
    outcome.code = (await runPass(context, next)).code;
  }
  if (context.restart) print(RESTART_LINE);
  return outcome;
};

export const main = async (argv = process.argv.slice(2), deps = {}) => {
  if (argv.length > 0) {
    (deps.errlog ?? console.error)('Usage: node init-project.mjs');
    return 2;
  }
  const readline = deps.terminal ? null : createInterface({ input: process.stdin, output: process.stdout });
  const terminal = deps.terminal ?? { isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    ask: (prompt) => readline.question(prompt), print: (line) => console.log(line) };
  try {
    const result = await runInitProject({ cwd: process.cwd(), env: process.env, home: homedir(), platform: process.platform,
      toolsDir: dirname(fileURLToPath(import.meta.url)), terminal,
      spawn: (args, options) => spawnSync(process.execPath, args.slice(1), { ...options, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER }),
      ...deps });
    return result.code;
  } finally {
    readline?.close();
  }
};

if (isDirectRun(import.meta.url)) process.exitCode = await main();
