// gates-declaration.mjs — the gates.json declaration (load + strict validation) and the canonical
// checker predicate family (flow Plan 4 Phase 2, FLOW-READ-GRAPH-PURITY / the R10 rider). A LEAF
// below both run-gates.mjs and flow-store.mjs: run-gates re-exports the public surface (every
// historical consumer keeps its import site), and the locked subset-attempt factory imports the
// derivation DIRECTLY — re-deriving the pregate subset itself was blocked exactly by the
// run-gates↔flow-store import cycle this extraction removes. No CLI, no side effects on import,
// no fs writes. Dependency-free, Node >= 22.

import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, loadConfig, CONFIG_REL } from './orchestration-config.mjs';
import { matchesCoverageProducer } from './coverage-producer.mjs';

// The per-project declaration (strict JSON, hand-editable). cwd-relative — errors show a path the
// user can open (the orchestration-config CONFIG_REL idiom).
export const GATES_REL = 'docs/ai/gates.json';

// Parity: run-gates.mjs EXIT.malformed — its exit-code table stays the CLI authority (pinned by
// run-gates.test.mjs); this module throws the same tagged shape so the CLI surfaces it unchanged.
const EXIT_MALFORMED = 5;

const GATE_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const GATE_KEYS = Object.freeze(['id', 'title', 'cmd']);

// ── declaration validation (malformed → exit 5, loud `path: reason`) ─────────────────

