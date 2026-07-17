#!/usr/bin/env node
// autonomy-doctor.mjs — the cross-platform sandbox provisioner "doctor" (AD-044 Plan 2; mode:
// autonomy-doctor, GUARDED). Detect → consent-gated install → verify → loud degrade, for the
// AD-044 sandbox matrix: macOS Seatbelt built-in / Linux+WSL2 bwrap+socat / native Windows → WSL2.
//
// THREE lanes:
//   (flagless)          FS-only preview: diagnosis + the exact command it WOULD run + the exact
//                       --apply consent tuple. ZERO subprocesses. Never claims "ready".
//   --verify            unprivileged diagnostic: bwrap userns smoke + `socat -V` (captured stdio,
//                       DIAGNOSTIC runner). The ONLY source of a Linux "ready (verified)" claim.
//   --apply <pm>:<pkgs> consent-gated privileged install. The tuple must EQUAL the re-derived
//                       plan (consent binds to the previewed plan; mismatch → refuse, runs
//                       NOTHING), then the verify lane runs automatically.
//
// Trust gate (D2/D3): everything the doctor EXECUTES resolves to an ABSOLUTE path inside the
// FIXED trusted dirs /usr/bin:/bin:/usr/sbin:/sbin (isExecutableFile — statSync follows an
// in-dir symlink; /usr/local/bin deliberately excluded). A binary found only outside → loud
// degrade naming its location, never executed. The privileged child gets a minimal SCRUBBED env
// (trusted-dir PATH + LANG), argv array, no shell, stdio ['ignore','inherit','inherit'].
//
// Gating (D8): docs/ai deployment presence on EVERY run. NO .workflow-version stamp gate — the
// doctor mutates the OS, never lineage-bound repo content (the stated stamp EXEMPTION).
//
// Exit codes (D7, frozen): 0 ready (ready-verified / ready-assumed; Linux only via the verify
// oracle) · 1 precondition STOP (no-deployment) · 2 usage (bare --apply, tuple mismatch, unknown
// flag) · 3 not-ready diagnosis (missing-binaries offer / present-unverified / handoff-required)
// · 4 install failed · 5 verify failed / indeterminate / root-unproven · 6 unsupported/untrusted
// (win32 / unknown PM / found-only-outside-trusted-dirs). The machine summary line prints LAST in
// every diagnosis outcome (--help prints the help text alone):
// [autonomy-doctor] status=<token> platform=<p> missing=<csv> pm=<name|none>.
//
// Residual disclosure (D9, shipped in the preview): (i) a root-owned hostile binary inside the
// trusted dirs = the host is already lost (out of threat model); (ii) Claude itself resolves
// bwrap/socat via PATH at session init — the doctor verifies the trusted-dir copies and WARNS on
// a PATH shadow, never fixes it; (iii) the harness permission prompt shows the --apply tuple, not
// the absolute-path command — bridged by the apply-time re-print of the exact resolved command.
//
// Dependency-free, Node >= 22. No side effects on import (the isDirectRun idiom).

import { spawnSync } from 'node:child_process';
import { closeSync, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isExecutableFile, probeSandboxAvailability } from './velocity-profile.mjs';
import { assertDocsAiDeployment } from './atomic-write.mjs';

// ── the frozen contract tables (fixtures the tests copy) ────────────────────────────

