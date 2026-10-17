import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SEVERITIES } from './recommendations.mjs';
import { claudeDirOf, quoteArg, skillTargets } from './jev-facts.mjs';
import * as lanes from './write-lanes.mjs';

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
  'gate-hook.marker-stale', 'read-lane.stale', 'state-block', 'enforcement', 'commit-guard',
  'worktrees-dir',
  'attribution', 'footprint-global', 'executor-vehicle.differing',
];
const FORM_B = ['jev-connect'];
const FORM_C = [
  'family-freshness', 'sandbox-provision',
  'worktrees-dir.home',
];
const HARNESS = [
  'velocity-core', 'kit-tools-tier', 'bridge-tier', 'autonomy-render', 'gate-hook', 'read-lane.missing',
  'mcp-channel', 'mcp-channel.differing', 'agents', 'executor-vehicle', 'jev-skill', 'jev-skill.earlier',
  'gate-hook.marker-stale', 'read-lane.stale', 'state-block', 'enforcement', 'commit-guard',
  'worktrees-dir',
  'attribution', 'footprint-global', 'executor-vehicle.differing',
];
const USER = ['jev-connect', 'family-freshness', 'sandbox-provision.installable', 'sandbox-provision', 'worktrees-dir.home'];
const ENV_DEPENDENT = ['bridge-tier', 'jev-connect', 'jev-skill', 'jev-skill.earlier', 'sandbox-provision.installable'];
const WORKTREES_HOME_STEP = 'your own step — point docs/ai/worktrees.json parentDir at a dedicated directory, then run /agent-workflow-kit recommendations';
const WITH_FORMS = [...FORM_A, ...FORM_B, ...FORM_C];
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/home/u';
const PROJECT = '/home/u/proj';
const HOOKS = join(PROJECT, '.git', 'hooks');
const PROTECTION = { root: PROJECT, home: HOME, hooksDir: HOOKS };
const createFacts = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'write-lanes-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { toolsDir: TOOLS, root: ROOT, env: {}, home, platform: 'linux', tuple: 'apt-get:bubblewrap,socat' };
};
const getScriptPaths = () => readdirSync(join(PACKAGE_ROOT, 'references', 'scripts'))
  .filter((name) => name.endsWith('.mjs')).sort().map((name) => join(ROOT, 'scripts', name));
