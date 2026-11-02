// coverage-producer.test.mjs — the shared producer vocabulary (spec coverage-producer). Two contracts:
//   • matchesCoverageProducer is CLOSED — it accepts the one command body the kit writes, bare, with a path-shaped
//     tail and behind each exec prefix the offer emits, and rejects every near miss and every retired flag set;
//   • the vocabulary has TWO owners and no import between them, so a TEXT drift guard holds the regions equal.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COVERAGE_PRODUCER_BODY, isCoverageProducerGate, matchesCoverageProducer } from './coverage-producer.mjs';
import { execCmdFor } from './gates-init.mjs';
import { validateDeclaration, LCOV_PRODUCER_KEY } from './gates-declaration.mjs';
import { readFamily } from '../references/scripts/family.mjs';
import { KIT_COMMAND_PATH } from '../references/scripts/run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OWN_SOURCE = join(HERE, 'coverage-producer.mjs');
const KIT_RUN = '../references/scripts/run.mjs';

// The one body and the two flag sets earlier kits wrote, frozen here as literal bytes — never read back out of the
// module under test: deployed declarations on disk carry exactly these bytes.
const BODY = 'node scripts/agent-workflow/run.mjs unit-tests';
const RETIRED_V2 =
  '--experimental-test-coverage --test-reporter=lcov --test-reporter-destination="${AW_GIT_DIR:?exported by run-gates}/agent-workflow-lcov.info" --test-reporter=spec --test-reporter-destination=stdout';
const RETIRED_V1 =
  '--experimental-test-coverage --test-reporter=lcov --test-reporter-destination="$AW_GIT_DIR/agent-workflow-lcov.info" --test-reporter=spec --test-reporter-destination=stdout';
const RETIRED_BODIES = [RETIRED_V2, RETIRED_V1].map((flags) => `node --test ${flags}`);
const PMS = ['npm', 'pnpm', 'yarn'];
const prefixOf = (pm) => {
  const { cmd } = execCmdFor(pm, BODY);
  assert.ok(cmd?.endsWith(BODY), `${pm} has a verified exec form ending in the body`);
  return cmd.slice(0, -BODY.length);
};
const retiredForm = async () => (await import('./coverage-producer.mjs')).retiredProducerFormOf;

// The kit's in-package MIRROR of the memory canon: mirror-equality here IS canon-equality (test/scripts-mirror.test.mjs).
const MIGRATE_PATH = readFamily().find(({ path }) => path === 'gates/migrate-gates.mjs').path;
const MIRRORED_CANON = join(HERE, '..', 'references', 'scripts', ...MIGRATE_PATH.split('/'));
const BEGIN = '// coverage-producer canon >>> BEGIN drift-guarded region';
const END = '// coverage-producer canon <<< END drift-guarded region';
const regionOf = (text) => {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + END.length);
};

