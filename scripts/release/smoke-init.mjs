#!/usr/bin/env node
// smoke-init.mjs — the post-publish smoke harness (repo-local, tracked).
//
// Runs the REAL published installer — `npx @sabaiway/agent-workflow-kit@latest init` — inside a
// throwaway environment (temp HOME + temp project dir + temp npm cache) and asserts a provided
// expectation list against its output. The STATE-AWARE part deliberately stays with the agent:
// the caller chooses which lines to expect for this machine/registry state and reads the verdict;
// this harness only executes and matches deterministically.
//
//   node scripts/release/smoke-init.mjs --expect-line <substring> [--expect-line <substring>]...
//                                       [--expect-file <HOME-relative-path>=<substring>]...
//
// --expect-file asserts INSTALLED FILE CONTENT (a line match cannot see what landed on disk):
// the path is resolved against the sandbox HOME (never the host), and the file must contain the
// substring. Deterministic-first (AD-034): the release smoke asserts payload presence by script,
// not by eyeball.
//
// Isolation contract (pinned by smoke-init.test.mjs): the child runs with a SANITIZED env —
// HOME + npm cache point INTO the temp sandbox and every family/bridge override
// (`AGENT_WORKFLOW_*`, `*_MODEL`, `*_TIMEOUT`) is stripped — so the smoke can NEVER read or
// mutate the host's real installs (the deliberate real-machine `init` read is a separate,
// explicit release step, not this harness).
//
// Output: the observed line matched per expectation (verbatim), MISSING for an unmatched one;
// on any failure the full captured output is dumped for triage. Exit 0 iff the installer exited
// 0 AND every expectation matched; 1 otherwise; 2 usage. Dependency-free, Node >= 22.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const INSTALL_CMD = 'npx';
export const INSTALL_ARGS = Object.freeze(['-y', '@sabaiway/agent-workflow-kit@latest', 'init']);

// Env keys that must never leak into the sandboxed child: family overrides, bridge model/timeout
// overrides (they would repoint the installer or the bridges at host-local state), and EVERY npm
// config env override (`npm_config_*` / `NPM_CONFIG_*`, case-insensitive per npm's env parsing —
// e.g. NPM_CONFIG_USERCONFIG would point the child at the HOST's npm config despite the temp
// HOME). The sandbox then sets its own npm_config_cache; userconfig defaults to $HOME/.npmrc,
// which the temp HOME already isolates.
const STRIP_ENV_RE = /^AGENT_WORKFLOW_|^npm_config_|_(MODEL|TIMEOUT)$/i;

export const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

// PURE: the sanitized child env — the host env minus every stripped override, with HOME and the
// npm cache repointed into the sandbox (npm reads .npmrc from $HOME, so a temp HOME isolates
// user-level npm config too).
export const buildSanitizedEnv = (baseEnv, { home, npmCache }) => {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (STRIP_ENV_RE.test(key)) continue;
    env[key] = value;
  }
  env.HOME = home;
  env.npm_config_cache = npmCache;
  return env;
};

// PURE: match each expectation (substring) against the captured output lines.
export const matchExpectations = (outputText, expectations) => {
  const lines = outputText.split('\n');
  return expectations.map((expected) => {
    const matched = lines.find((line) => line.includes(expected));
    return { expected, matched: matched ?? null };
  });
};

// PURE parse of one --expect-file value: `<HOME-relative-path>=<substring>`, split on the FIRST
// `=` (the substring may itself carry one). The path must stay sandbox-HOME-relative — an
// absolute or `..`-traversing path could read the HOST filesystem, breaking the isolation contract.
export const parseFileExpectation = (raw) => {
  const eq = raw.indexOf('=');
  if (eq <= 0 || eq === raw.length - 1) {
    throw fail(2, '--expect-file requires <sandbox-HOME-relative path>=<non-empty substring>');
  }
  const rel = raw.slice(0, eq);
  const substring = raw.slice(eq + 1);
  // Reject BOTH path dialects (win32.isAbsolute also covers `/x` and `C:\x`; `..` is checked per
  // segment across / and \) — a host-absolute or traversing path would escape the sandbox HOME.
  if (isAbsolute(rel) || win32.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    throw fail(2, `--expect-file path must stay sandbox-HOME-relative (got "${rel}")`);
  }
  return { rel, substring };
};

