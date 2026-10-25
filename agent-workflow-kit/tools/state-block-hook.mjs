#!/usr/bin/env node
// state-block-hook.mjs — the writer behind the `state-block` advisor item: places the bundled
// closing-state-block detector (references/hooks/state-block-guard.mjs) to the project's
// .claude/hooks/state-block-guard.mjs and merges ONE `Stop` entry into .claude/settings.json by the
// three cases of references/modes/state-block-guard.md: no `hooks` key, a `hooks` key without
// `Stop`, and a `hooks.Stop` array, which gains one element.
//
// The symlink, target and settings-shape checks and the hook-file write (writeHookFile) are IMPORTED
// from gate-hook.mjs, with the stamp reader and the settings formatter; the unsafe-mode and stamp
// refusals, the place-then-wire order and the no-follow re-read of the placed file before the
// settings write follow gate-hook's, with its error codes. What is the Stop hook's own:
//   • preview by default; `--apply` writes;
//   • the runtime is created when absent, kept when byte-equal, replaced when it differs (the
//     preview says so; the danger check prints the replaced bytes' digest);
//   • the entry is merged only while no Stop entry of either settings file runs the runtime
//     (isStopHookWired — the one rule; the advisor's convergence imports it);
//   • a `hooks.Stop` that is present and not an array refuses on the preview and the apply alike;
//   • the offered command carries no `--require-block` (the kit does not mandate the block);
//   • never writes settings.local.json; never commits.
//
// Exit codes: 0 done / preview; 1 precondition STOP; 2 usage. Dependency-free beyond the kit's
// own internal exports, Node >= 22. No side effects on import.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_DIR,
  EXPECTED_WORKFLOW_VERSION,
  SAFE_DEFAULT_MODES,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  UNSAFE_BYPASS_MODE,
  WORKFLOW_STAMP,
  readSettingsFile,
  resolveEffectiveMode,
} from './velocity-profile.mjs';
import {
  GATE_HOOK_DIVERGED,
  GATE_HOOK_STAMP,
  GATE_HOOK_UNSAFE_MODE,
  HOOKS_DIR,
  assertDirSafe,
  assertHooksShape,
  assertSettingsWritable,
  formatJson,
  fsDeps,
  makeGateHookError,
  planTarget,
  readBundledHook,
  readStamp,
  writeHookFile,
} from './gate-hook.mjs';
import { isDirectRun } from './direct-run.mjs';
import { fileLine } from './distribution-files/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const STATE_BLOCK_HOOK_RUNTIME = 'state-block-guard.mjs';
export const STATE_BLOCK_HOOK_FILE_REL = `${HOOKS_DIR}/${STATE_BLOCK_HOOK_RUNTIME}`;
const BUNDLED_STATE_BLOCK_HOOK_PATH = resolve(HERE, '..', 'references', 'hooks', STATE_BLOCK_HOOK_RUNTIME);
// NO `--require-block` in the offered command. That flag turns on the absent-block report, and this
// kit does not mandate the three-part closing block — offering it to every project would hand them a
// hook that warns after nearly every turn. The mode doc explains when to add it.
export const STATE_BLOCK_HOOK_COMMAND = `node "$CLAUDE_PROJECT_DIR/${STATE_BLOCK_HOOK_FILE_REL}"`;
const STATE_BLOCK_HOOK_TIMEOUT_SECONDS = 10;
export const STOP_EVENT = 'Stop';

const EXIT_OK = 0;
const EXIT_PRECONDITION = 1;
const EXIT_USAGE = 2;
const UTF8 = 'utf8';
const LF = '\n';

const PLACEMENT_CREATE = 'create';
const PLACEMENT_KEEP = 'keep';
const PLACEMENT_REPLACE = 'replace';
const PLACEMENT_OF = Object.freeze({ place: PLACEMENT_CREATE, 'already-current': PLACEMENT_KEEP, diverged: PLACEMENT_REPLACE });

const MERGE_NO_HOOKS = 'no-hooks';
const MERGE_NO_STOP = 'no-stop';
const MERGE_APPEND = 'append';

const USAGE = `usage: state-block-hook [--apply] [--cwd <dir>] [--help]

Places the bundled closing-state-block detector to ${STATE_BLOCK_HOOK_FILE_REL} (created when
absent, kept when byte-equal, replaced when it differs) and merges ONE ${STOP_EVENT} entry running
${STATE_BLOCK_HOOK_COMMAND} into ${SETTINGS_FILE}, by the three cases of
references/modes/state-block-guard.md. Default is a preview that writes nothing; --apply writes.
The entry is merged only while no ${STOP_EVENT} entry of either settings file runs the runtime.

Never writes ${SETTINGS_LOCAL_FILE}; never commits.`;

const usageError = (message) => Object.assign(new Error(message), { exitCode: EXIT_USAGE });
const isJsonObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// ── the Stop entry ────────────────────────────────────────────────────────────────────

