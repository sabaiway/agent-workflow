#!/usr/bin/env node
// dispatch-publish.mjs — the ordered per-package publish dispatcher (repo-local, tracked).
//
// Replaces the turn-by-turn babysitting of `gh api` dispatch/poll/parse during Release
// Publishing: one invocation dispatches .github/workflows/publish.yml per package (NEVER
// `package=all` — Issue-007), polls every run to conclusion, and (in live mode) verifies the
// published artifact on npm + the GitHub Release.
//
//   node scripts/release/dispatch-publish.mjs <pkg>... [--expect <pkg>=X.Y.Z]... [--ref <ref>]
//        [--live] [--poll-timeout <seconds>] [--repo <owner/name>]
//
//   <pkg>...        ordered package list: memory | engine | kit (kit LAST when present — refused
//                   otherwise; Issue-007 ordering). One dispatch per package.
//   --expect        (repeatable) the intended version per package — feeds the post-publish
//                   verification; REQUIRED for every package in --live mode.
//   --ref           the git ref to dispatch on (default main).
//   --live          actually publish. Without it the script runs the DRY-RUN phase only.
//   --poll-timeout  per-run poll bound in seconds (default 1200).
//
// Invariants (pinned by dispatch-publish.test.mjs):
//   • NEVER self-triggering — this script runs ONLY when invoked after the maintainer's explicit
//     publish approval; nothing in the repo calls it automatically. Live mode requires --live.
//   • ALL dry-runs for the ordered list conclude green BEFORE the first live dispatch — a later
//     package's dry-run failure can never leave a partial release.
//   • Live preflight: clean tree AND `git ls-remote origin <ref>` == the local HEAD (the approved,
//     pushed release commit) — refused before ANY dispatch on mismatch.
//   • Deterministic run correlation: workflow_dispatch returns no run id, so each dispatch is
//     correlated via a pre/post run-listing diff + head_sha match; zero or multiple candidates →
//     REFUSE (never guess someone else's run).
//   • The Release tag is derived EXACTLY as _publish-one.yml derives it (`<package-dir>-v<version>`)
//     — the derivation line is READ from the workflow file at preflight and the run fails loudly
//     if the workflow no longer matches (the mapping is never assumed).
//   • Post-publish verification is bounded-retry (registry `@latest` can lag), with a loud timeout.
//
// Distinct exit codes: 0 ok · 2 usage · 3 preflight · 4 dispatch · 5 correlation · 6 poll
// timeout · 7 run concluded non-success · 8 post-publish verification failure.
// Dependency-free, Node >= 18 (global fetch). No side effects on import.

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
});

export const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

