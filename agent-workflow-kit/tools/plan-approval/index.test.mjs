import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { describe, it } from 'node:test';
import { canonicalFlowDigest } from '../flow-record-identity.mjs';
import { checkPlanStructure, parseLedger } from '../plan-shape.mjs';
import { AMENDMENT_LINE } from '../plan-structure/index.mjs';
import { planWith } from '../plan-shape-harness.test.mjs';

const GOAL = 'Spec: not adopted. Keep both guides current.';
const VERIFICATION = '- `node --test` exits 0';
const FIRST = 'R1 | modify | docs/guide.md | revise the guide robust:a | docs/guide.md:1';
const SECOND = 'R2 | create | docs/extra.md | add the appendix | docs/guide.md:1';
const AMENDMENT = 'A1 | modify | docs/missed.md | fix the omission | docs/guide.md:1';
const buildPlan = (...rows) => planWith({ goal: GOAL, ledger: rows.join('\n'), verification: VERIFICATION });
const PLAN = buildPlan(FIRST, SECOND);
const verdictOf = (text) => {
  const result = checkPlanStructure(text, { robustClasses: ['a', 'b'] });
  return { identity: 'docs/plans/guide.md', text, rows: parseLedger(text).rows.filter((row) => row.valid),
    accepted: result.findings.length === 0, result };
};

describe('spec:plan-approval/S1 approved plan parts', () => {
  it('answers exactly the goal, ordered approved row projections and verification, and hashes canonical JSON', async () => {
    const { approvedParts, digestPlan } = await import('./index.mjs');
    const text = buildPlan(FIRST, SECOND, AMENDMENT_LINE, AMENDMENT);
    const verdict = verdictOf(text);
    assert.equal(verdict.accepted, true, JSON.stringify(verdict.result.findings));
    const parts = approvedParts(text, verdict);
    const values = Object.values(parts);
    assert.equal(values.length, 3);
    assert.deepEqual(values.filter((value) => typeof value === 'string').map((value) => value.trim()).sort(),
      [GOAL, VERIFICATION].sort());
    assert.deepEqual(values.find(Array.isArray), [
      { verb: 'modify', path: 'docs/guide.md', responsibility: 'revise the guide' },
      { verb: 'create', path: 'docs/extra.md', responsibility: 'add the appendix' },
    ]);
    assert.equal(digestPlan(text, verdict), canonicalFlowDigest(parts));
  });

  it('ignores ids, anchors, tag corrections, amendments, cleanup, next steps and CRLF independently', async () => {
    const { digestPlan } = await import('./index.mjs');
    const digest = (text) => {
      const verdict = verdictOf(text);
      assert.equal(verdict.accepted, true, JSON.stringify(verdict.result.findings));
      return digestPlan(text, verdict);
    };
    const expected = digest(PLAN);
    assert.match(expected, /^[a-f0-9]{64}$/);
    for (const changed of [
      PLAN.replace('R1 |', 'R9 |'),
      PLAN.replace('docs/guide.md:1', 'docs/guide.md:7'),
      PLAN.replace('robust:a', 'robust:b'),
      buildPlan(FIRST, SECOND, AMENDMENT_LINE, AMENDMENT),
      PLAN.replace('- Record it.', '- Archive it.'),
      PLAN.replace('- Continue.', '- Check the result.'),
      PLAN.replaceAll('\n', '\r\n'),
    ]) assert.equal(digest(changed), expected, changed);
  });

  it('changes the digest for changed responsibility, path, goal, verification or row order', async () => {
    const { digestPlan } = await import('./index.mjs');
    const digest = (text) => {
      const verdict = verdictOf(text);
      assert.equal(verdict.accepted, true, JSON.stringify(verdict.result.findings));
      return digestPlan(text, verdict);
    };
    for (const changed of [
      PLAN.replace('revise the guide', 'rewrite the guide'),
      PLAN.replace('docs/extra.md', 'docs/appendix.md'),
      PLAN.replace('Keep both guides current.', 'Retire the guides.'),
      PLAN.replace(VERIFICATION, '- `node --test` exits 1'),
      buildPlan(SECOND, FIRST),
    ]) assert.notEqual(digest(changed), digest(PLAN), changed);
  });

  it('has no approved parts for a refusing input verdict, duplicate verification or doubled amendment line', async () => {
    const { approvedParts, digestPlan } = await import('./index.mjs');
    const refused = { ...verdictOf(PLAN), accepted: false, result: { findings: [{ code: 'ownership' }] } };
    assert.ok(!approvedParts(PLAN, refused));
    assert.ok(!digestPlan(PLAN, refused));
    for (const text of [
      PLAN.replace('## Phase: Cleanup', '## Verification\n- Another check.\n\n## Phase: Cleanup'),
      buildPlan(FIRST, SECOND, AMENDMENT_LINE, AMENDMENT, AMENDMENT_LINE),
    ]) {
      const verdict = verdictOf(text);
      assert.equal(verdict.accepted, false);
      assert.ok(!approvedParts(text, verdict));
      assert.ok(!digestPlan(text, verdict));
    }
  });
});

