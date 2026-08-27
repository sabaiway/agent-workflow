#!/usr/bin/env node
// Activity-procedures advisor — the read-only `/agent-workflow-kit procedures <activity>` surface.
//
// It composes the AD-018 orchestration recipes into NAMED activities: it reads the canonical procedure
// steps LIVE from the installed agent-workflow-engine (references/procedures.md — AD-016 live read, no
// bundled mirror), reads the per-project, hand-edited config (docs/ai/orchestration.json), composes the
// readiness every caller composes (detected backends + the executor vehicle), and prints the activity's
// steps VERBATIM + the resolved effective recipe per slot, plus the project's DECLARED source-size
// practice when it declares one (D-17 U1).
//
// Invariants (mirror recipes.mjs): pure-where-possible, READ-ONLY (never writes, never commits, never
// runs a subscription CLI). The deterministic resolution lives in the kit (resolveActivityRecipe), not
// in the agent. Dependency-free, Node >= 22.
//
// Exit codes: 0 success (an unsatisfiable explicit override degrades LOUDLY but still exits 0 — it is a
// valid request that gracefully degraded); 2 usage (unknown <activity> / bad --override syntax);
// 1 config error (malformed / schema-invalid / unreadable orchestration.json) or engine error (the
// installed engine is absent / invalid / too old to ship references/procedures.md).

import { readFileSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectBackends, wrapperCmdFor, wrapperContractFor } from './detect-backends.mjs';
// The host-level bridge-settings registry (manifest-as-source) + its allowed-value labels. READ-ONLY
// core only — never the writer — so this read-only advisor never imports the atomic-write core.
import { loadRegistry, allowedLabel } from './bridge-settings-read.mjs';
import { isDirectRun } from './direct-run.mjs';
import { ACTIVITIES, SLOT_RECIPES, isSwitchSlot, resolveActivityRecipe, planRecipe, composeReadiness } from './recipes.mjs';
import { resolveEngineDir, readEngineFragment, PROCEDURES_FRAGMENT_REL } from './engine-source.mjs';
// The plan-in-flight detector (AD-038) — imported from the plan-files.mjs LEAF (read-only fs by
// construction); the WRITER-capable grounding.mjs is only NAMED in rendered text, never imported.
import { plansInFlight, PLANS_REL } from './plan-files.mjs';
// The family's ONE shell quoter for a RENDERED command operand (bare when the value is already safe,
// single-quoted otherwise) — the same leaf eight other command renderers here read through.
import { shellQuoteArg } from './repo-lex.mjs';
// The config schema/read core (orchestration-config.mjs, the single config contract): the reader +
// the SHARED slot/recipe validity, never the fs-writer (orchestration-write.mjs) DIRECTLY — the
// import-split test pins the direct-import rule.
import { CONFIG_REL, fail, loadConfig, assertSlotRecipe } from './orchestration-config.mjs';
import { AUTONOMY_REL, loadAutonomy, resolveAutonomy, isSparseSeedConfig } from './autonomy-config.mjs';
// The flow armed-halves probe (P8): read-only store presence/adoption facts, from the read module
// that OWNS no write API — never the mixed flow-store module (append API) DIRECTLY, like never
// orchestration-write (the import-split test pins both direct rules; the TRANSITIVE claim is
// structural — test/read-graph-purity.test.mjs pins it).
import { resolveFlowStorePath, readFlowStore } from './flow-store-read.mjs';
import { CHAIN_KIND } from './flow-record.mjs';
// The declared source-size practice (D-17 U1), read through the practice's PURE READ core — never
// source-size-check.mjs, which owns the writer half: this advisor is a read root of
// test/read-graph-purity.test.mjs, and the core exists so a surface can ask without reaching a writer.
import { SOURCE_SIZE_CONFIG_REL, SOURCE_SIZE_WHY, loadSourceSizeConfig, practiceFacts } from './source-size-core.mjs';
export { CONFIG_REL };

// ── argument + override parsing (usage errors → exit 2) ─────────────────────────────

// Parse the activity's --override <slot>=<value> tokens into a { slot: recipe } map, validating each
// against the SHARED slot/recipe validity table (assertSlotRecipe — the SAME accept/reject the set-recipe
// op parser uses, drift-guarded). Every malformed token is a USAGE error (exit 2): a bare `<recipe>`, an
// unknown slot for the activity, an invalid recipe-for-slot, or a duplicate slot. (An override naming a
// recipe whose backend merely is not `ready` is NOT a usage error — it degrades loudly at resolution
// time, exit 0.) The grammar stays activity-SCOPED, unlike the writer's `--set <activity>.<slot>=<x>`.
const parseOverrides = (tokens, activity) => {
  const overrides = {};
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq <= 0) throw fail(2, `--override must be <slot>=<value> (got "${tok}")`);
    const slot = tok.slice(0, eq);
    const recipe = tok.slice(eq + 1);
    assertSlotRecipe(activity, slot, recipe); // shared validity (unknown slot / invalid recipe → exit 2)
    if (slot in overrides) throw fail(2, `--override: duplicate override for slot "${slot}"`);
    overrides[slot] = recipe;
  }
  return overrides;
};

const KNOWN_ACTIVITIES = () => Object.keys(ACTIVITIES).join(', ');

