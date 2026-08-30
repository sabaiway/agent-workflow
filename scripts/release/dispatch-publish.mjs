#!/usr/bin/env node
// dispatch-publish.mjs — the ordered publish dispatcher (repo-local, tracked).
//
// Replaces the turn-by-turn babysitting of `gh api` dispatch/poll/parse during Release
// Publishing: one invocation dispatches .github/workflows/publish.yml — either ONE `all` run
// covering the whole family (the preferred form: 2 workflow runs per family release; ordering
// inside the workflow via `kit needs: [memory, engine]`, and an unchanged member no-ops via the
// Issue-007 Release-step branch in _publish-one.yml) or one run per named package (the
// per-package fallback) — polls every run to conclusion, and (in live mode) verifies the
// published artifact on npm + the GitHub Release.
//
//   node scripts/release/dispatch-publish.mjs all | <pkg>... [--expect <pkg>=X.Y.Z]...
//        [--ref <ref>] [--live] [--poll-timeout <seconds>] [--repo <owner/name>]
//        [--token-file <path>]
//
//   all | <pkg>...  `all` ALONE (never mixed with named packages): one workflow run covers
//                   memory + engine + kit; --live then requires --expect for all three (an
//                   unchanged package's expectation = its current, already-published version).
//                   Or an ordered package list: memory | engine | kit (kit LAST when present —
//                   refused otherwise; Issue-007 ordering). One dispatch per named package.
//   --expect        (repeatable) the intended version per package — feeds the post-publish
//                   verification; REQUIRED for every package in --live mode.
//   --ref           the git ref to dispatch on (default main).
//   --live          actually publish. Without it the script runs the DRY-RUN phase only.
//   --poll-timeout  per-run poll bound in seconds (default 1200).
//   --token-file    read the GitHub PAT from <path> (line endings stripped) and use it as
//                   GH_TOKEN for every gh call this process spawns. The flat lane for headless/
//                   agent shells where env does not persist between tool calls and an
//                   env-prefixed compound invocation never matches a plain allow rule
//                   (INCIDENT 2026-07-21, second occurrence: the ad-hoc tmp-wrapper workaround —
//                   unreviewed tmp code reading a secret and spawning this script — is exactly
//                   the shape a host-side classifier rightly distrusts, and it got blocked
//                   mid-release). The token value is never logged.
//
// Invariants (pinned by dispatch-publish.test.mjs):
//   • NEVER self-triggering — this script runs ONLY when invoked after the maintainer's explicit
//     publish approval; nothing in the repo calls it automatically. Live mode requires --live.
//   • ALL dry-runs for the ordered list conclude green BEFORE the first live dispatch — a later
//     package's dry-run failure can never leave a partial release.
//   • Live preflight: clean tree AND `git ls-remote origin <ref>` == the local HEAD (the approved,
//     pushed release commit) — refused before ANY dispatch on mismatch. The refusal NAMES which
//     mismatch it observed, because they carry opposite remedies: a `refs/heads/` tip that is an
//     ancestor of HEAD is an UNPUSHED commit (push it) — and ONLY for a branch, since outside
//     `refs/heads/` this script recommends nothing; an id that peels to HEAD is an annotated tag,
//     not a different commit; a HEAD contained in the remote tip is BEHIND it; a pair where neither
//     commit reaches the other has DIVERGED, but only on a graph git calls whole — a SHALLOW clone
//     is its own outcome; a tip that does not resolve to a commit here is reported as exactly that
//     and nothing more; and a probe that does not ANSWER is undetermined, never guessed. Every arm
//     points at `scripts/release/preflight-remote.mjs`, the release's step 1, EXCEPT the two with
//     nothing for it to add: a BRANCH whose tip is simply unpushed, and an id that already peels to
//     HEAD. The pointer says what step 1 IS, never what it will conclude (AD-098).
//   • Live preflight (stub gate): a dispatched package whose CHANGELOG newest entry still carries
//     the RELEASE-STUB marker (the version-sync --bump placeholder) is refused before ANY
//     dispatch — "a stub cannot ship" is a gate, not a grep hope.
//   • Deterministic run correlation: workflow_dispatch returns no run id, so each dispatch is
//     correlated via a pre/post run-listing diff + head_sha match; zero or multiple candidates →
//     REFUSE (never guess someone else's run).
//   • The Release tag is derived EXACTLY as _publish-one.yml derives it (`<package-dir>-v<version>`)
//     — the derivation line is READ from the workflow file at preflight and the run fails loudly
//     if the workflow no longer matches (the mapping is never assumed).
//   • Post-publish verification is bounded-retry (registry `@latest` can lag), with a loud timeout.
//
// Distinct exit codes: 0 ok · 2 usage · 3 preflight · 4 dispatch · 5 correlation · 6 poll
// timeout · 7 run concluded non-success · 8 post-publish verification failure (reachable — a real
// red) · 9 post-publish verification UNREACHABLE (inconclusive — the publish itself concluded
// success but a verify endpoint could not be reached, e.g. a network-blocked sandbox; re-run the
// verify OUTSIDE the sandbox with the printed `--verify-only` command — NOT a failed release).
// Dependency-free, Node >= 22. No side effects on import.

import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runGitProcess } from './git-process.mjs';
import { readSmokeReceipt, candidateSmokeViolation } from './smoke-candidate.mjs';
import { readGateReceipt, crossVersionGateViolation } from './cross-version-gate.mjs';
import { npmViewLatest } from './npm-view.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

export const EXIT = Object.freeze({
  ok: 0,
  usage: 2,
  preflight: 3,
  dispatch: 4,
  correlation: 5,
  pollTimeout: 6,
  runFailed: 7,
  verify: 8,
  unreachable: 9,
});

export const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

// The publish.yml NAMED-package vocabulary → package dir. `all` is deliberately NOT an entry:
// it is a dispatch-only token (what the workflow receives), never a package dir — the two
// target lists below (dispatch vs preflight/verify) keep the roles distinct.
export const PKG_DIRS = Object.freeze({
  memory: 'agent-workflow-memory',
  engine: 'agent-workflow-engine',
  kit: 'agent-workflow-kit',
});

// What ONE `all` run covers: the preflight/verify iteration order (kit last, matching the
// workflow's own `kit needs: [memory, engine]` ordering).
export const ALL_PACKAGES = Object.freeze(['memory', 'engine', 'kit']);

export const WORKFLOW_FILE = 'publish.yml';
const WORKFLOW_ONE_REL = '.github/workflows/_publish-one.yml';
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

// Bounded loops (test-injectable via deps.now/deps.sleep).
export const CORRELATION_WINDOW_MS = 120_000;
export const CORRELATION_POLL_MS = 5_000;
export const RUN_POLL_MS = 15_000;
export const NPM_VERIFY_ATTEMPTS = 10;
export const NPM_VERIFY_BACKOFF_MS = 10_000;
export const DEFAULT_POLL_TIMEOUT_S = 1200;
// D3a: every verify-stage lookup (npm fetch + gh Release) carries this per-attempt transport deadline,
// so a network-blocked endpoint classifies as UNREACHABLE instead of hanging. The retry loop's TOTAL
// worst case is bounded by NPM_VERIFY_ATTEMPTS × (this + NPM_VERIFY_BACKOFF_MS) — a finite ceiling.
export const VERIFY_TRANSPORT_DEADLINE_MS = 30_000;

// ── tag derivation: READ from _publish-one.yml, never assumed ─────────────────────────