it('spec:plan-approval/S2 contract digest omits flow-owned metadata and bindings but not contract or scenario text', async () => {
  const { digestContract } = await import('./index.mjs');
  const contract = `---
type: spec
scope: permanent
staleAfter: 90d
owner: none
maxLines: 150
kind: spec
status: draft
revision: 1
lastUpdated: 2026-11-24
---
# Spec: reference

## Contract
- Keep the reference current :: draft content.

## Scenarios
- S1 the reference is current :: unbound
- S2 the reference is available :: unbound

## Out of scope
- Publishing.

## Module
- docs/reference.md
`;
  const digest = digestContract(contract);
  assert.match(digest, /^[a-f0-9]{64}$/);
  for (const changed of [
    contract.replace('status: draft', 'status: live'),
    contract.replace('revision: 1', 'revision: 2'),
    contract.replace('2026-11-24', '2026-11-25'),
    contract.replace('S1 the reference is current :: unbound', 'S1 the reference is current :: test/reference.test.mjs :: spec:reference/S1'),
    contract.replace('S2 the reference is available :: unbound', 'S2 the reference is available :: test/reference.test.mjs :: spec:reference/S2'),
  ]) assert.equal(digestContract(changed), digest, changed);
  for (const changed of [
    contract.replace('Keep the reference current', 'Retire the reference'),
    contract.replace('draft content.', 'revised content.'),
    contract.replace('the reference is current', 'the reference is archived'),
    contract.replace('the reference is available', 'the reference is unavailable'),
  ]) assert.notEqual(digestContract(changed), digest, changed);
});

