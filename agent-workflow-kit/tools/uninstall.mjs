#!/usr/bin/env node
// uninstall.mjs — the guarded family uninstaller behind `/agent-workflow-kit uninstall`.
//
// Reverses what `npx … init` and `/agent-workflow-kit setup` placed, SAFELY. It consumes the unified
// family-registry (the SKILL axis) + surveyProject (the DEPLOY axis) and classifies every surface it
// could touch into one of four classes, then mutates ONLY after preflighting all of them (AD-011:
// a conflict on a later item leaves the filesystem untouched). The hard rule: it NEVER deletes
// user-authored content (docs/ai, the entry-point docs, settings.json) — it only PRINTS the exact
// commands for the user to run by hand (the AD-014 tracked-file posture, generalized to teardown).
//
//   safe-remove    — kit-placed + provably ours: a family skill dir (valid manifest, name+kind match).
//   managed-marker — recognized by an OWNED marker: a wrapper symlink that points at our source, the
//                    hidden-mode managed fence, a pre-commit hook carrying our marker. Reversed
//                    surgically (only the owned part), never a blind delete.
//   report-only    — user-authored / shared: docs/ai, AGENTS.md, CLAUDE.md, .claude/settings.json.
//                    Printed for the user to handle; the tool refuses to delete them.
//   stop           — a skill dir that is present but NOT provably ours (foreign/stub/invalid) — left
//                    untouched and reported, never removed.
//
// Pure planner (buildPlan) + guarded executor (executePlan), both dependency-injectable so the whole
// module is unit-testable without the real filesystem. Dependency-free, Node >= 18. No side effects on
// import (the isDirectRun idiom).

import { existsSync, statSync, lstatSync, readlinkSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, basename, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { surveyFamily, surveyProject, FAMILY_MEMBERS, classifyMember, OK } from './family-registry.mjs';
import { removeTreeManaged, unlinkManaged, MANAGED_LINK_CONFLICT } from './fs-safe.mjs';
import { deriveLinks } from './setup-backends.mjs';
import { hideFootprint, excludePath } from './hide-footprint.mjs';

// ── surface classes ────────────────────────────────────────────────────────────
export const SAFE_REMOVE = 'safe-remove';
export const MANAGED_MARKER = 'managed-marker';
export const REPORT_ONLY = 'report-only';
export const STOP = 'stop';

// A typed STOP raised by executePlan's preflight — the same codebase idiom (no classes).
export const UNINSTALL_STOP = 'UNINSTALL_STOP';
const stop = (message, fields = {}) =>
  Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'UninstallStop', code: UNINSTALL_STOP, ...fields });

const DEFAULT_BINDIR_REL = '.local/bin';
// The pre-commit hook our installer writes carries `# <project-name>:install-git-hooks.mjs`. The
// project-name varies, but this suffix is stable — match it to recognize OUR hook without guessing
// the name (never remove an unmarked / user-authored hook).
const HOOK_MARKER_SUFFIX = ':install-git-hooks.mjs';
// User-authored / kit-deployed-but-now-owned-by-the-user surfaces — REPORTED, never deleted.
const REPORT_PATHS = ['docs/ai', 'AGENTS.md', 'CLAUDE.md', 'docs/plans'];

// ── injectable fs ────────────────────────────────────────────────────────────────
const fsOf = (deps = {}) => ({
  exists: deps.exists ?? existsSync,
  stat: deps.stat ?? statSync,
  lstat: deps.lstat ?? lstatSync,
  readlink: deps.readlink ?? readlinkSync,
  readFile: deps.readFile ?? readFileSync,
  realpath: deps.realpath ?? realpathSync,
  readManifest: deps.readManifest ?? ((skillDir) => JSON.parse(readFileSync(join(skillDir, 'capability.json'), 'utf8'))),
});

const lstatNoFollow = (path, lstat) => {
  try {
    return lstat(path);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err; // EACCES/EIO must not fail open
  }
};

// Classify a wrapper symlink dst WITHOUT mutating (the preflight mirror of fs-safe's unlinkManaged):
// 'ours' (symlink → our source), 'absent', or 'conflict' (a non-symlink, or a foreign symlink).
const inspectWrapper = (dst, expectedSrc, fs) => {
  const st = lstatNoFollow(dst, fs.lstat);
  if (st === null) return { state: 'absent' };
  if (!st.isSymbolicLink()) return { state: 'conflict', reason: 'a non-symlink exists there' };
  let target;
  try {
    target = fs.readlink(dst);
  } catch (err) {
    return { state: 'conflict', reason: `unreadable symlink (${err.code ?? 'fs error'})` };
  }
  const resolved = isAbsolute(target) ? target : resolve(dirname(dst), target);
  return resolved === resolve(expectedSrc) ? { state: 'ours' } : { state: 'conflict', reason: `foreign symlink → ${target}` };
};

