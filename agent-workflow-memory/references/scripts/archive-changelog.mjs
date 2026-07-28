#!/usr/bin/env node
// Rolling-window archive for docs/ai/changelog.md.
//
// HOT  (changelog.md)               — last HOT_DAYS days
// WARM (history/recent.md)          — entries HOT_DAYS..WARM_DAYS old
// COLD (history/YYYY-MM.md)         — entries older than WARM_DAYS, compressed
// META (history/condensed-index.md) — one-line TL;DRs of every archived entry
//
// The file is read through the shared block tokenizer (markdown-blocks.mjs): headings are
// recognised only OUTSIDE fenced regions, CRLF and trailing whitespace never change the block
// structure, and an unclosed fence is a loud error instead of a silent absorber. On top of the
// tokens this archiver applies its own unit grammar and FAILS CLOSED: a date-shaped heading that
// does not parse as an entry refuses with file:line — it is never glued into the previous entry,
// never duplicated into the footer, never normalised into a different calendar date.
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
// Every mode parses every source BEFORE any write, so a refusal fires identically for the
// default run, --dry-run and --check, and nothing is written on a refused input.
//
// CLI overrides:
//   --hot-days=N  (default 3)
//   --warm-days=N (default 30)
//   --today=YYYY-MM-DD (default today UTC) — useful for tests / reproducible runs

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tokenizeMarkdown, findParagraphBreak, fail } from './markdown-blocks.mjs';

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

const CHANGELOG_REL = 'docs/ai/changelog.md';
const HISTORY_REL = 'docs/ai/history';
const RECENT_REL = 'docs/ai/history/recent.md';
const LEGACY_REL = 'docs/ai/changelog-archive.md';

const DEFAULT_HOT_DAYS = 3;
const DEFAULT_WARM_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Both separators are ACCEPTED on read: deployed archives on disk are dotted, while every other
// date surface in the family — `lastUpdated:` included — is ISO. The backreference forbids a mixed
// form (`2026-07.20`). ISO is what gets WRITTEN into new templates; re-emission preserves each
// entry's source form verbatim.
const ENTRY_HEADING_RE = /^## (\d{4})([.-])(\d{2})\2(\d{2})(?: [—–] (.*))?$/;
// Kept exactly as shipped (Decision 3, L5): once the loud path exists this pattern is inert on the
// entry side — an entry heading never reaches it — and it still names what a footer boundary IS.
// Widening it was proven to convert a visible defect into a silent one; do not touch it.
const NON_ENTRY_H2_RE = /^## (?!\d{4}\.\d{2}\.\d{2})/;
// Unit-shape: a heading whose text begins with a plausible date attempt — deliberately WIDER than
// the entry grammar, at ANY heading level and indent, so `### 2026-07-20`, `  ## 2026.07.20`,
// `## 2026-07` and `## 20260720` all refuse loudly instead of being absorbed, while a prose
// heading that merely starts with a year (`## 2026 vision`) stays prose.
const DATE_LIKE_RE = /^\s*#{1,6}[ \t]+\d{4}[./-]?\d/;

const USAGE =
  'Usage: archive-changelog.mjs [--dry-run|--check] [--hot-days=N] [--warm-days=N] [--today=YYYY-MM-DD]';

