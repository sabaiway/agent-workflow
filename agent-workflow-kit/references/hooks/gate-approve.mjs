#!/usr/bin/env node
// gate-approve.mjs — the agent-workflow PreToolUse gate-approval hook. Bundled at
// references/hooks/gate-approve.mjs; PLACED (copied) by `/agent-workflow-kit hook` to
// <project>/.claude/hooks/agent-workflow-gates.mjs and wired as a `PreToolUse` "Bash" hook in
// .claude/settings.json.
//
// SELF-CONTAINED by contract: the placed copy must run on machines without the kit — no kit
// imports, dependency-free, Node >= 22, no side effects on import. Two constants are baked
// FROZEN COPIES of the velocity-profile.mjs exports (a placed file cannot import the kit):
// SEEDED_READONLY_CORE ≡ UNIVERSAL_READONLY_ALLOWLIST and RESIDUAL_FORMS ≡
// RUNTIME_RESIDUAL_FORMS — drift-guarded by the kit's test/gate-hook-core-parity.test.mjs.
//
// It reads <project root>/docs/ai/gates.json LIVE on every invocation (AD-035: one declaration,
// two consumers — editing gates.json never requires re-wiring) and, for the opt-in read-lane
// (rung c), <project root>/docs/ai/lanes.json LIVE as well (AD-055 Part II — a SEPARATE kit-owned
// file; gates.json, both its validators and the byte-mirrored template stay untouched). The project
// root resolves from $CLAUDE_PROJECT_DIR (the stdin `cwd` may be a subdirectory), falling back to
// the stdin `cwd` only when the env is absent.
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
//       seeded allow rule would have silently approved. Covers the kit-SEEDED core only, never
//       arbitrary user-added rules.
//       Detection is deliberately string-level and conservative (no shell parsing in a
//       dependency-free hook): a quoted metacharacter may over-ASK, never under-allow. That
//       over-ask is a KNOWN COST, not an oversight — searching for `=>`, or a plain read wearing
//       `2>/dev/null`, prompts. Three mechanisms to narrow it were built and removed; the note
//       above `detectResidualClasses` records all three with their counterexamples.
//   (c) read-lane allow (OPT-IN) → allow. Only when docs/ai/lanes.json enables it
//       (`{ "readLane": true }`, read LIVE per call, fail-closed): a command every separator-split
//       segment of which is a plain frozen read-only core prefix, with ZERO shell metaprogramming
//       anywhere — a conservative CLOSED-WORLD allow (any doubt → fall through, never a widening).
//       Mode-fenced like (a); cwd-agnostic (a read is a read from any directory). Runs AFTER (b),
//       so a residual-carrying core command still ASKs (most-restrictive-wins by ladder order).
//   (d) everything else → NO decision: exit 0, no output — the normal permission flow proceeds
//       unchanged. The hook NEVER emits `deny`.
//
// EVERY ASK ALSO CARRIES A CALLER-FACING HINT (`additionalContext`). The ask itself goes to the
// HUMAN and its reason never reaches the caller that composed the command — so the guard knew the
// right lane and could not say it, which is the one thing every withdrawn deny design was buying.
// The hint is that channel without the refusal, and a host that ignores the field degrades to
// silence, i.e. to the previous behaviour. See the note above `HINT_CORE`.
//
// WHY THERE IS NO DENY RUNG, AND WHY THE DIRECTION IS RETIRED (kit 4.0.0 built one, AD-078
// removed it; the class was closed from the other side instead). The withdrawn rung refused a
// seeded read-only command that provably DISCARDED its output, on the argument that such a refusal
// cannot destroy anything the caller wanted. The argument was sound; the byte-level PROOF was not.
// Five constructs defeated it in three rounds — `1<&2` (an fd dup routes stdout back out of
// /dev/null AFTER the approved `>`), a quoted literal `>/dev/null ` in an argument, a
// leading-token-only segment match (`… && npm test`), a bare `&` (backgrounds the read, runs the
// rest), and a `#` comment (bash never executes the redirect at all). Each was a FALSE REFUSAL,
// because on an ASK rung an incomplete scan merely over-asks — safe — while on a DENY rung the
// SAME incompleteness refuses real work.
// The direction is retired, not deferred, for a reason bigger than that: the prompts it was meant
// to prevent were being raised BY THIS HOOK. A deny cannot remove a prompt the hook itself is
// causing — correcting what the guard reports does, and it does it without ever refusing anything.
// Correcting what the guard REPORTS can, and refuses nothing — but three attempts at that
// correction were also built and removed (see the note above `detectResidualClasses`). The prompts
// are still there, and are stated rather than papered over.
// Design record: docs/plans/queue.md, BARE-LANE-DENY-RUNG.
//
// Fail-safe invariant, decoupled per function: a DECLARATION anomaly (missing / unreadable /
// malformed / schema-invalid gates.json) disables ONLY exact-gate approval (a) — the residual
// guard (b) needs no declaration and keeps running (a broken gates.json must not silently
// reopen the seeded-allowlist hole). A lanes.json anomaly (absent / malformed / non-boolean) merely
// leaves rung (c) DARK (fail-closed) — rungs (a)/(b) are unaffected. Only an INPUT anomaly (unparseable stdin, non-Bash
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
// The opt-in read-lane toggle (rung c) — a SEPARATE kit-owned strict-JSON file (AD-055 Part II);
// gates.json's schema/validators/template are untouched by design.
export const LANES_REL = 'docs/ai/lanes.json';
export const READ_LANE_KEY = 'readLane';
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
  // `$(…)` + backtick + BOTH process substitutions `<(…)` / `>(…)` RUN a nested command. `>(…)` is
  // named here explicitly because that is the class it is IN: the redirection scan also happens to
  // match its `>`, but a command that RUNS something must be reported as running something, and a
  // classification must not depend on another class's coincidence. Bare `<` is input redirection
  // (reads a file — read-only commands may
  // already do that), so it is deliberately NOT here. The bash-5.3 function substitutions `${ cmd; }`
  // (a blank — space/tab/newline/CR — right after `${`) and `${| cmd; }` also RUN a nested command —
  // matched as the literal openers `${ ` / `${\t` / `${\n` / `${\r` / `${|` (AD-055 Part II). Ordinary
  // `${VAR}` has no blank after `${`, so it trips none of these (kept rung-(b)-silent).
  commandSubstitutions: Object.freeze(['$(', '`', '<(', '>(', '${ ', '${\t', '${\n', '${\r', '${|']),
  // A backslash immediately before a newline/CR is a bash LINE CONTINUATION: bash removes it and
  // splices the two lines into ONE word, reconstructing a residual token (`--output`, `$(`, `${ …; }`)
  // a raw substring scan on the pre-splice string misses. Guards a settings-allowed SINGLE (rung c
  // already forbids backslash in every segment). AD-055 Part II council fold.
  lineContinuations: Object.freeze(['\\\n', '\\\r']),
  // The `--output` write-flag family, matched as a raw SUBSTRING of the whole command (never a
  // whitespace-token check): the hook sees the pre-shell command string, so `--output=f`,
  // `"--output=f"`, `'--output' f`, and `\--output` must all trip it — over-asking on a benign
  // `--output-indicator` is the safe direction (never under-allow a real write flag through quotes).
  boundedWriteFlags: Object.freeze(['--output']),
});

