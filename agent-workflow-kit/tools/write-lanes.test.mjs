import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SEVERITIES } from './recommendations.mjs';
import { skillTargets } from './jev-facts.mjs';

const lanes = await import('./write-lanes.mjs').catch(() => ({}));
const need = (mod, name) => {
  if (!(name in mod)) {
    throw new Error(`${name} is absent`);
  }
  return mod[name];
};
const TOOLS = join('/', 'home', "o'brien kit", '.claude', 'skills', 'agent-workflow-kit', 'tools');
const ROOT = join('/', 'work', 'my project');
const FORM_A = [
  'velocity-core', 'kit-tools-tier', 'bridge-tier', 'autonomy-render', 'gate-hook', 'read-lane.missing',
  'mcp-channel', 'mcp-channel.differing', 'agents', 'executor-vehicle', 'sandbox-provision.installable',
  'jev-skill', 'jev-skill.earlier',
];
const FORM_B = ['jev-connect'];
const FORM_C = [
  'family-freshness', 'sandbox-provision', 'commit-guard', 'gate-hook.marker-stale', 'read-lane.stale',
  'state-block', 'enforcement',
];
const CONSOLE = [...FORM_A, ...FORM_B, ...FORM_C];
const ROUTE = "applies at your next npx @sabaiway/agent-workflow-kit@latest init, run from this project's folder";
const RESTART = '; if init reports it not pending, restart the agent from that console';
const RESTART_VARIANTS = ['bridge-tier', 'jev-connect', 'jev-skill', 'jev-skill.earlier', 'sandbox-provision.installable'];
const HOME = '/home/u';
const PROJECT = '/home/u/proj';
const HOOKS = join(PROJECT, '.git', 'hooks');
const PROTECTION = { root: PROJECT, home: HOME, hooksDir: HOOKS };
const createFacts = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'write-lanes-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { toolsDir: TOOLS, root: ROOT, env: {}, home, platform: 'linux', tuple: 'apt-get:bubblewrap,socat' };
};
const expectedArgv = (FACTS, claudeDir = join(FACTS.home, '.claude')) => {
  const table = [
    ['velocity-core', 'velocity-profile.mjs', ['--cwd', ROOT], ['--apply', '--cwd', ROOT]],
    ['kit-tools-tier', 'velocity-profile.mjs', ['--kit-tools', '--cwd', ROOT], ['--apply', '--kit-tools', '--cwd', ROOT]],
    ['bridge-tier', 'velocity-profile.mjs', ['--bridge-tier', '--cwd', ROOT], ['--apply', '--bridge-tier', '--cwd', ROOT]],
    ['autonomy-render', 'velocity-profile.mjs', ['--autonomy', '--cwd', ROOT], ['--autonomy', '--apply', '--cwd', ROOT]],
    ['gate-hook', 'gate-hook.mjs', ['--cwd', ROOT], ['--apply', '--cwd', ROOT]],
    ['read-lane.missing', 'gate-hook.mjs', ['--cwd', ROOT], ['--apply', '--cwd', ROOT]],
    ['mcp-channel', 'mcp.mjs', ['--cwd', ROOT], ['--apply', '--cwd', ROOT]],
    ['mcp-channel.differing', 'mcp.mjs', ['--replace', '--cwd', ROOT], ['--replace', '--apply', '--cwd', ROOT]],
    ['agents', 'cheap-agents.mjs', ['--cwd', ROOT], ['--apply', '--cwd', ROOT]],
    ['executor-vehicle', 'cheap-agents.mjs', ['--cwd', ROOT], ['--apply', '--cwd', ROOT]],
    ['sandbox-provision.installable', 'autonomy-doctor.mjs', [], ['--apply', 'apt-get:bubblewrap,socat']],
    ['jev-skill', 'jev-skill.mjs', ['--claude-dir', claudeDir], ['--apply', '--claude-dir', claudeDir]],
    ['jev-skill.earlier', 'jev-skill.mjs', ['--claude-dir', claudeDir], ['--apply', '--claude-dir', claudeDir]],
  ];
  return Object.fromEntries(table.map(([variant, file, preview, apply]) => [variant, {
    preview: ['node', join(TOOLS, file), ...preview],
    apply: ['node', join(TOOLS, file), ...apply],
  }]));
};

