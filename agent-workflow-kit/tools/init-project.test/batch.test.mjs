import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { skillTargets } from '../jev-facts.mjs';
import {
  APPLY, FIVE, RESTART, RUN_NONE, SUDO, TOOLS, applies, changed, facts, fixture, hashTree, init, isApply, item, lanes,
  need, ok, pending, policy, put, realFixture,
} from './harness.test.mjs';

describe('spec:init-project/S11 previews and one terminal y', () => {
  it('every pending console variant is previewed with its posture text', async (t) => {
    const f = fixture(t, [item('velocity-core'), item('bridge-tier')], ['n']);
    const note = readFileSync(join(TOOLS, '..', 'references/modes/recommendations.md'), 'utf8').split('\n').find((line) => line.startsWith('- `bridge-tier` — '));
    assert.ok(note);
    f.respond = (argv) => ok(argv.includes('--bridge-tier') ? 'BT-PREVIEW' : 'VC-PREVIEW');
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 0 });
    const start = f.printed.indexOf('preview: velocity-core');
    assert.ok(start >= 0);
    assert.deepEqual(f.printed.slice(start, start + 5), ['preview: velocity-core', 'VC-PREVIEW', 'preview: bridge-tier', 'BT-PREVIEW', note]);
  });
  it('the run-none line prints before the y and one y applies the batch', async (t) => {
    const queue = [item('velocity-core'), item('bridge-tier')];
    const f = fixture(t, queue);
    const argvOf = need(lanes, 'consoleArgv');
    const expected = queue.map((i) => argvOf(i.variant, facts(f)).apply);
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 0 });
    assert.deepEqual(applies(f).map(({ argv }) => argv), expected);
    for (const { opts } of applies(f)) assert.deepEqual(opts.stdio, ['inherit', 'pipe', 'inherit']);
    const before = f.events.findIndex(([kind, line]) => kind === 'print' && line === RUN_NONE);
    const question = f.events.findIndex(([kind, line]) => kind === 'ask' && line === APPLY);
    assert.ok(before >= 0 && question > before);
    assert.deepEqual(f.questions, [APPLY]);
  });
  it('the doctor missing-binaries preview asks its sudo question and Enter skips only the install', async (t) => {
    for (const answer of ['', 'y']) {
      const f = fixture(t, [item('sandbox-provision.installable'), item('velocity-core')], ['y', answer]);
      f.respond = (argv) => {
        if (!argv[1].endsWith('autonomy-doctor.mjs') || isApply(argv)) return ok();
        return ok('status=missing-binaries\n--apply apt-get:bubblewrap', 3);
      };
      const run = need(init, 'runInitProject');
      assert.deepEqual(await run(f.deps), { code: 0 });
      assert.deepEqual(f.questions, [APPLY, SUDO]);
      assert.ok(!f.printed.some((line) => line.startsWith('preview refused')));
      const doctor = applies(f).filter(({ argv }) => argv[1].endsWith('autonomy-doctor.mjs'));
      assert.deepEqual(doctor.map(({ argv }) => argv), answer === 'y' ? [['node', join(TOOLS, 'autonomy-doctor.mjs'), '--apply', 'apt-get:bubblewrap']] : []);
      assert.ok(applies(f).some(({ argv }) => argv[1].endsWith('velocity-profile.mjs')));
    }
  });
  it('a pending bare sandbox-provision is listed and not applied', async (t) => {
    const f = fixture(t, [item('velocity-core'), item('sandbox-provision', 'BARE-WHAT')]);
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 0 });
    assert.ok(f.printed.includes('listed, not applied here: sandbox-provision — BARE-WHAT'));
    assert.ok(!f.calls.some(({ argv }) => argv[1].endsWith('autonomy-doctor.mjs')));
    assert.equal(applies(f).length, 1);
  });
  it('a refusing preview is printed and not applied while the other variant applies', async (t) => {
    const f = fixture(t, [item('mcp-channel'), item('velocity-core')]);
    f.respond = (argv) => ok('', argv[1].endsWith('mcp.mjs') ? 1 : 0);
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 0 });
    assert.ok(f.printed.includes('preview refused (exit 1): mcp-channel'));
    assert.equal(applies(f).length, 1);
    assert.ok(applies(f)[0].argv[1].endsWith('velocity-profile.mjs'));
  });
  it('an apply failing after a clean preview stops later variants, while doctor exit 5 after install completed succeeds', async (t) => {
    const outcomes = [
      ['velocity-core', 4, '', 1],
      ['sandbox-provision.installable', 5, 'install completed', 0],
      ['sandbox-provision.installable', 5, '', 1],
    ];
    for (const [variant, status, stdout, code] of outcomes) {
      const f = fixture(t, [item(variant), item('gate-hook')], variant === 'velocity-core' ? ['y'] : ['y', 'y']);
      f.respond = (argv) => {
        if (argv[1].endsWith('gate-hook.mjs')) return ok();
        if (isApply(argv)) return ok(stdout, status);
        if (argv[1].endsWith('autonomy-doctor.mjs')) return ok('status=missing-binaries\n--apply apt-get:bubblewrap', 3);
        return ok();
      };
      const run = need(init, 'runInitProject');
      assert.deepEqual(await run(f.deps), { code });
      assert.equal(applies(f).some(({ argv }) => argv[1].endsWith('gate-hook.mjs')), code === 0);
      if (code === 1) {
        assert.ok(f.printed.includes(`apply failed (exit ${status}): ${variant}`));
        assert.ok(f.printed.includes('not applied: gate-hook — an earlier apply failed'));
      } else {
        assert.ok(f.printed.includes('install completed'));
        assert.ok(!f.printed.includes('apply failed (exit 5): sandbox-provision.installable'));
      }
    }
  });
  it('n applies nothing and leaves the root tree hash unchanged', async (t) => {
    const f = fixture(t, [item('velocity-core'), item('bridge-tier')], ['n']);
    const before = hashTree(f.root);
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 0 });
    assert.deepEqual(applies(f), []);
    assert.equal(hashTree(f.root), before);
    assert.ok(f.printed.includes('preview: velocity-core'));
    assert.ok(f.printed.includes('preview: bridge-tier'));
  });
});

