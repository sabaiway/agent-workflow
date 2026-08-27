// Contract under test: docs/ai/specs/bridges/agy-review-verdict.md (verdict-body honesty).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox, run, readReceipts, seedFedChangeSet, fedRun } from './agy-review-harness.test.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const CONTRADICTION_OUTPUT = '### Verdict\nSHIP WITH NITS — solid, two nits.\n### Blocking\n1. correctness: drops the last chunk\n2. security: path traversal in the staging dir\n### Non-blocking\nnone\n### Questions\nnone';

describe('agy-review.sh — a ship-class verdict cannot ride numbered Blocking findings', { concurrency: 2 }, () => {
  // spec:agy-review-verdict/S1
  it('a ship-class verdict beside a numbered Blocking item exits 4 with NO receipt — fresh and fed lanes alike', async () => {
    const fresh = makeSandbox();
    const r = await run(fresh, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_FAKE_OUTPUT: CONTRADICTION_OUTPUT } });
    const freshReceipts = readReceipts(fresh.repo);
    rmSync(fresh.home, { recursive: true, force: true });
    assert.equal(r.status, 4, r.stderr);
    assert.equal(r.invoked, true, 'the contradiction is judged AFTER the run — a failed review, not a pre-spend refusal');
    assert.equal(freshReceipts.length, 0, 'a contradictory run mints nothing');
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = await fedRun(sb, { AGY_FAKE_FINAL_APPEND: '### Blocking\n1. a numbered blocker the verdict ignores' });
    const fedReceipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 4, fed.stderr);
    assert.equal(fedReceipts.length, 0, 'the fed lane refuses the same shape after a PROVEN delivery');
  });

  // spec:agy-review-verdict/S2
  it('a Blocking body of none — any case, trailing punctuation — mints exactly as today', async () => {
    for (const noneForm of ['none', 'None.', 'NONE']) {
      const sb = makeSandbox();
      const output = `### Verdict\nSHIP WITH NITS — fine.\n### Blocking\n${noneForm}\n### Non-blocking\nnone\n### Questions\nnone`;
      const r = await run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_FAKE_OUTPUT: output } });
      const receipts = readReceipts(sb.repo);
      rmSync(sb.home, { recursive: true, force: true });
      assert.equal(r.status, 0, `"${noneForm}" must pass: ${r.stderr}`);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].verdict, 'SHIP WITH NITS');
    }
  });

  // spec:agy-review-verdict/S3
  it('REWORK is never refused by the cross-check, numbered Blocking items or not', async () => {
    const sb = makeSandbox();
    const output = '### Verdict\nREWORK — two real blockers.\n### Blocking\n1. the guard fails open\n2. the receipt lies\n### Non-blocking\nnone\n### Questions\nnone';
    const r = await run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_FAKE_OUTPUT: output } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(receipts.length, 1, 'a veto needs no corroboration');
    assert.equal(receipts[0].verdict, 'REWORK');
  });

  // spec:agy-review-verdict/S4
  it('an absent Blocking section is not a contradiction — the verdict-only read is unchanged', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_FAKE_OUTPUT: '### Verdict\nSHIP — clean, no sections beyond this one.' } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(receipts.length, 1, 'the shape mandate lives in the prompt; absence is not judged here');
    assert.equal(receipts[0].verdict, 'SHIP');
  });

  // spec:agy-review-verdict/S5
  it('the continuation lane refuses a contradictory verdict before its informational receipt', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['--continue'], env: { AGY_FAKE_OUTPUT: CONTRADICTION_OUTPUT } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 4, r.stderr);
    assert.equal(receipts.length, 0, 'a fresh:false receipt must not encode a contradiction either');
  });

  // spec:agy-review-verdict/S6
  it('the refusal names both halves and the verdict is never rewritten or downgraded', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_FAKE_OUTPUT: CONTRADICTION_OUTPUT } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 4);
    assert.match(r.stderr, /SHIP WITH NITS — solid, two nits\./, 'the RAW verdict line is named, reason text included');
    assert.match(r.stderr, /drops the last chunk/, 'the first numbered Blocking item is named');
    assert.match(r.stderr, /[Rr]e-run the review/, 'the recovery is the same as every failed review');
    assert.equal(receipts.length, 0, 'no rewritten or downgraded verdict is ever minted');
  });

  // spec:agy-review-verdict/S8
  it('a second Blocking heading terminates the scan — only the first section is judged', async () => {
    const sb = makeSandbox();
    const output = '### Verdict\nSHIP — clean.\n### Blocking\nnone\n### Blocking\n1. a numbered item under a duplicate heading\n### Questions\nnone';
    const r = await run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_FAKE_OUTPUT: output } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(receipts.length, 1, 'the first section said none — a later heading cannot suppress the receipt');
    assert.equal(receipts[0].verdict, 'SHIP');
  });

  // spec:agy-review-verdict/S7
  it('the loadable skill text names the closed verdict vocabulary', async () => {
    const skill = readFileSync(resolve(HERE, '..', 'SKILL.md'), 'utf8');
    assert.match(skill, /SHIP \/ SHIP WITH NITS \/ REWORK/, 'the closed vocabulary is spelled in SKILL.md, not only in --help and failure stderr');
  });
});
