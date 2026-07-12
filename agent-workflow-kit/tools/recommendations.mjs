#!/usr/bin/env node
// recommendations.mjs — the read-only upgrade Recommendations advisor behind
// `/agent-workflow-kit recommendations` (AD-044 Plan 4, Phase 3).
//
// A consumer who upgrades the kit never learns their deployment is configured sub-optimally (no
// bridge allowlist, autonomy render drifted, sandbox not provisioned, gates undeclared) — every
// `upgrade` run therefore ends with a mandatory, deterministic Recommendations section: what is
// sub-optimal · the benefit in ONE plain line · the exact consent-gated apply one-liner. The agent
// pastes the section VERBATIM (the composeStatusLine precedent) and then OFFERS to apply; the user
// picks items in plain language; the agent runs EXACTLY the rendered one-liners — no improvisation,
// each writer's own consent semantics intact.
//
// Contract:
//   node recommendations.mjs --cwd <project-root> [--json]
// --cwd is REQUIRED (subdir-proof: the target project is explicit, never inferred from the shell's
// current directory). The section renders PRESENT-EVEN-WHEN-EMPTY (the exact empty-state line
// below). Benefit lines are frozen tool DATA, fact-true: the dual velocity+security wording rides
// ONLY items with a real security delta (sandbox/autonomy render); the bridge-wrappers item claims
// velocity only. A probe failure is a stated skipped-item line — never a crash, never a fabricated
// item. The network-allowlist item is HAND-APPLY by design (bridge council 2026-07-11, both
// backends concur): the kit never seeds sandbox.network.allowedDomains / filesystem.allowWrite.
//
// Read-only: never writes, never commits, never runs a subscription CLI. The reused probes are all
// exported read-only surfaces of their owning tools (velocity/autonomy/doctor/backends/recipes/
// registry/sandbox-masks); the sandbox-masks and settings probes may run read-only git queries.
// Dependency-free, Node >= 18. No side effects on import (the isDirectRun idiom).

import { readFileSync, readdirSync, lstatSync } from 'node:fs';
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

const HERE = dirname(fileURLToPath(import.meta.url));
const toolPath = (rel) => join(HERE, rel);
const q = shellQuoteArg;

// ── the section contract tokens (doc-parity-bound in upgrade.md + the mode doc) ────────────────
export const RECOMMENDATIONS_SECTION_HEADER = '## Recommendations (agent-workflow)';
export const RECOMMENDATIONS_EMPTY_LINE = 'no recommendations — flow optimal.';
// The one dual-wording security clause — rides ONLY the items with a real security delta.
export const DUAL_SECURITY_BENEFIT = 'safer — blast radius bounded by the OS sandbox, not human attention';

