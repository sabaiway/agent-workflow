#!/usr/bin/env node
// preflight-remote.mjs — the release procedure's FIRST question: does this branch still reach the
// remote it is about to publish from?
//
// WHY IT IS FIRST. The AD-098 release was built in full — ADR, three version bumps, changelogs, a
// two-backend council, a 15/15 final gate matrix — and only then was the push rejected as
// non-fast-forward. Measured at that moment: `git rev-list --left-right --count origin/main...HEAD`
// = 292 / 300. Nothing in the flow looked at push-ability until the push itself, and the dispatcher's
// own late preflight called EVERY mismatch "the approved release commit must be pushed first" —
// wrong guidance on a diverged branch, where no plain fast-forward push can succeed. That refusal
// now classifies what it observed and points here; this script still exists because the
// dispatcher's check comes only after the whole release has been built and paid for.
//
// WHAT A PASS MEANS, EXACTLY. No remote-only commits existed on the checked ref AT CHECK TIME. It is
// NOT push permission, NOT a statement about branch protection, and NOT proof against a race with
// another pusher. And it is only claimable over a COMPLETE history: a shallow clone is refused
// before the fetch, because counts taken across a truncated graph can invent remote-only commits
// and this script's divergence arm prints a force-push. And this run is NOT read-only: `git fetch` MAY write objects (it writes none when the
// fetched tip is already present locally) and DOES write one temporary ref into the local store. It
// makes no REMOTE mutation and no working-tree change; that is the honest claim, and the fetch is
// narrowed (`--no-tags --no-recurse-submodules --no-write-fetch-head`) so the claim is exactly true
// rather than approximately so.
//
// IT NEVER REMEDIES. It states facts and names remedies; it never chooses or runs one.
//
// LAYOUT. The pre-network guards live in `preflight-remote-guards.mjs`, their shared primitives in
// `preflight-remote-core.mjs`, and the credential-redaction rule in `preflight-remote-sanitize.mjs`.
// Five review rounds grew this file past the 400-line cap; the guards were the block that had grown
// most, and the redaction rule is the one that churned hardest, so each earned its own unit of review.
//
//   node scripts/release/preflight-remote.mjs [--ref <branch>]
//
// Exit codes: 0 ok · 2 usage · 3 refusal (fail-closed) · 9 inconclusive.
// Exit 9 means the fetch was KILLED BY A SIGNAL, so nothing was verified. The cause is deliberately
// NOT claimed: this run's own deadline and an external kill are indistinguishable in the process
// result, so naming either would be a fiction. Inconclusive is not a pass — it STOPS the procedure.
// Dependency-free, Node >= 22. No side effects on import.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runGitProcess } from './git-process.mjs';
import { EXIT, REMOTE, DEFAULT_REF, fail, firstLine } from './preflight-remote-core.mjs';
import { sanitize } from './preflight-remote-sanitize.mjs';
import { assertShortBranchName, assertPushTargetsDestination, assertCompleteHistory } from './preflight-remote-guards.mjs';

// The fetch lands HERE, not in FETCH_HEAD: a shared FETCH_HEAD can be overwritten by a concurrent
// fetch between two commands, so the count would silently read another run's OID.
const PREFLIGHT_REF_NAMESPACE = 'refs/aw-preflight';

// Re-exported so the CLI's contract has one import surface, and so a consumer never has to know which
// module a primitive was lifted into when the caps forced the split.
export {
  EXIT, REMOTE, DEFAULT_REF, fail, sanitize,
  assertShortBranchName, assertPushTargetsDestination, assertCompleteHistory,
};

export const HELP = `preflight-remote — can this branch still reach ${REMOTE}?

  node scripts/release/preflight-remote.mjs [--ref <branch>]

  --ref <branch>  the short branch name to check (default ${DEFAULT_REF}); must match the ref the
                  release will dispatch with. A full ref, a tag, or a name carrying a
                  shell-significant byte is refused.
  --help          this text.

Fetches ${REMOTE}/<branch> and counts the divergence against HEAD. A PASS means no remote-only
commits existed on that ref at check time — NOT push permission, NOT branch protection, NOT
protection against a race. May write objects and does write one temporary ref locally; mutates nothing
remote and nothing in the working tree. Never pulls, rebases or pushes: it names remedies, never runs one.

Exit: 0 ok · 2 usage · 3 refusal · 9 inconclusive (the fetch was killed by a signal, so nothing was
verified — this STOPS the release, it is not a pass).`;

export const parseArgs = (argv) => {
  const opts = { ref: DEFAULT_REF, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--ref') {
      i += 1;
      if (argv[i] === undefined) throw fail(EXIT.usage, '--ref requires a branch-name argument');
      opts.ref = argv[i];
    } else {
      throw fail(EXIT.usage, `unknown argument "${arg}" — see --help`);
    }
  }
  return opts;
};

export const preflightRefFor = ({ pid, nonce }) => `${PREFLIGHT_REF_NAMESPACE}/${pid}-${nonce}`;

