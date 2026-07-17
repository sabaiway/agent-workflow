#!/usr/bin/env node
// migrate-adr-store.mjs — the consent-gated, opt-in migration of an EXISTING consumer's docs/ai from
// the retired 3-tier ADR cascade (HOT decisions.md → WARM/COLD monoliths) to the one-file-per-ADR
// store (HOT decisions.md + docs/ai/adr/AD-NNN-slug.md records + the docs/ai/adr/log.md navigator).
// Reached ONLY through the `migrate-adr-store` mode (SKILL.md), NEVER auto: a normal upgrade never
// installs the new-scheme rotator into an un-migrated consumer — the new rotator arrives ONLY here,
// which migrates in the same step (AD-051, Decision 13).
//
// What it does (in order, on --apply):
//   1. GATE  — docs/ai must be deployed; the OLD layout must be present (a decisions-archive monolith
//              on disk). No monolith → a stated no-op (already migrated, or a fresh new-scheme tree).
//   2. SNAPSHOT — write a durable pre-migration snapshot (decisions.md + both monoliths + the
//              pre-refresh consumer scripts/ copies) to the project's git dir (uncommittable), with a
//              stated out-of-tree fallback off git; fail LOUD if neither base is writable (Decision 5).
//   3. FORCE-REFRESH — overwrite the consumer's deployed enforcement scripts (the DIRECTIONAL subset:
//              only kit-canon basenames the consumer's scripts/ already has) with this kit's bundled
//              copies, so their ongoing pre-commit gates run the NEW rotator + the NEW collapse rule.
//              A locally-edited script is snapshotted (step 2) before it is overwritten — never
//              silently clobbered — and the dry-run preview names every script that differs.
//   4. MIGRATE — run the (new-scheme) rotator's conservation-checked --migrate --apply against the
//              project root: explode the monoliths into adr/ records, retire them, regenerate the
//              navigator + docs/ai/index.md. Idempotent / crash-resumable.
//
// Write discipline: preview (--dry-run) is the DEFAULT and writes NOTHING; --apply performs the
// migration. It NEVER commits. Exit codes: 0 done / dry-run / no-op; 1 precondition STOP (no
// deployment, no writable snapshot base, a failed migration); 2 usage. Dependency-free, Node >= 22.
// No side effects on import.

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { writeContainedFileAtomic, assertDocsAiDeployment } from './atomic-write.mjs';
import {
  monolithsPresent,
  HOT_REL,
  WARM_REL,
  COLD_REL,
  ADR_DIR_REL,
  runCli as runArchiveDecisions,
} from '../references/scripts/archive-decisions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = resolve(HERE, '..');
const KIT_SCRIPTS = join(KIT_ROOT, 'references', 'scripts');
const CONSUMER_SCRIPTS_REL = 'scripts';
const SNAPSHOT_PREFIX = 'agent-workflow-adr-migration-snapshot';

const EXIT_OK = 0;
const EXIT_PRECONDITION = 1;
const EXIT_USAGE = 2;

export const MIGRATE_ADR_STORE_STOP = 'MIGRATE_ADR_STORE_STOP';
const stop = (message) =>
  Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'MigrateAdrStoreStop', code: MIGRATE_ADR_STORE_STOP, exitCode: EXIT_PRECONDITION });
const usageFail = (message) =>
  Object.assign(new Error(`[agent-workflow-kit] ${message}`), { exitCode: EXIT_USAGE });

const USAGE = `usage: migrate-adr-store [--dry-run | --apply] [--cwd <dir>] [--help]

Opt-in migration of a project's docs/ai from the retired 3-tier ADR cascade to the one-file-per-ADR
store. Default is --dry-run: prints the migration plan (monoliths to retire, scripts to refresh, the
conservation proof) and writes NOTHING. --apply snapshots, force-refreshes the enforcement scripts,
then runs the conservation-checked migration. It NEVER commits — review the tree and commit yourself.`;

