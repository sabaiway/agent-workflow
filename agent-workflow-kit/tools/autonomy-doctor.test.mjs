// autonomy-doctor.test.mjs — the AD-044 Plan 2 acceptance matrix. Everything is dependency-
// injected (scripted recording fakes; descriptors pinned AS DATA — the install.mjs
// memberInstallArgv / run-gates scriptedSpawn precedents): NO real apt/sudo/bwrap ever runs here.
// The deployment gate runs tmpdir-driven (the set-autonomy header precedent).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXIT,
  EXIT_FOR_STATUS,
  MUTATING_STDIO,
  PACKAGE_FOR,
  STATUS,
  TRUSTED_DIRS,
  buildSmokeArgv,
  composeSummaryLine,
  deriveDoctorPlan,
  hasControllingTerminal,
  main,
  parseDoctorArgs,
  runDiagnosticSpawn,
  runMutatingSpawn,
} from './autonomy-doctor.mjs';
import {
  KIT_READONLY_TOOLS,
  KIT_WRITER_PREVIEW_TOOLS,
  UNIVERSAL_READONLY_ALLOWLIST,
} from './velocity-profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRUSTED_PATH = TRUSTED_DIRS.join(':');
const EXEC_PATH = '/opt/node/bin/node';
const SUMMARY_RE = /^\[autonomy-doctor\] status=\S+ platform=\S+ missing=\S+ pm=\S+$/;
const GREEN = { status: 0, stdout: '', stderr: '' };

const makeDeployedDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'autonomy-doctor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
  return dir;
};

const makeBareDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'autonomy-doctor-bare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// A recording runner: every descriptor is captured verbatim; `script(descriptor)` supplies the
// result (default green). Descriptors are the AS-DATA fixture surface.
const makeRunner = (script = () => GREEN) => {
  const calls = [];
  const run = (descriptor) => {
    calls.push(descriptor);
    return script(descriptor);
  };
  run.calls = calls;
  return run;
};

// The executable world: a mutable Set of absolute paths that count as executable regular files.
const execWorld = (...paths) => {
  const set = new Set(paths);
  const isExec = (p) => set.has(p);
  isExec.add = (p) => set.add(p);
  return isExec;
};

// Drives main with recording fakes; asserts the machine summary line is LAST in every branch.
const runDoctor = (t, {
  argv = [],
  platform = 'linux',
  env = { PATH: '/usr/bin:/bin' },
  exec = execWorld(),
  euid = () => 1000,
  isTTY,
  diagnostic = makeRunner(),
  mutating = makeRunner(),
  execPath = EXEC_PATH,
  cwd,
} = {}) => {
  const lines = [];
  const code = main(argv, {
    cwd: cwd ?? makeDeployedDir(t),
    platform,
    env,
    isExecutable: exec,
    euid,
    isTTY,
    diagnosticRunner: diagnostic,
    mutatingRunner: mutating,
    execPath,
    log: (line) => lines.push(line),
  });
  const out = lines.join('\n');
  assert.match(lines[lines.length - 1], SUMMARY_RE, `summary line must be LAST, got: ${lines[lines.length - 1]}`);
  return { code, out, lines, diagnostic, mutating };
};

const READY_EXEC = () => execWorld('/usr/bin/bwrap', '/usr/bin/socat');
const SOCAT_MISSING_APT = () => execWorld('/usr/bin/bwrap', '/usr/bin/apt-get', '/usr/bin/env', '/usr/bin/sudo');

// ── D1 — tier absence: the doctor sits OUTSIDE every velocity auto-approve tier ──────────

describe('D1 — autonomy-doctor is OUTSIDE every velocity tier (the consented-writer pattern)', () => {
  it('not in KIT_READONLY_TOOLS / KIT_WRITER_PREVIEW_TOOLS / the core allowlist', () => {
    for (const rel of [...KIT_READONLY_TOOLS, ...KIT_WRITER_PREVIEW_TOOLS]) {
      assert.ok(!rel.includes('autonomy-doctor'), `autonomy-doctor must not be tiered (found ${rel})`);
    }
    for (const entry of UNIVERSAL_READONLY_ALLOWLIST) {
      assert.ok(!String(entry).includes('autonomy-doctor'), `autonomy-doctor must not be core-allowlisted (${entry})`);
    }
  });
});

// ── D4 — lane/runner invariants ───────────────────────────────────────────────────────