const bindirOf = (deps) => deps.bindir ?? join(deps.home ?? os.homedir(), DEFAULT_BINDIR_REL);

// ── buildPlan (pure) ───────────────────────────────────────────────────────────
// Classify every surface into the four classes. Takes the already-computed `family` (surveyFamily)
// and `project` (surveyProject | null) so the classification is testable in isolation; `deps` is used
// only to read bridge manifests (for the exact wrapper links) + probe the project's hook/settings.
// `member` (optional) narrows the SKILL axis to a single member name (whole family otherwise).
export const buildPlan = ({ family, project = null, projectDir = null, member = null, bindir }, deps = {}) => {
  const fs = fsOf(deps);
  const items = [];
  const resolvedBindir = bindir ?? bindirOf(deps);
  // Collapse a symlinked bindir to its real path (the link side did the same) — best-effort.
  const realBindir = (() => {
    try {
      return fs.realpath(resolvedBindir);
    } catch {
      return resolvedBindir;
    }
  })();

  const members = member ? family.filter((m) => m.name === member) : family;
  const registryOf = (name) => FAMILY_MEMBERS.find((m) => m.name === name);

  // ── SKILL axis ──
  for (const m of members) {
    if (!m.installed) continue; // nothing on disk for this member
    if (m.manifestState !== OK) {
      items.push({
        surface: 'skill', member: m.name, path: m.skillDir, class: STOP,
        reason: `skill dir is present but not provably ours ("${m.manifestState}") — left untouched`,
      });
      continue;
    }
    const reg = registryOf(m.name);
    // For a BRIDGE, derive its wrapper links FIRST. If that throws (an unreadable / underivable
    // manifest — unexpected for an `ok` member, but possible under a race/corruption), the bridge's
    // wrappers are not classifiable, so we must NOT remove its skill dir either — emit a STOP and move
    // on (a STOP aborts the whole teardown in executePlan; never a silent half-removal — codex #3).
    const links = (() => {
      if (!(reg && reg.wrapperCmds.length)) return [];
      try {
        return deriveLinks(fs.readManifest(m.skillDir), m.skillDir);
      } catch (err) {
        return { error: err.message ?? 'manifest read/derive error' };
      }
    })();
    if (links && links.error) {
      items.push({
        surface: 'skill', member: m.name, path: m.skillDir, class: STOP,
        reason: `could not classify this bridge's wrappers (${links.error}) — leaving the skill dir untouched`,
      });
      continue;
    }

    const shared = reg && reg.kind !== 'composition-root'; // engine/memory/bridges are shared globals
    items.push({
      surface: 'skill', member: m.name, path: m.skillDir, class: SAFE_REMOVE,
      reason: 'proven-managed family skill (valid manifest, name+kind match)',
      warn: shared ? 'this is a GLOBAL skill — other projects on this machine may use it' : null,
    });

    // Bridge wrappers: reverse the exact links the setup linker created (deriveLinks).
    for (const { cmd, source } of links) {
      const dst = join(realBindir, cmd);
      const info = inspectWrapper(dst, source, fs);
      if (info.state === 'absent') continue;
      if (info.state === 'ours') {
        items.push({ surface: 'wrapper', member: m.name, path: dst, expectedSrc: source, class: MANAGED_MARKER, reason: `managed wrapper symlink → ${source}` });
      } else {
        items.push({ surface: 'wrapper', member: m.name, path: dst, class: STOP, reason: `wrapper path is not ours (${info.reason}) — left untouched` });
      }
    }
  }

  // ── DEPLOY axis (only with a project dir) ──
  if (project && projectDir) {
    const dir = resolve(projectDir);

    if (project.hiddenFence) {
      // Display the git-path-resolved exclude file (worktree/submodule-safe), guarded → conventional path.
      const fencePath = (() => { try { return excludePath(deps, dir); } catch { return join(dir, '.git/info/exclude'); } })();
      items.push({ surface: 'fence', path: fencePath, class: MANAGED_MARKER, reason: 'hidden-mode managed block (removed via the existing unhide path; only the fenced lines)' });
    }

    const hookPath = join(dir, '.git/hooks/pre-commit');
    const hook = (() => {
      try {
        return fs.exists(hookPath) ? String(fs.readFile(hookPath, 'utf8')) : null;
      } catch {
        return null;
      }
    })();
    if (hook != null) {
      if (hook.includes(HOOK_MARKER_SUFFIX)) {
        items.push({ surface: 'hook', path: hookPath, class: MANAGED_MARKER, reason: 'pre-commit hook carrying our marker' });
      } else {
        items.push({ surface: 'hook', path: hookPath, class: REPORT_ONLY, reason: 'a pre-commit hook exists but is NOT ours — left untouched; remove it by hand if you want it gone' });
      }
    }

    const settingsPath = join(dir, '.claude/settings.json');
    const settings = (() => {
      try {
        return fs.exists(settingsPath) ? String(fs.readFile(settingsPath, 'utf8')) : null;
      } catch {
        return null;
      }
    })();
    if (settings != null && settings.includes('includeCoAuthoredBy')) {
      items.push({ surface: 'settings', path: settingsPath, class: REPORT_ONLY, reason: 'we set "includeCoAuthoredBy": false here — review/remove that key by hand (the file may hold your own settings)' });
    }

    for (const rel of REPORT_PATHS) {
      const p = join(dir, rel);
      if (fs.exists(p)) {
        items.push({ surface: 'docs', path: p, class: REPORT_ONLY, reason: 'user-authored after deploy — the uninstaller never deletes it; remove by hand if you want it gone' });
      }
    }
  }

  return { items, projectDir: projectDir ? resolve(projectDir) : null };
};

