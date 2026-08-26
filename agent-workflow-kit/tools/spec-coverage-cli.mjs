#!/usr/bin/env node
// The CLI half of the coverage requirement: argv, fs and the debt record. No rule lives here (the
// rule is spec-coverage.mjs), and the ratchet is enforced HERE because it is the only write.
//
// Exit codes: 0 accept; 1 refuse (an uncovered tool, or a settled debt entry still recorded); 2
// usage — an unknown flag, a flag with no value, an unreadable scope or store, a reasonless write.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isDirectRun } from './direct-run.mjs';
import { claimsOf, formatFindings, judgeCoverage, settleAfter } from './spec-coverage.mjs';

export const SCOPE_PATH = join('docs', 'ai', 'spec-coverage.json');
export const STORE_ROOT = join('docs', 'ai', 'specs');
const REASON_MAX_BYTES = 300;

const HELP = `spec-coverage — every shipped tool is governed by a contract, or the debt names it.

Usage:
  node spec-coverage-cli.mjs --report      [--root <dir>]
  node spec-coverage-cli.mjs --check       [--root <dir>]
  node spec-coverage-cli.mjs --write-debt --reason "<what was paid, and by which contract>" [--root <dir>]

--report      one line per in-scope tool: the contract that covers it, or that none does.
--check       refuses an in-scope tool no contract claims and is not recorded as debt, and a
              recorded entry that is already settled — the record must not overstate the debt.
--write-debt  records what was PAID: every adopted path whose contract now exists moves into the
              settled set, and nothing else changes. It never touches the adoption baseline, so a
              path outside it cannot be invented — it is refused by name. Write the contract first.

Scope and debt: ${SCOPE_PATH}. Contracts: ${STORE_ROOT}. Exit codes: 0 accept; 1 refuse; 2 usage.`;

const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });
const posix = (p) => p.split(sep).join('/');

// A scope this tool cannot trust is worse than no scope: `{}`, an empty `roots`, or an `exclude`
// carrying an empty string all yield a census of ZERO tools and a cheerful PASS — a gate answering
// about a domain it never looked at, which is the exact failure this whole rung exists to end.
const validateScope = (scope, path) => {
  const bad = (why) => { throw fail(2, `the coverage scope ${path} is unusable: ${why}`); };
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) bad('it is not an object');
  if (scope.schema !== 1) bad(`schema must be 1, got ${JSON.stringify(scope.schema)}`);
  const list = (key, required) => {
    const value = scope[key];
    if (value === undefined && !required) return [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v === '')) bad(`${key} must be an array of non-empty strings`);
    if (required && value.length === 0) bad(`${key} is empty, so nothing would ever be judged`);
    return value;
  };
  list('roots', true);
  const extensions = list('extensions', true);
  if (extensions.some((ext) => !ext.startsWith('.'))) bad('every extension starts with a dot');
  list('exclude', false);
  // Both recorded sets are PATHS. `Array.isArray` alone let `[42]` through, and a scope the tool
  // cannot trust is the thing this validator exists to catch.
  if (!Array.isArray(scope.adopted)) bad('adopted is the frozen set measured at adoption, and it must be an array');
  list('adopted', false);
  list('settled', false);
  return scope;
};

