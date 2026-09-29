// sandbox-masks-mount.test.mjs — the mount arm of the sandbox-masks predicate (spec kit/review-domain/sandbox-masks,
// S2-S4, S11, S16, S17). The mount table is injected as text through the readMountinfo seam; the lstat
// class and the untracked walk are stubbed where a real sandbox cannot be built, and real where a git
// fixture can carry the fact (S17).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { main, probeSandboxMasks, deriveMasks, revalidateFence, needsMasksApply } from './sandbox-masks.mjs';
import { computeFingerprintPayload } from './core-evidence-tree.mjs';
import { countNeverCommittableUntracked } from './review-state.mjs';
import { git, repoFactory, measured, DEVTMPFS, foreignBashrc, reader, stubs, writeFence, readExclude, adviseMasks } from './sandbox-masks-harness.test.mjs';

const makeRepo = repoFactory('sandbox-masks-mount');
const masksItem = (root, deps) => adviseMasks(root, deps).item;

describe('sandbox-masks — a foreign bind of an empty file is a mask (spec:sandbox-masks/S2)', () => {
  it('deriveMasks returns .bashrc for the injected foreign bind and an empty regular file (the acceptance red)', () => {
    const root = makeRepo();
    const derived = deriveMasks({ root, ...stubs({ '.bashrc': 'file' }), readMountinfo: reader(foreignBashrc(root)) });
    assert.deepEqual(derived.masks, ['.bashrc']);
  });

  it('a fenced /.bashrc under the same injection is not stale-real', () => {
    const root = makeRepo();
    const stale = revalidateFence(['/.bashrc'], { root, lstat: stubs({ '.bashrc': 'file' }).lstat, readMountinfo: reader(foreignBashrc(root)) });
    assert.deepEqual(stale, []);
  });
});

describe('sandbox-masks — a self bind in the measured shape is no mask (spec:sandbox-masks/S3)', () => {
  // The measured lines: the root mount, the work tree's parent bound onto itself, .mcp.json bound onto
  // itself from the same device; beside it the injected foreign .bashrc, the positive control.
  const table = (root) => `${[
    measured(347, 254, '8:48', '/', '/'),
    measured(1996, 347, '8:48', dirname(root), dirname(root)),
    measured(2034, 1996, '8:48', `${root}/.mcp.json`, `${root}/.mcp.json`),
    measured(2038, 1996, '0:40', '/tmp/empty', `${root}/.bashrc`, 'tmpfs tmpfs rw'),
  ].join('\n')}\n`;
  const deps = (root) => ({ ...stubs({ '.bashrc': 'file', '.mcp.json': 'file' }), readMountinfo: reader(table(root)) });

  it('the self-bound .mcp.json is not derived while the foreign .bashrc is, as a mount-only mask of a read table', () => {
    const root = makeRepo();
    const probe = probeSandboxMasks({ cwd: root, ...deps(root) });
    assert.deepEqual([probe.masks, probe.mountOnly, probe.mountSignal], [['.bashrc'], ['.bashrc'], 'read']);
  });

  it('fenced, the self-bound .mcp.json is stale-real and the foreign .bashrc is not', () => {
    const root = makeRepo();
    writeFence(root, '.bashrc', '.mcp.json');
    assert.deepEqual(probeSandboxMasks({ cwd: root, ...deps(root) }).staleReal, ['.mcp.json']);
  });
});

describe('sandbox-masks — the live device shape is a mask by both arms (spec:sandbox-masks/S4)', () => {
  // As measured: devtmpfs 0:6 rooted / at /dev, and its /null bound at a work-tree path.
  const table = (root) => `${[
    measured(347, 254, '8:48', '/', '/'),
    measured(349, 347, '0:6', '/', '/dev', DEVTMPFS),
    measured(1996, 347, '8:48', root, root),
    measured(2038, 1996, '0:6', '/null', `${root}/.bashrc`, DEVTMPFS),
  ].join('\n')}\n`;

  it('a character device there is a mask of the device arm, never mount-only', () => {
    const root = makeRepo();
    const probe = probeSandboxMasks({ cwd: root, ...stubs({ '.bashrc': 'char' }), readMountinfo: reader(table(root)) });
    assert.deepEqual([probe.masks, probe.mountOnly], [['.bashrc'], []]);
  });

  it('the same mount over a path lstat calls a regular file is still a mask, by the mount arm', () => {
    const root = makeRepo();
    const probe = probeSandboxMasks({ cwd: root, ...stubs({ '.bashrc': 'file' }), readMountinfo: reader(table(root)) });
    assert.deepEqual([probe.masks, probe.mountOnly], [['.bashrc'], ['.bashrc']]);
  });
});