describe('D4 — lane invariants (which lane may invoke which runner)', () => {
  it('flagless preview spawns NOTHING (both recording fakes at zero calls), on missing AND ready hosts', (t) => {
    const missing = runDoctor(t, { exec: SOCAT_MISSING_APT() });
    assert.equal(missing.diagnostic.calls.length, 0);
    assert.equal(missing.mutating.calls.length, 0);
    const ready = runDoctor(t, { exec: READY_EXEC() });
    assert.equal(ready.diagnostic.calls.length, 0);
    assert.equal(ready.mutating.calls.length, 0);
  });

  it('--verify invokes only DIAGNOSTIC (smoke + socat -V), never MUTATING', (t) => {
    const r = runDoctor(t, { argv: ['--verify'], exec: READY_EXEC() });
    assert.equal(r.code, EXIT.ready);
    assert.equal(r.diagnostic.calls.length, 2);
    assert.equal(r.mutating.calls.length, 0);
  });

  it('only --apply invokes MUTATING, exactly once; a green install auto-runs the verify lane', (t) => {
    const exec = SOCAT_MISSING_APT();
    const mutating = makeRunner(() => {
      exec.add('/usr/bin/socat');
      return GREEN;
    });
    const r = runDoctor(t, { argv: ['--apply', 'apt-get:socat'], exec, mutating });
    assert.equal(r.mutating.calls.length, 1);
    assert.equal(r.code, EXIT.ready, r.out);
    assert.match(r.out, /ready \(verified\)/);
    assert.equal(r.diagnostic.calls.length, 3, 'sudo -n preflight + smoke + socat -V');
  });

  it('--apply AS ROOT: the install runs, but the post-verify honestly refuses the verified claim (root-unproven, exit 5)', (t) => {
    const exec = SOCAT_MISSING_APT();
    const mutating = makeRunner(() => {
      exec.add('/usr/bin/socat');
      return GREEN;
    });
    const r = runDoctor(t, { argv: ['--apply', 'apt-get:socat'], exec, mutating, euid: () => 0 });
    assert.equal(r.mutating.calls.length, 1);
    assert.equal(r.code, EXIT.verifyFailed);
    assert.match(r.out, /status=root-unproven/);
    assert.match(r.out, /as your normal user/);
  });
});

// ── D3 — per-PM exact command strings (absolute paths, assume-yes forms) ────────────────

describe('D3 — the frozen 4-family install map (descriptors pinned AS DATA)', () => {
  const applyAsRoot = (t, exec, tuple, extra = {}) => {
    const mutating = makeRunner();
    runDoctor(t, { argv: ['--apply', tuple], exec, mutating, euid: () => 0, ...extra });
    assert.equal(mutating.calls.length, 1);
    return mutating.calls[0];
  };

  it('apt-get: the env-trampoline fixture — every executable token trusted-dir ABSOLUTE', (t) => {
    const d = applyAsRoot(t, SOCAT_MISSING_APT(), 'apt-get:socat');
    assert.deepEqual(d.argv, ['/usr/bin/env', 'DEBIAN_FRONTEND=noninteractive', '/usr/bin/apt-get', 'install', '-y', 'socat']);
  });

  it('dnf: absolute-path assume-yes form', (t) => {
    const d = applyAsRoot(t, execWorld('/usr/bin/bwrap', '/usr/bin/dnf'), 'dnf:socat');
    assert.deepEqual(d.argv, ['/usr/bin/dnf', 'install', '-y', 'socat']);
  });

  it('pacman: absolute-path --needed --noconfirm form', (t) => {
    const d = applyAsRoot(t, execWorld('/usr/bin/bwrap', '/usr/bin/pacman'), 'pacman:socat');
    assert.deepEqual(d.argv, ['/usr/bin/pacman', '-S', '--needed', '--noconfirm', 'socat']);
  });

  it('apk: absolute-path add form (resolved through the LATER trusted dir /sbin)', (t) => {
    const d = applyAsRoot(t, execWorld('/usr/bin/bwrap', '/sbin/apk'), 'apk:socat');
    assert.deepEqual(d.argv, ['/sbin/apk', 'add', 'socat']);
  });

  it('both binaries missing → the package map order bwrap→bubblewrap, socat→socat', (t) => {
    const d = applyAsRoot(t, execWorld('/usr/bin/apt-get', '/usr/bin/env'), 'apt-get:bubblewrap,socat');
    assert.deepEqual(d.argv, ['/usr/bin/env', 'DEBIAN_FRONTEND=noninteractive', '/usr/bin/apt-get', 'install', '-y', 'bubblewrap', 'socat']);
  });

  it('first-present ordering: apt-get wins over a co-present dnf', (t) => {
    const d = applyAsRoot(t, execWorld('/usr/bin/bwrap', '/usr/bin/apt-get', '/usr/bin/env', '/usr/bin/dnf'), 'apt-get:socat');
    assert.equal(d.argv[2], '/usr/bin/apt-get');
  });

  it('unknown PM → stated degrade naming the binaries + the manual path, exit 6, runs NOTHING', (t) => {
    const r = runDoctor(t, { argv: ['--apply', 'apt-get:socat'], exec: execWorld('/usr/bin/bwrap') });
    assert.equal(r.code, EXIT.unsupported);
    assert.match(r.out, /no supported package manager/);
    assert.match(r.out, /socat/);
    assert.match(r.out, /manually/);
    assert.match(r.out, /status=unknown-pm/);
    assert.equal(r.mutating.calls.length, 0);
  });

  it('PM found ONLY outside the trusted dirs → loud degrade naming its location, never executed, exit 6', (t) => {
    const r = runDoctor(t, {
      argv: ['--apply', 'apt-get:socat'],
      env: { PATH: '/opt/bin:/usr/bin' },
      exec: execWorld('/usr/bin/bwrap', '/opt/bin/apt-get'),
    });
    assert.equal(r.code, EXIT.unsupported);
    assert.match(r.out, /apt-get at \/opt\/bin\/apt-get/);
    assert.match(r.out, /refusing to execute/);
    assert.match(r.out, /status=untrusted-path/);
    assert.equal(r.mutating.calls.length, 0);
  });

  it('the apt env-trampoline needs a trusted env: env absent from the trusted dirs → loud degrade, runs NOTHING', (t) => {
    const r = runDoctor(t, { argv: ['--apply', 'apt-get:socat'], exec: execWorld('/usr/bin/bwrap', '/usr/bin/apt-get') });
    assert.equal(r.code, EXIT.unsupported);
    assert.match(r.out, /env not found in the trusted dirs/);
    assert.equal(r.mutating.calls.length, 0);
  });
});

