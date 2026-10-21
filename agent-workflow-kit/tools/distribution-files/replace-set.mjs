// replace-set.mjs — the ONE replace block an upgrade prints over every file whose write waits for the
// user's yes, and the replace run that yes starts. An op that owns such writes reports entries on its
// outcome: { rel, sha256, bytes, channel } for an edited file, { rel, absent: true, channel } for an
// absent one. This module binds their union into one digest, prints one block over it, and on the yes
// keeps every edit aside (kept-aside.mjs) before any owning op replaces a byte. It never imports
// ensure-configs.mjs: the CLI hands it the ops it runs.
//
// Dependency-free, Node >= 22. No side effects on import.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { composeFailure } from '../ensure-ops.mjs';
import { shellQuoteArg } from '../repo-lex.mjs';
import { keepAside, keptAsidePath } from './kept-aside.mjs';

export { keptAsidePath };

const INDEX_NOT_RUN = 'the navigator step did not run: a replace run runs it only after the spec layer succeeds';
const RACE_LINE = 'the files to replace changed since the replace line was printed (another set or other bytes), so nothing was written — ask the user again over the fresh block below';

// The digest binds the set AND the bytes: `<rel> <sha256>` or `<rel> absent`, sorted by rel in
// code-unit order, LF-joined. Over an all-edited set it is the digest the specs op printed before.
const byRel = (a, b) => (a.rel < b.rel ? -1 : 1);
const digestLine = (entry) => `${entry.rel} ${entry.absent ? 'absent' : entry.sha256}`;
export const replaceSetDigest = (entries) => createHash('sha256').update([...entries].sort(byRel).map(digestLine).join('\n')).digest('hex');

const entryLine = (entry, digest) => (entry.absent
  ? `${entry.rel}: absent — the user's yes places the bundled body`
  : `${entry.rel}: carries an edit — on the user's yes it is kept aside at ${keptAsidePath(digest, entry.rel)}, then the bundled body replaces it; an edit meant to last goes in ${entry.channel}`);

// One line per entry in rel order, then the ONE command line, its condition first and both paths
// shell-quoted; no line at all for an empty set.
export const replaceBlock = (entries, { kitRoot, cwd }) => {
  if (entries.length === 0) return [];
  const digest = replaceSetDigest(entries);
  return [
    ...[...entries].sort(byRel).map((entry) => entryLine(entry, digest)),
    `only on the user's yes, keep aside and replace the files named above: node ${shellQuoteArg(join(kitRoot, 'tools', 'ensure-configs.mjs'))} --reconcile --replace-custom ${digest} --cwd ${shellQuoteArg(cwd)}`,
  ];
};

// runReplace({ cwd, kitRoot, digest, owning, index, deps }) → { outcomes, block }. `owning` is
// [{ op, run }] in ENSURE_OPS order and `index` the navigator's run; each run(args) returns an
// outcome and never throws (the CLI wraps it). `block` carries the recomputed union only when the
// digest differs — every other outcome of a replace run prints no block.
export const runReplace = ({ cwd, kitRoot, digest, owning, index, deps = {} }) => {
  const notRun = (outcome) => ({ ...outcome, lines: [...outcome.lines, INDEX_NOT_RUN] });
  const surveys = [];
  for (const { op, run } of owning) {
    const survey = run({ cwd, kitRoot, dryRun: true, deps });
    if (survey.failed) return { outcomes: [notRun(survey)], block: [] };
    surveys.push({ run, entries: survey.entries ?? [] });
  }
  const union = surveys.flatMap((survey) => survey.entries);
  const first = owning[0].op;
  if (union.length > 0 && replaceSetDigest(union) !== digest) {
    return { outcomes: [notRun(composeFailure(first, 'race-unresolved', RACE_LINE))], block: union };
  }
  const kept = keepAside({ cwd, digest, entries: union, deps });
  if (kept.failed) return { outcomes: [notRun(composeFailure(first, kept.cause, ...kept.lines))], block: [] };
  const outcomes = [];
  for (const survey of surveys) {
    const replace = union.length > 0 ? { digest, entries: survey.entries } : undefined;
    const outcome = survey.run({ cwd, kitRoot, dryRun: false, deps, replace });
    if (outcome.failed) return { outcomes: [...outcomes, notRun(outcome)], block: [] };
    outcomes.push(outcome);
  }
  return { outcomes: [...outcomes, index({ cwd, kitRoot, dryRun: false, deps })], block: [] };
};
