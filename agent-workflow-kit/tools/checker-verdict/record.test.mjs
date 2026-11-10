import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT_CHECKER_CLAIMS, FINAL_CORE_CHECKS } from '../gates-declaration.mjs';
import { SOURCE_SIZE_TOOL_PATH } from '../source-size-core.mjs';
import { gatherOffered } from './run-harness.test.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const KIT_TOOLS = 'agent-workflow-kit/tools/';
const MEMORY_SCRIPTS = 'agent-workflow-memory/references/scripts/';
const FIRST_PATH = `${KIT_TOOLS}example-check.mjs`;
const SECOND_PATH = `${MEMORY_SCRIPTS}verify.mjs`;
const WORD_PATH = 'agent-workflow-engine/bin/write.mjs';
const CHECK_ARGUMENTS = ['--check'];
const OTHER_ARGUMENTS = ['--other'];
const FIRST_RED_CASE = 'missing-record';
const SECOND_RED_CASE = 'malformed-shape';
const SOURCE_SIZE_NAME = 'source-size';
const PLAN_SHAPE_NAME = 'plan-shape';
const WRITER_WORD = 'writer';
const INSTALLER_WORD = 'installer';
const LIBRARY_WORD = 'library';
const PROJECT_PLACE = '.';
const EXPECTED_FAULT_POINTS = ['read', 'stat', 'list', 'spawn'];
const WELL_FORMED_RECORD = {
  files: [
    {
      path: FIRST_PATH,
      commandLines: [{
        name: 'record-check',
        arguments: CHECK_ARGUMENTS,
        redCases: [{ name: FIRST_RED_CASE, places: ['docs/missing.json:3', 'docs', PROJECT_PLACE] }],
      }],
    },
    {
      path: SECOND_PATH,
      commandLines: [{
        name: 'shape-check',
        arguments: [],
        redCases: [{ name: SECOND_RED_CASE, places: ['docs/shape.json'] }],
      }],
    },
    { path: WORD_PATH, word: WRITER_WORD },
  ],
  redExceptions: [{
    path: FIRST_PATH, arguments: CHECK_ARGUMENTS, redCase: FIRST_RED_CASE, missKinds: ['place'],
  }],
  faultExceptions: [{ path: FIRST_PATH, arguments: CHECK_ARGUMENTS, faultPoint: EXPECTED_FAULT_POINTS[0] }],
};

const assertRecordRefusals = (readRecord, cases) => {
  for (const [label, change, token] of cases) {
    const record = structuredClone(WELL_FORMED_RECORD);
    change(record);
    assert.throws(() => readRecord(JSON.stringify(record)), (error) =>
      error instanceof Error && error.message.includes(token), label);
  }
};

const buildWordRecord = (paths) => ({
  files: paths.map((path) => ({ path, word: LIBRARY_WORD })),
  redExceptions: [],
  faultExceptions: [],
});

const buildFile = (path, marks = {}) => ({
  path, bin: false, interpreterLine: false, guardName: false, ...marks,
});

const buildRecordFiles = (record) => record.files.map(({ path }) =>
  buildFile(path, { interpreterLine: true }));

const buildCheckerEntry = (path, name, argumentsList) => ({
  path,
  commandLines: [{
    name, arguments: argumentsList, redCases: [{ name: 'missing-entry', places: [PROJECT_PLACE] }],
  }],
});

const buildOfferedFixture = () => {
  const { offered, commandTargets } = gatherOffered(ROOT);
  const record = {
    files: [
      ...KIT_CHECKER_CLAIMS.map((claim) =>
        buildCheckerEntry(KIT_TOOLS + claim.path, claim.id, claim.tail.split(' '))),
      ...FINAL_CORE_CHECKS.map((check) =>
        buildCheckerEntry(relative(ROOT, check.canonical), check.name, CHECK_ARGUMENTS)),
      buildCheckerEntry(relative(ROOT, SOURCE_SIZE_TOOL_PATH), SOURCE_SIZE_NAME, CHECK_ARGUMENTS),
      ...commandTargets.map(({ name, path }) => ({
        path, word: name === 'install-git-hooks' ? INSTALLER_WORD : LIBRARY_WORD,
      })),
    ],
    redExceptions: [],
    faultExceptions: [],
  };
  return { record, offered, commandTargets };
};

