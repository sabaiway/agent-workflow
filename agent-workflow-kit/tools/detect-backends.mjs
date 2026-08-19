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
import os from 'node:os';
import { isDirectRun } from './direct-run.mjs';
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
          'codex-exec [--nonce <n>] <plan-file|->',
          'codex-exec [--nonce <n>] <plan-file|-> -- <extra codex flags...>',
        ],
        grounding: "automatic — the root AGENTS.md (Hard Constraints) is auto-merged into codex's context and the wrapper prepends the orchestrator execution contract; no grounding flags",
        continue: [
          'codex-exec --resume-last [--nonce <n>] <plan-file|->',
          'codex-exec --resume <session-id> [--nonce <n>] <plan-file|->',
        ],
        receipt: "side effect — a NONCED run mints ONE exec receipt beside the delegation store: the dispatch nonce seam is the AW_DISPATCH_NONCE environment value or its plain-argument equivalent --nonce <n>, recognised ONLY before the prompt operand (after the operand or a literal '--' it is passthrough payload, never a flag), under the safe grammar [A-Za-z0-9._-]{1,64} — anything else, a duplicate, or a flag disagreeing with a non-empty env value refuses PRE-SPEND. The store directory resolves exactly as the kit's delegation store does: the dirname of an ABSOLUTE AW_DELEGATION_STORE (a relative one, or one ending in a path separator, refuses), else the git common dir. The artifact is agent-workflow-exec-receipt-<backendLength>-<backend>-<nonce>.json in two states: 'reserved' is written atomically and NO-CLOBBER immediately before the CLI runs — that write IS the nonce reservation, so a second dispatch on the same nonce, or an already-taken report name, refuses BEFORE any spend — and 'terminal' replaces it in place at exit. A nonced run also refuses pre-spend when no timeout/gtimeout binary can cap it (an accounted dispatch that cannot be capped can never honour the terminal-exit rule; a nonce-LESS run still warns and runs uncapped), when node is missing (the mint core), and when the prompt rides on stdin instead of a contract FILE — contractDigest is computed BY THIS WRAPPER from the dispatch file it was actually handed, so the kit can refuse a run that executed a different contract than the one it opened. That digest is taken from the SAME bytes already read as the prompt, never a second open of the path: two reads leave a window in which the file can be swapped, and the run would then execute one contract while its receipt claimed the digest of another. The header's own nonce must EQUAL the dispatch nonce — 'dispatch open' copies the nonce FROM the header, so a disagreeing --nonce could only reserve an identity no return would ever absorb, and it refuses pre-spend. A contract file edited BETWEEN 'dispatch open' and the run is caught at ABSORB by the contractDigest comparison, not pre-spend: the wrapper never reads the ledger, and that boundary is what the whole lane rests on. At exit the wrapper FIRST re-reads its reservation and verifies its own opaque owner token — a foreign owner refuses having published NOTHING, neither report nor receipt — THEN writes the delegate's final message atomically to agent-workflow-exec-report-<backendLength>-<backend>-<nonce>.txt, THEN re-verifies the owner and REPLACES the reservation with the terminal receipt {schema, kind, state, backend, nonce, owner, contractDigest, wrapperVersion, posture {model, effort, tier}, capS, killGraceS, sessionId, exitStatus, outcome, reportDigest, reportLength, timestamp}: the report is complete on disk before any artifact says the run arrived. capS and killGraceS are the cap the run ACTUALLY applied. outcome is the wrapper's own SUBSET of the ledger's vocabulary — exit 0 with a session id -> success, exit 0 without one -> missing-identity, ANY nonzero exit including the timeout codes 124 and 137 -> transport-failure; every orchestrator judgment is recorded at absorb time, never claimed here. The session id is captured BEFORE outcome branching, so a FAILED run records one too; in resume mode it is the validated resume id. FAIL-CLOSED, deliberately NOT the review lane's warn-only receipt: a publication that cannot complete exits nonzero with a DISTINCT status, and the message states only what the run can still prove. 70: the reservation could not be verified BEFORE any publication — NOTHING was published, not the report and not the receipt, and because the artifact found there belongs to another run it is never a '--no-receipt' source. 71: a publication stopped after that point — either the report write failed (nothing beyond the reservation was published; the '--no-receipt' absorb then records reportLength 0, ineligible by the name empty-report) or the report IS on disk and the terminal receipt was not completed (the absorb reads it, report-if-present). The post-report lane never claims the reservation still stands, because after that point its fate is no longer something this run observed. Every lane names the tree as partial/dirtied rather than untouched. A nonce-LESS invocation is byte-unchanged: no reservation, no receipt, no artifact, no node.",
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
          'every-run nested-sandbox scan (DUAL policy, deliberately two different rules): the scan runs on EVERY completed run, not only a failed one, because a run that SURVIVES the nested-sandbox failure exits 0 with an ungrounded answer and nothing said so. Failed run (rc != 0): the existing loose whole-trace combination rule prints the recovery hint. Successful run (rc == 0): a warning fires ONLY on precise per-item evidence — both a sandbox-mechanism token AND a permission/read-only failure token inside the aggregated_output of ONE command_execution item whose failure is PROVEN (a nonzero exit_code, or the serialized status "failed"); a null exit_code is never failure by itself, tokens split across two items never fire, and a successful command\'s output never fires. The answer is printed FIRST on stdout, then the warning on stderr. HONEST RESIDUAL: the exit status does NOT change on that lane (a distinct nonzero exit would give a heuristic scan DENY polarity, refusing real work whenever the scan over-warns), so an orchestrator keying on exit status alone can still bank an ungrounded answer — the stderr warning is the signal',
        ],
      },
      review: {
        invocations: [
          'codex-review plan <plan-file> [--nonce <n>]',
          'codex-review code [--nonce <n>] [extra focus...]',
        ],
        grounding: 'automatic — the wrapper precomputes the full working-tree change set (repo map, status, diffs, untracked contents) and codex auto-merges the root AGENTS.md; no grounding flags',
        continue: [],
        receipt: 'side effect — a successful review appends one JSON receipt line to <git dir>/agent-workflow-review-receipts.jsonl (AW_REVIEW_RECEIPTS overrides): fingerprint = sha256 over the canonical uncommitted-state payload (staged diff + unstaged diff + untracked-not-ignored contents — the review-payload domain; never-committable untracked paths — character/block devices, FIFOs, sockets — are excluded from the domain entirely, untracked symlinks/directories ride as name-only notes) in code mode, the artifact-file sha256 in plan mode; verdict parsed from the mandated literal verdict line (schema mode: the verdict field); always fresh:true (one-shot) + grounded:true (native AGENTS.md auto-merge, factsHash null); probe = whether the run relaxed the quality guards (CODEX_PROBE=1), written on EVERY receipt so it self-declares — the kit\'s review-state gate rejects a probe-marked receipt (a probe review never attests) and equally rejects an unmarked one (silence is not a declaration); posture = the ACTUAL run posture {model, effort, tier} (tier null on the standard tier), written on EVERY receipt (D5) — the gate rejects a receipt with an absent/invalid posture (a pre-D5 wrapper minted it; re-run the review), one stderr banner line states the same posture, and a posture value carrying control bytes refuses pre-spend in every mode; a run whose final message carries NO recognized \'Verdict: <ship|revise|rethink>\' line — empty or missing output included — exits 4 with NO receipt (D4: a FAILED review to RE-RUN, never a fatal session error); when the dispatch nonce seam is supplied — the AW_REVIEW_NONCE environment value or its plain-argument equivalent --nonce <n> (one seam: the flag assigns the same value; supplying both with different values refuses pre-spend) — under the safe grammar [A-Za-z0-9._-]{1,64} (anything else refuses pre-spend), the wrapper first mints the finding MANIFEST {schema, backend, nonce, fingerprint, findings} beside the receipts file (agent-workflow-finding-manifest-<backend>-<nonce>.json; atomic, no-clobber — a byte-identical rewrite is an idempotent no-op, different bytes refuse loudly) ORDERED before the receipt append — a failed manifest write EXCLUDES the receipt append, so a nonce-supplied dispatch can never land a receipt without its readable manifest; a nonce-less invocation adds NO nonce field and mints NO finding manifest (the existing wrapperVersion field still changes with each bridge release); a write failure warns, never fails the review',
        notes: [
          'the review posture banner appends a banner-only timeout=<duration> field — exactly the duration handed to timeout(1); the hard-timeout preflight fails CLOSED when no timeout/gtimeout binary exists (the wrapper refuses by name before any CLI run, so an uncapped review run can no longer happen), and the field never enters the receipt posture or the D5 banner↔receipt parity',
          'quote the posture banner verbatim when labeling this dispatch — the banner is the machine-stated posture; a prose re-type drifts',
        ],
      },
    },
    bin: 'codex',
    // The per-backend receipt-deadline default (seconds) the capability block reports — the review
    // wrapper's built-in hard cap (CODEX_HARD_TIMEOUT review default), an OFFLINE registry fact.
    deadlineDefaultS: 1800,
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
          'agy-review code [--facts @f] [--ungrounded] [--decided @f] [--focus "…"] [--nonce <n>] [extra focus…]',
          'agy-review plan <plan-file> [--facts @f] [--decided @f] [--focus "…"] [--nonce <n>]',
          'agy-review diff <diff-file> [--facts @f] [--decided @f] [--focus "…"] [--nonce <n>]',
        ],
        grounding: 'grounded review — agy reads NOTHING by default, an ungrounded review GUESSES: --facts @f = the verified facts to review AGAINST; --decided @f = decisions already made, do NOT re-raise (anti-circling). code mode REQUIRES a non-empty --facts payload and refuses BEFORE spending a run (escapes: --ungrounded, AGY_PROBE=1); plan/diff proceed with a loud warning',
        flags: [
          '--facts @f — verified facts the review runs AGAINST (code mode REQUIRES a non-empty payload; plan/diff warn loudly when omitted)',
          '--ungrounded — deliberately ungrounded CODE review, a throwaway opinion (code mode only, contradicts --facts; the receipt records grounded:false and never attests)',
          '--decided @f — already-decided / already-addressed list; do NOT re-raise (anti-circling; the round-2 payload)',
          '--focus "…" — extra focus (repeatable; code mode also takes trailing focus words)',
          '--nonce <n> — the flow dispatch nonce, the plain-argument lane onto the AW_REVIEW_NONCE seam (one seam: flag and a non-empty env must agree; a disagreeing pair refuses pre-spend)',
        ],
        continue: [
          'agy-review --continue [--decided @f] [--focus "…"] [--nonce <n>]',
          'agy-review --conversation <id> [--decided @f] [--focus "…"] [--nonce <n>]',
        ],
        receipt: "side effect — a successful review appends one JSON receipt line to <git dir>/agent-workflow-review-receipts.jsonl (AW_REVIEW_RECEIPTS overrides; plan/diff outside a git tree: warn + skip unless overridden): fingerprint = sha256 over the canonical uncommitted-state payload (staged diff + unstaged diff + untracked-not-ignored contents — the review-payload domain; never-committable untracked paths — character/block devices, FIFOs, sockets — are excluded from the domain entirely, untracked symlinks/directories ride as name-only notes) in code mode, the artifact-file sha256 in plan/diff mode; verdict recorded verbatim from the mandated '### Verdict' section (SHIP / SHIP WITH NITS / REWORK); grounded = whether a NON-EMPTY --facts payload was supplied (code mode refuses pre-spend without one — no run, no receipt — unless --ungrounded/AGY_PROBE=1; in plan/diff an empty payload records grounded:false — fail-closed, the state gate rejects it), factsHash = sha256 of the facts payload; a continuation receipt is fresh:false (informational-only — it cannot attest the folded tree); probe = whether the run relaxed the quality guards (AGY_PROBE=1), written on EVERY receipt so it self-declares — the kit's review-state gate rejects a probe-marked receipt (a probe review never attests) and equally rejects an unmarked one (silence is not a declaration); posture = the ACTUAL run posture {model} (agy has no tier), written on EVERY receipt (D5) — the gate rejects a receipt with an absent/invalid posture (a pre-D5 wrapper minted it; re-run the review), one stderr banner line states the same posture, an ATTESTING review with AGY_MODEL explicitly emptied refuses pre-spend, and a model string carrying control bytes refuses pre-spend in every mode; delivery = how the change set REACHED the model, currently emitted as 'inline' (the whole set rode one prompt — proven by construction) or 'fed' (a chunked feed whose per-part echo proof verified); REQUIRED on every agy code receipt and its ABSENCE is what stops a pre-fed-lane receipt attesting, while the gate accepts any well-formed declaration rather than a particular value; absent by construction on plan/diff/continuation receipts, which carry no change set; a run whose output carries NO recognized '### Verdict' section — empty output included — exits 4 with NO receipt (D4: a FAILED review to RE-RUN, never a fatal session error); when the dispatch nonce seam is supplied — the AW_REVIEW_NONCE environment value or its plain-argument equivalent --nonce <n> (one seam: the flag assigns the same value; supplying both with different values refuses pre-spend) — under the safe grammar [A-Za-z0-9._-]{1,64} (anything else refuses pre-spend), the wrapper first mints the finding MANIFEST {schema, backend, nonce, fingerprint, findings} beside the receipts file (agent-workflow-finding-manifest-<backend>-<nonce>.json; atomic, no-clobber — a byte-identical rewrite is an idempotent no-op, different bytes refuse loudly) ORDERED before the receipt append — a failed manifest write EXCLUDES the receipt append, so a nonce-supplied dispatch can never land a receipt without its readable manifest; a nonce-less invocation adds NO nonce field and mints NO finding manifest (the existing wrapperVersion field still changes with each bridge release); a write failure warns, never fails the review",
        notes: [
          'transport: every review dispatch drives the CLI in --output-format json (plus --disable-slash-commands) and the returned envelope is parsed in node (bin/agy-envelope.mjs) — the operator-facing invocations and flags above do NOT change, and on a ZERO exit the wrapper still PRINTS the review text, never JSON. A missing or unreadable envelope on a zero exit is a loud failure with NO receipt, never a downgraded verdict and never a fallback to raw-stdout parsing; a non-zero CLI exit keeps its own code and message, and publishes the captured stdout unchanged from the SINGLE dispatch or the FINAL fed turn (which may therefore be a JSON or partial payload — the envelope is parsed only on a zero exit); an INTERMEDIATE feed turn is the exception, its output stays private (Invariant E) and its failure prints only a named error. Enforced by a PRE-SPEND capability probe, not a version floor: agy --help must advertise --output-format and --disable-slash-commands, node must be >= 22, and bin/agy-envelope.mjs must be present — otherwise the review refuses before any run is spent and names the missing capability',
          'pre-dispatch host-diff: before the FIRST dispatch of this bridge, diff its declared networkHosts against the live sandbox allow-list — a missing host is surfaced to the maintainer BEFORE dispatching, never fired into a known prompt',
          'the review posture banner appends a banner-only timeout=<duration> field — exactly the duration agy-run hands to timeout(1); the hard-timeout preflight fails CLOSED when no timeout/gtimeout binary exists (the wrapper refuses by name before any CLI run, so an uncapped review run can no longer happen), and the field never enters the receipt posture or the D5 banner↔receipt parity',
          'quote the posture banner verbatim when labeling this dispatch — the banner is the machine-stated posture; a prose re-type drifts',
        ],
      },
    },
    bin: 'agy',
    // AGY_HARD_TIMEOUT's built-in review default is 30m — reported in seconds, an OFFLINE registry fact.
    deadlineDefaultS: 1800,
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

// The declared per-backend CAPABILITY block (flow-orchestration #15): roles, review-contract
// presence, and the receipt-deadline default — sourced OFFLINE from the registry alone. PURE over
// KNOWN_BACKENDS: no fs probe, no spawn, and never a live subscription CLI run (the detector as a
// whole spawns nothing — a source-level pin holds that).
export const backendCapability = (backendName) => {
  const entry = KNOWN_BACKENDS.find((b) => b.name === backendName);
  if (entry === undefined) return null;
  return {
    roles: Object.keys(entry.roleCmds ?? {}),
    reviewContract: (entry.roleContracts?.review ?? null) !== null,
    deadlineDefaultS: entry.deadlineDefaultS,
  };
};

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
    capability: backendCapability(entry.name),
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

if (isDirectRun(import.meta.url)) main(process.argv.slice(2));
