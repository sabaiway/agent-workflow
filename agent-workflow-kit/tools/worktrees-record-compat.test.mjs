// worktrees-record-compat.test.mjs — the record gained orientation fields, so a record written by
// an EARLIER kit now round-trips through a refresh (land --prepare re-writes the section from the
// PARSED record). An absent field must stay absent, never render as the string "null".

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeHandoffStub, parseProvisionRecord } from './worktrees.mjs';

// Exactly the five-field section an earlier kit wrote — no install / shared-queue / landing.
const LEGACY_RECORD = [
  '# Handoff — legacy',
  '',
  'provisioned, nothing done yet',
  '',
  '## Provision record',
  '',
  '- slug: legacy',
  '- branch: aw/legacy',
  '- include: (none)',
  '- node_modules: symlinked',
  '- vscode-settings: written',
  '',
].join('\n');

describe('provision record — a record from an earlier kit survives a refresh', () => {
  it('a refreshed legacy record never renders an absent field as "null"', () => {
    const parsed = parseProvisionRecord(LEGACY_RECORD);
    const refreshed = composeHandoffStub({ ...parsed, prepared: 'deadbeef' });
    assert.doesNotMatch(refreshed, /: null$/m, 'an absent orientation field must be omitted, not rendered as "null"');
    assert.match(refreshed, /- slug: legacy/, 'the identity fields still round-trip');
    assert.match(refreshed, /- prepared-tree: deadbeef/, 'and so does the prepared OID');
  });

  it('a refreshed legacy record re-parses to the same identity', () => {
    const parsed = parseProvisionRecord(LEGACY_RECORD);
    const reparsed = parseProvisionRecord(composeHandoffStub({ ...parsed, prepared: 'deadbeef' }));
    assert.equal(reparsed.slug, 'legacy');
    assert.equal(reparsed.branch, 'aw/legacy');
    assert.equal(reparsed.nodeModules, 'symlinked');
    assert.equal(reparsed.prepared, 'deadbeef');
  });
});
