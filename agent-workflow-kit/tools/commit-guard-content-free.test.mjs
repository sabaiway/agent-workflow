// The guard's two CONTENT-FREE lanes, in their own suite: commit-guard.test.mjs carries a recorded
// size baseline, and every fixture there stages a change before seeding, so none of them is
// content-free. A content-free fingerprint (a work tree whose payload has no bytes) states nothing
// about what a commit will carry, so it must decide NOTHING through a receipt — in either
// direction. The two lanes it splits into are told apart by the index, not by the fingerprint:
// a dirty index means real staged bytes the fingerprint domain cannot see; a clean one means the
// commit introduces no bytes at all.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { main } from './commit-guard.mjs';
import { computeTreeFingerprint, computeWorkingState } from './core-evidence.mjs';

// The literal clean-tree value, spelled out here rather than imported: a named import of the
// constant would make this suite fail to LINK against a tree that does not export it yet, and an
// unresolvable suite proves nothing about behavior. flow-check-content-free-red.test.mjs binds this
// same literal to both the exported constant and a real clean repository.
const CONTENT_FREE_FINGERPRINT = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const TMP = mkdtempSync(join(tmpdir(), 'aw-guard-content-free-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const GATES = { gates: [{ id: 'noop', title: 'noop', cmd: 'true' }] };
const sha = (text) => createHash('sha256').update(text).digest('hex');

let seq = 0;
const gitIn = (root) => (...args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

// A repo committed CLEAN: nothing staged, nothing unstaged, nothing untracked — so its fingerprint
// is the content-free value by construction, asserted here rather than assumed.
const makeCleanRepo = () => {
  const root = join(TMP, `repo-${seq += 1}`);
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  const g = gitIn(root);
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'coder-tools@proton.me');
  g('config', 'user.name', 'coder-tool');
  writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'solo' } }));
  writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify(GATES));
  writeFileSync(join(root, 'base.txt'), 'base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  assert.equal(computeTreeFingerprint(root), CONTENT_FREE_FINGERPRINT, 'the fixture must start content-free');
  return { root, g };
};

let attemptSeq = 0;
const seedFinal = (root, fingerprint, status, over = {}) => {
  attemptSeq += 1;
  const record = {
    schema: 1, kind: 'final', status, attempt: `content-free-attempt-${attemptSeq}`,
    fingerprintBefore: fingerprint, fingerprintAfter: fingerprint,
    declared: GATES.gates.map(({ id, cmd }) => ({ id, cmd })),
    results: [{ id: 'noop', ok: status === 'green', code: status === 'green' ? 0 : 1 }],
    integrityFailure: null, evidenceHashes: { redProof: sha(''), degrade: sha('') },
    lcovSha256: null, timestamp: new Date(Date.UTC(2026, 7, 18, 12, attemptSeq)).toISOString(),
    ...over,
  };
  appendFileSync(join(root, '.git', 'agent-workflow-core-evidence.jsonl'), `${JSON.stringify(record)}\n`);
};

const check = (root) => main(['--check', '--cwd', root], { env: {} });

