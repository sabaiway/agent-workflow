import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandLineOf, runCase, runCensus } from './run-harness.test.mjs';
import { copyPackageFolders } from './fixtures-family-harness.test.mjs';

const workspace = {};
const CHECKER_NAME = 'fixture-check';
const CHECKER_FILE = 'checker.mjs';
const PROJECT_FILE = 'fixture.txt';
const DECLARED_PLACE = `${PROJECT_FILE}:1`;
const RED_CASE = 'invalid-fixture';
const FINDING_TEXT = 'invalid fixture';
const VERDICT_LINE = `${CHECKER_NAME}: FAIL — fixture rejected`;
const REMEDY_LINE = `${CHECKER_NAME}: REMEDY — replace the fixture`;
const SIBLING_TEXT = 'sibling module loaded';
const LAUNCHER_TEXT = 'launcher calls completed';
const FAILURE_CODE = 1;
const SUCCESS_CODE = 0;
const FILE_CALLS = [
  `readFileSync(${JSON.stringify(PROJECT_FILE)}, 'utf8');`,
  `statSync(${JSON.stringify(PROJECT_FILE)});`,
  "readdirSync('.');",
];

before(() => {
  workspace.root = mkdtempSync(join(tmpdir(), 'census-proof-'));
});
after(() => {
  if (workspace.root) rmSync(workspace.root, { recursive: true, force: true });
});

const renderPrint = (text) => `console.log(${JSON.stringify(text)});`;
const indentLines = (lines) => lines.map((line) => `  ${line}`);
const buildCheckerText = ({
  red = 'base', fault = 'verdict', calls = true, sibling = false, resolveFirst = false, launchEntry,
} = {}) => {
  const imports = [
    "import { readFileSync, statSync, readdirSync, realpathSync } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    ...(sibling ? ["import { text } from './sibling.mjs';", 'console.log(text);'] : []),
  ];
  if (launchEntry) {
    return [...imports, ...FILE_CALLS, renderPrint(LAUNCHER_TEXT),
      `const result = spawnSync(process.execPath, [${JSON.stringify(launchEntry)}], { stdio: 'inherit' });`,
      'if (result.error) throw result.error;',
      'process.exitCode = result.status;',
    ].join('\n');
  }
  const redLines = [
    ...(red === 'note-first' ? ['fixture note'] : []),
    VERDICT_LINE,
    `${red === 'wrong-place' ? 'other.txt:1' : DECLARED_PLACE}: ${FINDING_TEXT}`,
    ...(red === 'no-remedy' ? [] : [REMEDY_LINE]),
  ];
  const body = [
    ...(resolveFirst ? [`console.log(realpathSync(${JSON.stringify(PROJECT_FILE)}));`] : []),
    ...(calls ? [...FILE_CALLS, "spawnSync(process.execPath, ['--version']);"] : []),
    ...redLines.map(renderPrint),
    `process.exitCode = ${red === 'exit-zero' ? SUCCESS_CODE : FAILURE_CODE};`,
  ];
  if (fault === 'escape') return [...imports, ...body].join('\n');
  const verdict = `${CHECKER_NAME}: FAIL — unexpected error`;
  const handler = [
    fault === 'verdict' || fault === 'exit-zero'
      ? `console.log(${JSON.stringify(`${verdict}: `)} + error.message);`
      : renderPrint(verdict),
    ...(fault === 'finding' ? [`console.log(${JSON.stringify(`${DECLARED_PLACE}: `)} + error.message);`] : []),
    renderPrint(REMEDY_LINE),
    ...(fault === 'below-head' ? ['console.log(error.message);'] : []),
    `process.exitCode = ${fault === 'exit-zero' ? SUCCESS_CODE : FAILURE_CODE};`,
  ];
  return [...imports, 'try {', ...indentLines(body), '} catch (error) {',
    ...indentLines(handler), '}',
  ].join('\n');
};