const readJson = (path, what) => {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw fail(2, `cannot read ${what} ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw fail(2, `${what} ${path} is not valid JSON: ${err.message}`);
  }
};

// Deterministic order in both walks: a report a human compares between runs must not depend on the
// order a directory happens to be read in.
const sorted = (entries) => [...entries].sort((a, b) => (a.name < b.name ? -1 : 1));

export const specDocuments = (root, io = { readdirSync, readFileSync }) => {
  const out = [];
  const walk = (dir) => {
    for (const entry of sorted(io.readdirSync(dir, { withFileTypes: true }))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) out.push({ rel: posix(relative(root, full)), text: io.readFileSync(full, 'utf8') });
    }
  };
  walk(join(root, STORE_ROOT));
  return out;
};

// A test file is never in scope: a contract governs the module, and its tests are the evidence FOR
// that contract, not a second thing to write one for. A `<name>.test/` directory is the same answer.
export const toolsIn = (root, scope, io = { readdirSync }) => {
  const extensions = scope.extensions ?? ['.mjs'];
  // A textual prefix is not a path. `.../fixtures` would also hide `.../fixtures-escape.mjs`, so a
  // new tool could leave the scope by being named next to an excluded directory. The boundary is a
  // path COMPONENT: the entry itself, or something under it.
  const excluded = (rel) => (scope.exclude ?? []).some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
  const isTest = (name) => extensions.some((ext) => name.endsWith(`.test${ext}`));
  const out = [];
  const walk = (dir) => {
    for (const entry of sorted(io.readdirSync(dir, { withFileTypes: true }))) {
      const full = join(dir, entry.name);
      const rel = posix(relative(root, full));
      if (excluded(rel)) continue;
      if (entry.isDirectory()) {
        if (!entry.name.endsWith('.test')) walk(full);
      } else if (extensions.some((ext) => entry.name.endsWith(ext)) && !isTest(entry.name)) out.push(rel);
    }
  };
  for (const scopeRoot of scope.roots ?? []) walk(join(root, scopeRoot));
  return out;
};

const parseArgv = (argv) => {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { mode: 'help' };
  const options = { mode: null, root: process.cwd(), reason: null };
  const seen = new Set();
  const valueOf = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) throw fail(2, `${flag} takes a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--report' || arg === '--check' || arg === '--write-debt') {
      if (options.mode) throw fail(2, `--${options.mode} was already given — name exactly one mode`);
      options.mode = arg.slice(2);
    } else if (arg === '--root' || arg === '--reason') {
      if (seen.has(arg)) throw fail(2, `${arg} was given twice — each option is named exactly once`);
      seen.add(arg);
      options[arg === '--root' ? 'root' : 'reason'] = valueOf(index, arg);
      index += 1;
    } else throw fail(2, `unknown argument "${arg}" — run with --help`);
  }
  if (!options.mode) throw fail(2, 'one of --report, --check or --write-debt is required — run with --help');
  // A repayment with no stated reason is how a ratchet becomes a rubber stamp: the reason is recorded
  // in the file it changes and is what the commit message and the changelog restate.
  if (options.mode === 'write-debt' && !options.reason) throw fail(2, '--write-debt requires --reason "<what was paid, and by which contract>"');
  if (options.reason && Buffer.byteLength(options.reason, 'utf8') > REASON_MAX_BYTES) {
    throw fail(2, `a reason must be at most ${REASON_MAX_BYTES} UTF-8 bytes, got ${Buffer.byteLength(options.reason, 'utf8')}`);
  }
  return options;
};

export const main = (argv, { log = console.log, error = console.error, io } = {}) => {
  let options;
  try {
    options = parseArgv(argv);
  } catch (err) {
    error(err.message);
    return err.exitCode ?? 2;
  }
  if (options.mode === 'help') {
    log(HELP);
    return 0;
  }

  let scope;
  let judged;
  let unreadable;
  try {
    scope = validateScope(readJson(join(options.root, SCOPE_PATH), 'the coverage scope'), join(options.root, SCOPE_PATH));
    const documents = specDocuments(options.root, io);
    const found = claimsOf(documents);
    unreadable = found.unreadable;
    const tools = toolsIn(options.root, scope, io);
    // A census of nothing is not a pass. Either the roots are wrong or the tree is not what the
    // scope describes; both are refusals, never a green.
    if (tools.length === 0) throw fail(2, `the declared roots (${(scope.roots ?? []).join(', ')}) hold no file this scope would judge — a census of zero is not a pass`);
    judged = judgeCoverage({ tools, claims: found.claims, adopted: scope.adopted, settled: scope.settled ?? [] });
  } catch (err) {
    error(err.message);
    return err.exitCode ?? 2;
  }

  if (options.mode === 'report') {
    for (const { path, by } of judged.covered) log(`${path}\tcovered\t${by}`);
    for (const path of judged.uncovered) log(`${path}\tuncovered\t-`);
    for (const path of judged.debt) log(`${path}\tdebt\t-`);
    return 0;
  }

  if (options.mode === 'write-debt') {
    // What is PAYABLE is a subset of what was ADOPTED by construction — it is the owed set filtered,
    // and the owed set is the baseline minus what is already settled. So this write cannot invent a
    // path even in principle; `settleAfter` states that as a rule and refuses one directly, which is
    // where it is asserted. A branch here would be unreachable, and an unreachable guard is not a
    // guard: it is a claim nobody can check.
    const next = settleAfter(scope.adopted, scope.settled ?? [], judged.payable);
    // `adopted` is never rewritten here: it is the state this write is judged against.
    writeFileSync(join(options.root, SCOPE_PATH), `${JSON.stringify({ ...scope, reason: options.reason, settled: next.settled }, null, 2)}\n`);
    log(`spec-coverage: debt ${judged.debt.length} → ${judged.debt.length - next.added.length} (${next.added.length} paid and recorded)`);
    log(`reason: ${options.reason}`);
    return 0;
  }

  const findings = formatFindings({ ...judged, unreadable });
  if (findings.length === 0) {
    log(`spec-coverage: PASS — ${judged.covered.length} tool(s) governed by a contract, ${judged.debt.length} still owed`);
    return 0;
  }
  error(`spec-coverage: FAIL — ${findings.length} finding(s) against ${join(options.root, SCOPE_PATH)}:`);
  for (const line of findings) error(line);
  error('spec-coverage: WHY — no work is done without a specification; a tool no contract governs promises nothing anyone can check.');
  return 1;
};

if (isDirectRun(import.meta.url)) process.exitCode = main(process.argv.slice(2));
