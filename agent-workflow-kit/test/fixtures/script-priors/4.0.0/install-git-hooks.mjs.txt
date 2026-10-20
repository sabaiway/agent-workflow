#!/usr/bin/env node
// Idempotent installer for the project's git hooks.
//
// Installs the `pre-commit` hook running the docs cap-validator + index-freshness
// gate + changelog/issues rotation-freshness checks + the `scripts/` test
// suite, so docs files cannot drift over their declared `maxLines`, the auto-generated
// `index.md` navigator cannot silently fall out of sync, stale archive entries never
// reach a commit, and regressions to the scripts themselves are caught at commit time.
//
// The hooks location comes from git's OWN answer (`git rev-parse --git-path hooks`) — a linked
// worktree resolves ITS OWN hooks path (its `.git` is a FILE; a hardcoded `.git/hooks` would
// miss or mis-write).
//
// COMMIT GUARD (D10, optional): `--commit-guard <path>` names the composition root's read-only
// commit-guard tool explicitly — the hook then gains its `--check` line with the RESOLVED,
// quoted path written at install time (a portable contract: no runtime guessing; this substrate
// knows no sibling by name, so the path always arrives from the caller). The guard binds the
// latest final-run receipt to the exact commit tree. An armed guard line SURVIVES flagless
// re-runs (carried forward from the managed hook — exactly ONE strictly-parsed line; an
// ambiguous duplicate fails closed); `--no-commit-guard` is the one consented disable; passing
// both flags together is a usage error.
//
// Package-manager-agnostic: the hook calls the scripts via `node` directly (no pnpm/npm
// assumption). Re-running is safe — the script detects a previously installed hook via
// the MAGIC_MARKER comment and rewrites only that file.
//
// To bypass once (only when truly justified): `git commit --no-verify`.

import { writeFile, readFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const readProjectName = () => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    if (pkg.name) return pkg.name;
  } catch {
    /* no package.json — fall back to repo dir basename */
  }
  return basename(ROOT);
};

const MAGIC_MARKER = `# ${readProjectName()}:install-git-hooks.mjs`;

// git's own hooks location (worktree-correct), or null outside a git checkout.
const gitHooksDir = () => {
  const r = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return resolve(ROOT, r.stdout.replace(/\r?\n$/, ''));
};

// The exact shape this installer writes — the strict carry-forward parse anchors on it
// (quoted path + a bare ` --check` tail; nothing else in the managed hook matches).
const GUARD_LINE_RE = /^node "([^"]+)" --check$/;

const ARGV = process.argv.slice(2);

// The optional commit-guard line: an explicit --commit-guard <path> arms it (resolved at install
// time); --no-commit-guard is the one consented disable; both together are a usage error —
// never an order-dependent pick.
const resolveGuardFlags = (argv) => {
  const at = argv.indexOf('--commit-guard');
  const noGuard = argv.includes('--no-commit-guard');
  if (at !== -1 && noGuard) {
    console.error('[install-git-hooks] --commit-guard and --no-commit-guard contradict each other — pass exactly one');
    process.exit(2);
  }
  if (noGuard) return { mode: 'disable' };
  if (at === -1) return { mode: 'carry' };
  const given = argv[at + 1];
  if (!given) {
    console.error('[install-git-hooks] --commit-guard needs a path');
    process.exit(2);
  }
  const abs = resolve(ROOT, given);
  if (!existsSync(abs)) {
    console.error(`[install-git-hooks] --commit-guard ${abs} does not exist`);
    process.exit(1);
  }
  return { mode: 'arm', path: abs };
};

// Flagless re-runs carry the armed guard forward from the MANAGED hook — strictly parsed:
// exactly one guard-shaped line keeps its path; none keeps the hook plain; more than one is
// ambiguous and fails CLOSED (an installer must never guess which line was the real guard).
const carriedGuardPath = (existingHook) => {
  if (existingHook === null) return null;
  const matches = existingHook.split('\n').map((l) => GUARD_LINE_RE.exec(l)).filter(Boolean);
  if (matches.length > 1) {
    console.error(`[install-git-hooks] the managed pre-commit hook carries ${matches.length} commit-guard --check lines — ambiguous; remove the duplicates by hand and re-run (refusing to guess)`);
    process.exit(1);
  }
  return matches.length === 1 ? matches[0][1] : null;
};

const preCommitContent = (guardPath) => `#!/usr/bin/env bash
${MAGIC_MARKER}
# Auto-installed by scripts/install-git-hooks.mjs (run it from "prepare" or by hand).
# Runs the docs cap-validator + index-freshness gate + rotation-freshness checks
# + the scripts/ test suite before every commit, so files cannot drift over their
# declared maxLines, the auto-generated index.md cannot silently go stale, stale
# archive entries never reach a commit, and regressions to the scripts are caught.
set -e
node scripts/check-docs-size.mjs
node scripts/check-docs-size.mjs --check-index
node scripts/archive-changelog.mjs --check
node scripts/archive-issues.mjs --check
node scripts/archive-decisions.mjs --check
node --test scripts/*.test.mjs
${guardPath ? `node "${guardPath}" --check\n` : ''}`;

const main = async () => {
  const flags = resolveGuardFlags(ARGV);
  const hooksDir = gitHooksDir();
  if (hooksDir === null) {
    console.log('[install-git-hooks] git cannot resolve a hooks path here — skipping (not a git checkout).');
    return;
  }
  const preCommitPath = resolve(hooksDir, 'pre-commit');

  let existing = null;
  if (existsSync(preCommitPath)) {
    existing = await readFile(preCommitPath, 'utf8');
    if (!existing.includes(MAGIC_MARKER)) {
      console.warn(
        `[install-git-hooks] WARNING: ${preCommitPath} exists and was not installed by this script. Refusing to overwrite — remove or merge it manually.`,
      );
      process.exit(1);
    }
  }

  const guardPath = flags.mode === 'arm' ? flags.path : flags.mode === 'disable' ? null : carriedGuardPath(existing);
  const content = preCommitContent(guardPath);
  if (existing === content) {
    console.log('[install-git-hooks] pre-commit already up to date.');
    return;
  }

  await mkdir(hooksDir, { recursive: true });
  await writeFile(preCommitPath, content, 'utf8');
  await chmod(preCommitPath, 0o755);
  console.log(
    `[install-git-hooks] installed ${preCommitPath} (docs caps + index freshness + archive checks + scripts/ tests${guardPath ? ' + commit guard' : ''}).`,
  );
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
