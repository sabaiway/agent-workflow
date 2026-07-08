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
//   5 malformed/invalid declaration · 6 bash unavailable · 7 --record asked but the gate-run
//   record could not be written. Gate `cmd` lines are BASH command lines (brace/glob expansion);
//   a host without bash gets the loud exit-6 preflight error, never a silent reinterpretation
//   under another shell.
//
// The runner itself WRITES NOTHING by default. `--record` (BUGFREE-2 / AD-048, D5) mints ONE
// v4 `gate-run` record — the green-baseline receipt the review-ledger writer's D5 tooth consumes —
// by DELEGATING to the ledger's sole writer (recordGateRun in review-ledger-write.mjs): this
// runner never opens the ledger file itself (an import/structure pin holds the boundary). The
// record carries the FULL declaration + exactly what ran (a --only subset records honestly as a
// subset — it never satisfies quality-green) + the tree fingerprint BEFORE and AFTER the run (a
// mutating gate attests no particular tree). Dependency-free, Node >= 18. No side effects on import.

import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { computeTreeFingerprint } from './review-state.mjs';
import { recordGateRun } from './review-ledger-write.mjs';
// (a) BUGFREE-3 / AD-049: the one-suite-run credit. The fold runner already spawned the `unit-tests`
// suite under coverage; --record can CREDIT that gate from the recorded evidence instead of
// re-spawning it minutes later — read-only (the read core, never the tree-toucher).
import { foldSuiteCredit } from './fold-completeness.mjs';

// The gate id the (a) credit applies to — the SAME command the fold runner resolves as its suite.
export const UNIT_TESTS_GATE_ID = 'unit-tests';

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
  // --record was asked for but the gate-run record could not be written (no in-flight loop, a
  // malformed ledger, an fs refusal): the invocation's contract included a ledger receipt — not
  // delivering it is its own loud outcome, never folded into ok/fail.
  recordFailed: 7,
});

// A tagged failure carrying its process exit code (the shared orchestration-config idiom).
export const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

const GATE_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const GATE_KEYS = Object.freeze(['id', 'title', 'cmd']);
const NO_FAILED_IDS = '-';
const SPAWN_FAILED_CODE = -1;
const MAX_GATE_OUTPUT_BYTES = 64 * 1024 * 1024;

const USAGE = [
  'usage: run-gates.mjs [--cwd <dir>] [--only <id>]... [--record] [--help]',
  '',
  `Runs the gates declared in <cwd>/${GATES_REL} (one bash command line each, project root as cwd).`,
  'Prints a per-gate PASS/FAIL table + one machine-readable summary line; exit 0 iff all green.',
  '--record additionally mints ONE v4 gate-run record into the review ledger via its sole writer',
  '(the D5 green-baseline receipt; needs a single in-flight plan): the full declaration + what ran',
  '+ the pre/post tree fingerprints. A red run records honestly; a --only subset records as a subset.',
  'In --record mode the unit-tests gate is CREDITED (not re-spawned) when it is the FIRST declared gate',
  'AND the fold-completeness runner already ran that EXACT command green at the current tree',
  '(fingerprint-bound + exit-0 + cmd-identity); positioned after another gate, it always re-spawns.',
  `Exit codes: 0 ok · 1 gate failure · 2 usage · 3 missing declaration · 4 empty gates list ·`,
  '5 malformed/invalid declaration · 6 bash unavailable · 7 --record asked but the record failed.',
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
// NODE_TEST_CONTEXT is stripped (mirroring the fold suite's childTestEnv): a `node --test` gate spawned
// while run-gates is itself running under a parent test context would otherwise inherit it, hit Node's
// recursive-run guard, silently skip every file, and exit 0 — a vacuous false green. Stripping it also
// makes the plain gate env-equivalent to the fold suite, so the (a) suite-run credit's exit-0 truthfully
// predicts a plain-spawn exit-0 (the one remaining, documented residual is NODE_V8_COVERAGE).
export const spawnGateViaBash = (cmd, cwd) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync('bash', ['-c', cmd], { cwd, env, encoding: 'utf8', maxBuffer: MAX_GATE_OUTPUT_BYTES });
};

// The command the bash preflight runs before ANY gate: proves bash itself spawns on this host,
// so "no bash" is one loud exit-6 error up front — never a per-gate spawn-failure cascade.
export const BASH_PROBE_CMD = 'true';

