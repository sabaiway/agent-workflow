#!/usr/bin/env node
// commands.mjs — the kit's canonical command catalog + the pure invocation router behind the
// `/agent-workflow-kit help` index and the safe unknown-invocation routing rule.
//
// Until now the modes existed only as `### Mode:` headers in SKILL.md, never enumerated for the user:
// there was no discoverable command surface and no executable answer to "what did the user actually
// invoke?". This module is the SINGLE source of truth for both — one frozen catalog (one entry per
// mode, grouped + tagged read-only/writer/guarded with a plain-language one-liner) that the `help`
// mode renders and the report footers point at, plus `routeInvocation(token)` that maps a raw
// subcommand token to its mode.
//
// Safety invariant (pinned by the tests): `bootstrap` is a writer and the BARE/EMPTY invocation maps
// to it — that is the ONE acknowledged exception, itself guarded downstream by the existing
// "docs/ai/ exists → ask upgrade-vs-bootstrap" check (SKILL.md Mode: bootstrap). The invariant is
// therefore: NO unrecognized/garbage token ever maps to a writer/guarded mode — every such token
// routes to `help`, which is read-only.
//
// Source of truth = the COMMANDS table below; a drift-guard test (commands.test.mjs) pins its keys to
// the `### Mode:` headers in SKILL.md, so the catalog cannot silently drift from the documented modes.
// Pure, dependency-free, Node >= 18. No side effects on import (the isDirectRun idiom).

import { pathToFileURL } from 'node:url';

const SKILL_NAME = 'agent-workflow-kit';
const BARE_INVOCATION = `/${SKILL_NAME}`;
const invocationOf = (token) => `${BARE_INVOCATION}${token ? ` ${token}` : ''}`;

// ── kinds ────────────────────────────────────────────────────────────────────────
// read-only    — never writes, never commits, never runs a subscription CLI.
// writer       — writes files (a project deployment or a settings/skill placement).
// guarded      — a destructive teardown gated behind a mandatory dry-run-first + explicit consent.
// project-exec — the kit itself writes nothing, but the mode RUNS the project's own declared
//                commands with the caller's privileges (the `gates` runner) — honest-tagged so a
//                user never reads "read-only" on a surface that executes their gate matrix.
// `writer` and `guarded` are the "acts on the system" kinds; only an explicit known token may reach
// one (plus the bare bootstrap exception). Garbage routes to `help` (read-only) — see routeInvocation.
export const READ_ONLY = 'read-only';
export const WRITER = 'writer';
export const GUARDED = 'guarded';
export const PROJECT_EXEC = 'project-exec';
const KINDS = new Set([READ_ONLY, WRITER, GUARDED, PROJECT_EXEC]);

// ── groups (fixed render order) ────────────────────────────────────────────────────
export const GROUP_ORDER = Object.freeze(['Inspect', 'Configure', 'Orchestrate', 'Lifecycle']);

