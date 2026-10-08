import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  RECIPES,
  BACKEND_ROLES,
  BACKEND_META,
  DISPLAY_ALIASES,
  ACTIVITIES,
  SLOT_RECIPES,
  planRecipe,
  recommendRecipe,
  resolveActivityRecipe,
  formatRecipes,
  composeStatusLine,
  composeActiveRecipeLine,
  composeAutonomyFacts,
  buildReport,
  composeReadiness,
  bridgeEntries,
  requiredBackendsForConfiguredRecipe,
} from './recipes.mjs';
import { detectBackends, READY, NEEDS_SKILL, NEEDS_CLI, NEEDS_CREDENTIALS, DEGRADED } from './detect-backends.mjs';
import { usedBridges } from './bridge-sandbox-recipe.mjs';

const recipesModule = await import('./recipes.mjs');
const getRecommendWiredRecipe = () => {
  if (!recipesModule.recommendWiredRecipe) throw new Error('recommendWiredRecipe is absent');
  return recipesModule.recommendWiredRecipe;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'recipes.mjs');
const REPO_ROOT = join(HERE, '..', '..');

const CODEX = 'codex-cli-bridge';
const AGY = 'antigravity-cli-bridge';
const EXECUTOR = 'executor';
const CARRY = 'carry';
const RECIPE_IDS = ['solo', 'reviewed', 'council', 'delegated', 'subagent'];
const RECIPE_TITLES = ['Solo', 'Reviewed', 'Council', 'Delegated', 'Subagent'];
const WIRING_ROUTE = 'wire it on the chat yes of /agent-workflow-kit upgrade';
const WIRING_ROUTE_UNUSED = 'no slot uses it for review — once one does, the chat yes of /agent-workflow-kit upgrade wires it';
const SANDBOX_ENABLED_CONDITION = 'enabled in the project settings — ready means wired where the host honors the settings sandbox keys';
const SANDBOX_NOT_ENABLED_CONDITION = 'not enabled in the project settings — ready means installed';
const UNWIRED = 'not wired';
const UNCHECKED = 'unchecked';
const NOT_COVERED = 'not covered';
const BOOM = 'boom';
const UNCHECKED_CONDITION = `${UNCHECKED} — ${BOOM}`;
const CODEX_REVIEW_EXCLUSION = 'codex-review *';
const CODEX_STATE_DIR = '~/.codex';
const RECIPES_POINTER = ' — see /agent-workflow-kit recipes';
const REVIEW_CONFIG = Object.fromEntries(['plan-authoring', 'plan-execution', 'feedback-triage', 'epic'].map((activity) => [activity, { review: 'reviewed' }]));
const entry = (bridge, fields = {}) => ({
  bridge, roles: ['review'], used: true, state: 'wired', review: 'covered',
  missing: { excludedCommands: [], hosts: [], dirs: [] }, count: 0, reason: null, route: null, reviewRoute: null,
  ...fields,
});
const wiringOf = (condition, ...bridges) => ({
  enabled: condition === SANDBOX_ENABLED_CONDITION ? true : condition === SANDBOX_NOT_ENABLED_CONDITION ? false : null,
  reason: condition.startsWith(`${UNCHECKED} — `) ? condition.slice(`${UNCHECKED} — `.length) : null,
  condition, bridges,
});

// A synthetic detector fixture, built from the REAL readiness vocabulary (no `missing` — that is the
// vehicle's probe axis, not a bridge readiness).
const detect = (codexReadiness, agyReadiness) => [
  { name: CODEX, readiness: codexReadiness },
  { name: AGY, readiness: agyReadiness },
];

// The readiness array the CLI modes compose, through the CLI's own seam — never re-implemented here.
const readinessWith = (state, codexReadiness = READY, agyReadiness = READY) =>
  composeReadiness('/nowhere', {
    detect: () => detect(codexReadiness, agyReadiness),
    surveyVehicle: () => ({ state, reason: state === 'unusable' ? 'a symlink' : null, rel: '.claude/agents/executor.md' }),
  });

const readManifest = (name) => JSON.parse(readFileSync(join(REPO_ROOT, name, 'capability.json'), 'utf8'));

const makeWiringCliFixture = (t) => {
  const base = mkdtempSync(join(tmpdir(), 'recipes-wiring-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'root');
  const home = join(base, 'home');
  const bin = join(base, 'bin');
  const codexBridge = join(base, 'codex-bridge');
  const emptyBridge = join(base, 'empty-bridge');
  for (const dir of [join(root, '.git'), join(root, '.claude'), join(root, 'docs', 'ai'), join(home, '.codex'), bin, emptyBridge]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, '.codex', 'auth.json'), '{}');
  cpSync(join(HERE, '..', 'bridges', CODEX), codexBridge, { recursive: true, filter: (src) => basename(src) !== 'node_modules' });
  for (const cmd of ['codex', 'codex-review', 'codex-exec']) writeFileSync(join(bin, cmd), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { ...process.env, PATH: bin, HOME: home, CODEX_CLI_BRIDGE_DIR: codexBridge, ANTIGRAVITY_CLI_BRIDGE_DIR: emptyBridge, XDG_CONFIG_HOME: join(base, 'missing-xdg') };
  for (const key of ['CODEX_HOME', 'CODEX_SERVICE_TIER', 'CODEX_HARD_TIMEOUT', 'CODEX_REVIEW_MAX_TOTAL_BYTES', 'AGY_HARD_TIMEOUT', 'AGY_REVIEW_ALLOW_ADDDIR']) delete env[key];
  assert.equal(detectBackends({ getenv: env, home }).find((backend) => backend.name === CODEX).readiness, READY, 'detector precondition');
  writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify(REVIEW_CONFIG));
  const sandbox = { enabled: true, excludedCommands: [CODEX_REVIEW_EXCLUSION], network: { allowedDomains: readManifest(join('agent-workflow-kit', 'bridges', CODEX)).networkHosts } };
  const settingsPath = join(root, '.claude', 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ sandbox }));
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, env, encoding: 'utf8' });
  return { root, sandbox, settingsPath, run };
};

// ── RECIPES shape ────────────────────────────────────────────────────────────────

describe('RECIPES — the five named patterns', () => {
  it('is exactly the five recipes, in lattice order', () => {
    assert.deepEqual(RECIPES.map((r) => r.id), RECIPE_IDS);
  });

  it('each recipe declares a role (or null for Solo), a minBackends count, and a degradation target', () => {
    for (const r of RECIPES) {
      assert.ok(typeof r.id === 'string' && r.id.length > 0 && 'role' in r && 'degradesTo' in r, `${r.id} declares id/role/degradesTo`);
      assert.ok(Number.isInteger(r.minBackends), `${r.id} declares minBackends`);
    }
  });

  it('Solo is the floor (no role, no backend, no degradation target)', () => {
    const solo = RECIPES.find((r) => r.id === 'solo');
    assert.deepEqual([solo.role, solo.minBackends, solo.degradesTo], [null, 0, null]);
  });

  it('Reviewed/Council need review; Delegated needs execute; Subagent needs carry; chains terminate at Solo', () => {
    const by = Object.fromEntries(RECIPES.map((r) => [r.id, [r.role, r.minBackends, r.degradesTo]]));
    assert.deepEqual(by.reviewed, ['review', 1, 'solo']);
    assert.deepEqual(by.council, ['review', 2, 'reviewed']);
    assert.deepEqual(by.delegated, ['execute', 1, 'solo']);
    assert.deepEqual(by.subagent, [CARRY, 1, 'solo']);
  });
});

// ── drift guards ───────────────────────────────────────────────────────────────

describe('role-coverage drift-guard — every recipe role has a declared provider', () => {
  it('no recipe demands a role nothing provides', () => {
    const provided = new Set(Object.values(BACKEND_ROLES).flat());
    for (const r of RECIPES) {
      if (r.role !== null) assert.ok(provided.has(r.role), `recipe ${r.id} role "${r.role}" has a provider`);
    }
  });

  it('carry is the ONE role no bridge provides — the executor vehicle is its only provider', () => {
    const bridgeRoles = new Set([...readManifest(CODEX).provides, ...readManifest(AGY).provides]);
    const nonBridge = [...new Set(Object.values(BACKEND_ROLES).flat())].filter((role) => !bridgeRoles.has(role));
    assert.deepEqual(nonBridge, [CARRY]);
    assert.deepEqual(BACKEND_ROLES[EXECUTOR], [CARRY]);
  });
});

