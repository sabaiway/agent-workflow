// coverage-producer.test.mjs — the shared producer vocabulary (Phase 1.1). Two contracts:
//   • matchesCoverageProducer is CLOSED — it accepts the full command forms the kit itself emits
//     and rejects every near miss (the destination inside an echo, a half-written reporter flag
//     set, the path as a bare substring). "Carries the destination somewhere" is a heuristic; a
//     heuristic here would declare the checker over a gate that writes no lcov.
//   • the reporter-flag value has TWO owners and no import between them (memory must not depend
//     on the kit; the kit must not import mirror bytes), so a TEXT drift guard holds them equal.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  UNIT_TESTS_COVERAGE_FLAGS,
  KNOWN_COVERAGE_FLAG_SETS,
  COVERAGE_PRODUCER_BODY,
  matchesCoverageProducer,
} from './coverage-producer.mjs';
import { execCmdFor } from './gates-init.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OWN_SOURCE = join(HERE, 'coverage-producer.mjs');

// The FIRST flag set the kit ever emitted, frozen here as literal bytes — never read back out of
// the set under test. Deployed declarations on disk carry exactly these bytes, so the append-only
// promise needs a checker that goes red if they are edited or dropped; deriving the "prior" from
// KNOWN_COVERAGE_FLAG_SETS would keep every such test green while real deployments broke.
const PRIOR_FLAG_SET_V1 =
  '--experimental-test-coverage --test-reporter=lcov --test-reporter-destination="$AW_GIT_DIR/agent-workflow-lcov.info" --test-reporter=spec --test-reporter-destination=stdout';
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

  it('recognition covers EVERY flag set the kit has emitted, and emission uses only the newest', () => {
    assert.equal(KNOWN_COVERAGE_FLAG_SETS[0], UNIT_TESTS_COVERAGE_FLAGS, 'the head is what the emitters write today');
    assert.ok(KNOWN_COVERAGE_FLAG_SETS.length >= 2, 'the set is append-only — a prior emitted form is never dropped');
    for (const flags of KNOWN_COVERAGE_FLAG_SETS) {
      const body = `node --test ${flags}`;
      assert.equal(matchesCoverageProducer(body), true, `an emitted form stays recognized forever: ${flags}`);
      assert.equal(matchesCoverageProducer(`${body} test/*.test.mjs`), true, 'with the project\'s own test paths too');
      for (const { cmd } of ['npm', 'pnpm', 'yarn'].map((pm) => execCmdFor(pm, body))) {
        assert.equal(matchesCoverageProducer(cmd), true, `and behind every verified exec wrapper: ${cmd}`);
      }
    }
  });

  it('the destination the kit EMITS refuses by name when AW_GIT_DIR is unset or EMPTY — never a bare expansion', () => {
    // Scope, exactly: `${VAR:?…}` refuses on unset OR empty. A STALE but exported AW_GIT_DIR is a
    // perfectly good expansion and is NOT caught — the lcov lands under the stale dir. What the
    // form removes is the hand-run case where nothing is set at all, which under a bare
    // `$AW_GIT_DIR` expanded to empty and wrote the lcov to the filesystem ROOT. The bare form
    // survives ONLY as a recognized prior (a deployed declaration), never as something this kit writes.
    assert.match(UNIT_TESTS_COVERAGE_FLAGS, /\$\{AW_GIT_DIR:\?[^}]+\}/, 'the emitted destination is `${AW_GIT_DIR:?…}`');
    assert.ok(!UNIT_TESTS_COVERAGE_FLAGS.includes('"$AW_GIT_DIR/'), 'the emitted form carries no bare expansion');
    assert.ok(KNOWN_COVERAGE_FLAG_SETS.includes(PRIOR_FLAG_SET_V1), 'the v1 bytes deployments carry are still recognized');
    assert.equal(matchesCoverageProducer(`node --test ${PRIOR_FLAG_SET_V1}`), true);
  });

  it('the closed tail grammar binds every known body — an option-shaped or operator tail passes under NONE', () => {
    for (const flags of KNOWN_COVERAGE_FLAG_SETS) {
      for (const tail of [
        '--test-concurrency=4',
        'test/*.mjs --test-reporter=dot',
        '&& rm -f "$AW_GIT_DIR/agent-workflow-lcov.info"',
        '> /dev/null',
        '$(echo x)',
      ]) {
        assert.equal(matchesCoverageProducer(`node --test ${flags} ${tail}`), false, `tail must not pass: ${tail}`);
      }
    }
  });

  it('a non-string cmd is never a producer (fail closed on type)', () => {
    for (const value of [null, undefined, 42, ['node', '--test'], { cmd: COVERAGE_PRODUCER_BODY }]) {
      assert.equal(matchesCoverageProducer(value), false);
    }
  });
});

