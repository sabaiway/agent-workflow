#!/usr/bin/env node
// gates-init.mjs — the consented docs/ai/gates.json FILL preview (D9; the pure derivation carried
// from the retired standalone seeder, AD-042/AD-052 invariants intact). Reached ONLY through
// explicitly-consenting prose (the init/bootstrap flows and the gates.md consent-fill section) —
// it is NOT a routable mode token, it sits OUTSIDE every velocity allowlist tier (a
// consent-per-run writer is never pre-approved), and the shipped gates.json TEMPLATE stays EMPTY
// (AD-021/AD-038): a populated declaration is per-entry maintainer consent recorded through this
// preview, never auto-seeding. ONE lifecycle contract: this preview runs at INIT; at UPGRADE the
// only gates.json writer is the consented legacy migration.
//
// What it offers (the derivation invariants, test-pinned) — CLOSED-WORLD since AD-052: an entry
// is offered only when every axis is proven safe by MEMBERSHIP in a finite, test-guarded set,
// never by absence from a blocklist (Issue-011 killed the blocklist model — one more gap per
// review round, unprovable):
//   • sources: discoverGateCandidates over package.json scripts (velocity-profile.mjs stays
//     read-only; THIS module owns the offer mapping) + the conditional review-state candidate;
//   • NAME screens shape WHICH entries are offered: warn-flagged candidates (release/publish/
//     deploy/push/version/commit/tag, pre*/post*) never enter; only terminating verification
//     class NAMES (test / lint / type-check / build) pass, never dev/start/watch/serve/preview,
//     never a mutating-variant name; a shell-unsafe name is screened first;
//   • the BODY must be a string member of the literal BODY_ALLOWLIST after a pinned ASCII-only
//     normalization — anything else is screened out with a LOUD note (never silently absent);
//   • the cmd is the per-PM HOOK-FREE form `COREPACK_ENABLE_NETWORK=0 <pm> exec -- <allowlisted-body>`
//     (packageManager field, else lockfile probe, else npm): `exec` runs a command, not a named
//     script, so the pre/post lifecycle-hook class dies structurally on npm/pnpm/yarn alike, and
//     the Corepack env prefix blocks a hostile packageManager pin from fetching the PM binary; a
//     family with no verified fail-closed exec contract is WITHHELD with a loud note. NEVER
//     `<pm> run <name>` — that re-exposes hooks and lets a later package.json edit change a
//     byte-exact-approved gate;
//   • the safety claim is scoped to the OFFER DERIVATION, not a runtime sandbox: a gate still
//     executes project-controlled tooling (a node_modules/.bin PATH shim intercepts under every
//     form) — the documented residual, disclosed in the preview, bounded by the two consents;
//   • ids derive kebab-case from script names (build:prod → build-prod) and every offered entry
//     passes the runner's validateDeclaration (this module imports the validator — NEVER the
//     reverse: run-gates.mjs stays a runner that writes nothing);
//   • the review-state candidate appears ONLY when docs/ai/orchestration.json DECLARES
//     reviewed/council on plan-execution.review — the slot the checker enforces — with the
//     resolved, QUOTED tool path (spaces survive; executes from the project root).
//
// Write discipline: preview (dry-run) is the DEFAULT and writes NOTHING — a declined offer leaves
// the file byte-identical. `--apply` appends EXACTLY the consented entries (`--only <id>`
// repeatable) through the shared atomic-write core (tools/atomic-write.mjs — exclusive-create
// tmp+rename, TOCTOU re-check, symlink STOPs): append-only, never modifies or removes an existing
// entry, refuses id collisions, refuses a malformed declaration (never writes over what it cannot
// parse). Deployment-gated: docs/ai presence (lstat, no-follow) on EVERY run; the
// .workflow-version == lineage-head stamp gate on --apply only (the velocity/gate-hook precedent).
//
// Exit codes: 0 done / dry-run; 1 precondition STOP (no deployment, stamp, symlink, malformed
// declaration, id collision); 2 usage. Dependency-free, Node >= 22. No side effects on import.

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverGateCandidates, EXPECTED_WORKFLOW_VERSION } from './velocity-profile.mjs';
import { GATES_REL, validateDeclaration } from './run-gates.mjs';
import { loadConfig } from './orchestration-config.mjs';
import { assertDocsAiDeployment, writeDocsAiFileAtomic, lstatNoFollow } from './atomic-write.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = resolve(HERE, '..');
const TEMPLATE_PATH = join(KIT_ROOT, 'references', 'templates', 'gates.json');
const REVIEW_STATE_TOOL = join(KIT_ROOT, 'tools', 'review-state.mjs');
const COVERAGE_CHECK_TOOL = join(KIT_ROOT, 'tools', 'coverage-check.mjs');
const STAMP_REL = join('docs', 'ai', '.workflow-version');

