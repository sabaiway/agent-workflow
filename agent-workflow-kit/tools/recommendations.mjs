#!/usr/bin/env node
// recommendations.mjs — the read-only upgrade Recommendations advisor behind
// `/agent-workflow-kit recommendations` (AD-044 Plan 4, Phase 3).
//
// A consumer who upgrades the kit never learns their deployment is configured sub-optimally (no
// bridge allowlist, autonomy render drifted, sandbox not provisioned, gates undeclared) — every
// `upgrade` run therefore ends with a mandatory, deterministic Recommendations section: what is
// sub-optimal · the benefit in ONE plain line · the exact consent-gated apply one-liner. The agent
// PRESENTS the section in the user's conversational language — every fact, count and item from
// the tool, nothing added or dropped; commands, paths, hosts and rule strings byte-exact; the raw
// tool block shown on request (the AD-032 report-contract lane). The user picks items in plain
// language; after the per-item consent moment the agent runs EXACTLY the rendered one-liners — no
// improvisation, each writer's own consent semantics intact.
//
// Contract:
//   node recommendations.mjs --cwd <project-root> [--json]
// --cwd is REQUIRED (subdir-proof: the target project is explicit, never inferred from the shell's
// current directory). The section renders PRESENT-EVEN-WHEN-EMPTY (the exact empty-state line
// below) and VERDICT-FIRST (D1): every non-optimal state opens with ONE composed verdict line.
// Registry strings are frozen tool DATA, fact-true, one line under the shape cap (D2); posture/
// risk prose lives in the mode doc at the consent moment (D3). A probe failure is a stated
// skipped-item line — never a crash, never a fabricated item. The consented
// `velocity-profile --bridge-tier` seeds used bridges' allow rules, <wrapper> * exclusions
// (codex-exec * where an execute slot delegates), hosts in sandbox.network.allowedDomains and
// state dirs in sandbox.filesystem.allowWrite; its recipe: line names the missing entries.
//
// Read-only: never writes, never commits, never runs a subscription CLI. The reused probes are all
// exported read-only surfaces of their owning tools (velocity/autonomy/doctor/backends/recipes/
// registry/sandbox-masks); the sandbox-masks, settings and tracked-tree-census probes may run
// read-only git queries. Dependency-free, Node >= 22. No side effects on import (the isDirectRun
// idiom).

import { readFileSync, readdirSync, lstatSync, existsSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  preflightVelocityProfile,
  planVelocityProfile,
  checkAutonomyProfile,
  probeSandboxAvailability,
  isExecutableFile,
  readSettingsFile,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
} from './velocity-profile.mjs';
import { loadAutonomy, isSparseSeedConfig, AUTONOMY_REL } from './autonomy-config.mjs';
import { deriveDoctorPlan, TRUSTED_DIRS } from './autonomy-doctor.mjs';
import { laneOf, applySlot, consoleArgv } from './write-lanes.mjs';
import { STATE_BLOCK_HOOK_COMMAND, STATE_BLOCK_HOOK_RUNTIME, isStopHookWired } from './state-block-hook.mjs';
import { detectBackends } from './detect-backends.mjs';
import { isDirectRun } from './direct-run.mjs';
import { ACTIVITIES, resolveActivityRecipe, composeReadiness, safeLine } from './recipes.mjs';
import { surveyFamily, surveyGateHook, surveyAdrLayoutStrict } from './family-registry.mjs';
import { probeSandboxMasks, needsMasksApply, patternToRel } from './sandbox-masks.mjs';
import { shellQuoteArg } from './review-state.mjs';
import { isFinalCapableDeclaration } from './run-gates.mjs';
import { loadDeclaration, canonicalCheckerGates, coverageProducerPrecedes, isKitOwnedCheckerGate, LCOV_PRODUCER_KEY } from './gates-declaration.mjs';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';
// The typed channel's READ-ONLY leaf only — never tools/mcp.mjs, which reaches the write core.
import {
  SERVER_NAME as MCP_SERVER_NAME,
  STATE as MCP_STATE,
  readRegistration,
} from './mcp-registration.mjs';
import { matchesCoverageProducer, isCoverageProducerGate } from './coverage-producer.mjs';
// How much of the TRACKED tree the changed-line coverage domain can assess at all — the fact that
// turns "the checker certifies" into "the checker certifies the assessable minority".
import { takeCensus, censusFact, CENSUS_VERDICT } from './tracked-tree-census.mjs';
// Read-only surfaces of the fill (buildOffer) and of the source-size practice (its pure core). The
// fill's own WRITER is never called from here — the advisor renders its consent-gated command, it
// does not run it.
import { buildOffer } from './gates-init.mjs';
import { CHECKER_CLAIM, INITIAL_ADOPTION_REASON, SOURCE_SIZE_GATE_ID, classifySourceSizeGate, loadSourceSizeConfig, readLayoutSetup } from './source-size-core.mjs';
// The declared-path resolution + segment containment this item's convergence lane shares with the
// autonomy render's allowWrite degrade — ONE leaf, so the two answers cannot drift.
import { resolveDeclaredDir, dirCovers, isResolvableDeclaredEntry } from './declared-paths.mjs';
import { hookCheckAnswers, plannedRoles, readPreCommitState, unsafeToolsPath } from './git-hooks.mjs';
export { resolveGitHooksPath, readPreCommitState, canonicalGuardLineRe, INSTALLER_MARKER_RE } from './git-hooks.mjs';
import { loadConfig } from './orchestration-config.mjs';
import { homeRelative } from './bridge-state-dirs.mjs';
import { sandboxEnabled, HOST_HONORS_QUALIFIER } from './bridge-wiring.mjs';
import { assertContainedRealPath } from './fs-safe.mjs';
import { nearestExistingDir, worktreesGrantDir, worktreesGrantHoldsHome } from './worktrees.mjs';
import { preflightCheapAgents, writeCheapAgents, EXECUTOR_VEHICLE } from './cheap-agents.mjs';
import { ATTRIBUTION_KEY, LEGACY_ATTRIBUTION_KEY, attributionHidesText, effectiveAttribution, readAttributionChoice, wrongTypedKey } from './attribution.mjs';
import { planGlobalRemoval } from './hide-footprint.mjs';
import { NODE_EVIDENCE, NODE_EVIDENCE_SCRIPTS, probeNodeEvidence } from './node-evidence.mjs';
// The vehicle READINESS comes from the read-only half — the same survey `recipes` and `status` read.
import { surveyExecutorVehicle, readExecutorPosture, executorBodyDiffers, executorTemplate, reviewLensTemplate, readStamp, readFsDeps, WORKFLOW_STAMP, EXPECTED_WORKFLOW_VERSION, REVIEW_LENS_VEHICLE } from './cheap-agents-read.mjs';
import { readVehicles, resolveExecutor, resolveReviewLens } from './vehicle-settings.mjs';
// The ack store's path, keys, lane registry, fingerprint and guarded reader live in their own leaf
// (contract: kit/ack-store) — `status` reads the same store, and a second copy is what drifts.
import {
  ACKS_FILE,
  ACKS_LANE_KEY,
  ACKS_WORKTREES_DIR_KEY,
  ACKS_COVERAGE_DOMAIN_KEY,
  ACKS_SOURCE_SIZE_COPY_KEY,
  ACKS_JEV_CONNECT_KEY,
  ACKS_JEV_SKILL_KEY,
  ACK_LANES,
  factFingerprint,
  readAckValue,
} from './ack-store.mjs';
import { ADOPTION, STORE_DIR_REL as SPEC_STORE_DIR_REL, SPEC_ADOPTION_LANE, declineFingerprint, readDeclineAck, surveySpecAdoption } from './spec-adoption.mjs';
import { ENSURE_OPS } from './ensure-vocabulary.mjs';
import { composeProfileGapScreen } from './profile-gap-screen.mjs';
import { NO_APPLY_LINE, SKILL_PINS, claudeDirOf, keySet, placeOf, printable, skillLine, skillState, skillTargets } from './jev-facts.mjs';

// The upgrade ensure that seeds the spec store — the not-adopted item's apply; pinned to the vocabulary.
const SPEC_LAYER_ENSURE = ENSURE_OPS.includes('specs') ? 'specs' : null;
const JEV_CONNECT_DECLINED = 'jev-connect:declined';
const JEV_CONNECT_DECLINE = factFingerprint(JEV_CONNECT_DECLINED);
// The skill decline names the pin it declined, so a pin move brings the update offer back once.
const JEV_SKILL_DECLINED = 'jev-skill:declined:';

export { ACKS_FILE, ACKS_LANE_KEY, ACKS_WORKTREES_DIR_KEY, ACKS_COVERAGE_DOMAIN_KEY, ACKS_SOURCE_SIZE_COPY_KEY, ACK_LANES, factFingerprint };

const HERE = dirname(fileURLToPath(import.meta.url));
const toolPath = (rel) => join(HERE, rel);
const q = shellQuoteArg;
// A user variant's own step, as the lane leaf words it: the rendered apply of every user item.
const userStepOf = (variant, root) => applySlot(variant, { toolsDir: HERE, root }).apply;
const ABSENT_CODE = 'ENOENT';
const ENFORCEMENT_KIT_ROOT = resolve(HERE, '..');
const ENFORCEMENT_BUNDLE_ROOT = join(ENFORCEMENT_KIT_ROOT, 'references', 'scripts');
const ENFORCEMENT_WHAT = 'the enforcement scripts are not deployed beside docs/ai (no Node evidence) \u2014 the offer copies them and installs the pre-commit hook';
const ENFORCEMENT_UNMANAGED_HOOK = 'an UNMANAGED pre-commit hook exists \u2014 the installer never overwrites it, so the kit places no script here; with that hook moved aside (your own step) the enforcement item is offered';
const COMMIT_GUARD_INSTALLER_VIA_ITEM = 'the hook installer (scripts/install-git-hooks.mjs) is not deployed \u2014 apply the enforcement item first, then re-run';
const COMMIT_GUARD_INSTALLER_OWN_STEP = 'the hook installer (scripts/install-git-hooks.mjs) is not deployed here \u2014 deploying the enforcement scripts into this project is your own step, then re-run';
const COMMIT_GUARD_UNMANAGED_HOOK = 'an UNMANAGED pre-commit hook exists \u2014 the installer never overwrites it; adding the guard line to it is your own step';
const HOOK_CHECKS_UNMANAGED_HOOK = 'an UNMANAGED pre-commit hook exists \u2014 the installer never overwrites it; adding the lines this item would arm to it is your own step';
const HOOK_CHECKS_WAIT = 'the layout line follows the source-size.layout record \u2014 apply that item first; this item\'s check line then arms the layout line too';
const LAYOUT_RECORD_RECIPE = 'the hook is per clone and the config per branch: a branch or linked worktree with no size config is judged under the kit\'s values and stops on its piles until it takes the record (a hidden deployment\'s linked worktree carries none); one with an older config without layout is not judged on layout; one whose config is schema 1 or unminted stops every commit on that config\'s own stop until it takes the current config';
const LAYOUT_HELD = {
  stops: () => 'the source-size check stops on this tree, so a layout record or layout line not yet in place waits \u2014 record that growth first with the reasoned --write-baseline its stop names, then re-run',
  'store-root': ({ root }) => `the source-size config declares the root "${root}" at or inside the spec store docs/ai/specs \u2014 the layout record starts once that root is declared outside it`,
};
// ── the section contract tokens (doc-parity-bound in upgrade.md + the mode doc) ────────────────
export const RECOMMENDATIONS_SECTION_HEADER = '## Recommendations (agent-workflow)';
export const RECOMMENDATIONS_EMPTY_LINE = 'no recommendations — flow optimal.';
// The one dual-wording security clause — rides ONLY the items with a real security delta.
export const DUAL_SECURITY_BENEFIT = 'safer — blast radius bounded by the OS sandbox, not human attention';

// ── the verdict-first contract (D1, REC-UX-REWORK) ──────────────────────────────────────────────
// The optimal state (no items, no skips) renders the frozen empty-state line ALONE — byte-identical
// to the pre-verdict contract. Every other state opens the body with ONE verdict line composed from
// these frozen templates ({X}-style placeholders; the "(s)" invariant form IS the pinned
// pluralization rule — no singular/plural branching). The templates are English tool DATA
// (doc-parity-bound in both mode docs); user-language rendering is the agent's presentation layer.
export const VERDICT_ATTENTION_TEMPLATE = '{K} item(s) need attention';
export const VERDICT_NOTHING_BROKEN = 'nothing is broken';
export const VERDICT_OPTIONAL_TEMPLATE = '{N} optional recommendation(s), apply any you want';
export const VERDICT_SKIPS_TEMPLATE = 'optimality NOT attested — {M} probe check(s) skipped';

