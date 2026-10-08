#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_DIR, RENDER_OWNED_REDLINE_RULES,
  SAFE_DEFAULT_MODES, SETTINGS_FILE, SETTINGS_LOCAL_FILE, UNIVERSAL_READONLY_ALLOWLIST,
  deriveKitToolsAllowlist, detectAtRoot, mergeAutonomySettings,
  writeAutonomyProfile, writeVelocityProfile,
} from './velocity-profile.mjs';
import { KIT_GROUNDING_TOOL, bundledSandboxRecipe, usedBridges } from './bridge-sandbox-recipe.mjs';
import { mergeAllowWrite, stateDirsOf } from './bridge-state-dirs.mjs';
import { loadConfig } from './orchestration-config.mjs';
import { HOOK_FILE_REL, HOOKS_DIR, buildHookSettingsEntry, mergeHookEntry, writeGateHook } from './gate-hook.mjs';
import { writeMcp } from './mcp.mjs';
import { ENABLED_KEY, MCP_JSON_REL, SERVERS_KEY, SERVER_NAME, allowRulesFor, buildServerEntry } from './mcp-registration.mjs';
import { AGENTS_DIR, writeCheapAgents } from './cheap-agents.mjs';
import { planFor } from './jev-skill.mjs';
import { SKILL_FILES, claudeDirOf, skillTargets } from './jev-facts.mjs';
import { findOnPath } from './detect-backends.mjs';
import { consoleArgv } from './write-lanes.mjs';
import { isDirectRun } from './direct-run.mjs';
import { dirCovers as covers } from './declared-paths.mjs';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const SKILL_VARIANTS = ['jev-skill', 'jev-skill.earlier'];
const VELOCITY_VARIANTS = ['velocity-core', 'kit-tools-tier', 'bridge-tier'];
const HOOK_VARIANTS = ['gate-hook', 'read-lane.missing'];
const MCP_VARIANTS = ['mcp-channel', 'mcp-channel.differing'];
const AGENT_VARIANTS = ['agents', 'executor-vehicle'];
const VARIANTS = [...VELOCITY_VARIANTS, 'autonomy-render', ...HOOK_VARIANTS, ...MCP_VARIANTS, ...AGENT_VARIANTS, ...SKILL_VARIANTS];
const CREDENTIALS = 'sandbox.credentials.envVars';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = (value) => object(value)
  ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  : Array.isArray(value) ? `[${value.map(stable).join(',')}]` : JSON.stringify(value);
const equal = (left, right) => stable(left) === stable(right);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const textValue = (value) => typeof value === 'string' ? value : JSON.stringify(value);

export const CHANGE_CLASSES = Object.freeze([
  'hosts reachable', 'paths writable', 'commands outside the sandbox',
  'prompts removed', 'commands the harness runs', 'nothing widened',
]);
export const KEY_TABLE = Object.freeze({
  'sandbox.network.allowedDomains': 0,
  'sandbox.filesystem.allowWrite': 1,
  'sandbox.excludedCommands': 2,
  'permissions.allow': 3,
  'permissions.defaultMode': 3,
  'sandbox.autoAllowBashIfSandboxed': 3,
  'permissions.ask': 3,
  'permissions.deny': 3,
  'sandbox.enabled': 3,
  'hooks.PreToolUse': 4,
  [ENABLED_KEY]: 4,
  [SERVERS_KEY]: 4,
  [CREDENTIALS]: 5,
});
const SCALARS = ['permissions.defaultMode', 'sandbox.enabled', 'sandbox.autoAllowBashIfSandboxed'];
const valid = (key, value, element = false) => {
  if (key.startsWith(`${SERVERS_KEY}.`) || key === SERVERS_KEY) return object(value);
  if (key === 'permissions.defaultMode') return typeof value === 'string';
  if (SCALARS.includes(key)) return typeof value === 'boolean';
  if (!element) return Array.isArray(value) && value.every((entry) => valid(key, entry, true));
  if (key === CREDENTIALS) return object(value) && typeof value.name === 'string' && typeof value.mode === 'string';
  return key === 'hooks.PreToolUse' ? object(value) : typeof value === 'string';
};
const keyOf = (key) => key.startsWith(`${SERVERS_KEY}.`) ? SERVERS_KEY : key;

