import { describe, it, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync, existsSync, readFileSync, linkSync, symlinkSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
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
  isFinalCapableDeclaration,
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
    assert.equal(out[out.length - 1], '[run-gates] status=ok gates=2 passed=2 failed=0 failed_ids=- coverage=none');
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
    assert.equal(out[out.length - 1], '[run-gates] status=fail gates=3 passed=2 failed=1 failed_ids=bad coverage=none');
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
    assert.equal(out[out.length - 1], '[run-gates] status=missing gates=0 passed=0 failed=0 failed_ids=- coverage=unknown');
  });

  it('empty gates list → exit 4, distinct message, summary status=empty', () => {
    const { code, out, errText } = runHermetic({ gates: [] });
    assert.equal(code, EXIT.empty);
    assert.match(errText, /empty "gates" list/);
    assert.equal(out[out.length - 1], '[run-gates] status=empty gates=0 passed=0 failed=0 failed_ids=- coverage=unknown');
  });

  it('malformed declaration → exit 5, loud reason, summary status=malformed', () => {
    const { code, out, errText } = runHermetic({ gates: [], files: memFs({ [GATES_REL]: '{ broken' }) });
    assert.equal(code, EXIT.malformed);
    assert.match(errText, /malformed JSON/);
    assert.equal(out[out.length - 1], '[run-gates] status=malformed gates=0 passed=0 failed=0 failed_ids=- coverage=unknown');
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
    assert.equal(out[out.length - 1], '[run-gates] status=no-bash gates=0 passed=0 failed=0 failed_ids=- coverage=unknown');
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
    assert.deepEqual(fields.map((field) => field.split('=')[0]), ['status', 'gates', 'passed', 'failed', 'failed_ids', 'coverage']);
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
    assert.equal(out[out.length - 1], '[run-gates] status=ok gates=1 passed=1 failed=0 failed_ids=- coverage=none');
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

  // The runner PRODUCES AW_GIT_DIR / AW_LCOV_FILE for gate children. Composing the child env as
  // {...process.env, ...injected} means a value already present in the PARENT survives whenever the
  // runner declines to inject one — so a stale or hostile host value silently becomes the gate's
  // truth instead of the computed one.
  it('a gate child never inherits a HOST-set producer variable — only a computed value reaches it', () => {
    const priorGitDir = process.env.AW_GIT_DIR;
    const priorLcov = process.env.AW_LCOV_FILE;
    process.env.AW_GIT_DIR = '/poisoned/by/the/host';
    process.env.AW_LCOV_FILE = '/poisoned/by/the/host/lcov.info';
    try {
      const show = 'printf "%s|%s" "${AW_GIT_DIR-<unset>}" "${AW_LCOV_FILE-<unset>}"';
      const bare = spawnGateViaBash(show, HERE);
      assert.equal(String(bare.stdout), '<unset>|<unset>', 'the host values are stripped, never inherited');
      const injected = spawnGateViaBash(show, HERE, { AW_GIT_DIR: '/computed' });
      assert.equal(String(injected.stdout), '/computed|<unset>', 'only what the runner computed reaches the gate');
    } finally {
      if (priorGitDir === undefined) delete process.env.AW_GIT_DIR; else process.env.AW_GIT_DIR = priorGitDir;
      if (priorLcov === undefined) delete process.env.AW_LCOV_FILE; else process.env.AW_LCOV_FILE = priorLcov;
    }
  });

  it('a hostile host AW_GIT_DIR never reaches a gate through a real run — the computed git dir wins', () => {
    const root = makeRepo([{ id: 'echo-gitdir', title: 'g', cmd: 'test "$AW_GIT_DIR" != "/poisoned/by/the/host"' }]);
    const prior = process.env.AW_GIT_DIR;
    process.env.AW_GIT_DIR = '/poisoned/by/the/host';
    try {
      const { code, out } = runFinal(root, []);
      assert.equal(code, EXIT.ok, `the gate saw the computed git dir, not the host one: ${out}`);
    } finally {
      if (prior === undefined) delete process.env.AW_GIT_DIR; else process.env.AW_GIT_DIR = prior;
      rmSync(root, { recursive: true, force: true });
    }
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
    // The withheld verdict must reach every carried-forward surface of THIS run, not just the
    // checker's own stdout: a run that read no lcov certifies nothing, however green its gates.
    assert.match(out, /^coverage-check: attested=no$/m, 'a --final run that consumed no lcov never attests');
    assert.match(out, /^coverage-check\s+PASS\s+coverage=not-run \(no lcov bytes were read/m, 'the table row names it');
    assert.match(out, /^\[run-gates\] status=ok gates=2 passed=2 failed=0 failed_ids=- coverage=not-run$/m);
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

  // The receipt RECORDS the run's own coverage token: lcovSha256 says what the receipt binds, never
  // whether a verdict was issued, so the stateless render must not re-derive one from the other.
  it('the --final receipt records the run\'s own coverage token', () => {
    const produce = { id: 'produce-lcov', title: 'p', cmd: 'printf "SF:%s/pending.mjs\\nDA:1,1\\nend_of_record\\n" "$PWD" > "$AW_LCOV_FILE"' };
    const withProducer = makeRepo([CANONICAL[0], produce, CANONICAL[1]]);
    const certified = runFinal(withProducer);
    const certifiedRecord = finalRecords(withProducer).filter((r) => r.kind === 'final').pop();
    rmSync(withProducer, { recursive: true, force: true });
    const deadPair = makeRepo(CANONICAL);
    const withheld = runFinal(deadPair);
    const withheldRecord = finalRecords(deadPair).filter((r) => r.kind === 'final').pop();
    rmSync(deadPair, { recursive: true, force: true });
    assert.equal(certified.code, EXIT.ok, certified.out);
    assert.equal(certifiedRecord.coverage, 'certified');
    assert.match(certifiedRecord.lcovSha256 ?? '', /^[0-9a-f]{64}$/, 'certified binds the digest it read');
    assert.equal(withheld.code, EXIT.ok, withheld.out);
    assert.equal(withheldRecord.coverage, 'not-run', 'a dead pair records the withheld verdict, not a green silence');
    assert.equal(withheldRecord.lcovSha256, null);
  });

  // The lcovProducer marker widens what a DECLARATION may CLAIM; it may never widen what a RUN
  // certifies. Two characterizations hold that line: the runner does not read the key at all, and
  // a claim the run does not honor is still caught by the checker, not by the declaration.
  it('a marker-claimed producer that writes NO lcov still ends skipped-no-lcov / attested=no', () => {
    const claimsButWritesNothing = { id: 'suite', title: 's', cmd: 'true', lcovProducer: true };
    const root = makeRepo([CANONICAL[0], claimsButWritesNothing, CANONICAL[1]]);
    const { code, out } = runFinal(root);
    const record = finalRecords(root).filter((r) => r.kind === 'final').pop();
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.ok, out);
    assert.match(out, /skipped-no-lcov/, 'the claim buys the declaration nothing at run time');
    assert.match(out, /^coverage-check: attested=no$/m);
    assert.equal(record.coverage, 'not-run', 'the receipt records the withheld verdict');
    assert.equal(record.lcovSha256, null);
  });

  it('--final never READS the marker — a marked and an unmarked declaration run identically', () => {
    const produceCmd = 'printf "SF:%s/pending.mjs\\nDA:1,1\\nend_of_record\\n" "$PWD" > "$AW_LCOV_FILE"';
    const runOf = (producer) => {
      const root = makeRepo([CANONICAL[0], producer, CANONICAL[1]]);
      const { code, out } = runFinal(root);
      const record = finalRecords(root).filter((r) => r.kind === 'final').pop();
      rmSync(root, { recursive: true, force: true });
      return {
        code,
        summary: /^\[run-gates\] status=.*$/m.exec(out)?.[0],
        attested: /^coverage-check: attested=(\w+)$/m.exec(out)?.[1],
        coverage: record.coverage,
        boundDigest: typeof record.lcovSha256,
      };
    };
    const bare = runOf({ id: 'produce-lcov', title: 'p', cmd: produceCmd });
    assert.equal(bare.coverage, 'certified', 'the control arm really certifies (the comparison is not vacuous)');
    assert.deepEqual(runOf({ id: 'produce-lcov', title: 'p', cmd: produceCmd, lcovProducer: true }), bare);
  });

  // WHICH gate is the checker is a property of the DECLARATION, so it is resolved before the matrix
  // spawns. Re-resolving it afterwards let a gate that deleted the tool path turn the selected
  // checker into "no checker at all" — a state the receipt validator refuses, so the attempt's
  // evidence would be LOST (exit 8, no completed record) instead of recorded honestly.
  it('a checker path that VANISHES mid-run still records a coverage token, never "no checker"', () => {
    // The canonical predicate is basename-anchored, so the link carries the tool's own name; it
    // resolves through realpath to the kit's tool, which is what makes it canonical.
    const link = 'coverage-check.mjs';
    const root = makeRepo([
      CANONICAL[0],
      { id: 'cut-the-link', title: 'c', cmd: `rm -f ${link}` },
      { id: 'coverage-check', title: 'cc', cmd: `node ${link} --check` },
    ]);
    symlinkSync(join(TOOLS, 'coverage-check.mjs'), join(root, link));
    const { code, out } = runFinal(root);
    const done = finalRecords(root).filter((r) => r.kind === 'final').pop();
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.fail, out);
    assert.ok(done, 'the attempt is RECORDED — a vanished tool path never costs the receipt');
    assert.equal(done.status, 'red');
    assert.equal(done.coverage, 'unknown', 'a checker that left no readable signal is unknown, never none');
  });

  // The machine summary is the LAST line for every NON-usage outcome — a thrown refusal included.
  it('a thrown non-usage refusal still ends with the machine summary line (coverage=unknown)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-gates-nogit-'));
    mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(dir, GATES_REL), JSON.stringify({ gates: CANONICAL }));
    const out = [];
    const err = [];
    const code = runCli(['--final', '--cwd', dir], { env: fixtureEnv(), log: (l) => out.push(String(l)), logError: (l) => err.push(String(l)) });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(code, EXIT.fail);
    assert.match(err.join('\n'), /git work tree/);
    assert.equal(out[out.length - 1], '[run-gates] status=fail gates=0 passed=0 failed=0 failed_ids=- coverage=unknown');
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

  // The checker exits 0 both when it certifies and when it WITHHOLDS a verdict, so a green exit
  // status alone never proves a coverage claim was made. Without these arms a gate that removed the
  // attestation context mid-run would mint a green receipt carrying no coverage claim at all.
  it('a checker that consumed an lcov but did NOT certify it is an integrity failure (green exit is not a claim)', () => {
    const produce = { id: 'produce-lcov', title: 'p', cmd: 'printf "SF:%s/pending.mjs\\nDA:1,1\\nend_of_record\\n" "$PWD" > "$AW_LCOV_FILE"' };
    const root = makeRepo([CANONICAL[0], produce, CANONICAL[1]]);
    const denyAttest = (cmd, cwd2, extra) => {
      const r = spawnGateViaBash(cmd, cwd2, extra);
      if (/coverage-check\.mjs/.test(cmd)) r.stdout = String(r.stdout ?? '').replace(/^coverage-check: attested=yes$/m, 'coverage-check: attested=no');
      return r;
    };
    const out = [];
    const code = runCli(['--final', '--cwd', root], { env: fixtureEnv(), spawn: denyAttest, log: (l) => out.push(String(l)), logError: (l) => out.push(String(l)) });
    const done = finalRecords(root).filter((r) => r.kind === 'final').pop();
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.finalFailed, out.join('\n'));
    assert.equal(done.status, 'red');
    assert.match(done.integrityFailure ?? '', /did NOT certify/);
  });

  it('a checker stdout MISSING the attested= line is an integrity failure (fail closed on the unknowable)', () => {
    const produce = { id: 'produce-lcov', title: 'p', cmd: 'printf "SF:%s/pending.mjs\\nDA:1,1\\nend_of_record\\n" "$PWD" > "$AW_LCOV_FILE"' };
    const root = makeRepo([CANONICAL[0], produce, CANONICAL[1]]);
    const stripAttest = (cmd, cwd2, extra) => {
      const r = spawnGateViaBash(cmd, cwd2, extra);
      if (/coverage-check\.mjs/.test(cmd)) r.stdout = String(r.stdout ?? '').replace(/^coverage-check: attested=.*\n?/m, '');
      return r;
    };
    const out = [];
    const code = runCli(['--final', '--cwd', root], { env: fixtureEnv(), spawn: stripAttest, log: (l) => out.push(String(l)), logError: (l) => out.push(String(l)) });
    const done = finalRecords(root).filter((r) => r.kind === 'final').pop();
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.finalFailed, out.join('\n'));
    assert.match(done.integrityFailure ?? '', /no attested= line/);
  });

  it('TWO canonical coverage-check gates are refused pre-spend, and the shared predicate agrees', () => {
    const twin = { ...CANONICAL[1], id: 'coverage-check-twin' };
    const root = makeRepo([CANONICAL[0], twin, CANONICAL[1]]);
    const { code, out } = runFinal(root, ['--final']);
    const capable = isFinalCapableDeclaration([CANONICAL[0], twin, CANONICAL[1]], root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.malformed, out);
    assert.match(out, /2 gates are the canonical coverage-check/);
    assert.equal(capable, false, 'a consumer must never advertise final-capability for a declaration --final rejects');
  });

  it('an integrity failure never leaves the machine summary line saying status=ok', () => {
    const produce = { id: 'produce-lcov', title: 'p', cmd: 'printf "SF:%s/pending.mjs\\nDA:1,1\\nend_of_record\\n" "$PWD" > "$AW_LCOV_FILE"' };
    const root = makeRepo([CANONICAL[0], produce, CANONICAL[1]]);
    const stripAttest = (cmd, cwd2, extra) => {
      const r = spawnGateViaBash(cmd, cwd2, extra);
      if (/coverage-check\.mjs/.test(cmd)) r.stdout = String(r.stdout ?? '').replace(/^coverage-check: attested=.*\n?/m, '');
      return r;
    };
    const out = [];
    const code = runCli(['--final', '--cwd', root], { env: fixtureEnv(), spawn: stripAttest, log: (l) => out.push(String(l)), logError: (l) => out.push(String(l)) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.finalFailed);
    assert.match(out.join('\n'), /status=fail/, 'the machine line must agree with the exit code');
    assert.doesNotMatch(out.join('\n'), /status=ok/);
  });

  it('the attestation capability reaches the CANONICAL checker ONLY — never another gate, never the host env', () => {
    // The gate itself is the assertion: it FAILS if any attestation variable reaches it, so a leak
    // reddens the run rather than hiding in a green gate's unechoed stdout.
    const leak = { id: 'leak', title: 'l', cmd: 'test -z "$AW_FINAL_ATTEST_NONCE"' };
    const root = makeRepo([CANONICAL[0], leak, CANONICAL[1]]);
    const seen = [];
    const watch = (cmd, cwd2, extra) => {
      seen.push({ cmd, keys: Object.keys(extra ?? {}) });
      return spawnGateViaBash(cmd, cwd2, extra);
    };
    const out = [];
    // The forgery must live in the REAL process env: spawnGateViaBash composes its child env from
    // process.env, so a value injected through runCli's ctx would never reach the strip and the
    // test would pass without exercising it at all.
    const hadNonce = Object.hasOwn(process.env, 'AW_FINAL_ATTEST_NONCE');
    const priorNonce = process.env.AW_FINAL_ATTEST_NONCE;
    process.env.AW_FINAL_ATTEST_NONCE = 'host-forged';
    let code;
    try {
      code = runCli(['--final', '--cwd', root], {
        env: fixtureEnv(), spawn: watch, log: (l) => out.push(String(l)), logError: (l) => out.push(String(l)),
      });
    } finally {
      if (hadNonce) process.env.AW_FINAL_ATTEST_NONCE = priorNonce;
      else delete process.env.AW_FINAL_ATTEST_NONCE;
    }
    rmSync(root, { recursive: true, force: true });
    const carriers = seen.filter((s) => s.keys.includes('AW_FINAL_ATTEST_NONCE'));
    assert.equal(carriers.length, 1, 'exactly one gate is HANDED the capability');
    assert.match(carriers[0].cmd, /coverage-check\.mjs/);
    assert.equal(code, EXIT.ok, `the leak gate saw a nonce it must never see: ${out.join('\n')}`);
  });

  it('a PLAIN run surfaces the withheld verdict — a green table must never read as a coverage claim', () => {
    const produce = { id: 'produce-lcov', title: 'p', cmd: 'printf "SF:%s/pending.mjs\\nDA:1,1\\nend_of_record\\n" "$PWD" > "$AW_GIT_DIR/agent-workflow-lcov.info"' };
    const root = makeRepo([CANONICAL[0], produce, CANONICAL[1]]);
    const { code, out } = runFinal(root, []);
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, EXIT.ok, out);
    assert.match(out, /NO COVERAGE VERDICT/);
    assert.match(out, /run-gates\.mjs --final/);
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

// A declared cmd may reference a variable this runner is responsible for PRODUCING. When the run
// will not set it, the reference expands to empty and the gate fails somewhere far from the cause —
// the class that cost three separate review rounds to re-diagnose. Refuse before anything spawns.
// The hermetic harness runs with cwd '/proj', where the git dir never resolves.
describe('runCli — producer-env precondition (a reference the run will not satisfy refuses up front)', () => {
  it('refuses a gate cmd referencing AW_GIT_DIR when the git dir did not resolve', () => {
    const { code, errText, calls } = runHermetic({
      gates: [{ id: 'unit-tests', title: 'ut', cmd: 'node --test --test-reporter-destination="$AW_GIT_DIR/x.info"' }],
      byCmd: { [BASH_PROBE_CMD]: GREEN },
    });
    assert.equal(code, EXIT.fail);
    assert.match(errText, /AW_GIT_DIR/, 'the refusal names the variable');
    assert.match(errText, /unit-tests/, 'the refusal names the gate');
    assert.match(errText, /git work tree/i, 'the refusal names the remedy');
    assert.equal(calls.length, 0, 'nothing spawned — the refusal is pre-spend');
  });

  it('names the braced reference form too', () => {
    const { code, errText, calls } = runHermetic({
      gates: [{ id: 'unit-tests', title: 'ut', cmd: 'cp report "${AW_GIT_DIR}/out"' }],
      byCmd: { [BASH_PROBE_CMD]: GREEN },
    });
    assert.equal(code, EXIT.fail);
    assert.match(errText, /references \$AW_GIT_DIR/, 'the refusal itself, not an incidental echo of the cmd');
    assert.equal(calls.length, 0, 'nothing spawned — the refusal is pre-spend');
  });

  // The canonical producer destination is written `${AW_GIT_DIR:?…}` so bash refuses BY NAME when
  // the variable is unset instead of writing the lcov to the filesystem root. That form is still a
  // reference this runner is responsible for injecting: an uninjected run must refuse here, or the
  // only signal left is bash's own failure inside a gate child — exactly the far-from-the-cause
  // death this preflight exists to prevent.
  it('refuses the REQUIRED-PARAMETER form — a ${VAR:?…} expansion is a reference, not a fallback', () => {
    const { code, errText, calls } = runHermetic({
      gates: [{
        id: 'unit-tests',
        title: 'ut',
        cmd: 'node --test --test-reporter-destination="${AW_GIT_DIR:?exported by run-gates}/agent-workflow-lcov.info"',
      }],
      byCmd: { [BASH_PROBE_CMD]: GREEN },
    });
    assert.equal(code, EXIT.fail);
    assert.match(errText, /references \$AW_GIT_DIR/, 'the refusal names the variable');
    assert.match(errText, /unit-tests/, 'the refusal names the gate');
    assert.equal(calls.length, 0, 'nothing spawned — the refusal is pre-spend');
    // ONE explanation serves two shell behaviours, so it may claim neither: `$VAR` expands to empty
    // (and a cmd like `echo "$VAR"` still exits 0), while `${VAR:?…}` aborts that expansion by name.
    // What both share is the only thing the runner actually detected. Both retired claims stay
    // pinned — the negative keeps "expand to empty" out, the positive keeps the neutral text in.
    assert.match(errText, /the child would run without the runner-produced value/, 'the explanation states only what was detected');
    assert.doesNotMatch(errText, /expand to empty/, 'never the mode the :? form does not have');
    assert.doesNotMatch(errText, /would fail/, 'nor a failure the runner cannot promise');
  });

  it('does NOT refuse a reference that carries its own shell fallback', () => {
    const cmd = 'ls "${AW_GIT_DIR:-.}"';
    const { code } = runHermetic({
      gates: [{ id: 'unit-tests', title: 'ut', cmd }],
      byCmd: { [cmd]: GREEN, [BASH_PROBE_CMD]: GREEN },
    });
    assert.equal(code, EXIT.ok, 'a cmd with its own default does not depend on the injection');
  });

  it('refuses an AW_LCOV_FILE reference on a plain run — that variable is produced only by --final', () => {
    const { code, errText } = runHermetic({
      gates: [{ id: 'unit-tests', title: 'ut', cmd: 'node --test > "$AW_LCOV_FILE"' }],
      byCmd: { [BASH_PROBE_CMD]: GREEN },
    });
    assert.equal(code, EXIT.fail);
    assert.match(errText, /AW_LCOV_FILE/);
    assert.match(errText, /--final/, 'the refusal names the remedy');
  });

  it('never refuses a cmd that references no producer variable', () => {
    const { code } = runHermetic({
      gates: [{ id: 'unit-tests', title: 'ut', cmd: 'node --test x' }],
      byCmd: { 'node --test x': GREEN, [BASH_PROBE_CMD]: GREEN },
    });
    assert.equal(code, EXIT.ok);
  });

  it('never refuses on a variable whose name merely starts the same way', () => {
    const { code } = runHermetic({
      gates: [{ id: 'unit-tests', title: 'ut', cmd: 'echo "$AW_GIT_DIRECTORY_OVERRIDE"' }],
      byCmd: { 'echo "$AW_GIT_DIRECTORY_OVERRIDE"': GREEN, [BASH_PROBE_CMD]: GREEN },
    });
    assert.equal(code, EXIT.ok, 'the boundary is the whole variable name, never a prefix');
  });

  it('screens only the SELECTED gates — an --only subset is not refused by a sibling it does not run', () => {
    const { code } = runHermetic({
      gates: [
        { id: 'needs-gitdir', title: 'g', cmd: 'ls "$AW_GIT_DIR"' },
        { id: 'plain', title: 'p', cmd: 'node --test x' },
      ],
      argv: ['--only', 'plain'],
      byCmd: { 'node --test x': GREEN, [BASH_PROBE_CMD]: GREEN },
    });
    assert.equal(code, EXIT.ok);
  });
});

// ── Phase 2 (flow Plan 3): the --pre-review derived subset (#66, Decision 7, P14/P27) ──
import { isReviewDependentGate } from './run-gates.mjs';
const RS_TOOL = fileURLToPath(new URL('./review-state.mjs', import.meta.url));
const CG_TOOL = fileURLToPath(new URL('./commit-guard.mjs', import.meta.url));
const CC_TOOL = fileURLToPath(new URL('./coverage-check.mjs', import.meta.url));
const FC_TOOL = fileURLToPath(new URL('./flow-check.mjs', import.meta.url));

describe('run-gates — --pre-review derived subset (#66/P14/P27)', () => {
  const canonicalGates = [
    { id: 'unit', title: 'U', cmd: 'node --test x' },
    { id: 'receipts', title: 'R', cmd: `node "${RS_TOOL}" --check` },
    { id: 'guard-probe', title: 'G', cmd: `node "${CG_TOOL}" --check` },
    { id: 'chain-state', title: 'F', cmd: `node "${FC_TOOL}" --check` },
    { id: 'coverage-check', title: 'C', cmd: `node "${CC_TOOL}" --check` },
  ];

  it('--pre-review is mutually exclusive with --only (exit 2, named)', () => {
    const r = runHermetic({ gates: canonicalGates, argv: ['--pre-review', '--only', 'unit'] });
    assert.equal(r.code, EXIT.usage);
    assert.match(r.errText, /--pre-review refuses --only/);
  });

  it('--pre-review is mutually exclusive with --final (exit 2, named)', () => {
    const r = runHermetic({ gates: canonicalGates, argv: ['--final', '--pre-review'] });
    assert.equal(r.code, EXIT.usage);
    assert.match(r.errText, /--final refuses --pre-review|--pre-review refuses --final/);
  });

  it('the subset derives from canonical checker paths in cmd CONTENT — project-authored ids never decide', () => {
    const r = runHermetic({ gates: canonicalGates, argv: ['--pre-review'], byCmd: { 'node --test x': GREEN } });
    assert.equal(r.code, EXIT.ok, r.errText);
    const ran = r.calls.filter((c) => c.cmd !== BASH_PROBE_CMD).map((c) => c.cmd);
    assert.deepEqual(ran, ['node --test x'], 'every canonical-checker gate is derived OUT, whatever its id');
  });

  it('isReviewDependentGate matches the resolved canonical tool, never an id or a masked form', () => {
    assert.equal(isReviewDependentGate({ id: 'anything', title: 'x', cmd: `node "${RS_TOOL}" --check` }, '/proj'), true);
    assert.equal(isReviewDependentGate({ id: 'anything', title: 'x', cmd: `node "${FC_TOOL}" --check` }, '/proj'), true);
    assert.equal(isReviewDependentGate({ id: 'review-state', title: 'x', cmd: 'echo review-state' }, '/proj'), false);
    assert.equal(isReviewDependentGate({ id: 'x', title: 'x', cmd: `node "${CG_TOOL}" --check --help` }, '/proj'), false);
  });

  const tickNow = () => {
    let tick = 0;
    return () => {
      tick += 100;
      return tick;
    };
  };
  const runReal = (dir, argv, byCmd) => {
    const out = [];
    const err = [];
    const calls = [];
    const code = runCli(argv, {
      cwd: dir,
      log: (l) => out.push(l),
      logError: (l) => err.push(l),
      spawn: scriptedSpawn(byCmd, calls),
      now: tickNow(),
    });
    return { code, calls, text: out.join('\n'), errText: err.join('\n') };
  };
  const tempProject = (flow, gates, { rawConfig = null } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'run-gates-pre-'));
    mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(dir, GATES_REL), declarationOf(gates));
    writeFileSync(join(dir, 'docs', 'ai', 'orchestration.json'), rawConfig ?? JSON.stringify({ flow }));
    return dir;
  };

  it('an unknown flow.pregateExclude id is a loud refusal naming the id', () => {
    const dir = tempProject({ schema: 1, pregateExclude: ['nope'] }, [{ id: 'unit', title: 'U', cmd: 'node --test x' }]);
    const r = runReal(dir, ['--pre-review'], {});
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, EXIT.malformed);
    assert.match(r.errText, /nope/);
    assert.match(r.errText, /pregateExclude/);
  });

  it('a validated pregateExclude id is skipped by the subset', () => {
    const dir = tempProject({ schema: 1, pregateExclude: ['integration'] }, [
      { id: 'unit', title: 'U', cmd: 'node --test x' },
      { id: 'integration', title: 'I', cmd: 'echo slow' },
    ]);
    const r = runReal(dir, ['--pre-review'], { 'node --test x': GREEN });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.deepEqual(r.calls.filter((c) => c.cmd !== BASH_PROBE_CMD).map((c) => c.cmd), ['node --test x']);
  });

  it('an unmatched-but-FAILING gate yields the named review-dependent diagnosis, never a hard-stop count', () => {
    const dir = tempProject({ schema: 1 }, [{ id: 'maybe-review', title: 'M', cmd: 'check-review' }]);
    const r = runReal(dir, ['--pre-review'], { 'check-review': { status: 1, stdout: '', stderr: 'no receipts' } });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, EXIT.fail);
    assert.match(r.text, /review-dependent\? declare it in/);
    assert.match(r.text, /pregateExclude/);
  });

  it('a plain run never loads the orchestration config — --final and plain stay byte-neutral to a broken flow block', () => {
    const dir = tempProject(null, [{ id: 'unit', title: 'U', cmd: 'node --test x' }], { rawConfig: 'not json' });
    const r = runReal(dir, [], { 'node --test x': GREEN });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, EXIT.ok, `a plain run must not consult orchestration.json: ${r.errText}`);
  });

  it('a config-load failure under --pre-review exits 1 with a status=fail summary as the LAST line', () => {
    const dir = tempProject(null, [{ id: 'unit', title: 'U', cmd: 'node --test x' }], { rawConfig: 'not json' });
    const r = runReal(dir, ['--pre-review'], {});
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, EXIT.fail, 'loadConfig pins malformed config as exit 1 — never the declaration-malformed 5');
    const lines = r.text.split('\n').filter((l) => l.length > 0);
    assert.equal(lines[lines.length - 1], composeSummaryLine({ status: 'fail' }), 'the machine summary is the last line for every non-usage outcome');
    assert.match(r.errText, /orchestration\.json/);
  });
});

