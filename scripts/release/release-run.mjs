#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fail, shellQuote } from './dispatch-publish.mjs';
import { runGitProcess } from './git-process.mjs';
import { parseFileExpectation } from './smoke-init.mjs';
import {
  buildReceipt, commitProofViolation, fingerprint, hasValidRef, lockPath, readReceipt, receiptPath, resumeViolation,
  stagedOnlyViolation, startViolation,
} from './release-receipt.mjs';
import { EXIT, liveOutcome, stageCommand, STAGES, verifyOutcome } from './release-stages.mjs';
import { isDirectRun } from '../../agent-workflow-kit/tools/direct-run.mjs';
import { isRenderableLine } from '../../agent-workflow-kit/tools/repo-lex.mjs';

export const USAGE = 'usage: node scripts/release/release-run.mjs [--plan] [--from <stage>] [--message-file <file>] [--ref <branch>] --expect memory=X.Y.Z --expect engine=X.Y.Z --expect kit=X.Y.Z --token-file <file> [--smoke-line <line>] [--smoke-file <path=substring>] [--approved <fingerprint>]';
const ROOT = resolve(import.meta.dirname, '..', '..');
const NODE_COMMAND = 'node';
const SCRIPT = 'scripts/release/release-run.mjs';
const DEFAULT_REF = 'main';
const EXPECT_KEYS = Object.freeze(['memory', 'engine', 'kit']);
const SEMVER = /^\d+\.\d+\.\d+$/u;
const STATUS_ARGS = Object.freeze(['status', '--porcelain', '--untracked-files=all']);
const CACHED_DIFF_ARGS = Object.freeze(['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none']);
const SEQUENCER_REFS = Object.freeze(['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD']);
export const GIT_LOCATION_VARS = Object.freeze(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES']);
const GIT_CONFIG_PREFIX = 'GIT_CONFIG';
export const isGitRedirectingKey = (key) => GIT_LOCATION_VARS.includes(key) || key.startsWith(GIT_CONFIG_PREFIX);
const START_COMMIT = 'commit';
const START_PREFLIGHT = 'preflight-remote';
const LIVE = 'live';
const VERIFY = 'verify';
const STATUS = Object.freeze({ pending: 'pending', running: 'running', pass: 'pass', fail: 'fail' });
const ONE_SECOND_MS = 1_000;
const FILE_MODE = 0o600;
const refuseUsage = () => { throw fail(EXIT.usage, USAGE); };
const isSmokeFileOperand = (value) => { try { parseFileExpectation(value); return true; } catch { return false; } };
const readOperand = (argv, index) => {
  const value = argv[index + 1];
  return value === undefined || !isRenderableLine(value) ? refuseUsage() : value;
};
export const parseArgs = (argv) => {
  const parsed = { plan: false, from: null, messageFile: null, ref: DEFAULT_REF, expect: {}, tokenFile: null, smoke: [], approved: null };
  const seenExpect = new Set();
  const startFlags = new Set();
  const consume = (index) => {
    if (index >= argv.length) return;
    const flag = argv[index];
    if (!isRenderableLine(flag) || flag === '--message') refuseUsage();
    if (flag === '--plan') { parsed.plan = true; consume(index + 1); return; }
    const value = readOperand(argv, index);
    if (flag === '--from') parsed.from = value;
    else if (flag === '--message-file') { parsed.messageFile = resolve(value); startFlags.add(flag); }
    else if (flag === '--ref') { parsed.ref = value; startFlags.add(flag); }
    else if (flag === '--token-file') { parsed.tokenFile = resolve(value); startFlags.add(flag); }
    else if (flag === '--approved') { parsed.approved = value; startFlags.add(flag); }
    else if (flag === '--expect') {
      const separator = value.indexOf('=');
      const key = value.slice(0, separator);
      const version = value.slice(separator + 1);
      if (!EXPECT_KEYS.includes(key) || seenExpect.has(key) || !SEMVER.test(version)) refuseUsage();
      parsed.expect[key] = version;
      seenExpect.add(key);
      startFlags.add(flag);
    } else if (flag === '--smoke-line' || flag === '--smoke-file') {
      if (flag === '--smoke-line' ? value === '' : !isSmokeFileOperand(value)) refuseUsage();
      parsed.smoke.push({ kind: flag === '--smoke-line' ? 'line' : 'file', value });
      startFlags.add(flag);
    } else refuseUsage();
    consume(index + 2);
  };
  consume(0);
  if (parsed.from !== null && (!STAGES.includes(parsed.from) || parsed.from === START_COMMIT)) refuseUsage();
  const starts = parsed.from === null || startFlags.size > 0;
  if (parsed.from !== null && parsed.from !== START_PREFLIGHT && startFlags.size > 0) refuseUsage();
  if (parsed.from === START_PREFLIGHT && parsed.messageFile !== null) refuseUsage();
  if (starts) {
    if (!hasValidRef(parsed.ref) || seenExpect.size !== EXPECT_KEYS.length || parsed.tokenFile === null) refuseUsage();
    if (parsed.from === null && parsed.messageFile === null) refuseUsage();
    if (!parsed.plan && parsed.approved === null) refuseUsage();
  }
  if (!starts) return { ...parsed, ref: null, expect: null, tokenFile: null, smoke: [] };
  return { ...parsed, expect: Object.freeze({ ...parsed.expect }), smoke: Object.freeze(parsed.smoke.map(Object.freeze)) };
};
const renderCommand = ({ command, argv }) => [command, ...argv].map(shellQuote).join(' ');
export const renderPlan = ({ record, from = null, approved = null }) => {
  const cut = from === null ? 0 : STAGES.indexOf(from);
  const lines = STAGES.map((name, index) => `${index + 1}. ${name}: ${index < cut ? 'skipped' : renderCommand(stageCommand(name, record))}`);
  if (from === null || (from === START_PREFLIGHT && approved !== null)) lines.push(`approved: ${approved}`);
  return lines;
};
const runChild = (command, argv, { cwd, env, spawnImpl = spawn }) => new Promise((resolveChild) => {
  try {
    const child = spawnImpl(command, argv, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', (error) => resolveChild({ status: null, signal: null, error }));
    child.on('close', (status, signal) => resolveChild({ status, signal, error: null }));
  } catch (error) {
    resolveChild({ status: null, signal: null, error });
  }
});

const writeAll = (descriptor, bytes, offset = 0) => {
  if (offset >= bytes.length) return;
  writeAll(descriptor, bytes, offset + writeSync(descriptor, bytes, offset));
};
const fsyncPath = (target, flags) => {
  const descriptor = openSync(target, flags);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
};
const DIRECTORY_FSYNC_UNSUPPORTED = Object.freeze(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM']);
export const writeAtomic = (path, bytes, { warn = console.error, fsyncDirectory = fsyncPath } = {}) => {
  const directory = resolve(path, '..');
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const descriptor = openSync(temporary, 'wx', FILE_MODE);
  try {
    try { writeAll(descriptor, Buffer.from(bytes)); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
  try {
    fsyncDirectory(directory, 'r');
  } catch (error) {
    if (!DIRECTORY_FSYNC_UNSUPPORTED.includes(error?.code)) throw error;
    warn(`release receipt ${path}: the directory fsync is unsupported here (${error.code}); the rename is complete, durability across a power loss is the filesystem's`);
  }
};
const measureSeconds = (start, end) => Math.max(0, (Date.parse(end) - Date.parse(start)) / ONE_SECOND_MS);
const replaceStage = (receipt, name, stage) => buildReceipt({
  ...receipt,
  stages: receipt.stages.map((current) => current.name === name ? stage : current),
});
const countPassed = (receipt) => receipt?.stages.filter(({ status }) => status === STATUS.pass).length ?? 0;
const sumDuration = (receipt, fallback) => receipt
  ? receipt.stages.reduce((total, stage) => total + (stage.durationS ?? 0), 0)
  : fallback;
const hasInconclusiveVerify = (receipt) => receipt?.stages.some(({ name, inconclusive }) => name === VERIFY && inconclusive) ?? false;
const renderLine = (argv) => [NODE_COMMAND, SCRIPT, ...argv].map(shellQuote).join(' ');
const describeGitFailure = (args, result) => `git ${args.join(' ')} failed: ${result.error?.message
  ?? (result.killedByDeadline ? 'killed at the deadline' : (String(result.stderr ?? '') || `exit ${result.status}`))}`;

export const runRelease = async (argv, overrides = {}) => {
  const deps = {
    readFile: readFileSync, writeFileAtomic: (path, bytes) => writeAtomic(path, bytes, { warn: deps.logError }), removeLock: unlinkSync,
    createLock: (path, bytes) => writeFileSync(path, bytes, { flag: 'wx', mode: FILE_MODE }),
    now: () => new Date().toISOString(), pid: process.pid,
    log: console.log, logError: console.error, env: process.env, root: ROOT, spawnImpl: spawn,
    ...overrides,
  };
  deps.exec ??= (command, args, options) => runChild(command, args, { ...options, spawnImpl: deps.spawnImpl });
  deps.env = Object.fromEntries(Object.entries(deps.env).filter(([key]) => !isGitRedirectingKey(key)));
  deps.git ??= (args, options) => runGitProcess(args, options);
  const parsed = (() => { try { return parseArgs(argv); } catch (error) { return error; } })();
  if (parsed instanceof Error) {
    deps.logError(parsed.message);
    return parsed.exitCode ?? EXIT.usage;
  }
  const state = {
    receipt: null, record: null, invocationCount: 1, commitDuration: 0,
    ownedLock: false, activeLockPath: null, commonDir: null, messageBytes: null, expectedTree: null,
  };

  const readGit = async (args, options = {}) => {
    const result = await deps.git(args, { cwd: deps.root, env: deps.env, ...options });
    if (result.error !== null || result.status !== EXIT.ok) throw fail(EXIT.refusal, describeGitFailure(args, result));
    return result.stdout;
  };
  const readCommonDir = async () => {
    state.commonDir ??= (await readGit(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    return state.commonDir;
  };
  const account = () => deps.log(`release-run: ${countPassed(state.receipt)}/${STAGES.length} stages passed · ${Math.round(sumDuration(state.receipt, state.commitDuration))}s · ${state.invocationCount} invocation(s)${hasInconclusiveVerify(state.receipt) ? ' · verify: inconclusive' : ''}`);
  const refuse = (message) => { deps.logError(message); return EXIT.refusal; };
  const readMessage = () => {
    try { return deps.readFile(parsed.messageFile); } catch (error) { throw fail(EXIT.usage, `--message-file ${parsed.messageFile} cannot be read: ${error.message}`); }
  };
  const writeReceipt = async () => {
    const path = receiptPath(await readCommonDir());
    try { await deps.writeFileAtomic(path, `${JSON.stringify(state.receipt)}\n`); }
    catch (error) { throw fail(EXIT.refusal, `the release receipt ${path} could not be written: ${error.message}`); }
  };
  const openReceipt = (head, stages) => buildReceipt({ ...state.record, head, approved: parsed.approved, invocations: state.invocationCount, stages });
  const readStateReceipt = async () => {
    const path = receiptPath(await readCommonDir());
    const result = readReceipt(path, deps.readFile);
    if (result.refusal) throw fail(EXIT.refusal, result.refusal);
    return result.receipt;
  };
  const readFingerprint = async ({ head, porcelain, messageBytes }) => fingerprint({
    head, porcelain, cachedDiff: await readGit(CACHED_DIFF_ARGS, { encoding: null }), messageBytes,
    ref: parsed.ref, expect: parsed.expect, smoke: parsed.smoke, tokenFile: parsed.tokenFile,
  });
  const treeDeviation = async (moment) => {
    const seenHead = (await readGit(['rev-parse', 'HEAD'])).trim();
    const seenStatus = await readGit(STATUS_ARGS);
    if (seenHead !== state.receipt.head) return `HEAD moved ${moment}: expected ${state.receipt.head}, saw ${seenHead}`;
    return seenStatus === '' ? null : `the tree is dirty ${moment}: ${seenStatus.trim()}`;
  };
  const runStageChild = async (name, command) => {
    try {
      const result = await deps.exec(command.command, command.argv, { cwd: deps.root, env: command.env });
      if (result?.error) deps.logError(`${name} failed to run: ${result.error.message}`);
      return result;
    } catch (error) {
      deps.logError(`${name} failed to run: ${error.message}`);
      return { status: null, signal: null, error };
    }
  };

  const describeHolder = () => {
    try {
      const holder = JSON.parse(String(deps.readFile(state.activeLockPath)));
      return `pid ${holder.pid}, started ${holder.startedAt}`;
    } catch { return 'unknown holder'; }
  };
  const acquireLock = async () => {
    state.activeLockPath = lockPath(await readCommonDir());
    try {
      await deps.createLock(state.activeLockPath, `${JSON.stringify({ pid: deps.pid, startedAt: deps.now() })}\n`);
      state.ownedLock = true;
      return null;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw fail(EXIT.refusal, `the release lock ${state.activeLockPath} could not be created: ${error.message}`);
      return `release lock ${state.activeLockPath} is held by ${describeHolder()}; remove it by hand only after ps confirms the pid is gone`;
    }
  };

  const execute = async () => {
    if (!parsed.plan) {
      const held = await acquireLock();
      if (held !== null) return refuse(held);
    }
    state.receipt = await readStateReceipt();
    const head = (await readGit(['rev-parse', 'HEAD'])).trim();
    const porcelain = await readGit(STATUS_ARGS);
    for (const ref of SEQUENCER_REFS) {
      const probe = await deps.git(['rev-parse', '-q', '--verify', ref], { cwd: deps.root, env: deps.env });
      if (probe.status === EXIT.ok) return refuse(`a git operation is in progress (${ref} exists); finish or abort it before the release run`);
      if (probe.error !== null || probe.status !== EXIT.failed) throw fail(EXIT.refusal, describeGitFailure(['rev-parse', '-q', '--verify', ref], probe));
    }
    const preflightStarts = parsed.from === START_PREFLIGHT && parsed.expect !== null;
    const starts = parsed.from === null || preflightStarts;

    if (parsed.plan && !starts) {
      if (state.receipt === null || state.receipt.head !== head) {
        if (parsed.from === START_PREFLIGHT) throw fail(EXIT.usage, USAGE);
        throw fail(EXIT.refusal, `cannot render a resume without a receipt at HEAD ${head}`);
      }
      const violation = resumeViolation({ receipt: state.receipt, head, from: parsed.from });
      if (violation !== null) throw fail(EXIT.refusal, violation);
      state.record = { ref: state.receipt.ref, expect: state.receipt.expect, tokenFile: state.receipt.tokenFile, smoke: state.receipt.smoke, messageFile: null, head: state.receipt.head };
      renderPlan({ record: state.record, from: parsed.from, approved: null }).forEach((line) => deps.log(line));
      return EXIT.ok;
    }
    if (parsed.from === START_PREFLIGHT && !starts && (state.receipt === null || state.receipt.head !== head)) throw fail(EXIT.usage, USAGE);

    if (starts) {
      const form = parsed.from === null ? START_COMMIT : START_PREFLIGHT;
      const violation = startViolation({ receipt: state.receipt, head, dirty: porcelain !== '', expect: parsed.expect, form })
        ?? (form === START_COMMIT ? stagedOnlyViolation(porcelain) : null);
      if (violation !== null) return refuse(violation);
      if (form === START_COMMIT && !parsed.plan) state.expectedTree = (await readGit(['write-tree'])).trim();
      state.record = { ref: parsed.ref, expect: parsed.expect, tokenFile: parsed.tokenFile, smoke: parsed.smoke, messageFile: parsed.messageFile, head: form === START_PREFLIGHT ? head : undefined };
      state.messageBytes = form === START_COMMIT ? readMessage() : Buffer.alloc(0);
      const approved = await readFingerprint({ head, porcelain, messageBytes: state.messageBytes });
      if (parsed.plan) {
        renderPlan({ record: state.record, from: parsed.from, approved }).forEach((line) => deps.log(line));
        return EXIT.ok;
      }
      if (approved !== parsed.approved) return refuse('the tree is not the one approved');
      if (state.receipt !== null) {
        const lastPassed = state.receipt.stages.filter(({ status }) => status === STATUS.pass).at(-1)?.name ?? 'none';
        deps.log(`release-run: superseding receipt at ${state.receipt.head} (last passed stage: ${lastPassed})`);
      }
      if (form === START_COMMIT) state.receipt = null;
    } else {
      const violation = resumeViolation({ receipt: state.receipt, head, from: parsed.from });
      if (violation !== null) return refuse(violation);
      state.record = { ref: state.receipt.ref, expect: state.receipt.expect, tokenFile: state.receipt.tokenFile, smoke: state.receipt.smoke, messageFile: null, head: state.receipt.head };
      state.invocationCount = state.receipt.invocations + 1;
    }

    const fromIndex = parsed.from === null ? 0 : STAGES.indexOf(parsed.from);
    if (starts && parsed.from === START_PREFLIGHT) {
      state.receipt = openReceipt(head, STAGES.slice(0, fromIndex).map((name) => ({ name, status: STATUS.pass, exit: EXIT.ok, startedAt: null, durationS: 0 })));
      await writeReceipt();
    } else if (!starts) {
      state.receipt = buildReceipt({ ...state.receipt, invocations: state.invocationCount });
      await writeReceipt();
    }

    if (fromIndex === 0) {
      const stageStartedAt = deps.now();
      const result = await runStageChild(START_COMMIT, stageCommand(START_COMMIT, state.record, deps.env));
      const stageEndedAt = deps.now();
      state.commitDuration = measureSeconds(stageStartedAt, stageEndedAt);
      const exit = Number.isInteger(result?.status) ? result.status : EXIT.failed;
      if (exit !== EXIT.ok) {
        deps.log(renderLine(argv));
        return EXIT.failed;
      }
      const newHead = (await readGit(['rev-parse', 'HEAD'])).trim();
      const afterStatus = await readGit(STATUS_ARGS);
      const commitObject = await readGit(['cat-file', 'commit', 'HEAD'], { encoding: null });
      const landed = (reason) => `${reason}; commit ${newHead} landed over ${head} — undo it by hand with git reset --soft ${head}, only while git rev-parse HEAD prints ${newHead}`;
      if (afterStatus !== '') return refuse(landed(`the tree is dirty after commit: ${afterStatus.trim()}`));
      if (!commitObject.subarray(commitObject.indexOf('\n\n') + 2).equals(Buffer.from(state.messageBytes))) return refuse(landed('the committed message does not equal the message file'));
      const proof = commitProofViolation({
        parents: (await readGit(['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').slice(1),
        tree: (await readGit(['rev-parse', 'HEAD^{tree}'])).trim(), expectedParent: head, expectedTree: state.expectedTree,
      });
      if (proof !== null) return refuse(landed(proof));
      state.receipt = openReceipt(newHead, [{ name: START_COMMIT, status: STATUS.pass, exit, startedAt: stageStartedAt, durationS: state.commitDuration }]);
      state.record = { ...state.record, head: newHead };
      try {
        await writeReceipt();
      } catch (error) {
        return refuse(`${error.message}; commit ${newHead} landed over ${head} and is approved — continue with the receipt-free START (--from preflight-remote) once the receipt path is writable — render --plan --from preflight-remote again`);
      }
    }

    for (const name of STAGES.slice(Math.max(1, fromIndex))) {
      const before = await treeDeviation(`before ${name}`);
      if (before !== null) return refuse(before);
      const stageStartedAt = deps.now();
      state.receipt = replaceStage(state.receipt, name, { name, status: STATUS.running, exit: null, startedAt: stageStartedAt, durationS: null });
      await writeReceipt();
      const result = await runStageChild(name, stageCommand(name, state.record, deps.env));
      const exit = Number.isInteger(result?.status) ? result.status : EXIT.failed;
      const liveUnknown = state.receipt.stages.find((stage) => stage.name === LIVE)?.dispatched === 'unknown';
      const outcome = result?.error && result.status === null ? { status: STATUS.fail, exit, resumable: true }
        : name === LIVE ? liveOutcome(exit) : name === VERIFY ? verifyOutcome(exit, { liveUnknown })
          : exit === EXIT.ok ? { status: STATUS.pass, exit } : { status: STATUS.fail, exit };
      const stageEndedAt = deps.now();
      state.receipt = replaceStage(state.receipt, name, { name, ...outcome, startedAt: stageStartedAt, durationS: measureSeconds(stageStartedAt, stageEndedAt) });
      if (name === VERIFY && outcome.status === STATUS.pass) {
        const currentLive = state.receipt.stages.find((stage) => stage.name === LIVE);
        if (currentLive?.dispatched === 'unknown') state.receipt = replaceStage(state.receipt, LIVE, {
          name: LIVE, status: STATUS.pass, exit: currentLive.exit, startedAt: currentLive.startedAt,
          durationS: currentLive.durationS, provenBy: VERIFY,
        });
      }
      await writeReceipt();
      const after = await treeDeviation(`after ${name}`);
      if (after !== null) return refuse(after);
      if (outcome.status === STATUS.fail) {
        deps.log(renderLine(['--from', name === LIVE && outcome.dispatched === 'unknown' ? VERIFY : name]));
        return EXIT.failed;
      }
    }
    return EXIT.ok;
  };

  const finish = async () => {
    try { return await execute(); }
    catch (error) { deps.logError(error.message); return error.exitCode ?? EXIT.failed; }
  };
  const code = await finish();
  if (state.ownedLock) {
    try { await deps.removeLock(state.activeLockPath); }
    catch (error) {
      const completed = code === EXIT.ok ? '; the release itself completed' : '';
      deps.logError(`failed to remove release lock ${state.activeLockPath}: ${error.message} — remove it by hand once ps confirms pid ${deps.pid} is gone${completed}`);
    }
  }
  if (!parsed.plan && code !== EXIT.usage) account();
  return code;
};

if (isDirectRun(import.meta.url)) {
  runRelease(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