export const RESIDUAL_CLASS_REDIRECTION = 'output redirection';
export const RESIDUAL_CLASS_SUBSTITUTION = 'command substitution';
export const RESIDUAL_CLASS_OUTPUT_FLAG = 'a bounded --output write flag';
export const RESIDUAL_CLASS_CONTINUATION = 'a line-continuation splice';

const EXIT_OK = 0;
const UTF8 = 'utf8';
const BASH_ALLOW_PATTERN = /^Bash\((.+):\*\)$/u;
const WHITESPACE_PATTERN = /\s+/u;
const GATE_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const GATE_CMD_NEWLINE_PATTERN = /[\r\n]/u;
const GATE_KEYS = Object.freeze(['id', 'title', 'cmd']);
// The ONE optional gate key (the coverage-producer marker), accepted here for the same reason every
// other shape rule is restated: a declaration the RUNNER accepts must never be rejected here, or a
// marker-carrying project would silently lose auto-approval on gates the runner runs happily.
const LCOV_PRODUCER_KEY = 'lcovProducer';
const ALLOWED_GATE_KEYS = Object.freeze([...GATE_KEYS, LCOV_PRODUCER_KEY]);
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
      if (!ALLOWED_GATE_KEYS.includes(key)) return invalid;
    }
    for (const key of GATE_KEYS) {
      if (typeof gate[key] !== 'string' || gate[key].trim() === '') return invalid;
    }
    if (gate[LCOV_PRODUCER_KEY] !== undefined && typeof gate[LCOV_PRODUCER_KEY] !== 'boolean') return invalid;
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

