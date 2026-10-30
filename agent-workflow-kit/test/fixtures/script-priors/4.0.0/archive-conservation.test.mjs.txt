import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeMarkdown } from './markdown-blocks.mjs';
import {
  parseChangelogText,
  computeCutoffs,
  categorize,
  compressEntry,
  buildChangelog,
  buildRecent,
  buildCold,
  groupByMonth,
} from './archive-changelog.mjs';

// ── The conservation / round-trip harness (Phase 2.0) ─────────────────────────────────
//
// Built BEFORE the parsers move onto the tokenizer, against the current code, so it is a
// checker and not a rationalisation. Its contract, for EVERY input:
//
//   either the parse REFUSES loudly (a typed Error carrying exitCode 1 and a message),
//   or the three properties hold:
//     conservation      — every body line lands in exactly one bucket, none dropped, none doubled
//     round-trip        — a full rotation re-parses to the same entry set
//     self-consumption  — the rotator accepts the HOT/WARM/COLD its own writer just wrote
//
// A crash (TypeError, missing exitCode) is NOT a refusal: a refusal has a predicate AND a
// disposition, and the disposition asserted here is "a typed error that names its cause,
// with no partial result". Deliberately dropped decoration (blank lines, `---` separators,
// `**Last Updated:**` footers) is excluded from the accounting on both sides — everything
// else must be conserved.

const FM = '---\ntype: history\nlastUpdated: 2026-07-28\nmaxLines: 700\n---\n';
const B = '```';
const TODAY = '2026-07-28';

const matchableView = (line) => line.replace(/\s+$/, '');
const isDroppable = (line) =>
  line === '' || line === '---' || /^\*\*Last Updated:/i.test(line);

const accountable = (text) =>
  text.split('\n').map(matchableView).filter((line) => !isDroppable(line));

const countLines = (lines) => {
  const counts = new Map();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
};

const conservationDelta = (text, parsed) => {
  const input = countLines(accountable(text));
  const output = countLines(
    [parsed.frontmatter, parsed.preamble, ...parsed.entries.map((e) => e.block), parsed.footer]
      .filter((s) => s !== '')
      .flatMap((s) => accountable(s)),
  );
  const missing = [];
  const duplicated = [];
  for (const [line, n] of input) if ((output.get(line) ?? 0) < n) missing.push(line);
  for (const [line, n] of output) if (n > (input.get(line) ?? 0)) duplicated.push(line);
  return { missing, duplicated };
};

const assertTypedRefusal = (err, context) => {
  assert.ok(err instanceof Error, `${context}: a refusal must be an Error, got ${typeof err}`);
  assert.equal(
    err.exitCode,
    1,
    `${context}: a refusal carries exitCode 1 — a crash is not a refusal (${err.message})`,
  );
  assert.ok(err.message.length > 0, `${context}: a refusal names its cause`);
};

const identity = (entry) => `${entry.dateStr}|${entry.title}`;

const rotateInMemory = (parsed) => {
  const cutoffs = computeCutoffs(TODAY, 3, 30);
  const { hot, warm, cold } = categorize(parsed.entries, cutoffs);
  const coldByMonth = groupByMonth(cold);
  const tiers = [
    [
      'HOT',
      buildChangelog({
        frontmatter: parsed.frontmatter || FM,
        preamble: parsed.preamble || '# Changelog',
        hot,
        footer: parsed.footer,
        hasArchive: warm.length > 0 || cold.length > 0,
      }),
    ],
  ];
  if (warm.length > 0) tiers.push(['WARM', buildRecent(warm, TODAY)]);
  for (const [key, entries] of coldByMonth) {
    const [year, month] = key.split('-');
    tiers.push([`COLD ${key}`, buildCold(year, month, entries, TODAY)]);
  }
  return { tiers, hot, warm, cold };
};

// ── seeded generator with a one-pass oracle ───────────────────────────────────────────
//
// The oracle (which headings are REAL entries, and whether the document must refuse) is
// recorded WHILE emitting, never re-derived with a regex afterwards — so a disagreement
// with the parser is a real failure, not two copies of one mistake agreeing. Drawn from
// the LCG's high bits (the low bit strictly alternates and starves input classes).

const DATE_GRID = [
  ['07', '28'], ['07', '27'], ['07', '26'], // HOT at TODAY with hot-days=3
  ['07', '20'], ['07', '10'], ['07', '02'], // WARM
  ['05', '27'], ['05', '15'], ['03', '02'], // COLD
];