describe('manifest drift-guards — BACKEND_ROLES / BACKEND_META / DISPLAY_ALIASES track each bridge manifest', () => {
  it('is keyed by the readiness names (manifest names, not display aliases) plus the executor vehicle', () => {
    assert.deepEqual(Object.keys(BACKEND_ROLES).sort(), [AGY, CODEX, EXECUTOR].sort());
  });
  it('matches each bridge capability.json provides[]', () => {
    assert.deepEqual(BACKEND_ROLES[CODEX], readManifest(CODEX).provides);
    assert.deepEqual(BACKEND_ROLES[AGY], readManifest(AGY).provides);
  });
  it('cost + quota equal each bridge capability.json', () => {
    for (const name of [CODEX, AGY]) {
      const m = readManifest(name);
      assert.equal(BACKEND_META[name].cost, m.cost);
      assert.deepEqual(BACKEND_META[name].quota, m.quota);
    }
  });
  it('the agy health advisory (Issue-001) is present as static project knowledge', () => {
    assert.ok(typeof BACKEND_META[AGY].health === 'string' && BACKEND_META[AGY].health.length > 0);
    assert.ok(!BACKEND_META[CODEX].health, 'codex carries no standing health caveat');
  });
  it('maps both bridges to their short aliases', () => {
    assert.deepEqual([DISPLAY_ALIASES[CODEX], DISPLAY_ALIASES[AGY]], ['codex', 'agy']);
  });
});

// ── engine ⟷ kit recipe-name parity (cross-package read in the monorepo) ───────────

describe('engine↔kit recipe-name parity — the four ids appear in the engine canon', () => {
  const engineRefs = ['orchestration.md', 'orchestration-slot.md'].map((f) =>
    readFileSync(join(REPO_ROOT, 'agent-workflow-engine', 'references', f), 'utf8').toLowerCase(),
  );
  for (const id of RECIPE_IDS) {
    it(`"${id}" appears in both engine orchestration files`, () => {
      for (const text of engineRefs) assert.ok(text.includes(id), `engine canon names "${id}"`);
    });
  }
});

// The engine narrative (orchestration.md) hardcodes the bridges' role vocabulary as prose; keep it in
// lockstep with the manifests so a future `provides[]` change forces the narrative to be updated too.
describe('engine narrative ⟷ manifest role-vocabulary parity', () => {
  const orchestration = readFileSync(join(REPO_ROOT, 'agent-workflow-engine', 'references', 'orchestration.md'), 'utf8');
  const norm = (s) => s.replace(/\s+/g, ''); // whitespace-insensitive: prose has `["a", "b"]`, JSON has `["a","b"]`

  for (const name of [CODEX, AGY]) {
    it(`orchestration.md renders ${name}'s provides[] from the manifest`, () => {
      const provides = readManifest(name).provides;
      assert.ok(
        norm(orchestration).includes(norm(`provides: ${JSON.stringify(provides)}`)),
        `orchestration.md §1 must render ${name} provides ${JSON.stringify(provides)} (drifted from the manifest)`,
      );
    });
  }

  it('the agy health advisory (Issue-001) is consistent between BACKEND_META and the engine narrative, and reflects the grounded loosening', () => {
    // Flatten whitespace so a prose line-wrap (e.g. "substantive\nprompts") doesn't hide the substring.
    const flat = orchestration.replace(/\s+/g, ' ').toLowerCase();
    // The REAL service-stall caveat is kept (grounding removes false positives, not the stalls).
    assert.match(flat, /stall on substantive prompts/, 'the engine still narrates the real service-stall advisory');
    assert.match(flat, /issue-001/, 'the engine narrative ties it to Issue-001');
    assert.match(flat, /prefer .?codex/, 'codex stays the default for substantive / escalation reviews');
    // The LOOSENING: grounded agy-review is a sound second opinion (no longer "merely avoid agy").
    assert.match(flat, /grounded/, 'the loosening: the grounded agy-review contract is named');
    assert.match(flat, /sound|false positive/, 'the loosening: grounded review is a SOUND opinion (false positives removed)');
    // BACKEND_META carries the same advisory facts (kit-side), tying the two representations together.
    const health = BACKEND_META[AGY].health.toLowerCase();
    for (const frag of ['stall on substantive prompts', 'issue-001', 'codex', 'grounded']) {
      assert.ok(health.includes(frag), `BACKEND_META[AGY].health must include "${frag}"`);
    }
  });
});

// ── planRecipe ─────────────────────────────────────────────────────────────────

const dispatchBackends = (plan) => plan.dispatch.map((d) => d.backend);
const notesText = (plan) => plan.notes.join(' :: ');

// The lattice over every environment, as one table: requested recipe → effective recipe + dispatch.
const ENVIRONMENTS = [
  { name: 'both ready', det: detect(READY, READY), expect: { reviewed: ['reviewed', [CODEX]], council: ['council', [CODEX, AGY]], delegated: ['delegated', [CODEX]] } },
  { name: 'codex only', det: detect(READY, NEEDS_SKILL), expect: { reviewed: ['reviewed', [CODEX]], council: ['reviewed', [CODEX]], delegated: ['delegated', [CODEX]] } },
  { name: 'agy only', det: detect(NEEDS_SKILL, READY), expect: { reviewed: ['reviewed', [AGY]], council: ['reviewed', [AGY]], delegated: ['solo', []] } },
  { name: 'none installed', det: detect(NEEDS_SKILL, NEEDS_SKILL), expect: { reviewed: ['solo', []], council: ['solo', []], delegated: ['solo', []] } },
  { name: 'agy wrapper off PATH', det: detect(READY, DEGRADED), expect: { reviewed: ['reviewed', [CODEX]], council: ['reviewed', [CODEX]], delegated: ['delegated', [CODEX]] } },
];

describe('planRecipe — the lattice over every environment', () => {
  for (const { name, det, expect } of ENVIRONMENTS) {
    it(`${name}: Solo dispatches nothing and every recipe reaches its effective form`, () => {
      const solo = planRecipe('solo', det);
      assert.deepEqual([solo.effective, solo.degraded, solo.dispatch], ['solo', false, []]);
      for (const [requested, [effective, backends]] of Object.entries(expect)) {
        const p = planRecipe(requested, det);
        assert.equal(p.effective, effective, `${requested} in "${name}"`);
        assert.deepEqual(dispatchBackends(p), backends, `${requested} in "${name}"`);
        assert.equal(p.degraded, effective !== requested, `${requested} in "${name}"`);
      }
    });
  }

  it('a dispatch record carries the role, the readiness name and the display alias', () => {
    assert.deepEqual(planRecipe('delegated', detect(READY, READY)).dispatch, [{ role: 'execute', backend: CODEX, display: 'codex' }]);
  });
});

describe('planRecipe — degradation reasons, advisory notes, purity', () => {
  it('Council → Reviewed states the from/to pair and the not-installed bridge skill', () => {
    const step = planRecipe('council', detect(READY, NEEDS_SKILL)).degradation[0];
    assert.deepEqual([step.from, step.to], ['council', 'reviewed']);
    assert.match(step.reason, /not installed/i);
  });

  it('a wrapper off PATH reads as the wrapper reason, distinct from the health note', () => {
    assert.match(planRecipe('council', detect(READY, DEGRADED)).degradation[0].reason, /PATH|wrapper/i);
  });

  it('a role no ready backend provides names the role', () => {
    assert.match(planRecipe('delegated', detect(NEEDS_SKILL, READY)).degradation[0].reason, /execute/i);
  });

  it('the agy health caveat rides a dispatch that uses agy, and only that', () => {
    const health = BACKEND_META[AGY].health;
    assert.ok(notesText(planRecipe('council', detect(READY, READY))).includes(health), 'council uses agy');
    assert.ok(notesText(planRecipe('reviewed', detect(NEEDS_SKILL, READY))).includes(health), 'agy is the reviewer');
    assert.ok(!notesText(planRecipe('reviewed', detect(READY, READY))).includes(health), 'codex chosen');
    assert.ok(!notesText(planRecipe('reviewed', detect(READY, DEGRADED))).includes(health), 'agy not dispatchable');
  });

  it('Council carries the two-quota caveat', () => {
    assert.match(notesText(planRecipe('council', detect(READY, READY))), /two backends|both backends|two .*quota/i);
  });

  it('is deterministic: same detection → deeply-equal plan', () => {
    const det = detect(READY, NEEDS_CREDENTIALS);
    assert.deepEqual(planRecipe('council', det), planRecipe('council', det));
  });

  it('does not mutate the detection input', () => {
    const det = detect(READY, READY);
    const snapshot = JSON.parse(JSON.stringify(det));
    planRecipe('council', det);
    assert.deepEqual(det, snapshot);
  });
});