describe('spec:coverage-producer/S1 the one producer body and the retired move list', () => {
  it('COVERAGE_PRODUCER_BODY equals node, KIT_COMMAND_PATH and UNIT_TESTS_NAME joined by single spaces', async () => {
    const { UNIT_TESTS_NAME } = await import(KIT_RUN);
    assert.equal(COVERAGE_PRODUCER_BODY, ['node', KIT_COMMAND_PATH, UNIT_TESTS_NAME].join(' '));
    assert.equal(COVERAGE_PRODUCER_BODY, BODY);
  });

  it('the body bare, with a path tail, with a single-quoted glob tail and behind each execCmdFor prefix is a producer', () => {
    for (const tail of ['', ' tools/*.test.mjs test/*.test.mjs', " 'src/**/*.test.mjs'", '   tools/*.test.mjs', ' ~/shared/*.test.mjs "test dir/*.mjs"',
      ' agent-workflow-memory/{scripts,references/scripts,bin}/*.test.mjs', ' test/?.mjs', ' test/[ab].mjs', ' src/**/*.test.mjs']) {
      assert.equal(matchesCoverageProducer(`${BODY}${tail}`), true, `a producer: ${BODY}${tail}`);
      for (const pm of PMS) assert.equal(matchesCoverageProducer(`${prefixOf(pm)}${BODY}${tail}`), true, `${pm}: ${tail}`);
    }
    assert.equal(matchesCoverageProducer(`  ${BODY}  `), true, 'surrounding whitespace is trimmed');
  });

  it('RETIRED_COVERAGE_FLAG_SETS holds the two flag sets byte for byte, newest first', async () => {
    const { RETIRED_COVERAGE_FLAG_SETS } = await import('./coverage-producer.mjs');
    assert.deepEqual(RETIRED_COVERAGE_FLAG_SETS, [RETIRED_V2, RETIRED_V1]);
  });

  it('node --test with either flag set, bare, with a path tail or behind an exec prefix, is no producer; retiredProducerFormOf reads it', async () => {
    const formOf = await retiredForm();
    for (const body of RETIRED_BODIES) {
      for (const [prefix, tail] of [['', ''], ['', 'tools/*.test.mjs'], ['', "'src/**/*.test.mjs'"], ...PMS.map((pm) => [prefixOf(pm), '']), [prefixOf('pnpm'), 'test/*.test.mjs']]) {
        const cmd = `${prefix}${body}${tail ? `  ${tail}` : ''}`;
        assert.equal(matchesCoverageProducer(cmd), false, `a retired form is no producer: ${cmd}`);
        const form = formOf(cmd);
        assert.deepEqual({ ...form, prefix: form?.prefix?.trimEnd() }, { prefix: prefix.trimEnd(), tail, pathShaped: true }, cmd);
      }
    }
  });

  it('neither copy exports the retired flag constants: each exports the vocabulary and no other flag-set name', async () => {
    const vocabulary = ['COVERAGE_PRODUCER_BODY', 'RETIRED_COVERAGE_FLAG_SETS', 'isCoverageProducerGate', 'matchesCoverageProducer', 'retiredProducerFormOf'];
    for (const [label, namespace] of [['the kit copy', await import('./coverage-producer.mjs')], ['the memory copy', await import(pathToFileURL(MIRRORED_CANON).href)]]) {
      assert.deepEqual(vocabulary.filter((name) => !Object.hasOwn(namespace, name)), [], `${label} exports the vocabulary`);
      assert.deepEqual(Object.keys(namespace).filter((name) => name.includes('COVERAGE_FLAG')), ['RETIRED_COVERAGE_FLAG_SETS'], `${label} exports no retired flag constant`);
    }
  });
});

describe('spec:coverage-producer/S2 the near misses, the retired reader\'s refusals and the drift guard', () => {
  it('every near miss of the body is no producer, while the body itself is one', () => {
    assert.equal(matchesCoverageProducer(BODY), true, 'the anchor: the body is a producer');
    for (const cmd of [
      `echo ${BODY}`,
      `true && ${BODY}`,
      `"${BODY}"`,
      'node ./scripts/agent-workflow/run.mjs unit-tests',
      'node scripts/agent-workflow/run.mjs docs-size',
      `${BODY} --test-reporter=dot`,
      `${BODY} tools/*.test.mjs --test-reporter=dot`,
      `${BODY} --test-concurrency=1 x`,
      `${BODY} && rm -f "$AW_GIT_DIR/agent-workflow-lcov.info"`,
      `${BODY} test/*.mjs;rm -rf x`,
      `${BODY} > /dev/null`,
      `${BODY} $(echo x)`,
      `${BODY} test/*.mjs | tee /dev/null`,
      `${BODY} \`echo x\``,
      `${BODY} test/*.mjs & echo backgrounded`,
      'node --test tools/*.test.mjs',
      'npm test',
    ]) {
      assert.equal(matchesCoverageProducer(cmd), false, `must NOT read as a producer: ${cmd}`);
    }
    for (const value of [null, undefined, 42, ['node'], { cmd: BODY }]) assert.equal(matchesCoverageProducer(value), false);
  });

  it('retiredProducerFormOf answers pathShaped false for a flag in the tail, and null for a partial set, the body and a non-string', async () => {
    const formOf = await retiredForm();
    const flagged = formOf(`${RETIRED_BODIES[0]} --test-concurrency=1 tools/*.test.mjs`);
    assert.deepEqual({ ...flagged, prefix: flagged?.prefix?.trimEnd() }, { prefix: '', tail: '--test-concurrency=1 tools/*.test.mjs', pathShaped: false });
    assert.equal(formOf(`${RETIRED_BODIES[1]} --test-concurrency=1`).pathShaped, false);
    for (const value of [
      'node --test --experimental-test-coverage --test-reporter=lcov tools/*.test.mjs',
      `node --test ${RETIRED_V2.replace(' --test-reporter=spec --test-reporter-destination=stdout', '')}`,
      `${RETIRED_BODIES[0]}x`,
      `echo ${RETIRED_BODIES[0]}`,
      BODY,
      `${BODY} tools/*.test.mjs`,
      'node --test tools/*.test.mjs',
      null,
      42,
      { cmd: RETIRED_BODIES[0] },
    ]) {
      assert.equal(formOf(value), null, `no retired form: ${JSON.stringify(value)}`);
    }
  });

  it('the gate predicate\'s verdict on an unmarked gate equals the cmd predicate\'s', () => {
    assert.equal(isCoverageProducerGate({ id: 'unit-tests', cmd: BODY }), true, 'the anchor: the body gate is a producer');
    for (const cmd of [BODY, `${BODY} test/*.test.mjs`, ...RETIRED_BODIES, `${BODY} && rm -f x`, `echo ${BODY}`, 'npm test', ...PMS.map((pm) => `${prefixOf(pm)}${BODY}`)]) {
      const gate = { id: 'suite', title: 'Suite', cmd };
      assert.equal(isCoverageProducerGate(gate), matchesCoverageProducer(cmd), cmd);
      assert.equal(isCoverageProducerGate({ ...gate, lcovProducer: false }), matchesCoverageProducer(cmd), `an explicit false never revokes: ${cmd}`);
    }
  });

  it('the two regions are byte-equal, carry the move list, and a one-byte change inside either is detected', () => {
    const ownText = readFileSync(OWN_SOURCE, 'utf8');
    const canonText = readFileSync(MIRRORED_CANON, 'utf8');
    const [own, canon] = [regionOf(ownText), regionOf(canonText)];
    assert.ok(own && canon, 'both sources carry the delimited region');
    assert.ok(own.includes('RETIRED_COVERAGE_FLAG_SETS') && own.includes('retiredProducerFormOf'), 'the region holds the move list and its reader');
    assert.equal(own, canon, 'the two owners drifted — edit BOTH, then run node scripts/sync-mirrors.mjs');
    for (const text of [ownText, canonText]) {
      const mutated = text.replace(`${BEGIN}\n`, `${BEGIN}\nx`);
      assert.notEqual(mutated, text, 'the mutation applied');
      assert.notEqual(regionOf(mutated), own, 'a mutated region compares UNEQUAL');
    }
  });
});

