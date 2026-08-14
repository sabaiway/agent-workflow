#!/usr/bin/env node
// cross-version-gate.mjs — the Issue-016 cross-version release gate (repo-local, tracked).
//
// The cross-version question is not one question. This gate asserts all THREE axes by name against
// the PUBLISHED kit, installed fresh from the registry into a throwaway dir:
//   schema-accept        — what the published validator does with a marker-carrying gates.json
//   execution            — whether the NEW canonical producer cmd RUNS under the published
//                          run-gates and lands its lcov under the runner-injected AW_GIT_DIR
//   producer-recognition — whether each side reads the OTHER side's producer form correctly
//
// The conditional arms are DECIDED, never inferred from the accept itself: MARKER_AWARE_SINCE
// names the first marker-aware kit version, and the probed published semver is compared against
// it (the threshold, the evaluators, the fixtures and the receipt contract live in the
// cross-version-axes.mjs leaf, re-exported here). Below the threshold the published kit MUST
// reject the marker LOUDLY and its advisor MUST misread a NEW-form pair as inert (Issue-016's
// stated not-forward-safe direction); at or above it, acceptance and recognition become the
// assertions — "retired" is the label, and a regression re-rejecting the marker fails the gate.
//
//   node scripts/release/cross-version-gate.mjs [--keep]
//
// On PASS a receipt is written into the git dir (never the work tree) binding {candidate kit
// version, HEAD, probed published version} plus the full smoke-candidate contract (schema,
// outcome, dirty, one verdict per axis); dispatch-publish.mjs refuses a kit-carrying dispatch —
// dry-run included — without a covering one. On FAIL, or an unreachable registry, nothing is
// written and the exit is loud. The previous receipt is invalidated before the first fallible
// step, and the repo's `git status --porcelain` is captured before and compared after on BOTH
// paths. Exit 0 iff every axis held; 1 otherwise; 2 usage. Dependency-free, Node >= 22.

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { installPublishedKit } from './published-kit.mjs';
import { fail, REPO_ROOT, KIT_DIR, KIT_PACKAGE_NAME, candidateDeclaration } from './smoke-candidate.mjs';
import { buildForeignFixture } from '../testing/foreign-fixture.mjs';
import { LCOV_PRODUCER_KEY } from '../../agent-workflow-kit/tools/gates-declaration.mjs';
import { LCOV_BASENAME } from '../../agent-workflow-kit/tools/coverage-check.mjs';
import {
  MARKER_AWARE_SINCE, isMarkerAware, markerFixtureGates, executionFixtureGates,
  EXECUTION_TEST_REL, EXECUTION_TEST_BODY, candidateOldFormRecognition,
  evaluateSchemaAccept, evaluateExecution, evaluateProducerRecognition,
  buildGateReceipt, gateReceiptPath,
} from './cross-version-axes.mjs';

// The pure halves live in the axes leaf; the sanitized child env + the @latest install live in
// published-kit.mjs. Both are re-exported so historical import sites stay stable.
export * from './cross-version-axes.mjs';
export { gateChildEnv } from './published-kit.mjs';
import { gateChildEnv } from './published-kit.mjs';

// ── the run ───────────────────────────────────────────────────────────────────────────

const USAGE = 'usage: cross-version-gate.mjs [--keep]';

export const parseArgs = (argv) => {
  const opts = { keep: false, help: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--keep') opts.keep = true;
    else throw fail(2, `unknown argument "${arg}"\n${USAGE}`);
  }
  return opts;
};

const execDefault = (cmd, args, { cwd, env } = {}) => spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

const runStep = (exec, label, cmd, args, options) => {
  const res = exec(cmd, args, options);
  if (res.error || res.status !== 0) {
    const detail = res.error ? res.error.message : `${res.stderr ?? ''}\n${res.stdout ?? ''}`.trim();
    throw fail(1, `${label} failed: ${detail}`);
  }
  return res;
};

const gitOut = (exec, args, cwd) => String(runStep(exec, `git ${args.join(' ')}`, 'git', args, { cwd }).stdout ?? '').trim();

