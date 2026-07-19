import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOT_REL,
  WARM_REL,
  COLD_REL,
  ADR_DIR_REL,
  NAV_REL,
  HEADING_RE,
  RECORD_CAP,
  parseDecisionsText,
  slugify,
  recordFileName,
  explode,
  blockHash,
  verifyConservation,
  computeSupersededSet,
  buildNavigator,
  loadAdrStore,
  lineCountOf,
  runCli,
  defaultRegenerateIndex,
} from './archive-decisions.mjs';

// Hermetic: this test ships as deploy payload and runs inside CONSUMER repos via the pre-commit
// `node --test scripts/*.test.mjs` — it must never read the host repo's docs/ai. Every fixture lives
// in a fresh temp root; the index-regen hook + the git-dir snapshot are always injected.

const tempDirs = [];
const makeRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-decisions-'));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

const fm = (cap) =>
  `---\ntype: reference\nlastUpdated: 2026-01-01\nscope: permanent\nstaleAfter: never\nowner: none\nmaxLines: ${cap}\n---\n`;

// One canonical ADR block. `status: null` omits the status line (the 6-of-9-active default case);
// `separate: true` writes Date and Status on their own lines (the AD-001/AD-043 shape).
const adrBlock = (id, { title = `Decision ${id}`, date = '2026-01-01', status = 'Accepted', body = 2, separate = false } = {}) => {
  const lines = [`## AD-${id} — ${title}`, ''];
  if (separate) {
    if (date) lines.push(`**Date:** ${date}`);
    if (status) lines.push(`**Status:** ${status}`);
  } else if (date || status) {
    lines.push(`**Date:** ${date}${status ? ` · **Status:** ${status}` : ''}`);
  }
  lines.push('');
  for (let i = 0; i < body; i += 1) lines.push(`body ${i + 1} of AD-${id}`);
  return lines.join('\n');
};

const tierText = (cap, preamble, blocks) => `${fm(cap)}\n${preamble}\n\n${blocks.join('\n\n')}\n`;

const HOT_PREAMBLE = [
  '# Architecture Decision Records (ADRs)',
  '',
  '> Newest at the bottom. Link related ADRs with `[[AD-XXX]]`.',
  '>',
  '> **Archive:** the stable **AD-003 … AD-004** now live in [`history/decisions-archive.md`](./history/decisions-archive.md) (the earliest **AD-001 … AD-002** rolled further to the COLD [`history/decisions-archive-early.md`](./history/decisions-archive-early.md)); this file carries the active set (AD-005 onward).',
].join('\n');
const WARM_PREAMBLE = '# ADR Archive (AD-003 … AD-004)\n\n> WARM tier.';
const COLD_PREAMBLE = '# ADR Early Archive (AD-001 … AD-002)\n\n> COLD tier.';

// Seed a legacy 3-tier tree (pre-migration). Caps generous so nothing overflows unless asked.
const seedLegacy = (root, { hot, warm = [], cold = [], hotCapDelta = 200 }) => {
  mkdirSync(join(root, 'docs', 'ai', 'history'), { recursive: true });
  const writeTier = (rel, preamble, blocks, capDelta) => {
    const probe = tierText(9999, preamble, blocks);
    const cap = lineCountOf(probe) + capDelta;
    writeFileSync(join(root, rel), tierText(cap, preamble, blocks));
    return cap;
  };
  const hotBlocks = hot.map((spec) => (typeof spec === 'string' ? adrBlock(spec) : adrBlock(spec.id, spec)));
  const warmBlocks = warm.map((spec) => (typeof spec === 'string' ? adrBlock(spec) : adrBlock(spec.id, spec)));
  const coldBlocks = cold.map((spec) => (typeof spec === 'string' ? adrBlock(spec) : adrBlock(spec.id, spec)));
  return {
    hotCap: writeTier(HOT_REL, HOT_PREAMBLE, hotBlocks, hotCapDelta),
    warmCap: warm.length ? writeTier(WARM_REL, WARM_PREAMBLE, warmBlocks, 200) : null,
    coldCap: cold.length ? writeTier(COLD_REL, COLD_PREAMBLE, coldBlocks, 200) : null,
  };
};

const fakeGit = (root) => (cmd) => (cmd === 'git' ? { status: 0, stdout: `${join(root, '.git')}\n` } : { status: 1 });
const noGit = () => ({ status: 1 });

const run = (argv, root, opts = {}) => {
  const out = [];
  const err = [];
  const calls = [];
  const regen = opts.regen ?? ((r, t) => { calls.push([r, t]); return { ok: true, detail: '' }; });
  const code = runCli(argv, {
    root,
    log: (l) => out.push(l),
    logError: (l) => err.push(l),
    regenerateIndex: regen,
    stamp: opts.stamp ?? 'STAMP',
    snapshotFallbackBase: opts.fallbackBase,
    spawnSync: opts.spawnSync ?? fakeGit(root),
  });
  return { code, out, err, text: out.join('\n'), errText: err.join('\n'), regenCalls: calls };
};

const adrFiles = (root) => (existsSync(join(root, ADR_DIR_REL)) ? readdirSync(join(root, ADR_DIR_REL)).filter((n) => /^AD-\d{3,}-/.test(n)).sort() : []);
const idsIn = (root, rel) => parseDecisionsText(readFileSync(join(root, rel), 'utf8'), rel).entries.map((e) => e.id);

// ── 1.1 — the widened grammar + real-corpus parser + status/date/lifecycle extraction ──

