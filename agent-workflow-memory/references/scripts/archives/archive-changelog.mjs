#!/usr/bin/env node
// The changelog rotation (spec archive-rotations); META grows one line per archived entry, ~1159 lines over 2y in a stress test.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenizeMarkdown, findParagraphBreak, fail, findProjectRoot,
  composeRedBlock, composeUsageRefusal, guardChecker } from '../shared/index.mjs';
import { CAP_TABLE, capFor, countLines, shardingWarning } from './archive-caps.mjs';

const ROOT = findProjectRoot(import.meta.url);
const CHECKER_NAME = 'archive-changelog';
const PACKAGE_REL = 'package.json';
const GUARD = Object.freeze({ name: CHECKER_NAME, exitCode: 1, remedy: 'fix the cause the stack below names, then re-run' });
const INDEX_REL = 'docs/ai/history/condensed-index.md';
const shown = (text) => text.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
const composeFailure = (failed, findings, remedy, after = []) => ({
  exitCode: 1,
  lines: composeRedBlock({ name: CHECKER_NAME, failed: shown(failed),
    findings: findings.map(({ place, text }) => ({ place, text: shown(text) })),
    remedies: [shown(remedy)], after }),
});
export const readProjectName = (root) => {
  try {
    const text = readFileSync(resolve(root, PACKAGE_REL), 'utf8');
    try {
      return JSON.parse(text)?.name || basename(root);
    } catch {
      return basename(root);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return basename(root);
  }
};
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
    else return { unknown: arg };
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

// Refuse malformed date-shaped headings and entries after the footer, naming label:line.
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
          `${label}:${fileLine(heading.index)}`,
        );
      }
      if (footerIdx !== -1) {
        throw fail(
          1,
          `${label}:${fileLine(heading.index)}: entry heading "${heading.text}" appears after the ` +
            `footer boundary at line ${fileLine(footerIdx)} — the footer must be the last section; ` +
            'it would previously have been silently duplicated into the footer; move the entry ' +
            'above the footer, then re-run.',
          `${label}:${fileLine(heading.index)}`,
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
        `${label}:${fileLine(heading.index)}`,
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
      line: fileLine(index),
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

// Each tier renders TWICE and stamps what the second render can honour. The cap is one line of
// frontmatter whatever integer it holds, so the first render's line count IS the final file's line
// count — which makes the stamp a fixed point rather than a promise about a corpus nobody has seen.
// capFor refuses outright past the tier's ceiling; see archive-caps.mjs.
const stamped = (tier, render) => render(capFor({ tier, count: countLines(render(0)) }));

export const buildRecent = (entries, todayStr, projectName = readProjectName(ROOT)) => {
  const preamble = `# Changelog WARM Archive — ${projectName}\n\n> Entries aged **7–30 days** from today. Newer → [\`../changelog.md\`](../changelog.md). Older → [\`condensed-index.md\`](./condensed-index.md) plus per-month \`YYYY-MM.md\` files.`;
  const body = renderEntries(entries);
  return stamped('warm', (cap) => `${FRONTMATTER('history', cap, todayStr)}\n${preamble}\n\n---\n\n${body}\n`);
};

export const buildCold = (year, month, entries, todayStr) => {
  const preamble = `# Changelog COLD Archive — ${year}-${month}\n\n> Compressed entries from ${year}-${month} (older than 30 days). Cross-month one-liners → [\`condensed-index.md\`](./condensed-index.md). Full commit history: \`git log --since=${year}-${month}-01 --until=${year}-${month}-31\`.`;
  const compressed = entries.map(compressEntry).join('\n\n---\n\n');
  return stamped('cold', (cap) => `${FRONTMATTER('history', cap, todayStr)}\n${preamble}\n\n---\n\n${compressed}\n`);
};

export const buildCondensedIndex = (warmEntries, coldByMonth, todayStr, projectName = readProjectName(ROOT)) => {
  const intro = `# Condensed Index — ${projectName} Changelog\n\n> One-line TL;DR for every archived entry. Each line links to the file holding the full text.`;

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
  return stamped('meta', (cap) => `${FRONTMATTER('history', cap, todayStr)}\n${intro}\n\n${lines.join('\n').trim()}\n`);
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

const buildTier = (tier, place, build) => {
  try {
    return build();
  } catch (error) {
    if (error.exitCode && !error.place) throw Object.assign(error, { tier, archivePlace: place });
    throw error;
  }
};
const rotate = (argv, root, log, warnings) => {
  try {
    const { flags, opts, unknown } = parseArgs(argv);
    if (unknown !== undefined) return { exitCode: 2, lines: composeUsageRefusal({
      name: CHECKER_NAME, failed: shown('unknown argument: ' + unknown), usage: USAGE,
    }) };
    if (flags.help) {
      log(USAGE);
      return 0;
    }
    const project = {};
    try {
      project.name = readProjectName(root);
    } catch (error) {
      return composeFailure(`cannot read ${PACKAGE_REL}: ${error.message.split(/\r\n|[\r\n]/)[0]}`,
        [{ place: PACKAGE_REL, text: "the project's name cannot be read from it" }],
        'make package.json a readable file, or remove it, then re-run');
    }
    const cutoffs = computeCutoffs(opts.today, opts.hotDays, opts.warmDays);
    const todayStr = cutoffs.today.toISOString().slice(0, 10);
    const changelogPath = resolve(root, CHANGELOG_REL);
    const historyDir = resolve(root, HISTORY_REL);
    const recentPath = resolve(root, RECENT_REL);
    const indexPath = resolve(historyDir, 'condensed-index.md');
    const legacyPath = resolve(root, LEGACY_REL);
    if (!existsSync(changelogPath)) {
      return composeFailure(`${CHANGELOG_REL} not found`,
        [{ place: CHANGELOG_REL, text: 'the file this rotation reads does not exist' }],
        `create ${CHANGELOG_REL}, then re-run`);
    }
    // Every mode parses every source before any write, so a refusal names its file:line and writes nothing.
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

    // Build every cap-bearing tier in every mode before any write; a ceiling refusal leaves the tree untouched.
    const archives = [];
    if (warm.length > 0) archives.push({ path: recentPath,
      text: buildTier('warm', RECENT_REL, () => buildRecent(warm, todayStr, project.name)) });
    for (const [key, entries] of coldByMonth) {
      const [year, month] = key.split('-');
      const place = `${HISTORY_REL}/${year}-${month}.md`;
      archives.push({ path: resolve(historyDir, `${year}-${month}.md`),
        text: buildTier('cold', place, () => buildCold(year, month, entries, todayStr)) });
    }
    if (warm.length > 0 || cold.length > 0) {
      const index = buildTier('meta', INDEX_REL, () => buildCondensedIndex(warm, coldByMonth, todayStr, project.name));
      const warning = shardingWarning({ tier: 'meta', count: countLines(index) });
      if (warning) warnings.push(`[archive-changelog] WARNING: ${warning}`);
      archives.push({ path: indexPath, text: index });
    }

    if (flags.check) {
      const tooOldInHot = parsed.entries.filter((e) => e.dateObj < cutoffs.hotCutoff);
      if (tooOldInHot.length > 0) {
        return composeFailure(`entries of ${CHANGELOG_REL} older than ${opts.hotDays} days (relative to ${todayStr}): ${tooOldInHot.length}`,
          tooOldInHot.map((entry) => ({ place: `${CHANGELOG_REL}:${entry.line}`, text: `${entry.dateStr} — ${entry.title}` })),
          'rotate them with node scripts/agent-workflow/run.mjs archive-changelog', warnings.splice(0));
      }
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

    for (const archive of archives) writeFileSync(archive.path, archive.text, 'utf8');

    log('[archive-changelog] migrated:');
    log(`  HOT (${CHANGELOG_REL}): ${hot.length}`);
    log(`  WARM (${RECENT_REL}): ${warm.length}`);
    for (const key of coldByMonth.keys()) {
      log(`  COLD (${HISTORY_REL}/${key}.md): ${coldByMonth.get(key).length}`);
    }
    return 0;
  } catch (err) {
    if (err.exitCode && err.place) return composeFailure(`cannot parse ${err.place.replace(/:\d+$/, '')}`,
      [{ place: err.place, text: err.message.slice(err.place.length + 2) }], 'fix the place named above, then re-run');
    if (err.exitCode && err.archivePlace) return composeFailure(`the ${err.tier} tier ${err.archivePlace} is past its ceiling`,
      [{ place: err.archivePlace, text: err.message }], CAP_TABLE[err.tier].remedy);
    throw err;
  }
};
export const runCli = (argv, deps = {}) => {
  const { root = ROOT, log = console.log, logError = console.error } = deps;
  const greenLines = [];
  const warnings = [];
  const answer = guardChecker(GUARD, () => rotate(argv, root, (line) => greenLines.push(line), warnings));
  if (typeof answer === 'number') {
    for (const warning of warnings) logError(warning);
    for (const line of greenLines) log(line);
    return answer;
  }
  for (const line of [...answer.lines, ...warnings]) log(line);
  return answer.exitCode;
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
if (isDirectRun) process.exitCode = runCli(process.argv.slice(2));
