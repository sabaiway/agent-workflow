import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The engine is the canonical source for the bounded autonomy slot fragment (AD-044 Plan 3) — the
// kit injects it verbatim into a deployed AGENTS.md between the workflow:autonomy markers, so it
// must stay one marker-free content line. Unlike the sibling slots, this fragment carries a READ
// CONTRACT, not just a pointer: an AGENTS.md-native executor (codex) gets only the merged entry
// point — never the kit — so the fragment itself must state where the policy lives, what applies
// when the file is absent (the canonical default floor — stable canon constants, not per-project
// values), and that a malformed policy is a loud STOP. The kit side pins the same floor against
// its own exports (REDLINE_DEFAULTS / DEFAULT_ACTIVITY_AUTONOMY), the both-directions pair.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLOT = join(ROOT, 'references', 'autonomy-slot.md');

const contentLines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);

describe('engine autonomy-slot.md — bounded one-line fragment (the AGENTS.md-native read contract)', () => {
  const slot = readFileSync(SLOT, 'utf8');

  it('exists and is non-empty', () => {
    assert.ok(slot.trim().length > 0, 'the autonomy slot fragment must not be empty');
  });

  it('is exactly one content line', () => {
    assert.equal(contentLines(slot).length, 1, 'the slot fragment must be exactly one content line');
  });

  it('carries no marker text (the kit frames it with the markers, the fragment must not)', () => {
    assert.ok(!slot.includes('<!--'), 'the fragment must not contain an HTML comment / marker');
    assert.ok(!slot.includes('workflow:autonomy'), 'the fragment must not contain the slot marker name');
  });

  it('names the policy file and tells the agent to READ it at session start', () => {
    assert.match(slot, /docs\/ai\/autonomy\.json/, 'names the per-project policy file');
    assert.match(slot, /[Rr]ead it at session start/, 'carries the read-at-start clause');
  });

  it('states the concrete default floor (absent file → the computed defaults ARE the policy)', () => {
    assert.match(slot, /computed defaults/, 'names the absent-file semantics');
    assert.ok(slot.includes('commit/push/publish `ask`'), 'command red-lines default to ask');
    assert.ok(slot.includes('network/credentials/fs-outside-repo `deny`'), 'non-command red-lines default to deny');
    assert.ok(slot.includes('floors at `prompt`'), 'an absent activity floors at prompt');
    assert.ok(slot.includes('`sandbox`'), 'names the sandbox activity level');
  });

  it('fails closed on a malformed policy — STOP loudly, never guess', () => {
    assert.match(slot, /STOP loudly, never guess/, 'a malformed policy is a loud STOP, never a guess');
  });

  it('routes through the in-project kit surfaces, never the engine-internal references', () => {
    assert.match(slot, /\/agent-workflow-kit set-autonomy/, 'names the set-autonomy writer');
    assert.match(slot, /autonomy-doctor/, 'names the sandbox provisioner');
    assert.ok(!slot.includes('references/'), 'the slot must never point at an engine-internal reference (absent from a user project)');
  });

  it('states the enforcement honesty note — informational for backends, enforcement = sandbox + orchestrator', () => {
    assert.match(slot, /informational/, 'the policy is informational for delegated backends');
    assert.match(slot, /enforcement stays the OS sandbox \+ the orchestrator/, 'enforcement is the sandbox + the orchestrator, never the fragment');
  });
});
