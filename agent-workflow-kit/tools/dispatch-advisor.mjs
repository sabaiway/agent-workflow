// dispatch-advisor.mjs — the vehicle-routing ADVISOR (delegation Plan 3, Phase 1; D1-D4).
//
// One question, one answer: *which vehicle carries this step class on THIS host, and what has the
// ledger already recorded for it.* That answer lived only in prose canon and in a remembered rule,
// so a cold session routed a sub-task from memory or not at all. It is now a printed block at two
// points of use — `dispatch advise` and the footer of a form-valid `dispatch check`.
//
// What it deliberately is NOT:
//   • it never gates. Nothing here refuses a dispatch, and the footer prints ONLY over a form-valid
//     contract, so the checker's exit contract and FIRST line stay byte-identical whatever this
//     module concludes. A choice that diverges from the advice is a NOTE, never a refusal.
//   • THIS MODULE writes nothing and spawns nothing — but the VERB that prints it is not spawn-free,
//     and the honest split is stated in ADVISOR_PROBE_POSTURE below rather than claimed away here.
//     Host capability is filesystem-only: the execute backend through the detector (which spawns
//     nothing by a source-level pin), the cheap vehicles through the PRESENCE of
//     `.claude/agents/<name>.md` at the repository top-level, which the CALLER resolves and declares.
//   • it opens no second ledger door. The recorded history arrives as the CALLER's read outcome —
//     `{ok:true, records}` or `{ok:false, reason}` — and is counted through the store's OWN thread
//     walk (`delegationThreadState`), never a second walker. An unreadable store degrades the
//     history line and leaves the advice standing.
//
// Portability is stated rather than assumed: the four bundled vehicles and the kit's own worktrees
// mode are portable rows; `doc-research` is HOST-LOCAL — a per-host web grant the kit does not
// bundle — and the host's own subagent lane is ASSUMED/manual, carrying no availability verdict at
// all. Dependency-free, Node >= 22. No side effects on import; no CLI (the verb lives on dispatch).

import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { STEP_CLASSES } from './dispatch-record.mjs';
import { delegationThreadState } from './dispatch-store.mjs';
import { AGENTS_DIR, FALLBACK_LENS_ADDITIONAL_ONLY } from './cheap-agents.mjs';
import { detectBackends, wrapperCmdFor, READY } from './detect-backends.mjs';

// The two sentences doc-parity binds into references/modes/dispatch.md. Stated ONCE, here, so the
// mode doc can never drift into promising a gate this module does not own.
export const ADVISOR_NO_GATE = 'the advice never gates a dispatch: which vehicle carries a sub-task stays orchestrator judgment, and a divergence from the advice is recorded as a note rather than refused';
export const HARNESS_SUBAGENT_LANE = "the harness's own subagent lane is ASSUMED/manual — it is not kit-detectable, so it carries no availability verdict here and no acceptance weight";

// The other lane, always printed: an unavailable vehicle is not a dead end, it is a degrade you record.
export const ADVISOR_FALLBACK = 'solo (this orchestrator) — recorded as a degrade, never a silent skip';

// The verb's honest posture, bound into the mode doc and interpolated into the tool's HELP so the
// three surfaces state ONE thing. "Spawns nothing" was false of the VERB from the first line of this
// lane — the store path is resolved through git unless AW_DELEGATION_STORE names it — so the claim
// is stated where it is true (the module) and qualified where it is not (the verb).
export const ADVISOR_PROBE_POSTURE = 'the advisor module itself writes nothing, spawns nothing and opens no second ledger door; the VERB may run read-only git probes — the delegation store path (unless AW_DELEGATION_STORE names it outright) and the repository top-level the cheap vehicles are anchored at — and it never runs a vehicle, a subscription CLI, or anything that writes';

// The table's shape, stated ONCE. The header line, the alignment rule, the rendered rows and the
// parser's arity + per-cell diagnosis all DERIVE from this: three separate statements of one column
// order is exactly how a reordered header keeps a green gate over rows that no longer mean what
// their columns say.
export const ADVISOR_MATRIX_COLUMNS = Object.freeze([
  Object.freeze({ key: 'stepClass', label: 'step class' }),
  Object.freeze({ key: 'vehicle', label: 'vehicle' }),
  Object.freeze({ key: 'availabilityNote', label: 'availability' }),
  Object.freeze({ key: 'returns', label: 'returns' }),
]);

