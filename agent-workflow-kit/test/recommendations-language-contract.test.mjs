// Contract guard for the Recommendations PRESENTATION surface (REC-UX-REWORK, D3/D5). The retired
// contract told the agent to paste the tool section VERBATIM — colliding with the deployment's
// conversational-language contract (AD-032 resolved this class once: rendered in the user's
// language, never hardcoded). Doc-parity alone cannot catch a re-introduced paste-verbatim
// sentence (it binds constant VALUES, not the surrounding contract prose), so this static guard
// pins BOTH directions across every LIVE contract surface: the presence of the user-language
// presentation tokens and the ABSENCE of the retired phrases. Historical records (CHANGELOGs,
// docs/ai archives) are deliberately out of scope. Same pattern as report-contract.test.mjs.
//
// Dev-only repo test (test/ is outside the package `files` whitelist — not shipped in the tarball).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RISK_NOTED_KEYS } from '../tools/recommendations.mjs';

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(kitRoot, rel), 'utf8');

const MODE_DOC = read('references/modes/recommendations.md');
const UPGRADE_DOC = read('references/modes/upgrade.md');
const VELOCITY_DOC = read('references/modes/velocity.md');
const HOOK_DOC = read('references/modes/hook.md');
const README = read('README.md');
const TOOL_SOURCE = read('tools/recommendations.mjs');
const TOOL_TEST = read('tools/recommendations.test.mjs');
const PARITY_SOURCE = read('tools/doc-parity.mjs');

// The README contract surface is the ONE table row of the recommendations command (line-scoped —
// other rows legitimately keep their own verbatim contracts, e.g. the tool-composed status lines).
const readmeRow = README.split('\n').find((l) => l.includes('`/agent-workflow-kit recommendations`'));

// Slice between two anchors (report-contract.test.mjs precedent — a missing anchor is red).
const between = (text, from, to) => {
  const a = text.indexOf(from);
  assert.notEqual(a, -1, `missing anchor: "${from}"`);
  const b = to ? text.indexOf(to, a + from.length) : text.length;
  assert.notEqual(b, -1, `missing anchor: "${to}"`);
  return text.slice(a, b);
};

const LANGUAGE_TOKEN = /in the user's conversational language/i;
const BYTE_EXACT_TOKEN = /byte-exact/;
const RAW_BLOCK_TOKEN = /raw tool block/i;

describe('recommendations language contract — the presentation tokens are PRESENT (D5)', () => {
  it('the mode doc presents in the user language: facts complete, commands byte-exact, raw block on request', () => {
    assert.match(MODE_DOC, LANGUAGE_TOKEN);
    assert.match(MODE_DOC, BYTE_EXACT_TOKEN);
    assert.match(MODE_DOC, RAW_BLOCK_TOKEN);
    assert.match(MODE_DOC, /nothing added or dropped/i, 'the completeness half of the contract is stated');
  });

  it('upgrade.md steps 4 AND 8 carry the presentation contract (both exits)', () => {
    const step4 = between(UPGRADE_DOC, 'Equal-head exit', '5. Show the relevant');
    const step8 = between(UPGRADE_DOC, '8. Re-stamp', '');
    for (const [label, step] of [['step 4', step4], ['step 8', step8]]) {
      assert.match(step, LANGUAGE_TOKEN, `${label} presents in the user's language`);
      assert.match(step, BYTE_EXACT_TOKEN, `${label} keeps commands byte-exact`);
    }
  });

  it('the README row and the tool header carry the presentation contract', () => {
    assert.ok(readmeRow, 'the README recommendations row exists');
    assert.match(readmeRow, LANGUAGE_TOKEN);
    assert.match(readmeRow, BYTE_EXACT_TOKEN);
    assert.match(TOOL_SOURCE, LANGUAGE_TOKEN, 'the tool header states the presentation contract');
  });
});

describe('recommendations language contract — the retired paste-verbatim phrases are ABSENT (D5)', () => {
  it('the mode doc, tool source, parity source, and tool test carry NO verbatim wording at all', () => {
    for (const [label, text] of [
      ['references/modes/recommendations.md', MODE_DOC],
      ['tools/recommendations.mjs', TOOL_SOURCE],
      ['tools/doc-parity.mjs', PARITY_SOURCE],
      ['tools/recommendations.test.mjs', TOOL_TEST],
    ]) {
      assert.doesNotMatch(text, /verbatim/i, `${label} must not re-introduce a paste-verbatim contract`);
    }
  });

  it('upgrade.md drops the recommendations paste sentence (other tool-composed verbatim contracts stay)', () => {
    assert.doesNotMatch(UPGRADE_DOC, /paste its output VERBATIM/i, 'the retired recommendations paste sentence is gone');
    assert.doesNotMatch(UPGRADE_DOC, /Recommendations[^\n]*VERBATIM/i, 'no recommendations sentence pairs with VERBATIM');
  });

  it('the README recommendations row carries no verbatim wording', () => {
    assert.doesNotMatch(readmeRow, /verbatim/i);
  });
});

