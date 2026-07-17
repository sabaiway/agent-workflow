#!/usr/bin/env node
// hide-footprint.mjs — the kit's single hide-writer. Makes a HIDDEN-mode repo "look normal" by keeping
// the full AI/agent footprint (the kit's own artifacts + every known foreign tool's files) out of
// commits — in ONE managed, fenced block in the PROJECT-LOCAL `.git/info/exclude` (AD-014, amends
// AD-006). Never the machine-global `core.excludesFile`: visibility is a project setting, so its ignore
// must be project-scoped (the AD-013 `.claude/skills/` one-off, generalized).
//
// Registry → classify → splice, all with cwd = the resolved project dir and on repo-relative probe
// paths (the anchored gitignore form is NOT a git pathspec — a leading "/" reads as "outside
// repository"). Tracked-ness is read from `git ls-files` STDOUT (the index authority); an UNKNOWN git
// state fails CLOSED (typed STOP), never open. A tracked path is never silently un-tracked — only
// `git rm --cached` truly un-tracks it, which the tool PRINTS as guidance and never runs.
//
// Decisions (plan D1–D16): one managed fence, re-derived wholesale → re-run is byte-identical (zero
// diff); tracked → ASK; present-but-untracked high-risk (generic names) → ASK; everything else → HIDE;
// asks are excluded from the block unless opted in via `--include` (an asks-only, traversal/glob-free
// path). Add-local-first, then DETECT + REPORT the residual legacy global block — removal is the
// explicit, ASK-gated `--remove-global` (prints a restorable backup), never a default (an arbitrary
// host's OTHER hidden repo may rely on the same root-anchored global lines). Windows is supported (text
// edit; forward-slash patterns; CRLF preserved via EOL detection). Dependency-free, Node >= 22.

