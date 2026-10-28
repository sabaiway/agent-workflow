// The command line over the check and the record writer: one mode per run, --check exit codes with no
// byte moved, --record over the writer. Contract: docs/ai/specs/kit/project-rules/rules-cli.md.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  EFFECTIVE, KIT, KIT_TEXT, LOCAL, MERGED_TEXT, ONE_THEME, RECORD, UPGRADE,
  copyProject, entryOf, load, makeProject, mergedProject, need, recordText, removeProject, sha, snapshot,
} from './rules-harness.test.mjs';

const CLI = fileURLToPath(new URL('./rules-cli.mjs', import.meta.url));
const NOTE = 'move your edit to local/, a rebuild drops it';
const h = sha(KIT_TEXT);
const ONE = { themes: ONE_THEME };
const FOUR = ['--theme', 'project-layout', '--kit', h, '--local', 'absent', '--effective', h];

const loadMain = async () => need(await load('./rules-cli.mjs'), 'main');

// A project whose kit and effective files moved after a merge was recorded.
const driftProject = () => {
  const root = mergedProject();
  writeFileSync(join(root, KIT), `${KIT_TEXT}Kit edited.\n`);
  writeFileSync(join(root, EFFECTIVE), `${MERGED_TEXT}Effective edited.\n`);
  return root;
};

// The three ways a run names its project: ctx.cwd alone, --cwd absolute, --cwd relative to ctx.cwd.
const checkRuns = (main, root) => [
  ['ctx.cwd', () => main(['--check'], { cwd: root, deps: ONE })],
  ['--cwd absolute', () => main(['--check', '--cwd', root], { deps: ONE })],
  ['--cwd relative', () => main(['--check', '--cwd', basename(root)], { cwd: dirname(root), deps: ONE })],
];

describe('spec:project-rules/S12 exactly one mode with exactly its options, help alone, else usage reading no file', () => {
  let root;
  before(() => { root = makeProject(); });
  after(() => removeProject(root));

  for (const flag of ['--help', '-h']) {
    it(`${flag} alone prints the usage and exits 0`, async () => {
      const main = await loadMain();
      const out = main([flag]);
      assert.equal(out.code, 0);
      assert.equal(out.stderr, '');
      assert.match(out.stdout, /--check/);
      assert.match(out.stdout, /--record/);
    });
  }

  const usage = [
    [],
    ['--check', '--record'],
    ['--bogus'],
    ['--check', '--cwd'],
    ['--check', '--cwd', '--record'],
    ['--check', '--check'],
    ['--check', '--cwd', 'a', '--cwd', 'b'],
    ['--check', '--theme', 'project-layout'],
    ['--record', '--theme', 'project-layout', '--kit', h, '--local', 'absent'],
    ['--record', '--theme', 'project-layout', '--theme', 'project-layout', '--kit', h, '--local', 'absent', '--effective', h],
    ['--help', '--check'],
    ['-h', '-h'],
    ['--record', ...FOUR, '--extra'],
    ['toString'],
  ];
  for (const argv of usage) {
    const title = JSON.stringify(argv).replaceAll(h, '<h>');
    it(`${title} is usage: exit 2, nothing on stdout, nothing read`, async () => {
      const main = await loadMain();
      let touched = 0;
      const refuse = (path) => {
        touched += 1;
        throw new Error(`read ${path} during usage`);
      };
      const out = main(argv, { cwd: root, deps: { read: refuse, lstat: refuse } });
      assert.equal(out.code, 2);
      assert.equal(out.stdout, '');
      assert.ok(out.stderr.startsWith('project-rules: '), out.stderr);
      assert.equal(touched, 0);
    });
  }

  it('--check with only --cwd over an empty project is accepted and exits 0', async () => {
    const main = await loadMain();
    const out = main(['--check', '--cwd', root], { deps: ONE });
    assert.equal(out.code, 0);
    assert.equal(out.stdout, 'project-layout: absent\n');
    assert.equal(out.stderr, '');
  });
});

