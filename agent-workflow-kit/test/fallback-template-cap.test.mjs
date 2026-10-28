import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The kit's fallback entry-point template carries no line cap any more: the kit's one block in a
// deployed AGENTS.md is written by the reconcile with no length judged (spec entry-pointers), so the
// template keeps no slot pair for it to fill and no footer promising a line budget. Memory's template
// is held to the same by agent-workflow-memory/scripts/standalone-bootstrap.test.mjs.
const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = [['kit', join(KIT_ROOT, 'references', 'templates', 'AGENTS.md')]];
const SLOT_LINE = /^\s*<!--\s*workflow:(?:methodology|orchestration|autonomy):(?:start|end)\s*-->\s*$/;
const CAP_FOOTER = /≤\s*\d+\s*lines|<=\s*\d+\s*lines/i;

describe('kit fallback entry-point template — no slot pairs and no line-cap footer', () => {
  for (const [label, file] of TEMPLATES) {
    it(`the ${label} template carries no workflow:methodology, workflow:orchestration or workflow:autonomy comment line`, () => {
      assert.deepEqual(readFileSync(file, 'utf8').split('\n').filter((line) => SLOT_LINE.test(line)), []);
    });

    it(`the ${label} template carries no line-cap footer`, () => {
      assert.deepEqual(readFileSync(file, 'utf8').split('\n').filter((line) => CAP_FOOTER.test(line)), []);
    });
  }

  it('non-vacuity: a slot pair and the old footer pasted into a copy are caught (injected)', () => {
    const doctored = ['<!-- workflow:orchestration:start -->', '**Rule:** This file stays CONCISE (≤100 lines).'];
    assert.deepEqual([SLOT_LINE.test(doctored[0]), CAP_FOOTER.test(doctored[1])], [true, true]);
  });
});
