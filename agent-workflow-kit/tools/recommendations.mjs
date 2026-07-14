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
// registry/sandbox-masks); the sandbox-masks and settings probes may run read-only git queries.
// Dependency-free, Node >= 18. No side effects on import (the isDirectRun idiom).

import { readFileSync, readdirSync, lstatSync } from 'node:fs';
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
import { surveyFamily, surveyGateHook } from './family-registry.mjs';
import { probeSandboxMasks, needsMasksApply } from './sandbox-masks.mjs';
import { shellQuoteArg } from './review-state.mjs';
import { loadConfig } from './orchestration-config.mjs';
import { DEFAULT_BUNDLE_ROOT, SETTINGS_FILENAME, settingsPath, parseSettings, duplicateKeys } from './bridge-settings-read.mjs';
import { assertContainedRealPath } from './fs-safe.mjs';

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
  'gate-hook': SEVERITY_OPTIONAL,
  'family-freshness': SEVERITY_ATTENTION,
  'sandbox-masks': SEVERITY_OPTIONAL,
  'agy-adddir': SEVERITY_OPTIONAL,
  'agy-adddir.invalid-env': SEVERITY_ATTENTION,
  'sandbox-lane': SEVERITY_OPTIONAL,
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
  'gate-hook': '{n} declared gate(s) prompt per run — the gate-approval hook is not wired',
  'family-freshness': '{parts}',
  'sandbox-masks': '{n} sandbox device mask(s) clutter git status — the managed exclude block is absent or stale',
  'sandbox-masks.stale-real': '{n} sandbox device mask(s) clutter git status — the exclude block is stale; {m} fenced entr(ies) are REAL paths (a fresh apply drops them)',
  'agy-adddir': 'agy-review is placed but AGY_REVIEW_ALLOW_ADDDIR is not set ({file}) — an oversized code review refuses instead of offloading',
  'agy-adddir.invalid-env': 'AGY_REVIEW_ALLOW_ADDDIR is set to an INVALID value ({value}) — refuse-mode applies and the settings file is shadowed while it is set',
  'sandbox-lane': 'the wired review wrappers declare a session-sandbox recipe (egress hosts + writable state dirs) not yet acknowledged for this project',
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
  'review-recipe': 'review coverage — the review recipe you configured actually runs instead of silently degrading',
  'gates-declaration': 'velocity — your project’s gates run as ONE declared batch with a PASS/FAIL table',
  'gate-hook': 'velocity — your own declared gate commands auto-approve byte-exactly (opt-in PreToolUse hook)',
  'family-freshness': 'currency — placed family members carry the latest shipped fixes and features',
  'sandbox-masks': 'zero clutter — git status shows only your changes (the review domain already ignores the masks by construction)',
  'agy-adddir': 'large reviews — an oversized agy code review offloads to a staging dir instead of refusing',
  'sandbox-lane': 'discoverability — the manifest-declared observed sandbox recipe for bridge runs surfaces itself instead of waiting to be asked',
});

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
    // pins the target project via a cd prefix (codex R2, Segment B).
    add('sandbox-provision', fillTemplate(WHATS[variant], { reason, tuple: plan.tuple }), `cd ${q(root)} && node ${q(toolPath('autonomy-doctor.mjs'))}`);
  } catch (err) {
    skip('sandbox-provision', err);
  }
};

