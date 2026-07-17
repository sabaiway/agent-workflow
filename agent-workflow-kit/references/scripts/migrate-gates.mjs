#!/usr/bin/env node
// migrate-gates.mjs — the consented LEGACY gates.json migration (strip-the-kit D8). A deployment
// that predates the hardened core declares gates the stripped kit no longer ships (the
// review-ledger / fold-completeness checks); this tool migrates the declaration ATOMICALLY and
// COMPLETELY in one consented step: it REMOVES the canonical legacy entries, EXTENDS the
// canonical `unit-tests` cmd with the built-in lcov reporters (the D3(d) coverage source), and
// ADDS the coverage-check gate LAST (removal alone is not a migration — the result must satisfy
// `run-gates --final` and carry a working commit path).
//
// Matching is by the DOCUMENTED cmd forms ONLY (hand-wired history included — never by seed
// provenance): a legacy entry is `node <path>/review-ledger.mjs --check` or
// `node <path>/fold-completeness.mjs --check` (quoted or bare path, ONE plain invocation); the
// canonical unit-tests entry is id `unit-tests` with a cmd starting `node --test `. ANYTHING
// else is a CUSTOMIZED entry — never auto-touched: the preview reports it loudly and prints the
// paste-ready recovery so the maintainer applies the intent by hand; the commit guard is NOT to
// be installed until the declaration is final-run-capable.
//
// Write discipline (the family's consented-writer contract): preview (dry-run) is the DEFAULT
// and writes NOTHING; `--apply` rewrites docs/ai/gates.json via exclusive tmp+rename in the same
// directory; a symlinked gates.json (or docs/ai parent) is a STOP; a malformed declaration is
// never written over. `--kit-tools <dir>` names the installed kit's tools directory — the
// migration writes RESOLVED, QUOTED paths for the coverage-check gate (no runtime guessing).
//
// Exit codes: 0 done / preview / nothing-to-migrate; 1 precondition STOP; 2 usage.
// Dependency-free. No side effects on import.

import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const MIGRATE_GATES_STOP = 'MIGRATE_GATES_STOP';
const stop = (message) =>
  Object.assign(new Error(`[agent-workflow] ${message}`), { name: 'MigrateGatesStop', code: MIGRATE_GATES_STOP, exitCode: 1 });
const usageFail = (message) => Object.assign(new Error(`[agent-workflow] ${message}`), { exitCode: 2 });

export const GATES_REL = join('docs', 'ai', 'gates.json');

// The documented canonical forms — ONE plain invocation, quoted or bare path, `--check` at END
// (the run-gates strict-matcher shape; a masked/compound form is a CUSTOMIZED entry).
const legacyRe = (basename) => new RegExp(`^node\\s+(?:"(?:[^"]*[/\\\\])?${basename}"|(?:[^\\s"]*[/\\\\])?${basename})\\s+--check$`);
export const LEGACY_FORMS = Object.freeze([
  { name: 'review-ledger', re: legacyRe('review-ledger\\.mjs') },
  { name: 'fold-completeness', re: legacyRe('fold-completeness\\.mjs') },
]);

// The D3(d) reporter flags the canonical unit-tests cmd gains — lcov at the fixed git-dir path
// run-gates --final exports, plus an explicit stdout reporter (without it the lcov reporter
// swallows the human TAP/spec stream).
export const UNIT_TESTS_COVERAGE_FLAGS =
  '--experimental-test-coverage --test-reporter=lcov --test-reporter-destination="$AW_GIT_DIR/agent-workflow-lcov.info" --test-reporter=spec --test-reporter-destination=stdout';

// The RETIRED kit-owned git-dir stores the deleted machinery wrote — dead data a consumer's
// upgrade would otherwise strand forever. The migration cleans them (consented via the preview;
// ENOENT is a silent no-op; any other unlink error is reported loudly but never fails the
// migration — the stores are not a gate input).
export const RETIRED_STORE_BASENAMES = Object.freeze([
  'agent-workflow-review-ledger.jsonl',
  'agent-workflow-review-ledger.v5-orphans.jsonl',
  'agent-workflow-fold-completeness.jsonl',
]);

const trueGitDir = (cwd) => {
  const r = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8', windowsHide: true });
  return r.error || r.status !== 0 ? null : r.stdout.replace(/\r?\n$/, '');
};

