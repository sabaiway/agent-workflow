#!/usr/bin/env node
// migrate-gates.mjs — the consented LEGACY gates.json migration (strip-the-kit D8). A deployment
// that predates the hardened core declares gates the stripped kit no longer ships (the
// review-ledger / fold-completeness checks); this tool migrates the declaration ATOMICALLY and
// COMPLETELY in one consented step: it REMOVES the canonical legacy entries, EXTENDS the
// canonical `unit-tests` cmd with the built-in lcov reporters (the D3(d) coverage source), and
// ADDS the coverage-check gate LAST (removal alone is not a migration — the result must satisfy
// `run-gates --final` and carry a working commit path). The checker is added ONLY over a
// declaration that PRODUCES the lcov it reads; with no producer it is WITHHELD with a loud
// warning, because a checker with no producer passes (`skipped-no-lcov`) while verifying nothing.
//
// Matching is by the DOCUMENTED cmd forms ONLY (hand-wired history included — never by seed
// provenance): a legacy entry is `node <path>/review-ledger.mjs --check` or
// `node <path>/fold-completeness.mjs --check` (quoted or bare path, ONE plain invocation); the
// canonical unit-tests entry is id `unit-tests` with a cmd starting `node --test `. ANYTHING
// else is a CUSTOMIZED entry — never auto-touched: the preview reports it loudly and prints the
// paste-ready recovery so the maintainer applies the intent by hand; the commit guard is NOT to
// be installed until the declaration is final-run-capable.
//
// Write discipline (the family's consented-writer contract): preview (dry-run) is the DEFAULT
// and writes NOTHING; `--apply` rewrites docs/ai/gates.json via exclusive tmp+rename in the same
// directory; a symlinked gates.json (or docs/ai parent) is a STOP; a malformed declaration is
// never written over. `--kit-tools <dir>` names the installed kit's tools directory — the
// migration writes RESOLVED, QUOTED paths for the coverage-check gate (no runtime guessing).
//
// Exit codes: 0 done / preview / nothing-to-migrate; 1 precondition STOP; 2 usage.
// Dependency-free. No side effects on import.

import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const MIGRATE_GATES_STOP = 'MIGRATE_GATES_STOP';
const stop = (message) =>
  Object.assign(new Error(`[agent-workflow] ${message}`), { name: 'MigrateGatesStop', code: MIGRATE_GATES_STOP, exitCode: 1 });
const usageFail = (message) => Object.assign(new Error(`[agent-workflow] ${message}`), { exitCode: 2 });

export const GATES_REL = join('docs', 'ai', 'gates.json');

// The documented canonical forms — ONE plain invocation, quoted or bare path, `--check` at END
// (the run-gates strict-matcher shape; a masked/compound form is a CUSTOMIZED entry).
const legacyRe = (basename) => new RegExp(`^node\\s+(?:"(?:[^"]*[/\\\\])?${basename}"|(?:[^\\s"]*[/\\\\])?${basename})\\s+--check$`);
export const LEGACY_FORMS = Object.freeze([
  { name: 'review-ledger', re: legacyRe('review-ledger\\.mjs') },
  { name: 'fold-completeness', re: legacyRe('fold-completeness\\.mjs') },
]);

// coverage-producer canon >>> BEGIN drift-guarded region
// Authored TWICE, byte-identically: in the memory substrate's references/scripts/migrate-gates.mjs
// and in the composition root's tools/coverage-producer.mjs. Neither side imports the other — the
// substrate is standalone and must not depend on the root, and the root must not import mirrored
// bytes — so a TEXT drift guard beside the root's copy holds them equal. Edit BOTH, then re-run the
// mirror sync.
//
// The destination is written against AW_GIT_DIR, which run-gates exports to every gate child on a
// plain run AND on --final (AW_LCOV_FILE is --final only), so one cmd survives the unmet
// producer-variable preflight in both modes. The `:?` is not decoration either: this cmd is also
// PASTE-READY, and the required-parameter form makes bash refuse BY NAME when AW_GIT_DIR is unset
// or EMPTY, where a bare `$AW_GIT_DIR` expanded to empty and wrote the lcov to the filesystem ROOT.
// Residual, stated: `:?` says nothing about the value's ORIGIN — a STALE exported AW_GIT_DIR
// expands fine and the lcov lands under it; only the runner's own injection makes it the right dir.
// The explicit stdout reporter keeps the human stream: without it the lcov reporter swallows the
// TAP/spec output.
export const UNIT_TESTS_COVERAGE_FLAGS =
  '--experimental-test-coverage --test-reporter=lcov --test-reporter-destination="${AW_GIT_DIR:?exported by run-gates}/agent-workflow-lcov.info" --test-reporter=spec --test-reporter-destination=stdout';

