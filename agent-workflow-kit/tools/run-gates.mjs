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
//   5 malformed/invalid declaration · 6 bash unavailable · 8 --final receipt not written.
//   Gate `cmd` lines are BASH command lines (brace/glob expansion); a host without bash gets the
//   loud exit-6 preflight error, never a silent reinterpretation under another shell.
//
// The runner itself WRITES NOTHING on a plain run. Two modes write state: `--final` (D3(a))
// records every attempt in the core-evidence store via its sole writer, and an ARMED
// `--pre-review` records its subset-attempt through the flow store's locked append factory
// (Plan 4 Decision 7/8 — an unarmed repo's `--pre-review` stays byte-unchanged, writing
// nothing). Both flow lanes resolve the CANONICAL git-derived store only — a SET AW_FLOW_STORE
// refuses up front. Dependency-free. No side effects on import.

import { readFileSync, lstatSync, unlinkSync, realpathSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { computeTreeFingerprint } from './review-state.mjs';
import { CONFIG_REL, loadConfig } from './orchestration-config.mjs';
// The D3(a) final receipt rides the core-evidence SOLE WRITER (the sole-writer boundary — this
// runner never opens the store itself) + the canonical per-kind serialization its hashes bind.
import { appendEvidenceRecord, resolveEvidencePath, readEvidence, canonicalKindSerialization, EVIDENCE_SCHEMA_VERSION, resolveBase } from './core-evidence.mjs';
// The Decision-7/8 recording lane (--pre-review under an ARMED flow) and the D10 flow→final
// binding (Plan 4): the subset attempt rides the flow store's locked append factory; the final
// receipt hashes the owner-scoped projection through the ONE shared pure helper.
import {
  resolveFlowStorePath, readFlowStore, deriveFlowOwner, walkChainState,
  appendSubsetAttempt, acquireSubsetRunLock, probeFlowAppendLock, subsetAttemptState, subsetExhaustionRemedy,
  SUBSET_ATTEMPT_MAX_REDS, SUBSET_ATTEMPT_DIAGNOSIS_REDS,
} from './flow-store.mjs';
import {
  CHAIN_KIND, validateChainSequence, validateSupersessions,
  subsetFoldBatchDigest, subsetGateIdsDigest, flowProjectionHash, SUBSET_ATTEMPT_DIAGNOSIS_FROM,
} from './flow-record.mjs';
import {
  LCOV_BASENAME,
  commitmentFor,
  ATTEST_NONCE_ENV,
  ATTEST_FINGERPRINT_ENV,
  ATTEST_BASE_ENV,
} from './coverage-check.mjs';

// The per-project declaration (strict JSON, hand-editable). cwd-relative — errors show a path the
// user can open (the orchestration-config CONFIG_REL idiom).
export const GATES_REL = 'docs/ai/gates.json';

// The full exit-code table — one distinct code per honest outcome (never a silent green).
// 7 is RETIRED (the deleted --record arm's outcome) — never reused for a new meaning.
export const EXIT = Object.freeze({
  ok: 0,
  fail: 1,
  usage: 2,
  missing: 3,
  empty: 4,
  malformed: 5,
  noBash: 6,
  // --final could not write its receipt (a corrupt store, an fs refusal): green gates WITHOUT a
  // written receipt never read as success (D3(a)).
  finalFailed: 8,
});

// A tagged failure carrying its process exit code (the shared orchestration-config idiom).
export const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

const GATE_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const GATE_KEYS = Object.freeze(['id', 'title', 'cmd']);
const NO_FAILED_IDS = '-';
const SPAWN_FAILED_CODE = -1;
const MAX_GATE_OUTPUT_BYTES = 64 * 1024 * 1024;

const USAGE = [
  'usage: run-gates.mjs [--cwd <dir>] [--only <id>]... [--final] [--pre-review [--diagnosis <text>]] [--help]',
  '',
  '--pre-review runs the DERIVED mechanical subset (#66): the full matrix minus every gate whose',
  'cmd is a canonical kit checker invocation (review-state / commit-guard / coverage-check /',
  'flow-check --check, resolved by realpath — never by gate id) minus a validated',
  'flow.pregateExclude from docs/ai/orchestration.json (an unknown exclude id refuses loudly).',
  'A failing subset gate gets the named review-dependent diagnosis. Under an ARMED flow (exactly',
  'one open adopted chain owned by this worktree) every subset run is RECORDED as a',
  'subset-attempt through the flow store\'s locked append factory; the counting context keys',
  '{planId, cycle, stepId, foldBatch, subsetDigest}. Hard stop (Decision 7/8): the run producing',
  'the SECOND red at a context completes, records, and exits red; the next attempt there needs',
  '--diagnosis "<non-empty, byte-distinct from the prior>" (a recorded, self-servable',
  'continuation — never a maintainer wait-state); after the THIRD red every further solo run',
  'refuses — no diagnosis reopens it; a recorded FRESH-EYES consult verdict does (a grounded',
  'bridge consult-attestation at this round context reopens exactly ONE further diagnosed',
  'attempt), else park the stuck work or open a fresh context (a new round, or a declared',
  'pregateExclude change). An unarmed repo is byte-unchanged; a spawn/declaration failure',
  'records NO attempt. Mutually exclusive with --only and --final.',
  '',
  '--final runs the FULL declared matrix as the D3(a) final verification run: it refuses a',
  'declaration lacking the canonical core checks (the review-state + coverage-check gates),',
  'deletes the stale git-dir lcov first, exports AW_GIT_DIR to every gate cmd, records EVERY',
  'attempt (start + completed green/red) in the core-evidence store, and binds the receipt to',
  '{ fingerprint before/after, the full declaration, per-gate results, the canonical red-proof +',
  'degrade evidence hashes, the lcov sha, and — when a flow store exists — evidenceHashes.flow,',
  'the owner-scoped flow projection hash (D10; projection movement under the run is a red',
  'integrityFailure) }. --final refuses --only (a subset never attests).',
  '',
  `Runs the gates declared in <cwd>/${GATES_REL} (one bash command line each, project root as cwd).`,
  'Prints a per-gate PASS/FAIL table + one machine-readable summary line; exit 0 iff all green.',
  '',
  'Producer env: AW_GIT_DIR (inside a git tree) and AW_LCOV_FILE (--final only) are computed and',
  'exported to every gate child, and STRIPPED from the inherited environment first — a host-set',
  'value never stands in for a computed one. A selected gate referencing a producer variable this',
  'run will not set is refused BEFORE anything spawns (exit 1), naming the gate, the variable, and',
  'the remedy — never left to expand to empty and fail far from its cause.',
  'Sandbox-safe: the runner itself needs no network and writes only repo-local state — the D4 sandbox',
  'lane; each DECLARED gate command is the project\'s own, so ITS sandbox-safety is command-shape',
  'dependent (first try the sandbox-safe shape — cache under $TMPDIR, offline/notifier off).',
  `Exit codes: 0 ok · 1 gate failure · 2 usage · 3 missing declaration · 4 empty gates list ·`,
  '5 malformed/invalid declaration · 6 bash unavailable ·',
  '8 --final asked but its receipt could not be written (green gates never read as success without it).',
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
// NODE_TEST_CONTEXT is stripped: a `node --test` gate spawned while run-gates is itself running
// under a parent test context would otherwise inherit it, hit Node's recursive-run guard, silently
// skip every file, and exit 0 — a vacuous false green.
// The variables this runner PRODUCES for gate children. They are stripped from the inherited
// environment before every spawn: composing the child env as {...process.env, ...injected} would
// let a stale or hostile HOST value stand in whenever this run injects nothing, so a gate would
// silently attest against the wrong git dir or lcov instead of the computed one.
export const RESERVED_PRODUCER_ENV = Object.freeze(['AW_GIT_DIR', 'AW_LCOV_FILE']);

// The attestation variables ride the same STRIP but are NOT producer variables: a producer variable
// is something a gate cmd may legitimately reference, and a missing one refuses the run up front.
// A capability is the opposite — no gate may reference it, exactly one gate is handed it, and every
// other child (and any descendant it spawns) must see it absent, host-set copies included, or that
// descendant could certify a foreign lcov later. Conflating the two lists made a gate that merely
// MENTIONS the name refuse the whole run.
export const RESERVED_CAPABILITY_ENV = Object.freeze([ATTEST_NONCE_ENV, ATTEST_FINGERPRINT_ENV, ATTEST_BASE_ENV]);

export const spawnGateViaBash = (cmd, cwd, extraEnv = {}) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const name of RESERVED_PRODUCER_ENV) delete env[name];
  for (const name of RESERVED_CAPABILITY_ENV) delete env[name];
  return spawnSync('bash', ['-c', cmd], { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', maxBuffer: MAX_GATE_OUTPUT_BYTES });
};

// A `$VAR` / `${VAR}` reference to a producer variable. A `${VAR:-default}` form is deliberately NOT
// matched — a cmd carrying its own fallback does not depend on the injection.
const referencesProducer = (cmd, name) => new RegExp(`\\$\\{${name}\\}|\\$${name}(?![A-Za-z0-9_])`).test(cmd);

const PRODUCER_RECOVERY = Object.freeze({
  AW_GIT_DIR: 'run from inside a git work tree — the runner resolves the git dir there and exports it to every gate.',
  AW_LCOV_FILE: 'AW_LCOV_FILE is produced only by --final — run with --final, or drop the reference from the gate cmd.',
});

// Which SELECTED gates reference a producer variable this run will not set. Such a reference
// expands to empty and fails the gate somewhere far from its cause, so it is refused before
// anything spawns, naming the gate, the variable, and the one remedy.
export const findUnmetProducerRefs = (gates, injected) =>
  gates.flatMap((gate) =>
    RESERVED_PRODUCER_ENV
      .filter((name) => !injected.includes(name) && referencesProducer(gate.cmd, name))
      .map((name) => ({ id: gate.id, name })));

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
    results.push({ id: gate.id, title: gate.title, ok, code, elapsedMs, stdout: res.stdout ? String(res.stdout) : '' });
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
  const opts = { cwd: null, only: [], final: false, preReview: false, diagnosis: null, help: false };
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
    } else if (arg === '--final') {
      opts.final = true;
    } else if (arg === '--pre-review') {
      opts.preReview = true;
    } else if (arg === '--diagnosis') {
      i += 1;
      if (argv[i] === undefined || argv[i].length === 0) throw fail(EXIT.usage, '--diagnosis requires a non-empty text argument (Decision 8 — the recorded continuation states a hypothesis)');
      opts.diagnosis = argv[i];
    } else {
      throw fail(EXIT.usage, `unknown argument "${arg}"\n${USAGE}`);
    }
  }
  if (opts.final && opts.only.length > 0) {
    throw fail(EXIT.usage, '--final refuses --only — a subset never attests (the D3(a) receipt binds the FULL declaration)');
  }
  if (opts.preReview && opts.only.length > 0) {
    throw fail(EXIT.usage, '--pre-review refuses --only — the subset is DERIVED from canonical checker paths, never hand-picked (P27)');
  }
  if (opts.preReview && opts.final) {
    throw fail(EXIT.usage, '--final refuses --pre-review — the final run attests the FULL declared matrix, never the derived subset (P27)');
  }
  if (opts.diagnosis !== null && !opts.preReview) {
    throw fail(EXIT.usage, '--diagnosis rides --pre-review only (Decision 8 — the diagnosed continuation of a subset hard stop)');
  }
  return opts;
};

