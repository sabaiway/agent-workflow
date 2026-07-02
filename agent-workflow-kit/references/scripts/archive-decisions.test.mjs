import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOT_REL,
  WARM_REL,
  COLD_REL,
  parseDecisionsText,
  loadTiers,
  renderTier,
  lineCountOf,
  planRotation,
  updateRangeTokens,
  runCli,
} from './archive-decisions.mjs';

// Hermetic by design: this test ships as deploy payload and runs inside CONSUMER repos via the
// pre-commit `node --test scripts/*.test.mjs` — it must never read the host repo's docs/ai.

const tempDirs = [];
const makeRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-decisions-'));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

const fm = (cap) =>
  `---\ntype: reference\nlastUpdated: 2026-01-01\nscope: permanent\nstaleAfter: never\nowner: none\nmaxLines: ${cap}\n---\n`;

// One canonical entry block: 3 fixed lines + extraLines body lines.
const entryBlock = (id, extraLines = 2) =>
  [`## AD-${id} — Decision ${id}`, '', '**Date:** 2026-01-01', ...Array.from({ length: extraLines }, (_, i) => `body ${i + 1} of AD-${id}`)].join('\n');

const tierText = (cap, preamble, blocks) => `${fm(cap)}\n${preamble}\n\n${blocks.join('\n\n')}\n`;

const HOT_PREAMBLE = [
  '# Architecture Decision Records (ADRs)',
  '',
  '> Newest at the bottom.',
  '>',
  '> **Archive:** the stable ADRs **AD-003 … AD-004** now live in [`history/decisions-archive.md`](./history/decisions-archive.md) (the earliest **AD-001 … AD-002** rolled further to the COLD [`history/decisions-archive-early.md`](./history/decisions-archive-early.md)); this file carries the active set (AD-005 onward).',
].join('\n');

const WARM_PREAMBLE = '# ADR Archive (AD-003 … AD-004)\n\n> WARM tier. The earliest (AD-001 … AD-002) are COLD.';
const COLD_PREAMBLE = '# ADR Early Archive (AD-001 … AD-002)\n\n> COLD tier.';

// Seed a project: HOT with `hotIds`, WARM with `warmIds`, COLD with `coldIds`; caps computed
// from the measured rendered size + a delta (so fixtures stay robust to formatting arithmetic).
const seedProject = (root, { hotIds, warmIds, coldIds, hotCapDelta = 100, warmCapDelta = 100, coldCapDelta = 100 }) => {
  mkdirSync(join(root, 'docs', 'ai', 'history'), { recursive: true });
  const write = (rel, preamble, ids, capDelta) => {
    const blocks = ids.map((id) => entryBlock(id));
    const probe = tierText(999, preamble, blocks);
    const cap = lineCountOf(probe) + capDelta;
    writeFileSync(join(root, rel), tierText(cap, preamble, blocks));
    return cap;
  };
  return {
    hotCap: write(HOT_REL, HOT_PREAMBLE, hotIds, hotCapDelta),
    warmCap: write(WARM_REL, WARM_PREAMBLE, warmIds, warmCapDelta),
    coldCap: write(COLD_REL, COLD_PREAMBLE, coldIds, coldCapDelta),
  };
};

const run = (argv, root) => {
  const out = [];
  const err = [];
  const code = runCli(argv, { root, log: (l) => out.push(l), logError: (l) => err.push(l) });
  return { code, out, err, text: out.join('\n'), errText: err.join('\n') };
};

const idsIn = (root, rel) => parseDecisionsText(readFileSync(join(root, rel), 'utf8'), rel).entries.map((e) => e.id);

// ── parsing: strict canonical headings (the Issue-009 lesson) ─────────────────────────

describe('parseDecisionsText — fail-loud on non-canonical headings', () => {
  it('parses canonical entries with ids, titles, and per-entry line counts', () => {
    const parsed = parseDecisionsText(tierText(500, HOT_PREAMBLE, [entryBlock('005'), entryBlock('006', 4)]), 'x');
    assert.deepEqual(parsed.entries.map((e) => e.id), ['005', '006']);
    assert.equal(parsed.entries[0].lineCount, 5);
    assert.equal(parsed.entries[1].lineCount, 7);
    assert.equal(parsed.cap, 500);
  });

  const badHeadings = [
    ['a hyphen instead of the em-dash', '## AD-024 - Title'],
    ['a 2-digit id', '## AD-24 — Title'],
    ['a missing title', '## AD-024 — '],
    ['an unrelated H2', '## Notes'],
  ];
  for (const [name, heading] of badHeadings) {
    it(`rejects ${name} naming file:line — never a silent merge`, () => {
      const text = `${fm(500)}\n# T\n\n${entryBlock('001')}\n\n${heading}\nbody\n`;
      assert.throws(() => parseDecisionsText(text, 'docs/ai/decisions.md'), (e) => {
        assert.equal(e.exitCode, 1);
        assert.match(e.message, /docs\/ai\/decisions\.md:\d+/);
        assert.match(e.message, /non-canonical H2/);
        return true;
      });
    });
  }

  it('rejects disordered ids (oldest must be at the top)', () => {
    const text = tierText(500, '# T', [entryBlock('007'), entryBlock('005')]);
    assert.throws(() => parseDecisionsText(text, 'x'), /strictly ascending/);
  });
});