// Every flag set the kit has EVER emitted — APPEND-ONLY, newest first. Emission uses the head; the
// tail exists so a declaration written by an EARLIER kit and living on disk in a deployed project
// keeps reading as the producer it is. De-recognizing a prior form would silently reclassify a
// working suite gate as customized and withhold the checker over it.
export const KNOWN_COVERAGE_FLAG_SETS = Object.freeze([
  UNIT_TESTS_COVERAGE_FLAGS,
  '--experimental-test-coverage --test-reporter=lcov --test-reporter-destination="$AW_GIT_DIR/agent-workflow-lcov.info" --test-reporter=spec --test-reporter-destination=stdout',
]);

// The ONE suite body that produces that lcov with no extra dependency (the EMITTED form), beside
// the closed set of bodies recognition accepts.
export const COVERAGE_PRODUCER_BODY = `node --test ${UNIT_TESTS_COVERAGE_FLAGS}`;
const KNOWN_PRODUCER_BODIES = Object.freeze(KNOWN_COVERAGE_FLAG_SETS.map((flags) => `node --test ${flags}`));

// The per-PM exec wrappers a fill offer puts that body behind. Recognition must cover every form
// the kit has EMITTED, so the prefixes are matched literally; gates-init's execCmdFor stays the one
// EMITTER and is bound to this list by a named acceptance test, never by a second grammar.
const PRODUCER_EXEC_PREFIXES = Object.freeze([
  'COREPACK_ENABLE_NETWORK=0 npm exec --offline --script-shell /bin/sh -- ',
  'COREPACK_ENABLE_NETWORK=0 pnpm exec -- ',
  'COREPACK_ENABLE_NETWORK=0 yarn exec -- ',
]);

