import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKER_CLAIM, classifyCheckerClaim } from './checker-claim.mjs';

const loaded = await import('./gates-declaration.mjs').catch(() => ({}));
const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = mkdtempSync(join(tmpdir(), 'gates-declaration-'));
after(() => rmSync(PROJECT, { recursive: true, force: true }));
const CLAIMS = [
  ['control-bytes', 'control-bytes.mjs', '--check'],
  ['plan-shape', 'plan-shape-cli.mjs', '--check --in-flight'],
  ['spec-check', 'spec-check-cli.mjs', '--all'],
  ['spec-coverage', 'spec-coverage-cli.mjs', '--check'],
];
const claims = () => {
  assert.ok(Array.isArray(loaded.KIT_CHECKER_CLAIMS), 'gates-declaration.mjs KIT_CHECKER_CLAIMS is absent');
  return loaded.KIT_CHECKER_CLAIMS;
};
const gate = (cmd) => ({ id: 'any', title: 'any', cmd });
const canonicalCmd = (basename, tail) => `node "${join(HERE, basename)}" ${tail}`;
const vendoredCmd = (basename, tail) => {
  const copy = join(PROJECT, 'vendor', basename);
  mkdirSync(dirname(copy), { recursive: true });
  writeFileSync(copy, '// a copy\n');
  return `node "${copy}" ${tail}`;
};

describe('spec:checker-gates/S13 the kit-owned predicate learns the four declarable checkers', () => {
  it('exports KIT_CHECKER_CLAIMS in candidate order, each a frozen { id, basename, tail, screen } on the sibling tool', () => {
    const table = claims();
    assert.ok(Object.isFrozen(table));
    assert.deepEqual(table.map(({ id, basename, tail }) => [id, basename, tail]), CLAIMS);
    for (const claim of table) {
      assert.ok(Object.isFrozen(claim), claim.id);
      assert.deepEqual(Reflect.ownKeys(claim).sort(), ['basename', 'id', 'screen', 'tail']);
      assert.equal(claim.screen.canonical, join(HERE, claim.basename));
      assert.equal(classifyCheckerClaim(claim.screen, canonicalCmd(claim.basename, claim.tail), PROJECT), CHECKER_CLAIM.CANONICAL);
    }
  });

  it('answers yes for the canonical claim of each of the four', () => {
    for (const [id, basename, tail] of CLAIMS) {
      assert.equal(loaded.isKitOwnedCheckerGate(gate(canonicalCmd(basename, tail)), PROJECT), true, id);
    }
  });

  it('answers no for a tool-elsewhere copy, a wrong tail and another command', () => {
    for (const [id, basename, tail] of CLAIMS) {
      assert.equal(loaded.isKitOwnedCheckerGate(gate(canonicalCmd(basename, tail)), PROJECT), true, `${id} canonical`);
      assert.equal(loaded.isKitOwnedCheckerGate(gate(vendoredCmd(basename, tail)), PROJECT), false, `${id} elsewhere`);
      assert.equal(loaded.isKitOwnedCheckerGate(gate(canonicalCmd(basename, `${tail} --help`)), PROJECT), false, `${id} masked`);
    }
    assert.equal(loaded.isKitOwnedCheckerGate(gate('npm test'), PROJECT), false);
  });

  it('keeps the review-dependent predicate and FINAL_CORE_CHECKS as they were', () => {
    for (const [id, basename, tail] of CLAIMS) {
      assert.equal(loaded.isReviewDependentGate(gate(canonicalCmd(basename, tail)), PROJECT), false, id);
    }
    assert.equal(loaded.isReviewDependentGate(gate(canonicalCmd('review-state.mjs', '--check')), PROJECT), true);
    assert.deepEqual(loaded.FINAL_CORE_CHECKS.map(({ name }) => name), ['review-state', 'coverage-check']);
    assert.equal(loaded.isKitOwnedCheckerGate(gate(canonicalCmd('source-size-check.mjs', '--check')), PROJECT), true);
  });
});
