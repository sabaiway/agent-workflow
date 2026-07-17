#!/usr/bin/env node
// One-file-per-ADR store for docs/ai/decisions.md (ADRs) — the durable replacement for the retired
// 3-tier cascade (HOT → WARM archive → a single COLD monolith whose cap was raised release after
// release). Every ADR beyond the HOT window becomes its OWN immutable record so no artifact is ever
// O(n) and no cap is ever raised again.
//
// HOT   (docs/ai/decisions.md)          — the active ADR window (newest at the bottom), self-bounding
//                                         under its own frontmatter maxLines.
// STORE (docs/ai/adr/AD-NNN-slug.md)     — one immutable MADR record per archived ADR (frontmatter +
//                                         the verbatim `## AD-NNN — title` block). Retrieval is O(1):
//                                         by id → the deterministic filename glob `AD-NNN-*.md`; by
//                                         topic → grep the flat tree; by lifecycle → the two-way
//                                         supersedes/supersededBy frontmatter + the [[AD-NNN]] chain.
// NAV   (docs/ai/adr/log.md)             — the ONE generated navigator: the currently-governing heads
//                                         (accepted ∧ not-superseded, computed by supersession
//                                         inference across the whole corpus) + a recent window. It
//                                         plateaus at O(governing), never O(cumulative). Not a ledger.
//
// Modes:
//   (default)          rotate: explode the oldest HOT entries beyond the cap into adr/ records, then
//                      regenerate the navigator + docs/ai/index.md (item (h)). Monoliths present → a
//                      LOUD legacy-guard refusal ("run --migrate first"); it never half-explodes.
//   --check            verify HOT cap + adr/ store integrity + the legacy guard + navigator freshness;
//                      exit 1 on any breach. A STATED skip (exit 0) only when NO ADR substrate exists
//                      (neither decisions.md NOR docs/ai/adr/).
//   --migrate          one-time retirement of the 3-tier monoliths → per-file adr/ records. Dry-run by
//                      default (prints the file set + id diff + conservation proof, writes nothing).
//   --migrate --apply  writes a durable pre-delete snapshot, writes the records, rewrites the retained
//                      HOT preamble, and only THEN removes the monoliths — gated on conservation AND
//                      the snapshot. Re-run skips byte-identical records (crash-resumable).
//   --write-navigator  regenerate docs/ai/adr/log.md AND re-trigger the index regen (the authoring /
//                      supersession write-side; the --write-index analog).
//   --dry-run          print the planned rotation move-set, change nothing.
//   --today=YYYY-MM-DD pin the lastUpdated stamp (tests / reproducible runs).
//
// FAIL-LOUD invariants (the Issue-009 lesson — never silently glue an entry to the previous body):
//   • every `## ` heading MUST parse canonically as `## AD-NNN — <title>` (AD-\d{3,}) — a malformed
//     heading is exit 1 naming file:line, never a silent merge;
//   • ADR ids are strictly ascending (NUMERIC, never lexical) within a tier and unique across HOT ∪ adr/;
//   • migration is CONSERVATION-checked before any destructive write: the full multiset
//     {id → sha256(verbatim block)} across the OLD monoliths equals {retained-HOT ∪ written records};
//     a drop / renumber / edited-block / stray adr record fails exit 1 before any remove or overwrite;
//   • a legacy monolith still on disk fails LOUD on default/--check (it is a half-migrated tree).
//
// docs/ai here is git-ignored, so the monoliths were NEVER committed (no VCS recovery) — every
// destructive --migrate --apply writes a durable snapshot to the git dir (uncommittable, the
// review-receipts precedent) BEFORE any delete, with a stated out-of-tree fallback off git.
//
// Dependency-free, Node >= 22. Deployed into a consumer's scripts/ like its siblings.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, '..');

export const HOT_REL = 'docs/ai/decisions.md';
// The retired monolith tiers — still READ during migration (their entries explode into records) and
// still DETECTED by the legacy guard; never written by the new scheme.
export const WARM_REL = 'docs/ai/history/decisions-archive.md';
export const COLD_REL = 'docs/ai/history/decisions-archive-early.md';
export const ADR_DIR_REL = 'docs/ai/adr';
export const NAV_REL = 'docs/ai/adr/log.md';

// A per-record cap (generous vs the largest real ADR ~74 lines; a body over it is a genuine smell) and
// the navigator cap (bounded — exceeding it is the future plateau-shard trigger, Decision 8).
export const RECORD_CAP = 400;
export const NAV_MAXLINES = 200;
// How many most-recent ids the navigator's recent window carries (status-annotated, incl. supersessions).
const NAV_RECENT_WINDOW = 15;

// AD-\d{3,}: 3-digit ids stay valid, AD-1000+ parse; ordering is always NUMERIC (never lexical).
export const HEADING_RE = /^## AD-(\d{3,}) — (.+)$/;
const ANY_H2_RE = /^## /;
const FRONTMATTER_RE = /^(---\n[\s\S]*?\n---\n)/;
const RECORD_FILE_RE = /^AD-(\d{3,})-.*\.md$/;

export const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

// ── parsing (strict; malformed headings are LOUD) + lifecycle extraction ───────────────

const stripTrailingSeparators = (blockLines) => {
  const lines = [...blockLines];
  while (lines.length > 0 && (lines[lines.length - 1].trim() === '' || lines[lines.length - 1].trim() === '---')) {
    lines.pop();
  }
  return lines;
};

