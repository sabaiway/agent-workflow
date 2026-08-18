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
//   1. recomputes the CURRENT tree fingerprint (the review-state export — read-only git plumbing),
//      and decides the two CONTENT-FREE lanes here, because no store read can answer them: a
//      payload with no bytes yields the ONE fingerprint every clean moment of every repository
//      shares, so any receipt at it was minted elsewhere and may attest nothing. With a DIRTY
//      index that means staged content the payload cannot see (a gitlink hidden by
//      `submodule.<name>.ignore` / `diff.ignoreSubmodules`) and the guard REFUSES, naming the
//      configuration rather than re-staging; with a clean index the commit introduces no bytes
//      (`--allow-empty`, a message-only `--amend`, an empty merge) and the guard PASSES while
//      stating that it attests NOTHING — the receipt arms are skipped, never satisfied;
//   2. reads the LATEST completed final-run record from the core-evidence store (only the latest
//      attempt at a fingerprint is authoritative — a green receipt is DEAD once a later attempt at
//      the same fingerprint went red) and refuses on: no record for the current fingerprint · a
//      red record · fingerprintBefore ≠ fingerprintAfter · a LATER final-start with no completion
//      (an attempt of unknown outcome) · a DECLARATION whose current {id, cmd} content differs
//      from the recorded one · evidence hashes that no longer match the store's canonical
//      red-proof/degrade serializations · an lcov file whose sha moved. The guard's own reads
//      resolve FIXED git-dir paths (env overrides are producer test seams, never guard inputs);
//   3. consults the flow decision (Plan 3 Phase 2, two-tier): with NO flow store file the guard is
//      byte-identical to the pre-flow guard; a PRESENT store must read clean and its refusals
//      (open own chain, base motion, coverage, ordering) refuse the commit with the flow-check
//      reason verbatim — a foreign worktree's chain stays advisory; the armed state extends the
//      PASS line;
//   4. re-computes the review-state decision (the ship-receipt arm) — a missing/vetoed ship
//      receipt refuses. The env it hands over is SANITIZED (receipts/evidence/flow-store producer
//      seams stripped) so a poisoned override can neither redirect nor mask any store this guard
//      reads.
// `git commit --no-verify` stays the stated residual (a self-discipline mechanism, not a security
// boundary). Read-only; dependency-free; Node >= 22. No side effects on import.

import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { computeTreeFingerprint, buildState, decideCheck, quoteReportName, shellQuoteArg } from './review-state.mjs';
import {
  resolveEvidencePath, readEvidence, authoritativeOfKind, canonicalKindSerialization,
  computeWorkingState, CONTENT_FREE_FINGERPRINT,
} from './core-evidence.mjs';
import { resolveLcovPath } from './coverage-check.mjs';
import { GATES_REL, loadDeclaration } from './run-gates.mjs';
import { computeFlowDecision } from './flow-check.mjs';

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
// The flow decision's two renders, shared by every lane that consults it — the empty-commit lane
// reaches the same store through the same consumer mode, so its wording can never drift from the
// byte-carrying one.
const flowRefusalLines = (flow) => [
  `commit-guard: REFUSED — the flow store refuses this commit: ${flow.refusals[0]}`,
  ...flow.refusals.slice(1).map((r) => `commit-guard: flow refusal — ${r}`),
];
const flowAdvisoryLines = (flow) => (flow.present && flow.armed
  ? flow.advisories.map((a) => `commit-guard: flow advisory — ${a}`)
  : []);

