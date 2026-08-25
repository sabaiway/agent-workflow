import { describe, it } from 'node:test';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect } from './_expect-shim.mjs';
import {
  parseChangelogText,
  stripTrailingSeparator,
  computeCutoffs,
  categorize,
  compressEntry,
  buildChangelog,
  buildRecent,
  buildCold,
  buildCondensedIndex,
  groupByMonth,
} from './archive-changelog.mjs';

const FM = '---\ntype: history\nlastUpdated: 2026-05-24\nmaxLines: 700\n---\n';
const TEMPLATES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

const makeEntry = (dateStr, title = '') => {
  const [year, month, day] = dateStr.split('.');
  return {
    dateStr,
    dateObj: new Date(`${year}-${month}-${day}T00:00:00Z`),
    year,
    month,
    day,
    title,
    block: `## ${dateStr} — ${title}\n\n**Goal:** test body.\n\n**Files:**\n- a.ts`,
  };
};

describe('parseChangelogText', () => {
  it('extracts frontmatter, preamble, entries, and trailing footer', () => {
    const text = `${FM}\n# Changelog\n\n## 2026.05.20 — alpha\n\nbody one.\n\n## 2026.05.10 — beta\n\nbody two.\n\n## Footer\n\nstray.\n`;
    const parsed = parseChangelogText(text);
    expect(parsed.frontmatter).toBe(FM);
    expect(parsed.preamble).toContain('# Changelog');
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].dateStr).toBe('2026.05.20');
    expect(parsed.entries[0].title).toBe('alpha');
    expect(parsed.footer).toContain('## Footer');
  });

  it('does NOT slurp preamble `## History` into footer when it appears before any entry (preamble-before-entries regression)', () => {
    const text = `${FM}\n# Changelog\n\n## History\n\n> See history/recent.md.\n\n---\n\n## 2026.05.20 — alpha\n\nbody.\n`;
    const parsed = parseChangelogText(text);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].dateStr).toBe('2026.05.20');
    expect(parsed.footer).toBe('');
  });

  it('returns empty entries when body has no date headings', () => {
    const text = `${FM}\n# Just preamble, no entries.\n`;
    const parsed = parseChangelogText(text);
    expect(parsed.entries).toEqual([]);
    expect(parsed.preamble).toContain('# Just preamble');
  });

  it('strips trailing separator + "Last Updated" footer line from each entry block', () => {
    const text = `${FM}\n## 2026.05.20 — alpha\n\nbody.\n\n**Last Updated:** 2026.05.20\n\n---\n\n## 2026.05.10 — beta\n\nlater.\n`;
    const parsed = parseChangelogText(text);
    expect(parsed.entries[0].block).not.toMatch(/Last Updated/);
    expect(parsed.entries[0].block).not.toMatch(/---\s*$/);
  });
});

describe('stripTrailingSeparator', () => {
  it('strips trailing `---`, blanks, and Last-Updated lines', () => {
    const input = 'body line\n\n---\n\n**Last Updated:** 2026.05.20\n\n---\n';
    expect(stripTrailingSeparator(input)).toBe('body line');
  });

  it('returns block unchanged when nothing trailing matches', () => {
    expect(stripTrailingSeparator('keep this exact line')).toBe('keep this exact line');
  });
});

describe('computeCutoffs', () => {
  it('returns HOT/WARM cutoffs computed from todayStr (inclusive window)', () => {
    const { today, hotCutoff, warmCutoff } = computeCutoffs('2026-05-24', 3, 30);
    expect(today.toISOString().slice(0, 10)).toBe('2026-05-24');
    expect(hotCutoff.toISOString().slice(0, 10)).toBe('2026-05-22'); // 24 - 2
    expect(warmCutoff.toISOString().slice(0, 10)).toBe('2026-04-25'); // 24 - 29
  });
});