// Parse argv → { activity, overrides, json }. Unknown activity / bad flags / bad --override → exit 2.
const parseArgs = (argv) => {
  let activity;
  let json = false;
  const overrideTokens = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') {
      json = true;
    } else if (a === '--override') {
      const tok = argv[i + 1];
      if (tok === undefined || tok.startsWith('--')) throw fail(2, '--override requires <slot>=<value>');
      overrideTokens.push(tok);
      i += 1;
    } else if (a.startsWith('--override=')) {
      overrideTokens.push(a.slice('--override='.length));
    } else if (a.startsWith('-')) {
      throw fail(2, `unknown flag: ${a}`);
    } else if (activity === undefined) {
      activity = a;
    } else {
      throw fail(2, `unexpected argument: ${a}`);
    }
  }
  if (!activity) throw fail(2, `missing <activity> (known: ${KNOWN_ACTIVITIES()})`);
  const activityDef = ACTIVITIES[activity];
  if (!activityDef) throw fail(2, `unknown activity "${activity}" (known: ${KNOWN_ACTIVITIES()})`);
  return { activity, overrides: parseOverrides(overrideTokens, activity), json };
};

// ── engine canon: live read + per-activity section extraction (engine errors → exit 1) ──

// Read the activity-procedures canon LIVE from the installed engine. A failure (engine absent / invalid
// / too old to ship references/procedures.md) is surfaced loudly with the resolver's message + an
// upgrade hint — never a cryptic fs error.
const readProceduresCanon = (env, home) => {
  const { dir, source } = resolveEngineDir({ env, home });
  try {
    return readEngineFragment(dir, { source, rel: PROCEDURES_FRAGMENT_REL });
  } catch (err) {
    throw fail(
      1,
      `${err.message}\n  (the activity-procedures canon needs agent-workflow-engine shipping references/procedures.md — upgrade the engine if it is installed but older.)`,
    );
  }
};

// Extract a `## <activity>` section (its heading → the next `## ` heading or EOF) and return it
// VERBATIM (trailing blank lines trimmed). The kit prints this string; it never parses the steps.
export const extractSection = (text, activity) => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${activity}`);
  if (start === -1) {
    throw fail(
      1,
      `the installed engine's procedures.md has no "## ${activity}" section — upgrade the engine (it predates this activity).`,
    );
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').replace(/[\r\n]+$/, ''); // trim trailing blank lines (LF or CRLF)
};

// ── resolution + rendering ─────────────────────────────────────────────────────────

const resolveAllSlots = ({ activity, config, detection, overrides }) => {
  // The host-level settings knobs (manifest-as-source), best-effort: a corrupt bundle degrades to none
  // and the advisor never crashes. Attached per wrapper cmd via each knob's `appliesTo`. Fact-only —
  // model/effort are not knobs, so no model claim can ride here.
  const registry = (() => {
    try {
      return loadRegistry({});
    } catch {
      return new Map();
    }
  })();
  const knobsFor = (cmd) => [...registry.values()].filter((k) => (k.appliesTo ?? []).includes(cmd));
  return Object.entries(ACTIVITIES[activity].slots).map(([slot, slotType]) => {
    const resolved = resolveActivityRecipe({ config: config ?? {}, readiness: detection, activity, slot, override: overrides[slot] });
    if (isSwitchSlot(slotType)) return { slot, ...resolved, backends: [], contracts: [], vehicles: [] };
    // The concrete wrapper set this slot's EFFECTIVE recipe dispatches (empty for solo). Reuse
    // planRecipe's drift-guarded dispatch for WHICH backends, then resolve each (backend, role) to its
    // manifest wrapper cmd via the bridge registry — no wrapper name is hand-composed here. A vehicle
    // step is NOT a bridge: it carries its own state and is never looked up in a manifest.
    const { dispatch } = planRecipe(resolved.recipe, detection);
    const vehicles = dispatch.filter((d) => d.vehicle != null).map((d) => ({ backend: d.backend, state: d.vehicle }));
    const bridged = dispatch.filter((d) => d.vehicle == null);
    const backends = bridged.map((d) => wrapperCmdFor(d.backend, d.role)).filter(Boolean);
    // The full DRIVING CONTRACT per dispatched (backend, role) — resolved HERE, on the raw dispatch
    // pairs, BEFORE they are flattened to wrapper names (the name array cannot reconstruct the role).
    // Every slot with a non-empty dispatch gets contracts — including execute=delegated; the contract
    // is NEVER gated by REVIEW_RECIPES (that set gates only the review-loop economics block).
    const contracts = bridged
      .map((d) => ({ backend: d.backend, role: d.role, cmd: wrapperCmdFor(d.backend, d.role), contract: wrapperContractFor(d.backend, d.role) }))
      .filter((c) => c.cmd && c.contract)
      // `retired` rides along: without it this surface advertised a RETIRED key as an ordinary
      // settable knob, while the writer refuses to set it — a driving contract that contradicts the
      // tool it points at.
      .map((c) => ({ ...c, settings: knobsFor(c.cmd).map((k) => ({ key: k.key, allowed: allowedLabel(k), retired: k.retired ?? null })) }));
    return { slot, ...resolved, backends, contracts, vehicles };
  });
};

// An unsatisfiable EXPLICIT override is the only "warning" (loud, flagged for the agent to relay). A
// graceful config/default degradation is reported as a per-slot reason, not a warning.
const collectWarnings = (slots) =>
  slots
    .filter((s) => s.overrideUnsatisfied)
    .map(
      (s) =>
        `override "${s.slot}=${s.degradedFrom}" could not be satisfied here — degraded to ${s.recipe} (${s.reason}). Tell the user.`,
    );

