import { join, resolve } from 'node:path';
import { dirCovers } from './declared-paths.mjs';
import { claudeDirOf, quoteArg, skillTargets } from './jev-facts.mjs';
import { targetsFor } from './jev-connect.mjs';
import { DEPLOYED_SCRIPTS, INSTALLER_REL } from './node-evidence.mjs';
import { dqUnsafePath } from './checker-claim.mjs';
import { isLineUnsafe } from './source-size-refusal.mjs';
import { SOURCE_SIZE_GATE_ID } from './source-size-gate-cmd.mjs';
import { GATES_REL } from './gates-declaration.mjs';

export const LANE_CHAT = 'chat';
export const LANE_HARNESS = 'harness';
export const LANE_USER = 'user';
export const LANE_KIT = 'kit';

export const VARIANT_LANES = Object.freeze({
  'velocity-core': LANE_HARNESS,
  'kit-tools-tier': LANE_HARNESS,
  'bridge-tier': LANE_HARNESS,
  'autonomy-policy': LANE_CHAT,
  'autonomy-render': LANE_HARNESS,
  'sandbox-provision': LANE_USER,
  'sandbox-provision.installable': LANE_USER,
  'review-recipe': LANE_USER,
  'gates-declaration': LANE_CHAT,
  'gates-inert': LANE_CHAT,
  'gates-inert.unfillable': LANE_USER,
  'gates-inert.no-verification': LANE_CHAT,
  'gates-inert.producer-unrecognized': LANE_USER,
  'gates-inert.coverage-domain-narrow': LANE_CHAT,
  'source-size': LANE_CHAT,
  'source-size.unminted': LANE_CHAT,
  'source-size.adopted-elsewhere': LANE_CHAT,
  'source-size.id-squatter': LANE_USER,
  'source-size.schema-1': LANE_CHAT,
  'source-size.layout': LANE_CHAT,
  'source-size.piles': LANE_CHAT,
  'gate-hook': LANE_HARNESS,
  'gate-hook.not-current': LANE_KIT,
  'commit-guard': LANE_HARNESS,
  'hook-checks': LANE_HARNESS,
  enforcement: LANE_HARNESS,
  'read-lane': LANE_CHAT,
  'state-block': LANE_HARNESS,
  'state-block.not-current': LANE_KIT,
  'mcp-channel': LANE_HARNESS,
  'mcp-channel.differing': LANE_HARNESS,
  agents: LANE_HARNESS,
  'agents.not-current': LANE_KIT,
  'executor-vehicle': LANE_HARNESS,
  attribution: LANE_HARNESS,
  'footprint-global': LANE_HARNESS,
  'family-freshness': LANE_USER,
  'sandbox-masks': LANE_CHAT,
  'sandbox-masks.unfenced-mount': LANE_CHAT,
  'worktrees-dir': LANE_HARNESS,
  'worktrees-dir.home': LANE_USER,
  'spec-adoption': LANE_CHAT,
  'profile-gap': LANE_CHAT,
  'jev-connect': LANE_USER,
  'jev-skill': LANE_HARNESS,
  'jev-skill.not-current': LANE_KIT,
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
const LOCAL_SETTINGS_WRITES = [join('.claude', 'settings.local.json')];
const GATE_HOOK_FILE = [join('.claude', 'hooks', 'agent-workflow-gates.mjs')];
const STOP_HOOK_FILE = [join('.claude', 'hooks', 'state-block-guard.mjs')];
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

const preCommitOf = (facts) => join(facts.hooksDir ?? join(facts.root, '.git', 'hooks'), 'pre-commit');
const getEnforcementPaths = (facts) => [...DEPLOYED_SCRIPTS.map(({ deployed }) => join(facts.root, deployed)), preCommitOf(facts)];
const getGuardPaths = (facts) => [preCommitOf(facts), join(facts.root, INSTALLER_REL)];

const formatCommand = (argv) => argv.map(quoteArg).join(' ');
const TERMINAL_STEP = 'run in a terminal of your own: ';
const OWN_STEP = 'your own step — ';
const RERUN_ADVISOR = ', then run /agent-workflow-kit recommendations';

const squatterStep = (facts) => {
  const tool = join(facts.toolsDir, 'source-size-check.mjs');
  const rename = `${OWN_STEP}in ${GATES_REL} rename the "${SOURCE_SIZE_GATE_ID}" gate to an id of its own`;
  if (dqUnsafePath(tool) || isLineUnsafe(tool)) return `${rename}${RERUN_ADVISOR}`;
  return `${rename}, or repoint its cmd at node "${tool}" --check${RERUN_ADVISOR}`;
};

// rejudged: the written value derives from state init's record does not watch, so init re-runs its check before the apply.
const createForm = (file, preview, apply, writes, envDependent = false, userStep = null, rejudged = false) => Object.freeze({
  file,
  preview,
  apply,
  writes,
  envDependent,
  userStep,
  rejudged,
});

const CORE_FORM = createForm('velocity-profile.mjs', ['--cwd', '<root>'], ['--apply', '--cwd', '<root>'], SETTINGS_WRITES);
// A hook's offer writes its file and the settings entry; its kit item, over a wired hook, the file alone.
const hookForm = (file, writes) => createForm(file, ['--cwd', '<root>'], ['--apply', '--cwd', '<root>'], writes);
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
  'gate-hook': hookForm('gate-hook.mjs', [...GATE_HOOK_FILE, ...SETTINGS_WRITES]),
  'gate-hook.not-current': hookForm('gate-hook.mjs', GATE_HOOK_FILE),
  'state-block': hookForm('state-block-hook.mjs', [...STOP_HOOK_FILE, ...SETTINGS_WRITES]),
  'state-block.not-current': hookForm('state-block-hook.mjs', STOP_HOOK_FILE),
  'mcp-channel': createForm('mcp.mjs', ['--cwd', '<root>'], ['--apply', '--cwd', '<root>'], MCP_WRITES),
  'mcp-channel.differing': createForm('mcp.mjs',
    ['--replace', '--cwd', '<root>'], ['--replace', '--apply', '--cwd', '<root>'], MCP_WRITES),
  agents: AGENT_FORM,
  'agents.not-current': AGENT_FORM,
  'executor-vehicle': AGENT_FORM,
  attribution: createForm('attribution.mjs', ['--cwd', '<root>'], ['--apply', '--cwd', '<root>'], SETTINGS_WRITES),
  'footprint-global': createForm('hide-footprint.mjs',
    ['--remove-global', '--dry-run', '--dir', '<root>'], ['--remove-global', '--dir', '<root>'], [], false, null, true),
  'sandbox-provision.installable': createForm('autonomy-doctor.mjs', [], ['--apply', '<tuple>'], [], true,
    (facts, argv) => 'your own step (a sudo install; the doctor prints the --apply line to run next) — '
      + `${TERMINAL_STEP}cd ${quoteArg(facts.root)} && ${formatCommand(argv.preview)}`),
  'jev-skill': SKILL_FORM,
  'jev-skill.not-current': SKILL_FORM,
  'jev-connect': createForm('jev-connect.mjs', null, [], getStartupPaths, true,
    (facts, argv) => `${OWN_STEP}it asks for the key in your terminal and the key never goes into the chat — `
      + `${TERMINAL_STEP}${formatCommand(argv.apply)}`),
  'family-freshness': Object.freeze({
    userStep: () => `${OWN_STEP}${TERMINAL_STEP}${formatCommand(['npx', '@sabaiway/agent-workflow-kit@latest', 'init'])}`,
  }),
  'sandbox-provision': Object.freeze({
    userStep: (facts) => `${OWN_STEP}the doctor has no install it can run for you here (the reason is this item's text) — `
      + `${TERMINAL_STEP}cd ${quoteArg(facts.root)} && ${formatCommand(['node', join(facts.toolsDir, 'autonomy-doctor.mjs')])}`,
  }),
  enforcement: createForm('git-hooks.mjs',
    ['--enforcement', '--cwd', '<root>'], ['--apply', '--enforcement', '--cwd', '<root>'], getEnforcementPaths),
  'commit-guard': createForm('git-hooks.mjs',
    ['--commit-guard', '--cwd', '<root>'], ['--apply', '--commit-guard', '--cwd', '<root>'], getGuardPaths),
  'hook-checks': createForm('git-hooks.mjs',
    ['--hook-checks', '--cwd', '<root>'], ['--apply', '--hook-checks', '--cwd', '<root>'], getGuardPaths),
  'worktrees-dir': createForm('velocity-profile.mjs',
    ['--worktrees', '--cwd', '<root>'], ['--apply', '--worktrees', '--cwd', '<root>'], LOCAL_SETTINGS_WRITES, false, null, true),
  'worktrees-dir.home': Object.freeze({
    userStep: () => `${OWN_STEP}point docs/ai/worktrees.json parentDir at a dedicated directory${RERUN_ADVISOR}`,
  }),
  'gates-inert.unfillable': Object.freeze({
    userStep: () => `${OWN_STEP}in ${GATES_REL} declare or move a suite gate carrying the coverage reporters before the coverage checker`
      + ` (references/modes/gates.md names the exact form), or drop that checker${RERUN_ADVISOR}`,
  }),
  'gates-inert.producer-unrecognized': Object.freeze({
    userStep: () => `${OWN_STEP}in ${GATES_REL} mark the gate that writes the lcov with "lcovProducer": true`
      + ` (references/modes/gates.md names the key), or drop the coverage checker${RERUN_ADVISOR}`,
  }),
  'source-size.id-squatter': Object.freeze({ userStep: squatterStep }),
  'review-recipe': Object.freeze({
    userStep: () => `${OWN_STEP}set up the backend the recipe names with /agent-workflow-kit setup (it places the bridge skill`
      + ' and links its wrappers, and names the CLI install and sign-in that stay yours; /agent-workflow-kit backends shows what is'
      + ` missing), or re-pick the recipe with /agent-workflow-kit set-recipe${RERUN_ADVISOR}`,
  }),
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

export const isRejudged = (variant) => {
  laneOf(variant);
  return FORMS[variant]?.rejudged === true;
};

export const applySlot = (variant, facts) => {
  const lane = laneOf(variant);
  const form = FORMS[variant];
  if (lane === LANE_HARNESS || lane === LANE_KIT) {
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