// ── recommendRecipe ──────────────────────────────────────────────────────────────

describe('recommendRecipe — never blank; the everyday default', () => {
  it('both ready → Council available, Reviewed the everyday default', () => {
    const r = recommendRecipe(detect(READY, READY));
    assert.equal(r.recipe, 'council');
    assert.match(r.clause, /council/i);
    assert.match(r.clause, /reviewed/i);
  });

  it('one ready → Reviewed', () => {
    const r = recommendRecipe(detect(READY, NEEDS_SKILL));
    assert.equal(r.recipe, 'reviewed');
    assert.match(r.clause, /reviewed/i);
  });

  it('none installed → Solo + a setup pointer', () => {
    const r = recommendRecipe(detect(NEEDS_SKILL, NEEDS_SKILL));
    assert.equal(r.recipe, 'solo');
    assert.match(r.clause, /solo/i);
    assert.match(r.clause, /\/agent-workflow-kit setup/);
  });

  it('present-but-not-ready → Solo with the specific remedy', () => {
    const r = recommendRecipe(detect(NEEDS_CLI, NEEDS_SKILL));
    assert.equal(r.recipe, 'solo');
    assert.match(r.clause, /CLI|cli/);
  });

  it('the clause is never empty', () => {
    const mixes = [detect(READY, READY), detect(READY, NEEDS_SKILL), detect(NEEDS_SKILL, NEEDS_SKILL), detect(NEEDS_CREDENTIALS, DEGRADED)];
    for (const det of mixes) assert.ok(recommendRecipe(det).clause.trim().length > 0);
  });

  it('present-but-not-ready tie-break is deterministic (codex before agy) regardless of detection order', () => {
    // At the SAME readiness rank the remedy must name codex, not whichever the detector emitted first.
    const forward = recommendRecipe([{ name: CODEX, readiness: DEGRADED }, { name: AGY, readiness: DEGRADED }]);
    const reversed = recommendRecipe([{ name: AGY, readiness: DEGRADED }, { name: CODEX, readiness: DEGRADED }]);
    assert.equal(forward.clause, reversed.clause, 'order-independent');
    assert.match(forward.clause, /codex/, 'ties break to codex');
  });
});

// ── CLI / formatRecipes ──────────────────────────────────────────────────────────

describe('formatRecipes — deterministic advisor text', () => {
  it('renders the five recipes + a recommendation deterministically', () => {
    const det = detect(READY, NEEDS_SKILL);
    const once = formatRecipes(det);
    assert.equal(once, formatRecipes(det), 'same detection → identical text');
    assert.match(once, /via the bridge skills or the executor vehicle and always commits/, 'the header names both carriers');
    assert.match(once, /needs a provider providing carry, but no provider provides it/, 'a degrade names providers, never only backends');
    for (const title of RECIPE_TITLES) assert.match(once, new RegExp(title));
  });
});

// ── ACTIVITIES + resolveActivityRecipe (the activity-procedures resolver) ───────────

// The table itself is pinned in carriers.test.mjs; what recipes.mjs owes is the re-export (so no
// importer's path moved) and the bridge between the table's values and the RECIPES lattice.
describe('the registry re-export — carriers.mjs through recipes.mjs', () => {
  it('re-exports the table so every importer keeps its `from ./recipes.mjs` path', async () => {
    const carriers = await import('./carriers.mjs');
    assert.equal(ACTIVITIES, carriers.ACTIVITIES, 'one table object, not a copy');
    assert.equal(SLOT_RECIPES, carriers.SLOT_RECIPES);
  });

  it('every recipe-typed slot value is a real RECIPE id; a switch value is deliberately not one', () => {
    const recipeIds = new Set(RECIPES.map((r) => r.id));
    for (const def of Object.values(ACTIVITIES)) {
      for (const slotType of Object.values(def.slots)) {
        if (slotType === 'switch') continue;
        for (const id of SLOT_RECIPES[slotType]) assert.ok(recipeIds.has(id), `"${id}" is a real recipe`);
      }
    }
    for (const value of SLOT_RECIPES.switch) assert.ok(!recipeIds.has(value), `"${value}" is a flag, not a recipe`);
  });
});

// The resolution triple every arm below reads: what ran, where it came from, what it fell from.
const resolveTriple = (args) => {
  const r = resolveActivityRecipe(args);
  return [r.recipe, r.source, r.degradedFrom];
};

describe('resolveActivityRecipe — defaults (config silent), readiness-aware', () => {
  it('review default is Reviewed when a backend is ready — NOT Council (recommendRecipe is not reused)', () => {
    assert.deepEqual(resolveTriple({ readiness: detect(READY, READY), activity: 'plan-authoring', slot: 'review' }), ['reviewed', 'default', null]);
    // sanity: recommendRecipe DOES return council for the same detection — the default must not.
    assert.equal(recommendRecipe(detect(READY, READY)).recipe, 'council');
  });

  it('review default is Solo when no backend is ready', () => {
    assert.deepEqual(resolveTriple({ readiness: detect(NEEDS_SKILL, NEEDS_SKILL), activity: 'plan-authoring', slot: 'review' }), ['solo', 'default', null]);
  });

  it('execute default is Solo even when codex is ready (Delegated is opt-in)', () => {
    assert.deepEqual(resolveTriple({ readiness: detect(READY, READY), activity: 'plan-execution', slot: 'execute' }), ['solo', 'default', null]);
  });
});

describe('resolveActivityRecipe — config-driven, graceful degradation', () => {
  const config = { 'plan-authoring': { review: 'council' }, 'plan-execution': { execute: 'delegated', review: 'reviewed' } };

  it('config review=council holds when both backends are ready', () => {
    const r = resolveActivityRecipe({ config, readiness: detect(READY, READY), activity: 'plan-authoring', slot: 'review' });
    assert.deepEqual([r.recipe, r.source, r.degradedFrom, r.overrideUnsatisfied], ['council', 'config', null, false]);
  });

  it('config review=council degrades GRACEFULLY to Reviewed with one backend (not a loud override)', () => {
    const r = resolveActivityRecipe({ config, readiness: detect(READY, NEEDS_SKILL), activity: 'plan-authoring', slot: 'review' });
    assert.deepEqual([r.recipe, r.degradedFrom, r.overrideUnsatisfied], ['reviewed', 'council', false]);
    assert.match(r.reason, /not installed|council/i);
  });

  it('config execute=delegated holds when codex is ready', () => {
    assert.deepEqual(resolveTriple({ config, readiness: detect(READY, NEEDS_SKILL), activity: 'plan-execution', slot: 'execute' }), ['delegated', 'config', null]);
  });

  it('config execute=delegated degrades to Solo when codex is not ready (agy cannot execute)', () => {
    const r = resolveActivityRecipe({ config, readiness: detect(NEEDS_SKILL, READY), activity: 'plan-execution', slot: 'execute' });
    assert.deepEqual([r.recipe, r.degradedFrom, r.overrideUnsatisfied], ['solo', 'delegated', false]);
    assert.match(r.reason, /execute/i);
  });
});

describe('resolveActivityRecipe — override precedence + LOUD degradation', () => {
  it('an override beats the config entry', () => {
    const config = { 'plan-authoring': { review: 'solo' } };
    assert.deepEqual(resolveTriple({ config, readiness: detect(READY, READY), activity: 'plan-authoring', slot: 'review', override: 'council' }), ['council', 'override', null]);
  });

  it('an unsatisfiable override degrades LOUDLY (overrideUnsatisfied = true)', () => {
    const r = resolveActivityRecipe({ readiness: detect(READY, NEEDS_SKILL), activity: 'plan-authoring', slot: 'review', override: 'council' });
    assert.deepEqual([r.recipe, r.degradedFrom, r.overrideUnsatisfied], ['reviewed', 'council', true]);
  });

  it('a satisfiable override is not flagged', () => {
    const r = resolveActivityRecipe({ readiness: detect(READY, READY), activity: 'plan-authoring', slot: 'review', override: 'council' });
    assert.deepEqual([r.recipe, r.overrideUnsatisfied], ['council', false]);
  });
});