// Read the opt-in read-lane toggle LIVE per call — the gates.json live-read pattern, over the
// SEPARATE kit-owned docs/ai/lanes.json (Decisions 5). Fail-closed: an absent / unreadable /
// malformed / non-object file, or a `readLane` that is not the boolean literal `true`, leaves the
// lane DARK (returns false → rung (c) never fires; rungs (a)/(b) unaffected). Only an explicit
// `{ "readLane": true }` opens the lane. A PRE-1.48 placed hook never calls this, so enabling the
// lane against a stale placed copy is simply a no-op (the gate-hook writer's currency check makes
// that loud at consent time).
export const readReadLaneEnabled = (projectRoot, deps = {}) => {
  const readFile = deps.readFile ?? readFileSync;
  if (typeof projectRoot !== 'string' || projectRoot === '') return false;
  try {
    const parsed = JSON.parse(readFile(join(projectRoot, LANES_REL), UTF8));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return parsed[READ_LANE_KEY] === true;
  } catch {
    return false;
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

// Kit tools whose invocations rung (b) scans even though they are NOT in the seeded read-only core.
// The distinction is deliberate and load-bearing: CORING one of these would also hand it the
// rung (c) read-lane allow, which is exactly what a tool taking caller-supplied arguments must not
// have. This SEPARATE list buys the residual coverage without that side effect.
//
// AD-079 line: this is the SAME unchanged scan run over a different prefix — it never asks what a
// byte MEANS, so it is on the permitted side. Nothing here parses or deletes a span.
// KIT-QUALIFIED, forward-slash canonical. Matching on the bare basename was the first attempt and
// review killed it: it would pull ANY unrelated `repo-search.mjs` into rung (b2), turning a
// pre-existing NO decision into an ASK — a change to a decision path this release has no business
// touching.
// The RECOVERY is per tool, not a constant. When repo-search was the only entry the reason named the
// literal `--pattern-file`, and that was wrong the moment a second tool joined: wrong for a tool with
// no such flag, and already incomplete for repo-search itself once its TARGET half gained a lane. An
// ask whose named recovery does not exist is worse than an ask with no advice, so the advice is
// derived from whichever tool matched.
export const SCANNED_TOOL_LANES = Object.freeze({
  'agent-workflow-kit/tools/repo-search.mjs': '--pattern-file / --paths-file',
  'agent-workflow-kit/tools/path-inventory.mjs': '--paths-file',
});
export const SCANNED_TOOL_PATHS = Object.freeze(Object.keys(SCANNED_TOOL_LANES));

// Quotes stripped and separators canonicalised, so a relative, absolute, quoted or Windows-separated
// spelling all compare the same. SUBSTRING, not equality, and scanned across EVERY token rather than
// just the one after `node`: both reviewers found the strict form under-inclusive, one through node
// flags (`node --no-warnings <tool>`), one through an operator attached to the path
// (`node <tool>>out`). A missed invocation silently restores the unscanned behaviour on exactly the
// surface this exists to cover, while a spurious match merely over-asks — so inclusiveness wins.
const canonicalToken = (token) => token.replace(/["']/gu, '').replace(/\\/gu, '/');

export const matchScannedToolPrefix = (command) => matchScannedTools(command)[0] ?? null;

// ALL matches, not just the first. A command naming two scanned tools would otherwise be advised
// about whichever happens to sit earlier in the registry, and the residual may belong to the other.
export const matchScannedTools = (command) => {
  const tokens = tokenizeCommand(command).map(canonicalToken);
  return SCANNED_TOOL_PATHS.filter((path) => tokens.some((token) => token.includes(path)));
};

// String-level, conservative: the hook sees the PRE-SHELL command string, so every class is a raw
// substring scan (never a whitespace-token check — a token check misses `"--output=f"` / `'>' f`
// where the quotes are still in the string but the shell will strip them). A quoted metacharacter
// or write flag may over-ASK, never under-allow (no shell parsing in a dependency-free hook).
// Word-construction — quoting (`"`/`'`), backslash, brace, glob (`[]`/`{}`/`*`/`?`) — can splice a
// residual token back together AFTER a raw substring scan: `--out"put"=f` / `--outpu[t]=f` /
// `--out{put}=f` all collapse to `--output=f` when Bash strips the construction (council R2-M1). The
// scan re-runs against a DE-SPLICED copy (those characters removed) so a settings-allowed SINGLE
// carrying such a reconstruction still trips. De-splicing only ever ADDS matches — over-ASK, the safe
// direction (rung (c) forbids every construction character per segment, so this guards rung (b) singles).
const WORD_CONSTRUCTION_CHARS = /["'\\[\]{}*?]/gu;

// THREE MECHANISMS WERE BUILT TO NARROW THIS SCAN AND ALL THREE WERE REMOVED (AD-079). They are
// recorded here because each died to a DIFFERENT counterexample, and together they say something
// the next attempt needs: this hook cannot decide what a redirection byte MEANS — not by parsing
// it, and not even by deleting it — because JavaScript's idea of a token boundary and bash's do not
// agree. Each counterexample was verified LIVE, each ships as a test, and each was removed on a
// stop rule declared to the reviewing bridge BEFORE the round that met it.
//   1. A quote/escape-aware ACTIVE VIEW, so a `>` inside a search pattern would stop reading as an
//      operator. Defeated by HEREDOCS: their bodies are not shell code, and one quote in each of
//      TWO bodies opens a spurious span and later closes it, with a genuinely active `$(…)` sitting
//      BETWEEN them. The walker ends balanced, so the ambiguity fallback never engages, and the
//      guard goes silent on a nested command. Exact sequence: the test below.
//   2. An fd-DUPLICATION exemption (`2>&1` writes nothing). Defeated by a missing token boundary:
//      `>&word` duplicates only when the word is a bare number, and `grep x f >&12file` writes the
//      FILE `12file`, whose `>&12` prefix the pattern deleted.
//   3. A NULL-DEVICE exemption (a redirect into `/dev/null` writes nothing), with a boundary this
//      time. Defeated by U+00A0: JavaScript `\s` counts a no-break space as a boundary and bash does
//      not, so `grep x f >/dev/null<U+00A0>sink` names the FILE `/dev/null<U+00A0>sink` and the span
//      was deleted anyway.
// What survives is the original scan, unchanged, plus `>(` named in the substitution class where it
// belongs. The over-asks stay — a `>` that is ordinary text, and an fd duplication — and they are
// documented as open rather than papered over. AD-078's lesson, now one layer deeper: on an ASK rung
// an incomplete scan merely over-asks, which is safe; every attempt to make it exact has been a
// claim about bash that a dependency-free string scanner is not in a position to make.
export const detectResidualClasses = (command) => {
  const deSpliced = command.replace(WORD_CONSTRUCTION_CHARS, '');
  const scan = (form) => command.includes(form) || deSpliced.includes(form);
  const classes = [];
  if (RESIDUAL_FORMS.writeRedirections.some(scan)) classes.push(RESIDUAL_CLASS_REDIRECTION);
  if (RESIDUAL_FORMS.commandSubstitutions.some(scan)) classes.push(RESIDUAL_CLASS_SUBSTITUTION);
  if (RESIDUAL_FORMS.boundedWriteFlags.some(scan)) classes.push(RESIDUAL_CLASS_OUTPUT_FLAG);
  if (RESIDUAL_FORMS.lineContinuations.some(scan)) classes.push(RESIDUAL_CLASS_CONTINUATION);
  return classes;
};

// ── read-lane classifier (ladder c; Decisions 6-8) ────────────────────────────────────
// The opt-in read-lane's closed-world allow: a command is lane-safe ONLY when it is a compound (or
// single) of frozen read-only core commands with ZERO shell metaprogramming anywhere. Conservative
// by construction — any doubt returns false (no decision; the command keeps today's flow, the hook
// still never denies). The lane is BOUNDED BY THE FROZEN AUDITED read-only core (the set velocity
// seeds) — a standalone opt-in grant, never a command OUTSIDE that audited core. Enabling it
// auto-approves compounds (and singles) of that audited core REGARDLESS of which of those commands
// the user seeded as individual settings rules (the opt-in consent covers exactly the audited core,
// not strictly a subset of the current settings).

// Documented command separators (bash / Claude Code): the split points between independently-run
// segments. Longest-first so `&&`/`||`/`|&` win over the bare `|`; newline + CR included. No capture
// groups → `String.split` drops the separators. A bare `&` (backgrounding) is deliberately ABSENT
// here — it is caught as a forbidden per-segment character (so `ls & grep x` never rides the lane).
const LANE_SEPARATOR_PATTERN = /&&|\|\||\|&|;|\||\n|\r/u;

// Any of these characters in a post-split SEGMENT puts the whole command OUTSIDE the lane:
// expansion (`$`), substitution (backtick), quoting (`"` `'`), backslash splice (`\`), brace
// expansion (`{` `}`), glob (`*` `?` `[` `]`), redirection/subshell (`<` `>` `(` `)`),
// home/history/comment (`~` `!` `#`), and a leftover backgrounding/pipe operator (`&` `|`). The
// word-construction vectors (quote/backslash/brace/glob) are closed CONSERVATIVELY here — each can
// reconstruct a write/exec token after a raw scan (Decisions 7; the council B1 fold added the glob
// character-class brackets `[`/`]` after `--outpu[t]=f` was shown to reconstruct `--output`). The
// multi-char `--output` write flag is caught by detectResidualClasses over the raw string, not here.
const LANE_FORBIDDEN_SEGMENT_CHARS = Object.freeze([
  '$', '`', '"', "'", '\\', '{', '}', '*', '?', '[', ']', '<', '>', '(', ')', '~', '!', '#', '&', '|',
]);

const hasForbiddenSegmentChar = (segment) => LANE_FORBIDDEN_SEGMENT_CHARS.some((ch) => segment.includes(ch));

// True iff every separator-split segment is a non-empty, metacharacter-free, frozen read-only core
// command. Quote-BLIND by design (the splitter never interprets quotes): over-splitting can only
// REDUCE the set of allowed commands, never widen it. An empty segment (adjacent/leading/trailing
// separator) never allows; a residual anywhere over the raw string (redirection, `$(`/backtick/`<(`,
// funsub, `--output`) takes the command out of the lane before the split even runs.
export const isReadLaneCommand = (command) => {
  const trimmed = command.trim();
  if (trimmed === '') return false;
  if (detectResidualClasses(trimmed).length > 0) return false;
  return trimmed.split(LANE_SEPARATOR_PATTERN).every((segment) => {
    const seg = segment.trim();
    if (seg === '') return false;
    if (hasForbiddenSegmentChar(seg)) return false;
    return matchSeededCorePrefix(seg) !== null;
  });
};

// ── the caller-facing hint (rides an ask; refuses nothing) ────────────────────────────
//
// WHY THIS EXISTS, AND WHY IT IS NOT A DENY. An ask is answered by the HUMAN: `permissionDecisionReason`
// is context for THEIR dialog and never reaches the caller that composed the command. So for the whole
// life of this guard it has known the right lane and had no way to say it — which is the single reason
// every withdrawn deny design looked attractive, since a deny is refusal-shaped and does reach the
// caller. `additionalContext` is the same channel without the refusal. Probed live on 2026-07-28 with
// a throwaway hook: a distinct marker was delivered to the model on `allow`, on `ask`, AND on no
// decision at all.
// FAIL-SAFE BY CONSTRUCTION: a host that does not honour the field simply drops it, which is exactly
// the behaviour that existed before — silence. Nothing is refused, so a hint that is wrong for a
// particular command costs the caller a sentence, never their work. That is the property no deny
// design could ever claim.
export const HINT_CORE = 'agent-workflow: this read left the promptless lane — a plain read-only command with no redirection, no banner and no quotes stays inside it. If the byte is a decoration you do not need, drop it and re-issue; if it is ordinary text inside an argument, a search belongs in `repo-search.mjs` (`--pattern-file`), and several path questions (exists / size / line count / listing / small-file contents) are ONE `path-inventory.mjs` call. If the byte is a deliberate operator, keep it and confirm by hand.';

// The hint must not GUESS which of the two causes produced the residual — the guard cannot tell a
// byte that is ordinary text inside an argument from a real shell operator, and pretending otherwise
// is the exact claim AD-079 closed. So it names BOTH recoveries and lets the caller pick: the one
// that fits is always present, and the one that does not costs a clause.
// The hint never tells the caller to delete an operator it cannot read the intent of: dropping a
// real `> report.json` would change what the command DOES, and a guard that silently edits meaning is
// the failure this whole area was built to avoid. It names the out-of-band lane, notes that these
// tools already bound and print their own result (so a decoration is usually redundant), and leaves a
// deliberate operator to the human confirmation that already exists.
const hintForScannedTools = (tools) => {
  const lanes = tools.map((tool) => `\`${tool}\` → ${SCANNED_TOOL_LANES[tool]}`).join('; ');
  return `agent-workflow: the residual guard stopped this. If the byte is part of an ARGUMENT, pass it out of band — ${lanes} — and its bytes then never enter the command string, so this guard has nothing to scan (whether the clean form still prompts depends on your settings allow rules, which this hook does not read). If the byte is a decoration you do not need, drop it: these tools bound and print their own result. If it is a deliberate operator, keep it and confirm by hand — that is what the prompt is for.`;
};

// ── the decision ladder (pure core) ───────────────────────────────────────────────────

export const decideBashCall = ({ command, permissionMode, cwdIsProjectRoot, gates, readLaneOn = false }) => {
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
        additionalContext: HINT_CORE,
      };
    }
  }
  // (b2) the same guard over the scanned kit tools. The refusal NAMES the lane that avoids it, so a
  // caller who picked the inline lane for a shell-significant pattern is corrected by the mechanism
  // rather than expected to have remembered the rule.
  const scannedTools = matchScannedTools(trimmed);
  if (scannedTools.length > 0) {
    const residualClasses = detectResidualClasses(trimmed);
    if (residualClasses.length > 0) {
      const named = scannedTools.map((tool) => `"${tool}"`).join(' + ');
      const lanes = [...new Set(scannedTools.map((tool) => SCANNED_TOOL_LANES[tool]))].join(' / ');
      return {
        permissionDecision: DECISION_ASK,
        permissionDecisionReason: `agent-workflow residual guard: ${named} carries ${residualClasses.join(' + ')} — pass the byte-carrying argument out of band with ${lanes} (its bytes then never enter the command string), or confirm by hand if the byte is really part of the invocation`,
        additionalContext: hintForScannedTools(scannedTools),
      };
    }
  }
  // (c) read-lane allow — opt-in (lanes.json), mode-fenced like (a) but cwd-agnostic (a read is a
  // read from any directory). Runs AFTER (b), so a residual-carrying core command still ASKs.
  if (readLaneOn === true && ALLOW_PERMISSION_MODES.includes(permissionMode) && isReadLaneCommand(trimmed)) {
    return {
      permissionDecision: DECISION_ALLOW,
      permissionDecisionReason: `agent-workflow read-lane: every command segment is a frozen read-only core prefix with no shell metaprogramming — auto-approved (opt-in ${LANES_REL})`,
    };
  }
  // (d) no decision — the normal permission flow proceeds unchanged.
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
    readLaneOn: readReadLaneEnabled(projectRoot, deps),
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
