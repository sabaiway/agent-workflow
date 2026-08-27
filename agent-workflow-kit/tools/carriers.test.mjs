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
} from './carriers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

const CODEX = 'codex-cli-bridge';
const AGY = 'antigravity-cli-bridge';
const survey = (state, reason = null) => ({ state, reason, rel: '.claude/agents/executor.md' });

describe('carriers — the one activity/slot table (spec:carriers/S1)', () => {
  it('names three activities, each with its typed slots', () => {
    assert.deepEqual(Object.keys(ACTIVITIES), ['plan-authoring', 'plan-execution', 'routine']);
    assert.deepEqual(ACTIVITIES['plan-authoring'].slots, { author: 'carrier', review: 'review' });
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
