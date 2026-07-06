#!/usr/bin/env node
// seed-gates.mjs — the consent-gated docs/ai/gates.json seeder (AD-042). Reached ONLY through
// explicitly-consenting prose (the bootstrap accelerators block and the gates.md consent-seed
// section) — it is NOT a routable mode token, it sits OUTSIDE every velocity allowlist tier
// (a consent-per-run writer is never pre-approved), and the shipped gates.json TEMPLATE stays
// EMPTY (AD-021/AD-038): a populated declaration is per-entry maintainer consent recorded through
// this preview, never auto-seeding.
//
// What it offers (the derivation invariants, test-pinned):
//   • sources: discoverGateCandidates over package.json scripts (velocity-profile.mjs stays
//     read-only; THIS module owns the offer mapping) + the conditional review-state candidate;
//   • warn-flagged candidates (release/publish/deploy/push/version/commit/tag, pre*/post*) NEVER
//     enter the offer — excluded, not offered-with-a-warning;
//   • only TERMINATING verification classes are offered (test / lint / type-check / build) —
//     never dev/start/watch/serve/preview, never a formatter write-mode;
//   • commands are package-manager-aware (packageManager field, else lockfile probe, else npm);
//   • ids derive kebab-case from script names (build:prod → build-prod) and every offered entry
//     passes the runner's validateDeclaration (the seeder imports the validator — NEVER the
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
// declaration, id collision); 2 usage. Dependency-free, Node >= 18. No side effects on import.

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
const REVIEW_LEDGER_TOOL = join(KIT_ROOT, 'tools', 'review-ledger.mjs');
const STAMP_REL = join('docs', 'ai', '.workflow-version');

const EXIT_OK = 0;
const EXIT_PRECONDITION = 1;
const EXIT_USAGE = 2;

export const SEED_GATES_STOP = 'SEED_GATES_STOP';
const stop = (message) =>
  Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'SeedGatesStop', code: SEED_GATES_STOP, exitCode: EXIT_PRECONDITION });
const usageFail = (message) =>
  Object.assign(new Error(`[agent-workflow-kit] ${message}`), { exitCode: EXIT_USAGE });

// The trust-chain disclosure (AD-042) — printed with EVERY preview, token-pinned by the tests: a
// consent-seeded command becomes auto-approvable only after TWO explicit consents.
export const TRUST_CHAIN_DISCLOSURE =
  'Disclosure: once the optional approval hook is wired (/agent-workflow-kit hook), it ' +
  'auto-approves byte-exact declared gate commands from the project root — seeding (this consent) ' +
  'and hook wiring (its own consent) are two separate yeses.';

const USAGE = `usage: seed-gates [--dry-run | --apply] [--only <id>]... [--cwd <dir>] [--help]

Consent-gated seeder for the project's own docs/ai/gates.json. Default is --dry-run: prints the
derived { id, title, cmd } entries and writes NOTHING. --apply APPENDS exactly the consented
entries (--only <id> selects a subset; append-only — existing entries are never modified or
removed, an id collision is refused). Only terminating verification commands are offered
(test / lint / type-check / build); release/publish/deploy scripts and watch/serve modes never
enter the offer. ${TRUST_CHAIN_DISCLOSURE}`;

// ── candidate classification (the LOCKED derivation invariants) ────────────────────────
// The derived cmd (`<pm> run <name>`) is bash-interpolated by the gate runner and can become
// hook-auto-approvable, so only shell-SAFE script names ever enter the offer: a name carrying
// whitespace or any shell metacharacter (`test:ci && echo pwn`) is screened out entirely.
const SAFE_SCRIPT_NAME_PATTERN = /^[A-Za-z0-9:_.-]+$/;
const TERMINATING_CLASS_PATTERN = /^(test|lint|type-?check|types|tsc|build)([:._-]|$)/i;
// Non-terminating screening is TOKEN-set based, position-independent (never an anchored regex —
// the anchored form missed `build:preview` and a bare `vite preview` body): a non-terminating
// token in ANY name segment, or as ANY bare/dashed body word, disqualifies; `watch` disqualifies
// as a substring anywhere (watchAll, --watchAll). Conservative on purpose — a screened-out script
// can still be declared by hand; a wrongly-included one would become hook-auto-approvable.
const NON_TERMINATING_TOKENS = new Set(['dev', 'start', 'serve', 'watch', 'preview']);
// A terminating-looking NAME can still hide release work in its BODY (`"test": "npm publish"`):
// the same token classes the warn-name screen rejects are rejected as bare body words too — an
// offered cmd is hook-auto-approvable, so a dangerous body must never ride a clean name.
const DANGEROUS_BODY_TOKENS = new Set(['release', 'publish', 'deploy', 'push', 'version', 'commit', 'tag']);
const WATCH_ANYWHERE_PATTERN = /watch/i;
const wordOf = (raw) => raw.toLowerCase().replace(/^-+/, '').split('=')[0];
const hasTokenIn = (text, splitter, tokens) =>
  String(text)
    .split(splitter)
    .some((part) => tokens.has(wordOf(part)));
