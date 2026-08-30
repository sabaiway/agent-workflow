import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildReceipt, fingerprint, lockPath, readReceipt, receiptPath, RELEASE_RUN_RECEIPT_BASENAME } from './release-receipt.mjs';
import { EXIT, STAGES } from './release-stages.mjs';
import {
  CACHED_DIFF, EXPECT, LOCK_FILE, MESSAGE_FILE, NEW_HEAD, OLD_HEAD, PORCELAIN, RECEIPT_FILE, TOKEN_FILE,
  makeResumeReceipt, makeWorld,
} from './release-run-harness.test.mjs';

const EXIT_CODE_BEFORE_IMPORT = process.exitCode;
const mod = await import('./release-run.mjs').catch(() => ({}));
const EXIT_CODE_AFTER_IMPORT = process.exitCode;
const parseArgs = mod.parseArgs;
const renderPlan = mod.renderPlan;
const runRelease = mod.runRelease;
const USAGE = mod.USAGE;
const ATOMIC_TIME = 123;
const SETTLE_MS = 50;
const RENAME_REFUSAL_CODES = new Set(['EISDIR', 'ENOTEMPTY', 'EEXIST']);

// spec:release-run/S10
test('tree and commit proof failures refuse before a receipt is advanced', async () => {
  assert.equal(typeof runRelease, 'function');
  const moved = makeWorld({ receipt: makeResumeReceipt('smoke-candidate'), headReads: [NEW_HEAD, OLD_HEAD], statusReads: ['', ''] });
  assert.equal(await runRelease(moved.args({ from: 'smoke-candidate', approved: null }), moved.deps), EXIT.refusal);
  assert.match(moved.errors.join('\n'), /HEAD|head/u);

  const dirty = makeWorld({ receipt: makeResumeReceipt('smoke-candidate'), headReads: [NEW_HEAD, NEW_HEAD], statusReads: ['', ' M changed\n'] });
  assert.equal(await runRelease(dirty.args({ from: 'smoke-candidate', approved: null }), dirty.deps), EXIT.refusal);
  assert.match(dirty.errors.join('\n'), /dirty|changed/u);

  const afterCommit = makeWorld({ statusReads: [PORCELAIN, ' M changed\n'] });
  assert.equal(await runRelease(afterCommit.args(), afterCommit.deps), EXIT.refusal);
  assert.equal(afterCommit.files.has(RECEIPT_FILE), false);

  const receiptLost = makeWorld({ writeFails: true });
  assert.equal(await runRelease(receiptLost.args(), receiptLost.deps), EXIT.refusal);
  assert.match(receiptLost.errors.join('\n'), new RegExp(`disk full.*commit ${NEW_HEAD} landed over ${OLD_HEAD}.*--from preflight-remote.*render --plan --from preflight-remote again$`, 'mu'));
  const wrongMessage = makeWorld({ logMessage: 'another message\n' });
  assert.equal(await runRelease(wrongMessage.args(), wrongMessage.deps), EXIT.refusal);
  assert.equal(wrongMessage.files.has(RECEIPT_FILE), false);
  assert.match(wrongMessage.errors.join('\n'), new RegExp(`commit ${NEW_HEAD} landed over ${OLD_HEAD}.*reset --soft ${OLD_HEAD}`, 'u'));

  const dirtiedLast = makeWorld({ statusReads: [PORCELAIN, ...Array(14).fill(''), ' M dirtied\n'] });
  assert.equal(await runRelease(dirtiedLast.args(), dirtiedLast.deps), EXIT.refusal);
  assert.match(dirtiedLast.errors.join('\n'), /dirtied/u);
  assert.equal(JSON.parse(dirtiedLast.files.get(RECEIPT_FILE)).stages.at(-1).status, 'pass');

  const newlineHead = makeWorld({ headSuffix: '\n' });
  assert.equal(await runRelease(newlineHead.args(), newlineHead.deps), EXIT.ok);
  assert.equal(JSON.parse(newlineHead.files.get(RECEIPT_FILE)).head, NEW_HEAD);
  const gitOrder = newlineHead.calls.order.filter((entry) => entry.startsWith('git:'));
  assert.ok(gitOrder.indexOf('git:status --porcelain --untracked-files=all') < gitOrder.indexOf('git:write-tree'));
  assert.ok(gitOrder.indexOf('git:write-tree') < gitOrder.indexOf('git:diff --cached --binary --no-ext-diff --no-textconv --ignore-submodules=none'));
  for (const sequencerRef of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD']) {
    const busy = makeWorld({ sequencerRef });
    assert.equal(await runRelease(busy.args(), busy.deps), EXIT.refusal);
    assert.match(busy.errors.join('\n'), new RegExp(`in progress \\(${sequencerRef}`, 'u'));
    assert.equal(busy.calls.exec.length, 0);
    assert.equal(await runRelease(busy.args({ plan: true, approved: null }), makeWorld({ sequencerRef }).deps), EXIT.refusal);
    const preflightBusy = makeWorld({ sequencerRef, statusReads: [''] });
    const preflightArgv = ['--from', 'preflight-remote', '--expect', `memory=${EXPECT.memory}`, '--expect', `engine=${EXPECT.engine}`, '--expect', `kit=${EXPECT.kit}`, '--token-file', TOKEN_FILE, '--approved', 'x'];
    assert.equal(await runRelease(preflightArgv, preflightBusy.deps), EXIT.refusal);
    assert.match(preflightBusy.errors.join('\n'), new RegExp(`in progress \\(${sequencerRef}`, 'u'));
  }
  const resumeBusy = makeWorld({ receipt: makeResumeReceipt('push'), sequencerRef: 'MERGE_HEAD' });
  assert.equal(await runRelease(resumeBusy.args({ from: 'push', approved: null }), resumeBusy.deps), EXIT.refusal);
  assert.equal(resumeBusy.calls.exec.length, 0);
  const probeBroken = makeWorld({ probeFails: true });
  assert.equal(await runRelease(probeBroken.args(), probeBroken.deps), EXIT.refusal);
  assert.match(probeBroken.errors.join('\n'), /rev-parse -q --verify/u);
  assert.equal(probeBroken.calls.exec.length, 0);
  const readFails = makeWorld({ failReadAfter: 'smoke-candidate' });
  assert.equal(await runRelease(readFails.args(), readFails.deps), EXIT.refusal);
  assert.equal(JSON.parse(readFails.files.get(RECEIPT_FILE)).stages.find(({ name }) => name === 'smoke-candidate').status, 'pass');

  for (const porcelain of [' M unstaged\n', 'MM half staged\n', '?? untracked\n', 'UU conflicted\n']) {
    const guarded = makeWorld({ statusReads: [porcelain] });
    assert.equal(await runRelease(guarded.args(), guarded.deps), EXIT.refusal);
    assert.equal(guarded.errors.join('\n').includes(porcelain.trim()), true);
    assert.equal(guarded.calls.exec.length, 0);
  }
  for (const options of [{ treeAfter: 'd'.repeat(40) }, { parentAfter: NEW_HEAD }, { parentAfter: `${OLD_HEAD} ${'e'.repeat(40)}` }]) {
    const proof = makeWorld(options);
    assert.equal(await runRelease(proof.args(), proof.deps), EXIT.refusal);
    assert.match(proof.errors.join('\n'), /approved index/u);
    assert.equal(proof.files.has(RECEIPT_FILE), false);
  }
});