describe('strict record reading (spec:checker-verdict/S5)', () => {
  it('accepts and returns the well-formed record', async () => {
    const { readRecord } = await import('./record.mjs');
    assert.deepEqual(readRecord(JSON.stringify(WELL_FORMED_RECORD)), WELL_FORMED_RECORD);
  });

  it('names unknown keys and missing fields at all six levels', async () => {
    const { readRecord } = await import('./record.mjs');
    const levels = [
      ['top', (record) => record, 'redExceptions'],
      ['file', (record) => record.files[2], 'path'],
      ['command', (record) => record.files[1].commandLines[0], 'name'],
      ['red-case', (record) => record.files[1].commandLines[0].redCases[0], 'places'],
      ['red-exception', (record) => record.redExceptions[0], 'missKinds'],
      ['fault-exception', (record) => record.faultExceptions[0], 'faultPoint'],
    ];
    const cases = levels.flatMap(([label, select, field]) => {
      const unknownKey = `unknown-${label}`;
      return [
        [`unknown key at ${label}`, (record) => { select(record)[unknownKey] = true; }, unknownKey],
        [`missing field at ${label}`, (record) => { delete select(record)[field]; }, field],
      ];
    });
    assertRecordRefusals(readRecord, cases);
  });

  it('names fields whose types differ from the record shape', async () => {
    const { readRecord } = await import('./record.mjs');
    const cases = [
      ['list instead of string', (record) => { record.files[2].word = []; }, 'word'],
      ['string instead of list', (record) => { record.faultExceptions = 'not-a-list'; }, 'faultExceptions'],
      ['string instead of a file entry', (record) => { record.files[2] = 'loose'; }, 'files'],
      ['number among arguments', (record) => {
        record.files[1].commandLines[0].arguments = [7];
      }, 'arguments'],
    ];
    assertRecordRefusals(readRecord, cases);
  });

  it('names repeated paths, command lines, red cases and both exception entries', async () => {
    const { readRecord } = await import('./record.mjs');
    const cases = [
      ['repeated path', (record) => { record.files.push(structuredClone(record.files[2])); }, WORD_PATH],
      ['repeated command line', (record) => {
        record.files[1].commandLines.push(structuredClone(record.files[1].commandLines[0]));
      }, SECOND_PATH],
      ['repeated red-case name', (record) => {
        const redCases = record.files[1].commandLines[0].redCases;
        redCases.push(structuredClone(redCases[0]));
      }, SECOND_RED_CASE],
      ['repeated red exception', (record) => {
        record.redExceptions.push(structuredClone(record.redExceptions[0]));
      }, FIRST_PATH],
      ['repeated fault exception', (record) => {
        record.faultExceptions.push(structuredClone(record.faultExceptions[0]));
      }, FIRST_PATH],
    ];
    assertRecordRefusals(readRecord, cases);
  });
});

describe('record shape refusals (spec:checker-verdict/S6)', () => {
  it('names invalid file entries, red cases and places', async () => {
    const { readRecord } = await import('./record.mjs');
    const unsupportedWord = 'unsupported-role';
    const malformedPlace = './docs/a.md';
    const absolutePlace = '/outside/a.md';
    const cases = [
      ['no red case', (record) => { record.files[1].commandLines[0].redCases = []; }, SECOND_PATH],
      ['neither command lines nor word', (record) => { delete record.files[2].word; }, WORD_PATH],
      ['both command lines and word', (record) => { record.files[1].word = LIBRARY_WORD; }, SECOND_PATH],
      ['empty command lines', (record) => { record.files[1].commandLines = []; }, SECOND_PATH],
      ['word outside closed list', (record) => { record.files[2].word = unsupportedWord; }, unsupportedWord],
      ['no place', (record) => {
        record.files[1].commandLines[0].redCases[0].places = [];
      }, SECOND_RED_CASE],
      ...[malformedPlace, absolutePlace].map((place) => [place, (record) => {
        record.files[1].commandLines[0].redCases[0].places = [place];
      }, place]),
    ];
    assertRecordRefusals(readRecord, cases);
  });

  it('names missing exception references and unknown miss kinds and fault points', async () => {
    const { readRecord } = await import('./record.mjs');
    const missingPath = `${KIT_TOOLS}absent-check.mjs`;
    const missingRedCase = 'unrecorded-red-case';
    const unsupportedMissKind = 'unsupported-miss';
    const unsupportedFaultPoint = 'unsupported-fault';
    const cases = [
      ...['redExceptions', 'faultExceptions'].flatMap((field) => [
        [`${field} missing path`, (record) => { record[field][0].path = missingPath; }, missingPath],
        [`${field} other arguments`, (record) => {
          record[field][0].arguments = OTHER_ARGUMENTS;
        }, FIRST_PATH],
      ]),
      ['missing red case', (record) => { record.redExceptions[0].redCase = missingRedCase; }, missingRedCase],
      ['unknown miss kind', (record) => {
        record.redExceptions[0].missKinds = [unsupportedMissKind];
      }, unsupportedMissKind],
      ['unknown fault point', (record) => {
        record.faultExceptions[0].faultPoint = unsupportedFaultPoint;
      }, unsupportedFaultPoint],
    ];
    assertRecordRefusals(readRecord, cases);
  });
});

