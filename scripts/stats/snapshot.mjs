#!/usr/bin/env node
// snapshot.mjs — the Level-0 usage snapshot: collect the public signals, append ONE dated row to the
// history, and render the shields.io endpoint badges the README points at.
//
// Two properties this file exists to guarantee, both learned from the shape it replaces:
//
//   1. UNAVAILABLE IS NOT ZERO. The traffic endpoints need a token with repo access; the previous
//      inline-bash collector tolerated a missing one and wrote `0`, so the history carried 48
//      consecutive days of "no clones, no views" for a repository CI clones every day. A signal that
//      could not be read is now `null` — an EMPTY CSV field and an "n/a" badge — and the run says so
//      loudly on stderr and as a GitHub Actions warning annotation. A reader can tell a real zero
//      from a missing measurement; before, nobody could.
//   2. THE HISTORY NEVER TOUCHES THE DEFAULT BRANCH. The snapshot is data, not source: it is written
//      to a dedicated data branch, so a daily bot commit can no longer race a human's push to main
//      (which cost a rejected push, a manual rebase and a voided release approval).
//
// Dependency-free, Node >= 22. Every function below is pure except main(); the network and the
// filesystem enter through injected seams so the whole contract is unit-testable offline.

import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The history's column order IS its schema — appending a column is safe, reordering is not.
export const COLUMNS = [
  'date',
  'memory_npm_last_day', 'memory_npm_last_week',
  'kit_npm_last_day', 'kit_npm_last_week',
  'stars', 'forks', 'watchers',
  'clones_14d', 'clones_uniques_14d',
  'views_14d', 'views_uniques_14d',
];
export const HEADER = COLUMNS.join(',');

export const PACKAGES = {
  memory: '@sabaiway/agent-workflow-memory',
  kit: '@sabaiway/agent-workflow-kit',
};

// A count is a signal only when it is a non-negative integer. Anything else — a 404 body, an error
// object, a string, a float, a missing key — is UNAVAILABLE, never 0.
export const readCount = (value) =>
  (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null);

export const npmDownloads = (payload) => readCount(payload?.downloads);

export const repoSignals = (payload) => ({
  stars: readCount(payload?.stargazers_count),
  forks: readCount(payload?.forks_count),
  watchers: readCount(payload?.subscribers_count),
});

export const trafficSignals = (payload) => ({
  total: readCount(payload?.count),
  uniques: readCount(payload?.uniques),
});

// An unavailable signal renders as an EMPTY field: a reader (and a chart) sees a gap, not a zero.
const cell = (v) => (v === null || v === undefined ? '' : String(v));

export const renderRow = (date, s) => [
  date,
  cell(s.memoryDay), cell(s.memoryWeek), cell(s.kitDay), cell(s.kitWeek),
  cell(s.stars), cell(s.forks), cell(s.watchers),
  cell(s.clonesTotal), cell(s.clonesUniques),
  cell(s.viewsTotal), cell(s.viewsUniques),
].join(',');

// Idempotent by date: re-running on the same day REPLACES that day's row in place rather than
// appending a second one, and the row keeps its position so the series stays ordered.
export const upsertRow = (csvText, date, row) => {
  const lines = String(csvText ?? '').split('\n').filter((l) => l.trim() !== '');
  const body = lines.length > 0 && lines[0] === HEADER ? lines.slice(1) : lines;
  const at = body.findIndex((l) => l.startsWith(`${date},`));
  if (at >= 0) body[at] = row;
  else body.push(row);
  return `${[HEADER, ...body].join('\n')}\n`;
};

// shields.io endpoint schema: the README renders these live from the data branch, so the numbers
// reach the repository's landing page without a single write to the default branch.
export const renderBadge = ({ label, value, suffix = '' }) => ({
  schemaVersion: 1,
  label,
  message: value === null || value === undefined ? 'n/a' : `${value}${suffix}`,
  color: value === null || value === undefined ? 'lightgrey' : 'blue',
});

// The columns the previous collector FABRICATED: it wrote `0` whenever the traffic endpoint was
// unreadable, so all 48 historical rows claim zero clones and zero views for a repository CI clones
// daily. They were never observations, so the one-time migration onto the data branch blanks exactly
// these four and leaves every other cell byte-identical — a chart must show a gap there, not a flat
// line at zero.
export const FABRICATED_COLUMNS = ['clones_14d', 'clones_uniques_14d', 'views_14d', 'views_uniques_14d'];

export const blankFabricated = (csvText, columns = FABRICATED_COLUMNS) => {
  const lines = String(csvText ?? '').split('\n');
  const at = lines.findIndex((l) => l.trim() !== '');
  if (at < 0) return csvText;
  const head = lines[at].split(',');
  const idx = columns.map((c) => head.indexOf(c));
  if (idx.some((i) => i < 0)) {
    throw new Error(`blankFabricated: column(s) not in header: ${columns.filter((c, i) => idx[i] < 0).join(', ')}`);
  }
  return lines.map((line, i) => {
    if (i <= at || line.trim() === '') return line;
    const cells = line.split(',');
    if (cells.length !== head.length) return line; // a malformed row is left exactly as found
    for (const j of idx) cells[j] = '';
    return cells.join(',');
  }).join('\n');
};

// The family total is the one number shields cannot serve on its own (its npm badges are
// per-package), so it is the badge worth generating; a missing part makes the TOTAL unavailable
// rather than silently smaller.
export const familyWeekly = (memoryWeek, kitWeek) =>
  (memoryWeek === null || kitWeek === null ? null : memoryWeek + kitWeek);

