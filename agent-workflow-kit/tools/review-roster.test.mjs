import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { KNOWN_BACKENDS } from './detect-backends.mjs';
import { DISPLAY_ALIASES, REVIEW_CMD_ALIASES } from './carriers.mjs';

const roster = await import('./review-roster.mjs');
const resolved = await import('./review-roster-resolve.mjs');

describe('review roster grammar, expansion and wording (spec:review-roster/S1)', () => {
  it('parses bridges, bare lenses and derived bundled lenses', () => {
    assert.deepEqual(roster.parseSlotToken('codex-review'), {
      member: 'codex-review', instrument: 'codex-review', kind: 'bridge', stem: 'codex',
      model: null, effort: null, template: null, derived: false,
    });
    assert.deepEqual(roster.parseSlotToken('review-lens:opus:high'), {
      member: 'review-lens:opus:high', instrument: 'review-lens', kind: 'lens',
      stem: 'review-lens-opus-high', model: 'opus', effort: 'high',
      template: 'review-lens', derived: true,
    });
    assert.equal(roster.parseSlotToken('my-review-lens').stem, 'my-review-lens');
  });

  it('refuses malformed members and duplicate resolved stems', () => {
    for (const member of ['codex-review:opus:high', 'review-lens:opus', 'review-lens:opus:high:extra',
      'Review-Lens', 'review-lens::high', 'other-lens:opus:high', 42]) {
      assert.throws(() => roster.validateRoster([member]), /review roster|member|bundled|bridge/u, String(member));
    }
    assert.throws(
      () => roster.validateRoster(['review-lens:opus:high', 'review-lens-opus-high']),
      /duplicate.*review-lens-opus-high/u,
    );
    assert.throws(() => roster.validateRoster([]), /must not be empty/u);
  });

  it('expands only lossless shorthands and keeps reviewed typed but non-lossless', () => {
    assert.deepEqual(roster.expandShorthand('solo'), { lossless: true, members: [] });
    assert.deepEqual(roster.expandShorthand('council'), {
      lossless: true, members: ['codex-review', 'agy-review'],
    });
    assert.deepEqual(roster.expandShorthand('reviewed'), { lossless: false, members: null });
    assert.equal(Array.isArray(roster.expandShorthand('reviewed')), false);
  });

  it('derives members and gate obligations without ever obliging a lens', () => {
    const value = ['review-lens:opus:high', 'codex-review'];
    assert.deepEqual(roster.bridgeMembersOf(value), ['codex-review']);
    assert.deepEqual(roster.lensMembersOf({ 'plan-authoring': { review: value } }), ['review-lens:opus:high']);
    assert.deepEqual(roster.obligationsOf(value), {
      recipe: 'reviewed', backends: ['codex'], minShip: 1, perBackend: true,
    });
    assert.deepEqual(roster.obligationsOf(['review-lens']), {
      recipe: 'solo', backends: [], minShip: 0, perBackend: false,
    });
  });

  it('applies list operations without mutating the input', () => {
    const original = ['codex-review'];
    assert.deepEqual(roster.addReviewer(original, 'review-lens'), ['codex-review', 'review-lens']);
    assert.deepEqual(roster.removeReviewer(['codex-review', 'review-lens'], 'codex-review'), ['review-lens']);
    assert.deepEqual(original, ['codex-review']);
  });

  it('list operations expand a lossless shorthand and refuse reviewed and the last member', () => {
    assert.deepEqual(roster.addReviewer('council', 'review-lens'), ['codex-review', 'agy-review', 'review-lens']);
    assert.deepEqual(roster.addReviewer('solo', 'agy-review'), ['agy-review']);
    assert.deepEqual(roster.removeReviewer('solo', 'agy-review'), []);
    assert.throws(() => roster.addReviewer('reviewed', 'review-lens'), /no lossless roster expansion/u);
    assert.throws(() => roster.removeReviewer(['codex-review'], 'codex-review'), /last member/u);
    assert.deepEqual(roster.expandShorthand('bogus'), { lossless: false, members: null });
    assert.throws(() => roster.obligationsOf('council'), /must be an array/u);
  });

  it('maps every bridge readiness state to one remedy wording', () => {
    const cases = [
      [{ readiness: 'needs-skill' }, /skill not installed — run/u],
      [{ readiness: 'needs-skill', setupHint: { local: '/x/SKILL.md' } }, /skill not installed — \/x\/SKILL\.md/u],
      [{ readiness: 'needs-cli', setupHint: { url: 'https://x.invalid' } }, /CLI is not installed — https:\/\/x\.invalid/u],
      [{ readiness: 'needs-cli' }, /CLI is not installed$/u],
      [{ readiness: 'needs-credentials' }, /not signed in/u],
      [{ readiness: 'degraded' }, /wrapper not on PATH/u],
      [{ readiness: 'other-state' }, /^other-state$/u],
      [{}, /readiness unavailable/u],
    ];
    for (const [entry, expected] of cases) assert.match(resolved.remedyFor(entry), expected, JSON.stringify(entry));
  });

  it('REVIEW_CMD_ALIASES mirrors the backend registry exactly (drift guard)', () => {
    const reviewBackends = KNOWN_BACKENDS.filter((backend) => backend.roleCmds?.review);
    assert.deepEqual(Object.keys(REVIEW_CMD_ALIASES).sort(), reviewBackends.map((backend) => backend.roleCmds.review).sort());
    for (const backend of reviewBackends) {
      assert.deepEqual(REVIEW_CMD_ALIASES[backend.roleCmds.review], { backend: backend.name, receiptId: DISPLAY_ALIASES[backend.name] });
    }
  });

  it('resolveRoster returns the shared row schema for a surveyed lens, an unsurveyed lens and a posture-less bridge', () => {
    const readiness = [{ name: 'codex-cli-bridge', readiness: 'ready' }];
    const surveyLens = (spec) => ({ state: 'placed', reason: null, rel: `.claude/agents/${spec.stem}.md`, model: 'opus', effort: 'high' });
    assert.deepEqual(resolved.resolveRoster({ value: ['codex-review', 'review-lens'], readiness, surveyLens }), [
      { member: 'codex-review', stem: 'codex', kind: 'bridge', state: 'ready', reason: null, posture: null },
      { member: 'review-lens', stem: 'review-lens', kind: 'lens', state: 'placed', reason: null, posture: 'model=opus effort=high' },
    ]);
    assert.deepEqual(resolved.resolveRoster({ value: ['review-lens'], readiness }), [
      { member: 'review-lens', stem: 'review-lens', kind: 'lens', state: 'unsurveyed', reason: null, posture: null },
    ]);
    assert.deepEqual(resolved.resolveRoster({ value: ['agy-review'], readiness: [] }), [
      { member: 'agy-review', stem: 'agy', kind: 'bridge', state: 'needs-skill', reason: 'bridge skill not installed — run /agent-workflow-kit setup', posture: null },
    ]);
  });

  it('builds derived specs/templates and roster cells from one wording leaf', () => {
    const spec = resolved.lensVehicleSpec('review-lens:opus:high');
    assert.deepEqual(spec, {
      stem: 'review-lens-opus-high', template: 'review-lens', model: 'opus', effort: 'high',
      tools: 'read-only', derived: true,
    });
    const template = '---\nname: review-lens\nmodel: sonnet\neffort: medium\ntools: Read\n---\nbody\n';
    assert.match(resolved.deriveLensTemplate(template, spec), /^---\nname: review-lens-opus-high\nmodel: opus\neffort: high\n/mu);
    const rows = [{ member: 'codex-review', state: 'ready' }, { member: 'review-lens', state: 'missing' }];
    assert.equal(resolved.rosterLabel(rows), 'codex-review + review-lens (missing)');
    assert.equal(resolved.activeLineCell(rows), '[codex-review + review-lens (missing)]');
  });
});

