// suite-evidence.test.mjs — spec-first for the (a) v4 suite-execution evidence emitted by the fold
// runner (BUGFREE-3, AD-049, step 1.5). The runner records the ONE suite spawn per fingerprint as
// { cmd, exit, fingerprintBefore, fingerprintAfter } on the v4 run record: a green suite records exit
// 0, a red suite records its honest nonzero exit, and the pre/post fingerprints are equal (the suite
// left the tree unchanged — coverage went out-of-tree).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runFoldCompleteness } from './fold-completeness-run.mjs';
import { validateRunRecord } from './fold-completeness.mjs';

const envFor = (root) => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AW_')) delete env[k];
  return { ...env, AW_REVIEW_LEDGER: join(root, '.git', 'rl.jsonl'), AW_FOLD_RESULTS: join(root, '.git', 'fc.jsonl') };
};

const makeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'suite-ev-'));
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'p@e');
  g('config', 'user.name', 'p');
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'queue.md'), '# queue\n');
  writeFileSync(join(root, 'docs', 'plans', 'demo-plan.md'), '# demo\n');
  writeFileSync(join(root, 'keep.mjs'), 'export const a = 1;\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  writeFileSync(join(root, 'keep.mjs'), 'export const a = 1;\nexport const b = 2;\n'); // dirty surface
  return { root };
};
const done = (root) => rmSync(root, { recursive: true, force: true });

describe('(a) suite-execution evidence on the v4 run record', () => {
  it('a GREEN suite records { cmd, exit: 0, fingerprintBefore === fingerprintAfter }', () => {
    const { root } = makeRepo();
    const { record } = runFoldCompleteness({ cwd: root, env: envFor(root), suiteCmd: 'true' });
    done(root);
    assert.equal(record.schema, 4);
    assert.ok(record.suite, 'the v4 run carries suite evidence');
    assert.equal(record.suite.cmd, 'true');
    assert.equal(record.suite.exit, 0);
    assert.match(record.suite.fingerprintBefore, /^[0-9a-f]{64}$/);
    assert.equal(record.suite.fingerprintBefore, record.suite.fingerprintAfter, 'the suite left the tree unchanged');
    assert.equal(record.suite.fingerprintBefore, record.fingerprint, 'the suite fingerprint IS the run fingerprint (fingerprint-bound)');
    assert.equal(validateRunRecord(record).ok, true);
  });

  it('a RED suite records its honest nonzero exit (never laundered green)', () => {
    const { root } = makeRepo();
    const { record } = runFoldCompleteness({ cwd: root, env: envFor(root), suiteCmd: 'exit 3' });
    done(root);
    assert.equal(record.suite.exit, 3, 'the nonzero suite exit is recorded honestly');
    assert.equal(validateRunRecord(record).ok, true);
  });

  it('the suite cmd recorded is the resolved suite command (cmd-identity source for the credit)', () => {
    const { root } = makeRepo();
    const cmd = 'node --test keep.test.mjs';
    const { record } = runFoldCompleteness({ cwd: root, env: envFor(root), suiteCmd: cmd });
    done(root);
    assert.equal(record.suite.cmd, cmd);
  });
});