// The emitted cmd is a FIXTURE TO EXECUTE, never a string to admire: every earlier check read the
// constant's bytes, so a destination that expanded to the filesystem root whenever AW_GIT_DIR was
// unset or empty stayed invisible to the whole suite. This is the standing pattern for every
// canonical paste-ready cmd. What the executed guard covers is exactly that condition — a stale
// but exported AW_GIT_DIR expands fine and no check here (or in bash) catches it.
describe('coverage-producer — the emitted cmd is EXECUTED', () => {
  const SUITE_FIXTURE = "import { test } from 'node:test';\ntest('ok', () => {});\n";
  const mkSuiteDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'coverage-producer-exec-'));
    writeFileSync(join(dir, 'ok.test.mjs'), SUITE_FIXTURE);
    return dir;
  };
  // NODE_TEST_CONTEXT is stripped for the same reason run-gates strips it: a `node --test` spawned
  // under a parent test context hits Node's recursive-run guard, skips every file and exits 0.
  // AW_GIT_DIR rides the spawn env OPTION, never a same-line prefix assignment — a prefix
  // assignment is applied by the very expansion under test, which would mask what this asserts.
  const runEmittedBody = (cwd, extraEnv) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.AW_GIT_DIR;
    return spawnSync('bash', ['-c', COVERAGE_PRODUCER_BODY], { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8' });
  };

  it('with AW_GIT_DIR unset it refuses BY NAME before the suite runs, and writes nothing', () => {
    const dir = mkSuiteDir();
    const res = runEmittedBody(dir, {});
    const left = readdirSync(dir).sort();
    rmSync(dir, { recursive: true, force: true });
    assert.notEqual(res.status, 0, 'an unset producer variable fails the cmd, never runs it silently');
    assert.match(res.stderr, /AW_GIT_DIR/, 'the failure names the variable the reader must set');
    assert.deepEqual(left, ['ok.test.mjs'], 'nothing was produced anywhere the cmd could reach');
  });

  it('an EMPTY AW_GIT_DIR refuses exactly like an unset one — the colon in `:?` is load-bearing', () => {
    // Without this case the suite would stay green after `:?` was weakened to `?`, which refuses
    // only on UNSET: an exported-but-empty value would expand away and put the lcov back at the
    // filesystem root — the very defect the required-parameter form exists to remove.
    const dir = mkSuiteDir();
    const res = runEmittedBody(dir, { AW_GIT_DIR: '' });
    const left = readdirSync(dir).sort();
    rmSync(dir, { recursive: true, force: true });
    assert.notEqual(res.status, 0, 'an empty producer variable is a failure, never a run against the filesystem root');
    assert.match(res.stderr, /AW_GIT_DIR/, 'the failure names the variable');
    assert.deepEqual(left, ['ok.test.mjs'], 'nothing was produced anywhere the cmd could reach');
  });

  it('with AW_GIT_DIR injected the destination resolves UNDER it', () => {
    const dir = mkSuiteDir();
    const res = runEmittedBody(dir, { AW_GIT_DIR: dir });
    const produced = existsSync(join(dir, 'agent-workflow-lcov.info'));
    rmSync(dir, { recursive: true, force: true });
    assert.equal(res.status, 0, `the suite runs green under the injected git dir: ${res.stderr}`);
    assert.equal(produced, true, 'the lcov lands at the injected git dir — the checker reads the file the suite wrote');
  });
});

describe('coverage-producer — the shipped gates template carries no producer bytes', () => {
  it('the template declares nothing, so it has no canonical cmd to age when the constant moves', () => {
    // Scope, stated: this pins the TEMPLATE only. The other hand-copy of the canonical body lives
    // in references/modes/gates.md and is held to the constant by the doc-parity binding
    // `coverage-producer-body`, not by anything here — a title claiming "no canonical bytes live
    // outside the constant" would promise coverage this block does not have.
    const template = readFileSync(join(HERE, '..', 'references', 'templates', 'gates.json'), 'utf8');
    assert.deepEqual(JSON.parse(template).gates, [], 'the shipped declaration is empty');
    for (const flags of KNOWN_COVERAGE_FLAG_SETS) {
      assert.ok(!template.includes(flags), 'no emitted flag set is copied into the template');
    }
    assert.ok(!template.includes('agent-workflow-lcov.info'), 'nor the destination in any form');
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
