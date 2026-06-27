// Velocity-profile pure core: a fixed, audited read-only allowlist that an onboarding step seeds
// into `.claude/settings.json` so an AI agent stops idling on approval prompts for routine read-only
// commands. No fs / no I/O here — this module is pure logic (the writer + CLI live elsewhere).
//
// Load-bearing invariant: the seeded allowlist must NEVER permit `git commit` / `git push` /
// `npm publish` — commit stays the single human approval checkpoint.

// The audited read-only core. Every entry is a Claude Code Bash allow pattern whose command performs
// NO write and NO arbitrary code execution through its own flags (verified empirically, not assumed):
// commands with an inline write/exec flag are deliberately EXCLUDED, e.g. `git grep`
// (`--open-files-in-pager=<cmd>` runs a program), `sort` (`-o` writes, `--compress-program=<cmd>`
// runs a program), `echo`/`find` (redirect-/`-delete`-writable), `gh` (`gh api` can POST),
// `node`/`npx`/`npm run`/`npm install`/`npm pack` (arbitrary/lifecycle code), bare `git`/`npm`.
// `git diff`/`git log`/`git show` are kept: their only residual is a BOUNDED WRITE via
// `--output=<file>` (the same class as shell output redirection, documented below), not code
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
]);

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
// full runtime closure (rejecting substitution + mutating commands at invocation) is the deferred
// PreToolUse hook (queue.md follow-up), not something settings-level allow rules can enforce.
export const SHELL_METACHARACTERS = Object.freeze([
  '&', '|', ';', '<', '>', '$', '`', '(', ')',
  '\n', '\r', '\t', '\\', '{', '}', '*', '?', '#', '~', '!',
]);

export const VELOCITY_OFFCORE = 'VELOCITY_OFFCORE';
export const VELOCITY_NON_READONLY = 'VELOCITY_NON_READONLY';
export const VELOCITY_INVALID_ARGUMENT = 'VELOCITY_INVALID_ARGUMENT';

const VELOCITY_ERROR_NAME = 'VelocityProfileError';
const ERROR_PREFIX = '[agent-workflow-kit]';
const BASH_ALLOW_PATTERN = /^Bash\((.+):\*\)$/u;
const WHITESPACE_PATTERN = /\s+/u;
const GIT_COMMAND = 'git';
const NPM_COMMAND = 'npm';
const NPM_RUN_COMMAND = 'npm run';
const DO_NOT_ADD_WARNING = 'do not add';
const ADD_BY_HAND = true;
const MUTATING_SCRIPT_NAME_PATTERN = /(release|publish|deploy|push|version|commit|tag)/iu;
const MUTATING_SCRIPT_HOOK_PATTERN = /^(pre|post)/iu;
// The one thing velocity must never seed — an explicit, greppable expression of the load-bearing
// invariant (kept deliberately even though the read-only screen already rejects these, so the
// refusal is named, tested, and produces a clear message).
const MUTATING_ALLOW_COMMAND_PATTERN = /^(?:git\s+(?:commit|push)|npm\s+publish)(?:\s|$)/iu;

export const makeVelocityProfileError = (code, message, fields = {}) =>
  Object.assign(new Error(`${ERROR_PREFIX} ${message}`), { name: VELOCITY_ERROR_NAME, code, ...fields });

const hasShellMetacharacter = (cmd) => SHELL_METACHARACTERS.some((ch) => cmd.includes(ch));

const tokenizeCommand = (cmd) => cmd.trim().split(WHITESPACE_PATTERN).filter(Boolean);

const getSubcommand = (tokens) => tokens.slice(1).join(' ');

const getBashAllowCommand = (pattern) => {
  if (typeof pattern !== 'string') return undefined;
  const match = pattern.match(BASH_ALLOW_PATTERN);
  return match ? match[1] : undefined;
};

const isSingleShellToken = (cmd, tokens) => tokens.length === 1 && cmd === tokens[0];

const isScriptMap = (scripts) => Boolean(scripts) && typeof scripts === 'object' && !Array.isArray(scripts);

const isMutatingScriptName = (name) =>
  MUTATING_SCRIPT_NAME_PATTERN.test(name) || MUTATING_SCRIPT_HOOK_PATTERN.test(name);

const makeGateCandidate = (name) => ({
  command: `${NPM_RUN_COMMAND} ${name}`,
  addByHand: ADD_BY_HAND,
  ...(isMutatingScriptName(name) ? { warn: DO_NOT_ADD_WARNING } : {}),
});

const matchesMutatingAllowCommand = (entry) => {
  const cmd = getBashAllowCommand(entry);
  return Boolean(cmd) && MUTATING_ALLOW_COMMAND_PATTERN.test(cmd.trim());
};

// `:*` is the trailing word-boundary wildcard: equivalent to a trailing ` *`, recognized only at the
// end of a pattern per Claude Code semantics.
export const screenAllowlistEntry = (pattern) => {
  const cmd = getBashAllowCommand(pattern);
  if (!cmd) return false;
  if (hasShellMetacharacter(cmd)) return false;

  const tokens = tokenizeCommand(cmd);
  if (tokens[0] === GIT_COMMAND) return GIT_READONLY_SUBCOMMANDS.includes(getSubcommand(tokens));
  if (tokens[0] === NPM_COMMAND) return NPM_READONLY_SUBCOMMANDS.includes(getSubcommand(tokens));
  return isSingleShellToken(cmd, tokens) && SHELL_READONLY.includes(cmd);
};

export const discoverGateCandidates = (packageJson) => {
  const scripts = packageJson?.scripts;
  if (!isScriptMap(scripts)) return [];
  return Object.keys(scripts).map(makeGateCandidate);
};

/**
 * Validate that what we are about to write is a subset of the audited read-only core: every entry
 * must (a) NOT be a commit/push/publish allow entry, (b) pass the read-only screen, and (c) be a
 * member of UNIVERSAL_READONLY_ALLOWLIST (a guard against the constant drifting). Pure; owns no exit
 * codes — a CLI maps the typed `.code` to a process exit.
 */
export const validateProfile = (allowEntries = UNIVERSAL_READONLY_ALLOWLIST) => {
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
    if (!UNIVERSAL_READONLY_ALLOWLIST.includes(entry)) {
      throw makeVelocityProfileError(VELOCITY_OFFCORE, `allow entry is outside the audited core: ${entry}`, { entry });
    }
  }

  return { ok: true, count: allowEntries.length };
};
