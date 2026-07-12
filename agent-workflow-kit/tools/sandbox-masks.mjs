#!/usr/bin/env node
// sandbox-masks.mjs — the GUARDED cosmetic exclude lane behind `/agent-workflow-kit sandbox-masks`
// (AD-044 Plan 4, Phase 1.5; design consult codex+agy CONVERGED on B+D — probe-DERIVED, never a
// frozen list). An OS sandbox (Claude Code) injects character-device masks into the work tree;
// the review domain already ignores them BY CONSTRUCTION (review-state.mjs + both bridge wrappers,
// Decision 1), so this lane is COSMETIC ONLY: it hides the masks from `git status` (and from every
// other --exclude-standard untracked walk) via ONE managed fenced block in the repo's
// `git rev-parse --git-path info/exclude` file.
//
// Contract:
//   flagless      READ-ONLY probe/preview. Derives the CURRENT mask set from the UNFILTERED
//                 untracked walk (`git ls-files --others -z`, WITHOUT standard excludes — an
//                 already-excluded mask must stay visible to a rerun) + lstat classification.
//                 ONLY the never-committable classes (char/block devices, FIFOs, sockets — the
//                 SAME class set as the review-domain filter) are ever candidates; tracked /
//                 regular / directory / symlink / gitlink / missing paths can never enter the
//                 block by construction. The probe also REVALIDATES the existing fenced entries
//                 and loudly flags any that became a REAL path (delete that line first — an
//                 excluded real file is silently skipped by bulk staging, `git add -A`/`git add .`,
//                 and `.git/info/exclude` never warns). No standing detector: the flags ride probe runs.
//   --apply       consent-gated FULL-BLOCK REPLACE from a fresh derivation (stale masks drop by
//                 construction — never append-only). An apply whose derivation is EMPTY while a
//                 non-empty block exists (e.g. accidentally run outside the sandbox) REFUSES
//                 unless --clear is also given; an empty derivation with no existing block
//                 reports "0 masks visible" and no-ops.
//   --clear       (only with --apply) remove the managed block entirely. Takes PRECEDENCE over
//                 the derivation — with masks still visible the block is removed, never re-written.
//
// Writes ONLY its own fenced block in the file `git rev-parse --git-path info/exclude` names —
// never .gitignore, never a global excludesFile, never outside the fence. The fence is SEPARATE
// from the hidden-mode reconcile's block (hide-footprint.mjs — that lane noops on visible
// deployments; this one serves them too). A malformed fence (start without end / duplicated
// markers) fails CLOSED: loud report, file untouched. Patterns are root-anchored (`/rel`),
// glob-metacharacters escaped, NUL-safe walk. Dependency-free, Node >= 18; no side effects on
// import (the isDirectRun idiom).

import { lstatSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fail } from './orchestration-config.mjs';
import { isNeverCommittableStat, shellQuoteArg } from './review-state.mjs';
import { assertContainedRealPath } from './fs-safe.mjs';

export const MASKS_FENCE_START = '# >>> agent-workflow sandbox-masks — managed block, fully REPLACED by the kit sandbox-masks lane; do not hand-edit inside >>>';
export const MASKS_FENCE_END = '# <<< agent-workflow sandbox-masks <<<';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── git plumbing (read-only queries; injectable for tests) ─────────────────────────

const gitLine = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout.replace(/\r?\n$/, '');
};

