import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { buildReceipt, fingerprint, lockPath, receiptPath } from './release-receipt.mjs';
import { STAGES } from './release-stages.mjs';

export const ROOT = '/repo';
export const COMMON_DIR = join(ROOT, '.git');
export const MESSAGE_FILE = join(ROOT, 'release message.txt');
export const TOKEN_FILE = join(ROOT, 'token file');
export const RECEIPT_FILE = receiptPath(COMMON_DIR);
export const LOCK_FILE = lockPath(COMMON_DIR);
export const OLD_HEAD = 'a'.repeat(40);
export const NEW_HEAD = 'b'.repeat(40);
export const TREE = 'c'.repeat(40);
export const MESSAGE = Buffer.concat([Buffer.from('release message '), Buffer.from([0xff, 0x0a])]);
export const PORCELAIN = 'M  staged-file\n';
export const CACHED_DIFF = Buffer.from([0x63, 0x61, 0x63, 0x68, 0x65, 0x64, 0xff, 0x0a]);
export const EXPECT = Object.freeze({ memory: '7.1.2', engine: '4.4.0', kit: '10.5.0' });
export const SMOKE = Object.freeze([
  Object.freeze({ kind: 'line', value: "it's ready" }),
  Object.freeze({ kind: 'file', value: 'state.json=ready' }),
]);
const START_TIME = Date.parse('2026-08-30T00:00:00.000Z');

