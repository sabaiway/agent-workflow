import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, cpSync, readdirSync, symlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXEC = join(HERE, 'codex-exec.sh');
const REVIEW = join(HERE, 'codex-review.sh');
const MANIFEST = JSON.parse(readFileSync(join(HERE, '..', 'capability.json'), 'utf8'));
const REAL_TIMEOUT = spawnSync('bash', ['-c', 'type -P timeout'], { encoding: 'utf8' }).stdout.trim();
const ESC = String.fromCharCode(27);

const FAKE_CODEX = [
  '#!/usr/bin/env bash',
  'set -u',
  'if [[ "${1:-}" == "login" ]]; then echo "Logged in using ChatGPT"; exit 0; fi',
  'if [[ "${1:-}" == "--version" ]]; then echo "codex-cli ${CODEX_FAKE_VERSION:-0.160.0}"; exit 0; fi',
  'if [[ "${1:-}" == "debug" ]]; then',
  '  echo "catalog argv=[$*] home=${CODEX_HOME:-} keys=${OPENAI_API_KEY:-unset},${FOO_API_KEY:-unset},${OPENAI_BASE_URL:-unset}" >>"$CODEX_FAKE_LOG"',
  '  if [[ -n "${CODEX_FAKE_CATALOG_SLEEP:-}" ]]; then sleep "$CODEX_FAKE_CATALOG_SLEEP"; fi',
  '  if [[ -n "${CODEX_FAKE_CATALOG_EXIT:-}" ]]; then exit "$CODEX_FAKE_CATALOG_EXIT"; fi',
  '  if grep -q model_provider "${CODEX_HOME:-$HOME/.codex}/config.toml" 2>/dev/null && [[ "$*" != *model_provider=openai* ]]; then',
  '    cat "$CODEX_FAKE_USER_CATALOG"; exit 0',
  '  fi',
  '  cat "$CODEX_FAKE_CATALOG"; exit 0',
  'fi',
  'echo "run argv=[$*]" >>"$CODEX_FAKE_LOG"',
  'cat >/dev/null',
  'out=""; prev=""',
  'for a in "$@"; do if [[ "$prev" == "-o" ]]; then out="$a"; fi; prev="$a"; done',
  'if [[ -n "$out" ]]; then printf "fake answer\\nVerdict: ship\\n" >"$out"; fi',
  'echo "{\\"type\\":\\"thread.started\\",\\"thread_id\\":\\"sess-fake\\"}"',
  '',
].join('\n');

const FAKE_UNAME = `#!/usr/bin/env bash\nif [[ $# -eq 0 || "$1" == "-s" ]]; then echo Linux; exit 0; fi\nexec "${spawnSync('bash', ['-c', 'type -P uname'], { encoding: 'utf8' }).stdout.trim()}" "$@"\n`;
const FAKE_TIMEOUT = [
  '#!/usr/bin/env bash',
  'if [[ " $* " == *" debug models "* ]]; then',
  '  while [[ $# -gt 0 && "$1" != "codex" ]]; do shift; done',
  `  exec "${REAL_TIMEOUT}" 1 "$@"`,
  'fi',
  `exec "${REAL_TIMEOUT}" "$@"`,
  '',
].join('\n');

const entry = (slug, priority, efforts, level = 'medium', visibility = 'list') => ({
  slug, priority, visibility, default_reasoning_level: level, supported_reasoning_levels: efforts.map((effort) => ({ effort })),
});
const ALL = ['low', 'medium', 'high', 'xhigh'];
const STANDARD = { models: [entry('gpt-6.1-sol', 1, ALL, 'low'), entry('gpt-6-astra', 2, ALL), entry('gpt-6-luna', 3, ['low', 'medium', 'high'])] };
const HOST_SETTING = 'CODEX_MODEL=gpt-6-luna\nCODEX_EFFORT=medium\n';

