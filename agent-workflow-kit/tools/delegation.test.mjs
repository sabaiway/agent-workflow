import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectMemory, handoffPlan, REQUIRED_MEMORY_ASSETS } from './delegation.mjs';
import { MEMORY_ORCH_TEMPLATE_REL } from './family-registry.mjs';

// Inject a fake validator + fs so the decision matrix is tested independent of real files/agents.
const fakeValidate = (over = {}) => () => ({
  result: 'valid',
  kind: 'memory-substrate',
  name: 'agent-workflow-memory',
  available: true,
  errors: [],
  ...over,
});
const ASSET_TYPE = {
  'references/templates': 'dir',
  'references/templates/orchestration.json': 'file',
  'references/contracts.md': 'file',
  'references/scripts': 'dir',
  'scripts/stamp-takeover.mjs': 'file',
  migrations: 'dir',
  'capability.json': 'file',
};
const typeFor = (p) => {
  for (const [k, t] of Object.entries(ASSET_TYPE)) if (p.endsWith(k)) return t;
  return 'file';
};
const allPresent = (p) => typeFor(p);
const missing = (absent) => (p) => (absent.some((a) => p.endsWith(a)) ? null : typeFor(p));
const wrongType = (paths) => (p) => {
  for (const [k, t] of Object.entries(ASSET_TYPE)) {
    if (p.endsWith(k)) return paths.includes(k) ? (t === 'dir' ? 'file' : 'dir') : t;
  }
  return 'file';
};

describe('detectMemory — decision matrix', () => {
  it('valid + memory-substrate + right name + available + all assets → delegate', () => {
    const d = detectMemory('/m', { validate: fakeValidate(), statType: allPresent });
    assert.equal(d.delegate, true);
  });

  it('invalid manifest → fallback', () => {
    const d = detectMemory('/m', { validate: fakeValidate({ result: 'invalid' }), statType: allPresent });
    assert.equal(d.delegate, false);
    assert.match(d.reason, /invalid/);
  });

  it('unsupported schema → fallback (treated like invalid)', () => {
    const d = detectMemory('/m', { validate: fakeValidate({ result: 'unsupported' }), statType: allPresent });
    assert.equal(d.delegate, false);
  });

  it('wrong kind → fallback', () => {
    const d = detectMemory('/m', { validate: fakeValidate({ kind: 'composition-root' }), statType: allPresent });
    assert.equal(d.delegate, false);
    assert.match(d.reason, /not memory-substrate/);
  });

  it('wrong name → fallback (even if kind + assets are right)', () => {
    const d = detectMemory('/m', { validate: fakeValidate({ name: 'evil-substrate' }), statType: allPresent });
    assert.equal(d.delegate, false);
    assert.match(d.reason, /name/);
  });

  it('available:false stub → fallback', () => {
    const d = detectMemory('/m', { validate: fakeValidate({ available: false }), statType: allPresent });
    assert.equal(d.delegate, false);
    assert.match(d.reason, /stub/);
  });

  it('partial install (missing stamp-takeover) → fallback', () => {
    const d = detectMemory('/m', {
      validate: fakeValidate(),
      statType: missing(['scripts/stamp-takeover.mjs']),
    });
    assert.equal(d.delegate, false);
    assert.match(d.reason, /stamp-takeover/);
  });

  it('wrong-type asset (templates is a file, not a dir) → fallback', () => {
    const d = detectMemory('/m', { validate: fakeValidate(), statType: wrongType(['references/templates']) });
    assert.equal(d.delegate, false);
    assert.match(d.reason, /references\/templates/);
  });

  // Step 2.4 — the surgical orchestration-template gate: a memory whose templates dir exists but lacks
  // orchestration.json (a pre-1.2.0 install, e.g. v1.0.0) can't seed docs/ai/orchestration.json, so it
  // must NOT be delegate-classified — the kit falls back to its own bundled substrate (which seeds it).
  it('memory MISSING the orchestration template (old memory) → fallback (not delegate)', () => {
    const d = detectMemory('/m', { validate: fakeValidate(), statType: missing(['references/templates/orchestration.json']) });
    assert.equal(d.delegate, false);
    assert.match(d.reason, /orchestration\.json/);
  });

  // The Plan-3 decision HOLDS (review-delegation-r01-blocker-01, Segment B): detectMemory carries NO autonomy-marker
  // gate — an old memory missing the autonomy seed stays delegable; the kit-side upgrade ensure +
  // the family-registry caveat (inform, never gate) cover the stale-memory case instead.
  it('autonomy.json is NOT a required memory asset — the Plan-3 no-gate decision holds', () => {
    assert.ok(
      !REQUIRED_MEMORY_ASSETS.some((a) => String(a.path).includes('autonomy.json')),
      'the delegation gate must never key on the autonomy seed (inform via the registry caveat instead)',
    );
  });

  it('required assets use real (references/) paths', () => {
    const paths = REQUIRED_MEMORY_ASSETS.map((a) => a.path);
    assert.ok(paths.includes('references/templates'));
    assert.ok(paths.includes('references/contracts.md'));
  });
});

