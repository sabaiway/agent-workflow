import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENEFITS, OPT_IN_CAPABILITIES, RISK_NOTED_KEYS } from '../tools/recommendations.mjs';
import { ACK_LANES } from '../tools/ack-store.mjs';
import * as lanes from '../tools/write-lanes.mjs';
import * as velocityModule from '../tools/velocity-profile.mjs';
import { COMMANDS, kindOf } from '../tools/commands.mjs';

const need = (mod, name) => {
  if (!(name in mod)) {
    throw new Error(`${name} is absent`);
  }
  return mod[name];
};

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(kitRoot, rel), 'utf8');

const MODE_DOC = read('references/modes/recommendations.md');
const UPGRADE_DOC = read('references/modes/upgrade.md');
const BOOTSTRAP_DOC = read('references/modes/bootstrap.md');
const MCP_DOC = read('references/modes/mcp.md');
const VELOCITY_DOC = read('references/modes/velocity.md');
const HOOK_DOC = read('references/modes/hook.md');
const README = read('README.md');
const WORKTREES_DOC = read('references/modes/worktrees.md');
const GATE_HOOK_SOURCE = read('tools/gate-hook.mjs');
const CHEAP_AGENT_TEMPLATES = ['mechanical-sweep', 'gate-triage', 'changelog-skeleton'].map(
  (name) => [`references/agents/${name}.md`, read(`references/agents/${name}.md`)],
);
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
const ENFORCEMENT_NOTE_START = '- `enforcement` —';
const POSTURE_NOTE_BOUNDARY = '\n- ';
const ENFORCEMENT_NOTE_LITERALS = Object.freeze({
  chatApply: 'the agent applies the item on the chat yes after the check',
  optionalInit: '`init` applies it on the batch terminal yes as the route the user may take instead',
  createOnly: 'The copy is create-only',
  noClobberOrFollow: 'an existing file stands and nothing is written through a link',
  installerRefusal: 'refuses to overwrite a pre-commit hook it did not write',
  rollback: 'removes the scripts this apply copied',
  pending: "the item is offered again with the installer's output shown",
  unmanagedHook: 'over a pre-commit hook the installer did not write the item is not offered',
  ownStep: "its skip names the user's own step",
});
const ENFORCEMENT_RISK_PROFILE_END = /Risk profile: [^\n]+\.$/u;
const WORKTREES_NOTE_LITERALS = Object.freeze([
  'the agent applies the item on the chat yes after the check',
  '`init` applies it on the batch terminal yes as the route the user may take instead',
  "written to this copy's `.claude/settings.local.json` only, never the committed project settings",
  'the parent created when missing',
  'every sibling path under it (other repositories included)',
  'for every later session and every worktree provisioned afterwards',
  'Narrow it BEFORE the first apply: point `docs/ai/worktrees.json` `parentDir` at a dedicated dir',
  'an earlier one stays until the user deletes it',
  "renders `worktrees-dir.home` instead, the user's own step",
  'recorded by the `ack-write --lane worktrees-dir` line the `recipe:` line carries',
  'the ack fallback for a host that ignores the key',
  '**resolved probe dir**',
  'Risk profile: a real write-surface widening where honored — scope it deliberately.',
]);
const WORKTREES_LANE_SENTENCE = "For `worktrees-dir` you apply the grant on the chat yes after its check, like every harness item, with no hand step to wait for; its `recipe:` line's `ack-write` preview is the ack fallback, run only on the user's word that the host ignores the settings key, instead of the grant, and against a trusted host NO no ack renders.";
const WORKTREES_CONSENT_LITERALS = Object.freeze([
  'An unwritable parent prints the `worktrees-dir` check line and the full terminal command',
  'The agent runs that check line and, on the chat yes on its result, its apply line by the consent route',
  "written to this copy's `.claude/settings.local.json` only",
  "When the check refuses, prints nothing to change, or grants a dir that does not hold the command's target, use the printed terminal command for each operation",
  "`worktreesDirAck` in `docs/ai/acks.json`, recorded by the `ack-write` line the item's `recipe:` line carries, the fallback instead of the grant",
  'resolved probe dir',
]);

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
    assert.match(readmeRow, /spec-adoption decline preview/, 'the row lists the fourth `recipe:` kind');
    assert.match(TOOL_SOURCE, LANGUAGE_TOKEN, 'the tool header states the presentation contract');
  });

  it('the README status row names the feature-spec adoption state it now renders', () => {
    const statusRow = README.split('\n').find((l) => l.includes('`/agent-workflow-kit status`'));
    assert.ok(statusRow, 'the README status row exists');
    assert.match(statusRow, /feature-spec adoption state/);
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

  it('the worktrees-dir note pins checked chat consent, local settings, widening, narrowing and the ack fallback', () => {
    const note = between(notes, '- `worktrees-dir` —', POSTURE_NOTE_BOUNDARY).replace(/\s+/gu, ' ');
    for (const literal of WORKTREES_NOTE_LITERALS) {
      assert.ok(note.includes(literal), `the worktrees-dir note states: ${literal}`);
    }
    assert.doesNotMatch(note, /settings-native|harness-managed|host\/session|re-run recommendations/iu);
  });

  it('the enforcement note pins checked consent, create-only safety, installer refusal, rollback, and its risk profile', () => {
    const start = notes.indexOf(ENFORCEMENT_NOTE_START);
    assert.notEqual(start, -1, 'the enforcement posture note exists');
    const enforcementNote = notes.slice(start).split(POSTURE_NOTE_BOUNDARY)[0];
    for (const [label, literal] of Object.entries(ENFORCEMENT_NOTE_LITERALS)) {
      assert.ok(enforcementNote.includes(literal), `${label}: ${literal}`);
    }
    assert.match(enforcementNote, ENFORCEMENT_RISK_PROFILE_END);
    assert.ok(enforcementNote.endsWith("Risk profile: local tooling and a Git hook are added on the chat yes after the check, or on init's y."));
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
    assert.doesNotMatch(MODE_DOC, /the note INCLUDES the sandbox-lanes ladder/i);
  });

  it('the item-shape contract documents the optional `recipe:` line (mode doc + README; the tool --help is pinned in recommendations.test.mjs)', () => {
    assert.match(MODE_DOC, /optional `recipe:` line/i, 'the mode doc lists the optional `recipe:` line');
    assert.match(README, /optional `recipe:` line/i, 'the README lists the optional `recipe:` line');
  });

  it('recommendations-mode-doc-documents-the-new-detail-kind: the recipe: line is no longer sandbox-lane-only', () => {
    // The `recipe:` detail now carries a SECOND kind — the worktrees-dir hand-apply-first grant
    // advice — so the sandbox-lane-only wording on both surfaces would now be a false contract.
    assert.doesNotMatch(
      MODE_DOC,
      /the `sandbox-lane` live recipe — egress hosts \+ resolved writable dirs — only/,
      'the mode doc drops the sandbox-lane-ONLY wording',
    );
    assert.doesNotMatch(readmeRow, /\(sandbox-lane only\)/, 'the README row drops the sandbox-lane-ONLY wording');
    assert.match(MODE_DOC, /--lane worktrees-dir/, 'the mode doc documents the worktrees-dir ack command');
  });

  it('worktrees-dir-consent-flow-applies-the-grant-after-its-check-with-the-ack-as-fallback', () => {
    assert.doesNotMatch(MODE_DOC, /maintainer territory/i, 'the retired maintainer territory sentence is absent');
    const lane = between(MODE_DOC, '3. **The apply-through-agent lane', '**Per-item posture notes').replace(/\s+/gu, ' ');
    assert.ok(lane.includes(WORKTREES_LANE_SENTENCE), 'the grant follows its check and the ack is the fallback');
    assert.doesNotMatch(lane, /wait for the maintainer to confirm the grant/iu);
    assert.doesNotMatch(
      MODE_DOC,
      /acknowledgement carried by this item's rendered `recipe:` line/,
      'the retired ack-in-recipe claim is gone',
    );
    const consent = between(WORKTREES_DOC, '**Host-specific consent', '\n\n').replace(/\s+/gu, ' ');
    for (const literal of WORKTREES_CONSENT_LITERALS) {
      assert.ok(consent.includes(literal), `worktrees.md consent states: ${literal}`);
    }
    assert.doesNotMatch(consent, /consent-gated apply one-liner records/iu);
    assert.doesNotMatch(
      WORKTREES_DOC,
      /its rendered `recipe:` line records/,
      'worktrees.md drops the retired recipe-line claim',
    );
  });

  it('worktrees-mode-doc-matches-the-advisor: the worktrees mode doc states both convergence lanes', () => {
    assert.doesNotMatch(
      WORKTREES_DOC,
      /treats write access as unverified without a trusted host-capability signal/,
      'the never-converging claim is retired',
    );
    assert.match(WORKTREES_DOC, /allowWrite/, 'the declaration lane is named');
    assert.match(WORKTREES_DOC, /acks\.json/, 'the ack fallback lane is named');
    assert.match(WORKTREES_DOC, /worktreesDirAck/, 'the ack store key is named');
  });

  it('the ack-rebinding claim is bound to the RESOLVED probe dir, never to the configured parentDir', () => {
    // resolveProbeDir climbs to the nearest EXISTING ancestor, so two different ABSENT parentDir
    // values can resolve to the SAME dir and keep the same fingerprint — a doc claiming that any
    // parentDir change re-fires the item would overstate the guarantee.
    for (const [name, doc] of [['the mode doc', MODE_DOC], ['worktrees.md', WORKTREES_DOC]]) {
      assert.doesNotMatch(doc, /changing `parentDir` moves the fingerprint/, `${name} drops the overstated claim`);
      assert.doesNotMatch(doc, /a changed `parentDir` re-fires the item/, `${name} drops the overstated claim`);
      assert.match(doc, /resolved probe dir/i, `${name} binds the fingerprint to the resolved probe dir`);
    }
  });

  it('the sandbox-lanes section explains the recipe per host class', () => {
    const lanes = between(MODE_DOC, '**Sandbox lanes', '**Invariants');
    assert.match(lanes, /settings-native/i);
    assert.match(lanes, /harness-managed/i);
  });

  it('the harness-managed lane keeps the harness controls without a kit shape or ack step', () => {
    const lanes = between(MODE_DOC, '**Sandbox lanes', '**Invariants');
    const harnessLane = between(lanes, '- **Harness-managed sandbox**', '\n- ');
    assert.match(harnessLane, /scoped/i);
    assert.match(harnessLane, /session/i);
    assert.doesNotMatch(harnessLane, /paste-ready|Record the ack|ack-write/i);
  });
});

