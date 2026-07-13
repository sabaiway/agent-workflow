// Contract guard for the report-facts surface (REPORT-FACTS train, Item A / D1–D3). Any claim a
// bootstrap / upgrade / recommendations report makes about the CURRENT host or session state must
// trace to live tool output from THIS session, never a memory/handover snapshot — the AD-034 "the
// registry computes, the tools speak, the agent pastes" doctrine at the report point of use. There
// is no runtime that executes the SKILL prose, so this static text-drift guard is the automatable
// half of "No changes without tests" for a prose contract (report-contract.test.mjs precedent).
//
// It pins the SINGLE-HOME shape (D2): the full clause lives in report-footer.md carrying footer-only
// detail tokens; each mode surface carries EXACTLY ONE compact binding line with the pinned tokens
// and NONE of the footer-only detail. The memory template's §2.5 Communication bullet is bound here
// too (D3/D6), so the whole report-facts contract lives in one checker.
//
// Dev-only repo test (test/ is outside the package `files` whitelist — not shipped in the tarball).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(kitRoot, rel), 'utf8');

const FOOTER = read('references/shared/report-footer.md');
const UPGRADE = read('references/modes/upgrade.md');
const RECOMMENDATIONS = read('references/modes/recommendations.md');
const KIT_TEMPLATE = read('references/templates/agent_rules.md');
// The report-facts §2.5 Communication bullet lives ONLY in the memory-package template twin (D6).
const MEMORY_TEMPLATE = readFileSync(
  resolve(kitRoot, '..', 'agent-workflow-memory', 'references', 'templates', 'agent_rules.md'),
  'utf8',
);

// Slice between two anchors (report-contract.test.mjs precedent — a missing anchor is red).
const between = (text, from, to) => {
  const a = text.indexOf(from);
  assert.notEqual(a, -1, `missing anchor: "${from}"`);
  const b = to ? text.indexOf(to, a + from.length) : text.length;
  assert.notEqual(b, -1, `missing anchor: "${to}"`);
  return text.slice(a, b);
};
const flat = (s) => s.replace(/\s+/g, ' ');
const countOccurrences = (text, token) => text.split(token).length - 1;

// The pinned tokens — present on all four kit surfaces + the memory template bullet (D2).
const PINNED_TOKENS = [
  'live tool output',
  'this session',
  'omitted or explicitly marked unverified',
  'context, never report facts',
];
// The footer-only detail tokens — the single-home proof: PRESENT in the footer clause, ABSENT from
// every compact mode-file binding line (the meaning lives in ONE home, the modes only point).
const FOOTER_ONLY_TOKENS = [
  'records what was true when written',
  'back-filled from a snapshot',
];
// One pinned token doubles as the binding-line marker used to cardinality-assert a single line.
const BINDING_MARKER = 'context, never report facts';

const footerClause = flat(between(FOOTER, '### Live host/session facts', ''));
const upgradeStep4 = flat(between(UPGRADE, 'Equal-head exit', '5. Show the relevant'));
const upgradeStep8 = flat(between(UPGRADE, '8. Re-stamp', ''));
const recommendations = flat(RECOMMENDATIONS);
const memoryComms = flat(between(MEMORY_TEMPLATE, '### 2.5. Communication', '### 2.6'));

describe('report-facts contract — the full clause lives in report-footer.md (D1)', () => {
  it('the footer clause carries every pinned token', () => {
    for (const token of PINNED_TOKENS) {
      assert.ok(footerClause.includes(token), `the footer clause is missing the pinned token "${token}"`);
    }
  });
  it('the footer clause carries the footer-only detail tokens (the single home)', () => {
    for (const token of FOOTER_ONLY_TOKENS) {
      assert.ok(footerClause.includes(token), `the footer clause is missing the footer-only token "${token}"`);
    }
  });
});

describe('report-facts contract — each mode surface binds via ONE compact line (D2)', () => {
  const SURFACES = [
    ['upgrade.md step 4', upgradeStep4],
    ['upgrade.md step 8', upgradeStep8],
    ['recommendations.md', recommendations],
  ];
  for (const [label, region] of SURFACES) {
    it(`${label} carries every pinned token`, () => {
      for (const token of PINNED_TOKENS) {
        assert.ok(region.includes(token), `${label} is missing the pinned token "${token}"`);
      }
    });
    it(`${label} carries EXACTLY ONE binding, all pinned tokens clustered in it (single-home cardinality)`, () => {
      assert.equal(countOccurrences(region, BINDING_MARKER), 1,
        `${label} must carry exactly one report-facts binding`);
      // Prove the tokens sit in the SAME binding as the marker, not merely somewhere in the region.
      const at = region.indexOf(BINDING_MARKER);
      const binding = region.slice(Math.max(0, at - 340), at + 340);
      for (const token of PINNED_TOKENS) {
        assert.ok(binding.includes(token),
          `${label}: the pinned token "${token}" must sit in the same binding as the marker, not scattered`);
      }
    });
    it(`${label} re-copies NONE of the footer-only detail (the meaning stays in the footer home)`, () => {
      for (const token of FOOTER_ONLY_TOKENS) {
        assert.ok(!region.includes(token),
          `${label} re-copies the footer-only token "${token}" — keep the single home`);
      }
    });
  }
});

describe('report-facts contract — recommendations.md loads the footer clause it points at (D1)', () => {
  it('recommendations.md Requires: the report-footer shared file', () => {
    const requires = RECOMMENDATIONS.split('\n').filter((l) => l.startsWith('Requires: '));
    assert.equal(requires.length, 1, 'recommendations.md declares exactly one Requires: line');
    assert.match(requires[0], /references\/shared\/report-footer\.md/,
      'recommendations.md must Require the report-footer clause its binding line points at');
  });
});

describe('report-facts contract — the memory template §2.5 bullet is the only Communication twin (D3/D6)', () => {
  it('the memory template §2.5 Communication carries the report-facts bullet with every pinned token', () => {
    for (const token of PINNED_TOKENS) {
      assert.ok(memoryComms.includes(token), `the memory template §2.5 bullet is missing the pinned token "${token}"`);
    }
  });
  it('the kit template carries NO Communication section (D6 — the twin lives in memory only)', () => {
    assert.ok(!/###\s*2\.\d+\.\s*Communication/.test(KIT_TEMPLATE),
      'the kit template must not gain a Communication section (D6)');
  });
});