const matrixRow = (cells) => `| ${ADVISOR_MATRIX_COLUMNS.map(({ key }) => cells[key]).join(' | ')} |`;

export const ADVISOR_MATRIX_HEADER = matrixRow(Object.fromEntries(ADVISOR_MATRIX_COLUMNS.map(({ key, label }) => [key, label])));
export const ADVISOR_MATRIX_RULE = matrixRow(Object.fromEntries(ADVISOR_MATRIX_COLUMNS.map(({ key }) => [key, '---'])));

// The execute backend is named once; its wrapper cmd is READ from the detector's role registry
// rather than re-typed, so a renamed wrapper moves this row with it.
const EXECUTE_BACKEND = 'codex-cli-bridge';
const EXECUTE_ROLE = 'execute';

const BUNDLED = 'bundled vehicle — present once placed in .claude/agents/';
const HOST_LOCAL = 'HOST-LOCAL — a per-host web grant, never bundled with the kit';

// ── the frozen row set: exactly one row per D9 step class ─────────────────────────────────────────
// Totality is a TEST, not a comment: a class added to dispatch-record.mjs reddens the advisor suite
// rather than printing nothing at the point of use.

const row = (entry) => Object.freeze(entry);

export const ADVISOR_ROWS = Object.freeze([
  row({
    stepClass: 'code',
    vehicle: wrapperCmdFor(EXECUTE_BACKEND, EXECUTE_ROLE),
    kind: 'backend',
    backend: EXECUTE_BACKEND,
    portable: true,
    availabilityNote: 'execute backend — readiness read from the bridge install, never from a spawn',
    returns: "a diff plus the wrapper's exec receipt",
    why: 'a bounded code sub-task returns a diff you review + gate',
  }),
  row({
    stepClass: 'extraction',
    vehicle: 'mechanical-sweep',
    kind: 'agent',
    portable: true,
    availabilityNote: BUNDLED,
    returns: 'an extraction report you verify',
    why: 'a mechanical multi-file sweep returns facts, on a read-only vehicle that can never shell out',
  }),
  row({
    stepClass: 'triage',
    vehicle: 'gate-triage',
    kind: 'agent',
    portable: true,
    availabilityNote: BUNDLED,
    returns: 'a structured gate-failure classification',
    why: "a failing gate's output returns classified, never fixed — the fix stays yours",
  }),
  row({
    stepClass: 'draft',
    vehicle: 'changelog-skeleton',
    kind: 'agent',
    portable: true,
    availabilityNote: BUNDLED,
    returns: 'a factual skeleton',
    why: 'the factual bones come back cheap; the lead and the final text stay yours',
  }),
  row({
    stepClass: 'research',
    vehicle: 'doc-research',
    kind: 'agent',
    portable: false,
    availabilityNote: HOST_LOCAL,
    returns: 'cited findings',
    why: 'an external documentation question returns cited findings, on the one vehicle granted web access',
  }),
  row({
    stepClass: 'review-opinion',
    vehicle: 'review-lens',
    kind: 'agent',
    portable: true,
    availabilityNote: BUNDLED,
    returns: 'one additional review opinion',
    why: FALLBACK_LENS_ADDITIONAL_ONLY,
  }),
  row({
    stepClass: 'worktree-stream',
    vehicle: 'worktrees',
    kind: 'kit',
    portable: true,
    availabilityNote: 'ships with the kit — available wherever the kit is deployed',
    returns: 'a prepared satellite diff plus its handoff',
    why: 'a parallel feature stream runs in its own worktree and returns a prepared diff plus its handoff',
  }),
]);

export const advisorRow = (stepClass) => ADVISOR_ROWS.find((r) => r.stepClass === stepClass);

// ── host capability, resolved by filesystem facts only (D2) ───────────────────────────────────────

// The agent lane is FOUR-valued, and the two unknowns are kept apart because they are two different
// ignorances. `.claude/agents/` is a repository-ROOT surface, so a probe run from anywhere else
// proves nothing — an absent file under an UNANCHORED cwd is not evidence the vehicle is unplaced,
// and a PRESENT one there is not evidence it is the repository's vehicle either, since a nested
// shadow copy reads identically. Separately, an anchored probe can simply fail to answer (any errno
// but ENOENT — EACCES is not absence), and saying "the repository root was not resolved" there would
// be a false statement about a root that WAS resolved. Both render as `unknown`; each names its own
// cause.
export const AGENT_PRESENT = 'present';
export const AGENT_MISSING = 'missing';
export const AGENT_UNANCHORED = 'unanchored';
export const AGENT_PROBE_ERROR = 'probe-error';