// Lifecycle from the real corpus body forms (Decision 9), the block preserved VERBATIM:
//   • status = the leading word of `**Status:**` (lowercased); the marker may be on its own line OR
//     same-line after `**Date:** … · **Status:** …`, and its prose may wrap. A MISSING status line →
//     `accepted` (the in-force default; 6 of 9 active HOT ADRs carry no status line). An unknown
//     leading word is kept verbatim (never coerced) — governance keys on the exact 'accepted' token.
//   • date   = the `**Date:**` value up to a ` · ` separator or end of line (null when absent).
//   • supersedes  ← every `Supersedes [[AD-NNN]]`.
//   • supersededBy ← every `Superseded by [[AD-NNN]]` / `Amended by [[AD-NNN]]`.
const extractLifecycle = (block) => {
  const statusMatch = block.match(/\*\*Status:\*\*\s*([^\n]*)/);
  let status = 'accepted';
  if (statusMatch) {
    const word = (statusMatch[1].trim().match(/^[A-Za-z]+/) || [''])[0].toLowerCase();
    if (word) status = word;
  }
  const dateMatch = block.match(/\*\*Date:\*\*\s*([^\n·]*)/);
  const date = dateMatch ? dateMatch[1].trim() || null : null;
  const idsFrom = (re) => {
    const out = [];
    let m;
    const g = new RegExp(re.source, 'g');
    while ((m = g.exec(block)) !== null) out.push(m[1]);
    return out;
  };
  const supersedes = idsFrom(/Supersedes \[\[AD-(\d{3,})\]\]/);
  const supersededBy = [
    ...idsFrom(/Superseded by \[\[AD-(\d{3,})\]\]/),
    ...idsFrom(/Amended by \[\[AD-(\d{3,})\]\]/),
  ];
  return { status, date, supersedes, supersededBy };
};

// Parse one tier's text → { frontmatter, cap, preamble, entries }. Every `## ` line must be a
// canonical AD heading — anything else is exit 1 naming file:line (Issue-009).
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
        `${label}:${fmLines + i + 1}: non-canonical H2 heading "${line}" — every "## " heading must be \`## AD-NNN — <title>\` (AD-\\d{3,}; never silently glued to the previous entry; fix the heading, then re-run)`,
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
    const block = blockLines.join('\n');
    return {
      id: m[1],
      idNum: Number(m[1]),
      title: m[2],
      block,
      lineCount: blockLines.length,
      ...extractLifecycle(block),
    };
  });

  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i].idNum <= entries[i - 1].idNum) {
      throw fail(
        1,
        `${label}: AD-${entries[i].id} appears after AD-${entries[i - 1].id} — ids must be strictly ascending (numeric) within a tier (oldest at the top); refusing to rotate a disordered file`,
      );
    }
  }

  const capMatch = frontmatter.match(/^maxLines:\s*(\d+)\s*$/m);
  return { frontmatter, cap: capMatch ? Number(capMatch[1]) : null, preamble, entries };
};

// ── slug + record rendering (frontmatter built INLINE, Decision 1 — no runtime template read) ──

const SLUG_MAX = 60;

export const slugify = (title) => {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length <= SLUG_MAX) return base || 'record';
  const cut = base.slice(0, SLUG_MAX);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut) || 'record';
};

export const recordFileName = (id, slug) => `AD-${id}-${slug}.md`;

const yamlIdList = (ids) => (ids.length > 0 ? `[${ids.map((id) => `AD-${id}`).join(', ')}]` : '[]');

// The record's 6-field frontmatter + the 4 lifecycle keys (Decision 1). Ends with `---\n` like the
// sibling CREATED_FRONTMATTER pattern; the block follows after one blank line.
export const buildRecordFrontmatter = (entry, today) =>
  [
    '---',
    'type: adr',
    `lastUpdated: ${today}`,
    'scope: permanent',
    'staleAfter: never',
    'owner: none',
    `maxLines: ${RECORD_CAP}`,
    `status: ${entry.status}`,
    `date: ${entry.date ?? 'unknown'}`,
    `supersedes: ${yamlIdList(entry.supersedes)}`,
    `supersededBy: ${yamlIdList(entry.supersededBy)}`,
    '---',
    '',
  ].join('\n');

export const renderRecord = (record) => `${record.frontmatter}\n${record.block}\n`;

// explode entries → immutable records (id, slug, filename, frontmatter, verbatim block).
export const explode = (entries, today) =>
  entries.map((entry) => {
    const slug = slugify(entry.title);
    return {
      id: entry.id,
      idNum: entry.idNum,
      slug,
      fileName: recordFileName(entry.id, slug),
      frontmatter: buildRecordFrontmatter(entry, today),
      block: entry.block,
    };
  });

// ── conservation (fail-loud, partition-preserving, extra-aware — Decision 4) ────────────

export const blockHash = (block) => createHash('sha256').update(block, 'utf8').digest('hex');

const multiset = (items) => {
  const map = new Map();
  for (const { id, block } of items) {
    if (map.has(id)) throw fail(1, `conservation: AD-${id} appears twice on the same side — a duplicate id (no double-count allowed)`);
    map.set(id, blockHash(block));
  }
  return map;
};

