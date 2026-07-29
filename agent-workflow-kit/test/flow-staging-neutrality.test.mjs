// #67 characterization, no production edit: staging a tracked modification cannot move the
// fingerprint (the payload concatenates staged+unstaged; the untracked counterexample keeps the
// claim narrow), and a flow-store append never moves it — the store lives outside the review domain.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeTreeFingerprint } from '../tools/core-evidence.mjs';
import { appendFlowRecord, resolveFlowStorePath, readFlowStore } from '../tools/flow-store.mjs';
import { FLOW_SCHEMA_VERSION } from '../tools/flow-record.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-flow-neutrality-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

let seq = 0;
const makeRepo = () => {
  const root = join(TMP, `repo-${seq += 1}`);
  mkdirSync(root, { recursive: true });
  sh(['init', '-q', '-b', 'main'], root);
  sh(['config', 'user.email', 'coder-tools@proton.me'], root);
  sh(['config', 'user.name', 'coder-tool'], root);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  sh(['add', '-A'], root);
  sh(['commit', '-q', '-m', 'init'], root);
  return root;
};

const BASE = 'ad'.repeat(20);
const FP = 'a1'.repeat(32);
const rerunCause = (attempt) => ({
  schema: FLOW_SCHEMA_VERSION, kind: 'rerun-cause', fingerprint: FP,
  cause: 'flaky fixture confirmed', attempt, base: BASE, timestamp: '2026-07-29T00:00:00.000Z',
});

describe('flow staging neutrality (#67) — frozen-domain characterization', () => {
  it('staging a lone tracked modification leaves the fingerprint UNCHANGED (otherwise-empty index)', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'base.txt'), 'tracked modification\n');
    const before = computeTreeFingerprint(root);
    sh(['add', 'base.txt'], root);
    const after_ = computeTreeFingerprint(root);
    assert.equal(after_, before, 'the staged+unstaged concatenation cannot see a tracked hunk move into the index');
  });

  it('staging an UNTRACKED file MOVES the fingerprint — the counterexample pinning the narrow claim', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'fresh.mjs'), 'export const f = 1;\n');
    const before = computeTreeFingerprint(root);
    sh(['add', 'fresh.mjs'], root);
    const after_ = computeTreeFingerprint(root);
    assert.notEqual(after_, before, 'an untracked file becoming a staged addition changes the payload class — the neutrality claim stays THIS narrow');
  });

  it('a flow-store append moves NO fingerprint — main tree and linked worktree (the store is outside the review domain)', () => {
    const root = makeRepo();
    const wt = join(TMP, `wt-${seq += 1}`);
    sh(['worktree', 'add', '-q', wt], root);
    writeFileSync(join(root, 'base.txt'), 'mid-review dirt\n');
    const mainBefore = computeTreeFingerprint(root);
    const linkedBefore = computeTreeFingerprint(wt);
    appendFlowRecord({ cwd: root, record: rerunCause('from-main'), env: {} });
    appendFlowRecord({ cwd: wt, record: rerunCause('from-linked'), env: {} });
    assert.equal(computeTreeFingerprint(root), mainBefore, 'a main-tree flow write must not move the main fingerprint');
    assert.equal(computeTreeFingerprint(wt), linkedBefore, 'a linked-worktree flow write must not move either fingerprint');
    assert.equal(readFlowStore(resolveFlowStorePath(root, {})).records.length, 2, 'both writes landed in the one common-dir store');
  });
});