// The states that are NOT a verdict — exported so a consumer can ask the question without re-deriving
// which values happen to be ignorance today.
export const AGENT_UNKNOWN_STATES = Object.freeze([AGENT_UNANCHORED, AGENT_PROBE_ERROR]);

// No-follow by construction: the placement writer refuses to write through a symlink, so a symlinked
// entry is not a vehicle this kit placed and is not counted as one.
const probeAgentFile = (cwd, name) => {
  try {
    return lstatSync(join(cwd, AGENTS_DIR, `${name}.md`)).isFile() ? AGENT_PRESENT : AGENT_MISSING;
  } catch (err) {
    return err?.code === 'ENOENT' ? AGENT_MISSING : AGENT_PROBE_ERROR;
  }
};

// advisorDeps({cwd, anchored, detect}) → the injected host half. `anchored` states whether `cwd` IS
// the repository top-level; when it is not, the agent lane answers `unanchored` rather than guessing.
// Both probes are pure reads; `detect` is the detector's own no-spawn pass, resolved ONCE per call so
// seven rows cost one detection.
export const advisorDeps = ({ cwd = process.cwd(), anchored = true, detect = detectBackends } = {}) => {
  let detected = null;
  return {
    agentState: (name) => (anchored ? probeAgentFile(cwd, name) : AGENT_UNANCHORED),
    backendReadiness: (backend) => {
      detected ??= detect();
      return detected.find((b) => b.name === backend)?.readiness ?? 'not-installed';
    },
  };
};

const AGENT_LABELS = Object.freeze({
  portable: Object.freeze({
    [AGENT_PRESENT]: 'ready',
    [AGENT_MISSING]: 'unavailable — not placed; run /agent-workflow-kit agents',
    [AGENT_UNANCHORED]: 'unknown — the repository root was not resolved, so .claude/agents/ was never located',
    [AGENT_PROBE_ERROR]: 'unknown — the repository root resolved, but .claude/agents/ could not be probed there',
  }),
  'host-local': Object.freeze({
    [AGENT_PRESENT]: 'ready — host-local',
    [AGENT_MISSING]: 'unavailable — host-local, not bundled',
    [AGENT_UNANCHORED]: 'unknown — host-local, and the repository root was not resolved',
    [AGENT_PROBE_ERROR]: 'unknown — host-local, and .claude/agents/ could not be probed',
  }),
});

// The label for a state this module does not recognize. It claims NOTHING — not that the root
// resolved, not that it did not. Reusing the probe-error wording here would assert "the repository
// root resolved" about a value that establishes no such thing, which is the same class of false
// statement the two named unknowns exist to avoid, one level down.
export const AGENT_UNRECOGNIZED_LABEL = 'unknown — the availability probe returned an unrecognized state, so nothing about this vehicle is established';

export const availabilityOf = (entry, deps) => {
  if (entry.kind === 'kit') return { ready: true, label: 'ready — ships with the kit' };
  if (entry.kind === 'backend') {
    const readiness = deps.backendReadiness(entry.backend);
    return readiness === READY
      ? { ready: true, label: 'ready' }
      : { ready: false, label: `unavailable — ${readiness}` };
  }
  const state = deps.agentState(entry.vehicle);
  const labels = AGENT_LABELS[entry.portable ? 'portable' : 'host-local'];
  return { ready: state === AGENT_PRESENT, label: labels[state] ?? AGENT_UNRECOGNIZED_LABEL };
};

// ── the recorded history: the store's OWN thread walk, over a CLOSED state taxonomy (D4) ──────────

const THREAD_KINDS = ['dispatch', 'return', 'fold', 'degrade'];

// The four states are exactly what delegationThreadState distinguishes. `open` is printed SEPARATELY
// and is never among the closed threads: a live thread is not evidence about a finished one.
const threadStateName = (state) => {
  if (state.closure?.kind === 'fold') return 'folded';
  if (state.closure?.kind === 'degrade') return 'degrade-closed';
  return state.terminal ? 'failure-terminal' : 'open';
};

