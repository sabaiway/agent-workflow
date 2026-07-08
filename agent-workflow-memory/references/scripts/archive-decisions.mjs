#!/usr/bin/env node
// Three-tier cascade archive for docs/ai/decisions.md (ADRs) — the archive-changelog.mjs sibling.
//
// HOT  (docs/ai/decisions.md)                      — the active ADR set (newest at the bottom)
// WARM (docs/ai/history/decisions-archive.md)      — stable/superseded ADRs rotated out of HOT
// COLD (docs/ai/history/decisions-archive-early.md) — the earliest ADRs, rolled out of WARM
//
// Caps are read from each file's OWN frontmatter `maxLines`. The cascade is CHAINED: rolling
// HOT→WARM when WARM is near its cap first rolls WARM→COLD to make headroom. Whole entries move,
// oldest (lowest AD id, top of file) first; an entry's lines move verbatim.
//
// Modes:
//   (default)   rotate, mutate files in place (only when something is over cap), then regenerate
//               docs/ai/index.md so the rotation never leaves the index stale (item (h))
//   --dry-run   print the planned move-set, change nothing
//   --check     report per-tier lines/cap; exit 1 if any tier is over its cap
//   --today=YYYY-MM-DD  pin the lastUpdated stamp (tests / reproducible runs)
//
// FAIL-LOUD invariants (the Issue-009 lesson — never silently glue an entry to the previous body):
//   • every `## ` heading in every tier MUST parse canonically as `## AD-0NN — <title>` — a
//     malformed heading is exit 1 naming the file + line, never a silent merge;
//   • ADR ids must be strictly ascending within a tier and unique across tiers;
//   • a COLD tier at its cap — or a roll that would not fit COLD's remaining headroom — fails
//     LOUD **before any write** (a cap raise / a new COLD file is a maintainer/agent decision;
//     this script only moves entries);
//   • conservation is self-verified before writing: the multiset of AD ids across all three
//     tiers and every entry's line count are unchanged by the plan.
//
// DELIBERATE divergence from the siblings: on a project WITHOUT docs/ai/decisions.md, `--check`
// reports the absence and exits 0 — the deployed pre-commit hook must never block a commit over
// an absent ADR substrate. (archive-changelog.mjs reads its source unconditionally and crashes
// ENOENT on an absent file; this script states the skip instead.)
//
// Cap accounting is on the REAL on-disk line count (what the docs cap-validator counts), never
// on a normalized render — a template-shaped file with `---` separators between entries must not
// false-green near its cap. A write NORMALIZES formatting (entries joined by one blank line;
// separators dropped), so when a tier is over cap on raw lines but already fits after
// normalization, the rotation performs a NORMALIZE-ONLY rewrite (zero entry moves, stated).
//
// Dependency-free, Node >= 18. Deployed into a consumer's scripts/ like its siblings.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, '..');