describe('1.1 parser — real-corpus formats, widened grammar, verbatim blocks', () => {
  it('parses AD-001 (separate Date/Status lines), a same-line + wrapped-rich status, and AD-1000', () => {
    const wrapped = ['## AD-042 — Same-line rich', '', '**Date:** 2026-07-04 · **Status:** Accepted (ships kit `1.34.0`;', 'wrapped continuation of the status prose)', '', 'body'].join('\n');
    const text = tierText(500, '# T', [
      adrBlock('001', { separate: true }),
      wrapped,
      adrBlock('1000', { title: 'Four digits' }),
    ]);
    const p = parseDecisionsText(text, 'x');
    assert.deepEqual(p.entries.map((e) => e.id), ['001', '042', '1000']);
    assert.equal(p.entries[1].status, 'accepted', 'the leading Status word wins even when the prose wraps');
    assert.match(p.entries[1].block, /wrapped continuation of the status prose/, 'the block is preserved VERBATIM');
    assert.equal(p.entries[0].date, '2026-01-01');
  });

  it('a MISSING status line defaults to accepted (6 of 9 active HOT ADRs carry none)', () => {
    const noStatus = ['## AD-045 — No status line', '', '**Problem.** starts straight in.', '', 'body'].join('\n');
    const p = parseDecisionsText(tierText(500, '# T', [noStatus]), 'x');
    assert.equal(p.entries[0].status, 'accepted');
    assert.equal(p.entries[0].date, null, 'no Date line → null');
  });

  it('backfills supersedes / supersededBy from the real corpus link forms', () => {
    const blocks = [
      adrBlock('006', { status: 'Amended by [[AD-014]] (later refinement)' }),
      adrBlock('007', { status: 'Superseded by [[AD-011]] (Plan B realized)' }),
      adrBlock('018', { status: 'Accepted — realized in kit 1.7.0. Supersedes [[AD-007]].' }),
    ];
    const p = parseDecisionsText(tierText(500, '# T', blocks), 'x');
    assert.deepEqual(p.entries[0].supersededBy, ['014']);
    assert.equal(p.entries[0].status, 'amended');
    assert.deepEqual(p.entries[1].supersededBy, ['011']);
    assert.equal(p.entries[1].status, 'superseded');
    assert.deepEqual(p.entries[2].supersedes, ['007']);
    assert.equal(p.entries[2].status, 'accepted');
  });

  const badHeadings = [
    ['a hyphen instead of the em-dash', '## AD-024 - Title'],
    ['a 2-digit id (below the AD-\\d{3,} floor)', '## AD-24 — Title'],
    ['a missing title', '## AD-024 — '],
    ['an unrelated H2', '## Notes'],
  ];
  for (const [name, heading] of badHeadings) {
    it(`rejects ${name} naming file:line — never a silent merge`, () => {
      const text = `${fm(500)}\n# T\n\n${adrBlock('001')}\n\n${heading}\nbody\n`;
      assert.throws(() => parseDecisionsText(text, 'docs/ai/decisions.md'), (e) => {
        assert.equal(e.exitCode, 1);
        assert.match(e.message, /docs\/ai\/decisions\.md:\d+/);
        assert.match(e.message, /non-canonical H2/);
        return true;
      });
    });
  }

  it('rejects disordered ids (oldest at the top, NUMERIC order)', () => {
    assert.throws(() => parseDecisionsText(tierText(500, '# T', [adrBlock('007'), adrBlock('005')]), 'x'), /strictly ascending/);
  });

  it('AD-200 precedes AD-1000 numerically (never lexically — Decision 10)', () => {
    const ok = parseDecisionsText(tierText(500, '# T', [adrBlock('200'), adrBlock('1000')]), 'x');
    assert.deepEqual(ok.entries.map((e) => e.id), ['200', '1000']);
    assert.throws(() => parseDecisionsText(tierText(500, '# T', [adrBlock('1000'), adrBlock('200')]), 'x'), /strictly ascending/, 'AD-1000 before AD-200 is descending numerically');
  });
});

describe('slugify + recordFileName', () => {
  it('lowercases, replaces non-alphanumerics, trims to a bounded length', () => {
    assert.equal(slugify('Host-level bridge settings surface'), 'host-level-bridge-settings-surface');
    assert.equal(slugify('Onboarding UX: batched asks (the seeding↔hook chain)'), 'onboarding-ux-batched-asks-the-seeding-hook-chain');
    assert.ok(slugify('x'.repeat(200)).length <= 60);
  });
  it('the filename encodes the id (the O(1) by-id glob key)', () => {
    assert.equal(recordFileName('042', 'a-slug'), 'AD-042-a-slug.md');
  });
});

// ── 1.2 — explode + conservation (pure) ────────────────────────────────────────────────

describe('1.2 explode — one immutable record per id, verbatim block, lifecycle frontmatter', () => {
  it('builds a record per entry with inline lifecycle frontmatter and the verbatim block', () => {
    const p = parseDecisionsText(tierText(500, '# T', [adrBlock('003', { status: 'Superseded by [[AD-009]]' })]), 'x');
    const [rec] = explode(p.entries, '2026-07-09');
    assert.equal(rec.fileName, 'AD-003-decision-003.md');
    assert.match(rec.frontmatter, /type: adr/);
    assert.match(rec.frontmatter, new RegExp(`maxLines: ${RECORD_CAP}`));
    assert.match(rec.frontmatter, /status: superseded/);
    assert.match(rec.frontmatter, /supersededBy: \[AD-009\]/);
    assert.equal(rec.block, p.entries[0].block, 'the block is carried VERBATIM');
  });
});

describe('1.2 verifyConservation — partition-preserving, extra-aware, fail-loud', () => {
  const items = (pairs) => pairs.map(([id, block]) => ({ id, block }));
  it('passes when the NEW side is exactly the OLD multiset', () => {
    const old = items([['001', 'a'], ['002', 'b']]);
    assert.doesNotThrow(() => verifyConservation(old, items([['001', 'a'], ['002', 'b']])));
  });
  it('fails on a DROPPED id (an ADR would be lost)', () => {
    assert.throws(() => verifyConservation(items([['001', 'a'], ['002', 'b']]), items([['001', 'a']])), /absent from the migrated store/);
  });
  it('fails on an EDITED block (hash mismatch — the block must move verbatim)', () => {
    assert.throws(() => verifyConservation(items([['001', 'a']]), items([['001', 'a-edited']])), /block changed during migration/);
  });
  it('fails on a STRAY new id absent from the OLD tiers (invented history)', () => {
    assert.throws(() => verifyConservation(items([['001', 'a']]), items([['001', 'a'], ['009', 'x']])), /stray\/invented/);
  });
  it('fails on a RENUMBER (old 002 lost, new 003 stray)', () => {
    assert.throws(() => verifyConservation(items([['001', 'a'], ['002', 'b']]), items([['001', 'a'], ['003', 'b']])), /lost|absent from the migrated store/);
  });
  it('blockHash is stable + content-addressed', () => {
    assert.equal(blockHash('x'), blockHash('x'));
    assert.notEqual(blockHash('x'), blockHash('y'));
  });
});

// ── 1.3 — --migrate + snapshot + retire monoliths + idempotence + legacy guard ─────────