// findRetiredStores(cwd) → the absolute paths of retired stores PRESENT in the target's git dir.
export const findRetiredStores = (cwd) => {
  const gitDir = trueGitDir(cwd);
  if (gitDir == null) return [];
  return RETIRED_STORE_BASENAMES.map((name) => join(gitDir, name)).filter((p) => existsSync(p));
};

const UNIT_TESTS_PREFIX = 'node --test ';

// The core-check forms the stripped core anchors on (same strict single-invocation shape as the
// legacy matcher). Canonicity is PURE path equality against the caller-named kit tools dir —
// an ABSOLUTE token resolving to the installed tool; run-gates --final does the live realpath
// check. A cmd that MATCHES the shape but resolves elsewhere (or relatively) is a LOOKALIKE —
// reported customized, never counted as the core check.
const CORE_CHECK_RE = { 'coverage-check': legacyRe('coverage-check\\.mjs'), 'review-state': legacyRe('review-state\\.mjs') };
const coreCheckToken = (cmd) => /^node\s+(?:"([^"]+)"|([^\s"]+))\s+--check$/.exec(cmd.trim())?.slice(1).find(Boolean) ?? null;
const samePath = (a, b) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b); // an unresolvable side falls back to the lexical compare
  }
};
const isCanonicalCoreCheck = (name, cmd, kitToolsDir) => {
  if (!CORE_CHECK_RE[name].test(cmd.trim())) return false;
  const token = coreCheckToken(cmd);
  return token !== null && isAbsolute(token) && samePath(token, join(kitToolsDir, `${name}.mjs`));
};

// buildMigrationPlan(gates, kitToolsDir) → the PURE migration plan.
// plan rows: { action: 'keep' | 'remove' | 'extend' | 'move' | 'add', entry, reason }.
// finalCapable mirrors the run-gates --final acceptance shape: the canonical review-state check
// must be PRESENT (the checker itself is guaranteed last by the plan) — missing means the result
// is NOT final-run-capable and the preview says so loudly with the paste-ready candidate.
export const buildMigrationPlan = (gates, kitToolsDir) => {
  const plan = [];
  const customized = [];
  let unitTestsExtended = false;
  let checkerRow = null;
  let hasReviewState = false;
  const coverageCmd = `node "${join(kitToolsDir, 'coverage-check.mjs')}" --check`;
  for (const gate of gates) {
    const legacy = LEGACY_FORMS.find((f) => f.re.test(gate.cmd.trim()));
    if (legacy) {
      plan.push({ action: 'remove', entry: gate, reason: `the ${legacy.name} check died with its tool (strip-the-kit)` });
      continue;
    }
    if (isCanonicalCoreCheck('coverage-check', gate.cmd, kitToolsDir)) {
      checkerRow = { action: 'keep', entry: gate, reason: null };
      plan.push(checkerRow);
      continue;
    }
    if (isCanonicalCoreCheck('review-state', gate.cmd, kitToolsDir)) {
      hasReviewState = true;
      plan.push({ action: 'keep', entry: gate, reason: null });
      continue;
    }
    if (gate.id === 'unit-tests') {
      if (gate.cmd.includes(UNIT_TESTS_COVERAGE_FLAGS)) {
        plan.push({ action: 'keep', entry: gate, reason: null }); // already fully configured
        continue;
      }
      if (gate.cmd.startsWith(UNIT_TESTS_PREFIX) && !/--experimental-test-coverage|--test-reporter/.test(gate.cmd)) {
        const extended = { ...gate, cmd: `node --test ${UNIT_TESTS_COVERAGE_FLAGS} ${gate.cmd.slice(UNIT_TESTS_PREFIX.length)}` };
        plan.push({ action: 'extend', entry: extended, reason: 'the unit-tests cmd gains the built-in lcov reporters (the D3(d) coverage source)' });
        unitTestsExtended = true;
        continue;
      }
      // npm test / a wrapper / a partial flag set: the coverage contract cannot be VERIFIED on a
      // cmd this tool does not understand — customized, never silently counted as configured.
      customized.push(gate);
      plan.push({ action: 'keep', entry: gate, reason: null });
      continue;
    }
    // A dead-tool reference or a core-check LOOKALIKE in a non-canonical form — reported, never touched.
    if (/review-ledger|fold-completeness|verification-profile|seed-gates|sarif|coverage-check\.mjs|review-state\.mjs/.test(gate.cmd)) {
      customized.push(gate);
    }
    plan.push({ action: 'keep', entry: gate, reason: null });
  }
  const kept = plan.filter((r) => r.action === 'keep' || r.action === 'extend');
  let collision = null;
  if (checkerRow === null) {
    // A surviving NON-canonical entry already holding the checker's id blocks the add — two
    // `coverage-check` rows would be ambiguous; the customized entry must be resolved by hand
    // FIRST (the caller turns this into a loud STOP on preview and apply alike).
    if (kept.some((r) => r.entry.id === 'coverage-check')) {
      collision = 'coverage-check';
    } else {
      plan.push({
        action: 'add',
        entry: { id: 'coverage-check', title: 'Changed-line coverage + red-proof verification (the final-run checker)', cmd: coverageCmd },
        reason: 'run-gates --final requires the canonical checker as the LAST declared gate',
      });
    }
  } else if (kept[kept.length - 1] !== checkerRow) {
    checkerRow.action = 'move';
    checkerRow.reason = 'the canonical checker must be the LAST declared gate (nothing may run after it consumed the lcov)';
  }
  const reviewStateCandidate = `{ "id": "review-state", "title": "Review receipts converged (D3(b))", "cmd": "node \\"${join(kitToolsDir, 'review-state.mjs')}\\" --check" }`;
  return { plan, customized, unitTestsExtended, finalCapable: hasReviewState, reviewStateCandidate, collision };
};