describe('spec:coverage-producer/S10 the one producer question of a declared row, and the absent remedy', () => {
  it('readsAsCoverageProducer holds for a body gate and a marked gate only under the claim not-the-tool', async () => {
    const [{ readsAsCoverageProducer }, { CHECKER_CLAIM }] = await Promise.all([import('./coverage-producer.mjs'), import('./checker-claim.mjs')]);
    assert.equal(typeof readsAsCoverageProducer, 'function', 'the region exports readsAsCoverageProducer');
    assert.equal(CHECKER_CLAIM.NOT_THE_TOOL, 'not-the-tool', 'the region\'s claim literal is the canon\'s value');
    const producers = [{ id: 'unit-tests', title: 'Unit', cmd: `${BODY} tools/*.test.mjs` }, { id: 'suite', title: 'Suite', cmd: 'pnpm vitest run --coverage', lcovProducer: true }];
    for (const gate of producers) {
      assert.equal(readsAsCoverageProducer(gate, 'not-the-tool'), true, `a producer under not-the-tool: ${gate.cmd}`);
      for (const claim of ['canonical', 'tool-elsewhere', undefined, null, '', 'NOT-THE-TOOL', true]) {
        assert.equal(readsAsCoverageProducer(gate, claim), false, `a row claiming the checker, or any other claim, is no producer: ${JSON.stringify(claim)}`);
      }
    }
    for (const gate of [{ id: 'suite', title: 'Suite', cmd: 'npm test' }, { id: 'old', title: 'Old', cmd: RETIRED_BODIES[0] }, null]) {
      assert.equal(readsAsCoverageProducer(gate, 'not-the-tool'), false, `no producer under any claim: ${JSON.stringify(gate)}`);
    }
  });

  it('guardRemedy(absent, u) names Node evidence, a root package.json and a kit script, and ends with u', async () => {
    const [{ guardRemedy }, u] = [await import('./coverage-producer.mjs'), '/agent-workflow-kit upgrade'];
    assert.equal(guardRemedy('absent', u),
      `is absent — the kit's upgrade places the kit folder only where Node evidence stands (a root package.json, or a kit script): add one if this project runs Node, then run ${u}.`);
    assert.ok(guardRemedy('absent', 'the kit\'s upgrade').endsWith('run the kit\'s upgrade.'), 'the caller\'s upgrade name is the one named');
  });
});