describe('1.3 --migrate dry-run writes nothing', () => {
  it('prints the file set + conservation proof, mutates no file, creates no adr/ tree', () => {
    const root = makeRoot();
    seedLegacy(root, { hot: ['005', '006'], warm: ['003', '004'], cold: ['001', '002'] });
    const before = readFileSync(join(root, HOT_REL), 'utf8');
    const { code, text } = run(['--migrate', '--today=2026-07-09'], root);
    assert.equal(code, 0, text);
    assert.match(text, /DRY-RUN/);
    assert.match(text, /conserved/);
    assert.equal(readFileSync(join(root, HOT_REL), 'utf8'), before, 'HOT untouched');
    assert.ok(existsSync(join(root, WARM_REL)) && existsSync(join(root, COLD_REL)), 'monoliths untouched');
    assert.ok(!existsSync(join(root, ADR_DIR_REL)), 'no adr/ tree created on a dry-run');
  });
});

describe('1.3 --migrate --apply — records + snapshot + retire monoliths + HOT rewrite', () => {
  it('writes one record per archived id, a git-dir snapshot, a nav, retires monoliths, rewrites the HOT preamble', () => {
    const root = makeRoot();
    seedLegacy(root, { hot: ['005', '006', '007', '008'], warm: ['003', '004'], cold: ['001', '002'] });
    const { code, text } = run(['--migrate', '--apply', '--today=2026-07-09'], root);
    assert.equal(code, 0, text);

    assert.deepEqual(adrFiles(root), ['AD-001-decision-001.md', 'AD-002-decision-002.md', 'AD-003-decision-003.md', 'AD-004-decision-004.md']);
    assert.deepEqual(idsIn(root, HOT_REL), ['005', '006', '007', '008'], 'HOT keeps the active window');
    assert.ok(!existsSync(join(root, WARM_REL)) && !existsSync(join(root, COLD_REL)), 'both monoliths retired');
    assert.ok(existsSync(join(root, NAV_REL)), 'navigator generated');

    const hotText = readFileSync(join(root, HOT_REL), 'utf8');
    assert.match(hotText, /adr\/log\.md/, 'the HOT preamble now points at the navigator');
    assert.doesNotMatch(hotText, /decisions-archive/, 'the dead monolith links are dropped');
    assert.match(hotText, /AD-005 onward/, 'the active-window token is rewritten to the retained oldest');

    const snapDir = join(root, '.git', 'agent-workflow-adr-migration-snapshot-STAMP');
    assert.ok(existsSync(snapDir), 'the snapshot landed under the git dir (never the work tree)');
    assert.equal(readdirSync(snapDir).sort().length, 3, 'snapshot captured decisions.md + both monoliths');
  });

  it('the snapshot captures the ORIGINAL decisions.md + monolith BYTES (recoverable content, not just names)', () => {
    const root = makeRoot();
    seedLegacy(root, { hot: ['005', '006'], warm: ['003'], cold: ['001'] });
    const hotBefore = readFileSync(join(root, HOT_REL), 'utf8');
    const warmBefore = readFileSync(join(root, WARM_REL), 'utf8');
    const coldBefore = readFileSync(join(root, COLD_REL), 'utf8');
    run(['--migrate', '--apply', '--today=2026-07-09'], root);
    const snapDir = join(root, '.git', 'agent-workflow-adr-migration-snapshot-STAMP');
    assert.equal(readFileSync(join(snapDir, 'docs__ai__decisions.md'), 'utf8'), hotBefore, 'the ORIGINAL HOT is recoverable verbatim');
    assert.equal(readFileSync(join(snapDir, 'docs__ai__history__decisions-archive.md'), 'utf8'), warmBefore, 'the ORIGINAL WARM monolith is recoverable verbatim');
    assert.equal(readFileSync(join(snapDir, 'docs__ai__history__decisions-archive-early.md'), 'utf8'), coldBefore, 'the ORIGINAL COLD monolith is recoverable verbatim');
  });

  it('migrating an OVER-CAP HOT explodes the HOT overflow into records too (not only the monoliths)', () => {
    const root = makeRoot();
    seedLegacy(root, { hot: ['005', '006', '007', '008'], warm: ['003'], cold: ['001'], hotCapDelta: -1 });
    const { code } = run(['--migrate', '--apply', '--today=2026-07-09'], root);
    assert.equal(code, 0);
    assert.ok(adrFiles(root).includes('AD-005-decision-005.md'), 'the HOT overflow AD-005 exploded to a record');
    assert.ok(!idsIn(root, HOT_REL).includes('005'), 'AD-005 left the HOT window');
    assert.equal(run(['--check', '--today=2026-07-09'], root).code, 0, 'the migrated over-cap tree is green');
  });

  it('a second --apply no-ops (monoliths already retired → already-migrated)', () => {
    const root = makeRoot();
    seedLegacy(root, { hot: ['005', '006'], warm: ['003'], cold: ['001'] });
    run(['--migrate', '--apply', '--today=2026-07-09'], root);
    const snapshotBefore = readdirSync(join(root, '.git'));
    const { code, text } = run(['--migrate', '--apply', '--today=2026-07-10'], root);
    assert.equal(code, 0);
    assert.match(text, /already migrated/);
    assert.deepEqual(readdirSync(join(root, '.git')), snapshotBefore, 'no second snapshot');
  });

  it('the migrated tree passes --check (green end-to-end)', () => {
    const root = makeRoot();
    seedLegacy(root, { hot: ['005', '006', '007'], warm: ['003', '004'], cold: ['001', '002'] });
    run(['--migrate', '--apply', '--today=2026-07-09'], root);
    const { code, text } = run(['--check', '--today=2026-07-09'], root);
    assert.equal(code, 0, text);
    assert.match(text, /OK — HOT within cap, store integrity intact, navigator fresh/);
  });

  it('a stray adr record NEWER than the HOT window fails exit 1 (partition) BEFORE any snapshot/delete', () => {
    const root = makeRoot();
    seedLegacy(root, { hot: ['005'], warm: ['003'], cold: ['001'] });
    mkdirSync(join(root, ADR_DIR_REL), { recursive: true });
    // AD-099 is newer than the HOT window (AD-005) → not a legitimate archived record → refuse.
    writeFileSync(join(root, ADR_DIR_REL, 'AD-099-stray.md'), `${fm(RECORD_CAP)}\n${adrBlock('099')}\n`);
    const { code, errText } = run(['--migrate', '--apply', '--today=2026-07-09'], root);
    assert.equal(code, 1);
    assert.match(errText, /partition violated/);
    assert.ok(existsSync(join(root, WARM_REL)) && existsSync(join(root, COLD_REL)), 'monoliths NOT deleted on a refused migration');
    assert.ok(!existsSync(join(root, '.git', 'agent-workflow-adr-migration-snapshot-STAMP')), 'no snapshot on a refusal (the integrity check precedes the snapshot)');
  });

  it('resumes after a post-writeHot / post-partial-delete crash without wedging (idempotent) — internal-sweep major', () => {
    const root = makeRoot();
    // Reconstruct a post-crash state: HOT ALREADY trimmed to [006,007,008] (AD-005 was the exploded
    // overflow, its source no longer in HOT); adr/ holds records 001..005; monoliths STILL present
    // (crash before rmSync). A naive conservation would accuse AD-005 of being "invented history".
    seedLegacy(root, { hot: ['006', '007', '008'], warm: ['003', '004'], cold: ['001', '002'] });
    mkdirSync(join(root, ADR_DIR_REL), { recursive: true });
    const recEntries = ['001', '002', '003', '004', '005'].map((id) => parseDecisionsText(tierText(999, '# T', [adrBlock(id)]), 'x').entries[0]);
    for (const rec of explode(recEntries, '2026-07-09')) writeFileSync(join(root, ADR_DIR_REL, rec.fileName), `${rec.frontmatter}\n${rec.block}\n`);
    const { code } = run(['--migrate', '--apply', '--today=2026-07-09'], root);
    assert.equal(code, 0, 'the resume completes — it never accuses its own migrated records of being stray');
    assert.deepEqual(adrFiles(root), ['AD-001-decision-001.md', 'AD-002-decision-002.md', 'AD-003-decision-003.md', 'AD-004-decision-004.md', 'AD-005-decision-005.md']);
    assert.deepEqual(idsIn(root, HOT_REL), ['006', '007', '008']);
    assert.ok(!existsSync(join(root, WARM_REL)) && !existsSync(join(root, COLD_REL)), 'monoliths retired on the completed resume');
    assert.equal(run(['--check', '--today=2026-07-09'], root).code, 0, 'the resumed tree passes --check');
  });

  it('refuses when a pre-existing adr/ record duplicates an ADR that stays in HOT (never two places — review-adr-archive-r04-major-01)', () => {
    const root = makeRoot();
    seedLegacy(root, { hot: ['005', '006'], warm: ['003'], cold: ['001'] });
    mkdirSync(join(root, ADR_DIR_REL), { recursive: true });
    // AD-006 stays in the HOT window, but a store record for it already exists (a corrupt partial state).
    const rec = explode(parseDecisionsText(tierText(999, '# T', [adrBlock('006')]), 'x').entries, '2026-07-09')[0];
    writeFileSync(join(root, ADR_DIR_REL, rec.fileName), `${rec.frontmatter}\n${rec.block}\n`);
    const { code, errText } = run(['--migrate', '--apply', '--today=2026-07-09'], root);
    assert.equal(code, 1);
    assert.match(errText, /duplicate ADR id AD-006/);
    assert.ok(existsSync(join(root, WARM_REL)), 'monoliths NOT deleted on the refused migration');
  });

  it('resumes a half-migrated tree (a byte-identical record is skipped, the rest complete)', () => {
    const root = makeRoot();
    seedLegacy(root, { hot: ['005', '006'], warm: ['003', '004'], cold: ['001', '002'] });
    run(['--migrate', '--today=2026-07-09'], root); // dry-run to observe (no writes)
    // Simulate a crash mid-write: AD-001's record already on disk, monoliths still present.
    const partial = explode(parseDecisionsText(readFileSync(join(root, COLD_REL), 'utf8'), COLD_REL).entries, '2026-07-09')[0];
    mkdirSync(join(root, ADR_DIR_REL), { recursive: true });
    writeFileSync(join(root, ADR_DIR_REL, partial.fileName), `${partial.frontmatter}\n${partial.block}\n`);
    const { code } = run(['--migrate', '--apply', '--today=2026-07-09'], root);
    assert.equal(code, 0, 'the resume completes');
    assert.deepEqual(adrFiles(root), ['AD-001-decision-001.md', 'AD-002-decision-002.md', 'AD-003-decision-003.md', 'AD-004-decision-004.md']);
    assert.ok(!existsSync(join(root, WARM_REL)), 'monoliths retired on the completed resume');
  });

  it('a corrupt crash-resume record (same id, DIFFERENT body) fails loud before any write (conservation is not bypassed)', () => {
    const root = makeRoot();
    seedLegacy(root, { hot: ['005', '006'], warm: ['003', '004'], cold: ['001', '002'] });
    mkdirSync(join(root, ADR_DIR_REL), { recursive: true });
    // An AD-003 record exists on disk but with a TAMPERED body (≠ the WARM monolith's AD-003).
    writeFileSync(join(root, ADR_DIR_REL, 'AD-003-decision-003.md'), `${fm(RECORD_CAP)}\n## AD-003 — Decision 003\n\n**Date:** 2026-01-01\n\nTAMPERED body not in the monolith\n`);
    const { code, errText } = run(['--migrate', '--apply', '--today=2026-07-09'], root);
    assert.equal(code, 1);
    assert.match(errText, /DIFFERENT body|corrupt or hand-edited/);
    assert.ok(existsSync(join(root, WARM_REL)) && existsSync(join(root, COLD_REL)), 'monoliths NOT deleted — the edited record is never silently overwritten');
    assert.ok(!existsSync(join(root, '.git', 'agent-workflow-adr-migration-snapshot-STAMP')), 'no snapshot on a refused migration (conservation precedes the snapshot)');
  });

  it('off git, the snapshot falls back to a stated out-of-tree base (never the work tree)', () => {
    const root = makeRoot();
    const fallback = makeRoot();
    seedLegacy(root, { hot: ['005'], warm: ['003'], cold: ['001'] });
    const { code } = run(['--migrate', '--apply', '--today=2026-07-09'], root, { spawnSync: noGit, fallbackBase: fallback });
    assert.equal(code, 0);
    assert.ok(existsSync(join(fallback, 'agent-workflow-adr-migration-snapshot-STAMP')), 'off-git snapshot landed in the fallback base');
    assert.ok(!existsSync(join(root, '.git')), 'nothing written under a non-existent git dir');
  });
});

