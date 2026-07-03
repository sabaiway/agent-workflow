import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// Velocity-profile core + writer: a fixed, audited read-only allowlist that an onboarding step seeds
// into `.claude/settings.json` so routine read-only commands stop idling on approval prompts.
//
// Load-bearing invariant: the seeded allowlist must NEVER permit `git commit` / `git push` /
// `npm publish` — commit stays the single human approval checkpoint.

// Deployment-lineage head this velocity build targets; bump together with agent-workflow-memory
// LINEAGE_HEAD when the deployed docs/ai structure changes.
export const EXPECTED_WORKFLOW_VERSION = '1.3.0';
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

const VELOCITY_ERROR_NAME = 'VelocityProfileError';
const ERROR_PREFIX = '[agent-workflow-kit]';
const BASH_ALLOW_PATTERN = /^Bash\((.+):\*\)$/u;
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
  'residual: seeded read-only allow entries are a trust-posture convenience, NOT a sandbox; settings-level rules cannot inspect runtime redirection/command-substitution/--output writes; commit/push/publish are never allowlisted (a DIRECT invocation still ASKs, but the runtime residual is not closed here); the residual guard ships as the opt-in PreToolUse hook — Mode: hook (/agent-workflow-kit hook).';

const USAGE = `usage: velocity-profile [--dry-run | --apply] [--accept-edits] [--cwd <dir>] [--help]

Seeds the fixed read-only Claude Code allowlist into .claude/settings.json.
Default is --dry-run. --apply writes; --accept-edits only sets defaultMode when applying.`;

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

const collectPreExistingNonReadonly = (sources) =>
  sources.flatMap(({ source, data }) =>
    getAllowEntries(data)
      .filter((entry) => typeof entry === 'string' && BASH_PERMISSION_PATTERN.test(entry))
      .filter((entry) => !screenAllowlistEntry(entry))
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

const mergeProjectSettings = (projectData, toAdd, acceptEdits) => {
  const base = projectData ?? {};
  const permissions = getPermissions(base);
  const allow = getAllowEntries(base);
  const mergedAllow = [...allow, ...toAdd.filter((entry) => !allow.includes(entry))];
  const mergedPermissions = {
    ...permissions,
    allow: mergedAllow,
    ...(acceptEdits === true ? { defaultMode: ACCEPT_EDITS_MODE } : {}),
  };
  return { ...base, permissions: mergedPermissions };
};

const formatEntryList = (entries) => (entries.length ? entries.map((entry) => `  - ${entry}`) : ['  - (none)']);

const formatAllowlist = (result) => [
  `${result.wrote ? 'added' : 'would add'} read-only core entries: ${result.toAdd.length}`,
  ...formatEntryList(result.toAdd),
  `already present: ${result.alreadyPresent.length}`,
];

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
    formatDefaultMode(result),
    ...formatGateAdvisory(result.gateCandidates),
    ...formatPreExistingAdvisory(result.preExistingNonReadonly),
    RESIDUAL_NOTICE,
  ].join(LF);

// Usage errors from `fail` carry an explicit exitCode (2); every other thrown error — including all
// VELOCITY_* precondition errors — maps to the precondition exit (1).
const exitCodeFor = (err) => err?.exitCode ?? EXIT_PRECONDITION;

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

  const preExistingNonReadonly = collectPreExistingNonReadonly([
    { source: SETTINGS_FILE, data: projectSettings.data },
    { source: SETTINGS_LOCAL_FILE, data: localSettings.data },
  ]);
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

export const planVelocityProfile = (preflight, { acceptEdits } = {}) => {
  const projectAllow = getAllowEntries(preflight.projectSettings?.data);
  const toAdd = UNIVERSAL_READONLY_ALLOWLIST.filter((entry) => !projectAllow.includes(entry));
  const alreadyPresent = UNIVERSAL_READONLY_ALLOWLIST.filter((entry) => projectAllow.includes(entry));
  return { toAdd, alreadyPresent, setsDefaultMode: acceptEdits === true };
};

export const writeVelocityProfile = ({ cwd, acceptEdits = false, dryRun = true } = {}, deps = {}) => {
  const projectDir = cwd ?? deps.cwd ?? process.cwd();
  const preflight = preflightVelocityProfile({ cwd: projectDir }, deps);
  const plan = planVelocityProfile(preflight, { acceptEdits });
  // Drift guard runs on BOTH dry-run and apply (so a dry-run faithfully predicts the apply) and
  // validates the FULL audited core, not just the to-add delta — a drifted core entry is caught even
  // when it is already present in the user's allow list (and toAdd is a subset of the core anyway).
  validateProfile();
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
  const merged = mergeProjectSettings(preflight.projectSettings.data, plan.toAdd, acceptEdits);
  fs.writeFile(settingsPath, formatJson(merged, preflight.projectSettings.eol ?? LF), UTF8);
  return { wrote: true, dryRun: false, settingsPath, ...resultBase };
};

export const parseArgs = (argv) => {
  const parsed = argv.reduce(
    (state, arg, index, allArgs) => {
      if (state.skipNext) return { ...state, skipNext: false };
      if (arg === FLAG_HELP || arg === SHORT_FLAG_HELP) return { ...state, help: true };
      if (arg === FLAG_DRY_RUN) return { ...state, dryRunFlag: true };
      if (arg === FLAG_APPLY) return { ...state, apply: true };
      if (arg === FLAG_ACCEPT_EDITS) return { ...state, acceptEdits: true };
      if (arg === FLAG_CWD) {
        const next = allArgs[index + 1];
        if (next === undefined || next.startsWith('-')) throw fail(EXIT_USAGE, `${FLAG_CWD} needs a directory argument`);
        return { ...state, cwd: next, skipNext: true };
      }
      if (arg.startsWith('-')) throw fail(EXIT_USAGE, `unknown flag: ${arg}`);
      throw fail(EXIT_USAGE, `unexpected argument: ${arg}`);
    },
    { help: false, dryRunFlag: false, apply: false, acceptEdits: false, cwd: undefined, skipNext: false },
  );

  if (parsed.dryRunFlag && parsed.apply) throw fail(EXIT_USAGE, `${FLAG_DRY_RUN} and ${FLAG_APPLY} cannot be used together`);
  return {
    help: parsed.help,
    dryRun: parsed.apply ? false : true,
    apply: parsed.apply,
    acceptEdits: parsed.acceptEdits,
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
    const result = writeVelocityProfile(
      { cwd: args.cwd ?? deps.cwd ?? process.cwd(), acceptEdits: args.acceptEdits, dryRun: args.dryRun },
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
