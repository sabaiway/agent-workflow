import { describe, it, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveBase } from './core-evidence.mjs';
import {
  GATES_REL,
  EXIT,
  validateDeclaration,
  loadDeclaration,
  selectGates,
  composeSummaryLine,
  runCli,
  BASH_PROBE_CMD,
  spawnGateViaBash,
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

// ── the retired --record arm + the sole-writer boundary ──────────────────────────────────────────

describe('the retired --record arm', () => {
  const gates = [{ id: 'one', title: 'First', cmd: 'cmd-one' }];

  it('--record is GONE — a loud usage refusal, nothing spawned (exit 7 is retired with it)', () => {
    const { code, errText, calls } = runHermetic({
      gates,
      argv: ['--record'],
      byCmd: { 'cmd-one': GREEN },
    });
    assert.equal(code, EXIT.usage);
    assert.match(errText, /unknown argument "--record"/);
    assert.equal(calls.length, 0, 'nothing ran');
    assert.equal(EXIT.recordFailed, undefined, 'the retired outcome has no exit-table row');
  });

  it('the sole-writer boundary: run-gates delegates to appendEvidenceRecord and never opens a store itself (structure pin)', () => {
    const src = readFileSync(join(HERE, 'run-gates.mjs'), 'utf8');
    assert.match(src, /appendEvidenceRecord/, 'the final receipt rides the core-evidence sole writer');
    assert.ok(!/atomic-write/.test(src), 'never the atomic-write core directly');
    assert.ok(!/agent-workflow-core-evidence\.jsonl/.test(src), 'never the evidence basename/path');
  });
});

// ── --final: the D3(a) green receipt (strip-the-kit 2.4) — real fixture repos, real spawns ────────

describe('run-gates --final — the ONE receipt the commit guard consumes', () => {
  const TOOLS = HERE;
  const fixtureEnv = (extra = {}) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('AW_')) delete env[k];
    return { ...env, ...extra };
  };
  // The invariant part of the committed base (config + base file) is built once and cloned; only
  // the per-test gates.json still lands in its own commit (a full per-test `git init`+commit
  // dominated the fixture cost).
  const REPO_TEMPLATE = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'run-gates-final-template-'));
    const g = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 'probe@example.com');
    g('config', 'user.name', 'probe');
    mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'solo' } }));
    writeFileSync(join(dir, 'base.txt'), 'base\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    return dir;
  })();
  after(() => rmSync(REPO_TEMPLATE, { recursive: true, force: true }));

  const makeRepo = (gates) => {
    const root = mkdtempSync(join(tmpdir(), 'run-gates-final-'));
    cpSync(REPO_TEMPLATE, root, { recursive: true });
    const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates }));
    g('add', '-A');
    g('commit', '-qm', 'gates');
    writeFileSync(join(root, 'pending.mjs'), 'export const p = 1;\n');
    return root;
  };
  const CANONICAL = [
    { id: 'review-state', title: 'rs', cmd: `node "${join(TOOLS, 'review-state.mjs')}" --check` },
    { id: 'coverage-check', title: 'cc', cmd: `node "${join(TOOLS, 'coverage-check.mjs')}" --check` },
  ];
  const finalRecords = (root) => {
    const raw = readFileSync(join(root, '.git', 'agent-workflow-core-evidence.jsonl'), 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };
  const runFinal = (root, argv = ['--final'], extraEnv = {}) => {
    const out = [];
    const code = runCli([...argv, '--cwd', root], { env: fixtureEnv(extraEnv), log: (l) => out.push(String(l)), logError: (l) => out.push(String(l)) });
    return { code, out: out.join('\n') };
  };
  // A shape-valid red-proof whose bound test EXISTS and passes — verifiable by the checker.
  const greenBoundProof = (root, name) => {
    writeFileSync(
      join(root, name),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('pinned', () => { assert.equal(1, 1); });\n",
    );
    return {
      schema: 1, kind: 'red-proof', testId: `${name}#pinned`, file: name,
      fileHash: createHash('sha256').update(readFileSync(join(root, name))).digest('hex'),
      runs: 1, reds: 1, base: resolveBase(root), fingerprint: 'b'.repeat(64),
      timestamp: '2026-07-17T00:00:00Z',
    };
  };

  it('AW_GIT_DIR is exported to gate children on EVERY run inside a git tree (plain and --only alike)', () => {
    const root = makeRepo([
      { id: 'needs-gitdir', title: 'g', cmd: 'test -n "$AW_GIT_DIR"' },
      { id: 'other', title: 'o', cmd: 'true' },
    ]);
    const plain = runFinal(root, []);
    assert.equal(plain.code, EXIT.ok, `a PLAIN run exports AW_GIT_DIR: ${plain.out}`);
    const subset = runFinal(root, ['--only', 'needs-gitdir']);
    rmSync(root, { recursive: true, force: true });
    assert.equal(subset.code, EXIT.ok, `an --only subset exports AW_GIT_DIR too: ${subset.out}`);
  });

  it('--final --only is a loud usage refusal (a subset never attests)', () => {
    const root = makeRepo([...CANONICAL, { id: 'noop', title: 'n', cmd: 'true' }]);
    const { code, out } = runFinal(root, ['--final', '--only', 'noop']);
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.usage);
    assert.match(out, /--final.*--only|subset never attests/);
  });

  it('a WEAKENED declaration (missing the canonical core checks) is refused before anything runs', () => {
    const root = makeRepo([{ id: 'noop', title: 'n', cmd: 'true' }]);
    const { code, out } = runFinal(root);
    const recorded = existsSync(join(root, '.git', 'agent-workflow-core-evidence.jsonl'));
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.malformed);
    assert.match(out, /review-state/);
    assert.match(out, /coverage-check/);
    assert.equal(recorded, false, 'nothing ran, nothing recorded');
  });

  it('a GREEN final run deletes the stale lcov, exports AW_GIT_DIR, and mints the completed receipt', () => {
    const root = makeRepo([CANONICAL[0], { id: 'needs-gitdir', title: 'g', cmd: 'test -n "$AW_GIT_DIR"' }, CANONICAL[1]]);
    writeFileSync(join(root, '.git', 'agent-workflow-lcov.info'), 'SF:stale\nend_of_record\n');
    const { code, out } = runFinal(root);
    assert.equal(code, EXIT.ok, out);
    assert.equal(existsSync(join(root, '.git', 'agent-workflow-lcov.info')), false, 'the stale lcov is deleted before the suite (no gate recreated it here)');
    const records = finalRecords(root);
    const start = records.find((r) => r.kind === 'final-start');
    const done = records.find((r) => r.kind === 'final');
    assert.ok(start, 'every attempt records its start');
    assert.ok(done, 'the completed attempt is recorded');
    assert.equal(done.status, 'green');
    assert.equal(done.fingerprintBefore, done.fingerprintAfter, 'the tree did not move under the run');
    assert.deepEqual(done.declared.map((d) => d.id), ['review-state', 'needs-gitdir', 'coverage-check']);
    assert.match(done.evidenceHashes.redProof, /^[0-9a-f]{64}$/);
    assert.match(done.evidenceHashes.degrade, /^[0-9a-f]{64}$/);
    assert.ok(typeof start.attempt === 'string' && start.attempt.length > 0, 'the start names its attempt');
    assert.equal(done.attempt, start.attempt, 'the completion closes exactly ITS start (attempt linkage)');
    assert.equal(done.integrityFailure, null, 'a clean run records no integrity failure');
    rmSync(root, { recursive: true, force: true });
  });

  it('a RED final run records status red — never an attesting receipt', () => {
    const root = makeRepo([CANONICAL[0], { id: 'boom', title: 'b', cmd: 'false' }, CANONICAL[1]]);
    const { code } = runFinal(root);
    const done = finalRecords(root).filter((r) => r.kind === 'final').pop();
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.fail);
    assert.equal(done.status, 'red', 'the attempt is recorded honestly as red');
  });

  it('a receipt append failure is its own distinct non-zero outcome (green gates never read as success without the written receipt)', () => {
    const root = makeRepo(CANONICAL);
    writeFileSync(join(root, '.git', 'agent-workflow-core-evidence.jsonl'), 'not json — the store is corrupt so the sole writer refuses\n');
    const { code, out } = runFinal(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.finalFailed);
    assert.match(out, /final.*record|receipt/i);
  });

  it('a store that becomes unwritable AFTER the start record still fails as finalFailed (the completion catch)', () => {
    // The start append succeeds; a mid-run gate replaces the store with a DIRECTORY, so the
    // COMPLETED-record append throws — green gates never read as success without the receipt.
    const wreck = { id: 'wreck-store', title: 'w', cmd: 'rm -f "$AW_GIT_DIR/agent-workflow-core-evidence.jsonl" && mkdir "$AW_GIT_DIR/agent-workflow-core-evidence.jsonl"' };
    const root = makeRepo([{ ...CANONICAL[0] }, wreck, { ...CANONICAL[1] }]);
    const { code, out } = runFinal(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.finalFailed);
    assert.match(out, /could not write its receipt/);
  });

  it('masked core-check commands are refused as weakened (strict full-command match)', () => {
    const cc = join(TOOLS, 'coverage-check.mjs');
    const masked = [
      `node "${cc}" --check --help`,
      `node "${cc}" --check || true`,
      'echo coverage-check.mjs --check',
      'node evil-coverage-check.mjs --check',
    ];
    for (const cmd of masked) {
      const root = makeRepo([CANONICAL[0], { id: 'coverage-check', title: 'cc', cmd }]);
      const { code, out } = runFinal(root);
      rmSync(root, { recursive: true, force: true });
      assert.equal(code, EXIT.malformed, `a masked cmd never attests: ${cmd}\n${out}`);
    }
  });

  it('a RELATIVE path resolving to the canonical tool is ACCEPTED (the anchor never falsely refuses a legitimate form)', () => {
    const root = makeRepo(CANONICAL);
    const gates = { gates: [
      { id: 'review-state', title: 'rs', cmd: `node ${relative(root, join(TOOLS, 'review-state.mjs'))} --check` },
      { id: 'coverage-check', title: 'cc', cmd: `node ${relative(root, join(TOOLS, 'coverage-check.mjs'))} --check` },
    ] };
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify(gates));
    const { code, out } = runFinal(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.ok, out);
  });

  it('an UNRESOLVABLE core-check path is refused pre-spend (a missing file is never canonical)', () => {
    const root = makeRepo([
      CANONICAL[0],
      { id: 'coverage-check', title: 'cc', cmd: 'node no-such-dir/coverage-check.mjs --check' },
    ]);
    const { code, out } = runFinal(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.malformed, out);
    assert.match(out, /canonical/i);
  });

  it('a NON-CANONICAL core-check path is refused pre-spend (a lookalike tool never attests, whatever it prints)', () => {
    const root = makeRepo([
      CANONICAL[0],
      { id: 'coverage-check', title: 'cc', cmd: 'node coverage-check.mjs --check' },
    ]);
    writeFileSync(join(root, 'coverage-check.mjs'), 'console.log("coverage-check: lcov-sha256=none"); process.exit(0);\n');
    const { code, out } = runFinal(root);
    const recorded = existsSync(join(root, '.git', 'agent-workflow-core-evidence.jsonl'));
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.malformed, out);
    assert.match(out, /canonical/i);
    assert.equal(recorded, false, 'refused pre-spend, nothing recorded');
  });

  it('a declaration where coverage-check is NOT the last gate is refused (nothing runs after the checker)', () => {
    const root = makeRepo([CANONICAL[0], CANONICAL[1], { id: 'after', title: 'a', cmd: 'true' }]);
    const { code, out } = runFinal(root);
    const recorded = existsSync(join(root, '.git', 'agent-workflow-core-evidence.jsonl'));
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.malformed);
    assert.match(out, /last/i);
    assert.equal(recorded, false, 'refused pre-spend, nothing recorded');
  });

  it('--final surfaces the checker diagnostics on green: skipped-no-lcov is LOUD, the null lcov is named', () => {
    const root = makeRepo(CANONICAL);
    const { code, out } = runFinal(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.ok, out);
    assert.match(out, /skipped-no-lcov/, 'the green checker stdout is printed under --final');
    assert.match(out, /consumed NO lcov/i);
  });

  it('a green run with a produced lcov binds the receipt to the CHECKER-read bytes', () => {
    const produce = { id: 'produce-lcov', title: 'p', cmd: 'printf "SF:%s/pending.mjs\\nDA:1,1\\nend_of_record\\n" "$PWD" > "$AW_LCOV_FILE"' };
    const root = makeRepo([CANONICAL[0], produce, CANONICAL[1]]);
    const { code, out } = runFinal(root);
    const done = finalRecords(root).filter((r) => r.kind === 'final').pop();
    const lcovBytes = readFileSync(join(root, '.git', 'agent-workflow-lcov.info'));
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.ok, out);
    assert.equal(done.lcovSha256, createHash('sha256').update(lcovBytes).digest('hex'));
    assert.equal(done.integrityFailure, null);
  });

  it('an evidence-store append DURING the final run is integrity drift: a red receipt, exit finalFailed', () => {
    const root = makeRepo([CANONICAL[0], { id: 'sneak', title: 's', cmd: 'PLACEHOLDER' }, CANONICAL[1]]);
    // The sneaked record is VALID and even VERIFIABLE (its bound test exists and passes) — the
    // drift tooth must fire on the WRITE-DURING-RUN itself, not on the record's quality.
    const sneaked = JSON.stringify(greenBoundProof(root, 'drift.test.mjs'));
    const gates = JSON.parse(readFileSync(join(root, 'docs', 'ai', 'gates.json'), 'utf8'));
    gates.gates[1].cmd = `printf '%s\\n' '${sneaked}' >> "$AW_GIT_DIR/agent-workflow-core-evidence.jsonl"`;
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify(gates));
    const { code, out } = runFinal(root, ['--final'], { AW_CORE_EVIDENCE_RERUNS: '1' });
    const done = finalRecords(root).filter((r) => r.kind === 'final').pop();
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.finalFailed, out);
    assert.equal(done.status, 'red', 'green never survives an integrity failure');
    assert.match(done.integrityFailure ?? '', /store/i);
  });

  it('a bound test that rewrites the lcov UNDER the checker is caught by the end re-hash (integrity drift)', () => {
    const produce = { id: 'produce-lcov', title: 'p', cmd: 'printf "SF:%s/pending.mjs\\nDA:1,1\\nend_of_record\\n" "$PWD" > "$AW_LCOV_FILE"' };
    const root = makeRepo([CANONICAL[0], produce, CANONICAL[1]]);
    const lcovAbs = join(root, '.git', 'agent-workflow-lcov.info');
    // The bound test PASSES — and mutates the lcov the checker already read (the checker's own
    // children are the one write window that survives "coverage-check runs last").
    writeFileSync(
      join(root, 'mutate.test.mjs'),
      `import { test } from 'node:test';\nimport { appendFileSync } from 'node:fs';\ntest('pinned', () => { appendFileSync(${JSON.stringify(lcovAbs)}, 'DA:9,9\\n'); });\n`,
    );
    const proof = {
      schema: 1, kind: 'red-proof', testId: 'mutate.test.mjs#pinned', file: 'mutate.test.mjs',
      fileHash: createHash('sha256').update(readFileSync(join(root, 'mutate.test.mjs'))).digest('hex'),
      runs: 1, reds: 1, base: resolveBase(root), fingerprint: 'b'.repeat(64),
      timestamp: '2026-07-17T00:00:00Z',
    };
    writeFileSync(join(root, '.git', 'agent-workflow-core-evidence.jsonl'), `${JSON.stringify(proof)}\n`);
    const { code, out } = runFinal(root, ['--final'], { AW_CORE_EVIDENCE_RERUNS: '1' });
    const done = finalRecords(root).filter((r) => r.kind === 'final').pop();
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.finalFailed, out);
    assert.equal(done.status, 'red');
    assert.match(done.integrityFailure ?? '', /lcov/i);
  });

  it('a checker stdout MISSING the lcov-sha256 line is an integrity failure (fail closed on the unknowable)', () => {
    // The canonical checker always prints the line while green — the arm is fail-closed defense;
    // the runner's spawn is the DI seam that makes it deterministically reachable.
    const root = makeRepo(CANONICAL);
    const stripSpawn = (cmd, cwd2, extra) => {
      const r = spawnGateViaBash(cmd, cwd2, extra);
      if (/coverage-check\.mjs/.test(cmd)) r.stdout = String(r.stdout ?? '').replace(/^coverage-check: lcov-sha256=.*\n?/m, '');
      return r;
    };
    const out = [];
    const code = runCli(['--final', '--cwd', root], { env: fixtureEnv(), spawn: stripSpawn, log: (l) => out.push(String(l)), logError: (l) => out.push(String(l)) });
    const done = finalRecords(root).filter((r) => r.kind === 'final').pop();
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.finalFailed, out.join('\n'));
    assert.equal(done.status, 'red');
    assert.match(done.integrityFailure ?? '', /no lcov-sha256 line/);
  });

  it('a DUPLICATED lcov-sha256 line is integrity drift (exactly ONE full machine line binds the receipt)', () => {
    const root = makeRepo(CANONICAL);
    const dupSpawn = (cmd, cwd2, extra) => {
      const r = spawnGateViaBash(cmd, cwd2, extra);
      if (/coverage-check\.mjs/.test(cmd)) r.stdout = `${String(r.stdout ?? '')}coverage-check: lcov-sha256=none\n`;
      return r;
    };
    const out = [];
    const code = runCli(['--final', '--cwd', root], { env: fixtureEnv(), spawn: dupSpawn, log: (l) => out.push(String(l)), logError: (l) => out.push(String(l)) });
    const done = finalRecords(root).filter((r) => r.kind === 'final').pop();
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.finalFailed, out.join('\n'));
    assert.equal(done.status, 'red');
    assert.match(done.integrityFailure ?? '', /exactly ONE/);
  });

  it('a full [unit-tests → core checks] declaration SPAWNS the suite and binds its produced lcov (no credit lane exists)', () => {
    const unitCmd = 'printf "SF:%s/pending.mjs\\nDA:1,1\\nend_of_record\\n" "$PWD" > "$AW_LCOV_FILE"';
    const root = makeRepo([
      { id: 'unit-tests', title: 'ut', cmd: unitCmd },
      CANONICAL[0],
      CANONICAL[1],
    ]);
    const { code, out } = runFinal(root);
    const done = finalRecords(root).filter((r) => r.kind === 'final').pop();
    const lcovBytes = readFileSync(join(root, '.git', 'agent-workflow-lcov.info'));
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.ok, out);
    assert.doesNotMatch(out, /credited/, 'the final receipt never rides a credit');
    assert.equal(
      done.lcovSha256,
      createHash('sha256').update(lcovBytes).digest('hex'),
      'the SPAWNED unit-tests gate produced the lcov the checker consumed',
    );
  });

  it('a stale lcov that cannot be deleted refuses BEFORE the matrix (only ENOENT is survivable)', () => {
    const root = makeRepo(CANONICAL);
    mkdirSync(join(root, '.git', 'agent-workflow-lcov.info'));
    writeFileSync(join(root, '.git', 'agent-workflow-lcov.info', 'occupant'), 'x');
    const { code, out } = runFinal(root);
    const recorded = existsSync(join(root, '.git', 'agent-workflow-core-evidence.jsonl'));
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.finalFailed);
    assert.match(out, /stale lcov/i);
    assert.equal(recorded, false, 'refused before the attempt started');
  });
});