// ── executePlan (guarded: preview → preflight → mutate) ──────────────────────────
// `opts.yes` applies the auto-removable set (skill dirs + wrappers + fence + hook); without it (and
// without dryRun) nothing is mutated — the caller previews with --dry-run, asks, then re-runs with
// --yes (the agent-driven consent model). `opts.dryRun` previews only. Report-only items are NEVER
// mutated. Before mutating, EVERY surface is preflighted; ANY blocker ⇒ zero mutations (AD-011).
export const executePlan = (plan, opts = {}, deps = {}) => {
  const fs = fsOf(deps);
  const removeTree = deps.removeTree ?? removeTreeManaged;
  const unlink = deps.unlink ?? unlinkManaged;
  const unhide = deps.hideFootprint ?? hideFootprint;
  const classify = deps.classify ?? classifyMember;
  const rmFile = deps.rmFile ?? ((p) => removeTreeManaged(p, dirname(p), deps)); // marker hook is a regular file

  const mutable = plan.items.filter((i) => i.class === SAFE_REMOVE || i.class === MANAGED_MARKER);
  // `reported` (returned + summarized) = everything we do NOT mutate: user-authored (report-only) AND
  // not-provably-ours surfaces (STOP). STOP items were detected at plan time and shown in the dry-run;
  // we leave them untouched and proceed with what IS ours (the per-item posture of setup-backends —
  // a stray foreign wrapper never blocks removing the rest). They are NEVER mutated.
  const reported = plan.items.filter((i) => i.class === REPORT_ONLY || i.class === STOP);
  const result = { removed: [], unlinked: [], unhidden: false, hookRemoved: false, reported, applied: false, dryRun: !!opts.dryRun };

  // Preview / awaiting consent → show the plan (formatPlan), mutate NOTHING, abort NOTHING.
  if (opts.dryRun || !opts.yes) return result;

  // ── ABOUT TO MUTATE: preflight every MUTABLE surface; if any CHANGED since the plan ⇒ zero mutations
  // (the real AD-011 guarantee — the plan is now stale, so do nothing rather than act on bad data). A
  // surface that merely VANISHED is benign (the mutate is a no-op). Blocker kinds: a skill no longer
  // ours, a wrapper turned foreign, a hook that lost our marker, or a malformed fence (validated by a
  // dry-run unhide — codex #2 — so the fence can't blow up AFTER wrappers/skills were already removed).
  // (Plan-time STOP items are NOT a conflict — they were never ours; they are reported + left, above.)
  const conflicts = [];
  for (const item of mutable) {
    if (item.surface === 'skill') {
      const recheck = classify(FAMILY_MEMBERS.find((m) => m.name === item.member), deps);
      if (!(recheck.installed && recheck.manifestState === OK && recheck.skillDir === item.path)) {
        conflicts.push(`${item.path} is no longer a proven-managed ${item.member} skill`);
      }
    } else if (item.surface === 'wrapper') {
      const info = inspectWrapper(item.path, item.expectedSrc, fs);
      if (info.state === 'conflict') conflicts.push(`${item.path} is not ours (${info.reason})`);
    } else if (item.surface === 'hook') {
      const present = (() => { try { return fs.exists(item.path); } catch { return false; } })();
      if (present) {
        const content = (() => { try { return String(fs.readFile(item.path, 'utf8')); } catch { return ''; } })();
        if (!content.includes(HOOK_MARKER_SUFFIX)) conflicts.push(`${item.path} no longer carries our marker`);
      }
    } else if (item.surface === 'fence') {
      // Validate the unhide WITHOUT writing — a malformed managed block throws here, before any mutation,
      // so the fence can never blow up AFTER wrappers/skills were already removed (codex #2).
      try {
        unhide({ dir: plan.projectDir, unhide: true, dryRun: true }, deps);
      } catch (err) {
        conflicts.push(`${item.path} — ${err.message ?? 'malformed managed block'}`);
      }
    }
  }
  if (conflicts.length) {
    throw stop(
      `refusing to proceed — ${conflicts.length} surface(s) are not safe to touch (zero changes made):\n  - ` +
        `${conflicts.join('\n  - ')}\n  Resolve these, or narrow the teardown with \`uninstall <member>\`.`,
      { conflicts },
    );
  }

  // ── MUTATE (wrappers first, then skill dirs, then project surfaces) ──
  for (const item of mutable.filter((i) => i.surface === 'wrapper')) {
    const realBindir = (() => { try { return fs.realpath(dirname(item.path)); } catch { return dirname(item.path); } })();
    const action = unlink(join(realBindir, basename(item.path)), item.expectedSrc, realBindir, deps);
    if (action === 'unlinked') result.unlinked.push(item.path);
  }
  for (const item of mutable.filter((i) => i.surface === 'skill')) {
    const action = removeTree(item.path, dirname(item.path), deps);
    if (action === 'removed') result.removed.push(item.path);
  }
  for (const item of mutable.filter((i) => i.surface === 'fence')) {
    const r = unhide({ dir: plan.projectDir, unhide: true }, deps);
    result.unhidden = r && r.action === 'unhidden';
  }
  for (const item of mutable.filter((i) => i.surface === 'hook')) {
    // Marker-aware even at mutate time (belt-and-suspenders past the preflight): remove the hook ONLY
    // while it still carries our marker, so a user hook can never be deleted even under a TOCTOU race.
    const content = (() => { try { return fs.exists(item.path) ? String(fs.readFile(item.path, 'utf8')) : null; } catch { return null; } })();
    if (content != null && content.includes(HOOK_MARKER_SUFFIX)) {
      rmFile(item.path);
      result.hookRemoved = true;
    }
  }
  result.applied = true;
  return result;
};

