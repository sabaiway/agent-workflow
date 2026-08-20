#!/usr/bin/env node
// smoke-candidate.mjs — the PRE-publish candidate smoke (repo-local, tracked).
//
// smoke-init.mjs is the POST-publish lane: it installs `@latest` FROM the registry, so by
// construction it cannot say anything about bytes that are not published yet. This is its mirror
// image. It packs the CANDIDATE, installs THAT tarball into a throwaway FOREIGN project, and runs
// the installed advisor over it — the one assertion a unit run cannot make, because a unit run
// exercises the advisor in this repo's own tree, where every source file is inside the coverage
// domain and the false green cannot reproduce.
//
// What it refuses to let ship: a kit whose advisor attests `no recommendations — flow optimal.`
// over a project whose primary source tree the changed-line coverage domain never reaches. The
// assertion is on the machine-readable VARIANT identifier, never on prose — the wording of an item
// is free to change, the outcome identity is not.
//
//   node scripts/release/smoke-candidate.mjs [--tarball <path>] [--keep]
//
//   --tarball  skip `npm pack` and smoke an already-built tarball. The receipt records that the
//              bytes were supplied by hand, and the live publish preflight refuses such a receipt:
//              a hand-supplied tarball is not provably the tree that is about to be published.
//   --keep     leave the sandbox dirs behind for triage.
//
// The pack lands in a TEMP dir, never the package dir: a tarball dropped beside package.json
// dirties the working tree that the publish dispatcher's clean-tree preflight reads. The repo's
// `git status --porcelain` is captured before and after and compared on BOTH the success and the
// failure path — a smoke that dirties the tree it is clearing for release would be its own defect.
//
// On PASS a receipt is written into the git dir (never the work tree) binding the outcome to the
// kit version + HEAD; `dispatch-publish.mjs` refuses a kit-carrying dispatch without a matching
// one. On FAIL nothing is written — a stale pass must never survive a red run.
//
// Exit 0 iff every assertion held; 1 on a violation or a failed step; 2 usage.
// Dependency-free, Node >= 22. No side effects on import.

import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSanitizedEnv } from './smoke-init.mjs';
import { buildForeignFixture } from '../testing/foreign-fixture.mjs';
import { COVERAGE_PRODUCER_BODY } from '../../agent-workflow-kit/tools/coverage-producer.mjs';
import { RECOMMENDATIONS_EMPTY_LINE } from '../../agent-workflow-kit/tools/recommendations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const KIT_DIR = 'agent-workflow-kit';
export const KIT_PACKAGE_NAME = '@sabaiway/agent-workflow-kit';

// The exact outcome the packed advisor must reach over the fixture. A prose match would go green
// on a reworded item and red on a rewording that changed nothing.
export const REQUIRED_VARIANT = 'gates-inert.coverage-domain-narrow';
export const FORBIDDEN_LINE = RECOMMENDATIONS_EMPTY_LINE;

export const SMOKE_RECEIPT_BASENAME = 'agent-workflow-smoke-candidate.json';
export const SMOKE_RECEIPT_SCHEMA = 1;
export const SMOKE_COMMAND = 'node scripts/release/smoke-candidate.mjs';

export const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

// ── the pure halves ───────────────────────────────────────────────────────────────────

const USAGE = 'usage: smoke-candidate.mjs [--tarball <path>] [--keep]';

export const parseArgs = (argv) => {
  const opts = { tarball: null, keep: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--tarball') {
      i += 1;
      if (argv[i] === undefined || argv[i] === '') throw fail(2, '--tarball requires a path to a packed candidate');
      opts.tarball = argv[i];
    } else {
      throw fail(2, `unknown argument "${arg}"\n${USAGE}`);
    }
  }
  return opts;
};

// The declaration the fixture carries: a RECOGNIZED producer that certifies the incidental JS,
// then the packaged canonical checker. Both halves matter. Without a live pair the advisor is in
// the dead-pair arm, which is a different outcome; with the pair live, the only thing left to say
// about this tree is that certification reaches its assessable minority — and saying nothing there
// is exactly the false green this lane exists to block.
export const candidateDeclaration = (installedToolsDir) => [
  { id: 'unit-tests', title: 'Incidental JS suite (the recognized producer)', cmd: `${COVERAGE_PRODUCER_BODY} scripts/*.test.mjs` },
  { id: 'coverage-check', title: 'Changed-line coverage (the final-run checker)', cmd: `node "${join(installedToolsDir, 'coverage-check.mjs')}" --check` },
];

