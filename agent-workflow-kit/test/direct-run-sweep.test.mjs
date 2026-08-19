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

test('the swept-module list is complete and duplicate-free', () => {
  // Object.freeze pins the CONTENTS, never the completeness: a dropped entry, or one replaced by a
  // duplicate, would silently narrow both arms below. These two literals are what makes that loud.
  assert.equal(SWEPT_MODULES.length, 39, 'the frozen W1 site list is 39 files');
  assert.equal(new Set(SWEPT_MODULES).size, 39, 'the frozen W1 site list has no duplicate entry');
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
  for (const relativePath of SWEPT_MODULES) {
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
