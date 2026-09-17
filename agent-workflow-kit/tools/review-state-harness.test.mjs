// Shared fixture module for the facade suite and the review-state leaf suites.
import { after } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, lstatSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { computeFingerprintPayload, computeTreeFingerprint, resolveBase } from './core-evidence.mjs';
import { resolveFlowStorePath } from './flow-store.mjs';
import { FLOW_SCHEMA_VERSION } from './flow-record.mjs';

export const CODEX = 'codex-cli-bridge';
export const AGY = 'antigravity-cli-bridge';
export const detect = (codex, agy) => () => [
  { name: CODEX, readiness: codex },
  { name: AGY, readiness: agy },
];

// The normative receipt fixture (AD-038 shape + the D3 self-declaring probe marker); tests override
// fields. wrapperVersion stays at its historical 2.2.0 ON PURPOSE: the probe verdict must depend on the
// MARKER alone, so no suite can pass because of a version. The default verdict is SHIP-CLASS (only
// ship-class satisfies the hardened gate); the veto/vocabulary fixtures override it explicitly.
export const RECEIPT_FIXTURE = JSON.parse(
  '{"schema":1,"artifact":"code","fresh":true,"fingerprint":"<sha256hex>","backend":"codex","verdict":"ship","grounded":true,"factsHash":null,"wrapperVersion":"2.2.0","timestamp":"2026-07-03T12:00:00Z","probe":false,"posture":{"model":"<display>"}}',
);
// An agy `code` receipt additionally SELF-DECLARES how the change set reached the model (D8b); for a
// single-turn review that is `inline`. Pre-marker fixtures pass `delivery: undefined` (JSON.stringify
// drops the key).
export const receiptLine = (overrides) => {
  const receipt = { ...RECEIPT_FIXTURE, ...overrides };
  if (receipt.backend === 'agy' && !Object.hasOwn(overrides, 'delivery')) receipt.delivery = 'inline';
  return `${JSON.stringify(receipt)}\n`;
};

export const COUNCIL_CONFIG = JSON.stringify({ 'plan-execution': { execute: 'solo', review: 'council' } });
export const SOLO_CONFIG = JSON.stringify({ 'plan-execution': { review: 'solo' } });

// A real git fixture repo: committed base, per-test config / plans / pending state. The committed base
// is IDENTICAL for every test (all variation is untracked), so it is built ONCE and cloned per test —
// a per-test `git init`+commit dominated this suite's wall.
const REPO_TEMPLATE = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'review-state-template-'));
  const g = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'probe@example.com');
  g('config', 'user.name', 'probe');
  writeFileSync(join(dir, 'base.txt'), 'committed base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  return dir;
})();
after(() => rmSync(REPO_TEMPLATE, { recursive: true, force: true }));

export const makeRepo = ({ config = COUNCIL_CONFIG, plan = 'active-plan.md', pending = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'review-state-'));
  cpSync(REPO_TEMPLATE, root, { recursive: true });
  const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (config != null) {
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), config);
  }
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'queue.md'), '# queue\n');
  if (plan) writeFileSync(join(root, 'docs', 'plans', plan), '# active plan\n');
  if (pending) writeFileSync(join(root, 'pending.txt'), 'uncommitted work\n');
  return { root, g };
};

// A fake lstat result: exactly one type flag true, every other false (a real lstat has one type).
export const fakeStat = (type) => ({
  isFile: () => type === 'file',
  isDirectory: () => type === 'dir',
  isSymbolicLink: () => type === 'symlink',
  isCharacterDevice: () => type === 'char',
  isBlockDevice: () => type === 'block',
  isFIFO: () => type === 'fifo',
  isSocket: () => type === 'socket',
});

// A repo whose ONLY untracked path is the git-visible mask fixture; the lying lstat reports the given class while git (dirent) lists it.
export const makeMaskRepo = () => {
  const { root, g } = makeRepo({ config: null, plan: null, pending: false });
  g('add', '-A');
  g('commit', '-qm', 'docs committed');
  const baselinePayload = computeFingerprintPayload(root).toString('latin1');
  const baselineFp = computeTreeFingerprint(root);
  writeFileSync(join(root, 'mask.txt'), 'sandbox mask body\n');
  const liar = (p) => (p.endsWith('mask.txt') ? fakeStat('char') : lstatSync(p));
  return { root, baselinePayload, baselineFp, liar };
};

export const throwing = () => { throw new Error('EACCES'); };

export const FLOW_TS = '2026-07-30T00:00:00.000Z';
export const FLOW_TS_2 = '2026-07-30T00:00:01.000Z';
export const flowStoreAt = (root) => resolveFlowStorePath(root, {});
export const writeFlowStore = (root, records) =>
  writeFileSync(flowStoreAt(root), records.map((r) => `${JSON.stringify(r)}\n`).join(''));
export const flowAdoption = (over = {}) => ({
  schema: FLOW_SCHEMA_VERSION, kind: 'chain', purpose: 'adoption', planId: 'plan-x', cycle: 1, round: 0,
  commitEpoch: 0, owner: 'main', base: null, timestamp: FLOW_TS, stepId: null, fingerprint: 'a1'.repeat(32),
  planLabel: 'Plan X', createdAt: FLOW_TS, planDigest: 'b2'.repeat(32), ...over,
});
export const attestationAt = (root, planId, over = {}) => ({
  schema: FLOW_SCHEMA_VERSION, kind: 'internal-attestation', fingerprint: computeTreeFingerprint(root), planId,
  stepId: 's1', cycle: 1, round: 1, lenses: ['correctness'], degraded: [],
  posture: { model: 'frontier', effort: null, tier: null }, authority: 'orchestrator',
  base: resolveBase(root), timestamp: FLOW_TS, ...over,
});
export const PLAN_WITH_ID = '---\nplanId: plan-x\n---\n# active plan\n';
export const digestOf = (text) => createHash('sha256').update(Buffer.from(text)).digest('hex');
export const planPath = (root) => join(root, 'docs', 'plans', 'active-plan.md');