// OLD = every block across the migrated tiers; NEW = retained-HOT ∪ written record bodies. Every OLD
// id must appear exactly once on the NEW side with a byte-identical block; a NEW id absent from OLD is
// a stray (crashed-run remnant / invented history) → refuse. No loss, no double-count, no edit.
export const verifyConservation = (oldItems, newItems) => {
  const before = multiset(oldItems);
  const after = multiset(newItems);
  for (const [id, hash] of before) {
    if (!after.has(id)) throw fail(1, `conservation violation: AD-${id} is present in the OLD tiers but absent from the migrated store — refusing to write (an ADR would be lost)`);
    if (after.get(id) !== hash) throw fail(1, `conservation violation: AD-${id}'s block changed during migration (hash mismatch) — the block must move verbatim; refusing to write`);
  }
  for (const id of after.keys()) {
    if (!before.has(id)) throw fail(1, `conservation violation: AD-${id} is present in the migrated store but NOT in the OLD tiers — a stray/invented record; refuse or quarantine it, then re-run`);
  }
};

// ── tier / store IO ─────────────────────────────────────────────────────────────────────

export const lineCountOf = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

export const loadHot = (root) => {
  const path = resolve(root, HOT_REL);
  const raw = readFileSync(path, 'utf8');
  const parsed = parseDecisionsText(raw, HOT_REL);
  if (parsed.cap === null) {
    throw fail(1, `${HOT_REL}: frontmatter carries no maxLines cap — refusing to operate against an unknown budget (add a maxLines field to the frontmatter)`);
  }
  return { rel: HOT_REL, path, raw, rawLines: lineCountOf(raw), ...parsed };
};

const loadMonolith = (root, rel) => {
  const path = resolve(root, rel);
  if (!existsSync(path)) return { rel, path, exists: false, entries: [] };
  const raw = readFileSync(path, 'utf8');
  const parsed = parseDecisionsText(raw, rel);
  return { rel, path, exists: true, raw, ...parsed };
};

export const monolithsPresent = (root) =>
  [WARM_REL, COLD_REL].filter((rel) => existsSync(resolve(root, rel)));

export const NAV_BASENAME = 'log.md';

// Read the immutable adr/ store → one entry per AD-NNN-slug.md record (the navigator log.md
// excluded). Any UNEXPECTED markdown file in the tree is a LOUD integrity failure — never silently
// dropped from the store (the collapse would otherwise hide it from both navigator and index). The
// heading id must match the filename id.
export const loadAdrStore = (root) => {
  const dir = resolve(root, ADR_DIR_REL);
  if (!existsSync(dir)) return [];
  const records = [];
  const seenIds = new Map(); // the ROOT store invariant: exactly one file per id (never a silent dup)
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = entry.name;
    if (entry.isDirectory()) {
      throw fail(1, `${ADR_DIR_REL}/${name}/: the adr/ store is a FLAT directory — a nested subdirectory would hide records from the navigator + integrity checks; remove it, then re-run`);
    }
    if (name === NAV_BASENAME) continue; // the navigator, not a record
    if (!RECORD_FILE_RE.test(name)) {
      if (name.endsWith('.md')) {
        throw fail(1, `${ADR_DIR_REL}/${name}: unexpected markdown file in the adr/ store — only the navigator ${NAV_BASENAME} and AD-NNN-slug.md records belong here; rename/remove it, then re-run (never silently hidden)`);
      }
      continue; // a non-markdown stray is ignored by the ADR store (and by the cap-validator)
    }
    const rel = `${ADR_DIR_REL}/${name}`;
    const parsed = parseDecisionsText(readFileSync(resolve(dir, name), 'utf8'), rel);
    if (parsed.entries.length !== 1) {
      throw fail(1, `${rel}: an adr/ record must hold exactly one ADR block (found ${parsed.entries.length}); refusing to treat it as a record`);
    }
    const record = parsed.entries[0];
    const fnId = name.match(RECORD_FILE_RE)[1];
    if (fnId !== record.id) {
      throw fail(1, `${rel}: filename id AD-${fnId} does not match the heading id AD-${record.id} — a corrupt/renamed record; refusing to trust it`);
    }
    // Fail LOUD at the SOURCE on a duplicate id (two files for one AD-NNN) so no caller ever operates
    // on — or silently dedups away — a corrupt store (rotate/migrate/navigator/check all read here).
    if (seenIds.has(record.id)) {
      throw fail(1, `${ADR_DIR_REL}/: two records for AD-${record.id} (${seenIds.get(record.id)} and ${name}) — the store must hold exactly one file per id; remove the stale one, then re-run`);
    }
    seenIds.set(record.id, name);
    records.push({ ...record, fileName: name, rel });
  }
  return records;
};

// ── HOT rendering + preamble rewrite (Decision 15) ──────────────────────────────────────

export const renderTier = (frontmatter, preamble, entries) => {
  const blocks = entries.map((entry) => entry.block).join('\n\n');
  const body = [preamble, blocks].filter((part) => part !== '').join('\n\n');
  return `${frontmatter}\n${body}\n`;
};

const NEW_ARCHIVE_LINE = (oldestId) =>
  `> **Archive:** older ADRs are stored one file per record under [\`adr/\`](./adr/) — see the active-set ` +
  `navigator [\`adr/log.md\`](./adr/log.md). This file carries the active window (AD-${oldestId} onward).`;

