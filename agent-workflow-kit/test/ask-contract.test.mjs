// F11 ask-contract pin (AD-042): the three bootstrap setup questions (visibility / conversational
// language / agent attribution) are asked as ONE structured multi-question prompt where the agent
// supports it (`AskUserQuestion`), each answer recorded individually, and NOTHING is written until
// all are answered — first-contact interruptions 3 → 1. Upgrade's two migration asks batch the
// same way ONLY when both AGENTS.md blocks are missing (a pre-1.1.0 deployment; the Attribution
// block marks pre-1.2.0, so the caveat keys on BLOCKS, not a version label), collected before the
// migration files are applied and never re-asked inside them.
//
// This is prose contract with no runtime, so the wording is pinned here (test-as-spec — the
// lens-mirror token + non-vacuity precedent). The kit and memory `references/contracts.md` ask
// paragraphs additionally stay BYTE-IDENTICAL: a hand-lockstep pair, deliberately NOT a
// sync-mirrors family (its family root would be wrong — scripts/sync-mirrors.mjs:51-77).
//
// Reads the full monorepo checkout (sibling packages present) — the lens-mirror /
// bridges-mirror cross-package precedent. Lives under test/ (never ships).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = join(HERE, '..');
const FAMILY_ROOT = join(KIT_ROOT, '..');

// The 7 files carrying ask-and-wait wording (the re-verified F11 site list; the 4 migration
// files are OUT — they carry single conditional standalone-fallback asks, batching lives in the
// orchestrators that sequence them).
const ASK_FILES = [
  ['kit bootstrap.md', join(KIT_ROOT, 'references', 'modes', 'bootstrap.md')],
  ['kit upgrade.md', join(KIT_ROOT, 'references', 'modes', 'upgrade.md')],
  ['kit contracts.md', join(KIT_ROOT, 'references', 'contracts.md')],
  ['memory contracts.md', join(FAMILY_ROOT, 'agent-workflow-memory', 'references', 'contracts.md')],
  ['memory SKILL.md', join(FAMILY_ROOT, 'agent-workflow-memory', 'SKILL.md')],
  ['kit deploy-tail.md', join(KIT_ROOT, 'references', 'shared', 'deploy-tail.md')],
  ['kit windsurf-workflow.md', join(KIT_ROOT, 'launchers', 'windsurf-workflow.md')],
];

// The batched-ask contract: the one-prompt instruction, the record-individually clause, and the
// write-nothing-until-all-answered clause.
const BATCH_TOKENS = [
  'ONE structured multi-question prompt',
  'record each answer individually',
  'write nothing until ALL are answered',
];

// The upgrade batching caveat: batch ONLY when both blocks are missing (pre-1.1.0); answers are
// collected before the migrations apply and a collected answer is never re-asked.
const UPGRADE_CAVEAT_TOKENS = [
  'both blocks are missing',
  'never re-asks',
  'a single missing block keeps its single ask',
];
const UPGRADE_CAVEAT_FILES = ['kit upgrade.md', 'memory SKILL.md'];

const read = (p) => readFileSync(p, 'utf8');
// Blockquote-aware flatten: `> `-wrapped preambles (memory SKILL.md) must not split a token, and
// markdown bold must not either; then whitespace-normalize + case-fold (router-contract style).
const flatten = (text) =>
  text.replace(/\n> ?/g, '\n').replaceAll('**', '').replace(/\s+/g, ' ').toLowerCase();
const missingTokens = (text, tokens) => {
  const haystack = flatten(text);
  return tokens.filter((t) => !haystack.includes(t.toLowerCase()));
};

describe('ask contract — the batched-ask tokens hold in all 7 F11 files (a)', () => {
  for (const [label, file] of ASK_FILES) {
    it(`${label} carries the one-prompt + record-individually + write-nothing clauses`, () => {
      assert.deepEqual(
        missingTokens(read(file), BATCH_TOKENS),
        [],
        `${label} (${file}) dropped batched-ask contract wording`,
      );
    });
  }
});

describe('ask contract — kit and memory contracts.md ask paragraphs stay byte-identical (b)', () => {
  // The paragraph is found by its distinctive token, not by line number — a moved paragraph is
  // still checked; two candidate paragraphs in one file is a loud failure, never a silent pick.
  const askParagraph = (text, where) => {
    const paras = text.split(/\n\n+/).filter((p) => p.includes('multi-question prompt'));
    assert.equal(paras.length, 1, `${where}: expected exactly ONE ask paragraph (got ${paras.length})`);
    return paras[0];
  };

  it('the ask paragraph is byte-identical across the hand-lockstep pair', () => {
    const kit = askParagraph(read(ASK_FILES[2][1]), 'kit contracts.md');
    const memory = askParagraph(read(ASK_FILES[3][1]), 'memory contracts.md');
    assert.equal(
      kit,
      memory,
      'kit references/contracts.md and memory references/contracts.md ask paragraphs diverged — ' +
        'this pair is hand-lockstep (NOT a sync-mirrors family); re-align the wording byte-for-byte',
    );
  });
});

describe('ask contract — the upgrade both-blocks-missing caveat + never-re-ask clause (c)', () => {
  for (const label of UPGRADE_CAVEAT_FILES) {
    const [, file] = ASK_FILES.find(([l]) => l === label);
    it(`${label} carries the both-blocks caveat and the never-re-ask clause`, () => {
      assert.deepEqual(
        missingTokens(read(file), UPGRADE_CAVEAT_TOKENS),
        [],
        `${label} (${file}) dropped the upgrade batching caveat wording`,
      );
    });
  }
});

describe('ask contract — non-vacuity: injected divergence goes red (d)', () => {
  // One-word corruptions that cannot span a line break, applied to EVERY occurrence — a drift can
  // never stay green by matching an accidental second occurrence (the lens-mirror precedent).
  const CORRUPTIONS = [
    ['multi-question', 'mono-question', 'ONE structured multi-question prompt'],
    ['individually', 'collectively', 'record each answer individually'],
    ['answered', 'answred', 'write nothing until ALL are answered'],
  ];

  it('a one-word in-memory drop is reported missing by the same checker, in every file', () => {
    for (const [label, file] of ASK_FILES) {
      const real = read(file);
      assert.deepEqual(missingTokens(real, BATCH_TOKENS), [], `sanity: ${label} is green before injection`);
      for (const [needle, replacement, token] of CORRUPTIONS) {
        const corrupted = real.replaceAll(needle, replacement);
        assert.notEqual(corrupted, real, `sanity: the corruption "${needle}" actually hits ${label}`);
        assert.deepEqual(
          missingTokens(corrupted, [token]),
          [token],
          `${label}: dropping "${token}" must go red — otherwise the pin is vacuous`,
        );
      }
    }
  });

  it('an injected byte divergence in the contracts.md pair is caught by the same comparator', () => {
    const kit = read(ASK_FILES[2][1]);
    const memory = read(ASK_FILES[3][1]);
    const kitPara = kit.split(/\n\n+/).filter((p) => p.includes('multi-question prompt'))[0];
    const memoryPara = memory
      .replace('multi-question prompt', 'multi-question  prompt') // two spaces — a one-byte drift
      .split(/\n\n+/)
      .filter((p) => p.includes('multi-question'))
      .find((p) => p.includes('multi-question  prompt'));
    assert.ok(kitPara, 'sanity: the kit ask paragraph exists');
    assert.ok(memoryPara, 'sanity: the drifted memory paragraph exists');
    assert.notEqual(kitPara, memoryPara, 'the byte comparison must reject a one-byte drift');
  });
});
