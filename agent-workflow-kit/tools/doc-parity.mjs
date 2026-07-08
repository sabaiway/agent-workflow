#!/usr/bin/env node
// doc-parity.mjs — the deterministic doc-drift lint behind `/agent-workflow-kit doc-parity`
// (BUGFREE-3 / AD-049, economics item (b)). A whole class of BUGFREE-2 review churn came from a
// mode-contract doc silently lagging a code constant (a `--check` doc still saying "300" after the
// diff cap moved to 400). This tool closes it mechanically: a CLOSED, exported registry of bindings
// each ties ONE live code constant to the exact token its contract doc must carry, and the checker
// asserts the current value renders into every bound `references/modes/*.md` file.
//
// Why the modes/*.md docs and not the tool HELP strings: every tool's HELP INTERPOLATES the same
// constant (`the ${DEFAULT_DIFF_CAP}-line diff cap`), so it can never drift from the code — there is
// nothing to check there. The hand-authored contract prose in `references/modes/*.md` is the surface
// that DOES drift, so that is exactly what this lint pins. The numeric/version tokens are IMPORTED
// live from the tools (never re-typed here), and the ledger vocabulary is sourced from the schema's
// own exported `V4_CLASSES` / `V4_OVERRIDE_SCOPES` Sets — so the registry cannot itself go stale.
//
// Edit-safe by construction (the U2-DEBT closed-world lesson): adding a binding ADDS a checked entry;
// it never widens a blocklist. A token that stops appearing, a file that cannot be read, or an
// unknown binding all FAIL CLOSED — never a silent pass.
//
// Read-only: never writes, never commits, never runs a subscription CLI, spawns nothing. Dependency-
// free, Node >= 18. No side effects on import (the isDirectRun idiom).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SCHEMA_VERSION, REVIEW_CAP, V4_CLASSES, V4_OVERRIDE_SCOPES } from './review-ledger.mjs';
import { HARD_MAX, DEFAULT_DIFF_CAP } from './review-ledger-write.mjs';
import { RESULT_SCHEMA_VERSION } from './fold-completeness.mjs';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REVIEW_LEDGER_DOC = 'references/modes/review-ledger.md';
const FOLD_DOC = 'references/modes/fold-completeness.md';

// A typed usage failure (exit 2) for the CLI parser — the codebase's typed-error idiom (no classes).
const usageFail = (message) => Object.assign(new Error(message), { exitCode: 2 });

// ── the closed binding registry ──────────────────────────────────────────────────────
// Each binding: { constant, value (live), token (value rendered into the doc's exact phrasing),
// files[] (the contract docs that MUST carry the token) }. The token phrasings match the current
// prose in the named files; a value drift makes the current-value token absent → a loud failure.
const valueBinding = (constant, value, phrase, files) => ({ constant, value, token: phrase, files });

// The ledger vocabulary — sourced from the schema's own exported Sets plus the v4 `gate-run` kind,
// so the closed set can never disagree with the code. Every word must appear in the ledger contract.
const LEDGER_VOCAB = [...V4_CLASSES, ...V4_OVERRIDE_SCOPES, 'gate-run'];

export const BINDINGS = Object.freeze([
  valueBinding('SCHEMA_VERSION', SCHEMA_VERSION, `schema v${SCHEMA_VERSION}`, [REVIEW_LEDGER_DOC]),
  valueBinding('HARD_MAX', HARD_MAX, `hard-max ceiling of ${HARD_MAX}`, [REVIEW_LEDGER_DOC]),
  valueBinding('DEFAULT_DIFF_CAP', DEFAULT_DIFF_CAP, `default ${DEFAULT_DIFF_CAP}`, [REVIEW_LEDGER_DOC]),
  valueBinding('REVIEW_CAP', REVIEW_CAP, `cap ≤${REVIEW_CAP}`, [REVIEW_LEDGER_DOC]),
  valueBinding('RESULT_SCHEMA_VERSION', RESULT_SCHEMA_VERSION, `schema v${RESULT_SCHEMA_VERSION}`, [FOLD_DOC]),
  ...LEDGER_VOCAB.map((word) => valueBinding(`vocab:${word}`, word, word, [REVIEW_LEDGER_DOC])),
].map((b) => Object.freeze(b)));

