// sandbox-masks-leftover.test.mjs — a possible LEFTOVER withholds the verdict (spec kit/review-domain/sandbox-masks,
// S23 and S24): a fenced empty regular file with a numeric mode and no write bit that no arm calls a mask refuses.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { main, probeSandboxMasks, toExcludePattern, MASKS_FENCE_START, MASKS_FENCE_END } from './sandbox-masks.mjs';
import { isLineUnsafe, jsonForLine } from './source-size-refusal.mjs';
import { formatRecommendations } from './recommendations.mjs';
import { fakeStat, repoFactory, measured, plainTable, foreignBashrc, reader, stubs, writeFence, readExclude, adviseMasks } from './sandbox-masks-harness.test.mjs';
const makeRepo = repoFactory('sandbox-masks-leftover');
const empty = (mode, size = 0) => fakeStat('file', { size, mode });
const staleRealHead = (n) => `  ⚠ ${n} fenced entr(ies) became REAL path(s) — delete each one's line from the managed block BEFORE relying on git for it: an excluded real file is silently skipped by bulk staging (git add -A / git add .), so it stays OUT of your commits, and an explicit git add refuses it without -f; .git/info/exclude never warns:`;
const leftoverHead = (n) => `  ⚠ refusing: ${n} fenced entr(ies) are empty read-only files no arm calls a mask, so neither verdict is given — a running sandbox's mask: re-run once no other sandboxed command runs; litter a sandbox left: remove the file outside the sandbox and keep its line; a real file: delete its line:`;
const PATH_INDENT = '      ';
const pathLine = (rel) => `${PATH_INDENT}${jsonForLine(rel)}`;
const withCliPrefix = (line) => `sandbox-masks: ${line}`;
const refusalLines = ([head, ...rest]) => [withCliPrefix(head), ...rest];
const assertWholeReason = (skip, lines) => {
  assert.deepEqual(skip.whole, lines);
  const report = formatRecommendations({ items: [], skips: [skip] }).split('\n');
  const rendered = [`  ⚠ skipped item sandbox-masks — probe failed: ${skip.reason}`, ...lines.map((line) => `      | ${line}`)];
  assert.deepEqual(report.slice(-rendered.length), rendered);
};
const selfTable = (root) => `${[
  measured(347, 254, '8:48', '/', '/'),
  measured(1996, 347, '8:48', dirname(root), dirname(root)),
  measured(2034, 1996, '8:48', `${root}/.bashrc`, `${root}/.bashrc`),
  measured(2035, 1996, '8:48', `${root}/.mcp.json`, `${root}/.mcp.json`),
].join('\n')}\n`;
const READERS = [
  ['self-bound in the measured shape', (root) => reader(selfTable(root))],
  ['unbound', (root) => reader(plainTable(root))],
  ['under a reader answering absent', () => () => null],
];
const MODES = [['0444', 0o100444], ['0400', 0o100400]];
const REAL_BESIDE = [['209 bytes 0444', empty(0o100444, 209)], ['0 bytes 0644', empty(0o100644)]];

