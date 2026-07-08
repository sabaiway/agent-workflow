// Spec for fold-completeness-run --preflight (BUGFREE-3, AD-049): the cheap pass surfaces actions to
// record BEFORE the expensive coverage pass, but spawns no suite, runs no probe, and writes nothing.
// The no-spawn invariant is proven by a suite command that leaves a sentinel file iff it runs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runPreflight, main } from './fold-completeness-run.mjs';

const ID = 'x.test.mjs#p';
const C1 = "import { test } from 'node:test';\ntest('p', () => {});\n// a\n// b\n";
const sha = (s) => createHash('sha256').update(Buffer.from(s)).digest('hex');

let BASE = null;
const envFor = (root) => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AW_')) delete env[k];
  return { ...env, AW_FOLD_RESULTS: join(root, '.git', 'fc.jsonl'), AW_REVIEW_LEDGER: join(root, '.git', 'rl.jsonl') };
};

// Repo with a COMMITTED bound test x.test.mjs (removal trips tamper, append does not) and a fixable-bug
// triage bound in the review ledger. `dirty` mutates the file post-commit; `receiptHash` seeds a red
// receipt; `suiteCmd` is the gates.json unit-tests cmd (default writes the no-spawn sentinel).
const makeRepo = ({ dirty = null, receiptHash = null, suiteCmd = 'touch ' + 'ran-suite.sentinel' } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'preflight-'));
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'p@e');
  g('config', 'user.name', 'p');
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'x.test.mjs'), C1);
  writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [{ id: 'unit-tests', title: 't', cmd: suiteCmd }] }));
  writeFileSync(join(root, 'docs', 'plans', 'queue.md'), '# queue\n');
  writeFileSync(join(root, 'docs', 'plans', 'demo-plan.md'), '# demo\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  BASE = g('rev-parse', 'HEAD').stdout.trim();
  if (dirty != null) writeFileSync(join(root, 'x.test.mjs'), dirty);
  writeFileSync(join(root, '.git', 'rl.jsonl'), `${JSON.stringify({ schema: 4, loop: 'demo-plan', activity: 'plan-execution', kind: 'triage', round: 1, base: BASE, fingerprint: 'b'.repeat(64), classifications: [{ findingKey: 'k', class: 'fixable-bug', accepted: false, testId: ID, note: '' }], timestamp: 't' })}\n`);
  if (receiptHash) {
    writeFileSync(join(root, '.git', 'fc.jsonl'), `${JSON.stringify({ schema: 4, kind: 'red-probe', loop: 'demo-plan', base: BASE, testId: ID, fileHash: receiptHash, runs: 3, reds: 3, fingerprint: 'a'.repeat(64), timestamp: 't' })}\n`);
  }
  return { root };
};
const done = (root) => rmSync(root, { recursive: true, force: true });

describe('--preflight — routes the needed action by kind', () => {
  it('bound testId with no red receipt → one `red` action', () => {
    const { root } = makeRepo();
    const { actions } = runPreflight({ cwd: root, env: envFor(root) });
    done(root);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].kind, 'red');
    assert.match(actions[0].command, /--red/);
    assert.match(actions[0].note, /red-proof/);
  });

  it('tampered bound test file (trailing lines removed) → an `oracle-change` action on that file', () => {
    const { root } = makeRepo({ dirty: "import { test } from 'node:test';\ntest('p', () => {});\n", receiptHash: sha(C1) });
    const { actions } = runPreflight({ cwd: root, env: envFor(root) });
    done(root);
    const oracle = actions.find((a) => a.kind === 'oracle-change');
    assert.ok(oracle, `expected an oracle-change action, got ${JSON.stringify(actions)}`);
    assert.equal(oracle.file, 'x.test.mjs');
    assert.match(oracle.command, /oracle-change/);
  });

  it('green-only append (hash changed, not tampered) with a prior receipt → one `reattest` action', () => {
    const appended = C1 + "test('q', () => {});\n";
    const { root } = makeRepo({ dirty: appended, receiptHash: sha(C1) });
    const { actions } = runPreflight({ cwd: root, env: envFor(root) });
    done(root);
    assert.equal(actions.length, 1, JSON.stringify(actions));
    assert.equal(actions[0].kind, 'reattest');
    assert.match(actions[0].command, /--reattest/);
  });

  it('matching custody hash + no tamper → no actions (all-clear)', () => {
    const { root } = makeRepo({ receiptHash: sha(C1) });
    const { actions } = runPreflight({ cwd: root, env: envFor(root) });
    done(root);
    assert.deepEqual(actions, []);
  });

  it('malformed fold ledger → throws (fail-closed, never a false all-clear)', () => {
    const { root } = makeRepo({ receiptHash: sha(C1) });
    appendFileSync(join(root, '.git', 'fc.jsonl'), '{ corrupt json line\n');
    assert.throws(() => runPreflight({ cwd: root, env: envFor(root) }), /malformed|failing closed/i);
    done(root);
  });

  it('malformed review ledger → throws (fail-closed over a corrupt bound set)', () => {
    const { root } = makeRepo({ receiptHash: sha(C1) });
    appendFileSync(join(root, '.git', 'rl.jsonl'), '{ corrupt json line\n');
    assert.throws(() => runPreflight({ cwd: root, env: envFor(root) }), /malformed|failing closed/i);
    done(root);
  });
});

