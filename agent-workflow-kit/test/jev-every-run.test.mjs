// jev-every-run.test.mjs — spec jev-every-run across the bridges: the wrapper list derived from the manifests (S6), the
// two hosts held to one set (S19), the two SKILL.md paragraphs (S22) and the shipped text that may no longer say
// network OFF or an every-key scrub (S23).
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, symlinkSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { JEV_ENDPOINT, KEY_VARIABLE } from '../tools/jev-facts.mjs';
import { stripGitLocationEnv } from '../tools/git-env.mjs';
import { bridgeRoleSources } from '../../scripts/testing/bridge-role-sources.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const BRIDGES = ['codex-cli-bridge', 'antigravity-cli-bridge'];
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');
const manifestOf = (bridge) => JSON.parse(read(`${bridge}/capability.json`));
const childEnv = (overrides = {}) => Object.fromEntries(Object.entries(stripGitLocationEnv({ ...process.env, ...overrides }))
  .filter(([key]) => key !== 'NODE_TEST_CONTEXT' && key !== 'NODE_V8_COVERAGE'));

const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
// A fixture tree holding a copy of both bridges' manifests and role sources, plus whatever a case adds.
const fixtureTree = (extra, clean = false) => {
  const root = mkdtempSync(join(tmpdir(), 'jev-every-run-'));
  made.push(root);
  for (const bridge of BRIDGES) {
    cpSync(join(REPO, bridge, 'capability.json'), join(root, bridge, 'capability.json'));
    for (const { source } of Object.values(manifestOf(bridge).roles)) cpSync(join(REPO, bridge, source), join(root, bridge, source));
    if (clean) {
      writeFileSync(join(root, bridge, 'capability.json'), JSON.stringify({ services: ['jev'], roles: Object.fromEntries(Object.entries(manifestOf(bridge).roles).map(([role, { source }]) => [role, { source }])) }));
      for (const { source } of Object.values(manifestOf(bridge).roles)) writeFileSync(join(root, bridge, source), '#!/usr/bin/env bash\n');
    }
  }
  for (const [rel, text] of Object.entries(extra)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
};
// The wrapper check itself, run against a tree: the shared-block suite with its discovery pointed at the fixture.
const checkTree = (root, fragments, endpointHost, keyVariable) => {
  if (fragments) return hostDrifts(root, fragments, endpointHost, keyVariable);
  const env = childEnv();
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(HERE, 'settings-reader-parity.test.mjs')], { encoding: 'utf8', env: { ...env, AW_BRIDGES_ROOT: root } });
  assert.ifError(r.error);
  assert.ok(r.status === 0 || r.status === 1, `wrapper check exited ${r.status}, signal ${r.signal}`);
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
};
const roles = (entries) => JSON.stringify({ roles: Object.fromEntries(entries) });

describe('the wrappers are derived from the bridge manifests — spec:jev-every-run/S6', () => {
  it('the check passes on the bridges as they are, holds a bash wrapper added to a new bridge, and fails a role without a source', () => {
    assert.ok(bridgeRoleSources(REPO).length > 0, 'the shared discovery returns the wrappers');
    const r = checkTree(fixtureTree({
      'node-bridge/capability.json': roles([['tool', { source: 'bin/tool.mjs' }]]),
      'node-bridge/bin/tool.mjs': '#!/usr/bin/env node\nconsole.log(1);\n',
      'agent-workflow-kit/bridges/mirror-bridge/capability.json': roles([['review', { cmd: 'mirror-review' }]]),
    }));
    assert.equal(r.status, 0, `a non-bash role source and a manifest below the top level are no wrappers: ${r.output}`);
    const added = checkTree(fixtureTree({
      'judge-bridge/capability.json': roles([['judge', { source: 'bin/judge.sh' }]]),
      'judge-bridge/bin/judge.sh': '#!/usr/bin/env bash\necho judged\n',
    }));
    assert.ok(added.status !== 0 && added.output.includes('judge-bridge/bin/judge.sh'), `the added wrapper is named: ${added.output}`);
    const sourceless = checkTree(fixtureTree({ 'quiet-bridge/capability.json': roles([['review', { cmd: 'quiet-review' }]]) }));
    assert.ok(sourceless.status !== 0 && sourceless.output.includes('quiet-bridge/capability.json role review has no source'), sourceless.output);
  });
});

