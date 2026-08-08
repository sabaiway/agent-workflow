import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HEADER, COLUMNS, readCount, npmDownloads, repoSignals, trafficSignals,
  renderRow, upsertRow, renderBadge, familyWeekly, badgeSet, unavailable,
  collect, writeSnapshot, main, fetchJsonDefault, blankFabricated, FABRICATED_COLUMNS,
} from './snapshot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(HERE, '..', '..', '.github', 'workflows');
const WORKFLOW = readFileSync(join(WORKFLOWS_DIR, 'stats.yml'), 'utf8');
const README = readFileSync(join(HERE, '..', '..', 'README.md'), 'utf8');

const full = {
  memoryDay: 63, memoryWeek: 149, kitDay: 306, kitWeek: 633,
  stars: 0, forks: 0, watchers: 0,
  clonesTotal: 12, clonesUniques: 4, viewsTotal: 90, viewsUniques: 21,
};

// The exact shape of the series this collector inherited: real npm counts, genuinely-zero
// star/fork/watcher columns, and the four traffic columns carrying FABRICATED zeros — what the old
// collector wrote every time the endpoint was unreadable. The live file was migrated to the data
// branch and removed from main, so the reader's obligations toward it are pinned on this sample.
const LEGACY_SAMPLE = `${HEADER}
2026-06-22,52,52,249,260,0,0,0,0,0,0,0
2026-08-06,7,229,27,747,0,0,0,0,0,0,0
2026-08-07,27,106,9,364,0,0,0,0,0,0,0
2026-08-08,63,149,306,633,0,0,0,0,0,0,0
`;

describe('snapshot — UNAVAILABLE is never zero (the defect this file replaces)', () => {
  it('a non-integer, negative, missing or error payload reads as null, and a real 0 survives', () => {
    assert.equal(readCount(0), 0, 'a measured zero is a SIGNAL and must survive');
    assert.equal(readCount(7), 7);
    for (const bad of [undefined, null, -1, 1.5, '3', NaN, Infinity, {}, []]) {
      assert.equal(readCount(bad), null, `${JSON.stringify(bad)} is not a count`);
    }
  });

  it('a 404 body from npm and an error body from GitHub both read as null, never 0', () => {
    assert.equal(npmDownloads(null), null, 'a failed fetch is not zero downloads');
    assert.equal(npmDownloads({ error: 'not found' }), null);
    assert.equal(npmDownloads({ downloads: 0 }), 0, 'a genuine zero still reads as zero');
    assert.deepEqual(repoSignals(null), { stars: null, forks: null, watchers: null });
    assert.deepEqual(trafficSignals({ message: 'Must have push access to repository' }), { total: null, uniques: null });
    assert.deepEqual(trafficSignals({ count: 0, uniques: 0 }), { total: 0, uniques: 0 });
  });

  it('an unavailable signal renders as an EMPTY csv field — a gap a reader can SEE', () => {
    const row = renderRow('2026-08-08', { ...full, clonesTotal: null, clonesUniques: null, viewsTotal: null, viewsUniques: null });
    assert.equal(row, '2026-08-08,63,149,306,633,0,0,0,,,,');
    assert.equal(/,0,0,0,0$/.test(row), false, 'the shape that lied for 48 days must not be reproducible');
  });

  it('unavailable() names every missing signal, so the run can say what it could not read', () => {
    assert.deepEqual(unavailable(full), []);
    const partial = { ...full, viewsTotal: null, viewsUniques: null, kitDay: null };
    assert.deepEqual(unavailable(partial), [
      'npm downloads (kit, last-day)', 'traffic views (total)', 'traffic views (uniques)',
    ]);
  });
});