const SOURCE_LABEL = {
  default: 'computed default',
  config: `from ${CONFIG_REL}`,
  override: 'from --override',
};

// The explicit wrapper set a review/execute recipe dispatches, printed beside the recipe name so the A2
// recipe-fidelity obligation ("run every named backend, every round") is mechanical at the point of use.
// ≥2 backends (Council) → the every-round reminder; exactly 1 → the lone wrapper; Solo dispatches none → ''.
const backendSetLabel = (backends) =>
  !backends || backends.length === 0
    ? ''
    : backends.length >= 2
      ? ` → run every backend every round: ${backends.join(' + ')}`
      : ` → ${backends[0]}`;

// The review-loop economics block (M1 + M6's firing half) — printed when the activity engages a review
// backend (a slot resolving reviewed | council) and OMITTED for solo. It paraphrases the procedures.md
// Fold + loop step + orchestration §4 canon (no rival rule): the ≤2-round architecture cap, the bar met by RAISING a
// surviving major to an acceptance invariant (not exhausting prose), backend divergence = the crossover
// stop, the thin-plan/diff-review carve-out, a self-consistency read before every re-review, and the
// REQUIRED per-round structured emission {round N · finding-origin tally · per-backend verdict}. Only a
// review slot can resolve reviewed|council (execute floors at solo|delegated), so gate on the recipe.
const REVIEW_RECIPES = new Set(['reviewed', 'council']);
// activity-aware (AD-046): the triage classification vocabulary rides EVERY review-backed activity;
// the LEDGER pointer renders ONLY for plan-execution — the ledger is plan-execution-scoped (AD-045),
// and pointing plan-authoring at it would send rounds of the wrong activity into the code loop's gate.
const reviewLoopAdvice = (slots, activity) =>
  slots.some((s) => REVIEW_RECIPES.has(s.recipe))
    ? [
        'Review-loop economics (procedures.md Fold + loop · orchestration.md §4) — the review this recipe runs:',
        '  • Cap architecture plan-review at ≤2 rounds; the bar is met by RAISING a surviving major to an acceptance invariant (or handing it to Execute/diff-review), never by exhausting the strictest backend.',
        '  • Backend divergence (one backend grounded-ships while another keeps revising mechanics) IS the crossover stop.',
        '  • Route an all-mechanics/CI or prose-only artifact to a thin plan + diff-review; run a self-consistency read before every re-review.',
        '  • Each round MUST emit {round N · finding-origin tally (first-draft / fold-induced / mechanics) · per-backend verdict} so the crossover is a computed signal.',
        '  • At the cap, classify every surviving blocking finding: fixable-bug (fold ONCE as a red→green test, re-review) / inherent-layer-residual (document + raise to an acceptance criterion) / escalate (the maintainer decides); a minor never forces triage.',
        ...(activity === 'plan-execution'
          ? [
              '  • The computed instrument for THIS loop: declare each bugfix red BEFORE the fix (core-evidence red-proof — observed N/N red, custody-hashed); an unavailable backend gets an explicit core-evidence degrade record, never a silent skip; then stage everything, run the reviews on the STAGED tree, and mint the ONE receipt with run-gates --final (coverage + red-proof verification ride the final run); the commit is gated by commit-guard --check (the D13 ordering: any edit after the final run re-stales it); read the loop state statelessly with core-evidence summary.',
            ]
          : []),
      ]
    : [];

// The grounding pre-step (AD-038, extending the AD-033 verbatim-contract rendering): whenever the
// resolved dispatch includes agy-review, print the CONCRETE facts-assembly invocation + the
// --facts form as a copy-paste pre-step — population, not placeholders. Plan-path population rule
// (the review-state plan-in-flight detector): exactly ONE plan in flight → render it populated;
// zero or several → the explicit `--plan <path>` placeholder + a one-line discovery caveat. The
// suggested --out lives OUTSIDE the repo (/tmp) — grounding.mjs refuses a non-scratch destination.
// Exported for the bridge-tier byte-parity pin (AD-044 Plan 4): the velocity tier seeds the
// grounding rule in EXACTLY this rendered spelling — `node "${GROUNDING_TOOL}"` — so seeded and
// rendered forms can never drift apart.
export const GROUNDING_TOOL = join(dirname(fileURLToPath(import.meta.url)), 'grounding.mjs');
const GROUNDING_FACTS_OUT = '/tmp/review-facts.md';
const groundingPreStepAdvice = (activity, slots, plans) => {
  if (!slots.some((s) => (s.backends ?? []).includes('agy-review'))) return [];
  const planArg = plans.length === 1 ? `--plan "${PLANS_REL}/${plans[0]}"` : '--plan <path>';
  // plan-authoring reviews the plan FILE — when exactly one plan is in flight, the review command
  // is populated with the same discovered path (a known path never renders a placeholder).
  const reviewForm =
    activity === 'plan-authoring'
      ? plans.length === 1
        ? `agy-review plan "${PLANS_REL}/${plans[0]}"`
        : 'agy-review plan <plan-file>'
      : 'agy-review code';
  // `run:`/`then:` prefixes keep these POPULATED command lines machine-distinguishable from the
  // verbatim contract DESCRIPTORS above (the descriptor drift guard set-equals bare wrapper lines).
  // Path arguments are double-quoted — a skill dir or plan name with a space must stay copy-pasteable.
  const lines = [
    'Grounding pre-step (agy is dispatched — assemble the verified facts BEFORE the review; grounding.mjs slices verbatim, judgment additions stay yours):',
    `  run:  node "${GROUNDING_TOOL}" --constraints --autonomy ${planArg} --out ${GROUNDING_FACTS_OUT}`,
    `  then: ${reviewForm} --facts @${GROUNDING_FACTS_OUT}`,
  ];
  if (plans.length === 0) {
    lines.push(`  ↳ plan discovery: no plan in flight under ${PLANS_REL} — substitute the plan file you are reviewing against, or drop --plan for constraints+autonomy facts.`);
  } else if (plans.length > 1) {
    lines.push(`  ↳ plan discovery: ${plans.length} plans in flight under ${PLANS_REL} (${plans.join(', ')}) — populate --plan with the one under review.`);
  }
  return lines;
};

