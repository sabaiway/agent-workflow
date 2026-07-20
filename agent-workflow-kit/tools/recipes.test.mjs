import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

// ── ACTIVITIES + resolveActivityRecipe (the activity-procedures resolver) ───────────

describe('ACTIVITIES — the v1 activity/slot table', () => {
  it('declares exactly plan-authoring (review) and plan-execution (execute, review)', () => {
    assert.deepEqual(Object.keys(ACTIVITIES), ['plan-authoring', 'plan-execution']);
    assert.deepEqual(Object.keys(ACTIVITIES['plan-authoring'].slots), ['review']);
    assert.deepEqual(Object.keys(ACTIVITIES['plan-execution'].slots), ['execute', 'review']);
  });

  it('every slot type maps to a SLOT_RECIPES list, and every listed recipe is a real RECIPE id', () => {
    const recipeIds = new Set(RECIPES.map((r) => r.id));
    for (const def of Object.values(ACTIVITIES)) {
      for (const slotType of Object.values(def.slots)) {
        assert.ok(Array.isArray(SLOT_RECIPES[slotType]), `slot type "${slotType}" has a recipe list`);
        for (const id of SLOT_RECIPES[slotType]) assert.ok(recipeIds.has(id), `"${id}" is a real recipe`);
      }
    }
  });

  it('review composes solo|reviewed|council; execute composes solo|delegated', () => {
    assert.deepEqual(SLOT_RECIPES.review, ['solo', 'reviewed', 'council']);
    assert.deepEqual(SLOT_RECIPES.execute, ['solo', 'delegated']);
  });
});

