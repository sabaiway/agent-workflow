import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  injectMethodology,
  findSlot,
  extractSlot,
  ensureSlot,
  reconcileSlot,
  METHODOLOGY_ANCHOR,
  EMPTY_SLOT,
  AGENTS_MD_CAP,
  START_MARKER,
  END_MARKER,
} from './inject-methodology.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'inject-methodology.mjs');
const FRAGMENT = readFileSync(join(HERE, 'methodology-slot.md'), 'utf8');

const wrap = (inner) =>
  `# AGENTS.md\n\nprefix bytes\n\n## Session Protocols\n\nintro line.\n\n${START_MARKER}${inner}${END_MARKER}\n\n## Hard Constraints\n\nsuffix bytes\n`;

// The exact Session-Protocols line both deployed templates carry — the slot anchor.
const ANCHOR_LINE =
  'Start-of-session, during-work, and task-completion procedures live in [`docs/ai/agent_rules.md`](./docs/ai/agent_rules.md) §1. **Read it before any code change.**';

// A pre-slot (markerless) entry point that still carries the Session-Protocols anchor line —
// the realistic shape of a legacy deployment the upgrade reconciliation must add a slot to.
const legacyWithAnchor = (nl = '\n') =>
  [
    '# AGENTS.md',
    '',
    'prefix bytes',
    '',
    '## 🚀 Session Protocols',
    '',
    ANCHOR_LINE,
    '',
    '---',
    '',
    '## 🚫 Hard Constraints',
    '',
    'suffix bytes',
    '',
  ].join(nl);

const countMatches = (text, re) => (text.match(new RegExp(re.source, 'gm')) || []).length;

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

describe('METHODOLOGY_ANCHOR — locating the Session-Protocols slot position', () => {
  it('matches exactly one line in a deployed-style markerless entry point', () => {
    assert.equal(countMatches(legacyWithAnchor(), METHODOLOGY_ANCHOR), 1);
  });
  it('matches exactly one line in BOTH shipped templates', () => {
    const memTmpl = readFileSync(
      join(HERE, '..', '..', 'agent-workflow-memory', 'references', 'templates', 'AGENTS.md'),
      'utf8',
    );
    const kitTmpl = readFileSync(join(HERE, '..', 'references', 'templates', 'AGENTS.md'), 'utf8');
    assert.equal(countMatches(memTmpl, METHODOLOGY_ANCHOR), 1, 'memory template has exactly one anchor');
    assert.equal(countMatches(kitTmpl, METHODOLOGY_ANCHOR), 1, 'kit fallback template has exactly one anchor');
  });
  it('does not match an entry point that lacks the Session-Protocols line', () => {
    assert.equal(countMatches('# AGENTS.md\nno session protocols here\n', METHODOLOGY_ANCHOR), 0);
  });
});

describe('EMPTY_SLOT — the canonical empty marker pair', () => {
  it('is exactly the start+end markers joined by a newline', () => {
    assert.equal(EMPTY_SLOT, `${START_MARKER}\n${END_MARKER}`);
    assert.equal(findSlot(EMPTY_SLOT).state, 'ok');
    assert.equal(extractSlot(EMPTY_SLOT).trim(), '');
  });
});