// The UNFILTERED untracked walk: --others WITHOUT --exclude-standard, so a mask already hidden by
// an earlier apply stays visible to a rerun (the full-block replace re-derives it, codex).
const listUntrackedUnfilteredZ = (root) => {
  const r = spawnSync('git', ['ls-files', '--others', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout.split('\0').filter(Boolean);
};

// ── derivation (the D5 guard IS the classifier: only never-committable classes survive) ────────

// A root-anchored gitignore pattern for one relative path: leading `/` (root-anchored — a mask
// name can never shadow a deeper real path), glob metacharacters + leading-! / leading-# handled
// by the anchor, trailing whitespace escaped (gitignore trims it otherwise).
// Trailing SPACES are escapable in gitignore (`\ `); a trailing TAB is not expressible — such a
// name is classified unrenderable by the derivation (codex R12), so it never reaches this renderer.
export const toExcludePattern = (rel) => {
  const escaped = rel.replace(/([\\*?[\]])/g, '\\$1').replace(/ +$/, (m) => '\\ '.repeat(m.length));
  return `/${escaped}`;
};

// deriveMasks({ root, lstat, listUntracked }) → { masks, unrenderable }: sorted rel paths whose
// lstat class is never-committable (char/block/FIFO/socket). Everything else is refused by
// construction — tracked paths never appear in an --others walk; regular/dir/symlink/missing fail
// the predicate. A CR/LF-carrying mask NAME cannot be expressed as ONE gitignore rule — rendering
// it would split into several rules and could hide unrelated committable paths (codex R3) — so it
// is a LOUD unrenderable skip, never written (the review domain already ignores the mask itself).
export const deriveMasks = ({ root, lstat = lstatSync, listUntracked = listUntrackedUnfilteredZ } = {}) => {
  const entries = listUntracked(root);
  if (entries == null) return null;
  const masks = [];
  const unrenderable = [];
  for (const rel of entries) {
    let stat = null;
    try {
      stat = lstat(join(root, rel));
    } catch {
      stat = null;
    }
    if (!isNeverCommittableStat(stat)) continue;
    // CR/LF anywhere, or a trailing TAB (inexpressible in gitignore — only trailing SPACES escape
    // as `\ `; codex R12), make the name unrenderable as ONE exclude rule.
    if (/[\r\n]/.test(rel) || /\t$/.test(rel)) unrenderable.push(rel);
    else masks.push(rel);
  }
  return { masks: masks.sort(), unrenderable: unrenderable.sort() };
};

// ── the fence (own block; malformed → fail closed) ─────────────────────────────────

export const findMasksFence = (lines) => {
  const starts = lines.map((l, i) => [l.trim(), i]).filter(([t]) => t === MASKS_FENCE_START).map(([, i]) => i);
  const ends = lines.map((l, i) => [l.trim(), i]).filter(([t]) => t === MASKS_FENCE_END).map(([, i]) => i);
  if (starts.length === 0 && ends.length === 0) return { state: 'absent' };
  if (starts.length !== 1 || ends.length !== 1) return { state: 'malformed', reason: 'duplicated fence marker(s)' };
  if (ends[0] < starts[0]) return { state: 'malformed', reason: 'end marker precedes start marker' };
  return { state: 'ok', startIdx: starts[0], endIdx: ends[0], body: lines.slice(starts[0] + 1, ends[0]) };
};

// A fenced pattern back to its relative path (the derivation writes only `/rel` root-anchored
// escaped forms; unescape is its exact inverse — the escaped-space form `\ ` included, so a
// trailing-space mask round-trips; codex R1). Non-pattern lines (blank/comment) are skipped;
// only UNESCAPED trailing whitespace is insignificant (gitignore semantics).
const patternToRel = (line) => {
  // A trailing CR (a CRLF-saved exclude file) strips FIRST — it would otherwise ride into the rel
  // name and false-ENOENT the revalidation lstat (agy R5); then only UNESCAPED trailing
  // whitespace is insignificant (gitignore semantics — an escaped `\ ` survives).
  const t = line.replace(/\r$/, '').replace(/^[ \t]+/, '').replace(/(?<!\\)[ \t]+$/, '');
  if (t === '' || t.startsWith('#') || !t.startsWith('/')) return null;
  return t.slice(1).replace(/\\([\\*?[\] ])/g, '$1');
};

// Revalidate the CURRENT fence body against the disk: an entry whose path now exists as anything
// OTHER than a never-committable class is a STALE-REAL flag — the D5 watch (a real file at an
// excluded path is silently skipped by bulk staging; delete the line before trusting git with it).
export const revalidateFence = (bodyLines, { root, lstat = lstatSync } = {}) => {
  const staleReal = [];
  for (const line of bodyLines) {
    const rel = patternToRel(line);
    if (rel == null) continue;
    let stat = null;
    try {
      stat = lstat(join(root, rel));
    } catch {
      continue; // vanished mask — the next --apply drops it by construction, nothing real is hidden
    }
    if (!isNeverCommittableStat(stat)) staleReal.push(rel);
  }
  return staleReal;
};

// ── the probe (read-only; exported — the Recommendations advisor consumes it) ──────

// probeSandboxMasks({ cwd, ... }) → everything the render/apply/advisor needs, or null when not a
// git work tree. Read-only always.
export const probeSandboxMasks = ({ cwd = process.cwd(), lstat = lstatSync, listUntracked = listUntrackedUnfilteredZ, readFile = readFileSync } = {}) => {
  const root = gitLine(['rev-parse', '--show-toplevel'], cwd);
  if (root == null) return null;
  const gitPathRaw = gitLine(['rev-parse', '--git-path', 'info/exclude'], cwd);
  const commonDirRaw = gitLine(['rev-parse', '--git-common-dir'], cwd);
  if (gitPathRaw == null || commonDirRaw == null) return null;
  const excludeFile = resolve(cwd, gitPathRaw);
  // The write-containment root (codex R2): info/exclude lives in the COMMON git dir (worktree-safe),
  // and the apply must never write through a symlinked component or a non-regular leaf.
  const gitCommonDir = resolve(cwd, commonDirRaw);
  const derived = deriveMasks({ root, lstat, listUntracked });
  if (derived == null) return null;
  const { masks, unrenderable } = derived;
  // The WHOLE chain is guarded BEFORE any read (codex R7+R8): a symlinked exclude leaf OR a
  // symlinked parent (.git/info) must never be read through, and a FIFO/socket leaf would HANG
  // the read-only probe — parent-chain containment + leaf lstat first, fail closed on everything
  // but a plain absent file, then read the existing REGULAR content. The apply re-checks
  // (defense in depth) before writing.
  try {
    assertContainedRealPath(gitCommonDir, excludeFile, { lstat });
  } catch (err) {
    throw fail(1, `refusing to touch ${excludeFile}: ${err.message}`);
  }
  // The chain guard above already refused symlinked components (the leaf included) and PROPAGATED
  // any non-ENOENT lstat failure — after it, the leaf can only be absent or exist non-symlinked.
  const leafStat = (() => {
    try {
      return lstat(excludeFile);
    } catch {
      return null; // absent (ENOENT) — the only reachable arm after the chain guard
    }
  })();
  if (leafStat != null && !leafStat.isFile()) {
    throw fail(1, `refusing to open ${excludeFile}: the exclude path exists but is not a regular file (a FIFO/device read would hang)`);
  }
  let content = '';
  if (leafStat != null) {
    try {
      content = readFile(excludeFile, 'utf8');
    } catch (err) {
      // The file existed a moment ago — ANY read failure now fails CLOSED (an apply over a misread
      // "empty" file would overwrite hand content outside the managed block; codex R4).
      throw fail(1, `cannot read ${excludeFile} (${err?.code ?? err?.message ?? err}) — refusing to treat an unreadable exclude file as empty`);
    }
  }
  const lines = content.split('\n');
  const fence = findMasksFence(lines);
  const staleReal = fence.state === 'ok' ? revalidateFence(fence.body, { root, lstat }) : [];
  const applyCmd = `node ${shellQuoteArg(join(HERE, 'sandbox-masks.mjs'))} --cwd ${shellQuoteArg(root)} --apply`;
  return { root, excludeFile, gitCommonDir, content, lines, fence, masks, unrenderable, staleReal, applyCmd };
};

// needsMasksApply(probe) → whether the CURRENT derivation diverges from the fenced block — the
// Recommendations advisor's fire condition (Phase 3, AD-044 Plan 4). True when any fenced entry
// became a real path (stale-real), or when visible masks exist and the derived set ≠ the fenced
// set. A malformed fence is NOT an apply item (the apply would fail closed — it needs a hand fix,
// which the probe render itself flags loudly). Pure over the probe result.
export const needsMasksApply = (probe) => {
  if (probe == null) return false;
  if (probe.staleReal.length > 0) return true;
  if (probe.fence.state === 'malformed') return false;
  const fenced = probe.fence.state === 'ok' ? probe.fence.body.map(patternToRel).filter((r) => r != null) : [];
  return probe.masks.length > 0 && [...probe.masks].sort().join('\0') !== [...fenced].sort().join('\0');
};

// ── the apply plan (pure: probe → new file content or a refusal) ───────────────────

export const planApply = (probe, { clear = false } = {}) => {
  if (probe.fence.state === 'malformed') {
    return { action: 'refuse', reason: `malformed managed block in ${probe.excludeFile} (${probe.fence.reason}) — fix it by hand; the file was left unchanged` };
  }
  // --clear takes PRECEDENCE over the derivation (codex, Segment-A receipt): it means "remove the
  // managed block", even while masks are visible — re-writing the block instead of the requested
  // clear would be a silent divergence. An EMPTY fence (markers, no entries) clears too (codex R8);
  // no fence at all is a stated no-op.
  if (clear && probe.fence.state !== 'ok') {
    return { action: 'noop', reason: 'no managed block present — nothing to clear' };
  }
  const hasBlock = probe.fence.state === 'ok' && probe.fence.body.some((l) => patternToRel(l) != null);
  if (!clear && probe.masks.length === 0 && hasBlock) {
    return { action: 'refuse', reason: '0 masks visible but a non-empty managed block exists — you are probably OUTSIDE the sandbox (the masks are in-sandbox only). Re-run inside the sandbox, or pass --apply --clear to intentionally remove the block' };
  }
  if (!clear && probe.masks.length === 0 && !hasBlock) {
    return { action: 'noop', reason: '0 masks visible (outside the sandbox or clean) — nothing to write' };
  }
  const masks = clear ? [] : probe.masks;
  const block = masks.length === 0 ? [] : [MASKS_FENCE_START, ...masks.map(toExcludePattern), MASKS_FENCE_END];
  // EVERY hand byte outside the managed fence is preserved EXACTLY (codex R5+R6): the first-apply
  // append adds at most ONE separator newline, and the existing-block replace splices via RAW
  // string offsets around the fence lines — a split/join('\n') rebuild would silently normalize
  // CRLF hand content outside the block. Only the fenced block itself is ours (always LF).
  const rendered = block.length ? `${block.join('\n')}\n` : '';
  let content;
  if (probe.fence.state === 'ok') {
    const offsetOf = (lineIdx) => probe.lines.slice(0, lineIdx).reduce((n, l) => n + l.length + 1, 0);
    const rawStart = offsetOf(probe.fence.startIdx);
    const endLineStop = offsetOf(probe.fence.endIdx) + probe.lines[probe.fence.endIdx].length;
    const rawEnd = endLineStop < probe.content.length ? endLineStop + 1 : endLineStop; // consume the end-marker's own newline when present
    content = `${probe.content.slice(0, rawStart)}${rendered}${probe.content.slice(rawEnd)}`;
  } else {
    const head = probe.content === '' ? '' : probe.content.endsWith('\n') ? probe.content : `${probe.content}\n`;
    content = `${head}${rendered}`;
  }
  return { action: masks.length === 0 ? 'cleared' : 'replaced', content, count: masks.length };
};

// ── rendering ───────────────────────────────────────────────────────────────────────

const formatProbe = (probe) => {
  const lines = [
    `sandbox-masks — never-committable untracked masks (device/FIFO/socket) in ${probe.root}`,
    `  exclude file: ${probe.excludeFile}`,
    `  managed block: ${probe.fence.state === 'ok' ? `present (${probe.fence.body.filter((l) => patternToRel(l) != null).length} entr(ies))` : probe.fence.state}`,
  ];
  if (probe.fence.state === 'malformed') lines.push(`  ⚠ MALFORMED managed block (${probe.fence.reason}) — this lane fails closed and will not write until it is fixed by hand`);
  lines.push(`  masks visible now: ${probe.masks.length === 0 ? '0 (outside the sandbox or clean)' : ''}`);
  for (const m of probe.masks) lines.push(`    · ${m}`);
  for (const rel of probe.staleReal) {
    lines.push(`  ⚠ fenced entry became a REAL path: ${rel} — delete its line from the managed block BEFORE relying on git for this path: an excluded real file is silently skipped by bulk staging (git add -A / git add .), so it stays OUT of your commits, and an explicit git add refuses it without -f; .git/info/exclude never warns`);
  }
  for (const rel of probe.unrenderable) {
    lines.push(`  ⚠ mask name carries a newline or ends with a tab and cannot be expressed as ONE exclude rule — NOT written (the review domain already ignores the mask itself): ${JSON.stringify(rel)}`);
  }
  // A stale-real-only fence (empty derivation over a non-empty block) makes the plain --apply
  // REFUSE — the rendered one-liner must be the form planApply actually accepts (--clear), the
  // same rule the Recommendations item applies (codex terminal).
  const applyLine = probe.masks.length === 0 && probe.staleReal.length > 0 ? `${probe.applyCmd} --clear` : probe.applyCmd;
  lines.push('', probe.masks.length > 0 || probe.fence.state === 'ok'
    ? `  apply (consent-gated, full-block replace): ${applyLine}`
    : '  nothing to apply.');
  return lines.join('\n');
};

const HELP = `sandbox-masks — cosmetic exclude lane for sandbox-injected device masks (agent-workflow kit, AD-044).

Usage:
  node sandbox-masks.mjs [--cwd <dir>] [--json]          # READ-ONLY probe/preview
  node sandbox-masks.mjs [--cwd <dir>] --apply [--clear] # consent-gated FULL-BLOCK replace

The review domain already ignores never-committable untracked paths (char/block devices, FIFOs,
sockets) BY CONSTRUCTION — this lane is cosmetic: it hides the CURRENT, probe-derived mask set
from \`git status\` via one managed fenced block in \`git rev-parse --git-path info/exclude\`.
Only that block is ever written — never .gitignore, never a global excludesFile. --apply REPLACES
the whole block from a fresh derivation (stale masks drop by construction); an EMPTY derivation
over a non-empty block refuses unless --clear is given (you are probably outside the sandbox).
--clear always means REMOVE the managed block — it takes precedence over the derivation.
Watch note: an exclude rule hides a path from git status AND from bulk staging — a real file at
an excluded path is silently skipped by \`git add -A\`/\`git add .\` (explicit \`git add\` refuses
without -f), so it would stay out of your commits. The probe flags any fenced entry that became a
real path; delete that line first.

Exit codes: 0 ok (probe / applied / no-op); 1 refusal or error (loud); 2 usage.`;

const KNOWN_ARGS = new Set(['--help', '-h', '--apply', '--clear', '--json', '--cwd']);

export const main = (argv, ctx = {}) => {
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === '--cwd') { i += 1; continue; }
      if (!KNOWN_ARGS.has(argv[i])) throw fail(2, `unknown argument: ${argv[i]} (see --help)`);
    }
    const cwdIdx = argv.indexOf('--cwd');
    const cwd = cwdIdx !== -1 ? argv[cwdIdx + 1] : (ctx.cwd ?? process.cwd());
    if (cwdIdx !== -1 && (!cwd || cwd.startsWith('--'))) throw fail(2, '--cwd requires a directory argument');
    if (argv.includes('--clear') && !argv.includes('--apply')) throw fail(2, '--clear is only valid together with --apply');
    const probe = probeSandboxMasks({ cwd, ...(ctx.deps ?? {}) });
    if (probe == null) throw fail(1, `not a git work tree: ${cwd}`);
    if (!argv.includes('--apply')) {
      if (argv.includes('--json')) {
        const { lines: _lines, content: _content, ...rest } = probe;
        return { code: 0, stdout: JSON.stringify(rest, null, 2), stderr: '' };
      }
      return { code: 0, stdout: formatProbe(probe), stderr: '' };
    }
    const plan = planApply(probe, { clear: argv.includes('--clear') });
    // The unrenderable skips stay LOUD on EVERY apply path (codex R4) — the same warning the
    // probe prints; the renderable subset still applies (a refusal would block the useful masks).
    const skipWarnings = probe.unrenderable
      .map((rel) => `sandbox-masks: ⚠ mask name carries a newline or ends with a tab and cannot be expressed as ONE exclude rule — NOT written (the review domain already ignores the mask itself): ${JSON.stringify(rel)}`)
      .join('\n');
    // A refusal carries the unrenderable warnings too (codex R5) — they are never discarded.
    if (plan.action === 'refuse') throw fail(1, skipWarnings ? `${plan.reason}\n${skipWarnings}` : plan.reason);
    if (plan.action === 'noop') return { code: 0, stdout: `sandbox-masks: ${plan.reason}`, stderr: skipWarnings };
    const writeFile = ctx.deps?.writeFile ?? writeFileSync;
    const mkdir = ctx.deps?.mkdir ?? mkdirSync;
    const lstat = ctx.deps?.lstat ?? lstatSync;
    // The write never follows a symlink or clobbers a non-regular leaf (codex R2): every component
    // from the common git dir down is guarded, and an existing exclude leaf must be a regular file.
    try {
      assertContainedRealPath(probe.gitCommonDir, probe.excludeFile, { lstat });
    } catch (err) {
      throw fail(1, `refusing to write ${probe.excludeFile}: ${err.message}`);
    }
    const leaf = (() => {
      try {
        return lstat(probe.excludeFile);
      } catch {
        return null;
      }
    })();
    if (leaf != null && !leaf.isFile()) throw fail(1, `refusing to write ${probe.excludeFile}: the exclude path exists but is not a regular file`);
    mkdir(dirname(probe.excludeFile), { recursive: true });
    writeFile(probe.excludeFile, plan.content);
    const verb = plan.action === 'cleared' ? 'managed block removed (0 masks)' : `managed block replaced — ${plan.count} mask(s) hidden from git status`;
    return { code: 0, stdout: `sandbox-masks: ${verb} in ${probe.excludeFile}`, stderr: skipWarnings };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `sandbox-masks: ${err.message}` };
  }
};

const emitResult = (r) => {
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) emitResult(main(process.argv.slice(2)));