// The repositories sit outside every temp root (spec jev-every-run): under node_modules, TMPDIR their sibling.
const FIXTURES = join(HERE, '..', 'node_modules', '.aw-fixtures');
for (const dir of ['repos', 'tmp']) mkdirSync(join(FIXTURES, dir), { recursive: true });
const SHARED = mkdtempSync(join(FIXTURES, 'repos', 'codex-posture-'));
after(() => rmSync(SHARED, { recursive: true, force: true }));
const TEMPLATE = (() => {
  const home = join(SHARED, 'template');
  const repo = join(home, 'repo');
  mkdirSync(join(home, 'bin'), { recursive: true });
  mkdirSync(repo);
  writeFileSync(join(home, 'bin', 'codex'), FAKE_CODEX, { mode: 0o755 });
  writeFileSync(join(home, 'bin', 'uname'), FAKE_UNAME, { mode: 0o755 });
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'probe@example.com');
  git('config', 'user.name', 'probe');
  writeFileSync(join(repo, 'AGENTS.md'), '# AGENTS\n\nHard Constraints: none (test fixture).\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  writeFileSync(join(repo, 'plan.md'), '# a plan under review\n');
  return home;
})();

let sequence = 0;
const sandbox = ({ settings, catalog = STANDARD, catalogText, userCatalog, fakeTimeout = false } = {}) => {
  const home = join(SHARED, `sb-${++sequence}`);
  cpSync(TEMPLATE, home, { recursive: true });
  const sb = {
    home, repo: join(home, 'repo'), bin: join(home, 'bin'), log: join(home, 'calls.log'),
    catalog: join(home, 'catalog.json'), userCatalog: join(home, 'user-catalog.json'),
    settingsFile: join(home, '.config', 'agent-workflow', 'bridge-settings.conf'),
  };
  writeFileSync(sb.catalog, catalogText ?? JSON.stringify(catalog));
  writeFileSync(sb.userCatalog, JSON.stringify(userCatalog ?? { models: [] }));
  if (settings !== undefined) {
    mkdirSync(dirname(sb.settingsFile), { recursive: true });
    writeFileSync(sb.settingsFile, settings);
  }
  if (fakeTimeout) writeFileSync(join(sb.bin, 'timeout'), FAKE_TIMEOUT, { mode: 0o755 });
  return sb;
};

const drive = (sb, [wrapper, args], env = {}) => {
  const r = spawnSync('bash', [wrapper, ...args], {
    cwd: sb.repo, input: 'do the thing', encoding: 'utf8', timeout: 60000,
    env: {
      PATH: `${sb.bin}:${process.env.PATH}`, HOME: sb.home, TMPDIR: join(FIXTURES, 'tmp'),
      CODEX_FAKE_LOG: sb.log, CODEX_FAKE_CATALOG: sb.catalog, CODEX_FAKE_USER_CATALOG: sb.userCatalog, ...env,
    },
  });
  const log = existsSync(sb.log) ? readFileSync(sb.log, 'utf8') : '';
  return { status: r.status, stderr: r.stderr, log, ran: log.includes('run argv='), runArgv: (log.match(/^run argv=\[(.*)\]$/m) ?? [])[1] ?? '' };
};

const FRESH_EXEC = [EXEC, ['-']];
const PLAN_REVIEW = [REVIEW, ['plan', 'plan.md']];
const PARENTS = {
  exec: () => FRESH_EXEC,
  'exec.resume-last': (sb) => {
    writeFileSync(join(sb.repo, '.codex-last-session'), 'sess-1\n');
    return [EXEC, ['--resume-last', '-']];
  },
  'exec.resume': () => [EXEC, ['--resume', 'sess-1', '-']],
  'review.plan': () => PLAN_REVIEW,
  'review.code': (sb) => {
    writeFileSync(join(sb.repo, 'pending.txt'), 'an uncommitted change\n');
    return [REVIEW, ['code']];
  },
};

const quote = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const remedyRe = (sb, model, effort) => new RegExp(
  `remedy: set these lines in ${quote(sb.settingsFile)}:\\s+CODEX_MODEL=${quote(model)}\\s+CODEX_EFFORT=${quote(effort)}\\s+and unset CODEX_MODEL and CODEX_EFFORT in the environment`);
const bannerOf = (stderr) => stderr.split('\n').find((line) => /^(exec|review) posture: /.test(line)) ?? '';
const assertRan = (r, model, effort) => {
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.runArgv, new RegExp(`(^| )-m ${quote(model)}( |$)`), r.log);
  assert.match(r.runArgv, new RegExp(`model_reasoning_effort=${quote(effort)}( |$)`), r.log);
};
const assertRefusedUnspent = (r) => {
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.ran, false, 'refused before any run is spent');
};