describe('resolveActivityRecipe — defensive validity + purity', () => {
  it('throws on an unknown activity', () => {
    assert.throws(() => resolveActivityRecipe({ readiness: detect(READY, READY), activity: 'nope', slot: 'review' }), /unknown activity/);
  });
  it('throws on an unknown slot for the activity', () => {
    assert.throws(() => resolveActivityRecipe({ readiness: detect(READY, READY), activity: 'plan-authoring', slot: 'execute' }), /unknown slot/);
  });
  it('throws on a recipe invalid for the slot (e.g. delegated in a review slot)', () => {
    assert.throws(() => resolveActivityRecipe({ readiness: detect(READY, READY), activity: 'plan-authoring', slot: 'review', override: 'delegated' }), /invalid recipe/);
  });
  it('does not mutate the detection input', () => {
    const det = detect(READY, READY);
    const snapshot = JSON.parse(JSON.stringify(det));
    resolveActivityRecipe({ readiness: det, activity: 'plan-execution', slot: 'review' });
    assert.deepEqual(det, snapshot);
  });
});

describe('the subagent carrier in the lattice, the resolver and the CLI (spec:carriers/S2) (spec:plan-review-loop/S15)', () => {
  it('a placed or customized vehicle carries; a missing or unusable one degrades to Solo', () => {
    for (const state of ['placed', 'customized']) {
      const p = planRecipe('subagent', readinessWith(state));
      assert.equal(p.effective, 'subagent');
      assert.deepEqual(p.dispatch, [{ role: CARRY, backend: EXECUTOR, display: EXECUTOR, vehicle: state }]);
      assert.deepEqual(p.notes, [], 'the vehicle spends no bridge quota');
    }
    for (const state of ['missing', 'unusable']) {
      const p = planRecipe('subagent', readinessWith(state));
      assert.equal(p.effective, 'solo', state);
      assert.equal(p.degraded, true);
      assert.match(p.degradation.map((d) => d.reason).join(' '), new RegExp(`${CARRY}|${EXECUTOR}`));
    }
  });

  it('the executor is the ONLY provider of carry — both bridges ready changes nothing', () => {
    const p = planRecipe('subagent', detect(READY, READY));
    assert.equal(p.effective, 'solo');
    assert.match(p.degradation[0].reason, /no provider provides it/);
  });

  it('a carrier slot holds when placed, degrades gracefully when missing, and stays silent by default', () => {
    const config = { 'plan-authoring': { author: 'subagent', fold: 'subagent' }, routine: { carrier: 'subagent' } };
    for (const [activity, slot] of [['plan-authoring', 'author'], ['plan-authoring', 'fold'], ['routine', 'carrier']]) {
      const ok = resolveActivityRecipe({ config, readiness: readinessWith('placed'), activity, slot });
      assert.deepEqual([ok.recipe, ok.source, ok.degradedFrom], ['subagent', 'config', null]);
      const gone = resolveActivityRecipe({ config, readiness: readinessWith('missing'), activity, slot });
      assert.deepEqual([gone.recipe, gone.degradedFrom, gone.overrideUnsatisfied], ['solo', 'subagent', false]);
      const silent = resolveActivityRecipe({ readiness: readinessWith('placed'), activity, slot });
      assert.deepEqual([silent.recipe, silent.source], ['solo', 'default'], 'placing the vehicle never flips a default');
    }
  });

  it('a silent fold stays solo beside a configured author subagent', () => {
    const config = { 'plan-authoring': { author: 'subagent' } };
    const author = resolveActivityRecipe({ config, readiness: readinessWith('placed'), activity: 'plan-authoring', slot: 'author' });
    const fold = resolveActivityRecipe({ config, readiness: readinessWith('placed'), activity: 'plan-authoring', slot: 'fold' });
    assert.deepEqual([author.recipe, author.source], ['subagent', 'config']);
    assert.deepEqual([fold.recipe, fold.source], ['solo', 'default']);
  });

  it('an --override to subagent on a missing vehicle degrades LOUDLY', () => {
    for (const [activity, slot] of [['plan-authoring', 'fold'], ['plan-execution', 'execute']]) {
      const r = resolveActivityRecipe({ readiness: readinessWith('missing'), activity, slot, override: 'subagent' });
      assert.deepEqual([r.recipe, r.degradedFrom, r.overrideUnsatisfied], ['solo', 'subagent', true], `${activity}.${slot}`);
    }
  });

  it('routine.parallel returns its value untouched from every source and NEVER degrades', () => {
    const flag = (extra) => resolveActivityRecipe({ readiness: readinessWith('missing'), activity: 'routine', slot: 'parallel', ...extra });
    assert.deepEqual(flag({}), { recipe: 'on', source: 'default', degradedFrom: null, reason: null, overrideUnsatisfied: false });
    assert.deepEqual(flag({ config: { routine: { parallel: 'off' } } }), { recipe: 'off', source: 'config', degradedFrom: null, reason: null, overrideUnsatisfied: false });
    assert.deepEqual(flag({ config: { routine: { parallel: 'off' } }, override: 'on' }), { recipe: 'on', source: 'override', degradedFrom: null, reason: null, overrideUnsatisfied: false });
  });

  it('routine.parallel refuses a value outside on|off rather than coercing it', () => {
    assert.throws(
      () => resolveActivityRecipe({ readiness: readinessWith('placed'), activity: 'routine', slot: 'parallel', override: 'maybe' }),
      /invalid recipe "maybe" for switch slot/,
    );
  });

  it('a ready executor is NOT a ready reviewer — a silent review config still computes solo', () => {
    const r = requiredBackendsForConfiguredRecipe({ config: {}, readiness: readinessWith('placed', NEEDS_SKILL, NEEDS_SKILL) });
    assert.deepEqual([r.recipe, r.source, r.backends, r.minShip], ['solo', 'default', [], 0]);
    assert.equal(recommendRecipe(readinessWith('placed', NEEDS_SKILL, NEEDS_SKILL)).recipe, 'solo');
  });

  it('derives the raw review obligation independently for each review activity', () => {
    const readiness = detect(READY, NEEDS_SKILL);
    const table = [
      ['solo', 'solo', [], false],
      ['reviewed', 'reviewed', ['codex', 'agy'], false],
      ['council', 'council', ['codex', 'agy'], true],
      [['codex-review'], 'reviewed', ['codex'], true],
      [['review-lens'], 'solo', [], false],
      [['codex-review', 'review-lens'], 'reviewed', ['codex'], true],
    ];
    for (const activity of ['plan-authoring', 'plan-execution']) {
      for (const [configured, recipe, backends, perBackend] of table) {
        const result = requiredBackendsForConfiguredRecipe({ config: { [activity]: { review: configured } }, readiness, activity });
        assert.deepEqual([result.recipe, result.backends, result.perBackend], [recipe, backends, perBackend], `${activity}: ${JSON.stringify(configured)}`);
      }
    }
  });

  it('uses readiness only for an absent slot, reports detector failure as unknowable, and defaults activity to plan-execution', () => {
    const oneReady = detect(READY, NEEDS_SKILL);
    const noneReady = detect(NEEDS_SKILL, NEEDS_SKILL);
    assert.equal(requiredBackendsForConfiguredRecipe({ config: {}, readiness: oneReady, activity: 'plan-authoring' }).recipe, 'reviewed');
    assert.equal(requiredBackendsForConfiguredRecipe({ config: {}, readiness: noneReady, activity: 'plan-authoring' }).recipe, 'solo');
    assert.equal(requiredBackendsForConfiguredRecipe({ config: {}, readiness: [], detectionFailed: true, activity: 'plan-authoring' }).unknowable, true);
    assert.equal(requiredBackendsForConfiguredRecipe({ config: { 'plan-authoring': { review: 'council' } }, readiness: [], detectionFailed: true, activity: 'plan-authoring' }).unknowable, false);
    assert.equal(requiredBackendsForConfiguredRecipe({ config: { 'plan-execution': { review: 'council' } }, readiness: noneReady }).recipe, 'council');
    assert.throws(() => requiredBackendsForConfiguredRecipe({ config: {}, readiness: noneReady, activity: 'routine' }), /has no review slot/);
  });

  it('the human render names the vehicle state when placed, and the degrade when missing', () => {
    const placed = formatRecipes(readinessWith('placed'));
    assert.match(placed, /Subagent \(subagent\) — a full-tool frontier subagent/);
    assert.match(placed, /Subagent: executor carry \(vehicle placed\)/);
    assert.match(formatRecipes(readinessWith('missing')), /Subagent → solo: orchestrator only/);
  });

  it('the JSON report carries the fifth recipe and its plan, placed and missing', () => {
    const placed = buildReport(readinessWith('placed'));
    assert.deepEqual(placed.recipes.map((r) => r.id), RECIPE_IDS);
    const placedPlan = placed.plans.find((p) => p.requested === 'subagent');
    assert.equal(placedPlan.effective, 'subagent');
    assert.deepEqual(placedPlan.dispatch, [{ role: CARRY, backend: EXECUTOR, display: EXECUTOR, vehicle: 'placed' }]);
    const missingPlan = buildReport(readinessWith('missing')).plans.find((p) => p.requested === 'subagent');
    assert.deepEqual([missingPlan.effective, missingPlan.degraded], ['solo', true]);
  });

  it('the active-recipe line renders the new slots and dispatches no wrapper for the executor', () => {
    const line = composeActiveRecipeLine({ config: { routine: { carrier: 'subagent' } }, source: 'x' }, readinessWith('placed'));
    assert.ok(!line.includes('\n'), 'exactly one line');
    assert.match(line, /routine\.carrier = subagent \(configured\)/);
    assert.match(line, /routine\.parallel = on \(computed default; switch\)/);
    assert.match(line, /plan-authoring\.author = solo \(computed default\)/);
    assert.match(line, /plan-authoring\.fold = solo \(computed default\)/);
  });
});

