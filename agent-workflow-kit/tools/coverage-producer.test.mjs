// coverage-producer.test.mjs — the shared producer vocabulary (Phase 1.1). Two contracts:
//   • matchesCoverageProducer is CLOSED — it accepts the full command forms the kit itself emits
//     and rejects every near miss (the destination inside an echo, a half-written reporter flag
//     set, the path as a bare substring). "Carries the destination somewhere" is a heuristic; a
//     heuristic here would declare the checker over a gate that writes no lcov.
//   • the reporter-flag value has TWO owners and no import between them (memory must not depend
//     on the kit; the kit must not import mirror bytes), so a TEXT drift guard holds them equal.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNIT_TESTS_COVERAGE_FLAGS, COVERAGE_PRODUCER_BODY, matchesCoverageProducer } from './coverage-producer.mjs';
import { execCmdFor } from './gates-init.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OWN_SOURCE = join(HERE, 'coverage-producer.mjs');
// The kit's in-package MIRROR of the memory canon. scripts/sync-mirrors.mjs copies the canon tree
// verbatim and test/scripts-mirror.test.mjs guards that half, so mirror-equality here IS
// canon-equality — reached without importing either side.
const MIRRORED_CANON = join(HERE, '..', 'references', 'scripts', 'migrate-gates.mjs');

// The delimiters are matched as TEXT in both sources — the region is authored twice on purpose.
const BEGIN = '// coverage-producer canon >>> BEGIN drift-guarded region';
const END = '// coverage-producer canon <<< END drift-guarded region';
const regionOf = (text) => {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + END.length);
};

describe('coverage-producer — the closed producer predicate', () => {
  it('accepts the migrator\'s canonical suite gate, bare and with the project\'s own test paths', () => {
    assert.equal(COVERAGE_PRODUCER_BODY, `node --test ${UNIT_TESTS_COVERAGE_FLAGS}`);
    assert.equal(matchesCoverageProducer(COVERAGE_PRODUCER_BODY), true);
    assert.equal(matchesCoverageProducer(`${COVERAGE_PRODUCER_BODY} tools/*.test.mjs test/*.test.mjs`), true);
    assert.equal(matchesCoverageProducer(`  ${COVERAGE_PRODUCER_BODY}  `), true, 'surrounding whitespace is trimmed');
  });

  it('accepts the offer form of EVERY verified package-manager family — the emitter and the recognizer are bound, not two grammars', () => {
    for (const pm of ['npm', 'pnpm', 'yarn']) {
      const { cmd } = execCmdFor(pm, COVERAGE_PRODUCER_BODY);
      assert.ok(cmd, `${pm} must have a verified exec form`);
      assert.equal(matchesCoverageProducer(cmd), true, `the ${pm} offer cmd must read as a producer: ${cmd}`);
      assert.equal(matchesCoverageProducer(`${cmd} test/*.test.mjs`), true, `${pm}: a hand-added path suffix stays a producer`);
    }
  });

  it('REJECTS every near miss — mentioning the destination is not producing it', () => {
    const destination = '"$AW_GIT_DIR/agent-workflow-lcov.info"';
    for (const cmd of [
      `echo ${destination}`,
      `cat ${destination}`,
      `test -f ${destination} && echo ok`,
      `echo ${COVERAGE_PRODUCER_BODY}`,
      `echo "${COVERAGE_PRODUCER_BODY}"`,
      'node --test --experimental-test-coverage tools/*.test.mjs',
      `node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=${destination} tools/*.test.mjs`,
      'node --test tools/*.test.mjs',
      'npm test',
      `true && ${COVERAGE_PRODUCER_BODY}`,
      `COREPACK_ENABLE_NETWORK=0 npm exec --offline --script-shell /bin/sh -- ${UNIT_TESTS_COVERAGE_FLAGS}`,
    ]) {
      assert.equal(matchesCoverageProducer(cmd), false, `must NOT read as a producer: ${cmd}`);
    }
  });

  it('REJECTS a tail that is not path-shaped — a suite that runs and then DELETES the lcov is not a producer', () => {
    // The tail is the project's own test paths, so it cannot be closed to a literal set; it IS
    // closed to a positive path grammar. An open-ended tail would certify `… && rm -f <lcov>`.
    for (const tail of [
      '&& rm -f "$AW_GIT_DIR/agent-workflow-lcov.info"',
      'test/*.mjs;rm -rf x',
      '> /dev/null',
      '$(echo x)',
      '`echo x`',
      'test/*.mjs | tee /dev/null',
      'test/*.mjs & echo backgrounded',
    ]) {
      assert.equal(matchesCoverageProducer(`${COVERAGE_PRODUCER_BODY} ${tail}`), false, `tail must not pass: ${tail}`);
    }
  });

  it('ACCEPTS the real path tails the family emits and declares — globs, brace expansion, quoting and tilde', () => {
    for (const tail of [
      'test/*.test.mjs',
      'tools/*.test.mjs test/*.test.mjs',
      'agent-workflow-memory/{scripts,references/scripts,bin}/*.test.mjs agent-workflow-kit/test/*.test.mjs',
      'src/**/*.test.mjs',
      'test/?.mjs',
      'test/[ab].mjs',
      '"test dir/*.mjs"',
      "'another dir/*.mjs'",
      '~/shared/*.test.mjs',
    ]) {
      assert.equal(matchesCoverageProducer(`${COVERAGE_PRODUCER_BODY} ${tail}`), true, `tail must pass: ${tail}`);
    }
  });

  it('REJECTS an OPTION-shaped tail token — the tail is the project\'s test PATHS, never more flags', () => {
    // A flag in the tail reopens an open-world question the closed design refuses: whether some
    // later option negates the reporters that make this cmd a producer. The tail is paths; a
    // declaration that needs extra flags declares its checker by hand (stated withhold, mild).
    for (const tail of [
      '--no-experimental-test-coverage',
      '--test-concurrency=4',
      'test/*.mjs --test-reporter=dot',
      '-w test/*.mjs',
    ]) {
      assert.equal(matchesCoverageProducer(`${COVERAGE_PRODUCER_BODY} ${tail}`), false, `option-shaped tail must not pass: ${tail}`);
    }
  });

  it('a non-string cmd is never a producer (fail closed on type)', () => {
    for (const value of [null, undefined, 42, ['node', '--test'], { cmd: COVERAGE_PRODUCER_BODY }]) {
      assert.equal(matchesCoverageProducer(value), false);
    }
  });
});

describe('coverage-producer — the TEXT drift guard against the memory canon', () => {
  it('the kit constant and the memory canon hold the region byte-identically', () => {
    const own = regionOf(readFileSync(OWN_SOURCE, 'utf8'));
    const canon = regionOf(readFileSync(MIRRORED_CANON, 'utf8'));
    assert.ok(own, 'the kit source carries the delimited region');
    assert.ok(canon, 'the memory canon carries the delimited region');
    assert.ok(own.includes(UNIT_TESTS_COVERAGE_FLAGS), 'the region carries the live flag value');
    assert.equal(own, canon, 'the two owners drifted — edit BOTH, then run node scripts/sync-mirrors.mjs');
  });

  it('the guard is NOT vacuous — a one-byte divergence inside the region is detected', () => {
    const canonText = readFileSync(MIRRORED_CANON, 'utf8');
    const mutated = canonText.replace('--test-reporter=lcov', '--test-reporter=lcov2');
    assert.notEqual(mutated, canonText, 'the mutation applied (the flag literal is really in the canon)');
    assert.notEqual(regionOf(mutated), regionOf(canonText), 'a mutated region must compare UNEQUAL');
  });
});
