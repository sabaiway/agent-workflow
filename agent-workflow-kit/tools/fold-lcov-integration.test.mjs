// Language-independence proof for BUGFREE-3 (AD-049): the same JS fixture yields the same
// uncovered-changed verdict via the V8 path and via a coverage.kind:"lcov" profile — the
// fold-completeness gate is not V8-only, any LCOV-emitting suite drives it identically.
// The fixture LCOV encodes the fixture's TRUE coverage (line 3 executed, line 5 never), so both
// paths independently flagging line 5 is a real proof, not a tautology; the gitignored lcovPath
// must leave the tree fingerprint unchanged.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runFoldCompleteness } from './fold-completeness-run.mjs';
import { computeTreeFingerprint } from './review-state.mjs';

// L1 decl · L2 if · L3 return (if-true) · L4 } · L5 return (else) · L6 }.
const LIB_V1 = "export const classify = (n) => {\n  if (n > 0) {\n    return 'pos';\n  }\n  return 'neg';\n};\n";
// Lines 3 and 5 change content → changed surface is [3, 5].
const LIB_V2 = "export const classify = (n) => {\n  if (n > 0) {\n    return 'positive';\n  }\n  return 'nonpositive';\n};\n";
const TEST_SRC = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { classify } from './lib.mjs';\ntest('classify positive', () => { assert.equal(classify(1), 'positive'); });\n";

const fixtureEnv = (root) => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AW_')) delete env[k];
  return { ...env, AW_REVIEW_LEDGER: join(root, '.git', 'rl.jsonl'), AW_FOLD_RESULTS: join(root, '.git', 'fc.jsonl') };
};

// Hermetic repo: committed base (lib V1 + test + plan + gates), then lib left dirty at V2.
const makeFixture = (profile) => {
  const root = mkdtempSync(join(tmpdir(), 'fold-lcov-'));
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'p@e.com');
  g('config', 'user.name', 'p');
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, '.fold'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.fold/\n');
  writeFileSync(join(root, 'lib.mjs'), LIB_V1);
  writeFileSync(join(root, 'lib.test.mjs'), TEST_SRC);
  writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [{ id: 'unit-tests', title: 't', cmd: 'node --test lib.test.mjs' }] }));
  writeFileSync(join(root, 'docs', 'plans', 'queue.md'), '# queue\n');
  writeFileSync(join(root, 'docs', 'plans', 'active-plan.md'), '# plan\n');
  if (profile) writeFileSync(join(root, 'docs', 'ai', 'verification-profile.json'), JSON.stringify(profile));
  g('add', '-A');
  g('commit', '-qm', 'base');
  writeFileSync(join(root, 'lib.mjs'), LIB_V2);
  return { root };
};

describe('fold-completeness LCOV path — language-independence proof', () => {
  it('V8 path flags the uncovered changed line (5), not the covered one (3)', () => {
    const { root } = makeFixture(null);
    const { record } = runFoldCompleteness({ cwd: root, env: fixtureEnv(root), suiteCmd: 'node --test lib.test.mjs' });
    const uncov = record.coverage.uncoveredChanged.filter((u) => u.file === 'lib.mjs');
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(uncov, [{ file: 'lib.mjs', line: 5 }], 'V8: only the never-executed else line is uncovered');
  });

  it('LCOV path yields the same verdict from a profile-declared, gitignored LCOV file', () => {
    const profile = { schema: 1, coverage: { kind: 'lcov', lcovPath: '.fold/lcov.info' } };
    const { root } = makeFixture(profile);
    const beforeFp = computeTreeFingerprint(root);
    // suiteCmd runs the suite and leaves an LCOV for the fixture's true coverage (line 3 executed, line 5 never).
    const suiteCmd = "node --test lib.test.mjs >/dev/null 2>&1; printf 'SF:lib.mjs\\nDA:1,1\\nDA:2,1\\nDA:3,1\\nDA:5,0\\nend_of_record\\n' > .fold/lcov.info";
    const { record } = runFoldCompleteness({ cwd: root, env: fixtureEnv(root), suiteCmd });
    const afterFp = computeTreeFingerprint(root);
    const uncov = record.coverage.uncoveredChanged.filter((u) => u.file === 'lib.mjs');
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(uncov, [{ file: 'lib.mjs', line: 5 }], 'LCOV: same verdict as V8 — line 5 uncovered, line 3 covered');
    assert.equal(beforeFp, afterFp, 'the gitignored lcovPath left the tree fingerprint unchanged');
  });

  it('a changed assessable file ABSENT from the LCOV reads as a file-level RED (line: null)', () => {
    const profile = { schema: 1, coverage: { kind: 'lcov', lcovPath: '.fold/lcov.info' } };
    const { root } = makeFixture(profile);
    writeFileSync(join(root, 'orphan.mjs'), 'export const y = 1;\n'); // changed + assessable, never in the LCOV
    const suiteCmd = "node --test lib.test.mjs >/dev/null 2>&1; printf 'SF:lib.mjs\\nDA:1,1\\nDA:2,1\\nDA:3,1\\nDA:5,0\\nend_of_record\\n' > .fold/lcov.info";
    const { record } = runFoldCompleteness({ cwd: root, env: fixtureEnv(root), suiteCmd });
    const orphan = record.coverage.uncoveredChanged.filter((u) => u.file === 'orphan.mjs');
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(orphan, [{ file: 'orphan.mjs', line: null }], 'a file the LCOV never mentions is a file-level RED');
  });

  it('LCOV profile whose suite writes no LCOV fails closed (loud STOP, never false green)', () => {
    const profile = { schema: 1, coverage: { kind: 'lcov', lcovPath: '.fold/lcov.info' } };
    const { root } = makeFixture(profile);
    assert.throws(
      () => runFoldCompleteness({ cwd: root, env: fixtureEnv(root), suiteCmd: 'true' }),
      (e) => /no LCOV file was found/.test(e.message),
    );
    rmSync(root, { recursive: true, force: true });
  });

  it('a stale lcov.info is removed pre-suite so a failed suite can never mask uncovered as green', () => {
    const profile = { schema: 1, coverage: { kind: 'lcov', lcovPath: '.fold/lcov.info' } };
    const { root } = makeFixture(profile);
    writeFileSync(join(root, '.fold', 'lcov.info'), 'SF:lib.mjs\nDA:1,1\nDA:2,1\nDA:3,1\nDA:5,1\nend_of_record\n');
    assert.throws(
      () => runFoldCompleteness({ cwd: root, env: fixtureEnv(root), suiteCmd: 'true' }),
      (e) => /no LCOV file was found/.test(e.message),
      'the stale LCOV must be removed pre-run so it can never be re-read as the current coverage',
    );
    rmSync(root, { recursive: true, force: true });
  });
});