describe('spec:init-project/S13 consent bound to the previewed state', () => {
  it('the five writers pending on a fresh project all apply on one y', async (t) => {
    const f = realFixture(t);
    assert.deepEqual(pending(f), FIVE);
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 0 });
    assert.deepEqual(pending(f), []);
    assert.deepEqual(f.questions, [APPLY]);
    assert.equal(applies(f).length, 5);
    const argvOf = need(lanes, 'consoleArgv');
    assert.deepEqual(applies(f).map(({ argv }) => argv), FIVE.map((variant) => argvOf(variant, facts(f)).apply));
  });
  it('bridge-tier then autonomy-render both apply and neither stays pending', async (t) => {
    const f = realFixture(t, new Set(['bridge-tier', 'autonomy-render']));
    policy(f);
    assert.deepEqual(pending(f), ['bridge-tier', 'autonomy-render']);
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 0 });
    assert.deepEqual(pending(f), []);
    assert.deepEqual(applies(f).map(({ argv }) => argv.includes('--bridge-tier') ? 'bridge-tier' : 'autonomy-render'), ['bridge-tier', 'autonomy-render']);
    assert.deepEqual(f.questions, [APPLY]);
  });
  it('an autonomy.json edited after the previews leaves autonomy-render and every later variant unapplied', async (t) => {
    const variants = ['autonomy-render', 'gate-hook', 'mcp-channel'];
    const f = realFixture(t, new Set(variants));
    policy(f);
    assert.deepEqual(pending(f), variants);
    f.answers = [async () => {
      policy(f, 'plan-authoring');
      return 'y';
    }];
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 1 });
    for (const variant of variants) assert.ok(f.printed.includes(changed(variant, join(f.root, 'docs/ai/autonomy.json'))));
    assert.deepEqual(applies(f), []);
    assert.deepEqual(pending(f), variants);
  });
  it('an autonomy.json edited while velocity-core applies stops autonomy-render after the core converges', async (t) => {
    const f = realFixture(t, new Set(['velocity-core', 'autonomy-render']));
    policy(f);
    assert.deepEqual(pending(f), ['velocity-core', 'autonomy-render']);
    const realSpawn = f.respond;
    f.respond = (argv, opts) => {
      const result = realSpawn(argv, opts);
      if (isApply(argv) && !argv.includes('--autonomy')) policy(f, 'plan-authoring');
      return result;
    };
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 1 });
    assert.deepEqual(pending(f), ['autonomy-render']);
    assert.equal(applies(f).length, 1);
    assert.ok(f.printed.includes(changed('autonomy-render', join(f.root, 'docs/ai/autonomy.json'))));
  });
  it('a jev-skill target deleted after the preview stops that variant and every later one', async (t) => {
    const f = fixture(t, [item('jev-skill'), item('velocity-core')]);
    const paths = skillTargets({ home: f.home, claudeDir: join(f.home, '.claude') }).map(({ path }) => path);
    for (const path of paths) mkdirSync(path, { recursive: true });
    assert.equal(paths.length, 3);
    f.answers = [async () => {
      rmSync(paths[0], { recursive: true });
      return 'y';
    }];
    const writes = need(lanes, 'writesOf');
    assert.deepEqual(writes('jev-skill', { ...facts(f), env: {} }), paths);
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 1 });
    for (const variant of ['jev-skill', 'velocity-core']) assert.ok(f.printed.includes(changed(variant, paths[0])));
    assert.deepEqual(applies(f), []);
  });
  it('an agents apply that rewrites a placed vehicle is recorded again, so the next variant still applies', async (t) => {
    const f = fixture(t, [item('agents'), item('velocity-core')]);
    const vehicle = join(f.root, '.claude/agents/vehicle.md');
    put(vehicle, 'old\n');
    f.respond = (argv) => {
      if (isApply(argv) && argv[1] === join(TOOLS, 'cheap-agents.mjs')) put(vehicle, 'new\n');
      return ok();
    };
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 0 });
    assert.equal(applies(f).length, 2);
    assert.equal(f.printed.some((line) => line.startsWith('not applied:')), false);
  });
  it('a foreign file created beside the written hook during its apply stops the next variant, .claude/hooks absent or present before', async (t) => {
    for (const [present, foreign] of [[false, false], [false, true], [true, false], [true, true]]) {
      const f = fixture(t, [item('gate-hook'), item('velocity-core')]);
      const hooks = join(f.root, '.claude/hooks');
      if (present) for (const name of ['agent-workflow-gates.mjs', 'zz.mjs']) put(join(hooks, name), 'old\n');
      f.respond = (argv) => {
        if (isApply(argv) && argv[1] === join(TOOLS, 'gate-hook.mjs')) {
          put(join(hooks, 'agent-workflow-gates.mjs'), 'hook\n');
          if (foreign) put(join(hooks, 'foreign.mjs'), 'foreign\n');
        }
        return ok();
      };
      const run = need(init, 'runInitProject');
      assert.deepEqual(await run(f.deps), { code: foreign ? 1 : 0 });
      assert.equal(applies(f).length, foreign ? 1 : 2);
      assert.equal(f.printed.includes(changed('velocity-core', hooks)), foreign);
    }
  });
  it('a symlinked hook and a symlinked jev-skill target are recorded through their links, and a deleted link target stops the batch', async (t) => {
    for (const deleted of [false, true]) {
      const f = fixture(t, [item('jev-skill'), item('velocity-core')]);
      put(join(f.root, 'scripts/pre-commit'), '#!/bin/sh\n');
      mkdirSync(join(f.root, '.git/hooks'), { recursive: true });
      symlinkSync('../../scripts/pre-commit', join(f.root, '.git/hooks/pre-commit'));
      const paths = skillTargets({ home: f.home, claudeDir: join(f.home, '.claude') }).map(({ path }) => path);
      const copy = join(f.home, 'vendor/typesafe-ai');
      put(join(copy, 'SKILL.md'), 'skill\n');
      mkdirSync(dirname(paths[0]), { recursive: true });
      symlinkSync(copy, paths[0]);
      f.answers = [async () => {
        if (deleted) rmSync(copy, { recursive: true });
        return 'y';
      }];
      const run = need(init, 'runInitProject');
      assert.deepEqual(await run(f.deps), { code: deleted ? 1 : 0 });
      assert.equal(applies(f).length, deleted ? 0 : 2);
      if (deleted) for (const variant of ['jev-skill', 'velocity-core']) assert.ok(f.printed.includes(changed(variant, paths[0])));
    }
  });
  it('an autonomy.json edited while a later preview runs leaves autonomy-render and every later variant unapplied', async (t) => {
    const f = fixture(t, [item('autonomy-render'), item('velocity-core')]);
    policy(f);
    f.respond = (argv) => {
      if (!isApply(argv) && !argv.includes('--autonomy')) policy(f, 'plan-authoring');
      return ok();
    };
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 1 });
    for (const variant of ['autonomy-render', 'velocity-core']) assert.ok(f.printed.includes(changed(variant, join(f.root, 'docs/ai/autonomy.json'))));
    assert.deepEqual(applies(f), []);
  });
  it('a skill file edited and a resolved hook created after the previews each stop the batch, naming the path', async (t) => {
    for (const edit of ['skill', 'hook']) {
      const f = fixture(t, [item('jev-skill'), item('velocity-core')]);
      const target = skillTargets({ home: f.home, claudeDir: join(f.home, '.claude') })[0].path;
      put(join(target, 'SKILL.md'), 'skill\n');
      const hooks = join(f.home, 'common/hooks');
      mkdirSync(hooks, { recursive: true });
      f.deps.gitHooksPath = () => hooks;
      const path = edit === 'skill' ? target : hooks;
      f.answers = [async () => {
        put(edit === 'skill' ? join(target, 'SKILL.md') : join(hooks, 'pre-commit'), 'changed\n');
        return 'y';
      }];
      const run = need(init, 'runInitProject');
      assert.deepEqual(await run(f.deps), { code: 1 });
      for (const variant of ['jev-skill', 'velocity-core']) assert.ok(f.printed.includes(changed(variant, path)));
    }
  });
  it('a recorded path that cannot be read stops the pass before any preview, naming it and its code', async (t) => {
    const f = fixture(t, [item('velocity-core')]);
    const link = join(f.root, '.claude/hooks/linked.mjs');
    put(join(f.root, 'hook.mjs'), '');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(f.root, 'hook.mjs'), link);
    f.deps.io = { stat: (path) => {
      throw Object.assign(new Error('denied'), { code: path === link ? 'EACCES' : 'ENOENT' });
    } };
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 1 });
    assert.ok(f.printed.includes(`not applied: velocity-core — ${link} could not be read: EACCES`));
    assert.deepEqual(f.calls, []);
  });
  it('a written path that cannot be read after its apply stops every later variant, naming it', async (t) => {
    const f = fixture(t, [item('velocity-core'), item('gate-hook')]);
    const settings = join(f.root, '.claude/settings.json');
    let armed = false;
    f.respond = (argv) => {
      armed ||= isApply(argv);
      return ok();
    };
    f.deps.io = { readFile: (path, ...rest) => {
      if (armed && path === settings) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return readFileSync(path, ...rest);
    } };
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 1 });
    assert.ok(f.printed.includes(changed('gate-hook', settings)));
    assert.equal(applies(f).length, 1);
  });
  it('a docs/ai json file created after the previews leaves agents and every later variant unapplied', async (t) => {
    const f = fixture(t, [item('agents'), item('velocity-core')]);
    f.answers = [async () => {
      put(join(f.root, 'docs/ai/vehicles.json'), '{}\n');
      return 'y';
    }];
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 1 });
    for (const variant of ['agents', 'velocity-core']) assert.ok(f.printed.includes(changed(variant, join(f.root, 'docs/ai/*.json'))));
    assert.deepEqual(applies(f), []);
  });
});