// The third outcomes (feedback-hardening Plan 2). An arm nobody can name is an arm nobody can act
// on: the section renders one composed line per item, and everything about WHY it fired and what the
// convergence costs lives in the notes at the consent moment. A new arm whose identifier never
// reaches the doc is exactly the OPT-IN-SHIPS-INVISIBLE shape one layer down.
describe('recommendations contract — the third-outcome vocabulary reaches the consent moment', () => {
  const notes = between(MODE_DOC, '**Per-item posture notes', '**Sandbox lanes');

  it('every third-outcome arm is named in the posture notes by its own identifier', () => {
    for (const arm of ['producer-unrecognized', 'coverage-domain-narrow', 'adopted-elsewhere', 'id-squatter']) {
      assert.ok(notes.includes(`\`${arm}\``), `the ${arm} arm is named where its consent moment is`);
    }
  });

  it('both new ack lanes name their lane AND their store key — the two halves a reader needs', () => {
    for (const [lane, storeKey] of [['coverage-domain', 'coverageDomainAck'], ['source-size-copy', 'sourceSizeCopyAck']]) {
      assert.ok(notes.includes(lane), `the ${lane} lane is named`);
      assert.ok(notes.includes(storeKey), `and the ${storeKey} it writes`);
    }
  });

  it('the notes state what the acks may NOT silence — the one thing a convergence lane can get wrong', () => {
    // A lane that silenced a broken declaration would re-open the false green through the
    // convergence itself, so the boundary is documented, not merely coded.
    assert.match(notes, /a dead pair is broken, not narrow/i, 'the coverage-domain boundary is stated');
    assert.match(notes, /NO acknowledgement silences it/i, 'and the unminted boundary too');
  });

  it("the user-item arms name the user's own step without HAND-APPLY", () => {
    for (const phrase of ['`producer-unrecognized`', '`id-squatter`']) {
      const at = notes.indexOf(phrase);
      assert.notEqual(at, -1, `${phrase} is documented`);
      assert.match(notes.slice(at, at + 1400), /the user's own step/, `${phrase} names the user's own step`);
      assert.doesNotMatch(notes.slice(at, at + 1400), /HAND-APPLY/, `${phrase} retires HAND-APPLY`);
    }
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

  it('velocity.md routes the bridge surfaces through the bridge-tier item', () => {
    assert.match(VELOCITY_DOC, /bridge-tier/);
    assert.doesNotMatch(VELOCITY_DOC, /sandbox-lane/);
    assert.match(VELOCITY_DOC, /docs\/ai\/acks\.json/);
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

  it('the read-lane posture note names the enable preview and the kit item for a stale or absent hook (council R2-minor)', () => {
    const notes = between(MODE_DOC, '**Per-item posture notes', '**Sandbox lanes');
    assert.match(notes, /- `read-lane` —/, 'the read-lane posture note exists');
    const note = between(notes, '- `read-lane` —', POSTURE_NOTE_BOUNDARY);
    assert.match(note, /gate-hook --read-lane/u, 'the note names the enable preview');
    assert.ok(note.includes('`gate-hook.not-current`'), 'a stale or absent hook under the lane is a planned file of the kit item');
    assert.doesNotMatch(note, /reseed|\brm\b/iu);
  });
});

// D10 — the subagent promise. Whether a host fires hooks on a SUBAGENT's Bash is host behaviour the
// kit cannot verify from inside; one shipped surface stated the coverage as flat fact while another
// already hedged it. Every surface now carries the SAME qualifier, so the promise cannot drift apart
// again — and the retired flat wordings are pinned absent in both directions.
describe('the subagent promise is qualified on every shipped surface (D10)', () => {
  const SUBAGENT_QUALIFIER = /where the host fires hooks on subagent Bash/;
  const surfaces = [
    ['tools/gate-hook.mjs', GATE_HOOK_SOURCE],
    ['references/modes/recommendations.md', MODE_DOC],
    ...CHEAP_AGENT_TEMPLATES,
  ];

  it('subagent-promise-is-qualified-everywhere: every surface claiming coverage carries the host qualifier', () => {
    for (const [name, text] of surfaces) {
      assert.match(text, /subagent/i, `${name} still speaks about subagents`);
      assert.match(text, SUBAGENT_QUALIFIER, `${name} qualifies the subagent promise`);
    }
  });

  it('subagent-promise-is-qualified-everywhere: the unqualified wordings never return', () => {
    for (const [name, text] of surfaces) {
      assert.doesNotMatch(text, /applies to every future session and to subagents' Bash/, `${name}: the flat claim is gone`);
      assert.doesNotMatch(text, /\(it fires on subagent Bash too\)/, `${name}: the flat parenthetical is gone`);
    }
  });
});

const PROFILE_GAP_NOTE_START = '- `profile-gap` — ';
const PROFILE_GAP_NOTE_LITERALS = Object.freeze([
  'is a PREVIEW that writes nothing',
  'the confirmed pick runs the preview and you relay every line it prints',
  'the same line with ` --apply` appended runs only on a SECOND yes',
  'Items whose apply lines are byte-equal are one writer and take one answer',
  "the tier preview's `--apply` writes the absent slots, the store seed and the queue seed together",
  'A no records nothing',
  'A DECLINE is asked apart from later',
  'runs `node ${CLAUDE_SKILL_DIR}/tools/tier-preview.mjs --decline --cwd <project-root>` only when the user refuses EVERY item the tier preview then reports offered',
  'a declined item leaves the screen until a lineage step changes the profile',
  'An undecidable entry is a stated skip naming its reason',
  'rewrites `docs/ai/orchestration.json` in canonical form with the `_README` note',
  'the PRIVILEGED `docs/ai/gates.json`',
]);

describe('recommendations contract — the profile-gap posture note (spec:gap-screen/S9)', () => {
  const notes = between(MODE_DOC, '**Per-item posture notes', '**Sandbox lanes');
  const note = notes.slice(notes.indexOf(PROFILE_GAP_NOTE_START)).split(POSTURE_NOTE_BOUNDARY)[0];
  it('the intro names the gap; the profile-gap note occurs once, carries every literal and closes on its risk profile', () => {
    assert.match(between(MODE_DOC, 'The **read-only deployment advisor**', '**Live host/session facts'), /a difference from the reference profile the project has not declined/);
    assert.equal(notes.split(PROFILE_GAP_NOTE_START).length - 1, 1, 'exactly one profile-gap bullet');
    for (const literal of PROFILE_GAP_NOTE_LITERALS) assert.ok(note.includes(literal), `the profile-gap note states: ${literal}`);
    assert.match(note, ENFORCEMENT_RISK_PROFILE_END);
    for (const [pattern, why] of [[/<kit>/, 'a kit path is written in the ${CLAUDE_SKILL_DIR} form'], [/hand edit|lens preserves/i, 'no remedy says a hand edit or that the lens preserves a region'],
      [/rules-insert|the insert|`lens` reconcile|region|story-sessions-section|communication-absent/, 'no insert of a rules-file region and no lens remedy is named']]) assert.doesNotMatch(note, pattern, why);
  });
});

describe('recommendations contract — the full-flow-profile capability (spec:gap-screen/S10)', () => {
  it('upgrade.md declares it beside its two declarations and changes no other byte', () => {
    const declarations = [...UPGRADE_DOC.matchAll(/^<!-- opt-in-capability: ([a-z-]+) -->$/gmu)].map((match) => match[1]);
    assert.deepEqual(declarations, ['family-freshness', 'spec-adoption', 'full-flow-profile']);
    const prior = UPGRADE_DOC.replace('<!-- opt-in-capability: full-flow-profile -->\n', '');
    assert.deepEqual([Buffer.byteLength(prior), createHash('sha256').update(prior).digest('hex')], [34973, 'd5ada684ab7f402cc5ab151f856725ccebf76ce1652dce946b34f1123a8fb197'], 'the bytes after KIT-TEXT story S2 (the step-6 relay and head 5.0.0)');
  });
  it('the registry row names mode upgrade and advisor key profile-gap', () => {
    assert.deepEqual(OPT_IN_CAPABILITIES.filter(({ id }) => id === 'full-flow-profile'), [{ id: 'full-flow-profile', mode: 'upgrade', advisorKey: 'profile-gap' }]);
  });
});

const JEV_NOTE_START = '- `jev-connect` — ';
const JEV_SKILL_NOTE_START = '- `jev-skill` — ';
const JEV_SKILL_NOTE_LITERALS = Object.freeze([
  'the agent records', 'the chat yes', 'after the check', 'third-party text', 'pinned', 'verified copy',
  'jev-skill.not-current', 'with no question', 'foreign', 'left untouched', 'BEFORE the confirmation', 'jevSkillAck', 'docs/ai/acks.json',
]);
const JEV_NOTE_LITERALS = Object.freeze([
  'the agent records', "user's own step", 'not consent', 'no echo', 'api.typesafe.ai', "only on the user's own run",
  'plain text', 'typesafe-api-key.fish', 'user environment variable', 'enterprise', 'BEFORE the confirmation', 'jevConnectAck', 'docs/ai/acks.json',
]);
const PROBE_ORDER = Object.freeze(['probeVelocityItems', 'probeAttribution', 'probeAutonomyItems', 'probeSandboxProvision', 'probeReviewRecipe', 'probeGates', 'probeGatesInert', 'probeSourceSize',
  'probeCommitGuard', 'probeHookChecks', 'probeEnforcement', 'probeReadLane', 'probeStateBlockHook', 'probeCheapAgents', 'probeExecutorVehicle', 'probeFamilyFreshness',
  'probeMasksItem', 'probeFootprintGlobal', 'probeWorktreesDir', 'probeMcpChannel', 'probeSpecAdoption', 'probeProfileGaps']);

describe('spec:jev-guide/S19 — the jev-connect user step and jev-skill checked apply', () => {
  const notes = between(MODE_DOC, '**Per-item posture notes', '**Sandbox lanes').trimEnd();
  it('the two opt-in rows, the jev.md declarations on lines 3 and 4 and the two RISK_NOTED_KEYS entries', () => {
    assert.deepEqual(OPT_IN_CAPABILITIES.filter(({ mode }) => mode === 'jev'), [{ id: 'jev-connect', mode: 'jev', advisorKey: 'jev-connect' },
      { id: 'jev-skill', mode: 'jev', advisorKey: 'jev-skill' }]);
    assert.deepEqual(read('references/modes/jev.md').split('\n').slice(2, 4), ['<!-- opt-in-capability: jev-connect -->', '<!-- opt-in-capability: jev-skill -->']);
    assert.ok(RISK_NOTED_KEYS.includes('jev-connect') && RISK_NOTED_KEYS.includes('jev-skill'));
  });
  it('the jev-connect note occurs once, carries every literal and closes on its risk profile; the intro list names the offer', () => {
    assert.equal(notes.split(JEV_NOTE_START).length - 1, 1, 'exactly one jev-connect bullet');
    const note = notes.slice(notes.indexOf(JEV_NOTE_START)).split(POSTURE_NOTE_BOUNDARY)[0];
    for (const literal of JEV_NOTE_LITERALS) {
      assert.ok(note.includes(literal), `the jev-connect note states: ${literal}`);
    }
    assert.doesNotMatch(note, /HAND-APPLY/);
    assert.match(note, ENFORCEMENT_RISK_PROFILE_END);
    assert.match(between(MODE_DOC, 'The **read-only deployment advisor**', '**Live host/session facts'), /Jev not connected on this host, the Jev skill not installed for every agent/);
  });
  it('the jev-skill note occurs once, carries every literal and closes on its risk profile', () => {
    assert.equal(notes.split(JEV_SKILL_NOTE_START).length - 1, 1, 'exactly one jev-skill bullet');
    const note = notes.slice(notes.indexOf(JEV_SKILL_NOTE_START)).split(POSTURE_NOTE_BOUNDARY)[0];
    for (const literal of JEV_SKILL_NOTE_LITERALS) {
      assert.ok(note.includes(literal), `the jev-skill note states: ${literal}`);
    }
    assert.deepEqual(['HAND-APPLY', 'never updated silently', 'jev-skill.earlier'].filter((retired) => note.includes(retired)), []);
    assert.match(note, ENFORCEMENT_RISK_PROFILE_END);
  });
  it('ACK_LANES maps jev-connect to jevConnectAck and jev-skill to jevSkillAck, and the writer usage names both lanes', () => {
    assert.equal(ACK_LANES['jev-connect'], 'jevConnectAck');
    assert.equal(ACK_LANES['jev-skill'], 'jevSkillAck');
    const usage = spawnSync(process.execPath, [resolve(kitRoot, 'tools/ack-write.mjs'), '--help'], { encoding: 'utf8' });
    assert.deepEqual([usage.error, usage.status], [undefined, 0], usage.stderr);
    assert.match(usage.stdout, /--lane <[^>]*\bjev-connect\b[^>]*>/);
    assert.match(usage.stdout, /--lane <[^>]*\bjev-skill\b[^>]*>/);
  });
  it('probeJevConnect and probeJevSkill are declared export const and sit in PROBES in that order directly before probeProfileGaps, every other probe in its order', () => {
    assert.match(TOOL_SOURCE, /^export const probeJevConnect = /m);
    assert.match(TOOL_SOURCE, /^export const probeJevSkill = /m);
    const probes = between(TOOL_SOURCE, 'const PROBES = Object.freeze([', ']);').split('\n').slice(1).map((line) => line.trim().replace(/,$/, ''));
    assert.deepEqual(probes.filter(Boolean), [...PROBE_ORDER.slice(0, -1), 'probeJevConnect', 'probeJevSkill', PROBE_ORDER.at(-1)]);
  });
});

const SLOT_VARIANTS = Object.freeze([
  'velocity-core', 'kit-tools-tier', 'bridge-tier', 'autonomy-render',
  'gate-hook', 'mcp-channel', 'mcp-channel.differing',
  'agents', 'executor-vehicle', 'sandbox-provision.installable', 'jev-skill',
  'jev-skill.not-current', 'jev-connect', 'family-freshness',
  'state-block', 'sandbox-provision',
  'enforcement', 'commit-guard',
  'gates-inert.unfillable', 'gates-inert.producer-unrecognized',
  'source-size.id-squatter', 'review-recipe',
]);
const HARNESS_POSTURE_KEYS = Object.freeze(['bridge-tier', 'gate-hook', 'mcp-channel', 'jev-skill', 'enforcement', 'worktrees-dir']);
const RETIRED_LANE_LITERALS = Object.freeze([
  'applies at your next npx', 'upgrade, then init again', 'written ONLY by', 'never runs a console item',
  'lane: console', 'HAND-APPLY item is never run', 'never run by you', 'only `init` applies',
  'agent never runs it', 'never the agent', 'as printed and never run it', 'apply when init runs',
  'console item', 'console lane', 'lane is console', 'route line', 'preview alone',
  'run init from this folder', 'chat items only', 'applies only chat', 'consent-gated chat applies',
  'restart the agent from that console',
]);
const INABILITY_TOKEN = /\b(?:the agent|you|the consent flow)\b[^.;\n]*\b(?:cannot|must not|never)\s+(?:run|runs|apply|applies)\b|\bnever (?:you|the agent)\b|\bnever something the consent flow runs\b|\ban item\b[^.;\n]*\bcannot use that lane\b|\b(?:cannot|must not|never)\s+(?:be\s+)?(?:run|applied)\b[^.;\n]*\b(?:you|the agent|the consent flow)\b/iu;
const CONSENT_ROUTE_LITERALS = Object.freeze([
  'check:', 'in the sandbox and show its result', 'masked:', 'once more outside the sandbox',
  'yes is taken on the outside result', "user's yes on that result", 'apply:', "that result's digest",
  'once, outside the sandbox at once', 'point of action', 'never another line', 'never unseen',
  'velocity-core preferred', "before any other pick's check runs", "no other pick's check until the user answers",
  'one plain step', 'leave auto mode for this one action', 'shift+tab', 'the mode indicator in an editor',
  'in a terminal of your own', 'the same line once more', 'run the advisor again', 'only what is still pending',
  'a check that refuses', 'unapplied and pending', 'a changed digest', 'asks a new yes',
  'a no, a harness refusal and any other failure', 'leave the item pending with its output shown',
  'a chat item is never retried outside the sandbox', 'every failure of a chat step is a stop',
  "user's own step", 'handed over as worded',
  'the kit route', 'for no pick', "kit item's `check:` line in the sandbox", 'then at once run', 'with its new digest',
  'still with no question', 'every other outcome', '`lane: kit`',
]);
const RETIRED_ROUTE_LITERALS = Object.freeze([
  'in the sandbox first', 'a write the os refuses on a protected file', 'mcp masked report',
]);
const UNMEASURED_HOSTS = Object.freeze(['Codex', 'Devin', 'agy', 'macOS']);

describe('spec:init-project/S6 — apply slots and posture notes permit the checked consent route', () => {
  it('harness and user slots carry no HAND-APPLY, inability or retired line', () => {
    const applySlot = need(lanes, 'applySlot');
    const facts = { toolsDir: resolve(kitRoot, 'tools'), root: '/project', home: '/home/example', env: {}, platform: 'linux' };
    for (const variant of SLOT_VARIANTS) {
      const slot = applySlot(variant, facts);
      assert.ok(slot, `${variant} has a slot`);
      for (const line of [slot.check, slot.apply].filter((value) => value !== null)) {
        assert.doesNotMatch(line, /HAND-APPLY|\bcannot\b|\bmust not\b/, variant);
        assert.doesNotMatch(line, INABILITY_TOKEN, variant);
        for (const literal of RETIRED_LANE_LITERALS) {
          assert.ok(!line.includes(literal), `${variant} retires: ${literal}`);
        }
      }
    }
  });

  it('the lane paragraph and every posture note drop inability sentences; harness notes name the chat yes after the check and optional init', () => {
    const notes = between(MODE_DOC, '**Per-item posture notes', '**Sandbox lanes');
    const lane = between(MODE_DOC, '3. **The apply-through-agent lane', '**Per-item posture notes');
    assert.doesNotMatch(lane, INABILITY_TOKEN, 'the lane paragraph');
    assert.doesNotMatch(notes, INABILITY_TOKEN, 'all notes, including gates-inert');
    for (const key of HARNESS_POSTURE_KEYS) {
      const start = `- \`${key}\` —`;
      assert.ok(notes.includes(start), `the ${key} posture note exists`);
      const note = notes.slice(notes.indexOf(start)).split(POSTURE_NOTE_BOUNDARY)[0];
      assert.match(note, /\bagent\b[^.]*\bapplies\b[^.]*\bchat yes\b/i, key);
      assert.match(note, /after the check/i, key);
      assert.match(note, /\binit\b[^.]*\b(?:may take|instead)\b/i, key);
    }
    const connect = notes.slice(notes.indexOf(JEV_NOTE_START)).split(POSTURE_NOTE_BOUNDARY)[0];
    assert.ok(connect.includes("user's own step"));
  });
});

describe('spec:init-project/S7 — consent route, doc pointers and optional console init', () => {
  it('recommendations.md states the revised route and the kit route: apply once outside at once, a velocity pick first, the one plain step, no retired arm', () => {
    const doc = MODE_DOC.replace(/\s+/gu, ' ').toLowerCase();
    for (const literal of CONSENT_ROUTE_LITERALS) {
      assert.ok(doc.includes(literal), `recommendations.md states: ${literal}`);
    }
    for (const re of [/\bkit item[^.]*\bneither\b[^.]*\bclass/u, /\bonly kit items\b[^.]*\bno skip[^.]*`nothing is broken` alone/u]) assert.match(between(MODE_DOC, '2. **Verdict first', '\n3.'), re);
    for (const literal of RETIRED_ROUTE_LITERALS) {
      assert.ok(!doc.includes(literal), `recommendations.md retires: ${literal}`);
    }
  });

  it('upgrade and bootstrap point to the consent route, bootstrap closes on pending user steps, and the mutation example is chat', () => {
    for (const [name, doc] of [['upgrade.md', UPGRADE_DOC], ['bootstrap.md', BOOTSTRAP_DOC]]) {
      assert.match(doc, /consent route/i, name);
      assert.ok(doc.includes('${CLAUDE_SKILL_DIR}/references/modes/recommendations.md'), name);
    }
    const report = between(BOOTSTRAP_DOC, '11. **Report & ask.', 'Fill strategy:');
    assert.match(report, /user items[^.]*pending|pending user items/i);
    assert.match(report, /user's own step/i);
    const applyLane = between(MODE_DOC, '3. **The apply-through-agent lane', '\n4.');
    assert.doesNotMatch(applyLane, /family-freshness/);
    assert.match(applyLane, /spec-adoption[^.]*ensure-configs --reconcile --only specs/);
    assert.equal(lanes.laneOf('spec-adoption'), 'chat');
    for (const step of [between(UPGRADE_DOC, '- **Render the mandatory Recommendations section', '\n'), between(UPGRADE_DOC, '8. Re-stamp', '\n')]) assert.match(step, /\beach kit item\b[^.]*\bkit route\b[^]*OFFER the consent route/u);
    assert.ok(['chat', 'harness', 'kit', 'user'].every((lane) => between(UPGRADE_DOC, '- **Recommendations lanes', '\n').includes(`\`${lane}\``)));
  });

  it('the mode docs, README and mcp.md retire every never-run, only-init, route and restart sentence', () => {
    for (const [name, doc] of [['recommendations.md', MODE_DOC], ['upgrade.md', UPGRADE_DOC], ['bootstrap.md', BOOTSTRAP_DOC], ['README.md', README], ['mcp.md', MCP_DOC]]) {
      for (const literal of RETIRED_LANE_LITERALS) {
        assert.ok(!doc.toLowerCase().includes(literal.toLowerCase()), `${name} retires: ${literal}`);
      }
    }
  });

  it('README install, upgrade lines and composition paragraph and mcp.md name the agent apply after the check with init optional', () => {
    const surfaces = [
      between(README, '### 1.', '### 2.'), between(README, 'After `init`,', '> **Optional standalone'),
      between(README, '> **Two kinds of "upgrade":', '\n---'),
      between(README, 'The kit is the member you install', '\n```'), MCP_DOC,
    ];
    for (const text of surfaces) {
      assert.match(text, /\bagent\b[^.]*\bappl(?:y|ies)\b/i);
      assert.match(text, /after the check/i);
      assert.match(text, /\binit\b[^.]*\b(?:optional|may take|instead)\b|\b(?:optional|may take|instead)\b[^.]*\binit\b/i);
      if (text !== MCP_DOC) {
        assert.match(text, /a user item stays your own step/);
        assert.doesNotMatch(text, /HAND-APPLY/);
      }
    }
  });
});

describe('spec:velocity-profile/S24 — the ask rule is named by its purpose: all work stays in auto mode', () => {
  it('velocity.md and the README velocity row name the seeded rule by its purpose', () => {
    const rule = need(velocityModule, 'APPLY_ASK_RULE');
    assert.ok(VELOCITY_DOC.includes(rule));
    const row = README.split('\n').find((line) => line.includes('`/agent-workflow-kit velocity`'));
    for (const [name, text] of [['velocity.md', VELOCITY_DOC], ['README velocity row', row]]) {
      const doc = text.replace(/\s+/gu, ' ').toLowerCase();
      for (const phrase of ['so all work can stay in auto mode', 'auto mode refuses a harness', 'the rule allows nothing']) assert.ok(doc.includes(phrase), name);
      assert.doesNotMatch(doc, /ask rule[^.|]*\b(?:removes|silences|stops)\b[^.|]*\bprompt/, name);
    }
  });
  it('no line says the check line is allow-listed or names an argv-order rule', () => {
    need(velocityModule, 'APPLY_ASK_RULE');
    for (const [name, doc] of [['velocity.md', VELOCITY_DOC], ['recommendations.md', MODE_DOC], ['README.md', README]]) {
      for (const line of doc.split('\n')) {
        assert.doesNotMatch(line, /check line[^.]*allow-?list|allow-?list(?:ed)?[^.]*check line|argv[- ]order/i, `${name}: ${line}`);
      }
    }
  });
});

describe('spec:init-project/S19 — native Windows, unmeasured hosts and first-session prompt limits', () => {
  it('the sandbox items say on native Windows that they take no effect there, and the mode doc states the unmeasured hosts and the first-session prompt limit', () => {
    const lines = MODE_DOC.split('\n');
    assert.match(MODE_DOC, /native Windows[^\n]*no effect/);
    assert.ok(lines.some((line) => line.includes('unmeasured') && UNMEASURED_HOSTS.every((host) => line.includes(host))), 'one line names every unmeasured host');
    assert.match(MODE_DOC, /first session[^\n]*prompt/);
  });
});

it('spec:velocity-profile/S10 — every bridge-tier passage names used bridges and seeded sandbox surfaces', () => {
  const usage = spawnSync(process.execPath, [resolve(kitRoot, 'tools/recommendations.mjs'), '--help'], { encoding: 'utf8' });
  assert.deepEqual([usage.error, usage.status], [undefined, 0], usage.stderr);
  assert.ok(readmeRow, 'the README recommendations row exists');
  const surfaces = [
    ['velocity.md bridge tier', between(VELOCITY_DOC, '**The `--bridge-tier`', '**Consented posture')],
    ['recommendations.md posture note', between(MODE_DOC, '- `bridge-tier` —', '\n- ')],
    ['recommendations.md settings-native lane', between(MODE_DOC, '- **Settings-native sandbox**', '\n- ')],
    ['README advisor row', between(readmeRow, '`/agent-workflow-kit recommendations`', '`--cwd` is required')],
    ['schema.md networkHosts and writableDirs', between(read('tools/manifest/schema.md'), '## Network hosts', '## Mode catalog')],
    ['recommendations --help bridge tier', between(usage.stdout, 'Apply lines are cwd-independent', '\n\nRead-only:')],
    ['BENEFITS[bridge-tier]', BENEFITS['bridge-tier']],
  ];
  const forbidden = [
    'stays hand-apply',
    'stay hand-apply',
    'unseeded',
    'never seeds',
    'never writes',
    'placed bridges',
    'as a network weakening',
    'credential dirs',
  ];
  for (const [label, passage] of surfaces) {
    const text = passage.replace(/[`*]/gu, '').replace(/\s+/gu, ' ').toLowerCase();
    assert.ok(text.includes('used bridge'), `${label} names the used bridges`);
    if (label !== 'BENEFITS[bridge-tier]') {
      assert.ok(passage.includes('codex-exec *'), `${label} names the execution wrapper's * exclusion`);
      assert.ok(passage.includes('allowWrite'), `${label} names the seeded state-dir allowance`);
    }
    for (const literal of forbidden) {
      assert.ok(!text.includes(literal), `${label} retires: ${literal}`);
    }
  }
  const harnessLane = between(MODE_DOC, '- **Harness-managed sandbox**', '\n- ').toLowerCase();
  for (const literal of ['credential dirs', 'were rejected for']) {
    assert.ok(!harnessLane.includes(literal), `recommendations.md harness-managed lane retires: ${literal}`);
  }
  assert.match(BENEFITS['bridge-tier'], /^velocity — /);
  assert.doesNotMatch(BENEFITS['bridge-tier'], /safer|security|blast radius/iu);
});

const S21_PATHS = Object.freeze([
  'README.md', 'references/modes/recommendations.md', 'references/modes/velocity.md',
  'references/modes/recipes.md', 'references/modes/set-recipe.md', 'references/shared/report-footer.md',
  'tools/manifest/schema.md', 'tools/recipes.mjs', 'tools/write-lanes.mjs',
  'tools/manifest/validate.mjs', 'tools/ack-write.mjs', 'tools/velocity-profile.mjs',
]);
const S21_PHRASES = Object.freeze([
  'hand-apply', 'hand-applied', 'hand-add', 'paste-ready', 'by hand',
  'withhold', 'never writes', 'kit never', 'for safety',
]);
const S21_KEYS = Object.freeze([
  'excludedCommands', 'allowedDomains', 'allowWrite', 'networkHosts', 'writableDirs',
  'state dir', 'Bash(codex-review', 'Bash(agy-review',
]);
const S21_LINE_TOKEN = /sandbox-lane|sandboxLaneAck|not yet acknowledged|unacknowledged sandbox|Record the ack/iu;
const S21_ACK_PATH = 'tools/ack-write.mjs';

const splitSentences = (text, markdown) => {
  const paragraphs = text.split('\n').reduce((groups, raw, index) => {
    const comment = raw.match(/^\s*\/\/\s?(.*)$/u);
    const content = comment ? comment[1].trim() : raw.trim();
    const kind = comment ? 'comment' : markdown ? 'markdown' : 'source';
    const prior = groups.at(-1);
    if (!content) groups.push([]);
    else if (!prior?.length || prior[0].kind !== kind || kind === 'source' || /^\s*(?:[-*+] |\d+[.)] |#|\|)/u.test(raw)) {
      groups.push([{ content, kind, line: index + 1 }]);
    } else prior.push({ content, kind, line: index + 1 });
    return groups;
  }, []);
  return paragraphs.filter((paragraph) => paragraph.length).flatMap((paragraph) => {
    const spans = paragraph.map((line, index) => ({
      ...line, start: paragraph.slice(0, index).reduce((total, entry) => total + entry.content.length + 1, 0),
    }));
    const parts = paragraph.map(({ content }) => content).join(' ').split(/[.;] /u);
    return parts.map((sentence, index) => {
      const start = parts.slice(0, index).reduce((total, part) => total + part.length + 2, 0);
      const lines = spans.filter((span) => span.start < start + sentence.length && span.start + span.content.length > start);
      return { text: sentence, first: lines[0]?.line, last: lines.at(-1)?.line };
    }).filter(({ text: sentence }) => sentence.trim());
  });
};

describe('spec:velocity-profile/S21 — shipped bridge keys have no hand-apply advice', () => {
  it('sweeps retired lines and bridge sentences while preserving unrelated hand steps', () => {
    const usage = spawnSync(process.execPath, [resolve(kitRoot, 'tools/recommendations.mjs'), '--help'], { encoding: 'utf8' });
    assert.deepEqual([usage.error, usage.status], [undefined, 0], usage.stderr);
    const surfaces = [
      ...S21_PATHS.map((path) => [path, read(path)]),
      ['tools/recommendations.mjs', TOOL_SOURCE.match(/^#![^\n]*\n(?:\/\/[^\n]*\n)+/u)[0]],
      ['tools/recommendations.mjs --help', usage.stdout],
    ];
    const hits = surfaces.flatMap(([path, text]) => [
      ...text.split('\n').flatMap((line, index) => {
        const match = line.match(S21_LINE_TOKEN);
        const defaultLane = path === S21_ACK_PATH && /^export const DEFAULT_ACK_LANE = 'sandbox-lane';$/u.test(line);
        return match && !defaultLane ? [`${path}:${index + 1}-${index + 1}: ${match[0]}`] : [];
      }),
      ...splitSentences(text, path.endsWith('.md') || path.endsWith('--help')).flatMap(({ text: sentence, first, last }) => {
        const normalized = sentence.toLowerCase();
        const phrases = S21_PHRASES.filter((phrase) => normalized.includes(phrase));
        const keys = S21_KEYS.filter((key) => normalized.includes(key.toLowerCase()));
        return phrases.flatMap((phrase) => keys.map((key) => `${path}:${first}-${last}: ${phrase} + ${key}`));
      }),
    ]);
    for (const path of ['gates', 'core-evidence', 'upgrade']) {
      assert.match(read(`references/modes/${path}.md`), /paste-ready/iu, path);
    }
    for (const command of ['mcp']) {
      const row = README.split('\n').find((line) => line.includes(`\`/agent-workflow-kit ${command}\``));
      assert.ok(row, `README row: ${command}`);
      assert.match(row, /`mcp-channel`/u, command);
      assert.doesNotMatch(row, /paste-ready/iu, command);
    }
    assert.doesNotMatch(MODE_DOC, /HAND-APPLY/u);
    assert.match(MODE_DOC, /--lane worktrees-dir/u);
    assert.deepEqual(hits, [], `shipped bridge advice hits:\n${hits.join('\n')}`);
    assert.doesNotMatch(VELOCITY_DOC, /opt-in-capability: sandbox-lane/iu);
  });

  it('no worktrees consent surface pairs the grant with a hand step', () => {
    const row = README.split('\n').find((line) => line.includes('`/agent-workflow-kit worktrees`'));
    assert.ok(row, 'the README worktrees row exists');
    const surfaces = [
      ['worktrees-dir posture note', between(MODE_DOC, '- `worktrees-dir` —', POSTURE_NOTE_BOUNDARY)],
      ['lane paragraph', between(MODE_DOC, '3. **The apply-through-agent lane', '**Per-item posture notes')],
      ['invariants', between(MODE_DOC, '**Invariants:**', '\n')],
      ['worktrees.md consent', between(WORKTREES_DOC, '**Host-specific consent', '\n\n')],
      ['README worktrees row', row],
    ];
    const hits = surfaces.flatMap(([label, text]) => splitSentences(text, true).flatMap(({ text: sentence, first, last }) =>
      /worktrees/iu.test(sentence) && /hand-apply|by hand|yours to paste|maintainer-pasted/iu.test(sentence)
        ? [`${label}:${first}-${last}: ${sentence}`] : []));
    assert.deepEqual(hits, [], `worktrees hand-step advice hits:\n${hits.join('\n')}`);
  });
});

describe('spec:init-project/S33 shipped text of the three writers', () => {
  const variants = Object.freeze(['gate-hook', 'state-block', 'gate-hook.not-current', 'state-block.not-current']);
  const bannedTokens = /HAND-APPLY|\brm\b|No writer yet|has no writer|yours to paste|by hand/iu;
  const stateBlockDoc = read('references/modes/state-block-guard.md');
  const gatesDoc = read('references/modes/gates.md');
  const skillDoc = read('SKILL.md');
  const routerModeBudget = 52224;
  const OWN_HOOK = '.claude/hooks/<name>.local.mjs';
  const readmeRowOf = (command) => README.split('\n').find((line) => line.includes(`\`/agent-workflow-kit ${command}\``)) ?? '';
  // A retired word anywhere, or a clause (split at ; and at a sentence end) that says preserved or by hand of a hook file.
  const retiredHookWords = (text) => [...(text.match(/reseed|never clobbered|placement stays opt-in|never place new ones/giu) ?? []),
    ...text.split(/;|\.\s/u).filter((clause) => /preserved|by hand/iu.test(clause) && /\.mjs|hook file|placed hook/iu.test(clause))];

  it('hook.md, gates.md, state-block-guard.md, recommendations.md and the README hook rows carry no retired hook-file word', () => {
    const surfaces = { 'hook.md': HOOK_DOC, 'gates.md': gatesDoc, 'state-block-guard.md': stateBlockDoc, 'recommendations.md': MODE_DOC,
      'README hook row': readmeRowOf('hook'), 'README state-block-guard row': readmeRowOf('state-block-guard') };
    for (const [name, text] of Object.entries(surfaces)) assert.deepEqual(retiredHookWords(text), [], name);
  });

  it('the three writers have apply slots with no retired hand-step tokens', () => {
    const facts = { toolsDir: resolve(kitRoot, 'tools'), root: '/project', home: '/home/example', env: {}, platform: 'linux' };
    const applySlot = need(lanes, 'applySlot');
    for (const variant of variants) {
      const slot = applySlot(variant, facts);
      assert.ok(slot, `${variant} has a slot`);
      for (const line of [slot.check, slot.apply].filter((value) => value !== null)) {
        assert.doesNotMatch(line, bannedTokens, variant);
      }
    }
  });

  it('the gate-hook and read-lane notes carry no retired arm, name the kit item and keep the checked chat yes and optional init', () => {
    const notes = between(MODE_DOC, '**Per-item posture notes', '**Sandbox lanes');
    for (const key of ['gate-hook', 'read-lane']) {
      const note = between(notes, `- \`${key}\` —`, POSTURE_NOTE_BOUNDARY);
      assert.doesNotMatch(note, bannedTokens, key);
      assert.doesNotMatch(note, /marker-stale|read-lane\.stale|read-lane\.missing|\*\*stale\*\* arm/u, key);
      assert.ok(note.includes('`gate-hook.not-current`'), `${key} names the kit item`);
      assert.match(note, /\bagent\b[^.]*\bapplies\b[^.]*\bchat yes\b/i, key);
      assert.match(note, /after the check/i, key);
      assert.match(note, /\binit\b[^.]*\b(?:may take|instead)\b/i, key);
    }
  });

  it('state-block-guard.md names the writer and its offered command, including the --require-block paragraph', () => {
    assert.doesNotMatch(stateBlockDoc, bannedTokens, 'state-block-guard.md');
    const opening = between(stateBlockDoc, '<!-- opt-in-capability:', '**Read this first');
    assert.ok(opening.includes('tools/state-block-hook.mjs'));
    assert.ok(opening.includes('node "$CLAUDE_PROJECT_DIR/.claude/hooks/state-block-guard.mjs"'));
    assert.doesNotMatch(opening, /read-only/iu);
    const requireBlock = between(stateBlockDoc, '**The writer offers that command without', '\n\n');
    assert.match(requireBlock, /\bwriter\b/iu);
    assert.ok(requireBlock.includes('--require-block'));
    assert.ok(stateBlockDoc.includes('`state-block.not-current`'), 'state-block-guard.md names the kit item for a wired runtime absent or differing');
  });

  it('hook.md states the rule, the own hook file and the kit item, and its invariant keeps only the wiring opt-in', () => {
    const otherHook = between(HOOK_DOC, "**The kit's other hook.**", '');
    assert.ok(otherHook.includes('tools/state-block-hook.mjs'));
    assert.doesNotMatch(otherHook, bannedTokens);
    for (const pin of [/\bplaced when (?:it is )?absent\b/iu, /\bwritten with the kit's body\b/iu, /\bno copy (?:is )?kept\b/iu, /\bwith no question\b/iu]) assert.ok(pin.test(HOOK_DOC), `hook.md states: ${pin}`);
    for (const literal of [OWN_HOOK, '`gate-hook.not-current`', 'once the hook is wired',
      "(wiring stays opt-in — the AD-011/AD-034 boundary: the upgrade with no question, and init on its one y, place or refresh the hook file of a hook the user wired, and a hook is wired only on the user's yes to its offer)"]) {
      assert.ok(HOOK_DOC.includes(literal), `hook.md carries: ${literal}`);
    }
    assert.doesNotMatch(HOOK_DOC, /no refresh-only hook lane|placed \*\*and\*\* wired/iu);
  });

  it('gates.md recovers a marker-carrying declaration with gate-hook.not-current, applied with no question', () => {
    const marker = between(gatesDoc, '**A marker-carrying declaration needs a CURRENT placed hook.**', '\n\n');
    assert.ok(marker.includes('`gate-hook.not-current`'));
    assert.match(marker, /\bwith no question\b/iu);
    assert.doesNotMatch(marker, bannedTokens);
  });

  it('the README hook and state-block-guard rows state the rule, the own hook file and the writer', () => {
    const [hookRow, stateBlockRow] = [readmeRowOf('hook'), readmeRowOf('state-block-guard')];
    for (const [name, row] of [['hook', hookRow], ['state-block-guard', stateBlockRow]]) {
      assert.ok(row.includes(OWN_HOOK), `README ${name} row names the own hook file`);
      assert.match(row, /\bwith no question\b/iu, `README ${name} row states the rule`);
    }
    assert.ok(stateBlockRow.includes('tools/state-block-hook.mjs'));
    assert.doesNotMatch(stateBlockRow, /has no writer|yourself/iu);
  });

  it('the state-block-guard catalog kind and SKILL.md router line both say writer', () => {
    assert.equal(kindOf('state-block-guard'), 'writer');
    const mode = between(skillDoc, '### Mode: state-block-guard', '\n### Mode:');
    const line = mode.split('\n').slice(1).find((entry) => entry.trim());
    assert.match(line, /^writer — /u);
  });

  it('the user-item example excludes read-lane.stale and both sandbox passages call the bare item the user\'s own step', () => {
    const lane = between(MODE_DOC, '3. **The apply-through-agent lane', '\n4.');
    const example = between(lane, 'A user item is the user', 'After presenting');
    assert.doesNotMatch(example, /`read-lane\.stale`/u);
    assert.match(example, /source-size\.id-squatter/u);
    assert.doesNotMatch(example, /enforcement/iu);
    assert.doesNotMatch(example, /worktrees/iu);
    for (const start of ['The sandbox items state:', '**Invariants:**']) {
      const line = between(MODE_DOC, start, '\n');
      assert.match(line, /the bare `sandbox-provision`[^·\n]*user's own step/u, start);
    }
  });

  it('recommendations.md and SKILL.md together stay within the 52224-byte router budget', () => {
    const bytes = Buffer.byteLength(MODE_DOC) + Buffer.byteLength(skillDoc);
    assert.ok(bytes <= routerModeBudget, `router plus recommendations.md: ${bytes} > ${routerModeBudget} bytes`);
  });
});

describe('spec:init-project/S37 shipped text of the two git-hook items', () => {
  const notes = between(MODE_DOC, '**Per-item posture notes', '**Sandbox lanes');
  const note = between(notes, ENFORCEMENT_NOTE_START, POSTURE_NOTE_BOUNDARY);
  const lane = between(MODE_DOC, '3. **The apply-through-agent lane', '\n4.');
  const invariants = between(MODE_DOC, '**Invariants:**', '\n');
  const step8 = between(BOOTSTRAP_DOC, '8. **Offer enforcement', '\n9. **');
  const step9 = between(BOOTSTRAP_DOC, '9. **Wire / hide**', '\n   - **visible**');
  const upgrade = between(UPGRADE_DOC, '**What the enforcement-script ensure does.**', '\n\n');
  const bannedTokens = /HAND-APPLY|\bmerge\b|by hand|bootstrap steps? 8|node scripts\/install-git-hooks|copied scripts stay|only when the maintainer applies|\bcp\b|mkdir -p/iu;

  it('the note, bootstrap leads and upgrade paragraph retire hand steps; the example and invariants drop the old exceptions', () => {
    const example = between(lane, 'A user item is the user', 'After presenting');
    for (const [label, text] of [['enforcement note', note], ['bootstrap step 8', step8], ['bootstrap step 9 lead', step9], ['upgrade ensure', upgrade]]) {
      assert.doesNotMatch(text, bannedTokens, label);
    }
    assert.doesNotMatch(example, /`enforcement`/u);
    assert.match(example, /source-size\.id-squatter/u);
    assert.doesNotMatch(example, /read-lane\.stale|worktrees/iu);
    assert.doesNotMatch(invariants, /no-writer|keep their text/u);
  });

  it('both apply slots and the advisor source retire the installer and hand-copy instructions', () => {
    const facts = { toolsDir: resolve(kitRoot, 'tools'), root: '/project', home: '/home/example', env: {}, platform: 'linux' };
    const applySlot = need(lanes, 'applySlot');
    for (const variant of ['enforcement', 'commit-guard']) {
      const slot = applySlot(variant, facts);
      assert.ok(slot, `${variant} has a slot`);
      for (const line of [slot.check, slot.apply]) {
        assert.doesNotMatch(line, /HAND-APPLY|install-git-hooks|\bcp\b|mkdir -p|by hand/u, variant);
      }
    }
    for (const literal of ['HAND-APPLY: mkdir', 'merge the guard line by hand', 'bootstrap steps 8']) {
      assert.ok(!TOOL_SOURCE.includes(literal), `the advisor retires: ${literal}`);
    }
  });

  it('bootstrap checks enforcement before its one ask, leaves refusals pending and applies commit-guard the same way; upgrade uses that route', () => {
    for (const literal of [
      'node ${CLAUDE_SKILL_DIR}/tools/apply-danger-check.mjs --variant enforcement --cwd <project>',
      'Ask once on that result', 'the copy is create-only', '(exit 1 or 3)', 'exits 6', 'fill the command slots as on a no',
    ]) {
      assert.ok(step8.includes(literal), `bootstrap step 8 states: ${literal}`);
    }
    for (const literal of ["the advisor's `commit-guard` item", 'its check line first', "exits 6 with the installer's output"]) {
      assert.ok(step9.includes(literal), `bootstrap step 9 states: ${literal}`);
    }
    assert.doesNotMatch(step9, /install-git-hooks/u);
    assert.ok(upgrade.includes('the `enforcement` check line and apply, by the consent route'));
    assert.doesNotMatch(upgrade, /node scripts\/install-git-hooks\.mjs/u);
  });

  it('recommendations.md with the router stays within 52224 bytes', () => {
    const routerModeBudget = 52224;
    const bytes = Buffer.byteLength(MODE_DOC) + Buffer.byteLength(read('SKILL.md'));
    assert.ok(bytes <= routerModeBudget, `router plus recommendations.md: ${bytes} > ${routerModeBudget} bytes`);
  });
});

describe('spec:velocity-profile/S26 — velocity.md and the README velocity row document the --worktrees mode', () => {
  it('the worktrees paragraph pins the one local entry, created parent, home refusal, widening and narrowing', () => {
    const paragraph = between(VELOCITY_DOC, '**The `--worktrees` grant (own opt-in, its own mode).**', '\n\n').replace(/\s+/gu, ' ');
    for (const literal of [
      'velocity-profile.mjs --worktrees [--apply] [--cwd <dir>]',
      'It writes ONE `sandbox.filesystem.allowWrite` entry, the worktrees parent itself',
      "into this copy's `.claude/settings.local.json` alone, and creates the parent when it is missing",
      'It never writes `.claude/settings.json`, seeds no core and no ask rule, and cannot be combined with `--autonomy`, `--kit-tools`, `--bridge-tier` or `--accept-edits`',
      'A parent that is the home or holds it is refused (`VELOCITY_WORKTREES_HOME`), nothing written',
      'can then write the whole parent dir, sibling repositories under it included, for every later session',
      'Narrow it BEFORE the first apply: point `parentDir` at a dedicated dir',
    ]) {
      assert.ok(paragraph.includes(literal), `velocity.md worktrees paragraph states: ${literal}`);
    }
  });

  it('the opening and invariants name the worktrees exception to the project settings target', () => {
    const opening = between(VELOCITY_DOC, 'The opt-in onboarding', '\n\n').replace(/\s+/gu, ' ');
    const invariants = between(VELOCITY_DOC, '**Invariants:**', '\n').replace(/\s+/gu, ' ');
    assert.ok(opening.includes('its `--worktrees` mode alone writes `.claude/settings.local.json` plus the created parent'));
    assert.ok(invariants.includes('and with `--worktrees` alone `.claude/settings.local.json` plus the created parent'));
  });

  it('every local-file refusal or project-only claim before the autonomy heading names the worktrees exception', () => {
    const seeding = between(VELOCITY_DOC, '### Mode: velocity', '## The `--autonomy` render').replace(/[`*]/gu, '');
    const hits = splitSentences(seeding, true).filter(({ text }) =>
      /never writes settings\.local\.json|writes only \.claude\/settings\.json/iu.test(text) && !text.includes('--worktrees'));
    assert.deepEqual(hits, [], 'settings target claims outside the autonomy render name the --worktrees exception');
  });

  it('the README velocity row names the fourth local opt-in and neither surface denies the grant writer', () => {
    const row = README.split('\n').find((line) => line.includes('`/agent-workflow-kit velocity`'));
    assert.ok(row, 'the README velocity row exists');
    assert.ok(row.replace(/\s+/gu, ' ').includes('a fourth opt-in, `--worktrees`, writes the worktrees grant into the local settings, `.claude/settings.local.json`, alone'));
    for (const [label, text] of [['velocity.md', VELOCITY_DOC], ['README velocity row', row]]) {
      assert.doesNotMatch(text.replace(/\s+/gu, ' '), /kit never writes the grant|yours to paste/iu, label);
    }
    assert.doesNotMatch(row, /never writes `settings\.local\.json`/iu, 'README velocity row');
  });

  it('the velocity help limits the apply ask rule to flagless, kit-tools and bridge-tier applies', () => {
    const usage = spawnSync(process.execPath, [resolve(kitRoot, 'tools/velocity-profile.mjs'), '--help'], { encoding: 'utf8' });
    assert.deepEqual([usage.error, usage.status], [undefined, 0], usage.stderr);
    assert.ok(usage.stdout.replace(/\s+/gu, ' ').includes('Every flagless, --kit-tools and --bridge-tier apply also appends the apply ask rule'));
  });
});

describe("spec:init-project/S44 — the worktrees grant's shipped text", () => {
  const notes = between(MODE_DOC, '**Per-item posture notes', '**Sandbox lanes');
  const note = between(notes, '- `worktrees-dir` —', POSTURE_NOTE_BOUNDARY).replace(/\s+/gu, ' ');
  const lane = between(MODE_DOC, '3. **The apply-through-agent lane', '**Per-item posture notes').replace(/\s+/gu, ' ');
  const invariants = between(MODE_DOC, '**Invariants:**', '\n').replace(/\s+/gu, ' ');
  const consent = between(WORKTREES_DOC, '**Host-specific consent', '\n\n').replace(/\s+/gu, ' ');
  const worktreesRow = README.split('\n').find((line) => line.includes('`/agent-workflow-kit worktrees`'));
  const routerModeBudget = 52224;

  it('the recipe list names the ack fallback and the lane applies the checked grant within the router budget', () => {
    const recipes = between(MODE_DOC, 'The **read-only deployment advisor**', '**Live host/session facts').replace(/\s+/gu, ' ');
    assert.ok(recipes.includes('the `worktrees-dir` ack fallback'));
    assert.ok(lane.includes(WORKTREES_LANE_SENTENCE));
    const bytes = Buffer.byteLength(MODE_DOC) + Buffer.byteLength(read('SKILL.md'));
    assert.ok(bytes <= routerModeBudget, `router plus recommendations.md: ${bytes} > ${routerModeBudget} bytes`);
  });

  it('the posture note and invariants pin local consent, scope, narrowing, the home step and the recipe ack recorder', () => {
    for (const literal of WORKTREES_NOTE_LITERALS) {
      assert.ok(note.includes(literal), `the worktrees-dir note states: ${literal}`);
    }
    for (const literal of [
      'the worktrees grant is seeded into the local settings by the consented `velocity-profile --worktrees`',
      'recorded by the `ack-write` line its `recipe:` line carries, not by its apply line',
    ]) {
      assert.ok(invariants.includes(literal), `recommendations.md invariants state: ${literal}`);
    }
  });

  it('worktrees consent names the checked chat apply, local target, terminal fallback and recipe ack recorder', () => {
    for (const literal of WORKTREES_CONSENT_LITERALS) {
      assert.ok(consent.includes(literal), `worktrees.md consent states: ${literal}`);
    }
    assert.doesNotMatch(consent, /consent-gated apply one-liner|\.claude\/settings\.json|paste/iu);
  });

  it('the README advisor and worktrees rows name the ack fallback, checked chat apply, local settings and optional init', () => {
    assert.ok(readmeRow, 'the README advisor row exists');
    assert.ok(worktreesRow, 'the README worktrees row exists');
    assert.ok(readmeRow.replace(/\s+/gu, ' ').includes('the worktrees-dir ack fallback for a host that ignores the settings key'));
    assert.ok(worktreesRow.replace(/\s+/gu, ' ').includes("an unwritable parent prints the `worktrees-dir` check line: the agent applies the grant on your chat yes after the check, one entry in this copy's `.claude/settings.local.json`, never the committed project settings (`init` is the route you may take instead, and the ack is the fallback for a host that ignores the key)"));
  });

  it('the shipped grant surfaces retire the hand-apply-first, waiting and paste instructions', () => {
    assert.ok(readmeRow, 'the README advisor row exists');
    assert.ok(worktreesRow, 'the README worktrees row exists');
    for (const [label, text] of [
      ['recommendations.md', MODE_DOC], ['worktrees.md consent', consent],
      ['README advisor row', readmeRow], ['README worktrees row', worktreesRow],
    ]) {
      assert.doesNotMatch(text.replace(/\s+/gu, ' '), /hand-apply-first|wait for the maintainer to confirm the grant|maintainer-pasted commands|The kit does not write this worktrees grant|yours to paste/iu, label);
    }
  });

  it('worktrees acknowledgement sentences name no apply one-liner and worktrees-dir sentences name no grant advice or HAND-APPLY', () => {
    assert.ok(readmeRow, 'the README advisor row exists');
    assert.ok(worktreesRow, 'the README worktrees row exists');
    const surfaces = [
      ['recommendations.md', MODE_DOC], ['worktrees.md consent', consent],
      ['README advisor row', readmeRow], ['README worktrees row', worktreesRow],
    ];
    const hits = surfaces.flatMap(([label, text]) => splitSentences(text, true).flatMap(({ text: sentence, first, last }) => {
      const normalized = sentence.replace(/[`*]/gu, '').replace(/\s+/gu, ' ');
      const ackHit = /worktreesDirAck|--lane worktrees-dir|the worktrees-dir acknowledgement/iu.test(normalized)
        && /apply one-liner|never by the recipe: line/iu.test(normalized);
      const grantHit = /worktrees-dir/iu.test(normalized) && /grant advice|HAND-APPLY/iu.test(normalized);
      return ackHit || grantHit ? [`${label}:${first}-${last}: ${sentence}`] : [];
    }));
    assert.deepEqual(hits, [], `retired worktrees grant or ack advice:\n${hits.join('\n')}`);
  });
});

const namesAgentsItem = (name, text, flat = text.replace(/\s+/gu, ' ')) => assert.ok(/\bagents`? item\b/u.test(flat) && !/executor-vehicle\.differing|agents\.not-current|\bwith no question\b|\bon consent\b|\byes\b/u.test(flat), `${name}: ${flat}`);
describe('spec:init-project/S50 — shipped text of the five writes', () => {
  it('bootstrap declares both capabilities and routes steps 4 and 9 through their items without hand steps', () => {
    for (const key of ['attribution', 'footprint-global']) {
      assert.ok(BOOTSTRAP_DOC.includes(`<!-- opt-in-capability: ${key} -->`), key);
    }
    const step4 = between(BOOTSTRAP_DOC, '4. **Choose agent attribution', '\n5. **');
    const step9 = between(BOOTSTRAP_DOC, '9. **Wire / hide**', '\n10. **');
    assert.ok(step4.includes("the advisor's `attribution` item of step 11 sets the harness setting"));
    assert.ok(step9.includes("the advisor's `footprint-global` item of step 11 removes it on the user's yes after its check"));
    for (const step of [step4, step9]) {
      assert.doesNotMatch(step, /\b(?:by hand|No Node on the agent host|includeCoAuthoredBy|create it if absent|write the one managed block)\b/iu);
    }
  });

  it('upgrade names footprint-global and the pending differing arm', () => {
    const footprint = between(UPGRADE_DOC, '**`footprint` — hidden-mode footprint reconcile', '\n\n');
    assert.ok(footprint.includes("the advisor's `footprint-global` item removes it"));
    assert.doesNotMatch(footprint, /\bask before `--remove-global`/iu);
    const executor = between(UPGRADE_DOC, '**What the executor ensure does.**', '\n\n');
    for (const text of [between(UPGRADE_DOC, '3. `configs` —', '\n'), between(UPGRADE_DOC, '**`configs` —', '\n\n'), executor]) {
      assert.ok(text.includes('`pending`'));
      assert.doesNotMatch(text, /\b(?:re-derived|would-re-derive)\b/u);
    }
    namesAgentsItem('upgrade.md', executor);
    assert.ok(between(read('references/shared/composition-handoff.md'), '- **Delegated**', '- **Fallback**')
      .includes('memory is told to skip its step-4 settings write; the `attribution` item of step 11 sets it'));
  });

  it('migration steps, verification and rollback name their items and retire manual creation, merging and grep verification', () => {
    const attribution = read('migrations/1.2.0-agent-attribution.md');
    const step5 = between(attribution, '5. **Whenever the Attribution block', '\n6.');
    const step4 = between(read('migrations/3.0.0-hardened-core-loop.md'), '4. **Commit guard', '\n5.');
    for (const [key, text] of [
      ['attribution', step5], ['attribution', between(attribution, '## Verification', '## Rollback')],
      ['attribution', between(attribution, '## Rollback', '')], ['commit-guard', step4],
    ]) {
      assert.ok(text.includes(`\`${key}\``), key);
      assert.doesNotMatch(text.replace(/\s+/gu, ' '), /\b(?:create it as|if absent|STOP and merge|by hand|grep|preserves existing scripts|cmp -s|your own step)\b/iu, key);
    }
    assert.ok(step5.replace(/\s+/gu, ' ').includes('"includeCoAuthoredBy": false already converges the item'));
    assert.ok(['makes the apply exit 6 with one line naming the hook and the guard line the installer left out, ending with the upgrade route', '`/agent-workflow-kit upgrade`'].every((phrase) => step4.replace(/\s+/gu, ' ').includes(phrase)));
  });

  it('the trailer gotcha and the attribution and visibility contracts name the advisor items', () => {
    const trailer = between(read('references/shared/deploy-tail.md'), '- **The `Co-Authored-By` trailer', '\n');
    const contracts = read('references/contracts.md');
    const attribution = between(contracts, '- **Two enforcement layers**', '\n');
    const visibility = between(contracts, '- **hidden** (in-tree)', '\n');
    for (const text of [trailer, attribution]) {
      assert.ok(text.includes("the advisor's `attribution` item sets the harness setting"));
    }
    assert.ok(visibility.includes("removal is the advisor's `footprint-global` item, which the agent applies on the user's yes after its check"));
  });

  it('the two posture notes permit checked chat consent and optional init, warn about other repositories and distinguish differing from placed', () => {
    const notes = between(MODE_DOC, '**Per-item posture notes', '**Sandbox lanes');
    for (const key of ['attribution', 'footprint-global']) {
      const note = between(notes, `- \`${key}\` — `, POSTURE_NOTE_BOUNDARY);
      assert.ok(note.includes('the agent applies the item on the chat yes after the check'), key);
      assert.ok(note.includes('`init` applies it on the terminal y as the route the user may take instead'), key);
    }
    assert.ok(between(notes, '- `footprint-global` — ', POSTURE_NOTE_BOUNDARY).includes("Another of the user's repositories may rely on the same lines"));
    const executor = between(MODE_DOC, '**The `executor-vehicle` item', '\n\n');
    const flat = executor.replace(/\s+/gu, ' ');
    assert.ok(/\bkit item\b[^.;]*\bwith no question\b/u.test(flat) && /\byield[^.;]*agents\.not-current/u.test(flat) && !flat.includes('executor-vehicle.differing'), flat);
    assert.ok(executor.includes('**`placed` renders NOTHING**'));
    assert.doesNotMatch(executor, /\bcustomized\b[^.;\n]*\brenders? NOTHING\b/iu);
  });

  it('composition and vehicles name the pending items and ensure-configs help retires re-derive', () => {
    assert.ok(read('references/shared/composition-handoff.md').replace(/\s+/gu, ' ').includes("(a stale memory's residual global block is the advisor's footprint-global item)"));
    assert.ok(JSON.parse(read('references/templates/vehicles.json'))._README.includes('the upgrade reports a differing body as pending'));
    const help = between(read('tools/ensure-configs.mjs'), 'Usage:', '`;');
    assert.ok(help.includes('is pending'));
    assert.doesNotMatch(help, /\bre-derive(?:d)?\b/iu);
    namesAgentsItem('ensure-configs help', between(help, 'The executor ensure writes nothing', 'A fifth writes too'));
    const lines = read('tools/ensure-executor.mjs').split('\n').filter((line) => line.includes("the advisor's") && !line.trim().startsWith('//'));
    for (const line of lines.length > 0 ? lines : ['(no line names the advisor)']) namesAgentsItem('ensure-executor line', line);
    const agents = read('references/modes/agents.md');
    assert.ok(agents.includes('differs from the body derived from the vehicle settings') && !agents.includes('--executor'));
    assert.ok(readmeRow.includes("; a kit item it applies with no question, its check line first, the harness's own dialog the only ask, or the one plain step where auto mode refuses its check or apply"));
    assert.ok(README.split('\n').find((line) => line.includes('`/agent-workflow-kit velocity`')).includes('a harness or kit apply (the `apply:` line of each harness or kit item'));
  });
});