const EXIT_OK = 0;
const EXIT_PRECONDITION = 1;
const EXIT_USAGE = 2;

export const GATES_INIT_STOP = 'GATES_INIT_STOP';
const stop = (message) =>
  Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'GatesInitStop', code: GATES_INIT_STOP, exitCode: EXIT_PRECONDITION });
const usageFail = (message) =>
  Object.assign(new Error(`[agent-workflow-kit] ${message}`), { exitCode: EXIT_USAGE });

// The trust-chain disclosure (AD-042) — printed with EVERY preview, token-pinned by the tests: a
// consent-seeded command becomes auto-approvable only after TWO explicit consents.
export const TRUST_CHAIN_DISCLOSURE =
  'Disclosure: gates.json is a PRIVILEGED file — once the optional approval hook is wired ' +
  '(/agent-workflow-kit hook), it auto-approves byte-exact declared gate commands from the ' +
  'project root — filling (this consent) and hook wiring (its own consent) are two separate ' +
  'yeses. A script gate runs the project\'s own tooling, which executes project-controlled code ' +
  '(this preview does not sandbox it; the two consents bound it).';

const USAGE = `usage: gates-init [--dry-run | --apply] [--only <id>]... [--cwd <dir>] [--help]

The consented FILL preview for the project's own docs/ai/gates.json (D9). Default is --dry-run:
prints the derived { id, title, cmd } entries and writes NOTHING. --apply APPENDS exactly the
consented entries (--only <id> selects a subset; append-only — existing entries are never
modified or removed, an id collision is refused). The offer is CLOSED-WORLD: only a
terminating-class script name (test / lint / type-check / build — never release/publish/deploy,
never watch/serve, never a write-mode variant) whose BODY is a member of the literal runner
allowlist is offered, as the hook-free \`COREPACK_ENABLE_NETWORK=0 <pm> exec -- <body>\` form for
the detected package manager. A gate-class script whose body is NOT in the allowlist is screened
out with a note naming it (a command you trust can still be declared by hand); non-gate-class
names are excluded silently, as always.
${TRUST_CHAIN_DISCLOSURE}`;

// ── candidate classification: the NAME screens (the LOCKED derivation invariants) ──────
// NAME screens shape WHICH safe entries are offered; the danger axis (the BODY) is closed-world
// below (AD-052). The derived cmd is bash-interpolated by the gate runner and can become
// hook-auto-approvable, so only shell-SAFE script names ever enter the offer: a name carrying
// whitespace or any shell metacharacter (`test:ci && echo pwn`) is screened out entirely.
const SAFE_SCRIPT_NAME_PATTERN = /^[A-Za-z0-9:_.-]+$/;
const TERMINATING_CLASS_PATTERN = /^(test|lint|type-?check|types|tsc|build)([:._-]|$)/i;
// Non-terminating NAME screening is TOKEN-set based, position-independent (never an anchored
// regex — the anchored form missed `build:preview`): a non-terminating token in ANY name segment
// disqualifies; `watch` disqualifies as a substring anywhere (watchAll). Conservative on purpose —
// a screened-out script can still be declared by hand.
const NON_TERMINATING_TOKENS = new Set(['dev', 'start', 'serve', 'watch', 'preview']);
const WATCH_ANYWHERE_PATTERN = /watch/i;
const wordOf = (raw) => raw.toLowerCase().replace(/^-+/, '').split('=')[0];
const hasTokenIn = (text, splitter, tokens) =>
  String(text)
    .split(splitter)
    .some((part) => tokens.has(wordOf(part)));