describe('spec:project-rules/S13 --check exits 0 only on current or absent, names every stop, moves no byte, also spawned', () => {
  const roots = [];
  const project = (make) => {
    const root = make();
    roots.push(root);
    return root;
  };
  after(() => roots.forEach(removeProject));

  // Each way of naming the project gives the same exit and stdout, stderr '' and no byte moved.
  const runEach = (main, root, expect) => {
    for (const [how, run] of checkRuns(main, root)) {
      const prior = snapshot(root);
      const out = run();
      assert.equal(out.code, expect.code, `${how}: ${out.stdout}`);
      assert.equal(out.stderr, '', how);
      expect.stdout(out.stdout, how);
      assert.deepEqual(snapshot(root), prior, how);
    }
  };

  it('an empty project is absent and exits 0', async () => {
    const main = await loadMain();
    runEach(main, project(() => makeProject()), {
      code: 0, stdout: (s, how) => assert.equal(s, 'project-layout: absent\n', how),
    });
  });

  it('a recorded kit copy is current and exits 0', async () => {
    const main = await loadMain();
    runEach(main, project(copyProject), {
      code: 0, stdout: (s, how) => assert.equal(s, 'project-layout: current\n', how),
    });
  });

  it('a merge with its kit and effective files moved is drift naming both, exits 1', async () => {
    const main = await loadMain();
    runEach(main, project(driftProject), {
      code: 1,
      stdout: (s, how) => {
        assert.ok(s.endsWith('\n') && s.split('\n').length === 2, `${how}: ${s}`);
        assert.ok(s.startsWith('project-layout: drift'), `${how}: ${s}`);
        for (const part of [KIT, EFFECTIVE, NOTE, UPGRADE]) assert.ok(s.includes(part), `${how}: ${part} in ${s}`);
        assert.ok(!s.includes(LOCAL), `${how}: the unmoved local file is named in ${s}`);
      },
    });
  });

  it('a kit file with no record entry is a record stop naming no-entry, exits 1', async () => {
    const main = await loadMain();
    runEach(main, project(() => makeProject({ [KIT]: KIT_TEXT })), {
      code: 1,
      stdout: (s, how) => {
        assert.ok(s.endsWith('\n') && s.split('\n').length === 2, `${how}: ${s}`);
        for (const part of ['project-layout: record', '(no-entry)', UPGRADE]) assert.ok(s.includes(part), `${how}: ${part} in ${s}`);
      },
    });
  });

  it('spawned directly, a drift project exits 1 and an empty one exits 0', async () => {
    await loadMain();
    const spawn = (root) => spawnSync(process.execPath, [CLI, '--check', '--cwd', root], { encoding: 'utf8' });
    const drift = project(driftProject);
    const driftBefore = snapshot(drift);
    const stopped = spawn(drift);
    assert.equal(stopped.status, 1, stopped.stderr);
    assert.ok(stopped.stdout.includes(KIT), stopped.stdout);
    assert.ok(stopped.stdout.includes(UPGRADE), stopped.stdout);
    assert.equal(stopped.stderr, '');
    assert.deepEqual(snapshot(drift), driftBefore);
    const empty = project(() => makeProject());
    const accepted = spawn(empty);
    assert.equal(accepted.status, 0, accepted.stderr);
    const lines = accepted.stdout.split('\n').filter(Boolean);
    assert.ok(lines.includes('project-layout: absent') && lines.every((line) => line.endsWith(': absent')), accepted.stdout);
  });
});

describe('spec:project-rules/S14 --record exits 0 on a write, 1 naming the failed condition while writing nothing', () => {
  const roots = [];
  const unrecorded = () => {
    const root = makeProject({ [KIT]: KIT_TEXT, [EFFECTIVE]: KIT_TEXT });
    roots.push(root);
    return root;
  };
  after(() => roots.forEach(removeProject));

  it('a kit copy with no record is recorded, exit 0', async () => {
    const main = await loadMain();
    const root = unrecorded();
    const out = main(['--record', ...FOUR, '--cwd', root]);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout, `project-rules: recorded project-layout in ${RECORD}\n`);
    assert.equal(out.stderr, '');
    const expected = recordText({ 'project-layout': entryOf({ kit: KIT_TEXT, effective: KIT_TEXT }) });
    assert.equal(readFileSync(join(root, RECORD), 'utf8'), expected);
  });

  const refusals = [
    ['a wrong --kit', ['--theme', 'project-layout', '--kit', sha('another kit'), '--local', 'absent', '--effective', h], 'kit-moved'],
    ['a theme outside the registry', ['--theme', 'no-such-theme', '--kit', h, '--local', 'absent', '--effective', h], 'theme'],
  ];
  for (const [what, four, condition] of refusals) {
    it(`${what} is refused naming (${condition}), exit 1, nothing written`, async () => {
      const main = await loadMain();
      const root = unrecorded();
      const prior = snapshot(root);
      const out = main(['--record', ...four, '--cwd', root]);
      assert.equal(out.code, 1, out.stdout);
      assert.equal(out.stdout, '');
      assert.ok(out.stderr.startsWith('project-rules: --record refused'), out.stderr);
      assert.ok(out.stderr.includes(`(${condition})`), out.stderr);
      assert.ok(out.stderr.includes('nothing written'), out.stderr);
      assert.deepEqual(snapshot(root), prior);
      assert.equal(existsSync(join(root, RECORD)), false);
    });
  }
});
