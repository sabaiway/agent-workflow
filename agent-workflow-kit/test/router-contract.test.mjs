// Router-contract drift guard for the SKILL.md progressive-disclosure split (AD-039).
//
// The kit SKILL.md is a thin ROUTER: every invocation loads it whole, then reads exactly one
// references/modes/<key>.md (plus that file's `Requires:`-declared references/shared/*.md). The
// token cut only survives if four invariant families hold over the REAL files:
//   (a) the router still carries its decision core (safe-routing + version-status routing note +
//       the composition-root tokens) — region-scoped, non-vacuous;
//   (b) one router line per catalog mode, carrying the catalog `kind` EXACTLY and the
//       ${CLAUDE_SKILL_DIR}/references/modes/<mode>.md pointer spelling;
//   (c) the router carries NO actionable writer steps (the moved step-list tokens must not return);
//   (d) the D4 pointer audits, permanent: every `Requires:` resolves; no italic *Mode: x* / plain
//       (Mode: x) cross-reference; no bare kit-relative link; moved shared-section title refs carry
//       their report-footer pointer;
//   (e) the D6 byte budgets, read sets computed from the parsed `Requires:` lines.
// There is no runtime that "executes" SKILL.md prose, so this static guard is the automatable half
// of the "No changes without tests" Hard Constraint for the split.
//
// Dev-only repo test (test/ is outside the package `files` whitelist — not shipped in the tarball).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, kindOf } from '../tools/commands.mjs';

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODES_DIR = join(kitRoot, 'references', 'modes');
const SHARED_DIR = join(kitRoot, 'references', 'shared');
const VAR = '${CLAUDE_SKILL_DIR}';

const ROUTER = readFileSync(join(kitRoot, 'SKILL.md'), 'utf8');
const modeKeys = COMMANDS.map((c) => c.key);
const readMode = (k) => readFileSync(join(MODES_DIR, `${k}.md`), 'utf8');
const sharedNames = readdirSync(SHARED_DIR).filter((f) => f.endsWith('.md'));
const readShared = (f) => readFileSync(join(SHARED_DIR, f), 'utf8');
const bytesOf = (p) => statSync(p).size;

// Every split file, labelled — the D4 audits sweep all of them.
const CORPUS = [
  { label: 'SKILL.md (router)', text: ROUTER },
  ...modeKeys.map((k) => ({ label: `references/modes/${k}.md`, text: readMode(k) })),
  ...sharedNames.map((f) => ({ label: `references/shared/${f}`, text: readShared(f) })),
];

// ── helpers ─────────────────────────────────────────────────────────────────
// Region slice with asserted anchors (a renamed heading fails loudly, never matches nothing).
const region = (text, from, to, where) => {
  const a = text.indexOf(from);
  assert.notEqual(a, -1, `${where}: missing region anchor "${from}"`);
  const b = to ? text.indexOf(to, a + from.length) : text.length;
  assert.notEqual(b, -1, `${where}: missing region anchor "${to}"`);
  return text.slice(a, b);
};
const missingTokens = (regionText, tokens) => {
  const haystack = regionText.toLowerCase().replace(/\s+/g, ' ');
  return tokens.filter((t) => !haystack.includes(t.toLowerCase()));
};
// Parse a mode file's ONE optional `Requires:` line into shared basenames.
const parseRequires = (text, where) => {
  const lines = text.split('\n').filter((l) => l.startsWith('Requires: '));
  assert.ok(lines.length <= 1, `${where}: at most ONE Requires: line (found ${lines.length})`);
  if (!lines.length) return [];
  return lines[0]
    .slice('Requires: '.length)
    .split(' · ')
    .map((p) => p.trim());
};

// ── (a) the router decision core, region-scoped + non-vacuous ───────────────
describe('router contract — the decision core stays on the router (a)', () => {
  const COMPOSITION_TOKENS = [
    'composition root', 'prefers to delegate', 'own bundled copy', 'use the bundled copy',
    'tools/delegation.mjs', 'ask before committing', 'once placed', '--no-bridges',
  ];
  const ROUTING_TOKENS = [
    'Safe-routing rule', 'no unrecognized/garbage invocation ever triggers a write',
    'never-downgrade gate', 'Two independent version axes', 'restart the session',
  ];

  it('keeps the composition-root decision tokens inside ## Memory substrate → ## Modes', () => {
    const slice = region(ROUTER, '## Memory substrate', '## Modes', 'router');
    assert.deepEqual(missingTokens(slice, COMPOSITION_TOKENS), []);
  });

  it('keeps the safe-routing rule + version-status routing note inside ### Version status → the first mode header', () => {
    const slice = region(ROUTER, '### Version status & the two axes', '### Mode: ', 'router');
    assert.deepEqual(missingTokens(slice, ROUTING_TOKENS), []);
  });

  it('is non-vacuous: a doctored router with a stripped token is reported missing (red→green probe)', () => {
    const doctored = ROUTER.replaceAll('Safe-routing rule', 'REDACTED rule');
    const slice = region(doctored, '### Version status & the two axes', '### Mode: ', 'doctored router');
    assert.deepEqual(missingTokens(slice, ['Safe-routing rule']), ['Safe-routing rule']);
  });
});

