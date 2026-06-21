#!/usr/bin/env node
// Rolling-window archive for docs/ai/changelog.md.
//
// HOT  (changelog.md)               — last HOT_DAYS days
// WARM (history/recent.md)          — entries HOT_DAYS..WARM_DAYS old
// COLD (history/YYYY-MM.md)         — entries older than WARM_DAYS, compressed
// META (history/condensed-index.md) — one-line TL;DRs of every archived entry
//
// NOTE (multi-year scaling): condensed-index.md grows O(total archived entries),
// so on a multi-year horizon it approaches its cap (~1159 lines over 2y in a stress
// test). When it nears the cap, shard it per-year (condensed-index-YYYY.md) or switch
// to an append-only cap. Stress-test rotation via the exported pure functions against
// a /tmp copy seeded with a synthetic multi-year dataset (include burst periods).
//
// Modes:
//   (default)   run rotation, mutate files in place
//   --dry-run   print planned distribution, do not change files
//   --check     exit 1 if changelog.md still holds entries that should be archived
//
// CLI overrides:
//   --hot-days=N  (default 7)
//   --warm-days=N (default 30)
//   --today=YYYY-MM-DD (default today UTC) — useful for tests / reproducible runs

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const readProjectName = () => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    if (pkg.name) return pkg.name;
  } catch {
    /* no package.json — fall back to repo dir basename */
  }
  return basename(ROOT);
};
const PROJECT_NAME = readProjectName();

const CHANGELOG_PATH = resolve(ROOT, 'docs/ai/changelog.md');
const HISTORY_DIR = resolve(ROOT, 'docs/ai/history');
const RECENT_PATH = resolve(HISTORY_DIR, 'recent.md');
const INDEX_PATH = resolve(HISTORY_DIR, 'condensed-index.md');

const DEFAULT_HOT_DAYS = 3;
const DEFAULT_WARM_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ENTRY_HEADING_RE = /^## (\d{4})\.(\d{2})\.(\d{2})(?: [—–] (.*))?$/;
const NON_ENTRY_H2_RE = /^## (?!\d{4}\.\d{2}\.\d{2})/;

