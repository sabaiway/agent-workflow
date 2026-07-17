#!/usr/bin/env node
// Legacy-stamp takeover — the lineage-coherent state machine for the
// `.workflow-version` (kit-fallback) → `.memory-version` (memory) transition.
//
// Two independent axes: npm *package* versions vs the *deployment-lineage* stamp.
// The deployment lineage is a SINGLE shared sequence; its current head is LINEAGE_HEAD.
// Both `.memory-version` and the kit-fallback `.workflow-version` track THAT sequence —
// never their package versions. So this substrate's package may be 1.0.0 while the stamp
// it writes is the lineage head (3.0.0 today).
//
// `decideTakeover` is a PURE function (stamp state in → action out) so the state machine is
// unit-testable per row. `applyTakeover` is the thin fs wrapper; stamp writes are ATOMIC
// (write temp + rename) so an interrupted write can never corrupt the prior stamp.
//
// The Markdown twin `migrations/legacy-stamp-takeover.md` documents the same table as the
// no-Node manual fallback. Dependency-free, Node >= 22.

import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// The shared agent-workflow deployment-lineage head. Bumped only when a project-migration
// changes the deployed docs/ai structure — NOT on a packaging-only release.
export const LINEAGE_HEAD = '3.0.0';

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

export const parseSemver = (value) => {
  if (value == null) return null;
  const match = String(value).trim().match(SEMVER_RE);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

// Returns -1 | 0 | 1 for a<b | a==b | a>b, or null if either side is unparseable.
export const compareSemver = (a, b) => {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
};

// null ONLY for a truly absent value (ENOENT). A PRESENT but empty/whitespace stamp normalizes to
// '' (not null), so decideTakeover treats it as unparseable → STOP rather than absent → rebootstrap.
const normalize = (value) => (value == null ? null : String(value).trim());

// PURE: given the two stamp values (string contents or null) and the lineage head, decide the
// takeover action. Mirrors the §1.5 state table. Output:
//   status            'ok' | 'stop' | 'rebootstrap'
//   writeMemoryVersion the value to atomically write to .memory-version now, or null
//   migrateFrom        the version memory migrations run from (exclusive), or null
//   note              human-readable reason (for the report)
export const decideTakeover = (state, head = LINEAGE_HEAD) => {
  const memory = normalize(state?.memoryVersion);
  const workflow = normalize(state?.workflowVersion);

  // Validate every PRESENT stamp before any state branch: unparseable or future → STOP.
  for (const [name, value] of [['.memory-version', memory], ['.workflow-version', workflow]]) {
    if (value == null) continue;
    if (!parseSemver(value)) {
      return {
        status: 'stop',
        writeMemoryVersion: null,
        migrateFrom: null,
        note: `unparseable ${name} stamp "${value}" — STOP and report (needs manual review).`,
      };
    }
    if (compareSemver(value, head) > 0) {
      return {
        status: 'stop',
        writeMemoryVersion: null,
        migrateFrom: null,
        note: `${name} stamp "${value}" is newer than the lineage head ${head} — STOP and report (do not downgrade).`,
      };
    }
  }

  if (memory != null) {
    // .memory-version present (valid, not future): takeover is a no-op; migrate from it.
    return {
      status: 'ok',
      writeMemoryVersion: null,
      migrateFrom: memory,
      note:
        workflow != null
          ? 'both stamps present — no takeover; each tool migrates from its own stamp (.memory-version here).'
          : 'migrate from the existing .memory-version.',
    };
  }

  if (workflow != null) {
    // Legacy only: copy verbatim → .memory-version; leave .workflow-version; migrate from it.
    return {
      status: 'ok',
      writeMemoryVersion: workflow,
      migrateFrom: workflow,
      note: `legacy takeover — copy .workflow-version "${workflow}" verbatim into .memory-version; the legacy stamp is left in place.`,
    };
  }

  // No stamp at all → conservative re-bootstrap offer (existing behaviour).
  return {
    status: 'rebootstrap',
    writeMemoryVersion: null,
    migrateFrom: null,
    note: 'no stamp found — offer a conservative re-bootstrap.',
  };
};

// Select migration versions strictly newer than `migrateFrom` and ≤ head, ascending.
// `available` is the list of migration `<version>` strings present in migrations/.
export const selectMigrations = (migrateFrom, available, head = LINEAGE_HEAD) =>
  [...available]
    .filter((v) => parseSemver(v))
    .filter((v) => (migrateFrom == null || compareSemver(v, migrateFrom) > 0) && compareSemver(v, head) <= 0)
    .sort((a, b) => compareSemver(a, b));

// Absent ONLY for ENOENT. A permission/EISDIR/IO error must NOT masquerade as "no stamp" — that
// would silently route a real failure into re-bootstrap or a wrong takeover; surface it so the
// caller STOPs.
export const readStamp = async (filePath) => {
  try {
    return normalize(await readFile(filePath, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
};

// Atomic single-line stamp write: an EXCLUSIVE (`wx` = O_EXCL|O_CREAT) randomized temp file in the
// same dir, then rename over the target. `wx` never follows or overwrites a pre-existing path
// (so a planted temp-name symlink can't redirect the write); a randomized name avoids collisions;
// a crash before the rename leaves the prior stamp byte-for-byte intact; the temp is cleaned on
// any failure so no residue is left behind.
export const writeStampAtomic = async (filePath, value) => {
  const tmp = join(dirname(filePath), `.${basename(filePath)}.tmp-${randomBytes(8).toString('hex')}`);
  try {
    await writeFile(tmp, `${String(value).trim()}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
};

// Thin fs wrapper: read both stamps from a docs/ai dir, decide, and (only when the decision
// says so) atomically write .memory-version. Idempotent: a second run sees .memory-version
// and writes nothing. Returns the decision for the caller to report.
export const applyTakeover = async (docsAiDir, { head = LINEAGE_HEAD } = {}) => {
  const memoryPath = join(docsAiDir, '.memory-version');
  const workflowPath = join(docsAiDir, '.workflow-version');
  const decision = decideTakeover(
    { memoryVersion: await readStamp(memoryPath), workflowVersion: await readStamp(workflowPath) },
    head,
  );
  if (decision.status === 'ok' && decision.writeMemoryVersion != null) {
    await writeStampAtomic(memoryPath, decision.writeMemoryVersion);
  }
  return decision;
};

// Direct-run CLI: `node stamp-takeover.mjs <docs/ai-dir>` reads the two stamps, applies the
// lineage takeover (atomic, idempotent), and prints the decision. Exits non-zero on a STOP state.
const main = async (argv) => {
  const dir = argv[0];
  if (!dir) {
    console.error('usage: stamp-takeover.mjs <docs/ai-dir>  (applies the .workflow-version → .memory-version lineage takeover)');
    process.exit(2);
  }
  const decision = await applyTakeover(resolve(dir));
  console.log(`[stamp-takeover] ${decision.status}: ${decision.note}`);
  if (decision.migrateFrom) console.log(`[stamp-takeover] migrate memory migrations from: ${decision.migrateFrom} (head ${LINEAGE_HEAD})`);
  if (decision.status === 'stop') process.exit(1);
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) await main(process.argv.slice(2));
