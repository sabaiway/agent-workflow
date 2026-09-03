import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_REL,
  fail,
  loadConfig,
  validateConfig,
  parseOp,
  assertSlotRecipe,
  recipeValidForSlot,
  applySetOps,
  serializeConfig,
  normalizeCanonical,
  refreshIfCanonical,
  refreshReadme,
  CANON_README,
  KNOWN_PRIOR_README,
  SEED_CONFIG,
  FLOW_SCHEMA_VERSION,
} from './orchestration-config.mjs';
import { ACTIVITIES, resolveActivityRecipe } from './recipes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = join(HERE, '..');

// ── loadConfig / validateConfig — the moved-verbatim reader (parity with the prior procedures.mjs) ──
describe('orchestration-config — loadConfig + validateConfig', () => {
  let cwd;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'orch-cfg-'));
    mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));
  const write = (json) => writeFileSync(join(cwd, CONFIG_REL), json);

  it('absent config → { config: null, source: "none" }', () => {
    assert.deepEqual(loadConfig(cwd), { config: null, source: 'none' });
  });

  it('a valid config returns { config, source: CONFIG_REL }', () => {
    write(JSON.stringify({ _README: 'x', 'plan-authoring': { review: 'council' } }));
    const { config, source } = loadConfig(cwd);
    assert.equal(source, CONFIG_REL);
    assert.equal(config['plan-authoring'].review, 'council');
  });

  it('accepts {} and { "_README": "x" }', () => {
    assert.deepEqual(validateConfig({}), {});
    assert.deepEqual(validateConfig({ _README: 'x' }), { _README: 'x' });
  });

  it('malformed JSON → fail(1) with a malformed-JSON message', () => {
    write('{ not json');
    assert.throws(() => loadConfig(cwd), (e) => e.exitCode === 1 && /malformed JSON/.test(e.message));
  });

  it('schema-invalid (recipe not allowed for slot) → fail(1)', () => {
    assert.throws(() => validateConfig({ 'plan-authoring': { review: 'delegated' } }), (e) => e.exitCode === 1 && /invalid value "delegated" for review slot/.test(e.message));
  });

  it('unknown activity / unknown slot / non-string _README → fail(1)', () => {
    assert.throws(() => validateConfig({ 'plan-foo': {} }), (e) => e.exitCode === 1 && /unknown activity "plan-foo"/.test(e.message));
    assert.throws(() => validateConfig({ 'plan-authoring': { execute: 'solo' } }), (e) => e.exitCode === 1 && /unknown slot "execute"/.test(e.message));
    assert.throws(() => validateConfig({ _README: 42 }), (e) => e.exitCode === 1 && /"_README" must be a string/.test(e.message));
  });

  it('a dangling symlink at the config path is unreadable (fail(1)), not silently absent', () => {
    symlinkSync(join(cwd, 'nowhere.json'), join(cwd, CONFIG_REL));
    assert.throws(() => loadConfig(cwd), (e) => e.exitCode === 1 && /unreadable/.test(e.message));
  });
});

// ── characterization: the unknown-top-level-key refusal (the lagging-kit failure shape) ──
// A kit predating a reserved top-level key sees it as an unknown activity: the config LOAD fails
// loudly, reddening every consumer that shares loadConfig. This IS a pre-flow kit's behavior.
describe('orchestration-config — unknown-top-level-key characterization (lagging-kit failure shape)', () => {
  let cwd;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'orch-lag-'));
    mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('validateConfig refuses an unknown top-level key loudly, naming the key and the known activities', () => {
    assert.throws(
      () => validateConfig({ 'not-an-activity': { schema: 1 } }),
      (e) => e.exitCode === 1 && /unknown activity "not-an-activity"/.test(e.message) && /known: /.test(e.message),
    );
  });

  it('loadConfig surfaces the refusal as a loud config-load failure — never a silent fallback to defaults', () => {
    writeFileSync(join(cwd, CONFIG_REL), JSON.stringify({ 'not-an-activity': {}, 'plan-authoring': { review: 'council' } }));
    assert.throws(() => loadConfig(cwd), (e) => e.exitCode === 1 && /unknown activity "not-an-activity"/.test(e.message));
  });
});