// ── report ───────────────────────────────────────────────────────────────────
const CLASS_LABEL = { [SAFE_REMOVE]: 'remove', [MANAGED_MARKER]: 'reverse', [REPORT_ONLY]: 'KEEP (do by hand)', [STOP]: 'STOP (left untouched)' };

// POSIX single-quote a path for the copy-paste commands we PRINT (never run) — so a path with spaces
// or shell metacharacters can't misbehave when the user pastes it (codex #4).
const shq = (p) => `'${String(p).replace(/'/g, "'\\''")}'`;

// The "do this by hand" line for a report-only surface. settings.json is an EDIT (remove one key), not
// an `rm` — deleting it would lose the user's own settings (codex #4); everything else is a quoted rm.
const handGuidance = (item) =>
  item.surface === 'settings'
    ? `edit ${shq(item.path)} → remove the "includeCoAuthoredBy" entry (keep the rest of your settings)`
    : `rm -rf ${shq(item.path)}   # if it was committed:  git rm -r --cached ${shq(item.path)}`;

export const formatPlan = (plan) => {
  const lines = ['agent-workflow uninstall — planned actions (nothing is changed without --yes)', ''];
  if (plan.items.length === 0) return [...lines, '  nothing to do — no installed family members or deployment found here.'].join('\n');
  for (const i of plan.items) {
    lines.push(`  [${CLASS_LABEL[i.class]}] ${i.surface}: ${i.path}`);
    lines.push(`        ${i.reason}`);
    if (i.warn) lines.push(`        ⚠ ${i.warn}`);
  }
  const reportOnly = plan.items.filter((i) => i.class === REPORT_ONLY);
  if (reportOnly.length) {
    lines.push('', 'These are NOT removed (user-authored / shared). To remove them yourself:');
    for (const i of reportOnly) lines.push(`  ${handGuidance(i)}`);
  }
  return lines.join('\n');
};

