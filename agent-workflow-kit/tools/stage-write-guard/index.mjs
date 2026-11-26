// stage-write-guard/index.mjs — docs/ai/specs/kit/stage-write-guard.md

import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGE_GUARD_HOOK } from '../../references/scripts/shared/index.mjs';
import { formatKitHookResult, writeKitHook } from '../hook-writer/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_STAGE_GUARD_PATH = resolve(HERE, '..', '..', 'references', 'hooks', basename(STAGE_GUARD_HOOK));
const PRE_TOOL_USE_EVENT = 'PreToolUse';
const COMMAND_HOOK_TYPE = 'command';

export const STAGE_GUARD_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit';
export const STAGE_GUARD_HOOK_COMMAND = `node "$CLAUDE_PROJECT_DIR/${STAGE_GUARD_HOOK}"`;

export const buildStageGuardEntry = () => ({
  matcher: STAGE_GUARD_MATCHER,
  hooks: [{ type: COMMAND_HOOK_TYPE, command: STAGE_GUARD_HOOK_COMMAND }],
});

const isJsonObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const runsStageGuard = (hook) => isJsonObject(hook) && hook.type === COMMAND_HOOK_TYPE && hook.command === STAGE_GUARD_HOOK_COMMAND;

export const isStageGuardWired = (data) => {
  const entries = isJsonObject(data) && isJsonObject(data.hooks) ? data.hooks[PRE_TOOL_USE_EVENT] : undefined;
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => isJsonObject(entry)
    && entry.matcher === STAGE_GUARD_MATCHER
    && Array.isArray(entry.hooks)
    && entry.hooks.some(runsStageGuard));
};

const STAGE_GUARD = Object.freeze({
  fileRel: STAGE_GUARD_HOOK,
  bundlePath: BUNDLED_STAGE_GUARD_PATH,
  event: PRE_TOOL_USE_EVENT,
  entry: Object.freeze(buildStageGuardEntry()),
  isWired: isStageGuardWired,
  refusesUnsafeModes: false,
  lines: Object.freeze({
    title: 'stage guard hook',
    reload: 'the guard runs from the next file write',
    merge: Object.freeze({
      'no-hooks': `the hooks key with the ${PRE_TOOL_USE_EVENT} entry`,
      'no-event': `the ${PRE_TOOL_USE_EVENT} key beside the existing hooks`,
      append: `one element to the existing hooks.${PRE_TOOL_USE_EVENT} array`,
    }),
    trustPosture: 'trust posture: the guard reads the stage record and the orchestration config on each file write of the edit tools and prints one deny or nothing; it makes no network call, writes nothing and approves nothing.',
    nothingToChange: 'nothing to change: the stage guard hook is placed, current and wired',
  }),
});

export const writeStageGuard = ({ cwd, dryRun = true } = {}, deps = {}) => {
  const result = writeKitHook(STAGE_GUARD, { cwd, dryRun }, deps);
  return { ...result, report: formatKitHookResult(STAGE_GUARD, result) };
};
