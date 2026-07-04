// Contract guard for the bootstrap/upgrade REPORT surface (the "humanize the deploy/version report"
// change). The internal `docs/ai` structure version (`deploymentHead`) is un-actionable in the happy
// path and was leaking into every successful report — including zero-diff no-ops. This static
// text-drift guard pins the acceptance invariants A1–A6 over the SKILL.md prose STRUCTURE (never a
// conversational-language string), so a future edit can't quietly re-leak the number where it is inert,
// or drop it where it is actionable. There is no runtime that "executes" SKILL.md prose, so this is the
// automatable half of the "No changes without tests" Hard Constraint for a prose-contract change (same
// pattern as backend-status-line / skill-status-contract).
//
// Dev-only repo test (test/ is outside the package `files` whitelist — not shipped in the tarball).

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = readFileSync(resolve(kitRoot, 'SKILL.md'), 'utf8');
// Post-split (the progressive-disclosure router): the report contracts live in the shared
// report-footer file; the mode procedures live in references/modes/<key>.md. The router keeps
// only the routing surfaces — the whole-file routing asserts below stay on SKILL.
const FOOTER_FILE = readFileSync(resolve(kitRoot, 'references', 'shared', 'report-footer.md'), 'utf8');
const UPGRADE_FILE = readFileSync(resolve(kitRoot, 'references', 'modes', 'upgrade.md'), 'utf8');
const STATUS_FILE = readFileSync(resolve(kitRoot, 'references', 'modes', 'status.md'), 'utf8');
const BOOTSTRAP_FILE = readFileSync(resolve(kitRoot, 'references', 'modes', 'bootstrap.md'), 'utf8');

// Slice the text between two anchor substrings (to = end-of-file when omitted).
const between = (text, from, to) => {
  const a = text.indexOf(from);
  assert.notEqual(a, -1, `the split corpus is missing the anchor: "${from}"`);
  const b = to ? text.indexOf(to, a + from.length) : text.length;
  assert.notEqual(b, -1, `the split corpus is missing the anchor: "${to}"`);
  return text.slice(a, b);
};
// Collapse all whitespace so assertions survive source re-wrapping (the contract wraps across lines).
const flat = (s) => s.replace(/\s+/g, ' ');

// The leak tokens the happy path must never surface to the user.
const SEMVER = /\b\d+\.\d+\.\d+\b/;
const STRUCTURE_LABEL_LEAK = /Deployment structure:/; // the old version-block line-1 label
const STAMP_PATH = /\.workflow-version/;
const TWO_AXES_COMPARISON = /npm\/GitHub/i; // the "GitHub shows a bigger number" note

