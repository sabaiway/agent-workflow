import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractLensRegion, renderLens, parseLensPriors } from '../tools/lens-region.mjs';

// Render-parity guard (the slot-render mesh, post-AD-041). The planning/review/process-fidelity
// lens block has ONE canonical home — the engine's `references/agent-rules-lens.md` — and both
// `agent_rules.md` templates carry a RENDER of it (the file's own section number bound into the
// number-neutral heading). This guard pins exactly that: each template's extracted block must
// byte-equal render(fragment, its number) OR render(a prior-store entry, its number) — a template
// seeded from a KNOWN canonical body stays green (the kit reconcile converges it in the wild;
// a stale-but-known seed is canonical-and-convergent), an unknown/hand-drifted body goes red.
// Parity against the CURRENT fragment alone would force template edits (kit+memory diffs) on
// every future engine-only wording release — the exact mesh this design deletes.
//
// The old 22-token × 4-file vocabulary mesh is gone: discipline-token presence is pinned ONCE, in
// the engine's own lens-fragment.test.mjs (canon-presence); canon-section coverage stays with
// planning-canon / orchestration-canon / procedures-canon (unchanged). Extraction runs through
// the SHIPPED module (tools/lens-region.mjs) — the boundary rule this test once carried privately
// is now the tested production implementation.
//
// Reads the full monorepo checkout (sibling packages present) — the same cross-package precedent
// as lineage-head-drift.test.mjs / bridges-mirror.test.mjs. Lives under test/ (never ships).
const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = join(HERE, '..');
const FAMILY_ROOT = join(KIT_ROOT, '..');

const DRIFT_MESSAGE =
  'agent_rules template lens block is not a render of a known canonical body — re-render it from the engine fragment (or append the outgoing body to the engine prior store in the same release).';

const FRAGMENT = readFileSync(join(FAMILY_ROOT, 'agent-workflow-engine', 'references', 'agent-rules-lens.md'), 'utf8');
const PRIORS = parseLensPriors(
  readFileSync(join(FAMILY_ROOT, 'agent-workflow-engine', 'references', 'agent-rules-lens-priors.md'), 'utf8'),
);

const TEMPLATE_FILES = [
  ['memory agent_rules template', join(FAMILY_ROOT, 'agent-workflow-memory', 'references', 'templates', 'agent_rules.md')],
  ['kit agent_rules template', join(KIT_ROOT, 'references', 'templates', 'agent_rules.md')],
];

// The full known-canonical set, rendered at a given section number.
const knownRendersAt = (number) => [FRAGMENT, ...PRIORS].map((body) => renderLens(body, number));

describe('agent_rules lens — render-parity against the engine known-canonical set', () => {
  for (const [label, file] of TEMPLATE_FILES) {
    it(`${label}: the lens block byte-equals a render of the fragment or a prior`, () => {
      const region = extractLensRegion(readFileSync(file, 'utf8'));
      assert.equal(region.found, true, `${label} (${file}) is missing the lens block. ${DRIFT_MESSAGE}`);
      assert.ok(
        knownRendersAt(region.number).includes(region.body),
        `${label} (${file}) lens block does not byte-equal any known canonical render. ${DRIFT_MESSAGE}`,
      );
    });
  }

  it('at this release both templates carry the CURRENT render (not merely a prior)', () => {
    // A stale-but-known template is legal for a SEED in the wild; the CHECKOUT templates are set
    // to the current render at every release that touches the fragment (this pin is what makes a
    // fragment edit without a template re-render fail fast in the monorepo).
    for (const [label, file] of TEMPLATE_FILES) {
      const region = extractLensRegion(readFileSync(file, 'utf8'));
      assert.equal(region.body, renderLens(FRAGMENT, region.number), `${label} must carry the current render. ${DRIFT_MESSAGE}`);
    }
  });

  // Injected red→green NON-VACUITY proof (the AD-029/AD-031 precedent): corrupt a template copy
  // IN MEMORY and assert the same extractor + comparator reject it — a hand-drift can never stay
  // green by matching an accidental occurrence elsewhere.
  it('non-vacuity: a one-token in-memory drift makes the parity check go red (injected)', () => {
    const [label, file] = TEMPLATE_FILES[0];
    const real = readFileSync(file, 'utf8');
    const sane = extractLensRegion(real);
    assert.ok(knownRendersAt(sane.number).includes(sane.body), `sanity: the real ${label} block is a known render`);
    for (const corruption of [
      ['Fold by code', 'Fold by vibes'],
      ['0 blockers + 0 majors', '1 blocker'],
      ['cheapest adequate executor', 'priciest executor'],
    ]) {
      const corrupted = real.replace(corruption[0], corruption[1]);
      assert.notEqual(corrupted, real, `sanity: the corruption "${corruption[0]}" actually hits the template`);
      const region = extractLensRegion(corrupted);
      assert.equal(region.found, true, 'the corrupted copy still has the heading');
      assert.ok(
        !knownRendersAt(region.number).includes(region.body),
        `the parity check must go RED when "${corruption[0]}" drifts — otherwise the guard is vacuous`,
      );
    }
  });
});
