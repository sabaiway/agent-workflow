#!/usr/bin/env node
// Methodology slot injection — the composition root's only mutation of memory's AGENTS.md.
//
// memory ships an EMPTY delimited slot in templates/AGENTS.md; the kit (which knows the whole
// family) fills it. The engine only *provides* the methodology text — Plan 2 repoints the
// source to it. Phase 1 source = the kit's bundled tools/methodology-slot.md (a BOUNDED summary
// + pointer, NOT the full references/planning.md), so AGENTS.md stays under its line cap.
//
// Marker contract (shared with memory's upgrade extract-and-reinsert), strictly enforced:
//   - exactly one ordered start→end pair  → replace only the bytes between them.
//   - markers absent (legacy AGENTS.md)   → gracefully NO-OP (slot migration is Plan 2).
//   - any malformed state (single, reversed, nested, duplicate) → NO-OP WITH AN ERROR; never edit.
// Prefix/suffix bytes are preserved exactly. Re-running with the same fragment is idempotent.
//
// Pure string functions (testable with byte-preservation fixtures); dependency-free, Node >= 18.

export const START_MARKER = '<!-- workflow:methodology:start -->';
export const END_MARKER = '<!-- workflow:methodology:end -->';
export const AGENTS_MD_CAP = 100; // the deployed AGENTS.md line budget (its own footer rule)

const countOccurrences = (haystack, needle) => {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + needle.length;
  }
};

// Classify the marker state of an AGENTS.md text. Pure; no fs.
//   { state: 'ok',      startIdx, endIdx }   exactly one ordered pair
//   { state: 'absent' }                      no markers at all → caller no-ops
//   { state: 'malformed', reason }           anything else → caller no-ops WITH error
export const findSlot = (text) => {
  const starts = countOccurrences(text, START_MARKER);
  const ends = countOccurrences(text, END_MARKER);
  if (starts === 0 && ends === 0) return { state: 'absent' };
  if (starts !== 1 || ends !== 1) {
    return { state: 'malformed', reason: `expected exactly one start/end marker pair, found ${starts} start / ${ends} end` };
  }
  const startIdx = text.indexOf(START_MARKER);
  const endIdx = text.indexOf(END_MARKER);
  if (endIdx < startIdx) return { state: 'malformed', reason: 'end marker precedes start marker' };
  return { state: 'ok', startIdx, endIdx };
};

// Inject `fragment` between the markers, replacing only the bytes between them.
// Returns { status: 'injected' | 'noop-absent' | 'error', text, error? }. On absent/error the
// returned text is the INPUT, byte-for-byte (never edit on a malformed slot). Pass
// `{ maxLines }` to enforce the AGENTS.md line cap as a postcondition (refuse, don't bust it).
export const injectMethodology = (text, fragment, { maxLines } = {}) => {
  // A fragment that itself contains a marker would create a duplicate/nested slot — refuse.
  if (fragment.includes(START_MARKER) || fragment.includes(END_MARKER)) {
    return { status: 'error', text, error: 'fragment contains a methodology marker — refusing to inject (would create a duplicate/nested slot)' };
  }
  const slot = findSlot(text);
  if (slot.state === 'absent') return { status: 'noop-absent', text };
  if (slot.state === 'malformed') return { status: 'error', text, error: slot.reason };
  const before = text.slice(0, slot.startIdx + START_MARKER.length);
  const after = text.slice(slot.endIdx);
  const out = `${before}\n${fragment.trim()}\n${after}`;
  if (maxLines != null) {
    const lines = out.split('\n').length - (out.endsWith('\n') ? 1 : 0);
    if (lines > maxLines) {
      return { status: 'error', text, error: `injection would push AGENTS.md to ${lines} lines (cap ${maxLines}) — trim the fragment or the file` };
    }
  }
  return { status: 'injected', text: out };
};

// Inverse used by memory's upgrade: extract the current slot content (preserve-on-upgrade).
// Returns the bytes strictly between the markers, or null on absent/malformed.
export const extractSlot = (text) => {
  const slot = findSlot(text);
  if (slot.state !== 'ok') return null;
  return text.slice(slot.startIdx + START_MARKER.length, slot.endIdx);
};

const main = async (argv) => {
  const { readFile, writeFile, rename } = await import('node:fs/promises');
  const { dirname, basename, join, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const agentsPath = argv[0];
  if (!agentsPath) {
    console.error('usage: inject-methodology.mjs <path/to/AGENTS.md> [fragment.md]');
    process.exit(2);
  }
  const fragmentPath = argv[1] ? resolve(argv[1]) : resolve(here, 'methodology-slot.md');
  const text = await readFile(resolve(agentsPath), 'utf8');
  const fragment = await readFile(fragmentPath, 'utf8');
  const result = injectMethodology(text, fragment, { maxLines: AGENTS_MD_CAP });
  if (result.status === 'error') {
    console.error(`[inject-methodology] malformed slot — refusing to edit: ${result.error}`);
    process.exit(1);
  }
  if (result.status === 'noop-absent') {
    console.log('[inject-methodology] no methodology markers found — nothing to inject (legacy AGENTS.md).');
    return;
  }
  const tmp = join(dirname(resolve(agentsPath)), `.${basename(agentsPath)}.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, result.text, 'utf8');
  await rename(tmp, resolve(agentsPath));
  console.log('[inject-methodology] injected the bounded methodology fragment into the slot.');
};

const { pathToFileURL } = await import('node:url');
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) await main(process.argv.slice(2));
