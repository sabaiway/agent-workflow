// migrate-gates.test.mjs — spec for the consented legacy gates.json migration (strip-the-kit D8).
// The migration is ATOMIC and COMPLETE: canonical legacy entries removed + the unit-tests cmd
// moved onto the stable kit command, with no question + the coverage-check gate added LAST on the yes; customized entries are
// NEVER auto-touched (loud report + recovery); preview writes NOTHING; apply is tmp+rename. A kit-check
// gate over a current kit folder is switched to the stable kit command as one more action (spec kit-command S9).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  LEGACY_FORMS,
  RETIRED_STORE_BASENAMES,
  findRetiredStores,
  buildMigrationPlan,
  resultingGates,
  formatPreview,
  main,
} from './migrate-gates.mjs';
import { readFamily } from '../family.mjs';

const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^[Gg][Ii][Tt]_/.test(key) && key !== 'NODE_TEST_CONTEXT'));
// An INSTALLED kit tools dir carries both core checks as real files. That is a fixture
// requirement, not decoration: canonicity is a realpath anchor, so a core check whose file is not
// there resolves to nothing and is no claim at all — the same fail-closed answer run-gates gives.
const KIT_TOOLS = mkdtempSync(join(tmpdir(), 'migrate-gates-kit-'));
writeFileSync(join(KIT_TOOLS, 'coverage-check.mjs'), '// the installed checker the migration points at\n');
writeFileSync(join(KIT_TOOLS, 'review-state.mjs'), '// the installed review-state check\n');
// The project root the plan builder resolves declared RELATIVE tokens against — the same anchor
// run-gates uses. Empty on purpose for the pure-plan cases: a relative lookalike resolves to
// nothing there, which is exactly the "no claim can be made" outcome those rows assert. The
// vendored rows below build their own project and pass it explicitly. Its kit folder holds the migration's own run.mjs
// and the reporter, the guard on every write of the unit-tests command (spec coverage-producer).
const TREE = dirname(dirname(fileURLToPath(import.meta.url)));
const [RUN_REL, REPORTER_REL] = ['scripts/agent-workflow/run.mjs', 'scripts/agent-workflow/test-reporter/reporter.mjs'];
const placeCommand = (root) => {
  for (const rel of ['run.mjs', 'test-reporter/reporter.mjs']) {
    mkdirSync(dirname(join(root, 'scripts', 'agent-workflow', rel)), { recursive: true });
    copyFileSync(join(TREE, rel), join(root, 'scripts', 'agent-workflow', rel));
  }
};
const PROJECT = mkdtempSync(join(tmpdir(), 'migrate-gates-project-'));
placeCommand(PROJECT);

const mkProject = (gates, { command = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'migrate-gates-'));
  if (command) placeCommand(root);
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

// The one body the kit writes and the two flag sets earlier kits wrote after `node --test`, frozen as literal bytes:
// deployed declarations on disk carry exactly these.
const BODY = 'node scripts/agent-workflow/run.mjs unit-tests';
const SUITE_LINE = `${BODY} <your test paths>`;
const RETIRED_V2 =
  '--experimental-test-coverage --test-reporter=lcov --test-reporter-destination="${AW_GIT_DIR:?exported by run-gates}/agent-workflow-lcov.info" --test-reporter=spec --test-reporter-destination=stdout';
const RETIRED_V1 =
  '--experimental-test-coverage --test-reporter=lcov --test-reporter-destination="$AW_GIT_DIR/agent-workflow-lcov.info" --test-reporter=spec --test-reporter-destination=stdout';
const EXEC_PREFIXES = ['COREPACK_ENABLE_NETWORK=0 npm exec --offline --script-shell /bin/sh -- ', 'COREPACK_ENABLE_NETWORK=0 pnpm exec -- ', 'COREPACK_ENABLE_NETWORK=0 yarn exec -- '];
const [FLAG_SET_BYTES, UPGRADE] = [/--experimental-test-coverage|--test-reporter/, "the kit's upgrade"]; // memory names no sibling skill
// Every checker line: one positional fact and one remedy; a guard-kept gate's line ends with the upgrade's promise.
const [WITHHELD_FACT, POSITIONAL_FACT] = ['no declared gate is a producer this kit reads', 'no gate before it is a producer this kit reads'];
const CHECKER_REMEDY = 'declare or move one before it: node scripts/agent-workflow/run.mjs unit-tests <your test paths>, or mark your own suite gate "lcovProducer": true';
const GUARD_PROMISE = `once that is resolved, ${UPGRADE} moves this gate with no question`;
const [ADD_CHECKER, RERUN, VERIFIES_NOTHING] = ['--apply --add-checker', /re-run this migration/, /verif(?:y|ies|ying) nothing|certif(?:y|ies|ying) nothing/];
const factLine = (text, fact) => text.split('\n').find((line) => line.includes(fact) && line.includes(CHECKER_REMEDY));

// A VENDORED deployment: the SAME tools, from a copy `--kit-tools` does not name. Recognition is a
// realpath anchor, so these are real files — a fake path would be the unresolvable case instead.
const VENDORED_TOOLS = mkdtempSync(join(tmpdir(), 'migrate-gates-vendored-'));
writeFileSync(join(VENDORED_TOOLS, 'coverage-check.mjs'), '// a vendored copy of the checker\n');
writeFileSync(join(VENDORED_TOOLS, 'review-state.mjs'), '// a vendored copy of the review-state check\n');
const vendoredCmd = (name) => `node "${join(VENDORED_TOOLS, `${name}.mjs`)}" --check`;
const installedCmd = (name) => `node "${join(KIT_TOOLS, `${name}.mjs`)}" --check`;

