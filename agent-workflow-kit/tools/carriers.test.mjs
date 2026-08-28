import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTIVITIES,
  POLICY_ACTIVITIES,
  SLOT_RECIPES,
  SWITCH_SLOT,
  SWITCH_DEFAULT,
  isSwitchSlot,
  SUBAGENT_RECIPE,
  CARRY_ROLE,
  EXECUTOR_PROVIDER,
  withVehicle,
  EXECUTOR_APPLY,
  vehicleDegradeReason,
  SLICE_BY_SLOT,
  DISPATCH_LINES,
  PARALLEL_LINES,
  PARALLEL_SOLO_NOTE,
  SUBAGENT_SLOT_TYPES,
  dispatchForm,
  parallelLine,
} from './carriers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

const CODEX = 'codex-cli-bridge';
const AGY = 'antigravity-cli-bridge';
const survey = (state, reason = null) => ({ state, reason, rel: '.claude/agents/executor.md' });

describe('carriers — the one activity/slot table (spec:carriers/S1) (spec:plan-review-loop/S14)', () => {
  it('names three activities, each with its typed slots', () => {
    assert.deepEqual(Object.keys(ACTIVITIES), ['plan-authoring', 'plan-execution', 'routine']);
    assert.deepEqual(ACTIVITIES['plan-authoring'].slots, { author: 'carrier', fold: 'carrier', review: 'review' });
    assert.deepEqual(ACTIVITIES['plan-execution'].slots, { execute: 'execute', review: 'review' });
    assert.deepEqual(ACTIVITIES.routine.slots, { carrier: 'carrier', parallel: 'switch' });
  });

  it('names the value set of every slot type', () => {
    assert.deepEqual(SLOT_RECIPES, {
      review: ['solo', 'reviewed', 'council'],
      execute: ['solo', 'delegated', 'subagent'],
      carrier: ['solo', 'subagent'],
      switch: ['on', 'off'],
    });
  });

  it('every slot type a slot declares has a value list, and no list is orphaned', () => {
    const used = new Set(Object.values(ACTIVITIES).flatMap((def) => Object.values(def.slots)));
    for (const slotType of used) assert.ok(Array.isArray(SLOT_RECIPES[slotType]), `slot type "${slotType}" has a value list`);
    assert.deepEqual([...used].sort(), Object.keys(SLOT_RECIPES).sort());
  });
});

describe('carriers — the switch slot is a flag, not a recipe', () => {
  it('SWITCH_SLOT is a declared slot type and SWITCH_DEFAULT is one of its values', () => {
    assert.equal(SWITCH_SLOT, 'switch');
    assert.equal(SWITCH_DEFAULT, 'on');
    assert.ok(SLOT_RECIPES[SWITCH_SLOT].includes(SWITCH_DEFAULT));
  });

  it('isSwitchSlot is true for the switch type and false for every other declared type', () => {
    for (const slotType of Object.keys(SLOT_RECIPES)) {
      assert.equal(isSwitchSlot(slotType), slotType === SWITCH_SLOT, `isSwitchSlot("${slotType}")`);
    }
    assert.equal(isSwitchSlot(undefined), false);
  });
});

describe('carriers — the subagent recipe descriptor', () => {
  it('is the carry-role recipe that needs one provider and degrades to solo', () => {
    assert.equal(SUBAGENT_RECIPE.id, 'subagent');
    assert.equal(SUBAGENT_RECIPE.title, 'Subagent');
    assert.equal(SUBAGENT_RECIPE.role, CARRY_ROLE);
    assert.equal(CARRY_ROLE, 'carry');
    assert.equal(SUBAGENT_RECIPE.minBackends, 1);
    assert.equal(SUBAGENT_RECIPE.degradesTo, 'solo');
  });

  it('its summary names the vehicle, the bounded slice and who commits', () => {
    const summary = SUBAGENT_RECIPE.summary;
    for (const fragment of ['executor vehicle', 'bounded', 'file-disjoint', 'orchestrator verifies']) {
      assert.ok(summary.includes(fragment), `summary names "${fragment}"`);
    }
  });

  it('subagent is a value of both carrier-typed and execute-typed slots, and of no review slot', () => {
    assert.ok(SLOT_RECIPES.carrier.includes(SUBAGENT_RECIPE.id));
    assert.ok(SLOT_RECIPES.execute.includes(SUBAGENT_RECIPE.id));
    assert.ok(!SLOT_RECIPES.review.includes(SUBAGENT_RECIPE.id), 'a subagent is never a review backend');
  });
});