describe('spec:init-project/S1 every severity key has a lane and the three console forms are disjoint', () => {
  it('every severity key has a frozen lane, installable is registered, masked is retired, and laneOf agrees', () => {
    const keys = Object.keys(SEVERITIES).sort();
    const variantLanes = need(lanes, 'VARIANT_LANES');
    const consoleLane = need(lanes, 'LANE_CONSOLE');
    const chatLane = need(lanes, 'LANE_CHAT');
    const laneOf = need(lanes, 'laneOf');
    assert.equal(Object.isFrozen(variantLanes), true);
    assert.equal(Object.getPrototypeOf(variantLanes), Object.prototype);
    assert.deepEqual(Object.keys(variantLanes).sort(), keys);
    assert.equal(Object.hasOwn(variantLanes, 'sandbox-provision.installable'), true);
    assert.equal(Object.hasOwn(SEVERITIES, 'sandbox-provision.installable'), true);
    assert.equal(Object.hasOwn(variantLanes, 'mcp-channel.masked'), false);
    assert.equal(Object.hasOwn(SEVERITIES, 'mcp-channel.masked'), false);
    assert.equal(consoleLane, 'console');
    assert.equal(chatLane, 'chat');
    for (const variant of keys) {
      assert.ok([consoleLane, chatLane].includes(variantLanes[variant]), variant);
      assert.equal(laneOf(variant), variantLanes[variant], variant);
    }
  });

  it('the console set is exactly the three forms and every other key, including the named exceptions, is chat', () => {
    const keys = Object.keys(SEVERITIES);
    const variantLanes = need(lanes, 'VARIANT_LANES');
    assert.deepEqual(keys.filter((v) => variantLanes[v] === 'console').sort(), [...CONSOLE].sort());
    for (const variant of keys.filter((v) => !CONSOLE.includes(v))) {
      assert.equal(variantLanes[variant], 'chat', variant);
    }
    for (const variant of ['read-lane', 'worktrees-dir', 'review-recipe', 'sandbox-masks']) {
      assert.equal(variantLanes[variant], 'chat', variant);
    }
  });

  it('preview-and-apply, apply-only, and no-argv forms partition console keys while every chat key answers null', (t) => {
    const FACTS = createFacts(t);
    const keys = Object.keys(SEVERITIES);
    const consoleArgv = need(lanes, 'consoleArgv');
    const variantLanes = need(lanes, 'VARIANT_LANES');
    const answers = keys.map((variant) => ({ variant, argv: consoleArgv(variant, FACTS) }));
    const formA = answers.filter(({ argv }) => argv !== null && argv.preview !== null && Array.isArray(argv.apply));
    const formB = answers.filter(({ argv }) => argv !== null && argv.preview === null && Array.isArray(argv.apply));
    const formC = answers.filter(({ variant, argv }) => variantLanes[variant] === 'console' && argv === null);
    const groups = [formA, formB, formC].map((group) => group.map(({ variant }) => variant).sort());
    assert.deepEqual(groups, [[...FORM_A].sort(), [...FORM_B].sort(), [...FORM_C].sort()]);
    for (const [index, group] of groups.entries()) {
      for (const other of groups.slice(index + 1)) {
        assert.deepEqual(group.filter((v) => other.includes(v)), []);
      }
    }
    for (const { variant, argv } of answers.filter(({ variant }) => variantLanes[variant] === 'chat')) {
      assert.equal(argv, null, variant);
    }
  });

  it('an unregistered variant makes laneOf, consoleArgv, and routeLine throw an Error naming it', (t) => {
    const FACTS = createFacts(t);
    const laneOf = need(lanes, 'laneOf');
    const consoleArgv = need(lanes, 'consoleArgv');
    const routeLine = need(lanes, 'routeLine');
    const error = { name: 'Error', message: /no-such-variant/ };
    assert.throws(() => laneOf('no-such-variant'), error);
    assert.throws(() => consoleArgv('no-such-variant', FACTS), error);
    assert.throws(() => routeLine('no-such-variant'), error);
  });
});

