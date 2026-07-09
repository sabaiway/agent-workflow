import { describe, it, beforeEach, afterEach } from 'node:test';
import { expect } from './_expect-shim.mjs';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseFrontmatter,
  parseStaleAfter,
  computeToday,
  inspectFile,
  buildIndex,
  checkIndexFreshness,
  walkMarkdownFiles,
  regenerateIndex,
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

// The cap-validator discovers ONLY `*.md` files, so a non-`.md` doc — e.g. a hand-edited
// `docs/ai/orchestration.json` config — is inherently skipped: never validated for frontmatter / caps.
// This belt-and-suspenders regression pins that skip so adding a config `.json` under docs/ai can never
// start failing the docs gate.
describe('walkMarkdownFiles — only *.md is discovered (a config .json is skipped)', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'walk-md-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the .md file and NOT a sibling orchestration.json', async () => {
    await writeFile(join(dir, 'doc.md'), '---\ntype: reference\nmaxLines: 100\n---\n\nbody.\n');
    await writeFile(join(dir, 'orchestration.json'), '{ "plan-authoring": { "review": "reviewed" } }\n');
    const found = await walkMarkdownFiles(dir);
    expect(found.some((f) => f.endsWith('doc.md'))).toBe(true);
    expect(found.some((f) => f.endsWith('.json'))).toBe(false);
    expect(found.some((f) => f.endsWith('orchestration.json'))).toBe(false);
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

// The one-file-per-ADR store collapses to a SINGLE aggregate index row so the index stays under its
// own 80-line cap no matter how many records accumulate — while every body is still cap-checked.
describe('buildIndex — docs/ai/adr/ directory collapse (Decision 11)', () => {
  it('200 synthetic AD-*.md records collapse to ONE aggregate row; the index stays ≤ 80 lines', () => {
    const adr = Array.from({ length: 200 }, (_, i) => makeRow(`docs/ai/adr/AD-${String(i + 1).padStart(3, '0')}-record-${i}.md`, { frontmatter: { type: 'adr', maxLines: '400', lastUpdated: '2026-07-09', staleAfter: 'never' } }));
    const rows = [makeRow('docs/ai/handover.md'), makeRow('docs/ai/adr/log.md', { frontmatter: { type: 'reference', maxLines: '200' } }), ...adr];
    const out = buildIndex(rows, '2026-07-09');
    const adrRowLines = out.split('\n').filter((l) => l.includes('](./adr/log.md)'));
    expect(adrRowLines.length).toBe(1); // exactly one row references the whole adr/ tree
    expect(out).not.toMatch(/AD-001-record-0\.md/); // individual records are NOT listed
    expect(out.split('\n').length <= 80).toBe(true);
  });

  it('a stray adr/ markdown file renders as its OWN visible row (never collapsed/hidden)', () => {
    const rows = [
      makeRow('docs/ai/adr/AD-001-a.md', { frontmatter: { type: 'adr', maxLines: '400' } }),
      makeRow('docs/ai/adr/log.md', { frontmatter: { type: 'reference', maxLines: '200' } }),
      makeRow('docs/ai/adr/notes.md', { frontmatter: { type: 'reference', maxLines: '100' } }),
    ];
    const out = buildIndex(rows, '2026-07-09');
    expect(out).toMatch(/adr\/notes\.md/); // the stray is a visible row, not swallowed by the collapse
    const aggregateRows = out.split('\n').filter((l) => l.includes('](./adr/log.md)'));
    expect(aggregateRows.length).toBe(1); // exactly one aggregate row for the real record(s)
  });

  it('the aggregate row shows the record count and a NUMERIC id range (AD-200 … AD-1000)', () => {
    const rows = [
      makeRow('docs/ai/adr/AD-200-a.md', { frontmatter: { type: 'adr', maxLines: '400' } }),
      makeRow('docs/ai/adr/AD-1000-b.md', { frontmatter: { type: 'adr', maxLines: '400' } }),
      makeRow('docs/ai/adr/log.md', { frontmatter: { type: 'reference', maxLines: '200' } }),
    ];
    const out = buildIndex(rows, '2026-07-09');
    expect(out).toMatch(/\[`adr\/`\]\(\.\/adr\/log\.md\) \| adr \| 2 records \| AD-200 … AD-1000/);
  });

  it('adding a record drifts the collapse row → checkIndexFreshness flags it stale', () => {
    const base = [makeRow('docs/ai/adr/AD-001-a.md', { frontmatter: { type: 'adr', maxLines: '400' } }), makeRow('docs/ai/adr/log.md', { frontmatter: { type: 'reference', maxLines: '200' } })];
    const onDisk = buildIndex(base, '2026-07-09');
    const grown = [...base, makeRow('docs/ai/adr/AD-002-b.md', { frontmatter: { type: 'adr', maxLines: '400' } })];
    expect(checkIndexFreshness(grown, onDisk).fresh).toBe(false);
  });

  it('a single adr record OVER its own cap still fails inspectFile (the collapse never hides a fat body)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adr-cap-'));
    try {
      const path = join(dir, 'AD-001-huge.md');
      await writeFile(path, `---\ntype: adr\nlastUpdated: 2026-07-09\nscope: permanent\nstaleAfter: never\nowner: none\nmaxLines: 5\n---\n\n## AD-001 — Huge\n${'x\n'.repeat(20)}`);
      const result = await inspectFile(path, computeToday('2026-07-09'));
      expect(result.errors.some((e) => /lines > maxLines/.test(e))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
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

// ── (h) — root-parameterization: the ADR-rotation hook regenerates ANOTHER root's index ────
// The generator's module ROOT is the CLI default only; --root / regenerateIndex(root) target an
// arbitrary tree so the rotation hook (and hermetic tests) never touch the real repo.
describe('root parameterization (item (h))', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'check-docs-root-'));
    await mkdir(join(root, 'docs', 'ai'), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const seedDoc = (name, extra = '') =>
    writeFile(join(root, 'docs', 'ai', name), `---\ntype: reference\nlastUpdated: 2026-07-08\nscope: permanent\nstaleAfter: 30d\nowner: none\nmaxLines: 100\n---\n\n# ${name}\n${extra}`);

  it('inspectFile computes the file path RELATIVE to the passed root (not the module ROOT)', async () => {
    await seedDoc('handover.md');
    const result = await inspectFile(join(root, 'docs', 'ai', 'handover.md'), computeToday('2026-07-08'), root);
    expect(result.path).toBe('docs/ai/handover.md');
  });

  it('regenerateIndex(root, today) writes THAT root\'s docs/ai/index.md from its frontmatter', async () => {
    await seedDoc('a.md');
    await seedDoc('b.md');
    const res = await regenerateIndex(root, '2026-07-08');
    expect(res.indexPath).toBe(join(root, 'docs', 'ai', 'index.md'));
    expect(existsSync(res.indexPath)).toBe(true);
    const index = await readFile(res.indexPath, 'utf8');
    expect(index).toMatch(/lastUpdated: 2026-07-08/); // header date is the argument
    expect(index).toMatch(/a\.md/);
    expect(index).toMatch(/b\.md/);
    expect(index).not.toMatch(/\[`index\.md`\]/); // the index never lists itself
  });

  it('a re-run with unchanged sources is byte-identical (deterministic, --check-index safe)', async () => {
    await seedDoc('a.md');
    const first = await regenerateIndex(root, '2026-07-08');
    const bytesA = await readFile(first.indexPath, 'utf8');
    await regenerateIndex(root, '2026-07-08');
    const bytesB = await readFile(first.indexPath, 'utf8');
    expect(bytesB).toBe(bytesA);
  });

  // The CLI entry (main) over --root — a subprocess smoke so the --help usage + the --check-index
  // fresh/stale branches (root-parameterized) are exercised end-to-end.
  const SCRIPT = fileURLToPath(new URL('./check-docs-size.mjs', import.meta.url));
  const runCli = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  it('--help prints the usage (naming --root) and exits 0', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/--root=/);
  });

  it('--check-index --root: a fresh index is OK (exit 0); a drifted one is stale (exit 1)', async () => {
    await seedDoc('a.md');
    expect(runCli(['--write-index', `--root=${root}`]).status).toBe(0);
    const fresh = runCli(['--check-index', `--root=${root}`]);
    expect(fresh.status).toBe(0);
    expect(fresh.stdout).toMatch(/in sync/);
    await seedDoc('b.md'); // a new source row drifts the on-disk index
    const stale = runCli(['--check-index', `--root=${root}`]);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/stale/);
  });
});