// A trailing suffix is the project's own test paths; a leading one would mean the body is not what
// this cmd runs. The tail passes a POSITIVE closed grammar — every whitespace-separated token must
// be path-shaped — never an operator blocklist: `node --test <flags> && rm -f <lcov>` runs the
// suite and then DELETES the file, so an open-ended tail would certify a producer that leaves
// nothing behind, and scanning for operator BYTES would put the incomplete-scan failure on the
// unsafe side (a missed operator is a dead pair) instead of the mild one (an unrecognised
// legitimate tail merely withholds the offer — add the gate by hand).
// The token set is everything that appears in a PATH or a glob and can never sequence, redirect or
// substitute a command — quoting and `~` included, `( ) $ ` ; & | < > # \` excluded. SCOPE, stated
// exactly: the screen judges each token's SOURCE bytes. Quote removal adds none, but brace SEQUENCE
// expansion does — `{Y..a}` yields ``[ \ ] ^ _ ` `` (probed) — so "no new bytes" would be a false
// claim. What holds is the property that matters: bash does not re-scan an expansion result as
// syntax, so a byte arriving that way is literal argument DATA, never an operator. The leading-`-`
// exclusion is weaker still — a FIRST-ORDER screen only, defeated by `'--flag'` and
// `{path,--flag}`. It is kept because the tail is the project's test PATHS and it costs only a loud
// withhold. Deciding an argument's post-expansion identity needs a shell lexer, which this family
// deliberately has NOWHERE (AD-079). So the claim is "configured with the reporters", never "the
// lcov survives the command"; a run that produces none is caught honestly at runtime as
// `skipped-no-lcov`.
const PRODUCER_PATH_TOKEN = /^(?!-)[A-Za-z0-9_./*{},:@+=~?[\]!'"-]+$/;
const pathShapedTail = (tail) => tail === '' || tail.split(/[ \t]+/).every((token) => PRODUCER_PATH_TOKEN.test(token));
const carriesProducerBody = (text) =>
  KNOWN_PRODUCER_BODIES.some(
    (body) => text === body || (text.startsWith(`${body} `) && pathShapedTail(text.slice(body.length).trim())),
  );

// matchesCoverageProducer(cmd) → CLOSED-WORLD over the full command forms the kit emits, never a
// substring probe: `echo "$AW_GIT_DIR/agent-workflow-lcov.info"`, a half-written reporter flag set,
// or the path as a bare substring must all read as NOT a producer — otherwise the checker is
// declared over a gate that writes nothing and then PASSES while certifying nothing.
export const matchesCoverageProducer = (cmd) => {
  if (typeof cmd !== 'string') return false;
  const trimmed = cmd.trim();
  if (carriesProducerBody(trimmed)) return true;
  return PRODUCER_EXEC_PREFIXES.some((prefix) => trimmed.startsWith(prefix) && carriesProducerBody(trimmed.slice(prefix.length)));
};

// isCoverageProducerGate(gate) → the GATE-level producer question, and the ONE predicate every
// consumer asks it through: does THIS declared entry write the lcov the canonical checker reads?
// Exactly two ways to be one — the cmd passes the closed world above, or the declaration CLAIMS
// production through the optional `lcovProducer` marker. The marker exists because the closed world
// is a `node --test` world: a project whose primary suite is another runner has NO cmd form
// recognition can accept, so without it the checker over such a suite reads as a dead pair forever.
// Recognition itself never widens (anti-squatter) — the marker is a declared claim, not a new
// grammar. Only the literal `true` claims: any truthy value would let the string "false" certify.
// And the claim is about the DECLARATION, never the run — a marked gate that produces no lcov still
// ends `skipped-no-lcov` / `attested=no` at run time.
// An entry with no RUNNABLE cmd claims nothing (fail closed): no string cmd, an empty or
// whitespace-only one, or one carrying an embedded newline. The strict validator already refuses all
// three, but this predicate has a SECOND host — the standalone migration's loader is deliberately
// lenient — and a marker must never make a checker pair with an entry that runs nothing there.
export const isCoverageProducerGate = (gate) => {
  if (gate === null || typeof gate !== 'object' || Array.isArray(gate) || typeof gate.cmd !== 'string') return false;
  if (gate.cmd.trim() === '' || /[\r\n]/.test(gate.cmd)) return false;
  return matchesCoverageProducer(gate.cmd) || gate.lcovProducer === true;
};
// coverage-producer canon <<< END drift-guarded region

// checker-claim canon >>> BEGIN drift-guarded region
// Authored TWICE, byte-identically: in the composition root's tools/checker-claim.mjs and in the
// memory substrate's references/scripts/migrate-gates.mjs. Neither side imports the other — the
// substrate is standalone and must not depend on the root, and the root must not import mirrored
// bytes — so a TEXT drift guard beside the root's copy holds them equal. Edit BOTH, then re-run the
// mirror sync.
//
// A cmd makes exactly ONE of three claims about a given tool, and collapsing them into a boolean is
// what makes a VENDORED copy of the tool read as "the tool is not declared at all" — a false
// absence, with a remedy (adopt it) that then collides with the entry already there:
//   • canonical      — this tool's `--check` invocation, resolving to THIS copy of it
//   • tool-elsewhere — the same invocation shape, resolving to a DIFFERENT real copy
//   • not-the-tool   — anything else: another command, a masked form, an inadmissible token, or a
//                      path nothing can resolve
// The realpath anchor never widens: a lookalike file that merely carries the basename is not this
// tool, whatever it prints. What widens is the VOCABULARY. Stated residual, unchanged by the split:
// nothing here reads the file's CONTENT, so a byte-swapped file at the canonical path is invisible.
export const CHECKER_CLAIM = Object.freeze({
  CANONICAL: 'canonical',
  ELSEWHERE: 'tool-elsewhere',
  NOT_THE_TOOL: 'not-the-tool',
});

// The token is screened by the rules of the quoting it actually carries, because the two halves are
// interpreted differently and a single screen would be wrong for one of them:
//   • QUOTED — double quotes survive most bytes, so only what breaks OUT of them is refused.
//   • BARE   — anything the shell may split, expand or glob makes the executed command different
//              from the string, so a bare token is admitted only from a known-safe alphabet.
// Either way the point is the same: a path that resolves literally here while the shell would read
// it differently must never be called a claim about this tool, or the screen certifies a command
// that never runs.
export const dqUnsafePath = (text) => [...text].some((ch) => {
  const code = ch.codePointAt(0);
  return ch === '"' || ch === '$' || code === 96 || code === 92 || code === 13 || code === 10;
});

// Stated as the bytes the shell ACTS on, not as an alphabet of blessed ones: an allow-list refuses
// perfectly ordinary paths (`@`, `+`, `,`, `%`, `=`, anything non-ASCII) that the shell passes
// through verbatim, and refusing a command that really is canonical is its own defect. Whitespace
// and ASCII control bytes are refused too — a bare token cannot contain them and still be one token.
const SHELL_ACTIVE_BARE = new Set([...'"\'\\$|&;<>(){}[]*?!#~^`']);
const bareTokenSafe = (text) => text.length > 0 && ![...text].some((ch) => {
  const code = ch.codePointAt(0);
  return code <= 0x20 || code === 0x7f || SHELL_ACTIVE_BARE.has(ch);
});

const RE_META = /[.*+?^${}()|[\]\\]/g;

// checkerClaimTool(basename, canonicalPath) → the screen for ONE tool. The shape is the STRICT full
// command — `node` + ONE (quoted or bare) path token + the exact basename + ` --check` + END — so a
// masked form (`--check --help`, `--check || true`, a prefix command) is never any claim at all.
// Separators are PLAIN SPACES, not \s: a newline between the tokens is not a command a runner would
// execute as written. The basename is regex-escaped here, never by the caller — a caller-escaped
// literal is one forgotten backslash away from a dot matching any byte.
export const checkerClaimTool = (basename, canonicalPath) => {
  const safe = basename.replace(RE_META, '\\$&');
  return Object.freeze({
    re: new RegExp(`^node +(?:"((?:[^"]*[/\\\\])?${safe})"|((?:[^\\s"]*[/\\\\])?${safe})) +--check$`),
    canonical: canonicalPath,
  });
};

// classifyCheckerClaim(tool, cmd, projectDir) → one CHECKER_CLAIM value. Every unresolvable side
// fails CLOSED to `not-the-tool`: an unresolvable path is not evidence the tool lives elsewhere, it
// is evidence nothing can be told about it — and `tool-elsewhere` is a claim a consumer ACTS on.
//
// Two screens beyond the shape, for the same reason the quoting screens exist — a claim must never
// be minted for a command that cannot run the tool as written:
//   • a token starting with `-` is an OPTION to node, whatever it resolves to on disk. (First-order,
//     like the producer canon's own leading-`-` rule: `{x,-y}` still defeats it, and the cost of a
//     miss is only a withheld claim.)
//   • the RESOLVED target must be a REGULAR FILE. A directory or a FIFO carrying the basename
//     resolves perfectly well and is not a copy of anything; `realpathSync` succeeding proves a path
//     exists, never that it is a tool. lstat runs AFTER realpath, so there is no link left to follow.
export const classifyCheckerClaim = (tool, cmd, projectDir) => {
  if (typeof cmd !== 'string' || typeof projectDir !== 'string') return CHECKER_CLAIM.NOT_THE_TOOL;
  const match = tool.re.exec(cmd.trim());
  if (!match) return CHECKER_CLAIM.NOT_THE_TOOL;
  const token = match[1] ?? match[2];
  const admissible = match[1] !== undefined ? !dqUnsafePath(token) : bareTokenSafe(token);
  if (!admissible || token.startsWith('-')) return CHECKER_CLAIM.NOT_THE_TOOL;
  const declared = isAbsolute(token) ? token : join(projectDir, token);
  try {
    const resolved = realpathSync(declared);
    if (!lstatSync(resolved).isFile()) return CHECKER_CLAIM.NOT_THE_TOOL;
    return resolved === realpathSync(tool.canonical) ? CHECKER_CLAIM.CANONICAL : CHECKER_CLAIM.ELSEWHERE;
  } catch {
    return CHECKER_CLAIM.NOT_THE_TOOL;
  }
};
// checker-claim canon <<< END drift-guarded region

// The RETIRED kit-owned git-dir stores the deleted machinery wrote — dead data a consumer's
// upgrade would otherwise strand forever. The migration cleans them (consented via the preview;
// ENOENT is a silent no-op; any other unlink error is reported loudly but never fails the
// migration — the stores are not a gate input).
export const RETIRED_STORE_BASENAMES = Object.freeze([
  'agent-workflow-review-ledger.jsonl',
  'agent-workflow-review-ledger.v5-orphans.jsonl',
  'agent-workflow-fold-completeness.jsonl',
]);

const trueGitDir = (cwd) => {
  const r = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8', windowsHide: true });
  return r.error || r.status !== 0 ? null : r.stdout.replace(/\r?\n$/, '');
};

// findRetiredStores(cwd) → the absolute paths of retired stores PRESENT in the target's git dir.
export const findRetiredStores = (cwd) => {
  const gitDir = trueGitDir(cwd);
  if (gitDir == null) return [];
  return RETIRED_STORE_BASENAMES.map((name) => join(gitDir, name)).filter((p) => existsSync(p));
};

const UNIT_TESTS_PREFIX = 'node --test ';

// The core-check forms the stripped core anchors on (same strict single-invocation shape as the
// legacy matcher). Canonicity is PURE path equality against the caller-named kit tools dir —
// an ABSOLUTE token resolving to the installed tool; run-gates --final does the live realpath
// check. A cmd that MATCHES the shape but resolves elsewhere (or relatively) is a LOOKALIKE —
// reported customized, never counted as the core check.
const CORE_CHECK_RE = { 'coverage-check': legacyRe('coverage-check\\.mjs'), 'review-state': legacyRe('review-state\\.mjs') };
const coreCheckToken = (cmd) => /^node\s+(?:"([^"]+)"|([^\s"]+))\s+--check$/.exec(cmd.trim())?.slice(1).find(Boolean) ?? null;
const samePath = (a, b) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b); // an unresolvable side falls back to the lexical compare
  }
};
const isCanonicalCoreCheck = (name, cmd, kitToolsDir) => {
  if (!CORE_CHECK_RE[name].test(cmd.trim())) return false;
  const token = coreCheckToken(cmd);
  return token !== null && isAbsolute(token) && samePath(token, join(kitToolsDir, `${name}.mjs`));
};

// buildMigrationPlan(gates, kitToolsDir) → the PURE migration plan.
// plan rows: { action: 'keep' | 'remove' | 'extend' | 'move' | 'add', entry, reason }.
// finalCapable mirrors the run-gates --final acceptance shape: the canonical review-state check
// must be PRESENT (the checker itself is guaranteed last by the plan) — missing means the result
// is NOT final-run-capable and the preview says so loudly with the paste-ready candidate.
export const buildMigrationPlan = (gates, kitToolsDir) => {
  const plan = [];
  const customized = [];
  // EVERY canonical checker row, not just the last one seen: a duplicate is a real declaration
  // state, and both the producer question and the final-capability claim have to see all of them.
  const checkerRows = [];
  let unitTestsExtended = false;
  let hasReviewState = false;
  const coverageCmd = `node "${join(kitToolsDir, 'coverage-check.mjs')}" --check`;
  for (const gate of gates) {
    const legacy = LEGACY_FORMS.find((f) => f.re.test(gate.cmd.trim()));
    if (legacy) {
      plan.push({ action: 'remove', entry: gate, reason: `the ${legacy.name} check died with its tool (strip-the-kit)` });
      continue;
    }
    if (isCanonicalCoreCheck('coverage-check', gate.cmd, kitToolsDir)) {
      const row = { action: 'keep', entry: gate, reason: null };
      checkerRows.push(row);
      plan.push(row);
      continue;
    }
    if (isCanonicalCoreCheck('review-state', gate.cmd, kitToolsDir)) {
      hasReviewState = true;
      plan.push({ action: 'keep', entry: gate, reason: null });
      continue;
    }
    if (gate.id === 'unit-tests') {
      // Already fully configured — decided by the CLOSED predicate, never a substring probe, and
      // over ANY flag set the kit has emitted: a declaration written by an earlier kit stays a
      // zero-diff keep (the constant moving must not re-read a working gate as customized), while a
      // cmd that merely CONTAINS the bytes — `echo <flags>`, a `&& rm -f <lcov>` tail — is not a
      // producer and must reach the CUSTOMIZED report with its recovery instead of a silent keep.
      // A declared `lcovProducer` marker settles it the same way: the entry claims production, so
      // there is nothing to extend and nothing to report as unverifiable.
      if (isCoverageProducerGate(gate)) {
        plan.push({ action: 'keep', entry: gate, reason: null });
        continue;
      }
      if (gate.cmd.startsWith(UNIT_TESTS_PREFIX) && !/--experimental-test-coverage|--test-reporter/.test(gate.cmd)) {
        const extended = { ...gate, cmd: `node --test ${UNIT_TESTS_COVERAGE_FLAGS} ${gate.cmd.slice(UNIT_TESTS_PREFIX.length)}` };
        plan.push({ action: 'extend', entry: extended, reason: 'the unit-tests cmd gains the built-in lcov reporters (the D3(d) coverage source)' });
        unitTestsExtended = true;
        continue;
      }
      // npm test / a wrapper / a partial flag set: the coverage contract cannot be VERIFIED on a
      // cmd this tool does not understand — customized, never silently counted as configured.
      customized.push(gate);
      plan.push({ action: 'keep', entry: gate, reason: null });
      continue;
    }
    // A dead-tool reference or a core-check LOOKALIKE in a non-canonical form — reported, never touched.
    if (/review-ledger|fold-completeness|verification-profile|seed-gates|sarif|coverage-check\.mjs|review-state\.mjs/.test(gate.cmd)) {
      customized.push(gate);
    }
    plan.push({ action: 'keep', entry: gate, reason: null });
  }
  const kept = plan.filter((r) => r.action === 'keep' || r.action === 'extend');
  const checkerRow = checkerRows[checkerRows.length - 1] ?? null;
  // The checker READS an lcov; something has to WRITE it FIRST. Adding the checker over a
  // declaration with no producer creates the dead pair — the gate PASSES (`skipped-no-lcov`) and
  // certifies nothing, so the migration withholds it and says why instead.
  // POSITIONAL, like every other producer question in the family: the checker always ends up LAST
  // here (added last, or moved last), so the producers are exactly the rows that are not a checker.
  // EVERY checker row is excluded, not merely the one that ends up last — a checker cannot produce
  // the lcov it reads, so a marker on a DUPLICATE checker must not read as the producer for the
  // other one; that pair would claim final-capability while nothing wrote the file.
  const hasProducer = kept.some((r) => !checkerRows.includes(r) && isCoverageProducerGate(r.entry));
  let collision = null;
  let checkerWithheld = false;
  if (checkerRow === null) {
    // A surviving NON-canonical entry already holding the checker's id blocks the add — two
    // `coverage-check` rows would be ambiguous; the customized entry must be resolved by hand
    // FIRST (the caller turns this into a loud STOP on preview and apply alike).
    if (kept.some((r) => r.entry.id === 'coverage-check')) {
      collision = 'coverage-check';
    } else if (!hasProducer) {
      checkerWithheld = true;
    } else {
      plan.push({
        action: 'add',
        entry: { id: 'coverage-check', title: 'Changed-line coverage + red-proof verification (the final-run checker)', cmd: coverageCmd },
        reason: 'run-gates --final requires the canonical checker as the LAST declared gate',
      });
    }
  } else if (kept[kept.length - 1] !== checkerRow) {
    checkerRow.action = 'move';
    checkerRow.reason = 'the canonical checker must be the LAST declared gate (nothing may run after it consumed the lcov)';
  }
  // An ALREADY-declared checker over no producer is the same dead pair the withhold prevents — an
  // earlier deployment could have created it. The migration removes no declared gate, so it reports
  // the inertness and refuses to call the result final-run-capable.
  const checkerInert = checkerRow !== null && !hasProducer;
  // `--final` accepts EXACTLY ONE canonical checker, so a declaration carrying two is not
  // final-run-capable however healthy the rest of it looks. The migration removes no declared gate,
  // so it names the duplication and withholds the claim instead of over-promising a green.
  const duplicateCheckers = checkerRows.length;
  const reviewStateCandidate = `{ "id": "review-state", "title": "Review receipts converged (D3(b))", "cmd": "node \\"${join(kitToolsDir, 'review-state.mjs')}\\" --check" }`;
  return {
    plan,
    customized,
    unitTestsExtended,
    finalCapable: hasReviewState && !checkerWithheld && !checkerInert && duplicateCheckers <= 1,
    hasProducer,
    hasReviewState,
    checkerWithheld,
    checkerInert,
    duplicateCheckers,
    reviewStateCandidate,
    collision,
  };
};

export const resultingGates = (plan) => {
  const kept = plan.filter((r) => r.action === 'keep' || r.action === 'extend').map((r) => r.entry);
  const moved = plan.filter((r) => r.action === 'move').map((r) => r.entry);
  const added = plan.filter((r) => r.action === 'add').map((r) => r.entry);
  return [...kept, ...moved, ...added]; // move/add go LAST — the checker ends up the last declared gate
};

// The per-entry customized recovery: a unit-tests-class entry gets the FULL canonical flag set
// (the intent is known — the cmd shape just cannot be verified); anything else gets the
// dead-tool recovery.
const customizedRecovery = (gate) =>
  gate.id === 'unit-tests'
    ? `declare the canonical suite gate by hand so the coverage contract is verifiable: node --test ${UNIT_TESTS_COVERAGE_FLAGS} <your test paths>`
    : 'remove the entry, or repoint it at a living check — the review-ledger / fold-completeness tools no longer exist.';

const warningLines = ({ customized, finalCapable, hasReviewState = finalCapable, checkerWithheld = false, checkerInert = false, duplicateCheckers = 0, reviewStateCandidate }) => {
  const lines = [];
  for (const gate of customized) {
    lines.push(`  CUSTOMIZED (untouched): ${gate.id}: ${gate.cmd}`);
    lines.push(`    recovery (apply by hand if the intent still stands): ${customizedRecovery(gate)}`);
  }
  if (customized.length) {
    lines.push('  IMPORTANT: do NOT install the commit guard until every customized entry above is resolved — a declaration that cannot pass run-gates --final would block every commit.');
  }
  if (checkerWithheld) {
    lines.push('  WARNING: the canonical coverage-check gate was NOT added — no declared gate would PRODUCE the lcov it reads, and a checker with no producer passes while verifying nothing. Declare the suite gate first, then re-run this migration:');
    lines.push(`    node --test ${UNIT_TESTS_COVERAGE_FLAGS} <your test paths>`);
  }
  if (checkerInert) {
    lines.push('  WARNING: the DECLARED coverage-check gate is INERT — no declared gate PRODUCES the lcov it reads, so it passes while verifying nothing. Nothing is removed for you; declare the suite gate:');
    lines.push(`    node --test ${UNIT_TESTS_COVERAGE_FLAGS} <your test paths>`);
  }
  if (duplicateCheckers > 1) {
    lines.push(`  WARNING: ${duplicateCheckers} declared gates are the canonical coverage checker — run-gates --final accepts EXACTLY ONE, so the result is NOT final-run-capable. Nothing is removed for you; keep a single checker and delete the rest by hand.`);
  }
  if (!hasReviewState) {
    lines.push('  WARNING: the result is NOT final-run-capable — no canonical review-state check is declared. Add it (paste-ready), then run-gates --final can mint the receipt:');
    lines.push(`    ${reviewStateCandidate}`);
  }
  return lines;
};

export const formatPreview = (analysis, applyHint) => {
  const { plan, unitTestsExtended, finalCapable, hasProducer = unitTestsExtended, retiredStores = [] } = analysis;
  const lines = ['[agent-workflow] legacy gates.json migration preview (dry-run — nothing was written):'];
  const acted = plan.filter((r) => r.action !== 'keep');
  for (const r of acted) {
    lines.push(`  ${r.action.toUpperCase()} ${r.entry.id}: ${r.entry.cmd}   (${r.reason})`);
  }
  for (const p of retiredStores) {
    lines.push(`  CLEAN ${p}   (a retired kit-owned store the deleted machinery wrote — dead data, unlinked on apply)`);
  }
  if (!acted.length && !retiredStores.length) {
    lines.push(
      finalCapable
        ? '  nothing to migrate — no canonical legacy entries, no retired stores, and the declaration is already final-run-capable.'
        : '  nothing to migrate mechanically — no canonical legacy entries and no retired stores; the warnings below still need a hand.',
    );
  }
  // Keyed on the ID, but a PRODUCER is recognized under any id — repeating this advice over a
  // working producer sends the user to fix nothing.
  if (!hasProducer && !unitTestsExtended && !plan.some((r) => r.entry.id === 'unit-tests')) {
    lines.push('  note: no canonical `unit-tests` entry found — declare your suite gate with the lcov reporters by hand (the coverage-check gate reads the file it produces).');
  }
  lines.push(...warningLines(analysis));
  if (acted.length || retiredStores.length) {
    lines.push(`  apply exactly this migration: ${applyHint}`);
  }
  return lines.join('\n');
};

// The parent chain (docs, docs/ai) is lstat'd NO-FOLLOW: a symlinked parent means the write
// would land OUTSIDE the target project — a STOP on preview and apply alike. ENOENT reads as
// "no declaration" (a preview no-op); any OTHER lstat failure (EACCES, EIO) fails CLOSED —
// an unverifiable parent is never treated as safe. lstatFn is the injectable test seam.
const checkRealParents = (cwd, lstatFn) => {
  for (const rel of ['docs', join('docs', 'ai')]) {
    const p = join(cwd, rel);
    let st;
    try {
      st = lstatFn(p);
    } catch (err) {
      if (err.code === 'ENOENT') return { missing: true };
      throw stop(`${p}: cannot verify the declaration parent (${err.code ?? err.message}) — refusing to proceed (fail closed)`);
    }
    if (st.isSymbolicLink()) throw stop(`${p} is a symlink — refusing to read or write the declaration through a symlinked parent`);
    if (!st.isDirectory()) throw stop(`${p} is not a real directory — fix the layout by hand`);
  }
  return { missing: false };
};

const loadDeclaration = (cwd, lstatFn = lstatSync) => {
  const full = join(cwd, GATES_REL);
  let leaf = null;
  try {
    leaf = lstatFn(full);
  } catch (err) {
    // ONLY "not there" reads as missing — an EACCES/EIO leaf must never let apply proceed
    // (it would clean the retired stores while silently not migrating the declaration).
    if (err.code === 'ENOENT') return { outcome: 'missing' };
    throw stop(`${GATES_REL}: cannot lstat the declaration (${err.code ?? err.message}) — refusing to proceed (fail closed)`);
  }
  if (leaf.isSymbolicLink()) throw stop(`${GATES_REL} is a symlink — refusing to touch it`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(full, 'utf8'));
  } catch (err) {
    throw stop(`${GATES_REL}: malformed JSON (${err.message}) — fix it by hand; the migration never writes over a declaration it cannot parse`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.gates)) {
    throw stop(`${GATES_REL}: not a { gates: [...] } declaration — fix it by hand`);
  }
  return { outcome: 'loaded', parsed };
};

// The parent chain is re-verified immediately before the tmp write AND again before the rename
// (an honest-effort TOCTOU guard — a parent swapped for a symlink mid-migration never gets
// written through).
const writeAtomic = (cwd, body, lstatFn) => {
  const full = join(cwd, GATES_REL);
  if (checkRealParents(cwd, lstatFn).missing) throw stop(`${GATES_REL}: the docs/ai parent vanished during the migration — nothing was written`);
  const tmp = `${full}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, body, { flag: 'wx' });
  try {
    if (checkRealParents(cwd, lstatFn).missing) throw stop(`${GATES_REL}: the docs/ai parent vanished during the migration — nothing was written`);
    renameSync(tmp, full);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort tmp cleanup */ }
    throw err;
  }
  return full;
};

