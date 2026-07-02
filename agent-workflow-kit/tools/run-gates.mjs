#!/usr/bin/env node
// run-gates.mjs — the generic project gate runner behind `/agent-workflow-kit gates`.
//
// A project declares its verification gates ONCE in docs/ai/gates.json (seeded from
// references/templates/gates.json — the orchestration.json pattern: bootstrap seeds it, upgrade
// ensures-if-missing, the file stays hand-editable). This runner batches them: read the
// declaration, run each gate as ONE bash command line from the project root, print a per-gate
// PASS/FAIL table plus ONE machine-readable summary line, and exit 0 iff every selected gate is
// green. A failing gate's own output is preserved verbatim (triage without re-running); a green
// gate's output is not echoed — the table + summary line are the report. `--only <id>`
// (repeatable) re-runs a subset; an unknown id is a loud usage error.
//
// The declaration names WHAT to check — never who executes it: the schema has no lane/model/
// routing fields and rejects unknown keys loudly. Trust posture (stated in the template _README
// too): the runner executes the project's OWN declared commands with the caller's privileges —
// a batching convenience over commands the project already runs by hand, not a sandbox.
//
// Honest outcomes — each distinct, never a silent green (the exit-code table + the summary-line
// schema are pinned by run-gates.test.mjs):
//   0 ok · 1 gate failure · 2 usage · 3 missing declaration · 4 empty gates list ·
//   5 malformed/invalid declaration · 6 bash unavailable. Gate `cmd` lines are BASH command
//   lines (brace/glob expansion); a host without bash gets the loud exit-6 preflight error,
//   never a silent reinterpretation under another shell.
//
// The runner itself WRITES NOTHING. Dependency-free, Node >= 18. No side effects on import.

import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// The per-project declaration (strict JSON, hand-editable). cwd-relative — errors show a path the
// user can open (the orchestration-config CONFIG_REL idiom).
export const GATES_REL = 'docs/ai/gates.json';

// The full exit-code table — one distinct code per honest outcome (never a silent green).
export const EXIT = Object.freeze({
  ok: 0,
  fail: 1,
  usage: 2,
  missing: 3,
  empty: 4,
  malformed: 5,
  noBash: 6,
});

// A tagged failure carrying its process exit code (the shared orchestration-config idiom).
export const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

const GATE_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const GATE_KEYS = Object.freeze(['id', 'title', 'cmd']);
const NO_FAILED_IDS = '-';
const SPAWN_FAILED_CODE = -1;
const MAX_GATE_OUTPUT_BYTES = 64 * 1024 * 1024;

const USAGE = [
  'usage: run-gates.mjs [--cwd <dir>] [--only <id>]... [--help]',
  '',
  `Runs the gates declared in <cwd>/${GATES_REL} (one bash command line each, project root as cwd).`,
  'Prints a per-gate PASS/FAIL table + one machine-readable summary line; exit 0 iff all green.',
  `Exit codes: 0 ok · 1 gate failure · 2 usage · 3 missing declaration · 4 empty gates list ·`,
  '5 malformed/invalid declaration · 6 bash unavailable.',
].join('\n');

// ── declaration validation (malformed → exit 5, loud `path: reason`) ─────────────────

// Validate a parsed gates.json object. Strict: only `_README` (string) + `gates` (array of
// { id, title, cmd }) are allowed; unknown keys anywhere are rejected loudly — the declaration
// names WHAT to check, never lanes/models/routing. Returns the validated gates array.
export const validateDeclaration = (parsed) => {
  const reject = (reason) => {
    throw fail(EXIT.malformed, `${GATES_REL}: ${reason}`);
  };
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    reject('must be a JSON object { "_README"?: string, "gates": [{ id, title, cmd }, ...] }');
  }
  for (const key of Object.keys(parsed)) {
    if (key !== '_README' && key !== 'gates') reject(`unknown top-level key "${key}" (allowed: _README, gates)`);
  }
  if (parsed._README !== undefined && typeof parsed._README !== 'string') reject('"_README" must be a string');
  if (!Array.isArray(parsed.gates)) reject('"gates" must be an array of { id, title, cmd }');
  const seenIds = new Set();
  parsed.gates.forEach((gate, index) => {
    const at = `gates[${index}]`;
    if (gate === null || typeof gate !== 'object' || Array.isArray(gate)) {
      reject(`${at}: must be an object { id, title, cmd }`);
    }
    for (const key of Object.keys(gate)) {
      if (!GATE_KEYS.includes(key)) {
        reject(`${at}: unknown key "${key}" (allowed: id, title, cmd — gates declare WHAT to check, never lane/model/routing)`);
      }
    }
    for (const key of GATE_KEYS) {
      if (typeof gate[key] !== 'string' || gate[key].trim() === '') {
        reject(`${at}: "${key}" must be a non-empty string`);
      }
    }
    if (/[\r\n]/.test(gate.cmd)) {
      reject(`${at}: "cmd" must be ONE bash command line — embedded newlines (a multi-line script) are rejected; chain with && or move the script into a file`);
    }
    if (!GATE_ID_RE.test(gate.id)) reject(`${at}: id "${gate.id}" must be kebab-case (lowercase [a-z0-9] groups separated by "-")`);
    if (seenIds.has(gate.id)) reject(`${at}: duplicate id "${gate.id}"`);
    seenIds.add(gate.id);
  });
  return parsed.gates;
};