it('spec:plan-approval/S3 the door only re-exports its named owners without effects or cycles', async (t) => {
  const door = new URL('./index.mjs', import.meta.url);
  const source = fs.readFileSync(door, 'utf8');
  const entries = fs.readFileSync(new URL('./entries.mjs', door), 'utf8');
  const record = fs.readFileSync(new URL('./record.mjs', door), 'utf8');
  const cli = fs.readFileSync(new URL('./cli.mjs', door), 'utf8');
  const reexports = /export\s*\{([^}]+)\}\s*from\s*['"](\.\/(?:entries|record)\.mjs)['"]\s*;?/g;
  const namedExports = [...source.matchAll(reexports)];
  assert.equal(source.replace(reexports, '').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').trim(), '');
  for (const name of ['readApproval', 'appendApproval', 'getLocalDate', 'OUTCOME_LINES']) {
    assert.ok(namedExports.some(([, names, owner]) => owner === './record.mjs' && names.split(',').map((value) => value.trim()).includes(name)), name);
  }
  for (const name of ['readApproval', 'OUTCOME_LINES']) {
    assert.ok([...cli.matchAll(/export\s*\{([^}]+)\}\s*(?:from\s*['"]\.\/record\.mjs['"])?/g)]
      .some(([, names]) => names.split(',').map((value) => value.trim()).includes(name)), name);
  }
  const modules = { 'index.mjs': source, 'entries.mjs': entries, 'record.mjs': record, 'cli.mjs': cli };
  const visit = (name, ancestors = []) => {
    assert.ok(!ancestors.includes(name), [...ancestors, name].join(' -> '));
    for (const [, target] of modules[name].matchAll(/(?:from\s*|import\s*\(?\s*)['"]\.\/([^'"]+)['"]/g)) {
      if (Object.hasOwn(modules, target)) visit(target, [...ancestors, name]);
    }
  };
  for (const name of Object.keys(modules)) visit(name);
  const imports = [...entries.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)];
  for (const [name, owner] of [
    ['parseLedger', '../plan-shape.mjs'],
    ['relateAmendments', '../plan-structure/index.mjs'],
    ['parseRobustTag', '../robustness-literals.mjs'],
    ['SPEC_SCHEMA', '../../references/scripts/spec-schema/index.mjs'],
  ]) assert.ok(imports.some(([, names, path]) => path === owner && new RegExp(`\\b${name}\\b`).test(names)), name);
  assert.doesNotMatch(entries, /\b(?:judgePlan|checkPlanStructure)\b/);

  const effects = [];
  const isLoaderRead = (stack) => /node:internal\/modules\//.test(stack)
    && !stack.split('\n').some((frame) => frame.includes('file://') && !frame.includes(import.meta.url));
  const forbid = (name, original = () => {}) => function (...args) {
    if (isLoaderRead(new Error().stack)) return original.apply(this, args);
    effects.push(name);
    throw new Error(name);
  };
  const forbidOn = (owner, name) => t.mock.method(owner, name, forbid(name, owner[name]));
  for (const name of ['readFileSync', 'readFile', 'openSync', 'open', 'readdirSync', 'readdir', 'statSync', 'lstatSync', 'existsSync',
    'writeFileSync', 'writeFile', 'appendFileSync', 'mkdirSync', 'renameSync', 'rmSync']) {
    forbidOn(fs, name);
  }
  for (const name of ['readFile', 'open', 'readdir', 'writeFile', 'appendFile', 'mkdir', 'rename', 'rm']) {
    forbidOn(fs.promises, name);
  }
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    forbidOn(childProcess, name);
  }
  t.mock.method(process.stdout, 'write', forbid('stdout'));
  t.mock.method(process.stderr, 'write', forbid('stderr'));
  syncBuiltinESMExports();
  try {
    for (const attempt of [1, 2]) {
      const exports = await import(`${door.href}?attempt=${attempt}`);
      assert.deepEqual(Object.keys(exports).sort(), [
        'APPROVAL_RECORD_BASENAME', 'OUTCOME_LINES', 'appendApproval', 'approvedParts', 'composeEntry', 'digestContract',
        'digestPlan', 'findMatch', 'getLocalDate', 'parseEntries', 'readApproval',
      ]);
      assert.equal(exports.APPROVAL_RECORD_BASENAME, 'agent-workflow-plan-approvals.jsonl');
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(effects, []);
  const recordExports = await import('./record.mjs');
  const doorExports = await import(door.href);
  const cliExports = await import('./cli.mjs');
  for (const name of ['readApproval', 'appendApproval', 'getLocalDate', 'OUTCOME_LINES']) assert.equal(doorExports[name], recordExports[name], name);
  for (const name of ['readApproval', 'OUTCOME_LINES']) assert.equal(cliExports[name], recordExports[name], name);
});

it('spec:plan-approval/S6 matches provision by plan digest alone and approval by both digests', async () => {
  const { findMatch } = await import('./index.mjs');
  const planDigest = 'a'.repeat(64);
  const contractsDigest = canonicalFlowDigest([]);
  const essence = 'Keep the guide current.';
  const entry = {
    schema: 1, plan: 'docs/plans/guide.md', date: '2026-11-24',
    planDigest, contractsDigest, contracts: [], essence, from: 'approval',
    approval: canonicalFlowDigest({ planDigest, contractsDigest, essence }),
  };
  const match = (from, planDigest, contractsDigest) => Boolean(findMatch([{ ...entry, from }], { planDigest, contractsDigest }));
  for (const [from, planDigest, contractsDigest, expected] of [
    ['approval', entry.planDigest, entry.contractsDigest, true],
    ['approval', entry.planDigest, 'd'.repeat(64), false],
    ['approval', 'd'.repeat(64), entry.contractsDigest, false],
    ['provision', entry.planDigest, 'd'.repeat(64), true],
    ['provision', entry.planDigest, entry.contractsDigest, true],
    ['provision', 'd'.repeat(64), entry.contractsDigest, false],
  ]) assert.equal(match(from, planDigest, contractsDigest), expected, from);
});
