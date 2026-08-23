#!/usr/bin/env node
// mcp.mjs — the guarded writer behind `/agent-workflow-kit mcp`: registers the kit's stdio MCP
// server in ONE project, so the typed readers (`path_inventory`, `repo_search`) reach a deployed
// project instead of only the repo that built them. It writes exactly two files:
//   • `.mcp.json` at the project root — the `agent-workflow` stdio entry (command `node`, args = the
//     RUNNING kit's tools/mcp-server.mjs, absolute);
//   • `.claude/settings.json` — `enabledMcpjsonServers: ["agent-workflow"]` plus the two allow rules
//     derived from the server's own SERVER_NAME + TOOLS.
//
// Same family writer discipline as gate-hook.mjs, and the same reasons:
//   • preview-then-mutate — `--dry-run` is the DEFAULT and writes nothing; `--apply` writes;
//   • the ENTRY is printed BEFORE consent — a registration is a command the client will RUN, so the
//     exact structured value is on screen at the moment the decision is made, never described in
//     prose. It is re-serialized for the preview, so it is that VALUE and not those literal bytes;
//   • `.mcp.json` FIRST, then settings — settings enabling a server whose entry is not yet there
//     would be a client error on every startup;
//   • merge-don't-clobber — foreign servers, foreign settings keys and existing allow rules are
//     preserved; re-apply adds nothing twice; the file's EOL is kept;
//   • a same-name entry that STRUCTURALLY DIFFERS is REFUSED unwritten (key order is ignored, so a
//     re-serialized identical entry is the SAME registration) — silently changing what an MCP server
//     launches is exactly what consent must not slide past; the recovery is named;
//   • the preflight is READ-ONLY: an absent `.claude/` is a NAMED state, and the dir is created on
//     `--apply` only (assertCreatableDirSafe mkdirs, so it may not run in a preview);
//   • a MASKED target (an OS sandbox injects a character device where `.mcp.json` would be — this
//     repo is exactly that case) is not a failure: the kit hands over both paste-ready fragments,
//     writes nothing, and exits 0. Where it cannot write, it says precisely what it would have.
//   • never `settings.local.json`; never commits.
//
// The read half lives in mcp-registration.mjs, which the advisor and `uninstall` use — so what is
// there and what would be written are computed by one module, never by two that can disagree.
//
// Exit codes: 0 done / dry-run (incl. the hand-apply masked state); 1 precondition STOP; 2 usage.
// Dependency-free beyond the kit's own exports, Node >= 22. No side effects on import.

import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCreatableDirSafe, writeContainedFileAtomic } from './atomic-write.mjs';
import { isDirectRun } from './direct-run.mjs';
import {
  CLAUDE_DIR_REL,
  ENABLED_KEY,
  MCP_JSON_REL,
  SERVERS_KEY,
  SERVER_NAME,
  SETTINGS_REL,
  STATE,
  formatJson,
  mergeMcpJson,
  mergeSettings,
  readRegistration,
  renderFragments,
} from './mcp-registration.mjs';
import { shellQuoteArg } from './review-state.mjs';

const q = shellQuoteArg;

export const MCP_SYMLINK = 'MCP_SYMLINK';
export const MCP_MALFORMED = 'MCP_MALFORMED';
export const MCP_DIFFERS = 'MCP_DIFFERS';

const EXIT_OK = 0;
const EXIT_PRECONDITION = 1;
const EXIT_USAGE = 2;
const ERROR_PREFIX = '[agent-workflow-kit]';
const LF = '\n';
const JSON_INDENT = 2;

export const MCP_TOOL = fileURLToPath(import.meta.url);
export const applyMcpCommand = (root) => `node ${q(MCP_TOOL)} --apply --cwd ${q(root)}`;

const USAGE = `usage: mcp [--dry-run | --apply] [--cwd <dir>] [--help]

Registers this kit's stdio MCP server in ONE project: the "${SERVER_NAME}" entry in
${MCP_JSON_REL}, and "${ENABLED_KEY}" + the two tool allow rules in ${SETTINGS_REL}.
Default is --dry-run (a preview that prints the exact entry and writes nothing).
--apply writes: ${MCP_JSON_REL} first, then ${SETTINGS_REL}; merge-don't-clobber, EOL kept.

An existing "${SERVER_NAME}" entry that STRUCTURALLY DIFFERS is refused unwritten (key
order is ignored). Where ${MCP_JSON_REL} is a device node, FIFO or socket — an OS sandbox
mask is the usual cause — the entry to merge is printed and nothing is written.
Never writes settings.local.json; never commits.`;