// The per-activity autonomy block (AD-044 Plan 4): the resolved level for THIS activity + what it
// implies, rendered from resolveAutonomy — never retyped constants. Read at session start beside
// the resolved recipes (the AGENTS.md autonomy pointer's read contract). A malformed policy
// surfaces LOUDLY here (the session-start read is exactly where "malformed → STOP, never guess"
// must be visible); an absent file states the computed-defaults origin honestly.
const autonomyAdvice = (activity, facts) => {
  if (facts == null) return [];
  if (facts.error) return [`Autonomy (${AUTONOMY_REL}): MALFORMED — ${facts.error} — STOP and fix the policy file, never guess around it.`];
  const level = facts.activities?.[activity]?.autonomy;
  if (!level) return [];
  const origin = facts.source === 'none'
    ? `computed defaults — no ${AUTONOMY_REL}`
    : facts.defaultsEquivalent
      ? `computed defaults — ${AUTONOMY_REL} is the sparse defaults-equivalent seed`
      : `from ${facts.source}`;
  const redlines = Object.entries(facts.redlines).map(([k, v]) => `${k}=${v}`).join(', ');
  const implies = level === 'sandbox'
    ? 'the OS sandbox confines and auto-allows confined commands — work runs to the next checkpoint without per-command prompts'
    : 'every non-allowlisted command prompts (the sandbox, where enabled, still confines)';
  return [
    `Autonomy for "${activity}" (${origin}): ${level} — ${implies}.`,
    `  red-lines (always): ${redlines} — commit/push/publish keep their maintainer asks regardless of level.`,
  ];
};

// The finding-scope block (procedures.md plan-execution step 5) — plan-execution ONLY and
// UNCONDITIONAL: the rule routes EVERY finding, review-backed or not, so gating it on REVIEW_RECIPES
// (which gates only the loop economics above) would hide it from every Solo project. The canon
// section is printed VERBATIM above, so this block never re-states the rule — it carries only what
// the canon cannot: the POPULATED checker command, and which of the two registers `--queue` names.
export const FOLD_SCOPE_TOOL = join(dirname(fileURLToPath(import.meta.url)), 'fold-scope-cli.mjs');
const foldScopeAdvice = (activity, config, plans) => {
  if (activity !== 'plan-execution') return [];
  const declared = config?.flow?.debtQueue ?? null;
  const queue = declared ?? `${PLANS_REL}/queue.md`;
  const plan = plans.length === 1 ? `${PLANS_REL}/${plans[0]}` : '<plan-file>';
  return [
    'Finding scope (procedures.md plan-execution step 5) — the rule is the section above; this is the checker it names:',
    `  • node ${shellQuoteArg(FOLD_SCOPE_TOOL)} --class '<in-scope|new-invariant|blocking>' --claim '<the invariant>' --plan ${shellQuoteArg(plan)} --queue ${shellQuoteArg(queue)}`,
    `  • --queue is ${declared ? `${declared}, the declared flow.debtQueue` : `${queue}, the planning lifecycle queue (no flow.debtQueue is declared)`}. Advisory: nothing records that it ran, so a skipped or late call is indistinguishable from a pre-edit declaration.`,
  ];
};

// The spec-store block (the feature-spec layer) — plan-execution ONLY and unconditional, like the
// finding-scope block above: a change to docs/ai/specs/ is judged whoever reviews it. It carries
// only what no canon can: the POPULATED checker commands, and the session register they read. The
// register is NEVER defaulted by the tool — naming it here is the whole point of the block.
export const SPEC_CHECK_TOOL = join(dirname(fileURLToPath(import.meta.url)), 'spec-check-cli.mjs');
const SPEC_OPS_REGISTER = `${PLANS_REL}/spec-ops.list`;
const specCheckAdvice = (activity) => {
  if (activity !== 'plan-execution') return [];
  return [
    'Spec store (the feature-spec layer) — state what this session changed, then let the checker judge the store against it:',
    `  • node ${shellQuoteArg(SPEC_CHECK_TOOL)} --ops-file ${shellQuoteArg(SPEC_OPS_REGISTER)}   (or --op '<add|modify|remove>=docs/ai/specs/<slug>.md', repeatable; rename=<old>:<new>)`,
    `  • node ${shellQuoteArg(SPEC_CHECK_TOOL)} --all — the whole store instead: unlisted child vs orphan, acyclicity, store-wide slug uniqueness, module overlap.`,
    `  • ${SPEC_OPS_REGISTER} is SESSION SCRATCH: this session writes it, the plan's Cleanup deletes it. It is never defaulted — an unnamed register would attest a post-state nobody declared. Advisory: nothing records that it ran.`,
  ];
};