// The publish.yml package vocabulary (minus the forbidden `all`) → package dir.
export const PKG_DIRS = Object.freeze({
  memory: 'agent-workflow-memory',
  engine: 'agent-workflow-engine',
  kit: 'agent-workflow-kit',
});

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
const GH_AUTH_FAILURE_RE = /auth|login|401|unauthenti|credential|token|bad credentials/i;
export const assertGitHubAuth = (ghApi) => {
  try {
    ghApi({ path: 'user' });
  } catch (err) {
    if (GH_AUTH_FAILURE_RE.test(err.message ?? '')) {
      // Looks like missing auth → the project-specific recovery, and deliberately WITHOUT gh's raw
      // "run gh auth login" line (it contradicts this repo's GH_TOKEN mechanism and misled a session).
      throw fail(
        EXIT.preflight,
        'GitHub auth unavailable — gh could not authenticate.\n' +
          '  This is a SKIPPED SETUP STEP, not a publish blocker: this repo authenticates gh via GH_TOKEN\n' +
          '  (a PAT), NOT `gh auth login`. Load it, then re-run — see docs/ai/env_commands.md, the\n' +
          '  "## Access / gh" block (export GH_TOKEN=$(… your PAT file …); export GH_TOKEN). An empty\n' +
          '  `gh auth status` here means the token was never exported this session, not that it is missing.',
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

// gh REST (GH_TOKEN per docs/ai/env_commands.md). method GET → parsed JSON; POST with fields.
const ghApiDefault = ({ method = 'GET', path, fields = {} }) => {
  const args = ['api', '-X', method, path];
  for (const [key, value] of Object.entries(fields)) args.push('-f', `${key}=${value}`);
  const res = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (res.status !== 0) {
    throw fail(EXIT.dispatch, `gh api ${method} ${path} failed: ${(res.stderr || res.stdout || '').trim()}`);
  }
  const body = (res.stdout || '').trim();
  return body === '' ? null : JSON.parse(body);
};

const fetchJsonDefault = async (url) => {
  const res = await fetch(url);
  if (!res.ok) return { httpError: res.status };
  return res.json();
};

const sleepDefault = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// ── arg parsing (usage → exit 2) ──────────────────────────────────────────────────────

const USAGE =
  'usage: dispatch-publish.mjs <pkg>... [--expect <pkg>=X.Y.Z]... [--ref <ref>] [--live] [--poll-timeout <seconds>] [--repo <owner/name>]';

export const parseArgs = (argv) => {
  const opts = { packages: [], expect: {}, ref: 'main', live: false, pollTimeoutS: DEFAULT_POLL_TIMEOUT_S, repo: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--live') opts.live = true;
    else if (arg === '--ref') {
      i += 1;
      if (argv[i] === undefined) throw fail(EXIT.usage, '--ref requires a ref argument');
      opts.ref = argv[i];
    } else if (arg === '--repo') {
      i += 1;
      if (argv[i] === undefined) throw fail(EXIT.usage, '--repo requires an owner/name argument');
      opts.repo = argv[i];
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
  if (opts.packages.length === 0) throw fail(EXIT.usage, `no packages given\n${USAGE}`);
  for (const pkg of opts.packages) {
    if (pkg === 'all') throw fail(EXIT.usage, 'package "all" is refused — one dispatch per package (Issue-007); list them in order instead');
    if (!PKG_DIRS[pkg]) throw fail(EXIT.usage, `unknown package "${pkg}" (known: ${Object.keys(PKG_DIRS).join(', ')})`);
  }
  if (new Set(opts.packages).size !== opts.packages.length) throw fail(EXIT.usage, 'duplicate package in the ordered list');
  const kitIndex = opts.packages.indexOf('kit');
  if (kitIndex !== -1 && kitIndex !== opts.packages.length - 1) {
    throw fail(EXIT.usage, 'kit must be LAST in the ordered list (it composes on memory + engine — Issue-007 ordering)');
  }
  if (opts.live) {
    const missing = opts.packages.filter((pkg) => !opts.expect[pkg]);
    if (missing.length > 0) {
      throw fail(EXIT.usage, `--live requires --expect <pkg>=X.Y.Z for every dispatched package (missing: ${missing.join(', ')})`);
    }
  }
  return opts;
};

export const parseOriginRepo = (originUrl) => {
  const match = originUrl.trim().match(/github\.com[:/]([^/]+\/[^/.\s]+)(\.git)?$/);
  if (!match) throw fail(EXIT.preflight, `cannot derive owner/repo from origin url "${originUrl.trim()}" — pass --repo`);
  return match[1];
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
export const verifyPublished = async ({ pkg, ctx }) => {
  const { ghApi, repo, expect, tagFor, fetchJson, readFile, root, sleep, log } = ctx;
  const dir = PKG_DIRS[pkg];
  const expected = expect[pkg];
  const name = JSON.parse(readFile(join(root, dir, 'package.json'), 'utf8')).name;
  const encoded = name.replace('/', '%2F');
  let lastSeen = null;
  let verified = false;
  for (let attempt = 1; attempt <= NPM_VERIFY_ATTEMPTS && !verified; attempt += 1) {
    const latest = await fetchJson(`https://registry.npmjs.org/${encoded}/latest`);
    lastSeen = latest && latest.version ? latest.version : `http ${latest && latest.httpError}`;
    if (lastSeen === expected) {
      verified = true;
    } else {
      log(`   npm @latest for ${name}: saw ${lastSeen}, want ${expected} (${attempt}/${NPM_VERIFY_ATTEMPTS})…`);
      await sleep(NPM_VERIFY_BACKOFF_MS);
    }
  }
  if (!verified) {
    throw fail(EXIT.verify, `npm @latest for ${name} is "${lastSeen}", expected ${expected} — verification timed out after ${NPM_VERIFY_ATTEMPTS} attempts`);
  }
  const tag = tagFor(dir, expected);
  // A missing Release surfaces as a gh api 404 THROW (not a null return) — classify any failure
  // of this lookup as the precise verification exit code, never the generic dispatch one.
  let release = null;
  try {
    release = ghApi({ path: `repos/${repo}/releases/tags/${tag}` });
  } catch (err) {
    throw fail(EXIT.verify, `GitHub Release ${tag} could not be fetched (${err.message}) — treating as missing`);
  }
  if (!release || release.draft !== false) throw fail(EXIT.verify, `GitHub Release ${tag} is missing or still a draft`);
  const assetCount = (release.assets ?? []).length;
  if (assetCount !== 1) throw fail(EXIT.verify, `GitHub Release ${tag} carries ${assetCount} assets, expected exactly 1 (the published tarball)`);
  log(`   ✓ verified ${name}@${expected} on npm + Release ${tag} (1 asset)`);
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

    // Preflight — everything that can refuse does so BEFORE any dispatch.
    const tagFor = readTagTemplate(readFile(join(root, WORKFLOW_ONE_REL), 'utf8'));
    const repo = opts.repo ?? parseOriginRepo(runGit(['remote', 'get-url', 'origin']));
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
      // A stale --expect must never ship: the workflow publishes whatever package.json carries,
      // so each expectation is compared to the LOCAL package version BEFORE any dispatch — a
      // mismatch would otherwise publish the wrong artifact and fail only at post-verify.
      for (const pkg of opts.packages) {
        const dir = PKG_DIRS[pkg];
        const localVersion = JSON.parse(readFile(join(root, dir, 'package.json'), 'utf8')).version;
        if (localVersion !== opts.expect[pkg]) {
          throw fail(
            EXIT.preflight,
            `--expect ${pkg}=${opts.expect[pkg]} but ${dir}/package.json carries ${localVersion} — a stale expectation; refusing ANY live dispatch`,
          );
        }
      }
    }

    // GitHub auth is required for BOTH dry-run and live (every phase drives `gh api`) — prove it
    // ONCE here so a missing token fails with the project-specific recovery, never gh's generic hint.
    assertGitHubAuth(ghApi);

    const ctx = { ghApi, repo, ref: opts.ref, expectedSha, expect: opts.expect, tagFor, fetchJson, readFile, root, pollTimeoutS: opts.pollTimeoutS, now, sleep, log };

    // Phase 1 — ALL dry-runs conclude green before the FIRST live dispatch.
    for (const pkg of opts.packages) await dispatchAndAwait({ pkg, dryRun: true, ctx });
    log(`✓ all ${opts.packages.length} dry-run(s) green (${opts.packages.join(' → ')})`);
    if (!opts.live) {
      log('dry-run mode — no live dispatch performed (re-run with --live after approval).');
      return EXIT.ok;
    }

    // Phase 2 — live, in order (kit last enforced at parse), verify after each.
    for (const pkg of opts.packages) {
      await dispatchAndAwait({ pkg, dryRun: false, ctx });
      await verifyPublished({ pkg, ctx });
    }
    log(`✓ published + verified: ${opts.packages.map((pkg) => `${pkg}@${opts.expect[pkg]}`).join(' · ')}`);
    return EXIT.ok;
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