describe('a fresh host runs the built-in default — spec:bridge-model/S1', () => {
  it('codex-exec and codex-review run gpt-6.1-sol at effort high and the banner names source default', () => {
    const exec = drive(sandbox(), FRESH_EXEC);
    assertRan(exec, 'gpt-6.1-sol', 'high');
    assert.equal(bannerOf(exec.stderr), 'exec posture: model=gpt-6.1-sol effort=high tier=standard sandbox=jev-profile session=fresh '
      + 'jev=api.typesafe.ai,docs.typesafe.ai source=model:default,effort:default timeout=3600s');
    const review = drive(sandbox(), PLAN_REVIEW);
    assertRan(review, 'gpt-6.1-sol', 'high');
    assert.equal(bannerOf(review.stderr), 'review posture: model=gpt-6.1-sol effort=high tier=standard jev=api.typesafe.ai,docs.typesafe.ai source=model:default,effort:default timeout=1800s');
  });
  it('a codex-exec fallback run keeps the same model fields, sandbox=workspace-write and jev=unreachable before source=', () => {
    const exec = drive(sandbox(), FRESH_EXEC, { CODEX_FAKE_VERSION: '0.159.0' });
    assertRan(exec, 'gpt-6.1-sol', 'high');
    assert.equal(bannerOf(exec.stderr), 'exec posture: model=gpt-6.1-sol effort=high tier=standard sandbox=workspace-write session=fresh jev=unreachable (codex 0.159.0 below 0.160.0) source=model:default,effort:default timeout=3600s');
  });
});

describe('the setting is the host posture of every codex wrapper — spec:bridge-model/S2', () => {
  for (const [label, parent] of [['codex-exec', FRESH_EXEC], ['codex-review', PLAN_REVIEW]]) {
    it(`${label} runs the set model and effort without a probe flag, the banner naming source setting`, () => {
      const r = drive(sandbox({ settings: HOST_SETTING }), parent);
      assertRan(r, 'gpt-6-luna', 'medium');
      assert.match(bannerOf(r.stderr), / model=gpt-6-luna effort=medium .*source=model:setting,effort:setting timeout=/);
      assert.doesNotMatch(r.stderr, /unknown key/, 'the model keys are recognised beside the registry');
    });
  }
});

describe('an environment value equal to the host posture is no one-off — spec:bridge-model/S3', () => {
  const cases = [
    ['the setting restated in the env', HOST_SETTING, { CODEX_MODEL: 'gpt-6-luna', CODEX_EFFORT: 'medium' }, 'gpt-6-luna', 'medium', 'model:environment,effort:environment'],
    ['env gpt-6.1-sol on a fresh host', undefined, { CODEX_MODEL: 'gpt-6.1-sol' }, 'gpt-6.1-sol', 'high', 'model:environment,effort:default'],
    ['explicitly empty env keys on a fresh host', undefined, { CODEX_MODEL: '', CODEX_EFFORT: '' }, 'gpt-6.1-sol', 'high', 'model:environment,effort:environment'],
  ];
  for (const [label, settings, env, model, effort, source] of cases) {
    for (const parent of [FRESH_EXEC, PLAN_REVIEW]) {
      it(`${label}: ${parent[0] === EXEC ? 'codex-exec' : 'codex-review'} runs without a probe flag, source environment`, () => {
        const r = drive(sandbox({ settings }), parent, env);
        assertRan(r, model, effort);
        assert.match(bannerOf(r.stderr), new RegExp(` source=${source} timeout=`));
      });
    }
  }
});

const ONE_OFFS = [
  ['env gpt-6.1-sol', { CODEX_MODEL: 'gpt-6.1-sol' }, 'gpt-6.1-sol', 'medium'],
  ['env CODEX_EFFORT=high alone', { CODEX_EFFORT: 'high' }, 'gpt-6-luna', 'high'],
  ['an explicitly empty CODEX_MODEL=', { CODEX_MODEL: '' }, 'gpt-6.1-sol', 'medium'],
  ['an explicitly empty CODEX_EFFORT=', { CODEX_EFFORT: '' }, 'gpt-6-luna', 'high'],
];

