import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITIES, SLOT_RECIPES } from '../tools/recipes.mjs';
import { MIRROR_TEMPLATE_FILES, TEMPLATE_HARD_EXCLUDES } from '../../scripts/sync-mirrors.mjs';

// The composition root deploys docs/ai/ from MEMORY's templates when memory is healthy, and from its
// OWN bundled fallback templates otherwise (SKILL.md). For a deployment to be identical on both paths,
// the shared templates must be byte-identical across the two packages. This guard pins that parity for
// the WHOLE mirror manifest exported by scripts/sync-mirrors.mjs — the sync script and this guard
// govern the SAME explicit set, so drift cannot hide between them — and validates the two JSON seeds
// against the kit's schemas (so a malformed seed can never ship).
//
// Dev-only repo test (test/ is outside the package `files` whitelist — not shipped in the tarball;
// the cross-package import of the tracked repo-root script follows lineage-head-drift.test.mjs).
const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MEMORY_ROOT = resolve(KIT_ROOT, '..', 'agent-workflow-memory');
const KIT_TEMPLATES = join(KIT_ROOT, 'references', 'templates');
const MEMORY_TEMPLATES = join(MEMORY_ROOT, 'references', 'templates');

describe('kit ⟷ memory template parity — every manifest-listed template byte-identical', () => {
  for (const name of MIRROR_TEMPLATE_FILES) {
    it(`${name} is byte-identical in both packages`, () => {
      const kit = join(KIT_TEMPLATES, name);
      const memory = join(MEMORY_TEMPLATES, name);
      assert.ok(existsSync(kit), `kit ships references/templates/${name}`);
      assert.ok(existsSync(memory), `memory ships references/templates/${name}`);
      assert.equal(
        readFileSync(kit, 'utf8'),
        readFileSync(memory, 'utf8'),
        `${name} drifted between the kit fallback copy and the memory copy — the two deploy paths would diverge (re-sync: node scripts/sync-mirrors.mjs)`,
      );
    });
  }
});

describe('the mirror manifest itself — reverse pins (the sync and this guard govern ONE set)', () => {
  it('keeps the load-bearing seeds IN the manifest', () => {
    for (const required of ['AGENTS.md', 'orchestration.json', 'gates.json']) {
      assert.ok(
        MIRROR_TEMPLATE_FILES.includes(required),
        `${required} must stay in the mirror manifest — dropping it would silently stop both the sync and this parity guard`,
      );
    }
  });

  it('never gains a hard-excluded (deliberately divergent) template', () => {
    for (const required of ['agent_rules.md', 'decisions.md']) {
      assert.ok(
        TEMPLATE_HARD_EXCLUDES.includes(required),
        `${required} must stay hard-excluded — it is deliberately divergent (AD-038); its shared regions are owned by template-region-parity.test.mjs / lens-mirror.test.mjs`,
      );
      assert.ok(
        !MIRROR_TEMPLATE_FILES.includes(required),
        `${required} must never enter the whole-file mirror manifest — a full-file sync would clobber the deliberate divergence`,
      );
    }
  });
});

describe('gates.json seed — strict JSON valid against the kit runner schema', () => {
  const raw = readFileSync(join(KIT_TEMPLATES, 'gates.json'), 'utf8');

  it('parses as strict JSON (no comments — the runner JSON.parses it)', () => {
    assert.doesNotThrow(() => JSON.parse(raw));
  });

  it('validates against the runner schema and ships an EMPTY gates list + a string _README', async () => {
    const { validateDeclaration } = await import('../tools/run-gates.mjs');
    const parsed = JSON.parse(raw);
    assert.equal(typeof parsed._README, 'string', 'the onboarding _README is a string');
    assert.deepEqual(validateDeclaration(parsed), [], 'the seed declares no gates — a project declares its own');
  });

  it('the _README states the bash cmd contract and the trust posture', () => {
    const readme = JSON.parse(raw)._README;
    assert.match(readme, /bash/i, 'names the bash execution shell');
    assert.match(readme, /not a sandbox/i, 'states the trust posture');
    assert.match(readme, /never who executes/i, 'states the no-lane/model/routing axis');
  });
});

describe('orchestration.json seed — strict JSON valid against the kit schema', () => {
  const raw = readFileSync(join(KIT_TEMPLATES, 'orchestration.json'), 'utf8');

  it('parses as strict JSON (no comments — the kit JSON.parses it at deploy)', () => {
    assert.doesNotThrow(() => JSON.parse(raw));
  });

  it('every activity/slot/recipe is valid, _README is a string, no unknown keys', () => {
    const config = JSON.parse(raw);
    assert.equal(typeof config._README, 'string', 'the onboarding _README is a string (allowed + ignored)');
    for (const [activity, slots] of Object.entries(config)) {
      if (activity === '_README') continue;
      assert.ok(ACTIVITIES[activity], `"${activity}" is a known activity`);
      for (const [slot, recipe] of Object.entries(slots)) {
        const slotType = ACTIVITIES[activity].slots[slot];
        assert.ok(slotType, `"${slot}" is a valid slot of "${activity}"`);
        assert.ok(SLOT_RECIPES[slotType].includes(recipe), `recipe "${recipe}" is valid for the ${slotType} slot`);
      }
    }
  });

  it('the seeded default is conservative — every configured slot is solo (opting into a backend is a conscious edit)', () => {
    const config = JSON.parse(raw);
    for (const [activity, slots] of Object.entries(config)) {
      if (activity === '_README') continue;
      for (const recipe of Object.values(slots)) assert.equal(recipe, 'solo', `${activity} ships solo by default`);
    }
  });
});