describe('1.3 legacy-substrate guard (Decision 6) — never half-explodes, never green on a monolith', () => {
  it('a default rotate with a monolith present fails LOUD (run --migrate first)', () => {
    const root = makeRoot();
    seedLegacy(root, { hot: ['005'], warm: ['003'], cold: ['001'] });
    const { code, errText } = run(['--today=2026-07-09'], root);
    assert.equal(code, 1);
    assert.match(errText, /legacy monolith present/);
    assert.match(errText, /--migrate --apply/);
  });
  it('--check with a monolith present fails LOUD (half-migrated), never reports green', () => {
    const root = makeRoot();
    seedLegacy(root, { hot: ['005'], warm: ['003'], cold: ['001'] });
    const { code, errText } = run(['--check'], root);
    assert.equal(code, 1);
    assert.match(errText, /half-migrated/);
  });

  it('a LONE monolith (HOT and adr/ both absent) fails the legacy guard, never a clean substrate-absent skip', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'docs', 'ai', 'history'), { recursive: true });
    writeFileSync(join(root, WARM_REL), tierText(500, WARM_PREAMBLE, [adrBlock('003')]));
    const { code, errText } = run(['--check'], root);
    assert.equal(code, 1);
    assert.match(errText, /legacy monolith present/);
  });
});

