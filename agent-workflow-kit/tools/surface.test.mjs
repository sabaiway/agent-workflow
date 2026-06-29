import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveFormat,
  resolveWidth,
  resolveColor,
  detectSurface,
  FORMATS,
  MIN_WIDTH,
  DEFAULT_WIDTH,
  FORMAT_ENV,
} from './surface.mjs';

describe('surface — resolveFormat (flag beats env; --json sugar; loud reject)', () => {
  it('--json resolves to json; --format=plain to plain', () => {
    assert.equal(resolveFormat(['--json']), 'json');
    assert.equal(resolveFormat(['--format=plain']), 'plain');
    assert.equal(resolveFormat(['--format=ansi']), 'ansi');
    assert.equal(resolveFormat(['--format=auto']), 'auto');
  });
  it('--format=json is byte-identical sugar with --json', () => {
    assert.equal(resolveFormat(['--format=json']), resolveFormat(['--json']));
  });
  it('a flag beats the AGENT_WORKFLOW_FORMAT env', () => {
    assert.equal(resolveFormat(['--format=plain'], { [FORMAT_ENV]: 'ansi' }), 'plain');
  });
  it('falls back to the env when no flag is present, else auto', () => {
    assert.equal(resolveFormat([], { [FORMAT_ENV]: 'ansi' }), 'ansi');
    assert.equal(resolveFormat([], {}), 'auto');
  });
  it('among flags, the LAST on argv wins (deterministic)', () => {
    assert.equal(resolveFormat(['--format=plain', '--json']), 'json');
    assert.equal(resolveFormat(['--json', '--format=ansi']), 'ansi');
  });
  it('a bare --format (no value) is a loud reject', () => {
    assert.throws(() => resolveFormat(['--format']), /--format needs a value/);
  });
  it('an empty or unknown format value is a loud reject', () => {
    assert.throws(() => resolveFormat(['--format=']), /invalid format/);
    assert.throws(() => resolveFormat(['--format=fancy']), /invalid format/);
    assert.throws(() => resolveFormat([], { [FORMAT_ENV]: 'nope' }), /invalid format/);
  });
  it('exposes the four valid formats', () => {
    assert.deepEqual(FORMATS, ['auto', 'plain', 'ansi', 'json']);
  });
});

describe('surface — resolveWidth', () => {
  it('stdout columns win when > 0', () => {
    assert.equal(resolveWidth({ columns: 120 }), 120);
  });
  it('falls through 0 / undefined / garbage columns to $COLUMNS, then to the 80 default', () => {
    assert.equal(resolveWidth({ columns: 0, env: { COLUMNS: '100' } }), 100);
    assert.equal(resolveWidth({ columns: undefined, env: { COLUMNS: '90' } }), 90);
    assert.equal(resolveWidth({ columns: 'wide', env: { COLUMNS: '70' } }), 70);
    assert.equal(resolveWidth({ columns: 0, env: { COLUMNS: 'garbage' } }), DEFAULT_WIDTH);
    assert.equal(resolveWidth({}), DEFAULT_WIDTH);
  });
});

describe('surface — resolveColor (orthogonal; FORCE beats NO_COLOR)', () => {
  it('CLICOLOR_FORCE / FORCE_COLOR present → on', () => {
    assert.equal(resolveColor({ env: { CLICOLOR_FORCE: '1' } }), true);
    assert.equal(resolveColor({ env: { FORCE_COLOR: '1' } }), true);
    assert.equal(resolveColor({ env: { FORCE_COLOR: '' } }), true);
  });
  it('FORCE_COLOR=0 / false → off (explicit disable)', () => {
    assert.equal(resolveColor({ env: { FORCE_COLOR: '0' } }), false);
    assert.equal(resolveColor({ env: { FORCE_COLOR: 'false' } }), false);
  });
  it('NO_COLOR present (incl. empty) → off', () => {
    assert.equal(resolveColor({ env: { NO_COLOR: '1' }, isTTY: true }), false);
    assert.equal(resolveColor({ env: { NO_COLOR: '' }, isTTY: true }), false);
  });
  it('FORCE beats NO_COLOR', () => {
    assert.equal(resolveColor({ env: { FORCE_COLOR: '1', NO_COLOR: '1' } }), true);
  });
  it('otherwise follows isTTY', () => {
    assert.equal(resolveColor({ env: {}, isTTY: true }), true);
    assert.equal(resolveColor({ env: {}, isTTY: false }), false);
  });
});

describe('surface — detectSurface (the §4.5 table)', () => {
  it('json format → mode json, color off', () => {
    const s = detectSurface({ argv: ['--json'], isTTY: true });
    assert.equal(s.mode, 'json');
    assert.equal(s.color, false);
  });
  it('auto + not a TTY → plain', () => {
    assert.equal(detectSurface({ isTTY: false }).mode, 'plain');
  });
  it('auto + a TTY → ansi', () => {
    assert.equal(detectSurface({ isTTY: true }).mode, 'ansi');
  });
  it('TERM=dumb → plain even on a TTY', () => {
    assert.equal(detectSurface({ isTTY: true, env: { TERM: 'dumb' } }).mode, 'plain');
  });
  it('any CI env → plain even on a TTY', () => {
    assert.equal(detectSurface({ isTTY: true, env: { CI: 'true' } }).mode, 'plain');
    assert.equal(detectSurface({ isTTY: true, env: { CI: '' } }).mode, 'plain', 'presence, not truthiness');
  });
  it('an explicit ansi format is honored even when not a TTY', () => {
    assert.equal(detectSurface({ argv: ['--format=ansi'], isTTY: false }).mode, 'ansi');
  });
  it('width below the floor forces plain + ASCII (a box cannot lay out under 40 cols)', () => {
    const s = detectSurface({ argv: ['--format=ansi'], isTTY: true, columns: MIN_WIDTH - 1 });
    assert.equal(s.mode, 'plain');
    assert.equal(s.ascii, true);
  });
  it('a Windows TTY without a UTF-8 locale → ASCII glyphs; with UTF-8 → unicode', () => {
    assert.equal(detectSurface({ isTTY: true, platform: 'win32', env: { TERM: 'xterm' } }).ascii, true);
    assert.equal(detectSurface({ isTTY: true, platform: 'win32', env: { TERM: 'xterm', LANG: 'en_US.UTF-8' } }).ascii, false);
  });
});
