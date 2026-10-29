#!/usr/bin/env node
// Idempotent installer for the project's git hooks: `node scripts/agent-workflow/run.mjs install-git-hooks`.
//
// Installs the `pre-commit` hook running the docs cap-validator + index-freshness
// gate + changelog/issues/decisions rotation-freshness checks, each through the stable kit
// command `node scripts/agent-workflow/run.mjs <name>`, so docs files cannot drift over their declared
// `maxLines`, the auto-generated `index.md` navigator cannot silently fall out of sync, and
// stale archive entries never reach a commit. The hook runs no suite.
// First after `set -e` it runs the project's own `scripts/pre-commit.local` with bash when present.
//
// The project root is three levels above this file's own folder (scripts/agent-workflow/git-hooks/):
// the installer imports nothing, so the bytes a danger check binds are the bytes the run executes.
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
// RULES AND LAYOUT CHECKS (optional): `--rules-check <path>` and `--layout-check <path>` arm one line
// each, `node "<abs>" --check # rules-check` and `node "<abs>" --check # layout-check`, ahead of the
// guard. The role comment is what a line's role is read by, so the guard rule above never matches
// either line and a legacy guard line keeps its role whatever its file name. Each takes only its own
// tool's file name and a path in one safe shell representation (on win32 its separators made `/`),
// and is carried forward by flagless re-runs exactly as the guard is; no flag disarms either.
//
// Package-manager-agnostic: the hook calls the scripts via `node` directly (no pnpm/npm
// assumption). Re-running is safe — the script reads a hook as its own when a line of it, one
// trailing carriage return dropped, ends with `:install-git-hooks.mjs` (the MAGIC_MARKER names no
// project, and an older project-named marker still reads as managed) and rewrites only that file.
//
// To bypass once (only when truly justified): `git commit --no-verify`.

import { writeFile, readFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..', '..', '..');

export const MAGIC_MARKER = '# agent-workflow:install-git-hooks.mjs';
const MARKER_TAIL = ':install-git-hooks.mjs';
// A hook is this installer's when a line of it, one trailing carriage return dropped, ends with the marker tail.
export const isManaged = (hook) => hook.split('\n').some((l) => l.replace(/\r$/, '').endsWith(MARKER_TAIL));

// git's own hooks location (worktree-correct), or null outside a git checkout.
const gitHooksDir = () => {
  const r = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return resolve(ROOT, r.stdout.replace(/\r?\n$/, ''));
};

// The exact shape this installer writes — the strict carry-forward parse anchors on it
// (quoted path + a bare ` --check` tail; nothing else in the managed hook matches).
const GUARD_LINE_RE = /^node "([^"]+)" --check$/;

// The two role-tagged lines, in hook order, each bound to its own tool's file name.
const ROLES = [
  { flag: '--rules-check', role: 'rules-check', file: 'rules-cli.mjs' },
  { flag: '--layout-check', role: 'layout-check', file: 'source-size-check.mjs' },
].map((entry) => ({ ...entry, re: new RegExp(`^node "([^"]+)" --check # ${entry.role}$`) }));