export const makeWorld = (options = {}) => {
  const files = new Map();
  const calls = { git: [], gitEnvs: [], exec: [], reads: [], writes: [], locks: [], removes: [], spawn: [], snapshots: [], logArgs: [], order: [] };
  const logs = [];
  const errors = [];
  const state = {
    committed: false,
    gitFails: false,
    ticks: START_TIME,
    exits: { ...(options.exits ?? {}) },
    headReads: [...(options.headReads ?? [])],
    statusReads: [...(options.statusReads ?? [])],
  };

  if (options.receipt) files.set(RECEIPT_FILE, `${JSON.stringify(options.receipt)}\n`);
  if (options.lock) files.set(LOCK_FILE, options.lock);

  const readHead = () => `${state.headReads.shift() ?? (state.committed || options.receipt ? NEW_HEAD : OLD_HEAD)}${options.headSuffix ?? ''}`;
  const readStatus = () => state.statusReads.shift() ?? (state.committed || options.receipt ? '' : PORCELAIN);
  const git = async (argv, callOptions) => {
    calls.git.push([...argv]);
    calls.gitEnvs.push(callOptions?.env ?? {});
    const key = argv.join(' ');
    calls.order.push(`git:${key}`);
    if (state.gitFails && key === 'rev-parse HEAD') return { status: 1, stdout: '', stderr: 'read failed', error: null, signal: null };
    if (key.startsWith('rev-parse -q --verify ')) return { status: options.probeFails ? 128 : key.endsWith(` ${options.sequencerRef}`) ? 0 : 1, stdout: '', stderr: options.probeFails ? 'fatal: broken' : '', error: null, signal: null };
    const stdout = key === 'rev-parse HEAD' ? readHead()
      : key === 'status --porcelain --untracked-files=all' ? readStatus()
        : key === 'diff --cached --binary --no-ext-diff --no-textconv --ignore-submodules=none' ? (callOptions?.encoding === null ? CACHED_DIFF : CACHED_DIFF.toString())
          : key === 'rev-parse --path-format=absolute --git-common-dir' ? COMMON_DIR
            : key === 'cat-file commit HEAD' ? (callOptions?.encoding === null ? Buffer.concat([Buffer.from(`tree ${TREE}\nparent ${OLD_HEAD}\n\n`), Buffer.from(options.logMessage ?? MESSAGE)]) : 'decoded')
              : key === 'write-tree' ? TREE
                : key === 'rev-parse HEAD^{tree}' ? `${options.treeAfter ?? TREE}${options.headSuffix ?? ''}`
                  : key === 'rev-list --parents -n 1 HEAD' ? `${NEW_HEAD} ${options.parentAfter ?? OLD_HEAD}\n`
                    : '';
    return { status: 0, stdout, stderr: '', error: null, signal: null };
  };
  const readFile = (path) => {
    calls.reads.push(path);
    calls.order.push(`read:${path}`);
    if (path === MESSAGE_FILE) return MESSAGE;
    if (files.has(path)) return files.get(path);
    const error = new Error(`ENOENT: ${path}`);
    error.code = 'ENOENT';
    throw error;
  };
  const writeFileAtomic = async (path, bytes) => {
    calls.writes.push(path);
    if (options.writeFails) throw new Error('disk full');
    files.set(path, String(bytes));
  };
  const createLock = async (path, bytes) => {
    calls.locks.push(path);
    calls.order.push('lock');
    if (files.has(path)) {
      const error = new Error('lock exists');
      error.code = 'EEXIST';
      throw error;
    }
    files.set(path, String(bytes));
  };
  const removeLock = async (path) => {
    calls.removes.push(path);
    if (options.removeError) throw options.removeError;
    files.delete(path);
  };
  const readStage = (command, argv) => command === 'git' ? argv[0]
    : argv[0].includes('preflight-remote') ? 'preflight-remote'
      : argv[0].includes('smoke-candidate') ? 'smoke-candidate'
        : argv[0].includes('cross-version-gate') ? 'cross-version-gate'
          : argv[0].includes('dispatch-publish') ? (argv.includes('--live') ? 'live' : 'verify')
            : 'smoke-init';
  const exec = async (command, argv, execOptions) => {
    const stage = readStage(command, argv);
    calls.exec.push({ stage, command, argv: [...argv], options: execOptions });
    calls.snapshots.push(files.get(RECEIPT_FILE) ?? null);
    if (stage === 'commit') state.committed = true;
    if (options.failReadAfter === stage) state.gitFails = true;
    if (options.throwStage === stage) throw new Error(`thrown ${stage}`);
    return { status: state.exits[stage] ?? 0, signal: null, error: null };
  };
  const spawnImpl = (command, argv, spawnOptions) => {
    calls.spawn.push({ command, argv: [...argv], options: spawnOptions });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  };
  const now = () => new Date(state.ticks += 1_000).toISOString();
  const deps = {
    exec, git, readFile, writeFileAtomic, createLock, removeLock, now,
    pid: 4242, log: (...args) => { calls.logArgs.push(args); logs.push(String(args[0])); }, logError: (line) => errors.push(line),
    env: { PATH: '/bin' }, root: ROOT, spawnImpl,
  };
  const approval = () => fingerprint({
    head: OLD_HEAD, porcelain: PORCELAIN, cachedDiff: CACHED_DIFF,
    messageBytes: MESSAGE, ref: 'main', expect: EXPECT, smoke: SMOKE, tokenFile: TOKEN_FILE,
  });
  const args = ({ plan = false, from, approved = approval() } = {}) => [
    ...(plan ? ['--plan'] : []), ...(from ? ['--from', from] : []),
    ...(!from || from === 'preflight-remote' ? [
      '--message-file', MESSAGE_FILE,
      '--expect', `memory=${EXPECT.memory}`, '--expect', `engine=${EXPECT.engine}`, '--expect', `kit=${EXPECT.kit}`,
      '--token-file', TOKEN_FILE, '--smoke-line', SMOKE[0].value, '--smoke-file', SMOKE[1].value,
      ...(approved === null ? [] : ['--approved', approved]),
    ] : approved === null ? [] : ['--approved', approved]),
  ];
  return { deps, files, calls, logs, errors, state, args, approval };
};

export const makeResumeReceipt = (from, changes = {}) => {
  const fromIndex = STAGES.indexOf(from);
  return buildReceipt({
    head: NEW_HEAD, ref: 'main', expect: EXPECT, tokenFile: TOKEN_FILE, smoke: SMOKE,
    approved: '0'.repeat(64), invocations: 1,
    stages: STAGES.map((name, index) => ({ name, status: index < fromIndex ? 'pass' : 'pending', exit: index < fromIndex ? 0 : null, startedAt: null, durationS: null })),
    ...changes,
  });
};
