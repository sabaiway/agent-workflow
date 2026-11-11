import { describe, it } from 'node:test';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from '../test-support/index.mjs';
import { runCli, parseChangelogText, buildCondensedIndex, groupByMonth } from './archive-changelog.mjs';

import * as caps from './archive-caps.mjs';

// The tier table, restated here on purpose. A test that imports the table it is checking agrees with
// the source by construction and pins nothing; these three rows are the frozen contract, and moving a
// number in the module must break this file.
const TABLE = [
  ['cold', 1500, 3000],
  ['warm', 3500, 7000],
  ['meta', 1500, 3000],
];

// Every arm builds its own corpus under a temp root and passes a fixed `--today`, so nothing here
// reads the project's own `docs/ai` — these pass in a clean checkout where that tree is absent.
const TODAY = '2026-06-15';
const FM = '---\ntype: history\nlastUpdated: 2026-06-15\nscope: permanent\nstaleAfter: never\nowner: none\nmaxLines: 700\n---\n';

const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'archive-caps-'));
  mkdirSync(join(root, 'docs', 'ai', 'history'), { recursive: true });
  return root;
};

// TALL entries carry a files block and a metric, so compression keeps eight lines of them; MINIMAL
// entries keep three. The difference is how a tier is driven to a chosen size: COLD/WARM need height,
// META needs COUNT (one line per archived entry) with every month's own COLD file left small.
const entryBlock = (dateStr, n, tall) =>
  tall
    ? `## ${dateStr} — synthetic ${n}\n\n**Goal:** synthetic session ${n}.\n\n**Files:**\n- \`src/f${n}.mjs\`\n\n**Result:** ${n} tests\n`
    : `## ${dateStr} — synthetic ${n}\n\n**Goal:** synthetic session ${n}.\n`;

const seed = (root, dates, tall = true) => {
  const body = dates.map((d, i) => entryBlock(d, i + 1, tall)).join('\n');
  writeFileSync(join(root, 'docs', 'ai', 'changelog.md'), `${FM}\n# Changelog\n\n${body}`, 'utf8');
};

const day = (i) => String((i % 28) + 1).padStart(2, '0');

// One month, well behind the WARM cutoff — everything lands in that month's COLD file.
const oneMonth = (count) => Array.from({ length: count }, (_, i) => `2026.03.${day(i)}`);

// Inside the WARM window (older than today-3, newer than today-30 = 2026-05-16).
const warmWindow = (count) =>
  Array.from({ length: count }, (_, i) => `2026.05.${String(17 + (i % 14)).padStart(2, '0')}`);

// Spread across many CLOSED months so META grows by count while no single COLD file gets near its
// own ceiling — the only shape in which META can be the tier that refuses.
const manyMonths = (months, perMonth) => {
  const dates = [];
  for (const m of Array.from({ length: months }, (_, i) => i)) {
    const year = 2019 + Math.floor(m / 12);
    const month = String((m % 12) + 1).padStart(2, '0');
    for (const i of Array.from({ length: perMonth }, (_, i) => i)) dates.push(`${year}.${month}.${day(i)}`);
  }
  return dates;
};

const run = (root, argv) => {
  const out = [];
  const err = [];
  const code = runCli([...argv, `--today=${TODAY}`], {
    root,
    log: (m) => out.push(String(m)),
    logError: (m) => err.push(String(m)),
  });
  return { code, out: out.join('\n'), err: err.join('\n'), log: out, logError: err };
};

const historyDir = (root) => join(root, 'docs', 'ai', 'history');
const emitted = (root, name) => readFileSync(join(historyDir(root), name), 'utf8');

// A refusal must leave the tree BYTE-unchanged, and "the history dir is still empty" does not say
// that: it would miss a rewritten changelog.md. Snapshot every file under the root instead.
// Built with fromCharCode, not an escape literal: the separator only has to be deterministic, and
// spelling it in code points keeps a stray byte out of a file the NUL guard scans.
const SEP = String.fromCharCode(10, 64, 64, 10);
const snapshot = (root) => {
  const base = root;
  const walk = (dir, prefix) =>
    readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
          : [`${prefix}${entry.name}:${readFileSync(join(dir, entry.name), 'utf8')}`],
      );
  return walk(base, '').join(SEP);
};
const stampOf = (text) => Number(/^maxLines: (\d+)$/m.exec(text)[1]);
const countOf = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

const refusal = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
};

