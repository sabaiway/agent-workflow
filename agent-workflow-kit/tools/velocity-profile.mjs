import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// The --autonomy render reads the per-project autonomy policy through the read-only autonomy core
// (AD-044). This file is the family's one .claude/settings.json writer, so the policy render lives here;
// it never imports the policy fs-writer (autonomy-write.mjs) — the render owns the settings file, not
// the policy file.
import { AUTONOMY_REL, loadAutonomy, resolveAutonomy, COMMAND_REDLINES } from './autonomy-config.mjs';
// The bridge-wrappers tier's placement probe (AD-044 Plan 4, Decision 2): a tier entry derives ONLY
// for a PLACED bridge wrapper — findOnPath is the same read-only PATH scan the backend detector uses.
import { findOnPath } from './detect-backends.mjs';

// Velocity-profile core + writer: a fixed, audited read-only allowlist that an onboarding step seeds
// into `.claude/settings.json` so routine read-only commands stop idling on approval prompts.
//
// Load-bearing invariant: the seeded allowlist must NEVER permit `git commit` / `git push` /
// `npm publish` — commit stays the single human approval checkpoint.

// Deployment-lineage head this velocity build targets; bump together with agent-workflow-memory
// LINEAGE_HEAD when the deployed docs/ai structure changes.
export const EXPECTED_WORKFLOW_VERSION = '2.0.0';
export const SETTINGS_FILE = '.claude/settings.json';
export const SETTINGS_LOCAL_FILE = '.claude/settings.local.json';
export const CLAUDE_DIR = '.claude';
export const WORKFLOW_STAMP = 'docs/ai/.workflow-version';
export const SAFE_DEFAULT_MODES = Object.freeze(['default', 'acceptEdits', 'plan']);
export const UNSAFE_BYPASS_MODE = 'bypassPermissions';
export const ACCEPT_EDITS_MODE = 'acceptEdits';

