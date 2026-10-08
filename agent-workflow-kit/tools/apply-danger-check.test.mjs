import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as velocity from './velocity-profile.mjs';
import * as hook from './gate-hook.mjs';
import { writeMcp } from './mcp.mjs';
import { buildServerEntry } from './mcp-registration.mjs';
import { writeCheapAgents } from './cheap-agents.mjs';
import { planFor } from './jev-skill.mjs';
import { SKILL_FILES, SKILL_PINS, skillTargets } from './jev-facts.mjs';
import { findOnPath } from './detect-backends.mjs';
import * as lanes from './write-lanes.mjs';

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
  'jev-skill', 'jev-skill.earlier'];
const CLASSES = ['hosts reachable', 'paths writable', 'commands outside the sandbox', 'prompts removed',
  'commands the harness runs', 'nothing widened'];
const NOTHING = CLASSES[5];
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
const hashes = (f) => [sha(JSON.stringify(tree(f.root))), sha(JSON.stringify(tree(f.home)))];
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
  for (const name of [...velocity.BRIDGE_REVIEW_WRAPPERS, 'bwrap', 'socat', 'claude']) {
    put(join(bin, name), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(join(bin, name), 0o755);
  }
  put(join(bin, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.291' }));
  t.mock.method(process, 'exit', () => {
    throw new Error('main must return without exiting');
  });
  return { toolsDir: TOOLS, root, home, bin, platform: process.platform,
    env: { HOME: home, PATH: `${bin}:${dirname(process.execPath)}` } };
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
  const addFile = (path, after) => files.push({ path, before: json(join(f.root, path)), after });
  if (['velocity-core', 'kit-tools-tier', 'bridge-tier'].includes(variant)) {
    const p = velocity.writeVelocityProfile({ cwd: f.root, dryRun: true,
      kitTools: variant === 'kit-tools-tier', bridgeTier: variant === 'bridge-tier' }, writerDeps(f));
    const before = p.projectSettings.data ?? {};
    const after = structuredClone(before);
    after.permissions = { ...before.permissions, allow: [...(before.permissions?.allow ?? []),
      ...p.toAdd, ...p.tierToAdd, ...p.bridgeToAdd] };
    if (p.excludedToAdd.length || p.hostsToAdd.length) after.sandbox = {
      ...before.sandbox, excludedCommands: [...(before.sandbox?.excludedCommands ?? []), ...p.excludedToAdd],
      network: { ...before.sandbox?.network,
        allowedDomains: [...(before.sandbox?.network?.allowedDomains ?? []), ...p.hostsToAdd] } };
    addFile(SETTINGS, after);
  } else if (variant === 'autonomy-render') {
    const render = velocity.writeAutonomyProfile({ cwd: f.root, apply: false }, writerDeps(f));
    addFile(SETTINGS, velocity.mergeAutonomySettings(json(join(f.root, SETTINGS)), render));
  } else if (['gate-hook', 'read-lane.missing'].includes(variant)) {
    const p = hook.writeGateHook({ cwd: f.root, dryRun: true });
    if (p.wirePlanned) addFile(SETTINGS, hook.mergeHookEntry(p.projectSettings.data));
    if (p.placePlanned) writes.push({ path: join(f.root, hook.HOOK_FILE_REL), bytes: p.bundleContent });
  } else if (variant.startsWith('mcp-channel')) {
    const p = writeMcp({ cwd: f.root, dryRun: true, replace: variant.endsWith('.differing') }).plan;
    if (p.writeMcpJson) addFile('.mcp.json', JSON.parse(p.mcpBody));
    if (p.writeSettings) addFile(SETTINGS, JSON.parse(p.settingsBody));
  } else if (['agents', 'executor-vehicle'].includes(variant)) {
    const p = writeCheapAgents({ cwd: f.root, dryRun: true });
    for (const item of p.plan.filter(({ action }) => ['place', 're-derive'].includes(action))) {
      writes.push({ path: item.abs, bytes: item.content });
    }
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
    assert.match(line.slice(prefix.length), /^[0-9a-f]{64}$/);
    if (!write.directory) assert.equal(line, prefix + sha(write.bytes));
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
    line.slice(8).replace(/ sha256:[0-9a-f]{64}$/, '').replace(/\/ created$/, ''));
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
      [...LIST_ROWS, ...SCALAR_ROWS].map(([key]) => key).concat('sandbox.credentials.envVars', 'mcpServers').sort());
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
    const settingsBefore = new Map([SETTINGS, '.mcp.json'].map((path) => [path, json(join(copy.root, path))]));
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
    assertAppliedPaths(copy, before, result, [SETTINGS, '.mcp.json']);
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
    ['unplaced bridge host', 'bridge-tier', 'sandbox.network.allowedDomains', () => {
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