const LEGACY_LEDGER = { id: 'review-ledger', title: 'L', cmd: 'node "/kit/tools/review-ledger.mjs" --check' };
const LEGACY_FOLD = { id: 'fold-completeness', title: 'F', cmd: 'node /kit/tools/fold-completeness.mjs --check' };
const UNIT = { id: 'unit-tests', title: 'U', cmd: 'node --test tools/*.test.mjs' };
const CUSTOM = { id: 'my-ledger-wrap', title: 'C', cmd: 'node scripts/wrap.mjs && node /kit/tools/review-ledger.mjs --check' };

describe('migrate-gates — the pure migration plan', () => {
  it('matches BOTH documented legacy forms (quoted and bare paths) and removes them', () => {
    for (const form of LEGACY_FORMS) assert.ok(form.re instanceof RegExp);
    const { plan } = buildMigrationPlan([LEGACY_LEDGER, LEGACY_FOLD], KIT_TOOLS, PROJECT);
    assert.deepEqual(plan.filter((r) => r.action === 'remove').map((r) => r.entry.id), ['review-ledger', 'fold-completeness']);
  });

  it('a unit-tests entry that merely CONTAINS a retired flag set is CUSTOMIZED with the command\'s recovery, never a silent keep', () => {
    const nearMiss = { id: 'unit-tests', title: 'U', cmd: `echo ${RETIRED_V1}` };
    const analysis = buildMigrationPlan([nearMiss], KIT_TOOLS, PROJECT);
    assert.equal(analysis.plan.find((r) => r.entry.id === 'unit-tests').action, 'keep', 'nothing is rewritten');
    assert.deepEqual(analysis.customized.map((g) => g.id), ['unit-tests'], 'but it IS reported customized');
    assert.equal(analysis.hasProducer, false, 'and it never counts as the producer the checker would read');
    const preview = formatPreview(analysis, 'APPLY');
    assert.match(preview, /CUSTOMIZED \(untouched\): unit-tests/);
    const recovery = preview.split('\n').find((line) => line.includes('recovery (apply by hand')) ?? '';
    assert.ok(recovery.includes(SUITE_LINE), `the recovery names the command: ${recovery}`);
    assert.doesNotMatch(recovery, FLAG_SET_BYTES, 'and no flag set');
    assert.match(recovery, /"lcovProducer": true/, 'the recovery names the marker as the other lane');
  });

  it('--apply --add-checker adds the coverage-check gate LAST with the RESOLVED quoted path; never a second one', () => {
    const root = mkProject([UNIT]);
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply', '--add-checker'], quiet()), 0);
    const last = gatesOf(root).at(-1);
    assert.equal(last.id, 'coverage-check');
    assert.equal(last.cmd, `node "${join(KIT_TOOLS, 'coverage-check.mjs')}" --check`);
    const before = readFileSync(join(root, 'docs', 'ai', 'gates.json'), 'utf8');
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply', '--add-checker'], quiet()), 0);
    assert.equal(readFileSync(join(root, 'docs', 'ai', 'gates.json'), 'utf8'), before, 'a declaration already carrying the checker gains no duplicate');
    rmSync(root, { recursive: true, force: true });
  });

  it('a declaration with NO producer never GAINS the checker — the pair is declared together or not at all', () => {
    const npmSuite = { id: 'suite', title: 'S', cmd: 'npm test' };
    const analysis = buildMigrationPlan([LEGACY_LEDGER, npmSuite], KIT_TOOLS, PROJECT);
    assert.ok(!analysis.plan.some((r) => r.action === 'add'), 'no checker is added over a declaration that produces no lcov');
    assert.deepEqual(resultingGates(analysis.plan).map((g) => g.id), ['suite'], 'the legacy entry still goes, nothing dead arrives');
    assert.equal(analysis.finalCapable, false, 'a declaration with no checker is not final-run-capable');
    const preview = formatPreview(analysis, 'APPLY');
    assert.match(preview, /coverage-check/, 'the withheld checker is named');
    assert.match(preview, /produce/i, 'the preview says WHY — no gate produces the lcov it would read');
    assert.ok(factLine(preview, WITHHELD_FACT), `the withheld line states the fact and the remedy, the command and the marker: ${preview}`);
  });

  it('an ALREADY-declared checker over no producer is reported INERT, is never removed, and is not final-run-capable', () => {
    const checker = { id: 'coverage-check', title: 'CC', cmd: `node "${join(KIT_TOOLS, 'coverage-check.mjs')}" --check` };
    const reviewState = { id: 'review-state', title: 'RS', cmd: `node "${join(KIT_TOOLS, 'review-state.mjs')}" --check` };
    const analysis = buildMigrationPlan([{ id: 'suite', title: 'S', cmd: 'npm test' }, reviewState, checker], KIT_TOOLS, PROJECT);
    assert.equal(analysis.finalCapable, false, 'a review-state present must NOT make an inert pair read as final-run-capable');
    assert.ok(resultingGates(analysis.plan).some((g) => g.id === 'coverage-check'), 'the declared checker is never removed');
    const preview = formatPreview(analysis, 'APPLY');
    assert.ok(factLine(preview, POSITIONAL_FACT), `the inert line states the fact and the remedy, the command and the marker: ${preview}`);
    assert.doesNotMatch(preview, FLAG_SET_BYTES, 'and carries no flag set');
    assert.doesNotMatch(preview, /already final-run-capable/);
  });

  it('a gates-init-shaped producer (the exec-wrapped offer form) is recognized — the checker IS added over it on the yes', () => {
    const offered = {
      id: 'test',
      title: 'T',
      cmd: `${EXEC_PREFIXES[0]}${BODY}`,
    };
    const root = mkProject([offered]);
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply', '--add-checker'], quiet()), 0);
    assert.deepEqual(gatesOf(root).map((g) => g.id), ['test', 'coverage-check']);
    rmSync(root, { recursive: true, force: true });
    const analysis = buildMigrationPlan([offered], KIT_TOOLS, PROJECT);
    // The `no canonical unit-tests entry` advice is keyed on the ID, but a producer is recognized
    // under ANY id — repeating the advice over a working producer sends the user to fix nothing.
    assert.doesNotMatch(formatPreview(analysis, 'APPLY'), /declare your suite gate with the lcov reporters by hand/);
  });

  it('a CUSTOMIZED dead-tool reference (compound form) is kept untouched and reported', () => {
    const analysis = buildMigrationPlan([CUSTOM], KIT_TOOLS, PROJECT);
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
    const { plan } = buildMigrationPlan([canonical, UNIT], KIT_TOOLS, PROJECT);
    const result = resultingGates(plan);
    assert.equal(result[result.length - 1].id, 'coverage-check', 'the canonical checker ends up LAST');
    assert.ok(plan.some((r) => r.action === 'move' && r.entry.id === 'coverage-check'), 'the reorder is an explicit move action');
    assert.ok(!plan.some((r) => r.action === 'add'), 'no duplicate checker is added');
  });

  it('a LOOKALIKE checker cmd is CUSTOMIZED (never counted canonical) and the canonical one is still added on the yes', () => {
    const lookalike = { id: 'cov', title: 'C', cmd: 'node scripts/coverage-check.mjs --check' };
    const analysis = buildMigrationPlan([lookalike, UNIT], KIT_TOOLS, PROJECT);
    assert.ok(analysis.customized.some((g) => g.id === 'cov'), 'the lookalike is reported customized');
    const root = mkProject([lookalike, UNIT]);
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply', '--add-checker'], quiet()), 0);
    assert.equal(gatesOf(root).at(-1).id, 'coverage-check', 'the REAL canonical checker is added last');
    rmSync(root, { recursive: true, force: true });
  });

  it('the result is judged final-capable ONLY with a canonical review-state present; missing → a LOUD warning with the candidate line, never "final-run-capable"', () => {
    const analysis = buildMigrationPlan([UNIT], KIT_TOOLS, PROJECT);
    assert.equal(analysis.finalCapable, false, 'no review-state → not final-capable');
    const preview = formatPreview(analysis, 'APPLY');
    assert.match(preview, /review-state/, 'the warning names the missing core check');
    assert.match(preview, /"id": "review-state"|review-state\.mjs/, 'the paste-ready candidate is carried');
    assert.doesNotMatch(preview, /already final-run-capable/);
    const withRs = buildMigrationPlan(
      [UNIT, { id: 'review-state', title: 'RS', cmd: `node "${join(KIT_TOOLS, 'review-state.mjs')}" --check` }],
      KIT_TOOLS,
      PROJECT,
    );
    assert.equal(withRs.finalCapable, true);
  });

  it('a PARTIALLY-flagged unit-tests cmd is CUSTOMIZED (a lone coverage flag never reads as configured)', () => {
    const partial = { id: 'unit-tests', title: 'U', cmd: 'node --test --experimental-test-coverage tools/*.test.mjs' };
    const analysis = buildMigrationPlan([partial], KIT_TOOLS, PROJECT);
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

describe('migrate-gates — a VENDORED core check is the tool, from a copy --kit-tools does not name (D6)', () => {
  const UNIT_DONE = { id: 'unit-tests', title: 'U', cmd: `${BODY} tools/*.test.mjs` };
  const INSTALLED_REVIEW_STATE = { id: 'review-state', title: 'RS', cmd: installedCmd('review-state') };

  it('a vendored coverage-check is PRESERVED exactly as declared — declared, never added over, never a collision', () => {
    // Before the split this entry was a LOOKALIKE holding the checker's id, which made the whole
    // upgrade a hard STOP: every preview and every apply over a vendored deployment failed.
    const vendored = { id: 'coverage-check', title: 'CC', cmd: vendoredCmd('coverage-check') };
    const declaration = [UNIT_DONE, INSTALLED_REVIEW_STATE, vendored];
    const analysis = buildMigrationPlan(declaration, KIT_TOOLS, PROJECT);
    assert.equal(analysis.collision, null, 'a vendored copy carries the tool\'s own id legitimately — it is no squatter');
    assert.ok(!analysis.plan.some((r) => r.action === 'add'), 'the checker IS declared, so a second one is never added');
    assert.deepEqual(analysis.plan.map((r) => r.action), ['keep', 'keep', 'keep'], 'nothing is rewritten or reordered');
    assert.deepEqual(resultingGates(analysis.plan), declaration, 'the declaration comes out byte-for-byte as it went in');
    assert.deepEqual(analysis.externalCoreChecks.map((c) => c.name), ['coverage-check']);
    assert.deepEqual(analysis.customized, [], 'a real copy of the tool is not an entry the tool cannot verify');
    assert.equal(analysis.finalCapable, false, '--final anchors on the INSTALLED copy, so the capability claim is withheld');
    const preview = formatPreview(analysis, 'APPLY');
    assert.match(preview, /VERIFY \(preserved exactly as declared\): coverage-check/, 'the outcome is NAMED');
    assert.match(preview, /DIFFERENT copy of the tool/, 'and says what it actually found');
    assert.match(preview, /NOT final-run-capable/);
    assert.doesNotMatch(preview, /already final-run-capable/);
  });

  it('a vendored review-state is preserved too — and is never advised to "add it" on top of itself', () => {
    const vendored = { id: 'review-state', title: 'RS', cmd: vendoredCmd('review-state') };
    const analysis = buildMigrationPlan([UNIT_DONE, vendored], KIT_TOOLS, PROJECT);
    assert.deepEqual(analysis.externalCoreChecks.map((c) => c.name), ['review-state']);
    assert.equal(analysis.hasReviewState, false, 'the INSTALLED review-state is still not declared');
    assert.equal(analysis.finalCapable, false);
    const preview = formatPreview(analysis, 'APPLY');
    assert.match(preview, /VERIFY \(preserved exactly as declared\): review-state/);
    assert.doesNotMatch(preview, /Add it \(paste-ready\)/, 'a second review-state entry is the ambiguity, not the remedy');
  });

  it('a core check naming a path nothing resolves is NO claim — fail-closed exactly where --final is', () => {
    // A lexical path compare called this canonical: the file need not exist to compare equal after
    // resolve(). The migration then promised final-run-capability over a cmd --final cannot run.
    const ghost = { id: 'review-state', title: 'RS', cmd: `node "${join(KIT_TOOLS, 'nowhere', 'review-state.mjs')}" --check` };
    const analysis = buildMigrationPlan([UNIT_DONE, ghost], KIT_TOOLS, PROJECT);
    assert.equal(analysis.hasReviewState, false, 'an unresolvable path is never the installed tool');
    assert.deepEqual(analysis.externalCoreChecks, [], 'nor evidence that the tool lives somewhere else');
    assert.ok(analysis.customized.some((g) => g.id === 'review-state'), 'it is reported as an entry the tool cannot verify');
    assert.equal(analysis.finalCapable, false);
  });

  it('a vendored checker never produces the lcov it reads — the declared pair stays INERT', () => {
    const vendored = { id: 'coverage-check', title: 'CC', cmd: vendoredCmd('coverage-check'), lcovProducer: true };
    const analysis = buildMigrationPlan(
      [{ id: 'lint', title: 'L', cmd: 'eslint .' }, INSTALLED_REVIEW_STATE, vendored],
      KIT_TOOLS,
      PROJECT,
    );
    assert.equal(analysis.hasProducer, false, 'a marker on the checker itself never self-pairs, whichever copy it is');
    assert.equal(analysis.checkerInert, true, 'a checker over nothing that writes the lcov reads no producer');
    assert.ok(factLine(formatPreview(analysis, 'APPLY'), POSITIONAL_FACT));
  });

  it('producer-after-vendored-checker: a producer declared AFTER a vendored checker never covers it', () => {
    // A canonical checker is always MOVED last, so "a producer exists" answers "a producer runs
    // first" for it. A vendored checker is left where the deployment put it, so the position-blind
    // answer reported a live pair over a checker that reads the lcov before anything writes one.
    const vendored = { id: 'coverage-check', title: 'CC', cmd: vendoredCmd('coverage-check') };
    const after = buildMigrationPlan([INSTALLED_REVIEW_STATE, vendored, UNIT_DONE], KIT_TOOLS, PROJECT);
    assert.equal(after.hasProducer, true, 'a producer IS declared somewhere');
    assert.equal(after.checkerInert, true, 'but not before the checker that reads what it writes');
    assert.equal(after.finalCapable, false);
    assert.ok(factLine(formatPreview(after, 'APPLY'), POSITIONAL_FACT));

    const before = buildMigrationPlan([UNIT_DONE, INSTALLED_REVIEW_STATE, vendored], KIT_TOOLS, PROJECT);
    assert.equal(before.checkerInert, false, 'the same entries in producer-first order are a live pair');
    assert.ok(!formatPreview(before, 'APPLY').includes(POSITIONAL_FACT));
  });

  it('the inert vendored row states one positional fact and one remedy, whether its producer runs after it or is absent', () => {
    // One fact covers both: a producer after the checker and none at all are the same position, and the one remedy names both edits.
    const vendored = { id: 'coverage-check', title: 'CC', cmd: vendoredCmd('coverage-check') };
    const misordered = formatPreview(buildMigrationPlan([INSTALLED_REVIEW_STATE, vendored, UNIT_DONE], KIT_TOOLS, PROJECT), 'APPLY');
    const absent = formatPreview(buildMigrationPlan([INSTALLED_REVIEW_STATE, vendored], KIT_TOOLS, PROJECT), 'APPLY');
    for (const preview of [misordered, absent]) {
      assert.ok(factLine(preview, POSITIONAL_FACT), preview);
      assert.doesNotMatch(preview, VERIFIES_NOTHING, 'no checker line says the checker verifies nothing');
    }
  });

  it('a mixed declaration renders ONE edit, never a removal and a reorder at once', () => {
    // The two folds met here: canonicalTwin asks for a removal, the inert arm asked for a reorder,
    // and a preview carrying both leaves the reader with no unambiguous next step.
    const canonical = { id: 'coverage-check', title: 'CC', cmd: installedCmd('coverage-check') };
    const vendored = { id: 'coverage-check-vendor', title: 'CCV', cmd: vendoredCmd('coverage-check') };
    const analysis = buildMigrationPlan([INSTALLED_REVIEW_STATE, vendored, UNIT_DONE, canonical], KIT_TOOLS, PROJECT);
    assert.deepEqual(analysis.externalCoreChecks.map((c) => [c.canonicalTwin, c.inert]), [[true, true]]);
    assert.equal(analysis.canonicalCheckerInert, false, 'the canonical checker ends up last, after the producer');
    const preview = formatPreview(analysis, 'APPLY');
    assert.match(preview, /Remove THIS entry by hand/);
    assert.ok(preview.includes(POSITIONAL_FACT), 'the inert row states the fact');
    assert.doesNotMatch(preview, /belongs LAST, after its producer/, 'no second, contradictory edit');
    assert.ok(!preview.includes(CHECKER_REMEDY), 'the twin keeps its one remedy, the removal');
  });

  it('a canonical checker declared BESIDE the vendored one changes the recovery — remove, never repoint', () => {
    // Repointing the vendored cmd at the installed copy would leave TWO canonical checkers, and
    // --final accepts exactly one; a recovery that cannot converge is worse than none.
    const canonical = { id: 'coverage-check', title: 'CC', cmd: installedCmd('coverage-check') };
    const vendored = { id: 'coverage-check-vendor', title: 'CCV', cmd: vendoredCmd('coverage-check') };
    const analysis = buildMigrationPlan([UNIT_DONE, INSTALLED_REVIEW_STATE, vendored, canonical], KIT_TOOLS, PROJECT);
    assert.deepEqual(analysis.externalCoreChecks.map((c) => c.canonicalTwin), [true]);
    const preview = formatPreview(analysis, 'APPLY');
    assert.match(preview, /accepts exactly ONE canonical check/);
    assert.match(preview, /Remove THIS entry by hand/);
    assert.doesNotMatch(preview, /either repoint the cmd/, 'the non-convergent recovery is not offered here');
  });

  it('a vendored deployment carries the SAME commit-guard consequence a customized one does', () => {
    // Both end in a declaration --final refuses, which mints no receipt, which makes the guard
    // refuse every commit. Naming the consequence for one and not the other is a false asymmetry.
    const vendored = { id: 'coverage-check', title: 'CC', cmd: vendoredCmd('coverage-check') };
    const preview = formatPreview(buildMigrationPlan([UNIT_DONE, INSTALLED_REVIEW_STATE, vendored], KIT_TOOLS, PROJECT), 'APPLY');
    assert.match(preview, /do NOT install the commit guard/);
  });

  it('the plan builder REFUSES without the project root — a relative cmd cannot be resolved without it', () => {
    assert.throws(() => buildMigrationPlan([UNIT_DONE], KIT_TOOLS), /project root/);
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
    assert.match(text, /apply exactly this migration: node "\/[^"]*migrate-gates\.mjs" --kit-tools/, 'the apply hint is a REAL runnable path (never a file: URL)');
    rmSync(root, { recursive: true, force: true });
  });

  it('--apply --add-checker lands the full migration: legacy gone, unit-tests extended, coverage-check LAST', () => {
    const root = mkProject([UNIT, LEGACY_LEDGER, LEGACY_FOLD]);
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply', '--add-checker'], io), 0);
    const gates = gatesOf(root);
    assert.deepEqual(gates.map((g) => g.id), ['unit-tests', 'coverage-check']);
    assert.equal(gates[0].cmd, `${BODY} tools/*.test.mjs`);
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
    const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8', env: childEnv });
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
    const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8', env: childEnv });
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
    assert.deepEqual(gatesOf(root).map((g2) => g2.id), ['unit-tests'], 'the moves land; the checker waits for the yes');
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

describe('spec:kit-command/S9 a kit-check gate is switched as an action of the migration, any other form named', () => {
  const TREE = dirname(dirname(fileURLToPath(import.meta.url)));
  const kitProject = (gates) => {
    const root = mkProject(gates);
    for (const { path } of readFamily(TREE).filter((entry) => entry.role === 'deployed')) {
      mkdirSync(dirname(join(root, 'scripts', 'agent-workflow', path)), { recursive: true });
      copyFileSync(join(TREE, path), join(root, 'scripts', 'agent-workflow', path));
    }
    return root;
  };
  const declared = (root) => readFileSync(join(root, 'docs', 'ai', 'gates.json'), 'utf8');
  const run = (root, args) => { const io = quiet(); const code = main(['--cwd', root, '--kit-tools', KIT_TOOLS, ...args], io); return { code, out: io.out.join('\n'), err: io.err.join('\n') }; };
  const repointLines = (text, name) => text.split('\n').filter((l) => l.includes(`node scripts/agent-workflow/run.mjs ${name}`) && !/^\s*(SWITCH|CUSTOMIZED)\b/.test(l) && !l.includes('apply exactly this migration'));
  const DOCS = { id: 'docs', title: 'D', cmd: 'node scripts/check-docs-size.mjs --check-index' };
  const SWITCHED = 'node scripts/agent-workflow/run.mjs docs-size --check-index';
  const LINT = { id: 'lint', title: 'L', cmd: 'npm run lint' };
  it('the preview switches an absent flat file or deployed target, writes nothing and prints a hint with only the three migration flags that applies exactly the switch', () => {
    for (const cmd of [DOCS.cmd, 'node scripts/agent-workflow/docs-size/check-docs-size.mjs --check-index']) {
      const docs = { ...DOCS, cmd };
      const root = kitProject([docs, LINT]);
      const before = declared(root);
      const r = run(root, []);
      assert.equal(r.code, 0, r.err);
      const switches = r.out.split('\n').filter((l) => /^\s*SWITCH\b/.test(l));
      assert.equal(switches.length, 1, r.out);
      for (const part of ['SWITCH docs', SWITCHED, docs.cmd]) assert.ok(switches[0].includes(part), `${switches[0]} carries ${part}`);
      assert.doesNotMatch(r.out, /nothing to migrate/);
      assert.equal(declared(root), before, 'the preview writes nothing');
      const hint = r.out.split('\n').find((l) => l.includes('apply exactly this migration: '))?.split('apply exactly this migration: ')[1] ?? '';
      assert.deepEqual(hint.match(/--[a-z-]+/g), ['--kit-tools', '--cwd', '--apply'], hint);
      for (const value of [KIT_TOOLS, root]) assert.ok(hint.includes(`"${value}"`), hint);
      const applied = spawnSync('bash', ['-c', hint], { encoding: 'utf8', env: childEnv });
      assert.equal(applied.status, 0, applied.stderr);
      assert.deepEqual(gatesOf(root), [{ ...DOCS, cmd: SWITCHED }, LINT], 'the hint switched exactly the gate the preview named SWITCH');
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('--apply writes each switch at its place, beside the legacy migration\'s own actions', () => {
    const issues = { id: 'issues', title: 'I', cmd: 'node scripts/agent-workflow/archives/archive-issues.mjs --check' };
    const root = kitProject([LEGACY_LEDGER, DOCS, UNIT, issues]);
    const r = run(root, ['--apply']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(gatesOf(root), [
      { ...DOCS, cmd: SWITCHED },
      { ...UNIT, cmd: `${BODY} tools/*.test.mjs` },
      { ...issues, cmd: 'node scripts/agent-workflow/run.mjs archive-issues --check' },
    ], 'no checker is added without --add-checker');
    rmSync(root, { recursive: true, force: true });
  });
  it('--kit-script is an unknown argument, exits 2 without writing and appears nowhere in the usage', () => {
    const root = kitProject([DOCS]);
    const before = declared(root);
    for (const tail of [[], ['--apply']]) {
      const r = run(root, ['--kit-script', 'scripts/check-docs-size.mjs', ...tail]);
      assert.equal(r.code, 2, `${tail}: ${r.out}${r.err}`);
      assert.match(r.err, /unknown argument: --kit-script/);
      assert.equal(r.out, '');
      assert.equal(declared(root), before, `${tail} wrote nothing`);
    }
    const help = run(root, ['--help']);
    assert.equal(help.code, 0, help.err);
    assert.doesNotMatch(help.out, /--kit-script/);
    rmSync(root, { recursive: true, force: true });
  });
  it('a standing flat file keeps its gate and repoint beside an absent flat file that switches, in preview and apply', () => {
    const issues = { id: 'issues', title: 'I', cmd: 'node scripts/archive-issues.mjs --check' };
    const root = kitProject([LINT, DOCS, issues]);
    writeFileSync(join(root, 'scripts', 'archive-issues.mjs'), 'project-owned bytes\n');
    const before = declared(root);
    for (const tail of [[], ['--apply']]) {
      const r = run(root, tail);
      assert.equal(r.code, 0, r.err);
      assert.equal(repointLines(r.out, 'archive-issues').filter((line) => line.includes(issues.id)).length, 1, r.out);
      assert.doesNotMatch(r.out, /CUSTOMIZED|do NOT install the commit guard/);
      if (tail.length === 0) { assert.match(r.out, /SWITCH docs:/); assert.equal(declared(root), before); }
      else assert.deepEqual(gatesOf(root), [LINT, { ...DOCS, cmd: SWITCHED }, issues]);
    }
    rmSync(root, { recursive: true, force: true });
  });
  it('a kit check beside a dead-tool reference stays CUSTOMIZED with its recovery and the guard warning and gains its repoint line; a repoint alone joins neither', () => {
    const wrapped = { id: 'wrapped', title: 'W', cmd: 'node scripts/check-docs-size.mjs && node /kit/tools/review-ledger.mjs --check' };
    const elsewhere = { id: 'elsewhere', title: 'E', cmd: 'node scripts/archives/archive-issues.mjs --check' };
    for (const [one, name, customized] of [[wrapped, 'docs-size', true], [elsewhere, 'archive-issues', false]]) {
      const root = kitProject([one]);
      for (const tail of [[], ['--apply']]) {
        const r = run(root, tail);
        assert.equal(r.code, 0, r.err);
        assert.equal(repointLines(r.out, name).filter((l) => l.includes(one.id)).length, 1, `${one.id} ${tail}: one repoint line\n${r.out}`);
        for (const pattern of [new RegExp(`CUSTOMIZED \\(untouched\\): ${one.id}`), /recovery \(apply by hand/, /do NOT install the commit guard/]) {
          assert.equal(pattern.test(r.out), customized, `${one.id} ${tail}: ${pattern}\n${r.out}`);
        }
        assert.deepEqual(gatesOf(root), [one], `${one.id} ${tail}: the gate is never rewritten`);
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const RS = { id: 'review-state', title: 'RS', cmd: installedCmd('review-state') };
const CC = { id: 'coverage-check', title: 'CC', cmd: installedCmd('coverage-check') };
const retired = (flags, { id = 'unit-tests', prefix = '', tail = '', ...extra } = {}) => ({ id, title: 'U', cmd: `${prefix}node --test ${flags}${tail ? ` ${tail}` : ''}`, ...extra });
const commandCmd = (prefix = '', tail = '') => `${prefix}${BODY}${tail ? ` ${tail}` : ''}`;
const linesOf = (text, pattern) => text.split('\n').filter((line) => pattern.test(line));
const previewOf = (gates, project = PROJECT) => formatPreview(buildMigrationPlan(gates, KIT_TOOLS, project), 'APPLY');
// The guard's remedies in the memory substrate, which names the kit's upgrade and no sibling skill.
const ABSENT_REMEDY = `is absent — the kit's upgrade places the kit folder only where Node evidence stands (a root package.json, or a kit script): add one if this project runs Node, then run ${UPGRADE}.`;
const WRONG_KIND_REMEDY = `is not what the kit writes there — a directory, a link, or a file where a folder belongs — beside which the specs op writes nothing: clear it by hand first, then run ${UPGRADE}`;
// A project whose guard fails one way, with the first failing path and its remedy.
const GUARD_FAILURES = [
  ['run.mjs absent', RUN_REL, ABSENT_REMEDY, (root) => rmSync(join(root, RUN_REL))],
  ['run.mjs an earlier kit\'s bytes', RUN_REL, 'differs from this kit\'s', (root) => writeFileSync(join(root, RUN_REL), `${readFileSync(join(root, RUN_REL), 'utf8')}// an earlier kit\n`)],
  ['the reporter absent', REPORTER_REL, ABSENT_REMEDY, (root) => rmSync(join(root, REPORTER_REL))],
  ['scripts/agent-workflow a regular file', 'scripts/agent-workflow', WRONG_KIND_REMEDY, (root) => { rmSync(join(root, 'scripts', 'agent-workflow'), { recursive: true }); writeFileSync(join(root, 'scripts', 'agent-workflow'), 'x\n'); }],
];
const declaredBytes = (root) => readFileSync(join(root, 'docs', 'ai', 'gates.json'), 'utf8');
const runIn = (root, ...args) => { const io = quiet(); const code = main(['--cwd', root, '--kit-tools', KIT_TOOLS, ...args], io); return { code, out: io.out.join('\n'), err: io.err.join('\n') }; };
const switchLines = (text) => linesOf(text, /^\s*SWITCH\b/).map((line) => line.trim());

describe('spec:coverage-producer/S4 --apply, with no other flag, switches every retired producer form to the command while the guard holds', () => {
  it('bare, behind each exec prefix, with a path tail and a quoted glob tail, under unit-tests and test, marked: switched in place, SWITCH with its was:, the preview the same lines, a rerun writes nothing', () => {
    const cases = [...[RETIRED_V2, RETIRED_V1].map((flags) => [flags, {}]), ...EXEC_PREFIXES.map((prefix) => [RETIRED_V2, { prefix, id: 'test' }]),
      [RETIRED_V1, { tail: 'tools/*.test.mjs test/*.test.mjs' }], [RETIRED_V2, { tail: "'src/**/*.test.mjs'", id: 'test' }],
      [RETIRED_V2, { tail: 'tools/*.test.mjs', lcovProducer: true }], [RETIRED_V1, { prefix: EXEC_PREFIXES[1], tail: 'test/*.mjs', id: 'test', lcovProducer: true }]];
    for (const [flags, options] of cases) {
      const gate = retired(flags, options);
      const expected = { ...gate, cmd: commandCmd(options.prefix, options.tail) };
      const root = mkProject([gate, RS]);
      const before = declaredBytes(root);
      const preview = runIn(root);
      assert.ok(preview.code === 0 && declaredBytes(root) === before, `${gate.cmd}: the preview writes nothing: ${preview.err}`);
      const applied = runIn(root, '--apply');
      assert.equal(applied.code, 0, applied.err);
      assert.deepEqual(gatesOf(root), [expected, RS], `${gate.cmd}: switched at its place, every other field kept, no checker unasked`);
      const lines = switchLines(applied.out);
      assert.equal(lines.length, 1, applied.out);
      for (const part of [`SWITCH ${gate.id}`, expected.cmd, `was: ${gate.cmd}`]) assert.ok(lines[0].includes(part), `${lines[0]} carries ${part}`);
      assert.deepEqual(switchLines(preview.out), lines, 'the preview prints the same SWITCH line');
      const moved = declaredBytes(root);
      assert.ok(runIn(root, '--apply').code === 0 && declaredBytes(root) === moved, `${gate.cmd}: a second --apply writes nothing`);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--apply keeps every other gate at its place; a command-body gate, an echo of a retired body and a shopt-prefixed retired body are untouched', () => {
    const lint = { id: 'lint', title: 'L', cmd: 'npm run lint' };
    const switched = retired(RETIRED_V2, { id: 'test', prefix: EXEC_PREFIXES[0], tail: 'tools/*.test.mjs' });
    const untouched = [{ id: 'own', title: 'O', cmd: commandCmd('', 'more/*.test.mjs') }, { id: 'echoed', title: 'E', cmd: `echo node --test ${RETIRED_V2}` },
      { id: 'globbed', title: 'G', cmd: `shopt -s globstar && node --test ${RETIRED_V2} tools/**/*.test.mjs` }];
    const root = mkProject([lint, switched, ...untouched, RS]);
    const applied = runIn(root, '--apply');
    assert.equal(applied.code, 0, applied.err);
    assert.deepEqual(switchLines(applied.out).map((line) => line.split(':')[0]), ['SWITCH test']);
    assert.deepEqual(gatesOf(root), [lint, { ...switched, cmd: commandCmd(EXEC_PREFIXES[0], 'tools/*.test.mjs') }, ...untouched, RS]);
    rmSync(root, { recursive: true, force: true });
    const kept = mkProject([retired(RETIRED_V1, { lcovProducer: true }), RS, CC]);
    assert.equal(runIn(kept, '--apply').code, 0);
    assert.deepEqual(gatesOf(kept), [{ ...retired(RETIRED_V1, { lcovProducer: true }), cmd: BODY }, RS, CC], 'the declared checker is kept, never duplicated');
    rmSync(kept, { recursive: true, force: true });
  });
});

describe('spec:coverage-producer/S5 a flag in the tail is CUSTOMIZED; a failed guard keeps the gate with its one line', () => {
  it('a retired form whose tail holds --test-concurrency=1, under unit-tests and another id, is CUSTOMIZED with the command\'s recovery and written nowhere; the checker lines state the fact', () => {
    for (const id of ['unit-tests', 'test']) {
      const gate = retired(RETIRED_V2, { id, tail: '--test-concurrency=1 tools/*.test.mjs' });
      for (const [gates, fact] of [[[gate], WITHHELD_FACT], [[gate, RS, CC], POSITIONAL_FACT], [[gate, RS, { ...CC, cmd: vendoredCmd('coverage-check') }], POSITIONAL_FACT]]) {
        const root = mkProject(gates);
        const before = declaredBytes(root);
        const r = runIn(root, '--apply');
        assert.ok(r.code === 0 && declaredBytes(root) === before, `${id} ${gates.length}: written nowhere: ${r.err}`);
        const [recovery] = linesOf(r.out, /recovery \(apply by hand/);
        assert.ok(r.out.includes(`CUSTOMIZED (untouched): ${id}`) && switchLines(r.out).length === 0 && recovery?.includes(SUITE_LINE) && !FLAG_SET_BYTES.test(recovery), `${id}: ${r.out}`);
        assert.ok(factLine(r.out, fact), `${id} ${gates.length}: the checker line states the fact and the remedy: ${r.out}`);
        assert.doesNotMatch(r.out, /form an earlier kit wrote|verif(?:y|ies|ying) nothing/, 'why a gate was kept rides that gate\'s own line, never a checker line');
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  for (const [state, path, remedy, breakGuard] of GUARD_FAILURES) {
    it(`${state}: each retired gate, marked or not, is kept as declared with one line naming its id, ${path}, its remedy and the upgrade's promise, no SWITCH, no re-run`, () => {
      const unmarked = retired(RETIRED_V2, { tail: 'tools/*.test.mjs' });
      const marked = retired(RETIRED_V1, { id: 'project-check-42', lcovProducer: true });
      for (const [gates, gate, checker] of [[[unmarked], unmarked, 'withheld'], [[unmarked, RS, CC], unmarked, 'inert'], [[marked], marked, 'offered'], [[marked, RS, CC], marked, 'kept']]) {
        const root = mkProject(gates);
        breakGuard(root);
        const before = declaredBytes(root);
        const r = runIn(root, '--apply');
        assert.equal(r.code, 0, `${state} ${checker}: no throw: ${r.err}`);
        assert.ok(declaredBytes(root) === before && switchLines(r.out).length === 0, `${state} ${checker}: kept as declared, nothing added, no SWITCH: ${r.out}`);
        const kept = linesOf(r.out, new RegExp(GUARD_PROMISE));
        assert.equal(kept.length, 1, `${state} ${checker}: ${r.out}`);
        for (const word of [gate.id, `${path} `, remedy]) assert.ok(kept[0].includes(word), `${kept[0]} names ${word}`);
        assert.doesNotMatch(r.out, RERUN, `${state} ${checker}: no line says re-run this migration`);
        if (checker === 'withheld') assert.ok(factLine(r.out, WITHHELD_FACT), r.out);
        if (checker === 'inert') assert.ok(factLine(r.out, POSITIONAL_FACT), r.out);
        if (checker === 'offered') assert.ok(r.out.includes(ADD_CHECKER), `a marked gate reads as a producer: the checker is offered: ${r.out}`);
        if (checker === 'kept') assert.ok(!r.out.includes(POSITIONAL_FACT) && !r.out.includes(ADD_CHECKER), r.out);
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe('spec:coverage-producer/S6 the extend writes the command over a path-shaped rest; every printed suite line names the command', () => {
  it('--apply extends node --test with paths and alone to the command body with its was:, a declared checker inert before reads live after; a flag in the rest is CUSTOMIZED', () => {
    for (const [cmd, written] of [['node --test tools/*.test.mjs', `${BODY} tools/*.test.mjs`], ['node --test', BODY]]) {
      const root = mkProject([{ ...UNIT, cmd }, RS, CC]);
      const r = runIn(root, '--apply');
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(gatesOf(root), [{ ...UNIT, cmd: written }, RS, CC], cmd);
      const extend = linesOf(r.out, /^\s*EXTEND unit-tests\b/);
      assert.ok(extend.length === 1 && extend[0].includes(written) && extend[0].includes(`was: ${cmd}`), `the acted row prints with its was: ${r.out}`);
      const again = runIn(root);
      assert.ok(!again.out.includes(POSITIONAL_FACT) && !/CUSTOMIZED|^\s*(EXTEND|SWITCH)\b/m.test(again.out), `${cmd}: the checker reads live, the next run has nothing to do: ${again.out}`);
      rmSync(root, { recursive: true, force: true });
    }
    const flagged = { ...UNIT, cmd: 'node --test --test-concurrency=1 tools/*.test.mjs' };
    const analysis = buildMigrationPlan([flagged], KIT_TOOLS, PROJECT);
    assert.deepEqual([analysis.customized, analysis.unitTestsExtended], [[flagged], false]);
    assert.ok(linesOf(formatPreview(analysis, 'APPLY'), /recovery \(apply by hand/)[0]?.includes(SUITE_LINE));
  });

  it('with run.mjs absent the unit-tests gate is kept with the guard\'s line, never extended', () => {
    const root = mkProject([UNIT, RS]);
    rmSync(join(root, RUN_REL));
    const before = declaredBytes(root);
    const r = runIn(root, '--apply');
    assert.ok(r.code === 0 && declaredBytes(root) === before && linesOf(r.out, /^\s*EXTEND\b/).length === 0, `${r.out}${r.err}`);
    const kept = linesOf(r.out, new RegExp(GUARD_PROMISE));
    assert.ok(kept.length === 1 && ['unit-tests', `${RUN_REL} `, ABSENT_REMEDY].every((word) => kept[0].includes(word)) && !RERUN.test(r.out), r.out);
    rmSync(root, { recursive: true, force: true });
  });

  it('no printed suite or recovery line carries a flag set: the customized recovery, the withheld and inert blocks and a vendored inert line', () => {
    const vendored = { id: 'coverage-check', title: 'CC', cmd: vendoredCmd('coverage-check') }; assert.deepEqual(buildMigrationPlan([{ ...UNIT, cmd: 'npm test' }], KIT_TOOLS, PROJECT).customized.map((g) => g.cmd), ['npm test'], 'npm test is CUSTOMIZED');
    for (const gates of [[{ ...UNIT, cmd: 'npm test' }], [{ id: 'suite', title: 'S', cmd: 'npm test' }], [{ id: 'suite', title: 'S', cmd: 'npm test' }, RS, CC], [RS, vendored]]) {
      assert.doesNotMatch(previewOf(gates), FLAG_SET_BYTES, JSON.stringify(gates));
      const suiteLines = linesOf(previewOf(gates), /your test paths/);
      assert.ok(suiteLines.length > 0, JSON.stringify(gates));
      for (const line of suiteLines) assert.ok(line.includes(SUITE_LINE) && !FLAG_SET_BYTES.test(line), line);
    }
  });
});