export const buildStopHookEntry = () => ({
  hooks: [{ type: 'command', command: STATE_BLOCK_HOOK_COMMAND, timeout: STATE_BLOCK_HOOK_TIMEOUT_SECONDS }],
});

// Matched on the RUNTIME FILE NAME inside the command, not on an exact string: a hand-wired copy
// may run a kit-source path or carry `--require-block`. Any Stop entry that runs this runtime counts
// as wired — the honest question is "is it watching?". Both entry shapes count: the matcher-group
// form (an object carrying its own `hooks` array) this family ships, and a flat entry.
const runsStateBlockGuard = (hook) => typeof hook?.command === 'string' && hook.command.includes(STATE_BLOCK_HOOK_RUNTIME);
export const isStopHookWired = (data) => {
  const entries = data?.hooks?.[STOP_EVENT];
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => (Array.isArray(entry?.hooks)
    ? entry.hooks.some(runsStateBlockGuard)
    : runsStateBlockGuard(entry)));
};

const mergeCaseOf = (data) => {
  if (!isJsonObject(data) || data.hooks === undefined) return MERGE_NO_HOOKS;
  return data.hooks[STOP_EVENT] === undefined ? MERGE_NO_STOP : MERGE_APPEND;
};

// Append our ONE entry; every foreign hook, matcher and key is carried over untouched. Only called
// when the entry is absent (idempotence lives in the caller's plan, not in dedup-on-write).
export const mergeStopEntry = (base) => {
  const root = isJsonObject(base) ? base : {};
  const hooks = isJsonObject(root.hooks) ? root.hooks : {};
  const entries = Array.isArray(hooks[STOP_EVENT]) ? hooks[STOP_EVENT] : [];
  return { ...root, hooks: { ...hooks, [STOP_EVENT]: [...entries, buildStopHookEntry()] } };
};

// ── the writer ────────────────────────────────────────────────────────────────────────

const preflight = (projectDir, deps) => {
  const fs = fsDeps(deps);
  const bundleContent = readBundledHook({ ...deps, bundlePath: deps.bundlePath ?? BUNDLED_STATE_BLOCK_HOOK_PATH });
  const stamp = readStamp(join(projectDir, WORKFLOW_STAMP), fs);
  assertDirSafe(join(projectDir, CLAUDE_DIR), CLAUDE_DIR, fs);
  assertDirSafe(join(projectDir, HOOKS_DIR), HOOKS_DIR, fs);
  const target = planTarget(join(projectDir, STATE_BLOCK_HOOK_FILE_REL), STATE_BLOCK_HOOK_FILE_REL, bundleContent, fs);
  assertSettingsWritable(join(projectDir, SETTINGS_FILE), fs);
  const projectSettings = readSettingsFile(join(projectDir, SETTINGS_FILE), { ...deps, cwd: projectDir });
  const localSettings = readSettingsFile(join(projectDir, SETTINGS_LOCAL_FILE), { ...deps, cwd: projectDir });
  const { bypassPermissionsPresent, unsafeModePresent } = resolveEffectiveMode(projectSettings.data, localSettings.data);
  if (bypassPermissionsPresent) {
    throw makeGateHookError(GATE_HOOK_UNSAFE_MODE, `${UNSAFE_BYPASS_MODE} appears in Claude settings - refusing to wire a hook beside it`);
  }
  if (unsafeModePresent) {
    throw makeGateHookError(
      GATE_HOOK_UNSAFE_MODE,
      `an unsafe or unknown permissions.defaultMode is present in Claude settings - accepted modes: ${SAFE_DEFAULT_MODES.join(', ')}`,
    );
  }
  assertHooksShape(projectSettings.data, SETTINGS_FILE, STOP_EVENT);
  return {
    projectDir,
    bundleContent,
    stamp,
    stampOk: stamp === EXPECTED_WORKFLOW_VERSION,
    placement: PLACEMENT_OF[target.action],
    projectSettings,
    localSettings,
    wiredInProject: isStopHookWired(projectSettings.data),
    wiredInLocal: isStopHookWired(localSettings.data),
    mergeCase: mergeCaseOf(projectSettings.data),
  };
};

