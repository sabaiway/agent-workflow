import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATE_PHRASING,
  VISIBILITY_PHRASING,
  BLOCK_TITLES,
  SETTINGS_LABELS,
  GLYPHS,
  glyphsFor,
  NO_DEPLOYMENT,
} from './presentation.mjs';

describe('presentation — state phrasing', () => {
  it('installed → null (show the version); every other public token → an English phrase', () => {
    assert.equal(STATE_PHRASING.installed, null);
    assert.equal(STATE_PHRASING.absent, 'not installed');
    assert.match(STATE_PHRASING['other-tool'], /different tool/);
    assert.match(STATE_PHRASING.placeholder, /placeholder/);
    assert.match(STATE_PHRASING.invalid, /didn't validate/);
    assert.match(STATE_PHRASING.unsupported, /too new/);
    assert.match(STATE_PHRASING.uncheckable, /permission error/);
    assert.ok(Object.isFrozen(STATE_PHRASING));
  });
});

describe('presentation — visibility phrasing', () => {
  it('visibility phrases never use the internal fence/marker terms', () => {
    for (const phrase of Object.values(VISIBILITY_PHRASING)) {
      assert.ok(!/fence|marker/i.test(phrase), `visibility phrase leaks internals: ${phrase}`);
    }
    assert.match(VISIBILITY_PHRASING.hidden, /git-ignored/);
  });
});

describe('presentation — titles, labels, glyphs', () => {
  it('block titles include a project-dir function', () => {
    assert.equal(typeof BLOCK_TITLES.project, 'function');
    assert.equal(BLOCK_TITLES.project('/p'), 'project deployment (/p)');
    assert.match(BLOCK_TITLES.members, /family/);
    assert.equal(BLOCK_TITLES.settings, 'settings');
  });
  it('settings labels + no-deployment line exist', () => {
    assert.deepEqual(Object.keys(SETTINGS_LABELS).sort(), ['agents', 'attribution', 'hook', 'recipes', 'velocity']);
    assert.match(NO_DEPLOYMENT, /no agent-workflow deployment/);
  });
  it('glyphsFor toggles between the unicode and ASCII sets', () => {
    assert.equal(glyphsFor(false), GLYPHS.unicode);
    assert.equal(glyphsFor(true), GLYPHS.ascii);
    assert.equal(GLYPHS.unicode.note, '↳');
    assert.equal(GLYPHS.ascii.note, '->');
    assert.equal(GLYPHS.unicode.present, '✓');
    assert.equal(GLYPHS.ascii.present, '+');
    assert.ok(Object.isFrozen(GLYPHS.unicode) && Object.isFrozen(GLYPHS.ascii));
  });
});