export const diffFiles = (before, after) => {
  const entries = [];
  const scalar = (key, left, right) => {
    if (equal(left, right)) return;
    if (left === undefined) entries.push({ key, change: 'added', value: right });
    else if (right === undefined) entries.push({ key, change: 'removed', value: left });
    else entries.push({ key, change: 'altered', value: right, previous: left });
  };
  const walk = (left, right, key) => {
    if (equal(left, right)) return;
    const known = Object.hasOwn(KEY_TABLE, key);
    if (known && [left, right].some((value) => value !== undefined && !valid(key, value))) {
      scalar(key, left, right);
    } else if (key === SERVERS_KEY) {
      for (const name of new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])) {
        scalar(`${key}.${name}`, left?.[name], right?.[name]);
      }
    } else if (known && !SCALARS.includes(key)) {
      const old = left ?? [];
      const next = right ?? [];
      const unpaired = old.filter((value) => !next.some((entry) => equal(value, entry)));
      const changes = next.filter((value) => !old.some((entry) => equal(value, entry))).map((value) => {
        const at = key === CREDENTIALS ? unpaired.findIndex((entry) => entry.name === value.name) : -1;
        return at < 0 ? { key, change: 'added', value } : { key, change: 'altered', value, previous: unpaired.splice(at, 1)[0] };
      });
      for (const value of unpaired) entries.push({ key, change: 'removed', value });
      entries.push(...changes);
    } else if (!known && (key === '' || Object.keys(KEY_TABLE).some((path) => path.startsWith(`${key}.`)))
      && [left, right].every((value) => value === undefined || object(value))) {
      for (const name of new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])) {
        walk(left?.[name], right?.[name], key ? `${key}.${name}` : name);
      }
    } else scalar(key, left, right);
  };
  walk(before ?? {}, after ?? {}, '');
  const order = Object.keys(KEY_TABLE);
  const rank = (key) => order.includes(keyOf(key)) ? order.indexOf(keyOf(key)) : order.length;
  return entries.sort((a, b) => rank(a.key) - rank(b.key));
};

const classOf = ({ key, change, value }) => {
  const base = keyOf(key);
  if (!Object.hasOwn(KEY_TABLE, base)) return null;
  let index = KEY_TABLE[base];
  if (change === 'removed') index = ['permissions.ask', 'permissions.deny', CREDENTIALS].includes(key) ? 3 : 5;
  else if (['permissions.ask', 'permissions.deny'].includes(key)) index = 5;
  else if (key === 'permissions.defaultMode') index = value === 'acceptEdits' ? 3 : 5;
  else if (key === 'sandbox.enabled') index = value === false ? 3 : 5;
  else if (key === 'sandbox.autoAllowBashIfSandboxed') index = value === true ? 3 : 5;
  return CHANGE_CLASSES[index];
};
export const judgeChange = ({ variant, files, scope }) => {
  const entries = [];
  const refused = [];
  for (const { path, before, after } of files) {
    for (const diff of diffFiles(before, after)) {
      const entry = { ...diff, path, class: classOf(diff) };
      entries.push(entry);
      const { key, change } = diff;
      const atKey = (data) => key.split('.').reduce((value, name) => value?.[name], data);
      const wrongType = [atKey(before), atKey(after)].some((value) => value !== undefined && !valid(key, value));
      const reason = entry.class === null ? 'unknown key' : wrongType ? 'wrong type'
        : key === CREDENTIALS && change !== 'added' ? 'credentials entry removed or altered'
          : !scope.admits(entry) ? `beyond the declared scope of ${variant}` : null;
      if (reason) refused.push({ path, key, reason });
    }
  }
  return { entries, refused };
};
const writerFacts = (facts, deps) => ({
  ...deps, ...facts,
  detect: deps.detect ?? facts.detect,
  findWrapper: (name) => findOnPath(name, { getenv: facts.env }).state === 'present',
  findOnPath: (name) => findOnPath(name, { getenv: facts.env }),
});