// The plain, user-facing NAME the number must carry when it IS shown (never "lineage head").
const STRUCTURE_NAME = /docs\/ai` structure version/;

// ── Regions (anchor-existence keeps the missing-anchor-is-red property) ──────
const footer = flat(between(FOOTER_FILE, '### The version block + welcome mat', '### Version disclosure'));
const disclosure = flat(between(FOOTER_FILE, '### Version disclosure', ''));
const upgrade = between(UPGRADE_FILE, '### Mode: upgrade', '');
const equalHead = flat(between(upgrade, 'Equal-head exit — a real successful-exit report', '5. Show the relevant'));
const stopGate = flat(between(upgrade, '2. **Never-downgrade gate — FIRST', '3. **Reconcile the bounded pointers'));
const step8 = flat(between(upgrade, '8. Re-stamp `docs/ai/.workflow-version`', ''));
const status = flat(between(STATUS_FILE, '### Mode: status', ''));
const bootstrap = flat(between(BOOTSTRAP_FILE, '### Mode: bootstrap', ''));

describe('report contract — the happy path hides the docs/ai structure number (A1)', () => {
  it('the shared report footer surfaces no structure semver / stamp path / head|lineage wording', () => {
    assert.doesNotMatch(footer, SEMVER, 'no version number in the shared happy-path footer');
    assert.doesNotMatch(footer, STRUCTURE_LABEL_LEAK, 'the "Deployment structure:" line-1 is gone from the footer');
    assert.doesNotMatch(footer, STAMP_PATH, 'no .workflow-version stamp path in the happy-path footer');
    assert.doesNotMatch(footer, /lineage/i, 'no "lineage" vocabulary in the happy-path footer');
    assert.doesNotMatch(footer, /\bhead\b/i, 'no "head" axis vocabulary in the happy-path footer');
    assert.doesNotMatch(footer, TWO_AXES_COMPARISON, 'the two-axes note is not in the happy-path footer');
  });

  it('the footer frames the happy path as "settings already current — no update required"', () => {
    assert.match(footer, /settings already current/i);
    assert.match(footer, /no update is required/i);
    // The message is rendered in the user's language, never hardcoded (illustrative RU is only an example).
    assert.match(footer, /in the user's conversational language/i);
    assert.match(footer, /never hardcode a phrase/i);
    // A fresh bootstrap gets its OWN success framing (a deploy is not "no update needed") — minus the number.
    assert.match(footer, /fresh `bootstrap`.{0,60}minus the number/i,
      'a fresh bootstrap keeps its deploy-success framing (not "settings already current"), still number-free');
  });

  it('the equal-head exit hides the number and the two-axes note', () => {
    assert.doesNotMatch(equalHead, SEMVER, 'no version number on the equal-head exit');
    assert.doesNotMatch(equalHead, STRUCTURE_LABEL_LEAK);
    assert.doesNotMatch(equalHead, STAMP_PATH);
    assert.doesNotMatch(equalHead, TWO_AXES_COMPARISON, 'no two-axes note on the equal-head exit');
    assert.doesNotMatch(equalHead, /deployment-lineage head/i, 'the equal-head exit no longer recites the lineage head');
  });

  it('the equal-head exit distinguishes a writeful reconcile from a pure no-op (not misreported as no-op)', () => {
    // A stamp-independent step-3 reconcile (pointer slot / orchestration.json / hidden footprint) may
    // have JUST written something — that is NOT "settings already current / no update needed".
    assert.match(equalHead, /added the slot \(or anything else changed\), report it and ask/i,
      'a writeful reconcile reports what changed and asks');
    assert.match(equalHead, /pure zero-diff no-op.{0,80}settings already current/i,
      'only a pure zero-diff no-op is framed "settings already current"');
  });
});

describe('report contract — the structure line survives only where it is actionable (A2)', () => {
  it('the number is named "docs/ai structure version" on the explicit status view', () => {
    assert.match(status, STRUCTURE_NAME, 'Mode: status shows the docs/ai structure version');
  });
  it('the number is shown at the never-downgrade STOP gate', () => {
    assert.match(stopGate, STRUCTURE_NAME, 'the STOP gate shows the docs/ai structure version');
  });
});

describe('report contract — the two-axes note is plain + gated on demand (A3)', () => {
  it('Version disclosure defines the plain two-axes note, gated to exactly three surfaces', () => {
    assert.match(disclosure, TWO_AXES_COMPARISON, 'the two-axes note names the npm/GitHub package number');
    assert.match(disclosure, /package version/i);
    assert.match(disclosure, /not.{0,4}a newer deployment/i);
    assert.match(disclosure, /on demand only/i);
    // The three (and only three) surfaces: STOP, explicit status view, explicit user ask.
    assert.match(disclosure, /never-downgrade STOP/i);
    assert.match(disclosure, /version-status view|Mode: status/i);
    assert.match(disclosure, /user explicitly asks/i);
  });
});

describe('report contract — a migration that ran is described in human terms (A4)', () => {
  it('step 8 describes the change plainly and OMITS the raw number (no leak on a successful report)', () => {
    assert.match(step8, /describe what the upgrade changed in plain human terms/i);
    assert.match(step8, /\bomit the raw structure number/i);
    assert.doesNotMatch(step8, /may omit the raw structure number/i, 'omission is mandatory here, not optional');
    // The preserved mechanics + shared-footer sequence (also pinned by backend-status-line.test.mjs).
    assert.match(step8, /Re-stamp.*backend-status line.*ask before committing/);
  });
});

describe('report contract — the STOP gate keeps the number + a plain two-axes note; routing untouched (A5)', () => {
  it('the STOP gate shows the number, the plain two-axes note, and names it — never "lineage head"', () => {
    assert.match(stopGate, STRUCTURE_NAME, 'the STOP shows the docs/ai structure version');
    assert.match(stopGate, /two-axes note/i, 'the STOP includes the plain two-axes note');
    assert.match(stopGate, /never.{0,20}"?lineage head"?/i, 'the STOP names the structure version, never "lineage head"');
  });
  it('the version-status check is framed as INTERNAL routing (never surfaced on every invocation)', () => {
    assert.match(SKILL, /### Version status & the two axes/, 'the routing section still exists');
    assert.doesNotMatch(SKILL, /surface this on every invocation/,
      'the routing header must not imply surfacing the version status on every invocation');
    assert.match(SKILL, /internal.{0,40}routing decision.{0,40}not.{0,40}line you print/i,
      'the version-status check is an internal routing decision, not user output');
  });
});

describe('report contract — the number, when shown, is never labelled "lineage head" (A6)', () => {
  it('Mode: status names it the docs/ai structure version and forbids the "lineage head" label', () => {
    assert.match(status, STRUCTURE_NAME);
    assert.match(status, /never.{0,4}"?lineage head"?/i, 'status explicitly forbids the "lineage head" label');
  });
  it('bootstrap does not separately surface the structure number (it uses the shared footer)', () => {
    // Bootstrap step 11 routes through the shared footer contract; it must not print its own semver line.
    assert.doesNotMatch(bootstrap, STRUCTURE_LABEL_LEAK, 'bootstrap has no "Deployment structure:" leak');
  });
});
