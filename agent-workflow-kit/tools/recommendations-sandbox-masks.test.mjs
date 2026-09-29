// recommendations-sandbox-masks.test.mjs — the advisor's sandbox-masks item once the mount arm exists (spec
// kit/review-domain/sandbox-masks, S18 and S22). A mount-only mask rides git add -A and the review
// fingerprint until the managed block holds it, so a PRESENT block that lacks one is attention-class;
// every other firing stays an optional offer. A new suite: recommendations.test.mjs is over-cap debt.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WHATS, BENEFITS, SEVERITY_ATTENTION, SEVERITY_OPTIONAL } from './recommendations.mjs';
import { main, probeSandboxMasks, MASKS_FENCE_START } from './sandbox-masks.mjs';
import { git, repoFactory, line, stubs, writeFence, readExclude, adviseMasks } from './sandbox-masks-harness.test.mjs';

const freshRepo = repoFactory('recommendations-sandbox-masks', { 'docs/ai/.workflow-version': '4.0.0\n' });
const makeRepo = (...fenced) => {
  const root = freshRepo();
  if (fenced.length > 0) writeFence(root, ...fenced);
  return root;
};

// The root mount, the work tree on 8:2, and a foreign bind of /tmp/empty at each named path.
const tableWith = (root, ...foreign) => () => `${[
  line(1, 0, '8:1', '/', '/'),
  line(2, 1, '8:2', '/wt', root),
  ...foreign.map((rel, i) => line(3 + i, 2, '0:40', '/tmp/empty', `${root}/${rel}`)),
].join('\n')}\n`;
const masksItem = (root, deps) => adviseMasks(root, deps).item;

describe('recommendations — the sandbox-masks wording (spec:sandbox-masks/S18)', () => {
  it('both WHATS strings say sandbox mask(s), never device masks', () => {
    assert.equal(WHATS['sandbox-masks'], '{n} sandbox mask(s) clutter git status — the managed exclude block is absent or stale');
    assert.equal(WHATS['sandbox-masks.stale-real'], '{n} sandbox mask(s) clutter git status — the exclude block is stale; {m} fenced entr(ies) are REAL paths (a fresh apply drops them)');
  });

  it('the benefit line no longer claims the review domain ignores every mask', () => {
    assert.doesNotMatch(BENEFITS['sandbox-masks'], /ignores the masks/);
    assert.match(BENEFITS['sandbox-masks'], /^zero clutter — a mask git ignores through the block leaves git status/);
  });
});

describe('recommendations — the sandbox-masks severity rule (spec:sandbox-masks/S22)', () => {
  it('a present block lacking a mount-only mask the derivation holds is attention-class', () => {
    const root = makeRepo('.zshrc');
    const item = masksItem(root, { ...stubs({ '.bashrc': 'file' }), readMountinfo: tableWith(root, '.bashrc') });
    assert.deepEqual([item?.severity, item?.variant], [SEVERITY_ATTENTION, 'sandbox-masks.unfenced-mount']);
    assert.equal(item.what, '1 sandbox mask(s) clutter git status — the managed exclude block is absent or stale');
  });

  it('it stays attention-class when another ignore rule already hides that mask', () => {
    const root = makeRepo('.other');
    writeFileSync(join(root, '.bashrc'), '');
    writeFileSync(join(root, '.gitignore'), '/.bashrc\n');
    assert.equal(git(root, 'status', '--porcelain', '--', '.bashrc').stdout, '', '.gitignore hides it from git status already');
    const item = masksItem(root, { readMountinfo: tableWith(root, '.bashrc') });
    assert.deepEqual([item?.severity, item?.variant], [SEVERITY_ATTENTION, 'sandbox-masks.unfenced-mount']);
  });

  it('an absent block is an optional offer, the mount-only mask included', () => {
    const root = makeRepo();
    const item = masksItem(root, { ...stubs({ '.bashrc': 'file' }), readMountinfo: tableWith(root, '.bashrc') });
    assert.deepEqual([item?.severity, item?.variant], [SEVERITY_OPTIONAL, 'sandbox-masks']);
  });

  it('a present block lacking a device mask alone is an optional offer', () => {
    const root = makeRepo('.zshrc');
    const deps = { ...stubs({ '.vscode': 'char' }), readMountinfo: tableWith(root) };
    assert.deepEqual(probeSandboxMasks({ cwd: root, ...deps }).mountOnly, []);
    const item = masksItem(root, deps);
    assert.deepEqual([item?.severity, item?.variant], [SEVERITY_OPTIONAL, 'sandbox-masks']);
  });

  it('a present block holding every mount-only mask stays optional while a device mask is missing', () => {
    const root = makeRepo('.bashrc');
    const deps = { ...stubs({ '.bashrc': 'file', '.vscode': 'char' }), readMountinfo: tableWith(root, '.bashrc') };
    assert.deepEqual(probeSandboxMasks({ cwd: root, ...deps }).mountOnly, ['.bashrc']);
    const item = masksItem(root, deps);
    assert.deepEqual([item?.severity, item?.variant], [SEVERITY_OPTIONAL, 'sandbox-masks']);
  });

  it('the probe names the mount-only masks, sorted, and never a device mask', () => {
    const root = makeRepo();
    const deps = { ...stubs({ '.zshrc': 'file', '.vscode': 'char', '.bashrc': 'file' }), readMountinfo: tableWith(root, '.zshrc', '.bashrc', '.vscode') };
    const probe = probeSandboxMasks({ cwd: root, ...deps });
    assert.deepEqual([probe.masks, probe.mountOnly], [['.bashrc', '.vscode', '.zshrc'], ['.bashrc', '.zshrc']]);
  });

  it('--apply --clear never reads the table: the reader that refuses the apply leaves the clear alone', () => {
    const root = makeRepo('.bashrc');
    let calls = 0;
    const deps = {
      ...stubs({ '.bashrc': 'file' }),
      readMountinfo: () => {
        calls += 1;
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
    };
    const refused = main(['--cwd', root, '--apply'], { deps });
    assert.equal(refused.code, 1, 'the plain apply derives, so the unreadable table refuses it');
    assert.match(refused.stderr, /cannot read \/proc\/self\/mountinfo/);
    calls = 0;
    const cleared = main(['--cwd', root, '--apply', '--clear'], { deps });
    assert.equal(cleared.code, 0, cleared.stderr);
    assert.match(cleared.stdout, /managed block removed/);
    assert.ok(!readExclude(root).includes(MASKS_FENCE_START));
    assert.equal(calls, 0, 'the clear never called the reader');
  });
});
