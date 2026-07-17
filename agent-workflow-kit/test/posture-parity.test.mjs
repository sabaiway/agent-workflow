// posture-parity.test.mjs — the D5 posture pins cannot drift (strip Phase 4): each bridge's
// capability.json `posture` block is the CHECKABLE source the kit renders from, and it must equal
// the wrapper's OWN shell defaults — in the root bridge dirs AND the kit's bundled mirrors alike
// (bridges-mirror pins byte-equality of the trees; this test pins the SEMANTIC pair inside them).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeConfiguredPosture } from '../tools/recipes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const shellDefault = (src, name) => {
  const m = src.match(new RegExp(`^${name}="([^"]*)"`, 'm'));
  return m ? m[1] : null;
};

for (const base of [ROOT, join(ROOT, 'agent-workflow-kit', 'bridges')]) {
  const label = base === ROOT ? 'root' : 'kit bundle';

  describe(`posture pins ⟷ wrapper defaults (${label})`, () => {
    it('agy: manifest posture.model === DEFAULT_AGY_REVIEW_MODEL; no effort/tier (agy has no tier)', () => {
      const manifest = JSON.parse(readFileSync(join(base, 'antigravity-cli-bridge', 'capability.json'), 'utf8'));
      const src = readFileSync(join(base, 'antigravity-cli-bridge', 'bin', 'agy-review.sh'), 'utf8');
      assert.ok(manifest.posture, 'the agy manifest declares the posture block');
      assert.equal(manifest.posture.model, shellDefault(src, 'DEFAULT_AGY_REVIEW_MODEL'));
      assert.deepEqual(Object.keys(manifest.posture), ['model'], 'agy declares exactly {model}');
    });

    it('codex: manifest posture {model, effort, tier:null} === the wrapper defaults (standard tier)', () => {
      const manifest = JSON.parse(readFileSync(join(base, 'codex-cli-bridge', 'capability.json'), 'utf8'));
      const src = readFileSync(join(base, 'codex-cli-bridge', 'bin', 'codex-review.sh'), 'utf8');
      assert.ok(manifest.posture, 'the codex manifest declares the posture block');
      assert.equal(manifest.posture.model, shellDefault(src, 'DEFAULT_CODEX_MODEL'));
      assert.equal(manifest.posture.effort, shellDefault(src, 'DEFAULT_CODEX_EFFORT'));
      assert.equal(manifest.posture.tier, null, 'the DEFAULT tier is standard — null, never a silent Fast pin');
      assert.match(src, /^CODEX_SERVICE_TIER="\$\{CODEX_SERVICE_TIER:-\}"$/m, 'the wrapper tier default is EMPTY (standard)');
      assert.deepEqual(Object.keys(manifest.posture), ['model', 'effort', 'tier'], 'codex declares exactly {model, effort, tier}');
    });

    it('the kit RENDER composes exactly the manifest pins (+ the bridge-settings tier overlay)', () => {
      const bundleRoot = base === ROOT ? join(ROOT, 'agent-workflow-kit', 'bridges') : base;
      const rendered = composeConfiguredPosture({ bundleRoot, settings: { active: [] } });
      assert.equal(rendered, 'codex model=gpt-5.6-sol effort=xhigh tier=standard · agy model=Gemini 3.1 Pro (High)');
      const fast = composeConfiguredPosture({
        bundleRoot,
        settings: { active: [{ key: 'CODEX_SERVICE_TIER', value: 'priority', source: 'file', bridge: 'codex-cli-bridge' }] },
      });
      assert.match(fast, /codex model=gpt-5\.6-sol effort=xhigh tier=priority \(bridge-settings\)/, 'an armed tier knob overlays the pin and names its source');
      const empty = composeConfiguredPosture({ bundleRoot: join(HERE, '__no_bundle__') });
      assert.equal(empty, null, 'no posture-declaring bundle → null (every surface stays byte-identical)');
      const hostile = composeConfiguredPosture({ bundleRoot, settings: { active: 42 } });
      assert.equal(hostile, null, 'a hostile settings shape degrades to null via the outer catch — a footer fact never crashes');
    });

    it('the receipt writer and the banner both ride the SAME resolved values (source-level pins)', () => {
      const agy = readFileSync(join(base, 'antigravity-cli-bridge', 'bin', 'agy-review.sh'), 'utf8');
      assert.match(agy, /^echo "review posture: model=\$\{AGY_MODEL:-<agy settings default>\}" >&2$/m);
      assert.match(agy, /posture_json\(\)/, 'the agy receipt posture rides posture_json');
      const codex = readFileSync(join(base, 'codex-cli-bridge', 'bin', 'codex-review.sh'), 'utf8');
      assert.match(codex, /^echo "review posture: model=\$CODEX_MODEL effort=\$CODEX_EFFORT tier=\$\{CODEX_SERVICE_TIER:-standard\}" >&2$/m);
      assert.match(codex, /posture_json\(\)/, 'the codex receipt posture rides posture_json');
    });
  });
}

// A hermetic fixture bundle: two bridge dirs with caller-supplied capability.json bodies.
const mkBundle = (codexManifest, agyManifest) => {
  const root = mkdtempSync(join(tmpdir(), 'posture-bundle-'));
  for (const [name, body] of [['codex-cli-bridge', codexManifest], ['antigravity-cli-bridge', agyManifest]]) {
    mkdirSync(join(root, name), { recursive: true });
    if (body !== null) writeFileSync(join(root, name, 'capability.json'), body);
  }
  return root;
};
const GOOD_CODEX = JSON.stringify({ posture: { model: 'm1', effort: 'e1', tier: null } });
const GOOD_AGY = JSON.stringify({ posture: { model: 'm2' } });

describe('composeConfiguredPosture — corruption fails CLOSED to silence, never a partial line (M5)', () => {
  it('an UNREADABLE/corrupt manifest nulls the WHOLE render — never a partial posture', () => {
    const missing = mkBundle(null, GOOD_AGY); // codex manifest file absent-but-expected
    assert.equal(composeConfiguredPosture({ bundleRoot: missing }), null, 'a vanished manifest is corruption, not absence');
    rmSync(missing, { recursive: true, force: true });
    const corrupt = mkBundle('{not json', GOOD_AGY);
    assert.equal(composeConfiguredPosture({ bundleRoot: corrupt }), null);
    rmSync(corrupt, { recursive: true, force: true });
  });

  it('a present-but-INVALID posture block (bad effort/tier, unknown key) nulls the WHOLE render', () => {
    for (const bad of [
      JSON.stringify({ posture: { model: 'm', effort: 42 } }),
      JSON.stringify({ posture: { model: 'm', tier: 0 } }),
      JSON.stringify({ posture: { model: '' } }),
      JSON.stringify({ posture: { model: 'm', extra: 'key' } }),
      JSON.stringify({ posture: 'gpt' }),
    ]) {
      const root = mkBundle(bad, GOOD_AGY);
      assert.equal(composeConfiguredPosture({ bundleRoot: root }), null, `must null on: ${bad}`);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an ABSENT posture key in a READABLE manifest is a legitimate pre-D5 skip — the declaring bridge renders alone', () => {
    const root = mkBundle(JSON.stringify({ name: 'codex-cli-bridge' }), GOOD_AGY);
    assert.equal(composeConfiguredPosture({ bundleRoot: root }), 'agy model=m2');
    rmSync(root, { recursive: true, force: true });
  });
});
