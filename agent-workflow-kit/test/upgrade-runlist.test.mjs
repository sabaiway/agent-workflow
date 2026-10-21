// upgrade-runlist.test.mjs — the structure test over the upgrade step-3 run-list (feedback item 5).
//
// Two halves, one contract. (1) The registry's own shape: exactly the eight L1 operations, in the
// L1 order, kebab-case ids, the ONE command-path exception (`gates-migration` runs a
// references/scripts command; the other seven live under tools/), consent marked exactly where L1
// says so, and the `configs` outcome copy held equal to its owning vocabulary leaf. (2) The doc
// half, asserted against references/modes/upgrade.md step 3: the checklist opens the step BEFORE
// the first rationale block; checklist rows ↔ registry entries (same backticked ids, same order,
// each row carrying its registry command and naming its outcome vocabulary, a consent marker
// exactly on the consent-bearing rows); every backticked id anchors exactly one rationale block
// below; and every `node ${CLAUDE_SKILL_DIR}/…` command anywhere in step 3 is a registry command —
// prose cannot name an operation the checklist misses.
//
// Brittleness bound: ids + commands + order + the named outcome tokens, never wording. Canon
// mechanics: planning-canon.test.mjs (section slice + token asserts), init-refresh-lens.test.mjs
// (anchored regions, non-vacuous extraction). Dev-only repo test (test/ is outside files[]).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UPGRADE_RUNLIST } from '../tools/upgrade-runlist.mjs';
import { RELAYED_ENSURE_TOKENS } from '../tools/ensure-vocabulary.mjs';
import { SKIPPED_READONLY } from '../tools/setup-backends.mjs';
import { PARITY } from '../tools/refresh-parity.mjs';

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UPGRADE = readFileSync(resolve(kitRoot, 'references', 'modes', 'upgrade.md'), 'utf8');

// The L1 lock, restated here on purpose: the registry cannot re-order or rename an operation
// without this test noticing — the ids are the future reconcile driver's item tokens.
const L1_IDS = ['pointers', 'footprint', 'configs', 'gates-migration', 'bridges', 'lens', 'tier', 'bridge-settings'];
const SKILL_VAR = '${CLAUDE_SKILL_DIR}';
const CONSENT = "a replace line → ONE yes naming every file its block names, each edit's kept-aside copy and that the bundled body replaces it, asked even on a non-zero exit; on the yes run the printed line, then STOP if that run fails or an op it does not re-run failed; on a no STOP on any failed op.";
const REPLACE_COMMAND = `node ${SKILL_VAR}/tools/ensure-configs.mjs --reconcile --replace-custom <digest> --cwd <project>`;

// ── extraction helpers (anchored, non-vacuous: a missing anchor is red) ─────────────────────────
const between = (text, from, to, where) => {
  const a = text.indexOf(from);
  assert.notEqual(a, -1, `${where}: missing anchor "${from}"`);
  const b = text.indexOf(to, a + from.length);
  assert.notEqual(b, -1, `${where}: missing anchor "${to}"`);
  return text.slice(a, b);
};

// Step 3 of the top-level ordered list: from the "3. " line to the "4. " line (nested checklist
// rows are indented, so only the top-level step numbers match at column 0).
const step3 = () => between(UPGRADE, '\n3. ', '\n4. ', 'upgrade.md');

// A checklist row: an indented numbered line opening with a backticked id and its backticked
// registry command. Returns [{id, line, index}] in document order.
const ROW_RE = /^\s*\d+\.\s+`([a-z][a-z0-9-]*)` — `node \$\{CLAUDE_SKILL_DIR\}\//;
const rowsOf = (section) => {
  const rows = [];
  let offset = 0;
  for (const line of section.split('\n')) {
    const m = line.match(ROW_RE);
    if (m) rows.push({ id: m[1], line, index: offset });
    offset += line.length + 1;
  }
  return rows;
};

// Boundary-guarded token match (round-2 fold): a token never rides inside a longer word or a
// hyphenated sibling — `skipped` must not be satisfied by the `skipped-readonly` substring — and
// the token is regex-escaped before the boundaries are built.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasToken = (text, token) => new RegExp(`(?<![\\w-])${escapeRe(token)}(?![\\w-])`).test(text);

// A rationale anchor: a line opening (after indent) with a BOLD backticked id — distinct from the
// checklist grammar (rows open with a list number, anchors with `**`).
const anchorsOf = (section) => {
  const anchors = [];
  const re = /^\s*\*\*`([a-z][a-z0-9-]*)`/gm;
  for (const m of section.matchAll(re)) anchors.push({ id: m[1], index: m.index });
  return anchors;
};

const blockOf = (id) => {
  const section = step3();
  const anchors = anchorsOf(section);
  const at = anchors.findIndex((a) => a.id === id);
  assert.notEqual(at, -1, `step 3 anchors a \`${id}\` rationale block`);
  return section.slice(anchors[at].index, anchors[at + 1]?.index ?? section.length);
};

const listRegularFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = resolve(dir, entry.name);
  return entry.isDirectory() ? listRegularFiles(path) : entry.isFile() ? [path] : [];
});

// ── the registry's own shape ────────────────────────────────────────────────────────────────────
describe('upgrade-runlist registry — the L1 eight, in order', () => {
  it('carries exactly the eight L1 ids, in the L1 order', () => {
    assert.deepEqual(UPGRADE_RUNLIST.map((e) => e.id), L1_IDS);
  });

  it('every id is kebab-case', () => {
    for (const { id } of UPGRADE_RUNLIST) {
      assert.match(id, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, id);
    }
  });

  it('every entry is a frozen {id, command, consent, outcomes} record', () => {
    assert.ok(Object.isFrozen(UPGRADE_RUNLIST));
    for (const e of UPGRADE_RUNLIST) {
      assert.ok(Object.isFrozen(e), e.id);
      assert.ok(Object.isFrozen(e.outcomes), e.id);
      assert.deepEqual(Object.keys(e).sort(), ['command', 'consent', 'id', 'outcomes'], e.id);
      assert.ok(e.command.length > 0, e.id);
      assert.ok(e.outcomes.length > 0, e.id);
      for (const token of e.outcomes) assert.ok(typeof token === 'string' && token.length > 0, e.id);
    }
  });

  it('seven commands live under tools/; the ONE exception is gates-migration (references/scripts)', () => {
    for (const e of UPGRADE_RUNLIST) {
      if (e.id === 'gates-migration') {
        assert.ok(
          e.command.startsWith(`node ${SKILL_VAR}/references/scripts/migrate-gates.mjs`),
          'gates-migration runs the deployed-canon migration script, not a tools/ command',
        );
      } else {
        assert.ok(e.command.startsWith(`node ${SKILL_VAR}/tools/`), `${e.id}: ${e.command}`);
      }
    }
  });

  it('consent marks exactly the four L1 operations: footprint, configs, gates-migration and tier', () => {
    for (const e of UPGRADE_RUNLIST) {
      if (e.id === 'footprint') {
        assert.ok(typeof e.consent === 'string' && e.consent.includes('--dry-run'),
          'footprint consent gates the non-dry-run re-run');
      } else if (e.id === 'configs') {
        assert.equal(e.consent, `${CONSENT} The printed line: ${REPLACE_COMMAND}`);
      } else if (e.id === 'gates-migration') {
        assert.ok(typeof e.consent === 'string' && e.consent.includes('--apply'),
          'gates-migration consent gates the --apply re-run');
      } else if (e.id === 'tier') {
        assert.ok(typeof e.consent === 'string' && e.consent.includes('--apply') && e.consent.includes('--decline'),
          'tier consent gates the --apply and the --decline re-run');
      } else {
        assert.equal(e.consent, null, `${e.id} carries no consent gate`);
      }
    }
  });

  it('the configs outcome copy equals the owning vocabulary leaf (RELAYED_ENSURE_TOKENS)', () => {
    const configs = UPGRADE_RUNLIST.find((e) => e.id === 'configs');
    assert.deepEqual([...configs.outcomes], [...RELAYED_ENSURE_TOKENS]);
  });

  it('the bridges outcomes track the live refresh vocabulary (skipped-readonly)', () => {
    const bridges = UPGRADE_RUNLIST.find((e) => e.id === 'bridges');
    assert.ok(bridges.outcomes.includes(SKIPPED_READONLY));
    // The parity verdicts ride the skipped-readonly LINE, not the outcome set — they must not leak
    // into the checklist vocabulary (the rationale block owns them).
    for (const verdict of Object.values(PARITY)) {
      assert.ok(!bridges.outcomes.includes(verdict), verdict);
    }
  });
});