describe('spec:carriers/S28 shipped text of the kit agent files rule', () => {
  const [OWN, RETIRED] = ['.claude/agents/<name>.local.md', /--executor|\bpreserved\b|never overwritten|delete the file to reseed|Only on an explicit yes/iu];
  it("agents.md, the writer's --help and header and the README agents row state the rule and the own-vehicle file with no retired word; agents.md's step 2, the base arm's yield, the router budget, upgrade.md and ensure-configs", async () => {
    const help = [];
    (await import('../tools/cheap-agents.mjs')).main(['--help'], { log: (line) => help.push(line) });
    const surfaces = { 'agents.md': read('references/modes/agents.md'), '--help': help.join('\n'), header: read('tools/cheap-agents.mjs').split('\nimport ')[0], 'README agents row': README.split('\n').find((line) => line.startsWith('| `/agent-workflow-kit agents`')) ?? '' };
    const misses = Object.entries(surfaces).flatMap(([name, text, flat = text.replace(/\s+/gu, ' ')]) => [
      !/\bwith no question\b/u.test(flat) && `${name}: no rule`, !flat.includes(OWN) && `${name}: no ${OWN}`, RETIRED.test(flat) && `${name}: ${flat.match(RETIRED)?.[0]}`,
      /\bcustomized\b/iu.test(flat.replace(/`customized`/gu, '')) && `${name}: customized outside its code span`].filter(Boolean));
    assert.deepEqual(misses, []);
    const step2 = between(read('references/modes/agents.md'), '\n2. ', '\n3. ').replace(/\s+/gu, ' ');
    assert.ok(['agents.not-current', '--apply'].every((word) => step2.includes(word)) && /\bwith no question\b/u.test(step2) && /\bfirst placement\b[^.]*\byes\b/iu.test(step2), step2);
    assert.match(between(MODE_DOC, '**The `executor-vehicle` item', '\n\n').replace(/\s+/gu, ' '), /\byield[^.;]*agents\.not-current/u);
    assert.ok(Buffer.byteLength(MODE_DOC) + Buffer.byteLength(read('SKILL.md')) <= 52224);
    namesAgentsItem('upgrade.md', between(UPGRADE_DOC, '**What the executor ensure does.**', '\n\n'));
    namesAgentsItem('ensure-configs help', between(between(read('tools/ensure-configs.mjs'), 'Usage:', '`;'), 'The executor ensure writes nothing', 'A fifth writes too'));
  });
});