// ── parseOp ≡ validateConfig accept/reject (the ONE shared slot/recipe validity table) ──
describe('orchestration-config — parseOp (typed, fully-qualified) + shared validity', () => {
  it('parses a valid --set and a valid --unset into typed records', () => {
    assert.deepEqual(parseOp('set', 'plan-authoring.review=council'), { kind: 'set', activity: 'plan-authoring', slot: 'review', recipe: 'council' });
    assert.deepEqual(parseOp('set', 'plan-execution.execute=delegated'), { kind: 'set', activity: 'plan-execution', slot: 'execute', recipe: 'delegated' });
    assert.deepEqual(parseOp('unset', 'plan-execution.review'), { kind: 'unset', activity: 'plan-execution', slot: 'review' });
  });

  it('rejects a BARE recipe (no activity) — name the activity (exit 2)', () => {
    assert.throws(() => parseOp('set', 'review=council'), (e) => e.exitCode === 2 && /name the activity/.test(e.message));
  });

  it('rejects unknown activity / unknown slot / invalid value-for-slot (exit 2)', () => {
    assert.throws(() => parseOp('set', 'plan-foo.review=council'), (e) => e.exitCode === 2 && /unknown activity "plan-foo"/.test(e.message));
    assert.throws(() => parseOp('set', 'plan-authoring.execute=delegated'), (e) => e.exitCode === 2 && /unknown slot "execute"/.test(e.message));
    assert.throws(() => parseOp('set', 'plan-authoring.review=delegated'), (e) => e.exitCode === 2 && /invalid value "delegated" for review slot/.test(e.message));
  });

  it('rejects a --set with no recipe, and a --unset with a stray recipe (exit 2)', () => {
    assert.throws(() => parseOp('set', 'plan-authoring.review='), (e) => e.exitCode === 2);
    assert.throws(() => parseOp('set', 'plan-authoring.review'), (e) => e.exitCode === 2);
    assert.throws(() => parseOp('unset', 'plan-authoring.review=solo'), (e) => e.exitCode === 2 && /without a value/.test(e.message));
  });

  // parseOp('set') and validateConfig MUST agree on accept/reject for every (activity, slot, recipe).
  it('parseOp(set) accept/reject ≡ validateConfig accept/reject over the full matrix', () => {
    const activities = ['plan-authoring', 'plan-execution', 'routine', 'feedback-triage', 'plan-foo'];
    const slots = ['review', 'execute', 'author', 'carrier', 'parallel', 'bogus'];
    const recipes = ['solo', 'reviewed', 'council', 'delegated', 'subagent', 'on', 'off', 'nope'];
    for (const a of activities) {
      for (const s of slots) {
        for (const r of recipes) {
          const pred = recipeValidForSlot(a, s, r);
          let opOk = true;
          try { parseOp('set', `${a}.${s}=${r}`); } catch { opOk = false; }
          let cfgOk = true;
          try { validateConfig({ [a]: { [s]: r } }); } catch { cfgOk = false; }
          assert.equal(opOk, pred, `parseOp(${a}.${s}=${r}) should be ${pred}`);
          assert.equal(cfgOk, pred, `validateConfig(${a}.${s}=${r}) should be ${pred}`);
        }
      }
    }
  });

  it('assertSlotRecipe is the shared validator (exit code is parameterized)', () => {
    assert.doesNotThrow(() => assertSlotRecipe('plan-authoring', 'review', 'council'));
    assert.throws(() => assertSlotRecipe('plan-authoring', 'review', 'delegated', 1), (e) => e.exitCode === 1);
  });
});