export const writeStateBlockHook = ({ cwd, dryRun = true } = {}, deps = {}) => {
  const fs = fsDeps(deps);
  const plan = preflight(resolve(cwd ?? deps.cwd ?? process.cwd()), deps);
  const placePlanned = plan.placement !== PLACEMENT_KEEP;
  const mergePlanned = !plan.wiredInProject && !plan.wiredInLocal;
  const base = { placePlanned, mergePlanned, ...plan };
  if (dryRun) return { wrote: false, dryRun: true, ...base };

  if (!plan.stampOk) {
    throw makeGateHookError(
      GATE_HOOK_STAMP,
      `not a deployed agent-workflow project at lineage ${EXPECTED_WORKFLOW_VERSION} (found ${plan.stamp ?? 'none'}) — run init/upgrade first`,
    );
  }
  // Place FIRST, then wire — a wired-but-missing hook would error on every turn end.
  const hookAbs = join(plan.projectDir, STATE_BLOCK_HOOK_FILE_REL);
  if (plan.placement === PLACEMENT_CREATE) fs.mkdir(join(plan.projectDir, HOOKS_DIR), { recursive: true });
  if (placePlanned) writeHookFile(hookAbs, STATE_BLOCK_HOOK_FILE_REL, plan.bundleContent, plan.placement === PLACEMENT_CREATE, fs);
  if (mergePlanned) {
    // Re-judge the placed file no-follow immediately BEFORE wiring: a runtime swapped, or turned
    // into a link, between the placement and now must never be wired — zero settings mutation.
    const placed = planTarget(hookAbs, STATE_BLOCK_HOOK_FILE_REL, plan.bundleContent, fs);
    if (placed.action !== 'already-current') {
      throw makeGateHookError(
        GATE_HOOK_DIVERGED,
        `${STATE_BLOCK_HOOK_FILE_REL} changed after placement — refusing to wire an unknown script as a ${STOP_EVENT} hook (no settings change made); re-run`,
      );
    }
    fs.writeFile(
      join(plan.projectDir, SETTINGS_FILE),
      formatJson(mergeStopEntry(plan.projectSettings.data ?? {}), plan.projectSettings.eol ?? LF),
      UTF8,
    );
  }
  return { wrote: placePlanned || mergePlanned, dryRun: false, ...base };
};

// ── report ────────────────────────────────────────────────────────────────────────────

const STATE_BLOCK_CURRENT_LINE = 'nothing to change: the state-block hook is placed, current and wired';

const TRUST_POSTURE_LINE =
  'trust posture: the guard reads the closing assistant message of each turn and writes one warning line; it runs a Node process on every turn end, reads nothing else, makes no network call and approves nothing.';

const PLACEMENT_LINES = Object.freeze({ [PLACEMENT_CREATE]: ['would place', 'placed'], [PLACEMENT_KEEP]: ['already current', 'already current'] });
const placementLine = ({ placement, dryRun }) => (placement === PLACEMENT_REPLACE
  ? fileLine({ rel: STATE_BLOCK_HOOK_FILE_REL, state: 'hook' }, dryRun ? undefined : 'written', dryRun)
  : `${STATE_BLOCK_HOOK_FILE_REL}: ${PLACEMENT_LINES[placement][dryRun ? 0 : 1]}`);

const MERGE_LINES = Object.freeze({
  [MERGE_NO_HOOKS]: 'the hooks key with the Stop entry',
  [MERGE_NO_STOP]: 'the Stop key beside the existing hooks',
  [MERGE_APPEND]: 'one element to the existing hooks.Stop array',
});

const formatSettingsLine = (result) => {
  if (result.wiredInProject) return `  - ${SETTINGS_FILE}: already wired`;
  if (result.wiredInLocal) return `  - ${SETTINGS_FILE}: already wired via ${SETTINGS_LOCAL_FILE} — not duplicated`;
  return `  - ${SETTINGS_FILE}: ${result.dryRun ? 'would add' : 'added'} ${MERGE_LINES[result.mergeCase]}`;
};

export const formatResult = (result) => {
  if (!result.placePlanned && !result.mergePlanned) return STATE_BLOCK_CURRENT_LINE;
  const lines = [
    result.dryRun
      ? 'agent-workflow state-block hook — DRY RUN (no changes; re-run with --apply)'
      : 'agent-workflow state-block hook — APPLY',
    `  - ${placementLine(result)}`,
    formatSettingsLine(result),
    `  command: ${STATE_BLOCK_HOOK_COMMAND} (no --require-block; references/modes/state-block-guard.md says when to add it)`,
    TRUST_POSTURE_LINE,
  ];
  if (!result.stampOk) {
    lines.push(`note: no current deployment stamp found (${result.stamp ?? 'none'}) — --apply will refuse until init/upgrade runs.`);
  }
  if (!result.dryRun && result.mergePlanned) {
    lines.push('settings hot-reload: the Stop hook runs from the next turn end — no session restart needed.');
  }
  return lines.join(LF);
};

// ── CLI ───────────────────────────────────────────────────────────────────────────────

export const parseArgs = (argv) => {
  const opts = { apply: false, cwd: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '--cwd') {
      i += 1;
      if (argv[i] === undefined || argv[i].startsWith('-')) throw usageError('--cwd needs a directory argument');
      opts.cwd = argv[i];
    } else {
      throw usageError(`unknown argument: ${arg}`);
    }
  }
  return { help: opts.help, dryRun: !opts.apply, cwd: opts.cwd };
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
    log(formatResult(writeStateBlockHook({ cwd: args.cwd ?? deps.cwd ?? process.cwd(), dryRun: args.dryRun }, deps)));
    return EXIT_OK;
  } catch (err) {
    errlog(err?.message ?? String(err));
    if (err?.exitCode === EXIT_USAGE) errlog(USAGE);
    return err?.exitCode ?? EXIT_PRECONDITION;
  }
};

if (isDirectRun(import.meta.url)) process.exitCode = main(process.argv.slice(2));
