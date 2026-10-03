// bridge-settings-model.test.mjs — the model keys on the bridge-settings command (spec bridge-settings):
// the read-out of each bridge's host posture and the models its installed CLI offers, the set judged
// against that bridge's catalog before any write, and the shipped text naming only each default.
// Fake `codex` and `agy` CLIs sit on the injected PATH; each logs its argv and environment.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main } from './bridge-settings.mjs';
import { surveyBridges } from './family-registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const KIT = resolve(HERE, '..');
// The catalog leaf ships with this story: a missing module fails each cell at its first use.
const catalogLeaf = await import('./bridge-catalog.mjs').catch(() => ({}));
const ABSENT = 'bridge-catalog.mjs is not present';
const leaf = (name) => catalogLeaf[name] ?? (() => { throw new Error(ABSENT); })();

const CODEX_CATALOG = JSON.stringify({ models: [
  { slug: 'gpt-6.1-sol', visibility: 'list', priority: 1, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] },
  { slug: 'gpt-6-luna', visibility: 'list', priority: 2, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }] },
  { slug: 'gpt-6-hidden', visibility: 'hide', priority: 3, supported_reasoning_levels: [{ effort: 'low' }] },
] });
const AGY_CATALOG = 'Available models:\nm1\tGemini 3.8 Flash (High)\nm2\tAstra Two (Low)\n';
const OUTPUT = { codex: { ok: CODEX_CATALOG, notjson: 'not json', empty: '{"models":[]}' }, agy: { ok: AGY_CATALOG, notjson: 'no tab here\n', empty: '' } };

const fake = (cli) => [
  `#!${process.execPath}`,
  "const fs = require('node:fs');",
  `fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cli: '${cli}', argv: process.argv.slice(2), env: process.env }) + '\\n');`,
  `const mode = process.env.FAKE_${cli.toUpperCase()}_MODE || 'ok';`,
  "if (mode === 'hang') { process.on('SIGTERM', () => {}); setTimeout(() => {}, 20000); }",
  "else if (mode === 'fail') process.exit(3);",
  `else process.stdout.write(${JSON.stringify(OUTPUT[cli])}[mode]);`,
  '',
].join('\n');