// spec:release-run/S12
test('a plan renders the approved eight-stage run without writing', async () => {
  assert.equal(typeof renderPlan, 'function');
  const world = makeWorld();
  const parsed = parseArgs(world.args({ plan: true, approved: null }));
  const record = { ref: parsed.ref, expect: parsed.expect, tokenFile: parsed.tokenFile, smoke: parsed.smoke, messageFile: parsed.messageFile };
  const lines = renderPlan({ record, from: parsed.from, approved: world.approval() });
  assert.equal(lines.filter((line) => /^\d+[.] /u.test(line)).length, STAGES.length);
  assert.match(lines.join('\n'), /'it'\\''s ready'|'it'"'"'s ready'/u);
  assert.equal(lines.at(-1), `approved: ${world.approval()}`);
  assert.equal(renderPlan({ record, from: 'verify', approved: world.approval() }).some((line) => line.startsWith('approved:')), false);
  assert.throws(() => parseArgs(['--plan', '--message-file', 'bad\npath']), { exitCode: EXIT.usage });
  assert.equal(await runRelease(world.args({ plan: true, approved: null }), world.deps), EXIT.ok);
  assert.equal(world.calls.writes.length + world.calls.locks.length, 0);
  assert.equal(world.calls.logArgs.every((args) => args.length === 1), true);

  const resume = makeWorld({ receipt: makeResumeReceipt('verify'), headReads: [NEW_HEAD], statusReads: [''] });
  assert.equal(await runRelease(resume.args({ plan: true, from: 'verify', approved: null }), resume.deps), EXIT.ok);
  assert.equal(resume.logs.some((line) => line.startsWith('approved:')), false);
  assert.match(resume.logs[0], /commit: skipped/u);

  const unreadable = (argv) => argv.map((value) => value === MESSAGE_FILE ? '/repo/missing.txt' : value);
  assert.equal(await runRelease(unreadable(world.args({ plan: true, approved: null })), makeWorld().deps), EXIT.usage);
  const unreadableRun = makeWorld();
  assert.equal(await runRelease(unreadable(world.args()), unreadableRun.deps), EXIT.usage);
  assert.equal(unreadableRun.logs.some((line) => line.startsWith('release-run:')), false);
  assert.equal(await runRelease(['--plan', '--from', 'preflight-remote'], makeWorld().deps), EXIT.usage);
  const released = makeWorld({ receipt: makeResumeReceipt('smoke-init', { stages: STAGES.map((name) => ({ name, status: 'pass', exit: 0, startedAt: null, durationS: 1 })) }) });
  assert.equal(await runRelease(released.args({ plan: true, approved: null }), released.deps), EXIT.refusal);
  const unstagedPlan = makeWorld({ statusReads: [' M unstaged\n'] });
  assert.equal(await runRelease(unstagedPlan.args({ plan: true, approved: null }), unstagedPlan.deps), EXIT.refusal);
  assert.equal([...released.logs, ...unstagedPlan.logs].some((line) => line.startsWith('approved:')), false);
  assert.equal(await runRelease(['--plan', '--from', 'verify'], makeWorld().deps), EXIT.refusal);

  const diffKill = makeWorld();
  const diffGit = diffKill.deps.git;
  diffKill.deps.git = (argv, options) => argv[0] === 'diff'
    ? Promise.resolve({ status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: null, signal: 'SIGTERM', killedByDeadline: true })
    : diffGit(argv, options);
  assert.equal(await runRelease(diffKill.args({ plan: true, approved: null }), diffKill.deps), EXIT.refusal);
  assert.match(diffKill.errors.join('\n'), /killed at the deadline/u);

  const readFailure = makeWorld();
  readFailure.deps.git = async () => ({ status: 1, stdout: '', stderr: 'cannot read', error: null, signal: null });
  assert.equal(await runRelease(readFailure.args({ plan: true, approved: null }), readFailure.deps), EXIT.refusal);
  assert.match(readFailure.errors.join('\n'), /cannot read/u);
});

// spec:release-run/S13
test('a failed stage prints the one safe resume command', async () => {
  assert.equal(typeof runRelease, 'function');
  const failed = makeWorld({ exits: { 'smoke-candidate': 1 } });
  assert.equal(await runRelease(failed.args(), failed.deps), EXIT.failed);
  assert.match(failed.logs.join('\n'), /'--from' 'smoke-candidate'/u);
  const failedDirty = makeWorld({ exits: { push: 1 }, statusReads: [PORCELAIN, '', '', '', '', ' M leaked\n'] });
  assert.equal(await runRelease(failedDirty.args(), failedDirty.deps), EXIT.refusal);
  assert.match(failedDirty.errors.join('\n'), /leaked/u);
  assert.equal(failedDirty.logs.some((line) => line.includes('--from')), false);
  assert.equal(JSON.parse(failedDirty.files.get(RECEIPT_FILE)).stages.find(({ name }) => name === 'push').status, 'fail');

  const unknown = makeWorld({ exits: { live: 8 } });
  assert.equal(await runRelease(unknown.args(), unknown.deps), EXIT.failed);
  assert.match(unknown.logs.join('\n'), /'--from' 'verify'/u);
  const denied = makeWorld({ throwStage: 'live' });
  assert.equal(await runRelease(denied.args(), denied.deps), EXIT.failed);
  assert.match(denied.logs.join('\n'), /'--from' 'live'/u);
  assert.equal(JSON.parse(denied.files.get(RECEIPT_FILE)).stages.find(({ name }) => name === 'live').dispatched, undefined);

  const base = makeResumeReceipt('verify');
  const unknownReceipt = buildReceipt({ ...base, stages: base.stages.map((stage) => stage.name === 'live'
    ? { ...stage, status: 'fail', exit: 8, dispatched: 'unknown' } : stage) });
  const recovered = makeWorld({ receipt: unknownReceipt, headReads: [NEW_HEAD, NEW_HEAD, NEW_HEAD], statusReads: ['', '', ''] });
  assert.equal(await runRelease(recovered.args({ from: 'verify', approved: null }), recovered.deps), EXIT.ok);
  assert.equal(JSON.parse(recovered.files.get(RECEIPT_FILE)).stages.find(({ name }) => name === 'live').provenBy, 'verify');
  assert.equal(readReceipt(RECEIPT_FILE, () => recovered.files.get(RECEIPT_FILE)).refusal, undefined);
  for (const snapshot of recovered.calls.snapshots) assert.equal(readReceipt(RECEIPT_FILE, () => snapshot).refusal, undefined);

  const commit = makeWorld({ exits: { commit: 1 } });
  assert.equal(await runRelease(commit.args(), commit.deps), EXIT.failed);
  assert.match(commit.logs.join('\n'), /--message-file/u);
  assert.equal(commit.files.has(RECEIPT_FILE), false);
  const staleCommit = makeWorld({ exits: { commit: 1 }, receipt: makeResumeReceipt('live'), statusReads: [PORCELAIN], headReads: [OLD_HEAD] });
  assert.equal(await runRelease(staleCommit.args(), staleCommit.deps), EXIT.failed);
  assert.match(staleCommit.logs.at(-1), /^release-run: 0\/8 stages passed/u);
});

// spec:release-run/S14
test('invalid command forms are usage errors', () => {
  assert.equal(typeof parseArgs, 'function');
  const world = makeWorld();
  const valid = world.args();
  const cases = [
    ['--message', 'inline'], ['--unknown'],
    valid.filter((value, index) => !(value === '--expect' && valid[index + 1]?.startsWith('kit=')) && !(valid[index - 1] === '--expect' && value.startsWith('kit='))),
    [...valid, '--expect', `kit=${EXPECT.kit}`], valid.map((value) => value === `kit=${EXPECT.kit}` ? 'kit=1.0' : value),
    [...valid, '--ref', 'refs/heads/main'],
    ...['/main', 'foo/.bar', '@', 'foo]bar', 'release+1', 'a;b'].map((ref) => [...valid, '--ref', ref]),
    [...valid, '--ref', 'bad ref'], ['--from', 'commit'], ['--from', 'missing'],
    ['--from', 'verify', '--token-file', TOKEN_FILE], ['--from', 'verify', '--approved', 'x'], world.args({ approved: null }),
    valid.map((value) => value === MESSAGE_FILE ? 'bad\npath' : value), [...valid, '--smoke-file', 'missing-equals'],
    [...valid, '--smoke-line', ''], [...valid, '--smoke-file', '/abs/path=x'], [...valid, '--smoke-file', 'a='],
  ];
  for (const argv of cases) assert.throws(() => parseArgs(argv), { exitCode: EXIT.usage, message: /--smoke-file/u });
  assert.equal(typeof USAGE, 'string');
  assert.equal(USAGE.includes('\n'), false);
  assert.equal(parseArgs(valid.map((value) => value === MESSAGE_FILE ? 'relative message.txt' : value)).messageFile, resolve('relative message.txt'));
  assert.equal(parseArgs(valid.map((value) => value === TOKEN_FILE ? 'relative token' : value)).tokenFile, resolve('relative token'));
});

// spec:release-run/S15
test('the run preserves secret paths and finishes with accounting', async () => {
  assert.equal(typeof runRelease, 'function');
  const world = makeWorld();
  assert.equal(await runRelease(world.args(), world.deps), EXIT.ok);
  const live = world.calls.exec.find(({ stage }) => stage === 'live');
  assert.equal(live.argv[live.argv.indexOf('--token-file') + 1], TOKEN_FILE);
  assert.deepEqual(world.calls.exec.find(({ stage }) => stage === 'push').argv, ['push', 'origin', `${NEW_HEAD}:refs/heads/main`]);
  const hostileKeys = [...mod.GIT_LOCATION_VARS, 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'];
  assert.equal(mod.GIT_LOCATION_VARS.length, 8);
  const hostile = makeWorld();
  hostile.deps.env = { PATH: '/bin', GIT_AUTHOR_DATE: 'kept', ...Object.fromEntries(hostileKeys.map((key) => [key, '/elsewhere'])) };
  assert.equal(await runRelease(hostile.args(), hostile.deps), EXIT.ok);
  const clean = (env) => hostileKeys.every((key) => env[key] === undefined) && env.PATH === '/bin' && env.GIT_AUTHOR_DATE === 'kept';
  assert.equal(hostile.calls.exec.every(({ options }) => clean(options.env)), true);
  assert.equal(hostile.calls.gitEnvs.every(clean), true);
  assert.equal(world.calls.reads.includes(TOKEN_FILE), false);
  assert.match(world.logs.at(-1), /^release-run: 8\/8 stages passed · \d+s · 1 invocation[(]s[)]$/u);

  const receipt = makeResumeReceipt('smoke-init');
  const spawned = makeWorld({ receipt, headReads: [NEW_HEAD, NEW_HEAD], statusReads: ['', ''] });
  delete spawned.deps.exec;
  assert.equal(await runRelease(spawned.args({ from: 'smoke-init', approved: null }), spawned.deps), EXIT.ok);
  assert.deepEqual(spawned.calls.spawn[0].options.stdio, ['ignore', 'inherit', 'inherit']);

  const spawnFailure = makeWorld({ receipt, headReads: [NEW_HEAD, NEW_HEAD], statusReads: ['', ''] });
  delete spawnFailure.deps.exec;
  spawnFailure.deps.spawnImpl = () => { throw new Error('spawn denied'); };
  assert.equal(await runRelease(spawnFailure.args({ from: 'smoke-init', approved: null }), spawnFailure.deps), EXIT.failed);
  assert.match(spawnFailure.errors.join('\n'), /spawn denied/u);

  const emittedFailure = makeWorld({ receipt, headReads: [NEW_HEAD, NEW_HEAD], statusReads: ['', ''] });
  delete emittedFailure.deps.exec;
  emittedFailure.deps.spawnImpl = () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('spawn emitted error')));
    return child;
  };
  const emittedExit = await Promise.race([
    runRelease(emittedFailure.args({ from: 'smoke-init', approved: null }), emittedFailure.deps),
    new Promise((resolve) => setTimeout(() => resolve('unsettled'), SETTLE_MS)),
  ]);
  assert.equal(emittedExit, EXIT.failed);
});