// ── the two axes: bridgeEntries (what the renders name) + composeReadiness (how they get it) ──────

describe('bridgeEntries + composeReadiness — the bridge half renders, the carrier survives a detector throw', () => {
  const boom = () => { throw new Error('corrupt bridge (EISDIR)'); };
  const placed = () => ({ state: 'placed', reason: null, rel: '.claude/agents/executor.md' });

  it('bridgeEntries drops exactly the executor entry, keeps bridge order, and never mutates its input', () => {
    const readiness = readinessWith('placed', READY, NEEDS_SKILL);
    const snapshot = structuredClone(readiness);
    assert.deepEqual(bridgeEntries(readiness).map((b) => b.name), [CODEX, AGY]);
    assert.deepEqual(readiness, snapshot, 'the input array is untouched');
    assert.deepEqual(bridgeEntries(detect(READY, READY)), detect(READY, READY), 'no vehicle entry — nothing dropped');
  });

  it('composeStatusLine never names the executor, while the lattice still carries the placed vehicle', () => {
    const readiness = readinessWith('placed');
    assert.ok(!composeStatusLine(readiness, recommendRecipe(readiness)).includes(EXECUTOR));
    assert.equal(planRecipe('subagent', readiness).effective, 'subagent');
  });

  it('surveys the vehicle FIRST and hands a detector throw to the hook exactly once', () => {
    const order = [];
    const errors = [];
    const readiness = composeReadiness('/nowhere', {
      surveyVehicle: () => { order.push('survey'); return placed(); },
      detect: () => { order.push('detect'); return boom(); },
      onDetectError: (err) => errors.push(err),
    });
    assert.deepEqual(order, ['survey', 'detect'], 'the vehicle is surveyed before the bridges');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /corrupt bridge/);
    assert.deepEqual(readiness.map((b) => b.name), [EXECUTOR], 'the vehicle entry only — the bridge set is empty');
    assert.equal(readiness[0].readiness, READY);
  });

  it('with NO hook the throw becomes one stderr line and the vehicle still comes back', () => {
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    let readiness;
    try {
      readiness = composeReadiness('/nowhere', { surveyVehicle: placed, detect: boom });
    } finally {
      console.error = original;
    }
    assert.deepEqual(readiness.map((b) => b.name), [EXECUTOR]);
    assert.equal(lines.length, 1, 'exactly one line, never a repeat per caller');
    assert.match(lines[0], /backend detection failed: corrupt bridge/);
  });

  it('CLI: neither --status-line nor --json lists the executor under backends, and subagent still resolves', () => {
    const root = mkdtempSync(join(tmpdir(), 'recipes-vehicle-'));
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(root, '.claude', 'agents', 'executor.md'), readFileSync(join(HERE, '..', 'references', 'agents', 'executor.md')));
    const env = { ...process.env, PATH: '' };
    const opts = { encoding: 'utf8', env, cwd: root };
    const report = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--json'], opts));
    const statusLine = execFileSync(process.execPath, [SCRIPT, '--status-line'], opts);
    rmSync(root, { recursive: true, force: true });
    assert.equal(report.plans.find((p) => p.requested === 'subagent').effective, 'subagent', 'the placed vehicle carries');
    const backendsPart = (line) => line.slice(0, line.indexOf(' — run '));
    assert.ok(!backendsPart(report.statusLine).includes(EXECUTOR));
    assert.ok(!backendsPart(statusLine).includes(EXECUTOR));
  });
});

// ── composeStatusLine (the machine-composed one-line backend status) ───────────────

describe('composeStatusLine — the tool speaks, the agent pastes', () => {
  it('composes the WHOLE line: backend parts · backends pointer · recipes clause · recipes pointer', () => {
    const det = detect(READY, NEEDS_CREDENTIALS);
    const rec = recommendRecipe(det);
    assert.equal(
      composeStatusLine(det, rec),
      `backends: codex ✓ ready · agy ✗ needs-credentials — run /agent-workflow-kit backends · recipes: ${rec.clause} — see /agent-workflow-kit recipes`,
    );
  });

  it('is exactly one line for every readiness mix (no part may inject a newline)', () => {
    for (const det of [detect(READY, READY), detect(NEEDS_SKILL, DEGRADED), detect(NEEDS_CLI, NEEDS_CREDENTIALS)]) {
      assert.ok(!composeStatusLine(det, recommendRecipe(det)).includes('\n'));
    }
  });

  it('is deterministic under reversed detection order (codex renders before agy)', () => {
    const forward = detect(READY, DEGRADED);
    const reversed = [...forward].reverse();
    assert.equal(composeStatusLine(forward, recommendRecipe(forward)), composeStatusLine(reversed, recommendRecipe(reversed)));
    assert.match(composeStatusLine(reversed, recommendRecipe(reversed)), /codex .* agy/);
  });

  it('display names come from the ONE alias table (DISPLAY_ALIASES) — never the raw manifest names', () => {
    const line = composeStatusLine(detect(READY, READY), { clause: 'x' });
    for (const alias of Object.values(DISPLAY_ALIASES)) assert.ok(line.includes(`${alias} `), `uses the "${alias}" alias`);
    assert.ok(!line.includes('cli-bridge'), 'raw manifest names never leak into the line');
  });

  it('ready → ✓; every non-ready readiness → ✗ + its own token', () => {
    const line = composeStatusLine(detect(READY, NEEDS_SKILL), { clause: 'x' });
    assert.match(line, /codex ✓ ready/);
    assert.match(line, /agy ✗ needs-skill/);
  });

  it('settings suffix: appended ONLY when a bridge knob is active; the default line stays byte-identical', () => {
    const det = detect(READY, READY);
    const base = composeStatusLine(det, { clause: 'x' });
    // No snapshot / no active knob → byte-identical to the two-arg form (unchanged unless a knob is active).
    assert.equal(composeStatusLine(det, { clause: 'x' }, null), base);
    assert.equal(composeStatusLine(det, { clause: 'x' }, { active: [] }), base);
    // An active knob → a fact-only ` · settings: KEY=VALUE` suffix, still ONE line (no newline).
    const withKnob = composeStatusLine(det, { clause: 'x' }, { active: [{ key: 'CODEX_SERVICE_TIER', value: 'priority' }] });
    assert.equal(withKnob, `${base} · settings: CODEX_SERVICE_TIER=priority`);
    assert.ok(!withKnob.includes('\n'), 'the knob suffix never breaks the single-line invariant');
  });

  it('a raw env value carrying a newline is collapsed to one line (review-recipes-r02-major-01: no newline injection)', () => {
    const det = detect(READY, READY);
    const line = composeStatusLine(det, { clause: 'x' }, { active: [{ key: 'CODEX_HARD_TIMEOUT', value: '2h\nINJECTED: pwned' }] });
    assert.ok(!line.includes('\n'), 'a newline in a raw env value never breaks the one-line contract');
    assert.match(line, /settings: CODEX_HARD_TIMEOUT=2h INJECTED: pwned/);
  });

  it('autonomy segment (AD-044 Plan 4): appended ONLY when the facts are supplied; the default line stays byte-identical', () => {
    const det = detect(READY, READY);
    const base = composeStatusLine(det, { clause: 'x' });
    assert.equal(composeStatusLine(det, { clause: 'x' }, null, null), base, 'an omitted param keeps the line byte-identical');
    const prompts = { 'plan-authoring': { autonomy: 'prompt' }, 'plan-execution': { autonomy: 'prompt' } };
    const declared = composeStatusLine(det, { clause: 'x' }, null, { source: 'docs/ai/autonomy.json', activities: { ...prompts, 'plan-execution': { autonomy: 'sandbox' } }, renderState: 'in sync' });
    assert.equal(declared, `${base} · autonomy: plan-authoring=prompt, plan-execution=sandbox (declared; render in sync)`);
    const defaults = composeStatusLine(det, { clause: 'x' }, null, { source: 'none', activities: prompts, renderState: null });
    assert.match(defaults, /autonomy: .*\(computed defaults — no policy file; declare with \/agent-workflow-kit set-autonomy\)$/);
    const sparse = composeStatusLine(det, { clause: 'x' }, null, { source: 'docs/ai/autonomy.json', defaultsEquivalent: true, activities: prompts, renderState: null });
    assert.match(sparse, /\(declared, defaults-equivalent — computed defaults apply; declare levels with \/agent-workflow-kit set-autonomy\)$/, 'the sparse seed never reads as DRIFT');
  });

  it('autonomy segment: a MALFORMED policy surfaces loudly and never breaks the one-line contract', () => {
    const det = detect(READY, READY);
    const line = composeStatusLine(det, { clause: 'x' }, null, { error: 'docs/ai/autonomy.json: malformed JSON\n(details)' });
    assert.ok(!line.includes('\n'), 'a newline-carrying error message never breaks the single line');
    assert.match(line, /autonomy: MALFORMED policy — docs\/ai\/autonomy\.json: malformed JSON \(details\)/);
  });
});

