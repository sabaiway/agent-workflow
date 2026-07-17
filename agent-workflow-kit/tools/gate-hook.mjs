#!/usr/bin/env node
// gate-hook.mjs — the onboarding writer behind `/agent-workflow-kit hook`: places the bundled
// PreToolUse gate-approval hook runtime (references/hooks/gate-approve.mjs) to the project's
// .claude/hooks/agent-workflow-gates.mjs and wires ONE `PreToolUse` "Bash" entry into
// .claude/settings.json. The hook then auto-approves byte-exact invocations of the gates
// declared in docs/ai/gates.json (run from the project root) and asks on seeded-read-only
// commands carrying the documented runtime residual — see the runtime's own header.
//
// A separate SIBLING of velocity, deliberately NOT a velocity flag: velocity's test-pinned
// invariant is "writes ONLY .claude/settings.json", while this writer also places a file. It
// REUSES the exported velocity machinery (readSettingsFile / resolveEffectiveMode) rather than
// re-deriving it, and follows the family writer discipline verbatim:
//   • preview-then-mutate — `--dry-run` is the DEFAULT and writes nothing; `--apply` writes;
//   • deployment-gated — `--apply` STOPs unless docs/ai/.workflow-version equals the lineage
//     head (a dry-run stays usable on any project);
//   • symlink-safe — a symlinked `.claude` / `.claude/hooks` / target file / settings.json is
//     a STOP on BOTH dry-run and apply (a dry-run never promises a write the apply refuses);
//   • refuses `bypassPermissions` / unsafe modes in EITHER settings file;
//   • merge-don't-clobber — foreign hooks/matchers/keys and existing permissions are preserved
//     semantically; our entry is added idempotently (re-apply never duplicates). The reused
//     readSettingsFile validates `permissions.*` ONLY, so this writer adds its OWN strict shape
//     precondition on any existing `hooks` key — a malformed `hooks`/`hooks.PreToolUse[]` shape
//     is a STOP with ZERO writes, never a merge-through-clobber;
//   • place-then-wire ORDER — the hook file is placed BEFORE settings are wired (a
//     wired-but-missing hook would error on every Bash call);
//   • a target hook file with DIFFERENT content while our entry is NOT wired is a precondition
//     STOP (no file write, no settings mutation — wiring an unknown script as a PreToolUse hook
//     is exactly what consent must not slide past); the recovery is named: delete the file to
//     reseed from the bundle. An identical file is `already current`; an already-wired entry
//     pointing at a diverged file is REPORTED, never unwired or clobbered (the cheap-agents
//     preserved-customization discipline — no refresh-in-place, no marker/checksum machinery);
//   • never writes settings.local.json; never commits.
//
// The `--read-lane` flag is a SEPARATE operation (AD-055 Part II): it enables the opt-in read-only
// compound lane in docs/ai/lanes.json after a currency check, and never touches settings or
// gates.json — see the read-lane writer section below.
//
// Exit codes: 0 done / dry-run (incl. the report-only diverged-but-wired state); 1 precondition
// STOP; 2 usage. Dependency-free beyond the kit's own internal exports, Node >= 22. No side
// effects on import.

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CLAUDE_DIR,
  EXPECTED_WORKFLOW_VERSION,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  UNSAFE_BYPASS_MODE,
  SAFE_DEFAULT_MODES,
  WORKFLOW_STAMP,
  readSettingsFile,
  resolveEffectiveMode,
} from './velocity-profile.mjs';
import { assertDocsAiDeployment, writeDocsAiFileAtomic } from './atomic-write.mjs';
import { shellQuoteArg } from './review-state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// This tool's own absolute path — the recovery / apply one-liners the read-lane writer prints.
export const GATE_HOOK_TOOL = fileURLToPath(import.meta.url);
const q = shellQuoteArg;