describe('commit-guard — the CONTENT-FREE lanes', () => {
  it('a clean index with a content-free tree PASSES and attests nothing', () => {
    const { root } = makeCleanRepo();
    const out = check(root);
    assert.equal(out.code, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /attests NOTHING/);
    assert.match(out.stdout, /changes no tree content/);
    // The claim is about CORRELATION, not about a receipt being impossible: one may well exist for
    // this very moment, and nothing can prove that it is the one.
    assert.match(out.stdout, /cannot be correlated to THIS moment or base/);
  });

  it('the empty-commit lane never consults a receipt — a RED content-free final does not refuse it', () => {
    // The decisive case: content-free evidence can neither convict nor acquit. A red final at the
    // universal empty fingerprint was minted by some other clean moment, possibly at another base.
    const { root } = makeCleanRepo();
    seedFinal(root, CONTENT_FREE_FINGERPRINT, 'red');
    const out = check(root);
    assert.equal(out.code, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /attests NOTHING/);
    assert.doesNotMatch(out.stdout, /green final receipt binds this exact tree/);
  });

  it('a foreign GREEN content-free receipt never becomes an attestation either', () => {
    const { root } = makeCleanRepo();
    seedFinal(root, CONTENT_FREE_FINGERPRINT, 'green');
    const out = check(root);
    assert.equal(out.code, 0, out.stdout + out.stderr);
    assert.doesNotMatch(out.stdout, /binds this exact tree/, 'a content-free green states nothing about this commit');
  });

  it('staged content INVISIBLE to the fingerprint refuses by name and names the configuration', () => {
    // A staged gitlink hidden from `git diff`: the payload stays empty while the index carries a
    // real change. EACH ignore setting is applied as the SOLE mechanism — with both set at once
    // neither would be proven sufficient — and clearing it must return the tree to the ordinary
    // lane, which is what proves the refusal was about the hiding and nothing else.
    for (const setting of ['submodule.vendor.ignore', 'diff.ignoreSubmodules']) {
      const { root, g } = makeCleanRepo();
      const sub = join(TMP, `sub-${seq}`);
      mkdirSync(sub, { recursive: true });
      const gs = gitIn(sub);
      gs('init', '-q', '-b', 'main');
      gs('config', 'user.email', 'coder-tools@proton.me');
      gs('config', 'user.name', 'coder-tool');
      writeFileSync(join(sub, 'f.txt'), 'one\n');
      gs('add', '-A');
      gs('commit', '-qm', 'sub base');
      const add = spawnSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor'], { cwd: root, encoding: 'utf8' });
      assert.equal(add.status, 0, add.stderr);
      g('commit', '-qm', 'add submodule');
      // Move the submodule's HEAD, stage the new gitlink, then hide it from every diff.
      writeFileSync(join(sub, 'f.txt'), 'two\n');
      gs('commit', '-qam', 'sub move');
      const pull = spawnSync('git', ['-c', 'protocol.file.allow=always', 'fetch', '-q'], { cwd: join(root, 'vendor'), encoding: 'utf8' });
      assert.equal(pull.status, 0, pull.stderr);
      gitIn(join(root, 'vendor'))('checkout', '-q', 'main');
      gitIn(join(root, 'vendor'))('reset', '-q', '--hard', 'origin/main');
      g('add', 'vendor');
      g('config', setting, 'all');
      assert.equal(computeTreeFingerprint(root), CONTENT_FREE_FINGERPRINT, `${setting} alone empties the payload`);
      assert.equal(computeWorkingState(root).stagedDirty, true, 'while the index really carries the gitlink');
      const out = check(root);
      assert.equal(out.code, 1, setting);
      assert.match(out.stdout, /cannot see/);
      // Both candidate settings are named by their exact spelling, so a later edit cannot quietly
      // drop the one the operator actually set.
      assert.match(out.stdout, /submodule\.<name>\.ignore/);
      assert.match(out.stdout, /diff\.ignoreSubmodules/);
      assert.doesNotMatch(out.stdout, /git add -A/, 'the recovery is the configuration, not re-staging what is already staged');
      // Absolute, and quoted only when the path needs it — the same shellQuoteArg shape the
      // index-lag recovery prints. What matters is that no installed kit is handed a repo-relative
      // path it cannot run.
      assert.match(out.stdout, /node '?\/.*run-gates\.mjs'? --final/, 'and it names the RESOLVED tool');
      // The recovery, executed: unset the setting and the gitlink becomes visible again, so the
      // tree carries bytes and the guard falls back to the ordinary no-receipt refusal.
      g('config', '--unset', setting);
      assert.notEqual(computeTreeFingerprint(root), CONTENT_FREE_FINGERPRINT, `${setting} cleared makes the change visible`);
      const after = check(root);
      assert.equal(after.code, 1);
      assert.match(after.stdout, /no completed final-run record/, `${setting}: the ordinary lane, not the content-free one`);
    }
  });

  it('an ARMED flow plus a foreign GREEN carrying a stale flow hash still does not decide the lane', () => {
    // The D10 flow-to-final binding is the last place a content-free receipt could have decided:
    // it reads evidenceHashes.flow off the green final AT the current fingerprint and refuses when
    // the live projection differs. Here that green belongs to another clean moment and its bound
    // hash matches nothing, so binding it would refuse a commit that carries no bytes.
    const { root } = makeCleanRepo();
    const adoption = {
      schema: 1, kind: 'chain', purpose: 'adoption', planId: 'plan-a', cycle: 1, round: 0,
      commitEpoch: 0, owner: 'main', base: 'ad'.repeat(20), timestamp: '2026-08-18T00:00:00.000Z',
      stepId: null, fingerprint: CONTENT_FREE_FINGERPRINT, planLabel: 'Plan A',
      createdAt: '2026-08-18T00:00:00.000Z', planDigest: 'd1'.repeat(32),
    };
    writeFileSync(join(root, '.git', 'agent-workflow-flow.jsonl'), `${JSON.stringify(adoption)}\n`);
    seedFinal(root, CONTENT_FREE_FINGERPRINT, 'green', { evidenceHashes: { redProof: sha(''), degrade: sha(''), flow: 'ff'.repeat(32) } });
    const out = check(root);
    assert.equal(out.code, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /attests NOTHING/);
  });

  it('store HEALTH is not waived — a malformed evidence store still refuses an empty commit', () => {
    // Health is not a correlation: a store that cannot be read cannot answer the chain questions
    // either, so the empty-commit lane fails closed on it exactly like every other lane.
    const { root } = makeCleanRepo();
    appendFileSync(join(root, '.git', 'agent-workflow-core-evidence.jsonl'), 'not json at all\n');
    const out = check(root);
    assert.equal(out.code, 1);
    assert.match(out.stdout, /evidence store unavailable|malformed/);
  });

  it('a tree that carries bytes is untouched by the arm — the ordinary no-receipt refusal still fires', () => {
    const { root, g } = makeCleanRepo();
    writeFileSync(join(root, 'change.mjs'), 'export const x = 1;\n');
    g('add', '-A');
    assert.notEqual(computeTreeFingerprint(root), CONTENT_FREE_FINGERPRINT);
    const out = check(root);
    assert.equal(out.code, 1);
    assert.match(out.stdout, /no completed final-run record/);
  });
});