describe('categorize', () => {
  it('partitions entries by HOT / WARM / COLD windows', () => {
    const cutoffs = computeCutoffs('2026-05-24', 3, 30);
    const entries = [
      makeEntry('2026.05.23'), // HOT
      makeEntry('2026.05.10'), // WARM
      makeEntry('2026.03.01'), // COLD
    ];
    const { hot, warm, cold } = categorize(entries, cutoffs);
    expect(hot.map((e) => e.dateStr)).toEqual(['2026.05.23']);
    expect(warm.map((e) => e.dateStr)).toEqual(['2026.05.10']);
    expect(cold.map((e) => e.dateStr)).toEqual(['2026.03.01']);
  });
});

describe('compressEntry', () => {
  it('keeps heading, a summary paragraph, file bullets, and metrics', () => {
    const entry = makeEntry('2026.05.20', 'compressor smoke');
    entry.block = `## 2026.05.20 — compressor smoke

**Goal:** verify compressor output shape.

**Files:**
- a.ts
- b.ts

**Result:** 8 passed, 0 failed.`;
    const out = compressEntry(entry);
    expect(out).toMatch(/^## 2026\.05\.20/);
    expect(out).toMatch(/\*\*Goal:\*\*/);
    expect(out).toMatch(/\*\*Files:\*\*/);
    expect(out).toMatch(/8 passed/);
  });

  it('falls back to first non-heading paragraph when no labelled paragraph present', () => {
    const entry = makeEntry('2026.05.20', 'unlabelled');
    entry.block = `## 2026.05.20 — unlabelled\n\njust a plain summary.`;
    const out = compressEntry(entry);
    expect(out).toMatch(/just a plain summary/);
  });
});

describe('buildChangelog', () => {
  it('emits frontmatter, cleaned preamble, History pointer, and HOT block when hasArchive', () => {
    const result = buildChangelog({
      frontmatter: FM,
      preamble: '# Changelog',
      hot: [makeEntry('2026.05.23', 'recent')],
      footer: '',
      hasArchive: true,
    });
    expect(result).toMatch(/^---\n/);
    expect(result).toMatch(/# Changelog/);
    expect(result).toMatch(/## History/);
    expect(result).toMatch(/## 2026\.05\.23 — recent/);
  });

  it('omits History pointer when hasArchive=false', () => {
    const result = buildChangelog({
      frontmatter: FM,
      preamble: '# Changelog',
      hot: [makeEntry('2026.05.23', 'recent')],
      footer: '',
      hasArchive: false,
    });
    expect(result).not.toMatch(/## History/);
  });
});

describe('buildRecent', () => {
  it('emits frontmatter at the WARM floor for a corpus that fits under it', () => {
    const result = buildRecent([makeEntry('2026.05.10', 'warm')], '2026-05-24');
    expect(result).toMatch(/maxLines: 3500/);
    expect(result).toMatch(/Changelog WARM Archive/);
    expect(result).toMatch(/## 2026\.05\.10/);
  });

  // 3500/1500/1500 are tier FLOORS reached through capFor (archive-caps.mjs), not literals a builder
  // still carries — this pins all three onto that path; band/ceiling/fixed point: archive-caps.test.mjs.
  it('every builder stamps its own tier floor on a corpus that fits under it', () => {
    expect(buildCold('2026', '03', [makeEntry('2026.03.10', 'c')], '2026-05-24')).toMatch(/maxLines: 1500/);
    expect(buildCondensedIndex([makeEntry('2026.05.10', 'w')], new Map(), '2026-05-24')).toMatch(/maxLines: 1500/);
  });
});

describe('buildCold', () => {
  it('emits compressed monthly archive with frontmatter and preamble', () => {
    const entries = [makeEntry('2026.03.10', 'cold one')];
    const result = buildCold('2026', '03', entries, '2026-05-24');
    expect(result).toMatch(/Changelog COLD Archive — 2026-03/);
    expect(result).toMatch(/## 2026\.03\.10 — cold one/);
  });
});

describe('buildCondensedIndex', () => {
  it('lists WARM then per-month COLD with one-line summaries', () => {
    const warm = [makeEntry('2026.05.10', 'warm')];
    const coldByMonth = new Map([['2026-03', [makeEntry('2026.03.05', 'cold')]]]);
    const result = buildCondensedIndex(warm, coldByMonth, '2026-05-24');
    expect(result).toMatch(/## WARM \(7–30 days\)/);
    expect(result).toMatch(/## COLD 2026-03/);
    expect(result).toMatch(/\[recent\.md\]/);
    expect(result).toMatch(/\[2026-03\.md\]/);
  });
});

describe('groupByMonth', () => {
  it('keys entries by YYYY-MM', () => {
    const grouped = groupByMonth([
      makeEntry('2026.03.10'),
      makeEntry('2026.03.20'),
      makeEntry('2026.04.01'),
    ]);
    expect([...grouped.keys()].sort()).toEqual(['2026-03', '2026-04']);
    expect(grouped.get('2026-03')).toHaveLength(2);
  });
});

// ── date-form contract ────────────────────────────────────────────────────────────────
// Dotted archives exist on disk in every deployed project, so acceptance WIDENS to ISO rather
// than moving to it. The two describes below are deliberately separated: the first pins behaviour
// that is already correct (characterization — green before and after, never a red-proof candidate),
// the second is the genuinely-red set for the widening.

describe('date-form characterization — already green, guards a sloppy widening', () => {
  it('keeps dotted entry headings parsing unchanged', () => {
    const text = `${FM}\n# Changelog\n\n## 2026.05.20 — alpha\n\nbody one.\n\n## 2026.05.10 — beta\n\nbody two.\n`;
    const parsed = parseChangelogText(text);
    expect(parsed.entries.map((e) => e.dateStr)).toEqual(['2026.05.20', '2026.05.10']);
  });

  it('accepts a dated heading with no title at all (legacy tolerance, deliberately kept)', () => {
    const parsed = parseChangelogText(`${FM}\n# Changelog\n\n## 2026-07-20\n\nbody.\n`);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].title).toBe('');
  });

  it('leaves ordinary prose H2 headings alone', () => {
    const text = `${FM}\n# Changelog\n\n## History\n\n> pointer.\n\n---\n\n## 2026.05.20 — alpha\n\nbody.\n\n## Footer\n\nstray.\n`;
    const parsed = parseChangelogText(text);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.footer).toContain('## Footer');
  });
});

// The loud path (Arm A). A date-shaped heading that does not parse REFUSES, naming file:line —
// never absorbed as body text, never a silent footer boundary, never normalised. Both halves are
// pinned: the predicate (what refuses) and the disposition (a typed exitCode-1 error naming the
// offender, with no partial result escaping).
const expectRefusal = (fn, messageRe) => {
  let threw = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  expect(threw).not.toBe(null);
  expect(threw.exitCode).toBe(1);
  if (messageRe) expect(threw.message).toMatch(messageRe);
  return threw;
};

const between = (heading) =>
  `${FM}\n# Changelog\n\n## 2026.07.21 — good one\n\nbody one.\n\n${heading}\n\nORPHAN BODY.\n\n## 2026.01.05 — good two\n\nbody two.\n`;

// The title deliberately carries the PRIOR pins' names ("do not parse are LOUD", "the gap the
// fail-closed change will close"): red-proof records key on {base, testId}, a record whose test
// was renamed can neither be re-observed nor retired, and it would fail the final gate forever.
// Carrying the lineage in the title lets one re-observation SUPERSEDE the legacy keys honestly.
// The missing retirement lane is queued as RED-PROOF-RENAME-LANE.
describe('unparsed date-like headings refuse loudly: date-like headings that do not parse are LOUD — the gap the fail-closed change will close', () => {
  it('a mixed-separator date refuses instead of falling through', () => {
    expectRefusal(() => parseChangelogText(between('## 2026-07.20 — mixed separators')));
  });

  it('an impossible calendar date refuses in BOTH forms instead of being normalised', () => {
    for (const heading of ['## 2026.02.30 — impossible dotted', '## 2026-02-30 — impossible iso']) {
      expectRefusal(() => parseChangelogText(between(heading)), /calendar/);
    }
  });

  it('a wrong-level date heading refuses instead of hiding a whole corpus', () => {
    expectRefusal(() => parseChangelogText(between('### 2026-07-20 — wrong level')));
  });

  it('an indented date heading refuses instead of being glued', () => {
    expectRefusal(() => parseChangelogText(between('  ## 2026-07-19 — indented')));
  });

  it('a tab-separated date heading refuses instead of vanishing', () => {
    expectRefusal(() => parseChangelogText(between('##\t2026-07-18 — tab separated')));
  });

  it('the refusal names the file label and the 1-based line of the first offender', () => {
    const err = expectRefusal(() => parseChangelogText(between('## 2026/07/20 — slash'), 'docs/ai/changelog.md'));
    // FM is 5 lines; the offender sits 8 body lines further down.
    expect(err.message).toMatch(/^docs\/ai\/changelog\.md:13:/);
    expect(err.message).toContain('## 2026/07/20 — slash');
  });
});

// Same lineage-carrying title as above ("fenced code blocks are never scanned", "second gap the
// fail-closed change will close") — see the RED-PROOF-RENAME-LANE note.
describe('fenced regions are invisible to the entry grammar: fenced code blocks are never scanned — the second gap the fail-closed change will close', () => {
  const FENCE = '```';

  it('a heading inside a closed fence is never an entry, in either separator form', () => {
    for (const sample of ['## 2026.07.20 — an example entry', '## 2026-07-20 — an example entry']) {
      const text = `${FM}\n# Changelog\n\n## 2026.07.21 — teaches the format\n\nWrite entries like this:\n\n${FENCE}markdown\n${sample}\n${FENCE}\n\nend of body.\n`;
      const parsed = parseChangelogText(text);
      expect(parsed.entries.map((e) => e.dateStr)).toEqual(['2026.07.21']);
    }
  });

  it('an unclosed fence refuses loudly naming its opening line', () => {
    const text = `${FM}\n# Changelog\n\n## 2026.07.21 — good one\n\n${FENCE}markdown\n## 2026.07.20 — hidden\n`;
    expectRefusal(() => parseChangelogText(text), /never closed/);
  });
});

describe('structure refusals and the zero-corpus policy', () => {
  it('an entry heading after the footer boundary refuses instead of duplicating into the footer', () => {
    const text = `${FM}\n# Changelog\n\n## 2026.07.21 — good one\n\nbody.\n\n## Footer\n\nstray.\n\n## 2026.07.20 — after the footer\n\nlate body.\n`;
    expectRefusal(() => parseChangelogText(text), /footer/);
  });

  it('a rotated-empty tier with a preamble and no unit-shaped headings parses green with zero entries', () => {
    const text = `${FM}\n# Changelog\n\n## History\n\n> older sessions are layered.\n\n---\n`;
    const parsed = parseChangelogText(text);
    expect(parsed.entries).toEqual([]);
    expect(parsed.preamble).toContain('# Changelog');
  });

  it('a CRLF document parses identically, untitled ISO heading included', () => {
    const lf = `${FM}\n# Changelog\n\n## 2026.07.21 — titled\n\nbody one.\n\n## 2026-07-20\n\nbody two.\n`;
    const a = parseChangelogText(lf);
    const b = parseChangelogText(lf.replace(/\n/g, '\r\n'));
    expect(b.entries.map((e) => `${e.dateStr}|${e.title}`)).toEqual(a.entries.map((e) => `${e.dateStr}|${e.title}`));
    expect(b.frontmatter.replace(/\r\n/g, '\n')).toBe(a.frontmatter);
  });
});

describe('date-form contract — ISO accepted alongside dots', () => {
  it('accepts an ISO entry heading', () => {
    const text = `${FM}\n# Changelog\n\n## 2026-07-20 — iso alpha\n\nbody.\n`;
    const parsed = parseChangelogText(text);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].title).toBe('iso alpha');
  });

  it('parses every entry of a MIXED dotted+ISO file and leaves footer empty', () => {
    const text = `${FM}\n# Changelog\n\n## 2026.07.20 — alpha\n\nbody a.\n\n## 2026-06-15 — beta\n\nbody b.\n\n## 2026.05.10 — gamma\n\nbody g.\n`;
    const parsed = parseChangelogText(text);
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.footer).toBe('');
  });

  it('treats a genuine "## Footer" after an ISO entry as the footer boundary', () => {
    const text = `${FM}\n# Changelog\n\n## 2026-07-20 — alpha\n\nbody.\n\n## Footer\n\nstray.\n`;
    const parsed = parseChangelogText(text);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.footer).toContain('## Footer');
  });

  it('both separator forms of one entry parse, then share one dedupe identity', () => {
    const text = `${FM}\n# Changelog\n\n## 2026-05-12 — twin\n\nbody.\n\n## 2026.05.12 — twin\n\nbody.\n`;
    const parsed = parseChangelogText(text);
    // BOTH halves are asserted on purpose: a bare "dedupes to one" is green pre-fix, because the
    // ISO twin is simply invisible to the dotted-only parser and one entry is all there ever was.
    expect(parsed.entries).toHaveLength(2);
    const identities = new Set(parsed.entries.map((e) => `${e.dateStr}|${e.title}`));
    expect(identities.size).toBe(1);
  });

  it('renders an archived ISO entry date in its SOURCE form in the condensed index', () => {
    const text = `${FM}\n# Changelog\n\n## 2026-05-12 — iso cold\n\nbody.\n`;
    const [entry] = parseChangelogText(text).entries;
    const index = buildCondensedIndex([entry], new Map(), '2026-07-28');
    expect(index).toMatch(/\*\*2026-05-12\*\*/);
  });

  it('re-emits every entry heading verbatim across HOT, WARM and COLD', () => {
    const text = `${FM}\n# Changelog\n\n## 2026-05-12 — iso cold\n\nbody i.\n\n## 2026.05.10 — dotted cold\n\nbody d.\n`;
    const { entries } = parseChangelogText(text);
    expect(entries).toHaveLength(2);
    const hot = buildChangelog({ frontmatter: FM, preamble: '# Changelog', hot: entries, footer: '', hasArchive: false });
    const warm = buildRecent(entries, '2026-07-28');
    const cold = buildCold('2026', '05', entries, '2026-07-28');
    for (const rendered of [hot, warm, cold]) {
      expect(rendered).toContain('## 2026-05-12 — iso cold');
      expect(rendered).toContain('## 2026.05.10 — dotted cold');
    }
  });

  // In the PACKAGE this file sits beside references/templates/ and the seed is asserted; the
  // DEPLOYED copy runs in a consumer's scripts/ where no ../templates exists — a stated skip, not
  // an ENOENT crash (the canon-side kit template-parity suite still pins the seed every run).
  it('parses the seeded bootstrap heading shipped in references/templates/changelog.md', { skip: !existsSync(resolve(TEMPLATES_DIR, 'changelog.md')) && 'deployed copy: the template ships in the package, not at the consumer' }, () => {
    const template = readFileSync(resolve(TEMPLATES_DIR, 'changelog.md'), 'utf8');
    const seeded = template.replaceAll('{{DATE}}', '2026-07-28');
    const parsed = parseChangelogText(seeded);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].title).toBe('Bootstrap');
  });
});