const parseArgs = (argv) => {
  const flags = { dryRun: false, check: false, help: false };
  const opts = { hotDays: DEFAULT_HOT_DAYS, warmDays: DEFAULT_WARM_DAYS, today: null };
  for (const arg of argv) {
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--check') flags.check = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('--hot-days=')) opts.hotDays = Number(arg.slice('--hot-days='.length));
    else if (arg.startsWith('--warm-days=')) opts.warmDays = Number(arg.slice('--warm-days='.length));
    else if (arg.startsWith('--today=')) opts.today = arg.slice('--today='.length);
    else throw fail(2, `unknown argument: ${arg}\n${USAGE}`);
  }
  return { flags, opts };
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

// Parse one tier's text → { frontmatter, preamble, entries, footer }. Fails closed: any
// unit-shaped heading that does not parse as an entry is exit 1 naming `label:line`, and an entry
// appearing after the footer boundary refuses rather than being duplicated into the footer.
export const parseChangelogText = (text, label = 'changelog') => {
  const { frontmatter, frontLines, lines, headings } = tokenizeMarkdown(text, label);
  const fileLine = (index) => frontLines + index + 1;

  const entryHeadings = [];
  let footerIdx = -1;
  for (const heading of headings) {
    const m = ENTRY_HEADING_RE.exec(heading.text);
    if (m) {
      const [, year, , month, day] = m;
      const dateObj = new Date(`${year}-${month}-${day}T00:00:00Z`);
      const roundTrips =
        dateObj.getUTCFullYear() === Number(year) &&
        dateObj.getUTCMonth() + 1 === Number(month) &&
        dateObj.getUTCDate() === Number(day);
      if (!roundTrips) {
        throw fail(
          1,
          `${label}:${fileLine(heading.index)}: "${heading.text}" is date-shaped but ` +
            `${year}-${month}-${day} is not a real calendar date — it would previously have been ` +
            'silently normalised into a different month; fix the date, then re-run.',
        );
      }
      if (footerIdx !== -1) {
        throw fail(
          1,
          `${label}:${fileLine(heading.index)}: entry heading "${heading.text}" appears after the ` +
            `footer boundary at line ${fileLine(footerIdx)} — the footer must be the last section; ` +
            'it would previously have been silently duplicated into the footer; move the entry ' +
            'above the footer, then re-run.',
        );
      }
      entryHeadings.push({ index: heading.index, match: m });
      continue;
    }
    if (DATE_LIKE_RE.test(heading.text)) {
      throw fail(
        1,
        `${label}:${fileLine(heading.index)}: "${heading.text}" is date-shaped but does not parse ` +
          'as an entry heading — expected `## YYYY-MM-DD — title` or `## YYYY.MM.DD — title` at ' +
          'column 0 with a real calendar date. It would previously have been silently absorbed ' +
          'into the previous entry; fix the heading, then re-run.',
      );
    }
    if (heading.level === 2 && entryHeadings.length > 0 && footerIdx === -1 && NON_ENTRY_H2_RE.test(heading.text)) {
      // Only a non-entry H2 AFTER at least one date entry is the footer boundary. Otherwise a
      // previously-inserted "## History" pointer in the preamble would be mis-detected and cause
      // every entry to be slurped into `footer`.
      footerIdx = heading.index;
    }
  }

  const preambleEnd = entryHeadings.length > 0 ? entryHeadings[0].index : lines.length;
  // The trailing `---` before the entries block is the BUILDER's structural separator, not
  // preamble content — keeping it made every rebuild of an archive-less tree add one more.
  const preamble = stripTrailingSeparator(lines.slice(0, preambleEnd).join('\n')).trim();

  const entries = entryHeadings.map(({ index, match }, i) => {
    const end =
      i + 1 < entryHeadings.length
        ? entryHeadings[i + 1].index
        : footerIdx !== -1
          ? footerIdx
          : lines.length;
    const block = stripTrailingSeparator(lines.slice(index, end).join('\n'));
    const [, year, separator, month, day, title] = match;
    return {
      // dateStr is the DEDUPE IDENTITY and the grouping key, so it stays separator-insensitive —
      // one entry written both ways collapses to one. dateSource preserves what the file said, and
      // is what gets RENDERED, so an index line matches the heading it links to.
      dateStr: `${year}.${month}.${day}`,
      dateSource: `${year}${separator}${month}${separator}${day}`,
      dateObj: new Date(`${year}-${month}-${day}T00:00:00Z`),
      year,
      month,
      day,
      title: title ?? '',
      block,
    };
  });

  const footer = footerIdx !== -1 ? lines.slice(footerIdx).join('\n').trim() : '';

  return { frontmatter, preamble, entries, footer };
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
  // The block came out of a tokenized document, so its fences are balanced by construction; the
  // paragraph split below is fence-aware, so compression can no longer cut a fenced block in half
  // and write an archive the next run refuses.
  const { lines, fencedLines } = tokenizeMarkdown(entry.block, 'entry block');
  const heading = lines[0];
  const body = lines.slice(1).join('\n');

  const paragraphs = [];
  let cursor = 1;
  while (cursor < lines.length) {
    const brk = findParagraphBreak(lines, fencedLines, cursor);
    const end = brk === -1 ? lines.length : brk;
    const para = lines.slice(cursor, end).join('\n').trim();
    if (para !== '') paragraphs.push(para);
    cursor = end + 1;
  }

  // A previously-generated `**Result:**` line is never summary material and is PRESERVED as the
  // metric below instead of being re-extracted — re-harvesting metrics from our own output made
  // every COLD rewrite append another copy (`12 tests` → `12 tests, 12 tests`).
  const isResultLine = (p) => /^\*\*Result:\*\*/.test(p);
  const summary =
    paragraphs.find(
      (p) => !p.startsWith('#') && !isResultLine(p) && /^(\*\*Goal|\*\*Problem|\*\*Context|\*\*Why|\*\*Session)/i.test(p),
    ) ??
    paragraphs.find((p) => !p.startsWith('#') && !isResultLine(p)) ??
    '';

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

  const existingResult = paragraphs.find(isResultLine);
  const metric = existingResult ?? extractMetric(body);

  // The writer never emits what the reader refuses, by construction: the summary is whole
  // fence-aware paragraphs (balanced fences), bullet lines and the metric line cannot open a
  // fence, and the heading is a heading. The harness's self-consumption property pins this, and
  // the WARM/COLD byte-fixed-point property pins that re-compression changes nothing.
  return [heading, '', summary, extractFileBullets(body), metric]
    .filter(Boolean)
    .join('\n\n')
    .trim();
};

const summarizeEntry = (entry, sourceLink) => {
  const titleSnippet = entry.title.slice(0, 110).replace(/\n/g, ' ');
  // Render the form the entry was WRITTEN in, so an index line matches the heading it links to.
  return `- **${entry.dateSource ?? entry.dateStr}** — ${titleSnippet} — [${sourceLink}](./${sourceLink})`;
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

export const runCli = (argv, deps = {}) => {
  const { root = ROOT, log = console.log, logError = console.error } = deps;
  try {
    const { flags, opts } = parseArgs(argv);
    if (flags.help) {
      log(USAGE);
      return 0;
    }
    const cutoffs = computeCutoffs(opts.today, opts.hotDays, opts.warmDays);
    const todayStr = cutoffs.today.toISOString().slice(0, 10);

    const changelogPath = resolve(root, CHANGELOG_REL);
    const historyDir = resolve(root, HISTORY_REL);
    const recentPath = resolve(root, RECENT_REL);
    const indexPath = resolve(historyDir, 'condensed-index.md');
    const legacyPath = resolve(root, LEGACY_REL);

    if (!existsSync(changelogPath)) {
      logError(`[archive-changelog] ${CHANGELOG_REL} not found — nothing to do.`);
      return 1;
    }

    // EVERY mode parses EVERY source before any write: a refusal in the main file, the legacy
    // archive, recent.md or a monthly COLD file fires identically for the default run, --dry-run
    // and --check, naming that file's own file:line — and nothing is written.
    const perFile = {};
    const parsed = parseChangelogText(readFileSync(changelogPath, 'utf8'), CHANGELOG_REL);
    perFile[CHANGELOG_REL] = parsed.entries.length;

    let legacyEntries = [];
    if (existsSync(legacyPath)) {
      legacyEntries = parseChangelogText(readFileSync(legacyPath, 'utf8'), LEGACY_REL).entries;
      perFile[LEGACY_REL] = legacyEntries.length;
    }
    let warmExistingEntries = [];
    if (existsSync(recentPath)) {
      warmExistingEntries = parseChangelogText(readFileSync(recentPath, 'utf8'), RECENT_REL).entries;
      perFile[RECENT_REL] = warmExistingEntries.length;
    }
    const coldExistingEntries = [];
    if (existsSync(historyDir)) {
      for (const name of readdirSync(historyDir)) {
        if (!/^\d{4}-\d{2}\.md$/.test(name)) continue;
        const rel = `${HISTORY_REL}/${name}`;
        const entries = parseChangelogText(readFileSync(resolve(historyDir, name), 'utf8'), rel).entries;
        perFile[rel] = entries.length;
        coldExistingEntries.push(...entries);
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
      perFile,
      hotDates: hot.map((e) => e.dateStr),
      warmDates: warm.map((e) => e.dateStr),
      coldDates: cold.map((e) => e.dateStr),
      coldFiles: [...coldByMonth.keys()].sort(),
    };

    if (flags.check) {
      const tooOldInHot = parsed.entries.filter((e) => e.dateObj < cutoffs.hotCutoff);
      if (tooOldInHot.length > 0) {
        logError(
          `[archive-changelog] FAIL: ${tooOldInHot.length} entries in ${CHANGELOG_REL} are older than ${opts.hotDays} days (relative to ${todayStr}).`,
        );
        for (const e of tooOldInHot) logError(`  - ${e.dateStr} — ${e.title}`);
        logError('Run the changelog archive script (without --check) to rotate.');
        return 1;
      }
      // The verdict names what it acted on: a zero-entry tier is a DECISION — with the loud path
      // above, zero can only mean nothing unit-shaped is present, never a file that failed to parse.
      log(
        `[archive-changelog] OK — ${CHANGELOG_REL}: ${parsed.entries.length} parsed entries, all within ` +
          `${opts.hotDays} days of ${todayStr}; corpus ${allEntries.length} (HOT ${hot.length} / WARM ${warm.length} / COLD ${cold.length}).`,
      );
      return 0;
    }

    if (flags.dryRun) {
      log('[archive-changelog] DRY-RUN — no files will be changed.');
      log(JSON.stringify(summary, null, 2));
      return 0;
    }

    // Zero-corpus policy, default mode: with the loud path above, zero entries across EVERY
    // source can only mean genuinely nothing to rotate — a stated no-op, never a gratuitous
    // mkdir + rewrite. Checked against allEntries (not just HOT) so an empty HOT never blocks
    // servicing existing WARM/COLD entries.
    if (allEntries.length === 0) {
      log('[archive-changelog] nothing to rotate — 0 entries across every source.');
      return 0;
    }

    mkdirSync(historyDir, { recursive: true });

    const newChangelog = buildChangelog({
      frontmatter: parsed.frontmatter || FRONTMATTER('history', 700, todayStr),
      preamble: parsed.preamble,
      hot,
      footer: parsed.footer,
      hasArchive: warm.length > 0 || cold.length > 0,
    });
    writeFileSync(changelogPath, newChangelog, 'utf8');

    if (warm.length > 0) {
      writeFileSync(recentPath, buildRecent(warm, todayStr), 'utf8');
    }

    for (const [key, entries] of coldByMonth) {
      const [year, month] = key.split('-');
      writeFileSync(resolve(historyDir, `${year}-${month}.md`), buildCold(year, month, entries, todayStr), 'utf8');
    }

    if (warm.length > 0 || cold.length > 0) {
      writeFileSync(indexPath, buildCondensedIndex(warm, coldByMonth, todayStr), 'utf8');
    }

    log('[archive-changelog] migrated:');
    log(`  HOT (${CHANGELOG_REL}): ${hot.length}`);
    log(`  WARM (${RECENT_REL}): ${warm.length}`);
    for (const key of coldByMonth.keys()) {
      log(`  COLD (${HISTORY_REL}/${key}.md): ${coldByMonth.get(key).length}`);
    }
    return 0;
  } catch (err) {
    logError(`[archive-changelog] ${err.message}`);
    return err.exitCode ?? 1;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = runCli(process.argv.slice(2));
