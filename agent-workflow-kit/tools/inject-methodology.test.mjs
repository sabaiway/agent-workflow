import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
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
  slotNeedsFill,
  METHODOLOGY_ANCHOR,
  EMPTY_SLOT,
  AGENTS_MD_CAP,
  START_MARKER,
  END_MARKER,
  ORCH_START_MARKER,
  ORCH_END_MARKER,
  ORCHESTRATION_DESCRIPTOR,
  findMarkerSlot,
  extractMarkerSlot,
} from './inject-methodology.mjs';

// Read the orchestration slot's content from a reconciled entry point.
const extractOrch = (text) => extractMarkerSlot(text, ORCHESTRATION_DESCRIPTOR);
const hasOrchSlot = (text) => findMarkerSlot(text, ORCHESTRATION_DESCRIPTOR).state === 'ok';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'inject-methodology.mjs');

// The bounded methodology fragment is read LIVE from the installed engine now (the kit mirror is
// retired in Plan 3D), so this suite no longer reads a bundled methodology-slot.md. Tests use an
// inline fragment and, for the live-read CLI cases, an on-the-fly engine fixture that ships exactly
// this fragment — keeping the kit suite decoupled from the sibling engine's on-disk presence.
// Single-line (like the canonical fragment) so byte-equality holds in both LF and CRLF documents.
const FRAGMENT =
  '> **Workflow methodology (test fixture)** — plan → execute → review. Plans are ephemeral, gitignored, never committed; every Plan ends with a mandatory **Phase: Cleanup**.\n';
// The SECOND bounded fragment (Plan 4) — distinct content so a test can tell which slot got which.
const ORCH_FRAGMENT =
  '> **Orchestration recipes (test fixture)** — Solo / Reviewed / Council / Delegated; pick one with `/agent-workflow-kit recipes`.\n';