// ── the doc half: upgrade.md step 3 renders the registry ────────────────────────────────────────
describe('upgrade.md step 3 — a normative run-list rendered from the registry', () => {
  const section = step3();
  const rows = rowsOf(section);
  const anchors = anchorsOf(section);

  it('(a) the checklist opens step 3 before the first rationale block', () => {
    assert.ok(rows.length > 0, 'step 3 opens with a checklist of registry rows');
    assert.ok(anchors.length > 0, 'step 3 carries per-operation rationale blocks');
    const lastRow = rows[rows.length - 1];
    const firstAnchor = anchors[0];
    assert.ok(lastRow.index < firstAnchor.index,
      'every checklist row precedes every rationale block');
  });

  it('(b) checklist rows ↔ registry entries: same ids, same order', () => {
    assert.deepEqual(rows.map((r) => r.id), UPGRADE_RUNLIST.map((e) => e.id));
  });

  it('(b) each row carries its registry command', () => {
    for (const e of UPGRADE_RUNLIST) {
      const row = rows.find((r) => r.id === e.id);
      assert.ok(row, `a checklist row for \`${e.id}\``);
      assert.ok(row.line.includes(`\`${e.command}\``), `${e.id}: the row quotes the exact command`);
    }
  });

  it('(b) each row names its outcome vocabulary', () => {
    for (const e of UPGRADE_RUNLIST) {
      const row = rows.find((r) => r.id === e.id);
      assert.ok(row, `a checklist row for \`${e.id}\``);
      for (const token of e.outcomes) {
        assert.ok(hasToken(row.line, token), `${e.id}: the row names outcome "${token}" (boundary-guarded)`);
      }
    }
  });

  it('(b) a consent marker rides exactly the consent-bearing rows', () => {
    for (const e of UPGRADE_RUNLIST) {
      const row = rows.find((r) => r.id === e.id);
      assert.ok(row, `a checklist row for \`${e.id}\``);
      if (e.consent === null) {
        assert.ok(!/consent/i.test(row.line), `${e.id}: no consent marker on a consent-free row`);
      } else {
        assert.ok(/consent/i.test(row.line), `${e.id}: the row carries its consent marker`);
      }
    }
  });

  it('(c) every backticked id anchors exactly one rationale block below the checklist', () => {
    for (const e of UPGRADE_RUNLIST) {
      const mine = anchors.filter((a) => a.id === e.id);
      assert.equal(mine.length, 1, `\`${e.id}\` anchors exactly one rationale block (got ${mine.length})`);
    }
    for (const a of anchors) {
      assert.ok(L1_IDS.includes(a.id), `rationale anchor \`${a.id}\` is a registry id`);
    }
  });

  it('(d) every node ${CLAUDE_SKILL_DIR}/… command in step 3 is a registry command', () => {
    const registryScripts = new Set(UPGRADE_RUNLIST.map((e) => e.command.split(' ')[1]));
    const named = [...section.matchAll(/node (\$\{CLAUDE_SKILL_DIR\}\/[^\s`]+)/g)].map((m) => m[1]);
    assert.ok(named.length >= UPGRADE_RUNLIST.length, 'the step names at least the eight registry commands');
    for (const script of named) {
      assert.ok(registryScripts.has(script),
        `step 3 names "${script}" — prose cannot run an operation the checklist misses`);
    }
  });
});

// ── the tier item: its registry entry and its one ask (spec kit/tier/tier-offer, part lineage-step) ──
describe('spec:tier-offer/S14 the tier item runs the offer and puts its one ask', () => {
  it('the tier entry follows lens with the preview command, the two re-runs and the offer words', () => {
    const ids = UPGRADE_RUNLIST.map((e) => e.id);
    assert.equal(ids.indexOf('tier'), ids.indexOf('lens') + 1);
    const tier = UPGRADE_RUNLIST.find((e) => e.id === 'tier');
    assert.equal(tier.command, `node ${SKILL_VAR}/tools/tier-preview.mjs --cwd <project>`);
    assert.ok(tier.consent.includes('every other offered line'), tier.consent);
    assert.deepEqual([...tier.outcomes], ['present', 'offered', 'declined', 'undecidable', 'applied', 'recorded', 'refused']);
  });

  for (const token of ['`offered`', '`--apply`', '`--decline`', '`story-sessions-section`', '`declined`', 'Communication', '`refused`', 're-stamp']) {
    it(`the tier block names ${token}`, () => {
      assert.ok(blockOf('tier').includes(token), `the \`tier\` block names ${token}`);
    });
  }

  it('the lens block hands its explicit-yes ask to the tier item', () => {
    assert.ok(blockOf('lens').includes('`tier`'), 'the lens block names the `tier` ask');
  });
});

// A clause a copy or refresh verb, a script, pair or scripts/ path and "by hand" share; comment lines are not shipped text.
const CLAUSE_SPLIT = /\.(?=\s|$)|[;:—!?()→]/;
const HAND_COPY = /\b(?:cop(?:y|ies|ied|ying)|refresh(?:es|ed|ing)?)\b.*(?:\b(?:scripts?|pairs?)\b|\bscripts\/).*\bby hand\b/i;
const handCopyClauses = (line) => (/^\s*(?:\/\/|\/?\*)/.test(line) ? [] : line.split(CLAUSE_SPLIT).filter((clause) => HAND_COPY.test(clause)));

describe('spec:distribution-files/S10 the upgrade asks one yes over the replace block and no line says copy by hand', () => {
  it('the configs entry carries the one-yes sentence and the exact replace command; the upgrade.md row the sentence alone', () => {
    const { consent } = UPGRADE_RUNLIST.find((e) => e.id === 'configs');
    assert.equal(consent, `${CONSENT} The printed line: ${REPLACE_COMMAND}`);
    const row = rowsOf(step3()).find((r) => r.id === 'configs');
    assert.ok(row?.line.includes(CONSENT), 'the configs row carries the one-yes sentence verbatim');
    assert.ok(!row.line.includes('--replace-custom'), 'the exact replace command belongs to the registry alone');
  });
  it('the configs block has exactly one STOP sentence and it defers to the row 3 ask over a replace line', () => {
    const block = blockOf('configs').replaceAll('**', '');
    assert.equal((block.match(/STOP/g) ?? []).length, 1);
    assert.ok(block.includes("A non-zero exit STOPs this upgrade — once row 3's replace ask is answered when a replace line printed, then as that ask says"));
  });
  it("the spec-layer paragraph keeps edits aside on row 3's yes; contracts.md names the family's reserved folder", () => {
    const paragraph = step3().split('\n').find((line) => line.trim().startsWith('**What the spec-layer ensure does.**'));
    assert.ok(paragraph?.includes("edited files are kept aside and replaced on row 3's yes"), paragraph);
    const contracts = readFileSync(resolve(kitRoot, 'references', 'contracts.md'), 'utf8');
    assert.ok(contracts.includes("`.agent-workflow/` is the family's reserved folder") && contracts.includes('`.agent-workflow/kept-aside/<16 hex>/<path>`'));
  });
  it('no shipped line says to copy or refresh a script by hand', () => {
    const files = [resolve(kitRoot, 'tools'), resolve(kitRoot, 'references'), resolve(kitRoot, '..', 'agent-workflow-memory', 'references')].flatMap(listRegularFiles);
    const matches = [...files, resolve(kitRoot, '..', 'agent-workflow-memory', 'SKILL.md')].filter((file) => !/\.test\.mjs$|\.test\//.test(file)).flatMap((file) =>
      readFileSync(file, 'utf8').split('\n').flatMap((line, index) => (handCopyClauses(line).length > 0 ? [`${file}:${index + 1}: ${line}`] : [])));
    assert.deepEqual(matches, [], matches.join('\n'));
  });
  it('the judge catches a hand copy of a pair or a scripts/ path and spares the No-Node pointer paragraph', () => {
    assert.deepEqual(['copy the pair by hand, then re-run', 'refresh scripts/check-docs-size.mjs by hand', '// copy the pair by hand'].map((line) => handCopyClauses(line).length), [1, 1, 0]);
    const noNode = step3().split('\n').find((line) => line.includes('**No-Node project:**'));
    assert.ok(noNode?.includes('by hand') && /pair/.test(noNode) && /copy/.test(noNode), 'the spared paragraph names a pair, a copy and by hand');
    assert.deepEqual(handCopyClauses(noNode), []);
  });
});

describe('spec:docs-navigator/S4 the configs block and the spec-adoption item name the replace yes', () => {
  it('the index token list names customized-preserved', () => {
    assert.ok(blockOf('configs').includes('index → `regenerated` / `already-current` / `customized-preserved`'));
  });
  it('the spec-adoption example and risk text name the replace yes', () => {
    const lines = readFileSync(resolve(kitRoot, 'references', 'modes', 'recommendations.md'), 'utf8').split('\n');
    const rule = lines.find((line) => line.startsWith('3. '));
    const posture = lines.find((line) => line.startsWith('- `spec-adoption` — '));
    const replaceWords = 'prints a replace line that takes its own yes';
    assert.ok(rule?.includes("`spec-adoption`'s `ensure-configs --reconcile --only specs`"), 'rule 3 carries the spec-adoption example');
    assert.ok(rule.includes(replaceWords), 'rule 3 names the replace yes');
    assert.ok(posture?.includes(replaceWords), 'the spec-adoption posture names the replace yes');
    assert.ok(posture.split('Risk profile:')[1]?.includes('refreshes a script body a release shipped'), 'the risk profile names the prior refresh');
  });
});

// ── steps 4 and 8: the report enumerations cover every run-list operation (round-2 fold) ────────
// The run-list closes the "prose cannot miss an operation" hole for step 3; without this half the
// REPORT steps could still silently omit one. The ids are structural labels of the instruction —
// the user-facing report itself stays plain language (the steps' own wording).
describe('upgrade.md steps 4 and 8 — the reports name every run-list operation', () => {
  const step4 = () => between(UPGRADE, '\n4. ', '\n5. ', 'upgrade.md step 4');
  const step8 = () => {
    const at = UPGRADE.indexOf('\n8. ');
    assert.notEqual(at, -1, 'upgrade.md: missing anchor "\\n8. "');
    return UPGRADE.slice(at);
  };
  for (const id of L1_IDS) {
    it(`step 4 names \`${id}\``, () => {
      assert.ok(step4().includes(`\`${id}\``), `step 4 reports the \`${id}\` outcome`);
    });
    it(`step 8 names \`${id}\``, () => {
      assert.ok(step8().includes(`\`${id}\``), `step 8 reports the \`${id}\` outcome`);
    });
  }
  it('the boundary guard is non-vacuous: skipped is not satisfied by skipped-readonly (injected)', () => {
    assert.equal(hasToken('lines: `skipped-readonly` only', 'skipped'), false);
    assert.equal(hasToken('lines: skipped — with its stated reason', 'skipped'), true);
  });
});

// ── non-vacuity: the extractors flag what they exist to flag (injected red→green proof) ─────────
describe('the extractors are non-vacuous', () => {
  const SYNTH = [
    '\n3. **Run the list.**',
    '',
    '   1. `pointers` — `node ${CLAUDE_SKILL_DIR}/tools/inject-methodology.mjs reconcile <project>/AGENTS.md` → added',
    '',
    '   **`pointers` — why.** Because.',
    '\n4. next step',
  ].join('\n');

  it('a synthetic step 3 yields its row and its anchor', () => {
    const section = between(SYNTH, '\n3. ', '\n4. ', 'synthetic');
    assert.deepEqual(rowsOf(section).map((r) => r.id), ['pointers']);
    assert.deepEqual(anchorsOf(section).map((a) => a.id), ['pointers']);
  });

  it('a stripped row / a stripped anchor is reported missing', () => {
    const noRow = between(SYNTH.replace('`pointers` — `node', 'pointers — node'), '\n3. ', '\n4. ', 'doctored');
    assert.deepEqual(rowsOf(noRow), []);
    const noAnchor = between(SYNTH.replace('**`pointers`', '**pointers'), '\n3. ', '\n4. ', 'doctored');
    assert.deepEqual(anchorsOf(noAnchor), []);
  });
});