export const scopeOf = (variant, facts, deps = {}) => {
  const allowed = {};
  const set = (key, values) => {
    allowed[key] = (value) => values.some((entry) => equal(entry, value));
  };
  if (VELOCITY_VARIANTS.includes(variant)) {
    const allow = [...UNIVERSAL_READONLY_ALLOWLIST];
    if (variant === 'kit-tools-tier') allow.push(...deriveKitToolsAllowlist({ projectDir: facts.root }));
    if (variant === 'bridge-tier') {
      const detect = deps.detect ?? facts.detect ?? (() => detectAtRoot(facts.root, { env: facts.env, home: facts.home }));
      const used = usedBridges(loadConfig(facts.root).config, detect());
      const recipe = bundledSandboxRecipe(used, { groundingAbsPath: join(facts.toolsDir, '..', KIT_GROUNDING_TOOL) });
      allow.push(...recipe.allow);
      set('sandbox.excludedCommands', recipe.excludedCommands);
      set('sandbox.network.allowedDomains', recipe.hosts);
      set('sandbox.filesystem.allowWrite', stateDirsOf(recipe.dirEntries, facts));
    }
    set('permissions.allow', allow);
  } else if (variant === 'autonomy-render') {
    set('permissions.defaultMode', SAFE_DEFAULT_MODES);
    set('sandbox.enabled', [true]);
    set('sandbox.autoAllowBashIfSandboxed', [true, false]);
    set('permissions.ask', RENDER_OWNED_REDLINE_RULES);
    set('permissions.deny', RENDER_OWNED_REDLINE_RULES);
    allowed[CREDENTIALS] = (value) => value.mode === 'deny';
  } else if (HOOK_VARIANTS.includes(variant)) set('hooks.PreToolUse', [buildHookSettingsEntry()]);
  else if (MCP_VARIANTS.includes(variant)) {
    set(`${SERVERS_KEY}.${SERVER_NAME}`, [buildServerEntry(join(facts.toolsDir, 'mcp-server.mjs'))]);
    set(ENABLED_KEY, [SERVER_NAME]);
    set('permissions.allow', allowRulesFor());
  }
  const targets = SKILL_VARIANTS.includes(variant) ? skillTargets({ home: facts.home,
    claudeDir: facts.claudeDir ?? claudeDirOf(facts.env, facts.home, facts.platform).dir }) : [];
  const filePaths = HOOK_VARIANTS.includes(variant) ? [join(facts.root, HOOK_FILE_REL)] : [];
  const directories = VELOCITY_VARIANTS.includes(variant) || variant === 'autonomy-render'
    || HOOK_VARIANTS.includes(variant) || MCP_VARIANTS.includes(variant) || AGENT_VARIANTS.includes(variant)
    ? [join(facts.root, CLAUDE_DIR)] : [];
  if (HOOK_VARIANTS.includes(variant)) directories.push(join(facts.root, HOOKS_DIR));
  if (AGENT_VARIANTS.includes(variant)) directories.push(join(facts.root, AGENTS_DIR));
  for (const target of targets) {
    for (let at = target.root; at !== target.base && covers(target.base, at); at = dirname(at)) directories.push(at);
    filePaths.push(target.path);
  }
  return {
    admits: ({ path, key, change, value }) => {
      const correctFile = key.startsWith(`${SERVERS_KEY}.`) ? path === MCP_JSON_REL : path === SETTINGS_FILE;
      const gains = variant === 'bridge-tier' || key === 'hooks.PreToolUse' || key === ENABLED_KEY || key === CREDENTIALS;
      return correctFile && (!gains || change === 'added') && Boolean(allowed[key]?.(value));
    },
    admitsPath: (path, directory = false) => directory ? directories.includes(path)
      : filePaths.includes(path) || (AGENT_VARIANTS.includes(variant) && covers(join(facts.root, AGENTS_DIR), path)),
  };
};

