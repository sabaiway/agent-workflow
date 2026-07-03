// active-recipe-line.test.mjs — the discovery line (AD-038): composeActiveRecipeLine renders the
// CONFIGURED recipe per activity/slot from the per-project orchestration config + live readiness —
// never the readiness recommendation. Non-vacuity fixture: a config that says council while the
// environment would recommend reviewed — the line MUST say council (it derives from the config), and
// its degradation must be stated. Solo renders honestly; the whole render is exactly one line.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { composeActiveRecipeLine, recommendRecipe } from '../tools/recipes.mjs';
import { READY, NEEDS_CREDENTIALS, NEEDS_SKILL } from '../tools/detect-backends.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'tools', 'recipes.mjs');

const CODEX = 'codex-cli-bridge';
const AGY = 'antigravity-cli-bridge';

const detect = (codexReadiness, agyReadiness) => [
  { name: CODEX, readiness: codexReadiness },
  { name: AGY, readiness: agyReadiness },
];

const COUNCIL_CONFIG = {
  'plan-authoring': { review: 'council' },
  'plan-execution': { execute: 'solo', review: 'council' },
};

describe('composeActiveRecipeLine — derives from the CONFIG, never the recommendation', () => {
  it('renders the configured council even where the environment recommends reviewed (non-vacuity)', () => {
    // One ready reviewer → recommendRecipe says "reviewed"; the config says council. The line must
    // carry council (labeled configured) — proving it reads the config, not the recommendation.
    const det = detect(READY, NEEDS_CREDENTIALS);
    assert.equal(recommendRecipe(det).recipe, 'reviewed', 'fixture precondition: recommendation ≠ configured');
    const line = composeActiveRecipeLine({ config: COUNCIL_CONFIG, source: 'docs/ai/orchestration.json' }, det);
    assert.match(line, /plan-execution\.review = council \(configured/);
    assert.match(line, /plan-authoring\.review = council \(configured/);
    assert.match(line, /readiness-recommended here: reviewed \(informational\)/);
    assert.match(line, /the configured recipes above are what runs/);
    assert.match(line, /from docs\/ai\/orchestration\.json/);
  });

  it('states degradation per slot (configured council, one ready reviewer → degrades to reviewed, reason named)', () => {
    const det = detect(READY, NEEDS_CREDENTIALS);
    const line = composeActiveRecipeLine({ config: COUNCIL_CONFIG, source: 'docs/ai/orchestration.json' }, det);
    assert.match(line, /plan-execution\.review = council \(configured; degrades here to reviewed — /);
    assert.match(line, /not signed in|credentials missing/);
  });

  it('renders the dispatched wrapper set — council with both ready names every backend every round', () => {
    const det = detect(READY, READY);
    const line = composeActiveRecipeLine({ config: COUNCIL_CONFIG, source: 'docs/ai/orchestration.json' }, det);
    assert.match(line, /plan-execution\.review = council \(configured\) → every backend every round: codex-review \+ agy-review/);
  });

  it('solo renders honestly (no wrapper suffix, its source labeled)', () => {
    const det = detect(READY, READY);
    const line = composeActiveRecipeLine({ config: COUNCIL_CONFIG, source: 'docs/ai/orchestration.json' }, det);
    assert.match(line, /plan-execution\.execute = solo \(configured\)(?! →)/);
  });

  it('a config-silent slot renders its computed default, labeled as such', () => {
    const det = detect(READY, READY);
    const line = composeActiveRecipeLine(
      { config: { 'plan-execution': { review: 'council' } }, source: 'docs/ai/orchestration.json' },
      det,
    );
    assert.match(line, /plan-authoring\.review = reviewed \(computed default\)/);
    assert.match(line, /plan-execution\.execute = solo \(computed default\)/);
  });

  it('no config file → says so and renders the computed defaults', () => {
    const line = composeActiveRecipeLine({ config: null, source: 'none' }, detect(NEEDS_SKILL, NEEDS_SKILL));
    assert.match(line, /no config file — computed defaults apply/);
    assert.match(line, /plan-execution\.review = solo \(computed default\)/);
  });

  it('is exactly one line for every readiness mix (no part may inject a newline)', () => {
    for (const det of [detect(READY, READY), detect(READY, NEEDS_CREDENTIALS), detect(NEEDS_SKILL, NEEDS_SKILL)]) {
      const line = composeActiveRecipeLine({ config: COUNCIL_CONFIG, source: 'docs/ai/orchestration.json' }, det);
      assert.ok(!line.includes('\n'), 'exactly one line');
    }
  });
});

describe('recipes.mjs CLI — --active-line', () => {
  const withFixtureRepo = (configBody, fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'active-line-'));
    try {
      if (configBody != null) {
        mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
        writeFileSync(join(dir, 'docs', 'ai', 'orchestration.json'), configBody);
      }
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('prints exactly one line, derived from the cwd orchestration.json (configured council survives an all-not-ready env)', () => {
    withFixtureRepo(JSON.stringify(COUNCIL_CONFIG), (dir) => {
      const out = execFileSync(process.execPath, [SCRIPT, '--active-line'], {
        encoding: 'utf8',
        cwd: dir,
        env: { ...process.env, PATH: '' },
      });
      assert.ok(out.endsWith('\n'), 'ends with the single trailing newline');
      const line = out.slice(0, -1);
      assert.ok(!line.includes('\n'), 'exactly one line');
      assert.match(line, /plan-execution\.review = council \(configured; degrades here to solo — /);
      assert.match(line, /^active recipes \(from docs\/ai\/orchestration\.json\): /);
    });
  });

  it('no config file → the computed-defaults line (never an error)', () => {
    withFixtureRepo(null, (dir) => {
      const out = execFileSync(process.execPath, [SCRIPT, '--active-line'], {
        encoding: 'utf8',
        cwd: dir,
        env: { ...process.env, PATH: '' },
      });
      assert.match(out, /^active recipes \(no config file — computed defaults apply\): /);
    });
  });

  it('malformed config → loud exit 1, never a silent fallback line', () => {
    withFixtureRepo('{ not json', (dir) => {
      const r = spawnSync(process.execPath, [SCRIPT, '--active-line'], {
        encoding: 'utf8',
        cwd: dir,
        env: { ...process.env, PATH: '' },
      });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /malformed JSON/);
      assert.equal(r.stdout, '');
    });
  });

  it('rejects --active-line together with --json / --status-line (each owns stdout whole)', () => {
    for (const other of ['--json', '--status-line']) {
      const r = spawnSync(process.execPath, [SCRIPT, other, '--active-line'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: '' },
      });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /mutually exclusive/);
    }
  });

  it('--help mentions the --active-line mode', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
    assert.match(out, /--active-line/);
  });
});
