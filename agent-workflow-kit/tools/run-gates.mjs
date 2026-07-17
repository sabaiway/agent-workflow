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
// The runner itself WRITES NOTHING on a plain run. `--final` (D3(a)) is the ONE writing mode:
// every attempt lands in the core-evidence store via its sole writer. Dependency-free.
// No side effects on import.

import { readFileSync, lstatSync, unlinkSync, realpathSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { computeTreeFingerprint } from './review-state.mjs';
// The D3(a) final receipt rides the core-evidence SOLE WRITER (the sole-writer boundary — this
// runner never opens the store itself) + the canonical per-kind serialization its hashes bind.
import { appendEvidenceRecord, resolveEvidencePath, readEvidence, canonicalKindSerialization, EVIDENCE_SCHEMA_VERSION } from './core-evidence.mjs';
import { LCOV_BASENAME } from './coverage-check.mjs';

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
  'usage: run-gates.mjs [--cwd <dir>] [--only <id>]... [--final] [--help]',
  '',
  '--final runs the FULL declared matrix as the D3(a) final verification run: it refuses a',
  'declaration lacking the canonical core checks (the review-state + coverage-check gates),',
  'deletes the stale git-dir lcov first, exports AW_GIT_DIR to every gate cmd, records EVERY',
  'attempt (start + completed green/red) in the core-evidence store, and binds the receipt to',
  '{ fingerprint before/after, the full declaration, per-gate results, the canonical red-proof +',
  'degrade evidence hashes, the lcov sha }. --final refuses --only (a subset never attests).',
  '',
  `Runs the gates declared in <cwd>/${GATES_REL} (one bash command line each, project root as cwd).`,
  'Prints a per-gate PASS/FAIL table + one machine-readable summary line; exit 0 iff all green.',
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
export const spawnGateViaBash = (cmd, cwd, extraEnv = {}) => {
  const env = { ...process.env, ...extraEnv };
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
  const opts = { cwd: null, only: [], final: false, help: false };
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
    } else {
      throw fail(EXIT.usage, `unknown argument "${arg}"\n${USAGE}`);
    }
  }
  if (opts.final && opts.only.length > 0) {
    throw fail(EXIT.usage, '--final refuses --only — a subset never attests (the D3(a) receipt binds the FULL declaration)');
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

// isFinalCapableDeclaration(gates, projectDir) → whether --final would accept this declaration
// (every canonical core check present + the checker LAST) — the ONE home consumers (the
// recommendations guard-install probe) read instead of re-deriving the rule.
export const isFinalCapableDeclaration = (gates, projectDir) => {
  if (!Array.isArray(gates) || gates.length === 0) return false;
  const missing = FINAL_CORE_CHECKS.filter((c) => !gates.some((g) => matchesCanonicalCheck(c, g.cmd, projectDir)));
  if (missing.length > 0) return false;
  return matchesCanonicalCheck(FINAL_CORE_CHECKS[1], gates[gates.length - 1].cmd, projectDir);
};
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

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
    const probe = spawn(BASH_PROBE_CMD, projectDir);
    if (probe.error && probe.error.code === 'ENOENT') {
      logError(
        '[run-gates] bash is not available on this host — gate cmd lines are BASH command lines ' +
          '(brace/glob expansion); refusing to silently reinterpret them under another shell. Install bash and re-run.',
      );
      log(composeSummaryLine({ status: 'no-bash' }));
      return EXIT.noBash;
    }
    // --final needs the pre-run fingerprint (the receipt binds before == after == current).
    const finalFingerprintBefore = opts.final ? fingerprint(projectDir) : null;
    const finalAttempt = opts.final ? randomUUID() : null;
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
        // Exactly ONE full machine line binds the receipt — an unanchored first-match would let
        // an injected/duplicated line shadow the real one and skip the end re-hash.
        const shaLineRe = /^coverage-check: lcov-sha256=([0-9a-f]{64}|none)$/;
        const shaLines = String(checkerRow?.stdout ?? '').split(/\r?\n/).filter((l) => shaLineRe.test(l));
        const shaValue = shaLines.length === 1 ? shaLineRe.exec(shaLines[0])[1] : null;
        const lcovSha256 = shaValue !== null && shaValue !== 'none' ? shaValue : null;
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
            evidenceHashes: endBroken
              ? startEvidenceHashes
              : {
                redProof: sha256Hex(canonicalKindSerialization(endRead.records, 'red-proof')),
                degrade: sha256Hex(canonicalKindSerialization(endRead.records, 'degrade')),
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
    log(composeSummaryLine({ status: allGreen ? 'ok' : 'fail', results }));
    if (finalError) return EXIT.finalFailed;
    return allGreen ? EXIT.ok : EXIT.fail;
  } catch (err) {
    logError(`[run-gates] ${err.message}`);
    if (err.exitCode === EXIT.malformed) log(composeSummaryLine({ status: 'malformed' }));
    return err.exitCode ?? EXIT.fail;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = runCli(process.argv.slice(2));
