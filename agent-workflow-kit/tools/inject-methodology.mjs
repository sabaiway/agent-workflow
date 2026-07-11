#!/usr/bin/env node
// Marker-slot injection + reconciliation — the composition root's only mutation of a deployed
// AGENTS.md. A deployed entry point carries THREE reconciled marker slots, each filled LIVE from the
// installed agent-workflow-engine (the family's one source of truth, no bundled mirror):
//   1. workflow:methodology  — the plan→execute→review pointer (references/methodology-slot.md).
//   2. workflow:orchestration — the recipe-vocabulary pointer  (references/orchestration-slot.md).
//   3. workflow:autonomy     — the autonomy-policy read contract (references/autonomy-slot.md).
//
// All share ONE generic marker engine (a slot DESCRIPTOR parameterizes the markers / anchor /
// empty-slot / leading-blank). The methodology exports (findSlot / injectMethodology / ensureSlot /
// reconcileSlot / slotNeedsFill / extractSlot) delegate to it byte-for-byte, so the methodology
// contract is unchanged; the later slots are the SAME engine with different descriptors.
//
// Contract per slot, strictly enforced:
//   exactly one ordered start→end pair → replace only the bytes between them;
//   markers absent → ensure-insert an empty pair at the slot's anchor (or NO-OP in legacy inject);
//   any malformed state (single, reversed, nested, duplicate) → NO-OP WITH AN ERROR, never edit.
// The live read is lazy + fail-loud: resolve+read the engine ONLY when a fill is actually needed, and
// STOP loudly (never a silent fallback) when the engine is needed but absent/invalid.
//
// Pure string functions (testable with byte-preservation fixtures); dependency-free, Node >= 18.
//
// Canonical-refresh (AD-025): a slot filled BEFORE a clause existed is normally preserved verbatim
// (reconcile only fills an EMPTY slot). To push a NEW canonical clause to the EXISTING filled base
// without clobbering a user's customization, reconcileMarkerSlot also REFRESHES a filled slot — but
// ONLY when its content normalize-matches a KNOWN PRIOR canonical fragment (drift-guarded, append-only
// per descriptor). A customized slot never matches → preserved verbatim + a read-only upgrade advisory.

import { normalizeCanonical } from './orchestration-config.mjs';

export const START_MARKER = '<!-- workflow:methodology:start -->';
export const END_MARKER = '<!-- workflow:methodology:end -->';
export const ORCH_START_MARKER = '<!-- workflow:orchestration:start -->';
export const ORCH_END_MARKER = '<!-- workflow:orchestration:end -->';
export const AUTONOMY_START_MARKER = '<!-- workflow:autonomy:start -->';
export const AUTONOMY_END_MARKER = '<!-- workflow:autonomy:end -->';
export const AGENTS_MD_CAP = 100; // the deployed AGENTS.md line budget (its own footer rule)

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

const countMatches = (text, re) => (text.match(new RegExp(re.source, 'gm')) || []).length;

// The Session-Protocols anchor line both deployed templates carry (the agent_rules.md §1 sentence).
// ensureSlot inserts an empty METHODOLOGY slot right after this line when a legacy entry point has no
// markers. Contract: EXACTLY ONE match required — 0 or >1 → error (never guess where it lives).
export const METHODOLOGY_ANCHOR = /^.*Read it before any code change\..*$/m;
// The orchestration pair lands right BELOW the methodology end marker — so its anchor is that line.
// A well-formed entry point carries exactly one methodology end marker → exactly one anchor.
export const ORCH_ANCHOR = new RegExp(`^.*${escapeRegExp(END_MARKER)}.*$`, 'm');
// The autonomy pair chains right below the orchestration pair — its anchor is the orchestration end
// marker line. The anchor can legitimately be ABSENT (a legacy file whose orchestration pair was
// itself skipped) — the chained CLI classifies that as a soft skip, never a hard STOP (D4).
export const AUTONOMY_ANCHOR = new RegExp(`^.*${escapeRegExp(ORCH_END_MARKER)}.*$`, 'm');

// The canonical empty slots (an ordered start→end pair, nothing between) — what a fresh template
// ships and what ensureSlot inserts. LF form; ensureSlot rewrites the newline to match the document.
export const EMPTY_SLOT = `${START_MARKER}\n${END_MARKER}`;
export const ORCH_EMPTY_SLOT = `${ORCH_START_MARKER}\n${ORCH_END_MARKER}`;
export const AUTONOMY_EMPTY_SLOT = `${AUTONOMY_START_MARKER}\n${AUTONOMY_END_MARKER}`;