// ── (b) one router line per catalog mode: kind EXACTLY + the pointer spelling ─
describe('router contract — one kind-exact pointer line per mode (b)', () => {
  const routerLines = ROUTER.split('\n');
  // The section under a mode header = the lines up to the next heading or horizontal rule
  // (grounding is the last header — its section ends at the `---` before ## References).
  const sectionUnder = (key) => {
    const at = routerLines.indexOf(`### Mode: ${key}`);
    assert.notEqual(at, -1, `the bare header ### Mode: ${key} must survive on the router`);
    const body = [];
    for (let i = at + 1; i < routerLines.length; i++) {
      const line = routerLines[i];
      if (/^(#|---)/.test(line)) break;
      if (line.trim()) body.push(line.trim());
    }
    return body;
  };
  for (const key of modeKeys) {
    it(`### Mode: ${key} carries "${kindOf(key)}" and the ${VAR} pointer to its mode file`, () => {
      const body = sectionUnder(key);
      assert.equal(body.length, 1, `exactly ONE router line under ### Mode: ${key} (got ${body.length})`);
      const expected = `${kindOf(key)} — read \`${VAR}/references/modes/${key}.md\` before acting.`;
      assert.equal(body[0], expected, 'the router line = catalog kind EXACTLY + the mode-file pointer');
    });
  }
});

// ── (c) the router carries no actionable writer steps ───────────────────────
describe('router contract — no writer steps on the router (c)', () => {
  // Step-list tokens that MOVED into mode files; any one of them reappearing on the router means
  // a mode body is bleeding back into the always-loaded surface.
  const MOVED_STEP_TOKENS = [
    'Re-stamp `docs/ai/.workflow-version`', // upgrade step 8
    'tools/set-recipe.mjs', // the set-recipe dispatch line
    'tools/run-gates.mjs', // the gates dispatch line
    'tools/setup-backends.mjs', // the setup dispatch line
    'tools/uninstall.mjs', // the uninstall dispatch line
    'tools/hide-footprint.mjs', // bootstrap step 9 / the upgrade reconcile
    'AskUserQuestion', // the bootstrap question protocol
  ];
  for (const token of MOVED_STEP_TOKENS) {
    it(`router does not carry "${token}"`, () => {
      assert.ok(!ROUTER.includes(token), `the router must not carry the moved step token "${token}"`);
    });
  }
});

// ── (d) the D4 pointer audits, permanent ─────────────────────────────────────
describe('router contract — D4 pointer audits over the whole split corpus (d)', () => {
  it('every Requires:-declared shared file resolves to an existing, non-empty references/shared/ file', () => {
    for (const key of modeKeys) {
      for (const declared of parseRequires(readMode(key), `modes/${key}.md`)) {
        assert.ok(declared.startsWith(`${VAR}/references/shared/`),
          `modes/${key}.md declares "${declared}" — must use the ${VAR}/references/shared/ spelling`);
        const base = declared.slice(`${VAR}/references/shared/`.length);
        const abs = join(SHARED_DIR, base);
        assert.ok(existsSync(abs), `modes/${key}.md requires ${base} — file missing`);
        assert.ok(statSync(abs).size > 0, `modes/${key}.md requires ${base} — file empty`);
      }
    }
  });

  it('no file carries an italic *Mode: x* or plain (Mode: x) cross-reference (pointers only)', () => {
    for (const { label, text } of CORPUS) {
      const hits = [...(text.match(/\*Mode: [a-z-]+\*/g) ?? []), ...(text.match(/\(Mode: [a-z-]+\)/g) ?? [])];
      assert.deepEqual(hits, [], `${label} carries un-plumbed cross-mode refs`);
    }
  });

  it('no file carries a bare kit-relative references/tools/migrations/bridges/launchers link', () => {
    for (const { label, text } of CORPUS) {
      const hits = text.match(/\]\((references|tools|migrations|bridges|launchers)\/[^)]*\)/g) ?? [];
      assert.deepEqual(hits, [], `${label} carries bare kit-relative links (must be ${VAR}/…)`);
    }
  });

  it('moved shared-section title references carry the report-footer pointer (outside report-footer itself)', () => {
    const POINTER = ` in \`${VAR}/references/shared/report-footer.md\``;
    for (const { label, text } of CORPUS) {
      if (label.endsWith('report-footer.md')) continue; // intra-file refs moved together — stay bare
      const flat = text.replace(/\s+/g, ' ');
      for (const title of ['*Version disclosure*', '*The version block + welcome mat*']) {
        let at = flat.indexOf(title);
        while (at !== -1) {
          const follows = flat.slice(at + title.length, at + title.length + POINTER.length);
          assert.equal(follows, POINTER, `${label}: "${title}" must point at report-footer.md`);
          at = flat.indexOf(title, at + title.length);
        }
      }
      assert.ok(!flat.includes('the shared contracts above'),
        `${label}: "the shared contracts above" must have become a report-footer pointer`);
    }
  });
});