describe('loadTiers — cross-tier integrity', () => {
  it('rejects a duplicate id across tiers', () => {
    const root = makeRoot();
    seedProject(root, { hotIds: ['005'], warmIds: ['005'], coldIds: [] });
    assert.throws(() => loadTiers(root, '2026-01-02'), /duplicate id across tiers/);
  });
});

// ── the cascade ───────────────────────────────────────────────────────────────────────

describe('rotation — simple HOT→WARM roll', () => {
  it('rolls the OLDEST whole entries until HOT fits; ids + line counts conserved', () => {
    const root = makeRoot();
    seedProject(root, { hotIds: ['005', '006', '007', '008'], warmIds: ['003', '004'], coldIds: ['001', '002'], hotCapDelta: -1 });
    const before = loadTiers(root, '2026-01-02');
    const allBefore = [before.hot, before.warm, before.cold].flatMap((t) => t.entries.map((e) => `${e.id}:${e.lineCount}`)).sort();

    const { code, text } = run(['--today=2026-01-02'], root);
    assert.equal(code, 0, text);
    assert.deepEqual(idsIn(root, HOT_REL), ['006', '007', '008'], 'the oldest HOT entry rolled');
    assert.deepEqual(idsIn(root, WARM_REL), ['003', '004', '005'], 'appended to the WARM end');
    assert.deepEqual(idsIn(root, COLD_REL), ['001', '002'], 'COLD untouched');

    const after = loadTiers(root, '2026-01-02');
    const allAfter = [after.hot, after.warm, after.cold].flatMap((t) => t.entries.map((e) => `${e.id}:${e.lineCount}`)).sort();
    assert.deepEqual(allAfter, allBefore, 'id multiset + per-entry line counts conserved');
    assert.ok(lineCountOf(renderTier(after.hot, after.hot.entries)) <= after.hot.cap, 'HOT now fits its cap');
  });

  it('a tree already under cap is a no-op (nothing written)', () => {
    const root = makeRoot();
    seedProject(root, { hotIds: ['005'], warmIds: ['003'], coldIds: ['001'] });
    const bytesBefore = readFileSync(join(root, HOT_REL), 'utf8');
    const { code, text } = run([], root);
    assert.equal(code, 0);
    assert.match(text, /nothing to rotate/);
    assert.equal(readFileSync(join(root, HOT_REL), 'utf8'), bytesBefore);
  });
});

describe('rotation — the CHAINED roll (WARM near cap rolls WARM→COLD first)', () => {
  it('an incoming HOT entry that would overflow WARM pushes the oldest WARM entry to COLD', () => {
    const root = makeRoot();
    seedProject(root, {
      hotIds: ['005', '006', '007'],
      warmIds: ['003', '004'],
      coldIds: ['001', '002'],
      hotCapDelta: -1, // force one HOT roll
      warmCapDelta: 3, // the incoming 6-line append does NOT fit → chain
    });
    const { code } = run(['--today=2026-01-02'], root);
    assert.equal(code, 0);
    assert.deepEqual(idsIn(root, HOT_REL), ['006', '007']);
    assert.deepEqual(idsIn(root, WARM_REL), ['004', '005'], 'AD-003 chained out, AD-005 appended');
    assert.deepEqual(idsIn(root, COLD_REL), ['001', '002', '003'], 'the chained entry landed in COLD');
  });
});

describe('rotation — COLD exhaustion fails LOUD before ANY write', () => {
  it('a roll that does not fit COLD headroom leaves all three files byte-identical', () => {
    const root = makeRoot();
    seedProject(root, {
      hotIds: ['005', '006', '007'],
      warmIds: ['003', '004'],
      coldIds: ['001', '002'],
      hotCapDelta: -1, // force a HOT roll
      warmCapDelta: 3, // force the chain into COLD
      coldCapDelta: 3, // the chained 6-line entry does NOT fit COLD
    });
    const snapshot = () => [HOT_REL, WARM_REL, COLD_REL].map((rel) => readFileSync(join(root, rel), 'utf8'));
    const before = snapshot();
    const { code, errText } = run(['--today=2026-01-02'], root);
    assert.equal(code, 1);
    assert.match(errText, /refusing BEFORE any write/);
    assert.match(errText, /maintainer\/agent decision/);
    assert.deepEqual(snapshot(), before, 'no file changed on the refused plan');
  });
});