// ── the frozen severity registry (D1; pinned by tests) ─────────────────────────────────────────
// `attention` — the item reports a CONFIGURED declaration that is broken, drifted, degrading or
// invalid (the deployment needs review); `optional` — an offer to enable an unconfigured
// capability. One class per key, frozen registry data; a `<key>.<variant>` entry classes a
// per-site arm whose semantics differ from its base (the invalid-env arm reports an INVALID
// configured value — attention — while the unset arm stays an offer).
export const SEVERITY_ATTENTION = 'attention';
export const SEVERITY_OPTIONAL = 'optional';
export const SEVERITIES = Object.freeze({
  'velocity-core': SEVERITY_OPTIONAL,
  'kit-tools-tier': SEVERITY_OPTIONAL,
  'bridge-tier': SEVERITY_OPTIONAL,
  'autonomy-policy': SEVERITY_OPTIONAL,
  'autonomy-render': SEVERITY_ATTENTION,
  'sandbox-provision': SEVERITY_OPTIONAL,
  'sandbox-provision.installable': SEVERITY_OPTIONAL,
  'review-recipe': SEVERITY_ATTENTION,
  'gates-declaration': SEVERITY_OPTIONAL,
  'gates-inert': SEVERITY_ATTENTION,
  'gates-inert.unfillable': SEVERITY_ATTENTION,
  'gates-inert.no-verification': SEVERITY_ATTENTION,
  // Both third outcomes are attention, and both therefore block the flow-optimal line MECHANICALLY:
  // an added item makes the verdict non-null. One reports a pair that is dead on a tree the closed
  // producer world cannot speak for; the other reports a LIVE pair whose certification reaches only
  // the assessable minority of that tree. Neither changes what a run may certify.
  'gates-inert.producer-unrecognized': SEVERITY_ATTENTION,
  'gates-inert.coverage-domain-narrow': SEVERITY_ATTENTION,
  'source-size': SEVERITY_OPTIONAL,
  // The declared-but-unminted arm reports a CONFIGURED declaration that is broken — a gate certain
  // to refuse on every run — while the base arm stays an offer to enable something unconfigured.
  'source-size.unminted': SEVERITY_ATTENTION,
  // A vendored copy of this checker is a DELIBERATE deployment choice, not a broken declaration —
  // the practice runs, the advisor simply cannot read it through its own tool; the offer is the
  // acknowledgment. An id SQUATTER is the opposite: the id says adopted while nothing measures size.
  'source-size.adopted-elsewhere': SEVERITY_OPTIONAL,
  'source-size.id-squatter': SEVERITY_ATTENTION,
  // A minted schema-1 config is a record the check stops on until the writer moves it.
  'source-size.schema-1': SEVERITY_ATTENTION,
  'source-size.layout': SEVERITY_OPTIONAL,
  'gate-hook': SEVERITY_OPTIONAL,
  // A placed hook that predates the marker key goes DARK on a marker-carrying declaration (unknown
  // key → auto-approval off), so a CONFIGURED capability silently stops working: attention, not an
  // offer to enable something.
  'gate-hook.marker-stale': SEVERITY_ATTENTION,
  'commit-guard': SEVERITY_OPTIONAL,
  'hook-checks': SEVERITY_OPTIONAL,
  enforcement: SEVERITY_OPTIONAL,
  'read-lane': SEVERITY_OPTIONAL,
  'read-lane.stale': SEVERITY_ATTENTION,
  'read-lane.missing': SEVERITY_ATTENTION,
  'state-block': SEVERITY_OPTIONAL,
  'mcp-channel': SEVERITY_OPTIONAL,
  'mcp-channel.differing': SEVERITY_ATTENTION,
  agents: SEVERITY_OPTIONAL,
  // The `agents` row above is an OFFER to place vehicles. This one reports a config that ALREADY
  // names the subagent carrier over a vehicle that cannot carry it — a configured declaration that
  // is broken, which is what attention means.
  'executor-vehicle': SEVERITY_ATTENTION,
  // A hand edit of the placed executor is not a broken declaration — the vehicle still carries — so
  // re-deriving it is an offer.
  'executor-vehicle.differing': SEVERITY_OPTIONAL,
  // The AGENTS.md block is a configured choice the harness does not honour.
  attribution: SEVERITY_ATTENTION,
  'footprint-global': SEVERITY_OPTIONAL,
  'family-freshness': SEVERITY_ATTENTION,
  'adr-store-migration': SEVERITY_ATTENTION,
  'sandbox-masks': SEVERITY_OPTIONAL,
  'sandbox-masks.unfenced-mount': SEVERITY_ATTENTION,
  'worktrees-dir': SEVERITY_OPTIONAL,
  'worktrees-dir.home': SEVERITY_OPTIONAL,
  // The layer is opt-in, so both arms are OFFERS under the frozen registry (attention is a CONFIGURED
  // declaration that is broken): an absent store offers the seed, a store with no live contract offers
  // the decline. Neither arm can leave the flow-optimal line standing — an offer is still an item.
  'spec-adoption': SEVERITY_OPTIONAL,
  'profile-gap': SEVERITY_OPTIONAL,
  'jev-connect': SEVERITY_OPTIONAL,
  'jev-skill': SEVERITY_OPTIONAL,
  'jev-skill.earlier': SEVERITY_OPTIONAL,
  'spec-adoption.adopting': SEVERITY_OPTIONAL,
});
// The per-item render tags (frozen presentation data, same language contract as the templates).
export const SEVERITY_LABELS = Object.freeze({
  [SEVERITY_ATTENTION]: 'needs attention',
  [SEVERITY_OPTIONAL]: 'optional',
});

// {X}-style template fill (D1/D2): every placeholder must be supplied — a miss is a programming
// error that surfaces through the probe's stated-skip lane, never a rendered "{K}".
const fillTemplate = (template, values) => template.replace(/\{([A-Za-z]+)\}/g, (_, name) => {
  if (!(name in values)) throw new Error(`unfilled template placeholder {${name}}`);
  return String(values[name]);
});

// composeVerdict(counts) → the ONE verdict line, or null for the optimal state (D1 state matrix).
// attention>0 leads; the "nothing is broken" wording renders ONLY when attention==0 AND skipped==0
// (a skipped probe could hide an attention-class problem, so the claim would overreach; it renders
// only as the lead-in to the optional offer, never in a skips-only state); the skips part is
// appended last.
export const composeVerdict = ({ attention, optional, skipped }) => {
  if (attention === 0 && optional === 0 && skipped === 0) return null;
  const parts = [];
  if (attention > 0) parts.push(fillTemplate(VERDICT_ATTENTION_TEMPLATE, { K: attention }));
  if (optional > 0) {
    const offer = fillTemplate(VERDICT_OPTIONAL_TEMPLATE, { N: optional });
    parts.push(attention === 0 && skipped === 0 ? `${VERDICT_NOTHING_BROKEN} — ${offer}` : offer);
  }
  if (skipped > 0) parts.push(fillTemplate(VERDICT_SKIPS_TEMPLATE, { M: skipped }));
  return parts.join('; ');
};

// ── the frozen WHAT-template registry (D2; pinned by the static shape test) ─────────────────────
// Every static WHAT template lives here — `<key>` is the item key, `<key>.<variant>` a per-site
// variant of the same item — so ALL variants are assertable at build time (single line, char cap,
// banned tokens), never a fixture-coverage gamble. A pure-placeholder template marks a WHAT whose
// content is fully dynamic (capped at composition by truncation-with-count) — except `profile-gap`, whose
// WHAT is never truncated: the leaf's suite pins every composed WHAT under the cap.
const GATES_INERT_WHAT = 'the declared coverage checker ({id}) has no producer before it — it certifies nothing this run, or reads a stale lcov';
export const WHATS = Object.freeze({
  'velocity-core': 'routine read-only commands still prompt — {n} audited read-only allowlist entr(ies) not seeded',
  'velocity-core.rule': 'auto mode refuses a harness apply, so work cannot stay in auto mode — the apply ask rule is not seeded',
  'velocity-core.both': 'routine read-only commands still prompt, and auto mode refuses a harness apply — {n} entr(ies) not seeded',
  'kit-tools-tier': "the kit's own read-only tools still prompt — {n} kit-tools tier entr(ies) not seeded",
  'bridge-tier': 'bridge-wrappers tier incomplete — {n} entr(ies) missing (allow rules, exclusions, hosts or state dirs of used bridges)',
  'autonomy-policy': 'no {path} — the computed defaults apply implicitly (red-lines ask/deny; every activity floors at prompt)',
  'autonomy-render': 'the declared autonomy policy is not rendered into .claude/settings.json — drift: {drift}',
  'sandbox-provision': 'the OS sandbox is unavailable: {reason}',
  'sandbox-provision.installable': 'the OS sandbox is unavailable: {reason} — installable via the doctor (consent tuple {tuple})',
  'review-recipe': '{degraded}',
  'gates-declaration': 'no declared gate matrix (docs/ai/gates.json absent or empty) — gates prompt one by one; the apply PREVIEWS its --apply line, writes nothing',
  'gates-inert': GATES_INERT_WHAT,
  'gates-inert.unfillable': GATES_INERT_WHAT,
  'gates-inert.no-verification': "all {n} declared gate(s) are the kit's own checkers — the matrix runs no project-verification command",
  'gates-inert.producer-unrecognized': 'the coverage checker ({id}) has NO producer declared and none offerable, on a tree the changed-line domain barely reaches',
  'gates-inert.coverage-domain-narrow': 'certification covers the assessable minority only — {ext} dominate(s) the tracked tree, and the changed-line domain excludes them',
  'source-size': 'no source-size gate — module size drifts unmeasured, and an over-cap file is invisible instead of recorded debt',
  'source-size.unminted': 'the source-size gate is declared over an unminted record ({state}) — the check refuses it, or if absent judges layout alone, no line',
  'source-size.schema-1': 'the source-size config is schema 1, which the check stops on — the writer moves it to schema 2 in one write',
  'source-size.layout': 'the layout record is not started — starting it records any directory already beyond the layout limits, so the commit hook can judge layout',
  'source-size.adopted-elsewhere': "the source-size gate runs a DIFFERENT copy of this checker ({n} declared) — adopted here, just not through this kit's own tool",
  'source-size.id-squatter': 'a gate carries the source-size id but is not this checker — the practice reads as declared while nothing measures module size',
  'gate-hook': '{n} declared gate(s) prompt per run — the gate-approval hook is not wired',
  'gate-hook.marker-stale': 'the declaration carries the lcovProducer key but the placed hook predates it — the hook goes dark and every gate prompts',
  'commit-guard': 'the gate matrix is final-run-capable but no commit-guard arms the pre-commit hook — a commit needs no green receipt yet',
  'hook-checks': 'the pre-commit hook lacks this kit\'s {checks} — the kit arms each line',
  enforcement: ENFORCEMENT_WHAT,
  'read-lane': 'the gate hook is wired but the read-only compound lane is off — pipes/chains of seeded reads still prompt one by one',
  'read-lane.stale': 'the read-lane is ON but the placed gate hook is stale — an old hook never reads lanes.json, so the lane is silently dark; reseed it',
  'read-lane.missing': 'the gate hook is wired but its placed file is missing — every Bash call errors and the read-lane is dark; re-place it',
  'state-block': 'nothing checks the closing state block — a turn that ends on «nothing needed from you», or on a promise it never started, passes unseen',
  'mcp-channel': "the kit's read-only MCP server is not registered here — path questions and literal searches stay shell strings",
  'mcp-channel.differing': 'an "{server}" MCP entry is already declared here and DIFFERS from the registration this kit copy would write',
  agents: '{n} bundled subagent vehicle(s) not placed (Claude Code) — {ro} read-only, {ex} the full-tool executor; the apply PREVIEWS first',
  'agents.lens-rederive': 'the placed review-lens.md differs from its body derived from docs/ai/vehicles.json; {n} vehicle(s) to place ({ro} read-only, {ex} executor)',
  'executor-vehicle': '{n} slot(s) configured subagent but the executor vehicle is {state}{reason} — every such slot runs solo until it is usable',
  'executor-vehicle.differing': 'the placed executor vehicle differs from the body derived from docs/ai/vehicles.json — a hand edit stands until it is re-derived',
  attribution: 'AGENTS.md says attribution off but .claude/settings.json does not hide the harness trailer and PR text',
  'footprint-global': 'legacy kit ignore line(s) sit in {file} — they ignore kit paths in every repository here',
  'family-freshness': '{parts}',
  'adr-store-migration': 'still on the retired 3-tier ADR layout — {shape}',
  'sandbox-masks': '{n} sandbox mask(s) clutter git status — the managed exclude block is absent or stale',
  'sandbox-masks.stale-real': '{n} sandbox mask(s) clutter git status — the exclude block is stale; {m} fenced entr(ies) are REAL paths (a fresh apply drops them)',
  'worktrees-dir': 'write access to the worktrees parent dir {dir} is not confirmed — provision may still stop',
  'worktrees-dir.home': 'the worktrees parent dir {dir} is the home or holds it — the kit grants no write surface there',
  'spec-adoption': 'feature-spec store absent (docs/ai/specs) — no feature contract can govern a plan here yet; seed the store, or record the decline',
  'profile-gap': '{what}',
  'jev-connect': 'Jev (TypeSafe) is not connected: TYPESAFE_API_KEY is not in the environment the agent\'s commands run in',
  'jev-skill': 'Jev\'s vendor skill is not installed for every agent here: a skill root the kit fills is absent or behind the kit\'s pin',
  'jev-skill.earlier': 'Jev\'s vendor skill in the agent skill roots is at {old}, behind the kit\'s pin {new}; only copies matching a kit pin change',
  'spec-adoption.adopting': 'feature-spec store: {n} draft spec(s), no live contract — nothing governs a plan through it yet; land a live contract, or record the decline',
});

// ── the shape contract (D2): registry strings AND composed items stay one line under the cap ────
export const ITEM_LINE_CAP = 140;
export const SKIP_REASON_CAP = 200;

const oneLineOf = (text) => String(text).replace(/\s*[\r\n]+\s*/g, ' ').trim();
// Scalar truncation-with-count — a capped value states what it dropped, never a silent cut.
// GUARANTEED result.length <= cap for every input/budget: when even the count note cannot fit
// the budget, the tail arm hard-slices to a bare ellipsis instead of overflowing.
const truncatedTo = (text, cap) => {
  if (text.length <= cap) return text;
  const note = (dropped) => `… (+${dropped} more chars)`;
  let keep = cap;
  while (keep > 0 && keep + note(text.length - keep).length > cap) keep -= 1;
  if (keep === 0) return cap <= 0 ? '' : `${text.slice(0, cap - 1)}…`;
  return text.slice(0, keep) + note(text.length - keep);
};
// List truncation-with-count: whole leading entries + " (+N more)" for the dropped tail; if even
// the first entry overflows, it is scalar-truncated so the count survives.
const capList = (entries, budget, sep = '; ') => {
  for (let take = entries.length; take >= 1; take -= 1) {
    const joined = entries.slice(0, take).join(sep);
    const tail = take < entries.length ? ` (+${entries.length - take} more)` : '';
    if (joined.length + tail.length <= budget) return joined + tail;
  }
  const tail = entries.length > 1 ? ` (+${entries.length - 1} more)` : '';
  return truncatedTo(entries[0], Math.max(0, budget - tail.length)) + tail;
};
// The char budget a template leaves for its placeholder values.
const templateBudget = (template) => ITEM_LINE_CAP - template.replace(/\{[A-Za-z]+\}/g, '').length;

// ── the frozen benefit registry (fact-true; pinned by tests) ────────────────────────────────────
export const BENEFITS = Object.freeze({
  'velocity-core': 'velocity — routine read-only commands stop prompting while the maintainer is away; all work stays in auto mode',
  'kit-tools-tier': "velocity — the kit's own read-only tools run promptless (audited, resolved-absolute tier)",
  'bridge-tier':
    'velocity — used bridges get <wrapper> * exclusions (codex-exec * if delegated), hosts, state dirs (allowWrite); reviews: code-mode allows',
  'autonomy-policy': 'clarity — the per-activity autonomy policy becomes an explicit, versioned declaration instead of implicit computed defaults',
  'autonomy-render': `velocity — confined commands auto-allow per your declared policy; ${DUAL_SECURITY_BENEFIT}`,
  'sandbox-provision': `velocity — confined ad-hoc commands stop prompting; ${DUAL_SECURITY_BENEFIT}`,
  'review-recipe': 'recipe coverage — the review AND execution recipes you configured actually run instead of silently degrading',
  'gates-declaration': 'velocity — your project’s gates run as ONE declared batch with a PASS/FAIL table',
  'gates-inert': 'honest gates — the declared matrix verifies your project instead of reporting green over a check that ran nothing',
  'source-size': 'maintainability — a module you can hold whole stays reviewable, and size drift becomes recorded, reasoned debt',
  'gate-hook': 'velocity — your own declared gate commands auto-approve byte-exactly (opt-in PreToolUse hook)',
  'commit-guard': 'integrity — commits require the ONE green --final receipt at the exact staged fingerprint (consented pre-commit arm)',
  'hook-checks': 'enforcement — every commit runs the checks armed here, so their findings stop the commit',
  enforcement: 'enforcement — bundled checks and the pre-commit hook keep caps, archives, and the generated index current',
  'read-lane': 'velocity — pipes/chains of your seeded read-only commands auto-approve instead of prompting (opt-in, conservatively classified)',
  'state-block': 'no silent stalls — a turn ending on «you are not needed», or on work it never started, warns at once instead of waiting to be spotted',
  'mcp-channel': 'velocity — path facts and literal searches arrive as typed tool calls whose arguments are JSON fields, never a shell string',
  agents: 'cost and quiet — cheap-model mechanical work, no shell on a read-only vehicle (no prompt flood); the executor carries slices you verify',
  'executor-vehicle': 'carrier readiness — a slot you configured subagent dispatches the subagent it names instead of silently running solo',
  attribution: 'attribution — the harness adds no Co-Authored-By trailer, PR text or session link, as your AGENTS.md block requires',
  'footprint-global': 'hygiene — the legacy machine-global excludes stop ignoring kit paths in every other repository on this host',
  'family-freshness': 'currency — placed family members carry the latest shipped fixes and features',
  'adr-store-migration': 'durability — every decision becomes its own file with a generated navigator, instead of one hand-rotated pile',
  'sandbox-masks': 'zero clutter — a mask git ignores through the block leaves git status; a mount-only one leaves git add -A and the review fingerprint too',
  'worktrees-dir': 'parallel features — the host-specific write allowance or terminal fallback is surfaced before provision',
  'spec-adoption': 'contracts — a plan names the contract it builds to, and a change to a governed slice is visible at review instead of after it',
  'profile-gap': 'full flow — each difference from the reference profile is previewed by its own writer; a declined one returns only at a lineage step',
  'jev-connect': 'decisions — a typed choice with a confidence in under a second for your code and the agent\'s scripts, once for every project here',
  'jev-skill': 'the TypeSafe skill for Claude Code, Codex and Antigravity CLI, one pinned verified copy per agent root, from one command you run',
});
// The one arm whose gain differs from its base item's (BENEFITS stays keyed by item key).
export const VARIANT_BENEFITS = Object.freeze({
  'executor-vehicle.differing': 'carrier fidelity — the placed executor runs the model and effort docs/ai/vehicles.json names, not a hand edit',
  'source-size.layout': 'layout — piles past the layout limits become recorded, reasoned debt, so the commit hook can judge new ones once its layout line is armed',
});

