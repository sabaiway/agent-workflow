#!/usr/bin/env node
// migrate-adr-store.mjs — the consent-gated, opt-in migration of an EXISTING consumer's docs/ai from
// the retired 3-tier ADR cascade (HOT decisions.md → WARM/COLD monoliths) to the one-file-per-ADR
// store (HOT decisions.md + docs/ai/adr/AD-NNN-slug.md records + the docs/ai/adr/log.md navigator).
// Reached ONLY through the `migrate-adr-store` mode (SKILL.md), NEVER auto: a normal upgrade never
// installs the new-scheme rotator into an un-migrated consumer — the new rotator arrives ONLY here,
// which migrates in the same step (AD-051, Decision 13).
//
// What it does (in order, on --apply):
//   1. GATE  — docs/ai must be deployed, and the tree must be on the OLD layout. That is TWO shapes:
//              a decisions-archive monolith on disk, OR no monolith at all but a deployed
//              scripts/archive-decisions.mjs that predates the store (the project simply never
//              rotated). The no-monolith shape runs the crossing WITHOUT an explosion — snapshot,
//              script refresh, then SEED the store — and is re-runnable to completion from any crash
//              point, because a store directory alone never counts as finished. A tree with no ADR
//              substrate at all, or one already finalised, is a stated no-op.
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
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { writeContainedFileAtomic, assertDocsAiDeployment } from './atomic-write.mjs';
import {
  monolithsPresent,
  HOT_REL,
  WARM_REL,
  COLD_REL,
  ADR_DIR_REL,
  NAV_REL,
  defaultRegenerateIndex,
  runCli as runArchiveDecisions,
} from '../references/scripts/archive-decisions.mjs';
import { isDirectRun } from './direct-run.mjs';
import { surveyAdrLayoutStrict, ADR_LAYOUT_PATHS } from './family-registry.mjs';

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

