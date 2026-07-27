// publish-workflow.test.mjs — drift guard over the publish workflow's release step.
//
// The kit 4.1.0 release published to npm, pushed its tag, and then went RED on the very last line:
// `gh release edit "$tag" --draft=false`. A DRAFT release is not addressable by tag — gh answers
// "release not found" until it is published — so the un-draft must go through the API by release
// ID. The draft was published by hand afterwards. This test exists so the tag-addressed form cannot
// come back, in either of the two places that publish a draft.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = join(HERE, '..', '..', '.github', 'workflows', '_publish-one.yml');
const source = readFileSync(WORKFLOW, 'utf8');

describe('publish workflow — a draft release is published by ID, never by tag', () => {
  it('no `gh release edit <tag> --draft=false` survives anywhere', () => {
    const offenders = source
      .split('\n')
      .map((line, index) => [index + 1, line.trim()])
      .filter(([, line]) => line.includes('gh release edit') && line.includes('--draft=false'));
    assert.deepEqual(
      offenders,
      [],
      `a draft is not addressable by tag; use the undraft helper instead:\n${offenders.map(([n, l]) => `  :${n} ${l}`).join('\n')}`,
    );
  });

  it('the undraft helper resolves the release ID and PATCHes draft=false', () => {
    assert.match(source, /undraft\(\)\s*\{/u);
    assert.match(source, /draft_id\(\)\s*\{/u);
    assert.match(source, /select\(\.tag_name == \\"\$1\\" and \.draft\)/u);
    assert.match(source, /-X PATCH -F draft=false/u);
  });

  it('both publish paths call the helper — the create path and the complete-a-draft path', () => {
    const calls = source.split('\n').filter((line) => line.trim().startsWith('undraft "$tag"'));
    assert.equal(calls.length, 2, 'both the create path and the stranded-draft completion path must un-draft by ID');
  });

  it('the helper fails LOUDLY when no draft is found, never silently', () => {
    assert.match(source, /::error::no DRAFT release found for tag/u);
  });
});
