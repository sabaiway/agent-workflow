#!/usr/bin/env node
// Marker-slot injection + reconciliation — the composition root's only mutation of a deployed
// AGENTS.md. A deployed entry point carries THREE reconciled marker slots, each filled LIVE from the
// installed agent-workflow-engine (the family's one source of truth, no bundled mirror):
//   1. workflow:methodology  — the plan→execute→review pointer (references/methodology-slot.md).
//   2. workflow:orchestration — the recipe-vocabulary pointer  (references/orchestration-slot.md).
//   3. workflow:autonomy     — the autonomy-policy read contract (references/autonomy-slot.md).
//
// All share ONE generic marker engine (a slot DESCRIPTOR parameterizes the markers / anchor / empty-slot
// / leading-blank); the methodology exports delegate to it byte-for-byte. After the three slots,
// reconcile keeps one Memory Map row per project-rules theme (project-rules/memory-map-row.mjs).
//
// Contract per slot, strictly enforced:
//   exactly one ordered start→end pair → replace only the bytes between them;
//   markers absent → ensure-insert an empty pair at the slot's anchor (or NO-OP in legacy inject);
//   any malformed state (single, reversed, nested, duplicate) → NO-OP WITH AN ERROR, never edit.
// The live read is fail-loud: the engine is read for every slot the ensure can place (a filled slot
// cannot be judged without its fragment), and a needed-but-absent/invalid engine is a loud STOP.
// Pure string functions (testable with byte-preservation fixtures); dependency-free, Node >= 22.
//
// The policy per slot (entry-pointers revision 1): content equal to the fragment is left, a KNOWN PRIOR
// canonical fragment (drift-guarded, append-only per descriptor) is refreshed, and any other content is
// written current with no question and no copy kept. Contract: docs/ai/specs/kit/install/entry-pointers.md.