describe('--preflight — a tampered bound file still surfaces its per-testId custody action', () => {
  // decideCheck (fold-completeness.mjs) enforces the observed-red + custody chain for EVERY bound
  // testId; an oracle-change override only lifts the separate tamper guard. So a tampered bound file
  // must surface BOTH oracle-change (tamper) AND the per-testId custody action — else preflight gives a
  // false all-clear and the expensive coverage pass fails at --check on "custody broken".
  it('tampered file with a broken-custody bound testId → BOTH oracle-change AND a `red` action', () => {
    const { root } = makeRepo({ dirty: "import { test } from 'node:test';\ntest('p', () => {});\n", receiptHash: sha(C1) });
    const { actions } = runPreflight({ cwd: root, env: envFor(root) });
    done(root);
    const oracle = actions.find((a) => a.kind === 'oracle-change' && a.file === 'x.test.mjs');
    const red = actions.find((a) => a.kind === 'red' && a.testId === ID);
    assert.ok(oracle, `expected an oracle-change action, got ${JSON.stringify(actions)}`);
    assert.ok(red, `expected a red action for the tampered bound testId, got ${JSON.stringify(actions)}`);
    // a tampered (modified) file is a real edit, not a green-only append → --reattest cannot anchor it.
    assert.equal(actions.some((a) => a.kind === 'reattest'), false, 'a tampered file cannot be re-anchored by --reattest');
    assert.match(red.note, /modif|re-observe|tamper/i);
  });

  it('tampered file with a MISSING receipt → a `red` action carrying the tampered note', () => {
    const { root } = makeRepo({ dirty: "import { test } from 'node:test';\ntest('p', () => {});\n" }); // tampered, no receipt
    const { actions } = runPreflight({ cwd: root, env: envFor(root) });
    done(root);
    const red = actions.find((a) => a.kind === 'red' && a.testId === ID);
    assert.ok(red, `expected a red action, got ${JSON.stringify(actions)}`);
    assert.match(red.note, /tampered|modified/i);
  });
});

