import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isRefusedControlByte } from '../tools/repo-lex.mjs';
import { RUNTIME_RESIDUAL_FORMS, UNIVERSAL_READONLY_ALLOWLIST } from '../tools/velocity-profile.mjs';

describe('the velocity profile lists the gate hook region renders from', () => {
  it('the bash-5.3 funsub openers and process substitutions stay pinned in the velocity profile', () => {
    for (const opener of ['${ ', '${\t', '${\n', '${\r', '${|', '<(', '>(']) {
      assert.ok(RUNTIME_RESIDUAL_FORMS.commandSubstitutions.includes(opener), `commandSubstitutions must include ${JSON.stringify(opener)}`);
    }
    for (const form of ['\\\n', '\\\r']) {
      assert.ok(RUNTIME_RESIDUAL_FORMS.lineContinuations.includes(form), `lineContinuations must include the splice form ${JSON.stringify(form)}`);
    }
  });

  it('the velocity profile lists are frozen at every level', () => {
    for (const value of [UNIVERSAL_READONLY_ALLOWLIST, RUNTIME_RESIDUAL_FORMS, ...Object.values(RUNTIME_RESIDUAL_FORMS)]) {
      assert.equal(Object.isFrozen(value), true);
    }
  });
});

describe('spec:init-project/S77 generated hook lists preserve values and frozen structure', () => {
  const assertFrozenLists = (core, forms) => {
    for (const value of [core, forms, ...Object.values(forms)]) assert.equal(Object.isFrozen(value), true);
  };

  it('the bundled hook holds the render exactly once and exports the frozen velocity lists', async () => {
    const { renderGateHookLists } = await import('../../scripts/sync-mirrors.mjs');
    const render = renderGateHookLists(UNIVERSAL_READONLY_ALLOWLIST, RUNTIME_RESIDUAL_FORMS);
    const hookUrl = new URL('../references/hooks/gate-approve.mjs', import.meta.url);
    const text = readFileSync(hookUrl, 'utf8');
    assert.equal(text.split(render).length - 1, 1);
    const { SEEDED_READONLY_CORE, RESIDUAL_FORMS } = await import(hookUrl.href);
    assert.deepEqual(SEEDED_READONLY_CORE, UNIVERSAL_READONLY_ALLOWLIST);
    assert.deepEqual(RESIDUAL_FORMS, RUNTIME_RESIDUAL_FORMS);
    assertFrozenLists(SEEDED_READONLY_CORE, RESIDUAL_FORMS);
  });

  it('injected characters round-trip through a safe render with every level frozen', async () => {
    const { renderGateHookLists } = await import('../../scripts/sync-mirrors.mjs');
    const core = ['double"quote', 'back\\slash', 'line\nfeed', 'carriage\rreturn'];
    const forms = { 'own"key': ['back`tick', '${', '\u0001'], 'other\\key': ['\u007f'] };
    const before = structuredClone({ core, forms });
    const render = renderGateHookLists(core, forms);
    assert.equal(render, renderGateHookLists(core, forms));
    assert.deepEqual({ core, forms }, before);
    for (const byte of Buffer.from(render, 'utf8')) assert.equal(isRefusedControlByte(byte), false);
    assert.ok(render.includes('\\u007f'));
    const dir = mkdtempSync(join(tmpdir(), 'gate-hook-lists-'));
    try {
      const file = join(dir, 'lists.mjs');
      writeFileSync(file, render);
      const { SEEDED_READONLY_CORE, RESIDUAL_FORMS } = await import(pathToFileURL(file).href);
      assert.deepEqual(SEEDED_READONLY_CORE, core);
      assert.deepEqual(RESIDUAL_FORMS, forms);
      assertFrozenLists(SEEDED_READONLY_CORE, RESIDUAL_FORMS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