// The canonical core checks a --final declaration must carry (D3(a)), matched as STRICT FULL
// commands: `node` + ONE (quoted or bare) path token + the exact tool basename + ` --check` +
// END — and the path token must REALPATH-RESOLVE to the kit's OWN tool (the canonical sibling of
// this runner). Masked forms (`--check --help`, `--check || true`, prefix commands) never match
// the shape; a lookalike file that merely carries the basename — whatever it prints — never
// resolves to the canonical tool. Any form that DOES resolve (bare, relative, absolute, quoted)
// is accepted, so the anchor adds no false refusals.
const coreCheckRe = (basename) => new RegExp(`^node\\s+(?:"((?:[^"]*[/\\\\])?${basename})"|((?:[^\\s"]*[/\\\\])?${basename}))\\s+--check$`);
const FINAL_CORE_CHECKS = [
  { name: 'review-state', re: coreCheckRe('review-state\\.mjs'), canonical: fileURLToPath(new URL('./review-state.mjs', import.meta.url)) },
  { name: 'coverage-check', re: coreCheckRe('coverage-check\\.mjs'), canonical: fileURLToPath(new URL('./coverage-check.mjs', import.meta.url)) },
];
const matchesCanonicalCheck = (check, cmd, projectDir) => {
  const m = check.re.exec(cmd.trim());
  if (!m) return false;
  const token = m[1] ?? m[2];
  const abs = isAbsolute(token) ? token : join(projectDir, token);
  try {
    return realpathSync(abs) === realpathSync(check.canonical);
  } catch {
    return false; // unresolvable → never canonical (fail closed)
  }
};