// ── known-prior canonical fragments (drift-guarded, APPEND-ONLY per slot) ───────
// The EXACT content a PREVIOUS release's engine fragment shipped (what a filled slot would carry today).
// reconcileMarkerSlot refreshes a filled slot to the current engine fragment IFF its content
// normalize-matches one of these — so the install base gains a new clause without clobbering a
// customization (which never matches). Any release that CHANGES an engine fragment must FIRST append the
// OUTGOING content here, so the immediately-previous deployments still match (a drift-guard test pins
// current-minus-one → new). NEVER edit an existing entry — only append.
export const KNOWN_PRIOR_METHODOLOGY_SLOT = [
  // v1.3.0 — pre-communication-contract methodology pointer (procedures route, no §1.9 clause).
  '> **Workflow methodology** — plan → execute → review. Plans are ephemeral `docs/plans/*.md` (gitignored, **never committed**); every Plan ends with a mandatory **Phase: Cleanup**; series order lives in `docs/plans/queue.md`. Full vocabulary, lifecycle, and the plan-then-execute split live in the project\'s **planning skill** (it overrides the generic `writing-plans`); summary in `docs/ai/agent_rules.md` §5. Named activities (plan-authoring, plan-execution) have procedures — see `/agent-workflow-kit procedures <activity>` for the steps + resolved recipe.',
];
export const KNOWN_PRIOR_ORCH_SLOT = [
  // v1.3.0 — pre-read-at-start orchestration pointer (recipes vocabulary, no orchestration.json clause).
  '> **Orchestration recipes** — compose plan → execute → review with a named recipe: **Solo** (no backend), **Reviewed** (one backend reviews), **Council** (both review, you synthesize), **Delegated** (a backend executes a bounded sub-task); the orchestrator always commits, a backend is never autonomous. Pick + plan one for this environment with `/agent-workflow-kit recipes` (read-only); the deployed how/why lives in your `docs/ai/` workflow docs.',
];

// A slot descriptor bundles everything the generic engine needs to operate on ONE marker pair.
// `leadingBlank` controls whether the inserted empty pair gets a blank separator line above it — the
// methodology insert keeps it (readability), the orchestration insert omits it to save a cap line
// (the pair already sits right under the methodology block). `knownPriorCanonicals` drives the refresh;
// `upgradeSignature` + `upgradeAdvice` drive the read-only advisory for a CUSTOMIZED (non-matching) slot
// that predates the current clause.
export const METHODOLOGY_DESCRIPTOR = {
  startMarker: START_MARKER,
  endMarker: END_MARKER,
  anchor: METHODOLOGY_ANCHOR,
  emptySlot: EMPTY_SLOT,
  leadingBlank: true,
  markerName: 'methodology',
  anchorLabel: 'methodology anchor (the "Read it before any code change." Session-Protocols line)',
  knownPriorCanonicals: KNOWN_PRIOR_METHODOLOGY_SLOT,
  upgradeSignature: 'Communication',
  upgradeAdvice:
    'the workflow-methodology pointer predates the communication-contract clause (deliver the artifact inline, lead with the result) — refresh it to the current canon, or add the clause by hand; the contract still applies.',
};
export const ORCHESTRATION_DESCRIPTOR = {
  startMarker: ORCH_START_MARKER,
  endMarker: ORCH_END_MARKER,
  anchor: ORCH_ANCHOR,
  emptySlot: ORCH_EMPTY_SLOT,
  leadingBlank: false,
  markerName: 'orchestration',
  anchorLabel: 'orchestration anchor (the methodology end-marker line)',
  knownPriorCanonicals: KNOWN_PRIOR_ORCH_SLOT,
  upgradeSignature: '/agent-workflow-kit set-recipe',
  upgradeAdvice:
    'the orchestration-recipes pointer predates the read-at-start clause — add "read `docs/ai/orchestration.json` at session start; set it with /agent-workflow-kit set-recipe", or set your preference now with /agent-workflow-kit set-recipe.',
};
// The autonomy-policy slot (AD-044 Plan 3) — first canon, so no known priors yet: any future
// fragment change must append the outgoing content to a KNOWN_PRIOR_AUTONOMY_SLOT store first.
export const AUTONOMY_DESCRIPTOR = {
  startMarker: AUTONOMY_START_MARKER,
  endMarker: AUTONOMY_END_MARKER,
  anchor: AUTONOMY_ANCHOR,
  emptySlot: AUTONOMY_EMPTY_SLOT,
  leadingBlank: false,
  markerName: 'autonomy',
  anchorLabel: 'autonomy anchor (the orchestration end-marker line)',
  knownPriorCanonicals: [],
  upgradeSignature: 'docs/ai/autonomy.json',
  upgradeAdvice:
    'the autonomy pointer does not name the per-project policy file — add "read `docs/ai/autonomy.json` at session start; set it with /agent-workflow-kit set-autonomy", or refresh the slot to the current canon.',
};

