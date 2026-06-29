import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Contract guard for the SKILL.md `status` render surface (Plan §4.4 INV). Wiring `Mode: status` onto
// the additive `installed[].refresh` must NOT silently rewrite the SHARED notes-based surfaces — the
// version block and the bootstrap/upgrade report footers stay `notes`-based this release (their refresh
// migration is deferred). This grep pins both halves of that contract so a future edit can't drift one
// without the other failing loudly.
const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', 'SKILL.md');

describe('SKILL.md — status reads refresh; the shared notes-based footers stay untouched', () => {
  let skill;
  before(() => {
    skill = readFileSync(SKILL, 'utf8');
  });

  it('Mode: status now keys freshness on installed[].refresh (behind + recommend)', () => {
    assert.match(skill, /refresh\.behind/, 'status must read refresh.behind for the headline count');
    assert.match(skill, /refresh\.recommend/, 'status must show the verbatim refresh.recommend command');
  });

  it('Mode: status does NOT also paste the English notes caveats (no command duplication on the agent surface)', () => {
    assert.match(skill, /do not also paste the English `notes` caveats/i);
  });

  it('the shared VERSION BLOCK is unchanged — still appends installed[].notes verbatim', () => {
    assert.match(skill, /Append any `installed\[\]\.notes`/, 'the shared version block must stay notes-based');
  });

  it('the welcome-mat next-step is unchanged — still keys on an installed[].notes caveat', () => {
    assert.match(skill, /`installed\[\]\.notes` caveat fired/, 'the bootstrap/upgrade welcome mat must stay notes-based');
  });
});