// evaluateAdvisorRun({ jsonText, plainText }) → { ok, violations, variants }. Every failure mode is
// a NAMED violation rather than a thrown parse error: a smoke that dies on unparsable output and a
// smoke that saw the wrong verdict must not be reported the same way.
export const evaluateAdvisorRun = ({ jsonText, plainText }) => {
  const violations = [];
  let variants = [];
  let parsed = null;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    violations.push(`the packed advisor's --json output did not parse (${err.message})`);
  }
  if (parsed !== null) {
    if (!Array.isArray(parsed.items)) {
      violations.push('the packed advisor\'s --json payload carries no items array');
    } else {
      variants = parsed.items.map((item) => item.variant);
      if (!variants.includes(REQUIRED_VARIANT)) {
        violations.push(`the packed advisor did not report ${REQUIRED_VARIANT} over a tree the coverage domain cannot reach (variants: ${variants.join(', ') || 'none'})`);
      }
    }
  }
  if (plainText.includes(FORBIDDEN_LINE)) {
    violations.push(`the packed advisor attested "${FORBIDDEN_LINE}" over that same tree`);
  }
  return { ok: violations.length === 0, violations, variants };
};

export const buildReceipt = ({ kitVersion, headSha, dirty, packedFrom, at }) => ({
  schema: SMOKE_RECEIPT_SCHEMA,
  outcome: 'pass',
  kitVersion,
  headSha,
  dirty,
  packedFrom,
  variant: REQUIRED_VARIANT,
  at,
});

export const smokeReceiptPath = (gitDir) => join(gitDir, SMOKE_RECEIPT_BASENAME);