export const BUNDLED_HOOK_PATH = resolve(HERE, '..', 'references', 'hooks', 'gate-approve.mjs');
export const HOOKS_DIR = '.claude/hooks';
export const HOOK_FILE_REL = `${HOOKS_DIR}/agent-workflow-gates.mjs`;
export const PRE_TOOL_USE_EVENT = 'PreToolUse';
export const HOOK_MATCHER = 'Bash';
// The literal settings fragment (the plan/test fixture): $CLAUDE_PROJECT_DIR is resolved by
// Claude Code when it runs the hook command, so the entry survives project relocation.
export const HOOK_COMMAND = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/agent-workflow-gates.mjs"';
export const HOOK_TIMEOUT_SECONDS = 30;

export const GATE_HOOK_STAMP = 'GATE_HOOK_STAMP';
export const GATE_HOOK_SYMLINK = 'GATE_HOOK_SYMLINK';
export const GATE_HOOK_UNSAFE_MODE = 'GATE_HOOK_UNSAFE_MODE';
export const GATE_HOOK_MALFORMED = 'GATE_HOOK_MALFORMED';
export const GATE_HOOK_DIVERGED = 'GATE_HOOK_DIVERGED';
export const GATE_HOOK_BUNDLE = 'GATE_HOOK_BUNDLE';
// --read-lane (AD-055 Part II): the opt-in read-only compound lane toggle + its currency guard.
export const LANES_REL = 'docs/ai/lanes.json';
export const READ_LANE_KEY = 'readLane';
export const GATE_HOOK_STALE = 'GATE_HOOK_STALE'; // the placed hook is absent/stale — the lane cannot fire
export const GATE_HOOK_LANE = 'GATE_HOOK_LANE'; // a lanes.json write refusal (deployment/malformed)

const EXIT_OK = 0;
const EXIT_PRECONDITION = 1;
const EXIT_USAGE = 2;
const UTF8 = 'utf8';
const LF = '\n';
const CRLF = '\r\n';
const ERROR_PREFIX = '[agent-workflow-kit]';
const SETTINGS_JSON_INDENT = 2;
const JSON_NEWLINE_PATTERN = /\n/gu;

const TARGET_PLACE = 'place';
const TARGET_CURRENT = 'already-current';
const TARGET_DIVERGED = 'diverged';

const USAGE = `usage: gate-hook [--dry-run | --apply] [--cwd <dir>] [--help]
       gate-hook --read-lane [--dry-run | --apply] [--cwd <dir>]   (enable the opt-in read-only compound lane)

Places the bundled PreToolUse gate-approval hook to ${HOOK_FILE_REL} and wires ONE
PreToolUse "Bash" entry into ${SETTINGS_FILE}. Default is --dry-run (a preview; writes
nothing). --apply writes. The hook auto-approves byte-exact declared gate cmds
(docs/ai/gates.json, project root) and asks on seeded-read-only commands carrying the
documented runtime residual.

--read-lane enables the opt-in read-only COMPOUND lane in ${LANES_REL} ("${READ_LANE_KEY}": true) — the
hook then auto-approves compounds of the seeded read-only core carrying zero shell metaprogramming.
--apply --read-lane verifies the PLACED hook is the CURRENT bundle first (a pre-1.48 hook never reads
${LANES_REL}) and refuses with the delete-to-reseed recovery otherwise. Never touches ${SETTINGS_FILE}
or docs/ai/gates.json.

Never writes ${SETTINGS_LOCAL_FILE}; never commits.`;

export const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

export const makeGateHookError = (code, message) =>
  Object.assign(new Error(`${ERROR_PREFIX} ${message}`), { name: 'GateHookError', code, exitCode: EXIT_PRECONDITION });

const fsDeps = (deps = {}) => ({
  exists: deps.exists ?? deps.existsSync ?? existsSync,
  lstat: deps.lstat ?? deps.lstatSync ?? lstatSync,
  mkdir: deps.mkdir ?? deps.mkdirSync ?? mkdirSync,
  readFile: deps.readFile ?? deps.readFileSync ?? readFileSync,
  writeFile: deps.writeFile ?? deps.writeFileSync ?? writeFileSync,
});