const isNonTerminatingName = (name) =>
  hasTokenIn(name, /[:._-]/, NON_TERMINATING_TOKENS) || WATCH_ANYWHERE_PATTERN.test(name);
// A MUTATING VARIANT NAME of a terminating class never enters the offer (lint:fix, test:update,
// build:write, test:snapshot) — a hook-auto-approvable gate must never be a writer. Write-mode
// BODIES need no screen: the closed-world allowlist simply has no write-mode member.
const MUTATING_VARIANT_NAME_PATTERN = /(^|[:._-])(fix|write|update|snapshot)([:._-]|$)/i;

// ── the CLOSED-WORLD body contract (AD-052 — the Issue-011 structural fix) ─────────────
// The body axis is ALLOWLIST MEMBERSHIP, never blocklist screening. The failure direction flips
// by construction: worst case = a legit command not offered (mild, add-by-hand) — never a
// dangerous one offered. Extension contract (edit-safety): adding an entry = adding the literal
// here + classifying its stem in the partition below + its own test case; the self-safety test
// pins every entry against shell metacharacters, write-mode flags, and unrecognized runner stems.
// Deliberately EXCLUDED: `tsc -p .` without --noEmit — it EMITS compiled .js into the tree by
// default, a write side-effect a verification gate must not have.
export const BODY_ALLOWLIST = Object.freeze([
  'node --test',
  'vitest run',
  'jest',
  'jest --ci',
  'eslint .',
  'prettier --check .',
  'tsc --noEmit',
  'tsc -p . --noEmit',
  'vite build',
]);
// The FIXED executable-source partition of the allowlist stems (test-pinned, never a runtime
// probe): a host-runtime stem (`node`) is always on PATH and never a node_modules package — no
// local-bin resolution applies to it; a package-runner stem resolves from the project's own
// node_modules (or Berry .pnp.cjs) via `<pm> exec`, under the per-PM no-network-fetch rule below.
export const HOST_RUNTIME_STEMS = Object.freeze(['node']);
export const PACKAGE_RUNNER_STEMS = Object.freeze(['vitest', 'jest', 'eslint', 'prettier', 'tsc', 'vite']);

// Decision-3 order, test-pinned: (1) string-typed, else not offered; (2) reject ANY char outside
// printable ASCII + space/tab BEFORE trimming — String.trim() strips \n/NBSP/BOM at the EDGES and
// would mask a leading/trailing forbidden char; (3) trim + collapse ASCII space/tab runs to one
// space; (4) literal membership. No case folding, no arg reordering, no separate env/path reject
// axis — `FOO=bar node --test` and `./scripts/x.sh` are already rejected by NON-MEMBERSHIP.
const PRINTABLE_ASCII_BODY_PATTERN = /^[\x20-\x7E\t]*$/;
const allowlistedBodyOf = (body) => {
  if (typeof body !== 'string') return null;
  if (!PRINTABLE_ASCII_BODY_PATTERN.test(body)) return null;
  const normalized = body.replace(/^[ \t]+|[ \t]+$/g, '').replace(/[ \t]+/g, ' ');
  return BODY_ALLOWLIST.includes(normalized) ? normalized : null;
};