describe('a one-off is refused pre-spend unless it is a probe — spec:bridge-model/S4', () => {
  it('the probe hook names exactly the parents driven here', () => {
    const hook = MANIFEST.modeCatalog.find((mode) => mode.key === 'CODEX_PROBE');
    assert.deepEqual([...hook.parents].sort(), Object.keys(PARENTS).sort());
  });
  for (const [label, env, model, effort] of ONE_OFFS) {
    for (const [parent, argsOf] of Object.entries(PARENTS)) {
      it(`${label} on ${parent}: refused with the remedy, run under CODEX_PROBE=1`, () => {
        const refusedSb = sandbox({ settings: HOST_SETTING });
        const refused = drive(refusedSb, argsOf(refusedSb), env);
        assertRefusedUnspent(refused);
        assert.match(refused.stderr, /one-off/);
        assert.match(refused.stderr, remedyRe(refusedSb, model, effort));
        const probeSb = sandbox({ settings: HOST_SETTING });
        const probed = drive(probeSb, argsOf(probeSb), { ...env, CODEX_PROBE: '1' });
        assertRan(probed, model, effort);
        assert.match(bannerOf(probed.stderr), / source=model:(environment|setting),effort:(environment|setting) timeout=/);
      });
    }
  }
});

const CONTRACT = '# dispatch\n\n```aw-dispatch-contract\n{"nonce":"n1","scope":"probe"}\n```\n';
describe('a nonced probe one-off is refused; a probe review keeps its nonce — spec:bridge-model/S6', () => {
  const nonced = [
    ['AW_DISPATCH_NONCE', ['task.md'], { AW_DISPATCH_NONCE: 'n1' }],
    ['--nonce', ['--nonce', 'n1', 'task.md'], {}],
    ['--nonce on a resume', ['--resume', 'sess-1', '--nonce', 'n1', 'task.md'], {}],
  ];
  for (const [label, args, env] of nonced) {
    it(`${label}: a probe one-off is refused before any reservation`, () => {
      const sb = sandbox({ settings: HOST_SETTING });
      writeFileSync(join(sb.repo, 'task.md'), CONTRACT);
      const r = drive(sb, [EXEC, args], { ...env, CODEX_PROBE: '1', CODEX_MODEL: 'gpt-6.1-sol' });
      assertRefusedUnspent(r);
      assert.match(r.stderr, /cannot carry a dispatch nonce/);
      assert.equal(existsSync(join(sb.repo, '.git', 'agent-workflow-exec-receipt-5-codex-n1.json')), false);
    });
  }
  it('a nonced probe on the host posture runs and mints its receipt', () => {
    const sb = sandbox({ settings: HOST_SETTING });
    writeFileSync(join(sb.repo, 'task.md'), CONTRACT);
    const r = drive(sb, [EXEC, ['--nonce', 'n1', 'task.md']], { CODEX_PROBE: '1' });
    assertRan(r, 'gpt-6-luna', 'medium');
    const receipt = JSON.parse(readFileSync(join(sb.repo, '.git', 'agent-workflow-exec-receipt-5-codex-n1.json'), 'utf8'));
    assert.deepEqual(receipt.posture, { model: 'gpt-6-luna', effort: 'medium', tier: null });
  });
  it('a probe review one-off keeps its --nonce', () => {
    const r = drive(sandbox({ settings: HOST_SETTING }), [REVIEW, ['plan', 'plan.md', '--nonce', 'n1']], { CODEX_PROBE: '1', CODEX_MODEL: 'gpt-6.1-sol' });
    assertRan(r, 'gpt-6.1-sol', 'medium');
  });
});

describe('a model or effort flag after -- is refused pre-spend — spec:bridge-model/S7', () => {
  for (const flag of [['-m', 'gpt-6-luna'], ['--model=gpt-6-luna'], ['-c', 'model_reasoning_effort=low'], ['--config', 'model=x'], ['-p', 'fast']]) {
    it(`codex-exec refuses ${flag[0]} on the host posture`, () => {
      const r = drive(sandbox(), [EXEC, ['-', '--', ...flag]]);
      assertRefusedUnspent(r);
      assert.match(r.stderr, /is not allowed/);
    });
  }
});

