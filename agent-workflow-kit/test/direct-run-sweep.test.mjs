// The kit-tools sweep: every converted module imports without CLI side effects, no swept source
// keeps the lexical entry guard, and a representative CLI runs through a symlink.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LEGACY_PATTERN = 'pathToFileURL(process.argv[1]).href';
const SWEPT_MODULES = Object.freeze([
  'agent-workflow-kit/tools/ack-write.mjs',
  'agent-workflow-kit/tools/autonomy-doctor.mjs',
  'agent-workflow-kit/tools/bridge-settings.mjs',
  'agent-workflow-kit/tools/cheap-agents.mjs',
  'agent-workflow-kit/tools/commands.mjs',
  'agent-workflow-kit/tools/commit-guard.mjs',
  'agent-workflow-kit/tools/core-evidence.mjs',
  'agent-workflow-kit/tools/coverage-check.mjs',
  'agent-workflow-kit/tools/delegation.mjs',
  'agent-workflow-kit/tools/detect-backends.mjs',
  'agent-workflow-kit/tools/doc-parity.mjs',
  'agent-workflow-kit/tools/family-registry.mjs',
  'agent-workflow-kit/tools/flow-check.mjs',
  'agent-workflow-kit/tools/flow-writer.mjs',
  'agent-workflow-kit/tools/gate-hook.mjs',
  'agent-workflow-kit/tools/gates-init.mjs',
  'agent-workflow-kit/tools/grounding.mjs',
  'agent-workflow-kit/tools/hide-footprint.mjs',
  'agent-workflow-kit/tools/inject-methodology.mjs',
  'agent-workflow-kit/tools/lens-region.mjs',
  'agent-workflow-kit/tools/manifest/validate.mjs',
  'agent-workflow-kit/tools/mcp-server.mjs',
  'agent-workflow-kit/tools/migrate-adr-store.mjs',
  'agent-workflow-kit/tools/path-inventory.mjs',
  'agent-workflow-kit/tools/procedures.mjs',
  'agent-workflow-kit/tools/receipt-deadline.mjs',
  'agent-workflow-kit/tools/recipes.mjs',
  'agent-workflow-kit/tools/recommendations.mjs',
  'agent-workflow-kit/tools/release-scan.mjs',
  'agent-workflow-kit/tools/repo-search.mjs',
  'agent-workflow-kit/tools/review-state.mjs',
  'agent-workflow-kit/tools/run-gates.mjs',
  'agent-workflow-kit/tools/sandbox-masks.mjs',
  'agent-workflow-kit/tools/set-autonomy.mjs',
  'agent-workflow-kit/tools/set-flow.mjs',
  'agent-workflow-kit/tools/set-recipe.mjs',
  'agent-workflow-kit/tools/setup-backends.mjs',
  'agent-workflow-kit/tools/uninstall.mjs',
  'agent-workflow-kit/tools/velocity-profile.mjs',
  'agent-workflow-kit/tools/worktrees.mjs',
]);
// Root scripts/ mirrors are absent because this committed test must run from a fresh checkout:
// they are host-local deployed copies matched by .git/info/exclude. The authority that keeps them
// byte-identical to their canon is node scripts/sync-mirrors.mjs --check.
const STANDALONE_MODULES = Object.freeze([
  'agent-workflow-memory/references/scripts/check-docs-size.mjs',
  'agent-workflow-memory/references/scripts/archive-changelog.mjs',
  'agent-workflow-memory/references/scripts/archive-decisions.mjs',
  'agent-workflow-memory/references/scripts/archive-issues.mjs',
  'agent-workflow-memory/references/scripts/migrate-gates.mjs',
  'agent-workflow-kit/references/scripts/check-docs-size.mjs',
  'agent-workflow-kit/references/scripts/archive-changelog.mjs',
  'agent-workflow-kit/references/scripts/archive-decisions.mjs',
  'agent-workflow-kit/references/scripts/archive-issues.mjs',
  'agent-workflow-kit/references/scripts/migrate-gates.mjs',
  'agent-workflow-kit/references/hooks/state-block-guard.mjs',
  'agent-workflow-kit/references/hooks/gate-approve.mjs',
]);
const REMAINING_STANDALONE_MODULES = Object.freeze([
  'agent-workflow-memory/scripts/stamp-takeover.mjs',
  'scripts/suite-parity.mjs',
  'scripts/check-ascii-letters.mjs',
  'scripts/sync-mirrors.mjs',
  'scripts/stats/snapshot.mjs',
  'scripts/release/smoke-init.mjs',
  'scripts/release/smoke-candidate.mjs',
  'scripts/release/version-sync.mjs',
  'scripts/release/cross-version-gate.mjs',
  'scripts/release/dispatch-publish.mjs',
  'scripts/release/preflight-remote.mjs',
]);

