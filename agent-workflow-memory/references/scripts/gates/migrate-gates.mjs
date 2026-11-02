#!/usr/bin/env node
// migrate-gates.mjs — the LEGACY gates.json migration (strip-the-kit D8), the kit's MANDATORY move. A
// deployment that predates the hardened core declares gates the stripped kit no longer ships (the
// review-ledger / fold-completeness checks); `--apply` migrates the declaration ATOMICALLY, with no
// question: it REMOVES a canonical legacy entry whose target is proven absent, EXTENDS the canonical
// `unit-tests` cmd, and SWITCHES every producer form an earlier kit wrote, onto the stable kit
// command's unit-tests name (the D3(d) coverage source), and moves a declared coverage-check gate LAST.
// The coverage check stays OPTIONAL: the checker is ADDED only with `--add-checker`, which the agent
// runs on the user's explicit yes, and only over a declaration that PRODUCES the lcov it reads — over
// none it is withheld, with the fact and the remedy (spec coverage-producer).
//
// Matching is by the DOCUMENTED cmd forms ONLY (hand-wired history included — never by seed
// provenance): a legacy entry is `node <path>/review-ledger.mjs --check` or
// `node <path>/fold-completeness.mjs --check` (quoted or bare path, ONE plain invocation); the
// canonical unit-tests entry is id `unit-tests` with a cmd `node --test` and a path-shaped rest; an
// earlier kit's producer form is matched under any id (spec coverage-producer). ANYTHING
// else, but a kit-check gate the switch below rewrites, is a CUSTOMIZED entry — never auto-touched: the
// preview reports it loudly and prints the paste-ready recovery so the maintainer applies the intent by
// hand; the commit guard is NOT to be installed until the declaration is final-run-capable.
//
// A kit-check gate over a current kit folder that the rules above do not hold customized is SWITCHED to the stable kit command (spec kit-command, read by
// ./kit-command-gates.mjs); any other form is named.
//
// Write discipline (the family's writer contract): preview (dry-run) is the DEFAULT and writes
// NOTHING, `--add-checker` included; `--apply` rewrites docs/ai/gates.json via exclusive tmp+rename in the same
// directory; a symlinked gates.json (or docs/ai parent) is a STOP; a malformed declaration is
// never written over. `--kit-tools <dir>` names the installed kit's tools directory — the
// migration writes RESOLVED, QUOTED paths for the coverage-check gate (no runtime guessing).
//
// Exit codes: 0 done / preview / nothing-to-migrate; 1 precondition STOP; 2 usage.
// Dependency-free. No side effects on import.

import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { planKitCommandGates, repointsOf } from './kit-command-gates.mjs';

export const MIGRATE_GATES_STOP = 'MIGRATE_GATES_STOP';
const stop = (message) =>
  Object.assign(new Error(`[agent-workflow] ${message}`), { name: 'MigrateGatesStop', code: MIGRATE_GATES_STOP, exitCode: 1 });
const usageFail = (message) => Object.assign(new Error(`[agent-workflow] ${message}`), { exitCode: 2 });

export const GATES_REL = join('docs', 'ai', 'gates.json');

// The documented canonical forms — ONE plain invocation, quoted or bare path, `--check` at END
// (the run-gates strict-matcher shape; a masked/compound form is a CUSTOMIZED entry).
const legacyRe = (basename) => new RegExp(`^node\\s+(?:"((?:[^"]*[/\\\\])?${basename})"|((?:[^\\s"]*[/\\\\])?${basename}))\\s+--check$`);
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
// The ONE producer form the kit writes: the stable kit command's unit-tests name (spec kit-command) —
// the Node test runner with the lcov reporter under AW_GIT_DIR and the kit test reporter on stdout.
export const COVERAGE_PRODUCER_BODY = 'node scripts/agent-workflow/run.mjs unit-tests';

// The reporter flag sets earlier kits wrote after `node --test`, newest first, byte for byte: a MOVE
// LIST the gate migration switches onto the body above, never read as a producer.
export const RETIRED_COVERAGE_FLAG_SETS = Object.freeze([
  '--experimental-test-coverage --test-reporter=lcov --test-reporter-destination="${AW_GIT_DIR:?exported by run-gates}/agent-workflow-lcov.info" --test-reporter=spec --test-reporter-destination=stdout',
  '--experimental-test-coverage --test-reporter=lcov --test-reporter-destination="$AW_GIT_DIR/agent-workflow-lcov.info" --test-reporter=spec --test-reporter-destination=stdout',
]);
const RETIRED_BODIES = Object.freeze(RETIRED_COVERAGE_FLAG_SETS.map((flags) => `node --test ${flags}`));

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
// be path-shaped — never an operator blocklist: `<body> && rm -f <lcov>` runs the suite and then
// DELETES the file, so an open-ended tail would certify a producer that leaves nothing behind, and
// scanning for operator BYTES would put the incomplete-scan failure on the unsafe side (a missed
// operator is a dead pair) instead of the mild one (an unrecognised legitimate tail merely
// withholds the offer — add the gate by hand). No flag either: the command hands it to the runner.
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

