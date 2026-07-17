#!/usr/bin/env node
// known-footprint.mjs — the kit-owned registry of what "hidden mode" must keep out of a repo.
//
// Two registries, both holding ANCHORED gitignore patterns (repo-root-relative, leading "/"):
//   KIT_OWN_PATHS   — the kit's OWN deployed artifacts (AGENTS.md, docs/ai/, the added scripts, the
//                     attribution settings). Always candidates in hidden mode.
//   KNOWN_FOOTPRINT — every OTHER AI/agent tool's footprint (Claude skills, Cursor, Windsurf, Gemini,
//                     Copilot, Aider, Continue, …) that would otherwise leak into a commit. Only the
//                     ones PRESENT on disk become candidates (no pre-emptive hiding of absent paths).
//
// Source of truth is here, not an on-disk manifest (the AD-008 `KNOWN_BACKENDS` pattern): a foreign
// tool's footprint has no file in the kit tarball to read, so the per-tool facts must live in-tool.
// The drift-guard test (known-footprint.test.mjs) keeps the registry honest — a frozen snapshot +
// count sentinel + intrinsic invariants (anchoring, uniqueness, disjointness, no subsumption) — and
// references/contracts.md carries the human-readable mirror table, kept in sync by review.
//
// Pure, dependency-free, Node >= 22. The only fs touch is expandGlob (readdir/stat of a glob parent),
// injected so the registry stays unit-testable without the real filesystem.

import { readdirSync, statSync } from 'node:fs';

// A typed STOP — a deliberate refusal we surface (never a silent skip, never a fail-open). Shared by
// the writer tool (hide-footprint.mjs imports it) so both speak one error vocabulary. The codebase's
// typed-error idiom: Object.assign(new Error(), { code }) — no classes (agent_rules §2.3).
export const FOOTPRINT_STOP = 'FOOTPRINT_STOP';
export const stop = (message, fields = {}) =>
  Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'FootprintStop', code: FOOTPRINT_STOP, ...fields });

// ── registries ────────────────────────────────────────────────────────────────

// The kit's OWN footprint — canonical anchored patterns. `/docs/ai/` subsumes the deployment stamp
// (`.workflow-version`); the 8 enforcement scripts are enumerated (no bare `/scripts/` — a host repo
// may have unrelated scripts). `/.claude/settings.json` is carried HIDDEN-ONLY: in hidden mode the
// kit's own attribution file is a footprint; in visible mode the kit commits it and never runs this
// tool. It passes the same tracked→ASK classifier, so a project that already commits it gets an ASK,
// never a silent un-track. `/docs/plans/` + both `.claude/settings*.json` are listed because a pure
// hidden deploy has no tracked `.gitignore`; the classifier drops any candidate a tracked `.gitignore`
// already covers, so in a repo that DOES track those ignores they are never re-written.
export const KIT_OWN_PATHS = [
  '/AGENTS.md',
  '/CLAUDE.md',
  '/docs/ai/',
  '/scripts/_expect-shim.mjs',
  '/scripts/archive-changelog.mjs',
  '/scripts/archive-changelog.test.mjs',
  '/scripts/archive-decisions.mjs',
  '/scripts/archive-decisions.test.mjs',
  '/scripts/archive-issues.mjs',
  '/scripts/archive-issues.test.mjs',
  '/scripts/check-docs-size.mjs',
  '/scripts/check-docs-size.test.mjs',
  '/scripts/install-git-hooks.mjs',
  '/docs/plans/',
  '/.claude/settings.local.json',
  '/.claude/settings.json',
];

// Every OTHER tool's footprint. `falsePositiveRisk` flags a name generic/ambiguous enough that a
// present-but-untracked instance should be ASKed about rather than hidden by default (D-policy A).
// `glob:true` marks the ONE reviewed wildcard (`/.github/copilot-*`) — it is expanded against the
// filesystem (expandGlob) to concrete present files before any git probe; never fed to ls-files.
export const KNOWN_FOOTPRINT = [
  { pattern: '/.claude/skills/', owner: 'Claude Code', type: 'dir', falsePositiveRisk: false, note: 'local-dev skills; absorbs the AD-013 one-off' },
  { pattern: '/.claude/agents/', owner: 'Claude Code', type: 'dir', falsePositiveRisk: false, note: 'project subagent definitions (incl. the kit-placed cheap-lane vehicles)' },
  { pattern: '/.claude/hooks/', owner: 'Claude Code', type: 'dir', falsePositiveRisk: false, note: 'project hooks (incl. the kit-placed gate-approval hook)' },
  { pattern: '/.cursor/rules/', owner: 'Cursor', type: 'dir', falsePositiveRisk: false, note: 'project rule files' },
  { pattern: '/.cursorrules', owner: 'Cursor (legacy)', type: 'file', falsePositiveRisk: true, note: 'legacy single-file rules' },
  { pattern: '/.codeium/', owner: 'Codeium/Windsurf', type: 'dir', falsePositiveRisk: false, note: 'home-scoped launchers live under ~/, out of scope' },
  { pattern: '/.windsurf/', owner: 'Windsurf (Devin)', type: 'dir', falsePositiveRisk: false, note: 'project config dir' },
  { pattern: '/.windsurfrules', owner: 'Windsurf', type: 'file', falsePositiveRisk: true, note: 'legacy single-file rules' },
  { pattern: '/GEMINI.md', owner: 'Gemini/Antigravity', type: 'file', falsePositiveRisk: true, note: 'context file; generic name' },
  { pattern: '/.antigravity.md', owner: 'Antigravity', type: 'file', falsePositiveRisk: true, note: 'context file' },
  { pattern: '/.github/copilot-*', owner: 'GitHub Copilot', type: 'file', falsePositiveRisk: true, glob: true, note: 'covers copilot-instructions.md; the one reviewed glob' },
  { pattern: '/.aider.conf.yml', owner: 'Aider', type: 'file', falsePositiveRisk: false, note: 'config' },
  { pattern: '/.aider.chat.history.md', owner: 'Aider', type: 'file', falsePositiveRisk: false, note: 'chat history' },
  { pattern: '/.aider.input.history', owner: 'Aider', type: 'file', falsePositiveRisk: false, note: 'input history' },
  { pattern: '/.continue/', owner: 'Continue', type: 'dir', falsePositiveRisk: false, note: 'project config dir' },
];

