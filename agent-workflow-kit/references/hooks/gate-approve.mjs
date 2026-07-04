#!/usr/bin/env node
// gate-approve.mjs — the agent-workflow PreToolUse gate-approval hook. Bundled at
// references/hooks/gate-approve.mjs; PLACED (copied) by `/agent-workflow-kit hook` to
// <project>/.claude/hooks/agent-workflow-gates.mjs and wired as a `PreToolUse` "Bash" hook in
// .claude/settings.json.
//
// SELF-CONTAINED by contract: the placed copy must run on machines without the kit — no kit
// imports, dependency-free, Node >= 18, no side effects on import. Two constants are baked
// FROZEN COPIES of the velocity-profile.mjs exports (a placed file cannot import the kit):
// SEEDED_READONLY_CORE ≡ UNIVERSAL_READONLY_ALLOWLIST and RESIDUAL_FORMS ≡
// RUNTIME_RESIDUAL_FORMS — drift-guarded by the kit's test/gate-hook-core-parity.test.mjs.
//
// It reads <project root>/docs/ai/gates.json LIVE on every invocation (AD-035: one declaration,
// two consumers — editing gates.json never requires re-wiring). The project root resolves from
// $CLAUDE_PROJECT_DIR (the stdin `cwd` may be a subdirectory), falling back to the stdin `cwd`
// only when the env is absent.
//
// Decision ladder for every Bash PreToolUse call — first match wins:
//   (a) declared-gate EXACT match → allow. Byte-identical (leading/trailing trim only — no
//       whitespace collapsing, no quote/glob/variable interpretation, no prefix or pattern
//       matching: patterns are exactly what made AD-021 auto-seeding fragile) to one declared
//       gate `cmd`, AND the stdin `cwd` realpath-resolves to the project root (gates run FROM
//       THE ROOT by contract — the same bytes from a subdirectory resolve relative paths
//       differently), AND permission_mode is `default`/`acceptEdits` (an allow never loosens
//       `plan`/`bypassPermissions`).
//   (b) residual guard → ask. The command's leading tokens match the SEEDED read-only core AND
//       the command carries a documented runtime residual (output redirection, command
//       substitution, the bounded `--output` write-flag family) that a settings-level allow
//       rule cannot see. Most-restrictive-wins: this surfaces a human prompt even where a
//       seeded allow rule would have silently approved. Detection is deliberately string-level
//       and conservative (no shell parsing in a dependency-free hook): a quoted metacharacter
//       may over-ASK, never under-allow. Covers the kit-SEEDED core only, never arbitrary
//       user-added rules.
//   (c) everything else → NO decision: exit 0, no output — the normal permission flow proceeds
//       unchanged. The hook NEVER emits `deny`.
//
// Fail-safe invariant, decoupled per function: a DECLARATION anomaly (missing / unreadable /
// malformed / schema-invalid gates.json) disables ONLY exact-gate approval (a) — the residual
// guard (b) needs no declaration and keeps running (a broken gates.json must not silently
// reopen the seeded-allowlist hole). Only an INPUT anomaly (unparseable stdin, non-Bash
// tool_name) disables the whole hook. EVERY anomaly path exits 0 — never exit 2 (exit 2 is an
// immediate block; a hook that fires on every Bash call must never become the blocker or the
// noise — run-gates.mjs already yells about a broken declaration at its own point of use).
//
// Trust posture: this hook only removes the PROMPT for commands the human already declared in
// gates.json — the same trust boundary as run-gates.mjs, which executes those commands with the
// caller's privileges. gates.json is thereby a privileged file; an invalid declaration approves
// NOTHING (strict-parse-or-no-decision).

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const HOOK_EVENT_NAME = 'PreToolUse';
export const BASH_TOOL_NAME = 'Bash';
export const GATES_REL = 'docs/ai/gates.json';
export const PROJECT_DIR_ENV = 'CLAUDE_PROJECT_DIR';
export const DECISION_ALLOW = 'allow';
export const DECISION_ASK = 'ask';
// The only modes an `allow` may be emitted under — an allowlist, so an unknown future mode is
// fenced closed by default. The residual guard (b) is NOT mode-fenced: an `ask` never loosens.
export const ALLOW_PERMISSION_MODES = Object.freeze(['default', 'acceptEdits']);

// Baked frozen copy of velocity-profile.mjs UNIVERSAL_READONLY_ALLOWLIST (the audited read-only
// core velocity seeds as settings allow rules). Drift-guarded — never edit here alone.
export const SEEDED_READONLY_CORE = Object.freeze([
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git ls-files:*)',
  'Bash(git check-ignore:*)',
  'Bash(git branch --list:*)',
  'Bash(git rev-parse:*)',
  'Bash(git blame:*)',
  'Bash(git shortlog:*)',
  'Bash(git describe:*)',
  'Bash(git tag --list:*)',
  'Bash(git stash list:*)',
  'Bash(git worktree list:*)',
  'Bash(npm view:*)',
  'Bash(npm ls:*)',
  'Bash(npm outdated:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  'Bash(readlink:*)',
  'Bash(which:*)',
  'Bash(grep:*)',
  'Bash(diff:*)',
  'Bash(stat:*)',
  'Bash(du:*)',
  'Bash(basename:*)',
  'Bash(dirname:*)',
  'Bash(realpath:*)',
]);