describe('spec:init-project/S57 shipped text of revision 11', () => {
  const readmeSurfaces = [
    between(README, '### 1.', '### 2.'),
    between(README, 'After `init`,', '> **Optional standalone'),
    between(README, '> **Two kinds of "upgrade":', '\n---'),
    between(README, 'The kit is the member you install', '\n```'),
  ];

  it('the advisor sources, help and shipped restatements retire HAND-APPLY', () => {
    const usage = spawnSync(process.execPath, [resolve(kitRoot, 'tools/recommendations.mjs'), '--help'], { encoding: 'utf8' });
    assert.deepEqual([usage.error, usage.status], [undefined, 0], usage.stderr);
    const surfaces = [
      ['tools/recommendations.mjs', TOOL_SOURCE],
      ['tools/write-lanes.mjs', read('tools/write-lanes.mjs')],
      ['recommendations --help', usage.stdout],
      ['recommendations.md', MODE_DOC],
      ['gates.md producer paragraph', between(read('references/modes/gates.md'), '**The coverage PRODUCER', '\n')],
      ['mcp.md MASKED arm', between(MCP_DOC, '- **MASKED**', '\n')],
      ...readmeSurfaces.map((text, index) => [`README restatement ${index + 1}`, text]),
    ];
    for (const [label, text] of surfaces) {
      for (const line of text.split('\n')) {
        assert.doesNotMatch(line, /hand-apply/iu, `${label} retires HAND-APPLY`);
      }
    }
  });

  it('the lane names the user step and keeps the second-yes exception in the printed-follow-up sentence', () => {
    const lane = between(MODE_DOC, '3. **The apply-through-agent lane', '\n4.').replace(/\s+/gu, ' ');
    assert.ok(lane.includes("A user item is the user's own step, handed over as worded"), 'the lane names the user item as the user\'s own step');
    assert.ok(lane.includes('(e.g. `source-size.id-squatter`)'), 'the lane keeps the user-item example');
    assert.doesNotMatch(lane, /maintainer territory/iu);
    const followUp = 'you run that printed follow-up command — no second ask, no improvisation (each writer keeps its own consent semantics: previews, `--apply` flags, refusals) — except profile-gap, whose apply line runs with --apply appended only on a second yes over the relayed preview.';
    assert.ok(lane.includes(followUp), 'the printed-follow-up sentence itself carries the profile-gap second-yes exception alone');
  });

  it('the recipe descriptions name user facts and alternatives and the README points to the writers table', () => {
    const recipeShape = "an optional `recipe:` line (an item's own facts or its alternative, such as the `bridge-tier` missing-entries line or the `worktrees-dir` ack fallback)";
    assert.ok(MODE_DOC.split('\n')[6].includes(recipeShape), 'recommendations.md line 7 names the recipe class with its pinned examples');
    assert.ok(readmeRow, 'the README advisor row exists');
    assert.ok(readmeRow.includes("a user item's own facts, the spec-adoption decline preview"), 'the README advisor row names user facts before the decline preview');
    assert.ok(readmeRow.includes('`references/advisor-writers.md`'), 'the README advisor row points to the writers table');
    assert.ok(readmeRow.includes('the worktrees-dir ack fallback for a host that ignores the settings key'), 'the README keeps the worktrees ack fallback');
    assert.ok(readmeRow.includes('runs EXACTLY the rendered one-liners and the follow-up commands required by the mode doc, only on the answer authorizing that step — your yes to apply or your explicit decline to record it — with a second yes where the mode doc requires it'),
      'the README advisor row names the follow-up commands, the recorded decline and the second yes');
  });

  it('the posture notes name user steps and recorded declines, keep no adr-store-migration note and drop no risk key', () => {
    const notes = between(MODE_DOC, '**Per-item posture notes', '**Sandbox lanes');
    const bullets = notes.split(POSTURE_NOTE_BOUNDARY);
    const gatesNote = bullets.find((note) => note.startsWith('`gates-inert` —'));
    assert.ok(gatesNote?.includes('the user item `gates-inert.unfillable`'), 'the gates-inert note names the unfillable user item');
    assert.ok(gatesNote.includes("the user's own step"), 'the gates-inert note names the user\'s own step');
    for (const start of ['ADDITIONAL `gates-inert` arms', '`source-size` —']) {
      const note = bullets.find((entry) => entry.startsWith(start));
      assert.ok(note?.includes("the user's own step"), `${start} names the user's own step`);
    }
    assert.equal(bullets.find((note) => note.startsWith('`adr-store-migration` —')), undefined, 'no adr-store-migration note remains');
    for (const key of ['spec-adoption', 'jev-connect', 'jev-skill']) {
      const note = bullets.find((entry) => entry.startsWith(`\`${key}\` —`));
      assert.ok(note?.includes('the agent records'), `${key} names the decline the agent records`);
      assert.ok(note.includes('BEFORE the confirmation'), `${key} asks apart before the confirmation`);
    }
    const noteKeys = [...notes.matchAll(/^- `([a-z-]+)`/gmu)].map((match) => match[1]);
    assert.deepEqual([...noteKeys].sort(), [...RISK_NOTED_KEYS].sort(), 'risk-marked keys still equal the posture-note keys');
  });

  it('the README and catalog masked clauses name the mcp-channel consent route', () => {
    const row = README.split('\n').find((line) => line.includes('`/agent-workflow-kit mcp`'));
    assert.ok(row, 'the README mcp row exists');
    const masked = between(row, 'Where an OS sandbox masks', '. ');
    assert.ok(masked.includes('`mcp-channel`'), 'the README masked sentence names mcp-channel');
    assert.ok(masked.includes('consent route'), 'the README masked sentence names the consent route');
    assert.doesNotMatch(masked, /merge|paste|hands/iu, 'the README masked sentence retires the text handoff');
    assert.ok(row.includes('**exact entry is printed before consent**'), 'the README keeps the preview exact-entry promise');
    const command = COMMANDS.find(({ key }) => key === 'mcp');
    assert.ok(command, 'the mcp catalog entry exists');
    assert.ok(command.oneLine.includes('mcp-channel'), 'the mcp catalog names mcp-channel');
    assert.ok(command.oneLine.includes('consent route'), 'the mcp catalog names the consent route');
    assert.doesNotMatch(command.oneLine, /paste|hands|merge|\b(?:fragment|slot|marker|reconcile)\b/iu, 'the mcp catalog retires handoff text and keeps its vocabulary boundary');
  });

  it('mcp.md routes the masked arm through the item and keeps the settings merge refusal', () => {
    const masked = between(MCP_DOC, '- **MASKED**', '\n');
    assert.ok(masked.includes('`mcp-channel`'), 'the mcp.md MASKED arm names mcp-channel');
    assert.ok(masked.includes('consent route'), 'the mcp.md MASKED arm names the consent route');
    assert.doesNotMatch(masked, /mcpServers|paste|hands over/iu, 'the MASKED arm retires fragments and handoff instructions');
    assert.match(masked, /merge/u, 'the masked settings.json refusal keeps its merge boundary');
    for (const start of ['**Refusals', '**Exit codes:**']) {
      assert.match(between(MCP_DOC, start, '\n'), /`mcp-channel`/u, `${start} names mcp-channel`);
    }
    assert.doesNotMatch(MCP_DOC, /hand-apply|paste|hands over|what it would have/iu, 'mcp.md retires the masked text handoff');
  });

  it('upgrade names the recorded decline and the advisor stays within the router byte budget', () => {
    assert.ok(UPGRADE_DOC.includes('the decline the agent records'), 'upgrade.md names the decline the agent records');
    assert.doesNotMatch(UPGRADE_DOC, /hand-apply/iu, 'upgrade.md retires hand-apply');
    const routerModeBudget = 52224;
    const bytes = Buffer.byteLength(MODE_DOC) + Buffer.byteLength(read('SKILL.md'));
    assert.ok(bytes <= routerModeBudget, `router plus recommendations.md: ${bytes} > ${routerModeBudget} bytes`);
  });
});
