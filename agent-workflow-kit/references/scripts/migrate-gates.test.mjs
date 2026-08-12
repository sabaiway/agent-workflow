// migrate-gates.test.mjs — spec for the consented legacy gates.json migration (strip-the-kit D8).
// The migration is ATOMIC and COMPLETE: canonical legacy entries removed + the unit-tests cmd
// extended with the lcov reporters + the coverage-check gate added LAST; customized entries are
// NEVER auto-touched (loud report + recovery); preview writes NOTHING; apply is tmp+rename.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  LEGACY_FORMS,
  UNIT_TESTS_COVERAGE_FLAGS,
  KNOWN_COVERAGE_FLAG_SETS,
  COVERAGE_PRODUCER_BODY,
  RETIRED_STORE_BASENAMES,
  findRetiredStores,
  buildMigrationPlan,
  resultingGates,
  formatPreview,
  main,
} from './migrate-gates.mjs';

const KIT_TOOLS = mkdtempSync(join(tmpdir(), 'migrate-gates-kit-'));
writeFileSync(join(KIT_TOOLS, 'coverage-check.mjs'), '// the installed checker the migration points at\n');

const mkProject = (gates) => {
  const root = mkdtempSync(join(tmpdir(), 'migrate-gates-'));
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  writeFileSync(join(root, 'docs', 'ai', 'gates.json'), `${JSON.stringify({ _README: 'mine', gates }, null, 2)}\n`);
  return root;
};
const gatesOf = (root) => JSON.parse(readFileSync(join(root, 'docs', 'ai', 'gates.json'), 'utf8')).gates;
const quiet = () => {
  const out = [];
  const err = [];
  return { log: (l) => out.push(String(l)), error: (l) => err.push(String(l)), out, err };
};

// The FIRST flag set the kit ever emitted, frozen here as literal bytes — never read back out of
// KNOWN_COVERAGE_FLAG_SETS. Deployed declarations on disk carry exactly these bytes, so the
// append-only promise needs a checker that goes red if they are edited or dropped; deriving the
// "prior" from the set under test would keep this green while real deployments broke.
const PRIOR_FLAG_SET_V1 =
  '--experimental-test-coverage --test-reporter=lcov --test-reporter-destination="$AW_GIT_DIR/agent-workflow-lcov.info" --test-reporter=spec --test-reporter-destination=stdout';

const LEGACY_LEDGER = { id: 'review-ledger', title: 'L', cmd: 'node "/kit/tools/review-ledger.mjs" --check' };
const LEGACY_FOLD = { id: 'fold-completeness', title: 'F', cmd: 'node /kit/tools/fold-completeness.mjs --check' };
const UNIT = { id: 'unit-tests', title: 'U', cmd: 'node --test tools/*.test.mjs' };
const CUSTOM = { id: 'my-ledger-wrap', title: 'C', cmd: 'node scripts/wrap.mjs && node /kit/tools/review-ledger.mjs --check' };