describe('delegation gate parity — the orchestration template (Step 2.4)', () => {
  it('required-asset set includes references/templates/orchestration.json as a file', () => {
    const orch = REQUIRED_MEMORY_ASSETS.find((a) => a.path === 'references/templates/orchestration.json');
    assert.ok(orch, 'the orchestration template must be a required asset');
    assert.equal(orch.type, 'file');
  });

  // The read-only family-registry note and this delegation gate must key on the SAME asset — the note
  // INFORMS, the gate ACTS. This drift-guard ties them so they can never diverge to different files.
  // It asserts EQUALITY to the concrete orchestration template + its `file` type, so it would still
  // catch a note that drifted to another required path (e.g. the `references/templates` DIR).
  it('the family-registry memory-caveat probe keys on the SAME asset the gate requires', () => {
    const matched = REQUIRED_MEMORY_ASSETS.find((a) => a.path === MEMORY_ORCH_TEMPLATE_REL);
    assert.ok(matched, 'the note path must be a required asset');
    assert.equal(matched.type, 'file', 'the note must key on the orchestration TEMPLATE FILE, not the templates dir');
    assert.match(MEMORY_ORCH_TEMPLATE_REL, /orchestration\.json$/, 'the note path must be the orchestration template');
  });
});

describe('handoffPlan — stamp sets + single commit gate', () => {
  it('delegate → both stamps present; memory never raises its own commit gate', () => {
    const p = handoffPlan(true);
    assert.deepEqual(p.stampsPresent, ['.memory-version', '.workflow-version']);
    assert.equal(p.memoryRaisesCommitGate, false);
    assert.equal(p.commitGate, 'kit-only-after-injection');
    assert.ok(p.memoryWrites.includes('docs/ai/.memory-version'));
    // Delegate is the ONLY branch with real slots (memory ships them empty; the kit injects).
    assert.ok(
      p.kitWrites.some((w) => w.includes('slot') && w.includes('methodology') && w.includes('orchestration') && w.includes('autonomy')),
      'delegate kitWrites should name the bounded reconcile of all three pointer slots',
    );
    assert.ok(
      p.kitWrites.some((w) => w.includes('agent_rules.md lens region')),
      'delegate kitWrites must name the lens-region refresh (it converges a stale-memory seed)',
    );
  });

  it('fallback → only .workflow-version; kit writes everything; one kit gate', () => {
    const p = handoffPlan(false);
    assert.deepEqual(p.stampsPresent, ['.workflow-version']);
    assert.deepEqual(p.memoryWrites, []);
    assert.equal(p.memoryRaisesCommitGate, false);
    assert.equal(p.commitGate, 'kit-only-after-injection');
    // Fallback now ships the kit's own AGENTS.md with the EMPTY pointer slots, which the kit
    // reconciles + fills — the same slot mechanism as the delegate path (Plan 2).
    assert.ok(
      p.kitWrites.some((w) => w.includes('slot') && w.includes('methodology') && w.includes('orchestration') && w.includes('autonomy')) &&
        !p.kitWrites.some((w) => w.includes('inline')),
      'fallback kitWrites should describe all three pointer slots, not inline methodology',
    );
    assert.ok(
      p.kitWrites.some((w) => w.includes('agent_rules.md lens region')),
      'fallback kitWrites must name the lens-region refresh (both paths run it)',
    );
  });
});