const lstatNoFollow = (absPath, fs) => {
  try {
    return fs.lstat(absPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
};

const isJsonObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// ── the bundle ────────────────────────────────────────────────────────────────────────

export const readBundledHook = (deps = {}) => {
  const fs = fsDeps(deps);
  const bundlePath = deps.bundlePath ?? BUNDLED_HOOK_PATH;
  try {
    return fs.readFile(bundlePath, UTF8);
  } catch (err) {
    throw makeGateHookError(GATE_HOOK_BUNDLE, `bundled hook runtime unreadable (${err.code ?? err.message}): ${bundlePath} — the kit install is incomplete`);
  }
};

// ── preflight (read-only; velocity discipline) ────────────────────────────────────────

const readStamp = (absPath, fs) => {
  try {
    if (!fs.exists(absPath)) return null;
    const stamp = String(fs.readFile(absPath, UTF8)).trim();
    return stamp.length ? stamp : null;
  } catch {
    return null; // unreadable stamp == not a valid deployment stamp (apply STOPs; dry-run reports)
  }
};

const assertDirSafe = (absPath, relPath, fs) => {
  const stat = lstatNoFollow(absPath, fs);
  if (stat === null) return;
  if (stat.isSymbolicLink()) throw makeGateHookError(GATE_HOOK_SYMLINK, `${relPath} is a symlink — refusing to write through it`);
  if (!stat.isDirectory()) throw makeGateHookError(GATE_HOOK_SYMLINK, `${relPath} exists but is not a directory — refusing to write through it`);
};

const assertSettingsWritable = (absPath, fs) => {
  const stat = lstatNoFollow(absPath, fs);
  if (stat !== null && !stat.isFile()) {
    throw makeGateHookError(GATE_HOOK_SYMLINK, `${SETTINGS_FILE} exists but is not a regular file — refusing to clobber it`);
  }
};

// Target plan: place | already-current | diverged. A symlinked / non-regular target is a STOP —
// never a write-through, never a comparison pretending it is a file.
const planTarget = (absPath, bundleContent, fs) => {
  const stat = lstatNoFollow(absPath, fs);
  if (stat === null) return { action: TARGET_PLACE };
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw makeGateHookError(GATE_HOOK_SYMLINK, `${HOOK_FILE_REL} exists but is not a regular file — refusing to touch it`);
  }
  return fs.readFile(absPath, UTF8) === bundleContent ? { action: TARGET_CURRENT } : { action: TARGET_DIVERGED };
};

// The reused readSettingsFile validates permissions.* ONLY — this writer scans and appends
// inside `hooks`, so any existing `hooks` key must be shape-valid BEFORE a write is planned:
// a malformed shape is a STOP with zero writes, never a merge-through-clobber.
const assertHooksShape = (data, relPath) => {
  if (data === undefined || data.hooks === undefined) return;
  if (!isJsonObject(data.hooks)) {
    throw makeGateHookError(GATE_HOOK_MALFORMED, `${relPath}: "hooks" must be a JSON object`);
  }
  const entries = data.hooks[PRE_TOOL_USE_EVENT];
  if (entries === undefined) return;
  if (!Array.isArray(entries)) {
    throw makeGateHookError(GATE_HOOK_MALFORMED, `${relPath}: "hooks.${PRE_TOOL_USE_EVENT}" must be an array`);
  }
  for (const entry of entries) {
    if (!isJsonObject(entry)) {
      throw makeGateHookError(GATE_HOOK_MALFORMED, `${relPath}: every "hooks.${PRE_TOOL_USE_EVENT}[]" entry must be a JSON object`);
    }
    if (entry.hooks !== undefined && (!Array.isArray(entry.hooks) || entry.hooks.some((hook) => !isJsonObject(hook)))) {
      throw makeGateHookError(GATE_HOOK_MALFORMED, `${relPath}: "hooks.${PRE_TOOL_USE_EVENT}[].hooks" must be an array of objects`);
    }
  }
};

// Defensive scan (never throws): used for wired-detection in BOTH settings files — the local file
// is read-only for this writer, so its shape is never a STOP, just never a false match. An entry
// counts as OUR wiring only when it targets Bash (matcher "Bash") AND carries a command-type hook
// running HOOK_COMMAND — a same-command entry under a different matcher (e.g. "Write") is NOT our
// Bash approval hook, so it must not suppress the merge (else approvals/guard stay inactive while
// status reports wired).
export const isHookWired = (data) => {
  const entries = isJsonObject(data) && isJsonObject(data.hooks) ? data.hooks[PRE_TOOL_USE_EVENT] : undefined;
  if (!Array.isArray(entries)) return false;
  return entries.some(
    (entry) =>
      isJsonObject(entry) &&
      entry.matcher === HOOK_MATCHER &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some((hook) => isJsonObject(hook) && hook.type === 'command' && hook.command === HOOK_COMMAND),
  );
};

export const buildHookSettingsEntry = () => ({
  matcher: HOOK_MATCHER,
  hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS }],
});

