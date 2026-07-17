// legacy-upgrade-e2e.test.mjs — the D8 upgrade path END TO END, all real child spawns (round-1
// fold C10): a legacy consumer declaration (review-ledger gate + plain unit-tests + canonical
// review-state) is migrated by the kit's OWN mirrored migrate-gates.mjs --apply, the tree is
// staged, the REAL `run-gates.mjs --final` mints a GREEN receipt whose lcovSha256 is NON-NULL
// (the lcov pipeline actually ran), and a commit under a minimal commit-guard pre-commit hook is
// PERMITTED. The separate negative fixture proves the guard's teeth: one unstaged edit after the
// final run and the same commit is REFUSED on fingerprint drift.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(HERE, '..', 'tools');
const MIGRATE = join(HERE, '..', 'references', 'scripts', 'migrate-gates.mjs');

// Host AW_* overrides are producer test seams — a leaked one must never redirect the E2E.
const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AW_')) delete env[k];
  return env;
};
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8', env: cleanEnv() });

// A legacy consumer: one committed green test, a declaration the STRIPPED kit no longer accepts
// (a review-ledger gate, a reporterless unit-tests cmd, no coverage-check), a retired store.
const makeLegacyConsumer = () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-upgrade-e2e-'));
  const g = (...a) => run('git', a, root);
  g('init', '-q');
  g('config', 'user.email', 'probe@example.com');
  g('config', 'user.name', 'probe');
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'solo' } }));
  writeFileSync(
    join(root, 'tests', 'sample.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('holds', () => { assert.equal(1, 1); });\n",
  );
  writeFileSync(
    join(root, 'docs', 'ai', 'gates.json'),
    JSON.stringify({
      gates: [
        { id: 'unit-tests', title: 'Suite', cmd: 'node --test tests/*.test.mjs' },
        { id: 'review-ledger', title: 'Ledger', cmd: 'node "/opt/kit/tools/review-ledger.mjs" --check' },
        { id: 'review-state', title: 'Reviews', cmd: `node "${join(TOOLS, 'review-state.mjs')}" --check` },
      ],
    }),
  );
  const gitDir = run('git', ['rev-parse', '--absolute-git-dir'], root).stdout.trim();
  writeFileSync(join(gitDir, 'agent-workflow-review-ledger.jsonl'), '{"dead":1}\n');
  g('add', '-A');
  g('commit', '-qm', 'legacy base');
  return { root, gitDir, g };
};

// The consented D8 steps shared by both fixtures: migrate --apply → stage → REAL --final.
const migrateStageFinal = ({ root, g }) => {
  const migrated = run('node', [MIGRATE, '--cwd', root, '--kit-tools', TOOLS, '--apply'], root);
  assert.equal(migrated.status, 0, migrated.stderr);
  g('add', '-A');
  return run('node', [join(TOOLS, 'run-gates.mjs'), '--final', '--cwd', root], root);
};

const armGuardHook = ({ gitDir }) => {
  const hookPath = join(gitDir, 'hooks', 'pre-commit');
  mkdirSync(join(gitDir, 'hooks'), { recursive: true });
  writeFileSync(hookPath, `#!/usr/bin/env bash\nnode "${join(TOOLS, 'commit-guard.mjs')}" --check\n`);
  chmodSync(hookPath, 0o755);
};

describe('legacy upgrade E2E — migrate → stage → real --final → commit under the guard (D8+D10)', () => {
  it('the migrated declaration mints a GREEN receipt (non-null lcovSha256) and the guarded commit is PERMITTED', () => {
    const fx = makeLegacyConsumer();
    const final = migrateStageFinal(fx);
    assert.equal(final.status, 0, `--final is green on the migrated declaration: ${final.stdout}\n${final.stderr}`);

    // The migration was COMPLETE: legacy gone, reporters wired, the canonical checker LAST.
    const gates = JSON.parse(readFileSync(join(fx.root, 'docs', 'ai', 'gates.json'), 'utf8')).gates;
    assert.deepEqual(gates.map((g2) => g2.id), ['unit-tests', 'review-state', 'coverage-check']);
    assert.match(gates[0].cmd, /--test-reporter=lcov/);
    assert.throws(() => readFileSync(join(fx.gitDir, 'agent-workflow-review-ledger.jsonl')), /ENOENT/, 'the retired store was cleaned by the migration');

    // The receipt: green, quiescent, and the lcov pipeline REALLY ran (a null sha would mean the
    // coverage arm silently skipped — the E2E exists to catch exactly that).
    const records = readFileSync(join(fx.gitDir, 'agent-workflow-core-evidence.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const receipt = records.filter((r) => r.kind === 'final').at(-1);
    assert.equal(receipt.status, 'green');
    assert.equal(receipt.integrityFailure, null);
    assert.equal(receipt.fingerprintBefore, receipt.fingerprintAfter);
    assert.match(receipt.lcovSha256 ?? '', /^[0-9a-f]{64}$/, 'the receipt binds the exact lcov bytes the checker consumed');

    armGuardHook(fx);
    const head = run('git', ['rev-parse', 'HEAD'], fx.root).stdout.trim();
    const commit = run('git', ['commit', '-m', 'migrated under the guard'], fx.root);
    assert.equal(commit.status, 0, `the guard permits the attested commit: ${commit.stdout}\n${commit.stderr}`);
    assert.notEqual(run('git', ['rev-parse', 'HEAD'], fx.root).stdout.trim(), head, 'the commit landed');
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('NEGATIVE: one unstaged edit after the final run and the guarded commit is REFUSED on fingerprint drift', () => {
    const fx = makeLegacyConsumer();
    const final = migrateStageFinal(fx);
    assert.equal(final.status, 0, `--final is green before the drift: ${final.stdout}\n${final.stderr}`);
    armGuardHook(fx);
    writeFileSync(join(fx.root, 'tests', 'sample.test.mjs'), "import { test } from 'node:test';\ntest('drift', () => {});\n");
    const head = run('git', ['rev-parse', 'HEAD'], fx.root).stdout.trim();
    const commit = run('git', ['commit', '-am', 'drifted'], fx.root);
    assert.notEqual(commit.status, 0, 'the guard refuses a tree the receipt does not bind');
    assert.match(`${commit.stdout}\n${commit.stderr}`, /no completed final-run record for the current tree fingerprint/);
    assert.equal(run('git', ['rev-parse', 'HEAD'], fx.root).stdout.trim(), head, 'nothing was committed');
    rmSync(fx.root, { recursive: true, force: true });
  });
});
