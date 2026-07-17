#!/usr/bin/env node
// commit-guard.mjs — the read-only pre-commit guard (strip-the-kit 2.5, D10). It re-runs NO
// gate/test subprocess: the heavy D3(b)/(c)/(d) verification lives in `run-gates --final`, whose
// receipt this guard binds. `--check`:
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
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { computeTreeFingerprint, buildState, decideCheck } from './review-state.mjs';
import { resolveEvidencePath, readEvidence, authoritativeOfKind, canonicalKindSerialization } from './core-evidence.mjs';
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

// runGuard({ cwd, env }) → { code, lines }. Every refusal names its recovery.
export const runGuard = ({ cwd = process.cwd(), env = process.env } = {}) => {
  const rootTop = gitLine(['rev-parse', '--show-toplevel'], cwd);
  if (rootTop == null) return { code: 1, lines: ['commit-guard: not a git work tree — nothing to guard'] };
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

Re-runs NOTHING: recomputes the current tree fingerprint and binds the LATEST completed
run-gates --final receipt — refusing on { no receipt for this tree · a red latest attempt ·
before≠after · declaration content drift · evidence-hash drift · lcov drift · unsatisfied review
obligations (the review-state decision) }. Wire it into pre-commit; \`git commit --no-verify\`
stays the stated residual (self-discipline, not a security boundary).

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