export const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

export const makeMcpError = (code, message) =>
  Object.assign(new Error(`${ERROR_PREFIX} ${message}`), { name: 'McpError', code, exitCode: EXIT_PRECONDITION });

const lstatNoFollow = (path, lstat = lstatSync) => {
  try {
    return (lstat ?? lstatSync)(path);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
};

// ── preflight (READ-ONLY — it creates nothing, on either lane) ─────────────────────────

// A target we could not read or parse is never overwritten: a merge over a file whose current
// content is unknown is a clobber wearing a merge's name.
//
// `maskedAllowed` is TRUE for `.mcp.json` alone. That file has a sanctioned handoff — the kit hands
// over the entry for a human to merge from outside the sandbox — and `settings.json` has none, so a
// mask there is an ordinary refusal rather than a second, unplanned success path.
const assertTargetUsable = (target, { maskedAllowed = false } = {}) => {
  if (target.state === STATE.MASKED) {
    if (maskedAllowed) return;
    throw makeMcpError(
      MCP_SYMLINK,
      `${target.rel} is a ${target.className} (an OS sandbox device mask is the usual cause) — this mode can neither write it nor merge into what it cannot read`,
    );
  }
  if (target.state === STATE.FOREIGN) {
    throw makeMcpError(MCP_SYMLINK, `${target.rel} is a ${target.className} — refusing to write through it`);
  }
  if (target.state === STATE.MALFORMED) {
    throw makeMcpError(MCP_MALFORMED, `${target.rel} is ${target.reason} — refusing to overwrite it; fix or remove it, then re-run`);
  }
  if (target.state === STATE.UNREADABLE) {
    throw makeMcpError(MCP_MALFORMED, `${target.rel} cannot be read (${target.reason}) — refusing to overwrite what was never read`);
  }
};

export const preflightMcp = ({ cwd }, deps = {}) => {
  const root = resolve(cwd ?? deps.cwd ?? process.cwd());
  // The ROOT is judged BEFORE the registration is read, not merely before the first write: reading
  // first would follow the very link this refuses, which is exactly what the shipped claim denies.
  const rootStat = lstatNoFollow(root, deps.lstat);
  // A target that does not exist read as "a project with two absent files", so the preview offered an
  // apply that could only ENOENT. Both lanes refuse the same way, at the same point.
  if (rootStat === null) {
    throw makeMcpError(MCP_SYMLINK, `${root} does not exist — name an existing project directory`);
  }
  if (rootStat.isSymbolicLink()) {
    throw makeMcpError(MCP_SYMLINK, `${root} is a symlink — refusing to register into a symlinked project root`);
  }
  if (!rootStat.isDirectory()) {
    throw makeMcpError(MCP_SYMLINK, `${root} is not a directory — name an existing project directory`);
  }
  const registration = readRegistration(root, deps);
  // ORDER IS THE CONTRACT. Every OBSERVABLE surface is judged first — the container, both targets'
  // classes, then the entry itself — and only a run that survives all of them may reach the one
  // handoff this mode has. Taking the handoff early made a mask on ANY surface swallow the refusals
  // behind it: a differing entry and a malformed settings file both came back as a cheerful exit 0.
  const dir = registration.claudeDir;
  if (dir.state === STATE.FOREIGN) {
    throw makeMcpError(MCP_SYMLINK, `${dir.rel} is a ${dir.className} — refusing to write through it`);
  }
  if (dir.state === STATE.UNREADABLE) {
    throw makeMcpError(MCP_MALFORMED, `${dir.rel} cannot be inspected (${dir.reason}) — refusing to write into it`);
  }
  assertTargetUsable(registration.mcpJson, { maskedAllowed: true });
  assertTargetUsable(registration.settings);
  if (registration.mcpJson.differs) {
    throw makeMcpError(
      MCP_DIFFERS,
      `${MCP_JSON_REL} already carries an "${SERVER_NAME}" server entry that STRUCTURALLY DIFFERS from this kit copy's registration — refusing to change what it launches; review that entry and remove or rename it, then re-run`,
    );
  }
  const masked = registration.mcpJson.state === STATE.MASKED;
  return { root, registration, masked, plan: planMcp(registration) };
};

// The plan is pure over the registration: what is missing, and the exact body each file would get.
// Both bodies are built even when nothing is written — they ARE the preview and the hand-apply text.
export const planMcp = (registration) => ({
  writeMcpJson: !registration.mcpJson.matches,
  writeSettings: !registration.settings.complete,
  mcpBody: formatJson(mergeMcpJson(registration), registration.mcpJson.eol),
  settingsBody: formatJson(mergeSettings(registration), registration.settings.eol),
});

// ── the writer ─────────────────────────────────────────────────────────────────────────

export const writeMcp = ({ cwd, dryRun = true } = {}, deps = {}) => {
  const preflight = preflightMcp({ cwd: cwd ?? deps.cwd ?? process.cwd() }, deps);
  const base = { ...preflight, dryRun, wrote: false };
  if (preflight.masked) return { ...base, fragments: renderFragments(preflight.registration) };
  if (dryRun) return base;

  const { root, registration, plan } = preflight;
  const stop = (message) => makeMcpError(MCP_SYMLINK, message);
  if (plan.writeMcpJson) {
    writeContainedFileAtomic(root, registration.mcpJson.abs, plan.mcpBody, deps, { stop, label: MCP_JSON_REL });
  }
  if (plan.writeSettings) {
    // A settings failure AFTER the entry landed leaves a STANDING registration on disk that never
    // reaches formatResult — so the reconcile note has to ride the failure too, or a hidden
    // deployment is left with a visible `.mcp.json` and no mention of it anywhere.
    // The catch is around the WRITE, not inside it: a raw fs error (a failing rename) never passes
    // through the injected stop, and it is exactly the case that strands a standing registration.
    try {
      // The ONE write the preflight deliberately does not do: creating `.claude/` is a mutation, so
      // it belongs on the apply lane only — a preview that made a directory would not be a preview.
      assertCreatableDirSafe(join(root, CLAUDE_DIR_REL), deps, { stop, noun: SETTINGS_REL });
      writeContainedFileAtomic(root, registration.settings.abs, plan.settingsBody, deps, { stop, label: SETTINGS_REL });
    } catch (err) {
      // Reaching here always leaves a STANDING registration on disk — either this run wrote the
      // entry (`writeMcpJson`) or the preflight found it already current (`matches`), and those two
      // are exhaustive, so the note is unconditional rather than guarded by a branch nothing can
      // take. A differing entry never reaches the writer at all; it STOPs in the preflight.
      throw Object.assign(err, { message: `${err.message}\n${HIDDEN_MODE_LINE}` });
    }
  }
  return { ...base, wrote: plan.writeMcpJson || plan.writeSettings };
};

// ── the report ─────────────────────────────────────────────────────────────────────────

// A registration is an AI-tool footprint: `/.mcp.json` is in the known-footprint registry, so a
// HIDDEN deployment needs the reconcile before `git status` is clean again. Stated conditionally —
// this mode never detects visibility, and detecting it would widen what it reads.
const HIDDEN_MODE_LINE =
  'hidden-mode note: if this deployment is hidden, run the hide-footprint reconcile so the registration stays out of `git status` (the registry carries /.mcp.json).';

const POSTURE_LINE =
  'trust posture: the registered server is a READ-ONLY child of your MCP client (path/type/size/line facts and literal search over this project root) — it runs OUTSIDE the Bash sandbox, as the client itself does, and exposes no write or exec API. The two allow rules make its tool calls promptless; nothing else in this project changes.';

const indented = (text) => text.trimEnd().split(LF).map((line) => `    ${line}`).join(LF);

const mcpJsonLine = (result) => {
  if (!result.plan.writeMcpJson) return `  - ${MCP_JSON_REL}: already current`;
  const verb = result.dryRun ? 'would add' : 'added';
  return `  - ${MCP_JSON_REL}: ${verb} the "${SERVER_NAME}" stdio entry`;
};

const settingsLine = (result) => {
  const { registration, plan, dryRun } = result;
  if (!plan.writeSettings) return `  - ${SETTINGS_REL}: already current`;
  const parts = [];
  if (!registration.settings.enabled) parts.push(`"${ENABLED_KEY}" += "${SERVER_NAME}"`);
  if (registration.settings.allowMissing.length > 0) parts.push(`allow += ${registration.settings.allowMissing.join(', ')}`);
  return `  - ${SETTINGS_REL}: ${dryRun ? 'would set' : 'set'} ${parts.join(' · ')}`;
};

// The hand-apply text. The two halves are worded differently because the kit KNOWS different things
// about them: the settings body is a real merge over content it read, while the `.mcp.json` half is
// the entry ALONE — behind the mask this mode cannot see what that file already declares, and a
// whole-file body pasted as instructed would delete every server it could not see.
const maskedReport = (result) => {
  const target = result.registration.mcpJson;
  return [
    // The CLASS is what was observed; the sandbox mask is the usual CAUSE but is not established here.
    `agent-workflow MCP registration — HAND-APPLY: ${MCP_JSON_REL} is a ${target.className} (an OS sandbox device mask is the usual cause), so nothing was written.`,
    `  merge this entry into ${MCP_JSON_REL} under "${SERVERS_KEY}", and keep every other server it already declares (this mode cannot read them through the mask):`,
    indented(`"${SERVER_NAME}": ${result.fragments.mcpEntry.trimEnd()}`),
    `  merge into ${SETTINGS_REL} (that file was observable — and read where present — so this body already carries what is in it):`,
    indented(result.fragments.settings),
    POSTURE_LINE,
    HIDDEN_MODE_LINE,
  ].join(LF);
};

export const formatResult = (result) => {
  if (result.masked) return maskedReport(result);
  const nothingToDo = !result.plan.writeMcpJson && !result.plan.writeSettings;
  if (nothingToDo) {
    return [`agent-workflow MCP registration — already registered ("${SERVER_NAME}"); nothing to do.`, POSTURE_LINE, HIDDEN_MODE_LINE].join(LF);
  }
  const lines = [
    result.dryRun
      ? 'agent-workflow MCP registration — DRY RUN (no changes; re-run with --apply)'
      : 'agent-workflow MCP registration — APPLY',
    mcpJsonLine(result),
    settingsLine(result),
    '  the entry this registration declares (re-serialized here; the same structured value goes into the file):',
    indented(JSON.stringify(result.registration.entry, null, JSON_INDENT)),
    POSTURE_LINE,
    HIDDEN_MODE_LINE,
  ];
  if (result.dryRun) lines.push(`  to apply: ${applyMcpCommand(result.root)}`);
  return lines.join(LF);
};

// ── CLI ────────────────────────────────────────────────────────────────────────────────

export const parseArgs = (argv) => {
  const opts = { dryRunFlag: false, apply: false, cwd: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--dry-run') opts.dryRunFlag = true;
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '--cwd') {
      i += 1;
      // An EMPTY (or whitespace) value passes both guards above, and `resolve('')` silently means the
      // process cwd — so an explicit target of "" would write the registration wherever the tool
      // happened to run. An explicit argument that names nothing is a usage error, never a default.
      if (argv[i] === undefined || argv[i].startsWith('-') || argv[i].trim() === '') {
        throw fail(EXIT_USAGE, '--cwd needs a directory argument');
      }
      opts.cwd = argv[i];
    } else {
      throw fail(EXIT_USAGE, `unknown argument: ${arg}`);
    }
  }
  if (opts.dryRunFlag && opts.apply) throw fail(EXIT_USAGE, '--dry-run and --apply cannot be used together');
  return { help: opts.help, dryRun: !opts.apply, cwd: opts.cwd };
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
    log(formatResult(writeMcp({ cwd: args.cwd ?? deps.cwd ?? process.cwd(), dryRun: args.dryRun }, deps)));
    return EXIT_OK;
  } catch (err) {
    errlog(err?.message ?? String(err));
    if (err?.exitCode === EXIT_USAGE) errlog(USAGE);
    return err?.exitCode ?? EXIT_PRECONDITION;
  }
};

if (isDirectRun(import.meta.url)) process.exit(main(process.argv.slice(2)));