// ── generic marker-slot engine (descriptor-parameterized) ──────────────────────

// Classify the marker state of a slot. Pure; no fs.
//   { state: 'ok',      startIdx, endIdx }   exactly one ordered pair
//   { state: 'absent' }                      no markers at all → caller no-ops / ensure-inserts
//   { state: 'malformed', reason }           anything else → caller no-ops WITH error
export const findMarkerSlot = (text, descriptor) => {
  const starts = countOccurrences(text, descriptor.startMarker);
  const ends = countOccurrences(text, descriptor.endMarker);
  if (starts === 0 && ends === 0) return { state: 'absent' };
  if (starts !== 1 || ends !== 1) {
    return { state: 'malformed', reason: `expected exactly one start/end marker pair, found ${starts} start / ${ends} end` };
  }
  const startIdx = text.indexOf(descriptor.startMarker);
  const endIdx = text.indexOf(descriptor.endMarker);
  if (endIdx < startIdx) return { state: 'malformed', reason: 'end marker precedes start marker' };
  return { state: 'ok', startIdx, endIdx };
};

// Inject `fragment` between the markers, replacing only the bytes between them. Returns
// { status: 'injected' | 'noop-absent' | 'error', text, error? }. On absent/error the returned text
// is the INPUT, byte-for-byte. Pass `{ maxLines }` to enforce the AGENTS.md line cap (refuse, don't bust).
export const injectIntoSlot = (text, descriptor, fragment, { maxLines } = {}) => {
  if (fragment.includes(descriptor.startMarker) || fragment.includes(descriptor.endMarker)) {
    return { status: 'error', text, error: `fragment contains a ${descriptor.markerName} marker — refusing to inject (would create a duplicate/nested slot)` };
  }
  const slot = findMarkerSlot(text, descriptor);
  if (slot.state === 'absent') return { status: 'noop-absent', text };
  if (slot.state === 'malformed') return { status: 'error', text, error: slot.reason };
  // Frame the fragment with the DOCUMENT's newline style (and convert the LF-canonical fragment to
  // it) so injecting into a CRLF file does not leave lone LFs around the slot.
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const before = text.slice(0, slot.startIdx + descriptor.startMarker.length);
  const after = text.slice(slot.endIdx);
  const body = fragment.trim().replace(/\r?\n/g, nl);
  const out = `${before}${nl}${body}${nl}${after}`;
  if (maxLines != null && lineCount(out) > maxLines) {
    return { status: 'error', text, error: `injection would push AGENTS.md to ${lineCount(out)} lines (cap ${maxLines}) — trim the fragment or the file` };
  }
  return { status: 'injected', text: out };
};

// Extract the current slot content (preserve-on-upgrade inverse). Bytes strictly between the markers,
// or null on absent/malformed.
export const extractMarkerSlot = (text, descriptor) => {
  const slot = findMarkerSlot(text, descriptor);
  if (slot.state !== 'ok') return null;
  return text.slice(slot.startIdx + descriptor.startMarker.length, slot.endIdx);
};