// The activity/slot drift guard — the JS ACTIVITIES table must match the engine canon's parseable
// `Slots:` lines (the kit parses ONLY that line; the steps are rendered verbatim). Clones the
// engine↔kit recipe-name parity pattern above.
describe('engine↔kit activity/slot parity — ACTIVITIES matches procedures.md `Slots:` lines', () => {
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

describe('resolveActivityRecipe — defaults (config silent), readiness-aware', () => {
  it('review default is Reviewed when a backend is ready — NOT Council (recommendRecipe is not reused)', () => {
    const r = resolveActivityRecipe({ readiness: detect(READY, READY), activity: 'plan-authoring', slot: 'review' });
    assert.equal(r.recipe, 'reviewed');
    assert.equal(r.source, 'default');
    assert.equal(r.degradedFrom, null);
    // sanity: recommendRecipe DOES return council for the same detection — the default must not.
    assert.equal(recommendRecipe(detect(READY, READY)).recipe, 'council');
  });

  it('review default is Solo when no backend is ready', () => {
    const r = resolveActivityRecipe({ readiness: detect(NEEDS_SKILL, NEEDS_SKILL), activity: 'plan-authoring', slot: 'review' });
    assert.equal(r.recipe, 'solo');
    assert.equal(r.source, 'default');
  });

  it('execute default is Solo even when codex is ready (Delegated is opt-in)', () => {
    const r = resolveActivityRecipe({ readiness: detect(READY, READY), activity: 'plan-execution', slot: 'execute' });
    assert.equal(r.recipe, 'solo');
    assert.equal(r.source, 'default');
  });
});

describe('resolveActivityRecipe — config-driven, graceful degradation', () => {
  const config = { 'plan-authoring': { review: 'council' }, 'plan-execution': { execute: 'delegated', review: 'reviewed' } };

  it('config review=council holds when both backends are ready', () => {
    const r = resolveActivityRecipe({ config, readiness: detect(READY, READY), activity: 'plan-authoring', slot: 'review' });
    assert.equal(r.recipe, 'council');
    assert.equal(r.source, 'config');
    assert.equal(r.degradedFrom, null);
    assert.equal(r.overrideUnsatisfied, false);
  });

  it('config review=council degrades GRACEFULLY to Reviewed with one backend (not a loud override)', () => {
    const r = resolveActivityRecipe({ config, readiness: detect(READY, NEEDS_SKILL), activity: 'plan-authoring', slot: 'review' });
    assert.equal(r.recipe, 'reviewed');
    assert.equal(r.degradedFrom, 'council');
    assert.equal(r.overrideUnsatisfied, false);
    assert.match(r.reason, /not installed|council/i);
  });

  it('config execute=delegated holds when codex is ready', () => {
    const r = resolveActivityRecipe({ config, readiness: detect(READY, NEEDS_SKILL), activity: 'plan-execution', slot: 'execute' });
    assert.equal(r.recipe, 'delegated');
    assert.equal(r.degradedFrom, null);
  });

  it('config execute=delegated degrades to Solo when codex is not ready (agy cannot execute)', () => {
    const r = resolveActivityRecipe({ config, readiness: detect(NEEDS_SKILL, READY), activity: 'plan-execution', slot: 'execute' });
    assert.equal(r.recipe, 'solo');
    assert.equal(r.degradedFrom, 'delegated');
    assert.equal(r.overrideUnsatisfied, false);
    assert.match(r.reason, /execute/i);
  });
});

describe('resolveActivityRecipe — override precedence + LOUD degradation', () => {
  it('an override beats the config entry', () => {
    const config = { 'plan-authoring': { review: 'solo' } };
    const r = resolveActivityRecipe({ config, readiness: detect(READY, READY), activity: 'plan-authoring', slot: 'review', override: 'council' });
    assert.equal(r.recipe, 'council');
    assert.equal(r.source, 'override');
  });

  it('an unsatisfiable override degrades LOUDLY (overrideUnsatisfied = true)', () => {
    const r = resolveActivityRecipe({ readiness: detect(READY, NEEDS_SKILL), activity: 'plan-authoring', slot: 'review', override: 'council' });
    assert.equal(r.recipe, 'reviewed');
    assert.equal(r.degradedFrom, 'council');
    assert.equal(r.overrideUnsatisfied, true, 'an explicit override that cannot be satisfied is flagged loud');
  });

  it('a satisfiable override is not flagged', () => {
    const r = resolveActivityRecipe({ readiness: detect(READY, READY), activity: 'plan-authoring', slot: 'review', override: 'council' });
    assert.equal(r.recipe, 'council');
    assert.equal(r.overrideUnsatisfied, false);
  });
});

describe('resolveActivityRecipe — defensive validity + purity', () => {
  it('throws on an unknown activity', () => {
    assert.throws(() => resolveActivityRecipe({ readiness: detect(READY, READY), activity: 'nope', slot: 'review' }), /unknown activity/);
  });
  it('throws on an unknown slot for the activity', () => {
    assert.throws(
      () => resolveActivityRecipe({ readiness: detect(READY, READY), activity: 'plan-authoring', slot: 'execute' }),
      /unknown slot/,
    );
  });
  it('throws on a recipe invalid for the slot (e.g. delegated in a review slot)', () => {
    assert.throws(
      () => resolveActivityRecipe({ readiness: detect(READY, READY), activity: 'plan-authoring', slot: 'review', override: 'delegated' }),
      /invalid recipe/,
    );
  });
  it('does not mutate the detection input', () => {
    const det = detect(READY, READY);
    const snapshot = JSON.parse(JSON.stringify(det));
    resolveActivityRecipe({ readiness: det, activity: 'plan-execution', slot: 'review' });
    assert.deepEqual(det, snapshot);
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
    const declared = composeStatusLine(det, { clause: 'x' }, null, {
      source: 'docs/ai/autonomy.json',
      activities: { 'plan-authoring': { autonomy: 'prompt' }, 'plan-execution': { autonomy: 'sandbox' } },
      renderState: 'in sync',
    });
    assert.equal(declared, `${base} · autonomy: plan-authoring=prompt, plan-execution=sandbox (declared; render in sync)`);
    const defaults = composeStatusLine(det, { clause: 'x' }, null, {
      source: 'none',
      activities: { 'plan-authoring': { autonomy: 'prompt' }, 'plan-execution': { autonomy: 'prompt' } },
      renderState: null,
    });
    assert.match(defaults, /autonomy: .*\(computed defaults — no policy file; declare with \/agent-workflow-kit set-autonomy\)$/);
    const sparse = composeStatusLine(det, { clause: 'x' }, null, {
      source: 'docs/ai/autonomy.json',
      defaultsEquivalent: true,
      activities: { 'plan-authoring': { autonomy: 'prompt' }, 'plan-execution': { autonomy: 'prompt' } },
      renderState: null,
    });
    assert.match(sparse, /\(declared, defaults-equivalent — computed defaults apply; declare levels with \/agent-workflow-kit set-autonomy\)$/, 'the sparse seed never reads as DRIFT');
  });

  it('autonomy segment: a MALFORMED policy surfaces loudly and never breaks the one-line contract', () => {
    const det = detect(READY, READY);
    const line = composeStatusLine(det, { clause: 'x' }, null, { error: 'docs/ai/autonomy.json: malformed JSON\n(details)' });
    assert.ok(!line.includes('\n'), 'a newline-carrying error message never breaks the single line');
    assert.match(line, /autonomy: MALFORMED policy — docs\/ai\/autonomy\.json: malformed JSON \(details\)/);
  });
});

describe('the autonomy segment rides EVERY machine-composed surface (review-recipes-r01-major-01, Segment B)', () => {
  it('buildReport statusLine carries the SAME autonomy segment when the facts are supplied', () => {
    const det = detect(READY, READY);
    const facts = {
      source: 'none',
      activities: { 'plan-authoring': { autonomy: 'prompt' }, 'plan-execution': { autonomy: 'prompt' } },
      renderState: null,
    };
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
    for (const title of ['Solo', 'Reviewed', 'Council', 'Delegated']) assert.match(out, new RegExp(title));
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
  // Isolate the host: --status-line now reads the bridge-settings snapshot (env > file), so a host with
  // a bridge env var set OR a real ~/.config settings file would otherwise append a `· settings:` suffix
  // and break the exact-line assertions. Point XDG at an empty dir and strip every bridge setting env var.
  const cleanEnv = () => {
    const env = { ...process.env, PATH: '', XDG_CONFIG_HOME: join(HERE, '__no_xdg_fixture__') };
    for (const k of ['CODEX_SERVICE_TIER', 'CODEX_HARD_TIMEOUT', 'CODEX_REVIEW_MAX_TOTAL_BYTES', 'AGY_HARD_TIMEOUT', 'AGY_REVIEW_ALLOW_ADDDIR']) delete env[k];
    return env;
  };

  it('--status-line emits exactly one line matching the composed contract (incl. autonomy + posture)', () => {
    // cwd = system temp (no docs/ai): the autonomy segment must state the computed-defaults origin
    // honestly — and the line stays hermetic (this repo's own policy file never leaks into the pin).
    const out = execFileSync(process.execPath, [SCRIPT, '--status-line'], { encoding: 'utf8', env: cleanEnv(), cwd: tmpdir() });
    assert.ok(out.endsWith('\n'), 'ends with the single trailing newline');
    const line = out.slice(0, -1);
    assert.ok(!line.includes('\n'), 'exactly one line');
    assert.match(line, /^backends: /);
    assert.match(line, / — run \/agent-workflow-kit backends · recipes: /);
    assert.match(line, / — see \/agent-workflow-kit recipes · autonomy: /);
    assert.match(line, /autonomy: plan-authoring=prompt, plan-execution=prompt \(computed defaults — no policy file; declare with \/agent-workflow-kit set-autonomy\)/);
    // The D5 posture tail: composed from the bundled manifests' pins; cleanEnv strips the tier
    // knob, so the codex tier renders the pinned standard default.
    assert.match(line, /· posture: codex model=gpt-5\.6-sol effort=xhigh tier=standard · agy model=Gemini 3\.1 Pro \(High\)$/);
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