// ── the CLOSED opt-in capability registry (OPT-IN-SHIPS-INVISIBLE) ──────────────────────────────
// 3.14.0 shipped a capability with every surface an AGENT reads and NO advisor entry, so `upgrade`
// told a user their setup was optimal while the thing that had just shipped sat unwired. Every other
// surface of a mode is drift-guarded; the advisor was the one that was not, and it is the only
// surface a user receives PASSIVELY.
//
// Keyed by CAPABILITY, not by mode: a per-mode registry cannot detect a new opt-in added INSIDE an
// already-registered mode (the read-lane belongs to mode `hook`), because the mode set does not move.
// Each id is DECLARED at its point of use in references/modes/<mode>.md and this registry is asserted
// set-equal to those declarations (test/advisor-coverage.test.mjs), mirroring the catalog ⟷ SKILL.md
// ⟷ mode-docs triangle commands.test.mjs already enforces.
//
// Every row carries EXACTLY ONE of `advisorKey` (the offer that observes its unconfigured state) or
// `exempt` (a stated reason it legitimately has none). Adding a capability ADDS a checked row; it
// never widens a blocklist.
export const OPT_IN_CAPABILITIES = Object.freeze([
  { id: 'velocity-core', mode: 'velocity', advisorKey: 'velocity-core' },
  { id: 'kit-tools-tier', mode: 'velocity', advisorKey: 'kit-tools-tier' },
  { id: 'bridge-tier', mode: 'velocity', advisorKey: 'bridge-tier' },
  { id: 'autonomy-render', mode: 'velocity', advisorKey: 'autonomy-render' },
  { id: 'autonomy-policy', mode: 'set-autonomy', advisorKey: 'autonomy-policy' },
  { id: 'sandbox-provision', mode: 'autonomy-doctor', advisorKey: 'sandbox-provision' },
  { id: 'gates-declaration', mode: 'gates', advisorKey: 'gates-declaration' },
  // A DECLARED matrix that verifies nothing is its own capability: the gates-declaration offer
  // converges the moment any gate exists, so it can never observe this state. The advisor key names
  // the state it reports (an inert declaration), the capability names what the user gains.
  { id: 'gates-verification', mode: 'gates', advisorKey: 'gates-inert' },
  // The source-size practice is accepted AS a gate — it needs no mode of its own, and its capability
  // is therefore declared where its declaration lives. It is the DISCOVERY lane for the practice on
  // every deployment, new and existing alike: nothing else tells a project the practice exists.
  { id: 'source-size', mode: 'gates', advisorKey: 'source-size' },
  { id: 'gate-hook', mode: 'hook', advisorKey: 'gate-hook' },
  { id: 'read-lane', mode: 'hook', advisorKey: 'read-lane' },
  { id: 'commit-guard', mode: 'commit-guard', advisorKey: 'commit-guard' },
  { id: 'enforcement', mode: 'bootstrap', advisorKey: 'enforcement' },
  { id: 'hook-checks', mode: 'bootstrap', advisorKey: 'hook-checks' },
  { id: 'attribution', mode: 'bootstrap', advisorKey: 'attribution' },
  { id: 'footprint-global', mode: 'bootstrap', advisorKey: 'footprint-global' },
  { id: 'state-block', mode: 'state-block-guard', advisorKey: 'state-block' },
  { id: 'sandbox-masks', mode: 'sandbox-masks', advisorKey: 'sandbox-masks' },
  { id: 'mcp-channel', mode: 'mcp', advisorKey: 'mcp-channel' },
  { id: 'worktrees-dir', mode: 'worktrees', advisorKey: 'worktrees-dir' },
  { id: 'family-freshness', mode: 'upgrade', advisorKey: 'family-freshness' },
  // The feature-spec layer is delivered by upgrade's spec-layer ensure (there is no specs mode), so
  // its adoption state is declared where the store is seeded.
  { id: 'spec-adoption', mode: 'upgrade', advisorKey: 'spec-adoption' },
  { id: 'full-flow-profile', mode: 'upgrade', advisorKey: 'profile-gap' },
  { id: 'jev-connect', mode: 'jev', advisorKey: 'jev-connect' },
  { id: 'jev-skill', mode: 'jev', advisorKey: 'jev-skill' },
  { id: 'adr-store-migration', mode: 'migrate-adr-store', advisorKey: 'adr-store-migration' },
  { id: 'review-recipe', mode: 'set-recipe', advisorKey: 'review-recipe' },
  // The execute slot is a DISTINCT opt-in from the review slot, and the same probe reports both —
  // which is why the review-recipe benefit is worded for either slot rather than for review alone.
  { id: 'delegated-execution', mode: 'set-recipe', advisorKey: 'review-recipe' },
  { id: 'agents', mode: 'agents', advisorKey: 'agents' },
  // A DISTINCT capability from the offer above: the offer converges the moment nothing is left to
  // PLACE and the review lens matches its derived body, which a customized-but-unusable executor
  // also satisfies — so it can never observe the state that makes a configured subagent carrier run solo.
  { id: 'executor-vehicle', mode: 'agents', advisorKey: 'executor-vehicle' },
  // Exempt, not un-audited. `acceptEdits` auto-applies Edit/Write and auto-runs mkdir/touch/mv/cp:
  // a TRUST-POSTURE change. Velocity presents its full posture at its own consent moment;
  // the bridge tier separately seeds used bridges' allow rules, <wrapper> * exclusions
  // (codex-exec * where delegated), hosts and state dirs (allowWrite).
  {
    id: 'accept-edits',
    mode: 'velocity',
    exempt: 'a trust-posture change (auto-applied edits, auto-run mkdir/touch/mv/cp) — the kit never nudges a user toward weakening their own approval posture; velocity states the full posture at its own consent moment',
  },
  // Exempt for the mirror-image reason: the Fast tier bills at a higher credit rate, so an unprompted
  // offer would be the kit nudging the user to spend money.
  {
    id: 'codex-fast',
    mode: 'bridge-settings',
    exempt: 'a paid SPEND knob (the priority tier bills at a higher credit rate) — the kit never nudges a user toward spending money; bridge-settings surfaces it with its cost caveat when asked',
  },
].map((c) => Object.freeze(c)));

// A typed usage failure (exit 2) — the codebase's typed-error idiom (no classes).
const usageFail = (message) => Object.assign(new Error(message), { exitCode: 2 });

// ── item probes ──────────────────────────────────────────────────────────────────────────────────
// Each probe is independent and wrapped: a throw becomes a stated skipped-item line (never a crash,
// never a fabricated item); returning without adding means "nothing sub-optimal here".

const probeVelocityItems = ({ root, deps, add, skip }) => {
  const applyLine = (extra) => `node ${q(toolPath('velocity-profile.mjs'))} --apply${extra} --cwd ${q(root)}`;
  let preflight;
  try {
    preflight = preflightVelocityProfile({ cwd: root }, deps);
  } catch (err) {
    // One preflight failure (unsafe mode, malformed settings, symlinked .claude) skips all three
    // velocity items with the same stated reason.
    for (const key of ['velocity-core', 'kit-tools-tier', 'bridge-tier']) skip(key, err);
    return;
  }
  // The flagless core plan is pure filters over the successful preflight — it cannot throw, so it
  // deliberately carries NO defensive catch (a dead branch is not honesty; the preflight catch
  // above owns the real failure modes).
  const core = planVelocityProfile(preflight, {});
  if (core.toAdd.length > 0 || core.askToAdd.length > 0) {
    const template = core.toAdd.length === 0 ? WHATS['velocity-core.rule']
      : core.askToAdd.length === 0 ? WHATS['velocity-core'] : WHATS['velocity-core.both'];
    add('velocity-core', fillTemplate(template, { n: core.toAdd.length + core.askToAdd.length }), applyLine(''));
  }
  try {
    const kt = planVelocityProfile(preflight, { kitTools: true });
    if (kt.tierToAdd.length > 0) {
      add('kit-tools-tier', fillTemplate(WHATS['kit-tools-tier'], { n: kt.tierToAdd.length }), applyLine(' --kit-tools'));
    }
  } catch (err) {
    skip('kit-tools-tier', err);
  }
  try {
    const bt = planVelocityProfile(preflight, {
      bridgeTier: true, findWrapper: deps.findWrapper,
      bundleRoot: deps.bundleRoot, readdir: deps.readdir, readFile: deps.readFile,
      detect: deps.detect, env: deps.getenv ?? deps.env, home: deps.home,
    });
    const delta = bt.bridgeToAdd.length + bt.excludedToAdd.length + bt.hostsToAdd.length + bt.dirsToAdd.length;
    if (delta > 0) {
      const entrySeparator = ', ';
      const missing = [
        ['allow rules', bt.bridgeToAdd],
        ['exclusions', bt.excludedToAdd],
        ['hosts', bt.hostsToAdd],
        ['state dirs', bt.dirsToAdd],
      ].filter(([, entries]) => entries.length > 0)
        .map(([kind, entries]) => `${kind}: ${entries.join(entrySeparator)}`).join('; ');
      const executeMissing = [...bt.executeToAdd.excludedCommands, ...bt.executeToAdd.hosts, ...bt.executeToAdd.dirs];
      const executeDetail = executeMissing.length > 0
        ? `; the execution wrapper codex-exec needs: ${executeMissing.join(entrySeparator)}`
        : '';
      const hostCondition = (() => {
        try {
          return sandboxEnabled(preflight.projectSettings.data, preflight.localSettings.data)
            ? ` — once added, wired ${HOST_HONORS_QUALIFIER}`
            : '';
        } catch (err) {
          return ` — host condition unchecked: ${oneLineOf(err?.message ?? String(err))}`;
        }
      })();
      add(
        'bridge-tier',
        fillTemplate(WHATS['bridge-tier'], { n: delta }),
        applyLine(' --bridge-tier'),
        'bridge-tier',
        `missing — ${missing}${executeDetail}${hostCondition}`,
      );
    }
  } catch (err) {
    skip('bridge-tier', err);
  }
};

const probeAutonomyItems = ({ root, deps, add, skip }) => {
  let source = null;
  try {
    let config = null;
    ({ config, source } = loadAutonomy(root, deps.readFile ?? readFileSync, deps.lstat ?? lstatSync));
    // The STRUCTURAL seed (_README-only) declares nothing yet — a render item here would
    // overclaim (codex, Segment B). An EXPLICIT policy declaring the default values is a real
    // declaration: its render check still runs below (codex, Segment B closing).
    if (source !== 'none' && isSparseSeedConfig(config)) return;
    if (source === 'none') {
      add('autonomy-policy', fillTemplate(WHATS['autonomy-policy'], { path: AUTONOMY_REL }), '/agent-workflow-kit set-autonomy (run IN the target project — the conversational writer previews, then writes its docs/ai/autonomy.json)');
    }
  } catch (err) {
    skip('autonomy-policy', err);
    return; // a malformed policy also blocks the render check below — one stated reason is enough
  }
  if (source === 'none') return; // nothing to render-check without a declared policy (not a skip)
  try {
    const check = checkAutonomyProfile({ cwd: root }, deps);
    if (!check.inSync) {
      const drift = capList(check.drift, templateBudget(WHATS['autonomy-render']));
      add('autonomy-render', fillTemplate(WHATS['autonomy-render'], { drift }), `node ${q(toolPath('velocity-profile.mjs'))} --autonomy --apply --cwd ${q(root)}`);
    }
  } catch (err) {
    skip('autonomy-render', err);
  }
};

const probeSandboxProvision = ({ root, deps, add, skip }) => {
  try {
    const p = probeSandboxAvailability(deps);
    if (p.available) return;
    const isExec = deps.isExecutable ?? isExecutableFile;
    const plan = deriveDoctorPlan({ probeResult: p, env: deps.env ?? process.env, isExec });
    const installable = plan.tuple !== null && plan.untrusted.length === 0 && !plan.envMissing
      && ((deps.euid ?? (() => process.geteuid?.()))() === 0 || TRUSTED_DIRS.some((dir) => isExec(join(dir, 'sudo'))));
    const variant = installable ? 'sandbox-provision.installable' : 'sandbox-provision';
    const reason = truncatedTo(oneLineOf(p.reason), templateBudget(WHATS[variant]) - (installable ? plan.tuple.length : 0));
    // The doctor reads process.cwd() (deployment-gated) and takes no --cwd flag — the one-liner
    // pins the target project via a cd prefix (Segment B).
    add('sandbox-provision', fillTemplate(WHATS[variant], { reason, tuple: plan.tuple }),
      `cd ${q(root)} && node ${q(toolPath('autonomy-doctor.mjs'))}`, variant,
      installable ? null : 'on native Windows Claude Code runs no sandbox: this item takes no effect there',
    );
  } catch (err) {
    skip('sandbox-provision', err);
  }
};

