// Revision 1 of the entry file's kit pointers: a differing pointer and a differing Memory Map row are written
// current with no question and no copy kept. Contract: docs/ai/specs/kit/install/entry-pointers.md.
import assert from 'node:assert/strict';
import { describe, it, after } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runCli, reconcileMarkerSlot, ensureMarkerSlot, extractMarkerSlot, AGENTS_MD_CAP,
  START_MARKER, END_MARKER, ORCH_START_MARKER, ORCH_END_MARKER, AUTONOMY_START_MARKER, AUTONOMY_END_MARKER,
  METHODOLOGY_DESCRIPTOR, ORCHESTRATION_DESCRIPTOR, AUTONOMY_DESCRIPTOR,
} from '../inject-methodology.mjs';
import { THEMES, reconcileMemoryMapRows } from '../project-rules/index.mjs';
import { UPGRADE_RUNLIST } from '../upgrade-runlist.mjs';

// The names revision 1 adds are read off the namespace, so their absence reds a cell, never the suite.
const inject = await import('../inject-methodology.mjs');
const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = join(HERE, '..', '..');
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;
const POINTER_ROUTE = 'text of your own goes outside the two <!-- workflow: --> comment lines around each pointer';
const ROW_ROUTE = 'a row of your own goes on a line of its own, its first cell a path of your own';
const POINTER_NOTE = `[inject-methodology] note: ${POINTER_ROUTE}.`;
const ROW_NOTE = `[inject-methodology] note: ${ROW_ROUTE}.`;
const RETIRED_WORD_RE = /(^|[^a-z])(custom|customized|edited|preserved|verbatim|kept)([^a-z]|$)/i;
const INSTALL = 'npx @sabaiway/agent-workflow-engine@latest init';
const ANCHOR_LINE = 'Procedures live in [`docs/ai/agent_rules.md`](./docs/ai/agent_rules.md) §1. **Read it before any code change.**';
const AGENT_RULES_ROW = '| [`docs/ai/agent_rules.md`](./docs/ai/agent_rules.md) | **Before any code change** | Protocol changes |';
const CURRENT_ROWS = reconcileMemoryMapRows(AGENT_RULES_ROW + LF).text.split(LF).slice(1, -1);
const OTHER_ROWS = CURRENT_ROWS.map((row, i) => row.replace(THEMES[i].readWhen, 'My own read-when words'));

const SLOTS = [
  {
    id: 'methodology', label: 'workflow-methodology', descriptor: METHODOLOGY_DESCRIPTOR, pair: [START_MARKER, END_MARKER],
    anchor: ANCHOR_LINE, file: 'methodology-slot.md', fragment: '> **Workflow methodology (fixture)** — plan, execute, review.',
  },
  {
    id: 'orchestration', label: 'orchestration-recipes', descriptor: ORCHESTRATION_DESCRIPTOR, pair: [ORCH_START_MARKER, ORCH_END_MARKER],
    anchor: END_MARKER, file: 'orchestration-slot.md', fragment: '> **Orchestration recipes (fixture)** — pick one with `/agent-workflow-kit recipes`.',
  },
  {
    id: 'autonomy', label: 'autonomy', descriptor: AUTONOMY_DESCRIPTOR, pair: [AUTONOMY_START_MARKER, AUTONOMY_END_MARKER],
    anchor: ORCH_END_MARKER, file: 'autonomy-slot.md', fragment: '> **Autonomy policy (fixture)** — read `docs/ai/autonomy.json` at session start.',
  },
];

// The bytes between a pair's markers: own(text) a body on lines of its own, INLINE a body a write grows by two lines.
const own = (text) => LF + text + LF;
const EMPTY = LF;
const INLINE = ' my own words ';
const MINE = own('My own pointer words.');
const MINE_TWO = own('My own pointer words.' + LF + 'A second line of mine.');
const CURRENT = Object.fromEntries(SLOTS.map((slot) => [slot.id, own(slot.fragment)]));
const doubled = (slot) => LF + slot.pair[1] + LF + slot.pair[0] + LF;