// The mutually-exclusive dry-run/apply parse (a consent-gated writer never lets a later flag silently
// decide whether it mutates) + --cwd — the family's shared consented-writer contract.
export const parseArgs = (argv) => {
  const parsed = argv.reduce(
    (acc, a, i) => {
      if (acc.skip) return { ...acc, skip: false };
      if (a === '--help' || a === '-h') return { ...acc, help: true };
      if (a === '--dry-run') {
        if (acc.apply === true) throw usageFail('--dry-run and --apply are mutually exclusive — pick one');
        return { ...acc, apply: false, dryRunExplicit: true };
      }
      if (a === '--apply') {
        if (acc.dryRunExplicit) throw usageFail('--dry-run and --apply are mutually exclusive — pick one');
        return { ...acc, apply: true };
      }
      if (a === '--cwd') {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('-')) throw usageFail('--cwd needs a value: --cwd <dir>');
        return { ...acc, cwd: value, skip: true };
      }
      throw usageFail(`unknown argument "${a}"\n${USAGE}`);
    },
    { apply: false, dryRunExplicit: false, cwd: undefined, help: false, skip: false },
  );
  return { apply: parsed.apply === true, cwd: parsed.cwd, help: parsed.help };
};

// The DIRECTIONAL force-refresh set (Decision 12/13): a kit-canon enforcement script whose basename is
// ALSO present in the consumer's scripts/ — never ADD a script the consumer lacks, never touch a
// root-only/non-canon file. Returns [{ name, canon, dst, differs }] for every refresh candidate.
export const planScriptRefresh = (cwd, deps = {}) => {
  const exists = deps.exists ?? existsSync;
  const read = deps.read ?? readFileSync;
  const kitScripts = deps.kitScripts ?? KIT_SCRIPTS;
  const consumerScripts = join(cwd, CONSUMER_SCRIPTS_REL);
  const out = [];
  for (const name of readdirSync(kitScripts).sort()) {
    const canon = join(kitScripts, name);
    if (!statSync(canon).isFile()) continue;
    const dst = join(consumerScripts, name);
    if (!exists(dst)) continue; // directional: the consumer does not deploy this script — never add it
    const differs = read(canon, 'utf8') !== read(dst, 'utf8');
    out.push({ name, canon, dst, differs });
  }
  return out;
};

const gitDirOf = (cwd, spawn) => {
  const r = spawn('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8' });
  return r && r.status === 0 && r.stdout ? r.stdout.trim() : null;
};

// A path is INSIDE the work tree (stageable) when cwd contains it. The git dir is EXEMPT — it lives
// under cwd but git never stages its own contents (uncommittable by construction, the Decision-5 basis).
const isUnder = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

// The ordered snapshot bases that are provably NOT stageable: the git dir first (always safe), then the
// fallback base ONLY when its snapshot dir lands OUTSIDE cwd (else it is in the work tree and could be
// committed — reject it; codex R1 minor). Returns [{ base, dir, viaGitDir }] (possibly empty).
const snapshotBases = (cwd, stamp, gitDir, fallbackBase) => {
  const bases = [];
  if (gitDir) bases.push({ base: gitDir, dir: resolve(gitDir, `${SNAPSHOT_PREFIX}-${stamp}`), viaGitDir: true });
  const fallbackDir = resolve(fallbackBase, `${SNAPSHOT_PREFIX}-${stamp}`);
  if (!isUnder(fallbackDir, resolve(cwd))) bases.push({ base: fallbackBase, dir: fallbackDir, viaGitDir: false });
  return bases;
};

// The pre-migration snapshot dir chosen for the preview: the first out-of-tree base (git dir, else a
// fallback proven outside cwd), or { dir: null } when none is available. Pure — creates nothing.
export const resolveSnapshotDir = (cwd, stamp, deps = {}) => {
  const spawn = deps.spawnSync ?? spawnSync;
  const fallbackBase = deps.snapshotFallbackBase ?? tmpdir();
  const gitDir = gitDirOf(cwd, spawn);
  const chosen = snapshotBases(cwd, stamp, gitDir, fallbackBase)[0] ?? null;
  return chosen ? { base: chosen.base, gitDir, dir: chosen.dir, viaGitDir: chosen.viaGitDir } : { base: null, gitDir, dir: null, viaGitDir: false };
};

