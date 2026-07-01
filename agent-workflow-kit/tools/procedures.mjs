#!/usr/bin/env node
// Activity-procedures advisor — the read-only `/agent-workflow-kit procedures <activity>` surface.
//
// It composes the AD-018 orchestration recipes into NAMED activities: it reads the canonical procedure
// steps LIVE from the installed agent-workflow-engine (references/procedures.md — AD-016 live read, no
// bundled mirror), reads the per-project, hand-edited config (docs/ai/orchestration.json), runs the
// read-only backend detector, and prints the activity's steps VERBATIM + the resolved effective recipe
// per slot (default = Reviewed-when-a-backend-is-ready, Council on request, slot-aware incl. Delegated).
//
// Invariants (mirror recipes.mjs): pure-where-possible, READ-ONLY (never writes, never commits, never
// runs a subscription CLI). The deterministic resolution lives in the kit (resolveActivityRecipe), not
// in the agent. Dependency-free, Node >= 18.
//
// Exit codes: 0 success (an unsatisfiable explicit override degrades LOUDLY but still exits 0 — it is a
// valid request that gracefully degraded); 2 usage (unknown <activity> / bad --override syntax);
// 1 config error (malformed / schema-invalid / unreadable orchestration.json) or engine error (the
// installed engine is absent / invalid / too old to ship references/procedures.md).

import { readFileSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { detectBackends, wrapperCmdFor } from './detect-backends.mjs';
import { ACTIVITIES, resolveActivityRecipe, planRecipe } from './recipes.mjs';
import { resolveEngineDir, readEngineFragment, PROCEDURES_FRAGMENT_REL } from './engine-source.mjs';
// The config schema/read core lives in orchestration-config.mjs (the single config contract). procedures
// is READ-ONLY: it imports the reader + the SHARED slot/recipe validity, never the fs-writer
// (orchestration-write.mjs) — so "the read-only advisor can never reach a writer" is STRUCTURALLY true
// (an import-split test pins it). CONFIG_REL is RE-EXPORTED so existing importers (procedures.test.mjs,
// historically) keep their import site working.
import { CONFIG_REL, fail, loadConfig, assertSlotRecipe } from './orchestration-config.mjs';
export { CONFIG_REL };

// ── argument + override parsing (usage errors → exit 2) ─────────────────────────────

// Parse the activity's --override <slot>=<recipe> tokens into a { slot: recipe } map, validating each
// against the SHARED slot/recipe validity table (assertSlotRecipe — the SAME accept/reject the set-recipe
// op parser uses, drift-guarded). Every malformed token is a USAGE error (exit 2): a bare `<recipe>` (no
// slot), an unknown slot for the activity, an invalid recipe-for-slot, or a duplicate slot. (An override
// naming a recipe whose backend merely is not `ready` is NOT a usage error — it degrades loudly at
// resolution time, exit 0.) The `--override` grammar stays activity-SCOPED (the activity comes from the
// CLI arg), unlike the fully-qualified `--set <activity>.<slot>=<recipe>` the writer takes.
const parseOverrides = (tokens, activity) => {
  const overrides = {};
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq <= 0) throw fail(2, `--override must be <slot>=<recipe> (got "${tok}")`);
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
      if (tok === undefined || tok.startsWith('--')) throw fail(2, '--override requires <slot>=<recipe>');
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

const resolveAllSlots = ({ activity, config, detection, overrides }) =>
  Object.keys(ACTIVITIES[activity].slots).map((slot) => {
    const resolved = resolveActivityRecipe({ config: config ?? {}, readiness: detection, activity, slot, override: overrides[slot] });
    // The concrete wrapper set this slot's EFFECTIVE recipe dispatches (empty for solo). Reuse
    // planRecipe's drift-guarded dispatch for WHICH backends, then resolve each (backend, role) to its
    // manifest wrapper cmd via the bridge registry — no wrapper name is hand-composed here.
    const backends = planRecipe(resolved.recipe, detection).dispatch
      .map((d) => wrapperCmdFor(d.backend, d.role))
      .filter(Boolean);
    return { slot, ...resolved, backends };
  });

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
// backend (a slot resolving reviewed | council) and OMITTED for solo. It paraphrases the §9 +
// orchestration §4 canon (no rival rule): the ≤2-round architecture cap, the bar met by RAISING a
// surviving major to an acceptance invariant (not exhausting prose), backend divergence = the crossover
// stop, the thin-plan/diff-review carve-out, a self-consistency read before every re-review, and the
// REQUIRED per-round structured emission {round N · finding-origin tally · per-backend verdict}. Only a
// review slot can resolve reviewed|council (execute floors at solo|delegated), so gate on the recipe.
const REVIEW_RECIPES = new Set(['reviewed', 'council']);
const reviewLoopAdvice = (slots) =>
  slots.some((s) => REVIEW_RECIPES.has(s.recipe))
    ? [
        'Review-loop economics (planning.md §9 · orchestration.md §4) — the review this recipe runs:',
        '  • Cap architecture plan-review at ≤2 rounds; the bar is met by RAISING a surviving major to an acceptance invariant (or handing it to Execute/diff-review), never by exhausting the strictest backend.',
        '  • Backend divergence (one backend grounded-ships while another keeps revising mechanics) IS the crossover stop.',
        '  • Route an all-mechanics/CI or prose-only artifact to a thin plan + diff-review; run a self-consistency read before every re-review.',
        '  • Each round MUST emit {round N · finding-origin tally (first-draft / fold-induced / mechanics) · per-backend verdict} so the crossover is a computed signal.',
      ]
    : [];

const formatHuman = ({ activity, section, slots, warnings }) => {
  const lines = [
    section,
    '',
    `resolved recipes for "${activity}" (read-only — the orchestrator runs the recipe via the bridge skills and owns any commit; a backend never commits):`,
  ];
  for (const s of slots) {
    const arrow = s.degradedFrom ? ` (requested ${s.degradedFrom} → degraded)` : '';
    lines.push(`  ${s.slot}: ${s.recipe} — ${SOURCE_LABEL[s.source]}${arrow}${backendSetLabel(s.backends)}`);
    if (s.reason) lines.push(`      ↳ ${s.reason}`);
  }
  const advice = reviewLoopAdvice(slots);
  if (advice.length) lines.push('', ...advice);
  if (warnings.length) {
    lines.push('', 'warnings:');
    for (const w of warnings) lines.push(`  ⚠ ${w}`);
  }
  return lines.join('\n');
};

const buildJson = ({ activity, section, slots, configSource, warnings }) => ({
  activity,
  section,
  slots: Object.fromEntries(
    slots.map((s) => [s.slot, { recipe: s.recipe, source: s.source, degradedFrom: s.degradedFrom, reason: s.reason, backends: s.backends }]),
  ),
  reviewLoop: reviewLoopAdvice(slots),
  configSource,
  warnings,
});

const HELP = `procedures — read-only activity-procedures advisor for the agent-workflow family.

Usage:
  node procedures.mjs <activity> [--override <slot>=<recipe>]... [--json]

Activities: ${Object.keys(ACTIVITIES).join(', ')}
Slots:      plan-authoring → review;  plan-execution → execute, review
Recipes:    review accepts solo|reviewed|council;  execute accepts solo|delegated

Reads the activity's procedure steps LIVE from the installed agent-workflow-engine
(references/procedures.md), resolves the effective recipe per slot from
${CONFIG_REL} + the read-only backend detector, and prints both. A per-run
--override <slot>=<recipe> (repeatable) overrides the configured/default recipe for that slot.
Read-only: never writes, never commits, never runs a subscription CLI.

Exit codes: 0 success (an unsatisfiable override degrades loudly, still 0);
            2 usage (unknown activity / bad --override); 1 config or engine error.`;

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
    // Backend detection is a SECONDARY input — it only refines the recipe. A corrupt / unreadable backend
    // must NOT fail activity resolution as a config/engine error (exit 1, outside the contract): treat all
    // backends as not-ready (resolution floors at Solo) and surface the failure as a loud warning, exit 0.
    const detectWarnings = [];
    let detection = [];
    try {
      detection = detect();
    } catch (err) {
      detectWarnings.push(
        `backend detection failed (${(err && err.message) || err}) — treating all backends as not ready; recipes needing a backend degrade to solo.`,
      );
    }
    const slots = resolveAllSlots({ activity, config, detection, overrides });
    const warnings = [...detectWarnings, ...collectWarnings(slots)];
    const stdout = json
      ? JSON.stringify(buildJson({ activity, section, slots, configSource, warnings }), null, 2)
      : formatHuman({ activity, section, slots, warnings });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `procedures: ${err.message}` };
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const r = main(process.argv.slice(2));
  if (r.stdout) console.log(r.stdout);
  if (r.stderr) console.error(r.stderr);
  process.exit(r.code);
}
