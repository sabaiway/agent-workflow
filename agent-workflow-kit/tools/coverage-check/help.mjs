import { COVERAGE_DECLARED_REL } from '../coverage-declared/index.mjs';

export const LCOV_BASENAME = 'agent-workflow-lcov.info';
const USAGE = 'Usage:\n  node coverage-check.mjs --check [--cwd <dir>]';
const HELP = `coverage-check — the D3(c)+(d) final-run checker (agent-workflow family).

${USAGE}

Reads the FIXED kit-owned lcov file (<git dir>/${LCOV_BASENAME}; AW_LCOV_FILE overrides —
produced by the declared unit-tests gate cmd's --experimental-test-coverage lcov reporters and
deleted fresh by run-gates --final), lists uncovered CHANGED executable Node lines file:line,
lists changed out-of-domain files (the coverage claim is narrowed to Node lines), and VERIFIES
every current-base red-proof record: bound test present, content hash unchanged, green N/N
(AW_CORE_EVIDENCE_RERUNS, default 3), pre-fix fingerprint differing from the current tree.
An absent lcov file (ENOENT) is a LOUD skipped-no-lcov (exit 0 — NO coverage check ran, stated).
Any other lcov status failure, a symlinked lcov path, an uncovered line, a broken red-proof
obligation, or a malformed evidence store fails (exit 1).
A changed file listed in ${COVERAGE_DECLARED_REL} (one { path, reason } entry per file nothing
runs at its repository path) with no executed line in the lcov read is not judged; it and every
other list line print on every run. An unreadable or malformed list fails (exit 1); with a context
the list must be the one the final run started with (AW_FINAL_ATTEST_DECLARED), else the run
fails as attestation context refused (exit 1).

A coverage VERDICT is issued ONLY inside the run that owns the artifact's lifetime: run-gates
--final deletes the lcov before any gate spawns and hands this checker an attestation context
(a nonce whose one-way commitment over {nonce, fingerprint, base} is the final-start attempt id).
One anchored machine line rides every run: coverage-check: attested=<yes|no>. It states whether a
coverage VERDICT was ISSUED — pass OR fail — never that coverage passed.
  attested=yes → a verdict was issued over the lcov BYTES this run read (a failing one still
                 exits 1); the predicate is the consumed digest, never the skip flag.
  attested=no  → NO VERDICT: no handshake, or no lcov bytes were read at all (an absent file or a
                 refused path — nothing read, nothing certified). Withholding a verdict never
                 changes an exit code: an absent lcov stays exit 0, a refused non-regular path
                 keeps its own fail-closed exit 1, and uncovered lines still exit 1. Findings are
                 still printed; run-gates carries the withheld verdict as coverage=not-run.
  attestation context refused (exit 1) → the context describes another tree or another declared
                 list, or matches no recorded attempt.
Residual, stated: ownership of the fixed path is CONVENTION, not enforcement — a concurrent writer
to it can still place foreign evidence (queued as LCOV-EXCLUSIVE-OWNERSHIP).

Sandbox-safe: no network; writes nothing; spawns read-only git queries and the bound-test
probes (node --test, shell-free) — the D4 sandbox lane. The attestation variables are consumed and
removed from this process's environment before anything spawns, so no child inherits the capability.
Read-only. Exit codes: 0 pass / no-verdict / skipped-loud; 1 fail or attestation context refused; 2 usage.`;

export const composeHelp = () => HELP;
export const composeUsage = () => USAGE;