// The cost-lane advisory block (cost-tiered execution — orchestration.md §5 canon, paraphrased
// at the point of use like reviewLoopAdvice paraphrases procedures.md Fold + loop / orchestration §4). Rendered UNCONDITIONALLY for
// every activity — the lanes route EVERY step, review-backed or not (unlike reviewLoopAdvice,
// which fires only when a review backend engages). It may name the kit's own GENERIC L0
// surfaces (the gate runner, the rotation checks, the cheap-agents vehicles) — point-of-use
// routing, still project-agnostic (never a project's publish mechanics). Its distinctive tokens
// are drift-guarded against the canon on both sides (procedures.test.mjs + the engine canon tests).
const costLanesAdvice = () => [
  'Cost lanes (orchestration.md §5) — route every step to the cheapest adequate executor:',
  '  • L0 deterministic script — run the gate matrix as ONE batch: /agent-workflow-kit gates (the project-declared docs/ai/gates.json); rotation headroom: archive-changelog / archive-issues / archive-decisions --check. An exit code beats a model re-read.',
  '  • L1 cheap subagent (small model, low effort, read-only tools — /agent-workflow-kit agents places the vehicles) — mechanical sweeps, changelog fact-skeletons, gate-failure triage. Extraction/drafting ONLY; the orchestrator verifies the output and owns every conclusion.',
  '  • L2 subscription bridge (codex / agy) — reviews per the resolved recipe above, on frontier bridge models (quality-first).',
  '  • L3 frontier — judgment: plan/fold/synthesis, ADR/handover/changelog-entry wording, persuasive copy, go/no-go, real code.',
  '  • A step with no named guardrail does not move down a lane; red lines never move down (council review models · real code · memory/copy wording · the maintainer approval asks).',
  '  • Sandbox lanes (under an OS sandbox): the L0 surfaces are sandbox-safe — gates/ledger/state/fold checks, git reads, plain no-network tests; the bridge wrappers are genuinely unsandboxed (network); npm-cache-touching commands are COMMAND-SHAPE dependent — first try the sandbox-safe shape (cache under $TMPDIR, offline/notifier off). Move ONLY the failing command out of the sandbox, never its class; BATCH consecutive unsandboxed calls. Pre-dispatch host-diff: before the FIRST dispatch of each bridge, diff its manifest networkHosts against the live sandbox allow-list — a missing host is surfaced to the maintainer BEFORE dispatching, never fired into a known prompt. Nested-sandbox honesty: a backend CLI shipping its OWN OS sandbox cannot run nested inside a harness sandbox — route it outside (excludedCommands / a per-run consented bypass) on the OBSERVED failure, never a preemptive blanket.',
  '  • Prompt economy (autonomy-preserving dispatch): read-only fan-out (research/sweeps/extraction) runs ONLY on restricted-tool vehicles — a full-tool subagent for read-only work is a forbidden lane downgrade (invisible prompt-flood + blast radius), and a subagent is never told to shell out for facts obtainable read-only; the orchestrator\'s own shell form is ONE plain pipeline per call (a ;/&& chain or env-prefixed invocation never matches a prefix allow rule); a fan-out LAUNCHER that gates per call yields to the agent-spawn lane. Capability-gated: on a host with restricted-tool subagent vehicles use them; without restricted-tool vehicles (a host offering only full-tool agents included), read-only research stays in the orchestrator\'s own context — never a vehicle mandate a host cannot satisfy.',
  '  • Writer economy (autonomy-preserving dispatch): a stage\'s repeated WRITER commands batch into ONE invocation — combine a stage\'s writers via one batched write or one launcher per stage; never one writer call at a time (each write is its own prompt).',
  '  • The prompt-economy clause narrows TOOLS for read-only work only — judgment, code, synthesis stay at the frontier lane; a task that genuinely needs to run or write keeps a full-tool subagent. Honest limit: no deterministic gate classifies a dispatch — enforcement is the canon at the point of use + the placed vehicles + the retro loop.',
];

// ── the flow armed-halves block (P8 — design §5 read side) ─────────────────────────
// Rendered ONLY when the config carries a `flow` block (an unarmed project sees byte-identical
// output and NO store probe). Three halves: config-armed (the block's own keys), chain-armed (the
// flow store's adoption state — a light read-only probe on the checker's FIXED path, env ignored),
// bookkeeping (per declared path: tracked-at-arming vs loudly declared-excluded).

export const FLOW_ARMED_HALVES_HEADER = 'Flow (schema 1) — armed halves (config · chain · bookkeeping):';