describe('wholeness against command-line files (spec:checker-verdict/S7)', () => {
  it('names each missing file marked by exactly one rule and accepts its word entry', async () => {
    const { readRecord, judgeWholeness } = await import('./record.mjs');
    const files = [
      buildFile('agent-workflow-kit/tools/manifest-bin.data', { bin: true }),
      buildFile('codex-cli-bridge/bin/check.sh'),
      buildFile('antigravity-cli-bridge/tools/interpreter.mjs', { interpreterLine: true }),
      buildFile('typesafe-jev-bridge/tools/guard.mjs', { guardName: true }),
    ];
    const emptyRecord = readRecord(JSON.stringify(buildWordRecord([])));
    for (const file of files) {
      const options = { files: [file], offered: [], commandTargets: [] };
      const findings = judgeWholeness(emptyRecord, options);
      assert.equal(findings.length, 1, file.path);
      assert.ok(findings[0].includes(file.path), file.path);
      const record = readRecord(JSON.stringify(buildWordRecord([file.path])));
      assert.deepEqual(judgeWholeness(record, options), [], file.path);
    }
  });

  it('names a record path with no command-line mark or no listed file', async () => {
    const { readRecord, judgeWholeness } = await import('./record.mjs');
    const path = 'agent-workflow-engine/tools/unmarked.mjs';
    const record = readRecord(JSON.stringify(buildWordRecord([path])));
    for (const files of [[buildFile(path)], []]) {
      const findings = judgeWholeness(record, { files, offered: [], commandTargets: [] });
      assert.equal(findings.length, 1);
      assert.ok(findings[0].includes(path));
    }
  });
});

describe('files left out of the census (spec:checker-verdict/S8)', () => {
  it('ignores marked mirrors, tests and fixtures and ineligible text extensions', async () => {
    const { readRecord, judgeWholeness } = await import('./record.mjs');
    const markedPaths = [
      'agent-workflow-kit/references/scripts/mirror.mjs',
      'agent-workflow-kit/bridges/codex-cli-bridge/bin/mirror.sh',
      'agent-workflow-kit/tools/check.test.mjs',
      'agent-workflow-memory/references/scripts/check.spec.js',
      'agent-workflow-engine/tools/nested/fixtures/check.mjs',
    ];
    const files = [
      ...markedPaths.map((path) => buildFile(path, {
        bin: true, interpreterLine: true, guardName: true,
      })),
      buildFile('agent-workflow-kit/CHANGELOG.md', { guardName: true }),
      buildFile('agent-workflow-memory/interpreter.txt', { interpreterLine: true }),
    ];
    const record = readRecord(JSON.stringify(buildWordRecord([])));
    assert.deepEqual(judgeWholeness(record, { files, offered: [], commandTargets: [] }), []);
  });
});

describe('wholeness against offered command lines (spec:checker-verdict/S9)', () => {
  it('accepts every real offered command line and command target', async () => {
    const { readRecord, judgeWholeness } = await import('./record.mjs');
    const fixture = buildOfferedFixture();
    const { offered, commandTargets } = fixture;
    const record = readRecord(JSON.stringify(fixture.record));
    const files = buildRecordFiles(record);
    assert.deepEqual(judgeWholeness(record, { files, offered, commandTargets }), []);
  });

  it('names a missing entry from each of the four real offered lists', async () => {
    const { readRecord, judgeWholeness } = await import('./record.mjs');
    const fixture = buildOfferedFixture();
    const { offered, commandTargets } = fixture;
    const removals = [
      ...KIT_CHECKER_CLAIMS.map((claim) => ({ name: claim.id, path: KIT_TOOLS + claim.path })),
      ...FINAL_CORE_CHECKS.map((check) => ({ name: check.name, path: relative(ROOT, check.canonical) })),
      { name: SOURCE_SIZE_NAME, path: relative(ROOT, SOURCE_SIZE_TOOL_PATH) },
      ...fixture.commandTargets,
    ];
    for (const { name, path } of removals) {
      const changed = structuredClone(fixture.record);
      changed.files = changed.files.filter((file) => file.path !== path);
      const record = readRecord(JSON.stringify(changed));
      const files = buildRecordFiles(record);
      const findings = judgeWholeness(record, { files, offered, commandTargets });
      assert.ok(findings.some((finding) => finding.includes(name)), name);
    }
  });

  it('names plan-shape when its arguments omit the offered in-flight flag', async () => {
    const { readRecord, judgeWholeness } = await import('./record.mjs');
    const fixture = buildOfferedFixture();
    const { offered, commandTargets } = fixture;
    const changed = structuredClone(fixture.record);
    const claim = KIT_CHECKER_CLAIMS.find(({ id }) => id === PLAN_SHAPE_NAME);
    const entry = changed.files.find(({ path }) => path === KIT_TOOLS + claim.path);
    entry.commandLines[0].arguments = CHECK_ARGUMENTS;
    const record = readRecord(JSON.stringify(changed));
    const files = buildRecordFiles(record);
    const findings = judgeWholeness(record, { files, offered, commandTargets });
    assert.ok(findings.some((finding) => finding.includes(PLAN_SHAPE_NAME)));
  });
});

it('exports the frozen record words and fault points in interface order', async () => {
  const { RECORD_WORDS, FAULT_POINTS } = await import('./record.mjs');
  assert.deepEqual(RECORD_WORDS, [
    WRITER_WORD, 'advisor', INSTALLER_WORD, 'hook', 'server', 'launcher', 'bridge', LIBRARY_WORD,
  ]);
  assert.deepEqual(FAULT_POINTS, EXPECTED_FAULT_POINTS);
  assert.equal(Object.isFrozen(RECORD_WORDS), true);
  assert.equal(Object.isFrozen(FAULT_POINTS), true);
});
