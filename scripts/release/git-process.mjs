// git-process.mjs — the LOSSLESS process leaf the release scripts' git reads run through.
//
// It returns the raw outcome of a child process — {status, stdout, stderr, error, signal,
// killedByDeadline} — and nothing else: no throwing on a non-zero exit, no classification, no CLI, no side effects on
// import. Which exit status MEANS what is the caller's policy and must never be decided here:
// `git merge-base --is-ancestor` and `git rev-parse --verify` both use exit 1 as a normal ANSWER,
// while dispatch-publish.mjs's own runGit treats any non-zero as fatal. A shared classifier would
// have to know which of those a given call is — so the shared surface stops at the process result.
//
// Dependency-free, Node >= 22. Every side effect is injectable.

import { spawn } from 'node:child_process';

// The one deadline every process this leaf runs is bound by, in MILLISECONDS. Same order as the
// sibling transport deadline in dispatch-publish.mjs (VERIFY_TRANSPORT_DEADLINE_MS): a network git
// call and a gh call are the same kind of wait.
export const PROCESS_DEADLINE_MS = 30_000;

// "Cannot hang" is an OBLIGATION, not a claim. A deadline that merely signals does not end a
// process that ignores the signal, and a soft signal need not reach descendants — a `git fetch`
// spawns git-remote-https or ssh, and a descendant holding the stdout pipe keeps the parent's
// `close` from ever arriving. So termination escalates: SIGTERM to the whole process group, this
// grace window, then SIGKILL, which cannot be ignored or inherited away.
export const KILL_ESCALATION_MS = 2_000;

export const TERMINATE_SIGNAL = 'SIGTERM';
export const FORCE_SIGNAL = 'SIGKILL';

// The run can neither prompt nor hang. GIT_TERMINAL_PROMPT=0 alone is insufficient — it disables
// neither an askpass helper nor an SSH password prompt — so all four are pinned, and runGitProcess
// pins them LAST so a caller's own env can never unset one.
export const NON_INTERACTIVE_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
});

export const GIT_COMMAND = 'git';

// detached:true makes the child a process-group leader, so a negative pid reaches every descendant.
// Where a platform has no process groups the child alone is signalled.
//
// RETURNS WHETHER THE SIGNAL WAS ACTUALLY DELIVERED, and the caller may only claim a kill on a true:
// an already-exited target is an ordinary race, and calling it a kill would report a timeout for a run
// that finished on its own. The two failure shapes differ and both must be read — measured live,
// `process.kill(-pid, …)` on a dead group THROWS ESRCH while `child.kill()` on an exited child
// RETURNS FALSE, so a try/catch alone would read that false as success.
const killProcessTree = (child, signal, kill) => {
  try {
    kill(-child.pid, signal);
    return true;
  } catch {
    try {
      return child.kill(signal) !== false;
    } catch {
      return false;
    }
  }
};

export const runProcess = (command, args, {
  cwd,
  env = process.env,
  extraEnv = {},
  deadlineMs = PROCESS_DEADLINE_MS,
  escalationMs = KILL_ESCALATION_MS,
  encoding = 'utf8',
  spawnImpl = spawn,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  kill = (pid, signal) => process.kill(pid, signal),
} = {}) => new Promise((resolve) => {
  const stdoutChunks = [];
  const stderrChunks = [];
  const state = { settled: false, deadlineTimer: null, forceTimer: null, exit: null, error: null, killSignal: null };

  const disarm = () => {
    if (state.deadlineTimer !== null) clearTimer(state.deadlineTimer);
    if (state.forceTimer !== null) clearTimer(state.forceTimer);
    state.deadlineTimer = null;
    state.forceTimer = null;
  };

  // Everything observed is reported, including a partial stdout captured before a kill: the caller
  // decides what a killed run means, and it cannot decide over data this leaf discarded.
  //
  // A run THIS LEAF terminated is reported as killed, whatever the process happened to exit with.
  // Measured: when a descendant delays the drain past the deadline, `close` carries the parent's
  // ORIGINAL (0, null) — so reporting close verbatim would hand the caller a clean success for a run
  // we cut off, and the caller's only structural timeout signal (`killedByDeadline`, true only when
  // this leaf's deadline delivered the kill — an external signal is not one) would never fire. The
  // parent's exit code is deliberately given up in that case: the result carries six fields, and a
  // killed run being recognisable as killed is the one that matters.
  const settle = () => {
    if (state.settled) return;
    state.settled = true;
    disarm();
    const killed = state.killSignal !== null;
    const decode = (chunks) => (encoding === null ? Buffer.concat(chunks) : Buffer.concat(chunks).toString(encoding));
    resolve({
      status: killed || state.exit === null ? null : state.exit.code,
      stdout: decode(stdoutChunks),
      stderr: decode(stderrChunks),
      error: state.error,
      signal: killed ? state.killSignal : (state.exit === null ? null : state.exit.signal),
      killedByDeadline: killed,
    });
  };

  // stdin is never inherited: a child that cannot reach the terminal cannot prompt on it, whatever
  // its own environment says.
  //
  // Node DEFERS exactly five spawn errnos to an `error` event — EACCES, EAGAIN, EMFILE, ENFILE,
  // ENOENT (measured in node v24, internal/child_process); every OTHER errno is thrown straight out
  // of `spawn`, EIO among them. The two forms even read differently: the deferred one builds its
  // message as `'spawn ' + spawnfile` and sets `err.path`, the thrown one builds plain `'spawn'`.
  // Uncaught, such a throw leaves this leaf as a REJECTED promise — the one shape the contract has
  // no room for, since every caller reads the outcome out of `error`. A synchronous throw states the
  // same fact as the deferred event, that no process was created, so it settles through the same path.
  let child;
  try {
    child = spawnImpl(command, args, {
      cwd,
      env: { ...env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (err) {
    state.error = err;
    settle();
    return;
  }

  child.stdout?.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr?.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));

  // `close` (not `exit`) is the settle signal, so stdout captured up to the last byte is in the
  // result. The deadline covers the drain as well as the run — a descendant holding the pipe open
  // after its parent exited is killed by the same escalation.
  child.on('close', (code, signal) => {
    state.exit = { code, signal };
    settle();
  });

  // A spawn that never produced a process (ENOENT, EACCES) settles HERE, on the error alone. Node
  // documents `close` after `error` as OPTIONAL ("may or may not fire"), and with no pid no deadline
  // is armed — so waiting for it would be an unbounded wait in the one leaf that exists to be
  // bounded. The `close` that does arrive carries a negative errno (measured: -13), which is not the
  // exit status of a process that never ran. A spawn that DID start keeps its close path, so its
  // error and its exit are both reported.
  child.on('error', (err) => {
    state.error = err;
    if (!child.pid) settle();
  });

  if (deadlineMs > 0 && child.pid) {
    state.deadlineTimer = setTimer(() => {
      if (killProcessTree(child, TERMINATE_SIGNAL, kill)) state.killSignal = TERMINATE_SIGNAL;
      state.forceTimer = setTimer(() => {
        if (killProcessTree(child, FORCE_SIGNAL, kill)) state.killSignal = FORCE_SIGNAL;
      }, escalationMs);
    }, deadlineMs);
  }
});

// git under the non-interactive environment, pinned LAST so no caller env can unset one of the four.
export const runGitProcess = (args, options = {}) => runProcess(GIT_COMMAND, args, {
  ...options,
  extraEnv: { ...(options.extraEnv ?? {}), ...NON_INTERACTIVE_ENV },
});
