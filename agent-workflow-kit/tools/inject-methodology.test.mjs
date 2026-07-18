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
  AUTONOMY_START_MARKER,
  AUTONOMY_END_MARKER,
  ORCHESTRATION_DESCRIPTOR,
  AUTONOMY_DESCRIPTOR,
  METHODOLOGY_DESCRIPTOR,
  findMarkerSlot,
  extractMarkerSlot,
  reconcileMarkerSlot,
  markerSlotNeedsFill,
  markerSlotUpgradeHint,
  methodologyProceduresHint,
  isFillCapRefusal,
  injectIntoSlot,
  PROCEDURES_POINTER,
  KNOWN_PRIOR_METHODOLOGY_SLOT,
  KNOWN_PRIOR_ORCH_SLOT,
  runCli,
} from './inject-methodology.mjs';
import {
  COMMAND_REDLINES,
  NONCOMMAND_REDLINES,
  REDLINE_DEFAULTS,
  DEFAULT_ACTIVITY_AUTONOMY,
  AUTONOMY_REL,
} from './autonomy-config.mjs';

// Read the orchestration / autonomy slot content from a reconciled entry point.
const extractOrch = (text) => extractMarkerSlot(text, ORCHESTRATION_DESCRIPTOR);
const hasOrchSlot = (text) => findMarkerSlot(text, ORCHESTRATION_DESCRIPTOR).state === 'ok';
const extractAut = (text) => extractMarkerSlot(text, AUTONOMY_DESCRIPTOR);
const hasAutSlot = (text) => findMarkerSlot(text, AUTONOMY_DESCRIPTOR).state === 'ok';

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
// The THIRD bounded fragment (AD-044 Plan 3) — again distinct content.
const AUT_FRAGMENT =
  '> **Autonomy policy (test fixture)** — read `docs/ai/autonomy.json` at session start; set it with `/agent-workflow-kit set-autonomy`.\n';