const MALFORMED = [
  '## 2026-06-15 (no dash sep)',
  '## 2026/07/20 — slash date',
  '## 2026-7-20 — single digit',
  '## 2026-07 — truncated',
  '## 20260720 — unseparated',
  '## 2026-07.20 — mixed separators',
  '## 2026-02-30 — impossible date',
  '  ## 2026-07-19 — indented',
  '##\t2026-07-18 — tab separated',
];

const buildDoc = (seed) => {
  let state = seed;
  const rand = (n) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return Math.floor(state / 65536) % n;
  };

  const eol = rand(4) === 0 ? '\r\n' : '\n';
  const rows = [];
  const oracle = { entries: [], mustRefuse: false, crlf: eol === '\r\n' };

  const frontmatter = rand(5) === 0 ? '' : FM.replace(/\n/g, eol);
  rows.push('# Changelog');
  rows.push('');
  if (rand(3) === 0) {
    rows.push('## History');
    rows.push('');
    rows.push('> older sessions are layered.');
    rows.push('');
    rows.push('---');
    rows.push('');
  }

  const entryCount = 1 + rand(4);
  // start ranges over the WHOLE grid tail (a start of 3 was the blind spot: with at most four
  // entries the COLD rows were unreachable in every seed, and the non-idempotent COLD compressor
  // sailed through — the tier sentinel below pins the reach).
  const start = rand(6);
  for (let i = 0; i < entryCount; i += 1) {
    const [month, day] = DATE_GRID[start + i];
    const sep = rand(2) === 0 ? '.' : '-';
    const title = rand(5) === 0 ? '' : `entry ${seed}-${i}`;
    rows.push(title === '' ? `## 2026${sep}${month}${sep}${day}` : `## 2026${sep}${month}${sep}${day} — ${title}`);
    oracle.entries.push(`2026.${month}.${day}|${title}`);
    rows.push('');

    const bodyKind = rand(4);
    if (bodyKind === 0) {
      // Sometimes metric-bearing, so COLD compression's **Result:** extraction is exercised.
      rows.push(rand(2) === 0 ? `**Goal:** body of ${i}.` : `**Goal:** body of ${i}; ${1 + rand(20)} tests green.`);
    } else if (bodyKind === 1) {
      const fence = rand(2) === 0 ? B : '~~~';
      const lead = rand(2) === 0;
      if (lead) {
        rows.push('Write entries like this:');
        rows.push('');
      }
      rows.push(`${fence}markdown`);
      rows.push(`## 2026.01.0${1 + rand(8)} — fenced sample`);
      if (rand(2) === 0) {
        rows.push('');
        rows.push('more fenced text');
      }
      rows.push(fence);
    } else {
      rows.push(`plain body ${i}.`);
      rows.push(`second line ${i}.`);
    }
    rows.push('');
    if (rand(3) === 0) {
      rows.push('---');
      rows.push('');
    }
    if (rand(4) === 0) {
      rows.push(MALFORMED[rand(MALFORMED.length)]);
      rows.push('');
      rows.push('ORPHAN BODY.');
      rows.push('');
      oracle.mustRefuse = true;
    }
  }

  if (rand(3) === 0) {
    rows.push('## Footer');
    rows.push('');
    rows.push('stray note.');
  }
  if (rand(6) === 0) {
    rows.push(`${B}markdown`);
    rows.push('## 2026.02.02 — hidden behind the open fence');
    oracle.mustRefuse = true;
  }

  return { text: frontmatter + rows.join(eol) + eol, ...oracle };
};

// ── calibration — green before and after, recorded with the baseline ──────────────────

describe('calibration — a clean corpus, both separators', () => {
  it('parses, conserves every line, and rotation re-parses to the same set', () => {
    const text = `${FM}\n# Changelog\n\n## 2026-07-28 — iso hot\n\nbody a.\n\n## 2026.07.10 — dotted warm\n\nbody b.\n\n## 2026.03.02 — dotted cold\n\nbody c.\n\n## Footer\n\nstray.\n`;
    const parsed = parseChangelogText(text);
    assert.deepEqual(parsed.entries.map(identity), [
      '2026.07.28|iso hot',
      '2026.07.10|dotted warm',
      '2026.03.02|dotted cold',
    ]);
    assert.deepEqual(conservationDelta(text, parsed), { missing: [], duplicated: [] });
    const { tiers } = rotateInMemory(parsed);
    const reparsed = tiers.flatMap(([, tierText]) => parseChangelogText(tierText).entries.map(identity));
    assert.deepEqual(reparsed.sort(), parsed.entries.map(identity).sort());
  });
});

// ── doorway fixtures — one per face observed live in Phase 1 ──────────────────────────