import {
  readFileSync, writeFileSync, statSync, readdirSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import {
  KIT_OWN_PATHS, KNOWN_FOOTPRINT, FOOTPRINT_STOP, stop,
  normalizeSlashes, isDirPattern, patternToProbe, expandGlob, matchesKnownGlob,
} from './known-footprint.mjs';

// ── managed-fence + legacy markers ──────────────────────────────────────────────

export const START_MARKER = '# >>> agent-workflow-kit hidden mode (managed; do not edit between markers) >>>';
export const END_MARKER = '# <<< agent-workflow-kit hidden mode <<<';

// Recognized legacy forms we ABSORB (local) or MIGRATE (global). Matched by prefix so a minor wording
// drift can't strand a line (D7/D8).
const isLegacyGlobalHeader = (t) => t.startsWith('# agent-workflow-kit hidden mode (machine-local');
const isAd013Comment = (t) => t.startsWith('# standalone local-dev agent skills');

// The HISTORICAL global path-sets a legacy deployment wrote to `core.excludesFile` — kit-old (the
// verified 11 lines), memory-old (memory's set, incl. the now-subsumed `.memory-version` /
// `.workflow-version` stamps), and the AD-013 standalone line. NOT the new (larger) KIT_OWN_PATHS, and
// NOT the new fence — only what an OLD deployment actually emitted (D7).
const HISTORICAL_GLOBAL_PATHS = new Set([
  '/AGENTS.md', '/CLAUDE.md', '/docs/ai/', '/docs/plans/',
  '/docs/ai/.memory-version', '/docs/ai/.workflow-version',
  '/scripts/_expect-shim.mjs',
  '/scripts/archive-changelog.mjs', '/scripts/archive-changelog.test.mjs',
  '/scripts/archive-issues.mjs', '/scripts/archive-issues.test.mjs',
  '/scripts/check-docs-size.mjs', '/scripts/check-docs-size.test.mjs',
  '/scripts/install-git-hooks.mjs',
  '/.claude/skills/',
]);

// Registry lookups. The external set excludes the glob (its concrete files are expanded on demand).
const REGISTRY_SET = new Set([...KIT_OWN_PATHS, ...KNOWN_FOOTPRINT.filter((e) => !e.glob).map((e) => e.pattern)]);
// LOW-RISK recognized patterns: the only ones absorb/preserve folds present-irrelevantly (D8). KIT_OWN
// are all low-risk; a high-risk foreign file is only ever folded when actually present (a candidate).
const LOWRISK_SET = new Set([
  ...KIT_OWN_PATHS,
  ...KNOWN_FOOTPRINT.filter((e) => !e.glob && !e.falsePositiveRisk).map((e) => e.pattern),
]);
const registryMetaFor = (pattern) => {
  if (KIT_OWN_PATHS.includes(pattern)) return { type: isDirPattern(pattern) ? 'dir' : 'file', falsePositiveRisk: false, owner: 'agent-workflow-kit' };
  const e = KNOWN_FOOTPRINT.find((x) => x.pattern === pattern);
  return e ? { type: e.type, falsePositiveRisk: e.falsePositiveRisk, owner: e.owner } : { type: isDirPattern(pattern) ? 'dir' : 'file', falsePositiveRisk: false, owner: 'unknown' };
};

// Map a possibly slash-variant pattern to its registry canonical form, or null if unknown.
const canonicalize = (pattern) => {
  const p = normalizeSlashes(pattern);
  if (REGISTRY_SET.has(p)) return p;
  if (REGISTRY_SET.has(`${p}/`)) return `${p}/`;
  if (p.endsWith('/') && REGISTRY_SET.has(p.slice(0, -1))) return p.slice(0, -1);
  return null;
};

// Recognize a pre-existing HIDE RULE — a registry pattern OR a concrete child of a `glob:true` entry
// (e.g. `/.github/copilot-instructions.md`, which is NOT itself a registry pattern). Returns the
// canonical form, or null. This makes prior consent survive a re-run for a glob-backed entry:
// canonicalize alone misses glob children, so the consented line would be dropped → a silent un-hide.
const recognizeHideRule = (pattern) => canonicalize(pattern) ?? (matchesKnownGlob(pattern) ? normalizeSlashes(pattern) : null);

// Slash-tolerant membership in the HISTORICAL global set.
const historicalMatch = (pattern) => {
  const p = normalizeSlashes(pattern);
  return HISTORICAL_GLOBAL_PATHS.has(p) || HISTORICAL_GLOBAL_PATHS.has(`${p}/`) || (p.endsWith('/') && HISTORICAL_GLOBAL_PATHS.has(p.slice(0, -1)));
};

// ── EOL + line model ────────────────────────────────────────────────────────────

// EOL detected from the file's first line; empty/missing → LF (D2, Review fold agy#6).
const detectEol = (content) => {
  const i = content.indexOf('\n');
  if (i <= 0) return '\n';
  return content[i - 1] === '\r' ? '\r\n' : '\n';
};
// Split into logical lines; `lines.join(eol)` reproduces the structure (CRLF normalized to `eol`).
const splitLines = (content) => (content === '' ? [] : content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n'));
// Re-join, dropping trailing blank lines and ending with exactly one EOL (canonical, idempotent).
const joinLines = (lines, eol) => {
  const out = [...lines];
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.length ? `${out.join(eol)}${eol}` : '';
};

// A raw exclude line → an anchored pattern (leading "/"), or null when blank/comment.
const lineToPattern = (raw) => {
  const t = normalizeSlashes(raw).trim();
  if (t === '' || t.startsWith('#')) return null;
  return t.startsWith('/') ? t : `/${t}`;
};

// ── git runner (injectable) ──────────────────────────────────────────────────────

// One git invocation → { status, stdout, stderr }. execFileSync THROWS on a non-zero exit, so a "no
// match" (check-ignore exit 1) arrives via the catch — captured, not raised. A missing git binary
// (ENOENT) has status null → a STOP (the agent host can't run git; reported with the concrete reason).
const defaultGit = (args, { cwd, env }) => {
  try {
    const stdout = execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    if (err && err.code === 'ENOENT') throw stop(`cannot run git (${err.code}) — the agent host has no usable git on PATH`);
    return { status: err.status ?? null, stdout: (err.stdout ?? '').toString(), stderr: (err.stderr ?? '').toString() };
  }
};
const runGit = (deps, dir, args) => (deps.git ?? defaultGit)(args, { cwd: dir, env: deps.env ?? process.env });

const fsOf = (deps = {}) => ({
  readFile: deps.readFile ?? ((p) => readFileSync(p, 'utf8')),
  writeFile: deps.writeFile ?? ((p, c) => writeFileSync(p, c, 'utf8')),
  stat: deps.stat ?? statSync,
  readdir: deps.readdir ?? readdirSync,
});
const expandTilde = (p, home) => (p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p);

// ── git probes ────────────────────────────────────────────────────────────────────

// The resolved project-local exclude file — worktree/submodule-safe (NEVER a hardcoded path).
export const excludePath = (deps, dir) => {
  const r = runGit(deps, dir, ['rev-parse', '--git-path', 'info/exclude']);
  if (r.status !== 0) throw stop(`cannot resolve info/exclude (git rev-parse exit ${r.status}): ${r.stderr.trim()}`);
  const rel = r.stdout.trim();
  return isAbsolute(rel) ? rel : join(dir, rel);
};

// Tracked-ness from the INDEX: `git ls-files` STDOUT non-empty ⇒ tracked. Empty + exit 0 ⇒ untracked.
// Any nonzero / stderr ⇒ UNKNOWN ⇒ typed STOP (fail-closed — UNKNOWN never counts as safe-to-hide).
export const isTracked = (probe, deps, dir) => {
  const r = runGit(deps, dir, ['ls-files', '-z', '--', probe]);
  if (r.status !== 0 || (r.stderr && r.stderr.trim() !== '')) {
    throw stop(`git ls-files UNKNOWN state (exit ${r.status}) for ${probe}: ${r.stderr.trim()}`);
  }
  return r.stdout.replace(/\0/g, '').length > 0;
};

// `git check-ignore -v` → { ignored, source }. Exit 0 = ignored (verbose line carries the winning
// source); exit 1 = NOT ignored (normal); exit 128 = STOP. The index is respected: a tracked path
// reports exit 1 here (so tracked-ness is read from ls-files, never inferred from this).
export const checkIgnore = (probe, deps, dir) => {
  const r = runGit(deps, dir, ['check-ignore', '-v', '--', probe]);
  if (r.status === 1) return { ignored: false, source: null };
  if (r.status !== 0) throw stop(`git check-ignore failed (exit ${r.status}) for ${probe}: ${r.stderr.trim()}`);
  const out = r.stdout.split('\n').find((l) => l.trim() !== '') ?? '';
  const tab = out.lastIndexOf('\t');
  const left = tab >= 0 ? out.slice(0, tab) : out;
  const m = left.match(/^(.*):(\d+):(.*)$/);
  return { ignored: true, source: m ? m[1] : null, pattern: m ? m[3] : null };
};

// Is `source` a `.gitignore` that lives INSIDE the repo AND is tracked? Guards against a machine-global
// `core.excludesFile` that happens to be NAMED `.gitignore` (basename collision): such a source resolves
// OUTSIDE the repo, so feeding its relative path to `git ls-files` would error ("outside repository")
// and STOP the run — it is not a project `.gitignore` and must not be treated as one.
const isTrackedRepoGitignore = (source, deps, dir) => {
  if (!source || basename(source) !== '.gitignore') return false;
  const rel = relative(dir, resolve(dir, source));
  if (rel.startsWith('..') || isAbsolute(rel)) return false; // outside the repo → not a project .gitignore
  return isTracked(rel || '.gitignore', deps, dir);
};

// Does a TRACKED `.gitignore` already cover this path? (Only then is a candidate dropped as redundant.)
const coveredByTrackedGitignore = (probe, deps, dir) => {
  const ci = checkIgnore(probe, deps, dir);
  return ci.ignored ? isTrackedRepoGitignore(ci.source, deps, dir) : false;
};

const presentOnDisk = (pattern, fsx, dir) => {
  const probe = patternToProbe(pattern).replace(/\/$/, '');
  try {
    fsx.stat(join(dir, probe));
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw stop(`cannot stat ${join(dir, probe)} (${err.code ?? 'fs error'})`);
  }
};

// ── visibility inference (D16) ──────────────────────────────────────────────────

// A deployment does not record its chosen visibility. Infer it from the kit's anchor artifact:
//   tracked/committed                 → VISIBLE  (the hide tool must write zero bytes — D10)
//   untracked AND ignored             → HIDDEN   (run the reconcile)
//   untracked AND not ignored         → AMBIGUOUS (fresh-uncommitted vs broken-hidden → the agent ASKs)
export const inferVisibility = (deps, dir, fsx = fsOf(deps)) => {
  const anchors = ['/AGENTS.md', '/docs/ai/'];
  // VISIBLE keys on tracked-ness (git state), not disk presence — a committed-but-deleted AGENTS.md is
  // still visible. Check BOTH anchors before falling through to the ignored/ambiguous test.
  for (const a of anchors) {
    if (isTracked(patternToProbe(a), deps, dir)) return { visibility: 'visible', anchor: a, tracked: true, ignored: false };
  }
  const anchor = anchors.find((a) => presentOnDisk(a, fsx, dir)) ?? anchors[0];
  const ci = checkIgnore(patternToProbe(anchor), deps, dir);
  if (ci.ignored) return { visibility: 'hidden', anchor, tracked: false, ignored: true };
  return { visibility: 'ambiguous', anchor, tracked: false, ignored: false };
};

// ── classify (D4 — one algorithm, exact order) ───────────────────────────────────

// Per candidate, in order: (1) tracked → ASK; (2) untracked & a tracked .gitignore already covers it →
// DROP (redundant); (3) present high-risk (generic name) → ASK; (4) HIDE.
const classifyOne = (cand, deps, dir, fsx) => {
  const probe = patternToProbe(cand.pattern);
  if (isTracked(probe, deps, dir)) {
    return { ...cand, verdict: 'ask-tracked', reason: 'tracked in git — an exclude does nothing; un-track with `git rm --cached` to hide (never done silently)' };
  }
  if (coveredByTrackedGitignore(probe, deps, dir)) return { ...cand, verdict: 'drop', reason: 'already covered by a tracked .gitignore (redundant)' };
  if (cand.falsePositiveRisk && presentOnDisk(cand.pattern, fsx, dir)) {
    return { ...cand, verdict: 'ask-risk', reason: `present but its name is generic (${cand.owner}) — confirm before hiding` };
  }
  return { ...cand, verdict: 'hide', reason: 'untracked footprint — hide' };
};

// ── candidate assembly ───────────────────────────────────────────────────────────

const assembleCandidates = (deps, dir, fsx, forcedPreserve) => {
  const byPattern = new Map();
  const add = (pattern, meta) => { if (!byPattern.has(pattern)) byPattern.set(pattern, { pattern, ...meta }); };
  for (const p of KIT_OWN_PATHS) add(p, { type: isDirPattern(p) ? 'dir' : 'file', falsePositiveRisk: false, owner: 'agent-workflow-kit', origin: 'kit-own' });
  for (const e of KNOWN_FOOTPRINT) {
    if (e.glob) {
      for (const f of expandGlob(e.pattern, { dir, readdir: fsx.readdir, stat: fsx.stat })) {
        add(f, { type: 'file', falsePositiveRisk: e.falsePositiveRisk, owner: e.owner, origin: 'external' });
      }
    } else if (presentOnDisk(e.pattern, fsx, dir)) {
      add(e.pattern, { type: e.type, falsePositiveRisk: e.falsePositiveRisk, owner: e.owner, origin: 'external' });
    }
  }
  // Pre-existing recognized LOW-RISK rules (absorbed bare lines + current fence body) are a deliberate
  // prior local decision — kept regardless of on-disk presence (D8).
  for (const p of forcedPreserve) add(p, { ...registryMetaFor(p), origin: 'preserved' });
  return [...byPattern.values()];
};

// ── block build + splice (D2) ────────────────────────────────────────────────────

export const buildBlock = (patterns) => [...new Set(patterns)].sort();

// Find the managed fence in a line array. { state:'none' } | { state:'ok', startIdx, endIdx } |
// { state:'malformed', reason }. Malformed → caller STOPs with the file byte-for-byte unchanged.
const findFence = (lines) => {
  const starts = lines.map((l, i) => (l === START_MARKER ? i : -1)).filter((i) => i >= 0);
  const ends = lines.map((l, i) => (l === END_MARKER ? i : -1)).filter((i) => i >= 0);
  if (starts.length === 0 && ends.length === 0) return { state: 'none' };
  if (starts.length !== 1 || ends.length !== 1) return { state: 'malformed', reason: `expected exactly one managed marker pair, found ${starts.length} start / ${ends.length} end` };
  if (ends[0] < starts[0]) return { state: 'malformed', reason: 'end marker precedes start marker' };
  return { state: 'ok', startIdx: starts[0], endIdx: ends[0] };
};

// ── absorb (local pre-existing recognized lines → folded into the fence) ──────────

// Remove recognized pre-existing bare hide rules + their orphan comment headers (AD-013 / a stray
// legacy header) from OUTSIDE the fence; return the cleaned lines + the canonical patterns recognized
// (D8). A recognized line is a prior local decision to hide → consent, folded into the single managed
// block. Low-risk rules fold regardless of presence (D8 preserve). A HIGH-RISK rule folds as consent
// only while its file is still PRESENT; if its file is absent it is left exactly as-is (a deliberate
// pre-emptive user hide is never silently removed, and there is no present-file report mismatch).
const absorbOutside = (outsideLines, isPresent) => {
  const kept = [];
  const absorbed = [];
  for (const raw of outsideLines) {
    const t = raw.trim();
    if (isAd013Comment(t) || isLegacyGlobalHeader(t)) continue; // orphan header for an absorbed rule
    const pat = lineToPattern(raw);
    const canon = pat ? recognizeHideRule(pat) : null;
    if (canon && (LOWRISK_SET.has(canon) || isPresent(canon))) {
      absorbed.push(canon);
      continue;
    }
    kept.push(raw); // unrecognized, or a high-risk recognized rule whose file is absent → leave it
  }
  return { kept, absorbed };
};

// ── verify (D5 — over the WROTE set; "hidden" ≡ untracked ∧ ignored-by-OUR-source) ─

const verifyPath = (pattern, deps, dir, excludeFile) => {
  const probe = patternToProbe(pattern);
  const tracked = isTracked(probe, deps, dir);
  const ci = checkIgnore(probe, deps, dir);
  let hidden = false;
  if (!tracked && ci.ignored && ci.source) {
    if (resolve(dir, ci.source) === resolve(dir, excludeFile)) hidden = true;
    else if (isTrackedRepoGitignore(ci.source, deps, dir)) hidden = true;
  }
  return { path: pattern, tracked, ignored: ci.ignored, source: ci.source, hidden };
};

// ── global migration (D6/D7/D12) ─────────────────────────────────────────────────

const globalExcludesPath = (deps, dir, home) => {
  const r = runGit(deps, dir, ['config', '--get', 'core.excludesFile']);
  if (r.status === 1) return null; // unset = NORMAL "nothing to migrate" (not a STOP)
  if (r.status !== 0) throw stop(`git config --get core.excludesFile failed (exit ${r.status}): ${r.stderr.trim()}`);
  const p = r.stdout.trim();
  return p ? expandTilde(p, home) : null;
};

// Detect + REPORT a residual legacy global block; remove ONLY contiguous recognized runs (header +
// historical paths) and ONLY when removeGlobal — printing the removed lines as a restorable backup.
export const migrateFromGlobal = (deps, dir, { home, removeGlobal, dryRun }) => {
  const fsx = fsOf(deps);
  const gp = globalExcludesPath(deps, dir, home);
  if (!gp) return { found: false, source: null, removedLines: [], action: 'none' };
  let content;
  try {
    content = fsx.readFile(gp);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { found: false, source: gp, removedLines: [], action: 'none' };
    throw stop(`cannot read global excludes ${gp} (${err.code ?? 'fs error'})`);
  }
  const eol = detectEol(content);
  const lines = splitLines(content);
  const recognized = (raw) => {
    const t = raw.trim();
    if (isLegacyGlobalHeader(t) || isAd013Comment(t)) return true;
    const pat = lineToPattern(raw);
    return pat ? historicalMatch(pat) : false;
  };
  const kept = [];
  const removed = [];
  let i = 0;
  while (i < lines.length) {
    if (recognized(lines[i])) {
      while (i < lines.length && recognized(lines[i])) { removed.push(lines[i]); i += 1; }
    } else {
      kept.push(lines[i]);
      i += 1;
    }
  }
  if (removed.length === 0) return { found: false, source: gp, removedLines: [], action: 'none' };
  if (!removeGlobal) return { found: true, source: gp, removedLines: removed, action: 'kept' };
  if (!dryRun) fsx.writeFile(gp, joinLines(kept, eol));
  return { found: true, source: gp, removedLines: removed, action: 'removed', backup: removed.join('\n') };
};

// ── --include validation (D4 — only an asks[] path; no traversal/glob) ───────────

const canonicalizeIncludeArg = (arg) => {
  const t = normalizeSlashes(arg).trim();
  if (t.includes('*')) throw stop(`--include rejects a glob: ${arg}`);
  if (t.split('/').includes('..')) throw stop(`--include rejects traversal: ${arg}`);
  return t.startsWith('/') ? t : `/${t}`;
};
// An include matches an asks[] entry by its anchored pattern, slash-insensitively (file vs dir form).
const matchAsk = (canon, asks) => asks.find((a) => a.pattern === canon || a.pattern === `${canon}/` || (canon.endsWith('/') && a.pattern === canon.slice(0, -1)));

// ── core: compute the plan, then (optionally) apply it ───────────────────────────

export const hideFootprint = (opts = {}, deps = {}) => {
  const dir = resolve(opts.dir ?? process.cwd());
  const home = deps.home ?? os.homedir();
  const fsx = fsOf(deps);
  const dryRun = !!opts.dryRun;
  const excludeFile = excludePath(deps, dir);

  // Upgrade reconcile self-detects visibility first; bootstrap/delegated callers assert hidden.
  if (opts.reconcile) {
    const vis = inferVisibility(deps, dir, fsx);
    if (vis.visibility !== 'hidden') {
      return { excludeFile, action: 'noop', visibility: vis.visibility, anchor: vis.anchor, ambiguous: vis.visibility === 'ambiguous', wrote: [], asks: [], needsUntrack: [], dropped: [], verify: [], global: { action: 'skipped' } };
    }
  }

  const content = (() => {
    try {
      return fsx.readFile(excludeFile);
    } catch (err) {
      if (err && err.code === 'ENOENT') return '';
      throw stop(`cannot read ${excludeFile} (${err.code ?? 'fs error'})`);
    }
  })();
  const eol = detectEol(content);
  const lines = splitLines(content);
  const fence = findFence(lines);
  if (fence.state === 'malformed') throw stop(`refusing to edit a malformed managed block in ${excludeFile}: ${fence.reason} (file left unchanged)`);

  const before = fence.state === 'ok' ? lines.slice(0, fence.startIdx) : lines;
  const fenceBodyLines = fence.state === 'ok' ? lines.slice(fence.startIdx + 1, fence.endIdx) : [];
  const after = fence.state === 'ok' ? lines.slice(fence.endIdx + 1) : [];

  // ── unhide (D12): drop our fence; report/remove the residual global block ──────
  if (opts.unhide) {
    const global = migrateFromGlobal(deps, dir, { home, removeGlobal: opts.removeGlobal, dryRun });
    const newLines = [...before, ...after];
    const newContent = joinLines(newLines, eol);
    const changed = newContent !== content;
    if (changed && !dryRun) fsx.writeFile(excludeFile, newContent);
    return { excludeFile, action: fence.state === 'ok' ? (changed ? 'unhidden' : 'noop') : 'noop', visibility: 'hidden', wrote: [], asks: [], needsUntrack: [], dropped: [], verify: [], global };
  }

  // ── absorb pre-existing recognized lines, assemble + classify candidates ───────
  const isPresentCanon = (canon) => presentOnDisk(canon, fsx, dir);
  const { kept: cleanBefore, absorbed: absorbedBefore } = absorbOutside(before, isPresentCanon);
  const { kept: cleanAfter, absorbed: absorbedAfter } = absorbOutside(after, isPresentCanon);
  const fenceBodyPatterns = fenceBodyLines.map((l) => recognizeHideRule(lineToPattern(l) ?? '')).filter(Boolean);
  // Every pre-existing recognized hide rule (current fence body + absorbed loose lines, glob children
  // included) is prior consent. LOW-RISK rules are force-preserved as candidates regardless of presence
  // (D8); HIGH-RISK ones survive only while present (handled via the present-candidate path + consent).
  const recognizedExisting = [...new Set([...absorbedBefore, ...absorbedAfter, ...fenceBodyPatterns])];
  const forcedPreserve = recognizedExisting.filter((p) => LOWRISK_SET.has(p));

  const classified = assembleCandidates(deps, dir, fsx, forcedPreserve).map((c) => classifyOne(c, deps, dir, fsx));
  const hideSet = classified.filter((c) => c.verdict === 'hide');
  const asks = classified.filter((c) => c.verdict === 'ask-tracked' || c.verdict === 'ask-risk');
  const dropped = classified.filter((c) => c.verdict === 'drop');

  // Effective include = HIDE ∪ prior in-fence consent (still-ASK paths) ∪ this-run --include.
  const includeArgs = (opts.include ?? []).map(canonicalizeIncludeArg);
  const includedFromFlags = includeArgs.map((canon) => {
    const a = matchAsk(canon, asks);
    if (!a) throw stop(`--include ${canon} is not one of this run's asks — it can only opt in a path the tool surfaced`);
    return a;
  });
  const priorConsent = asks.filter((a) => recognizedExisting.includes(a.pattern));
  const includedAsks = [...new Map([...includedFromFlags, ...priorConsent].map((a) => [a.pattern, a])).values()];

  const writtenList = [...hideSet, ...includedAsks];
  const writtenPatterns = buildBlock(writtenList.map((c) => c.pattern));
  const needsUntrack = includedAsks.filter((a) => a.verdict === 'ask-tracked');

  // ── build the new file (splice the fence; preserve outside lines) ──────────────
  const fenceLines = writtenPatterns.length ? [START_MARKER, ...writtenPatterns, END_MARKER] : [];
  const newLines = writtenPatterns.length
    ? [...cleanBefore, ...fenceLines, ...cleanAfter]
    : [...cleanBefore, ...cleanAfter];
  const newContent = joinLines(newLines, eol);
  const changed = newContent !== content;
  if (changed && !dryRun) fsx.writeFile(excludeFile, newContent);

  // ── verify (post-write) every WROTE path; the hidden invariant GATES every written UNTRACKED
  //    path (the auto-HIDE set AND consented present-high-risk hides) — only TRACKED needsUntrack
  //    paths are exempt (an exclude cannot hide a tracked file; they carry `git rm --cached`) (D5) ──
  const verify = dryRun ? [] : writtenList.map((c) => verifyPath(c.pattern, deps, dir, excludeFile));
  const notHidden = verify.filter((v) => !v.hidden && !v.tracked);
  if (notHidden.length) {
    throw stop(`hide verification failed — these were written but are not hidden by the project-local exclude: ${notHidden.map((v) => v.path).join(', ')}`);
  }

  // ── then detect/report (or remove) the residual legacy global block (D6) ───────
  const global = migrateFromGlobal(deps, dir, { home, removeGlobal: opts.removeGlobal, dryRun });

  const action = !changed ? 'noop' : fence.state === 'ok' ? 'updated' : 'created';
  return {
    excludeFile,
    action,
    visibility: 'hidden',
    wrote: writtenPatterns,
    asks: asks.filter((a) => !includedAsks.some((i) => i.pattern === a.pattern)).map((a) => ({ path: a.pattern, reason: a.reason, owner: a.owner })),
    needsUntrack: needsUntrack.map((a) => {
      const target = patternToProbe(a.pattern).replace(/\/$/, '');
      return { path: a.pattern, command: isDirPattern(a.pattern) ? `git rm --cached -r -- ${target}` : `git rm --cached -- ${target}` };
    }),
    dropped: dropped.map((d) => d.pattern),
    verify,
    global,
  };
};

// ── CLI ───────────────────────────────────────────────────────────────────────────

const USAGE = `usage: hide-footprint [--dir <project>] [--reconcile] [--include=<path>]... [--keep-global | --remove-global] [--unhide] [--dry-run] [--help]

  --dir <project>     the target project (default: cwd)
  --reconcile         upgrade mode — infer visibility first; write zero bytes when VISIBLE, ASK when AMBIGUOUS
  --include=<path>    opt a surfaced ASK path into the hidden set (only an asks[] path; no glob/traversal)
  --keep-global       keep + report the residual legacy machine-global block (DEFAULT)
  --remove-global     remove the recognized legacy machine-global block (prints a restorable backup)
  --unhide            remove the project-local managed block (residual global only with --remove-global)
  --dry-run           print the plan; change nothing
  --help, -h          this help

Writes ONE managed block in the PROJECT-LOCAL .git/info/exclude (never the machine-global excludes).
Tracked files are never silently un-tracked — the tool prints the \`git rm --cached\` it will not run.`;

const parseArgs = (argv) => {
  const out = { dir: undefined, reconcile: false, include: [], removeGlobal: false, keepGlobal: false, unhide: false, dryRun: false, help: false, bad: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--reconcile') out.reconcile = true;
    else if (a === '--unhide') out.unhide = true;
    else if (a === '--keep-global') out.keepGlobal = true;
    else if (a === '--remove-global') out.removeGlobal = true;
    else if (a === '--dir') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) out.bad = '--dir needs a path argument';
      else { out.dir = next; i += 1; }
    } else if (a.startsWith('--include=')) out.include.push(a.slice('--include='.length));
    else if (a === '--include') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) out.bad = '--include needs a path argument';
      else { out.include.push(next); i += 1; }
    } else out.bad = `unknown argument: ${a}`;
  }
  if (out.keepGlobal && out.removeGlobal) out.bad = '--keep-global and --remove-global are mutually exclusive';
  return out;
};