const isNonTerminatingName = (name) =>
  hasTokenIn(name, /[:._-]/, NON_TERMINATING_TOKENS) || WATCH_ANYWHERE_PATTERN.test(name);
const isNonTerminatingBody = (body) =>
  hasTokenIn(body, /\s+/, NON_TERMINATING_TOKENS) || WATCH_ANYWHERE_PATTERN.test(body);
const isDangerousBody = (body) => hasTokenIn(body, /\s+/, DANGEROUS_BODY_TOKENS);
// A MUTATING VARIANT of a terminating class never enters the offer — a hook-auto-approvable gate
// must never be a writer. Screened on BOTH axes: the script NAME (lint:fix, test:update,
// build:write, test:snapshot) and the script BODY's write-mode flags (eslint --fix,
// prettier --write / -w, jest -u / --updateSnapshot, tsc -w). Conservative by design: an excluded
// candidate can still be declared by hand — a wrongly-included one would be silently auto-approved.
const MUTATING_VARIANT_NAME_PATTERN = /(^|[:._-])(fix|write|update|snapshot)([:._-]|$)/i;
const MUTATING_BODY_FLAG_PATTERN = /(^|\s)(--fix|--write|--update(?:-snapshot)?|--updateSnapshot|-w|-u)(=|\s|$)/;

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

// The script-derived offer entries. Order = package.json scripts order (the offer the user reads).
export const deriveScriptEntries = (cwd, deps = {}) => {
  const read = deps.readFile ?? readFileSync;
  const pkg = (() => {
    try {
      return JSON.parse(String(read(join(cwd, 'package.json'), 'utf8')));
    } catch {
      return null; // no/unreadable package.json → no script candidates (an honest empty offer)
    }
  })();
  const pm = detectPackageManager(cwd, deps);
  const seen = new Set();
  const bodyOf = (name) => String(pkg?.scripts?.[name] ?? '');
  return discoverGateCandidates(pkg ?? {})
    .filter((c) => !c.warn) // warn-flagged NEVER enter the offer
    .filter((c) => SAFE_SCRIPT_NAME_PATTERN.test(c.scriptName)) // shell-safe names only, FIRST
    .filter((c) => TERMINATING_CLASS_PATTERN.test(c.scriptName))
    .filter((c) => !isNonTerminatingName(c.scriptName))
    .filter((c) => !MUTATING_VARIANT_NAME_PATTERN.test(c.scriptName) && !MUTATING_BODY_FLAG_PATTERN.test(bodyOf(c.scriptName)))
    .filter((c) => !isNonTerminatingBody(bodyOf(c.scriptName)))
    .filter((c) => !isDangerousBody(bodyOf(c.scriptName)))
    .map((c) => ({
      id: kebabIdOf(c.scriptName),
      title: `Project script: ${pm} run ${c.scriptName}`,
      cmd: `${pm} run ${c.scriptName}`,
    }))
    .filter((e) => {
      if (!e.id || seen.has(e.id)) return false; // an empty or duplicate derived id never enters the offer
      seen.add(e.id);
      return true;
    });
};

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

