#!/usr/bin/env node
// sync-mirrors.mjs — the canon → mirror synchronizer for the three byte-identical mirror
// families (repo-local, tracked; repo-only tooling — never shipped in any tarball).
//
// The kit ships byte-identical MIRROR copies of content whose canon lives elsewhere in the
// monorepo. Three test files DETECT drift (bridges-mirror.test.mjs, scripts-mirror.test.mjs,
// template-parity.test.mjs) — this script is the deterministic FIXER for the same three
// families:
//
//   1. repo-root bridge dirs        → agent-workflow-kit/bridges/<name>/       (full tree)
//   2. memory references/scripts/   → kit references/scripts/                  (full tree)
//   3. memory references/templates/ → kit references/templates/                (manifest list ONLY)
//
//   node scripts/sync-mirrors.mjs [--check] [--root <dir>]
//
// Semantics (deterministic; canon always wins — a mirror-side edit is clobbered by design,
// preview with --check first):
//   • Full-tree families are SET-EQUAL: an extraneous mirror file is DELETED (the
//     bridges-mirror.test.mjs contract). The walk skips node_modules/.git exactly like that
//     test's walkFiles, so a stray local dir can never be copied into the shipped kit tarball.
//   • The templates family syncs ONLY the exported manifest list. The hard-excluded files
//     (deliberately divergent between the two packages — AD-038) are never read and never
//     written; anything outside the list is untouched.
//   • Every copy preserves the canon file MODE — a bare copyFileSync into a new path would
//     create a non-executable mirror of an executable canon wrapper.
//   • --check is report-only: exit 1 on any would-be change, exit 0 in sync, ZERO writes.
//     A default run applies and prints a per-file copied/deleted + per-family identical summary.
//
// The exported manifest (template list + hard-excludes) is consumed by BOTH this script and
// agent-workflow-kit/test/template-parity.test.mjs, so the sync and the guard govern the SAME
// explicit set — drift cannot hide between them. The exported sync helpers are
// ROOT-PARAMETERIZED (module-level REPO_ROOT is the CLI default only) so hermetic tests never
// touch the real tree; scripts/release/version-sync.mjs --bump reuses syncBridgeMirror after a
// bridge bump. Dependency-free, Node >= 18. No side effects on import.