const SHARED = mkdtempSync(join(tmpdir(), 'awf-bsm-'));
after(() => rmSync(SHARED, { recursive: true, force: true }));
let seq = 0;
// { codex, agy }: 'absent' leaves the CLI off PATH; any other value is the fake's mode.
const sandbox = ({ codex = 'ok', agy = 'ok', settings } = {}) => {
  const home = join(SHARED, `sb-${++seq}`);
  const bin = join(home, 'bin');
  mkdirSync(join(home, 'agent-workflow'), { recursive: true });
  mkdirSync(bin);
  if (codex !== 'absent') writeFileSync(join(bin, 'codex'), fake('codex'), { mode: 0o755 });
  if (agy !== 'absent') writeFileSync(join(bin, 'agy'), fake('agy'), { mode: 0o755 });
  const conf = join(home, 'agent-workflow', 'bridge-settings.conf');
  if (settings !== undefined) writeFileSync(conf, settings);
  const log = join(home, 'calls.log');
  const env = { XDG_CONFIG_HOME: home, PATH: bin, FAKE_LOG: log, FAKE_CODEX_MODE: codex, FAKE_AGY_MODE: agy };
  return { home, conf, log, ctx: (extra = {}, more = {}) => ({ getenv: { ...env, ...extra }, home, ...more }) };
};
const calls = (sb) => (existsSync(sb.log) ? readFileSync(sb.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const bridgeOf = (json, name) => json.bridges.find((b) => b.bridge === name);

// The wrappers' own host-posture reader, extracted verbatim (the reader-parity idiom).
const extractBashFn = (source, name) => {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${name}()`));
  assert.notEqual(start, -1, `wrapper carries ${name}()`);
  return lines.slice(start, lines.findIndex((l, i) => i > start && l === '}') + 1).join('\n');
};
const WRAPPERS = ['codex-cli-bridge/bin/codex-exec.sh', 'codex-cli-bridge/bin/codex-review.sh', 'antigravity-cli-bridge/bin/agy.sh', 'antigravity-cli-bridge/bin/agy-review.sh'];
const wrapperSource = (rel) => readFileSync(join(REPO, rel), 'utf8');
const runShell = (rel, fns, body, home) => spawnSync('bash', ['-c', `${fns.map((n) => extractBashFn(wrapperSource(rel), n)).join('\n')}\n${body}`],
  { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home } });

describe('the read-out on a fresh host — spec:bridge-settings/S1', () => {
  it('names each bridge default with source default and the models each CLI offers', async () => {
    const sb = sandbox();
    const r = await main([], sb.ctx());
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /codex-cli-bridge: model gpt-6\.1-sol \[default\] · effort high \[default\]/);
    assert.match(r.stdout, /antigravity-cli-bridge: model Gemini 3\.8 Flash \(High\) \[default\]/);
    assert.match(r.stdout, /offered: gpt-6\.1-sol \(low, medium, high\), gpt-6-luna \(low, medium\)\n/);
    assert.match(r.stdout, /offered: Gemini 3\.8 Flash \(High\), Astra Two \(Low\)\n/);
    assert.doesNotMatch(r.stdout, /gpt-6-hidden/, 'only visibility list entries are offered');
  });
});

describe('a written model is the next run host posture — spec:bridge-settings/S2', () => {
  it('--set CODEX_MODEL --apply: the read-out says setting and the wrapper reader takes it as setting', async () => {
    const sb = sandbox();
    const w = await main(['--set', 'CODEX_MODEL=gpt-6-luna', '--set', 'CODEX_EFFORT=medium', '--apply'], sb.ctx());
    assert.equal(w.code, 0, w.stderr);
    assert.equal(readFileSync(sb.conf, 'utf8'), 'CODEX_MODEL=gpt-6-luna\nCODEX_EFFORT=medium\n');
    const r = await main([], sb.ctx());
    assert.match(r.stdout, /codex-cli-bridge: model gpt-6-luna \[setting\] · effort medium \[setting\]/);
    const sh = runShell(WRAPPERS[0], ['aw_settings_file', 'aw_read_posture'],
      'unset CODEX_MODEL; aw_read_posture CODEX_MODEL gpt-6.1-sol gpt-6.1-sol; printf "%s|%s" "$AW_RUN_VALUE" "$AW_RUN_SOURCE"', sb.home);
    assert.equal(sh.stdout, 'gpt-6-luna|setting', sh.stderr);
  });
});

describe('environment values read as environment — spec:bridge-settings/S3', () => {
  it('a set value, an empty codex key and an empty AGY_MODEL', async () => {
    const sb = sandbox({ settings: 'CODEX_MODEL=gpt-6-luna\n' });
    const set = JSON.parse((await main(['--json'], sb.ctx({ CODEX_MODEL: 'gpt-6.1-sol' }))).stdout);
    assert.deepEqual([bridgeOf(set, 'codex-cli-bridge').model.value, bridgeOf(set, 'codex-cli-bridge').model.source], ['gpt-6.1-sol', 'environment']);
    const empty = JSON.parse((await main(['--json'], sb.ctx({ CODEX_MODEL: '', CODEX_EFFORT: '', AGY_MODEL: '' }))).stdout);
    const codex = bridgeOf(empty, 'codex-cli-bridge');
    assert.deepEqual([codex.model.value, codex.model.source, codex.effort.value, codex.effort.source], ['gpt-6.1-sol', 'environment', 'high', 'environment']);
    const agy = bridgeOf(empty, 'antigravity-cli-bridge');
    assert.deepEqual([agy.model.value, agy.model.source], [null, 'environment'], 'an empty AGY_MODEL is no model');
    assert.match((await main([], sb.ctx({ AGY_MODEL: '' }))).stdout, /antigravity-cli-bridge: model \(none\) \[environment\]/);
    const ctl = (await main([], sb.ctx({ AGY_MODEL: 'x\x01y', CODEX_MODEL: 'x\x01y' }))).stdout;
    assert.match(ctl, /AGY_MODEL — agy-review refuses the run pre-spend; agy-run has no control-byte screen/);
    assert.match(ctl, /CODEX_MODEL — the codex wrappers refuse the run pre-spend/);
  });
});

describe('a model or effort the catalog does not offer is refused before any write — spec:bridge-settings/S4', () => {
  const refused = async (sb, args, offered) => {
    const before = readFileSync(sb.conf, 'utf8');
    for (const extra of [[], ['--apply']]) {
      const r = await main([...args, ...extra], sb.ctx());
      assert.equal(r.code, 2, `${args.join(' ')} ${extra.join(' ')}: ${r.stdout}`);
      assert.match(r.stderr, new RegExp(`Offered: ${offered.replace(/[()]/g, '\\$&')}$`));
      assert.equal(readFileSync(sb.conf, 'utf8'), before, 'the file bytes are unchanged');
    }
  };
  it('an unoffered codex model, and a hidden one', async () => {
    const sb = sandbox({ settings: '# mine\n' });
    await refused(sb, ['--set', 'CODEX_MODEL=gpt-9-nope'], 'gpt-6.1-sol, gpt-6-luna');
    await refused(sb, ['--set', 'CODEX_MODEL=gpt-6-hidden'], 'gpt-6.1-sol, gpt-6-luna');
  });
  it('an effort the resulting model does not offer, set alone against a stored model included', async () => {
    await refused(sandbox({ settings: '' }), ['--set', 'CODEX_EFFORT=xhigh'], 'low, medium, high');
    await refused(sandbox({ settings: 'CODEX_MODEL=gpt-6-luna\n' }), ['--set', 'CODEX_EFFORT=high'], 'low, medium');
    await refused(sandbox({ settings: 'CODEX_EFFORT=high\n' }), ['--set', 'CODEX_MODEL=gpt-6-luna'], 'low, medium');
  });
  it('an unoffered agy model', async () => {
    await refused(sandbox({ settings: '' }), ['--set', 'AGY_MODEL=Gemini 3.8 Flash'], 'Gemini 3.8 Flash (High), Astra Two (Low)');
  });
  it('an offered posture proceeds; the environment does not decide the judgment', async () => {
    const sb = sandbox({ settings: '' });
    const r = await main(['--set', 'AGY_MODEL=Astra Two (Low)', '--apply'], sb.ctx({ AGY_MODEL: 'Unoffered' }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(sb.conf, 'utf8'), 'AGY_MODEL=Astra Two (Low)\n');
    assert.match(r.stdout, /AGY_MODEL is currently set in the environment — .*one-off, which agy-review refuses unless AGY_PROBE=1/);
    const codex = await main(['--set', 'CODEX_EFFORT=low'], sb.ctx({ CODEX_EFFORT: 'medium' }));
    assert.match(codex.stdout, /CODEX_EFFORT is currently set in the environment — .*one-off, which codex-exec and codex-review refuse unless CODEX_PROBE=1/);
  });
});

describe('an unreadable catalog never fails the command — spec:bridge-settings/S5', () => {
  for (const mode of ['absent', 'fail', 'notjson', 'empty']) {
    it(`a ${mode} catalog is one line naming the bridge and cause; the read-out exits 0`, async () => {
      const sb = sandbox({ codex: mode, agy: mode });
      const r = await main([], sb.ctx());
      assert.equal(r.code, 0, r.stderr);
      for (const bridge of ['codex-cli-bridge', 'antigravity-cli-bridge']) {
        const lines = r.stdout.split('\n').filter((l) => l.includes(`⚠ ${bridge}:`));
        assert.equal(lines.length, 1, `${bridge}: ${r.stdout}`);
        assert.match(lines[0], mode === 'absent' ? /not installed \((codex|agy) is not on PATH\)/ : /unreadable \(.+\)/);
      }
    });
  }
  it('a hung catalog ignoring SIGTERM is killed within its bound plus the grace; the reads run concurrently', { timeout: 10000 }, async () => {
    const sb = sandbox({ codex: 'hang', agy: 'hang' });
    const started = Date.now();
    const r = await main([], sb.ctx({}, { catalogBoundsMs: { 'codex-cli-bridge': 800, 'antigravity-cli-bridge': 800 }, catalogKillGraceMs: 200 }));
    const elapsed = Date.now() - started;
    assert.equal(r.code, 0, r.stderr);
    assert.ok(elapsed < 1900, `two hung reads took ${elapsed} ms — not concurrent, or not killed`);
    assert.equal((r.stdout.match(/unreadable \(it exceeded 0\.8s\)/g) ?? []).length, 2, r.stdout);
  });
  it('a CLI whose start throws (ETXTBSY) is one unreadable line; the read-out exits 0', async (t) => {
    const sb = sandbox();
    const fds = ['codex', 'agy'].map((cli) => openSync(join(sb.home, 'bin', cli), 'r+'));
    try {
      if (spawnSync(join(sb.home, 'bin', 'agy'), [], { stdio: 'ignore' }).error?.code !== 'ETXTBSY') return t.skip('this host does not refuse exec of a file open for writing');
      const r = await main([], sb.ctx());
      assert.equal(r.code, 0, r.stderr);
      assert.equal((r.stdout.match(/unreadable \(.*could not start \(ETXTBSY\)\)/g) ?? []).length, 2, r.stdout);
    } finally { fds.forEach((fd) => closeSync(fd)); }
  });
  it('a set proceeds on an unreadable catalog, stating the value was not checked', async () => {
    const sb = sandbox({ codex: 'fail' });
    const r = await main(['--set', 'CODEX_MODEL=gpt-9-anything', '--apply'], sb.ctx());
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(sb.conf, 'utf8'), 'CODEX_MODEL=gpt-9-anything\n');
    assert.match(r.stdout, /codex-cli-bridge: the value was not checked/);
  });
  it('the leaf bounds equal the wrappers constants', () => {
    const bounds = leaf('CATALOG_BOUNDS_MS');
    for (const rel of WRAPPERS.slice(0, 2)) assert.equal(bounds['codex-cli-bridge'], 1000 * Number(wrapperSource(rel).match(/^CODEX_CATALOG_TIMEOUT_S=(\d+)$/m)[1]), rel);
    for (const rel of WRAPPERS.slice(2)) assert.equal(bounds['antigravity-cli-bridge'], 1000 * Number(wrapperSource(rel).match(/^AGY_CATALOG_TIMEOUT=(\d+)s$/m)[1]), rel);
    for (const rel of WRAPPERS) assert.match(wrapperSource(rel), new RegExp(`--kill-after=${leaf('CATALOG_KILL_GRACE_MS') / 1000}s "\\$(CODEX_CATALOG_TIMEOUT_S|AGY_CATALOG_TIMEOUT)"`), rel);
  });
});

describe('the manifests declare the model keys; no reader calls them unknown — spec:bridge-settings/S6', () => {
  it('each key is kind posture, its default the posture block value, applying to every wrapper', () => {
    for (const [dir, keys] of [['codex-cli-bridge', { CODEX_MODEL: 'model', CODEX_EFFORT: 'effort' }], ['antigravity-cli-bridge', { AGY_MODEL: 'model' }]]) {
      const manifest = JSON.parse(readFileSync(join(REPO, dir, 'capability.json'), 'utf8'));
      const cmds = Object.values(manifest.roles).map((r) => r.cmd);
      for (const [key, slot] of Object.entries(keys)) {
        const entry = (manifest.settings ?? []).find((s) => s.key === key);
        assert.ok(entry, `${dir} declares ${key}`);
        assert.deepEqual([entry.kind, entry.default, [...entry.appliesTo].sort()], ['posture', manifest.posture[slot], [...cmds].sort()]);
      }
    }
  });
  for (const dir of ['codex-cli-bridge', 'antigravity-cli-bridge', 'agent-workflow-kit/bridges/codex-cli-bridge', 'agent-workflow-kit/bridges/antigravity-cli-bridge']) {
    it(`manifest validate --strict passes on ${dir}`, () => {
      const r = spawnSync(process.execPath, [join(KIT, 'tools', 'manifest', 'validate.mjs'), '--strict', join(REPO, dir)], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.ok(JSON.parse(readFileSync(join(REPO, dir, 'capability.json'), 'utf8')).settings.some((s) => s.kind === 'posture'), `${dir} carries the posture keys`);
    });
  }
  it('the kit reader and every wrapper recognise the three keys', async () => {
    const sb = sandbox({ settings: 'CODEX_MODEL=gpt-6-luna\nCODEX_EFFORT=low\nAGY_MODEL=Astra Two (Low)\n' });
    assert.doesNotMatch((await main([], sb.ctx())).stdout, /unknown keys/);
    const fns = ['aw_settings_file', 'aw_settings_known', 'aw_int_in_range', 'aw_settings_valid', 'aw_apply_settings'];
    for (const rel of WRAPPERS) {
      const sh = runShell(rel, fns, 'unset AW_SETTINGS_NOTIFIED; AW_SETTINGS_APPLIED=""; aw_apply_settings', sb.home);
      assert.equal(sh.status, 0, rel);
      assert.doesNotMatch(sh.stderr, /unknown key/, `${rel}: ${sh.stderr}`);
    }
  });
  it('an empty AGY_MODEL environment value drops the model in the wrapper reader too', () => {
    assert.match(wrapperSource(WRAPPERS[2]), /^aw_read_posture AGY_MODEL "\$DEFAULT_AGY_MODEL" ""$/m);
    assert.match(wrapperSource(WRAPPERS[0]), /^aw_read_posture CODEX_MODEL "\$DEFAULT_CODEX_MODEL" "\$DEFAULT_CODEX_MODEL"$/m);
  });
});

describe('the writer refuses an empty, padded or control-byte model value — spec:bridge-settings/S7', () => {
  for (const value of ['', ' gpt-6-luna', 'gpt-6-luna\t', `gpt${String.fromCharCode(1)}x`, `gpt${String.fromCharCode(127)}x`]) {
    it(`CODEX_MODEL=${JSON.stringify(value)} exits 2 before the file or a catalog is read`, async () => {
      const sb = sandbox({ settings: '# mine\n' });
      const reads = [];
      const r = await main(['--set', `CODEX_MODEL=${value}`, '--apply'], sb.ctx({}, { readFile: (p, enc) => { reads.push(String(p)); return readFileSync(p, enc); } }));
      assert.equal(r.code, 2, r.stdout);
      assert.match(r.stderr, /invalid value/);
      assert.ok(!reads.includes(sb.conf), 'nothing read of the settings file');
      assert.deepEqual(calls(sb), [], 'no catalog read');
    });
  }
});

describe('the catalog read carries no API key or base URL and runs no model — spec:bridge-settings/S8', () => {
  it('each CLI is called once with its catalog argv and a cleared environment', async () => {
    const sb = sandbox();
    const secrets = { OPENAI_API_KEY: 's1', CODEX_API_KEY: 's2', GEMINI_API_KEY: 's3', FOO_API_KEY: 's4', OPENAI_BASE_URL: 'http://evil' };
    assert.equal((await main([], sb.ctx(secrets))).code, 0);
    const log = calls(sb);
    assert.deepEqual(log.map((c) => [c.cli, c.argv]).sort(), [['agy', ['models']], ['codex', ['debug', 'models', '-c', 'model_provider=openai']]]);
    for (const c of log) assert.deepEqual(Object.keys(c.env).filter((k) => /_API_KEY$/.test(k) || (c.cli === 'codex' && k === 'OPENAI_BASE_URL')), [], c.cli);
  });
  it('catalogEnv drops every *_API_KEY, and OPENAI_BASE_URL for codex only', () => {
    const env = { PATH: '/b', X_API_KEY: '1', OPENAI_BASE_URL: 'u', KEEP: 'k' };
    assert.deepEqual(leaf('catalogEnv')('codex-cli-bridge', env), { PATH: '/b', KEEP: 'k' });
    assert.deepEqual(leaf('catalogEnv')('antigravity-cli-bridge', env), { PATH: '/b', OPENAI_BASE_URL: 'u', KEEP: 'k' });
  });
});

describe('the shipped text names each default and the command — spec:bridge-settings/S10', () => {
  const DEFAULTS = ['gpt-6.1-sol', 'Gemini 3.8 Flash (High)'];
  const MODEL_RE = /\bgpt-\d[\w.-]*|\bcodex-mini[\w.-]*|\bGemini \d+(?:\.\d+)? (?:Flash|Pro)(?: \((?:Low|Medium|High)\))?|\bClaude (?:Sonnet|Opus|Haiku) \d+(?:\.\d+)?(?: \(Thinking\))?|\bGPT-OSS \d+B(?: \(\w+\))?/g;
  const NAMING = ['codex-cli-bridge/SKILL.md', 'codex-cli-bridge/references/driving-codex.md', 'codex-cli-bridge/references/sandbox-and-flags.md',
    'antigravity-cli-bridge/SKILL.md', 'antigravity-cli-bridge/references/driving-agy.md', 'antigravity-cli-bridge/references/models-and-flags.md',
    ...WRAPPERS, 'agent-workflow-kit/README.md', 'agent-workflow-kit/references/modes/bridge-settings.md'];
  for (const rel of [...NAMING, 'codex-cli-bridge/capability.json', 'antigravity-cli-bridge/capability.json']) {
    it(`${rel} lists no vendor model beyond the defaults`, () => {
      const extra = [...readFileSync(join(REPO, rel), 'utf8').matchAll(MODEL_RE)].map((m) => m[0]).filter((m) => !DEFAULTS.includes(m));
      assert.deepEqual([...new Set(extra)], []);
    });
  }
  for (const rel of NAMING) {
    it(`${rel} names /agent-workflow-kit bridge-settings`, () => {
      assert.ok(readFileSync(join(REPO, rel), 'utf8').includes('/agent-workflow-kit bridge-settings'));
    });
    it(`${rel} never calls a model key unsettable`, () => {
      assert.doesNotMatch(readFileSync(join(REPO, rel), 'utf8'), /\bnot\b\** (?:file-)?settable|never settable/i);
    });
  }
});

describe('the recipes quota note gives no per-call cheapest-model advice — spec:bridge-settings/S11', () => {
  for (const rel of ['agent-workflow-kit/tools/recipes.mjs', 'agent-workflow-kit/references/modes/recipes.md']) {
    it(rel, () => assert.doesNotMatch(readFileSync(join(REPO, rel), 'utf8'), /cheapest[ -]model|top-tier model/i));
  }
});

describe('the upgrade survival check reports the model keys current — spec:bridge-settings/S12', () => {
  it('--reconcile over the three keys', async () => {
    const sb = sandbox({ settings: 'CODEX_MODEL=gpt-6-luna\nCODEX_EFFORT=low\nAGY_MODEL=Astra Two (Low)\n' });
    const r = await main(['--reconcile'], sb.ctx());
    assert.equal(r.stdout, '  bridge-settings: 3 key(s) recognized, all current');
    assert.deepEqual(calls(sb), [], 'reconcile reads no catalog');
  });
  it('the host survey still emits no model field with a model key set', () => {
    const sb = sandbox({ settings: 'CODEX_MODEL=gpt-6-luna\n' });
    const bridges = surveyBridges({ ...sb.ctx(), detect: () => [], findOnPath: (cmd) => ({ bin: cmd, state: 'missing', path: null }) });
    assert.ok(!/"model"/i.test(JSON.stringify(bridges)));
  });
});

describe('--json is one document for each catalog state — spec:bridge-settings/S13', () => {
  it('offered, unreadable and not-installed', async () => {
    const out = JSON.parse((await main(['--json'], sandbox({ agy: 'fail' }).ctx())).stdout);
    const codex = bridgeOf(out, 'codex-cli-bridge');
    assert.deepEqual([codex.model.value, codex.model.source, codex.effort.value, codex.effort.source], ['gpt-6.1-sol', 'default', 'high', 'default']);
    assert.deepEqual(codex.catalog, { state: 'offered', cause: null, entries: [{ model: 'gpt-6.1-sol', efforts: ['low', 'medium', 'high'] }, { model: 'gpt-6-luna', efforts: ['low', 'medium'] }] });
    assert.deepEqual(bridgeOf(out, 'antigravity-cli-bridge').catalog, { state: 'unreadable', cause: 'agy models exited 3', entries: [] });
    const none = JSON.parse((await main(['--json'], sandbox({ codex: 'absent' }).ctx())).stdout);
    assert.deepEqual(bridgeOf(none, 'codex-cli-bridge').catalog, { state: 'not-installed', cause: 'codex is not on PATH', entries: [] });
    assert.deepEqual(bridgeOf(none, 'antigravity-cli-bridge').catalog.entries, [{ model: 'Gemini 3.8 Flash (High)' }, { model: 'Astra Two (Low)' }]);
  });
});

describe('a set reads only that bridge catalog — spec:bridge-settings/S14', () => {
  it('AGY_MODEL spawns no codex; a codex key spawns no agy', async () => {
    const a = sandbox();
    assert.equal((await main(['--set', 'AGY_MODEL=Astra Two (Low)'], a.ctx())).code, 0);
    assert.deepEqual(calls(a).map((c) => c.cli), ['agy']);
    const c = sandbox();
    assert.equal((await main(['--set', 'CODEX_EFFORT=low'], c.ctx())).code, 0);
    assert.deepEqual(calls(c).map((x) => x.cli), ['codex']);
  });
});