describe('withVehicle — the executor joins readiness as the one carry provider', () => {
  const readiness = [
    { name: CODEX, readiness: 'ready' },
    { name: AGY, readiness: 'needs-skill' },
  ];

  it('EXECUTOR_PROVIDER is the appended entry name', () => {
    assert.equal(EXECUTOR_PROVIDER, 'executor');
    const out = withVehicle(readiness, survey('placed'));
    assert.equal(out.at(-1).name, EXECUTOR_PROVIDER);
  });

  it('a placed or customized vehicle is ready', () => {
    for (const state of ['placed', 'customized']) {
      assert.equal(withVehicle(readiness, survey(state)).at(-1).readiness, 'ready', state);
    }
  });

  it('an unusable, missing or absent survey is missing', () => {
    assert.equal(withVehicle(readiness, survey('unusable', 'a symlink')).at(-1).readiness, 'missing');
    assert.equal(withVehicle(readiness, survey('missing')).at(-1).readiness, 'missing');
    assert.equal(withVehicle(readiness).at(-1).readiness, 'missing');
    assert.equal(withVehicle().at(-1).readiness, 'missing');
  });

  it('carries the survey through so a render can name the state', () => {
    const s = survey('unusable', 'tools: Read is read-only');
    assert.deepEqual(withVehicle(readiness, s).at(-1).vehicle, s);
  });

  it('preserves every non-executor entry, in order', () => {
    const out = withVehicle(readiness, survey('placed'));
    assert.deepEqual(out.slice(0, -1), readiness);
    assert.equal(out.length, readiness.length + 1);
  });

  it('replaces an existing executor entry rather than appending a second one', () => {
    const already = withVehicle(readiness, survey('missing'));
    const again = withVehicle(already, survey('placed'));
    assert.equal(again.filter((b) => b.name === EXECUTOR_PROVIDER).length, 1);
    assert.equal(again.at(-1).readiness, 'ready');
  });

  it('never mutates its inputs', () => {
    const input = structuredClone(readiness);
    const s = survey('placed');
    const snapshot = JSON.stringify({ input, s });
    withVehicle(input, s);
    assert.equal(JSON.stringify({ input, s }), snapshot);
  });
});