// ── D2 — trusted-dir resolution + the PATH-shadow advisory ──────────────────────────────

describe('D2 — trusted-dir execution gate', () => {
  it('--verify with PATH-only binaries → loud degrade naming the location, DIAGNOSTIC never invoked, exit 6', (t) => {
    const r = runDoctor(t, {
      argv: ['--verify'],
      env: { PATH: '/opt/bin' },
      exec: execWorld('/opt/bin/bwrap', '/opt/bin/socat'),
    });
    assert.equal(r.code, EXIT.unsupported);
    assert.match(r.out, /bwrap found ONLY at \/opt\/bin\/bwrap/);
    assert.match(r.out, /status=untrusted-path/);
    assert.equal(r.diagnostic.calls.length, 0);
  });

  it('PATH-missing but trusted-dir-PRESENT → the diagnosis says fix-your-PATH, never a bare MISSING (the offer itself stays, D6-locked)', (t) => {
    const r = runDoctor(t, {
      env: { PATH: '/opt/only' },
      exec: execWorld('/usr/bin/bwrap', '/usr/bin/socat'),
    });
    assert.equal(r.code, EXIT.unsupported, 'no PM in the trusted dirs on this fixture');
    assert.match(r.out, /bwrap: NOT on PATH .*present at \/usr\/bin\/bwrap — fix your PATH/);
    assert.ok(!/bwrap: MISSING/.test(r.out), 'the bare MISSING line must not appear when a trusted copy exists');
  });

  it('PATH-first hit ≠ trusted-dir path → the loud shadow advisory in the diagnosis (no execution)', (t) => {
    const r = runDoctor(t, {
      env: { PATH: '/opt/bin:/usr/bin' },
      exec: execWorld('/opt/bin/bwrap', '/usr/bin/bwrap', '/usr/bin/socat'),
    });
    assert.match(r.out, /PATH-SHADOW WARNING: bwrap first resolves on PATH at \/opt\/bin\/bwrap, not the trusted \/usr\/bin\/bwrap/);
    assert.equal(r.diagnostic.calls.length, 0);
  });

  // review-autonomy-doctor-r01-major-01: a mixed state — one binary untrusted, the other missing — must never
  // reach the privileged install path; the untrusted degrade wins in EVERY lane.
  it('mixed missing and untrusted state refuses every lane with untrusted-path exit 6, runs NOTHING', (t) => {
    const mixed = () => execWorld('/opt/bin/bwrap', '/usr/bin/apt-get', '/usr/bin/env', '/usr/bin/sudo');
    const env = { PATH: '/opt/bin:/usr/bin' };
    const preview = runDoctor(t, { env, exec: mixed() });
    assert.equal(preview.code, EXIT.unsupported, preview.out);
    assert.match(preview.out, /status=untrusted-path/);
    assert.ok(!/--apply apt-get:socat/.test(preview.out), 'no consent invitation may print in the mixed state');
    const verify = runDoctor(t, { argv: ['--verify'], env, exec: mixed() });
    assert.equal(verify.code, EXIT.unsupported);
    assert.equal(verify.diagnostic.calls.length, 0);
    const apply = runDoctor(t, { argv: ['--apply', 'apt-get:socat'], env, exec: mixed() });
    assert.equal(apply.code, EXIT.unsupported);
    assert.match(apply.out, /bwrap found ONLY at \/opt\/bin\/bwrap/);
    assert.equal(apply.mutating.calls.length, 0, 'MUTATING must never run while any sandbox binary is untrusted');
    assert.equal(apply.diagnostic.calls.length, 0);
  });

  it('an in-dir symlink is the ALLOWED D2 case: resolution is presence-based, no realpath escape check', () => {
    // Pinned at the planner level: isExec is the ONLY predicate consulted — a symlinked
    // /usr/bin/socat that isExec accepts (statSync follows it) resolves as trusted.
    const plan = deriveDoctorPlan({
      probeResult: { missing: [] },
      env: { PATH: '/usr/bin' },
      isExec: (p) => p === '/usr/bin/socat' || p === '/usr/bin/bwrap',
    });
    assert.equal(plan.untrusted.length, 0);
    assert.equal(plan.resolutions.find((r) => r.name === 'socat').trusted, '/usr/bin/socat');
  });
});

// ── D6/D7 — the matrix parity (status token + exit code per branch) ─────────────────────

