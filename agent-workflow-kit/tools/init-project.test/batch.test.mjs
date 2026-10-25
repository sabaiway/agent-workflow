import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { BUNDLED_HOOK_PATH, HOOK_FILE_REL, LANES_REL, buildHookSettingsEntry } from '../gate-hook.mjs';
import { hermeticGitEnv } from '../git-env.mjs';
import { skillTargets } from '../jev-facts.mjs';
import {
  APPLY, FIVE, RESTART, RUN_NONE, SUDO, TOOLS, applies, changed, facts, fixture, hashTree, init, isApply, item, lanes,
  need, ok, pending, policy, put, realFixture,
} from './harness.test.mjs';

const CHECK_DIGEST = 'a'.repeat(64);
const HARNESS_VARIANTS = ['velocity-core', 'kit-tools-tier', 'bridge-tier', 'autonomy-render', 'gate-hook',
  'mcp-channel', 'mcp-channel.differing', 'agents', 'executor-vehicle', 'jev-skill', 'jev-skill.earlier'];

describe('spec:init-project/S11 previews and one terminal y', () => {
  it('every pending variant with preview argv prints its preview and check lines, bridge-tier with its note and velocity-core without one', async (t) => {
    const f = fixture(t, [item('velocity-core'), item('bridge-tier')], ['n']);
    const note = readFileSync(join(TOOLS, '..', 'references/modes/recommendations.md'), 'utf8').split('\n').find((line) => line.startsWith('- `bridge-tier` — '));
    assert.ok(note);
    f.respond = (argv) => ok(argv.includes('--bridge-tier') ? 'BT-PREVIEW' : 'VC-PREVIEW');
    f.deps.checkApply = (variant) => ({ lines: [`CHECK: ${variant}`, `digest: ${CHECK_DIGEST}`], digest: CHECK_DIGEST, refused: [] });
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 0 });
    const start = f.printed.indexOf('preview: velocity-core');
    assert.ok(start >= 0);
    assert.deepEqual(f.printed.slice(start, start + 9), ['preview: velocity-core', 'VC-PREVIEW', 'CHECK: velocity-core', `digest: ${CHECK_DIGEST}`,
      'preview: bridge-tier', 'BT-PREVIEW', 'CHECK: bridge-tier', `digest: ${CHECK_DIGEST}`, note]);
  });
  it('the check facts carry the env every launch receives, with no GIT_ key', async (t) => {
    const f = fixture(t, [item('velocity-core')]);
    f.env.GIT_CONFIG_GLOBAL = join(f.home, '.gitconfig');
    const checked = [];
    f.deps.checkApply = (variant, checkFacts) => {
      checked.push(checkFacts.env);
      return { lines: [`digest: ${CHECK_DIGEST}`], digest: CHECK_DIGEST, refused: [] };
    };
    assert.deepEqual(await need(init, 'runInitProject')(f.deps), { code: 0 });
    assert.ok(checked.length > 0 && f.calls.length > 0);
    for (const env of [...checked, ...f.calls.map(({ opts }) => opts.env)]) {
      assert.deepEqual(env, f.calls[0].opts.env);
      assert.ok(!Object.keys(env).some((key) => /^GIT_/iu.test(key)));
    }
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
  it('checked clean previews handle every spawn outcome, stop later applies on failure, and accept doctor exit 5 after install completed', async (t) => {
    const outcomes = [
      ['velocity-core', ok('', 4), 1],
      ['sandbox-provision.installable', ok('install completed', 5), 0],
      ['sandbox-provision.installable', ok('', 5), 1],
      ...[null, 0].flatMap((status) => ['ENOENT', 'EACCES', 'EPERM'].map((code) => ['velocity-core', { status, error: new Error(code) }, 1])),
      ...[null, 0].map((status) => ['velocity-core', { status, signal: 'SIGTERM' }, 1]),
      ['velocity-core', new Error('synchronous throw'), 1],
      ['velocity-core', ok('writer refused', 128), 1],
      ['velocity-core', undefined, 1],
      ['velocity-core', { status: null, error: new Error('maxBuffer') }, 1],
      ['velocity-core', ok(), 0],
    ];
    for (const [variant, result, code] of outcomes) await t.test(`${variant}: ${result?.error?.message ?? result?.signal ?? result?.message ?? result?.status ?? 'empty answer'} (exit ${result?.status ?? null}, init ${code})`, async (t) => {
      const f = fixture(t, [item(variant), item('gate-hook')], variant === 'velocity-core' ? ['y'] : ['y', 'y']);
      f.deps.checkApply = (checked) => ({ lines: [`CHECK: ${checked}`], digest: CHECK_DIGEST, refused: [] });
      f.respond = (argv) => {
        if (argv[1].endsWith('gate-hook.mjs')) return ok();
        if (isApply(argv) && result instanceof Error) throw result;
        if (isApply(argv)) return result;
        if (argv[1].endsWith('autonomy-doctor.mjs')) return ok('status=missing-binaries\n--apply apt-get:bubblewrap', 3);
        return ok();
      };
      const run = need(init, 'runInitProject');
      assert.deepEqual(await run(f.deps), { code });
      assert.ok(f.printed.includes('CHECK: gate-hook'));
      assert.equal(applies(f).some(({ argv }) => argv[1].endsWith('gate-hook.mjs')), code === 0);
      if (code === 1) {
        assert.ok(f.printed.includes(`apply failed (exit ${result?.status ?? null}): ${variant}`));
        assert.ok(f.printed.includes('not applied: gate-hook — an earlier apply failed'));
        const cause = result?.error?.message ?? result?.signal ?? result?.message ?? result?.stdout ?? 'empty answer';
        if (cause) assert.ok(f.printed.includes(cause));
      } else if (variant === 'sandbox-provision.installable') {
        assert.ok(f.printed.includes('install completed'));
        assert.ok(!f.printed.includes('apply failed (exit 5): sandbox-provision.installable'));
      }
    });
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

describe('spec:init-project/S24 danger check beside each harness and each kit preview', () => {
  it('selects by argv presence, prints each check after its preview, and removes refused or throwing checks before one y', async (t) => {
    for (const mode of ['within', 'refused', 'throw']) await t.test(mode, async (t) => {
      const queue = [...HARNESS_VARIANTS.map((variant) => ({ ...item(variant), lane: 'harness' })), { ...item('agents.not-current'), lane: 'kit' }, item('sandbox-provision.installable'), item('review-recipe')];
      const f = fixture(t, queue, ['y', '']);
      const checked = [];
      const refused = mode === 'within' ? [] : ['bridge-tier'];
      const keys = ['sandbox.network.allowedDomains', 'sandbox.excludedCommands'];
      f.respond = (argv) => ok(argv[1].endsWith('autonomy-doctor.mjs') ? 'status=missing-binaries\n--apply apt-get:bubblewrap' : 'PREVIEW', argv[1].endsWith('autonomy-doctor.mjs') ? 3 : 0);
      f.deps.checkApply = (variant, previewFacts, deps) => {
        checked.push(variant);
        const { toolsDir, root, env, home, platform, tuple } = previewFacts;
        assert.deepEqual({ toolsDir, root, env, home, platform, tuple }, { ...facts(f), tuple: undefined });
        assert.deepEqual(deps, {});
        if (mode === 'throw' && variant === 'bridge-tier') throw new Error('check threw');
        return { lines: [`CHECK: ${variant}`, `digest: ${CHECK_DIGEST}`], digest: CHECK_DIGEST,
          refused: mode === 'refused' && variant === 'bridge-tier' ? keys.map((key) => ({ path: '.claude/settings.json', key, reason: `beyond the declared scope of ${variant}` })) : [] };
      };
      assert.deepEqual(await need(init, 'runInitProject')(f.deps), { code: 0 });
      assert.deepEqual(checked, [...HARNESS_VARIANTS, 'agents.not-current']);
      for (const variant of [...HARNESS_VARIANTS, 'agents.not-current'].filter((variant) => mode !== 'throw' || variant !== 'bridge-tier')) {
        const start = f.printed.indexOf(`preview: ${variant}`);
        assert.deepEqual(f.printed.slice(start + 2, start + 4), [`CHECK: ${variant}`, `digest: ${CHECK_DIGEST}`]);
      }
      assert.deepEqual(applies(f).map(({ argv }) => argv), [...HARNESS_VARIANTS.filter((variant) => !refused.includes(variant)).map((variant) => need(lanes, 'consoleArgv')(variant, facts(f)).apply), ['node', join(TOOLS, 'cheap-agents.mjs'), '--apply', '--cwd', f.root]]);
      assert.deepEqual(f.questions, [APPLY, SUDO]);
      assert.ok(f.printed.includes('listed, not applied here: review-recipe — review-recipe'));
      if (mode !== 'within') {
        const line = `not applied: bridge-tier — the danger check refused: ${mode === 'throw' ? 'check threw' : keys.join(', ')}`;
        const index = f.events.findIndex(([kind, text]) => kind === 'print' && text === line);
        assert.ok(index >= 0 && index < f.events.findIndex(([kind, text]) => kind === 'ask' && text === APPLY));
      }
    });
  });
});

describe('spec:init-project/S30 init over the three writers with real writers', () => {
  const placeStaleHook = (f) => {
    put(join(f.root, HOOK_FILE_REL), 'process.exit(0);\n');
    put(join(f.root, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [buildHookSettingsEntry()] } }));
  };

  it('gate-hook over a differing unwired hook and state-block apply on one y, print each check after its preview, and leave no pending item', async (t) => {
    const variants = ['gate-hook', 'state-block'];
    const f = realFixture(t, new Set(variants));
    put(join(f.root, HOOK_FILE_REL), 'process.exit(0);\n');
    assert.deepEqual(pending(f), variants);
    const respond = f.respond;
    f.respond = (argv, opts) => {
      if (argv[1] !== join(TOOLS, 'state-block-hook.mjs')) return respond(argv, opts);
      assert.equal(argv[0], 'node');
      const result = spawnSync(process.execPath, argv.slice(1), { cwd: opts.cwd, env: opts.env, encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 0 });
    assert.deepEqual(f.questions, [APPLY]);
    assert.deepEqual(applies(f).map(({ argv }) => argv), [
      ['node', join(TOOLS, 'gate-hook.mjs'), '--apply', '--cwd', f.root],
      ['node', join(TOOLS, 'state-block-hook.mjs'), '--apply', '--cwd', f.root],
    ]);
    for (const [index, variant] of variants.entries()) {
      const preview = f.printed.indexOf(`preview: ${variant}`);
      const scope = f.printed.indexOf(`scope: within the declared scope of ${variant}`);
      const end = f.printed.indexOf(index === 0 ? `preview: ${variants[1]}` : RUN_NONE);
      assert.ok(preview >= 0 && scope > preview + 1 && end > scope, `${variant}: check lines follow its preview`);
    }
    assert.ok(f.printed.includes(RESTART));
    assert.deepEqual(pending(f), []);
    assert.equal(readFileSync(join(f.root, HOOK_FILE_REL), 'utf8'), readFileSync(BUNDLED_HOOK_PATH, 'utf8'));
    assert.equal(readFileSync(join(f.root, '.claude/hooks/state-block-guard.mjs'), 'utf8'),
      readFileSync(join(TOOLS, '../references/hooks/state-block-guard.mjs'), 'utf8'));
    const settings = JSON.parse(readFileSync(join(f.root, '.claude/settings.json'), 'utf8'));
    const leaf = await import('../state-block-hook.mjs').catch(() => ({}));
    assert.equal(need(leaf, 'isStopHookWired')(settings), true);
    assert.deepEqual(settings.hooks.Stop, [need(leaf, 'buildStopHookEntry')()]);
    assert.deepEqual(settings.hooks.PreToolUse, [buildHookSettingsEntry()]);
  });

  it('gate-hook.not-current over a wired differing hook is previewed by the plain dry run, applied on one y with both settings files byte-identical, and listed no more', async (t) => {
    const f = realFixture(t, new Set(['gate-hook.not-current']));
    placeStaleHook(f);
    put(join(f.root, LANES_REL), JSON.stringify({ readLane: true }));
    put(join(f.root, '.claude/settings.local.json'), '{"otherLocal":"kept"}\n');
    const settingsBytes = () => ['.claude/settings.json', '.claude/settings.local.json'].map((rel) => readFileSync(join(f.root, rel)));
    const before = settingsBytes();
    assert.deepEqual(pending(f), ['gate-hook.not-current']);
    assert.deepEqual(await need(init, 'runInitProject')(f.deps), { code: 0 });
    assert.deepEqual(f.questions, [APPLY]);
    assert.deepEqual(f.calls.map(({ argv }) => argv), [
      ['node', join(TOOLS, 'gate-hook.mjs'), '--cwd', f.root],
      ['node', join(TOOLS, 'gate-hook.mjs'), '--apply', '--cwd', f.root],
    ]);
    const preview = f.printed.indexOf('preview: gate-hook.not-current');
    const scope = f.printed.indexOf('scope: within the declared scope of gate-hook.not-current');
    assert.ok(preview >= 0 && scope > preview + 1 && f.printed.indexOf(RUN_NONE) > scope);
    assert.deepEqual(pending(f), []);
    assert.equal(readFileSync(join(f.root, HOOK_FILE_REL), 'utf8'), readFileSync(BUNDLED_HOOK_PATH, 'utf8'));
    assert.deepEqual(settingsBytes(), before);
  });

  it('on a fresh git project with no package.json a pending enforcement item is previewed by the leaf\'s dry run and applied on the one y, the record refreshed', async (t) => {
    const f = realFixture(t, new Set(['enforcement', 'state-block']));
    const gitDir = (process.env.PATH ?? '').split(delimiter).find((dir) => existsSync(join(dir, 'git')));
    assert.ok(gitDir, 'git must be on PATH');
    const git = spawnSync('git', ['init', '-q'], { cwd: f.root, env: hermeticGitEnv(process.env, f.home), encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
    f.env.PATH = [dirname(process.execPath), gitDir, f.env.PATH].join(delimiter);
    assert.equal(existsSync(join(f.root, 'package.json')), false);
    assert.deepEqual(pending(f), ['enforcement', 'state-block']);
    const respond = f.respond;
    f.respond = (argv, opts) => {
      if (![join(TOOLS, 'git-hooks.mjs'), join(TOOLS, 'state-block-hook.mjs')].includes(argv[1])) return respond(argv, opts);
      const result = spawnSync(process.execPath, argv.slice(1), { cwd: opts.cwd, env: opts.env, encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    assert.deepEqual(await need(init, 'runInitProject')(f.deps), { code: 0 });
    assert.deepEqual(f.questions, [APPLY]);
    assert.deepEqual(applies(f).map(({ argv }) => argv), [
      ['node', join(TOOLS, 'git-hooks.mjs'), '--apply', '--enforcement', '--cwd', f.root],
      ['node', join(TOOLS, 'state-block-hook.mjs'), '--apply', '--cwd', f.root],
    ]);
    const lines = f.printed.flatMap((line) => line.split('\n'));
    const preview = lines.indexOf('preview: enforcement');
    const scope = lines.indexOf('scope: within the declared scope of enforcement');
    const next = lines.indexOf('preview: state-block');
    const bundle = join(TOOLS, '../references/scripts');
    const names = readdirSync(bundle).filter((name) => name.endsWith('.mjs')).sort();
    assert.ok(preview >= 0 && scope > preview + names.length && next > scope);
    assert.deepEqual(lines.slice(preview + 1, preview + 1 + names.length), names.map((name) =>
      `copy: scripts/${name} created sha256:${createHash('sha256').update(readFileSync(join(bundle, name))).digest('hex')}`));
    for (const name of names) {
      assert.deepEqual(readFileSync(join(f.root, 'scripts', name)), readFileSync(join(bundle, name)));
    }
    assert.match(readFileSync(join(f.root, '.git/hooks/pre-commit'), 'utf8'), /:install-git-hooks\.mjs$/m);
    assert.deepEqual(pending(f), []);
  });
});

describe('spec:init-project/S43 — init over the worktrees grant', () => {
  it('a pending worktrees-dir previews and checks the real grant, applies on one y, and leaves no pending item', async (t) => {
    const f = realFixture(t, new Set(['worktrees-dir']));
    const parent = join(dirname(f.root), 'farm');
    put(join(f.root, 'docs/ai/worktrees.json'), JSON.stringify({ parentDir: parent }));
    const settings = join(f.root, '.claude/settings.json');
    const before = readFileSync(settings);
    assert.equal(existsSync(parent), false);
    assert.deepEqual(pending(f), ['worktrees-dir']);
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 0 });
    assert.deepEqual(f.questions, [APPLY]);
    assert.deepEqual(applies(f).map(({ argv }) => argv), [
      ['node', join(TOOLS, 'velocity-profile.mjs'), '--apply', '--worktrees', '--cwd', f.root],
    ]);
    const lines = f.printed.flatMap((line) => line.split('\n'));
    const preview = lines.indexOf('preview: worktrees-dir');
    const scope = lines.indexOf('scope: within the declared scope of worktrees-dir');
    assert.ok(preview >= 0 && scope > preview + 1 && lines.indexOf(RUN_NONE) > scope);
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, '.claude/settings.local.json'), 'utf8')),
      { sandbox: { filesystem: { allowWrite: [parent] } } });
    assert.ok(statSync(parent).isDirectory());
    assert.deepEqual(readFileSync(settings), before);
    assert.ok(f.printed.includes(RESTART));
    assert.deepEqual(pending(f), []);
  });

  it('a pending worktrees-dir.home is listed and not applied when the default parent holds the home', async (t) => {
    const f = realFixture(t, new Set(['worktrees-dir.home']));
    assert.equal(existsSync(join(f.root, 'docs/ai/worktrees.json')), false);
    assert.deepEqual(pending(f), ['worktrees-dir.home']);
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 0 });
    assert.ok(f.printed.some((line) => line.startsWith('listed, not applied here: worktrees-dir.home — ')));
    assert.ok(!f.calls.some(({ argv }) => argv[1] === join(TOOLS, 'velocity-profile.mjs') && argv.includes('--worktrees')));
    assert.deepEqual(applies(f), []);
    assert.equal(existsSync(join(f.root, '.claude/settings.local.json')), false);
    assert.deepEqual(pending(f), ['worktrees-dir.home']);
  });
});