export const resultingGates = (plan) => {
  const kept = plan.filter((r) => r.action === 'keep' || r.action === 'extend').map((r) => r.entry);
  const moved = plan.filter((r) => r.action === 'move').map((r) => r.entry);
  const added = plan.filter((r) => r.action === 'add').map((r) => r.entry);
  return [...kept, ...moved, ...added]; // move/add go LAST — the checker ends up the last declared gate
};

// The per-entry customized recovery: a unit-tests-class entry gets the FULL canonical flag set
// (the intent is known — the cmd shape just cannot be verified); anything else gets the
// dead-tool recovery.
const customizedRecovery = (gate) =>
  gate.id === 'unit-tests'
    ? `declare the canonical suite gate by hand so the coverage contract is verifiable: node --test ${UNIT_TESTS_COVERAGE_FLAGS} <your test paths>`
    : 'remove the entry, or repoint it at a living check — the review-ledger / fold-completeness tools no longer exist.';

const warningLines = ({ customized, finalCapable, reviewStateCandidate }) => {
  const lines = [];
  for (const gate of customized) {
    lines.push(`  CUSTOMIZED (untouched): ${gate.id}: ${gate.cmd}`);
    lines.push(`    recovery (apply by hand if the intent still stands): ${customizedRecovery(gate)}`);
  }
  if (customized.length) {
    lines.push('  IMPORTANT: do NOT install the commit guard until every customized entry above is resolved — a declaration that cannot pass run-gates --final would block every commit.');
  }
  if (!finalCapable) {
    lines.push('  WARNING: the result is NOT final-run-capable — no canonical review-state check is declared. Add it (paste-ready), then run-gates --final can mint the receipt:');
    lines.push(`    ${reviewStateCandidate}`);
  }
  return lines;
};

export const formatPreview = (analysis, applyHint) => {
  const { plan, unitTestsExtended, finalCapable, retiredStores = [] } = analysis;
  const lines = ['[agent-workflow] legacy gates.json migration preview (dry-run — nothing was written):'];
  const acted = plan.filter((r) => r.action !== 'keep');
  for (const r of acted) {
    lines.push(`  ${r.action.toUpperCase()} ${r.entry.id}: ${r.entry.cmd}   (${r.reason})`);
  }
  for (const p of retiredStores) {
    lines.push(`  CLEAN ${p}   (a retired kit-owned store the deleted machinery wrote — dead data, unlinked on apply)`);
  }
  if (!acted.length && !retiredStores.length) {
    lines.push(
      finalCapable
        ? '  nothing to migrate — no canonical legacy entries, no retired stores, and the declaration is already final-run-capable.'
        : '  nothing to migrate mechanically — no canonical legacy entries and no retired stores; the warnings below still need a hand.',
    );
  }
  if (!unitTestsExtended && !plan.some((r) => r.entry.id === 'unit-tests')) {
    lines.push('  note: no canonical `unit-tests` entry found — declare your suite gate with the lcov reporters by hand (the coverage-check gate reads the file it produces).');
  }
  lines.push(...warningLines(analysis));
  if (acted.length || retiredStores.length) {
    lines.push(`  apply exactly this migration: ${applyHint}`);
  }
  return lines.join('\n');
};

