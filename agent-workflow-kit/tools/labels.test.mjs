import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOT_INSTALLED,
  UNSUPPORTED_SCHEMA,
  INVALID_MANIFEST,
  STUB,
  FOREIGN,
  OK,
  UNKNOWN,
  STATE_PUBLIC,
  VISIBILITY_PUBLIC,
  DISPLAY_NAMES,
  displayOf,
  INTERNAL_RENDER_FORBIDDEN,
} from './labels.mjs';

describe('labels — manifestState constants', () => {
  it('carry the stable internal literals (the detect-backends precedence)', () => {
    assert.deepEqual(
      [NOT_INSTALLED, UNSUPPORTED_SCHEMA, INVALID_MANIFEST, STUB, FOREIGN, OK, UNKNOWN],
      ['not-installed', 'unsupported-schema', 'invalid-manifest', 'stub', 'foreign', 'ok', 'unknown'],
    );
  });
});

describe('labels — STATE_PUBLIC (internal → user-safe token)', () => {
  it('maps every internal state to its public token, never leaking the internal literal', () => {
    assert.deepEqual(STATE_PUBLIC, {
      [OK]: 'installed',
      [NOT_INSTALLED]: 'absent',
      [FOREIGN]: 'other-tool',
      [STUB]: 'placeholder',
      [INVALID_MANIFEST]: 'invalid',
      [UNSUPPORTED_SCHEMA]: 'unsupported',
      [UNKNOWN]: 'uncheckable',
    });
  });
  it('is frozen (a contract, not a mutable)', () => {
    assert.ok(Object.isFrozen(STATE_PUBLIC));
  });
});

describe('labels — VISIBILITY_PUBLIC + DISPLAY_NAMES', () => {
  it('visibility maps the three inferVisibility states to user-safe words', () => {
    assert.deepEqual(VISIBILITY_PUBLIC, { visible: 'visible', hidden: 'hidden', ambiguous: 'unclear' });
    assert.ok(Object.isFrozen(VISIBILITY_PUBLIC));
  });
  it('display names cover the five members; displayOf falls back to the raw name', () => {
    assert.equal(DISPLAY_NAMES['agent-workflow-kit'], 'kit');
    assert.equal(DISPLAY_NAMES['codex-cli-bridge'], 'codex-bridge');
    assert.equal(displayOf('agent-workflow-engine'), 'engine');
    assert.equal(displayOf('something-unknown'), 'something-unknown');
    assert.ok(Object.isFrozen(DISPLAY_NAMES));
  });
});

describe('labels — INTERNAL_RENDER_FORBIDDEN (the no-leak set, Plan §4.3 INV-4)', () => {
  it('includes the internal manifestState literals, field names, and stamp filenames', () => {
    for (const term of [
      'not-installed',
      'unsupported-schema',
      'invalid-manifest',
      'stub',
      'foreign',
      'manifestState',
      'hiddenFence',
      '.workflow-version',
      '.memory-version',
    ]) {
      assert.ok(INTERNAL_RENDER_FORBIDDEN.includes(term), `forbidden set must include "${term}"`);
    }
  });

  it('EXCLUDES the public-overlapping tokens — "unknown" (a bridge wrapper state) and "ok"', () => {
    assert.ok(!INTERNAL_RENDER_FORBIDDEN.includes('unknown'), '"unknown" is also a PUBLIC bridge state — never forbidden');
    assert.ok(!INTERNAL_RENDER_FORBIDDEN.includes('ok'), '"ok" is too generic + not sensitive — never forbidden');
  });

  it('EXCLUDES the public state tokens (so a rendered envelope using them never trips the guard)', () => {
    for (const pub of Object.values(STATE_PUBLIC)) {
      assert.ok(!INTERNAL_RENDER_FORBIDDEN.includes(pub), `public token "${pub}" must not be forbidden`);
    }
  });

  it('EXCLUDES the public visibility words (only the internal compound fence terms are forbidden)', () => {
    for (const word of Object.values(VISIBILITY_PUBLIC)) {
      assert.ok(!INTERNAL_RENDER_FORBIDDEN.includes(word), `visibility word "${word}" must not be forbidden`);
    }
    assert.ok(INTERNAL_RENDER_FORBIDDEN.includes('hidden fence'), 'the internal compound fence term IS forbidden');
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(INTERNAL_RENDER_FORBIDDEN));
  });
});