describe('--preflight — reattest actions are de-duplicated per file', () => {
  it('two green-only-appended bound testIds in ONE file → a single reattest action', () => {
    const root = mkdtempSync(join(tmpdir(), 'preflight-dedup-'));
    const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 'p@e');
    g('config', 'user.name', 'p');
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    const src = "import { test } from 'node:test';\ntest('p', () => {});\ntest('q', () => {});\n";
    writeFileSync(join(root, 'y.test.mjs'), src);
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [{ id: 'unit-tests', title: 't', cmd: 'true' }] }));
    writeFileSync(join(root, 'docs', 'plans', 'queue.md'), '# queue\n');
    writeFileSync(join(root, 'docs', 'plans', 'demo-plan.md'), '# demo\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    const base = g('rev-parse', 'HEAD').stdout.trim();
    writeFileSync(join(root, 'y.test.mjs'), src + "test('r', () => {});\n"); // green-only append (hash changes, no tamper)
    const oldHash = sha(src);
    const idP = 'y.test.mjs#p';
    const idQ = 'y.test.mjs#q';
    writeFileSync(
      join(root, '.git', 'rl.jsonl'),
      `${JSON.stringify({ schema: 4, loop: 'demo-plan', activity: 'plan-execution', kind: 'triage', round: 1, base, fingerprint: 'b'.repeat(64), classifications: [{ findingKey: 'k1', class: 'fixable-bug', accepted: false, testId: idP, note: '' }, { findingKey: 'k2', class: 'fixable-bug', accepted: false, testId: idQ, note: '' }], timestamp: 't' })}\n`,
    );
    writeFileSync(
      join(root, '.git', 'fc.jsonl'),
      `${JSON.stringify({ schema: 4, kind: 'red-probe', loop: 'demo-plan', base, testId: idP, fileHash: oldHash, runs: 3, reds: 3, fingerprint: 'a'.repeat(64), timestamp: 't' })}\n` +
        `${JSON.stringify({ schema: 4, kind: 'red-probe', loop: 'demo-plan', base, testId: idQ, fileHash: oldHash, runs: 3, reds: 3, fingerprint: 'a'.repeat(64), timestamp: 't' })}\n`,
    );
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('AW_')) delete env[k];
    const { actions } = runPreflight({ cwd: root, env: { ...env, AW_FOLD_RESULTS: join(root, '.git', 'fc.jsonl'), AW_REVIEW_LEDGER: join(root, '.git', 'rl.jsonl') } });
    rmSync(root, { recursive: true, force: true });
    const reattests = actions.filter((a) => a.kind === 'reattest');
    assert.equal(reattests.length, 1, `expected ONE reattest for the file, got ${JSON.stringify(actions)}`);
    assert.equal(reattests[0].file, 'y.test.mjs');
  });
});

describe('--preflight — a deleted/unresolvable bound file surfaces a hard blocker, not a silent all-clear', () => {
  // decideCheck fails `unresolvable` UNCONDITIONALLY (before the red-proof / oracle-change lanes), so a
  // bound file that no longer resolves must surface a blocker — never a silent all-clear, never a reattest.
  it('deleted bound file WITH a prior receipt → an `unresolvable` blocker, never reattest, note says no override rescues it', () => {
    const { root } = makeRepo({ receiptHash: sha(C1) });
    rmSync(join(root, 'x.test.mjs'), { force: true }); // delete the committed bound test file
    const { actions } = runPreflight({ cwd: root, env: envFor(root) });
    done(root);
    const unresolvable = actions.find((a) => a.kind === 'unresolvable' && a.testId === ID);
    assert.ok(unresolvable, `expected an unresolvable blocker, got ${JSON.stringify(actions)}`);
    assert.equal(unresolvable.file, 'x.test.mjs');
    assert.match(unresolvable.note, /restore|re-triage/i);
    assert.match(unresolvable.note, /no override|oracle-change|red-proof|re-attest/i);
    assert.equal(actions.some((a) => a.kind === 'reattest'), false, 'a missing file is never re-attestable');
  });

  it('deleted bound file with NO receipt → the `unresolvable` blocker, NOT a bare `red` against a missing file', () => {
    const { root } = makeRepo();
    rmSync(join(root, 'x.test.mjs'), { force: true });
    const { actions } = runPreflight({ cwd: root, env: envFor(root) });
    done(root);
    assert.ok(actions.some((a) => a.kind === 'unresolvable' && a.testId === ID), `expected an unresolvable blocker, got ${JSON.stringify(actions)}`);
    assert.equal(actions.some((a) => a.kind === 'red'), false, 'a missing file must not read as a plain observe-red action');
  });
});