describe('a model the catalog does not offer is refused with the offered list — spec:bridge-model/S8', () => {
  const offered = 'offered: gpt-6.1-sol, gpt-6-astra, gpt-6-luna';
  const sources = [['the setting', { settings: 'CODEX_MODEL=gpt-unknown\n' }, {}], ['the environment', {}, { CODEX_MODEL: 'gpt-unknown' }]];
  for (const [label, options, env] of sources) {
    for (const parent of [FRESH_EXEC, PLAN_REVIEW]) {
      it(`a model from ${label} on ${parent[0] === EXEC ? 'codex-exec' : 'codex-review'}: the built-in default lines, whatever was refused`, () => {
        const sb = sandbox(options);
        const r = drive(sb, parent, env);
        assertRefusedUnspent(r);
        assert.match(r.stderr, /CODEX_MODEL='gpt-unknown' .*not a model the installed codex offers/);
        assert.ok(r.stderr.includes(offered), r.stderr);
        assert.match(r.stderr, remedyRe(sb, 'gpt-6.1-sol', 'high'));
      });
    }
  }
  for (const parent of [FRESH_EXEC, PLAN_REVIEW]) {
    it(`a dash-leading model on ${parent[0] === EXEC ? 'codex-exec' : 'codex-review'} is refused as not offered, never read as a node option`, () => {
      const r = drive(sandbox({ settings: 'CODEX_MODEL=--version\n' }), parent);
      assertRefusedUnspent(r);
      assert.match(r.stderr, /CODEX_MODEL='--version' \(setting\) is not a model the installed codex offers/);
    });
  }
  it('the default is restored even when another offered slug has a smaller priority number', () => {
    const sb = sandbox({ settings: 'CODEX_MODEL=gpt-unknown\n', catalog: { models: [entry('gpt-6-luna', 0, ALL), entry('gpt-6.1-sol', 1, ALL, 'low')] } });
    assert.match(drive(sb, FRESH_EXEC).stderr, remedyRe(sb, 'gpt-6.1-sol', 'high'));
  });
  it('the default itself is refused when not offered; the remedy is the smallest-priority entry whole', () => {
    const sb = sandbox({ catalog: { models: [entry('gpt-6-astra', 5, ALL), entry('gpt-6-luna', 2, ['low', 'medium'], 'low')] } });
    const r = drive(sb, FRESH_EXEC);
    assertRefusedUnspent(r);
    assert.match(r.stderr, /CODEX_MODEL='gpt-6\.1-sol' \(default\)/);
    assert.match(r.stderr, remedyRe(sb, 'gpt-6-luna', 'low'));
  });
  it('on a mixed catalog only visibility=list entries count — a hidden slug is refused and never named', () => {
    const mixed = { models: [entry('gpt-secret', 0, ALL, 'xhigh', 'hide'), entry('gpt-6-luna', 2, ALL), entry('gpt-6.1-sol', 3, ['low', 'medium'], 'low')] };
    const sb = sandbox({ settings: 'CODEX_MODEL=gpt-secret\n', catalog: mixed });
    const r = drive(sb, FRESH_EXEC);
    assertRefusedUnspent(r);
    const afterRefusal = r.stderr.slice(r.stderr.indexOf('offered:'));
    assert.ok(afterRefusal.includes('offered: gpt-6-luna, gpt-6.1-sol'), r.stderr);
    assert.doesNotMatch(afterRefusal, /gpt-secret/);
    assert.match(r.stderr, remedyRe(sb, 'gpt-6-luna', 'medium'));
  });
});

describe('an effort the model does not offer is refused the same way — spec:bridge-model/S9', () => {
  for (const parent of [FRESH_EXEC, PLAN_REVIEW]) {
    it(`${parent[0] === EXEC ? 'codex-exec' : 'codex-review'} names the model's efforts and the built-in default lines`, () => {
      const sb = sandbox({ settings: 'CODEX_MODEL=gpt-6-luna\nCODEX_EFFORT=xhigh\n' });
      const r = drive(sb, parent);
      assertRefusedUnspent(r);
      assert.match(r.stderr, /CODEX_EFFORT='xhigh' \(setting\) is not an effort the installed codex offers for gpt-6-luna/);
      assert.ok(r.stderr.includes('offered: low, medium, high'), r.stderr);
      assert.match(r.stderr, remedyRe(sb, 'gpt-6.1-sol', 'high'));
    });
  }
});

