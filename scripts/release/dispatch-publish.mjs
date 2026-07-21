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
//     pushed release commit) — refused before ANY dispatch on mismatch.
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
// Dependency-free, Node >= 22 (global fetch). No side effects on import.

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

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

// npm registry read, typed (D3). Envelope (flat — a success is the parsed JSON object, which carries
// `.version`): `{transportError}` (no response — DNS/connection/timeout/abort) · `{httpError}` (a
// status WAS observed — reachable) · `{parseError}` (reachable but malformed body) · the parsed JSON.
// `deadlineMs` bounds the fetch via an AbortController (D3a); `fetchImpl` is injectable for T2e/T2g.
export const fetchJsonDefault = async (url, { deadlineMs, fetchImpl = fetch } = {}) => {
  const controller = deadlineMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), deadlineMs) : null;
  try {
    const res = await fetchImpl(url, controller ? { signal: controller.signal } : {});
    if (!res.ok) return { httpError: res.status };
    try {
      return await res.json();
    } catch (err) {
      // res.json() rejected AFTER headers: a genuine malformed body is a SyntaxError → parseError
      // (reachable red). An abort (the deadline fired mid-body) or a dropped body stream is NOT
      // malformed JSON — it is a TRANSPORT failure, never a false reachable red.
      if (err && err.name === 'SyntaxError') return { parseError: err.message || 'invalid JSON' };
      const isAbort = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
      return { transportError: isAbort ? `timeout after ${deadlineMs}ms` : `response body unreadable (${(err && err.message) || 'stream failure'})` };
    }
  } catch (err) {
    const isAbort = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    return { transportError: isAbort ? `timeout after ${deadlineMs}ms` : ((err && err.message) || 'network failure') };
  } finally {
    if (timer) clearTimeout(timer);
  }
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

// Post-publish verification: npm `@latest` equals the expected version (bounded retry — the
// registry read-through cache can lag) and the GitHub Release exists, is published (not a
// draft), and carries EXACTLY ONE asset — at the tag _publish-one.yml derives.
//
// RETURNS a typed outcome, never throws (D3b — the caller collects per-package outcomes + continues):
//   { outcome: 'verified', name }
//   { outcome: 'unreachable', name, endpoint, cause }  — a TRANSPORT failure (npm or gh); the publish
//        concluded success, only the verify endpoint was unreachable → inconclusive, not a red.
//   { outcome: 'failed', name, detail }                — a REACHABLE red (wrong version after the
//        bounded retry, missing/draft Release, wrong asset count, or a parse-error body) → loud.
// Every lookup carries VERIFY_TRANSPORT_DEADLINE_MS (D3a) so a network-blocked endpoint cannot hang.
export const verifyPublished = async ({ pkg, ctx }) => {
  const { ghApi, repo, expect, tagFor, fetchJson, readFile, root, sleep, log } = ctx;
  const dir = PKG_DIRS[pkg];
  const expected = expect[pkg];
  const name = JSON.parse(readFile(join(root, dir, 'package.json'), 'utf8')).name;
  const encoded = name.replace('/', '%2F');
  let lastSeen = null;
  let verified = false;
  for (let attempt = 1; attempt <= NPM_VERIFY_ATTEMPTS && !verified; attempt += 1) {
    const latest = await fetchJson(`https://registry.npmjs.org/${encoded}/latest`, { deadlineMs: VERIFY_TRANSPORT_DEADLINE_MS });
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

// ── the orchestrated flow ─────────────────────────────────────────────────────────────

export const runDispatch = async (argv, deps = {}) => {
  const {
    log = console.log,
    logError = console.error,
    ghApi = ghApiDefault,
    runGit = runGitDefault,
    fetchJson = fetchJsonDefault,
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
      const ctx = { ghApi, repo, expect: opts.expect, tagFor, fetchJson, readFile, root, sleep, log };
      const outcomes = [];
      for (const pkg of verifyTargets) outcomes.push(await verifyPublished({ pkg, ctx }));
      return finalizeVerify(outcomes, ctx, renderRecovery, { verifyOnly: true });
    }

    // Dispatch preflight — everything that can refuse a dispatch does so BEFORE any dispatch.
    const lsRemote = runGit(['ls-remote', 'origin', opts.ref]).trim();
    const expectedSha = lsRemote.split(/\s/)[0];
    if (!expectedSha) throw fail(EXIT.preflight, `git ls-remote origin ${opts.ref} returned nothing — unknown ref`);
    if (opts.live) {
      const dirty = runGit(['status', '--porcelain']).trim();
      if (dirty !== '') throw fail(EXIT.preflight, `working tree is not clean — refusing ANY live dispatch:\n${dirty}`);
      const localHead = runGit(['rev-parse', 'HEAD']).trim();
      if (localHead !== expectedSha) {
        throw fail(
          EXIT.preflight,
          `origin/${opts.ref} is at ${expectedSha} but the local HEAD is ${localHead} — the approved release commit must be pushed first; refusing ANY live dispatch`,
        );
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

    // GitHub auth is required for BOTH dry-run and live (every phase drives `gh api`) — prove it
    // ONCE here so a missing token fails with the project-specific recovery, never gh's generic hint.
    // Bounded (M1/D3a): a transport timeout here is a loud preflight red in live/dry.
    assertGitHubAuth(ghApi, { deadlineMs: VERIFY_TRANSPORT_DEADLINE_MS });

    const ctx = { ghApi, repo, ref: opts.ref, expectedSha, expect: opts.expect, tagFor, fetchJson, readFile, root, pollTimeoutS: opts.pollTimeoutS, now, sleep, log };

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

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  runDispatch(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