describe('D6/D7 — matrix parity + the frozen EXIT table', () => {
  it('the exported EXIT/status tables are the frozen D7 contract', () => {
    assert.deepEqual(EXIT, { ready: 0, stop: 1, usage: 2, notReady: 3, installFailed: 4, verifyFailed: 5, unsupported: 6 });
    assert.ok(Object.isFrozen(EXIT) && Object.isFrozen(STATUS) && Object.isFrozen(EXIT_FOR_STATUS));
    // The D2/D3 trust tables pinned as LITERALS (never derived from the module under test): a
    // widened allowlist — /usr/local/bin is the D2-excluded escalation vector — must go red here.
    assert.deepEqual(TRUSTED_DIRS, ['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
    assert.deepEqual(PACKAGE_FOR, { bwrap: 'bubblewrap', socat: 'socat' });
    assert.deepEqual(EXIT_FOR_STATUS, {
      'ready-verified': 0,
      'ready-assumed': 0,
      'no-deployment': 1,
      usage: 2,
      'missing-binaries': 3,
      'present-unverified': 3,
      'handoff-required': 3,
      'install-failed': 4,
      'verify-failed': 5,
      indeterminate: 5,
      'root-unproven': 5,
      'unsupported-platform': 6,
      'unknown-pm': 6,
      'untrusted-path': 6,
    });
  });

  it('Linux flagless with binaries present → present-unverified, exit 3 — NEVER exit 0', (t) => {
    const r = runDoctor(t, { exec: READY_EXEC() });
    assert.equal(r.code, EXIT.notReady);
    assert.match(r.out, /status=present-unverified/);
    assert.match(r.out, /never claims ready/i);
  });

  it('Linux missing → the offer, exit 3, status missing-binaries', (t) => {
    const r = runDoctor(t, { exec: SOCAT_MISSING_APT() });
    assert.equal(r.code, EXIT.notReady);
    assert.match(r.out, /status=missing-binaries/);
    assert.match(r.out, /--apply apt-get:socat/);
  });

  it('macOS → ready-assumed with the honest not-smoke-tested note, exit 0', (t) => {
    const r = runDoctor(t, { platform: 'darwin' });
    assert.equal(r.code, EXIT.ready);
    assert.match(r.out, /Seatbelt assumed built-in — not smoke-tested/);
    assert.match(r.out, /status=ready-assumed platform=darwin/);
  });

  it('macOS --apply → nothing to install (Seatbelt built-in), refuse, exit 2, runs NOTHING', (t) => {
    const r = runDoctor(t, { platform: 'darwin', argv: ['--apply', 'apt-get:socat'] });
    assert.equal(r.code, EXIT.usage);
    assert.match(r.out, /nothing to install on macOS/);
    assert.equal(r.mutating.calls.length, 0);
  });

  it('an unmatrixed platform (freebsd) → unsupported degrade, exit 6', (t) => {
    const r = runDoctor(t, { platform: 'freebsd' });
    assert.equal(r.code, EXIT.unsupported);
    assert.match(r.out, /native freebsd sandbox unsupported/);
    assert.match(r.out, /status=unsupported-platform platform=freebsd/);
  });

  it('win32 → WSL2 redirect, exit 6 — platform-gated, a THROWING euid getter is never called', (t) => {
    const r = runDoctor(t, {
      platform: 'win32',
      euid: () => {
        throw new Error('process.geteuid is absent on win32');
      },
    });
    assert.equal(r.code, EXIT.unsupported);
    assert.match(r.out, /WSL2/);
    assert.match(r.out, /status=unsupported-platform platform=win32/);
  });

  it('the summary line schema is pinned', () => {
    assert.equal(
      composeSummaryLine({ status: 'missing-binaries', platform: 'linux', missing: ['socat'], pm: 'apt-get' }),
      '[autonomy-doctor] status=missing-binaries platform=linux missing=socat pm=apt-get',
    );
    assert.equal(
      composeSummaryLine({ status: 'ready-verified', platform: 'linux' }),
      '[autonomy-doctor] status=ready-verified platform=linux missing=- pm=none',
    );
  });
});

// ── D5 — the verify oracle (one predicate, honesty-split) ───────────────────────────────

describe('D5 — the verify oracle', () => {
  const smokeArgvFixture = ['/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', EXEC_PATH, '--version'];

  it('the smoke argv fixture is pinned AS DATA (trusted bwrap + execPath payload, scrubbed env, captured stdio)', (t) => {
    const r = runDoctor(t, { argv: ['--verify'], exec: READY_EXEC() });
    assert.deepEqual(r.diagnostic.calls[0], { argv: smokeArgvFixture, env: { PATH: TRUSTED_PATH }, stdio: 'pipe' });
    assert.deepEqual(r.diagnostic.calls[1], { argv: ['/usr/bin/socat', '-V'], env: { PATH: TRUSTED_PATH }, stdio: 'pipe' });
    assert.deepEqual(buildSmokeArgv('/usr/bin/bwrap', EXEC_PATH), smokeArgvFixture);
  });

  it('ready-verified: probe + smoke + socat -V all green → exit 0, nothing to install, restart note, honesty line', (t) => {
    const r = runDoctor(t, { argv: ['--verify'], exec: READY_EXEC() });
    assert.equal(r.code, EXIT.ready);
    assert.match(r.out, /ready \(verified\)/);
    assert.match(r.out, /nothing to install/);
    assert.match(r.out, /Restart Claude Code/);
    assert.match(r.out, /NOT that Claude initialized its sandbox/);
    assert.match(r.out, /status=ready-verified/);
  });

  it('failing ONLY socat -V → not ready, verbatim stderr, exit 5', (t) => {
    const diagnostic = makeRunner((d) => (d.argv[1] === '-V' ? { status: 3, stdout: '', stderr: 'socat exploded' } : GREEN));
    const r = runDoctor(t, { argv: ['--verify'], exec: READY_EXEC(), diagnostic });
    assert.equal(r.code, EXIT.verifyFailed);
    assert.match(r.out, /socat exploded/);
    assert.match(r.out, /status=verify-failed/);
  });

  it('failing only the smoke → cause-differentiated: names the non-install remediation class, NEVER restates the install command', (t) => {
    const diagnostic = makeRunner((d) => (d.argv[0] === '/usr/bin/bwrap' ? { status: 1, stdout: '', stderr: 'bwrap: bind mount failed' } : GREEN));
    const r = runDoctor(t, { argv: ['--verify'], exec: READY_EXEC(), diagnostic });
    assert.equal(r.code, EXIT.verifyFailed);
    assert.match(r.out, /NOT an install problem/);
    assert.match(r.out, /user namespaces|userns/);
    assert.match(r.out, /WSL2, not WSL1/);
    assert.ok(!r.out.includes('install -y'), 'a smoke failure must never restate the install command');
    assert.match(r.out, /bwrap: bind mount failed/);
  });

  it('namespace-denied signature + green probe → LOUD INDETERMINATE naming nested sandboxing, exit 5', (t) => {
    const diagnostic = makeRunner((d) =>
      d.argv[0] === '/usr/bin/bwrap' ? { status: 1, stdout: '', stderr: 'bwrap: setting up uid map: Permission denied' } : GREEN,
    );
    const r = runDoctor(t, { argv: ['--verify'], exec: READY_EXEC(), diagnostic });
    assert.equal(r.code, EXIT.verifyFailed);
    assert.match(r.out, /INDETERMINATE/);
    assert.match(r.out, /nested sandboxing|inside a container/);
    assert.match(r.out, /unsandboxed shell/);
    assert.match(r.out, /status=indeterminate/);
  });

  it('DIAGNOSTIC res.error (spawn failure) is a DISTINCT branch from a non-zero res.status', (t) => {
    const diagnostic = makeRunner((d) => (d.argv[0] === '/usr/bin/bwrap' ? { error: { code: 'EACCES' }, status: null } : GREEN));
    const r = runDoctor(t, { argv: ['--verify'], exec: READY_EXEC(), diagnostic });
    assert.equal(r.code, EXIT.verifyFailed);
    assert.match(r.out, /could not SPAWN \(EACCES\)/);
  });

  it('socat -V spawn error (res.error) is its own loud branch too', (t) => {
    const diagnostic = makeRunner((d) => (d.argv[1] === '-V' ? { error: { code: 'ENOMEM' }, status: null } : GREEN));
    const r = runDoctor(t, { argv: ['--verify'], exec: READY_EXEC(), diagnostic });
    assert.equal(r.code, EXIT.verifyFailed);
    assert.match(r.out, /socat -V could not SPAWN \(ENOMEM\)/);
  });

  it('root refusal: euid==0 → the verified claim is REFUSED loudly, exit 5, no runner invoked', (t) => {
    const r = runDoctor(t, { argv: ['--verify'], exec: READY_EXEC(), euid: () => 0 });
    assert.equal(r.code, EXIT.verifyFailed);
    assert.match(r.out, /refusing the "verified" claim/);
    assert.match(r.out, /status=root-unproven/);
    assert.equal(r.diagnostic.calls.length, 0);
    assert.equal(r.mutating.calls.length, 0);
  });

  it('root refusal: SUDO_UID set (non-zero euid) → the same refusal', (t) => {
    const r = runDoctor(t, { argv: ['--verify'], exec: READY_EXEC(), env: { PATH: '/usr/bin:/bin', SUDO_UID: '1000' } });
    assert.equal(r.code, EXIT.verifyFailed);
    assert.match(r.out, /status=root-unproven/);
  });

  it('--verify with binaries missing → the offer diagnosis, DIAGNOSTIC not invoked, exit 3', (t) => {
    const r = runDoctor(t, { argv: ['--verify'], exec: SOCAT_MISSING_APT() });
    assert.equal(r.code, EXIT.notReady);
    assert.match(r.out, /status=missing-binaries/);
    assert.equal(r.diagnostic.calls.length, 0);
  });
});

// ── D4 — the sudo boundary + the scrubbed-env/stdio descriptor ──────────────────────────

describe('D4 — sudo boundary + the MUTATING descriptor', () => {
  it('the through-sudo descriptor is pinned AS DATA: scrubbed env (trusted PATH only), argv array, stdio [ignore,inherit,inherit]', (t) => {
    const diagnostic = makeRunner(); // sudo -n true → green
    const mutating = makeRunner();
    runDoctor(t, { argv: ['--apply', 'apt-get:socat'], exec: SOCAT_MISSING_APT(), diagnostic, mutating });
    assert.deepEqual(mutating.calls[0], {
      argv: ['/usr/bin/sudo', '/usr/bin/env', 'DEBIAN_FRONTEND=noninteractive', '/usr/bin/apt-get', 'install', '-y', 'socat'],
      env: { PATH: TRUSTED_PATH },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    assert.deepEqual(MUTATING_STDIO, ['ignore', 'inherit', 'inherit']);
  });

  it('LANG passes through the scrubbed env; nothing else does', (t) => {
    const mutating = makeRunner();
    runDoctor(t, {
      argv: ['--apply', 'apt-get:socat'],
      exec: SOCAT_MISSING_APT(),
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', NPM_TOKEN: 'secret' },
      mutating,
    });
    assert.deepEqual(mutating.calls[0].env, { PATH: TRUSTED_PATH, LANG: 'C.UTF-8' });
  });

  it('euid==0 drops sudo (no preflight, the root-form argv)', (t) => {
    const diagnostic = makeRunner();
    const mutating = makeRunner();
    runDoctor(t, { argv: ['--apply', 'apt-get:socat'], exec: SOCAT_MISSING_APT(), euid: () => 0, diagnostic, mutating });
    assert.equal(diagnostic.calls.length, 0, 'no sudo -n preflight as root');
    assert.equal(mutating.calls[0].argv[0], '/usr/bin/env');
  });

  it('sudo absent everywhere → loud degrade with the ROOT-form command, runs NOTHING, exit 3', (t) => {
    const r = runDoctor(t, { argv: ['--apply', 'apt-get:socat'], exec: execWorld('/usr/bin/bwrap', '/usr/bin/apt-get', '/usr/bin/env') });
    assert.equal(r.code, EXIT.notReady);
    assert.match(r.out, /run this as ROOT/);
    assert.match(r.out, /\/usr\/bin\/env DEBIAN_FRONTEND=noninteractive \/usr\/bin\/apt-get install -y socat/);
    assert.match(r.out, /status=handoff-required/);
    assert.equal(r.mutating.calls.length, 0);
  });

  it('sudo found ONLY outside the trusted dirs → untrusted degrade naming its location, exit 6', (t) => {
    const r = runDoctor(t, {
      argv: ['--apply', 'apt-get:socat'],
      env: { PATH: '/opt/bin:/usr/bin' },
      exec: execWorld('/usr/bin/bwrap', '/usr/bin/apt-get', '/usr/bin/env', '/opt/bin/sudo'),
    });
    assert.equal(r.code, EXIT.unsupported);
    assert.match(r.out, /sudo found ONLY at \/opt\/bin\/sudo/);
    assert.equal(r.mutating.calls.length, 0);
  });

  it('sudo -n success → proceeds with the LOUD no-password note', (t) => {
    const r = runDoctor(t, { argv: ['--apply', 'apt-get:socat'], exec: SOCAT_MISSING_APT() });
    assert.match(r.out, /WITHOUT a password prompt \(cached credentials or NOPASSWD\)/);
    assert.equal(r.mutating.calls.length, 1);
    assert.deepEqual(r.diagnostic.calls[0].argv, ['/usr/bin/sudo', '-n', 'true']);
  });

  it('sudo -n failure + isTTY → proceeds (interactive password prompt)', (t) => {
    const diagnostic = makeRunner((d) => (d.argv[1] === '-n' ? { status: 1, stdout: '', stderr: 'sudo: a password is required' } : GREEN));
    const r = runDoctor(t, { argv: ['--apply', 'apt-get:socat'], exec: SOCAT_MISSING_APT(), diagnostic, isTTY: true });
    assert.match(r.out, /prompt for your password/);
    assert.equal(r.mutating.calls.length, 1);
  });

  it('sudo -n failure + !isTTY → runs NOTHING, prints the ENFORCED handoff with the exact command, exit 3', (t) => {
    const diagnostic = makeRunner((d) => (d.argv[1] === '-n' ? { status: 1, stdout: '', stderr: 'sudo: a password is required' } : GREEN));
    const r = runDoctor(t, { argv: ['--apply', 'apt-get:socat'], exec: SOCAT_MISSING_APT(), diagnostic, isTTY: false });
    assert.equal(r.code, EXIT.notReady);
    assert.match(r.out, /NO controlling terminal — running NOTHING/);
    assert.match(r.out, /\/usr\/bin\/sudo \/usr\/bin\/env DEBIAN_FRONTEND=noninteractive \/usr\/bin\/apt-get install -y socat/);
    assert.match(r.out, /re-run --verify/);
    assert.match(r.out, /status=handoff-required/);
    assert.equal(r.mutating.calls.length, 0);
  });

  it('install failure → exit 4, loud, never a silent green; the verify lane never runs', (t) => {
    const mutating = makeRunner(() => ({ status: 100, stdout: '', stderr: '' }));
    const r = runDoctor(t, { argv: ['--apply', 'apt-get:socat'], exec: SOCAT_MISSING_APT(), mutating, euid: () => 0 });
    assert.equal(r.code, EXIT.installFailed);
    assert.match(r.out, /install FAILED \(exit 100\)/);
    assert.match(r.out, /stale package index/);
    assert.match(r.out, /status=install-failed/);
  });

  it('install SPAWN error (res.error) is its own loud exit-4 branch', (t) => {
    const mutating = makeRunner(() => ({ error: { code: 'EACCES' }, status: null }));
    const r = runDoctor(t, { argv: ['--apply', 'apt-get:socat'], exec: SOCAT_MISSING_APT(), mutating, euid: () => 0 });
    assert.equal(r.code, EXIT.installFailed);
    assert.match(r.out, /install could not SPAWN \(EACCES\)/);
  });

  it('apply re-prints the EXACT resolved absolute-path command BEFORE the MUTATING call (D9 bridge)', (t) => {
    const seen = [];
    const lines = [];
    const exec = SOCAT_MISSING_APT();
    const mutating = makeRunner(() => {
      seen.push(...lines);
      exec.add('/usr/bin/socat');
      return GREEN;
    });
    const code = main(['--apply', 'apt-get:socat'], {
      cwd: makeDeployedDir(t),
      platform: 'linux',
      env: { PATH: '/usr/bin:/bin' },
      isExecutable: exec,
      euid: () => 1000,
      diagnosticRunner: makeRunner(),
      mutatingRunner: mutating,
      execPath: EXEC_PATH,
      log: (line) => lines.push(line),
    });
    assert.equal(code, EXIT.ready);
    assert.ok(seen.some((l) => l.includes('/usr/bin/sudo /usr/bin/env DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get install -y socat')),
      'the exact resolved command must be printed BEFORE the MUTATING runner is invoked');
    assert.ok(seen.some((l) => l.includes('executing EXACTLY')));
  });
});

// ── D4/D7 — tuple consent ─────────────────────────────────────────────────────────────

describe('D4/D7 — the consent tuple', () => {
  it('bare --apply → usage exit 2, runs NOTHING', (t) => {
    const r = runDoctor(t, { argv: ['--apply'], exec: SOCAT_MISSING_APT() });
    assert.equal(r.code, EXIT.usage);
    assert.match(r.out, /bare --apply is refused/);
    assert.match(r.out, /status=usage/);
    assert.equal(r.diagnostic.calls.length, 0);
    assert.equal(r.mutating.calls.length, 0);
  });

  it('tuple mismatch vs the re-derived plan → refuse, exit 2, runs NOTHING', (t) => {
    const r = runDoctor(t, { argv: ['--apply', 'apt-get:bubblewrap'], exec: SOCAT_MISSING_APT() });
    assert.equal(r.code, EXIT.usage);
    assert.match(r.out, /consent REFUSED: tuple mismatch/);
    assert.match(r.out, /derives "apt-get:socat"/);
    assert.equal(r.diagnostic.calls.length, 0);
    assert.equal(r.mutating.calls.length, 0);
  });

  it('--apply on a READY host → the re-derived plan is EMPTY, refuse, exit 2, MUTATING never invoked', (t) => {
    const r = runDoctor(t, { argv: ['--apply', 'apt-get:socat'], exec: READY_EXEC() });
    assert.equal(r.code, EXIT.usage);
    assert.match(r.out, /re-derived plan is EMPTY/);
    assert.equal(r.mutating.calls.length, 0);
  });

  it('unknown flag → usage exit 2, runs NOTHING', (t) => {
    const r = runDoctor(t, { argv: ['--force'], exec: READY_EXEC() });
    assert.equal(r.code, EXIT.usage);
    assert.match(r.out, /unknown flag: --force/);
    assert.equal(r.diagnostic.calls.length, 0);
    assert.equal(r.mutating.calls.length, 0);
  });

  it('--verify combined with --apply → usage exit 2', (t) => {
    const r = runDoctor(t, { argv: ['--verify', '--apply', 'apt-get:socat'], exec: READY_EXEC() });
    assert.equal(r.code, EXIT.usage);
    assert.match(r.out, /at most ONE/);
  });

  it('parseDoctorArgs pins the tuple grammar', () => {
    assert.deepEqual(parseDoctorArgs(['--apply', 'apt-get:socat']), { lane: 'apply', tuple: 'apt-get:socat' });
    assert.deepEqual(parseDoctorArgs(['--apply=dnf:bubblewrap,socat']), { lane: 'apply', tuple: 'dnf:bubblewrap,socat' });
    assert.throws(() => parseDoctorArgs(['--apply', 'no-colon']), /not <pm>:<pkg/);
    assert.throws(() => parseDoctorArgs(['--apply', '--verify']), /bare --apply is refused/);
  });
});

// ── D5/D6 — idempotence ──────────────────────────────────────────────────────────────

describe('D5/D6 — idempotence (ready host)', () => {
  it('NON-ROOT ready host → "nothing to install", exit 0, MUTATING never invoked', (t) => {
    const r = runDoctor(t, { argv: ['--verify'], exec: READY_EXEC(), euid: () => 1000 });
    assert.equal(r.code, EXIT.ready);
    assert.match(r.out, /nothing to install/);
    assert.equal(r.mutating.calls.length, 0);
  });

  it('root/SUDO_UID ready host → root-unproven exit 5, MUTATING never invoked (the branches do not contradict)', (t) => {
    const r = runDoctor(t, { argv: ['--verify'], exec: READY_EXEC(), euid: () => 0 });
    assert.equal(r.code, EXIT.verifyFailed);
    assert.match(r.out, /status=root-unproven/);
    assert.equal(r.mutating.calls.length, 0);
  });
});

// ── D9 — the preview disclosure + honesty outputs ────────────────────────────────────

describe('D9 — disclosure + honesty', () => {
  it('the flagless preview carries the D9 disclosure text (all three residuals)', (t) => {
    const r = runDoctor(t, { exec: READY_EXEC() });
    assert.match(r.out, /Residual disclosure \(D9\)/);
    assert.match(r.out, /already lost/);
    assert.match(r.out, /PATH at session init|resolves bwrap\/socat via PATH/);
    assert.match(r.out, /tuple, not the absolute-path command/);
  });

  it('the preview of a missing host prints the WOULD-run command with the resolved absolute sudo path', (t) => {
    const r = runDoctor(t, { exec: SOCAT_MISSING_APT() });
    assert.match(r.out, /\/usr\/bin\/sudo \/usr\/bin\/env DEBIAN_FRONTEND=noninteractive \/usr\/bin\/apt-get install -y socat/);
    assert.match(r.out, /--apply apt-get:socat/);
  });

  it('the preview on a sudo-less host prints the ROOT form + the run-as-root note (still exit 3, runs NOTHING)', (t) => {
    const r = runDoctor(t, { exec: execWorld('/usr/bin/bwrap', '/usr/bin/apt-get', '/usr/bin/env') });
    assert.equal(r.code, EXIT.notReady);
    assert.match(r.out, /no sudo in the trusted dirs — the command above is the ROOT form/);
    assert.equal(r.diagnostic.calls.length, 0);
  });

  it('the preview with sudo only OUTSIDE the trusted dirs names its location in the root-form note', (t) => {
    const r = runDoctor(t, {
      env: { PATH: '/opt/bin:/usr/bin' },
      exec: execWorld('/usr/bin/bwrap', '/usr/bin/apt-get', '/usr/bin/env', '/opt/bin/sudo'),
    });
    assert.match(r.out, /sudo found only at \/opt\/bin\/sudo — NOT in the trusted dirs/);
  });
});

// ── the real seams (executed characterization — no apt/sudo/bwrap, ever) ─────────────

describe('default seams — characterized with harmless argv', () => {
  it('hasControllingTerminal returns a boolean (the /dev/tty probe never throws)', () => {
    assert.equal(typeof hasControllingTerminal(), 'boolean');
  });

  it('runDiagnosticSpawn captures stdio of a harmless child (node --version)', () => {
    const res = runDiagnosticSpawn({ argv: [process.execPath, '--version'], env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe' });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /^v\d+/);
  });

  it('runMutatingSpawn executes the descriptor argv verbatim (harmless child, silenced stdio)', () => {
    const res = runMutatingSpawn({ argv: [process.execPath, '--version'], env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'ignore'] });
    assert.equal(res.status, 0);
  });

  it('the CLI entry runs end-to-end (subprocess smoke: --help exits 0, spawns nothing)', () => {
    const script = join(HERE, 'autonomy-doctor.mjs');
    const r = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /sandbox provisioner doctor/);
  });

  // review-autonomy-doctor-r01-minor-01: --help is NOT a diagnosis outcome — the summary contract is scoped to
  // the three lanes, and help's LAST line must never read as a live machine summary.
  it('--help prints no machine summary line (its last line does not match the pinned schema)', () => {
    const script = join(HERE, 'autonomy-doctor.mjs');
    const r = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
    const lines = r.stdout.replace(/\n$/, '').split('\n');
    assert.ok(!SUMMARY_RE.test(lines[lines.length - 1]), `help's last line must not parse as a summary: ${lines[lines.length - 1]}`);
    assert.match(r.stdout, /--help prints this help text alone/, 'the help states its own summary-line exception');
  });
});

// ── D7/D8 — deployment gate + stamp exemption ────────────────────────────────────────

describe('D7/D8 — gating', () => {
  it('no docs/ai → precondition STOP, status no-deployment, exit 1, the summary line still LAST', (t) => {
    const r = runDoctor(t, { cwd: makeBareDir(t), exec: READY_EXEC() });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.out, /precondition STOP/);
    assert.match(r.out, /status=no-deployment/);
  });

  it('NO stamp gate: a deployment WITHOUT .workflow-version runs every lane (test-pinned exemption)', (t) => {
    // A stamp gate would STOP before the consent check; reaching the consent refuse proves its absence.
    const r = runDoctor(t, { argv: ['--apply', 'apt-get:socat'], exec: READY_EXEC() });
    assert.equal(r.code, EXIT.usage);
    assert.ok(!/workflow-version|stamp/i.test(r.out), 'no stamp-gate wording may appear');
  });

  it('structural pin: the doctor never imports the stamp constant or reads .workflow-version', () => {
    const src = readFileSync(join(HERE, 'autonomy-doctor.mjs'), 'utf8');
    assert.ok(!src.includes('EXPECTED_WORKFLOW_VERSION'), 'no stamp-constant import');
    assert.ok(!/\.workflow-version(?!.*EXEMPTION)/.test(src.replace(/\/\/[^\n]*/g, '')), 'no stamp-file read outside comments');
  });
});