describe('an unreadable catalog is one stderr line and the run proceeds — spec:bridge-model/S10', () => {
  const unreadable = [
    ['a failing read', {}, { CODEX_FAKE_CATALOG_EXIT: '3' }],
    ['a timed-out read', { fakeTimeout: true }, { CODEX_FAKE_CATALOG_SLEEP: '5' }],
    ['output that is not JSON', { catalogText: 'not json at all' }, {}],
    ['JSON without models[]', { catalog: { data: [] } }, {}],
    ['a catalog that offers no model', { catalog: { models: [entry('gpt-6.1-sol', 1, ALL, 'low', 'hide')] } }, {}],
    ['an offered entry without a slug', { catalog: { models: [{ ...entry('', 0, ALL), slug: undefined }, entry('gpt-6-luna', 2, ALL)] } }, {}],
    ['the effective entry without supported_reasoning_levels', { catalog: { models: [{ slug: 'gpt-6.1-sol', priority: 1, visibility: 'list', default_reasoning_level: 'low' }] } }, {}],
  ];
  for (const [label, options, env] of unreadable) {
    for (const parent of [FRESH_EXEC, PLAN_REVIEW]) {
      it(`${label} on ${parent[0] === EXEC ? 'codex-exec' : 'codex-review'}`, () => {
        const r = drive(sandbox(options), parent, env);
        assertRan(r, 'gpt-6.1-sol', 'high');
        assert.equal(r.stderr.split('\n').filter((line) => /catalog/.test(line)).length, 1, r.stderr);
        assert.match(r.stderr, /^warning: the codex model catalog is unreadable \(.+\) — the run proceeds/m);
      });
    }
  }
  it('without a timeout binary the nonce-less codex-exec still reads the catalog, unbounded', () => {
    const sb = sandbox();
    const farm = join(sb.home, 'farm');
    mkdirSync(farm);
    const linked = new Set(['timeout', 'gtimeout']);
    for (const dir of process.env.PATH.split(':').filter(Boolean)) {
      for (const name of existsSync(dir) ? readdirSync(dir) : []) {
        if (!linked.has(name)) symlinkSync(resolve(dir, name), join(farm, name));
        linked.add(name);
      }
    }
    const r = drive(sb, FRESH_EXEC, { PATH: `${sb.bin}:${farm}` });
    assertRan(r, 'gpt-6.1-sol', 'high');
    assert.match(r.log, /^catalog /m);
    assert.match(bannerOf(r.stderr), / timeout=uncapped$/);
  });
});

describe('the catalog read follows the subscription guard and ignores a user config — spec:bridge-model/S11', () => {
  for (const parent of [FRESH_EXEC, PLAN_REVIEW]) {
    it(`${parent[0] === EXEC ? 'codex-exec' : 'codex-review'} reads the run's CODEX_HOME catalog with the built-in provider, keys cleared`, () => {
      const sb = sandbox({ userCatalog: { models: [entry('their-model', 1, ALL)] } });
      const codexHome = join(sb.home, 'codex-home');
      mkdirSync(codexHome);
      writeFileSync(join(codexHome, 'config.toml'), 'model_provider = "their-proxy"\n');
      const r = drive(sb, parent, { CODEX_HOME: codexHome, OPENAI_API_KEY: 'sk-live', FOO_API_KEY: 'foo', OPENAI_BASE_URL: 'http://proxy' });
      assertRan(r, 'gpt-6.1-sol', 'high');
      assert.match(r.log, new RegExp(`^catalog argv=\\[.*\\] home=${quote(codexHome)} keys=unset,unset,unset$`, 'm'));
    });
  }
});

describe('a settings-file model value with a control byte or an empty one falls back — spec:bridge-model/S17', () => {
  const values = [
    ['a control byte', `CODEX_MODEL=gpt-6-luna${ESC}[31m\nCODEX_EFFORT=medium${ESC}\n`],
    ['an empty value', 'CODEX_MODEL=\nCODEX_EFFORT=\n'],
  ];
  for (const [label, settings] of values) {
    it(`${label}: each key warns without the raw byte and the run takes the built-in default`, () => {
      const r = drive(sandbox({ settings }), FRESH_EXEC);
      assertRan(r, 'gpt-6.1-sol', 'high');
      assert.equal(r.stderr.includes(ESC), false, 'no raw control byte reaches stderr');
      assert.match(r.stderr, /warning: CODEX_MODEL in bridge settings file .* built-in default/);
      assert.match(r.stderr, /warning: CODEX_EFFORT in bridge settings file .* built-in default/);
      assert.match(bannerOf(r.stderr), / source=model:default,effort:default timeout=/);
    });
  }
});