// _publish-one.yml derives the Release tag as  tag="${{ inputs.dir }}-v$ver"  — assert that exact
// derivation still exists in the workflow text and return the equivalent mapper. If the workflow
// changes its derivation, this fails LOUD at preflight instead of verifying a wrong tag.
export const readTagTemplate = (workflowText) => {
  if (!/tag="\$\{\{ inputs\.dir \}\}-v\$ver"/.test(workflowText)) {
    throw fail(
      EXIT.preflight,
      `${WORKFLOW_ONE_REL} no longer derives the Release tag as "<package-dir>-v<version>" — update dispatch-publish.mjs to match the workflow before dispatching`,
    );
  }
  return (dir, version) => `${dir}-v${version}`;
};

// ── default (real) side-effect deps — every one injectable in tests ───────────────────

const runGitDefault = (args, cwd = REPO_ROOT) => {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw fail(EXIT.preflight, `git ${args.join(' ')} failed: ${(res.stderr || '').trim()}`);
  return res.stdout;
};

// Auth preflight — ONE cheap authenticated call (`gh api user`) BEFORE any dispatch, so a missing
// token fails LOUD with the PROJECT-SPECIFIC recovery instead of gh's generic "run gh auth login".
// This exists because a session once mis-read an empty `gh auth status` as a hard publish-blocker:
// gh here authenticates via GH_TOKEN (a PAT), which env_commands.md → "## Access / gh" documents
// loading — an unloaded token is a SKIPPED SETUP STEP, not a blocker. Injectable via ghApi for tests.
const firstLine = (text) => String(text ?? '').split('\n')[0].trim();
// Signatures of an AUTHENTICATION failure specifically (vs network / outage / permission). Only an
// auth failure earns the GH_TOKEN recovery — anything else keeps its raw error so a real outage is
// never mislabeled a "skipped token" (a wrong diagnosis is exactly the class this fix exists to end).
// A PRECISE auth-failure signature — narrow enough NOT to match a stray substring like "unknown
// authority" (an x509 TRANSPORT error) or a "token" mention in a non-auth message. A structurally
// observed HTTP 401 is the primary signal; these are the exact credential/login phrasings gh emits.
const GH_AUTH_FAILURE_RE = /bad credentials|not logged in|requires authentication|unauthenticated|gh auth login|http 401|\b401\b/i;
// The auth preflight (kept in EVERY mode — the Release lookup needs it). Mode-specific transport
// semantics (D2): an AUTH-shaped failure (structural 401 / precise credential+login signatures) is
// LOUD in every mode; a TYPED TRANSPORT failure (no HTTP response — nothing conclusive observed) is a
// loud preflight red in live/dry, but INCONCLUSIVE (EXIT.unreachable) in `--verify-only` — that lane
// exists precisely to be re-run when a sandbox blocked the network, so it must not paint a transport
// blip red. Transport is decided STRUCTURALLY (err.transport), never a broad message-text match.
export const assertGitHubAuth = (ghApi, { verifyOnly = false, deadlineMs, reRunCommand } = {}) => {
  try {
    // The auth preflight is itself a verify-stage lookup — bound it with the transport deadline so it
    // cannot hang before the main bounded verify (M1/D3a); a deadline timeout classifies as transport.
    ghApi({ path: 'user' }, deadlineMs ? { deadlineMs } : undefined);
  } catch (err) {
    // Structural 401 or a precise credential/login signature ⇒ AUTH. A typed transport error (x509 /
    // DNS / reset — whose message may merely CONTAIN "auth"ority) is NOT auth and falls through.
    const authShaped = err.ghStatus === 401 || GH_AUTH_FAILURE_RE.test(err.message ?? '');
    if (authShaped) {
      // Looks like missing auth → the project-specific recovery, and deliberately WITHOUT gh's raw
      // "run gh auth login" line (it contradicts this repo's GH_TOKEN mechanism and misled a session).
      throw fail(
        EXIT.preflight,
        'GitHub auth unavailable — gh could not authenticate.\n' +
          '  This is a SKIPPED SETUP STEP, not a publish blocker: this repo authenticates gh via GH_TOKEN\n' +
          '  (a PAT), NOT `gh auth login`. Simplest recovery: re-run with --token-file <your PAT file> —\n' +
          '  the dispatcher reads the file itself, no env export needed (the flat lane for shells whose\n' +
          '  env does not persist). The export form stays valid too — see docs/ai/env_commands.md, the\n' +
          '  "## Access / gh" block (export GH_TOKEN=$(… your PAT file …)). An empty\n' +
          '  `gh auth status` here means the token was never exported this session, not that it is missing.',
      );
    }
    if (verifyOnly && err.transport) {
      // Nothing conclusive was observed — the verify-only lane degrades to inconclusive, not a red, and
      // prints the CANONICAL --verify-only recovery command (targets + --expect + --repo) so a degraded
      // auth preflight recovers exactly like a degraded verify.
      throw fail(
        EXIT.unreachable,
        `GitHub auth preflight could not REACH GitHub (${firstLine(err.message)}) — the --verify-only\n` +
          '  lane is INCONCLUSIVE (no HTTP response was observed, so nothing was verified). Re-run OUTSIDE\n' +
          `  the sandbox once the network is reachable:\n    ${reRunCommand ?? '(the --verify-only command)'}`,
      );
    }
    // NOT obviously auth (network / GitHub outage / permission) — keep the raw failure honest, never
    // dress it up as a missing token; point at the token recovery only as a fallback.
    throw fail(
      EXIT.preflight,
      `GitHub auth could not be proven — \`gh api user\` failed, and this does not look like a missing\n` +
        `  token (network / GitHub outage / permissions?): ${firstLine(err.message)}\n` +
        '  If it IS auth, load GH_TOKEN per docs/ai/env_commands.md "## Access / gh" and re-run.',
    );
  }
};

// Typed transport classification (D3). The signal that separates "the server responded" from "we
// never reached it" is the OUTPUT SHAPE, never the exit code alone: a gh HTTP 404 and a gh DNS
// failure BOTH exit nonzero. An OBSERVED HTTP status ⇒ reachable (loud path); a process that ran and
// exited nonzero with NO observed status ⇒ no HTTP response was received ⇒ transport ⇒ UNREACHABLE.
const GH_HTTP_STATUS_RE = /HTTP (\d{3})/;

