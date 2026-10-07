import { join, resolve } from 'node:path';
import { dirCovers } from './declared-paths.mjs';
import { claudeDirOf, skillTargets } from './jev-facts.mjs';
import { targetsFor } from './jev-connect.mjs';

export const LANE_CONSOLE = 'console';
export const LANE_CHAT = 'chat';

export const VARIANT_LANES = Object.freeze({
  'velocity-core': LANE_CONSOLE,
  'kit-tools-tier': LANE_CONSOLE,
  'bridge-tier': LANE_CONSOLE,
  'autonomy-policy': LANE_CHAT,
  'autonomy-render': LANE_CONSOLE,
  'sandbox-provision': LANE_CONSOLE,
  'sandbox-provision.installable': LANE_CONSOLE,
  'review-recipe': LANE_CHAT,
  'gates-declaration': LANE_CHAT,
  'gates-inert': LANE_CHAT,
  'gates-inert.no-verification': LANE_CHAT,
  'gates-inert.producer-unrecognized': LANE_CHAT,
  'gates-inert.coverage-domain-narrow': LANE_CHAT,
  'source-size': LANE_CHAT,
  'source-size.unminted': LANE_CHAT,
  'source-size.adopted-elsewhere': LANE_CHAT,
  'source-size.id-squatter': LANE_CHAT,
  'gate-hook': LANE_CONSOLE,
  'gate-hook.marker-stale': LANE_CONSOLE,
  'commit-guard': LANE_CONSOLE,
  enforcement: LANE_CONSOLE,
  'read-lane': LANE_CHAT,
  'read-lane.stale': LANE_CONSOLE,
  'read-lane.missing': LANE_CONSOLE,
  'state-block': LANE_CONSOLE,
  'mcp-channel': LANE_CONSOLE,
  'mcp-channel.differing': LANE_CONSOLE,
  agents: LANE_CONSOLE,
  'executor-vehicle': LANE_CONSOLE,
  'family-freshness': LANE_CONSOLE,
  'adr-store-migration': LANE_CHAT,
  'sandbox-masks': LANE_CHAT,
  'sandbox-masks.unfenced-mount': LANE_CHAT,
  'sandbox-lane': LANE_CHAT,
  'worktrees-dir': LANE_CHAT,
  'spec-adoption': LANE_CHAT,
  'profile-gap': LANE_CHAT,
  'jev-connect': LANE_CONSOLE,
  'jev-skill': LANE_CONSOLE,
  'jev-skill.earlier': LANE_CONSOLE,
  'spec-adoption.adopting': LANE_CHAT,
});

export const laneOf = (variant) => {
  if (!Object.hasOwn(VARIANT_LANES, variant)) {
    throw new Error(`unregistered variant: ${variant}`);
  }
  return VARIANT_LANES[variant];
};

const SETTINGS_PATH = join('.claude', 'settings.json');
const PROTECTED_FILES = [
  SETTINGS_PATH,
  join('.claude', 'settings.local.json'),
  '.mcp.json',
  join('.git', 'config'),
];
const PROTECTED_DIRS = ['agents', 'hooks', 'skills'].map((name) => join('.claude', name));

export const isProtectedPath = (abs, { root, home, hooksDir }) => {
  const project = resolve(root);
  const hooks = resolve(hooksDir);
  const path = resolve(abs);
  if (!dirCovers(project, hooks)) {
    throw new Error(`hooksDir outside the project: ${hooksDir}`);
  }
  if (!dirCovers(project, path)) return dirCovers(resolve(home), path);
  return PROTECTED_FILES.some((file) => path === join(project, file))
    || [...PROTECTED_DIRS.map((dir) => join(project, dir)), hooks].some((dir) => dirCovers(dir, path));
};

const ROUTE = "applies at your next npx @sabaiway/agent-workflow-kit@latest init, run from this project's folder";
const RESTART = '; if init reports it not pending, restart the agent from that console';
const SETTINGS_WRITES = [SETTINGS_PATH];
const HOOK_WRITES = [join('.claude', 'hooks', 'agent-workflow-gates.mjs'), ...SETTINGS_WRITES];
const MCP_WRITES = ['.mcp.json', ...SETTINGS_WRITES];
const AGENT_WRITES = [join('.claude', 'agents')];