export const defaultFlowProbe = (cwd, lstat = lstatSync) => {
  const storePath = resolveFlowStorePath(cwd, {});
  if (storePath == null) return { present: false, armed: false, broken: null };
  try {
    lstat(storePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { present: false, armed: false, broken: null };
    return { present: true, armed: false, broken: 'the store leaf cannot be stat-ed (fail closed)' };
  }
  const read = readFlowStore(storePath);
  const broken = read.readError ?? (read.malformed > 0 ? `${read.malformed} malformed line(s) (${read.malformedReasons[0]})` : null);
  return {
    present: true,
    armed: broken == null && read.records.some((r) => r.kind === CHAIN_KIND && r.purpose === 'adoption'),
    broken,
  };
};

const flowHalvesAdvice = (flow, probe) => {
  if (flow == null) return [];
  const chainLine = probe.broken != null
    ? `  chain: store BROKEN — ${probe.broken}; every composed checker fails closed on it`
    : !probe.present
      ? '  chain: UNARMED — no flow store file yet (plan adoption arms it: flow-writer adoption <plan-file>)'
      : probe.armed
        ? '  chain: ARMED — the flow store carries an adoption record'
        : '  chain: UNARMED — a store file exists but no chain is adopted (semantic arms stay inert, #52)';
  const bookkeeping = [
    ['debtQueue', flow.debtQueue, flow.debtQueueExcluded],
    ['convergenceSummary', flow.convergenceSummary, flow.convergenceSummaryExcluded],
  ].map(([key, rel, excluded]) => `  bookkeeping.${key}: ${rel == null
    ? '(undeclared)'
    : `${rel} — ${excluded === true ? 'DECLARED-EXCLUDED (loud, #31)' : 'declared non-excluded (the tracked-file floor verifies on the set-flow arming path, #37)'}`}`);
  return [
    FLOW_ARMED_HALVES_HEADER,
    `  config: ARMED — preset ${flow.preset ?? '(unset)'} · councilRounds ${flow.councilRounds ?? '(unset)'} · kitMinVersion ${flow.kitMinVersion ?? '(none declared)'}`,
    chainLine,
    ...bookkeeping,
  ];
};

// ── the declared source-size practice (D-17 U1) ────────────────────────────────────
// A practice the agent meets only when a gate refuses is a practice learned too late: the caps and
// their reason ride EVERY named-activity render, so the plan's Module ledger is cut to them while the
// plan is being written. Composed from the project's live declaration, never from constants here.
// Each config state speaks as itself: ABSENT renders NOTHING (a project that declares no practice must
// not be handed invented limits); AUTHORED and INCOMPLETE render the declared caps plus the honest
// "nothing is recorded yet" line (treating INCOMPLETE as MINTED would report a half record as the
// whole tree's debt); MINTED renders the recorded counts too.
// A config that cannot be read renders ONE loud line carrying the reader's own message and the render
// still completes: the exit code for a broken source-size config belongs to the practice's own checker,
// while THIS tool's exit contract is about its own config and the engine.

export const DECLARED_PRACTICE_HEADER = `Declared source-size practice (${SOURCE_SIZE_CONFIG_REL}) — known BEFORE the code is written:`;

const declaredPracticeAdvice = (cwd, readFile, lstat) => {
  let declaration;
  try {
    declaration = loadSourceSizeConfig(cwd, { readFile, lstat });
  } catch (err) {
    return [`Declared source-size practice: UNREADABLE — ${(err && err.message) || err} — fix ${SOURCE_SIZE_CONFIG_REL} by hand; a declared practice is never guessed around.`];
  }
  if (declaration.state === 'absent') return [];
  const facts = practiceFacts(declaration.config);
  // The two pre-mint states share a LANE (the ratchet holds nothing, the mint step is next) but not a
  // FACT: an incomplete file carries half the machine record, so "no size is recorded" would be a
  // plain untruth about it — it names the missing half instead. Neither ever prints minted counts.
  // The mint step is named, not rendered: on a project path that does not survive double-quoting the
  // checker deliberately withholds a paste-ready command, and this advisor never re-decides that.
  const unmintedRecord = declaration.state === 'incomplete'
    ? `  recorded: PARTIAL — the machine record is half-written (missing ${declaration.missingMachineKeys.map((key) => `"${key}"`).join(', ')}), so the ratchet holds nothing yet; run \`source-size-check.mjs --check\` for the mint step.`
    : '  recorded: NOTHING YET — the caps are declared but no size is recorded, so the ratchet holds nothing; run `source-size-check.mjs --check` for the mint step.';
  return [
    DECLARED_PRACTICE_HEADER,
    `  caps: ${facts.maxLines} lines · ${facts.maxLineBytes} bytes per line, over ${facts.roots} declared root(s).`,
    declaration.state === 'minted'
      ? `  recorded: ${facts.recordedFiles} file(s) carry a recorded size (debt, not permission) · aggregate ${facts.aggregateLines} line(s), EXACT — growth takes a reasoned bump, never free headroom.`
      : unmintedRecord,
    `  why: ${SOURCE_SIZE_WHY}`,
  ];
};

// The verbatim per-backend DRIVING CONTRACT block (M-contract): the exact invocation descriptor(s),
// the closed flag set, the grounding note, the round-2/continue delta, and the guarded passthrough
// tiers — every descriptor printed VERBATIM from the registry mirror of the bridge manifest
// roles[role].contract (drift-guarded), never re-derived or re-worded here. Rendered for EVERY
// dispatched backend of EVERY slot (review AND execute=delegated); each wrapper's --help prints the
// same contract, so the agent never needs to open the wrapper source.
const contractLines = ({ cmd, contract, settings }) => {
  const lines = [`      ${cmd} — driving contract (as bundled with this kit; copy-paste — \`${cmd} --help\` prints the same):`];
  for (const inv of contract.invocations) lines.push(`        ${inv}`);
  for (const f of contract.flags ?? []) lines.push(`        ${f}`);
  if (contract.grounding) lines.push(`        grounding: ${contract.grounding}`);
  const cont = contract.continue ?? [];
  if (cont.length) {
    lines.push('        round-2 delta (resume — never re-send the reviewed artifact):');
    for (const c of cont) lines.push(`          ${c}`);
  }
  if (contract.passthrough) {
    lines.push(`        passthrough after '--' is ${contract.passthrough.policy}: blocked always: ${contract.passthrough.blocked.join(' ')}; relaxed only under CODEX_PROBE=1: ${contract.passthrough.probeRelaxed.join(' ')}`);
  }
  // Contract notes — a TYPED renderer (AD-054): a manifest note MUST render here, else adding a
  // notes[] key would silently disappear (the manifest validator tolerates unknown keys). Drift-
  // guarded both directions against the manifest AND each wrapper's --help.
  for (const note of contract.notes ?? []) lines.push(`        note: ${note}`);
  // Host-level settings knobs this wrapper honors (fact-only, from the bundled manifests; explicit
  // branch — contractLines drops any contract key it does not name, so this must be enumerated here).
  if ((settings ?? []).length) {
    lines.push('        host settings (survive kit upgrades — set via /agent-workflow-kit bridge-settings):');
    for (const s of settings) {
      lines.push(s.retired
        ? `          ${s.key} — RETIRED: recognized but arms nothing; the writer refuses --set, --unset clears an existing line`
        : `          ${s.key} — ${s.allowed}`);
    }
  }
  return lines;
};

const formatHuman = ({ activity, section, slots, warnings, plans, autonomy, flowHalves, declaredPractice, foldScope, specCheck }) => {
  const lines = [
    section,
    '',
    `resolved recipes for "${activity}" (read-only — the orchestrator runs the recipe via the bridge skills or the executor vehicle and owns any commit; every other carrier never commits):`,
  ];
  for (const s of slots) {
    const arrow = s.degradedFrom ? ` (requested ${s.degradedFrom} → degraded)` : '';
    lines.push(`  ${s.slot}: ${s.recipe} — ${SOURCE_LABEL[s.source]}${arrow}${backendSetLabel(s.backends)}`);
    if (s.reason) lines.push(`      ↳ ${s.reason}`);
    for (const v of s.vehicles ?? []) lines.push(`      ${v.backend} — the placed subagent vehicle (${v.state})`);
    for (const c of s.contracts ?? []) lines.push(...contractLines(c));
  }
  if ((flowHalves ?? []).length) lines.push('', ...flowHalves);
  const autonomyBlock = autonomyAdvice(activity, autonomy);
  if (autonomyBlock.length) lines.push('', ...autonomyBlock);
  const grounding = groundingPreStepAdvice(activity, slots, plans);
  if (grounding.length) lines.push('', ...grounding);
  const advice = reviewLoopAdvice(slots, activity);
  if (advice.length) lines.push('', ...advice);
  if (foldScope.length) lines.push('', ...foldScope);
  if (specCheck.length) lines.push('', ...specCheck);
  lines.push('', ...costLanesAdvice());
  if (declaredPractice.length) lines.push('', ...declaredPractice);
  if (warnings.length) {
    lines.push('', 'warnings:');
    for (const w of warnings) lines.push(`  ⚠ ${w}`);
  }
  return lines.join('\n');
};

const buildJson = ({ activity, section, slots, configSource, warnings, plans, autonomy, flowHalves, declaredPractice, foldScope, specCheck }) => ({
  activity,
  section,
  slots: Object.fromEntries(
    // `backends: string[]` is the STABLE pre-existing shape (wrapper names) — never repurposed.
    // `contracts` is the ADDITIVE per-dispatch driving-contract field (empty for solo).
    slots.map((s) => [s.slot, { recipe: s.recipe, source: s.source, degradedFrom: s.degradedFrom, reason: s.reason, backends: s.backends, contracts: s.contracts }]),
  ),
  reviewLoop: reviewLoopAdvice(slots, activity),
  // ADDITIVE (AD-038): the populated grounding pre-step, structured (empty when agy is not dispatched).
  groundingPreStep: groundingPreStepAdvice(activity, slots, plans),
  // ADDITIVE (cost-tiered execution): the unconditional cost-lane advisory, structured.
  costLanes: costLanesAdvice(),
  // ADDITIVE (the fold channel): the finding-scope block, structured (empty outside plan-execution).
  foldScope,
  // ADDITIVE (spec layer 2b): the spec-store block, structured (empty outside plan-execution).
  specCheck,
  // ADDITIVE (AD-044 Plan 4): the per-activity autonomy block, structured (empty when unresolvable).
  autonomy: autonomyAdvice(activity, autonomy),
  // ADDITIVE (D-17 U1): the SAME composed lines the human render prints — one array, two renders, so
  // a scripted reader and a human can never be told different things about the declared practice.
  declaredPractice,
  // CONDITIONAL (flow P8): the armed-halves block rides ONLY a flow-carrying config — the unarmed
  // JSON key set stays byte-exact (unarmed neutrality outranks the additive-key precedent).
  ...(flowHalves == null ? {} : { flowHalves }),
  configSource,
  warnings,
});

const HELP = `procedures — read-only activity-procedures advisor for the agent-workflow family.

Usage:
  node procedures.mjs <activity> [--override <slot>=<value>]... [--json]

Activities: ${Object.keys(ACTIVITIES).join(', ')}
Slots:      ${Object.entries(ACTIVITIES).map(([a, d]) => `${a} → ${Object.keys(d.slots).join(', ')}`).join(';  ')}
Accepted values: ${Object.entries(SLOT_RECIPES).map(([type, values]) => `${type} accepts ${values.join('|')}`).join(';  ')}

Reads the activity's procedure steps LIVE from the installed agent-workflow-engine
(references/procedures.md), resolves the effective recipe per slot from
${CONFIG_REL} + the read-only backend detector, and prints both. A per-run
--override <slot>=<value> (repeatable) overrides the configured/default recipe for that slot.
Read-only: never writes, never commits, never runs a subscription CLI.

Also prints the project's DECLARED source-size practice (${SOURCE_SIZE_CONFIG_REL}) when it declares
one — the caps, what is recorded, why the practice exists, and the plan-time rung — as the
declaredPractice block (--json: the same lines under "declaredPractice"). A project with no such
file renders nothing; a file that cannot be read renders ONE loud UNREADABLE line and still exits 0
(the practice's own checker owns the exit code for its config).

Exit codes: 0 success (an unsatisfiable override degrades loudly, still 0);
            2 usage (unknown activity / bad --override); 1 config or engine error
            (incl. a malformed ${AUTONOMY_REL} — the advisory still renders, the exit flips).`;

// ── main ───────────────────────────────────────────────────────────────────────────

// main(argv, ctx) → { code, stdout, stderr }. Pure I/O at the edges (cwd / env / home / detect are
// injectable for host-independent tests); never calls process.exit itself — the direct-run guard does.
export const main = (argv, ctx = {}) => {
  const cwd = ctx.cwd ?? process.cwd();
  const env = ctx.env ?? process.env;
  const home = ctx.home ?? homedir();
  const detect = ctx.detect ?? detectBackends;
  const readFile = ctx.readFileSync ?? readFileSync;
  const lstat = ctx.lstatSync ?? lstatSync;
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    const { activity, overrides, json } = parseArgs(argv);
    const { config, source: configSource } = loadConfig(cwd, readFile, lstat);
    const section = extractSection(readProceduresCanon(env, home), activity);
    // Readiness is a SECONDARY input — it only refines the recipe. A corrupt bridge must NOT fail
    // activity resolution as a config/engine error: the detector-failure hook floors the bridge half
    // at not-ready and warns (exit 0), while the surveyed executor vehicle survives untouched.
    const detectWarnings = [];
    const detection = composeReadiness(cwd, {
      detect,
      surveyVehicle: ctx.surveyVehicle,
      onDetectError: (err) => detectWarnings.push(
        `backend detection failed (${(err && err.message) || err}) — treating every bridge as not ready; recipes needing a bridge degrade to solo (the executor vehicle is unaffected).`,
      ),
    });
    const slots = resolveAllSlots({ activity, config, detection, overrides });
    const warnings = [...detectWarnings, ...collectWarnings(slots)];
    const plans = plansInFlight(cwd);
    // The autonomy facts (AD-044 Plan 4): resolved levels + red-lines from the policy file. A
    // malformed policy renders LOUDLY in the block AND flips the exit to 1 (config error) — the
    // recipes and contracts still print, only the code changes.
    const autonomy = (() => {
      try {
        const { config: autonomyConfig, source } = loadAutonomy(cwd, readFile, lstat);
        const resolved = resolveAutonomy(autonomyConfig);
        // Structural seed detection (shared predicate) — a declared-defaults policy reads as
        // "from docs/ai/autonomy.json", never as the seed (codex, Segment B closing).
        const defaultsEquivalent = source !== 'none' && isSparseSeedConfig(autonomyConfig);
        return { source, defaultsEquivalent, ...resolved };
      } catch (err) {
        return { error: (err && err.message) || String(err) };
      }
    })();
    // The flow armed-halves block (P8): probed ONLY when the config carries a flow block — an
    // unarmed project keeps byte-identical output (human AND JSON) and never pays the store probe.
    const flowProbe = ctx.flowProbe ?? defaultFlowProbe;
    const flowHalves = config?.flow == null ? null : flowHalvesAdvice(config.flow, flowProbe(cwd));
    const declaredPractice = declaredPracticeAdvice(cwd, readFile, lstat);
    const foldScope = foldScopeAdvice(activity, config, plans);
    const specCheck = specCheckAdvice(activity);
    const stdout = json
      ? JSON.stringify(buildJson({ activity, section, slots, configSource, warnings, plans, autonomy, flowHalves, declaredPractice, foldScope, specCheck }), null, 2)
      : formatHuman({ activity, section, slots, warnings, plans, autonomy, flowHalves, declaredPractice, foldScope, specCheck });
    if (autonomy?.error) {
      return { code: 1, stdout, stderr: `procedures: malformed ${AUTONOMY_REL} — ${autonomy.error}` };
    }
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `procedures: ${err.message}` };
  }
};

if (isDirectRun(import.meta.url)) {
  const r = main(process.argv.slice(2));
  if (r.stdout) console.log(r.stdout);
  if (r.stderr) console.error(r.stderr);
  process.exit(r.code);
}