// ── the pure checker (readText is injectable for hermetic tests) ────────────────────────
// checkBinding(binding, readText) → { constant, token, files: [{ rel, ok, reason }], ok }.
// readText(rel) returns the file text or THROWS (an unreadable bound file fails closed).
export const checkBinding = (binding, readText) => {
  const files = binding.files.map((rel) => {
    let text;
    try {
      text = readText(rel);
    } catch (err) {
      return { rel, ok: false, reason: `unreadable (${(err && err.code) || (err && err.message) || 'read failed'})` };
    }
    const present = text.includes(binding.token);
    return { rel, ok: present, reason: present ? null : `token ${JSON.stringify(binding.token)} not found` };
  });
  return { constant: binding.constant, token: binding.token, files, ok: files.every((f) => f.ok) };
};

const defaultReadText = (rel) => readFileSync(resolve(KIT_ROOT, rel), 'utf8');

// checkParity(bindings, readText) → [ per-binding result ]. Default reads the real modes/*.md files
// relative to the kit root.
export const checkParity = (bindings = BINDINGS, readText = defaultReadText) => bindings.map((b) => checkBinding(b, readText));

// ── rendering ───────────────────────────────────────────────────────────────────────
const formatHuman = (results) => {
  const lines = ['doc-parity — code constants ⟷ references/modes/*.md contract (read-only, BUGFREE-3)'];
  for (const r of results) {
    for (const f of r.files) {
      lines.push(`  ${f.ok ? '✓' : '✗'} ${r.constant} → ${f.rel}${f.ok ? '' : ` — ${f.reason}`}`);
    }
  }
  const failed = results.flatMap((r) => r.files.filter((f) => !f.ok).map((f) => `${r.constant} @ ${f.rel}`));
  lines.push(`  check: ${failed.length === 0 ? 'PASS' : 'FAIL'} — ${failed.length === 0 ? `${results.length} binding(s) consistent` : `${failed.length} drifted binding(s): ${failed.join('; ')}`}`);
  return lines.join('\n');
};

const HELP = `doc-parity — deterministic doc-drift lint for the agent-workflow family (BUGFREE-3 / AD-049).

Usage:
  node doc-parity.mjs [--check | --json]

A CLOSED, exported registry binds each live code constant (review-ledger SCHEMA_VERSION / REVIEW_CAP,
review-ledger-write HARD_MAX / DEFAULT_DIFF_CAP, fold-completeness RESULT_SCHEMA_VERSION) and the
ledger vocabulary (V4_CLASSES / V4_OVERRIDE_SCOPES + gate-run) to the exact token its
references/modes/*.md contract must carry, and asserts the CURRENT value renders into every bound
file. A drifted doc, an unreadable bound file, or an absent token FAILS CLOSED.

--check exits 0/1 as a gate (declare it in docs/ai/gates.json by hand). --json prints the structured
result. Default prints the per-binding report.

Read-only: never writes, never commits, spawns nothing. Exit codes: 0 pass (or plain report); 1 drift
(under --check) or error; 2 usage.`;

const KNOWN_ARGS = new Set(['--help', '-h', '--check', '--json']);

export const main = (argv, ctx = {}) => {
  const readText = ctx.readText ?? defaultReadText;
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    const unknown = argv.find((a) => !KNOWN_ARGS.has(a));
    if (unknown !== undefined) throw usageFail(`unknown argument: ${unknown}`);
    const results = checkParity(BINDINGS, readText);
    const failed = results.filter((r) => !r.ok);
    if (argv.includes('--json')) {
      return { code: argv.includes('--check') && failed.length > 0 ? 1 : 0, stdout: JSON.stringify({ results, ok: failed.length === 0 }, null, 2), stderr: '' };
    }
    if (argv.includes('--check')) {
      const reason = failed.length === 0 ? `${results.length} binding(s) consistent` : `${failed.length} drifted binding(s): ${failed.map((r) => r.constant).join(', ')} — update the contract doc(s) in the SAME edit as the code`;
      return { code: failed.length === 0 ? 0 : 1, stdout: `doc-parity check: ${failed.length === 0 ? 'PASS' : 'FAIL'} — ${reason}`, stderr: '' };
    }
    return { code: 0, stdout: formatHuman(results), stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `doc-parity: ${err.message}` };
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const r = main(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
}