// gh REST (GH_TOKEN per docs/ai/env_commands.md). method GET → parsed JSON; POST with fields. A
// failure is thrown TYPED: `.transport` true ⇒ no HTTP response was observed (DNS/connection/reset/
// TLS/timeout); `.localError` true ⇒ a LOCAL/process failure (gh not installed/executable, output
// too large) — loud, never "unreachable"; `.ghStatus` carries an observed HTTP status when present.
// Non-verify callers keep the loud EXIT.dispatch; the verify stage reads `.transport` to degrade to
// UNREACHABLE. `deadlineMs` bounds the spawn (D3a). `spawnImpl` is injectable so T2e/T2g drive the
// classifier with low-level fixtures.
export const ghApiDefault = ({ method = 'GET', path, fields = {} } = {}, { deadlineMs, spawnImpl = spawnSync } = {}) => {
  const args = ['api', '-X', method, path];
  for (const [key, value] of Object.entries(fields)) args.push('-f', `${key}=${value}`);
  const res = spawnImpl('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...(deadlineMs ? { timeout: deadlineMs } : {}) });
  // A DEADLINE timeout ⇒ transport (unreachable). A NON-timeout spawn error (gh not on PATH / not
  // executable / output too large) is a LOCAL/process failure — LOUD, never "unreachable" (M3): the
  // degrade must not tell the user to leave the sandbox for a broken local install.
  const timedOut = (res.error && res.error.code === 'ETIMEDOUT') || (deadlineMs && res.signal === 'SIGTERM');
  if (timedOut) {
    throw Object.assign(fail(EXIT.dispatch, `gh api ${method} ${path} timed out after ${deadlineMs}ms — endpoint unreachable`), { transport: true, ghStatus: null });
  }
  if (res.error) {
    throw Object.assign(
      fail(EXIT.dispatch, `gh api ${method} ${path} could not run LOCALLY (${res.error.code ?? res.error.message}) — a local/process error (gh not installed / not executable / output too large), NOT a network transport failure`),
      { transport: false, localError: true, ghStatus: null },
    );
  }
  if (res.status !== 0) {
    const out = `${res.stderr || ''}\n${res.stdout || ''}`;
    const statusMatch = out.match(GH_HTTP_STATUS_RE);
    const observedStatus = statusMatch ? Number(statusMatch[1]) : null;
    // The process RAN and exited nonzero: an OBSERVED HTTP status ⇒ reachable (the server answered —
    // a 404 / permission red stays loud); NO observed status ⇒ no HTTP response was received ⇒
    // TRANSPORT (M2 — classify by response-SHAPE, never an allowlist of error phrasings: a
    // `connection reset` / `x509` / `TLS handshake` failure carries no status and IS transport).
    const transport = observedStatus === null;
    throw Object.assign(
      fail(EXIT.dispatch, `gh api ${method} ${path} failed: ${(res.stderr || res.stdout || '').trim()}`),
      { transport, ghStatus: observedStatus },
    );
  }
  const body = (res.stdout || '').trim();
  return body === '' ? null : JSON.parse(body);
};

const sleepDefault = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// ── arg parsing (usage → exit 2) ──────────────────────────────────────────────────────

const USAGE =
  'usage: dispatch-publish.mjs all | <pkg>... [--expect <pkg>=X.Y.Z]... [--ref <ref>] [--live | --verify-only] [--poll-timeout <seconds>] [--repo <owner/name>] [--token-file <path>]';

// Reads the PAT for --token-file. Strips EVERY CR/LF (the documented `tr -d '\r\n'` semantics —
// a PAT file often ends in a newline, and a multi-line paste must collapse the same way the
// export form always did). Unreadable or empty fails LOUD at usage time: an empty GH_TOKEN would
// otherwise surface later as gh's misleading generic auth error. The token value is returned,
// never logged.
export const loadGhToken = (path, readFile = readFileSync) => {
  let raw;
  try {
    raw = String(readFile(path, 'utf8'));
  } catch (err) {
    throw fail(EXIT.usage, `--token-file: cannot read ${path} (${err?.code ?? 'error'}) — the file must hold the GitHub PAT this repo publishes with (docs/ai/env_commands.md "## Access / gh")`);
  }
  const token = raw.replace(/[\r\n]/g, '');
  if (token === '') {
    throw fail(EXIT.usage, `--token-file: ${path} is empty after stripping line endings — it must hold the GitHub PAT this repo publishes with`);
  }
  return token;
};

export const parseArgs = (argv) => {
  const opts = { packages: [], expect: {}, ref: 'main', live: false, verifyOnly: false, pollTimeoutS: DEFAULT_POLL_TIMEOUT_S, repo: null, tokenFile: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--live') opts.live = true;
    else if (arg === '--verify-only') opts.verifyOnly = true;
    else if (arg === '--ref') {
      i += 1;
      if (argv[i] === undefined) throw fail(EXIT.usage, '--ref requires a ref argument');
      opts.ref = argv[i];
    } else if (arg === '--repo') {
      i += 1;
      if (argv[i] === undefined) throw fail(EXIT.usage, '--repo requires an owner/name argument');
      // Validated to a plain owner/name: it is rendered into a copy-paste `--verify-only` recovery
      // command, so a shell metacharacter (`;` `&&` `|` `$()` backtick, whitespace) must never reach it.
      if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(argv[i])) throw fail(EXIT.usage, `--repo must be a plain owner/name with no shell metacharacters (got "${argv[i]}")`);
      opts.repo = argv[i];
    } else if (arg === '--token-file') {
      i += 1;
      if (argv[i] === undefined) throw fail(EXIT.usage, '--token-file requires a path argument (the file holding the GitHub PAT)');
      opts.tokenFile = argv[i];
    } else if (arg === '--poll-timeout') {
      i += 1;
      const parsed = Number(argv[i]);
      if (!Number.isInteger(parsed) || parsed <= 0) throw fail(EXIT.usage, '--poll-timeout requires a positive integer (seconds)');
      opts.pollTimeoutS = parsed;
    } else if (arg === '--expect') {
      i += 1;
      const token = argv[i];
      if (token === undefined) throw fail(EXIT.usage, '--expect requires <pkg>=X.Y.Z');
      const eq = token.indexOf('=');
      if (eq <= 0 || eq === token.length - 1) throw fail(EXIT.usage, `--expect must be <pkg>=X.Y.Z (got "${token}")`);
      const pkg = token.slice(0, eq);
      const version = token.slice(eq + 1);
      if (!PKG_DIRS[pkg]) throw fail(EXIT.usage, `--expect: unknown package "${pkg}" (known: ${Object.keys(PKG_DIRS).join(', ')})`);
      if (!SEMVER_RE.test(version)) throw fail(EXIT.usage, `--expect version must be X.Y.Z (got "${version}")`);
      opts.expect[pkg] = version;
    } else if (arg.startsWith('--')) {
      throw fail(EXIT.usage, `unknown argument "${arg}"\n${USAGE}`);
    } else {
      opts.packages.push(arg);
    }
  }
  if (opts.help) return opts;
  if (opts.verifyOnly && opts.live) throw fail(EXIT.usage, '--verify-only and --live are mutually exclusive — verify-only performs ZERO dispatches and only re-runs the post-publish verify');
  if (opts.packages.length === 0) throw fail(EXIT.usage, `no packages given\n${USAGE}`);
  if (opts.packages.includes('all')) {
    // `all` is accepted ONLY alone — mixed with named packages the intent is ambiguous (the
    // `all` run would already cover every named one).
    if (opts.packages.length > 1) {
      throw fail(EXIT.usage, '"all" must be given ALONE — one all-run already covers memory + engine + kit (drop the named packages, or name them without "all")');
    }
  } else {
    for (const pkg of opts.packages) {
      if (!PKG_DIRS[pkg]) throw fail(EXIT.usage, `unknown package "${pkg}" (known: all, ${Object.keys(PKG_DIRS).join(', ')})`);
    }
    if (new Set(opts.packages).size !== opts.packages.length) throw fail(EXIT.usage, 'duplicate package in the ordered list');
    const kitIndex = opts.packages.indexOf('kit');
    if (kitIndex !== -1 && kitIndex !== opts.packages.length - 1) {
      throw fail(EXIT.usage, 'kit must be LAST in the ordered list (it composes on memory + engine — Issue-007 ordering)');
    }
  }
  if (opts.live || opts.verifyOnly) {
    // Both --live and --verify-only need an expectation for every target — verify-only compares the
    // published artifact to --expect, so it is as required there as it is for --live. For `all`, every
    // family package needs one (an unchanged package's expectation is its already-published version).
    const required = opts.packages.includes('all') ? ALL_PACKAGES : opts.packages;
    const missing = required.filter((pkg) => !opts.expect[pkg]);
    if (missing.length > 0) {
      const flag = opts.verifyOnly ? '--verify-only' : '--live';
      throw fail(EXIT.usage, `${flag} requires --expect <pkg>=X.Y.Z for every ${opts.packages.includes('all') ? 'family package (all = memory + engine + kit)' : 'target package'} (missing: ${missing.join(', ')})`);
    }
  }
  return opts;
};