// Ensure a single, well-formed slot EXISTS — without filling it. Pure; no fs.
//   { status: 'present',  text }   a well-formed slot already exists → bytes unchanged (idempotent).
//   { status: 'inserted', text }   absent + exactly one anchor → an EMPTY slot inserted right after
//                                   the anchor line, newline style + all other bytes preserved.
//   { status: 'error', text, error }  malformed slot, OR (when absent) 0/>1 anchors → bytes unchanged.
export const ensureMarkerSlot = (text, descriptor) => {
  const slot = findMarkerSlot(text, descriptor);
  if (slot.state === 'ok') return { status: 'present', text };
  if (slot.state === 'malformed') return { status: 'error', text, error: slot.reason };
  const anchors = countMatches(text, descriptor.anchor);
  if (anchors !== 1) {
    return {
      status: 'error',
      text,
      error: `expected exactly one ${descriptor.anchorLabel}, found ${anchors} — refusing to guess where the slot belongs; add the slot markers manually`,
    };
  }
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const match = text.match(descriptor.anchor);
  const eol = text.indexOf('\n', match.index);
  const insertAt = eol === -1 ? text.length : eol + 1;
  const slotText = descriptor.emptySlot.replace(/\n/g, nl);
  const block = descriptor.leadingBlank ? `${nl}${slotText}${nl}` : `${slotText}${nl}`;
  const out = `${text.slice(0, insertAt)}${block}${text.slice(insertAt)}`;
  return { status: 'inserted', text: out };
};

// Bootstrap/upgrade reconciliation policy (pure): ensure the slot exists, then fill it ONLY IF it
// is empty (a filled/customized slot is preserved verbatim), enforcing the line cap — all as one step
// the CLI commits with a single atomic write. On ANY error the INPUT bytes are returned unchanged.
//   reconciled-inserted  — slot was absent, inserted at the anchor, then filled.
//   reconciled-filled    — slot existed but was empty, now filled.
//   reconciled-refreshed — slot was filled with a KNOWN PRIOR canonical → replaced with `fragment`.
//   present-filled       — slot already carried CUSTOM content → preserved verbatim.
//   error                — malformed slot, 0/>1 anchors, or cap exceeded → input unchanged.
export const reconcileMarkerSlot = (text, descriptor, fragment, { maxLines } = {}) => {
  const ensured = ensureMarkerSlot(text, descriptor);
  if (ensured.status === 'error') return { status: 'error', text, error: ensured.error };
  const current = extractMarkerSlot(ensured.text, descriptor);
  const isEmpty = current == null || current.trim() === '';
  if (!isEmpty) {
    // Canonical-refresh: a slot whose content normalize-matches a known prior canonical is STALE — replace
    // it with the current `fragment`. A customized slot never matches → preserved verbatim. (`fragment`
    // is empty for a customized slot — main() only sources it when markerSlotNeedsFill is true.)
    const priors = descriptor.knownPriorCanonicals ?? [];
    const matchesPrior = fragment && fragment.trim() !== '' && priors.some((p) => normalizeCanonical(p) === normalizeCanonical(current));
    if (matchesPrior) {
      const injected = injectIntoSlot(ensured.text, descriptor, fragment, { maxLines });
      if (injected.status !== 'injected') return { status: 'error', text, error: injected.error };
      return { status: 'reconciled-refreshed', text: injected.text };
    }
    if (maxLines != null && lineCount(ensured.text) > maxLines) {
      return { status: 'error', text, error: `AGENTS.md is ${lineCount(ensured.text)} lines (cap ${maxLines}) — trim the file (a customized ${descriptor.markerName} slot must still fit the cap)` };
    }
    return { status: 'present-filled', text: ensured.text };
  }
  const injected = injectIntoSlot(ensured.text, descriptor, fragment, { maxLines });
  if (injected.status !== 'injected') return { status: 'error', text, error: injected.error };
  const status = ensured.status === 'inserted' ? 'reconciled-inserted' : 'reconciled-filled';
  return { status, text: injected.text };
};

// Pure predicate (no fs): does this slot actually need its fragment? True only when the slot can be
// ensured (present or insertable) AND is empty — i.e. when reconcileMarkerSlot would inject. Reuses
// the SAME primitives as reconcileMarkerSlot, so the lazy "read the engine only when needed" guard in
// main() cannot diverge from the actual fill decision.
export const markerSlotNeedsFill = (text, descriptor) => {
  const ensured = ensureMarkerSlot(text, descriptor);
  if (ensured.status === 'error') return false;
  const current = extractMarkerSlot(ensured.text, descriptor);
  if (current == null || current.trim() === '') return true; // empty → fill
  // filled-but-STALE (content matches a known prior canonical) → needs a refresh, so main() must
  // re-source the fragment. A customized slot doesn't match → no source needed (preserved verbatim).
  const priors = descriptor.knownPriorCanonicals ?? [];
  return priors.some((p) => normalizeCanonical(p) === normalizeCanonical(current));
};