export const runGuard = ({ cwd = process.cwd(), env = process.env } = {}) => {
  const rootTop = gitLine(['rev-parse', '--show-toplevel'], cwd);
  if (rootTop == null) return { code: 1, lines: ['commit-guard: not a git work tree — nothing to guard'] };
  // FIRST: a pure tree property needing no store read. Its recovery re-stages the tree and re-mints
  // the receipt, so every arm below is re-decided anyway — naming a stale fingerprint ahead of it
  // would send the operator down a recovery they must redo.
  const working = computeWorkingState(cwd);
  const indexLag = decideIndexLag(working);
  if (indexLag !== null) return indexLag;
  const fingerprint = computeTreeFingerprint(cwd);
  // The CONTENT-FREE lanes — the second pure tree property, decided here for the same reason the
  // index lag is: no store read can answer it. A payload with no bytes states nothing about what
  // this commit will carry, and its fingerprint is the ONE value every clean moment of every
  // repository shares, so a receipt found at it was minted by some other moment, possibly at
  // another base. Such evidence must therefore decide NOTHING here — neither refuse nor attest
  // (the same fact flow-check-rungs.mjs applies to a red final). The index tells the two lanes
  // apart, and `computeWorkingState` probes it with --ignore-submodules=none precisely so a
  // config-hidden gitlink cannot pass for a clean one.
  const contentFree = fingerprint === CONTENT_FREE_FINGERPRINT;
  if (contentFree && working.stagedDirty) {
    return {
      code: 1,
      lines: [`commit-guard: REFUSED — the index carries staged content the fingerprint domain cannot see (a submodule gitlink hidden from \`git diff\` by \`submodule.<name>.ignore\` or \`diff.ignoreSubmodules\`), so no final receipt can describe what this commit will carry. Recovery: clear that ignore setting (or set it to \`none\`) until \`git diff --cached --no-ext-diff\` shows the change, then re-run node ${FINAL_RUN_TOOL} --final`],
    };
  }
  // The guard's OWN reads resolve FIXED git-dir paths — a stray AW_CORE_EVIDENCE / AW_LCOV_FILE
  // in the committing shell must never redirect the LAST line of defense to a forged artifact
  // (the env stays a test seam for the producers, never for this consumer).
  const storePath = resolveEvidencePath(cwd, {});
  const read = storePath ? readEvidence(storePath) : { records: [], malformed: 0 };
  if ((read.malformed ?? 0) > 0 || read.readError) {
    return { code: 1, lines: [`commit-guard: REFUSED — evidence store unavailable (${read.malformed} malformed line(s)${read.readError ? `, read error: ${read.readError}` : ''}); inspect ${storePath}`] };
  }
  // The empty-commit lane: the index equals HEAD, so this commit introduces no bytes at all
  // (`git commit --allow-empty`, a message- or signature-only `--amend`, an empty merge). The
  // guard's whole claim is about bytes, so here it has none to make and says so. The receipt arms
  // are SKIPPED rather than satisfied — consulting a content-free receipt would make the outcome
  // depend on which stray clean moment happened to be recorded last. The flow arm still runs: an
  // empty commit still moves HEAD, and the chain bookkeeping is about that, not about bytes; its
  // own fingerprint-keyed correlations (the D10 flow→final binding, receipt and degrade coverage)
  // drop out inside flow-check on the same fact, so no stray content-free record decides here
  // either. Store HEALTH is deliberately NOT waived above: an unreadable store is not a
  // correlation, and a store that cannot be read cannot answer the chain questions either.
  if (contentFree) {
    const emptyFlow = computeFlowDecision({ cwd, consumer: 'commit-guard', treeCarriesBytes: false });
    if (emptyFlow.refusals.length > 0) return { code: 1, lines: flowRefusalLines(emptyFlow) };
    return {
      code: 0,
      lines: [
        'commit-guard: PASS — this commit changes no tree content (the index contributes no tree-content delta and the work tree adds nothing), so the guard attests NOTHING about it: a receipt found at the shared content-free fingerprint cannot be correlated to THIS moment or base',
        ...flowAdvisoryLines(emptyFlow),
      ],
    };
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
  // The flow arm (#43/P3, two-tier over FIXED git-derived paths): no store file ⇒ byte-exact
  // prior behavior; a present store's refusals (malformed reads included) refuse with the
  // flow-check reason verbatim. The commit-guard consumer mode arms the D10 flow→final
  // comparison (Plan 4 Decision 2) — the in-matrix flow-check gate stays inert on it.
  const flow = computeFlowDecision({ cwd, consumer: 'commit-guard' });
  // NOT gated on flow.present: the D10 binding refusal fires precisely when a receipt carries
  // evidenceHashes.flow and the store has since VANISHED (present=false) — a deletion must
  // never un-arm the binding. A no-store repo with no flow-bearing receipt still yields zero
  // refusals (byte-exact pre-flow behavior).
  if (flow.refusals.length > 0) return { code: 1, lines: flowRefusalLines(flow) };
  // The ship-receipt arm: the SAME normative decision review-state --check computes, over a
  // SANITIZED env — the receipts/evidence/flow-store overrides are producer test seams, and
  // honoring them HERE would let a forged store bypass the fixed-path reads above.
  const reviewEnv = { ...env };
  delete reviewEnv.AW_REVIEW_RECEIPTS;
  delete reviewEnv.AW_CORE_EVIDENCE;
  delete reviewEnv.AW_FLOW_STORE;
  const review = decideCheck(buildState({ cwd, env: reviewEnv }));
  if (review.code !== 0) {
    return { code: 1, lines: [`commit-guard: REFUSED — the review obligations are not satisfied: ${review.reason}`] };
  }
  const flowSuffix = flow.present && flow.armed
    ? ` — flow: armed${review.flowLabels?.length ? ` (${review.flowLabels.join('; ')})` : ''}`
    : '';
  return { code: 0, lines: [`commit-guard: PASS — a green final receipt binds this exact tree (${fingerprint.slice(0, 12)}…), the declaration and evidence hashes match, and the review obligations are satisfied${flowSuffix}`, ...flowAdvisoryLines(flow)] };
};

const HELP = `commit-guard — the read-only pre-commit guard (agent-workflow family, D10).

Usage:
  node commit-guard.mjs --check [--cwd <dir>]

Re-runs NOTHING: refuses an INDEX that lags the verified working tree (FIRST — unstaged tracked
paths, reviewable untracked paths, or a dirty tracked submodule, each named with its recovery;
this deliberately blocks a partial commit), then recomputes the current tree fingerprint.

A CONTENT-FREE fingerprint (a payload with no bytes — the value every clean work tree shares)
decides WITHOUT a receipt, because one found there was minted by another clean moment: with a dirty
index it REFUSES (staged content the payload cannot see — a gitlink hidden by
\`submodule.<name>.ignore\` / \`diff.ignoreSubmodules\`; the recovery is that configuration, not
\`git add\`), and with a clean index it PASSES stating it attests NOTHING (the commit carries no
bytes: \`--allow-empty\`, a message-only \`--amend\`, an empty merge).

Otherwise it binds
the LATEST completed run-gates --final receipt — refusing on { no receipt for this tree · a red
latest attempt · before≠after · declaration content drift · evidence-hash drift · lcov drift ·
a flow-store refusal (a PRESENT store's open own chain / base motion / coverage — verbatim; no
store file = byte-exact pre-flow behavior) · unsatisfied review obligations (the review-state
decision, over a sanitized env — receipts/evidence/flow-store seams stripped) }. Wire it into
pre-commit; \`git commit --no-verify\` stays the stated residual (self-discipline, not a security
boundary).

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
