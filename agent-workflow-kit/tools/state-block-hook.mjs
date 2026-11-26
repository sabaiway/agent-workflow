#!/usr/bin/env node
// state-block-hook.mjs — the writer behind the `state-block` advisor item: places the bundled
// closing-state-block detector (references/hooks/state-block-guard.mjs) to the project's
// .claude/hooks/state-block-guard.mjs and merges ONE `Stop` entry into .claude/settings.json by the
// three cases of references/modes/state-block-guard.md: no `hooks` key, a `hooks` key without
// `Stop`, and a `hooks.Stop` array, which gains one element.
//
// The place-then-wire flow runs on the kit's hook writer (hook-writer/index.mjs), which imports the
// hardened checks, the hook-file write and the unsafe-mode and stamp refusals from gate-hook.mjs,
// with its error codes. What is the Stop hook's own:
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

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STOP_HOOK } from '../references/scripts/shared/index.mjs';
import { SETTINGS_FILE, SETTINGS_LOCAL_FILE } from './velocity-profile.mjs';
import { formatKitHookResult, mergeHookEntryInto, writeKitHook } from './hook-writer/index.mjs';
import { isDirectRun } from './direct-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const STATE_BLOCK_HOOK_RUNTIME = 'state-block-guard.mjs';
export const STATE_BLOCK_HOOK_FILE_REL = STOP_HOOK;
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

const MERGE_NO_HOOKS = 'no-hooks';
const MERGE_NO_EVENT = 'no-event';
const MERGE_NO_STOP = 'no-stop';
const MERGE_APPEND = 'append';
const STOP_CASE_OF = Object.freeze({ [MERGE_NO_EVENT]: MERGE_NO_STOP });
const KIT_CASE_OF = Object.freeze({ [MERGE_NO_STOP]: MERGE_NO_EVENT });

const USAGE = `usage: state-block-hook [--apply] [--cwd <dir>] [--help]

Places the bundled closing-state-block detector to ${STATE_BLOCK_HOOK_FILE_REL} (created when
absent, kept when byte-equal, replaced when it differs) and merges ONE ${STOP_EVENT} entry running
${STATE_BLOCK_HOOK_COMMAND} into ${SETTINGS_FILE}, by the three cases of
references/modes/state-block-guard.md. Default is a preview that writes nothing; --apply writes.
The entry is merged only while no ${STOP_EVENT} entry of either settings file runs the runtime.

Never writes ${SETTINGS_LOCAL_FILE}; never commits.`;

const usageError = (message) => Object.assign(new Error(message), { exitCode: EXIT_USAGE });

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

// Append our ONE entry; every foreign hook, matcher and key is carried over untouched. Only called
// when the entry is absent (idempotence lives in the caller's plan, not in dedup-on-write).
export const mergeStopEntry = (base) => mergeHookEntryInto(base, STOP_EVENT, buildStopHookEntry());

// ── the writer and its report ─────────────────────────────────────────────────────────

const TRUST_POSTURE_LINE =
  'trust posture: the guard reads the closing assistant message of each turn and writes one warning line; it runs a Node process on every turn end, reads nothing else, makes no network call and approves nothing.';

const STATE_BLOCK_HOOK = Object.freeze({
  fileRel: STATE_BLOCK_HOOK_FILE_REL,
  bundlePath: BUNDLED_STATE_BLOCK_HOOK_PATH,
  event: STOP_EVENT,
  entry: buildStopHookEntry(),
  isWired: isStopHookWired,
  refusesUnsafeModes: true,
  lines: Object.freeze({
    title: 'state-block hook',
    commandNote: `command: ${STATE_BLOCK_HOOK_COMMAND} (no --require-block; references/modes/state-block-guard.md says when to add it)`,
    reload: 'the Stop hook runs from the next turn end',
    merge: Object.freeze({
      [MERGE_NO_HOOKS]: 'the hooks key with the Stop entry',
      [MERGE_NO_EVENT]: 'the Stop key beside the existing hooks',
      [MERGE_APPEND]: 'one element to the existing hooks.Stop array',
    }),
    bypassReason: 'refusing to wire a hook beside it',
    trustPosture: TRUST_POSTURE_LINE,
    nothingToChange: 'nothing to change: the state-block hook is placed, current and wired',
  }),
});

const withMergeCase = (result, caseOf) => ({ ...result, mergeCase: caseOf[result.mergeCase] ?? result.mergeCase });

export const writeStateBlockHook = ({ cwd, dryRun = true } = {}, deps = {}) =>
  withMergeCase(writeKitHook(STATE_BLOCK_HOOK, { cwd: cwd ?? deps.cwd ?? process.cwd(), dryRun }, deps), STOP_CASE_OF);

export const formatResult = (result) => formatKitHookResult(STATE_BLOCK_HOOK, withMergeCase(result, KIT_CASE_OF));

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
