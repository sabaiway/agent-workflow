// coverage-producer.mjs — the kit's half of the shared coverage-producer vocabulary: the reporter
// flags the canonical suite gate carries, and the CLOSED predicate deciding whether a declared gate
// cmd actually WRITES the lcov the canonical checker reads. A LEAF — imports nothing, so every
// consumer (gates-init, gates-declaration, the advisor) decides through ONE predicate.
// Dependency-free, Node >= 22. No side effects on import.

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
