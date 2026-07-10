// SKILL.md is the procedure an agent EXECUTES — its load-bearing contract lines need pins the same
// way code constants do (the doc-parity idea, memory-side). Pins here are token-level: tight enough
// to fail when the contract line is dropped or inverted, loose enough to survive prose rewording.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'SKILL.md'), 'utf8');

describe('SKILL.md upgrade contract — the ADR-store enforcement-pair ensure (AD-051)', () => {
  it('the pair ensure carries the legacy-monolith gate (never seed the new rotator beside un-migrated monoliths)', () => {
    const ensureIdx = SKILL.indexOf('ensure the ADR-store enforcement pair');
    assert.ok(ensureIdx !== -1, 'the enforcement-pair ensure block exists');
    const block = SKILL.slice(ensureIdx, ensureIdx + 2400);
    assert.match(block, /decisions-archive\*\.md/, 'the gate names the legacy monolith glob');
    assert.match(
      block,
      /never sit beside\s+un-migrated monoliths/,
      'the gate states the invariant: the new-scheme rotator never sits beside un-migrated monoliths',
    );
    assert.match(
      block,
      /--migrate --apply/,
      'the gate routes a consenting standalone deployment through the one-time migration in the same step',
    );
    assert.match(
      block,
      /without consent leave\s+the tree untouched/i,
      'declining consent leaves the tree untouched (reported, never half-done)',
    );
  });
});

describe('SKILL.md upgrade contract — the consented legacy-migration path is failure-safe', () => {
  it('a failed consented migration rolls back the just-copied pair (never left beside un-migrated monoliths)', () => {
    const gateIdx = SKILL.indexOf('Legacy-monolith');
    assert.ok(gateIdx !== -1, 'the legacy-monolith gate exists');
    const block = SKILL.slice(gateIdx, gateIdx + 1600);
    assert.match(
      block,
      /remove the just-copied pair/i,
      'a failed preview/apply rolls the copy back — the forbidden new-rotator-beside-monoliths state never persists',
    );
  });
});