// Repoint the retained HOT preamble at the navigator and DROP the dead monolith links/"rolled to
// COLD" prose (Decision 15 — not just a range re-stamp). Any line that is the `**Archive:**` marker
// OR names a retired monolith is dropped; the FIRST such line is replaced by the navigator pointer.
// A preamble that never mentioned the archive is left untouched (a consumer's own wording preserved).
// Assumes the archive prose is one logical blockquote line (the shipped shape); a hand-wrapped
// continuation line carrying NEITHER marker is left in place (a stated, benign residual).
export const rewriteHotPreamble = (preamble, oldestId) => {
  const isArchiveLine = (line) => /decisions-archive/.test(line) || /\*\*Archive:\*\*/.test(line);
  const out = [];
  let replaced = false;
  for (const line of preamble.split('\n')) {
    if (isArchiveLine(line)) {
      if (!replaced) {
        out.push(NEW_ARCHIVE_LINE(oldestId));
        replaced = true;
      }
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
};

const stampLastUpdated = (frontmatter, today) => frontmatter.replace(/^lastUpdated: .*$/m, `lastUpdated: ${today}`);

// ── the deterministic HOT-bounding plan (oldest-out until the render fits its cap) ──────

export const boundHot = (candidates, frontmatter, preamble, cap) => {
  const retained = [...candidates].sort((a, b) => a.idNum - b.idNum);
  const toExplode = [];
  while (retained.length > 1 && lineCountOf(renderTier(frontmatter, preamble, retained)) > cap) {
    toExplode.unshift(retained.shift());
  }
  return { retained, toExplode };
};

// ── navigator generation (governance COMPUTED by supersession inference — Decision 8) ───

// The set of ids superseded BY ANOTHER ADR: an entry's own `Superseded by / Amended by [[X]]`
// declaration retires that entry, and an IN-FORCE (accepted) entry's `Supersedes [[Y]]` retires Y
// — so a new superseding ADR needs NO predecessor-file mutation. A Supersedes edge from a NON-accepted
// entry (proposed/rejected/superseded) is NOT effective and never retires its target.
export const IN_FORCE_STATUS = 'accepted';

export const computeSupersededSet = (entries) => {
  const superseded = new Set();
  for (const entry of entries) {
    if (entry.supersededBy.length > 0) superseded.add(entry.id);
    if (entry.status === IN_FORCE_STATUS) {
      for (const id of entry.supersedes) superseded.add(id);
    }
  }
  return superseded;
};

// Governing heads = in-force (accepted) AND not superseded by another. A non-accepted status
// (proposed/rejected/superseded/amended/deprecated) is never a governing head.
export const computeGoverningIds = (entries) => {
  const superseded = computeSupersededSet(entries);
  return new Set(entries.filter((e) => e.status === IN_FORCE_STATUS && !superseded.has(e.id)).map((e) => e.id));
};

const NAV_FRONTMATTER = (today) =>
  `---\ntype: reference\nlastUpdated: ${today}\nscope: permanent\nstaleAfter: never\nowner: none\nmaxLines: ${NAV_MAXLINES}\n---\n`;

// Build docs/ai/adr/log.md from the WHOLE corpus (HOT entries ∪ adr/ records). Governing heads
// (accepted ∧ not-superseded) sorted newest-first; superseded ADRs drop OUT (still reachable by
// filename/grep/chain) so the navigator plateaus at O(governing). A recent window follows, status-
// annotated, so recent supersessions stay visible. On-demand (type: reference), never a full ledger.
export const buildNavigator = (corpus, today) => {
  const entries = [...corpus].sort((a, b) => a.idNum - b.idNum);
  const superseded = computeSupersededSet(entries);
  const governingIds = computeGoverningIds(entries);
  const governing = entries.filter((entry) => governingIds.has(entry.id));
  const govLines = [...governing]
    .reverse()
    .map((entry) => {
      const where = entry.fileName ? `[\`${entry.fileName}\`](./${entry.fileName})` : `[\`../decisions.md\`](../decisions.md)`;
      return `| AD-${entry.id} | ${entry.title.replace(/\|/g, '\\|')} | ${where} |`;
    });
  const recent = [...entries].slice(-NAV_RECENT_WINDOW).reverse().map((entry) => {
    const state = governingIds.has(entry.id) ? 'governing' : superseded.has(entry.id) ? 'superseded' : entry.status;
    const where = entry.fileName ? `adr/${entry.fileName}` : 'decisions.md (HOT)';
    return `- **AD-${entry.id}** — ${state} — \`${where}\``;
  });
  const oldestId = entries.length > 0 ? entries[0].id : '000';
  const newestId = entries.length > 0 ? entries[entries.length - 1].id : '000';
  const body = [
    `# ADR Navigator — active set (AD-${oldestId} … AD-${newestId})`,
    '',
    '> **Auto-generated** (`archive-decisions.mjs --write-navigator`). The governing heads only —',
    '> an ADR superseded/amended by another drops OUT (still reachable by filename, grep, or the',
    `> \`[[AD-NNN]]\` chain). The HOT window lives in [\`../decisions.md\`](../decisions.md); every`,
    '> archived record is one file in this directory. This is a navigator, never a full ledger.',
    '',
    `## Governing (${governing.length}) — accepted & not superseded`,
    '',
    '| ADR | Title | Record |',
    '|-----|-------|--------|',
    ...govLines,
    '',
    `## Recent (${Math.min(NAV_RECENT_WINDOW, entries.length)})`,
    '',
    ...recent,
  ].join('\n');
  return `${NAV_FRONTMATTER(today)}\n${body}\n`;
};

// ── snapshot (durable, pre-delete — Decision 5) ─────────────────────────────────────────

const SNAPSHOT_PREFIX = 'agent-workflow-adr-migration-snapshot';

const resolveGitDir = (root, spawn) => {
  const r = spawn('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, encoding: 'utf8' });
  return r && r.status === 0 && r.stdout ? r.stdout.trim() : null;
};

// Snapshot the docs the migration is about to destroy (decisions.md + both monoliths) into the git
// dir (uncommittable — never in the work tree, never stageable). Off git → a stated tmpdir fallback;
// fails LOUD if neither base is writable. Returns { dir, base } for the caller to report.
export const writeSnapshot = (root, files, deps = {}) => {
  const spawn = deps.spawnSync ?? spawnSync;
  const stamp = deps.stamp ?? `${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const fallbackBase = deps.snapshotFallbackBase ?? tmpdir();
  const gitDir = resolveGitDir(root, spawn);
  const bases = gitDir ? [gitDir, fallbackBase] : [fallbackBase];
  let lastErr = null;
  for (const base of bases) {
    const dir = resolve(base, `${SNAPSHOT_PREFIX}-${stamp}`);
    try {
      mkdirSync(dir, { recursive: true });
      for (const { rel, content } of files) {
        writeFileSync(resolve(dir, rel.replace(/\//g, '__')), content, 'utf8');
      }
      return { dir, base, viaGitDir: base === gitDir };
    } catch (err) {
      lastErr = err;
    }
  }
  throw fail(1, `refusing to migrate: no writable snapshot location (git dir + fallback both failed: ${lastErr && lastErr.message}) — a durable pre-delete snapshot is mandatory`);
};

// ── index regeneration (item (h) — reuse the ONE generator in check-docs-size.mjs) ──────

const CHECK_DOCS_SIBLING = resolve(__dirname, 'check-docs-size.mjs');
const INDEX_INSTRUCT = 'run `node scripts/check-docs-size.mjs --write-index` to refresh docs/ai/index.md';

export const defaultRegenerateIndex = (root, today, deps = {}) => {
  const exists = deps.existsSync ?? existsSync;
  const spawn = deps.spawnSync ?? spawnSync;
  const sibling = deps.sibling ?? CHECK_DOCS_SIBLING;
  if (!exists(sibling)) {
    return { ok: false, detail: `the index generator is not beside this script — ${INDEX_INSTRUCT}` };
  }
  const r = spawn(process.execPath, [sibling, '--write-index', '--report', `--root=${root}`, `--today=${today}`], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    return { ok: false, detail: `index regeneration failed (${(r.error && r.error.message) || `exit ${r.status}`}) — ${INDEX_INSTRUCT}` };
  }
  return { ok: true, detail: (r.stdout || '').trim() };
};

// ── shared store-write helpers ──────────────────────────────────────────────────────────

const writeRecords = (root, records) => {
  const dir = resolve(root, ADR_DIR_REL);
  mkdirSync(dir, { recursive: true });
  // Index the existing filenames by id ONCE (O(store), not O(records × store)) so a stale same-id
  // file under a DIVERGENT slug (a retitled or prior-run remnant) can be pruned — exactly one file
  // per id survives, the canonical slug wins.
  const existingById = new Map();
  for (const name of readdirSync(dir)) {
    const m = name.match(RECORD_FILE_RE);
    if (!m) continue;
    const arr = existingById.get(m[1]);
    if (arr) arr.push(name);
    else existingById.set(m[1], [name]);
  }
  let written = 0;
  let skipped = 0;
  for (const record of records) {
    for (const name of existingById.get(record.id) ?? []) {
      if (name !== record.fileName) rmSync(resolve(dir, name));
    }
    const path = resolve(dir, record.fileName);
    const body = renderRecord(record);
    if (existsSync(path) && readFileSync(path, 'utf8') === body) {
      skipped += 1; // crash-resumable: a byte-identical record is left as is
      continue;
    }
    writeFileSync(path, body, 'utf8');
    written += 1;
  }
  return { written, skipped };
};

const writeNavigatorFile = (root, corpus, today) => {
  const dir = resolve(root, ADR_DIR_REL);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(root, NAV_REL), buildNavigator(corpus, today), 'utf8');
};

const writeHot = (root, hot, retained, today) => {
  const oldestId = retained.length > 0 ? retained[0].id : hot.entries.length > 0 ? hot.entries[0].id : '000';
  const preamble = rewriteHotPreamble(hot.preamble, oldestId);
  const frontmatter = stampLastUpdated(hot.frontmatter, today);
  writeFileSync(hot.path, renderTier(frontmatter, preamble, retained), 'utf8');
};

// ── CLI ─────────────────────────────────────────────────────────────────────────────────

const USAGE = 'Usage: archive-decisions.mjs [--check|--migrate [--apply]|--write-navigator|--dry-run] [--today=YYYY-MM-DD]';

const parseArgs = (argv) => {
  const flags = { check: false, migrate: false, apply: false, writeNavigator: false, dryRun: false, help: false };
  let today = null;
  for (const arg of argv) {
    if (arg === '--check') flags.check = true;
    else if (arg === '--migrate') flags.migrate = true;
    else if (arg === '--apply') flags.apply = true;
    else if (arg === '--write-navigator') flags.writeNavigator = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('--today=')) today = arg.slice('--today='.length);
    else throw fail(2, `Unknown argument: ${arg}\n${USAGE}`);
  }
  return { flags, today };
};

// Store integrity: HOT ∪ adr/ ids are unique (an ADR lives in exactly one place) AND partitioned —
// every archived record holds a strictly-OLDER (smaller) id than every HOT entry. NUMERIC throughout.
const assertStoreIntegrity = (hotEntries, adrEntries) => {
  const seen = new Map();
  for (const e of [...adrEntries, ...hotEntries]) {
    const where = e.fileName ? `adr/${e.fileName}` : HOT_REL;
    if (seen.has(e.id)) {
      throw fail(1, `duplicate ADR id AD-${e.id} across the store (${seen.get(e.id)} and ${where}) — an ADR must live in exactly one place; refusing`);
    }
    seen.set(e.id, where);
  }
  // The adr/ store is the past, the HOT window is the present; an interleaved id is corruption.
  if (adrEntries.length > 0 && hotEntries.length > 0) {
    const newestAdr = adrEntries.reduce((a, b) => (b.idNum > a.idNum ? b : a));
    const oldestHot = hotEntries.reduce((a, b) => (b.idNum < a.idNum ? b : a));
    if (newestAdr.idNum >= oldestHot.idNum) {
      throw fail(1, `store partition violated: archived AD-${newestAdr.id} (adr/${newestAdr.fileName}) is not older than active AD-${oldestHot.id} (${HOT_REL}) — the adr/ store must hold strictly-older ids than the HOT window; refusing`);
    }
  }
};

const runMigrate = (root, flags, today, deps, log, logError) => {
  const present = monolithsPresent(root);
  const hasHot = existsSync(resolve(root, HOT_REL));
  if (present.length === 0) {
    if (existsSync(resolve(root, ADR_DIR_REL))) {
      log('[archive-decisions] already migrated — no legacy monolith present; nothing to do.');
      return 0;
    }
    log('[archive-decisions] nothing to migrate — no legacy decisions-archive monolith found.');
    return 0;
  }
  if (!hasHot) throw fail(1, `${HOT_REL} not found but a legacy monolith is present — a broken tree; restore ${HOT_REL} before migrating.`);

  const hot = loadHot(root);
  const warm = loadMonolith(root, WARM_REL);
  const cold = loadMonolith(root, COLD_REL);
  const existingStore = loadAdrStore(root);

  // Build the FULL ADR corpus as the UNION of every CURRENT source (HOT ∪ monoliths ∪ adr/ store),
  // keyed by id — the crash-safe / idempotent core (internal-sweep major). The destructive apply
  // trims HOT and deletes the monoliths NON-atomically, so on a resume a source may be gone while
  // its already-written adr record survives; deriving the corpus from the union (not just the
  // surviving monoliths + trimmed HOT) means a re-run reconstructs the SAME corpus and repartitions
  // to the SAME target — it never accuses its own correct records of being "invented history".
  // An id in two sources MUST carry a byte-identical block (else a corrupt / hand-edited resume
  // artifact → FAIL before any write, never silently overwritten).
  const corpusById = new Map();
  const addEntry = (entry, where) => {
    const seen = corpusById.get(entry.id);
    if (seen) {
      if (seen.block !== entry.block) {
        throw fail(1, `AD-${entry.id} appears in ${seen.where} and ${where} with DIFFERENT bodies — a corrupt or hand-edited store/resume artifact; resolve it by hand, refusing to migrate`);
      }
      return;
    }
    corpusById.set(entry.id, { ...entry, where });
  };
  for (const entry of [...warm.entries, ...cold.entries]) addEntry(entry, 'a legacy monolith');
  for (const entry of hot.entries) addEntry(entry, HOT_REL);
  for (const entry of existingStore) addEntry(entry, entry.rel);
  const allEntries = [...corpusById.values()].sort((a, b) => a.idNum - b.idNum);

  // Retain the bounded CURRENT HOT window (never repopulated from archived entries); everything else
  // in the corpus becomes an adr/ record. The preamble is rewritten first so the cap arithmetic
  // reflects the post-migration (shorter) preamble.
  const provisionalOldest = hot.entries.length > 0 ? hot.entries[0].id : allEntries.length > 0 ? allEntries[0].id : '000';
  const rewrittenPreamble = rewriteHotPreamble(hot.preamble, provisionalOldest);
  const { retained } = boundHot(hot.entries, hot.frontmatter, rewrittenPreamble, hot.cap ?? Infinity);
  const retainedIds = new Set(retained.map((e) => e.id));
  const toExplode = allEntries.filter((e) => !retainedIds.has(e.id));
  const records = explode(toExplode, today);

  // Conservation: a PURE repartition of the corpus — retained-HOT ∪ written records == the corpus,
  // nothing lost, added, double-counted, or edited.
  const oldItems = allEntries.map((e) => ({ id: e.id, block: e.block }));
  const newItems = [
    ...retained.map((e) => ({ id: e.id, block: e.block })),
    ...records.map((r) => ({ id: r.id, block: r.block })),
  ];
  verifyConservation(oldItems, newItems);
  // Integrity over the FULL final store — existing records ∪ freshly-exploded — not just the new
  // writes: a pre-existing adr/ record whose id also stays RETAINED in HOT would otherwise leave the
  // ADR in two places (codex R4). Same full-store pattern as runRotate.
  const finalStoreById = new Map(existingStore.map((e) => [e.id, { id: e.id, idNum: e.idNum, fileName: e.fileName }]));
  for (const r of records) finalStoreById.set(r.id, { id: r.id, idNum: r.idNum, fileName: r.fileName });
  assertStoreIntegrity(retained, [...finalStoreById.values()]);

  const summary = {
    records: records.map((r) => r.fileName),
    retainedHot: retained.map((e) => `AD-${e.id}`),
    monolithsRetired: present,
    conservation: `${oldItems.length} corpus blocks → ${retained.length} retained-HOT + ${records.length} records (conserved)`,
  };

  if (!flags.apply) {
    log('[archive-decisions] --migrate DRY-RUN — no files will be changed.');
    log(JSON.stringify(summary, null, 2));
    return 0;
  }

  const snapshotFiles = [
    { rel: HOT_REL, content: hot.raw },
    ...(warm.exists ? [{ rel: WARM_REL, content: warm.raw }] : []),
    ...(cold.exists ? [{ rel: COLD_REL, content: cold.raw }] : []),
  ];
  const snapshot = writeSnapshot(root, snapshotFiles, deps);

  writeRecords(root, records);
  const corpus = [...retained, ...loadAdrStore(root)];
  writeNavigatorFile(root, corpus, today);
  writeHot(root, hot, retained, today);
  // Only NOW — conservation passed AND the snapshot exists — remove the monoliths.
  for (const rel of present) rmSync(resolve(root, rel));

  const regen = (deps.regenerateIndex ?? defaultRegenerateIndex)(root, today);
  log('[archive-decisions] migrated the 3-tier cascade → one-file-per-ADR store:');
  log(`  snapshot: ${snapshot.dir} (${snapshot.viaGitDir ? 'git dir' : 'out-of-tree fallback'})`);
  log(`  records written: ${records.length} under ${ADR_DIR_REL}/`);
  log(`  retained HOT: ${summary.retainedHot.join(', ') || '(none)'}`);
  log(`  retired monoliths: ${present.join(', ')}`);
  log(`  navigator: ${NAV_REL}`);
  if (regen.ok) log('  regenerated docs/ai/index.md');
  else logError(`[archive-decisions] docs/ai/index.md NOT regenerated — ${regen.detail}`);
  return 0;
};

const runWriteNavigator = (root, today, deps, log, logError) => {
  if (!existsSync(resolve(root, HOT_REL)) && !existsSync(resolve(root, ADR_DIR_REL))) {
    log(`[archive-decisions] SKIP — no ADR substrate (neither ${HOT_REL} nor ${ADR_DIR_REL}); nothing to write.`);
    return 0;
  }
  const present = monolithsPresent(root);
  if (present.length > 0) throw fail(1, `${present.join(', ')} present — a half-migrated tree; run \`--migrate\` first before regenerating the navigator.`);
  const hotEntries = existsSync(resolve(root, HOT_REL)) ? loadHot(root).entries : [];
  const adrEntries = loadAdrStore(root);
  assertStoreIntegrity(hotEntries, adrEntries); // never emit a duplicate-row / corrupt navigator
  const corpus = [...hotEntries, ...adrEntries];
  writeNavigatorFile(root, corpus, today);
  const regen = (deps.regenerateIndex ?? defaultRegenerateIndex)(root, today);
  log(`[archive-decisions] wrote ${NAV_REL} (${corpus.length} ADRs in the corpus).`);
  if (regen.ok) log('  regenerated docs/ai/index.md');
  else logError(`[archive-decisions] docs/ai/index.md NOT regenerated — ${regen.detail}`);
  return 0;
};

// Reuse the on-disk navigator's OWN lastUpdated for the freshness diff so a mere day-rollover (no
// corpus change) is never flagged — only genuine drift makes it stale (the --check-index precedent).
const navLastUpdated = (text) => {
  const m = text.match(/^lastUpdated:\s*(.*)$/m);
  return m ? m[1].trim() : 'unknown';
};

const runCheck = (root, today, log, logError) => {
  const hasHot = existsSync(resolve(root, HOT_REL));
  const hasStore = existsSync(resolve(root, ADR_DIR_REL));
  // The legacy guard runs BEFORE the substrate-absent skip: a lone monolith (HOT and adr/ both
  // absent) is a half-migrated / half-deleted tree, never a clean "no substrate" skip.
  const present = monolithsPresent(root);
  if (present.length > 0) {
    logError(`[archive-decisions] FAIL: legacy monolith present (${present.join(', ')}) — the ADR store is half-migrated; run \`node scripts/archive-decisions.mjs --migrate --apply\` first.`);
    return 1;
  }
  if (!hasHot && !hasStore) {
    log(`[archive-decisions] SKIP — no ADR substrate (neither ${HOT_REL} nor ${ADR_DIR_REL}); nothing to check.`);
    return 0;
  }
  const hot = hasHot ? loadHot(root) : null;
  const adrEntries = loadAdrStore(root);
  const hotEntries = hot ? hot.entries : [];
  assertStoreIntegrity(hotEntries, adrEntries);

  const problems = [];
  if (hot) {
    log(`[archive-decisions] ${HOT_REL}: ${hot.rawLines}/${hot.cap}`);
    if (hot.cap !== null && hot.rawLines > hot.cap) problems.push(`${HOT_REL} is over its cap (${hot.rawLines}/${hot.cap}) — run \`node scripts/archive-decisions.mjs\` to explode the oldest entries`);
  }
  log(`[archive-decisions] ${ADR_DIR_REL}: ${adrEntries.length} record(s)`);

  // Navigator freshness: regenerate in memory and diff against on-disk (the folded --check that never
  // false-blocks — --write-navigator is the deterministic fix).
  const navPath = resolve(root, NAV_REL);
  const corpus = [...hotEntries, ...adrEntries];
  const expected = buildNavigator(corpus, existsSync(navPath) ? navLastUpdated(readFileSync(navPath, 'utf8')) : today);
  const onDisk = existsSync(navPath) ? readFileSync(navPath, 'utf8') : null;
  if (onDisk !== expected) {
    problems.push(`${NAV_REL} is stale (out of sync with the ADR corpus) — run \`node scripts/archive-decisions.mjs --write-navigator\` and commit it`);
  }

  if (problems.length > 0) {
    for (const p of problems) logError(`[archive-decisions] FAIL: ${p}.`);
    return 1;
  }
  log('[archive-decisions] OK — HOT within cap, store integrity intact, navigator fresh.');
  return 0;
};

const runRotate = (root, flags, today, deps, log, logError) => {
  const present = monolithsPresent(root);
  if (present.length > 0) {
    logError(`[archive-decisions] FAIL: legacy monolith present (${present.join(', ')}) — the ADR store is half-migrated; run \`node scripts/archive-decisions.mjs --migrate --apply\` first (a default rotate never half-explodes).`);
    return 1;
  }
  const hot = loadHot(root);
  const existingStore = loadAdrStore(root);
  const { retained, toExplode } = boundHot(hot.entries, hot.frontmatter, hot.preamble, hot.cap ?? Infinity);
  if (toExplode.length === 0 && hot.rawLines <= (hot.cap ?? Infinity)) {
    assertStoreIntegrity(hot.entries, existingStore); // a no-op still refuses a corrupt store (dup / partition)
    log(`[archive-decisions] nothing to rotate — HOT ${hot.rawLines}/${hot.cap}, ${existingStore.length} archived record(s).`);
    return 0;
  }
  const rewrittenPreamble = rewriteHotPreamble(hot.preamble, retained.length > 0 ? retained[0].id : '000');
  if (hot.cap !== null && lineCountOf(renderTier(hot.frontmatter, rewrittenPreamble, retained)) > hot.cap) {
    throw fail(1, `${HOT_REL} is over its cap but cannot be reduced (the newest entry alone exceeds ${hot.cap} lines) — trim it or raise the cap (a maintainer decision; this script only moves entries).`);
  }

  const records = explode(toExplode, today);
  // Crash-resume (fold-induced, codex R2): a record from a prior crashed rotate may already be on
  // disk. A byte-identical one is done (deduped, not a duplicate-id error); a divergent-body one is
  // corrupt → FAIL. The FINAL store = existing ∪ freshly-exploded, deduped by id.
  const existingById = new Map(existingStore.map((e) => [e.id, e]));
  for (const rec of records) {
    const ex = existingById.get(rec.id);
    if (ex && ex.block !== rec.block) {
      throw fail(1, `${ex.rel}: the existing adr/ record for AD-${rec.id} diverges from the freshly-exploded block — a corrupt or hand-edited crash-resume artifact; resolve it by hand, refusing to overwrite`);
    }
  }
  const finalStoreById = new Map(existingStore.map((e) => [e.id, { id: e.id, idNum: e.idNum, fileName: e.fileName }]));
  for (const rec of records) finalStoreById.set(rec.id, { id: rec.id, idNum: rec.idNum, fileName: rec.fileName });
  assertStoreIntegrity(retained, [...finalStoreById.values()]);

  const summary = { explode: records.map((r) => r.fileName), retainedHot: retained.map((e) => `AD-${e.id}`) };
  if (flags.dryRun) {
    log('[archive-decisions] DRY-RUN — no files will be changed.');
    log(JSON.stringify(summary, null, 2));
    return 0;
  }

  writeRecords(root, records);
  const corpus = [...retained, ...loadAdrStore(root)];
  writeNavigatorFile(root, corpus, today);
  writeHot(root, hot, retained, today);
  const regen = (deps.regenerateIndex ?? defaultRegenerateIndex)(root, today);
  log('[archive-decisions] rotated:');
  log(`  exploded to adr/: ${summary.explode.join(', ') || '(none)'}`);
  log(`  retained HOT: ${summary.retainedHot.join(', ')}`);
  if (regen.ok) log('  regenerated docs/ai/index.md');
  else logError(`[archive-decisions] docs/ai/index.md NOT regenerated — ${regen.detail}`);
  return 0;
};

export const runCli = (argv, deps = {}) => {
  const { root = DEFAULT_ROOT, log = console.log, logError = console.error } = deps;
  try {
    const { flags, today: todayOpt } = parseArgs(argv);
    if (flags.help) {
      log(USAGE);
      return 0;
    }
    const today = todayOpt ?? new Date().toISOString().slice(0, 10);

    if (flags.migrate) return runMigrate(root, flags, today, deps, log, logError);
    if (flags.writeNavigator) return runWriteNavigator(root, today, deps, log, logError);
    if (flags.check) return runCheck(root, today, log, logError);

    if (!existsSync(resolve(root, HOT_REL))) {
      logError(`[archive-decisions] ${HOT_REL} not found — nothing to rotate.`);
      return 1;
    }
    return runRotate(root, flags, today, deps, log, logError);
  } catch (err) {
    logError(`[archive-decisions] ${err.message}`);
    return err.exitCode ?? 1;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = runCli(process.argv.slice(2));
