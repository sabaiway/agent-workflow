import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeSandbox, farmFor, readReceipts, FED_CAP, seedFedChangeSet } from './agy-review-harness.test.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, '..');
const REVIEW = join(HERE, 'agy-review.sh');
const AGY_RUN = join(HERE, 'agy.sh');
const MANIFEST = JSON.parse(readFileSync(join(BRIDGE, 'capability.json'), 'utf8'));
const REAL_TIMEOUT = spawnSync('bash', ['-c', 'type -P timeout'], { encoding: 'utf8' }).stdout.trim();
const ESC = String.fromCharCode(27);
const DEFAULT = 'Gemini 3.8 Flash (High)';
const SET = 'Claude Opus 4.6 (Thinking)';
const SECOND = 'Gemini 3.7 Flash (Low)';
const FACTS = ['code', '--facts', 'a verified fact'];

const FAKE_TIMEOUT = [
  '#!/usr/bin/env bash',
  'if [[ " $* " == *" agy models "* ]]; then',
  '  while [[ $# -gt 0 && "$1" != "agy" ]]; do shift; done',
  `  exec "${REAL_TIMEOUT}" 1 "$@"`,
  'fi',
  `exec "${REAL_TIMEOUT}" "$@"`,
  '',
].join('\n');

const catalogOf = (...displays) => displays.map((display, index) => `id-${index}\t${display}\n`).join('');

const sandbox = ({ settings, fakeTimeout = false } = {}) => {
  const sb = makeSandbox();
  sb.settingsFile = join(sb.home, '.config', 'agent-workflow', 'bridge-settings.conf');
  if (settings !== undefined) {
    mkdirSync(dirname(sb.settingsFile), { recursive: true });
    writeFileSync(sb.settingsFile, settings);
  }
  if (fakeTimeout) writeFileSync(join(sb.bin, 'timeout'), FAKE_TIMEOUT, { mode: 0o755 });
  writeFileSync(join(sb.repo, 'plan.md'), '# a plan under review\n');
  writeFileSync(join(sb.repo, 'change.diff'), '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n');
  return sb;
};

let sequence = 0;
const drive = (sb, args, env = {}, wrapper = REVIEW) => {
  const tag = join(sb.home, `posture-${++sequence}`);
  const r = spawnSync('bash', [wrapper, ...args], {
    cwd: sb.repo, input: '', encoding: 'utf8', timeout: 60000,
    env: {
      HOME: sb.home, PATH: `${sb.bin}:${farmFor(['agy', 'agy-run'])}`, TMPDIR: process.env.TMPDIR ?? '/tmp',
      AGY_FAKE_MODELS_LOG: `${tag}-models`, AGY_FAKE_SENTINEL: `${tag}-sentinel`, AGY_FAKE_ARGV: `${tag}-argv`,
      AGY_FAKE_PROMPT: `${tag}-prompt`, AGY_FAKE_TURNS: `${tag}-turns`, ...env,
    },
  });
  const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
  const modelsLog = read(`${tag}-models`);
  return {
    status: r.status, stderr: r.stderr, invoked: existsSync(`${tag}-sentinel`), argv: read(`${tag}-argv`),
    turns: Number(read(`${tag}-turns`) || 0), modelsLog, modelsCalls: modelsLog.split('\n').filter(Boolean).length,
  };
};
const runDirect = (sb, env = {}, extra = []) => drive(sb, ['a probe prompt', ...extra], env, AGY_RUN);

const quote = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const remedyRe = (sb, model) => (model === ''
  ? /remedy: unset AGY_MODEL in the environment/
  : new RegExp(`remedy: set this line in ${quote(sb.settingsFile)}:\\s+AGY_MODEL=${quote(model)}\\s+and unset AGY_MODEL in the environment`));
const bannerOf = (stderr) => stderr.split('\n').find((line) => line.startsWith('review posture: ')) ?? '';
const modelArg = (r) => (r.argv.match(/(?:^|\n)--model\n(.*)\n/) ?? [])[1] ?? null;
const assertRan = (r, model) => {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.invoked, true, 'the CLI ran');
  assert.equal(modelArg(r), model, r.argv);
};
const assertRefusedUnspent = (r) => {
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.invoked, false, 'refused before any run is spent');
};

const PARENTS = {
  'review.code': FACTS,
  'review.plan': ['plan', 'plan.md'],
  'review.diff': ['diff', 'change.diff'],
  'review.continue': ['--continue'],
  'review.conversation': ['--conversation', 'conv-1'],
};

