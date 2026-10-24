import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as velocity from './velocity-profile.mjs';
import * as hook from './gate-hook.mjs';
import { writeMcp } from './mcp.mjs';
import { buildServerEntry } from './mcp-registration.mjs';
import { writeCheapAgents } from './cheap-agents.mjs';
import { planFor } from './jev-skill.mjs';
import { SKILL_FILES, SKILL_PINS, skillTargets } from './jev-facts.mjs';
import { detectBackends, findOnPath } from './detect-backends.mjs';
import { ACTIVITIES } from './carriers.mjs';
import * as lanes from './write-lanes.mjs';
import { spawnSync } from 'node:child_process';
import { hermeticGitEnv } from './git-env.mjs';
import { shellQuoteArg } from './repo-lex.mjs';
import { homeRelative, mergeAllowWrite } from './bridge-state-dirs.mjs';
import { SOURCE_SIZE_DEFAULTS } from './source-size-config.mjs';

const leaf = await import('./state-block-hook.mjs').catch(() => ({}));
const worktrees = await import('./worktrees.mjs');
const need = (name) => {
  if (!(name in leaf)) throw new Error(name + ' is absent');
  return leaf[name];
};
const danger = await import('./apply-danger-check.mjs').catch((cause) => new Proxy({}, {
  get: (_, name) => {
    if (name === 'then') return undefined;
    return () => {
      throw new Error(`apply-danger-check.mjs unavailable: ${String(name)}`, { cause });
    };
  },
}));
const TOOLS = dirname(fileURLToPath(import.meta.url));
const SETTINGS = '.claude/settings.json';
const VARIANTS = ['velocity-core', 'kit-tools-tier', 'bridge-tier', 'autonomy-render', 'gate-hook',
  'read-lane.missing', 'mcp-channel', 'mcp-channel.differing', 'agents', 'executor-vehicle',
  'jev-skill', 'jev-skill.earlier', 'worktrees-dir'];
const CLASSES = ['hosts reachable', 'paths writable', 'commands outside the sandbox', 'prompts removed',
  'commands the harness runs', 'nothing widened'];
const NOTHING = CLASSES[5];
const askRule = () => {
  if (!('APPLY_ASK_RULE' in velocity)) throw new Error('APPLY_ASK_RULE is absent');
  return velocity.APPLY_ASK_RULE;
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sorted = (entries) => entries.map((entry) => JSON.stringify(entry)).sort();
const textValue = (value) => typeof value === 'string' ? value : JSON.stringify(value);
const lineOf = ({ key, change, value, previous, class: kind }) =>
  `  ${key}: ${change} ${change === 'altered' ? `${textValue(previous)} → ` : ''}${textValue(value)} — ${kind ?? 'unknown'}`;
const atKey = (key, value) => key.split('.').reduceRight((child, name) => ({ [name]: child }), value);
const put = (path, bytes) => {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, bytes);
};
const json = (path) => fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : null;
const tree = (root) => {
  const entries = {};
  const walk = (path) => {
    const stat = fs.lstatSync(path);
    const key = relative(root, path);
    if (stat.isSymbolicLink()) entries[key] = ['link', stat.mode, fs.readlinkSync(path)];
    else if (stat.isDirectory()) {
      entries[key] = ['dir', stat.mode];
      for (const name of fs.readdirSync(path).sort()) walk(join(path, name));
    } else entries[key] = ['file', stat.mode, fs.readFileSync(path).toString('hex')];
  };
  walk(root);
  return entries;
};
const hashes = (f) => [f.root, f.home, ...(f.env.CODEX_HOME ? [resolve(f.root, f.env.CODEX_HOME)] : [])]
  .map((path) => sha(JSON.stringify(tree(path))));