// Write the durable snapshot (decisions.md + both monoliths + the pre-refresh consumer scripts). Tries
// the git dir first, then an out-of-tree fallback; fails LOUD if none is available/writable (Decision 5).
// Paths are flattened (/ → __) exactly like the rotator's own snapshot.
export const writeSnapshot = (cwd, refresh, stamp, deps = {}) => {
  const spawn = deps.spawnSync ?? spawnSync;
  const read = deps.read ?? readFileSync;
  const exists = deps.exists ?? existsSync;
  const mkdir = deps.mkdir ?? ((p) => mkdirSync(p, { recursive: true }));
  const write = deps.write ?? ((p, b) => writeFileSync(p, b, 'utf8'));
  const fallbackBase = deps.snapshotFallbackBase ?? tmpdir();
  const gitDir = gitDirOf(cwd, spawn);
  const bases = snapshotBases(cwd, stamp, gitDir, fallbackBase);
  if (bases.length === 0) {
    throw stop(`refusing to migrate: no out-of-tree snapshot location (not a git repo, and the fallback would land inside the work tree ${cwd}) — a durable, non-stageable pre-migration snapshot is mandatory`);
  }

  const files = [];
  for (const rel of [HOT_REL, WARM_REL, COLD_REL]) {
    const abs = join(cwd, rel);
    if (exists(abs)) files.push({ rel, content: read(abs, 'utf8') });
  }
  for (const { name, dst } of refresh) {
    if (exists(dst)) files.push({ rel: `${CONSUMER_SCRIPTS_REL}/${name}`, content: read(dst, 'utf8') });
  }

  let lastErr = null;
  for (const { dir, viaGitDir } of bases) {
    try {
      mkdir(dir);
      for (const { rel, content } of files) write(resolve(dir, rel.replace(/[/\\]/g, '__')), content);
      return { dir, viaGitDir, fileCount: files.length };
    } catch (err) {
      lastErr = err;
    }
  }
  throw stop(`refusing to migrate: no writable snapshot location (${lastErr && lastErr.message}) — a durable pre-migration snapshot is mandatory`);
};

// Overwrite each refresh target with the kit canon, atomically, preserving the canon's exec bit.
const applyScriptRefresh = (cwd, refresh, deps = {}) => {
  const read = deps.read ?? readFileSync;
  const chmod = deps.chmod ?? chmodSync;
  const stat = deps.stat ?? statSync;
  for (const { canon, dst, name } of refresh) {
    writeContainedFileAtomic(cwd, dst, read(canon, 'utf8'), deps, { stop, label: `${CONSUMER_SCRIPTS_REL}/${name}` });
    chmod(dst, stat(canon).mode & 0o777); // the exec bit is the git-tracked axis the mirror guard pins
  }
};