describe('spec:init-project/S14 protected files written in place', () => {
  it('existing protected files keep their inode and nlink, an absent hook is created, and no protected file is gone', async (t) => {
    const f = realFixture(t);
    const paths = ['.claude/settings.json', '.mcp.json'].map((rel) => join(f.root, rel));
    const before = paths.map((path) => statSync(path).ino);
    const hook = join(f.root, '.claude/hooks/agent-workflow-gates.mjs');
    assert.equal(existsSync(hook), false);
    assert.deepEqual(pending(f), FIVE);
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 0 });
    assert.deepEqual(paths.map((path) => statSync(path).ino), before);
    assert.deepEqual(paths.map((path) => statSync(path).nlink), [1, 1]);
    assert.ok(statSync(hook).isFile());
    assert.deepEqual(pending(f), []);
  });
  it('an empty read-only protected file is named with both readings, untouched, and has no listed or previewed item', async (t) => {
    const f = fixture(t, [item('mcp-channel'), item('velocity-core')]);
    const path = join(f.root, '.mcp.json');
    put(path, '');
    chmodSync(path, 0o444);
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 0 });
    assert.ok(f.printed.includes(`${path}: an empty read-only file — a running agent command's mask (run init again once it ends) or litter a sandbox left (remove it, then run init again)`));
    assert.ok(!f.printed.some((line) => line.includes('mcp-channel')));
    assert.ok(!f.calls.some(({ argv }) => argv[1].endsWith('mcp.mjs')));
    assert.equal(readFileSync(path, 'utf8'), '');
    assert.equal(statSync(path).mode & 0o777, 0o444);
  });
  it('an empty read-only file inside a written directory drops the variant that writes the directory', async (t) => {
    const f = fixture(t, [item('agents'), item('velocity-core')]);
    const path = join(f.root, '.claude/agents/executor.md');
    put(path, '');
    chmodSync(path, 0o444);
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 0 });
    assert.ok(f.printed.some((line) => line.startsWith(`${path}: an empty read-only file`)));
    assert.ok(!f.printed.includes('preview: agents'));
    assert.ok(!f.calls.some(({ argv }) => argv[1].endsWith('cheap-agents.mjs')));
    assert.equal(applies(f).length, 1);
  });
});

