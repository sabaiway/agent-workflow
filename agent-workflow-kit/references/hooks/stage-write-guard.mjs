#!/usr/bin/env node
// stage-write-guard.mjs — the kit's PreToolUse stage write guard, placed at .claude/hooks/stage-write-guard.mjs
// (docs/ai/specs/kit/stage-write-guard.md). Self-contained: node: modules only, no effect unless run as the hook.

import { spawnSync } from 'node:child_process';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// generated from agent-workflow-memory/references/scripts/shared/locations.mjs and agent-workflow-kit/tools/stage-render/ (index.mjs, stages.json) by scripts/sync-mirrors.mjs; do not edit
const DOCS = "docs";
const DOCS_TREE = "docs/ai";
const PLANS = "docs/plans";
const ORCHESTRATION = "docs/ai/orchestration.json";
const STAGE_GUARD_HOOK = ".claude/hooks/stage-write-guard.mjs";
const STAGE_RECORD_BASENAME = "agent-workflow-stage.json";
const SLOT_FILE_NAME = "next-session.json";
const RENDER_LINE = "node <kit>/tools/stage-render/cli.mjs docs/plans/next-session.json";
const STAGE_IDS = ["epic","design-consult","spec-and-plan","waiting-on-approval","tests","code","diff-review","split-modules","split-edits","pause","empty-queue"];
// end of the generated locations

const PATH_FIELDS = Object.freeze({ Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' });
const HOOK_EVENT_NAME = 'PreToolUse';
const DENY = 'deny';
const UTF8 = 'utf8';

const GIT = 'git';
const GIT_ARGS = Object.freeze(['rev-parse', '--show-toplevel', '--absolute-git-dir']);
const GIT_COMMAND = [GIT, ...GIT_ARGS].join(' ');
const GIT_VARIABLE = /^git_/iu;
const GIT_ANSWERED_EXIT = 128;
const NOT_A_REPOSITORY = /^fatal: not a git repository\b/mu;
const NO_WORK_TREE = /^fatal: this operation must be run in a work tree\b/mu;
const GIT_OUTPUT_CEILING = 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const GIT_ANSWER_LINES = 3;
const STDERR_SHOWN = 200;

const RUN_TREE = 'tree';
const RUN_NONE = 'none';
const RUN_FAILED = 'failed';

const RECORD_SCHEMA = 1;
const RECORD_KEYS = Object.freeze(['schema', 'slotFile', 'stage', 'writes']);
const WRITES_ANY = 'any';
const WRITES_AUTHORING = 'authoring';
const JSON_STRING = /"(?:[^"\\]|\\.)*"/gu;
const FOLLOWED_BY_COLON = /^\s*:/u;
const READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

const MARKDOWN = '.md';
const JSON_FILE = '.json';
const TEXT_FILE = '.txt';
const DOT_DOT = '..';
const RAW_SEGMENT_SEPARATOR = /[\\/]/u;
const CONFIG_HOME = '.claude';
const MEMORY_PROJECTS = 'projects';
const MEMORY_DIR = 'memory';
const HOST_PLANS = 'plans';
const MEMORY_NOTE_DEPTH = 4;
const HOST_PLAN_DEPTH = 2;

const GUARD_PREFIX = `stage guard (${STAGE_GUARD_HOOK})`;
const RENDER_SENTENCE = `code and tests are written only after the render of an approved plan's tests, code, split-edits or diff-review stage: ${RENDER_LINE}`;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const failed = (failure) => ({ kind: RUN_FAILED, failure });
const codeOf = (error) => error?.code ?? error?.message ?? String(error);

const lstatOrNull = (path) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};

const realPathOf = (path) => {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const entry = lstatOrNull(path);
  if (entry?.isSymbolicLink()) return realPathOf(resolve(dirname(path), readlinkSync(path)));
  if (entry !== null) throw new Error(`${path}: present but without a real path`);
  const parent = dirname(path);
  if (parent === path) throw new Error(`${path}: no existing ancestor`);
  return join(realPathOf(parent), basename(path));
};

const realOrNull = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const deepestExisting = (path) => {
  if (lstatOrNull(path) !== null) return path;
  const parent = dirname(path);
  if (parent === path) throw new Error(`${path}: no existing ancestor`);
  return deepestExisting(parent);
};

const readNoFollow = (path) => {
  const descriptor = openSync(path, READ_FLAGS);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error('not a regular file');
    return new TextDecoder(UTF8, { fatal: true, ignoreBOM: true }).decode(readFileSync(descriptor));
  } finally {
    closeSync(descriptor);
  }
};

