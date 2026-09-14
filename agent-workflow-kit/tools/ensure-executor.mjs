// ensure-executor.mjs — the EIGHTH upgrade ensure, fifth in the fixed order right after `vehicles`:
// the placed executor vehicle (.claude/agents/executor.md) re-derived from docs/ai/vehicles.json.
// The agents writer PLACES the vehicle on consent; this ensure never does — it only keeps a placed
// body equal to the one derived from the settings, and a hand edit is replaced, never preserved.
//
// The state table, in the order the cells are proven (the write is the LAST step):
// | cell | .claude, .claude/agents | placed path | docs/ai/vehicles.json | answer | read before answering |
// |------|-------------------------|-------------|-----------------------|--------|-----------------------|
// | 0 | a symlink or not a directory | any | any | failed / wrong-node-kind | nothing |
// | 1 | absent or directories | a symlink, a directory, another non-regular node | any | failed / wrong-node-kind | nothing |
// | 2 | absent or directories | no entry | any, malformed included | not-placed | nothing |
// | 3 | directories | regular file | unreadable (malformed, read or lstat error) | failed / vehicle-settings-unreadable | the settings only |
// | 4 | directories | regular file | present or absent | failed / bundle-unreadable when the bundled template cannot be read | settings, bundle |
// | 5 | directories | regular file, bytes equal to the derived body | present or absent | already-current | settings, bundle, placed file |
// | 6 | directories | regular file, bytes differ | present or absent | dry-run would-re-derive; apply re-derived, or failed / write-refused | settings, bundle, placed file |
// | 7 | an lstat of `.claude`, `.claude/agents` or the placed path throwing other than ENOENT, or the read of the placed file throwing | | | NOT caught: the error propagates to the CLI's catch-all (`unexpected-error`) | |
//
// Dependency-free, Node >= 22. Every fs primitive is injectable (deps.*). No side effects on import.

import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { writeContainedFileAtomic } from './atomic-write.mjs';
import { composeFailure, composeOutcome, probeSeedTarget, tmpNote } from './ensure-ops.mjs';
import { assertDirSafe, AGENTS_DIR, CLAUDE_DIR, CHEAP_AGENTS_SYMLINK, EXECUTOR_VEHICLE_REL, executorTemplate, readExecutorPosture } from './cheap-agents-read.mjs';
import { VEHICLES_REL } from './vehicle-settings.mjs';

export const EXECUTOR_OP = 'executor';

const BUNDLE_DIR = ['references', 'agents'];
const ENCODING = 'utf8';

const ok = (token, lines) => composeOutcome(EXECUTOR_OP, token, lines, false);
const loud = (cause, ...lines) => composeFailure(EXECUTOR_OP, cause, ...lines);
const causeOf = (err) => String((err && err.message) || err);

export const ensureExecutor = ({ cwd, kitRoot, dryRun = false, deps = {} }) => {
  const lstat = deps.lstat ?? lstatSync;
  const read = deps.readFile ?? readFileSync;

  try {
    assertDirSafe(join(cwd, CLAUDE_DIR), CLAUDE_DIR, { lstat });
    assertDirSafe(join(cwd, AGENTS_DIR), AGENTS_DIR, { lstat });
  } catch (err) {
    if (err?.code !== CHEAP_AGENTS_SYMLINK) throw err;
    return loud('wrong-node-kind', causeOf(err));
  }

  const target = join(cwd, EXECUTOR_VEHICLE_REL);
  const probe = probeSeedTarget(target, lstat);
  if (probe.wrongKind) {
    return loud('wrong-node-kind', `${EXECUTOR_VEHICLE_REL}: exists but is ${probe.wrongKind} — nothing was read or written; resolve it by hand, then re-run`);
  }
  if (!probe.present) {
    return ok('not-placed', [`${EXECUTOR_VEHICLE_REL}: not placed — the agents mode places it on consent; nothing written`]);
  }

  const { posture, reason } = readExecutorPosture(cwd, deps);
  if (posture === null) {
    return loud('vehicle-settings-unreadable', `${EXECUTOR_VEHICLE_REL}: ${reason} — nothing written; fix ${VEHICLES_REL} by hand, then re-run`);
  }

  let body;
  try {
    body = executorTemplate(posture, { ...deps, bundleDir: join(kitRoot, ...BUNDLE_DIR) }).content;
  } catch (err) {
    return loud('bundle-unreadable', `${EXECUTOR_VEHICLE_REL}: the bundled executor template could not be read, so nothing was written — reinstall the kit. ${causeOf(err)}`);
  }

  const existing = read(target, ENCODING);
  if (existing === body) {
    return ok('already-current', [`${EXECUTOR_VEHICLE_REL}: the body derived from ${VEHICLES_REL} (model=${posture.model}, effort=${posture.effort}, source ${posture.source}) — nothing written`]);
  }
  if (dryRun) {
    return ok('would-re-derive', [`${EXECUTOR_VEHICLE_REL}: differs from the body derived from ${VEHICLES_REL} — would be rewritten (a hand edit is replaced, never preserved)`]);
  }

  let result;
  try {
    result = writeContainedFileAtomic(cwd, target, body, deps, { label: EXECUTOR_VEHICLE_REL });
  } catch (err) {
    return loud('write-refused', `${EXECUTOR_VEHICLE_REL}: ${causeOf(err)}`);
  }
  return ok('re-derived', [
    `${EXECUTOR_VEHICLE_REL}: rewritten to the body derived from ${VEHICLES_REL} (model=${posture.model}, effort=${posture.effort}) — a hand edit was replaced; set the model in ${VEHICLES_REL}`,
    ...tmpNote(EXECUTOR_VEHICLE_REL, result.tmpLeftBehind),
  ]);
};