const paragraphPattern = /^\*\*The Jev skill in a delegated run\.\*\*[^\n]*(?:\n(?!\n)[^\n]*)*/m;
const hostDrifts = (root, fragments, endpointHost = new URL(JEV_ENDPOINT).hostname, keyVariable = KEY_VARIABLE) => {
  const families = new Set(Object.values(fragments).flatMap(({ hosts }) => hosts.map((host) => host.toLowerCase().replace(/^\*\./, '').split('.').slice(-2).join('.'))));
  const variables = [...new Set(Object.values(fragments).flatMap(({ passedVariables }) => passedVariables))];
  const hits = [];
  const wrappers = new Set(bridgeRoleSources(root).map(({ bridge, source }) => join(root, bridge, source)));
  const inspect = (path) => {
    const text = readFileSync(path, 'utf8');
    const isJevSkill = BRIDGES.some((bridge) => path === join(root, bridge, 'SKILL.md'));
    const paragraph = isJevSkill ? text.match(paragraphPattern)?.[0] : undefined;
    const outside = paragraph ? text.replace(paragraph, '') : text;
    const paragraphVariables = [...(paragraph ?? '').matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map(([, variable]) => variable);
    if ([...text.matchAll(/(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z0-9-]+/gi)].some(([host]) => families.has(host.toLowerCase().split('.').slice(-2).join('.')))) hits.push(`${path}: host`);
    for (const variable of variables) if (new RegExp(`\\b${variable}\\b`).test(wrappers.has(path) ? text : outside)) hits.push(`${path}: variable ${variable}`);
    if (/\b(?:both|one|two|three|four|\d+)\s+(?:Jev\s+|reachable\s+|run\s+)?hosts?\b/i.test(text)) hits.push(`${path}: host count`);
    if (paragraph && (!paragraphVariables.length || paragraphVariables.some((variable) => !fragments.jev.passedVariables.includes(variable)))) hits.push(`${path}: paragraph variable`);
    if (isJevSkill && !paragraph) hits.push(`${path}: missing paragraph`);
  };
  const walk = (directory) => readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'service-facts.txt' || entry.name.endsWith('.test.mjs')) return;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path); else if (entry.isFile()) inspect(path);
  });
  for (const bridge of BRIDGES) {
    if (!JSON.parse(readFileSync(join(root, bridge, 'capability.json'), 'utf8')).services?.includes('jev')) hits.push(`${bridge}: services`);
    walk(join(root, bridge));
  }
  const detector = join(root, 'agent-workflow-kit/tools/detect-backends.mjs');
  if (existsSync(detector)) inspect(detector);
  if (!fragments.jev.hosts.includes(endpointHost)) hits.push('JEV_ENDPOINT');
  if (!fragments.jev.passedVariables.includes(keyVariable)) hits.push('KEY_VARIABLE');
  return hits;
};
describe('Hosts — spec:jev-every-run/S19', () => {
  it('rejects every planted host, key, count, paragraph, manifest and endpoint drift and the real tree has none', async () => {
    const { loadServiceFragments } = await import('../tools/services/index.mjs');
    const fragments = loadServiceFragments();
    const variable = fragments.jev.passedVariables[0];
    const paragraph = `**The Jev skill in a delegated run.** Pass \`${variable}\` as given.\n\n`;
    const baseline = Object.fromEntries(BRIDGES.map((bridge) => [`${bridge}/SKILL.md`, paragraph]));
    const root = fixtureTree(baseline, true);
    assert.deepEqual(checkTree(root, fragments), []);
    const drifts = [
      ...['api2.typesafe.ai', 'API.TYPESAFE.AI', variable, 'two hosts'].map((text) => ['codex-cli-bridge/references/drift.md', text]),
      ['codex-cli-bridge/bin/codex-exec.sh', `#!/usr/bin/env bash\necho ${variable}\n`],
      ['agent-workflow-kit/tools/detect-backends.mjs', 'api2.typesafe.ai'],
      ['codex-cli-bridge/references/nested/SKILL.md', paragraph],
      ...BRIDGES.flatMap((bridge) => [[`${bridge}/SKILL.md`, `${paragraph}${variable}\n`], [`${bridge}/SKILL.md`, paragraph.replace(variable, 'WRONG_API_KEY')], [`${bridge}/SKILL.md`, paragraph.replace('as given', 'to two hosts')], [`${bridge}/capability.json`, roles([['tool', { source: Object.values(manifestOf(bridge).roles)[0].source }]])]]),
    ];
    for (const [path, text] of drifts) assert.notDeepEqual(checkTree(fixtureTree({ ...baseline, [path]: text }, true), fragments), [], `${path}: ${text}`);
    for (const [path, text] of [['codex-cli-bridge/service-facts.txt', 'api2.typesafe.ai'], ['codex-cli-bridge/bin/excluded.test.mjs', variable], ['codex-cli-bridge/node_modules/page.md', 'API.TYPESAFE.AI']]) {
      assert.deepEqual(checkTree(fixtureTree({ ...baseline, [path]: text }, true), fragments), [], `${path}: excluded`);
    }
    assert.deepEqual(checkTree(root, fragments, 'api2.typesafe.ai'), ['JEV_ENDPOINT']);
    assert.deepEqual(checkTree(root, fragments, undefined, 'WRONG_API_KEY'), ['KEY_VARIABLE']);
    const wildcard = { ...fragments, injected: { hosts: ['*.family.example'], passedVariables: ['INJECTED_API_KEY'] } };
    for (const text of ['api.family.example', '*.family.example', 'INJECTED_API_KEY']) assert.notDeepEqual(checkTree(fixtureTree({ ...baseline, 'antigravity-cli-bridge/page.md': text }, true), wildcard), [], text);
    for (const bridge of BRIDGES) for (const text of ['no Jev paragraph\n', paragraph.replace(variable, '')]) assert.notDeepEqual(checkTree(fixtureTree({ ...baseline, [`${bridge}/SKILL.md`]: text }, true), fragments), [], `${bridge}: missing paragraph or key`);
    assert.deepEqual(checkTree(REPO, fragments), []);
  });
});