// ── 1.4 — --check + default rotate + item-(h) regen ────────────────────────────────────

// A fully-migrated tree (post-migration substrate) built directly for the check/rotate tests.
const seedMigrated = (root, { hotIds, storeIds = [], hotCapDelta = 200, today = '2026-07-09' }) => {
  mkdirSync(join(root, ADR_DIR_REL), { recursive: true });
  const hotBlocks = hotIds.map((id) => adrBlock(id));
  const probe = tierText(9999, HOT_PREAMBLE.replace(/> \*\*Archive:\*\*.*/, ''), hotBlocks);
  const cap = lineCountOf(probe) + hotCapDelta;
  const preamble = ['# ADRs', '', '> Newest at the bottom.'].join('\n');
  writeFileSync(join(root, HOT_REL), tierText(cap, preamble, hotBlocks));
  const storeEntries = storeIds.map((id) => (typeof id === 'string' ? { id } : id));
  const records = explode(storeEntries.map((s) => parseDecisionsText(tierText(999, '# T', [adrBlock(s.id, s)]), 'x').entries[0]), today);
  for (const rec of records) writeFileSync(join(root, ADR_DIR_REL, rec.fileName), `${rec.frontmatter}\n${rec.block}\n`);
  // A fresh navigator so --check is green from the start.
  run(['--write-navigator', `--today=${today}`], root);
  return { cap };
};

describe('1.4 --check', () => {
  it('a green migrated tree → exit 0', () => {
    const root = makeRoot();
    seedMigrated(root, { hotIds: ['005', '006'], storeIds: ['001', '002'] });
    assert.equal(run(['--check', '--today=2026-07-09'], root).code, 0);
  });

  it('a duplicate id across HOT and adr/ → exit 1', () => {
    const root = makeRoot();
    seedMigrated(root, { hotIds: ['002', '005'], storeIds: ['001', '002'] }); // AD-002 in BOTH
    const { code, errText } = run(['--check', '--today=2026-07-09'], root);
    assert.equal(code, 1);
    assert.match(errText, /duplicate ADR id AD-002/);
  });

  it('a decisions.md with NO maxLines cap fails loud (never operates against an unknown budget — review-adr-archive-r04-major-02)', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    const noCapFm = '---\ntype: reference\nlastUpdated: 2026-01-01\nscope: permanent\nstaleAfter: never\nowner: none\n---\n';
    writeFileSync(join(root, HOT_REL), `${noCapFm}\n# ADRs\n\n${adrBlock('005')}\n`);
    const { code, errText } = run(['--check', '--today=2026-07-09'], root);
    assert.equal(code, 1);
    assert.match(errText, /no maxLines cap/);
  });

  it('NO substrate (neither decisions.md nor adr/) → exit 0 with a STATED skip', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    const { code, text } = run(['--check'], root);
    assert.equal(code, 0);
    assert.match(text, /SKIP — no ADR substrate/);
  });

  it('an adr/ record NEWER than a HOT entry fails store integrity (partition — the once-dead check is live)', () => {
    const root = makeRoot();
    seedMigrated(root, { hotIds: ['005'], storeIds: ['001'] });
    const rec = explode(parseDecisionsText(tierText(999, '# T', [adrBlock('010')]), 'x').entries, '2026-07-09')[0];
    writeFileSync(join(root, ADR_DIR_REL, rec.fileName), `${rec.frontmatter}\n${rec.block}\n`); // AD-010 > HOT AD-005
    const { code, errText } = run(['--check', '--today=2026-07-09'], root);
    assert.equal(code, 1);
    assert.match(errText, /partition violated/);
  });

  it('an UNEXPECTED markdown file in adr/ fails loud (never silently hidden from the store)', () => {
    const root = makeRoot();
    seedMigrated(root, { hotIds: ['005'], storeIds: ['001'] });
    writeFileSync(join(root, ADR_DIR_REL, 'notes.md'), '# stray notes with no frontmatter\n');
    const { code, errText } = run(['--check', '--today=2026-07-09'], root);
    assert.equal(code, 1);
    assert.match(errText, /unexpected markdown file/);
  });

  it('TWO files for one id (a corrupt duplicate-filled store) fail loud at the SOURCE — never deduped away (council R3)', () => {
    const root = makeRoot();
    seedMigrated(root, { hotIds: ['005'], storeIds: ['001'] });
    writeFileSync(join(root, ADR_DIR_REL, 'AD-001-divergent-slug.md'), `${fm(RECORD_CAP)}\n${adrBlock('001')}\n`); // a 2nd file for AD-001
    const { code, errText } = run(['--check', '--today=2026-07-09'], root);
    assert.equal(code, 1);
    assert.match(errText, /two records for AD-001/);
  });

  it('a rotate over a duplicate-filled store fails loud (the R2 crash-resume dedup no longer hides pre-existing dups — council R3)', () => {
    const root = makeRoot();
    mkdirSync(join(root, ADR_DIR_REL), { recursive: true });
    const blocks = ['005', '006', '007', '008'].map((id) => adrBlock(id));
    const preamble = '# ADRs\n\n> HOT.';
    const probe = tierText(9999, preamble, blocks);
    writeFileSync(join(root, HOT_REL), tierText(lineCountOf(probe) - 1, preamble, blocks)); // over cap → rotate proceeds
    for (const r of explode(['001'].map((id) => parseDecisionsText(tierText(999, '# T', [adrBlock(id)]), 'x').entries[0]), '2026-07-09')) {
      writeFileSync(join(root, ADR_DIR_REL, r.fileName), `${r.frontmatter}\n${r.block}\n`);
    }
    writeFileSync(join(root, ADR_DIR_REL, 'AD-001-second.md'), `${fm(RECORD_CAP)}\n${adrBlock('001')}\n`); // duplicate id
    const { code, errText } = run(['--today=2026-07-09'], root);
    assert.equal(code, 1);
    assert.match(errText, /two records for AD-001/);
  });

  it('a NESTED subdirectory in adr/ fails loud (the store is a flat directory — review-adr-archive-r02-major-01)', () => {
    const root = makeRoot();
    seedMigrated(root, { hotIds: ['005'], storeIds: ['001'] });
    mkdirSync(join(root, ADR_DIR_REL, 'nested'), { recursive: true });
    writeFileSync(join(root, ADR_DIR_REL, 'nested', 'AD-002-x.md'), `${fm(RECORD_CAP)}\n${adrBlock('002')}\n`);
    const { code, errText } = run(['--check', '--today=2026-07-09'], root);
    assert.equal(code, 1);
    assert.match(errText, /FLAT directory/);
  });

  it('adr/ present but HOT absent → integrity is STILL checked (not skipped): a stale nav → exit 1', () => {
    const root = makeRoot();
    seedMigrated(root, { hotIds: ['005'], storeIds: ['001', '002'] });
    rmSync(join(root, HOT_REL));
    writeFileSync(join(root, NAV_REL), readFileSync(join(root, NAV_REL), 'utf8') + '\nstale junk\n');
    const { code, errText } = run(['--check', '--today=2026-07-09'], root);
    assert.equal(code, 1, 'the check runs (does not skip) even with HOT absent');
    assert.match(errText, /stale/);
  });
});