// The ONE network act, narrowed to exactly the declared surface: no tag auto-follow, no submodule
// recursion however the repo is configured, and no FETCH_HEAD write. Addressing refs/heads/<ref>
// explicitly is what settles the branch/tag ambiguity a bare `git fetch origin <ref>` leaves open when
// a branch and a tag share a name. Passing a tracking-ref STRING here would be a defect: probed,
// `git fetch origin/main` gives "fatal: 'origin/main' does not appear to be a git repository", exit 128.
export const fetchDestination = async (ref, landingRef, runGit) => {
  const res = await runGit([
    'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head',
    REMOTE, `+refs/heads/${ref}:${landingRef}`,
  ]);
  // A process killed by a signal is reported as INCONCLUSIVE, and the CAUSE is deliberately not named:
  // this run's own deadline and an external kill produce the identical process result, so "timed out"
  // or "unreachable" would be a claim the run cannot support. Every other non-zero fetch is a
  // fail-closed 3 carrying git's own stderr verbatim — git returns the SAME exit status for transport,
  // auth and a missing ref, so any taxonomy here would rest on parsing prose that drifts with each git
  // release. The operator gets the real message instead of our guess at a category.
  if (res.status === null && res.signal !== null) {
    throw fail(
      EXIT.inconclusive,
      `git fetch ${REMOTE} ${ref} was killed by a signal (${res.signal}) — nothing about the divergence was verified.\n`
        + '  INCONCLUSIVE, not a pass. Re-run this check; if it keeps ending this way, run it where the\n'
        + '  fetch can complete.',
    );
  }
  if (res.error) {
    throw fail(EXIT.refusal, `git fetch ${REMOTE} ${ref} could not run (${res.error.code ?? res.error.message}) — refusing fail-closed`);
  }
  if (res.status !== 0) {
    throw fail(EXIT.refusal, `git fetch ${REMOTE} ${ref} failed (exit ${res.status}) — refusing fail-closed. git said (verbatim except credential redaction):\n${res.stderr.trim()}`);
  }
};

export const readFetchedOid = async (landingRef, runGit) => {
  const res = await runGit(['rev-parse', landingRef]);
  if (res.status !== 0 || res.stdout.trim() === '') {
    throw fail(EXIT.refusal, `the fetched ref ${landingRef} could not be read back (exit ${res.status}) — refusing fail-closed`);
  }
  return res.stdout.trim();
};

// Counted against the OID THIS run fetched, never a remote-tracking ref: `git fetch <remote> <branch>`
// updates the tracking ref only opportunistically (probed: it does with a configured refspec, does not
// without one), so reading it afterwards can read a stale value.
//
// The separator is a TAB and nothing else. A looser `\s+` would accept a NEWLINE, so malformed output
// like "0\n4\n" would parse as behind 0 and produce a false PASS — measured, the real shape is "0\t0\n".
export const countDivergence = async (landingRef, runGit) => {
  const res = await runGit(['rev-list', '--left-right', '--count', `${landingRef}...HEAD`]);
  if (res.status !== 0) {
    throw fail(EXIT.refusal, `git rev-list --left-right --count failed (exit ${res.status}) — refusing fail-closed. git said (verbatim except credential redaction):\n${res.stderr.trim()}`);
  }
  const counts = /^(\d+)\t(\d+)$/.exec(res.stdout.replace(/\n$/, ''));
  if (counts === null) {
    throw fail(
      EXIT.refusal,
      `git rev-list --left-right --count returned output this run cannot parse: ${JSON.stringify(res.stdout)} — refusing fail-closed rather than counting a guess`,
    );
  }
  return { behind: Number(counts[1]), ahead: Number(counts[2]) };
};

// EVERY printed command is fully bound to what this run verified — no bare forms. This is a safety
// invariant, not a style rule:
//   • a bare `git pull --ff-only` resolves through the UPSTREAM, which this run deliberately does not
//     verify, and which does not resolve at all in the refspec-less case — so the catch-up lane is
//     expressed against the fetched OID instead;
//   • a bare `git push --force-with-lease=<ref>:<oid>` pins the lease but NOT the destination: under
//     push.default=matching a bare push can update other branches even though the @{push} guard
//     passed for this one. So remote and refspec are both bound explicitly.
// Precise about what is GUARANTEED: the ref write always happens, while the object write does not when
// the fetched tip is already present locally.
const NOTHING_RAN = 'No remedy was run. The fetch may have written local objects and did write one temporary ref; nothing remote and nothing in the working tree changed.';