const buildProject = (project) => {
  writeFileSync(join(project, PROJECT_FILE), `${FINDING_TEXT}\n`);
};
const createChecker = (identity, variation = {}) => {
  const directory = join(workspace.root, identity);
  mkdirSync(directory);
  writeFileSync(join(directory, CHECKER_FILE), buildCheckerText(variation));
  if (variation.sibling) {
    writeFileSync(join(directory, 'sibling.mjs'), `export const text = ${JSON.stringify(SIBLING_TEXT)};\n`);
  }
  return { path: `${identity}/${CHECKER_FILE}`, commandArguments: [], redCase: RED_CASE, build: buildProject };
};
const readFixtureRecord = (readRecord, checker, { redMisses = [], faultPoints = [] } = {}) => {
  const { path } = checker;
  return readRecord(JSON.stringify({
    files: [{ path, commandLines: [{
      name: CHECKER_NAME, arguments: [], redCases: [{ name: RED_CASE, places: [DECLARED_PLACE] }],
    }] }],
    redExceptions: redMisses.length ? [{ path, arguments: [], redCase: RED_CASE, missKinds: redMisses }] : [],
    faultExceptions: faultPoints.map((faultPoint) => ({ path, arguments: [], faultPoint })),
  }));
};
const assertCensus = async (readRecord, checker, exceptions, expected) => {
  const record = readFixtureRecord(readRecord, checker, exceptions);
  const problems = await runCensus({ record, fixtures: [checker], root: workspace.root });
  assert.deepEqual(problems.map(({ path, commandArguments, ...problem }) => {
    assert.equal(path, checker.path);
    assert.deepEqual(commandArguments, []);
    return problem;
  }), expected);
};
const createDirectCase = (identity, variation = {}) => {
  const checker = createChecker(identity, variation);
  const directory = join(workspace.root, identity);
  const project = join(directory, 'project');
  mkdirSync(project);
  checker.build(project);
  return { checker, project, entry: join(workspace.root, checker.path), marks: join(directory, 'marks') };
};
const runDirectCase = ({ checker, project }, environment, path = checker.path) => runCase({
  project,
  commandLine: commandLineOf({ root: workspace.root, path, commandArguments: [] }),
  environment,
});
const buildFaultBlock = (phrase) => `${CHECKER_NAME}: FAIL — unexpected error: ${phrase}\n${REMEDY_LINE}`;

describe('red census proofs (spec:checker-verdict/S11)', () => {
  it('accepts a checker that follows the form', async () => {
    const { readRecord } = await import('./record.mjs');
    await assertCensus(readRecord, createChecker('red-base'), {}, []);
  });

  for (const [variation, missKind] of [
    ['note-first', 'verdict'], ['wrong-place', 'place'], ['no-remedy', 'remedy'],
  ]) {
    it(`reports only ${missKind} for ${variation}`, async () => {
      const { readRecord } = await import('./record.mjs');
      const checker = createChecker(`red-${variation}`, { red: variation });
      await assertCensus(readRecord, checker, {}, [
        { problem: 'unlisted-miss', redCase: RED_CASE, missKinds: [missKind] },
      ]);
    });

    it(`accepts the exact ${missKind} exception for ${variation}`, async () => {
      const { readRecord } = await import('./record.mjs');
      const checker = createChecker(`red-listed-${variation}`, { red: variation });
      await assertCensus(readRecord, checker, { redMisses: [missKind] }, []);
    });
  }

  it('reports exit-0 while fault runs still exit non-zero', async () => {
    const { readRecord } = await import('./record.mjs');
    await assertCensus(readRecord, createChecker('red-exit-zero', { red: 'exit-zero' }), {}, [
      { problem: 'exit-0', redCase: RED_CASE },
    ]);
  });

  it('reports a stale red exception when the checker follows the form', async () => {
    const { readRecord } = await import('./record.mjs');
    await assertCensus(readRecord, createChecker('red-stale'), { redMisses: ['verdict'] }, [
      { problem: 'stale-miss', redCase: RED_CASE, missKinds: [] },
    ]);
  });
});

