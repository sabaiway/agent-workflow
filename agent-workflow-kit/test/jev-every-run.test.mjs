// jev-every-run.test.mjs — spec jev-every-run across the bridges: the wrapper list derived from the manifests (S6), the
// two hosts held to one set (S19), the two SKILL.md paragraphs (S22) and the shipped text that may no longer say
// network OFF or an every-key scrub (S23).
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { JEV_ENDPOINT } from '../tools/jev-facts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const BRIDGES = ['codex-cli-bridge', 'antigravity-cli-bridge'];
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');
const manifestOf = (bridge) => JSON.parse(read(`${bridge}/capability.json`));
const HOSTS = ['api.typesafe.ai', 'docs.typesafe.ai'];

const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
// A fixture tree holding a copy of both bridges' manifests and role sources, plus whatever a case adds.
const fixtureTree = (extra) => {
  const root = mkdtempSync(join(tmpdir(), 'jev-every-run-'));
  made.push(root);
  for (const bridge of BRIDGES) {
    cpSync(join(REPO, bridge, 'capability.json'), join(root, bridge, 'capability.json'));
    for (const { source } of Object.values(manifestOf(bridge).roles)) cpSync(join(REPO, bridge, source), join(root, bridge, source));
  }
  for (const [rel, text] of Object.entries(extra)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
};
// The wrapper check itself, run against a tree: the shared-block suite with its discovery pointed at the fixture.
const checkTree = (root) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT' && key !== 'NODE_V8_COVERAGE'));
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(HERE, 'settings-reader-parity.test.mjs')], { encoding: 'utf8', env: { ...env, AW_BRIDGES_ROOT: root } });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
};
const roles = (entries) => JSON.stringify({ roles: Object.fromEntries(entries) });