describe('spec:init-project/S45 — the console y re-judges the worktrees grant', () => {
  const REJUDGED = 'not applied: worktrees-dir — its danger check no longer answers the previewed result';

  it('a link planted at the parent before the y leaves the grant and every later item unapplied, the link target untouched', async (t) => {
    const f = realFixture(t, new Set(['velocity-core', 'worktrees-dir']));
    const parent = join(dirname(f.root), 'farm');
    const other = join(dirname(f.root), 'other');
    mkdirSync(other);
    put(join(f.root, 'docs/ai/worktrees.json'), JSON.stringify({ parentDir: parent }));
    assert.deepEqual(pending(f), ['velocity-core', 'worktrees-dir']);
    f.answers = [async () => {
      symlinkSync(other, parent);
      return 'y';
    }];
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 1 });
    assert.ok(f.printed.includes(`${REJUDGED}: its digest moved`));
    assert.ok(f.printed.includes('not applied: velocity-core — an earlier item\'s danger check no longer answers the previewed result'));
    assert.deepEqual(applies(f), []);
    assert.equal(existsSync(join(f.root, '.claude/settings.local.json')), false);
    assert.deepEqual(readdirSync(other), []);
  });

  it('a re-judge that throws leaves the grant unapplied', async (t) => {
    const f = realFixture(t, new Set(['worktrees-dir']));
    put(join(f.root, 'docs/ai/worktrees.json'), JSON.stringify({ parentDir: join(dirname(f.root), 'farm') }));
    let checks = 0;
    f.deps.checkApply = () => {
      checks += 1;
      if (checks > 1) throw new Error('the check could not run');
      return { lines: [], digest: CHECK_DIGEST, refused: [] };
    };
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 1 });
    assert.equal(checks, 2);
    assert.ok(f.printed.includes(`${REJUDGED}: the check could not run`));
    assert.deepEqual(applies(f), []);
  });

  it('a re-judge that refuses leaves the grant unapplied, naming the refused keys', async (t) => {
    const f = realFixture(t, new Set(['worktrees-dir']));
    put(join(f.root, 'docs/ai/worktrees.json'), JSON.stringify({ parentDir: join(dirname(f.root), 'farm') }));
    let checks = 0;
    f.deps.checkApply = () => {
      checks += 1;
      const refused = checks > 1 ? [{ key: 'sandbox.filesystem.allowWrite' }, { key: 'farm' }] : [];
      return { lines: [], digest: CHECK_DIGEST, refused };
    };
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 1 });
    assert.ok(f.printed.includes(`${REJUDGED}: it refuses sandbox.filesystem.allowWrite, farm`));
    assert.deepEqual(applies(f), []);
  });

  it('a batch whose earlier writer creates .claude applies the grant first and then the rest', async (t) => {
    const f = realFixture(t, new Set(['velocity-core', 'worktrees-dir']));
    const parent = join(dirname(f.root), 'farm');
    rmSync(join(f.root, '.claude'), { recursive: true });
    put(join(f.root, 'docs/ai/worktrees.json'), JSON.stringify({ parentDir: parent }));
    assert.deepEqual(pending(f), ['velocity-core', 'worktrees-dir']);
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 0 });
    assert.deepEqual(applies(f).map(({ argv }) => argv.includes('--worktrees')), [true, false]);
    assert.ok(!f.printed.some((line) => line.startsWith(REJUDGED)));
    assert.ok(existsSync(join(f.root, '.claude/settings.json')));
    assert.ok(existsSync(join(f.root, '.claude/settings.local.json')));
    assert.ok(statSync(parent).isDirectory());
    assert.deepEqual(pending(f), []);
  });
});