// ── CLI ────────────────────────────────────────────────────────────────────────
// STRICT parsing (codex #6): an unknown flag, a missing --dir/--bindir value, or an unknown <member>
// is rejected via `bad` — main() prints it + usage + exits non-zero. A typo can never silently slip
// through into a `--yes` mutation. Exported for unit testing.
const FLAGS_NO_VAL = ['--help', '-h', '--dry-run', '--yes'];
const FLAGS_WITH_VAL = ['--dir', '--bindir'];
const KNOWN_MEMBERS = new Set(FAMILY_MEMBERS.map((m) => m.name));

export const parseArgs = (argv) => {
  const valOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  // The index immediately after a value-flag is that flag's VALUE, not a stray token.
  const valueIdx = new Set(FLAGS_WITH_VAL.flatMap((f) => { const i = argv.indexOf(f); return i >= 0 ? [i + 1] : []; }));
  const stray = argv.filter((a, i) => !FLAGS_NO_VAL.includes(a) && !FLAGS_WITH_VAL.includes(a) && !valueIdx.has(i));
  const unknownFlags = stray.filter((a) => a.startsWith('-'));
  const positionals = stray.filter((a) => !a.startsWith('-'));
  const dir = valOf('--dir');
  const bindir = valOf('--bindir');
  const bad = (() => {
    if (unknownFlags.length) return `unknown option(s): ${unknownFlags.join(', ')}`;
    if (argv.includes('--dir') && (dir === undefined || dir.startsWith('-'))) return '--dir requires a <project> path';
    if (argv.includes('--bindir') && (bindir === undefined || bindir.startsWith('-'))) return '--bindir requires a path';
    if (positionals.length > 1) return `expected at most one <member>, got: ${positionals.join(', ')}`;
    if (positionals.length === 1 && !KNOWN_MEMBERS.has(positionals[0])) {
      return `unknown member "${positionals[0]}" — expected one of: ${[...KNOWN_MEMBERS].join(', ')}`;
    }
    return null;
  })();
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    dryRun: argv.includes('--dry-run'),
    yes: argv.includes('--yes'),
    dir,
    bindir,
    member: positionals[0],
    bad,
  };
};

const HELP = `agent-workflow uninstall — guarded teardown of the installed family.

Usage:
  node uninstall.mjs [<member>] [--dir <project>] [--bindir <path>] [--dry-run | --yes]

  <member>     limit the skill axis to one member (default: the whole family)
  --dir        also plan the project-deployment surfaces in <project>
  --bindir     where the bridge wrappers were linked (default: ~/.local/bin)
  --dry-run    print the plan and change NOTHING (run this first)
  --yes        apply the auto-removable set (skill dirs + wrappers + fence + marker hook)
  --help       this help

It NEVER deletes user-authored content (docs/ai, AGENTS.md, settings.json) — those are reported with
the exact commands for you to run by hand. A skill dir that is not provably ours is left untouched.`;

const main = (argv) => {
  const args = parseArgs(argv);
  if (args.help) return console.log(HELP);
  if (args.bad) {
    console.error(`[agent-workflow-kit] ${args.bad}\n`);
    console.log(HELP);
    process.exit(2);
  }

  const family = surveyFamily();
  const project = args.dir ? surveyProject(args.dir) : null;
  const plan = buildPlan({ family, project, projectDir: args.dir, member: args.member, bindir: args.bindir });
  console.log(formatPlan(plan));

  if (args.dryRun) return;
  if (!args.yes) {
    console.log('\nThis was a preview. Re-run with --yes to apply the removable set (or --dry-run to preview again).');
    return;
  }
  const result = executePlan(plan, { yes: true });
  console.log(`\n[agent-workflow-kit] done — removed ${result.removed.length} skill dir(s), ${result.unlinked.length} wrapper(s)` +
    `${result.unhidden ? ', unhid the project' : ''}${result.hookRemoved ? ', removed the pre-commit hook' : ''}.`);
  if (result.reported.length) {
    console.log(`${result.reported.length} surface(s) were left untouched — user-authored content (handle by hand, see above) or paths that are not ours.`);
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message ?? err);
    process.exit(1);
  }
}
