#!/usr/bin/env node
// Backend detector — read-only detection of the family's optional execution-backends (the bridges
// to subscription CLIs: codex-cli-bridge → `codex`, antigravity-cli-bridge → `agy`). Surfaced as
// `/agent-workflow-kit backends` and a one-line bootstrap summary. It answers "what is set up vs
// missing" WITHOUT running any subscription CLI: "credentials present" means the credential-marker
// FILE exists, never a live `codex login` / `agy` check (which spawns a paid/slow/networked CLI).
//
// Two orthogonal axes are reported independently (a healthy manifest ≠ a usable backend):
//   manifestState — health of the bridge SKILL: not-installed | unsupported-schema |
//                   invalid-manifest | foreign | stub | ok.
//   readiness     — cli + credentials + wrappers, probed for EVERY registry entry even when the
//                   skill is absent, so we can say "the CLI is installed but the bridge skill isn't".
//
// Source of truth is the in-tool KNOWN_BACKENDS registry (Option B / AD-008): a missing bridge has
// no manifest on disk and no setup/README in the kit tarball, so the per-backend facts (bin,
// credential marker, stable setup URL) must live here. A drift-guard test keeps the registry in
// lockstep with the in-repo manifests.
//
// Pure, dependency-injectable (fs/env/validator are deps), dependency-free, Node >= 18. Every fs
// probe is wrapped → an explicit `unknown` + reason, never a throw and never a nameless failure.

import { existsSync, statSync, accessSync, realpathSync, readFileSync, constants } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { validateManifest, UNSUPPORTED, INVALID } from './manifest/validate.mjs';

// Probe states. `unknown` (a wrapped fs error) NEVER counts as present in any readiness rule.
const PRESENT = 'present';
const MISSING = 'missing';
const UNKNOWN = 'unknown';

// manifestState values.
const NOT_INSTALLED = 'not-installed';
const UNSUPPORTED_SCHEMA = 'unsupported-schema';
const INVALID_MANIFEST = 'invalid-manifest';
const STUB = 'stub';
const FOREIGN = 'foreign';
const OK = 'ok';

// readiness values.
const READY = 'ready';
const NEEDS_SKILL = 'needs-skill';
const NEEDS_CLI = 'needs-cli';
const NEEDS_CREDENTIALS = 'needs-credentials';
const DEGRADED = 'degraded';

const EXPECTED_KIND = 'execution-backend';

// The kit-owned registry: the per-backend facts the detector needs even when a bridge is NOT
// installed (no manifest on disk to read). Kept in lockstep with the in-repo manifests by the
// drift-guard test. `credential.env: null` → no env override exists (do not invent one).
export const KNOWN_BACKENDS = [
  {
    name: 'codex-cli-bridge',
    installed: { env: 'CODEX_CLI_BRIDGE_DIR', default: '~/.claude/skills/codex-cli-bridge', file: 'SKILL.md' },
    bin: 'codex',
    credential: { env: 'CODEX_HOME', default: '~/.codex', file: 'auth.json' },
    setupUrl: 'https://github.com/sabaiway/agent-workflow/blob/main/codex-cli-bridge/setup/README.md',
    setupPathLocal: 'setup/README.md',
  },
  {
    name: 'antigravity-cli-bridge',
    installed: { env: 'ANTIGRAVITY_CLI_BRIDGE_DIR', default: '~/.claude/skills/antigravity-cli-bridge', file: 'SKILL.md' },
    bin: 'agy',
    credential: { env: null, default: '~/.gemini/antigravity-cli', file: 'antigravity-oauth-token' },
    setupUrl: 'https://github.com/sabaiway/agent-workflow/blob/main/antigravity-cli-bridge/setup/README.md',
    setupPathLocal: 'setup/README.md',
  },
];

// ── pure helpers ─────────────────────────────────────────────────────────────

// Expand a leading "~" / "~/x" against home; absolute and relative paths pass through untouched.
export const expandTilde = (p, home = os.homedir()) => {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
};

// Resolve a {env, default} dir spec: a non-empty env var wins as-is, else the (tilde-expanded)
// default. Same resolver for the skill dir AND the credential dir.
export const resolveDir = ({ env, default: dflt }, getenv = process.env, home = os.homedir()) => {
  const fromEnv = env ? getenv[env] : undefined;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return expandTilde(dflt, home);
};

const defaultAccessX = (p) => accessSync(p, constants.X_OK);
const defaultRealpath = (p) => realpathSync(p);