describe('ensureSlot — idempotent slot presence (insert at the anchor only when absent)', () => {
  it('present (one ok pair) → status present, bytes unchanged', () => {
    const input = wrap('\nfilled\n');
    const out = ensureSlot(input);
    assert.equal(out.status, 'present');
    assert.equal(out.text, input);
  });

  it('malformed slot → status error, never edits', () => {
    const input = `${START_MARKER}\n${END_MARKER}\n${START_MARKER}\n${END_MARKER}\n`;
    const out = ensureSlot(input);
    assert.equal(out.status, 'error');
    assert.equal(out.text, input);
  });

  it('absent + exactly one anchor → inserts EMPTY_SLOT after the anchor line, preserving bytes', () => {
    const input = legacyWithAnchor();
    const out = ensureSlot(input);
    assert.equal(out.status, 'inserted');
    assert.equal(findSlot(out.text).state, 'ok', 'a well-formed slot now exists');
    assert.equal(extractSlot(out.text).trim(), '', 'the inserted slot is empty');
    // the slot lands right after the anchor line
    assert.match(out.text, new RegExp(`Read it before any code change\\.\\*\\*\\n+${START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    // every original line survives
    for (const line of ['# AGENTS.md', 'prefix bytes', ANCHOR_LINE, '## 🚫 Hard Constraints', 'suffix bytes']) {
      assert.ok(out.text.includes(line), `original line preserved: ${line}`);
    }
  });

  it('absent + zero anchor → status error with an actionable message, never edits', () => {
    const input = '# AGENTS.md\n\nno anchor at all\n';
    const out = ensureSlot(input);
    assert.equal(out.status, 'error');
    assert.equal(out.text, input);
    assert.match(out.error, /anchor/i);
  });

  it('absent + multiple anchors → status error (refuses to guess), never edits', () => {
    const input = `${ANCHOR_LINE}\n\nsome text\n\n${ANCHOR_LINE}\n`;
    const out = ensureSlot(input);
    assert.equal(out.status, 'error');
    assert.equal(out.text, input);
  });

  it('preserves CRLF newline style when inserting', () => {
    const input = legacyWithAnchor('\r\n');
    const out = ensureSlot(input);
    assert.equal(out.status, 'inserted');
    assert.equal(findSlot(out.text).state, 'ok');
    assert.ok(out.text.includes(`${START_MARKER}\r\n${END_MARKER}`), 'markers use CRLF');
    assert.ok(!/[^\r]\n/.test(out.text), 'no lone LF introduced into a CRLF document');
  });

  it('is idempotent — a second ensureSlot finds the slot present and changes nothing', () => {
    const once = ensureSlot(legacyWithAnchor()).text;
    const twice = ensureSlot(once);
    assert.equal(twice.status, 'present');
    assert.equal(twice.text, once);
  });
});

describe('reconcileSlot — ensure + inject-if-empty + cap, as one atomic policy', () => {
  it('markerless legacy (with anchor) → reconciled-inserted, slot filled, outside bytes preserved', () => {
    const input = legacyWithAnchor();
    const out = reconcileSlot(input, FRAGMENT, { maxLines: AGENTS_MD_CAP });
    assert.equal(out.status, 'reconciled-inserted');
    assert.equal(extractSlot(out.text).trim(), FRAGMENT.trim(), 'slot now carries the fragment');
    assert.ok(out.text.includes(ANCHOR_LINE), 'anchor preserved');
    assert.ok(out.text.includes('## 🚫 Hard Constraints'), 'suffix preserved');
  });

  it('present empty slot → reconciled-filled', () => {
    const out = reconcileSlot(wrap('\n'), FRAGMENT, { maxLines: AGENTS_MD_CAP });
    assert.equal(out.status, 'reconciled-filled');
    assert.equal(extractSlot(out.text).trim(), FRAGMENT.trim());
  });

  it('present customized/filled slot → present-filled, preserved verbatim (byte-for-byte)', () => {
    const custom = wrap('\nuser-authored methodology notes\nsecond line\n');
    const out = reconcileSlot(custom, FRAGMENT, { maxLines: AGENTS_MD_CAP });
    assert.equal(out.status, 'present-filled');
    assert.equal(out.text, custom, 'a filled slot is never overwritten');
  });

  it('malformed slot → error, input returned byte-for-byte', () => {
    const input = `${START_MARKER}\n${END_MARKER}\n${START_MARKER}\n${END_MARKER}\n`;
    const out = reconcileSlot(input, FRAGMENT, { maxLines: AGENTS_MD_CAP });
    assert.equal(out.status, 'error');
    assert.equal(out.text, input);
  });

  it('markerless with no anchor → error, input unchanged (never guesses placement)', () => {
    const input = '# AGENTS.md\n\nno slot, no anchor\n';
    const out = reconcileSlot(input, FRAGMENT, { maxLines: AGENTS_MD_CAP });
    assert.equal(out.status, 'error');
    assert.equal(out.text, input);
  });

  it('over-cap result → error, input unchanged (atomic: discards the intermediate slot insert)', () => {
    const input = legacyWithAnchor();
    const out = reconcileSlot(input, FRAGMENT, { maxLines: 5 });
    assert.equal(out.status, 'error');
    assert.equal(out.text, input);
  });

  it('produces a clean CRLF document when inserting + filling (no lone LF)', () => {
    // ensureSlot preserves the document newline style for the markers, and injectMethodology frames
    // the LF-canonical fragment with the document's EOL — so a CRLF document stays uniformly CRLF.
    const input = legacyWithAnchor('\r\n');
    const out = reconcileSlot(input, FRAGMENT, { maxLines: AGENTS_MD_CAP });
    assert.equal(out.status, 'reconciled-inserted');
    assert.equal(extractSlot(out.text).trim(), FRAGMENT.trim());
    assert.ok(out.text.includes(`${ANCHOR_LINE}\r\n`), 'anchor line keeps CRLF');
    assert.ok(!/[^\r]\n/.test(out.text), 'no lone LF introduced into a CRLF document');
  });

  it('present filled slot over the line cap → error, input returned unchanged', () => {
    const bigSlot = `\n${Array.from({ length: 30 }, (_, i) => `note ${i}`).join('\n')}\n`;
    const filled = wrap(bigSlot);
    const out = reconcileSlot(filled, FRAGMENT, { maxLines: 10 });
    assert.equal(out.status, 'error');
    assert.equal(out.text, filled, 'an over-cap entry point is surfaced, not silently accepted');
    assert.match(out.error, /cap 10/);
  });
});

describe('reconcile CLI — atomic ensure+inject-if-empty+cap on the real filesystem', () => {
  const withTempAgents = (contents, run) => {
    const dir = mkdtempSync(join(tmpdir(), 'reconcile-cli-'));
    const agents = join(dir, 'AGENTS.md');
    writeFileSync(agents, contents);
    try {
      return run(agents);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('markerless legacy (with anchor) → slot inserted and filled (exit 0)', () => {
    withTempAgents(legacyWithAnchor(), (agents) => {
      execFileSync(process.execPath, [SCRIPT, 'reconcile', agents], { stdio: 'pipe' });
      const out = readFileSync(agents, 'utf8');
      assert.equal(findSlot(out).state, 'ok');
      assert.equal(extractSlot(out).trim(), FRAGMENT.trim());
    });
  });

  it('present empty slot → slot filled (exit 0)', () => {
    withTempAgents(wrap('\n'), (agents) => {
      execFileSync(process.execPath, [SCRIPT, 'reconcile', agents], { stdio: 'pipe' });
      assert.equal(extractSlot(readFileSync(agents, 'utf8')).trim(), FRAGMENT.trim());
    });
  });

  it('filled/customized slot → file left byte-for-byte untouched', () => {
    const custom = wrap('\nuser notes\n');
    withTempAgents(custom, (agents) => {
      execFileSync(process.execPath, [SCRIPT, 'reconcile', agents], { stdio: 'pipe' });
      assert.equal(readFileSync(agents, 'utf8'), custom);
    });
  });

  it('malformed slot → STOP with non-zero exit, file byte-unchanged', () => {
    const malformed = `${START_MARKER}\n${END_MARKER}\n${START_MARKER}\n${END_MARKER}\n`;
    withTempAgents(malformed, (agents) => {
      assert.throws(() => execFileSync(process.execPath, [SCRIPT, 'reconcile', agents], { stdio: 'pipe' }));
      assert.equal(readFileSync(agents, 'utf8'), malformed);
    });
  });
});
