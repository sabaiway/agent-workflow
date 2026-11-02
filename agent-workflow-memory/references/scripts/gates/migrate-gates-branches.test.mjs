// migrate-gates-branches.test.mjs — the refusal/no-op branch pins the main spec file leaves
// unexercised (colocated so the D3(d) changed-line check reads real executions, not intentions):
// the --help arm, the missing-declaration no-op, the invalid-shape STOP, the honest no-op split
// on final-run-capability, the mid-write parent-verification failure (fail closed + tmp cleanup),
// and the loud-but-non-fatal retired-store cleanup error.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CHECKER_CLAIM, RETIRED_STORE_BASENAMES, checkerClaimTool, classifyCheckerClaim, main } from './migrate-gates.mjs';

// Both core checks exist as real files — canonicity is a realpath anchor, so a check whose file is
// absent resolves to nothing and is no claim at all (the fail-closed answer run-gates gives too).
const KIT_TOOLS = mkdtempSync(join(tmpdir(), 'migrate-branches-kit-'));
writeFileSync(join(KIT_TOOLS, 'coverage-check.mjs'), '// the installed checker the migration points at\n');
writeFileSync(join(KIT_TOOLS, 'review-state.mjs'), '// the installed review-state check\n');

// Every project's kit folder holds the migration's own run.mjs and the reporter, the guard on every write of the
// unit-tests command (spec coverage-producer).
const TREE = dirname(dirname(fileURLToPath(import.meta.url)));
const mkProject = (gates) => {
  const root = mkdtempSync(join(tmpdir(), 'migrate-branches-'));
  for (const rel of ['run.mjs', 'test-reporter/reporter.mjs']) {
    mkdirSync(dirname(join(root, 'scripts', 'agent-workflow', rel)), { recursive: true });
    writeFileSync(join(root, 'scripts', 'agent-workflow', rel), readFileSync(join(TREE, rel)));
  }
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

const UNIT_DONE = { id: 'unit-tests', title: 'U', cmd: 'node scripts/agent-workflow/run.mjs unit-tests tools/*.test.mjs' };
const CHECKER = { id: 'coverage-check', title: 'CC', cmd: `node "${join(KIT_TOOLS, 'coverage-check.mjs')}" --check` };
const REVIEW_STATE = { id: 'review-state', title: 'RS', cmd: `node "${join(KIT_TOOLS, 'review-state.mjs')}" --check` };
const LEGACY = { id: 'review-ledger', title: 'L', cmd: 'node "/kit/tools/review-ledger.mjs" --check' };
const UNIT = { id: 'unit-tests', title: 'U', cmd: 'node --test tools/*.test.mjs' };
// A suite the closed producer world cannot express, declaring itself with the optional marker.
const MARKED_SUITE = { id: 'suite', title: 'S', cmd: 'pnpm vitest run --coverage', lcovProducer: true };
// Every checker line: one positional fact and one remedy (spec coverage-producer), as literal bytes.
const [WITHHELD_FACT, POSITIONAL_FACT] = ['no declared gate is a producer this kit reads', 'no gate before it is a producer this kit reads'];
const CHECKER_REMEDY = 'declare or move one before it: node scripts/agent-workflow/run.mjs unit-tests <your test paths>, or mark your own suite gate "lcovProducer": true';
const ADD_CHECKER = '--apply --add-checker';
const VERIFIES_NOTHING = /verif(?:y|ies|ying) nothing|certif(?:y|ies|ying) nothing/;
const factLine = (text, fact) => text.split('\n').find((line) => line.includes(fact) && line.includes(CHECKER_REMEDY));
const declaredBytes = (root) => readFileSync(join(root, 'docs', 'ai', 'gates.json'), 'utf8');
const gatesOf = (root) => JSON.parse(declaredBytes(root)).gates;
const runIn = (root, ...args) => { const io = quiet(); const code = main(['--cwd', root, '--kit-tools', KIT_TOOLS, ...args], io); return { code, out: io.out.join('\n'), err: io.err.join('\n') }; };

describe('migrate-gates — refusal and no-op branches', () => {
  it('--help prints the contract and exits 0', () => {
    const io = quiet();
    assert.equal(main(['--help'], io), 0);
    assert.match(io.out.join('\n'), /Usage:/);
  });

  it('an entry path that does not resolve reads as an import: the module loads and its CLI never runs', () => {
    const absent = join(tmpdir(), `migrate-gates-absent-${process.pid}-${Date.now()}`, 'entry.mjs');
    const probe = `const m = await import(${JSON.stringify(import.meta.resolve('./migrate-gates.mjs'))}); console.log(typeof m.main);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '--eval', probe, absent, '--help'], { encoding: 'utf8' });
    assert.equal(r.stdout, 'function\n', r.stderr);
    assert.equal(r.status, 0, r.stderr);
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
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply', '--add-checker'], io), 0, io.err.join('\n'));
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
    assert.ok(factLine(text, POSITIONAL_FACT), `the dead pair is named by its fact: ${text}`);
    assert.doesNotMatch(text, /already final-run-capable/, 'and never claimed capable');
    rmSync(root, { recursive: true, force: true });
  });

  it('a MARKED unit-tests entry is a zero-diff keep — never extended, never reported customized', () => {
    // Both arms the marker settles at once: `npm test` is a cmd this tool cannot verify (customized
    // without the marker), and rewriting a cmd whose owner declared it the producer would change
    // bytes the byte-exact hook approval binds.
    const marked = { id: 'unit-tests', title: 'U', cmd: 'npm test', lcovProducer: true };
    const root = mkProject([marked, REVIEW_STATE]);
    const before = declaredBytes(root);
    const { code, out: text, err } = runIn(root, '--apply');
    assert.equal(code, 0, err);
    assert.equal(declaredBytes(root), before, 'a zero-diff keep');
    assert.ok(text.includes(ADD_CHECKER), 'the claimed producer unlocks the checker\'s offer');
    assert.doesNotMatch(text, /EXTEND unit-tests/, 'a claimed producer cmd is never rewritten');
    assert.doesNotMatch(text, /CUSTOMIZED/, 'nor reported as a cmd the tool cannot verify');
    rmSync(root, { recursive: true, force: true });

    // The SAME entry unmarked is the customized/withheld path — the marker is what settles it.
    const bare = mkProject([{ id: 'unit-tests', title: 'U', cmd: 'npm test' }, REVIEW_STATE]);
    const r = runIn(bare, '--apply');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /CUSTOMIZED/);
    assert.ok(!r.out.includes(ADD_CHECKER) && factLine(r.out, WITHHELD_FACT), `the checker stays withheld with no producer: ${r.out}`);
    rmSync(bare, { recursive: true, force: true });
  });

  it('a marker over an UNRUNNABLE cmd never unlocks the checker — the lenient loader has no validator', () => {
    // This tool accepts any `{ gates: [...] }` shape, so an entry the strict validator would refuse
    // reaches the plan builder intact. A marker on such an entry must not make the migration ADD the
    // canonical checker: the result would be the dead pair the withhold exists to prevent, and the
    // written declaration would then fail run-gates outright.
    for (const cmd of ['   ', 'echo a\nrm -rf b']) {
      const root = mkProject([{ id: 'suite', title: 'S', cmd, lcovProducer: true }, REVIEW_STATE]);
      const { code, out: text, err } = runIn(root, '--apply', '--add-checker');
      assert.equal(code, 0, err);
      assert.ok(!gatesOf(root).some((g) => g.id === 'coverage-check') && !text.includes(ADD_CHECKER), `an unrunnable cmd must not unlock the checker: ${JSON.stringify(cmd)}`);
      assert.ok(factLine(text, WITHHELD_FACT), `and the withhold is stated: ${text}`);
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
    assert.ok(text.includes(POSITIONAL_FACT), 'and the pair is still reported inert — nothing writes the lcov');
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

const RETIRED_V2 = '--experimental-test-coverage --test-reporter=lcov --test-reporter-destination="${AW_GIT_DIR:?exported by run-gates}/agent-workflow-lcov.info" --test-reporter=spec --test-reporter-destination=stdout';
const RETIRED_GATE = { id: 'unit-tests', title: 'U', cmd: `node --test ${RETIRED_V2} tools/*.test.mjs` };
const SWITCHED = { ...RETIRED_GATE, cmd: UNIT_DONE.cmd };
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^[Gg][Ii][Tt]_/.test(key) && key !== 'NODE_TEST_CONTEXT'));
const offerLines = (text) => text.split('\n').filter((line) => line.includes(ADD_CHECKER));

describe('spec:coverage-producer/S11 --apply writes every move and no checker; the add runs on the yes', () => {
  it('over a producer and no checker --apply writes nothing and prints one offer line, which adds the checker last; a rerun of either writes nothing', () => {
    const root = mkProject([UNIT_DONE, REVIEW_STATE]);
    const before = declaredBytes(root);
    for (let upgrade = 0; upgrade < 2; upgrade += 1) { // the offer reprints on each upgrade, no decline recorded
      const r = runIn(root, '--apply');
      assert.ok(r.code === 0 && declaredBytes(root) === before && offerLines(r.out).length === 1, `no checker unasked, one offer line: ${r.out}${r.err}`);
    }
    const [offer] = offerLines(runIn(root, '--apply').out);
    const command = offer.slice(offer.indexOf('node "'), offer.indexOf(ADD_CHECKER) + ADD_CHECKER.length);
    const yes = spawnSync('bash', ['-c', command], { encoding: 'utf8', env: childEnv });
    assert.equal(yes.status, 0, `${command}\n${yes.stderr}`);
    assert.deepEqual(gatesOf(root), [UNIT_DONE, REVIEW_STATE, { ...CHECKER, title: gatesOf(root).at(-1).title }], 'the canonical checker is added last, resolved and quoted');
    const added = declaredBytes(root);
    for (const args of [['--apply'], ['--apply', '--add-checker']]) {
      const r = runIn(root, ...args);
      assert.ok(r.code === 0 && declaredBytes(root) === added && offerLines(r.out).length === 0, `${args.join(' ')}: a rerun writes nothing: ${r.out}${r.err}`);
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('a row other than a checker under the id coverage-check leaves a retired-form gate switched and withholds the add with one line, exit 0', () => {
    const squatter = { id: 'coverage-check', title: 'C', cmd: 'npm run coverage' };
    const root = mkProject([RETIRED_GATE, squatter, REVIEW_STATE]);
    for (const args of [['--apply'], ['--apply', '--add-checker']]) {
      const r = runIn(root, ...args);
      assert.equal(r.code, 0, `${args.join(' ')}: it stops no mandatory row: ${r.err}`);
      assert.deepEqual(gatesOf(root), [SWITCHED, squatter, REVIEW_STATE], args.join(' '));
      const naming = r.out.split('\n').filter((line) => line.includes('coverage-check') && !/CUSTOMIZED|recovery \(apply by hand|^\s*SWITCH\b/.test(line));
      assert.ok(naming.length === 1 && naming[0].endsWith('rename that row by hand.') && offerLines(r.out).length === 0, `${args.join(' ')}: one line names the withheld add, its one remedy, no offer: ${r.out}`);
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('with no producer the withheld line carries the fact and the remedy; --add-checker without --apply writes nothing', () => {
    const none = mkProject([{ id: 'suite', title: 'S', cmd: 'npm test' }, REVIEW_STATE]);
    for (const args of [['--apply'], ['--apply', '--add-checker']]) {
      const r = runIn(none, ...args);
      assert.ok(r.code === 0 && factLine(r.out, WITHHELD_FACT) && offerLines(r.out).length === 0, `${args.join(' ')}: ${r.out}${r.err}`);
      assert.ok(!gatesOf(none).some((g) => g.id === 'coverage-check'), 'no dead checker');
    }
    rmSync(none, { recursive: true, force: true });
    for (const gates of [[UNIT_DONE, REVIEW_STATE], [RETIRED_GATE, REVIEW_STATE]]) {
      const root = mkProject(gates);
      const before = declaredBytes(root);
      const r = runIn(root, '--add-checker');
      assert.ok(r.code === 0 && declaredBytes(root) === before, `a hand run without --apply previews and writes nothing: ${r.err}`);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('spec:coverage-producer/S12 a legacy check leaves only over a target proven absent', () => {
  // Each case: the gate, then how its target stands in the project (null: absent).
  const ledger = (token) => ({ id: 'review-ledger', title: 'L', cmd: `node ${token} --check` });
  const CASES = [
    ['an absent review-ledger target', ledger('tools/review-ledger.mjs'), null, true],
    ['an absent fold-completeness target', { id: 'fold-completeness', title: 'F', cmd: 'node "tools/fold-completeness.mjs" --check' }, null, true],
    ['a regular file', ledger('tools/review-ledger.mjs'), (root) => writeFileSync(join(root, 'tools', 'review-ledger.mjs'), '// a project file\n'), false],
    ['a fold-completeness regular file', { id: 'fold-completeness', title: 'F', cmd: 'node tools/fold-completeness.mjs --check' }, (root) => writeFileSync(join(root, 'tools', 'fold-completeness.mjs'), '// a project file\n'), false],
    ['a directory', ledger('tools/review-ledger.mjs'), (root) => mkdirSync(join(root, 'tools', 'review-ledger.mjs')), false],
    ['a link to a file', ledger('tools/review-ledger.mjs'), (root) => { writeFileSync(join(root, 'real.mjs'), '// real\n'); symlinkSync(join(root, 'real.mjs'), join(root, 'tools', 'review-ledger.mjs')); }, false],
    ['a dangling link', ledger('tools/review-ledger.mjs'), (root) => symlinkSync(join(root, 'nowhere.mjs'), join(root, 'tools', 'review-ledger.mjs')), false],
    ['a ~ token', ledger('~/tools/review-ledger.mjs'), null, false],
    ['a $HOME token', ledger('$HOME/tools/review-ledger.mjs'), null, false],
  ];
  for (const [label, gate, place, removed] of CASES) {
    it(`${label}: ${removed ? 'removed with its was:' : 'CUSTOMIZED with its recovery and kept'}`, () => {
      const lint = { id: 'lint', title: 'L', cmd: 'npm run lint' }; // no producer: the checker's add stays out of this cell
      const root = mkProject([gate, lint, REVIEW_STATE]);
      mkdirSync(join(root, 'tools')); place?.(root);
      const r = runIn(root, '--apply');
      assert.equal(r.code, 0, r.err);
      if (removed) {
        assert.deepEqual(gatesOf(root), [lint, REVIEW_STATE]);
        const line = r.out.split('\n').find((l) => new RegExp(`\\bREMOVE ${gate.id}\\b`, 'i').test(l));
        assert.ok(line?.includes(`was: ${gate.cmd}`), `the acted row prints with its was: ${r.out}`);
      } else {
        assert.deepEqual(gatesOf(root), [gate, lint, REVIEW_STATE], 'never removed');
        assert.ok(r.out.includes(`CUSTOMIZED (untouched): ${gate.id}`) && /recovery \(apply by hand/.test(r.out), r.out);
        assert.ok(r.out.includes('a path that does not contain') && !/keep it/.test(r.out), `the recovery ends the report: ${r.out}`);
      }
      rmSync(root, { recursive: true, force: true });
    });
  }
  it('a project check moved to a path without the retired name, the gate pointed at it, reads no CUSTOMIZED on the rerun', () => {
    const own = { id: 'review-ledger', title: 'L', cmd: 'node tools/own-check.mjs --check' };
    const root = mkProject([own, REVIEW_STATE]);
    mkdirSync(join(root, 'tools')); writeFileSync(join(root, 'tools', 'own-check.mjs'), '// a project file\n');
    const r = runIn(root, '--apply');
    assert.ok(r.code === 0 && !r.out.includes('CUSTOMIZED') && !/IMPORTANT: do NOT install/.test(r.out), r.out);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('spec:coverage-producer/S13 a row claiming the checker is never a producer; the checker lines are positional', () => {
  it('a vendored checker marked lcovProducer before the canonical one leaves it inert with the fact and the remedy; the vendored twin keeps its remove remedy', () => {
    const vendored = { id: 'vendored-cov', title: 'V', cmd: 'node "vendor/coverage-check.mjs" --check', lcovProducer: true };
    const root = mkProject([vendored, REVIEW_STATE, CHECKER]);
    mkdirSync(join(root, 'vendor')); writeFileSync(join(root, 'vendor', 'coverage-check.mjs'), '// a vendored copy of the checker\n');
    const before = declaredBytes(root);
    const r = runIn(root, '--apply');
    assert.ok(r.code === 0 && declaredBytes(root) === before, r.err);
    assert.ok(factLine(r.out, POSITIONAL_FACT), `the canonical checker reads no producer: ${r.out}`);
    assert.match(r.out, /Remove THIS entry by hand/, 'the twin keeps its one remedy');
    assert.doesNotMatch(r.out, VERIFIES_NOTHING);
    rmSync(root, { recursive: true, force: true });
  });

  it('a retired-form gate after the canonical checker is switched and the checker moved last, no inert line; guard-kept, it keeps its line and the checker moves last', () => {
    const root = mkProject([CHECKER, RETIRED_GATE, REVIEW_STATE]);
    const r = runIn(root, '--apply');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(gatesOf(root), [SWITCHED, REVIEW_STATE, CHECKER]);
    assert.ok(r.out.split('\n').some((line) => /^\s*SWITCH unit-tests\b/.test(line) && line.includes(`was: ${RETIRED_GATE.cmd}`)), r.out);
    assert.ok(!r.out.includes(POSITIONAL_FACT), `no inert line: ${r.out}`);
    rmSync(root, { recursive: true, force: true });
    const kept = mkProject([CHECKER, RETIRED_GATE, REVIEW_STATE]);
    rmSync(join(kept, 'scripts', 'agent-workflow', 'run.mjs'));
    const k = runIn(kept, '--apply');
    assert.equal(k.code, 0, k.err);
    assert.deepEqual(gatesOf(kept), [RETIRED_GATE, REVIEW_STATE, CHECKER], 'the gate kept, the checker moved last');
    const line = k.out.split('\n').filter((l) => l.includes("once that is resolved, the kit's upgrade moves this gate with no question"));
    assert.ok(line.length === 1 && line[0].includes('unit-tests'), k.out);
    assert.doesNotMatch(`${r.out}\n${k.out}`, VERIFIES_NOTHING, 'no migration line says verifying nothing');
    rmSync(kept, { recursive: true, force: true });
  });
});