// ── pure pattern helpers ────────────────────────────────────────────────────────

// Forward-slash normalize (Windows `\` → `/`) — every fs/git path is compared in this canonical form.
export const normalizeSlashes = (p) => p.replace(/\\/g, '/');

// A pattern naming a directory ends with a trailing "/". Used to derive the type of a bare KIT_OWN
// pattern (KNOWN_FOOTPRINT entries carry an explicit `type`).
export const isDirPattern = (pattern) => normalizeSlashes(pattern).endsWith('/');

// Is this an unexpanded glob pattern? (Only `/.github/copilot-*` today — `glob:true` in the registry.)
export const isGlobPattern = (pattern) => normalizeSlashes(pattern).includes('*');

// Convert an ANCHORED gitignore pattern to a repo-relative probe path for `git ls-files` /
// `git check-ignore` (both run with cwd = the project dir, so the probe must be repo-relative, NOT
// the leading-"/" gitignore form which git reads as an absolute path → "outside repository", exit 128).
// Strips the leading "/", preserves a trailing "/" (dir), rejects traversal, and REFUSES a glob — a
// glob must be expandGlob'd to concrete files first (never handed to git verbatim).
export const patternToProbe = (pattern) => {
  const p = normalizeSlashes(pattern);
  if (p.includes('*')) throw stop(`refusing to probe an unexpanded glob: ${pattern} (expandGlob it first)`);
  if (p.split('/').includes('..')) throw stop(`refusing a traversal pattern: ${pattern}`);
  if (!p.startsWith('/')) throw stop(`pattern is not anchored (must start with "/"): ${pattern}`);
  return p.slice(1); // keeps a trailing "/" for dir patterns
};

// Turn a basename glob (`copilot-*`) into an anchored regex. Only a single-level `*` is supported
// (no `**`, no `/`): split on `*`, regex-escape each literal segment, then join with `.*`.
const basenameGlobToRegExp = (glob) => {
  const parts = glob.split('*').map((seg) => seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.*')}$`);
};

// Expand a `glob:true` registry pattern against the filesystem → the anchored canonical patterns of
// the concrete present FILES it matches (each is then probed/classified on its own). One directory
// level only: readdir the glob's parent, match basenames, keep regular files. An absent parent →
// no candidates (empty array); any OTHER fs error → typed STOP (fail-closed, never a silent drop).
// Is a CONCRETE anchored path (e.g. `/.github/copilot-instructions.md`) a child that a `glob:true`
// registry entry would match? Recognizes an already-written/consented glob expansion (the concrete
// file, not the glob pattern) as a pre-existing hide rule — so consent survives a re-run.
export const matchesKnownGlob = (pattern) => {
  const p = normalizeSlashes(pattern);
  return KNOWN_FOOTPRINT.some((e) => {
    if (!e.glob) return false;
    const probe = normalizeSlashes(e.pattern).slice(1); // ".github/copilot-*"
    const slash = probe.lastIndexOf('/');
    if (slash === -1) return false;
    const parent = `/${probe.slice(0, slash)}`; // "/.github"
    const base = probe.slice(slash + 1); // "copilot-*"
    if (!p.startsWith(`${parent}/`)) return false;
    const tail = p.slice(parent.length + 1);
    return !tail.includes('/') && basenameGlobToRegExp(base).test(tail);
  });
};

export const expandGlob = (pattern, { dir, readdir = readdirSync, stat = statSync } = {}) => {
  const p = normalizeSlashes(pattern);
  if (!p.includes('*')) throw stop(`expandGlob called on a non-glob pattern: ${pattern}`);
  const probe = p.slice(1); // strip leading "/" → e.g. ".github/copilot-*"
  const slash = probe.lastIndexOf('/');
  if (slash === -1) throw stop(`glob must live under a directory (no bare top-level glob): ${pattern}`);
  const parentRel = probe.slice(0, slash);
  const baseGlob = probe.slice(slash + 1);
  if (baseGlob.includes('*') === false) throw stop(`glob has no wildcard in its basename: ${pattern}`);
  const re = basenameGlobToRegExp(baseGlob);
  const parentAbs = `${dir}/${parentRel}`;
  let names;
  try {
    names = readdir(parentAbs);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw stop(`cannot read glob parent (${err.code ?? 'fs error'}): ${parentAbs}`);
  }
  const out = [];
  for (const name of names) {
    if (!re.test(name)) continue;
    let st;
    try {
      st = stat(`${parentAbs}/${name}`);
    } catch (err) {
      if (err && err.code === 'ENOENT') continue; // raced away — not a present footprint
      throw stop(`cannot stat glob match (${err.code ?? 'fs error'}): ${parentAbs}/${name}`);
    }
    if (st.isFile()) out.push(`/${parentRel}/${name}`);
  }
  return out.sort();
};