// The canonical `--verify-only` re-run render (D2/D3b) — preserves every `--expect` and an explicit
// `--repo`. Without `pkgs` it preserves the original target shape (`all` vs the named list). With an
// explicit `pkgs` subset (M-B — after a partial flow, only the packages actually published +
// inconclusive need re-verification) it renders that NAMED list, never `all`: listing an un-published
// tail package would guarantee a false verify-red on the re-run.
export const renderVerifyOnlyCommand = (opts, pkgs = null) => {
  const isAll = opts.packages.includes('all');
  const targetPkgs = pkgs ?? (isAll ? ALL_PACKAGES : opts.packages);
  const target = !pkgs && isAll ? 'all' : targetPkgs.join(' ');
  const expects = targetPkgs.map((pkg) => `--expect ${pkg}=${opts.expect[pkg]}`).join(' ');
  const repoFlag = opts.repo ? ` --repo ${opts.repo}` : '';
  return `node scripts/release/dispatch-publish.mjs ${target} --verify-only ${expects}${repoFlag}`;
};

export const parseOriginRepo = (originUrl) => {
  const match = originUrl.trim().match(/github\.com[:/]([^/]+\/[^/.\s]+)(\.git)?$/);
  if (!match) throw fail(EXIT.preflight, `cannot derive owner/repo from origin url "${originUrl.trim()}" — pass --repo`);
  return match[1];
};

// ── the CHANGELOG stub gate (live preflight) ──────────────────────────────────────────

// `version-sync.mjs --bump` inserts a loud placeholder heading carrying this marker; the same
// release session replaces it with the real entry. "A stub cannot ship silently" is a GATE here,
// not a grep hope — the verify pass is deliberately stub-agnostic (the heading parses), so the
// LIVE preflight is the one place that refuses it.
export const RELEASE_STUB_MARKER = 'RELEASE-STUB';

// The newest entry = from the first `## ` heading to (exclusive) the next one.
export const newestChangelogEntry = (text) => {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s/.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
};

// ── the candidate-smoke preflight (kit-carrying dispatches only) ───────────────────────

// The kit is the package whose ADVISOR a consumer runs, so it is the one package whose behaviour a
// unit suite cannot fully certify: in this repo's own tree every source file is inside the coverage
// domain, and the false "flow optimal" cannot reproduce. `smoke-candidate.mjs` packs the candidate,
// installs it into a foreign project and asserts the outcome; this refuses to dispatch the kit
// without a receipt that covers the exact bytes being published.
//
// ORDERED before the FIRST dry-run dispatch, not just before the live one: a dry-run that concludes
// green is what the release lane reads as "the candidate is publishable", so a smoke checked only in
// live mode would arrive after the decision it exists to inform. `--verify-only` (zero dispatches)
// and a dispatch not carrying the kit skip it — there is nothing to smoke either way.
export const kitIsDispatched = (verifyTargets) => verifyTargets.includes('kit');

// What the receipt covers is the LOCAL candidate; what a dispatch RUNS is the remote ref. On the
// live path those are the same commit — the live preflight above refuses otherwise — but a dry-run
// may legitimately be exploratory, and there the two are free to differ. Saying so is the whole
// remedy: the receipt is never allowed to read as having smoked the bytes that were dispatched.
export const assertCandidateSmoke = ({ gitDir, kitVersion, headSha, expectedSha, readFile, log }) => {
  const violation = candidateSmokeViolation({ receipt: readSmokeReceipt(gitDir, readFile), kitVersion, headSha });
  if (violation !== null) throw fail(EXIT.preflight, `candidate smoke preflight: ${violation}`);
  log(`✓ candidate smoke receipt covers kit ${kitVersion} at local HEAD ${headSha}`);
  if (expectedSha !== headSha) {
    log(
      `  NOTE: this dispatch runs the REMOTE ref at ${expectedSha}, which is not the commit the smoke covered (${headSha}) — ` +
        'the smoke says nothing about the dispatched bytes here; a live dispatch requires the two to be equal.',
    );
  }
};

// The SECOND receipt a kit-carrying dispatch needs (Issue-016): the cross-version gate proves the
// three named axes (schema-accept / execution / producer-recognition) against the PUBLISHED kit.
// Same ordering rationale and same skips as the candidate smoke — before the FIRST dry-run
// dispatch, `--verify-only` and non-kit dispatches exempt. crossVersionGateViolation validates
// EVERY receipt field; the covering log line states the probed published version, because that is
// the fact the conditional arms were decided against.
export const assertCrossVersionGate = ({ gitDir, kitVersion, headSha, readFile, log }) => {
  const receipt = readGateReceipt(gitDir, readFile);
  const violation = crossVersionGateViolation({ receipt, kitVersion, headSha });
  if (violation !== null) throw fail(EXIT.preflight, `cross-version gate preflight: ${violation}`);
  log(`✓ cross-version gate receipt covers kit ${kitVersion} at local HEAD ${headSha} (all three axes PASS against published ${receipt.publishedVersion})`);
};

// ── the run machinery ─────────────────────────────────────────────────────────────────

const listRuns = (ghApi, repo) =>
  ghApi({ path: `repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=50` }).workflow_runs ?? [];

// Deterministic correlation: pre/post run-listing diff + head_sha match. Zero candidates inside
// the window, or more than one → REFUSE (exit 5) — never adopt an ambiguous run.
export const correlateRun = async ({ ghApi, repo, preIds, expectedSha, now, sleep, log }) => {
  const startedAt = now();
  while (now() - startedAt <= CORRELATION_WINDOW_MS) {
    const candidates = listRuns(ghApi, repo).filter((run) => !preIds.has(run.id) && run.head_sha === expectedSha);
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      throw fail(
        EXIT.correlation,
        `ambiguous run correlation: ${candidates.length} new workflow_dispatch runs at ${expectedSha} (${candidates.map((run) => run.id).join(', ')}) — refusing to adopt one`,
      );
    }
    log('   waiting for the dispatched run to appear…');
    await sleep(CORRELATION_POLL_MS);
  }
  throw fail(EXIT.correlation, `no new workflow_dispatch run at ${expectedSha} appeared within ${CORRELATION_WINDOW_MS / 1000}s`);
};

export const pollRunToConclusion = async ({ ghApi, repo, runId, pollTimeoutS, now, sleep, log }) => {
  const startedAt = now();
  for (;;) {
    const run = ghApi({ path: `repos/${repo}/actions/runs/${runId}` });
    if (run.status === 'completed') {
      if (run.conclusion !== 'success') {
        throw fail(EXIT.runFailed, `run ${runId} concluded "${run.conclusion}" — ${run.html_url ?? ''}`);
      }
      return run;
    }
    if (now() - startedAt > pollTimeoutS * 1000) {
      throw fail(EXIT.pollTimeout, `run ${runId} still "${run.status}" after ${pollTimeoutS}s — poll timeout (${run.html_url ?? ''})`);
    }
    log(`   run ${runId}: ${run.status}…`);
    await sleep(RUN_POLL_MS);
  }
};

