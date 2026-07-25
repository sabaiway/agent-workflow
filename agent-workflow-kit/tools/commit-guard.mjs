#!/usr/bin/env node
// commit-guard.mjs — the read-only pre-commit guard (strip-the-kit 2.5, D10). It re-runs NO
// gate/test subprocess: the heavy D3(b)/(c)/(d) verification lives in `run-gates --final`, whose
// receipt this guard binds. `--check`:
//   0. refuses an INDEX that lags the verified working tree — FIRST, before the fingerprint is
//      computed. The gates and the fingerprint describe the WORKING tree while `git commit` builds
//      the commit from the INDEX alone, and the fingerprint domain is identical either way, so
//      without this arm a lagging index ships a strict SUBSET of what was verified. Refuses on
//      tracked paths differing index↔worktree or reviewable untracked-not-ignored paths (the same
//      never-committable filter the fingerprint applies; ignored paths never refuse), naming them
//      up to INDEX_LAG_PATH_CAP with the remainder stated. A dirty tracked SUBMODULE is named
//      separately with its own recovery. Fail-closed on an undecidable probe. This BLOCKS the
//      deliberate partial commit by design — `--no-verify` is the stated residual, not a flag;
//   1. recomputes the CURRENT tree fingerprint (the review-state export — read-only git plumbing);
//   2. reads the LATEST completed final-run record from the core-evidence store (only the latest
//      attempt at a fingerprint is authoritative — a green receipt is DEAD once a later attempt at
//      the same fingerprint went red) and refuses on: no record for the current fingerprint · a
//      red record · fingerprintBefore ≠ fingerprintAfter · a LATER final-start with no completion
//      (an attempt of unknown outcome) · a DECLARATION whose current {id, cmd} content differs
//      from the recorded one · evidence hashes that no longer match the store's canonical
//      red-proof/degrade serializations · an lcov file whose sha moved. The guard's own reads
//      resolve FIXED git-dir paths (env overrides are producer test seams, never guard inputs);
//   3. re-computes the review-state decision (the ship-receipt arm) — a missing/vetoed ship
//      receipt refuses.
// `git commit --no-verify` stays the stated residual (a self-discipline mechanism, not a security
// boundary). Read-only; dependency-free; Node >= 22. No side effects on import.

import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { computeTreeFingerprint, buildState, decideCheck, quoteReportName, shellQuoteArg } from './review-state.mjs';
import { resolveEvidencePath, readEvidence, authoritativeOfKind, canonicalKindSerialization, computeWorkingState } from './core-evidence.mjs';
import { resolveLcovPath } from './coverage-check.mjs';
import { GATES_REL, loadDeclaration } from './run-gates.mjs';

const usageFail = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { exitCode: 2 });
const sha = (text) => createHash('sha256').update(text).digest('hex');

const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const gitLine = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout.toString('utf8').replace(/\r?\n$/, '');
};

// resolveGitHooksPath(projectDir) → the ABSOLUTE hooks dir git itself reports (a linked worktree
// answers with ITS OWN hooks path — never a hardcoded `.git/hooks`), or null outside a git tree.
// The one home consumers (the recommendations guard-install probe) read instead of re-deriving it.
export const resolveGitHooksPath = (projectDir) => {
  const line = gitLine(['rev-parse', '--git-path', 'hooks'], projectDir);
  return line == null ? null : resolve(projectDir, line);
};

// How many offending paths the index-lag refusal names before it states a remainder count: enough
// to act on, bounded so a wide lag cannot bury a pre-commit hook's output.
export const INDEX_LAG_PATH_CAP = 10;

// The recovery must name the run-gates the CONSUMER actually has. A repo-relative literal is only
// correct inside this monorepo; every installed deployment keeps the tool beside this file. Shell-
// quoted, because an install path carrying a space or a metacharacter would otherwise render an
// instruction that is unrunnable at best and dangerous to paste at worst.
const FINAL_RUN_TOOL = shellQuoteArg(fileURLToPath(new URL('./run-gates.mjs', import.meta.url)));

// ONE budget across every named category — a per-category cap would print 2× the stated number.
const renderBudgeted = (paths, budget) => ({
  text: paths.slice(0, Math.max(budget, 0)).map(quoteReportName).join(', '),
  used: Math.min(paths.length, Math.max(budget, 0)),
});