import { isDirectRun } from './direct-run.mjs';
import { normalizeCanonical } from './orchestration-config.mjs';
import { reconcileMemoryMapRows, ROW_ROUTE } from './project-rules/index.mjs';

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
// reconcileMarkerSlot words a filled slot's write as a refresh IFF its content normalize-matches one of
// these. Any release that CHANGES an engine fragment must FIRST append the
// OUTGOING content here, so the immediately-previous deployments still match (a drift-guard test pins
// current-minus-one → new). NEVER edit an existing entry — only append.
export const KNOWN_PRIOR_METHODOLOGY_SLOT = [
  // v1.3.0 — pre-communication-contract methodology pointer (procedures route, no §1.9 clause).
  '> **Workflow methodology** — plan → execute → review. Plans are ephemeral `docs/plans/*.md` (gitignored, **never committed**); every Plan ends with a mandatory **Phase: Cleanup**; series order lives in `docs/plans/queue.md`. Full vocabulary, lifecycle, and the plan-then-execute split live in the project\'s **planning skill** (it overrides the generic `writing-plans`); summary in `docs/ai/agent_rules.md` §5. Named activities (plan-authoring, plan-execution) have procedures — see `/agent-workflow-kit procedures <activity>` for the steps + resolved recipe.',
  // engine 2.1.0 — the pre-canon-rewrite pointer (vocabulary + plan-then-execute wording, with the communication contract).
  '> **Workflow methodology** — plan → execute → review. Plans are ephemeral `docs/plans/*.md` (gitignored, **never committed**); every Plan ends with a mandatory **Phase: Cleanup**; series order lives in `docs/plans/queue.md`. Full vocabulary, lifecycle, and the plan-then-execute split live in the project\'s **planning skill** (it overrides the generic `writing-plans`); summary in `docs/ai/agent_rules.md` §5. Named activities (plan-authoring, plan-execution) have procedures — see `/agent-workflow-kit procedures <activity>` for the steps + resolved recipe. **Communication:** user-facing messages deliver the artifact inline (paste the prompt / diff / command — never "see §X" as a substitute), lead with the result, show exactly what was asked, and never read as mockery (a large artifact: a real summary inline + a link).',
  // engine 4.2.0 — the two-activity pointer, before `routine` joined the named activities.
  '> **Workflow methodology** — plan → execute → review. Plans are ephemeral `docs/plans/*.md` (gitignored, **never committed**); every Plan ends with a mandatory **Phase: Cleanup**; series order lives in `docs/plans/queue.md`. The plan shape, its caps and lifecycle live in the project\'s **planning skill** (it overrides the generic `writing-plans`); summary in `docs/ai/agent_rules.md` §5. Named activities (plan-authoring, plan-execution) have procedures — see `/agent-workflow-kit procedures <activity>` for the steps + resolved recipe. **Communication:** user-facing messages deliver the artifact inline (paste the prompt / diff / command — never "see §X" as a substitute), lead with the result, show exactly what was asked, and never read as mockery (a large artifact: a real summary inline + a link).',
  // engine 4.6.0 — the three-activity pointer, before feedback-triage joined the named activities.
  '> **Workflow methodology** — plan → execute → review. Plans are ephemeral `docs/plans/*.md` (gitignored, **never committed**); every Plan ends with a mandatory **Phase: Cleanup**; series order lives in `docs/plans/queue.md`. The plan shape, its caps and lifecycle live in the project\'s **planning skill** (it overrides the generic `writing-plans`); summary in `docs/ai/agent_rules.md` §5. Named activities (plan-authoring, plan-execution, routine) have procedures — see `/agent-workflow-kit procedures <activity>` for the steps + resolved recipe. **Communication:** user-facing messages deliver the artifact inline (paste the prompt / diff / command — never "see §X" as a substitute), lead with the result, show exactly what was asked, and never read as mockery (a large artifact: a real summary inline + a link).',
  // engine 5.7.0 — the four-activity pointer, before epic and task joined the named activities.
  '> **Workflow methodology** — plan → execute → review. Plans are ephemeral `docs/plans/*.md` (gitignored, **never committed**); every Plan ends with a mandatory **Phase: Cleanup**; series order lives in `docs/plans/queue.md`. The plan shape, its caps and lifecycle live in the project\'s **planning skill** (it overrides the generic `writing-plans`); summary in `docs/ai/agent_rules.md` §5. Named activities (plan-authoring, plan-execution, routine, feedback-triage) have procedures — see `/agent-workflow-kit procedures <activity>` for the steps + resolved recipe. **Communication:** user-facing messages deliver the artifact inline (paste the prompt / diff / command — never "see §X" as a substitute), lead with the result, show exactly what was asked, and never read as mockery (a large artifact: a real summary inline + a link).',
];
export const KNOWN_PRIOR_ORCH_SLOT = [
  // v1.3.0 — pre-read-at-start orchestration pointer (recipes vocabulary, no orchestration.json clause).
  '> **Orchestration recipes** — compose plan → execute → review with a named recipe: **Solo** (no backend), **Reviewed** (one backend reviews), **Council** (both review, you synthesize), **Delegated** (a backend executes a bounded sub-task); the orchestrator always commits, a backend is never autonomous. Pick + plan one for this environment with `/agent-workflow-kit recipes` (read-only); the deployed how/why lives in your `docs/ai/` workflow docs.',
  // engine 4.2.0 — the four-recipe pointer with the read-at-start clause, before the Subagent carrier joined the list.
  '> **Orchestration recipes** — compose plan → execute → review with a named recipe: **Solo** (no backend), **Reviewed** (one backend reviews), **Council** (both review, you synthesize), **Delegated** (a backend executes a bounded sub-task); the orchestrator always commits, a backend is never autonomous. Pick + plan one for this environment with `/agent-workflow-kit recipes` (read-only); the deployed how/why lives in your `docs/ai/` workflow docs. At the start of a planning/execution session, read your standing recipe preference in `docs/ai/orchestration.json` — set it in plain language with `/agent-workflow-kit set-recipe` (previews first; hand-edit stays supported).',
];

