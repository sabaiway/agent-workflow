import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  FLOW_STORE_STOP, resolveFlowStorePath, readFlowStore, appendFlowRecord,
  deriveFlowOwner, mintAdoption, priorChainTerminal, walkChainState,
} from './flow-store.mjs';
import { FLOW_SCHEMA_VERSION, canonicalFlowDigest } from './flow-record.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-flow-chain-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

let seq = 0;
const makeRepo = () => {
  const root = join(TMP, `repo-${seq += 1}`);
  mkdirSync(root, { recursive: true });
  sh(['init', '-q', '-b', 'main'], root);
  sh(['config', 'user.email', 'coder-tools@proton.me'], root);
  sh(['config', 'user.name', 'coder-tool'], root);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  sh(['add', '-A'], root);
  sh(['commit', '-q', '-m', 'init'], root);
  return root;
};
const addWorktree = (root) => {
  const wt = join(TMP, `wt-${seq += 1}`);
  sh(['worktree', 'add', '-q', wt], root);
  return wt;
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const writePlan = (dir, name, planId) => {
  const p = join(dir, name);
  writeFileSync(p, planId == null ? '# A plan with no frontmatter\n\nBody.\n' : `---\nplanId: ${planId}\n---\n\n# Plan body\n`);
  return p;
};

const BASE = 'ad'.repeat(20);
const FP = 'a1'.repeat(32);
const D = (pair) => pair.repeat(32);
const TS = (n) => `2026-07-30T00:00:0${n}.000Z`;

const chainRec = (purpose, over = {}) => ({
  schema: FLOW_SCHEMA_VERSION, kind: 'chain', purpose, planId: 'plan-a', cycle: 1,
  round: 1, commitEpoch: 0, owner: 'wt-main', base: BASE, timestamp: TS(0),
  stepId: 'step-1', fingerprint: FP, ...over,
});
const adoption = (over = {}) => chainRec('adoption', {
  round: 0, stepId: null, planLabel: 'Plan A', createdAt: TS(0), planDigest: D('1a'), ...over,
});
const opener = (opensFrom, over = {}) => chainRec('round', { opensFrom, dispatches: [], dispositions: [], ...over });
const refresh = (refreshedRecord, over = {}) => {
  const r = chainRec('refresh', { fingerprintBefore: FP, fingerprintAfter: FP, cause: 'base moved', refreshedRecord, ...over });
  delete r.fingerprint;
  return r;
};

const throwsStop = (fn, re) => assert.throws(fn, (err) => {
  assert.equal(err.code, FLOW_STORE_STOP, `expected a typed flow-store stop, got: ${err.message}`);
  assert.match(err.message, re);
  return true;
});

let storeSeq = 0;
const freshStore = () => {
  const dir = join(TMP, `store-${storeSeq += 1}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'flow.jsonl');
};
const appendTo = (store, record) => appendFlowRecord({ record, env: { AW_FLOW_STORE: store } });

describe('flow-chain-identity — adoption mint (planId frontmatter + content digest)', () => {
  it('the mint reads the frontmatter planId, binds the plan content digest, and lands the chain first record', () => {
    const root = makeRepo();
    const planPath = writePlan(root, 'plan.md', 'plan-alpha');
    const { record, digest, writtenPath } = mintAdoption({ cwd: root, planPath, env: {} });
    assert.equal(record.kind, 'chain');
    assert.equal(record.purpose, 'adoption');
    assert.equal(record.planId, 'plan-alpha', 'planId comes from the frontmatter, never the filename');
    assert.equal(record.planDigest, sha256(readFileSync(planPath)), 'the adoption binds the plan CONTENT digest');
    assert.equal(record.owner, deriveFlowOwner(root));
    assert.equal(record.stepId, null);
    assert.equal(digest, canonicalFlowDigest(record));
    assert.equal(writtenPath, resolveFlowStorePath(root, {}));
    const read = readFlowStore(writtenPath);
    assert.equal(read.malformed, 0);
    assert.deepEqual(read.records, [record]);
  });

  it('a plan file without a frontmatter planId is refused, printing the verbatim frontmatter line to add — the plan file is never written', () => {
    const root = makeRepo();
    const planPath = writePlan(root, 'no-id.md', null);
    const before = readFileSync(planPath);
    throwsStop(() => mintAdoption({ cwd: root, planPath, env: {} }), /carries no frontmatter planId/);
    throwsStop(() => mintAdoption({ cwd: root, planPath, env: {} }), /planId: <your-stable-plan-id>/);
    assert.deepEqual(readFileSync(planPath), before, 'the plan file is READ-ONLY to the mint');
    assert.equal(readFlowStore(resolveFlowStorePath(root, {})).records.length, 0, 'nothing lands on a refusal');
  });

  it('a closed frontmatter block without planId, and an unterminated block, both refuse the same way', () => {
    const root = makeRepo();
    const closed = join(root, 'closed.md');
    writeFileSync(closed, '---\ntitle: no id here\n---\n\n# Body\n');
    throwsStop(() => mintAdoption({ cwd: root, planPath: closed, env: {} }), /carries no frontmatter planId/);
    const unterminated = join(root, 'unterminated.md');
    writeFileSync(unterminated, '---\ntitle: never closed\n');
    throwsStop(() => mintAdoption({ cwd: root, planPath: unterminated, env: {} }), /carries no frontmatter planId/);
  });

  it('an unterminated frontmatter block with a planId line refuses — identity binds only a CLOSED block', () => {
    const root = makeRepo();
    const sneaky = join(root, 'unterminated-id.md');
    writeFileSync(sneaky, '---\nplanId: sneaky-id\n');
    throwsStop(() => mintAdoption({ cwd: root, planPath: sneaky, env: {} }), /carries no frontmatter planId/);
  });

  it('a CRLF plan file mints — line endings never break chain identity', () => {
    const root = makeRepo();
    const crlf = join(root, 'crlf.md');
    writeFileSync(crlf, '---\r\nplanId: plan-crlf\r\n---\r\n\r\n# Body\r\n');
    const { record } = mintAdoption({ cwd: root, planPath: crlf, env: {} });
    assert.equal(record.planId, 'plan-crlf');
  });

  it('a successful mint never writes the plan file', () => {
    const root = makeRepo();
    const planPath = writePlan(root, 'plan.md', 'plan-alpha');
    const before = readFileSync(planPath);
    mintAdoption({ cwd: root, planPath, env: {} });
    assert.deepEqual(readFileSync(planPath), before);
  });

  it('an unreadable plan file is a named refusal', () => {
    const root = makeRepo();
    throwsStop(() => mintAdoption({ cwd: root, planPath: join(root, 'absent.md'), env: {} }), /cannot read the plan file/);
  });

  it('a renamed plan file keeps its chain identity — the content digest match survives the rename', () => {
    const root = makeRepo();
    const planPath = writePlan(root, 'plan.md', 'plan-alpha');
    mintAdoption({ cwd: root, planPath, env: {} });
    const renamed = join(root, 'plan-renamed.md');
    renameSync(planPath, renamed);
    throwsStop(
      () => mintAdoption({ cwd: root, planPath: renamed, env: {} }),
      /already adopted \(content digest unchanged — a rename never resets chain identity\)/,
    );
  });

  it('re-adopting edited plan content is detectable — the digest mismatch surfaces by name', () => {
    const root = makeRepo();
    const planPath = writePlan(root, 'plan.md', 'plan-alpha');
    mintAdoption({ cwd: root, planPath, env: {} });
    writeFileSync(planPath, `---\nplanId: plan-alpha\n---\n\n# Plan body EDITED\n`);
    throwsStop(
      () => mintAdoption({ cwd: root, planPath, env: {} }),
      /already adopted and the plan file content no longer matches its adoption record/,
    );
  });

  it('minting outside a git work tree is a named refusal — chain identity needs the tree', () => {
    const dir = join(TMP, 'no-repo-mint');
    mkdirSync(dir, { recursive: true });
    const planPath = writePlan(dir, 'plan.md', 'plan-alpha');
    throwsStop(() => mintAdoption({ cwd: dir, planPath, env: {} }), /not inside a git work tree/);
  });
});