// entry(inners, { lines, rows, eol }) → an AGENTS.md: each slot's pair holding its inner (null: no pair), then a
// Memory Map, padded to `lines` lines.
const entry = (inners, { lines = 0, rows = CURRENT_ROWS, eol = LF } = {}) => {
  const pairs = SLOTS.filter((slot) => inners[slot.id] != null).map((slot) => slot.pair[0] + inners[slot.id] + slot.pair[1]);
  const out = ['# AGENTS.md', '', '## Session Protocols', '', ANCHOR_LINE, '', ...pairs, '', '## Memory Map', '',
    '| File | Read When | Update When |', '|---|---|---|', AGENT_RULES_ROW, ...rows].join(LF).split(LF);
  while (out.length < lines) out.push('pad line ' + out.length);
  return out.join(eol) + eol;
};
const lineCount = (text) => text.split(LF).length - 1;
const linesOf = (stdout) => stdout.split(LF).filter(Boolean);

const tmpDirs = [];
after(() => tmpDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const tempDir = (prefix) => tmpDirs[tmpDirs.push(mkdtempSync(join(tmpdir(), prefix))) - 1];
// makeEngine(ids) → a valid engine fixture shipping the fragments of the named slots only.
const makeEngine = (ids = SLOTS.map((slot) => slot.id)) => {
  const dir = tempDir('entry-pointers-engine-');
  const manifest = { family: 'agent-workflow', schema: 1, name: 'agent-workflow-engine', kind: 'methodology-engine', version: '1.0.0', available: true, provides: ['plan'], roles: {} };
  writeFileSync(join(dir, 'capability.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'SKILL.md'), ['---', 'name: agent-workflow-engine', 'metadata:', "  version: '1.0.0'", '---', '# engine', ''].join(LF));
  mkdirSync(join(dir, 'references'));
  for (const slot of SLOTS.filter((one) => ids.includes(one.id))) writeFileSync(join(dir, 'references', slot.file), slot.fragment + LF);
  return dir;
};
const ENGINE = makeEngine();
const NO_ENGINE = join(tempDir('entry-pointers-none-'), 'absent-engine');
const HOME = tempDir('entry-pointers-home-');

const run = (args, engine) => runCli(args, { env: { AGENT_WORKFLOW_ENGINE_DIR: engine }, home: HOME });
// reconcile(text, { engine, fragment }) → the command's result over a fresh AGENTS.md, the file after it and its folder's names.
const reconcile = async (text, { engine = ENGINE, fragment = null } = {}) => {
  const dir = tempDir('entry-pointers-');
  const path = join(dir, 'AGENTS.md');
  writeFileSync(path, text);
  if (fragment != null) writeFileSync(join(dir, 'fragment.md'), fragment);
  const args = fragment == null ? ['reconcile', path] : ['reconcile', path, join(dir, 'fragment.md')];
  const result = await run(args, engine);
  return { ...result, args, path, after: readFileSync(path, 'utf8'), names: readdirSync(dir).sort() };
};

const clause = (slot, written) => (written ? `wrote the current ${slot.label} pointer over a different one` : `${slot.label} pointer already present`);
const rowClauses = (word) => THEMES.map((theme) => `the ${theme.name} Memory Map row ${word}`).join('; ');
const reconcileLine = (written = [], rowWord = 'already present') =>
  `[inject-methodology] reconcile: ${SLOTS.map((slot) => clause(slot, written.includes(slot.id))).join('; ')}; ${rowClauses(rowWord)}.`;
const ZERO_DIFF = `[inject-methodology] reconcile: all three pointers already present and filled; ${rowClauses('already present')} — nothing to do (zero-diff).`;

describe('spec:entry-pointers/S1 the pure judgement writes any other content with the fragment', () => {
  for (const [index, slot] of SLOTS.entries()) {
    const judge = (text, fragment = slot.fragment) => reconcileMarkerSlot(text, slot.descriptor, fragment, { maxLines: AGENTS_MD_CAP });
    const expect = (text, status, out) => {
      const result = judge(text);
      assert.deepEqual([result.status, result.text], [status, out]);
    };

    it(`fills an empty ${slot.id} pair and inserts an absent one at its one anchor`, () => {
      expect(entry({ ...CURRENT, [slot.id]: EMPTY }), 'reconciled-filled', entry(CURRENT));
      const inserted = judge(entry(Object.fromEntries(SLOTS.slice(0, index).map((one) => [one.id, CURRENT[one.id]]))));
      assert.equal(inserted.status, 'reconciled-inserted');
      assert.equal(extractMarkerSlot(inserted.text, slot.descriptor), CURRENT[slot.id]);
      expect(inserted.text, 'present-filled', inserted.text);
    });

    it(`leaves a ${slot.id} pair equal to the fragment, also with trailing spaces and in a CRLF document`, () => {
      for (const text of [entry(CURRENT), entry({ ...CURRENT, [slot.id]: LF + slot.fragment + '   ' + LF }), entry(CURRENT, { eol: CRLF })]) {
        expect(text, 'present-filled', text);
      }
    });

    it(`refreshes a ${slot.id} pair equal to a known prior`, () => {
      for (const prior of slot.descriptor.knownPriorCanonicals) expect(entry({ ...CURRENT, [slot.id]: own(prior) }), 'reconciled-refreshed', entry(CURRENT));
    });

    it(`writes any other ${slot.id} content, one line or several, LF and CRLF, every byte outside the pair unchanged`, () => {
      for (const eol of [LF, CRLF]) {
        for (const inner of [MINE, MINE_TWO, INLINE]) expect(entry({ ...CURRENT, [slot.id]: inner }, { eol }), 'reconciled-written', entry(CURRENT, { eol }));
      }
    });

    it(`answers error with the text unchanged for a ${slot.id} fragment carrying its marker or blank, and a malformed pair`, () => {
      for (const text of [entry({ ...CURRENT, [slot.id]: MINE }), entry({ ...CURRENT, [slot.id]: EMPTY })]) {
        for (const fragment of [`bad ${slot.pair[0]} fragment`, '  ' + LF]) {
          const result = judge(text, fragment);
          assert.deepEqual([result.status, result.text], ['error', text], JSON.stringify(fragment));
        }
      }
      expect(entry({ ...CURRENT, [slot.id]: doubled(slot) }), 'error', entry({ ...CURRENT, [slot.id]: doubled(slot) }));
    });

    it(`answers the ensure's own error for a malformed ${slot.id} pair and an anchorless absent one, given a blank fragment`, () => {
      for (const text of [entry({ ...CURRENT, [slot.id]: doubled(slot) }), '# AGENTS.md' + LF + LF + 'no anchor here' + LF]) {
        assert.deepEqual(judge(text, '  ' + LF), { status: 'error', text, error: ensureMarkerSlot(text, slot.descriptor).error });
      }
    });
  }
});

describe('spec:entry-pointers/S2 the command writes a differing pointer with its own fragment and names the route', () => {
  it('names the route in one module constant', () => {
    assert.equal(inject.POINTER_ROUTE, POINTER_ROUTE);
  });

  const cases = [...SLOTS.map((slot) => [[slot.id], { ...CURRENT, [slot.id]: MINE }]), [SLOTS.map((slot) => slot.id), Object.fromEntries(SLOTS.map((slot) => [slot.id, MINE_TWO]))]];
  for (const [written, inners] of cases) {
    it(`writes the ${written.join(', ')} pointer with one route note, a second run zero-diff, no line saying a retired word`, async () => {
      const first = await reconcile(entry(inners));
      assert.deepEqual([first.code, first.stderr, first.after, first.names], [0, '', entry(CURRENT), ['AGENTS.md']]);
      assert.deepEqual(linesOf(first.stdout), [reconcileLine(written), POINTER_NOTE]);
      const second = await run(first.args, ENGINE);
      assert.deepEqual([second.code, second.stdout, second.stderr, readFileSync(first.path, 'utf8')], [0, ZERO_DIFF + LF, '', entry(CURRENT)]);
      const said = [first.stdout, first.stderr, second.stdout, second.stderr].join(LF).split(LF).filter((line) => RETIRED_WORD_RE.test(line));
      assert.deepEqual(said, []);
    });
  }
});

describe('spec:entry-pointers/S3 the engine is read for every slot the ensure can place', () => {
  it('markerSlotEnsurable is true for a present or insertable pair and false for a malformed or unplaceable one', () => {
    assert.equal(typeof inject.markerSlotEnsurable, 'function', 'markerSlotEnsurable is absent: the plan adds it');
    for (const slot of SLOTS) {
      const ensurable = (text) => inject.markerSlotEnsurable(text, slot.descriptor);
      const present = [EMPTY, CURRENT[slot.id], MINE, ...slot.descriptor.knownPriorCanonicals.map(own)];
      assert.deepEqual(present.map((inner) => ensurable(entry({ ...CURRENT, [slot.id]: inner }))), present.map(() => true), slot.id);
      const absent = (anchors) => ['# AGENTS.md', ...Array(anchors).fill(slot.anchor), ''].join(LF);
      const unplaceable = [absent(1), absent(0), absent(2), entry({ ...CURRENT, [slot.id]: doubled(slot) })];
      assert.deepEqual(unplaceable.map(ensurable), [true, false, false, false], slot.id);
    }
  });

  for (const [name, inner] of [['current', null], ['differing', MINE]]) {
    it(`STOPs with the install command over three ${name} pointers when the engine is absent, the file byte-identical`, async () => {
      const text = entry(inner == null ? CURRENT : Object.fromEntries(SLOTS.map((slot) => [slot.id, inner])));
      const result = await reconcile(text, { engine: NO_ENGINE });
      assert.deepEqual([result.code, result.stdout, result.after], [1, '', text]);
      assert.match(result.stderr, /^\[inject-methodology\] reconcile STOP — methodology engine not found\/invalid/);
      assert.ok(result.stderr.includes(INSTALL), result.stderr);
    });
  }

  it('retires the fill predicates, the advisories and the upgrade fields', () => {
    const retired = ['markerSlotNeedsFill', 'slotNeedsFill', 'methodologyProceduresHint', 'markerSlotUpgradeHint', 'PROCEDURES_POINTER'];
    assert.deepEqual(retired.filter((name) => name in inject), []);
    const fields = SLOTS.flatMap((slot) => ['upgradeSignature', 'upgradeAdvice'].filter((key) => key in slot.descriptor).map((key) => `${slot.id}.${key}`));
    assert.deepEqual(fields, []);
  });
});

describe('spec:entry-pointers/S4 a differing pointer meets the cap as a fill does', () => {
  const pushed = `injection would push AGENTS.md to ${AGENTS_MD_CAP + 2} lines (cap ${AGENTS_MD_CAP})`;

  it('refuses a differing methodology slot whose write would pass the cap, nothing written', async () => {
    const text = entry({ ...CURRENT, methodology: INLINE }, { lines: AGENTS_MD_CAP });
    const result = await reconcile(text);
    assert.deepEqual([result.code, result.stdout, result.after], [1, '', text]);
    assert.equal(result.stderr, `[inject-methodology] reconcile refused — ${pushed} — trim the fragment or the file${LF}`);
  });

  it('soft-skips a differing orchestration slot past the cap and chains the autonomy skip, the methodology still written', async () => {
    const result = await reconcile(entry({ ...CURRENT, methodology: MINE, orchestration: INLINE }, { lines: AGENTS_MD_CAP }));
    assert.deepEqual([result.code, result.stderr, result.after], [0, '', entry({ ...CURRENT, orchestration: INLINE }, { lines: AGENTS_MD_CAP })]);
    const [line, ...notes] = linesOf(result.stdout);
    assert.ok(line.includes(`wrote the current workflow-methodology pointer over a different one; orchestration-recipes pointer skipped — ${pushed}`), line);
    assert.ok(line.includes('autonomy pointer skipped — chained below the orchestration pointer, which was itself skipped this run'), line);
    assert.deepEqual(notes, [POINTER_NOTE]);
  });

  it('soft-skips a differing autonomy slot past the cap with the inject message, the file unchanged', async () => {
    const text = entry({ ...CURRENT, autonomy: INLINE }, { lines: AGENTS_MD_CAP });
    const result = await reconcile(text);
    assert.deepEqual([result.code, result.after, linesOf(result.stdout).length], [0, text, 1]);
    assert.ok(result.stdout.includes(`autonomy pointer skipped — ${pushed}`), result.stdout);
  });

  it('refuses a current slot in a file already past the cap by its count, the line naming no customized slot', async () => {
    const text = entry(CURRENT, { lines: AGENTS_MD_CAP + 1 });
    const result = await reconcile(text);
    assert.deepEqual([result.code, result.stdout, result.after], [1, '', text]);
    const overCap = `AGENTS.md is ${AGENTS_MD_CAP + 1} lines (cap ${AGENTS_MD_CAP}) — trim the file (the current workflow-methodology pointer must still fit the cap)`;
    assert.equal(result.stderr, `[inject-methodology] reconcile refused — ${overCap}${LF}`);
  });

  it('writes a differing methodology slot whose write brings an over-cap file to the cap', async () => {
    const result = await reconcile(entry({ ...CURRENT, methodology: MINE_TWO }, { lines: AGENTS_MD_CAP + 1 }));
    assert.deepEqual([result.code, result.stderr, lineCount(result.after)], [0, '', AGENTS_MD_CAP]);
    assert.equal(extractMarkerSlot(result.after, METHODOLOGY_DESCRIPTOR), CURRENT.methodology);
  });
});

describe('spec:entry-pointers/S5 the chained soft skips leave a differing slot byte-identical', () => {
  const differing = Object.fromEntries(SLOTS.map((slot) => [slot.id, MINE]));

  it('an engine without the orchestration fragment writes the methodology slot and skips both chained slots', async () => {
    const result = await reconcile(entry(differing), { engine: makeEngine(['methodology']) });
    assert.deepEqual([result.code, result.stderr, result.after], [0, '', entry({ ...differing, methodology: CURRENT.methodology })]);
    const [line, ...notes] = linesOf(result.stdout);
    assert.ok(line.includes('wrote the current workflow-methodology pointer over a different one; orchestration-recipes pointer skipped — the installed engine is too old'), line);
    assert.ok(line.includes('autonomy pointer skipped — chained below the orchestration pointer'), line);
    assert.deepEqual(notes, [POINTER_NOTE]);
  });

  it('an engine without the autonomy fragment skips a differing autonomy slot and writes the other two', async () => {
    const result = await reconcile(entry(differing), { engine: makeEngine(['methodology', 'orchestration']) });
    assert.deepEqual([result.code, result.stderr, result.after], [0, '', entry({ ...CURRENT, autonomy: MINE })]);
    const [line, ...notes] = linesOf(result.stdout);
    assert.ok(line.includes('wrote the current orchestration-recipes pointer over a different one; autonomy pointer skipped — the installed engine is too old'), line);
    assert.deepEqual(notes, [POINTER_NOTE]);
  });

  it('malformed autonomy markers beside a differing methodology slot STOP with nothing written', async () => {
    const text = entry({ ...CURRENT, methodology: MINE, autonomy: doubled(SLOTS[2]) });
    const result = await reconcile(text);
    assert.deepEqual([result.code, result.stdout, result.after], [1, '', text]);
    assert.match(result.stderr, /reconcile refused \(autonomy\)/);
  });
});

describe('spec:entry-pointers/S6 the explicit fragment form judges the methodology slot alone', () => {
  const GIVEN = '> my given methodology line';
  const lone = (inner) => entry({ methodology: inner }, { rows: [] });

  it('leaves a slot equal to the given fragment, nothing written and no engine read', async () => {
    const result = await reconcile(lone(own(GIVEN)), { engine: NO_ENGINE, fragment: GIVEN + LF });
    assert.deepEqual([result.code, result.stderr, result.after], [0, '', lone(own(GIVEN))]);
    assert.equal(result.stdout, '[inject-methodology] methodology slot already present and filled — nothing to do (zero-diff).' + LF);
  });

  it('writes other content with the given fragment, the written clause and the route note, adding no pair and no row', async () => {
    const result = await reconcile(lone(MINE), { engine: NO_ENGINE, fragment: GIVEN + LF });
    assert.deepEqual([result.code, result.stderr, result.after], [0, '', lone(own(GIVEN))]);
    assert.deepEqual(linesOf(result.stdout), ['[inject-methodology] reconcile: wrote the current workflow-methodology pointer over a different one.', POINTER_NOTE]);
  });
});

// A differing pointer beside the current row is S2's cells, whose lines carry the pointer note and no row note.
describe('spec:entry-pointers/S10 the Memory Map rows ride the same write, their note after the pointer note', () => {
  it('writes a differing pointer and a row with other text in one write, both clauses, then both notes', async () => {
    const result = await reconcile(entry({ ...CURRENT, orchestration: MINE }, { rows: OTHER_ROWS }));
    assert.deepEqual([result.code, result.stderr, result.after, result.names], [0, '', entry(CURRENT), ['AGENTS.md']]);
    assert.deepEqual(linesOf(result.stdout), [reconcileLine(['orchestration'], 'written with the current text'), POINTER_NOTE, ROW_NOTE]);
  });

  it('prints the row note alone for three current pointers and a row with other text', async () => {
    const result = await reconcile(entry(CURRENT, { rows: OTHER_ROWS }));
    assert.deepEqual([result.code, result.stderr, result.after], [0, '', entry(CURRENT)]);
    assert.deepEqual(linesOf(result.stdout), [reconcileLine([], 'written with the current text'), ROW_NOTE]);
  });

  it('STOPs on a malformed slot with the row unchanged', async () => {
    const text = entry({ ...CURRENT, methodology: doubled(SLOTS[0]) }, { rows: OTHER_ROWS });
    const result = await reconcile(text);
    assert.deepEqual([result.code, result.stdout, result.after], [1, '', text]);
  });
});

// A clause (split at ;, a sentence end and a middle dot, never at a slash) pairing a pointer, slot or row with a
// word that keeps it; the phrase no copy kept is spared.
const KEEP_SUBJECT = /(^|[^a-z])(pointers?|slots?|rows?)([^a-z]|$)/i;
const KEEP_WORD = /(^|[^a-z])(preserved|verbatim|untouched|never overwritten|as you wrote|kept|stays|left)([^a-z]|$)/i;
const keptClauses = (text) => text.replace(/\s+/g, ' ').split(/;|[.?!](?=\s|$)|·/)
  .map((part) => part.replace(/no copy kept/gi, ' ').trim()).filter((part) => KEEP_SUBJECT.test(part) && KEEP_WORD.test(part));
const flat = (text) => text.replace(/\*\*|`/g, '').replace(/\s+/g, ' ');
const clausesOf = (text) => flat(text).split(/;|[.?!](?=\s|$)/);

describe('spec:entry-pointers/S11 the shipped text names the written pointer and row and no kept one', () => {
  const read = (...parts) => readFileSync(join(KIT, ...parts), 'utf8');
  const between = (text, from, to, where) => {
    const start = text.indexOf(from);
    assert.notEqual(start, -1, `${where}: missing anchor ${from}`);
    const end = text.indexOf(to, start + from.length);
    assert.notEqual(end, -1, `${where}: missing anchor ${to}`);
    return text.slice(start, end);
  };
  const lineWith = (text, start) => text.split(LF).find((line) => line.trimStart().startsWith(start)) ?? '';
  const bulletWith = (text, words) => {
    const lines = text.split(LF);
    const at = lines.findIndex((line) => line.startsWith('- **') && line.includes(words));
    assert.notEqual(at, -1, `no bullet names ${words}`);
    const end = lines.findIndex((line, i) => i > at && !line.startsWith('  '));
    return lines.slice(at, end).join(LF);
  };
  const slices = () => {
    const upgrade = read('references', 'modes', 'upgrade.md');
    const block = between(upgrade, '**`pointers` —', '**`footprint` —', 'upgrade.md pointers block');
    const contracts = read('references', 'contracts.md');
    return {
      row: lineWith(upgrade, '1. `pointers`'),
      block,
      c: lineWith(block, '(c) '),
      noNode: lineWith(block, '**No-Node project:**'),
      step4: between(between(upgrade, LF + '4. ', LF + '5. ', 'step 4'), '`pointers` slot (workflow-methodology', 'nine project-configuration ensure', 'step 4'),
      step8: between(upgrade.slice(upgrade.indexOf(LF + '8. ')), 'the `pointers` slots', ', the `footprint`', 'step 8'),
      outcomes: UPGRADE_RUNLIST.find((item) => item.id === 'pointers').outcomes.join(' · '),
      handoff: between(read('references', 'shared', 'composition-handoff.md'), '**Bounded pointer reconciliation', LF + LF, 'composition-handoff.md'),
      contracts: contracts.split(LF + '## Reserved names and channels' + LF)[1] ?? '',
      skill: bulletWith(readFileSync(join(KIT, '..', 'agent-workflow-memory', 'SKILL.md'), 'utf8'), 'pointer slots'),
      procedures: lineWith(read('references', 'modes', 'procedures.md'), '**Cap-soft-skip degradation'),
    };
  };

  it("the pointers row and the run-list name written over a different one, the row a written Memory Map row after it", () => {
    const { row, outcomes } = slices();
    const at = row.indexOf('per Memory Map row');
    assert.ok(at !== -1 && row.slice(0, at).includes('written over a different one'), row);
    assert.match(row.slice(at), /(^|[^a-z])written([^a-z]|$)/, row);
    assert.ok(outcomes.includes('written over a different one'), outcomes);
  });

  it('the pointers block, the step-4 relay and the handoff paragraph name both routes, the zero-diff clause the current text', () => {
    const parts = slices();
    const missing = ['block', 'step4', 'handoff'].flatMap((name) => [POINTER_ROUTE, ROW_ROUTE].filter((route) => !flat(parts[name]).includes(route)).map((route) => `${name}: ${route}`));
    assert.deepEqual(missing, []);
    const zeroDiff = clausesOf(parts.block).find((part) => part.includes('zero-diff')) ?? '';
    assert.ok(zeroDiff.includes('with the current text'), zeroDiff);
  });

  it('the engine is read for every pointer judged and its absence STOPs over filled pointers; the No-Node walk brings none current', () => {
    const parts = slices();
    const reads = (text) => clausesOf(text).some((part) => /\bengine\b/i.test(part) && /\b(read|reads)\b/i.test(part) && /\bevery pointer\b/i.test(part));
    const stops = (text) => clausesOf(text).some((part) => /\bstop/i.test(part) && /\bevery pointer\b[^;]*\bfilled\b/i.test(part));
    assert.deepEqual(['block', 'c', 'handoff'].filter((name) => !(reads(parts[name]) && stops(parts[name]))), []);
    assert.deepEqual([/no pointer is brought current/i.test(flat(parts.noNode)), /upgrade continues/i.test(flat(parts.noNode))], [true, true], parts.noNode);
    assert.deepEqual(['block', 'handoff'].filter((name) => /a fill is needed|a fill was needed|needs filling|without the engine/i.test(flat(parts[name]))), []);
  });

  it("memory's gotcha names the composition root writing the slots current, procedures.md no customized pointer", () => {
    const { skill, procedures } = slices();
    assert.match(flat(skill), /\bcomposition root\b[^.;]*\bwrites?\b[^.;]*\bcurrent\b/i, skill);
    assert.doesNotMatch(skill, /the user's/i);
    assert.doesNotMatch(procedures, /customi[sz]ed/i);
  });

  it('no clause of the named slices pairs a pointer, slot or row with a word that keeps it', () => {
    assert.deepEqual(Object.entries(slices()).flatMap(([name, text]) => keptClauses(text).map((part) => `${name}: ${part}`)), []);
  });

  it('the judge splits at a semicolon, a sentence end and a middle dot, never at a slash, and spares no copy kept', () => {
    const judged = ['a filled / user-customized slot is preserved verbatim', 'the pointer is refreshed; the slot stays', 'each row added · the row left as it stands',
      'the slot is written with no question and no copy kept', 'the pointer is written. It stays current'];
    assert.deepEqual(judged.map((text) => keptClauses(text).length), [1, 1, 1, 0, 0]);
  });
});