const probeReviewRecipe = ({ root, deps, add, skip }) => {
  try {
    // The VALIDATED reader (Segment B): a schema-invalid config (unknown activity/slot,
    // bad recipe) throws here and becomes a stated skip — raw JSON.parse would silently ignore it.
    const { config } = loadConfig(root, deps.readFile ?? readFileSync, deps.lstat ?? lstatSync);
    const readiness = composeReadiness(root, { ...deps, detect: deps.detect ?? (() => detectBackends(deps)), onDetectError: (err) => { throw err; } });
    const degraded = [];
    for (const [activity, def] of Object.entries(ACTIVITIES)) {
      for (const slot of Object.keys(def.slots)) {
        if (config?.[activity]?.[slot] === 'subagent') continue; // the executor vehicle has its own probe
        const r = resolveActivityRecipe({ config, readiness, activity, slot });
        if (r.degradedFrom) degraded.push(`${activity}.${slot}: configured ${r.degradedFrom} degrades to ${r.recipe} (${r.reason})`);
      }
    }
    if (degraded.length > 0) {
      add('review-recipe', fillTemplate(WHATS['review-recipe'], { degraded: capList(degraded, templateBudget(WHATS['review-recipe'])) }),
        userStepOf('review-recipe', root));
    }
  } catch (err) {
    skip('review-recipe', err);
  }
};

const probeGates = ({ root, deps, add, skip, shared }) => {
  try {
    const sg = surveyGateHook(root, deps);
    if (sg.error) throw new Error(sg.error);
    if (sg.declarationPresent && sg.declaredGates === null) throw new Error(sg.declarationError ?? 'gates.json present but unreadable');
    // An ABSENT file and the seeded-EMPTY list are equally undeclared (Segment B); the
    // apply is the consent-gated gates-init PREVIEW (it proposes entries from the project's own
    // scripts and writes only on an explicit yes) — never the runner.
    if (!sg.declarationPresent || sg.declaredGates === 0) {
      // gates-init writes ONLY with --apply — the apply field stays a PURE executable command
      // (run-exactly-as-rendered feeds it to the shell); the two-step preview semantics live in
      // WHAT, never as prose appended to the command.
      add('gates-declaration', fillTemplate(WHATS['gates-declaration'], {}), `node ${q(toolPath('gates-init.mjs'))} --cwd ${q(root)}`);
      return;
    }
    if (!sg.wired) {
      add('gate-hook', fillTemplate(WHATS['gate-hook'], { n: sg.declaredGates }), `node ${q(toolPath('gate-hook.mjs'))} --apply --cwd ${q(root)}`);
      return;
    }
    // D8 — the marker REFRESH path. The placed hook validates the declaration through its OWN baked
    // copy and goes dark on any key it does not know (auto-approval off, every gate prompts again),
    // so a declaration carrying the marker key under a hook that predates it silently switches a
    // CONFIGURED capability off with no error anywhere. Deliberately marker-SCOPED: a stale hook is
    // otherwise harmless, and nagging every deployment about hook bytes is not this item's job.
    if (!declarationCarriesMarker(root, deps)) return;
    // Throws on a symlink / directory / unreadable target → the stated skip, never a wrong verdict.
    // ABSENT is not this arm either: a hook that is not placed belongs to the place offers above and
    // in the read-lane item, whose recovery actually places one.
    if (readPlacedHookCurrency(root, deps) !== HOOK_CURRENCY.STALE) return;
    // The writer's OWN stale recovery: `gate-hook --apply --reseed` replaces the placed hook with
    // the bundle in place — the one consented replacement; the slot renders it behind the check.
    // The RESULT is what the read-lane item defers to — not these conditions re-derived there. Both
    // probes read the placed hook independently, so a hook that changes between the two reads would
    // otherwise let each conclude the other owns it and leave a dark lane reported by nobody.
    shared.markerStaleRendered = add(
      'gate-hook',
      fillTemplate(WHATS['gate-hook.marker-stale'], {}),
      `node ${q(toolPath('gate-hook.mjs'))} --apply --reseed --cwd ${q(root)}`,
      'gate-hook.marker-stale',
    );
  } catch (err) {
    skip('gate-hook', err);
  }
};

// The INERT-DECLARATION item: a gate matrix that is declared, runs green, and verifies nothing.
// Both causes are read off the DECLARATION through the same predicates the runner and the fill
// decide with — the checker side through canonicalCheckerGates, the producer side through the
// closed matchesCoverageProducer — so the advisor can never disagree with what --final accepts.
//
// A declared CHECKER is answered first and alone, in the arms below: the DOMAIN arm when the pair is
// live, the marker arm when no producer exists anywhere on a tree the domain cannot reach, and cause
// A — the dead or mis-ordered pair — otherwise. Its remedy also resolves cause B, because a producer
// gate is not a kit checker. Cause A's apply follows what the FILL can actually do, which the
// D-8 placement rule changed: when the checker is the declaration's LAST gate and the project's own
// scripts yield an offerable producer, the fill now PLACES that producer before the checker, so the
// remedy is the ordinary consent-gated preview. Where no offerable producer exists, or the checker
// is not last, the arm is the user item `gates-inert.unfillable` — the edit is the project's own,
// because the fill never reorders entries it did not write.
//
// An ABSENT or EMPTY declaration belongs to the gates-declaration item; a malformed one throws out
// of the validated reader and becomes this probe's stated skip, never a guess.
// ONE rule for every fill preview this item renders: name only the entries the fill would ACCEPT.
// An id the declaration already carries is refused as a collision, so an unrestricted preview hands
// the reader a lane that cannot converge — and both arms of this item render over a declaration that
// already carries at least one gate the offer also proposes, so both need the rule. With nothing
// selectable the bare preview is still the honest render: its own notes say why.
const fillPreviewFor = (root, ids) =>
  `node ${q(toolPath('gates-init.mjs'))} --cwd ${q(root)}${ids.map((id) => ` --only ${id}`).join('')}`;

// The census, injectable WHOLE and only whole. Forwarding this probe's `deps` into the leaf would
// hand it whatever `spawn` another probe's fixture happens to inject, so a masks-probe stub would
// silently become this probe's git — the census takes its own default and a test replaces the
// function, never its seams. It THROWS on an unavailable tree; each call site below decides what
// that means there, because the two arms have different honest answers and one global fallback
// would be wrong for one of them.
const readCensus = (root, deps) => (deps.takeCensus ?? takeCensus)(root);

export const probeGatesInert = ({ root, deps, add, skip }) => {
  try {
    const declaration = loadDeclaration(root, deps);
    if (declaration.outcome === 'missing') return;
    const gates = declaration.gates;
    if (gates.length === 0) return;
    const checkers = canonicalCheckerGates(gates, root);
    if (checkers.length > 0) {
      // ORDER decides, through the declaration's own shared predicate: a producer declared AFTER the
      // checker leaves it just as inert as no producer at all (it reads nothing, or stale bytes), and
      // only --final refuses that shape — a plain run reports every gate PASS.
      if (coverageProducerPrecedes(gates, gates.indexOf(checkers[0]))) {
        // The pair is LIVE, and that is exactly where the DOMAIN question becomes the honest one: the
        // checker's changed-line domain is `.mjs/.cjs/.js` by design, so on a tree dominated by what
        // that domain excludes, "certified" means "certified over the assessable minority". An
        // UNAVAILABLE census throws out of here into the stated-skip lane — no census, no optimality
        // claim; this is the ONE arm where nothing else would render, so a silent return would be the
        // false green one layer down.
        const census = readCensus(root, deps);
        if (census.verdict !== CENSUS_VERDICT.NARROW) return; // the domain reaches this tree — converged
        // The ack binds the FACT (verdict + the sorted unsupported extensions), never the counts: a
        // count-bound ack would re-fire on every added file and turn the acknowledgment into a nag.
        const fingerprint = factFingerprint(censusFact(census));
        if (readAckValue(root, deps, ACKS_COVERAGE_DOMAIN_KEY) === fingerprint) return; // acknowledged
        const ext = capList(census.unsupportedExtensions, templateBudget(WHATS['gates-inert.coverage-domain-narrow']), ', ');
        add(
          'gates-inert',
          fillTemplate(WHATS['gates-inert.coverage-domain-narrow'], { ext }),
          `node ${q(toolPath('ack-write.mjs'))} --lane coverage-domain --fingerprint ${fingerprint} --cwd ${q(root)}`,
          'gates-inert.coverage-domain-narrow',
        );
        return;
      }
      // The fill's own answer is needed BEFORE the arms split, because one of them makes a claim
      // about it. The PRODUCER entry is kept, not just its existence: a rendered preview must name it
      // with --only. A whole-offer apply collides by construction — the declaration already carries
      // the checker, and the offer carries it too — so an unrestricted preview would hand the reader
      // a lane that refuses instead of the one entry that resolves what the item just reported.
      // Read once and asked TWO different questions, because the two arms need different ones. The
      // fill's selectable entry is collision-filtered: an id the declaration already carries is
      // refused, so counting it would render a preview that cannot fix what the item just reported.
      // The EXPRESSIBILITY question is not filtered at all — a `node --test` script whose offered id
      // happens to be taken is still a suite the recognized producer set can express, and the narrow
      // arm's sentence would be false over it. An offer computation that throws reaches the probe's
      // stated-skip lane, which is the honest answer to "can the fill help here" when nobody knows.
      const declaredIds = new Set(gates.map((gate) => gate.id));
      const offered = buildOffer(root, deps).entries.filter((entry) => matchesCoverageProducer(entry.cmd));
      const producer = offered.find((entry) => !declaredIds.has(entry.id));
      // The dead pair on a tree the recognized producer set cannot speak for. It is deliberately NOT
      // the ordering arm: a producer that EXISTS but sits after the checker is one MOVE away from
      // working, and prescribing the marker there would teach the wrong fix — so this arm requires
      // no producer ANYWHERE in the declaration. The ack lane is closed to it on purpose: a dead pair
      // is broken, not narrow, and removing a producer after an acknowledgment lands right back here.
      //
      // The canonical checker ROWS are excluded from that search, and the exclusion is load-bearing:
      // producer-ness is POSITIONAL everywhere else in this family precisely so a marker on the
      // checker cannot self-pair, and an "anywhere" test without the exclusion re-opens exactly that
      // hole — a checker carrying its own marker would read as its own producer and route a dead pair
      // into the ordering arm.
      //
      // An OFFERED producer also disqualifies this arm, and that is the sharper condition of the
      // two. The census answers how much of the tree the coverage DOMAIN reaches; it says nothing
      // about producers at all. A TS-dominated project whose package.json still carries a
      // `node --test` script has both facts at once, and the arm must not fire over it. The test is
      // the UNFILTERED offer, not the fill's selectable entry: a collision on the offered id blocks
      // the preview without making the producer one bit less real.
      //
      // STATED RESIDUAL, and the reason this arm no longer claims INEXPRESSIBILITY: the fill screens
      // by terminating-class script NAME before it ever looks at a body, so `"ci": "node --test"` is
      // a recognizable producer the offer never carries. The arm therefore says only what it knows —
      // nothing declares one and nothing offers one — and its apply names that gap, because the
      // remedy there is a hand-declared gate rather than the marker.
      if (offered.length === 0 && !gates.some((gate) => !checkers.includes(gate) && isCoverageProducerGate(gate))) {
        // An UNAVAILABLE census is NOT a skip here. The dead pair is a defect on any tree, and the
        // arm below states it truthfully — falling through keeps a non-git deployment byte-identical
        // to what it saw before this outcome existed, and still renders an item, so the flow-optimal
        // line stays blocked either way. Only THAT failure is absorbed: the census leaf tags its own
        // unavailability, and a bug reaching here would otherwise be laundered into an ordinary
        // diagnosis instead of surfacing.
        const narrow = (() => {
          try {
            return readCensus(root, deps).verdict === CENSUS_VERDICT.NARROW;
          } catch (err) {
            if (err?.code === 'CENSUS_UNAVAILABLE') return false;
            throw err;
          }
        })();
        if (narrow) {
          const id = truncatedTo(oneLineOf(checkers[0].id), templateBudget(WHATS['gates-inert.producer-unrecognized']));
          add(
            'gates-inert',
            fillTemplate(WHATS['gates-inert.producer-unrecognized'], { id }),
            userStepOf('gates-inert.producer-unrecognized', root),
            'gates-inert.producer-unrecognized',
            `${id} has no producer declared and none offerable — the fill offers only terminating-class script names, so a recognized body under another name (a "ci" script running node --test) is declared as its own gate entry, never marked`,
          );
          return;
        }
      }
      const id = truncatedTo(oneLineOf(checkers[0].id), templateBudget(WHATS['gates-inert']));
      // The fill can only help when it would land the producer in the right place: the checker must
      // be LAST (that is the one position the placement rule inserts before) and the offer must
      // actually carry a producer the fill would ACCEPT (computed above).
      const checkerIsLast = checkers[0] === gates[gates.length - 1];
      // THREE ways the fill cannot help, and each needs its own sentence, because each names a
      // different edit for the reader to make. A checker that is not last blocks a placement even
      // when a producer is offerable — that is about POSITION, so it leads. An offered producer whose
      // id is already taken is not an absent one: the suite is expressible and the fill is merely
      // refused on the collision, so naming the conflicting id turns a dead end into a rename. Only
      // with neither of those is "no offerable producer exists here" a true sentence.
      const colliding = producer === undefined ? offered.find((entry) => declaredIds.has(entry.id)) : undefined;
      const blocked = !checkerIsLast
        ? `${id} is not the LAST declared gate, so there is no trailing position to place a producer before, and the fill never reorders entries it did not write`
        : colliding !== undefined
          ? `a producer IS offerable here, but its id "${colliding.id}" is already declared, so the fill refuses it as a collision — rename that gate, or repoint it at the producer form`
          : `no offerable producer exists here, and the fill never reorders entries it did not write`;
      if (checkerIsLast && producer) {
        add('gates-inert', fillTemplate(WHATS['gates-inert'], { id }), fillPreviewFor(root, [producer.id]));
        return;
      }
      add('gates-inert', fillTemplate(WHATS['gates-inert.unfillable'], { id }), userStepOf('gates-inert.unfillable', root),
        'gates-inert.unfillable', blocked);
      return;
    }
    // The source-size checker is one of the kit's OWN checkers, and it is deliberately NOT
    // review-dependent (it needs no receipt), so the review-dependent predicate alone cannot see it.
    // Left out, a matrix of nothing but that gate reads as carrying project verification — and a
    // project that just adopted the practice and declared nothing else would be told it is optimal.
    if (gates.every((gate) => isKitOwnedCheckerGate(gate, root))) {
      const declaredIds = new Set(gates.map((gate) => gate.id));
      // Only PROJECT-verification entries: a non-colliding entry is not enough, it has to be one
      // that RESOLVES the item, and declaring one more kit checker converges nothing — the item
      // would simply fire again on the next run.
      const selectable = buildOffer(root, deps).entries
        .filter((entry) => !declaredIds.has(entry.id) && !isKitOwnedCheckerGate(entry, root))
        .map((entry) => entry.id);
      add(
        'gates-inert',
        fillTemplate(WHATS['gates-inert.no-verification'], { n: gates.length }),
        fillPreviewFor(root, selectable),
        'gates-inert.no-verification',
      );
    }
  } catch (err) {
    skip('gates-inert', err);
  }
};

