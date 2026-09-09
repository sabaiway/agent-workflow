import { spawnSync } from 'node:child_process';
import { join, posix } from 'node:path';
import { computeWorkingState, coverageQualifierFor, describeMissingReviewAttestation } from './core-evidence.mjs';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';
import { GIT_MAX_BUFFER, stripGitLocationEnv, withGitPath } from './git-env.mjs';
import { PLANS_REL, plansInFlight } from './plan-files.mjs';
import { isSweep, parseLedger, unique } from './plan-shape.mjs';
import { buildFacts, expandPatterns } from './plan-shape-facts.mjs';

const VERIFICATION = '## Verification';
const NUL = String.fromCharCode(0);
const STAGED_ARGV = Object.freeze(['diff', '--cached', '--name-only', '-z', '--no-renames']);
const IGNORE_ARGV = Object.freeze(['check-ignore', '-z', '--stdin']);

const detailOf = (result) => {
  const stderr = String(result.stderr ?? '').trim();
  return stderr ? ` (${stderr})` : '';
};

// Every spawn outcome is named — an error, a signal, an unaccepted status, a throw — never an empty success read as "nothing is staged".
export const readGitPaths = (argv, { cwd, env, spawn = spawnSync, input, accept = [0] }) => {
  const label = `git ${argv[0]}`;
  const runEnv = withGitPath({ ...stripGitLocationEnv(env), LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' });
  const result = (() => {
    try {
      return spawn('git', argv, { cwd, env: runEnv, input, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
    } catch (error) {
      throw new Error(`${label} threw synchronously (${error?.message ?? error})`);
    }
  })();
  if (result === null || typeof result !== 'object') throw new Error(`${label} returned no result`);
  if (result.error) throw new Error(`${label} could not run (${result.error.code ?? result.error.message ?? result.error})`);
  if (result.signal) throw new Error(`${label} was killed by ${result.signal}`);
  if (!accept.includes(result.status)) throw new Error(`${label} exited ${result.status}${detailOf(result)}`);
  return String(result.stdout ?? '').split(NUL).filter(Boolean);
};

const refused = (path, parseError) => ({ path, parsed: null, parseError, rows: [] });

const readPlanEntry = (cwd, name) => {
  const path = `${PLANS_REL}/${name}`;
  const read = readRegularFileNoFollow(join(cwd, PLANS_REL, name));
  if (read.outcome !== 'ok') return refused(path, `${path} is not a readable regular file (${read.className ?? read.code ?? read.outcome})`);
  try {
    const parsed = parseLedger(read.content);
    const verification = parsed.document.headings.find(({ text }) => text === VERIFICATION);
    return verification
      ? { path, parsed, parseError: null, rows: [] }
      : refused(path, `${path} carries no "${VERIFICATION}" heading, so its ledger cannot be located`);
  } catch (error) {
    return refused(path, `${path} cannot be parsed (${error?.message ?? error})`);
  }
};

const describeCurrency = ({ state, detail }) => detail ? `${state} (${detail})` : state;
const toVerdict = ({ backend, summary }) => {
  const missing = describeMissingReviewAttestation(summary);
  return { backend, line: `${backend}: ${missing ?? `${summary.receipt.verdict} (attesting, ${summary.receipt.timestamp})`}` };
};

const describeFinalRun = (record) => {
  if (!record) return null;
  const qualifier = coverageQualifierFor(record);
  return {
    status: String(record.status).toUpperCase(),
    gates: Array.isArray(record.results) ? `${record.results.filter(({ ok }) => ok === true).length}/${record.results.length}` : 'unknown',
    fingerprintBefore: record.fingerprintBefore,
    timestamp: record.timestamp,
    coverage: qualifier ? qualifier.replace(/^ \u2014 /, '') : `coverage=${record.coverage ?? 'unknown'}`,
  };
};

// The summary's review half, mapped ONCE: the tree block and the per-row red-proof annotation read the same records.
export const readSummaryFacts = (summary) => ({
  redProofs: summary.redProofs.map((record) => ({ path: record.file, currency: describeCurrency(record.currency) })),
  receipts: { path: summary.receiptsPath, verdicts: summary.verdicts.map(toVerdict), finalRun: describeFinalRun(summary.finalRun) },
});

// A sweep row is judged as a SET: presence from the expansion on disk, each changed-set flag from the glob over that FULL git set (a deleted member still counts), exclusion only when every member is excluded.
// git names a path in one spelling; a ledger may write `./src/a.mjs` or `src//a.mjs`, so every lookup uses the canonical form.
const canonical = (path) => posix.normalize(path).replace(/\/$/, '');
const matchesAny = (pattern, paths) => expandPatterns(paths, [pattern])[pattern].length > 0;
const sweepEvidenceFor = (pattern, expansions, sets) => {
  const members = expansions[pattern] ?? [];
  return {
    pathFact: members.length > 0 ? { kind: 'sweep', members: members.length } : { kind: 'absent' },
    staged: matchesAny(pattern, sets.staged),
    unstaged: matchesAny(pattern, sets.unstaged),
    untracked: matchesAny(pattern, sets.untracked),
    excluded: members.length > 0 && members.every((member) => sets.excluded.includes(member)),
  };
};
// `path` is the canonical form every reader of the row's evidence keys on; a row the ledger grammar refused carries none.
const hasPath = (row) => typeof row.path === 'string' && row.path.length > 0;
const evidenceFor = (row, pathFacts, expansions, sets) => {
  if (!hasPath(row)) return { path: null, pathFact: null, staged: false, unstaged: false, untracked: false, excluded: false };
  const path = canonical(row.path);
  if (isSweep(path)) return { path, ...sweepEvidenceFor(path, expansions, sets) };
  return {
    path,
    pathFact: pathFacts[path] ?? null,
    staged: sets.staged.includes(path),
    unstaged: sets.unstaged.includes(path),
    untracked: sets.untracked.includes(path),
    excluded: sets.excluded.includes(path),
  };
};

export const gatherPlanFacts = ({ cwd, env = process.env, deps = {} }) => {
  const entries = plansInFlight(cwd, deps.readdir).map((name) => readPlanEntry(cwd, name));
  const ledgerPaths = unique(entries.flatMap(({ parsed }) => (parsed ? parsed.rows : []))
    .filter(hasPath)
    .map(({ path }) => canonical(path)));
  const { pathFacts, expansions } = buildFacts(cwd, { paths: ledgerPaths });
  const concretePaths = unique([...ledgerPaths.filter((path) => !isSweep(path)), ...Object.values(expansions).flat()]);
  const working = computeWorkingState(cwd, { env });
  if (working === null) throw new Error(`the working state of ${cwd} is not decidable`);
  const staged = readGitPaths(STAGED_ARGV, { cwd, env, spawn: deps.spawn });
  const excluded = concretePaths.length === 0
    ? []
    : readGitPaths(IGNORE_ARGV, { cwd, env, spawn: deps.spawn, accept: [0, 1], input: `${concretePaths.join(NUL)}${NUL}` });
  const changed = { staged, unstaged: working.unstagedPaths, untracked: working.untrackedPaths };
  const sets = { staged, unstaged: changed.unstaged, untracked: changed.untracked, excluded };
  const plans = entries.map((entry) => ({
    ...entry,
    rows: (entry.parsed?.rows ?? []).map((row) => ({ row, raw: row.raw, evidence: evidenceFor(row, pathFacts, expansions, sets) })),
  }));
  return { plans, pathFacts, changed, excluded };
};