describe('snapshot — the history is append-only and idempotent by date', () => {
  it('a first run writes the header and one row', () => {
    const out = upsertRow('', '2026-08-08', renderRow('2026-08-08', full));
    assert.equal(out, `${HEADER}\n2026-08-08,63,149,306,633,0,0,0,12,4,90,21\n`);
  });

  it('a re-run on the same day REPLACES that row in place, never appends a second', () => {
    const first = upsertRow('', '2026-08-08', renderRow('2026-08-08', full));
    const second = upsertRow(first, '2026-08-08', renderRow('2026-08-08', { ...full, kitDay: 999 }));
    const rows = second.trim().split('\n');
    assert.equal(rows.length, 2, 'header + exactly one row for the day');
    assert.match(rows[1], /,999,/);
  });

  it('an earlier day keeps its POSITION when re-written — the series stays ordered', () => {
    let csv = upsertRow('', '2026-08-06', renderRow('2026-08-06', full));
    csv = upsertRow(csv, '2026-08-07', renderRow('2026-08-07', full));
    csv = upsertRow(csv, '2026-08-06', renderRow('2026-08-06', { ...full, stars: 5 }));
    const rows = csv.trim().split('\n');
    assert.equal(rows.length, 3);
    assert.match(rows[1], /^2026-08-06,/);
    assert.match(rows[1], /,5,/);
    assert.match(rows[2], /^2026-08-07,/);
  });

  it('the column order IS the schema and is pinned', () => {
    assert.equal(COLUMNS.length, 12);
    assert.equal(HEADER, 'date,memory_npm_last_day,memory_npm_last_week,kit_npm_last_day,kit_npm_last_week,stars,forks,watchers,clones_14d,clones_uniques_14d,views_14d,views_uniques_14d');
  });

  it('a pre-existing series parses under this reader without moving a byte', () => {
    // The shape the migrated series really has: this reader had to accept the file that had been
    // accumulating since 2026-06-22 before it could be moved to the data branch, and it did — the
    // migration ran against those live 48 rows and is recorded on the branch. The file itself no
    // longer lives on main, which is the entire point, so the property is pinned on its shape here.
    const rows = LEGACY_SAMPLE.trim().split('\n');
    assert.equal(rows[0], HEADER, 'a pre-existing history carries exactly this header');
    const round = upsertRow(LEGACY_SAMPLE, '2026-08-08', rows.at(-1));
    assert.equal(round.trim().split('\n').length, rows.length, 're-writing the last day adds no row');
  });
});

describe('snapshot — badges reach the landing page, and say n/a rather than lying', () => {
  it('a present value renders a coloured badge; an absent one renders n/a in grey', () => {
    assert.deepEqual(renderBadge({ label: 'views/14d', value: 21, suffix: ' uniq' }),
      { schemaVersion: 1, label: 'views/14d', message: '21 uniq', color: 'blue' });
    assert.deepEqual(renderBadge({ label: 'views/14d', value: null }),
      { schemaVersion: 1, label: 'views/14d', message: 'n/a', color: 'lightgrey' });
  });

  it('a zero is rendered as a zero — n/a is reserved for "not measured"', () => {
    assert.equal(renderBadge({ label: 'stars', value: 0 }).message, '0');
    assert.equal(renderBadge({ label: 'stars', value: 0 }).color, 'blue');
  });

  it('the family total is the number shields cannot serve, and a missing half makes it n/a', () => {
    assert.equal(familyWeekly(149, 633), 782);
    assert.equal(familyWeekly(null, 633), null, 'a missing half must not read as a smaller total');
    assert.equal(familyWeekly(149, null), null);
    assert.equal(badgeSet(full)['badge-downloads.json'].message, '782');
    assert.equal(badgeSet({ ...full, kitWeek: null })['badge-downloads.json'].message, 'n/a');
  });

  it('the three badge files are exactly the set the README points at', () => {
    const names = Object.keys(badgeSet(full));
    assert.deepEqual(names.sort(), ['badge-clones.json', 'badge-downloads.json', 'badge-views.json']);
    for (const name of names) {
      assert.ok(README.includes(name), `README must render ${name} — an unrendered badge is the defect being fixed`);
    }
  });

  it('every badge the README renders is fed from the DATA branch, never from main', () => {
    for (const m of README.matchAll(/raw\.githubusercontent\.com\/[^)\s]+/g)) {
      assert.match(m[0], /\/refs\/heads\/stats\//, `${m[0]} must read the stats branch`);
    }
  });
});