const unchanged = (f, run) => {
  const before = hashes(f);
  try {
    return run();
  } finally {
    assert.deepEqual(hashes(f), before, 'project and synthetic home unchanged');
    assert.equal(process.exit.mock.callCount(), 0, 'main never calls process.exit');
  }
};
const fixture = (t) => {
  const base = fs.mkdtempSync(join(tmpdir(), 'danger-check-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'root');
  const home = join(base, 'home');
  const bin = join(base, 'bin');
  fs.mkdirSync(home);
  put(join(root, 'docs/ai/.workflow-version'), `${velocity.EXPECTED_WORKFLOW_VERSION}\n`);
  put(join(root, 'docs/ai/autonomy.json'), JSON.stringify({ 'plan-execution': { autonomy: 'sandbox' } }));
  put(join(root, 'docs/ai/worktrees.json'), JSON.stringify({ parentDir: 'wt' }));
  fs.mkdirSync(join(root, 'wt'));
  for (const name of [...velocity.BRIDGE_REVIEW_WRAPPERS, 'codex', 'agy', 'codex-exec', 'agy-run', 'bwrap', 'socat', 'claude']) {
    put(join(bin, name), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(join(bin, name), 0o755);
  }
  put(join(home, '.codex/auth.json'), '{}');
  put(join(home, '.gemini/antigravity-cli/antigravity-oauth-token'), '{}');
  put(join(bin, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.291' }));
  t.mock.method(process, 'exit', () => {
    throw new Error('main must return without exiting');
  });
  return { toolsDir: TOOLS, root, home, bin, platform: process.platform,
    env: { HOME: home, PATH: `${bin}:${dirname(process.execPath)}`,
      CODEX_CLI_BRIDGE_DIR: join(TOOLS, '../bridges/codex-cli-bridge'),
      ANTIGRAVITY_CLI_BRIDGE_DIR: join(TOOLS, '../bridges/antigravity-cli-bridge') } };
};
const capture = (f, spawn) => {
  const lines = [];
  const errors = [];
  const io = { ...f, log: (line) => lines.push(line), error: (line) => errors.push(line) };
  if (spawn) io.spawn = spawn;
  return { io, lines, errors };
};
const argvFor = (variant, f) => ['--variant', variant, '--cwd', f.root,
  ...(f.claudeDir ? ['--claude-dir', f.claudeDir] : [])];
const digestResult = (result) => {
  assert.match(result.digest, /^[0-9a-f]{64}$/);
  assert.equal(result.lines.at(-1), `digest: ${result.digest}`);
  assert.equal(result.digest, sha(result.lines.slice(0, -1).join('\n')));
};
const writerDeps = (f) => ({ ...f,
  findWrapper: (name) => findOnPath(name, { getenv: f.env }).state === 'present',
  findOnPath: (name) => findOnPath(name, { getenv: f.env }) });
const expectedPlan = (variant, f, deps = {}) => {
  const files = [];
  const writes = [];
  const temporaries = [];
  const worktreesDirectories = [];
  const addFile = (path, after) => files.push({ path, before: json(join(f.root, path)), after });
  if (['velocity-core', 'kit-tools-tier', 'bridge-tier'].includes(variant)) {
    const p = velocity.writeVelocityProfile({ cwd: f.root, dryRun: true,
      kitTools: variant === 'kit-tools-tier', bridgeTier: variant === 'bridge-tier' }, writerDeps(f));
    const before = p.projectSettings.data ?? {};
    const after = structuredClone(before);
    after.permissions = { ...before.permissions, allow: [...(before.permissions?.allow ?? []),
      ...p.toAdd, ...p.tierToAdd, ...p.bridgeToAdd] };
    if ((p.askToAdd ?? []).length) after.permissions.ask = [...(before.permissions?.ask ?? []), ...p.askToAdd];
    if (p.excludedToAdd.length || p.hostsToAdd.length) after.sandbox = {
      ...before.sandbox, excludedCommands: [...(before.sandbox?.excludedCommands ?? []), ...p.excludedToAdd],
      network: { ...before.sandbox?.network,
        allowedDomains: [...(before.sandbox?.network?.allowedDomains ?? []), ...p.hostsToAdd] } };
    if ((p.dirsToAdd ?? []).length) after.sandbox = { ...after.sandbox,
      filesystem: { ...before.sandbox?.filesystem,
        allowWrite: [...(before.sandbox?.filesystem?.allowWrite ?? []), ...(p.dirsToAdd ?? [])] } };
    addFile(SETTINGS, after);
  } else if (variant === 'autonomy-render') {
    const render = velocity.writeAutonomyProfile({ cwd: f.root, apply: false }, writerDeps(f));
    addFile(SETTINGS, velocity.mergeAutonomySettings(json(join(f.root, SETTINGS)), render));
  } else if (['gate-hook', 'read-lane.missing'].includes(variant)) {
    const p = hook.writeGateHook({ cwd: f.root, dryRun: true });
    if (p.wirePlanned) addFile(SETTINGS, hook.mergeHookEntry(p.projectSettings.data));
    if (p.placePlanned) writes.push({ path: join(f.root, hook.HOOK_FILE_REL), bytes: p.bundleContent });
  } else if (['gate-hook.marker-stale', 'read-lane.stale'].includes(variant)) {
    const p = hook.writeGateHook({ cwd: f.root, dryRun: true, reseed: true });
    if (p.wirePlanned) addFile(SETTINGS, hook.mergeHookEntry(p.projectSettings.data));
    const path = join(f.root, hook.HOOK_FILE_REL);
    if (p.reseedPlanned) writes.push({ path, bytes: p.bundleContent, replaces: fs.readFileSync(path) });
  } else if (variant === 'state-block') {
    const p = need('writeStateBlockHook')({ cwd: f.root, dryRun: true });
    if (p.mergePlanned) addFile(SETTINGS, need('mergeStopEntry')(p.projectSettings.data));
    const path = join(f.root, '.claude/hooks/state-block-guard.mjs');
    if (p.placement === 'create') writes.push({ path, bytes: p.bundleContent });
    if (p.placement === 'replace') writes.push({ path, bytes: p.bundleContent, replaces: fs.readFileSync(path) });
  } else if (variant.startsWith('mcp-channel')) {
    const p = writeMcp({ cwd: f.root, dryRun: true, replace: variant.endsWith('.differing') }).plan;
    if (p.writeMcpJson) addFile('.mcp.json', JSON.parse(p.mcpBody));
    if (p.writeSettings) addFile(SETTINGS, JSON.parse(p.settingsBody));
  } else if (['agents', 'executor-vehicle'].includes(variant)) {
    const p = writeCheapAgents({ cwd: f.root, dryRun: true });
    for (const item of p.plan.filter(({ action }) => ['place', 're-derive'].includes(action))) {
      writes.push({ path: item.abs, bytes: item.content, ...(item.action === 're-derive' ? { replaces: fs.readFileSync(item.abs) } : {}) });
    }
  } else if (variant === 'worktrees-dir') {
    const p = velocity.writeVelocityProfile({ cwd: f.root, dryRun: true, worktrees: true }, writerDeps(f));
    addFile('.claude/settings.local.json', mergeAllowWrite(json(join(f.root, '.claude/settings.local.json')) ?? {}, p.worktreesDirToAdd ?? []));
    worktreesDirectories.push(...(p.worktreesDirsToCreate ?? []));
  } else {
    const p = planFor({ ...f, ...deps, lstat: fs.lstatSync, readdir: fs.readdirSync, readFile: fs.readFileSync });
    for (const target of p.targets.filter(({ action }) => ['install', 'replace'].includes(action))) {
      writes.push({ path: target.path, directory: true });
      const stem = basename(target.path);
      temporaries.push(`temporary: ${dirname(target.root)}/.${stem}.kit-tmp-*`);
      if (target.action === 'replace') temporaries.push(`temporary: ${dirname(target.root)}/.${stem}.kit-old-*`);
    }
  }
  const directories = new Set();
  for (const path of worktreesDirectories) directories.add(path);
  for (const path of [...files.map(({ path }) => join(f.root, path)), ...writes.map(({ path }) => path)]) {
    for (let parent = dirname(path); !fs.existsSync(parent); parent = dirname(parent)) directories.add(parent);
  }
  return { files, writes, temporaries, directories: [...directories] };
};
const printablePath = (f, path) => path.startsWith(`${f.root}/`) ? relative(f.root, path) : path;
const assertPreview = (variant, f, result, plan) => {
  digestResult(result);
  assert.deepEqual(result.refused, []);
  const expected = danger.judgeChange({ variant, files: plan.files, scope: danger.scopeOf(variant, f) });
  assert.deepEqual(expected.refused, []);
  assert.deepEqual(result.lines.filter((line) => line.startsWith('  ')), expected.entries.map(lineOf));
  assert.deepEqual(result.lines.filter((line) => line.endsWith(':')),
    plan.files.filter(({ before, after }) => danger.diffFiles(before, after).length).map(({ path }) => `${path}:`));
  for (const write of plan.writes) {
    const prefix = `writes: ${printablePath(f, write.path)} sha256:`;
    const line = result.lines.find((item) => item.startsWith(prefix));
    assert.ok(line, prefix);
    if (write.directory) assert.match(line.slice(prefix.length), /^[0-9a-f]{64}$/);
    else {
      const replaces = write.replaces === undefined ? '' : ` — replaces sha256:${sha(write.replaces)}`;
      assert.equal(line, prefix + sha(write.bytes) + replaces);
    }
  }
  for (const path of plan.directories) assert.ok(result.lines.includes(`writes: ${printablePath(f, path)}/ created`));
  assert.deepEqual(result.lines.filter((line) => line.startsWith('temporary: ')).sort(), plan.temporaries.sort());
  assert.ok(result.lines.includes(`scope: within the declared scope of ${variant}`));
};
const copyFixture = (t, f) => {
  const copy = fixture(t);
  for (const key of ['root', 'home', 'bin']) {
    fs.rmSync(copy[key], { recursive: true, force: true });
    fs.cpSync(f[key], copy[key], { recursive: true });
  }
  if (f.claudeDir) copy.claudeDir = join(copy.home, relative(f.home, f.claudeDir));
  return copy;
};
const assertAppliedPaths = (f, before, result, files) => {
  const after = snapshot(f);
  const changed = Object.keys(after).filter((path) => JSON.stringify(after[path]) !== JSON.stringify(before[path]));
  assert.deepEqual(Object.keys(before).filter((path) => !(path in after)), [], 'apply removes no standing path');
  const paths = result.lines.filter((line) => line.startsWith('writes: ')).map((line) =>
    line.slice(8).replace(/ — replaces sha256:[0-9a-f]{64}$/, '').replace(/ sha256:[0-9a-f]{64}$/, '').replace(/\/ created$/, ''));
  const rest = changed.filter((path) => !files.includes(path));
  for (const path of rest) assert.ok(paths.some((p) => path === p || path.startsWith(`${p}/`)), `unprinted write: ${path}`);
  for (const path of paths) assert.ok(rest.some((p) => p === path || p.startsWith(`${path}/`)), `unchanged printed path: ${path}`);
};
const snapshot = (f) => ({ ...tree(f.root),
  ...Object.fromEntries(Object.entries(tree(f.home)).map(([p, v]) => [join(f.home, p), v])) });

const LIST_ROWS = [
  ['permissions.allow', 'Bash(ls:*)', CLASSES[3], NOTHING],
  ['permissions.ask', 'Bash(git commit:*)', NOTHING, CLASSES[3]],
  ['permissions.deny', 'Bash(npm publish:*)', NOTHING, CLASSES[3]],
  ['sandbox.network.allowedDomains', 'example.test', CLASSES[0], NOTHING],
  ['sandbox.filesystem.allowWrite', '/scratch', CLASSES[1], NOTHING],
  ['sandbox.excludedCommands', 'codex-review', CLASSES[2], NOTHING],
  ['hooks.PreToolUse', hook.buildHookSettingsEntry(), CLASSES[4], NOTHING],
  ['hooks.Stop', { hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/state-block-guard.mjs"', timeout: 10 }] }, CLASSES[4], NOTHING],
  ['enabledMcpjsonServers', 'agent-workflow', CLASSES[4], NOTHING],
];
const SCALAR_ROWS = [
  ['permissions.defaultMode', ['default', 'acceptEdits', 'plan'], [NOTHING, CLASSES[3], NOTHING]],
  ['sandbox.enabled', [false, true], [CLASSES[3], NOTHING]],
  ['sandbox.autoAllowBashIfSandboxed', [false, true], [NOTHING, CLASSES[3]]],
];
const judged = (before, after, path = SETTINGS) =>
  danger.judgeChange({ variant: 'table', files: [{ path, before, after }], scope: { admits: () => true } });

describe('spec:init-project/S21 closed classification table and key-level diff', () => {
  it('exports a frozen closed table and pure entry points', () => {
    assert.deepEqual(danger.diffFiles(null, {}), []);
    assert.deepEqual(danger.CHANGE_CLASSES, CLASSES);
    assert.ok(Object.isFrozen(danger.CHANGE_CLASSES));
    assert.ok(Object.isFrozen(danger.KEY_TABLE));
    assert.deepEqual(Object.keys(danger.KEY_TABLE).sort(),
      [...LIST_ROWS, ...SCALAR_ROWS].map(([key]) => key).concat('sandbox.credentials.envVars', 'mcpServers', 'attribution').sort());
    assert.equal(danger.CHANGE_CLASSES[danger.KEY_TABLE.attribution], NOTHING);
    for (const name of ['judgeChange', 'scopeOf', 'plannedChange', 'checkApply', 'main']) assert.equal(typeof danger[name], 'function');
  });
  for (const [key, value, addedClass, removedClass] of LIST_ROWS) it(`${key}: additions and removals over absent, empty and populated files`, () => {
    const populated = atKey(key, [value]);
    for (const empty of [null, {}, atKey(key, [])]) {
      for (const [before, after, change, kind] of [[empty, populated, 'added', addedClass], [populated, empty, 'removed', removedClass]]) {
        const entry = { key, change, value };
        assert.deepEqual(danger.diffFiles(before, after), [entry]);
        assert.deepEqual(judged(before, after), { entries: [{ ...entry, path: SETTINGS, class: kind }], refused: [] });
      }
    }
    assert.deepEqual(danger.diffFiles(populated, structuredClone(populated)), []);
    const replacement = typeof value === 'string' ? `${value}-other` : { ...value, matcher: 'Write' };
    assert.deepEqual(sorted(danger.diffFiles(populated, atKey(key, [replacement]))),
      sorted([{ key, change: 'removed', value }, { key, change: 'added', value: replacement }]));
  });
  for (const [key, values, kinds] of SCALAR_ROWS) it(`${key}: each value and both directions, including scalar removals`, () => {
    for (const [index, value] of values.entries()) {
      const after = atKey(key, value);
      for (const prior of [undefined, ...values.filter((v) => v !== value)]) {
        for (const before of prior === undefined ? [null, {}] : [atKey(key, prior)]) {
          const entry = prior === undefined ? { key, change: 'added', value } : { key, change: 'altered', value, previous: prior };
          assert.deepEqual(danger.diffFiles(before, after), [entry]);
          assert.deepEqual(judged(before, after), { entries: [{ ...entry, path: SETTINGS, class: kinds[index] }], refused: [] });
        }
      }
      for (const empty of [null, {}]) assert.deepEqual(danger.diffFiles(after, empty), [{ key, change: 'removed', value }]);
      assert.deepEqual(danger.diffFiles(after, structuredClone(after)), []);
    }
  });
  it('credentials compare by name, add deny without widening, and refuse every removal or alteration', () => {
    const key = 'sandbox.credentials.envVars';
    const value = { name: 'TOKEN', mode: 'deny' };
    const populated = atKey(key, [value]);
    for (const before of [null, {}, atKey(key, [])]) {
      assert.deepEqual(judged(before, populated), { entries: [{ path: SETTINGS, key, change: 'added', value, class: NOTHING }], refused: [] });
    }
    const masked = { name: 'NPM_TOKEN', mode: 'mask' };
    for (const [before, after, entry] of [
      [atKey(key, [{ ...masked, mode: 'deny' }, masked]), atKey(key, [{ ...masked, mode: 'deny' }]), { change: 'removed', value: masked }],
      [populated, {}, { change: 'removed', value }],
      [populated, atKey(key, [{ ...value, mode: 'mask' }]), { change: 'altered', value: { ...value, mode: 'mask' }, previous: value }],
      [populated, atKey(key, [{ ...value, extra: true }]), { change: 'altered', value: { ...value, extra: true }, previous: value }]]) {
      assert.deepEqual(danger.diffFiles(before, after), [{ key, ...entry }]);
      assert.deepEqual(judged(before, after).refused, [{ path: SETTINGS, key, reason: 'credentials entry removed or altered' }]);
    }
    const twice = atKey(key, [{ name: 'GITHUB_TOKEN', mode: 'deny' }, { name: 'GITHUB_TOKEN', mode: 'deny' }]);
    assert.deepEqual(danger.diffFiles(twice, atKey(key, [{ name: 'GITHUB_TOKEN', mode: 'deny' }])), []);
    assert.deepEqual(danger.diffFiles(populated, atKey(key, [{ mode: 'deny', name: 'TOKEN' }])), []);
    assert.deepEqual(sorted(danger.diffFiles(populated, atKey(key, [{ name: 'OTHER', mode: 'deny' }]))),
      sorted([{ key, change: 'removed', value }, { key, change: 'added', value: { name: 'OTHER', mode: 'deny' } }]));
  });
  it('MCP servers diff individually and classify additions, alterations and removals', () => {
    const key = 'mcpServers.agent-workflow';
    const value = buildServerEntry(join(TOOLS, 'mcp-server.mjs'));
    const populated = { mcpServers: { 'agent-workflow': value } };
    for (const empty of [null, {}, { mcpServers: {} }]) {
      for (const [before, after, change, kind] of [[empty, populated, 'added', CLASSES[4]], [populated, empty, 'removed', NOTHING]]) {
        assert.deepEqual(danger.diffFiles(before, after), [{ key, change, value }]);
        const result = danger.judgeChange({ variant: 'table', files: [{ path: '.mcp.json', before, after }], scope: { admits: () => true } });
        assert.deepEqual(result, { entries: [{ path: '.mcp.json', key, change, value, class: kind }], refused: [] });
      }
    }
    const altered = buildServerEntry('/other.mjs');
    const after = { mcpServers: { 'agent-workflow': altered } };
    assert.deepEqual(danger.diffFiles(populated, after), [{ key, change: 'altered', value: altered, previous: value }]);
    assert.deepEqual(judged(populated, after, '.mcp.json'), {
      entries: [{ path: '.mcp.json', key, change: 'altered', value: altered, previous: value, class: CLASSES[4] }], refused: [] });
    assert.deepEqual(sorted(danger.diffFiles(populated, { mcpServers: { other: value } })), sorted([
      { key, change: 'removed', value }, { key: 'mcpServers.other', change: 'added', value }]));
    assert.deepEqual(judged(null, { mcpServers: { other: value } }, '.mcp.json'), {
      entries: [{ path: '.mcp.json', key: 'mcpServers.other', change: 'added', value, class: CLASSES[4] }], refused: [] });
    assert.deepEqual(danger.diffFiles(populated, structuredClone(populated)), []);
  });
  const refusals = [
    ['env', { A: '1' }, 'unknown key'], ['sandbox.foo', 1, 'unknown key'],
    ['sandbox.credentials.files', ['/secret'], 'unknown key'],
    ...LIST_ROWS.map(([key]) => [key, 'not-an-array', 'wrong type']),
    ['sandbox.enabled', 'true', 'wrong type'], ['sandbox.autoAllowBashIfSandboxed', 1, 'wrong type'],
    ['permissions.defaultMode', false, 'wrong type'], ['mcpServers', [], 'wrong type'],
    ['sandbox.credentials.envVars', [{ mode: 'deny' }], 'wrong type'],
  ];
  for (const [key, value, reason] of refusals) it(`${key}: refuses ${reason} despite an admitting scope`, () => {
    const path = key === 'mcpServers' ? '.mcp.json' : SETTINGS;
    for (const [before, after, change, changedValue] of [[null, atKey(key, value), 'added', value],
      [atKey(key, value), {}, 'removed', value], [atKey(key, value), atKey(key, null), 'altered', null]]) {
      const entry = { key, change, value: changedValue, ...(change === 'altered' ? { previous: value } : {}) };
      assert.deepEqual(danger.diffFiles(before, after), [entry]);
      const result = judged(before, after, path);
      assert.deepEqual(result.refused, [{ path, key, reason }]);
      if (reason === 'unknown key') assert.deepEqual(result.entries, [{ ...entry, path, class: null }]);
    }
  });
});

describe('spec:init-project/S22 real writers, declared scopes and unchanged trees', () => {
  for (const variant of VARIANTS) it(`${variant}: real preview, created directories, copy apply and already applied`, (t) => {
    const f = fixture(t);
    if (variant.endsWith('.differing')) put(join(f.root, '.mcp.json'), JSON.stringify({ mcpServers: { 'agent-workflow': buildServerEntry('/old.mjs') } }));
    const originalHashes = hashes(f);
    const plan = unchanged(f, () => expectedPlan(variant, f));
    unchanged(f, () => {
      const result = danger.checkApply(variant, f);
      assertPreview(variant, f, result, plan);
      if (variant.endsWith('.differing')) assert.ok(result.lines.some((line) => line.startsWith('  mcpServers.agent-workflow: altered ')
        && line.split(' → ')[0].includes('/old.mjs') && line.split(' → ')[1]?.includes(join(TOOLS, 'mcp-server.mjs'))));
      assert.deepEqual(danger.checkApply(variant, f), result, 'stable digest');
      const cli = capture(f, () => { throw new Error('preview spawned'); });
      assert.equal(danger.main(argvFor(variant, f), cli.io), 0);
      assert.deepEqual(cli.lines, result.lines);
      assert.deepEqual(cli.errors, []);
    });
    const copy = copyFixture(t, f);
    const before = snapshot(copy);
    const settingsBefore = new Map([SETTINGS, '.mcp.json', '.claude/settings.local.json'].map((path) => [path, json(join(copy.root, path))]));
    const result = unchanged(copy, () => danger.checkApply(variant, copy));
    const cli = capture(copy);
    assert.equal(danger.main([...argvFor(variant, copy), '--apply', '--expect', result.digest], cli.io), 0);
    assert.deepEqual(cli.lines, result.lines);
    for (const [path, data] of settingsBefore) {
      const entries = danger.diffFiles(data, json(join(copy.root, path)));
      const header = result.lines.indexOf(`${path}:`);
      const printed = header < 0 ? [] : result.lines.slice(header + 1).filter((line, i, tail) =>
        line.startsWith('  ') && tail.slice(0, i).every((prior) => prior.startsWith('  ')));
      const judgedEntries = danger.judgeChange({ variant, files: [{ path, before: data, after: json(join(copy.root, path)) }], scope: danger.scopeOf(variant, copy) });
      assert.deepEqual(printed, judgedEntries.entries.map(lineOf));
      assert.deepEqual(sorted(judgedEntries.entries.map(({ path: _, class: __, ...entry }) => entry)), sorted(entries));
    }
    assertAppliedPaths(copy, before, result, [SETTINGS, '.mcp.json', '.claude/settings.local.json']);
    unchanged(copy, () => {
      const applied = danger.checkApply(variant, copy);
      digestResult(applied);
      assert.deepEqual(applied.lines.slice(0, -1), [`nothing to change: ${variant} is already applied`]);
      assert.deepEqual(applied.refused, []);
      assert.equal(danger.main(argvFor(variant, copy), capture(copy).io), 0);
    });
    assert.deepEqual(hashes(f), originalHashes, 'original retained while copy applied');
  });
  it('jev-skill.earlier: real planFor replacement prints skill writes and both temporary prefixes', (t) => {
    const f = fixture(t);
    const legacy = { 'SKILL.md': 'earlier skill\n', LICENSE: 'earlier license\n' };
    const pins = [...SKILL_PINS, { tag: 'fixture-earlier', digests:
      Object.fromEntries(Object.keys(SKILL_FILES).map((name) => [name, sha(legacy[name])])) }];
    for (const target of skillTargets({ home: f.home, claudeDir: join(f.home, '.claude') })) {
      for (const [name, bytes] of Object.entries(legacy)) put(join(target.path, name), bytes);
    }
    unchanged(f, () => {
      const plan = expectedPlan('jev-skill.earlier', f, { pins });
      assert.equal(plan.writes.length, 3);
      assert.equal(plan.temporaries.length, 6);
      const result = danger.checkApply('jev-skill.earlier', f, { pins });
      assertPreview('jev-skill.earlier', f, result, plan);
      assert.equal(result.lines.some((line) => line.startsWith('writes: ') && line.includes(' — replaces')), false);
    });
    const current = fixture(t);
    unchanged(current, () => {
      const result = danger.checkApply('jev-skill.earlier', current);
      const cli = capture(current);
      assert.equal(danger.main(argvFor('jev-skill.earlier', current), cli.io), 0);
      assert.deepEqual(cli.lines, result.lines);
    });
  });
  const plants = [
    ['a host of a bridge no slot uses', 'bridge-tier', 'sandbox.network.allowedDomains', () => {
      const agy = json(join(TOOLS, '../bridges/antigravity-cli-bridge/capability.json')).networkHosts;
      const codex = json(join(TOOLS, '../bridges/codex-cli-bridge/capability.json')).networkHosts;
      return agy.find((host) => !codex.includes(host));
    }],
    ['non-wrapper exclusion', 'bridge-tier', 'sandbox.excludedCommands', () => 'codex-exec'],
    ['unaudited allow', 'velocity-core', 'permissions.allow', () => 'Bash(node:*)'],
    ['writer apply rule', 'kit-tools-tier', 'permissions.allow', () => `Bash(node ${join(TOOLS, 'gate-hook.mjs')} --apply)`],
    ['source-size write rule', 'kit-tools-tier', 'permissions.allow', () => `Bash(node ${join(TOOLS, 'source-size-check.mjs')} --write-baseline)`],
    ['final gates rule', 'kit-tools-tier', 'permissions.allow', (f) => `Bash(node ${join(TOOLS, 'run-gates.mjs')} --cwd ${f.root} --final)`],
    ['foreign hook command', 'gate-hook', 'hooks.PreToolUse', () => ({ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other.mjs' }] })],
    ['other MCP server path', 'mcp-channel', 'mcpServers.agent-workflow', () => buildServerEntry('/other/mcp-server.mjs')],
    ['unsafe default mode', 'autonomy-render', 'permissions.defaultMode', () => 'bypassPermissions'],
  ];
  for (const [title, variant, key, valueOf] of plants) it(`${variant}: refuses ${title} naming ${key}`, (t) => {
    const f = fixture(t);
    fs.rmSync(join(f.bin, 'agy-review'));
    const value = valueOf(f);
    assert.notEqual(value, undefined, 'fixture has a bridge-specific host');
    unchanged(f, () => {
      const after = atKey(key, LIST_ROWS.some(([name]) => key === name) ? [value] : value);
      const path = key.startsWith('mcpServers.') ? '.mcp.json' : SETTINGS;
      assert.deepEqual(danger.diffFiles(null, after), [{ key, change: 'added', value }]);
      const result = danger.judgeChange({ variant, files: [{ path, before: null, after }], scope: danger.scopeOf(variant, f) });
      assert.deepEqual(result.refused, [{ path, key, reason: `beyond the declared scope of ${variant}` }]);
    });
  });
  it('a render with no claude refuses and names every removed credentials entry, exit 1', (t) => {
    const f = fixture(t);
    fs.rmSync(join(f.bin, 'claude'));
    const entries = ['NPM_TOKEN', 'GITHUB_TOKEN'].map((name) => ({ name, mode: 'deny' }));
    put(join(f.root, SETTINGS), JSON.stringify(atKey('sandbox.credentials.envVars', entries)));
    unchanged(f, () => {
      const result = danger.checkApply('autonomy-render', f);
      assert.equal(result.refused.length, entries.length);
      for (const value of entries) assert.ok(result.lines.some((line) =>
        line.startsWith(`  sandbox.credentials.envVars: removed ${JSON.stringify(value)} — `)));
      for (const refused of result.refused) assert.deepEqual(refused, {
        path: SETTINGS, key: 'sandbox.credentials.envVars', reason: 'credentials entry removed or altered' });
      assert.ok(result.lines.includes('nothing written'));
      const cli = capture(f, () => { throw new Error('refusal spawned'); });
      assert.equal(danger.main(argvFor('autonomy-render', f), cli.io), 1);
      assert.deepEqual(cli.lines, result.lines);
    });
  });
  it('a planned write outside the variant scope refuses naming its path, nothing written', (t) => {
    const f = fixture(t);
    const claudeDir = join(f.home, 'elsewhere');
    const scoped = skillTargets({ home: f.home, claudeDir: join(f.home, '.claude') }).map(({ path }) => path);
    const outside = skillTargets({ home: f.home, claudeDir }).map(({ path }) => path).filter((path) => !scoped.includes(path));
    unchanged(f, () => {
      const result = danger.checkApply('jev-skill', f, { claudeDir });
      assert.equal(outside.length, 1);
      assert.ok(result.refused.some(({ path, key }) => path === outside[0] && key === outside[0]));
      assert.ok(result.refused.every(({ reason }) => reason === 'beyond the declared scope of jev-skill'));
      assert.equal(result.lines.at(-2), 'nothing written');
    });
  });
  it('a character-device settings mask halts before judgement and prints masked at exit 3', (t) => {
    const f = fixture(t);
    put(join(f.root, SETTINGS), '{}');
    unchanged(f, () => {
      const original = fs.lstatSync;
      const mocked = t.mock.method(fs, 'lstatSync', (path, ...args) => path === join(f.root, SETTINGS)
        ? Object.assign(Object.create(original(path)), { isCharacterDevice: () => true, isFile: () => false })
        : original(path, ...args));
      syncBuiltinESMExports();
      try {
        assert.throws(() => danger.checkApply('velocity-core', f), (error) =>
          error.code === 'CHECK_HALTED' && JSON.stringify(error.lines) === JSON.stringify([`masked: ${SETTINGS}`]));
        const cli = capture(f, () => ({ status: 0 }));
        assert.equal(danger.main(argvFor('velocity-core', f), cli.io), 3);
        assert.deepEqual(cli.lines, [`masked: ${SETTINGS}`]);
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
    });
  });
  for (const [title, setup] of [
    ['malformed settings', (f) => put(join(f.root, SETTINGS), '{')],
    ['unsafe mode', (f) => put(join(f.root, SETTINGS), JSON.stringify(atKey('permissions.defaultMode', 'bypassPermissions')))],
    ['symlinked target', (f) => {
      put(join(f.root, 'other.json'), '{}');
      fs.mkdirSync(join(f.root, '.claude'));
      fs.symlinkSync(join(f.root, 'other.json'), join(f.root, SETTINGS));
    }],
  ]) it(`writer dry-run refusal: ${title}, exit 3`, (t) => {
    const f = fixture(t);
    setup(f);
    unchanged(f, () => {
      let message;
      try {
        velocity.writeVelocityProfile({ cwd: f.root, dryRun: true }, writerDeps(f));
      } catch (error) {
        message = error.message;
      }
      assert.ok(message, 'real writer refuses the fixture');
      assert.throws(() => danger.checkApply('velocity-core', f), (error) =>
        error.code === 'CHECK_HALTED' && JSON.stringify(error.lines) === JSON.stringify([message]));
      const cli = capture(f, () => ({ status: 0 }));
      assert.equal(danger.main(argvFor('velocity-core', f), cli.io), 3);
      assert.ok([...cli.lines, ...cli.errors].includes(message));
    });
  });
  it('an unreadable bridge manifest preserves the real writer refusal and exits 3', (t) => {
    const f = fixture(t);
    const path = join(TOOLS, '../bridges/codex-cli-bridge/capability.json');
    unchanged(f, () => {
      const original = fs.readFileSync;
      const mocked = t.mock.method(fs, 'readFileSync', (file, ...args) => {
        if (file === path) throw Object.assign(new Error('fixture manifest unreadable'), { code: 'EACCES' });
        return original(file, ...args);
      });
      syncBuiltinESMExports();
      try {
        let message;
        try {
          velocity.writeVelocityProfile({ cwd: f.root, dryRun: true, bridgeTier: true }, writerDeps(f));
        } catch (error) {
          message = error.message;
        }
        assert.ok(message, 'the real writer refuses an unreadable manifest');
        assert.throws(() => danger.checkApply('bridge-tier', f), (error) =>
          error.code === 'CHECK_HALTED' && JSON.stringify(error.lines) === JSON.stringify([message]));
        const cli = capture(f, () => ({ status: 0 }));
        assert.equal(danger.main(argvFor('bridge-tier', f), cli.io), 3);
        assert.ok([...cli.lines, ...cli.errors].includes(message));
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
    });
  });
});

describe('spec:init-project/S39 — the danger check over worktrees-dir by proof', () => {
  const variant = 'worktrees-dir';
  const local = '.claude/settings.local.json';
  const key = 'sandbox.filesystem.allowWrite';
  const reason = 'beyond the declared scope of worktrees-dir';
  const needWorktrees = (name) => {
    if (!(name in worktrees)) throw new Error(name + ' is absent');
    return worktrees[name];
  };
  const worktreesFixture = (t) => {
    const f = fixture(t);
    put(join(f.root, 'docs/ai/worktrees.json'), JSON.stringify({ parentDir: '../farm/deep' }));
    return f;
  };
  const unchangedWorktrees = (f, run) => unchanged(f, () => {
    const before = tree(dirname(f.root));
    try {
      return run();
    } finally {
      assert.deepEqual(tree(dirname(f.root)), before, 'whole temporary tree unchanged');
    }
  });
  for (const underHome of [false, true]) it(`no local file: exact ${underHome ? 'home-relative' : 'absolute'} grant and ordered created directories`, (t) => {
    const f = worktreesFixture(t);
    const parent = underHome ? join(f.home, 'wt') : join(dirname(f.root), 'farm/deep');
    if (underHome) put(join(f.root, 'docs/ai/worktrees.json'), JSON.stringify({ parentDir: parent }));
    unchangedWorktrees(f, () => {
      const result = danger.checkApply(variant, f);
      digestResult(result);
      assert.deepEqual(result.refused, []);
      const entry = underHome ? '~/wt' : parent;
      assert.deepEqual(result.lines, [
        `${local}:`, `  ${key}: added ${entry} — paths writable`, 'writes: .claude/ created',
        ...(!underHome ? [`writes: ${dirname(parent)}/ created`] : []),
        `writes: ${parent}/ created`, `scope: within the declared scope of ${variant}`, `digest: ${result.digest}`,
      ]);
      assert.equal(result.lines.some((line) => line.startsWith(SETTINGS) || line.startsWith('  permissions.')), false);
      const spawn = t.mock.fn(() => { throw new Error('preview spawned'); });
      const cli = capture(f, spawn);
      assert.equal(danger.main(argvFor(variant, f), cli.io), 0);
      assert.equal(spawn.mock.callCount(), 0);
      assert.deepEqual(cli.lines, result.lines);
      assert.deepEqual(cli.errors, []);
      assert.equal(entry, homeRelative(needWorktrees('worktreesGrantDir')(f.root), f.home));
    });
  });
  it('plants: only the extra grant is refused; foreign grants, project settings, removal, ask rule and outside directory are refused', (t) => {
    const f = worktreesFixture(t);
    const parent = join(dirname(f.root), 'farm/deep');
    unchangedWorktrees(f, () => {
      const scope = danger.scopeOf(variant, f);
      const result = danger.judgeChange({ variant, files: [{ path: local, before: null,
        after: atKey(key, [parent, '/elsewhere']) }], scope });
      assert.deepEqual(result.entries, [parent, '/elsewhere'].map((value) => ({ path: local, key,
        change: 'added', value, class: CLASSES[1] })));
      assert.deepEqual(result.refused, [{ path: local, key, reason }]);
      assert.equal(scope.admits(result.entries[0]), true);
      assert.equal(scope.admits(result.entries[1]), false);
      for (const [path, entryKey, before, after] of [
        [local, key, null, atKey(key, ['/elsewhere'])],
        [SETTINGS, key, null, atKey(key, [parent])],
        [local, key, atKey(key, ['/x']), atKey(key, [])],
        [local, key, atKey(key, [parent]), atKey(key, [])],
        [local, 'permissions.ask', null, atKey('permissions.ask', [askRule()])],
      ]) assert.deepEqual(danger.judgeChange({ variant, files: [{ path, before, after }], scope }).refused,
        [{ path, key: entryKey, reason }]);
      assert.equal(scope.admitsPath(join(dirname(f.root), 'elsewhere'), true), false);
      for (const path of [join(f.root, '.claude'), dirname(parent), parent]) assert.equal(scope.admitsPath(path, true), true, path);
    });
  });
  for (const coveringAncestor of [false, true]) it(`local ${coveringAncestor ? 'covering ancestor' : 'exact entry'} with existing parent: nothing to change`, (t) => {
    const f = worktreesFixture(t);
    const parent = join(dirname(f.root), 'farm/deep');
    fs.mkdirSync(parent, { recursive: true });
    put(join(f.root, local), JSON.stringify(atKey(key, [coveringAncestor ? dirname(f.root) : parent])));
    unchangedWorktrees(f, () => {
      const result = danger.checkApply(variant, f);
      digestResult(result);
      assert.deepEqual(result.refused, []);
      assert.deepEqual(result.lines, [`nothing to change: ${variant} is already applied`, `digest: ${result.digest}`]);
    });
  });
  it('local entry with absent parent: only the missing parent and ancestor are printed, no settings line', (t) => {
    const f = worktreesFixture(t);
    const parent = join(dirname(f.root), 'farm/deep');
    put(join(f.root, local), JSON.stringify(atKey(key, [parent])));
    unchangedWorktrees(f, () => {
      const result = danger.checkApply(variant, f);
      digestResult(result);
      assert.deepEqual(result.refused, []);
      assert.deepEqual(result.lines, [`writes: ${dirname(parent)}/ created`, `writes: ${parent}/ created`,
        `scope: within the declared scope of ${variant}`, `digest: ${result.digest}`]);
      assert.equal(result.lines.includes(`${local}:`), false);
    });
  });
  it('masked local settings: exit 3, masked line alone and nothing spawned', (t) => {
    const f = worktreesFixture(t);
    put(join(f.root, local), '{}');
    unchangedWorktrees(f, () => {
      const original = fs.lstatSync;
      const mocked = t.mock.method(fs, 'lstatSync', (path, ...args) => path === join(f.root, local)
        ? Object.assign(Object.create(original(path)), { isCharacterDevice: () => true, isFile: () => false })
        : original(path, ...args));
      syncBuiltinESMExports();
      try {
        const spawn = t.mock.fn(() => { throw new Error('masked local settings spawned'); });
        const cli = capture(f, spawn);
        const code = danger.main(argvFor(variant, f), cli.io);
        assert.equal(spawn.mock.callCount(), 0);
        assert.equal(code, 3);
        assert.deepEqual(cli.lines, [`masked: ${local}`]);
        assert.deepEqual(cli.errors, []);
        assert.throws(() => danger.checkApply(variant, f), (error) =>
          error.code === 'CHECK_HALTED' && JSON.stringify(error.lines) === JSON.stringify([`masked: ${local}`]));
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
    });
  });
  for (const [title, setup, code, message] of [
    ['parent is home', (f) => put(join(f.root, 'docs/ai/worktrees.json'), JSON.stringify({ parentDir: f.home })),
      'VELOCITY_WORKTREES_HOME', /the worktrees parent dir .* is the home or holds it/],
    ['parent holds home', (f) => put(join(f.root, 'docs/ai/worktrees.json'), JSON.stringify({ parentDir: dirname(f.root) })),
      'VELOCITY_WORKTREES_HOME', /the worktrees parent dir .* is the home or holds it/],
    ['symlinked home resolves to the default parent holding the root', (f) => {
      fs.rmSync(join(f.root, 'docs/ai/worktrees.json'));
      const link = join(dirname(f.root), 'linked-home');
      fs.symlinkSync(dirname(f.root), link);
      f.home = link;
      f.env.HOME = link;
    }, 'VELOCITY_WORKTREES_HOME', /the worktrees parent dir .* is the home or holds it/],
    ['parent names a regular file', (f) => {
      put(join(dirname(f.root), 'ordinary-file'), 'sentinel');
      put(join(f.root, 'docs/ai/worktrees.json'), JSON.stringify({ parentDir: '../ordinary-file' }));
    }, 'VELOCITY_MALFORMED', /docs\/ai\/worktrees\.json: parentDir names an existing non-directory:/],
    ['malformed worktrees config', (f) => put(join(f.root, 'docs/ai/worktrees.json'), '{ nope'),
      'VELOCITY_MALFORMED', /docs\/ai\/worktrees\.json: malformed JSON/],
    ['malformed local allowWrite', (f) => put(join(f.root, local), JSON.stringify(atKey(key, ['']))),
      'VELOCITY_MALFORMED', /settings\.local\.json: sandbox\.filesystem\.allowWrite must be an array of non-blank strings/],
    ['symlinked local settings', (f) => {
      put(join(f.root, 'other.json'), '{}');
      fs.mkdirSync(join(f.root, '.claude'));
      fs.symlinkSync(join(f.root, 'other.json'), join(f.root, local));
    }, 'VELOCITY_SYMLINK', /settings\.local\.json exists but is not a regular file - refusing to clobber it/],
  ]) it(`writer refusal: ${title}, exit 3, its message alone and nothing spawned`, (t) => {
    const f = worktreesFixture(t);
    setup(f);
    unchangedWorktrees(f, () => {
      const spawn = t.mock.fn(() => { throw new Error('writer refusal spawned'); });
      const cli = capture(f, spawn);
      const status = danger.main(argvFor(variant, f), cli.io);
      assert.equal(spawn.mock.callCount(), 0);
      assert.equal(status, 3);
      const messages = [];
      assert.throws(() => velocity.writeVelocityProfile({ cwd: f.root, dryRun: true, worktrees: true }, writerDeps(f)), (error) => {
        assert.equal(error.code, code);
        assert.match(error.message, message);
        messages.push(error.message);
        return true;
      });
      assert.deepEqual(cli.lines, messages);
      assert.deepEqual(cli.errors, []);
      assert.throws(() => danger.checkApply(variant, f), (error) =>
        error.code === 'CHECK_HALTED' && JSON.stringify(error.lines) === JSON.stringify(messages));
    });
  });
  it('writer bypassed: the independent scope refuses a home-holding grant', (t) => {
    const f = worktreesFixture(t);
    put(join(f.root, 'docs/ai/worktrees.json'), JSON.stringify({ parentDir: f.home }));
    unchangedWorktrees(f, () => {
      const entry = homeRelative(f.home, f.home);
      assert.equal(entry, '~');
      const result = danger.judgeChange({ variant, files: [{ path: local, before: null, after: atKey(key, [entry]) }],
        scope: danger.scopeOf(variant, f) });
      assert.deepEqual(result.refused, [{ path: local, key, reason }]);
      assert.equal(needWorktrees('worktreesGrantDir')(f.root), f.home);
    });
  });
  it('real copy apply creates exactly the printed directories and local diff; project settings stay absent; next check has nothing to change', (t) => {
    const f = worktreesFixture(t);
    const original = tree(dirname(f.root));
    const originalHashes = hashes(f);
    const copy = copyFixture(t, f);
    const base = dirname(copy.root);
    const before = tree(base);
    const homeBefore = hashes(copy)[1];
    const result = unchangedWorktrees(copy, () => danger.checkApply(variant, copy));
    digestResult(result);
    const cli = capture(copy);
    assert.equal(danger.main([...argvFor(variant, copy), '--apply', '--expect', result.digest], cli.io), 0);
    assert.deepEqual(cli.lines, result.lines);
    assert.deepEqual(cli.errors, []);
    assert.equal(fs.statSync(join(base, 'farm/deep')).isDirectory(), true);
    const written = json(join(copy.root, local));
    const entries = danger.diffFiles(null, written);
    const judgedEntries = danger.judgeChange({ variant, files: [{ path: local, before: null, after: written }],
      scope: danger.scopeOf(variant, copy) });
    assert.deepEqual(judgedEntries.refused, []);
    assert.deepEqual(entries, [{ key, change: 'added', value: join(base, 'farm/deep') }]);
    assert.deepEqual(result.lines.filter((line) => line.startsWith('  ')), judgedEntries.entries.map(lineOf));
    assert.deepEqual(sorted(judgedEntries.entries.map(({ path: _, class: __, ...entry }) => entry)), sorted(entries));
    const after = tree(base);
    const changed = Object.keys(after).filter((path) => JSON.stringify(after[path]) !== JSON.stringify(before[path]));
    const directories = result.lines.filter((line) => line.startsWith('writes: '))
      .map((line) => relative(base, resolve(copy.root, line.slice(8).replace(/\/ created$/, ''))));
    assert.deepEqual(changed.sort(), [...directories, relative(base, join(copy.root, local))].sort());
    assert.deepEqual(Object.keys(before).filter((path) => !(path in after)), []);
    assert.equal(fs.existsSync(join(copy.root, SETTINGS)), false);
    assert.equal(hashes(copy)[1], homeBefore);
    unchangedWorktrees(copy, () => {
      const applied = danger.checkApply(variant, copy);
      digestResult(applied);
      assert.deepEqual(applied.refused, []);
      assert.deepEqual(applied.lines, [`nothing to change: ${variant} is already applied`, `digest: ${applied.digest}`]);
    });
    assert.deepEqual(tree(dirname(f.root)), original);
    assert.deepEqual(hashes(f), originalHashes);
  });
  it('CLI accepts --variant worktrees-dir', (t) => {
    const f = worktreesFixture(t);
    unchangedWorktrees(f, () => {
      const spawn = t.mock.fn(() => { throw new Error('CLI preview spawned'); });
      const cli = capture(f, spawn);
      assert.equal(danger.main(['--variant', 'worktrees-dir', '--cwd', f.root], cli.io), 0);
      assert.equal(spawn.mock.callCount(), 0);
      const result = danger.checkApply(variant, f);
      digestResult(result);
      assert.deepEqual(cli.lines, result.lines);
      assert.deepEqual(cli.errors, []);
    });
  });
});

describe('spec:init-project/S29 the danger check over the three writers by proof', () => {
  const stopPath = '.claude/hooks/state-block-guard.mjs';
  const stopEntry = LIST_ROWS.find(([key]) => key === 'hooks.Stop')[1];
  const oldBytes = '// earlier placed runtime\n';
  const exerciseWriter = (t, variant, f, inspect) => {
    const originalHashes = hashes(f);
    unchanged(f, () => {
      const result = danger.checkApply(variant, f);
      assertPreview(variant, f, result, expectedPlan(variant, f));
      inspect(result);
      assert.deepEqual(danger.checkApply(variant, f), result, 'stable digest');
      const cli = capture(f, () => { throw new Error('preview spawned'); });
      assert.equal(danger.main(argvFor(variant, f), cli.io), 0);
      assert.deepEqual(cli.lines, result.lines);
      assert.deepEqual(cli.errors, []);
    });
    const copy = copyFixture(t, f);
    const before = snapshot(copy);
    const settingsBefore = json(join(copy.root, SETTINGS));
    const result = unchanged(copy, () => danger.checkApply(variant, copy));
    const cli = capture(copy);
    assert.equal(danger.main([...argvFor(variant, copy), '--apply', '--expect', result.digest], cli.io), 0);
    assert.deepEqual(cli.lines, result.lines);
    assert.deepEqual(cli.errors, []);
    const entries = danger.diffFiles(settingsBefore, json(join(copy.root, SETTINGS)));
    assert.deepEqual(result.lines.filter((line) => line.startsWith('  ')),
      entries.map((entry) => lineOf({ ...entry, class: CLASSES[4] })));
    assertAppliedPaths(copy, before, result, [SETTINGS]);
    unchanged(copy, () => {
      const applied = danger.checkApply(variant, copy);
      digestResult(applied);
      assert.deepEqual(applied.refused, []);
      assert.deepEqual(applied.lines.slice(0, -1), [`nothing to change: ${variant} is already applied`]);
      const preview = capture(copy, () => { throw new Error('already-applied preview spawned'); });
      assert.equal(danger.main(argvFor(variant, copy), preview.io), 0);
      assert.deepEqual(preview.lines, applied.lines);
      assert.deepEqual(preview.errors, []);
    });
    assert.deepEqual(hashes(f), originalHashes, 'original retained while copy applied');
  };
  for (const variant of ['gate-hook.marker-stale', 'read-lane.stale']) {
    for (const wired of [true, false]) it(`${variant}: diverged ${wired ? 'wired' : 'unwired'} hook, replaces preview, copy apply and already applied`, (t) => {
      const f = fixture(t);
      put(join(f.root, hook.HOOK_FILE_REL), oldBytes);
      put(join(f.root, SETTINGS), JSON.stringify(wired ? hook.mergeHookEntry({}) : {}));
      const bundle = fs.readFileSync(join(TOOLS, '../references/hooks/gate-approve.mjs'));
      exerciseWriter(t, variant, f, (result) => {
        assert.ok(result.lines.includes(`writes: ${hook.HOOK_FILE_REL} sha256:${sha(bundle)} — replaces sha256:${sha(oldBytes)}`));
        assert.equal(result.lines.includes(`${SETTINGS}:`), !wired);
        assert.deepEqual(result.lines.filter((line) => line.startsWith('  ')), wired ? [] : [
          lineOf({ key: 'hooks.PreToolUse', change: 'added', value: hook.buildHookSettingsEntry(), class: CLASSES[4] }),
        ]);
      });
    });
  }
  for (const placement of ['fresh', 'append', 'replace']) it(`state-block: ${placement}, real preview, copy apply and already applied`, (t) => {
    const f = fixture(t);
    if (placement === 'append') put(join(f.root, SETTINGS), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node foreign-stop.mjs' }] }] },
    }));
    if (placement === 'replace') {
      put(join(f.root, stopPath), oldBytes);
      put(join(f.root, SETTINGS), JSON.stringify(atKey('hooks.Stop', [stopEntry])));
    }
    const bundle = fs.readFileSync(join(TOOLS, '../references/hooks/state-block-guard.mjs'));
    exerciseWriter(t, 'state-block', f, (result) => {
      const entry = need('buildStopHookEntry')();
      assert.deepEqual(entry, stopEntry);
      const replaces = placement === 'replace' ? ` — replaces sha256:${sha(oldBytes)}` : '';
      assert.ok(result.lines.includes(`writes: ${stopPath} sha256:${sha(bundle)}${replaces}`));
      assert.equal(result.lines.includes(`${SETTINGS}:`), placement !== 'replace');
      assert.deepEqual(result.lines.filter((line) => line.startsWith('  ')), placement === 'replace' ? [] : [
        lineOf({ key: 'hooks.Stop', change: 'added', value: entry, class: CLASSES[4] }),
      ]);
      if (placement === 'fresh') assert.ok(result.lines.includes('writes: .claude/ created'));
      if (placement !== 'replace') assert.ok(result.lines.includes('writes: .claude/hooks/ created'));
    });
  });
  const plants = [
    ['another Stop command', 'node foreign-stop.mjs'],
    ['bundled Stop command with --require-block', `${stopEntry.hooks[0].command} --require-block`],
  ];
  for (const [title, command] of plants) it(`state-block: refuses ${title} naming hooks.Stop`, (t) => {
    const f = fixture(t);
    const value = { hooks: [{ ...stopEntry.hooks[0], command }] };
    unchanged(f, () => {
      const result = danger.judgeChange({ variant: 'state-block',
        files: [{ path: SETTINGS, before: null, after: atKey('hooks.Stop', [value]) }],
        scope: danger.scopeOf('state-block', f) });
      assert.deepEqual(result.refused, [{ path: SETTINGS, key: 'hooks.Stop',
        reason: 'beyond the declared scope of state-block' }]);
    });
  });
  it('state-block: non-array hooks.Stop preserves the writer refusal at exit 3, never spawning', (t) => {
    const f = fixture(t);
    put(join(f.root, SETTINGS), JSON.stringify(atKey('hooks.Stop', {})));
    unchanged(f, () => {
      const spawn = t.mock.fn(() => { throw new Error('malformed Stop spawned'); });
      const cli = capture(f, spawn);
      const code = danger.main(argvFor('state-block', f), cli.io);
      assert.equal(spawn.mock.callCount(), 0);
      assert.equal(code, 3);
      const message = `${SETTINGS}: "hooks.Stop" must be an array`;
      assert.ok(cli.lines.some((line) => line.includes(message)));
      let writerMessage;
      assert.throws(() => need('writeStateBlockHook')({ cwd: f.root, dryRun: true }), (error) => {
        writerMessage = error.message;
        return error.code === 'GATE_HOOK_MALFORMED' && error.message.includes(message);
      });
      assert.deepEqual(cli.lines, [writerMessage]);
      assert.deepEqual(cli.errors, []);
      assert.throws(() => danger.checkApply('state-block', f), (error) =>
        error.code === 'CHECK_HALTED' && JSON.stringify(error.lines) === JSON.stringify([writerMessage]));
    });
  });
  for (const variant of ['state-block', 'gate-hook.marker-stale']) it(`${variant}: character-device settings mask exits 3 before judgement, never spawning`, (t) => {
    const f = fixture(t);
    put(join(f.root, SETTINGS), '{}');
    if (variant === 'gate-hook.marker-stale') put(join(f.root, hook.HOOK_FILE_REL), oldBytes);
    unchanged(f, () => {
      const original = fs.lstatSync;
      const mocked = t.mock.method(fs, 'lstatSync', (path, ...args) => path === join(f.root, SETTINGS)
        ? Object.assign(Object.create(original(path)), { isCharacterDevice: () => true, isFile: () => false })
        : original(path, ...args));
      syncBuiltinESMExports();
      try {
        const spawn = t.mock.fn(() => { throw new Error('masked settings spawned'); });
        const cli = capture(f, spawn);
        const code = danger.main(argvFor(variant, f), cli.io);
        assert.equal(spawn.mock.callCount(), 0);
        assert.equal(code, 3);
        assert.deepEqual(cli.lines, [`masked: ${SETTINGS}`]);
        assert.deepEqual(cli.errors, []);
        assert.throws(() => danger.checkApply(variant, f), (error) =>
          error.code === 'CHECK_HALTED' && JSON.stringify(error.lines) === JSON.stringify([`masked: ${SETTINGS}`]));
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
    });
  });
  it('read-lane.stale: an absent gate hook prints the writer refusal at exit 3, never spawning', (t) => {
    const f = fixture(t);
    unchanged(f, () => {
      const spawn = t.mock.fn(() => { throw new Error('absent hook spawned'); });
      const cli = capture(f, spawn);
      const code = danger.main(argvFor('read-lane.stale', f), cli.io);
      assert.equal(spawn.mock.callCount(), 0);
      assert.equal(code, 3);
      assert.match(cli.lines.join('\n'), /is not placed/);
      assert.deepEqual(cli.errors, []);
      let writerMessage;
      assert.throws(() => hook.writeGateHook({ cwd: f.root, dryRun: true, reseed: true }), (error) => {
        writerMessage = error.message;
        return error.code === 'GATE_HOOK_STALE' && error.message.includes('is not placed');
      });
      assert.deepEqual(cli.lines, [writerMessage]);
      assert.throws(() => danger.checkApply('read-lane.stale', f), (error) =>
        error.code === 'CHECK_HALTED' && JSON.stringify(error.lines) === JSON.stringify([writerMessage]));
    });
  });
  for (const variant of ['gate-hook.marker-stale', 'state-block']) it(`${variant}: hook bytes changed after the check print the new result at exit 5, never spawning`, (t) => {
    const f = fixture(t);
    const path = variant === 'state-block' ? stopPath : hook.HOOK_FILE_REL;
    put(join(f.root, path), oldBytes);
    put(join(f.root, SETTINGS), JSON.stringify(variant === 'state-block'
      ? atKey('hooks.Stop', [stopEntry]) : hook.mergeHookEntry({})));
    const first = unchanged(f, () => danger.checkApply(variant, f));
    digestResult(first);
    assertPreview(variant, f, first, expectedPlan(variant, f));
    const editedBytes = '// edited after the check\n';
    put(join(f.root, path), editedBytes);
    unchanged(f, () => {
      const current = danger.checkApply(variant, f);
      assertPreview(variant, f, current, expectedPlan(variant, f));
      assert.notEqual(current.digest, first.digest);
      assert.deepEqual(first.lines.filter((line) => !line.startsWith('digest: ')).map((line) =>
        line.replace(` — replaces sha256:${sha(oldBytes)}`, ` — replaces sha256:${sha(editedBytes)}`)),
      current.lines.filter((line) => !line.startsWith('digest: ')));
      const spawn = t.mock.fn(() => { throw new Error('changed hook spawned'); });
      const cli = capture(f, spawn);
      const code = danger.main([...argvFor(variant, f), '--apply', '--expect', first.digest], cli.io);
      assert.equal(spawn.mock.callCount(), 0);
      assert.equal(code, 5);
      assert.deepEqual(cli.lines, current.lines);
      assert.deepEqual(cli.errors, []);
    });
  });
});

describe('spec:init-project/S36 the danger check over the two git-hook writers by proof', () => {
  const bundle = join(TOOLS, '../references/scripts');
  const names = fs.readdirSync(bundle).filter((name) => name.endsWith('.mjs')).sort();
  const installer = 'scripts/install-git-hooks.mjs';
  const bytes = fs.readFileSync(join(bundle, basename(installer)));
  const kept = 'markdown-blocks.test.mjs';
  const initGit = (f) => {
    const git = findOnPath('git', { getenv: process.env }).path;
    assert.ok(git, 'git is on the host PATH');
    f.env.PATH += `:${dirname(git)}`;
    const child = spawnSync('git', ['init', '-q', f.root], { env: hermeticGitEnv(process.env, f.home) });
    assert.equal(child.status, 0, String(child.stderr));
    return f;
  };
  const project = (t, deployed = false) => {
    const f = initGit(fixture(t));
    if (deployed) for (const name of ['archive-decisions.mjs', basename(installer)]) put(join(f.root, 'scripts', name), fs.readFileSync(join(bundle, name)));
    return f;
  };
  const runLine = (variant) => `runs: node ${installer}${variant === 'commit-guard'
    ? ` --commit-guard ${shellQuoteArg(join(TOOLS, 'commit-guard.mjs'))}` : ''} sha256:${sha(bytes)}`;
  const preview = (f, variant, lines) => unchanged(f, () => {
    const result = danger.checkApply(variant, f);
    digestResult(result);
    assert.deepEqual(result.refused, []);
    assert.deepEqual(result.lines, [...lines, `scope: within the declared scope of ${variant}`, `digest: ${result.digest}`]);
    assert.equal(result.lines.some((line) => /^(?:\.claude\/|  |masked:)/.test(line)), false);
    return result;
  });
  for (const standing of [false, true]) it(`enforcement: fresh git root, kept test ${standing}, ordered bundled writes and run`, (t) => {
    const f = project(t);
    if (standing) put(join(f.root, 'scripts', kept), 'foreign bytes\n');
    preview(f, 'enforcement', [...names.filter((name) => !standing || name !== kept)
      .map((name) => `writes: scripts/${name} sha256:${sha(fs.readFileSync(join(bundle, name)))}`),
    ...(!standing ? ['writes: scripts/ created'] : []), runLine('enforcement')]);
  });
  it('enforcement: character-device settings mask does not halt main or print masked', (t) => {
    const f = project(t);
    put(join(f.root, SETTINGS), '{}');
    unchanged(f, () => {
      const original = fs.lstatSync;
      const mocked = t.mock.method(fs, 'lstatSync', (path, ...args) => path === join(f.root, SETTINGS)
        ? Object.assign(Object.create(original(path)), { isCharacterDevice: () => true, isFile: () => false })
        : original(path, ...args));
      syncBuiltinESMExports();
      try {
        const cli = capture(f, () => { throw new Error('preview spawned'); });
        assert.equal(danger.main(argvFor('enforcement', f), cli.io), 0);
        assert.equal(cli.lines.some((line) => line.startsWith('masked:')), false);
        assert.deepEqual(cli.errors, []);
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
    });
  });
  it('enforcement: deployed root always prints the installer run with a stable digest', (t) => {
    const f = project(t, true);
    assert.deepEqual(preview(f, 'enforcement', [runLine('enforcement')]), preview(f, 'enforcement', [runLine('enforcement')]));
  });
  it('commit-guard: deployed root prints only its guarded run; absent installer exits 3 without spawning', (t) => {
    const f = project(t, true);
    preview(f, 'commit-guard', [runLine('commit-guard')]);
    fs.unlinkSync(join(f.root, installer));
    unchanged(f, () => {
      const spawn = t.mock.fn(() => { throw new Error('absent installer spawned'); });
      assert.equal(danger.main(argvFor('commit-guard', f), capture(f, spawn).io), 3);
      assert.equal(spawn.mock.callCount(), 0);
    });
  });
  for (const outside of ['copy', 'runs']) it(`enforcement: planted ${outside} outside scope exits 1, nothing written`, (t) => {
    const f = project(t);
    const plan = { root: f.root, variant: 'enforcement', scriptsCreated: false,
      copies: outside === 'copy' ? [{ name: 'x.mjs', path: join(f.root, 'elsewhere/x.mjs'), action: 'created', bytes }] : [],
      runs: { argv: ['node', join(f.root, installer)], shown: ['node', outside === 'runs' ? 'scripts/other.mjs' : installer], bytes } };
    unchanged(f, () => {
      const spawn = t.mock.fn(() => { throw new Error('refused plan spawned'); });
      const cli = capture(f, spawn);
      assert.equal(danger.main(argvFor(plan.variant, f), { ...cli.io, planGitHooks: () => plan }), 1);
      assert.ok(cli.lines.includes(`runs: ${plan.runs.shown.map(shellQuoteArg).join(' ')} sha256:${sha(plan.runs.bytes)}`));
      assert.ok(cli.lines.some((line) => line.startsWith(outside === 'copy' ? 'refused: elsewhere/x.mjs ' : 'refused: runs: ')));
      assert.ok(cli.lines.includes('nothing written'));
      assert.equal(spawn.mock.callCount(), 0);
    });
  });
  it('enforcement: real apply on a copy writes exactly the printed paths and pre-commit with the printed hashes', (t) => {
    const f = project(t);
    const copy = initGit(copyFixture(t, f));
    const result = unchanged(copy, () => danger.checkApply('enforcement', copy));
    digestResult(result);
    const before = snapshot(copy);
    assert.equal(danger.main([...argvFor('enforcement', copy), '--apply', '--expect', result.digest], capture(copy).io), 0);
    const after = snapshot(copy);
    const writes = result.lines.filter((line) => line.startsWith('writes: '));
    const paths = writes.map((line) => line.slice(8).replace(/ sha256:[0-9a-f]{64}$|\/ created$/g, ''));
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((path) => (!path.startsWith('.git/') || path === '.git/hooks/pre-commit') && JSON.stringify(before[path]) !== JSON.stringify(after[path]));
    assert.deepEqual(changed.sort(), [...new Set([...paths, 'scripts', '.git/hooks/pre-commit'])].sort());
    for (const line of writes.filter((line) => line.includes(' sha256:'))) {
      const [path, hash] = line.slice(8).split(' sha256:');
      assert.equal(sha(fs.readFileSync(join(copy.root, path))), hash);
    }
    assert.equal(result.lines.find((line) => line.startsWith('runs: ')), `runs: node ${installer} sha256:${sha(fs.readFileSync(join(copy.root, installer)))}`);
  });
  it('enforcement: installer edited after the yes exits 5 without spawning', (t) => {
    const f = project(t, true);
    const result = preview(f, 'enforcement', [runLine('enforcement')]);
    fs.appendFileSync(join(f.root, installer), '// edited after the yes\n');
    unchanged(f, () => {
      const spawn = t.mock.fn(() => { throw new Error('changed installer spawned'); });
      assert.equal(danger.main([...argvFor('enforcement', f), '--apply', '--expect', result.digest], capture(f, spawn).io), 5);
      assert.equal(spawn.mock.callCount(), 0);
    });
  });
  it('enforcement: unmanaged hook exits 6 and rolls back created copies, keeping the test and hook bytes', (t) => {
    const f = project(t);
    const hookPath = join(f.root, '.git/hooks/pre-commit');
    put(hookPath, '#!/bin/sh\nexit 0\n');
    put(join(f.root, 'scripts', kept), 'foreign bytes\n');
    const result = unchanged(f, () => danger.checkApply('enforcement', f));
    const cli = capture(f);
    assert.equal(danger.main([...argvFor('enforcement', f), '--apply', '--expect', result.digest], cli.io), 6);
    assert.deepEqual(cli.errors, ['apply exited 1']);
    for (const name of names.filter((name) => name !== kept)) assert.equal(fs.existsSync(join(f.root, 'scripts', name)), false, name);
    assert.equal(fs.readFileSync(join(f.root, 'scripts', kept), 'utf8'), 'foreign bytes\n');
    assert.equal(fs.readFileSync(hookPath, 'utf8'), '#!/bin/sh\nexit 0\n');
  });
  for (const variant of ['enforcement', 'commit-guard']) it(`CLI accepts --variant ${variant} with its lines`, (t) => {
    const f = project(t, true);
    const cli = capture(f, () => { throw new Error('preview spawned'); });
    assert.equal(unchanged(f, () => danger.main(argvFor(variant, f), cli.io)), 0);
    assert.deepEqual(cli.lines, preview(f, variant, [runLine(variant)]).lines);
    assert.deepEqual(cli.errors, []);
  });
});

describe('spec:init-project/S63 the danger check over hook-checks by proof', () => {
  const [ambient, reset] = [{ ...process.env }, (keep, env) => { for (const key of Object.keys(process.env)) if (!keep(key)) delete process.env[key]; Object.assign(process.env, env); }];
  before(() => reset((key) => !/^git_/i.test(key), { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }));
  after(() => reset((key) => key in ambient, ambient));
  const [INSTALLER, RULE] = ['scripts/install-git-hooks.mjs', '# Project layout\n'];
  const [bundled, prior] = [`references/${INSTALLER}`, 'test/fixtures/script-priors/4.0.0/install-git-hooks.mjs.txt'].map((path) => fs.readFileSync(join(TOOLS, '..', path)));
  const [rules, layout] = [['--rules-check', join(TOOLS, 'project-rules/rules-cli.mjs')], ['--layout-check', join(TOOLS, 'source-size-check.mjs')]];
  const deployment = (t, installer, { theme = true, config } = {}) => {
    const f = fixture(t);
    f.env = hermeticGitEnv({ ...f.env, PATH: `${f.env.PATH}:${dirname(findOnPath('git', { getenv: process.env }).path)}` }, f.home);
    assert.equal(spawnSync('git', ['init', '-q', f.root], { env: f.env }).status, 0);
    const record = JSON.stringify({ schema: 1, themes: { 'project-layout': { kit: sha(RULE), local: 'absent', effective: sha(RULE) } } });
    for (const [path, bytes] of Object.entries({ [INSTALLER]: installer, 'docs/ai/source-size.json': config, ...theme && { 'docs/ai/rules/project-layout.md': RULE,
      'docs/ai/rules/effective/project-layout.md': RULE, 'docs/ai/rules/effective/sources.json': record } })) if (bytes !== undefined) put(join(f.root, path), bytes);
    return f;
  };
  const runs = (flags, bytes = bundled) => `runs: ${['node', INSTALLER, ...flags].map(shellQuoteArg).join(' ')} sha256:${sha(bytes)}`;
  const main = (f, argv = [], io = {}, cli = capture(f, () => { throw new Error('spawned'); })) =>
    ({ code: unchanged(f, () => danger.main([...argvFor('hook-checks', f), ...argv], { ...cli.io, ...io })), ...cli });
  const schema1 = { config: JSON.stringify({ schema: 1, defaults: SOURCE_SIZE_DEFAULTS, roots: ['src'], exclude: [], extensions: ['.mjs'] }) };
  for (const [title, installer, opts, flags] of [['prior, both lines', prior, {}, [...rules, ...layout]], ['current, both lines', bundled, {}, [...rules, ...layout]],
    ['current, the rules line alone', bundled, schema1, rules], ['prior, the layout line alone', prior, { theme: false }, layout]]) it(`${title}: the runs line alone, scope within, the CLI accepts --variant hook-checks, edited after the yes exit 5`, (t) => {
    const f = deployment(t, installer, opts);
    const result = unchanged(f, () => danger.checkApply('hook-checks', f));
    assert.deepEqual(result.lines, [runs(flags, installer), 'scope: within the declared scope of hook-checks', `digest: ${result.digest}`]);
    const cli = main(f);
    assert.deepEqual([cli.code, cli.lines, cli.errors], [0, result.lines, []]);
    fs.appendFileSync(join(f.root, INSTALLER), '// edited after the yes\n');
    assert.equal(main(f, ['--apply', '--expect', result.digest]).code, 5);
  });
  for (const [title, { flags = rules, write }] of [
    ['another flag', { flags: ['--commit-guard', join(TOOLS, 'commit-guard.mjs')] }], ['another tool path', { flags: ['--rules-check', '/elsewhere/rules-cli.mjs'] }],
    ['the lines out of order', { flags: [...layout, ...rules] }], ['a planted write of the installer', { write: INSTALLER }], ['a planted write of another path', { write: 'scripts/other.mjs' }]]) it(`refuses ${title}, exit 1, nothing spawned`, (t) => {
    const f = deployment(t, prior);
    const plan = { root: f.root, variant: 'hook-checks', scriptsCreated: false, roles: ['rules'],
      copies: write ? [{ name: basename(write), path: join(f.root, write), action: 'created', bytes: bundled }] : [],
      runs: { argv: ['node', join(f.root, INSTALLER), ...flags], shown: ['node', INSTALLER, ...flags], bytes: prior } };
    const cli = main(f, [], { planGitHooks: () => plan });
    assert.deepEqual([cli.code, cli.lines.filter((line) => line.startsWith('refused: ')).map((line) => line.startsWith(`refused: ${write ?? 'runs:'} `)), cli.lines.at(-2)], [1, [true], 'nothing written']);
    assert.ok(cli.lines.includes(runs(flags, prior)));
  });
  it('the real apply over the current installer writes nothing the leaf placed and arms the printed lines; the next check is the leaf\'s refusal, exit 3', (t) => {
    const f = deployment(t, bundled);
    const [result, earlier] = [unchanged(f, () => danger.checkApply('hook-checks', f)), snapshot(f)];
    assert.equal(danger.main([...argvFor('hook-checks', f), '--apply', '--expect', result.digest], capture(f).io), 0);
    const later = snapshot(f);
    assert.deepEqual(Object.keys(later).filter((path) => (!path.startsWith('.git/') || path === '.git/hooks/pre-commit')
      && JSON.stringify(earlier[path]) !== JSON.stringify(later[path])).sort(), ['.git/hooks/pre-commit']);
    assert.equal(result.lines.some((line) => line.startsWith('writes: ')), false);
    const hook = fs.readFileSync(join(f.root, '.git/hooks/pre-commit'), 'utf8').split('\n');
    for (const [flag, path] of [rules, layout]) assert.ok(hook.includes(`node "${path}" --check # ${flag.slice(2)}`), flag);
    const next = main(f);
    assert.deepEqual([next.code, next.lines], [3, ['nothing to plan — the rules-check line: armed; the layout-check line: armed']]);
  });
});

describe('spec:init-project/S26 — the velocity variants admit exactly the apply ask rule', () => {
  for (const variant of ['velocity-core', 'kit-tools-tier', 'bridge-tier']) it(`${variant}: lacking the rule prints it added, nothing widened, within scope; carrying it prints no ask entry`, (t) => {
    const f = fixture(t);
    const result = unchanged(f, () => danger.checkApply(variant, f));
    const rule = askRule();
    assert.ok(result.lines.includes(`  permissions.ask: added ${rule} — nothing widened`));
    assert.ok(result.lines.includes(`scope: within the declared scope of ${variant}`));
    assert.deepEqual(result.refused, []);
    put(join(f.root, SETTINGS), JSON.stringify({ permissions: { ask: [rule] } }));
    assert.equal(unchanged(f, () => danger.checkApply(variant, f)).lines.some((line) => line.startsWith('  permissions.ask:')), false);
  });
  for (const variant of ['velocity-core', 'kit-tools-tier', 'bridge-tier']) it(`${variant}: planted other ask entry and removal of the rule are refused naming permissions.ask; the rule alone is admitted`, (t) => {
    const f = fixture(t);
    const rule = askRule();
    for (const [before, after, refused] of [
      [null, atKey('permissions.ask', ['Bash(git push:*)']), [{ path: SETTINGS, key: 'permissions.ask', reason: `beyond the declared scope of ${variant}` }]],
      [atKey('permissions.ask', [rule]), atKey('permissions.ask', []), [{ path: SETTINGS, key: 'permissions.ask', reason: `beyond the declared scope of ${variant}` }]],
      [null, atKey('permissions.ask', [rule]), []],
    ]) assert.deepEqual(unchanged(f, () => danger.judgeChange({ variant, files: [{ path: SETTINGS, before, after }],
      scope: danger.scopeOf(variant, f) })).refused, refused);
  });
  it('the autonomy-render scope is unchanged', (t) => {
    const scope = danger.scopeOf('autonomy-render', fixture(t));
    const rule = askRule();
    assert.equal(scope.admits({ path: SETTINGS, key: 'permissions.ask', change: 'added', value: rule }), false);
    assert.equal(scope.admits({ path: SETTINGS, key: 'permissions.ask', change: 'added', value: velocity.RENDER_OWNED_REDLINE_RULES[0] }), true);
  });
  it('real velocity-core apply on a copy: diffFiles(before, written) equals the printed entries, the ask entry included', (t) => {
    const f = fixture(t);
    const copy = copyFixture(t, f);
    const before = json(join(copy.root, SETTINGS));
    const result = unchanged(copy, () => danger.checkApply('velocity-core', copy));
    assert.equal(danger.main([...argvFor('velocity-core', copy), '--apply', '--expect', result.digest], capture(copy).io), 0);
    const judgedEntries = danger.judgeChange({ variant: 'velocity-core',
      files: [{ path: SETTINGS, before, after: json(join(copy.root, SETTINGS)) }], scope: danger.scopeOf('velocity-core', copy) });
    assert.deepEqual(result.lines.filter((line) => line.startsWith('  ')),
      danger.diffFiles(before, json(join(copy.root, SETTINGS))).map((entry, i) => lineOf({ ...entry, class: judgedEntries.entries[i].class })));
    const rule = askRule();
    assert.ok(result.lines.includes(`  permissions.ask: added ${rule} — nothing widened`));
  });
});

describe('spec:velocity-profile/S8 used bridge scope, additions only and state-dir refusals', () => {
  const codexHosts = json(join(TOOLS, '../bridges/codex-cli-bridge/capability.json')).networkHosts;
  const agyHost = json(join(TOOLS, '../bridges/antigravity-cli-bridge/capability.json')).networkHosts
    .find((host) => !codexHosts.includes(host));
  const grounding = `Bash(node "${join(TOOLS, 'grounding.mjs')}":*)`;
  const setReviews = (f, review = 'reviewed') => put(join(f.root, 'docs/ai/orchestration.json'),
    JSON.stringify(Object.fromEntries(Object.entries(ACTIVITIES)
      .filter(([, activity]) => Object.values(activity.slots).includes('review'))
      .map(([name]) => [name, { review }]))));
  const judge = (f, key, value, change = 'added') => danger.judgeChange({ variant: 'bridge-tier',
    files: [{ path: SETTINGS, before: change === 'removed' ? atKey(key, [value]) : null,
      after: change === 'removed' ? {} : atKey(key, [value]) }], scope: danger.scopeOf('bridge-tier', f) });
  for (const external of [false, true]) it(`real reviewed preview: ${external ? 'outside-home CODEX_HOME' : '~/.codex'} with exact classes`, (t) => {
    const f = fixture(t);
    setReviews(f);
    const dir = external ? join(dirname(f.root), 'codex-state') : '~/.codex';
    if (external) {
      f.env.CODEX_HOME = dir;
      put(join(dir, 'auth.json'), '{}');
    }
    unchanged(f, () => {
      assert.deepEqual(detectBackends({ getenv: f.env, home: f.home }).map(({ readiness }) => readiness), ['ready', 'ready']);
      const result = danger.checkApply('bridge-tier', f);
      assertPreview('bridge-tier', f, result, expectedPlan('bridge-tier', f));
      for (const [key, value, kind] of [
        ['sandbox.excludedCommands', 'codex-review *', CLASSES[2]],
        ...codexHosts.map((host) => ['sandbox.network.allowedDomains', host, CLASSES[0]]),
        ['sandbox.filesystem.allowWrite', dir, CLASSES[1]],
      ]) assert.ok(result.lines.includes(lineOf({ key, value, change: 'added', class: kind })), `${key}: ${value} — ${kind}`);
      assert.deepEqual(judge(f, 'sandbox.filesystem.allowWrite', dir).refused, []);
      assert.deepEqual(judge(f, 'sandbox.network.allowedDomains', codexHosts[0]).refused, []);
      const cli = capture(f, () => { throw new Error('preview spawned'); });
      assert.equal(danger.main(argvFor('bridge-tier', f), cli.io), 0);
      assert.deepEqual(cli.lines, result.lines);
    });
  });
  const plants = [
    ['unused agy host', 'sandbox.network.allowedDomains', agyHost],
    ['unused agy dir', 'sandbox.filesystem.allowWrite', '~/.gemini/antigravity-cli'],
    ['unused agy allow', 'permissions.allow', 'Bash(agy-review code:*)'],
    ['bare codex-review exclusion', 'sandbox.excludedCommands', 'codex-review'],
    ['outside derived dirs', 'sandbox.filesystem.allowWrite', '/scratch'],
    ['foreign grounding with agy used', 'permissions.allow', 'Bash(node "/other-kit/tools/grounding.mjs":*)', 'added', 'council'],
    ['installed grounding with agy unused', 'permissions.allow', grounding],
    ['removed codex allow', 'permissions.allow', 'Bash(codex-review code:*)', 'removed'],
    ['removed codex exclusion', 'sandbox.excludedCommands', 'codex-review *', 'removed'],
    ['removed codex host', 'sandbox.network.allowedDomains', codexHosts[0], 'removed'],
    ['removed codex dir', 'sandbox.filesystem.allowWrite', '~/.codex', 'removed'],
  ];
  for (const [title, key, value, change, review] of plants) it(`refuses ${title} naming ${key}; admits used codex dir`, (t) => {
    const f = fixture(t);
    setReviews(f, review);
    unchanged(f, () => {
      assert.notEqual(value, undefined, 'fixture has a bridge-specific host');
      const result = judge(f, key, value, change);
      assert.deepEqual(result.refused, [{ path: SETTINGS, key, reason: 'beyond the declared scope of bridge-tier' }], title);
      if (review === 'council') assert.deepEqual(judge(f, 'permissions.allow', grounding).refused, []);
      assert.deepEqual(judge(f, 'sandbox.network.allowedDomains', codexHosts[0]).refused, []);
      assert.deepEqual(judge(f, 'sandbox.filesystem.allowWrite', '~/.codex').refused, [], 'used codex dir admitted');
    });
  });
  it('main refuses the real grounding rule at another installed kit path, exit 1 without spawning', (t) => {
    const f = fixture(t);
    setReviews(f, 'council');
    const otherKit = { ...f, toolsDir: join(f.root, 'other-kit/tools') };
    unchanged(f, () => {
      const result = danger.checkApply('bridge-tier', otherKit);
      assert.deepEqual(result.refused, [{ path: SETTINGS, key: 'permissions.allow', reason: 'beyond the declared scope of bridge-tier' }]);
      assert.ok(result.lines.includes(lineOf({ key: 'permissions.allow', value: grounding, change: 'added', class: CLASSES[3] })));
      assert.ok(result.lines.includes('nothing written'));
      const cli = capture(otherKit, () => { throw new Error('refused apply spawned'); });
      assert.equal(danger.main([...argvFor('bridge-tier', f), '--apply', '--expect', result.digest], cli.io), 1);
      assert.deepEqual(cli.lines, result.lines);
      assert.deepEqual(judge(f, 'sandbox.filesystem.allowWrite', '~/.codex').refused, [], 'used codex dir admitted');
    });
  });
  for (const parent of [false, true]) it(`CODEX_HOME at ${parent ? 'root and home parent' : 'synthetic home'}: writer message, exit 3`, (t) => {
    const f = fixture(t);
    setReviews(f);
    f.env.CODEX_HOME = parent ? dirname(f.root) : f.home;
    put(join(f.env.CODEX_HOME, 'auth.json'), '{}');
    unchanged(f, () => {
      const messages = [];
      assert.throws(() => velocity.writeVelocityProfile({ cwd: f.root, dryRun: true, bridgeTier: true }, writerDeps(f)), (error) => {
        assert.match(error.message, /CODEX_HOME/);
        messages.push(error.message);
        return true;
      }, 'real writer refuses unsafe CODEX_HOME');
      assert.throws(() => danger.checkApply('bridge-tier', f), (error) =>
        error.code === 'CHECK_HALTED' && JSON.stringify(error.lines) === JSON.stringify(messages));
      const cli = capture(f, () => { throw new Error('writer refusal spawned'); });
      assert.equal(danger.main(argvFor('bridge-tier', f), cli.io), 3);
      assert.deepEqual(cli.lines, messages);
      assert.deepEqual(cli.errors, []);
    });
  });
  it('a relative CODEX_HOME resolves against the project root, never the caller cwd', (t) => {
    const f = fixture(t);
    setReviews(f);
    f.env.CODEX_HOME = 'codex-state';
    put(join(f.root, 'codex-state/auth.json'), '{}');
    const dir = join(f.root, 'codex-state');
    unchanged(f, () => {
      assert.notEqual(process.cwd(), f.root, 'the caller runs outside the project root');
      const result = danger.checkApply('bridge-tier', f);
      assert.ok(result.lines.includes(lineOf({ key: 'sandbox.excludedCommands', value: 'codex-review *', change: 'added', class: CLASSES[2] })));
      assert.ok(result.lines.includes(lineOf({ key: 'sandbox.filesystem.allowWrite', value: dir, change: 'added', class: CLASSES[1] })));
      const plan = velocity.writeVelocityProfile({ cwd: f.root, dryRun: true, bridgeTier: true }, writerDeps(f));
      assert.deepEqual([plan.excludedToAdd, plan.dirsToAdd], [['codex-review *'], [dir]]);
    });
  });
});

describe('spec:init-project/S47 the danger check over in-session writers by proof', () => {
  const hidden = { commit: '', pr: '', sessionUrl: false };
  const local = '.claude/settings.local.json';
  const header = '# agent-workflow-kit hidden mode (machine-local, applies to every repo on this host)';
  const legacy = [header, '/AGENTS.md', '/scripts/check-docs-size.mjs'];
  const loadName = async (module, name) => {
    const loaded = await import(module).catch((cause) => ({ cause }));
    return loaded[name] ?? (() => { throw new Error(`${name} is absent`, { cause: loaded.cause }); });
  };
  const configureGlobal = (f) => {
    put(join(f.home, '.gitconfig'), '[core]\n\texcludesFile = ~/.gitignore_global\n');
    return { ...f, env: { ...f.env, PATH: process.env.PATH, HOME: f.home,
      GIT_CONFIG_GLOBAL: join(f.home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } };
  };
  const writesLine = (path, before, after) =>
    `writes: ${path} sha256:${sha(Buffer.from(after, 'latin1'))} — replaces sha256:${sha(Buffer.from(before, 'latin1'))}`;
  for (const prior of [null, { attribution: { commit: 'old', pr: 'old' } }]) {
    it(`attribution: ${prior ? 'altered' : 'added'} hidden object, nothing widened, copy apply matches printed diff`, async (t) => {
      const f = fixture(t);
      if (prior) put(join(f.root, SETTINGS), JSON.stringify(prior));
      const writeAttribution = await loadName('./attribution.mjs', 'writeAttribution');
      const originalHashes = hashes(f);
      unchanged(f, () => {
        const plan = writeAttribution({ cwd: f.root, dryRun: true }, writerDeps(f));
        assert.equal(plan.planned, true);
        assert.deepEqual(plan.after, { ...prior, attribution: hidden });
        const result = danger.checkApply('attribution', f);
        assertPreview('attribution', f, result, { files: [{ path: SETTINGS, before: plan.before, after: plan.after }],
          writes: [], temporaries: [], directories: plan.claudeDirAbsent ? [join(f.root, '.claude')] : [] });
        assert.equal(result.lines[0], `${SETTINGS}:`);
        assert.equal(result.lines[1], lineOf({ key: 'attribution', value: hidden, class: NOTHING,
          change: prior ? 'altered' : 'added', ...(prior ? { previous: prior.attribution } : {}) }));
      });
      const copy = copyFixture(t, f);
      const before = snapshot(copy);
      const result = unchanged(copy, () => danger.checkApply('attribution', copy));
      assert.equal(danger.main([...argvFor('attribution', copy), '--apply', '--expect', result.digest], capture(copy).io), 0);
      const entries = danger.diffFiles(prior, json(join(copy.root, SETTINGS)));
      assert.deepEqual(result.lines.filter((line) => line.startsWith('  ')), entries.map((entry) => lineOf({ ...entry, class: NOTHING })));
      assertAppliedPaths(copy, before, result, [SETTINGS]);
      assert.deepEqual(hashes(f), originalHashes);
    });
  }
  for (const settings of [{ attribution: hidden }, { attribution: false }, { includeCoAuthoredBy: false }]) {
    it(`attribution: hidden settings ${JSON.stringify(settings)} have nothing to change`, async (t) => {
      const f = fixture(t);
      put(join(f.root, SETTINGS), JSON.stringify(settings));
      const writeAttribution = await loadName('./attribution.mjs', 'writeAttribution');
      unchanged(f, () => {
        assert.equal(writeAttribution({ cwd: f.root, dryRun: true }, writerDeps(f)).planned, false);
        const result = danger.checkApply('attribution', f);
        digestResult(result);
        assert.deepEqual(result.lines, ['nothing to change: attribution is already applied', `digest: ${result.digest}`]);
        assert.deepEqual(result.refused, []);
      });
    });
  }
  for (const [title, path, before, after, key] of [
    ['other value', SETTINGS, null, { attribution: true }, 'attribution'],
    ['second key', SETTINGS, null, { attribution: hidden, includeCoAuthoredBy: false }, 'includeCoAuthoredBy'],
    ['local key', local, null, { attribution: hidden }, 'attribution'],
    ['hidden key removal', SETTINGS, { attribution: hidden }, {}, 'attribution'],
  ]) it(`attribution: planted ${title} is refused naming ${key}`, (t) => {
    const f = fixture(t);
    unchanged(f, () => {
      const result = danger.judgeChange({ variant: 'attribution', files: [{ path, before, after }], scope: danger.scopeOf('attribution', f) });
      assert.deepEqual(result.refused, [{ path, key, reason: key === 'includeCoAuthoredBy' ? 'unknown key' : 'beyond the declared scope of attribution' }]);
      assert.deepEqual(result.entries, judged(before, after, path).entries);
      assert.ok(result.entries.some((entry) => entry.key === 'attribution' && entry.class === NOTHING));
    });
  });
  for (const path of [SETTINGS, local]) it(`attribution: masked ${path} exits 3`, (t) => {
    const f = fixture(t);
    put(join(f.root, path), '{}');
    unchanged(f, () => {
      const original = fs.lstatSync;
      const mocked = t.mock.method(fs, 'lstatSync', (file, ...args) => file === join(f.root, path)
        ? Object.assign(Object.create(original(file)), { isCharacterDevice: () => true, isFile: () => false }) : original(file, ...args));
      syncBuiltinESMExports();
      try {
        const cli = capture(f, () => { throw new Error('masked settings spawned'); });
        assert.equal(danger.main(argvFor('attribution', f), cli.io), 3);
        assert.deepEqual(cli.lines, [`masked: ${path}`]);
        assert.deepEqual(cli.errors, []);
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
    });
  });
  for (const [key, value] of [['attribution', 'wrong'], ['includeCoAuthoredBy', 'wrong']]) {
    it(`attribution: wrong-typed ${key} preserves the writer refusal at exit 3`, async (t) => {
      const f = fixture(t);
      put(join(f.root, SETTINGS), JSON.stringify({ [key]: value }));
      const writeAttribution = await loadName('./attribution.mjs', 'writeAttribution');
      unchanged(f, () => {
        const messages = [];
        assert.throws(() => writeAttribution({ cwd: f.root, dryRun: true }, writerDeps(f)), (error) => {
          assert.match(error.message, /\bATTRIBUTION_MALFORMED\b/);
          assert.match(error.message, new RegExp(`\\b${key}\\b`));
          messages.push(error.message);
          return true;
        });
        const cli = capture(f, () => { throw new Error('wrong-typed settings spawned'); });
        assert.equal(danger.main(argvFor('attribution', f), cli.io), 3);
        assert.deepEqual(cli.lines, messages);
        assert.deepEqual(cli.errors, []);
      });
    });
  }
  for (const [title, before, after] of [
    ['interleaved user line', `${header}\nkeep\n${legacy.slice(1).join('\n')}\n`, 'keep\n'],
    ['blank separator before block', `keep\n\n${legacy.join('\n')}\n`, 'keep\n\n'],
    ['trailing blank', `${legacy.join('\n')}\nkeep\n\n`, 'keep\n\n'],
    ['CRLF', `keep\r\n${legacy.join('\r\n')}\r\n`, 'keep\r\n'],
    ['mixed endings', `keep\r\n${header}\r/AGENTS.md\nuser\r/scripts/check-docs-size.mjs\r\n`, 'keep\r\nuser\r'],
    ['no final newline', `${legacy.join('\n')}\nkeep`, 'keep'],
    ['non-UTF-8 byte', `caf\xe9\n${legacy.join('\n')}\n`, 'caf\xe9\n'],
  ]) it(`footprint-global: ${title}, exact digests and removed spans, real copy apply`, async (t) => {
    const f = configureGlobal(fixture(t));
    const path = join(f.home, '.gitignore_global');
    put(path, Buffer.from(before, 'latin1'));
    const globalRemovalOf = await loadName('./hide-footprint.mjs', 'globalRemovalOf');
    const planGlobalRemoval = await loadName('./hide-footprint.mjs', 'planGlobalRemoval');
    const originalHashes = hashes(f);
    unchanged(f, () => {
      assert.deepEqual(globalRemovalOf(before), { after, removedLines: legacy });
      assert.deepEqual(planGlobalRemoval({ env: f.env }, f.root, { home: f.home }), { source: path, before, after, removedLines: legacy });
      const result = danger.checkApply('footprint-global', f);
      digestResult(result);
      assert.deepEqual(result.refused, []);
      assert.deepEqual(result.lines, [writesLine(path, before, after), ...legacy.map((line) => `removes: ${line}`),
        'scope: within the declared scope of footprint-global', `digest: ${result.digest}`]);
      assert.ok(result.lines[0].endsWith(` — replaces sha256:${sha(fs.readFileSync(path))}`));
      const cli = capture(f, () => { throw new Error('preview spawned'); });
      assert.equal(danger.main(argvFor('footprint-global', f), cli.io), 0);
      assert.deepEqual(cli.lines, result.lines);
      assert.deepEqual(cli.errors, []);
    });
    const copy = configureGlobal(copyFixture(t, f));
    const copyPath = join(copy.home, '.gitignore_global');
    const snapshotBefore = snapshot(copy);
    const beforeBytes = fs.readFileSync(copyPath);
    const result = unchanged(copy, () => danger.checkApply('footprint-global', copy));
    const cli = capture(copy);
    assert.equal(danger.main([...argvFor('footprint-global', copy), '--apply', '--expect', result.digest], cli.io), 0);
    const afterBytes = fs.readFileSync(copyPath);
    assert.deepEqual(afterBytes, Buffer.from(after, 'latin1'));
    assert.equal(result.lines[0], `writes: ${copyPath} sha256:${sha(afterBytes)} — replaces sha256:${sha(beforeBytes)}`);
    assert.deepEqual(cli.lines, result.lines);
    assert.deepEqual(cli.errors, []);
    assertAppliedPaths(copy, snapshotBefore, result, []);
    assert.deepEqual(hashes(f), originalHashes);
  });
  it('footprint-global: another cwd prints the same absolute writes path', (t) => {
    const f = configureGlobal(fixture(t));
    const path = join(f.home, '.gitignore_global');
    put(path, `${legacy.join('\n')}\nkeep\n`);
    unchanged(f, () => {
      const first = capture(f);
      assert.equal(danger.main(argvFor('footprint-global', f), first.io), 0);
      const cwd = process.cwd();
      try {
        process.chdir(f.home);
        const cli = capture(f);
        assert.equal(danger.main(['--variant', 'footprint-global', '--cwd', relative(f.home, f.root)], cli.io), 0);
        assert.deepEqual(cli.lines, first.lines);
        assert.equal(cli.lines[0], writesLine(path, `${legacy.join('\n')}\nkeep\n`, 'keep\n'));
      } finally {
        process.chdir(cwd);
      }
    });
  });
  for (const [title, content] of [
    ['unset core.excludesFile', `${legacy.join('\n')}\n`], ['absent file', null],
    ['no recognised line', 'user\n'], ['only generic lines', '/AGENTS.md\n/CLAUDE.md\n/docs/ai/\n/docs/plans/\n/.claude/skills/\n'],
  ]) it(`footprint-global: ${title} has nothing to change`, (t) => {
    const f = configureGlobal(fixture(t));
    if (content !== null) put(join(f.home, '.gitignore_global'), content);
    if (title === 'unset core.excludesFile') put(join(f.home, '.gitconfig'), '');
    unchanged(f, () => {
      const result = danger.checkApply('footprint-global', f);
      digestResult(result);
      assert.deepEqual(result.lines, ['nothing to change: footprint-global is already applied', `digest: ${result.digest}`]);
      assert.deepEqual(result.refused, []);
      const cli = capture(f, () => { throw new Error('empty preview spawned'); });
      assert.equal(danger.main(argvFor('footprint-global', f), cli.io), 0);
      assert.deepEqual(cli.lines, result.lines);
      assert.deepEqual(cli.errors, []);
    });
  });
  for (const title of ['unrecognised line removed', 'generic-only file', 'before differs', 'after differs']) {
    it(`footprint-global: planted ${title} refuses naming the file at exit 1`, async (t) => {
      const f = configureGlobal(fixture(t));
      const path = join(f.home, '.gitignore_global');
      const before = title === 'generic-only file' ? '/AGENTS.md\n/docs/ai/\n' : `caf\xe9\n${legacy.join('\n')}\n`;
      put(path, Buffer.from(before, 'latin1'));
      const globalRemovalOf = await loadName('./hide-footprint.mjs', 'globalRemovalOf');
      unchanged(f, () => {
        const core = globalRemovalOf(before);
        const plan = title === 'generic-only file' ? { source: path, before, after: '', removedLines: ['/AGENTS.md', '/docs/ai/'] }
          : { source: path, before: title === 'before differs' ? before.replace('\xe9', '\ufffd') : before,
            after: title === 'unrecognised line removed' ? '' : title === 'after differs' ? `${core.after}extra\n` : core.after,
            removedLines: title === 'unrecognised line removed' ? ['caf\xe9', ...core.removedLines] : core.removedLines };
        const deps = { planGlobalRemoval: () => plan };
        const result = danger.checkApply('footprint-global', f, deps);
        digestResult(result);
        assert.deepEqual(result.refused.map(({ path, key }) => ({ path, key })), [{ path, key: path }]);
        assert.ok(result.lines.some((line) => line.startsWith(`refused: ${path} ${path} — `)));
        assert.ok(result.lines.includes('nothing written'));
        const cli = capture(f, () => { throw new Error('planted removal spawned'); });
        assert.equal(danger.main([...argvFor('footprint-global', f), '--apply', '--expect', result.digest], { ...cli.io, ...deps }), 1);
        assert.deepEqual(cli.lines, result.lines);
        assert.deepEqual(cli.errors, []);
      });
    });
  }
  it('executor-vehicle.differing: the one executor write beside absent vehicles, an edited or linked lens and a rejected config; scope admits it alone', (t) => {
    const [f, path, config] = [fixture(t), '.claude/agents/executor.md', 'docs/ai/orchestration.json'];
    for (const [rel, body] of [[path, 'differing body\n'], [config, JSON.stringify({ 'plan-execution': { review: ['review-lens:opus:xhigh'] } })], ['.claude/agents/review-lens.md', 'edited lens\n']]) put(join(f.root, rel), body);
    const derived = writeCheapAgents({ cwd: f.root, dryRun: true }).plan.find((item) => item.rel === path && item.action === 're-derive').content;
    const judge = () => unchanged(f, () => {
      const result = danger.checkApply('executor-vehicle.differing', f);
      assert.deepEqual([result.lines.filter((line) => line.startsWith('writes: ')), result.refused, result.lines.includes('scope: within the declared scope of executor-vehicle.differing')], [[`writes: ${path} sha256:${sha(derived)} — replaces sha256:${sha('differing body\n')}`], [], true]);
      const cli = capture(f, () => { throw new Error('CLI preview spawned'); });
      assert.deepEqual([danger.main(argvFor('executor-vehicle.differing', f), cli.io), cli.lines], [0, result.lines]);
      return result.digest;
    });
    const digest = judge();
    for (const mutate of [() => fs.symlinkSync(join(f.root, config), join(f.root, '.claude/agents/review-lens-opus-xhigh.md')), () => put(join(f.root, config), '{ not json')]) {
      mutate();
      assert.equal(judge(), digest, 'the executor-only plan reads neither the lens nor the config');
    }
    assert.deepEqual(['executor.md', 'mechanical-sweep.md', 'review-lens.md', 'review-lens-opus-xhigh.md'].map((name) => danger.scopeOf('executor-vehicle.differing', f).admitsPath(join(f.root, '.claude/agents', name))), [true, false, false, false]);
  });
  for (const variant of ['attribution', 'footprint-global', 'executor-vehicle.differing']) it(`CLI accepts --variant ${variant}`, (t) => {
    const f = variant === 'footprint-global' ? configureGlobal(fixture(t)) : fixture(t);
    if (variant === 'executor-vehicle.differing') put(join(f.root, '.claude/agents/executor.md'), 'differing body\n');
    unchanged(f, () => {
      const cli = capture(f, () => { throw new Error('CLI preview spawned'); });
      assert.equal(danger.main(argvFor(variant, f), cli.io), 0);
      assert.deepEqual(cli.lines, danger.checkApply(variant, f).lines);
      assert.deepEqual(cli.errors, []);
    });
  });
});

describe('spec:init-project/S23 CLI usage, consent digest and exact apply argv', () => {
  const usageRows = [
    ['--help', 0], ['-h', 0], ['--unknown', 2], ['--variant', 2], ['--cwd', 2], ['--claude-dir', 2], ['--expect', 2],
    ['--variant velocity-core --cwd <file>', 2], ['--variant velocity-core --cwd <root> --claude-dir <dir>', 2],
    ['--variant read-lane --cwd <root>', 2], ['--variant jev-connect --cwd <root>', 2],
    ['--variant velocity-core --cwd <root> --apply', 2], ['--variant velocity-core --cwd <root> --expect <hex>', 2],
    ...['short', 'A'.repeat(64), 'g'.repeat(64)].map((hex) => [`--variant velocity-core --cwd <root> --apply --expect ${hex}`, 2]),
    ['--help --variant velocity-core', 2], ['-h --cwd <root>', 2],
  ];
  for (const [title, code] of usageRows) it(`usage ${code}: ${title}, nothing read`, (t) => {
    const f = fixture(t);
    put(join(f.root, 'ordinary-file'), 'sentinel');
    const values = { '<root>': f.root, '<file>': join(f.root, 'ordinary-file'), '<dir>': join(f.home, '.claude'), '<hex>': 'a'.repeat(64) };
    const argv = title.split(' ').map((arg) => values[arg] ?? arg);
    unchanged(f, () => {
      const cli = capture(f, () => { throw new Error('usage spawned'); });
      const mocked = t.mock.method(fs, 'readFileSync', () => { throw new Error('usage read a file'); });
      syncBuiltinESMExports();
      try {
        assert.equal(danger.main(argv, cli.io), code);
        assert.equal(mocked.mock.callCount(), 0);
        if (code === 0) {
          assert.match(cli.lines.join('\n'), /usage/i);
          assert.deepEqual(cli.errors, []);
          assert.doesNotMatch(cli.lines.join('\n'), /digest:|scope:|writes:/);
        } else assert.ok(cli.errors.length);
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
    });
  });
  for (const variant of VARIANTS) it(`${variant}: equal digest spawns exact FORMS argv; mismatch 5; writer failure 6`, (t) => {
    const f = fixture(t);
    if (variant.startsWith('jev-skill')) f.claudeDir = join(f.home, 'override');
    unchanged(f, () => {
      const result = danger.checkApply(variant, f);
      digestResult(result);
      for (const status of [0, 7]) {
        const calls = [];
        const cli = capture(f, (argv, opts) => {
          calls.push({ argv, opts });
          return { status };
        });
        const code = danger.main([...argvFor(variant, f), '--apply', '--expect', result.digest], cli.io);
        assert.equal(code, status === 0 ? 0 : 6);
        assert.deepEqual(cli.lines, result.lines);
        assert.deepEqual(cli.errors, status === 0 ? [] : ['apply exited 7']);
        const facts = f.claudeDir ? { ...f, env: { ...f.env, CLAUDE_CONFIG_DIR: f.claudeDir } } : f;
        assert.deepEqual(calls, [{ argv: lanes.consoleArgv(variant, facts).apply,
          opts: { cwd: f.root, env: f.env, stdio: 'inherit' } }]);
      }
      const mismatch = capture(f, () => { throw new Error('changed digest spawned'); });
      const different = `${result.digest[0] === '0' ? '1' : '0'}${result.digest.slice(1)}`;
      assert.equal(danger.main([...argvFor(variant, f), '--apply', '--expect', different], mismatch.io), 5);
      assert.deepEqual(mismatch.lines, result.lines);
    });
  });
  it('a refused apply exits 1 and never spawns, even with its equal digest', (t) => {
    const f = fixture(t);
    fs.rmSync(join(f.bin, 'claude'));
    put(join(f.root, SETTINGS), JSON.stringify(atKey('sandbox.credentials.envVars', [{ name: 'NPM_TOKEN', mode: 'deny' }])));
    unchanged(f, () => {
      const result = danger.checkApply('autonomy-render', f);
      assert.ok(result.refused.length);
      const cli = capture(f, () => { throw new Error('refused apply spawned'); });
      assert.equal(danger.main([...argvFor('autonomy-render', f), '--apply', '--expect', result.digest], cli.io), 1);
      assert.deepEqual(cli.lines, result.lines);
    });
  });
});