describe('spec:velocity-profile/S17 — wiring cells, recommendation clauses and report parity', () => {
  const det = detect(READY, READY);
  const rec = recommendRecipe(det);
  const enabled = (...entries) => wiringOf(SANDBOX_ENABLED_CONDITION, ...entries);
  const unchecked = wiringOf(UNCHECKED_CONDITION, ...[CODEX, AGY].map((bridge) => entry(bridge, { state: UNCHECKED, review: UNCHECKED, reason: BOOM })));
  it('renders used, unused and unchecked cells and keeps every non-ready cell unchanged', () => {
    const used = enabled(entry(CODEX, { state: UNWIRED, count: 3, route: WIRING_ROUTE }), entry(AGY));
    assert.ok(composeStatusLine(det, rec, null, null, null, used).includes('codex ✗ not wired — 3 sandbox entr(ies) missing · agy ✓ ready'));
    const unused = enabled(entry(CODEX), entry(AGY, { state: UNWIRED, used: false, count: 2, route: WIRING_ROUTE_UNUSED }));
    assert.ok(composeStatusLine(det, rec, null, null, null, unused).includes('agy ✗ not wired (unused) — 2 sandbox entr(ies) missing'));
    const line = composeStatusLine(det, rec, null, null, null, unchecked);
    assert.ok(line.includes(`codex ✗ unchecked — ${BOOM} · agy ✗ unchecked — ${BOOM}`));
    assert.ok(line.includes(` · sandbox: ${UNCHECKED_CONDITION}`));
    for (const state of [NEEDS_SKILL, NEEDS_CLI, NEEDS_CREDENTIALS, DEGRADED]) {
      const partial = detect(READY, state);
      assert.ok(composeStatusLine(partial, recommendRecipe(partial), null, null, null, enabled(entry(CODEX))).includes(`agy ✗ ${state}`));
    }
  });
  it('puts enabled and not-enabled conditions before settings, autonomy and posture', () => {
    const settings = { active: [{ key: 'CODEX_SERVICE_TIER', value: 'priority' }] };
    const autonomy = { source: 'docs/ai/autonomy.json', activities: { 'plan-authoring': { autonomy: 'prompt' }, 'plan-execution': { autonomy: 'sandbox' } }, renderState: 'in sync' };
    const posture = 'fixture posture';
    for (const condition of [SANDBOX_ENABLED_CONDITION, SANDBOX_NOT_ENABLED_CONDITION]) {
      const line = composeStatusLine(det, rec, settings, autonomy, posture, wiringOf(condition, entry(CODEX), entry(AGY)));
      assert.ok(line.includes(`${RECIPES_POINTER} · sandbox: ${condition} · settings: CODEX_SERVICE_TIER=priority · autonomy: `));
      assert.ok(line.endsWith(` · posture: ${posture}`));
    }
  });
  it('uses the wired clause whatever recommendation is passed', () => {
    const wiring = enabled(entry(CODEX, { review: NOT_COVERED, reviewRoute: WIRING_ROUTE }), entry(AGY));
    const clause = getRecommendWiredRecipe()(det, wiring).clause;
    const line = composeStatusLine(det, { clause: 'x' }, null, null, null, wiring);
    assert.ok(line.includes(`recipes: ${clause} — see`));
    assert.ok(!line.includes('recipes: x —'));
  });
  it('keeps the readiness recipe and appends only uncovered review routes and unchecked aliases', () => {
    const codexOnly = detect(READY, NEEDS_SKILL);
    const uncoveredCodex = entry(CODEX, { review: NOT_COVERED, reviewRoute: WIRING_ROUTE });
    const uncoveredAgy = entry(AGY, { review: NOT_COVERED, reviewRoute: WIRING_ROUTE_UNUSED });
    const uncheckedAgy = entry(AGY, { state: UNCHECKED, review: UNCHECKED, reason: BOOM });
    const cases = [
      [det, enabled(entry(CODEX), entry(AGY)), ''],
      [codexOnly, enabled(entry(CODEX, { state: UNWIRED, missing: { excludedCommands: ['codex-exec *'], hosts: [], dirs: [] }, count: 1, route: WIRING_ROUTE })), ''],
      [codexOnly, enabled(entry(CODEX, { used: false, review: NOT_COVERED, reviewRoute: WIRING_ROUTE_UNUSED })), ` · not wired: codex (review) — ${WIRING_ROUTE_UNUSED}`],
      [det, enabled(uncoveredCodex, entry(AGY)), ` · not wired: codex (review) — ${WIRING_ROUTE}`],
      [det, enabled(uncoveredCodex, uncoveredAgy), ` · not wired: codex (review) — ${WIRING_ROUTE}; agy (review) — ${WIRING_ROUTE_UNUSED}`],
      [det, unchecked, ' · unchecked: codex, agy'],
      [det, enabled(uncoveredCodex, uncheckedAgy), ` · not wired: codex (review) — ${WIRING_ROUTE} · unchecked: agy`],
    ];
    for (const [readiness, wiring, tail] of cases) {
      const base = recommendRecipe(readiness);
      const actual = getRecommendWiredRecipe()(readiness, wiring);
      assert.equal(actual.recipe, base.recipe);
      assert.deepEqual(actual, tail ? { recipe: base.recipe, clause: base.clause + tail } : base);
    }
  });
  it('carries wiring in the report and keeps omitted or null wiring byte-identical', () => {
    assert.equal(composeStatusLine(det, rec), composeStatusLine(det, rec, null, null, null, null));
    assert.equal(JSON.stringify(buildReport(det)), JSON.stringify(buildReport(det, null, null, null, null)));
    assert.ok(!JSON.stringify(buildReport(det)).includes('"wiring"'));
    const wiring = enabled(entry(CODEX, { state: UNWIRED, count: 1, route: WIRING_ROUTE }), entry(AGY));
    const report = buildReport(det, null, null, null, wiring);
    assert.equal(report.statusLine, composeStatusLine(det, report.recommendation, null, null, null, wiring));
    assert.ok(report.statusLine.includes(' · sandbox: '));
    assert.deepEqual(report.wiring, wiring);
    assert.deepEqual(report.recommendation, rec);
  });
});

