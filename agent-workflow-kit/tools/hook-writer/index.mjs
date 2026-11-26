// hook-writer/index.mjs — docs/ai/specs/kit/hook-writer.md

import { join, resolve } from 'node:path';
import {
  CLAUDE_DIR,
  EXPECTED_WORKFLOW_VERSION,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  WORKFLOW_STAMP,
  readSettingsFile,
} from '../velocity-profile.mjs';
import {
  GATE_HOOK_DIVERGED,
  HOOKS_DIR,
  assertDirSafe,
  assertHooksShape,
  assertSafeModes,
  assertSettingsWritable,
  assertStampCurrent,
  formatJson,
  fsDeps,
  makeGateHookError,
  planTarget,
  readBundledHook,
  readStamp,
  writeHookFile,
} from '../gate-hook.mjs';
import { fileLine } from '../distribution-files/index.mjs';

const UTF8 = 'utf8';
const LF = '\n';

const PLACEMENT_CREATE = 'create';
const PLACEMENT_KEEP = 'keep';
const PLACEMENT_REPLACE = 'replace';
const PLACEMENT_OF = Object.freeze({ place: PLACEMENT_CREATE, 'already-current': PLACEMENT_KEEP, diverged: PLACEMENT_REPLACE });
const TARGET_CURRENT = 'already-current';

const MERGE_NO_HOOKS = 'no-hooks';
const MERGE_NO_EVENT = 'no-event';
const MERGE_APPEND = 'append';

const PLACEMENT_LINES = Object.freeze({ [PLACEMENT_CREATE]: ['would place', 'placed'], [PLACEMENT_KEEP]: ['already current', 'already current'] });
const HEADER_DRY_RUN = 'DRY RUN (no changes; re-run with --apply)';
const HEADER_APPLY = 'APPLY';
const FILE_STATE_HOOK = 'hook';
const FILE_WRITTEN = 'written';

const isJsonObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const mergeCaseOf = (data, event) => {
  if (!isJsonObject(data) || data.hooks === undefined) return MERGE_NO_HOOKS;
  return data.hooks[event] === undefined ? MERGE_NO_EVENT : MERGE_APPEND;
};

export const mergeHookEntryInto = (base, event, entry) => {
  const root = isJsonObject(base) ? base : {};
  const hooks = isJsonObject(root.hooks) ? root.hooks : {};
  const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
  return { ...root, hooks: { ...hooks, [event]: [...entries, entry] } };
};

const preflight = (hook, projectDir, deps) => {
  const fs = fsDeps(deps);
  const bundleContent = readBundledHook({ ...deps, bundlePath: deps.bundlePath ?? hook.bundlePath });
  const stamp = readStamp(join(projectDir, WORKFLOW_STAMP), fs);
  assertDirSafe(join(projectDir, CLAUDE_DIR), CLAUDE_DIR, fs);
  assertDirSafe(join(projectDir, HOOKS_DIR), HOOKS_DIR, fs);
  const target = planTarget(join(projectDir, hook.fileRel), hook.fileRel, bundleContent, fs);
  assertSettingsWritable(join(projectDir, SETTINGS_FILE), fs);
  const projectSettings = readSettingsFile(join(projectDir, SETTINGS_FILE), { ...deps, cwd: projectDir });
  const localSettings = readSettingsFile(join(projectDir, SETTINGS_LOCAL_FILE), { ...deps, cwd: projectDir });
  if (hook.refusesUnsafeModes) assertSafeModes(projectSettings.data, localSettings.data, hook.lines.bypassReason);
  assertHooksShape(projectSettings.data, SETTINGS_FILE, hook.event);
  return {
    projectDir,
    bundleContent,
    stamp,
    stampOk: stamp === EXPECTED_WORKFLOW_VERSION,
    placement: PLACEMENT_OF[target.action],
    projectSettings,
    localSettings,
    wiredInProject: hook.isWired(projectSettings.data),
    wiredInLocal: hook.isWired(localSettings.data),
    mergeCase: mergeCaseOf(projectSettings.data, hook.event),
  };
};

const wireEntry = (hook, plan, fs) => {
  const hookAbs = join(plan.projectDir, hook.fileRel);
  const placed = planTarget(hookAbs, hook.fileRel, plan.bundleContent, fs);
  if (placed.action !== TARGET_CURRENT) {
    throw makeGateHookError(
      GATE_HOOK_DIVERGED,
      `${hook.fileRel} changed after placement — refusing to wire an unknown script as a ${hook.event} hook (no settings change made); re-run`,
    );
  }
  fs.writeFile(
    join(plan.projectDir, SETTINGS_FILE),
    formatJson(mergeHookEntryInto(plan.projectSettings.data ?? {}, hook.event, hook.entry), plan.projectSettings.eol ?? LF),
    UTF8,
  );
};

export const writeKitHook = (hook, { cwd, dryRun = true } = {}, deps = {}) => {
  const fs = fsDeps(deps);
  const plan = preflight(hook, resolve(cwd ?? deps.cwd ?? process.cwd()), deps);
  const placePlanned = plan.placement !== PLACEMENT_KEEP;
  const mergePlanned = !plan.wiredInProject && !plan.wiredInLocal;
  const base = { placePlanned, mergePlanned, ...plan };
  if (dryRun) return { wrote: false, dryRun: true, ...base };

  assertStampCurrent(plan.stamp);
  const creates = plan.placement === PLACEMENT_CREATE;
  if (creates) fs.mkdir(join(plan.projectDir, HOOKS_DIR), { recursive: true });
  if (placePlanned) writeHookFile(join(plan.projectDir, hook.fileRel), hook.fileRel, plan.bundleContent, creates, fs);
  if (mergePlanned) wireEntry(hook, plan, fs);
  return { wrote: placePlanned || mergePlanned, dryRun: false, ...base };
};

const placementLine = (hook, { placement, dryRun }) => (placement === PLACEMENT_REPLACE
  ? fileLine({ rel: hook.fileRel, state: FILE_STATE_HOOK }, dryRun ? undefined : FILE_WRITTEN, dryRun)
  : `${hook.fileRel}: ${PLACEMENT_LINES[placement][dryRun ? 0 : 1]}`);

const settingsLine = (hook, result) => {
  if (result.wiredInProject) return `  - ${SETTINGS_FILE}: already wired`;
  if (result.wiredInLocal) return `  - ${SETTINGS_FILE}: already wired via ${SETTINGS_LOCAL_FILE} — not duplicated`;
  return `  - ${SETTINGS_FILE}: ${result.dryRun ? 'would add' : 'added'} ${hook.lines.merge[result.mergeCase]}`;
};

export const formatKitHookResult = (hook, result) => {
  if (!result.placePlanned && !result.mergePlanned) return hook.lines.nothingToChange;
  const lines = [
    `agent-workflow ${hook.lines.title} — ${result.dryRun ? HEADER_DRY_RUN : HEADER_APPLY}`,
    `  - ${placementLine(hook, result)}`,
    settingsLine(hook, result),
    ...(hook.lines.commandNote === undefined ? [] : [`  ${hook.lines.commandNote}`]),
    hook.lines.trustPosture,
  ];
  if (!result.stampOk) {
    lines.push(`note: no current deployment stamp found (${result.stamp ?? 'none'}) — --apply will refuse until init/upgrade runs.`);
  }
  if (!result.dryRun && result.mergePlanned) {
    lines.push(`settings hot-reload: ${hook.lines.reload} — no session restart needed.`);
  }
  return lines.join(LF);
};