export const parseArgs = (argv) => {
  const args = { cwd: process.cwd(), apply: false, kitTools: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--cwd') {
      i += 1;
      if (!argv[i]) throw usageFail('--cwd needs a directory');
      args.cwd = argv[i];
    } else if (a === '--kit-tools') {
      i += 1;
      if (!argv[i]) throw usageFail('--kit-tools needs the installed kit tools directory');
      args.kitTools = argv[i];
    } else throw usageFail(`unknown argument: ${a}`);
  }
  return args;
};

const HELP = `migrate-gates — the consented legacy gates.json migration (strip-the-kit D8).

Usage:
  node migrate-gates.mjs --kit-tools <installed-kit-tools-dir> [--cwd <project>] [--apply]

Default is a dry-run PREVIEW (writes nothing). --apply rewrites ${GATES_REL} atomically:
canonical legacy entries (review-ledger / fold-completeness --check, matched by their documented
single-invocation forms) are REMOVED; the canonical unit-tests cmd gains the built-in lcov
reporters; the coverage-check gate is ADDED last (resolved, QUOTED path) — and WITHHELD, loudly,
when no declared gate produces the lcov it reads. Customized entries are
NEVER auto-touched — the preview names each with a paste-ready recovery, and the commit guard
must not be installed until they are resolved.`;

