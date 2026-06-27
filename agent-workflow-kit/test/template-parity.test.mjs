import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITIES, SLOT_RECIPES } from '../tools/recipes.mjs';

// The composition root deploys docs/ai/ from MEMORY's templates when memory is healthy, and from its
// OWN bundled fallback templates otherwise (SKILL.md). For a deployment to be identical on both paths,
// the shared templates must be byte-identical across the two packages. This guard pins that parity for
// the entry-point template AND the orchestration.json config seed (AD-019), and validates the seed
// against the kit's schema (so a malformed seed can never ship).
//
// Dev-only repo test (test/ is outside the package `files` whitelist — not shipped in the tarball).
const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MEMORY_ROOT = resolve(KIT_ROOT, '..', 'agent-workflow-memory');
const KIT_TEMPLATES = join(KIT_ROOT, 'references', 'templates');
const MEMORY_TEMPLATES = join(MEMORY_ROOT, 'references', 'templates');

const SHARED_TEMPLATES = ['AGENTS.md', 'orchestration.json'];

describe('kit ⟷ memory template parity — byte-identical shared seeds', () => {
  for (const name of SHARED_TEMPLATES) {
    it(`${name} is byte-identical in both packages`, () => {
      const kit = join(KIT_TEMPLATES, name);
      const memory = join(MEMORY_TEMPLATES, name);
      assert.ok(existsSync(kit), `kit ships references/templates/${name}`);
      assert.ok(existsSync(memory), `memory ships references/templates/${name}`);
      assert.equal(
        readFileSync(kit, 'utf8'),
        readFileSync(memory, 'utf8'),
        `${name} drifted between the kit fallback copy and the memory copy — the two deploy paths would diverge`,
      );
    });
  }
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