// ── (e) the D6 byte budgets, read sets from the parsed Requires: lines ───────
const BUDGET = {
  router: 11264, // router alone. 10240 → 11264 (11 KB): AD-044 Plan 4 adds the sandbox-masks and
  // recommendations modes to the router (~110 B each) against 27 B of headroom — a documented
  // KB-multiple bump, never a silent re-pin.
  routerPlusMode: 38912, // router + any single mode file. 37888 → 38912 (38 KB): AD-061 Phase 3 —
  // upgrade.md gains the Communication-section reconcile contract (the enumerated outcome set on
  // steps 3 and 4, the step-8 row) and the pair measures 37985 B, over the 37 KB ceiling — a
  // documented KB-multiple bump, never a silent re-pin.
  // History: 35840 → 37888 (37 KB): the REPORT-FACTS
  // train (Item A, AD-054) adds the report-facts binding line to upgrade.md steps 4 AND 8 (the
  // single-home pointer + the four pinned tokens on each exit) — the pair measures 36931 B, over the
  // 35 KB ceiling; a documented KB-multiple bump, never a silent re-pin.
  // History: 32768 → 35840 (35 KB): AD-044 Plan 4
  // Segment B — upgrade.md gains the mandatory Recommendations section contract on BOTH exits
  // (~1.1 KB: the section render, the pinned order, the apply lane) PLUS the autonomy-declaration
  // ensure paragraph + its step-4/8 outcome rows (~1.2 KB) against a pair already at its 32 KB
  // ceiling — a documented KB-multiple bump, never a silent re-pin. (History: 28672 → 29696: the
  // AD-042 documented
  // AD-039 amendment — the F11 both-blocks batching caveat is +422 B of new upgrade.md contract
  // content against 154 B of headroom; then 29696 → 30720 (30 KB): AD-043 adds the bridge-settings
  // reconcile paragraph + its step-4/8 report mentions to upgrade.md, ~628 B of new contract content
  // that overflows the 29696 pair by 90 B — a documented KB-multiple bump, never a silent re-pin;
  // then 30720 → 31744 (31 KB): AD-049 adds the doc-parity mode to the router (offset by a router
  // trim to stay FLAT ≤ 10240) AND the carry-in `verification-profile.json` clause to upgrade.md's
  // equal-head report checklist, which overflows the 30720 pair by 120 B — another documented
  // KB-multiple bump. The router itself stays FLAT ≤ 10240 for the new mode.
  // Then 31744 → 32768 (32 KB): AD-044 Plan 3 takes upgrade.md's two-pointer reconcile contract to
  // THREE pointers (the autonomy slot: step-3 wording, the (a)(iii) anchor-absent soft-skip lane,
  // the No-Node walk, the step-4/8 report row) — ~575 B of new contract content over 179 B of
  // headroom; a documented KB-multiple bump, never a silent re-pin.)
  fullReadSet: 65536, // router + mode + its declared shared files. 63488 → 65536 (64 KB):
  // AD-061 Phase 3 — upgrade.md gains the Communication-section reconcile contract (the
  // enumerated outcome set on steps 3/4, the step-8 row) AND composition-handoff.md gains the
  // Communication half of the both-paths refresh paragraph, against 83 B of headroom; the
  // heaviest set (upgrade + its 4 shared files) measures 64526 B — a documented KB-multiple
  // bump, never a silent re-pin. History: 62464 → 63488 (62 KB):
  // AD-061 — the shared command-shapes contract (references/shared/command-shapes.md, ~1.6 KB)
  // joins the probe-instructing modes' read sets; the heaviest set (upgrade + its now-4 shared
  // files) measures 63405 B, over the 61 KB ceiling — a documented KB-multiple bump, never a
  // silent re-pin. Then 61440 → 62464 (61 KB):
  // strip-the-kit 3.6 — upgrade.md gains the consented D8 legacy gates.json migration paragraph
  // (~0.9 KB) against a pair already at its 60 KB ceiling (the deleted verification-profile
  // ensure freed less than the migration costs) — a documented KB-multiple bump, never a silent
  // re-pin. History: 59392 → 61440 (60 KB): the
  // REPORT-FACTS train (Item A, AD-054) — the report-facts full clause lands in report-footer.md
  // (~1 KB, in upgrade.md's read set) and the two binding lines grow upgrade.md itself; the heaviest
  // read set (upgrade + its 3 shared files) measures 61367 B, over the 58 KB budget — a documented
  // KB-multiple bump, never a silent re-pin.
  // History: 58368 → 59392 (58 KB): AD-044
  // Plan 4 Segment B closing (codex cycle-10 fold) — report-footer.md documents the autonomy
  // segment on the backend-status placeholder (the composer appends it; the contract must match
  // the pasted surface), ~340 B of new shared contract content vs 86 B over the 57 KB budget —
  // the same documented KB-multiple bump, never a silent re-pin.
  // History: 55296 → 56320 (55 KB): AD-044
  // Plan 4 — the new router mode lines (sandbox-masks, recommendations) ride EVERY mode's read set
  // and upgrade.md gains the Recommendations final section + the autonomy-seed ensure row against
  // 12 B of headroom — a documented KB-multiple bump, never a silent re-pin. Then 56320 → 58368
  // (57 KB): the LANDED Segment-B upgrade.md contract measures ~2.3 KB — the Recommendations
  // section on both exits (~1.1 KB) + the autonomy-declaration ensure paragraph with its step-4/8
  // outcome rows (~1.2 KB) — vs the ~0.5 KB anticipated at Segment A; the same documented
  // KB-multiple bump.
  // History: 53248 → 54272 (53 KB): AD-049 —
  // the heaviest read set (upgrade + its 3 shared files) sat 6 B under the 52 KB budget, so the new
  // doc-parity router line (present in EVERY mode's read set) plus the carry-in verification-profile
  // clause on upgrade.md overflow it by 190 B — a documented KB-multiple bump, never a silent re-pin.
  // Then 54272 → 55296 (54 KB): AD-044 Plan 3 — the same three-pointer contract also lands in
  // composition-handoff.md (a shared file in upgrade's read set), overflowing the pair by ~949 B;
  // the same documented KB-multiple bump.
  daily: 18432, // the no-shared daily modes (help/backends/recipes/procedures/gates). 16384 →
  // 17408 (17 KB): AD-052 replaces gates.md's one-sentence offer description with the closed-world
  // contract paragraph (allowlist membership + the uniform `<pm> exec` hook-free form + the per-PM
  // fail-closed floor + the runtime-residual disclosure), 738 B of new contract content against
  // 471 B of headroom, overflowing by 267 B after trimming — a documented KB-multiple bump, never
  // a silent re-pin. Then 17408 → 18432 (18 KB): AD-060 — the worktrees mode header lands in the
  // router (one line riding EVERY daily read set), overflowing gates by 67 B; the same documented
  // KB-multiple bump.
};
const DAILY = ['help', 'backends', 'recipes', 'procedures', 'gates'];