describe('spec:velocity-profile/S18 — recipes name wiring without changing readiness or dispatch', () => {
  it('renders missing keys and routes in priority order while every readiness consumer still names codex', () => {
    const det = detect(READY, READY);
    const snapshot = structuredClone(det);
    const codex = entry(CODEX, { state: UNWIRED, review: NOT_COVERED, reviewRoute: WIRING_ROUTE, route: WIRING_ROUTE, missing: { excludedCommands: [CODEX_REVIEW_EXCLUSION], hosts: ['chatgpt.com'], dirs: [CODEX_STATE_DIR] }, count: 3 });
    const wiring = wiringOf(SANDBOX_ENABLED_CONDITION, codex, entry(AGY));
    const text = formatRecipes(det, wiring);
    assert.deepEqual(det, snapshot);
    assert.deepEqual(recommendRecipe(det), recommendRecipe(snapshot));
    assert.equal(recommendRecipe(det).recipe, 'council');
    assert.equal(planRecipe('reviewed', det).dispatch[0].backend, CODEX);
    assert.equal(planRecipe('council', det).dispatch[0].backend, CODEX);
    assert.equal(resolveActivityRecipe({ config: REVIEW_CONFIG, readiness: det, activity: 'plan-execution', slot: 'review' }).recipe, 'reviewed');
    assert.ok(composeActiveRecipeLine({ config: REVIEW_CONFIG, source: 'fixture' }, det).includes('codex-review'));
    assert.ok(requiredBackendsForConfiguredRecipe({ config: REVIEW_CONFIG, readiness: det }).backends.includes('codex'));
    assert.deepEqual(usedBridges(REVIEW_CONFIG, det), [{ bridge: CODEX, roles: ['review'] }]);
    const vocabulary = [READY, NEEDS_SKILL, NEEDS_CLI, NEEDS_CREDENTIALS, DEGRADED];
    assert.deepEqual(vocabulary, ['ready', 'needs-skill', 'needs-cli', 'needs-credentials', 'degraded']);
    for (const state of ['wired', UNWIRED, UNCHECKED]) assert.ok(!vocabulary.includes(state));
    const recommended = `recommended here: council — Council available, Reviewed the everyday default · not wired: codex (review) — ${WIRING_ROUTE}`;
    const missing = `  not wired: codex — missing excludedCommands [${CODEX_REVIEW_EXCLUSION}]; allowedDomains [chatgpt.com]; allowWrite [${CODEX_STATE_DIR}]; ${SANDBOX_ENABLED_CONDITION}; ${WIRING_ROUTE}`;
    assert.ok(text.split('\n').includes(recommended));
    assert.ok(text.split('\n').includes(missing));
    assert.ok(text.indexOf(recommended) < text.indexOf(missing) && text.indexOf(missing) < text.indexOf('plan for the current environment:'));
    assert.ok(text.split('\n').includes('  Council: codex review, agy review'));
    const dirsOnly = wiringOf(SANDBOX_ENABLED_CONDITION, entry(CODEX, { ...codex, missing: { excludedCommands: [], hosts: [], dirs: [CODEX_STATE_DIR] }, count: 1 }), entry(AGY));
    assert.ok(formatRecipes(det, dirsOnly).split('\n').includes(`  not wired: codex — missing allowWrite [${CODEX_STATE_DIR}]; ${SANDBOX_ENABLED_CONDITION}; ${WIRING_ROUTE}`));
    const unchecked = wiringOf(UNCHECKED_CONDITION, ...[CODEX, AGY].map((bridge) => entry(bridge, { state: UNCHECKED, review: UNCHECKED, reason: BOOM })));
    const uncheckedText = formatRecipes(det, unchecked);
    for (const alias of ['codex', 'agy']) assert.ok(uncheckedText.split('\n').includes(`  unchecked: ${alias} — ${BOOM}`));
    assert.doesNotMatch(formatRecipes(det, wiringOf(SANDBOX_ENABLED_CONDITION, entry(CODEX), entry(AGY))), /not wired:|unchecked:/);
    assert.equal(formatRecipes(det), formatRecipes(det, null));
  });
});

describe('spec:velocity-profile/S19 — CLI wiring over an installed ready codex fixture', () => {
  it('enabled sandbox shares the not-wired status across status-line, JSON and recipes output', (t) => {
    const { run } = makeWiringCliFixture(t);
    const status = run('--status-line');
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout.split('\n').length, 2, 'exactly one line and its trailing newline');
    const line = status.stdout.slice(0, -1);
    assert.ok(line.includes('codex ✗ not wired — 1 sandbox entr(ies) missing'));
    assert.ok(line.includes(`Reviewed available (via codex) · not wired: codex (review) — ${WIRING_ROUTE}`));
    assert.ok(line.includes(`${RECIPES_POINTER} · sandbox: ${SANDBOX_ENABLED_CONDITION} · autonomy: `));
    const json = run('--json');
    assert.equal(json.status, 0, json.stderr);
    const report = JSON.parse(json.stdout);
    assert.equal(report.statusLine, line);
    assert.equal(report.wiring.bridges[0].bridge, CODEX);
    assert.equal(report.wiring.bridges[0].state, UNWIRED);
    assert.equal(report.wiring.bridges[0].count, 1);
    const recipes = run();
    assert.equal(recipes.status, 0, recipes.stderr);
    assert.ok(recipes.stdout.split('\n').includes(`  not wired: codex — missing allowWrite [${CODEX_STATE_DIR}]; ${SANDBOX_ENABLED_CONDITION}; ${WIRING_ROUTE}`));
  });
  it('sandbox without enabled keeps ready and says ready means installed', (t) => {
    const { sandbox, settingsPath, run } = makeWiringCliFixture(t);
    writeFileSync(settingsPath, JSON.stringify({ sandbox: { excludedCommands: sandbox.excludedCommands, network: sandbox.network } }));
    const status = run('--status-line');
    assert.equal(status.status, 0, status.stderr);
    assert.ok(status.stdout.includes('codex ✓ ready'));
    assert.ok(status.stdout.includes(` · sandbox: ${SANDBOX_NOT_ENABLED_CONDITION}`));
  });
  it('enabled sandbox with local bypassPermissions renders unchecked and names the mode', (t) => {
    const { root, run } = makeWiringCliFixture(t);
    writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
    const status = run('--status-line');
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /codex ✗ unchecked — [^·]*bypassPermissions/);
  });
  it('malformed settings render unchecked with exit 0', (t) => {
    const { settingsPath, run } = makeWiringCliFixture(t);
    writeFileSync(settingsPath, '{ not json');
    const status = run('--status-line');
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /codex ✗ unchecked — /);
  });
});

describe('the autonomy segment rides EVERY machine-composed surface (review-recipes-r01-major-01, Segment B)', () => {
  it('buildReport statusLine carries the SAME autonomy segment when the facts are supplied', () => {
    const det = detect(READY, READY);
    const facts = { source: 'none', activities: { 'plan-authoring': { autonomy: 'prompt' }, 'plan-execution': { autonomy: 'prompt' } }, renderState: null };
    const report = buildReport(det, null, facts);
    assert.match(report.statusLine, /· autonomy: /, 'the --json envelope must not expose a stale status line');
    assert.equal(report.statusLine, composeStatusLine(det, report.recommendation, null, facts));
  });

  it('composeActiveRecipeLine surfaces a MALFORMED policy loudly on the line', () => {
    const det = detect(READY, READY);
    const line = composeActiveRecipeLine({ config: {}, source: 'none' }, det, { error: 'docs/ai/autonomy.json: malformed JSON\n(x)' });
    assert.ok(!line.includes('\n'), 'still exactly one line');
    assert.match(line, /autonomy: MALFORMED policy — docs\/ai\/autonomy\.json: malformed JSON \(x\)/, 'never a silent drop of the STOP signal');
  });
});

