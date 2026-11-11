#!/usr/bin/env node
// The issues rotation (spec archive-rotations).

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenizeMarkdown, fail, findProjectRoot, composeRedBlock, composeUsageRefusal, guardChecker } from '../shared/index.mjs';

const ROOT = findProjectRoot(import.meta.url);
const CHECKER_NAME = 'archive-issues';
const PACKAGE_REL = 'package.json';
const GUARD = Object.freeze({ name: CHECKER_NAME, exitCode: 1, remedy: 'fix the cause the stack below names, then re-run' });
const shown = (text) => text.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
const composeFailure = (failed, findings, remedy) => ({
  exitCode: 1,
  lines: composeRedBlock({ name: CHECKER_NAME, failed: shown(failed),
    findings: findings.map(({ place, text }) => ({ place, text: shown(text) })), remedies: [shown(remedy)] }),
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
const KNOWN_REL = 'docs/ai/known_issues.md';
const HISTORY_REL = 'docs/ai/history';
const RESOLVED_REL = 'docs/ai/history/issues-resolved.md';

const DEFAULT_CUTOFF_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ISSUE_HEADING_RE = /^### (.+?)$/;
const STRIKETHROUGH_RE = /^~~(.+)~~$/;
// The canonical issue-heading form, named in code: a column-0 level-3 heading whose title starts
// `Issue-NNN` (strikethrough optional). ISSUE-SHAPE is deliberately wider — the same prefix at any
// level or indent — so a mis-levelled or indented issue heading refuses loudly instead of being
// silently absorbed into the section above it.
const ISSUE_TITLE_RE = /^~{0,2}Issue-\d/;
const ISSUE_SHAPED_HEADING_RE = /^\s*#{1,6}[ \t]+~{0,2}Issue-\d/;
// The strict canonical placement: level 3, column 0, exactly one space. An issue-shaped heading
// that misses it by ANY whitespace (double space, a tab, an indent) refuses — `###  Issue-123`
// would otherwise slip past the level-3 boundary test and silently declassify to prose.
const ISSUE_CANONICAL_RE = /^### ~{0,2}Issue-\d/;

// The resolution-marker grammar. The FIELD anchors the residual (Decision 7): only a line-leading
// Status/Resolved field is ever read — a date in prose, or in a Discovered/Update field, is inert.
const MARKER_FIELD_RE = /^(?:- )?\*\*(Status|Resolved):\*\*\s*(.*)$/;
// Optional leading emoji and optional ** emphasis around either keyword — `**FIXED** (…)`,
// `✅ **Resolved** (…)` are resolution claims, not silently-open sections. Case stays exact.
const RESOLVED_SIGNAL_RE = /^(?:✅\s*)?\*{0,2}(?:FIXED|Resolved)\b/;
// The explicitly-open vocabulary — ONLY consulted under a struck heading, where the strike itself
// signals resolution: `~~Issue~~ + Status: Closed/DONE/Wontfix` is an undated resolution claim
// (Arm C loud), while UNSTRUCK sections keep a free status vocabulary and can never false-red.
const OPEN_STATUS_RE = /^(?:Open|Mitigated|Accepted)\b/;
// Loose finds anything date-shaped; strict validates one separator form with 2-digit fields. The
// FIRST date-shaped token is the marker's date — loose-but-not-strict is a refusal, never a skip.
const STRICT_MARKER_DATE_RE = /(?<!\d)(\d{4})([.-])(\d{2})\2(\d{2})(?!\d)/;
const LOOSE_MARKER_DATE_RE = /(?<!\d)\d{4}[./-]\d{1,2}[./-]\d{1,2}(?!\d)/;

const FOOTER_QUOTE_RE = /^ {0,3}>/;
// The canonical closing note the template seeds. The trailing `---` + blockquote run is a FILE
// footer ONLY when its quote text normalises to exactly this sentence — an issue-owned trailing
// quote (even one naming the archive path) stays with its section and archives WITH it, never
// orphaned in the kept file. A reworded note falls back to the section-owned attribution.
export const CANONICAL_FOOTER_NOTE =
  'Resolved issues older than the window are rotated to `history/issues-resolved.md` by the issue-archive script.';
// The exact resolved-example heading the pre-4.0.0 template seeded (legacy-compat, see classify).
const LEGACY_TEMPLATE_BLANK_HEADING = '### Issue-XXX — {{Title}}';
const matchable = (line) => line.replace(/\s+$/, '');
const normalizeQuoteRun = (lines) =>
  lines
    .map((line) => matchable(line))
    .filter((line) => FOOTER_QUOTE_RE.test(line))
    .map((line) => line.replace(/^ {0,3}>\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

const USAGE = 'Usage: archive-issues.mjs [--dry-run|--check] [--cutoff-days=N] [--today=YYYY-MM-DD]';

const parseArgs = (argv) => {
  const flags = { dryRun: false, check: false, help: false };
  const opts = { cutoffDays: DEFAULT_CUTOFF_DAYS, today: null };
  for (const arg of argv) {
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--check') flags.check = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('--cutoff-days=')) opts.cutoffDays = Number(arg.slice('--cutoff-days='.length));
    else if (arg.startsWith('--today=')) opts.today = arg.slice('--today='.length);
    else return { unknown: arg };
  }
  return { flags, opts };
};

// Sections retain byte-exact lines, body-relative starts and section-relative fenced indexes.
export const parseKnownIssues = (text, label = KNOWN_REL) => {
  const { frontmatter, frontLines, lines, headings, fencedLines } = tokenizeMarkdown(text, label);

  const boundaries = new Map();
  for (const heading of headings) {
    if (ISSUE_SHAPED_HEADING_RE.test(heading.text) && !ISSUE_CANONICAL_RE.test(heading.text)) {
      throw fail(
        1,
        `${label}:${frontLines + heading.index + 1}: "${heading.text}" is issue-shaped but not a ` +
          'canonical issue heading — expected `### Issue-NNN — title` (level 3, column 0, exactly ' +
          'one space, ~~strikethrough~~ optional). It would previously have been silently glued ' +
          'into the section above it or declassified to prose; fix the heading, then re-run.',
        `${label}:${frontLines + heading.index + 1}`,
      );
    }
    if (heading.level === 2 || heading.level === 3) boundaries.set(heading.index, heading);
  }

  // Only an unfenced terminal `---` + canonical quote run belongs to the file, not the issue.
  let footerStart = -1;
  let tail = lines.length - 1;
  while (tail >= 0 && !fencedLines.has(tail) && (matchable(lines[tail]) === '' || FOOTER_QUOTE_RE.test(lines[tail]))) tail -= 1;
  if (
    tail >= 0 &&
    !fencedLines.has(tail) &&
    /^ {0,3}---$/.test(matchable(lines[tail])) &&
    normalizeQuoteRun(lines.slice(tail + 1)) === CANONICAL_FOOTER_NOTE
  ) {
    footerStart = tail;
  }

  const end = footerStart === -1 ? lines.length : footerStart;
  const sections = [];
  let current = { heading: null, structural: true, start: 0, lines: [] };
  const flush = () => {
    if (current.heading !== null || current.lines.length > 0) sections.push(current);
  };
  for (let i = 0; i < end; i += 1) {
    const boundary = boundaries.get(i);
    if (boundary) {
      flush();
      current = { heading: boundary.text, structural: boundary.level !== 3, start: i, lines: [] };
    }
    current.lines.push(lines[i]);
  }
  flush();
  if (footerStart !== -1) sections.push({ heading: null, structural: true, start: footerStart, lines: lines.slice(footerStart) });

  for (const section of sections) {
    section.fenced = new Set();
    for (let i = 0; i < section.lines.length; i += 1) {
      if (fencedLines.has(section.start + i)) section.fenced.add(i);
    }
  }

  verifySectionPartition(sections, lines, label);

  return { frontmatter, frontLines, sections };
};

// Refuse before any write if chunks fail to reproduce the body element-wise and in order,
// including equal-cardinality corruption a future edit to the chunk loop might introduce.
export const verifySectionPartition = (sections, bodyLines, label = KNOWN_REL) => {
  const rebuilt = sections.flatMap((s) => s.lines);
  const exact = rebuilt.length === bodyLines.length && rebuilt.every((line, i) => line === bodyLines[i]);
  if (!exact) {
    throw fail(
      1,
      `${label}: internal section-model error — the ${rebuilt.length}-line section partition does ` +
        `not reproduce the ${bodyLines.length}-line body; refusing before any write.`,
      label,
    );
  }
};

const scanMarkerDate = (value) => {
  const loose = LOOSE_MARKER_DATE_RE.exec(value);
  if (!loose) return null;
  const strict = STRICT_MARKER_DATE_RE.exec(loose[0]);
  if (strict && strict[0] === loose[0]) {
    const [, year, , month, day] = strict;
    const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
    // Round-trip, never trust Date: V8 rolls 2026-02-30 into March instead of rejecting it.
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === `${year}-${month}-${day}`) {
      return { date };
    }
  }
  return { invalid: loose[0] };
};

export const classifySection = (section, cutoffDate) => {
  if (section.structural || section.heading === null) return { kind: 'structure' };
  const headingMatch = ISSUE_HEADING_RE.exec(section.heading);
  if (!headingMatch) return { kind: 'other' };
  const title = headingMatch[1];
  // The pre-4.0.0 template seeded this EXACT example section — the literal heading is a safe
  // identity (no real issue carries `{{Title}}`), so a pristine OR half-substituted legacy blank
  // is inert BEFORE any marker/conflict/date classification and can never red a gate or archive.
  if (section.heading === LEGACY_TEMPLATE_BLANK_HEADING) return { kind: 'template-blank' };
  const stricken = STRIKETHROUGH_RE.test(title);

  let claims = null;
  let nonClaims = null;
  for (let i = 0; i < section.lines.length; i += 1) {
    if (section.fenced?.has(i)) continue;
    const field = MARKER_FIELD_RE.exec(matchable(section.lines[i]));
    if (!field) continue;
    const isClaim = field[1] === 'Resolved' || RESOLVED_SIGNAL_RE.test(field[2]);
    if (isClaim && claims === null) claims = { line: i, raw: matchable(section.lines[i]), value: field[2] };
    else if (!isClaim && nonClaims === null) nonClaims = { line: i, raw: matchable(section.lines[i]), value: field[2] };
    if (claims && nonClaims) break;
  }

  // Contradictory state refuses: Resolved-priority would silently ARCHIVE a genuinely reopened
  // issue, Status-priority would silently skip a resolved one forever — loud hides nothing.
  if (claims && nonClaims) {
    return { kind: 'conflict', markerLine: claims.line, marker: claims.raw, openLine: nonClaims.line, openMarker: nonClaims.raw };
  }
  if (claims) {
    const scanned = scanMarkerDate(claims.value);
    if (!scanned) return { kind: 'fixed-undated', markerLine: claims.line, marker: claims.raw };
    if (scanned.invalid) return { kind: 'bad-date', markerLine: claims.line, marker: claims.raw, raw: scanned.invalid };
    return scanned.date < cutoffDate
      ? { kind: 'archivable', fixedDate: scanned.date }
      : { kind: 'fixed-recent', fixedDate: scanned.date };
  }
  // An explicit non-resolution Status decides — strikethrough is cosmetic in BOTH directions, so
  // a reopened-but-still-struck issue never refuses every mode. EXCEPT: under a struck heading an
  // UNRECOGNISED status value (Closed, DONE, Wontfix …) is a resolution claim without a date.
  if (nonClaims) {
    if (stricken && !OPEN_STATUS_RE.test(nonClaims.value)) {
      return { kind: 'fixed-undated', markerLine: nonClaims.line, marker: nonClaims.raw };
    }
    return { kind: ISSUE_TITLE_RE.test(title) ? 'open' : 'other' };
  }
  // A struck heading with NO status/resolved field still claims resolution — undated is loud.
  if (stricken) return { kind: 'fixed-undated', markerLine: 0, marker: section.heading };
  return { kind: ISSUE_TITLE_RE.test(title) ? 'open' : 'other' };
};

export const buildResolvedFile = (existing, newSections, todayStr, projectName = readProjectName(ROOT)) => {
  const header = existing
    ? existing
    : `---\ntype: history\nlastUpdated: ${todayStr}\nscope: permanent\nstaleAfter: never\nowner: none\nmaxLines: 3500\n---\n\n# Resolved Issues — ${projectName}\n\n> Append-only archive of issues closed > 14 days ago. Sourced from \`../known_issues.md\`.\n\n---\n`;
  if (newSections.length === 0) return header;
  // Preserve content verbatim; trim only trailing blank elements (trim() eats a CR).
  // One blank separator follows each block's EOL flavor, as the conservation harness allows.
  const blocks = newSections
    .map((s) => {
      const kept = [...s.lines];
      while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
      const separator = kept.length > 0 && kept[kept.length - 1].endsWith('\r') ? '\n\r\n' : '\n\n';
      return kept.join('\n') + separator;
    })
    .join('');
  // Header separators and the single final terminator retain their own EOL flavors.
  // Only runs stay pure; differing header/block flavors remain mixed at their boundary.
  const headerEndsBlank = /(\r?\n){2}$/.test(header);
  const headerEol = header.endsWith('\r\n') ? '\r\n' : '\n';
  return (header + (headerEndsBlank ? '' : headerEol) + blocks).replace(/(\r?\n)+$/, '$1');
};
const rotate = (argv, root, log) => {
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
    const today = opts.today
      ? new Date(`${opts.today}T00:00:00Z`)
      : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
    const cutoffDate = new Date(today.getTime() - (opts.cutoffDays - 1) * MS_PER_DAY);
    const cutoffStr = cutoffDate.toISOString().slice(0, 10);
    const todayStr = today.toISOString().slice(0, 10);

    const knownIssuesPath = resolve(root, KNOWN_REL);
    const historyDir = resolve(root, HISTORY_REL);
    const resolvedPath = resolve(root, RESOLVED_REL);

    if (!existsSync(knownIssuesPath)) {
      return composeFailure(`${KNOWN_REL} not found`,
        [{ place: KNOWN_REL, text: 'the file this rotation reads does not exist' }],
        `create ${KNOWN_REL}, then re-run`);
    }
    const { frontmatter, frontLines, sections } = parseKnownIssues(readFileSync(knownIssuesPath, 'utf8'), KNOWN_REL);
    const classified = sections.map((s) => ({ section: s, ...classifySection(s, cutoffDate) }));

    const loud = classified.filter((c) => c.kind === 'fixed-undated' || c.kind === 'bad-date' || c.kind === 'conflict');
    if (loud.length > 0) {
      const findings = loud.map((c) => {
        const line = frontLines + c.section.start + (c.markerLine ?? 0) + 1;
        const place = `${KNOWN_REL}:${line}`;
        if (c.kind === 'conflict') {
          const openLine = frontLines + c.section.start + c.openLine + 1;
          return { place, text: `"${c.marker.trim()}" contradicts the explicit open status ` +
              `"${c.openMarker.trim()}" (line ${openLine}) — an issue is either open or resolved; delete the ` +
              'stale line, then re-run.' };
        }
        return { place, text: c.kind === 'bad-date'
              ? `resolution marker date "${c.raw}" in "${c.marker.trim()}" ` +
                  'is not a valid calendar date in one separator form (YYYY-MM-DD or YYYY.MM.DD) — fix the date, then re-run.'
              : `"${(c.marker ?? c.section.heading).trim()}" claims resolution ` +
                  'but carries no recognisable date — add a line-leading `- **Resolved:** YYYY-MM-DD` (or ' +
                  '`- **Status:** … FIXED (YYYY-MM-DD)`). Previously this section was silently skipped forever.' };
      });
      return composeFailure(`sections claiming a resolution the rotation cannot accept in ${KNOWN_REL}: ${loud.length}`,
        findings, 'fix each section named above, then re-run');
    }

    const archivable = classified.filter((c) => c.kind === 'archivable');
    const counts = {};
    for (const c of classified) {
      if (c.kind === 'structure') continue;
      counts[c.kind] = (counts[c.kind] ?? 0) + 1;
    }
    const issueSectionCount = classified.filter((c) => c.kind !== 'structure').length;
    const countLine = Object.entries(counts)
      .map(([kind, n]) => `${kind} ${n}`)
      .join(' / ');

    if (flags.check) {
      if (archivable.length > 0) {
        return composeFailure(`archivable issues in ${KNOWN_REL}: ${archivable.length}`,
          archivable.map((c) => ({ place: `${KNOWN_REL}:${frontLines + c.section.start + 1}`, text: c.section.heading.trim() })),
          'archive them with node scripts/agent-workflow/run.mjs archive-issues');
      }
      log(
        `[archive-issues] OK — ${KNOWN_REL}: ${issueSectionCount} issue sections (${countLine || 'none'}), ` +
          `0 archivable with a recognised date older than ${cutoffStr} (cutoff ${opts.cutoffDays} days, relative to ${todayStr}).`,
      );
      return 0;
    }

    if (flags.dryRun) {
      log('[archive-issues] DRY-RUN — no files will be changed.');
      log(`  cutoffDate: ${cutoffStr}`);
      log(`  total sections: ${sections.length}`);
      log(`  issue sections: ${issueSectionCount}${countLine ? ` (${countLine})` : ''}`);
      log(`  archivable: ${archivable.length}`);
      for (const c of archivable) log(`    - ${c.section.heading.trim()}`);
      return 0;
    }

    if (archivable.length === 0) {
      log(`[archive-issues] nothing to archive — ${issueSectionCount} issue sections (${countLine || 'none'}).`);
      return 0;
    }

    mkdirSync(historyDir, { recursive: true });
    const existing = existsSync(resolvedPath) ? readFileSync(resolvedPath, 'utf8') : '';
    const updatedResolved = buildResolvedFile(existing, archivable.map((c) => c.section), todayStr, project.name);
    writeFileSync(resolvedPath, updatedResolved, 'utf8');

    const rebuilt =
      frontmatter +
      classified
        .filter((c) => c.kind !== 'archivable')
        .flatMap((c) => c.section.lines)
        .join('\n');
    writeFileSync(knownIssuesPath, rebuilt, 'utf8');

    log(`[archive-issues] archived ${archivable.length} issue(s) to ${RESOLVED_REL}`);
    return 0;
  } catch (err) {
    if (err.exitCode && err.place) return composeFailure(`cannot parse ${err.place.replace(/:\d+$/, '')}`,
      [{ place: err.place, text: err.message.slice(err.place.length + 2) }], 'fix the place named above, then re-run');
    throw err;
  }
};
export const runCli = (argv, deps = {}) => {
  const { root = ROOT, log = console.log } = deps;
  const answer = guardChecker(GUARD, () => rotate(argv, root, log));
  if (typeof answer === 'number') return answer;
  for (const line of answer.lines) log(line);
  return answer.exitCode;
};
// Run only directly; realpathSync makes a symlinked entry match its target too.
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