// The exec prefix the trimmed text opens with ('' for none), and the rest after it.
const splitExecPrefix = (text) => {
  const prefix = PRODUCER_EXEC_PREFIXES.find((p) => text.startsWith(p)) ?? '';
  return [prefix, text.slice(prefix.length)];
};

// The rest after `body` (trimmed; '' when nothing follows), or null unless the text is the body, then nothing or one space.
const bodyRest = (text, body) => {
  if (text === body) return '';
  return text.startsWith(`${body} `) ? text.slice(body.length).trim() : null;
};

// matchesCoverageProducer(cmd) → CLOSED-WORLD over the full command forms the kit emits, never a
// substring probe: `echo <body>`, the quoted body or a retired flag set is NOT a producer — else the
// checker is declared over a gate that writes nothing and then PASSES while certifying nothing.
export const matchesCoverageProducer = (cmd) => {
  if (typeof cmd !== 'string') return false;
  const [, text] = splitExecPrefix(cmd.trim());
  const rest = bodyRest(text, COVERAGE_PRODUCER_BODY);
  return rest !== null && pathShapedTail(rest);
};

// retiredProducerFormOf(cmd) → { prefix (as written, or ''), tail (trimmed), pathShaped } when the
// trimmed cmd is no or one exec prefix, `node --test`, a retired flag set and nothing or one space and
// a rest; null for every other value. The switch carries only a path-shaped tail onto the body.
export const retiredProducerFormOf = (cmd) => {
  if (typeof cmd !== 'string') return null;
  const [prefix, text] = splitExecPrefix(cmd.trim());
  for (const body of RETIRED_BODIES) {
    const tail = bodyRest(text, body);
    if (tail !== null) return { prefix, tail, pathShaped: pathShapedTail(tail) };
  }
  return null;
};

// unitTestsGuardFailure → the guard on every write of the body: run.mjs a regular file equal to `ownRun`, then the reporter
// a regular file, every folder on the way a directory (lstat: a link fails); null, or the first failing path and kind,
// worded by guardRemedy with the caller's upgrade.
const GUARD_PATHS = Object.freeze(['scripts/agent-workflow/run.mjs', 'scripts/agent-workflow/test-reporter/reporter.mjs']);
export const unitTestsGuardFailure = (projectDir, ownRun, { lstatSync, readFileSync }) => {
  for (const rel of GUARD_PATHS) {
    const parts = rel.split('/');
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const at = parts.slice(0, depth).join('/');
      const st = lstatSync(`${projectDir}/${at}`, { throwIfNoEntry: false });
      if (st === undefined) return { path: rel, kind: 'absent' };
      if (depth < parts.length ? !st.isDirectory() : !st.isFile()) return { path: at, kind: 'wrong-kind' };
    }
    if (rel === GUARD_PATHS[0] && !readFileSync(`${projectDir}/${rel}`).equals(readFileSync(ownRun))) return { path: rel, kind: 'earlier' };
  }
  return null;
};
export const guardRemedy = (kind, upgrade) => ({
  absent: `is absent — the kit's upgrade places the kit folder only where Node evidence stands (a root package.json, or a kit script): add one if this project runs Node, then run ${upgrade}.`,
  earlier: `differs from this kit's — run ${upgrade}, whose configs step writes the current one`,
  'wrong-kind': `is not what the kit writes there — a directory, a link, or a file where a folder belongs — beside which the specs op writes nothing: clear it by hand first, then run ${upgrade}`,
})[kind];

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
// readsAsCoverageProducer(gate, claim) → the ONE producer question of a declared row, asked by both hosts: `claim` is
// the row's claim on the coverage-check tool through the checker-claim canon, and only a row that is not the tool
// (`'not-the-tool'`, equal by test to CHECKER_CLAIM.NOT_THE_TOOL) can produce — a checker, canonical or vendored,
// consumes the lcov it reads, so its marker claims nothing.
export const readsAsCoverageProducer = (gate, claim) => claim === 'not-the-tool' && isCoverageProducerGate(gate);
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
//   • canonical      — this tool's invocation with its tail (`--check` by default), resolving to THIS copy
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