// Match each file expectation against the sandbox HOME: 'ok' (file present + substring found),
// 'no-match' (present, substring absent), 'absent' (unreadable/missing). Injectable read.
export const matchFileExpectations = (home, fileExpectations, readFile = readFileSync) =>
  fileExpectations.map(({ rel, substring }) => {
    try {
      const content = readFile(join(home, rel), 'utf8');
      return { rel, substring, state: content.includes(substring) ? 'ok' : 'no-match' };
    } catch {
      return { rel, substring, state: 'absent' };
    }
  });

const USAGE =
  'usage: smoke-init.mjs [--expect-line <substring>]... [--expect-file <HOME-relative-path>=<substring>]... [--keep] (at least one expectation)';

const parseArgs = (argv) => {
  const opts = { expectations: [], fileExpectations: [], keep: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--expect-line') {
      i += 1;
      if (argv[i] === undefined || argv[i] === '') throw fail(2, '--expect-line requires a non-empty substring');
      opts.expectations.push(argv[i]);
    } else if (arg === '--expect-file') {
      i += 1;
      if (argv[i] === undefined || argv[i] === '') throw fail(2, '--expect-file requires a non-empty <path>=<substring>');
      opts.fileExpectations.push(parseFileExpectation(argv[i]));
    } else {
      throw fail(2, `unknown argument "${arg}"\n${USAGE}`);
    }
  }
  if (!opts.help && opts.expectations.length === 0 && opts.fileExpectations.length === 0) {
    throw fail(2, `at least one --expect-line or --expect-file is required (a smoke with no expectations proves nothing)\n${USAGE}`);
  }
  return opts;
};

const execDefault = (cmd, args, { cwd, env }) =>
  spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

export const runCli = (argv, deps = {}) => {
  const { log = console.log, logError = console.error, exec = execDefault, baseEnv = process.env } = deps;
  const sandboxes = [];
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      log(USAGE);
      return 0;
    }
    const home = mkdtempSync(join(tmpdir(), 'smoke-init-home-'));
    const npmCache = mkdtempSync(join(tmpdir(), 'smoke-init-cache-'));
    const project = mkdtempSync(join(tmpdir(), 'smoke-init-project-'));
    sandboxes.push(home, npmCache, project);

    const env = buildSanitizedEnv(baseEnv, { home, npmCache });
    log(`[smoke-init] sandbox: HOME=${home} project=${project}`);
    log(`[smoke-init] running: ${INSTALL_CMD} ${INSTALL_ARGS.join(' ')}`);
    const res = exec(INSTALL_CMD, INSTALL_ARGS, { cwd: project, env });
    const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    const installerFailed = res.status !== 0 || res.error;

    const results = matchExpectations(output, opts.expectations);
    const missing = results.filter((result) => result.matched === null);
    for (const result of results) {
      if (result.matched !== null) log(`[smoke-init] ✓ ${result.matched.trim()}`);
      else logError(`[smoke-init] ✗ MISSING expected line containing: "${result.expected}"`);
    }
    const fileResults = matchFileExpectations(home, opts.fileExpectations, deps.readFile ?? readFileSync);
    const fileMisses = fileResults.filter((result) => result.state !== 'ok');
    for (const result of fileResults) {
      if (result.state === 'ok') log(`[smoke-init] ✓ file ${result.rel} contains "${result.substring}"`);
      else if (result.state === 'absent') logError(`[smoke-init] ✗ file ${result.rel} is absent (or unreadable) in the sandbox HOME`);
      else logError(`[smoke-init] ✗ file ${result.rel} does not contain: "${result.substring}"`);
    }
    if (installerFailed) {
      logError(`[smoke-init] installer exited ${res.error ? `with spawn error ${res.error.code}` : res.status}`);
    }
    const totalExpectations = opts.expectations.length + opts.fileExpectations.length;
    if (installerFailed || missing.length > 0 || fileMisses.length > 0) {
      logError('[smoke-init] full captured output follows:');
      logError(output.trimEnd());
      log(`[smoke-init] FAIL — ${missing.length + fileMisses.length}/${totalExpectations} expectation(s) missing${installerFailed ? ', installer non-zero' : ''}`);
      return 1;
    }
    log(`[smoke-init] PASS — all ${totalExpectations} expectation(s) matched.`);
    return 0;
  } catch (err) {
    logError(`[smoke-init] ${err.message}`);
    return err.exitCode ?? 1;
  } finally {
    const keep = argv.includes('--keep');
    if (!keep) {
      for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
    } else if (sandboxes.length > 0) {
      log(`[smoke-init] --keep: sandbox dirs retained (${sandboxes.join(', ')})`);
    }
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = runCli(process.argv.slice(2));