const fmtGlobal = (g) => {
  if (!g || g.action === 'none' || g.action === 'skipped') return [];
  if (g.action === 'kept') return [`  • residual legacy machine-global block in ${g.source} (${g.removedLines.filter((l) => l.trim() && !l.trim().startsWith('#')).length} path line(s)) — KEPT + reported; pass --remove-global to remove (with a printed backup)`];
  if (g.action === 'removed') return [`  • removed the legacy machine-global block from ${g.source} (backup of ${g.removedLines.length} line(s) printed below)`, ...g.removedLines.map((l) => `      | ${l}`)];
  return [];
};

const formatReport = (r, dryRun) => {
  const lines = [dryRun ? 'hide-footprint — DRY RUN (no changes)' : 'hide-footprint'];
  if (r.visibility === 'visible') return [...lines, `  • deployment is VISIBLE (anchor ${r.anchor} is tracked) — nothing to hide; wrote zero bytes`].join('\n');
  if (r.ambiguous) return [...lines, `  • AMBIGUOUS visibility (anchor ${r.anchor} is untracked AND not ignored) — cannot tell fresh-uncommitted from broken-hidden; ASK the user before writing`].join('\n');
  lines.push(`  • ${r.action} ${r.excludeFile}`);
  // The block contains every written pattern, but a TRACKED --include path is NOT hidden by it (it is
  // reported separately, below) — so the "hidden" line lists only the genuinely-hidden untracked paths.
  const untrackedOnly = new Set(r.needsUntrack.map((n) => n.path));
  const hiddenNow = r.wrote.filter((p) => !untrackedOnly.has(p));
  if (hiddenNow.length) lines.push(`  • hidden (${hiddenNow.length}): ${hiddenNow.join(', ')}`);
  for (const a of r.asks) lines.push(`  • ASK ${a.path} — ${a.reason}`);
  for (const n of r.needsUntrack) lines.push(`  • tracked, NOT hidden: ${n.path} — run \`${n.command}\` to un-track (kept on disk)`);
  if (r.dropped.length) lines.push(`  • skipped ${r.dropped.length} already-ignored (tracked .gitignore)`);
  lines.push(...fmtGlobal(r.global));
  return lines.join('\n');
};

export const main = (argv = process.argv.slice(2), deps = {}) => {
  const log = deps.log ?? console.log;
  const errlog = deps.errlog ?? console.error;
  const args = parseArgs(argv);
  if (args.help) { log(USAGE); return 0; }
  if (args.bad) { errlog(args.bad); errlog(USAGE); return 2; }
  try {
    const result = hideFootprint(
      { dir: args.dir, dryRun: args.dryRun, reconcile: args.reconcile, include: args.include, removeGlobal: args.removeGlobal, unhide: args.unhide },
      deps,
    );
    log(formatReport(result, args.dryRun));
    return 0;
  } catch (err) {
    if (err && err.code === FOOTPRINT_STOP) { errlog(err.message); return 1; }
    throw err;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exit(main(process.argv.slice(2)));
