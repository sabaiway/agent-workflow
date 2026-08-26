import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import {
  PROCESS_DEADLINE_MS,
  KILL_ESCALATION_MS,
  TERMINATE_SIGNAL,
  FORCE_SIGNAL,
  NON_INTERACTIVE_ENV,
  GIT_COMMAND,
  runProcess,
  runGitProcess,
} from './git-process.mjs';

// ── harness: a stub child + a stub clock, so the deadline arms are observable ──────────

// Overrides are ASSIGNED, never destructured with a default: a failed spawn really does carry
// `pid: undefined`, and a default parameter would quietly replace exactly that case with a pid.
const stubChild = (overrides = {}) => Object.assign(new EventEmitter(), {
  pid: 4242,
  stdout: new EventEmitter(),
  stderr: new EventEmitter(),
  kill: () => true,
}, overrides);

// `cleared` records the tokens handed back to clearTimer: disarming the force timer on close is what
// keeps this leaf from signalling a pid it no longer owns, so the property earns a direct assertion.
const timerHarness = () => {
  const armed = [];
  const cleared = [];
  return {
    armed,
    cleared,
    setTimer: (fn, ms) => {
      const token = { fn, ms };
      armed.push(token);
      return token;
    },
    clearTimer: (token) => cleared.push(token),
  };
};

const spawnHarness = (child) => {
  const calls = [];
  return { calls, spawnImpl: (command, args, options) => { calls.push({ command, args, options }); return child; } };
};

const killHarness = () => {
  const calls = [];
  return { calls, kill: (pid, signal) => { calls.push({ pid, signal }); } };
};

// ── the deadline constant is DECLARED in the module, and it is the one applied ─────────

describe('git-process — the named deadline constant', () => {
  it('declares the deadline as 30_000 MILLISECONDS and the escalation grace as 2_000', () => {
    assert.equal(PROCESS_DEADLINE_MS, 30_000);
    assert.equal(KILL_ESCALATION_MS, 2_000);
  });

  it('arms the DEFAULT deadline constant when the caller passes no override', async () => {
    const child = stubChild();
    const clock = timerHarness();
    const promise = runProcess('git', ['status'], { spawnImpl: spawnHarness(child).spawnImpl, ...clock });
    child.emit('close', 0, null);
    await promise;
    assert.deepEqual(clock.armed.map((t) => t.ms), [PROCESS_DEADLINE_MS]);
  });

  it("arms the caller's deadline when one is given, and never the default as well", async () => {
    const child = stubChild();
    const clock = timerHarness();
    const promise = runProcess('git', ['status'], { deadlineMs: 500, spawnImpl: spawnHarness(child).spawnImpl, ...clock });
    child.emit('close', 0, null);
    await promise;
    assert.deepEqual(clock.armed.map((t) => t.ms), [500]);
  });
});

// ── the run can neither prompt nor read the terminal ───────────────────────────────────

