#!/usr/bin/env node
// Methodology slot injection + reconciliation — the composition root's only mutation of a
// deployed AGENTS.md.
//
// Both templates (memory's + the kit fallback) ship an EMPTY delimited slot; the kit (which knows
// the whole family) fills it. The bounded fragment is a BOUNDED summary + pointer (NOT the full
// references/planning.md), so AGENTS.md stays under its line cap. It is read LIVE from the installed
// agent-workflow-engine (references/methodology-slot.md) via engine-source.mjs — the family's one
// source of truth; there is no bundled mirror (retired in Plan 3D, AD-016). The live read is lazy +
// fail-loud: resolve+read the engine ONLY when a fill is actually needed, and STOP loudly (never a
// silent fallback) when the engine is needed but absent/invalid.
//
// Two layers over one marker parser:
//   - injectMethodology — fill an EXISTING slot. Marker contract, strictly enforced:
//       exactly one ordered start→end pair → replace only the bytes between them;
//       markers absent → NO-OP; any malformed state (single, reversed, nested, duplicate) →
//       NO-OP WITH AN ERROR, never edit. Prefix/suffix preserved exactly; re-run is idempotent.
//   - ensureSlot / reconcileSlot — the bootstrap/upgrade policy (Plan 2): ensure the slot EXISTS
//       (insert an empty pair at the Session-Protocols anchor when a legacy file lacks one) →
//       inject ONLY IF empty (preserve a customized slot verbatim) → cap-check. Stamp-independent.
//
// Pure string functions (testable with byte-preservation fixtures); dependency-free, Node >= 18.

export const START_MARKER = '<!-- workflow:methodology:start -->';
export const END_MARKER = '<!-- workflow:methodology:end -->';
export const AGENTS_MD_CAP = 100; // the deployed AGENTS.md line budget (its own footer rule)