const gitEnvOf = (env) => ({ ...Object.fromEntries(Object.entries(env).filter(([key]) => !GIT_VARIABLE.test(key))), LC_ALL: 'C' });

const readGitAnswer = (dir, stdout) => {
  const lines = stdout.split('\n');
  if (lines.length !== GIT_ANSWER_LINES || lines[2] !== '' || !lines.slice(0, 2).every((line) => isAbsolute(line))) {
    return failed(`${GIT_COMMAND} in ${dir} answered no work tree and git directory`);
  }
  try {
    const gitDir = realpathSync(lines[1]);
    return { kind: RUN_TREE, root: realpathSync(lines[0]), gitDir, recordPath: join(gitDir, STAGE_RECORD_BASENAME) };
  } catch (error) {
    return failed(`${GIT_COMMAND} in ${dir} answered a path without a real path (${codeOf(error)})`);
  }
};

const runGit = (dir, env) => {
  const result = spawnSync(GIT, GIT_ARGS, {
    cwd: dir, env: gitEnvOf(env), encoding: UTF8, maxBuffer: GIT_OUTPUT_CEILING, timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  if (result.error) return failed(`${GIT_COMMAND} in ${dir} could not run (${codeOf(result.error)})`);
  if (result.signal) return failed(`${GIT_COMMAND} in ${dir} was killed by ${result.signal}`);
  if (result.status === 0) return readGitAnswer(dir, result.stdout);
  const stderr = result.stderr ?? '';
  if (result.status === GIT_ANSWERED_EXIT && (NOT_A_REPOSITORY.test(stderr) || NO_WORK_TREE.test(stderr))) return { kind: RUN_NONE };
  return failed(`${GIT_COMMAND} in ${dir} exited ${result.status}: ${stderr.trim().slice(0, STDERR_SHOWN)}`);
};

const runsFor = (cwd, realTarget, env) => {
  const targetDir = deepestExisting(dirname(realTarget));
  const cwdRun = runGit(cwd, env);
  return realOrNull(cwd) === targetDir ? [cwdRun] : [cwdRun, runGit(targetDir, env)];
};

const holdsDotDot = (rawPath) => rawPath.split(RAW_SEGMENT_SEPARATOR).includes(DOT_DOT);
const segmentsUnder = (base, path) => {
  const rel = relative(base, path);
  if (rel === '' || isAbsolute(rel)) return null;
  const segments = rel.split(sep);
  return segments[0] === DOT_DOT ? null : segments;
};

const configDirOf = (env) => {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (typeof configured === 'string' && isAbsolute(configured)) return configured;
  return join(typeof env.HOME === 'string' && isAbsolute(env.HOME) ? env.HOME : homedir(), CONFIG_HOME);
};

const isHarnessDocument = (rawPath, target, env) => {
  try {
    const realTarget = realPathOf(target);
    if (holdsDotDot(rawPath) || extname(realTarget) !== MARKDOWN) return false;
    const segments = segmentsUnder(realPathOf(configDirOf(env)), realTarget);
    if (segments === null) return false;
    return (segments.length === MEMORY_NOTE_DEPTH && segments[0] === MEMORY_PROJECTS && segments[2] === MEMORY_DIR)
      || (segments.length === HOST_PLAN_DEPTH && segments[0] === HOST_PLANS);
  } catch {
    return false;
  }
};

const isUnder = (rel, dir) => rel.startsWith(`${dir}/`);
const isCanonicalRel = (value) => value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== DOT_DOT);

const configuredPaths = (root) => {
  try {
    const flow = JSON.parse(readNoFollow(join(root, ORCHESTRATION)))?.flow;
    if (!isPlainObject(flow)) return [];
    return [flow.debtQueue, flow.convergenceSummary].filter((value) => typeof value === 'string' && !value.includes('\\')
      && isCanonicalRel(value) && isUnder(value, DOCS) && extname(value) === MARKDOWN);
  } catch {
    return [];
  }
};

const isProjectAuthoring = (root, realTarget) => {
  const segments = segmentsUnder(root, realTarget);
  if (segments === null) return false;
  const rel = segments.join('/');
  const extension = extname(rel);
  if (isUnder(rel, DOCS_TREE) && (extension === MARKDOWN || extension === JSON_FILE)) return true;
  if (isUnder(rel, PLANS) && (extension === MARKDOWN || extension === TEXT_FILE)) return true;
  if (rel === `${PLANS}/${SLOT_FILE_NAME}`) return true;
  return configuredPaths(root).includes(rel);
};

const memberNamesOf = (text) => [...text.matchAll(JSON_STRING)]
  .filter((token) => FOLLOWED_BY_COLON.test(text.slice(token.index + token[0].length)))
  .map((token) => JSON.parse(token[0]));

const isRecordShape = (record, text) => isPlainObject(record)
  && memberNamesOf(text).sort().join() === RECORD_KEYS.join()
  && record.schema === RECORD_SCHEMA
  && (record.stage === null || STAGE_IDS.includes(record.stage))
  && record.slotFile === `${PLANS}/${SLOT_FILE_NAME}`
  && (record.writes === WRITES_ANY || record.writes === WRITES_AUTHORING);

const readRecord = (recordPath, entry) => {
  if (!entry.isFile()) return { unreadable: entry.isSymbolicLink() ? 'a link' : 'not a regular file' };
  try {
    const text = readNoFollow(recordPath);
    const record = JSON.parse(text);
    return isRecordShape(record, text) ? { record } : { unreadable: 'not a stage record of schema 1' };
  } catch (error) {
    return { unreadable: codeOf(error) };
  }
};

const presentRecords = (runs) => {
  const trees = runs.filter(({ kind }) => kind === RUN_TREE);
  return trees.filter((tree, index) => trees.findIndex(({ gitDir }) => gitDir === tree.gitDir) === index)
    .flatMap((tree) => {
      try {
        const entry = lstatOrNull(tree.recordPath);
        return entry === null ? [] : [{ tree, ...readRecord(tree.recordPath, entry) }];
      } catch (error) {
        return [{ tree, unreadable: codeOf(error) }];
      }
    });
};

const denial = (target, cause) => `${GUARD_PREFIX}: ${target} is refused: ${cause}; ${RENDER_SENTENCE}`;
const stageCause = ({ stage, slotFile }) => (stage === null
  ? `the last render recorded no stage for slot file ${slotFile}, which writes only authoring documents`
  : `the recorded stage ${stage} (slot file ${slotFile}) writes only authoring documents`);

const judgeRecord = (target, present, isAuthoring) => {
  if (present.unreadable !== undefined) {
    return isAuthoring() ? null : denial(target, `the stage record ${present.tree.recordPath} cannot be read (${present.unreadable})`);
  }
  if (present.record.writes === WRITES_ANY || isAuthoring()) return null;
  return denial(target, stageCause(present.record));
};

const judgeWrite = ({ rawPath, cwd }, target, harnessDocument, env) => {
  const realTarget = realPathOf(target);
  const runs = runsFor(cwd, realTarget, env);
  const failure = runs.find(({ kind }) => kind === RUN_FAILED);
  if (failure !== undefined) return harnessDocument ? null : denial(target, failure.failure);
  const present = presentRecords(runs);
  const landing = runs.at(-1);
  const isAuthoring = () => harnessDocument
    || (!holdsDotDot(rawPath) && landing.kind === RUN_TREE && isProjectAuthoring(landing.root, realTarget));
  return present.map((record) => judgeRecord(target, record, isAuthoring)).find((reason) => reason !== null) ?? null;
};

const decideWrite = (request, env) => {
  const validCwd = typeof request.cwd === 'string' && isAbsolute(request.cwd);
  const target = isAbsolute(request.rawPath) ? resolve(request.rawPath) : validCwd ? resolve(request.cwd, request.rawPath) : null;
  const harnessDocument = target !== null && isHarnessDocument(request.rawPath, target, env);
  try {
    if (target === null || !validCwd) throw new Error('the payload names no absolute cwd');
    return judgeWrite(request, target, harnessDocument, env);
  } catch (error) {
    return harnessDocument ? null : denial(target ?? request.rawPath, `the guard could not judge the write (${codeOf(error)})`);
  }
};

const readWriteRequest = (text) => {
  try {
    const payload = JSON.parse(text);
    if (!isPlainObject(payload) || !Object.hasOwn(PATH_FIELDS, payload.tool_name) || !isPlainObject(payload.tool_input)) return null;
    const rawPath = payload.tool_input[PATH_FIELDS[payload.tool_name]];
    return typeof rawPath === 'string' && rawPath !== '' ? { rawPath, cwd: payload.cwd } : null;
  } catch {
    return null;
  }
};

const formatDeny = (reason) => JSON.stringify({
  hookSpecificOutput: { hookEventName: HOOK_EVENT_NAME, permissionDecision: DENY, permissionDecisionReason: reason },
});

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString(UTF8);
};

const main = async () => {
  const request = readWriteRequest(await readStdin().catch(() => ''));
  if (request === null) return;
  const reason = decideWrite(request, process.env);
  if (reason !== null) process.stdout.write(`${formatDeny(reason)}\n`);
};

const isDirectRun = (() => {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isDirectRun) main().catch(() => {});
