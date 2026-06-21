import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  injectMethodology,
  findSlot,
  extractSlot,
  START_MARKER,
  END_MARKER,
} from './inject-methodology.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRAGMENT = readFileSync(join(HERE, 'methodology-slot.md'), 'utf8');

const wrap = (inner) =>
  `# AGENTS.md\n\nprefix bytes\n\n## Session Protocols\n\nintro line.\n\n${START_MARKER}${inner}${END_MARKER}\n\n## Hard Constraints\n\nsuffix bytes\n`;

describe('findSlot — marker classification', () => {
  it('one ordered pair → ok', () => {
    assert.equal(findSlot(wrap('\n')).state, 'ok');
  });
  it('no markers → absent', () => {
    assert.equal(findSlot('# AGENTS.md\nno markers here\n').state, 'absent');
  });
  it('duplicate pair → malformed', () => {
    const text = `${START_MARKER}\n${END_MARKER}\n${START_MARKER}\n${END_MARKER}\n`;
    assert.equal(findSlot(text).state, 'malformed');
  });
  it('single start only → malformed', () => {
    assert.equal(findSlot(`x\n${START_MARKER}\ny\n`).state, 'malformed');
  });
  it('single end only → malformed', () => {
    assert.equal(findSlot(`x\n${END_MARKER}\ny\n`).state, 'malformed');
  });
  it('reversed (end before start) → malformed', () => {
    assert.equal(findSlot(`${END_MARKER}\nmiddle\n${START_MARKER}\n`).state, 'malformed');
  });
});

describe('injectMethodology — byte preservation', () => {
  it('injects into an empty slot, preserving prefix/suffix exactly', () => {
    const input = wrap('\n');
    const out = injectMethodology(input, FRAGMENT);
    assert.equal(out.status, 'injected');
    assert.ok(out.text.startsWith('# AGENTS.md\n\nprefix bytes\n\n## Session Protocols\n\nintro line.\n\n'));
    assert.ok(out.text.endsWith('\n\n## Hard Constraints\n\nsuffix bytes\n'));
    assert.ok(out.text.includes(FRAGMENT.trim()));
    // markers themselves are preserved
    assert.equal((out.text.match(new RegExp(START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1);
  });

  it('is idempotent — re-injecting the same fragment is stable', () => {
    const once = injectMethodology(wrap('\n'), FRAGMENT).text;
    const twice = injectMethodology(once, FRAGMENT).text;
    assert.equal(twice, once);
  });

  it('overwrites a previously-filled slot (bootstrap composition), preserving outside bytes', () => {
    const filled = wrap('\nstale content\n');
    const out = injectMethodology(filled, FRAGMENT);
    assert.equal(out.status, 'injected');
    assert.ok(!out.text.includes('stale content'));
    assert.ok(out.text.endsWith('\n\n## Hard Constraints\n\nsuffix bytes\n'));
  });

  it('rejects a fragment that itself contains a marker (would nest/duplicate the slot)', () => {
    const out = injectMethodology(wrap('\n'), `bad ${START_MARKER} fragment`);
    assert.equal(out.status, 'error');
    assert.equal(out.text, wrap('\n'));
  });

  it('refuses to bust the line cap (maxLines) instead of silently overflowing it', () => {
    const huge = Array.from({ length: 40 }, (_, i) => `methodology line ${i}`).join('\n');
    const out = injectMethodology(wrap('\n'), huge, { maxLines: 20 });
    assert.equal(out.status, 'error');
    assert.match(out.error, /cap 20/);
    assert.equal(out.text, wrap('\n')); // unchanged
  });

  it('absent markers → no-op, returns input byte-for-byte', () => {
    const input = '# AGENTS.md\nlegacy file, no slot\n';
    const out = injectMethodology(input, FRAGMENT);
    assert.equal(out.status, 'noop-absent');
    assert.equal(out.text, input);
  });

  for (const [label, input] of [
    ['duplicate pair', `${START_MARKER}\n${END_MARKER}\n${START_MARKER}\n${END_MARKER}\n`],
    ['single start', `head\n${START_MARKER}\ntail\n`],
    ['single end', `head\n${END_MARKER}\ntail\n`],
    ['reversed', `${END_MARKER}\nx\n${START_MARKER}\n`],
  ]) {
    it(`malformed (${label}) → error, returns input byte-for-byte`, () => {
      const out = injectMethodology(input, FRAGMENT);
      assert.equal(out.status, 'error');
      assert.equal(out.text, input); // never edits a malformed slot
    });
  }
});

describe('extractSlot — preserve-on-upgrade inverse', () => {
  it('returns the bytes strictly between the markers', () => {
    assert.equal(extractSlot(wrap('\nkeep me\n')), '\nkeep me\n');
  });
  it('null on absent/malformed', () => {
    assert.equal(extractSlot('no markers'), null);
    assert.equal(extractSlot(`${START_MARKER}\n${START_MARKER}\n${END_MARKER}\n`), null);
  });
});

describe('post-injection cap — AGENTS.md stays under its line budget', () => {
  it('injecting the bounded fragment into the real memory template keeps AGENTS.md ≤ 100 lines', () => {
    const template = readFileSync(
      join(HERE, '..', '..', 'agent-workflow-memory', 'references', 'templates', 'AGENTS.md'),
      'utf8',
    );
    const out = injectMethodology(template, FRAGMENT);
    assert.equal(out.status, 'injected');
    const lines = out.text.split('\n').length - (out.text.endsWith('\n') ? 1 : 0);
    assert.ok(lines <= 100, `AGENTS.md would be ${lines} lines after injection (cap 100)`);
  });
});