describe('coverage-producer — the GATE-level predicate (the lcovProducer marker)', () => {
  const gate = (cmd, extra = {}) => ({ id: 'suite', title: 'Suite', cmd, ...extra });
  const FOREIGN_SUITE = 'pnpm vitest run --coverage';

  it('a marker-true gate IS a producer even though its cmd is outside the closed world', () => {
    assert.equal(matchesCoverageProducer(FOREIGN_SUITE), false, 'recognition itself never widened');
    assert.equal(isCoverageProducerGate(gate(FOREIGN_SUITE, { lcovProducer: true })), true);
  });

  it('only the LITERAL true claims — false, absent, and every truthy near-miss do not', () => {
    assert.equal(isCoverageProducerGate(gate(FOREIGN_SUITE)), false, 'marker absent');
    assert.equal(isCoverageProducerGate(gate(FOREIGN_SUITE, { lcovProducer: false })), false);
    for (const value of ['true', 'false', 1, {}, [], 'yes']) {
      assert.equal(isCoverageProducerGate(gate(FOREIGN_SUITE, { lcovProducer: value })), false, `truthy near-miss must not claim: ${JSON.stringify(value)}`);
    }
  });

  it('a marker over a cmd that cannot RUN claims nothing — the second host has no strict validator', () => {
    for (const cmd of ['', '   ', '\t\n ', 'echo a\nrm -rf b', 'echo a\r\nrm -rf b']) {
      assert.equal(isCoverageProducerGate(gate(cmd, { lcovProducer: true })), false, `must not claim: ${JSON.stringify(cmd)}`);
    }
    assert.equal(isCoverageProducerGate(gate(' pnpm vitest run ', { lcovProducer: true })), true, 'ordinary surrounding whitespace still claims');
  });

  it('a marker on a NON-gate shape claims nothing (fail closed)', () => {
    for (const value of [null, undefined, 42, 'lcovProducer', [{ lcovProducer: true }], { lcovProducer: true }, { cmd: 42, lcovProducer: true }]) {
      assert.equal(isCoverageProducerGate(value), false, `must not claim: ${JSON.stringify(value)}`);
    }
  });
});

describe('coverage-producer — the shipped gates template carries no producer bytes', () => {
  it('the template declares nothing, so it has no canonical cmd to age when the constant moves', async () => {
    const { RETIRED_COVERAGE_FLAG_SETS } = await import('./coverage-producer.mjs');
    const template = readFileSync(join(HERE, '..', 'references', 'templates', 'gates.json'), 'utf8');
    assert.deepEqual(JSON.parse(template).gates, [], 'the shipped declaration is empty');
    for (const text of [BODY, ...RETIRED_COVERAGE_FLAG_SETS]) assert.ok(!template.includes(text), `no producer bytes copied in: ${text}`);
    assert.ok(!template.includes('agent-workflow-lcov.info'), 'nor the destination in any form');
  });
});

// The mode doc SHOWS the marker as a declaration fragment, the form a reader copies: it must validate.
describe('coverage-producer — the mode doc\'s marker fragment is a VALID declaration', () => {
  const GATES_DOC = join(HERE, '..', 'references', 'modes', 'gates.md');
  const fencedJson = (text) => [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);

  it('the fenced fragment parses, validates, and really carries the marker', () => {
    const blocks = fencedJson(readFileSync(GATES_DOC, 'utf8'));
    const marker = blocks.filter((b) => b.includes(`"${LCOV_PRODUCER_KEY}"`));
    assert.equal(marker.length, 1, 'exactly one fenced fragment demonstrates the marker');
    const gates = validateDeclaration(JSON.parse(marker[0]));
    assert.ok(gates.some((g) => g[LCOV_PRODUCER_KEY] === true), 'and it demonstrates the LITERAL true, the only value that claims');
    assert.ok(gates.some((g) => isCoverageProducerGate(g)), 'so the predicate reads the documented entry as a producer');
  });

  it('EVERY fenced fragment in the doc validates — a shown declaration is a copyable one', () => {
    for (const block of fencedJson(readFileSync(GATES_DOC, 'utf8'))) {
      assert.doesNotThrow(() => validateDeclaration(JSON.parse(block)), `a documented fragment the validator rejects: ${block}`);
    }
  });

  it('the guard is NOT vacuous — a fragment carrying a non-boolean marker is REJECTED', () => {
    const blocks = fencedJson(readFileSync(GATES_DOC, 'utf8'));
    const mutated = blocks.find((b) => b.includes(`"${LCOV_PRODUCER_KEY}"`)).replace(`"${LCOV_PRODUCER_KEY}": true`, `"${LCOV_PRODUCER_KEY}": "true"`);
    assert.throws(() => validateDeclaration(JSON.parse(mutated)), /must be a boolean/);
  });
});