describe('doorway fixtures — each must refuse or conserve', () => {
  const between = (middle) =>
    `${FM}\n# Changelog\n\n## 2026.07.21 — good one\n\nbody one.\n\n${middle}\n\nORPHAN BODY.\n\n## 2026.01.05 — good two\n\nbody two.\n`;

  it('doorway one: a malformed date heading between entries is never glued or duplicated', () => {
    const text = between('## 2026-06-15 (no dash sep)');
    let parsed;
    try {
      parsed = parseChangelogText(text);
    } catch (err) {
      assertTypedRefusal(err, 'doorway one');
      return;
    }
    assert.deepEqual(conservationDelta(text, parsed), { missing: [], duplicated: [] });
  });

  it('doorway two: a heading inside a closed fence is never counted as an entry', () => {
    const text = `${FM}\n# Changelog\n\n## 2026.07.21 — teaches the format\n\nWrite entries like this:\n\n${B}markdown\n## 2026.01.03 — fenced sample\n${B}\n\nend of body.\n`;
    const parsed = parseChangelogText(text);
    assert.deepEqual(parsed.entries.map(identity), ['2026.07.21|teaches the format']);
  });

  it('doorway three: an unclosed fence refuses loudly instead of hiding the rest of the file', () => {
    const text = `${FM}\n# Changelog\n\n## 2026.07.21 — good one\n\n${B}markdown\n## 2026.07.20 — hidden\n`;
    let threw = null;
    try {
      parseChangelogText(text);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'an unclosed fence was silently absorbed');
    assertTypedRefusal(threw, 'doorway three');
  });

  it('doorway four: the writer never emits an unclosed fence — compressed output tokenizes', () => {
    const text = `${FM}\n# Changelog\n\n## 2026.03.02 — carries a fenced block\n\n${B}\nfenced text\n\nmore fenced text\n${B}\n`;
    const parsed = parseChangelogText(text);
    assert.equal(parsed.entries.length, 1);
    const cold = buildCold('2026', '03', parsed.entries, TODAY);
    tokenizeMarkdown(cold, 'history/2026-03.md');
  });

  it('doorway five: a CRLF file parses identically to its LF twin', () => {
    const lf = `${FM}\n# Changelog\n\n## 2026.07.21 — titled\n\nbody one.\n\n## 2026-07-20\n\nbody two.\n`;
    const a = parseChangelogText(lf);
    const b = parseChangelogText(lf.replace(/\n/g, '\r\n'));
    assert.deepEqual(b.entries.map(identity), a.entries.map(identity));
    assert.equal(b.frontmatter.replace(/\r\n/g, '\n'), a.frontmatter);
  });

  it('doorway six: slash, single-digit, truncated, unseparated and impossible dates refuse', () => {
    for (const heading of MALFORMED) {
      const text = between(heading);
      let threw = null;
      try {
        parseChangelogText(text);
      } catch (err) {
        threw = err;
      }
      assert.ok(threw, `"${heading}" fell through silently instead of refusing`);
      assertTypedRefusal(threw, `"${heading}"`);
    }
  });
});

// ── properties over generated documents ───────────────────────────────────────────────