const getSkillPaths = ({ env, home, platform }) => {
  const claudeDir = claudeDirOf(env, home, platform).dir;
  return skillTargets({ home, claudeDir }).map(({ path }) => path);
};

const getStartupPaths = ({ env, home, platform }) => targetsFor({
  shell: env.SHELL,
  home,
  zdotdir: env.ZDOTDIR,
  xdgConfigHome: env.XDG_CONFIG_HOME,
  platform,
}).filter(({ path }) => path !== null).map(({ path }) => path);

const createForm = (file, preview, apply, writes, restart = false) => Object.freeze({
  file,
  preview,
  apply,
  writes,
  route: restart ? ROUTE + RESTART : ROUTE,
});

const CORE_FORM = createForm('velocity-profile.mjs', ['--cwd', '<root>'], ['--apply', '--cwd', '<root>'], SETTINGS_WRITES);
const HOOK_FORM = createForm('gate-hook.mjs', ['--cwd', '<root>'], ['--apply', '--cwd', '<root>'], HOOK_WRITES);
const AGENT_FORM = createForm('cheap-agents.mjs', ['--cwd', '<root>'], ['--apply', '--cwd', '<root>'], AGENT_WRITES);
const SKILL_FORM = createForm('jev-skill.mjs', ['--claude-dir', '<dir>'], ['--apply', '--claude-dir', '<dir>'], getSkillPaths, true);

const FORMS = Object.freeze({
  'velocity-core': CORE_FORM,
  'kit-tools-tier': createForm('velocity-profile.mjs',
    ['--kit-tools', '--cwd', '<root>'], ['--apply', '--kit-tools', '--cwd', '<root>'], SETTINGS_WRITES),
  'bridge-tier': createForm('velocity-profile.mjs',
    ['--bridge-tier', '--cwd', '<root>'], ['--apply', '--bridge-tier', '--cwd', '<root>'], SETTINGS_WRITES, true),
  'autonomy-render': createForm('velocity-profile.mjs',
    ['--autonomy', '--cwd', '<root>'], ['--autonomy', '--apply', '--cwd', '<root>'], SETTINGS_WRITES),
  'gate-hook': HOOK_FORM,
  'read-lane.missing': HOOK_FORM,
  'mcp-channel': createForm('mcp.mjs', ['--cwd', '<root>'], ['--apply', '--cwd', '<root>'], MCP_WRITES),
  'mcp-channel.differing': createForm('mcp.mjs',
    ['--replace', '--cwd', '<root>'], ['--replace', '--apply', '--cwd', '<root>'], MCP_WRITES),
  agents: AGENT_FORM,
  'executor-vehicle': AGENT_FORM,
  'sandbox-provision.installable': createForm('autonomy-doctor.mjs', [], ['--apply', '<tuple>'], [], true),
  'jev-skill': SKILL_FORM,
  'jev-skill.earlier': SKILL_FORM,
  'jev-connect': createForm('jev-connect.mjs', null, [], getStartupPaths, true),
  'family-freshness': { route: ROUTE },
  'sandbox-provision': null,
  'commit-guard': null,
  'gate-hook.marker-stale': null,
  'read-lane.stale': null,
  'state-block': null,
  enforcement: null,
});

const resolveArgument = (arg, facts) => {
  if (arg === '<root>') return facts.root;
  if (arg === '<tuple>') return facts.tuple;
  if (arg === '<dir>') return claudeDirOf(facts.env, facts.home, facts.platform).dir;
  return arg;
};

export const consoleArgv = (variant, facts) => {
  laneOf(variant);
  const form = FORMS[variant];
  if (!form?.file) return null;
  const argv = (args) => ['node', join(facts.toolsDir, form.file), ...args.map((arg) => resolveArgument(arg, facts))];
  return {
    preview: form.preview === null ? null : argv(form.preview),
    apply: argv(form.apply),
  };
};

export const writesOf = (variant, facts) => {
  laneOf(variant);
  const form = FORMS[variant];
  if (!form?.file) return null;
  if (typeof form.writes === 'function') return form.writes(facts);
  return form.writes.map((path) => join(facts.root, path));
};

export const routeLine = (variant) => {
  laneOf(variant);
  return FORMS[variant]?.route ?? null;
};
