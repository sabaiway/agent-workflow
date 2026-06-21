import { describe, it } from 'node:test';
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
  it('emits frontmatter with maxLines 3500 for WARM archive', () => {
    const result = buildRecent([makeEntry('2026.05.10', 'warm')], '2026-05-24');
    expect(result).toMatch(/maxLines: 3500/);
    expect(result).toMatch(/Changelog WARM Archive/);
    expect(result).toMatch(/## 2026\.05\.10/);
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
