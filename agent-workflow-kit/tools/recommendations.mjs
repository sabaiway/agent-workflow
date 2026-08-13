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
// skipped-item line — never a crash, never a fabricated item. The kit never seeds
// sandbox.network.allowedDomains / filesystem.allowWrite (HAND-APPLY territory; bridge council
// 2026-07-11, both backends concur); the sandbox-lane item's convergence is a NEUTRAL
// fingerprint-bound acknowledgement recorded by the consent-gated ack writer into the family-owned
// docs/ai/acks.json (AD-055 relocated it off the host settings schema), never a security key (D4).
//
// Read-only: never writes, never commits, never runs a subscription CLI. The reused probes are all
// exported read-only surfaces of their owning tools (velocity/autonomy/doctor/backends/recipes/
// registry/sandbox-masks); the sandbox-masks, settings and tracked-tree-census probes may run
// read-only git queries. Dependency-free, Node >= 22. No side effects on import (the isDirectRun
// idiom).

import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  preflightVelocityProfile,
  planVelocityProfile,
  checkAutonomyProfile,
  probeSandboxAvailability,
  isExecutableFile,
  readSettingsFile,
  BRIDGE_REVIEW_WRAPPERS,
  BRIDGE_REVIEW_MODE,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
} from './velocity-profile.mjs';
import { loadAutonomy, isSparseSeedConfig, AUTONOMY_REL } from './autonomy-config.mjs';
import { deriveDoctorPlan } from './autonomy-doctor.mjs';
import { detectBackends, findOnPath } from './detect-backends.mjs';
import { ACTIVITIES, resolveActivityRecipe } from './recipes.mjs';
import { surveyFamily, surveyGateHook, surveyAdrLayoutStrict } from './family-registry.mjs';
import { probeSandboxMasks, needsMasksApply } from './sandbox-masks.mjs';
import { shellQuoteArg } from './review-state.mjs';
import { isFinalCapableDeclaration } from './run-gates.mjs';
import { loadDeclaration, canonicalCheckerGates, coverageProducerPrecedes, isKitOwnedCheckerGate, GATES_REL, LCOV_PRODUCER_KEY } from './gates-declaration.mjs';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';
import { matchesCoverageProducer, isCoverageProducerGate } from './coverage-producer.mjs';
// How much of the TRACKED tree the changed-line coverage domain can assess at all — the fact that
// turns "the checker certifies" into "the checker certifies the assessable minority".
import { takeCensus, censusFact, CENSUS_VERDICT } from './tracked-tree-census.mjs';
// Read-only surfaces of the fill (buildOffer) and of the source-size practice (its pure core). The
// fill's own WRITER is never called from here — the advisor renders its consent-gated command, it
// does not run it.
import { buildOffer } from './gates-init.mjs';
import { CHECKER_CLAIM, INITIAL_ADOPTION_REASON, SOURCE_SIZE_GATE_ID, classifySourceSizeGate, loadSourceSizeConfig } from './source-size-core.mjs';
// The declared-path resolution + segment containment this item's convergence lane shares with the
// autonomy render's allowWrite degrade — ONE leaf, so the two answers cannot drift.
import { resolveDeclaredDir, dirCovers, isResolvableDeclaredEntry } from './declared-paths.mjs';
import { resolveGitHooksPath } from './commit-guard.mjs';
import { loadConfig } from './orchestration-config.mjs';
import { DEFAULT_BUNDLE_ROOT } from './bridge-settings-read.mjs';
import { assertContainedRealPath } from './fs-safe.mjs';
import { loadWorktreesConfig, resolveProbeDir } from './worktrees.mjs';
import { preflightCheapAgents } from './cheap-agents.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const toolPath = (rel) => join(HERE, rel);
const q = shellQuoteArg;

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
  'review-recipe': SEVERITY_ATTENTION,
  'gates-declaration': SEVERITY_OPTIONAL,
  'gates-inert': SEVERITY_ATTENTION,
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
  'gate-hook': SEVERITY_OPTIONAL,
  // A placed hook that predates the marker key goes DARK on a marker-carrying declaration (unknown
  // key → auto-approval off), so a CONFIGURED capability silently stops working: attention, not an
  // offer to enable something.
  'gate-hook.marker-stale': SEVERITY_ATTENTION,
  'commit-guard': SEVERITY_OPTIONAL,
  'read-lane': SEVERITY_OPTIONAL,
  'read-lane.stale': SEVERITY_ATTENTION,
  'read-lane.missing': SEVERITY_ATTENTION,
  'state-block': SEVERITY_OPTIONAL,
  agents: SEVERITY_OPTIONAL,
  'family-freshness': SEVERITY_ATTENTION,
  'adr-store-migration': SEVERITY_ATTENTION,
  'sandbox-masks': SEVERITY_OPTIONAL,
  'sandbox-lane': SEVERITY_OPTIONAL,
  'worktrees-dir': SEVERITY_OPTIONAL,
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
// content is fully dynamic (capped at composition by truncation-with-count).
export const WHATS = Object.freeze({
  'velocity-core': 'routine read-only commands still prompt — {n} audited read-only allowlist entr(ies) not seeded',
  'kit-tools-tier': "the kit's own read-only tools still prompt — {n} kit-tools tier entr(ies) not seeded",
  'bridge-tier': 'council review runs prompt per bridge invocation — {n} bridge-wrappers tier entr(ies) not seeded (placed bridges only, code mode only)',
  'autonomy-policy': 'no {path} — the computed defaults apply implicitly (red-lines ask/deny; every activity floors at prompt)',
  'autonomy-render': 'the declared autonomy policy is not rendered into .claude/settings.json — drift: {drift}',
  'sandbox-provision': 'the OS sandbox is unavailable: {reason}',
  'sandbox-provision.installable': 'the OS sandbox is unavailable: {reason} — installable via the doctor (consent tuple {tuple})',
  'review-recipe': '{degraded}',
  'gates-declaration': 'no declared gate matrix (docs/ai/gates.json absent or empty) — gates prompt one by one; the apply PREVIEWS its --apply line, writes nothing',
  'gates-inert': 'the declared coverage checker ({id}) has no producer before it — it certifies nothing this run, or reads a stale lcov',
  'gates-inert.no-verification': "all {n} declared gate(s) are the kit's own checkers — the matrix runs no project-verification command",
  'gates-inert.producer-unrecognized': 'the coverage checker ({id}) has NO producer declared and none offerable, on a tree the changed-line domain barely reaches',
  'gates-inert.coverage-domain-narrow': 'certification covers the assessable minority only — {ext} dominate(s) the tracked tree, and the changed-line domain excludes them',
  'source-size': 'no source-size gate — module size drifts unmeasured, and an over-cap file is invisible instead of recorded debt',
  'source-size.unminted': 'the source-size gate is declared but its record ({state}) is not minted — the checker refuses, so this gate reds every run',
  'source-size.adopted-elsewhere': "the source-size gate runs a DIFFERENT copy of this checker ({n} declared) — adopted here, just not through this kit's own tool",
  'source-size.id-squatter': 'a gate carries the source-size id but is not this checker — the practice reads as declared while nothing measures module size',
  'gate-hook': '{n} declared gate(s) prompt per run — the gate-approval hook is not wired',
  'gate-hook.marker-stale': 'the declaration carries the lcovProducer key but the placed hook predates it — the hook goes dark and every gate prompts',
  'commit-guard': 'the gate matrix is final-run-capable but no commit-guard arms the pre-commit hook — a commit needs no green receipt yet',
  'read-lane': 'the gate hook is wired but the read-only compound lane is off — pipes/chains of seeded reads still prompt one by one',
  'read-lane.stale': 'the read-lane is ON but the placed gate hook is stale — an old hook never reads lanes.json, so the lane is silently dark; reseed it',
  'read-lane.missing': 'the gate hook is wired but its placed file is missing — every Bash call errors and the read-lane is dark; re-place it',
  'state-block': 'nothing checks the closing state block — a turn that ends on «nothing needed from you», or on a promise it never started, passes unseen',
  agents: '{n} read-only subagent(s) not placed (Claude Code) — no shell-free vehicle for that work; the apply PREVIEWS first',
  'family-freshness': '{parts}',
  'adr-store-migration': 'still on the retired 3-tier ADR layout — {shape}',
  'sandbox-masks': '{n} sandbox device mask(s) clutter git status — the managed exclude block is absent or stale',
  'sandbox-masks.stale-real': '{n} sandbox device mask(s) clutter git status — the exclude block is stale; {m} fenced entr(ies) are REAL paths (a fresh apply drops them)',
  'sandbox-lane': 'the wired review wrappers declare a session-sandbox recipe (egress hosts + writable state dirs) not yet acknowledged for this project',
  'worktrees-dir': 'write access to the worktrees parent dir {dir} is not confirmed — provision may still stop',
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
  'velocity-core': 'velocity — routine read-only commands stop prompting while the maintainer is away',
  'kit-tools-tier': "velocity — the kit's own read-only tools run promptless (audited, resolved-absolute tier)",
  'bridge-tier':
    'velocity — placed review wrappers run code-mode council reviews promptless (plan/diff modes and delegated execution keep their prompt)',
  'autonomy-policy': 'clarity — the per-activity autonomy policy becomes an explicit, versioned declaration instead of implicit computed defaults',
  'autonomy-render': `velocity — confined commands auto-allow per your declared policy; ${DUAL_SECURITY_BENEFIT}`,
  'sandbox-provision': `velocity — confined ad-hoc commands stop prompting; ${DUAL_SECURITY_BENEFIT}`,
  'review-recipe': 'recipe coverage — the review AND execution recipes you configured actually run instead of silently degrading',
  'gates-declaration': 'velocity — your project’s gates run as ONE declared batch with a PASS/FAIL table',
  'gates-inert': 'honest gates — the declared matrix verifies your project instead of reporting green over a check that ran nothing',
  'source-size': 'maintainability — a module you can hold whole stays reviewable, and size drift becomes recorded, reasoned debt',
  'gate-hook': 'velocity — your own declared gate commands auto-approve byte-exactly (opt-in PreToolUse hook)',
  'commit-guard': 'integrity — commits require the ONE green --final receipt at the exact staged fingerprint (consented pre-commit arm)',
  'read-lane': 'velocity — pipes/chains of your seeded read-only commands auto-approve instead of prompting (opt-in, conservatively classified)',
  'state-block': 'no silent stalls — a turn ending on «you are not needed», or on work it never started, warns at once instead of waiting to be spotted',
  agents: 'cost and quiet — mechanical work runs on a cheap model, and no vehicle has a shell, so a read-only fan-out cannot flood you with prompts',
  'family-freshness': 'currency — placed family members carry the latest shipped fixes and features',
  'adr-store-migration': 'durability — every decision becomes its own file with a generated navigator, instead of one hand-rotated pile',
  'sandbox-masks': 'zero clutter — git status shows only your changes (the review domain already ignores the masks by construction)',
  'sandbox-lane': 'discoverability — the manifest-declared observed sandbox recipe for bridge runs surfaces itself instead of waiting to be asked',
  'worktrees-dir': 'parallel features — the host-specific write allowance or terminal fallback is surfaced before provision',
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
  { id: 'sandbox-lane', mode: 'velocity', advisorKey: 'sandbox-lane' },
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
  { id: 'state-block', mode: 'state-block-guard', advisorKey: 'state-block' },
  { id: 'sandbox-masks', mode: 'sandbox-masks', advisorKey: 'sandbox-masks' },
  { id: 'worktrees-dir', mode: 'worktrees', advisorKey: 'worktrees-dir' },
  { id: 'family-freshness', mode: 'upgrade', advisorKey: 'family-freshness' },
  { id: 'adr-store-migration', mode: 'migrate-adr-store', advisorKey: 'adr-store-migration' },
  { id: 'review-recipe', mode: 'set-recipe', advisorKey: 'review-recipe' },
  // The execute slot is a DISTINCT opt-in from the review slot, and the same probe reports both —
  // which is why the review-recipe benefit is worded for either slot rather than for review alone.
  { id: 'delegated-execution', mode: 'set-recipe', advisorKey: 'review-recipe' },
  { id: 'agents', mode: 'agents', advisorKey: 'agents' },
  // Exempt, not un-audited. `acceptEdits` auto-applies Edit/Write and auto-runs mkdir/touch/mv/cp:
  // a TRUST-POSTURE change. The kit never nudges a user toward weakening their approval posture (the
  // same doctrine that keeps sandbox network/filesystem allowances HAND-APPLY); velocity presents the
  // full honest posture at its own consent moment, where the user is already deciding.
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
  if (core.toAdd.length > 0) {
    add('velocity-core', fillTemplate(WHATS['velocity-core'], { n: core.toAdd.length }), applyLine(''));
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
    const bt = planVelocityProfile(preflight, { bridgeTier: true, findWrapper: deps.findWrapper });
    const delta = bt.bridgeToAdd.length + bt.excludedToAdd.length;
    if (delta > 0) {
      add('bridge-tier', fillTemplate(WHATS['bridge-tier'], { n: delta }), applyLine(' --bridge-tier'));
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
    const plan = deriveDoctorPlan({ probeResult: p, env: deps.env ?? process.env, isExec: deps.isExecutable ?? isExecutableFile });
    const variant = plan.tuple ? 'sandbox-provision.installable' : 'sandbox-provision';
    const reason = truncatedTo(oneLineOf(p.reason), templateBudget(WHATS[variant]) - (plan.tuple ? String(plan.tuple).length : 0));
    // The doctor reads process.cwd() (deployment-gated) and takes no --cwd flag — the one-liner
    // pins the target project via a cd prefix (Segment B).
    add('sandbox-provision', fillTemplate(WHATS[variant], { reason, tuple: plan.tuple }), `cd ${q(root)} && node ${q(toolPath('autonomy-doctor.mjs'))}`);
  } catch (err) {
    skip('sandbox-provision', err);
  }
};

const probeReviewRecipe = ({ root, deps, add, skip }) => {
  try {
    // The VALIDATED reader (Segment B): a schema-invalid config (unknown activity/slot,
    // bad recipe) throws here and becomes a stated skip — raw JSON.parse would silently ignore it.
    const { config } = loadConfig(root, deps.readFile ?? readFileSync, deps.lstat ?? lstatSync);
    const detection = detectBackends(deps);
    const degraded = [];
    for (const [activity, def] of Object.entries(ACTIVITIES)) {
      for (const slot of Object.keys(def.slots)) {
        const r = resolveActivityRecipe({ config, readiness: detection, activity, slot });
        if (r.degradedFrom) degraded.push(`${activity}.${slot}: configured ${r.degradedFrom} degrades to ${r.recipe} (${r.reason})`);
      }
    }
    if (degraded.length > 0) {
      add('review-recipe', fillTemplate(WHATS['review-recipe'], { degraded: capList(degraded, templateBudget(WHATS['review-recipe'])) }), '/agent-workflow-kit backends');
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
    // The writer's OWN stale recovery, in its exact shape: `gate-hook --apply` never overwrites a
    // placed diverged hook (it places only an ABSENT target), so remove-then-reseed is the only lane
    // that converges — and it is maintainer territory, hence HAND-APPLY.
    // The RESULT is what the read-lane item defers to — not these conditions re-derived there. Both
    // probes read the placed hook independently, so a hook that changes between the two reads would
    // otherwise let each conclude the other owns it and leave a dark lane reported by nobody.
    shared.markerStaleRendered = add(
      'gate-hook',
      fillTemplate(WHATS['gate-hook.marker-stale'], {}),
      `HAND-APPLY: rm ${q(join(root, GATE_HOOK_REL))}, then node ${q(toolPath('gate-hook.mjs'))} --apply --cwd ${q(root)}`,
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
// remedy is the ordinary consent-gated preview. HAND-APPLY remains exactly where no offerable
// producer exists, or where the checker is not last — there the edit really is the maintainer's,
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
            `HAND-APPLY: mark the gate that actually writes the lcov with "lcovProducer": true in ${GATES_REL} (references/modes/gates.md names the key), or drop ${id} — and note the fill offers only terminating-class script NAMES, so a recognized body under another name (a "ci" script running node --test) is declared by hand, not marked`,
            'gates-inert.producer-unrecognized',
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
      add(
        'gates-inert',
        fillTemplate(WHATS['gates-inert'], { id }),
        checkerIsLast && producer
          ? fillPreviewFor(root, [producer.id])
          : `HAND-APPLY: declare or MOVE a suite gate carrying the coverage reporters BEFORE ${id} in ${GATES_REL} (references/modes/gates.md names the exact form), or drop ${id} — ${blocked}`,
      );
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
// checker ships with the kit and refuses until a project declares its own scope, so without this
// item a deployment would never learn the practice exists — the same OPT-IN-SHIPS-INVISIBLE failure
// the capability registry was built for. New and existing deployments meet it identically, because
// the advisor section is mandatory at every upgrade.
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
const probeSourceSize = ({ root, deps, add, skip }) => {
  try {
    const declaration = loadDeclaration(root, deps);
    const gates = declaration.outcome === 'loaded' ? declaration.gates : [];
    const tool = toolPath('source-size-check.mjs');
    // The reason string is PINNED, not composed: it is copied unchanged into every entry the first
    // mint records, and a first mint records the whole tree — so "this is what the tree already
    // carried when the practice arrived" is the one sentence that is true of all of them.
    const adoptLine = `node ${q(tool)} --adopt --reason "${INITIAL_ADOPTION_REASON}" --cwd ${q(root)}`;
    const claims = gates.map((gate) => ({ gate, claim: classifySourceSizeGate(gate.cmd, root) }));
    const canonical = claims.filter((c) => c.claim === CHECKER_CLAIM.CANONICAL);
    const elsewhere = claims.filter((c) => c.claim === CHECKER_CLAIM.ELSEWHERE);
    if (canonical.length > 0 || elsewhere.length > 0) {
      // A DECLARED gate is not the same fact as a working one: the checker refuses on every config
      // state but MINTED, so a gate declared over an absent or half-written record reds the matrix
      // on every run. Reading the declaration alone would report that deployment as adopted and say
      // nothing about the one thing that is wrong with it. The split changes NOTHING here — the
      // outcome, its attention class and its immunity to every ack are the same whichever copy runs.
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
    // correct against a squatter, and useless as a RENDERED remedy, so this arm names the two hand
    // edits that actually resolve it instead.
    if (gates.some((gate) => gate.id === SOURCE_SIZE_GATE_ID)) {
      add(
        'source-size',
        fillTemplate(WHATS['source-size.id-squatter'], {}),
        `HAND-APPLY: in ${GATES_REL}, either rename the "${SOURCE_SIZE_GATE_ID}" gate to an id of its own, or repoint its cmd at node ${q(tool)} --check — then re-run recommendations`,
        'source-size.id-squatter',
      );
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
// alike; an UNMANAGED hook is a loud skip (manual merge, never an overwrite offer); a
// non-final-capable declaration gets NO offer (an armed guard over a matrix that cannot mint a
// receipt would block every commit).
const INSTALLER_MARKER_RE = /:install-git-hooks\.mjs$/m;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Convergence needs the EXACT canonical armed line the installer writes — full-line anchored on
// the kit's OWN resolved guard path. A commented-out line or a lookalike path (fake-commit-guard)
// must never read as armed (that would suppress the offer and leave commits unguarded).
const canonicalGuardLineRe = () => new RegExp(`^node "${escapeRe(toolPath('commit-guard.mjs'))}" --check$`, 'm');
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
      skip('commit-guard', new Error('the hook installer (scripts/install-git-hooks.mjs) is not deployed — run upgrade first'));
      return;
    }
    const hooksPath = (deps.gitHooksPath ?? resolveGitHooksPath)(root);
    if (hooksPath === null) return; // not a git tree — nothing to hook
    const hook = (() => {
      try {
        return String(read(join(hooksPath, 'pre-commit'), 'utf8'));
      } catch {
        return null;
      }
    })();
    if (hook !== null && canonicalGuardLineRe().test(hook)) return; // armed — converged (managed or not)
    if (hook !== null && !INSTALLER_MARKER_RE.test(hook)) {
      skip('commit-guard', new Error('an UNMANAGED pre-commit hook exists — merge the guard line by hand (the installer refuses to overwrite it)'));
      return;
    }
    add('commit-guard', fillTemplate(WHATS['commit-guard'], {}), `node ${q(installer)} --commit-guard ${q(toolPath('commit-guard.mjs'))}`);
  } catch (err) {
    skip('commit-guard', err);
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
    if (!sg.filePlaced) {
      placeRecovery();
      return;
    }
    if (readReadLaneToggle(root, deps)) {
      // The lane is ON: converged IFF the placed hook is byte-current — a stale (pre-1.48) hook never
      // reads lanes.json, so the enabled lane is a silent no-op the user must reseed (council B7). The
      // rm target is ABSOLUTE (council R2-M3) so running the recovery from any cwd can only delete this
      // repo's hook.
      const currency = readPlacedHookCurrency(root, deps);
      if (currency === HOOK_CURRENCY.CURRENT) return; // converged
      if (currency === HOOK_CURRENCY.ABSENT) {
        // The survey saw it placed and it is gone by the time we read it. The missing arm is the
        // honest report of that; a reseed recovery whose `rm` targets nothing is not.
        placeRecovery();
        return;
      }
      // ONE render per condition — and the item that renders is the one whose CAUSE is true. A hook
      // that postdates the read-lane but predates the marker key reads lanes.json perfectly well, so
      // this arm's "an old hook never reads lanes.json" would be a false diagnosis over it, while the
      // marker arm's is exact. Both carry the same remove-then-reseed recovery, so deferring costs
      // the reader nothing and buys a true sentence. The condition is that the marker arm REALLY
      // rendered — never the conditions it would have used, re-derived here: each probe reads the
      // placed hook itself, so a hook changing between the two reads could otherwise have both defer
      // to the other and leave the dark lane reported by nobody.
      if (shared.markerStaleRendered === true) return;
      add(
        'read-lane',
        fillTemplate(WHATS['read-lane.stale'], {}),
        `HAND-APPLY: rm ${q(join(root, GATE_HOOK_REL))}, then node ${q(toolPath('gate-hook.mjs'))} --apply --cwd ${q(root)}`,
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
// entry — so `upgrade` reported «nothing is broken» to a user who did not have it. There is no writer
// for this hook, so the apply is a HAND-APPLY pointer at the mode doc, which carries the exact block
// and the three merge cases.
const probeStateBlockHook = ({ root, deps, add, skip }) => {
  try {
    const project = readSettingsFile(join(root, SETTINGS_FILE), { ...deps, cwd: root });
    const local = readSettingsFile(join(root, SETTINGS_LOCAL_FILE), { ...deps, cwd: root });
    if (isStateBlockGuardWired(project.data) || isStateBlockGuardWired(local.data)) return; // converged
    add(
      'state-block',
      fillTemplate(WHATS['state-block'], {}),
      `HAND-APPLY: add a Stop hook running ${STATE_BLOCK_HOOK_COMMAND} to ${SETTINGS_FILE} — the exact block and the three merge cases are in references/modes/state-block-guard.md`,
    );
  } catch (err) {
    skip('state-block', err);
  }
};

// The cheap-agents offer (OPT-IN-SHIPS-INVISIBLE). This item exists because the coverage registry
// surfaced its absence: `agents` is the family's SECOND `.claude/` writer, the `help` Tune tail
// advertises it, and the advisor had no entry for it — so a user who never runs `help` never learned
// it existed while the advisor reported the deployment optimal. Found by the guard, not by an incident.
// Only a PLACE action counts as a gap: `already-current` is converged and `customized-preserved` is
// the user's own edit, which the writer never clobbers and the advisor must never nag about.
const probeCheapAgents = ({ root, deps, add, skip }) => {
  try {
    const preflight = preflightCheapAgents({ cwd: root }, deps);
    // The writer refuses below the expected lineage, so offering its command would hand the user a
    // guaranteed failure — the honest surface is a stated skip naming the recovery.
    if (!preflight.stampOk) {
      skip('agents', new Error(`not a deployed agent-workflow project at the current lineage (found ${preflight.stamp ?? 'none'}) — run upgrade first`));
      return;
    }
    const toPlace = preflight.plan.filter((item) => item.action === 'place');
    if (toPlace.length === 0) return; // converged
    // The writer's contract is «--dry-run first, ALWAYS» (references/modes/agents.md, and its stated
    // invariant «preview by default»), so the rendered line is the PREVIEW — this item joins the
    // dry-run-preview class the mode doc already documents for the gates-declaration seeder, where the
    // same confirmation then runs the follow-up the preview prints. Rendering --apply here would have
    // skipped the per-vehicle plan the user is supposed to see before consenting.
    // The hidden-mode reconcile rides the detail, never the apply line: it is wrong to run on a
    // VISIBLE deployment, and the apply slot must stay one pure executable command.
    add(
      'agents',
      fillTemplate(WHATS.agents, { n: toPlace.length }),
      `node ${q(toolPath('cheap-agents.mjs'))} --cwd ${q(root)}`,
      'agents',
      `hidden-mode deployments only: after the --apply the preview prints, run node ${q(toolPath('hide-footprint.mjs'))} --dir ${q(root)} --reconcile so the placed .claude/agents/ stays invisible to git status`,
    );
  } catch (err) {
    skip('agents', err);
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
    add('sandbox-masks', fillTemplate(WHATS[variant], { n: p.masks.length, m: p.staleReal.length }), apply);
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

// The manifest-declared session-sandbox recipe surfaces of every BUNDLED bridge whose review
// wrapper is in the wired set — networkHosts ∪ writableDirs, derived from the manifests (the
// single documentation source), never hardcoded here.
const bundledSandboxRecipe = (placedWrappers, deps) => {
  const readFile = deps.readFile ?? readFileSync;
  const readDir = deps.readdir ?? readdirSync;
  const bundleRoot = deps.bundleRoot ?? DEFAULT_BUNDLE_ROOT;
  const hosts = [];
  const dirEntries = [];
  for (const dir of readDir(bundleRoot)) {
    // An unreadable/unparsable bundled manifest must NOT thin the recipe silently — a partial
    // recipe rendered as complete is worse than no item. The throw reaches the probe's catch and
    // becomes a stated skip.
    let manifest;
    try {
      manifest = JSON.parse(readFile(join(bundleRoot, dir, 'capability.json'), 'utf8'));
    } catch (err) {
      // ENOTDIR = the entry is a stray regular file (.DS_Store, a README), not a bridge bundle.
      if (err?.code === 'ENOTDIR') continue;
      throw new Error(`bundled manifest unreadable: ${join(dir, 'capability.json')} — ${err?.message ?? err}`);
    }
    const reviewCmd = manifest?.roles?.review?.cmd;
    if (!reviewCmd || !placedWrappers.includes(reviewCmd)) continue;
    if (Array.isArray(manifest.networkHosts)) {
      for (const h of manifest.networkHosts) if (!hosts.includes(h)) hosts.push(h);
    }
    if (Array.isArray(manifest.writableDirs)) dirEntries.push(...manifest.writableDirs);
  }
  return { hosts, dirEntries };
};

// D6 resolution, mirroring the wrappers' byte-semantics (`${VAR:-default}` + the exact case-arms:
// `~` / `~/…` / `/…` ride as-given; EVERY other form — including `~user/…`, which the wrappers
// never resolve as a home path — anchors like a relative path). The advisor anchors to the TARGET
// PROJECT ROOT (the pinned --cwd), matching what a wrapper invoked from the project root resolves
// (the documented dispatch form; the wrapper itself anchors to its invocation $PWD).
const resolveWritableDir = (entry, { env, root }) => {
  const value = entry.env == null ? '' : (env[entry.env] ?? '');
  if (value === '') return entry.default;
  if (value === '~' || value.startsWith('~/') || value.startsWith('/')) return value;
  return resolve(root, value);
};

// The NEUTRAL recipe fingerprint (D4): a hash over the resolved hosts ∪ dirs data — an
// acknowledgement token, never a security key. Canonical form is HOME-SYMBOLIC: an
// absolute dir under the resolved home canonicalizes BACK to its `~/…` form and tilde forms stay
// symbolic — so `~/.codex` and its absolute expansion acknowledge the SAME recipe AND the default
// recipe's fingerprint is identical across machines/users (a committed project-scope ack never
// churns between them); only a genuinely-outside-home absolute override stays absolute
// (machine-specific by nature). Any change to the recipe re-fires the item.
export const recipeFingerprint = ({ hosts, dirs, home }) => {
  const homeAbs = resolve(home);
  const norm = (d) => {
    if (d === '~') return '~';
    if (d.startsWith('~/')) return `~/${d.slice(2)}`;
    const abs = resolve(d);
    if (abs === homeAbs) return '~';
    return abs.startsWith(`${homeAbs}/`) ? `~/${abs.slice(homeAbs.length + 1)}` : abs;
  };
  const canonical = JSON.stringify({ hosts: [...hosts].sort(), dirs: [...new Set(dirs.map(norm))].sort() });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
};

// The fingerprint for an acknowledgment whose subject is already a canonical STRING — the census
// fact, the sorted set of declared tool-elsewhere claims — rather than a hosts ∪ dirs recipe. Same
// 16-hex shape the ack writer validates, so every lane records one comparable token; the canonical
// form is the caller's, because only the caller knows which part of its fact is durable and which
// is churn (the census binds the verdict + extension set, never per-file counts).
export const factFingerprint = (fact) => createHash('sha256').update(fact).digest('hex').slice(0, 16);

// The kit-owned neutral ack store (D4; AD-055 Part I): a FAMILY-OWNED strict-JSON file no host
// validator guards — top-level key `sandboxLaneAck` (+ optional `_README`), unknown keys tolerated
// on read (future acks are siblings). This is the PRIMARY ack channel; the legacy settings-scope
// keys below are read for one deprecation window. The sandbox/permissions security keys are NEVER
// consulted as an ack.
export const ACKS_FILE = 'docs/ai/acks.json';
export const ACKS_LANE_KEY = 'sandboxLaneAck';
export const ACKS_WORKTREES_DIR_KEY = 'worktreesDirAck';
export const ACKS_COVERAGE_DOMAIN_KEY = 'coverageDomainAck';
export const ACKS_SOURCE_SIZE_COPY_KEY = 'sourceSizeCopyAck';
// The CLOSED-WORLD ack-lane registry: the lane name an advisor item renders on the writer's
// command line → the store key that writer sets. A lane the registry does not name is a usage
// refusal at the writer, never a newly-invented key in the shared store.
//
// An ack lane exists for a state the maintainer can only ANSWER, never converge: a tracked tree the
// coverage domain cannot reach, a checker deliberately vendored elsewhere. It is deliberately NOT
// available to a state that is simply BROKEN — a dead checker/producer pair is fixed, not
// acknowledged, so no lane names it.
export const ACK_LANES = Object.freeze({
  'sandbox-lane': ACKS_LANE_KEY,
  'worktrees-dir': ACKS_WORKTREES_DIR_KEY,
  'coverage-domain': ACKS_COVERAGE_DOMAIN_KEY,
  'source-size-copy': ACKS_SOURCE_SIZE_COPY_KEY,
});

// The opt-in read-lane toggle file (AD-055 Part II) — the SAME kit-owned docs/ai/lanes.json the
// placed hook reads live. The read-lane item offers to enable it once the hook is placed+wired.
export const LANES_FILE = 'docs/ai/lanes.json';
export const READ_LANE_KEY = 'readLane';

// The placed gate hook + the bundled runtime the read-lane item byte-compares for currency (AD-055
// Part II, council B7): an enabled lane over a STALE hook is a silent no-op — the pre-1.48 hook never
// reads lanes.json — so it must surface as an ATTENTION reseed, not a silent convergence.
const GATE_HOOK_REL = '.claude/hooks/agent-workflow-gates.mjs';
const BUNDLED_HOOK_ABS = join(HERE, '..', 'references', 'hooks', 'gate-approve.mjs');

// The state-block-guard wiring the advisor looks for. Matched on the RUNTIME FILE NAME inside the
// command, not on an exact string: the hook has no writer, so every user pastes their own path —
// a copy under `.claude/hooks/`, a kit-source path, `--require-block` or not. Any Stop entry that
// runs this runtime counts as wired, which is the honest question ("is it watching?").
export const STATE_BLOCK_HOOK_RUNTIME = 'state-block-guard.mjs';
// NO `--require-block` in the offered command. That flag turns on the absent-block report, and this
// kit does not mandate the three-part closing block — recommending it to every project would hand
// them a hook that warns after nearly every turn. The mode doc explains when to add it. (Offering the
// strict flag by default would also contradict the very reason the report was made opt-in.)
export const STATE_BLOCK_HOOK_COMMAND = `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${STATE_BLOCK_HOOK_RUNTIME}"`;
const runsStateBlockGuard = (hook) => typeof hook?.command === 'string' && hook.command.includes(STATE_BLOCK_HOOK_RUNTIME);
// Both entry shapes count. The matcher-group form (an object carrying its own `hooks` array) is what
// this family ships and what was observed firing; a flat entry is accepted too, because the question
// this probe answers is "is anything watching?" — and guessing NO for a wiring that works would nag
// someone who already did the work.
const isStateBlockGuardWired = (data) => {
  const entries = data?.hooks?.Stop;
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => (Array.isArray(entry?.hooks)
    ? entry.hooks.some(runsStateBlockGuard)
    : runsStateBlockGuard(entry)));
};

// The placed gate hook's currency, as the states a caller must tell APART (D8). Read through the
// writer-class fail-closed no-follow primitive, never a bare readFile: a byte-compare that FOLLOWS a
// symlink can call a placed hook current because something ELSE is — a wrong verdict, which is worse
// than a missing one. `current` and `stale` are answers; `absent` is one the caller disposes of
// itself (a hook that is not there belongs to the place offers, never to a refresh arm); a symlink,
// a directory and an unreadable target all THROW into the probe's stated-skip lane.
const HOOK_CURRENCY = Object.freeze({ CURRENT: 'current', STALE: 'stale', ABSENT: 'absent' });
const readPlacedHookCurrency = (root, deps) => {
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

// The LEGACY neutral ack namespace (pre-AD-055): read from BOTH settings scopes until the next kit
// MAJOR (2.0.0) so a never-migrated host stays converged across the deprecation window (Decisions 3).
export const SANDBOX_LANE_ACK_PARENT = 'agentWorkflow';
export const SANDBOX_LANE_ACK_KEY = 'sandboxLaneAck';

// Read the family-owned ack store. An ABSENT file (or absent docs/ai) is the NORMAL not-yet-acked
// state → null (plain fall-through, never a skip). A parse/IO error on an EXISTING file THROWS — the
// probe's catch turns it into a stated skip line (Decisions 2). A non-object root is a malformed
// store (fail-closed skip); a non-string value at the key is tolerated → null (the item re-fires).
// The WHOLE path chain (root / docs / ai / acks.json) is guarded WITHOUT following symlinks
// BEFORE any read: a symlinked ANCESTOR could otherwise read an ack from OUTSIDE the project (the
// writer refuses such a deployment — the reader must too), a symlinked/dangling LEAF must not read as
// not-yet-acked, and a non-regular target (FIFO/dir/device) is a fail-closed SKIP — never read it (a
// FIFO would BLOCK the advisor). ENOENT-safe: an absent file/dir is the NORMAL not-yet-acked null.
const readAckValue = (root, deps, ackKey) => {
  const readFile = deps.readFile ?? readFileSync;
  const lstat = deps.lstat ?? lstatSync;
  const absPath = join(root, ACKS_FILE);
  let st;
  try {
    assertContainedRealPath(root, absPath, { lstat }); // symlinked root/ancestor/leaf or escape → throws
    st = lstat(absPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return null; // genuinely absent (file or docs/ai) — normal not-yet-acked
    throw err; // a symlinked ancestor/leaf, an escape, or a real IO error — stated skip
  }
  if (!st.isFile()) {
    throw new Error(`${ACKS_FILE} is not a regular file — refusing to read it`);
  }
  const parsed = JSON.parse(readFile(absPath, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${ACKS_FILE}: expected a JSON object`);
  }
  const value = parsed[ackKey];
  return typeof value === 'string' ? value : null;
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
export const RISK_NOTED_KEYS = Object.freeze(['sandbox-lane', 'read-lane', 'worktrees-dir', 'adr-store-migration', 'gates-inert', 'source-size', 'gate-hook']);

const probeSandboxLane = ({ root, deps, add, skip }) => {
  try {
    const settings = readSettingsFile(join(root, SETTINGS_FILE), { ...deps, cwd: root });
    const localSettings = readSettingsFile(join(root, SETTINGS_LOCAL_FILE), { ...deps, cwd: root });
    const sandbox = settings.data?.sandbox;
    const excluded = Array.isArray(sandbox?.excludedCommands) ? sandbox.excludedCommands : [];
    const probePlaced = deps.findWrapper ?? ((cmd) => findOnPath(cmd, deps).state === 'present');
    // Wired = the FULL two-surface tier proof (excludedCommands + the code-mode allow rule, either
    // scope) — surfacing the recipe while the tier is half-configured would front-run the
    // bridge-tier item (codex terminal). Byte-form from the tier's own constants.
    const allowRules = [
      ...(Array.isArray(settings.data?.permissions?.allow) ? settings.data.permissions.allow : []),
      ...(Array.isArray(localSettings.data?.permissions?.allow) ? localSettings.data.permissions.allow : []),
    ];
    const wired = BRIDGE_REVIEW_WRAPPERS.filter(
      (w) => excluded.includes(w) && probePlaced(w) && allowRules.includes(`Bash(${w} ${BRIDGE_REVIEW_MODE}:*)`),
    );
    if (wired.length === 0) return; // the tier is not (fully) wired — the bridge-tier item covers first
    const { hosts, dirEntries } = bundledSandboxRecipe(wired, deps);
    const env = deps.getenv ?? process.env;
    const home = deps.home ?? homedir();
    const dirs = [];
    for (const entry of dirEntries) {
      const resolved = resolveWritableDir(entry, { env, root });
      if (!dirs.includes(resolved)) dirs.push(resolved);
    }
    const fingerprint = recipeFingerprint({ hosts, dirs, home });
    // Convergence is the NEUTRAL fingerprint-bound acknowledgement: the item converges iff the
    // CURRENT fingerprint equals the ack in ANY consulted store — the family-owned acks.json FIRST,
    // then the legacy settings scopes; a stale value in one store is ignored when another matches
    // (Decisions 2). A changed recipe (hosts, dirs, or an env override) re-fires the item (D4).
    const acks = [
      readAckValue(root, deps, ACKS_LANE_KEY),
      settings.data?.[SANDBOX_LANE_ACK_PARENT]?.[SANDBOX_LANE_ACK_KEY],
      localSettings.data?.[SANDBOX_LANE_ACK_PARENT]?.[SANDBOX_LANE_ACK_KEY],
    ];
    if (acks.includes(fingerprint)) return; // the acknowledged recipe — the item converged
    // The item joins the CONSENT-GATED WRITER class (Decisions 4): the apply is the ack writer's
    // PREVIEW one-liner (pure executable, cwd-independent), carrying the neutral fingerprint — never
    // a security key. The LIVE recipe (egress hosts + resolved writable dirs) rides a separate
    // rendered `recipe:` line (the fill source for the mode doc's lane-(2) hand-apply block); the
    // fingerprint encodes it, so a changed recipe re-fires with a fresh command.
    const recipe = `egress hosts [${hosts.join(', ')}]; writable state dirs [${dirs.join(', ')}] (observed-minimal; a blocked host names itself at run time)`;
    add(
      'sandbox-lane',
      fillTemplate(WHATS['sandbox-lane'], {}),
      `node ${q(toolPath('ack-write.mjs'))} --fingerprint ${fingerprint} --cwd ${q(root)}`,
      'sandbox-lane',
      recipe,
    );
  } catch (err) {
    skip('sandbox-lane', err);
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
// through the shared neutral fingerprint (the same home-symbolic canonicalization the sandbox-lane
// ack uses, so a home-anchored dir acks portably). The binding is to the RESOLVED probe dir, so the
// item re-fires only when that resolved dir changes — two ABSENT parentDir values sharing an
// existing ancestor resolve to the same dir and keep the same ack.
export const worktreesDirFingerprint = (probeDir, home) => recipeFingerprint({ hosts: [], dirs: [probeDir], home });

// The worktrees-dir arming item (parallel feature worktrees): fires when write access to the
// resolved worktrees parent dir (docs/ai/worktrees.json parentDir, else the repo's own parent) is
// neither confirmed by a trusted host signal nor declared/acknowledged by the maintainer. Before
// D7 the host signal was the ONLY convergence lane — injectable from tests but never supplied in
// production, so the item fired forever even once its own advice had been applied.
const probeWorktreesDir = ({ root, deps, add, skip }) => {
  try {
    const config = loadWorktreesConfig(root, deps);
    const parent = config.parentDir == null ? dirname(root) : resolve(root, config.parentDir);
    // the SAME canonical derivation the provision preflight probes (worktrees.mjs) — an absent
    // configured dir resolves to its nearest existing ancestor, never a false denial
    const probeDir = resolveProbeDir(parent, deps);
    // A supplied host signal is runtime truth and OVERRIDES both declaration lanes in EITHER
    // direction: a trusted yes converges, a trusted no fires however the project is configured.
    const hostSignal = deps.canWriteDir?.(probeDir);
    if (hostSignal === true) return;
    const home = deps.home ?? homedir();
    const fingerprint = worktreesDirFingerprint(probeDir, home);
    if (hostSignal !== false) {
      if (declaresWritableDir(root, probeDir, deps)) return;
      if (readAckValue(root, deps, ACKS_WORKTREES_DIR_KEY) === fingerprint) return;
    }
    const dir = truncatedTo(oneLineOf(probeDir), templateBudget(WHATS['worktrees-dir']));
    const grantAdvice = `add ${JSON.stringify(probeDir)} to sandbox.filesystem.allowWrite in .claude/settings.json on settings-native hosts; on harness-managed hosts grant this dir for the session or use the provision terminal fallback`;
    // The consent-flow executes only the APPLY slot; a HAND-APPLY line is maintainer territory and
    // a recipe: detail is informational. So when the ack lane is open, the runnable ack preview IS
    // the apply (dry-run; it prints the exact --apply the flow then runs) and the grant advice
    // rides the detail, labeled as the first step. Against a trusted NO the ack could never
    // converge, so the grant advice is the apply and no ack surfaces.
    if (hostSignal === false) {
      add('worktrees-dir', fillTemplate(WHATS['worktrees-dir'], { dir }), `HAND-APPLY: ${grantAdvice}`);
    } else {
      add(
        'worktrees-dir',
        fillTemplate(WHATS['worktrees-dir'], { dir }),
        `node ${q(toolPath('ack-write.mjs'))} --lane worktrees-dir --fingerprint ${fingerprint} --cwd ${q(root)}`,
        'worktrees-dir',
        `HAND-APPLY FIRST: ${grantAdvice}; THEN this item's apply one-liner previews the dir-bound ack and prints the exact --apply that records it`,
      );
    }
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
    // HAND-APPLY, not the standard lane: the consent flow executes the apply slot against the
    // confirmation given BEFORE the preview, and this crossing requires informed consent AFTER its
    // dry-run. A runnable one-liner here would auto-run a tree-mutating migration on stale consent.
    add(
      'adr-store-migration',
      fillTemplate(WHATS['adr-store-migration'], { shape }),
      `HAND-APPLY: node ${q(toolPath('migrate-adr-store.mjs'))} --dry-run --cwd ${q(root)} — then re-run with --apply ONLY after showing the plan and getting fresh consent`,
    );
  } catch (err) {
    skip('adr-store-migration', err);
  }
};

// ── assembly (frozen presentation order) ─────────────────────────────────────────────────────────
const PROBES = Object.freeze([
  probeVelocityItems,
  probeAutonomyItems,
  probeSandboxProvision,
  probeReviewRecipe,
  probeGates,
  probeGatesInert,
  probeSourceSize,
  probeCommitGuard,
  probeReadLane,
  probeStateBlockHook,
  probeCheapAgents,
  probeFamilyFreshness,
  probeAdrStore,
  probeMasksItem,
  probeSandboxLane,
  probeWorktreesDir,
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
  // `detail` (optional) is an extra rendered `recipe:` line — factual context that is TOO LONG for
  // the capped WHAT and does NOT belong in the pure-command apply (the sandbox-lane live recipe:
  // egress hosts + resolved writable dirs; the worktrees-dir hand-apply-first grant advice; the
  // agents hidden-mode reconcile follow-up). Single-line like apply; absent for every other item.
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
    items.push({ key, variant, severity: SEVERITIES[variant], what, benefit: BENEFITS[key], apply, detail });
    return true;
  };
  // The per-run scratch a probe uses to tell a LATER probe what it actually did. Written by exactly
  // one pair today (the marker-stale ⟷ read-lane.stale precedence) and read in the frozen PROBES
  // order, so the reader can never run first.
  const shared = {};
  for (const probe of deps.probes ?? PROBES) probe({ root, deps, add, skip, shared });
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
      if (item.detail) lines.push(`   recipe: ${item.detail}`);
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
sub-optimal · the benefit in one plain line · an optional \`recipe:\` line (the sandbox-lane live
recipe, the worktrees-dir hand-apply-first grant advice, or the agents hidden-mode reconcile
follow-up) · the exact consent-gated apply one-liner}. --cwd is
REQUIRED (the target project is explicit, never inferred from the shell's current directory). The
section renders present-even-when-empty ("${RECOMMENDATIONS_EMPTY_LINE}"); a probe failure is a
stated skipped-item line. Apply lines are cwd-independent (absolute tool paths, a pinned --cwd;
the doctor item pins via a cd prefix; the ONE exception is the set-autonomy item — a
conversational skill invocation labeled "run IN the target project") and preserve each writer's
own consent semantics; the kit never seeds sandbox network/filesystem allowances (HAND-APPLY
territory), and the sandbox-lane convergence is a neutral fingerprint acknowledgement recorded by
the consent-gated ack writer into docs/ai/acks.json (never a security key).

Read-only: never writes, never commits, never runs a subscription CLI. Exit codes: 0 report
rendered (items or empty); 1 error; 2 usage.`;

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
    const result = buildRecommendations({ cwd, deps: ctx.deps ?? {} });
    if (json) return { code: 0, stdout: JSON.stringify(result, null, 2), stderr: '' };
    return { code: 0, stdout: formatRecommendations(result), stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `recommendations: ${err.message}` };
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const r = main(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
}