// The per-PM HOOK-FREE exec form (Decision 1, host-proven npm 12 / pnpm 10 / yarn 1 + berry 4):
// `exec` runs a COMMAND, not a named script — no pre/post lifecycle exists to fire, uniformly.
// The `--` keeps a body flag (`jest --ci`) from being absorbed by the PM. Per-PM hardening — the
// pinned invariant is NO NETWORK FETCH of an absent runner, not "no user-machine fallback":
//   npm  — `--script-shell /bin/sh` beats a hostile per-project `.npmrc script-shell` (proven the
//          flag wins) and `--offline` refuses an absent runner as a cache miss, never a registry
//          fetch; a hit on a previously-installed real package (the npm cache OR the host's
//          global tree — both user machine state, not project content) is the documented runtime
//          residual (Decision 2 ii / 6), not a separate guard.
//   pnpm — no network fetch; an absent runner fails closed when no project-local or
//          PATH-resolvable runner exists (a user-installed one executing is the same
//          user-machine-state residual). Reads no npm `.npmrc script-shell`.
//   yarn — same contract, uniform for classic + berry (berry resolves via .pnp.cjs; proven).
// The `COREPACK_ENABLE_NETWORK=0` prefix closes ONE more attacker-reachable fetch axis: when the
// PM binary is a Corepack shim, a hostile `packageManager: "<pm>@<uncached-version>"` field makes
// Corepack DOWNLOAD that PM release from the registry BEFORE exec even resolves the runner. The env
// var disables that provisioning (proven: it fails closed "Network access disabled" on an uncached
// pin, and is inert when the PM is a real install or already provisioned) — so the no-network
// contract holds for the PM-provision step too, not just the runner. Applies to all three (Corepack
// can shim npm/pnpm/yarn alike). An UNKNOWN family has no verified fail-closed exec contract → cmd
// null (withheld, loud note) — the mild worst case, never a hole. detectPackageManager can only
// yield npm/pnpm/yarn today (bun collapses to npm — characterized), so this is the builder floor.
const COREPACK_NO_NETWORK = 'COREPACK_ENABLE_NETWORK=0';
export const execCmdFor = (pm, body) => {
  if (pm === 'npm') return { cmd: `${COREPACK_NO_NETWORK} npm exec --offline --script-shell /bin/sh -- ${body}`, note: null };
  if (pm === 'pnpm') return { cmd: `${COREPACK_NO_NETWORK} pnpm exec -- ${body}`, note: null };
  if (pm === 'yarn') return { cmd: `${COREPACK_NO_NETWORK} yarn exec -- ${body}`, note: null };
  return {
    cmd: null,
    note: `no fail-closed exec form is verified for this package manager (${pm}) — add the gate by hand`,
  };
};