test('the swept-module list is complete and duplicate-free', () => {
  // Object.freeze pins the CONTENTS, never the completeness: a dropped entry, or one replaced by a
  // duplicate, would silently narrow both arms below. These two literals are what makes that loud.
  assert.equal(SWEPT_MODULES.length, 40, 'the frozen W1 site list is 40 files');
  assert.equal(new Set(SWEPT_MODULES).size, 40, 'the frozen W1 site list has no duplicate entry');
});

test('the standalone-module list is complete and duplicate-free', () => {
  assert.equal(STANDALONE_MODULES.length, 12, 'the frozen W2 site list is 12 files');
  assert.equal(new Set(STANDALONE_MODULES).size, 12, 'the frozen W2 site list has no duplicate entry');
});

test('the remaining-standalone-module list is complete and duplicate-free', () => {
  assert.equal(REMAINING_STANDALONE_MODULES.length, 11, 'the frozen W3 site list is 11 files');
  assert.equal(new Set(REMAINING_STANDALONE_MODULES).size, 11, 'the frozen W3 site list has no duplicate entry');
});

test('an unresolvable entry point fails the standalone guard CLOSED', async () => {
  // Each standalone file inlines the realpath compare instead of importing the shared leaf, so each
  // copy carries its own catch arm — and that arm runs ONLY when realpathSync throws, which needs an
  // argv[1] that does not resolve. These standalone modules are imported for the FIRST time in this
  // process right here, so the guard runs under the broken entry and the arm executes IN-PROCESS;
  // a spawned child's executed lines never reach the coverage map.
  const realEntry = process.argv[1];
  process.argv[1] = join(REPOSITORY_ROOT, 'no-such-entry-point.mjs');
  try {
    for (const relativePath of [...STANDALONE_MODULES, ...REMAINING_STANDALONE_MODULES]) {
      const exitCodeBefore = process.exitCode;
      const namespace = await import(pathToFileURL(join(REPOSITORY_ROOT, relativePath)).href);
      assert.equal(typeof namespace, 'object', `${relativePath}: import did not produce a module object`);
      assert.equal(process.exitCode, exitCodeBefore, `${relativePath}: an unresolvable entry point still ran the CLI`);
    }
  } finally {
    process.argv[1] = realEntry;
  }
});

test('every swept module imports without setting an exit code', async () => {
  const initialExitCode = process.exitCode;
  for (const relativePath of SWEPT_MODULES) {
    const namespace = await import(pathToFileURL(join(REPOSITORY_ROOT, relativePath)).href);
    assert.equal(typeof namespace, 'object', `${relativePath}: import did not produce a module object`);
    assert.equal(process.exitCode, initialExitCode, `${relativePath}: import changed process.exitCode`);
  }
});

test('no swept production file keeps the lexical direct-run pattern', () => {
  // agent-workflow-kit/tools/direct-run.mjs is excluded by name because its bug-documentation
  // comment legitimately carries LEGACY_PATTERN.
  const findings = [];
  for (const relativePath of [...SWEPT_MODULES, ...STANDALONE_MODULES, ...REMAINING_STANDALONE_MODULES]) {
    const source = readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8');
    const index = source.indexOf(LEGACY_PATTERN);
    if (index !== -1) findings.push(`${relativePath}:${source.slice(0, index).split('\n').length}`);
  }
  assert.deepEqual(findings, [], findings.join('\n'));
});

test('a converted CLI runs when its entry point is a symlink', () => {
  const directory = mkdtempSync(join(tmpdir(), 'direct-run-sweep-'));
  try {
    const target = join(REPOSITORY_ROOT, 'agent-workflow-kit/tools/commands.mjs');
    const link = join(directory, 'commands.mjs');
    symlinkSync(target, link);
    // No argument: commands.mjs ignores --help rather than handling it, so the bare run is the
    // honest one. Its index goes to stdout.
    const result = spawnSync(process.execPath, [link], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    // The broken lexical guard also exited 0 through a symlink, but printed NOTHING. Asserting a
    // marker on the EXPECTED stream is what separates "ran" from "silently did nothing" — any
    // stderr byte (a stray Node warning) would not.
    assert.match(result.stdout, /command index \(this list is read-only\)/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a converted memory CLI runs when its entry point is a symlink', () => {
  const directory = mkdtempSync(join(tmpdir(), 'direct-run-memory-sweep-'));
  try {
    const target = join(REPOSITORY_ROOT, 'agent-workflow-memory/scripts/stamp-takeover.mjs');
    const link = join(directory, 'stamp-takeover.mjs');
    symlinkSync(target, link);
    // An empty directory has no lineage stamps, so this argument is read-only. This is exactly the
    // arm that would have been green on the broken form: status 0 alone cannot prove the CLI ran.
    const result = spawnSync(process.execPath, [link, directory], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[stamp-takeover\] rebootstrap: no stamp found/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