describe('agy runs the host posture on both wrappers, with no advisory', () => {
  it('agy-review runs the set model without a probe flag; the banner names source setting', () => {
    const r = drive(sandbox({ settings: `AGY_MODEL=${SET}\n` }), FACTS);
    assertRan(r, SET);
    assert.equal(bannerOf(r.stderr), `review posture: model=${SET} source=model:setting timeout=30m`);
    assert.doesNotMatch(r.stderr, /unknown key|frontier/i);
  });
  it('agy-run runs the set model and prints no posture banner', () => {
    const r = runDirect(sandbox({ settings: `AGY_MODEL=${SET}\n` }));
    assertRan(r, SET);
    assert.doesNotMatch(r.stderr, /posture/);
  });
  for (const [label, settings, env, model] of [
    ['the setting restated in the env', `AGY_MODEL=${SET}\n`, { AGY_MODEL: SET }, SET],
    ['env Gemini 3.8 Flash (High) on a fresh host', undefined, { AGY_MODEL: DEFAULT }, DEFAULT],
  ]) {
    it(`${label} is no one-off: agy-review runs it, source environment`, () => {
      const r = drive(sandbox({ settings }), FACTS, env);
      assertRan(r, model);
      assert.equal(bannerOf(r.stderr), `review posture: model=${model} source=model:environment timeout=30m`);
    });
  }
});

describe('an agy one-off is refused pre-spend unless AGY_PROBE=1 — spec:bridge-model/S5', () => {
  it('the probe hook names exactly the parents driven here', () => {
    const hook = MANIFEST.modeCatalog.find((mode) => mode.key === 'AGY_PROBE');
    assert.deepEqual([...hook.parents].sort(), Object.keys(PARENTS).sort());
  });
  const forms = [['env Gemini 3.8 Flash (High)', DEFAULT], ['a second offered non-default model', SECOND], ['an explicitly empty AGY_MODEL=', '']];
  for (const [label, model] of forms) {
    for (const [parent, args] of Object.entries(PARENTS)) {
      it(`${label} on ${parent}: refused with the remedy, run under AGY_PROBE=1`, () => {
        const refusedSb = sandbox({ settings: `AGY_MODEL=${SET}\n` });
        const refused = drive(refusedSb, args, { AGY_MODEL: model });
        assertRefusedUnspent(refused);
        assert.match(refused.stderr, /is a one-off/);
        assert.match(refused.stderr, remedyRe(refusedSb, model));
        const probed = drive(sandbox({ settings: `AGY_MODEL=${SET}\n` }), args, { AGY_MODEL: model, AGY_PROBE: '1' });
        assertRan(probed, model === '' ? null : model);
      });
    }
    it(`${label}: agy-run, the probe role, runs it`, () => {
      assertRan(runDirect(sandbox({ settings: `AGY_MODEL=${SET}\n` }), { AGY_MODEL: model }), model === '' ? null : model);
    });
  }
});

describe('agy-run refuses a model or effort flag after -- on the host posture', () => {
  for (const flag of [['--model', SET], [`--model=${SET}`], ['--effort', 'high'], ['--effort=low']]) {
    it(`refuses ${flag[0]}`, () => {
      const r = runDirect(sandbox(), {}, ['--', ...flag]);
      assertRefusedUnspent(r);
      assert.match(r.stderr, /is not allowed/);
    });
  }
});

describe('an agy model the catalog does not offer is refused with the offered list', () => {
  const laterDefault = catalogOf(SECOND, DEFAULT);
  for (const [label, settings, env] of [['the setting', 'AGY_MODEL=Gemini 9 Ultra\n', {}], ['the environment', undefined, { AGY_MODEL: 'Gemini 9 Ultra', AGY_PROBE: '1' }]]) {
    for (const [wrapper, args] of [[REVIEW, FACTS], [AGY_RUN, ['a probe prompt']]]) {
      it(`a model from ${label} on ${wrapper === REVIEW ? 'agy-review' : 'agy-run'}: the default offered on a later line is set`, () => {
        const sb = sandbox({ settings });
        const r = drive(sb, args, { AGY_FAKE_MODELS: laterDefault, ...env }, wrapper);
        assertRefusedUnspent(r);
        assert.match(r.stderr, /AGY_MODEL='Gemini 9 Ultra' .*not a model the installed agy offers/);
        assert.ok(r.stderr.includes(`offered: ${SECOND}, ${DEFAULT}`), r.stderr);
        assert.match(r.stderr, remedyRe(sb, DEFAULT));
      });
    }
  }
  it('the default itself is refused when not offered; the remedy names the first offered line', () => {
    const sb = sandbox();
    const r = drive(sb, FACTS, { AGY_FAKE_MODELS: `Fetching...\n${catalogOf(SET, SECOND)}` });
    assertRefusedUnspent(r);
    assert.match(r.stderr, new RegExp(`AGY_MODEL='${quote(DEFAULT)}' \\(default\\)`));
    assert.match(r.stderr, remedyRe(sb, SET));
  });
});