describe('flow-chain-identity — canonical owning-worktree identity (stable, git-derived)', () => {
  it('the main tree derives a stable owner and a linked worktree derives its own distinct one', () => {
    const root = makeRepo();
    const wt = addWorktree(root);
    const mainOwner = deriveFlowOwner(root);
    const wtOwner = deriveFlowOwner(wt);
    assert.equal(mainOwner, 'main');
    assert.match(wtOwner, /^worktree:/);
    assert.notEqual(wtOwner, mainOwner);
    assert.equal(deriveFlowOwner(join(TMP, 'nowhere-such')), null, 'outside a git tree there is no owner');
  });

  it('a path-alias invocation still matches its own chain — the owner is not the raw path', () => {
    const root = makeRepo();
    const alias = join(TMP, `alias-${seq += 1}`);
    symlinkSync(root, alias);
    assert.equal(deriveFlowOwner(alias), deriveFlowOwner(root), 'an aliased spelling of one worktree derives ONE owner');
  });

  it('git worktree move cannot silently turn an own open chain into foreign advisory (relocation evasion)', () => {
    const root = makeRepo();
    const wt = addWorktree(root);
    const planPath = writePlan(wt, 'plan.md', 'plan-moved');
    const before = deriveFlowOwner(wt);
    const { record } = mintAdoption({ cwd: wt, planPath, env: {} });
    assert.equal(record.owner, before);
    const moved = join(TMP, `wt-moved-${seq += 1}`);
    sh(['worktree', 'move', wt, moved], root);
    assert.equal(deriveFlowOwner(moved), before, 'the derived identity survives git worktree move');
    const openerRec = opener(canonicalFlowDigest(record), {
      planId: 'plan-moved', owner: deriveFlowOwner(moved), base: record.base, fingerprint: record.fingerprint,
    });
    appendFlowRecord({ cwd: moved, record: openerRec, env: {} });
    assert.equal(readFlowStore(resolveFlowStorePath(moved, {})).records.length, 2, 'the moved worktree still writes into its OWN chain');
  });

  it('a repo-root relocation keeps the main-tree identity', () => {
    const root = makeRepo();
    const before = deriveFlowOwner(root);
    const moved = join(TMP, `repo-moved-${seq += 1}`);
    renameSync(root, moved);
    assert.equal(deriveFlowOwner(moved), before);
  });
});