// ── the four activities, their typed slots and each slot's value set (AD-124) ──
describe('orchestration-config — the carrier surface validates (spec:carriers/S3) (spec:plan-review-loop/S17)', () => {
  it('accepts every feedback review form beside the existing carrier and switch values', () => {
    for (const config of [
      { 'plan-authoring': { author: 'subagent' } },
      { 'plan-authoring': { fold: 'subagent' } },
      { 'plan-execution': { execute: 'subagent' } },
      { routine: { carrier: 'subagent' } },
      { routine: { carrier: 'subagent', parallel: 'off' } },
      ...['solo', 'reviewed', 'council', ['codex-review']].map((review) => ({ 'feedback-triage': { review } })),
    ]) {
      assert.deepEqual(validateConfig(config), config, JSON.stringify(config));
    }
  });

  it('refuses a value outside its slot, an unknown slot and an unknown activity with exit 1', () => {
    const refusal = (config, pattern) =>
      assert.throws(() => validateConfig(config), (e) => e.exitCode === 1 && pattern.test(e.message), JSON.stringify(config));
    refusal({ 'plan-authoring': { author: 'delegated' } }, /invalid value "delegated" for carrier slot of "plan-authoring" \(carrier accepts: solo, subagent\)/);
    refusal({ routine: { parallel: 'maybe' } }, /invalid value "maybe" for switch slot of "routine" \(switch accepts: on, off\)/);
    refusal({ 'plan-authoring': { review: 'subagent' } }, /invalid value "subagent" for review slot/);
    refusal({ routine: { review: 'council' } }, /unknown slot "review" for activity "routine" \(routine slots: carrier, parallel\)/);
    refusal({ 'feedback-triage': { review: 'delegated' } }, /invalid value "delegated" for review slot/);
    refusal({ chores: { carrier: 'solo' } }, /unknown activity "chores".*routine/);
  });

  it('a config with no routine or feedback-triage block and no author resolves every absent slot default', () => {
    const legacy = { 'plan-authoring': { review: 'solo' }, 'plan-execution': { execute: 'solo', review: 'solo' } };
    assert.deepEqual(validateConfig(legacy), legacy);
    const readiness = [{ name: 'executor', readiness: 'missing', vehicle: { state: 'missing', reason: null } }];
    for (const [activity, slot, expected] of [['plan-authoring', 'author', 'solo'], ['plan-authoring', 'fold', 'solo'], ['routine', 'carrier', 'solo'], ['routine', 'parallel', 'on'], ['feedback-triage', 'review', 'solo']]) {
      const r = resolveActivityRecipe({ config: legacy, readiness, activity, slot });
      assert.deepEqual([r.recipe, r.source], [expected, 'default'], `${activity}.${slot}`);
    }
  });
});

// ── applySetOps — pure merge, preserve, sparse, seed-on-change ──
describe('orchestration-config — applySetOps (pure merge)', () => {
  it('sets a slot, preserving _README + untouched slots', () => {
    const current = { _README: 'keep me', 'plan-execution': { execute: 'delegated', review: 'solo' } };
    const out = applySetOps(current, [parseOp('set', 'plan-execution.review=council')]);
    assert.equal(out._README, 'keep me');
    assert.equal(out['plan-execution'].execute, 'delegated', 'untouched slot preserved');
    assert.equal(out['plan-execution'].review, 'council');
  });

  it('is pure — never mutates the input', () => {
    const current = { 'plan-authoring': { review: 'solo' } };
    const snapshot = JSON.stringify(current);
    applySetOps(current, [parseOp('set', 'plan-authoring.review=council')]);
    assert.equal(JSON.stringify(current), snapshot, 'input config unchanged');
  });

  it('README-only base → the activity is appended, _README preserved', () => {
    const out = applySetOps({ _README: 'note' }, [parseOp('set', 'plan-authoring.review=reviewed')], { seedReadme: CANON_README });
    assert.equal(out._README, 'note', 'an existing _README is preserved, never reseeded');
    assert.equal(out['plan-authoring'].review, 'reviewed');
  });

  it('an empty or absent base + a real change + seedReadme → the activity is added AND _README seeded', () => {
    for (const base of [{}, null]) {
      const out = applySetOps(base, [parseOp('set', 'plan-authoring.review=council')], { seedReadme: CANON_README });
      assert.deepEqual(out, { _README: CANON_README, 'plan-authoring': { review: 'council' } }, JSON.stringify(base));
    }
  });

  it('overwrites an existing slot value, but a no-op set seeds no _README (change-gated)', () => {
    const overwritten = applySetOps({ 'plan-authoring': { review: 'solo' } }, [parseOp('set', 'plan-authoring.review=council')]);
    assert.equal(overwritten['plan-authoring'].review, 'council');
    const noop = applySetOps({ 'plan-authoring': { review: 'solo' } }, [parseOp('set', 'plan-authoring.review=solo')], { seedReadme: CANON_README });
    assert.deepEqual(noop, { 'plan-authoring': { review: 'solo' } }, 'no change → no spurious _README seed');
  });

  it('unset removes a slot, drops an emptied activity (sparse), and is a no-op on an absent slot', () => {
    const out = applySetOps({ 'plan-authoring': { review: 'council' }, 'plan-execution': { execute: 'delegated' } }, [parseOp('unset', 'plan-authoring.review')]);
    assert.deepEqual(out, { 'plan-execution': { execute: 'delegated' } }, 'emptied activity dropped');
    assert.deepEqual(applySetOps({}, [parseOp('unset', 'plan-authoring.review')], { seedReadme: CANON_README }), {});
  });

  it('re-validates the merged result — a hand-built op bypassing the parser is still refused', () => {
    assert.throws(() => applySetOps({}, [{ kind: 'set', activity: 'plan-authoring', slot: 'review', recipe: 'delegated' }]), (e) => e.exitCode === 1);
  });
});

