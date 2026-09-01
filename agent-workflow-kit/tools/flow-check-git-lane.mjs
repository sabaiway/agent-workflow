// flow-check-git-lane.mjs — the all-path git lane for the checker's base-motion inputs (#62/P22):
// toplevel-rooted, submodules never ignored, test files included. Split out of flow-check.mjs
// (baseline-practices tranche 1) and deliberately a LEAF — it imports no flow-check sibling, so the
// pure decision cores can never reach a git spawn through it.

import { spawnSync } from 'node:child_process';
import { GIT_MAX_BUFFER } from './git-env.mjs';

const short = (digest) => `${digest.slice(0, 12)}…`;

// computeChangedSurface exists for COVERAGE and excludes test files by design — the base-
// intersection inputs come from these helpers instead: every changed path counts, tests included.
const gitPathList = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout.toString('utf8').split('\0').filter(Boolean);
};

export const resolveGitToplevel = (cwd) => {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  const top = r.stdout.toString('utf8').replace(/\r?\n$/, '');
  return top === '' ? null : top;
};

export const computeAllPathBaseDelta = (cwd, fromBase, toBase) => {
  const isSha = (v) => typeof v === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(v);
  if (!isSha(fromBase) || !isSha(toBase)) {
    return { ok: false, reason: `a base delta needs two shas (got ${JSON.stringify(fromBase)} → ${JSON.stringify(toBase)})` };
  }
  const root = resolveGitToplevel(cwd);
  if (root == null) return { ok: false, reason: 'not inside a git work tree — the base delta is unresolvable (fail closed)' };
  const paths = gitPathList(['diff', '--name-only', '--no-renames', '--ignore-submodules=none', '-z', fromBase, toBase], root);
  if (paths == null) return { ok: false, reason: `git diff ${short(fromBase)} ${short(toBase)} failed — an unresolvable base delta fails closed` };
  return { ok: true, paths };
};

export const computeAllPathWorktreeSurface = (cwd) => {
  const root = resolveGitToplevel(cwd);
  if (root == null) return { ok: false, reason: 'not inside a git work tree — the worktree surface is unresolvable (fail closed)' };
  // assume-unchanged/skip-worktree lie to git diff — any flagged entry fails the surface closed.
  const flagged = gitPathList(['ls-files', '-v', '-z'], root);
  if (flagged == null) return { ok: false, reason: 'the worktree surface is unresolvable (git ls-files -v failed) — fail closed' };
  for (const entry of flagged) {
    if (entry.length < 3 || entry[1] !== ' ') return { ok: false, reason: `the worktree surface is unresolvable (unparseable ls-files -v entry ${JSON.stringify(entry)}) — fail closed` };
    const assumeUnchanged = /[a-z]/.test(entry[0]);
    const skipWorktree = entry[0].toUpperCase() === 'S';
    if (assumeUnchanged || skipWorktree) {
      const flags = [assumeUnchanged ? 'assume-unchanged' : null, skipWorktree ? 'skip-worktree' : null].filter(Boolean).join(' + ');
      return { ok: false, reason: `index-flagged entry ${entry.slice(2)} (${flags}) hides changes from git diff — the worktree surface is undecidable (fail closed)` };
    }
  }
  const tracked = gitPathList(['diff', 'HEAD', '--name-only', '--no-renames', '--ignore-submodules=none', '-z'], root);
  const untracked = gitPathList(['ls-files', '--others', '--exclude-standard', '-z'], root);
  if (tracked == null || untracked == null) return { ok: false, reason: 'the worktree surface is unresolvable (git diff/ls-files failed) — fail closed' };
  return { ok: true, paths: [...new Set([...tracked, ...untracked])] };
};