// The gate proper. Every sandbox and fixture is pushed onto `state` so the caller can tear them
// down and re-read the repo status whichever way this returns.
const runGate = (argv, deps, state) => {
  const {
    log = console.log,
    exec = execDefault,
    buildFixture = buildForeignFixture,
    readFile = readFileSync,
    writeFile = writeFileSync,
    removeFile = (path) => rmSync(path, { force: true }),
    fileExists = existsSync,
    mkdtemp = mkdtempSync,
    baseEnv = process.env,
    root = REPO_ROOT,
    now = () => new Date().toISOString(),
  } = deps;
  const logError = deps.logError ?? console.error;
  const opts = parseArgs(argv);
  if (opts.help) {
    log(USAGE);
    return 0;
  }
  const gitDir = gitOut(exec, ['rev-parse', '--absolute-git-dir'], root);
  // Invalidate FIRST, before the first step that can fail (the smoke-candidate rule): any started
  // run invalidates the previous claim, so a red re-run over the same commit can never leave the
  // old PASS standing and clearing the dispatch it was re-run to question.
  removeFile(gateReceiptPath(gitDir));
  const headSha = gitOut(exec, ['rev-parse', 'HEAD'], root);
  const statusBefore = gitOut(exec, ['status', '--porcelain'], root);
  state.statusBefore = statusBefore;
  const kitVersion = JSON.parse(String(readFile(join(root, KIT_DIR, 'package.json'), 'utf8'))).version;

  // Each dir is registered the moment it exists (review F3): a failure of a LATER mkdtemp must
  // never strand an earlier dir outside the caller's cleanup.
  const tempDir = (prefix) => {
    const dir = mkdtemp(join(tmpdir(), prefix));
    state.sandboxes.push(dir);
    return dir;
  };
  const home = tempDir('cross-version-home-');
  const npmCache = tempDir('cross-version-cache-');
  const installDir = tempDir('cross-version-install-');
  const env = gateChildEnv(baseEnv, { home, npmCache });

  log(`[cross-version-gate] installing ${KIT_PACKAGE_NAME}@latest into ${installDir}`);
  const { publishedVersion, installedTools } = installPublishedKit({ installDir, env, exec, readFile, writeFile });
  const markerAware = isMarkerAware(publishedVersion);
  log(`[cross-version-gate] published ${publishedVersion} vs MARKER_AWARE_SINCE ${MARKER_AWARE_SINCE} → the ${markerAware ? 'marker-aware' : 'marker-unaware'} arms are DECIDED`);

  const fixtureOf = (options) => {
    const fixture = buildFixture(options);
    state.fixtures.push(fixture);
    return fixture;
  };
  // The published run-gates' exit code is DATA here (5 is one arm's pass), so only a spawn failure
  // is a hard stop — never a nonzero exit.
  const runPublishedGates = (fixtureRoot) => {
    const res = exec('node', [join(installedTools, 'run-gates.mjs')], { cwd: fixtureRoot, env });
    if (res.error) throw fail(1, `the published run-gates could not be spawned: ${res.error.message}`);
    return { exitCode: res.status, output: `${res.stdout ?? ''}\n${res.stderr ?? ''}` };
  };
  const violations = [];
  const axisReport = (axis, axisViolations, passNote) => {
    if (axisViolations.length === 0) {
      log(`[cross-version-gate] ✓ ${axis} — ${passNote}`);
      return;
    }
    for (const violation of axisViolations) logError(`[cross-version-gate] ✗ ${violation}`);
    violations.push(...axisViolations);
  };

  const schemaFixture = fixtureOf({ prefix: 'cross-version-schema-', gates: markerFixtureGates() });
  const schemaRun = runPublishedGates(schemaFixture.root);
  axisReport(
    'schema-accept',
    evaluateSchemaAccept({ markerAware, exitCode: schemaRun.exitCode, output: schemaRun.output }),
    markerAware
      ? `the marker-aware published kit accepts the ${LCOV_PRODUCER_KEY} declaration (retired for this pair)`
      : `the marker-unaware published kit rejected the ${LCOV_PRODUCER_KEY} declaration loudly (exit 5, key named)`,
  );

  const execFixture = fixtureOf({ prefix: 'cross-version-execution-', gates: executionFixtureGates(), extraFiles: { [EXECUTION_TEST_REL]: EXECUTION_TEST_BODY } });
  const execRun = runPublishedGates(execFixture.root);
  axisReport(
    'execution',
    evaluateExecution({ exitCode: execRun.exitCode, lcovExists: fileExists(join(execFixture.root, '.git', LCOV_BASENAME)) }),
    'the published run-gates ran the NEW-form producer and the lcov landed under the runner-injected AW_GIT_DIR',
  );

  // Axis 3 rides a JS-dominated tree on purpose: an inert read must come from the PAIR, never from
  // the census domain-narrow arm. The candidate half judges the INDEPENDENT prior-form literals —
  // never the live set, which would be tautological (review F1).
  const oldForms = candidateOldFormRecognition();
  const pairFixture = fixtureOf({ prefix: 'cross-version-pair-', tsFiles: 0, jsFiles: 3, gates: candidateDeclaration(installedTools) });
  const advisorRun = runStep(exec, 'the published advisor (--json)', 'node', [join(installedTools, 'recommendations.mjs'), '--cwd', pairFixture.root, '--json'], { cwd: pairFixture.root, env });
  axisReport(
    'producer-recognition',
    evaluateProducerRecognition({ markerAware, oldForms, advisorJsonText: String(advisorRun.stdout ?? '') }),
    markerAware
      ? 'the candidate recognizes every prior emitted form; the published advisor recognizes the NEW-form pair'
      : "the candidate recognizes every prior emitted form; the published advisor misreads the NEW-form pair as inert (Issue-016's stated direction)",
  );

  if (violations.length > 0) {
    log(`[cross-version-gate] FAIL — ${violations.length} axis violation(s); no receipt was written.`);
    return 1;
  }
  // RETURNED, never written here: the receipt may only be published once the tree is proven
  // unchanged, which is a fact only the caller holds.
  state.receipt = buildGateReceipt({ kitVersion, headSha, dirty: statusBefore !== '', publishedVersion, at: now() });
  state.gitDir = gitDir;
  return 0;
};

