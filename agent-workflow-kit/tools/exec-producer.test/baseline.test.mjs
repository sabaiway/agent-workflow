import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { enumerateReturnedObjects, computeReturnedDiff } from '../exec-producer.mjs';
import { HEAD_BASELINE, validateDelegationRecord } from '../dispatch-record.mjs';
import { computeBasePayload, computeBaseFingerprint } from '../dispatch-baseline.mjs';
import { computeFingerprintPayload, computeTreeFingerprint } from '../core-evidence.mjs';
import { uncommittedStateFingerprint, DELEGATION_STORE_STOP } from '../dispatch-store.mjs';
import { delegationSemanticPreflight } from '../dispatch-store-read.mjs';
import { buildRegistration, buildDispatch, buildReturn } from '../delegation-harness.test.mjs';
import { hermeticGitEnv } from '../git-env.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-producer-baseline-'));
const ENV = hermeticGitEnv(process.env, TMP);
const IO = { env: ENV };
const BASE_OID = 'a'.repeat(40);
const OTHER_OID = 'b'.repeat(40);
const CHECKPOINT = { kind: 'checkpoint', treeOid: BASE_OID };
after(() => rmSync(TMP, { recursive: true, force: true }));
const sh = (args, cwd, env = ENV) => {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trimEnd();
};
const put = (root, path, bytes) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
};
const makeRepo = ({ unborn = false } = {}) => {
  const root = mkdtempSync(join(TMP, 'repo-'));
  sh(['init', '-q', '-b', 'main'], root);
  sh(['config', 'user.name', 'coder-tool'], root);
  sh(['config', 'user.email', 'coder-tools@proton.me'], root);
  put(root, 'base.txt', 'base\n');
  if (!unborn) {
    sh(['add', '-A'], root);
    sh(['commit', '-q', '-m', 'init'], root);
  }
  return root;
};
const snapshot = (root) => {
  const directory = mkdtempSync(join(TMP, 'index-'));
  const env = { ...ENV, GIT_INDEX_FILE: join(directory, 'index') };
  try {
    sh(['add', '-A'], root, env);
    return { kind: 'checkpoint', treeOid: sh(['write-tree'], root, env) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
const entriesOf = (root, base) => {
  const result = enumerateReturnedObjects(root, { ...IO, base });
  assert.equal(result.ok, true, result.reason);
  return result.entries;
};
const diffOf = (root, base) => {
  const result = computeReturnedDiff(root, { ...IO, base });
  assert.equal(result.ok, true, result.reason);
  return result.diff;
};

describe('exec-producer base-relative walk — spec:dispatch-baseline/S4', () => {
  it('enumerates a gitlink that differs from the base while an ignore-submodules setting hides it', () => {
    const root = makeRepo();
    const sub = join(root, 'sub');
    mkdirSync(sub);
    sh(['init', '-q', '-b', 'main'], sub);
    sh(['config', 'user.name', 'coder-tool'], sub);
    sh(['config', 'user.email', 'coder-tools@proton.me'], sub);
    put(sub, 'f.txt', 'one\n');
    sh(['add', 'f.txt'], sub);
    sh(['commit', '-q', '-m', 'A'], sub);
    sh(['add', 'sub'], root);
    sh(['commit', '-q', '-m', 'base'], root);
    const base = { kind: 'checkpoint', treeOid: sh(['rev-parse', 'HEAD^{tree}'], root) };
    put(sub, 'f.txt', 'two\n');
    sh(['commit', '-q', '-am', 'B'], sub);
    sh(['add', 'sub'], root);
    sh(['commit', '-q', '-m', 'head'], root);
    sh(['config', 'diff.ignoreSubmodules', 'all'], root);
    const entries = entriesOf(root, base);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'submodule');
    assert.equal(entries[0].path, 'sub');
  });
  it('does not enumerate an unchanged snapshot file untracked at HEAD and sizes its modification from the base blob', () => {
    const root = makeRepo();
    put(root, 'snapshot.txt', 'snapshot content\n');
    const base = snapshot(root);
    assert.equal(sh(['ls-files', '--', 'snapshot.txt'], root), '');
    assert.deepEqual(entriesOf(root, base), []);
    put(root, 'snapshot.txt', 'edited\n');
    assert.deepEqual(entriesOf(root, base), [{
      kind: 'modified', path: 'snapshot.txt', objectId: 'pre:snapshot.txt', preImageBytes: Buffer.byteLength('snapshot content\n'),
    }]);
    assert.match(diffOf(root, base).toString(), /-snapshot content\n\+edited/);
  });
  it('enumerates a deleted snapshot path with its base pre-image', () => {
    const root = makeRepo();
    put(root, 'gone.txt', 'deleted content\n');
    const base = snapshot(root);
    rmSync(join(root, 'gone.txt'));
    assert.deepEqual(entriesOf(root, base), [{
      kind: 'deleted', path: 'gone.txt', objectId: 'pre:gone.txt', preImageBytes: Buffer.byteLength('deleted content\n'),
    }]);
  });
  it('enumerates a file created after the snapshot from its stored post-image', () => {
    const root = makeRepo();
    const base = snapshot(root);
    put(root, 'new.txt', 'new content\n');
    assert.deepEqual(entriesOf(root, base), [{
      kind: 'new', path: 'new.txt', objectId: 'new:new.txt', postImageBytes: Buffer.byteLength('new content\n'),
    }]);
  });
  it('reads the binary markers of a file created after the snapshot', () => {
    const root = makeRepo();
    const base = snapshot(root);
    const bytes = Buffer.from([0, 1, 2, 3]);
    put(root, 'new.bin', bytes);
    assert.deepEqual(entriesOf(root, base), [{ kind: 'binary', path: 'new.bin', objectId: 'new:new.bin', sizeBytes: bytes.length }]);
  });
  it('keeps explicit and default head walks byte-identical over staged, unstaged and untracked changes', () => {
    const root = makeRepo();
    put(root, 'base.txt', 'staged\n');
    sh(['add', '--', 'base.txt'], root);
    put(root, 'base.txt', 'unstaged\n');
    put(root, 'new.txt', 'untracked\n');
    const enumerated = enumerateReturnedObjects(root);
    assert.equal(enumerated.ok, true, enumerated.reason);
    assert.deepEqual(enumerateReturnedObjects(root, { base: HEAD_BASELINE }), enumerated);
    const returned = computeReturnedDiff(root);
    assert.equal(returned.ok, true, returned.reason);
    assert.deepEqual(computeReturnedDiff(root, { base: HEAD_BASELINE }), returned);
    assert.deepEqual(returned.diff, computeFingerprintPayload(root));
  });
  it('returns the leaf payload and preserves the real index', () => {
    const root = makeRepo();
    const base = snapshot(root);
    put(root, 'base.txt', 'post-snapshot content\n');
    put(root, 'new.txt', 'new content\n');
    const index = readFileSync(join(root, '.git/index'));
    assert.deepEqual(diffOf(root, base), computeBasePayload(root, base, IO));
    assert.deepEqual(readFileSync(join(root, '.git/index')), index);
  });
  it('ignores index-only changes for checkpoint while head still sees them', () => {
    const root = makeRepo();
    const base = snapshot(root);
    const beforeEntries = entriesOf(root, base);
    const beforeDiff = diffOf(root, base);
    put(root, 'base.txt', 'index-only\n');
    sh(['add', '--', 'base.txt'], root);
    put(root, 'base.txt', 'base\n');
    assert.deepEqual(entriesOf(root, base), beforeEntries);
    assert.deepEqual(diffOf(root, base), beforeDiff);
    assert.equal(entriesOf(root, HEAD_BASELINE).length, 1);
    assert.ok(diffOf(root, HEAD_BASELINE).length > 0);
  });
  it('refuses an unborn branch under both bases', () => {
    const root = makeRepo({ unborn: true });
    const base = snapshot(root);
    for (const candidate of [HEAD_BASELINE, base]) {
      for (const read of [enumerateReturnedObjects, computeReturnedDiff]) {
        const result = read(root, { ...IO, base: candidate });
        assert.equal(result.ok, false);
        assert.match(result.reason, /unborn/);
      }
    }
  });
  it('refuses a non-tree base and failed raw or binary reads without throwing', () => {
    const root = makeRepo();
    const base = snapshot(root);
    const invalid = { kind: 'checkpoint', treeOid: sh(['rev-parse', 'HEAD'], root) };
    for (const read of [enumerateReturnedObjects, computeReturnedDiff]) {
      assert.match(read(root, { ...IO, base: invalid }).reason, /base-relative change set/);
    }
    for (const flag of ['--raw', '--numstat']) {
      const result = enumerateReturnedObjects(root, { ...IO, base, runGit: (args, cwd, input, env) => {
        if (args.includes(flag)) throw new Error('injected git failure');
        return spawnSync('git', args, { cwd, input, env });
      } });
      assert.equal(result.ok, false);
      assert.match(result.reason, flag === '--raw' ? /base-relative change set/ : /numstat binary markers/);
    }
  });
});

describe('dispatch-store base routing and retry equality', () => {
  it('routes the store fingerprint through the checkpoint leaf and retains head defaults', () => {
    const root = mkdtempSync(join(TMP, 'injected-'));
    mkdirSync(join(root, '.git'));
    const io = { ...IO, runGit: (args) => {
      const stdout = args[0] === 'rev-parse'
        ? (args[1] === '--show-toplevel' ? root : args.includes('HEAD') ? BASE_OID : join(root, '.git')) + '\n'
        : args[0] === 'cat-file' ? 'tree\n'
          : args[0] === 'diff' ? (args.includes(BASE_OID) ? 'checkpoint payload' : 'head payload') : '';
      return { status: 0, stdout: Buffer.from(stdout) };
    } };
    const expected = createHash('sha256').update('checkpoint payload').digest('hex');
    assert.equal(uncommittedStateFingerprint(root, io, CHECKPOINT), expected);
    assert.equal(uncommittedStateFingerprint(root, io, CHECKPOINT), computeBaseFingerprint(root, CHECKPOINT, io));
    assert.equal(uncommittedStateFingerprint(root, io), computeTreeFingerprint(root, io));
    assert.equal(uncommittedStateFingerprint(root, io, HEAD_BASELINE), computeTreeFingerprint(root, io));
  });
  it('refuses a null fingerprint with the same STOP under either base', () => {
    const io = { ...IO, runGit: () => { throw new Error('unavailable'); } };
    for (const base of [HEAD_BASELINE, CHECKPOINT]) {
      assert.throws(() => uncommittedStateFingerprint(TMP, io, base), { code: DELEGATION_STORE_STOP });
    }
  });
  const retryFacts = (originBase, retryBase) => {
    const origin = buildDispatch({ ...(originBase === undefined ? {} : { baseline: originBase }) });
    const returned = buildReturn(origin, { outcome: 'transport-failure', exitStatus: 1 });
    const retry = buildDispatch({ nonce: 'retry', retryOf: origin.nonce, retryIndex: 1,
      ...(retryBase === undefined ? {} : { baseline: retryBase }) });
    const records = [buildRegistration(), origin, returned];
    for (const record of [...records, retry]) assert.deepEqual(validateDelegationRecord(record), { ok: true });
    return { records, snapshot: retry, storePath: join(TMP, 'ledger.jsonl') };
  };
  for (const [origin, retry] of [
    [HEAD_BASELINE, CHECKPOINT], [CHECKPOINT, HEAD_BASELINE],
    [CHECKPOINT, { kind: 'checkpoint', treeOid: OTHER_OID }], [undefined, CHECKPOINT],
  ]) it(`refuses retry base drift ${JSON.stringify(origin)} to ${JSON.stringify(retry)}`, () => {
    const facts = retryFacts(origin, retry);
    const before = JSON.stringify(facts);
    assert.throws(() => delegationSemanticPreflight(facts), (error) => {
      assert.equal(error.code, DELEGATION_STORE_STOP);
      assert.match(error.message, /refusing a retry: its base.*differs from its retry origin "held-1".*ONE base.*nothing was written/);
      assert.ok(error.message.includes(retry.kind));
      assert.ok(error.message.includes(String(retry.treeOid)));
      assert.ok(error.message.includes(origin?.kind ?? 'head'));
      assert.ok(error.message.includes(String(origin?.treeOid ?? null)));
      return true;
    });
    assert.equal(JSON.stringify(facts), before);
  });
  for (const [origin, retry] of [
    [HEAD_BASELINE, HEAD_BASELINE], [CHECKPOINT, CHECKPOINT], [undefined, HEAD_BASELINE],
    [HEAD_BASELINE, undefined], [undefined, undefined],
  ]) it(`accepts equal retry bases ${JSON.stringify(origin)} and ${JSON.stringify(retry)}`, () => {
    assert.doesNotThrow(() => delegationSemanticPreflight(retryFacts(origin, retry)));
  });
});