export const main = (argv = process.argv.slice(2), deps = {}) => {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const runMigrate = deps.runArchiveDecisions ?? runArchiveDecisions;
  const stamp = deps.stamp ?? new Date().toISOString().replace(/[:.]/g, '-');
  try {
    const args = parseArgs(argv);
    if (args.help) {
      log(USAGE);
      return EXIT_OK;
    }
    const cwd = resolve(args.cwd ?? process.cwd());
    assertDocsAiDeployment(cwd, deps, { stop, noun: 'the ADR store', rel: 'the docs/ai ADR store' });

    const monoliths = monolithsPresent(cwd);
    if (monoliths.length === 0) {
      const migrated = existsSync(join(cwd, ADR_DIR_REL));
      log(migrated
        ? '[migrate-adr-store] already migrated — the one-file-per-ADR store is in place (no legacy monolith); nothing to do.'
        : '[migrate-adr-store] nothing to migrate — no legacy decisions-archive monolith found (a fresh new-scheme tree).');
      return EXIT_OK;
    }

    const refresh = planScriptRefresh(cwd, deps);
    const drifted = refresh.filter((r) => r.differs);

    if (!args.apply) {
      const preview = resolveSnapshotDir(cwd, stamp, deps);
      log('[migrate-adr-store] --dry-run — no files will be changed. Planned migration:');
      log(`  old layout: ${monoliths.join(', ')} (will be exploded into ${ADR_DIR_REL}/ then retired)`);
      log(`  snapshot → ${preview.dir ? `${preview.dir} (${preview.viaGitDir ? 'git dir' : 'out-of-tree fallback'})` : 'NONE — no out-of-tree location; run inside a git repo (apply would refuse otherwise)'}`);
      log(`  refresh ${refresh.length} enforcement script(s) to this kit's version${drifted.length ? ` (${drifted.length} locally differ: ${drifted.map((r) => r.name).join(', ')})` : ''}`);
      log('  then the conservation-checked rotation:');
      // Surface the rotation's own exit code (codex R1 major): a failed dry-run must NOT print the
      // "run with --apply" go-ahead nor exit 0 — it would send the user to --apply on an unsafe tree.
      const code = runMigrate(['--migrate'], { root: cwd, log: (m) => log(`    ${m}`), logError: (m) => error(`    ${m}`) });
      if (code !== EXIT_OK) {
        throw stop(`the dry-run rotation would not conserve every ADR (exit ${code}) — NOT safe to --apply; fix the reported problem, then re-run.`);
      }
      // A null preview means --apply would refuse (no out-of-tree snapshot base) — never green-light it
      // (codex R2 minor: a dry-run go-ahead must not send the user to an apply that will STOP).
      if (preview.dir === null) {
        throw stop('no out-of-tree snapshot location — --apply would refuse; run inside a git repo (or point the fallback outside the project), then re-run.');
      }
      log('Run `/agent-workflow-kit migrate-adr-store` again with --apply to perform it (it never commits).');
      return EXIT_OK;
    }

    // Pre-flight: validate the rotation on a dry-run (conservation + store integrity) BEFORE any
    // mutation, so a failure aborts having touched nothing — no snapshot, no refreshed scripts, no
    // half-migrated tree. The error surfaces on logError; the plan itself is suppressed (already shown).
    const preflight = runMigrate(['--migrate'], { root: cwd, log: () => {}, logError: error });
    if (preflight !== EXIT_OK) {
      throw stop(`the migration would not conserve every ADR (dry-run exit ${preflight}) — refusing to touch the tree; fix the reported problem, then re-run.`);
    }

    const snapshot = writeSnapshot(cwd, refresh, stamp, deps);
    applyScriptRefresh(cwd, refresh, deps);
    const code = runMigrate(['--migrate', '--apply'], { root: cwd, log, logError: error });
    if (code !== EXIT_OK) {
      throw stop(`the rotation failed (exit ${code}) — the pre-migration snapshot is at ${snapshot.dir}; resolve the reported problem and re-run (the migration is idempotent).`);
    }
    log('[migrate-adr-store] migrated the 3-tier ADR cascade → one-file-per-ADR store:');
    log(`  snapshot: ${snapshot.dir} (${snapshot.viaGitDir ? 'git dir' : 'out-of-tree fallback'}, ${snapshot.fileCount} file(s))`);
    log(`  refreshed ${refresh.length} enforcement script(s) to this kit's version`);
    log('  next: run the normal upgrade (it re-stamps the deployment lineage to the current head),');
    log('  then review the migrated docs/ai/ tree and the re-stamp together and commit them yourself — this command never commits.');
    return EXIT_OK;
  } catch (err) {
    error(err.message);
    return err.exitCode ?? EXIT_PRECONDITION;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = main();