// The SOURCE-SIZE offer (baseline-practices Plan 1). This is the practice's ONE discovery lane: the
// checker ships with the kit and, until a project declares its own scope, judges no file's lines, so
// without this item a deployment would never learn the practice exists — the same
// OPT-IN-SHIPS-INVISIBLE failure the capability registry was built for. New and existing deployments
// meet it identically, because the advisor section is mandatory at every upgrade.
//
// The probe asks what each declared cmd CLAIMS about this checker, in the three named outcomes —
// because the boolean it used to ask made a DELIBERATELY VENDORED copy read as "no source-size gate
// at all", and the remedy that false absence rendered (`--adopt`) then collides on the very id
// already in the declaration. It deliberately does NOT key on the config's state to decide WHETHER
// to speak: a project with no config is exactly the project that needs to hear about the practice,
// and the apply's own refusal is what teaches the one manual step (authoring the scope). A missing
// declaration is not a skip — there is no source-size gate in it either.
//
// Precedence over a MIXED declaration is pinned and deterministic: any canonical match answers the
// practice question outright; else any tool-elsewhere claim; else the id collision; else the offer.
// A MINTED schema-1 config is asked first, ahead of the gate arms: the check stops on it whatever is
// declared. Its line carries no reason, since a pinned one would launder a raise; an unreadable
// config keeps today's arms, which report it.
const schema1Minted = (root, deps) => {
  try { const { state, config } = loadSourceSizeConfig(root, deps); return state === 'minted' && config.schema === 1; } catch { return false; }
};

// The layout setup's answer for the layout arm; its throw is a stated skip, and the other arms still speak.
const layoutSetupOrSkip = (root, deps, skip) => {
  try {
    return readLayoutSetup(root, deps);
  } catch (err) {
    skip('source-size.layout', err);
    return null;
  }
};

const probeSourceSize = ({ root, deps, add, skip, shared }) => {
  try {
    const tool = toolPath('source-size-check.mjs');
    if (schema1Minted(root, deps)) {
      add('source-size', fillTemplate(WHATS['source-size.schema-1'], {}), `node ${q(tool)} --write-baseline --cwd ${q(root)}`, 'source-size.schema-1');
      return;
    }
    // The layout arm, additive: the record renders as its own item ahead of the other arms; a held answer
    // no other arm speaks for is a stated skip, so the item's absence is explained in the run it goes.
    const setup = layoutSetupOrSkip(root, deps, skip);
    if (setup?.answer === 'record') {
      shared.layoutRecord = add('source-size', fillTemplate(WHATS['source-size.layout'], {}),
        `node ${q(tool)} ${setup.args.map(q).join(' ')} --cwd ${q(root)}`, 'source-size.layout', LAYOUT_RECORD_RECIPE);
    } else if (setup?.answer === 'held' && Object.hasOwn(LAYOUT_HELD, setup.reason)) skip('source-size.layout', new Error(LAYOUT_HELD[setup.reason](setup)));
    const declaration = loadDeclaration(root, deps);
    const gates = declaration.outcome === 'loaded' ? declaration.gates : [];
    // The reason string is PINNED, not composed: it is copied unchanged into every entry the first
    // mint records, and a first mint records the whole tree — so "this is what the tree already
    // carried when the practice arrived" is the one sentence that is true of all of them.
    const adoptLine = `node ${q(tool)} --adopt --reason "${INITIAL_ADOPTION_REASON}" --cwd ${q(root)}`;
    const claims = gates.map((gate) => ({ gate, claim: classifySourceSizeGate(gate.cmd, root) }));
    const canonical = claims.filter((c) => c.claim === CHECKER_CLAIM.CANONICAL);
    const elsewhere = claims.filter((c) => c.claim === CHECKER_CLAIM.ELSEWHERE);
    if (canonical.length > 0 || elsewhere.length > 0) {
      // A DECLARED gate is not the same fact as a working one: the checker refuses an authored or
      // half-written record, so a gate declared over one reds the matrix on every run, and over an
      // absent one it judges layout alone and no line. The declaration alone would report that deployment
      // as adopted and say nothing about the one thing wrong with it. The split changes NOTHING here —
      // the outcome, its attention class and its immunity to every ack are the same whichever copy runs.
      const { state } = loadSourceSizeConfig(root, deps);
      if (state !== 'minted') {
        // Only the way OUT differs. With the gate declared through another copy, `--adopt` would
        // mint the record and then be refused by the fill on the id it is already looking at, so the
        // rendered verb is the mint alone: the declaration is not the half that is missing.
        const mintLine = `node ${q(tool)} --write-baseline --reason "${INITIAL_ADOPTION_REASON}" --cwd ${q(root)}`;
        add(
          'source-size',
          fillTemplate(WHATS['source-size.unminted'], { state }),
          canonical.length > 0 ? adoptLine : mintLine,
          'source-size.unminted',
        );
        return;
      }
      if (canonical.length > 0) return; // adopted through THIS copy and armed — converged
      // A vendored copy is a deployment CHOICE, not a defect: the practice runs, the realpath anchor
      // simply cannot see it as this advisor's own sibling (and never widens — that anchor is what
      // keeps a lookalike from certifying). So the convergence is an acknowledgment, never `--adopt`.
      // The fingerprint binds the claims as AUTHORED, sorted and de-duplicated — not the resolved
      // realpaths, which are machine-specific and would churn a committed ack between machines.
      const fingerprint = factFingerprint(JSON.stringify([...new Set(elsewhere.map((c) => c.gate.cmd))].sort()));
      if (readAckValue(root, deps, ACKS_SOURCE_SIZE_COPY_KEY) === fingerprint) return; // acknowledged
      add(
        'source-size',
        fillTemplate(WHATS['source-size.adopted-elsewhere'], { n: elsewhere.length }),
        `node ${q(toolPath('ack-write.mjs'))} --lane source-size-copy --fingerprint ${fingerprint} --cwd ${q(root)}`,
        'source-size.adopted-elsewhere',
      );
      return;
    }
    // The id SQUATTER — the id says the practice is declared, the cmd is not this checker under any
    // reading. `--adopt` here mints the record and is then refused by the fill on the id collision:
    // correct against a squatter, and useless as a RENDERED remedy, so this arm is a user item whose
    // step names the edits that actually resolve it.
    if (gates.some((gate) => gate.id === SOURCE_SIZE_GATE_ID)) {
      add('source-size', fillTemplate(WHATS['source-size.id-squatter'], {}), userStepOf('source-size.id-squatter', root),
        'source-size.id-squatter');
      return;
    }
    add('source-size', fillTemplate(WHATS['source-size'], {}), adoptLine);
  } catch (err) {
    skip('source-size', err);
  }
};

// The D10 consumer surface: once the declaration is FINAL-capable (the canonical core checks
// present, the checker LAST — the run-gates helper is the one home of that rule), offer the
// consented commit-guard install — for a MANAGED guardless pre-commit hook AND for an absent one
// alike; an UNMANAGED hook is a loud skip naming the user's own step (never an overwrite offer); a
// non-final-capable declaration gets NO offer (an armed guard over a matrix that cannot mint a
// receipt would block every commit).
// The advisor asks git under its own process env; only the commit-guard apply passes the installer's.
const readHookState = (root, deps) => {
  const hook = readPreCommitState(root, { ...deps, env: undefined });
  if (hook.state === 'unreadable') throw new Error(`${hook.path} is unreadable (${hook.code}) — the pre-commit hook cannot be judged`);
  return hook;
};
const formsApply = (variant, root) => consoleArgv(variant, { toolsDir: HERE, root }).apply.map(q).join(' ');
const probeCommitGuard = ({ root, deps, add, skip }) => {
  try {
    const read = deps.readFile ?? readFileSync;
    const gatesRaw = (() => {
      try {
        return String(read(join(root, 'docs', 'ai', 'gates.json'), 'utf8'));
      } catch {
        return null;
      }
    })();
    if (gatesRaw === null) return; // undeclared — the gates-declaration item owns that story
    const gates = JSON.parse(gatesRaw).gates;
    if (!isFinalCapableDeclaration(gates, root)) return; // no receipt to guard yet — no offer
    const installer = join(root, 'scripts', 'install-git-hooks.mjs');
    if (!(deps.exists ?? existsSync)(installer)) {
      skip('commit-guard', new Error(enforcementAdmits(root, deps) ? COMMIT_GUARD_INSTALLER_VIA_ITEM : COMMIT_GUARD_INSTALLER_OWN_STEP));
      return;
    }
    const { state, armed } = readHookState(root, deps);
    if (armed || state === 'no-hooks-dir') return; // armed (managed or not), or not a git tree — converged
    if (state === 'unmanaged') {
      skip('commit-guard', new Error(COMMIT_GUARD_UNMANAGED_HOOK));
      return;
    }
    add('commit-guard', fillTemplate(WHATS['commit-guard'], {}), formsApply('commit-guard', root));
  } catch (err) {
    skip('commit-guard', err);
  }
};

// The hook-checks offer: the commit-guard probe's shape over the two answers the leaf asks, on disk.
const HOOK_CHECK_NAMES = { rules: 'project-rules check', layout: 'layout check', both: 'project-rules and layout checks' };
const probeHookChecks = ({ root, deps, add, skip, shared }) => {
  try {
    if (!(deps.exists ?? existsSync)(join(root, 'docs', 'ai'))) return;
    const unsafe = unsafeToolsPath(HERE);
    if (unsafe !== null) throw new Error(unsafe);
    const hook = readHookState(root, deps);
    if (hook.state === 'no-hooks-dir') return;
    const roles = plannedRoles(hookCheckAnswers(root, deps), hook).map(({ key }) => key);
    const waits = shared.layoutRecord === true && !hook.layoutArmed && !roles.includes('layout');
    if (roles.length === 0 && !waits) return;
    if (hook.state === 'unmanaged') throw new Error(HOOK_CHECKS_UNMANAGED_HOOK);
    if (!(deps.exists ?? existsSync)(join(root, 'scripts', 'install-git-hooks.mjs'))) {
      throw new Error(enforcementAdmits(root, deps) ? COMMIT_GUARD_INSTALLER_VIA_ITEM : COMMIT_GUARD_INSTALLER_OWN_STEP);
    }
    const keys = [...roles, ...(waits ? ['layout'] : [])];
    const checks = HOOK_CHECK_NAMES[keys.length === 2 ? 'both' : keys[0]];
    add('hook-checks', fillTemplate(WHATS['hook-checks'], { checks }), formsApply('hook-checks', root), 'hook-checks', waits ? HOOK_CHECKS_WAIT : null);
  } catch (err) {
    skip('hook-checks', err);
  }
};

const readEnforcementNode = (path, lstat) => {
  try {
    return lstat(path);
  } catch (err) {
    if (err?.code === ABSENT_CODE) return null;
    throw new Error(`${path}: ${err?.code ?? err?.message ?? err}`);
  }
};

// The enforcement offer's one admission: true when the item renders, false when nothing renders, and
// a throw names the skip.
const enforcementOffer = (root, deps) => {
  const lstat = deps.lstat ?? lstatSync;
  const docsAi = join(root, 'docs', 'ai');
  const docsAiNode = readEnforcementNode(docsAi, lstat);
  if (docsAiNode === null) return false;
  if (!docsAiNode.isDirectory()) throw new Error(`${docsAi} is not a plain directory`);
  const evidence = probeNodeEvidence(root, lstat);
  if (evidence.state === NODE_EVIDENCE.PACKAGE_JSON || evidence.state === NODE_EVIDENCE.DEPLOYED_SCRIPTS) return false;
  if (evidence.state === NODE_EVIDENCE.UNREADABLE) throw new Error(`${root}: ${evidence.error}`);
  if (evidence.state !== NODE_EVIDENCE.NONE) throw new Error(`unknown Node-evidence state: ${evidence.state}`);
  if (evidence.wrongKind.length > 0) throw new Error(join(root, evidence.wrongKind[0]));
  const readDir = deps.readdir ?? readdirSync;
  const bundleRoot = deps.scriptsBundleRoot ?? ENFORCEMENT_BUNDLE_ROOT;
  const bundleBasenames = readDir(bundleRoot).filter((name) => name.endsWith('.mjs')).sort();
  if (NODE_EVIDENCE_SCRIPTS.some((name) => !bundleBasenames.includes(name))) throw new Error(`${bundleRoot}: a runnable enforcement script is missing`);
  const scripts = join(root, 'scripts');
  const scriptsNode = readEnforcementNode(scripts, lstat);
  if (scriptsNode !== null && !scriptsNode.isDirectory()) throw new Error(`${scripts} is not a plain directory`);
  for (const basename of scriptsNode === null ? [] : bundleBasenames) {
    const destination = join(scripts, basename);
    if (readEnforcementNode(destination, lstat) === null) continue;
    throw new Error(`${destination} already exists; the enforcement copy would clobber it`);
  }
  if (readHookState(root, deps).state === 'unmanaged') throw new Error(ENFORCEMENT_UNMANAGED_HOOK);
  return true;
};

export const enforcementAdmits = (root, deps = {}) => {
  try {
    return enforcementOffer(root, deps);
  } catch {
    return false;
  }
};

export const probeEnforcement = ({ root, deps, add, skip }) => {
  try {
    if (enforcementOffer(root, deps)) add('enforcement', ENFORCEMENT_WHAT, formsApply('enforcement', root));
  } catch (err) {
    skip('enforcement', err);
  }
};

// The read-lane offer (AD-055 Part II, Help-through-Recommendations): once the gate hook is PLACED
// and WIRED, offer to enable the opt-in read-only compound lane. Mutually exclusive with the
// gate-hook item BY CONSTRUCTION — that item keys on `!wired`, this one on `wired` — so an unplaced
// or un-wired hook is covered there, never double-offered here. The apply is the gate-hook
// --read-lane PREVIEW one-liner (its own currency check + posture note fire at the writer; it may
// prompt once — it IS a consent flow). Converges once lanes.json enables the lane.
const probeReadLane = ({ root, deps, add, skip, shared }) => {
  try {
    const sg = surveyGateHook(root, deps);
    if (sg.error) throw new Error(sg.error);
    if (!sg.wired) return; // not wired → the gate-hook item covers (no double-fire)
    // Wired but the placed hook FILE is missing — the hook errors on every Bash call and the lane
    // is silently dark; surface it as attention with a place-first recovery (council R2-M2).
    const placeRecovery = () =>
      add('read-lane', fillTemplate(WHATS['read-lane.missing'], {}), `node ${q(toolPath('gate-hook.mjs'))} --apply --cwd ${q(root)}`, 'read-lane.missing');
    if (!sg.filePlaced || readsAbsent(deps, join(root, GATE_HOOK_REL))) {
      placeRecovery();
      return;
    }
    if (readReadLaneToggle(root, deps)) {
      // The lane is ON: converged IFF the placed hook is byte-current — a stale (pre-1.48) hook never
      // reads lanes.json, so the enabled lane is a silent no-op the user must reseed (council B7). The
      // reseed route pins the ABSOLUTE root (council R2-M3), so running it from any cwd can only
      // replace this repo's hook.
      const currency = readPlacedHookCurrency(root, deps);
      if (currency === HOOK_CURRENCY.CURRENT) return; // converged
      if (currency === HOOK_CURRENCY.ABSENT) {
        // The survey saw it placed and it is gone by the time we read it. The missing arm is the
        // honest report of that; a reseed recovery, which refuses an absent hook, is not.
        placeRecovery();
        return;
      }
      // ONE render per condition — and the item that renders is the one whose CAUSE is true. A hook
      // that postdates the read-lane but predates the marker key reads lanes.json perfectly well, so
      // this arm's "an old hook never reads lanes.json" would be a false diagnosis over it, while the
      // marker arm's is exact. Both carry the same reseed recovery, so deferring costs
      // the reader nothing and buys a true sentence. The condition is that the marker arm REALLY
      // rendered — never the conditions it would have used, re-derived here: each probe reads the
      // placed hook itself, so a hook changing between the two reads could otherwise have both defer
      // to the other and leave the dark lane reported by nobody.
      if (shared.markerStaleRendered === true) return;
      add(
        'read-lane',
        fillTemplate(WHATS['read-lane.stale'], {}),
        `node ${q(toolPath('gate-hook.mjs'))} --apply --reseed --cwd ${q(root)}`,
        'read-lane.stale',
      );
      return;
    }
    add('read-lane', fillTemplate(WHATS['read-lane'], {}), `node ${q(toolPath('gate-hook.mjs'))} --read-lane --cwd ${q(root)}`);
  } catch (err) {
    skip('read-lane', err);
  }
};