// Arm B at the CLI seam. `runCli` is imported dynamically so this file still LOADS against a
// parser that predates it — the tests then fail as honest reds instead of taking the whole
// suite down with a module-load error.
describe('reading modes agree on refusal and write nothing', () => {
  const seedTree = (dir, text) => {
    mkdirSync(join(dir, 'docs/ai'), { recursive: true });
    writeFileSync(join(dir, 'docs/ai/changelog.md'), text, 'utf8');
  };

  for (const mode of [['--check'], ['--dry-run'], []]) {
    it(`${JSON.stringify(mode)} refuses the same malformed heading with exit 1 and leaves the tree untouched`, async () => {
      const { runCli } = await import('./archive-changelog.mjs');
      const dir = mkdtempSync(join(tmpdir(), 'archive-changelog-'));
      try {
        seedTree(dir, between('## 2026/07/20 — slash'));
        const before = readFileSync(join(dir, 'docs/ai/changelog.md'), 'utf8');
        const errs = [];
        const code = runCli(mode, { root: dir, log: () => {}, logError: (m) => errs.push(m) });
        expect(code).toBe(1);
        expect(errs.join('\n')).toContain('docs/ai/changelog.md:13');
        expect(readFileSync(join(dir, 'docs/ai/changelog.md'), 'utf8')).toBe(before);
        expect(existsSync(join(dir, 'docs/ai/history'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('the check verdict names the counts it acted on', async () => {
    const { runCli } = await import('./archive-changelog.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'archive-changelog-'));
    try {
      seedTree(dir, `${FM}\n# Changelog\n\n## 2026-07-28 — fresh\n\nbody.\n`);
      const logs = [];
      const code = runCli(['--check', '--today=2026-07-28'], { root: dir, log: (m) => logs.push(m), logError: (m) => logs.push(m) });
      expect(code).toBe(0);
      const out = logs.join('\n');
      expect(out).toContain('1 parsed entries');
      expect(out).toContain('HOT 1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rotation end to end through runCli', () => {
  const seedTree = (dir, rel, text) => {
    mkdirSync(join(dir, 'docs/ai'), { recursive: true });
    writeFileSync(join(dir, rel), text, 'utf8');
  };
  const FULL = `${FM}\n# Changelog\n\n## 2026-07-28 — hot iso\n\nbody hot.\n\n## 2026.07.10 — warm dotted\n\nbody warm.\n\n## 2026.03.02 — cold dotted\n\n**Goal:** cold body.\n\n## Footer\n\nstray.\n`;

  it('a default run writes every tier, keeps the footer, and a second run is a byte fixed point', async () => {
    const { runCli, parseChangelogText } = await import('./archive-changelog.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'archive-changelog-'));
    try {
      seedTree(dir, 'docs/ai/changelog.md', FULL);
      seedTree(dir, 'docs/ai/changelog-archive.md', `${FM}\n# Legacy\n\n## 2026.03.05 — legacy one\n\nbody legacy.\n`);
      const code = runCli(['--today=2026-07-28'], { root: dir, log: () => {}, logError: () => {} });
      expect(code).toBe(0);
      expect(existsSync(join(dir, 'docs/ai/history/recent.md'))).toBe(true);
      expect(existsSync(join(dir, 'docs/ai/history/2026-03.md'))).toBe(true);
      expect(existsSync(join(dir, 'docs/ai/history/condensed-index.md'))).toBe(true);
      const hot = readFileSync(join(dir, 'docs/ai/changelog.md'), 'utf8');
      const parsed = parseChangelogText(hot);
      expect(parsed.entries.map((e) => e.dateStr)).toEqual(['2026.07.28']);
      expect(parsed.footer).toContain('## Footer');
      expect(readFileSync(join(dir, 'docs/ai/history/2026-03.md'), 'utf8')).toContain('legacy one');
      expect(runCli(['--check', '--today=2026-07-28'], { root: dir, log: () => {}, logError: () => {} })).toBe(0);
      const warmBefore = readFileSync(join(dir, 'docs/ai/history/recent.md'), 'utf8');
      expect(runCli(['--today=2026-07-28'], { root: dir, log: () => {}, logError: () => {} })).toBe(0);
      expect(readFileSync(join(dir, 'docs/ai/changelog.md'), 'utf8')).toBe(hot);
      expect(readFileSync(join(dir, 'docs/ai/history/recent.md'), 'utf8')).toBe(warmBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a dry run prints the per-file census and writes nothing', async () => {
    const { runCli } = await import('./archive-changelog.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'archive-changelog-'));
    try {
      seedTree(dir, 'docs/ai/changelog.md', FULL);
      const logs = [];
      const code = runCli(['--dry-run', '--today=2026-07-28', '--hot-days=60', '--warm-days=90'], { root: dir, log: (m) => logs.push(m), logError: (m) => logs.push(m) });
      expect(code).toBe(0);
      const out = logs.join('\n');
      expect(out).toContain('"perFile"');
      expect(out).toContain('"hot": 2');
      expect(existsSync(join(dir, 'docs/ai/history'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a zero-corpus default run is a stated no-op — nothing written anywhere', async () => {
    const { runCli } = await import('./archive-changelog.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'archive-changelog-'));
    try {
      seedTree(dir, 'docs/ai/changelog.md', `${FM}\n# Changelog\n\n> no entries yet.\n`);
      const before = readFileSync(join(dir, 'docs/ai/changelog.md'), 'utf8');
      const logs = [];
      const code = runCli(['--today=2026-07-28'], { root: dir, log: (m) => logs.push(m), logError: (m) => logs.push(m) });
      expect(code).toBe(0);
      expect(logs.join('\n')).toContain('nothing to rotate');
      expect(readFileSync(join(dir, 'docs/ai/changelog.md'), 'utf8')).toBe(before);
      expect(existsSync(join(dir, 'docs/ai/history'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a stale HOT tier fails the check naming each overdue entry', async () => {
    const { runCli } = await import('./archive-changelog.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'archive-changelog-'));
    try {
      seedTree(dir, 'docs/ai/changelog.md', FULL);
      const errs = [];
      const code = runCli(['--check', '--today=2026-07-28'], { root: dir, log: () => {}, logError: (m) => errs.push(m) });
      expect(code).toBe(1);
      const out = errs.join('\n');
      expect(out).toContain('2026.07.10');
      expect(out).toContain('2026.03.02');
      expect(out).toContain('without --check');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('help exits 0, an unknown argument exits 2, a missing changelog exits 1', async () => {
    const { runCli } = await import('./archive-changelog.mjs');
    const logs = [];
    const errs = [];
    expect(runCli(['--help'], { root: '/nonexistent', log: (m) => logs.push(m), logError: () => {} })).toBe(0);
    expect(logs.join('\n')).toContain('Usage');
    expect(runCli(['--wat'], { root: '/nonexistent', log: () => {}, logError: (m) => errs.push(m) })).toBe(2);
    expect(errs.join('\n')).toContain('unknown argument');
    const dir = mkdtempSync(join(tmpdir(), 'archive-changelog-'));
    try {
      const missing = [];
      expect(runCli([], { root: dir, log: () => {}, logError: (m) => missing.push(m) })).toBe(1);
      expect(missing.join('\n')).toContain('not found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('idempotency contract', () => {
  it('parse → buildChangelog → parse yields identical entries (idempotency regression)', () => {
    const text = `${FM}\n# Changelog\n\n## History\n\n> pointer.\n\n---\n\n## 2026.05.23 — alpha\n\nbody one.\n\n---\n\n## 2026.05.22 — beta\n\nbody two.\n`;
    const first = parseChangelogText(text);
    const rebuilt = buildChangelog({
      frontmatter: first.frontmatter,
      preamble: first.preamble,
      hot: first.entries,
      footer: first.footer,
      hasArchive: true,
    });
    const second = parseChangelogText(rebuilt);
    expect(second.entries.map((e) => e.dateStr)).toEqual(first.entries.map((e) => e.dateStr));
    expect(second.entries.map((e) => e.title)).toEqual(first.entries.map((e) => e.title));
  });
});