const expectedArgv = (FACTS, claudeDir = join(FACTS.home, '.claude')) => {
  const table = [
    ['velocity-core', 'velocity-profile.mjs', ['--cwd', ROOT], ['--apply', '--cwd', ROOT]],
    ['kit-tools-tier', 'velocity-profile.mjs', ['--kit-tools', '--cwd', ROOT], ['--apply', '--kit-tools', '--cwd', ROOT]],
    ['bridge-tier', 'velocity-profile.mjs', ['--bridge-tier', '--cwd', ROOT], ['--apply', '--bridge-tier', '--cwd', ROOT]],
    ['autonomy-render', 'velocity-profile.mjs', ['--autonomy', '--cwd', ROOT], ['--autonomy', '--apply', '--cwd', ROOT]],
    ['gate-hook', 'gate-hook.mjs', ['--cwd', ROOT], ['--apply', '--cwd', ROOT]],
    ['read-lane.missing', 'gate-hook.mjs', ['--cwd', ROOT], ['--apply', '--cwd', ROOT]],
    ['gate-hook.marker-stale', 'gate-hook.mjs', ['--reseed', '--cwd', ROOT], ['--apply', '--reseed', '--cwd', ROOT]],
    ['read-lane.stale', 'gate-hook.mjs', ['--reseed', '--cwd', ROOT], ['--apply', '--reseed', '--cwd', ROOT]],
    ['state-block', 'state-block-hook.mjs', ['--cwd', ROOT], ['--apply', '--cwd', ROOT]],
    ['enforcement', 'git-hooks.mjs', ['--enforcement', '--cwd', ROOT], ['--apply', '--enforcement', '--cwd', ROOT]],
    ['commit-guard', 'git-hooks.mjs', ['--commit-guard', '--cwd', ROOT], ['--apply', '--commit-guard', '--cwd', ROOT]],
    ['mcp-channel', 'mcp.mjs', ['--cwd', ROOT], ['--apply', '--cwd', ROOT]],
    ['mcp-channel.differing', 'mcp.mjs', ['--replace', '--cwd', ROOT], ['--replace', '--apply', '--cwd', ROOT]],
    ['agents', 'cheap-agents.mjs', ['--cwd', ROOT], ['--apply', '--cwd', ROOT]],
    ['executor-vehicle', 'cheap-agents.mjs', ['--cwd', ROOT], ['--apply', '--cwd', ROOT]],
    ['sandbox-provision.installable', 'autonomy-doctor.mjs', [], ['--apply', 'apt-get:bubblewrap,socat']],
    ['jev-skill', 'jev-skill.mjs', ['--claude-dir', claudeDir], ['--apply', '--claude-dir', claudeDir]],
    ['jev-skill.earlier', 'jev-skill.mjs', ['--claude-dir', claudeDir], ['--apply', '--claude-dir', claudeDir]],
    ['worktrees-dir', 'velocity-profile.mjs', ['--worktrees', '--cwd', ROOT], ['--apply', '--worktrees', '--cwd', ROOT]],
    ['attribution', 'attribution.mjs', ['--cwd', ROOT], ['--apply', '--cwd', ROOT]],
    ['footprint-global', 'hide-footprint.mjs', ['--remove-global', '--dry-run', '--dir', ROOT], ['--remove-global', '--dir', ROOT]],
    ['executor-vehicle.differing', 'cheap-agents.mjs', ['--cwd', ROOT], ['--apply', '--cwd', ROOT]],
  ];
  return Object.fromEntries(table.map(([variant, file, preview, apply]) => [variant, {
    preview: ['node', join(TOOLS, file), ...preview],
    apply: ['node', join(TOOLS, file), ...apply],
  }]));
};