// Count lines independent of a trailing newline (CRLF-safe: split on '\n' — a CRLF line still ends
// in '\n', so the count is the same as for LF).
const lineCount = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

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
  // Frame the fragment with the DOCUMENT's newline style (and convert the LF-canonical fragment to
  // it) so injecting into a CRLF file does not leave lone LFs around the slot.
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const before = text.slice(0, slot.startIdx + START_MARKER.length);
  const after = text.slice(slot.endIdx);
  const body = fragment.trim().replace(/\r?\n/g, nl);
  const out = `${before}${nl}${body}${nl}${after}`;
  if (maxLines != null && lineCount(out) > maxLines) {
    return { status: 'error', text, error: `injection would push AGENTS.md to ${lineCount(out)} lines (cap ${maxLines}) — trim the fragment or the file` };
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

// The Session-Protocols anchor line both deployed templates carry (the agent_rules.md §1 sentence).
// ensureSlot inserts an empty slot right after this line when a legacy entry point has no markers.
// Contract: EXACTLY ONE match required — 0 or >1 → error (never guess where the methodology lives).
export const METHODOLOGY_ANCHOR = /^.*Read it before any code change\..*$/m;

// The canonical empty slot (an ordered start→end pair, nothing between) — what a fresh template
// ships and what ensureSlot inserts. LF form; ensureSlot rewrites the newline to match the document.
export const EMPTY_SLOT = `${START_MARKER}\n${END_MARKER}`;

const countMatches = (text, re) => (text.match(new RegExp(re.source, 'gm')) || []).length;

// Ensure a single, well-formed methodology slot EXISTS — without filling it. Pure; no fs.
//   { status: 'present',  text }   a well-formed slot already exists → bytes unchanged (idempotent).
//   { status: 'inserted', text }   absent + exactly one anchor → an EMPTY slot inserted right after
//                                   the anchor line, newline style + all other bytes preserved.
//   { status: 'error', text, error }  malformed slot, OR (when absent) 0/>1 anchors → bytes unchanged.
export const ensureSlot = (text) => {
  const slot = findSlot(text);
  if (slot.state === 'ok') return { status: 'present', text };
  if (slot.state === 'malformed') return { status: 'error', text, error: slot.reason };
  // absent → place an empty slot at the one anchor, or refuse rather than guess.
  const anchors = countMatches(text, METHODOLOGY_ANCHOR);
  if (anchors !== 1) {
    return {
      status: 'error',
      text,
      error: `expected exactly one methodology anchor (the "Read it before any code change." Session-Protocols line), found ${anchors} — refusing to guess where the slot belongs; add the slot markers manually`,
    };
  }
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const match = text.match(METHODOLOGY_ANCHOR);
  const eol = text.indexOf('\n', match.index);
  const insertAt = eol === -1 ? text.length : eol + 1;
  const block = `${nl}${EMPTY_SLOT.replace(/\n/g, nl)}${nl}`;
  const out = `${text.slice(0, insertAt)}${block}${text.slice(insertAt)}`;
  return { status: 'inserted', text: out };
};

// Bootstrap/upgrade reconciliation policy (pure): ensure the slot exists, then fill it ONLY IF it
// is empty (a filled/customized slot is preserved verbatim), enforcing the line cap — all as one
// step the CLI commits with a single atomic write. On ANY error the INPUT bytes are returned
// unchanged (the intermediate slot-insert is discarded), so there is no partial on-disk state.
//   reconciled-inserted — slot was absent, inserted at the anchor, then filled.
//   reconciled-filled   — slot existed but was empty, now filled.
//   present-filled      — slot already carried content → preserved verbatim.
//   error               — malformed slot, 0/>1 anchors, or cap exceeded → input unchanged.
export const reconcileSlot = (text, fragment, { maxLines } = {}) => {
  const ensured = ensureSlot(text);
  if (ensured.status === 'error') return { status: 'error', text, error: ensured.error };
  const current = extractSlot(ensured.text);
  const isEmpty = current == null || current.trim() === '';
  if (!isEmpty) {
    // Preserve a filled/customized slot verbatim — but still enforce the cap on the result, so an
    // already-over-cap entry point is surfaced (input unchanged) rather than silently accepted.
    if (maxLines != null && lineCount(ensured.text) > maxLines) {
      return { status: 'error', text, error: `AGENTS.md is ${lineCount(ensured.text)} lines (cap ${maxLines}) — trim the file (a customized methodology slot must still fit the cap)` };
    }
    return { status: 'present-filled', text: ensured.text };
  }
  const injected = injectMethodology(ensured.text, fragment, { maxLines });
  if (injected.status !== 'injected') return { status: 'error', text, error: injected.error };
  const status = ensured.status === 'inserted' ? 'reconciled-inserted' : 'reconciled-filled';
  return { status, text: injected.text };
};

// Pure predicate (no fs): does this AGENTS.md actually need the methodology fragment? True only when
// the slot can be ensured (present or insertable) AND is empty — i.e. when reconcileSlot would
// inject. False when the slot is already filled (preserve-verbatim, no fragment read) OR when the
// slot/anchor is malformed (so reconcileSlot's own precise error path still fires). It reuses the
// SAME primitives as reconcileSlot (ensureSlot + extractSlot), so the lazy "read the engine only
// when needed" guard in main() cannot diverge from the actual fill decision.
export const slotNeedsFill = (text) => {
  const ensured = ensureSlot(text);
  if (ensured.status === 'error') return false;
  const current = extractSlot(ensured.text);
  return current == null || current.trim() === '';
};

const main = async (argv) => {
  const { readFile, writeFile, rename, rm } = await import('node:fs/promises');
  const { dirname, basename, join, resolve } = await import('node:path');
  const { homedir } = await import('node:os');
  const { resolveEngineDir, readEngineFragment } = await import('./engine-source.mjs');

  // `reconcile <AGENTS.md> [fragment.md]` = ensure-slot + inject-if-empty + cap (bootstrap/upgrade);
  // `<AGENTS.md> [fragment.md]` = the legacy inject-into-existing-slot mode.
  const mode = argv[0] === 'reconcile' ? 'reconcile' : 'inject';
  const rest = mode === 'reconcile' ? argv.slice(1) : argv;
  const agentsPath = rest[0];
  if (!agentsPath) {
    console.error('usage: inject-methodology.mjs [reconcile] <path/to/AGENTS.md> [fragment.md]');
    process.exit(2);
  }
  const explicitFragmentArg = rest[1];
  const text = await readFile(resolve(agentsPath), 'utf8');

  // Source the bounded fragment LAZILY. An explicit [fragment.md] arg (tests + manual) wins and skips
  // engine resolution entirely. Otherwise read it LIVE from the installed engine — there is no
  // bundled mirror. readEngineFragment THROWS (never falls back) when the engine is needed but
  // absent/invalid; sourceFragmentOrStop turns that into a hard, loud STOP carrying the install
  // command. The caller only invokes this when a fill is actually needed (the laziness).
  const sourceFragment = async () => {
    if (explicitFragmentArg) return readFile(resolve(explicitFragmentArg), 'utf8');
    const { dir, source } = resolveEngineDir({ env: process.env, home: homedir() });
    return readEngineFragment(dir, { source }); // sync; throws loudly when the engine is absent/invalid
  };
  const sourceFragmentOrStop = async (label) => {
    try {
      return await sourceFragment();
    } catch (err) {
      // Engine needed-but-absent → a hard STOP, distinct from the soft cap-skip. The
      // "methodology engine not found/invalid" prefix lets the agent classify this exit (SKILL.md).
      console.error(`[inject-methodology] ${label} — ${err.message}`);
      process.exit(1);
    }
  };

  const writeAtomic = async (out) => {
    const tmp = join(dirname(resolve(agentsPath)), `.${basename(agentsPath)}.tmp-${process.pid}-${Date.now()}`);
    try {
      await writeFile(tmp, out, 'utf8');
      await rename(tmp, resolve(agentsPath));
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {}); // never leave a temp file behind on failure
      throw err;
    }
  };

  if (mode === 'reconcile') {
    // Read the engine only when the slot actually needs filling (lazy). slotNeedsFill reuses the same
    // primitives reconcileSlot does, so it cannot disagree with the fill decision below — a filled
    // slot reconciles to a zero-diff no-op WITHOUT consulting the engine.
    const fragment = slotNeedsFill(text) ? await sourceFragmentOrStop('reconcile STOP') : '';
    const result = reconcileSlot(text, fragment, { maxLines: AGENTS_MD_CAP });
    if (result.status === 'error') {
      console.error(`[inject-methodology] reconcile refused — ${result.error}`);
      process.exit(1);
    }
    if (result.status === 'present-filled') {
      console.log('[inject-methodology] methodology slot already present and filled — nothing to do (zero-diff).');
      return;
    }
    await writeAtomic(result.text);
    const what =
      result.status === 'reconciled-inserted'
        ? 'inserted the methodology slot at the Session-Protocols anchor and filled it'
        : 'filled the empty methodology slot';
    console.log(`[inject-methodology] reconcile: ${what}.`);
    return;
  }

  // Legacy inject-into-existing-slot mode. injectMethodology no-ops on absent markers and errors on a
  // malformed slot WITHOUT reading the fragment, so resolve+read the engine only when there is a
  // present (ok) slot to fill — a markerless legacy AGENTS.md stays a no-op without the engine.
  const fragment = findSlot(text).state === 'ok' ? await sourceFragmentOrStop('STOP') : '';
  const result = injectMethodology(text, fragment, { maxLines: AGENTS_MD_CAP });
  if (result.status === 'error') {
    console.error(`[inject-methodology] malformed slot — refusing to edit: ${result.error}`);
    process.exit(1);
  }
  if (result.status === 'noop-absent') {
    console.log('[inject-methodology] no methodology markers found — nothing to inject (legacy AGENTS.md).');
    return;
  }
  await writeAtomic(result.text);
  console.log('[inject-methodology] injected the bounded methodology fragment into the slot.');
};

const { pathToFileURL } = await import('node:url');
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) await main(process.argv.slice(2));