// The ONE ordered recovery plan — text and executable `argv` built from the SAME structure, so a
// test can run exactly what the operator is shown instead of reconstructing its own commands.
// Order matters: the submodule step first (staging and re-running --final before it would stale the
// fresh receipt at once), then the index bits, because `git add -A` CANNOT restage a skip-worktree
// or assume-unchanged entry — printing it alone is a recovery that silently does nothing. The two
// bits get SEPARATE commands: one `update-index` invocation carrying both flags applies only one.
// The text points at `git ls-files -v` rather than pasting names — the displayed list is capped,
// and a name safe to display is not automatically safe to paste into a shell.
export const buildIndexLagRecovery = (state) => {
  const flags = state.flaggedPaths ?? [];
  const steps = [];
  if (state.unstagedSubmodulePaths.length > 0) {
    steps.push({ text: 'commit or clean INSIDE every dirty submodule named above and stage its gitlink — a root-level git add -A cannot reach a submodule\'s own worktree' });
  }
  for (const [bit, key] of [['--no-skip-worktree', 'skipWorktree'], ['--no-assume-unchanged', 'assumeUnchanged']]) {
    const affected = flags.filter((flag) => flag[key]);
    if (affected.length === 0) continue;
    // Scoped to the LAGGING paths only, never to `git ls-files -v`: that set also holds every
    // de-materialised sparse-checkout entry, and clearing THEIR bit before `git add -A` would stage
    // their deletions. The cap is handled by iteration, not by a wider enumeration. The executable
    // form is offered ONLY when every affected name survives a byte round-trip — a lossily decoded
    // name would address a DIFFERENT path, so there the text stands alone and says so.
    const exact = affected.every((flag) => flag.exactName);
    steps.push({
      text: `clear the ${bit.slice(5)} bit on the bit-carrying path(s) named above — it is what makes git add -A a no-op on them — with git update-index ${bit} -- <path>, for those paths ONLY (never every entry git ls-files -v reports: that set includes de-materialised sparse paths whose deletions would then be staged)${exact ? '' : '; at least one of these names carries bytes that do not decode cleanly, so the name shown above is LOSSY and this refusal cannot give you a runnable command for it — its record is visible in git ls-files -v -z, and clearing that one is a by-hand step'}`,
      ...(exact ? { argv: ['update-index', bit, '--', ...affected.map((flag) => flag.rel)] } : {}),
    });
  }
  steps.push({ text: 'run git add -A from the work-tree root', argv: ['add', '-A'] });
  steps.push({ text: `re-run node ${FINAL_RUN_TOOL} --final` });
  steps.push({ text: 'commit the WHOLE tree' });
  return steps;
};

// decideIndexLag(state) → a refusal, or null when the index already carries the verified tree.
// The gates and the fingerprint both describe the WORKING tree; `git commit` takes the INDEX, and
// the fingerprint domain cannot tell the two apart — so without this arm a lagging index ships a
// strict subset of what was verified (it did, on 2026-07-25). FAIL-CLOSED on an undecidable probe:
// the guard's whole claim is that the committed bytes ARE the verified bytes, and it cannot make
// that claim about a tree it failed to read.
export const decideIndexLag = (state) => {
  if (state == null) {
    return { code: 1, lines: ['commit-guard: REFUSED — the index/worktree comparison could not be decided (a git probe failed); re-run inside the work tree and inspect `git status` by hand before committing'] };
  }
  // THREE categories, because they take DIFFERENT recoveries. A bit-carrying path folded into the
  // plain list would be un-actionable: its clause is the only one whose recovery is not `git add -A`,
  // and on cap overflow the plain paths could hide every one of them.
  const flaggedSet = new Set((state.flaggedPaths ?? []).map((flag) => flag.rel));
  const all = [...state.unstagedPaths, ...state.untrackedPaths];
  const plain = all.filter((rel) => !flaggedSet.has(rel));
  const bitCarrying = all.filter((rel) => flaggedSet.has(rel));
  const submodules = state.unstagedSubmodulePaths;
  const total = plain.length + bitCarrying.length + submodules.length;
  if (total === 0) return null;
  // Every non-empty category reserves a slot before the budget is spent — a clause that names no
  // path cannot deliver the recovery it exists to state.
  const groups = [plain, bitCarrying, submodules];
  const rendered = [];
  let spent = 0;
  groups.forEach((group, index) => {
    if (group.length === 0) {
      rendered[index] = { text: '', used: 0 };
      return;
    }
    const stillToReserve = groups.slice(index + 1).filter((later) => later.length > 0).length;
    rendered[index] = renderBudgeted(group, INDEX_LAG_PATH_CAP - spent - stillToReserve);
    spent += rendered[index].used;
  });
  const hidden = total - spent;
  const remainder = hidden > 0 ? `, plus ${hidden} further path(s) not listed` : '';
  const clauses = [];
  if (plain.length > 0) {
    clauses.push(`paths the index does not carry: ${rendered[0].text}`);
  }
  if (bitCarrying.length > 0) {
    clauses.push(`path(s) held back by a skip-worktree / assume-unchanged index bit: ${rendered[1].text}`);
  }
  if (submodules.length > 0) {
    clauses.push(`tracked submodule(s) not proven current: ${rendered[2].text}`);
  }
  // ONE ordered recovery, and every step must actually converge. The submodule step comes FIRST:
  // staging and re-running --final before it would stale the fresh receipt at once. The index-bit
  // step comes next, because `git add -A` CANNOT restage a skip-worktree / assume-unchanged entry —
  // printing it alone would be a recovery that silently does nothing. It deliberately points at
  // `git ls-files -v` rather than pasting names: the list above is capped, and a filename safe to
  // display is not automatically safe to paste into a shell.
  const steps = buildIndexLagRecovery(state);
  // The iterate-until-silent hint must also fire when the CAP hid work — otherwise a truncated
  // list of submodules with no index bits would send the operator to --final and commit while
  // unnamed ones are still unhandled.
  const converge = hidden > 0 || (state.flaggedPaths ?? []).length > 0
    ? ' The listed paths are capped: re-run this guard after each pass and it names the next batch, until it names none — that is the completion signal.'
    : '';
  return {
    code: 1,
    lines: [`commit-guard: REFUSED — the index does NOT carry the whole CURRENT working tree, so this commit would leave part of it behind: ${clauses.join('; ')}${remainder}. To recover, in order: ${steps.map((step, i) => `(${i + 1}) ${step.text}`).join('; ')}. An intentional partial commit stays git commit --no-verify.${converge}`],
  };
};