// Baked frozen copy of velocity-profile.mjs RUNTIME_RESIDUAL_FORMS (the documented residual a
// settings-level allow rule cannot see). Drift-guarded — never edit here alone.
export const RESIDUAL_FORMS = Object.freeze({
  writeRedirections: Object.freeze(['>', '>>', '1>', '2>', '&>', '>|']),
  // `$(…)` + backtick + process substitution `<(…)` all RUN a nested command (`>(…)` is caught by
  // the `>` redirection scan). Bare `<` is input redirection (reads a file — read-only commands may
  // already do that), so it is deliberately NOT here.
  commandSubstitutions: Object.freeze(['$(', '`', '<(']),
  // The `--output` write-flag family, matched as a raw SUBSTRING of the whole command (never a
  // whitespace-token check): the hook sees the pre-shell command string, so `--output=f`,
  // `"--output=f"`, `'--output' f`, and `\--output` must all trip it — over-asking on a benign
  // `--output-indicator` is the safe direction (never under-allow a real write flag through quotes).
  boundedWriteFlags: Object.freeze(['--output']),
});

export const RESIDUAL_CLASS_REDIRECTION = 'output redirection';
export const RESIDUAL_CLASS_SUBSTITUTION = 'command substitution';
export const RESIDUAL_CLASS_OUTPUT_FLAG = 'a bounded --output write flag';

const EXIT_OK = 0;
const UTF8 = 'utf8';
const BASH_ALLOW_PATTERN = /^Bash\((.+):\*\)$/u;
const WHITESPACE_PATTERN = /\s+/u;
const GATE_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const GATE_CMD_NEWLINE_PATTERN = /[\r\n]/u;
const GATE_KEYS = Object.freeze(['id', 'title', 'cmd']);
const README_KEY = '_README';
const GATES_KEY = 'gates';

// ── declaration (validation parity with run-gates.mjs) ────────────────────────────────

// Self-contained restatement of run-gates.mjs `validateDeclaration`, at EXACT parity including
// the optional `_README` string — a declaration the runner accepts is never rejected here (else
// every template-shaped declaration would approve nothing), and one the runner rejects never
// approves anything. Returns a boolean shape instead of throwing: anomalies go dark, not loud.
export const validateDeclarationShape = (parsed) => {
  const invalid = { ok: false };
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid;
  for (const key of Object.keys(parsed)) {
    if (key !== README_KEY && key !== GATES_KEY) return invalid;
  }
  if (parsed[README_KEY] !== undefined && typeof parsed[README_KEY] !== 'string') return invalid;
  if (!Array.isArray(parsed[GATES_KEY])) return invalid;
  const seenIds = new Set();
  for (const gate of parsed[GATES_KEY]) {
    if (gate === null || typeof gate !== 'object' || Array.isArray(gate)) return invalid;
    for (const key of Object.keys(gate)) {
      if (!GATE_KEYS.includes(key)) return invalid;
    }
    for (const key of GATE_KEYS) {
      if (typeof gate[key] !== 'string' || gate[key].trim() === '') return invalid;
    }
    if (GATE_CMD_NEWLINE_PATTERN.test(gate.cmd)) return invalid;
    if (!GATE_ID_PATTERN.test(gate.id)) return invalid;
    if (seenIds.has(gate.id)) return invalid;
    seenIds.add(gate.id);
  }
  return { ok: true, gates: parsed[GATES_KEY] };
};

// Read + strictly validate the LIVE declaration. Any declaration anomaly returns null — ladder
// (a) goes dark while the residual guard (b) keeps running (the decoupled fail-safe invariant).
export const readDeclarationGates = (projectRoot, deps = {}) => {
  const readFile = deps.readFile ?? readFileSync;
  if (typeof projectRoot !== 'string' || projectRoot === '') return null;
  try {
    const validated = validateDeclarationShape(JSON.parse(readFile(join(projectRoot, GATES_REL), UTF8)));
    return validated.ok ? validated.gates : null;
  } catch {
    return null;
  }
};

// ── seeded-core prefix + residual detection (ladder b) ────────────────────────────────

const getAllowCommandPrefix = (pattern) => {
  const match = pattern.match(BASH_ALLOW_PATTERN);
  return match ? match[1] : undefined;
};

const tokenizeCommand = (command) => command.trim().split(WHITESPACE_PATTERN).filter(Boolean);

const CORE_PREFIX_TOKEN_LISTS = Object.freeze(
  SEEDED_READONLY_CORE.map(getAllowCommandPrefix)
    .filter(Boolean)
    .map((prefix) => Object.freeze(tokenizeCommand(prefix))),
);