describe('snapshot — collect() maps every endpoint through the same honesty rule', () => {
  const payloads = {
    'https://api.npmjs.org/downloads/point/last-day/%40sabaiway%2Fagent-workflow-memory': { downloads: 63 },
    'https://api.npmjs.org/downloads/point/last-week/%40sabaiway%2Fagent-workflow-memory': { downloads: 149 },
    'https://api.npmjs.org/downloads/point/last-day/%40sabaiway%2Fagent-workflow-kit': { downloads: 306 },
    'https://api.npmjs.org/downloads/point/last-week/%40sabaiway%2Fagent-workflow-kit': { downloads: 633 },
    'https://api.github.com/repos/o/r': { stargazers_count: 0, forks_count: 0, subscribers_count: 0 },
    'https://api.github.com/repos/o/r/traffic/clones': { count: 12, uniques: 4 },
    'https://api.github.com/repos/o/r/traffic/views': { count: 90, uniques: 21 },
  };

  it('a fully answering set produces every signal', async () => {
    const signals = await collect({ repo: 'o/r', token: 't', fetchJson: async (url) => payloads[url] ?? null });
    assert.deepEqual(signals, full);
    assert.deepEqual(unavailable(signals), []);
  });

  it('an UNAUTHORIZED traffic endpoint leaves the traffic signals null and everything else intact', async () => {
    const signals = await collect({
      repo: 'o/r', token: null,
      fetchJson: async (url) => (url.includes('/traffic/') ? null : payloads[url] ?? null),
    });
    assert.equal(signals.kitWeek, 633, 'the readable signals still land');
    assert.deepEqual(
      [signals.clonesTotal, signals.clonesUniques, signals.viewsTotal, signals.viewsUniques],
      [null, null, null, null],
      'the token-gated half is UNAVAILABLE, which is the live state of this repo today',
    );
    assert.equal(unavailable(signals).length, 4);
  });

  it('the token rides an Authorization header only when present', async () => {
    const seen = [];
    const spy = async (url, headers) => { seen.push([url, headers]); return null; };
    await collect({ repo: 'o/r', token: 'secret', fetchJson: spy });
    const gh = seen.find(([u]) => u.endsWith('/repos/o/r'));
    assert.equal(gh[1].authorization, 'Bearer secret');
    seen.length = 0;
    await collect({ repo: 'o/r', token: null, fetchJson: spy });
    assert.equal('authorization' in seen.find(([u]) => u.endsWith('/repos/o/r'))[1], false);
  });
});

describe('snapshot — writeSnapshot lands the csv and the badges together', () => {
  it('writes the history plus all three badge files under the data dir', () => {
    const written = new Map();
    const io = {
      mkdirSync: () => {},
      readFileSync: () => { throw new Error('ENOENT'); },
      writeFileSync: (p, c) => written.set(p, c),
    };
    writeSnapshot({ dir: '/data', date: '2026-08-08', signals: full, io });
    assert.deepEqual([...written.keys()].sort(), [
      '/data/badge-clones.json', '/data/badge-downloads.json', '/data/badge-views.json', '/data/history.csv',
    ]);
    assert.match(written.get('/data/history.csv'), /^date,/);
    assert.equal(JSON.parse(written.get('/data/badge-views.json')).message, '21 uniq');
  });
});

describe('snapshot — the one-time migration blanks the FABRICATED columns and nothing else', () => {
  // Executed once, against the live 48-row file, before main dropped it; the result is the data
  // branch's first commit. The mechanism stays pinned here so a re-run — or a second series that
  // ever needs the same treatment — cannot quietly change what it touches.
  const live = LEGACY_SAMPLE;

  it('blanks exactly the four traffic columns and leaves every other cell alone', () => {
    const before = live.trim().split('\n');
    const after = blankFabricated(live).trim().split('\n');
    assert.equal(after.length, before.length, 'no row is added or dropped');
    assert.equal(after[0], before[0], 'the header is untouched');
    const head = before[0].split(',');
    const blanked = FABRICATED_COLUMNS.map((c) => head.indexOf(c));
    assert.deepEqual(blanked, [8, 9, 10, 11], 'the fabricated columns are the four traffic ones');
    for (let i = 1; i < before.length; i += 1) {
      const b = before[i].split(',');
      const a = after[i].split(',');
      assert.equal(a[0], b[0], `row ${i} keeps its date — the series order is preserved`);
      for (let j = 0; j < head.length; j += 1) {
        if (blanked.includes(j)) assert.equal(a[j], '', `row ${i} column ${head[j]} must be empty`);
        else assert.equal(a[j], b[j], `row ${i} column ${head[j]} must be byte-identical`);
      }
    }
  });

  it('is idempotent — re-running the migration changes nothing', () => {
    const once = blankFabricated(live);
    assert.equal(blankFabricated(once), once);
  });

  it('refuses loudly when a named column is not in the header — never a silent no-op', () => {
    assert.throws(() => blankFabricated('date,stars\n2026-08-08,1\n'), /column\(s\) not in header/);
  });

  it('leaves a malformed row exactly as found rather than shifting its cells', () => {
    const csv = `${HEADER}\n2026-08-08,1,2\n`;
    assert.equal(blankFabricated(csv), csv);
  });

  it('an empty input is returned unchanged', () => {
    assert.equal(blankFabricated(''), '');
  });
});

