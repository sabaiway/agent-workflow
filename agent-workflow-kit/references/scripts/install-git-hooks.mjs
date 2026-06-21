#!/usr/bin/env node
// Idempotent installer for the project's git hooks.
//
// Installs `.git/hooks/pre-commit` running the docs cap-validator + index-freshness
// gate + changelog/issues rotation-freshness checks + the `scripts/` test
// suite, so docs files cannot drift over their declared `maxLines`, the auto-generated
// `index.md` navigator cannot silently fall out of sync, stale archive entries never
// reach a commit, and regressions to the scripts themselves are caught at commit time.
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const HOOKS_DIR = resolve(ROOT, '.git/hooks');
const PRE_COMMIT_PATH = resolve(HOOKS_DIR, 'pre-commit');

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

const PRE_COMMIT_CONTENT = `#!/usr/bin/env bash
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
node --test scripts/*.test.mjs
`;

const main = async () => {
  if (!existsSync(resolve(ROOT, '.git'))) {
    console.log('[install-git-hooks] .git directory not found — skipping (not a git checkout).');
    return;
  }
  await mkdir(HOOKS_DIR, { recursive: true });

  if (existsSync(PRE_COMMIT_PATH)) {
    const existing = await readFile(PRE_COMMIT_PATH, 'utf8');
    if (existing.includes(MAGIC_MARKER) && existing === PRE_COMMIT_CONTENT) {
      console.log('[install-git-hooks] pre-commit already up to date.');
      return;
    }
    if (!existing.includes(MAGIC_MARKER)) {
      console.warn(
        '[install-git-hooks] WARNING: .git/hooks/pre-commit exists and was not installed by this script. Refusing to overwrite — remove or merge it manually.',
      );
      process.exit(1);
    }
  }

  await writeFile(PRE_COMMIT_PATH, PRE_COMMIT_CONTENT, 'utf8');
  await chmod(PRE_COMMIT_PATH, 0o755);
  console.log('[install-git-hooks] installed .git/hooks/pre-commit (docs caps + index freshness + archive checks + scripts/ tests).');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