describe('git-process — the non-interactive environment (Decision 7)', () => {
  const runWithEnv = async (env, options = {}) => {
    const child = stubChild();
    const spawns = spawnHarness(child);
    const promise = runGitProcess(['fetch', 'origin', 'main'], { env, spawnImpl: spawns.spawnImpl, ...timerHarness(), ...options });
    child.emit('close', 0, null);
    await promise;
    return spawns.calls[0];
  };

  it('sets all four non-interactive variables to their exact expected values', async () => {
    const call = await runWithEnv({ PATH: '/usr/bin' });
    assert.equal(call.options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(call.options.env.GIT_ASKPASS, '');
    assert.equal(call.options.env.SSH_ASKPASS, '');
    assert.equal(call.options.env.GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');
    assert.deepEqual({ ...NON_INTERACTIVE_ENV }, {
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    });
  });

  it("preserves the caller's other environment", async () => {
    const call = await runWithEnv({ PATH: '/usr/bin', LANG: 'en_US.UTF-8', HOME: '/home/someone' });
    assert.equal(call.options.env.PATH, '/usr/bin');
    assert.equal(call.options.env.LANG, 'en_US.UTF-8');
    assert.equal(call.options.env.HOME, '/home/someone');
  });

  it('pins the four LAST, so a caller cannot unset one through extraEnv', async () => {
    const call = await runWithEnv({ PATH: '/usr/bin' }, { extraEnv: { GIT_TERMINAL_PROMPT: '1', GIT_SSH_COMMAND: 'ssh', GIT_CONFIG_COUNT: '0' } });
    assert.equal(call.options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(call.options.env.GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');
    assert.equal(call.options.env.GIT_CONFIG_COUNT, '0', 'an unrelated extraEnv entry still reaches the child');
  });

  it('never inherits stdin — a child that cannot reach the terminal cannot prompt on it', async () => {
    const call = await runWithEnv({ PATH: '/usr/bin' });
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(call.options.detached, true, 'detached makes the child a group leader, so termination can reach descendants');
    assert.equal(call.command, GIT_COMMAND);
  });
});

// ── the result is lossless on every path ───────────────────────────────────────────────

describe('git-process — the result stays lossless', () => {
  it('reports a NON-ZERO exit as a result, never a throw, with stdout and stderr unmangled', async () => {
    const child = stubChild();
    const promise = runProcess('git', ['merge-base', '--is-ancestor', 'a', 'b'], { spawnImpl: spawnHarness(child).spawnImpl, ...timerHarness() });
    child.stdout.emit('data', Buffer.from('partial out'));
    child.stderr.emit('data', Buffer.from('fatal: not a valid commit name\n'));
    child.emit('close', 1, null);
    const res = await promise;
    assert.equal(res.status, 1);
    assert.equal(res.stdout, 'partial out');
    assert.equal(res.stderr, 'fatal: not a valid commit name\n');
    assert.equal(res.error, null);
    assert.equal(res.signal, null);
  });

  it('reports a SPAWN failure with the error object itself, and a null status', async () => {
    const child = stubChild({ pid: undefined });
    const spawnError = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    const clock = timerHarness();
    const promise = runProcess('git', ['status'], { spawnImpl: spawnHarness(child).spawnImpl, ...clock });
    child.emit('error', spawnError);
    const res = await promise;
    assert.equal(res.error, spawnError, 'the error object is passed through, never re-wrapped into text');
    assert.equal(res.error.code, 'ENOENT');
    assert.equal(res.status, null);
    assert.equal(res.signal, null);
    assert.equal(res.stdout, '');
    assert.equal(res.stderr, '');
    assert.deepEqual(clock.armed, [], 'without a pid there is no process to bound, so no deadline is armed');
  });

  // Node defers exactly five spawn errnos to an `error` event (EACCES, EAGAIN, EMFILE, ENFILE,
  // ENOENT); every other one is thrown straight out of `spawn` — measured here: EIO — and uncaught
  // it escapes this leaf as a REJECTION. The whole result is pinned, not just the error: a
  // non-start must answer in the same five fields as every other outcome.
  it('a spawn that THROWS settles like one that emits — a named cause, never a rejection', async () => {
    const thrown = Object.assign(new Error('spawn EIO'), { code: 'EIO', errno: -5, syscall: 'spawn' });
    const clock = timerHarness();
    const res = await runProcess('git', ['status'], { spawnImpl: () => { throw thrown; }, ...clock });
    assert.deepEqual(res, { status: null, stdout: '', stderr: '', error: thrown, signal: null });
    assert.equal(res.error, thrown, 'the platform error object reaches the caller, never re-wrapped');
    assert.deepEqual(clock.armed, [], 'no process was created, so no deadline is armed');
  });

  // Red against the alternative the round-1 review prescribed: waiting for `close` after a spawn
  // error. Node documents that close "may or may not" follow error, and no deadline is armed without
  // a pid — so that wait is unbounded in the one leaf that exists to be bounded. Measured live, the
  // close that DOES arrive carries -13: a negative errno, not the exit status of a process that never
  // ran, so surfacing it as `status` would report a fiction.
  it('settles a spawn failure on the error alone, and a LATE close cannot turn an errno into a status', async () => {
    const child = stubChild({ pid: undefined });
    const spawnError = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    const promise = runProcess('git', ['status'], { spawnImpl: spawnHarness(child).spawnImpl, ...timerHarness() });
    child.emit('error', spawnError);
    child.emit('close', -13, null);
    const res = await promise;
    assert.equal(res.status, null);
    assert.equal(res.error, spawnError);
  });

  it('reports a TIMEOUT as a KILLED PROCESS — a signal, not a message — and keeps the partial output', async () => {
    const child = stubChild();
    const clock = timerHarness();
    const killer = killHarness();
    const promise = runProcess('git', ['fetch'], { deadlineMs: 10, escalationMs: 5, spawnImpl: spawnHarness(child).spawnImpl, ...clock, kill: killer.kill });
    child.stdout.emit('data', Buffer.from('remote: counting'));
    clock.armed[0].fn();
    assert.deepEqual(killer.calls, [{ pid: -4242, signal: TERMINATE_SIGNAL }], 'the NEGATIVE pid signals the whole group, not the child alone');
    clock.armed[1].fn();
    assert.deepEqual(killer.calls[1], { pid: -4242, signal: FORCE_SIGNAL }, 'a soft signal that was ignored escalates to one that cannot be');
    assert.equal(clock.armed[1].ms, 5);
    child.emit('close', null, FORCE_SIGNAL);
    const res = await promise;
    assert.equal(res.status, null);
    assert.equal(res.signal, FORCE_SIGNAL, 'the timeout is structurally recognisable: a killed process, never parsed prose');
    assert.equal(res.stdout, 'remote: counting');
    assert.equal(res.error, null);
  });

  // The measured shape a descendant produces: the parent exited 0 long before the deadline, the pipe
  // stayed open, and `close` therefore carries the parent's ORIGINAL (0, null). Reporting that would
  // hand the caller a clean success for a run this leaf cut off, and the consumer's timeout rule
  // (status null AND a signal) would never fire.
  it('reports a run IT terminated as killed, even when close carries the exit code 0', async () => {
    const child = stubChild();
    const clock = timerHarness();
    const promise = runProcess('git', ['fetch'], { deadlineMs: 10, escalationMs: 5, spawnImpl: spawnHarness(child).spawnImpl, ...clock, kill: killHarness().kill });
    child.stdout.emit('data', Buffer.from('parent done\n'));
    clock.armed[0].fn();
    child.emit('close', 0, null);
    const res = await promise;
    assert.equal(res.status, null, 'a run the leaf itself terminated is never reported as a clean exit');
    assert.equal(res.signal, TERMINATE_SIGNAL, 'the signal reported is the one the leaf actually sent');
    assert.equal(res.stdout, 'parent done\n', 'the bytes that did arrive are still reported');
  });

  it('names the ESCALATED signal when the grace window also expired', async () => {
    const child = stubChild();
    const clock = timerHarness();
    const promise = runProcess('git', ['fetch'], { deadlineMs: 10, escalationMs: 5, spawnImpl: spawnHarness(child).spawnImpl, ...clock, kill: killHarness().kill });
    clock.armed[0].fn();
    clock.armed[1].fn();
    child.emit('close', 0, null);
    const res = await promise;
    assert.equal(res.status, null);
    assert.equal(res.signal, FORCE_SIGNAL);
  });
});

// ── the group-kill fallback: a platform without process groups, and an already-gone target ──

describe('git-process — termination degrades honestly when the group cannot be signalled', () => {
  const refuseGroupKill = () => {
    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
  };

  it('signals the child alone when the process GROUP cannot be signalled', async () => {
    const child = stubChild();
    const childSignals = [];
    child.kill = (signal) => {
      childSignals.push(signal);
      return true;
    };
    const clock = timerHarness();
    const promise = runProcess('git', ['fetch'], { deadlineMs: 10, escalationMs: 5, spawnImpl: spawnHarness(child).spawnImpl, ...clock, kill: refuseGroupKill });
    clock.armed[0].fn();
    assert.deepEqual(childSignals, [TERMINATE_SIGNAL], 'a platform with no process groups still gets its child signalled');
    clock.armed[1].fn();
    assert.deepEqual(childSignals, [TERMINATE_SIGNAL, FORCE_SIGNAL], 'and the escalation reaches it too');
    child.emit('close', null, FORCE_SIGNAL);
    assert.equal((await promise).signal, FORCE_SIGNAL);
  });

  // A run nothing could be signalled is NOT a killed run. The deadline firing is not the fact that
  // matters — DELIVERY is. If the process had already exited on its own, reporting a timeout would
  // stop a release over a fetch that actually succeeded, which is the round-1 blocker inverted.
  it('reports the TRUTH when the kill was never delivered — an already-exited process is not a timeout', async () => {
    const child = stubChild();
    child.kill = () => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    };
    const clock = timerHarness();
    const promise = runProcess('git', ['fetch'], { deadlineMs: 10, escalationMs: 5, spawnImpl: spawnHarness(child).spawnImpl, ...clock, kill: refuseGroupKill });
    clock.armed[0].fn();
    child.emit('close', 0, null);
    const res = await promise;
    assert.equal(res.error, null, 'an ESRCH from our own kill attempt is a race, never the run\'s error');
    assert.equal(res.status, 0, 'nothing was signalled, so the process really did exit 0 on its own');
    assert.equal(res.signal, null, 'naming a signal here would be a fiction about a process we never touched');
  });

  // Measured live: `child.kill()` on an already-exited child RETURNS FALSE, it does not throw, while
  // `process.kill(-pid, …)` on a dead group DOES throw ESRCH. The two failure shapes differ, so a
  // try/catch alone would read a false as delivery and re-introduce the fiction one layer down.
  it('reads a FALSE return from child.kill as "nothing was signalled", not as success', async () => {
    const child = stubChild();
    child.kill = () => false;
    const clock = timerHarness();
    const promise = runProcess('git', ['fetch'], { deadlineMs: 10, escalationMs: 5, spawnImpl: spawnHarness(child).spawnImpl, ...clock, kill: refuseGroupKill });
    clock.armed[0].fn();
    child.emit('close', 0, null);
    const res = await promise;
    assert.equal(res.status, 0);
    assert.equal(res.signal, null);
  });
});

// ── the timers are disarmed, so this leaf never signals a pid it no longer owns ────────

describe('git-process — the deadline is disarmed once the run is over', () => {
  it('cancels the armed deadline on a normal close', async () => {
    const child = stubChild();
    const clock = timerHarness();
    const promise = runProcess('git', ['status'], { spawnImpl: spawnHarness(child).spawnImpl, ...clock });
    child.emit('close', 0, null);
    await promise;
    assert.deepEqual(clock.cleared, [clock.armed[0]], 'a deadline left armed would fire against a pid the OS may have reused');
  });

  it('cancels the FORCE timer when the process closes during the grace window', async () => {
    const child = stubChild();
    const clock = timerHarness();
    const killer = killHarness();
    const promise = runProcess('git', ['fetch'], { deadlineMs: 10, escalationMs: 5, spawnImpl: spawnHarness(child).spawnImpl, ...clock, kill: killer.kill });
    clock.armed[0].fn();
    child.emit('close', null, TERMINATE_SIGNAL);
    await promise;
    assert.deepEqual(clock.cleared, [clock.armed[0], clock.armed[1]], 'the pending SIGKILL must be cancelled the moment the child is gone');
    assert.deepEqual(killer.calls, [{ pid: -4242, signal: TERMINATE_SIGNAL }], 'and it must never actually be sent');
  });
});

// ── Decision 7 acceptance: a REAL hanging process, really reaped ───────────────────────

const IGNORES_SIGTERM = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";

// The parent ignores SIGTERM AND leaves a descendant holding the stdout pipe — the exact shape a
// `git fetch` over ssh can produce, and the one a soft signal to the child alone would not end.
const HOLDS_THE_PIPE = [
  "const { spawn } = require('child_process');",
  `const kid = spawn(process.execPath, ['-e', ${JSON.stringify(IGNORES_SIGTERM)}], { stdio: ['ignore', 'inherit', 'inherit'] });`,
  "process.stdout.write(String(kid.pid) + '\\n');",
  IGNORES_SIGTERM,
].join('\n');

// The blocker's real shape: the parent finishes and exits 0 IMMEDIATELY, but the descendant it left
// behind inherits the stdout pipe and ignores SIGTERM, so `close` is delayed past the deadline and
// then arrives carrying the parent's own successful exit.
const PARENT_EXITS_ZERO_DESCENDANT_HOLDS_PIPE = [
  "const { spawn } = require('child_process');",
  `spawn(process.execPath, ['-e', ${JSON.stringify(IGNORES_SIGTERM)}], { stdio: ['ignore', 'inherit', 'inherit'] });`,
  "process.stdout.write('parent done\\n');",
  'process.exit(0);',
].join('\n');

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitUntilGone = async (pid, budgetMs = 5_000) => {
  const giveUpAt = Date.now() + budgetMs;
  while (Date.now() < giveUpAt) {
    if (!isAlive(pid)) return true;
    await new Promise((settle) => setTimeout(settle, 25));
  }
  return false;
};

const recordingSpawn = (spawned) => (command, args, options) => {
  const child = spawn(command, args, options);
  spawned.push(child);
  return child;
};

describe('git-process — a real hanging child is actually reaped, not merely signalled', () => {
  it('ends a REAL process that ignores SIGTERM, and the promise resolves', async () => {
    const spawned = [];
    const res = await runProcess(process.execPath, ['-e', IGNORES_SIGTERM], { deadlineMs: 250, escalationMs: 250, spawnImpl: recordingSpawn(spawned) });
    assert.equal(res.status, null);
    assert.equal(res.signal, FORCE_SIGNAL, 'SIGTERM was ignored, so the escalation is what ended it');
    assert.equal(await waitUntilGone(spawned[0].pid), true, 'the child must be GONE — a deadline that only signals proves nothing about hanging');
  });

  it('ends a real DESCENDANT that ignores SIGTERM and holds the stdout pipe open', async () => {
    const spawned = [];
    const res = await runProcess(process.execPath, ['-e', HOLDS_THE_PIPE], { deadlineMs: 500, escalationMs: 250, spawnImpl: recordingSpawn(spawned) });
    const descendantPid = Number(res.stdout.trim());
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0, `the descendant pid must have been captured, got ${JSON.stringify(res.stdout)}`);
    assert.equal(await waitUntilGone(descendantPid), true, 'the DESCENDANT must be reaped too — signalling the child alone would leave it running and the pipe open');
    assert.equal(await waitUntilGone(spawned[0].pid), true);
  });

  it('reports a REAL run whose parent exited 0 while a descendant held the pipe as KILLED, not as success', async () => {
    const spawned = [];
    const res = await runProcess(process.execPath, ['-e', PARENT_EXITS_ZERO_DESCENDANT_HOLDS_PIPE], { deadlineMs: 400, escalationMs: 250, spawnImpl: recordingSpawn(spawned) });
    assert.equal(res.stdout, 'parent done\n', 'the parent really did finish and really did write');
    assert.equal(res.status, null, "measured: close carries the parent's original (0, null) — reporting that is a clean success for a run we cut off");
    assert.ok([TERMINATE_SIGNAL, FORCE_SIGNAL].includes(res.signal), `a kill signal must be named, got ${JSON.stringify(res.signal)}`);
    assert.equal(await waitUntilGone(spawned[0].pid), true);
  });

  it('runs real git and returns its real result, unclassified', async () => {
    const res = await runGitProcess(['--version']);
    assert.equal(res.status, 0);
    assert.equal(res.signal, null);
    assert.equal(res.error, null);
    assert.match(res.stdout, /^git version /);
  });
});
