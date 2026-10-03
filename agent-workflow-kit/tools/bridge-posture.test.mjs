// bridge-posture.test.mjs — the posture render tells the truth (spec bridge-settings, S9): a model or
// effort the settings file or the environment sets replaces the manifest default and names its source,
// an explicitly empty AGY_MODEL renders as no model, and the render reads only the file and the
// environment — it runs no catalog command.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { posturesByBackend } from './bridge-posture.mjs';
import { settingsSnapshot } from './bridge-settings-read.mjs';
import { composeConfiguredPosture } from './recipes.mjs';

let tmp;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'awf-bp-')); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const snapshot = (body, env = {}) => {
  if (body !== undefined) {
    mkdirSync(join(tmp, 'agent-workflow'), { recursive: true });
    writeFileSync(join(tmp, 'agent-workflow', 'bridge-settings.conf'), body);
  }
  return settingsSnapshot({ getenv: { XDG_CONFIG_HOME: tmp, ...env }, home: tmp });
};
const rendered = (settings) => Object.fromEntries(Object.entries(posturesByBackend({ settings })).map(([id, row]) => [id, row.posture]));

describe('the posture render overlays a set model and effort — spec:bridge-settings/S9', () => {
  it('nothing set: the manifest defaults, unchanged', () => {
    assert.deepEqual(rendered(snapshot()), { codex: 'model=gpt-6.1-sol effort=high tier=standard', agy: 'model=Gemini 3.8 Flash (High)' });
  });

  it('a file model and effort name setting', () => {
    const rows = rendered(snapshot('CODEX_MODEL=gpt-6-luna\nCODEX_EFFORT=low\nAGY_MODEL=Astra Two (Low)\n'));
    assert.equal(rows.codex, 'model=gpt-6-luna (setting) effort=low (setting) tier=standard');
    assert.equal(rows.agy, 'model=Astra Two (Low) (setting)');
  });

  it('an environment value names environment and wins over the file', () => {
    const rows = rendered(snapshot('CODEX_MODEL=gpt-6-luna\n', { CODEX_MODEL: 'gpt-6-astra', AGY_MODEL: 'Astra Two (Low)' }));
    assert.equal(rows.codex, 'model=gpt-6-astra (environment) effort=high tier=standard');
    assert.equal(rows.agy, 'model=Astra Two (Low) (environment)');
  });

  it('an effort set alone overlays the effort only', () => {
    assert.equal(rendered(snapshot(undefined, { CODEX_EFFORT: 'low' })).codex, 'model=gpt-6.1-sol effort=low (environment) tier=standard');
  });

  it('an explicitly empty AGY_MODEL renders as no model', () => {
    assert.equal(rendered(snapshot(undefined, { AGY_MODEL: '' })).agy, 'model=none (environment)');
  });

  it('the tier overlay still names bridge-settings beside a model overlay', () => {
    assert.equal(rendered(snapshot('CODEX_MODEL=gpt-6-luna\nCODEX_SERVICE_TIER=priority\n')).codex,
      'model=gpt-6-luna (setting) effort=high tier=priority (bridge-settings)');
  });

  it('the recipes and status-line render composes the overlay', () => {
    assert.equal(composeConfiguredPosture({ settings: snapshot('CODEX_EFFORT=medium\n') }),
      'codex model=gpt-6.1-sol effort=medium (setting) tier=standard · agy model=Gemini 3.8 Flash (High)');
  });

  it('the render runs no catalog command', () => {
    const bin = join(tmp, 'bin');
    const log = join(tmp, 'calls.log');
    mkdirSync(bin);
    for (const cli of ['codex', 'agy']) writeFileSync(join(bin, cli), `#!/bin/sh\necho ${cli} >>"${log}"\n`, { mode: 0o755 });
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    try {
      const settings = snapshot('CODEX_MODEL=gpt-6-luna\n', { PATH: process.env.PATH });
      rendered(settings);
      composeConfiguredPosture({ settings });
    } finally {
      process.env.PATH = saved;
    }
    assert.equal(existsSync(log), false, 'no codex or agy was run');
  });
});