describe('the wrappers are derived from the bridge manifests — spec:jev-every-run/S6', () => {
  it('the check passes on the bridges as they are, holds a bash wrapper added to a new bridge, and fails a role without a source', () => {
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

// Every "<host>"="allow" pair a wrapper's profile literal carries, a backslash before a quote allowed.
const profileHostsOf = (text) => [...text.matchAll(/\\?"([a-z0-9.-]+)\\?"\s*=\s*\\?"allow\\?"/g)].map(([, host]) => host);
const hostCopies = () => ({
  'codex-exec.sh': profileHostsOf(read('codex-cli-bridge/bin/codex-exec.sh')),
  'codex-review.sh': profileHostsOf(read('codex-cli-bridge/bin/codex-review.sh')),
  ...Object.fromEntries(BRIDGES.map((bridge) => [`${bridge} networkHosts`, manifestOf(bridge).networkHosts.filter((host) => host.endsWith('typesafe.ai'))])),
});
const setOf = (hosts) => [...new Set(hosts)].sort().join(',');
// The copies whose host set differs from the exec wrapper's, and JEV_ENDPOINT when its host is outside that set.
const drift = (copies, endpointHost) => {
  const want = setOf(copies['codex-exec.sh']);
  const off = Object.entries(copies).filter(([, hosts]) => setOf(hosts) !== want).map(([name]) => name);
  return want.split(',').includes(endpointHost) ? off : [...off, 'JEV_ENDPOINT'];
};

describe('one set of hosts — spec:jev-every-run/S19', () => {
  const endpointHost = new URL(JEV_ENDPOINT).host;
  it('both manifests declare the two hosts, the copies agree, and a drift in any one copy fails the check', () => {
    for (const bridge of BRIDGES) for (const host of HOSTS) assert.ok(manifestOf(bridge).networkHosts.includes(host), `${bridge} declares ${host}`);
    const copies = hostCopies();
    assert.equal(setOf(copies['codex-exec.sh']), HOSTS.join(','));
    assert.deepEqual(drift(copies, endpointHost), []);
    for (const name of Object.keys(copies)) {
      const moved = { ...copies, [name]: copies[name].map((host) => host.replace('docs.', 'doc.')) };
      assert.notDeepEqual(drift(moved, endpointHost), [], `a drift in ${name} is caught`);
    }
    assert.deepEqual(drift(copies, 'api2.typesafe.ai'), ['JEV_ENDPOINT']);
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
// A phrase is a violation unless an every-key statement names TYPESAFE_API_KEY within its sentence's reach.
const violations = (surface, text) => {
  const body = flat(text);
  const hits = [...body.matchAll(NETWORK_OFF)].map((m) => m.index);
  for (const m of body.matchAll(EVERY_KEY)) if (!body.slice(Math.max(0, m.index - 200), m.index + 300).includes('TYPESAFE_API_KEY')) hits.push(m.index);
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
  const help = spawnSync('bash', [join(REPO, rel), '--help'], { encoding: 'utf8' }).stdout;
  const fence = commentBlocks(lines).filter((block) => block.some((line) => /fence/i.test(line))).flat();
  return [...header, help, ...lines.filter((line) => !/^\s*#/.test(line)), ...fence].join('\n');
};
const pages = (bridge) => ['references', 'setup'].flatMap((dir) => readdirSync(join(REPO, bridge, dir)).filter((name) => name.endsWith('.md')).map((name) => `${bridge}/${dir}/${name}`));

describe('the shipped text follows — spec:jev-every-run/S23', () => {
  it('no wrapper header, help, directive or fence comment, manifest, SKILL.md, page or kit role-contract copy says network OFF or an every-key scrub', () => {
    assert.equal(violations('a', '# network access OFF: installs by hand').length, 1, 'the network phrase is caught');
    assert.equal(violations('b', 'the wrapper unsets every `*_API_KEY` before the run').length, 1, 'the every-key phrase is caught');
    assert.equal(violations('c', 'it unsets every *_API_KEY except TYPESAFE_API_KEY').length, 0, 'the new rule is not');
    const surfaces = [
      ...BRIDGES.flatMap((bridge) => Object.values(manifestOf(bridge).roles).map(({ source }) => [`${bridge}/${source}`, wrapperText(`${bridge}/${source}`)])),
      ...BRIDGES.flatMap((bridge) => [`${bridge}/capability.json`, `${bridge}/SKILL.md`, ...pages(bridge)].map((rel) => [rel, read(rel)])),
      ['agent-workflow-kit/tools/detect-backends.mjs', read('agent-workflow-kit/tools/detect-backends.mjs')],
    ];
    assert.deepEqual(surfaces.flatMap(([surface, text]) => violations(surface, text)), []);
  });
});

describe('the settings-native lane states the sandboxed wrapper — spec:jev-every-run/S24', () => {
  it('the lane conditions the tier route, names the harness-proxy 403, routes the hosts to the tier re-run and keeps the allowWrite step', () => {
    const doc = flat(read('agent-workflow-kit/references/modes/recommendations.md'));
    const lane = doc.slice(doc.indexOf('**Settings-native sandbox**'), doc.indexOf('**Harness-managed sandbox**'));
    const outside = lane.match(/\boutside the (?:harness )?sandbox\b/gi) ?? [];
    const conditioned = lane.match(/where the harness honours[^.;]*excludedCommands[^.;]*outside the (?:harness )?sandbox\b/gi) ?? [];
    assert.ok(outside.length > 0 && outside.length === conditioned.length, 'every outside claim is conditioned');
    assert.match(lane, /Tunnel connection failed: 403/, 'the harness-proxy refusal is named');
    const sentences = lane.split(/(?<=\.)\s+/);
    assert.ok(sentences.some((s) => s.includes('--bridge-tier') && /\bre-?run\b/i.test(s) && /\bhosts\b/.test(s)), 'the tier re-run is the lane for the hosts');
    assert.ok(sentences.some((s) => /hand-apply/i.test(s) && s.includes('allowWrite') && /state dir/i.test(s)), 'the hand-apply allowWrite state-dir step stays');
  });
});