describe('rotation — determinism + dry-run', () => {
  it('the same input yields the same move-set (planRotation is pure)', () => {
    const root = makeRoot();
    seedProject(root, { hotIds: ['005', '006', '007', '008'], warmIds: ['003'], coldIds: ['001'], hotCapDelta: -1 });
    const tiers = loadTiers(root, '2026-01-02');
    const planA = planRotation(tiers);
    const planB = planRotation(loadTiers(root, '2026-01-02'));
    assert.deepEqual(planA.moves, planB.moves);
  });

  it('--dry-run prints the move-set and writes nothing', () => {
    const root = makeRoot();
    seedProject(root, { hotIds: ['005', '006'], warmIds: [], coldIds: [], hotCapDelta: -1 });
    const before = readFileSync(join(root, HOT_REL), 'utf8');
    const { code, text } = run(['--dry-run'], root);
    assert.equal(code, 0);
    assert.match(text, /DRY-RUN/);
    assert.match(text, /AD-005/);
    assert.equal(readFileSync(join(root, HOT_REL), 'utf8'), before);
  });
});

describe('preamble range tokens', () => {
  it('updates the recognizable range/onward tokens after a rotation', () => {
    const root = makeRoot();
    seedProject(root, { hotIds: ['005', '006', '007'], warmIds: ['003', '004'], coldIds: ['001', '002'], hotCapDelta: -1 });
    const { code } = run(['--today=2026-01-02'], root);
    assert.equal(code, 0);
    const hotText = readFileSync(join(root, HOT_REL), 'utf8');
    assert.match(hotText, /\*\*AD-003 … AD-005\*\*/, 'WARM range token updated in HOT');
    assert.match(hotText, /\(AD-006 onward\)/, 'active-set token updated');
    const warmText = readFileSync(join(root, WARM_REL), 'utf8');
    assert.match(warmText, /AD-003 … AD-005/, 'WARM file H1 range updated');
  });

  it('a preamble without tokens is left untouched (consumer wording preserved)', () => {
    const updated = updateRangeTokens('# My own ADR file\n\n> no tokens here', 'hot', {
      hotEntries: [{ id: '010' }],
      warmEntries: [{ id: '001' }, { id: '002' }],
      coldEntries: [],
    });
    assert.equal(updated, '# My own ADR file\n\n> no tokens here');
  });
});

// ── --check + the absent-substrate divergence ─────────────────────────────────────────