import { readFileSync, existsSync, readdirSync, mkdirSync, statSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');

export const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

// ── the mirror manifest ───────────────────────────────────────────────────────────────

export const BRIDGE_DIRS = Object.freeze(['codex-cli-bridge', 'antigravity-cli-bridge']);

const MEMORY_DIR = 'agent-workflow-memory';
const KIT_DIR = 'agent-workflow-kit';
const SCRIPTS_REL = 'references/scripts';
const TEMPLATES_REL = 'references/templates';
// This repo dogfoods the deployed enforcement scripts from its OWN root scripts/ (a consumer's
// scripts/). The root subset is DIRECTIONAL (Decision 12): a memory-canon script whose basename is
// ALSO present at root is kept byte+exec-identical; root-only tooling (sync-mirrors*, release/*, any
// non-canon script) is NEVER flagged or deleted, and a canon file absent from root is never added.
const ROOT_SCRIPTS_REL = 'scripts';

// The byte-identical template set (15 top-level + 1 adr/ + 3 pages/). One explicit list, consumed
// by BOTH the sync below and template-parity.test.mjs — never two lists that can drift apart. The
// adr-record.md authoring reference + the seed adr/log.md navigator are package-neutral (identical
// memory↔kit); the divergent decisions.md HOT seed stays in TEMPLATE_HARD_EXCLUDES (hand-edited).
export const MIRROR_TEMPLATE_FILES = Object.freeze([
  'AGENTS.md',
  'active_plan.md',
  'adr-record.md',
  'architecture.md',
  'autonomy.json',
  'changelog.md',
  'current_state.md',
  'env_commands.md',
  'gates.json',
  'handover.md',
  'known_issues.md',
  'orchestration.json',
  'tech_reference.md',
  'technical_specification.md',
  'verification-profile.json',
  'adr/log.md',
  'pages/PAGE_TEMPLATE.md',
  'pages/index.md',
  'pages/shared-patterns.md',
]);

// Deliberately DIVERGENT between memory and the kit (AD-038) — never whole-file synced. Their
// shared regions are owned by template-region-parity.test.mjs + lens-mirror.test.mjs. The sync
// never reads these files; template-parity.test.mjs pins that the manifest never gains them.
export const TEMPLATE_HARD_EXCLUDES = Object.freeze(['agent_rules.md', 'decisions.md']);

// ── planning (read-only) ──────────────────────────────────────────────────────────────

// Same exclusions as bridges-mirror.test.mjs walkFiles — a stray local dir (node_modules, .git)
// must never enter the comparison, and therefore never enter the shipped kit tarball.
const WALK_EXCLUDES = new Set(['node_modules', '.git']);

const walkFiles = (root) => {
  const out = [];
  const recurse = (rel) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (WALK_EXCLUDES.has(entry.name)) continue;
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) recurse(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  recurse('');
  return out.sort();
};

const EXEC_BITS = 0o111;

// A mirror file needs a copy when it is absent, its executable bit drifted from the canon's, or
// its bytes differ. Mode comparison is exec-bit-only (the git-tracked axis) — full-mode equality
// would churn on umask differences.
const fileNeedsCopy = (canonPath, mirrorPath) => {
  if (!existsSync(mirrorPath)) return true;
  if ((statSync(canonPath).mode & EXEC_BITS) !== (statSync(mirrorPath).mode & EXEC_BITS)) return true;
  return !readFileSync(canonPath).equals(readFileSync(mirrorPath));
};

// Plan one full-tree family (set-equality). An absent mirror dir means everything copies; an
// absent CANON dir is a loud failure — silently treating a missing canon as empty would delete
// the whole mirror.
const planTreeSync = (root, canonRel, mirrorRel) => {
  const canonRoot = join(root, canonRel);
  if (!existsSync(canonRoot)) {
    throw fail(1, `canon dir is missing: ${canonRel} — refusing to sync (a missing canon is never an empty canon)`);
  }
  const mirrorRoot = join(root, mirrorRel);
  const canonFiles = walkFiles(canonRoot);
  const canonSet = new Set(canonFiles);
  const changes = [];
  let identical = 0;
  for (const rel of canonFiles) {
    if (fileNeedsCopy(join(canonRoot, rel), join(mirrorRoot, rel))) {
      changes.push({ action: 'copy', rel: join(mirrorRel, rel), from: join(canonRoot, rel), to: join(mirrorRoot, rel) });
    } else {
      identical += 1;
    }
  }
  for (const rel of existsSync(mirrorRoot) ? walkFiles(mirrorRoot) : []) {
    if (!canonSet.has(rel)) changes.push({ action: 'delete', rel: join(mirrorRel, rel), to: join(mirrorRoot, rel) });
  }
  return { changes, identical };
};

// Plan the templates family: ONLY the manifest list. Hard-excluded files are never read; files
// outside the list are never written or deleted. A manifest file missing on the canon side is a
// loud failure — the manifest and the tree may not silently disagree.
const planTemplatesSync = (root) => {
  const canonRoot = join(root, MEMORY_DIR, TEMPLATES_REL);
  if (!existsSync(canonRoot)) {
    throw fail(1, `canon dir is missing: ${MEMORY_DIR}/${TEMPLATES_REL} — refusing to sync`);
  }
  const mirrorRoot = join(root, KIT_DIR, TEMPLATES_REL);
  const changes = [];
  let identical = 0;
  for (const rel of MIRROR_TEMPLATE_FILES) {
    const canonPath = join(canonRoot, rel);
    if (!existsSync(canonPath)) {
      throw fail(1, `manifest template is missing on the canon side: ${MEMORY_DIR}/${TEMPLATES_REL}/${rel} — fix the manifest or the tree`);
    }
    if (fileNeedsCopy(canonPath, join(mirrorRoot, rel))) {
      changes.push({ action: 'copy', rel: join(KIT_DIR, TEMPLATES_REL, rel), from: canonPath, to: join(mirrorRoot, rel) });
    } else {
      identical += 1;
    }
  }
  return { changes, identical };
};

// Plan the root-scripts subset: memory canon → this repo's root scripts/ (Decision 12). NOT
// planTreeSync set-equality — that would DELETE release/* and sync-mirrors.mjs itself. Only a canon
// file whose basename ALSO exists at root is a candidate; a root-only or absent-at-root file is
// untouched. An absent canon dir is a loud failure (never treat a missing canon as empty).
export const planRootSubsetSync = (root) => {
  const canonRoot = join(root, MEMORY_DIR, SCRIPTS_REL);
  if (!existsSync(canonRoot)) {
    throw fail(1, `canon dir is missing: ${MEMORY_DIR}/${SCRIPTS_REL} — refusing to sync`);
  }
  const rootScripts = join(root, ROOT_SCRIPTS_REL);
  const changes = [];
  let identical = 0;
  for (const rel of walkFiles(canonRoot)) {
    const rootPath = join(rootScripts, rel);
    if (!existsSync(rootPath)) continue; // canon file not part of the root subset — never ADD it
    if (fileNeedsCopy(join(canonRoot, rel), rootPath)) {
      changes.push({ action: 'copy', rel: join(ROOT_SCRIPTS_REL, rel), from: join(canonRoot, rel), to: rootPath });
    } else {
      identical += 1;
    }
  }
  return { changes, identical };
};

// All families, in canonical order → [{ family, changes, identical }].
export const planAllMirrors = (root) => {
  const plans = [];
  for (const bridge of BRIDGE_DIRS) {
    plans.push({ family: `bridge:${bridge}`, ...planTreeSync(root, bridge, join(KIT_DIR, 'bridges', bridge)) });
  }
  plans.push({ family: 'reference-scripts', ...planTreeSync(root, join(MEMORY_DIR, SCRIPTS_REL), join(KIT_DIR, SCRIPTS_REL)) });
  plans.push({ family: 'templates', ...planTemplatesSync(root) });
  plans.push({ family: 'root-scripts', ...planRootSubsetSync(root) });
  return plans;
};

// ── apply ─────────────────────────────────────────────────────────────────────────────

const applyChange = (change) => {
  if (change.action === 'delete') {
    rmSync(change.to);
    return;
  }
  mkdirSync(dirname(change.to), { recursive: true });
  copyFileSync(change.from, change.to);
  chmodSync(change.to, statSync(change.from).mode & 0o777); // preserve the canon mode (exec bit)
};

// Re-sync ONE bridge's kit mirror (full tree, set-equality) — the version-sync.mjs --bump hook:
// after a bridge bump mutates the canon, this restores the byte-identical end state
// bridges-mirror.test.mjs demands. Applies immediately; returns the applied change list.
export const syncBridgeMirror = (root, bridgeDir) => {
  if (!BRIDGE_DIRS.includes(bridgeDir)) {
    throw fail(1, `not a bridge dir: "${bridgeDir}" (bridges: ${BRIDGE_DIRS.join(', ')})`);
  }
  const { changes } = planTreeSync(root, bridgeDir, join(KIT_DIR, 'bridges', bridgeDir));
  for (const change of changes) applyChange(change);
  return changes;
};

// ── CLI ───────────────────────────────────────────────────────────────────────────────

const USAGE = 'usage: sync-mirrors.mjs [--check] [--root <dir>]';

const parseArgs = (argv) => {
  const opts = { check: false, root: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--root') {
      i += 1;
      if (argv[i] === undefined) throw fail(2, '--root requires a directory argument');
      opts.root = argv[i];
    } else {
      throw fail(2, `unknown argument "${arg}"\n${USAGE}`);
    }
  }
  return opts;
};

export const runCli = (argv, deps = {}) => {
  const { log = console.log, logError = console.error, root: defaultRoot = REPO_ROOT } = deps;
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      log(USAGE);
      return 0;
    }
    const root = opts.root ?? defaultRoot;
    const plans = planAllMirrors(root);
    let total = 0;
    for (const plan of plans) {
      for (const change of plan.changes) {
        if (!opts.check) applyChange(change);
        const verb = opts.check ? `would ${change.action}` : change.action === 'copy' ? 'copied' : 'deleted';
        log(`${plan.family}: ${verb} ${change.rel}`);
      }
      log(`${plan.family}: ${plan.changes.length} change(s), ${plan.identical} identical`);
      total += plan.changes.length;
    }
    if (total === 0) {
      log('[sync-mirrors] all mirrors in sync — nothing to do.');
      return 0;
    }
    log(opts.check ? `[sync-mirrors] ${total} would-be change(s) — run without --check to apply.` : `[sync-mirrors] applied ${total} change(s).`);
    return opts.check ? 1 : 0;
  } catch (err) {
    logError(`[sync-mirrors] ${err.message}`);
    return err.exitCode ?? 1;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = runCli(process.argv.slice(2));
