import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTONOMY_REL,
  fail,
  loadAutonomy,
  validateAutonomy,
  parseAutonomyOp,
  assertAutonomySlot,
  assertAutonomyAssignment,
  assignmentValid,
  slotValid,
  applyAutonomyOps,
  serializeAutonomy,
  resolveAutonomy,
  REDLINE_KEYS,
  REDLINE_VALUES,
  REDLINE_DEFAULTS,
  AUTONOMY_LEVELS,
  DEFAULT_ACTIVITY_AUTONOMY,
  AUTONOMY_README,
  SEED_AUTONOMY,
} from './autonomy-config.mjs';

// The Decision-5 fixture, copied verbatim — the executable form of the plan's schema fixture.
const FIXTURE = {
  _README: AUTONOMY_README,
  redlines: {
    commit: 'ask', push: 'ask', publish: 'ask',
    network: 'deny', credentials: 'deny', fs_outside_repo: 'deny',
  },
  'plan-authoring': { autonomy: 'sandbox' },
  'plan-execution': { autonomy: 'sandbox' },
};

// ── loadAutonomy / validateAutonomy — the strict-JSON reader ──
describe('autonomy-config — loadAutonomy + validateAutonomy', () => {
  let cwd;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'autonomy-cfg-'));
    mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));
  const write = (json) => writeFileSync(join(cwd, AUTONOMY_REL), json);

  it('accepts the Decision-5 fixture verbatim', () => {
    assert.deepEqual(validateAutonomy(structuredClone(FIXTURE)), FIXTURE);
    write(JSON.stringify(FIXTURE));
    const { config, source } = loadAutonomy(cwd);
    assert.equal(source, AUTONOMY_REL);
    assert.deepEqual(config, FIXTURE);
  });

  it('SEED_AUTONOMY equals the fixture and validates', () => {
    assert.deepEqual(SEED_AUTONOMY, FIXTURE);
    assert.doesNotThrow(() => validateAutonomy(SEED_AUTONOMY));
  });

  it('absent config → { config: null, source: "none" } (computed defaults)', () => {
    assert.deepEqual(loadAutonomy(cwd), { config: null, source: 'none' });
  });

  it('accepts {}, { "_README": "x" }, and a sparse policy', () => {
    assert.deepEqual(validateAutonomy({}), {});
    assert.deepEqual(validateAutonomy({ _README: 'x' }), { _README: 'x' });
    assert.deepEqual(validateAutonomy({ redlines: { network: 'ask' } }), { redlines: { network: 'ask' } });
    assert.deepEqual(validateAutonomy({ 'plan-execution': { autonomy: 'prompt' } }), { 'plan-execution': { autonomy: 'prompt' } });
  });

  it('rejects an unknown top-level key (exit 1, loud path: reason)', () => {
    assert.throws(() => validateAutonomy({ redlinez: {} }), (e) => e.exitCode === 1 && /unknown top-level key "redlinez"/.test(e.message) && e.message.startsWith(AUTONOMY_REL));
  });

  it('rejects an unknown red-line key (exit 1)', () => {
    assert.throws(() => validateAutonomy({ redlines: { deploy: 'ask' } }), (e) => e.exitCode === 1 && /unknown red-line "deploy"/.test(e.message));
  });

  it('rejects a bad red-line value / bad autonomy enum (exit 1)', () => {
    assert.throws(() => validateAutonomy({ redlines: { commit: 'maybe' } }), (e) => e.exitCode === 1 && /invalid value "maybe" for redlines\.commit/.test(e.message));
    assert.throws(() => validateAutonomy({ 'plan-execution': { autonomy: 'yolo' } }), (e) => e.exitCode === 1 && /invalid value "yolo" for plan-execution\.autonomy/.test(e.message));
  });

  it('rejects an unknown activity / an unknown activity key (exit 1)', () => {
    assert.throws(() => validateAutonomy({ 'plan-foo': { autonomy: 'sandbox' } }), (e) => e.exitCode === 1 && /unknown top-level key "plan-foo"/.test(e.message));
    assert.throws(() => validateAutonomy({ 'plan-execution': { execute: 'sandbox' } }), (e) => e.exitCode === 1 && /unknown key "execute" for activity "plan-execution"/.test(e.message));
  });

  it('rejects non-object shapes (root, redlines, an activity) (exit 1)', () => {
    for (const bad of [null, [], 'x', 42]) {
      assert.throws(() => validateAutonomy(bad), (e) => e.exitCode === 1 && /must be a JSON object/.test(e.message));
    }
    assert.throws(() => validateAutonomy({ redlines: 'x' }), (e) => e.exitCode === 1 && /"redlines" must be a JSON object/.test(e.message));
    assert.throws(() => validateAutonomy({ redlines: ['commit'] }), (e) => e.exitCode === 1 && /"redlines" must be a JSON object/.test(e.message));
    assert.throws(() => validateAutonomy({ 'plan-authoring': 'sandbox' }), (e) => e.exitCode === 1 && /activity "plan-authoring" must be a JSON object/.test(e.message));
    assert.throws(() => validateAutonomy({ _README: 42 }), (e) => e.exitCode === 1 && /"_README" must be a string/.test(e.message));
  });

  it('malformed JSON → fail(1) with a malformed-JSON message', () => {
    write('{ not json');
    assert.throws(() => loadAutonomy(cwd), (e) => e.exitCode === 1 && /malformed JSON/.test(e.message));
  });

  it('a dangling symlink at the policy path is unreadable (fail(1)), not silently absent', () => {
    symlinkSync(join(cwd, 'nowhere.json'), join(cwd, AUTONOMY_REL));
    assert.throws(() => loadAutonomy(cwd), (e) => e.exitCode === 1 && /unreadable/.test(e.message));
  });

  it('fail() tags an exitCode', () => {
    const e = fail(2, 'boom');
    assert.equal(e.exitCode, 2);
    assert.equal(e.message, 'boom');
  });
});

