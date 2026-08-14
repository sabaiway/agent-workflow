// cross-version-gate.test.mjs — the Issue-016 gate CLI, driven through an INJECTED exec (the
// smoke-candidate.test.mjs pattern): every conditional arm runs against a STUBBED published-kit
// probe, and the schema-accept marker-aware arm is ADDITIONALLY proven against the real validator
// of the PACKED CANDIDATE (hermetic — the networked published-kit install runs only in the
// release lane, never here). The pure halves are pinned in cross-version-axes.test.mjs.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  AXES, GATE_RECEIPT_BASENAME, gateChildEnv, markerFixtureGates,
  evaluateSchemaAccept, buildGateReceipt, gateReceiptPath, crossVersionGateViolation,
  parseArgs, runCli,
} from './cross-version-gate.mjs';
import { KIT_DIR, KIT_PACKAGE_NAME, REPO_ROOT } from './smoke-candidate.mjs';
import { buildForeignFixture } from '../testing/foreign-fixture.mjs';
import { LCOV_PRODUCER_KEY } from '../../agent-workflow-kit/tools/gates-declaration.mjs';
import { COVERAGE_PRODUCER_BODY } from '../../agent-workflow-kit/tools/coverage-producer.mjs';

describe('cross-version-gate — parseArgs', () => {
  it('--keep is a flag; an unknown argument is usage (exit 2)', () => {
    assert.deepEqual(parseArgs(['--keep']), { keep: true, help: false });
    assert.throws(() => parseArgs(['--nope']), (err) => err.exitCode === 2);
  });
});

// ── the CLI against a fully stubbed install + published-kit run ────────────────────────

const GIT_DIR = '/repo/.git';
const HEAD = 'feed5678';
const CANDIDATE_VERSION = '9.9.8';
const advisorPayload = (...variants) => JSON.stringify({ root: '/x', items: variants.map((variant) => ({ key: 'k', variant })), skips: [] });
const REJECTING = { status: 5, stdout: '', stderr: `docs/ai/gates.json: gates[0]: unknown key "${LCOV_PRODUCER_KEY}"` };

const runStubbed = ({
  argv = [], publishedVersion = '5.6.0', schemaRun = REJECTING, execRun = { status: 0, stdout: '', stderr: '' },
  advisorJson = advisorPayload('gates-inert'), lcovExists = true, npmInstallFails = false,
  statusBefore = '', statusAfter, statusRereadFails = false, receiptWriteFails = false, mkdtemp, teardown = () => {},
} = {}) => {
  const writes = {}; const removed = []; const events = []; const fixtureGates = {}; const envs = [];
  const status = [statusBefore, statusAfter === undefined ? statusBefore : statusAfter];
  let statusReads = 0;
  const exec = (cmd, args, options = {}) => {
    const line = [cmd, ...args].join(' ');
    events.push(`exec ${line}`);
    envs.push(options.env ?? null);
    if (cmd === 'git' && args.includes('--absolute-git-dir')) return { status: 0, stdout: `${GIT_DIR}\n` };
    if (cmd === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: `${HEAD}\n` };
    if (cmd === 'git' && args[0] === 'status') {
      if (statusRereadFails && statusReads > 0) return { status: 1, stdout: '', stderr: 'injected: cannot read the index' };
      const value = status[Math.min(statusReads, 1)] ?? status[0]; statusReads += 1;
      return { status: 0, stdout: `${value}\n` };
    }
    if (cmd === 'npm') return npmInstallFails ? { status: 1, stdout: '', stderr: 'ENOTFOUND registry.npmjs.org' } : { status: 0, stdout: '' };
    if (cmd === 'node' && line.includes('run-gates.mjs')) return String(options.cwd).includes('schema') ? schemaRun : execRun;
    if (cmd === 'node' && line.includes('recommendations.mjs')) return { status: 0, stdout: advisorJson };
    return { status: 0, stdout: '' };
  };
  const out = [];
  const code = runCli(argv, {
    log: (line) => out.push(String(line)),
    logError: (line) => out.push(String(line)),
    exec,
    buildFixture: ({ prefix, gates }) => {
      fixtureGates[prefix] = gates;
      return { root: `/fx/${prefix}x`, teardown, census: { assessable: 3, unsupported: 0 } };
    },
    readFile: (path) => (String(path).includes('node_modules') ? JSON.stringify({ version: publishedVersion }) : JSON.stringify({ version: CANDIDATE_VERSION })),
    writeFile: (path, body) => {
      if (receiptWriteFails && String(path).endsWith(GATE_RECEIPT_BASENAME)) throw new Error('injected: EROFS');
      writes[path] = body;
    },
    removeFile: (path) => {
      removed.push(path); events.push(`remove ${path}`); delete writes[path];
    },
    fileExists: () => lcovExists,
    ...(mkdtemp === undefined ? {} : { mkdtemp }),
    baseEnv: { PATH: '/usr/bin', HOME: '/home/real', AW_FLOW_STORE: '/leaked', AGENT_WORKFLOW_KIT_CHANNEL: 'dev' },
    root: '/repo',
    now: () => '2026-08-14T00:00:00.000Z',
  });
  return { code, writes, removed, events, envs, fixtureGates, text: out.join('\n') };
};