// The state-block-guard offer (AD-075 · OPT-IN-SHIPS-INVISIBLE). This item exists because its absence
// fired: 3.14.0 shipped the detector with a mode doc, a catalog row and a README row — and no advisor
// entry — so `upgrade` reported «nothing is broken» to a user who did not have it. Its writer is
// state-block-hook.mjs; convergence is that leaf's own isStopHookWired over both settings files.
const probeStateBlockHook = ({ root, deps, add, skip }) => {
  try {
    const project = readSettingsFile(join(root, SETTINGS_FILE), { ...deps, cwd: root });
    const local = readSettingsFile(join(root, SETTINGS_LOCAL_FILE), { ...deps, cwd: root });
    if (isStopHookWired(project.data) || isStopHookWired(local.data)) return; // converged
    add(
      'state-block',
      fillTemplate(WHATS['state-block'], {}),
      `node ${q(toolPath('state-block-hook.mjs'))} --apply --cwd ${q(root)}`,
    );
  } catch (err) {
    skip('state-block', err);
  }
};

// The cheap-agents offer (OPT-IN-SHIPS-INVISIBLE). This item exists because the coverage registry
// surfaced its absence: `agents` is the family's SECOND `.claude/` writer, the `help` Tune tail
// advertises it, and the advisor had no entry for it — so a user who never runs `help` never learned
// it existed while the advisor reported the deployment optimal. Found by the guard, not by an incident.
// A PLACE action and the bundled review lens's `re-derive` (its placed body differs from the one derived from docs/ai/vehicles.json) count as gaps: `already-current` is converged; a customized read-only vehicle or derived lens is
// the user's own edit the writer never clobbers and the advisor never nags about; the executor is not preserved but re-derived from docs/ai/vehicles.json (its `re-derive` answer is not a gap of this offer).
const probeCheapAgents = ({ root, deps, add, skip }) => {
  try {
    const fs = readFsDeps(deps);
    const answer = readVehicles(root, fs.readFile, fs.lstat);
    const { posture, reason } = resolveExecutor(answer);
    if (posture === null) {
      skip('agents', new Error(`${reason} — fix that file first`));
      return;
    }
    const derived = [executorTemplate(posture, deps), reviewLensTemplate(resolveReviewLens(answer).posture, deps)];
    const preflight = preflightCheapAgents({ cwd: root, derived }, deps);
    // The writer refuses below the expected lineage, so offering its command would hand the user a
    // guaranteed failure — the honest surface is a stated skip naming the recovery.
    if (!preflight.stampOk) {
      skip('agents', new Error(`not a deployed agent-workflow project at the current lineage (found ${preflight.stamp ?? 'none'}) — run upgrade first`));
      return;
    }
    const toPlace = preflight.plan.filter((item) => item.action === 'place');
    const lensRederive = preflight.plan.some((item) => item.name === REVIEW_LENS_VEHICLE && item.action === 're-derive');
    if (toPlace.length === 0 && !lensRederive) return; // converged
    // The writer's contract is «--dry-run first, ALWAYS» (references/modes/agents.md, and its stated
    // invariant «preview by default»), so the rendered line is the PREVIEW — this item joins the
    // dry-run-preview class the mode doc already documents for the gates-declaration seeder, where the
    // same confirmation then runs the follow-up the preview prints. Rendering --apply here would have
    // skipped the per-vehicle plan the user is supposed to see before consenting.
    // The hidden-mode reconcile rides the detail, never the apply line: it is wrong to run on a
    // VISIBLE deployment, and the apply slot must stay one pure executable command.
    const executors = toPlace.filter((item) => item.name === EXECUTOR_VEHICLE).length;
    add('agents', fillTemplate(WHATS[lensRederive ? 'agents.lens-rederive' : 'agents'], { n: toPlace.length, ex: executors, ro: toPlace.length - executors }),
      `node ${q(toolPath('cheap-agents.mjs'))} --cwd ${q(root)}`, 'agents',
      `hidden-mode deployments only: after the --apply the preview prints, run node ${q(toolPath('hide-footprint.mjs'))} --dir ${q(root)} --reconcile so the placed .claude/agents/ stays invisible to git status`,
    );
  } catch (err) {
    skip('agents', err);
  }
};

// The subagent carrier's ONE instrument (contract: kit/carriers). Neither neighbour can report this
// state: `probeReviewRecipe` skips a slot configured `subagent` by construction, and the offer above
// judges only what is left to PLACE and the bundled lens's re-derive — a customized-but-broken executor
// gives it neither. So a project could declare the carrier and have every such slot run solo, unseen.
const VEHICLE_BROKEN_STATES = Object.freeze(['missing', 'unusable']);

const writerBlock = (root, deps) => {
  try {
    preflightCheapAgents({ cwd: root }, deps);
    return null;
  } catch (err) {
    return safeLine(err?.message ?? String(err));
  }
};

const HIDDEN_AGENTS_FOLLOW_UP = (root) => `hidden-mode deployments only: after the apply, run node ${q(toolPath('hide-footprint.mjs'))} --dir ${q(root)} --reconcile so the placed .claude/agents/ stays invisible to git status`;

const probeExecutorVehicle = ({ root, deps, add, skip }) => {
  if (renderBrokenExecutor({ root, deps, add, skip })) return;
  try {
    if (!executorBodyDiffers(root, deps)) return;
    const plan = writeCheapAgents({ cwd: root, dryRun: true }, deps);
    if (!plan.stampOk) throw new Error(`run /agent-workflow-kit upgrade first (deployment stamp ${plan.stamp ?? 'none'}, expected ${EXPECTED_WORKFLOW_VERSION})`);
    add('executor-vehicle', WHATS['executor-vehicle.differing'], formsApply('executor-vehicle.differing', root),
      'executor-vehicle.differing', HIDDEN_AGENTS_FOLLOW_UP(root));
  } catch (err) {
    skip('executor-vehicle', err);
  }
};

const renderBrokenExecutor = ({ root, deps, add, skip }) => {
  try {
    // The VALIDATED reader, as probeReviewRecipe uses it: a schema-invalid config is a stated skip,
    // never an item computed over a shape nothing accepted.
    const { config } = loadConfig(root, deps.readFile ?? readFileSync, deps.lstat ?? lstatSync);
    const configured = Object.entries(ACTIVITIES).flatMap(([activity, def]) =>
      Object.keys(def.slots).filter((slot) => config?.[activity]?.[slot] === 'subagent'));
    if (configured.length === 0) return false;
    const survey = (deps.surveyVehicle ?? surveyExecutorVehicle)(root, deps);
    if (!VEHICLE_BROKEN_STATES.includes(survey.state)) return false;
    const reason = safeLine(survey.reason ?? '');
    const { posture, reason: settingsReason } = readExecutorPosture(root, deps);
    const stamp = readStamp(join(root, WORKFLOW_STAMP), readFsDeps(deps));
    const preconditions = [
      ...(stamp === EXPECTED_WORKFLOW_VERSION ? [] : [`run /agent-workflow-kit upgrade first (deployment stamp ${stamp ?? 'none'}, expected ${EXPECTED_WORKFLOW_VERSION})`]),
      ...(posture === null ? [`${safeLine(settingsReason)} — fix that`] : []),
    ];
    // The writer refuses on ANY vehicle path it cannot touch (a symlinked read-only vehicle blocks a
    // missing executor's placement too), so its own preflight is the last precondition.
    const blocked = writerBlock(root, deps);
    if (blocked) preconditions.push(`${blocked} — fix that`);
    const room = templateBudget(WHATS['executor-vehicle']) - String(configured.length).length - survey.state.length - 2;
    add(
      'executor-vehicle',
      fillTemplate(WHATS['executor-vehicle'], {
        n: configured.length,
        state: survey.state,
        reason: reason && room > 0 ? `: ${truncatedTo(reason, room)}` : '',
      }),
      // The writer places a missing vehicle and re-derives a placed executor whose bytes differ from the derived body (an invalid
      // frontmatter or read-only tools included), so those states need no precondition; every precondition above is a refusal the apply would meet.
      `node ${q(toolPath('cheap-agents.mjs'))} --apply --cwd ${q(root)}`,
      'executor-vehicle',
      `${preconditions.length ? `precondition: ${preconditions.join('; ')}; ` : ''}${HIDDEN_AGENTS_FOLLOW_UP(root)}`,
    );
    return true;
  } catch (err) {
    skip('executor-vehicle', err);
    return true;
  }
};

const probeFamilyFreshness = ({ deps, add, skip }) => {
  try {
    const survey = deps.surveyFamily ?? surveyFamily;
    const rows = survey(deps);
    const behind = rows.filter((r) => r.freshness === 'behind');
    const caveated = rows.filter((r) => (r.caveats ?? []).length > 0 && r.freshness !== 'behind');
    // freshness 'unknown' with NO caveat = a compare probe FAILED silently (the memory
    // template-probe lane) — dropping the row would let the flow-optimal claim ride a failed
    // check; it becomes a stated skip. 'not-checked' is a deliberately unprobed surface, not a failure.
    const unknownUncaveated = rows.filter((r) => r.freshness === 'unknown' && (r.caveats ?? []).length === 0);
    if (unknownUncaveated.length > 0) {
      skip('family-freshness', new Error(`freshness unknown for ${unknownUncaveated.map((r) => r.name).join(', ')} — the compare probe failed; npx @sabaiway/agent-workflow-kit@latest init refreshes/repairs the install`));
    }
    if (behind.length === 0 && caveated.length === 0) return;
    const parts = [
      ...behind.map((r) => `${r.name} ${r.version ?? '?'} is behind its bundled copy`),
      // ALL caveats per row — a memory missing BOTH templates must not drop the second (codex).
      ...caveated.map((r) => `${r.name}: ${r.caveats.join('; ')}`),
    ];
    add('family-freshness', fillTemplate(WHATS['family-freshness'], { parts: capList(parts, templateBudget(WHATS['family-freshness'])) }), 'npx @sabaiway/agent-workflow-kit@latest init');
  } catch (err) {
    skip('family-freshness', err);
  }
};

const probeMasksItem = ({ root, deps, add, skip }) => {
  try {
    const p = probeSandboxMasks({ cwd: root, ...deps });
    if (p == null) return; // not a git work tree — the lane is N/A, not sub-optimal
    if (!needsMasksApply(p)) return;
    const variant = p.staleReal.length > 0 ? 'sandbox-masks.stale-real' : 'sandbox-masks';
    // A stale-real-only fence (EMPTY derivation over a non-empty block) makes the plain --apply
    // REFUSE — the exact one-liner must carry --clear there (Segment B).
    const apply = p.masks.length === 0 && p.staleReal.length > 0 ? `${p.applyCmd} --clear` : p.applyCmd;
    const unfenced = p.fence.state === 'ok' && p.mountOnly.some((rel) => !p.fence.body.map(patternToRel).includes(rel));
    add('sandbox-masks', fillTemplate(WHATS[variant], { n: p.masks.length, m: p.staleReal.length }), apply, unfenced ? 'sandbox-masks.unfenced-mount' : 'sandbox-masks');
  } catch (err) {
    skip('sandbox-masks', err);
  }
};

// probeAgyAdddir is GONE, not silenced. It offered to arm AGY_REVIEW_ALLOW_ADDDIR with the benefit
// "large reviews — an oversized agy code review offloads to a staging dir instead of refusing".
// Headless agy AUTO-DENIES its own read_file tool, so that lane could return a confident fabrication
// (two BLOCKING findings citing lines of a file that has none, observed) or an empty SHIP, with no
// way to tell — the advisor was recommending the one lane whose failure mode is undetectable. The
// knob is retired in the wrappers (recognized, arms nothing) and an oversized code review is now a
// chunked feed with a per-part delivery proof, so there is nothing left to offer.

// The NEUTRAL recipe fingerprint (D4): a hash over the resolved hosts ∪ dirs data — an
// acknowledgement token, never a security key. Canonical form is HOME-SYMBOLIC: an
// absolute dir under the resolved home canonicalizes BACK to its `~/…` form and tilde forms stay
// symbolic — so `~/.codex` and its absolute expansion acknowledge the SAME recipe AND the default
// recipe's fingerprint is identical across machines/users (a committed project-scope ack never
// churns between them); only a genuinely-outside-home absolute override stays absolute
// (machine-specific by nature). Any change to the recipe re-fires the item.
export const recipeFingerprint = ({ hosts, dirs, home }) => {
  const norm = (dir) => homeRelative(dir, home);
  return factFingerprint(JSON.stringify({ hosts: [...hosts].sort(), dirs: [...new Set(dirs.map(norm))].sort() }));
};

// The ack store (D4; AD-055 Part I) is the kit-owned ack channel. An ack lane exists for a state the
// maintainer can only ANSWER, never converge — a dead checker/producer pair is fixed, not acknowledged,
// so no lane names it. The store's path, keys, lane registry and reader are ack-store.mjs.

// The opt-in read-lane toggle file (AD-055 Part II) — the SAME kit-owned docs/ai/lanes.json the
// placed hook reads live. The read-lane item offers to enable it once the hook is placed+wired.
export const LANES_FILE = 'docs/ai/lanes.json';
export const READ_LANE_KEY = 'readLane';

// The placed gate hook + the bundled runtime the read-lane item byte-compares for currency (AD-055
// Part II, council B7): an enabled lane over a STALE hook is a silent no-op — the pre-1.48 hook never
// reads lanes.json — so it must surface as an ATTENTION reseed, not a silent convergence.
const GATE_HOOK_REL = '.claude/hooks/agent-workflow-gates.mjs';
const BUNDLED_HOOK_ABS = join(HERE, '..', 'references', 'hooks', 'gate-approve.mjs');

// The state-block-guard wiring the advisor looks for is the writer leaf's own rule (any Stop entry of
// either settings file running the runtime); the two constants are re-exported for their readers.
export { STATE_BLOCK_HOOK_COMMAND, STATE_BLOCK_HOOK_RUNTIME };

// The placed gate hook's currency, as the states a caller must tell APART (D8). Read through the
// writer-class fail-closed no-follow primitive, never a bare readFile: a byte-compare that FOLLOWS a
// symlink can call a placed hook current because something ELSE is — a wrong verdict, which is worse
// than a missing one. `current` and `stale` are answers; `absent` is one the caller disposes of
// itself (a hook that is not there belongs to the place offers, never to a refresh arm); a symlink,
// a directory and an unreadable target all THROW into the probe's stated-skip lane.
const HOOK_CURRENCY = Object.freeze({ CURRENT: 'current', STALE: 'stale', ABSENT: 'absent' });
const readsAbsent = (deps, path) => {
  try {
    (deps.lstat ?? lstatSync)(path);
    return false;
  } catch (err) {
    return err?.code === ABSENT_CODE;
  }
};

