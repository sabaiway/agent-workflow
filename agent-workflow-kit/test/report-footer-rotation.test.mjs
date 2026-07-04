// F10a rotation-parity pin (AD-042): the welcome-mat ladder has ONE canonical home —
// references/shared/report-footer.md — and its command set (`setup` / `recipes` / `velocity` /
// `agents` / `hook`) is restated in exactly two mode files: upgrade.md (step-4 shorthand) and
// bootstrap.md (step-11 shorthand). Recon found the three spellings had already diverged once
// (upgrade carried a 3-command shorthand while bootstrap enumerated 2 of them in extended text);
// this pin closes that gap: the canonical region carries every ladder command, and BOTH
// restatements carry the SAME shorthand literal. Non-vacuous (injected drop goes red).
//
// Dev-only repo test (test/ is outside the package `files` whitelist — not shipped).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(KIT_ROOT, rel), 'utf8');

const FOOTER = 'references/shared/report-footer.md';
const RESTATEMENT_FILES = ['references/modes/upgrade.md', 'references/modes/bootstrap.md'];

// The ladder command set, pinned as full invocations inside the canonical ladder region.
const LADDER_COMMANDS = ['setup', 'recipes', 'velocity', 'agents', 'hook'];
// The ONE shorthand literal both restatements carry — byte-identical, so the two mode files can
// never drift from each other or from the canonical command set again.
const RESTATEMENT =
  'a behind member first, else `setup` / `recipes` / `velocity` / `agents` / `hook`';

// The canonical ladder region: from the welcome-mat heading to the next section heading. Asserted
// anchors — a renamed heading fails loudly, never matches nothing (router-contract precedent).
const ladderRegion = (text, where) => {
  const from = '**Welcome mat';
  const to = '### Version disclosure';
  const a = text.indexOf(from);
  assert.notEqual(a, -1, `${where}: missing region anchor "${from}"`);
  const b = text.indexOf(to, a);
  assert.notEqual(b, -1, `${where}: missing region anchor "${to}"`);
  return text.slice(a, b);
};

const missingCommands = (regionText) =>
  LADDER_COMMANDS.filter((cmd) => !regionText.includes(`/agent-workflow-kit ${cmd}`));

describe('report-footer rotation parity — the ladder command set holds everywhere', () => {
  it(`the canonical ladder region (${FOOTER}) carries every ladder command as a full invocation`, () => {
    assert.deepEqual(
      missingCommands(ladderRegion(read(FOOTER), FOOTER)),
      [],
      `${FOOTER} welcome-mat region dropped a ladder command`,
    );
  });

  for (const rel of RESTATEMENT_FILES) {
    it(`${rel} carries the exact shorthand restatement`, () => {
      assert.ok(
        read(rel).includes(RESTATEMENT),
        `${rel} must carry the byte-identical ladder shorthand: ${RESTATEMENT}`,
      );
    });
  }

  it('non-vacuity: dropping one command from the region or the restatement goes red (injected)', () => {
    const real = ladderRegion(read(FOOTER), FOOTER);
    assert.deepEqual(missingCommands(real), [], 'sanity: the real region is green before injection');
    const corrupted = real.replaceAll('/agent-workflow-kit agents', '/agent-workflow-kit REDACTED');
    assert.notEqual(corrupted, real, 'sanity: the corruption actually hits the region');
    assert.deepEqual(missingCommands(corrupted), ['agents'], 'a dropped rung command must be reported');
    const drifted = RESTATEMENT.replace(' / `agents`', '');
    assert.ok(!read(RESTATEMENT_FILES[0]).includes(drifted + 'X'), 'sanity: probe string is synthetic');
    assert.notEqual(drifted, RESTATEMENT, 'a drifted shorthand is not the pinned literal');
  });
});
