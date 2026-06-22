import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectMemory, handoffPlan, REQUIRED_MEMORY_ASSETS } from './delegation.mjs';

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

  it('required assets use real (references/) paths', () => {
    const paths = REQUIRED_MEMORY_ASSETS.map((a) => a.path);
    assert.ok(paths.includes('references/templates'));
    assert.ok(paths.includes('references/contracts.md'));
  });
});

describe('handoffPlan — stamp sets + single commit gate', () => {
  it('delegate → both stamps present; memory never raises its own commit gate', () => {
    const p = handoffPlan(true);
    assert.deepEqual(p.stampsPresent, ['.memory-version', '.workflow-version']);
    assert.equal(p.memoryRaisesCommitGate, false);
    assert.equal(p.commitGate, 'kit-only-after-injection');
    assert.ok(p.memoryWrites.includes('docs/ai/.memory-version'));
    // Delegate is the ONLY branch with a real slot (memory ships it empty; the kit injects).
    assert.ok(p.kitWrites.some((w) => w.includes('slot')), 'delegate kitWrites should name the methodology slot');
  });

  it('fallback → only .workflow-version; kit writes everything; one kit gate', () => {
    const p = handoffPlan(false);
    assert.deepEqual(p.stampsPresent, ['.workflow-version']);
    assert.deepEqual(p.memoryWrites, []);
    assert.equal(p.memoryRaisesCommitGate, false);
    assert.equal(p.commitGate, 'kit-only-after-injection');
    // Fallback now ships the kit's own AGENTS.md with the EMPTY methodology slot, which the kit
    // reconciles + fills — the same slot mechanism as the delegate path (Plan 2).
    assert.ok(
      p.kitWrites.some((w) => w.includes('slot')) && !p.kitWrites.some((w) => w.includes('inline')),
      'fallback kitWrites should describe the methodology slot, not inline methodology',
    );
  });
});