// Append our ONE entry; every foreign hook/matcher/key is carried over untouched. Only called
// when the entry is absent (idempotence lives in the caller's plan, not in dedup-on-write).
export const mergeHookEntry = (base) => {
  const root = isJsonObject(base) ? base : {};
  const hooks = isJsonObject(root.hooks) ? root.hooks : {};
  const entries = Array.isArray(hooks[PRE_TOOL_USE_EVENT]) ? hooks[PRE_TOOL_USE_EVENT] : [];
  return { ...root, hooks: { ...hooks, [PRE_TOOL_USE_EVENT]: [...entries, buildHookSettingsEntry()] } };
};

export const preflightGateHook = ({ cwd }, deps = {}) => {
  const fs = fsDeps(deps);
  const projectDir = cwd ?? deps.cwd ?? process.cwd();
  const bundleContent = readBundledHook(deps);
  const stamp = readStamp(join(projectDir, WORKFLOW_STAMP), fs);
  const stampOk = stamp === EXPECTED_WORKFLOW_VERSION;
  assertDirSafe(join(projectDir, CLAUDE_DIR), CLAUDE_DIR, fs);
  assertDirSafe(join(projectDir, HOOKS_DIR), HOOKS_DIR, fs);
  const target = planTarget(join(projectDir, HOOK_FILE_REL), bundleContent, fs);
  assertSettingsWritable(join(projectDir, SETTINGS_FILE), fs);
  const projectSettings = readSettingsFile(join(projectDir, SETTINGS_FILE), { ...deps, cwd: projectDir });
  const localSettings = readSettingsFile(join(projectDir, SETTINGS_LOCAL_FILE), { ...deps, cwd: projectDir });
  const { bypassPermissionsPresent, unsafeModePresent } = resolveEffectiveMode(projectSettings.data, localSettings.data);

  if (bypassPermissionsPresent) {
    throw makeGateHookError(GATE_HOOK_UNSAFE_MODE, `${UNSAFE_BYPASS_MODE} appears in Claude settings - refusing because it auto-approves Bash`);
  }
  if (unsafeModePresent) {
    throw makeGateHookError(
      GATE_HOOK_UNSAFE_MODE,
      `an unsafe or unknown permissions.defaultMode is present in Claude settings - accepted modes: ${SAFE_DEFAULT_MODES.join(', ')}`,
    );
  }
  assertHooksShape(projectSettings.data, SETTINGS_FILE);

  const wiredInProject = isHookWired(projectSettings.data);
  const wiredInLocal = isHookWired(localSettings.data);
  // Diverged target + our entry NOT wired anywhere = STOP on BOTH dry-run and apply: applying
  // would wire an unknown script as a PreToolUse hook — exactly what consent must not slide
  // past. (Diverged + already wired is the user's own standing state: report-only, below.)
  if (target.action === TARGET_DIVERGED && !wiredInProject && !wiredInLocal) {
    throw makeGateHookError(
      GATE_HOOK_DIVERGED,
      `${HOOK_FILE_REL} exists with DIFFERENT content and is not wired — refusing to wire an unknown script as a PreToolUse hook; delete the file to reseed from the bundle, then re-run`,
    );
  }

  return { projectDir, bundleContent, stamp, stampOk, target, projectSettings, localSettings, wiredInProject, wiredInLocal };
};

// ── the writer ────────────────────────────────────────────────────────────────────────

const formatJson = (data, eol) =>
  `${JSON.stringify(data, null, SETTINGS_JSON_INDENT).replace(JSON_NEWLINE_PATTERN, eol)}${eol}`;

