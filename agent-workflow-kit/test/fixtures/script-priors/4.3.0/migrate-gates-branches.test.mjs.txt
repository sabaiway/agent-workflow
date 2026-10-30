// migrate-gates-branches.test.mjs — the refusal/no-op branch pins the main spec file leaves
// unexercised (colocated so the D3(d) changed-line check reads real executions, not intentions):
// the --help arm, the missing-declaration no-op, the invalid-shape STOP, the honest no-op split
// on final-run-capability, the mid-write parent-verification failure (fail closed + tmp cleanup),
// and the loud-but-non-fatal retired-store cleanup error.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CHECKER_CLAIM, UNIT_TESTS_COVERAGE_FLAGS, RETIRED_STORE_BASENAMES, checkerClaimTool, classifyCheckerClaim, main } from './migrate-gates.mjs';

// Both core checks exist as real files — canonicity is a realpath anchor, so a check whose file is
// absent resolves to nothing and is no claim at all (the fail-closed answer run-gates gives too).
const KIT_TOOLS = mkdtempSync(join(tmpdir(), 'migrate-branches-kit-'));
writeFileSync(join(KIT_TOOLS, 'coverage-check.mjs'), '// the installed checker the migration points at\n');
writeFileSync(join(KIT_TOOLS, 'review-state.mjs'), '// the installed review-state check\n');

const mkProject = (gates) => {
  const root = mkdtempSync(join(tmpdir(), 'migrate-branches-'));
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  if (gates !== undefined) {
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), typeof gates === 'string' ? gates : `${JSON.stringify({ gates }, null, 2)}\n`);
  }
  return root;
};
const quiet = () => {
  const out = [];
  const err = [];
  return { log: (l) => out.push(String(l)), error: (l) => err.push(String(l)), out, err };
};

const UNIT_DONE = { id: 'unit-tests', title: 'U', cmd: `node --test ${UNIT_TESTS_COVERAGE_FLAGS} tools/*.test.mjs` };
const CHECKER = { id: 'coverage-check', title: 'CC', cmd: `node "${join(KIT_TOOLS, 'coverage-check.mjs')}" --check` };
const REVIEW_STATE = { id: 'review-state', title: 'RS', cmd: `node "${join(KIT_TOOLS, 'review-state.mjs')}" --check` };
const LEGACY = { id: 'review-ledger', title: 'L', cmd: 'node "/kit/tools/review-ledger.mjs" --check' };
const UNIT = { id: 'unit-tests', title: 'U', cmd: 'node --test tools/*.test.mjs' };
// A suite the closed producer world cannot express, declaring itself with the optional marker.
const MARKED_SUITE = { id: 'suite', title: 'S', cmd: 'pnpm vitest run --coverage', lcovProducer: true };