describe('migrate-gates — the pure migration plan', () => {
  it('matches BOTH documented legacy forms (quoted and bare paths) and removes them', () => {
    for (const form of LEGACY_FORMS) assert.ok(form.re instanceof RegExp);
    const { plan } = buildMigrationPlan([LEGACY_LEDGER, LEGACY_FOLD], KIT_TOOLS);
    assert.deepEqual(plan.filter((r) => r.action === 'remove').map((r) => r.entry.id), ['review-ledger', 'fold-completeness']);
  });

  it('extends the canonical unit-tests cmd with the lcov reporters (flags inserted after `node --test`)', () => {
    const { plan, unitTestsExtended } = buildMigrationPlan([UNIT], KIT_TOOLS);
    assert.ok(unitTestsExtended);
    const extended = plan.find((r) => r.action === 'extend').entry;
    assert.equal(extended.cmd, `node --test ${UNIT_TESTS_COVERAGE_FLAGS} tools/*.test.mjs`);
  });

  it('an already-extended unit-tests cmd is left alone (idempotent)', () => {
    const done = { id: 'unit-tests', title: 'U', cmd: `node --test ${UNIT_TESTS_COVERAGE_FLAGS} tools/*.test.mjs` };
    const { plan } = buildMigrationPlan([done], KIT_TOOLS);
    assert.equal(plan.find((r) => r.entry.id === 'unit-tests').action, 'keep');
  });

  it('a declaration carrying a PRIOR emitted flag set reads as already-configured — keep, zero diff, no warning', () => {
    // The canonical flag set moved (the destination became a required-parameter expansion). A
    // deployment written by the earlier kit must not suddenly read as customized: that would send
    // the maintainer to hand-fix a gate which already produces the lcov the checker reads.
    assert.notEqual(PRIOR_FLAG_SET_V1, UNIT_TESTS_COVERAGE_FLAGS, 'the v1 bytes are a form the kit no longer emits');
    assert.ok(KNOWN_COVERAGE_FLAG_SETS.includes(PRIOR_FLAG_SET_V1), 'and the append-only set still carries them');
    const deployed = [
      { id: 'unit-tests', title: 'U', cmd: `node --test ${PRIOR_FLAG_SET_V1} tools/*.test.mjs` },
      { id: 'review-state', title: 'RS', cmd: `node "${join(KIT_TOOLS, 'review-state.mjs')}" --check` },
      { id: 'coverage-check', title: 'CC', cmd: `node "${join(KIT_TOOLS, 'coverage-check.mjs')}" --check` },
    ];
    const analysis = buildMigrationPlan(deployed, KIT_TOOLS);
    assert.equal(analysis.plan.find((r) => r.entry.id === 'unit-tests').action, 'keep');
    assert.deepEqual(analysis.customized, [], 'a prior emitted form is never reported customized');
    assert.equal(analysis.hasProducer, true, 'it still counts as the producer the checker reads');
    assert.equal(analysis.checkerInert, false);
    assert.equal(analysis.finalCapable, true);
    assert.deepEqual(resultingGates(analysis.plan), deployed, 'zero diff — nothing is rewritten');
    const preview = formatPreview(analysis, 'APPLY');
    assert.match(preview, /nothing to migrate/, 'the preview says there is nothing to do');
    assert.doesNotMatch(preview, /CUSTOMIZED|INERT|WARNING/, 'and warns about nothing');
  });

  it('a unit-tests entry that merely CONTAINS the prior bytes is CUSTOMIZED, never a silent keep', () => {
    // The already-configured decision runs through the closed producer predicate. A substring probe
    // would call `echo <prior flags>` already configured and say nothing, leaving the maintainer
    // with an entry the tool cannot verify and no recovery line.
    const nearMiss = { id: 'unit-tests', title: 'U', cmd: `echo ${PRIOR_FLAG_SET_V1}` };
    const analysis = buildMigrationPlan([nearMiss], KIT_TOOLS);
    assert.equal(analysis.plan.find((r) => r.entry.id === 'unit-tests').action, 'keep', 'nothing is rewritten');
    assert.deepEqual(analysis.customized.map((g) => g.id), ['unit-tests'], 'but it IS reported customized');
    assert.equal(analysis.hasProducer, false, 'and it never counts as the producer the checker would read');
    const preview = formatPreview(analysis, 'APPLY');
    assert.match(preview, /CUSTOMIZED \(untouched\): unit-tests/);
    assert.match(preview, /declare the canonical suite gate by hand/, 'the paste-ready recovery rides along');
  });

  it('adds the coverage-check gate LAST with the RESOLVED quoted path; never a second one', () => {
    const { plan } = buildMigrationPlan([UNIT], KIT_TOOLS);
    const result = resultingGates(plan);
    const last = result[result.length - 1];
    assert.equal(last.id, 'coverage-check');
    assert.equal(last.cmd, `node "${join(KIT_TOOLS, 'coverage-check.mjs')}" --check`);
    const again = buildMigrationPlan(result, KIT_TOOLS);
    assert.ok(!again.plan.some((r) => r.action === 'add'), 'a declaration already carrying the checker gains no duplicate');
  });

  it('a declaration with NO producer never GAINS the checker — the pair is declared together or not at all', () => {
    const npmSuite = { id: 'suite', title: 'S', cmd: 'npm test' };
    const analysis = buildMigrationPlan([LEGACY_LEDGER, npmSuite], KIT_TOOLS);
    assert.ok(!analysis.plan.some((r) => r.action === 'add'), 'no checker is added over a declaration that produces no lcov');
    assert.deepEqual(resultingGates(analysis.plan).map((g) => g.id), ['suite'], 'the legacy entry still goes, nothing dead arrives');
    assert.equal(analysis.finalCapable, false, 'a declaration with no checker is not final-run-capable');
    const preview = formatPreview(analysis, 'APPLY');
    assert.match(preview, /coverage-check/, 'the withheld checker is named');
    assert.match(preview, /produce/i, 'the preview says WHY — no gate produces the lcov it would read');
  });

  it('an ALREADY-declared checker over no producer is reported INERT, is never removed, and is not final-run-capable', () => {
    const checker = { id: 'coverage-check', title: 'CC', cmd: `node "${join(KIT_TOOLS, 'coverage-check.mjs')}" --check` };
    const reviewState = { id: 'review-state', title: 'RS', cmd: `node "${join(KIT_TOOLS, 'review-state.mjs')}" --check` };
    const analysis = buildMigrationPlan([{ id: 'suite', title: 'S', cmd: 'npm test' }, reviewState, checker], KIT_TOOLS);
    assert.equal(analysis.finalCapable, false, 'a review-state present must NOT make an inert pair read as final-run-capable');
    assert.ok(resultingGates(analysis.plan).some((g) => g.id === 'coverage-check'), 'the declared checker is never removed');
    const preview = formatPreview(analysis, 'APPLY');
    assert.match(preview, /INERT/, 'the inert pair is named');
    assert.match(preview, /--experimental-test-coverage/, 'the paste-ready suite cmd is carried');
    assert.doesNotMatch(preview, /already final-run-capable/);
  });

  it('a gates-init-shaped producer (the exec-wrapped offer form) is recognized — the checker IS added over it', () => {
    const offered = {
      id: 'test',
      title: 'T',
      cmd: `COREPACK_ENABLE_NETWORK=0 npm exec --offline --script-shell /bin/sh -- ${COVERAGE_PRODUCER_BODY}`,
    };
    const analysis = buildMigrationPlan([offered], KIT_TOOLS);
    assert.deepEqual(resultingGates(analysis.plan).map((g) => g.id), ['test', 'coverage-check']);
    // The `no canonical unit-tests entry` advice is keyed on the ID, but a producer is recognized
    // under ANY id — repeating the advice over a working producer sends the user to fix nothing.
    assert.doesNotMatch(formatPreview(analysis, 'APPLY'), /declare your suite gate with the lcov reporters by hand/);
  });

  it('a CUSTOMIZED dead-tool reference (compound form) is kept untouched and reported', () => {
    const analysis = buildMigrationPlan([CUSTOM], KIT_TOOLS);
    assert.equal(analysis.plan.find((r) => r.entry.id === 'my-ledger-wrap').action, 'keep');
    assert.deepEqual(analysis.customized.map((g) => g.id), ['my-ledger-wrap']);
    const preview = formatPreview(analysis, 'APPLY');
    assert.match(preview, /CUSTOMIZED \(untouched\): my-ledger-wrap/);
    assert.match(preview, /do NOT install the commit guard/);
  });
});

