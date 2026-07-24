#!/usr/bin/env node
// doc-parity.mjs — the deterministic doc-drift lint behind `/agent-workflow-kit doc-parity`
// (BUGFREE-3 / AD-049, economics item (b)). A whole class of BUGFREE-2 review churn came from a
// mode-contract doc silently lagging a code constant (a `--check` doc still saying "300" after the
// diff cap moved to 400). This tool closes it mechanically: a CLOSED, exported registry of bindings
// each ties ONE live code constant to the exact token its contract doc must carry, and the checker
// asserts the current value renders into every bound `references/modes/*.md` file.
//
// Why the modes/*.md docs and not the tool HELP strings: every tool's HELP INTERPOLATES the same
// constant, so it can never drift from the code — there is nothing to check there. The
// hand-authored contract prose in `references/modes/*.md` is the surface that DOES drift, so that
// is exactly what this lint pins. The tokens are IMPORTED live from the tools (never re-typed
// here) — so the registry cannot itself go stale.
//
// Edit-safe by construction (the U2-DEBT closed-world lesson): adding a binding ADDS a checked entry;
// it never widens a blocklist. A token that stops appearing, a file that cannot be read, or an
// unknown binding all FAIL CLOSED — never a silent pass.
//
// Read-only: never writes, never commits, never runs a subscription CLI, spawns nothing. Dependency-
// free, Node >= 22. No side effects on import (the isDirectRun idiom).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT as DOCTOR_EXIT, STATUS as DOCTOR_STATUS, TRUSTED_DIRS as DOCTOR_TRUSTED_DIRS } from './autonomy-doctor.mjs';
import {
  RECOMMENDATIONS_SECTION_HEADER,
  RECOMMENDATIONS_EMPTY_LINE,
  VERDICT_ATTENTION_TEMPLATE,
  VERDICT_NOTHING_BROKEN,
  VERDICT_OPTIONAL_TEMPLATE,
  VERDICT_SKIPS_TEMPLATE,
  ACKS_FILE,
} from './recommendations.mjs';
import { SKIPPED_READONLY } from './setup-backends.mjs';
import { LATENT_ARM_NOTICE } from './review-state.mjs';
import { QUEUE_SHARED_RULE, LANDING_FROM_MAIN, NO_DEPENDENCIES_POSTURE, CLEANUP_OWNERSHIP_RULE, INCLUDE_IDENTITY_RULE, RESUME_VERIFY_RULE } from './worktrees.mjs';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const AUTONOMY_DOCTOR_DOC = 'references/modes/autonomy-doctor.md';
const RECOMMENDATIONS_DOC = 'references/modes/recommendations.md';
const UPGRADE_DOC = 'references/modes/upgrade.md';
const VELOCITY_DOC = 'references/modes/velocity.md';
const SETUP_DOC = 'references/modes/setup.md';
const REVIEW_STATE_DOC = 'references/modes/review-state.md';
const WORKTREES_DOC = 'references/modes/worktrees.md';

// A typed usage failure (exit 2) for the CLI parser — the codebase's typed-error idiom (no classes).
const usageFail = (message) => Object.assign(new Error(message), { exitCode: 2 });

// ── the closed binding registry ──────────────────────────────────────────────────────
// Each binding: { constant, value (live), token (value rendered into the doc's exact phrasing),
// files[] (the contract docs that MUST carry the token) }. The token phrasings match the current
// prose in the named files; a value drift makes the current-value token absent → a loud failure.
const valueBinding = (constant, value, phrase, files) => ({ constant, value, token: phrase, files });

// The autonomy-doctor D7 contract (AD-044 Plan 2): the live EXIT table + every status token must
// render into the mode's contract doc. `usage` is skipped as a bare-word token (trivially present
// everywhere) — its exit-code phrase below pins that outcome instead.
const DOCTOR_EXIT_PHRASES = [
  ['ready', `\`${DOCTOR_EXIT.ready}\` ready`],
  ['stop', `\`${DOCTOR_EXIT.stop}\` precondition STOP`],
  ['usage', `\`${DOCTOR_EXIT.usage}\` usage`],
  ['notReady', `\`${DOCTOR_EXIT.notReady}\` not-ready diagnosis`],
  ['installFailed', `\`${DOCTOR_EXIT.installFailed}\` install failed`],
  ['verifyFailed', `\`${DOCTOR_EXIT.verifyFailed}\` verify failed`],
  ['unsupported', `\`${DOCTOR_EXIT.unsupported}\` unsupported / untrusted`],
];