// The parent chain (docs, docs/ai) is lstat'd NO-FOLLOW: a symlinked parent means the write
// would land OUTSIDE the target project — a STOP on preview and apply alike. ENOENT reads as
// "no declaration" (a preview no-op); any OTHER lstat failure (EACCES, EIO) fails CLOSED —
// an unverifiable parent is never treated as safe. lstatFn is the injectable test seam.
const checkRealParents = (cwd, lstatFn) => {
  for (const rel of ['docs', join('docs', 'ai')]) {
    const p = join(cwd, rel);
    let st;
    try {
      st = lstatFn(p);
    } catch (err) {
      if (err.code === 'ENOENT') return { missing: true };
      throw stop(`${p}: cannot verify the declaration parent (${err.code ?? err.message}) — refusing to proceed (fail closed)`);
    }
    if (st.isSymbolicLink()) throw stop(`${p} is a symlink — refusing to read or write the declaration through a symlinked parent`);
    if (!st.isDirectory()) throw stop(`${p} is not a real directory — fix the layout by hand`);
  }
  return { missing: false };
};

const loadDeclaration = (cwd, lstatFn = lstatSync) => {
  const full = join(cwd, GATES_REL);
  let leaf = null;
  try {
    leaf = lstatFn(full);
  } catch (err) {
    // ONLY "not there" reads as missing — an EACCES/EIO leaf must never let apply proceed
    // (it would clean the retired stores while silently not migrating the declaration).
    if (err.code === 'ENOENT') return { outcome: 'missing' };
    throw stop(`${GATES_REL}: cannot lstat the declaration (${err.code ?? err.message}) — refusing to proceed (fail closed)`);
  }
  if (leaf.isSymbolicLink()) throw stop(`${GATES_REL} is a symlink — refusing to touch it`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(full, 'utf8'));
  } catch (err) {
    throw stop(`${GATES_REL}: malformed JSON (${err.message}) — fix it by hand; the migration never writes over a declaration it cannot parse`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.gates)) {
    throw stop(`${GATES_REL}: not a { gates: [...] } declaration — fix it by hand`);
  }
  return { outcome: 'loaded', parsed };
};