describe('1.4 default rotate — explode the oldest beyond cap + regenerate the index (item h)', () => {
  it('a HOT one line over cap explodes EXACTLY the oldest entry, keeps the rest, calls the index regen once', () => {
    const root = makeRoot();
    // 4 HOT entries, cap = rendered - 1 → exactly one must roll out.
    mkdirSync(join(root, ADR_DIR_REL), { recursive: true });
    const blocks = ['005', '006', '007', '008'].map((id) => adrBlock(id));
    const preamble = '# ADRs\n\n> Newest at the bottom.';
    const probe = tierText(9999, preamble, blocks);
    writeFileSync(join(root, HOT_REL), tierText(lineCountOf(probe) - 1, preamble, blocks));
    run(['--write-navigator', '--today=2026-07-09'], root); // seed a fresh nav
    const { code, regenCalls } = run(['--today=2026-07-09'], root);
    assert.equal(code, 0);
    assert.deepEqual(idsIn(root, HOT_REL), ['006', '007', '008'], 'exactly the oldest rolled out');
    assert.deepEqual(adrFiles(root), ['AD-005-decision-005.md'], 'AD-005 exploded to a record');
    assert.deepEqual(regenCalls, [[root, '2026-07-09']], 'the index regen fired once with (root, today)');
  });

  it('an under-cap migrated tree is a no-op (nothing written, no regen)', () => {
    const root = makeRoot();
    seedMigrated(root, { hotIds: ['005', '006'], storeIds: ['001'] });
    const { code, text, regenCalls } = run(['--today=2026-07-09'], root);
    assert.equal(code, 0);
    assert.match(text, /nothing to rotate/);
    assert.equal(regenCalls.length, 0, 'a no-op never regenerates the index');
  });

  it('is crash-resumable: a byte-identical record from a crashed prior rotate is deduped, not a fatal duplicate (review-adr-archive-r02-major-02)', () => {
    const root = makeRoot();
    mkdirSync(join(root, ADR_DIR_REL), { recursive: true });
    const blocks = ['005', '006', '007', '008'].map((id) => adrBlock(id));
    const preamble = '# ADRs\n\n> Newest at the bottom.';
    const probe = tierText(9999, preamble, blocks);
    writeFileSync(join(root, HOT_REL), tierText(lineCountOf(probe) - 1, preamble, blocks)); // AD-005 overflows
    // Crash after writeRecords, before writeHot: AD-005 already exploded, HOT untrimmed; plus archived AD-001.
    for (const r of explode(['001', '005'].map((id) => parseDecisionsText(tierText(999, '# T', [adrBlock(id)]), 'x').entries[0]), '2026-07-09')) {
      writeFileSync(join(root, ADR_DIR_REL, r.fileName), `${r.frontmatter}\n${r.block}\n`);
    }
    const { code } = run(['--today=2026-07-09'], root);
    assert.equal(code, 0, 'the crashed rotate resumes cleanly — no fatal duplicate on the already-written record');
    assert.deepEqual(idsIn(root, HOT_REL), ['006', '007', '008']);
    assert.deepEqual(adrFiles(root), ['AD-001-decision-001.md', 'AD-005-decision-005.md']);
    assert.equal(run(['--check', '--today=2026-07-09'], root).code, 0);
  });

  it('a no-op rotate still REFUSES a corrupt store (partition) — never a silent green no-op (review-adr-archive-r02-major-03)', () => {
    const root = makeRoot();
    seedMigrated(root, { hotIds: ['005'], storeIds: ['001'] }); // under cap
    const rec = explode(parseDecisionsText(tierText(999, '# T', [adrBlock('010')]), 'x').entries, '2026-07-09')[0];
    writeFileSync(join(root, ADR_DIR_REL, rec.fileName), `${rec.frontmatter}\n${rec.block}\n`); // AD-010 > HOT AD-005
    const { code, errText } = run(['--today=2026-07-09'], root);
    assert.equal(code, 1);
    assert.match(errText, /partition violated/);
  });

  it('degrades LOUDLY when the index regen fails — the rotation itself still succeeds (exit 0)', () => {
    const root = makeRoot();
    const blocks = ['005', '006', '007', '008'].map((id) => adrBlock(id));
    const preamble = '# ADRs\n\n> Newest at the bottom.';
    const probe = tierText(9999, preamble, blocks);
    mkdirSync(join(root, ADR_DIR_REL), { recursive: true });
    writeFileSync(join(root, HOT_REL), tierText(lineCountOf(probe) - 1, preamble, blocks));
    run(['--write-navigator', '--today=2026-07-09'], root);
    const { code, errText } = run(['--today=2026-07-09'], root, { regen: () => ({ ok: false, detail: 'the index generator is not beside this script' }) });
    assert.equal(code, 0, 'the rotation succeeded — regen is best-effort');
    assert.match(errText, /NOT regenerated/);
  });
});