describe('sandbox-masks — a fenced LEFTOVER refuses the probe (spec:sandbox-masks/S23)', () => {
  for (const [readerLabel, readerFor] of READERS) {
    for (const [modeLabel, mode] of MODES) {
      for (const [realLabel, realStat] of REAL_BESIDE) {
        it(`${modeLabel}, ${readerLabel}, beside a real ${realLabel}: led by the stale-real entry, exit 1, and the advisor skips`, () => {
          const root = makeRepo();
          writeFence(root, '.bashrc', '.mcp.json');
          const deps = () => ({ ...stubs({ '.bashrc': empty(mode), '.mcp.json': realStat }), readMountinfo: readerFor(root) });
          const r = main(['--cwd', root], { deps: deps() });
          assert.deepEqual([r.code, r.stdout], [1, '']);
          const staleGroup = [staleRealHead(1), pathLine('.mcp.json')];
          const lines = [...staleGroup, leftoverHead(1), pathLine('.bashrc')];
          assert.deepEqual(r.stderr.split('\n'), refusalLines(lines));
          const { item, skip } = adviseMasks(root, deps());
          assert.equal(item, undefined);
          const summary = /^(.+)… \(\+\d+ more chars; the whole reason follows\)$/u.exec(skip?.reason ?? '');
          assert.ok(summary && staleGroup[0].trimStart().startsWith(summary[1]));
          assertWholeReason(skip, lines);
          assert.deepEqual(JSON.parse(JSON.stringify(skip)).whole, lines);
          writeFence(root, '.mcp.json');
          const warning = main(['--cwd', root], { deps: deps() });
          assert.equal(warning.code, 0);
          const warningLines = warning.stdout.split('\n');
          const warningIndex = warningLines.indexOf(staleGroup[0]);
          assert.deepEqual(warningLines.slice(warningIndex, warningIndex + staleGroup.length), staleGroup);
        });
      }
    }
  }
  it('three stale-real stubs, each one clause off, beside two leftovers: the refusal names all five, the stale-real lines first', () => {
    const root = makeRepo();
    const classes = { '.bashrc': empty(0o100444), '.group-w': empty(0o100464), '.sized': empty(0o100444, 209), '.dir': fakeStat('dir', { mode: 0o40555 }), '.zshrc': empty(0o100400) };
    writeFence(root, ...Object.keys(classes));
    const r = main(['--cwd', root], { deps: { ...stubs(classes), readMountinfo: reader(plainTable(root)) } });
    assert.equal(r.code, 1);
    assert.deepEqual(r.stderr.split('\n'), refusalLines([staleRealHead(3), pathLine('.group-w'), pathLine('.sized'), pathLine('.dir'), leftoverHead(2), pathLine('.bashrc'), pathLine('.zshrc')]));
  });

  it('line-safe JSON strings preserve special leftover names in fence order and in the advisor', () => {
    const root = makeRepo();
    const names = ['trail ', 'in\ttab', 'a,b', 'back\\slash', 'ctl\u0001x'];
    const excludeFile = join(root, '.git', 'info', 'exclude');
    mkdirSync(dirname(excludeFile), { recursive: true });
    writeFileSync(excludeFile, `${[MASKS_FENCE_START, ...names.map(toExcludePattern), MASKS_FENCE_END].join('\n')}\n`);
    const deps = { ...stubs(Object.fromEntries(names.map((name) => [name, empty(0o100444)]))), readMountinfo: reader(plainTable(root)) };
    const r = main(['--cwd', root], { deps });
    assert.equal(r.code, 1);
    const lines = [leftoverHead(5), ...names.map(pathLine)];
    const stderrLines = r.stderr.split('\n');
    assert.deepEqual(stderrLines, refusalLines(lines));
    assert.ok(stderrLines.every((line) => !isLineUnsafe(line)));
    assert.deepEqual(stderrLines.slice(1).map((line) => JSON.parse(line.slice(PATH_INDENT.length))), names);
    assertWholeReason(adviseMasks(root, deps).skip, lines);
  });

  it('a plain --apply beside a derived mask exits 1 by the leftover message, the exclude file byte-unchanged', () => {
    const root = makeRepo();
    writeFence(root, '.bashrc');
    const before = readExclude(root);
    const r = main(['--cwd', root, '--apply'], { deps: { ...stubs({ '.bashrc': empty(0o100444), '.zshrc': 'char' }), readMountinfo: reader(plainTable(root)) } });
    assert.equal(r.code, 1);
    assert.deepEqual(r.stderr.split('\n'), refusalLines([leftoverHead(1), pathLine('.bashrc')]));
    assert.equal(readExclude(root), before);
  });

  it('a stat whose mode is not a number is no leftover: stale-real, exit 0', () => {
    const root = makeRepo();
    writeFence(root, '.bashrc');
    const deps = { ...stubs({ '.bashrc': fakeStat('file', { size: 0 }) }), readMountinfo: reader(selfTable(root)) };
    assert.deepEqual(probeSandboxMasks({ cwd: root, ...deps }).staleReal, ['.bashrc']);
    assert.equal(main(['--cwd', root], { deps }).code, 0);
  });
});

describe('sandbox-masks — the leftover shape never decides (spec:sandbox-masks/S24)', () => {
  it('unfenced it is not derived and the probe answers without a refusal', () => {
    const root = makeRepo();
    const probe = probeSandboxMasks({ cwd: root, ...stubs({ '.bashrc': empty(0o100444) }), readMountinfo: reader(selfTable(root)) });
    assert.deepEqual([probe.masks, probe.staleReal], [[], []]);
  });

  it('a fenced foreign mount target of that shape is a mask and the probe answers without a refusal', () => {
    const root = makeRepo();
    writeFence(root, '.bashrc');
    const probe = probeSandboxMasks({ cwd: root, ...stubs({ '.bashrc': empty(0o100444) }), readMountinfo: reader(foreignBashrc(root)) });
    assert.deepEqual([probe.masks, probe.mountOnly, probe.staleReal], [['.bashrc'], ['.bashrc'], []]);
  });

  it('--apply --clear over a fenced leftover removes the block', () => {
    const root = makeRepo();
    writeFence(root, '.bashrc');
    const r = main(['--cwd', root, '--apply', '--clear'], { deps: { ...stubs({ '.bashrc': empty(0o100444) }), readMountinfo: reader(selfTable(root)) } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /managed block removed/);
    assert.equal(readExclude(root), '');
  });

  it('an lstat answering the leftover first and a device on any later call still refuses; lstat runs once per path', () => {
    const root = makeRepo();
    writeFence(root, '.bashrc');
    const calls = [];
    const lstat = (p) => {
      calls.push(p);
      return calls.filter((c) => c === p).length === 1 ? empty(0o100444) : fakeStat('char');
    };
    const r = main(['--cwd', root], { deps: { listUntracked: () => ['.bashrc'], lstat: (p) => (p.endsWith('/.bashrc') ? lstat(p) : lstatSync(p)), readMountinfo: reader(plainTable(root)) } });
    assert.equal(r.code, 1);
    assert.equal(r.stderr.split('\n')[0], withCliPrefix(leftoverHead(1)));
    assert.equal(calls.length, 1, 'one lstat answer for the fenced path the walk lists');
  });
});