// Temp dirs created by the fixtures below — cleaned up once after the whole file.
const tmpDirs = [];
after(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// A minimal but VALID installed-engine fixture: a methodology-engine capability.json + a SKILL.md
// whose metadata.version matches it (the validator's authoritative version source when there is no
// package.json) + ALL THREE live fragments (methodology + orchestration + autonomy). detectEngine
// accepts it; pass `orchFragment = null` / `autFragment = null` to model an OLDER engine that ships
// no orchestration / no autonomy fragment.
const makeEngineFixture = (fragment = FRAGMENT, version = '1.0.0', orchFragment = ORCH_FRAGMENT, autFragment = AUT_FRAGMENT) => {
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
  if (autFragment != null) writeFileSync(join(dir, 'references', 'autonomy-slot.md'), autFragment);
  return dir;
};

const ENGINE = makeEngineFixture();
// A path that is guaranteed NOT to be a valid engine — proves the no-op / explicit-override paths
// never consult the engine, and drives the fail-loud STOP.
const NO_ENGINE = join(tmpdir(), `definitely-no-engine-${process.pid}`);
const withEngine = (engineDir) => ({ ...process.env, AGENT_WORKFLOW_ENGINE_DIR: engineDir });

// In-process twin of the spawned CLI (the 5.2 conversion): same argv contract; a non-zero code
// throws the execFileSync-shaped error ({ status, stdout, stderr }). Two representative process
// spawns remain below as the real argv/exit-code E2E pins.
const runScript = async (args, { env = process.env } = {}) => {
  const { code, stdout, stderr } = await runCli(args, { env });
  if (code !== 0) {
    throw Object.assign(new Error(`inject-methodology exited ${code}\n${stderr}`), { status: code, stdout, stderr });
  }
  return stdout;
};

const wrap = (inner) =>
  `# AGENTS.md\n\nprefix bytes\n\n## Session Protocols\n\nintro line.\n\n${START_MARKER}${inner}${END_MARKER}\n\n## Hard Constraints\n\nsuffix bytes\n`;

// An entry point carrying BOTH reconciled slots (the orchestration pair sits right under the
// methodology pair, as the descriptor anchors it) — the deployed shape after a dual-slot reconcile.
const wrapDual = (methInner, orchInner) =>
  `# AGENTS.md\n\nprefix bytes\n\n## Session Protocols\n\nintro line.\n\n${START_MARKER}${methInner}${END_MARKER}\n${ORCH_START_MARKER}${orchInner}${ORCH_END_MARKER}\n\n## Hard Constraints\n\nsuffix bytes\n`;

// All THREE reconciled slots (autonomy chains right under the orchestration pair) — the deployed
// shape after a triple-slot reconcile.
const wrapTriple = (methInner, orchInner, autInner) =>
  `# AGENTS.md\n\nprefix bytes\n\n## Session Protocols\n\nintro line.\n\n${START_MARKER}${methInner}${END_MARKER}\n${ORCH_START_MARKER}${orchInner}${ORCH_END_MARKER}\n${AUTONOMY_START_MARKER}${autInner}${AUTONOMY_END_MARKER}\n\n## Hard Constraints\n\nsuffix bytes\n`;

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

// ── canonical-refresh (AD-025 §1.6a/§1.9): push a NEW canon clause to FILLED-but-stale slots, preserve a
//    customization, advise on the customized case. Covers BOTH the methodology + orchestration slots. ──
describe('canonical-refresh — refresh a known-prior slot, preserve a customization', () => {
  const PRIOR_METH = KNOWN_PRIOR_METHODOLOGY_SLOT[0];
  const PRIOR_ORCH = KNOWN_PRIOR_ORCH_SLOT[0];
  const NEW_METH = '> **Workflow methodology (new canon)** — see `/agent-workflow-kit procedures`. **Communication:** deliver the artifact inline.\n';
  const NEW_ORCH = '> **Orchestration recipes (new canon)** — `/agent-workflow-kit recipes`; set it with `/agent-workflow-kit set-recipe`.\n';
  const ENGINE_DIR = join(HERE, '..', '..', 'agent-workflow-engine');

  it('methodology: a slot filled with a KNOWN PRIOR is refreshed to the new fragment', () => {
    const stale = wrap(`\n${PRIOR_METH}\n`);
    assert.equal(slotNeedsFill(stale), true, 'a stale slot needs the fragment re-sourced');
    const out = reconcileSlot(stale, NEW_METH, { maxLines: AGENTS_MD_CAP });
    assert.equal(out.status, 'reconciled-refreshed');
    assert.equal(extractSlot(out.text).trim(), NEW_METH.trim());
  });

  it('methodology: a CUSTOMIZED slot is preserved verbatim (never matches a prior)', () => {
    const custom = wrap('\n> my own methodology note\n');
    assert.equal(slotNeedsFill(custom), false, 'a customization is not re-sourced');
    const out = reconcileSlot(custom, NEW_METH, { maxLines: AGENTS_MD_CAP });
    assert.equal(out.status, 'present-filled');
    assert.equal(out.text, custom, 'a customization is never overwritten');
  });

  it('orchestration: a known-prior slot refreshes; a customized one is preserved', () => {
    const stale = wrapDual('\nuser meth\n', `\n${PRIOR_ORCH}\n`);
    assert.equal(markerSlotNeedsFill(stale, ORCHESTRATION_DESCRIPTOR), true);
    const refreshed = reconcileMarkerSlot(stale, ORCHESTRATION_DESCRIPTOR, NEW_ORCH, { maxLines: AGENTS_MD_CAP });
    assert.equal(refreshed.status, 'reconciled-refreshed');
    assert.equal(extractOrch(refreshed.text).trim(), NEW_ORCH.trim());

    const custom = wrapDual('\nuser meth\n', '\n> my own orch note\n');
    assert.equal(markerSlotNeedsFill(custom, ORCHESTRATION_DESCRIPTOR), false);
    assert.equal(reconcileMarkerSlot(custom, ORCHESTRATION_DESCRIPTOR, NEW_ORCH, { maxLines: AGENTS_MD_CAP }).status, 'present-filled');
  });

  it('a prior carrying trailing-space / CRLF noise still matches (normalized)', () => {
    const trailing = reconcileSlot(wrap(`\n${PRIOR_METH}   \n`), NEW_METH, { maxLines: AGENTS_MD_CAP });
    assert.equal(trailing.status, 'reconciled-refreshed', 'a trailing-space prior still matches');
    const crlf = reconcileSlot(wrap(`\n${PRIOR_METH}\n`).replace(/\n/g, '\r\n'), NEW_METH, { maxLines: AGENTS_MD_CAP });
    assert.equal(crlf.status, 'reconciled-refreshed', 'a CRLF-noisy prior still matches');
  });

  it('the line cap is still enforced AFTER a refresh (over-cap → error, input unchanged)', () => {
    const stale = wrap(`\n${PRIOR_METH}\n`);
    const out = reconcileSlot(stale, NEW_METH, { maxLines: 3 });
    assert.equal(out.status, 'error');
    assert.equal(out.text, stale, 'an over-cap refresh leaves the input unchanged');
  });

  it('a new/empty slot still FILLS (not refreshed) — regression', () => {
    const out = reconcileSlot(wrap('\n'), NEW_METH, { maxLines: AGENTS_MD_CAP });
    assert.equal(out.status, 'reconciled-filled');
  });

  // Drift-guard: the SHIPPED engine fragment (current) must refresh a current-minus-one slot.
  it('current-minus-one → the SHIPPED new engine fragment (both slots)', () => {
    const realMeth = readFileSync(join(ENGINE_DIR, 'references', 'methodology-slot.md'), 'utf8');
    const realOrch = readFileSync(join(ENGINE_DIR, 'references', 'orchestration-slot.md'), 'utf8');
    assert.notEqual(realMeth.trim(), PRIOR_METH, 'the shipped methodology fragment must differ from its prior');
    assert.notEqual(realOrch.trim(), PRIOR_ORCH, 'the shipped orchestration fragment must differ from its prior');
    const m = reconcileSlot(wrap(`\n${PRIOR_METH}\n`), realMeth, { maxLines: AGENTS_MD_CAP });
    assert.equal(m.status, 'reconciled-refreshed');
    assert.equal(extractSlot(m.text).trim(), realMeth.trim());
    const o = reconcileMarkerSlot(wrapDual('\nuser\n', `\n${PRIOR_ORCH}\n`), ORCHESTRATION_DESCRIPTOR, realOrch, { maxLines: AGENTS_MD_CAP });
    assert.equal(o.status, 'reconciled-refreshed');
    assert.equal(extractOrch(o.text).trim(), realOrch.trim());
  });
});

describe('markerSlotUpgradeHint — read-only advisory for a customized slot missing the new clause', () => {
  it('methodology: a filled slot WITHOUT "Communication" gets the advice; with it → null', () => {
    const without = wrap('\n> custom methodology note (no comms clause)\n');
    const hint = markerSlotUpgradeHint(without, METHODOLOGY_DESCRIPTOR);
    assert.match(hint, /communication-contract|deliver the artifact/);
    const realMeth = readFileSync(join(HERE, '..', '..', 'agent-workflow-engine', 'references', 'methodology-slot.md'), 'utf8');
    assert.ok(realMeth.includes('Communication'), 'the shipped methodology fragment carries the Communication clause');
    const withClause = wrap(`\n${realMeth.trim()}\n`);
    assert.equal(markerSlotUpgradeHint(withClause, METHODOLOGY_DESCRIPTOR), null, 'a slot already carrying the clause gets no advice');
  });

  it('orchestration: a customized slot missing the set-recipe pointer gets the advice; with it → null', () => {
    const without = wrapDual('\nm\n', '\n> custom orch note, no set-recipe\n');
    const hint = markerSlotUpgradeHint(without, ORCHESTRATION_DESCRIPTOR);
    assert.match(hint, /read-at-start|set-recipe/);
    const realOrch = readFileSync(join(HERE, '..', '..', 'agent-workflow-engine', 'references', 'orchestration-slot.md'), 'utf8');
    const withClause = wrapDual('\nm\n', `\n${realOrch.trim()}\n`);
    assert.equal(markerSlotUpgradeHint(withClause, ORCHESTRATION_DESCRIPTOR), null, 'a slot already carrying the clause gets no advice');
  });

  it('an empty / absent slot gets no advice', () => {
    assert.equal(markerSlotUpgradeHint(wrapDual('\nm\n', '\n'), ORCHESTRATION_DESCRIPTOR), null);
    assert.equal(markerSlotUpgradeHint('# AGENTS.md\nno slot\n', ORCHESTRATION_DESCRIPTOR), null);
  });

  it('autonomy: a customized slot missing the policy-file name gets the advice; the real fragment → null', () => {
    const without = wrapTriple('\nm\n', '\no\n', '\n> custom autonomy note, no policy file named\n');
    const hint = markerSlotUpgradeHint(without, AUTONOMY_DESCRIPTOR);
    assert.match(hint, /docs\/ai\/autonomy\.json|set-autonomy/);
    const realAut = readFileSync(join(HERE, '..', '..', 'agent-workflow-engine', 'references', 'autonomy-slot.md'), 'utf8');
    const withClause = wrapTriple('\nm\n', '\no\n', `\n${realAut.trim()}\n`);
    assert.equal(markerSlotUpgradeHint(withClause, AUTONOMY_DESCRIPTOR), null, 'a slot carrying the current canon gets no advice');
  });
});

// ── AD-044 Plan 3 — the third (autonomy) descriptor: reconcile statuses, the chained anchor, and
//    the cap behavior, all against the SAME generic engine (pure functions, no fs). ──
describe('AUTONOMY_DESCRIPTOR — third-slot reconcile statuses + chained anchor position', () => {
  it('meth+orch present, autonomy absent → reconciled-inserted right below the orchestration end marker', () => {
    const input = wrapDual('\nm\n', '\no\n');
    const out = reconcileMarkerSlot(input, AUTONOMY_DESCRIPTOR, AUT_FRAGMENT, { maxLines: AGENTS_MD_CAP });
    assert.equal(out.status, 'reconciled-inserted');
    assert.equal(extractAut(out.text).trim(), AUT_FRAGMENT.trim());
    // The chained anchor position: the autonomy start marker line follows the orchestration end line.
    const lines = out.text.split('\n');
    const orchEndAt = lines.findIndex((l) => l.includes(ORCH_END_MARKER));
    assert.equal(lines[orchEndAt + 1].includes(AUTONOMY_START_MARKER), true, 'autonomy pair chains directly below the orchestration pair');
    assert.equal(extractSlot(out.text), '\nm\n', 'methodology bytes preserved');
    assert.equal(extractOrch(out.text), '\no\n', 'orchestration bytes preserved');
  });

  it('present empty autonomy pair → reconciled-filled', () => {
    const out = reconcileMarkerSlot(wrapTriple('\nm\n', '\no\n', '\n'), AUTONOMY_DESCRIPTOR, AUT_FRAGMENT, { maxLines: AGENTS_MD_CAP });
    assert.equal(out.status, 'reconciled-filled');
    assert.equal(extractAut(out.text).trim(), AUT_FRAGMENT.trim());
  });

  it('a FILLED autonomy slot is ALWAYS custom-preserved — refreshed is unreachable with empty priors', () => {
    assert.deepEqual(AUTONOMY_DESCRIPTOR.knownPriorCanonicals, [], 'first canon: no known priors yet');
    // Even a slot carrying the CURRENT fragment verbatim is preserved (it matches no PRIOR) — the
    // refresh lane only opens once a future release appends the outgoing content to a prior store.
    for (const inner of ['\nuser autonomy customization\n', `\n${AUT_FRAGMENT.trim()}\n`]) {
      const input = wrapTriple('\nm\n', '\no\n', inner);
      assert.equal(markerSlotNeedsFill(input, AUTONOMY_DESCRIPTOR), false, 'a filled slot is never re-sourced');
      const out = reconcileMarkerSlot(input, AUTONOMY_DESCRIPTOR, AUT_FRAGMENT, { maxLines: AGENTS_MD_CAP });
      assert.equal(out.status, 'present-filled');
      assert.equal(out.text, input, 'preserved byte-for-byte');
    }
  });

  it('malformed autonomy pair → error, input returned byte-for-byte', () => {
    const input = `${AUTONOMY_START_MARKER}\n${AUTONOMY_END_MARKER}\n${AUTONOMY_START_MARKER}\n${AUTONOMY_END_MARKER}\n`;
    const out = reconcileMarkerSlot(input, AUTONOMY_DESCRIPTOR, AUT_FRAGMENT, { maxLines: AGENTS_MD_CAP });
    assert.equal(out.status, 'error');
    assert.equal(out.text, input);
  });

  it('combined-cap refusal — a fill that would bust the cap errors atomically (input unchanged)', () => {
    const input = wrapDual('\nm\n', '\no\n');
    const out = reconcileMarkerSlot(input, AUTONOMY_DESCRIPTOR, AUT_FRAGMENT, { maxLines: 5 });
    assert.equal(out.status, 'error');
    assert.match(out.error, /cap 5/);
    assert.equal(out.text, input);
  });
});

// ── D4 cap-lane honesty: the CLI's autonomy lane soft-skips ONLY the genuine fill-overflow; an
//    already-over-cap custom file keeps its distinct over-cap report. Pinned against the REAL
//    messages the pure functions produce — never retyped strings. ──
describe('isFillCapRefusal — the D4 cap-lane split over the real cap messages', () => {
  it('TRUE on the fill-overflow message from an in-cap input (injectIntoSlot refusal)', () => {
    const fillOverflow = injectIntoSlot(wrapTriple('\nm\n', '\no\n', '\n'), AUTONOMY_DESCRIPTOR, AUT_FRAGMENT, { maxLines: 5 });
    assert.equal(fillOverflow.status, 'error');
    assert.match(fillOverflow.error, /\(cap 5\)/, 'sanity: the message carries the shared "(cap N)" substring');
    assert.equal(isFillCapRefusal(fillOverflow.error), true, 'a genuine fill-overflow is the soft skip');
  });

  it('FALSE on the already-over-cap custom-file message (reconcileMarkerSlot refusal) — keeps its distinct report', () => {
    const overCap = reconcileMarkerSlot(wrapTriple('\nm\n', '\no\n', '\ncustom\n'), AUTONOMY_DESCRIPTOR, AUT_FRAGMENT, { maxLines: 5 });
    assert.equal(overCap.status, 'error');
    assert.match(overCap.error, /\(cap 5\)/, 'sanity: this message carries the SAME "(cap N)" substring the old classifier conflated');
    assert.match(overCap.error, /trim the file/, 'sanity: it is the over-cap-custom-file message');
    assert.equal(isFillCapRefusal(overCap.error), false, 'an over-cap file is NOT a fill skip — it keeps the over-cap report');
  });
});

// ── D3 both-directions parity: the ENGINE fragment must carry the kit's REAL command tokens and the
//    kit's REAL canonical default floor — sourced from the kit's own exports, never retyped (the
//    engine-side canon guard pins the same strings as literals; this is the kit-side pair). ──
describe('engine autonomy-slot.md ⟷ kit parity (D3 tokens from the kit exports)', () => {
  const realAut = readFileSync(join(HERE, '..', '..', 'agent-workflow-engine', 'references', 'autonomy-slot.md'), 'utf8');

  it('is exactly one content line and names the kit command tokens', () => {
    assert.equal(realAut.split('\n').filter((l) => l.trim()).length, 1, 'one content line (the slot budget)');
    assert.match(realAut, /set-autonomy/, 'names the policy writer');
    assert.match(realAut, /autonomy-doctor/, 'names the sandbox provisioner');
    assert.ok(realAut.includes(AUTONOMY_REL), 'names the policy file by its kit-exported rel path');
  });

  it('states the concrete default floor from REDLINE_DEFAULTS / DEFAULT_ACTIVITY_AUTONOMY (not retyped)', () => {
    const soleDefault = (keys) => {
      const values = new Set(keys.map((k) => REDLINE_DEFAULTS[k]));
      assert.equal(values.size, 1, `the ${keys.join('/')} red-lines share one default`);
      return [...values][0];
    };
    const commandFloor = `${COMMAND_REDLINES.join('/')} \`${soleDefault(COMMAND_REDLINES)}\``;
    const nonCommandFloor = `${NONCOMMAND_REDLINES.join('/').replaceAll('_', '-')} \`${soleDefault(NONCOMMAND_REDLINES)}\``;
    assert.ok(realAut.includes(commandFloor), `fragment states "${commandFloor}"`);
    assert.ok(realAut.includes(nonCommandFloor), `fragment states "${nonCommandFloor}"`);
    assert.ok(realAut.includes(`floors at \`${DEFAULT_ACTIVITY_AUTONOMY}\``), 'the absent-activity floor comes from the kit export');
  });

  it('the descriptor upgrade signature is present in the current fragment (a filled current slot gets no advice)', () => {
    assert.ok(realAut.includes(AUTONOMY_DESCRIPTOR.upgradeSignature), 'the fragment carries its own canonical-signature token');
  });
});

describe('reconcile CLI — atomic ensure+inject-if-empty+cap, reading the fragment LIVE from the engine', () => {
  const withTempAgents = async (contents, run) => {
    const dir = mkdtempSync(join(tmpdir(), 'reconcile-cli-'));
    const agents = join(dir, 'AGENTS.md');
    writeFileSync(agents, contents);
    try {
      return await run(agents);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('markerless legacy (with anchor) → ALL THREE slots inserted + filled from their own live engine fragments (exit 0)', async () => {
    await withTempAgents(legacyWithAnchor(), (agents) => {
      // E2E process-spawn pin №1 (success lane): the real argv + exit-code contract.
      execFileSync(process.execPath, [SCRIPT, 'reconcile', agents], { stdio: 'pipe', env: withEngine(ENGINE) });
      const out = readFileSync(agents, 'utf8');
      assert.equal(findSlot(out).state, 'ok');
      assert.equal(extractSlot(out).trim(), FRAGMENT.trim(), 'methodology slot filled from the methodology fragment');
      assert.ok(hasOrchSlot(out), 'the orchestration slot was inserted below the methodology pair');
      assert.equal(extractOrch(out).trim(), ORCH_FRAGMENT.trim(), 'orchestration slot filled from the orchestration fragment');
      assert.ok(hasAutSlot(out), 'the autonomy slot was inserted below the orchestration pair');
      assert.equal(extractAut(out).trim(), AUT_FRAGMENT.trim(), 'autonomy slot filled from the autonomy fragment');
    });
  });

  it('present empty methodology slot → ALL THREE slots filled; each from its OWN engine fragment (exit 0)', async () => {
    await withTempAgents(wrap('\n'), async (agents) => {
      await runScript(['reconcile', agents], { env: withEngine(ENGINE) });
      const out = readFileSync(agents, 'utf8');
      assert.equal(extractSlot(out).trim(), FRAGMENT.trim());
      assert.equal(extractOrch(out).trim(), ORCH_FRAGMENT.trim());
      assert.equal(extractAut(out).trim(), AUT_FRAGMENT.trim());
      // Per-slot fragment sourcing: the three slots carry DIFFERENT content (not all the methodology one).
      assert.equal(new Set([extractSlot(out).trim(), extractOrch(out).trim(), extractAut(out).trim()]).size, 3);
    });
  });

  it('ALL THREE slots already filled → zero-diff no-op WITHOUT consulting the engine (engine absent, exit 0)', async () => {
    const custom = wrapTriple('\nuser meth notes\n', '\nuser orch notes\n', '\nuser autonomy notes\n');
    await withTempAgents(custom, async (agents) => {
      // Engine pointed at a path that does not exist — a fully-filled entry point must NOT require it.
      const out = await runScript(['reconcile', agents], { env: withEngine(NO_ENGINE) });
      assert.equal(readFileSync(agents, 'utf8'), custom);
      assert.match(out, /all three pointers already present and filled/, 'the zero-diff report names all three pointers');
    });
  });

  it('meth+orch filled, autonomy markers ABSENT + engine fully ABSENT → hard STOP (a fill is needed; install command shown)', async () => {
    // The autonomy pair chains below a PRESENT orchestration pair, so a fill is genuinely needed —
    // and a fully absent/invalid engine cannot supply ANY fragment: the same hard STOP as the
    // methodology/orchestration lanes, never a silent drop (distinct from the too-old soft skip).
    const custom = wrapDual('\nuser meth notes\n', '\nuser orch notes\n');
    await withTempAgents(custom, async (agents) => {
      const err = await runScript(['reconcile', agents], { env: withEngine(NO_ENGINE) }).then(() => null, (e) => e);
      assert.ok(err, 'expected a non-zero exit when the autonomy fill is needed but the engine is fully absent');
      assert.match(String(err.stderr), /methodology engine not found\/invalid/);
      assert.match(String(err.stderr), /npx @sabaiway\/agent-workflow-engine@latest init/);
      assert.equal(readFileSync(agents, 'utf8'), custom, 'no partial write on STOP');
    });
  });

  it('meth+orch customized, EMPTY autonomy pair → only the autonomy slot is filled; the custom fills survive byte-for-byte', async () => {
    const custom = wrapTriple('\nuser meth notes\n', '\nuser orch notes\n', '\n');
    await withTempAgents(custom, async (agents) => {
      const out = await runScript(['reconcile', agents], { env: withEngine(ENGINE) });
      const text = readFileSync(agents, 'utf8');
      assert.equal(extractSlot(text), '\nuser meth notes\n', 'methodology customization preserved byte-for-byte');
      assert.equal(extractOrch(text), '\nuser orch notes\n', 'orchestration customization preserved byte-for-byte');
      assert.equal(extractAut(text).trim(), AUT_FRAGMENT.trim(), 'the empty autonomy pointer was filled');
      assert.match(out, /filled the empty autonomy pointer/);
    });
  });

  it('present empty slot + engine ABSENT → hard STOP (nonzero) printing the install command, file unchanged', async () => {
    await withTempAgents(wrap('\n'), (agents) => {
      // E2E process-spawn pin №2 (STOP lane): the real non-zero exit + stderr through the process.
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

  it('explicit [fragment.md] override fills methodology ONLY and skips both engine + the orchestration slot', async () => {
    const override = '> custom override fragment line\n';
    const fdir = mkdtempSync(join(tmpdir(), 'frag-'));
    tmpDirs.push(fdir);
    const fpath = join(fdir, 'frag.md');
    writeFileSync(fpath, override);
    await withTempAgents(wrap('\n'), async (agents) => {
      await runScript(['reconcile', agents, fpath], { env: withEngine(NO_ENGINE) });
      const out = readFileSync(agents, 'utf8');
      assert.equal(extractSlot(out).trim(), override.trim(), 'methodology filled from the explicit fragment');
      assert.ok(!hasOrchSlot(out), 'an explicit single-file override binds methodology only — no orchestration slot added');
      assert.ok(!hasAutSlot(out), 'an explicit single-file override binds methodology only — no autonomy slot added');
    });
  });

  it('dual-block cap → orchestration pointer is SOFT-skipped (reported), the file is byte-unchanged (exit 0)', async () => {
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
    await withTempAgents(atCap, async (agents) => {
      const out = await runScript(['reconcile', agents], { env: withEngine(ENGINE) });
      assert.match(out, /skipped/i, 'the orchestration cap-skip is reported, not silent');
      assert.equal(readFileSync(agents, 'utf8'), atCap, 'file byte-unchanged — the orchestration pointer was withheld, methodology already present');
    });
  });

  it('malformed orchestration pair → hard STOP (nonzero), file byte-unchanged (methodology fine)', async () => {
    const malformedOrch =
      `# AGENTS.md\n\nintro line.\n\n${START_MARKER}\n${FRAGMENT.trim()}\n${END_MARKER}\n` +
      `${ORCH_START_MARKER}\n${ORCH_END_MARKER}\n${ORCH_START_MARKER}\n${ORCH_END_MARKER}\n`;
    await withTempAgents(malformedOrch, async (agents) => {
      await assert.rejects(runScript(['reconcile', agents], { env: withEngine(ENGINE) }));
      assert.equal(readFileSync(agents, 'utf8'), malformedOrch, 'no partial write on an orchestration STOP');
    });
  });

  it('engine too old (no orchestration fragment) → methodology filled, orchestration SOFT-skipped (exit 0, not a regression)', async () => {
    // A VALID engine that ships methodology-slot.md but NOT orchestration-slot.md (i.e. <1.2.0 —
    // it predates the autonomy fragment too). The methodology fill must NOT be discarded — only
    // the chained pointers are withheld, reported, exit 0.
    const oldEngine = makeEngineFixture(FRAGMENT, '1.0.0', null, null);
    await withTempAgents(wrap('\n'), async (agents) => {
      const out = await runScript(['reconcile', agents], { env: withEngine(oldEngine) });
      const text = readFileSync(agents, 'utf8');
      assert.equal(extractSlot(text).trim(), FRAGMENT.trim(), 'methodology pointer filled (not discarded by the too-old engine)');
      assert.match(out, /skipped/i, 'the orchestration skip is reported (not silent)');
      assert.match(out, /too old/i, 'the skip names the too-old-engine reason');
      assert.ok(!hasOrchSlot(text), 'a too-old engine adds no orchestration pointer');
      assert.ok(!hasAutSlot(text), 'a too-old engine adds no autonomy pointer either');
    });
  });

  it('orchestration fragment PRESENT but unreadable → hard STOP (a corrupt engine is NOT mislabeled "too old")', async () => {
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
      await withTempAgents(wrap('\n'), async (agents) => {
        await assert.rejects(runScript(['reconcile', agents], { env: withEngine(corruptEngine) }));
        assert.equal(extractSlot(readFileSync(agents, 'utf8')).trim(), '', 'no partial write on a corrupt-fragment STOP');
      });
    } finally {
      chmodSync(orchPath, 0o644); // restore so the after() cleanup can remove the fixture
    }
  });

  // ── the THREE D4 autonomy soft-skip lanes: every one is LOUD, preserves the prior fills, exit 0 ──

  it('D4 (i) engine too old for the AUTONOMY fragment only → meth+orch filled, autonomy SOFT-skipped (exit 0)', async () => {
    // The realistic post-Plan-3 install base: a current engine that predates references/autonomy-slot.md.
    const preAutonomyEngine = makeEngineFixture(FRAGMENT, '1.14.0', ORCH_FRAGMENT, null);
    await withTempAgents(wrap('\n'), async (agents) => {
      const out = await runScript(['reconcile', agents], { env: withEngine(preAutonomyEngine) });
      const text = readFileSync(agents, 'utf8');
      assert.equal(extractSlot(text).trim(), FRAGMENT.trim(), 'methodology fill preserved and written');
      assert.equal(extractOrch(text).trim(), ORCH_FRAGMENT.trim(), 'orchestration fill preserved and written');
      assert.ok(!hasAutSlot(text), 'no autonomy pointer from a pre-autonomy engine');
      assert.match(out, /autonomy pointer skipped/i, 'the autonomy skip is reported, not silent');
      assert.match(out, /too old/i, 'the skip names the too-old-engine reason');
    });
  });

  it('D4 (ii) autonomy fill would bust the cap → SOFT skip (loud), prior fills intact, byte-unchanged (exit 0)', async () => {
    // An at-cap file with FILLED meth+orch and an EMPTY autonomy pair: the fill overflows 100 → the
    // pointer is withheld with the fill-overflow message, never a hard STOP, never silent.
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
      ORCH_FRAGMENT.trim(),
      ORCH_END_MARKER,
      AUTONOMY_START_MARKER,
      AUTONOMY_END_MARKER,
    ];
    const pad = Array.from({ length: AGENTS_MD_CAP - head.length }, (_, i) => `pad line ${i}`);
    const atCap = [...head, ...pad].join('\n') + '\n';
    await withTempAgents(atCap, async (agents) => {
      const out = await runScript(['reconcile', agents], { env: withEngine(ENGINE) });
      assert.match(out, /autonomy pointer skipped/i, 'the autonomy cap-skip is reported, not silent');
      assert.match(out, /injection would push/, 'the skip carries the genuine fill-overflow reason');
      assert.equal(readFileSync(agents, 'utf8'), atCap, 'file byte-unchanged — the autonomy pointer was withheld');
    });
  });

  it('D4 (iii-a) anchor absent because the orchestration fill was CAP-skipped on a near-cap markerless file → autonomy SOFT-skipped, methodology fill kept (exit 0)', async () => {
    // 96 content lines + the methodology insert(3)+fill(1) = 100 (fits); the orchestration
    // insert(2)+fill(1) would hit 103 → orch cap-skips WITHOUT inserting its markers → the autonomy
    // anchor (the orchestration end marker) is absent → the chained soft skip, NOT a 0-anchors STOP
    // that would discard the methodology fill.
    const base = legacyWithAnchor(); // 14 lines
    const pad = Array.from({ length: 96 - base.split('\n').length + 1 }, (_, i) => `pad ${i}`).join('\n');
    const nearCap = `${base}${pad}\n`;
    await withTempAgents(nearCap, async (agents) => {
      const out = await runScript(['reconcile', agents], { env: withEngine(ENGINE) });
      const text = readFileSync(agents, 'utf8');
      assert.equal(extractSlot(text).trim(), FRAGMENT.trim(), 'the methodology fill landed and was NOT discarded');
      assert.ok(!hasOrchSlot(text), 'the orchestration pair was withheld (cap)');
      assert.ok(!hasAutSlot(text), 'no autonomy pair without its anchor');
      assert.match(out, /orchestration-recipes pointer skipped/i);
      // Anchored to the SKIP CLAUSE itself — a bare /anchor/ over the whole combined stdout line is
      // vacuous (describeMeth always says "Session-Protocols anchor" on an inserted methodology).
      assert.match(
        out,
        /autonomy pointer skipped — chained below the orchestration pointer, which was itself skipped/,
        'the chained lane is a loud soft skip that names its reason',
      );
    });
  });

  // NB the double space in "orch  EMPTY" is load-bearing: a historical bound fixable-bug
  // testId pins this name as a regex — do not "fix" the spacing (it would unbind the fold proof).
  it('D4 causal chain: EMPTY orch  EMPTY autonomy pairs + an engine shipping the AUTONOMY fragment but NOT the orchestration one → autonomy stays EMPTY (never fills under a withheld recipes pointer)', async () => {
    const partialEngine = makeEngineFixture(FRAGMENT, '1.0.0', null, AUT_FRAGMENT);
    await withTempAgents(wrapTriple('\n', '\n', '\n'), async (agents) => {
      const out = await runScript(['reconcile', agents], { env: withEngine(partialEngine) });
      const text = readFileSync(agents, 'utf8');
      assert.equal(extractSlot(text).trim(), FRAGMENT.trim(), 'methodology filled');
      assert.equal(extractOrch(text).trim(), '', 'orchestration stays empty (too-old skip)');
      assert.equal(extractAut(text).trim(), '', 'autonomy stays EMPTY — the chain is causal, not merely positional');
      assert.match(out, /orchestration-recipes pointer skipped/i);
      assert.match(out, /autonomy pointer skipped — chained below the orchestration pointer/, 'the short-circuit is loud');
    });
  });

  it('D4 (iii-b) anchor absent because a legacy markerless file met an engine lacking orchestration-slot.md → autonomy SOFT-skipped, methodology fill kept (exit 0)', async () => {
    const oldEngine = makeEngineFixture(FRAGMENT, '1.0.0', null, null);
    await withTempAgents(legacyWithAnchor(), async (agents) => {
      const out = await runScript(['reconcile', agents], { env: withEngine(oldEngine) });
      const text = readFileSync(agents, 'utf8');
      assert.equal(extractSlot(text).trim(), FRAGMENT.trim(), 'the methodology fill landed and was NOT discarded');
      assert.ok(!hasOrchSlot(text) && !hasAutSlot(text), 'neither chained pair was inserted');
      assert.match(out, /orchestration-recipes pointer skipped/i, 'the orchestration too-old skip is reported');
      assert.match(out, /autonomy pointer skipped — chained below the orchestration pointer/, 'the chained skip is reported with its reason');
    });
  });

  it('an autonomy fragment that itself CONTAINS the marker → hard STOP (never a mislabeled soft skip), no partial write', async () => {
    // The non-cap reconcile error lane: injectIntoSlot refuses a fragment carrying the slot marker
    // (it would nest/duplicate the pair) — not a cap message, so the CLI must hard-STOP.
    const markerEngine = makeEngineFixture(FRAGMENT, '1.15.0', ORCH_FRAGMENT, `bad ${AUTONOMY_START_MARKER} fragment\n`);
    const custom = wrapTriple('\nuser meth\n', '\nuser orch\n', '\n');
    await withTempAgents(custom, async (agents) => {
      const err = await runScript(['reconcile', agents], { env: withEngine(markerEngine) }).then(() => null, (e) => e);
      assert.ok(err, 'expected a non-zero exit');
      assert.match(String(err.stderr), /reconcile refused \(autonomy\)/);
      assert.equal(readFileSync(agents, 'utf8'), custom, 'no partial write');
    });
  });

  it('D7: autonomy fragment PRESENT but unreadable → hard STOP (a corrupt engine is NOT mislabeled "too old")', async () => {
    if (process.getuid && process.getuid() === 0) return; // root bypasses 0o000 perms — can't restrict
    const corruptEngine = makeEngineFixture(FRAGMENT, '1.15.0', ORCH_FRAGMENT, '> autonomy line\n');
    const autPath = join(corruptEngine, 'references', 'autonomy-slot.md');
    chmodSync(autPath, 0o000);
    let restricted = false;
    try {
      readFileSync(autPath, 'utf8');
    } catch {
      restricted = true;
    }
    if (!restricted) {
      chmodSync(autPath, 0o644); // exotic FS / perms ignored → can't exercise this path here
      return;
    }
    try {
      await withTempAgents(wrap('\n'), async (agents) => {
        await assert.rejects(runScript(['reconcile', agents], { env: withEngine(corruptEngine) }));
        assert.equal(extractSlot(readFileSync(agents, 'utf8')).trim(), '', 'no partial write on a corrupt-fragment STOP');
      });
    } finally {
      chmodSync(autPath, 0o644); // restore so the after() cleanup can remove the fixture
    }
  });

  it('malformed AUTONOMY pair + orchestration SKIPPED this run → still a hard STOP, no partial methodology write', async () => {
    // The causal short-circuit must never outrank marker validation: with the orchestration
    // pointer withheld (too-old engine) AND a duplicate autonomy pair, the run STOPs — a soft
    // "skip" here would write the methodology fill beside malformed markers.
    const preAutonomyEngine = makeEngineFixture(FRAGMENT, '1.14.0', null, null);
    const malformedAut =
      `# AGENTS.md\n\nintro line.\n\n${START_MARKER}\n${END_MARKER}\n` +
      `${AUTONOMY_START_MARKER}\n${AUTONOMY_END_MARKER}\n${AUTONOMY_START_MARKER}\n${AUTONOMY_END_MARKER}\n`;
    await withTempAgents(malformedAut, async (agents) => {
      const err = await runScript(['reconcile', agents], { env: withEngine(preAutonomyEngine) }).then(() => null, (e) => e);
      assert.ok(err, 'expected a non-zero exit');
      assert.match(String(err.stderr), /reconcile refused \(autonomy\)/, 'the STOP names the autonomy lane');
      assert.equal(readFileSync(agents, 'utf8'), malformedAut, 'no partial write — the methodology fill was discarded');
    });
  });

  it('malformed AUTONOMY pair → hard STOP (nonzero), file byte-unchanged (prior slots fine)', async () => {
    const malformedAut =
      `# AGENTS.md\n\nintro line.\n\n${START_MARKER}\n${FRAGMENT.trim()}\n${END_MARKER}\n` +
      `${ORCH_START_MARKER}\n${ORCH_FRAGMENT.trim()}\n${ORCH_END_MARKER}\n` +
      `${AUTONOMY_START_MARKER}\n${AUTONOMY_END_MARKER}\n${AUTONOMY_START_MARKER}\n${AUTONOMY_END_MARKER}\n`;
    await withTempAgents(malformedAut, async (agents) => {
      await assert.rejects(runScript(['reconcile', agents], { env: withEngine(ENGINE) }));
      assert.equal(readFileSync(agents, 'utf8'), malformedAut, 'no partial write on an autonomy STOP');
    });
  });

  it('fully absent engine + a fill needed → hard STOP (methodology fragment also unavailable)', async () => {
    // Distinct from the too-old case: a fully absent engine cannot supply EITHER fragment, so the
    // methodology slot fill itself STOPs first — the dual-slot reconcile never silently no-ops.
    await withTempAgents(wrap('\n'), async (agents) => {
      await assert.rejects(runScript(['reconcile', agents], { env: withEngine(NO_ENGINE) }));
      assert.equal(readFileSync(agents, 'utf8'), wrap('\n'), 'no partial write when the engine is fully absent');
    });
  });

  it('malformed slot → STOP with non-zero exit, file byte-unchanged (engine never consulted)', async () => {
    const malformed = `${START_MARKER}\n${END_MARKER}\n${START_MARKER}\n${END_MARKER}\n`;
    await withTempAgents(malformed, async (agents) => {
      await assert.rejects(runScript(['reconcile', agents], { env: withEngine(NO_ENGINE) }));
      assert.equal(readFileSync(agents, 'utf8'), malformed);
    });
  });

  it('legacy inject mode: markerless AGENTS.md → no-op WITHOUT the engine (exit 0)', async () => {
    const markerless = '# AGENTS.md\n\nlegacy, no slot\n';
    await withTempAgents(markerless, async (agents) => {
      await runScript([agents], { env: withEngine(NO_ENGINE) });
      assert.equal(readFileSync(agents, 'utf8'), markerless);
    });
  });

  // Legacy `inject` mode FORCE-OVERWRITES any present (ok) slot — filled or empty — unlike `reconcile`,
  // which preserves a filled slot. So for an ok slot it genuinely NEEDS the fragment and reads the
  // engine; the read-on-`state==='ok'` guard is correct (reading only an EMPTY ok slot would inject ''
  // and WIPE a filled slot). These two tests pin that contract.
  it('legacy inject mode: a FILLED slot is OVERWRITTEN from the live engine (engine present, exit 0)', async () => {
    const filled = wrap('\nstale user content\n');
    await withTempAgents(filled, async (agents) => {
      await runScript([agents], { env: withEngine(ENGINE) });
      const out = readFileSync(agents, 'utf8');
      assert.equal(extractSlot(out).trim(), FRAGMENT.trim(), 'slot overwritten with the live fragment');
      assert.ok(!out.includes('stale user content'), 'prior slot content replaced');
    });
  });

  it('legacy inject mode: a present (ok) slot + engine ABSENT → hard STOP, file unchanged', async () => {
    const filled = wrap('\nstale user content\n');
    await withTempAgents(filled, async (agents) => {
      await assert.rejects(runScript([agents], { env: withEngine(NO_ENGINE) }));
      assert.equal(readFileSync(agents, 'utf8'), filled, 'no partial write on STOP');
    });
  });
});

// AD-019 §3.1a — the read-only upgrade advisory: a FILLED methodology pointer lacking the procedures
// route gets a hint (it can't be auto-re-rendered, reconcile preserves a filled slot verbatim); a slot
// that already routes to procedures, or an empty / absent / malformed slot, is silent. NO mutation.
describe('methodologyProceduresHint — read-only upgrade advisory (§3.1a)', () => {
  it('a filled methodology slot WITHOUT the procedures route → a hint naming the procedures command', () => {
    const entry = wrap('\n> methodology notes the user wrote, no procedures route here\n');
    const hint = methodologyProceduresHint(entry);
    assert.ok(hint, 'a filled-without-clause slot yields a hint');
    assert.match(hint, new RegExp(PROCEDURES_POINTER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('a filled methodology slot that ALREADY routes to procedures → silent (null)', () => {
    const entry = wrap(`\n> methodology — see ${PROCEDURES_POINTER} <activity> for the steps\n`);
    assert.equal(methodologyProceduresHint(entry), null);
  });

  it('an empty methodology slot → silent (null) — only a filled slot is advised', () => {
    assert.equal(methodologyProceduresHint(wrap('\n')), null);
  });

  it('an absent / malformed methodology slot → silent (null)', () => {
    assert.equal(methodologyProceduresHint('# AGENTS.md\n\nno slot here\n'), null);
    assert.equal(methodologyProceduresHint(`${START_MARKER}\n${END_MARKER}\n${START_MARKER}\n${END_MARKER}\n`), null);
  });

  it('is read-only: a pre-filled-without-clause deployment is reported, not mutated, on reconcile (engine absent)', async () => {
    // A triple-filled entry point whose methodology lacks the procedures route: reconcile is a zero-diff
    // no-op (filled slots preserved) yet still surfaces the hint on stdout — never rewrites the file.
    const custom = wrapTriple('\nuser meth notes, no procedures route\n', '\nuser orch notes\n', '\nuser autonomy notes\n');
    const dir = mkdtempSync(join(tmpdir(), 'reconcile-hint-'));
    tmpDirs.push(dir);
    const agents = join(dir, 'AGENTS.md');
    writeFileSync(agents, custom);
    const out = await runScript(['reconcile', agents], { env: withEngine(NO_ENGINE) });
    assert.equal(readFileSync(agents, 'utf8'), custom, 'the file is byte-unchanged (read-only advisory)');
    assert.match(out, /note:.*procedures/i, 'the upgrade flow surfaces the procedures hint');
  });
});

// §3.2 (kit) — the REAL extended engine fragments must keep the triple-fill ≤ 100 on BOTH deployed
// templates. Each canonical fragment is ONE line, but pin it against the REAL fragments + REAL
// templates so a future fragment edit that DID add a line is caught here, not in the field.
describe('real-fragment triple-fill ≤ cap on both deployed templates (§3.2)', () => {
  const ENGINE_REFS = join(HERE, '..', '..', 'agent-workflow-engine', 'references');
  const realMeth = readFileSync(join(ENGINE_REFS, 'methodology-slot.md'), 'utf8');
  const realOrch = readFileSync(join(ENGINE_REFS, 'orchestration-slot.md'), 'utf8');
  const realAut = readFileSync(join(ENGINE_REFS, 'autonomy-slot.md'), 'utf8');
  const lineCount = (t) => t.split('\n').length - (t.endsWith('\n') ? 1 : 0);
  const TEMPLATES = {
    kit: join(HERE, '..', 'references', 'templates', 'AGENTS.md'),
    memory: join(HERE, '..', '..', 'agent-workflow-memory', 'references', 'templates', 'AGENTS.md'),
  };

  it('the real methodology fragment carries the procedures route (auto-discovery clause)', () => {
    assert.match(realMeth, new RegExp(PROCEDURES_POINTER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(lineCount(realMeth), 1, 'the methodology fragment stays exactly one content line');
  });

  for (const [name, path] of Object.entries(TEMPLATES)) {
    it(`${name} template: filling ALL THREE real fragments stays ≤ ${AGENTS_MD_CAP} lines`, () => {
      const template = readFileSync(path, 'utf8');
      const meth = reconcileSlot(template, realMeth, { maxLines: AGENTS_MD_CAP });
      assert.equal(meth.status, 'reconciled-filled', `${name}: methodology slot fills`);
      const both = reconcileMarkerSlot(meth.text, ORCHESTRATION_DESCRIPTOR, realOrch, { maxLines: AGENTS_MD_CAP });
      assert.equal(both.status, 'reconciled-filled', `${name}: orchestration slot fills`);
      const all = reconcileMarkerSlot(both.text, AUTONOMY_DESCRIPTOR, realAut, { maxLines: AGENTS_MD_CAP });
      assert.equal(all.status, 'reconciled-filled', `${name}: autonomy slot fills`);
      assert.ok(lineCount(all.text) <= AGENTS_MD_CAP, `${name}: triple-filled entry point is ${lineCount(all.text)} lines (cap ${AGENTS_MD_CAP})`);
    });
  }
});