describe('spec:init-project/S1 every severity key has one of the three lanes and environment dependence is exact', () => {
  it('every severity key has a frozen lane, laneOf agrees, masked is retired, and retired exports are absent', () => {
    const keys = Object.keys(SEVERITIES).sort();
    const variantLanes = need(lanes, 'VARIANT_LANES');
    const chatLane = need(lanes, 'LANE_CHAT');
    const harnessLane = need(lanes, 'LANE_HARNESS');
    const userLane = need(lanes, 'LANE_USER');
    const laneOf = need(lanes, 'laneOf');
    assert.equal(Object.isFrozen(variantLanes), true);
    assert.equal(Object.getPrototypeOf(variantLanes), Object.prototype);
    assert.deepEqual(Object.keys(variantLanes).sort(), keys);
    assert.equal(Object.hasOwn(variantLanes, 'sandbox-provision.installable'), true);
    assert.equal(Object.hasOwn(SEVERITIES, 'sandbox-provision.installable'), true);
    assert.equal(Object.hasOwn(variantLanes, 'mcp-channel.masked'), false);
    assert.equal(Object.hasOwn(SEVERITIES, 'mcp-channel.masked'), false);
    assert.equal(chatLane, 'chat');
    assert.equal(harnessLane, 'harness');
    assert.equal(userLane, 'user');
    assert.equal(Object.hasOwn(lanes, 'LANE_CONSOLE'), false);
    assert.equal(Object.hasOwn(lanes, 'routeLine'), false);
    for (const variant of keys) {
      assert.ok([chatLane, harnessLane, userLane].includes(variantLanes[variant]), variant);
      assert.equal(laneOf(variant), variantLanes[variant], variant);
    }
  });

  it('the harness and user sets are exact and every other key, including the named exceptions, is chat', () => {
    const keys = Object.keys(SEVERITIES);
    const variantLanes = need(lanes, 'VARIANT_LANES');
    assert.deepEqual(keys.filter((v) => variantLanes[v] === 'harness').sort(), [...HARNESS].sort());
    assert.deepEqual(keys.filter((v) => variantLanes[v] === 'user').sort(), [...USER].sort());
    for (const variant of keys.filter((v) => !HARNESS.includes(v) && !USER.includes(v))) {
      assert.equal(variantLanes[variant], 'chat', variant);
    }
    for (const variant of ['read-lane', 'review-recipe', 'sandbox-masks']) {
      assert.equal(variantLanes[variant], 'chat', variant);
    }
  });

  it('isEnvDependent is true for exactly five variants and unregistered laneOf and consoleArgv throw', (t) => {
    const FACTS = createFacts(t);
    const laneOf = need(lanes, 'laneOf');
    const consoleArgv = need(lanes, 'consoleArgv');
    const error = { name: 'Error', message: /no-such-variant/ };
    assert.throws(() => laneOf('no-such-variant'), error);
    assert.throws(() => consoleArgv('no-such-variant', FACTS), error);
    const isEnvDependent = need(lanes, 'isEnvDependent');
    for (const variant of Object.keys(SEVERITIES)) {
      assert.equal(isEnvDependent(variant), ENV_DEPENDENT.includes(variant), variant);
    }
  });

  it('isRejudged is true for worktrees-dir and footprint-global alone', () => {
    const isRejudged = need(lanes, 'isRejudged');
    const variantLanes = need(lanes, 'VARIANT_LANES');
    assert.equal(isRejudged('worktrees-dir'), true);
    assert.equal(isRejudged('footprint-global'), true);
    for (const variant of Object.keys(variantLanes).filter((v) => !['worktrees-dir', 'footprint-global'].includes(v))) {
      assert.equal(isRejudged(variant), false, variant);
    }
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

describe('spec:init-project/S3 each form uses unquoted injected tool paths and declares its writes without package paths', () => {
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

  it('argv forms partition the writer variants and no argv or slot line carries the npx package root on win32', (t) => {
    const FACTS = { ...createFacts(t), platform: 'win32' };
    const keys = Object.keys(SEVERITIES);
    const consoleArgv = need(lanes, 'consoleArgv');
    const answers = keys.map((variant) => ({ variant, argv: consoleArgv(variant, FACTS) }));
    const formA = answers.filter(({ argv }) => argv !== null && argv.preview !== null && Array.isArray(argv.apply));
    const formB = answers.filter(({ argv }) => argv !== null && argv.preview === null && Array.isArray(argv.apply));
    const formC = answers.filter(({ variant, argv }) => WITH_FORMS.includes(variant) && argv === null);
    const groups = [formA, formB, formC].map((group) => group.map(({ variant }) => variant).sort());
    assert.deepEqual(groups, [[...FORM_A].sort(), [...FORM_B].sort(), [...FORM_C].sort()]);
    for (const [index, group] of groups.entries()) {
      for (const other of groups.slice(index + 1)) {
        assert.deepEqual(group.filter((v) => other.includes(v)), []);
      }
    }
    for (const { variant, argv } of answers.filter(({ variant }) => !WITH_FORMS.includes(variant))) {
      assert.equal(argv, null, variant);
    }
    for (const variant of keys) {
      const argv = consoleArgv(variant, FACTS);
      for (const element of [...(argv?.preview ?? []), ...(argv?.apply ?? [])]) {
        assert.equal(element.includes(PACKAGE_ROOT), false, `${variant}: ${element}`);
      }
    }
    const applySlot = need(lanes, 'applySlot');
    for (const variant of keys) {
      const slot = applySlot(variant, FACTS);
      for (const line of [slot?.check, slot?.apply].filter((line) => line != null)) {
        assert.equal(line.includes(PACKAGE_ROOT), false, variant);
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
      'gate-hook.marker-stale': hook,
      'read-lane.stale': hook,
      'state-block': [join(ROOT, '.claude', 'hooks', 'state-block-guard.mjs'), ...settings],
      enforcement: [...getScriptPaths(), join(ROOT, '.git', 'hooks', 'pre-commit')],
      'commit-guard': [join(ROOT, '.git', 'hooks', 'pre-commit'), join(ROOT, 'scripts', 'install-git-hooks.mjs')],
      'mcp-channel': mcp,
      'mcp-channel.differing': mcp,
      agents,
      'executor-vehicle': agents,
      'sandbox-provision.installable': [],
      'jev-skill': skills,
      'jev-skill.earlier': skills,
      'worktrees-dir': [join(ROOT, '.claude', 'settings.local.json')],
      attribution: settings,
      'footprint-global': [],
      'executor-vehicle.differing': agents,
    };
    const nullVariants = [...new Set([...FORM_C, ...Object.keys(SEVERITIES).filter((v) => !WITH_FORMS.includes(v))])];
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

  it('enforcement and commit-guard name pre-commit in a hooksDir inside or outside the project without a throw', (t) => {
    const FACTS = createFacts(t);
    const scripts = getScriptPaths();
    const writesOf = need(lanes, 'writesOf');
    for (const hooksDir of [join(ROOT, '.githooks'), '/elsewhere/hooks']) {
      const facts = { ...FACTS, hooksDir };
      const preCommit = join(hooksDir, 'pre-commit');
      assert.deepEqual(writesOf('enforcement', facts), [...scripts, preCommit]);
      assert.deepEqual(writesOf('commit-guard', facts), [preCommit, join(ROOT, 'scripts', 'install-git-hooks.mjs')]);
    }
  });
});

const expectedCheck = (variant, facts) => {
  const args = [join(facts.toolsDir, 'apply-danger-check.mjs'), '--variant', variant, '--cwd', facts.root];
  if (['jev-skill', 'jev-skill.earlier'].includes(variant)) {
    args.push('--claude-dir', claudeDirOf(facts.env, facts.home, facts.platform).dir);
  }
  return `node ${args.map(quoteArg).join(' ')}`;
};
const assertSlotLines = (slot, variant) => {
  for (const line of [slot.check, slot.apply].filter((line) => line !== null)) {
    for (const forbidden of ['applies at your next npx', 'restart the agent from that console', 'HAND-APPLY', PACKAGE_ROOT]) {
      assert.equal(line.includes(forbidden), false, `${variant}: ${forbidden}`);
    }
  }
};

describe('spec:init-project/S20 apply slots use the danger check or the user step by proof', () => {
  it('every harness slot quotes the check and appends the literal digest suffix, including both Jev claude dirs on win32', (t) => {
    const base = createFacts(t);
    const fixtures = [
      { ...base, platform: 'win32' },
      { ...base, platform: 'win32', env: { CLAUDE_CONFIG_DIR: "/cc o'brien" } },
      { ...base, platform: 'win32', env: { CLAUDE_CONFIG_DIR: 'relative' } },
    ];
    const applySlot = need(lanes, 'applySlot');
    for (const facts of fixtures) {
      for (const variant of HARNESS) {
        const check = expectedCheck(variant, facts);
        const slot = applySlot(variant, facts);
        assert.deepEqual(slot, { check, apply: `${check} --apply --expect <digest>` }, variant);
        assertSlotLines(slot, variant);
      }
    }
  });

  it('jev-connect, family-freshness and the installable doctor return user steps ending on their command on win32', (t) => {
    const facts = { ...createFacts(t), platform: 'win32' };
    const expected = {
      'jev-connect': 'your own step — it asks for the key in your terminal and the key never goes into the chat — run in a terminal of your own: '
        + `node ${quoteArg(join(facts.toolsDir, 'jev-connect.mjs'))}`,
      'family-freshness': 'your own step — run in a terminal of your own: npx @sabaiway/agent-workflow-kit@latest init',
      'sandbox-provision.installable': 'your own step (a sudo install; the doctor prints the --apply line to run next) — run in a terminal of your own: '
        + `cd ${quoteArg(facts.root)} && node ${quoteArg(join(facts.toolsDir, 'autonomy-doctor.mjs'))}`,
      'sandbox-provision': "your own step — the doctor has no install it can run for you here (the reason is this item's text) — run in a terminal of your own: "
        + `cd ${quoteArg(facts.root)} && node ${quoteArg(join(facts.toolsDir, 'autonomy-doctor.mjs'))}`,
      'worktrees-dir.home': WORKTREES_HOME_STEP,
    };
    const applySlot = need(lanes, 'applySlot');
    for (const [variant, apply] of Object.entries(expected)) {
      const slot = applySlot(variant, facts);
      assert.deepEqual(slot, { check: null, apply }, variant);
      assertSlotLines(slot, variant);
    }
  });

  it('every chat variant returns no slot on win32', (t) => {
    const facts = { ...createFacts(t), platform: 'win32' };
    const chat = Object.keys(SEVERITIES).filter((variant) => !HARNESS.includes(variant) && !USER.includes(variant));
    const applySlot = need(lanes, 'applySlot');
    for (const variant of chat) {
      assert.equal(applySlot(variant, facts), null, variant);
    }
  });
});

describe('spec:init-project/S38 — worktrees-dir is a harness variant and worktrees-dir.home a user one', () => {
  it('the worktrees variants have their lanes among exactly twenty-one harness and five user severity keys', () => {
    const variantLanes = need(lanes, 'VARIANT_LANES');
    const keys = Object.keys(SEVERITIES);
    assert.equal(variantLanes['worktrees-dir'], 'harness');
    assert.equal(variantLanes['worktrees-dir.home'], 'user');
    assert.equal(keys.filter((variant) => variantLanes[variant] === 'harness').length, 21);
    assert.equal(keys.filter((variant) => variantLanes[variant] === 'user').length, 5);
  });

  it('worktrees-dir uses the local settings form and quoted danger-check slot on win32 without changing the five env-dependent variants', (t) => {
    const facts = { ...createFacts(t), platform: 'win32' };
    const consoleArgv = need(lanes, 'consoleArgv');
    const writesOf = need(lanes, 'writesOf');
    const isEnvDependent = need(lanes, 'isEnvDependent');
    const applySlot = need(lanes, 'applySlot');
    assert.deepEqual(consoleArgv('worktrees-dir', facts), {
      preview: ['node', join(TOOLS, 'velocity-profile.mjs'), '--worktrees', '--cwd', ROOT],
      apply: ['node', join(TOOLS, 'velocity-profile.mjs'), '--apply', '--worktrees', '--cwd', ROOT],
    });
    assert.deepEqual(writesOf('worktrees-dir', facts), [join(ROOT, '.claude', 'settings.local.json')]);
    assert.equal(isEnvDependent('worktrees-dir'), false);
    assert.deepEqual(Object.keys(SEVERITIES).filter((variant) => isEnvDependent(variant)).sort(), [...ENV_DEPENDENT].sort());
    const check = ['node', join(TOOLS, 'apply-danger-check.mjs'), '--variant', 'worktrees-dir', '--cwd', ROOT].map(quoteArg).join(' ');
    const slot = applySlot('worktrees-dir', facts);
    assert.deepEqual(slot, { check, apply: `${check} --apply --expect <digest>` });
    assertSlotLines(slot, 'worktrees-dir');
  });

  it('worktrees-dir.home has no argv or writes and gives the parentDir user step without a command or paths', (t) => {
    const facts = { ...createFacts(t), platform: 'win32' };
    const consoleArgv = need(lanes, 'consoleArgv');
    const writesOf = need(lanes, 'writesOf');
    const isEnvDependent = need(lanes, 'isEnvDependent');
    const applySlot = need(lanes, 'applySlot');
    assert.equal(consoleArgv('worktrees-dir.home', facts), null);
    assert.equal(writesOf('worktrees-dir.home', facts), null);
    assert.equal(isEnvDependent('worktrees-dir.home'), false);
    const slot = applySlot('worktrees-dir.home', facts);
    assert.deepEqual(slot, { check: null, apply: WORKTREES_HOME_STEP });
    for (const forbidden of ['node', TOOLS, ROOT]) {
      assert.equal(slot.apply.includes(forbidden), false, forbidden);
    }
    assertSlotLines(slot, 'worktrees-dir.home');
  });

  it('preserves the absence of a worktrees.mjs import in the write-lanes source', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./write-lanes.mjs', import.meta.url), 'utf8');
    assert.equal(source.includes('./worktrees.mjs'), false);
  });
});