describe('composeAutonomyFacts — the fact source behind the autonomy segments (AD-044 Plan 4)', () => {
  const makeCwd = () => {
    const root = mkdtempSync(join(tmpdir(), 'autonomy-facts-'));
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    return root;
  };

  it('no policy file → source none, computed defaults, no render check', async () => {
    const root = makeCwd();
    const facts = await composeAutonomyFacts(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(facts.source, 'none');
    assert.equal(facts.renderState, null);
    assert.equal(facts.activities['plan-execution'].autonomy, 'prompt');
    assert.equal(facts.redlines.commit, 'ask');
  });

  it('the SPARSE defaults-equivalent seed reads as computed defaults — never a false DRIFT (codex, Segment B)', async () => {
    const root = makeCwd();
    writeFileSync(join(root, 'docs', 'ai', 'autonomy.json'), '{ "_README": "note" }\n');
    const facts = await composeAutonomyFacts(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(facts.source, 'docs/ai/autonomy.json');
    assert.equal(facts.defaultsEquivalent, true);
    assert.equal(facts.renderState, null, 'no render check until real policy content is declared');
  });

  it('a REAL declared policy with NO rendered settings → renderState DRIFT', async () => {
    const root = makeCwd();
    writeFileSync(join(root, 'docs', 'ai', 'autonomy.json'), JSON.stringify({ 'plan-execution': { autonomy: 'sandbox' } }));
    const facts = await composeAutonomyFacts(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(facts.source, 'docs/ai/autonomy.json');
    assert.match(facts.renderState, /^DRIFT/);
  });

  it('a REAL declared policy whose render matches the live settings → renderState in sync', async () => {
    const root = makeCwd();
    writeFileSync(
      join(root, 'docs', 'ai', 'autonomy.json'),
      JSON.stringify({ 'plan-authoring': { autonomy: 'sandbox' }, 'plan-execution': { autonomy: 'sandbox' } }),
    );
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({
        sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
        permissions: { defaultMode: 'acceptEdits', ask: ['Bash(git commit:*)', 'Bash(git push:*)', 'Bash(npm publish:*)'] },
      }),
    );
    // The harness probe is injected: the render check now reads the installed build, so without a
    // seam this fixture would read "in sync" or "DRIFT" depending on whether the machine running the
    // suite happens to have a credential-capable harness installed.
    const facts = await composeAutonomyFacts(root, { findOnPath: () => ({ bin: 'claude', state: 'missing', path: null }) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(facts.renderState, 'in sync');
  });

  it('a REAL declared policy + UNREADABLE settings → renderState unchecked (loud reason, never a throw)', async () => {
    const root = makeCwd();
    writeFileSync(join(root, 'docs', 'ai', 'autonomy.json'), JSON.stringify({ 'plan-execution': { autonomy: 'sandbox' } }));
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), '{ not json');
    const facts = await composeAutonomyFacts(root);
    rmSync(root, { recursive: true, force: true });
    assert.match(facts.renderState, /^unchecked \(/);
  });

  it('a MALFORMED policy → { error }, never a throw', async () => {
    const root = makeCwd();
    writeFileSync(join(root, 'docs', 'ai', 'autonomy.json'), '{ not json');
    const facts = await composeAutonomyFacts(root);
    rmSync(root, { recursive: true, force: true });
    assert.match(facts.error, /malformed JSON/);
  });

  it('an EXPLICIT declared-defaults policy is NOT the seed — the render check runs (structural seed detection)', async () => {
    const root = makeCwd();
    writeFileSync(join(root, 'docs', 'ai', 'autonomy.json'), JSON.stringify({ 'plan-execution': { autonomy: 'prompt' } }));
    const facts = await composeAutonomyFacts(root);
    rmSync(root, { recursive: true, force: true });
    assert.ok(!facts.defaultsEquivalent, 'resolved-equality must not conflate a real declaration with the _README-only seed');
    assert.ok(facts.renderState != null, 'the render-sync state is computed for a real declaration');
  });

  it('resolves the PROJECT ROOT from a subdirectory — the paste surfaces never read a subdir-relative policy', async () => {
    // The report-footer invokes --status-line without --cwd; an agent shell sitting in a subdir
    // must still read the root docs/ai/autonomy.json (codex terminal, Segment B closing).
    const root = makeCwd();
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', 'autonomy.json'), JSON.stringify({ 'plan-execution': { autonomy: 'sandbox' } }));
    const facts = await composeAutonomyFacts(join(root, 'docs', 'ai'));
    rmSync(root, { recursive: true, force: true });
    assert.notEqual(facts.source, 'none', 'the root policy is found from the subdirectory');
    assert.equal(facts.activities['plan-execution'].autonomy, 'sandbox', 'the DECLARED root level renders, not a computed default');
  });
});

describe('composeActiveRecipeLine — the per-activity autonomy level beside the recipe cells (AD-044 Plan 4)', () => {
  it('an omitted autonomy param keeps the line byte-identical; supplied facts add "; autonomy <level>" per cell', () => {
    const det = detect(READY, READY);
    const base = composeActiveRecipeLine({ config: {}, source: 'none' }, det);
    assert.equal(composeActiveRecipeLine({ config: {}, source: 'none' }, det, null), base);
    const withLevels = composeActiveRecipeLine({ config: {}, source: 'none' }, det, {
      activities: { 'plan-authoring': { autonomy: 'sandbox' }, 'plan-execution': { autonomy: 'prompt' } },
    });
    assert.ok(!withLevels.includes('\n'), 'still exactly one line');
    assert.match(withLevels, /plan-authoring\.review = [a-z]+ \(computed default; autonomy sandbox\)/);
    assert.match(withLevels, /plan-execution\.review = [a-z]+ \(computed default; autonomy prompt\)/);
  });
});

describe('buildReport — additive statusLine field', () => {
  it('statusLine equals composeStatusLine over the same detection + recommendation', () => {
    const det = detect(READY, NEEDS_SKILL);
    const report = buildReport(det);
    assert.equal(report.statusLine, composeStatusLine(det, report.recommendation));
  });
});

describe('recipes.mjs CLI — read-only, exit 0', () => {
  it('prints the recipes and exits 0', () => {
    const out = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
    for (const title of RECIPE_TITLES) assert.match(out, new RegExp(title));
  });
  it('--json emits parseable JSON with the recommendation + the additive statusLine', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed.recipes));
    assert.ok(parsed.recommendation && typeof parsed.recommendation.recipe === 'string');
    assert.equal(typeof parsed.statusLine, 'string');
    assert.match(parsed.statusLine, /^backends: /);
  });
});

describe('recipes.mjs CLI — --status-line + strict args (no silent fallthrough)', () => {
  // Isolate the host: a bridge env var or a real ~/.config settings file would append a `· settings:`
  // suffix and break the exact-line assertions.
  const cleanEnv = () => {
    const env = { ...process.env, PATH: '', XDG_CONFIG_HOME: join(HERE, '__no_xdg_fixture__') };
    for (const k of ['CODEX_SERVICE_TIER', 'CODEX_HARD_TIMEOUT', 'CODEX_REVIEW_MAX_TOTAL_BYTES', 'AGY_HARD_TIMEOUT', 'AGY_REVIEW_ALLOW_ADDDIR']) delete env[k];
    return env;
  };

  it('--status-line emits exactly one line matching the composed contract (incl. autonomy + posture)', () => {
    // cwd = system temp (no docs/ai), so the line stays hermetic and states computed defaults honestly.
    const out = execFileSync(process.execPath, [SCRIPT, '--status-line'], { encoding: 'utf8', env: cleanEnv(), cwd: tmpdir() });
    assert.ok(out.endsWith('\n'), 'ends with the single trailing newline');
    const line = out.slice(0, -1);
    assert.ok(!line.includes('\n'), 'exactly one line');
    assert.match(line, /^backends: /);
    assert.match(line, / — run \/agent-workflow-kit backends · recipes: /);
    assert.ok(line.includes(`${RECIPES_POINTER} · sandbox: ${SANDBOX_NOT_ENABLED_CONDITION} · autonomy: `));
    assert.match(line, /autonomy: plan-authoring=prompt, plan-execution=prompt \(computed defaults — no policy file; declare with \/agent-workflow-kit set-autonomy\)/);
    // The D5 posture tail: composed from the bundled manifests' pins; cleanEnv strips the tier
    // knob, so the codex tier renders the pinned standard default.
    assert.match(line, /· posture: codex model=gpt-6\.1-sol effort=high tier=standard · agy model=Gemini 3\.8 Flash \(High\)$/);
  });

  it('rejects an unknown/mistyped argument loudly — never the silent multi-line human render', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--status-lien'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown argument: --status-lien/);
    assert.equal(r.stdout, '');
  });

  it('rejects --json + --status-line together (each owns stdout whole)', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--json', '--status-line'], { encoding: 'utf8', env: cleanEnv() });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /mutually exclusive/);
  });

  it('--help mentions the --status-line mode', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
    assert.match(out, /--status-line/);
  });
});