export const kebabIdOf = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// package manager: the package.json `packageManager` field wins, else the lockfile probe, else npm.
export const detectPackageManager = (cwd, deps = {}) => {
  const read = deps.readFile ?? readFileSync;
  const exists = deps.exists ?? existsSync;
  const fromField = (() => {
    try {
      const pkg = JSON.parse(String(read(join(cwd, 'package.json'), 'utf8')));
      const pm = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null;
      return pm === 'pnpm' || pm === 'yarn' || pm === 'npm' ? pm : null;
    } catch {
      return null;
    }
  })();
  if (fromField) return fromField;
  if (exists(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (exists(join(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm';
};

// The script-derived offer: entries + loud honesty notes (a gate-class script screened out on its
// body, or a whole family withheld, is COUNTED and NAMED — never silently absent). Order =
// package.json scripts order (the offer the user reads). `deps.packageManager` injects a family
// token past the detector for the builder-boundary fail-closed proof (T4b).
const deriveScripts = (cwd, deps = {}) => {
  const read = deps.readFile ?? readFileSync;
  const pkg = (() => {
    try {
      return JSON.parse(String(read(join(cwd, 'package.json'), 'utf8')));
    } catch {
      return null; // no/unreadable package.json → no script candidates (an honest empty offer)
    }
  })();
  const pm = deps.packageManager ?? detectPackageManager(cwd, deps);
  const named = discoverGateCandidates(pkg ?? {})
    .filter((c) => !c.warn) // warn-flagged NEVER enter the offer
    .filter((c) => SAFE_SCRIPT_NAME_PATTERN.test(c.scriptName)) // shell-safe names only, FIRST
    .filter((c) => TERMINATING_CLASS_PATTERN.test(c.scriptName))
    .filter((c) => !isNonTerminatingName(c.scriptName))
    .filter((c) => !MUTATING_VARIANT_NAME_PATTERN.test(c.scriptName));
  const seen = new Set(); // first occurrence of a derived id wins, whatever its outcome (conservative)
  const entries = [];
  const screenedIds = [];
  const withheld = [];
  for (const c of named) {
    const id = kebabIdOf(c.scriptName);
    if (!id || seen.has(id)) continue; // an empty or duplicate derived id never enters the offer
    seen.add(id);
    const body = allowlistedBodyOf(pkg?.scripts?.[c.scriptName]);
    if (body === null) {
      screenedIds.push(id);
      continue;
    }
    const { cmd, note } = execCmdFor(pm, body);
    if (cmd === null) {
      withheld.push({ id, note });
      continue;
    }
    entries.push({ id, title: `Project script ${c.scriptName}: ${body}`, cmd });
  }
  const notes = [];
  if (screenedIds.length) {
    notes.push(
      `${screenedIds.length} gate-class script(s) screened out — body not in the closed-world ` +
        `allowlist: ${screenedIds.join(', ')} — a command you trust can still be declared by hand in ${GATES_REL}`,
    );
  }
  if (withheld.length) {
    notes.push(`${withheld.length} script gate(s) withheld: ${withheld.map((w) => w.id).join(', ')} — ${withheld[0].note}`);
  }
  return { entries, notes };
};

export const deriveScriptEntries = (cwd, deps = {}) => deriveScripts(cwd, deps).entries;

// The conditional review-state candidate — keyed on the SLOT the checker enforces
// (plan-execution.review, tools/review-state.mjs), read via the shared config reader. Offered only
// when the config DECLARES reviewed/council there; solo configs and a council-on-plan-authoring-only
// config never see it. The cmd carries the resolved, QUOTED tool path and passes the validator.
// Double-quote-unsafe shell metacharacters: inside `"…"` bash still expands `$`, backticks and
// backslashes, and a `"` breaks the quoting entirely. A candidate cmd is hook-auto-approvable, so a
// path that cannot be safely double-quoted is WITHHELD with a loud note — never offered wrongly.
const DQ_UNSAFE_PATH_PATTERN = /["$`\\\r\n]/;

export const reviewStateCandidate = (cwd, deps = {}) => {
  const toolPath = deps.reviewStateTool ?? REVIEW_STATE_TOOL;
  try {
    const { config } = loadConfig(resolve(cwd), deps.readFile ?? readFileSync, deps.lstat ?? lstatSync);
    const declared = config?.['plan-execution']?.review;
    if (declared !== 'reviewed' && declared !== 'council') return { candidate: null, note: null };
    if (DQ_UNSAFE_PATH_PATTERN.test(toolPath)) {
      return {
        candidate: null,
        note:
          `the review-state candidate was withheld: the resolved kit path contains shell ` +
          `metacharacters that do not survive double-quoting (${toolPath}) — declare the gate ` +
          `by hand per references/modes/review-state.md step 3`,
      };
    }
    return {
      candidate: {
        id: 'review-state',
        title: 'Review receipts current for the uncommitted tree',
        cmd: `node "${toolPath}" --check`,
      },
      note: null,
    };
  } catch (err) {
    return {
      candidate: null,
      note: `orchestration config unreadable (${err.message}) — the review-state candidate was not evaluated`,
    };
  }
};

// The conditional COVERAGE-CHECK candidate (D3(a)) — the SAME consent + conditional rule as the
// review-state candidate (offered ONLY when plan-execution.review is reviewed/council), keyed on
// the same slot, path resolved + QUOTED. Together they are the canonical core pair `run-gates
// --final` requires (the checker declared LAST — buildOffer appends it last so a whole-offer
// apply lands final-ready); review-state gates receipt satisfaction, coverage-check verifies the
// consumed lcov + the red-proof declarations.
export const coverageCheckCandidate = (cwd, deps = {}) => {
  const toolPath = deps.coverageCheckTool ?? COVERAGE_CHECK_TOOL;
  try {
    const { config } = loadConfig(resolve(cwd), deps.readFile ?? readFileSync, deps.lstat ?? lstatSync);
    const declared = config?.['plan-execution']?.review;
    if (declared !== 'reviewed' && declared !== 'council') return { candidate: null, note: null };
    if (DQ_UNSAFE_PATH_PATTERN.test(toolPath)) {
      return {
        candidate: null,
        note:
          `the coverage-check candidate was withheld: the resolved kit path contains shell ` +
          `metacharacters that do not survive double-quoting (${toolPath}) — declare the gate ` +
          `by hand per references/modes/coverage-check.md`,
      };
    }
    return {
      candidate: {
        id: 'coverage-check',
        title: 'Changed-line coverage + red-proof verification (the final-run checker)',
        cmd: `node "${toolPath}" --check`,
      },
      note: null,
    };
  } catch (err) {
    return {
      candidate: null,
      note: `orchestration config unreadable (${err.message}) — the coverage-check candidate was not evaluated`,
    };
  }
};

// Every --only id must name an OFFERED entry — enforced in BOTH paths (dry-run and apply), before
// any empty-offer shortcut, so a typo is a loud usage error, never a silent filter or a silent
// "nothing to offer" success.
const assertOnlyIdsOffered = (offer, onlyIds = []) => {
  const offered = new Set(offer.entries.map((e) => e.id));
  const unknown = onlyIds.filter((id) => !offered.has(id));
  if (unknown.length) {
    throw usageFail(`--only names ids not in the offer: ${unknown.join(', ')} (offered: ${[...offered].join(', ') || 'none'})`);
  }
};

// The full offer: script entries + the conditional review-state + coverage-check candidates
// (coverage-check LAST — the `run-gates --final` declaration-shape rule requires the checker as
// the last declared gate, so a whole-offer apply is final-ready by construction). Both key on the
// same slot (plan-execution.review reviewed/council) but gate distinct axes.
export const buildOffer = (cwd, deps = {}) => {
  const scripts = deriveScripts(cwd, deps);
  const rs = reviewStateCandidate(cwd, deps);
  const cc = coverageCheckCandidate(cwd, deps);
  const candidates = [rs.candidate, cc.candidate].filter(Boolean);
  return {
    entries: [...scripts.entries, ...candidates],
    notes: [...scripts.notes, rs.note, cc.note].filter(Boolean),
  };
};

// The RUNNABLE apply invocation for a given project — this tool has no bin and no mode token, so
// the consent step must print the real command, never a bare `gates-init`. Consent integrity: a
// previewed --only subset is carried into the hint VERBATIM (ids are shell-safe by construction —
// kebabIdOf output / the fixed `review-state`), so following the hint can never widen the consent.
// Paths that do not survive double-quoting (the reviewStateCandidate screen, same pattern) make
// this return null — the preview then falls back to a generic, unquoted instruction.
export const applyInvocationFor = (cwd, onlyIds = []) => {
  const ownPath = fileURLToPath(import.meta.url);
  if (DQ_UNSAFE_PATH_PATTERN.test(ownPath) || DQ_UNSAFE_PATH_PATTERN.test(cwd)) return null;
  const only = onlyIds.map((id) => ` --only ${id}`).join('');
  return `node "${ownPath}" --cwd "${cwd}" --apply${only}`;
};

const GENERIC_APPLY_HINT = 're-run this same command with --apply [--only <id>]...';

export const formatPreview = (offer, applyInvocation = null, { explicitOnly = false } = {}) => {
  const lines = ['[agent-workflow-kit] gates fill preview (dry-run — nothing was written):'];
  if (!offer.entries.length) {
    lines.push('  nothing to offer — no seedable terminating verification scripts were found.');
  }
  for (const e of offer.entries) {
    lines.push(`  ${e.id}: ${e.cmd}   (${e.title})`);
  }
  for (const note of offer.notes) lines.push(`  note: ${note}`);
  if (offer.entries.length) {
    const suffix = explicitOnly ? '' : ' [--only <id>]...';
    lines.push(`  apply exactly the entries you consent to: ${applyInvocation ?? GENERIC_APPLY_HINT}${applyInvocation ? suffix : ''}`);
  }
  lines.push(`  ${TRUST_CHAIN_DISCLOSURE}`);
  return lines.join('\n');
};

// ── the existing declaration (append-only source) ──────────────────────────────────────
const loadExistingDeclaration = (cwd, deps = {}) => {
  const read = deps.readFile ?? readFileSync;
  const lstat = deps.lstat ?? lstatSync;
  const full = join(cwd, GATES_REL);
  const leaf = lstatNoFollow(full, lstat);
  if (leaf === null) return { outcome: 'missing' };
  // Refuse a symlinked leaf HERE, before any read/parse — the atomic core would refuse it at write
  // time anyway, but the honest STOP names the symlink, not a misleading parse error on its target.
  if (leaf.isSymbolicLink()) {
    throw stop(`${GATES_REL} is a symlink — refusing to touch it (a write would clobber the link target)`);
  }
  const parsed = (() => {
    try {
      return JSON.parse(String(read(full, 'utf8')));
    } catch (err) {
      throw stop(`${GATES_REL}: malformed JSON (${err.message}) — fix it by hand; this preview never writes over a declaration it cannot parse`);
    }
  })();
  const gates = (() => {
    try {
      return validateDeclaration(parsed);
    } catch (err) {
      throw stop(`${err.message} — fix it by hand; this preview never writes over an invalid declaration`);
    }
  })();
  return { outcome: 'loaded', readme: typeof parsed._README === 'string' ? parsed._README : undefined, gates };
};

const templateReadme = (deps = {}) => {
  const read = deps.readTemplate ?? readFileSync;
  try {
    const parsed = JSON.parse(String(read(TEMPLATE_PATH, 'utf8')));
    if (typeof parsed._README !== 'string') throw new Error('template has no _README');
    return parsed._README;
  } catch (err) {
    throw stop(`the bundled gates.json template is unreadable (${err.message}) — the kit install is incomplete`);
  }
};

const readStampValue = (cwd, deps = {}) => {
  const read = deps.readFile ?? readFileSync;
  try {
    const v = String(read(join(cwd, STAMP_REL), 'utf8')).trim();
    return v.length ? v : null;
  } catch {
    return null;
  }
};

// ── apply (append exactly the consented entries) ───────────────────────────────────────
export const applyFill = ({ cwd, onlyIds = [] }, deps = {}) => {
  assertDocsAiDeployment(cwd, deps, { stop, noun: 'a gate declaration', rel: GATES_REL });
  const stampValue = readStampValue(cwd, deps);
  if (stampValue !== EXPECTED_WORKFLOW_VERSION) {
    throw stop(
      `--apply is deployment-gated: ${STAMP_REL} is ${stampValue ?? 'absent'} but this kit expects ` +
        `${EXPECTED_WORKFLOW_VERSION} (the preview works on any deployment; run upgrade first)`,
    );
  }
  const offer = buildOffer(cwd, deps);
  assertOnlyIdsOffered(offer, onlyIds); // BEFORE the empty-offer return — a typo is never masked
  if (!offer.entries.length) return { outcome: 'nothing', notes: offer.notes };
  const selected = onlyIds.length ? offer.entries.filter((e) => onlyIds.includes(e.id)) : offer.entries;

  const existing = loadExistingDeclaration(cwd, deps);
  const existingGates = existing.outcome === 'loaded' ? existing.gates : [];
  const existingIds = new Set(existingGates.map((g) => g.id));
  const collisions = selected.filter((e) => existingIds.has(e.id)).map((e) => e.id);
  if (collisions.length) {
    throw stop(
      `id collision — already declared in ${GATES_REL}: ${collisions.join(', ')} (append-only: the ` +
        `fill never modifies or removes an existing entry; pick the others with --only, or edit by hand)`,
    );
  }

  const merged = {
    _README: existing.outcome === 'loaded' && existing.readme !== undefined ? existing.readme : templateReadme(deps),
    gates: [...existingGates, ...selected],
  };
  validateDeclaration(merged); // every written declaration passes the runner's validator, always
  const body = `${JSON.stringify(merged, null, 2)}\n`;
  const { writtenPath } = writeDocsAiFileAtomic(cwd, GATES_REL, body, deps, { stop, noun: 'a gate declaration' });
  return { outcome: 'written', writtenPath, appended: selected.map((e) => e.id), notes: offer.notes };
};

// ── CLI ────────────────────────────────────────────────────────────────────────────────
export const parseArgs = (argv) => {
  const parsed = argv.reduce(
    (acc, a, i) => {
      if (acc.skip) return { ...acc, skip: false };
      if (a === '--help' || a === '-h') return { ...acc, help: true };
      // A consent-gated writer never lets a later flag silently decide whether it mutates:
      // mixed --dry-run/--apply is a usage error, whichever order they arrive in.
      if (a === '--dry-run') {
        if (acc.apply === true) throw usageFail('--dry-run and --apply are mutually exclusive — pick one');
        return { ...acc, apply: false, dryRunExplicit: true };
      }
      if (a === '--apply') {
        if (acc.dryRunExplicit) throw usageFail('--dry-run and --apply are mutually exclusive — pick one');
        return { ...acc, apply: true };
      }
      if (a === '--cwd') {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('-')) throw usageFail('--cwd needs a value: --cwd <dir>');
        return { ...acc, cwd: value, skip: true };
      }
      if (a === '--only') {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('-')) throw usageFail('--only needs a gate id');
        return { ...acc, only: [...acc.only, value], skip: true };
      }
      throw usageFail(`unknown argument: ${a}`);
    },
    { help: false, apply: false, dryRunExplicit: false, cwd: undefined, only: [], skip: false },
  );
  return parsed;
};

export const main = (argv = process.argv.slice(2), deps = {}) => {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  try {
    const args = parseArgs(argv);
    if (args.help) {
      log(USAGE);
      return EXIT_OK;
    }
    const cwd = resolve(args.cwd ?? process.cwd());
    assertDocsAiDeployment(cwd, deps, { stop, noun: 'a gate declaration', rel: GATES_REL });
    if (!args.apply) {
      const offer = buildOffer(cwd, deps);
      assertOnlyIdsOffered(offer, args.only); // a dry-run --only typo is loud too
      const filtered = args.only.length ? { ...offer, entries: offer.entries.filter((e) => args.only.includes(e.id)) } : offer;
      log(formatPreview(filtered, applyInvocationFor(cwd, args.only), { explicitOnly: args.only.length > 0 }));
      return EXIT_OK;
    }
    const result = applyFill({ cwd, onlyIds: args.only }, deps);
    if (result.outcome === 'nothing') {
      log('[agent-workflow-kit] nothing to offer — no seedable terminating verification scripts were found; wrote nothing.');
      for (const note of result.notes) log(`  note: ${note}`); // the user learns WHY (same note as the preview)
      return EXIT_OK;
    }
    log(`[agent-workflow-kit] appended ${result.appended.length} consented gate(s) to ${GATES_REL}: ${result.appended.join(', ')}`);
    for (const note of result.notes) log(`  note: ${note}`); // a mixed offer never silently omits what was screened
    log(`[agent-workflow-kit] ${TRUST_CHAIN_DISCLOSURE}`);
    return EXIT_OK;
  } catch (err) {
    error(err?.message ?? String(err));
    return err?.exitCode ?? EXIT_PRECONDITION;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exit(main(process.argv.slice(2)));