// A path the shell would read as anything but itself inside double quotes is refused.
const SHELL_ACTIVE = /["$`\\\r\n]/;

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

// A role flag arms its line with the resolved path in its one safe shell representation, or refuses.
const resolveRoleFlag = (argv, { flag, file }) => {
  const at = argv.indexOf(flag);
  if (at === -1) return null;
  const given = argv[at + 1];
  if (!given) {
    console.error(`[install-git-hooks] ${flag} needs a path`);
    process.exit(2);
  }
  const resolved = resolve(ROOT, given);
  const abs = process.platform === 'win32' ? resolved.replaceAll('\\', '/') : resolved;
  if (basename(abs) !== file) {
    console.error(`[install-git-hooks] ${flag} takes a path to ${file}, got ${abs}`);
    process.exit(2);
  }
  if (SHELL_ACTIVE.test(abs)) {
    console.error(`[install-git-hooks] ${flag} ${JSON.stringify(abs)} carries ", $, a backtick, a backslash, CR or LF — inside the hook's quotes it would not name that file; refusing to arm it`);
    process.exit(2);
  }
  if (!existsSync(abs)) {
    console.error(`[install-git-hooks] ${flag} ${abs} does not exist`);
    process.exit(1);
  }
  return abs;
};

// Flagless re-runs carry each armed role line forward by the guard's rule: one keeps its path, none
// leaves it out, more than one fails CLOSED naming the role.
const carriedRolePath = (existingHook, { role, re }) => {
  if (existingHook === null) return null;
  const matches = existingHook.split('\n').map((l) => re.exec(l.replace(/\r$/, ''))).filter(Boolean);
  if (matches.length > 1) {
    console.error(`[install-git-hooks] the managed pre-commit hook carries ${matches.length} ${role} lines — ambiguous; remove the duplicates by hand and re-run (refusing to guess)`);
    process.exit(1);
  }
  return matches.length === 1 ? matches[0][1] : null;
};

// Flagless re-runs carry the armed guard forward from the MANAGED hook — strictly parsed:
// exactly one guard-shaped line keeps its path; none keeps the hook plain; more than one is
// ambiguous and fails CLOSED (an installer must never guess which line was the real guard).
const carriedGuardPath = (existingHook) => {
  if (existingHook === null) return null;
  const matches = existingHook.split('\n').map((l) => GUARD_LINE_RE.exec(l.replace(/\r$/, ''))).filter(Boolean);
  if (matches.length > 1) {
    console.error(`[install-git-hooks] the managed pre-commit hook carries ${matches.length} commit-guard --check lines — ambiguous; remove the duplicates by hand and re-run (refusing to guess)`);
    process.exit(1);
  }
  return matches.length === 1 ? matches[0][1] : null;
};

const preCommitContent = (guardPath, rolePaths = []) => `#!/usr/bin/env bash
${MAGIC_MARKER}
# Auto-installed by node scripts/agent-workflow/run.mjs install-git-hooks (run it by hand or from the kit).
# Runs the docs cap-validator + index-freshness gate + rotation-freshness checks
# before every commit, so files cannot drift over their declared maxLines, the
# auto-generated index.md cannot silently go stale, and stale archive entries
# never reach a commit.
set -e
# Your own commit checks go in scripts/pre-commit.local; it runs first, with bash, when present.
if [ -f scripts/pre-commit.local ]; then bash scripts/pre-commit.local; fi
node scripts/agent-workflow/run.mjs docs-size
node scripts/agent-workflow/run.mjs docs-size --check-index
node scripts/agent-workflow/run.mjs archive-changelog --check
node scripts/agent-workflow/run.mjs archive-issues --check
node scripts/agent-workflow/run.mjs archive-decisions --check
${rolePaths.map((path, at) => (path ? `node "${path}" --check # ${ROLES[at].role}\n` : '')).join('')}${guardPath ? `node "${guardPath}" --check\n` : ''}`;

const main = async () => {
  const flags = resolveGuardFlags(ARGV);
  const roleFlags = ROLES.map((role) => resolveRoleFlag(ARGV, role));
  const hooksDir = gitHooksDir();
  if (hooksDir === null) {
    console.log('[install-git-hooks] git cannot resolve a hooks path here — skipping (not a git checkout).');
    return;
  }
  const preCommitPath = resolve(hooksDir, 'pre-commit');

  let existing = null;
  if (existsSync(preCommitPath)) {
    existing = await readFile(preCommitPath, 'utf8');
    if (!isManaged(existing)) {
      console.warn(
        `[install-git-hooks] WARNING: ${preCommitPath} exists and was not installed by this script. Refusing to overwrite — remove or merge it manually.`,
      );
      process.exit(1);
    }
  }

  const guardPath = flags.mode === 'arm' ? flags.path : flags.mode === 'disable' ? null : carriedGuardPath(existing);
  const rolePaths = ROLES.map((role, at) => roleFlags[at] ?? carriedRolePath(existing, role));
  const content = preCommitContent(guardPath, rolePaths);
  if (existing === content) {
    console.log('[install-git-hooks] pre-commit already up to date.');
    return;
  }

  await mkdir(hooksDir, { recursive: true });
  await writeFile(preCommitPath, content, 'utf8');
  await chmod(preCommitPath, 0o755);
  console.log(
    `[install-git-hooks] installed ${preCommitPath} (docs caps + index freshness + archive checks${rolePaths.map((path, at) => (path ? ` + ${ROLES[at].role}` : '')).join('')}${guardPath ? ' + commit guard' : ''}).`,
  );
};

// Run main() only when executed directly, never on import; compare by REAL path so a symlinked entry still runs.
const isDirectRun = (() => {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(__filename);
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