describe('recommendations contract — risk lives at the consent moment (D3, closed bidirectional)', () => {
  const notes = between(MODE_DOC, '**Per-item posture notes', '**Sandbox lanes');

  it('risk-marked keys == mode-doc posture-note keys, exactly (a dropped note goes red)', () => {
    const noteKeys = [...notes.matchAll(/^- `([a-z-]+)`/gmu)].map((m) => m[1]);
    assert.deepEqual([...noteKeys].sort(), [...RISK_NOTED_KEYS].sort());
    for (const key of RISK_NOTED_KEYS) {
      assert.ok(notes.includes(`- \`${key}\` —`), `the ${key} posture note is present`);
    }
  });

  it('the consent-sequence is an explicit informed-consent checkpoint (nothing runs before confirmation)', () => {
    assert.match(MODE_DOC, /surface its posture note inline/i);
    assert.match(MODE_DOC, /explicitly confirms/i);
    assert.match(MODE_DOC, /only then/i);
    // The invariant is that NO command runs before confirmation — and the doc must NOT let a
    // no---apply command (e.g. family-freshness's `npx … init`) be treated as a "safe preview" to
    // run before consent. Safety is NOT inferred from the presence/absence of an --apply flag.
    assert.match(MODE_DOC, /no command runs before confirmation/i, 'nothing runs before confirmation');
    assert.match(MODE_DOC, /Do NOT infer safety from the presence or absence of an `--apply` flag/i, 'the --apply heuristic is explicitly rejected');
    assert.match(MODE_DOC, /family-freshness/, 'the no---apply mutation is named as a mutation, never a preview');
    assert.match(MODE_DOC, /dry-run preview/i, 'the genuine preview class is named');
    // Negative pin: the rejected "run the preview BEFORE confirmation" wording must never return —
    // nothing runs before confirmation, and no command is ever declared safe-to-run pre-consent.
    assert.doesNotMatch(MODE_DOC, /FIRST run that rendered preview/i, 'the rejected run-preview-before-confirm wording never returns');
    assert.doesNotMatch(MODE_DOC, /safe to run before confirmation/i, 'no command is declared safe to run before confirmation');
    // The sandbox-lane guidance must be DELIVERED at the consent moment, not left behind a
    // pointer the user never follows: the ladder rides the note inline.
    assert.match(MODE_DOC, /the note INCLUDES the sandbox-lanes ladder/i);
    assert.match(MODE_DOC, /present the whole ladder inline/i);
  });

  it('the item-shape contract documents the optional `recipe:` line (mode doc + README; the tool --help is pinned in recommendations.test.mjs)', () => {
    assert.match(MODE_DOC, /optional `recipe:` line/i, 'the mode doc lists the optional `recipe:` line');
    assert.match(README, /optional `recipe:` line/i, 'the README lists the optional `recipe:` line');
  });

  it('the sandbox-lanes section explains the recipe per host class', () => {
    const lanes = between(MODE_DOC, '**Sandbox lanes', '**Invariants');
    assert.match(lanes, /settings-native/i);
    assert.match(lanes, /harness-managed/i);
  });

  it('the harness-managed lane is a NARROWEST-SCOPE ladder — a session-wide allowance is an informed widening, never the default advice', () => {
    // Advising a blanket session allowance would reproduce the exact blast-radius class the
    // settings security keys were rejected for — the ladder states scoped-first,
    // widening-informed, bypass-as-fallback.
    const lanes = between(MODE_DOC, '**Sandbox lanes', '**Invariants');
    assert.match(lanes, /NARROWEST-SCOPE ladder/i, 'the ladder framing is present');
    assert.match(lanes, /wrapper\/command-SCOPED/i, 'scoped rules come first');
    assert.match(lanes, /INFORMED WIDENING/i, 'a session-scoped allowance is named a widening');
    assert.match(lanes, /same blast-radius class/i, 'the widening names its risk class plainly');
    assert.match(lanes, /per-run consented bypass/i, 'the bypass fallback stays on the ladder');
  });
});

describe('recommendations contract — the retired item key is gone from LIVE surfaces (2.3 rename)', () => {
  it('no live contract surface still names network-allowlist', () => {
    for (const [label, text] of [
      ['references/modes/recommendations.md', MODE_DOC],
      ['references/modes/upgrade.md', UPGRADE_DOC],
      ['references/modes/velocity.md', VELOCITY_DOC],
      ['README.md', README],
      ['tools/recommendations.mjs', TOOL_SOURCE],
      ['tools/recommendations.test.mjs', TOOL_TEST],
    ]) {
      assert.ok(!text.includes('network-allowlist'), `${label} still names the retired network-allowlist key`);
    }
  });

  it('velocity.md routes the recipe through the sandbox-lane item', () => {
    assert.match(VELOCITY_DOC, /sandbox-lane/);
  });

  it('the read-lane canon is documented (velocity.md mechanism + node -e ban; README lane mention) — AD-055 Part II', () => {
    assert.match(VELOCITY_DOC, /read-lane/, 'velocity.md names the read-lane mechanism for compound reads');
    assert.match(VELOCITY_DOC, /node -e/, 'velocity.md bans the unclassifiable inline node -e probe form');
    assert.match(README, /read-lane/, 'the README hook row mentions the opt-in read-lane');
  });

  it('hook.md frames the read-lane as a standalone grant bounded by the frozen audited core, not the user\'s seeded rules (council B4)', () => {
    assert.match(HOOK_DOC, /bounded by the frozen audited read-only core/i, 'the honest framing is present');
    assert.match(HOOK_DOC, /standalone opt-in grant/i, 'the lane is named a standalone grant');
    assert.doesNotMatch(HOOK_DOC, /never new per-command exposure/i, 'the overstated subset claim is gone');
  });

  it('the read-lane posture note covers BOTH the enable-preview and the stale delete-to-reseed recovery (council R2-minor)', () => {
    const notes = between(MODE_DOC, '**Per-item posture notes', '**Sandbox lanes');
    assert.match(notes, /- `read-lane` —/, 'the read-lane posture note exists');
    assert.match(notes, /delete-to-reseed/i, 'the note names the stale-variant reseed recovery, not only the enable preview');
  });
});
