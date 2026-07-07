import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GATES_REL,
  EXIT,
  validateDeclaration,
  loadDeclaration,
  selectGates,
  composeSummaryLine,
  runCli,
  BASH_PROBE_CMD,
} from './run-gates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_TEMPLATE = join(HERE, '..', 'references', 'templates', 'gates.json');

// ── hermetic harness: an in-memory declaration + an injected spawn (never the real matrix) ──
// The injected spawn also answers the bash preflight (BASH_PROBE_CMD) — a test that wants the
// "no bash" outcome makes the probe itself fail with ENOENT.

const memFs = (files) => ({
  readFile: (path) => {
    const rel = Object.keys(files).find((name) => path.endsWith(name));
    if (rel === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return files[rel];
  },
  lstat: (path) => {
    const rel = Object.keys(files).find((name) => path.endsWith(name));
    if (rel === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return {};
  },
});

const declarationOf = (gates) => JSON.stringify({ _README: 'x', gates }, null, 2);

// A scripted spawn: cmd → { status, stdout, stderr } (plus the always-green bash probe).
const scriptedSpawn = (byCmd, calls = []) => (cmd, cwd) => {
  calls.push({ cmd, cwd });
  if (cmd === BASH_PROBE_CMD) return byCmd[BASH_PROBE_CMD] ?? { status: 0, stdout: '', stderr: '' };
  const res = byCmd[cmd];
  if (res === undefined) throw new Error(`unscripted cmd: ${cmd}`);
  return res;
};

const runHermetic = ({ gates, argv = [], byCmd = {}, files = null, deps = {} }) => {
  const out = [];
  const err = [];
  const calls = [];
  const fsDeps = files ?? memFs({ [GATES_REL]: declarationOf(gates) });
  const code = runCli(argv, {
    cwd: '/proj',
    log: (line) => out.push(line),
    logError: (line) => err.push(line),
    spawn: scriptedSpawn(byCmd, calls),
    readFile: fsDeps.readFile,
    lstat: fsDeps.lstat,
    now: (() => {
      let tick = 0;
      return () => {
        tick += 100;
        return tick;
      };
    })(),
    ...deps,
  });
  return { code, out, err, calls, text: out.join('\n'), errText: err.join('\n') };
};

const GREEN = { status: 0, stdout: 'fine\n', stderr: '' };

// ── declaration schema (strict; malformed → the loud exit-5 class) ───────────────────────

describe('validateDeclaration — strict schema, loud rejections', () => {
  const gate = (over = {}) => ({ id: 'unit-tests', title: 'Unit tests', cmd: 'node --test x', ...over });

  it('accepts a minimal valid declaration and returns the gates array', () => {
    const gates = validateDeclaration({ _README: 'doc', gates: [gate()] });
    assert.equal(gates.length, 1);
    assert.equal(gates[0].id, 'unit-tests');
  });

  it('accepts an empty gates list (the shipped template shape)', () => {
    assert.deepEqual(validateDeclaration({ gates: [] }), []);
  });

  const rejects = [
    ['a non-object top level', [], /must be a JSON object/],
    ['an unknown top-level key', { gates: [], lanes: {} }, /unknown top-level key "lanes"/],
    ['a non-string _README', { _README: 42, gates: [] }, /_README.*string/],
    ['a missing gates array', { _README: 'x' }, /"gates" must be an array/],
    ['a non-object gate entry', { gates: ['nope'] }, /gates\[0\].*object/],
    ['an unknown gate key (no lane/model/routing fields ever)', { gates: [{ id: 'a', title: 'A', cmd: 'x', model: 'haiku' }] }, /unknown key "model"/],
    ['a missing cmd', { gates: [{ id: 'a', title: 'A' }] }, /"cmd" must be a non-empty string/],
    ['an empty title', { gates: [{ id: 'a', title: '  ', cmd: 'x' }] }, /"title" must be a non-empty string/],
    ['a non-kebab id', { gates: [{ id: 'Unit_Tests', title: 'A', cmd: 'x' }] }, /kebab-case/],
    ['an embedded newline in cmd (one bash line, never a multi-line script)', { gates: [{ id: 'a', title: 'A', cmd: 'echo x\nrm -rf y' }] }, /embedded newlines/],
    ['a duplicate id', { gates: [{ id: 'a', title: 'A', cmd: 'x' }, { id: 'a', title: 'B', cmd: 'y' }] }, /duplicate id "a"/],
  ];
  for (const [name, parsed, re] of rejects) {
    it(`rejects ${name}`, () => {
      assert.throws(() => validateDeclaration(parsed), (thrown) => {
        assert.match(thrown.message, re);
        assert.equal(thrown.exitCode, EXIT.malformed);
        return true;
      });
    });
  }
});

describe('loadDeclaration — missing is a distinct outcome, malformed is loud', () => {
  it('a truly-absent file → the missing outcome (never a throw)', () => {
    assert.deepEqual(loadDeclaration('/proj', memFs({})), { outcome: 'missing' });
  });

  it('malformed JSON → loud exit-5 error naming the file', () => {
    assert.throws(
      () => loadDeclaration('/proj', memFs({ [GATES_REL]: '{ nope' })),
      (thrown) => thrown.exitCode === EXIT.malformed && thrown.message.includes(GATES_REL),
    );
  });
});

describe('selectGates — --only subset', () => {
  const gates = [
    { id: 'a', title: 'A', cmd: 'x' },
    { id: 'b', title: 'B', cmd: 'y' },
    { id: 'c', title: 'C', cmd: 'z' },
  ];

  it('keeps declaration order and collapses duplicates', () => {
    assert.deepEqual(selectGates(gates, ['c', 'a', 'c']).map((gate) => gate.id), ['a', 'c']);
  });

  it('an unknown id is a loud usage error naming the declared ids', () => {
    assert.throws(() => selectGates(gates, ['nope']), (thrown) => {
      assert.equal(thrown.exitCode, EXIT.usage);
      assert.match(thrown.message, /unknown gate id\(s\): nope/);
      assert.match(thrown.message, /declared: a, b, c/);
      return true;
    });
  });
});

// ── the CLI end-to-end (hermetic; the exit-code table + summary-line schema pinned here) ──

describe('runCli — all-green fixture', () => {
  const gates = [
    { id: 'one', title: 'First', cmd: 'cmd-one' },
    { id: 'two', title: 'Second', cmd: 'cmd-two' },
  ];

  it('exit 0, PASS table rows, ONE summary line as the last line', () => {
    const { code, out, text } = runHermetic({ gates, byCmd: { 'cmd-one': GREEN, 'cmd-two': GREEN } });
    assert.equal(code, EXIT.ok);
    assert.match(text, /one\s+PASS/);
    assert.match(text, /two\s+PASS/);
    assert.equal(out[out.length - 1], '[run-gates] status=ok gates=2 passed=2 failed=0 failed_ids=-');
    assert.equal(out.filter((line) => line.startsWith('[run-gates] status=')).length, 1);
  });

  it('a green gate does not echo its output (table + summary are the report)', () => {
    const { text } = runHermetic({ gates, byCmd: { 'cmd-one': GREEN, 'cmd-two': GREEN } });
    assert.ok(!text.includes('fine'), 'green output must not be echoed');
  });
});

describe('runCli — a failing gate', () => {
  const gates = [
    { id: 'good', title: 'Good', cmd: 'cmd-good' },
    { id: 'bad', title: 'Bad', cmd: 'cmd-bad' },
    { id: 'after', title: 'After the failure', cmd: 'cmd-after' },
  ];
  const byCmd = {
    'cmd-good': GREEN,
    'cmd-bad': { status: 1, stdout: 'assertion exploded at line 42\n', stderr: 'boom-stderr\n' },
    'cmd-after': GREEN,
  };

  it('exit 1; the failing gate\'s own output is preserved VERBATIM; later gates still run', () => {
    const { code, text, calls } = runHermetic({ gates, byCmd });
    assert.equal(code, EXIT.fail);
    assert.ok(text.includes('assertion exploded at line 42'), 'verbatim stdout of the failing gate');
    assert.ok(text.includes('boom-stderr'), 'verbatim stderr of the failing gate');
    assert.ok(calls.some((call) => call.cmd === 'cmd-after'), 'gates after a failure still run');
    assert.match(text, /bad\s+FAIL \(exit 1\)/);
  });

  it('the summary line names the failed ids', () => {
    const { out } = runHermetic({ gates, byCmd });
    assert.equal(out[out.length - 1], '[run-gates] status=fail gates=3 passed=2 failed=1 failed_ids=bad');
  });
});

describe('runCli — --only subset', () => {
  const gates = [
    { id: 'a', title: 'A', cmd: 'cmd-a' },
    { id: 'b', title: 'B', cmd: 'cmd-b' },
  ];

  it('runs only the named gate (repeatable flag)', () => {
    const { code, calls } = runHermetic({ gates, argv: ['--only', 'b'], byCmd: { 'cmd-b': GREEN } });
    assert.equal(code, EXIT.ok);
    const gateCalls = calls.filter((call) => call.cmd !== BASH_PROBE_CMD);
    assert.deepEqual(gateCalls.map((call) => call.cmd), ['cmd-b']);
  });

  it('an unknown --only id → usage exit 2, nothing spawned', () => {
    const { code, calls, errText } = runHermetic({ gates, argv: ['--only', 'nope'], byCmd: {} });
    assert.equal(code, EXIT.usage);
    assert.deepEqual(calls, [], 'no spawn on a usage error');
    assert.match(errText, /unknown gate id/);
  });
});

describe('runCli — the three honest declaration outcomes are DISTINCT (never a silent green)', () => {
  it('missing declaration → exit 3, recovery names the template, summary status=missing', () => {
    const { code, out, errText } = runHermetic({ gates: [], files: memFs({}) });
    assert.equal(code, EXIT.missing);
    assert.match(errText, /no gate declaration found/);
    assert.match(errText, /references\/templates\/gates\.json/, 'the recovery names the template source');
    assert.equal(out[out.length - 1], '[run-gates] status=missing gates=0 passed=0 failed=0 failed_ids=-');
  });

  it('empty gates list → exit 4, distinct message, summary status=empty', () => {
    const { code, out, errText } = runHermetic({ gates: [] });
    assert.equal(code, EXIT.empty);
    assert.match(errText, /empty "gates" list/);
    assert.equal(out[out.length - 1], '[run-gates] status=empty gates=0 passed=0 failed=0 failed_ids=-');
  });

  it('malformed declaration → exit 5, loud reason, summary status=malformed', () => {
    const { code, out, errText } = runHermetic({ gates: [], files: memFs({ [GATES_REL]: '{ broken' }) });
    assert.equal(code, EXIT.malformed);
    assert.match(errText, /malformed JSON/);
    assert.equal(out[out.length - 1], '[run-gates] status=malformed gates=0 passed=0 failed=0 failed_ids=-');
  });

  it('the three outcomes carry three different exit codes', () => {
    assert.equal(new Set([EXIT.missing, EXIT.empty, EXIT.malformed]).size, 3);
  });
});

describe('runCli — bash preflight', () => {
  it('no bash on the host → exit 6, loud (never a silent reinterpretation)', () => {
    const gates = [{ id: 'a', title: 'A', cmd: 'cmd-a' }];
    const enoent = { error: Object.assign(new Error('spawn bash ENOENT'), { code: 'ENOENT' }) };
    const { code, out, errText, calls } = runHermetic({ gates, byCmd: { [BASH_PROBE_CMD]: enoent } });
    assert.equal(code, EXIT.noBash);
    assert.match(errText, /bash is not available/i);
    assert.equal(out[out.length - 1], '[run-gates] status=no-bash gates=0 passed=0 failed=0 failed_ids=-');
    const gateCalls = calls.filter((call) => call.cmd !== BASH_PROBE_CMD);
    assert.deepEqual(gateCalls, [], 'no gate runs after a failed preflight');
  });
});

describe('runCli — usage errors', () => {
  it('an unknown flag → exit 2 with usage, no summary line', () => {
    const out = [];
    const err = [];
    const code = runCli(['--frobnicate'], { log: (line) => out.push(line), logError: (line) => err.push(line) });
    assert.equal(code, EXIT.usage);
    assert.match(err.join('\n'), /unknown argument/);
    assert.ok(!out.some((line) => line.startsWith('[run-gates] status=')), 'usage failures emit no summary line');
  });
});

describe('composeSummaryLine — schema', () => {
  it('is one line, machine-splittable on spaces into key=value fields', () => {
    const line = composeSummaryLine({ status: 'ok', results: [{ id: 'a', ok: true }] });
    assert.ok(!line.includes('\n'));
    const fields = line.replace('[run-gates] ', '').split(' ');
    assert.deepEqual(fields.map((field) => field.split('=')[0]), ['status', 'gates', 'passed', 'failed', 'failed_ids']);
  });
});

// ── the ONE real-spawn fixture: bash brace+glob expansion (why the contract says BASH) ────

describe('real spawn — a gate needing bash brace+glob expansion runs correctly', () => {
  const tempDirs = [];
  afterEach(() => {
    while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
  });

  it('a brace-glob cmd (the shape of this repo\'s test matrix) passes under the real runner', () => {
    const project = mkdtempSync(join(tmpdir(), 'run-gates-real-'));
    tempDirs.push(project);
    mkdirSync(join(project, 'docs', 'ai'), { recursive: true });
    mkdirSync(join(project, 'pkg-a'), { recursive: true });
    mkdirSync(join(project, 'pkg-b'), { recursive: true });
    writeFileSync(join(project, 'pkg-a', 'one.probe.txt'), 'x');
    writeFileSync(join(project, 'pkg-b', 'two.probe.txt'), 'x');
    // Brace + glob in one cmd: /bin/sh would not expand {pkg-a,pkg-b} and ls would fail loudly.
    const declaration = {
      gates: [{ id: 'brace-glob', title: 'Brace+glob expansion', cmd: 'ls {pkg-a,pkg-b}/*.probe.txt' }],
    };
    writeFileSync(join(project, 'docs', 'ai', 'gates.json'), JSON.stringify(declaration, null, 2));

    const out = [];
    const code = runCli(['--cwd', project], { log: (line) => out.push(line), logError: (line) => out.push(line) });
    assert.equal(code, EXIT.ok, `expected green, got:\n${out.join('\n')}`);
    assert.equal(out[out.length - 1], '[run-gates] status=ok gates=1 passed=1 failed=0 failed_ids=-');
  });
});

// ── stale-memory self-heal: the kit-side ensure works from the KIT's own template twin ────
// gates.json is deliberately NOT a REQUIRED_MEMORY_ASSETS entry (gates are optional; absence is
// an honest runner outcome, not a delegation-classification failure). The self-heal at the point
// of use: (a) the runner's missing-declaration report names the exact recovery, and (b) the
// kit-side upgrade ensure seeds from the KIT's own template twin — independent of how old the
// installed memory substrate is. So a stale-memory deployment never silently loses the feature.

describe('stale memory — the feature self-heals from the kit template twin', () => {
  const tempDirs = [];
  afterEach(() => {
    while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
  });

  it('kit twin exists, parses, and is the shipped empty-list shape', () => {
    assert.ok(existsSync(KIT_TEMPLATE), 'kit ships references/templates/gates.json');
    const parsed = JSON.parse(readFileSync(KIT_TEMPLATE, 'utf8'));
    assert.deepEqual(validateDeclaration(parsed), [], 'the template ships an empty, valid gates list');
    assert.equal(typeof parsed._README, 'string');
  });

  it('a deployment seeded by a PRE-gates memory heals: runner names the recovery, kit ensure seeds the twin', () => {
    // A stale-memory deployment: docs/ai exists (old substrate), but no gates.json was seeded.
    const project = mkdtempSync(join(tmpdir(), 'run-gates-stale-'));
    tempDirs.push(project);
    mkdirSync(join(project, 'docs', 'ai'), { recursive: true });

    // (a) the runner is honest about the absence and names the recovery — never a silent green.
    const out = [];
    const err = [];
    const before = runCli(['--cwd', project], { log: (line) => out.push(line), logError: (line) => err.push(line) });
    assert.equal(before, EXIT.missing);
    assert.match(err.join('\n'), /references\/templates\/gates\.json/);

    // (b) the kit-side upgrade ensure (SKILL.md Mode: upgrade — modeled here exactly as the
    // documented prose performs it) seeds from the KIT's own twin, not from the stale memory.
    const dest = join(project, 'docs', 'ai', 'gates.json');
    const ensureGates = () => {
      if (!existsSync(dest)) cpSync(KIT_TEMPLATE, dest);
    };
    ensureGates();
    assert.equal(readFileSync(dest, 'utf8'), readFileSync(KIT_TEMPLATE, 'utf8'), 'seeded byte-identical to the kit twin');

    // (c) the ensure never clobbers an existing (possibly customized) declaration.
    writeFileSync(dest, '{ "gates": [{ "id": "custom", "title": "Mine", "cmd": "true" }] }\n');
    ensureGates();
    assert.match(readFileSync(dest, 'utf8'), /custom/, 'an existing declaration is preserved byte-for-byte');
  });
});

// ── --record: the D5 gate-run receipt (BUGFREE-2 / AD-048) — delegation, honesty, exit 7 ─────────

describe('runCli --record — the gate-run receipt via the ledger sole writer', () => {
  const gates = [
    { id: 'one', title: 'First', cmd: 'cmd-one' },
    { id: 'two', title: 'Second', cmd: 'cmd-two' },
  ];
  const RED = { status: 1, stdout: 'boom\n', stderr: '' };
  const fpSeq = (...values) => {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)];
  };

  it('record written ONLY under --record (a plain run never touches the writer)', () => {
    const recorded = [];
    const { code } = runHermetic({
      gates,
      byCmd: { 'cmd-one': GREEN, 'cmd-two': GREEN },
      deps: { record: (params) => { recorded.push(params); return { writtenPath: '/L' }; }, fingerprint: fpSeq('f1') },
    });
    assert.equal(code, EXIT.ok);
    assert.equal(recorded.length, 0, 'no --record → the writer is never called');
  });

  it('--record mirrors the machine summary: full declaration + what ran + pre/post fingerprints', () => {
    const recorded = [];
    const { code, out } = runHermetic({
      gates,
      argv: ['--record'],
      byCmd: { 'cmd-one': GREEN, 'cmd-two': RED },
      deps: { record: (params) => { recorded.push(params); return { writtenPath: '/L' }; }, fingerprint: fpSeq('fp-before', 'fp-after') },
    });
    assert.equal(code, EXIT.fail, 'the gate verdict still rules the exit when the record succeeded');
    assert.equal(recorded.length, 1, 'a RED run records too (telemetry fuel)');
    const p = recorded[0];
    assert.deepEqual(p.declared, [{ id: 'one', cmd: 'cmd-one' }, { id: 'two', cmd: 'cmd-two' }]);
    assert.deepEqual(p.results, [{ id: 'one', ok: true, code: 0 }, { id: 'two', ok: false, code: 1 }]);
    assert.deepEqual(p.summary, { status: 'fail', gates: 2, passed: 1, failed: 1, failedIds: ['two'] });
    assert.equal(p.fingerprintBefore, 'fp-before');
    assert.equal(p.fingerprintAfter, 'fp-after');
    assert.match(out.join('\n'), /gate-run recorded → \/L/);
    assert.equal(out[out.length - 1], '[run-gates] status=fail gates=2 passed=1 failed=1 failed_ids=two', 'the machine summary stays the LAST line');
  });

  it('a --only subset records HONESTLY as a subset: declared stays full, results shrink', () => {
    const recorded = [];
    const { code } = runHermetic({
      gates,
      argv: ['--record', '--only', 'one'],
      byCmd: { 'cmd-one': GREEN },
      deps: { record: (params) => { recorded.push(params); return { writtenPath: '/L' }; }, fingerprint: fpSeq('f') },
    });
    assert.equal(code, EXIT.ok);
    assert.equal(recorded[0].declared.length, 2, 'the FULL declaration is recorded');
    assert.deepEqual(recorded[0].results.map((r) => r.id), ['one'], 'only what ran is a result');
  });

  it('a record failure is its own LOUD outcome — exit 7, stderr names it, the summary line still lands', () => {
    const { code, out, errText } = runHermetic({
      gates,
      argv: ['--record'],
      byCmd: { 'cmd-one': GREEN, 'cmd-two': GREEN },
      deps: { record: () => { throw new Error('no in-flight plan'); }, fingerprint: fpSeq('f') },
    });
    assert.equal(code, EXIT.recordFailed);
    assert.match(errText, /--record failed: no in-flight plan/);
    assert.equal(out[out.length - 1], '[run-gates] status=ok gates=2 passed=2 failed=0 failed_ids=-');
  });

  it('the sole-writer boundary: run-gates delegates to recordGateRun and never opens the ledger itself (structure pin)', () => {
    const src = readFileSync(join(HERE, 'run-gates.mjs'), 'utf8');
    assert.match(src, /import \{ recordGateRun \} from '\.\/review-ledger-write\.mjs'/, 'the delegation import');
    assert.ok(!/atomic-write/.test(src), 'never the atomic-write core directly');
    assert.ok(!/agent-workflow-review-ledger/.test(src), 'never the ledger basename/path');
    assert.ok(!/appendRecord/.test(src), 'never the append primitive');
  });
});