// runGuard({ cwd, env }) → { code, lines }. Every refusal names its recovery.
export const runGuard = ({ cwd = process.cwd(), env = process.env } = {}) => {
  const rootTop = gitLine(['rev-parse', '--show-toplevel'], cwd);
  if (rootTop == null) return { code: 1, lines: ['commit-guard: not a git work tree — nothing to guard'] };
  // FIRST: a pure tree property needing no store read. Its recovery re-stages the tree and re-mints
  // the receipt, so every arm below is re-decided anyway — naming a stale fingerprint ahead of it
  // would send the operator down a recovery they must redo.
  const indexLag = decideIndexLag(computeWorkingState(cwd));
  if (indexLag !== null) return indexLag;
  const fingerprint = computeTreeFingerprint(cwd);
  // The guard's OWN reads resolve FIXED git-dir paths — a stray AW_CORE_EVIDENCE / AW_LCOV_FILE
  // in the committing shell must never redirect the LAST line of defense to a forged artifact
  // (the env stays a test seam for the producers, never for this consumer).
  const storePath = resolveEvidencePath(cwd, {});
  const read = storePath ? readEvidence(storePath) : { records: [], malformed: 0 };
  if ((read.malformed ?? 0) > 0 || read.readError) {
    return { code: 1, lines: [`commit-guard: REFUSED — evidence store unavailable (${read.malformed} malformed line(s)${read.readError ? `, read error: ${read.readError}` : ''}); inspect ${storePath}`] };
  }
  const finals = authoritativeOfKind(read.records, 'final');
  const current = finals.find((r) => r.fingerprintBefore === fingerprint) ?? null;
  if (!current) {
    return { code: 1, lines: [`commit-guard: REFUSED — no completed final-run record for the current tree fingerprint (${fingerprint.slice(0, 12)}…). Stage everything, run the required reviews, then: node agent-workflow-kit/tools/run-gates.mjs --final — and commit immediately (any edit after the final run re-stales it)`] };
  }
  if (current.status !== 'green') {
    return { code: 1, lines: ['commit-guard: REFUSED — the LATEST completed final attempt at this fingerprint is RED (a dead green never revives); fix the failing gates and re-run run-gates.mjs --final'] };
  }
  if (current.fingerprintAfter !== current.fingerprintBefore) {
    return { code: 1, lines: ['commit-guard: REFUSED — the tree moved UNDER the final run (fingerprint before ≠ after); re-run run-gates.mjs --final on a quiescent tree'] };
  }
  // A dangling LATER attempt: a final-start at this fingerprint appended AFTER the latest
  // completion, whose own completion never landed (interrupted run / failed receipt append) —
  // the green above cannot stand for an attempt whose outcome is unknown. Scoped to
  // after-the-latest-completion so an old dead start never bricks recovery: the recovery IS
  // re-running --final, whose completion closes its own start and becomes the new latest.
  let lastFinalIdx = -1;
  read.records.forEach((r, i) => {
    if (r.kind === 'final' && r.fingerprintBefore === fingerprint) lastFinalIdx = i;
  });
  const completedAttempts = new Set(read.records.filter((r) => r.kind === 'final').map((r) => r.attempt));
  const dangling = read.records.some(
    (r, i) => r.kind === 'final-start' && r.fingerprint === fingerprint && i > lastFinalIdx && !completedAttempts.has(r.attempt),
  );
  if (dangling) {
    return { code: 1, lines: ['commit-guard: REFUSED — a later final attempt started and never completed (interrupted, or its receipt failed to write); re-run run-gates.mjs --final'] };
  }
  const declaration = loadDeclaration(rootTop);
  if (declaration.outcome !== 'loaded') {
    return { code: 1, lines: [`commit-guard: REFUSED — no readable gate declaration at ${GATES_REL}`] };
  }
  const currentDeclared = declaration.gates.map(({ id, cmd }) => ({ id, cmd }));
  if (JSON.stringify(currentDeclared) !== JSON.stringify(current.declared)) {
    return { code: 1, lines: [`commit-guard: REFUSED — the gate declaration changed after the final run (${GATES_REL} no longer matches the receipt's recorded {id, cmd} content); re-run run-gates.mjs --final`] };
  }
  const wantHashes = {
    redProof: sha(canonicalKindSerialization(read.records, 'red-proof')),
    degrade: sha(canonicalKindSerialization(read.records, 'degrade')),
  };
  if (wantHashes.redProof !== current.evidenceHashes.redProof || wantHashes.degrade !== current.evidenceHashes.degrade) {
    return { code: 1, lines: ['commit-guard: REFUSED — the evidence store moved under the receipt (canonical red-proof/degrade hashes no longer match); re-run run-gates.mjs --final'] };
  }
  if (current.lcovSha256 !== null) {
    const lcovPath = resolveLcovPath(cwd, {}); // the SAME fixed resolution the checker defaults to — env ignored here
    let lcovNow = null;
    try {
      if (lstatSync(lcovPath).isFile()) lcovNow = sha(readFileSync(lcovPath));
    } catch { /* absent → mismatch below */ }
    if (lcovNow !== current.lcovSha256) {
      return { code: 1, lines: ['commit-guard: REFUSED — the lcov file the receipt consumed moved or vanished; re-run run-gates.mjs --final'] };
    }
  }
  // The ship-receipt arm: the SAME normative decision review-state --check computes (configured
  // obligations, ship-class-only, veto, degrade escape) — a file-read recompute, no subprocess —
  // over a SANITIZED env: the store overrides are producer test seams, and honoring them HERE
  // would let a forged receipts/degrade store bypass the fixed-path reads above.
  const reviewEnv = { ...env };
  delete reviewEnv.AW_REVIEW_RECEIPTS;
  delete reviewEnv.AW_CORE_EVIDENCE;
  const review = decideCheck(buildState({ cwd, env: reviewEnv }));
  if (review.code !== 0) {
    return { code: 1, lines: [`commit-guard: REFUSED — the review obligations are not satisfied: ${review.reason}`] };
  }
  return { code: 0, lines: [`commit-guard: PASS — a green final receipt binds this exact tree (${fingerprint.slice(0, 12)}…), the declaration and evidence hashes match, and the review obligations are satisfied`] };
};