// FS-only PATH scan — never a subprocess/shell. POSIX → one candidate per dir, checked with
// accessSync(file, X_OK); Windows → bin+ext for each PATHEXT entry. A symlinked binary still passes
// X_OK (access follows symlinks) and is reported at its realpath. ENOENT → keep scanning; any other
// fs error (e.g. EACCES) means we cannot confirm → `unknown`.
export const findOnPath = (bin, deps = {}) => {
  const getenv = deps.getenv ?? process.env;
  const platform = deps.platform ?? process.platform;
  const access = deps.access ?? defaultAccessX;
  const realpath = deps.realpath ?? defaultRealpath;
  const isWin = platform === 'win32';
  const rawPath = (isWin ? getenv.PATH ?? getenv.Path : getenv.PATH) ?? '';
  const dirs = rawPath.split(isWin ? ';' : ':').filter(Boolean);
  const exts = isWin ? (getenv.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  let sawUnknown = false;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      try {
        access(candidate);
        let resolved = candidate;
        try {
          resolved = realpath(candidate);
        } catch {
          // realpath failed (race / broken symlink) — keep the candidate path, still present.
        }
        return { bin, state: PRESENT, path: resolved };
      } catch (err) {
        if (err && err.code === 'ENOENT') continue;
        sawUnknown = true; // EACCES or other → cannot confirm absence
      }
    }
  }
  return { bin, state: sawUnknown ? UNKNOWN : MISSING, path: null };
};

// Wrapped file-existence probe: present (a regular file) | missing (absent or not a file) |
// unknown (a non-ENOENT fs error). Never reads contents.
const probeFile = (file, deps = {}) => {
  const exists = deps.exists ?? existsSync;
  const stat = deps.stat ?? statSync;
  try {
    if (!exists(file)) return MISSING;
    return stat(file).isFile() ? PRESENT : MISSING;
  } catch (err) {
    return err && err.code === 'ENOENT' ? MISSING : UNKNOWN;
  }
};

// "authed?" = existence of the credential-marker file (read-only). NEVER runs the subscription CLI.
// Report wording is "credentials present/missing/unknown", never "authenticated".
export const probeCredential = (entry, deps = {}) => {
  const dir = resolveDir(
    { env: entry.credential.env, default: entry.credential.default },
    deps.getenv ?? process.env,
    deps.home ?? os.homedir(),
  );
  const file = join(dir, entry.credential.file);
  return { state: probeFile(file, deps), path: file };
};

const defaultReadManifest = (skillDir, deps = {}) => {
  const read = deps.readFile ?? readFileSync;
  try {
    return JSON.parse(read(join(skillDir, 'capability.json'), 'utf8'));
  } catch {
    return null;
  }
};

// The bridge's PATH wrapper names = the deduped `roles[].cmd` set (codex's review + execute roles
// are two cmds; antigravity's review + probe roles share one `agy-run`).
const wrapperCmds = (manifest) => {
  const roles = manifest && typeof manifest.roles === 'object' && !Array.isArray(manifest.roles) ? manifest.roles : {};
  const seen = new Set();
  const out = [];
  for (const role of Object.values(roles)) {
    const cmd = role && typeof role.cmd === 'string' ? role.cmd : null;
    if (cmd && !seen.has(cmd)) {
      seen.add(cmd);
      out.push(cmd);
    }
  }
  return out;
};

const computeReadiness = (manifestState, cli, credentials, wrappers) => {
  if (manifestState !== OK) return NEEDS_SKILL;
  if (cli.state !== PRESENT) return NEEDS_CLI;
  if (credentials.state !== PRESENT) return NEEDS_CREDENTIALS;
  if (wrappers.every((w) => w.state === PRESENT)) return READY;
  return DEGRADED;
};

// ── core ─────────────────────────────────────────────────────────────────────