describe('fault census proofs (spec:checker-verdict/S12)', () => {
  for (const [variation, description] of [
    ['escape', 'an error escaping before the verdict'],
    ['below-head', 'a phrase only below the head'],
    ['no-phrase', 'a phrase printed nowhere'],
    ['exit-zero', 'exit 0 after catching a fired fault'],
  ]) {
    it(`reports four misses for ${description}`, async () => {
      const { readRecord, FAULT_POINTS } = await import('./record.mjs');
      const checker = createChecker(`fault-${variation}`, { fault: variation });
      await assertCensus(readRecord, checker, {}, FAULT_POINTS.map((faultPoint) => ({
        problem: 'unlisted-fault-miss', faultPoint,
      })));
    });

    it(`accepts all four exact exceptions for ${description}`, async () => {
      const { readRecord, FAULT_POINTS } = await import('./record.mjs');
      const checker = createChecker(`fault-listed-${variation}`, { fault: variation });
      await assertCensus(readRecord, checker, { faultPoints: FAULT_POINTS }, []);
    });
  }

  it('accepts the fault phrase in a finding line of the head', async () => {
    const { readRecord } = await import('./record.mjs');
    await assertCensus(readRecord, createChecker('fault-finding', { fault: 'finding' }), {}, []);
  });

  it('accepts the fault phrase in the verdict line', async () => {
    const { readRecord } = await import('./record.mjs');
    await assertCensus(readRecord, createChecker('fault-verdict'), {}, []);
  });

  it('reports a stale fault exception for a counted run that follows the form', async () => {
    const { readRecord, FAULT_POINTS } = await import('./record.mjs');
    const [faultPoint] = FAULT_POINTS;
    await assertCensus(readRecord, createChecker('fault-stale'), { faultPoints: [faultPoint] }, [
      { problem: 'stale-fault-miss', faultPoint },
    ]);
  });

  it('reports no-fault-fired when the checker makes no replaced call', async () => {
    const { readRecord } = await import('./record.mjs');
    await assertCensus(readRecord, createChecker('fault-no-calls', { calls: false }), {}, [
      { problem: 'no-fault-fired' },
    ]);
  });
});

describe('fault process and call boundaries (spec:checker-verdict/S13)', () => {
  it('loads a sibling module under every fault and marks the checker entry', async () => {
    const { FAULT_POINTS } = await import('./record.mjs');
    const { faultEnvironment, readFaultMarks, faultPhrase } = await import('./fault-harness.test.mjs');
    for (const point of FAULT_POINTS) {
      const direct = createDirectCase(`sibling-${point}`, { sibling: true });
      const environment = faultEnvironment({ point, entry: direct.entry, marks: direct.marks });
      assert.deepEqual(runDirectCase(direct, environment), {
        code: FAILURE_CODE, block: `${SIBLING_TEXT}\n${buildFaultBlock(faultPhrase(point))}`,
      });
      assert.deepEqual(readFaultMarks(direct.marks), [direct.entry]);
    }
  });

  it('spares launcher calls under every fault and marks only the checker', async () => {
    const { FAULT_POINTS } = await import('./record.mjs');
    const { faultEnvironment, readFaultMarks, faultPhrase } = await import('./fault-harness.test.mjs');
    for (const point of FAULT_POINTS) {
      const direct = createDirectCase(`launcher-${point}`);
      const launcher = `launcher-${point}/launcher.mjs`;
      writeFileSync(join(workspace.root, launcher), buildCheckerText({ launchEntry: direct.entry }));
      const environment = faultEnvironment({ point, entry: direct.entry, marks: direct.marks });
      assert.deepEqual(runDirectCase(direct, environment, launcher), {
        code: FAILURE_CODE, block: `${LAUNCHER_TEXT}\n${buildFaultBlock(faultPhrase(point))}`,
      });
      assert.deepEqual(readFaultMarks(direct.marks), [direct.entry]);
    }
  });

  it('spares realpathSync under stat before any other checker call', async () => {
    const { FAULT_POINTS } = await import('./record.mjs');
    const { faultEnvironment, readFaultMarks, faultPhrase } = await import('./fault-harness.test.mjs');
    const point = FAULT_POINTS.find((candidate) => candidate === 'stat');
    assert.equal(point, 'stat');
    const direct = createDirectCase('resolve-stat', { resolveFirst: true });
    const environment = faultEnvironment({ point, entry: direct.entry, marks: direct.marks });
    assert.deepEqual(runDirectCase(direct, environment), {
      code: FAILURE_CODE,
      block: `${realpathSync(join(direct.project, PROJECT_FILE))}\n${buildFaultBlock(faultPhrase(point))}`,
    });
    assert.deepEqual(readFaultMarks(direct.marks), [direct.entry]);
  });

  it('replaces nothing and leaves no mark when the preload names no fault point', async () => {
    const { FAULT_POINTS } = await import('./record.mjs');
    const { faultEnvironment, readFaultMarks, FAULT_POINT_ENV } = await import('./fault-harness.test.mjs');
    const direct = createDirectCase('preload-inactive');
    const environment = faultEnvironment({ point: undefined, entry: direct.entry, marks: direct.marks });
    assert.equal(FAULT_POINTS.includes(environment[FAULT_POINT_ENV]), false);
    const expected = {
      code: FAILURE_CODE, block: `${VERDICT_LINE}\n${DECLARED_PLACE}: ${FINDING_TEXT}\n${REMEDY_LINE}`,
    };
    assert.deepEqual(runDirectCase(direct, environment), expected);
    assert.equal(existsSync(direct.marks), false);
    assert.deepEqual(readFaultMarks(direct.marks), []);
  });
});

