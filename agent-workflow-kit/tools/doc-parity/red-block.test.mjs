import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const parity = await import('../doc-parity.mjs');
const { main, BINDINGS, checkParity, checkMatrixStructure } = parity;
const door = await import('./index.mjs').catch(() => ({}));
const { CHECKER_NAME, formatHuman, formatCheckPass, composeDriftBlock } = door;
const matrix = await import('../advisor-matrix.mjs');
const { ADVISOR_MATRIX_DOC, readKitDoc } = matrix;
const { runCheckerTail } = await import('../checker-block/index.mjs').catch(() => ({}));
const { judgeBlock } = await import('../checker-verdict/index.mjs').catch(() => ({}));

const NAME = 'doc-parity';
const FAIL = `${NAME}: FAIL — `;
const REMEDY = `${NAME}: REMEDY — `;
const BINDING_CLASS = 'drifted binding(s)';
const STRUCTURE_CLASS = 'the advisor matrix structure drifted';
const PASS = `doc-parity check: PASS — ${BINDINGS.length} binding(s) consistent; the advisor matrix structure corresponds`;
const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const KIT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ENTRY = join(KIT_ROOT, 'tools/doc-parity.mjs');
const JSON_CHECK = [['--json', '--check'], ['--check', '--json']];
const UNKNOWN = '--mystery';
const TWIN = BINDINGS.find(({ files }) => files.length === 2);

const runCommand = (args, cwd = REPO_ROOT, entry = ENTRY) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [entry, ...args], { cwd, env, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};
const linesOf = (stdout) => stdout.replace(/\n$/, '').split('\n');
const tempDirectory = (test) => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-parity-red-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const removeToken = (text, { token }) => text.replaceAll(token, '');
const withoutTokens = (edits) => (rel) =>
  edits.reduce((text, [binding, files]) => files.includes(rel) ? removeToken(text, binding) : text, readKitDoc(rel));
const bothFilesDrift = () => withoutTokens([[TWIN, TWIN.files]]);
const oneFileDrifts = () => withoutTokens([[TWIN, [TWIN.files[0]]]]);