// ── serializeConfig — canonical 2-space, _README first, round-trip ──
describe('orchestration-config — serializeConfig', () => {
  it('emits _README first, 2-space, trailing newline, and round-trips', () => {
    const out = serializeConfig({ 'plan-authoring': { review: 'solo' }, _README: 'note' });
    assert.equal(out, JSON.stringify({ _README: 'note', 'plan-authoring': { review: 'solo' } }, null, 2) + '\n');
    const x = { _README: 'r', 'plan-execution': { execute: 'delegated', review: 'council' } };
    assert.deepEqual(JSON.parse(serializeConfig(x)), x);
  });

  it('SEED_CONFIG keeps its two-activity shape — an older installed kit must accept the seed', () => {
    assert.deepEqual(SEED_CONFIG, {
      _README: CANON_README,
      'plan-authoring': { review: 'solo' },
      'plan-execution': { execute: 'solo', review: 'solo' },
    });
  });

  it('serializeConfig(SEED_CONFIG) is byte-identical to the shipped template (kit + memory)', () => {
    const expected = serializeConfig(SEED_CONFIG);
    for (const pkg of ['agent-workflow-kit', 'agent-workflow-memory']) {
      const tpl = readFileSync(join(KIT_ROOT, '..', pkg, 'references', 'templates', 'orchestration.json'), 'utf8');
      assert.equal(tpl, expected, `${pkg}/references/templates/orchestration.json must equal serializeConfig(SEED_CONFIG)`);
    }
  });
});