// (h) — after a rotation write, docs/ai/index.md would silently go stale (a moved ADR, or just the
// bumped lastUpdated), tripping the SEPARATE `--check-index` gate mid-release-matrix. So the
// rotation regenerates the index by REUSING the ONE generator in the sibling check-docs-size.mjs
// (spawned with --write-index --root=<root>). The subprocess bridges that script's ASYNC generator,
// so this runCli stays SYNCHRONOUS (spawnSync) — the existing sync callers/tests never ripple. It
// DEGRADES LOUDLY to an instruct (never a silent failure) when the sibling is absent or the
// regeneration fails; the --check-index gate still catches a stale index. Injectable for tests.
const CHECK_DOCS_SIBLING = resolve(__dirname, 'check-docs-size.mjs');
const INDEX_INSTRUCT = 'run `node scripts/check-docs-size.mjs --write-index` to refresh docs/ai/index.md';
// Exported + its filesystem edges injectable (deps) so BOTH degrade branches are unit-testable.
export const defaultRegenerateIndex = (root, today, deps = {}) => {
  const exists = deps.existsSync ?? existsSync;
  const spawn = deps.spawnSync ?? spawnSync;
  const sibling = deps.sibling ?? CHECK_DOCS_SIBLING;
  if (!exists(sibling)) {
    return { ok: false, detail: `the index generator is not beside this script — ${INDEX_INSTRUCT}` };
  }
  // `--report` ISOLATES the index-WRITE outcome from the docs-cap-CHECK outcome: check-docs-size
  // --write-index still WRITES the index (and still exits 2 on an empty write / rejects a genuine
  // throw), but --report suppresses its exit-1 on an unrelated over-cap co-located doc — otherwise a
  // benign over-cap sibling would read as an index-regeneration FAILURE (a cry-wolf on this very
  // loud-degrade channel).
  const r = spawn(process.execPath, [sibling, '--write-index', '--report', `--root=${root}`, `--today=${today}`], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    return { ok: false, detail: `index regeneration failed (${(r.error && r.error.message) || `exit ${r.status}`}) — ${INDEX_INSTRUCT}` };
  }
  return { ok: true, detail: (r.stdout || '').trim() };
};

export const HOT_REL = 'docs/ai/decisions.md';
export const WARM_REL = 'docs/ai/history/decisions-archive.md';
export const COLD_REL = 'docs/ai/history/decisions-archive-early.md';

const DEFAULT_WARM_CAP = 500;
const DEFAULT_COLD_CAP = 400;

export const HEADING_RE = /^## AD-(\d{3}) — (.+)$/;
const ANY_H2_RE = /^## /;
const FRONTMATTER_RE = /^(---\n[\s\S]*?\n---\n)/;

export const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

// ── parsing (strict; malformed headings are LOUD) ─────────────────────────────────────

const stripTrailingSeparators = (blockLines) => {
  const lines = [...blockLines];
  while (lines.length > 0 && (lines[lines.length - 1].trim() === '' || lines[lines.length - 1].trim() === '---')) {
    lines.pop();
  }
  return lines;
};

// Parse one tier's text → { frontmatter, cap, preamble, entries }. Every `## ` line must be a
// canonical AD heading — anything else in any tier is exit 1 naming file:line (Issue-009).
export const parseDecisionsText = (text, label) => {
  const fmMatch = text.match(FRONTMATTER_RE);
  const frontmatter = fmMatch ? fmMatch[1] : '';
  const fmLines = frontmatter === '' ? 0 : frontmatter.split('\n').length - 1;
  const rest = text.slice(frontmatter.length);
  const lines = rest.split('\n');

  const startIdxs = [];
  lines.forEach((line, i) => {
    if (!ANY_H2_RE.test(line)) return;
    if (!HEADING_RE.test(line)) {
      throw fail(
        1,
        `${label}:${fmLines + i + 1}: non-canonical H2 heading "${line}" — every "## " heading must be \`## AD-0NN — <title>\` (never silently glued to the previous entry; fix the heading, then re-run)`,
      );
    }
    startIdxs.push(i);
  });

  const preambleEnd = startIdxs.length > 0 ? startIdxs[0] : lines.length;
  const preamble = lines.slice(0, preambleEnd).join('\n').trim();

  const entries = startIdxs.map((idx, i) => {
    const end = i + 1 < startIdxs.length ? startIdxs[i + 1] : lines.length;
    const blockLines = stripTrailingSeparators(lines.slice(idx, end));
    const m = HEADING_RE.exec(lines[idx]);
    return {
      id: m[1],
      idNum: Number(m[1]),
      title: m[2],
      block: blockLines.join('\n'),
      lineCount: blockLines.length,
    };
  });

  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i].idNum <= entries[i - 1].idNum) {
      throw fail(
        1,
        `${label}: AD-${entries[i].id} appears after AD-${entries[i - 1].id} — ids must be strictly ascending within a tier (oldest at the top); refusing to rotate a disordered file`,
      );
    }
  }

  const capMatch = frontmatter.match(/^maxLines:\s*(\d+)\s*$/m);
  return { frontmatter, cap: capMatch ? Number(capMatch[1]) : null, preamble, entries };
};

