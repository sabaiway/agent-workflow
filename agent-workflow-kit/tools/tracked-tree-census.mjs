// tracked-tree-census.mjs — how much of a project's TRACKED tree the changed-line coverage domain
// can actually assess, in the closed vocabulary that domain already speaks. A LEAF: it imports the
// classification and nothing else, and it spawns exactly one read-only `git ls-files`.
//
// Why this exists: the coverage checker's domain is `.mjs/.cjs/.js` by design, and on a TS project
// that domain is a rounding error of the tree. Certifying it and calling the flow optimal is the
// false green one layer up. The census is the FACT that turns "certified" into "certified over the
// assessable minority" — it never changes what a run may certify.
//
// Read-only: never writes, never commits. Dependency-free, Node >= 22. No side effects on import.

import { spawnSync } from 'node:child_process';
import { classifyChangedPath } from './changed-surface.mjs';

const GIT_MAX_BUFFER = 256 * 1024 * 1024; // a large tracked tree; never truncate

export const CENSUS_VERDICT = Object.freeze({ NARROW: 'domain-narrow', WITHIN_DOMAIN: 'within-domain' });

// The tracked tree is listed with -z and split on NUL. A newline-split of the plain form would be
// wrong twice over: git C-QUOTES a path carrying quotes/control/non-ASCII bytes (so the classifier
// would read `"src/\303\251.ts"`, extension and all, as some other path), and a path containing a
// real newline would split into two phantom entries. -z emits raw bytes and never quotes.
//
// DE-DUPLICATED, because `ls-files` lists per INDEX ENTRY, not per file: during an unresolved merge
// one conflicted path appears once per stage (probed: three times for a content conflict). Counting
// those would inflate one population and could flip a tie into the narrow verdict on nothing but a
// merge in progress.
//
// The split and the de-duplication happen on RAW BYTES, before any decoding. A filename is a byte
// string on this platform and need not be valid UTF-8; decoding first turns every invalid sequence
// into the same replacement character, so two genuinely different paths would collapse into one and
// the de-duplication — added to fix an over-count — would become an UNDER-count. Decoding happens
// once per surviving entry, for the classifier only.
const NUL = 0;
const splitOnNul = (buffer) => {
  const parts = [];
  let start = 0;
  for (let at = buffer.indexOf(NUL, start); at !== -1; at = buffer.indexOf(NUL, start)) {
    if (at > start) parts.push(buffer.subarray(start, at));
    start = at + 1;
  }
  if (start < buffer.length) parts.push(buffer.subarray(start));
  return parts;
};

const listTrackedPaths = (root, spawn) => {
  const result = spawn('git', ['ls-files', '-z'], { cwd: root, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
  if (result.error || result.status !== 0) {
    const reason = result.error ? (result.error.code ?? result.error.message) : `git exited ${result.status}`;
    throw Object.assign(new Error(`tracked-tree census unavailable: ${reason}`), { code: 'CENSUS_UNAVAILABLE' });
  }
  // A spawn seam may hand back a string (an injected fixture); anything else is the real Buffer.
  const raw = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout ?? ''), 'utf8');
  const seenBytes = new Set();
  const paths = [];
  for (const part of splitOnNul(raw)) {
    const identity = part.toString('latin1'); // byte-exact key: one char per byte, never lossy
    if (seenBytes.has(identity)) continue;
    seenBytes.add(identity);
    paths.push(part.toString('utf8'));
  }
  return paths;
};

// takeCensus(root) → { counts, unsupportedExtensions, verdict, total }.
//
// The verdict fires on STRICT DOMINANCE only — the unsupported population must strictly outnumber
// the assessable one. A tie, or a lone `.d.ts` shim beside a real JS tree, is not a narrow domain
// and must not raise an item the project cannot act on. `.d.ts` counts as unsupported like any
// other `.ts` (stated: the classification is by extension, and this leaf adds no exceptions to it).
// Anything outside both sets — `.py`, `.go`, a README — is `out-of-domain` and counted, never
// judged: detecting whole out-of-domain-language projects is deliberately not this census's job.
// An UNAVAILABLE census throws (a non-git tree, a broken git) — the caller's stated-skip lane. It
// never returns a verdict it could not compute; a silent "within-domain" would be the same false
// green one layer down.
export const takeCensus = (root, { spawn = spawnSync } = {}) => {
  const counts = { assessable: 0, unsupported: 0, 'out-of-domain': 0, 'excluded-test': 0 };
  const unsupportedExtensions = new Set();
  for (const path of listTrackedPaths(root, spawn)) {
    const kind = classifyChangedPath(path);
    counts[kind] += 1;
    if (kind === 'unsupported') {
      const base = path.split('/').pop();
      unsupportedExtensions.add(base.slice(base.lastIndexOf('.')));
    }
  }
  const verdict = counts.unsupported > counts.assessable ? CENSUS_VERDICT.NARROW : CENSUS_VERDICT.WITHIN_DOMAIN;
  return {
    counts,
    unsupportedExtensions: [...unsupportedExtensions].sort(),
    verdict,
    total: Object.values(counts).reduce((sum, n) => sum + n, 0),
  };
};

// censusFact(census) → the canonical string an acknowledgment binds. It carries the VERDICT and the
// sorted set of unsupported extensions present — never the per-file counts. A count-bound fact
// would re-fire the moment any file is added, turning a durable acknowledgment into a nag; the
// FACT the maintainer acknowledged ("this tree is dominated by .ts/.tsx, and certification covers
// the JS minority") is exactly what stays stable while the tree grows, and exactly what changes
// when a new unsupported language arrives or the verdict flips back.
export const censusFact = (census) => `${census.verdict}:${census.unsupportedExtensions.join(',')}`;
