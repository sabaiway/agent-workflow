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

  // The kit 4.2.0 release failed HERE, one release after the ID fix landed. npm published, the tag
  // pushed, `gh release create --draft` succeeded and printed its `untagged-…` URL — and the very
  // next `draft_id` lookup, 1.2 seconds later, returned nothing. The releases LIST endpoint had not
  // caught up; minutes later the same query returned the draft with the correct tag_name. The draft
  // was left stranded exactly as in 4.1.0, for an entirely different reason.
  //
  // A single unretried read of an eventually-consistent endpoint is the defect. The lookup retries.
  // Extract a shell function body by NAME rather than by lexical position: slicing between two
  // `indexOf`s silently yields an empty string — and vacuously passing assertions — the moment
  // someone reorders the functions.
  const bodyOf = (name) => {
    const start = source.indexOf(`${name}() {`);
    assert.notEqual(start, -1, `${name}() is missing from the workflow`);
    const end = source.indexOf('\n          }', start);
    assert.notEqual(end, -1, `${name}() has no closing brace at the expected indent`);
    return source.slice(start, end);
  };

  it('the post-create lookup RETRIES with the pinned shape — a single read is the 4.2.0 defect', () => {
    const settled = bodyOf('draft_id_settled');
    assert.match(settled, /for _attempt in 1 2 3 4 5; do/u, 'five attempts, pinned — a one-shot loop would pass a looser check');
    assert.match(settled, /\[ "\$_attempt" = 5 \] \|\| sleep 3/u, 'back off 3s BETWEEN attempts, never after the last');
    assert.match(source, /id="\$\(draft_id_settled "\$1"\)"/u, 'undraft must use the retrying lookup');
  });

  it('the stranded-draft PROBE stays a single read — finding nothing is its normal answer', () => {
    // Retrying here would spend the full backoff on every green publish, where no draft existing is
    // exactly what is expected. Pinned from BOTH sides: the probe calls the plain form, and the
    // plain form itself must stay loop-free.
    assert.match(source, /existing_draft="\$\(draft_id "\$tag"\)"/u);
    const plain = bodyOf('draft_id');
    assert.doesNotMatch(plain, /\bfor\b|\bsleep\b|\bwhile\b/u, 'draft_id must stay a single read');
  });
});