// canonicalCheckerGates(gates, projectDir) → every gate that IS the canonical coverage-check. The
// count is load-bearing twice over: --final refuses more than one (the attestation capability would
// reach more than one process) and this predicate must refuse the same declaration, or a consumer
// would advertise final-capability for a declaration --final then rejects.
export const canonicalCheckerGates = (gates, projectDir) =>
  gates.filter((g) => matchesCanonicalCheck(FINAL_CORE_CHECKS[1], g.cmd, projectDir));

// isFinalCapableDeclaration(gates, projectDir) → whether --final would accept this declaration
// (every canonical core check present + EXACTLY ONE canonical checker + that checker LAST) — the
// ONE home consumers (the recommendations guard-install probe, the worktrees report) read instead
// of re-deriving the rule.
export const isFinalCapableDeclaration = (gates, projectDir) => {
  if (!Array.isArray(gates) || gates.length === 0) return false;
  const missing = FINAL_CORE_CHECKS.filter((c) => !gates.some((g) => matchesCanonicalCheck(c, g.cmd, projectDir)));
  if (missing.length > 0) return false;
  if (canonicalCheckerGates(gates, projectDir).length !== 1) return false;
  return matchesCanonicalCheck(FINAL_CORE_CHECKS[1], gates[gates.length - 1].cmd, projectDir);
};
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

// The review-dependent predicate (#66/P14): a gate is review-dependent iff its cmd IS the plain
// canonical `--check` invocation of one of the kit's OWN checkers, resolved by realpath — never a
// project-authored id. A project abstracting the invocation behind its own script declares it in
// flow.pregateExclude (the mode doc states this plainly).
const REVIEW_DEPENDENT_CHECKS = ['review-state', 'commit-guard', 'coverage-check', 'flow-check'].map((name) => ({
  name,
  re: coreCheckRe(`${name}\\.mjs`),
  canonical: fileURLToPath(new URL(`./${name}.mjs`, import.meta.url)),
}));