export const badgeSet = (s) => ({
  'badge-downloads.json': renderBadge({ label: 'downloads/week', value: familyWeekly(s.memoryWeek, s.kitWeek) }),
  'badge-views.json': renderBadge({ label: 'views/14d', value: s.viewsUniques, suffix: ' uniq' }),
  'badge-clones.json': renderBadge({ label: 'clones/14d', value: s.clonesUniques, suffix: ' uniq' }),
});

// Every signal that came back unavailable, named — the run's own honesty report.
export const unavailable = (s) => Object.entries({
  'npm downloads (memory, last-day)': s.memoryDay,
  'npm downloads (memory, last-week)': s.memoryWeek,
  'npm downloads (kit, last-day)': s.kitDay,
  'npm downloads (kit, last-week)': s.kitWeek,
  stars: s.stars, forks: s.forks, watchers: s.watchers,
  'traffic clones (total)': s.clonesTotal, 'traffic clones (uniques)': s.clonesUniques,
  'traffic views (total)': s.viewsTotal, 'traffic views (uniques)': s.viewsUniques,
}).filter(([, v]) => v === null).map(([name]) => name);

// ── I/O ──────────────────────────────────────────────────────────────────────────────────────────

// The real transport, and the ONE place a network failure becomes `null`: a non-2xx, an unparseable
// body and a thrown request are the same answer — "not measured" — which is what keeps the
// unavailable-is-not-zero rule true all the way down to the socket.
export const fetchJsonDefault = async (url, headers = {}) => {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
};

export const collect = async ({ repo, token, fetchJson = fetchJsonDefault }) => {
  const gh = (path) => fetchJson(`https://api.github.com/repos/${repo}${path}`, {
    accept: 'application/vnd.github+json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });
  const npm = (pkg, window) => fetchJson(`https://api.npmjs.org/downloads/point/${window}/${encodeURIComponent(pkg)}`);

  const [memDay, memWeek, kitDay, kitWeek, repoPayload, clones, views] = await Promise.all([
    npm(PACKAGES.memory, 'last-day'), npm(PACKAGES.memory, 'last-week'),
    npm(PACKAGES.kit, 'last-day'), npm(PACKAGES.kit, 'last-week'),
    gh(''), gh('/traffic/clones'), gh('/traffic/views'),
  ]);
  const r = repoSignals(repoPayload);
  const c = trafficSignals(clones);
  const v = trafficSignals(views);
  return {
    memoryDay: npmDownloads(memDay), memoryWeek: npmDownloads(memWeek),
    kitDay: npmDownloads(kitDay), kitWeek: npmDownloads(kitWeek),
    stars: r.stars, forks: r.forks, watchers: r.watchers,
    clonesTotal: c.total, clonesUniques: c.uniques,
    viewsTotal: v.total, viewsUniques: v.uniques,
  };
};

export const writeSnapshot = ({ dir, date, signals, io = { readFileSync, writeFileSync, mkdirSync } }) => {
  io.mkdirSync(dir, { recursive: true });
  const csvPath = join(dir, 'history.csv');
  let existing = '';
  try {
    existing = io.readFileSync(csvPath, 'utf8');
  } catch { /* first run — the header is written below */ }
  io.writeFileSync(csvPath, upsertRow(existing, date, renderRow(date, signals)));
  for (const [name, badge] of Object.entries(badgeSet(signals))) {
    io.writeFileSync(join(dir, name), `${JSON.stringify(badge, null, 2)}\n`);
  }
  return csvPath;
};

// Every seam is injected so the whole entry point is exercised offline; the defaults are the real
// process, network and filesystem. → exit code (0 written, 2 usage).
export const main = async ({
  env = process.env,
  fetchJson = fetchJsonDefault,
  io = { readFileSync, writeFileSync, mkdirSync },
  out = (s) => process.stdout.write(s),
  err = (s) => process.stderr.write(s),
} = {}) => {
  const repo = env.STATS_REPO;
  const dir = env.STATS_DIR;
  if (!repo || !dir) {
    err('snapshot: STATS_REPO and STATS_DIR are required\n');
    return 2;
  }
  const date = env.STATS_DATE || new Date().toISOString().slice(0, 10);
  const signals = await collect({ repo, token: env.GH_TOKEN, fetchJson });
  const missing = unavailable(signals);
  if (missing.length > 0) {
    // Loud on BOTH channels: the annotation surfaces in the Actions UI, the stderr line in the log.
    // The run still SUCCEEDS — a missing signal is a recorded gap, not a reason to stop collecting
    // the ones that ARE available — but nobody can mistake it for a measured zero any more.
    const list = missing.join(', ');
    out(`::warning title=Stats signals unavailable::${list} — recorded as EMPTY (not 0). Traffic needs a token with repo access: set the STATS_TOKEN secret.\n`);
    err(`snapshot: ${missing.length} signal(s) UNAVAILABLE and recorded as empty: ${list}\n`);
  }
  const csvPath = writeSnapshot({ dir, date, signals, io });
  err(`snapshot ${date}: wrote ${csvPath} (${COLUMNS.length} columns) + 3 badge file(s)\n`);
  return 0;
};

// Run main() only when executed directly, never on import. Compare by REAL path: an entry point
// reached through a symlink resolves to its target, so a raw string compare reads the two as
// different and the CLI never runs. realpathSync collapses the link so both sides match.
const isDirectRun = (() => {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isDirectRun) process.exitCode = await main();
