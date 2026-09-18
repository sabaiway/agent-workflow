// review-state-render.mjs — the human report and the mask advisory line.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_REL } from './orchestration-config.mjs';
import { escapeForDisplay, shellQuoteArg } from './repo-lex.mjs';
import { decideHeldSession } from './held-session.mjs';
import { ACTIVITY, SLOT, quoteReportName, rejectionCause } from './review-state-judge.mjs';

// ── the sandbox-masks advisory (D lane, AD-044 Plan 4 Phase 1.5) ────────────────────

export const maskAdvisoryLine = (state) =>
  state.maskedUntracked > 0
    ? `notice: ${state.maskedUntracked} never-committable untracked path(s) (device/FIFO/socket) are ignored by the review domain — hide them from git status: node ${shellQuoteArg(join(dirname(fileURLToPath(import.meta.url)), 'sandbox-masks.mjs'))} --cwd ${shellQuoteArg(state.root)} --apply`
    : '';

// ── rendering ───────────────────────────────────────────────────────────────────────

// The glyph reflects SATISFACTION, not bare state: a `current` row carrying a recognized
// NEGATIVE is an authoritative veto and renders ✗.
const STATE_GLYPH = { 'unrecognized-verdict': '✗', ungrounded: '✗', probe: '✗', rejected: '✗', stale: '✗', missing: '✗' };
const glyphFor = (b) => (b.state === 'current' ? (b.shipClass ? '✓' : '✗') : STATE_GLYPH[b.state]);

export const formatHuman = (state, check) => {
  const src = state.obligations.source === 'config' ? `from ${CONFIG_REL}` : 'computed default';
  const lines = [
    `review-state — ${ACTIVITY}.${SLOT} = ${state.obligations.recipe ?? '(unknowable)'} (${src})${state.requiredBackends.length ? ` → ${state.requiredBackends.join(' + ')}${state.obligations.perBackend ? '' : ' (any one, ship-class)'}` : ''}`,
  ];
  if (state.detectionWarning) lines.push(`  ⚠ ${state.detectionWarning}`);
  lines.push(`  plan in flight: ${state.plans.length ? state.plans.map((name) => quoteReportName(name)).join(', ') : '(none)'}`);
  if (state.fingerprint == null) lines.push(`  tree: ${state.location != null && state.location.state !== 'work-tree' ? `git location ${state.location.state} — ${escapeForDisplay(state.location.cause)}` : 'the fingerprint is undecidable (a git query failed or was killed)'}`);
  else if (state.clean === true) lines.push('  tree: clean (nothing to review)');
  else lines.push(`  tree fingerprint: ${state.fingerprint}`);
  if (state.heldSession != null) lines.push(`  ${decideHeldSession(state.heldSession).line}`);
  lines.push(`  receipts: ${state.receiptsPath == null ? '(unresolvable — no git dir)' : escapeForDisplay(state.receiptsPath)} (${state.receiptCount} line(s)${state.malformed ? `, ${state.malformed} malformed — inspect the file` : ''})`);
  if (state.receiptsReadError) lines.push(`  ⚠ receipts store unreadable (${state.receiptsReadError}) — inspect ${escapeForDisplay(state.receiptsPath)}`);
  if (state.evidenceUnavailable) lines.push(`  ⚠ evidence store unavailable (${state.evidenceMalformed} malformed line(s)${state.evidenceReadError ? `, read error: ${state.evidenceReadError}` : ''}) — the degrade escape is denied (fail-closed)`);
  const exempt = new Set(state.degradedExempt);
  for (const b of state.backends) {
    const exemptTag = exempt.has(b.backend) ? ' — degrade-recorded for the current tree (core-evidence store)' : '';
    const detail =
      b.state === 'current'
        ? `current (verdict: ${JSON.stringify(b.verdict)}${b.shipClass ? ', ship-class' : ' — a recognized negative, an authoritative VETO'}, grounded, ${b.timestamp ?? '?'})`
        : b.state === 'unrecognized-verdict'
          ? `latest normal receipt carries an unrecognized verdict (${JSON.stringify(b.verdict)}) — never attests (fail-closed)`
          : b.state === 'ungrounded'
            ? `ungrounded latest normal receipt (verdict: ${JSON.stringify(b.verdict)}) — a grounded fresh run is required`
            : b.state === 'probe'
              ? 'only probe receipts for the current tree (quality guards relaxed) — a probe review never attests'
              : b.state === 'rejected'
                ? `current-tree receipts rejected — ${rejectionCause(b)} (fail-closed)`
                : b.state === 'stale'
                  ? 'stale — no receipt matches the current tree (edited after review)'
                  : 'missing — no receipt from this backend';
    const excludedTag = b.probeExcluded || b.markerRejected || b.unmarkedRejected
      ? ` [excluded: ${b.probeExcluded} probe, ${b.markerRejected} malformed-marker, ${b.unmarkedRejected} unmarked]`
      : '';
    const liftTag = b.deltaLift != null ? ` — lifted to CURRENT through ${b.deltaLift} bookkeeping-delta link(s) (#61)` : '';
    const overrideTag = b.overrideLabel ? ` — ${b.overrideLabel}` : '';
    // ⊘ only where the escape actually applies: a PRODUCED receipt outranks the record — a
    // negative/unknown verdict keeps its ✗ (a degrade lifts neither; a maintainer-override does).
    const escapeApplies = (exempt.has(b.backend) && b.state !== 'current' && b.state !== 'unrecognized-verdict') || Boolean(b.overrideLabel);
    lines.push(`    ${escapeApplies ? '⊘' : glyphFor(b)} ${b.backend}: ${detail}${liftTag}${overrideTag}${excludedTag}${exemptTag}`);
  }
  lines.push(`  check: ${check.code === 0 ? 'PASS' : 'FAIL'} — ${check.reason}`);
  return lines.join('\n');
};