// ── normalizeCanonical / refreshIfCanonical / refreshReadme — the shared canonical-refresh ──
describe('orchestration-config — canonical refresh', () => {
  it('normalizeCanonical trims + LF-normalizes (CRLF + trailing-space variants match)', () => {
    assert.equal(normalizeCanonical('a\r\nb\r\n'), 'a\nb');
    assert.equal(normalizeCanonical('  a\nb  '), 'a\nb');
  });

  it('refreshIfCanonical replaces a known prior (incl. CRLF/whitespace noise), preserves a customization', () => {
    const prior = 'the old note';
    const next = 'the new note';
    assert.equal(refreshIfCanonical('the old note', [prior], next), next);
    assert.equal(refreshIfCanonical('the old note\r\n', [prior], next), next, 'CRLF-noisy prior still matches');
    assert.equal(refreshIfCanonical('  the old note  ', [prior], next), next, 'whitespace-noisy prior still matches');
    assert.equal(refreshIfCanonical('a CUSTOM note', [prior], next), 'a CUSTOM note', 'a customization is preserved verbatim');
  });

  it('CANON_README points at set-recipe and never says "never written for you"; the prior IS in the known set', () => {
    assert.match(CANON_README, /set-recipe/);
    assert.ok(!/never written for you/.test(CANON_README));
    assert.ok(KNOWN_PRIOR_README.some((p) => /never written for you/.test(p)), 'the v1 note is retained as a known prior');
  });

  it('CANON_README names the four activities, every slot, its values, the vehicle and the defaults', () => {
    for (const [activity, def] of Object.entries(ACTIVITIES)) {
      assert.ok(CANON_README.includes(activity), `names "${activity}"`);
      for (const slot of Object.keys(def.slots)) assert.ok(CANON_README.includes(slot), `names the "${slot}" slot`);
    }
    for (const values of ['solo | reviewed | council', 'solo | delegated | subagent', 'solo | subagent', 'on | off']) {
      assert.ok(CANON_README.includes(values), `names ${values}`);
    }
    assert.match(CANON_README, /composition root's `agents` writer places it/, 'subagent needs the placed executor vehicle');
    assert.ok(!CANON_README.includes('/agent-workflow-kit'), 'the memory twin of the seed must name no sibling skill');
    assert.match(CANON_README, /Every slot seeded below is 'solo'/u, 'the seed defaults are stated without claiming silent slots are seeded');
    assert.match(CANON_README, /'feedback-triage.review' is reviewed as soon as a review backend is ready/u, 'the silent review slot\'s default is stated honestly');
    assert.ok(CANON_README.includes("'feedback-triage' (slot review)"), 'the fourth activity is explicit');
  });

  it('the OUTGOING note joined the known-prior set, so an existing file refreshes on the next write', () => {
    const outgoing = KNOWN_PRIOR_README.find((p) => /set-recipe --unset/.test(p) && !/routine/.test(p));
    assert.ok(outgoing, 'the two-activity pre-AD-124 note is retained as a known prior');
    const refreshed = refreshReadme({ _README: outgoing, routine: { carrier: 'subagent' } });
    assert.deepEqual([refreshed.changed, refreshed.config._README], [true, CANON_README]);
    assert.deepEqual(refreshed.config.routine, { carrier: 'subagent' }, 'activities preserved');
  });

  it('the prior roster canonical refreshes, and every slot-list surface names fold', () => {
    const outgoing = KNOWN_PRIOR_README.find((value) => value.includes('review-lens') && value.includes('slots author, review'));
    assert.ok(outgoing, 'the roster canonical before fold is retained as a known prior');
    assert.equal(refreshReadme({ _README: outgoing }).config._README, CANON_README);
    for (const mode of ['set-recipe', 'procedures', 'recipes', 'status', 'agents']) {
      const text = readFileSync(join(KIT_ROOT, 'references', 'modes', `${mode}.md`), 'utf8');
      assert.match(text, /plan-authoring[^\n]*fold/u, `${mode}.md names plan-authoring.fold`);
    }
    const readme = readFileSync(join(KIT_ROOT, 'README.md'), 'utf8');
    const proceduresRow = readme.split('\n').find((line) => line.includes('/agent-workflow-kit procedures')) ?? '';
    assert.match(proceduresRow, /fold/u, 'the README procedures row names fold');
    assert.match(proceduresRow, /except `feedback-triage`[^|]*the record is the artifact/u, 'the README procedures row states the feedback-triage exception');
  });
  it('the three-activity canonical is a known prior that refreshes', () => {
    const prior = KNOWN_PRIOR_README.find((value) => value.includes('Three activities are configured') && value.includes('slots author, fold, review'));
    assert.ok(prior, 'the outgoing three-activity canonical is retained whole');
    assert.equal(refreshReadme({ _README: prior }).config._README, CANON_README);
  });

  it('the solo-for-every-slot four-activity note is a known prior that refreshes', () => {
    const prior = KNOWN_PRIOR_README.find((value) => value.includes('Four activities') && value.includes("'solo' for every recipe and carrier slot"));
    assert.ok(prior);
    const refreshed = refreshReadme({ _README: prior });
    assert.equal(refreshed.changed, true);
    assert.equal(refreshed.config._README, CANON_README);
  });

  it('refreshReadme: a prior-canonical _README is refreshed to CANON_README; a customized one is preserved', () => {
    const a = refreshReadme({ _README: KNOWN_PRIOR_README[0], 'plan-authoring': { review: 'solo' } });
    assert.equal(a.changed, true);
    assert.equal(a.config._README, CANON_README);
    assert.equal(a.config['plan-authoring'].review, 'solo', 'activities preserved');

    const b = refreshReadme({ _README: 'my own note', 'plan-authoring': { review: 'solo' } });
    assert.equal(b.changed, false);
    assert.equal(b.config._README, 'my own note');
  });

  it('refreshReadme seeds an absent _README and reports changed', () => {
    const r = refreshReadme({ 'plan-authoring': { review: 'solo' } });
    assert.equal(r.changed, true);
    assert.equal(r.config._README, CANON_README);
  });

  it('refreshReadme is idempotent on an already-current _README', () => {
    const r = refreshReadme({ _README: CANON_README, 'plan-authoring': { review: 'solo' } });
    assert.equal(r.changed, false);
  });
});

// ── FLOW-TOLERATE — the versioned, uninterpreted `flow` top-level key (tolerate-only release) ──
describe('orchestration-config — flow tolerate branch (FLOW-TOLERATE)', () => {
  let cwd;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'orch-flow-'));
    mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));
  const write = (obj) => writeFileSync(join(cwd, CONFIG_REL), JSON.stringify(obj));

  it('a flow object carrying the known numeric schema loads through the file reader (schema-1 keys only)', () => {
    const cfg = {
      flow: { schema: FLOW_SCHEMA_VERSION, councilRounds: 3, debtQueue: 'docs/debt.md' },
      'plan-authoring': { review: 'council' },
    };
    assert.deepEqual(validateConfig(cfg), cfg);
    write(cfg);
    const { config, source } = loadConfig(cwd);
    assert.equal(source, CONFIG_REL);
    assert.deepEqual(config.flow, cfg.flow);
  });

  it('the acceptance check and the refusal message share the ONE exported constant (numeric wire pin)', () => {
    assert.equal(typeof FLOW_SCHEMA_VERSION, 'number');
    assert.doesNotThrow(() => validateConfig({ flow: { schema: FLOW_SCHEMA_VERSION } }));
    assert.throws(
      () => validateConfig({ flow: { schema: FLOW_SCHEMA_VERSION + 1 } }),
      (e) => e.exitCode === 1 && /"flow"/.test(e.message) && e.message.includes(String(FLOW_SCHEMA_VERSION)),
    );
  });

  it('the STRING form of the accepted version refuses loudly, naming the key and the accepted version', () => {
    assert.throws(
      () => validateConfig({ flow: { schema: String(FLOW_SCHEMA_VERSION) } }),
      (e) => e.exitCode === 1 && /"flow"/.test(e.message) && e.message.includes(String(FLOW_SCHEMA_VERSION)),
    );
  });

  it('an absent schema refuses loudly, naming the key and the accepted version', () => {
    assert.throws(
      () => validateConfig({ flow: { records: [] } }),
      (e) => e.exitCode === 1 && /"flow"/.test(e.message) && e.message.includes(String(FLOW_SCHEMA_VERSION)),
    );
  });

  it('a non-object flow (string / array / null) refuses loudly, naming the key and the accepted version', () => {
    for (const bad of ['v1', [], null]) {
      assert.throws(
        () => validateConfig({ flow: bad }),
        (e) => e.exitCode === 1 && /"flow"/.test(e.message) && e.message.includes(String(FLOW_SCHEMA_VERSION)),
        `flow=${JSON.stringify(bad)} must refuse naming the accepted version`,
      );
    }
  });

  it('any OTHER unknown top-level key still refuses exactly as today', () => {
    assert.throws(
      () => validateConfig({ flows: { schema: FLOW_SCHEMA_VERSION } }),
      (e) => e.exitCode === 1 && /unknown activity "flows"/.test(e.message),
    );
  });

  it('loader-level consumer proof: a valid flow block changes NOTHING about recipe resolution', () => {
    const activities = { 'plan-authoring': { review: 'council' }, 'plan-execution': { execute: 'solo', review: 'reviewed' } };
    write({ flow: { schema: FLOW_SCHEMA_VERSION, councilRounds: 2 }, ...activities });
    const withFlow = loadConfig(cwd).config;
    for (const [activity, def] of Object.entries(ACTIVITIES)) {
      for (const slot of Object.keys(def.slots)) {
        assert.deepEqual(
          resolveActivityRecipe({ config: withFlow, readiness: [], activity, slot }),
          resolveActivityRecipe({ config: activities, readiness: [], activity, slot }),
          `${activity}.${slot} resolves identically with and without the flow block`,
        );
      }
    }
  });
});