describe('router contract — D6 byte budgets hold over the real files (e)', () => {
  const routerBytes = bytesOf(join(kitRoot, 'SKILL.md'));

  it(`router ≤ ${BUDGET.router} B`, () => {
    assert.ok(routerBytes <= BUDGET.router, `router is ${routerBytes} B (> ${BUDGET.router})`);
  });

  for (const key of modeKeys) {
    it(`${key}: router+mode ≤ ${BUDGET.routerPlusMode} B and full read set ≤ ${BUDGET.fullReadSet} B`, () => {
      const modeBytes = bytesOf(join(MODES_DIR, `${key}.md`));
      const sharedBytes = parseRequires(readMode(key), `modes/${key}.md`)
        .map((d) => bytesOf(join(SHARED_DIR, d.slice(`${VAR}/references/shared/`.length))))
        .reduce((a, b) => a + b, 0);
      const pair = routerBytes + modeBytes;
      const full = pair + sharedBytes;
      assert.ok(pair <= BUDGET.routerPlusMode, `${key}: router+mode = ${pair} B (> ${BUDGET.routerPlusMode})`);
      assert.ok(full <= BUDGET.fullReadSet, `${key}: full read set = ${full} B (> ${BUDGET.fullReadSet})`);
    });
  }

  it(`the daily modes declare no shared files and stay ≤ ${BUDGET.daily} B with the router`, () => {
    for (const key of DAILY) {
      assert.deepEqual(parseRequires(readMode(key), `modes/${key}.md`), [],
        `${key} is a daily mode — it must not declare shared files`);
      const set = routerBytes + bytesOf(join(MODES_DIR, `${key}.md`));
      assert.ok(set <= BUDGET.daily, `${key}: daily read set = ${set} B (> ${BUDGET.daily})`);
    }
  });

  it('is non-vacuous: an inflated synthetic read set trips the same budget comparison (red→green probe)', () => {
    const inflated = routerBytes + BUDGET.routerPlusMode; // guaranteed over any real mode size
    assert.ok(!(inflated <= BUDGET.routerPlusMode), 'the budget comparison must reject an oversized read set');
  });
});