describe('snapshot — the transport turns EVERY failure into "not measured", never into 0', () => {
  const withFetch = async (impl, run) => {
    const real = globalThis.fetch;
    globalThis.fetch = impl;
    try { return await run(); } finally { globalThis.fetch = real; }
  };

  it('a 2xx body is returned as parsed JSON, with the headers passed through', async () => {
    const seen = [];
    const got = await withFetch(async (url, init) => {
      seen.push([url, init]);
      return { ok: true, json: async () => ({ downloads: 7 }) };
    }, () => fetchJsonDefault('https://example.test/x', { authorization: 'Bearer t' }));
    assert.deepEqual(got, { downloads: 7 });
    assert.deepEqual(seen[0][1], { headers: { authorization: 'Bearer t' } });
  });

  it('a non-2xx response is null — a 403 from /traffic is not zero traffic', async () => {
    const got = await withFetch(async () => ({ ok: false, status: 403, json: async () => ({ message: 'Must have push access' }) }),
      () => fetchJsonDefault('https://example.test/traffic'));
    assert.equal(got, null);
  });

  it('a thrown request and an unparseable body are both null', async () => {
    assert.equal(await withFetch(async () => { throw new Error('ENOTFOUND'); }, () => fetchJsonDefault('https://example.test/x')), null);
    assert.equal(await withFetch(async () => ({ ok: true, json: async () => { throw new Error('not json'); } }), () => fetchJsonDefault('https://example.test/x')), null);
  });
});

describe('snapshot — main() is the whole entry point, exercised offline', () => {
  const harness = (env, fetchJson) => {
    const written = new Map();
    const stdout = [];
    const stderr = [];
    return {
      written, stdout, stderr,
      run: () => main({
        env,
        fetchJson,
        io: {
          mkdirSync: () => {},
          readFileSync: () => { throw new Error('ENOENT'); },
          writeFileSync: (p, c) => written.set(p, c),
        },
        out: (s) => stdout.push(s),
        err: (s) => stderr.push(s),
      }),
    };
  };

  it('refuses with exit 2 and writes NOTHING when the required env is absent', async () => {
    for (const env of [{}, { STATS_REPO: 'o/r' }, { STATS_DIR: '/d' }]) {
      const h = harness(env, async () => null);
      assert.equal(await h.run(), 2);
      assert.equal(h.written.size, 0, 'a usage refusal never writes a snapshot');
      assert.match(h.stderr.join(''), /STATS_REPO and STATS_DIR are required/);
    }
  });

  it('a fully answering run writes the csv + badges, exits 0 and warns about nothing', async () => {
    const payload = { downloads: 5, stargazers_count: 1, forks_count: 2, subscribers_count: 3, count: 9, uniques: 4 };
    const h = harness({ STATS_REPO: 'o/r', STATS_DIR: '/d', STATS_DATE: '2026-08-08', GH_TOKEN: 't' }, async () => payload);
    assert.equal(await h.run(), 0);
    assert.deepEqual([...h.written.keys()].sort(), [
      '/d/badge-clones.json', '/d/badge-downloads.json', '/d/badge-views.json', '/d/history.csv',
    ]);
    assert.match(h.written.get('/d/history.csv'), /^date,[\s\S]*\n2026-08-08,5,5,5,5,1,2,3,9,4,9,4\n$/);
    assert.equal(h.stdout.join(''), '', 'nothing unavailable, so no warning annotation');
    assert.match(h.stderr.join(''), /wrote \/d\/history\.csv \(12 columns\) \+ 3 badge file\(s\)/);
  });

  it('an unavailable half still SUCCEEDS, but says so on both channels and records empty fields', async () => {
    const h = harness(
      { STATS_REPO: 'o/r', STATS_DIR: '/d', STATS_DATE: '2026-08-08' },
      async (url) => (url.includes('/traffic/') ? null : { downloads: 5, stargazers_count: 1, forks_count: 2, subscribers_count: 3 }),
    );
    assert.equal(await h.run(), 0, 'a recorded gap is not a reason to fail the collection');
    assert.match(h.written.get('/d/history.csv'), /\n2026-08-08,5,5,5,5,1,2,3,,,,\n$/);
    const annotation = h.stdout.join('');
    assert.match(annotation, /^::warning title=Stats signals unavailable::/);
    assert.match(annotation, /recorded as EMPTY \(not 0\)/);
    assert.match(annotation, /STATS_TOKEN/, 'the annotation names the one action that fixes it');
    assert.match(h.stderr.join(''), /4 signal\(s\) UNAVAILABLE/);
    assert.equal(JSON.parse(h.written.get('/d/badge-views.json')).message, 'n/a');
  });

  it('the date defaults to today when STATS_DATE is unset', async () => {
    const h = harness({ STATS_REPO: 'o/r', STATS_DIR: '/d' }, async () => ({ downloads: 1, count: 1, uniques: 1, stargazers_count: 1, forks_count: 1, subscribers_count: 1 }));
    assert.equal(await h.run(), 0);
    const today = new Date().toISOString().slice(0, 10);
    assert.match(h.written.get('/d/history.csv'), new RegExp(`\\n${today},`));
  });
});