describe('--preflight — red-proof is checked AFTER unresolvable (mirrors decideCheck order)', () => {
  // decideCheck fails `unresolvable` (probeVerdict) BEFORE the red-proof `continue`; preflight must match,
  // else a red-proof'd deleted bound file reads clear here yet fails at --check.
  const redProof = (root) =>
    appendFileSync(join(root, '.git', 'rl.jsonl'), `${JSON.stringify({ schema: 4, loop: 'demo-plan', activity: 'plan-execution', kind: 'override', round: 1, base: BASE, scope: 'red-proof', testId: ID, reason: 'x', fingerprint: 'b'.repeat(64), timestamp: 't' })}\n`);

  it('red-proof + DELETED bound file → an `unresolvable` blocker (red-proof does NOT mask a missing file)', () => {
    const { root } = makeRepo({ receiptHash: sha(C1) });
    redProof(root);
    rmSync(join(root, 'x.test.mjs'), { force: true });
    const { actions } = runPreflight({ cwd: root, env: envFor(root) });
    done(root);
    assert.ok(actions.some((a) => a.kind === 'unresolvable' && a.testId === ID), `red-proof must not suppress an unresolvable deleted file, got ${JSON.stringify(actions)}`);
  });

  it('red-proof + RESOLVED file (custody delta) → no action (red-proof suppresses receipt/custody once the file resolves)', () => {
    const { root } = makeRepo({ dirty: C1 + "test('q', () => {});\n", receiptHash: sha(C1) });
    redProof(root);
    const { actions } = runPreflight({ cwd: root, env: envFor(root) });
    done(root);
    assert.equal(actions.some((a) => a.testId === ID), false, `red-proof suppresses receipt/custody for a resolvable file, got ${JSON.stringify(actions)}`);
  });
});

describe('--preflight — the reattest recommendation carries the additions-only weakening caveat', () => {
  it('a `reattest` action warns that an in-body insertion must re-observe red instead (not blithe re-anchor)', () => {
    const { root } = makeRepo({ dirty: C1 + "test('q', () => {});\n", receiptHash: sha(C1) });
    const { actions } = runPreflight({ cwd: root, env: envFor(root) });
    done(root);
    const reattest = actions.find((a) => a.kind === 'reattest');
    assert.ok(reattest, JSON.stringify(actions));
    assert.match(reattest.note, /append/i);
    assert.match(reattest.note, /--red/); // the caveat routes an in-body insertion to re-observe red
  });
});

describe('--preflight — no suite spawn, no probe, writes nothing', () => {
  it('never fires the suite cmd (no sentinel) and leaves the fold ledger unchanged', () => {
    const { root } = makeRepo({ dirty: C1 + "test('q', () => {});\n", receiptHash: sha(C1) });
    const fcBefore = readFileSync(join(root, '.git', 'fc.jsonl'), 'utf8');
    const r = main(['--preflight'], { cwd: root, env: envFor(root) });
    const sentinel = existsSync(join(root, 'ran-suite.sentinel'));
    const fcAfter = readFileSync(join(root, '.git', 'fc.jsonl'), 'utf8');
    done(root);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(sentinel, false, 'the suite command must NEVER run during --preflight');
    assert.equal(fcAfter, fcBefore, '--preflight writes nothing to the result ledger');
    assert.match(r.stdout, /preflight/);
    assert.match(r.stdout, /suite was NOT run/i);
  });

  it('all-clear preflight also spawns no suite', () => {
    const { root } = makeRepo({ receiptHash: sha(C1) });
    main(['--preflight'], { cwd: root, env: envFor(root) });
    const sentinel = existsSync(join(root, 'ran-suite.sentinel'));
    done(root);
    assert.equal(sentinel, false);
  });

  it('renders an `unresolvable` blocker and a `red` action via the CLI (no crash on a command-less action)', () => {
    const del = makeRepo({ receiptHash: sha(C1) });
    rmSync(join(del.root, 'x.test.mjs'), { force: true }); // deleted → unresolvable (command-less action)
    const rDel = main(['--preflight'], { cwd: del.root, env: envFor(del.root) });
    done(del.root);
    assert.equal(rDel.code, 0, rDel.stderr);
    assert.match(rDel.stdout, /unresolvable bound file/);

    const noReceipt = makeRepo(); // no receipt → a `red` action head is rendered
    const rRed = main(['--preflight'], { cwd: noReceipt.root, env: envFor(noReceipt.root) });
    done(noReceipt.root);
    assert.match(rRed.stdout, /observe red for/);
  });
});