const jsonAt = (path) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
const halted = (lines) => Object.assign(new Error(lines.join('\n')), { code: 'CHECK_HALTED', lines });
const maskedFiles = (variant, facts) => {
  const paths = VELOCITY_VARIANTS.includes(variant) || variant === 'autonomy-render' || HOOK_VARIANTS.includes(variant)
    ? [SETTINGS_FILE, SETTINGS_LOCAL_FILE] : MCP_VARIANTS.includes(variant) ? [MCP_JSON_REL, SETTINGS_FILE] : [];
  return paths.flatMap((path) => lstatSync(join(facts.root, path), { throwIfNoEntry: false })?.isCharacterDevice()
    ? [`masked: ${path}`] : []);
};
export const plannedChange = (variant, facts, deps = {}) => {
  const files = [];
  const writes = [];
  const temporaries = [];
  const writerDeps = writerFacts(facts, deps);
  const addFile = (path, before, after) => {
    files.push({ path, before: before ?? null, after });
  };
  try {
    const masks = maskedFiles(variant, facts);
    if (masks.length) throw halted(masks);
    if (VELOCITY_VARIANTS.includes(variant)) {
      const plan = writeVelocityProfile({ cwd: facts.root, dryRun: true,
        kitTools: variant === 'kit-tools-tier', bridgeTier: variant === 'bridge-tier' }, writerDeps);
      const before = plan.projectSettings.data ?? {};
      let after = structuredClone(before);
      after.permissions = { ...before.permissions,
        allow: [...(before.permissions?.allow ?? []), ...plan.toAdd, ...plan.tierToAdd, ...plan.bridgeToAdd] };
      if (plan.excludedToAdd.length || plan.hostsToAdd.length) {
        after.sandbox = { ...before.sandbox };
        if (plan.excludedToAdd.length) after.sandbox.excludedCommands = [...(before.sandbox?.excludedCommands ?? []), ...plan.excludedToAdd];
        if (plan.hostsToAdd.length) after.sandbox.network = { ...before.sandbox?.network,
          allowedDomains: [...(before.sandbox?.network?.allowedDomains ?? []), ...plan.hostsToAdd] };
      }
      after = mergeAllowWrite(after, plan.dirsToAdd);
      addFile(SETTINGS_FILE, plan.projectSettings.data, after);
    } else if (variant === 'autonomy-render') {
      const render = writeAutonomyProfile({ cwd: facts.root, apply: false }, writerDeps);
      const before = jsonAt(join(facts.root, SETTINGS_FILE));
      addFile(SETTINGS_FILE, before, mergeAutonomySettings(before, render));
    } else if (HOOK_VARIANTS.includes(variant)) {
      const plan = writeGateHook({ cwd: facts.root, dryRun: true }, writerDeps);
      if (plan.wirePlanned) addFile(SETTINGS_FILE, plan.projectSettings.data, mergeHookEntry(plan.projectSettings.data));
      if (plan.placePlanned) writes.push({ path: join(facts.root, HOOK_FILE_REL), bytes: plan.bundleContent });
    } else if (MCP_VARIANTS.includes(variant)) {
      const result = writeMcp({ cwd: facts.root, dryRun: true, replace: variant === 'mcp-channel.differing' }, writerDeps);
      const { plan, registration } = result;
      if (plan.writeMcpJson) addFile(MCP_JSON_REL, registration.mcpJson.data, JSON.parse(plan.mcpBody));
      if (plan.writeSettings) addFile(SETTINGS_FILE, registration.settings.data, JSON.parse(plan.settingsBody));
    } else if (AGENT_VARIANTS.includes(variant)) {
      const plan = writeCheapAgents({ cwd: facts.root, dryRun: true }, writerDeps);
      for (const item of plan.plan.filter(({ action }) => ['place', 're-derive'].includes(action))) {
        writes.push({ path: item.abs, bytes: item.content });
      }
    } else if (SKILL_VARIANTS.includes(variant)) {
      const plan = planFor({ ...writerDeps, lstat: lstatSync, readdir: readdirSync, readFile: readFileSync });
      for (const target of plan.targets.filter(({ action }) => ['install', 'replace'].includes(action))) {
        const stem = basename(target.path);
        const bytes = Object.keys(SKILL_FILES).sort().map((name) => [name,
          readFileSync(join(facts.toolsDir, '..', 'references', 'vendor', stem, SKILL_FILES[name]))]);
        writes.push({ path: target.path, bytes: Buffer.concat(bytes.flatMap(([name, body]) => [Buffer.from(`${name}\0`), body])), directory: true });
        temporaries.push(`temporary: ${dirname(target.root)}/.${stem}.kit-tmp-*`);
        if (target.action === 'replace') temporaries.push(`temporary: ${dirname(target.root)}/.${stem}.kit-old-*`);
      }
    } else throw new Error(`unsupported variant: ${variant}`);
  } catch (error) {
    throw error.code === 'CHECK_HALTED' ? error : halted([error.message]);
  }
  const directories = new Set();
  const changedFiles = files.filter(({ before, after }) => diffFiles(before, after).length);
  for (const path of [...changedFiles.map(({ path }) => join(facts.root, path)), ...writes.map(({ path }) => path)]) {
    for (let parent = dirname(path); !existsSync(parent); parent = dirname(parent)) directories.add(parent);
  }
  return { files, writes, temporaries, directories: [...directories] };
};