const dispatchAndAwait = async ({ pkg, dryRun, ctx }) => {
  const { ghApi, repo, ref, expectedSha, pollTimeoutS, now, sleep, log } = ctx;
  const label = dryRun ? 'dry-run' : 'LIVE';
  log(`── dispatch ${label}: package=${pkg} ref=${ref}`);
  const preIds = new Set(listRuns(ghApi, repo).map((run) => run.id));
  ghApi({
    method: 'POST',
    path: `repos/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    fields: { ref, 'inputs[package]': pkg, 'inputs[dry_run]': dryRun ? 'true' : 'false' },
  });
  const run = await correlateRun({ ghApi, repo, preIds, expectedSha, now, sleep, log });
  log(`   correlated run ${run.id}`);
  await pollRunToConclusion({ ghApi, repo, runId: run.id, pollTimeoutS, now, sleep, log });
  log(`   ✓ ${label} ${pkg} concluded success (run ${run.id})`);
  return run;
};

// RETURNS a typed outcome, never throws (D3b — the caller collects per-package outcomes + continues):
//   { outcome: 'verified', name }
//   { outcome: 'unreachable', name, endpoint, cause }  — a TRANSPORT failure (npm or gh); the publish
//        concluded success, only the verify endpoint was unreachable → inconclusive, not a red.
//   { outcome: 'failed', name, detail }                — a REACHABLE red (wrong version after the
//        bounded retry, missing/draft Release, wrong asset count, or a parse-error body) → loud.
export const verifyPublished = async ({ pkg, ctx }) => {
  const { ghApi, repo, expect, tagFor, readLatest, readFile, root, sleep, log } = ctx;
  const dir = PKG_DIRS[pkg];
  const expected = expect[pkg];
  const name = JSON.parse(readFile(join(root, dir, 'package.json'), 'utf8')).name;
  let lastSeen = null;
  let verified = false;
  for (let attempt = 1; attempt <= NPM_VERIFY_ATTEMPTS && !verified; attempt += 1) {
    const latest = await Promise.resolve()
      .then(() => readLatest(name, { deadlineMs: VERIFY_TRANSPORT_DEADLINE_MS }))
      .catch((localError) => ({ localError }));
    if (latest && latest.localError) {
      return { outcome: 'failed', pkg, name, detail: `LOCAL npm failure: ${firstLine(latest.localError.message)}` };
    }
    if (latest && latest.transportError) {
      return { outcome: 'unreachable', pkg, name, endpoint: `npm registry (${name}@latest)`, cause: latest.transportError };
    }
    if (latest && latest.parseError) {
      return { outcome: 'failed', pkg, name, detail: `npm @latest for ${name} returned an unparseable body (${latest.parseError}) — reachable but malformed` };
    }
    lastSeen = latest && latest.version ? latest.version : `http ${latest && latest.httpError}`;
    if (lastSeen === expected) {
      verified = true;
    } else {
      log(`   npm @latest for ${name}: saw ${lastSeen}, want ${expected} (${attempt}/${NPM_VERIFY_ATTEMPTS})…`);
      await sleep(NPM_VERIFY_BACKOFF_MS);
    }
  }
  if (!verified) {
    return { outcome: 'failed', pkg, name, detail: `npm @latest for ${name} is "${lastSeen}", expected ${expected} — verification timed out after ${NPM_VERIFY_ATTEMPTS} attempts` };
  }
  const tag = tagFor(dir, expected);
  // A missing Release is a gh 404 (a status observed → reachable → loud); a TRANSPORT failure (no
  // HTTP response) is `.transport` → UNREACHABLE, never mislabeled "missing Release".
  let release = null;
  try {
    release = ghApi({ path: `repos/${repo}/releases/tags/${tag}` }, { deadlineMs: VERIFY_TRANSPORT_DEADLINE_MS });
  } catch (err) {
    if (err.transport) return { outcome: 'unreachable', pkg, name, endpoint: `GitHub Release ${tag}`, cause: firstLine(err.message) };
    return { outcome: 'failed', pkg, name, detail: `GitHub Release ${tag} could not be fetched (${firstLine(err.message)})` };
  }
  if (!release || release.draft !== false) return { outcome: 'failed', pkg, name, detail: `GitHub Release ${tag} is missing or still a draft` };
  const assetCount = (release.assets ?? []).length;
  if (assetCount !== 1) return { outcome: 'failed', pkg, name, detail: `GitHub Release ${tag} carries ${assetCount} assets, expected exactly 1 (the published tarball)` };
  log(`   ✓ verified ${name}@${expected} on npm + Release ${tag} (1 asset)`);
  return { outcome: 'verified', pkg, name };
};

// Collapse collected verify outcomes into an exit code + one enumerating message (D3b). Priority: a
// captured DISPATCH failure's exit code dominates (M5 — preserved, never lost to the outer catch);
// else a reachable FAILED anywhere → EXIT.verify; else any UNREACHABLE → EXIT.unreachable (with the
// --verify-only recovery); else all verified → EXIT.ok. The message names EXACTLY what concluded,
// what verified, and what is inconclusive — never more than what ran. `verifyOnly` mode (M6) never
// claims a publish it did not perform.
export const finalizeVerify = (outcomes, ctx, renderRecovery, { verifyOnly = false, dispatchFailure = null } = {}) => {
  const { log } = ctx;
  const verified = outcomes.filter((o) => o.outcome === 'verified');
  const unreachable = outcomes.filter((o) => o.outcome === 'unreachable');
  const failed = outcomes.filter((o) => o.outcome === 'failed');
  if (!dispatchFailure && !failed.length && !unreachable.length) {
    log(verifyOnly ? `✓ verified: ${verified.map((o) => o.name).join(' · ')}` : `✓ published + verified: ${verified.map((o) => o.name).join(' · ')}`);
    return EXIT.ok;
  }
  const parts = [];
  if (verified.length) parts.push(`${verifyOnly ? 'verified' : 'concluded + verified'}: ${verified.map((o) => o.name).join(', ')}`);
  if (dispatchFailure) parts.push(`dispatch FAILED: ${dispatchFailure.message}`);
  if (failed.length) parts.push(`verify FAILED (reachable red): ${failed.map((o) => `${o.name} — ${o.detail}`).join('; ')}`);
  if (unreachable.length) {
    parts.push(`verify INCONCLUSIVE (${verifyOnly ? 'endpoint unreachable' : 'publish concluded success; endpoint unreachable'}): ${unreachable.map((o) => `${o.name} @ ${o.endpoint} — ${o.cause}`).join('; ')}`);
    // M-B: the recovery re-verifies ONLY the inconclusive packages (the ones actually published) —
    // never an un-published tail package, which would false-red on the re-run.
    parts.push(`re-run the verify OUTSIDE the sandbox: ${renderRecovery(unreachable.map((o) => o.pkg))}`);
  }
  const label = verifyOnly ? 'verify' : 'post-publish verification';
  const exitCode = dispatchFailure ? (dispatchFailure.exitCode ?? 1) : (failed.length ? EXIT.verify : EXIT.unreachable);
  throw fail(exitCode, `${label} incomplete — ${parts.join(' · ')}`);
};

// ── the head-mismatch refusal: WHICH mismatch, never a guess (AD-098) ───────────────

// `ls-remote` says WHERE the remote ref is. It does not say whether this branch can still reach it,
// and the two mismatches it hides need OPPOSITE remedies: an unpushed commit is fixed by pushing, a
// diverged branch cannot be fast-forwarded, so no PLAIN push fixes it. AD-098 was the live instance — a full release
// built, then a non-fast-forward rejection at 292 remote-only against 300 local-only commits, while
// this refusal was still saying "must be pushed first".
//
// The probes run on the RAW process result, not through the throwing `runGit`: `rev-parse --verify`
// and `merge-base --is-ancestor` both use exit 1 as an ANSWER, and an exception cannot carry an
// answer. That is the whole reason for the separate dependency (the lossless leaf) — every existing
// call site keeps the throwing runGit unchanged.
const runGitRawDefault = (args, cwd = REPO_ROOT) => runGitProcess(args, { cwd });

// `git ls-remote origin <ref>` PATTERN-matches, it does not look a ref up: `main` can return
// `refs/heads/main`, `refs/tags/main`, `refs/heads/foo/main`, and a peeled `refs/tags/main^{}`.
// Taking the first whitespace token of that output picks one of them by luck of ordering, so the sha
// the whole live preflight compares against could belong to a ref this release never dispatches. The
// destination is therefore chosen by EXACT refname, every line is parsed strictly, and an ambiguous
// or unparseable answer refuses instead of guessing.
export const selectRemoteRef = (stdout, ref) => {
  const refuse = (error) => ({ oid: null, name: null, error });
  // EMPTY stdout is zero rows — a ref that matched nothing, which has its own message. A body that is
  // not empty must be lines: at most ONE trailing LF is stripped, and any remaining blank line is
  // malformed, because "every line is parsed strictly" has to mean it.
  const body = String(stdout);
  const rows = [];
  if (body !== '') {
    const text = body.endsWith('\n') ? body.slice(0, -1) : body;
    for (const line of text.split('\n')) {
      // A blank line needs no clause of its own: it splits to one field, and one field is not a row.
      const parts = line.split('\t');
      if (parts.length !== 2 || !/^[0-9a-f]+$/.test(parts[0]) || parts[1] === '') {
        return refuse(`git ls-remote origin ${ref} returned a line this run cannot parse: ${JSON.stringify(line)}`);
      }
      rows.push({ oid: parts[0], name: parts[1] });
    }
  }
  // A `^{}` entry is a PROJECTION of a ref, not a ref: nothing can be dispatched at it. Excluding it
  // before matching means no request — not even a literal `v1^{}` — can select one.
  const candidates = rows.filter((row) => !row.name.endsWith('^{}'));
  // A full ref is taken as written; a short name is looked for as a branch OR a tag, and finding
  // BOTH is the collision that must not be resolved silently.
  const wanted = ref.startsWith('refs/') ? [ref] : [`refs/heads/${ref}`, `refs/tags/${ref}`];
  const matches = candidates.filter((row) => wanted.includes(row.name));
  if (matches.length === 0) {
    return refuse(`git ls-remote origin ${ref} returned no exact ${wanted.join(' or ')} (it pattern-matches, so a near miss is not the ref you asked for)`);
  }
  if (matches.length > 1) {
    return refuse(`git ls-remote origin ${ref} is AMBIGUOUS — it matches ${matches.map((row) => row.name).join(' and ')}, and this run will not choose between them`);
  }
  return { oid: matches[0].oid, name: matches[0].name, error: null };
};

export const ANCESTRY = Object.freeze({
  ancestor: 'ancestor',
  behind: 'behind',
  diverged: 'diverged',
  shallow: 'shallow',
  resolvesToHead: 'resolves-to-head',
  unresolvable: 'unresolvable',
  undetermined: 'undetermined',
});

// ONLY exit 0 and exit 1 are answers. Everything else — 128, any other status, a null status, a
// spawn error, a kill signal — is the ABSENCE of an answer, and reading absence as a verdict is the
// one misreading that turns a safe refusal into a confidently wrong message. Enumerating just 128
// would leave a cold reader free to treat an exit 2 or 129 as an answer.
const probeAnswer = (res) =>
  (res.error == null && res.signal == null && (res.status === 0 || res.status === 1) ? res.status : null);

const probeCause = (res) => {
  if (res.signal != null) return `git was killed by ${res.signal}`;
  if (res.error != null) return `git could not be run: ${firstLine(res.error.message)}`;
  const detail = firstLine(res.stderr);
  const status = res.status === null ? 'with no status' : `with status ${res.status}`;
  return `git exited ${status}${detail ? `: ${detail}` : ''}`;
};

const undetermined = (cause) => ({ state: ANCESTRY.undetermined, cause });
const isObjectId = (value, likeThis) => value.length === likeThis.length && /^[0-9a-f]+$/.test(value);

// The object guard is `rev-parse --verify --quiet <sha>^{commit}`, NOT `cat-file -e`. Probed: for a
// well-formed but absent sha it exits 1, and for an object that EXISTS but is a blob it also exits
// 1 — the case `cat-file -e` would wrongly pass. Note what that makes exit 1 mean here: "does not
// resolve to a commit in this clone", which is NOT the claim "the object is missing", so the
// message must not make the stronger one. The guard is also not optional: once `ls-remote` reports
// a tip this clone has never fetched, an unguarded `merge-base --is-ancestor` dies with exit 128
// `fatal: Not a valid commit name`, and that is the DEFAULT path on a real divergence.
//
// The guard's stdout — the PEELED oid — is what the rest of the run uses. `ls-remote` reports the
// object the ref points AT, which for an annotated tag is the tag object, not its commit; peeling
// and then classifying the peeled commit is the only way the answer describes commits at all. And
// if the peeled oid IS the local head, the two ids differ only by ref type, which is a fact worth
// saying rather than dressing up as an unpushed commit.
//
// Both ancestry directions are probed, because one of them cannot tell two mismatches apart: exit 1
// from `merge-base --is-ancestor <remote> <head>` says only "the remote tip does not reach HEAD",
// which is equally true of a branch merely BEHIND the remote and of a genuine fork.
//
// Every command addresses the CAPTURED head oid, never the literal `HEAD`: a concurrent checkout
// between two probes would otherwise classify a commit the message does not name.
//
// A POSITIVE answer (exit 0) is a path git actually found, so it is trusted as it stands. Two
// NEGATIVE answers are trusted only in a complete repository: a shallow clone's history boundary
// can hide the very link that would prove an ancestry, so a fork is claimed only after
// `rev-parse --is-shallow-repository` says `false`. A shallow graph is its OWN outcome, not a
// broken probe — git answered, and the answer was "you cannot know this here".
export const probeAncestry = async (runGitRaw, sha, localHead, cwd) => {
  const present = await runGitRaw(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], cwd);
  const presentAnswer = probeAnswer(present);
  if (presentAnswer === null) return undetermined(probeCause(present));
  if (presentAnswer === 1) return { state: ANCESTRY.unresolvable, cause: null };
  // Exactly ONE line, hex, and the SAME WIDTH as the head oid this run captured. Anything else —
  // empty, multi-line, a different object format — is fail-closed here rather than handed to
  // merge-base as an operand, because a probe answering about the wrong object answers nothing.
  // EXACTLY `<oid>` or `<oid>\n`. Filtering blank lines out first would accept `\n<oid>\n\n`, which
  // is not what git prints and not what "one object id" means.
  const peeled = present.stdout.endsWith('\n') ? present.stdout.slice(0, -1) : present.stdout;
  if (!isObjectId(peeled, localHead)) {
    return undetermined(`git resolved ${sha} to ${JSON.stringify(present.stdout)}, which is not one object id of this repository's width`);
  }
  if (peeled === localHead) return { state: ANCESTRY.resolvesToHead, cause: null };

  const reaches = await runGitRaw(['merge-base', '--is-ancestor', peeled, localHead], cwd);
  const reachesAnswer = probeAnswer(reaches);
  if (reachesAnswer === null) return undetermined(probeCause(reaches));
  if (reachesAnswer === 0) return { state: ANCESTRY.ancestor, cause: null };

  const reached = await runGitRaw(['merge-base', '--is-ancestor', localHead, peeled], cwd);
  const reachedAnswer = probeAnswer(reached);
  if (reachedAnswer === null) return undetermined(probeCause(reached));
  if (reachedAnswer === 0) return { state: ANCESTRY.behind, cause: null };

  const complete = await runGitRaw(['rev-parse', '--is-shallow-repository'], cwd);
  if (complete.error != null || complete.signal != null || complete.status !== 0) return undetermined(probeCause(complete));
  // EXACTLY `true`/`false`, with at most one trailing newline — the same bytes the sibling guard in
  // preflight-remote accepts. Reading this loosely is how a padded or multi-line body becomes a
  // confident DIVERGED here while the other script refuses the very same answer.
  const truncated = complete.stdout.endsWith('\n') ? complete.stdout.slice(0, -1) : complete.stdout;
  if (truncated === 'true') return { state: ANCESTRY.shallow, cause: null };
  if (truncated !== 'false') return undetermined(`git answered ${JSON.stringify(complete.stdout)} when asked whether this repository is shallow`);
  return { state: ANCESTRY.diverged, cause: null };
};

// A ref reaches the operator's clipboard here, so it is quoted, never interpolated bare. The
// dispatcher deliberately accepts a wider ref set than the preflight does (tightening its input is
// a different change), and a name like `release;uname` would otherwise paste as two commands and
// run the second one before preflight-remote could refuse it. Single quotes make every byte
// literal; an embedded quote closes, escapes and reopens.
export const shellQuote = (value) => `'${String(value).split("'").join("'\\''")}'`;

// Every arm keeps the SAME refusal and the SAME exit code; only the reason changes.
//
// Ref-type awareness is computed ONCE, here, and no arm phrases a ref-type-dependent claim for
// itself. Two review rounds found the same defect in two different arms — a message assuming the
// destination is a branch — so the surface is subtracted rather than patched: an arm that ignores
// these three values cannot be written without ignoring them visibly.
//
// The conservative boundary is `refs/heads/`. What is claimed for it is deliberately NOT "a plain
// push cannot succeed": `remote.<name>.push` can send an ordinary push somewhere else entirely, so
// the honest claim is about UPDATING THE SELECTED REF without force. For every other namespace this
// script recommends nothing at all — it states the topology it observed and stops.
//
// And the claim is "requires an explicitly forced update", not "cannot succeed without `--force`":
// a non-fast-forward update also goes through `--force-with-lease` or a `+`-refspec, and
// force-with-lease is exactly what the sibling script offers. Naming one flag would make this
// message contradict the remedy the operator is about to be shown.
const BRANCH_PREFIX = 'refs/heads/';

export const describeDestination = (remoteRef) => {
  const branch = remoteRef.startsWith(BRANCH_PREFIX);
  return {
    branch,
    label: branch ? `origin/${remoteRef.slice(BRANCH_PREFIX.length)}` : `${remoteRef} on origin`,
    subject: branch ? 'this branch' : 'the selected ref',
  };
};

export const renderHeadMismatch = ({ ref, remoteRef, expectedSha, localHead, ancestry }) => {
  // REQUIRED, not defaulted: a missing refname would fall back to branch phrasing, which is exactly
  // the assumption this whole surface exists to remove.
  if (typeof remoteRef !== 'string' || remoteRef === '') {
    throw new Error('renderHeadMismatch requires the selected refname — a ref-type claim cannot be made without it');
  }
  const { branch, label, subject } = describeDestination(remoteRef);
  const seen = `${label} is at ${expectedSha} but the local HEAD is ${localHead}`;
  const step1 = `node scripts/release/preflight-remote.mjs --ref ${shellQuote(ref)}`;
  // The pointer says what step 1 IS, never what it will return. It does not promise a fetch either:
  // step 1 refuses a shallow repository BEFORE its network act, so promising one would make these
  // two scripts contradict each other in the very case the shallow arm describes.
  const pointer =
    `Run the release's step 1, \`${step1}\` — the first check of the\n` +
    '  release procedure. It refuses a repository or a ref it cannot verify, it names the choices\n' +
    '  when it can, and it never performs a remedy of its own';
  // Said only where it is true. Outside `refs/heads/` this script recommends nothing, because what
  // an ordinary push would do to such a ref is a matter of the operator's push configuration.
  const cannotUpdate = `updating ${label} from this HEAD requires an explicitly forced update`;
  const noAdvice = `${label} is not a branch, so no push is prescribed here — recommendations are\n  limited to \`refs/heads/\` refs`;

  if (ancestry.state === ANCESTRY.ancestor) {
    if (branch) {
      return `${seen} — the approved release commit must be pushed first; refusing ANY live dispatch`;
    }
    return (
      `${seen}, and that id resolves to an ancestor of HEAD. ${noAdvice}.\n` +
      `  ${pointer}. Refusing ANY live dispatch`
    );
  }
  if (ancestry.state === ANCESTRY.resolvesToHead) {
    return (
      `${seen}, and that id RESOLVES TO the local HEAD — it is an object peeling to this very commit\n` +
      '  (an annotated tag), not a different commit. Nothing is unpushed: the mismatch is one of ref\n' +
      '  TYPE, not of history. Refusing ANY live dispatch all the same — the dispatcher compares the\n' +
      '  id the remote reports for the ref, and that id is not a commit id'
    );
  }
  if (ancestry.state === ANCESTRY.behind) {
    return (
      `${seen}, and HEAD is contained in that commit — the remote is AHEAD of ${subject}, so the\n` +
      `  approved release commit is not the tip${branch ? ` and ${cannotUpdate}` : `. ${noAdvice}`}.\n` +
      `  ${pointer}.\n  Refusing ANY live dispatch`
    );
  }
  if (ancestry.state === ANCESTRY.diverged) {
    return (
      `${seen}, and neither commit reaches the other — ${subject} has DIVERGED${branch ? `, so ${cannotUpdate}` : ''}.\n` +
      `  It is NOT an unpushed commit${branch ? '; whether some other move is right is the maintainer\'s call, not\n  this script\'s' : `. ${noAdvice}`}.\n` +
      `  ${pointer}. Refusing ANY live dispatch`
    );
  }
  if (ancestry.state === ANCESTRY.shallow) {
    return (
      `${seen}, and neither commit reaches the other — but this repository is SHALLOW, and across a\n` +
      '  truncated history that pair of answers proves nothing: the link that would establish an\n' +
      '  ancestry can lie beyond the boundary. So the relationship is NOT classified here, and this\n' +
      '  is not a broken probe — git answered. Step 1 refuses this repository for the same reason\n' +
      // Bound to the remote, byte-for-byte the remedy the sibling guard in preflight-remote prints:
      // the two scripts refuse the same condition, so they must hand over the same command, and a
      // bare form would resolve through the branch's configured remote instead of this one.
      '  until the history is complete:\n    git fetch --unshallow origin\n' +
      `  ${pointer}.\n  Refusing ANY live dispatch`
    );
  }
  if (ancestry.state === ANCESTRY.unresolvable) {
    return (
      `${seen}, and the reported remote tip does not resolve to a commit in this clone — that is the\n` +
      '  whole observation: nothing here says WHY, and an object of the wrong type would look the\n' +
      `  same as one this clone has never seen. ${pointer}.\n  Refusing ANY live dispatch`
    );
  }
  return (
    `${seen}, and the relationship could NOT be determined (${ancestry.cause}) — refusing ANY live\n` +
    `  dispatch rather than reading an unanswered probe as a verdict. ${pointer}.`
  );
};

// ── the orchestrated flow ─────────────────────────────────────────────────────────────

export const runDispatch = async (argv, deps = {}) => {
  const {
    log = console.log,
    logError = console.error,
    ghApi = ghApiDefault,
    runGit = runGitDefault,
    runGitRaw = runGitRawDefault,
    readLatest = npmViewLatest,
    sleep = sleepDefault,
    now = Date.now,
    readFile = readFileSync,
    root = REPO_ROOT,
  } = deps;
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      log(USAGE);
      return EXIT.ok;
    }

    // The flat token lane loads BEFORE the auth preflight — every gh call this process spawns
    // inherits it. process.env is this process's own child-env source; the value is never logged.
    if (opts.tokenFile !== null) {
      process.env.GH_TOKEN = loadGhToken(opts.tokenFile, readFile);
    }

    // D6: `all` resolves to TWO distinct target lists — the DISPATCH target (what the workflow
    // receives: the single `all` token) and the preflight/verify target list (the package names
    // the stale-expect check + verifyPublished iterate). PKG_DIRS has no `all` entry, so one
    // shared list cannot serve both roles.
    const isAll = opts.packages.includes('all');
    const dispatchTargets = isAll ? ['all'] : opts.packages;
    const verifyTargets = isAll ? [...ALL_PACKAGES] : opts.packages;

    // Shared, dispatch-independent preflight: the tag mapper (local workflow read) + the repo (a git
    // config read or --repo). Both the dispatch lane and the verify-only lane need these.
    const tagFor = readTagTemplate(readFile(join(root, WORKFLOW_ONE_REL), 'utf8'));
    const repo = opts.repo ?? parseOriginRepo(runGit(['remote', 'get-url', 'origin']));
    // The recovery render is a function of the packages to re-verify — finalizeVerify scopes it to the
    // inconclusive ones (M-B); the default (no subset) preserves the original target shape.
    const renderRecovery = (pkgs) => renderVerifyOnlyCommand(opts, pkgs);

    // ── verify-only lane (D2): re-run ONLY the post-publish verify — ZERO dispatches, NO dry-run. It
    // SKIPS the dispatch-only preflights (ls-remote / clean-tree / stale-expect / stub gate — none
    // apply when nothing is dispatched) but KEEPS the gh auth preflight (the Release lookup needs it),
    // with the verify-only transport semantics (a transport auth failure is inconclusive, not a red).
    if (opts.verifyOnly) {
      assertGitHubAuth(ghApi, { verifyOnly: true, deadlineMs: VERIFY_TRANSPORT_DEADLINE_MS, reRunCommand: renderRecovery(null) });
      const ctx = { ghApi, repo, expect: opts.expect, tagFor, readLatest, readFile, root, sleep, log };
      const outcomes = [];
      for (const pkg of verifyTargets) outcomes.push(await verifyPublished({ pkg, ctx }));
      return finalizeVerify(outcomes, ctx, renderRecovery, { verifyOnly: true });
    }

    // Dispatch preflight — everything that can refuse a dispatch does so BEFORE any dispatch.
    const selected = selectRemoteRef(runGit(['ls-remote', 'origin', opts.ref]), opts.ref);
    if (selected.error !== null) throw fail(EXIT.preflight, `${selected.error}; refusing before ANY dispatch`);
    const expectedSha = selected.oid;
    if (opts.live) {
      const dirty = runGit(['status', '--porcelain']).trim();
      if (dirty !== '') throw fail(EXIT.preflight, `working tree is not clean — refusing ANY live dispatch:\n${dirty}`);
      const localHead = runGit(['rev-parse', 'HEAD']).trim();
      if (localHead !== expectedSha) {
        const ancestry = await probeAncestry(runGitRaw, expectedSha, localHead, root);
        throw fail(EXIT.preflight, renderHeadMismatch({ ref: opts.ref, remoteRef: selected.name, expectedSha, localHead, ancestry }));
      }
      for (const pkg of verifyTargets) {
        const dir = PKG_DIRS[pkg];
        // A stale --expect must never ship: the workflow publishes whatever package.json carries,
        // so each expectation is compared to the LOCAL package version BEFORE any dispatch — a
        // mismatch would otherwise publish the wrong artifact and fail only at post-verify.
        const localVersion = JSON.parse(readFile(join(root, dir, 'package.json'), 'utf8')).version;
        if (localVersion !== opts.expect[pkg]) {
          throw fail(
            EXIT.preflight,
            `--expect ${pkg}=${opts.expect[pkg]} but ${dir}/package.json carries ${localVersion} — a stale expectation; refusing ANY live dispatch`,
          );
        }
        // D4 stub gate: a CHANGELOG whose newest entry still carries the --bump placeholder
        // means the real entry was never written — refused before ANY dispatch.
        const newestEntry = newestChangelogEntry(readFile(join(root, dir, 'CHANGELOG.md'), 'utf8'));
        if (newestEntry !== null && newestEntry.includes(RELEASE_STUB_MARKER)) {
          throw fail(
            EXIT.preflight,
            `${dir}/CHANGELOG.md newest entry still carries ${RELEASE_STUB_MARKER} — write the real changelog entry before ANY live dispatch`,
          );
        }
      }
    }

    // The two RECEIPT preflights — candidate smoke, then the cross-version gate — close the local
    // preflights, still before EVERY dispatch including the dry-run one. They run after the
    // tree/version/stub refusals on purpose: a dirty tree must be reported as a dirty tree, not as
    // a stale receipt, and each receipt's own dirty rule is only meaningful once the more
    // fundamental state has been named.
    if (kitIsDispatched(verifyTargets)) {
      const gitDir = runGit(['rev-parse', '--absolute-git-dir']).trim();
      const kitVersion = JSON.parse(readFile(join(root, PKG_DIRS.kit, 'package.json'), 'utf8')).version;
      const headSha = runGit(['rev-parse', 'HEAD']).trim();
      assertCandidateSmoke({ gitDir, kitVersion, headSha, expectedSha, readFile, log });
      assertCrossVersionGate({ gitDir, kitVersion, headSha, readFile, log });
    }

    // GitHub auth is required for BOTH dry-run and live (every phase drives `gh api`) — prove it
    // ONCE here so a missing token fails with the project-specific recovery, never gh's generic hint.
    // Bounded (M1/D3a): a transport timeout here is a loud preflight red in live/dry.
    assertGitHubAuth(ghApi, { deadlineMs: VERIFY_TRANSPORT_DEADLINE_MS });

    const ctx = { ghApi, repo, ref: opts.ref, expectedSha, expect: opts.expect, tagFor, readLatest, readFile, root, pollTimeoutS: opts.pollTimeoutS, now, sleep, log };

    // Phase 1 — ALL dry-runs conclude green before the FIRST live dispatch (for `all` that is
    // ONE dry-run workflow run covering the family).
    for (const pkg of dispatchTargets) await dispatchAndAwait({ pkg, dryRun: true, ctx });
    log(`✓ all ${dispatchTargets.length} dry-run(s) green (${dispatchTargets.join(' → ')})`);
    if (!opts.live) {
      log('dry-run mode — no live dispatch performed (re-run with --live after approval).');
      return EXIT.ok;
    }

    // Phase 2 — live. Named lists dispatch in order (kit last enforced at parse) and verify after
    // each package; `all` is ONE live run (ordering lives in the workflow's `kit needs`) verified for
    // every family package afterwards. D3b: verify outcomes are COLLECTED — an UNREACHABLE verify
    // (transport failure; the publish itself concluded success) never aborts the remaining work; a
    // reachable-red or a dispatch failure dominates the final exit code.
    const outcomes = [];
    let dispatchFailure = null;
    for (const pkg of dispatchTargets) {
      try {
        await dispatchAndAwait({ pkg, dryRun: false, ctx });
      } catch (err) {
        // M5: a dispatch failure mid-flow is finalized WITH the accumulated outcomes (prior
        // publishes/inconclusives), preserving its hard exit code — never lost to the outer catch.
        dispatchFailure = err;
        break;
      }
      if (!isAll) {
        const outcome = await verifyPublished({ pkg, ctx });
        outcomes.push(outcome);
        // M4: a REACHABLE verify red stops the named flow before the next live dispatch — don't publish
        // more after a confirmed-bad publish (continuation is only for an inconclusive transport degrade).
        if (outcome.outcome === 'failed') break;
      }
    }
    if (isAll && !dispatchFailure) {
      for (const pkg of verifyTargets) outcomes.push(await verifyPublished({ pkg, ctx }));
    }
    return finalizeVerify(outcomes, ctx, renderRecovery, { verifyOnly: false, dispatchFailure });
  } catch (err) {
    logError(`[dispatch-publish] ${err.message}`);
    return err.exitCode ?? 1;
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
if (isDirectRun) {
  runDispatch(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