describe('sandbox-masks — probe, apply, needsMasksApply and the advisor agree (spec:sandbox-masks/S11)', () => {
  it('the apply writes the foreign mount target, and the rerun finds nothing to offer', () => {
    const root = makeRepo();
    const deps = { ...stubs({ '.bashrc': 'file' }), readMountinfo: reader(foreignBashrc(root)) };
    const applied = main(['--cwd', root, '--apply'], { deps });
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(applied.stdout, /managed block replaced — 1 mask\(s\) hidden/);
    assert.ok(readExclude(root).includes('/.bashrc'));
    const probe = probeSandboxMasks({ cwd: root, ...deps });
    assert.deepEqual([probe.masks, probe.staleReal, needsMasksApply(probe)], [['.bashrc'], [], false]);
    assert.equal(masksItem(root, deps), undefined, 'the advisor offers nothing once the block holds the derivation');
  });

  it('a foreign mount target fenced today is neither stale-real nor a --clear offer', () => {
    const root = makeRepo();
    writeFence(root, '.bashrc');
    const deps = { ...stubs({ '.bashrc': 'file' }), readMountinfo: reader(foreignBashrc(root)) };
    assert.deepEqual(probeSandboxMasks({ cwd: root, ...deps }).staleReal, []);
    const shown = main(['--cwd', root], { deps });
    assert.equal(shown.code, 0, shown.stderr);
    assert.doesNotMatch(shown.stdout, /became a REAL path|--clear/);
    assert.equal(masksItem(root, deps), undefined, 'no stale-real item, so no --clear one-liner');
    const before = readExclude(root);
    assert.equal(main(['--cwd', root, '--apply'], { deps }).code, 0);
    assert.equal(readExclude(root), before, 'the apply re-writes the same block');
  });
});

describe('sandbox-masks — the mountinfo seam (spec:sandbox-masks/S16)', () => {
  it('deriveMasks takes readMountinfo beside lstat and listUntracked, and revalidateFence beside lstat', () => {
    const root = makeRepo();
    const derive = reader(foreignBashrc(root));
    assert.deepEqual(deriveMasks({ root, ...stubs({ '.bashrc': 'file' }), readMountinfo: derive }).masks, ['.bashrc']);
    assert.ok(derive.calls > 0, 'deriveMasks read the injected table');
    const revalidate = reader(foreignBashrc(root));
    assert.deepEqual(revalidateFence(['/.bashrc'], { root, lstat: stubs({ '.bashrc': 'file' }).lstat, readMountinfo: revalidate }), []);
    assert.ok(revalidate.calls > 0, 'revalidateFence read the injected table');
  });

  it('probeSandboxMasks takes readMountinfo beside lstat, listUntracked and readFile', () => {
    const root = makeRepo();
    const read = reader(foreignBashrc(root));
    const probe = probeSandboxMasks({ cwd: root, ...stubs({ '.bashrc': 'file' }), readFile: readFileSync, readMountinfo: read });
    assert.ok(read.calls > 0);
    assert.deepEqual([probe.mountOnly, probe.mountSignal], [['.bashrc'], 'read']);
  });

  it('the default reads /proc/self/mountinfo on Linux (absent elsewhere), never through the injected readFile', () => {
    const root = makeRepo();
    const readFile = (p, enc) => {
      if (p === '/proc/self/mountinfo') throw Object.assign(new Error('EACCES: the probe readFile is not the mount reader'), { code: 'EACCES' });
      return readFileSync(p, enc);
    };
    const probe = probeSandboxMasks({ cwd: root, readFile });
    assert.equal(probe.mountSignal, process.platform === 'linux' ? 'read' : 'absent');
    assert.deepEqual(probe.mountOnly, [], 'no mount sits in a fresh temporary work tree');
  });
});

describe('sandbox-masks — the review domain is unchanged (spec:sandbox-masks/S17)', () => {
  // A real empty .bashrc no ignore rule hides and no negation re-includes, judged foreign by the table.
  const fixture = () => {
    const root = makeRepo();
    writeFileSync(join(root, '.bashrc'), '');
    return { root, deps: { readMountinfo: reader(foreignBashrc(root)) } };
  };
  const standardWalk = (root) => git(root, 'ls-files', '--others', '--exclude-standard').stdout.split('\n').filter(Boolean);

  it('before the apply the mount-only mask rides the fingerprint payload, and the check notice counts no device', () => {
    const { root, deps } = fixture();
    assert.deepEqual(probeSandboxMasks({ cwd: root, ...deps }).mountOnly, ['.bashrc']);
    assert.ok(computeFingerprintPayload(root).toString('utf8').includes('untracked:.bashrc\n'), 'an ordinary untracked file');
    assert.ok(standardWalk(root).includes('.bashrc'));
    assert.equal(countNeverCommittableUntracked(root), 0, 'the notice counts the device class only');
  });

  it('after the apply it leaves every exclude-standard walk, the fingerprint payload included', () => {
    const { root, deps } = fixture();
    const applied = main(['--cwd', root, '--apply'], { deps });
    assert.equal(applied.code, 0, applied.stderr);
    assert.ok(!standardWalk(root).includes('.bashrc'), 'git ls-files --exclude-standard');
    assert.doesNotMatch(git(root, 'status', '--porcelain').stdout, /\.bashrc/, 'git status');
    assert.ok(!computeFingerprintPayload(root).toString('utf8').includes('.bashrc'), 'the review fingerprint payload');
  });
});
