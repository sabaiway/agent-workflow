// replace-set.mjs — the ONE replace block an upgrade prints over every file whose write waits for the
// user's yes, and the replace run that yes starts. An owning op reports entries on its outcome: { rel,
// sha256, bytes, channel } for an edited file, { rel, absent: true, channel } for an absent one, either
// marked `hookRun: true` when the commit hook runs it. One digest binds their union, one block prints
// over it, and the yes keeps every edit aside (kept-aside.mjs) before any op replaces a byte. It never
// imports ensure-configs.mjs: the CLI hands it the ops it runs.
//
// Dependency-free, Node >= 22. No side effects on import.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { composeFailure } from '../ensure-ops.mjs';
import { shellQuoteArg } from '../repo-lex.mjs';
import { keepAside, keptAsidePath } from './kept-aside.mjs';

export { keptAsidePath };

const INDEX_NOT_RUN = 'the navigator step did not run: a replace run runs it only after every step it re-runs succeeds';
const RACE_LINE = 'the files to replace changed since the replace line was printed (another set or other bytes), so nothing was written — ask the user again over the fresh block below';
const HOOK_RUN = '; the commit hook runs it, so it may stop the next commit';

// The digest binds the set AND the bytes: `<rel> <sha256>` or `<rel> absent`, sorted by rel in
// code-unit order, LF-joined. Over an all-edited set it is the digest the specs op printed before.
const byRel = (a, b) => (a.rel < b.rel ? -1 : 1);
const digestLine = (entry) => `${entry.rel} ${entry.absent ? 'absent' : entry.sha256}`;
export const replaceSetDigest = (entries) => createHash('sha256').update([...entries].sort(byRel).map(digestLine).join('\n')).digest('hex');

const entryLine = (entry, digest) => `${entry.absent
  ? `${entry.rel}: absent — the user's yes places the bundled body`
  : `${entry.rel}: carries an edit — on the user's yes it is kept aside at ${keptAsidePath(digest, entry.rel)}, then the bundled body replaces it; an edit meant to last goes in ${entry.channel}`}${entry.hookRun ? HOOK_RUN : ''}`;

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

// A refused survey is a failed outcome that carries no entries field: that op takes no part.
const refused = (outcome) => outcome.failed && outcome.entries === undefined;

// runReplace({ cwd, kitRoot, digest, owning, index, deps }) → { outcomes, block }. `owning` is
// [{ op, run }] in ENSURE_OPS order and `index` the navigator's run; each run(args) returns an
// outcome and never throws (the CLI wraps it). `block` carries the recomputed union only when the
// digest differs — every other outcome of a replace run prints no block.
export const runReplace = ({ cwd, kitRoot, digest, owning, index, deps = {} }) => {
  const surveys = owning.map(({ op, run }) => ({ op, run, survey: run({ cwd, kitRoot, dryRun: true, deps }) })).map((s) => ({ ...s, entries: s.survey.entries ?? [] }));
  // Outcomes in owning order; index only when none failed, else the last failed one ends with the navigator line.
  const finish = (results, block = []) => {
    const outcomes = results.filter(Boolean);
    const last = outcomes.findLastIndex((o) => o.failed);
    if (last === -1) return { outcomes: [...outcomes, index({ cwd, kitRoot, dryRun: false, deps })], block };
    return { outcomes: outcomes.map((o, i) => (i === last ? { ...o, lines: [...o.lines, INDEX_NOT_RUN] } : o)), block };
  };
  const results = surveys.map((s) => (refused(s.survey) ? s.survey : null));
  const stopped = surveys.findIndex((s) => s.survey.failed && !refused(s.survey));
  if (stopped !== -1) return finish(results.map((o, i) => (i === stopped ? surveys[i].survey : o)));
  const taking = surveys.filter((s) => !refused(s.survey));
  if (taking.length === 0) return finish(results);
  const union = taking.flatMap((s) => s.entries);
  const atFirst = (outcome) => results.map((o, i) => (surveys[i] === taking[0] ? outcome : o));
  if (union.length > 0 && replaceSetDigest(union) !== digest) return finish(atFirst(composeFailure(taking[0].op, 'race-unresolved', RACE_LINE)), union);
  const kept = keepAside({ cwd, digest, entries: union, deps });
  if (kept.failed) return finish(atFirst(composeFailure(taking[0].op, kept.cause, ...kept.lines)));
  for (const [i, s] of surveys.entries()) {
    if (refused(s.survey)) continue;
    results[i] = s.run({ cwd, kitRoot, dryRun: false, deps, replace: { digest, entries: s.entries } });
    if (results[i].failed) break;
  }
  return finish(results);
};
