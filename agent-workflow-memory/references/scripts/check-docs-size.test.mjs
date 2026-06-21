import { describe, it, beforeEach, afterEach } from 'node:test';
import { expect } from './_expect-shim.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseFrontmatter,
  parseStaleAfter,
  computeToday,
  inspectFile,
  buildIndex,
  checkIndexFreshness,
} from './check-docs-size.mjs';

describe('parseFrontmatter', () => {
  it('extracts scalar fields from valid YAML frontmatter', () => {
    const text = '---\ntype: reference\nmaxLines: 500\nstaleAfter: 30d\n---\n\nbody.';
    const fm = parseFrontmatter(text);
    expect(fm).toEqual({
      type: 'reference',
      maxLines: '500',
      staleAfter: '30d',
    });
  });

  it('returns null when no frontmatter block is present', () => {
    expect(parseFrontmatter('just body text\n')).toBeNull();
  });

  it('skips lines that do not match key:value pattern', () => {
    const text = '---\ntype: reference\n# stray comment\nmaxLines: 100\n---\n';
    const fm = parseFrontmatter(text);
    expect(fm).toEqual({ type: 'reference', maxLines: '100' });
  });
});

describe('parseStaleAfter', () => {
  it('parses Nd into Number', () => {
    expect(parseStaleAfter('7d')).toBe(7);
    expect(parseStaleAfter('30d')).toBe(30);
  });

  it('returns null for "never", empty, or undefined', () => {
    expect(parseStaleAfter('never')).toBeNull();
    expect(parseStaleAfter('')).toBeNull();
    expect(parseStaleAfter(undefined)).toBeNull();
  });

  it('returns null for invalid formats', () => {
    expect(parseStaleAfter('7days')).toBeNull();
    expect(parseStaleAfter('7')).toBeNull();
  });
});

describe('computeToday', () => {
  it('parses YYYY-MM-DD into UTC-midnight Date', () => {
    const d = computeToday('2026-05-24');
    expect(d.toISOString()).toBe('2026-05-24T00:00:00.000Z');
  });

  it('returns a Date when todayStr is null (no-throw smoke)', () => {
    const d = computeToday(null);
    expect(d).toBeInstanceOf(Date);
    expect(Number.isNaN(d.getTime())).toBe(false);
  });
});

describe('inspectFile', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'check-docs-size-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports no errors and no warnings for an in-cap, fresh file', async () => {
    const path = join(dir, 'fresh.md');
    await writeFile(
      path,
      '---\ntype: reference\nlastUpdated: 2026-05-24\nstaleAfter: 30d\nmaxLines: 100\n---\n\n# OK\n',
    );
    const result = await inspectFile(path, computeToday('2026-05-24'));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('reports an error when lineCount > maxLines', async () => {
    const path = join(dir, 'big.md');
    const body = '\n'.repeat(20); // 20 lines of body → total ~26
    await writeFile(
      path,
      `---\ntype: reference\nlastUpdated: 2026-05-24\nstaleAfter: 30d\nmaxLines: 5\n---\n\n# Too big${body}`,
    );
    const result = await inspectFile(path, computeToday('2026-05-24'));
    expect(result.errors.some((e) => /lines > maxLines/.test(e))).toBe(true);
  });

  it('reports an error when frontmatter is missing maxLines', async () => {
    const path = join(dir, 'no-cap.md');
    await writeFile(path, '---\ntype: reference\nlastUpdated: 2026-05-24\n---\n\nbody.\n');
    const result = await inspectFile(path, computeToday('2026-05-24'));
    expect(result.errors).toContain('frontmatter missing maxLines');
  });

  it('reports a warning when lastUpdated is older than staleAfter window', async () => {
    const path = join(dir, 'stale.md');
    await writeFile(
      path,
      '---\ntype: reference\nlastUpdated: 2026-01-01\nstaleAfter: 30d\nmaxLines: 100\n---\n\nbody.\n',
    );
    const result = await inspectFile(path, computeToday('2026-05-24'));
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/staleAfter/);
    expect(result.errors).toEqual([]);
  });

  it('reports a single error when frontmatter is missing entirely', async () => {
    const path = join(dir, 'no-fm.md');
    await writeFile(path, '# Just a body, no frontmatter.\n');
    const result = await inspectFile(path, computeToday('2026-05-24'));
    expect(result.frontmatter).toBeNull();
    expect(result.errors).toContain('missing YAML frontmatter');
  });
});

// Synthetic row matching the shape produced by `inspectFile` + `formatRow`.
const makeRow = (path, overrides = {}) => ({
  path,
  lineCount: 50,
  frontmatter: { type: 'reference', maxLines: '100', lastUpdated: '2026-05-29', staleAfter: '30d' },
  errors: [],
  warnings: [],
  ...overrides,
});

describe('buildIndex', () => {
  it('is deterministic, sorts rows by path, and excludes index.md itself', () => {
    const rows = [
      makeRow('docs/ai/index.md'),
      makeRow('docs/ai/b.md'),
      makeRow('docs/ai/a.md'),
    ];
    const out = buildIndex(rows, '2026-05-29');
    expect(out).toBe(buildIndex(rows, '2026-05-29')); // deterministic
    expect(out).not.toMatch(/\[`index\.md`\]/); // index.md row excluded
    expect(out.indexOf('a.md')).toBeLessThan(out.indexOf('b.md')); // sorted
    expect(out).toMatch(/lastUpdated: 2026-05-29/); // header date is the argument
  });
});

// `checkIndexFreshness` drives the `--check-index` exit code:
//   fresh === true  → script exits 0
//   fresh === false → script exits 1 ("index stale, regenerate with --write-index")
describe('checkIndexFreshness', () => {
  const rows = [makeRow('docs/ai/a.md'), makeRow('docs/ai/b.md')];

  it('reports fresh when on-disk matches the regenerated index (→ exit 0)', () => {
    const onDisk = buildIndex(rows, '2026-05-29');
    expect(checkIndexFreshness(rows, onDisk).fresh).toBe(true);
  });

  it('reports stale when a source row drifted, e.g. line count changed (→ exit 1)', () => {
    const onDisk = buildIndex(rows, '2026-05-29');
    const drifted = [makeRow('docs/ai/a.md', { lineCount: 999 }), makeRow('docs/ai/b.md')];
    expect(checkIndexFreshness(drifted, onDisk).fresh).toBe(false);
  });

  it('reports stale when index.md is missing entirely (→ exit 1)', () => {
    expect(checkIndexFreshness(rows, null).fresh).toBe(false);
  });

  it('does NOT flag stale on a mere day-rollover with unchanged content (uses on-disk header date)', () => {
    const onDisk = buildIndex(rows, '2026-05-01'); // index regenerated weeks ago
    // Same source rows, "today" is later — content unchanged, so it must stay fresh.
    expect(checkIndexFreshness(rows, onDisk).fresh).toBe(true);
  });
});
