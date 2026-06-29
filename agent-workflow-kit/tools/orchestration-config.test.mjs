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
} from './orchestration-config.mjs';

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
    assert.throws(() => validateConfig({ 'plan-authoring': { review: 'delegated' } }), (e) => e.exitCode === 1 && /invalid recipe "delegated" for review slot/.test(e.message));
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

// ── parseOp ≡ validateConfig accept/reject (the ONE shared slot/recipe validity table) ──
describe('orchestration-config — parseOp (typed, fully-qualified) + shared validity', () => {
  it('parses a valid --set into a typed record', () => {
    assert.deepEqual(parseOp('set', 'plan-authoring.review=council'), { kind: 'set', activity: 'plan-authoring', slot: 'review', recipe: 'council' });
    assert.deepEqual(parseOp('set', 'plan-execution.execute=delegated'), { kind: 'set', activity: 'plan-execution', slot: 'execute', recipe: 'delegated' });
  });

  it('parses a valid --unset into a typed record', () => {
    assert.deepEqual(parseOp('unset', 'plan-execution.review'), { kind: 'unset', activity: 'plan-execution', slot: 'review' });
  });

  it('rejects a BARE recipe (no activity) — name the activity (exit 2)', () => {
    assert.throws(() => parseOp('set', 'review=council'), (e) => e.exitCode === 2 && /name the activity/.test(e.message));
  });

  it('rejects unknown activity / unknown slot / invalid recipe-for-slot (exit 2)', () => {
    assert.throws(() => parseOp('set', 'plan-foo.review=council'), (e) => e.exitCode === 2 && /unknown activity "plan-foo"/.test(e.message));
    assert.throws(() => parseOp('set', 'plan-authoring.execute=delegated'), (e) => e.exitCode === 2 && /unknown slot "execute"/.test(e.message));
    assert.throws(() => parseOp('set', 'plan-authoring.review=delegated'), (e) => e.exitCode === 2 && /invalid recipe "delegated" for review slot/.test(e.message));
  });

  it('rejects a --set with no recipe, and a --unset with a stray recipe (exit 2)', () => {
    assert.throws(() => parseOp('set', 'plan-authoring.review='), (e) => e.exitCode === 2);
    assert.throws(() => parseOp('set', 'plan-authoring.review'), (e) => e.exitCode === 2);
    assert.throws(() => parseOp('unset', 'plan-authoring.review=solo'), (e) => e.exitCode === 2 && /without a recipe/.test(e.message));
  });

  // Drift table — parseOp('set') and validateConfig MUST agree on accept/reject for every (activity,
  // slot, recipe): both route through the one shared validity table. recipeValidForSlot is the predicate.
  it('parseOp(set) accept/reject ≡ validateConfig accept/reject over the full matrix', () => {
    const activities = ['plan-authoring', 'plan-execution', 'plan-foo'];
    const slots = ['review', 'execute', 'bogus'];
    const recipes = ['solo', 'reviewed', 'council', 'delegated', 'nope'];
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

  it('empty {} base + a real change + seedReadme → activity added AND _README seeded', () => {
    const out = applySetOps({}, [parseOp('set', 'plan-authoring.review=council')], { seedReadme: CANON_README });
    assert.equal(out._README, CANON_README);
    assert.equal(out['plan-authoring'].review, 'council');
  });

  it('absent (null) base behaves like {}', () => {
    const out = applySetOps(null, [parseOp('set', 'plan-authoring.review=council')], { seedReadme: CANON_README });
    assert.equal(out['plan-authoring'].review, 'council');
    assert.equal(out._README, CANON_README);
  });

  it('overwrites an existing slot value', () => {
    const out = applySetOps({ 'plan-authoring': { review: 'solo' } }, [parseOp('set', 'plan-authoring.review=council')]);
    assert.equal(out['plan-authoring'].review, 'council');
  });

  it('a no-op set (slot already equals) does NOT seed _README (change-gated)', () => {
    const out = applySetOps({ 'plan-authoring': { review: 'solo' } }, [parseOp('set', 'plan-authoring.review=solo')], { seedReadme: CANON_README });
    assert.equal(out._README, undefined, 'no change → no spurious _README seed');
    assert.deepEqual(out, { 'plan-authoring': { review: 'solo' } });
  });

  it('unset removes a slot; an emptied activity is dropped (sparse)', () => {
    const out = applySetOps({ 'plan-authoring': { review: 'council' }, 'plan-execution': { execute: 'delegated' } }, [parseOp('unset', 'plan-authoring.review')]);
    assert.equal(out['plan-authoring'], undefined, 'emptied activity dropped');
    assert.equal(out['plan-execution'].execute, 'delegated');
  });

  it('unset of an absent slot is a no-op (no seed, nothing added)', () => {
    const out = applySetOps({}, [parseOp('unset', 'plan-authoring.review')], { seedReadme: CANON_README });
    assert.deepEqual(out, {});
  });

  it('re-validates the merged result (loud on an invalid op slipping through)', () => {
    // A hand-built op that bypasses the parser must still be rejected by the post-merge validateConfig.
    assert.throws(() => applySetOps({}, [{ kind: 'set', activity: 'plan-authoring', slot: 'review', recipe: 'delegated' }]), (e) => e.exitCode === 1);
  });
});

// ── serializeConfig — canonical 2-space, _README first, round-trip ──
describe('orchestration-config — serializeConfig', () => {
  it('emits _README first, 2-space, trailing newline', () => {
    const out = serializeConfig({ 'plan-authoring': { review: 'solo' }, _README: 'note' });
    assert.ok(out.startsWith('{\n  "_README": "note",'), '_README sorted first');
    assert.ok(out.endsWith('}\n'), 'trailing newline');
    assert.equal(out, JSON.stringify({ _README: 'note', 'plan-authoring': { review: 'solo' } }, null, 2) + '\n');
  });

  it('round-trips: parse(serialize(x)) deep-equals x', () => {
    const x = { _README: 'r', 'plan-execution': { execute: 'delegated', review: 'council' } };
    assert.deepEqual(JSON.parse(serializeConfig(x)), x);
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
