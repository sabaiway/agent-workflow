// sandbox-masks-signal.test.mjs — where the mount signal is unavailable the answer says so (spec
// kit/review-domain/sandbox-masks, S12-S14). A reader answering null is the absent-by-platform case (the
// default answers it off Linux); a throwing reader is an unreadable table; a malformed table refuses too.
// Each refusal carries its own message, exits 1 on the CLI, and is a stated skip in the advisor.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync } from 'node:fs';
import { main, probeSandboxMasks } from './sandbox-masks.mjs';
import { fakeStat, repoFactory, line, plainTable, adviseMasks } from './sandbox-masks-harness.test.mjs';

const makeRepo = repoFactory('sandbox-masks-signal');

// A device mask and a plain file: the device arm alone derives exactly the first.
const stubs = () => ({
  listUntracked: () => ['.bashrc', '.zshrc'],
  lstat: (p) => (p.endsWith('/.bashrc') ? fakeStat('char') : p.endsWith('/.zshrc') ? fakeStat('file') : lstatSync(p)),
});
const readTable = (root) => () => plainTable(root);
const absent = () => null;
const unreadable = () => {
  throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
};
// Both MALFORMED shapes: a malformed LINE (no - field) and a malformed TABLE (two root mounts).
const MALFORMED_CASES = [
  ['a line with no - field', (root) => () => `${line(1, 0, '8:1', '/', '/')}\n2 1 8:2 /wt ${root} rw ext4 /dev/sda rw\n`],
  ['a table with two root mounts', (root) => () => `${[line(1, 0, '8:1', '/', '/'), line(5, 6, '8:5', '/', '/'), line(2, 1, '8:2', '/wt', root)].join('\n')}\n`],
];
const UNREADABLE = /cannot read \/proc\/self\/mountinfo/;
const MALFORMED = /malformed mountinfo/;
const PLATFORM_LINE = /^ {2}mount signal: not read on this platform\b/;

const advise = adviseMasks;

describe('sandbox-masks — the mount signal absent by platform (spec:sandbox-masks/S12)', () => {
  it('a reader answering absent leaves the device arm alone', () => {
    const root = makeRepo();
    const probe = probeSandboxMasks({ cwd: root, ...stubs(), readMountinfo: absent });
    assert.deepEqual([probe.masks, probe.mountOnly, probe.mountSignal], [['.bashrc'], [], 'absent']);
  });

  it('the probe render carries the one platform line and --json answers absent', () => {
    const root = makeRepo();
    const shown = main(['--cwd', root], { deps: { ...stubs(), readMountinfo: absent } });
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(shown.stdout.split('\n').filter((l) => PLATFORM_LINE.test(l)).length, 1, shown.stdout);
    const json = main(['--cwd', root, '--json'], { deps: { ...stubs(), readMountinfo: absent } });
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual([JSON.parse(json.stdout).mountSignal, JSON.parse(json.stdout).mountOnly], ['absent', []]);
  });

  it('a read table leaves the platform line out and --json answers read', () => {
    const root = makeRepo();
    const shown = main(['--cwd', root], { deps: { ...stubs(), readMountinfo: readTable(root) } });
    assert.equal(shown.code, 0, shown.stderr);
    assert.ok(!shown.stdout.split('\n').some((l) => PLATFORM_LINE.test(l)), shown.stdout);
    const json = main(['--cwd', root, '--json'], { deps: { ...stubs(), readMountinfo: readTable(root) } });
    assert.equal(JSON.parse(json.stdout).mountSignal, 'read');
  });
});

describe('sandbox-masks — an unreadable mountinfo refuses the probe (spec:sandbox-masks/S13)', () => {
  it('the probe throws its own message, never a device-only answer', () => {
    const root = makeRepo();
    assert.throws(() => probeSandboxMasks({ cwd: root, ...stubs(), readMountinfo: unreadable }), UNREADABLE);
  });

  it('the CLI exits 1 by that message, the --json probe too', () => {
    const root = makeRepo();
    for (const argv of [['--cwd', root], ['--cwd', root, '--json']]) {
      const r = main(argv, { deps: { ...stubs(), readMountinfo: unreadable } });
      assert.deepEqual([r.code, r.stdout], [1, ''], argv.join(' '));
      assert.match(r.stderr, UNREADABLE);
      assert.doesNotMatch(r.stderr, MALFORMED, 'its own message, not the malformed one');
    }
  });

  it('the advisor records a skip, never an item', () => {
    const root = makeRepo();
    const { item, skip } = advise(root, { ...stubs(), readMountinfo: unreadable });
    assert.equal(item, undefined);
    assert.match(skip?.reason ?? '', UNREADABLE);
  });
});

describe('sandbox-masks — a malformed mountinfo refuses the probe (spec:sandbox-masks/S14)', () => {
  for (const [label, readerFor] of MALFORMED_CASES) {
    it(`${label}: the CLI exits 1 by its own message`, () => {
      const root = makeRepo();
      assert.throws(() => probeSandboxMasks({ cwd: root, ...stubs(), readMountinfo: readerFor(root) }), MALFORMED);
      const r = main(['--cwd', root], { deps: { ...stubs(), readMountinfo: readerFor(root) } });
      assert.deepEqual([r.code, r.stdout], [1, '']);
      assert.match(r.stderr, MALFORMED);
      assert.doesNotMatch(r.stderr, UNREADABLE, 'its own message, not the unreadable one');
    });

    it(`${label}: the advisor records a skip, never an item`, () => {
      const root = makeRepo();
      const { item, skip } = advise(root, { ...stubs(), readMountinfo: readerFor(root) });
      assert.equal(item, undefined);
      assert.match(skip?.reason ?? '', MALFORMED);
    });
  }
});