export const countThreadStates = (records, stepClass) => {
  const counts = { folded: 0, 'failure-terminal': 0, 'degrade-closed': 0, open: 0 };
  const seen = new Set();
  for (const record of records) {
    if (!THREAD_KINDS.includes(record?.kind)) continue;
    const { nonce } = record;
    // A PRE-DISPATCH degrade carries nonce null and belongs to no thread at all.
    if (typeof nonce !== 'string' || nonce === '' || seen.has(nonce)) continue;
    seen.add(nonce);
    const state = delegationThreadState(records, nonce);
    if (state.dispatch === null || state.dispatch.stepClass !== stepClass) continue;
    counts[threadStateName(state)] += 1;
  }
  return counts;
};

const CLOSED_ORDER = ['folded', 'failure-terminal', 'degrade-closed'];

export const historyLine = (stepClass, ledger) => {
  if (ledger?.ok !== true) {
    return `history: unavailable — ${ledger?.reason ?? 'the ledger read reported no outcome at all'}`;
  }
  const counts = countThreadStates(ledger.records ?? [], stepClass);
  const closed = CLOSED_ORDER.reduce((sum, key) => sum + counts[key], 0);
  if (closed === 0 && counts.open === 0) return 'history: no recorded history';
  const parts = CLOSED_ORDER.filter((key) => counts[key] > 0).map((key) => `${counts[key]} ${key}`);
  const closedClause = closed === 0
    ? '0 closed threads'
    : `${closed} closed thread${closed === 1 ? '' : 's'} — ${parts.join(', ')}`;
  return `history: ${closedClause} · ${counts.open} open`;
};

// ── rendering ─────────────────────────────────────────────────────────────────────────────────────

// renderAdvisorBlock({stepClass, ledger, deps}) → the five-line block, or null for an unknown class.
// The refusal of an unknown class belongs to the CALLER (a usage exit naming the closed set), not
// here: this module answers a question and never decides an exit code.
export const renderAdvisorBlock = ({ stepClass, ledger, deps }) => {
  const entry = advisorRow(stepClass);
  if (entry === undefined) return null;
  const availability = availabilityOf(entry, deps);
  return [
    `dispatch advisor — step class: ${stepClass}`,
    `  advice: ${entry.vehicle} (${availability.label}) — ${entry.why}`,
    `  fallback: ${ADVISOR_FALLBACK}`,
    `  ${historyLine(stepClass, ledger)}`,
    `  note: ${ADVISOR_NO_GATE}`,
  ].join('\n');
};

// renderSelectionNote({stepClass, vehicle}) → the divergence NOTE, or null when the contract's
// SELECTED vehicle is the advised one. `vehicle.requested` is named only when it differs from
// `selected` — where the pair agrees there is nothing to distinguish, and printing it twice would
// read as a second fact.
export const renderSelectionNote = ({ stepClass, vehicle }) => {
  const entry = advisorRow(stepClass);
  if (entry === undefined || vehicle == null) return null;
  const { requested, selected } = vehicle;
  if (selected === entry.vehicle) return null;
  const requestedClause = requested !== selected ? ` (requested "${requested}")` : '';
  return `  divergence: the contract selected "${selected}"${requestedClause}; the advisor advises "${entry.vehicle}" — a NOTE, never a refusal`;
};

// The harness lane, as a row rather than as a rendered string: it joins the table through the same
// column order as every other row, and it is NOT a step class — no availability verdict, no
// acceptance weight, and it never enters the registry the advice is read from.
export const HARNESS_LANE_ROW = Object.freeze({
  stepClass: 'harness subagent',
  vehicle: "the host's own",
  availabilityNote: HARNESS_SUBAGENT_LANE,
  returns: 'not measured',
});

// renderAdvisorMatrix() → the vehicle-routing matrix the mode doc carries, WHOLE: header, alignment
// rule, one row per registry row in registry order, and the lane. The doc's copy is held to this
// exact block by doc-parity's structure check, so a deleted rule row, a rewritten lane and an extra
// row are all caught by the same comparison that catches a drifted cell.
export const renderAdvisorMatrix = () => [
  ADVISOR_MATRIX_HEADER,
  ADVISOR_MATRIX_RULE,
  ...ADVISOR_ROWS.map((entry) => matrixRow({ ...entry, stepClass: `\`${entry.stepClass}\`` })),
  matrixRow(HARNESS_LANE_ROW),
].join('\n');

// The closed class set, rendered for the caller's usage refusal — one source with the record
// vocabulary, so a class added there is offered here without a second edit.
export const ADVISOR_STEP_CLASSES = STEP_CLASSES;