describe('an unreadable agy catalog is one stderr line, one read, and the run proceeds', () => {
  const unreadable = [
    ['a failing read', {}, { AGY_FAKE_MODELS_STATUS: '1' }],
    ['a timed-out read', { fakeTimeout: true }, { AGY_FAKE_MODELS_SLEEP: '5' }],
    ['output without a TAB line', {}, { AGY_FAKE_MODELS: 'Fetching available models...\nno model here\n' }],
    ['an empty output', {}, { AGY_FAKE_MODELS: '' }],
  ];
  for (const [label, options, env] of unreadable) {
    for (const [wrapper, args] of [[REVIEW, FACTS], [AGY_RUN, ['a probe prompt']]]) {
      it(`${label} on ${wrapper === REVIEW ? 'agy-review' : 'agy-run'}`, () => {
        const r = drive(sandbox(options), args, env, wrapper);
        assertRan(r, DEFAULT);
        assert.equal(r.modelsCalls, 1);
        assert.equal(r.stderr.split('\n').filter((line) => /catalog/.test(line)).length, 1, r.stderr);
        assert.match(r.stderr, /^warning: the agy model catalog is unreadable \(.+\) — the run proceeds/m);
      });
    }
  }
  it('agy-review calls agy models without any of the caller\'s *_API_KEY values', () => {
    const r = drive(sandbox(), FACTS, { FOO_API_KEY: 'foo-key', ANTIGRAVITY_API_KEY: 'agy-key' });
    assertRan(r, DEFAULT);
    assert.equal(r.modelsLog, 'models unset unset\n');
  });
});

describe('agy-review reads the catalog once and its children skip the read — spec:bridge-model/S12', () => {
  for (const [label, env] of [['a readable catalog', {}], ['a failing catalog read', { AGY_FAKE_MODELS_STATUS: '1' }]]) {
    it(`a fed review over ${label} makes exactly one agy models call`, () => {
      const sb = sandbox();
      seedFedChangeSet(sb);
      const r = drive(sb, FACTS, { AGY_MAX_PROMPT_BYTES: String(FED_CAP), ...env });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.turns > 1, 'the change set was fed over several agy-run turns');
      assert.equal(r.modelsCalls, 1);
    });
  }
});

describe('an explicitly empty AGY_MODEL reads no catalog and drops --model — spec:bridge-model/S13', () => {
  it('a probe agy-review runs without --model, records model null, and makes no agy models call', () => {
    const sb = sandbox({ settings: `AGY_MODEL=${SET}\n` });
    const r = drive(sb, FACTS, { AGY_MODEL: '', AGY_PROBE: '1' });
    assertRan(r, null);
    assert.equal(r.modelsCalls, 0);
    assert.equal(bannerOf(r.stderr), 'review posture: model=<agy settings default> source=model:environment timeout=30m');
    assert.deepEqual(readReceipts(sb.repo).at(-1).posture, { model: null });
  });
  it('a direct agy-run runs without --model and makes no agy models call', () => {
    const r = runDirect(sandbox(), { AGY_MODEL: '' });
    assertRan(r, null);
    assert.equal(r.modelsCalls, 0);
  });
});

describe('no frontier list and no off-frontier warning for any offered model — spec:bridge-model/S14', () => {
  it('agy-review.sh carries no frontier list', () => {
    assert.doesNotMatch(readFileSync(REVIEW, 'utf8'), /frontier/i);
  });
  for (const model of [SECOND, SET]) {
    it(`a host posture of ${model} reviews without a warning`, () => {
      const r = drive(sandbox({ settings: `AGY_MODEL=${model}\n` }), FACTS);
      assertRan(r, model);
      assert.doesNotMatch(r.stderr, /warning/i);
    });
  }
});

describe('the shipped agy text names no 3.5 Flash model or family — spec:bridge-model/S15', () => {
  for (const rel of ['SKILL.md', 'references/models-and-flags.md', 'references/driving-agy.md', 'bin/agy.sh']) {
    it(rel, () => {
      assert.doesNotMatch(readFileSync(join(BRIDGE, rel), 'utf8'), /3[ ._-]?5[\s_-]*flash|flash[\s_-]*3[ ._-]?5/i);
    });
  }
});

describe('a settings-file AGY_MODEL with a control byte or an empty value falls back to the default', () => {
  for (const [label, settings] of [['a control byte', `AGY_MODEL=${SET}${ESC}[0m\n`], ['an empty value', 'AGY_MODEL=\n']]) {
    for (const [wrapper, args] of [[REVIEW, FACTS], [AGY_RUN, ['a probe prompt']]]) {
      it(`${label} on ${wrapper === REVIEW ? 'agy-review' : 'agy-run'} warns without the raw byte`, () => {
        const r = drive(sandbox({ settings }), args, {}, wrapper);
        assertRan(r, DEFAULT);
        assert.equal(r.stderr.includes(ESC), false, 'no raw control byte reaches stderr');
        assert.match(r.stderr, /warning: AGY_MODEL in bridge settings file .* built-in default/);
      });
    }
  }
});
