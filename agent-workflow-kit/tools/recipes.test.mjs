import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  RECIPES,
  BACKEND_ROLES,
  BACKEND_META,
  DISPLAY_ALIASES,
  planRecipe,
  recommendRecipe,
  formatRecipes,
} from './recipes.mjs';
import { READY, NEEDS_SKILL, NEEDS_CLI, NEEDS_CREDENTIALS, DEGRADED } from './detect-backends.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'recipes.mjs');
const REPO_ROOT = join(HERE, '..', '..');

const CODEX = 'codex-cli-bridge';
const AGY = 'antigravity-cli-bridge';
const RECIPE_IDS = ['solo', 'reviewed', 'council', 'delegated'];

// A synthetic detector fixture — the planner only consumes { name, readiness } off each entry, built
// from the REAL readiness vocabulary (no `missing` — that is a probe-axis state, not a readiness).
const detect = (codexReadiness, agyReadiness) => [
  { name: CODEX, readiness: codexReadiness },
  { name: AGY, readiness: agyReadiness },
];

const readManifest = (name) => JSON.parse(readFileSync(join(REPO_ROOT, name, 'capability.json'), 'utf8'));

// ── RECIPES shape ────────────────────────────────────────────────────────────────

describe('RECIPES — the four named patterns', () => {
  it('is exactly the four recipes, in lattice order', () => {
    assert.deepEqual(RECIPES.map((r) => r.id), RECIPE_IDS);
  });

  it('each recipe declares a role (or null for Solo), a minBackends count, and a degradation target', () => {
    for (const r of RECIPES) {
      assert.ok(typeof r.id === 'string' && r.id.length > 0);
      assert.ok('role' in r, `${r.id} declares a role key`);
      assert.ok(Number.isInteger(r.minBackends), `${r.id} declares minBackends`);
      assert.ok('degradesTo' in r, `${r.id} declares a degradation target`);
    }
  });

  it('Solo is the floor (no role, no backend, no degradation target)', () => {
    const solo = RECIPES.find((r) => r.id === 'solo');
    assert.equal(solo.role, null);
    assert.equal(solo.minBackends, 0);
    assert.equal(solo.degradesTo, null);
  });

  it('Reviewed/Council need review; Delegated needs execute; degradation chains terminate at Solo', () => {
    const by = Object.fromEntries(RECIPES.map((r) => [r.id, r]));
    assert.equal(by.reviewed.role, 'review');
    assert.equal(by.reviewed.minBackends, 1);
    assert.equal(by.reviewed.degradesTo, 'solo');
    assert.equal(by.council.role, 'review');
    assert.equal(by.council.minBackends, 2);
    assert.equal(by.council.degradesTo, 'reviewed');
    assert.equal(by.delegated.role, 'execute');
    assert.equal(by.delegated.minBackends, 1);
    assert.equal(by.delegated.degradesTo, 'solo');
  });
});

// ── drift guards ───────────────────────────────────────────────────────────────

describe('role-coverage drift-guard — every recipe role ∈ union of the bridges provides[]', () => {
  it('no recipe demands a role no backend provides', () => {
    const union = new Set([...readManifest(CODEX).provides, ...readManifest(AGY).provides]);
    for (const r of RECIPES) {
      if (r.role !== null) assert.ok(union.has(r.role), `recipe ${r.id} role "${r.role}" is provided by some backend`);
    }
  });
});

describe('BACKEND_ROLES drift-guard — keyed by status.name, equals each bridge provides[]', () => {
  it('is keyed by the manifest names the detector emits (not the display aliases)', () => {
    assert.deepEqual(Object.keys(BACKEND_ROLES).sort(), [AGY, CODEX].sort());
  });
  it('matches each bridge capability.json provides[]', () => {
    assert.deepEqual(BACKEND_ROLES[CODEX], readManifest(CODEX).provides);
    assert.deepEqual(BACKEND_ROLES[AGY], readManifest(AGY).provides);
  });
});