describe('migrate-gates — refusal and no-op branches', () => {
  it('--help prints the contract and exits 0', () => {
    const io = quiet();
    assert.equal(main(['--help'], io), 0);
    assert.match(io.out.join('\n'), /Usage:/);
  });

  it('the no-op split is HONEST about final-run-capability (capable names it; incapable never does)', () => {
    const capable = mkProject([UNIT_DONE, REVIEW_STATE, CHECKER]);
    const io = quiet();
    assert.equal(main(['--cwd', capable, '--kit-tools', KIT_TOOLS], io), 0);
    assert.match(io.out.join('\n'), /already final-run-capable/);
    rmSync(capable, { recursive: true, force: true });

    const incapable = mkProject([UNIT_DONE, CHECKER]);
    const io2 = quiet();
    assert.equal(main(['--cwd', incapable, '--kit-tools', KIT_TOOLS], io2), 0);
    const text = io2.out.join('\n');
    assert.match(text, /nothing to migrate mechanically/);
    assert.match(text, /NOT final-run-capable/);
    assert.doesNotMatch(text, /already final-run-capable/);
    rmSync(incapable, { recursive: true, force: true });
  });

  it('docs/ai WITHOUT a gates.json (and no stores) is a stated no-op, never a crash', () => {
    const root = mkProject(undefined);
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS], io), 0);
    assert.match(io.out.join('\n'), /nothing to migrate/);
    rmSync(root, { recursive: true, force: true });
  });

  it('a parseable-but-invalid declaration ({ gates: <non-array> }) is a loud STOP', () => {
    const root = mkProject('{ "gates": 5 }\n');
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply'], io), 1);
    assert.match(io.err.join('\n'), /not a \{ gates/);
    rmSync(root, { recursive: true, force: true });
  });

  it('an lstat failure DURING the write fails CLOSED — nothing written, the tmp cleaned', () => {
    const root = mkProject([LEGACY, UNIT]);
    const before = readFileSync(join(root, 'docs', 'ai', 'gates.json'), 'utf8');
    const tmpExists = () => readdirSync(join(root, 'docs', 'ai')).some((f) => f.endsWith('.tmp'));
    const io = {
      ...quiet(),
      // Fail the parent verification the moment the tmp file exists — that is exactly the
      // PRE-RENAME re-check, whatever the lstat call count is (count-anchored injection went
      // silently stale once loadDeclaration became an lstat consumer too).
      lstat: (p) => {
        if (tmpExists()) throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
        return lstatSync(p);
      },
    };
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply'], io), 1);
    assert.match(io.err.join('\n'), /cannot verify the declaration parent/);
    assert.equal(readFileSync(join(root, 'docs', 'ai', 'gates.json'), 'utf8'), before, 'the declaration is untouched');
    assert.deepEqual(readdirSync(join(root, 'docs', 'ai')).filter((f) => f.endsWith('.tmp')), [], 'no tmp litter survives (the writer catch cleaned it)');
    rmSync(root, { recursive: true, force: true });
  });

  it('a NON-canonical entry squatting the checker id is a loud STOP on preview AND apply (never a duplicate row)', () => {
    const squatter = { id: 'coverage-check', title: 'C', cmd: 'node scripts/coverage-check.mjs --check' };
    const root = mkProject([squatter, UNIT]);
    for (const argv of [['--cwd', root, '--kit-tools', KIT_TOOLS], ['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply']]) {
      const io = quiet();
      assert.equal(main(argv, io), 1, `must STOP: ${argv.join(' ')}`);
      assert.match(io.err.join('\n'), /id collision/);
    }
    const after = JSON.parse(readFileSync(join(root, 'docs', 'ai', 'gates.json'), 'utf8')).gates;
    assert.equal(after.filter((g) => g.id === 'coverage-check').length, 1, 'nothing was written');
    rmSync(root, { recursive: true, force: true });
  });

  it('a canonical checker addressed THROUGH A SYMLINKED kit dir is recognized (realpath, never lexical)', () => {
    const linked = join(tmpdir(), `migrate-branches-link-${process.pid}`);
    rmSync(linked, { force: true });
    symlinkSync(KIT_TOOLS, linked);
    const throughLink = { id: 'coverage-check', title: 'CC', cmd: `node "${join(linked, 'coverage-check.mjs')}" --check` };
    const root = mkProject([throughLink, UNIT]);
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS], io), 0, io.err.join('\n'));
    const text = io.out.join('\n');
    assert.doesNotMatch(text, /id collision/, 'the symlinked canonical checker is never a collision');
    assert.doesNotMatch(text, /ADD coverage-check/, 'no duplicate checker is added');
    rmSync(linked, { force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('a NON-ENOENT lstat failure on the gates.json LEAF is a loud STOP — never read as "missing"', () => {
    const root = mkProject([LEGACY, UNIT]);
    spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
    writeFileSync(join(root, '.git', RETIRED_STORE_BASENAMES[0]), '{"dead":1}\n');
    const io = {
      ...quiet(),
      lstat: (p) => {
        if (p.endsWith('gates.json')) throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
        return lstatSync(p);
      },
    };
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply'], io), 1, 'an unreadable declaration must STOP the apply');
    assert.match(io.err.join('\n'), /EACCES/);
    assert.ok(lstatSync(join(root, '.git', RETIRED_STORE_BASENAMES[0])).isFile(), 'the retired store is untouched on the STOP');
    rmSync(root, { recursive: true, force: true });
  });

  it('a marker-carrying entry survives an apply UNCHANGED — the loader is lenient, the writer opaque', () => {
    // The declaration this tool rewrites may carry keys it knows nothing about. The loader accepts
    // any `{ gates: [...] }` shape and the writer re-serializes the ENTRY, not a reconstruction of
    // it, so an upgrade over a marker-carrying deployment never silently drops the claim.
    const root = mkProject([LEGACY, MARKED_SUITE, REVIEW_STATE]);
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply'], io), 0, io.err.join('\n'));
    const raw = readFileSync(join(root, 'docs', 'ai', 'gates.json'), 'utf8');
    const written = JSON.parse(raw).gates;
    assert.deepEqual(written.map((g) => g.id), ['suite', 'review-state', 'coverage-check'], 'the checker is ADDED over a marker-claimed producer');
    assert.deepEqual(written[0], MARKED_SUITE, 'the marked entry round-trips key for key');
    assert.match(raw, /"lcovProducer": true/, 'and the marker is really in the written bytes');
    assert.doesNotMatch(io.out.join('\n'), /WARNING/, 'nothing is withheld over a declared producer');
    rmSync(root, { recursive: true, force: true });
  });

  it('a marker on the CHECKER ITSELF never self-pairs — the declared pair stays INERT', () => {
    // The producer question is POSITIONAL: the checker always ends up last, so it can never be its
    // own producer. Asking it over the whole kept set would let this declaration certify itself
    // into final-run-capability with nothing writing the lcov.
    const root = mkProject([{ id: 'lint', title: 'L', cmd: 'eslint .' }, REVIEW_STATE, { ...CHECKER, lcovProducer: true }]);
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS], io), 0, io.err.join('\n'));
    const text = io.out.join('\n');
    assert.match(text, /INERT/, 'the dead pair is named');
    assert.doesNotMatch(text, /already final-run-capable/, 'and never claimed capable');
    rmSync(root, { recursive: true, force: true });
  });

  it('a MARKED unit-tests entry is a zero-diff keep — never extended, never reported customized', () => {
    // Both arms the marker settles at once: `npm test` is a cmd this tool cannot verify (customized
    // without the marker), and rewriting a cmd whose owner declared it the producer would change
    // bytes the byte-exact hook approval binds.
    const marked = { id: 'unit-tests', title: 'U', cmd: 'npm test', lcovProducer: true };
    const root = mkProject([marked, REVIEW_STATE]);
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS], io), 0, io.err.join('\n'));
    const text = io.out.join('\n');
    assert.match(text, /ADD coverage-check/, 'the claimed producer unlocks the checker');
    assert.doesNotMatch(text, /EXTEND unit-tests/, 'a claimed producer cmd is never rewritten');
    assert.doesNotMatch(text, /CUSTOMIZED/, 'nor reported as a cmd the tool cannot verify');
    rmSync(root, { recursive: true, force: true });

    // The SAME entry unmarked is the customized/withheld path — the marker is what settles it.
    const bare = mkProject([{ id: 'unit-tests', title: 'U', cmd: 'npm test' }, REVIEW_STATE]);
    const io2 = quiet();
    assert.equal(main(['--cwd', bare, '--kit-tools', KIT_TOOLS], io2), 0, io2.err.join('\n'));
    const text2 = io2.out.join('\n');
    assert.match(text2, /CUSTOMIZED/);
    assert.doesNotMatch(text2, /ADD coverage-check/, 'the checker stays withheld with no producer');
    rmSync(bare, { recursive: true, force: true });
  });

  it('a marker over an UNRUNNABLE cmd never unlocks the checker — the lenient loader has no validator', () => {
    // This tool accepts any `{ gates: [...] }` shape, so an entry the strict validator would refuse
    // reaches the plan builder intact. A marker on such an entry must not make the migration ADD the
    // canonical checker: the result would be the dead pair the withhold exists to prevent, and the
    // written declaration would then fail run-gates outright.
    for (const cmd of ['   ', 'echo a\nrm -rf b']) {
      const root = mkProject([{ id: 'suite', title: 'S', cmd, lcovProducer: true }, REVIEW_STATE]);
      const io = quiet();
      assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS], io), 0, io.err.join('\n'));
      const text = io.out.join('\n');
      assert.doesNotMatch(text, /ADD coverage-check/, `an unrunnable cmd must not unlock the checker: ${JSON.stringify(cmd)}`);
      assert.match(text, /WARNING: the canonical coverage-check gate was NOT added/, 'and the withhold is stated');
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a marker on a DUPLICATE canonical checker never produces for the other — nor claims capability', () => {
    // `--final` accepts exactly ONE canonical checker, and a checker cannot write the lcov it reads.
    // Excluding only the LAST checker row from the producer search let a marker on the first one pair
    // with the second, and the preview then called the result final-run-capable over a declaration
    // --final rejects outright, with nothing writing the file.
    const root = mkProject([{ ...CHECKER, id: 'coverage-check', lcovProducer: true }, REVIEW_STATE, { ...CHECKER, id: 'coverage-check-2' }]);
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS], io), 0, io.err.join('\n'));
    const text = io.out.join('\n');
    assert.doesNotMatch(text, /already final-run-capable/, 'two checkers are never a final-run-capable result');
    assert.match(text, /2 declared gates are the canonical coverage checker/, 'the duplication is NAMED');
    assert.match(text, /INERT/, 'and the pair is still reported inert — nothing writes the lcov');
    rmSync(root, { recursive: true, force: true });
  });

  it('the tool-claim twin RUNS in this module — three outcomes, fail-closed on the unresolvable', () => {
    // The text drift guard (beside the kit's own copy) proves the two owners are byte-equal; it
    // cannot prove this copy WORKS, because the region is byte-equal inside a DIFFERENT host with
    // different imports. Executing it here is what proves the twin resolves everything it uses.
    const canonical = join(KIT_TOOLS, 'coverage-check.mjs');
    const root = mkProject([]);
    try {
      const elsewhere = join(root, 'vendor-coverage-check.mjs');
      writeFileSync(elsewhere, '// a vendored copy\n');
      const tool = checkerClaimTool('coverage-check.mjs', canonical);
      assert.equal(classifyCheckerClaim(tool, `node "${canonical}" --check`, KIT_TOOLS), CHECKER_CLAIM.CANONICAL);
      const vendored = checkerClaimTool('vendor-coverage-check.mjs', canonical);
      assert.equal(classifyCheckerClaim(vendored, `node "${elsewhere}" --check`, KIT_TOOLS), CHECKER_CLAIM.ELSEWHERE);
      assert.equal(classifyCheckerClaim(tool, `node "${canonical}" --check || true`, KIT_TOOLS), CHECKER_CLAIM.NOT_THE_TOOL, 'a masked form is no claim');
      assert.equal(classifyCheckerClaim(tool, `node "${join(KIT_TOOLS, 'nowhere', 'coverage-check.mjs')}" --check`, KIT_TOOLS), CHECKER_CLAIM.NOT_THE_TOOL, 'unresolvable fails closed');
      assert.equal(classifyCheckerClaim(tool, 'node $(pwd)/coverage-check.mjs --check', KIT_TOOLS), CHECKER_CLAIM.NOT_THE_TOOL, 'a shell-active bare token is no claim');
    } finally {
      rmSync(root, { recursive: true, force: true }); // every other case here cleans up; this one held its root only for a path
    }
  });

  it('a VENDORED deployment previews at exit 0 and its --apply writes ZERO bytes', () => {
    // The upgrade path this fixes: every preview AND every apply over a deployment that declared the
    // checker through its own vendored copy used to exit 1 on an id collision, so such a deployment
    // could not be upgraded at all.
    const vendoredTools = mkdtempSync(join(tmpdir(), 'migrate-branches-vendored-'));
    writeFileSync(join(vendoredTools, 'coverage-check.mjs'), '// a vendored copy of the checker\n');
    const vendored = { id: 'coverage-check', title: 'CC', cmd: `node "${join(vendoredTools, 'coverage-check.mjs')}" --check` };
    const root = mkProject([UNIT_DONE, REVIEW_STATE, vendored]);
    const before = readFileSync(join(root, 'docs', 'ai', 'gates.json'), 'utf8');

    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS], io), 0, io.err.join('\n'));
    const preview = io.out.join('\n');
    assert.match(preview, /VERIFY \(preserved exactly as declared\): coverage-check/);
    assert.doesNotMatch(preview, /ADD coverage-check/, 'nothing is added over a checker that is already declared');
    assert.doesNotMatch(io.err.join('\n'), /id collision/, 'a vendored copy is not a squatter');

    const io2 = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply'], io2), 0, io2.err.join('\n'));
    assert.equal(readFileSync(join(root, 'docs', 'ai', 'gates.json'), 'utf8'), before, 'the apply is a ZERO-DIFF write');
    assert.match(io2.out.join('\n'), /NOT final-run-capable/, 'and the withheld claim survives the no-op apply');
    rmSync(vendoredTools, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('a vendored copy named by a RELATIVE path resolves against the PROJECT root, as the runner resolves it', () => {
    const root = mkProject([UNIT_DONE, REVIEW_STATE, { id: 'coverage-check', title: 'CC', cmd: 'node "vendor/coverage-check.mjs" --check' }]);
    mkdirSync(join(root, 'vendor'), { recursive: true });
    writeFileSync(join(root, 'vendor', 'coverage-check.mjs'), '// a vendored copy inside the project\n');
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS], io), 0, io.err.join('\n'));
    assert.match(io.out.join('\n'), /VERIFY \(preserved exactly as declared\): coverage-check/, 'a relative token is resolved, not dismissed');
    rmSync(root, { recursive: true, force: true });
  });

  it('an un-unlinkable retired store is reported LOUDLY and never fails the migration', () => {
    const root = mkProject([LEGACY, UNIT]);
    spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
    // A DIRECTORY at the store path: existsSync sees it, unlink refuses (EISDIR/EPERM) — the
    // deterministic un-unlinkable shape (permission bits vary by runner; a dir does not).
    mkdirSync(join(root, '.git', RETIRED_STORE_BASENAMES[0]), { recursive: true });
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply'], io), 0);
    const text = io.out.join('\n');
    assert.match(text, /could not clean .*review-ledger\.jsonl/, 'the cleanup failure is named');
    assert.match(text, /migrated .*gates\.json/, 'the migration itself still landed');
    rmSync(root, { recursive: true, force: true });
  });
});