describe('own package census proof (spec:checker-verdict/S15)', () => {
  it('runs the laid-in checker and leaves every original file unchanged', async () => {
    const { readRecord } = await import('./record.mjs');
    const packagePath = 'fixture-package';
    const checkerPath = `${packagePath}/tools/${CHECKER_FILE}`;
    const documentPath = `${packagePath}/references/doc.md`;
    const token = 'required document token';
    const packageFolders = ['tools', 'references'];
    const packageFiles = [checkerPath, documentPath];
    const checkerText = [
      "import { readFileSync, realpathSync } from 'node:fs';",
      "import { relative, sep } from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      "const document = new URL('../references/doc.md', import.meta.url);",
      'try {',
      ...indentLines([
        "const text = readFileSync(document, 'utf8');",
        `if (text.includes(${JSON.stringify(token)})) {`,
        ...indentLines([
          renderPrint(`${CHECKER_NAME}: PASS — document token present`),
          `process.exitCode = ${SUCCESS_CODE};`,
        ]),
        '} else {',
        ...indentLines([
          'const place = relative(realpathSync(process.cwd()), realpathSync(fileURLToPath(document)));',
          renderPrint(VERDICT_LINE),
          `console.log(place.split(sep).join('/') + ${JSON.stringify(`: ${FINDING_TEXT}`)});`,
          renderPrint(REMEDY_LINE),
          `process.exitCode = ${FAILURE_CODE};`,
        ]),
        '}',
      ]),
      '} catch (error) {',
      ...indentLines([
        `console.log(${JSON.stringify(`${CHECKER_NAME}: FAIL — unexpected error: `)} + error.message);`,
        renderPrint(REMEDY_LINE),
        `process.exitCode = ${FAILURE_CODE};`,
      ]),
      '}',
    ].join('\n');
    for (const folder of packageFolders) {
      mkdirSync(join(workspace.root, packagePath, folder), { recursive: true });
    }
    writeFileSync(join(workspace.root, checkerPath), checkerText);
    writeFileSync(join(workspace.root, documentPath), `${token}\n`);
    const originalBytes = packageFiles.map((path) => readFileSync(join(workspace.root, path)));
    const fixture = {
      path: checkerPath,
      commandArguments: [],
      redCase: RED_CASE,
      ownPackage: packagePath,
      build: (project) => {
        copyPackageFolders(workspace.root, project, packagePath, packageFolders);
        const destination = join(project, documentPath);
        writeFileSync(destination, readFileSync(destination, 'utf8').replaceAll(token, ''));
      },
    };
    const record = readRecord(JSON.stringify({
      files: [{ path: checkerPath, commandLines: [{
        name: CHECKER_NAME,
        arguments: [],
        redCases: [{ name: RED_CASE, places: [documentPath] }],
      }] }],
      redExceptions: [],
      faultExceptions: [],
    }));
    const project = mkdtempSync(join(tmpdir(), 'census-own-package-'));
    try {
      const commandLine = commandLineOf({ root: workspace.root, path: checkerPath, commandArguments: [] });
      assert.equal(runCase({ project, commandLine }).code, SUCCESS_CODE);
      assert.deepEqual(await runCensus({ record, fixtures: [fixture], root: workspace.root }), []);
      assert.deepEqual(packageFiles.map((path) => readFileSync(join(workspace.root, path))), originalBytes);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