// ── tier IO ───────────────────────────────────────────────────────────────────────────

const CREATED_FRONTMATTER = (cap, today) =>
  `---\ntype: history\nlastUpdated: ${today}\nscope: permanent\nstaleAfter: never\nowner: none\nmaxLines: ${cap}\n---\n`;

const CREATED_WARM_PREAMBLE = [
  '# Architecture Decision Records — Archive (AD-000 … AD-000)',
  '',
  '> Stable ADRs rotated out of the active [`decisions.md`](../decisions.md) per the 3-tier archive',
  '> discipline. The earliest entries roll further to the COLD',
  '> [`decisions-archive-early.md`](./decisions-archive-early.md). Cross-links (`[[AD-XXX]]`) resolve',
  '> by id across all three decision files.',
].join('\n');

const CREATED_COLD_PREAMBLE = [
  '# Architecture Decision Records — Early Archive (AD-000 … AD-000)',
  '',
  '> The earliest foundational ADRs, rolled out of [`decisions-archive.md`](./decisions-archive.md) (WARM)',
  '> into this COLD tier when the WARM archive neared its cap. Cross-links (`[[AD-XXX]]`) still resolve',
  '> by id across all three decision files.',
].join('\n');

export const loadTiers = (root, today) => {
  const load = (rel, { createdCap, createdPreamble }) => {
    const path = resolve(root, rel);
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8');
      const parsed = parseDecisionsText(raw, rel);
      if (parsed.cap === null) throw fail(1, `${rel}: frontmatter carries no maxLines cap — refusing to rotate against an unknown budget`);
      return { rel, path, exists: true, rawLines: lineCountOf(raw), ...parsed };
    }
    return {
      rel,
      path,
      exists: false,
      rawLines: 0,
      frontmatter: CREATED_FRONTMATTER(createdCap, today),
      cap: createdCap,
      preamble: createdPreamble,
      entries: [],
    };
  };
  const hot = load(HOT_REL, { createdCap: 0, createdPreamble: '' }); // HOT is never created here
  const warm = load(WARM_REL, { createdCap: DEFAULT_WARM_CAP, createdPreamble: CREATED_WARM_PREAMBLE });
  const cold = load(COLD_REL, { createdCap: DEFAULT_COLD_CAP, createdPreamble: CREATED_COLD_PREAMBLE });

  const seen = new Map();
  for (const tier of [hot, warm, cold]) {
    for (const entry of tier.entries) {
      if (seen.has(entry.id)) throw fail(1, `AD-${entry.id} appears in both ${seen.get(entry.id)} and ${tier.rel} — duplicate id across tiers; refusing to rotate`);
      seen.set(entry.id, tier.rel);
    }
  }
  return { hot, warm, cold };
};

// ── rendering ─────────────────────────────────────────────────────────────────────────

export const renderTier = (tier, entries) => {
  const blocks = entries.map((entry) => entry.block).join('\n\n');
  const body = [tier.preamble, blocks].filter((part) => part !== '').join('\n\n');
  return `${tier.frontmatter}\n${body}\n`;
};

export const lineCountOf = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

// ── the deterministic move plan (same input → same move-set; nothing written here) ────