// Detect one backend → the data-model object (manifestState + decoupled readiness signals).
// manifestState precedence: not-installed → (validate) unsupported-schema → invalid-manifest →
// stub (available:false) → foreign (wrong kind/name) → ok.
export const detectBackend = (entry, deps = {}) => {
  const validate = deps.validate ?? validateManifest;
  const getenv = deps.getenv ?? process.env;
  const home = deps.home ?? os.homedir();
  const probeCliFn = deps.probeCli ?? ((bin) => findOnPath(bin, deps));
  const probeWrapperFn =
    deps.probeWrapper ??
    ((cmd) => {
      const r = findOnPath(cmd, deps);
      return { name: cmd, state: r.state };
    });
  const probeCredentialsFn = deps.probeCredentials ?? ((e) => probeCredential(e, deps));
  const readManifest = deps.readManifest ?? ((dir) => defaultReadManifest(dir, deps));

  const resolvedDir = resolveDir({ env: entry.installed.env, default: entry.installed.default }, getenv, home);
  const markerPresent = probeFile(join(resolvedDir, entry.installed.file), deps) === PRESENT;

  let manifestState;
  let manifestReason;
  let isOk = false;
  if (!markerPresent) {
    manifestState = NOT_INSTALLED;
    manifestReason = `bridge skill not installed — ${entry.installed.file} not found in ${resolvedDir}`;
  } else {
    const report = validate(resolvedDir);
    if (report.result === UNSUPPORTED) {
      manifestState = UNSUPPORTED_SCHEMA;
      manifestReason = `manifest schema unsupported — ${report.errors?.[0] ?? 'unknown schema'}`;
    } else if (report.result === INVALID) {
      manifestState = INVALID_MANIFEST;
      manifestReason = `manifest invalid — ${report.errors?.[0] ?? 'failed validation'}`;
    } else if (report.available === false) {
      manifestState = STUB;
      manifestReason = 'manifest declares available:false (stub, not a usable backend)';
    } else if (report.kind !== EXPECTED_KIND || report.name !== entry.name) {
      manifestState = FOREIGN;
      manifestReason = `manifest is ${report.kind ?? '?'}/${report.name ?? '?'}, expected ${EXPECTED_KIND}/${entry.name}`;
    } else {
      manifestState = OK;
      manifestReason = 'bridge skill installed and manifest valid';
      isOk = true;
    }
  }

  const cliProbe = probeCliFn(entry.bin);
  const credentials = probeCredentialsFn(entry);
  const wrappers = isOk ? wrapperCmds(readManifest(resolvedDir)).map(probeWrapperFn) : [];
  const readiness = computeReadiness(manifestState, cliProbe, credentials, wrappers);

  const installed = manifestState !== NOT_INSTALLED;
  const localPresent = installed && probeFile(join(resolvedDir, entry.setupPathLocal), deps) === PRESENT;
  const setupHint = localPresent
    ? { local: entry.setupPathLocal, url: entry.setupUrl }
    : { url: entry.setupUrl };

  return {
    name: entry.name,
    manifestState,
    manifestReason,
    skillDir: installed ? resolvedDir : null,
    cli: { bin: entry.bin, state: cliProbe.state, path: cliProbe.path ?? null },
    credentials: { state: credentials.state, path: credentials.path },
    wrappers,
    readiness,
    setupHint,
  };
};

export const detectBackends = (deps = {}) => KNOWN_BACKENDS.map((entry) => detectBackend(entry, deps));

// ── report ───────────────────────────────────────────────────────────────────

const MARK = { [PRESENT]: '✓', [MISSING]: '✗', [UNKNOWN]: '?' };
const mark = (state) => MARK[state] ?? '?';

const setupTarget = (s) => s.setupHint.local ?? s.setupHint.url;

// Next-step hint per readiness. Deliberately never says "authenticated"/"authed" — only
// "credentials present/missing" (detection is file-presence, not a live login check).
const nextStep = (s) => {
  switch (s.readiness) {
    case READY:
      return null;
    case NEEDS_SKILL:
      return `install the bridge skill — ${setupTarget(s)}`;
    case NEEDS_CLI:
      return `install or locate the "${s.cli.bin}" CLI on PATH`;
    case NEEDS_CREDENTIALS:
      return `set up credentials for "${s.cli.bin}" (marker file ${s.credentials.path} not present)`;
    case DEGRADED:
      return `bridge wrapper(s) not on PATH: ${s.wrappers.filter((w) => w.state !== PRESENT).map((w) => w.name).join(', ')}`;
    default:
      return null;
  }
};

const fmtWrappers = (ws) =>
  ws.length ? `wrappers ${ws.filter((w) => w.state === PRESENT).length}/${ws.length}` : 'wrappers —';

export const formatReport = (statuses) => {
  const lines = ['agent-workflow execution backends (detection only — no subscription CLI is run)', ''];
  for (const s of statuses) {
    lines.push(
      `  ${s.name}  [${s.manifestState}]  ` +
        `cli ${s.cli.bin} ${mark(s.cli.state)}  ` +
        `credentials ${mark(s.credentials.state)}  ` +
        `${fmtWrappers(s.wrappers)}  → ${s.readiness}`,
    );
    const hint = nextStep(s);
    if (hint) lines.push(`      ↳ ${hint}`);
  }
  return lines.join('\n');
};

const main = (_argv, deps = {}) => {
  console.log(formatReport(detectBackends(deps)));
  process.exit(0); // informational, like validate.mjs non-strict — never blocks anything
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main(process.argv.slice(2));