// ── the frozen benefit registry (fact-true; pinned by tests) ────────────────────────────────────
export const BENEFITS = Object.freeze({
  'velocity-core': 'velocity — routine read-only commands stop prompting while the maintainer is away',
  'kit-tools-tier': "velocity — the kit's own read-only tools run promptless (audited, resolved-absolute tier)",
  'bridge-tier':
    'velocity — unattended council review runs: the placed review wrappers’ code mode stops prompting (delegated execution and the plan/diff modes keep their prompt)',
  'autonomy-policy': 'clarity — the per-activity autonomy policy becomes an explicit, versioned declaration instead of implicit computed defaults',
  'autonomy-render': `velocity — the sandbox auto-allows confined commands per your declared policy; ${DUAL_SECURITY_BENEFIT}`,
  'sandbox-provision': `velocity — confined ad-hoc commands stop prompting once the OS sandbox is available; ${DUAL_SECURITY_BENEFIT}`,
  'review-recipe': 'review coverage — the review recipe you configured actually runs instead of silently degrading',
  'gates-declaration': 'velocity — your project’s gates run as ONE declared batch with a PASS/FAIL table',
  'gate-hook': 'velocity — your own declared gate commands auto-approve byte-exactly (opt-in PreToolUse hook)',
  'family-freshness': 'currency — placed family members carry the latest shipped fixes and features',
  'sandbox-masks': 'zero clutter — git status shows only your changes (the review domain already ignores the masks by construction)',
  'agy-adddir':
    'large reviews — an oversized agy code review offloads to a staging dir instead of refusing; CAVEAT: re-enables the Issue-001 stall risk (the hard timeout bounds it)',
  'network-allowlist':
    'unblocks the NETWORK half of in-sandbox bridge runs where the sandbox honors settings keys (settings-native harnesses; the network gate ONLY — no filesystem allowance is recommended); RISK stated plainly: pre-allows egress to these hosts for EVERY sandboxed command (informed hand-consent only). Live-observed 2026-07-12: an IDE-managed session sandbox ignores these settings keys too — there the durable lanes are the harness’s own per-host network consents / session sandbox config, or the per-run consented bypass; codex additionally needs a writable HOME (EROFS ~/.codex)',
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
    add('velocity-core', `routine read-only commands still prompt — ${core.toAdd.length} audited read-only allowlist entr(ies) not seeded`, applyLine(''));
  }
  try {
    const kt = planVelocityProfile(preflight, { kitTools: true });
    if (kt.tierToAdd.length > 0) {
      add('kit-tools-tier', `the kit's own read-only tools still prompt — ${kt.tierToAdd.length} kit-tools tier entr(ies) not seeded`, applyLine(' --kit-tools'));
    }
  } catch (err) {
    skip('kit-tools-tier', err);
  }
  try {
    const bt = planVelocityProfile(preflight, { bridgeTier: true, findWrapper: deps.findWrapper });
    const delta = bt.bridgeToAdd.length + bt.excludedToAdd.length;
    if (delta > 0) {
      add('bridge-tier', `council review runs prompt per bridge invocation — ${delta} bridge-wrappers tier entr(ies) not seeded (placed bridges only, code mode only)`, applyLine(' --bridge-tier'));
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
      add('autonomy-policy', `no ${AUTONOMY_REL} — the computed defaults apply implicitly (red-lines ask/deny; every activity floors at prompt)`, '/agent-workflow-kit set-autonomy (run IN the target project — the conversational writer previews, then writes its docs/ai/autonomy.json)');
    }
  } catch (err) {
    skip('autonomy-policy', err);
    return; // a malformed policy also blocks the render check below — one stated reason is enough
  }
  if (source === 'none') return; // nothing to render-check without a declared policy (not a skip)
  try {
    const check = checkAutonomyProfile({ cwd: root }, deps);
    if (!check.inSync) {
      add('autonomy-render', `the declared autonomy policy is not rendered into .claude/settings.json — drift: ${check.drift[0]}${check.drift.length > 1 ? ` (+${check.drift.length - 1} more)` : ''}`, `node ${q(toolPath('velocity-profile.mjs'))} --autonomy --apply --cwd ${q(root)}`);
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
    const installNote = plan.tuple ? ` — installable via the doctor (consent tuple ${plan.tuple})` : '';
    // The doctor reads process.cwd() (deployment-gated) and takes no --cwd flag — the one-liner
    // pins the target project via a cd prefix (codex R2, Segment B).
    add('sandbox-provision', `the OS sandbox is unavailable: ${p.reason}${installNote}`, `cd ${q(root)} && node ${q(toolPath('autonomy-doctor.mjs'))}`);
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
      add('review-recipe', degraded.join('; '), '/agent-workflow-kit backends');
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
      // stays a PURE executable command (run-exactly-verbatim feeds it to the shell); the
      // two-step preview semantics live in WHAT, never as prose appended to the command.
      add('gates-declaration', 'no declared gate matrix (docs/ai/gates.json absent or empty) — gate commands run ad hoc and prompt one by one; the apply line is the PREVIEW (writes nothing) — it prints the exact consent-gated --apply [--only <id>] line to run next', `node ${q(toolPath('seed-gates.mjs'))} --cwd ${q(root)}`);
      return;
    }
    if (sg.declaredGates > 0 && !sg.wired) {
      add('gate-hook', `${sg.declaredGates} declared gate(s) prompt per run — the gate-approval hook is not wired`, `node ${q(toolPath('gate-hook.mjs'))} --apply --cwd ${q(root)}`);
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
    add('family-freshness', parts.join('; '), 'npx @sabaiway/agent-workflow-kit@latest init');
  } catch (err) {
    skip('family-freshness', err);
  }
};

const probeMasksItem = ({ root, deps, add, skip }) => {
  try {
    const p = probeSandboxMasks({ cwd: root, ...deps });
    if (p == null) return; // not a git work tree — the lane is N/A, not sub-optimal
    if (!needsMasksApply(p)) return;
    const stale = p.staleReal.length ? `; ${p.staleReal.length} fenced entr(ies) became REAL paths (a fresh apply drops them by construction)` : '';
    // A stale-real-only fence (EMPTY derivation over a non-empty block) makes the plain --apply
    // REFUSE — the exact one-liner must carry --clear there (codex R1, Segment B).
    const apply = p.masks.length === 0 && p.staleReal.length > 0 ? `${p.applyCmd} --clear` : p.applyCmd;
    add('sandbox-masks', `${p.masks.length} sandbox device mask(s) clutter git status — the managed exclude block is absent or stale${stale}`, apply);
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
      add('agy-adddir', `AGY_REVIEW_ALLOW_ADDDIR is set to an INVALID value (${JSON.stringify(env.AGY_REVIEW_ALLOW_ADDDIR)}) — the wrapper falls back to refuse-mode and the settings file is shadowed while the env var is set`, 'HAND-APPLY: unset AGY_REVIEW_ALLOW_ADDDIR in the environment (or export it as 1), THEN configure it durably via the bridge-settings writer');
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
    const what = `agy-review is placed but AGY_REVIEW_ALLOW_ADDDIR is not set (${SETTINGS_FILENAME}) — an oversized code review refuses instead of offloading`;
    if (dups.length > 0) {
      add('agy-adddir', what, `HAND-APPLY: ${SETTINGS_FILENAME} carries duplicate key(s) (${dups.join(', ')}) and the settings writer refuses to edit it — remove the duplicate lines by hand, THEN run: node ${q(toolPath('bridge-settings.mjs'))} --set AGY_REVIEW_ALLOW_ADDDIR=1 --apply`);
      return;
    }
    add('agy-adddir', what, `node ${q(toolPath('bridge-settings.mjs'))} --set AGY_REVIEW_ALLOW_ADDDIR=1 --apply`);
  } catch (err) {
    skip('agy-adddir', err);
  }
};

// networkHosts of every BUNDLED bridge whose review wrapper is in the placed set — derived from the
// manifests (the single documentation source), never a hardcoded host list here.
const bundledNetworkHosts = (placedWrappers, deps) => {
  const readFile = deps.readFile ?? readFileSync;
  const readDir = deps.readdir ?? readdirSync;
  const bundleRoot = deps.bundleRoot ?? DEFAULT_BUNDLE_ROOT;
  const hosts = [];
  for (const dir of readDir(bundleRoot)) {
    // An unreadable/unparsable bundled manifest must NOT thin the paste list silently — a partial
    // allowlist pasted as complete is worse than no item. The throw reaches the probe's catch and
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
    if (reviewCmd && placedWrappers.includes(reviewCmd) && Array.isArray(manifest.networkHosts)) {
      for (const h of manifest.networkHosts) if (!hosts.includes(h)) hosts.push(h);
    }
  }
  return hosts;
};

const probeNetworkAllowlist = ({ root, deps, add, skip }) => {
  try {
    const settings = readSettingsFile(join(root, SETTINGS_FILE), { ...deps, cwd: root });
    const localSettings = readSettingsFile(join(root, SETTINGS_LOCAL_FILE), { ...deps, cwd: root });
    const sandbox = settings.data?.sandbox;
    const excluded = Array.isArray(sandbox?.excludedCommands) ? sandbox.excludedCommands : [];
    const probePlaced = deps.findWrapper ?? ((cmd) => findOnPath(cmd, deps).state === 'present');
    // Wired = the FULL two-surface tier proof (excludedCommands + the code-mode allow rule, either
    // scope) — surfacing the risky egress hand-apply while the tier is half-configured would
    // front-run the bridge-tier item (codex terminal). Byte-form from the tier's own constants.
    const allowRules = [
      ...(Array.isArray(settings.data?.permissions?.allow) ? settings.data.permissions.allow : []),
      ...(Array.isArray(localSettings.data?.permissions?.allow) ? localSettings.data.permissions.allow : []),
    ];
    const wired = BRIDGE_REVIEW_WRAPPERS.filter(
      (w) => excluded.includes(w) && probePlaced(w) && allowRules.includes(`Bash(${w} ${BRIDGE_REVIEW_MODE}:*)`),
    );
    if (wired.length === 0) return; // the tier is not (fully) wired — the bridge-tier item covers first
    // Convergence (codex R3): a hand-applied list must silence the item — compare the LIVE
    // allowedDomains (project + local scope) against the manifests and render only what is missing.
    const projectApplied = Array.isArray(sandbox?.network?.allowedDomains) ? sandbox.network.allowedDomains : [];
    const localApplied = Array.isArray(localSettings.data?.sandbox?.network?.allowedDomains) ? localSettings.data.sandbox.network.allowedDomains : [];
    // Local scope counts toward COVERAGE only — the paste targets the COMMITTED project file, so a
    // local-only allowance must never be widened to the whole project (codex terminal).
    const applied = [...projectApplied, ...localApplied];
    const manifestHosts = bundledNetworkHosts(wired, deps);
    const missing = manifestHosts.filter((h) => !applied.includes(h));
    if (missing.length === 0 && applied.length > 0) return; // every manifest host is already hand-applied
    // The pasted value is the FULL desired final list for the PROJECT scope (project ∪ missing) —
    // a missing-only snippet pasted verbatim would DROP the already-applied domains and oscillate.
    const finalList = [...projectApplied, ...missing];
    const hostsJson = finalList.map((h) => JSON.stringify(h)).join(', ');
    add(
      'network-allowlist',
      'IF plain wrapper runs still hit sandbox network prompts, this session’s sandbox is HARNESS-MANAGED — settings-level exclusions are inert there (live-observed 2026-07-11)',
      `HAND-APPLY (the kit never writes this): in .claude/settings.json set the key sandbox.network.allowedDomains to [${hostsJson}] — a MERGE into the existing sandbox object (keep excludedCommands and every other sandbox key); hosts from the bridges' capability.json networkHosts (observed-minimal; a blocked host names itself at run time)`,
    );
  } catch (err) {
    skip('network-allowlist', err);
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
  probeNetworkAllowlist,
]);

export const buildRecommendations = ({ cwd, deps = {} } = {}) => {
  const root = resolve(cwd);
  const items = [];
  const skips = [];
  const add = (key, what, apply) => items.push({ key, what, benefit: BENEFITS[key], apply });
  const skip = (key, err) => skips.push({ key, reason: err?.message ?? String(err) });
  for (const probe of PROBES) probe({ root, deps, add, skip });
  return { root, items, skips };
};

// ── rendering (the agent pastes this section VERBATIM) ──────────────────────────────────────────
export const formatRecommendations = ({ items, skips }) => {
  const lines = [RECOMMENDATIONS_SECTION_HEADER, ''];
  if (items.length === 0 && skips.length === 0) {
    // The flow-optimal claim renders ONLY when every probe ran and none fired — an empty item
    // list beside skipped checks would falsely attest optimality (codex R1, Segment B).
    lines.push(RECOMMENDATIONS_EMPTY_LINE);
  } else if (items.length === 0) {
    lines.push(`no applicable items, but ${skips.length} probe check(s) were skipped — the flow is NOT attested optimal:`);
  } else {
    items.forEach((item, i) => {
      lines.push(`${i + 1}. ${item.what}`);
      lines.push(`   benefit: ${item.benefit}`);
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

Computes the deterministic Recommendations section every kit upgrade ends with: what is
sub-optimal in THIS deployment · the benefit in one plain line · the exact consent-gated apply
one-liner. --cwd is REQUIRED (the target project is explicit, never inferred from the shell's
current directory). The section renders present-even-when-empty ("${RECOMMENDATIONS_EMPTY_LINE}");
a probe failure is a stated skipped-item line. Apply lines are cwd-independent (absolute tool
paths, a pinned --cwd; the doctor item pins via a cd prefix; the ONE exception is the set-autonomy
item — a conversational skill invocation labeled "run IN the target project") and preserve each
writer's own consent semantics; the network-allowlist item is HAND-APPLY by design — this tool and
the kit writers never seed sandbox network/filesystem allowances.

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