// ── the canonical catalog ──────────────────────────────────────────────────────────
// One entry per `### Mode:` in SKILL.md. `key` is the mode (and, for every non-bootstrap mode, the
// routable subcommand token — bootstrap is the bare invocation, so it has no token). `oneLine` is
// plain-language: NO internal terms (no reconcile/fence/stamp/manifest/anchor) a third-party user
// hasn't read SKILL.md for. The drift-guard test pins these keys to the SKILL.md headers.
const CATALOG = [
  {
    key: 'bootstrap',
    invocation: BARE_INVOCATION,
    group: 'Lifecycle',
    kind: WRITER,
    oneLine: 'Deploy the memory & workflow system into a new or empty project (asks visibility, language, and attribution first).',
  },
  {
    key: 'upgrade',
    invocation: invocationOf('upgrade'),
    group: 'Lifecycle',
    kind: WRITER,
    oneLine: 'Bring an existing deployment up to the current version — your authored notes are preserved.',
  },
  {
    key: 'uninstall',
    invocation: invocationOf('uninstall'),
    group: 'Lifecycle',
    kind: GUARDED,
    oneLine: 'Remove only what setup placed; it never deletes your notes and always previews before changing anything.',
  },
  {
    key: 'status',
    invocation: invocationOf('status'),
    group: 'Inspect',
    kind: READ_ONLY,
    oneLine: 'Show what is installed and at what version, your settings and backends, and what is deployed in this project.',
  },
  {
    key: 'backends',
    invocation: invocationOf('backends'),
    group: 'Inspect',
    kind: READ_ONLY,
    oneLine: 'Check which optional review/execute backends (codex, agy) are set up versus missing, and the next step.',
  },
  {
    key: 'help',
    invocation: invocationOf('help'),
    group: 'Inspect',
    kind: READ_ONLY,
    oneLine: 'List every command, grouped, marking each as read-only or as one that makes changes.',
  },
  {
    key: 'gates',
    invocation: invocationOf('gates'),
    group: 'Inspect',
    kind: PROJECT_EXEC,
    oneLine: 'Run the project’s own declared gate commands (docs/ai/gates.json) as one batch — a PASS/FAIL table, one summary line. Writes nothing by default; opt-in --record mints a gate-run record via the review-ledger writer (the segment’s green-baseline receipt). A separate consent-gated seeder can propose entries from your project’s own scripts (preview first, written only on your yes).',
  },
  {
    key: 'setup',
    invocation: invocationOf('setup'),
    group: 'Configure',
    kind: WRITER,
    oneLine: 'Set up an optional backend — place its helper and link its commands onto your PATH (opt-in; preview first).',
  },
  {
    key: 'velocity',
    invocation: invocationOf('velocity'),
    group: 'Configure',
    kind: WRITER,
    oneLine: 'Seed a read-only command allowlist so routine read-only commands stop prompting (Claude Code; opt-in; preview first).',
  },
  {
    key: 'agents',
    invocation: invocationOf('agents'),
    group: 'Configure',
    kind: WRITER,
    oneLine: 'Place bundled cheap-model subagent definitions for mechanical work — sweeps, changelog skeletons, gate triage (Claude Code; opt-in; preview first).',
  },
  {
    key: 'hook',
    invocation: invocationOf('hook'),
    group: 'Configure',
    kind: WRITER,
    oneLine: 'Auto-approve your own declared gate commands (docs/ai/gates.json) via a Claude Code hook — exact matches only, previews first (opt-in).',
  },
  {
    key: 'bridge-settings',
    invocation: invocationOf('bridge-settings'),
    group: 'Configure',
    kind: GUARDED,
    oneLine: 'Read or change the host-level bridge settings (e.g. the codex Fast tier) — a KEY=VALUE file that survives kit upgrades; previews first, and the Fast tier carries its extra-cost caveat.',
  },
  {
    key: 'recipes',
    invocation: invocationOf('recipes'),
    group: 'Orchestrate',
    kind: READ_ONLY,
    oneLine: 'See the orchestration recipes (Solo / Reviewed / Council / Delegated), which one fits this environment, and the configured per-activity line to paste at session start.',
  },
  {
    key: 'procedures',
    invocation: invocationOf('procedures'),
    group: 'Orchestrate',
    kind: READ_ONLY,
    oneLine: 'Show a named activity’s steps, the recipe per stage, and each dispatched backend’s exact driving contract (invocation + grounding + round-2 delta).',
  },
  {
    key: 'set-recipe',
    invocation: invocationOf('set-recipe'),
    group: 'Orchestrate',
    kind: WRITER,
    oneLine: 'Set the orchestration recipe for an activity from plain language — previews the change, then writes the config when you confirm.',
  },
  {
    key: 'set-autonomy',
    invocation: invocationOf('set-autonomy'),
    group: 'Orchestrate',
    kind: WRITER,
    oneLine: 'Set the per-project autonomy policy from plain language — which actions always ask (commit/push/publish/network) and how autonomously each activity runs; previews the change, then writes the policy when you confirm.',
  },
  {
    key: 'review-state',
    invocation: invocationOf('review-state'),
    group: 'Orchestrate',
    kind: READ_ONLY,
    oneLine: 'Check that every configured review backend has receipted the current uncommitted tree with a fresh grounded review; --check turns it into a gate exit code.',
  },
  {
    key: 'grounding',
    invocation: invocationOf('grounding'),
    group: 'Orchestrate',
    kind: WRITER,
    oneLine: 'Assemble the verified-facts payload a grounded review runs against — the entry-point Hard Constraints plus a plan’s decision sections; prints it, or writes ONE scratch file with --out.',
  },
  {
    key: 'review-ledger',
    invocation: invocationOf('review-ledger'),
    group: 'Orchestrate',
    kind: WRITER,
    oneLine: 'Record each review round, its triage, and recorded overrides (oracle-change / red-proof / size-cap waivers) and read the computed crossover-stop for the plan-execution loop — per SEGMENT since v4 (base = HEAD; caps and teeth reset only at a gated commit; class refuted is the honest phantom lane); --check turns it into a gate exit code, --telemetry renders counts-only gate-efficacy data.',
  },
  {
    key: 'fold-completeness',
    invocation: invocationOf('fold-completeness'),
    group: 'Orchestrate',
    kind: WRITER,
    oneLine: 'Verify the review loop’s folded fixes are pinned by HONEST tests — every changed executable line executed, and each bound test carries an observed-red receipt (--red, minted BEFORE the fix), N/N-green probes, and content custody (waivable per-testId only by a recorded red-proof override), over a test surface whose tampered files carry recorded oracle-change overrides; SEGMENT-scoped since v3 (a committed phase’s custody obligations close with its commit); --check turns the result into a gate exit code.',
  },
];