// The upgrade path: refreshReadme touches ONLY `_README`; a present flow subtree rides through.
describe('orchestration-config — upgrade-path flow preservation (refreshReadme characterization)', () => {
  const FLOW = { schema: FLOW_SCHEMA_VERSION, future: { bytes: true } };

  it('absent _README: seeded + changed, flow subtree JSON-value-equal through serialization', () => {
    const r = refreshReadme({ flow: structuredClone(FLOW), 'plan-authoring': { review: 'solo' } });
    assert.equal(r.changed, true);
    assert.equal(r.config._README, CANON_README);
    assert.deepEqual(r.config.flow, FLOW);
    assert.deepEqual(JSON.parse(serializeConfig(r.config)).flow, FLOW);
  });

  it('known-prior canonical _README: refreshed, flow subtree JSON-value-equal', () => {
    const r = refreshReadme({ _README: KNOWN_PRIOR_README[0], flow: structuredClone(FLOW), 'plan-authoring': { review: 'solo' } });
    assert.equal(r.changed, true);
    assert.equal(r.config._README, CANON_README);
    assert.deepEqual(r.config.flow, FLOW);
  });

  it('customized _README: preserved verbatim, flow subtree JSON-value-equal', () => {
    const r = refreshReadme({ _README: 'my own note', flow: structuredClone(FLOW), 'plan-authoring': { review: 'solo' } });
    assert.equal(r.changed, false);
    assert.equal(r.config._README, 'my own note');
    assert.deepEqual(r.config.flow, FLOW);
  });
});