// ── parseAutonomyOp ≡ validateAutonomy accept/reject (the ONE shared grammar) ──
describe('autonomy-config — parseAutonomyOp (typed, fully-qualified) + shared validity', () => {
  it('parses a valid --set into a typed record', () => {
    assert.deepEqual(parseAutonomyOp('set', 'redlines.commit=ask'), { kind: 'set', section: 'redlines', key: 'commit', value: 'ask' });
    assert.deepEqual(parseAutonomyOp('set', 'plan-execution.autonomy=sandbox'), { kind: 'set', section: 'plan-execution', key: 'autonomy', value: 'sandbox' });
    assert.deepEqual(parseAutonomyOp('set', 'redlines.fs_outside_repo=deny'), { kind: 'set', section: 'redlines', key: 'fs_outside_repo', value: 'deny' });
  });

  it('parses a valid --unset into a typed record', () => {
    assert.deepEqual(parseAutonomyOp('unset', 'redlines.network'), { kind: 'unset', section: 'redlines', key: 'network' });
    assert.deepEqual(parseAutonomyOp('unset', 'plan-authoring.autonomy'), { kind: 'unset', section: 'plan-authoring', key: 'autonomy' });
  });

  it('rejects a BARE key (no section) — name the section (exit 2)', () => {
    assert.throws(() => parseAutonomyOp('set', 'commit=ask'), (e) => e.exitCode === 2 && /name the section/.test(e.message));
  });

  it('rejects unknown section / unknown key / bad value (exit 2)', () => {
    assert.throws(() => parseAutonomyOp('set', 'bogus.commit=ask'), (e) => e.exitCode === 2 && /unknown section "bogus"/.test(e.message));
    assert.throws(() => parseAutonomyOp('set', 'redlines.deploy=ask'), (e) => e.exitCode === 2 && /unknown red-line "deploy"/.test(e.message));
    assert.throws(() => parseAutonomyOp('set', 'plan-execution.execute=sandbox'), (e) => e.exitCode === 2 && /unknown key "execute" for activity "plan-execution"/.test(e.message));
    assert.throws(() => parseAutonomyOp('set', 'redlines.commit=maybe'), (e) => e.exitCode === 2 && /invalid value "maybe" for redlines\.commit/.test(e.message));
    assert.throws(() => parseAutonomyOp('set', 'plan-execution.autonomy=yolo'), (e) => e.exitCode === 2 && /invalid value "yolo"/.test(e.message));
  });

  it('rejects a --set with no value, and a --unset with a stray value (exit 2)', () => {
    assert.throws(() => parseAutonomyOp('set', 'redlines.commit='), (e) => e.exitCode === 2);
    assert.throws(() => parseAutonomyOp('set', 'redlines.commit'), (e) => e.exitCode === 2);
    assert.throws(() => parseAutonomyOp('unset', 'redlines.commit=ask'), (e) => e.exitCode === 2 && /without a value/.test(e.message));
  });

  // Drift table — parseAutonomyOp('set'), validateAutonomy, and assignmentValid MUST agree on
  // accept/reject for every (section, key, value): all route through the one shared grammar. This is
  // the "one table, drift-impossible" pin (the orchestration recipeValidForSlot precedent).
  it('parseAutonomyOp(set) ≡ validateAutonomy ≡ assignmentValid over the full matrix', () => {
    const sections = ['redlines', 'plan-authoring', 'plan-execution', 'bogus'];
    const keys = ['commit', 'push', 'network', 'credentials', 'fs_outside_repo', 'autonomy', 'execute', 'bogus'];
    const values = ['ask', 'deny', 'sandbox', 'prompt', 'nope'];
    for (const s of sections) {
      for (const k of keys) {
        for (const v of values) {
          const pred = assignmentValid(s, k, v);
          let opOk = true;
          try { parseAutonomyOp('set', `${s}.${k}=${v}`); } catch { opOk = false; }
          let cfgOk = true;
          try { validateAutonomy({ [s]: { [k]: v } }); } catch { cfgOk = false; }
          assert.equal(opOk, pred, `parseAutonomyOp(${s}.${k}=${v}) should be ${pred}`);
          assert.equal(cfgOk, pred, `validateAutonomy(${s}.${k}=${v}) should be ${pred}`);
        }
      }
    }
  });

  it('slotValid / assertAutonomySlot / assertAutonomyAssignment are the shared table (exit code parameterized)', () => {
    assert.equal(slotValid('redlines', 'commit'), true);
    assert.equal(slotValid('redlines', 'autonomy'), false);
    assert.equal(slotValid('plan-execution', 'autonomy'), true);
    assert.equal(assertAutonomySlot('redlines', 'commit'), 'redline');
    assert.equal(assertAutonomySlot('plan-execution', 'autonomy'), 'activity');
    assert.throws(() => assertAutonomyAssignment('redlines', 'commit', 'maybe', 1), (e) => e.exitCode === 1);
    assert.doesNotThrow(() => assertAutonomyAssignment('redlines', 'commit', 'deny'));
  });
});