export const planRotation = ({ hot, warm, cold }) => {
  const hotEntries = [...hot.entries];
  const warmEntries = [...warm.entries];
  const coldEntries = [...cold.entries];
  const moves = { hotToWarm: [], warmToCold: [] };

  const linesOf = (tier, entries) => lineCountOf(renderTier(tier, entries));

  const rollWarmToCold = () => {
    if (warmEntries.length === 0) {
      throw fail(1, `${WARM_REL} exceeds its cap with no entries left to roll — its preamble alone is over budget; fix the file by hand`);
    }
    const moved = warmEntries[0];
    const next = [...coldEntries, moved];
    if (linesOf(cold, next) > cold.cap) {
      throw fail(
        1,
        `refusing BEFORE any write: rolling AD-${moved.id} (${moved.lineCount} lines) into ${COLD_REL} would exceed its cap ` +
          `(${linesOf(cold, coldEntries)}/${cold.cap} now, ${linesOf(cold, next)} after) — the COLD tier is exhausted; ` +
          'a cap raise or a new COLD file is a maintainer/agent decision, this script only moves entries',
      );
    }
    warmEntries.shift();
    coldEntries.push(moved);
    moves.warmToCold.push(moved.id);
  };

  const ensureWarmFits = () => {
    while (linesOf(warm, warmEntries) > warm.cap) rollWarmToCold();
  };

  ensureWarmFits(); // a pre-existing WARM overflow chains down first
  while (linesOf(hot, hotEntries) > hot.cap) {
    if (hotEntries.length <= 1) {
      throw fail(1, `${HOT_REL} exceeds its cap but only one entry remains — the newest entry alone is over budget; trim it or raise the cap (maintainer decision)`);
    }
    const moved = hotEntries.shift();
    warmEntries.push(moved);
    moves.hotToWarm.push(moved.id);
    ensureWarmFits();
  }

  return { moves, hotEntries, warmEntries, coldEntries };
};

// Conservation self-verify: the multiset of (id → lineCount) across all tiers is unchanged.
export const verifyConservation = (before, after) => {
  const snapshot = (tiers) =>
    tiers
      .flat()
      .map((entry) => `${entry.id}:${entry.lineCount}`)
      .sort()
      .join('|');
  const beforeKey = snapshot(before);
  const afterKey = snapshot(after);
  if (beforeKey !== afterKey) {
    throw fail(1, `internal conservation violation — the planned move-set would change the ADR set (before ${beforeKey.slice(0, 120)}… vs after ${afterKey.slice(0, 120)}…); refusing to write`);
  }
};

// ── preamble range-token maintenance ──────────────────────────────────────────────────
// The hand-authored preambles carry range tokens ("AD-014 … AD-023", "(AD-024 onward)",
// "from **AD-024**"). After a rotation those would silently lie, so the recognizable tokens are
// updated in place; a preamble without them (a consumer's own wording) is left untouched.

const RANGE_TOKEN_RE = /AD-\d{3} … AD-\d{3}/g;

const formatRange = (entries) => `AD-${entries[0].id} … AD-${entries[entries.length - 1].id}`;

export const updateRangeTokens = (preamble, kind, { hotEntries, warmEntries, coldEntries }) => {
  // Token order per tier file: HOT + WARM preambles mention the WARM range then the COLD range;
  // COLD mentions only its own. This ASSUMES the hand-authored order (WARM before COLD) — the
  // shape all three files here carry. A maintainer who rewrites a preamble with the ranges
  // swapped would get the bounds injected into the wrong slots; if you reorder the ranges,
  // update this sequence too (a preamble WITHOUT the tokens is simply left untouched).
  const sequence = kind === 'cold' ? [coldEntries] : [warmEntries, coldEntries];
  let occurrence = 0;
  let out = preamble.replace(RANGE_TOKEN_RE, (token) => {
    const tierEntries = sequence[Math.min(occurrence, sequence.length - 1)];
    occurrence += 1;
    return tierEntries.length > 0 ? formatRange(tierEntries) : token;
  });
  if (hotEntries.length > 0) {
    out = out.replace(/\(AD-\d{3} onward\)/, `(AD-${hotEntries[0].id} onward)`);
    out = out.replace(/from \*\*AD-\d{3}\*\*/, `from **AD-${hotEntries[0].id}**`);
  }
  return out;
};