const readPlacedHookCurrency = (root, deps) => {
  if (readsAbsent(deps, join(root, GATE_HOOK_REL))) return HOOK_CURRENCY.ABSENT;
  const read = deps.readRegularFileNoFollow ?? readRegularFileNoFollow;
  const placed = read(join(root, GATE_HOOK_REL));
  if (placed.outcome === 'absent') return HOOK_CURRENCY.ABSENT;
  if (placed.outcome === 'foreign') {
    throw new Error(`${GATE_HOOK_REL} is a ${placed.className}, not a regular file — refusing to judge its currency`);
  }
  if (placed.outcome !== 'ok') throw new Error(`${GATE_HOOK_REL} is unreadable (${placed.code})`);
  const bundle = (deps.readFile ?? readFileSync)(deps.bundledHookPath ?? BUNDLED_HOOK_ABS, 'utf8');
  return placed.content === bundle ? HOOK_CURRENCY.CURRENT : HOOK_CURRENCY.STALE;
};

// Does the declaration carry the marker KEY at all? The question is PRESENCE, never the value: an
// older hook rejects a key it does not know whatever that key says, so `lcovProducer: false` — a
// perfectly valid declaration the runner accepts — darkens such a hook exactly as `true` does. Asking
// through the producer predicate would be wrong twice over: it answers yes for a cmd-recognized
// producer that needs nothing from the hook, and no for the false marker that does.
const declarationCarriesMarker = (root, deps) => {
  const declaration = loadDeclaration(root, deps);
  return declaration.outcome === 'loaded' && declaration.gates.some((gate) => Object.hasOwn(gate, LCOV_PRODUCER_KEY));
};