describe('BACKEND_META drift-guard — cost/quota mirror the manifests; agy carries a health advisory', () => {
  it('cost + quota equal each bridge capability.json', () => {
    for (const name of [CODEX, AGY]) {
      const m = readManifest(name);
      assert.equal(BACKEND_META[name].cost, m.cost);
      assert.deepEqual(BACKEND_META[name].quota, m.quota);
    }
  });
  it('the agy health advisory (Issue-001) is present as static project knowledge', () => {
    assert.equal(typeof BACKEND_META[AGY].health, 'string');
    assert.ok(BACKEND_META[AGY].health.length > 0);
    // codex carries no standing health caveat
    assert.ok(!BACKEND_META[CODEX].health);
  });
});

describe('DISPLAY_ALIASES — the manifest-name → human-alias map', () => {
  it('maps both bridges to their short aliases', () => {
    assert.equal(DISPLAY_ALIASES[CODEX], 'codex');
    assert.equal(DISPLAY_ALIASES[AGY], 'agy');
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

  it('the agy health advisory (Issue-001) is consistent between BACKEND_META and the engine narrative', () => {
    // Flatten whitespace so a prose line-wrap (e.g. "substantive\nprompts") doesn't hide the substring.
    const flat = orchestration.replace(/\s+/g, ' ').toLowerCase();
    assert.match(flat, /stall on substantive prompts/, 'the engine narrates the stall advisory');
    assert.match(flat, /issue-001/, 'the engine narrative ties it to Issue-001');
    assert.match(flat, /prefer .?codex/, 'the engine narrates the prefer-codex remedy');
    // BACKEND_META carries the same advisory facts (kit-side), tying the two representations together.
    const health = BACKEND_META[AGY].health.toLowerCase();
    assert.ok(health.includes('stall on substantive prompts') && health.includes('issue-001') && health.includes('codex'));
  });
});

// ── planRecipe ─────────────────────────────────────────────────────────────────

const dispatchBackends = (plan) => plan.dispatch.map((d) => d.backend);
const notesText = (plan) => plan.notes.join(' :: ');

describe('planRecipe — all backends ready', () => {
  const det = detect(READY, READY);

  it('Solo: no degradation, no dispatch', () => {
    const p = planRecipe('solo', det);
    assert.equal(p.effective, 'solo');
    assert.equal(p.degraded, false);
    assert.deepEqual(p.dispatch, []);
  });

  it('Reviewed: picks codex over agy (deterministic tie-break), not degraded', () => {
    const p = planRecipe('reviewed', det);
    assert.equal(p.effective, 'reviewed');
    assert.equal(p.degraded, false);
    assert.deepEqual(dispatchBackends(p), [CODEX]);
    // codex chosen → the agy health caveat is NOT attached
    assert.ok(!notesText(p).includes(BACKEND_META[AGY].health));
  });

  it('Council: both backends review; the agy health caveat + the two-quota note are attached', () => {
    const p = planRecipe('council', det);
    assert.equal(p.effective, 'council');
    assert.equal(p.degraded, false);
    assert.deepEqual(dispatchBackends(p), [CODEX, AGY]);
    assert.ok(notesText(p).includes(BACKEND_META[AGY].health), 'agy health note present when agy is used');
    assert.match(notesText(p), /two backends|both backends|two .*quota/i);
  });

  it('Delegated: codex executes the bounded sub-task', () => {
    const p = planRecipe('delegated', det);
    assert.equal(p.effective, 'delegated');
    assert.equal(p.degraded, false);
    assert.deepEqual(p.dispatch, [{ role: 'execute', backend: CODEX, display: 'codex' }]);
  });
});

describe('planRecipe — codex only (agy needs-skill)', () => {
  const det = detect(READY, NEEDS_SKILL);

  it('Council → Reviewed(codex) with a stated reason', () => {
    const p = planRecipe('council', det);
    assert.equal(p.effective, 'reviewed');
    assert.equal(p.degraded, true);
    assert.equal(p.degradation[0].from, 'council');
    assert.equal(p.degradation[0].to, 'reviewed');
    assert.match(p.degradation[0].reason, /not installed/i);
    assert.deepEqual(dispatchBackends(p), [CODEX]);
  });

  it('Delegated stays Delegated (codex provides execute and is ready)', () => {
    const p = planRecipe('delegated', det);
    assert.equal(p.effective, 'delegated');
    assert.equal(p.degraded, false);
  });

  it('Reviewed → codex', () => {
    assert.deepEqual(dispatchBackends(planRecipe('reviewed', det)), [CODEX]);
  });
});

describe('planRecipe — agy only (codex needs-skill)', () => {
  const det = detect(NEEDS_SKILL, READY);

  it('Council → Reviewed(agy)', () => {
    const p = planRecipe('council', det);
    assert.equal(p.effective, 'reviewed');
    assert.equal(p.degraded, true);
    assert.deepEqual(dispatchBackends(p), [AGY]);
    assert.ok(notesText(p).includes(BACKEND_META[AGY].health), 'agy health note present when agy is the reviewer');
  });

  it('Delegated → Solo (no backend provides execute) with the reason stated', () => {
    const p = planRecipe('delegated', det);
    assert.equal(p.effective, 'solo');
    assert.equal(p.degraded, true);
    assert.match(p.degradation[0].reason, /execute/i);
    assert.deepEqual(p.dispatch, []);
  });

  it('Reviewed → agy', () => {
    assert.deepEqual(dispatchBackends(planRecipe('reviewed', det)), [AGY]);
  });
});

describe('planRecipe — none installed (both needs-skill)', () => {
  const det = detect(NEEDS_SKILL, NEEDS_SKILL);
  for (const id of ['reviewed', 'council', 'delegated']) {
    it(`${id} → Solo, reason names the not-installed bridge skill`, () => {
      const p = planRecipe(id, det);
      assert.equal(p.effective, 'solo');
      assert.equal(p.degraded, true);
      assert.match(p.degradation.map((d) => d.reason).join(' '), /not installed/i);
    });
  }
});

describe('planRecipe — agy degraded (wrapper not on PATH)', () => {
  const det = detect(READY, DEGRADED);

  it('Reviewed → codex (agy not dispatchable); no agy health note (agy unused)', () => {
    const p = planRecipe('reviewed', det);
    assert.equal(p.effective, 'reviewed');
    assert.equal(p.degraded, false);
    assert.deepEqual(dispatchBackends(p), [CODEX]);
    assert.ok(!notesText(p).includes(BACKEND_META[AGY].health));
  });

  it('Council → Reviewed(codex); the degradation reason is the wrapper one (distinct from the health note)', () => {
    const p = planRecipe('council', det);
    assert.equal(p.effective, 'reviewed');
    assert.equal(p.degraded, true);
    assert.match(p.degradation[0].reason, /PATH|wrapper/i);
    assert.deepEqual(dispatchBackends(p), [CODEX]);
  });
});

describe('planRecipe — purity + determinism', () => {
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
    for (const det of [
      detect(READY, READY),
      detect(READY, NEEDS_SKILL),
      detect(NEEDS_SKILL, NEEDS_SKILL),
      detect(NEEDS_CREDENTIALS, DEGRADED),
    ]) {
      assert.ok(recommendRecipe(det).clause.trim().length > 0);
    }
  });

  it('present-but-not-ready tie-break is deterministic (codex before agy) regardless of detection order', () => {
    // Both present-but-not-ready at the SAME readiness rank → the remedy must name codex, not whichever
    // the detector happened to emit first (mirrors the dispatch-path priority).
    const forward = recommendRecipe([{ name: CODEX, readiness: DEGRADED }, { name: AGY, readiness: DEGRADED }]);
    const reversed = recommendRecipe([{ name: AGY, readiness: DEGRADED }, { name: CODEX, readiness: DEGRADED }]);
    assert.equal(forward.clause, reversed.clause, 'order-independent');
    assert.match(forward.clause, /codex/, 'ties break to codex');
  });
});

// ── CLI / formatRecipes ──────────────────────────────────────────────────────────

describe('formatRecipes — deterministic advisor text', () => {
  it('renders the four recipes + a recommendation deterministically', () => {
    const det = detect(READY, NEEDS_SKILL);
    const once = formatRecipes(det);
    assert.equal(once, formatRecipes(det), 'same detection → identical text');
    for (const title of ['Solo', 'Reviewed', 'Council', 'Delegated']) assert.match(once, new RegExp(title));
  });
});

describe('recipes.mjs CLI — read-only, exit 0', () => {
  it('prints the recipes and exits 0', () => {
    const out = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
    for (const title of ['Solo', 'Reviewed', 'Council', 'Delegated']) assert.match(out, new RegExp(title));
  });
  it('--json emits parseable JSON with the recommendation', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed.recipes));
    assert.ok(parsed.recommendation && typeof parsed.recommendation.recipe === 'string');
  });
});
