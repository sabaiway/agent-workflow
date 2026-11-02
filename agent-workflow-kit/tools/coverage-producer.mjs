// coverage-producer.mjs — the kit's half of the shared coverage-producer vocabulary (spec
// coverage-producer): the one command body the suite gate runs, the move list of the flag sets
// earlier kits wrote, and the CLOSED predicate deciding whether a declared gate cmd actually WRITES
// the lcov the canonical checker reads. A LEAF — imports nothing, so every consumer (gates-init,
// gates-declaration, the advisor) decides through ONE predicate.
// Dependency-free, Node >= 22. No side effects on import.

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