export const checkApply = (variant, facts, deps = {}) => {
  const plan = plannedChange(variant, facts, deps);
  const scope = scopeOf(variant, facts, deps);
  const { entries, refused } = judgeChange({ variant, files: plan.files, scope });
  const lines = [];
  const display = (path) => facts.root && covers(facts.root, path) ? relative(facts.root, path) : path;
  for (const file of plan.files) {
    const changes = entries.filter(({ path }) => path === file.path);
    if (!changes.length) continue;
    lines.push(`${file.path}:`);
    for (const entry of changes) {
      const old = entry.change === 'altered' ? `${textValue(entry.previous)} → ` : '';
      lines.push(`  ${entry.key}: ${entry.change} ${old}${textValue(entry.value)} — ${entry.class ?? 'unknown'}`);
    }
  }
  const pathLine = (path, directory, line) => {
    lines.push(line);
    if (!scope.admitsPath(path, directory)) refused.push({ path: display(path), key: display(path),
      reason: `beyond the declared scope of ${variant}` });
  };
  for (const write of plan.writes) pathLine(write.path, false, `writes: ${display(write.path)} sha256:${sha(write.bytes)}`);
  for (const path of plan.directories) pathLine(path, true, `writes: ${display(path)}/ created`);
  lines.push(...plan.temporaries);
  if (refused.length) {
    for (const entry of refused) lines.push(`refused: ${entry.path} ${entry.key} — ${entry.reason}`);
    lines.push('nothing written');
  } else lines.push(lines.length ? `scope: within the declared scope of ${variant}` : `nothing to change: ${variant} is already applied`);
  const digest = sha(lines.join('\n'));
  return { lines: [...lines, `digest: ${digest}`], digest, refused };
};

const USAGE = 'usage: apply-danger-check --variant <v> --cwd <root> [--claude-dir <abs>] [--apply --expect <digest>]';
const parse = (argv, platform) => {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--apply') args.apply = true;
    else if (['--variant', '--cwd', '--claude-dir', '--expect'].includes(flag)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new Error(`${flag} takes a value`);
      args[flag.slice(2)] = value;
      index += 1;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  if (!VARIANTS.includes(args.variant) || !args.cwd) throw new Error('--variant and --cwd are required for a harness variant');
  if (args['claude-dir'] && (!SKILL_VARIANTS.includes(args.variant)
    || !(platform === 'win32' ? win32.isAbsolute : isAbsolute)(args['claude-dir']))) throw new Error('--claude-dir requires a skill variant and an absolute path');
  if (Boolean(args.apply) !== Boolean(args.expect) || (args.expect && !/^[0-9a-f]{64}$/.test(args.expect))) {
    throw new Error('--apply requires --expect with 64 lowercase hex characters');
  }
  args.root = resolve(args.cwd);
  if (!statSync(args.root).isDirectory()) throw new Error('--cwd must be a directory');
  return args;
};
export const main = (argv, io = {}) => {
  const resolved = { log: console.log, error: console.error, env: process.env, home: homedir(),
    platform: process.platform, toolsDir: TOOLS,
    spawn: (argv, options) => spawnSync(argv[0], argv.slice(1), options), ...io };
  let args;
  try {
    args = parse(argv, resolved.platform);
  } catch (error) {
    resolved.error(error.message);
    return 2;
  }
  if (args.help) {
    resolved.log(USAGE);
    return 0;
  }
  const facts = { toolsDir: resolved.toolsDir, root: args.root, env: resolved.env, home: resolved.home,
    platform: resolved.platform, claudeDir: args['claude-dir'] };
  let result;
  try {
    result = checkApply(args.variant, facts, { detect: resolved.detect });
  } catch (error) {
    for (const line of error.lines ?? [error.message]) resolved.log(line);
    return 3;
  }
  for (const line of result.lines) resolved.log(line);
  if (result.refused.length) return 1;
  if (!args.apply) return 0;
  if (args.expect !== result.digest) return 5;
  const spawnFacts = facts.claudeDir ? { ...facts, env: { ...facts.env, CLAUDE_CONFIG_DIR: facts.claudeDir } } : facts;
  const child = resolved.spawn(consoleArgv(args.variant, spawnFacts).apply,
    { cwd: facts.root, env: resolved.env, stdio: 'inherit' });
  if (child.status === 0) return 0;
  resolved.error(`apply exited ${child.status}`);
  return 6;
};

if (isDirectRun(import.meta.url)) process.exitCode = main(process.argv.slice(2));