// The conditional review-LEDGER candidate (AD-045) — the SAME consent + conditional rule as the
// review-state candidate (offered ONLY when plan-execution.review is reviewed/council), keyed on the
// same slot, path resolved + QUOTED. It gates the review-ROUND ledger (converged / accepted-residual);
// review-state gates receipt PRESENCE. Both may be offered together — distinct axes.
export const reviewLedgerCandidate = (cwd, deps = {}) => {
  const toolPath = deps.reviewLedgerTool ?? REVIEW_LEDGER_TOOL;
  try {
    const { config } = loadConfig(resolve(cwd), deps.readFile ?? readFileSync, deps.lstat ?? lstatSync);
    const declared = config?.['plan-execution']?.review;
    if (declared !== 'reviewed' && declared !== 'council') return { candidate: null, note: null };
    if (DQ_UNSAFE_PATH_PATTERN.test(toolPath)) {
      return {
        candidate: null,
        note:
          `the review-ledger candidate was withheld: the resolved kit path contains shell ` +
          `metacharacters that do not survive double-quoting (${toolPath}) — declare the gate ` +
          `by hand per references/modes/review-ledger.md`,
      };
    }
    return {
      candidate: {
        id: 'review-ledger',
        title: 'Review-round ledger: the in-flight loop is converged or accepted-residual',
        cmd: `node "${toolPath}" --check`,
      },
      note: null,
    };
  } catch (err) {
    return {
      candidate: null,
      note: `orchestration config unreadable (${err.message}) — the review-ledger candidate was not evaluated`,
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

// The full offer: script entries + the conditional review-state + review-ledger candidates (last),
// plus loud notes. Both review candidates key on the same slot (plan-execution.review reviewed/council)
// but gate distinct axes (receipt presence vs review-round convergence) — offered together.
export const buildOffer = (cwd, deps = {}) => {
  const entries = deriveScriptEntries(cwd, deps);
  const rs = reviewStateCandidate(cwd, deps);
  const rl = reviewLedgerCandidate(cwd, deps);
  const candidates = [rs.candidate, rl.candidate].filter(Boolean);
  const notes = [rs.note, rl.note].filter(Boolean);
  return {
    entries: [...entries, ...candidates],
    notes,
  };
};

// The RUNNABLE apply invocation for a given project — this tool has no bin and no mode token, so
// the consent step must print the real command, never a bare `seed-gates`. Consent integrity: a
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
  const lines = ['[agent-workflow-kit] gates seeding preview (dry-run — nothing was written):'];
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
      throw stop(`${GATES_REL}: malformed JSON (${err.message}) — fix it by hand; the seeder never writes over a declaration it cannot parse`);
    }
  })();
  const gates = (() => {
    try {
      return validateDeclaration(parsed);
    } catch (err) {
      throw stop(`${err.message} — fix it by hand; the seeder never writes over an invalid declaration`);
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
export const applySeed = ({ cwd, onlyIds = [] }, deps = {}) => {
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
  if (!offer.entries.length) return { outcome: 'nothing' };
  const selected = onlyIds.length ? offer.entries.filter((e) => onlyIds.includes(e.id)) : offer.entries;

  const existing = loadExistingDeclaration(cwd, deps);
  const existingGates = existing.outcome === 'loaded' ? existing.gates : [];
  const existingIds = new Set(existingGates.map((g) => g.id));
  const collisions = selected.filter((e) => existingIds.has(e.id)).map((e) => e.id);
  if (collisions.length) {
    throw stop(
      `id collision — already declared in ${GATES_REL}: ${collisions.join(', ')} (append-only: the ` +
        `seeder never modifies or removes an existing entry; pick the others with --only, or edit by hand)`,
    );
  }

  const merged = {
    _README: existing.outcome === 'loaded' && existing.readme !== undefined ? existing.readme : templateReadme(deps),
    gates: [...existingGates, ...selected],
  };
  validateDeclaration(merged); // every written declaration passes the runner's validator, always
  const body = `${JSON.stringify(merged, null, 2)}\n`;
  const { writtenPath } = writeDocsAiFileAtomic(cwd, GATES_REL, body, deps, { stop, noun: 'a gate declaration' });
  return { outcome: 'written', writtenPath, appended: selected.map((e) => e.id) };
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
    const result = applySeed({ cwd, onlyIds: args.only }, deps);
    if (result.outcome === 'nothing') {
      log('[agent-workflow-kit] nothing to offer — no seedable terminating verification scripts were found; wrote nothing.');
      return EXIT_OK;
    }
    log(`[agent-workflow-kit] appended ${result.appended.length} consented gate(s) to ${GATES_REL}: ${result.appended.join(', ')}`);
    log(`[agent-workflow-kit] ${TRUST_CHAIN_DISCLOSURE}`);
    return EXIT_OK;
  } catch (err) {
    error(err?.message ?? String(err));
    return err?.exitCode ?? EXIT_PRECONDITION;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exit(main(process.argv.slice(2)));