// ── resolveAutonomy — sparse → effective policy (computed defaults) ──
describe('autonomy-config — resolveAutonomy (computed defaults)', () => {
  it('absent (null) config → every red-line at its Decision-4 default, every activity at prompt', () => {
    const r = resolveAutonomy(null);
    assert.deepEqual(r.redlines, REDLINE_DEFAULTS);
    for (const a of ['plan-authoring', 'plan-execution']) assert.equal(r.activities[a].autonomy, DEFAULT_ACTIVITY_AUTONOMY);
    // The command red-lines default to ask; the non-command red-lines default to deny (Decision 4).
    assert.equal(r.redlines.commit, 'ask');
    assert.equal(r.redlines.network, 'deny');
    assert.equal(r.redlines.credentials, 'deny');
    assert.equal(r.redlines.fs_outside_repo, 'deny');
  });

  it('a sparse config overrides only what it names; the rest fall to defaults', () => {
    const r = resolveAutonomy({ redlines: { network: 'ask', commit: 'deny' }, 'plan-execution': { autonomy: 'sandbox' } });
    assert.equal(r.redlines.network, 'ask');
    assert.equal(r.redlines.commit, 'deny');
    assert.equal(r.redlines.push, 'ask', 'unnamed command red-line falls to its default');
    assert.equal(r.redlines.credentials, 'deny', 'unnamed non-command red-line falls to its default');
    assert.equal(r.activities['plan-execution'].autonomy, 'sandbox');
    assert.equal(r.activities['plan-authoring'].autonomy, 'prompt', 'unnamed activity floors at prompt');
  });

  it('resolves the Decision-5 fixture to itself (defaults for red-lines match, activities sandbox)', () => {
    const r = resolveAutonomy(SEED_AUTONOMY);
    assert.deepEqual(r.redlines, REDLINE_DEFAULTS);
    assert.equal(r.activities['plan-authoring'].autonomy, 'sandbox');
    assert.equal(r.activities['plan-execution'].autonomy, 'sandbox');
  });

  it('every resolved key is defined (no undefined leaks through a sparse policy)', () => {
    const r = resolveAutonomy({});
    for (const k of REDLINE_KEYS) assert.ok(REDLINE_VALUES.includes(r.redlines[k]), `${k} resolved to a valid value`);
    for (const a of Object.keys(r.activities)) assert.ok(AUTONOMY_LEVELS.includes(r.activities[a].autonomy));
  });
});