const stampLastUpdated = (frontmatter, today) => frontmatter.replace(/^lastUpdated: .*$/m, `lastUpdated: ${today}`);

// ── CLI ───────────────────────────────────────────────────────────────────────────────

const USAGE = 'Usage: archive-decisions.mjs [--dry-run|--check] [--today=YYYY-MM-DD]';

const parseArgs = (argv) => {
  const flags = { dryRun: false, check: false, help: false };
  let today = null;
  for (const arg of argv) {
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--check') flags.check = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('--today=')) today = arg.slice('--today='.length);
    else throw fail(2, `Unknown argument: ${arg}\n${USAGE}`);
  }
  return { flags, today };
};

export const runCli = (argv, deps = {}) => {
  const { root = DEFAULT_ROOT, log = console.log, logError = console.error, regenerateIndex = defaultRegenerateIndex } = deps;
  try {
    const { flags, today: todayOpt } = parseArgs(argv);
    if (flags.help) {
      log(USAGE);
      return 0;
    }
    const today = todayOpt ?? new Date().toISOString().slice(0, 10);

    // DELIBERATE divergence from archive-changelog.mjs (which crashes ENOENT): an absent ADR
    // substrate is a STATED SKIP on --check — the deployed pre-commit hook must never block a
    // commit over a decisions.md the project simply does not keep.
    if (!existsSync(resolve(root, HOT_REL))) {
      if (flags.check) {
        log(`[archive-decisions] SKIP — ${HOT_REL} not found (this project keeps no ADR file); nothing to check.`);
        return 0;
      }
      logError(`[archive-decisions] ${HOT_REL} not found — nothing to rotate.`);
      return 1;
    }

    const tiers = loadTiers(root, today);
    const usage = (tier, entries = tier.entries) => `${lineCountOf(renderTier(tier, entries))}/${tier.cap}`;
    // Cap checks count the REAL on-disk lines (what the docs cap-validator counts) — a normalized
    // render undercounts a template-shaped file with `---` separators and would false-green.
    const rawUsage = (tier) => (tier.exists ? tier.rawLines : lineCountOf(renderTier(tier, tier.entries)));

    if (flags.check) {
      const over = [];
      for (const tier of [tiers.hot, tiers.warm, tiers.cold]) {
        const lines = rawUsage(tier);
        log(`[archive-decisions] ${tier.rel}: ${lines}/${tier.cap}${tier.exists ? '' : ' (absent — would be created on rotation)'}`);
        if (lines > tier.cap) over.push(tier);
      }
      if (over.length > 0) {
        for (const tier of over) {
          const recovery =
            tier.rel === COLD_REL
              ? 'the COLD tier is exhausted — a cap raise or a new COLD file is a maintainer/agent decision'
              : 'run `node scripts/archive-decisions.mjs` to rotate';
          logError(`[archive-decisions] FAIL: ${tier.rel} is over its cap — ${recovery}.`);
        }
        return 1;
      }
      log('[archive-decisions] OK — every tier is within its cap.');
      return 0;
    }

    const plan = planRotation(tiers);
    // A tier over its cap on RAW lines needs a write even with zero entry moves — normalization
    // (the canonical rendered form) alone brings it back under (the moves loop already ensured
    // the RENDERED result fits; if it did not, moves would be non-empty).
    const normalizeOnly = [tiers.hot, tiers.warm, tiers.cold].filter((tier) => tier.exists && tier.rawLines > tier.cap);
    if (plan.moves.hotToWarm.length === 0 && plan.moves.warmToCold.length === 0 && normalizeOnly.length === 0) {
      log(`[archive-decisions] nothing to rotate — HOT ${usage(tiers.hot)}, WARM ${usage(tiers.warm)}, COLD ${usage(tiers.cold)}.`);
      return 0;
    }
    verifyConservation(
      [tiers.hot.entries, tiers.warm.entries, tiers.cold.entries],
      [plan.hotEntries, plan.warmEntries, plan.coldEntries],
    );

    const summary = {
      hotToWarm: plan.moves.hotToWarm.map((id) => `AD-${id}`),
      warmToCold: plan.moves.warmToCold.map((id) => `AD-${id}`),
      normalizeOnly: normalizeOnly.map((tier) => tier.rel),
      after: {
        hot: usage(tiers.hot, plan.hotEntries),
        warm: usage(tiers.warm, plan.warmEntries),
        cold: usage(tiers.cold, plan.coldEntries),
      },
    };

    if (flags.dryRun) {
      log('[archive-decisions] DRY-RUN — no files will be changed.');
      log(JSON.stringify(summary, null, 2));
      return 0;
    }

    const ranges = { hotEntries: plan.hotEntries, warmEntries: plan.warmEntries, coldEntries: plan.coldEntries };
    const writes = [
      { tier: tiers.hot, entries: plan.hotEntries, kind: 'hot' },
      { tier: tiers.warm, entries: plan.warmEntries, kind: 'warm' },
      { tier: tiers.cold, entries: plan.coldEntries, kind: 'cold' },
    ];
    // A rewrite must never claim success while a tier is STILL over its cap — normalization is
    // not a licence: if the planned rendered result exceeds the budget (a genuinely exhausted
    // COLD is the reachable case — the move loops already bound HOT and WARM), fail LOUD before
    // any write.
    for (const { tier, entries } of writes) {
      const plannedLines = lineCountOf(renderTier(tier, entries));
      if (plannedLines > tier.cap) {
        const recovery =
          tier.rel === COLD_REL
            ? 'the COLD tier is exhausted — a cap raise or a new COLD file is a maintainer/agent decision'
            : 'raise the cap or trim the offending entries (maintainer decision)';
        throw fail(1, `refusing BEFORE any write: ${tier.rel} would still be over its cap after rotation (${plannedLines}/${tier.cap}) — ${recovery}`);
      }
    }
    for (const { tier, entries, kind } of writes) {
      // Never materialize an ABSENT tier that still has nothing to hold — a normalize-only
      // rewrite of HOT must not seed empty WARM/COLD files into a project that never rotated.
      if (!tier.exists && entries.length === 0) continue;
      const updated = {
        ...tier,
        frontmatter: stampLastUpdated(tier.frontmatter, today),
        preamble: updateRangeTokens(tier.preamble, kind, ranges),
      };
      mkdirSync(dirname(tier.path), { recursive: true });
      writeFileSync(tier.path, renderTier(updated, entries), 'utf8');
    }
    // (h) — the write loop completed (a full successful rotation OR a normalize-only rewrite): the
    // docs index is now stale, so regenerate it here (never on --check / --dry-run / the
    // nothing-to-rotate no-op / a pre-write refusal — those return before this point).
    const regen = regenerateIndex(root, today);
    log('[archive-decisions] rotated:');
    log(`  HOT→WARM: ${summary.hotToWarm.join(', ') || '(none)'}`);
    log(`  WARM→COLD: ${summary.warmToCold.join(', ') || '(none)'}`);
    if (summary.normalizeOnly.length > 0 && summary.hotToWarm.length === 0 && summary.warmToCold.length === 0) {
      log(`  normalize-only rewrite (over cap on raw lines, no entry moves): ${summary.normalizeOnly.join(', ')}`);
    }
    log(`  now: HOT ${summary.after.hot} · WARM ${summary.after.warm} · COLD ${summary.after.cold}`);
    if (regen.ok) log('  regenerated docs/ai/index.md (the rotation kept the index fresh)');
    else logError(`[archive-decisions] docs/ai/index.md NOT regenerated — ${regen.detail}`);
    return 0;
  } catch (err) {
    logError(`[archive-decisions] ${err.message}`);
    return err.exitCode ?? 1;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = runCli(process.argv.slice(2));
