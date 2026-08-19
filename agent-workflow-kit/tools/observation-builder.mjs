// observation-builder.mjs — measure a scope and construct the OBSERVATION record (delegation
// Plan 3, Phase 3). Extracted from dispatch.mjs so `dispatch observe` and the handoff-return rung
// build the IDENTICAL record through ONE path: the rung is imported by dispatch.mjs for its verb,
// so a rung importing dispatch.mjs back would be exactly the cycle test/read-graph-purity.test.mjs
// pins the tools graph against. Every function here moved byte-for-byte; the only new export is
// the record construction the observe verb previously inlined.
//
// Spawns nothing but git READS (through the shared gitLine). No CLI, no writes, no side effects on
// import. Dependency-free, Node >= 22.

import { readFileSync, openSync, closeSync, realpathSync, constants as fsConstants } from 'node:fs';
import { resolve, sep } from 'node:path';
import {
  DELEGATION_SCHEMA_VERSION, computeNumerator, evaluateObservationEligibility,
} from './dispatch-record.mjs';
import { lstatNoFollowRead, describeNonRegular } from './fs-read-nofollow.mjs';
import { gitLine } from './flow-store-read.mjs';
import { lexicalRepoRelative } from './repo-lex.mjs';

// The solo baseline counts each scope object's POST-IMAGE — the bytes on disk after the
// construction — which is exactly the `new` numerator rule (D6). No exec diff kind enumerates
// ranges, so a measured observation can never claim a partial object.
const SOLO_COMPONENT_KIND = 'new';

// The scope's anchor is the git TOP-LEVEL, never the caller's cwd: a recorded scope must name the
// same objects whoever runs the tool from wherever. `null` outside a work tree — a repo-relative
// domain with no repository has nothing to be relative TO, and falling back to cwd would be a
// second, incompatible semantics for the same field.
export const resolveRepoRoot = (cwd) => {
  if (gitLine(['rev-parse', '--is-inside-work-tree'], cwd) !== 'true') return null;
  const top = gitLine(['rev-parse', '--show-toplevel'], cwd);
  return top === null ? null : realpathSync(top);
};

// The read is no-follow on the LEAF (a symlinked leaf is already refused by name above; O_NOFOLLOW
// makes a swap between the classification and the read fail loudly rather than counting another
// object's bytes). Honest limit: classify-then-read is not race-free, and it is not meant to be —
// the scope is the orchestrator's OWN work tree and the result is a MAGNITUDE, never a store
// identity, so a pathname race costs a wrong byte count, not a forged record.
const readObjectBytes = (path) => {
  const fd = openSync(path, (fsConstants.O_RDONLY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
};

// One scope object → one numerator entry. Refuses by NAME on anything it cannot count honestly: a
// path escaping the repo LEXICALLY, an absent path, a non-regular path (a symlinked leaf included —
// following one would count another object's bytes under this name), and a path whose REAL location
// is outside the repository. The last one is the case the lexical rule alone cannot see: it rejects
// `../x` while accepting `link/x`, where `link` is an ancestor symlink pointing out of the tree.
// The identity is the CANONICAL repo-relative path taken from the verified real path — not a content
// hash. The solo domain has no rename lineage for a content id to protect, and a content id would
// let one object read between two measurements look like TWO objects instead of refusing as the
// producer contradiction it is ("one identity, one size"). Two equal-byte files at different paths
// are two objects and count twice; one path reached twice (a second listing, an in-repo ancestor
// symlink) is one object and counts once.
export const measureObject = (root, rel) => {
  const lexical = lexicalRepoRelative(rel);
  if (!lexical.ok) return { ok: false, reason: `scope path "${rel}": ${lexical.reason}` };
  const path = resolve(root, rel);
  const stat = lstatNoFollowRead(path);
  if (stat === null) return { ok: false, reason: `scope path "${rel}" does not exist — an observation counts objects that are actually there (fail closed)` };
  if (!stat.isFile()) return { ok: false, reason: `scope path "${rel}" is a ${describeNonRegular(stat)}, not a regular file — the scope names repository objects (fail closed)` };
  const real = realpathSync(path);
  if (!real.startsWith(`${root}${sep}`)) {
    return { ok: false, reason: `scope path "${rel}" resolves to ${real}, which leaves the repository at ${root} — an ancestor symlink is not a way out of the scope domain (fail closed)` };
  }
  const canonical = real.slice(root.length + 1);
  const bytes = readObjectBytes(path);
  return { ok: true, entry: { kind: SOLO_COMPONENT_KIND, path: canonical, objectId: canonical, postImageBytes: bytes.length } };
};

// One repo-relative path per scope entry, in the order given. The measured CANONICAL paths become
// the record's `scope` as a canonical JSON array, so what was measured and what is written down are
// the same statement — and a path carrying a space says so unambiguously.
export const measureScope = (root, paths) => {
  const entries = [];
  for (const rel of paths) {
    const measured = measureObject(root, rel);
    if (!measured.ok) return measured;
    entries.push(measured.entry);
  }
  const numerator = computeNumerator(entries);
  return numerator.ok
    ? { ...numerator, scope: JSON.stringify(entries.map((e) => e.path)) }
    : { ok: false, reason: numerator.reason };
};

export const ratio = (value) => value.toFixed(3);

// L is printed ONLY where the metric is eligible: an ineligible metric has a NAMED reason and no
// ratio at all, and printing a number beside the name is how a silent zero gets read as a
// measurement.
export const formatRatio = (metric) => (metric.eligible
  ? `L = ${ratio(metric.numeratorBytes / metric.denominatorBytes)} (${metric.numeratorBytes} B / ${metric.denominatorBytes} B)`
  : `L = n/a — INELIGIBLE (${metric.ineligibleReason})`);

// The ONE observation-record construction: the eligibility is evaluated here, over the same two
// numbers the record carries, so a record and its own eligibility can never disagree at the door.
export const buildObservationRecord = ({ waveId, stepClass, measured, provenance, denominatorBytes, planId, phase, timestamp }) => {
  const eligibility = evaluateObservationEligibility({ numeratorBytes: measured.numeratorBytes, denominatorBytes });
  return {
    schema: DELEGATION_SCHEMA_VERSION,
    kind: 'observation',
    waveId,
    stepClass,
    scope: measured.scope,
    metric: {
      numeratorBytes: measured.numeratorBytes,
      denominatorBytes,
      components: measured.components,
      provenance,
      eligible: eligibility.eligible,
      ineligibleReason: eligibility.ineligibleReason,
    },
    planId,
    phase,
    timestamp,
  };
};