// Temp dirs created by the fixtures below — cleaned up once after the whole file.
const tmpDirs = [];
after(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// A minimal but VALID installed-engine fixture: a methodology-engine capability.json + a SKILL.md
// whose metadata.version matches it (the validator's authoritative version source when there is no
// package.json) + BOTH live fragments (methodology + orchestration). detectEngine accepts it; pass
// `orchFragment = null` to model an OLDER engine (<1.2.0) that ships no orchestration fragment.
const makeEngineFixture = (fragment = FRAGMENT, version = '1.0.0', orchFragment = ORCH_FRAGMENT) => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-fixture-'));
  tmpDirs.push(dir);
  const manifest = {
    family: 'agent-workflow',
    schema: 1,
    name: 'agent-workflow-engine',
    kind: 'methodology-engine',
    version,
    available: true,
    provides: ['plan'],
    roles: {},
  };
  writeFileSync(join(dir, 'capability.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: agent-workflow-engine\nmetadata:\n  version: '${version}'\n---\n# engine\n`);
  mkdirSync(join(dir, 'references'), { recursive: true });
  writeFileSync(join(dir, 'references', 'methodology-slot.md'), fragment);
  if (orchFragment != null) writeFileSync(join(dir, 'references', 'orchestration-slot.md'), orchFragment);
  return dir;
};

const ENGINE = makeEngineFixture();
// A path that is guaranteed NOT to be a valid engine — proves the no-op / explicit-override paths
// never consult the engine, and drives the fail-loud STOP.
const NO_ENGINE = join(tmpdir(), `definitely-no-engine-${process.pid}`);
const withEngine = (engineDir) => ({ ...process.env, AGENT_WORKFLOW_ENGINE_DIR: engineDir });

const wrap = (inner) =>
  `# AGENTS.md\n\nprefix bytes\n\n## Session Protocols\n\nintro line.\n\n${START_MARKER}${inner}${END_MARKER}\n\n## Hard Constraints\n\nsuffix bytes\n`;

// An entry point carrying BOTH reconciled slots (the orchestration pair sits right under the
// methodology pair, as the descriptor anchors it) — the deployed shape after a dual-slot reconcile.
const wrapDual = (methInner, orchInner) =>
  `# AGENTS.md\n\nprefix bytes\n\n## Session Protocols\n\nintro line.\n\n${START_MARKER}${methInner}${END_MARKER}\n${ORCH_START_MARKER}${orchInner}${ORCH_END_MARKER}\n\n## Hard Constraints\n\nsuffix bytes\n`;

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

describe('slotNeedsFill — lazy-read predicate (matches reconcileSlot fill decision)', () => {
  it('present empty slot → true', () => {
    assert.equal(slotNeedsFill(wrap('\n')), true);
  });
  it('markerless legacy with one anchor (insertable empty slot) → true', () => {
    assert.equal(slotNeedsFill(legacyWithAnchor()), true);
  });
  it('present filled/customized slot → false (fragment not needed)', () => {
    assert.equal(slotNeedsFill(wrap('\nuser notes\n')), false);
  });
  it('malformed slot → false (reconcileSlot error path fires, not a fill)', () => {
    assert.equal(slotNeedsFill(`${START_MARKER}\n${END_MARKER}\n${START_MARKER}\n${END_MARKER}\n`), false);
  });
  it('markerless with no anchor → false (cannot insert; reconcile errors without the engine)', () => {
    assert.equal(slotNeedsFill('# AGENTS.md\n\nno anchor here\n'), false);
  });

  // slotNeedsFill and reconcileSlot share the SAME emptiness primitives (ensureSlot + extractSlot), so
  // the lazy "read the engine only when needed" guard cannot disagree with reconcileSlot's actual fill
  // decision. Pin that equivalence across representative inputs: needsFill === true  IFF reconcile fills
  // (reconciled-filled / reconciled-inserted); needsFill === false IFF reconcile does NOT fill
  // (present-filled / error). This forecloses any future divergence that could silently drop a slot.
  it('agrees with reconcileSlot across every slot state (no divergence → no silent drop)', () => {
    const cases = [
      wrap('\n'), // present empty slot → fill
      legacyWithAnchor(), // markerless + anchor → insert + fill
      wrap('\nuser notes\n'), // filled slot → no fill
      `${START_MARKER}\n${END_MARKER}\n${START_MARKER}\n${END_MARKER}\n`, // malformed → no fill (error)
      '# AGENTS.md\n\nno anchor here\n', // no anchor → no fill (error)
    ];
    for (const text of cases) {
      const needs = slotNeedsFill(text);
      const result = reconcileSlot(text, FRAGMENT, { maxLines: AGENTS_MD_CAP });
      const filled = result.status === 'reconciled-filled' || result.status === 'reconciled-inserted';
      assert.equal(needs, filled, `slotNeedsFill (${needs}) must match whether reconcile fills (${result.status})`);
    }
  });
});

describe('reconcile CLI — atomic ensure+inject-if-empty+cap, reading the fragment LIVE from the engine', () => {
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

  it('markerless legacy (with anchor) → BOTH slots inserted + filled from their own live engine fragments (exit 0)', () => {
    withTempAgents(legacyWithAnchor(), (agents) => {
      execFileSync(process.execPath, [SCRIPT, 'reconcile', agents], { stdio: 'pipe', env: withEngine(ENGINE) });
      const out = readFileSync(agents, 'utf8');
      assert.equal(findSlot(out).state, 'ok');
      assert.equal(extractSlot(out).trim(), FRAGMENT.trim(), 'methodology slot filled from the methodology fragment');
      assert.ok(hasOrchSlot(out), 'the orchestration slot was inserted below the methodology pair');
      assert.equal(extractOrch(out).trim(), ORCH_FRAGMENT.trim(), 'orchestration slot filled from the orchestration fragment');
    });
  });

  it('present empty methodology slot → BOTH slots filled; each from its OWN engine fragment (exit 0)', () => {
    withTempAgents(wrap('\n'), (agents) => {
      execFileSync(process.execPath, [SCRIPT, 'reconcile', agents], { stdio: 'pipe', env: withEngine(ENGINE) });
      const out = readFileSync(agents, 'utf8');
      assert.equal(extractSlot(out).trim(), FRAGMENT.trim());
      assert.equal(extractOrch(out).trim(), ORCH_FRAGMENT.trim());
      // Per-slot fragment sourcing: the two slots carry DIFFERENT content (not both the methodology one).
      assert.notEqual(extractSlot(out).trim(), extractOrch(out).trim());
    });
  });

  it('BOTH slots already filled → zero-diff no-op WITHOUT consulting the engine (engine absent, exit 0)', () => {
    const custom = wrapDual('\nuser meth notes\n', '\nuser orch notes\n');
    withTempAgents(custom, (agents) => {
      // Engine pointed at a path that does not exist — a fully-filled entry point must NOT require it.
      execFileSync(process.execPath, [SCRIPT, 'reconcile', agents], { stdio: 'pipe', env: withEngine(NO_ENGINE) });
      assert.equal(readFileSync(agents, 'utf8'), custom);
    });
  });

  it('present empty slot + engine ABSENT → hard STOP (nonzero) printing the install command, file unchanged', () => {
    withTempAgents(wrap('\n'), (agents) => {
      const err = (() => {
        try {
          execFileSync(process.execPath, [SCRIPT, 'reconcile', agents], { stdio: 'pipe', env: withEngine(NO_ENGINE) });
          return null;
        } catch (e) {
          return e;
        }
      })();
      assert.ok(err, 'expected a non-zero exit when a fill is needed but the engine is absent');
      const stderr = String(err.stderr);
      assert.match(stderr, /methodology engine not found\/invalid/);
      assert.match(stderr, /npx @sabaiway\/agent-workflow-engine@latest init/);
      assert.equal(readFileSync(agents, 'utf8'), wrap('\n'), 'no partial write on STOP');
    });
  });

  it('explicit [fragment.md] override fills methodology ONLY and skips both engine + the orchestration slot', () => {
    const override = '> custom override fragment line\n';
    const fdir = mkdtempSync(join(tmpdir(), 'frag-'));
    tmpDirs.push(fdir);
    const fpath = join(fdir, 'frag.md');
    writeFileSync(fpath, override);
    withTempAgents(wrap('\n'), (agents) => {
      execFileSync(process.execPath, [SCRIPT, 'reconcile', agents, fpath], { stdio: 'pipe', env: withEngine(NO_ENGINE) });
      const out = readFileSync(agents, 'utf8');
      assert.equal(extractSlot(out).trim(), override.trim(), 'methodology filled from the explicit fragment');
      assert.ok(!hasOrchSlot(out), 'an explicit single-file override binds methodology only — no orchestration slot added');
    });
  });

  it('dual-block cap → orchestration pointer is SOFT-skipped (reported), the file is byte-unchanged (exit 0)', () => {
    // A 100-line entry point with a FILLED methodology slot + an EMPTY orchestration slot: filling the
    // orchestration slot would push it to 101 > 100, so it is skipped loudly while methodology stays.
    const head = [
      '# AGENTS.md',
      '',
      '## Session Protocols',
      '',
      'Read it before any code change.',
      '',
      START_MARKER,
      FRAGMENT.trim(),
      END_MARKER,
      ORCH_START_MARKER,
      ORCH_END_MARKER,
    ];
    const pad = Array.from({ length: AGENTS_MD_CAP - head.length }, (_, i) => `pad line ${i}`);
    const atCap = [...head, ...pad].join('\n') + '\n';
    withTempAgents(atCap, (agents) => {
      const out = execFileSync(process.execPath, [SCRIPT, 'reconcile', agents], { encoding: 'utf8', env: withEngine(ENGINE) });
      assert.match(out, /skipped/i, 'the orchestration cap-skip is reported, not silent');
      assert.equal(readFileSync(agents, 'utf8'), atCap, 'file byte-unchanged — the orchestration pointer was withheld, methodology already present');
    });
  });

  it('malformed orchestration pair → hard STOP (nonzero), file byte-unchanged (methodology fine)', () => {
    const malformedOrch =
      `# AGENTS.md\n\nintro line.\n\n${START_MARKER}\n${FRAGMENT.trim()}\n${END_MARKER}\n` +
      `${ORCH_START_MARKER}\n${ORCH_END_MARKER}\n${ORCH_START_MARKER}\n${ORCH_END_MARKER}\n`;
    withTempAgents(malformedOrch, (agents) => {
      assert.throws(() =>
        execFileSync(process.execPath, [SCRIPT, 'reconcile', agents], { stdio: 'pipe', env: withEngine(ENGINE) }),
      );
      assert.equal(readFileSync(agents, 'utf8'), malformedOrch, 'no partial write on an orchestration STOP');
    });
  });

  it('engine too old (no orchestration fragment) → methodology filled, orchestration SOFT-skipped (exit 0, not a regression)', () => {
    // A VALID engine that ships methodology-slot.md but NOT orchestration-slot.md (i.e. <1.2.0). The
    // methodology fill must NOT be discarded — only the recipes pointer is withheld, reported, exit 0.
    const oldEngine = makeEngineFixture(FRAGMENT, '1.0.0', null);
    withTempAgents(wrap('\n'), (agents) => {
      const out = execFileSync(process.execPath, [SCRIPT, 'reconcile', agents], { encoding: 'utf8', env: withEngine(oldEngine) });
      const text = readFileSync(agents, 'utf8');
      assert.equal(extractSlot(text).trim(), FRAGMENT.trim(), 'methodology pointer filled (not discarded by the too-old engine)');
      assert.match(out, /skipped/i, 'the orchestration skip is reported (not silent)');
      assert.match(out, /too old/i, 'the skip names the too-old-engine reason');
      assert.ok(!hasOrchSlot(text), 'a too-old engine adds no orchestration pointer');
    });
  });

  it('orchestration fragment PRESENT but unreadable → hard STOP (a corrupt engine is NOT mislabeled "too old")', () => {
    if (process.getuid && process.getuid() === 0) return; // root bypasses 0o000 perms — can't restrict
    const corruptEngine = makeEngineFixture(FRAGMENT, '1.2.0', '> orchestration line\n'); // both fragments present
    const orchPath = join(corruptEngine, 'references', 'orchestration-slot.md');
    chmodSync(orchPath, 0o000);
    let restricted = false;
    try {
      readFileSync(orchPath, 'utf8');
    } catch {
      restricted = true;
    }
    if (!restricted) {
      chmodSync(orchPath, 0o644); // exotic FS / perms ignored → can't exercise this path here
      return;
    }
    try {
      withTempAgents(wrap('\n'), (agents) => {
        assert.throws(() =>
          execFileSync(process.execPath, [SCRIPT, 'reconcile', agents], { stdio: 'pipe', env: withEngine(corruptEngine) }),
        );
        assert.equal(extractSlot(readFileSync(agents, 'utf8')).trim(), '', 'no partial write on a corrupt-fragment STOP');
      });
    } finally {
      chmodSync(orchPath, 0o644); // restore so the after() cleanup can remove the fixture
    }
  });

  it('fully absent engine + a fill needed → hard STOP (methodology fragment also unavailable)', () => {
    // Distinct from the too-old case: a fully absent engine cannot supply EITHER fragment, so the
    // methodology slot fill itself STOPs first — the dual-slot reconcile never silently no-ops.
    withTempAgents(wrap('\n'), (agents) => {
      assert.throws(() =>
        execFileSync(process.execPath, [SCRIPT, 'reconcile', agents], { stdio: 'pipe', env: withEngine(NO_ENGINE) }),
      );
      assert.equal(readFileSync(agents, 'utf8'), wrap('\n'), 'no partial write when the engine is fully absent');
    });
  });

  it('malformed slot → STOP with non-zero exit, file byte-unchanged (engine never consulted)', () => {
    const malformed = `${START_MARKER}\n${END_MARKER}\n${START_MARKER}\n${END_MARKER}\n`;
    withTempAgents(malformed, (agents) => {
      assert.throws(() =>
        execFileSync(process.execPath, [SCRIPT, 'reconcile', agents], { stdio: 'pipe', env: withEngine(NO_ENGINE) }),
      );
      assert.equal(readFileSync(agents, 'utf8'), malformed);
    });
  });

  it('legacy inject mode: markerless AGENTS.md → no-op WITHOUT the engine (exit 0)', () => {
    const markerless = '# AGENTS.md\n\nlegacy, no slot\n';
    withTempAgents(markerless, (agents) => {
      execFileSync(process.execPath, [SCRIPT, agents], { stdio: 'pipe', env: withEngine(NO_ENGINE) });
      assert.equal(readFileSync(agents, 'utf8'), markerless);
    });
  });

  // Legacy `inject` mode FORCE-OVERWRITES any present (ok) slot — filled or empty — unlike `reconcile`,
  // which preserves a filled slot. So for an ok slot it genuinely NEEDS the fragment and reads the
  // engine; the read-on-`state==='ok'` guard is correct (reading only an EMPTY ok slot would inject ''
  // and WIPE a filled slot). These two tests pin that contract.
  it('legacy inject mode: a FILLED slot is OVERWRITTEN from the live engine (engine present, exit 0)', () => {
    const filled = wrap('\nstale user content\n');
    withTempAgents(filled, (agents) => {
      execFileSync(process.execPath, [SCRIPT, agents], { stdio: 'pipe', env: withEngine(ENGINE) });
      const out = readFileSync(agents, 'utf8');
      assert.equal(extractSlot(out).trim(), FRAGMENT.trim(), 'slot overwritten with the live fragment');
      assert.ok(!out.includes('stale user content'), 'prior slot content replaced');
    });
  });

  it('legacy inject mode: a present (ok) slot + engine ABSENT → hard STOP, file unchanged', () => {
    const filled = wrap('\nstale user content\n');
    withTempAgents(filled, (agents) => {
      assert.throws(() =>
        execFileSync(process.execPath, [SCRIPT, agents], { stdio: 'pipe', env: withEngine(NO_ENGINE) }),
      );
      assert.equal(readFileSync(agents, 'utf8'), filled, 'no partial write on STOP');
    });
  });
});