// ── methodology-slot exports (delegate to the generic engine, byte-for-byte) ────

export const findSlot = (text) => findMarkerSlot(text, METHODOLOGY_DESCRIPTOR);
export const injectMethodology = (text, fragment, opts) => injectIntoSlot(text, METHODOLOGY_DESCRIPTOR, fragment, opts);
export const extractSlot = (text) => extractMarkerSlot(text, METHODOLOGY_DESCRIPTOR);
export const ensureSlot = (text) => ensureMarkerSlot(text, METHODOLOGY_DESCRIPTOR);
export const reconcileSlot = (text, fragment, opts) => reconcileMarkerSlot(text, METHODOLOGY_DESCRIPTOR, fragment, opts);
export const slotNeedsFill = (text) => markerSlotNeedsFill(text, METHODOLOGY_DESCRIPTOR);

// The routing token the methodology pointer should carry so NL like "write a plan" auto-discovers the
// activity procedures. A deployment whose methodology slot was filled (legacy / customized) BEFORE this
// clause existed will NOT auto-receive it — reconcile preserves a filled slot verbatim (AD-019 §3.1a).
export const PROCEDURES_POINTER = '/agent-workflow-kit procedures';

// Read-only upgrade advisory (NO mutation): when the methodology slot is present + FILLED but lacks the
// procedures route, return a one-line note the upgrade flow surfaces — add it for auto-discovery; the
// feature is reachable now via the explicit command. Returns null for an absent / empty / malformed slot
// or one that already routes to procedures. Pure; never edits the file.
export const methodologyProceduresHint = (text) => {
  const content = extractSlot(text);
  if (content == null || content.trim() === '') return null; // only a FILLED methodology slot
  if (content.includes(PROCEDURES_POINTER)) return null; // already routes to the procedures advisor
  return `the methodology pointer has no procedures route — add "${PROCEDURES_POINTER} <activity>" for auto-discovery; the activity procedures are reachable now via ${PROCEDURES_POINTER}.`;
};

// Generic read-only upgrade advisory (AD-025; the §1.6a/§1.9 reach to CUSTOMIZED filled slots): a slot
// that is present + FILLED but lacks the descriptor's current-canon `upgradeSignature` (and so could not
// be canonical-refreshed — its content is customized) gets a one-line note the upgrade flow surfaces.
// Returns null for an absent / empty / malformed slot, or one that already carries the signature. Pure;
// never edits the file (a customization is never rewritten — only the user decides).
export const markerSlotUpgradeHint = (text, descriptor) => {
  if (!descriptor.upgradeSignature) return null;
  const content = extractMarkerSlot(text, descriptor);
  if (content == null || content.trim() === '') return null; // only a FILLED slot
  if (content.includes(descriptor.upgradeSignature)) return null; // already carries the current clause
  return descriptor.upgradeAdvice;
};

// A cap-refusal is a SOFT, reported skip (distinct from a malformed/anchor STOP) — keyed off the
// stable "(cap N)" substring both cap messages carry, so the dual-slot reconcile can skip the
// orchestration pointer (loud) while keeping the methodology fill, instead of aborting both.
const isCapRefusal = (errorMessage) => typeof errorMessage === 'string' && errorMessage.includes('(cap ');
// The autonomy lane distinguishes the TWO cap messages "(cap " conflates (D4 cap-lane honesty):
// only a FILL-overflow from an in-cap input (injectIntoSlot's "injection would push …") is the soft
// skip — the pointer was genuinely withheld. An ALREADY-over-cap custom file (reconcileMarkerSlot's
// "AGENTS.md is N lines … trim the file") keeps its distinct over-cap report as a hard refusal,
// never a mislabeled "skipped". Exported so the split is pinned against the real messages.
export const isFillCapRefusal = (errorMessage) =>
  isCapRefusal(errorMessage) && errorMessage.includes('injection would push');