describe('stats workflow — the snapshot never writes to the default branch again', () => {
  it('the workflow runs the tested script instead of inline collection bash', () => {
    assert.match(WORKFLOW, /scripts\/stats\/snapshot\.mjs/, 'collection logic lives in the tested script');
    assert.doesNotMatch(WORKFLOW, /api\.npmjs\.org/, 'no second, untested copy of the collection');
  });

  it('the commit lands on the stats data branch, and main is never a push target', () => {
    assert.match(WORKFLOW, /STATS_BRANCH:\s*stats/, 'the data branch is declared once');
    assert.match(WORKFLOW, /git push origin "\$STATS_BRANCH"/, 'the push names the data branch explicitly');
    assert.doesNotMatch(WORKFLOW, /^\s*git push\s*$/m, 'a bare `git push` would follow the checked-out branch');
  });

  it('the data branch is bootstrapped from an EMPTY tree — the history never carries repo source', () => {
    assert.match(WORKFLOW, /hash-object -w -t tree \/dev\/null/, 'orphan bootstrap, not a branch off main');
  });

  it('the workflow never migrates history from main — a seeding step that can no-op will', () => {
    assert.equal(/cp\s+stats\/history\.csv/.test(WORKFLOW), false, 'no CI-side seed path exists to skip silently');
    assert.match(WORKFLOW, /::warning title=Stats data branch missing::/, 'a missing branch starts a FRESH series LOUDLY');
    assert.match(WORKFLOW, /NOT recovered by this run/, 'and says exactly what it did not do');
  });

  it('the run still declares the least privilege it needs', () => {
    assert.match(WORKFLOW, /permissions:\s*\n\s*contents: write/);
  });

  it('the runner setup matches the version every other workflow in this repo already uses', () => {
    // Shipped as @v4 by mistake; the action itself then runs on a deprecated Node runtime and the
    // run carries a warning. The four sibling workflows were already on @v5 — this pins the repo's
    // own answer rather than a version guessed at authoring time.
    // BOTH extensions: Actions accepts .yaml too, and a workflow added under that name is exactly
    // the one that would drift unnoticed — a guard blind to its own subject is not a guard.
    const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    const versions = new Set(
      files.flatMap((f) => [...readFileSync(join(WORKFLOWS_DIR, f), 'utf8').matchAll(/actions\/setup-node@(v\d+)/g)].map((m) => m[1])),
    );
    assert.ok(versions.size > 0, 'no workflow uses setup-node any more — delete this guard rather than leaving it green on nothing');
    assert.equal(versions.size, 1, `every workflow must agree on one setup-node version, got ${[...versions].join(', ')}`);
  });
});