// ── Plan 4 Decision 7/8: --pre-review under an ARMED flow is a RECORDED attempt with a budget ──
import { resolveFlowStorePath as flowStorePathOf, readFlowStore as readFlowStoreOf, appendSubsetAttempt } from './flow-store.mjs';
import {
  FLOW_SCHEMA_VERSION as FLOW_SCHEMA, canonicalFlowDigest as flowDigestOf,
  subsetFoldBatchDigest, subsetGateIdsDigest, flowProjectionHash as projectionHashOf,
} from './flow-record.mjs';
import { validateEvidenceRecord } from './core-evidence.mjs';

describe('run-gates — --pre-review under an ARMED flow (Plan 4 Decision 7/8)', () => {
  const ATMP = mkdtempSync(join(tmpdir(), 'run-gates-armed-'));
  after(() => rmSync(ATMP, { recursive: true, force: true }));
  const FLOW_TS = '2026-08-05T00:00:00.000Z';
  const AFP = 'a1'.repeat(32);
  let aseq = 0;
  const gitIn = (root, ...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const writeFlowStore = (root, records) => writeFileSync(flowStorePathOf(root, {}), records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  const makeFlowRepo = (gates, { config = { 'plan-execution': { review: 'solo' } } } = {}) => {
    const root = join(ATMP, `repo-${aseq += 1}`);
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    gitIn(root, 'init', '-q', '-b', 'main');
    gitIn(root, 'config', 'user.email', 'probe@example.com');
    gitIn(root, 'config', 'user.name', 'probe');
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify(config));
    writeFileSync(join(root, GATES_REL), declarationOf(gates));
    writeFileSync(join(root, 'base.txt'), 'base\n');
    gitIn(root, 'add', '-A');
    gitIn(root, 'commit', '-qm', 'base');
    return root;
  };
  const adoptionRec = (root, over = {}) => ({
    schema: FLOW_SCHEMA, kind: 'chain', purpose: 'adoption', planId: 'plan-a', cycle: 1, round: 0,
    commitEpoch: 0, owner: 'main', base: resolveBase(root), timestamp: FLOW_TS, stepId: null,
    fingerprint: AFP, planLabel: 'Plan A', createdAt: FLOW_TS, planDigest: 'b2'.repeat(32), ...over,
  });
  const attemptsIn = (root) => readFlowStoreOf(flowStorePathOf(root, {})).records.filter((r) => r.kind === 'subset-attempt');
  const runArmed = (root, argv, byCmd) => {
    const out = [];
    const err = [];
    const calls = [];
    const code = runCli(argv, {
      cwd: root,
      log: (l) => out.push(String(l)),
      logError: (l) => err.push(String(l)),
      spawn: scriptedSpawn(byCmd, calls),
      now: (() => { let t = 0; return () => (t += 100); })(),
    });
    return { code, calls, text: out.join('\n'), errText: err.join('\n') };
  };
  const gateCalls = (calls) => calls.filter((c) => c.cmd !== BASH_PROBE_CMD).map((c) => c.cmd);
  const UNIT = { id: 'unit', title: 'U', cmd: 'node --test x' };
  const RED = { status: 1, stdout: 'boom\n', stderr: '' };

  it('an adoption landing while an UNARMED run executes refuses the result loudly — never a silent unrecorded run (round-11 fold)', () => {
    const root = makeFlowRepo([UNIT]);
    const out = [];
    const err = [];
    const spawnFn = (cmd) => {
      if (cmd === BASH_PROBE_CMD) return { status: 0, stdout: '', stderr: '' };
      writeFlowStore(root, [adoptionRec(root)]);
      return GREEN;
    };
    const code = runCli(['--pre-review', '--cwd', root], {
      log: (l) => out.push(String(l)),
      logError: (l) => err.push(String(l)),
      spawn: spawnFn,
      now: (() => { let t = 0; return () => (t += 100); })(),
    });
    assert.equal(code, EXIT.fail);
    assert.match(err.join('\n'), /ARMED while this run executed/);
    assert.match(out[out.length - 1], /^\[run-gates\] status=fail /, 'the machine summary stays LAST and agrees with the refusal');
    assert.deepEqual(attemptsIn(root), [], 'a pre-arming run records nothing — and says so loudly');
    const next = runArmed(root, ['--pre-review'], { 'node --test x': GREEN });
    assert.equal(next.code, EXIT.ok, next.errText);
    assert.match(next.text, /attempt #1 recorded/, "the first ARMED run starts the budget fresh — the pre-arming run never counted");
  });

  it('an UNARMED repo is byte-unchanged: no flow store appears, no attempt line prints', () => {
    const root = makeFlowRepo([UNIT]);
    const r = runArmed(root, ['--pre-review'], { 'node --test x': GREEN });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.equal(existsSync(flowStorePathOf(root, {})), false, 'the compatibility floor: an unarmed run writes NOTHING');
    assert.doesNotMatch(r.text, /subset attempt/);
  });

  it('an armed green run appends attemptIndex 1 under the ADOPTION context (stepId null, derived digests)', () => {
    const root = makeFlowRepo([UNIT]);
    writeFlowStore(root, [adoptionRec(root)]);
    const r = runArmed(root, ['--pre-review'], { 'node --test x': GREEN });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.match(r.text, /pre-review subset attempt #1 recorded \(green\)/);
    const [rec] = attemptsIn(root);
    assert.equal(rec.attemptIndex, 1);
    assert.equal(rec.stepId, null, 'before any round the attempt keys the adoption context');
    assert.equal(rec.foldBatch, subsetFoldBatchDigest({ planId: 'plan-a', cycle: 1, stepId: null, round: 0 }), 'foldBatch is DERIVED — no CLI input exists for it');
    assert.equal(rec.subsetDigest, subsetGateIdsDigest(['unit']));
    const again = runArmed(root, ['--pre-review'], { 'node --test x': GREEN });
    assert.equal(again.code, EXIT.ok, again.errText);
    assert.match(again.text, /attempt #2 recorded/, 'the counter is read from the STORE — a fresh invocation continues, never restarts');
  });

  it('foldBatch derives from the OPEN round identity once a round exists', () => {
    const root = makeFlowRepo([UNIT]);
    const first = adoptionRec(root);
    const opened = {
      schema: FLOW_SCHEMA, kind: 'chain', purpose: 'round', planId: 'plan-a', cycle: 1, round: 1,
      commitEpoch: 0, owner: 'main', base: resolveBase(root), timestamp: '2026-08-05T00:00:01.000Z',
      stepId: 'step-1', fingerprint: AFP, opensFrom: flowDigestOf(first), dispatches: [], dispositions: [],
    };
    writeFlowStore(root, [first, opened]);
    const r = runArmed(root, ['--pre-review'], { 'node --test x': GREEN });
    assert.equal(r.code, EXIT.ok, r.errText);
    const [rec] = attemptsIn(root);
    assert.equal(rec.stepId, 'step-1');
    assert.equal(rec.foldBatch, subsetFoldBatchDigest({ planId: 'plan-a', cycle: 1, stepId: 'step-1', round: 1 }));
    assert.notEqual(rec.foldBatch, subsetFoldBatchDigest({ planId: 'plan-a', cycle: 1, stepId: null, round: 0 }), 'a new round is a fresh budget');
  });

  it('red→fix→green consumes the retry: both attempts land at ONE counting context', () => {
    const root = makeFlowRepo([UNIT]);
    writeFlowStore(root, [adoptionRec(root)]);
    const redRun = runArmed(root, ['--pre-review'], { 'node --test x': RED });
    assert.equal(redRun.code, EXIT.fail);
    assert.match(redRun.text, /attempt #1 recorded \(red\)/);
    const greenRun = runArmed(root, ['--pre-review'], { 'node --test x': GREEN });
    assert.equal(greenRun.code, EXIT.ok, greenRun.errText);
    assert.match(greenRun.text, /attempt #2 recorded \(green\)/);
    const [a1, a2] = attemptsIn(root);
    assert.deepEqual([a1.status, a2.status], ['red', 'green']);
    assert.equal(a1.foldBatch, a2.foldBatch);
    assert.equal(a1.subsetDigest, a2.subsetDigest);
  });

  it('the run producing the SECOND red completes, records, exits red, and prints the diagnosis rule (Decision 8)', () => {
    const root = makeFlowRepo([UNIT]);
    writeFlowStore(root, [adoptionRec(root)]);
    runArmed(root, ['--pre-review'], { 'node --test x': RED });
    const second = runArmed(root, ['--pre-review'], { 'node --test x': RED });
    assert.equal(second.code, EXIT.fail);
    assert.match(second.text, /attempt #2 recorded \(red\)/, 'the second red COMPLETES and records before exiting');
    assert.match(second.text, /SECOND red/);
    assert.match(second.text, /--diagnosis/, 'the printed rule names the self-servable continuation, never a maintainer wait');
    assert.equal(attemptsIn(root).length, 2);
  });

  it('over two reds: a blind run refuses pre-gates; a --diagnosis run proceeds and records the diagnosed attempt', () => {
    const root = makeFlowRepo([UNIT]);
    writeFlowStore(root, [adoptionRec(root)]);
    runArmed(root, ['--pre-review'], { 'node --test x': RED });
    runArmed(root, ['--pre-review'], { 'node --test x': RED });
    const blind = runArmed(root, ['--pre-review'], { 'node --test x': GREEN });
    assert.equal(blind.code, EXIT.fail);
    assert.deepEqual(gateCalls(blind.calls), [], 'the refusal is PRE-GATES — nothing spawned');
    assert.match(blind.errText, /proceeds ONLY with a recorded diagnosis/);
    const diagnosed = runArmed(root, ['--pre-review', '--diagnosis', 'the fixture races the teardown'], { 'node --test x': GREEN });
    assert.equal(diagnosed.code, EXIT.ok, diagnosed.errText);
    assert.match(diagnosed.text, /attempt #3 recorded \(green\)/);
    assert.equal(attemptsIn(root)[2].diagnosis, 'the fixture races the teardown');
  });

  it('after the THIRD red every further solo run refuses — a diagnosis does not reopen it, the fresh-eyes remedy is named', () => {
    const root = makeFlowRepo([UNIT]);
    writeFlowStore(root, [adoptionRec(root)]);
    runArmed(root, ['--pre-review'], { 'node --test x': RED });
    runArmed(root, ['--pre-review'], { 'node --test x': RED });
    const third = runArmed(root, ['--pre-review', '--diagnosis', 'hypothesis A'], { 'node --test x': RED });
    assert.equal(third.code, EXIT.fail);
    assert.match(third.text, /red attempt 3 EXHAUSTS/);
    assert.match(third.text, /fresh-eyes/);
    const fourth = runArmed(root, ['--pre-review', '--diagnosis', 'hypothesis B'], { 'node --test x': GREEN });
    assert.equal(fourth.code, EXIT.fail);
    assert.deepEqual(gateCalls(fourth.calls), [], 'no gates run over an exhausted context');
    assert.match(fourth.errText, /EXHAUSTED/);
    assert.match(fourth.errText, /fresh-eyes[\s\S]*consult/);
    assert.match(fourth.errText, /park the stuck work/);
    assert.equal(attemptsIn(root).length, 3, 'nothing lands past the exhaustion bound');
  });

  it('a recorded FRESH-EYES consult verdict at the round context reopens exactly ONE further diagnosed run (Decision 8)', () => {
    const root = makeFlowRepo([UNIT]);
    const first = adoptionRec(root);
    const opened = {
      schema: FLOW_SCHEMA, kind: 'chain', purpose: 'round', planId: 'plan-a', cycle: 1, round: 1,
      commitEpoch: 0, owner: 'main', base: resolveBase(root), timestamp: '2026-08-05T00:00:01.000Z',
      stepId: 'step-1', fingerprint: AFP, opensFrom: flowDigestOf(first), dispatches: [], dispositions: [],
    };
    writeFlowStore(root, [first, opened]);
    runArmed(root, ['--pre-review'], { 'node --test x': RED });
    runArmed(root, ['--pre-review'], { 'node --test x': RED });
    runArmed(root, ['--pre-review', '--diagnosis', 'hypothesis A'], { 'node --test x': RED });
    const blocked = runArmed(root, ['--pre-review', '--diagnosis', 'hypothesis B'], { 'node --test x': GREEN });
    assert.equal(blocked.code, EXIT.fail);
    assert.match(blocked.errText, /fresh-eyes/);
    const consult = {
      schema: FLOW_SCHEMA, kind: 'consult-attestation', fingerprint: AFP, backend: 'codex', nonce: 'nx7',
      planId: 'plan-a', cycle: 1, stepId: 'step-1', round: 1,
      findingDigest: 'c3'.repeat(32), proposedFixDigest: 'd4'.repeat(32), base: resolveBase(root), timestamp: '2026-08-05T00:00:02.000Z',
    };
    writeFileSync(flowStorePathOf(root, {}), `${readFileSync(flowStorePathOf(root, {}), 'utf8')}${JSON.stringify(consult)}\n`);
    const reopened = runArmed(root, ['--pre-review', '--diagnosis', 'hypothesis B'], { 'node --test x': GREEN });
    assert.equal(reopened.code, EXIT.ok, reopened.errText);
    assert.match(reopened.text, /attempt #4 recorded \(green\)/);
    const spent = runArmed(root, ['--pre-review', '--diagnosis', 'hypothesis C'], { 'node --test x': GREEN });
    assert.equal(spent.code, EXIT.fail, 'the permit was CONSUMED by the reopened attempt — a further run needs a fresh consult verdict');
    assert.deepEqual(gateCalls(spent.calls), []);
    assert.match(spent.errText, /EXHAUSTED/);
  });

  it('a red on the REOPENED attempt prints the exhausted-again wording, never "THIRD red"', () => {
    const root = makeFlowRepo([UNIT]);
    const first = adoptionRec(root);
    const opened = {
      schema: FLOW_SCHEMA, kind: 'chain', purpose: 'round', planId: 'plan-a', cycle: 1, round: 1,
      commitEpoch: 0, owner: 'main', base: resolveBase(root), timestamp: '2026-08-05T00:00:01.000Z',
      stepId: 'step-1', fingerprint: AFP, opensFrom: flowDigestOf(first), dispatches: [], dispositions: [],
    };
    writeFlowStore(root, [first, opened]);
    runArmed(root, ['--pre-review'], { 'node --test x': RED });
    runArmed(root, ['--pre-review'], { 'node --test x': RED });
    runArmed(root, ['--pre-review', '--diagnosis', 'hypothesis A'], { 'node --test x': RED });
    const consult = {
      schema: FLOW_SCHEMA, kind: 'consult-attestation', fingerprint: AFP, backend: 'codex', nonce: 'nx8',
      planId: 'plan-a', cycle: 1, stepId: 'step-1', round: 1,
      findingDigest: 'c3'.repeat(32), proposedFixDigest: 'd4'.repeat(32), base: resolveBase(root), timestamp: '2026-08-05T00:00:02.000Z',
    };
    writeFileSync(flowStorePathOf(root, {}), `${readFileSync(flowStorePathOf(root, {}), 'utf8')}${JSON.stringify(consult)}\n`);
    const reopenedRed = runArmed(root, ['--pre-review', '--diagnosis', 'hypothesis B'], { 'node --test x': RED });
    assert.equal(reopenedRed.code, EXIT.fail);
    assert.match(reopenedRed.text, /attempt #4 recorded \(red\)/);
    assert.match(reopenedRed.text, /exhausted AGAIN/);
    assert.doesNotMatch(reopenedRed.text, /THIRD red/);
  });

  it('a POST-CONVERGENCE boundary refuses pre-gates — the null context is legal only before the FIRST round (round-6 fold)', () => {
    const root = makeFlowRepo([UNIT]);
    const first = adoptionRec(root);
    const opened = {
      schema: FLOW_SCHEMA, kind: 'chain', purpose: 'round', planId: 'plan-a', cycle: 1, round: 1,
      commitEpoch: 0, owner: 'main', base: resolveBase(root), timestamp: '2026-08-05T00:00:01.000Z',
      stepId: 'step-1', fingerprint: AFP, opensFrom: flowDigestOf(first), dispatches: [], dispositions: [],
    };
    const converged = {
      schema: FLOW_SCHEMA, kind: 'chain', purpose: 'converged', planId: 'plan-a', cycle: 1, round: 1,
      commitEpoch: 0, owner: 'main', base: resolveBase(root), timestamp: '2026-08-05T00:00:02.000Z',
      stepId: 'step-1', fingerprint: AFP,
    };
    writeFlowStore(root, [first, opened, converged]);
    const r = runArmed(root, ['--pre-review'], { 'node --test x': GREEN });
    assert.equal(r.code, EXIT.fail);
    assert.deepEqual(gateCalls(r.calls), [], 'refused pre-gates — a fake adoption-like context is never recorded');
    assert.match(r.errText, /post-convergence boundary/);
    assert.deepEqual(attemptsIn(root), []);
  });

  it('two CONCURRENT armed --pre-review runs never leave a red unrecorded — the run lock serializes the whole cycle (round-6 fold)', async () => {
    const root = makeFlowRepo([{ id: 'unit', title: 'U', cmd: 'sleep 1 && false' }]);
    writeFlowStore(root, [adoptionRec(root)]);
    appendSubsetAttempt({
      cwd: root, expected: { planId: 'plan-a', cycle: 1, stepId: null, round: 0 },
      subsetGateIds: ['unit'], status: 'red', base: resolveBase(root), fingerprint: AFP,
      timestamp: '2026-08-05T00:00:01.000Z',
    });
    const cleanChildEnv = () => {
      const env = { ...process.env };
      for (const k of Object.keys(env)) if (k.startsWith('AW_')) delete env[k];
      return env;
    };
    const RUN_GATES_TOOL = fileURLToPath(new URL('./run-gates.mjs', import.meta.url));
    const spawnChild = () => new Promise((done) => {
      const proc = spawn(process.execPath, [RUN_GATES_TOOL, '--pre-review', '--cwd', root], { env: cleanChildEnv() });
      let out = '';
      proc.stdout.on('data', (d) => { out += d; });
      proc.stderr.on('data', (d) => { out += d; });
      proc.on('close', (code) => done({ code, out }));
    });
    const [a, b] = await Promise.all([spawnChild(), spawnChild()]);
    const outputs = [a, b];
    const recorded = outputs.filter((r) => /attempt #2 recorded \(red\)/.test(r.out));
    assert.equal(recorded.length, 1, `exactly ONE run records red #2: ${a.out}\n---\n${b.out}`);
    const loser = outputs.find((r) => !/attempt #2 recorded \(red\)/.test(r.out));
    assert.ok(!/── unit/.test(loser.out), `the loser never SPENDS the gates — it re-reads the budget under the run lock and refuses pre-gates: ${loser.out}`);
    assert.match(loser.out, /recorded diagnosis|EXHAUSTED|another --pre-review/);
    const reds = attemptsIn(root).filter((r) => r.status === 'red');
    assert.equal(reds.length, 2, 'the store counts EVERY executed red — no unrecorded red run exists');
  });

  it('an UNAPPENDABLE store refuses before any gate spends: supersession violations, hard links, a dead append lock (round-8 fold)', () => {
    const supersessionRoot = makeFlowRepo([UNIT]);
    const badMark = (ts) => ({
      schema: FLOW_SCHEMA, kind: 'down-mark', fingerprint: AFP, backend: 'agy',
      reason: 'quota stall', expiresAt: '2027-01-01T00:00:00.000Z', base: null, timestamp: ts,
    });
    writeFlowStore(supersessionRoot, [adoptionRec(supersessionRoot), badMark('2026-08-05T00:00:01.000Z'), badMark('2026-08-05T00:00:02.000Z')]);
    const sup = runArmed(supersessionRoot, ['--pre-review'], { 'node --test x': GREEN });
    assert.equal(sup.code, EXIT.fail);
    assert.deepEqual(gateCalls(sup.calls), [], 'a store the append would refuse never spends the gates');
    assert.match(sup.errText, /cannot take the attempt append/);
    const linkedRoot = makeFlowRepo([UNIT]);
    writeFlowStore(linkedRoot, [adoptionRec(linkedRoot)]);
    linkSync(flowStorePathOf(linkedRoot, {}), join(linkedRoot, '.git', 'flow-alias.jsonl'));
    const linked = runArmed(linkedRoot, ['--pre-review'], { 'node --test x': GREEN });
    assert.equal(linked.code, EXIT.fail);
    assert.deepEqual(gateCalls(linked.calls), [], 'the hard-link refusal is pre-spend');
    assert.match(linked.errText, /hard links/);
    const deadLockRoot = makeFlowRepo([UNIT]);
    writeFlowStore(deadLockRoot, [adoptionRec(deadLockRoot)]);
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.equal(dead.status, 0);
    writeFileSync(`${flowStorePathOf(deadLockRoot, {})}.lock`, JSON.stringify({ pid: dead.pid, host: hostname(), startedAt: '2026-08-05T00:00:01.000Z' }));
    const blocked = runArmed(deadLockRoot, ['--pre-review'], { 'node --test x': GREEN });
    assert.equal(blocked.code, EXIT.fail);
    assert.deepEqual(gateCalls(blocked.calls), [], 'a dead append lock refuses pre-spend, never post-run');
    assert.match(blocked.errText, /append lock is not acquirable[\s\S]*DEAD process/);
  });

  it('a subset-run-lock release failure surfaces BEFORE the machine summary on early refusal branches (round-7 fold)', () => {
    const root = makeFlowRepo([UNIT]);
    writeFlowStore(root, [adoptionRec(root), adoptionRec(root, { planId: 'plan-b' })]);
    const lines = [];
    const code = runCli(['--pre-review', '--cwd', root], {
      log: (l) => lines.push(String(l)),
      logError: (l) => lines.push(String(l)),
      spawn: scriptedSpawn({ 'node --test x': GREEN }, []),
      flowLockDeps: { rm: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } },
    });
    assert.equal(code, EXIT.fail);
    const summaryAt = lines.findIndex((l) => l.startsWith('[run-gates] status='));
    const issueAt = lines.findIndex((l) => /cannot remove the flow-store lock at release/.test(l));
    assert.ok(issueAt !== -1, `the custody violation stays loud: ${lines.join('\n')}`);
    assert.ok(issueAt < summaryAt, 'the release issue precedes the machine line — the summary stays LAST across BOTH sinks');
    assert.equal(lines[lines.length - 1], composeSummaryLine({ status: 'fail' }), 'the machine summary is the last line of the combined stream');
  });

  it('a SET AW_FLOW_STORE refuses the recording lane up front — a VALID decoy override can never hide the armed store (round-5 fold)', () => {
    const root = makeFlowRepo([UNIT]);
    writeFlowStore(root, [adoptionRec(root)]);
    const decoy = join(ATMP, `decoy-${aseq += 1}.jsonl`);
    writeFileSync(decoy, '');
    const out = [];
    const err = [];
    const calls = [];
    const code = runCli(['--pre-review', '--cwd', root], {
      env: { ...process.env, AW_FLOW_STORE: decoy },
      log: (l) => out.push(String(l)),
      logError: (l) => err.push(String(l)),
      spawn: scriptedSpawn({ 'node --test x': GREEN }, calls),
    });
    assert.equal(code, EXIT.fail);
    assert.deepEqual(calls.filter((c) => c.cmd !== BASH_PROBE_CMD), [], 'refused BEFORE any spawn — the hard-stop budget is never bypassed through a redirected store');
    assert.match(err.join('\n'), /AW_FLOW_STORE is set/);
    assert.equal(out[out.length - 1], composeSummaryLine({ status: 'fail' }));
    assert.deepEqual(attemptsIn(root), [], 'nothing lands in the canonical store, nothing in the decoy lane');
  });

  it('an unresolvable AW_FLOW_STORE under --pre-review keeps the summary contract (exit 1, machine line LAST)', () => {
    const root = makeFlowRepo([UNIT]);
    const out = [];
    const err = [];
    const code = runCli(['--pre-review', '--cwd', root], {
      env: { ...process.env, AW_FLOW_STORE: 'relative/never-absolute.jsonl' },
      log: (l) => out.push(String(l)),
      logError: (l) => err.push(String(l)),
      spawn: scriptedSpawn({ 'node --test x': GREEN }, []),
    });
    assert.equal(code, EXIT.fail);
    assert.equal(out[out.length - 1], composeSummaryLine({ status: 'fail' }), 'the machine summary stays the LAST line — a thrown path resolution never bypasses it');
    assert.match(err.join('\n'), /AW_FLOW_STORE/);
  });

  it('a spawn failure records NO attempt — an infrastructure failure is not a gate red', () => {
    const root = makeFlowRepo([UNIT]);
    writeFlowStore(root, [adoptionRec(root)]);
    const r = runArmed(root, ['--pre-review'], { 'node --test x': { error: { code: 'ENOENT' }, status: null, stdout: '', stderr: '' } });
    assert.equal(r.code, EXIT.fail);
    assert.match(r.errText, /NO subset-attempt was recorded/);
    assert.deepEqual(attemptsIn(root), []);
  });

  it('armed + AMBIGUOUS owning context refuses loudly: zero own open chains, several, and a parked own chain', () => {
    const zeroOwn = makeFlowRepo([UNIT]);
    writeFlowStore(zeroOwn, [adoptionRec(zeroOwn, { owner: 'worktree:elsewhere' })]);
    const zero = runArmed(zeroOwn, ['--pre-review'], { 'node --test x': GREEN });
    assert.equal(zero.code, EXIT.fail);
    assert.match(zero.errText, /owns no open/);
    const twoOwn = makeFlowRepo([UNIT]);
    writeFlowStore(twoOwn, [adoptionRec(twoOwn), adoptionRec(twoOwn, { planId: 'plan-b' })]);
    const two = runArmed(twoOwn, ['--pre-review'], { 'node --test x': GREEN });
    assert.equal(two.code, EXIT.fail);
    assert.match(two.errText, /owns 2 open chains/);
    const parkedOwn = makeFlowRepo([UNIT]);
    writeFlowStore(parkedOwn, [adoptionRec(parkedOwn), {
      schema: FLOW_SCHEMA, kind: 'chain', purpose: 'park', planId: 'plan-a', cycle: 1, round: 0,
      commitEpoch: 0, owner: 'main', base: resolveBase(parkedOwn), timestamp: '2026-08-05T00:00:01.000Z', stepId: null, fingerprint: AFP,
    }]);
    const parked = runArmed(parkedOwn, ['--pre-review'], { 'node --test x': GREEN });
    assert.equal(parked.code, EXIT.fail);
    assert.match(parked.errText, /owns no open/);
    for (const root of [zeroOwn, twoOwn, parkedOwn]) assert.deepEqual(attemptsIn(root), []);
  });

  it('a BROKEN flow store refuses the run fail-closed — the armed state is undecidable', () => {
    const root = makeFlowRepo([UNIT]);
    writeFileSync(flowStorePathOf(root, {}), 'junk line\n');
    const r = runArmed(root, ['--pre-review'], { 'node --test x': GREEN });
    assert.equal(r.code, EXIT.fail);
    assert.match(r.errText, /malformed/);
    assert.deepEqual(gateCalls(r.calls), []);
  });

  it('declaring pregateExclude opens a FRESH counting context (new subsetDigest), and the hint names it', () => {
    const root = makeFlowRepo([UNIT, { id: 'flaky', title: 'F', cmd: 'run-flaky' }]);
    writeFlowStore(root, [adoptionRec(root)]);
    const red = runArmed(root, ['--pre-review'], { 'node --test x': GREEN, 'run-flaky': RED });
    assert.equal(red.code, EXIT.fail);
    assert.match(red.text, /"flaky" failed under --pre-review/);
    assert.match(red.text, /FRESH counting context/);
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'solo' }, flow: { schema: 1, pregateExclude: ['flaky'] } }));
    const green = runArmed(root, ['--pre-review'], { 'node --test x': GREEN });
    assert.equal(green.code, EXIT.ok, green.errText);
    assert.match(green.text, /attempt #1 recorded \(green\)/, 'the excluded subset is a NEW context — the budget restarts at 1');
    const [a1, a2] = attemptsIn(root);
    assert.notEqual(a1.subsetDigest, a2.subsetDigest);
    assert.equal(a1.foldBatch, a2.foldBatch, 'the round identity did not move — only the subset did');
  });

  it('the --diagnosis obligation keys on reds >= 2, never on the attempt index — green histories never demand it', () => {
    const allGreenRoot = makeFlowRepo([UNIT]);
    writeFlowStore(allGreenRoot, [adoptionRec(allGreenRoot)]);
    runArmed(allGreenRoot, ['--pre-review'], { 'node --test x': GREEN });
    runArmed(allGreenRoot, ['--pre-review'], { 'node --test x': GREEN });
    const third = runArmed(allGreenRoot, ['--pre-review'], { 'node --test x': GREEN });
    assert.equal(third.code, EXIT.ok, third.errText);
    assert.match(third.text, /attempt #3 recorded \(green\)/, 'two greens owe nothing — the blind budget counts REDS');
    const mixedRoot = makeFlowRepo([UNIT]);
    writeFlowStore(mixedRoot, [adoptionRec(mixedRoot)]);
    runArmed(mixedRoot, ['--pre-review'], { 'node --test x': RED });
    runArmed(mixedRoot, ['--pre-review'], { 'node --test x': GREEN });
    const afterRetry = runArmed(mixedRoot, ['--pre-review'], { 'node --test x': RED });
    assert.equal(afterRetry.code, EXIT.fail);
    assert.match(afterRetry.text, /attempt #3 recorded \(red\)/, 'red→green→red: one red on the books, the third attempt stays blind-legal');
    const fourth = runArmed(mixedRoot, ['--pre-review'], { 'node --test x': GREEN });
    assert.equal(fourth.code, EXIT.fail);
    assert.deepEqual(gateCalls(fourth.calls), [], 'reds reached 2 — the next run demands --diagnosis pre-gates');
    assert.match(fourth.errText, /recorded diagnosis/);
    const diagnosed = runArmed(mixedRoot, ['--pre-review', '--diagnosis', 'the retry regressed on a second axis'], { 'node --test x': GREEN });
    assert.equal(diagnosed.code, EXIT.ok, diagnosed.errText);
    assert.match(diagnosed.text, /attempt #4 recorded \(green\)/);
  });

  it('a REPLAYED identical --diagnosis refuses PRE-GATES — zero spawns, the run is never left unrecorded (round-4 fold)', () => {
    const root = makeFlowRepo([UNIT]);
    writeFlowStore(root, [adoptionRec(root)]);
    runArmed(root, ['--pre-review'], { 'node --test x': RED });
    runArmed(root, ['--pre-review'], { 'node --test x': RED });
    const first = runArmed(root, ['--pre-review', '--diagnosis', 'hypothesis A'], { 'node --test x': GREEN });
    assert.equal(first.code, EXIT.ok, first.errText);
    const replay = runArmed(root, ['--pre-review', '--diagnosis', 'hypothesis A'], { 'node --test x': GREEN });
    assert.equal(replay.code, EXIT.fail);
    assert.deepEqual(gateCalls(replay.calls), [], 'the replay refuses BEFORE any gate spawns — the gates are never spent on an unrecordable run');
    assert.match(replay.errText, /byte-identical/);
    const distinct = runArmed(root, ['--pre-review', '--diagnosis', 'hypothesis B'], { 'node --test x': GREEN });
    assert.equal(distinct.code, EXIT.ok, distinct.errText);
  });

  it('--diagnosis outside --pre-review is usage; unarmed or blind-budget --diagnosis refuses loudly', () => {
    const usage = runHermetic({ gates: [UNIT], argv: ['--diagnosis', 'x'] });
    assert.equal(usage.code, EXIT.usage);
    assert.match(usage.errText, /--diagnosis rides --pre-review only/);
    const emptyValue = runHermetic({ gates: [UNIT], argv: ['--pre-review', '--diagnosis', ''] });
    assert.equal(emptyValue.code, EXIT.usage);
    const unarmed = makeFlowRepo([UNIT]);
    const r = runArmed(unarmed, ['--pre-review', '--diagnosis', 'x'], { 'node --test x': GREEN });
    assert.equal(r.code, EXIT.fail);
    assert.match(r.errText, /unarmed/);
    const armed = makeFlowRepo([UNIT]);
    writeFlowStore(armed, [adoptionRec(armed)]);
    const blind = runArmed(armed, ['--pre-review', '--diagnosis', 'x'], { 'node --test x': GREEN });
    assert.equal(blind.code, EXIT.fail);
    assert.match(blind.errText, /blind budget/);
    assert.deepEqual(gateCalls(blind.calls), [], 'refused pre-gates');
  });
});

// ── Plan 4 Decision 2 / D10: --final binds the flow store through the owner-scoped projection ──
describe('run-gates — --final binds the flow store (Plan 4 Decision 2 / D10)', () => {
  const FTMP = mkdtempSync(join(tmpdir(), 'run-gates-final-flow-'));
  after(() => rmSync(FTMP, { recursive: true, force: true }));
  const FLOW_TS = '2026-08-05T00:00:00.000Z';
  const AFP = 'a1'.repeat(32);
  let fseq = 0;
  const gitIn = (root, ...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const CANON = [
    { id: 'review-state', title: 'rs', cmd: `node "${join(HERE, 'review-state.mjs')}" --check` },
    { id: 'coverage-check', title: 'cc', cmd: `node "${join(HERE, 'coverage-check.mjs')}" --check` },
  ];
  const makeFinalRepo = (extraGates = []) => {
    const root = join(FTMP, `repo-${fseq += 1}`);
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    gitIn(root, 'init', '-q', '-b', 'main');
    gitIn(root, 'config', 'user.email', 'probe@example.com');
    gitIn(root, 'config', 'user.name', 'probe');
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'solo' } }));
    writeFileSync(join(root, GATES_REL), JSON.stringify({ gates: [CANON[0], ...extraGates, CANON[1]] }));
    writeFileSync(join(root, 'base.txt'), 'base\n');
    gitIn(root, 'add', '-A');
    gitIn(root, 'commit', '-qm', 'base');
    return root;
  };
  const cleanEnv = (extra = {}) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('AW_')) delete env[k];
    return { ...env, ...extra };
  };
  const runFinalFlow = (root) => {
    const out = [];
    const code = runCli(['--final', '--cwd', root], { env: cleanEnv(), log: (l) => out.push(String(l)), logError: (l) => out.push(String(l)) });
    return { code, out: out.join('\n') };
  };
  const lastFinal = (root) => readFileSync(join(root, '.git', 'agent-workflow-core-evidence.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === 'final').pop();
  const adoptionRec = (root, over = {}) => ({
    schema: FLOW_SCHEMA, kind: 'chain', purpose: 'adoption', planId: 'plan-a', cycle: 1, round: 0,
    commitEpoch: 0, owner: 'main', base: resolveBase(root), timestamp: FLOW_TS, stepId: null,
    fingerprint: AFP, planLabel: 'Plan A', createdAt: FLOW_TS, planDigest: 'b2'.repeat(32), ...over,
  });
  const parkRec = (root) => ({
    schema: FLOW_SCHEMA, kind: 'chain', purpose: 'park', planId: 'plan-a', cycle: 1, round: 0,
    commitEpoch: 0, owner: 'main', base: resolveBase(root), timestamp: '2026-08-05T00:00:01.000Z', stepId: null, fingerprint: AFP,
  });
  const writeFlowStore = (root, records) => writeFileSync(flowStorePathOf(root, {}), records.map((r) => `${JSON.stringify(r)}\n`).join(''));

  it('NO flow store → the receipt carries no flow field and still validates (absent = pre-flow-binding)', () => {
    const root = makeFinalRepo();
    const { code, out } = runFinalFlow(root);
    assert.equal(code, EXIT.ok, out);
    const done = lastFinal(root);
    assert.equal('flow' in done.evidenceHashes, false);
    assert.deepEqual(validateEvidenceRecord(done), { ok: true });
  });

  it('a PRESENT store → the minted receipt carries the owner-scoped projection hash and validates', () => {
    const root = makeFinalRepo();
    const records = [adoptionRec(root), parkRec(root)];
    writeFlowStore(root, records);
    const { code, out } = runFinalFlow(root);
    assert.equal(code, EXIT.ok, out);
    const done = lastFinal(root);
    assert.equal(done.evidenceHashes.flow, projectionHashOf(records, { owner: 'main', currentFingerprint: done.fingerprintBefore }));
    assert.deepEqual(validateEvidenceRecord(done), { ok: true });
  });

  it('an OWN-projection append DURING the final run reds the receipt (integrity drift)', () => {
    const root = makeFinalRepo([{ id: 'sneak', title: 's', cmd: 'PLACEHOLDER' }]);
    writeFlowStore(root, [adoptionRec(root), parkRec(root)]);
    const sneaked = JSON.stringify({
      schema: FLOW_SCHEMA, kind: 'rerun-cause', fingerprint: AFP,
      cause: 'appended mid-final', attempt: 'sneak-1', base: null, timestamp: FLOW_TS,
    });
    const gates = JSON.parse(readFileSync(join(root, GATES_REL), 'utf8'));
    gates.gates[1].cmd = `printf '%s\\n' '${sneaked}' >> "$AW_GIT_DIR/agent-workflow-flow.jsonl"`;
    writeFileSync(join(root, GATES_REL), JSON.stringify(gates));
    const { code, out } = runFinalFlow(root);
    const done = lastFinal(root);
    assert.equal(code, EXIT.finalFailed, out);
    assert.equal(done.status, 'red');
    assert.match(done.integrityFailure ?? '', /flow store moved under the final run/);
  });

  it('a FOREIGN worktree append DURING the final run does NOT red the receipt (outside the projection)', () => {
    const root = makeFinalRepo([{ id: 'sneak', title: 's', cmd: 'PLACEHOLDER' }]);
    writeFlowStore(root, [adoptionRec(root), parkRec(root)]);
    const foreign = JSON.stringify({
      schema: FLOW_SCHEMA, kind: 'down-mark', fingerprint: 'ee'.repeat(32), backend: 'agy',
      reason: 'quota stall on another tree', expiresAt: '2027-01-01T00:00:00.000Z', base: null, timestamp: FLOW_TS,
    });
    const gates = JSON.parse(readFileSync(join(root, GATES_REL), 'utf8'));
    gates.gates[1].cmd = `printf '%s\\n' '${foreign}' >> "$AW_GIT_DIR/agent-workflow-flow.jsonl"`;
    writeFileSync(join(root, GATES_REL), JSON.stringify(gates));
    const { code, out } = runFinalFlow(root);
    const done = lastFinal(root);
    assert.equal(code, EXIT.ok, out);
    assert.equal(done.status, 'green', 'cross-tree stays advisory — a foreign append never reds a final');
    assert.equal(done.integrityFailure, null);
  });

  it('a BROKEN flow store refuses the attempt up front — zero evidence writes (fail closed)', () => {
    const root = makeFinalRepo();
    writeFileSync(flowStorePathOf(root, {}), 'junk line\n');
    const { code, out } = runFinalFlow(root);
    assert.equal(code, EXIT.finalFailed, out);
    assert.match(out, /flow→final binding fails closed/);
    assert.equal(existsSync(join(root, '.git', 'agent-workflow-core-evidence.jsonl')), false, 'not even the start record lands');
  });

  it('an unresolvable AW_FLOW_STORE under --final is finalFailed with the machine summary as the LAST line', () => {
    const root = makeFinalRepo();
    const out = [];
    const code = runCli(['--final', '--cwd', root], {
      env: cleanEnv({ AW_FLOW_STORE: 'relative/never-absolute.jsonl' }),
      log: (l) => out.push(String(l)),
      logError: (l) => out.push(String(l)),
    });
    assert.equal(code, EXIT.finalFailed);
    assert.equal(out[out.length - 1], composeSummaryLine({ status: 'fail' }), 'a thrown path resolution never bypasses the summary contract');
    assert.equal(existsSync(join(root, '.git', 'agent-workflow-core-evidence.jsonl')), false, 'zero evidence writes');
  });
});

// ── kit-inert-gate Phase 2 / Decision 8: the coverage= field on the machine summary line ──
// A CLOSED four-value vocabulary with one value defined for EVERY run outcome, derived from the
// canonical checker's own anchored machine lines (the bytes the --final receipt binds). It carries
// DETAIL, never a new state — the exit code and the status= token are untouched — so each outcome
// is pinned by an EXACT LINE: a machine contract prose cannot check.
describe('run-gates — the coverage= summary field (Decision 8)', () => {
  const CHECKER_CMD = `node "${CC_TOOL}" --check`;
  const SHA = 'a'.repeat(64);
  const checkerStdout = (sha, attested) => `coverage-check: lcov-sha256=${sha}\ncoverage-check: attested=${attested}\n`;
  const checkerRan = (stdout, status = 0) => ({ status, stdout, stderr: '' });
  const GATES = [
    { id: 'unit', title: 'U', cmd: 'node --test x' },
    { id: 'coverage-check', title: 'C', cmd: CHECKER_CMD },
  ];
  const lastLine = (r) => r.out[r.out.length - 1];

  it('a checker that ISSUED a verdict reports coverage=certified', () => {
    const r = runHermetic({ gates: GATES, byCmd: { 'node --test x': GREEN, [CHECKER_CMD]: checkerRan(checkerStdout(SHA, 'yes')) } });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.equal(lastLine(r), '[run-gates] status=ok gates=2 passed=2 failed=0 failed_ids=- coverage=certified');
  });

  it('a FAILING verdict is still a verdict — coverage=certified rides a red run', () => {
    const failing = `${checkerStdout(SHA, 'yes')}coverage-check: FAIL — uncovered/unattributed changed Node lines:\n  lib.mjs:2\n`;
    const r = runHermetic({ gates: GATES, byCmd: { 'node --test x': GREEN, [CHECKER_CMD]: checkerRan(failing, 1) } });
    assert.equal(r.code, EXIT.fail);
    assert.equal(lastLine(r), '[run-gates] status=fail gates=2 passed=1 failed=1 failed_ids=coverage-check coverage=certified');
  });

  it('the summary line carries coverage=not-run when the checker issued no verdict', () => {
    const r = runHermetic({ gates: GATES, byCmd: { 'node --test x': GREEN, [CHECKER_CMD]: checkerRan(checkerStdout('none', 'no')) } });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.equal(lastLine(r), '[run-gates] status=ok gates=2 passed=2 failed=0 failed_ids=- coverage=not-run');
  });

  it('the checker table row names the skipped coverage arm', () => {
    const r = runHermetic({ gates: GATES, byCmd: { 'node --test x': GREEN, [CHECKER_CMD]: checkerRan(checkerStdout('none', 'no')) } });
    assert.match(r.text, /^coverage-check\s+PASS\s+coverage=not-run \(no lcov bytes were read; no coverage verdict was issued\)$/m);
    assert.match(r.text, /^unit\s+PASS$/m, 'every other row is byte-unchanged');
  });

  it('a checker that READ an lcov and still issued no verdict names THAT reason on its row', () => {
    const r = runHermetic({ gates: GATES, byCmd: { 'node --test x': GREEN, [CHECKER_CMD]: checkerRan(checkerStdout(SHA, 'no')) } });
    assert.equal(lastLine(r), '[run-gates] status=ok gates=2 passed=2 failed=0 failed_ids=- coverage=not-run');
    assert.match(r.text, /coverage=not-run \(an lcov was read but no verdict was issued\)/);
  });

  it('an --only subset without the checker reports coverage=none', () => {
    const r = runHermetic({ gates: GATES, argv: ['--only', 'unit'], byCmd: { 'node --test x': GREEN } });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.equal(lastLine(r), '[run-gates] status=ok gates=1 passed=1 failed=0 failed_ids=- coverage=none');
  });

  it('the --pre-review derived subset reports coverage=none — every canonical checker is derived out', () => {
    const r = runHermetic({ gates: GATES, argv: ['--pre-review'], byCmd: { 'node --test x': GREEN } });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.equal(lastLine(r), '[run-gates] status=ok gates=1 passed=1 failed=0 failed_ids=- coverage=none');
  });

  it('a pre-spend refusal reports coverage=unknown — the gates never produced a signal', () => {
    const r = runHermetic({
      gates: [
        { id: 'unit', title: 'U', cmd: 'node --test --test-reporter-destination="$AW_GIT_DIR/x.info"' },
        { id: 'coverage-check', title: 'C', cmd: CHECKER_CMD },
      ],
      byCmd: {},
    });
    assert.equal(r.code, EXIT.fail);
    assert.equal(lastLine(r), '[run-gates] status=fail gates=0 passed=0 failed=0 failed_ids=- coverage=unknown');
  });

  it('a checker that could not SPAWN reports coverage=unknown — a dead gate never carries a claim', () => {
    const enoent = { error: Object.assign(new Error('spawn bash ENOENT'), { code: 'ENOENT' }) };
    const r = runHermetic({ gates: GATES, byCmd: { 'node --test x': GREEN, [CHECKER_CMD]: enoent } });
    assert.equal(r.code, EXIT.fail);
    assert.equal(lastLine(r), '[run-gates] status=fail gates=2 passed=1 failed=1 failed_ids=coverage-check coverage=unknown');
  });

  it('no single anchored attested= line reports coverage=unknown (fail closed on the unknowable)', () => {
    const missing = runHermetic({ gates: GATES, byCmd: { 'node --test x': GREEN, [CHECKER_CMD]: checkerRan(`coverage-check: lcov-sha256=${SHA}\n`) } });
    const duplicated = runHermetic({ gates: GATES, byCmd: { 'node --test x': GREEN, [CHECKER_CMD]: checkerRan(`${checkerStdout(SHA, 'yes')}coverage-check: attested=yes\n`) } });
    assert.equal(lastLine(missing), '[run-gates] status=ok gates=2 passed=2 failed=0 failed_ids=- coverage=unknown');
    assert.equal(lastLine(duplicated), '[run-gates] status=ok gates=2 passed=2 failed=0 failed_ids=- coverage=unknown');
  });

  // NEITHER line is trusted alone: the attestation says whether a verdict was issued, the digest
  // says whether anything was read, and a run whose pair cannot be read — or contradicts itself —
  // is unknowable, exactly as the --final receipt arm treats the same two lines.
  it('a missing or duplicated lcov-sha256 line reports coverage=unknown', () => {
    const missing = runHermetic({ gates: GATES, byCmd: { 'node --test x': GREEN, [CHECKER_CMD]: checkerRan('coverage-check: attested=no\n') } });
    const duplicated = runHermetic({ gates: GATES, byCmd: { 'node --test x': GREEN, [CHECKER_CMD]: checkerRan(`${checkerStdout(SHA, 'no')}coverage-check: lcov-sha256=none\n`) } });
    assert.equal(lastLine(missing), '[run-gates] status=ok gates=2 passed=2 failed=0 failed_ids=- coverage=unknown');
    assert.equal(lastLine(duplicated), '[run-gates] status=ok gates=2 passed=2 failed=0 failed_ids=- coverage=unknown');
    assert.match(missing.text, /coverage=unknown \(the checker printed no single anchored attested= \/ lcov-sha256 pair/);
  });

  it('attested=yes over lcov-sha256=none is a CONTRADICTION — coverage=unknown, never certified', () => {
    const r = runHermetic({ gates: GATES, byCmd: { 'node --test x': GREEN, [CHECKER_CMD]: checkerRan(checkerStdout('none', 'yes')) } });
    assert.equal(lastLine(r), '[run-gates] status=ok gates=2 passed=2 failed=0 failed_ids=- coverage=unknown');
    assert.match(r.text, /coverage=unknown \(the checker attested over an lcov it never read/);
  });

  it('the composed default is the honest unknown — a caller that states nothing claims nothing', () => {
    assert.ok(composeSummaryLine({ status: 'ok', results: [] }).endsWith(' coverage=unknown'), composeSummaryLine({ status: 'ok', results: [] }));
  });
});