// Read the opt-in read-lane toggle for the read-lane item. An ABSENT file (or absent docs/ai) →
// false (the lane is off — offer it). `readLane === true` → enabled (converged). A parse/IO error on
// an EXISTING file, a symlinked ancestor/leaf, an escape, or a non-object root THROWS — the probe
// turns it into a stated skip (a BROKEN toggle the writer would refuse to overwrite is not "off").
// A present-but-non-boolean value is a valid store the writer merges → false (offer), never a skip.
const readReadLaneToggle = (root, deps) => {
  const readFile = deps.readFile ?? readFileSync;
  const lstat = deps.lstat ?? lstatSync;
  const absPath = join(root, LANES_FILE);
  let st;
  try {
    assertContainedRealPath(root, absPath, { lstat }); // symlinked root/ancestor/leaf or escape → throws
    st = lstat(absPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return false; // genuinely absent — the lane is off, offer it
    throw err; // a symlinked ancestor/leaf, an escape, or a real IO error — stated skip
  }
  if (!st.isFile()) {
    throw new Error(`${LANES_FILE} is not a regular file — refusing to read it`);
  }
  const parsed = JSON.parse(readFile(absPath, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${LANES_FILE}: expected a JSON object`);
  }
  return parsed[READ_LANE_KEY] === true;
};

// D3: the risk-marked keys — every key here has a per-item posture note in the mode doc, surfaced
// at the consent moment; the static contract test asserts EXACT bidirectional coverage
// (risk-marked keys == mode-doc note keys — a dropped note goes red, not silent).
export const RISK_NOTED_KEYS = Object.freeze(['bridge-tier', 'read-lane', 'worktrees-dir', 'adr-store-migration', 'gates-inert', 'source-size', 'gate-hook', 'mcp-channel', 'spec-adoption', 'enforcement', 'hook-checks', 'profile-gap', 'jev-connect', 'jev-skill', 'attribution', 'footprint-global']);

// The feature-spec layer's adoption state (contract: kit/spec-adoption). The canon lets a plan cite
// zero governing specs while a project adopts the layer, and nothing ever said whether adoption had
// started — an owner found the store absent only by asking. The survey reads the store through
// spec-check's own census; a recorded decline (the `spec-adoption` ack lane) is the fact that
// silences the item, and an unreadable store is a stated skip so the flow-optimal line never renders
// over it. The not-adopted apply is the spec-layer ensure; the decline preview rides the recipe line.
// The one opening of every offer's decline alternative: a chat write the agent runs on the user's decline.
export const DECLINE_ALTERNATIVE = 'decline alternative (asked apart, before the confirmation; on your decline the agent records it instead of the apply, never after it): ';
export const probeSpecAdoption = ({ root, deps, add, skip }) => {
  try {
    const survey = surveySpecAdoption(root, deps);
    if (survey.state === ADOPTION.UNREADABLE) {
      skip('spec-adoption', new Error(`${survey.reason} — the adoption state under ${SPEC_STORE_DIR_REL} cannot be judged`));
      return;
    }
    if (survey.state === ADOPTION.ADOPTED || readDeclineAck(root, deps)) return;
    const decline = `node ${q(toolPath('ack-write.mjs'))} --lane ${SPEC_ADOPTION_LANE} --fingerprint ${declineFingerprint()} --cwd ${q(root)}`;
    if (survey.state === ADOPTION.NOT_ADOPTED) {
      add(
        'spec-adoption',
        fillTemplate(WHATS['spec-adoption'], {}),
        `node ${q(toolPath('ensure-configs.mjs'))} --reconcile --only ${SPEC_LAYER_ENSURE} --cwd ${q(root)}`,
        'spec-adoption',
        `${DECLINE_ALTERNATIVE}${decline}`,
      );
      return;
    }
    add('spec-adoption', fillTemplate(WHATS['spec-adoption.adopting'], { n: survey.draft }), decline, 'spec-adoption.adopting');
  } catch (err) {
    skip('spec-adoption', err);
  }
};

// D7 lane 1 — the DECLARATION confirmation. A settings entry is not proof of writable CAPABILITY
// (runtime truth stays with the provision preflight's real create+delete probe); it is proof the
// maintainer applied this item's own advice, which is what the item may converge on. Both scopes
// are consulted, as everywhere else here; a malformed store THROWS → the probe's stated skip.
// readSettingsFile only filters ENOENT — it rejects neither a symlink nor a non-regular target, and
// then reads THROUGH the link. A declaration is a CONVERGENCE signal here, so an unguarded read
// would let a store outside the project silence the item (and a FIFO would block the advisor).
// Guard the WHOLE path chain no-follow and require a regular file BEFORE the read; ENOENT stays the
// normal not-declared fall-through, everything else becomes the probe's stated skip.
const readDeclarationScope = (root, rel, deps) => {
  const lstat = deps.lstat ?? lstatSync;
  const absPath = join(root, rel);
  let st;
  try {
    assertContainedRealPath(root, absPath, { lstat });
    st = lstat(absPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  if (!st.isFile()) throw new Error(`${rel} is not a regular file — refusing to read it`);
  return readSettingsFile(absPath, { ...deps, cwd: root });
};

// Fail-closed shape check BEFORE any coverage test — UNIFORMLY, over the whole array: a declaration
// that suppresses a recommendation is never PARTIALLY trusted, so one bad entry invalidates the
// whole list rather than being filtered away beside a good one. An empty or whitespace-only entry is
// invalid too: it is meaningless to a host, but would resolve to the project root here and silence
// the item for any probe dir inside the repo. An ABSENT allowWrite is simply nothing declared.
const declaredWritableDirs = (scope, rel) => {
  const filesystem = scope?.data?.sandbox?.filesystem;
  if (filesystem === null || typeof filesystem !== 'object' || Array.isArray(filesystem)) return [];
  const { allowWrite } = filesystem;
  if (allowWrite === undefined) return [];
  if (!Array.isArray(allowWrite) || !allowWrite.every(isResolvableDeclaredEntry)) {
    throw new Error(`${rel}: sandbox.filesystem.allowWrite must be an array of non-empty strings`);
  }
  return allowWrite;
};

const declaresWritableDir = (root, probeDir, deps) => {
  const home = deps.home ?? homedir();
  // Both scopes are READ and SHAPE-CHECKED (never short-circuited) so the guards screen each one —
  // a malformed second scope must not hide behind a converging first.
  const declared = [SETTINGS_FILE, SETTINGS_LOCAL_FILE].map((rel) =>
    declaredWritableDirs(readDeclarationScope(root, rel, deps), rel),
  );
  return declared.some((entries) =>
    entries.some((entry) => dirCovers(resolveDeclaredDir(entry, { home, root }), probeDir)),
  );
};

// D7 lane 2 — the ack fallback for a host that ignores the settings key, bound to the PROBED DIR
// through the worktrees-dir fingerprint's home-symbolic canonicalization, so a home-anchored dir
// acks portably. The binding is to the RESOLVED probe dir, so the
// item re-fires only when that resolved dir changes — two ABSENT parentDir values sharing an
// existing ancestor resolve to the same dir and keep the same ack.
export const worktreesDirFingerprint = (probeDir, home) => recipeFingerprint({ hosts: [], dirs: [probeDir], home });

const WORKTREES_ACK_FALLBACK = 'ack fallback, only on your word that this host ignores the settings key, instead of the grant: ';

// The worktrees-dir item, by the table of spec bridges/velocity-profile, part worktrees-grant: the grant
// names the parent itself; the probe dir (its nearest existing ancestor) serves the convergence alone.
const probeWorktreesDir = ({ root, deps, add, skip }) => {
  try {
    const grantDir = worktreesGrantDir(root, deps);
    const probeDir = nearestExistingDir(grantDir, deps);
    const hostSignal = deps.canWriteDir?.(probeDir);
    if (hostSignal === true) return;
    const home = deps.home ?? homedir();
    if (worktreesGrantHoldsHome(grantDir, home, deps)) {
      const dir = truncatedTo(oneLineOf(grantDir), templateBudget(WHATS['worktrees-dir.home']));
      add('worktrees-dir', fillTemplate(WHATS['worktrees-dir.home'], { dir }), '', 'worktrees-dir.home');
      return;
    }
    const fingerprint = worktreesDirFingerprint(probeDir, home);
    if (hostSignal !== false) {
      if (declaresWritableDir(root, probeDir, deps)) return;
      if (readAckValue(root, deps, ACKS_WORKTREES_DIR_KEY) === fingerprint) return;
    }
    const dir = truncatedTo(oneLineOf(grantDir), templateBudget(WHATS['worktrees-dir']));
    const ack = `node ${q(toolPath('ack-write.mjs'))} --lane worktrees-dir --fingerprint ${fingerprint} --cwd ${q(root)}`;
    add('worktrees-dir', fillTemplate(WHATS['worktrees-dir'], { dir }), ack, 'worktrees-dir',
      hostSignal === false ? null : `${WORKTREES_ACK_FALLBACK}${ack}`);
  } catch (err) {
    skip('worktrees-dir', err);
  }
};

// The ADR-store crossing. Until now this mode declared it had NO advisor capability, on the argument
// that status and upgrade already report the old layout — but they only reported the MONOLITH shape,
// so a project whose deployed rotator merely predates the store was told nothing by anything.
//
// Honest scope: the advisor is the deterministic section every `upgrade` run ends with, so this is
// NOT a new door for someone who never runs status or upgrade — it MECHANIZES the upgrade door.
//
// It reads the STRICT layout survey deliberately: the lenient one turns every fs failure into
// "no ADR layout here", which would print «flow optimal» over a layout the probe could not read. A
// failure must become a STATED SKIP, never an absence.
// Each shape states a fact about THIS tree that holds whether or not a store directory exists —
// `old-unrotated` also covers a tree whose store is already there but whose rotation script is not,
// and saying "the store is not in place" there would be false.
const ADR_LAYOUT_SHAPES = Object.freeze({
  old: 'a legacy archive file is still on disk and must be exploded into the per-file store',
  'old-unrotated': 'the deployed rotation script predates the store and keeps writing the retired layout',
});
export const probeAdrStore = ({ root, deps, add, skip }) => {
  try {
    const shape = ADR_LAYOUT_SHAPES[surveyAdrLayoutStrict(root, deps)];
    if (!shape) return; // migrated, or no ADR substrate at all — nothing to offer
    // The apply is the bare dry run: consent takes two steps, as profile-gap's does — the first yes
    // runs it and the plan is relayed, the same line with --apply runs only on a second yes over it.
    add(
      'adr-store-migration',
      fillTemplate(WHATS['adr-store-migration'], { shape }),
      `node ${q(toolPath('migrate-adr-store.mjs'))} --dry-run --cwd ${q(root)}`,
    );
  } catch (err) {
    skip('adr-store-migration', err);
  }
};

// The typed-channel item. It asks the READ-ONLY registration leaf and nothing else — importing the
// writer would pull the atomic-write core into the advisor's graph (read-graph-purity.test.mjs).
const probeMcpChannel = ({ root, deps, add, skip }) => {
  try {
    const registration = readRegistration(root, deps);
    // A target we could not read is never turned into a verdict about what it contains.
    const assertReadable = (target) => {
      if (target.state === MCP_STATE.FOREIGN) throw new Error(`${target.rel} is a ${target.className} — refusing to read through it`);
      if (target.state === MCP_STATE.MALFORMED) throw new Error(`${target.rel} is ${target.reason}`);
      if (target.state === MCP_STATE.UNREADABLE) throw new Error(`${target.rel} cannot be read (${target.reason})`);
    };
    const preview = `node ${q(toolPath('mcp.mjs'))} --cwd ${q(root)}`;
    // ORDER: the `.mcp.json` half is judged and REPORTED on its own before anything about the
    // settings half can end the probe. A differing entry is fully observable, and an unreadable
    // settings file says nothing about it — returning on the settings mask first hid it.
    assertReadable(registration.mcpJson);
    if (registration.mcpJson.differs) {
      add(
        'mcp-channel',
        fillTemplate(WHATS['mcp-channel.differing'], { server: MCP_SERVER_NAME }),
        preview,
        'mcp-channel.differing',
      );
      return;
    }
    assertReadable(registration.settings);
    if (registration.registered) return;
    add('mcp-channel', fillTemplate(WHATS['mcp-channel'], {}), preview);
  } catch (err) {
    skip('mcp-channel', err);
  }
};

// The Jev offer (contract: kit/jev-guide, part jev-offer). The key is judged first, through the facts leaf's one rule over
// the injected environment.
export const probeJevConnect = ({ root, deps, add, skip }) => {
  try {
    const env = deps.getenv ?? {};
    if (deps.keySet === true || keySet(env)) return;
    if (readAckValue(root, deps, ACKS_JEV_CONNECT_KEY) === JEV_CONNECT_DECLINE) return;
    const host = deps.jevHost ?? {};
    const place = placeOf({ env, platform: host.platform, hostname: host.hostname, container: host.container });
    const decline = `node ${q(toolPath('ack-write.mjs'))} --lane jev-connect --fingerprint ${JEV_CONNECT_DECLINE} --cwd ${q(root)}`;
    add('jev-connect', WHATS['jev-connect'], applySlot('jev-connect', { toolsDir: HERE }).apply, 'jev-connect',
      `${place ? `run the apply in ${place}; ` : ''}${DECLINE_ALTERNATIVE}${decline}`);
  } catch (err) {
    skip('jev-connect', err);
  }
};

// The Jev skill offer (contract: kit/jev-guide, part jev-offer): only once the key is set, so one jev item shows at a time.
// Each target is judged by the facts leaf's one state rule; the item's apply comes from the lane leaf's checked slot.
export const probeJevSkill = ({ root, deps, add, skip }) => {
  try {
    const env = deps.getenv ?? {};
    if (deps.keySet !== true && !keySet(env)) return;
    const host = deps.jevHost ?? {};
    if (typeof host.home !== 'string' || host.home === '') return;
    const pins = deps.jevPins ?? SKILL_PINS;
    const { dir, note } = claudeDirOf(env, host.home, host.platform);
    const io = { lstat: deps.lstat ?? lstatSync, readdir: deps.readdir ?? readdirSync, readFile: deps.readFile ?? readFileSync, pins };
    const judged = skillTargets({ home: host.home, claudeDir: dir }).map((target) => ({ ...target, ...skillState(target, io) }));
    if (!judged.some(({ state }) => state === 'absent' || state === 'earlier')) return;
    const decline = factFingerprint(`${JEV_SKILL_DECLINED}${pins[0].tag}`);
    if (readAckValue(root, deps, ACKS_JEV_SKILL_KEY) === decline) return;
    const line = skillLine(HERE, host.platform, dir);
    if (line === '') {
      skip('jev-skill', new Error(NO_APPLY_LINE));
      return;
    }
    const place = placeOf({ env, platform: host.platform, hostname: host.hostname, container: host.container });
    const behind = judged.filter(({ state }) => state === 'earlier').map(({ tag }) => pins.findIndex((pin) => pin.tag === tag));
    const what = behind.length ? fillTemplate(WHATS['jev-skill.earlier'], { old: pins[Math.max(...behind)].tag, new: pins[0].tag })
      : WHATS['jev-skill'];
    const untouched = judged.filter(({ state }) => state === 'foreign')
      .map(({ path, reason }) => `left untouched: ${printable(path)} — ${printable(reason)}; `).join('');
    const record = `node ${q(toolPath('ack-write.mjs'))} --lane jev-skill --fingerprint ${decline} --cwd ${q(root)}`;
    add('jev-skill', what, line, behind.length ? 'jev-skill.earlier' : 'jev-skill',
      `${place ? `run the apply in ${place}; ` : ''}${untouched}${note ? `${note}; ` : ''}${DECLINE_ALTERNATIVE}${record}`);
  } catch (err) {
    skip('jev-skill', err);
  }
};

export const probeProfileGaps = ({ root, deps, add, skip }) => {
  try {
    const { gaps, skips } = composeProfileGapScreen({ root, deps });
    for (const { what, apply } of gaps) add('profile-gap', what, apply);
    for (const reason of skips) skip('profile-gap', new Error(reason));
  } catch (err) {
    skip('profile-gap', err);
  }
};

// The attribution item by its table (spec init-project, part in-session-writes): a choice of off the
// effective settings do not honour; the writer's preflight runs before it renders, so no rendered check always exits 3.
const probeAttribution = ({ root, deps, add, skip }) => {
  try {
    if (readAttributionChoice(root, deps) !== 'off') return;
    const project = readSettingsFile(join(root, SETTINGS_FILE), { ...deps, cwd: root }).data;
    const local = readSettingsFile(join(root, SETTINGS_LOCAL_FILE), { ...deps, cwd: root }).data;
    const effective = effectiveAttribution(project, local);
    if (attributionHidesText(effective)) return;
    preflightVelocityProfile({ cwd: root }, deps);
    for (const [file, data] of [[SETTINGS_FILE, project], [SETTINGS_LOCAL_FILE, local]]) {
      const wrong = wrongTypedKey(data);
      if (wrong) throw new Error(`${file}: ${wrong} — the attribution item cannot judge it`);
    }
    const setsText = (value) => value !== null && typeof value === 'object' && ['commit', 'pr'].some((key) => Object.hasOwn(value, key));
    const localKey = Object.hasOwn(local ?? {}, ATTRIBUTION_KEY) && !attributionHidesText({ [ATTRIBUTION_KEY]: local[ATTRIBUTION_KEY] }) ? ATTRIBUTION_KEY
      : local?.[LEGACY_ATTRIBUTION_KEY] === true && !setsText(effective[ATTRIBUTION_KEY]) ? LEGACY_ATTRIBUTION_KEY : null;
    if (localKey) throw new Error(`${SETTINGS_LOCAL_FILE} sets ${localKey} so the harness adds its text — a local-scope override is your own edit`);
    add('attribution', WHATS.attribution, formsApply('attribution', root));
  } catch (err) {
    skip('attribution', err);
  }
};

// The leftover machine-global block: the one plan the hide reports and the --remove-global mode removes,
// asked of git under the home the advisor was given.
const probeFootprintGlobal = ({ root, deps, add, skip }) => {
  try {
    const home = deps.home ?? deps.jevHost?.home ?? homedir();
    const plan = (deps.planGlobalRemoval ?? planGlobalRemoval)({ env: { ...process.env, HOME: home }, home }, root, { home });
    if (plan === null) return;
    const file = truncatedTo(plan.source, templateBudget(WHATS['footprint-global']));
    add('footprint-global', fillTemplate(WHATS['footprint-global'], { file }), formsApply('footprint-global', root));
  } catch (err) {
    skip('footprint-global', err);
  }
};

// ── assembly (frozen presentation order) ─────────────────────────────────────────────────────────
const PROBES = Object.freeze([
  probeVelocityItems,
  probeAttribution,
  probeAutonomyItems,
  probeSandboxProvision,
  probeReviewRecipe,
  probeGates,
  probeGatesInert,
  probeSourceSize,
  probeCommitGuard,
  probeHookChecks,
  probeEnforcement,
  probeReadLane,
  probeStateBlockHook,
  probeCheapAgents,
  probeExecutorVehicle,
  probeFamilyFreshness,
  probeAdrStore,
  probeMasksItem,
  probeFootprintGlobal,
  probeWorktreesDir,
  probeMcpChannel,
  probeSpecAdoption,
  probeJevConnect,
  probeJevSkill,
  probeProfileGaps,
]);

export const buildRecommendations = ({ cwd, deps = {} } = {}) => {
  const root = resolve(cwd);
  const items = [];
  const skips = [];
  // Skip reasons ride arbitrary Error.messages — normalized to ONE line and length-capped so a
  // multiline or oversized message can never rebuild a prose wall (D2).
  const skip = (key, err) => skips.push({ key, reason: truncatedTo(oneLineOf(err?.message ?? String(err)), SKIP_REASON_CAP) });
  // The runtime shape backstop (D2): every COMPOSED item is validated at construction — a
  // violation surfaces through the stated-skip lane, never a crash, never a rendered violation.
  // `variant` defaults to the item key; a per-site arm passes its `<key>.<variant>` entry. It is
  // BOTH the severity lookup and the machine-readable outcome identifier: the human render says
  // which item fired, and only this field says which ARM of it did — so a consumer (the pre-publish
  // smoke asserting a specific false-green never returns) can assert the exact outcome instead of
  // pattern-matching prose that is free to be reworded.
  // `detail` (optional) is an extra rendered `recipe:` line — an item's own facts or its alternative,
  // TOO LONG for the capped WHAT and outside the pure-command apply (such as the bridge-tier
  // missing-entries line or the worktrees-dir ack fallback). Single-line like apply; absent otherwise.
  // Returns whether the item really RENDERED. One probe's disposition depends on another's having
  // spoken (the marker-stale ⟷ read-lane.stale precedence), and "the conditions still look right"
  // is not the same fact as "an item exists" — the shape backstop can refuse, and a condition read
  // twice can answer twice.
  const add = (key, what, apply, variant = key, detail = null) => {
    const problems = [];
    if (!(key in BENEFITS)) problems.push(`unregistered item key ${JSON.stringify(key)}`);
    if (!(variant in SEVERITIES)) problems.push(`unregistered severity key ${JSON.stringify(variant)}`);
    if (/[\r\n]/.test(what)) problems.push('WHAT is not a single line');
    else if (what.length > ITEM_LINE_CAP) problems.push(`WHAT exceeds the ${ITEM_LINE_CAP}-char cap (${what.length})`);
    if (/[\r\n]/.test(apply)) problems.push('apply is not a single line');
    if (detail != null && /[\r\n]/.test(detail)) problems.push('recipe detail is not a single line');
    if (problems.length > 0) {
      skip(key, new Error(`item shape violation — ${problems.join('; ')}`));
      return false;
    }
    const slot = applySlot(variant, {
      toolsDir: HERE, root, env: deps.getenv ?? {},
      home: deps.jevHost?.home ?? deps.home ?? '',
      platform: deps.jevHost?.platform ?? deps.platform,
    });
    items.push({ key, variant, severity: SEVERITIES[variant], lane: laneOf(variant), what, benefit: VARIANT_BENEFITS[variant] ?? BENEFITS[key],
      check: slot?.check ?? null, apply: slot?.apply ?? apply, detail });
    return true;
  };
  // The per-run scratch a probe uses to tell a LATER probe what it actually did. Written by exactly
  // one pair today (the marker-stale ⟷ read-lane.stale precedence) and read in the frozen PROBES
  // order, so the reader can never run first.
  const shared = {};
  const contentDeps = Object.create(Object.getPrototypeOf(deps), {
    ...Object.getOwnPropertyDescriptors(deps),
    lstat: {
      enumerable: true,
      value: (path, ...args) => {
        const stat = (deps.lstat ?? deps.lstatSync ?? lstatSync)(path, ...args);
        if (stat.isCharacterDevice?.() || stat.isBlockDevice?.()) {
          throw Object.assign(new Error(`${ABSENT_CODE}: ${path}`), { code: ABSENT_CODE });
        }
        return stat;
      },
    },
  });
  for (const probe of deps.probes ?? PROBES) {
    probe({ root, deps: probe === probeMasksItem ? deps : contentDeps, add, skip, shared });
  }
  return { root, items, skips };
};

// ── rendering (English tool DATA — the agent presents it in the user's conversational language,
// facts/counts complete, commands byte-exact; the raw block on request) ─────────────────────────
export const formatRecommendations = ({ items, skips }) => {
  const lines = [RECOMMENDATIONS_SECTION_HEADER, ''];
  const attention = items.filter((i) => i.severity === SEVERITY_ATTENTION).length;
  const verdict = composeVerdict({ attention, optional: items.length - attention, skipped: skips.length });
  if (verdict == null) {
    // The flow-optimal claim renders ONLY when every probe ran and none fired — an empty item
    // list beside skipped checks would falsely attest optimality (Segment B).
    lines.push(RECOMMENDATIONS_EMPTY_LINE);
    return lines.join('\n');
  }
  lines.push(verdict);
  if (items.length > 0) {
    lines.push('');
    // Attention items lead (stable within each class — the frozen probe order).
    const ordered = [...items].sort(
      (a, b) => (a.severity === SEVERITY_ATTENTION ? 0 : 1) - (b.severity === SEVERITY_ATTENTION ? 0 : 1),
    );
    ordered.forEach((item, i) => {
      lines.push(`${i + 1}. ${SEVERITY_LABELS[item.severity] ?? SEVERITY_LABELS[SEVERITY_OPTIONAL]}: ${item.what}`);
      lines.push(`   benefit: ${item.benefit}`);
      lines.push(`   lane: ${item.lane}`);
      if (item.detail) lines.push(`   recipe: ${item.detail}`);
      if (item.check != null) lines.push(`   check: ${item.check}`);
      lines.push(`   apply: ${item.apply}`);
    });
  }
  for (const s of skips) {
    lines.push(`  ⚠ skipped item ${s.key} — probe failed: ${s.reason}`);
  }
  return lines.join('\n');
};

const HELP = `recommendations — the read-only upgrade Recommendations advisor (agent-workflow kit, AD-044).

Usage:
  node recommendations.mjs --cwd <project-root> [--json]

Computes the deterministic Recommendations section every kit upgrade ends with — VERDICT-FIRST:
one composed verdict line opens every non-optimal render, then per item {severity · what is
sub-optimal · the benefit in one plain line · the lane · an optional \`recipe:\` line (an item's own
facts or its alternative, such as the bridge-tier missing-entries line or
the worktrees-dir ack fallback) · the harness check line · the exact consent-gated apply one-liner}. --cwd is
REQUIRED (the target project is explicit, never inferred from the shell's current directory). The
section renders present-even-when-empty ("${RECOMMENDATIONS_EMPTY_LINE}"); a probe failure is a
stated skipped-item line. Apply lines are cwd-independent (absolute tool paths, a pinned --cwd;
the doctor item pins via a cd prefix; the ONE exception is the set-autonomy item — a
conversational skill invocation labeled "run IN the target project") and preserve each writer's
own consent semantics. The consented velocity-profile --bridge-tier seeds used bridges' code-mode
allow rules, <wrapper> * exclusions (codex-exec * where an execute slot delegates), hosts in
sandbox.network.allowedDomains and state dirs in sandbox.filesystem.allowWrite. Where the host
honors the settings sandbox keys, an excluded wrapper runs outside the sandbox, every sandboxed
command of the project can reach each host, and every sandboxed command can write each state dir;
plan/diff review modes and delegated execution keep their prompt.
A user item stays the user's own step.

Read-only: never writes, never commits, never runs a subscription CLI. Exit codes: 0 report
rendered (items or empty); 1 error; 2 usage.`;

// The host facts of the key and skill offers: the platform, the hostname (a throw reads as none), /.dockerenv a regular file, the home.
export const hostFacts = () => ({ platform: process.platform, hostname: (() => { try { return hostname(); } catch { return ''; } })(),
  container: (() => { try { return statSync('/.dockerenv').isFile(); } catch { return false; } })(),
  home: (() => { try { return homedir(); } catch { return ''; } })() });

export const main = (argv, ctx = {}) => {
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    let cwd = null;
    let json = false;
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '--cwd') {
        cwd = argv[i + 1];
        if (!cwd || cwd.startsWith('--')) throw usageFail('--cwd requires a directory argument');
        i += 1;
      } else if (a === '--json') json = true;
      else throw usageFail(`unknown argument: ${a} (see --help)`);
    }
    if (cwd == null) throw usageFail('--cwd <project-root> is required — the target project is explicit, never inferred');
    const lstat = ctx.deps?.lstat ?? lstatSync;
    const st = (() => {
      try {
        return lstat(resolve(cwd));
      } catch {
        return null;
      }
    })();
    if (st == null || !st.isDirectory()) throw Object.assign(new Error(`--cwd is not a directory: ${cwd}`), { exitCode: 1 });
    const result = buildRecommendations({ cwd, deps: ctx.deps ?? { getenv: process.env, jevHost: hostFacts() } });
    if (json) return { code: 0, stdout: JSON.stringify(result, null, 2), stderr: '' };
    return { code: 0, stdout: formatRecommendations(result), stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `recommendations: ${err.message}` };
  }
};

if (isDirectRun(import.meta.url)) {
  const r = main(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
}