describe('cross-version-gate — runCli against a stubbed published kit', () => {
  it('the marker-UNAWARE world passes all three axes, names each, and writes the full receipt', () => {
    const { code, writes, text, fixtureGates } = runStubbed({});
    assert.equal(code, 0, text);
    for (const axis of AXES) assert.match(text, new RegExp(`✓ ${axis}`), `the ${axis} axis is named in the output`);
    assert.match(text, /marker-unaware/);
    const receipt = JSON.parse(writes[gateReceiptPath(GIT_DIR)]);
    assert.deepEqual(receipt, buildGateReceipt({ kitVersion: CANDIDATE_VERSION, headSha: HEAD, dirty: false, publishedVersion: '5.6.0', at: '2026-08-14T00:00:00.000Z' }));
    assert.equal(crossVersionGateViolation({ receipt, kitVersion: CANDIDATE_VERSION, headSha: HEAD }), null, 'and the dispatcher accepts it');
    const prefixes = Object.keys(fixtureGates);
    assert.equal(prefixes.length, 3, 'one fixture per axis');
    const [schemaGates, execGates, pairGates] = prefixes.map((prefix) => fixtureGates[prefix]);
    assert.equal(schemaGates[0][LCOV_PRODUCER_KEY], true, 'axis 1 probes the marker');
    assert.ok(execGates[0].cmd.startsWith(COVERAGE_PRODUCER_BODY), 'axis 2 runs the NEW canonical form');
    assert.ok(pairGates[0].cmd.startsWith(COVERAGE_PRODUCER_BODY), 'axis 3 shows the advisor a NEW-form pair');
    assert.match(pairGates[1].cmd, /node_modules.*coverage-check\.mjs/, 'whose checker is the INSTALLED copy');
  });

  it('the marker-AWARE world flips both conditional arms and still passes', () => {
    const { code, text } = runStubbed({ publishedVersion: '5.10.0', schemaRun: { status: 0, stdout: 'green', stderr: '' }, advisorJson: advisorPayload('bridge-missing') });
    assert.equal(code, 0, text);
    assert.match(text, /marker-aware/);
  });

  it('a silent marker accept by an unaware kit FAILS the schema-accept axis — no receipt', () => {
    const { code, writes, text } = runStubbed({ schemaRun: { status: 0, stdout: '', stderr: '' } });
    assert.equal(code, 1);
    assert.match(text, /schema-accept/);
    assert.equal(writes[gateReceiptPath(GIT_DIR)], undefined, 'a failed gate never mints a licence');
  });

  it('an lcov that never landed FAILS the execution axis — no receipt', () => {
    const { code, writes, text } = runStubbed({ lcovExists: false });
    assert.equal(code, 1);
    assert.match(text, /execution.*AW_GIT_DIR/);
    assert.equal(writes[gateReceiptPath(GIT_DIR)], undefined);
  });

  it('an advisor that no longer misreads under the old arm FAILS producer-recognition — re-decide the threshold', () => {
    const { code, text } = runStubbed({ advisorJson: advisorPayload('bridge-missing') });
    assert.equal(code, 1);
    assert.match(text, /producer-recognition.*direction/);
  });

  it('an unreachable registry is a loud refusal with NO receipt, never a pass', () => {
    const { code, writes, text } = runStubbed({ npmInstallFails: true });
    assert.equal(code, 1);
    assert.match(text, /published kit could not be installed/);
    assert.equal(writes[gateReceiptPath(GIT_DIR)], undefined);
  });

  it('a malformed probed version refuses to DECIDE any arm', () => {
    const { code, text } = runStubbed({ publishedVersion: 'nightly' });
    assert.equal(code, 1);
    assert.match(text, /malformed/);
  });

  it('the previous receipt is invalidated BEFORE the first fallible step', () => {
    const { removed, events } = runStubbed({ npmInstallFails: true });
    assert.deepEqual(removed, [gateReceiptPath(GIT_DIR)]);
    assert.deepEqual(events.slice(0, 3), ['exec git rev-parse --absolute-git-dir', `remove ${gateReceiptPath(GIT_DIR)}`, 'exec git rev-parse HEAD']);
  });

  it('a DIRTY starting tree still runs, and the receipt RECORDS dirty — that receipt clears no dispatch', () => {
    const { code, writes, text } = runStubbed({ statusBefore: '?? wip.txt' });
    assert.equal(code, 0, text);
    const receipt = JSON.parse(writes[gateReceiptPath(GIT_DIR)]);
    assert.equal(receipt.dirty, true);
    assert.match(crossVersionGateViolation({ receipt, kitVersion: CANDIDATE_VERSION, headSha: HEAD }) ?? '', /DIRTY tree/);
  });

  it('a run that CHANGES the repo tree is a red run with no receipt', () => {
    const { code, writes, text } = runStubbed({ statusAfter: '?? stray.tgz' });
    assert.equal(code, 1);
    assert.match(text, /CHANGED the repo working tree/);
    assert.equal(writes[gateReceiptPath(GIT_DIR)], undefined);
  });

  it('a fixture that will not tear down is reported by PATH and never skips the tree assertion', () => {
    const { code, text } = runStubbed({
      teardown: () => {
        throw new Error('injected: EBUSY');
      },
    });
    assert.equal(code, 1);
    assert.match(text, /cleanup failed for 3 dir\(s\)/);
    assert.match(text, /injected: EBUSY/);
  });

  it('a temp dir allocated before a later mkdtemp failure is still registered — for cleanup AND for --keep (review F3)', () => {
    let allocations = 0;
    const { code, text } = runStubbed({
      argv: ['--keep'],
      mkdtemp: () => {
        allocations += 1;
        if (allocations === 2) throw new Error('injected: ENOSPC');
        return `/fake/dir${allocations}`;
      },
    });
    assert.equal(code, 1, text);
    assert.match(text, /injected: ENOSPC/);
    assert.match(text, /--keep: dirs retained \([^)]*\/fake\/dir1/, 'the first dir was registered BEFORE the failing allocation');
  });

  it('every child runs under the sanitized env — host HOME, AW_* and family overrides never reach it', () => {
    const { envs } = runStubbed({});
    const childEnv = envs.find((env) => env !== null && env.PATH !== undefined);
    assert.ok(childEnv);
    assert.equal(childEnv.AW_FLOW_STORE, undefined, 'a leaked AW_* override must not redirect the published kit');
    assert.equal(childEnv.AGENT_WORKFLOW_KIT_CHANNEL, undefined);
    assert.notEqual(childEnv.HOME, '/home/real');
  });

  it('a tree that cannot be PROVEN unchanged is a failure, not a note — and issues no receipt', () => {
    const { code, writes, text } = runStubbed({ statusRereadFails: true });
    assert.equal(code, 1);
    assert.match(text, /could not be proven unchanged/);
    assert.equal(writes[gateReceiptPath(GIT_DIR)], undefined);
  });

  it('a receipt that cannot be WRITTEN is a red run, not a silent pass', () => {
    const { code, text } = runStubbed({ receiptWriteFails: true });
    assert.equal(code, 1);
    assert.match(text, /receipt could not be written \(injected: EROFS\)/);
    assert.doesNotMatch(text, /PASS —/);
  });

  it('--keep names EVERY retained dir, the fixtures included, instead of removing them', () => {
    const { code, text } = runStubbed({ argv: ['--keep'] });
    assert.equal(code, 0, text);
    const retained = /--keep: dirs retained \(([^)]+)\)/.exec(text);
    assert.ok(retained, `the retained dirs are named for triage: ${text}`);
    const named = retained[1].split(', ');
    for (const root of ['/fx/cross-version-schema-x', '/fx/cross-version-execution-x', '/fx/cross-version-pair-x']) {
      assert.ok(named.includes(root), `${root} is named`);
    }
    for (const dir of named.filter((d) => !d.startsWith('/fx/'))) rmSync(dir, { recursive: true, force: true });
  });

  it('--help prints the usage and touches nothing', () => {
    const { code, events, text } = runStubbed({ argv: ['--help'] });
    assert.equal(code, 0);
    assert.match(text, /usage: cross-version-gate\.mjs/);
    assert.deepEqual(events, []);
  });
});

