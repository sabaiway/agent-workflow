// review-state-await.mjs — the --timeout grammar and the poll loop.

import { detectBackends } from './detect-backends.mjs';
import { fail } from './orchestration-config.mjs';
import { decideCheck } from './review-state-judge.mjs';
import { buildState } from './review-state-build.mjs';

// --await (BUGFREE-3 / AD-049, item (d)) bounds + poll cadence. The default timeout is generous —
// a real grounded bridge review can take minutes — and every value is overridable (--timeout / the
// injectable clock) so hermetic tests never spend wall-clock.
export const DEFAULT_AWAIT_TIMEOUT_S = 900;
export const AWAIT_POLL_MS = 5000;

// ── --await: block until the configured review obligations are SATISFIED ───────────────
// It waits until `--check` would pass: under `reviewed`, a ship-class attestation from any
// review-capable backend; under `council`, every configured backend ship-class OR carrying a
// current-tree degrade RECORD in the core-evidence store (never all backends) — once such a
// record lands, --await stops waiting for that backend and returns READY (before, it waited
// forever for a receipt that never comes). It inherits everything for FREE — it polls the SAME
// decideCheck(buildState()) `--check` computes. The completion signal is the RECEIPT/RECORD
// (i.e. `--check` would PASS), NEVER a process event — a harness "completed" notification fires
// early and a bridge's output late-flushes, so polling state is the durable mechanization of
// receipts-not-pgrep. Stays read-only (it only re-reads state — now the evidence store too, a
// few KB per tick); the clock is injectable (ctx.now / ctx.sleep / ctx.pollMs) so hermetic tests
// never spend wall-clock.

const AWAIT_ALLOWED_ARGS = new Set(['--await', '--timeout']);

const parseAwaitTimeoutS = (argv) => {
  const i = argv.indexOf('--timeout');
  if (i === -1) return DEFAULT_AWAIT_TIMEOUT_S;
  const raw = argv[i + 1];
  if (!raw || !/^\d+$/.test(raw) || Number(raw) < 1) throw fail(2, '--timeout requires a positive integer number of seconds');
  return Number(raw);
};

export const mainAwait = async (argv, ctx = {}) => {
  const cwd = ctx.cwd ?? process.cwd();
  const env = ctx.env ?? process.env;
  const detect = ctx.detect ?? detectBackends;
  const now = ctx.now ?? (() => Date.now());
  const sleep = ctx.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollMs = ctx.pollMs ?? AWAIT_POLL_MS;
  const build = ctx.buildState ?? buildState;
  try {
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '--timeout') { i += 1; continue; } // its value is consumed by parseAwaitTimeoutS
      if (!AWAIT_ALLOWED_ARGS.has(a)) throw fail(2, `--await accepts only --timeout <s> (got ${a})`);
    }
    const timeoutS = parseAwaitTimeoutS(argv);
    const timeoutMs = timeoutS * 1000;
    const start = now();
    // Poll the SAME normative decision --check computes: ready == `--check` would pass (solo / no
    // plan / a clean tree / not-a-git-tree all resolve instantly — nothing to await). Re-read state
    // every poll so a landed receipt (or a tree edit that re-staled one) is seen fresh. The DEADLINE
    // is checked BEFORE readiness (codex council R2): once elapsed reaches the timeout the await is
    // over, so a receipt that only lands AT/after the deadline never flips it to READY; and each
    // sleep is BOUNDED to the remaining time so a full poll interval can never overshoot the timeout.
    let lastReason = 'no poll completed before the deadline';
    for (;;) {
      const elapsed = now() - start;
      if (elapsed >= timeoutMs) return { code: 1, stdout: '', stderr: `review-state --await: TIMEOUT after ${timeoutS}s — ${lastReason}` };
      const check = decideCheck(build({ cwd, env, detect }));
      lastReason = check.reason;
      if (check.code === 0) return { code: 0, stdout: `review-state --await: READY — ${check.reason}`, stderr: '' };
      if (check.heldSession === true) return { code: 1, stdout: '', stderr: `review-state --await: HELD SESSION — ${check.reason}` };
      // Decision 4 (#50): an AUTHORITATIVE veto ends the wait loudly BEFORE the deadline — the
      // dispatched review answered with a landed negative; classifying that as a timeout was the
      // misclassification this amendment closes. Only a fresh review can move it, never waiting.
      if (check.veto === true) return { code: 1, stdout: '', stderr: `review-state --await: VETO — ${check.reason}` };
      await sleep(Math.min(pollMs, timeoutMs - elapsed));
    }
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `review-state: ${err.message}` };
  }
};