export const TRUSTED_DIRS = Object.freeze(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
const TRUSTED_PATH = TRUSTED_DIRS.join(':');

// The closed world of sandbox binaries → package names. Keys double as the binary list (the
// probe's SANDBOX_LINUX_BINARIES mirror); no repo/config/user input ever enters a command line.
export const PACKAGE_FOR = Object.freeze({ bwrap: 'bubblewrap', socat: 'socat' });

export const EXIT = Object.freeze({
  ready: 0,
  stop: 1,
  usage: 2,
  notReady: 3,
  installFailed: 4,
  verifyFailed: 5,
  unsupported: 6,
});

export const STATUS = Object.freeze({
  readyVerified: 'ready-verified',
  readyAssumed: 'ready-assumed',
  noDeployment: 'no-deployment',
  usage: 'usage',
  missingBinaries: 'missing-binaries',
  presentUnverified: 'present-unverified',
  handoffRequired: 'handoff-required',
  installFailed: 'install-failed',
  verifyFailed: 'verify-failed',
  indeterminate: 'indeterminate',
  rootUnproven: 'root-unproven',
  unsupportedPlatform: 'unsupported-platform',
  unknownPm: 'unknown-pm',
  untrustedPath: 'untrusted-path',
});

export const EXIT_FOR_STATUS = Object.freeze({
  [STATUS.readyVerified]: EXIT.ready,
  [STATUS.readyAssumed]: EXIT.ready,
  [STATUS.noDeployment]: EXIT.stop,
  [STATUS.usage]: EXIT.usage,
  [STATUS.missingBinaries]: EXIT.notReady,
  [STATUS.presentUnverified]: EXIT.notReady,
  [STATUS.handoffRequired]: EXIT.notReady,
  [STATUS.installFailed]: EXIT.installFailed,
  [STATUS.verifyFailed]: EXIT.verifyFailed,
  [STATUS.indeterminate]: EXIT.verifyFailed,
  [STATUS.rootUnproven]: EXIT.verifyFailed,
  [STATUS.unsupportedPlatform]: EXIT.unsupported,
  [STATUS.unknownPm]: EXIT.unsupported,
  [STATUS.untrustedPath]: EXIT.unsupported,
});

// The MUTATING stdio contract: sudo prompts on /dev/tty (never stdin), no PM can block on stdin.
export const MUTATING_STDIO = Object.freeze(['ignore', 'inherit', 'inherit']);

// The frozen 4-family install map (D3, closed world). First-present in the trusted dirs wins.
// Every executable token in the built argv is a D2-resolved ABSOLUTE trusted-dir path — apt's
// non-interactivity rides the env TRAMPOLINE (env is the command sudo runs, so sudo env_reset
// cannot strip DEBIAN_FRONTEND; a bare `apt-get` after env would hand resolution back to PATH).
const PM_FAMILIES = Object.freeze([
  Object.freeze({ name: 'apt-get', needsEnvTrampoline: true }),
  Object.freeze({ name: 'dnf', needsEnvTrampoline: false }),
  Object.freeze({ name: 'pacman', needsEnvTrampoline: false }),
  Object.freeze({ name: 'apk', needsEnvTrampoline: false }),
]);

const buildFamilyArgv = (family, pmPath, envPath, packages) => {
  if (family.name === 'apt-get') return [envPath, 'DEBIAN_FRONTEND=noninteractive', pmPath, 'install', '-y', ...packages];
  if (family.name === 'dnf') return [pmPath, 'install', '-y', ...packages];
  if (family.name === 'pacman') return [pmPath, '-S', '--needed', '--noconfirm', ...packages];
  return [pmPath, 'add', ...packages];
};

// The bwrap userns smoke (D5) — HOST-PROVEN fixture 2026-07-10 (WSL2, bwrap 0.9.0): the payload is
// process.execPath (injectable; `--ro-bind / /` makes it reachable — no /bin/true assumption).
export const buildSmokeArgv = (bwrapPath, execPath) =>
  Object.freeze([bwrapPath, '--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', execPath, '--version']);

// A smoke stderr that matches this WITH present binaries is the namespace-denied signature —
// LOUD INDETERMINATE (nested sandboxing / already inside a container), never an install offer.
const NAMESPACE_DENIED_RE = /operation not permitted|permission denied|no permissions to creat/i;

const D9_DISCLOSURE = [
  'Residual disclosure (D9):',
  '  (i)  a root-owned hostile binary inside the trusted dirs means the host is already lost — out of this doctor\'s threat model.',
  `  (ii) Claude itself resolves bwrap/socat via PATH at session init — the doctor verifies the trusted-dir copies (${TRUSTED_PATH}) and WARNS on a PATH shadow; it never fixes PATH.`,
  '  (iii) the harness permission prompt shows the --apply <pm>:<pkgs> tuple, not the absolute-path command — bridged by the apply-time re-print of the exact resolved command.',
];

const RESTART_NOTE =
  'Restart Claude Code now — the sandbox is detected only at session start; a fresh session is the behavioral proof.';
const VERIFY_HONESTY =
  'Honesty: a green verify proves the OS sandbox primitives (bwrap user namespaces + socat), NOT that Claude initialized its sandbox.';
const WSL2_REDIRECT =
  'native Windows is unsupported — run Claude Code inside WSL2 (Ubuntu) and re-run the doctor there.';
const SEATBELT_NOTE = 'macOS: Seatbelt assumed built-in — not smoke-tested by this doctor.';

const USAGE_HINT =
  'usage: autonomy-doctor.mjs [--verify | --apply <pm>:<pkg[,pkg...]>]  (flagless = FS-only preview)';

const HELP = `autonomy-doctor — sandbox provisioner doctor (detect → consent-gated install → verify).

Usage:
  node autonomy-doctor.mjs                      FS-only preview (diagnosis + the exact plan; runs NOTHING)
  node autonomy-doctor.mjs --verify             unprivileged diagnostic: bwrap userns smoke + socat -V
  node autonomy-doctor.mjs --apply <pm>:<pkgs>  consent-gated install (tuple must equal the previewed plan),
                                                then the verify lane runs automatically
  --help, -h                                    this help

Consent contract: --apply REQUIRES the <pm>:<pkg,...> tuple the preview printed — a mismatch vs the
re-derived plan refuses (exit 2) and runs NOTHING. Everything executed resolves to an absolute path
inside the trusted dirs ${TRUSTED_PATH}; the exact resolved command is re-printed immediately
before execution. The doctor never writes repo files and never commits.

Exit codes: 0 ready (ready-verified / ready-assumed) · 1 precondition STOP (no docs/ai deployment) ·
2 usage · 3 not-ready diagnosis · 4 install failed · 5 verify failed/indeterminate/root-unproven ·
6 unsupported/untrusted. The last line of every diagnosis outcome is the machine summary:
[autonomy-doctor] status=<token> platform=<p> missing=<csv> pm=<name|none>
(--help prints this help text alone — no summary line.)`;

// ── small pure helpers ───────────────────────────────────────────────────────────────

const NO_MISSING = '-';
export const composeSummaryLine = ({ status, platform, missing = [], pm = null }) =>
  `[autonomy-doctor] status=${status} platform=${platform} missing=${missing.length > 0 ? missing.join(',') : NO_MISSING} pm=${pm ?? 'none'}`;

const resolveTrusted = (name, isExec) => TRUSTED_DIRS.map((dir) => join(dir, name)).find((p) => isExec(p)) ?? null;

const findFirstPathHit = (name, env, isExec) =>
  ((env && env.PATH) || '').split(':').filter(Boolean).map((dir) => join(dir, name)).find((p) => isExec(p)) ?? null;

export const hasControllingTerminal = () => {
  try {
    closeSync(openSync('/dev/tty', 'r'));
    return true;
  } catch {
    return false;
  }
};

// ── the pure planner core (diagnosis + plan + tuple as DATA; no subprocesses) ─────────

export const deriveDoctorPlan = ({ probeResult, env, isExec }) => {
  const missing = probeResult.missing ?? [];
  const packages = missing.map((binary) => PACKAGE_FOR[binary]);
  const resolutions = Object.keys(PACKAGE_FOR).map((name) => {
    const trusted = resolveTrusted(name, isExec);
    const pathHit = findFirstPathHit(name, env, isExec);
    return { name, trusted, pathHit, missing: missing.includes(name) };
  });
  const shadows = resolutions.filter((r) => !r.missing && r.trusted !== null && r.pathHit !== null && r.pathHit !== r.trusted);
  const untrusted = resolutions.filter((r) => !r.missing && r.trusted === null);
  const family = PM_FAMILIES.map((f) => ({ family: f, path: resolveTrusted(f.name, isExec) })).find((f) => f.path !== null) ?? null;
  const envPath = resolveTrusted('env', isExec);
  const pm = family === null ? null : { name: family.family.name, path: family.path };
  const envMissing = family !== null && family.family.needsEnvTrampoline && envPath === null;
  const tuple = pm !== null && missing.length > 0 ? `${pm.name}:${packages.join(',')}` : null;
  const rootArgv = pm === null || missing.length === 0 || envMissing
    ? null
    : buildFamilyArgv(family.family, pm.path, envPath, packages);
  return { missing, packages, resolutions, shadows, untrusted, pm, envMissing, tuple, rootArgv };
};

// ── argv parsing (usage errors carry exitCode 2 via the shared idiom) ─────────────────

const usageFail = (message) => Object.assign(new Error(message), { exitCode: EXIT.usage });

export const parseDoctorArgs = (argv) => {
  let lane = 'preview';
  let tuple = null;
  const setLane = (next) => {
    if (lane !== 'preview') throw usageFail('pass at most ONE of --verify / --apply');
    lane = next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { lane: 'help', tuple: null };
    if (arg === '--verify') setLane('verify');
    else if (arg === '--apply' || arg.startsWith('--apply=')) {
      const raw = arg === '--apply' ? argv[(i += 1)] : arg.slice('--apply='.length);
      if (raw === undefined || raw === '' || raw.startsWith('--')) {
        throw usageFail('--apply requires the consent tuple <pm>:<pkg[,pkg...]> the preview printed (a bare --apply is refused)');
      }
      if (!/^[^:\s]+:[^:\s]+$/.test(raw)) throw usageFail(`--apply tuple "${raw}" is not <pm>:<pkg[,pkg...]>`);
      setLane('apply');
      tuple = raw;
    } else throw usageFail(`unknown flag: ${arg}`);
  }
  return { lane, tuple };
};

// ── rendering ─────────────────────────────────────────────────────────────────────────

const renderDiagnosis = ({ plan, probeResult, log }) => {
  log('autonomy-doctor — Linux sandbox diagnosis (bwrap + socat)');
  log(`  probe: ${probeResult.reason}`);
  for (const r of plan.resolutions) {
    if (r.missing && r.trusted !== null) {
      log(`  ${r.name}: NOT on PATH (the probe follows Claude's own PATH resolution) but present at ${r.trusted} — fix your PATH rather than re-installing.`);
    } else if (r.missing) log(`  ${r.name}: MISSING`);
    else if (r.trusted === null) {
      log(`  ${r.name}: found ONLY at ${r.pathHit} — NOT in the trusted dirs (${TRUSTED_PATH}); the doctor will never execute it`);
    } else log(`  ${r.name}: ${r.trusted}`);
  }
  for (const s of plan.shadows) {
    log(`  PATH-SHADOW WARNING: ${s.name} first resolves on PATH at ${s.pathHit}, not the trusted ${s.trusted} — Claude will resolve the PATH one at session init (the D9 residual); the doctor verifies only the trusted copy.`);
  }
};

// The untrusted degrade every lane runs FIRST (codex R1): while any sandbox binary resolves only
// outside the trusted dirs, no offer, no consent invitation, and no privileged path may proceed —
// an install cannot make such a host verify-ready.
const refuseUntrusted = ({ plan, log }) => {
  for (const r of plan.untrusted) {
    log(`${r.name} found ONLY at ${r.pathHit} — NOT in the trusted dirs (${TRUSTED_PATH}); refusing every install/verify path until a trusted copy exists (loud degrade, D2).`);
  }
  return STATUS.untrustedPath;
};

// The install offer (flagless + --verify share it). Returns the status token for the missing case.
const renderOffer = ({ plan, euid, isExec, env, log }) => {
  if (plan.untrusted.length > 0) return refuseUntrusted({ plan, log });
  if (plan.pm === null) {
    const packages = plan.packages.join(' + ');
    const outside = PM_FAMILIES
      .map((f) => ({ name: f.name, hit: findFirstPathHit(f.name, env, isExec) }))
      .filter((f) => f.hit !== null);
    if (outside.length > 0) {
      log(`package manager found ONLY outside the trusted dirs (${outside.map((f) => `${f.name} at ${f.hit}`).join('; ')}) — refusing to execute it (loud degrade, D3); install ${packages} manually, then re-run --verify.`);
      return STATUS.untrustedPath;
    }
    log(`no supported package manager found in the trusted dirs (supported: ${PM_FAMILIES.map((f) => f.name).join(', ')}) — install ${packages} manually with your PM, then re-run --verify. (zypper et al. are deliberate omissions — a stated degrade, never a guess.)`);
    return STATUS.unknownPm;
  }
  if (plan.envMissing) {
    log(`env not found in the trusted dirs (${TRUSTED_PATH}) — the apt non-interactivity trampoline cannot be built; install ${plan.packages.join(' + ')} manually, then re-run --verify.`);
    return STATUS.untrustedPath;
  }
  log(`  missing: ${plan.missing.join(', ')} → package(s): ${plan.packages.join(', ')} (via ${plan.pm.name})`);
  const sudoTrusted = resolveTrusted('sudo', isExec);
  const printedArgv = euid === 0 || sudoTrusted === null ? plan.rootArgv : [sudoTrusted, ...plan.rootArgv];
  log('  with your consent the doctor WOULD run exactly:');
  log(`    ${printedArgv.join(' ')}`);
  if (euid !== 0 && sudoTrusted === null) {
    const sudoOnPath = findFirstPathHit('sudo', env, isExec);
    log(sudoOnPath === null
      ? '  (no sudo in the trusted dirs — the command above is the ROOT form; run it as root)'
      : `  (sudo found only at ${sudoOnPath} — NOT in the trusted dirs; the command above is the ROOT form)`);
  }
  log(`  consent: re-run with  --apply ${plan.tuple}   (the tuple binds consent to exactly this plan)`);
  return STATUS.missingBinaries;
};

// ── the verify lane (D5 — the ONE ready predicate; shared by --verify and post-apply) ──

const runVerifyLane = ({ plan, ctx }) => {
  const { log, isExec, env, euid, execPath, diagnosticRunner, scrubbedEnv } = ctx;
  if (plan.untrusted.length > 0) return refuseUntrusted({ plan, log });
  if (plan.missing.length > 0) return renderOffer({ plan, euid, isExec, env, log });
  if (euid === 0 || (env && env.SUDO_UID)) {
    log('refusing the "verified" claim: running as root (euid 0 / SUDO_UID set) — a green smoke under root does NOT prove UNPRIVILEGED user namespaces. Re-run --verify as your normal user.');
    return STATUS.rootUnproven;
  }
  const bwrapPath = plan.resolutions.find((r) => r.name === 'bwrap').trusted;
  const socatPath = plan.resolutions.find((r) => r.name === 'socat').trusted;
  const smoke = diagnosticRunner({ argv: [...buildSmokeArgv(bwrapPath, execPath)], env: scrubbedEnv, stdio: 'pipe' });
  if (smoke.error) {
    log(`bwrap smoke could not SPAWN (${smoke.error.code ?? smoke.error.message}) — the binary resolved but did not execute.`);
    return STATUS.verifyFailed;
  }
  if (smoke.status !== 0) {
    const stderr = smoke.stderr ?? '';
    if (stderr) log(stderr.replace(/\n$/, ''));
    if (NAMESPACE_DENIED_RE.test(stderr)) {
      log('verify INDETERMINATE: the userns smoke was DENIED while the binaries are present — likely cause: nested sandboxing / already inside a container (a green probe cannot distinguish this). Re-run --verify from an unsandboxed shell.');
      return STATUS.indeterminate;
    }
    log(`bwrap userns smoke FAILED (exit ${smoke.status}). The binaries are PRESENT — this is NOT an install problem, so re-installing will not fix it: check unprivileged user namespaces (userns sysctl / AppArmor restrictions) and that this host is WSL2, not WSL1.`);
    return STATUS.verifyFailed;
  }
  const socat = diagnosticRunner({ argv: [socatPath, '-V'], env: scrubbedEnv, stdio: 'pipe' });
  if (socat.error || socat.status !== 0) {
    if (socat.stderr) log(socat.stderr.replace(/\n$/, ''));
    log(socat.error
      ? `socat -V could not SPAWN (${socat.error.code ?? socat.error.message}).`
      : `socat -V FAILED (exit ${socat.status}) — the binary is present but not functional; not an install-missing problem.`);
    return STATUS.verifyFailed;
  }
  log('ready (verified): probe green + bwrap userns smoke green + socat -V green — nothing to install.');
  log(VERIFY_HONESTY);
  log(RESTART_NOTE);
  return STATUS.readyVerified;
};

// ── the apply lane (the ONE place the MUTATING runner may be invoked, exactly once) ───

const runApplyLane = ({ plan, tuple, ctx }) => {
  const { log, isExec, env, euid, diagnosticRunner, mutatingRunner, scrubbedEnv, isTTYOf } = ctx;
  if (plan.untrusted.length > 0) return { status: refuseUntrusted({ plan, log }), finalPlan: plan };
  if (plan.missing.length === 0) {
    log(`consent REFUSED: the re-derived plan is EMPTY (nothing missing) — the tuple "${tuple}" matches no plan. Nothing was run or installed; run --verify for the ready proof.`);
    return { status: STATUS.usage, finalPlan: plan };
  }
  if (plan.pm === null || plan.envMissing) return { status: renderOffer({ plan, euid, isExec, env, log }), finalPlan: plan };
  if (tuple !== plan.tuple) {
    log(`consent REFUSED: tuple mismatch — given "${tuple}", the current diagnosis derives "${plan.tuple}". Nothing was run; re-run flagless to preview, then --apply with the derived tuple.`);
    return { status: STATUS.usage, finalPlan: plan };
  }
  let execArgv = plan.rootArgv;
  if (euid !== 0) {
    const sudoTrusted = resolveTrusted('sudo', isExec);
    if (sudoTrusted === null) {
      const sudoOnPath = findFirstPathHit('sudo', env, isExec);
      if (sudoOnPath !== null) {
        log(`sudo found ONLY at ${sudoOnPath} — NOT in the trusted dirs (${TRUSTED_PATH}); refusing to execute it.`);
        return { status: STATUS.untrustedPath, finalPlan: plan };
      }
      log('sudo is not available — run this as ROOT in your terminal, then re-run --verify:');
      log(`  ${plan.rootArgv.join(' ')}`);
      return { status: STATUS.handoffRequired, finalPlan: plan };
    }
    const preflight = diagnosticRunner({ argv: [sudoTrusted, '-n', 'true'], env: scrubbedEnv, stdio: 'pipe' });
    const preflightGreen = !preflight.error && preflight.status === 0;
    if (preflightGreen) {
      log('sudo will run WITHOUT a password prompt (cached credentials or NOPASSWD) — the install proceeds non-interactively.');
    } else if (!isTTYOf()) {
      log('sudo needs a password and there is NO controlling terminal — running NOTHING. Run this in YOUR terminal, then re-run --verify:');
      log(`  ${[sudoTrusted, ...plan.rootArgv].join(' ')}`);
      return { status: STATUS.handoffRequired, finalPlan: plan };
    } else {
      log('sudo will prompt for your password on your terminal.');
    }
    execArgv = [sudoTrusted, ...plan.rootArgv];
  }
  log('executing EXACTLY (every token trusted-dir absolute):');
  log(`  ${execArgv.join(' ')}`);
  const res = mutatingRunner({ argv: execArgv, env: scrubbedEnv, stdio: [...MUTATING_STDIO] });
  if (res.error || res.status !== 0) {
    log(res.error
      ? `install could not SPAWN (${res.error.code ?? res.error.message}).`
      : `install FAILED (exit ${res.status}) — see the package manager output above (stderr was inherited). A stale package index is one possible cause (the doctor never refreshes indexes — run your PM's update by hand if so).`);
    return { status: STATUS.installFailed, finalPlan: plan };
  }
  log('install completed — running the verify lane...');
  const freshProbe = ctx.probe();
  const freshPlan = deriveDoctorPlan({ probeResult: freshProbe, env, isExec });
  return { status: runVerifyLane({ plan: freshPlan, ctx }), finalPlan: freshPlan };
};

// ── default runners (the ONE real-process boundary; injectable for hermetic tests) ────

export const runDiagnosticSpawn = (descriptor) =>
  spawnSync(descriptor.argv[0], descriptor.argv.slice(1), { env: descriptor.env, encoding: 'utf8', stdio: 'pipe' });
export const runMutatingSpawn = (descriptor) =>
  spawnSync(descriptor.argv[0], descriptor.argv.slice(1), { env: descriptor.env, stdio: descriptor.stdio });

// ── main(argv, deps) → exit code ──────────────────────────────────────────────────────

export const main = (argv, deps = {}) => {
  const log = deps.log ?? console.log;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const lstat = deps.lstat ?? lstatSync;
  const isExec = deps.isExecutable ?? isExecutableFile;
  const execPath = deps.execPath ?? process.execPath;
  const diagnosticRunner = deps.diagnosticRunner ?? runDiagnosticSpawn;
  const mutatingRunner = deps.mutatingRunner ?? runMutatingSpawn;
  const probe = deps.probe ?? (() => probeSandboxAvailability({ platform, env, isExecutable: isExec }));
  const euidOf = deps.euid ?? (() => process.geteuid?.());
  const isTTYOf = () => deps.isTTY ?? hasControllingTerminal();

  const finish = (status, plan = null) => {
    log(composeSummaryLine({ status, platform, missing: plan?.missing ?? [], pm: plan?.pm?.name ?? null }));
    return EXIT_FOR_STATUS[status];
  };

  let parsed;
  try {
    parsed = parseDoctorArgs(argv);
  } catch (err) {
    log(`autonomy-doctor: ${err.message}`);
    log(USAGE_HINT);
    return finish(STATUS.usage);
  }
  if (parsed.lane === 'help') {
    log(HELP);
    return 0;
  }

  try {
    assertDocsAiDeployment(cwd, { lstat }, { noun: 'anything', rel: 'anything here' });
  } catch (err) {
    log(`precondition STOP — ${err.message}`);
    return finish(STATUS.noDeployment);
  }

  if (platform === 'win32') {
    log(WSL2_REDIRECT);
    return finish(STATUS.unsupportedPlatform);
  }
  if (platform === 'darwin') {
    if (parsed.lane === 'apply') {
      log(`consent REFUSED: nothing to install on macOS (Seatbelt is built-in) — the tuple "${parsed.tuple}" matches no plan. Nothing was run.`);
      return finish(STATUS.usage);
    }
    log(SEATBELT_NOTE);
    return finish(STATUS.readyAssumed);
  }
  if (platform !== 'linux') {
    log(`native ${platform} sandbox unsupported — use WSL2 on Windows.`);
    return finish(STATUS.unsupportedPlatform);
  }

  // Linux from here; euid resolves LAZILY after the platform gate (process.geteuid is win32-absent).
  const euid = euidOf();
  const probeResult = probe();
  const plan = deriveDoctorPlan({ probeResult, env, isExec });
  const scrubbedEnv = { PATH: TRUSTED_PATH, ...(env && env.LANG ? { LANG: env.LANG } : {}) };
  const ctx = { log, isExec, env, euid, execPath, diagnosticRunner, mutatingRunner, scrubbedEnv, isTTYOf, probe };

  renderDiagnosis({ plan, probeResult, log });

  if (parsed.lane === 'preview') {
    let status;
    if (plan.untrusted.length > 0) status = refuseUntrusted({ plan, log });
    else if (plan.missing.length > 0) status = renderOffer({ plan, euid, isExec, env, log });
    else {
      log('  state: binaries present but UNVERIFIED — the flagless preview never claims ready; run --verify for the ready proof.');
      status = STATUS.presentUnverified;
    }
    for (const line of D9_DISCLOSURE) log(line);
    return finish(status, plan);
  }
  if (parsed.lane === 'verify') return finish(runVerifyLane({ plan, ctx }), plan);
  const applied = runApplyLane({ plan, tuple: parsed.tuple, ctx });
  return finish(applied.status, applied.finalPlan);
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exit(main(process.argv.slice(2)));
