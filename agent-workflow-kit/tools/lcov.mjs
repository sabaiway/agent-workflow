#!/usr/bin/env node
// lcov.mjs — a dependency-free LCOV parser for the fold-completeness runner's coverage.kind:"lcov"
// branch (BUGFREE-3, AD-049 — the language-independence contract). When a verification profile
// declares coverage.kind:"lcov", the consumer's OWN suite leaves an LCOV file at the declared path
// (the diff-cover / c8 --reporter=lcov pattern) and this module reads it into a per-file
// line→hits map, keyed by the SAME canonical absolute path the V8 coverage map uses — so the
// runner's ONE uncovered-changed loop consumes either source unchanged (computeUncoveredLines /
// effectiveCount stay the V8-only path, D10).
//
// FAIL-CLOSED posture (the whole reason the fold gate exists): a malformed record can never mark a
// line COVERED — a DA with a valid line but a non-integer HIT count reads the line UNCOVERED (hits 0,
// the gate fails), and a DA with no valid line number is skipped (unattributable — there is no line to
// flag), never a false green. An SF path that resolves OUTSIDE the repo — or does not resolve at all —
// is never trusted as coverage (a wrong file could otherwise read covered). (STATED residual, inherent
// to the LCOV data model: a CONFORMANT producer emits DA:N,0 for every uncovered executable line, so a
// changed executable line with NO DA entry reads non-executable — LCOV carries no separate
// executability signal; the V8 path, which reads an absent line as uncovered, differs by format.)
//
// Dependency-free, Node >= 18. No side effects on import.

import { join, resolve, isAbsolute, sep } from 'node:path';
import { realpathSync } from 'node:fs';

// Only these three LCOV records are consulted; every other record (FN/FNDA/BRDA/LF/LH/BRF/…) is
// ignored. LCOV groups per-file sections between an `SF:<path>` line and `end_of_record`.
const SF_RE = /^SF:(.*)$/;
const DA_RE = /^DA:(\d+),(.*)$/; // DA:<line>,<hits-field>… — the LINE must be an int; the hits field is
// parsed leniently below so a truncated/malformed hit count reads UNCOVERED (fail-closed), not omitted.
const END_RE = /^end_of_record\s*$/;

// parseLcov(text) → Map<sfString, Map<lineNumber, hits>>. Raw SF strings (NOT yet canonicalized).
// A line's hits is the MAX across duplicate DA entries within a section (some tracers emit per-test
// sections that also repeat lines). A DA whose line or hit count is not a base-10 integer is skipped
// (fail-closed: it can never mark a line covered). Lines with no DA entry never appear (a
// non-executable line — blank/comment — is simply absent, mirroring the V8 blank-line skip).
export const parseLcov = (text) => {
  const out = new Map();
  let current = null; // the Map<line,hits> for the SF section in progress
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const sf = SF_RE.exec(line);
    if (sf) {
      const path = sf[1].trim();
      if (path.length === 0) {
        current = null;
        continue;
      }
      current = out.get(path);
      if (!current) {
        current = new Map();
        out.set(path, current);
      }
      continue;
    }
    if (END_RE.test(line)) {
      current = null;
      continue;
    }
    const da = DA_RE.exec(line);
    if (da && current) {
      const n = Number.parseInt(da[1], 10);
      if (!Number.isInteger(n) || n < 1) continue; // no valid line number → unattributable, skip
      const hitsField = da[2].split(',')[0]; // the hit count (a trailing ,checksum is ignored)
      // FAIL-CLOSED, STRICT: the hit count must be ALL digits — a truncated `DA:42,`, a
      // `DA:2,xyz`, a partial `DA:5,1abc`, or a fractional `DA:6,2.5` all read UNCOVERED (hits 0), never
      // parseInt-coerced to a positive "covered" value. A covered sibling still wins (max).
      const effHits = /^\d+$/.test(hitsField) ? Number.parseInt(hitsField, 10) : 0;
      current.set(n, Math.max(current.get(n) ?? 0, effHits));
    }
  }
  return out;
};

const defaultCanon = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

// Segment-safe containment ('/a' never contains '/ab'); correct at the filesystem root (mirrors
// fold-completeness-run.mjs containsPath). Defined locally so lcov.mjs never imports the runner (the
// runner imports THIS module).
const containsPath = (realRoot, realAbs) =>
  realAbs === realRoot || realAbs.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);

// lcovCoveredMap(text, rootTop, { canon }?) → Map<canonAbsKey, Map<line, hits>>. Each SF is resolved
// against rootTop (a relative / ./-prefixed / absolute-in-repo SF all normalize to the same key the
// V8 map uses), canon()-normalized, and KEPT only when it resolves strictly INSIDE the repo root; an
// outside-tree or unresolvable SF is DROPPED (never trusted as coverage). Duplicate SF sections are
// merged taking the max hits per line. canon is injectable for hermetic tests (default realpathSync).
export const lcovCoveredMap = (text, rootTop, deps = {}) => {
  const canon = deps.canon ?? defaultCanon;
  const raw = parseLcov(text);
  const rootCanon = canon(rootTop);
  const out = new Map();
  for (const [sf, lineHits] of raw) {
    const abs = isAbsolute(sf) ? sf : resolve(rootTop, sf);
    const key = canon(abs);
    if (!containsPath(rootCanon, key)) continue; // outside the repo (or unresolved elsewhere) → drop
    let m = out.get(key);
    if (!m) {
      m = new Map();
      out.set(key, m);
    }
    for (const [line, hits] of lineHits) m.set(line, Math.max(m.get(line) ?? 0, hits));
  }
  return out;
};

// uncoveredChangedFromLcov(coveredMap, key, changedLines) → the sorted changed lines that the LCOV
// records as EXECUTABLE-but-unexecuted (a DA entry with 0 hits). A file ABSENT from the map (no SF)
// is signalled by a null return → the caller records a file-level RED (line:null), exactly like the
// V8 "absent from coverage" case. A changed line with NO DA entry in a PRESENT file is non-executable
// (blank/comment) and never flagged — mirroring the V8 blank-line skip.
export const uncoveredChangedFromLcov = (coveredMap, key, changedLines) => {
  const lineHits = coveredMap.get(key);
  if (!lineHits) return null; // file absent from coverage → file-level RED (caller decides)
  const uncovered = [];
  for (const n of changedLines) {
    const hits = lineHits.get(n);
    if (hits === 0) uncovered.push(n); // executable, 0 hits → uncovered
    // hits > 0 → covered; hits === undefined → non-executable line, skip
  }
  return [...new Set(uncovered)].sort((a, b) => a - b);
};
