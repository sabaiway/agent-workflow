// composed-lines-scan.test.mjs — the scanner leaf's own red→green probes. The guard's authority
// rests on this scanner NOT being blind: every exemption (labels, machine lines, command spans,
// path tokens) is proven to stay narrow by a negative control that a real leak in the same
// position DOES hit.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ALARM_WORDS, INTERNAL_NAMES, hits, scannable } from '../../scripts/testing/composed-lines-scan.mjs';

const TOKENS = ['skipped-readonly', 'clean-parity', 'already-present'];

describe('negative controls — a leak in an exempt-looking position is still caught', () => {
  it('a backticked bare machine token is scanned (`skipped-readonly` in a sentence)', () => {
    assert.deepEqual(hits('  codex: the outcome is `skipped-readonly` this session', TOKENS), ['skipped-readonly']);
  });

  it('a slash-joined internal pair is scanned (anchor/slot)', () => {
    assert.ok(hits('  wire the anchor/slot pair before the refresh', INTERNAL_NAMES).length >= 2);
  });

  it('a BACKTICKED slash-joined internal pair is scanned (`anchor/slot`)', () => {
    assert.ok(hits('  wire the `anchor/slot` pair before the refresh', INTERNAL_NAMES).length >= 2);
  });

  it('a backticked lowercase key=token pair is scanned (`outcome=skipped-readonly`)', () => {
    assert.deepEqual(hits('  the run ended with `outcome=skipped-readonly` again', TOKENS), ['skipped-readonly']);
  });

  it('an alarm word in plain prose is scanned', () => {
    assert.deepEqual(hits('  the refresh failed and drift persists', ALARM_WORDS), ['failed', 'persists']);
  });
});

describe('exemptions — narrow by grammar, not by dropping', () => {
  it('a leading self-label/prefix is the machine channel (all four label shapes)', () => {
    for (const line of [
      '[lens-region] refreshed the section to the current canon.',
      '  bridge-settings: 2 key(s) recognized, all current',
      'hide-footprint — DRY RUN (no changes)',
      'ensure-configs (--reconcile)',
    ]) {
      assert.deepEqual(hits(line, INTERNAL_NAMES), [], line);
    }
  });

  it('a whole-line [tool] key=value machine line scans as EMPTY even with banned bytes in the value', () => {
    assert.equal(scannable('[lens-region] error="EACCES: a fragment anchor slot reconcile"'), '');
  });

  it('command spans, flags, KEY=VALUE and paths stay exempt', () => {
    for (const line of [
      '  run `git rm --cached -- .claude/settings.json` to un-track (kept on disk)',
      '  pass --remove-global to remove (with a printed backup)',
      '  clear it with `--unset AW_OLD_KNOB --apply` when convenient',
      '  hidden (2): /AGENTS.md, /docs/ai/',
      '  docs/ai/orchestration.json: created from the canonical seed',
      '  recover with /agent-workflow-kit setup',
      '  update the kit first: npx @sabaiway/agent-workflow-kit@latest init',
    ]) {
      assert.deepEqual(hits(line, [...INTERNAL_NAMES, ...TOKENS]), [], line);
    }
  });

  it('the +0/−0 delta token is not a false positive', () => {
    assert.deepEqual(hits('  • +0/−0 — the hidden set is unchanged', [...INTERNAL_NAMES, ...ALARM_WORDS]), []);
  });
});