const flat = (text) => text.replace(/\s+/g, ' ');
const paragraphOf = (bridge) => {
  const lines = read(`${bridge}/SKILL.md`).split('\n');
  const start = lines.findIndex((line) => line.startsWith('**The Jev skill in a delegated run.**'));
  assert.ok(start >= 0, `${bridge}: the Jev paragraph`);
  return flat(lines.slice(start, lines.findIndex((line, index) => index > start && line === '')).join(' '));
};

describe('the two SKILL.md paragraphs — spec:jev-every-run/S22', () => {
  const COMMON = [[/TYPESAFE_API_KEY/, 'the key'], [/\bpass(es|ed)?\b/, 'the key passes'], [/web_search/, 'the web_search residual'], [/\bevery\b[^.]*\b(run|environment)\b/i, 'the key in every run\'s environment']];
  const OWN = {
    'codex-cli-bridge': [[/\bone run\b[^.]*\bversion\b/i, 'one run lost per codex version']],
    'antigravity-cli-bridge': [[/first denied command/, 'the limit'], [/agy-review/, 'agy-review stays without Jev'], [/--dangerously-skip-permissions[^.]*unconfined|unconfined[^.]*--dangerously-skip-permissions/, 'the opt-in carries the key unconfined']],
  };
  for (const bridge of BRIDGES) {
    it(`${bridge}: the key passes and every stated fact is there, the retired sentence gone`, () => {
      const paragraph = paragraphOf(bridge);
      for (const [pattern, fact] of [...COMMON, ...OWN[bridge]]) assert.match(paragraph, pattern, `${bridge} states ${fact}`);
      assert.doesNotMatch(paragraph, /orchestrator's own/);
    });
  }
});

const NETWORK_OFF = /\b[Nn]etwork(?:\s+access)?\s+(?:is\s+)?OFF\b/g;
const EVERY_KEY = /\bevery\s+(?:other\s+)?[`*]*_?API_KEY/gi;
const violations = (surface, text) => {
  const body = flat(text);
  const hits = [...body.matchAll(NETWORK_OFF)].map((m) => m.index);
  for (const m of body.matchAll(EVERY_KEY)) if (!/except[^.;]*passed variables[^.;]*service-facts\.txt|except[^.;]*service-facts\.txt[^.;]*passed variables/.test(body.slice(Math.max(0, m.index - 200), m.index + 300))) hits.push(m.index);
  return hits.map((index) => `${surface}: ...${body.slice(Math.max(0, index - 60), index + 80)}...`);
};
const commentBlocks = (lines) => lines.reduce((blocks, line, index) => {
  if (/^\s*#/.test(line)) (index > 0 && /^\s*#/.test(lines[index - 1]) ? blocks.at(-1) : blocks[blocks.push([]) - 1]).push(line);
  return blocks;
}, []);
// A wrapper's shipped lines: its header comment, its --help, every non-comment line and every comment block about the fence.
const wrapperText = (rel) => {
  const lines = read(rel).split('\n');
  const header = lines.slice(1, lines.findIndex((line, index) => index > 0 && !line.startsWith('#')));
  const child = spawnSync('bash', [join(REPO, rel), '--help'], { encoding: 'utf8', env: childEnv() });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const help = child.stdout;
  const fence = commentBlocks(lines).filter((block) => block.some((line) => /fence/i.test(line))).flat();
  return [...header, help, ...lines.filter((line) => !/^\s*#/.test(line)), ...fence].join('\n');
};
const pages = (bridge) => ['references', 'setup'].flatMap((dir) => readdirSync(join(REPO, bridge, dir)).filter((name) => name.endsWith('.md')).map((name) => `${bridge}/${dir}/${name}`));

describe('the shipped text follows — spec:jev-every-run/S23', () => {
  it('no shipped surface says network OFF or an every-key scrub without the passed variables its service-facts.txt lists', async () => {
    const { loadServiceFragments } = await import('../tools/services/index.mjs');
    const variables = Object.values(loadServiceFragments()).flatMap(({ passedVariables }) => passedVariables);
    for (const bridge of BRIDGES) for (const line of read(`${bridge}/service-facts.txt`).split('\n').filter((line) => line.startsWith('PASSED_VARIABLE='))) assert.ok(variables.includes(line.slice(line.indexOf('=') + 1)), line);
    assert.equal(violations('a', '# network access OFF: installs by hand').length, 1, 'the network phrase is caught');
    assert.equal(violations('b', 'the wrapper unsets every `*_API_KEY` before the run').length, 1, 'the every-key phrase is caught');
    assert.equal(violations('c', 'it unsets every *_API_KEY except the passed variables its service-facts.txt lists').length, 0, 'the file-driven exception is admitted');
    const surfaces = [
      ...BRIDGES.flatMap((bridge) => Object.values(manifestOf(bridge).roles).map(({ source }) => [`${bridge}/${source}`, wrapperText(`${bridge}/${source}`)])),
      ...BRIDGES.flatMap((bridge) => [`${bridge}/capability.json`, `${bridge}/SKILL.md`, ...pages(bridge)].map((rel) => [rel, read(rel)])),
      ['agent-workflow-kit/tools/detect-backends.mjs', read('agent-workflow-kit/tools/detect-backends.mjs')],
    ];
    assert.deepEqual(surfaces.flatMap(([surface, text]) => violations(surface, text)), []);
  });
});

it('every discovered wrapper validates the facts state table before help or CLI spawn — spec:jev-every-run/S25', async (context) => {
  const { loadServiceFragments, mergeServices, renderServiceFacts } = await import('../tools/services/index.mjs');
  const fragments = {
    reachable: { hosts: ['API.EXAMPLE', '7label.example'], writableDirs: [{ env: 'FIRST_DIR', default: '~/shared cache:slot' }], excludedCommands: ['tool-name *'], passedVariables: ['FOO_API_KEY'], billingVariables: [], runReachesHosts: true },
    catalog: { hosts: ['*.catalog.example'], writableDirs: [{ env: null, default: '/srv/env less:cache' }, { env: 'SECOND_DIR', default: '~/shared cache:slot' }], excludedCommands: [], passedVariables: [], billingVariables: [], runReachesHosts: false },
  };
  const ids = Object.keys(fragments);
  const loaded = loadServiceFragments({ servicesDir: '/in-memory', readdir: () => ids.map((id) => `${id}.json`), readFile: (path) => JSON.stringify(fragments[basename(path, '.json')]) });
  const rendered = renderServiceFacts(mergeServices(ids, loaded));
  const root = mkdtempSync(join(tmpdir(), 'jev-facts-table-'));
  made.push(root);
  const farm = join(root, 'path');
  mkdirSync(farm);
  const seen = new Set(['codex', 'agy', 'agy-run']);
  for (const directory of (process.env.PATH ?? '').split(':').filter((path) => path && existsSync(path) && statSync(path).isDirectory())) {
    for (const name of readdirSync(directory)) if (!seen.has(name)) { seen.add(name); symlinkSync(join(directory, name), join(farm, name)); }
  }
  for (const name of ['bash', 'mkfifo']) assert.ok(existsSync(join(farm, name)), `PATH farm has ${name}`);
  for (const name of ['codex', 'agy']) assert.equal(existsSync(join(farm, name)), false, `${name} absent from PATH`);
  const header = read(`${BRIDGES[0]}/service-facts.txt`).split('\n')[0];
  const facts = (...lines) => [header, ...lines, ''].join('\n');
  const cells = [
    { name: 'admitted shipped file', admitted: true },
    { name: 'admitted rendered file', admitted: true, text: rendered },
    ...['absent', 'unreadable', 'directory', 'FIFO'].map((name) => ({ name })),
    { name: 'empty file', text: '', line: 1 }, { name: 'wrong header', text: '# another header\n', line: 1 },
    { name: 'no final newline', text: `${header}\nHOST=a.example`, line: 2 },
    { name: 'unknown key', text: facts('UNKNOWN=value'), line: 2 }, { name: 'no equals', text: facts('HOST'), line: 2 },
    ...[['HOST', 'bad host'], ['RUN_HOST', 'bad host'], ['PASSED_VARIABLE', 'lower_case'], ['WRITABLE_DIR', 'DIR:relative/path'], ['EXCLUDED_COMMAND', 'tool*']].map(([key, value]) => ({ name: `malformed ${key}`, text: facts(`${key}=${value}`), line: 2 })),
    { name: 'wildcard RUN_HOST', text: facts('HOST=*.example.com', 'RUN_HOST=*.example.com'), line: 3 },
    { name: 'OPENAI_BASE_URL passed', text: facts('PASSED_VARIABLE=OPENAI_BASE_URL'), line: 2 },
    { name: 'repeated HOST', text: facts('HOST=a.example', 'HOST=a.example'), line: 3 },
    { name: 'RUN_HOST absent from HOST', text: facts('HOST=a.example', 'RUN_HOST=b.example'), line: 3 },
  ];
  for (const cell of cells) for (const { bridge, source } of bridgeRoleSources(REPO)) for (const launch of ['direct', 'symlink']) {
    await context.test(`${cell.name}: ${bridge}/${source}: ${launch}`, (test) => {
      if (cell.name === 'unreadable' && process.getuid?.() === 0) { test.skip('chmod 000 is readable by uid 0'); return; }
      const directory = mkdtempSync(join(root, 'copy-'));
      cpSync(join(REPO, bridge, 'bin'), join(directory, 'bin'), { recursive: true });
      cpSync(join(REPO, bridge, 'capability.json'), join(directory, 'capability.json'));
      const path = join(directory, 'service-facts.txt');
      const env = { ...childEnv({ HOME: join(directory, 'home'), XDG_CONFIG_HOME: join(directory, 'home/.config'), PATH: farm, LC_ALL: 'C' }), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1' };
      mkdirSync(env.HOME);
      if (cell.name === 'directory') mkdirSync(path);
      else if (cell.name === 'FIFO') {
        const result = spawnSync('mkfifo', [path], { env, encoding: 'utf8' });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
      } else if (cell.name !== 'absent') {
        writeFileSync(path, cell.text ?? read(`${bridge}/service-facts.txt`));
        if (cell.name === 'unreadable') chmodSync(path, 0o000);
      }
      const linked = join(directory, 'bin', 'linked-wrapper');
      if (launch === 'symlink') symlinkSync(basename(source), linked);
      const result = spawnSync(join(farm, 'bash'), [launch === 'symlink' ? linked : join(directory, source), '--help'], { cwd: directory, env, encoding: 'utf8', timeout: 5000 });
      assert.ifError(result.error);
      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.status, cell.admitted ? 0 : 127, result.stderr);
      if (cell.admitted) assert.match(result.stdout, /Usage:\n/);
      else {
        assert.doesNotMatch(result.stdout, /Usage:/);
        const lines = result.stderr.trimEnd().split('\n');
        assert.equal(lines.length, 1, result.stderr);
        assert.ok(lines[0].includes(path), result.stderr);
        assert.ok(lines[0].includes('/agent-workflow-kit upgrade'), result.stderr);
        if (cell.line) assert.deepEqual([...lines[0].matchAll(/\bline (\d+)\b/g)].map(([, number]) => Number(number)), [cell.line], result.stderr);
        else assert.doesNotMatch(lines[0], /\bline \d+\b/);
      }
    });
  }
});

describe('the settings-native lane states the sandboxed wrapper — spec:jev-every-run/S24', () => {
  it('the lane conditions the tier route, names the harness-proxy 403, routes hosts and state dirs to the tier re-run and carries no hand-apply allowWrite step', () => {
    const doc = flat(read('agent-workflow-kit/references/modes/recommendations.md'));
    const lane = doc.slice(doc.indexOf('**Settings-native sandbox**'), doc.indexOf('**Harness-managed sandbox**'));
    const outside = lane.match(/\boutside the (?:harness )?sandbox\b/gi) ?? [];
    const conditioned = lane.match(/where the harness honours[^.;]*excludedCommands[^.;]*outside the (?:harness )?sandbox\b/gi) ?? [];
    assert.ok(outside.length > 0 && outside.length === conditioned.length, 'every outside claim is conditioned');
    assert.match(lane, /Tunnel connection failed: 403/, 'the harness-proxy refusal is named');
    const sentences = lane.split(/(?<=\.)\s+/);
    assert.ok(sentences.some((s) => s.includes('--bridge-tier') && /\bre-?run\b/i.test(s) && /\bhosts\b/.test(s)), 'the tier re-run is the lane for the hosts');
    assert.ok(!sentences.some((s) => /hand-apply/i.test(s) && s.includes('allowWrite')), 'the lane carries no hand-apply allowWrite step');
    assert.match(lane, /--bridge-tier.*\bre-?run\b.*(?:\ballowWrite\b|\bstate dirs?\b)/i, 'the tier re-run is the lane for the state dirs too');
  });
});

describe('a declared stub adds no wrapper — spec:jev-every-run/S28', () => {
  it('an absent role source passes only with available false', () => {
    const manifest = { available: false, roles: { judge: { cmd: 'jev-ask', source: 'bin/jev-ask.sh' } } };
    const stub = checkTree(fixtureTree({ 'typesafe-jev-bridge/capability.json': JSON.stringify(manifest) }));
    assert.equal(stub.status, 0, stub.output);
    const { available, ...undeclared } = manifest;
    for (const declared of [{ ...manifest, available: true }, undeclared]) {
      const result = checkTree(fixtureTree({ 'typesafe-jev-bridge/capability.json': JSON.stringify(declared) }));
      assert.notEqual(result.status, 0, result.output);
      assert.ok(result.output.includes('typesafe-jev-bridge/bin/jev-ask.sh'), result.output);
    }
  });
});