describe('rotation properties over generated documents', () => {
  const SEEDS = 300;

  it('every body line lands in exactly one bucket, or the parse refuses loudly', () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const doc = buildDoc(seed);
      let parsed;
      try {
        parsed = parseChangelogText(doc.text);
      } catch (err) {
        assertTypedRefusal(err, `seed ${seed}`);
        continue;
      }
      assert.deepEqual(conservationDelta(doc.text, parsed), { missing: [], duplicated: [] }, `seed ${seed}`);
    }
  });

  it('a document whose unit-shaped headings all parse yields exactly the generated entry set', () => {
    let covered = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const doc = buildDoc(seed);
      if (doc.mustRefuse) continue;
      covered += 1;
      const parsed = parseChangelogText(doc.text);
      assert.deepEqual(parsed.entries.map(identity).sort(), [...doc.entries].sort(), `seed ${seed}`);
    }
    assert.ok(covered >= 50, `the generator must produce clean documents (got ${covered})`);
  });

  it('an unparseable unit-shaped heading or an unclosed fence refuses loudly, never absorbs', () => {
    let covered = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const doc = buildDoc(seed);
      if (!doc.mustRefuse) continue;
      covered += 1;
      let threw = null;
      try {
        parseChangelogText(doc.text);
      } catch (err) {
        threw = err;
      }
      assert.ok(threw, `seed ${seed}: an unparseable unit-shaped heading was silently absorbed`);
      assertTypedRefusal(threw, `seed ${seed}`);
    }
    assert.ok(covered >= 20, `the generator must produce refusable documents (got ${covered})`);
  });

  it('a full rotation re-parses to the same entry set — nothing lost, nothing duplicated', () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const doc = buildDoc(seed);
      if (doc.mustRefuse) continue;
      let parsed;
      try {
        parsed = parseChangelogText(doc.text);
      } catch (err) {
        assertTypedRefusal(err, `seed ${seed}`);
        continue;
      }
      const { tiers } = rotateInMemory(parsed);
      const reparsed = [];
      for (const [tier, tierText] of tiers) {
        let again;
        try {
          again = parseChangelogText(tierText);
        } catch (err) {
          assert.fail(`seed ${seed}: the rotator refused its own ${tier} output — ${err.message}`);
        }
        reparsed.push(...again.entries.map(identity));
      }
      assert.deepEqual(reparsed.sort(), parsed.entries.map(identity).sort(), `seed ${seed}`);
    }
  });

  it('the rotator accepts its own writer output — every tier it writes tokenizes cleanly', () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const doc = buildDoc(seed);
      if (doc.mustRefuse) continue;
      let parsed;
      try {
        parsed = parseChangelogText(doc.text);
      } catch (err) {
        assertTypedRefusal(err, `seed ${seed}`);
        continue;
      }
      const { tiers } = rotateInMemory(parsed);
      for (const [tier, tierText] of tiers) {
        try {
          tokenizeMarkdown(tierText, tier);
        } catch (err) {
          assert.fail(`seed ${seed}: the writer emitted a ${tier} tier the tokenizer refuses — ${err.message}`);
        }
      }
    }
  });

  it('the generator reaches all three tiers across the seed range', () => {
    const cutoffs = computeCutoffs(TODAY, 3, 30);
    let hotSeen = 0;
    let warmSeen = 0;
    let coldSeen = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const doc = buildDoc(seed);
      if (doc.mustRefuse) continue;
      const entries = doc.entries.map((identityStr) => {
        const [dateStr] = identityStr.split('|');
        const [year, month, day] = dateStr.split('.');
        return { dateObj: new Date(`${year}-${month}-${day}T00:00:00Z`) };
      });
      const { hot, warm, cold } = categorize(entries, cutoffs);
      hotSeen += hot.length;
      warmSeen += warm.length;
      coldSeen += cold.length;
    }
    assert.ok(hotSeen > 0 && warmSeen > 0 && coldSeen > 0, `tier reach: hot ${hotSeen} / warm ${warmSeen} / cold ${coldSeen}`);
  });

  it('rewriting an already-written WARM or COLD tier is a byte fixed point', () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const doc = buildDoc(seed);
      if (doc.mustRefuse) continue;
      let parsed;
      try {
        parsed = parseChangelogText(doc.text);
      } catch (err) {
        assertTypedRefusal(err, `seed ${seed}`);
        continue;
      }
      const { tiers } = rotateInMemory(parsed);
      for (const [tier, tierText] of tiers) {
        if (tier === 'HOT') continue;
        const again = parseChangelogText(tierText, tier).entries;
        const rebuilt = tier === 'WARM'
          ? buildRecent(again, TODAY)
          : buildCold(...tier.slice('COLD '.length).split('-'), again, TODAY);
        assert.equal(rebuilt, tierText, `seed ${seed}: ${tier} is not a fixed point`);
      }
    }
  });

  it('rotating an already-rotated HOT tier is a byte fixed point', () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const doc = buildDoc(seed);
      if (doc.mustRefuse) continue;
      let parsed;
      try {
        parsed = parseChangelogText(doc.text);
      } catch (err) {
        assertTypedRefusal(err, `seed ${seed}`);
        continue;
      }
      const { tiers, hot, warm, cold } = rotateInMemory(parsed);
      // Stated scope cut, not a silent cap: with ZERO hot entries and a footer, the rebuilt file
      // holds a "## Footer" with no entry before it, so the re-parse folds it into the preamble
      // and the second build re-orders — the known zero-unit+footer corner (council round 2,
      // both backends: document, don't fold — a footer boundary with zero entries would
      // reintroduce the pinned "## History slurped every entry" mis-detection).
      if (hot.length === 0) continue;
      const hotText = tiers[0][1];
      const second = parseChangelogText(hotText);
      const rebuilt = buildChangelog({
        frontmatter: second.frontmatter || FM,
        preamble: second.preamble || '# Changelog',
        hot: second.entries,
        footer: second.footer,
        hasArchive: warm.length > 0 || cold.length > 0,
      });
      assert.equal(rebuilt, hotText, `seed ${seed}`);
    }
  });
});