// Validate a parsed gates.json object. Strict: only `_README` (string) + `gates` (array of
// { id, title, cmd }) are allowed; unknown keys anywhere are rejected loudly — the declaration
// names WHAT to check, never lanes/models/routing. Returns the validated gates array.
export const validateDeclaration = (parsed) => {
  const reject = (reason) => {
    throw fail(EXIT_MALFORMED, `${GATES_REL}: ${reason}`);
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
    throw fail(EXIT_MALFORMED, `${GATES_REL}: unreadable (${(err && err.code) || (err && err.message) || err})`);
  }
  let raw;
  try {
    raw = readFile(full, 'utf8');
  } catch (err) {
    throw fail(EXIT_MALFORMED, `${GATES_REL}: unreadable (${(err && err.code) || (err && err.message) || err})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw fail(EXIT_MALFORMED, `${GATES_REL}: malformed JSON (${err.message})`);
  }
  return { outcome: 'loaded', gates: validateDeclaration(parsed) };
};

// ── the canonical core-check matcher (STRICT full-command shape + realpath anchor) ────

// The canonical core checks a --final declaration must carry (D3(a)), matched as STRICT FULL
// commands: `node` + ONE (quoted or bare) path token + the exact tool basename + ` --check` +
// END — and the path token must REALPATH-RESOLVE to the kit's OWN tool (the canonical sibling of
// this runner). Masked forms (`--check --help`, `--check || true`, prefix commands) never match
// the shape; a lookalike file that merely carries the basename — whatever it prints — never
// resolves to the canonical tool. Any form that DOES resolve (bare, relative, absolute, quoted)
// is accepted, so the anchor adds no false refusals.
const coreCheckRe = (basename) => new RegExp(`^node\\s+(?:"((?:[^"]*[/\\\\])?${basename})"|((?:[^\\s"]*[/\\\\])?${basename}))\\s+--check$`);
export const FINAL_CORE_CHECKS = [
  { name: 'review-state', re: coreCheckRe('review-state\\.mjs'), canonical: fileURLToPath(new URL('./review-state.mjs', import.meta.url)) },
  { name: 'coverage-check', re: coreCheckRe('coverage-check\\.mjs'), canonical: fileURLToPath(new URL('./coverage-check.mjs', import.meta.url)) },
];
export const matchesCanonicalCheck = (check, cmd, projectDir) => {
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

// coverageProducerPrecedes(gates, checkerIndex) → whether a producer runs BEFORE the checker at that
// index. ORDER is the whole question: a producer declared AFTER the checker writes the lcov too late,
// so the checker reads nothing — or, worse, stale bytes an earlier run left behind — and still
// passes. ONE home for the rule: the written-declaration defects below and the advisor's
// inert-declaration item both decide through it, so they cannot drift apart.
export const coverageProducerPrecedes = (gates, checkerIndex) =>
  gates.slice(0, checkerIndex).some((gate) => matchesCoverageProducer(gate.cmd));

// coverageDeclarationDefects(gates, projectDir) → the WRITTEN-declaration coverage rule, as a list
// of named defects (empty = satisfied): at most ONE canonical coverage checker; if one is present
// it is LAST, and a producer precedes it. Consumers turn a defect into their own refusal — an
// offer-level check alone is not enough, because the declaration that gets WRITTEN is a merge of an
// existing file with a consented subset, and every one of these three shapes is reachable that way.
// Order is deliberate: a duplicate must be resolved before order or production can even be read.
export const coverageDeclarationDefects = (gates, projectDir) => {
  const checkers = canonicalCheckerGates(gates, projectDir);
  if (checkers.length > 1) {
    return [{
      kind: 'duplicate-checker',
      message:
        `${GATES_REL}: ${checkers.length} gates are the canonical coverage checker (${checkers.map((g) => g.id).join(', ')}) — ` +
        '--final accepts exactly one; keep a single checker and remove the rest',
    }];
  }
  if (checkers.length === 0) return []; // no checker declared — coverage is optional, nothing to enforce
  const index = gates.indexOf(checkers[0]);
  const after = gates.slice(index + 1);
  if (after.length > 0) {
    return [{
      kind: 'checker-not-last',
      message:
        `${GATES_REL}: the canonical coverage checker (${checkers[0].id}) must be the LAST declared gate — ` +
        `${after.map((g) => g.id).join(', ')} would run after it consumed the lcov. REORDER the declaration by hand ` +
        '(the gate itself is fine — this is an ORDERING refusal, and the fill is append-only, so it cannot reorder for you)',
    }];
  }
  if (!coverageProducerPrecedes(gates, index)) {
    return [{
      kind: 'no-producer',
      message:
        `${GATES_REL}: the canonical coverage checker (${checkers[0].id}) is declared but NO gate would produce the lcov it reads — ` +
        'the checker would pass while verifying nothing. Declare a suite gate carrying the coverage reporters ' +
        '(references/modes/gates.md names the exact form), or drop the checker',
    }];
  }
  return [];
};

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

// ── the pregate subset derivation (#66 / Decision 7 — ONE home for producer and factory) ─────

export const unknownPregateExcludeIds = (gates, exclude) => {
  const declaredIds = new Set(gates.map((gate) => gate.id));
  return exclude.filter((id) => !declaredIds.has(id));
};

// The derived --pre-review subset: the full declaration minus the DERIVED review-dependent gates
// minus a validated flow.pregateExclude — declaration order preserved.
export const derivePregateSubsetGates = (gates, exclude, projectDir) =>
  gates.filter((gate) => !isReviewDependentGate(gate, projectDir) && !exclude.includes(gate.id));

// derivePregateSubsetIds(cwd, io?) → the ordered gate-id array the subsetDigest is allowed to
// bind, derived from <cwd>'s declaration + orchestration config (the R10 rider consumer: the
// locked subset-attempt factory re-derives instead of trusting its caller). Throws the loud
// tagged failure on every underivable state — an underivable subset never mints an attempt.
export const derivePregateSubsetIds = (cwd, io = {}) => {
  const declaration = loadDeclaration(cwd, io);
  if (declaration.outcome === 'missing') {
    throw fail(EXIT_MALFORMED, `no gate declaration found at ${GATES_REL} — the pregate subset is underivable`);
  }
  const { config } = loadConfig(cwd);
  const exclude = config?.flow?.pregateExclude ?? [];
  const unknown = unknownPregateExcludeIds(declaration.gates, exclude);
  if (unknown.length > 0) {
    throw fail(EXIT_MALFORMED, `${CONFIG_REL} flow.pregateExclude names gate id(s) not declared in ${GATES_REL}: ${unknown.join(', ')} (declared: ${declaration.gates.map((gate) => gate.id).join(', ')})`);
  }
  return derivePregateSubsetGates(declaration.gates, exclude, cwd).map((gate) => gate.id);
};