// A slot descriptor bundles everything the generic engine needs to operate on ONE marker pair.
// `leadingBlank` controls whether the inserted empty pair gets a blank separator line above it — the
// methodology insert keeps it (readability), the orchestration insert omits it to save a cap line
// (the pair already sits right under the methodology block). `knownPriorCanonicals` words the refresh;
// `label` names the pointer in the reconcile line and the over-cap error.
export const METHODOLOGY_DESCRIPTOR = {
  startMarker: START_MARKER,
  endMarker: END_MARKER,
  anchor: METHODOLOGY_ANCHOR,
  emptySlot: EMPTY_SLOT,
  leadingBlank: true,
  markerName: 'methodology',
  label: 'workflow-methodology',
  anchorLabel: 'methodology anchor (the "Read it before any code change." Session-Protocols line)',
  knownPriorCanonicals: KNOWN_PRIOR_METHODOLOGY_SLOT,
};
export const ORCHESTRATION_DESCRIPTOR = {
  startMarker: ORCH_START_MARKER,
  endMarker: ORCH_END_MARKER,
  anchor: ORCH_ANCHOR,
  emptySlot: ORCH_EMPTY_SLOT,
  leadingBlank: false,
  markerName: 'orchestration',
  label: 'orchestration-recipes',
  anchorLabel: 'orchestration anchor (the methodology end-marker line)',
  knownPriorCanonicals: KNOWN_PRIOR_ORCH_SLOT,
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
  label: 'autonomy',
  anchorLabel: 'autonomy anchor (the orchestration end-marker line)',
  knownPriorCanonicals: [],
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

// Bootstrap/upgrade reconciliation policy (pure): ensure the slot exists, then judge the bytes between
// its markers against `fragment`, enforcing the line cap — all as one step the CLI commits with a single
// atomic write. On ANY error the INPUT bytes are returned unchanged.
//   reconciled-inserted  — slot was absent, inserted at the anchor, then filled.
//   reconciled-filled    — slot existed but was empty, now filled.
//   reconciled-refreshed — slot was filled with a KNOWN PRIOR canonical → replaced with `fragment`.
//   reconciled-written   — slot held any other content → replaced with `fragment`.
//   present-filled       — slot already carries `fragment` → left, bytes unchanged.
//   error                — malformed slot, 0/>1 anchors, a blank fragment, or cap exceeded → input unchanged.
export const reconcileMarkerSlot = (text, descriptor, fragment, { maxLines } = {}) => {
  const ensured = ensureMarkerSlot(text, descriptor);
  if (ensured.status === 'error') return { status: 'error', text, error: ensured.error };
  if (fragment.trim() === '') return { status: 'error', text, error: `the ${descriptor.label} fragment is blank — refusing to write an empty pointer` };
  const current = extractMarkerSlot(ensured.text, descriptor);
  let status = ensured.status === 'inserted' ? 'reconciled-inserted' : 'reconciled-filled';
  if (current.trim() !== '') {
    if (normalizeCanonical(current) === normalizeCanonical(fragment)) {
      if (maxLines != null && lineCount(ensured.text) > maxLines) {
        return { status: 'error', text, error: `AGENTS.md is ${lineCount(ensured.text)} lines (cap ${maxLines}) — trim the file (the current ${descriptor.label} pointer must still fit the cap)` };
      }
      return { status: 'present-filled', text: ensured.text };
    }
    const priors = descriptor.knownPriorCanonicals ?? [];
    status = priors.some((p) => normalizeCanonical(p) === normalizeCanonical(current)) ? 'reconciled-refreshed' : 'reconciled-written';
  }
  const injected = injectIntoSlot(ensured.text, descriptor, fragment, { maxLines });
  if (injected.status !== 'injected') return { status: 'error', text, error: injected.error };
  return { status, text: injected.text };
};

// Pure predicate (no fs): can the ensure place this slot (present or insertable)? Every such slot is
// judged against its fragment, so main() reads the engine exactly when this is true. Reuses the SAME
// ensure as reconcileMarkerSlot, so the engine-read guard cannot diverge from the policy.
export const markerSlotEnsurable = (text, descriptor) => ensureMarkerSlot(text, descriptor).status !== 'error';

// ── methodology-slot exports (delegate to the generic engine, byte-for-byte) ────

export const findSlot = (text) => findMarkerSlot(text, METHODOLOGY_DESCRIPTOR);
export const injectMethodology = (text, fragment, opts) => injectIntoSlot(text, METHODOLOGY_DESCRIPTOR, fragment, opts);
export const extractSlot = (text) => extractMarkerSlot(text, METHODOLOGY_DESCRIPTOR);
export const ensureSlot = (text) => ensureMarkerSlot(text, METHODOLOGY_DESCRIPTOR);
export const reconcileSlot = (text, fragment, opts) => reconcileMarkerSlot(text, METHODOLOGY_DESCRIPTOR, fragment, opts);

// The route the reconcile's pointer note names when it wrote a pointer over a different one.
export const POINTER_ROUTE = 'text of your own goes outside the two <!-- workflow: --> comment lines around each pointer';

// A cap-refusal is a SOFT, reported skip (distinct from a malformed/anchor STOP) — keyed off the
// stable "(cap N)" substring both cap messages carry, so the dual-slot reconcile can skip the
// orchestration pointer (loud) while keeping the methodology fill, instead of aborting both.
const isCapRefusal = (errorMessage) => typeof errorMessage === 'string' && errorMessage.includes('(cap ');
// The autonomy lane distinguishes the TWO cap messages "(cap " conflates (D4 cap-lane honesty):
// only a FILL-overflow from an in-cap input (injectIntoSlot's "injection would push …") is the soft
// skip — the pointer was genuinely withheld. An ALREADY-over-cap file (reconcileMarkerSlot's
// "AGENTS.md is N lines … trim the file") keeps its distinct over-cap report as a hard refusal,
// never a mislabeled "skipped". Exported so the split is pinned against the real messages.
export const isFillCapRefusal = (errorMessage) =>
  isCapRefusal(errorMessage) && errorMessage.includes('injection would push');

const EXIT = Symbol('inject-methodology.exit');
const ROW_WORDS = { inserted: 'added', kept: 'already present', refreshed: 'refreshed to the current text', written: 'written with the current text' };
// The reconcile line's clause for a judged slot, by its status.
const describeSlot = (descriptor, status) => {
  const pointer = `${descriptor.label} pointer`;
  const where = descriptor === METHODOLOGY_DESCRIPTOR ? 'at the Session-Protocols anchor' : 'below it';
  return {
    'reconciled-inserted': `inserted the ${pointer} ${where} and filled it`,
    'reconciled-filled': `filled the empty ${pointer}`,
    'reconciled-refreshed': `refreshed the ${pointer} to the current canon`,
    'reconciled-written': `wrote the current ${pointer} over a different one`,
    'present-filled': `${pointer} already present`,
  }[status];
};

// The return-code entry point (5.1): argv[] + injected env/home → { code, stdout, stderr }, no
// process.argv / process.exit / console inside — an in-process caller is as hermetic as a spawned
// one. The thin shell at the bottom is the only process-coupled code.
export const runCli = async (argv, deps = {}) => {
  const { readFile, writeFile, rename, rm } = await import('node:fs/promises');
  const { dirname, basename, join, resolve } = await import('node:path');
  const { homedir } = await import('node:os');
  const { resolveEngineDir, readEngineFragment, detectEngine, ENGINE_FRAGMENT_REL, ORCHESTRATION_FRAGMENT_REL, AUTONOMY_FRAGMENT_REL } = await import('./engine-source.mjs');
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();

  const stdoutLines = [];
  const stderrLines = [];
  const log = (line) => stdoutLines.push(line);
  const logError = (line) => stderrLines.push(line);
  const result = (code) => ({
    code,
    stdout: stdoutLines.length > 0 ? `${stdoutLines.join('\n')}\n` : '',
    stderr: stderrLines.length > 0 ? `${stderrLines.join('\n')}\n` : '',
  });
  // Nested sourcing helpers end the run from arbitrary depth — a tagged throw the catch below
  // translates into the result code (the process.exit of the pre-entry-point CLI).
  const stop = (code) => Object.assign(new Error(`exit ${code}`), { [EXIT]: code });

  // `reconcile <AGENTS.md> [fragment.md]` = ensure-slot + inject-if-empty + cap (bootstrap/upgrade) for
  // ALL THREE slots; `<AGENTS.md> [fragment.md]` = the legacy inject-into-existing-(methodology)-slot mode.
  const mode = argv[0] === 'reconcile' ? 'reconcile' : 'inject';
  const rest = mode === 'reconcile' ? argv.slice(1) : argv;
  const agentsPath = rest[0];
  if (!agentsPath) {
    logError('usage: inject-methodology.mjs [reconcile] <path/to/AGENTS.md> [fragment.md]');
    return result(2);
  }
  const explicitFragmentArg = rest[1];
  try {
  const text = await readFile(resolve(agentsPath), 'utf8');

  // Source a bounded fragment per slot. An explicit [fragment.md] arg (tests + manual) wins and skips
  // engine resolution entirely; it binds the METHODOLOGY slot only. Otherwise read it LIVE from the
  // installed engine (no bundled mirror) — readEngineFragment THROWS (never falls back) when the engine
  // is needed but absent/invalid; sourceFragmentOrStop turns that into a hard, loud STOP carrying the
  // install command. The caller invokes this for every slot the ensure can place.
  const sourceFragment = async (rel) => {
    if (explicitFragmentArg) return readFile(resolve(explicitFragmentArg), 'utf8');
    const { dir, source } = resolveEngineDir({ env, home });
    return readEngineFragment(dir, { source, rel }); // sync; throws loudly when the engine is absent/invalid
  };
  const sourceFragmentOrStop = async (label, rel) => {
    try {
      return await sourceFragment(rel);
    } catch (err) {
      // Engine needed-but-absent → a hard STOP, distinct from the soft cap-skip. The "methodology
      // engine not found/invalid" prefix lets the agent classify this exit (SKILL.md).
      logError(`[inject-methodology] ${label} — ${err.message}`);
      throw stop(1);
    }
  };

  // The orchestration + autonomy fragments are the CHAINED (less-critical) pointers. Source each, but
  // DISTINGUISH two failures keyed off the engine's own detection (not message text): an engine that
  // is VALID but simply TOO OLD to ship the requested fragment is a SOFT skip — the earlier slots'
  // results are written and the pointer is reported as withheld (parallel to the cap-skip); only a FULLY
  // absent/invalid engine (it cannot supply ANY pointer) is a hard STOP. A read error on a PRESENT
  // fragment is a real corruption STOP, NEVER a "too old" skip (don't mislabel a current engine with
  // an unreadable fragment). Returns { fragment } on success, { skip } for the soft case, or
  // process.exit(1) for the hard STOP.
  const sourceChainedFragment = async (rel) => {
    const { dir, source } = resolveEngineDir({ env, home });
    const chainedStop = (err) => {
      logError(`[inject-methodology] reconcile STOP — ${err.message}`);
      throw stop(1);
    };
    if (detectEngine(dir, { source, rel }).ok) {
      try {
        return { fragment: readEngineFragment(dir, { source, rel }) };
      } catch (err) {
        chainedStop(err);
      }
    }
    if (detectEngine(dir, { source }).ok) {
      return { skip: 'the installed engine is too old to supply it — refresh with `npx @sabaiway/agent-workflow-engine@latest init`' };
    }
    try {
      readEngineFragment(dir, { source, rel }); // throws the canonical install-me error
    } catch (err) {
      chainedStop(err);
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
    // ── Slot 1: methodology (the engine read for a slot the ensure can place, then reconcile) ──
    const methFragment = markerSlotEnsurable(text, METHODOLOGY_DESCRIPTOR) ? await sourceFragmentOrStop('reconcile STOP', ENGINE_FRAGMENT_REL) : '';
    const methResult = reconcileSlot(text, methFragment, { maxLines: AGENTS_MD_CAP });
    if (methResult.status === 'error') {
      // cap-refusal OR malformed/anchor STOP — preserve the single-slot classification (SKILL.md
      // distinguishes by the message); the file is byte-for-byte unchanged either way.
      logError(`[inject-methodology] reconcile refused — ${methResult.error}`);
      return result(1);
    }
    const afterMeth = methResult.text; // === text when the methodology slot was already current
    const describeMeth = describeSlot(METHODOLOGY_DESCRIPTOR, methResult.status);
    // One pointer note when a pointer was written over a different one; the row note follows it.
    let pointerWritten = methResult.status === 'reconciled-written';
    const reportNotes = (rowWritten = false) => {
      if (pointerWritten) log(`[inject-methodology] note: ${POINTER_ROUTE}.`);
      if (rowWritten) log(`[inject-methodology] note: ${ROW_ROUTE}.`);
    };

    // ── Explicit [fragment.md] binds methodology ONLY → skip the orchestration + autonomy reconciles ──
    if (explicitFragmentArg) {
      if (afterMeth === text) {
        log('[inject-methodology] methodology slot already present and filled — nothing to do (zero-diff).');
        return result(0);
      }
      await writeAtomic(afterMeth);
      log(`[inject-methodology] reconcile: ${describeMeth}.`);
      reportNotes();
      return result(0);
    }

    // ── Slot 2: orchestration, reconciled on the methodology-reconciled text (the cap-check then guards
    //    the COMBINED ≤100). The engine is read whenever the ensure can place the slot. ──
    let finalText = afterMeth;
    let describeOrch;
    let orchSkipped = false;

    const orchSource = markerSlotEnsurable(afterMeth, ORCHESTRATION_DESCRIPTOR)
      ? await sourceChainedFragment(ORCHESTRATION_FRAGMENT_REL)
      : { fragment: '' };
    if (orchSource.skip) {
      // Engine too old to supply the recipes pointer → SOFT skip, parallel to the cap-skip: the
      // methodology result is written; the recipes pointer is reported as withheld.
      orchSkipped = true;
      describeOrch = `orchestration-recipes pointer skipped — ${orchSource.skip}`;
    } else {
      const orchResult = reconcileMarkerSlot(afterMeth, ORCHESTRATION_DESCRIPTOR, orchSource.fragment, { maxLines: AGENTS_MD_CAP });
      if (orchResult.status === 'error') {
        if (isCapRefusal(orchResult.error)) {
          // SOFT skip — keep the methodology result, report the orchestration cap-skip loudly (not
          // silent); the orchestration slot is unchanged.
          orchSkipped = true;
          describeOrch = `orchestration-recipes pointer skipped — ${orchResult.error}`;
        } else {
          // Malformed orchestration slot/anchor → a hard STOP. No partial write.
          logError(`[inject-methodology] reconcile refused (orchestration) — ${orchResult.error}`);
          return result(1);
        }
      } else {
        finalText = orchResult.text;
        describeOrch = describeSlot(ORCHESTRATION_DESCRIPTOR, orchResult.status);
        pointerWritten ||= orchResult.status === 'reconciled-written';
      }
    }

    // ── Slot 3: autonomy, chained on the orchestration-reconciled text (same combined ≤100 guard).
    //    D4 invariant: every failure lane SPECIFIC to this slot is a LOUD soft skip that writes the
    //    earlier slots' results and exits 0 — (i) a too-old engine (no autonomy fragment), (ii) a
    //    fill-overflow cap refusal, (iii) an ABSENT anchor (the orchestration pair is absent or was
    //    itself skipped above — a 0-anchors ensure error must not discard the methodology result).
    //    Malformed autonomy markers, an already-over-cap file, a present-but-unreadable
    //    fragment, and a fully absent/invalid engine stay hard STOPs. ──
    let describeAut;
    let autSkipped = false;
    const autSlot = findMarkerSlot(finalText, AUTONOMY_DESCRIPTOR);
    if (autSlot.state === 'malformed') {
      // Malformed markers are a hard STOP on EVERY lane — validated before the soft-skip
      // short-circuits so a duplicate/reversed autonomy pair can never ride out as a "skip"
      // alongside a partial (methodology) write.
      logError(`[inject-methodology] reconcile refused (autonomy) — ${autSlot.reason}`);
      return result(1);
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
      const autSource = markerSlotEnsurable(finalText, AUTONOMY_DESCRIPTOR)
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
            // file keeps its distinct over-cap report via the hard-STOP branch below.
            autSkipped = true;
            describeAut = `autonomy pointer skipped — ${autResult.error}`;
          } else {
            logError(`[inject-methodology] reconcile refused (autonomy) — ${autResult.error}`);
            return result(1);
          }
        } else {
          finalText = autResult.text;
          describeAut = describeSlot(AUTONOMY_DESCRIPTOR, autResult.status);
          pointerWritten ||= autResult.status === 'reconciled-written';
        }
      }
    }

    // ── The Memory Map rows on the three-slot text, then one atomic write ──
    const rows = reconcileMemoryMapRows(finalText, { maxLines: AGENTS_MD_CAP });
    const describeRows = rows.outcomes.map((o) => `the ${o.theme} Memory Map row ${ROW_WORDS[o.status] ?? `skipped — ${o.note}`}`).join('; ');
    const rowWritten = rows.outcomes.some((o) => o.status === 'written');
    if (rows.text === text) {
      // Byte-unchanged. Still report a skip (it is not "nothing to do" — a pointer was withheld).
      if (orchSkipped || autSkipped) log(`[inject-methodology] reconcile: ${describeMeth}; ${describeOrch}; ${describeAut}; ${describeRows}.`);
      else log(`[inject-methodology] reconcile: all three pointers already present and filled; ${describeRows} — nothing to do (zero-diff).`);
      return result(0);
    }
    await writeAtomic(rows.text);
    log(`[inject-methodology] reconcile: ${describeMeth}; ${describeOrch}; ${describeAut}; ${describeRows}.`);
    reportNotes(rowWritten);
    return result(0);
  }

  // Legacy inject-into-existing-slot mode (METHODOLOGY only). injectMethodology no-ops on absent markers
  // and errors on a malformed slot WITHOUT reading the fragment, so resolve+read the engine only when
  // there is a present (ok) slot to fill — a markerless legacy AGENTS.md stays a no-op without the engine.
  const fragment = findSlot(text).state === 'ok' ? await sourceFragmentOrStop('STOP', ENGINE_FRAGMENT_REL) : '';
  const injected = injectMethodology(text, fragment, { maxLines: AGENTS_MD_CAP });
  if (injected.status === 'error') {
    logError(`[inject-methodology] malformed slot — refusing to edit: ${injected.error}`);
    return result(1);
  }
  if (injected.status === 'noop-absent') {
    log('[inject-methodology] no methodology markers found — nothing to inject (legacy AGENTS.md).');
    return result(0);
  }
  await writeAtomic(injected.text);
  log('[inject-methodology] injected the bounded methodology fragment into the slot.');
  return result(0);
  } catch (err) {
    if (err[EXIT] !== undefined) return result(err[EXIT]);
    throw err;
  }
};

if (isDirectRun(import.meta.url)) {
  const { code, stdout, stderr } = await runCli(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