const HELP = `commit-guard — the read-only pre-commit guard (agent-workflow family, D10).

Usage:
  node commit-guard.mjs --check [--cwd <dir>]

Re-runs NOTHING: refuses an INDEX that lags the verified working tree (FIRST — unstaged tracked
paths, reviewable untracked paths, or a dirty tracked submodule, each named with its recovery;
this deliberately blocks a partial commit), then recomputes the current tree fingerprint and binds
the LATEST completed run-gates --final receipt — refusing on { no receipt for this tree · a red
latest attempt · before≠after · declaration content drift · evidence-hash drift · lcov drift ·
unsatisfied review obligations (the review-state decision) }. Wire it into pre-commit;
\`git commit --no-verify\` stays the stated residual (self-discipline, not a security boundary).

Exit codes: 0 pass; 1 refused (reason named); 2 usage.`;

export const main = (argv, ctx = {}) => {
  const env = ctx.env ?? process.env;
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    let cwd = ctx.cwd ?? process.cwd();
    const rest = [...argv];
    const cwdAt = rest.indexOf('--cwd');
    if (cwdAt !== -1) {
      cwd = rest[cwdAt + 1];
      if (cwd === undefined) throw usageFail('--cwd needs a directory');
      rest.splice(cwdAt, 2);
    }
    const checkAt = rest.indexOf('--check');
    if (checkAt !== -1) rest.splice(checkAt, 1);
    if (rest.length > 0) throw usageFail(`unknown argument: ${rest[0]}`);
    const { code, lines } = runGuard({ cwd, env });
    return { code, stdout: lines.join('\n'), stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `commit-guard: ${err.message}` };
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const r = main(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
}
