import { describe, it } from 'node:test';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from './_expect-shim.mjs';
import { runCli } from './archive-changelog.mjs';

// RED-FIRST, and deliberately a DYNAMIC import: `archive-caps.mjs` does not exist when these arms
// are first recorded, and a STATIC import of an absent module makes the WHOLE file unloadable — every
// arm would then be recorded as "unresolvable" rather than as failing, which proves nothing about the
// behaviour it pins. Imported this way the file still loads and each arm fails on its own missing
// symbol.
const caps = await import('./archive-caps.mjs').catch(() => ({}));

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
  for (let m = 0; m < months; m += 1) {
    const year = 2019 + Math.floor(m / 12);
    const month = String((m % 12) + 1).padStart(2, '0');
    for (let i = 0; i < perMonth; i += 1) dates.push(`${year}.${month}.${day(i)}`);
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
  return { code, out: out.join('\n'), err: err.join('\n') };
};

const historyDir = (root) => join(root, 'docs', 'ai', 'history');
const emitted = (root, name) => readFileSync(join(historyDir(root), name), 'utf8');

// A refusal must leave the tree BYTE-unchanged, and "the history dir is still empty" does not say
// that: it would miss a rewritten changelog.md. Snapshot every file under docs/ai instead.
// Built with fromCharCode, not an escape literal: the separator only has to be deterministic, and
// spelling it in code points keeps a stray byte out of a file the NUL guard scans.
const SEP = String.fromCharCode(10, 64, 64, 10);
const snapshot = (root) => {
  const base = join(root, 'docs', 'ai');
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

describe('the archiver refuses past a ceiling, identically in every mode', () => {
  // The refusal has to fire in --check and --dry-run as well as the default run, or the standing
  // `--check` gate would go green on a corpus the next real run cannot write. That is only true if
  // every output is BUILT before the mode branch — which is what these three arms pin.
  const modes = [[], ['--dry-run'], ['--check']];

  // Each mode gets its OWN fixture: sharing one root lets an earlier mode's write hide inside a
  // later mode's assertion. And the tree is compared WHOLE before and after, so a rewritten
  // changelog.md is caught as well as a written archive.
  const refusesInEveryMode = (dates, tall, ceiling) => {
    for (const argv of modes) {
      withRoot((root) => {
        seed(root, dates, tall);
        const before = snapshot(root);
        const result = run(root, argv);
        expect(result.code).toBe(1);
        expect(result.err).toContain(`${ceiling}-line ceiling`);
        expect(snapshot(root)).toBe(before);
      });
    }
  };

  it('cold: a month past the ceiling refuses in all three modes', () => {
    refusesInEveryMode(oneMonth(400), true, 3000);
  });

  it('warm: a window past the ceiling refuses in all three modes', () => {
    refusesInEveryMode(warmWindow(700), true, 7000);
  });

  it('meta: a corpus past the ceiling refuses in all three modes', () => {
    refusesInEveryMode(manyMonths(62, 50), false, 3000);
  });

  // Two arms, deliberately separate: this one pins that a refusal is ACTIONABLE at all — it names
  // the tier, the measured size and a remedy clause, rather than a bare number the reader has to
  // interpret.
  it('the refusal names the tier and the remedy, not just the number', () => {
    withRoot((root) => {
      seed(root, oneMonth(400));
      const cold = run(root, ['--check']);
      expect(cold.err).toContain('cold archive is');
      expect(cold.err).toContain('-line ceiling');
      expect(cold.err).toContain('Remedy:');
    });
  });

  // And this one pins that the remedy is RIGHT for the tier it is printed for. One piece of advice
  // would be wrong for two of the three: COLD is already one file per month, and WARM's size is a
  // flag rather than a layout. A remedy must also never name a layout the archiver cannot read back.
  it('the refusal names the tier and a remedy that fits THAT tier', () => {
    withRoot((root) => {
      seed(root, oneMonth(400));
      const cold = run(root, ['--check']);
      expect(cold.err).toContain('already one file per month');
      expect(cold.err).toContain('NOT implemented');
    });
    withRoot((root) => {
      seed(root, warmWindow(700));
      const warm = run(root, ['--check']);
      expect(warm.err).toContain('warm archive is');
      expect(warm.err).toContain('--warm-days');
    });
    withRoot((root) => {
      seed(root, manyMonths(62, 50), false);
      const meta = run(root, ['--check']);
      expect(meta.err).toContain('meta archive is');
      expect(meta.err).toContain('condensed-index-YYYY.md');
    });
  });
});

describe('the sharding tripwire', () => {
  it('meta past its floor warns while still passing, so the remedy lands before the ceiling', () => {
    withRoot((root) => {
      seed(root, manyMonths(32, 50), false);
      const result = run(root, []);
      expect(result.code).toBe(0);
      expect(result.err).toContain('past its 1500-line floor');
      expect(result.err).toContain('condensed-index-YYYY.md');
    });
  });

  it('meta under its floor says nothing at all', () => {
    withRoot((root) => {
      seed(root, oneMonth(4));
      const result = run(root, []);
      expect(result.code).toBe(0);
      expect(result.err).not.toMatch(/floor/);
    });
  });
});