export const isReviewDependentGate = (gate, projectDir) =>
  REVIEW_DEPENDENT_CHECKS.some((check) => matchesCanonicalCheck(check, gate.cmd, projectDir));

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
    fingerprint = computeTreeFingerprint,
    flowLockDeps = {},
  } = deps;
  // The Decision-7 subset-run lock (round-6 fold) — held across the WHOLE armed --pre-review
  // cycle; released exactly once on EVERY exit lane, BEFORE the machine summary composes
  // (round-7 fold: a custody violation must never print after the "last" line), loud always.
  let subsetRunLock = null;
  const releaseSubsetRunLock = () => {
    if (subsetRunLock == null) return null;
    const lock = subsetRunLock;
    subsetRunLock = null;
    const issue = lock.release();
    if (issue != null) logError(`[run-gates] --pre-review: ${issue.message}`);
    return issue;
  };
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
    let selected = selectGates(declaration.gates, opts.only);
    // --pre-review (#66, Decision 7): the full matrix minus the DERIVED review-dependent gates
    // minus a validated flow.pregateExclude. The orchestration config is loaded ONLY here — a
    // plain run and --final stay byte-neutral to it.
    let preReviewFlow = null;
    let preReviewUnarmedCheck = null;
    if (opts.preReview) {
      // loadConfig pins malformed config as exit 1; the summary-line contract still holds — the
      // machine line is the LAST line for every non-usage outcome (M5).
      let config;
      try {
        ({ config } = loadConfig(projectDir));
      } catch (err) {
        logError(`[run-gates] --pre-review: ${err.message}`);
        log(composeSummaryLine({ status: 'fail' }));
        return EXIT.fail;
      }
      const exclude = config?.flow?.pregateExclude ?? [];
      const declaredIds = new Set(declaration.gates.map((gate) => gate.id));
      const unknownExcludes = exclude.filter((id) => !declaredIds.has(id));
      if (unknownExcludes.length > 0) {
        throw fail(EXIT.malformed, `--pre-review: ${CONFIG_REL} flow.pregateExclude names gate id(s) not declared in ${GATES_REL}: ${unknownExcludes.join(', ')} (declared: ${declaration.gates.map((gate) => gate.id).join(', ')})`);
      }
      selected = declaration.gates.filter((gate) => !isReviewDependentGate(gate, projectDir) && !exclude.includes(gate.id));
      // Decision 7/8 (Plan 4): under an ARMED flow the subset run is a RECORDED attempt with a
      // hard-stop budget; an unarmed repo stays byte-unchanged (the compatibility floor). The
      // pre-gate checks here are the cheap honest half — the locked append factory re-derives
      // and re-checks everything under the lock at record time.
      const armedRefusal = (message) => {
        logError(`[run-gates] --pre-review: ${message}`);
        releaseSubsetRunLock();
        log(composeSummaryLine({ status: 'fail' }));
        return EXIT.fail;
      };
      // The recording lane resolves the CANONICAL git-derived store ONLY (round-5 fold): a SET
      // AW_FLOW_STORE — valid or not — could hide the armed store and bypass the hard-stop
      // budget, so it refuses up front, before any read, spawn, or write.
      if (env.AW_FLOW_STORE) {
        return armedRefusal('AW_FLOW_STORE is set — the --pre-review recording lane resolves the CANONICAL git-derived flow store only (an override could hide the armed store and bypass the hard-stop budget; fail closed): unset AW_FLOW_STORE and re-run');
      }
      let flowPath;
      try {
        flowPath = resolveFlowStorePath(projectDir, env);
      } catch (err) {
        return armedRefusal(`the flow store path cannot be resolved (${err.message}) — an undecidable armed state refuses the run (fail closed)`);
      }
      const flowRead = flowPath == null ? null : readFlowStore(flowPath);
      if (flowRead != null && (flowRead.readError != null || flowRead.malformed > 0)) {
        return armedRefusal(`the flow store is not readable (${flowRead.readError ?? `${flowRead.malformed} malformed line(s): ${flowRead.malformedReasons[0]}`}) — an undecidable armed state refuses the run (fail closed)`);
      }
      const armed = flowRead != null && flowRead.records.some((r) => r.kind === CHAIN_KIND && r.purpose === 'adoption');
      if (!armed && opts.diagnosis !== null) {
        return armedRefusal("--diagnosis rides an ARMED flow's recorded subset attempt — this repo's flow is unarmed (no adopted chain)");
      }
      // Round-11 fold: an UNARMED start stays lock-free (the byte-unchanged floor), but the
      // post-run re-check below closes the silent lane where an adoption lands mid-run and the
      // finished result would otherwise go unrecorded without a word.
      if (!armed && flowPath != null && flowRead != null) preReviewUnarmedCheck = { flowPath };
      if (armed) {
        // G1 (round-6 fold): the WHOLE preflight→gates→append cycle is serialized by the
        // subset-run lock — a parallel run would otherwise execute gates whose red can no
        // longer be recorded once the winner lands (an unrecorded red undercounts the budget).
        // The budget preflight below reads a FRESH snapshot taken AFTER acquisition, so a
        // queued run re-decides against whatever the winner recorded.
        try {
          subsetRunLock = acquireSubsetRunLock({ cwd: projectDir, env, deps: flowLockDeps });
        } catch (err) {
          return armedRefusal(`the subset-run lock could not be acquired (${err.message}) — a parallel --pre-review may be running, or a crashed one left its lock; nothing was run`);
        }
        const lockedRead = readFlowStore(flowPath);
        if (lockedRead.readError != null || lockedRead.malformed > 0) {
          return armedRefusal(`the flow store is not readable under the run lock (${lockedRead.readError ?? `${lockedRead.malformed} malformed line(s): ${lockedRead.malformedReasons[0]}`}) — fail closed`);
        }
        // Append-READINESS preflight (round-8 fold): every append-refusal lane knowable NOW
        // refuses BEFORE gates spend — store-wide supersession legality, the hard-link guard,
        // and the ordinary append-lock probe. What remains post-run is only concurrent
        // movement and raw I/O failure (stated residual — excluding those would mean holding
        // the append lock across the whole gate run).
        const lockedSup = validateSupersessions(lockedRead.records);
        if (!lockedSup.ok) {
          return armedRefusal(`the flow store cannot take the attempt append (${lockedSup.reason}) — fail closed before any gate spends`);
        }
        let storeLeaf = null;
        try {
          storeLeaf = lstatSync(flowPath);
        } catch (err) {
          if (!err || err.code !== 'ENOENT') {
            return armedRefusal(`cannot stat the flow store (${(err && err.code) || (err && err.message) || err}) — fail closed`);
          }
        }
        if (storeLeaf != null && storeLeaf.nlink !== 1) {
          return armedRefusal(`the flow store has ${storeLeaf.nlink} hard links — the append would refuse (two path-derived locks would race one inode); remove the extra links and re-run`);
        }
        try {
          probeFlowAppendLock({ cwd: projectDir, env, deps: flowLockDeps });
        } catch (err) {
          return armedRefusal(`the flow append lock is not acquirable (${err.message}) — the attempt could not have been recorded after the run; nothing was spent`);
        }
        const owner = deriveFlowOwner(projectDir);
        const openOwnPlanIds = [...new Set(lockedRead.records.filter((r) => r.kind === CHAIN_KIND).map((r) => r.planId))].filter((planId) => {
          const chain = lockedRead.records.filter((r) => r.kind === CHAIN_KIND && r.planId === planId);
          if (chain[0].purpose !== 'adoption' || chain[0].owner !== owner || !validateChainSequence(chain).ok) return false;
          const state = walkChainState(chain);
          return !state.completed && !state.parked;
        });
        if (openOwnPlanIds.length !== 1) {
          return armedRefusal(openOwnPlanIds.length === 0
            ? `the flow is armed but this worktree ("${owner}") owns no open (adopted, non-parked, non-complete) chain — an unrecordable subset run refuses (fail closed); adopt or resume the owning plan first`
            : `the flow is armed and this worktree ("${owner}") owns ${openOwnPlanIds.length} open chains (${openOwnPlanIds.join(', ')}) — the attempt's owning context is ambiguous; park or complete the others first (fail closed)`);
        }
        const chain = lockedRead.records.filter((r) => r.kind === CHAIN_KIND && r.planId === openOwnPlanIds[0]);
        const state = walkChainState(chain);
        if (state.stepId == null && state.openers.length > 0) {
          return armedRefusal(`the chain for plan "${openOwnPlanIds[0]}" sits at a post-convergence boundary — the stepId-null (adoption) context is legal only before the FIRST round (round-6 fold); open the next step round first, then re-run`);
        }
        const expected = { planId: openOwnPlanIds[0], cycle: state.cycle, stepId: state.stepId, round: state.round ?? 0 };
        const subsetIds = selected.map((gate) => gate.id);
        const { attempts, reds, exhausted, nextIndex } = subsetAttemptState(lockedRead.records, {
          planId: expected.planId, cycle: expected.cycle, stepId: expected.stepId,
          foldBatch: subsetFoldBatchDigest(expected), subsetDigest: subsetGateIdsDigest(subsetIds),
        });
        if (exhausted) {
          return armedRefusal(`this counting context (plan "${expected.planId}", cycle ${expected.cycle}, step ${expected.stepId ?? 'adoption context'}) already holds ${reds} red attempts — EXHAUSTED (two blind + one diagnosed, Decision 8): no diagnosis reopens it and no gates were run; ${subsetExhaustionRemedy}`);
        }
        if (reds >= SUBSET_ATTEMPT_DIAGNOSIS_REDS && opts.diagnosis === null) {
          return armedRefusal(`this counting context already recorded ${reds} red attempts — past the second red every attempt proceeds ONLY with a recorded diagnosis (Decision 8, never a maintainer wait-state): investigate, then re-run with --diagnosis '<a new hypothesis, byte-distinct from the prior attempt>'; no gates were run`);
        }
        // The distinctness pre-check mirrors the locked gate (which stays authoritative): a
        // replayed diagnosis must refuse BEFORE any gate spawns — the gates are never spent on
        // a run whose append is already known to refuse (round-4 fold).
        if (opts.diagnosis !== null && attempts.find((a) => a.attemptIndex === nextIndex - 1)?.diagnosis === opts.diagnosis) {
          return armedRefusal(`the supplied --diagnosis is byte-identical to the prior attempt's — a diagnosed continuation states a NEW hypothesis (Decision 8); re-run with --diagnosis '<a new hypothesis, byte-distinct from the prior attempt>'; no gates were run`);
        }
        if (nextIndex < SUBSET_ATTEMPT_DIAGNOSIS_FROM && opts.diagnosis !== null) {
          return armedRefusal(`attempt ${nextIndex} is inside the blind budget (attempts 1-2) — --diagnosis rides only attempt ${SUBSET_ATTEMPT_DIAGNOSIS_FROM} and later (Decision 8); the captured context may be stale, so it is refused, never silently dropped`);
        }
        const attemptFingerprint = fingerprint(projectDir);
        if (attemptFingerprint == null) {
          return armedRefusal('cannot compute the tree fingerprint — the recorded attempt binds {base, fingerprint} (fail closed)');
        }
        preReviewFlow = { expected, subsetIds, base: resolveBase(projectDir), fingerprint: attemptFingerprint, diagnosis: opts.diagnosis };
      }
    }
    // AW_GIT_DIR rides EVERY gate child inside a git tree (plain and --only alike): declared
    // cmds reference fixed git-dir artifacts (the unit-tests lcov destination) — a plain red-run
    // must exercise the SAME cmd line --final will, never a broken-only-outside---final variant.
    const dirRes = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: projectDir, windowsHide: true });
    const gitDir = dirRes.error || dirRes.status !== 0 ? null : dirRes.stdout.toString('utf8').replace(/\r?\n$/, '');
    let gateSpawn = gitDir === null ? spawn : (cmd, cwd2) => spawn(cmd, cwd2, { AW_GIT_DIR: gitDir });
    // ── --final preflight (D3(a)): the declaration must carry the canonical core checks; the TRUE
    // git dir resolves AW_GIT_DIR; the stale lcov dies BEFORE the suite so it is never consumed.
    if (opts.final) {
      const missing = FINAL_CORE_CHECKS.filter((c) => !declaration.gates.some((g) => matchesCanonicalCheck(c, g.cmd, projectDir)));
      if (missing.length > 0) {
        throw fail(EXIT.malformed, `--final refuses a weakened declaration — missing the canonical core check(s): ${missing.map((c) => c.name).join(', ')} (each must be ONE plain --check invocation of the kit's OWN tool in ${GATES_REL} — a masked form, a compound, or a lookalike path never counts)`);
      }
      // EXACTLY ONE canonical checker. Two gates may carry the same canonical cmd under different
      // ids, and the capability is handed to every match — so without this the "exactly one gate
      // holds it" guarantee is prose, and an extra copy would run with a live attestation context.
      const canonicalCheckers = canonicalCheckerGates(declaration.gates, projectDir);
      if (canonicalCheckers.length > 1) {
        throw fail(EXIT.malformed, `--final refuses the declaration — ${canonicalCheckers.length} gates are the canonical coverage-check (${canonicalCheckers.map((g) => JSON.stringify(g.id)).join(', ')}); exactly ONE may be, or the attestation context would be handed to more than one process`);
      }
      const lastGate = declaration.gates[declaration.gates.length - 1];
      if (!matchesCanonicalCheck(FINAL_CORE_CHECKS[1], lastGate.cmd, projectDir)) {
        throw fail(EXIT.malformed, `--final refuses the declaration — the CANONICAL coverage-check gate must be the LAST declared gate (nothing may run after the checker consumed the lcov; "${lastGate.id}" is declared last)`);
      }
      if (gitDir === null) throw fail(EXIT.fail, '--final needs a git work tree (cannot resolve the git dir)');
      try {
        unlinkSync(join(gitDir, LCOV_BASENAME)); // a stale lcov is never consumed
      } catch (err) {
        if (err.code !== 'ENOENT') {
          // Anything but "absent" leaves a readable stale artifact behind — fail closed BEFORE
          // the attempt starts (a swallowed delete error could fake coverage).
          logError(`[run-gates] --final could not delete the stale lcov at ${join(gitDir, LCOV_BASENAME)}: ${err.message} (fail closed)`);
          log(composeSummaryLine({ status: 'fail' }));
          return EXIT.finalFailed;
        }
      }
      // ONE lcov path for delete/check/hash/guard: the fixed git-dir file is FORCED into every
      // gate child env — a stray host AW_LCOV_FILE can never desync the checker from the receipt.
      gateSpawn = (cmd, cwd2) => spawn(cmd, cwd2, { AW_GIT_DIR: gitDir, AW_LCOV_FILE: join(gitDir, LCOV_BASENAME) });
    }
    const injectedEnv = [...(gitDir === null ? [] : ['AW_GIT_DIR']), ...(opts.final ? ['AW_LCOV_FILE'] : [])];
    const unmet = findUnmetProducerRefs(selected, injectedEnv);
    if (unmet.length > 0) {
      for (const { id, name } of unmet) {
        logError(`[run-gates] gate "${id}" references $${name}, which this run will not set — it would expand to empty and fail far from its cause.`);
        logError(`   Recovery: ${PRODUCER_RECOVERY[name]}`);
      }
      releaseSubsetRunLock();
      log(composeSummaryLine({ status: 'fail' }));
      return EXIT.fail;
    }
    const probe = spawn(BASH_PROBE_CMD, projectDir);
    if (probe.error && probe.error.code === 'ENOENT') {
      logError(
        '[run-gates] bash is not available on this host — gate cmd lines are BASH command lines ' +
          '(brace/glob expansion); refusing to silently reinterpret them under another shell. Install bash and re-run.',
      );
      releaseSubsetRunLock();
      log(composeSummaryLine({ status: 'no-bash' }));
      return EXIT.noBash;
    }
    // --final needs the pre-run fingerprint (the receipt binds before == after == current).
    const finalFingerprintBefore = opts.final ? fingerprint(projectDir) : null;
    const finalBase = opts.final ? resolveBase(projectDir) ?? '' : null;
    // The attestation handshake (see coverage-check.mjs): a fresh random nonce rides the child
    // environment, and the attempt id this run records is the one-way COMMITMENT over it plus the
    // identity. Persisting only the commitment is what makes the context unreproducible from the
    // repository afterwards — a plain recorded id is public, and attesting from one let an ordinary
    // interrupted run certify a later run's lcov. The commitment is also the only place the BASE is
    // bound, since no record stores it.
    const finalNonce = opts.final ? randomUUID() : null;
    const finalAttempt = opts.final ? commitmentFor(finalNonce, finalFingerprintBefore ?? '', finalBase) : null;
    if (opts.final) {
      // ONLY the canonical checker receives the capability — the same predicate the --final preflight
      // uses to recognise it. Every other gate gets the producer variables and nothing else.
      gateSpawn = (cmd, cwd2) => {
        const producers = { AW_GIT_DIR: gitDir, AW_LCOV_FILE: join(gitDir, LCOV_BASENAME) };
        if (!matchesCanonicalCheck(FINAL_CORE_CHECKS[1], cmd, projectDir)) return spawn(cmd, cwd2, producers);
        return spawn(cmd, cwd2, {
          ...producers,
          [ATTEST_NONCE_ENV]: finalNonce,
          [ATTEST_FINGERPRINT_ENV]: finalFingerprintBefore ?? '',
          [ATTEST_BASE_ENV]: finalBase,
        });
      };
    }
    // D10 (Plan 4 Decision 2): the flow→final binding — hash the OWNER-SCOPED projection at
    // final start, re-hash at final end (movement under the run = integrityFailure, the #64
    // mirror of the evidence-store arm), and carry the start hash on the receipt as
    // evidenceHashes.flow. Absent store → absent field; a broken store refuses the attempt
    // up front with ZERO writes (fail closed). Stated residual (round-2 disposition): the
    // re-hash→receipt-write window is open by construction (holding the flow lock across a
    // CORE-store append would couple two stores' locks) — an append landing in it yields a
    // green receipt whose stale binding the commit guard's LIVE comparison refuses, exactly
    // as it refuses a post-write append.
    let finalFlow = null;
    if (opts.final) {
      // The same canonical-lane rule as --pre-review (round-5 fold): a SET AW_FLOW_STORE could
      // bind the receipt to the wrong store — refuse BEFORE any flow read and BEFORE the
      // final-start evidence write (zero writes on this lane).
      if (env.AW_FLOW_STORE) {
        logError('[run-gates] --final: AW_FLOW_STORE is set — the flow→final binding resolves the CANONICAL git-derived flow store only (an override would bind the receipt to the wrong store; fail closed): unset AW_FLOW_STORE and re-run; nothing was recorded');
        log(composeSummaryLine({ status: 'fail' }));
        return EXIT.finalFailed;
      }
      let flowPath;
      try {
        flowPath = resolveFlowStorePath(projectDir, env);
      } catch (err) {
        logError(`[run-gates] --final: the flow store path cannot be resolved (${err.message}) — the flow→final binding fails closed; nothing was recorded`);
        log(composeSummaryLine({ status: 'fail' }));
        return EXIT.finalFailed;
      }
      const flowOwner = deriveFlowOwner(projectDir);
      const readFlowProjection = () => {
        if (flowPath == null) return { present: false, hash: null };
        let leaf = null;
        try {
          leaf = lstatSync(flowPath);
        } catch (err) {
          if (!err || err.code !== 'ENOENT') return { failure: `cannot stat the flow store (${(err && err.code) || (err && err.message) || err})` };
        }
        if (leaf == null) return { present: false, hash: null };
        if (flowOwner == null) return { failure: 'the owning worktree identity is unresolvable — the projection is owner-scoped' };
        const read = readFlowStore(flowPath);
        if (read.readError) return { failure: `the flow store is unreadable (${read.readError})` };
        if (read.malformed > 0) return { failure: `the flow store carries ${read.malformed} malformed line(s) (${read.malformedReasons[0]})` };
        return { present: true, hash: flowProjectionHash(read.records, { owner: flowOwner, currentFingerprint: finalFingerprintBefore }) };
      };
      const startFlow = readFlowProjection();
      if (startFlow.failure) {
        logError(`[run-gates] --final: ${startFlow.failure} — the flow→final binding fails closed; nothing was recorded`);
        log(composeSummaryLine({ status: 'fail' }));
        return EXIT.finalFailed;
      }
      finalFlow = { ...startFlow, recheck: readFlowProjection };
    }
    let finalError = null;
    let startEvidenceHashes = null;
    if (opts.final) {
      try {
        appendEvidenceRecord({
          path: resolveEvidencePath(projectDir, env),
          record: { schema: EVIDENCE_SCHEMA_VERSION, kind: 'final-start', fingerprint: finalFingerprintBefore, attempt: finalAttempt, timestamp: new Date().toISOString() },
        });
        // The drift tooth's anchor: the canonical red-proof/degrade serializations BEFORE any
        // gate runs — no legitimate writer appends those kinds DURING a final run, so any change
        // by receipt time is an integrity failure, never a green.
        const { records } = readEvidence(resolveEvidencePath(projectDir, env));
        startEvidenceHashes = {
          redProof: sha256Hex(canonicalKindSerialization(records, 'red-proof')),
          degrade: sha256Hex(canonicalKindSerialization(records, 'degrade')),
        };
      } catch (err) {
        // EVERY attempt is recorded — an unwritable store refuses the whole attempt up front
        // (green gates without a written receipt never read as success).
        logError(`[run-gates] --final could not record the attempt start: ${err.message}`);
        log(composeSummaryLine({ status: 'fail' }));
        return EXIT.finalFailed;
      }
    }
    const results = runGates(selected, { cwd: projectDir, spawn: gateSpawn, log, now });
    for (const line of formatTable(results)) log(line);
    const allGreen = results.every((result) => result.ok);
    if (opts.preReview) {
      // The named diagnosis (#66): review-dependence is derived, so an abstracted checker can only
      // surface as an ordinary failure — say so, and name the mechanical reset (#47: a declared
      // exclude changes the subsetDigest, so the counting context opens fresh).
      for (const failed of results.filter((result) => !result.ok)) {
        log(`[run-gates] "${failed.id}" failed under --pre-review — review-dependent? declare it in ${CONFIG_REL} flow.pregateExclude and the subset will skip it (a declared exclude opens a FRESH counting context — the subsetDigest changes)`);
      }
      // Round-11 fold: a run that STARTED unarmed re-checks arming after the gates — an
      // adoption landing mid-run makes the finished, unrecordable result a LOUD refusal,
      // never a silent plain exit (the stable unarmed repo stays byte-identical: one read,
      // zero writes, zero locks). An adoption landing after THIS check is the stated residual.
      if (preReviewFlow === null && preReviewUnarmedCheck !== null) {
        const endRead = readFlowStore(preReviewUnarmedCheck.flowPath);
        const armedNow = endRead.readError == null && endRead.malformed === 0
          && endRead.records.some((r) => r.kind === CHAIN_KIND && r.purpose === 'adoption');
        if (armedNow) {
          logError('[run-gates] --pre-review: the flow was ARMED while this run executed — the run started unarmed, so its result is NOT recorded (round-11 fold); re-run under the armed flow');
          log(composeSummaryLine({ status: 'fail', results }));
          return EXIT.fail;
        }
      }
      // Decision 7/8 (Plan 4): the recorded attempt. A spawn failure is an infrastructure
      // failure, not a gate red — it records NOTHING; an armed-but-unrecordable run refuses
      // (an unrecorded attempt would be a silent budget bypass).
      if (preReviewFlow !== null) {
        if (results.some((result) => result.code === SPAWN_FAILED_CODE)) {
          logError('[run-gates] --pre-review: a gate could not SPAWN — an infrastructure failure is not a gate red, so NO subset-attempt was recorded; fix the spawn failure and re-run');
          releaseSubsetRunLock();
          log(composeSummaryLine({ status: 'fail', results }));
          return EXIT.fail;
        }
        const attemptStatus = allGreen ? 'green' : 'red';
        try {
          const minted = appendSubsetAttempt({
            cwd: projectDir, env,
            expected: preReviewFlow.expected, subsetGateIds: preReviewFlow.subsetIds,
            status: attemptStatus, diagnosis: preReviewFlow.diagnosis,
            base: preReviewFlow.base, fingerprint: preReviewFlow.fingerprint,
            timestamp: new Date().toISOString(),
          });
          log(`[run-gates] pre-review subset attempt #${minted.attemptIndex} recorded (${attemptStatus}) → ${minted.writtenPath}`);
          if (attemptStatus === 'red' && minted.redsAtKey === 2) {
            log(`[run-gates] SECOND red at this counting context — the next attempt here proceeds ONLY with a recorded diagnosis (Decision 8, never a maintainer wait-state): investigate, then re-run with --diagnosis '<a new hypothesis, byte-distinct from the prior attempt>'. The budget is ${SUBSET_ATTEMPT_MAX_REDS} reds total; the third exhausts this context.`);
          }
          if (attemptStatus === 'red' && minted.exhaustedAfter) {
            log(minted.reopened
              ? `[run-gates] the REOPENED attempt went red (red attempt ${minted.redsAtKey} at this counting context) — the budget is exhausted AGAIN; ${subsetExhaustionRemedy}.`
              : `[run-gates] red attempt ${minted.redsAtKey} EXHAUSTS this counting context (the budget is spent: two blind + one diagnosed, Decision 8); no diagnosis reopens it. Instead, ${subsetExhaustionRemedy}.`);
          }
        } catch (err) {
          logError(`[run-gates] --pre-review: the subset attempt could not be recorded — ${err.message}`);
          logError("[run-gates] an armed flow's subset run IS a recorded attempt; an unrecordable run refuses (fail closed)");
          releaseSubsetRunLock();
          log(composeSummaryLine({ status: 'fail', results }));
          return EXIT.fail;
        }
      }
    }
    // A green gate's stdout is deliberately not echoed — the table IS the report. But the checker
    // exits 0 both when it certifies and when it WITHHOLDS a verdict, so on a plain run the table
    // would read PASS over a coverage claim that was never made: the same false reassurance one
    // layer up from the defect this whole mechanism exists to close. Surface it, and only it.
    if (!opts.final) {
      const checkerAt = selected.findIndex((gate) => matchesCanonicalCheck(FINAL_CORE_CHECKS[1], gate.cmd, projectDir));
      const checkerRow = checkerAt === -1 ? null : results[checkerAt];
      if (checkerRow?.ok && /^coverage-check: attested=no$/m.test(String(checkerRow.stdout ?? ''))) {
        log(`── ${checkerRow.id} — NO COVERAGE VERDICT (the gate passed; it did not certify)`);
        for (const line of String(checkerRow.stdout).split(/\r?\n/).filter((l) => /^coverage-check: (NO VERDICT|skipped-no-lcov)/.test(l))) log(line);
        log('   A coverage verdict is issued only by run-gates.mjs --final, which owns the lcov for the whole run.');
      }
    }
    if (opts.final) {
      // The checker's verbatim diagnostics surface even on green — skipped-no-lcov and the
      // out-of-domain/unsupported lists must never vanish into a suppressed green stdout.
      const checkerRow = results[results.length - 1];
      if (checkerRow?.ok && checkerRow.stdout) {
        log('── coverage-check diagnostics (verbatim)');
        log(trimTrailingNewline(checkerRow.stdout));
      }
      // The completed attempt (D3(a)): status green/red DERIVED from results + integrity, the
      // FULL declaration, the per-gate results, the evidence hashes over the CANONICAL
      // authoritative serializations, and the lcov sha the CHECKER printed for the bytes it
      // actually read — with an end re-hash agreement check (the checker's own children are the
      // one write window that survives "coverage-check runs last").
      try {
        const storePath = resolveEvidencePath(projectDir, env);
        const endRead = readEvidence(storePath);
        const endBroken = Boolean(endRead.readError) || (endRead.malformed ?? 0) > 0;
        let integrityFailure = null;
        if (endBroken) {
          integrityFailure = 'the evidence store became unreadable under the final run';
        } else {
          const endHashes = {
            redProof: sha256Hex(canonicalKindSerialization(endRead.records, 'red-proof')),
            degrade: sha256Hex(canonicalKindSerialization(endRead.records, 'degrade')),
          };
          if (endHashes.redProof !== startEvidenceHashes.redProof || endHashes.degrade !== startEvidenceHashes.degrade) {
            integrityFailure = 'the evidence store moved under the final run (the canonical red-proof/degrade serialization changed)';
          }
        }
        // The D10 movement arm: the OWNER-SCOPED projection must not move under the run — a
        // foreign worktree's append changes nothing here (it is outside the projection).
        if (integrityFailure === null && finalFlow !== null) {
          const endFlow = finalFlow.recheck();
          if (endFlow.failure) {
            integrityFailure = `the flow store became unreadable under the final run (${endFlow.failure})`;
          } else if (endFlow.present !== finalFlow.present || endFlow.hash !== finalFlow.hash) {
            integrityFailure = 'the flow store moved under the final run (the owner-scoped projection changed)';
          }
        }
        // Exactly ONE full machine line binds the receipt — an unanchored first-match would let
        // an injected/duplicated line shadow the real one and skip the end re-hash.
        const shaLineRe = /^coverage-check: lcov-sha256=([0-9a-f]{64}|none)$/;
        const shaLines = String(checkerRow?.stdout ?? '').split(/\r?\n/).filter((l) => shaLineRe.test(l));
        const shaValue = shaLines.length === 1 ? shaLineRe.exec(shaLines[0])[1] : null;
        const lcovSha256 = shaValue !== null && shaValue !== 'none' ? shaValue : null;
        // The attestation line, on the SAME exactly-one-anchored-line contract as the sha: a green
        // exit status alone never proves the checker certified anything — it exits 0 both when it
        // attests and when it withholds a verdict. Without this arm a gate that removed the start
        // record mid-run would yield a green receipt carrying no coverage claim at all.
        const attestLineRe = /^coverage-check: attested=(yes|no)$/;
        const attestLines = String(checkerRow?.stdout ?? '').split(/\r?\n/).filter((l) => attestLineRe.test(l));
        const attested = attestLines.length === 1 ? attestLineRe.exec(attestLines[0])[1] : null;
        if (allGreen && integrityFailure === null && lcovSha256 !== null) {
          if (attestLines.length !== 1) {
            integrityFailure = attestLines.length === 0
              ? 'the coverage-check gate printed no attested= line — whether coverage was certified is unknowable (fail closed)'
              : `the coverage-check gate printed ${attestLines.length} attested= lines — exactly ONE full machine line binds the receipt`;
          } else if (attested !== 'yes') {
            integrityFailure = 'the coverage-check gate consumed an lcov but did NOT certify it — the final run reached the checker without a valid attestation context';
          }
        }
        if (allGreen && integrityFailure === null) {
          if (shaLines.length !== 1) {
            integrityFailure = shaLines.length === 0
              ? 'the coverage-check gate printed no lcov-sha256 line — the consumed lcov is unknowable (fail closed)'
              : `the coverage-check gate printed ${shaLines.length} lcov-sha256 lines — exactly ONE full machine line binds the receipt`;
          } else if (lcovSha256 !== null) {
            let endSha = null;
            try {
              const st = lstatSync(join(gitDir, LCOV_BASENAME));
              if (st.isFile()) endSha = sha256Hex(readFileSync(join(gitDir, LCOV_BASENAME)));
            } catch { /* vanished → disagreement below */ }
            if (endSha !== lcovSha256) integrityFailure = 'the lcov moved under the checker (the end re-hash differs from the checker-read bytes)';
          }
        }
        const status = allGreen && integrityFailure === null ? 'green' : 'red';
        appendEvidenceRecord({
          path: storePath,
          record: {
            schema: EVIDENCE_SCHEMA_VERSION,
            kind: 'final',
            status,
            attempt: finalAttempt,
            fingerprintBefore: finalFingerprintBefore,
            fingerprintAfter: fingerprint(projectDir),
            declared: declaration.gates.map(({ id, cmd }) => ({ id, cmd })),
            results: results.map(({ id, ok, code }) => ({ id, ok, code })),
            evidenceHashes: {
              ...(endBroken
                ? startEvidenceHashes
                : {
                  redProof: sha256Hex(canonicalKindSerialization(endRead.records, 'red-proof')),
                  degrade: sha256Hex(canonicalKindSerialization(endRead.records, 'degrade')),
                }),
              ...(finalFlow?.present ? { flow: finalFlow.hash } : {}),
            },
            lcovSha256,
            integrityFailure,
            timestamp: new Date().toISOString(),
          },
        });
        if (integrityFailure) {
          finalError = new Error(integrityFailure);
          logError(`[run-gates] --final integrity failure: ${integrityFailure} — the receipt is RED`);
        }
        log(`[run-gates] final receipt recorded (${status}) → ${storePath}`);
        if (status === 'green' && lcovSha256 === null) {
          logError(`[run-gates] --final consumed NO lcov — the coverage arm ran skipped-no-lcov; the receipt records lcovSha256:null (the declared unit-tests gate must produce <git-dir>/${LCOV_BASENAME})`);
        }
      } catch (err) {
        finalError = err;
        logError(`[run-gates] --final could not write its receipt: ${err.message}`);
      }
    }
    // The summary line is the MACHINE report, so it must agree with the exit code: an integrity
    // failure mints a RED receipt and exits finalFailed, and a line still saying status=ok there
    // would be a silent green in the one place a reader parses instead of reads. The run lock
    // releases BEFORE the line composes so a custody violation can never hide behind status=ok.
    const runLockIssue = releaseSubsetRunLock();
    log(composeSummaryLine({ status: allGreen && finalError === null && runLockIssue == null ? 'ok' : 'fail', results }));
    if (finalError) return EXIT.finalFailed;
    if (runLockIssue != null) return EXIT.fail;
    return allGreen ? EXIT.ok : EXIT.fail;
  } catch (err) {
    releaseSubsetRunLock();
    logError(`[run-gates] ${err.message}`);
    if (err.exitCode === EXIT.malformed) log(composeSummaryLine({ status: 'malformed' }));
    return err.exitCode ?? EXIT.fail;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = runCli(process.argv.slice(2));