// The parent chain is re-verified immediately before the tmp write AND again before the rename
// (an honest-effort TOCTOU guard — a parent swapped for a symlink mid-migration never gets
// written through).
const writeAtomic = (cwd, body, lstatFn) => {
  const full = join(cwd, GATES_REL);
  if (checkRealParents(cwd, lstatFn).missing) throw stop(`${GATES_REL}: the docs/ai parent vanished during the migration — nothing was written`);
  const tmp = `${full}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, body, { flag: 'wx' });
  try {
    if (checkRealParents(cwd, lstatFn).missing) throw stop(`${GATES_REL}: the docs/ai parent vanished during the migration — nothing was written`);
    renameSync(tmp, full);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort tmp cleanup */ }
    throw err;
  }
  return full;
};

export const parseArgs = (argv) => {
  const args = { cwd: process.cwd(), apply: false, kitTools: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--cwd') {
      i += 1;
      if (!argv[i]) throw usageFail('--cwd needs a directory');
      args.cwd = argv[i];
    } else if (a === '--kit-tools') {
      i += 1;
      if (!argv[i]) throw usageFail('--kit-tools needs the installed kit tools directory');
      args.kitTools = argv[i];
    } else throw usageFail(`unknown argument: ${a}`);
  }
  return args;
};

const HELP = `migrate-gates — the consented legacy gates.json migration (strip-the-kit D8).

Usage:
  node migrate-gates.mjs --kit-tools <installed-kit-tools-dir> [--cwd <project>] [--apply]

Default is a dry-run PREVIEW (writes nothing). --apply rewrites ${GATES_REL} atomically:
canonical legacy entries (review-ledger / fold-completeness --check, matched by their documented
single-invocation forms) are REMOVED; the canonical unit-tests cmd gains the built-in lcov
reporters; the coverage-check gate is ADDED last (resolved, QUOTED path). Customized entries are
NEVER auto-touched — the preview names each with a paste-ready recovery, and the commit guard
must not be installed until they are resolved.`;

export const main = (argv = process.argv.slice(2), io = {}) => {
  const out = io.log ?? console.log;
  const err = io.error ?? console.error;
  try {
    const args = parseArgs(argv);
    if (args.help) {
      out(HELP);
      return 0;
    }
    if (!args.kitTools) throw usageFail('--kit-tools <dir> is required (the installed kit tools directory — the migration writes resolved paths, never guesses)');
    const kitTools = isAbsolute(args.kitTools) ? args.kitTools : resolve(args.cwd, args.kitTools);
    // The kit path lands INSIDE a double-quoted bash cmd line — a path bash would interpret there
    // ($ ` " \) is a STOP before any plan is built or byte written (never a silently broken gate).
    if (/[$"`\\\r\n]/.test(kitTools)) {
      throw stop(`--kit-tools resolves to ${kitTools} — the path contains shell metacharacters unsafe inside a double-quoted gate cmd ($ \` " \\); relocate the kit to a safe path`);
    }
    if (!existsSync(join(kitTools, 'coverage-check.mjs'))) {
      throw stop(`--kit-tools ${kitTools} does not contain coverage-check.mjs — point it at the installed kit's tools directory`);
    }
    const lstatFn = io.lstat ?? lstatSync;
    const parents = checkRealParents(args.cwd, lstatFn);
    const retiredStores = findRetiredStores(args.cwd);
    const declaration = parents.missing ? { outcome: 'missing' } : loadDeclaration(args.cwd, lstatFn);
    if (declaration.outcome === 'missing' && !retiredStores.length) {
      out(`[agent-workflow] no ${GATES_REL} and no retired stores — nothing to migrate.`);
      return 0;
    }
    const parsed = declaration.outcome === 'loaded' ? declaration.parsed : { gates: [] };
    const analysis = { ...buildMigrationPlan(parsed.gates, kitTools), retiredStores };
    if (analysis.collision) {
      throw stop(
        `id collision — a NON-canonical entry already uses id "${analysis.collision}"; resolve it by hand first ` +
          '(two rows under the checker id would be ambiguous — the canonical checker is never added alongside a customized twin)',
      );
    }
    const applyHint = `node "${fileURLToPath(import.meta.url)}" --kit-tools "${kitTools}" --cwd "${args.cwd}" --apply`;
    if (!args.apply) {
      out(formatPreview(analysis, applyHint));
      return 0;
    }
    const acted = analysis.plan.filter((r) => r.action !== 'keep');
    if (acted.length && declaration.outcome === 'loaded') {
      const merged = { ...parsed, gates: resultingGates(analysis.plan) };
      const writtenPath = writeAtomic(args.cwd, `${JSON.stringify(merged, null, 2)}\n`, lstatFn);
      out(`[agent-workflow] migrated ${writtenPath}: ${acted.map((r) => `${r.action} ${r.entry.id}`).join(', ')}`);
    }
    for (const p of retiredStores) {
      try {
        unlinkSync(p);
        out(`  cleaned ${p} (a retired kit-owned store)`);
      } catch (e) {
        if (e.code !== 'ENOENT') out(`  could not clean ${p} (${e.code ?? e.message}) — dead data, remove it by hand; the migration itself is unaffected`);
      }
    }
    // The warnings survive EVERY apply outcome — a no-op apply must still say what needs a hand.
    for (const line of warningLines(analysis)) out(line);
    if (!acted.length && !retiredStores.length) {
      out(
        analysis.finalCapable
          ? '[agent-workflow] nothing to migrate — the declaration is already final-run-capable and no retired stores remain.'
          : '[agent-workflow] nothing to migrate mechanically — no canonical legacy entries and no retired stores remain; the warnings above still need a hand.',
      );
    }
    return 0;
  } catch (e) {
    err(e.message);
    return e.exitCode ?? 1;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = main();