// COMPANION seeds: modules the refreshed archivers IMPORT. The refresh above is deliberately
// directional (never ADDS a basename the consumer lacks), but refreshing an OLD deployment's
// archivers to this kit's canon without their runtime dependency would leave every refreshed
// script crashing on a missing `./markdown-blocks.mjs` import until a separate upgrade run — so
// the dependency rides the SAME apply, atomically, written before its importers.
// `archive-caps.mjs` joined the list the moment `archive-changelog.mjs` began importing it: a new
// import by a refreshed archiver reopens this exact hole, so the list moves with the imports.
//
// A seed is UNCONDITIONAL only when every refreshable archiver imports it. `markdown-blocks.mjs` is
// imported by all three (changelog, decisions, issues), so any refresh needs it. `archive-caps.mjs`
// is imported by `archive-changelog.mjs` ALONE — seeding it on a plain ADR migration that never
// refreshed the changelog archiver would write a file with no importer, which is the directional
// "never ADD a basename the consumer lacks" rule broken and a log line that says something untrue.
const COMPANION_SEEDS = [
  { name: 'markdown-blocks.mjs', requiredBy: null },
  { name: 'markdown-blocks.test.mjs', requiredBy: null },
  { name: 'archive-caps.mjs', requiredBy: 'archive-changelog.mjs' },
  { name: 'archive-caps.test.mjs', requiredBy: 'archive-changelog.mjs' },
];
export const planCompanionSeeds = (cwd, refresh, deps = {}) => {
  if (refresh.length === 0) return [];
  const exists = deps.exists ?? existsSync;
  const kitScripts = deps.kitScripts ?? KIT_SCRIPTS;
  const consumerScripts = join(cwd, CONSUMER_SCRIPTS_REL);
  const refreshed = new Set(refresh.map((entry) => entry.name));
  const out = [];
  for (const { name, requiredBy } of COMPANION_SEEDS) {
    if (requiredBy !== null && !refreshed.has(requiredBy)) continue;
    const canon = join(kitScripts, name);
    const dst = join(consumerScripts, name);
    if (exists(canon) && !exists(dst)) out.push({ name, canon, dst });
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
// committed — reject it). Returns [{ base, dir, viaGitDir }] (possibly empty).
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
//
// ORDER MATTERS: the rotation script is what the layout discriminator reads, so it is written LAST.
// A crash partway through a refresh that had already flipped it would otherwise leave a tree that
// LOOKS refreshed while other scripts are still the old copies — and a resume, keying on that same
// script, would skip them forever. Written last, an interrupted refresh always re-plans in full.
const DISCRIMINATOR_SCRIPT = ADR_LAYOUT_PATHS.rotator.split('/').pop();
const refreshOrder = (refresh) => [
  ...refresh.filter((r) => r.name !== DISCRIMINATOR_SCRIPT),
  ...refresh.filter((r) => r.name === DISCRIMINATOR_SCRIPT),
];

const applyScriptRefresh = (cwd, refresh, deps = {}) => {
  const read = deps.read ?? readFileSync;
  const chmod = deps.chmod ?? chmodSync;
  const stat = deps.stat ?? statSync;
  // Companion modules FIRST (a dependency must land before its importers), refresh order after —
  // the discriminator still last, so an interrupted apply always re-plans in full. Returns the
  // seeded names (computed pre-write; recomputing after would see them present and report none).
  const seeds = planCompanionSeeds(cwd, refresh, deps);
  for (const { canon, dst, name } of [...seeds, ...refreshOrder(refresh)]) {
    writeContainedFileAtomic(cwd, dst, read(canon, 'utf8'), deps, { stop, label: `${CONSUMER_SCRIPTS_REL}/${name}` });
    chmod(dst, stat(canon).mode & 0o777); // the exec bit is the git-tracked axis the mirror guard pins
  }
  return seeds.map((s) => s.name);
};

// ── the no-monolith crossing ─────────────────────────────────────────────────────
//
// A consumer on the RETIRED scheme that never rotated far enough to produce a monolith used to read
// "a fresh new-scheme tree" here and be sent away. The discriminator is the deployed rotation
// script's own provenance (family-registry.mjs), never "has decisions.md, lacks adr/".
//
// Re-entry is decided by what is FINISHED, never by one existence bit: the store directory existing
// does not prove the navigator was written or the index regenerated, so a crash there must not turn
// the next --apply into a no-op. Every write below is individually idempotent, which is why this
// needs no resume ledger.

// The crossing is COMPLETE when the navigator exists, the tree's own gate passes, AND the index the
// crossing regenerates is fresh. The index is part of the criterion because it is a real output of
// the crossing that `--check` never looks at: a crash (or a failed regeneration) between the
// navigator write and the index left a tree that reported "already migrated" on the retry and never
// repaired the index. An unreachable index generator is NOT treated as fresh — the crossing re-runs
// and fails loudly again, which is the honest outcome for a broken generator.
const INDEX_GENERATOR = join(KIT_SCRIPTS, 'check-docs-size.mjs');
const isIndexFresh = (cwd, deps = {}) => {
  const spawn = deps.spawnSync ?? spawnSync;
  const r = spawn(process.execPath, [INDEX_GENERATOR, '--check-index', `--root=${cwd}`], { encoding: 'utf8' });
  return !r.error && r.status === 0;
};

// The layout verdict leads, and it is the SAME verdict the status line and the advisor read: an
// old-scheme rotator beside a finished store still answers `old-unrotated`, so treating that tree as
// done would leave the signal permanently lit with nothing able to clear it.
const isFinalised = (cwd, runMigrate, deps = {}) =>
  surveyAdrLayoutStrict(cwd, deps) === 'migrated' &&
  substratePresent(join(cwd, NAV_REL), deps) &&
  runMigrate(['--check'], { root: cwd, log: () => {}, logError: () => {} }) === EXIT_OK &&
  isIndexFresh(cwd, deps);

// `existsSync` answers false for EVERY failure, EACCES included — so asking it whether the substrate
// is there would turn an UNREADABLE tree into a confident "nothing to migrate", exit 0. Absence is
// ENOENT and nothing else; anything else is surfaced, never swallowed. Same policy the layout survey
// already enforces, now applied where the tool acts on it.
const substratePresent = (path, deps = {}) => {
  const stat = deps.statSync ?? statSync;
  try {
    stat(path);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw stop(`cannot read ${path} (${err && err.message}) — refusing to report on a tree it could not inspect`);
  }
};

const crossWithoutMonolith = (cwd, args, stamp, { log, error, runMigrate, deps }) => {
  const hasStore = substratePresent(join(cwd, ADR_DIR_REL), deps);
  const hasHot = substratePresent(join(cwd, HOT_REL), deps);

  if (!hasHot && !hasStore) {
    // NOT "a fresh new-scheme tree" — this tree may well be old-scheme; it simply has no ADR
    // substrate for the crossing to carry across, which is exactly the rotator's own skip.
    log(`[migrate-adr-store] nothing to migrate — no ADR substrate (neither ${HOT_REL} nor ${ADR_DIR_REL}/) and no legacy monolith.`);
    return EXIT_OK;
  }
  if (hasStore && isFinalised(cwd, runMigrate, deps)) {
    log('[migrate-adr-store] already migrated — the one-file-per-ADR store is in place and its gate is green; nothing to do.');
    return EXIT_OK;
  }
  if (!hasStore && surveyAdrLayoutStrict(cwd, deps) === 'none' && !substratePresent(join(cwd, ADR_LAYOUT_PATHS.rotator), deps)) {
    // Nothing to refresh (the refresh is directional — it never ADDS a script) and nothing to
    // maintain a store we might seed. The normal upgrade owns seeding the pair.
    log('[migrate-adr-store] nothing to migrate — no deployed rotation script; run the normal upgrade first (it seeds the ADR enforcement pair).');
    return EXIT_OK;
  }

  const refresh = planScriptRefresh(cwd, deps);
  const drifted = refresh.filter((r) => r.differs);
  // The read-only preflight: the SAME parse / half-migrated guard / store-integrity check the seed
  // itself runs, stopping before every write. Without it a dry-run could green-light an apply that
  // writes the store and only then discovers it cannot converge.
  const preflight = (logError) => runMigrate(['--write-navigator', '--dry-run'], { root: cwd, log: () => {}, logError });

  if (!args.apply) {
    const preview = resolveSnapshotDir(cwd, stamp, deps);
    // Three attempts to SUMMARISE why this tree needs the crossing produced three wrong sentences —
    // each true of the common case and false of a state this arm deliberately supports. So the
    // summary is gone: the preview states the two facts it actually knows, one per line, and the
    // reader draws the conclusion. Nothing here can drift out of step with the tree, because nothing
    // here is an inference. (Which scripts are stale is already reported by the refresh line below —
    // never re-asserted here.)
    const layout = surveyAdrLayoutStrict(cwd, deps);
    const rotatorFact = layout === 'old-unrotated'
      ? `predates the one-file-per-ADR store`
      : substratePresent(join(cwd, ADR_LAYOUT_PATHS.rotator), deps)
        ? `already names the store`
        : `not deployed`; // and NOT "nothing to refresh" — a sibling script may still need one
    log('[migrate-adr-store] --dry-run — no files will be changed. Planned crossing (no legacy monolith to retire):');
    log(`  deployed ${ADR_LAYOUT_PATHS.rotator}: ${rotatorFact}`);
    log(`  ${ADR_DIR_REL}/: ${hasStore ? 'present, but the crossing has not been completed' : 'absent'}`);
    log(`  snapshot → ${preview.dir ? `${preview.dir} (${preview.viaGitDir ? 'git dir' : 'out-of-tree fallback'})` : 'NONE — no out-of-tree location; run inside a git repo (apply would refuse otherwise)'}`);
    log(`  refresh ${refresh.length} enforcement script(s) to this kit's version${drifted.length ? ` (${drifted.length} locally differ: ${drifted.map((r) => r.name).join(', ')})` : ''}`);
    for (const s of planCompanionSeeds(cwd, refresh, deps)) log(`  seed companion module ${CONSUMER_SCRIPTS_REL}/${s.name} (imported by the refreshed archivers; absent at the consumer)`);
    log(`  then seed the store: create ${ADR_DIR_REL}/, write ${NAV_REL} and regenerate docs/ai/index.md`);
    const code = preflight((m) => error(`    ${m}`));
    if (code !== EXIT_OK) {
      throw stop(`the tree cannot be seeded as it stands (exit ${code}) — NOT safe to --apply; fix the reported problem, then re-run.`);
    }
    if (preview.dir === null) {
      throw stop('no out-of-tree snapshot location — --apply would refuse; run inside a git repo (or point the fallback outside the project), then re-run.');
    }
    log('  index regeneration is verified at --apply time (a dry-run cannot observe it without writing).');
    log('Run `/agent-workflow-kit migrate-adr-store` again with --apply to perform it (it never commits).');
    return EXIT_OK;
  }

  const pre = preflight(error);
  if (pre !== EXIT_OK) {
    throw stop(`the tree cannot be seeded as it stands (preflight exit ${pre}) — refusing to touch the tree; fix the reported problem, then re-run.`);
  }

  const snapshot = writeSnapshot(cwd, refresh, stamp, deps);
  // The FULL refresh is re-planned and re-applied on every entry, so an interrupted one always
  // completes; the discriminator script is written last (see refreshOrder).
  const seededNames = applyScriptRefresh(cwd, refresh, deps);

  // Capture the index-regeneration verdict instead of matching log prose: the rotator logs a failed
  // regeneration and still returns 0, so "the gates are green" would not mean the index is fresh.
  const regen = { ok: true, detail: '' };
  const seed = runMigrate(['--write-navigator'], {
    root: cwd,
    log,
    logError: error,
    regenerateIndex: (root, today, d) => {
      const r = (deps.regenerateIndex ?? defaultRegenerateIndex)(root, today, d);
      regen.ok = r.ok;
      regen.detail = r.detail;
      return r;
    },
  });
  if (seed !== EXIT_OK) {
    throw stop(`seeding the ADR store failed (exit ${seed}) — the pre-crossing snapshot is at ${snapshot.dir}; resolve the reported problem and re-run (the crossing is idempotent).`);
  }
  if (!regen.ok) {
    throw stop(`the ADR store was seeded but docs/ai/index.md was NOT regenerated (${regen.detail}) — the pre-crossing snapshot is at ${snapshot.dir}; fix the index generator and re-run (the crossing is idempotent).`);
  }
  const verify = runMigrate(['--check'], { root: cwd, log: () => {}, logError: error });
  if (verify !== EXIT_OK) {
    throw stop(`the ADR store was seeded but its own gate does not pass (exit ${verify}) — the pre-crossing snapshot is at ${snapshot.dir}; resolve the reported problem and re-run (the crossing is idempotent).`);
  }

  // States what this run DID, never what the tree was before it: the same arm completes an
  // interrupted crossing whose scripts were already current, which no "old-scheme" claim covers.
  log('[migrate-adr-store] crossing complete — the one-file-per-ADR store is in place (no legacy monolith was present):');
  log(`  snapshot: ${snapshot.dir} (${snapshot.viaGitDir ? 'git dir' : 'out-of-tree fallback'}, ${snapshot.fileCount} file(s))`);
  log(`  refreshed ${refresh.length} enforcement script(s) to this kit's version${seededNames.length ? ` + seeded ${seededNames.join(', ')}` : ''}`);
  log(`  seeded ${ADR_DIR_REL}/ with ${NAV_REL} and regenerated docs/ai/index.md`);
  log('  next: run the normal upgrade (it re-stamps the deployment lineage to the current head),');
  log('  then review the migrated docs/ai/ tree and the re-stamp together and commit them yourself — this command never commits.');
  return EXIT_OK;
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
      return crossWithoutMonolith(cwd, args, stamp, { log, error, runMigrate, deps });
    }

    const refresh = planScriptRefresh(cwd, deps);
    const drifted = refresh.filter((r) => r.differs);

    if (!args.apply) {
      const preview = resolveSnapshotDir(cwd, stamp, deps);
      log('[migrate-adr-store] --dry-run — no files will be changed. Planned migration:');
      log(`  old layout: ${monoliths.join(', ')} (will be exploded into ${ADR_DIR_REL}/ then retired)`);
      log(`  snapshot → ${preview.dir ? `${preview.dir} (${preview.viaGitDir ? 'git dir' : 'out-of-tree fallback'})` : 'NONE — no out-of-tree location; run inside a git repo (apply would refuse otherwise)'}`);
      log(`  refresh ${refresh.length} enforcement script(s) to this kit's version${drifted.length ? ` (${drifted.length} locally differ: ${drifted.map((r) => r.name).join(', ')})` : ''}`);
    for (const s of planCompanionSeeds(cwd, refresh, deps)) log(`  seed companion module ${CONSUMER_SCRIPTS_REL}/${s.name} (imported by the refreshed archivers; absent at the consumer)`);
      log('  then the conservation-checked rotation:');
      // Surface the rotation's own exit code: a failed dry-run must NOT print the
      // "run with --apply" go-ahead nor exit 0 — it would send the user to --apply on an unsafe tree.
      const code = runMigrate(['--migrate'], { root: cwd, log: (m) => log(`    ${m}`), logError: (m) => error(`    ${m}`) });
      if (code !== EXIT_OK) {
        throw stop(`the dry-run rotation would not conserve every ADR (exit ${code}) — NOT safe to --apply; fix the reported problem, then re-run.`);
      }
      // A null preview means --apply would refuse (no out-of-tree snapshot base) — never green-light it
      // A dry-run go-ahead must not send the user to an apply that will STOP.
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
    const seededNames = applyScriptRefresh(cwd, refresh, deps);
    const code = runMigrate(['--migrate', '--apply'], { root: cwd, log, logError: error });
    if (code !== EXIT_OK) {
      throw stop(`the rotation failed (exit ${code}) — the pre-migration snapshot is at ${snapshot.dir}; resolve the reported problem and re-run (the migration is idempotent).`);
    }
    log('[migrate-adr-store] migrated the 3-tier ADR cascade → one-file-per-ADR store:');
    log(`  snapshot: ${snapshot.dir} (${snapshot.viaGitDir ? 'git dir' : 'out-of-tree fallback'}, ${snapshot.fileCount} file(s))`);
    log(`  refreshed ${refresh.length} enforcement script(s) to this kit's version${seededNames.length ? ` + seeded ${seededNames.join(', ')}` : ''}`);
    log('  next: run the normal upgrade (it re-stamps the deployment lineage to the current head),');
    log('  then review the migrated docs/ai/ tree and the re-stamp together and commit them yourself — this command never commits.');
    return EXIT_OK;
  } catch (err) {
    error(err.message);
    return err.exitCode ?? EXIT_PRECONDITION;
  }
};

if (isDirectRun(import.meta.url)) process.exitCode = main();