// `Bash(git status:*)` approves `git status <anything>` at a word boundary — the guard matches
// the same way: a core pattern's tokens must be the command's LEADING tokens exactly.
export const matchSeededCorePrefix = (command) => {
  const tokens = tokenizeCommand(command);
  const matched = CORE_PREFIX_TOKEN_LISTS.find(
    (prefixTokens) =>
      prefixTokens.length <= tokens.length && prefixTokens.every((token, index) => tokens[index] === token),
  );
  return matched ? matched.join(' ') : null;
};

// String-level, conservative: the hook sees the PRE-SHELL command string, so every class is a raw
// substring scan (never a whitespace-token check — a token check misses `"--output=f"` / `'>' f`
// where the quotes are still in the string but the shell will strip them). A quoted metacharacter
// or write flag may over-ASK, never under-allow (no shell parsing in a dependency-free hook).
export const detectResidualClasses = (command) => {
  const classes = [];
  if (RESIDUAL_FORMS.writeRedirections.some((form) => command.includes(form))) {
    classes.push(RESIDUAL_CLASS_REDIRECTION);
  }
  if (RESIDUAL_FORMS.commandSubstitutions.some((form) => command.includes(form))) {
    classes.push(RESIDUAL_CLASS_SUBSTITUTION);
  }
  if (RESIDUAL_FORMS.boundedWriteFlags.some((flag) => command.includes(flag))) {
    classes.push(RESIDUAL_CLASS_OUTPUT_FLAG);
  }
  return classes;
};

// ── the decision ladder (pure core) ───────────────────────────────────────────────────

export const decideBashCall = ({ command, permissionMode, cwdIsProjectRoot, gates }) => {
  const trimmed = command.trim();
  // (a) declared-gate exact match — all three invariants (declaration valid, cwd = project
  // root, mode in the allow fence) must hold; otherwise fall through, never error.
  if (Array.isArray(gates) && cwdIsProjectRoot === true && ALLOW_PERMISSION_MODES.includes(permissionMode)) {
    const declaredGate = gates.find((gate) => gate.cmd.trim() === trimmed);
    if (declaredGate !== undefined) {
      return {
        permissionDecision: DECISION_ALLOW,
        permissionDecisionReason: `agent-workflow gates: byte-exact match of declared gate "${declaredGate.id}" (${GATES_REL}), invoked from the project root`,
      };
    }
  }
  // (b) residual guard — no declaration needed; not mode-fenced (an ask never loosens).
  const corePrefix = matchSeededCorePrefix(trimmed);
  if (corePrefix !== null) {
    const residualClasses = detectResidualClasses(trimmed);
    if (residualClasses.length > 0) {
      return {
        permissionDecision: DECISION_ASK,
        permissionDecisionReason: `agent-workflow residual guard: read-only-seeded "${corePrefix}" carries ${residualClasses.join(' + ')} — a settings allow rule cannot see runtime shape; confirm by hand`,
      };
    }
  }
  // (c) no decision — the normal permission flow proceeds unchanged.
  return null;
};

// ── stdin-driven main ─────────────────────────────────────────────────────────────────

const resolveRealpath = (maybePath, realpath) => {
  if (typeof maybePath !== 'string' || maybePath === '') return null;
  try {
    return realpath(maybePath);
  } catch {
    return null;
  }
};

// Parse one PreToolUse stdin payload and run the ladder. Returns the decision object or null
// (null → no output, exit 0). Injectable deps keep the tests hermetic.
export const runHook = (rawInput, deps = {}) => {
  const env = deps.env ?? process.env;
  const realpath = deps.realpath ?? realpathSync;
  const parseInput = () => {
    try {
      return JSON.parse(rawInput);
    } catch {
      return null;
    }
  };
  const input = parseInput();
  // Input anomaly → the WHOLE hook goes dark (distinct from a declaration anomaly, which only
  // darkens ladder (a)).
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.tool_name !== BASH_TOOL_NAME) return null;
  const command = input.tool_input === null || typeof input.tool_input !== 'object' ? undefined : input.tool_input.command;
  if (typeof command !== 'string' || command.trim() === '') return null;

  const envRoot = env[PROJECT_DIR_ENV];
  const projectRoot =
    typeof envRoot === 'string' && envRoot !== '' ? envRoot : typeof input.cwd === 'string' ? input.cwd : null;
  const rootReal = resolveRealpath(projectRoot, realpath);
  const cwdReal = resolveRealpath(input.cwd, realpath);
  return decideBashCall({
    command,
    permissionMode: input.permission_mode,
    cwdIsProjectRoot: rootReal !== null && cwdReal !== null && rootReal === cwdReal,
    gates: readDeclarationGates(projectRoot, deps),
  });
};

export const formatDecision = (decision) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: HOOK_EVENT_NAME, ...decision } });

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString(UTF8);
};

export const main = async () => {
  // Exit 0 on EVERY path — never exit 2 (an immediate block), never a top-level throw: this
  // fires on every Bash call and must never become the blocker or the noise.
  try {
    const decision = runHook(await readStdin());
    if (decision !== null) process.stdout.write(`${formatDecision(decision)}\n`);
  } catch {
    // Deliberately dark: anomalies are the runner's job to report at its own point of use.
  }
  return EXIT_OK;
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main().then((code) => process.exit(code));
