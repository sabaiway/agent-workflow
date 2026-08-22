#!/usr/bin/env node
// uninstall.mjs — the guarded family uninstaller behind `/agent-workflow-kit uninstall`.
//
// Reverses what `npx … init` and `/agent-workflow-kit setup` placed, SAFELY. It consumes the unified
// family-registry (the SKILL axis) + surveyProject (the DEPLOY axis) and classifies every surface it
// could touch into one of four classes, then mutates ONLY after preflighting all of them (AD-011:
// a conflict on a later item leaves the filesystem untouched). The hard rule: it NEVER deletes
// user-authored content — it PRINTS the exact remove commands for docs/ai + the entry-point docs, and
// an EDIT instruction for .claude/settings.json (never an rm), for the user to run by hand (the
// AD-014 tracked-file posture, generalized to teardown).
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
// module is unit-testable without the real filesystem. Dependency-free, Node >= 22. No side effects on
// import (the isDirectRun idiom).

import { existsSync, statSync, lstatSync, readlinkSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, basename, isAbsolute } from 'node:path';
import os from 'node:os';
import { isDirectRun } from './direct-run.mjs';
import { surveyFamily, surveyProject, FAMILY_MEMBERS, classifyMember, OK } from './family-registry.mjs';
import { assertContainedRealPath, removeTreeManaged, unlinkManaged, MANAGED_LINK_CONFLICT } from './fs-safe.mjs';
import { deriveLinks } from './setup-backends.mjs';
import { hideFootprint, excludePath } from './hide-footprint.mjs';
import { HOOK_FILE_REL as GATE_HOOK_FILE_REL, readBundledHook } from './gate-hook.mjs';
// The MCP registration's two seams are recognized through the registration LEAF — its constants and
// its own entry decision — so this reporter can never disagree with the writer about what is ours.
import {
  CLAUDE_DIR_REL,
  DEFAULT_SERVER_PATH as MCP_SERVER_PATH,
  ENABLED_KEY as MCP_ENABLED_KEY,
  MCP_JSON_REL,
  SERVER_NAME as MCP_SERVER_NAME,
  SERVERS_KEY as MCP_SERVERS_KEY,
  STATE as MCP_STATE,
  allowRulesFor,
  buildServerEntry,
  decideMcpJsonText,
} from './mcp-registration.mjs';

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
  readdir: deps.readdir ?? readdirSync,
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

    // Plan time reads through the same parent chains the executor removes through, so it asks the
    // same question: a hook reached only by traversing a symlink is neither read nor planned.
    // Validates the PARENT CHAIN only. Walking the leaf too collapsed a symlinked settings file or
    // placed hook into "absent", which made their REPORT_ONLY branches unreachable and dropped the
    // surface from the plan entirely — worse than reporting it. The leaf is classified below, by its
    // own no-follow lstat, and reported without being followed.
    const reachable = (target) => {
      try {
        assertContainedRealPath(dir, dirname(target), { lstat: fs.lstat });
        return true;
      } catch {
        return false;
      }
    };
    const hookPath = join(dir, '.git/hooks/pre-commit');
    // `reachable` answers for the PARENT CHAIN only (by design — walking the leaf dropped surfaces
    // from the plan). The leaf therefore needs its own no-follow classification before any read: a
    // symlinked hook would expose an out-of-tree file, and a FIFO would block planning outright.
    const hookStat = reachable(hookPath) ? lstatNoFollow(hookPath, fs.lstat) : null;
    if (hookStat !== null && (hookStat.isSymbolicLink() || !hookStat.isFile())) {
      items.push({
        surface: 'hook', path: hookPath, class: REPORT_ONLY,
        reason: 'a pre-commit hook path exists but is a symlink or not a regular file — reported UNREAD and left untouched; check it by hand',
        hand: `inspect ${shq(hookPath)} by hand — this tool neither follows nor removes it`,
      });
    }
    const hook = (() => {
      if (hookStat === null || hookStat.isSymbolicLink() || !hookStat.isFile()) return null;
      try {
        return String(fs.readFile(hookPath, 'utf8'));
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

    const readRaw = (p) => {
      try {
        return fs.exists(p) ? String(fs.readFile(p, 'utf8')) : null;
      } catch {
        return null;
      }
    };
    // The `.claude` CONTAINER is classified before anything inside it is read. Path resolution
    // follows an INTERMEDIATE symlink (a no-follow open guards the final component only), so reading
    // first would let a symlinked `.claude` put a settings file from OUTSIDE the work tree into this
    // report — as a claim about surfaces this family placed. An ABSENT container is ordinary (the
    // reads below simply find nothing); a symlinked or non-directory one is reported UNREAD.
    const claudeDirPath = join(dir, CLAUDE_DIR_REL);
    const claudeDirStat = lstatNoFollow(claudeDirPath, fs.lstat);
    // NOT-A-DIRECTORY is the whole class, and every member of it blinds the reads below: a symlink
    // escapes the work tree, and a device / FIFO / socket turns each of them into ENOTDIR. Naming
    // only symlink-or-regular-file left the special classes to fail as an unhandled error instead.
    const claudeDirForeign = claudeDirStat !== null && !claudeDirStat.isDirectory();
    if (claudeDirForeign) {
      // Its own surface AND its own hand line. Under `settings` the report would tell the maintainer
      // to remove a settings KEY from a directory; under the generic fallback it would suggest
      // `rm -rf` on a path this tool has deliberately refused to look inside.
      items.push({
        surface: 'claude-dir', path: claudeDirPath, class: REPORT_ONLY,
        reason: `${CLAUDE_DIR_REL} exists but is not a directory — nothing inside it was read, so no settings or hook surface is reported from here`,
        hand: `inspect ${shq(claudeDirPath)} by hand — it exists but is not a directory, and this tool neither reads through it nor removes it`,
      });
    }
    // A settings file the tool will not read is REPORTED rather than dropped: the seams it may hold
    // are exactly what a teardown owes the maintainer, and silence about them is the worse answer.
    const settingsPath = join(dir, '.claude/settings.json');
    const settingsStat = claudeDirForeign || !reachable(settingsPath) ? null : lstatNoFollow(settingsPath, fs.lstat);
    const settingsUnread = !claudeDirForeign && reachable(settingsPath) && settingsStat !== null
      && (settingsStat.isSymbolicLink() || !settingsStat.isFile());
    if (settingsUnread) {
      items.push({
        surface: 'settings', path: settingsPath, class: REPORT_ONLY,
        reason: `${SETTINGS_REL_TXT} is a symlink or not a regular file — left UNREAD and untouched, so no seam in it is reported; check it by hand`,
        hand: `inspect ${shq(settingsPath)} by hand — this tool neither follows nor edits it`,
      });
    }
    const settings = claudeDirForeign || !reachable(settingsPath) || settingsUnread ? null : readRaw(settingsPath);
    const settingsSeams = detectSettingsSeams(settings);
    if (settingsSeams.attribution || settingsSeams.permissions || settingsSeams.gateHook || settingsSeams.mcp) {
      items.push({
        surface: 'settings',
        path: settingsPath,
        class: REPORT_ONLY,
        reason: settingsSeamReason(settingsSeams),
        hand: settingsSeamHand(settingsSeams, settingsPath),
      });
    }

    // The gate-approval hook (Mode: hook). Hooks merge from project AND local settings (the Claude
    // Code contract), so the wired probe checks BOTH files; a local entry is user-authored → its own
    // REPORT_ONLY edit item (uninstall never writes settings — either file). The placed FILE is
    // removable ONLY when the entry is absent from BOTH (hand-removed) AND the content is
    // byte-identical to the current bundle — never create the wired-but-missing state this tool
    // itself would warn about; while any entry is present, all surfaces are reported as one bundle
    // (edit settings first, re-run to remove the file).
    const localSettingsPath = join(dir, '.claude/settings.local.json');
    // Same leaf discipline as the hook: classified no-follow before any read, so a symlinked local
    // settings file is not followed out of the tree and a non-regular one is never opened.
    const localStat = !claudeDirForeign && reachable(localSettingsPath) ? lstatNoFollow(localSettingsPath, fs.lstat) : null;
    const localReadable = localStat !== null && !localStat.isSymbolicLink() && localStat.isFile();
    const localSeams = detectSettingsSeams(localReadable ? readRaw(localSettingsPath) : null);
    if (localSeams.gateHook) {
      items.push({
        surface: 'settings',
        path: localSettingsPath,
        class: REPORT_ONLY,
        reason: 'a PreToolUse entry wiring the kit-placed gate-approval hook is present in this file — remove it by hand to unwire (the tool never edits settings)',
        hand: `edit ${shq(localSettingsPath)} → remove the PreToolUse entry whose command runs ${GATE_HOOK_FILE_REL} (keep the rest of your settings)`,
      });
    }
    const gateHookPath = join(dir, GATE_HOOK_FILE_REL);
    // The placed hook lives INSIDE `.claude` too, so a foreign container blinds this probe as well —
    // its own no-follow lstat guards the leaf, never the path that reaches it.
    const gateHookStat = claudeDirForeign || !reachable(gateHookPath) ? null : lstatNoFollow(gateHookPath, fs.lstat);
    // lstat no-follow BEFORE reading: a symlink (or any non-regular file) at the placed path is
    // never a kit-placed hook we remove — reading through it would classify a symlink-to-bundle as
    // SAFE_REMOVE and only removeTreeManaged would catch it at mutate time, AFTER earlier removals.
    // Report it, never remove it.
    if (gateHookStat !== null && (gateHookStat.isSymbolicLink() || !gateHookStat.isFile())) {
      items.push({
        surface: 'gate-hook', path: gateHookPath, class: REPORT_ONLY,
        reason: 'a file exists at the gate-approval hook path but is a symlink or not a regular file — left untouched; remove by hand if you want it gone',
      });
    }
    const gateHookContent = gateHookStat !== null && gateHookStat.isFile() && !gateHookStat.isSymbolicLink() ? readRaw(gateHookPath) : null;
    if (gateHookContent != null) {
      const wired = settingsSeams.gateHook || localSeams.gateHook;
      const bundle = (() => {
        try {
          return readBundledHook(deps);
        } catch {
          return null;
        }
      })();
      if (wired) {
        items.push({
          surface: 'gate-hook', path: gateHookPath, class: REPORT_ONLY,
          reason: 'the gate-approval hook file is still WIRED in Claude settings — edit the settings entry first (see the settings item above), then re-run uninstall to remove the file (never leaves a wired-but-missing hook)',
        });
      } else if (bundle != null && gateHookContent === bundle) {
        items.push({
          surface: 'gate-hook', path: gateHookPath, class: SAFE_REMOVE, expectedContent: bundle,
          reason: 'kit-placed gate-approval hook — byte-identical to the current bundle and not wired in either settings file',
        });
      } else {
        items.push({
          surface: 'gate-hook', path: gateHookPath, class: REPORT_ONLY,
          reason: bundle == null
            ? 'could not read the kit bundle to verify this hook file — left untouched; remove by hand if you want it gone'
            : 'not byte-identical to the current kit bundle (customized, or from another kit version) — left untouched; remove by hand if you want it gone',
        });
      }
    }

    // The MCP registration's file seam (Mode: mcp). REPORT_ONLY without exception: `.mcp.json` is a
    // shared declaration that may list servers this kit never placed, so it is never rewritten and
    // never removed — only the entry to delete is named. lstat no-follow BEFORE any read: a symlink
    // or a sandbox device mask at this path is reported UNREAD, never followed and never parsed.
    const mcpJsonPath = join(dir, MCP_JSON_REL);
    const mcpStat = lstatNoFollow(mcpJsonPath, fs.lstat);
    if (mcpStat !== null && (mcpStat.isSymbolicLink() || !mcpStat.isFile())) {
      items.push({
        surface: 'mcp-json', path: mcpJsonPath, class: REPORT_ONLY,
        reason: `a file exists at ${MCP_JSON_REL} but is a symlink or not a regular file (an OS sandbox device mask reads exactly this way) — reported unread and left untouched; check it by hand from outside the sandbox`,
        // Every arm of this surface carries its OWN hand line: `.mcp.json` is a SHARED declaration
        // that may list servers this kit never placed, and the generic fallback would offer `rm -rf`.
        hand: `inspect ${shq(mcpJsonPath)} by hand from outside the sandbox — this tool neither follows nor removes it`,
      });
    } else if (mcpStat !== null) {
      const mcpText = readRaw(mcpJsonPath);
      const decided = mcpText == null ? null : decideMcpJsonText(mcpText, buildServerEntry(MCP_SERVER_PATH));
      if (decided === null || decided.state !== MCP_PRESENT) {
        // "Is our entry there?" has no answer over bytes that could not be read or parsed — and
        // treating no-answer as NO made the file vanish from a report whose whole job is completeness.
        items.push({
          surface: 'mcp-json', path: mcpJsonPath, class: REPORT_ONLY,
          reason: `${MCP_JSON_REL} could not be read or parsed (${decided?.reason ?? 'unreadable'}) — left untouched; check it by hand for an "${MCP_SERVER_NAME}" entry`,
          hand: `inspect ${shq(mcpJsonPath)} by hand and remove any "${MCP_SERVER_NAME}" entry under "${MCP_SERVERS_KEY}" — never delete the file, it may declare servers this kit never placed`,
        });
      } else if (decided.hasEntry) {
        items.push({
          surface: 'mcp-json', path: mcpJsonPath, class: REPORT_ONLY,
          reason: `an MCP server entry named "${MCP_SERVER_NAME}" is present in ${MCP_JSON_REL} — remove that entry by hand to unregister the typed channel (the file may declare servers this kit never placed, so it is never rewritten or removed)`,
          hand: `edit ${shq(mcpJsonPath)} → remove the "${MCP_SERVER_NAME}" entry under "${MCP_SERVERS_KEY}" (keep every other server)`,
        });
      }
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
  // `root` names the containment boundary the removal must stay inside. It defaults to the file's own
  // parent (the marker hook in .git/hooks), but a surface living under `.claude` passes the PROJECT
  // dir instead: with the parent as root, a symlinked `.claude` is inside the boundary by
  // construction and the guard can never fire.
  const rmFile = deps.rmFile ?? ((p, root) => removeTreeManaged(p, root ?? dirname(p), deps));

  const mutable = plan.items.filter((i) => i.class === SAFE_REMOVE || i.class === MANAGED_MARKER);
  // `reported` (returned + summarized) = everything we do NOT mutate: user-authored (report-only) AND
  // not-provably-ours surfaces (STOP). STOP items were detected at plan time and shown in the dry-run;
  // we leave them untouched and proceed with what IS ours (the per-item posture of setup-backends —
  // a stray foreign wrapper never blocks removing the rest). They are NEVER mutated.
  const reported = plan.items.filter((i) => i.class === REPORT_ONLY || i.class === STOP);
  const result = { removed: [], unlinked: [], unhidden: false, hookRemoved: false, gateHookRemoved: false, reported, applied: false, dryRun: !!opts.dryRun };

  // Preview / awaiting consent → show the plan (formatPlan), mutate NOTHING, abort NOTHING.
  if (opts.dryRun || !opts.yes) return result;

  // ── ABOUT TO MUTATE: preflight every MUTABLE surface; if any CHANGED since the plan ⇒ zero mutations
  // (the real AD-011 guarantee — the plan is now stale, so do nothing rather than act on bad data). A
  // surface that merely VANISHED is benign (the mutate is a no-op). Blocker kinds: a skill no longer
  // ours, a wrapper turned foreign, a hook that lost our marker, or a malformed fence (validated by a
  // dry-run unhide — codex #2 — so the fence can't blow up AFTER wrappers/skills were already removed).
  // (Plan-time STOP items are NOT a conflict — they were never ours; they are reported + left, above.)
  // Guarding ONE named container is a ladder with no top: close `.claude` and the next symlink moves
  // to `.claude/hooks`, then to `.git`. The property is the WHOLE parent chain from the project root,
  // and the kit already owns the walk that decides it — so this asks that primitive instead of adding
  // a third bespoke check. Re-read LIVE at each call site, never captured: the entire point is that
  // the chain can change, so a cached answer describes a moment that has already passed.
  const reachedSafely = (target) => {
    if (!plan.projectDir) return true;
    try {
      assertContainedRealPath(plan.projectDir, target, { lstat: fs.lstat });
      return true;
    } catch {
      return false;
    }
  };

  // The ONE classification both phases use, so the preflight and the mutate arm can never disagree
  // about what a leaf is. A non-ENOENT lstat failure is `unreadable`, NOT absent — the distinction the
  // whole late-conflict lane rests on.
  // Every call site runs AFTER `reachedSafely`, whose walk already lstats this same leaf: it turns a
  // non-ENOENT failure AND a symlink into their own conflicts before this is reached. So both a
  // separate unreadable branch and a separate symlink branch here were dead code, and both are gone
  // rather than covered — what still reaches this is the class that walk permits: a non-regular,
  // non-symlink leaf (a device, a FIFO, a socket), which must never be opened.
  const readableRegular = (target) => {
    const st = lstatNoFollow(target, fs.lstat);
    if (st === null) return { kind: 'absent' };
    if (!st.isFile()) return { kind: 'foreign', reason: 'is not a regular file — left untouched, and never opened' };
    return { kind: 'regular', st };
  };

  // A surface that changes, or whose removal REFUSES, between the conflict pass and its own mutation
  // is a LATE conflict: earlier mutations have already happened, so the zero-mutation guarantee no
  // longer applies and pretending otherwise would be the lie. Every mutating branch routes through
  // here — a contract implemented for two surfaces while documented for all of them is the same
  // silent-shape failure it exists to prevent.
  const lateConflicts = [];
  const partialFailures = [];
  // "left untouched" is a CLAIM, and only a containment/ownership REFUSAL proves it: those are raised
  // before the primitive touches anything. A recursive delete or a fence write that throws part way
  // has already changed the tree, so it is reported as POSSIBLY PARTIAL — and it stops the run,
  // because continuing to remove later surfaces on top of an unknown state is not a teardown.
  const isProvenRefusal = (err) =>
    err?.code === MANAGED_LINK_CONFLICT || err?.code === UNINSTALL_STOP || /refusing to/.test(String(err?.message ?? ''));
  const attemptRemoval = (label, run) => {
    if (partialFailures.length) return false; // stop after an unknown-state failure
    try {
      run();
      return true;
    } catch (err) {
      const note = `${label}: ${err?.message ?? err}`;
      if (isProvenRefusal(err)) lateConflicts.push(`${note} — refused before any change, left untouched`);
      else partialFailures.push(`${note} — it MAY BE PARTIALLY removed; the tool cannot tell`);
      return false;
    }
  };

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
      // The marker hook lives under `.git/`, which is a parent chain like any other: a symlinked
      // `.git` makes the read below describe a file outside the project, and the removal delete it.
      if (!reachedSafely(item.path)) {
        conflicts.push(`${item.path} is no longer reachable without traversing a symlink — refusing to read or remove anything through it`);
        continue;
      }
      // lstat, not exists: `exists` answers FALSE for a merely unreadable leaf, which would read as
      // the one state documented benign (vanished), and it follows a symlink. Only ENOENT is benign;
      // a non-regular leaf is classified and refused BEFORE any read, because reading a FIFO blocks.
      const st = readableRegular(item.path);
      if (st.kind === 'absent') continue;
      if (st.kind === 'foreign') {
        conflicts.push(`${item.path} ${st.reason}`);
        continue;
      }
      const content = (() => { try { return String(fs.readFile(item.path, 'utf8')); } catch { return null; } })();
      if (content == null) conflicts.push(`${item.path} could not be read — refusing to decide whether it is ours`);
      else if (!content.includes(HOOK_MARKER_SUFFIX)) conflicts.push(`${item.path} no longer carries our marker`);
    } else if (item.surface === 'gate-hook') {
      // Same AD-011 recheck as the marker hook: the file must STILL be a regular (non-symlink)
      // file, byte-identical to the bundle, AND still unwired — a symlink swapped in, a divergence,
      // or a new settings entry since the plan ⇒ zero mutations. lstat no-follow FIRST: a symlink
      // read through by fs.readFile would masquerade as the bundle and slip past this guard.
      //
      // The CONTAINER is rechecked before the leaf, because the leaf's no-follow lstat resolves
      // THROUGH it: a `.claude` swapped for a symlink since the plan makes every check below describe
      // a file outside the project, and the removal would then delete that file.
      if (!reachedSafely(item.path)) {
        conflicts.push(`${item.path} is no longer reachable without traversing a symlink — refusing to read or remove anything through it`);
        continue;
      }
      const cls = readableRegular(item.path);
      if (cls.kind === 'foreign') {
        conflicts.push(`${item.path} ${cls.reason}`);
        continue;
      }
      if (cls.kind === 'regular') {
        const content = (() => { try { return String(fs.readFile(item.path, 'utf8')); } catch { return null; } })();
        // Unreadable is its own cause — reporting it as a bundle mismatch states a comparison that
        // never happened.
        if (content == null) conflicts.push(`${item.path} could not be read — refusing to decide whether it is the kit bundle`);
        else if (content !== item.expectedContent) conflicts.push(`${item.path} no longer matches the kit bundle`);
        else if (gateHookWiredNow(plan.projectDir, fs)) conflicts.push(`${item.path} became wired in Claude settings since the plan`);
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
    attemptRemoval(item.path, () => {
      const realBindir = (() => { try { return fs.realpath(dirname(item.path)); } catch { return dirname(item.path); } })();
      const action = unlink(join(realBindir, basename(item.path)), item.expectedSrc, realBindir, deps);
      if (action === 'unlinked') result.unlinked.push(item.path);
    });
  }
  for (const item of mutable.filter((i) => i.surface === 'skill')) {
    attemptRemoval(item.path, () => {
      // Ownership is re-established immediately before the RECURSIVE delete, not only in the conflict
      // pass: a dir replaced in between would otherwise be removed whole on the strength of a check
      // that described something else. The shipped contract promises exactly this.
      const now = classify(FAMILY_MEMBERS.find((m) => m.name === item.member), deps);
      if (!(now.installed && now.manifestState === OK && now.skillDir === item.path)) {
        throw stop(`${item.path} stopped being a proven-managed ${item.member} skill after the preflight — refusing to remove it`);
      }
      const action = removeTree(item.path, dirname(item.path), deps);
      if (action === 'removed') result.removed.push(item.path);
    });
  }
  for (const item of mutable.filter((i) => i.surface === 'fence')) {
    attemptRemoval(item.path, () => {
      const r = unhide({ dir: plan.projectDir, unhide: true }, deps);
      result.unhidden = r && r.action === 'unhidden';
    });
  }
  for (const item of mutable.filter((i) => i.surface === 'hook')) {
    // Marker-aware even at mutate time (belt-and-suspenders past the preflight): remove the hook ONLY
    // while it still carries our marker. That closes the STATIC case — a user hook standing there is
    // never deleted. It is NOT a race guarantee: substitution of one regular file for another between
    // this read and the path-based removal stays open, for the reason named in mcp-registration.mjs.
    if (!reachedSafely(item.path)) {
      lateConflicts.push(`${item.path} became reachable only through a symlink after the preflight — left untouched`);
      continue;
    }
    // A surface that merely VANISHED stays benign — the mutate is a no-op and nothing is owed. Every
    // OTHER mismatch is a late conflict: passing over a hook that changed, or that could not be read,
    // and then reporting `applied: true` is the silent skip this arm claims not to have.
    const st = readableRegular(item.path);
    if (st.kind === 'absent') continue;
    if (st.kind === 'foreign') {
      lateConflicts.push(`${item.path} ${st.reason}`);
      continue;
    }
    const content = (() => { try { return String(fs.readFile(item.path, 'utf8')); } catch { return null; } })();
    if (content == null) {
      lateConflicts.push(`${item.path} could not be read at removal time — left untouched`);
      continue;
    }
    if (!content.includes(HOOK_MARKER_SUFFIX)) {
      lateConflicts.push(`${item.path} no longer carries our marker (it changed after the preflight) — left untouched`);
      continue;
    }
    if (attemptRemoval(item.path, () => rmFile(item.path, plan.projectDir))) result.hookRemoved = true;
  }
  for (const item of mutable.filter((i) => i.surface === 'gate-hook')) {
    // Bundle-identity + unwired re-verified at mutate time too (the TOCTOU posture above), lstat
    // no-follow FIRST so a symlink swapped in cannot be read-through as the bundle and removed: a
    // file that changed, turned into a symlink, or got wired between preflight and now is left
    // untouched, never removed.
    // The chain is re-walked here too, immediately before the removal — the conflict pass above ran
    // at a different instant, and this is the call that deletes.
    if (!reachedSafely(item.path)) {
      lateConflicts.push(`${item.path} became reachable only through a symlink after the preflight — left untouched`);
      continue;
    }
    const placed = readableRegular(item.path);
    if (placed.kind === 'absent') continue; // vanished — benign, the same documented no-op as everywhere else
    if (placed.kind === 'foreign') {
      lateConflicts.push(`${item.path} ${placed.reason}`);
      continue;
    }
    const content = (() => { try { return String(fs.readFile(item.path, 'utf8')); } catch { return null; } })();
    if (content !== item.expectedContent) {
      lateConflicts.push(`${item.path} ${content == null ? 'could not be read at removal time' : 'no longer matches the kit bundle (it changed after the preflight)'} — left untouched`);
      continue;
    }
    if (gateHookWiredNow(plan.projectDir, fs)) {
      lateConflicts.push(`${item.path} became wired in Claude settings after the preflight — left untouched (removing it would leave a wired-but-missing hook)`);
      continue;
    }
    {
      // Containment root = the PROJECT, not the file's parent: with the parent as root a symlinked
      // `.claude` sits inside the boundary by construction, so the traversal guard could never fire.
      if (attemptRemoval(item.path, () => rmFile(item.path, plan.projectDir))) {
        result.gateHookRemoved = true;
        // A `.claude/hooks/` dir left EMPTY by that removal is removed too (clean footprint); a dir
        // with anything else in it is untouched.
        const hooksDir = dirname(item.path);
        const leftover = (() => { try { return fs.readdir(hooksDir); } catch { return null; } })();
        if (leftover != null && leftover.length === 0) {
          attemptRemoval(hooksDir, () => removeTree(hooksDir, plan.projectDir ?? dirname(hooksDir), deps));
        }
      }
    }
  }
  if (partialFailures.length || lateConflicts.length) {
    // Unlike the preflight STOP, this one CANNOT promise zero changes — so it reports what actually
    // happened, DERIVED from the result. "Earlier removals were applied" is a claim, and on a plan
    // holding only the conflicted surface it is a false one.
    const done = [
      ...result.removed.map((p) => `removed ${p}`),
      ...result.unlinked.map((p) => `unlinked ${p}`),
      ...(result.unhidden ? ['unhidden the managed git-exclude block'] : []),
      ...(result.hookRemoved ? ['removed the marked pre-commit hook'] : []),
      ...(result.gateHookRemoved ? ['removed the placed gate-approval hook'] : []),
    ];
    const parts = [`the teardown is INCOMPLETE.`];
    if (partialFailures.length) {
      parts.push(`  ${partialFailures.length} removal(s) FAILED in an unknown state, so the run stopped there:\n  - ${partialFailures.join('\n  - ')}`);
    }
    if (lateConflicts.length) {
      parts.push(`  ${lateConflicts.length} surface(s) could not be touched safely and were left alone:\n  - ${lateConflicts.join('\n  - ')}`);
    }
    parts.push(`  ${done.length ? `Already applied before that point:\n  - ${done.join('\n  - ')}` : 'nothing had been removed before that point.'}`);
    parts.push('  Re-run the teardown once the tree is settled; anything listed as left untouched was not removed.');
    throw stop(parts.join('\n'), { lateConflicts, partialFailures, applied: done, partial: result });
  }
  result.applied = true;
  return result;
};

// Is the gate-approval hook wired NOW (either settings file)? Probed by the placed-path substring
// (the same broad detectSettingsSeams posture). Fail-CLOSED: an unreadable settings file counts as
// wired — "cannot prove unwired" must preserve the file, never remove it.
// This probe DECIDES a removal — a hook that reads as unwired gets deleted — so a settings file
// reached through a symlink would let bytes from outside the project drive that deletion. Each exact
// settings leaf is chain-validated from the project root before it is read; an unreachable one is
// answered the same way an unreadable one already was, by erring toward WIRED (preserve the file).
const gateHookWiredNow = (projectDir, fs) => {
  if (!projectDir) return false;
  const probe = (p) => {
    try {
      assertContainedRealPath(projectDir, p, { lstat: fs.lstat });
    } catch {
      return true;
    }
    try {
      return fs.exists(p) ? settingsMentionsGateHook(String(fs.readFile(p, 'utf8'))) : false;
    } catch {
      return true;
    }
  };
  return probe(join(projectDir, '.claude/settings.json')) || probe(join(projectDir, '.claude/settings.local.json'));
};

// ── report ───────────────────────────────────────────────────────────────────
const CLASS_LABEL = { [SAFE_REMOVE]: 'remove', [MANAGED_MARKER]: 'reverse', [REPORT_ONLY]: 'KEEP (do by hand)', [STOP]: 'STOP (left untouched)' };

// POSIX single-quote a path for the copy-paste commands we PRINT (never run) — so a path with spaces
// or shell metacharacters can't misbehave when the user pastes it (codex #4).
const shq = (p) => `'${String(p).replace(/'/g, "'\\''")}'`;

// Does any STRING VALUE anywhere in a parsed settings tree contain the placed hook path? Recursive
// so the probe reads the DECODED command (JSON `\/` and `/` escapes are already resolved by
// JSON.parse) — a raw-text substring scan would miss a validly-escaped `.claude\/hooks\/…` entry
// and wrongly read the hook as unwired.
const jsonStringContains = (value, needle) => {
  if (typeof value === 'string') return value.includes(needle);
  if (Array.isArray(value)) return value.some((v) => jsonStringContains(v, needle));
  if (value !== null && typeof value === 'object') return Object.values(value).some((v) => jsonStringContains(v, needle));
  return false;
};

// Is the gate-approval hook wired anywhere in a settings blob? Parse when possible and scan the
// DECODED string values (catches `\/` / `/` escapes); on malformed JSON fall back to a raw
// substring probe. Deliberately BROADER than the writer's exact-command check (any string mentioning
// the placed path counts): over-detection preserves the hook file, under-detection could remove a
// still-wired one — so the fallback errs toward wired.
const settingsMentionsGateHook = (settings) => {
  const parsed = (() => { try { return JSON.parse(settings); } catch { return null; } })();
  return parsed !== null && typeof parsed === 'object'
    ? jsonStringContains(parsed, GATE_HOOK_FILE_REL)
    : settings.includes(GATE_HOOK_FILE_REL);
};

// Detect the three settings.json seams the family may have written: the attribution edit
// (`includeCoAuthoredBy`), the velocity profile (`permissions.defaultMode` / `permissions.allow`),
// and the gate-approval hook wiring (a PreToolUse entry running the placed hook file — probed by
// the placed path across DECODED string values, deliberately BROADER than the writer's exact-command
// check: a hand-edited variant still counts as wired, so the file is preserved rather than removed).
// Parse when possible (accurate); on malformed JSON fall back to a substring probe for the
// attribution key so it is still surfaced (no silent miss). The velocity writer stores NO ownership
// marker, so the permissions seam is reported NON-COMMITTALLY — never a false ownership claim,
// never auto-removed.
// The MCP seam: the enabled-list membership or either derived tool allow rule. Same posture as the
// two seams beside it — over-detection is safe (REPORT_ONLY is never auto-removed), a silent miss
// would leave a registration nobody was told about.
const MCP_ALLOW_RULES = allowRulesFor();
const MCP_PRESENT = MCP_STATE.PRESENT;
const SETTINGS_REL_TXT = '.claude/settings.json';
const settingsMentionsMcp = (settings, parsed) => {
  if (parsed == null || typeof parsed !== 'object') {
    return settings.includes(MCP_ENABLED_KEY) || MCP_ALLOW_RULES.some((rule) => settings.includes(rule));
  }
  const enabled = Array.isArray(parsed[MCP_ENABLED_KEY]) ? parsed[MCP_ENABLED_KEY] : [];
  const allow = Array.isArray(parsed.permissions?.allow) ? parsed.permissions.allow : [];
  return enabled.includes(MCP_SERVER_NAME) || MCP_ALLOW_RULES.some((rule) => allow.includes(rule));
};

const detectSettingsSeams = (settings) => {
  if (settings == null) return { attribution: false, permissions: false, gateHook: false, mcp: false, parsed: true };
  const gateHook = settingsMentionsGateHook(settings);
  const parsed = (() => { try { return JSON.parse(settings); } catch { return null; } })();
  const mcp = settingsMentionsMcp(settings, parsed);
  if (parsed == null || typeof parsed !== 'object') {
    // Malformed / JSONC settings.json (comments, trailing commas) — probe the seams by substring so
    // none is silently missed (over-reporting REPORT_ONLY is safe; it is never auto-removed).
    return {
      attribution: settings.includes('includeCoAuthoredBy'),
      permissions: settings.includes('"permissions"') && (settings.includes('"defaultMode"') || settings.includes('"allow"')),
      gateHook,
      mcp,
      parsed: false,
    };
  }
  const perms = parsed.permissions;
  const permissions = perms != null && typeof perms === 'object'
    && (Object.prototype.hasOwnProperty.call(perms, 'defaultMode') || Object.prototype.hasOwnProperty.call(perms, 'allow'));
  return { attribution: Object.prototype.hasOwnProperty.call(parsed, 'includeCoAuthoredBy'), permissions, gateHook, mcp, parsed: true };
};

const ATTRIBUTION_REASON = 'we set "includeCoAuthoredBy": false here — review/remove that key by hand (the file may hold your own settings)';
const PERMISSIONS_REASON = 'a "permissions.defaultMode" and/or "permissions.allow" key is present in this file — if the velocity profile seeded them, review/remove by hand (no ownership marker is stored); otherwise leave them';
const GATE_HOOK_SEAM_REASON = `a PreToolUse entry wiring the kit-placed gate-approval hook (${GATE_HOOK_FILE_REL}) is present — remove that entry by hand to unwire it (the tool never edits settings)`;

const MCP_SEAM_REASON = `the MCP registration keys for "${MCP_SERVER_NAME}" are present in this file ("${MCP_ENABLED_KEY}" and/or the ${MCP_ALLOW_RULES.join(' / ')} allow rules) — remove them by hand to unregister the typed channel (the tool never edits settings)`;
// Over a file that could not be PARSED, the same seams are probed by substring — so any string or
// comment mentioning a managed token matches. That is deliberate (a missed seam is worse than an
// over-reported one), but the sentence must not then assert presence it never established.
const UNCERTAIN_PREFIX = 'this file could not be parsed, so the seams below are text matches rather than established keys — verify before acting. ';

const settingsSeamReason = (seams) =>
  (seams.parsed === false ? UNCERTAIN_PREFIX : '') +
  [
    ...(seams.attribution ? [ATTRIBUTION_REASON] : []),
    ...(seams.permissions ? [PERMISSIONS_REASON] : []),
    ...(seams.gateHook ? [GATE_HOOK_SEAM_REASON] : []),
    ...(seams.mcp ? [MCP_SEAM_REASON] : []),
  ].join('. Also: ');

const settingsSeamHand = (seams, p) => {
  const clauses = [
    ...(seams.attribution ? ['remove the "includeCoAuthoredBy" entry'] : []),
    ...(seams.permissions
      ? [seams.attribution
          ? 'review "permissions.defaultMode"/"permissions.allow" (if the velocity profile seeded them)'
          : 'if the velocity profile seeded "permissions.defaultMode"/"permissions.allow", review/remove them by hand']
      : []),
    ...(seams.gateHook ? [`remove the PreToolUse entry whose command runs ${GATE_HOOK_FILE_REL}`] : []),
    ...(seams.mcp ? [`remove "${MCP_SERVER_NAME}" from "${MCP_ENABLED_KEY}" and the ${MCP_ALLOW_RULES.join(" / ")} allow rules`] : []),
  ];
  return `edit ${shq(p)} → ${clauses.join(' and ')} (keep the rest of your settings)`;
};

// The "do this by hand" line for a report-only surface. A settings.json item carries its own `hand`
// guidance (an EDIT, never an `rm` — deleting it would lose the user's own settings, codex #4);
// everything else is a quoted rm. The fallback preserves the attribution wording for a bare item.
const handGuidance = (item) =>
  item.hand ??
  (item.surface === 'settings'
    ? `edit ${shq(item.path)} → remove the "includeCoAuthoredBy" entry (keep the rest of your settings)`
    : `rm -rf ${shq(item.path)}   # if it was committed:  git rm -r --cached ${shq(item.path)}`);

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

It NEVER deletes user-authored content — docs/ai and the entry-point docs are reported with the exact
rm commands for you to run, and .claude/settings.json with an EDIT instruction (remove the attribution
key; review any velocity permissions.*), never an rm. A skill dir not provably ours is left untouched.`;

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

if (isDirectRun(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message ?? err);
    process.exit(1);
  }
}