export const main = (argv = process.argv.slice(2), io = {}) => {
  const out = io.log ?? console.log;
  const err = io.error ?? console.error;
  try {
    const args = parseArgs(argv);
    if (args.help) {
      out(HELP);
      return 0;
    }
    if (!args.kitTools) throw usageFail('--kit-tools <dir> is required (the installed kit tools directory — the migration writes resolved paths, never guesses)');
    const kitTools = isAbsolute(args.kitTools) ? args.kitTools : resolve(args.cwd, args.kitTools);
    // The kit path lands INSIDE a double-quoted bash cmd line — a path bash would interpret there
    // ($ ` " \) is a STOP before any plan is built or byte written (never a silently broken gate).
    if (/[$"`\\\r\n]/.test(kitTools)) {
      throw stop(`--kit-tools resolves to ${kitTools} — the path contains shell metacharacters unsafe inside a double-quoted gate cmd ($ \` " \\); relocate the kit to a safe path`);
    }
    if (!existsSync(join(kitTools, 'coverage-check.mjs'))) {
      throw stop(`--kit-tools ${kitTools} does not contain coverage-check.mjs — point it at the installed kit's tools directory`);
    }
    const lstatFn = io.lstat ?? lstatSync;
    const parents = checkRealParents(args.cwd, lstatFn);
    const retiredStores = findRetiredStores(args.cwd);
    const declaration = parents.missing ? { outcome: 'missing' } : loadDeclaration(args.cwd, lstatFn);
    if (declaration.outcome === 'missing' && !retiredStores.length) {
      out(`[agent-workflow] no ${GATES_REL} and no retired stores — nothing to migrate.`);
      return 0;
    }
    const parsed = declaration.outcome === 'loaded' ? declaration.parsed : { gates: [] };
    const analysis = { ...buildMigrationPlan(parsed.gates, kitTools), retiredStores };
    if (analysis.collision) {
      throw stop(
        `id collision — a NON-canonical entry already uses id "${analysis.collision}"; resolve it by hand first ` +
          '(two rows under the checker id would be ambiguous — the canonical checker is never added alongside a customized twin)',
      );
    }
    const applyHint = `node "${fileURLToPath(import.meta.url)}" --kit-tools "${kitTools}" --cwd "${args.cwd}" --apply`;
    if (!args.apply) {
      out(formatPreview(analysis, applyHint));
      return 0;
    }
    const acted = analysis.plan.filter((r) => r.action !== 'keep');
    if (acted.length && declaration.outcome === 'loaded') {
      const merged = { ...parsed, gates: resultingGates(analysis.plan) };
      const writtenPath = writeAtomic(args.cwd, `${JSON.stringify(merged, null, 2)}\n`, lstatFn);
      out(`[agent-workflow] migrated ${writtenPath}: ${acted.map((r) => `${r.action} ${r.entry.id}`).join(', ')}`);
    }
    for (const p of retiredStores) {
      try {
        unlinkSync(p);
        out(`  cleaned ${p} (a retired kit-owned store)`);
      } catch (e) {
        if (e.code !== 'ENOENT') out(`  could not clean ${p} (${e.code ?? e.message}) — dead data, remove it by hand; the migration itself is unaffected`);
      }
    }
    // The warnings survive EVERY apply outcome — a no-op apply must still say what needs a hand.
    for (const line of warningLines(analysis)) out(line);
    if (!acted.length && !retiredStores.length) {
      out(
        analysis.finalCapable
          ? '[agent-workflow] nothing to migrate — the declaration is already final-run-capable and no retired stores remain.'
          : '[agent-workflow] nothing to migrate mechanically — no canonical legacy entries and no retired stores remain; the warnings above still need a hand.',
      );
    }
    return 0;
  } catch (e) {
    err(e.message);
    return e.exitCode ?? 1;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = main();