describe('flow-chain-identity — the prior-terminal reference (the generic reference validator)', () => {
  it('the plan first step binds to the adoption record itself — the exemption is explicit, never inferred', () => {
    const store = freshStore();
    const first = adoption();
    appendTo(store, first);
    appendTo(store, opener(canonicalFlowDigest(first), { timestamp: TS(1) }));
    const read = readFlowStore(store);
    assert.equal(read.malformed, 0);
    assert.equal(read.records.length, 2);
  });

  it('a new stepId without a prior-terminal reference is refused', () => {
    const store = freshStore();
    appendTo(store, adoption());
    throwsStop(() => appendTo(store, opener(null, { timestamp: TS(1) })), /must carry the prior-terminal reference/);
  });

  it('a reference whose target does not match the store is refused', () => {
    const store = freshStore();
    appendTo(store, adoption());
    throwsStop(() => appendTo(store, opener(D('9f'), { timestamp: TS(1) })), /does not match the store/);
  });

  it('a reference to a non-chain record is refused', () => {
    const store = freshStore();
    appendTo(store, adoption());
    const global = {
      schema: FLOW_SCHEMA_VERSION, kind: 'rerun-cause', fingerprint: FP,
      cause: 'flaky fixture confirmed', attempt: 'a-1', base: BASE, timestamp: TS(1),
    };
    appendTo(store, global);
    throwsStop(
      () => appendTo(store, opener(canonicalFlowDigest(global), { timestamp: TS(2) })),
      /targets a rerun-cause record, not a chain terminal/,
    );
  });

  it('a reference to another plan record is refused', () => {
    const store = freshStore();
    appendTo(store, adoption());
    const other = adoption({ planId: 'plan-b', timestamp: TS(1) });
    appendTo(store, other);
    throwsStop(
      () => appendTo(store, opener(canonicalFlowDigest(other), { timestamp: TS(2) })),
      /another plan's record/,
    );
  });

  it('a reference to a non-terminal record is refused', () => {
    const store = freshStore();
    const first = adoption();
    appendTo(store, first);
    const step1 = opener(canonicalFlowDigest(first), { timestamp: TS(1) });
    appendTo(store, step1);
    appendTo(store, chainRec('converged', { timestamp: TS(2) }));
    throwsStop(
      () => appendTo(store, opener(canonicalFlowDigest(step1), { stepId: 'step-2', timestamp: TS(3) })),
      /non-terminal record/i,
    );
  });

  it('a reference to a superseded record is refused; the authoritative terminal of the same key lands', () => {
    const store = freshStore();
    const first = adoption();
    appendTo(store, first);
    appendTo(store, opener(canonicalFlowDigest(first), { timestamp: TS(1) }));
    const converged1 = chainRec('converged', { timestamp: TS(2) });
    appendTo(store, converged1);
    appendTo(store, chainRec('unfreeze', { timestamp: TS(3) }));
    const converged2 = chainRec('converged', { timestamp: TS(4) });
    appendTo(store, converged2);
    throwsStop(
      () => appendTo(store, opener(canonicalFlowDigest(converged1), { stepId: 'step-2', timestamp: TS(5) })),
      /superseded record/i,
    );
    appendTo(store, opener(canonicalFlowDigest(converged2), { stepId: 'step-2', timestamp: TS(5) }));
    assert.equal(readFlowStore(store).records.length, 6);
  });

  it('a reference to another step terminal (not the PRIOR one) is refused — step minting cannot manufacture fresh budgets', () => {
    const store = freshStore();
    const first = adoption();
    appendTo(store, first);
    appendTo(store, opener(canonicalFlowDigest(first), { timestamp: TS(1) }));
    const converged1 = chainRec('converged', { timestamp: TS(2) });
    appendTo(store, converged1);
    appendTo(store, opener(canonicalFlowDigest(converged1), { stepId: 'step-2', timestamp: TS(3) }));
    const converged2 = chainRec('converged', { stepId: 'step-2', timestamp: TS(4) });
    appendTo(store, converged2);
    throwsStop(
      () => appendTo(store, opener(canonicalFlowDigest(converged1), { stepId: 'step-3', timestamp: TS(5) })),
      /PRIOR terminal/,
    );
    appendTo(store, opener(canonicalFlowDigest(converged2), { stepId: 'step-3', timestamp: TS(5) }));
    assert.equal(readFlowStore(store).records.length, 6);
  });

  it('a refresh binding a SUPERSEDED target is refused — the reference domain is the authoritative selection', () => {
    const store = freshStore();
    const first = adoption();
    appendTo(store, first);
    appendTo(store, opener(canonicalFlowDigest(first), { timestamp: TS(1) }));
    const deltaV1 = {
      schema: FLOW_SCHEMA_VERSION, kind: 'bookkeeping-delta', fingerprintBefore: D('aa'), fingerprintAfter: D('ab'),
      path: 'docs/x.md', contentDigest: D('cd'),
      custodyProof: { preClass: 'absent', tracked: false, headDigest: null, indexDigest: null, worktreeDigest: null, maskedFingerprint: D('aa') },
      base: BASE, timestamp: TS(2),
    };
    appendTo(store, deltaV1);
    const deltaV2 = { ...deltaV1, timestamp: TS(3) };
    appendTo(store, deltaV2);
    throwsStop(
      () => appendTo(store, refresh(canonicalFlowDigest(deltaV1), { timestamp: TS(4) })),
      /refreshedRecord targets a superseded record/,
    );
    appendTo(store, refresh(canonicalFlowDigest(deltaV2), { timestamp: TS(4) }));
    assert.equal(readFlowStore(store).records.length, 5);
  });

  it('a key-reordered canonical twin never forks reference authority — the digest domain decides, not object identity', () => {
    const store = freshStore();
    const first = adoption();
    appendTo(store, first);
    appendTo(store, opener(canonicalFlowDigest(first), { timestamp: TS(1) }));
    const deltaV1 = {
      schema: FLOW_SCHEMA_VERSION, kind: 'bookkeeping-delta', fingerprintBefore: D('aa'), fingerprintAfter: D('ab'),
      path: 'docs/x.md', contentDigest: D('cd'),
      custodyProof: { preClass: 'absent', tracked: false, headDigest: null, indexDigest: null, worktreeDigest: null, maskedFingerprint: D('aa') },
      base: BASE, timestamp: TS(2),
    };
    appendTo(store, deltaV1);
    const twin = Object.fromEntries(Object.entries(deltaV1).reverse());
    assert.notEqual(JSON.stringify(twin), JSON.stringify(deltaV1), 'the twin must be byte-different');
    assert.equal(canonicalFlowDigest(twin), canonicalFlowDigest(deltaV1), 'one canonical identity');
    appendTo(store, twin);
    appendTo(store, refresh(canonicalFlowDigest(deltaV1), { timestamp: TS(4) }));
    assert.equal(readFlowStore(store).records.length, 5, 'a reference to the shared canonical identity is authoritative, never "superseded"');
  });

  it('a refresh whose refreshedRecord does not match the store is refused; a resolvable one lands', () => {
    const store = freshStore();
    const first = adoption();
    appendTo(store, first);
    appendTo(store, opener(canonicalFlowDigest(first), { timestamp: TS(1) }));
    throwsStop(
      () => appendTo(store, refresh(D('9f'), { timestamp: TS(2) })),
      /refreshedRecord does not match the store/,
    );
    appendTo(store, refresh(canonicalFlowDigest(first), { timestamp: TS(2) }));
    assert.equal(readFlowStore(store).records.length, 3);
  });

  it('a round REVISION re-states its reference without re-classification — the reopened-step revision stays legal', () => {
    const store = freshStore();
    const first = adoption();
    appendTo(store, first);
    const step1 = opener(canonicalFlowDigest(first), { timestamp: TS(1) });
    appendTo(store, step1);
    appendTo(store, chainRec('converged', { timestamp: TS(2) }));
    appendTo(store, chainRec('unfreeze', { timestamp: TS(3) }));
    appendTo(store, { ...step1, timestamp: TS(4) });
    const read = readFlowStore(store);
    assert.equal(read.malformed, 0);
    assert.equal(read.records.length, 5, 'the revision lands although the prior terminal has since moved — its reference is byte-bound to the original');
  });
});