describe('spec:init-project/S2 the project list takes precedence over the home protected class', () => {
  it('each project-list path, including nested agents, hooks, skills, and the git hook, is protected', () => {
    const paths = [
      '.claude/settings.json', '.claude/settings.local.json', '.mcp.json', '.git/config', '.claude/agents',
      '.claude/agents/executor.md', '.claude/hooks/agent-workflow-gates.mjs', '.claude/skills/x/SKILL.md',
    ].map((path) => join(PROJECT, path));
    const isProtectedPath = need(lanes, 'isProtectedPath');
    for (const path of [...paths, join(HOOKS, 'pre-commit')]) {
      assert.equal(isProtectedPath(path, PROTECTION), true, path);
    }
  });

  it('every other project path is unprotected although the project sits under the home', () => {
    const paths = ['docs/ai/acks.json', 'docs/ai/autonomy.json', 'src/a.mjs', '.claude/commands/x.md'];
    const isProtectedPath = need(lanes, 'isProtectedPath');
    for (const path of paths) {
      assert.equal(isProtectedPath(join(PROJECT, path), PROTECTION), false, path);
    }
  });

  it('home paths outside the project are protected and paths outside both are not', () => {
    const homePaths = ['/home/u/.claude/settings.json', '/home/u/.bashrc', '/home/u/other/x'];
    const outsidePaths = ['/etc/hosts', '/tmp/x'];
    const isProtectedPath = need(lanes, 'isProtectedPath');
    for (const path of homePaths) {
      assert.equal(isProtectedPath(path, PROTECTION), true, path);
    }
    for (const path of outsidePaths) {
      assert.equal(isProtectedPath(path, PROTECTION), false, path);
    }
  });

  it('core.hooksPath inside the work tree is protected and a hooksDir outside the project is refused', () => {
    const inside = { ...PROTECTION, hooksDir: join(PROJECT, '.githooks') };
    const outside = { ...PROTECTION, hooksDir: '/home/u/shared-hooks' };
    const isProtectedPath = need(lanes, 'isProtectedPath');
    assert.equal(isProtectedPath(join(PROJECT, '.githooks', 'pre-commit'), inside), true);
    assert.throws(() => isProtectedPath(join(outside.hooksDir, 'pre-commit'), outside), {
      name: 'Error', message: /hooksDir outside the project/,
    });
  });
});