// ── applyAutonomyOps — pure merge, preserve, sparse, seed-on-change ──
describe('autonomy-config — applyAutonomyOps (pure merge)', () => {
  it('sets a key, preserving _README + untouched sections/keys', () => {
    const current = { _README: 'keep me', redlines: { commit: 'ask', push: 'ask' }, 'plan-execution': { autonomy: 'prompt' } };
    const out = applyAutonomyOps(current, [parseAutonomyOp('set', 'redlines.push=deny')]);
    assert.equal(out._README, 'keep me');
    assert.equal(out.redlines.commit, 'ask', 'untouched key preserved');
    assert.equal(out.redlines.push, 'deny');
    assert.equal(out['plan-execution'].autonomy, 'prompt', 'untouched section preserved');
  });

  it('is pure — never mutates the input', () => {
    const current = { redlines: { commit: 'ask' } };
    const snapshot = JSON.stringify(current);
    applyAutonomyOps(current, [parseAutonomyOp('set', 'redlines.commit=deny')]);
    assert.equal(JSON.stringify(current), snapshot, 'input policy unchanged');
  });

  it('empty {} base + a real change + seedReadme → key added AND _README seeded', () => {
    const out = applyAutonomyOps({}, [parseAutonomyOp('set', 'plan-execution.autonomy=sandbox')], { seedReadme: AUTONOMY_README });
    assert.equal(out._README, AUTONOMY_README);
    assert.equal(out['plan-execution'].autonomy, 'sandbox');
  });

  it('absent (null) base behaves like {}', () => {
    const out = applyAutonomyOps(null, [parseAutonomyOp('set', 'redlines.network=ask')], { seedReadme: AUTONOMY_README });
    assert.equal(out.redlines.network, 'ask');
    assert.equal(out._README, AUTONOMY_README);
  });

  it('preserves a CUSTOM _README on a touched merge (never reseeds it)', () => {
    const out = applyAutonomyOps({ _README: 'my note', redlines: { commit: 'ask' } }, [parseAutonomyOp('set', 'redlines.commit=deny')], { seedReadme: AUTONOMY_README });
    assert.equal(out._README, 'my note');
  });

  it('overwrites an existing value', () => {
    const out = applyAutonomyOps({ 'plan-execution': { autonomy: 'prompt' } }, [parseAutonomyOp('set', 'plan-execution.autonomy=sandbox')]);
    assert.equal(out['plan-execution'].autonomy, 'sandbox');
  });

  it('a no-op set (value already equals) does NOT seed _README (change-gated)', () => {
    const out = applyAutonomyOps({ redlines: { commit: 'ask' } }, [parseAutonomyOp('set', 'redlines.commit=ask')], { seedReadme: AUTONOMY_README });
    assert.equal(out._README, undefined, 'no change → no spurious _README seed');
    assert.deepEqual(out, { redlines: { commit: 'ask' } });
  });

  it('unset removes a key; an emptied section is dropped (sparse)', () => {
    const out = applyAutonomyOps({ redlines: { commit: 'ask' }, 'plan-execution': { autonomy: 'sandbox' } }, [parseAutonomyOp('unset', 'redlines.commit')]);
    assert.equal(out.redlines, undefined, 'emptied section dropped');
    assert.equal(out['plan-execution'].autonomy, 'sandbox');
  });

  it('unset of an absent key is a no-op (no seed, nothing added)', () => {
    const out = applyAutonomyOps({}, [parseAutonomyOp('unset', 'redlines.commit')], { seedReadme: AUTONOMY_README });
    assert.deepEqual(out, {});
  });

  it('re-validates the merged result (loud on an invalid hand-built op slipping through)', () => {
    assert.throws(() => applyAutonomyOps({}, [{ kind: 'set', section: 'redlines', key: 'commit', value: 'maybe' }]), (e) => e.exitCode === 1);
  });
});

// ── serializeAutonomy — canonical 2-space, _README first, round-trip ──
describe('autonomy-config — serializeAutonomy', () => {
  it('emits _README first, 2-space, trailing newline', () => {
    const out = serializeAutonomy({ redlines: { commit: 'ask' }, _README: 'note' });
    assert.ok(out.startsWith('{\n  "_README": "note",'), '_README sorted first');
    assert.ok(out.endsWith('}\n'), 'trailing newline');
    assert.equal(out, JSON.stringify({ _README: 'note', redlines: { commit: 'ask' } }, null, 2) + '\n');
  });

  it('round-trips the fixture: parse(serialize(x)) deep-equals x, _README first', () => {
    const out = serializeAutonomy(FIXTURE);
    assert.ok(out.startsWith('{\n  "_README":'), '_README serialized first');
    assert.deepEqual(JSON.parse(out), FIXTURE);
  });

  it('serializeAutonomy(SEED_AUTONOMY) parses back to a valid policy', () => {
    const body = serializeAutonomy(SEED_AUTONOMY);
    assert.deepEqual(JSON.parse(body), SEED_AUTONOMY);
    assert.doesNotThrow(() => validateAutonomy(JSON.parse(body)));
  });
});