// ── run + report ──────────────────────────────────────────────────────────────────────

const formatSeconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const trimTrailingNewline = (text) => text.replace(/\n$/, '');

// Run the selected gates sequentially (declaration order). A green gate logs one PASS line; a
// failing gate logs FAIL + its captured stdout/stderr VERBATIM (triage without re-running).
export const runGates = (gates, { cwd, spawn = spawnGateViaBash, now = Date.now, log = console.log, credit = null }) => {
  const results = [];
  for (const gate of gates) {
    log(`── ${gate.id} — ${gate.title}`);
    // (a) the one-suite-run credit: for the unit-tests gate, if the fold runner already ran this exact
    // command green at the current tree, CREDIT it instead of re-spawning (no quality loss — same
    // execution, same tree, recorded once). Any mismatch → credit is null → the normal spawn below.
    const credited = credit ? credit(gate) : null;
    if (credited) {
      log('   PASS (credited from the fold-completeness suite run — no re-spawn)');
      results.push({ id: gate.id, title: gate.title, ok: true, code: 0, elapsedMs: 0, credited: true });
      continue;
    }
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
  const opts = { cwd: null, only: [], record: false, help: false };
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
    } else if (arg === '--record') {
      opts.record = true;
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
    env = process.env,
    log = console.log,
    logError = console.error,
    spawn = spawnGateViaBash,
    readFile,
    lstat,
    now,
    record = recordGateRun,
    fingerprint = computeTreeFingerprint,
    foldCredit = foldSuiteCredit,
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
    const fingerprintBefore = opts.record ? fingerprint(projectDir) : null;
    // (a) the one-suite-run credit — ONLY in --record mode (the fold-loop flow), ONLY the unit-tests
    // gate, ONLY when it is the FIRST selected gate (a gate that ran BEFORE it could have side-effected
    // an ignored/out-of-tree artifact unit-tests depends on WITHOUT moving the fingerprint, so a
    // later-positioned unit-tests must re-spawn — never credit a state the real matrix might fail), and
    // ONLY when the fold evidence is fingerprint-bound + exit-0 (foldCredit) AND its recorded cmd EQUALS
    // this gate's cmd (the --only-subset defense). Any mismatch → credit is null → the normal spawn.
    let credit = null;
    if (opts.record && selected[0]?.id === UNIT_TESTS_GATE_ID) {
      const fold = foldCredit({ cwd: projectDir, env, fingerprint: fingerprintBefore });
      credit = (gate) => (gate.id === UNIT_TESTS_GATE_ID && fold.credited && fold.evidence.cmd === gate.cmd ? fold : null);
    }
    const results = runGates(selected, { cwd: projectDir, spawn, log, now, credit });
    for (const line of formatTable(results)) log(line);
    const allGreen = results.every((result) => result.ok);
    // The gate-run record (D5): minted for green AND red runs alike (an honest red is telemetry
    // fuel), via the ledger's sole writer. Emitted BEFORE the summary line — the machine summary
    // stays the LAST line of every non-usage outcome (pinned).
    let recordError = null;
    if (opts.record) {
      const failing = results.filter((result) => !result.ok);
      try {
        const { writtenPath } = record({
          cwd: projectDir,
          env,
          declared: declaration.gates.map(({ id, cmd }) => ({ id, cmd })),
          results: results.map(({ id, ok, code }) => ({ id, ok, code })),
          summary: {
            status: allGreen ? 'ok' : 'fail',
            gates: results.length,
            passed: results.length - failing.length,
            failed: failing.length,
            failedIds: failing.map((result) => result.id),
          },
          fingerprintBefore,
          fingerprintAfter: fingerprint(projectDir),
        });
        log(`[run-gates] gate-run recorded → ${writtenPath}`);
      } catch (err) {
        recordError = err;
        logError(`[run-gates] --record failed: ${err.message}`);
      }
    }
    log(composeSummaryLine({ status: allGreen ? 'ok' : 'fail', results }));
    if (recordError) return EXIT.recordFailed;
    return allGreen ? EXIT.ok : EXIT.fail;
  } catch (err) {
    logError(`[run-gates] ${err.message}`);
    if (err.exitCode === EXIT.malformed) log(composeSummaryLine({ status: 'malformed' }));
    return err.exitCode ?? EXIT.fail;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = runCli(process.argv.slice(2));