describe('--check', () => {
  it('all tiers within caps → exit 0 with a per-tier usage report', () => {
    const root = makeRoot();
    seedProject(root, { hotIds: ['005'], warmIds: ['003'], coldIds: ['001'] });
    const { code, text } = run(['--check'], root);
    assert.equal(code, 0);
    assert.match(text, /decisions\.md: \d+\/\d+/);
    assert.match(text, /OK — every tier is within its cap/);
  });

  it('an over-cap HOT → exit 1 naming the rotation recovery', () => {
    const root = makeRoot();
    seedProject(root, { hotIds: ['005', '006'], warmIds: [], coldIds: [], hotCapDelta: -1 });
    const { code, errText } = run(['--check'], root);
    assert.equal(code, 1);
    assert.match(errText, /decisions\.md is over its cap/);
    assert.match(errText, /archive-decisions\.mjs` to rotate/);
  });

  it('an over-cap COLD → exit 1 naming the maintainer decision (rotation cannot fix it)', () => {
    const root = makeRoot();
    seedProject(root, { hotIds: ['005'], warmIds: ['003'], coldIds: ['001', '002'], coldCapDelta: -1 });
    const { code, errText } = run(['--check'], root);
    assert.equal(code, 1);
    assert.match(errText, /maintainer\/agent decision/);
  });

  it('ABSENT decisions.md → --check exits 0 with a STATED skip (deliberate divergence from archive-changelog)', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    const { code, text } = run(['--check'], root);
    assert.equal(code, 0);
    assert.match(text, /SKIP — docs\/ai\/decisions\.md not found/);
  });

  it('an absent decisions.md WITHOUT --check is still a loud non-zero (rotation has nothing to do)', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    const { code, errText } = run([], root);
    assert.equal(code, 1);
    assert.match(errText, /not found/);
  });
});

describe('cap accounting is on RAW file lines (the template-shaped `---` separator case)', () => {
  // A consumer file born from the shipped template joins entries with `\n\n---\n\n`. Normalized
  // rendering drops those separator lines, so a render-based count would false-green a file the
  // docs cap-validator (raw lines) fails. --check and the write trigger must count RAW lines.
  const seedSeparatorShaped = (root, { capDelta }) => {
    mkdirSync(join(root, 'docs', 'ai', 'history'), { recursive: true });
    const blocks = [entryBlock('001'), entryBlock('002'), entryBlock('003')];
    const body = blocks.join('\n\n---\n\n'); // the template separator shape
    const probe = `${fm(999)}\n# ADRs\n\n${body}\n`;
    const cap = lineCountOf(probe) + capDelta;
    writeFileSync(join(root, HOT_REL), `${fm(cap)}\n# ADRs\n\n${body}\n`);
    return { cap, rawLines: lineCountOf(probe) };
  };

  it('--check fails on raw-over-cap even when the normalized render would fit', () => {
    const root = makeRoot();
    // 3 separators × 2 lines = 6 lines the render drops; cap sits 2 under raw → render fits, raw does not.
    seedSeparatorShaped(root, { capDelta: -2 });
    const { code, errText } = run(['--check'], root);
    assert.equal(code, 1, 'raw lines are what the docs cap-validator counts — never false-green');
    assert.match(errText, /decisions\.md is over its cap/);
  });

  it('rotation performs a NORMALIZE-ONLY rewrite when raw is over cap but the render fits (no moves)', () => {
    const root = makeRoot();
    seedSeparatorShaped(root, { capDelta: -2 });
    const { code, text } = run(['--today=2026-01-02'], root);
    assert.equal(code, 0, text);
    assert.match(text, /normalize-only rewrite/);
    assert.match(text, /HOT→WARM: \(none\)/);
    const after = parseDecisionsText(readFileSync(join(root, HOT_REL), 'utf8'), HOT_REL);
    assert.deepEqual(after.entries.map((e) => e.id), ['001', '002', '003'], 'ids conserved, nothing moved');
    const { code: recheck } = run(['--check'], root);
    assert.equal(recheck, 0, 'the normalized file now fits its cap on raw lines');
  });

  it('a tier STILL over cap after the planned rewrite refuses BEFORE any write (a normalized rewrite is not a licence)', () => {
    const root = makeRoot();
    // COLD legitimately exceeds its cap (entries, not formatting): no move can fix it and a
    // normalize-only rewrite would still be over budget — the run must refuse with files untouched.
    seedProject(root, { hotIds: ['005'], warmIds: ['003'], coldIds: ['001', '002'], coldCapDelta: -3 });
    const snapshot = () => [HOT_REL, WARM_REL, COLD_REL].map((rel) => readFileSync(join(root, rel), 'utf8'));
    const before = snapshot();
    const { code, errText } = run(['--today=2026-01-02'], root);
    assert.equal(code, 1);
    assert.match(errText, /would still be over its cap after rotation/);
    assert.match(errText, /maintainer\/agent decision/);
    assert.deepEqual(snapshot(), before, 'no file changed on the refused plan');
  });

  it('a normalize-only rewrite NEVER materializes absent WARM/COLD files (no premature archives)', () => {
    const root = makeRoot();
    seedSeparatorShaped(root, { capDelta: -2 }); // HOT only — no history files exist
    const { code } = run(['--today=2026-01-02'], root);
    assert.equal(code, 0);
    assert.ok(!existsSync(join(root, WARM_REL)), 'an absent WARM with zero entries is not created');
    assert.ok(!existsSync(join(root, COLD_REL)), 'an absent COLD with zero entries is not created');
  });
});

describe('created tiers (a consumer with no history files yet)', () => {
  it('rolling into an absent WARM creates it with frontmatter + preamble', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    const blocks = [entryBlock('001'), entryBlock('002')];
    const probe = tierText(999, '# ADRs', blocks);
    writeFileSync(join(root, HOT_REL), tierText(lineCountOf(probe) - 1, '# ADRs', blocks));
    const { code } = run(['--today=2026-01-02'], root);
    assert.equal(code, 0);
    assert.ok(existsSync(join(root, WARM_REL)), 'WARM created');
    const warm = parseDecisionsText(readFileSync(join(root, WARM_REL), 'utf8'), WARM_REL);
    assert.deepEqual(warm.entries.map((e) => e.id), ['001']);
    assert.equal(warm.cap, 500, 'created WARM carries the default cap');
    assert.match(warm.preamble, /AD-001 … AD-001/, 'created preamble range filled');
  });

  it('usage errors are loud (exit 2)', () => {
    const { code, errText } = run(['--frobnicate'], makeRoot());
    assert.equal(code, 2);
    assert.match(errText, /Unknown argument/);
  });
});