const parseArgs = (argv) => {
  const flags = { dryRun: false, check: false };
  const opts = { hotDays: DEFAULT_HOT_DAYS, warmDays: DEFAULT_WARM_DAYS, today: null };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--check') flags.check = true;
    else if (arg.startsWith('--hot-days=')) opts.hotDays = Number(arg.slice('--hot-days='.length));
    else if (arg.startsWith('--warm-days=')) opts.warmDays = Number(arg.slice('--warm-days='.length));
    else if (arg.startsWith('--today=')) opts.today = arg.slice('--today='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: archive-changelog.mjs [--dry-run|--check] [--hot-days=N] [--warm-days=N] [--today=YYYY-MM-DD]',
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return { flags, opts };
};

export const parseChangelogText = (text) => {
  const fmMatch = text.match(/^(---\n[\s\S]*?\n---\n)/);
  const frontmatter = fmMatch ? fmMatch[1] : '';
  const rest = text.slice(frontmatter.length);
  const lines = rest.split('\n');

  const entryStartIdxs = [];
  let firstNonEntryH2Idx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (ENTRY_HEADING_RE.test(lines[i])) {
      entryStartIdxs.push(i);
    } else if (
      firstNonEntryH2Idx === -1 &&
      entryStartIdxs.length > 0 &&
      NON_ENTRY_H2_RE.test(lines[i])
    ) {
      // Only treat a non-entry H2 as the footer boundary if it appears AFTER at least one date
      // entry. Otherwise a previously-inserted "## History" pointer in the preamble would be
      // mis-detected and cause every entry to be slurped into `footer`.
      firstNonEntryH2Idx = i;
    }
  }

  const preambleEnd = entryStartIdxs.length > 0 ? entryStartIdxs[0] : lines.length;
  const preamble = lines.slice(0, preambleEnd).join('\n');

  const entries = entryStartIdxs.map((idx, i) => {
    const isFollowedByEntry = i + 1 < entryStartIdxs.length;
    const tentativeEnd = isFollowedByEntry
      ? entryStartIdxs[i + 1]
      : firstNonEntryH2Idx !== -1 && firstNonEntryH2Idx > idx
        ? firstNonEntryH2Idx
        : lines.length;
    const block = lines.slice(idx, tentativeEnd).join('\n').replace(/\n+$/, '');
    const cleanedBlock = stripTrailingSeparator(block);
    const m = ENTRY_HEADING_RE.exec(lines[idx]);
    return {
      dateStr: `${m[1]}.${m[2]}.${m[3]}`,
      dateObj: new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`),
      year: m[1],
      month: m[2],
      day: m[3],
      title: m[4] ?? '',
      block: cleanedBlock,
    };
  });

  const footer = firstNonEntryH2Idx !== -1 ? lines.slice(firstNonEntryH2Idx).join('\n').trim() : '';

  return { frontmatter, preamble: preamble.trim(), entries, footer };
};

const TRAILING_FOOTER_PATTERNS = [
  /^\*\*Last Updated:/i,
];

export const stripTrailingSeparator = (block) => {
  const lines = block.replace(/\n+$/, '').split('\n');
  const isStripLine = (line) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed === '---') return true;
    return TRAILING_FOOTER_PATTERNS.some((re) => re.test(trimmed));
  };
  while (lines.length > 0 && isStripLine(lines[lines.length - 1])) lines.pop();
  return lines.join('\n');
};

export const stripBlockquoteHistoryNotice = (preamble) => {
  const filtered = preamble
    .split('\n')
    .filter((line) => !/changelog-archive\.md/i.test(line));

  // Strip any previously-inserted "## History" section so re-running the rotator is idempotent.
  // A History section starts at `## History` and ends at the next `---` separator or end-of-file.
  const out = [];
  let inHistorySection = false;
  for (const line of filtered) {
    if (!inHistorySection && /^## History\s*$/.test(line)) {
      inHistorySection = true;
      continue;
    }
    if (inHistorySection) {
      if (line.trim() === '---') {
        inHistorySection = false;
        // Drop the closing separator too — buildChangelog re-emits separators around the new block.
        continue;
      }
      continue;
    }
    out.push(line);
  }
  return out.join('\n').trim();
};

export const computeCutoffs = (todayStr, hotDays, warmDays) => {
  const today = todayStr
    ? new Date(`${todayStr}T00:00:00Z`)
    : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  // Inclusive window: HOT keeps `hotDays` calendar days ending today.
  return {
    today,
    hotCutoff: new Date(today.getTime() - (hotDays - 1) * MS_PER_DAY),
    warmCutoff: new Date(today.getTime() - (warmDays - 1) * MS_PER_DAY),
  };
};

export const categorize = (entries, cutoffs) => {
  const hot = [];
  const warm = [];
  const cold = [];
  for (const entry of entries) {
    if (entry.dateObj >= cutoffs.hotCutoff) hot.push(entry);
    else if (entry.dateObj >= cutoffs.warmCutoff) warm.push(entry);
    else cold.push(entry);
  }
  return { hot, warm, cold };
};

export const compressEntry = (entry) => {
  const lines = entry.block.split('\n');
  const heading = lines[0];
  const body = lines.slice(1).join('\n');

  const extractFirstParagraph = (text) => {
    const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    for (const para of paragraphs) {
      if (para.startsWith('#')) continue;
      if (/^(\*\*Goal|\*\*Problem|\*\*Context|\*\*Why|\*\*Session)/i.test(para)) return para;
    }
    return paragraphs.find((p) => !p.startsWith('#')) ?? '';
  };

  const extractFileBullets = (text) => {
    const filesSectionMatch = text.match(/\*\*(?:Changes|Files|Files touched|Files changed|Touched)[^\n]*\*\*([\s\S]*?)(?:\n\s*\n|\n##|$)/i);
    if (!filesSectionMatch) return '';
    const bullets = filesSectionMatch[1]
      .split('\n')
      .filter((line) => /^- /.test(line.trim()))
      .slice(0, 8);
    if (bullets.length === 0) return '';
    return ['**Files:**', ...bullets].join('\n');
  };

  const extractMetric = (text) => {
    const metricsMatch = text.match(/(\d+\s*(?:passed|failed|tests?|warnings?|errors?))/gi);
    if (!metricsMatch || metricsMatch.length === 0) return '';
    return `**Result:** ${metricsMatch.slice(0, 3).join(', ')}`;
  };

  const summary = extractFirstParagraph(body);
  const files = extractFileBullets(body);
  const metric = extractMetric(body);

  return [heading, '', summary, files, metric].filter(Boolean).join('\n\n').trim();
};

const summarizeEntry = (entry, sourceLink) => {
  const titleSnippet = entry.title.slice(0, 110).replace(/\n/g, ' ');
  return `- **${entry.dateStr}** — ${titleSnippet} — [${sourceLink}](./${sourceLink})`;
};

const renderEntries = (entries) =>
  entries
    .map((entry) => entry.block.trim())
    .join('\n\n---\n\n');

const FRONTMATTER = (type, maxLines, lastUpdated) =>
  `---\ntype: ${type}\nlastUpdated: ${lastUpdated}\nscope: permanent\nstaleAfter: never\nowner: none\nmaxLines: ${maxLines}\n---\n`;

export const buildChangelog = ({ frontmatter, preamble, hot, footer, hasArchive }) => {
  const cleanedPreamble = stripBlockquoteHistoryNotice(preamble);
  const historyBlock = hasArchive
    ? '## History\n\n> Older sessions are layered:\n>\n> - **7–30 days** → [`history/recent.md`](./history/recent.md) (full text)\n> - **>30 days** → [`history/condensed-index.md`](./history/condensed-index.md) (one-line TL;DRs that link into per-month `history/YYYY-MM.md` archives)'
    : '';
  const hotBlock = renderEntries(hot);
  const parts = [
    frontmatter,
    '',
    cleanedPreamble,
    '',
    historyBlock,
    '',
    '---',
    '',
    hotBlock,
    '',
    '---',
    '',
    footer || '',
    '',
  ];
  return parts.filter((p) => p !== null && p !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
};

export const buildRecent = (entries, todayStr) => {
  const frontmatter = FRONTMATTER('history', 3500, todayStr);
  const preamble = `# Changelog WARM Archive — ${PROJECT_NAME}\n\n> Entries aged **7–30 days** from today. Newer → [\`../changelog.md\`](../changelog.md). Older → [\`condensed-index.md\`](./condensed-index.md) plus per-month \`YYYY-MM.md\` files.`;
  const body = renderEntries(entries);
  return `${frontmatter}\n${preamble}\n\n---\n\n${body}\n`;
};

export const buildCold = (year, month, entries, todayStr) => {
  const frontmatter = FRONTMATTER('history', 1500, todayStr);
  const preamble = `# Changelog COLD Archive — ${year}-${month}\n\n> Compressed entries from ${year}-${month} (older than 30 days). Cross-month one-liners → [\`condensed-index.md\`](./condensed-index.md). Full commit history: \`git log --since=${year}-${month}-01 --until=${year}-${month}-31\`.`;
  const compressed = entries.map(compressEntry).join('\n\n---\n\n');
  return `${frontmatter}\n${preamble}\n\n---\n\n${compressed}\n`;
};

export const buildCondensedIndex = (warmEntries, coldByMonth, todayStr) => {
  const frontmatter = FRONTMATTER('history', 300, todayStr);
  const intro = `# Condensed Index — ${PROJECT_NAME} Changelog\n\n> One-line TL;DR for every archived entry. Each line links to the file holding the full text.`;

  const lines = [];
  if (warmEntries.length > 0) {
    lines.push('## WARM (7–30 days)\n');
    for (const e of warmEntries) lines.push(summarizeEntry(e, 'recent.md'));
    lines.push('');
  }
  const monthKeys = [...coldByMonth.keys()].sort().reverse();
  for (const key of monthKeys) {
    const [year, month] = key.split('-');
    lines.push(`## COLD ${year}-${month}\n`);
    for (const e of coldByMonth.get(key)) lines.push(summarizeEntry(e, `${year}-${month}.md`));
    lines.push('');
  }
  return `${frontmatter}\n${intro}\n\n${lines.join('\n').trim()}\n`;
};

export const groupByMonth = (entries) => {
  const map = new Map();
  for (const e of entries) {
    const key = `${e.year}-${e.month}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  return map;
};

const main = async () => {
  const { flags, opts } = parseArgs(process.argv);
  const cutoffs = computeCutoffs(opts.today, opts.hotDays, opts.warmDays);
  const todayStr = cutoffs.today.toISOString().slice(0, 10);

  const changelogText = await readFile(CHANGELOG_PATH, 'utf8');
  const parsed = parseChangelogText(changelogText);

  // Pull in legacy archive file if present (one-time inhalation).
  const legacyArchivePath = resolve(ROOT, 'docs/ai/changelog-archive.md');
  let legacyEntries = [];
  if (existsSync(legacyArchivePath)) {
    const legacyText = await readFile(legacyArchivePath, 'utf8');
    legacyEntries = parseChangelogText(legacyText).entries;
  }

  // Read existing archive files so rotation is idempotent and does not drop entries
  // already in WARM/COLD when only HOT changed.
  let warmExistingEntries = [];
  if (existsSync(RECENT_PATH)) {
    const recentText = await readFile(RECENT_PATH, 'utf8');
    warmExistingEntries = parseChangelogText(recentText).entries;
  }
  let coldExistingEntries = [];
  if (existsSync(HISTORY_DIR)) {
    const archiveEntries = await readdir(HISTORY_DIR);
    for (const name of archiveEntries) {
      if (!/^\d{4}-\d{2}\.md$/.test(name)) continue;
      const text = await readFile(resolve(HISTORY_DIR, name), 'utf8');
      coldExistingEntries.push(...parseChangelogText(text).entries);
    }
  }

  // Dedupe by (date + title) — favour the freshest occurrence by file source order.
  const seen = new Set();
  const allEntries = [
    ...parsed.entries,
    ...legacyEntries,
    ...warmExistingEntries,
    ...coldExistingEntries,
  ]
    .filter((e) => {
      const key = `${e.dateStr}|${e.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.dateObj.getTime() - a.dateObj.getTime());
  const { hot, warm, cold } = categorize(allEntries, cutoffs);
  const coldByMonth = groupByMonth(cold);

  const summary = {
    today: todayStr,
    hotCutoff: cutoffs.hotCutoff.toISOString().slice(0, 10),
    warmCutoff: cutoffs.warmCutoff.toISOString().slice(0, 10),
    totals: { all: allEntries.length, hot: hot.length, warm: warm.length, cold: cold.length },
    hotDates: hot.map((e) => e.dateStr),
    warmDates: warm.map((e) => e.dateStr),
    coldDates: cold.map((e) => e.dateStr),
    coldFiles: [...coldByMonth.keys()].sort(),
  };

  if (flags.check) {
    const tooOldInHot = parsed.entries.filter((e) => e.dateObj < cutoffs.hotCutoff);
    if (tooOldInHot.length > 0) {
      console.error(
        `[archive-changelog] FAIL: ${tooOldInHot.length} entries in changelog.md are older than ${opts.hotDays} days (relative to ${todayStr}).`,
      );
      for (const e of tooOldInHot) console.error(`  - ${e.dateStr} — ${e.title}`);
      console.error('Run the changelog archive script (without --check) to rotate.');
      process.exit(1);
    }
    console.log(`[archive-changelog] OK — all changelog.md entries are within ${opts.hotDays} days of ${todayStr}.`);
    process.exit(0);
  }

  if (flags.dryRun) {
    console.log('[archive-changelog] DRY-RUN — no files will be changed.');
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  await mkdir(HISTORY_DIR, { recursive: true });

  const newChangelog = buildChangelog({
    frontmatter: parsed.frontmatter || FRONTMATTER('history', 700, todayStr),
    preamble: parsed.preamble,
    hot,
    footer: parsed.footer,
    hasArchive: warm.length > 0 || cold.length > 0,
  });
  await writeFile(CHANGELOG_PATH, newChangelog, 'utf8');

  if (warm.length > 0) {
    await writeFile(RECENT_PATH, buildRecent(warm, todayStr), 'utf8');
  }

  for (const [key, entries] of coldByMonth) {
    const [year, month] = key.split('-');
    const path = resolve(HISTORY_DIR, `${year}-${month}.md`);
    await writeFile(path, buildCold(year, month, entries, todayStr), 'utf8');
  }

  if (warm.length > 0 || cold.length > 0) {
    await writeFile(INDEX_PATH, buildCondensedIndex(warm, coldByMonth, todayStr), 'utf8');
  }

  console.log('[archive-changelog] migrated:');
  console.log(`  HOT (${relative(ROOT, CHANGELOG_PATH)}): ${hot.length}`);
  console.log(`  WARM (${relative(ROOT, RECENT_PATH)}): ${warm.length}`);
  for (const key of coldByMonth.keys()) {
    console.log(`  COLD (history/${key}.md): ${coldByMonth.get(key).length}`);
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