const probeReviewRecipe = ({ root, deps, add, skip }) => {
  try {
    // The VALIDATED reader (codex R2, Segment B): a schema-invalid config (unknown activity/slot,
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

const probeGates = ({ root, deps, add, skip }) => {
  try {
    const sg = surveyGateHook(root, deps);
    if (sg.error) throw new Error(sg.error);
    if (sg.declarationPresent && sg.declaredGates === null) throw new Error(sg.declarationError ?? 'gates.json present but unreadable');
    // An ABSENT file and the seeded-EMPTY list are equally undeclared (codex R2, Segment B); the
    // apply is the consent-gated seeder PREVIEW (it proposes entries from the project's own
    // scripts and writes only on an explicit yes) — never the runner.
    if (!sg.declarationPresent || sg.declaredGates === 0) {
      // The seeder writes ONLY with --apply and consent is per-entry (--only) — the apply field
      // stays a PURE executable command (run-exactly-as-rendered feeds it to the shell); the
      // two-step preview semantics live in WHAT, never as prose appended to the command.
      add('gates-declaration', fillTemplate(WHATS['gates-declaration'], {}), `node ${q(toolPath('seed-gates.mjs'))} --cwd ${q(root)}`);
      return;
    }
    if (sg.declaredGates > 0 && !sg.wired) {
      add('gate-hook', fillTemplate(WHATS['gate-hook'], { n: sg.declaredGates }), `node ${q(toolPath('gate-hook.mjs'))} --apply --cwd ${q(root)}`);
    }
  } catch (err) {
    skip('gate-hook', err);
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
    // REFUSE — the exact one-liner must carry --clear there (codex R1, Segment B).
    const apply = p.masks.length === 0 && p.staleReal.length > 0 ? `${p.applyCmd} --clear` : p.applyCmd;
    add('sandbox-masks', fillTemplate(WHATS[variant], { n: p.masks.length, m: p.staleReal.length }), apply);
  } catch (err) {
    skip('sandbox-masks', err);
  }
};

const probeAgyAdddir = ({ deps, add, skip }) => {
  try {
    const probePlaced = deps.findWrapper ?? ((cmd) => findOnPath(cmd, deps).state === 'present');
    if (!probePlaced('agy-review')) return;
    // Configured means a VALID boolean value (the wrapper validates and falls back to the default
    // on garbage — presence alone proves nothing; codex R3). An explicit valid 0 is a user CHOICE
    // (refuse mode) — respected, never nagged. env > file, the wrappers' own precedence.
    const isValidBool = (v) => v === '0' || v === '1';
    const env = deps.getenv ?? process.env;
    if (env.AGY_REVIEW_ALLOW_ADDDIR != null) {
      if (isValidBool(env.AGY_REVIEW_ALLOW_ADDDIR)) return; // an explicit valid env choice — respected
      // A SET-BUT-EMPTY env var is the wrapper's opt-out shape (${!key+x}: it shadows the file
      // and falls back to the built-in refuse default) — a user CHOICE, never nagged (codex).
      if (env.AGY_REVIEW_ALLOW_ADDDIR === '') return;
      // env > file: while ANY env value is set the wrapper ignores the settings file, so the file
      // writer cannot fix an invalid env — the honest apply is to fix/unset the env var (codex).
      const value = truncatedTo(oneLineOf(JSON.stringify(env.AGY_REVIEW_ALLOW_ADDDIR)), templateBudget(WHATS['agy-adddir.invalid-env']));
      add('agy-adddir', fillTemplate(WHATS['agy-adddir.invalid-env'], { value }), 'HAND-APPLY: unset AGY_REVIEW_ALLOW_ADDDIR in the environment (or export it as 1), THEN configure it durably via the bridge-settings writer', 'agy-adddir.invalid-env');
      return;
    }
    const confPath = settingsPath({ getenv: env, home: deps.home });
    const readFile = deps.readFile ?? readFileSync;
    const text = (() => {
      try {
        return readFile(confPath, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') return '';
        throw err;
      }
    })();
    const parsed = parseSettings(text);
    const fileEntries = parsed.byKey.get('AGY_REVIEW_ALLOW_ADDDIR');
    const fileValue = fileEntries?.length ? fileEntries[fileEntries.length - 1].value : null;
    if (fileValue != null && isValidBool(fileValue)) return; // env is absent here — a valid file value governs
    // The settings writer REFUSES a duplicate-carrying file — rendering its command would hand
    // the user a guaranteed failure; the honest apply is fix-duplicates-first (codex terminal).
    const dups = duplicateKeys(parsed);
    const what = fillTemplate(WHATS['agy-adddir'], { file: SETTINGS_FILENAME });
    if (dups.length > 0) {
      add('agy-adddir', what, `HAND-APPLY: ${SETTINGS_FILENAME} carries duplicate key(s) (${dups.join(', ')}) and the settings writer refuses to edit it — remove the duplicate lines by hand, THEN run: node ${q(toolPath('bridge-settings.mjs'))} --set AGY_REVIEW_ALLOW_ADDDIR=1 --apply`);
      return;
    }
    add('agy-adddir', what, `node ${q(toolPath('bridge-settings.mjs'))} --set AGY_REVIEW_ALLOW_ADDDIR=1 --apply`);
  } catch (err) {
    skip('agy-adddir', err);
  }
};

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

// The kit-owned neutral ack store (D4; AD-055 Part I): a FAMILY-OWNED strict-JSON file no host
// validator guards — top-level key `sandboxLaneAck` (+ optional `_README`), unknown keys tolerated
// on read (future acks are siblings). This is the PRIMARY ack channel; the legacy settings-scope
// keys below are read for one deprecation window. The sandbox/permissions security keys are NEVER
// consulted as an ack.
export const ACKS_FILE = 'docs/ai/acks.json';
export const ACKS_LANE_KEY = 'sandboxLaneAck';

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
const readAcksLane = (root, deps) => {
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
  const value = parsed[ACKS_LANE_KEY];
  return typeof value === 'string' ? value : null;
};

// D3: the risk-marked keys — every key here has a per-item posture note in the mode doc, surfaced
// at the consent moment; the static contract test asserts EXACT bidirectional coverage
// (risk-marked keys == mode-doc note keys — a dropped note goes red, not silent).
export const RISK_NOTED_KEYS = Object.freeze(['agy-adddir', 'sandbox-lane']);

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
      readAcksLane(root, deps),
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

// ── assembly (frozen presentation order) ─────────────────────────────────────────────────────────
const PROBES = Object.freeze([
  probeVelocityItems,
  probeAutonomyItems,
  probeSandboxProvision,
  probeReviewRecipe,
  probeGates,
  probeFamilyFreshness,
  probeMasksItem,
  probeAgyAdddir,
  probeSandboxLane,
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
  // severityKey defaults to the item key; a per-site arm passes its `<key>.<variant>` entry when
  // its class differs from the base (the invalid-env attention arm).
  // `detail` (optional) is an extra rendered `recipe:` line — factual context that is TOO LONG for
  // the capped WHAT and does NOT belong in the pure-command apply (the sandbox-lane live recipe:
  // egress hosts + resolved writable dirs). Single-line like apply; absent for every other item.
  const add = (key, what, apply, severityKey = key, detail = null) => {
    const problems = [];
    if (!(key in BENEFITS)) problems.push(`unregistered item key ${JSON.stringify(key)}`);
    if (!(severityKey in SEVERITIES)) problems.push(`unregistered severity key ${JSON.stringify(severityKey)}`);
    if (/[\r\n]/.test(what)) problems.push('WHAT is not a single line');
    else if (what.length > ITEM_LINE_CAP) problems.push(`WHAT exceeds the ${ITEM_LINE_CAP}-char cap (${what.length})`);
    if (/[\r\n]/.test(apply)) problems.push('apply is not a single line');
    if (detail != null && /[\r\n]/.test(detail)) problems.push('recipe detail is not a single line');
    if (problems.length > 0) {
      skip(key, new Error(`item shape violation — ${problems.join('; ')}`));
      return;
    }
    items.push({ key, severity: SEVERITIES[severityKey], what, benefit: BENEFITS[key], apply, detail });
  };
  for (const probe of deps.probes ?? PROBES) probe({ root, deps, add, skip });
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
    // list beside skipped checks would falsely attest optimality (codex R1, Segment B).
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
recipe only) · the exact consent-gated apply one-liner}. --cwd is
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