describe('the vehicle degrade wording', () => {
  const hint = EXECUTOR_APPLY;

  it('EXECUTOR_APPLY is the agents writer command, and the default hint', () => {
    assert.equal(hint, '/agent-workflow-kit agents');
    assert.equal(vehicleDegradeReason(survey('missing')), vehicleDegradeReason(survey('missing'), hint));
  });

  it('names the state and the apply command', () => {
    const reason = vehicleDegradeReason(survey('missing'), hint);
    assert.match(reason, /missing/);
    assert.ok(reason.includes(hint), 'the apply command is quoted whole');
  });

  it('a missing vehicle is placed; an unusable one is fixed or removed FIRST — the remedy follows the state', () => {
    assert.match(vehicleDegradeReason(survey('missing'), hint), /is missing — place it with: \/agent-workflow-kit agents$/u);
    const unusable = vehicleDegradeReason(survey('unusable', 'a symlink'), hint);
    assert.match(unusable, /is unusable \(a symlink\) — fix or remove \.claude\/agents\/executor\.md, then place it with: \/agent-workflow-kit agents$/u);
    assert.match(vehicleDegradeReason({ state: 'unusable', reason: null }, hint), /fix or remove \.claude\/agents\/executor\.md/u, 'the default path when the survey carries none');
  });

  it('names the survey reason when the survey carries one, and omits the clause when it does not', () => {
    assert.match(vehicleDegradeReason(survey('unusable', 'a symlink'), hint), /unusable \(a symlink\)/);
    assert.ok(!vehicleDegradeReason(survey('missing'), hint).includes('('), 'no empty reason clause');
  });

  it('a survey reason is collapsed to one safe line: no line break, no escape sequence, no control byte', () => {
    const reason = vehicleDegradeReason(survey('unusable', 'first\nsecond \x1b[31mred\x1b[0m\ttab\u2028ls'), hint);
    assert.ok(!/[\n\r\t\u2028\x1b]/u.test(reason), reason);
    assert.match(reason, /unusable \(first second red tab ls\)/u);
    assert.equal(vehicleDegradeReason(survey('unusable', '\x1b[2K  \n'), hint), vehicleDegradeReason(survey('unusable'), hint), 'an all-noise reason renders no clause');
  });

  it('an absent survey still words a missing vehicle', () => {
    assert.match(vehicleDegradeReason(undefined, hint), /missing/);
  });
});