// ── (f) the shared command-shapes contract: the declaring set + the router's inline bar ──────
describe('router contract — command-shapes promptless bar (f)', () => {
  const SHAPES = `${VAR}/references/shared/command-shapes.md`;
  // Exactly the probe-instructing modes declare the contract (bootstrap's recon block, upgrade
  // step 1, velocity's version-status routing) — NOT universal: minimal modes stay minimal. The
  // pin is closed-world over the KNOWN probe-instructing modes; a future mode that instructs its
  // own improvised probes must be added to DECLARING at review — no mechanical catch exists for
  // it. The router's inline bar below covers only the shared stamp-read every mode routes through.
  const DECLARING = ['bootstrap', 'upgrade', 'velocity'];
  const SHAPES_TEXT = readShared('command-shapes.md');
  // The contract's own content pins: the promptless bar, the honest host/config-dependent
  // residual (never a promised prompt), the scope boundary, and the lens citation.
  const SHAPES_TOKENS = [
    'file-read tool', 'ONE plain undecorated command', 'one probe per invocation',
    'no redirects', 'no pipes', 'no command substitution', 'file-edit tools',
    'OUTSIDE this contract', 'plain pipeline per call', 'host/config-dependent',
    'read-lane may auto-approve', 'slip past a prefix allow rule',
  ];

  it('the probe-instructing modes — and ONLY those — declare command-shapes.md', () => {
    const declaring = modeKeys
      .filter((k) => parseRequires(readMode(k), `modes/${k}.md`).includes(SHAPES))
      .sort();
    assert.deepEqual(declaring, [...DECLARING].sort(),
      'the command-shapes declaring set drifted from the probe-instructing modes');
  });

  it('the router stamp-read carries the inline bar (file-read tool or one plain command)', () => {
    const slice = region(ROUTER, '### Version status & the two axes', '### Mode: ', 'router');
    assert.deepEqual(missingTokens(slice, ['file-read tool', 'ONE plain undecorated command']), []);
  });

  it('the contract file carries the promptless-bar tokens (content-pin)', () => {
    assert.deepEqual(missingTokens(SHAPES_TEXT, SHAPES_TOKENS), []);
  });

  it('the contract file promises NO guaranteed prompt (negative pin on the withdrawn claim)', () => {
    assert.ok(!SHAPES_TEXT.toLowerCase().includes('always prompts'),
      'the contract must state the host/config-dependent residual, never promise a prompt');
  });

  it('is non-vacuous: a doctored contract with a stripped token is reported missing (red→green probe)', () => {
    const doctored = SHAPES_TEXT.replaceAll('host/config-dependent', 'REDACTED');
    assert.deepEqual(missingTokens(doctored, SHAPES_TOKENS), ['host/config-dependent']);
  });

  it('the router References line labels every shared contract (references-label-map)', () => {
    // Closed-world basename → human-label map: keys must equal the real references/shared/ set,
    // every label must render in the router's ## References region.
    const LABELS = {
      'report-footer.md': 'report footer',
      'composition-handoff.md': 'composition hand-off',
      'deploy-tail.md': 'deploy tail',
      'command-shapes.md': 'command shapes',
    };
    assert.deepEqual(Object.keys(LABELS).sort(), [...sharedNames].sort(),
      'the basename → label map must cover exactly the real references/shared/ files');
    const refs = region(ROUTER, '## References', null, 'router');
    for (const label of Object.values(LABELS)) {
      assert.ok(refs.includes(label),
        `the router References region is missing the "${label}" shared-contract label`);
    }
  });
});