const main = async (argv) => {
  const { readFile, writeFile, rename, rm } = await import('node:fs/promises');
  const { dirname, basename, join, resolve } = await import('node:path');
  const { homedir } = await import('node:os');
  const { resolveEngineDir, readEngineFragment, detectEngine, ENGINE_FRAGMENT_REL, ORCHESTRATION_FRAGMENT_REL, AUTONOMY_FRAGMENT_REL } = await import('./engine-source.mjs');

  // `reconcile <AGENTS.md> [fragment.md]` = ensure-slot + inject-if-empty + cap (bootstrap/upgrade) for
  // ALL THREE slots; `<AGENTS.md> [fragment.md]` = the legacy inject-into-existing-(methodology)-slot mode.
  const mode = argv[0] === 'reconcile' ? 'reconcile' : 'inject';
  const rest = mode === 'reconcile' ? argv.slice(1) : argv;
  const agentsPath = rest[0];
  if (!agentsPath) {
    console.error('usage: inject-methodology.mjs [reconcile] <path/to/AGENTS.md> [fragment.md]');
    process.exit(2);
  }
  const explicitFragmentArg = rest[1];
  const text = await readFile(resolve(agentsPath), 'utf8');

  // Source a bounded fragment LAZILY, per slot. An explicit [fragment.md] arg (tests + manual) wins and
  // skips engine resolution entirely; it binds the METHODOLOGY slot only. Otherwise read it LIVE from
  // the installed engine (no bundled mirror) — readEngineFragment THROWS (never falls back) when the
  // engine is needed but absent/invalid; sourceFragmentOrStop turns that into a hard, loud STOP carrying
  // the install command. The caller only invokes this when a fill is actually needed (the laziness).
  const sourceFragment = async (rel) => {
    if (explicitFragmentArg) return readFile(resolve(explicitFragmentArg), 'utf8');
    const { dir, source } = resolveEngineDir({ env: process.env, home: homedir() });
    return readEngineFragment(dir, { source, rel }); // sync; throws loudly when the engine is absent/invalid
  };
  const sourceFragmentOrStop = async (label, rel) => {
    try {
      return await sourceFragment(rel);
    } catch (err) {
      // Engine needed-but-absent → a hard STOP, distinct from the soft cap-skip. The "methodology
      // engine not found/invalid" prefix lets the agent classify this exit (SKILL.md).
      console.error(`[inject-methodology] ${label} — ${err.message}`);
      process.exit(1);
    }
  };

  // The orchestration + autonomy fragments are the CHAINED (less-critical) pointers. Source each
  // lazily, but DISTINGUISH two failures keyed off the engine's own detection (not message text): an
  // engine that is VALID but simply TOO OLD to ship the requested fragment is a SOFT skip — the prior
  // fills are kept and the pointer is reported as withheld (parallel to the cap-skip); only a FULLY
  // absent/invalid engine (it cannot supply ANY pointer) is a hard STOP. A read error on a PRESENT
  // fragment is a real corruption STOP, NEVER a "too old" skip (don't mislabel a current engine with
  // an unreadable fragment). Returns { fragment } on success, { skip } for the soft case, or
  // process.exit(1) for the hard STOP.
  const sourceChainedFragment = async (rel) => {
    const { dir, source } = resolveEngineDir({ env: process.env, home: homedir() });
    const stop = (err) => {
      console.error(`[inject-methodology] reconcile STOP — ${err.message}`);
      process.exit(1);
    };
    if (detectEngine(dir, { source, rel }).ok) {
      try {
        return { fragment: readEngineFragment(dir, { source, rel }) };
      } catch (err) {
        stop(err);
      }
    }
    if (detectEngine(dir, { source }).ok) {
      return { skip: 'the installed engine is too old to supply it — refresh with `npx @sabaiway/agent-workflow-engine@latest init`' };
    }
    try {
      readEngineFragment(dir, { source, rel }); // throws the canonical install-me error
    } catch (err) {
      stop(err);
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
    // ── Slot 1: methodology (lazy engine read, then reconcile) ──
    const methFragment = slotNeedsFill(text) ? await sourceFragmentOrStop('reconcile STOP', ENGINE_FRAGMENT_REL) : '';
    const methResult = reconcileSlot(text, methFragment, { maxLines: AGENTS_MD_CAP });
    if (methResult.status === 'error') {
      // cap-refusal OR malformed/anchor STOP — preserve the single-slot classification (SKILL.md
      // distinguishes by the message); the file is byte-for-byte unchanged either way.
      console.error(`[inject-methodology] reconcile refused — ${methResult.error}`);
      process.exit(1);
    }
    const afterMeth = methResult.text; // === text when the methodology slot was already filled (custom)
    const describeMeth = {
      'reconciled-inserted': 'inserted the workflow-methodology pointer at the Session-Protocols anchor and filled it',
      'reconciled-filled': 'filled the empty workflow-methodology pointer',
      'reconciled-refreshed': 'refreshed the workflow-methodology pointer to the current canon',
      'present-filled': 'workflow-methodology pointer already present',
    }[methResult.status];
    // Read-only upgrade advisories for a CUSTOMIZED methodology pointer that reconcile preserved verbatim
    // (a refreshed/filled/inserted slot already carries the current canon, so it gets none): the AD-019
    // procedures route AND the §1.9 communication-contract clause. No mutation — reported notes only.
    const notes = [];
    if (methResult.status === 'present-filled') {
      const p = methodologyProceduresHint(afterMeth); if (p) notes.push(p);
      const u = markerSlotUpgradeHint(afterMeth, METHODOLOGY_DESCRIPTOR); if (u) notes.push(u);
    }
    const reportNotes = () => {
      for (const n of notes) console.log(`[inject-methodology] note: ${n}`);
    };

    // ── Explicit [fragment.md] binds methodology ONLY → skip the orchestration + autonomy reconciles ──
    if (explicitFragmentArg) {
      if (afterMeth === text) {
        console.log('[inject-methodology] methodology slot already present and filled — nothing to do (zero-diff).');
        return;
      }
      await writeAtomic(afterMeth);
      console.log(`[inject-methodology] reconcile: ${describeMeth}.`);
      return;
    }

    // ── Slot 2: orchestration, reconciled on the methodology-reconciled text (the cap-check then guards
    //    the COMBINED ≤100). Lazy: the engine is read only when the orchestration slot needs filling. ──
    let finalText = afterMeth;
    let describeOrch;
    let orchSkipped = false;

    const orchSource = markerSlotNeedsFill(afterMeth, ORCHESTRATION_DESCRIPTOR)
      ? await sourceChainedFragment(ORCHESTRATION_FRAGMENT_REL)
      : { fragment: '' };
    if (orchSource.skip) {
      // Engine too old to supply the recipes pointer → SOFT skip, parallel to the cap-skip: the
      // methodology fill is preserved and written; the recipes pointer is reported as withheld.
      orchSkipped = true;
      describeOrch = `orchestration-recipes pointer skipped — ${orchSource.skip}`;
    } else {
      const orchResult = reconcileMarkerSlot(afterMeth, ORCHESTRATION_DESCRIPTOR, orchSource.fragment, { maxLines: AGENTS_MD_CAP });
      if (orchResult.status === 'error') {
        if (isCapRefusal(orchResult.error)) {
          // SOFT skip — keep the methodology result, report the orchestration cap-skip loudly (not
          // silent). The methodology fill (if any) is preserved; the orchestration pointer is not added.
          orchSkipped = true;
          describeOrch = `orchestration-recipes pointer skipped — ${orchResult.error}`;
        } else {
          // Malformed orchestration slot/anchor → a hard STOP. No partial write.
          console.error(`[inject-methodology] reconcile refused (orchestration) — ${orchResult.error}`);
          process.exit(1);
        }
      } else {
        finalText = orchResult.text;
        describeOrch = {
          'reconciled-inserted': 'inserted the orchestration-recipes pointer below it and filled it',
          'reconciled-filled': 'filled the empty orchestration-recipes pointer',
          'reconciled-refreshed': 'refreshed the orchestration-recipes pointer to the current canon',
          'present-filled': 'orchestration-recipes pointer already present',
        }[orchResult.status];
        // §1.6a advisory: a CUSTOMIZED orchestration pointer preserved verbatim, lacking the read-at-start
        // clause, gets a read-only nudge (a refreshed/filled slot already carries it).
        if (orchResult.status === 'present-filled') {
          const u = markerSlotUpgradeHint(finalText, ORCHESTRATION_DESCRIPTOR);
          if (u) notes.push(u);
        }
      }
    }

    // ── Slot 3: autonomy, chained on the orchestration-reconciled text (same combined ≤100 guard).
    //    D4 invariant: every failure lane SPECIFIC to this slot is a LOUD soft skip that preserves
    //    the prior fills and exits 0 — (i) a too-old engine (no autonomy fragment), (ii) a
    //    fill-overflow cap refusal, (iii) an ABSENT anchor (the orchestration pair is absent or was
    //    itself skipped above — a 0-anchors ensure error must not discard the methodology fill).
    //    Malformed autonomy markers, an already-over-cap custom file, a present-but-unreadable
    //    fragment, and a fully absent/invalid engine stay hard STOPs. ──
    let describeAut;
    let autSkipped = false;
    const autSlot = findMarkerSlot(finalText, AUTONOMY_DESCRIPTOR);
    if (autSlot.state === 'malformed') {
      // Malformed markers are a hard STOP on EVERY lane — validated before the soft-skip
      // short-circuits so a duplicate/reversed autonomy pair can never ride out as a "skip"
      // alongside a partial (methodology) write.
      console.error(`[inject-methodology] reconcile refused (autonomy) — ${autSlot.reason}`);
      process.exit(1);
    }
    if (orchSkipped) {
      // The chain is CAUSAL, not merely positional: a pointer never lands in a run that withheld
      // the pointer it chains below (cap or too-old) — otherwise a partially-shipped engine could
      // fill autonomy under an unfilled recipes pointer, and a near-cap file could spend its last
      // lines on the less-critical pointer. LOUD soft skip. This branch also subsumes the D4 (iii)
      // anchor-absent lane: after a non-skipped orchestration reconcile the orchestration pair —
      // the autonomy anchor — is present by construction, so orchSkipped is the ONLY route to a
      // missing anchor (a separate anchor check would be dead code; coverage proved it).
      autSkipped = true;
      describeAut =
        'autonomy pointer skipped — chained below the orchestration pointer, which was itself skipped this run; re-run once it lands';
    } else {
      const autSource = markerSlotNeedsFill(finalText, AUTONOMY_DESCRIPTOR)
        ? await sourceChainedFragment(AUTONOMY_FRAGMENT_REL)
        : { fragment: '' };
      if (autSource.skip) {
        autSkipped = true;
        describeAut = `autonomy pointer skipped — ${autSource.skip}`;
      } else {
        const autResult = reconcileMarkerSlot(finalText, AUTONOMY_DESCRIPTOR, autSource.fragment, { maxLines: AGENTS_MD_CAP });
        if (autResult.status === 'error') {
          if (isFillCapRefusal(autResult.error)) {
            // SOFT skip — only the genuine fill-overflow withholds the pointer; an already-over-cap
            // custom file keeps its distinct over-cap report via the hard-STOP branch below.
            autSkipped = true;
            describeAut = `autonomy pointer skipped — ${autResult.error}`;
          } else {
            console.error(`[inject-methodology] reconcile refused (autonomy) — ${autResult.error}`);
            process.exit(1);
          }
        } else {
          finalText = autResult.text;
          describeAut = {
            'reconciled-inserted': 'inserted the autonomy pointer below it and filled it',
            'reconciled-filled': 'filled the empty autonomy pointer',
            'reconciled-refreshed': 'refreshed the autonomy pointer to the current canon',
            'present-filled': 'autonomy pointer already present',
          }[autResult.status];
          if (autResult.status === 'present-filled') {
            const u = markerSlotUpgradeHint(finalText, AUTONOMY_DESCRIPTOR);
            if (u) notes.push(u);
          }
        }
      }
    }

    // ── One atomic write of the final (three-slot) text ──
    if (finalText === text) {
      // Byte-unchanged. Still report a skip (it is not "nothing to do" — a pointer was withheld).
      if (orchSkipped || autSkipped) console.log(`[inject-methodology] reconcile: ${describeMeth}; ${describeOrch}; ${describeAut}.`);
      else console.log('[inject-methodology] reconcile: all three pointers already present and filled — nothing to do (zero-diff).');
      reportNotes();
      return;
    }
    await writeAtomic(finalText);
    console.log(`[inject-methodology] reconcile: ${describeMeth}; ${describeOrch}; ${describeAut}.`);
    reportNotes();
    return;
  }

  // Legacy inject-into-existing-slot mode (METHODOLOGY only). injectMethodology no-ops on absent markers
  // and errors on a malformed slot WITHOUT reading the fragment, so resolve+read the engine only when
  // there is a present (ok) slot to fill — a markerless legacy AGENTS.md stays a no-op without the engine.
  const fragment = findSlot(text).state === 'ok' ? await sourceFragmentOrStop('STOP', ENGINE_FRAGMENT_REL) : '';
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
