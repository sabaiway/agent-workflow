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
  handApply: 'HAND-APPLY',
  noClobber: 'never clobbers an existing file',
  noFollow: 'never follows a link',
  installerRefusal: 'refuses to overwrite',
  mergeRemedy: 'merge the hook by hand',
});
const ENFORCEMENT_RISK_PROFILE_END = /Risk profile: [^\n]+\.$/u;

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

  it('the worktrees-dir note distinguishes host classes and keeps the scope-narrowing mitigation', () => {
    assert.match(notes, /- `worktrees-dir` — /, 'the posture note exists');
    assert.match(notes, /settings-native/i, 'the settings-native effect is qualified');
    assert.match(notes, /harness-managed/i, 'the settings-ignoring host class is named');
    assert.match(notes, /host\/session/i, 'the harness-managed allowance is host/session-scoped');
    assert.match(notes, /terminal fallback/i, 'the terminal fallback remains available');
    assert.match(notes, /every sibling path under it/i, 'the sibling-wide scope is stated');
    assert.match(notes, /dedicated dir/i, 'the narrowing mitigation is stated');
    assert.match(notes, /parentDir/, 'the mitigation names the setting');
    assert.match(notes, /re-run recommendations/i, 'the re-check step is stated');
  });

  it('the enforcement note pins hand-apply safety, installer refusal, and its risk profile', () => {
    const start = notes.indexOf(ENFORCEMENT_NOTE_START);
    assert.notEqual(start, -1, 'the enforcement posture note exists');
    const enforcementNote = notes.slice(start).split(POSTURE_NOTE_BOUNDARY)[0];
    for (const [label, literal] of Object.entries(ENFORCEMENT_NOTE_LITERALS)) {
      assert.ok(enforcementNote.includes(literal), `${label}: ${literal}`);
    }
    assert.match(enforcementNote, ENFORCEMENT_RISK_PROFILE_END);
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

  it('worktrees-dir-consent-flow-waits-for-the-grant-then-runs-preview-and-printed-apply', () => {
    // The ack RECORDS a maintainer choice; executing it straight from the render would converge
    // the item with no grant made. The contract therefore sequences the item: HAND-APPLY is
    // maintainer territory wherever it renders, and the ack preview (plus its printed --apply)
    // runs only after the grant/fallback confirmation.
    assert.match(MODE_DOC, /maintainer territory wherever it renders/i, 'HAND-APPLY is bound to territory, not to a slot');
    assert.match(
      MODE_DOC,
      /wait for the maintainer to confirm the grant is applied \(or the terminal fallback chosen\)/i,
      'the flow waits for the grant',
    );
    assert.match(
      MODE_DOC,
      /before running that preview and the exact `--apply` command it prints/i,
      'the preview AND the printed --apply follow the confirmation',
    );
    assert.doesNotMatch(
      MODE_DOC,
      /acknowledgement carried by this item's rendered `recipe:` line/,
      'the retired ack-in-recipe claim is gone',
    );
    assert.match(WORKTREES_DOC, /consent-gated apply one-liner records/i, 'worktrees.md names the apply lane');
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
    for (const arm of ['producer-unrecognized', 'coverage-domain-narrow', 'adopted-elsewhere', 'id-squatter', 'marker-stale']) {
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

  it('the destructive arms stay HAND-APPLY in the doc, never a command the consent flow runs', () => {
    for (const phrase of ['`producer-unrecognized`', '`id-squatter`', '`marker-stale`']) {
      const at = notes.indexOf(phrase);
      assert.notEqual(at, -1, `${phrase} is documented`);
      assert.match(notes.slice(at, at + 1400), /HAND-APPLY/, `${phrase} names its hand-apply territory`);
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

  it('the read-lane posture note covers BOTH the enable-preview and the stale delete-to-reseed recovery (council R2-minor)', () => {
    const notes = between(MODE_DOC, '**Per-item posture notes', '**Sandbox lanes');
    assert.match(notes, /- `read-lane` —/, 'the read-lane posture note exists');
    assert.match(notes, /delete-to-reseed/i, 'the note names the stale-variant reseed recovery, not only the enable preview');
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
  'the insert writes every region it plans, all or nothing',
  'a `communication-absent` skip beside a declined `story-sessions-section` gets its own ask',
  'A no records nothing',
  'A DECLINE is asked apart from later',
  'runs `node ${CLAUDE_SKILL_DIR}/tools/tier-preview.mjs --decline --cwd <project-root>` only when the user refuses EVERY item the tier preview then reports offered',
  'a declined item leaves the screen until a lineage step changes the profile',
  'An undecidable entry is a stated skip naming its reason',
  "a prior → the upgrade's `lens` reconcile; an absent region → the insert; a customized region → a hand edit only",
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
    assert.doesNotMatch(note, /<kit>/, 'a kit path is written in the ${CLAUDE_SKILL_DIR} form');
  });
});

describe('recommendations contract — the full-flow-profile capability (spec:gap-screen/S10)', () => {
  it('upgrade.md declares it beside its two declarations and changes no other byte', () => {
    const declarations = [...UPGRADE_DOC.matchAll(/^<!-- opt-in-capability: ([a-z-]+) -->$/gmu)].map((match) => match[1]);
    assert.deepEqual(declarations, ['family-freshness', 'spec-adoption', 'full-flow-profile']);
    const prior = UPGRADE_DOC.replace('<!-- opt-in-capability: full-flow-profile -->\n', '');
    assert.deepEqual([Buffer.byteLength(prior), createHash('sha256').update(prior).digest('hex')], [39574, '605b2ccfd7fb41646c33b082f0052aac95113303bed9798ae7a6221d41aff36e'], 'the bytes after spec init-project revision 3 (the consent-route pointer)');
  });
  it('the registry row names mode upgrade and advisor key profile-gap', () => {
    assert.deepEqual(OPT_IN_CAPABILITIES.filter(({ id }) => id === 'full-flow-profile'), [{ id: 'full-flow-profile', mode: 'upgrade', advisorKey: 'profile-gap' }]);
  });
});

const JEV_NOTE_START = '- `jev-connect` — ';
const JEV_SKILL_NOTE_START = '- `jev-skill` — ';
const JEV_SKILL_NOTE_LITERALS = Object.freeze([
  'HAND-APPLY', 'chat yes', 'after the check', 'third-party text', 'pinned', 'verified copy',
  'never updated silently', 'foreign', 'left untouched', 'BEFORE the confirmation', 'jevSkillAck', 'docs/ai/acks.json',
]);
const JEV_NOTE_LITERALS = Object.freeze([
  'HAND-APPLY', "user's own step", 'not consent', 'no echo', 'api.typesafe.ai', "only on the user's own run",
  'plain text', 'typesafe-api-key.fish', 'user environment variable', 'enterprise', 'BEFORE the confirmation', 'jevConnectAck', 'docs/ai/acks.json',
]);
const PROBE_ORDER = Object.freeze(['probeVelocityItems', 'probeAutonomyItems', 'probeSandboxProvision', 'probeReviewRecipe', 'probeGates', 'probeGatesInert', 'probeSourceSize',
  'probeCommitGuard', 'probeEnforcement', 'probeReadLane', 'probeStateBlockHook', 'probeCheapAgents', 'probeExecutorVehicle', 'probeFamilyFreshness', 'probeAdrStore',
  'probeMasksItem', 'probeWorktreesDir', 'probeMcpChannel', 'probeSpecAdoption', 'probeProfileGaps']);

describe('spec:jev-guide/S19 — the jev-connect user step and jev-skill checked apply', () => {
  const notes = between(MODE_DOC, '**Per-item posture notes', '**Sandbox lanes');
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
    assert.match(note, ENFORCEMENT_RISK_PROFILE_END);
    assert.match(between(MODE_DOC, 'The **read-only deployment advisor**', '**Live host/session facts'), /Jev not connected on this host, the Jev skill not installed for every agent/);
  });
  it('the jev-skill note occurs once, carries every literal and closes on its risk profile', () => {
    assert.equal(notes.split(JEV_SKILL_NOTE_START).length - 1, 1, 'exactly one jev-skill bullet');
    const note = notes.slice(notes.indexOf(JEV_SKILL_NOTE_START)).split(POSTURE_NOTE_BOUNDARY)[0];
    for (const literal of JEV_SKILL_NOTE_LITERALS) {
      assert.ok(note.includes(literal), `the jev-skill note states: ${literal}`);
    }
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
  'gate-hook', 'read-lane.missing', 'mcp-channel', 'mcp-channel.differing',
  'agents', 'executor-vehicle', 'sandbox-provision.installable', 'jev-skill',
  'jev-skill.earlier', 'jev-connect', 'family-freshness',
]);
const KEPT_NO_WRITER_APPLY_LITERALS = Object.freeze([
  'HAND-APPLY: add a Stop hook running',
  'HAND-APPLY: mkdir -p {root}/scripts',
  'HAND-APPLY: rm ',
]);
const HARNESS_POSTURE_KEYS = Object.freeze(['bridge-tier', 'gate-hook', 'mcp-channel', 'jev-skill']);
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
  'check:', "user's yes on that result", 'apply:', "that result's digest", 'in the sandbox first',
  'a check that refuses', 'unapplied and pending', 'a changed digest', 'asks a new yes',
  'a write the os refuses on a protected file', 'mcp masked report', 'masked:',
  'once more outside the sandbox', 'point of action', "apply's own environment", 'never another line', 'never unseen',
  'after a `masked:` check', 'yes is taken on the outside result', 'a no, a harness refusal and any other failure',
  'leave the item pending with its output shown', 'a chat item is never retried outside the sandbox',
  'every failure of a chat step is a stop', "user's own step", 'hand-apply', 'whatever its lane', 'handed over as worded',
]);
const UNMEASURED_HOSTS = Object.freeze(['Codex', 'Devin', 'agy', 'macOS']);

describe('spec:init-project/S6 — apply slots and posture notes permit the checked consent route', () => {
  it('harness and user slots carry no HAND-APPLY, inability or retired line; no-writer text stays', () => {
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
    for (const literal of KEPT_NO_WRITER_APPLY_LITERALS) {
      assert.ok(TOOL_SOURCE.includes(literal), `the other form (c) items keep: ${literal}`);
    }
  });

  it('the lane paragraph and every posture note drop inability sentences; harness notes name the chat yes after the check and optional init', () => {
    const notes = between(MODE_DOC, '**Per-item posture notes', '**Sandbox lanes');
    const lane = between(MODE_DOC, '3. **The apply-through-agent lane', '**Per-item posture notes');
    assert.doesNotMatch(lane, INABILITY_TOKEN, 'the lane paragraph');
    assert.doesNotMatch(notes, INABILITY_TOKEN, 'all notes, including gates-inert and adr-store-migration');
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
  it('recommendations.md states the checked yes, digest, refusals, one visible retry and user-step handoff', () => {
    const doc = MODE_DOC.replace(/\s+/gu, ' ').toLowerCase();
    for (const literal of CONSENT_ROUTE_LITERALS) {
      assert.ok(doc.includes(literal), `recommendations.md states: ${literal}`);
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
      if (text !== MCP_DOC) assert.match(text, /a user item, and any item marked HAND-APPLY, stays your own step/);
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
        if (/worktrees/iu.test(sentence) && !/codex|agy|antigravity|bridge/iu.test(sentence)) return [];
        const phrases = S21_PHRASES.filter((phrase) => normalized.includes(phrase));
        const keys = S21_KEYS.filter((key) => normalized.includes(key.toLowerCase()));
        return phrases.flatMap((phrase) => keys.map((key) => `${path}:${first}-${last}: ${phrase} + ${key}`));
      }),
    ]);
    for (const path of ['gates', 'state-block-guard', 'core-evidence', 'upgrade']) {
      assert.match(read(`references/modes/${path}.md`), /paste-ready/iu, path);
    }
    for (const command of ['mcp', 'state-block-guard']) {
      const row = README.split('\n').find((line) => line.includes(`\`/agent-workflow-kit ${command}\``));
      assert.ok(row, `README row: ${command}`);
      assert.match(row, /paste-ready/iu, command);
    }
    assert.match(MODE_DOC, /HAND-APPLY/u);
    assert.match(MODE_DOC, /--lane worktrees-dir/u);
    assert.deepEqual(hits, [], `shipped bridge advice hits:\n${hits.join('\n')}`);
    assert.doesNotMatch(VELOCITY_DOC, /opt-in-capability: sandbox-lane/iu);
  });
});
