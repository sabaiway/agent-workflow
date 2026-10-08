import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const state = await import('./bridge-state-dirs.mjs').catch((cause) => new Proxy({}, {
  get: (_, name) => {
    if (name === 'then') return undefined;
    return () => {
      throw new Error(`bridge-state-dirs.mjs unavailable: ${String(name)}`, { cause });
    };
  },
}));

const HOME = '/home/u';
const ROOT = '/work/p';
const CODEX = { env: 'CODEX_HOME', default: '~/.codex' };
const AGY = { env: null, default: '~/.gemini/antigravity-cli' };
const CONTEXT = { home: HOME, root: ROOT, env: {} };

describe('spec:velocity-profile/S7 bridge state directories', () => {
  for (const [value, expected] of [
    ['~', '~'],
    ['~/x', '~/x'],
    ['/abs', '/abs'],
    ['state/codex', '/work/p/state/codex'],
  ]) {
    it(`resolveWritableDir resolves CODEX_HOME=${value}`, () => {
      assert.equal(state.resolveWritableDir(CODEX, {
        env: { CODEX_HOME: value },
        root: ROOT,
      }), expected);
    });
  }

  it('resolveWritableDir uses defaults for empty, unset or undeclared overrides', () => {
    assert.equal(state.resolveWritableDir(CODEX, CONTEXT), CODEX.default);
    assert.equal(state.resolveWritableDir(CODEX, {
      ...CONTEXT,
      env: { CODEX_HOME: '' },
    }), CODEX.default);
    const populated = { ...CONTEXT, env: { CODEX_HOME: '/srv/codex-state' } };
    assert.equal(state.resolveWritableDir(AGY, populated), AGY.default);
    assert.equal(state.resolveWritableDir({ default: CODEX.default }, populated), CODEX.default);
  });

  it('homeRelative renders home and descendants without matching a sibling prefix', () => {
    assert.equal(state.homeRelative(HOME, HOME), '~');
    assert.equal(state.homeRelative('/home/u/.codex', HOME), '~/.codex');
    assert.equal(state.homeRelative('/srv/codex-state', HOME), '/srv/codex-state');
    assert.equal(state.homeRelative('/home/u2/.codex', HOME), '/home/u2/.codex');
    assert.equal(state.homeRelative('~', HOME), '~');
    assert.equal(state.homeRelative('~/x', HOME), '~/x');
  });

  it('stateDirsOf renders an outside-home CODEX_HOME as absolute', () => {
    assert.deepEqual(state.stateDirsOf([CODEX], {
      ...CONTEXT,
      env: { CODEX_HOME: '/srv/codex-state' },
    }), ['/srv/codex-state']);
  });

  it('a home at the filesystem root spells a dir by its whole path under ~', () => {
    assert.equal(state.homeRelative('/srv/codex-state', '/'), '~/srv/codex-state');
    assert.deepEqual(state.stateDirsOf([CODEX], { home: '/', root: ROOT, env: { CODEX_HOME: '/srv/codex-state' } }),
      ['~/srv/codex-state']);
  });

  it('stateDirsOf lists repeated and equivalent entries once in first-seen order', () => {
    assert.deepEqual(state.stateDirsOf([
      CODEX,
      AGY,
      CODEX,
      { env: null, default: '/home/u/.codex' },
      AGY,
    ], CONTEXT), [CODEX.default, AGY.default]);
  });

  for (const value of ['~', '~/', '~/.', '/home/u/', '/home', '/', '..']) {
    it(`stateDirsOf rejects CODEX_HOME=${value} and names the override`, () => {
      assert.deepEqual(state.stateDirsOf([CODEX], CONTEXT), [CODEX.default]);
      assert.throws(() => state.stateDirsOf([CODEX], {
        ...CONTEXT,
        env: { CODEX_HOME: value },
      }), (error) => error instanceof Error && error.message.includes('CODEX_HOME'));
    });
  }

  it('missingStateDirs accepts ancestor coverage by segment and rejects sibling prefixes', () => {
    assert.deepEqual(state.missingStateDirs(
      [CODEX.default, AGY.default],
      ['~/.gemini', '/home/u/.codexx'],
      CONTEXT,
    ), [CODEX.default]);
  });

  it('missingStateDirs resolves exact and root-relative coverage but not descendants', () => {
    assert.deepEqual(state.missingStateDirs(
      [CODEX.default, '/work/p/state/cache'],
      ['/home/u/.codex', 'state'],
      CONTEXT,
    ), []);
    assert.deepEqual(state.missingStateDirs(
      [AGY.default],
      ['~/.gemini/antigravity-cli/cache'],
      CONTEXT,
    ), [AGY.default]);
  });

  it('missingStateDirs ignores non-string and blank entries', () => {
    const dirs = [CODEX.default, AGY.default, '/work/p/state'];
    assert.deepEqual(state.missingStateDirs(
      dirs,
      [null, undefined, false, 42, {}, [], '', '   ', '\t'],
      CONTEXT,
    ), dirs);
  });

  it('mergeAllowWrite preserves siblings, appends once and leaves its input unchanged', () => {
    const settings = {
      permissions: { allow: ['Read'] },
      sandbox: {
        enabled: true,
        network: { allowedDomains: ['example.invalid'] },
        filesystem: {
          allowWrite: ['/srv/foreign', CODEX.default],
          denyWrite: ['/srv/private'],
        },
      },
    };
    const original = structuredClone(settings);
    const dirs = [CODEX.default, AGY.default, AGY.default, '/srv/codex-state'];
    const merged = state.mergeAllowWrite(settings, dirs);
    assert.notStrictEqual(merged, settings);
    assert.deepEqual(settings, original);
    assert.deepEqual(merged, {
      ...original,
      sandbox: {
        ...original.sandbox,
        filesystem: {
          ...original.sandbox.filesystem,
          allowWrite: ['/srv/foreign', CODEX.default, AGY.default, '/srv/codex-state'],
        },
      },
    });
    const mergedSnapshot = structuredClone(merged);
    const again = state.mergeAllowWrite(merged, dirs);
    assert.strictEqual(again, merged);
    assert.deepEqual(again, mergedSnapshot);
  });

  it('mergeAllowWrite returns an empty-dir input unchanged without adding sandbox', () => {
    const settings = { permissions: { allow: ['Read'] } };
    const original = structuredClone(settings);
    assert.strictEqual(state.mergeAllowWrite(settings, []), settings);
    assert.deepEqual(settings, original);
    assert.equal(Object.hasOwn(settings, 'sandbox'), false);
  });
});