// The audited read-only core. Every entry is a Claude Code Bash allow pattern whose command runs NO
// mutating operation and NO inline arbitrary code execution through its OWN flags (verified
// empirically, not assumed) — the only own-flag residual is a bounded WRITE via `--output`
// (git diff/log/show). (The SEPARATE settings-level residual — redirection writes + command
// substitution exec — is a property of Claude Code's allow-rule parsing, documented at
// SHELL_METACHARACTERS below.) Commands with an inline write/exec flag are deliberately EXCLUDED, e.g. `git grep`
// (`--open-files-in-pager=<cmd>` runs a program), `sort` (`-o` writes, `--compress-program=<cmd>`
// runs a program), `echo`/`find` (redirect-/`-delete`-writable), `gh` (`gh api` can POST),
// `node`/`npx`/`npm run`/`npm install`/`npm pack` (arbitrary/lifecycle code), bare `git`/`npm`.
// `git diff`/`git log`/`git show` are kept: their only residual is a BOUNDED WRITE via
// `--output=<file>` (the same category as shell output redirection, documented below), not code
// execution — inline `--ext-diff` exec needs a `-c diff.external=` / env prefix that breaks the
// allow-pattern match.
export const UNIVERSAL_READONLY_ALLOWLIST = Object.freeze([
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

// Per-tool POSITIVE allowlists, as frozen arrays. NOTE: `Object.freeze` on a Set does NOT prevent
// `.add()` (it only freezes own properties), so an exported frozen Set could be mutated at runtime to
// widen the screen — frozen arrays + `.includes()` are genuinely immutable in ESM strict mode.
export const GIT_READONLY_SUBCOMMANDS = Object.freeze([
  'status',
  'diff',
  'log',
  'show',
  'ls-files',
  'check-ignore',
  'branch --list',
  'rev-parse',
  'blame',
  'shortlog',
  'describe',
  // `git cat-file` is deliberately ABSENT (diff-council fold, AD-040): `--textconv`/`--filters`
  // activate CONFIGURED external filters under an auto-approved command, and its read utility is
  // marginal next to the kept `git show`.
  // Fixed read-only forms ONLY — the bare `git tag` / `git stash` / `git worktree` forms mutate
  // (probe-proven, AD-040), the same multi-token precedent as 'branch --list'.
  'tag --list',
  'stash list',
  'worktree list',
]);
export const NPM_READONLY_SUBCOMMANDS = Object.freeze(['view', 'ls', 'outdated']);
export const SHELL_READONLY = Object.freeze([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'readlink',
  'which',
  'grep',
  // AD-040 audit survivors. `file` deliberately FAILED the audit (`-C -m <magic>` compiles a magic
  // FILE WRITE — probe-proven) and stays a hand-add candidate only. `diff -l/--paginate` execs `pr`
  // by a build-time FIXED absolute path (probed NOT PATH-resolved) — not arbitrary exec, kept.
  'diff',
  'stat',
  'du',
  'basename',
  'dirname',
  'realpath',
]);

// ── the opt-in --kit-tools tier (AD-040) ────────────────────────────────────────────────
// A SEPARATE frozen tier, never an extension of UNIVERSAL_READONLY_ALLOWLIST: the core stays the
// hook-parity surface (test/gate-hook-core-parity.test.mjs), while tier entries are derived at
// seed time from the RUNNING tool's own location — resolved-absolute, so a moved or reinstalled
// skill leaves a stale rule that FAIL-SAFE prompts again (never a silent widening).
//
// Membership (10, frozen): the read-only kit tools plus run-gates.mjs — which is NOT read-only but
// project-exec (it runs the project's OWN declared gates.json commands), so it seeds as ONE exact
// byte-string pinned to this project root (`--cwd <resolved root>`): a wildcard would be BROADER
// than the AD-037 hook boundary (`--cwd <dir>` executes an arbitrary OTHER project's gates.json)
// and a cwd-defaulting entry would follow the shell's current directory into subdirs. NEVER the
// writers. review-state.mjs's read-only git spawns are in-scope read-only.
export const KIT_RUN_GATES_TOOL = 'tools/run-gates.mjs';
export const KIT_READONLY_TOOLS = Object.freeze([
  'tools/recipes.mjs',
  'tools/procedures.mjs',
  'tools/family-registry.mjs',
  'tools/detect-backends.mjs',
  'tools/commands.mjs',
  'tools/review-state.mjs',
  'tools/recommendations.mjs',
  KIT_RUN_GATES_TOOL,
  'tools/manifest/validate.mjs',
  'tools/release-scan.mjs',
]);
// Writer previews: ONLY writers whose ARG-FREE invocation is a documented dry-run ("Default is
// --dry-run" in their usage) seed an EXACT preview byte-string — every --apply/--write/--yes keeps
// its prompt. set-recipe is excluded (its preview takes variable --set ops); setup-backends and
// hide-footprint are excluded (their arg-free forms APPLY); uninstall is excluded (a guarded
// teardown documents --dry-run explicitly — its bare form is not its preview contract).
export const KIT_WRITER_PREVIEW_TOOLS = Object.freeze([
  'tools/velocity-profile.mjs',
  'tools/cheap-agents.mjs',
  'tools/gate-hook.mjs',
]);
const KIT_WILDCARD_TOOLS = Object.freeze(KIT_READONLY_TOOLS.filter((rel) => rel !== KIT_RUN_GATES_TOOL));
// The kit root this tool runs from (tools/..) — the tier's seed-time path anchor.
const KIT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const KIT_TOOL_INVOKER = 'node';
const RUN_GATES_CWD_FLAG = '--cwd';

// ── the opt-in --bridge-tier (AD-044 Plan 4, Decision 2) ────────────────────────────────
// The FROZEN membership source: review-role wrapper NAMES only, spelled bare — that is how the
// wrappers are invoked (setup-backends places them as symlinks in ~/.local/bin). Roles come from
// THIS constant, never from the detector's wrapperCmds (which carries no role labels): codex-exec
// (execution role) and agy-run (probe role) are deliberately ABSENT. The velocity pain this tier
// closes is council REVIEW runs; codex-exec's nested-sandbox recovery is handled the canon way —
// route it outside ON the OBSERVED failure (orchestration.md §5), NOT a preemptive tier seed (AD-054
// final council: a blanket exclusion at opt-in contradicts «never a preemptive blanket»), guided by
// codex-exec.sh's own nested-sandbox detection hint.
export const BRIDGE_REVIEW_WRAPPERS = Object.freeze(['codex-review', 'agy-review']);
// Only the `code` review mode is auto-allowed (codex R2, Segment A): a bare `Bash(<wrapper>:*)`
// prefix would also cover the plan/diff file-argument modes, whose targets can point OUTSIDE the
// repo — the tier's stated surface is the unattended council CODE review, so the seeded prefix is
// `<wrapper> code`. Plan/diff invocations keep their prompt.
export const BRIDGE_REVIEW_MODE = 'code';
// The grounding pre-step tool (the reviews' facts assembler). Its tier entry is seeded in the
// EXACT byte-form the procedures advisor renders — a DOUBLE-QUOTED absolute path (deliberate
// there: a skill dir with a space must stay copy-pasteable) — so seeded↔rendered byte-parity
// holds; the screen accepts the quoted form ONLY for this one tool (a tier-scoped acceptance,
// never a general quote allowance).
export const KIT_GROUNDING_TOOL = 'tools/grounding.mjs';
const WRAPPER_PLACED = 'present';

// The quoted-grounding token: "<seedable-abs-path>/tools/grounding.mjs" — quotes stripped, the
// inner path must itself be seedable and end on the grounding tail. No other node tool may ride
// this class (a NEGATIVE screen pin).
const isQuotedGroundingToken = (token) => {
  if (typeof token !== 'string' || token.length < 3 || !token.startsWith('"') || !token.endsWith('"')) return false;
  const inner = token.slice(1, -1);
  return isSeedablePathToken(inner) && inner.endsWith(`/${KIT_GROUNDING_TOOL}`);
};

/**
 * Derive the opt-in bridge-wrappers tier: one code-mode allow rule per PLACED review wrapper (the
 * frozen constant is the membership source; placement is a probe, never a role source), the SAME
 * wrapper names for sandbox.excludedCommands (the harness runs an excluded command OUTSIDE the
 * sandbox, so a plain allowlisted invocation needs no sandbox-bypass approval — the zero-prompt
 * wiring), and the grounding pre-step rule in its rendered quoted byte-form (derived only when
 * agy-review is placed; an unseedable kit path is a stated skip). An absent bridge is a stated skip.
 */
export const deriveBridgeTierAllowlist = ({ findWrapper, groundingAbsPath } = {}) => {
  const probe = findWrapper ?? ((cmd) => findOnPath(cmd).state === WRAPPER_PLACED);
  const placed = BRIDGE_REVIEW_WRAPPERS.filter((cmd) => probe(cmd));
  const skips = BRIDGE_REVIEW_WRAPPERS.filter((cmd) => !placed.includes(cmd)).map((cmd) => ({
    entry: cmd,
    reason: `bridge wrapper "${cmd}" is not placed on PATH — its allow rule is not seeded (place the bridge with /agent-workflow-kit setup, then re-run)`,
  }));
  const allow = placed.map((cmd) => `Bash(${cmd} ${BRIDGE_REVIEW_MODE}:*)`);
  const excludedCommands = [...placed];
  // The grounding pre-step exists FOR agy (its grounded --facts reviews; codex grounds natively via
  // the AGENTS.md auto-merge) — a codex-only install must not auto-allow an unused writer (codex R9).
  if (placed.includes('agy-review')) {
    // groundingAbsPath is a TEST seam only (an unseedable kit path — spaces — is not constructible
    // from a test against the real checkout); production callers never pass it.
    const groundingAbs = groundingAbsPath ?? join(KIT_ROOT, KIT_GROUNDING_TOOL);
    if (isSeedablePathToken(groundingAbs)) {
      allow.push(`Bash(${KIT_TOOL_INVOKER} "${groundingAbs}":*)`);
    } else {
      skips.push({
        entry: groundingAbs,
        reason: 'the kit path is not a POSIX absolute path free of spaces/metacharacters/quoting — the grounding pre-step rule is not seeded (its prompt stays); add a hand-picked entry if you accept the spelling',
      });
    }
  }
  return Object.freeze({ allow: Object.freeze(allow), excludedCommands: Object.freeze(excludedCommands), skips: Object.freeze(skips), placed: Object.freeze(placed) });
};

// Characters that make a pattern NOT a single read-only command, so the screen rejects them.
// Per current Claude Code permission semantics: the recognized command SEPARATORS are
// `&& || ; | |& &` plus newline (each segment must be independently permitted, so a chained
// `&& git push` is denied). BUT redirections (`>`/`>>`) are NOT separators, and command
// substitution `$(...)`/backticks are NOT a documented separator either (the published docs are
// silent on whether substitution is extracted and independently permission-checked — treated here
// as the worst case: NOT extracted). So a seeded read-only prefix can still WRITE via `cmd > file`,
// and via substitution `cmd $(other-cmd)` could even RUN another command. The screen rejects any
// seed pattern carrying these metacharacters so the SEEDED patterns are always single read-only
// commands; but the RUNTIME residual (redirection, command substitution, a kept command's own
// `--output=<file>` write flag) means a seeded read-only entry is a TRUST-POSTURE convenience, NOT
// a sandbox. velocity never ADDS commit/push/publish as allow rules and keeps acceptEdits opt-in;
// runtime closure is not something settings-level allow rules can enforce — the residual guard
// ships as the opt-in PreToolUse hook (Mode: hook, tools/gate-hook.mjs; probe record in AD-037).
export const SHELL_METACHARACTERS = Object.freeze([
  '&', '|', ';', '<', '>', '$', '`', '(', ')',
  '\n', '\r', '\t', '\\', '{', '}', '*', '?', '#', '~', '!',
]);

// The RUNTIME residual documented above, as data: the exact write-redirection / command-
// substitution / bounded write-flag forms a settings-level allow rule cannot see. Consumed by
// the PreToolUse gate hook's residual guard — the placed hook (references/hooks/gate-approve.mjs)
// bakes a frozen COPY (a placed file cannot import the kit), drift-guarded by
// test/gate-hook-core-parity.test.mjs alongside UNIVERSAL_READONLY_ALLOWLIST.
export const RUNTIME_RESIDUAL_FORMS = Object.freeze({
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

export const VELOCITY_OFFCORE = 'VELOCITY_OFFCORE';
export const VELOCITY_NON_READONLY = 'VELOCITY_NON_READONLY';
export const VELOCITY_INVALID_ARGUMENT = 'VELOCITY_INVALID_ARGUMENT';
export const VELOCITY_STAMP = 'VELOCITY_STAMP';
export const VELOCITY_UNSAFE_MODE = 'VELOCITY_UNSAFE_MODE';
export const VELOCITY_MALFORMED = 'VELOCITY_MALFORMED';
export const VELOCITY_SYMLINK = 'VELOCITY_SYMLINK';
// The --autonomy render refuses an absent policy file (a writer renders only a declared policy).
export const VELOCITY_NO_POLICY = 'VELOCITY_NO_POLICY';

const VELOCITY_ERROR_NAME = 'VelocityProfileError';
const ERROR_PREFIX = '[agent-workflow-kit]';
const BASH_ALLOW_PATTERN = /^Bash\((.+):\*\)$/u;
// The EXACT (non-wildcard) allow form `Bash(cmd)` — tier-only (run-gates + writer previews); the
// git/npm/shell core classes stay wildcard-only so the pre-existing advisory behavior never shifts.
const BASH_EXACT_ALLOW_PATTERN = /^Bash\((.+)\)$/u;
const BASH_PERMISSION_PATTERN = /^Bash\(.+\)$/u;
const WHITESPACE_PATTERN = /\s+/u;
const GIT_COMMAND = 'git';
const NPM_COMMAND = 'npm';
const NPM_RUN_COMMAND = 'npm run';
const PACKAGE_FILE = 'package.json';
const SETTINGS_JSON_INDENT = 2;
const EXIT_USAGE = 2;
const EXIT_PRECONDITION = 1;
const EXIT_OK = 0;
const ENOENT = 'ENOENT';
const UTF8 = 'utf8';
const LF = '\n';
const CRLF = '\r\n';
const JSON_NEWLINE_PATTERN = /\n/gu;
const FLAG_DRY_RUN = '--dry-run';
const FLAG_APPLY = '--apply';
const FLAG_ACCEPT_EDITS = '--accept-edits';
const FLAG_KIT_TOOLS = '--kit-tools';
const FLAG_BRIDGE_TIER = '--bridge-tier';
const FLAG_AUTONOMY = '--autonomy';
const FLAG_CHECK = '--check';
const FLAG_CWD = '--cwd';
const FLAG_HELP = '--help';
const SHORT_FLAG_HELP = '-h';
const DO_NOT_ADD_WARNING = 'do not add';
const ADD_BY_HAND = true;
const MUTATING_SCRIPT_NAME_PATTERN = /(release|publish|deploy|push|version|commit|tag)/iu;
const MUTATING_SCRIPT_HOOK_PATTERN = /^(pre|post)/iu;
// The one thing velocity must never seed — an explicit, greppable expression of the load-bearing
// invariant (kept deliberately even though the read-only screen already rejects these, so the
// refusal is named, tested, and produces a clear message).
const MUTATING_ALLOW_COMMAND_PATTERN = /^(?:git\s+(?:commit|push)|npm\s+publish)(?:\s|$)/iu;
const RESIDUAL_NOTICE =
  'residual: seeded read-only allow entries are a trust-posture convenience, NOT a sandbox; settings-level rules cannot inspect runtime redirection/command-substitution/--output writes; commit/push/publish are never allowlisted (a DIRECT invocation still ASKs, but the runtime residual is not closed here); the residual guard ships as the opt-in PreToolUse hook — Mode: hook (/agent-workflow-kit hook). floor (never auto-approved, with or without the tier): every writer --apply/--write/--yes still prompts; clobber-protection STOPs still stop; the three release asks (commit/push/publish) stay maintainer-owned.';

const USAGE = `usage: velocity-profile [--dry-run | --apply] [--kit-tools] [--bridge-tier] [--accept-edits] [--cwd <dir>] [--help]
       velocity-profile --autonomy [--apply] [--cwd <dir>]        (render the autonomy policy)
       velocity-profile --autonomy --check [--cwd <dir>]          (read-only drift gate)

Allowlist mode (default): seeds the fixed read-only Claude Code allowlist into .claude/settings.json.
Default is --dry-run. --apply writes; --accept-edits only sets defaultMode when applying.
--kit-tools additionally seeds the audited kit-tool tier: 9 read-only kit tools by resolved
absolute path (args wildcard), run-gates.mjs as ONE exact project-root-pinned byte-string
(project-exec - it runs YOUR declared gates.json), and the writers' exact arg-free dry-run
preview byte-strings. Never touches settings.local.json.
--bridge-tier (own consent) seeds the bridge REVIEW wrappers' CODE mode for PLACED bridges
(codex-review code, agy-review code - never the execution/probe wrappers, never plan/diff modes)
+ the quoted grounding pre-step rule, and the wrapper names into sandbox.excludedCommands (they
need network - the harness runs them outside the sandbox). Consented posture: an auto-allowed
review wrapper runs UNATTENDED and sends the assembled repo payload to its subscription backend
(see the printed tier notice).

--autonomy renders docs/ai/autonomy.json into the settings blocks it OWNS — the sandbox block +
permissions.ask/deny red-lines + permissions.defaultMode. POLICY-ONLY: never seeds the allowlist and
leaves permissions.allow untouched. Preview by default; --apply writes; --check is a read-only drift
gate (exit 1 on drift). --autonomy cannot combine with --accept-edits, --kit-tools, or --bridge-tier
(allowlist-mode flags). Refuses an absent policy (seed one first with set-autonomy). Never touches
settings.local.json.`;

const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

export const makeVelocityProfileError = (code, message, fields = {}) =>
  Object.assign(new Error(`${ERROR_PREFIX} ${message}`), { name: VELOCITY_ERROR_NAME, code, ...fields });

const fsDeps = (deps = {}) => ({
  exists: deps.exists ?? deps.existsSync ?? existsSync,
  lstat: deps.lstat ?? deps.lstatSync ?? lstatSync,
  mkdir: deps.mkdir ?? deps.mkdirSync ?? mkdirSync,
  readFile: deps.readFile ?? deps.readFileSync ?? readFileSync,
  writeFile: deps.writeFile ?? deps.writeFileSync ?? writeFileSync,
});

const lstatNoFollow = (absPath, fs) => {
  try {
    return fs.lstat(absPath);
  } catch (err) {
    if (err && err.code === ENOENT) return null;
    throw err;
  }
};

const relativeToCwd = (absPath, cwd) => (cwd ? relative(cwd, absPath) || '.' : absPath);

const isJsonObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const readFileLoud = (absPath, relPath, fs) => {
  try {
    return fs.readFile(absPath, UTF8);
  } catch (err) {
    throw makeVelocityProfileError(VELOCITY_MALFORMED, `${relPath}: unreadable (${err.code ?? err.message})`);
  }
};

const parseJsonLoud = (raw, relPath) => {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw makeVelocityProfileError(VELOCITY_MALFORMED, `${relPath}: malformed JSON (${err.message})`);
  }
};

const validateSettingsShape = (data, relPath) => {
  if (!isJsonObject(data)) {
    throw makeVelocityProfileError(VELOCITY_MALFORMED, `${relPath}: root must be a JSON object`);
  }
  if (data.permissions !== undefined && !isJsonObject(data.permissions)) {
    throw makeVelocityProfileError(VELOCITY_MALFORMED, `${relPath}: permissions must be a JSON object`);
  }
  if (data.permissions?.allow !== undefined && !Array.isArray(data.permissions.allow)) {
    throw makeVelocityProfileError(VELOCITY_MALFORMED, `${relPath}: permissions.allow must be an array`);
  }
  // The --autonomy render merges into permissions.ask / permissions.deny (arrays) and the top-level
  // `sandbox` object — a malformed one of these is a STOP with ZERO writes, never a merge-through-clobber
  // (the same precondition posture as permissions.allow above). The allowlist mode never touches these,
  // so this only tightens the autonomy path.
  if (data.permissions?.ask !== undefined && !Array.isArray(data.permissions.ask)) {
    throw makeVelocityProfileError(VELOCITY_MALFORMED, `${relPath}: permissions.ask must be an array`);
  }
  if (data.permissions?.deny !== undefined && !Array.isArray(data.permissions.deny)) {
    throw makeVelocityProfileError(VELOCITY_MALFORMED, `${relPath}: permissions.deny must be an array`);
  }
  if (data.sandbox !== undefined && !isJsonObject(data.sandbox)) {
    throw makeVelocityProfileError(VELOCITY_MALFORMED, `${relPath}: sandbox must be a JSON object`);
  }
  // The bridge tier merges into sandbox.excludedCommands — a malformed (non-array) value is a STOP
  // with ZERO writes (the same fail-closed posture as permissions.allow above), never a silent
  // treat-as-empty overwrite (codex R1, Segment A).
  if (isJsonObject(data.sandbox) && data.sandbox.excludedCommands !== undefined && !Array.isArray(data.sandbox.excludedCommands)) {
    throw makeVelocityProfileError(VELOCITY_MALFORMED, `${relPath}: sandbox.excludedCommands must be an array`);
  }
  return data;
};

const getPermissions = (data) => (isJsonObject(data?.permissions) ? data.permissions : {});

const getAllowEntries = (data) => {
  const allow = getPermissions(data).allow;
  return Array.isArray(allow) ? allow : [];
};

const getDefaultMode = (data) => {
  const permissions = getPermissions(data);
  return hasOwn(permissions, 'defaultMode')
    ? { present: true, value: permissions.defaultMode }
    : { present: false, value: undefined };
};

const hasShellMetacharacter = (cmd) => SHELL_METACHARACTERS.some((ch) => cmd.includes(ch));

const tokenizeCommand = (cmd) => cmd.trim().split(WHITESPACE_PATTERN).filter(Boolean);

const getSubcommand = (tokens) => tokens.slice(1).join(' ');

const getBashAllowCommand = (pattern) => {
  if (typeof pattern !== 'string') return undefined;
  const match = pattern.match(BASH_ALLOW_PATTERN);
  return match ? match[1] : undefined;
};

// Parse the exact (non-wildcard) form ONLY when the wildcard form does not match — `Bash(cmd:*)`
// would otherwise parse here as `cmd:*`.
const getBashExactCommand = (pattern) => {
  if (typeof pattern !== 'string' || BASH_ALLOW_PATTERN.test(pattern)) return undefined;
  const match = pattern.match(BASH_EXACT_ALLOW_PATTERN);
  return match ? match[1] : undefined;
};

// Characters that survive whitespace tokenization but break an UNQUOTED byte-exact path rule:
// shell quoting syntax and glob brackets (SHELL_METACHARACTERS owns the command-level separators/
// redirections/expansions — `*`/`?` globs included — but not these four).
const PATH_BREAKING_CHARACTERS = Object.freeze(["'", '"', '[', ']']);

// A path token that can be seeded UNQUOTED into a byte-exact allow rule: POSIX-absolute, no
// whitespace, no shell metacharacter, no quoting/glob syntax.
const isSeedablePathToken = (token) =>
  typeof token === 'string' &&
  token.startsWith('/') &&
  !/\s/u.test(token) &&
  !hasShellMetacharacter(token) &&
  !PATH_BREAKING_CHARACTERS.some((ch) => token.includes(ch));

// A tier path token must be SEEDABLE (a relative or shell-syntax-carrying spelling is a dead rule
// the screen refuses to bless) and end on a known tier-tool tail. Any seedable absolute prefix is
// accepted — the user's own kit copy elsewhere is legitimate shape-wise; entries OUTSIDE the
// derived tier are still flagged by the pre-existing advisory, and membership in the SEEDED set
// stays enforced separately by validateProfile's audited-set check.
const isKitToolPathToken = (token, relPaths) =>
  isSeedablePathToken(token) && relPaths.some((rel) => token.endsWith(`/${rel}`));

const isSingleShellToken = (cmd, tokens) => tokens.length === 1 && cmd === tokens[0];

const isScriptMap = (scripts) => Boolean(scripts) && typeof scripts === 'object' && !Array.isArray(scripts);

const isMutatingScriptName = (name) =>
  MUTATING_SCRIPT_NAME_PATTERN.test(name) || MUTATING_SCRIPT_HOOK_PATTERN.test(name);

// `scriptName` is ADDITIVE (AD-042): the seed-gates offer layer maps a candidate to a
// package-manager-aware `{ id, title, cmd }` and needs the raw script name for that derivation;
// `command` stays the advisory's own npm-run spelling (this fn is otherwise unchanged).
const makeGateCandidate = (name) => ({
  command: `${NPM_RUN_COMMAND} ${name}`,
  scriptName: name,
  addByHand: ADD_BY_HAND,
  ...(isMutatingScriptName(name) ? { warn: DO_NOT_ADD_WARNING } : {}),
});

const matchesMutatingAllowCommand = (entry) => {
  const cmd = getBashAllowCommand(entry);
  return Boolean(cmd) && MUTATING_ALLOW_COMMAND_PATTERN.test(cmd.trim());
};

const readStamp = (absPath, deps = {}) => {
  const fs = fsDeps(deps);
  try {
    if (!fs.exists(absPath)) return null;
    const stamp = String(fs.readFile(absPath, UTF8)).trim();
    return stamp.length ? stamp : null;
  } catch {
    // An unreadable stamp == not a valid deployment stamp; --apply STOPs ("found none") while
    // --dry-run stays usable on any project (the stamp is enforced only on the write path).
    return null;
  }
};

const readPackageJson = (cwd, deps = {}) => {
  const fs = fsDeps(deps);
  const absPath = join(cwd, PACKAGE_FILE);
  if (!fs.exists(absPath)) return null;
  // package.json feeds ONLY the read-only gate advisory — a malformed one degrades to "no
  // candidates"; it must NEVER block the settings write.
  try {
    return JSON.parse(fs.readFile(absPath, UTF8));
  } catch {
    return null;
  }
};

const assertClaudeDirSafe = (cwd, deps = {}) => {
  const fs = fsDeps(deps);
  const absPath = join(cwd, CLAUDE_DIR);
  const stat = (() => {
    try {
      return lstatNoFollow(absPath, fs);
    } catch (err) {
      throw makeVelocityProfileError(VELOCITY_SYMLINK, `${CLAUDE_DIR}: unreadable (${err.code ?? err.message})`);
    }
  })();
  if (stat === null) return { claudeDirAbsent: true };
  if (stat.isSymbolicLink()) {
    throw makeVelocityProfileError(VELOCITY_SYMLINK, `${CLAUDE_DIR} is a symlink - refusing to write through it`);
  }
  if (!stat.isDirectory()) {
    throw makeVelocityProfileError(VELOCITY_SYMLINK, `${CLAUDE_DIR} exists but is not a directory - refusing to write through it`);
  }
  return { claudeDirAbsent: false };
};

// A kit-tool-SHAPED entry (any `node …` allow entry, wildcard or exact) passes the shape screen on
// any absolute path — but only the entries the tier itself derives for THIS kit + THIS root are
// audited. Everything else `node`-shaped is arbitrary local JS / foreign project-exec and must
// stay flagged for hand review (diff-council fold, AD-040).
const isKitToolShapedCommand = (entry) => {
  const cmd = getBashAllowCommand(entry) ?? getBashExactCommand(entry);
  return cmd !== undefined && tokenizeCommand(cmd)[0] === KIT_TOOL_INVOKER;
};

// A bridge-tier-SHAPED entry (a bare frozen-tier wrapper wildcard, or the quoted-grounding form)
// passes the shape screen — but only the entries the tier derives for THIS host (its PLACED
// bridges + this kit's grounding path) are audited; an absent-bridge or foreign-path spelling
// stays flagged for hand review (the same derived-set discipline as the kit-tools tier).
const isBridgeTierShapedCommand = (entry) => {
  const cmd = getBashAllowCommand(entry);
  if (cmd === undefined) return false;
  const tokens = tokenizeCommand(cmd);
  return (
    BRIDGE_REVIEW_WRAPPERS.includes(tokens[0]) ||
    (tokens[0] === KIT_TOOL_INVOKER && tokens.length === 2 && isQuotedGroundingToken(tokens[1]))
  );
};

const collectPreExistingNonReadonly = (sources, derivedTier = [], derivedBridgeAllow = []) =>
  sources.flatMap(({ source, data }) =>
    getAllowEntries(data)
      .filter((entry) => typeof entry === 'string' && BASH_PERMISSION_PATTERN.test(entry))
      .filter(
        (entry) =>
          !screenAllowlistEntry(entry) ||
          // The quoted grounding rule is node-shaped AND bridge-tier-shaped: membership in EITHER
          // derived set exempts it — the advisory never flags an entry a tier itself seeds.
          (isKitToolShapedCommand(entry) && !derivedTier.includes(entry) && !derivedBridgeAllow.includes(entry)) ||
          (isBridgeTierShapedCommand(entry) && !derivedBridgeAllow.includes(entry)),
      )
      .map((entry) => ({ source, entry })),
  );

const assertTargetWritable = (absPath, deps = {}) => {
  const fs = fsDeps(deps);
  const stat = lstatNoFollow(absPath, fs);
  if (stat !== null && !stat.isFile()) {
    throw makeVelocityProfileError(
      VELOCITY_SYMLINK,
      `${SETTINGS_FILE} exists but is not a regular file - refusing to clobber it`,
    );
  }
};

const formatJson = (data, eol) => `${JSON.stringify(data, null, SETTINGS_JSON_INDENT).replace(JSON_NEWLINE_PATTERN, eol)}${eol}`;

const mergeProjectSettings = (projectData, toAdd, acceptEdits, excludedToAdd = []) => {
  const base = projectData ?? {};
  const permissions = getPermissions(base);
  const allow = getAllowEntries(base);
  const mergedAllow = [...allow, ...toAdd.filter((entry) => !allow.includes(entry))];
  const mergedPermissions = {
    ...permissions,
    allow: mergedAllow,
    ...(acceptEdits === true ? { defaultMode: ACCEPT_EDITS_MODE } : {}),
  };
  // The bridge tier's second surface: sandbox.excludedCommands (merge-don't-clobber — foreign
  // entries and sandbox sub-keys preserved; only the tier's wrapper names append, deduped). The
  // flagless/kit-tools paths pass no entries, so the sandbox block stays untouched for them.
  const existingSandbox = isJsonObject(base.sandbox) ? base.sandbox : {};
  const existingExcluded = Array.isArray(existingSandbox.excludedCommands) ? existingSandbox.excludedCommands : [];
  const newExcluded = excludedToAdd.filter((cmd) => !existingExcluded.includes(cmd));
  const sandboxBlock = newExcluded.length
    ? { sandbox: { ...existingSandbox, excludedCommands: [...existingExcluded, ...newExcluded] } }
    : {};
  return { ...base, permissions: mergedPermissions, ...sandboxBlock };
};

const formatEntryList = (entries) => (entries.length ? entries.map((entry) => `  - ${entry}`) : ['  - (none)']);

const formatAllowlist = (result) => [
  `${result.wrote ? 'added' : 'would add'} read-only core entries: ${result.toAdd.length}`,
  ...formatEntryList(result.toAdd),
  `already present: ${result.alreadyPresent.length}`,
];

// The tier's honest posture, printed on every --kit-tools run: run-gates is project-exec (never
// "read-only"), previews stay dry-run-only, and the tier gets none of the hook's residual ask-net.
const KIT_TIER_NOTICE =
  'kit-tools tier: paths are resolved absolute at seed time (fail-safe - a moved skill or stale path simply prompts again); run-gates.mjs is seeded as ONE exact byte-string pinned to this project root and is project-exec - it runs YOUR declared gates.json commands, never "read-only"; writer previews are exact dry-run byte-strings - every --apply/--write/--yes still prompts; tier entries get NO PreToolUse-hook residual coverage (settings-level posture only - see the velocity mode notes).';

const formatKitTier = (result) =>
  result.kitTools
    ? [
        `${result.wrote ? 'added' : 'would add'} kit-tools tier entries: ${result.tierToAdd.length}`,
        ...formatEntryList(result.tierToAdd),
        `already present (tier): ${result.tierAlreadyPresent.length}`,
        KIT_TIER_NOTICE,
      ]
    : [];

// The bridge tier's honest posture, printed on EVERY --bridge-tier run (test-pinned — the codex-R2
// informed-consent resolution): the exfiltration surface is stated, never pretended away.
export const KIT_BRIDGE_TIER_NOTICE =
  'bridge-wrappers tier: seeds the REVIEW wrappers only, and only their CODE mode (`codex-review code`, `agy-review code` — never codex-exec/agy-run: delegated execution keeps its human prompt; never the plan/diff modes: their file arguments can point outside the repo, so they keep their prompt), each derived ONLY when its bridge is PLACED on PATH, plus the grounding pre-step rule in its rendered quoted byte-form. POSTURE (what this consent covers): an auto-allowed review wrapper runs UNATTENDED — it reads any repo file it is pointed at and sends the assembled payload to its subscription backend, and prefix rules cannot inspect arguments, so a code-mode argument that names a readable file (agy\'s --facts/--decided) rides the same consent — the same documented residual class as the autonomy red-line rules; that is the tier\'s PURPOSE (unattended council review runs) and its residual — tier entries get NO PreToolUse-hook coverage. The grounding entry\'s writer surface is bounded by grounding.mjs\'s OWN scratch-destination guard (a tracked or in-repo-not-ignored --out is refused by the tool). The wrapper names are ALSO seeded into sandbox.excludedCommands IN THE PROJECT settings.json (an exclusion only in settings.local.json was live-observed NOT to route — the wrapper then runs sandboxed and dies on a read-only HOME): the harness runs an excluded command OUTSIDE the sandbox (the wrappers need network), so a plain allowlisted invocation triggers no sandbox-bypass approval. INVOCATION SHAPE: a prefix rule matches only a PLAIN invocation starting with the wrapper name — an env-var prefix or a compound chain never matches (redirects are fine).';

const formatBridgeTier = (result) =>
  result.bridgeTier
    ? [
        `${result.wrote ? 'added' : 'would add'} bridge-wrappers tier allow entries: ${result.bridgeToAdd.length}`,
        ...formatEntryList(result.bridgeToAdd),
        `already present (bridge tier): ${result.bridgeAlreadyPresent.length}`,
        `${result.wrote ? 'added' : 'would add'} sandbox.excludedCommands entries: ${result.excludedToAdd.length}`,
        ...formatEntryList(result.excludedToAdd),
        `already present (excludedCommands): ${result.excludedAlreadyPresent.length}`,
        ...result.bridgeSkips.map((s) => `  skipped: ${s.reason}`),
        KIT_BRIDGE_TIER_NOTICE,
      ]
    : [];

const formatGateAdvisory = (gateCandidates) => [
  'gate advisory: candidates you may add BY HAND to .claude/settings.json or settings.local.json; this tool will NOT add them',
  ...(gateCandidates.length
    ? gateCandidates.map((candidate) => `  - ${candidate.command}${candidate.warn ? ` (${candidate.warn})` : ''}`)
    : ['  - (none)']),
];

const formatPreExistingAdvisory = (preExistingNonReadonly) =>
  preExistingNonReadonly.length
    ? [
        'pre-existing non-read-only Bash allow entries: consider removing by hand',
        ...preExistingNonReadonly.map(({ source, entry }) => `  - ${source}: ${entry}`),
      ]
    : [];

const formatDefaultMode = (result) =>
  result.wrote
    ? `defaultMode: ${result.setsDefaultMode ? `set to ${ACCEPT_EDITS_MODE}` : 'not set by this run'}`
    : `defaultMode: ${result.setsDefaultMode ? `would set to ${ACCEPT_EDITS_MODE}` : 'would not be set by this run'}`;

const formatVelocityProfileResult = (result) =>
  [
    result.dryRun ? 'agent-workflow velocity profile - DRY RUN (no changes)' : 'agent-workflow velocity profile - APPLY',
    ...formatAllowlist(result),
    ...formatKitTier(result),
    ...formatBridgeTier(result),
    formatDefaultMode(result),
    ...formatGateAdvisory(result.gateCandidates),
    ...formatPreExistingAdvisory(result.preExistingNonReadonly),
    RESIDUAL_NOTICE,
  ].join(LF);

// Usage errors from `fail` carry an explicit exitCode (2); every other thrown error — including all
// VELOCITY_* precondition errors — maps to the precondition exit (1).
const exitCodeFor = (err) => err?.exitCode ?? EXIT_PRECONDITION;

// `:*` is the trailing word-boundary wildcard: equivalent to a trailing ` *`, recognized only at the
// end of a pattern per Claude Code semantics. Two forms are recognized: the wildcard form (the
// git/npm/shell core + the kit-tool wildcard class) and the EXACT form (tier-only: the root-pinned
// run-gates byte-string + the writer-preview dry-run byte-strings).
export const screenAllowlistEntry = (pattern) => {
  const wildcardCmd = getBashAllowCommand(pattern);
  if (wildcardCmd !== undefined) {
    if (hasShellMetacharacter(wildcardCmd)) return false;
    const tokens = tokenizeCommand(wildcardCmd);
    if (tokens[0] === GIT_COMMAND) return GIT_READONLY_SUBCOMMANDS.includes(getSubcommand(tokens));
    if (tokens[0] === NPM_COMMAND) return NPM_READONLY_SUBCOMMANDS.includes(getSubcommand(tokens));
    // Kit-tool wildcard class: `node <abs kit tool>` + args wildcard. run-gates is deliberately NOT
    // here (Decision 3: only its exact root-pinned form below — a wildcard would cover `--cwd <any>`).
    // The quoted-grounding form is the bridge tier's ONE quoted acceptance (never a general quote
    // allowance): `node "<abs>/tools/grounding.mjs"` exactly.
    if (tokens[0] === KIT_TOOL_INVOKER) {
      return tokens.length === 2 && (isKitToolPathToken(tokens[1], KIT_WILDCARD_TOOLS) || isQuotedGroundingToken(tokens[1]));
    }
    // Bridge-review-wrapper class (AD-044 Plan 4): EXACTLY `<frozen-tier wrapper> code` + the args
    // wildcard — never codex-exec/agy-run, never the bare or plan/diff spellings (those file-argument
    // modes can read outside the repo; codex R2).
    if (BRIDGE_REVIEW_WRAPPERS.includes(tokens[0])) return tokens.length === 2 && tokens[1] === BRIDGE_REVIEW_MODE;
    return isSingleShellToken(wildcardCmd, tokens) && SHELL_READONLY.includes(wildcardCmd);
  }
  const exactCmd = getBashExactCommand(pattern);
  if (exactCmd === undefined || hasShellMetacharacter(exactCmd)) return false;
  const tokens = tokenizeCommand(exactCmd);
  if (tokens[0] !== KIT_TOOL_INVOKER) return false;
  // Writer preview: the arg-free dry-run byte-string of a preview-class writer.
  if (tokens.length === 2) return isKitToolPathToken(tokens[1], KIT_WRITER_PREVIEW_TOOLS);
  // run-gates: EXACTLY `node <abs run-gates> --cwd <abs root>` — any other form keeps prompting.
  return (
    tokens.length === 4 &&
    isKitToolPathToken(tokens[1], [KIT_RUN_GATES_TOOL]) &&
    tokens[2] === RUN_GATES_CWD_FLAG &&
    isSeedablePathToken(tokens[3])
  );
};

/**
 * Derive the opt-in kit-tools tier for a project: 9 wildcard entries (resolved-absolute script
 * path + args wildcard), ONE exact run-gates entry pinned to the resolved project root, and the
 * writer-preview exact dry-run byte-strings. Pure derivation — a stale path simply prompts again.
 */
// A seedable path must survive UNQUOTED inside a byte-exact allow rule: POSIX-absolute, no
// whitespace, no shell metacharacter, no quoting/glob syntax (isSeedablePathToken). Anything else
// is refused UP FRONT with a clear error (a Windows-shaped, space- or quote-carrying path would
// otherwise die downstream as a confusing VELOCITY_NON_READONLY, or seed dead/shell-reinterpreted
// byte strings) — the hand-add advisory is the fallback.
const assertSeedablePath = (label, absPath) => {
  if (isSeedablePathToken(absPath)) return;
  throw makeVelocityProfileError(
    VELOCITY_INVALID_ARGUMENT,
    `kit-tools tier: the ${label} "${absPath}" is not a POSIX absolute path free of spaces/metacharacters/quoting - byte-exact allow rules cannot be seeded for it; add hand-picked entries to your settings instead (hand-add)`,
    { entry: absPath },
  );
};

export const deriveKitToolsAllowlist = ({ projectDir } = {}) => {
  if (typeof projectDir !== 'string' || projectDir === '') {
    throw makeVelocityProfileError(VELOCITY_INVALID_ARGUMENT, 'kit-tools derivation needs a project directory', {
      entry: projectDir,
    });
  }
  const projectRoot = resolve(projectDir);
  assertSeedablePath('resolved project root', projectRoot);
  assertSeedablePath('resolved skill dir', join(KIT_ROOT, '.'));
  return Object.freeze([
    ...KIT_WILDCARD_TOOLS.map((rel) => `Bash(${KIT_TOOL_INVOKER} ${join(KIT_ROOT, rel)}:*)`),
    `Bash(${KIT_TOOL_INVOKER} ${join(KIT_ROOT, KIT_RUN_GATES_TOOL)} ${RUN_GATES_CWD_FLAG} ${projectRoot})`,
    ...KIT_WRITER_PREVIEW_TOOLS.map((rel) => `Bash(${KIT_TOOL_INVOKER} ${join(KIT_ROOT, rel)})`),
  ]);
};

export const discoverGateCandidates = (packageJson) => {
  const scripts = packageJson?.scripts;
  if (!isScriptMap(scripts)) return [];
  return Object.keys(scripts).map(makeGateCandidate);
};

/**
 * Validate that what we are about to write is a subset of the SELECTED audited set: every entry
 * must (a) NOT be a commit/push/publish allow entry, (b) pass the read-only screen, and (c) be a
 * member of the audited set (a guard against the constants drifting). The argument-less call keeps
 * its exact historical semantics — the full core validated against itself; a --kit-tools run
 * additionally validates the derived tier against core + tier. Pure; owns no exit codes — a CLI
 * maps the typed `.code` to a process exit.
 */
export const validateProfile = (allowEntries = UNIVERSAL_READONLY_ALLOWLIST, auditedSet = UNIVERSAL_READONLY_ALLOWLIST) => {
  if (!Array.isArray(allowEntries)) {
    throw makeVelocityProfileError(VELOCITY_INVALID_ARGUMENT, 'allow entries must be an array', { entry: allowEntries });
  }

  for (const entry of allowEntries) {
    if (matchesMutatingAllowCommand(entry)) {
      throw makeVelocityProfileError(VELOCITY_NON_READONLY, `refuses to seed a commit/push/publish allow entry: ${entry}`, { entry });
    }
    if (!screenAllowlistEntry(entry)) {
      throw makeVelocityProfileError(VELOCITY_NON_READONLY, `not a read-only allow entry: ${entry}`, { entry });
    }
    if (!auditedSet.includes(entry)) {
      throw makeVelocityProfileError(VELOCITY_OFFCORE, `allow entry is outside the audited core: ${entry}`, { entry });
    }
  }

  return { ok: true, count: allowEntries.length };
};

export const readSettingsFile = (absPath, deps = {}) => {
  const fs = fsDeps(deps);
  const relPath = relativeToCwd(absPath, deps.cwd);
  const stat = lstatNoFollow(absPath, fs);
  if (stat === null) return { present: false };
  const raw = readFileLoud(absPath, relPath, fs);
  const data = validateSettingsShape(parseJsonLoud(raw, relPath), relPath);
  return { present: true, data, eol: raw.includes(CRLF) ? CRLF : LF };
};

const isUnsafeMode = (mode) => mode !== undefined && !SAFE_DEFAULT_MODES.includes(mode);

export const resolveEffectiveMode = (projectData, localData) => {
  const projectMode = getDefaultMode(projectData);
  const localMode = getDefaultMode(localData);
  const effectiveMode = localMode.present ? localMode.value : projectMode.value;
  return {
    effectiveMode,
    // Presence-based, NOT effective-based: a SAFE local override must not mask a committed unsafe
    // mode in settings.json (merge-don't-clobber would otherwise preserve it for everyone on write).
    bypassPermissionsPresent: projectMode.value === UNSAFE_BYPASS_MODE || localMode.value === UNSAFE_BYPASS_MODE,
    unsafeModePresent: isUnsafeMode(projectMode.value) || isUnsafeMode(localMode.value),
  };
};

export const preflightVelocityProfile = ({ cwd }, deps = {}) => {
  const projectDir = cwd ?? deps.cwd ?? process.cwd();
  const stamp = readStamp(join(projectDir, WORKFLOW_STAMP), { ...deps, cwd: projectDir });
  const stampOk = stamp === EXPECTED_WORKFLOW_VERSION;
  const { claudeDirAbsent } = assertClaudeDirSafe(projectDir, deps);
  // A symlinked / non-regular settings.json STOPs on BOTH dry-run and apply (read-only check here),
  // so a dry-run never promises a write the apply would refuse.
  assertTargetWritable(join(projectDir, SETTINGS_FILE), deps);
  const projectSettings = readSettingsFile(join(projectDir, SETTINGS_FILE), { ...deps, cwd: projectDir });
  const localSettings = readSettingsFile(join(projectDir, SETTINGS_LOCAL_FILE), { ...deps, cwd: projectDir });
  const { effectiveMode, bypassPermissionsPresent, unsafeModePresent } = resolveEffectiveMode(projectSettings.data, localSettings.data);

  if (bypassPermissionsPresent) {
    throw makeVelocityProfileError(
      VELOCITY_UNSAFE_MODE,
      `${UNSAFE_BYPASS_MODE} appears in Claude settings - refusing because it auto-approves Bash`,
    );
  }
  if (unsafeModePresent) {
    throw makeVelocityProfileError(
      VELOCITY_UNSAFE_MODE,
      `an unsafe or unknown permissions.defaultMode is present in Claude settings - accepted modes: ${SAFE_DEFAULT_MODES.join(', ')}`,
    );
  }

  // The advisory compares kit-tool-shaped entries against the tier derived for THIS kit + root.
  // Defensive derive: on a machine whose paths cannot seed (space/metacharacter — the tier itself
  // refuses loudly on --kit-tools), the flagless advisory falls back to flagging EVERY node-shaped
  // entry — over-flagging is the safe direction, and flagless behavior never gains a new failure
  // mode from local skill paths.
  const derivedTier = (() => {
    try {
      return deriveKitToolsAllowlist({ projectDir });
    } catch {
      return [];
    }
  })();
  // Same defensive posture for the bridge tier: a probe failure falls back to flagging every
  // bridge-shaped entry — over-flagging is the safe direction for a read-only advisory.
  const derivedBridge = (() => {
    try {
      return deriveBridgeTierAllowlist({ findWrapper: deps.findWrapper }).allow;
    } catch {
      return [];
    }
  })();
  const preExistingNonReadonly = collectPreExistingNonReadonly(
    [
      { source: SETTINGS_FILE, data: projectSettings.data },
      { source: SETTINGS_LOCAL_FILE, data: localSettings.data },
    ],
    derivedTier,
    derivedBridge,
  );
  const gateCandidates = discoverGateCandidates(readPackageJson(projectDir, deps));

  return {
    cwd: projectDir,
    stamp,
    stampOk,
    claudeDirAbsent,
    projectSettings,
    localSettings,
    effectiveMode,
    bypassPermissionsPresent,
    preExistingNonReadonly,
    gateCandidates,
  };
};

export const planVelocityProfile = (preflight, { acceptEdits, kitTools, bridgeTier, findWrapper } = {}) => {
  const projectAllow = getAllowEntries(preflight.projectSettings?.data);
  const toAdd = UNIVERSAL_READONLY_ALLOWLIST.filter((entry) => !projectAllow.includes(entry));
  const alreadyPresent = UNIVERSAL_READONLY_ALLOWLIST.filter((entry) => projectAllow.includes(entry));
  const tier = kitTools === true ? deriveKitToolsAllowlist({ projectDir: preflight.cwd }) : [];
  const tierToAdd = tier.filter((entry) => !projectAllow.includes(entry));
  const tierAlreadyPresent = tier.filter((entry) => projectAllow.includes(entry));
  const bridge = bridgeTier === true ? deriveBridgeTierAllowlist({ findWrapper }) : { allow: [], excludedCommands: [], skips: [], placed: [] };
  const bridgeToAdd = bridge.allow.filter((entry) => !projectAllow.includes(entry));
  const bridgeAlreadyPresent = bridge.allow.filter((entry) => projectAllow.includes(entry));
  const existingSandbox = isJsonObject(preflight.projectSettings?.data?.sandbox) ? preflight.projectSettings.data.sandbox : {};
  const existingExcluded = Array.isArray(existingSandbox.excludedCommands) ? existingSandbox.excludedCommands : [];
  const excludedToAdd = bridge.excludedCommands.filter((cmd) => !existingExcluded.includes(cmd));
  const excludedAlreadyPresent = bridge.excludedCommands.filter((cmd) => existingExcluded.includes(cmd));
  return {
    toAdd,
    alreadyPresent,
    tierToAdd,
    tierAlreadyPresent,
    kitTools: kitTools === true,
    bridgeTier: bridgeTier === true,
    bridgeToAdd,
    bridgeAlreadyPresent,
    bridgeSkips: bridge.skips,
    excludedToAdd,
    excludedAlreadyPresent,
    setsDefaultMode: acceptEdits === true,
  };
};

export const writeVelocityProfile = ({ cwd, acceptEdits = false, dryRun = true, kitTools = false, bridgeTier = false } = {}, deps = {}) => {
  const projectDir = cwd ?? deps.cwd ?? process.cwd();
  const preflight = preflightVelocityProfile({ cwd: projectDir }, deps);
  const plan = planVelocityProfile(preflight, { acceptEdits, kitTools, bridgeTier, findWrapper: deps.findWrapper });
  // Drift guard runs on BOTH dry-run and apply (so a dry-run faithfully predicts the apply) and
  // validates the FULL audited core, not just the to-add delta — a drifted core entry is caught even
  // when it is already present in the user's allow list (and toAdd is a subset of the core anyway).
  validateProfile();
  // A --kit-tools run additionally validates the SELECTED tier against core + tier — flagless
  // behavior never depends on local skill paths (the derivation does not even run without the flag).
  if (kitTools === true) {
    const tier = deriveKitToolsAllowlist({ projectDir });
    validateProfile(tier, [...UNIVERSAL_READONLY_ALLOWLIST, ...tier]);
  }
  // A --bridge-tier run validates the DERIVED bridge entries the same way — the third audit point
  // (Decision 2): every seeded bridge entry passes the screen AND sits in the audited set, so the
  // flagless advisory can never flag an entry the tier itself seeded.
  if (bridgeTier === true) {
    const bridge = deriveBridgeTierAllowlist({ findWrapper: deps.findWrapper });
    validateProfile(bridge.allow, [...UNIVERSAL_READONLY_ALLOWLIST, ...bridge.allow]);
  }
  const resultBase = { ...preflight, ...plan };
  if (dryRun) return { wrote: false, dryRun: true, ...resultBase };

  if (!preflight.stampOk) {
    throw makeVelocityProfileError(
      VELOCITY_STAMP,
      `not a deployed agent-workflow project at lineage ${EXPECTED_WORKFLOW_VERSION} (found ${preflight.stamp ?? 'none'}) - run init/upgrade first`,
    );
  }

  const fs = fsDeps(deps);
  const settingsPath = join(projectDir, SETTINGS_FILE);
  if (preflight.claudeDirAbsent) fs.mkdir(join(projectDir, CLAUDE_DIR), { recursive: true });
  const merged = mergeProjectSettings(
    preflight.projectSettings.data,
    [...plan.toAdd, ...plan.tierToAdd, ...plan.bridgeToAdd],
    acceptEdits,
    plan.excludedToAdd,
  );
  fs.writeFile(settingsPath, formatJson(merged, preflight.projectSettings.eol ?? LF), UTF8);
  return { wrote: true, dryRun: false, settingsPath, ...resultBase };
};

// ── the --autonomy render (AD-044) ───────────────────────────────────────────────────────────────
// Render docs/ai/autonomy.json into the .claude/settings.json blocks the render OWNS — the `sandbox`
// block + permissions.ask/deny red-lines + permissions.defaultMode — per the Decision-6 invariant,
// wired to what the REAL claude 2.1.185 accepts (Step 3.1). POLICY-ONLY: never seeds the read-only
// allowlist and never touches permissions.allow as a value; a sibling of the flagless allowlist merge
// (mergeProjectSettings) that follows the identical merge-don't-clobber discipline. Preview-then-apply,
// dry-run default. Refuses an absent policy (a writer renders only a declared policy).

// The exact 2.1.185 sandbox settings keys (Step 3.1, characterized against the real CLI + official docs).
const SANDBOX_KEY = 'sandbox';
const SANDBOX_ENABLED_KEY = 'enabled';
const SANDBOX_AUTOALLOW_KEY = 'autoAllowBashIfSandboxed';
const DEFAULT_MODE_KEY = 'defaultMode';
const AUTONOMY_SANDBOX = 'sandbox';
const AUTONOMY_PROMPT = 'prompt';
// Decision 6: sandbox level ⇒ defaultMode acceptEdits; prompt level ⇒ defaultMode default.
const DEFAULT_MODE_FOR = Object.freeze({ [AUTONOMY_SANDBOX]: ACCEPT_EDITS_MODE, [AUTONOMY_PROMPT]: 'default' });
// The command red-lines → their Bash permission rule. The `:*` wildcard MATCHES argument-bearing forms
// (`git commit -m x`, `git push origin main`, `npm publish --tag latest`) — an exact `Bash(git commit)`
// would not (Step 3.1). These rules are the render-owned entries under permissions.ask / permissions.deny.
// ACCEPTED RESIDUAL (AD-044, do NOT try to enumerate away): Claude's prefix rules cannot cover an
// obfuscated spelling — a global-option form (`git -c user.name=x commit`) or a shell/wrapper escape
// falls outside `Bash(git commit:*)`, so under sandbox auto-allow it would not prompt. Enumerating every
// prefix is impossible; the command red-lines are a BEST-EFFORT checkpoint, not a security boundary (the
// same settings-level residual velocity documents). The real enforcement is the sandbox + the maintainer's
// approval process + the repo no-auto-commit constraint — see AUTONOMY_RESIDUAL_NOTICE.
const REDLINE_COMMAND_RULES = Object.freeze({
  commit: 'Bash(git commit:*)',
  push: 'Bash(git push:*)',
  publish: 'Bash(npm publish:*)',
});
export const RENDER_OWNED_REDLINE_RULES = Object.freeze(Object.values(REDLINE_COMMAND_RULES));
// The Linux sandbox binaries (Step 3.1: BOTH are required for the sandbox to INITIALIZE — a missing
// socat does NOT degrade only network; the whole sandbox falls back to unsandboxed).
const SANDBOX_LINUX_BINARIES = Object.freeze(['bwrap', 'socat']);

const AUTONOMY_RESIDUAL_NOTICE =
  'floor + residual (always, sandbox available or not): the command red-lines gate the DIRECT forms ' +
  '(`git commit …` / `git push …` / `npm publish …`) as a best-effort checkpoint, NOT a security ' +
  'boundary. RESIDUAL: Claude prefix-based ask/deny rules cannot exhaustively cover obfuscated forms — ' +
  'a global-option spelling (`git -c user.name=x commit`) or a shell/wrapper escape is not caught by ' +
  'the ask rule, and under sandbox auto-allow it would not prompt (the same settings-level residual ' +
  'velocity documents; enumerating every form is impossible). The REAL backstops are the SANDBOX (a ' +
  'genuine OS boundary, once available), the maintainer\'s commit/push/publish approval process, and ' +
  'the repo no-auto-commit constraint — never these settings rules alone. Any bypass/weakening ' +
  'warnings above are also best-effort: their ABSENCE is not proof no bypass exists. This render writes ' +
  'ONLY .claude/settings.json (never settings.local.json), touches ONLY the sandbox block + ' +
  'permissions.ask/deny/defaultMode, and leaves permissions.allow untouched.';

// isExecutableFile — true iff `p` is a REGULAR file with an execute bit (statSync FOLLOWS a symlink, so
// a symlinked binary resolves to its target). A directory or a non-executable file NAMED bwrap/socat
// must NOT count as the binary (else the loud sandbox-unavailable degrade would be wrongly suppressed).
// Exported (AD-044 Plan 2): autonomy-doctor.mjs promotes this to its trusted-dir execution gate.
export const isExecutableFile = (p) => {
  try {
    const st = statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

// hasBinaryOnPath — a read-only PATH scan (no spawn, fully injectable): is `name` present as an
// EXECUTABLE regular file in any PATH dir? The runtime probe is deterministic (Step 3.1 is the separate
// one-time MANUAL characterization).
const hasBinaryOnPath = (name, env, isExec) =>
  ((env && env.PATH) || '').split(':').filter(Boolean).some((dir) => isExec(join(dir, name)));

// probeSandboxAvailability(deps) → { platform, sandbox, available, missing, reason }. Read-only: platform
// (process.platform) + EXECUTABLE-binary presence via injectable deps (deps.platform / deps.env /
// deps.hasBinary / deps.isExecutable). NEVER launches a live `claude`. The degrade RULE is derived from
// Step 3.1: Linux needs bwrap+socat (both, or NO sandbox); macOS Seatbelt is built-in; native Windows
// unsupported → WSL2.
export const probeSandboxAvailability = (deps = {}) => {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const isExec = deps.isExecutable ?? isExecutableFile;
  const hasBinary = deps.hasBinary ?? ((name) => hasBinaryOnPath(name, env, isExec));
  if (platform === 'darwin') {
    return { platform, sandbox: 'seatbelt', available: true, missing: [], reason: 'macOS Seatbelt (built-in)' };
  }
  if (platform === 'linux') {
    const missing = SANDBOX_LINUX_BINARIES.filter((b) => !hasBinary(b));
    return {
      platform,
      sandbox: 'bubblewrap',
      available: missing.length === 0,
      missing,
      reason: missing.length === 0
        ? `Linux sandbox ready (${SANDBOX_LINUX_BINARIES.join(' + ')} present)`
        : `Linux sandbox needs ${SANDBOX_LINUX_BINARIES.join(' + ')} — missing: ${missing.join(', ')} (the whole sandbox falls back to unsandboxed)`,
    };
  }
  return { platform, sandbox: 'none', available: false, missing: [], reason: `native ${platform} sandbox unsupported — use WSL2 on Windows` };
};

// effectiveAutonomyLevel(resolved) → the ONE global level the (global, static) settings file renders.
// The autonomy policy is per-activity (Decision 2), but .claude/settings.json is global and the
// plan.end/exec.end checkpoints are BEHAVIORAL, not machine-enforced (Decision 1). Global auto-allow is
// a global settings behavior, so it engages only when EVERY activity is opted into `sandbox` (conservative
// unanimity — the safe floor); a mixed/default policy keeps the global `prompt` floor (the sandbox still
// confines). The preview surfaces the per-activity levels + this collapse loudly (never silent).
export const effectiveAutonomyLevel = (resolved) => {
  const levels = Object.values(resolved.activities).map((a) => a.autonomy);
  return levels.length > 0 && levels.every((l) => l === AUTONOMY_SANDBOX) ? AUTONOMY_SANDBOX : AUTONOMY_PROMPT;
};

// renderAutonomySettings(resolved, probe) → the render-owned blocks + honesty notes/degrades. PURE. The
// sandbox is ALWAYS enabled (the Decision-1 floor: BOTH levels confine); auto-allow + defaultMode follow
// the collapsed level. Command red-lines land under ask/deny by value. The three non-command red-lines
// are the sandbox DEFAULTS (network prompt-on-egress; fs cwd+$TMPDIR confine) — where 2.1.185 cannot
// express a value distinctly it DEGRADES LOUDLY (never a silent allow, never silent pretend-security).
export const renderAutonomySettings = (resolved, probe) => {
  const level = effectiveAutonomyLevel(resolved);
  const wantsSandbox = level === AUTONOMY_SANDBOX;
  const sandbox = { [SANDBOX_ENABLED_KEY]: true, [SANDBOX_AUTOALLOW_KEY]: wantsSandbox };
  const defaultMode = DEFAULT_MODE_FOR[level];
  const ask = [];
  const deny = [];
  for (const rl of COMMAND_REDLINES) {
    (resolved.redlines[rl] === 'deny' ? deny : ask).push(REDLINE_COMMAND_RULES[rl]);
  }
  const notes = [];
  const degrades = [];
  // network — 2.1.185 regular settings cannot HARD-BLOCK egress; both values render as no allowedDomains
  // (prompt-on-egress). deny DEGRADES LOUDLY (can't hard-block); ask is the faithful sandbox default.
  if (resolved.redlines.network === 'deny') {
    degrades.push('network=deny requested, but claude 2.1.185 regular settings cannot HARD-BLOCK egress — rendered as prompt-on-egress (the sandbox default: no domains pre-allowed, a new domain still prompts). A silent hard block needs managed settings (allowManagedDomainsOnly).');
  } else {
    notes.push('network=ask → prompt on each new domain (the sandbox default; no domains pre-allowed).');
  }
  // credentials — 2.1.185 has NO sandbox.credentials at all (deny added 2.1.187, mask 2.1.199). BOTH
  // values degrade loudly — never silent pretend-security.
  degrades.push(`credentials=${resolved.redlines.credentials} requested, but claude 2.1.185 has NO sandbox credential denial (deny added in 2.1.187, mask in 2.1.199) — NPM_TOKEN/GITHUB_TOKEN and ~/.ssh are NOT hidden from sandboxed commands. Upgrade to 2.1.187+ for sandbox.credentials.`);
  // fs_outside_repo — the sandbox default is a HARD confine to cwd+$TMPDIR; 2.1.185 has no
  // prompt-on-outside-write, so `ask` DEGRADES LOUDLY to the deny form (hard confine).
  if (resolved.redlines.fs_outside_repo === 'ask') {
    degrades.push('fs_outside_repo=ask requested, but claude 2.1.185 has no prompt-on-outside-write — rendered as the deny form (writes hard-confined to cwd+$TMPDIR; an outside write is blocked, then auto-retried through the normal permission flow).');
  } else {
    notes.push('fs_outside_repo=deny → writes confined to cwd+$TMPDIR (the sandbox default).');
  }
  // sandbox availability (Step 3.3 probe) — a LOUD degrade where the OS can't sandbox; the red-lines +
  // defaultMode still land (they are permission rules, sandbox-independent).
  if (!probe.available) {
    degrades.push(`sandbox UNAVAILABLE on this host (${probe.reason}) — claude renders the sandbox block but WARNS and runs UNSANDBOXED: ad-hoc scripts will still PROMPT and network/fs confinement is NOT enforced until it is available (run /agent-workflow-kit autonomy-doctor to diagnose and, with your consent, install the missing dependency). The red-lines + defaultMode still apply. failIfUnavailable is left UNSET so the session is never bricked.`);
  }
  return { level, activities: resolved.activities, sandbox, defaultMode, ask, deny, notes, degrades };
};

// mergeAutonomySettings(projectData, render) → merged settings.json (merge-don't-clobber). Touches ONLY
// the render-owned blocks: the sandbox key (foreign sub-keys preserved), permissions.defaultMode, and
// the render-owned red-line rules under permissions.ask/deny (a policy flip MOVES a rule between ask and
// deny rather than duplicating it; foreign ask/deny entries preserved). permissions.allow is UNTOUCHED
// as a value; every foreign top-level key (e.g. the gate-hook `hooks` block) is preserved.
export const mergeAutonomySettings = (projectData, render) => {
  const base = projectData ?? {};
  const permissions = getPermissions(base);
  const existingSandbox = isJsonObject(base[SANDBOX_KEY]) ? base[SANDBOX_KEY] : {};
  const existingAsk = Array.isArray(permissions.ask) ? permissions.ask : [];
  const existingDeny = Array.isArray(permissions.deny) ? permissions.deny : [];
  const stripOwned = (arr) => arr.filter((e) => !RENDER_OWNED_REDLINE_RULES.includes(e));
  const mergedAsk = [...stripOwned(existingAsk), ...render.ask];
  const mergedDeny = [...stripOwned(existingDeny), ...render.deny];
  const mergedPermissions = { ...permissions, [DEFAULT_MODE_KEY]: render.defaultMode };
  if (mergedAsk.length) mergedPermissions.ask = mergedAsk;
  else delete mergedPermissions.ask;
  if (mergedDeny.length) mergedPermissions.deny = mergedDeny;
  else delete mergedPermissions.deny;
  const mergedSandbox = { ...existingSandbox, [SANDBOX_ENABLED_KEY]: true, [SANDBOX_AUTOALLOW_KEY]: render.sandbox[SANDBOX_AUTOALLOW_KEY] };
  return { ...base, [SANDBOX_KEY]: mergedSandbox, permissions: mergedPermissions };
};

// Each command red-line as [tool, subcommand], for bypass detection over the real Claude allow-rule
// semantics. Global options can sit between the tool and the subcommand (`git -c x commit`,
// `npm --registry=r publish`), so bypass detection scans for the subcommand ANYWHERE in the tokens
// rather than requiring a strict prefix.
const REDLINE_COMMAND_WORDS = Object.freeze({ commit: ['git', 'commit'], push: ['git', 'push'], publish: ['npm', 'publish'] });

// allowEntryBypass(entry) → the red-lines a single allow entry would AUTO-APPROVE (or null). Parse the
// entry's command (wildcard `Bash(C:*)` or exact `Bash(C)`). It bypasses red-line R = <tool> <sub> when
// the command's first token is <tool> AND either (a) it is the bare-tool WILDCARD `Bash(git:*)` /
// `Bash(npm:*)` (subsumes every subcommand of that tool), or (b) <sub> appears anywhere in the tokens
// — covering `git commit`, `git -c user.name=x commit`, `npm --registry=r publish`, and exact
// `Bash(git commit)`. Conservative (over-flags a benign `git branch commit` — a warning, never a write);
// the render-owned `:*` forms alone would miss broad/exact/global-option allows.
const allowEntryBypass = (entry) => {
  const wild = getBashAllowCommand(entry);
  const cmd = wild ?? getBashExactCommand(entry);
  if (cmd === undefined) return null;
  const tokens = tokenizeCommand(cmd);
  const hit = [];
  for (const [rl, [tool, sub]] of Object.entries(REDLINE_COMMAND_WORDS)) {
    if (tokens[0] !== tool) continue;
    // A bare-tool WILDCARD (`Bash(git:*)`) subsumes every subcommand; otherwise the subcommand must
    // appear as a token. An EXACT bare-tool (`Bash(git)`) matches only the literal "git" (no bypass).
    if ((wild !== undefined && tokens.length === 1) || tokens.slice(1).includes(sub)) hit.push(rl);
  }
  return hit.length ? hit : null;
};

// collectRedlineBypass(sources) → the pre-existing allow entries (per file) that would AUTO-APPROVE a
// render-owned command red-line (commit/push/publish), defeating the rendered ask/deny. The render never
// touches allow, so it cannot fix this — it REPORTS it loudly (remove the allow entry by hand).
const collectRedlineBypass = (sources) =>
  sources.flatMap(({ source, data }) =>
    getAllowEntries(data).flatMap((entry) => {
      const redlines = allowEntryBypass(entry);
      return redlines ? [{ source, entry, redlines }] : [];
    }));

// collectSandboxWeakenings(sources) → foreign `sandbox` sub-keys (in either settings file) that WEAKEN a
// rendered red-line: `allowedDomains` pre-allows egress (weakens network); a filesystem write-allowance
// permits writes outside cwd (weakens fs_outside_repo); `allowUnsandboxedCommands:true` lets commands
// escape the sandbox entirely. The render owns only enabled/autoAllow and preserves other sandbox
// sub-keys (merge-don't-clobber, never a silent clobber of the user's sandbox tuning), so a pre-existing
// weakening sub-key is REPORTED loudly (remove it by hand) — never silently carried as security.
const collectSandboxWeakenings = (sources) => {
  // Tier-known PROOF (codex R4): an excludedCommands entry is downgraded to a note ONLY when it is
  // demonstrably the consented tier's own output — it lives in the PROJECT settings.json (the file
  // the tier writes; a local-file exclusion is never tier output) AND the matching derived
  // code-mode allow rule is present there. A bare name match alone proves nothing.
  const project = sources.find((s) => s.source === SETTINGS_FILE);
  const projectAllow = getAllowEntries(project?.data);
  const isTierKnownExclusion = (source, cmd) =>
    source === SETTINGS_FILE &&
    BRIDGE_REVIEW_WRAPPERS.includes(cmd) &&
    projectAllow.includes(`Bash(${cmd} ${BRIDGE_REVIEW_MODE}:*)`);
  return sources.flatMap(({ source, data }) => {
    const sb = isJsonObject(data?.[SANDBOX_KEY]) ? data[SANDBOX_KEY] : {};
    const out = [];
    const net = isJsonObject(sb.network) ? sb.network : {};
    if (Array.isArray(net.allowedDomains) && net.allowedDomains.length) {
      out.push({ source, key: `${SANDBOX_KEY}.network.allowedDomains`, weakens: 'network', detail: `${net.allowedDomains.length} pre-allowed domain(s) — egress to them is not gated` });
    }
    const fsb = isJsonObject(sb.filesystem) ? sb.filesystem : {};
    if (Array.isArray(fsb.allowWrite) && fsb.allowWrite.length) {
      out.push({ source, key: `${SANDBOX_KEY}.filesystem.allowWrite`, weakens: 'fs_outside_repo', detail: `${fsb.allowWrite.length} path(s) writable outside cwd+$TMPDIR` });
    }
    if (sb.allowUnsandboxedCommands === true) {
      out.push({ source, key: `${SANDBOX_KEY}.allowUnsandboxedCommands`, weakens: 'every sandbox red-line', detail: 'commands may run unsandboxed' });
    }
    if (Array.isArray(sb.excludedCommands) && sb.excludedCommands.length) {
      // The bridge tier's OWN wrapper names are tier-known ONLY with the proof above (the
      // --bridge-tier consent covers exactly this posture — the wrappers need network and
      // genuinely run unsandboxed); then they are an informational note, never a weakening flag
      // (the Decision-2 self-consistency bar). Every OTHER excluded command — hand-added names,
      // local-file exclusions, tier names without their allow rules — stays a loud weakening.
      const tierKnown = sb.excludedCommands.filter((c) => isTierKnownExclusion(source, c));
      const foreign = sb.excludedCommands.filter((c) => !tierKnown.includes(c));
      if (foreign.length) {
        out.push({ source, key: `${SANDBOX_KEY}.excludedCommands`, weakens: 'every sandbox red-line', detail: `${foreign.length} command(s) run UNSANDBOXED (network/fs confinement not applied to them)${tierKnown.length ? `; ${tierKnown.length} bridge-review wrapper exclusion(s) are tier-known and not flagged` : ''}` });
      } else if (tierKnown.length) {
        out.push({ source, key: `${SANDBOX_KEY}.excludedCommands`, weakens: null, tierKnown: true, detail: `${tierKnown.length} bridge-review wrapper exclusion(s) (${tierKnown.join(', ')}) — tier-known: the consented bridge-wrappers tier runs them outside the sandbox (network), and its allow rules are present in the project settings` });
      }
    }
    return out;
  });
};

// collectLocalMasks(localData, render) → the render-owned keys a settings.local.json value MASKS
// (local > project, so a differing local value defeats the rendered one silently). The render owns
// exactly permissions.defaultMode + sandbox.enabled + sandbox.autoAllowBashIfSandboxed — the COMPLETE
// finite set of scalar render-owned keys (the ask/deny red-line arrays MERGE across scopes and are
// covered by collectRedlineBypass). Reported loudly; the local file is the maintainer's, never written.
const collectLocalMasks = (localData, render) => {
  const local = localData ?? {};
  const localPerms = getPermissions(local);
  const localSandbox = isJsonObject(local[SANDBOX_KEY]) ? local[SANDBOX_KEY] : {};
  const masks = [];
  if (hasOwn(localPerms, DEFAULT_MODE_KEY) && localPerms[DEFAULT_MODE_KEY] !== render.defaultMode) {
    masks.push({ key: `permissions.${DEFAULT_MODE_KEY}`, local: localPerms[DEFAULT_MODE_KEY], rendered: render.defaultMode });
  }
  for (const k of [SANDBOX_ENABLED_KEY, SANDBOX_AUTOALLOW_KEY]) {
    if (hasOwn(localSandbox, k) && localSandbox[k] !== render.sandbox[k]) {
      masks.push({ key: `${SANDBOX_KEY}.${k}`, local: localSandbox[k], rendered: render.sandbox[k] });
    }
  }
  return masks;
};

const formatActivityLevels = (activities) =>
  Object.entries(activities).map(([a, v]) => `${a}=${v.autonomy}`).join(', ');

export const formatAutonomyResult = (r) => {
  const lines = [
    r.wrote ? 'agent-workflow autonomy render - APPLY' : 'agent-workflow autonomy render - DRY RUN (no changes)',
    `policy: ${r.source}  ·  per-activity: ${formatActivityLevels(r.activities)}  ·  effective global autonomy: ${r.level}`,
  ];
  if (r.level === AUTONOMY_PROMPT && !Object.values(r.activities).every((v) => v.autonomy === AUTONOMY_PROMPT)) {
    lines.push('  note: global autonomy is `prompt` because not every activity is `sandbox` — set every activity to sandbox (set-autonomy) to enable global auto-allow (conservative unanimity; the sandbox still confines).');
  }
  lines.push(
    `sandbox: ${SANDBOX_ENABLED_KEY}=true, ${SANDBOX_AUTOALLOW_KEY}=${r.sandbox[SANDBOX_AUTOALLOW_KEY]} (${r.level === AUTONOMY_SANDBOX ? 'auto-allow confined commands' : 'auto-allow OFF — confine only'})`,
    `permissions.${DEFAULT_MODE_KEY}: ${r.wrote ? 'set to' : 'would set to'} ${r.defaultMode}`,
    `permissions.ask (render-owned red-lines): ${r.ask.length ? r.ask.join(', ') : '(none)'}`,
    `permissions.deny (render-owned red-lines): ${r.deny.length ? r.deny.join(', ') : '(none)'}`,
    'permissions.allow: untouched (policy-only render)',
  );
  for (const n of r.notes) lines.push(`  note: ${n}`);
  for (const d of r.degrades) lines.push(`  ⚠ DEGRADE: ${d}`);
  for (const m of r.localMasks ?? []) {
    lines.push(`  ⚠ ${SETTINGS_LOCAL_FILE} sets ${m.key}=${JSON.stringify(m.local)}, which MASKS this render's ${m.key}=${JSON.stringify(m.rendered)} (local > project) — the local value wins, so the render is not effective for that key; the local file is the maintainer's and is never written by the kit.`);
  }
  for (const b of r.redlineBypass ?? []) {
    lines.push(`  ⚠ DEGRADE: ${b.source} has a pre-existing allow entry ${b.entry} that would BYPASS the rendered red-line(s) ${b.redlines.join('/')} (a matching allow rule AUTO-APPROVES the command, defeating ask/deny) — remove it by hand; this render never touches permissions.allow.`);
  }
  for (const w of r.sandboxWeakenings ?? []) {
    if (w.tierKnown) lines.push(`  note: ${w.source} has ${w.key} (${w.detail}).`);
    else lines.push(`  ⚠ DEGRADE: ${w.source} has ${w.key} (${w.detail}), which WEAKENS the rendered ${w.weakens} red-line — the render preserves your sandbox tuning (never clobbers it), so remove it by hand if you want the red-line fully enforced.`);
  }
  lines.push(AUTONOMY_RESIDUAL_NOTICE);
  if (!r.wrote) lines.push(`re-run with ${FLAG_APPLY} to write .claude/settings.json (only the render-owned blocks change).`);
  return lines.join(LF);
};

// writeAutonomyProfile({ cwd, apply }, deps) → the preview/apply result. Reuses preflightVelocityProfile
// for the SAFETY bar (refuse bypassPermissions / unsafe mode in either settings file, symlink-safe,
// stamp gate on apply, resolveEffectiveMode across BOTH files). Refuses an absent policy loudly.
export const writeAutonomyProfile = ({ cwd, apply = false } = {}, deps = {}) => {
  const projectDir = cwd ?? deps.cwd ?? process.cwd();
  const readFile = deps.readFile ?? deps.readFileSync ?? readFileSync;
  const lstat = deps.lstat ?? deps.lstatSync ?? lstatSync;
  const { config, source } = loadAutonomy(projectDir, readFile, lstat);
  if (source === 'none' || config === null) {
    throw makeVelocityProfileError(
      VELOCITY_NO_POLICY,
      `no ${AUTONOMY_REL} to render — seed a policy first (set-autonomy previews, then --write; or hand-edit it), then re-run the autonomy render`,
    );
  }
  const resolved = resolveAutonomy(config);
  const probe = probeSandboxAvailability(deps);
  const render = renderAutonomySettings(resolved, probe);
  const preflight = preflightVelocityProfile({ cwd: projectDir }, deps);
  // local-mask honesty: a settings.local.json value for ANY render-owned key (defaultMode + the sandbox
  // enable/auto-allow keys) that differs from the render's MASKS it (local > project). Reported loudly;
  // the local file is the maintainer's and is never touched.
  const localMasks = collectLocalMasks(preflight.localSettings?.data, render);
  // Red-line-bypass honesty: a pre-existing `permissions.allow` entry (in EITHER settings file) that
  // matches a render-owned command red-line (commit/push/publish) AUTO-APPROVES the command, defeating
  // the render's ask/deny placement. The render never touches allow, so it cannot fix this — it REPORTS
  // it loudly (remove the allow entry by hand). Reuse matchesMutatingAllowCommand (the velocity allow-screen
  // predicate) so the two surfaces agree on what a mutating allow entry is.
  const settingsSources = [
    { source: SETTINGS_FILE, data: preflight.projectSettings?.data },
    { source: SETTINGS_LOCAL_FILE, data: preflight.localSettings?.data },
  ];
  const redlineBypass = collectRedlineBypass(settingsSources);
  const sandboxWeakenings = collectSandboxWeakenings(settingsSources);
  const resultBase = {
    autonomy: true,
    source,
    probe,
    ...render,
    effectiveMode: preflight.effectiveMode,
    localMasks,
    redlineBypass,
    sandboxWeakenings,
    stamp: preflight.stamp,
    stampOk: preflight.stampOk,
  };
  if (!apply) return { wrote: false, dryRun: true, ...resultBase };

  if (!preflight.stampOk) {
    throw makeVelocityProfileError(
      VELOCITY_STAMP,
      `not a deployed agent-workflow project at lineage ${EXPECTED_WORKFLOW_VERSION} (found ${preflight.stamp ?? 'none'}) - run init/upgrade first`,
    );
  }
  const fs = fsDeps(deps);
  const settingsPath = join(projectDir, SETTINGS_FILE);
  if (preflight.claudeDirAbsent) fs.mkdir(join(projectDir, CLAUDE_DIR), { recursive: true });
  const merged = mergeAutonomySettings(preflight.projectSettings.data, render);
  fs.writeFile(settingsPath, formatJson(merged, preflight.projectSettings.eol ?? LF), UTF8);
  return { wrote: true, dryRun: false, settingsPath, mergedSettings: merged, ...resultBase };
};

// checkAutonomyProfile({ cwd }, deps) → the read-only drift-guard: recompute the render from
// docs/ai/autonomy.json + the probe, compare against the live .claude/settings.json blocks the render
// OWNS (sandbox.enabled / sandbox.autoAllowBashIfSandboxed / permissions.defaultMode / the render-owned
// red-line rules' array placement). Hand-edits OUTSIDE those blocks never flag (merge-don't-clobber
// boundary); a hand-edit INSIDE a render-owned block flags as drift naming the exact key. Refuses an
// absent policy loudly (nothing to check against).
export const checkAutonomyProfile = ({ cwd } = {}, deps = {}) => {
  const projectDir = cwd ?? deps.cwd ?? process.cwd();
  const readFile = deps.readFile ?? deps.readFileSync ?? readFileSync;
  const lstat = deps.lstat ?? deps.lstatSync ?? lstatSync;
  const { config, source } = loadAutonomy(projectDir, readFile, lstat);
  if (source === 'none' || config === null) {
    throw makeVelocityProfileError(VELOCITY_NO_POLICY, `no ${AUTONOMY_REL} to check against — seed a policy first (set-autonomy previews, then --write)`);
  }
  const render = renderAutonomySettings(resolveAutonomy(config), probeSandboxAvailability(deps));
  const settings = readSettingsFile(join(projectDir, SETTINGS_FILE), { ...deps, cwd: projectDir });
  const data = settings.present ? settings.data : {};
  const drift = [];
  const liveSandbox = isJsonObject(data[SANDBOX_KEY]) ? data[SANDBOX_KEY] : {};
  if (liveSandbox[SANDBOX_ENABLED_KEY] !== true) {
    drift.push(`${SANDBOX_KEY}.${SANDBOX_ENABLED_KEY}: expected true, found ${JSON.stringify(liveSandbox[SANDBOX_ENABLED_KEY])}`);
  }
  if (liveSandbox[SANDBOX_AUTOALLOW_KEY] !== render.sandbox[SANDBOX_AUTOALLOW_KEY]) {
    drift.push(`${SANDBOX_KEY}.${SANDBOX_AUTOALLOW_KEY}: expected ${render.sandbox[SANDBOX_AUTOALLOW_KEY]}, found ${JSON.stringify(liveSandbox[SANDBOX_AUTOALLOW_KEY])}`);
  }
  const perms = getPermissions(data);
  if (perms[DEFAULT_MODE_KEY] !== render.defaultMode) {
    drift.push(`permissions.${DEFAULT_MODE_KEY}: expected ${render.defaultMode}, found ${JSON.stringify(perms[DEFAULT_MODE_KEY])}`);
  }
  const liveAsk = Array.isArray(perms.ask) ? perms.ask : [];
  const liveDeny = Array.isArray(perms.deny) ? perms.deny : [];
  // Count occurrences (not includes()): a DUPLICATE render-owned rule is drift too — the render emits
  // each owned rule exactly once, so a re-apply would dedup it; the live block no longer matches.
  const countIn = (arr, rule) => arr.filter((e) => e === rule).length;
  for (const rl of COMMAND_REDLINES) {
    const rule = REDLINE_COMMAND_RULES[rl];
    const expectDeny = render.deny.includes(rule);
    const want = expectDeny ? 'deny' : 'ask';
    const other = expectDeny ? 'ask' : 'deny';
    const inExpected = countIn(expectDeny ? liveDeny : liveAsk, rule);
    const inOther = countIn(expectDeny ? liveAsk : liveDeny, rule);
    if (inExpected !== 1) drift.push(`permissions.${want}: expected exactly one ${rule} (redlines.${rl}=${want}), found ${inExpected}`);
    if (inOther !== 0) drift.push(`permissions.${other}: ${rule} present ${inOther}× but redlines.${rl}=${want} (belongs under ${want})`);
  }
  return { inSync: drift.length === 0, drift, source, level: render.level, settingsPresent: settings.present };
};

export const formatAutonomyCheck = (c) =>
  c.inSync
    ? `autonomy --check: IN SYNC — ${SETTINGS_FILE} matches the ${c.source} render (level ${c.level}).`
    : [
        `autonomy --check: DRIFT — ${SETTINGS_FILE} diverges from the ${c.source} render (level ${c.level}):`,
        ...c.drift.map((d) => `  ✗ ${d}`),
        `re-run \`velocity ${FLAG_AUTONOMY} ${FLAG_APPLY}\` to reconcile (only the render-owned blocks change).`,
      ].join(LF);

export const parseArgs = (argv) => {
  const parsed = argv.reduce(
    (state, arg, index, allArgs) => {
      if (state.skipNext) return { ...state, skipNext: false };
      if (arg === FLAG_HELP || arg === SHORT_FLAG_HELP) return { ...state, help: true };
      if (arg === FLAG_DRY_RUN) return { ...state, dryRunFlag: true };
      if (arg === FLAG_APPLY) return { ...state, apply: true };
      if (arg === FLAG_ACCEPT_EDITS) return { ...state, acceptEdits: true };
      if (arg === FLAG_KIT_TOOLS) return { ...state, kitTools: true };
      if (arg === FLAG_BRIDGE_TIER) return { ...state, bridgeTier: true };
      if (arg === FLAG_AUTONOMY) return { ...state, autonomy: true };
      if (arg === FLAG_CHECK) return { ...state, check: true };
      if (arg === FLAG_CWD) {
        const next = allArgs[index + 1];
        if (next === undefined || next.startsWith('-')) throw fail(EXIT_USAGE, `${FLAG_CWD} needs a directory argument`);
        return { ...state, cwd: next, skipNext: true };
      }
      if (arg.startsWith('-')) throw fail(EXIT_USAGE, `unknown flag: ${arg}`);
      throw fail(EXIT_USAGE, `unexpected argument: ${arg}`);
    },
    { help: false, dryRunFlag: false, apply: false, acceptEdits: false, kitTools: false, bridgeTier: false, autonomy: false, check: false, cwd: undefined, skipNext: false },
  );

  if (parsed.dryRunFlag && parsed.apply) throw fail(EXIT_USAGE, `${FLAG_DRY_RUN} and ${FLAG_APPLY} cannot be used together`);
  // The --autonomy render is a SEPARATE mode from the allowlist seeding: the allowlist-only flags
  // (--accept-edits sets defaultMode; --kit-tools seeds the kit tier) are meaningless under a
  // policy-driven render (defaultMode comes from the policy; --autonomy never seeds the allowlist).
  // Reject the mix LOUDLY rather than silently ignoring a flag.
  if (parsed.autonomy && parsed.acceptEdits) throw fail(EXIT_USAGE, `${FLAG_AUTONOMY} sets ${DEFAULT_MODE_KEY} from the policy — ${FLAG_ACCEPT_EDITS} (an allowlist-mode flag) cannot be combined with it`);
  if (parsed.autonomy && parsed.kitTools) throw fail(EXIT_USAGE, `${FLAG_KIT_TOOLS} is an allowlist-mode flag — it cannot be combined with ${FLAG_AUTONOMY} (a policy-only render)`);
  if (parsed.autonomy && parsed.bridgeTier) throw fail(EXIT_USAGE, `${FLAG_BRIDGE_TIER} is an allowlist-mode flag — it cannot be combined with ${FLAG_AUTONOMY} (a policy-only render)`);
  if (parsed.check && !parsed.autonomy) throw fail(EXIT_USAGE, `${FLAG_CHECK} is only valid with ${FLAG_AUTONOMY}`);
  if (parsed.check && parsed.apply) throw fail(EXIT_USAGE, `${FLAG_CHECK} is read-only — it cannot be combined with ${FLAG_APPLY}`);
  return {
    help: parsed.help,
    dryRun: parsed.apply ? false : true,
    apply: parsed.apply,
    acceptEdits: parsed.acceptEdits,
    kitTools: parsed.kitTools,
    bridgeTier: parsed.bridgeTier,
    autonomy: parsed.autonomy,
    check: parsed.check,
    cwd: parsed.cwd,
  };
};

export const main = (argv = process.argv.slice(2), deps = {}) => {
  const log = deps.log ?? console.log;
  const errlog = deps.errlog ?? console.error;
  try {
    const args = parseArgs(argv);
    if (args.help) {
      log(USAGE);
      return EXIT_OK;
    }
    const cwd = args.cwd ?? deps.cwd ?? process.cwd();
    // The --autonomy render is a separate mode from the allowlist seeding (policy → the render-owned
    // settings blocks); --check turns it into a read-only drift gate (exit 1 on drift).
    if (args.autonomy) {
      if (args.check) {
        const check = checkAutonomyProfile({ cwd }, deps);
        log(formatAutonomyCheck(check));
        return check.inSync ? EXIT_OK : EXIT_PRECONDITION;
      }
      const result = writeAutonomyProfile({ cwd, apply: args.apply }, deps);
      log(formatAutonomyResult(result));
      return EXIT_OK;
    }
    const result = writeVelocityProfile(
      { cwd, acceptEdits: args.acceptEdits, dryRun: args.dryRun, kitTools: args.kitTools, bridgeTier: args.bridgeTier },
      deps,
    );
    log(formatVelocityProfileResult(result));
    return EXIT_OK;
  } catch (err) {
    const exitCode = exitCodeFor(err);
    errlog(err?.message ?? String(err));
    if (exitCode === EXIT_USAGE) errlog(USAGE);
    return exitCode;
  }
};

export const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exit(main(process.argv.slice(2)));
