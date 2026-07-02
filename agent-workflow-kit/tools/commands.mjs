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
// read-only — never writes, never commits, never runs a subscription CLI.
// writer    — writes files (a project deployment or a settings/skill placement).
// guarded   — a destructive teardown gated behind a mandatory dry-run-first + explicit consent.
// `writer` and `guarded` are the "acts on the system" kinds; only an explicit known token may reach
// one (plus the bare bootstrap exception). Garbage routes to `help` (read-only) — see routeInvocation.
export const READ_ONLY = 'read-only';
export const WRITER = 'writer';
export const GUARDED = 'guarded';
const KINDS = new Set([READ_ONLY, WRITER, GUARDED]);

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
    key: 'recipes',
    invocation: invocationOf('recipes'),
    group: 'Orchestrate',
    kind: READ_ONLY,
    oneLine: 'See the orchestration recipes (Solo / Reviewed / Council / Delegated) and which one fits this environment.',
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
//   a known first token (upgrade/status/setup/backends/recipes/procedures/velocity/uninstall/help)
//     → that mode
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

const KIND_TAG = { [READ_ONLY]: '[read-only]', [WRITER]: '[writer]   ', [GUARDED]: '[guarded]  ' };
const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

// formatHelp() → the grouped, kind-tagged human index. Deterministic; groups in GROUP_ORDER, modes in
// catalog order within each group. The header states the index itself is read-only.
export const formatHelp = () => {
  const invocWidth = Math.max(...COMMANDS.map((c) => c.invocation.length));
  const lines = [
    `${SKILL_NAME} — command index (this list is read-only)`,
    '',
    'Each command is tagged read-only · writer (makes changes) · guarded (destructive, previews first).',
  ];
  for (const group of GROUP_ORDER) {
    const inGroup = COMMANDS.filter((c) => c.group === group);
    if (!inGroup.length) continue;
    lines.push('', group);
    for (const c of inGroup) {
      lines.push(`  ${pad(c.invocation, invocWidth)}  ${KIND_TAG[c.kind] ?? c.kind}  ${c.oneLine}`);
    }
  }
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