export const renderTopology = ({ ref, oid, behind, ahead }) => {
  const counts = `behind ${behind}, ahead ${ahead}`;
  if (behind === 0) {
    return {
      exitCode: EXIT.ok,
      message: `PASS — no remote-only commits on ${REMOTE}/${ref} at check time (${counts}, fetched ${oid}).\n`
        + '  This is not push permission and not protection against a race: it says only that nothing\n'
        + '  on the remote was missing locally when the fetch ran.',
    };
  }
  const catchUp = `git merge --ff-only ${oid}`;
  if (ahead === 0) {
    return {
      exitCode: EXIT.refusal,
      message: `REFUSED — ${REMOTE}/${ref} carries ${behind} commit(s) this branch does not have (${counts}, fetched ${oid}).\n`
        + `  The branch can still fast-forward. Catch up, then re-run this check:\n    ${catchUp}\n`
        + `  ${NOTHING_RAN}`,
    };
  }
  // Only ONE of the two lanes gets a printed command here. A fast-forward is impossible by definition
  // on a divergence, so `merge --ff-only` would be a command guaranteed to refuse — printing one that
  // cannot work is worse than printing none, because it also discredits the command beside it. What
  // must happen to the local commits (replay them, or discard them) is exactly the decision this script
  // does not make.
  const forcePush = `git push --force-with-lease=refs/heads/${ref}:${oid} ${REMOTE} HEAD:refs/heads/${ref}`;
  return {
    exitCode: EXIT.refusal,
    message: `REFUSED — ${REMOTE}/${ref} and this branch have DIVERGED (${counts}, fetched ${oid}).\n`
      + '  A plain push cannot succeed, and no automatic remedy is correct here. The choice is the\n'
      + '  maintainer\'s, and only one of the two lanes has a command this run can safely name:\n'
      + `    replace the remote history with this one:\n      ${forcePush}\n`
      + '    take the remote history instead: no command is printed. A fast-forward is impossible here by\n'
      + `      definition, so what happens to the ${ahead} local commit(s) — replayed onto ${oid}, or\n`
      + '      discarded — is the decision, and it is yours to make.\n'
      + '  The lease is pinned to the OID this run fetched, and the refspec is bound so no other branch\n'
      + '  can be updated. Old release tags are not rewritten by either lane, so published tarballs and\n'
      + '  Releases stay intact.\n'
      + `  ${NOTHING_RAN}`,
  };
};

export const main = async (argv, deps = {}) => {
  const runGit = deps.runGit ?? ((args) => runGitProcess(args));
  // The ONE redaction boundary: every line this run emits — a verdict, a guard refusal, git's stderr,
  // the final err.message — passes through sanitize() here, so no path can bypass it by omission.
  const writeOut = deps.log ?? ((line) => process.stdout.write(`${line}\n`));
  const writeErr = deps.logError ?? ((line) => process.stderr.write(`${line}\n`));
  const log = (line) => writeOut(sanitize(line));
  const logError = (line) => writeErr(sanitize(line));
  const landingRef = preflightRefFor({
    pid: deps.pid ?? process.pid,
    nonce: deps.nonce ?? process.hrtime.bigint().toString(36),
  });
  try {
    const opts = parseArgs(argv);
    // --help exits 0, matching dispatch-publish and flow-check; exit 2 is for usage ERRORS only.
    if (opts.help) {
      log(HELP);
      return EXIT.ok;
    }
    await assertShortBranchName(opts.ref, runGit);
    await assertPushTargetsDestination(opts.ref, runGit);
    // Before the network act: a truncated history makes every later count unsafe to print.
    await assertCompleteHistory(runGit);
    try {
      await fetchDestination(opts.ref, landingRef, runGit);
      const oid = await readFetchedOid(landingRef, runGit);
      const { behind, ahead } = await countDivergence(landingRef, runGit);
      const verdict = renderTopology({ ref: opts.ref, oid, behind, ahead });
      if (verdict.exitCode === EXIT.ok) log(verdict.message);
      else logError(verdict.message);
      return verdict.exitCode;
    } finally {
      // Best effort for the VERDICT — the divergence answer is already computed, so a failed delete must
      // not change it — but never SILENT. Nothing else will remove this ref: the next run's landing ref
      // carries a different pid and nonce, so it cannot reclaim this one.
      const cleaned = await runGit(['update-ref', '-d', landingRef]);
      if (cleaned.status !== 0) {
        // Careful with the claim: a failed delete does NOT prove the ref exists — when the fetch never
        // ran there was nothing to remove. And git's own reason is shown, because it is what explains
        // whether the printed command would fail the same way.
        logError(
          `[preflight-remote] warning: removal of the temporary ref ${landingRef} could not be confirmed`
            + ` (exit ${cleaned.status}, signal ${cleaned.signal}, ${cleaned.error?.code ?? 'no error'}) — the ref may remain.\n`
            + `  git said: ${firstLine(cleaned.stderr) || '(nothing)'}\n`
            + `  Remove it, if it is there, with:\n    git update-ref -d ${landingRef}`,
        );
      }
    }
  } catch (err) {
    logError(`[preflight-remote] ${err.message}`);
    return err.exitCode ?? 1;
  }
};

// The CLI edge is one exported call, so it is reachable by a test: an entry block whose BODY spans
// several lines is unreachable from an in-process test suite and lands as uncovered changed lines.
export const runCli = (argv, deps) => main(argv, deps).then((code) => {
  process.exitCode = code;
});

// Run main() only when executed directly, never on import. Compare by REAL path: an entry point
// reached through a symlink resolves to its target, so a raw string compare reads the two as
// different and the CLI never runs. realpathSync collapses the link so both sides match.
const isDirectRun = (() => {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isDirectRun) runCli(process.argv.slice(2));
