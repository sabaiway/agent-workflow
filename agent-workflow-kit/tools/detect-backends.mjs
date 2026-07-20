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
// Pure, dependency-injectable (fs/env/validator are deps), dependency-free, Node >= 22. Every fs
// probe is wrapped → an explicit `unknown` + reason, never a throw and never a nameless failure.

import { existsSync, statSync, accessSync, realpathSync, constants } from 'node:fs';
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

// readiness values. Exported so the recipe planner (tools/recipes.mjs) maps backend availability off
// the SAME consts the detector emits — no magic readiness literals duplicated across the two modules.
export const READY = 'ready';
export const NEEDS_SKILL = 'needs-skill';
export const NEEDS_CLI = 'needs-cli';
export const NEEDS_CREDENTIALS = 'needs-credentials';
export const DEGRADED = 'degraded';

const EXPECTED_KIND = 'execution-backend';

// The kit-owned registry: the per-backend facts the detector needs even when a bridge is NOT
// installed (no manifest on disk to read). Kept in lockstep with the in-repo manifests by the
// drift-guard test. `credential.env: null` → no env override exists (do not invent one).
// `roleCmds` is the role-keyed source of truth (role → the PATH wrapper cmd), mirroring each bridge
// manifest `roles[role].cmd`, drift-guarded. Two derivations ride on it, both drift-guarded against the
// manifests: `wrapperCmds` (the deduped set the readiness probe checks — a stale install missing one
// surfaces DEGRADED) and `wrapperCmdFor(backend, role)` (which concrete wrapper the backend-set aid prints).
const RAW_BACKENDS = [
  {
    name: 'codex-cli-bridge',
    installed: { env: 'CODEX_CLI_BRIDGE_DIR', default: '~/.claude/skills/codex-cli-bridge', file: 'SKILL.md' },
    roleCmds: { execute: 'codex-exec', review: 'codex-review' },
    // The per-role DRIVING CONTRACT (exact invocation descriptors + grounding + round-2 continue),
    // mirroring the bridge manifest roles[role].contract byte-for-byte — drift-guarded like roleCmds.
    // Scope = dispatchable recipe roles ONLY (review, execute): the probe role is never dispatched by
    // an activity slot, so it carries NO contract here (wrapperContractFor(_, 'probe') → null).
    roleContracts: {
      execute: {
        invocations: [
          'codex-exec <plan-file|->',
          'codex-exec <plan-file|-> -- <extra codex flags...>',
        ],
        grounding: "automatic — the root AGENTS.md (Hard Constraints) is auto-merged into codex's context and the wrapper prepends the orchestrator execution contract; no grounding flags",
        continue: [
          'codex-exec --resume-last <plan-file|->',
          'codex-exec --resume <session-id> <plan-file|->',
        ],
        passthrough: {
          policy: 'guarded',
          blocked: ['-c*', '--config*', '-s*', '--sandbox*', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--full-auto', '--oss', '--local-provider*', '-p*', '--profile*', '-m*', '--model*', '-o*', '--output-last-message*', '--json*', '--color*', '--output-schema*', '--ephemeral*'],
          probeRelaxed: ['--add-dir*', '-C*', '--cd*', '--skip-git-repo-check', '--ignore-rules', '--enable*', '--disable*'],
        },
        notes: [
          'nested-sandbox limit: codex-exec ships its OWN OS sandbox (bwrap workspace-write) and cannot run nested inside a harness sandbox (the FS turns read-only) — route it OUTSIDE the harness sandbox (excludedCommands / a per-run consented bypass) on the OBSERVED bwrap/EPERM failure, never a preemptive blanket',
          'exec posture banner: ONE stderr line before dispatch states the ACTUAL run posture — exec posture: model=… effort=… tier=… sandbox=workspace-write session=fresh|resume:<id> timeout=… — from RESOLVED post-validation values; the resume id is validated pre-spend, and control bytes in any banner field refuse pre-spend',
          'threat model: the sidecar byte and grammar screens detect corrupted input under a trusted parent environment. A hostile parent environment — including exported shell functions or PATH substitution of core/backend commands — is outside the threat model and can substitute the backend itself. Targeted shadow-proof resolution protects banner/dispatch honesty from accidental shadowing; it is not an environment security boundary',
          'the exec posture banner appends a banner-only timeout=<duration|uncapped> field — exactly the duration handed to timeout(1), uncapped when no timeout/gtimeout binary caps the run; INFORMATIONAL only: it is never persisted in a receipt or session sidecar',
          'quote the posture banner verbatim when labeling this dispatch — the banner is the machine-stated posture; a prose re-type drifts',
        ],
      },
      review: {
        invocations: [
          'codex-review plan <plan-file>',
          'codex-review code [extra focus...]',
        ],
        grounding: 'automatic — the wrapper precomputes the full working-tree change set (repo map, status, diffs, untracked contents) and codex auto-merges the root AGENTS.md; no grounding flags',
        continue: [],
        receipt: 'side effect — a successful review appends one JSON receipt line to <git dir>/agent-workflow-review-receipts.jsonl (AW_REVIEW_RECEIPTS overrides): fingerprint = sha256 over the canonical uncommitted-state payload (staged diff + unstaged diff + untracked-not-ignored contents — the review-payload domain; never-committable untracked paths — character/block devices, FIFOs, sockets — are excluded from the domain entirely, untracked symlinks/directories ride as name-only notes) in code mode, the artifact-file sha256 in plan mode; verdict parsed from the mandated literal verdict line (schema mode: the verdict field); always fresh:true (one-shot) + grounded:true (native AGENTS.md auto-merge, factsHash null); probe = whether the run relaxed the quality guards (CODEX_PROBE=1), written on EVERY receipt so it self-declares — the kit\'s review-state gate rejects a probe-marked receipt (a probe review never attests) and equally rejects an unmarked one (silence is not a declaration); posture = the ACTUAL run posture {model, effort, tier} (tier null on the standard tier), written on EVERY receipt (D5) — the gate rejects a receipt with an absent/invalid posture (a pre-D5 wrapper minted it; re-run the review), one stderr banner line states the same posture, and a posture value carrying control bytes refuses pre-spend in every mode; a run whose final message carries NO recognized \'Verdict: <ship|revise|rethink>\' line — empty or missing output included — exits 4 with NO receipt (D4: a FAILED review to RE-RUN, never a fatal session error); a write failure warns, never fails the review',
        notes: [
          'the review posture banner appends a banner-only timeout=<duration|uncapped> field — exactly the duration handed to timeout(1), uncapped when no timeout/gtimeout binary caps the run; INFORMATIONAL only: it never enters the receipt posture or the D5 banner↔receipt parity',
          'quote the posture banner verbatim when labeling this dispatch — the banner is the machine-stated posture; a prose re-type drifts',
        ],
      },
    },
    bin: 'codex',
    credential: { env: 'CODEX_HOME', default: '~/.codex', file: 'auth.json' },
    setupUrl: 'https://github.com/sabaiway/agent-workflow/blob/main/codex-cli-bridge/setup/README.md',
    setupPathLocal: 'setup/README.md',
    // The short canonical guided commands. Binary-install is platform-variant and longer, so it is
    // REFERENCED via setupRef (§1 of that README), never duplicated here (would drift with the README).
    guide: { setupRef: 'codex-cli-bridge/setup/README.md', loginCmd: 'codex login', verifyCmd: 'codex login status' },
  },
  {
    name: 'antigravity-cli-bridge',
    installed: { env: 'ANTIGRAVITY_CLI_BRIDGE_DIR', default: '~/.claude/skills/antigravity-cli-bridge', file: 'SKILL.md' },
    roleCmds: { review: 'agy-review', probe: 'agy-run' },
    // Mirror of the manifest roles.review.contract (see the codex entry note). probe: NO contract.
    roleContracts: {
      review: {
        invocations: [
          'agy-review code [--facts @f] [--ungrounded] [--decided @f] [--focus "…"] [extra focus…]',
          'agy-review plan <plan-file> [--facts @f] [--decided @f] [--focus "…"]',
          'agy-review diff <diff-file> [--facts @f] [--decided @f] [--focus "…"]',
        ],
        grounding: 'grounded review — agy reads NOTHING by default, an ungrounded review GUESSES: --facts @f = the verified facts to review AGAINST; --decided @f = decisions already made, do NOT re-raise (anti-circling). code mode REQUIRES a non-empty --facts payload and refuses BEFORE spending a run (escapes: --ungrounded, AGY_PROBE=1); plan/diff proceed with a loud warning',
        flags: [
          '--facts @f — verified facts the review runs AGAINST (code mode REQUIRES a non-empty payload; plan/diff warn loudly when omitted)',
          '--ungrounded — deliberately ungrounded CODE review, a throwaway opinion (code mode only, contradicts --facts; the receipt records grounded:false and never attests)',
          '--decided @f — already-decided / already-addressed list; do NOT re-raise (anti-circling; the round-2 payload)',
          '--focus "…" — extra focus (repeatable; code mode also takes trailing focus words)',
        ],
        continue: [
          'agy-review --continue [--decided @f] [--focus "…"]',
          'agy-review --conversation <id> [--decided @f] [--focus "…"]',
        ],
        receipt: "side effect — a successful review appends one JSON receipt line to <git dir>/agent-workflow-review-receipts.jsonl (AW_REVIEW_RECEIPTS overrides; plan/diff outside a git tree: warn + skip unless overridden): fingerprint = sha256 over the canonical uncommitted-state payload (staged diff + unstaged diff + untracked-not-ignored contents — the review-payload domain; never-committable untracked paths — character/block devices, FIFOs, sockets — are excluded from the domain entirely, untracked symlinks/directories ride as name-only notes) in code mode, the artifact-file sha256 in plan/diff mode; verdict recorded verbatim from the mandated '### Verdict' section (SHIP / SHIP WITH NITS / REWORK); grounded = whether a NON-EMPTY --facts payload was supplied (code mode refuses pre-spend without one — no run, no receipt — unless --ungrounded/AGY_PROBE=1; in plan/diff an empty payload records grounded:false — fail-closed, the state gate rejects it), factsHash = sha256 of the facts payload; a continuation receipt is fresh:false (informational-only — it cannot attest the folded tree); probe = whether the run relaxed the quality guards (AGY_PROBE=1), written on EVERY receipt so it self-declares — the kit's review-state gate rejects a probe-marked receipt (a probe review never attests) and equally rejects an unmarked one (silence is not a declaration); posture = the ACTUAL run posture {model} (agy has no tier), written on EVERY receipt (D5) — the gate rejects a receipt with an absent/invalid posture (a pre-D5 wrapper minted it; re-run the review), one stderr banner line states the same posture, an ATTESTING review with AGY_MODEL explicitly emptied refuses pre-spend, and a model string carrying control bytes refuses pre-spend in every mode; a run whose output carries NO recognized '### Verdict' section — empty output included — exits 4 with NO receipt (D4: a FAILED review to RE-RUN, never a fatal session error); a write failure warns, never fails the review",
        notes: [
          'pre-dispatch host-diff: before the FIRST dispatch of this bridge, diff its declared networkHosts against the live sandbox allow-list — a missing host is surfaced to the maintainer BEFORE dispatching, never fired into a known prompt',
          'the review posture banner appends a banner-only timeout=<duration|uncapped> field — exactly the duration agy-run hands to timeout(1), uncapped when no timeout/gtimeout binary caps the run; INFORMATIONAL only: it never enters the receipt posture or the D5 banner↔receipt parity',
          'quote the posture banner verbatim when labeling this dispatch — the banner is the machine-stated posture; a prose re-type drifts',
        ],
      },
    },
    bin: 'agy',
    credential: { env: null, default: '~/.gemini/antigravity-cli', file: 'antigravity-oauth-token' },
    setupUrl: 'https://github.com/sabaiway/agent-workflow/blob/main/antigravity-cli-bridge/setup/README.md',
    setupPathLocal: 'setup/README.md',
    guide: { setupRef: 'antigravity-cli-bridge/setup/README.md', loginCmd: 'agy', verifyCmd: 'echo "say OK" | agy-run -' },
  },
];

// The deduped roles[].cmd set the CURRENT kit bundles, derived from roleCmds in first-seen order — one
// source, so the readiness-probe list can never drift from the role-keyed map.
const wrapperCmdsFromRoles = (roleCmds) => [...new Set(Object.values(roleCmds ?? {}))];
export const KNOWN_BACKENDS = RAW_BACKENDS.map((entry) => ({ ...entry, wrapperCmds: wrapperCmdsFromRoles(entry.roleCmds) }));

// Resolve a dispatched (backend manifest name, role) to its concrete PATH wrapper cmd (e.g.
// codex-cli-bridge + review → "codex-review") from the role-keyed registry — the backend-set aid
// consumes this to print WHICH wrapper each dispatched backend runs. `null` when the pair is unknown.
export const wrapperCmdFor = (backendName, role) =>
  KNOWN_BACKENDS.find((b) => b.name === backendName)?.roleCmds?.[role] ?? null;

// Resolve a dispatched (backend, role) to its structured DRIVING CONTRACT — the registry mirror of
// the bridge manifest roles[role].contract: exact invocation descriptor(s), the grounding note, the
// closed flag set (when the wrapper's grammar is closed), the round-2/continue descriptor(s), and
// the guarded passthrough tiers (codex-exec). The point-of-use advisor (procedures.mjs) renders this
// VERBATIM so a driving agent never re-derives the contract from wrapper source. `null` when the
// pair is unknown or the role carries no contract (probe — never dispatched by an activity slot).
export const wrapperContractFor = (backendName, role) =>
  KNOWN_BACKENDS.find((b) => b.name === backendName)?.roleContracts?.[role] ?? null;

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
  // Probe the EXPECTED wrapper set the kit bundles (entry.wrapperCmds), NOT the installed manifest's
  // roles — so a STALE install missing a newer wrapper (e.g. agy-review on a v1.0.0 antigravity) is
  // reported DEGRADED rather than a false "ready N/N". Keeps detectBackend pure (reads only its args).
  const wrappers = isOk ? (entry.wrapperCmds ?? []).map(probeWrapperFn) : [];
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

// ── guidance (axis-aware, for the `setup` flow) ───────────────────────────────

const registryEntry = (name) => KNOWN_BACKENDS.find((b) => b.name === name);

// The skill axis can't be auto-fixed in every state: an absent dir IS placeable from the bundled
// kit; any other non-ok state (stub/foreign/invalid/unsupported, or an `unknown` marker fs error)
// is a STOP — never overwrite a dir we don't provably own.
const skillHint = (status, guide) =>
  status.manifestState === NOT_INSTALLED
    ? `place the bundled bridge skill — run \`/agent-workflow-kit setup ${status.name}\``
    : `bridge skill dir is "${status.manifestState}" — STOP and inspect ${status.skillDir ?? 'the skill dir'} (see ${guide?.setupRef ?? status.setupHint?.url})`;

// guideFor inspects the manifest/cli/credentials axes INDEPENDENTLY (never the collapsed readiness)
// and returns an ORDERED list of the manual steps still owed — possibly several at once (e.g. a
// fresh machine needs both the CLI and a login). `[]` ⇒ nothing manual left (the linker handles the
// wrappers). Each step is `{ need: 'skill'|'cli'|'credentials', hint }`. Pure; no fs, no side effects.
export const guideFor = (status) => {
  const guide = registryEntry(status.name)?.guide;
  const out = [];
  if (status.manifestState !== OK) out.push({ need: 'skill', hint: skillHint(status, guide) });
  if (status.cli.state !== PRESENT) {
    out.push({ need: 'cli', hint: `install the "${status.cli.bin}" CLI — see ${guide?.setupRef ?? status.setupHint?.url} §1` });
  }
  if (status.credentials.state !== PRESENT) {
    out.push({
      need: 'credentials',
      hint: `sign in once (subscription): ${guide?.loginCmd ?? 'see the setup README'}  (verify: ${guide?.verifyCmd ?? 'see the setup README'})`,
    });
  }
  return out;
};

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