// ── 1.5 — navigator generator + --write-navigator ──────────────────────────────────────

describe('1.5 navigator — governing heads (computed), superseded drop out but stay reachable', () => {
  it('a superseded ADR is absent from the governing list but present by filename + in the recent window', () => {
    const root = makeRoot();
    // AD-002 is superseded by AD-005 (self-declared); it must drop out of governing.
    seedMigrated(root, { hotIds: ['005', '006'], storeIds: [{ id: '001' }, { id: '002', status: 'Superseded by [[AD-005]]' }] });
    const nav = readFileSync(join(root, NAV_REL), 'utf8');
    const governingSection = nav.split('## Recent')[0];
    assert.doesNotMatch(governingSection, /AD-002/, 'the superseded ADR is NOT a governing head');
    assert.match(governingSection, /AD-001/, 'a governing ADR is listed');
    assert.ok(adrFiles(root).some((f) => f.startsWith('AD-002-')), 'the superseded ADR is still reachable by filename');
    assert.match(nav, /AD-002.*superseded/s, 'the recent window still surfaces it, marked superseded');
  });

  it('governance is computed across the corpus via inference (no predecessor mutation needed)', () => {
    const corpus = [
      { id: '001', idNum: 1, title: 'A', status: 'accepted', supersedes: [], supersededBy: [], fileName: 'AD-001-a.md' },
      { id: '002', idNum: 2, title: 'B', status: 'accepted', supersedes: ['001'], supersededBy: [], fileName: 'AD-002-b.md' },
    ];
    const superseded = computeSupersededSet(corpus);
    assert.ok(superseded.has('001'), 'AD-001 is inferred superseded because AD-002 declares Supersedes [[AD-001]]');
    assert.ok(!superseded.has('002'));
    const nav = buildNavigator(corpus, '2026-07-09');
    assert.match(nav, /Governing \(1\)/);
    assert.match(nav, /AD-001 … AD-002/, 'the navigator range is numeric min…max');
  });

  it('a Proposed head is NOT governing; a non-accepted Supersedes does NOT retire an accepted predecessor', () => {
    const corpus = [
      { id: '001', idNum: 1, title: 'A', status: 'accepted', supersedes: [], supersededBy: [], fileName: 'AD-001-a.md' },
      { id: '002', idNum: 2, title: 'B', status: 'proposed', supersedes: ['001'], supersededBy: [], fileName: 'AD-002-b.md' },
    ];
    const superseded = computeSupersededSet(corpus);
    assert.ok(!superseded.has('001'), 'a Proposed ADR does not effectively supersede its accepted predecessor');
    const gov = buildNavigator(corpus, '2026-07-09').split('## Recent')[0];
    assert.match(gov, /AD-001/, 'the accepted predecessor stays governing');
    assert.doesNotMatch(gov, /\| AD-002 \|/, 'the Proposed ADR is NOT a governing head (accepted & not-superseded only)');
  });

  it('authoring a new HOT ADR then --write-navigator keeps --check green; a stale nav with NO write → exit 1, then --write-navigator fixes it', () => {
    const root = makeRoot();
    seedMigrated(root, { hotIds: ['005', '006'], storeIds: ['001'] });
    assert.equal(run(['--check', '--today=2026-07-09'], root).code, 0, 'starts green');

    // Corrupt the navigator without regenerating → --check must flag it stale.
    writeFileSync(join(root, NAV_REL), readFileSync(join(root, NAV_REL), 'utf8') + '\n<!-- drift -->\n');
    const stale = run(['--check', '--today=2026-07-09'], root);
    assert.equal(stale.code, 1);
    assert.match(stale.errText, /navigator|stale|log\.md/i);

    // --write-navigator is the deterministic fix (never a fixless false-block).
    assert.equal(run(['--write-navigator', '--today=2026-07-09'], root).code, 0);
    assert.equal(run(['--check', '--today=2026-07-09'], root).code, 0, '--write-navigator restored freshness');
  });

  it('--write-navigator refuses a duplicate-id store (never emits a corrupt / duplicate-row navigator)', () => {
    const root = makeRoot();
    mkdirSync(join(root, ADR_DIR_REL), { recursive: true });
    writeFileSync(join(root, HOT_REL), tierText(500, '# ADRs\n\n> HOT.', [adrBlock('002'), adrBlock('005')]));
    const rec = explode(parseDecisionsText(tierText(999, '# T', [adrBlock('002')]), 'x').entries, '2026-07-09')[0];
    writeFileSync(join(root, ADR_DIR_REL, rec.fileName), `${rec.frontmatter}\n${rec.block}\n`); // AD-002 in adr/ AND HOT
    const { code, errText } = run(['--write-navigator', '--today=2026-07-09'], root);
    assert.equal(code, 1);
    assert.match(errText, /duplicate ADR id AD-002/);
  });

  it('--check does NOT false-block on a mere day-rollover (uses the on-disk nav lastUpdated)', () => {
    const root = makeRoot();
    seedMigrated(root, { hotIds: ['005'], storeIds: ['001'], today: '2026-07-01' });
    // "Today" is much later, but the corpus is unchanged → the nav must stay fresh.
    assert.equal(run(['--check', '--today=2026-07-31'], root).code, 0);
  });
});

// ── item (h) degrade branches on the REAL default regenerator (no injection) ───────────

describe('defaultRegenerateIndex — loud-degrade branches', () => {
  it('an absent index generator sibling → ok:false with a recovery instruct', () => {
    const r = defaultRegenerateIndex('/tmp/anyroot', '2026-07-09', { sibling: '/nonexistent/check-docs-size.mjs' });
    assert.equal(r.ok, false);
    assert.match(r.detail, /not beside this script/);
  });
  it('a subprocess that exits nonzero → ok:false with the recovery instruct', () => {
    const r = defaultRegenerateIndex('/tmp/anyroot', '2026-07-09', { existsSync: () => true, spawnSync: () => ({ status: 1 }) });
    assert.equal(r.ok, false);
    assert.match(r.detail, /index regeneration failed/);
  });
});

// ── coverage: defensive fail-loud branches + success/degrade paths (M3a) ───────────────