const withRoot = (body) => {
  const root = makeRoot();
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe('capFor — the frozen tier table', () => {
  for (const [tier, floor, ceiling] of TABLE) {
    it(`capFor: ${tier} stamps the floor below it, its own count inside the band, and the ceiling itself`, () => {
      expect(caps.capFor({ tier, count: 0 })).toBe(floor);
      expect(caps.capFor({ tier, count: floor - 1 })).toBe(floor);
      expect(caps.capFor({ tier, count: floor })).toBe(floor);
      expect(caps.capFor({ tier, count: floor + 1 })).toBe(floor + 1);
      expect(caps.capFor({ tier, count: ceiling - 1 })).toBe(ceiling - 1);
      // The boundary ACCEPTS. A cap equal to the count is a cap the file honours, so the ceiling is
      // the LAST count that can be stamped, never the first that refuses — and stamping the count
      // (not the ceiling) here is what separates this from a `Math.min(count, ceiling)` that would
      // pass the boundary arm while getting the whole band wrong.
      expect(caps.capFor({ tier, count: ceiling })).toBe(ceiling);
    });

    it(`capFor: ${tier} refuses one line past its ceiling`, () => {
      const err = refusal(() => caps.capFor({ tier, count: ceiling + 1 }));
      expect(err).not.toBeNull();
      expect(err.message).toContain(`${ceiling}-line ceiling`);
      expect(err.exitCode).toBe(1);
    });
  }

  it('capFor: an unknown tier and a nonsense count both refuse rather than stamp a default', () => {
    expect(refusal(() => caps.capFor({ tier: 'lukewarm', count: 10 })).message).toContain('unknown archive tier');
    expect(refusal(() => caps.capFor({ tier: 'cold', count: -1 })).message).toContain('non-negative integer');
    expect(refusal(() => caps.capFor({ tier: 'cold', count: 1.5 })).message).toContain('non-negative integer');
  });

  it('countLines: counts the docs gate its own way — a trailing newline ends a line, it never opens one', () => {
    expect(caps.countLines('a\nb\n')).toBe(2);
    expect(caps.countLines('a\nb')).toBe(2);
    expect(caps.countLines('a\n')).toBe(1);
    expect(caps.countLines('a\n\n')).toBe(2);
  });

  it('shardingWarning: silent under the floor, and past it names the tier, the count and the remedy', () => {
    expect(caps.shardingWarning({ tier: 'meta', count: 1500 })).toBeNull();
    const warning = caps.shardingWarning({ tier: 'meta', count: 1501 });
    expect(warning).toContain('1501');
    expect(warning).toContain('1500-line floor');
    expect(warning).toContain('condensed-index-YYYY.md');
  });
});

describe('the archiver stamps a cap it can honour', () => {
  it('cold: a band-sized month stamps its own count and round-trips byte-identically', () => {
    withRoot((root) => {
      seed(root, oneMonth(160));
      expect(run(root, []).code).toBe(0);

      const first = emitted(root, '2026-03.md');
      const count = countOf(first);
      // Strictly inside the band: below the floor the tier would stamp the floor and this arm would
      // pin nothing; at or above the ceiling it would refuse.
      expect(count).toBeGreaterThan(1500);
      expect(count).toBeLessThan(3001);
      expect(stampOf(first)).toBe(count);

      // The byte fixed point, under the new stamp: run two re-reads what run one wrote — including
      // the cap it stamped — and must reproduce it exactly.
      expect(run(root, []).code).toBe(0);
      expect(emitted(root, '2026-03.md')).toBe(first);
    });
  });

  it('warm: a band-sized window stamps its own count and round-trips byte-identically', () => {
    withRoot((root) => {
      seed(root, warmWindow(400));
      expect(run(root, []).code).toBe(0);

      const first = emitted(root, 'recent.md');
      const count = countOf(first);
      expect(count).toBeGreaterThan(3500);
      expect(count).toBeLessThan(7001);
      expect(stampOf(first)).toBe(count);

      expect(run(root, []).code).toBe(0);
      expect(emitted(root, 'recent.md')).toBe(first);
    });
  });

  it('meta: a band-sized corpus stamps its own count and round-trips byte-identically', () => {
    withRoot((root) => {
      seed(root, manyMonths(32, 50), false);
      expect(run(root, []).code).toBe(0);

      const first = emitted(root, 'condensed-index.md');
      const count = countOf(first);
      expect(count).toBeGreaterThan(1500);
      expect(count).toBeLessThan(3001);
      expect(stampOf(first)).toBe(count);

      expect(run(root, []).code).toBe(0);
      expect(emitted(root, 'condensed-index.md')).toBe(first);
    });
  });

  it('a tier under its floor still stamps the floor — the cap never shrinks to the corpus', () => {
    withRoot((root) => {
      seed(root, oneMonth(4));
      expect(run(root, []).code).toBe(0);
      const cold = emitted(root, '2026-03.md');
      expect(countOf(cold)).toBeLessThan(1500);
      expect(stampOf(cold)).toBe(1500);
    });
  });
});

describe('spec:archive-rotations/S9 tier refusals and sharding warning seams', () => {
  // The refusal has to fire in --check and --dry-run as well as the default run, or the standing
  // `--check` gate would go green on a corpus the next real run cannot write. That is only true if
  // every output is BUILT before the mode branch — which is what these three arms pin.
  const modes = [[], ['--dry-run'], ['--check']];
  // Each mode gets its OWN fixture: sharing one root lets an earlier mode's write hide inside a
  // later mode's assertion. And the tree is compared WHOLE before and after, so a rewritten
  // changelog.md is caught as well as a written archive.
  for (const [tier, dates, tall, file, remedyFragment] of [
    ['cold', oneMonth(400), true, 'docs/ai/history/2026-03.md', 'already one file per month'],
    ['warm', warmWindow(700), true, 'docs/ai/history/recent.md', '--warm-days'],
    ['meta', manyMonths(62, 50), false, 'docs/ai/history/condensed-index.md', 'condensed-index-YYYY.md'],
  ]) for (const argv of modes) {
    it(`${tier}: past its ceiling ${JSON.stringify(argv)} refuses without writing`, () => {
      withRoot((root) => {
        seed(root, dates, tall);
        const before = snapshot(root);
        const result = run(root, argv);
        expect(result.code).toBe(1);
        expect(snapshot(root)).toBe(before);
        expect(result.log).toHaveLength(3);
        expect(result.log[0]).toBe(`archive-changelog: FAIL — the ${tier} tier ${file} is past its ceiling`);
        expect(result.log[1].startsWith(`${file}: ${tier} archive is `)).toBe(true);
        expect(result.log[1]).toContain('-line ceiling');
        expect(result.log[2]).toBe(`archive-changelog: REMEDY — ${caps.CAP_TABLE[tier].remedy}`);
        expect(result.log[2]).toContain(remedyFragment);
        expect(result.logError).toEqual([]);
      });
    });
  }

  const warningFor = (root) => {
    const { entries } = parseChangelogText(readFileSync(join(root, 'docs/ai/changelog.md'), 'utf8'));
    const index = buildCondensedIndex([], groupByMonth(entries), TODAY);
    return `[archive-changelog] WARNING: ${caps.shardingWarning({ tier: 'meta', count: countOf(index) })}`;
  };
  for (const mode of ['default', 'dry-run', 'check after rotation']) {
    it(`meta past its floor: green ${mode} warns on logError`, () => {
      withRoot((root) => {
        seed(root, manyMonths(32, 50), false);
        const warning = warningFor(root);
        if (mode === 'check after rotation') expect(run(root, []).code).toBe(0);
        const result = run(root, mode === 'default' ? [] : [mode === 'dry-run' ? '--dry-run' : '--check']);
        expect(result.code).toBe(0);
        expect(result.logError).toEqual([warning]);
        expect(result.log).not.toContain(warning);
      });
    });
  }

  it('meta past its floor: red check puts its warning after the remedy on log', () => {
    withRoot((root) => {
      seed(root, manyMonths(32, 50), false);
      const warning = warningFor(root);
      const before = snapshot(root);
      const text = readFileSync(join(root, 'docs/ai/changelog.md'), 'utf8');
      const findings = text.split('\n').flatMap((line, index) => {
        const heading = /^## (.+) — (.+)$/.exec(line);
        return heading ? [`docs/ai/changelog.md:${index + 1}: ${heading[1]} — ${heading[2]}`] : [];
      });
      const result = run(root, ['--check']);
      expect(result.code).toBe(1);
      expect(snapshot(root)).toBe(before);
      expect(findings).toHaveLength(1600);
      expect(result.log).toEqual([
        'archive-changelog: FAIL — entries of docs/ai/changelog.md older than 3 days (relative to 2026-06-15): 1600',
        ...findings,
        'archive-changelog: REMEDY — rotate them with node scripts/agent-workflow/run.mjs archive-changelog',
        warning,
      ]);
      expect(result.logError).toEqual([]);
    });
  });

  it('meta past its floor: a failed index write puts the warning after the unexpected-error stack on log', () => {
    withRoot((root) => {
      seed(root, manyMonths(32, 50), false);
      const warning = warningFor(root);
      const path = join(historyDir(root), 'condensed-index.md');
      mkdirSync(path);
      const result = run(root, []);
      expect(result.code).toBe(1);
      expect(result.log[0]).toMatch(/^archive-changelog: FAIL — unexpected error: /);
      expect(result.log[1]).toBe('archive-changelog: REMEDY — fix the cause the stack below names, then re-run');
      expect(result.log.length).toBeGreaterThan(4);
      expect(result.log[2]).toMatch(/^Error: /);
      expect(result.log.at(-1)).toBe(warning);
      expect(result.log.slice(0, -1).join('\n')).not.toContain(warning);
      for (const line of result.log) expect(line).not.toMatch(/[\r\n]/);
      expect(result.logError).toEqual([]);
    });
  });

  it('meta under its floor says nothing at all', () => {
    withRoot((root) => {
      seed(root, oneMonth(4));
      const result = run(root, []);
      expect(result.code).toBe(0);
      expect(result.logError).toEqual([]);
    });
  });
});