export const writeGateHook = ({ cwd, dryRun = true } = {}, deps = {}) => {
  const fs = fsDeps(deps);
  const preflight = preflightGateHook({ cwd: cwd ?? deps.cwd ?? process.cwd() }, deps);
  const placePlanned = preflight.target.action === TARGET_PLACE;
  const wirePlanned = !preflight.wiredInProject && !preflight.wiredInLocal;
  const base = { placePlanned, wirePlanned, ...preflight };
  if (dryRun) return { wrote: false, dryRun: true, ...base };

  if (!preflight.stampOk) {
    throw makeGateHookError(
      GATE_HOOK_STAMP,
      `not a deployed agent-workflow project at lineage ${EXPECTED_WORKFLOW_VERSION} (found ${preflight.stamp ?? 'none'}) — run init/upgrade first`,
    );
  }

  // Place FIRST, then wire — a wired-but-missing hook would error on every Bash call.
  const hookAbs = join(preflight.projectDir, HOOK_FILE_REL);
  if (placePlanned) {
    fs.mkdir(join(preflight.projectDir, HOOKS_DIR), { recursive: true });
    fs.writeFile(hookAbs, preflight.bundleContent, UTF8);
  }
  if (wirePlanned) {
    // Re-verify the target no-follow immediately BEFORE wiring: preflight read it earlier, and an
    // external process could have swapped it (or slipped a symlink in) between preflight and now.
    // Wiring settings to point at an unknown script is exactly what consent must not slide past, so
    // confirm the on-disk bytes are still the bundle — abort with zero settings mutation otherwise.
    const onDisk = lstatNoFollow(hookAbs, fs);
    if (onDisk === null || onDisk.isSymbolicLink() || !onDisk.isFile() || fs.readFile(hookAbs, UTF8) !== preflight.bundleContent) {
      throw makeGateHookError(
        GATE_HOOK_DIVERGED,
        `${HOOK_FILE_REL} changed after preflight — refusing to wire an unknown script as a PreToolUse hook (no settings change made); re-run`,
      );
    }
    const merged = mergeHookEntry(preflight.projectSettings.data ?? {});
    fs.writeFile(
      join(preflight.projectDir, SETTINGS_FILE),
      formatJson(merged, preflight.projectSettings.eol ?? LF),
      UTF8,
    );
  }
  return { wrote: placePlanned || wirePlanned, dryRun: false, ...base };
};

// ── the read-lane writer (--read-lane; AD-055 Part II, Decisions 5/9) ──────────────────
// Enables the opt-in read-only COMPOUND lane by writing { "readLane": true } into the kit-owned
// docs/ai/lanes.json (a SEPARATE file — gates.json is never touched). Same family writer discipline
// as the base flow + ack-write (preview-then-mutate, deployment-gated, create-if-absent,
// merge-preserve, symlink/non-regular refusal, malformed-JSON fail-closed, atomic), PLUS a CURRENCY
// CHECK (Decisions 9): --apply refuses unless the PLACED hook is byte-identical to the current
// bundle — enabling a lane a pre-1.48 hook can never read would be a silent no-op the user paid
// consent for. The refusal names the delete-to-reseed recovery.

const laneStop = (message) => makeGateHookError(GATE_HOOK_LANE, message);