const driftMatrix = (readText) => (rel) => {
  const text = readText(rel);
  if (rel !== ADVISOR_MATRIX_DOC) return text;
  const begin = text.indexOf(matrix.ADVISOR_MATRIX_BEGIN);
  assert.ok(begin >= 0);
  const row = /^(\| `[^`]+` \| )[^|]+(?= \|)/m;
  const surface = text.slice(begin);
  assert.match(surface, row);
  return text.slice(0, begin) + surface.replace(row, '$1wrong vehicle');
};

const finding = (file, cwd, constant) => {
  const path = resolve(KIT_ROOT, file.rel);
  return { place: path.startsWith(`${cwd}/`) ? relative(cwd, path) : path, constant, reason: file.reason };
};
const bindingFindings = (results, cwd) => results.flatMap(({ constant, files }) =>
  files.filter(({ ok }) => !ok).map((file) => finding(file, cwd, constant)));

const readDriftBlock = (lines, findings, { bindings, structure = false }) => {
  const [verdict, ...body] = lines;
  assert.ok(verdict?.startsWith(FAIL), lines.join('\n'));
  assert.equal(lines.filter((line) => line.startsWith(FAIL)).length, 1);
  assert.equal(verdict.split(BINDING_CLASS).length - 1, bindings ? 1 : 0, verdict);
  assert.equal(verdict.split(STRUCTURE_CLASS).length - 1, structure ? 1 : 0, verdict);
  if (bindings) assert.ok(verdict.includes(`${bindings} ${BINDING_CLASS}`), verdict);
  if (bindings && structure) assert.ok(verdict.indexOf(BINDING_CLASS) < verdict.indexOf(STRUCTURE_CLASS), verdict);
  assert.deepEqual(verdict.match(/\b\d+\b/g), bindings ? [String(bindings)] : null);

  const remedy = body.pop();
  assert.ok(remedy?.startsWith(REMEDY), lines.join('\n'));
  assert.equal(lines.filter((line) => line.startsWith(REMEDY)).length, 1);
  const places = body.map((line) => line.slice(0, line.indexOf(': ')));
  assert.deepEqual(places, findings.map(({ place }) => place));
  for (const [index, { place, lead = '', constant, reason }] of findings.entries()) {
    const line = body[index];
    const prefix = `${place}: ${lead}`;
    assert.ok(line.startsWith(prefix), line);
    const text = line.slice(prefix.length);
    if (constant === undefined) assert.ok(text.includes(reason), line);
    else {
      const start = text.indexOf(constant);
      assert.ok(start >= 0 && text.includes(reason, start + constant.length), line);
    }
  }
  assert.deepEqual(judgeBlock(lines.join('\n'), { name: NAME, places }), []);
  return remedy;
};
const check = (readText, cwd = REPO_ROOT) => main(['--check'], { readText, cwd });
const readCheckBlock = ({ code, stdout, stderr }, findings, classes) => {
  assert.equal(code, 1, stdout);
  assert.equal(stderr, '');
  return readDriftBlock(linesOf(stdout), findings, classes);
};
const assertSameRemedy = (remedy) => assert.equal(remedy, linesOf(check(bothFilesDrift()).stdout).at(-1));

it('spec:doc-parity/S1 one drifted binding names both files in registry order', () => {
  const readText = bothFilesDrift();
  const results = checkParity(BINDINGS, readText);
  const drifted = results.filter(({ ok }) => !ok);
  assert.deepEqual(drifted.map(({ constant }) => constant), [TWIN.constant]);
  const findings = bindingFindings(drifted, REPO_ROOT);
  assert.deepEqual(findings.map(({ place }) => place), TWIN.files.map((rel) => `agent-workflow-kit/${rel}`));
  readCheckBlock(check(readText), findings, { bindings: 1 });
});

describe('spec:doc-parity/S2 unreadable documents keep their read error reason', () => {
  const faults = [
    ['a read error with EACCES', Object.assign(new Error('permission denied'), { code: 'EACCES' })],
    ['a read error with only a message', new Error('read failed without a code')],
  ];
  for (const [name, error] of faults) it(name, () => {
    const boundFiles = BINDINGS.flatMap(({ files }) => files);
    const rel = boundFiles.find((file) => file !== ADVISOR_MATRIX_DOC && boundFiles.indexOf(file) === boundFiles.lastIndexOf(file));
    const binding = BINDINGS.find(({ files }) => files.includes(rel));
    assert.ok(binding, 'expected a file used by exactly one binding');
    const readText = (file) => {
      if (file === rel) throw error;
      return readKitDoc(file);
    };
    const findings = bindingFindings([parity.checkBinding(binding, readText)], REPO_ROOT);
    assert.equal(findings.length, 1);
    assert.ok(findings[0].reason.includes(error.code ?? error.message));
    assertSameRemedy(readCheckBlock(check(readText), findings, { bindings: 1 }));
  });
});

describe('spec:doc-parity/S3 the matrix finding follows any binding findings', () => {
  for (const [name, bindings] of [['structure alone', 0], ['structure beside two drifted bindings', 2]]) it(name, () => {
    const second = BINDINGS.find((b) => b !== TWIN && b.files.length === 2 && b.token !== TWIN.token);
    const edits = bindings ? [[TWIN, [TWIN.files[1]]], [second, [second.files[0]]]] : [];
    const readText = driftMatrix(withoutTokens(edits));
    const results = checkParity(BINDINGS, readText);
    assert.deepEqual(results.filter(({ ok }) => !ok).map(({ constant }) => constant), edits.map(([b]) => b.constant));
    const structure = checkMatrixStructure(readText);
    assert.equal(structure.ok, false);
    const matrixFinding = finding(structure.files[0], REPO_ROOT);
    assert.equal(matrixFinding.place, 'agent-workflow-kit/references/modes/dispatch.md');
    const findings = [...bindingFindings(results, REPO_ROOT), matrixFinding];
    assertSameRemedy(readCheckBlock(check(readText), findings, { bindings, structure: true }));
  });
});

describe('spec:doc-parity/S4 places follow the working directory and protect the block form', () => {
  for (const [name, inside] of [['kit-relative paths', true], ['absolute paths from outside the kit', false]]) {
    it(name, (test) => {
      const cwd = inside ? KIT_ROOT : tempDirectory(test);
      const readText = bothFilesDrift();
      const findings = bindingFindings([parity.checkBinding(TWIN, readText)], cwd);
      assert.deepEqual(findings.map(({ place }) => place), TWIN.files.map((rel) => inside ? rel : resolve(KIT_ROOT, rel)));
      assertSameRemedy(readCheckBlock(check(readText, cwd), findings, { bindings: 1 }));
    });
  }

  it('a relative working directory places each doc inside it relative to it', () => {
    const readText = bothFilesDrift();
    const findings = bindingFindings([parity.checkBinding(TWIN, readText)], KIT_ROOT);
    assertSameRemedy(readCheckBlock(check(readText, relative(process.cwd(), KIT_ROOT) || '.'), findings, { bindings: 1 }));
  });

  it('hostile paths lead the text at the dot place', () => {
    const constant = 'CAP';
    const reason = 'token "cap 42" not found';
    const files = ['a:b.md', ' lead.md', 'back\\slash.md', NAME, 'plain.md'].map((rel) => ({ rel, ok: false, reason }));
    const results = [{ constant, token: 'cap 42', files, ok: false }];
    const structure = checkMatrixStructure();
    assert.equal(typeof composeDriftBlock, 'function');
    const lines = composeDriftBlock({ results, structure, cwd: KIT_ROOT });
    assert.ok(Array.isArray(lines));
    const findings = [
      ...['a:b.md', ' lead.md', 'back\\slash.md', NAME].map((rel) => ['.', `${resolve(KIT_ROOT, rel)}: `]), ['plain.md', ''],
    ].map(([place, lead]) => ({ place, lead, constant, reason }));
    assertSameRemedy(readDriftBlock(lines, findings, { bindings: 1 }));
  });
});

const usageLines = (help) => {
  const lines = linesOf(help);
  const start = lines.indexOf('Usage:');
  const end = lines.indexOf('', start);
  assert.ok(start >= 0 && end > start + 1);
  return lines.slice(start, end);
};

describe('spec:doc-parity/S5 command-line usage refusals and help precedence', () => {
  for (const [name, args] of [
    ['unknown argument', [UNKNOWN]],
    ['unknown argument containing a line feed', ['--mystery\nnext']],
    ['unknown argument beside --json', ['--json', UNKNOWN]],
  ]) it(name, () => {
    const { code, stdout, stderr } = runCommand(args);
    assert.equal(code, 2);
    assert.equal(stderr, '');
    const [verdict, ...usage] = linesOf(stdout);
    assert.ok(verdict.startsWith(FAIL) && verdict.includes(JSON.stringify(args.at(-1))), stdout);
    assert.ok(stdout.endsWith('\n'));
    assert.deepEqual(usage, usageLines(runCommand(['--help']).stdout));
    if (args.includes('--json')) assert.deepEqual(runCommand([UNKNOWN]), { code, stdout, stderr });
  });

  it('--help and -h take precedence over an unknown argument', () => {
    const help = runCommand(['--help']);
    assert.deepEqual(help, { code: 0, stdout: `${main(['--help']).stdout}\n`, stderr: '' });
    for (const flag of ['--help', '-h']) assert.deepEqual(runCommand([UNKNOWN, flag]), help);
  });
});

describe('spec:doc-parity/S6 the direct-run tail guards an unexpected read value', () => {
  for (const argv of [[], ['--check'], ['--json', '--check']]) it(argv.join(' ') || 'no arguments', () => {
    const readText = () => 42;
    let message;
    assert.throws(() => parity.checkBinding(TWIN, readText), (error) => {
      assert.ok(error instanceof TypeError);
      message = error.message.split('\n')[0];
      return true;
    });
    const writes = [];
    const errors = [];
    const host = { stdout: { write: (text) => writes.push(text) }, stderr: { write: (text) => errors.push(text) } };
    const remedy = 'return document text from the reader';
    const code = runCheckerTail({ name: NAME, exitCode: 1, remedy }, () => main(argv, { readText }), host);
    assert.deepEqual([code, host.exitCode, errors], [1, 1, []]);
    assert.equal(writes.length, 1, 'expected one guarded stdout block');
    const [verdict, remedyLine, errorLine, ...stack] = linesOf(writes[0]);
    assert.equal(verdict, `${FAIL}unexpected error: ${message}`);
    assert.equal(remedyLine, `${REMEDY}${remedy}`);
    assert.match(errorLine, /^TypeError: /);
    assert.ok(stack.length > 0);
    for (const frame of stack) assert.match(frame, /^    at /);
  });
});

const machineAnswer = (readText, code, ok) => ({
  code, stdout: JSON.stringify({ results: checkParity(BINDINGS, readText), structure: checkMatrixStructure(readText), ok }, null, 2), stderr: '',
});

describe('spec:doc-parity/S7 machine documents and green output stay byte-for-byte', () => {
  for (const flags of JSON_CHECK) it(`main ${flags.join(' ')} with and without drift`, () => {
    for (const [readText, code, ok] of [[oneFileDrifts(), 1, false], [readKitDoc, 0, true]]) {
      assert.deepEqual(main(flags, { readText }), machineAnswer(readText, code, ok));
    }
  });

  it('copied command prints only JSON in both flag orders after one doc drifts', (test) => {
    const copy = tempDirectory(test);
    const entry = join(copy, 'tools/doc-parity.mjs');
    for (const item of ['tools', 'references', 'package.json']) cpSync(join(KIT_ROOT, item), join(copy, item), { recursive: true });
    assert.deepEqual(runCommand(['--check'], copy, entry), { code: 0, stdout: `${PASS}\n`, stderr: '' });
    const path = join(copy, TWIN.files[0]);
    writeFileSync(path, removeToken(readFileSync(path, 'utf8'), TWIN));
    const expected = machineAnswer(oneFileDrifts(), 1, false);
    for (const flags of JSON_CHECK) assert.deepEqual(runCommand(flags, copy, entry), { ...expected, stdout: `${expected.stdout}\n` });
  });

  it('formatHuman prints the report literals for a passing and a failing structure', () => {
    const results = [
      { constant: 'CAP', token: 'cap 42', ok: false, files: [
        { rel: 'first.md', ok: true, reason: null }, { rel: 'second.md', ok: false, reason: 'token "cap 42" not found' },
      ] },
      { constant: 'MODE', token: 'read-only', ok: true, files: [{ rel: 'third.md', ok: true, reason: null }] },
    ];
    const header = [
      'doc-parity — code constants ⟷ references/modes/*.md contract (read-only, BUGFREE-3)',
      '  \u2713 CAP → first.md', '  \u2717 CAP → second.md — token "cap 42" not found', '  \u2713 MODE → third.md',
    ];
    assert.equal(typeof formatHuman, 'function');
    for (const [ok, reason, row, summary] of [
      [true, null, '  \u2713 matrix → dispatch.md', '  check: FAIL — 1 drifted binding(s): CAP @ second.md, structure PASS'],
      [false, 'wrong cell', '  \u2717 matrix → dispatch.md — wrong cell', '  check: FAIL — 1 drifted binding(s): CAP @ second.md, structure FAIL'],
    ]) {
      const structure = { constant: 'matrix', ok, files: [{ rel: 'dispatch.md', ok, reason }] };
      assert.equal(formatHuman(results, structure), [...header, row, summary].join('\n'));
    }
  });

  it('main plain report agrees with formatHuman with and without drift', () => {
    assert.equal(typeof formatHuman, 'function');
    for (const readText of [readKitDoc, oneFileDrifts()]) {
      const stdout = formatHuman(checkParity(BINDINGS, readText), checkMatrixStructure(readText));
      assert.deepEqual(main([], { readText }), { code: 0, stdout, stderr: '' });
    }
  });

  it('main --json agrees with the two check results', () => {
    assert.deepEqual(main(['--json']), machineAnswer(readKitDoc, 0, true));
  });

  it('main --check keeps the pass line', () => {
    assert.deepEqual(main(['--check']), { code: 0, stdout: PASS, stderr: '' });
  });

  it('formatCheckPass keeps the pass line', () => {
    assert.equal(typeof formatCheckPass, 'function');
    assert.equal(formatCheckPass(checkParity()), PASS);
  });

  it('main --help and -h print the help', () => {
    const help = main(['--help']);
    assert.deepEqual([help.code, help.stderr], [0, '']);
    assert.match(help.stdout, /^doc-parity — deterministic doc-drift lint/);
    assert.deepEqual(usageLines(help.stdout), ['Usage:', '  node doc-parity.mjs [--check | --json]']);
    assert.deepEqual(main(['-h']), help);
  });

  it('the main usage refusal prints the help usage lines', () => {
    const refusal = main([UNKNOWN]);
    assert.deepEqual(linesOf(refusal.stdout).slice(1), usageLines(main(['--help']).stdout));
  });

  for (const args of [['--help'], [], ['--json'], ['--check'], JSON_CHECK[0]]) it(`green command ${args.join(' ') || 'without flags'}`, () => {
    const expected = main(args);
    assert.ok(expected.stdout.length > 0);
    assert.deepEqual(runCommand(args), { code: 0, stdout: `${expected.stdout}\n`, stderr: '' });
  });
});

describe('spec:doc-parity/S8 the kit doc resolver and module boundaries', () => {
  it('readKitDoc reads the path returned by resolveKitDoc', (test) => {
    assert.equal(typeof matrix.resolveKitDoc, 'function');
    const paths = [];
    const mocked = test.mock.method(fs, 'readFileSync', (path) => { paths.push(path); return 'doc text'; });
    syncBuiltinESMExports();
    try {
      assert.equal(readKitDoc(ADVISOR_MATRIX_DOC), 'doc text');
      const path = matrix.resolveKitDoc(ADVISOR_MATRIX_DOC);
      assert.equal(path, resolve(KIT_ROOT, ADVISOR_MATRIX_DOC));
      assert.deepEqual(paths, [path]);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
  });

  it('the doc-parity door exports its name and uses only the two allowed imports', () => {
    const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /import\.meta/);
    const declarations = source.matchAll(/^\s*import\b\s*(?:[^'";]+?\bfrom\s*)?['"]([^'"]+)['"]/gm);
    const imports = Array.from(declarations, ([, spec]) => spec);
    assert.deepEqual([...new Set(imports)].sort(), ['../advisor-matrix.mjs', '../checker-block/index.mjs']);
    assert.equal(CHECKER_NAME, NAME);
    assert.deepEqual(Object.keys(door).sort(), ['CHECKER_NAME', 'composeDriftBlock', 'formatCheckPass', 'formatHuman']);
  });

  it('the command entry uses import.meta only for isDirectRun', () => {
    const lines = linesOf(readFileSync(ENTRY, 'utf8')).filter((line) => line.includes('import.meta'));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /isDirectRun/);
  });
});