// ── Phase 2 (flow Plan 3): full STRUCTURAL schema-1 validation of the flow block (P7/P20) ──
import {
  FLOW_SCHEMA_1_KEYS, FLOW_SCHEMA_1_FIXTURE, FLOW_PRESET_VALUES, FLOW_CANDIDATE_CLASSES,
} from './orchestration-config.mjs';

describe('orchestration-config — flow structural schema-1 validation (P7/P20)', () => {
  it('the full literal fixture validates — the ONE fixture the validator and the arming path share', () => {
    assert.doesNotThrow(() => validateConfig({ flow: { ...FLOW_SCHEMA_1_FIXTURE } }));
  });

  it('drift-guard: the fixture carries EXACTLY the closed key set, a fixture preset value, and fixture candidate classes', () => {
    assert.deepEqual(Object.keys(FLOW_SCHEMA_1_FIXTURE), [...FLOW_SCHEMA_1_KEYS]);
    assert.ok(FLOW_PRESET_VALUES.includes(FLOW_SCHEMA_1_FIXTURE.preset));
    for (const c of FLOW_SCHEMA_1_FIXTURE.candidates) {
      assert.deepEqual(Object.keys(c), ['name', 'class']);
      assert.ok(FLOW_CANDIDATE_CLASSES.includes(c.class));
    }
    assert.equal(FLOW_SCHEMA_1_FIXTURE.schema, FLOW_SCHEMA_VERSION);
  });

  it('an unknown flow key refuses loudly naming the key and the closed schema-1 key set', () => {
    assert.throws(
      () => validateConfig({ flow: { schema: FLOW_SCHEMA_VERSION, records: [] } }),
      (e) => e.exitCode === 1 && /"records"/.test(e.message) && FLOW_SCHEMA_1_KEYS.every((k) => e.message.includes(k)),
    );
  });

  it('every schema-1 key refuses its malformed forms with a loud path: reason naming the key', () => {
    const bad = [
      ['preset', 'nonsense', /preset/],
      ['preset', 42, /preset/],
      ['candidates', 'codex', /candidates/],
      ['candidates', [{ name: '', class: 'review' }], /candidates/],
      ['candidates', [{ name: 'codex', class: 'judge' }], /candidates/],
      ['candidates', [{ name: 'codex', class: 'review', extra: 1 }], /candidates/],
      ['councilRounds', 0, /councilRounds/],
      ['councilRounds', '3', /councilRounds/],
      ['debtQueue', '', /debtQueue/],
      ['debtQueue', 42, /debtQueue/],
      ['convergenceSummary', null, /convergenceSummary/],
      ['debtQueueExcluded', 'yes', /debtQueueExcluded/],
      ['convergenceSummaryExcluded', 1, /convergenceSummaryExcluded/],
      ['pregateExclude', 'unit', /pregateExclude/],
      ['pregateExclude', ['a', 'a'], /pregateExclude/],
      ['pregateExclude', [''], /pregateExclude/],
      ['kitMinVersion', 5, /kitMinVersion/],
      ['kitMinVersion', '', /kitMinVersion/],
    ];
    for (const [key, value, re] of bad) {
      assert.throws(
        () => validateConfig({ flow: { schema: FLOW_SCHEMA_VERSION, [key]: value } }),
        (e) => e.exitCode === 1 && re.test(e.message) && e.message.includes(CONFIG_REL),
        `flow.${key}=${JSON.stringify(value)} must refuse by name`,
      );
    }
  });

  it('a minimal { schema: 1 } block still validates — every other schema-1 key is optional', () => {
    assert.doesNotThrow(() => validateConfig({ flow: { schema: FLOW_SCHEMA_VERSION } }));
  });
});