// The activity/slot drift guard — the JS ACTIVITIES table must match the engine canon's parseable
// `Slots:` lines (the kit parses ONLY that line; the steps are rendered verbatim).
describe('engine-kit activity/slot parity — ACTIVITIES matches procedures.md `Slots:` lines', () => {
  const PROCEDURES = readFileSync(join(REPO_ROOT, 'agent-workflow-engine', 'references', 'procedures.md'), 'utf8');
  const sectionOf = (activity) => {
    const lines = PROCEDURES.split('\n');
    const start = lines.findIndex((l) => l.trim() === `## ${activity}`);
    if (start === -1) return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^## /.test(lines[i])) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end);
  };
  const slotsOf = (activity) => {
    const sec = sectionOf(activity);
    if (!sec) return null;
    const slotsLine = sec.slice(1).map((l) => l.trim()).find((l) => l.startsWith('Slots:'));
    if (!slotsLine) return null;
    return slotsLine
      .replace(/^Slots:\s*/, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  };

  for (const [activity, def] of Object.entries(ACTIVITIES)) {
    it(`${activity}: the canon's Slots line equals the JS slot set`, () => {
      assert.deepEqual(slotsOf(activity), Object.keys(def.slots), `procedures.md "## ${activity}" Slots: drifted from ACTIVITIES`);
    });
  }

  it('procedures.md declares no activity section absent from the ACTIVITIES table', () => {
    const headingIds = PROCEDURES.split('\n')
      .filter((l) => /^## /.test(l))
      .map((l) => l.replace(/^##\s+/, '').trim());
    for (const id of headingIds) assert.ok(ACTIVITIES[id], `procedures.md "## ${id}" has no ACTIVITIES entry`);
  });
});

describe('carriers — a routine chore carries no autonomy level of its own', () => {
  it('the two session activities are policy activities and routine is not', () => {
    assert.deepEqual(Object.keys(POLICY_ACTIVITIES), ['plan-authoring', 'plan-execution']);
    assert.equal(ACTIVITIES.routine.policy, false);
    for (const name of Object.keys(POLICY_ACTIVITIES)) assert.equal(ACTIVITIES[name].policy, true);
  });
});

describe('the dispatch form — the ONE wording source, pinned whole', () => {
  it('every subagent-capable activity/slot pair has one exact slice sentence', () => {
    const capableSlots = Object.entries(ACTIVITIES).flatMap(([activity, definition]) =>
      Object.entries(definition.slots)
        .filter(([, slotType]) => SLOT_RECIPES[slotType].includes(SUBAGENT_RECIPE.id))
        .map(([slot]) => `${activity}.${slot}`));
    assert.deepEqual(Object.keys(SLICE_BY_SLOT).sort(), capableSlots.sort());
    assert.equal(SLICE_BY_SLOT['plan-execution.execute'], 'a slice is a set of file-disjoint ledger rows; wording is copied verbatim where wording is a red line');
    assert.equal(SLICE_BY_SLOT['plan-authoring.author'], 'a slice is a brief naming the goal, the governing spec(s) and the ledger constraints; the subagent drafts the plan or the contract from it, and the orchestrator reviews the draft as its own');
    assert.equal(SLICE_BY_SLOT['plan-authoring.fold'], "a slice is the round's findings with their dispositions; the subagent edits the plan or the contract in place and returns; the orchestrator runs the self-consistency read itself");
    assert.equal(SLICE_BY_SLOT['routine.carrier'], "a slice is a bounded mechanical task; a read-only one (a sweep, gate triage) rides its placed read-only vehicle, or is carried solo with a stated reason when that vehicle is absent; a write-capable one (a regeneration, a fixture build) rides the executor; the changelog stays the orchestrator's");
  });

  it('the four shared dispatch lines are exact, and in this order', () => {
    assert.deepEqual(DISPATCH_LINES, [
      'dispatch: the executor vehicle (.claude/agents/executor.md — <state>), in the background',
      'the orchestrator verifies every returned slice by running its suites itself',
      'the subagent is never told to commit, never a review backend, never a bridge substitute',
      'honest limit: a Claude Code lane — on a host that cannot dispatch the vehicle, follow this form by hand and say so',
    ]);
  });

  it('SUBAGENT_SLOT_TYPES is computed from the value table — exactly the slot types that hold a subagent', () => {
    assert.deepEqual(SUBAGENT_SLOT_TYPES, ['execute', 'carrier']);
    for (const slotType of SUBAGENT_SLOT_TYPES) assert.ok(SLOT_RECIPES[slotType].includes(SUBAGENT_RECIPE.id), slotType);
  });

  it('dispatchForm fills the surveyed state into the first line and prepends the activity slice', () => {
    const form = dispatchForm({ activity: 'plan-execution', slot: 'execute', state: 'customized' });
    assert.equal(form[0], SLICE_BY_SLOT['plan-execution.execute']);
    assert.equal(form[1], 'dispatch: the executor vehicle (.claude/agents/executor.md — customized), in the background');
    assert.deepEqual(form.slice(2), DISPATCH_LINES.slice(1));
    assert.match(dispatchForm({ activity: 'routine', slot: 'carrier' })[1], / missing\), in the background$/u, 'an unstated state reads missing, never an empty parenthesis');
  });

  it('renders nothing for a slot no subagent can carry, and for an unknown activity', () => {
    assert.deepEqual(dispatchForm({ activity: 'plan-execution', slot: 'review', state: 'placed' }), []);
    assert.deepEqual(dispatchForm({ activity: 'routine', slot: 'parallel', state: 'placed' }), []);
    assert.deepEqual(dispatchForm({ activity: 'nope', slot: 'execute', state: 'placed' }), []);
    assert.deepEqual(dispatchForm(), []);
  });

  it('the four parallel x carrier cells are exact', () => {
    assert.equal(parallelLine({ value: 'on', carrier: 'subagent' }), 'parallel: on — file-disjoint slices dispatch concurrently');
    assert.equal(parallelLine({ value: 'on', carrier: 'solo' }), 'parallel: on (no effect while the carrier is solo)');
    assert.equal(parallelLine({ value: 'off', carrier: 'subagent' }), 'parallel: off — one slice at a time');
    assert.equal(parallelLine({ value: 'off', carrier: 'solo' }), 'parallel: off — one slice at a time (no effect while the carrier is solo)');
    assert.equal(PARALLEL_SOLO_NOTE, '(no effect while the carrier is solo)');
    assert.deepEqual(PARALLEL_LINES, { on: 'parallel: on — file-disjoint slices dispatch concurrently', off: 'parallel: off — one slice at a time' });
  });
});