export const runCli = (argv, deps = {}) => {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  const exec = deps.exec ?? execDefault;
  const writeFile = deps.writeFile ?? writeFileSync;
  const root = deps.root ?? REPO_ROOT;
  const keep = argv.includes('--keep');
  const state = { sandboxes: [], fixtures: [], statusBefore: null, receipt: null, gitDir: null };
  let code;
  try {
    code = runGate(argv, deps, state);
  } catch (err) {
    logError(`[cross-version-gate] ${err.message}`);
    code = err.exitCode ?? 1;
  }
  // Cleanup is per-directory and INDEPENDENT (the smoke-candidate shape): one failure never
  // strands the rest or skips the tree assertion below, and survivors are named by PATH.
  const retained = [...state.sandboxes, ...state.fixtures.map((fixture) => fixture.root)];
  if (keep) {
    if (retained.length > 0) log(`[cross-version-gate] --keep: dirs retained (${retained.join(', ')})`);
  } else {
    const survivors = [];
    const remove = (dir, drop) => {
      try {
        drop();
      } catch (err) {
        survivors.push(`${dir} (${err.message})`);
      }
    };
    for (const fixture of state.fixtures) remove(fixture.root, fixture.teardown);
    for (const dir of state.sandboxes) remove(dir, () => rmSync(dir, { recursive: true, force: true }));
    if (survivors.length > 0) {
      logError(`[cross-version-gate] cleanup failed for ${survivors.length} dir(s) — remove by hand: ${survivors.join(' · ')}`);
      code = code === 0 ? 1 : code;
    }
  }
  // The tree this lane is clearing for release must come out byte-identical — on the FAILURE path
  // too, and an UNPROVABLE tree is a failure: a receipt is a claim about a tree, and a tree nobody
  // can re-read is not one this run may vouch for.
  if (state.statusBefore !== null) {
    const statusAfter = (() => {
      try {
        return gitOut(exec, ['status', '--porcelain'], root);
      } catch (err) {
        logError(`[cross-version-gate] could not re-read the repo status (${err.message}) — the tree could not be proven unchanged`);
        return null;
      }
    })();
    if (statusAfter === null || statusAfter !== state.statusBefore) {
      if (statusAfter !== null) {
        logError(`[cross-version-gate] the run CHANGED the repo working tree — before:\n${state.statusBefore}\nafter:\n${statusAfter}`);
      }
      code = code === 0 ? 1 : code;
    }
  }
  // ONLY here, and only on a wholly clean run: the receipt is the dispatcher's licence to publish.
  if (code === 0 && state.receipt !== null) {
    try {
      writeFile(gateReceiptPath(state.gitDir), `${JSON.stringify(state.receipt, null, 2)}\n`);
    } catch (err) {
      logError(`[cross-version-gate] the receipt could not be written (${err.message}) — nothing was recorded`);
      return 1;
    }
    log(`[cross-version-gate] PASS — receipt at ${gateReceiptPath(state.gitDir)} (kit ${state.receipt.kitVersion} @ ${state.receipt.headSha}, published ${state.receipt.publishedVersion} probed${state.receipt.dirty ? ', DIRTY tree — this receipt will NOT clear a dispatch' : ''})`);
  }
  return code;
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = runCli(process.argv.slice(2));