export const BINDINGS = Object.freeze([
  ...DOCTOR_EXIT_PHRASES.map(([key, phrase]) => valueBinding(`doctor-exit:${key}`, DOCTOR_EXIT[key], phrase, [AUTONOMY_DOCTOR_DOC])),
  ...Object.values(DOCTOR_STATUS)
    .filter((token) => token !== DOCTOR_STATUS.usage)
    .map((token) => valueBinding(`doctor-status:${token}`, token, token, [AUTONOMY_DOCTOR_DOC])),
  valueBinding('doctor-trusted-dirs', DOCTOR_TRUSTED_DIRS.join(':'), DOCTOR_TRUSTED_DIRS.join(':'), [AUTONOMY_DOCTOR_DOC]),
  // The upgrade Recommendations section contract (AD-044 Plan 4 + REC-UX-REWORK D1): the section
  // header, the exact empty-state line, and the frozen verdict templates must render in BOTH the
  // mode doc and upgrade.md (both exits reference them) — a reworded doc would silently break the
  // presentation contract (facts/counts complete, commands byte-exact).
  valueBinding('recommendations-header', RECOMMENDATIONS_SECTION_HEADER, RECOMMENDATIONS_SECTION_HEADER, [RECOMMENDATIONS_DOC, UPGRADE_DOC]),
  valueBinding('recommendations-empty-line', RECOMMENDATIONS_EMPTY_LINE, RECOMMENDATIONS_EMPTY_LINE, [RECOMMENDATIONS_DOC, UPGRADE_DOC]),
  valueBinding('verdict-attention', VERDICT_ATTENTION_TEMPLATE, VERDICT_ATTENTION_TEMPLATE, [RECOMMENDATIONS_DOC, UPGRADE_DOC]),
  valueBinding('verdict-nothing-broken', VERDICT_NOTHING_BROKEN, VERDICT_NOTHING_BROKEN, [RECOMMENDATIONS_DOC, UPGRADE_DOC]),
  valueBinding('verdict-optional', VERDICT_OPTIONAL_TEMPLATE, VERDICT_OPTIONAL_TEMPLATE, [RECOMMENDATIONS_DOC, UPGRADE_DOC]),
  valueBinding('verdict-skips', VERDICT_SKIPS_TEMPLATE, VERDICT_SKIPS_TEMPLATE, [RECOMMENDATIONS_DOC, UPGRADE_DOC]),
  // The ack-store apply target (AD-055 Part I): the family-owned docs/ai/acks.json path — a
  // drift-guarded constant so the mode docs' ack-store references cannot silently outdate the code
  // (the incident's "mode-doc apply text stays in lockstep" acceptance as a mechanism, not prose).
  // Bound in BOTH docs that name the path (recommendations.md + velocity.md).
  valueBinding('acks-file', ACKS_FILE, ACKS_FILE, [RECOMMENDATIONS_DOC, VELOCITY_DOC]),
  // The refresh read-only degrade outcome (REFRESH-EROFS-HONESTY / AD-056): the new skipped-readonly
  // token must render in BOTH mode contracts that enumerate the placed-bridge refresh outcomes
  // (setup.md owns --refresh-placed; upgrade.md pastes its lines) — a reworded doc dropping the
  // outcome fails this pin plus the gate. The token tracks the exported SETUP constant.
  valueBinding('refresh-skipped-readonly', SKIPPED_READONLY, SKIPPED_READONLY, [SETUP_DOC, UPGRADE_DOC]),
  // The "the tool knows and does not say" contract: a clean-tree PASS must still name a latent arm.
  // It was a prose-only bar a doc could silently drop, so it is pinned to the live string the tool
  // actually emits — a reworded doc dropping the notice fails this pin plus the gate.
  valueBinding('latent-arm-notice', LATENT_ARM_NOTICE, LATENT_ARM_NOTICE, [REVIEW_STATE_DOC]),
  // The provision-record orientation contract (same "the tool knows and does not say" class): the
  // shared-queue rule, the landing-from-main fact, and the no-dependencies install posture were
  // prose-only bars a doc could silently drop, so all are pinned to the live strings the record
  // actually carries.
  valueBinding('queue-shared-rule', QUEUE_SHARED_RULE, QUEUE_SHARED_RULE, [WORKTREES_DOC]),
  valueBinding('landing-from-main', LANDING_FROM_MAIN, LANDING_FROM_MAIN, [WORKTREES_DOC]),
  valueBinding('no-dependencies-posture', NO_DEPENDENCIES_POSTURE, NO_DEPENDENCIES_POSTURE, [WORKTREES_DOC]),
  // The cleanup-ownership contract (AD-069): the exact live sentence every ownership STOP emits —
  // a reworded mode doc dropping the class × lane contract fails this pin plus the gate.
  valueBinding('cleanup-ownership-rule', CLEANUP_OWNERSHIP_RULE, CLEANUP_OWNERSHIP_RULE, [WORKTREES_DOC]),
  // The include-identity contract (F3): the exact live sentence every include-identity STOP emits —
  // a reworded mode doc dropping the preflight-binding × door-time-queue contract fails this pin
  // plus the gate.
  valueBinding('include-identity-rule', INCLUDE_IDENTITY_RULE, INCLUDE_IDENTITY_RULE, [WORKTREES_DOC]),
  // The resume-verify contract (slice R2): the exact live sentence every resume-verify STOP emits —
  // a reworded mode doc dropping the per-owned-path × session-never-probed contract fails this pin
  // plus the gate.
  valueBinding('resume-verify-rule', RESUME_VERIFY_RULE, RESUME_VERIFY_RULE, [WORKTREES_DOC]),
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

A CLOSED, exported registry binds each live code constant — the autonomy-doctor contract (the EXIT
table, the status tokens, the trusted-dir allowlist), the recommendations/upgrade presentation
contract (section header, empty line, verdict templates), the acks-store path, the setup refresh
degrade token, the review-state clean-tree latent-arm notice, the worktrees provision-record
orientation contract (shared-queue rule, landing-from-main, no-dependencies install posture), the
worktrees cleanup-ownership rule, the worktrees include-identity rule, and the worktrees
resume-verify rule — to
the exact token its references/modes/*.md contract must carry, and
asserts the CURRENT value renders into every bound file. A drifted doc, an unreadable bound file,
or an absent token FAILS CLOSED.

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