// spec:release-run/S16
test('the entry guard is inert on import and recognizes a symlink', async () => {
  assert.equal(typeof runRelease, 'function');
  assert.equal(EXIT_CODE_AFTER_IMPORT, EXIT_CODE_BEFORE_IMPORT);

  const dir = mkdtempSync(join(tmpdir(), 'release-run-link-'));
  const link = join(dir, 'release-run-link.mjs');
  try {
    symlinkSync(join(import.meta.dirname, 'release-run.mjs'), link);
    const stderrPath = join(dir, 'stderr.txt');
    const stderr = openSync(stderrPath, 'w');
    try {
      assert.throws(
        () => execFileSync(process.execPath, [link], { stdio: ['ignore', 'ignore', stderr] }),
        (error) => error.status === EXIT.usage,
      );
    } finally { closeSync(stderr); }
    assert.equal(readFileSync(stderrPath, 'utf8'), `${USAGE}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// spec:release-run/S18
test('the exclusive lock surrounds every persisted stage transition', async () => {
  assert.equal(typeof runRelease, 'function');
  const success = makeWorld();
  assert.equal(await runRelease(success.args(), success.deps), EXIT.ok);
  assert.equal(success.calls.locks.length, 1);
  assert.equal(success.calls.removes.length, 1);
  assert.equal(success.files.has(LOCK_FILE), false);
  const lockAt = success.calls.order.indexOf('lock');
  assert.ok(lockAt !== -1 && lockAt < success.calls.order.indexOf(`read:${RECEIPT_FILE}`));
  assert.ok(lockAt < success.calls.order.indexOf('git:rev-parse HEAD'));
  for (const [index, snapshot] of success.calls.snapshots.entries()) {
    if (index === 0) continue;
    assert.equal(JSON.parse(snapshot).stages.find(({ name }) => name === success.calls.exec[index].stage).status, 'running');
  }

  const plan = makeWorld();
  await runRelease(plan.args({ plan: true, approved: null }), plan.deps);
  assert.equal(plan.calls.locks.length, 0);

  const blocked = makeWorld({ lock: '{"pid":99,"startedAt":"then"}' });
  assert.equal(await runRelease(blocked.args(), blocked.deps), EXIT.refusal);
  assert.match(blocked.errors.join('\n'), /99|then/u);
  assert.equal(blocked.files.has(LOCK_FILE), true);
  assert.equal(blocked.calls.reads.includes(RECEIPT_FILE), false);
  assert.equal(blocked.calls.order.includes('git:rev-parse HEAD'), false);

  for (const options of [{ exits: { push: 1 } }, { throwStage: 'push' }]) {
    const failed = makeWorld(options);
    assert.equal(await runRelease(failed.args(), failed.deps), EXIT.failed);
    assert.equal(failed.files.has(LOCK_FILE), false);
  }

  const removal = makeWorld({ removeError: new Error('unlink denied') });
  assert.equal(await runRelease(removal.args(), removal.deps), EXIT.ok);
  assert.match(removal.errors.join('\n'), new RegExp(`${LOCK_FILE}.*unlink denied|unlink denied.*${LOCK_FILE}`, 'u'));
  assert.match(removal.errors.join('\n'), /release itself completed/u);
  const removalAfterFailure = makeWorld({ removeError: new Error('unlink denied'), exits: { push: 1 } });
  assert.equal(await runRelease(removalAfterFailure.args(), removalAfterFailure.deps), EXIT.failed);
  assert.doesNotMatch(removalAfterFailure.errors.join('\n'), /release itself completed/u);

  const approved = fingerprint({
    head: OLD_HEAD, porcelain: '', cachedDiff: CACHED_DIFF, messageBytes: Buffer.alloc(0),
    ref: 'main', expect: EXPECT, smoke: [], tokenFile: TOKEN_FILE,
  });
  const preflightArgs = [
    '--from', 'preflight-remote', '--expect', `memory=${EXPECT.memory}`, '--expect', `engine=${EXPECT.engine}`,
    '--expect', `kit=${EXPECT.kit}`, '--token-file', TOKEN_FILE, '--approved', approved,
  ];
  const atomicDir = mkdtempSync(join(tmpdir(), 'release-run-atomic-'));
  const atomic = makeWorld({ statusReads: Array(STAGES.length * 2).fill('') });
  const atomicGit = atomic.deps.git;
  atomic.deps.git = (argv, options) => argv.join(' ') === 'rev-parse --path-format=absolute --git-common-dir'
    ? Promise.resolve({ status: 0, stdout: atomicDir, stderr: '', error: null, signal: null }) : atomicGit(argv, options);
  delete atomic.deps.writeFileAtomic;
  delete atomic.deps.createLock;
  delete atomic.deps.removeLock;
  try {
    assert.equal(await runRelease(preflightArgs, atomic.deps), EXIT.ok);
    assert.equal(existsSync(receiptPath(atomicDir)), true);
    assert.equal(existsSync(lockPath(atomicDir)), false);
    assert.equal(JSON.parse(readFileSync(receiptPath(atomicDir), 'utf8')).stages[0].status, 'pass');
  } finally { rmSync(atomicDir, { recursive: true, force: true }); }

  const fsyncDir = mkdtempSync(join(tmpdir(), 'release-run-fsync-'));
  const warnings = [];
  const refusing = (code) => () => { throw Object.assign(new Error(code), { code }); };
  try {
    mod.writeAtomic(join(fsyncDir, 'receipt.json'), 'bytes', { warn: (line) => warnings.push(line), fsyncDirectory: refusing('EINVAL') });
    assert.equal(readFileSync(join(fsyncDir, 'receipt.json'), 'utf8'), 'bytes');
    assert.match(warnings.join('\n'), /EINVAL/u);
    assert.throws(() => mod.writeAtomic(join(fsyncDir, 'other.json'), 'bytes', { warn: () => {}, fsyncDirectory: refusing('EIO') }), { code: 'EIO' });
  } finally { rmSync(fsyncDir, { recursive: true, force: true }); }
  const renameDir = mkdtempSync(join(tmpdir(), 'release-run-rename-'));
  const renameTarget = join(renameDir, 'receipt.json');
  try {
    mkdirSync(renameTarget);
    assert.throws(() => mod.writeAtomic(renameTarget, 'bytes', { warn: () => {} }), (error) => RENAME_REFUSAL_CODES.has(error.code));
    assert.equal(existsSync(renameTarget), true);
    assert.equal(readdirSync(renameDir).some((name) => name.endsWith('.tmp')), false);
  } finally { rmSync(renameDir, { recursive: true, force: true }); }
  const collisionDir = mkdtempSync(join(tmpdir(), 'release-run-collision-'));
  const collision = makeWorld({ statusReads: [''] });
  const collisionGit = collision.deps.git;
  collision.deps.git = (argv, options) => argv.join(' ') === 'rev-parse --path-format=absolute --git-common-dir'
    ? Promise.resolve({ status: 0, stdout: collisionDir, stderr: '', error: null, signal: null }) : collisionGit(argv, options);
  delete collision.deps.writeFileAtomic;
  delete collision.deps.createLock;
  delete collision.deps.removeLock;
  const originalNow = Date.now;
  Date.now = () => ATOMIC_TIME;
  writeFileSync(join(collisionDir, `.${RELEASE_RUN_RECEIPT_BASENAME}.${process.pid}.${ATOMIC_TIME}.tmp`), 'occupied');
  try {
    assert.equal(await runRelease(preflightArgs, collision.deps), EXIT.refusal);
    assert.equal(existsSync(lockPath(collisionDir)), false);
    assert.equal(readFileSync(join(collisionDir, `.${RELEASE_RUN_RECEIPT_BASENAME}.${process.pid}.${ATOMIC_TIME}.tmp`), 'utf8'), 'occupied');
  } finally {
    Date.now = originalNow;
    rmSync(collisionDir, { recursive: true, force: true });
  }
});