// ── the HERMETIC packed-candidate case: the marker-aware arm's REAL validator ──────────

describe('cross-version-gate — the packed CANDIDATE accepts the marker fixture (hermetic)', () => {
  const dirs = [];
  let installedTools = null;
  let env = null;

  before(() => {
    // Each dir is registered the moment it exists (the F3 rule) — a later mkdtemp failure must
    // never strand an earlier dir outside the after() teardown.
    const home = mkdtempSync(join(tmpdir(), 'cross-version-test-home-'));
    dirs.push(home);
    const npmCache = mkdtempSync(join(tmpdir(), 'cross-version-test-cache-'));
    dirs.push(npmCache);
    const packDir = mkdtempSync(join(tmpdir(), 'cross-version-test-pack-'));
    dirs.push(packDir);
    const installDir = mkdtempSync(join(tmpdir(), 'cross-version-test-install-'));
    dirs.push(installDir);
    env = gateChildEnv(process.env, { home, npmCache });
    const pack = spawnSync('npm', ['pack', '--pack-destination', packDir], { cwd: join(REPO_ROOT, KIT_DIR), env, encoding: 'utf8' });
    assert.equal(pack.status, 0, `npm pack failed: ${pack.stderr}`);
    const tarball = readdirSync(packDir).find((name) => name.endsWith('.tgz'));
    assert.ok(tarball, 'the pack left a tarball behind');
    writeFileSync(join(installDir, 'package.json'), '{"name":"cross-version-probe","private":true}\n');
    const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--offline', join(packDir, tarball)], { cwd: installDir, env, encoding: 'utf8' });
    assert.equal(install.status, 0, `offline install of the packed candidate failed: ${install.stderr}`);
    installedTools = join(installDir, 'node_modules', KIT_PACKAGE_NAME, 'tools');
  });

  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('the real packed validator ACCEPTS the marker declaration, and the marker-aware evaluator agrees', () => {
    const fixture = buildForeignFixture({ prefix: 'cross-version-test-fixture-', gates: markerFixtureGates() });
    try {
      const res = spawnSync('node', [join(installedTools, 'run-gates.mjs')], { cwd: fixture.root, env, encoding: 'utf8' });
      const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
      assert.equal(res.status, 0, `the packed candidate rejected its own marker: ${output}`);
      assert.deepEqual(evaluateSchemaAccept({ markerAware: true, exitCode: res.status, output }), []);
    } finally {
      fixture.teardown();
    }
  });
});