describe('spec:init-project/S15 key first, two passes, and restart hint', () => {
  it('the key line comes before the queue', async (t) => {
    const f = fixture(t, [item('jev-connect'), item('velocity-core')], ['', 'n']);
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 0 });
    const key = f.events.findIndex(([kind, prompt]) => kind === 'ask' && prompt === 'y runs its command on this terminal, Enter skips: ');
    const preview = f.events.findIndex(([kind]) => kind === 'spawn');
    assert.ok(key >= 0 && preview > key);
    assert.ok(!f.calls.some(({ argv }) => argv[1].endsWith('jev-connect.mjs')));
  });
  it('unlocked variants are asked once more, never a third time', async (t) => {
    const f = fixture(t, [], ['y', 'y']);
    f.queues = [[item('velocity-core')], [item('gate-hook')], [item('mcp-channel')]];
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 0 });
    assert.deepEqual(f.questions, [APPLY, APPLY]);
    assert.equal(f.recommendations.length, 2);
    assert.ok(f.printed.includes('preview: gate-hook'));
    assert.ok(applies(f).some(({ argv }) => argv[1].endsWith('gate-hook.mjs')));
    assert.ok(!f.printed.includes('preview: mcp-channel'));
    assert.ok(!f.calls.some(({ argv }) => argv[1].endsWith('mcp.mjs')));
  });
  it('nothing unlocked asks nothing more', async (t) => {
    const f = fixture(t, [item('velocity-core')]);
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 0 });
    assert.deepEqual(f.questions, [APPLY]);
    assert.equal(f.recommendations.length, 2);
  });
  it('the restart hint prints exactly when the configuration changed', async (t) => {
    for (const [rel, restart] of [['.claude/settings.json', true], ['docs/ai/notes.json', false]]) {
      const f = fixture(t, [item('velocity-core')]);
      f.respond = (argv) => {
        if (isApply(argv)) put(join(f.root, rel), '{"changed":true}\n');
        return ok();
      };
      const run = need(init, 'runInitProject');
      assert.deepEqual(await run(f.deps), { code: 0 });
      assert.equal(f.printed.filter((line) => line === RESTART).length, restart ? 1 : 0);
    }
  });
});