describe('migrate-gates — the canonical anchor + final-capability validation (round-1 folds)', () => {
  it('a canonical checker NOT in the last position is MOVED last (never left mid-list)', () => {
    const canonical = { id: 'coverage-check', title: 'CC', cmd: `node "${join(KIT_TOOLS, 'coverage-check.mjs')}" --check` };
    const { plan } = buildMigrationPlan([canonical, UNIT], KIT_TOOLS);
    const result = resultingGates(plan);
    assert.equal(result[result.length - 1].id, 'coverage-check', 'the canonical checker ends up LAST');
    assert.ok(plan.some((r) => r.action === 'move' && r.entry.id === 'coverage-check'), 'the reorder is an explicit move action');
    assert.ok(!plan.some((r) => r.action === 'add'), 'no duplicate checker is added');
  });

  it('a LOOKALIKE checker cmd is CUSTOMIZED (never counted canonical) and the canonical one is still added', () => {
    const lookalike = { id: 'cov', title: 'C', cmd: 'node scripts/coverage-check.mjs --check' };
    const analysis = buildMigrationPlan([lookalike, UNIT], KIT_TOOLS);
    assert.ok(analysis.customized.some((g) => g.id === 'cov'), 'the lookalike is reported customized');
    const result = resultingGates(analysis.plan);
    assert.equal(result[result.length - 1].id, 'coverage-check', 'the REAL canonical checker is added last');
  });

  it('the result is judged final-capable ONLY with a canonical review-state present; missing → a LOUD warning with the candidate line, never "final-run-capable"', () => {
    const analysis = buildMigrationPlan([UNIT], KIT_TOOLS);
    assert.equal(analysis.finalCapable, false, 'no review-state → not final-capable');
    const preview = formatPreview(analysis, 'APPLY');
    assert.match(preview, /review-state/, 'the warning names the missing core check');
    assert.match(preview, /"id": "review-state"|review-state\.mjs/, 'the paste-ready candidate is carried');
    assert.doesNotMatch(preview, /already final-run-capable/);
    const withRs = buildMigrationPlan(
      [UNIT, { id: 'review-state', title: 'RS', cmd: `node "${join(KIT_TOOLS, 'review-state.mjs')}" --check` }],
      KIT_TOOLS,
    );
    assert.equal(withRs.finalCapable, true);
  });

  it('a NON-canonical unit-tests cmd (npm test / wrapper) is CUSTOMIZED with the full flag set as the recovery', () => {
    const npmTest = { id: 'unit-tests', title: 'U', cmd: 'npm test' };
    const analysis = buildMigrationPlan([npmTest], KIT_TOOLS);
    assert.equal(analysis.plan.find((r) => r.entry.id === 'unit-tests').action, 'keep');
    assert.ok(analysis.customized.some((g) => g.id === 'unit-tests'), 'a non-canonical suite cmd is customized');
    const preview = formatPreview(analysis, 'APPLY');
    assert.match(preview, /--experimental-test-coverage/, 'the recovery carries the full flag set');
  });

  it('a PARTIALLY-flagged unit-tests cmd is CUSTOMIZED (a lone coverage flag never reads as configured)', () => {
    const partial = { id: 'unit-tests', title: 'U', cmd: 'node --test --experimental-test-coverage tools/*.test.mjs' };
    const analysis = buildMigrationPlan([partial], KIT_TOOLS);
    assert.equal(analysis.plan.find((r) => r.entry.id === 'unit-tests').action, 'keep');
    assert.ok(analysis.customized.some((g) => g.id === 'unit-tests'), 'the half-wired cmd is customized, never silently left');
  });

  it('a kitTools path with DQ-unsafe characters is a loud STOP before any write', () => {
    const root = mkProject([UNIT]);
    const evil = mkdtempSync(join(tmpdir(), 'migrate-gates-$evil-'));
    writeFileSync(join(evil, 'coverage-check.mjs'), '// lookalike\n');
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', evil, '--apply'], io), 1);
    assert.match(io.err.join('\n'), /double-quot|shell metacharacter/i);
    rmSync(evil, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('CUSTOMIZED warnings + the guard warning print even when apply has nothing else to do', () => {
    const root = mkProject([CUSTOM]);
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply'], io), 0);
    const text = io.out.join('\n');
    assert.match(text, /CUSTOMIZED \(untouched\): my-ledger-wrap/, 'the customized row survives the no-op path');
    assert.match(text, /do NOT install the commit guard/i, 'the guard warning survives the no-op path');
    rmSync(root, { recursive: true, force: true });
  });

  it('a SYMLINKED docs (or docs/ai) PARENT is a STOP on preview AND apply (never written through)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'migrate-gates-target-'));
    mkdirSync(join(outside, 'ai'), { recursive: true });
    writeFileSync(join(outside, 'ai', 'gates.json'), `${JSON.stringify({ gates: [UNIT] })}\n`);
    const root = mkdtempSync(join(tmpdir(), 'migrate-gates-symparent-'));
    symlinkSync(outside, join(root, 'docs'));
    for (const argv of [['--cwd', root, '--kit-tools', KIT_TOOLS], ['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply']]) {
      const io = quiet();
      assert.equal(main(argv, io), 1, `must STOP: ${argv.join(' ')}`);
      assert.match(io.err.join('\n'), /symlink/i);
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('migrate-gates — preview writes NOTHING; apply is atomic and complete', () => {
  it('the dry-run default leaves gates.json byte-identical and prints the plan + the apply hint', () => {
    const root = mkProject([LEGACY_LEDGER, UNIT]);
    const before = readFileSync(join(root, 'docs', 'ai', 'gates.json'), 'utf8');
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS], io), 0);
    assert.equal(readFileSync(join(root, 'docs', 'ai', 'gates.json'), 'utf8'), before, 'dry-run must write nothing');
    const text = io.out.join('\n');
    assert.match(text, /REMOVE review-ledger/);
    assert.match(text, /EXTEND unit-tests/);
    assert.match(text, /ADD coverage-check/);
    assert.match(text, /apply exactly this migration: node "\/[^"]*migrate-gates\.mjs" --kit-tools/, 'the apply hint is a REAL runnable path (never a file: URL)');
    rmSync(root, { recursive: true, force: true });
  });

  it('--apply lands the full migration: legacy gone, unit-tests extended, coverage-check LAST', () => {
    const root = mkProject([UNIT, LEGACY_LEDGER, LEGACY_FOLD]);
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply'], io), 0);
    const gates = gatesOf(root);
    assert.deepEqual(gates.map((g) => g.id), ['unit-tests', 'coverage-check']);
    assert.match(gates[0].cmd, /--experimental-test-coverage/);
    assert.equal(gates[gates.length - 1].id, 'coverage-check');
    rmSync(root, { recursive: true, force: true });
  });

  it('an ALREADY-migrated declaration is a stated no-op on apply', () => {
    const root = mkProject([UNIT, LEGACY_LEDGER]);
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply'], quiet()), 0);
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply'], io), 0);
    assert.match(io.out.join('\n'), /nothing to migrate/);
    rmSync(root, { recursive: true, force: true });
  });

  it('a MISSING gates.json is a stated no-op; a MALFORMED one is a loud STOP (never written over)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'migrate-gates-none-'));
    const io = quiet();
    assert.equal(main(['--cwd', empty, '--kit-tools', KIT_TOOLS], io), 0);
    assert.match(io.out.join('\n'), /nothing to migrate/);
    rmSync(empty, { recursive: true, force: true });

    const root = mkProject([]);
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), '{ not json');
    const io2 = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply'], io2), 1);
    assert.match(io2.err.join('\n'), /malformed JSON/);
    rmSync(root, { recursive: true, force: true });
  });

  it('a SYMLINKED gates.json is a STOP on preview AND apply', () => {
    const root = mkdtempSync(join(tmpdir(), 'migrate-gates-link-'));
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, 'real.json'), '{"gates":[]}\n');
    symlinkSync(join(root, 'real.json'), join(root, 'docs', 'ai', 'gates.json'));
    for (const argv of [['--cwd', root, '--kit-tools', KIT_TOOLS], ['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply']]) {
      const io = quiet();
      assert.equal(main(argv, io), 1);
      assert.match(io.err.join('\n'), /symlink/);
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('retired git-dir stores: previewed as CLEAN rows (nothing deleted), unlinked on apply, ENOENT a no-op', () => {
    const root = mkProject([LEGACY_LEDGER]);
    const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
    g('init', '-q');
    for (const name of RETIRED_STORE_BASENAMES) writeFileSync(join(root, '.git', name), '{"dead":1}\n');
    assert.equal(findRetiredStores(root).length, RETIRED_STORE_BASENAMES.length, 'all three retired basenames are found');
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS], io), 0);
    assert.match(io.out.join('\n'), /CLEAN .*agent-workflow-review-ledger\.v5-orphans\.jsonl/, 'the v5-orphans archive is previewed too');
    assert.equal(findRetiredStores(root).length, RETIRED_STORE_BASENAMES.length, 'the dry-run deleted NOTHING');
    const io2 = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply'], io2), 0);
    assert.deepEqual(findRetiredStores(root), [], 'apply unlinked every retired store');
    assert.match(io2.out.join('\n'), /cleaned .*agent-workflow-fold-completeness\.jsonl/);
    // A second apply: stores gone, declaration migrated — a stated no-op (ENOENT never errors).
    const io3 = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply'], io3), 0);
    assert.match(io3.out.join('\n'), /nothing to migrate/);
    rmSync(root, { recursive: true, force: true });
  });

  it('stores alone (an already-migrated declaration) still get cleaned on apply', () => {
    const root = mkProject([UNIT]);
    const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
    g('init', '-q');
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply'], quiet()), 0); // migrate first
    writeFileSync(join(root, '.git', RETIRED_STORE_BASENAMES[0]), '{"dead":1}\n');
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply'], io), 0);
    assert.match(io.out.join('\n'), /cleaned .*agent-workflow-review-ledger\.jsonl/);
    assert.deepEqual(findRetiredStores(root), []);
    rmSync(root, { recursive: true, force: true });
  });

  it('outside a git tree the store cleanup is a silent no-op (no crash, gates.json still migrates)', () => {
    const root = mkProject([LEGACY_LEDGER, UNIT]);
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply'], io), 0);
    assert.deepEqual(gatesOf(root).map((g2) => g2.id), ['unit-tests', 'coverage-check']);
    rmSync(root, { recursive: true, force: true });
  });

  it('--kit-tools is REQUIRED and must contain the checker (no runtime guessing)', () => {
    const root = mkProject([UNIT]);
    const io = quiet();
    assert.equal(main(['--cwd', root], io), 2);
    assert.match(io.err.join('\n'), /--kit-tools/);
    const io2 = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', root], io2), 1);
    assert.match(io2.err.join('\n'), /coverage-check\.mjs/);
    rmSync(root, { recursive: true, force: true });
  });
});