// checkerClaimTool(basename, canonicalPath, tail) → the screen for ONE tool. The shape is the STRICT
// full command — `node` + ONE (quoted or bare) path token + the exact basename + the exact argument
// tail (`--check` by default) + END — so a masked form (`--check --help`, `--check || true`, a prefix
// command) or a reordered tail is never any claim at all. Separators are PLAIN SPACES, not \s: a
// newline between the tokens is not a command a runner would execute as written. The basename and
// every tail token are regex-escaped here, never by the caller — a caller-escaped literal is one
// forgotten backslash away from a dot matching any byte.
export const checkerClaimTool = (basename, canonicalPath, tail = '--check') => {
  const safe = basename.replace(RE_META, '\\$&');
  const args = tail.split(' ').map((token) => token.replace(RE_META, '\\$&')).join(' +');
  return Object.freeze({
    re: new RegExp(`^node +(?:"((?:[^"]*[/\\\\])?${safe})"|((?:[^\\s"]*[/\\\\])?${safe})) +${args}$`),
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
// upgrade would otherwise strand forever. The migration cleans them on apply (named by the preview;
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

const SUITE_LINE = `${COVERAGE_PRODUCER_BODY} <your test paths>`;
// Every checker line: one positional fact and one remedy; why a gate was kept rides that gate's own line.
const [WITHHELD_FACT, POSITIONAL_FACT] = ['no declared gate is a producer this kit reads', 'no gate before it is a producer this kit reads'];
const CHECKER_REMEDY = `declare or move one before it: ${SUITE_LINE}, or mark your own suite gate "lcovProducer": true`;

// The guard reads the project's kit folder against this migration's own ../run.mjs; the memory substrate names no sibling skill.
const OWN_RUN = join(dirname(fileURLToPath(import.meta.url)), '..', 'run.mjs');
const UPGRADE = "the kit's upgrade";
const guardLine = ({ id, path, kind }) =>
  `  KEPT ${id}: ${path} ${guardRemedy(kind, UPGRADE)} — once that is resolved, ${UPGRADE} moves this gate with no question.`;

// legacyTargetAbsent(re, cmd, projectDir) → whether a legacy check's invocation target, resolved from the project root as
// run-gates resolves a declared token, is PROVEN absent: the checker-claim quoting screens admit the token and its lstat
// answers ENOENT. A file, a directory or a link there, or a token the screens refuse (`~`, `$`), is no proof.
const legacyTargetAbsent = (re, cmd, projectDir) => {
  const [, quoted, bare] = re.exec(cmd.trim());
  const token = quoted ?? bare;
  if (!(quoted !== undefined ? !dqUnsafePath(token) : bareTokenSafe(token)) || token.startsWith('-')) return false;
  try {
    lstatSync(isAbsolute(token) ? token : join(projectDir, token));
    return false;
  } catch (err) {
    return err.code === 'ENOENT';
  }
};

// The core checks the stripped core anchors on, asked through the checker-claim canon above — the
// SAME three outcomes, so a declared cmd is read as what it is: this copy of the tool, a DIFFERENT
// copy of it, or not the tool at all. Resolution is anchored on the PROJECT root, exactly as
// run-gates resolves a declared token (gates-declaration.mjs matchesCanonicalCheck), so the
// migration and the runner never disagree about which copy a cmd names.
const CORE_CHECK_NAMES = Object.freeze(['coverage-check', 'review-state']);
const coreCheckTools = (kitToolsDir) =>
  Object.fromEntries(CORE_CHECK_NAMES.map((name) => [name, checkerClaimTool(`${name}.mjs`, join(kitToolsDir, `${name}.mjs`))]));

// buildMigrationPlan(gates, kitToolsDir, projectDir, { addChecker }) → the migration plan.
// plan rows: { action: 'keep' | 'remove' | 'extend' | 'switch' | 'move' | 'add', entry, reason, claim }.
// finalCapable mirrors the run-gates --final acceptance shape: the canonical review-state check
// must be PRESENT (the checker itself is guaranteed last by the plan) — missing means the result
// is NOT final-run-capable and the preview says so loudly with the paste-ready candidate. An
// EXTERNAL-COPY core check withholds that claim too: the runner anchors on the installed copy.
// Every row but the checker add is a mechanical move; the add joins the plan only with `addChecker`
// (the user's yes), else `checkerOffered` says it would.
export const buildMigrationPlan = (gates, kitToolsDir, projectDir, { addChecker = false } = {}) => {
  if (typeof projectDir !== 'string') {
    throw stop('buildMigrationPlan needs the project root — a declared cmd may name a core check by a RELATIVE path, and only the project root resolves it the way the runner does');
  }
  const kit = planKitCommandGates(gates, projectDir);
  let guard;
  const guardFailure = () => (guard === undefined ? (guard = unitTestsGuardFailure(projectDir, OWN_RUN, { lstatSync, readFileSync })) : guard);
  const guardKept = [];
  const tools = coreCheckTools(kitToolsDir);
  const claimOf = (name, cmd) => classifyCheckerClaim(tools[name], cmd, projectDir);
  const plan = [];
  const customized = [];
  // EVERY canonical checker row, not just the last one seen: a duplicate is a real declaration
  // state, and both the producer question and the final-capability claim have to see all of them.
  const checkerRows = [];
  // A core check declared through a DIFFERENT copy of the tool — the vendored deployment.
  const externalCoreChecks = [];
  let unitTestsExtended = false;
  let hasReviewState = false;
  const coverageCmd = `node "${join(kitToolsDir, 'coverage-check.mjs')}" --check`;
  for (const [at, gate] of gates.entries()) {
    const legacy = LEGACY_FORMS.find((f) => f.re.test(gate.cmd.trim()));
    if (legacy) {
      // Removed only over a target proven absent: anything standing there may be the project's own, so it is CUSTOMIZED.
      if (legacyTargetAbsent(legacy.re, gate.cmd, projectDir)) {
        plan.push({ action: 'remove', entry: gate, reason: `was: ${gate.cmd} — the ${legacy.name} check died with its tool (strip-the-kit), its target absent` });
        continue;
      }
      customized.push(gate);
      plan.push({ action: 'keep', entry: gate, reason: null, claim: CHECKER_CLAIM.NOT_THE_TOOL });
      continue;
    }
    const coverageClaim = claimOf('coverage-check', gate.cmd);
    const keep = { action: 'keep', entry: gate, reason: null, claim: coverageClaim };
    if (coverageClaim === CHECKER_CLAIM.CANONICAL) {
      checkerRows.push(keep);
      plan.push(keep);
      continue;
    }
    const reviewClaim = claimOf('review-state', gate.cmd);
    if (reviewClaim === CHECKER_CLAIM.CANONICAL) {
      hasReviewState = true;
      plan.push(keep);
      continue;
    }
    // The third outcome: this IS the tool, from a copy the caller did not name. A vendored
    // deployment declared it deliberately, so it is PRESERVED as written — a plain keep row, never
    // a new action kind (resultingGates carries only keep|extend|switch|move|add and would silently drop
    // one) — and it counts as DECLARED, which is what stops the checker being added on top of it
    // and stops its id reading as a squatter. What it does not buy is the final-capability claim:
    // run-gates --final anchors on the installed copy by realpath and would refuse this cmd.
    const elsewhereName = coverageClaim === CHECKER_CLAIM.ELSEWHERE
      ? 'coverage-check'
      : reviewClaim === CHECKER_CLAIM.ELSEWHERE ? 'review-state' : null;
    if (elsewhereName !== null) {
      externalCoreChecks.push({ name: elsewhereName, entry: gate, installed: join(kitToolsDir, `${elsewhereName}.mjs`), row: keep });
      plan.push(keep);
      continue;
    }
    // An earlier kit's producer form (any id, marked or not, read BEFORE the marker keep) is SWITCHED,
    // and the unit-tests gate's `node --test` EXTENDED, onto the command body: only over a path-shaped
    // tail (a flag there is CUSTOMIZED, never rewritten) and while the guard holds, else kept with the
    // guard's line. So no form is written that the next run reports CUSTOMIZED.
    const retired = retiredProducerFormOf(gate.cmd);
    const unitRest = retired === null && gate.id === 'unit-tests' && !isCoverageProducerGate(gate) ? bodyRest(gate.cmd.trim(), 'node --test') : null;
    const move = retired ?? (unitRest === null ? null : { prefix: '', tail: unitRest, pathShaped: pathShapedTail(unitRest) });
    if (move !== null) {
      if (!move.pathShaped) customized.push(gate);
      else if (guardFailure() !== null) guardKept.push({ id: gate.id, ...guardFailure() });
      else {
        const entry = { ...gate, cmd: `${move.prefix}${COVERAGE_PRODUCER_BODY}${move.tail ? ` ${move.tail}` : ''}` };
        plan.push(retired !== null
          ? { action: 'switch', entry, reason: `was: ${gate.cmd} — the unit tests run through the stable kit command`, claim: coverageClaim }
          : { action: 'extend', entry, reason: `was: ${gate.cmd} — the unit-tests cmd runs through the stable kit command, which adds the lcov reporter (the D3(d) coverage source)`, claim: coverageClaim });
        unitTestsExtended ||= retired === null;
        continue;
      }
      plan.push(keep);
      continue;
    }
    if (gate.id === 'unit-tests') {
      // Already configured — decided by the CLOSED predicate, never a substring probe — or a declared
      // `lcovProducer` marker: keep. `echo <body>`, a `&& rm -f <lcov>` tail, `npm test` or a wrapper
      // cannot be VERIFIED as a producer: CUSTOMIZED with its recovery, never a silent keep.
      if (!isCoverageProducerGate(gate)) customized.push(gate);
      plan.push(keep);
      continue;
    }
    // A dead-tool reference or a core-check LOOKALIKE in a non-canonical form — reported, never touched.
    const deadTool = /review-ledger|fold-completeness|verification-profile|seed-gates|sarif|coverage-check\.mjs|review-state\.mjs/.test(gate.cmd);
    if (deadTool) customized.push(gate);
    if (kit.gates[at] !== gate && !deadTool) {
      plan.push({ action: 'switch', entry: kit.gates[at], reason: `was: ${gate.cmd} — the kit check runs through the stable kit command`, claim: coverageClaim });
      continue;
    }
    plan.push(keep);
  }
  // A gate the kit reading would switch but the rules above keep untouched is named with its repoint instead.
  const switchedEntries = new Set(plan.filter((r) => r.action === 'switch').map((r) => r.entry));
  const repoints = [...kit.repoints, ...gates.flatMap((gate, at) => (kit.gates[at] !== gate && !switchedEntries.has(kit.gates[at]) ? repointsOf(gate) : []))];
  const kept = plan.filter((r) => r.action === 'keep' || r.action === 'extend' || r.action === 'switch');
  const checkerRow = checkerRows[checkerRows.length - 1] ?? null;
  const externalCoverageChecks = externalCoreChecks.filter((c) => c.name === 'coverage-check');
  // The checker READS an lcov; something has to WRITE it FIRST. Adding the checker over a
  // declaration with no producer creates the dead pair, so the migration withholds it and says why.
  // A row is a producer through the ONE question both hosts ask (readsAsCoverageProducer): a row
  // claiming the coverage checker, the canonical copy or a vendored one, consumes the lcov rather
  // than writing it, so its marker never pairs it with itself or with a duplicate.
  const isProducerRow = (row) => readsAsCoverageProducer(row.entry, row.claim);
  const hasProducer = kept.some(isProducerRow);
  let collision = null;
  let checkerWithheld = false;
  let checkerOffered = false;
  if (checkerRow !== null) {
    if (kept[kept.length - 1] !== checkerRow) {
      checkerRow.action = 'move';
      checkerRow.reason = `was: before ${kept.slice(kept.indexOf(checkerRow) + 1).map((r) => r.entry.id).join(', ')} — the canonical checker must be the LAST declared gate (nothing may run after it consumed the lcov)`;
    }
  } else if (externalCoverageChecks.length > 0) {
    // The checker IS declared, from another copy. Adding the canonical one beside it would create
    // a duplicate — and rewriting the row the deployment chose is not this tool's call. Nothing is
    // added, nothing is moved; the verify lines below carry what the maintainer has to decide.
  } else if (kept.some((r) => r.entry.id === 'coverage-check')) {
    // A surviving row other than a checker holding the checker's id withholds only the add — two
    // `coverage-check` rows would be ambiguous — and stops no mechanical row.
    collision = 'coverage-check';
  } else if (!hasProducer) {
    checkerWithheld = true;
  } else if (addChecker) {
    plan.push({
      action: 'add',
      entry: { id: 'coverage-check', title: 'Changed-line coverage + red-proof verification (the final-run checker)', cmd: coverageCmd },
      reason: 'run-gates --final requires the canonical checker as the LAST declared gate',
    });
  } else {
    checkerOffered = true;
  }
  // An ALREADY-declared checker over no producer is the same dead pair the withhold prevents — an
  // earlier deployment could have created it. The migration removes no declared gate, so it reports
  // the fact and refuses to call the result final-run-capable.
  //
  // The question is POSITIONAL for both checker kinds: a canonical checker always ENDS UP LAST here
  // (moved last), so its producers are every kept row; a VENDORED checker is left where the
  // deployment put it, so a producer declared AFTER it writes the lcov it has already read past.
  // Tracked PER ROW: the renderer names the edit for the row it is talking about.
  const inertExternalRows = new Set(
    externalCoverageChecks.filter(({ row }) => !kept.slice(0, kept.indexOf(row)).some(isProducerRow)).map(({ row }) => row),
  );
  const canonicalCheckerInert = checkerRow !== null && !hasProducer;
  const checkerInert = canonicalCheckerInert || inertExternalRows.size > 0;
  // `--final` accepts EXACTLY ONE canonical checker, so a declaration carrying two is not
  // final-run-capable however healthy the rest of it looks. The migration removes no declared gate,
  // so it names the duplication and withholds the claim instead of over-promising a green.
  const duplicateCheckers = checkerRows.length;
  const reviewStateCandidate = `{ "id": "review-state", "title": "Review receipts converged (D3(b))", "cmd": "node \\"${join(kitToolsDir, 'review-state.mjs')}\\" --check" }`;
  // finalCapable judges the result with the offered add landed: the offer line carries the one step left.
  return {
    plan,
    customized,
    unitTestsExtended,
    finalCapable:
      hasReviewState && !checkerWithheld && collision === null && !checkerInert && duplicateCheckers <= 1 && externalCoreChecks.length === 0,
    hasProducer,
    hasReviewState,
    checkerWithheld,
    checkerOffered,
    checkerInert,
    duplicateCheckers,
    // The plan ROW is an internal handle (the move arm mutates it) — consumers get the facts only.
    // `canonicalTwin` decides the RECOVERY: with the installed copy already declared, "repoint this
    // cmd" would leave two canonical checkers, which --final refuses — a recovery that cannot
    // converge is worse than none.
    externalCoreChecks: externalCoreChecks.map(({ name, entry, installed, row }) => ({
      name,
      entry,
      installed,
      canonicalTwin: name === 'coverage-check' ? checkerRows.length > 0 : hasReviewState,
      inert: inertExternalRows.has(row),
    })),
    canonicalCheckerInert,
    canonicalCheckerId: checkerRow?.entry.id ?? null,
    reviewStateCandidate,
    collision,
    repoints,
    withheld: kit.withheld,
    guardKept,
  };
};

export const resultingGates = (plan) => {
  const kept = plan.filter((r) => r.action === 'keep' || r.action === 'extend' || r.action === 'switch').map((r) => r.entry);
  const moved = plan.filter((r) => r.action === 'move').map((r) => r.entry);
  const added = plan.filter((r) => r.action === 'add').map((r) => r.entry);
  return [...kept, ...moved, ...added]; // move/add go LAST — the checker ends up the last declared gate
};

const MARKER_LANE = 'or, if your suite cmd already writes that lcov in a form this check cannot recognise, add "lcovProducer": true to that gate in docs/ai/gates.json';

// The per-entry customized recovery: a unit-tests-class entry — the unit-tests id, or an earlier
// kit's producer form under any id — gets the command's suite line (the intent is known — the cmd
// shape just cannot be verified); a legacy check whose target stands gets the hand decision; anything else the dead-tool recovery.
const customizedRecovery = (gate) => {
  if (gate.id === 'unit-tests' || retiredProducerFormOf(gate.cmd) !== null) {
    return `declare the canonical suite gate by hand so the coverage contract is verifiable: ${SUITE_LINE} — ${MARKER_LANE}`;
  }
  const legacy = LEGACY_FORMS.find((f) => f.re.test(gate.cmd.trim()));
  return legacy
    ? `the ${legacy.name} check is retired, but its target is not proven absent (something stands at that path, or its token is one the kit does not resolve) — remove the entry by hand if it runs the retired tool; if it is your own check, move its file to a path that does not contain ${legacy.name} and point the gate at it.`
    : 'remove the entry, or repoint it at a living check — the review-ledger / fold-completeness tools no longer exist.';
};

const warningLines = ({ customized, finalCapable, hasReviewState = finalCapable, checkerWithheld = false, checkerOffered = false, canonicalCheckerInert = false, canonicalCheckerId = 'coverage-check', duplicateCheckers = 0, externalCoreChecks = [], reviewStateCandidate, repoints = [], withheld = [], guardKept = [], collision = null, addCheckerHint = 'this migration with --apply --add-checker' }) => {
  const lines = [];
  for (const kept of guardKept) lines.push(guardLine(kept));
  for (const { id, path } of withheld) lines.push(`  WARNING: ${id} runs a kit check, but the kit folder is not current (${path}) — kept as declared; refresh the kit's scripts, then re-run this migration.`);
  for (const { id, repoint } of repoints) lines.push(`  REPOINT (untouched): ${id}: run ${repoint} in place of its invocation of that check, its arguments kept.`);
  for (const gate of customized) {
    lines.push(`  CUSTOMIZED (untouched): ${gate.id}: ${gate.cmd}`);
    lines.push(`    recovery (apply by hand if the intent still stands): ${customizedRecovery(gate)}`);
  }
  if (customized.length) {
    lines.push('  IMPORTANT: do NOT install the commit guard until every customized entry above is resolved — a declaration that cannot pass run-gates --final would block every commit.');
  }
  for (const { name, entry, installed, canonicalTwin = false, inert = false } of externalCoreChecks) {
    lines.push(`  VERIFY (preserved exactly as declared): ${entry.id}: ${entry.cmd}`);
    lines.push(
      `    this IS the ${name} check by invocation shape, but it resolves to a DIFFERENT copy of the tool than --kit-tools names (${installed}) — a vendored deployment. Nothing was added over it and nothing was rewritten.`,
    );
    lines.push(
      canonicalTwin
        ? `    the INSTALLED ${name} check is declared here too, so repointing this cmd would leave TWO — run-gates --final accepts exactly ONE canonical check. Remove THIS entry by hand and keep the canonical one.`
        : `    run-gates --final anchors on the installed copy by realpath, so the result is NOT final-run-capable while this entry stands: either repoint the cmd at ${installed}, or upgrade through the kit that owns the copy it names.`,
    );
    // The fact of THIS row, said on THIS row, with its one remedy — the removal above when a canonical twin stands.
    if (inert) lines.push(`    it also reads as inert: ${POSITIONAL_FACT} — ${canonicalTwin ? 'removing it, as above, is the one edit' : CHECKER_REMEDY}`);
  }
  if (externalCoreChecks.length) {
    // The same consequence the customized block carries, for the same reason: a declaration --final
    // refuses mints no receipt, and the commit guard then refuses every commit.
    lines.push('  IMPORTANT: do NOT install the commit guard while the entr(ies) above stand — a declaration that cannot pass run-gates --final would block every commit.');
  }
  if (collision !== null) {
    lines.push(`  WARNING: the canonical coverage-check gate was not added — a row that is not the checker already holds the id ${collision}: rename that row by hand.`);
  }
  if (checkerWithheld) lines.push(`  WARNING: the canonical coverage-check gate was not added — ${WITHHELD_FACT}; ${CHECKER_REMEDY}`);
  // The coverage check is optional: its add is the one step that waits for the user's explicit yes.
  if (checkerOffered) lines.push(`  OFFER coverage-check: a declared gate is a producer this kit reads and no checker is declared — on the user's explicit yes, add the canonical checker last: ${addCheckerHint}`);
  // The CANONICAL checker's fact only; an external row's is said on the row itself above.
  if (canonicalCheckerInert) lines.push(`  WARNING: the declared coverage checker (${canonicalCheckerId}): ${POSITIONAL_FACT} — ${CHECKER_REMEDY}`);
  if (duplicateCheckers > 1) {
    lines.push(`  WARNING: ${duplicateCheckers} declared gates are the canonical coverage checker — run-gates --final accepts EXACTLY ONE, so the result is NOT final-run-capable. Nothing is removed for you; keep a single checker and delete the rest by hand.`);
  }
  // A review-state declared through an external copy already has its VERIFY row above, naming the
  // same missing capability with the RIGHT remedy — telling the maintainer to "add it" on top of an
  // entry that is already there would advise a duplicate.
  if (!hasReviewState && !externalCoreChecks.some((c) => c.name === 'review-state')) {
    lines.push('  WARNING: the result is NOT final-run-capable — no canonical review-state check is declared. Add it (paste-ready), then run-gates --final can mint the receipt:');
    lines.push(`    ${reviewStateCandidate}`);
  }
  return lines;
};

// Each acted row, printed alike by the preview and the apply: its action, id, cmd and its reason (a moved or removed gate's `was:`).
const actedLines = (plan) => plan.filter((r) => r.action !== 'keep').map((r) => `  ${r.action.toUpperCase()} ${r.entry.id}: ${r.entry.cmd}   (${r.reason})`);

export const formatPreview = (analysis, applyHint) => {
  const { plan, unitTestsExtended, finalCapable, checkerOffered = false, hasProducer = unitTestsExtended, retiredStores = [] } = analysis;
  const lines = ['[agent-workflow] legacy gates.json migration preview (dry-run — nothing was written):'];
  const acted = actedLines(plan);
  lines.push(...acted);
  for (const p of retiredStores) {
    lines.push(`  CLEAN ${p}   (a retired kit-owned store the deleted machinery wrote — dead data, unlinked on apply)`);
  }
  if (!acted.length && !retiredStores.length) {
    lines.push(
      finalCapable && !checkerOffered
        ? '  nothing to migrate — no canonical legacy entries, no retired stores, and the declaration is already final-run-capable.'
        : '  nothing to migrate mechanically — no canonical legacy entries and no retired stores; the lines below still need a hand.',
    );
  }
  // Keyed on the ID, but a PRODUCER is recognized under any id — repeating this advice over a
  // working producer sends the user to fix nothing.
  if (!hasProducer && !unitTestsExtended && !plan.some((r) => r.entry.id === 'unit-tests')) {
    lines.push(`  note: no canonical \`unit-tests\` entry found — declare your suite gate by hand as ${SUITE_LINE} (the coverage-check gate reads the lcov it produces).`);
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
  const args = { cwd: process.cwd(), apply: false, addChecker: false, kitTools: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '--add-checker') args.addChecker = true;
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

const HELP = `migrate-gates — the legacy gates.json migration (strip-the-kit D8), the kit's mandatory move.

Usage:
  node migrate-gates.mjs --kit-tools <installed-kit-tools-dir> [--cwd <project>] [--apply [--add-checker]]

Default is a dry-run PREVIEW (writes nothing, --add-checker included). --apply rewrites ${GATES_REL}
atomically with every mechanical row, the upgrade's gates-migration step running it with no question:
a canonical legacy entry (review-ledger / fold-completeness --check, matched by its documented
single-invocation form) is REMOVED when its target is proven absent; the canonical unit-tests cmd and
every earlier kit's producer form run through ${COVERAGE_PRODUCER_BODY} (while the kit folder holds this
kit's command and reporter); a kit-check gate over a current kit folder is SWITCHED in place to
node scripts/agent-workflow/run.mjs <name>, unless it is a customized entry below, a flat scripts/<file>
only when nothing stands at that path; any other form naming a kit check is kept, named with its repoint;
a declared coverage-check gate is moved last. The coverage-check gate is ADDED last (resolved, QUOTED path)
only with --add-checker, on the user's explicit yes, and only when a declared gate produces the lcov it
reads. Customized entries are NEVER auto-touched — each is named with a paste-ready recovery, and the
commit guard must not be installed until they are resolved.`;

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
    const command = `node "${fileURLToPath(import.meta.url)}" --kit-tools "${kitTools}" --cwd "${args.cwd}"`;
    const addCheckerHint = `${command} --apply --add-checker`;
    const analysis = { ...buildMigrationPlan(parsed.gates, kitTools, resolve(args.cwd), { addChecker: args.addChecker }), retiredStores, addCheckerHint };
    const applyHint = args.addChecker ? addCheckerHint : `${command} --apply`;
    if (!args.apply) {
      out(formatPreview(analysis, applyHint));
      return 0;
    }
    const acted = analysis.plan.filter((r) => r.action !== 'keep');
    if (acted.length && declaration.outcome === 'loaded') {
      const merged = { ...parsed, gates: resultingGates(analysis.plan) };
      const writtenPath = writeAtomic(args.cwd, `${JSON.stringify(merged, null, 2)}\n`, lstatFn);
      for (const line of actedLines(analysis.plan)) out(line);
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
        analysis.finalCapable && !analysis.checkerOffered
          ? '[agent-workflow] nothing to migrate — the declaration is already final-run-capable and no retired stores remain.'
          : '[agent-workflow] nothing to migrate mechanically — no canonical legacy entries and no retired stores remain; the lines above still need a hand.',
      );
    }
    return 0;
  } catch (e) {
    err(e.message);
    return e.exitCode ?? 1;
  }
};

// Run main() only when executed directly, never on import. Compare by REAL path: an entry point
// reached through a symlink resolves to its target, so a raw string compare reads the two as
// different and the CLI never runs. realpathSync collapses the link so both sides match.
const isDirectRun = (() => {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isDirectRun) process.exitCode = main();