// Read the existing lanes.json (already gated as a regular file). ENOENT (a TOCTOU vanish) → absent
// {}; malformed JSON / a non-object root FAILS CLOSED — never overwrite an unparseable toggle file.
const readExistingLanes = (absPath, deps) => {
  const readFile = deps.readFile ?? readFileSync;
  let text;
  try {
    text = readFile(absPath, UTF8);
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    throw laneStop(`cannot read ${LANES_REL} (${err?.code ?? err?.message}) — refusing to overwrite it`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw laneStop(`${LANES_REL} is not valid JSON — refusing to overwrite it (fix or delete it, then re-run)`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw laneStop(`${LANES_REL} is not a JSON object — refusing to overwrite it`);
  }
  return parsed;
};

// Target gate: a symlinked / non-regular lanes.json is a STOP checked BEFORE any read (a FIFO can
// never block the reader). Returns { existed, existing } — the merge base.
const preflightLaneTarget = (absPath, deps) => {
  const fs = fsDeps(deps);
  const st = lstatNoFollow(absPath, fs);
  if (st === null) return { existed: false, existing: {} };
  if (st.isSymbolicLink()) throw makeGateHookError(GATE_HOOK_SYMLINK, `${LANES_REL} is a symlink — refusing to write through it`);
  if (!st.isFile()) throw makeGateHookError(GATE_HOOK_SYMLINK, `${LANES_REL} exists but is not a regular file — refusing to touch it`);
  return { existed: true, existing: readExistingLanes(absPath, deps) };
};

export const applyGateHookCommand = (root) => `node ${q(GATE_HOOK_TOOL)} --apply --cwd ${q(root)}`;
export const applyReadLaneCommand = (root) => `node ${q(GATE_HOOK_TOOL)} --read-lane --cwd ${q(root)} --apply`;

// The currency check (Decisions 9): the PLACED hook must be byte-identical to the current bundle,
// else enabling the lane is a no-op. Returns { current, reason, refusal? }; a symlinked / non-regular
// placed hook is a hard STOP.
const checkHookCurrency = (root, bundleContent, fs) => {
  const hookAbs = join(root, HOOK_FILE_REL);
  const st = lstatNoFollow(hookAbs, fs);
  if (st === null) {
    return {
      current: false,
      reason: `${HOOK_FILE_REL} is not placed`,
      refusal: `${HOOK_FILE_REL} is not placed — the read-lane cannot fire. Place the hook first:\n  ${applyGateHookCommand(root)}\nthen re-run with --read-lane.`,
    };
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw makeGateHookError(GATE_HOOK_SYMLINK, `${HOOK_FILE_REL} is not a regular file — refusing to touch it`);
  }
  if (fs.readFile(hookAbs, UTF8) !== bundleContent) {
    return {
      current: false,
      reason: `${HOOK_FILE_REL} is not the current bundle`,
      refusal: `${HOOK_FILE_REL} is NOT the current bundle — enabling the read-lane now would be a silent no-op (a pre-1.48 hook never reads ${LANES_REL}). Reseed it, then re-run with --read-lane:\n  rm ${q(join(root, HOOK_FILE_REL))}\n  ${applyGateHookCommand(root)}`,
    };
  }
  return { current: true, reason: 'the placed hook is the current bundle' };
};

// Pure preflight (both dry-run and apply): deployment gate + the merge over the existing toggle file.
export const planReadLane = ({ cwd }, deps = {}) => {
  const root = resolve(cwd);
  assertDocsAiDeployment(root, deps, { stop: laneStop, noun: 'the read-lane toggle', rel: LANES_REL });
  const absPath = join(root, LANES_REL);
  const { existed, existing } = preflightLaneTarget(absPath, deps);
  const already = existing[READ_LANE_KEY] === true;
  const merged = { ...existing, [READ_LANE_KEY]: true };
  const otherKeys = Object.keys(existing).filter((k) => k !== READ_LANE_KEY);
  return { root, absPath, existed, existing, merged, already, otherKeys };
};

// A byte-current hook that is not WIRED never fires — enabling the lane against it is the same
// silent no-op the currency check guards (council B5). Wired-detection reuses the writer's own
// isHookWired over BOTH settings scopes (the hooks contract merges both).
const checkHookWired = (root, deps) => {
  const project = readSettingsFile(join(root, SETTINGS_FILE), { ...deps, cwd: root });
  const local = readSettingsFile(join(root, SETTINGS_LOCAL_FILE), { ...deps, cwd: root });
  return isHookWired(project.data) || isHookWired(local.data);
};

export const writeReadLane = ({ cwd, dryRun = true } = {}, deps = {}) => {
  const fs = fsDeps(deps);
  const bundleContent = readBundledHook(deps);
  const plan = planReadLane({ cwd: cwd ?? deps.cwd ?? process.cwd() }, deps);
  const currency = checkHookCurrency(plan.root, bundleContent, fs);
  const wired = checkHookWired(plan.root, deps);
  const stamp = readStamp(join(plan.root, WORKFLOW_STAMP), fs);
  const stampOk = stamp === EXPECTED_WORKFLOW_VERSION;
  if (dryRun) return { wrote: false, dryRun: true, currency, wired, stamp, stampOk, ...plan };
  if (!currency.current) throw makeGateHookError(GATE_HOOK_STALE, currency.refusal);
  if (!wired) {
    throw makeGateHookError(
      GATE_HOOK_STALE,
      `${HOOK_FILE_REL} is placed and current but NOT wired into ${SETTINGS_FILE} — the read-lane cannot fire. Wire it first:\n  ${applyGateHookCommand(plan.root)}\nthen re-run with --read-lane.`,
    );
  }
  if (!stampOk) {
    throw makeGateHookError(
      GATE_HOOK_STAMP,
      `not a deployed agent-workflow project at lineage ${EXPECTED_WORKFLOW_VERSION} (found ${stamp ?? 'none'}) — run init/upgrade first`,
    );
  }
  if (plan.already) return { wrote: false, dryRun: false, currency, wired, stamp, stampOk, ...plan };
  const body = `${JSON.stringify(plan.merged, null, SETTINGS_JSON_INDENT)}\n`;
  writeDocsAiFileAtomic(plan.root, LANES_REL, body, deps, { stop: laneStop, noun: 'the read-lane toggle' });
  return { wrote: true, dryRun: false, currency, wired, stamp, stampOk, ...plan };
};

const READ_LANE_POSTURE =
  "posture: an auto-allowed read chain runs UNATTENDED and can read any file you can — the SAME trust boundary as the AUDITED read-only core velocity seeds, extended to COMPOUNDS (and singles) of that core. The subset invariant holds against that AUDITED CORE (every segment is an audited-core read), so the lane is a standalone opt-in grant BOUNDED BY the audited core — never a command outside it; it auto-approves those core commands REGARDLESS of which you seeded as individual settings rules (not strictly a subset of your current settings). This consent is a PROJECT-PERSISTENT declaration in docs/ai/lanes.json — it applies to every future session and to subagents' Bash, and where docs/ai is committed, to every checkout. It bypasses the PROMPT only, never the OS sandbox; on engine builds where a hook allow supersedes an ask rule, the opt-in covers EXACTLY the audited read-only core — nothing else.";

export const formatReadLaneResult = (result) => {
  const merge = result.otherKeys.length > 0 ? ` (merge-preserving ${result.otherKeys.length} existing key(s))` : '';
  if (!result.dryRun) {
    if (result.already) {
      return `agent-workflow read-lane — APPLY: ${LANES_REL} already enables the read-lane — nothing to do (hook currency verified).`;
    }
    return [
      'agent-workflow read-lane — APPLY',
      `  - ${LANES_REL}: "${READ_LANE_KEY}" = true${merge}`,
      '  - hook currency verified: the placed hook is the current bundle — the lane is active for new Bash calls.',
    ].join(LF);
  }
  const lines = [
    result.already
      ? `agent-workflow read-lane — DRY RUN: ${LANES_REL} already enables the read-lane ("${READ_LANE_KEY}": true) — nothing to do.`
      : 'agent-workflow read-lane — DRY RUN (no changes; re-run with --apply --read-lane)',
  ];
  if (!result.already) lines.push(`  - would ${result.existed ? 'set' : 'create'} ${LANES_REL} "${READ_LANE_KEY}" = true${merge}`);
  lines.push(
    result.currency.current
      ? '  hook currency: current — the lane will fire once enabled.'
      : `  hook currency: STALE — ${result.currency.reason}; --apply will REFUSE until you reseed the placed hook.`,
  );
  if (!result.wired) {
    lines.push(`  hook wiring: NOT wired into ${SETTINGS_FILE}; --apply will REFUSE until you wire it (${applyGateHookCommand(result.root)}).`);
  }
  if (!result.stampOk) {
    lines.push(`  deployment stamp: ${result.stamp ?? 'none'} ≠ lineage head ${EXPECTED_WORKFLOW_VERSION}; --apply will REFUSE until init/upgrade runs.`);
  }
  lines.push(READ_LANE_POSTURE);
  if (!result.already) lines.push(`  to apply: ${applyReadLaneCommand(result.root)}`);
  return lines.join(LF);
};

// ── report ────────────────────────────────────────────────────────────────────────────

const TRUST_POSTURE_LINE =
  'trust posture: the hook auto-approves ONLY byte-exact matches of the gate cmds declared in docs/ai/gates.json, invoked from the project root — gates.json is thereby a privileged file (whoever can edit it can get its commands auto-approved); an invalid declaration approves nothing.';

const formatTargetLine = (result) => {
  if (result.target.action === TARGET_PLACE) return `  - ${HOOK_FILE_REL}: ${result.dryRun ? 'would place' : 'placed'}`;
  if (result.target.action === TARGET_CURRENT) return `  - ${HOOK_FILE_REL}: already current`;
  return `  - ${HOOK_FILE_REL}: diverged from the bundle — preserved, never clobbered (already wired; delete the file to reseed from the bundle)`;
};

const formatSettingsLine = (result) => {
  if (result.wiredInProject) return `  - ${SETTINGS_FILE}: already wired`;
  if (result.wiredInLocal) return `  - ${SETTINGS_FILE}: already wired via ${SETTINGS_LOCAL_FILE} — not duplicated`;
  return `  - ${SETTINGS_FILE}: ${result.dryRun ? 'would wire' : 'wired'} the ${PRE_TOOL_USE_EVENT} "${HOOK_MATCHER}" entry`;
};

export const formatResult = (result) => {
  const lines = [
    result.dryRun
      ? 'agent-workflow gate hook — DRY RUN (no changes; re-run with --apply)'
      : 'agent-workflow gate hook — APPLY',
    formatTargetLine(result),
    formatSettingsLine(result),
    TRUST_POSTURE_LINE,
  ];
  if (!result.stampOk) {
    lines.push(`note: no current deployment stamp found (${result.stamp ?? 'none'}) — --apply will refuse until init/upgrade runs.`);
  }
  if (!result.dryRun && result.wrote) {
    lines.push('settings hot-reload: the hook is active for new Bash calls — no session restart needed.');
    lines.push('hidden-mode note: if this deployment is hidden, run the hide-footprint reconcile so the placed hook stays out of `git status` (the registry carries /.claude/hooks/).');
  }
  return lines.join(LF);
};

// ── CLI ───────────────────────────────────────────────────────────────────────────────

export const parseArgs = (argv) => {
  const opts = { dryRunFlag: false, apply: false, cwd: undefined, help: false, readLane: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--dry-run') opts.dryRunFlag = true;
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '--read-lane') opts.readLane = true;
    else if (arg === '--cwd') {
      i += 1;
      if (argv[i] === undefined || argv[i].startsWith('-')) throw fail(EXIT_USAGE, '--cwd needs a directory argument');
      opts.cwd = argv[i];
    } else {
      throw fail(EXIT_USAGE, `unknown argument: ${arg}`);
    }
  }
  if (opts.dryRunFlag && opts.apply) throw fail(EXIT_USAGE, '--dry-run and --apply cannot be used together');
  return { help: opts.help, dryRun: !opts.apply, cwd: opts.cwd, readLane: opts.readLane };
};

export const main = (argv = process.argv.slice(2), deps = {}) => {
  const log = deps.log ?? console.log;
  const errlog = deps.errlog ?? console.error;
  try {
    const args = parseArgs(argv);
    if (args.help) {
      log(USAGE);
      return EXIT_OK;
    }
    if (args.readLane) {
      const laneResult = writeReadLane({ cwd: args.cwd ?? deps.cwd ?? process.cwd(), dryRun: args.dryRun }, deps);
      log(formatReadLaneResult(laneResult));
      return EXIT_OK;
    }
    const result = writeGateHook({ cwd: args.cwd ?? deps.cwd ?? process.cwd(), dryRun: args.dryRun }, deps);
    log(formatResult(result));
    return EXIT_OK;
  } catch (err) {
    errlog(err?.message ?? String(err));
    if (err?.exitCode === EXIT_USAGE) errlog(USAGE);
    return err?.exitCode ?? EXIT_PRECONDITION;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exit(main(process.argv.slice(2)));
