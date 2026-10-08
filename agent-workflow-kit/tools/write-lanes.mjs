import { join, resolve } from 'node:path';
import { dirCovers } from './declared-paths.mjs';
import { claudeDirOf, quoteArg, skillTargets } from './jev-facts.mjs';
import { targetsFor } from './jev-connect.mjs';

export const LANE_CHAT = 'chat';
export const LANE_HARNESS = 'harness';
export const LANE_USER = 'user';

export const VARIANT_LANES = Object.freeze({
  'velocity-core': LANE_HARNESS,
  'kit-tools-tier': LANE_HARNESS,
  'bridge-tier': LANE_HARNESS,
  'autonomy-policy': LANE_CHAT,
  'autonomy-render': LANE_HARNESS,
  'sandbox-provision': LANE_USER,
  'sandbox-provision.installable': LANE_USER,
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
  'gate-hook': LANE_HARNESS,
  'gate-hook.marker-stale': LANE_USER,
  'commit-guard': LANE_USER,
  enforcement: LANE_USER,
  'read-lane': LANE_CHAT,
  'read-lane.stale': LANE_USER,
  'read-lane.missing': LANE_HARNESS,
  'state-block': LANE_USER,
  'mcp-channel': LANE_HARNESS,
  'mcp-channel.differing': LANE_HARNESS,
  agents: LANE_HARNESS,
  'executor-vehicle': LANE_HARNESS,
  'family-freshness': LANE_USER,
  'adr-store-migration': LANE_CHAT,
  'sandbox-masks': LANE_CHAT,
  'sandbox-masks.unfenced-mount': LANE_CHAT,
  'worktrees-dir': LANE_CHAT,
  'spec-adoption': LANE_CHAT,
  'profile-gap': LANE_CHAT,
  'jev-connect': LANE_USER,
  'jev-skill': LANE_HARNESS,
  'jev-skill.earlier': LANE_HARNESS,
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

const formatCommand = (argv) => argv.map(quoteArg).join(' ');
const TERMINAL_STEP = 'run in a terminal of your own: ';

const createForm = (file, preview, apply, writes, envDependent = false, userStep = null) => Object.freeze({
  file,
  preview,
  apply,
  writes,
  envDependent,
  userStep,
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
  'sandbox-provision.installable': createForm('autonomy-doctor.mjs', [], ['--apply', '<tuple>'], [], true,
    (facts, argv) => 'your own step (a sudo install; the doctor prints the --apply line to run next) — '
      + `${TERMINAL_STEP}cd ${quoteArg(facts.root)} && ${formatCommand(argv.preview)}`),
  'jev-skill': SKILL_FORM,
  'jev-skill.earlier': SKILL_FORM,
  'jev-connect': createForm('jev-connect.mjs', null, [], getStartupPaths, true,
    (facts, argv) => 'your own step — it asks for the key in your terminal and the key never goes into the chat — '
      + `${TERMINAL_STEP}${formatCommand(argv.apply)}`),
  'family-freshness': Object.freeze({
    userStep: () => `your own step — ${TERMINAL_STEP}${formatCommand(['npx', '@sabaiway/agent-workflow-kit@latest', 'init'])}`,
  }),
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

export const isEnvDependent = (variant) => {
  laneOf(variant);
  return FORMS[variant]?.envDependent === true;
};

export const applySlot = (variant, facts) => {
  const lane = laneOf(variant);
  const form = FORMS[variant];
  if (lane === LANE_HARNESS) {
    const args = ['node', join(facts.toolsDir, 'apply-danger-check.mjs'), '--variant', variant, '--cwd', facts.root];
    const skillArgs = form === SKILL_FORM ? form.preview.map((arg) => resolveArgument(arg, facts)) : [];
    const check = formatCommand([...args, ...skillArgs]);
    return { check, apply: `${check} --apply --expect <digest>` };
  }
  if (lane === LANE_USER && form?.userStep) {
    return { check: null, apply: form.userStep(facts, consoleArgv(variant, facts)) };
  }
  return null;
};