describe('the skipped line and the preview remedy (spec:review-roster/S5, folded here under the red-proof file freeze)', () => {
  it('skippedLine collapses the state only and hands the remedy through untouched', () => {
    const row = { state: 'needs-credentials', reason: 'not signed in (credentials missing)' };
    assert.equal(resolved.skippedLine(row), 'skipped this round — needs-credentials: not signed in (credentials missing)');
    const apply = "to place it, run exactly: node x.mjs --apply --cwd '/repo (backup)'";
    assert.equal(resolved.skippedLine(row, apply), `skipped this round — needs-credentials: ${apply}`);
  });

  it('the apply line of a lens not yet on disk names --write first; a persisted or written lens does not', async () => {
    const { renderRosterPreview, persistedLensStems } = await import('./set-recipe-roster.mjs');
    const derived = { member: 'review-lens:opus:xhigh', stem: 'review-lens-opus-xhigh', kind: 'lens', state: 'missing', reason: null, posture: null };
    const bundled = { ...derived, member: 'review-lens', stem: 'review-lens' };
    const row = (from, lens) => ({
      activity: 'plan-execution', slot: 'review', from, to: [lens.member], beforeValue: from, afterValue: [lens.member],
      changed: true, named: new Set([lens.stem]), roster: [lens],
    });
    const agentsApply = 'node cheap-agents.mjs --apply --cwd /p';
    const preview = renderRosterPreview(row('solo', derived), { agentsApply });
    assert.match(preview, /to place it, run exactly: node cheap-agents\.mjs --apply --cwd \/p$/mu);
    assert.match(preview, /^ {8}after --write — the agents writer derives this lens from what docs\/ai\/orchestration\.json names$/mu);
    assert.doesNotMatch(renderRosterPreview(row('solo', bundled), { agentsApply }), /after --write/u, 'a bundled template is placed regardless of the config');
    assert.doesNotMatch(renderRosterPreview(row(['review-lens:opus:xhigh'], derived), { agentsApply }), /after --write/u);
    assert.doesNotMatch(renderRosterPreview(row('solo', derived), { agentsApply, persistedLenses: new Set(['review-lens-opus-xhigh']) }), /after --write/u, 'the writer reads every review slot of the persisted config');
    const persisted = (member) => persistedLensStems({ 'plan-authoring': { review: [member] } });
    assert.doesNotMatch(renderRosterPreview(row('solo', derived), { agentsApply, persistedLenses: persisted('review-lens:opus:xhigh') }), /after --write/u);
    assert.match(renderRosterPreview(row('solo', derived), { agentsApply, persistedLenses: persisted('review-lens-opus-xhigh') }), /after --write/u, 'a bare stem is never derived, so it persists nothing the writer can place');
    assert.doesNotMatch(renderRosterPreview(row('solo', derived), { agentsApply, wrote: true }), /after --write/u);
  });
});