describe('spec:init-project/S49 — init previews and applies the new variants on one y', () => {
  const createFixture = (t, variants) => {
    const f = realFixture(t, new Set(variants));
    f.respond = (argv, opts) => {
      assert.equal(argv[0], 'node');
      assert.ok(['velocity-profile.mjs', 'gate-hook.mjs', 'mcp.mjs', 'attribution.mjs', 'hide-footprint.mjs'].some((name) => argv[1] === join(TOOLS, name)));
      return spawnSync(process.execPath, argv.slice(1), { cwd: opts.cwd, env: opts.env, encoding: 'utf8' });
    };
    return f;
  };

  it('attribution previews the real writer before its check and applies on one y with a restart hint', async (t) => {
    const f = createFixture(t, ['attribution']);
    put(join(f.root, 'AGENTS.md'), '> **Agent attribution: off** (chosen at setup).\n');
    assert.deepEqual(pending(f), ['attribution']);
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: 0 });
    assert.deepEqual(f.questions, [APPLY]);
    const lines = f.printed.flatMap((line) => line.split('\n'));
    const preview = lines.indexOf('preview: attribution');
    const dryRun = lines.indexOf('would set attribution (.claude/settings.json): {"commit":"","pr":"","sessionUrl":false}');
    const check = lines.indexOf('.claude/settings.json:');
    const scope = lines.indexOf('scope: within the declared scope of attribution');
    assert.ok(preview >= 0 && dryRun > preview && check > dryRun && scope > check);
    assert.deepEqual(applies(f).map(({ argv }) => argv), [['node', join(TOOLS, 'attribution.mjs'), '--apply', '--cwd', f.root]]);
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, '.claude/settings.json'), 'utf8')).attribution, { commit: '', pr: '', sessionUrl: false });
    assert.ok(f.printed.includes(RESTART));
    assert.deepEqual(pending(f), []);
  });

  for (const moved of [false, true]) it(moved
    ? 'a legacy line added before the y leaves footprint-global unapplied with the moved-digest reason'
    : 'footprint-global previews removal and applies before velocity-core on one y, preserving every user byte', async (t) => {
    const f = createFixture(t, moved ? ['footprint-global'] : ['velocity-core', 'footprint-global']);
    const global = join(f.home, '.gitignore_global');
    const before = 'user-first\r\n# agent-workflow-kit hidden mode (machine-local, applies to every repo on this host)\n/AGENTS.md\n/docs/ai/\n/scripts/check-docs-size.mjs\nuser-last\n';
    put(join(f.home, '.gitconfig'), '[core]\n\texcludesFile = ~/.gitignore_global\n');
    put(global, before);
    f.env.GIT_CONFIG_GLOBAL = join(f.home, '.gitconfig');
    f.env.GIT_CONFIG_NOSYSTEM = '1';
    assert.deepEqual(pending(f), moved ? ['footprint-global'] : ['velocity-core', 'footprint-global']);
    if (moved) f.answers = [async () => {
      put(global, readFileSync(global, 'utf8') + '/docs/plans/\n');
      return 'y';
    }];
    const run = need(init, 'runInitProject');
    assert.deepEqual(await run(f.deps), { code: moved ? 1 : 0 });
    assert.deepEqual(f.questions, [APPLY]);
    const lines = f.printed.flatMap((line) => line.split('\n'));
    const preview = lines.indexOf('preview: footprint-global');
    const dryRun = lines.indexOf(`  • would remove the legacy machine-global block from ${global} (4 line(s)):`);
    assert.ok(preview >= 0 && dryRun > preview);
    assert.deepEqual(f.calls.find(({ argv }) => argv[1] === join(TOOLS, 'hide-footprint.mjs'))?.argv,
      ['node', join(TOOLS, 'hide-footprint.mjs'), '--remove-global', '--dry-run', '--dir', f.root]);
    const launches = f.calls.filter(({ argv }) => isApply(argv) || (argv.includes('--remove-global') && !argv.includes('--dry-run')));
    if (moved) {
      assert.ok(f.printed.includes('not applied: footprint-global — its danger check no longer answers the previewed result: its digest moved'));
      assert.deepEqual(readFileSync(global), Buffer.from(before + '/docs/plans/\n'));
      assert.deepEqual(launches, []);
      assert.deepEqual(applies(f), []);
    } else {
      assert.deepEqual(launches.map(({ argv }) => argv), [
        ['node', join(TOOLS, 'hide-footprint.mjs'), '--remove-global', '--dir', f.root],
        ['node', join(TOOLS, 'velocity-profile.mjs'), '--apply', '--cwd', f.root],
      ]);
      assert.deepEqual(readFileSync(global), Buffer.from('user-first\r\nuser-last\n'));
      assert.deepEqual(pending(f), []);
    }
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
      f.deps.checkApply = () => ({ lines: [], digest: CHECK_DIGEST, refused: [] });
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