// readSmokeReceipt(gitDir, readFile) → the parsed receipt, or null when there is none to read.
// Unreadable and unparsable both read as ABSENT: the caller's refusal is identical either way, and
// a receipt nobody can read is not evidence of anything.
export const readSmokeReceipt = (gitDir, readFile = readFileSync) => {
  try {
    const parsed = JSON.parse(String(readFile(smokeReceiptPath(gitDir), 'utf8')));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

// candidateSmokeViolation({ receipt, kitVersion, headSha }) → a refusal sentence, or null when the
// receipt really covers the candidate about to be dispatched. Every field is a DIFFERENT way for a
// passing receipt to be about other bytes, so each states what it actually found.
//
// Every rule is mode-INDEPENDENT, and the two that once were live-only are the sharper half. A smoke
// over a dirty tree packs bytes that no commit names and that nothing keeps stable afterwards, so a
// receipt recording HEAD reads as covering a commit it never saw — and in the one case that matters
// most, a dirty tree at the dispatched sha, no mismatch line would warn about it either. A
// hand-supplied tarball is not provably any tree at all. Neither is worth a "dry-run only" exception:
// the dry-run's green is what the release lane reads as "the candidate is publishable".
export const candidateSmokeViolation = ({ receipt, kitVersion, headSha }) => {
  const rerun = `run \`${SMOKE_COMMAND}\` and re-dispatch`;
  if (receipt === null) return `no candidate smoke receipt for this tree — ${rerun}`;
  if (receipt.schema !== SMOKE_RECEIPT_SCHEMA) return `the candidate smoke receipt is schema ${receipt.schema}, this dispatcher reads ${SMOKE_RECEIPT_SCHEMA} — ${rerun}`;
  if (receipt.outcome !== 'pass') return `the candidate smoke receipt records "${receipt.outcome}", not a pass — ${rerun}`;
  if (receipt.kitVersion !== kitVersion) return `the candidate smoke passed for kit ${receipt.kitVersion}, but ${kitVersion} is being published — ${rerun}`;
  if (receipt.headSha !== headSha) return `the candidate smoke passed at ${receipt.headSha}, but HEAD is ${headSha} — ${rerun}`;
  if (receipt.dirty !== false) return `the candidate smoke ran over a DIRTY tree, so the bytes it packed are not the ones ${headSha} names — commit, then ${rerun}`;
  if (receipt.packedFrom !== 'repo') return `the candidate smoke used a hand-supplied tarball, which is not provably this tree — ${rerun}`;
  return null;
};

// ── the run ───────────────────────────────────────────────────────────────────────────

const execDefault = (cmd, args, { cwd, env } = {}) =>
  spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

const runStep = (exec, label, cmd, args, options) => {
  const res = exec(cmd, args, options);
  if (res.error || res.status !== 0) {
    const detail = res.error ? res.error.message : `${res.stderr ?? ''}\n${res.stdout ?? ''}`.trim();
    throw fail(1, `${label} failed: ${detail}`);
  }
  return res;
};

const gitOut = (exec, args, cwd) => String(runStep(exec, `git ${args.join(' ')}`, 'git', args, { cwd }).stdout ?? '').trim();

// The ONE tarball in a directory this run created empty. Reading the directory beats parsing npm's
// stdout: the pack output format is npm's to change, an empty dir with one file in it is not.
export const soleTarballIn = (dir, readDir = readdirSync) => {
  const found = readDir(dir).filter((name) => name.endsWith('.tgz'));
  if (found.length !== 1) throw fail(1, `npm pack left ${found.length} tarballs in ${dir} — expected exactly 1`);
  return join(dir, found[0]);
};

// The smoke proper. Every sandbox it creates is pushed onto `state` so the caller can tear them
// down and re-read the repo status whichever way this returns.
const runSmoke = (argv, deps, state) => {
  const {
    log = console.log,
    exec = execDefault,
    buildFixture = buildForeignFixture,
    readFile = readFileSync,
    writeFile = writeFileSync,
    readDir = readdirSync,
    removeFile = (path) => rmSync(path, { force: true }),
    baseEnv = process.env,
    root = REPO_ROOT,
    now = () => new Date().toISOString(),
  } = deps;
  const logError = deps.logError ?? console.error;
  const { sandboxes } = state;
  const opts = parseArgs(argv);
  if (opts.help) {
    log(USAGE);
    return 0;
  }
  const gitDir = gitOut(exec, ['rev-parse', '--absolute-git-dir'], root);
  // INVALIDATE FIRST, before the first step that can fail. A receipt is a claim about the LAST
  // completed smoke, and version + HEAD are all the dispatcher compares — so a red re-run over the
  // same commit would otherwise leave the previous PASS standing and keep clearing the dispatch it
  // was just re-run to question. The cost is the honest one: any started run invalidates the
  // previous claim, and the recovery is to finish a clean one.
  removeFile(smokeReceiptPath(gitDir));
  const headSha = gitOut(exec, ['rev-parse', 'HEAD'], root);
  const statusBefore = gitOut(exec, ['status', '--porcelain'], root);
  state.statusBefore = statusBefore;
  const kitVersion = JSON.parse(String(readFile(join(root, KIT_DIR, 'package.json'), 'utf8'))).version;

  const home = mkdtempSync(join(tmpdir(), 'smoke-candidate-home-'));
  const npmCache = mkdtempSync(join(tmpdir(), 'smoke-candidate-cache-'));
  sandboxes.push(home, npmCache);
  const env = buildSanitizedEnv(baseEnv, { home, npmCache });

  const tarball = (() => {
    if (opts.tarball !== null) return opts.tarball;
    const packDir = mkdtempSync(join(tmpdir(), 'smoke-candidate-pack-'));
    sandboxes.push(packDir);
    log(`[smoke-candidate] packing ${KIT_DIR}@${kitVersion} into ${packDir}`);
    runStep(exec, 'npm pack', 'npm', ['pack', '--pack-destination', packDir], { cwd: join(root, KIT_DIR), env });
    return soleTarballIn(packDir, readDir);
  })();
  log(`[smoke-candidate] candidate tarball: ${tarball}`);

  const fixture = buildFixture({ prefix: 'smoke-candidate-project-' });
  state.teardownFixture = fixture.teardown;
  state.fixtureRoot = fixture.root;
  log(`[smoke-candidate] foreign fixture: ${fixture.root} (${fixture.census.unsupported} unsupported / ${fixture.census.assessable} assessable tracked files)`);
  runStep(exec, 'npm install (candidate tarball)', 'npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--offline', tarball], {
    cwd: fixture.root,
    env,
  });
  const installedTools = join(fixture.root, 'node_modules', KIT_PACKAGE_NAME, 'tools');
  writeFile(
    join(fixture.root, 'docs', 'ai', 'gates.json'),
    `${JSON.stringify({ gates: candidateDeclaration(installedTools) }, null, 2)}\n`,
  );

  const advisor = join(installedTools, 'recommendations.mjs');
  const jsonRun = runStep(exec, 'the packed advisor (--json)', 'node', [advisor, '--cwd', fixture.root, '--json'], { cwd: fixture.root, env });
  const plainRun = runStep(exec, 'the packed advisor', 'node', [advisor, '--cwd', fixture.root], { cwd: fixture.root, env });
  const verdict = evaluateAdvisorRun({ jsonText: String(jsonRun.stdout ?? ''), plainText: String(plainRun.stdout ?? '') });
  for (const violation of verdict.violations) logError(`[smoke-candidate] ✗ ${violation}`);
  if (!verdict.ok) {
    logError('[smoke-candidate] full advisor output follows:');
    logError(String(plainRun.stdout ?? '').trimEnd());
    log('[smoke-candidate] FAIL — the candidate would ship a false "flow optimal"; no receipt was written.');
    return 1;
  }
  log(`[smoke-candidate] ✓ ${REQUIRED_VARIANT} fired and "${FORBIDDEN_LINE}" is absent`);

  // The receipt is RETURNED, never written here: it may only be published once the tree has been
  // proven unchanged, which is a fact only the caller holds (the run has not finished dirtying
  // anything yet). Writing it here left a valid pass receipt behind on the one path that returns 1.
  state.receipt = buildReceipt({
    kitVersion,
    headSha,
    dirty: statusBefore !== '',
    packedFrom: opts.tarball === null ? 'repo' : 'supplied',
    at: now(),
  });
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
  const state = { sandboxes: [], teardownFixture: null, fixtureRoot: null, statusBefore: null, receipt: null, gitDir: null };
  let code;
  try {
    code = runSmoke(argv, deps, state);
  } catch (err) {
    logError(`[smoke-candidate] ${err.message}`);
    code = err.exitCode ?? 1;
  }
  // Cleanup is per-directory and INDEPENDENT: one failure must not leave the rest behind, and it
  // must never skip the tree assertion below — that is the one path on which a stray artifact could
  // both survive and go unreported. What is left is named by PATH, because "the dirs above" is not
  // an instruction anyone can follow for a temp dir that was never printed.
  const retained = [...state.sandboxes, ...(state.fixtureRoot === null ? [] : [state.fixtureRoot])];
  if (keep) {
    if (retained.length > 0) log(`[smoke-candidate] --keep: dirs retained (${retained.join(', ')})`);
  } else {
    const survivors = [];
    const remove = (dir, drop) => {
      try {
        drop();
      } catch (err) {
        survivors.push(`${dir} (${err.message})`);
      }
    };
    if (state.teardownFixture !== null) remove(state.fixtureRoot, state.teardownFixture);
    for (const dir of state.sandboxes) remove(dir, () => rmSync(dir, { recursive: true, force: true }));
    if (survivors.length > 0) {
      logError(`[smoke-candidate] cleanup failed for ${survivors.length} dir(s) — remove by hand: ${survivors.join(' · ')}`);
      code = code === 0 ? 1 : code;
    }
  }
  // The tree this lane is clearing for release must come out of it byte-identical — on the FAILURE
  // path too, which is exactly where a stray pack artifact would otherwise survive. It is an
  // ASSERTION, and an UNPROVABLE one is a failure: the receipt this run exists to write is a claim
  // about a tree, so a tree nobody can re-read is not a tree this run may vouch for.
  if (state.statusBefore !== null) {
    const statusAfter = (() => {
      try {
        return gitOut(exec, ['status', '--porcelain'], root);
      } catch (err) {
        logError(`[smoke-candidate] could not re-read the repo status (${err.message}) — the tree could not be proven unchanged`);
        return null;
      }
    })();
    if (statusAfter === null || statusAfter !== state.statusBefore) {
      if (statusAfter !== null) {
        logError(`[smoke-candidate] the smoke CHANGED the repo working tree — before:\n${state.statusBefore}\nafter:\n${statusAfter}`);
      }
      code = code === 0 ? 1 : code;
    }
  }
  // ONLY here, and only on a wholly clean run: a receipt is the dispatcher's licence to publish, so
  // it is published after everything that could still turn this run red has already spoken.
  if (code === 0 && state.receipt !== null) {
    try {
      writeFile(smokeReceiptPath(state.gitDir), `${JSON.stringify(state.receipt, null, 2)}\n`);
    } catch (err) {
      logError(`[smoke-candidate] the receipt could not be written (${err.message}) — nothing was recorded`);
      return 1;
    }
    log(`[smoke-candidate] PASS — receipt at ${smokeReceiptPath(state.gitDir)} (kit ${state.receipt.kitVersion} @ ${state.receipt.headSha}${state.receipt.dirty ? ', DIRTY tree — this receipt will NOT clear a dispatch' : ''})`);
  }
  return code;
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
if (isDirectRun) process.exitCode = runCli(process.argv.slice(2));