// Deep-freeze: freeze the array AND every entry, so the catalog is genuinely immutable at runtime
// (Object.freeze on the array alone leaves the entry objects writable).
export const COMMANDS = Object.freeze(CATALOG.map((c) => Object.freeze(c)));

// The mode every garbage/unrecognized token routes to. Read-only by contract (see routeInvocation).
export const UNKNOWN_INVOCATION_MODE = 'help';
// The mode the bare/empty invocation maps to — the one writer reachable without an explicit token,
// guarded downstream by the docs/ai upgrade-vs-bootstrap check.
export const BARE_INVOCATION_MODE = 'bootstrap';

const byKey = new Map(COMMANDS.map((c) => [c.key, c]));
// Routable subcommand tokens = every mode except bootstrap (whose invocation is the bare default).
const ROUTABLE_TOKENS = new Set(COMMANDS.filter((c) => c.key !== BARE_INVOCATION_MODE).map((c) => c.key));

export const commandFor = (key) => byKey.get(key) ?? null;
export const kindOf = (key) => byKey.get(key)?.kind ?? null;

// ── the pure router ────────────────────────────────────────────────────────────────
// routeInvocation(token) → a mode key. `token` is the subcommand the user typed — either the raw word
// (`upgrade`) OR the full slash form (`/agent-workflow-kit upgrade`); the first word is significant
// and trailing args are ignored. Precise semantics:
//   undefined / null / '' / whitespace-only / the exact bare invocation → 'bootstrap'
//   a known first token (upgrade/status/setup/backends/recipes/procedures/velocity/agents/hook/
//     gates/set-recipe/uninstall/help) → that mode
//   anything else (unrecognized / ambiguous) → 'help'  (read-only — NEVER a writer/guarded mode)
export const routeInvocation = (token) => {
  if (token == null) return BARE_INVOCATION_MODE;
  const trimmed = String(token).trim();
  if (trimmed === '' || trimmed === BARE_INVOCATION) return BARE_INVOCATION_MODE;
  // Accept either the raw subcommand token OR the full slash invocation the user types — strip a
  // leading `/agent-workflow-kit ` prefix so `/agent-workflow-kit upgrade` routes like `upgrade`.
  const rest = trimmed.startsWith(`${BARE_INVOCATION} `)
    ? trimmed.slice(BARE_INVOCATION.length).trim()
    : trimmed;
  if (rest === '') return BARE_INVOCATION_MODE;
  const first = rest.split(/\s+/)[0];
  return ROUTABLE_TOKENS.has(first) ? first : UNKNOWN_INVOCATION_MODE;
};