describe('defensive branches + success/degrade paths', () => {
  it('a non-markdown stray in adr/ is IGNORED by the store (never an error)', () => {
    const root = makeRoot();
    seedMigrated(root, { hotIds: ['005'], storeIds: ['001'] });
    writeFileSync(join(root, ADR_DIR_REL, 'notes.txt'), 'not markdown — ignored\n');
    assert.equal(run(['--check', '--today=2026-07-09'], root).code, 0);
  });

  it('a record file holding TWO ADR blocks fails loud', () => {
    const root = makeRoot();
    seedMigrated(root, { hotIds: ['005'], storeIds: [] });
    writeFileSync(join(root, ADR_DIR_REL, 'AD-001-two.md'), `${fm(RECORD_CAP)}\n${adrBlock('001')}\n\n${adrBlock('002')}\n`);
    const { code, errText } = run(['--check', '--today=2026-07-09'], root);
    assert.equal(code, 1);
    assert.match(errText, /exactly one ADR block/);
  });

  it('a record whose filename id mismatches its heading id fails loud', () => {
    const root = makeRoot();
    seedMigrated(root, { hotIds: ['005'], storeIds: [] });
    writeFileSync(join(root, ADR_DIR_REL, 'AD-001-mismatch.md'), `${fm(RECORD_CAP)}\n${adrBlock('002')}\n`);
    const { code, errText } = run(['--check', '--today=2026-07-09'], root);
    assert.equal(code, 1);
    assert.match(errText, /does not match the heading id/);
  });

  it('a migration with NO writable snapshot base fails loud, monoliths untouched', () => {
    const root = makeRoot();
    seedLegacy(root, { hot: ['005'], warm: ['003'], cold: ['001'] });
    const fileAsBase = join(makeRoot(), 'i-am-a-file');
    writeFileSync(fileAsBase, 'x'); // mkdir UNDER a file → ENOTDIR → both bases fail
    const { code, errText } = run(['--migrate', '--apply', '--today=2026-07-09'], root, { spawnSync: noGit, fallbackBase: fileAsBase });
    assert.equal(code, 1);
    assert.match(errText, /no writable snapshot location/);
    assert.ok(existsSync(join(root, WARM_REL)), 'monoliths untouched when the snapshot cannot be written');
  });

  it('defaultRegenerateIndex: a successful subprocess (status 0) → ok:true with the trimmed stdout', () => {
    const r = defaultRegenerateIndex('/tmp/anyroot', '2026-07-09', { existsSync: () => true, spawnSync: () => ({ status: 0, stdout: 'Wrote docs/ai/index.md\n' }) });
    assert.equal(r.ok, true);
    assert.match(r.detail, /Wrote docs\/ai\/index\.md/);
  });

  it('migrate on a tree with NO monolith and NO store → a stated "nothing to migrate"', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, HOT_REL), tierText(500, '# ADRs', [adrBlock('005')]));
    const { code, text } = run(['--migrate', '--today=2026-07-09'], root);
    assert.equal(code, 0);
    assert.match(text, /nothing to migrate/);
  });

  it('migrate --apply with a FAILING index regen degrades loudly (migration still exit 0)', () => {
    const root = makeRoot();
    seedLegacy(root, { hot: ['005'], warm: ['003'], cold: ['001'] });
    const { code, errText } = run(['--migrate', '--apply', '--today=2026-07-09'], root, { regen: () => ({ ok: false, detail: 'boom' }) });
    assert.equal(code, 0);
    assert.match(errText, /NOT regenerated/);
  });

  it('--write-navigator on an empty tree → a stated skip', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    const { code, text } = run(['--write-navigator'], root);
    assert.equal(code, 0);
    assert.match(text, /SKIP — no ADR substrate/);
  });

  it('--write-navigator with a FAILING index regen degrades loudly (exit 0)', () => {
    const root = makeRoot();
    seedMigrated(root, { hotIds: ['005'], storeIds: ['001'] });
    const { code, errText } = run(['--write-navigator', '--today=2026-07-09'], root, { regen: () => ({ ok: false, detail: 'boom' }) });
    assert.equal(code, 0);
    assert.match(errText, /NOT regenerated/);
  });

  it('a SINGLE HOT entry over cap fails loud (cannot be reduced below one)', () => {
    const root = makeRoot();
    mkdirSync(join(root, ADR_DIR_REL), { recursive: true });
    const block = adrBlock('005', { body: 12 });
    const probe = tierText(9999, '# ADRs', [block]);
    writeFileSync(join(root, HOT_REL), tierText(lineCountOf(probe) - 1, '# ADRs', [block]));
    const { code, errText } = run(['--today=2026-07-09'], root);
    assert.equal(code, 1);
    assert.match(errText, /cannot be reduced/);
  });

  it('rotate refuses a DIVERGENT-body crash-resume record', () => {
    const root = makeRoot();
    mkdirSync(join(root, ADR_DIR_REL), { recursive: true });
    const blocks = ['005', '006', '007', '008'].map((id) => adrBlock(id));
    const probe = tierText(9999, '# ADRs', blocks);
    writeFileSync(join(root, HOT_REL), tierText(lineCountOf(probe) - 1, '# ADRs', blocks)); // AD-005 overflows
    writeFileSync(join(root, ADR_DIR_REL, 'AD-005-decision-005.md'), `${fm(RECORD_CAP)}\n## AD-005 — Decision 005\n\n**Date:** 2026-01-01\n\nDIVERGENT body\n`);
    const { code, errText } = run(['--today=2026-07-09'], root);
    assert.equal(code, 1);
    assert.match(errText, /diverges from the freshly-exploded block/);
  });

  it('rotate --dry-run prints the move-set and writes nothing', () => {
    const root = makeRoot();
    mkdirSync(join(root, ADR_DIR_REL), { recursive: true });
    const blocks = ['005', '006', '007', '008'].map((id) => adrBlock(id));
    const probe = tierText(9999, '# ADRs', blocks);
    writeFileSync(join(root, HOT_REL), tierText(lineCountOf(probe) - 1, '# ADRs', blocks));
    const before = readFileSync(join(root, HOT_REL), 'utf8');
    const { code, text } = run(['--dry-run', '--today=2026-07-09'], root);
    assert.equal(code, 0);
    assert.match(text, /DRY-RUN/);
    assert.equal(readFileSync(join(root, HOT_REL), 'utf8'), before);
  });
});

describe('usage', () => {
  it('an unknown argument is a loud exit 2', () => {
    const { code, errText } = run(['--frobnicate'], makeRoot());
    assert.equal(code, 2);
    assert.match(errText, /Unknown argument/);
  });
  it('--help prints usage and exits 0', () => {
    const { code, text } = run(['--help'], makeRoot());
    assert.equal(code, 0);
    assert.match(text, /Usage: archive-decisions/);
  });
});