describe('flow-chain-identity — the chain-state walk primitives', () => {
  it('priorChainTerminal selects the latest terminal, falling back to the adoption record', () => {
    const first = adoption();
    assert.equal(priorChainTerminal([first]), first);
    const step1 = opener(canonicalFlowDigest(first), { timestamp: TS(1) });
    const converged1 = chainRec('converged', { timestamp: TS(2) });
    assert.equal(priorChainTerminal([first, step1, converged1]), converged1);
    assert.equal(priorChainTerminal([]), null);
  });

  it('walkChainState reports openers with their at-that-point prior terminal, and the open/parked/completed state', () => {
    const first = adoption();
    const step1 = opener(canonicalFlowDigest(first), { timestamp: TS(1) });
    const converged1 = chainRec('converged', { timestamp: TS(2) });
    const opened = walkChainState([first, step1]);
    assert.equal(opened.mode, 'in-step');
    assert.equal(opened.openers.length, 1);
    assert.equal(opened.openers[0].priorTerminal, first);
    const closed = walkChainState([first, step1, converged1]);
    assert.equal(closed.mode, 'boundary');
    assert.equal(closed.completed, false);
    const parked = walkChainState([first, step1, chainRec('park', { stepId: null, timestamp: TS(3) })]);
    assert.equal(parked.parked, true);
    const resumed = walkChainState([first, step1,
      chainRec('park', { stepId: null, timestamp: TS(3) }), chainRec('resume', { stepId: null, timestamp: TS(4) })]);
    assert.equal(resumed.parked, false);
    assert.equal(resumed.mode, 'in-step');
  });
});