// ── declaration IO ────────────────────────────────────────────────────────────────────

// Load the declaration from <cwd>/docs/ai/gates.json. A truly-absent file is the DISTINCT
// `missing` outcome (exit 3 upstream, with the recovery named) — never an error throw; anything
// present-but-unreadable / malformed / schema-invalid throws the loud exit-5 failure. lstat does
// not follow links, so a dangling symlink reads as present and its read failure surfaces loudly
// (no-silent-failures Hard Constraint — the loadConfig idiom).
export const loadDeclaration = (cwd, { readFile = readFileSync, lstat = lstatSync } = {}) => {
  const full = join(cwd, GATES_REL);
  try {
    lstat(full);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { outcome: 'missing' };
    throw fail(EXIT.malformed, `${GATES_REL}: unreadable (${(err && err.code) || (err && err.message) || err})`);
  }
  let raw;
  try {
    raw = readFile(full, 'utf8');
  } catch (err) {
    throw fail(EXIT.malformed, `${GATES_REL}: unreadable (${(err && err.code) || (err && err.message) || err})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw fail(EXIT.malformed, `${GATES_REL}: malformed JSON (${err.message})`);
  }
  return { outcome: 'loaded', gates: validateDeclaration(parsed) };
};

// ── gate selection (--only) ───────────────────────────────────────────────────────────

// Resolve the `--only` subset against the declared gates: declaration order is preserved,
// duplicates collapse, an unknown id is a LOUD usage error naming the declared ids.
export const selectGates = (gates, onlyIds) => {
  if (onlyIds.length === 0) return gates;
  const declared = new Set(gates.map((gate) => gate.id));
  const unknown = onlyIds.filter((id) => !declared.has(id));
  if (unknown.length > 0) {
    throw fail(
      EXIT.usage,
      `--only: unknown gate id(s): ${unknown.join(', ')} (declared: ${gates.map((gate) => gate.id).join(', ')})`,
    );
  }
  const wanted = new Set(onlyIds);
  return gates.filter((gate) => wanted.has(gate.id));
};

// ── the bash spawn (the ONE real-process boundary; injectable for hermetic tests) ─────

// Spawn one gate cmd via bash from the project root. `cmd` is a BASH command line by contract
// (the declaration's _README states it): this repo's own gate matrix needs brace+glob expansion,
// which /bin/sh does not perform — hence bash explicitly, never the platform default shell.
export const spawnGateViaBash = (cmd, cwd) =>
  spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', maxBuffer: MAX_GATE_OUTPUT_BYTES });

// The command the bash preflight runs before ANY gate: proves bash itself spawns on this host,
// so "no bash" is one loud exit-6 error up front — never a per-gate spawn-failure cascade.
export const BASH_PROBE_CMD = 'true';

// ── run + report ──────────────────────────────────────────────────────────────────────

const formatSeconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const trimTrailingNewline = (text) => text.replace(/\n$/, '');

// Run the selected gates sequentially (declaration order). A green gate logs one PASS line; a
// failing gate logs FAIL + its captured stdout/stderr VERBATIM (triage without re-running).
export const runGates = (gates, { cwd, spawn = spawnGateViaBash, now = Date.now, log = console.log }) => {
  const results = [];
  for (const gate of gates) {
    log(`── ${gate.id} — ${gate.title}`);
    const startedAt = now();
    const res = spawn(gate.cmd, cwd);
    const elapsedMs = now() - startedAt;
    const spawnError = res.error ? `spawn error: ${res.error.code || res.error.message}` : null;
    const ok = spawnError === null && res.status === 0;
    const code = spawnError === null ? res.status : SPAWN_FAILED_CODE;
    results.push({ id: gate.id, title: gate.title, ok, code, elapsedMs });
    if (ok) {
      log(`   PASS (${formatSeconds(elapsedMs)})`);
    } else {
      log(`   FAIL exit=${code} (${formatSeconds(elapsedMs)})`);
      if (res.stdout) log(trimTrailingNewline(res.stdout));
      if (res.stderr) log(trimTrailingNewline(res.stderr));
      if (spawnError) log(`   ${spawnError}`);
    }
  }
  return results;
};

// The per-gate PASS/FAIL table (printed after every gate ran — failures never stop the matrix).
export const formatTable = (results) => {
  const idWidth = Math.max(...results.map((result) => result.id.length), 'gate'.length);
  const pad = (text) => text + ' '.repeat(idWidth - text.length);
  const lines = ['', `${pad('gate')}  result`];
  for (const result of results) {
    lines.push(`${pad(result.id)}  ${result.ok ? 'PASS' : `FAIL (exit ${result.code})`}`);
  }
  return lines;
};

// The ONE machine-readable summary line — always the LAST line printed for every non-usage
// outcome. Schema (pinned by tests): status ∈ ok|fail|missing|empty|malformed|no-bash.
export const composeSummaryLine = ({ status, results = [] }) => {
  const passed = results.filter((result) => result.ok).length;
  const failed = results.filter((result) => !result.ok);
  const failedIds = failed.length > 0 ? failed.map((result) => result.id).join(',') : NO_FAILED_IDS;
  return `[run-gates] status=${status} gates=${results.length} passed=${passed} failed=${failed.length} failed_ids=${failedIds}`;
};

// ── CLI ───────────────────────────────────────────────────────────────────────────────

const parseArgs = (argv) => {
  const opts = { cwd: null, only: [], help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--cwd') {
      i += 1;
      if (argv[i] === undefined) throw fail(EXIT.usage, '--cwd requires a directory argument');
      opts.cwd = argv[i];
    } else if (arg === '--only') {
      i += 1;
      if (argv[i] === undefined) throw fail(EXIT.usage, '--only requires a gate id argument');
      opts.only.push(argv[i]);
    } else {
      throw fail(EXIT.usage, `unknown argument "${arg}"\n${USAGE}`);
    }
  }
  return opts;
};

// The full CLI, dependency-injected for hermetic tests. Returns the process exit code; the two
// output sinks split human-facing report (log) from error channel (logError). The summary line is
// emitted via `log` as the final line of every non-usage outcome.
export const runCli = (argv, deps = {}) => {
  const {
    cwd = process.cwd(),
    log = console.log,
    logError = console.error,
    spawn = spawnGateViaBash,
    readFile,
    lstat,
    now,
  } = deps;
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      log(USAGE);
      return EXIT.ok;
    }
    const projectDir = opts.cwd ?? cwd;
    const declaration = loadDeclaration(projectDir, { readFile, lstat });
    if (declaration.outcome === 'missing') {
      logError(`[run-gates] no gate declaration found at ${GATES_REL} — nothing was run.`);
      logError(
        `Recovery: create ${GATES_REL} from the gates.json template (references/templates/gates.json — ` +
          'bootstrap seeds it; /agent-workflow-kit upgrade re-seeds a missing one), declare { id, title, cmd } gates, re-run.',
      );
      log(composeSummaryLine({ status: 'missing' }));
      return EXIT.missing;
    }
    if (declaration.gates.length === 0) {
      logError(`[run-gates] ${GATES_REL} declares an empty "gates" list — nothing to run (add { id, title, cmd } entries).`);
      log(composeSummaryLine({ status: 'empty' }));
      return EXIT.empty;
    }
    const selected = selectGates(declaration.gates, opts.only);
    const probe = spawn(BASH_PROBE_CMD, projectDir);
    if (probe.error && probe.error.code === 'ENOENT') {
      logError(
        '[run-gates] bash is not available on this host — gate cmd lines are BASH command lines ' +
          '(brace/glob expansion); refusing to silently reinterpret them under another shell. Install bash and re-run.',
      );
      log(composeSummaryLine({ status: 'no-bash' }));
      return EXIT.noBash;
    }
    const results = runGates(selected, { cwd: projectDir, spawn, log, now });
    for (const line of formatTable(results)) log(line);
    const allGreen = results.every((result) => result.ok);
    log(composeSummaryLine({ status: allGreen ? 'ok' : 'fail', results }));
    return allGreen ? EXIT.ok : EXIT.fail;
  } catch (err) {
    logError(`[run-gates] ${err.message}`);
    if (err.exitCode === EXIT.malformed) log(composeSummaryLine({ status: 'malformed' }));
    return err.exitCode ?? EXIT.fail;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = runCli(process.argv.slice(2));