describe('spec:init-project/S3 each form uses unquoted injected tool paths and declares its writes and route', () => {
  it('every form (a) preview and apply matches the table and jev-connect has only an apply with the unquoted tool path', (t) => {
    const FACTS = createFacts(t);
    const expected = expectedArgv(FACTS);
    const consoleArgv = need(lanes, 'consoleArgv');
    for (const variant of FORM_A) {
      assert.deepEqual(consoleArgv(variant, FACTS), expected[variant], variant);
    }
    assert.deepEqual(consoleArgv('jev-connect', FACTS), {
      preview: null, apply: ['node', join(TOOLS, 'jev-connect.mjs')],
    });
  });

  it('the jev-skill claude dir follows an absolute injected environment value and falls back for a relative one', (t) => {
    const FACTS = createFacts(t);
    const absolute = { ...FACTS, env: { CLAUDE_CONFIG_DIR: '/cc' } };
    const relative = { ...FACTS, env: { CLAUDE_CONFIG_DIR: 'relative' } };
    const expectedAbsolute = expectedArgv(FACTS, '/cc');
    const expectedRelative = expectedArgv(FACTS);
    const consoleArgv = need(lanes, 'consoleArgv');
    for (const variant of ['jev-skill', 'jev-skill.earlier']) {
      assert.deepEqual(consoleArgv(variant, absolute), expectedAbsolute[variant], variant);
      assert.deepEqual(consoleArgv(variant, relative), expectedRelative[variant], variant);
    }
  });

  it('injecting win32 changes no argv for any preview-and-apply or apply-only key', (t) => {
    const FACTS = createFacts(t);
    const windows = { ...FACTS, platform: 'win32' };
    const consoleArgv = need(lanes, 'consoleArgv');
    for (const variant of [...FORM_A, ...FORM_B]) {
      assert.deepEqual(consoleArgv(variant, windows), consoleArgv(variant, FACTS), variant);
    }
  });

  it('no element of any argv and no route line carries the npx package root', (t) => {
    const FACTS = createFacts(t);
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const keys = [...new Set([...Object.keys(SEVERITIES), ...CONSOLE])];
    const consoleArgv = need(lanes, 'consoleArgv');
    const routeLine = need(lanes, 'routeLine');
    for (const variant of keys) {
      const argv = consoleArgv(variant, FACTS);
      for (const element of [...(argv?.preview ?? []), ...(argv?.apply ?? [])]) {
        assert.equal(element.includes(packageRoot), false, `${variant}: ${element}`);
      }
      const route = routeLine(variant);
      if (route !== null) {
        assert.equal(route.includes(packageRoot), false, variant);
      }
    }
  });

  it('writesOf matches every form (a) target, is null for form (c) and chat, and selects startup files in an empty temp home', (t) => {
    const FACTS = createFacts(t);
    const settings = [join(ROOT, '.claude', 'settings.json')];
    const hook = [join(ROOT, '.claude', 'hooks', 'agent-workflow-gates.mjs'), ...settings];
    const mcp = [join(ROOT, '.mcp.json'), ...settings];
    const agents = [join(ROOT, '.claude', 'agents')];
    const skills = skillTargets({ home: FACTS.home, claudeDir: join(FACTS.home, '.claude') }).map(({ path }) => path);
    const expected = {
      'velocity-core': settings,
      'kit-tools-tier': settings,
      'bridge-tier': settings,
      'autonomy-render': settings,
      'gate-hook': hook,
      'read-lane.missing': hook,
      'mcp-channel': mcp,
      'mcp-channel.differing': mcp,
      agents,
      'executor-vehicle': agents,
      'sandbox-provision.installable': [],
      'jev-skill': skills,
      'jev-skill.earlier': skills,
    };
    const nullVariants = [...new Set([...FORM_C, ...Object.keys(SEVERITIES).filter((v) => !CONSOLE.includes(v))])];
    const writesOf = need(lanes, 'writesOf');
    for (const variant of FORM_A) {
      assert.deepEqual(writesOf(variant, FACTS), expected[variant], variant);
    }
    for (const variant of nullVariants) {
      assert.equal(writesOf(variant, FACTS), null, variant);
    }
    assert.deepEqual(writesOf('jev-connect', { ...FACTS, env: { SHELL: '/bin/zsh' } }), [join(FACTS.home, '.zshrc')]);
    assert.deepEqual(writesOf('jev-connect', { ...FACTS, env: { SHELL: '/bin/bash' } }), [
      join(FACTS.home, '.bashrc'), join(FACTS.home, '.bash_profile'),
    ]);
    assert.deepEqual(writesOf('jev-connect', { ...FACTS, platform: 'win32', env: { SHELL: '/bin/bash' } }), []);
  });

  it('routeLine is exactly ROUTE with the specified RESTART suffix, null for every other key, and never carries HAND-APPLY', () => {
    const keys = [...new Set([...Object.keys(SEVERITIES), ...CONSOLE])];
    const routed = [...FORM_A, ...FORM_B, 'family-freshness'];
    const routeLine = need(lanes, 'routeLine');
    for (const variant of keys) {
      const expected = RESTART_VARIANTS.includes(variant) ? ROUTE + RESTART : routed.includes(variant) ? ROUTE : null;
      const route = routeLine(variant);
      assert.equal(route, expected, variant);
      if (route !== null) {
        assert.equal(route.includes('HAND-APPLY'), false, variant);
      }
    }
  });
});