// ── render ──────────────────────────────────────────────────────────────────────────

const KIND_TAG = {
  [READ_ONLY]: '[read-only]        ',
  [WRITER]: '[writer]           ',
  [GUARDED]: '[guarded]          ',
  [PROJECT_EXEC]: '[runs project cmds]',
};
const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

// The "Tune" tail — the opt-in accelerator funnel, rendered AFTER the catalog groups. NOT a new
// catalog key or mode (the frozen CATALOG + GROUP_ORDER stay; the router SKILL.md is untouched):
// the same four entries the bootstrap accelerators block presents, one line of why each.
const TUNE_TAIL = Object.freeze([
  '',
  'Tune — opt-in accelerators (consent-first: every writer previews before writing; nothing runs without your yes)',
  `  ${BARE_INVOCATION} velocity      routine read-only commands stop prompting (incl. the --kit-tools tier for the kit's own read-only tools)`,
  `  ${BARE_INVOCATION} agents        cheap-model subagents take the mechanical work (sweeps, changelog skeletons, gate triage)`,
  `  ${BARE_INVOCATION} gates         run your declared gates (docs/ai/gates.json) as one batch; its guide also offers the consent-gated seeding preview — writes only on your yes`,
  `  ${BARE_INVOCATION} hook          auto-approve exactly your declared gate commands (byte-exact matches only)`,
  `  ${BARE_INVOCATION} set-recipe    put a ready review backend to work on plans and diffs`,
]);

// formatHelp() → the grouped, kind-tagged human index. Deterministic; groups in GROUP_ORDER, modes in
// catalog order within each group. The header states the index itself is read-only.
export const formatHelp = () => {
  const invocWidth = Math.max(...COMMANDS.map((c) => c.invocation.length));
  const lines = [
    `${SKILL_NAME} — command index (this list is read-only)`,
    '',
    'Each command is tagged read-only · writer (makes changes) · guarded (destructive, previews first) · runs project cmds (executes your own declared commands).',
  ];
  for (const group of GROUP_ORDER) {
    const inGroup = COMMANDS.filter((c) => c.group === group);
    if (!inGroup.length) continue;
    lines.push('', group);
    for (const c of inGroup) {
      lines.push(`  ${pad(c.invocation, invocWidth)}  ${KIND_TAG[c.kind] ?? c.kind}  ${c.oneLine}`);
    }
  }
  lines.push(...TUNE_TAIL);
  return lines.join('\n');
};

// The machine form behind `--json`: the flat catalog (machines group by `group` themselves) plus the
// two routing anchors, so a consumer can reproduce routeInvocation without re-deriving the rules.
export const buildJson = () => ({
  skill: SKILL_NAME,
  groupOrder: [...GROUP_ORDER],
  unknownInvocationMode: UNKNOWN_INVOCATION_MODE,
  bareInvocationMode: BARE_INVOCATION_MODE,
  commands: COMMANDS.map(({ key, invocation, group, kind, oneLine }) => ({ key, invocation, group, kind, oneLine })),
});

// ── CLI ──────────────────────────────────────────────────────────────────────────────
const main = (argv) => {
  if (argv.includes('--json')) {
    console.log(JSON.stringify(buildJson(), null, 2));
    return;
  }
  console.log(formatHelp());
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main(process.argv.slice(2));

export { KINDS, SKILL_NAME, BARE_INVOCATION };
