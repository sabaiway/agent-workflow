import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, appendFileSync, chmodSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { main, composePlanIdFrontmatter } from './flow-writer.mjs';
import { resolveFlowStorePath, readFlowStore, appendFlowRecord, readPlanFrontmatterId, mintBookkeepingDelta } from './flow-store.mjs';
import { FLOW_SCHEMA_VERSION, CHAIN_KIND, canonicalFlowDigest } from './flow-record.mjs';
import { computeTreeFingerprint, resolveBase, RECEIPTS_BASENAME, EVIDENCE_BASENAME, EVIDENCE_SCHEMA_VERSION } from './core-evidence.mjs';
import { runFlowCheck } from './flow-check.mjs';

const WRITER_TOOL = fileURLToPath(new URL('./flow-writer.mjs', import.meta.url));
const q = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
const TMP = mkdtempSync(join(tmpdir(), 'aw-flow-writer-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

let seq = 0;
const makeRepo = () => {
  const root = join(TMP, `repo-${seq += 1}`);
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  sh(['init', '-q', '-b', 'main'], root);
  sh(['config', 'user.email', 'coder-tools@proton.me'], root);
  sh(['config', 'user.name', 'coder-tool'], root);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  sh(['add', '-A'], root);
  sh(['commit', '-q', '-m', 'init'], root);
  return root;
};

// Deterministic, strictly increasing timestamps — two same-content mints must never collide into
// the store's byte-identical replay refusal.
let tick = 0;
const now = () => `2026-07-30T01:00:${String((tick += 1) % 60).padStart(2, '0')}.${String(tick).padStart(3, '0')}Z`;
const run = (root, argv) => main(argv, { cwd: root, env: {}, now });

const storeOf = (root) => readFlowStore(resolveFlowStorePath(root, {}));

const planFile = (root, name, body) => {
  writeFileSync(join(root, 'docs', 'plans', name), body);
  return `docs/plans/${name}`;
};

const adopt = (root, planId = 'plan-a') => {
  const rel = planFile(root, `${planId}.md`, `---\nplanId: ${planId}\n---\n# ${planId}\n`);
  const r = run(root, ['adoption', rel]);
  assert.equal(r.code, 0, r.stderr);
  return rel;
};

// A legal step-opening round appended as a FIXTURE (round minting is a Plan-4 writer arm).
const openRound = (root, planId = 'plan-a') => {
  const records = storeOf(root).records;
  const adoption = records.find((r) => r.kind === CHAIN_KIND && r.purpose === 'adoption' && r.planId === planId);
  const record = {
    schema: FLOW_SCHEMA_VERSION, kind: CHAIN_KIND, purpose: 'round', planId, cycle: adoption.cycle,
    round: 1, commitEpoch: adoption.commitEpoch, owner: adoption.owner, base: resolveBase(root),
    timestamp: now(), stepId: 'step-1', fingerprint: computeTreeFingerprint(root),
    opensFrom: canonicalFlowDigest(adoption), dispatches: [], dispositions: [],
  };
  appendFlowRecord({ cwd: root, record, env: {} });
  return record;
};

describe('flow-writer — write-plan-id (#58: bounded, contained-atomic, idempotent)', () => {
  it('prepends a closed frontmatter block to a plan without one, round-tripping the adoption parser', () => {
    const root = makeRepo();
    const rel = planFile(root, 'fresh.md', '# a plan\nbody\n');
    const r = run(root, ['write-plan-id', rel, '--plan-id', 'fresh-1']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /wrote planId "fresh-1"/);
    const text = readFileSync(join(root, rel), 'utf8');
    assert.equal(readPlanFrontmatterId(text), 'fresh-1');
    assert.ok(text.endsWith('# a plan\nbody\n'), 'the plan body is untouched');
  });

  it('inserts into an existing closed frontmatter block, preserving its other lines', () => {
    const root = makeRepo();
    const rel = planFile(root, 'fm.md', '---\nowner: someone\n---\nbody\n');
    const r = run(root, ['write-plan-id', rel, '--plan-id', 'fm-1']);
    assert.equal(r.code, 0, r.stderr);
    const text = readFileSync(join(root, rel), 'utf8');
    assert.equal(readPlanFrontmatterId(text), 'fm-1');
    assert.match(text, /owner: someone/);
  });

  it('the SAME id is an idempotent no-op — bytes untouched, exit 0', () => {
    const root = makeRepo();
    const rel = planFile(root, 'idem.md', '---\nplanId: idem-1\n---\nbody\n');
    const before = readFileSync(join(root, rel), 'utf8');
    const r = run(root, ['write-plan-id', rel, '--plan-id', 'idem-1']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /idempotent no-op; nothing written/);
    assert.equal(readFileSync(join(root, rel), 'utf8'), before);
  });

  it('a DIFFERENT existing id refuses — chain identity never silently changes', () => {
    const root = makeRepo();
    const rel = planFile(root, 'other.md', '---\nplanId: other-1\n---\nbody\n');
    const before = readFileSync(join(root, rel), 'utf8');
    const r = run(root, ['write-plan-id', rel, '--plan-id', 'other-2']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already carries planId "other-1" — a DIFFERENT id refuses/);
    assert.equal(readFileSync(join(root, rel), 'utf8'), before);
  });

  it('write-plan-id refuses a backslash byte before any read — forward-slash is the only separator', () => {
    const root = makeRepo();
    const r = run(root, ['write-plan-id', 'docs/plans/..\\outside.md', '--plan-id', 'x']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /backslash/);
  });

  it('a plan file with invalid UTF-8 refuses before any write — a lossy rewrite never corrupts bytes', () => {
    const root = makeRepo();
    const rel = 'docs/plans/mojibake.md';
    const bytes = Buffer.concat([Buffer.from('# plan\n'), Buffer.from([0xff, 0xfe, 0x41]), Buffer.from('\n')]);
    writeFileSync(join(root, rel), bytes);
    const r = run(root, ['write-plan-id', rel, '--plan-id', 'x1']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not valid UTF-8/);
    assert.deepEqual(readFileSync(join(root, rel)), bytes, 'the original bytes stay untouched');
  });

  it('abuse lanes refuse: absent file · outside docs/plans/ · traversal · symlink · bad id', () => {
    const root = makeRepo();
    assert.match(run(root, ['write-plan-id', 'docs/plans/absent.md', '--plan-id', 'x']).stderr, /does not exist — write-plan-id targets an EXISTING regular plan file/);
    assert.match(run(root, ['write-plan-id', 'base.txt', '--plan-id', 'x']).stderr, /must live under docs\/plans\//);
    assert.match(run(root, ['write-plan-id', 'docs/plans/../evil.md', '--plan-id', 'x']).stderr, /without "\." or "\.\." segments/);
    const target = planFile(root, 'real.md', 'body\n');
    symlinkSync(join(root, target), join(root, 'docs', 'plans', 'link.md'));
    assert.match(run(root, ['write-plan-id', 'docs/plans/link.md', '--plan-id', 'x']).stderr, /is a symlink — refusing/);
    const badId = run(root, ['write-plan-id', target, '--plan-id', 'two words']);
    assert.equal(badId.code, 2);
    assert.match(badId.stderr, /single non-whitespace token/);
  });
});

describe('flow-writer — adoption + the plan lane (park/resume/complete round-trip)', () => {
  it('write-plan-id → adoption round-trips through a real store, reporting the record digest', () => {
    const root = makeRepo();
    const rel = planFile(root, 'p1.md', '# p1\n');
    assert.equal(run(root, ['write-plan-id', rel, '--plan-id', 'p1']).code, 0);
    const r = run(root, ['adoption', rel, '--label', 'Plan One']);
    assert.equal(r.code, 0, r.stderr);
    const records = storeOf(root).records;
    assert.equal(records.length, 1);
    assert.equal(records[0].purpose, 'adoption');
    assert.equal(records[0].planId, 'p1');
    assert.equal(records[0].planLabel, 'Plan One');
    assert.ok(r.stdout.includes(canonicalFlowDigest(records[0])), 'the reported digest is the per-record canonical digest');
  });

  it('adoption of a plan without a frontmatter planId surfaces the mint refusal', () => {
    const root = makeRepo();
    const rel = planFile(root, 'noid.md', '# no id\n');
    const r = run(root, ['adoption', rel]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /carries no frontmatter planId/);
  });

  it('park → resume → complete round-trips; each record carries the walk-derived cycle/round and the live tree identity', () => {
    const root = makeRepo();
    adopt(root);
    for (const arm of ['park', 'resume', 'complete']) {
      const r = run(root, [arm, 'plan-a']);
      assert.equal(r.code, 0, `${arm}: ${r.stderr}`);
      assert.match(r.stdout, new RegExp(`appended chain/${arm} for plan "plan-a"`));
    }
    const purposes = storeOf(root).records.map((r) => r.purpose);
    assert.deepEqual(purposes, ['adoption', 'park', 'resume', 'complete']);
    for (const r of storeOf(root).records.slice(1)) {
      assert.equal(r.cycle, 1);
      assert.equal(r.round, 0, 'plan-lane records preserve the pre-park boundary round');
      assert.equal(r.stepId, null);
      assert.equal(r.owner, 'main');
    }
  });

  it('an illegal transition surfaces the store refusal VERBATIM — the writer adds no second validator', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['complete', 'plan-a']).code, 0);
    const r = run(root, ['park', 'plan-a']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\[agent-workflow-kit\] refusing an illegal chain record: chain sequence: complete admits no successor/);
    assert.ok(r.stderr.startsWith('[agent-workflow-kit] '), `a store STOP passes through UNPREFIXED — byte-verbatim; got: ${r.stderr}`);
  });

  it('a foreign worktree chain refuses by name — chain records are minted from their own worktree only (#57)', () => {
    const root = makeRepo();
    adopt(root);
    const wt = join(TMP, `wt-${seq += 1}`);
    sh(['worktree', 'add', '-q', wt], root);
    const r = run(wt, ['park', 'plan-a']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /owned by "main" \(a foreign worktree\)/);
  });

  it('a leading-dash planId stays fully recoverable — the -- terminator and --flag=value forms', () => {
    const root = makeRepo();
    const rel = planFile(root, 'dash.md', '# dash\n');
    assert.equal(run(root, ['write-plan-id', rel, '--plan-id=-weird']).code, 0);
    assert.equal(run(root, ['adoption', rel]).code, 0);
    const parked = run(root, ['park', '--', '-weird']);
    assert.equal(parked.code, 0, parked.stderr);
    assert.equal(storeOf(root).records.at(-1).purpose, 'park');
    const cause = run(root, ['rerun-cause', '--attempt=-a1', '--cause=confirmed retry']);
    assert.equal(cause.code, 0, cause.stderr);
    assert.equal(storeOf(root).records.at(-1).attempt, '-a1');
  });

  it('an unadopted plan names the adoption arm as its recovery', () => {
    const root = makeRepo();
    const r = run(root, ['park', 'ghost']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no chain in the flow store — adoption is a chain's first record/);
  });
});

describe('flow-writer — the pasteable-recovery loop (Decision 3: refusals paste-run green)', () => {
  it('flow-check prints the park command; running that exact arm turns flow-check green', () => {
    const root = makeRepo();
    adopt(root);
    openRound(root);
    const refused = runFlowCheck({ cwd: root });
    assert.equal(refused.code, 1);
    const line = refused.lines.find((l) => l.includes('OPEN chain'));
    assert.ok(line.includes(`recovery (pasteable): node ${q(WRITER_TOOL)} park -- ${q('plan-a')}`), `the refusal carries the verbatim writer command; got: ${line}`);
    assert.equal(run(root, ['park', '--', 'plan-a']).code, 0);
    const after = runFlowCheck({ cwd: root });
    assert.equal(after.code, 0, `flow-check must pass after the pasted park: ${after.lines.join('\n')}`);
  });
});

describe('flow-writer — refresh + re-baseline', () => {
  it('refresh binds an existing record: fingerprintBefore = the target record\'s tree fingerprint', () => {
    const root = makeRepo();
    adopt(root);
    const round = openRound(root);
    const r = run(root, ['refresh', 'plan-a', '--cause', 're-attest', '--refreshed-record', canonicalFlowDigest(round)]);
    assert.equal(r.code, 0, r.stderr);
    const refresh = storeOf(root).records.at(-1);
    assert.equal(refresh.purpose, 'refresh');
    assert.equal(refresh.fingerprintBefore, round.fingerprint);
    assert.equal(refresh.fingerprintAfter, computeTreeFingerprint(root));
    assert.equal(refresh.stepId, 'step-1');
  });

  it('refresh with no open step refuses — a refresh is a within-step re-attestation', () => {
    const root = makeRepo();
    adopt(root);
    const r = run(root, ['refresh', 'plan-a', '--cause', 'x', '--refreshed-record', 'ab'.repeat(32)]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no open step/);
  });

  it('refresh with an unresolvable target digest refuses by name', () => {
    const root = makeRepo();
    adopt(root);
    openRound(root);
    const r = run(root, ['refresh', 'plan-a', '--cause', 'x', '--refreshed-record', 'ab'.repeat(32)]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no record in the flow store digests to/);
  });

  it('re-baseline records the pre-motion base after a real base move', () => {
    const root = makeRepo();
    adopt(root);
    const before = resolveBase(root);
    writeFileSync(join(root, 'base.txt'), 'moved\n');
    sh(['add', '-A'], root);
    sh(['commit', '-q', '-m', 'move base'], root);
    const after = resolveBase(root);
    assert.notEqual(before, after);
    const r = run(root, ['re-baseline', 'plan-a']);
    assert.equal(r.code, 0, r.stderr);
    const rec = storeOf(root).records.at(-1);
    assert.equal(rec.purpose, 're-baseline');
    assert.equal(rec.baseBefore, before);
    assert.equal(rec.base, after);
    assert.equal(rec.stepId, null, 'a boundary re-baseline after adoption anchors to the adoption terminal');
  });
});

describe('flow-writer — the global kinds (rerun-cause, down-mark family, degrade-justification)', () => {
  it('rerun-cause binds the CURRENT tree — fingerprint and base are computed, never hand-supplied', () => {
    const root = makeRepo();
    const r = run(root, ['rerun-cause', '--attempt', 'a-7', '--cause', 'flaky fixture confirmed']);
    assert.equal(r.code, 0, r.stderr);
    const rec = storeOf(root).records.at(-1);
    assert.deepEqual([rec.kind, rec.attempt, rec.cause], ['rerun-cause', 'a-7', 'flaky fixture confirmed']);
    assert.equal(rec.fingerprint, computeTreeFingerprint(root));
    assert.equal(rec.base, resolveBase(root));
  });

  it('down-mark lands; a second mark for the same backend surfaces the store supersession refusal verbatim', () => {
    const root = makeRepo();
    const mint = () => run(root, ['down-mark', '--backend', 'codex', '--reason', 'quota exhausted', '--expires-at', '2026-08-01T00:00:00.000Z']);
    assert.equal(mint().code, 0);
    const second = mint();
    assert.equal(second.code, 1);
    assert.match(second.stderr, /already carries an ACTIVE down-mark/);
  });

  it('down-mark-up auto-resolves the ACTIVE mark; with none it refuses by name', () => {
    const root = makeRepo();
    assert.equal(run(root, ['down-mark', '--backend', 'codex', '--reason', 'quota', '--expires-at', '2026-08-01T00:00:00.000Z']).code, 0);
    const mark = storeOf(root).records.at(-1);
    const up = run(root, ['down-mark-up', '--backend', 'codex']);
    assert.equal(up.code, 0, up.stderr);
    assert.equal(storeOf(root).records.at(-1).target, canonicalFlowDigest(mark));
    const again = run(root, ['down-mark-up', '--backend', 'codex']);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /no ACTIVE down-mark for backend "codex"/);
  });

  it('degrade-justification auto-resolves the active mark AND the core degrade at the current tree', () => {
    const root = makeRepo();
    assert.equal(run(root, ['down-mark', '--backend', 'agy', '--reason', 'headless flake', '--expires-at', '2026-08-01T00:00:00.000Z']).code, 0);
    const mark = storeOf(root).records.at(-1);
    const degrade = { schema: EVIDENCE_SCHEMA_VERSION, kind: 'degrade', backend: 'agy', reason: 'headless flake', fingerprint: computeTreeFingerprint(root), timestamp: now() };
    appendFileSync(join(root, '.git', EVIDENCE_BASENAME), `${JSON.stringify(degrade)}\n`);
    const r = run(root, ['degrade-justification', '--backend', 'agy']);
    assert.equal(r.code, 0, r.stderr);
    const rec = storeOf(root).records.at(-1);
    assert.equal(rec.kind, 'degrade-justification');
    assert.equal(rec.downMark, canonicalFlowDigest(mark));
    assert.equal(rec.degradeDigest, canonicalFlowDigest(degrade));
  });

  it('an expired down-mark never carries a justification — close it and mint a fresh mark (#25/#39)', () => {
    const root = makeRepo();
    appendFlowRecord({ cwd: root, env: {}, record: {
      schema: FLOW_SCHEMA_VERSION, kind: 'down-mark', fingerprint: computeTreeFingerprint(root),
      backend: 'agy', reason: 'quota', expiresAt: '2026-07-30T00:30:00.000Z',
      base: resolveBase(root), timestamp: '2026-07-30T00:00:00.000Z',
    } });
    const r = run(root, ['degrade-justification', '--backend', 'agy']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /outside its active window at mint time/);
    assert.match(r.stderr, /down-mark-clear/);
  });

  it("an explicit --down-mark digest must resolve to that backend's UNCLOSED down-mark", () => {
    const root = makeRepo();
    const unresolvable = run(root, ['degrade-justification', '--backend', 'agy', '--down-mark', 'ab'.repeat(32)]);
    assert.equal(unresolvable.code, 1);
    assert.match(unresolvable.stderr, /no record in the flow store digests to/);
    assert.equal(run(root, ['down-mark', '--backend', 'codex', '--reason', 'x', '--expires-at', '2026-08-01T00:00:00.000Z']).code, 0);
    const foreign = storeOf(root).records.at(-1);
    const wrongBackend = run(root, ['degrade-justification', '--backend', 'agy', '--down-mark', canonicalFlowDigest(foreign)]);
    assert.equal(wrongBackend.code, 1);
    assert.match(wrongBackend.stderr, /a justification rides a down-mark of backend "agy"/);
  });

  it('an explicit --degrade-digest must EQUAL the authoritative core degrade at the current tree — foreign digests never mint', () => {
    const root = makeRepo();
    assert.equal(run(root, ['down-mark', '--backend', 'agy', '--reason', 'x', '--expires-at', '2026-09-01T00:00:00.000Z']).code, 0);
    const degrade = { schema: EVIDENCE_SCHEMA_VERSION, kind: 'degrade', backend: 'agy', reason: 'x', fingerprint: computeTreeFingerprint(root), timestamp: now() };
    appendFileSync(join(root, '.git', EVIDENCE_BASENAME), `${JSON.stringify(degrade)}\n`);
    const mismatched = run(root, ['degrade-justification', '--backend', 'agy', '--degrade-digest', 'ab'.repeat(32)]);
    assert.equal(mismatched.code, 1);
    assert.match(mismatched.stderr, /not the authoritative core degrade of backend "agy" at the current tree/);
    const exact = run(root, ['degrade-justification', '--backend', 'agy', '--degrade-digest', canonicalFlowDigest(degrade)]);
    assert.equal(exact.code, 0, exact.stderr);
  });

  it('degrade-justification without an active mark, and without a core degrade, refuses by name', () => {
    const root = makeRepo();
    const noMark = run(root, ['degrade-justification', '--backend', 'agy']);
    assert.equal(noMark.code, 1);
    assert.match(noMark.stderr, /no ACTIVE down-mark for backend "agy"/);
    assert.equal(run(root, ['down-mark', '--backend', 'agy', '--reason', 'x', '--expires-at', '2026-08-01T00:00:00.000Z']).code, 0);
    const noDegrade = run(root, ['degrade-justification', '--backend', 'agy']);
    assert.equal(noDegrade.code, 1);
    assert.match(noDegrade.stderr, /no core degrade record for backend "agy" at the current tree/);
  });
});

describe('flow-writer — maintainer-override (#38/#56: the bound set prints; the flag gates)', () => {
  const RECEIPT_FIXTURE = {
    schema: 1, artifact: 'code', fresh: true, fingerprint: 'x'.repeat(64), backend: 'codex',
    verdict: 'revise', grounded: true, factsHash: null, wrapperVersion: '2.2.0',
    timestamp: '2026-07-30T00:00:00Z', probe: false, posture: { model: 'gpt-5.2-codex' },
  };
  const mintVetoReceipt = (root, over = {}) => {
    const receipt = { ...RECEIPT_FIXTURE, fingerprint: computeTreeFingerprint(root), ...over };
    appendFileSync(join(root, '.git', RECEIPTS_BASENAME), `${JSON.stringify(receipt)}\n`);
    return receipt;
  };

  it('without --checkpoint-approved: the FULL bound set prints, nothing is written, exit 1', () => {
    const root = makeRepo();
    adopt(root);
    const receipt = mintVetoReceipt(root);
    const before = storeOf(root).records.length;
    const r = run(root, ['maintainer-override', 'plan-a', '--backend', 'codex']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /requires the explicit --checkpoint-approved flag \(#38\)/);
    assert.match(r.stdout, /the FULL bound set about to be recorded/);
    assert.ok(r.stdout.includes(`vetoReceiptDigest: ${canonicalFlowDigest(receipt)}`));
    assert.match(r.stdout, /verdict: "revise"/);
    assert.match(r.stdout, /supersedes: null \(the first override of this veto instance\)/);
    assert.equal(storeOf(root).records.length, before, 'nothing was written');
  });

  it('with the flag: the override lands binding {receipt digest, backend, verdict, base, fingerprint, chainRecord}', () => {
    const root = makeRepo();
    adopt(root);
    const receipt = mintVetoReceipt(root);
    const chainTail = storeOf(root).records.at(-1);
    const r = run(root, ['maintainer-override', 'plan-a', '--backend', 'codex', '--checkpoint-approved']);
    assert.equal(r.code, 0, r.stderr);
    const rec = storeOf(root).records.at(-1);
    assert.equal(rec.kind, 'maintainer-override');
    assert.equal(rec.vetoReceiptDigest, canonicalFlowDigest(receipt));
    assert.equal(rec.verdict, 'revise');
    assert.equal(rec.chainRecord, canonicalFlowDigest(chainTail));
    assert.equal(rec.supersedes, null);
    assert.equal(rec.fingerprint, computeTreeFingerprint(root));
  });

  it('a second override of the same veto instance supersedes the CURRENT head automatically', () => {
    const root = makeRepo();
    adopt(root);
    mintVetoReceipt(root);
    assert.equal(run(root, ['maintainer-override', 'plan-a', '--backend', 'codex', '--checkpoint-approved']).code, 0);
    const first = storeOf(root).records.at(-1);
    const r = run(root, ['maintainer-override', 'plan-a', '--backend', 'codex', '--checkpoint-approved']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(storeOf(root).records.at(-1).supersedes, canonicalFlowDigest(first));
  });

  it('with no current-tree receipt of the backend the mint refuses by name', () => {
    const root = makeRepo();
    adopt(root);
    const r = run(root, ['maintainer-override', 'plan-a', '--backend', 'codex', '--checkpoint-approved']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no current-tree review receipt of backend "codex" to override/);
  });

  it('a ship-class receipt never mints an override — only the recognized NEGATIVE class is overridable', () => {
    const root = makeRepo();
    adopt(root);
    mintVetoReceipt(root, { verdict: 'ship' });
    const r = run(root, ['maintainer-override', 'plan-a', '--backend', 'codex', '--checkpoint-approved']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not a recognized NEGATIVE/);
  });

  it("an explicit --chain-record must belong to the NAMED plan's chain — a foreign chain never binds", () => {
    const root = makeRepo();
    adopt(root);
    mintVetoReceipt(root);
    const r = run(root, ['maintainer-override', 'plan-a', '--backend', 'codex', '--checkpoint-approved', '--chain-record', 'ab'.repeat(32)]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /does not resolve to a record of plan "plan-a"'s chain/);
  });

  it('an override never binds a partially read receipts store — malformed or unreadable fails closed', () => {
    const root = makeRepo();
    adopt(root);
    mintVetoReceipt(root);
    appendFileSync(join(root, '.git', RECEIPTS_BASENAME), 'not json\n');
    const mixed = run(root, ['maintainer-override', 'plan-a', '--backend', 'codex', '--checkpoint-approved']);
    assert.equal(mixed.code, 1);
    assert.match(mixed.stderr, /carries 1 malformed line/);
    chmodSync(join(root, '.git', RECEIPTS_BASENAME), 0o000);
    try {
      const unreadable = run(root, ['maintainer-override', 'plan-a', '--backend', 'codex', '--checkpoint-approved']);
      assert.equal(unreadable.code, 1);
      assert.match(unreadable.stderr, /receipts store is unreadable/);
    } finally {
      chmodSync(join(root, '.git', RECEIPTS_BASENAME), 0o644);
    }
  });

  it('a SYMLINKED receipts store never reads through — the override refuses fail-closed (RECEIPTS-READER-NOFOLLOW)', () => {
    const root = makeRepo();
    adopt(root);
    const real = join(root, '.git', 'real-receipts.jsonl');
    writeFileSync(real, `${JSON.stringify({ ...RECEIPT_FIXTURE, fingerprint: computeTreeFingerprint(root) })}\n`);
    symlinkSync('real-receipts.jsonl', join(root, '.git', RECEIPTS_BASENAME));
    const r = run(root, ['maintainer-override', 'plan-a', '--backend', 'codex', '--checkpoint-approved']);
    assert.equal(r.code, 1, 'a symlinked store must never bind an override, however valid its target content');
    assert.match(r.stderr, /receipts store is unreadable/);
    assert.match(r.stderr, /symlink/);
  });

  it("an explicit --veto-receipt must be the backend's authoritative CURRENT-tree receipt", () => {
    const root = makeRepo();
    adopt(root);
    const stale = { ...RECEIPT_FIXTURE, fingerprint: 'ab'.repeat(32) };
    appendFileSync(join(root, '.git', RECEIPTS_BASENAME), `${JSON.stringify(stale)}\n`);
    mintVetoReceipt(root);
    const r = run(root, ['maintainer-override', 'plan-a', '--backend', 'codex', '--checkpoint-approved', '--veto-receipt', canonicalFlowDigest(stale)]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not the backend's authoritative CURRENT-tree receipt/);
  });
});

// The consult-attestation arm (Phase 4.2, Decision 8): findingDigest is COMPUTED from the
// {backend, nonce}-named finding manifest beside the receipts file — the round-trip named test
// P29 demands, plus every fail-closed lane.
describe('flow-writer — consult-attestation (manifest → attestation round-trip)', () => {
  const MANIFEST_FINDINGS = '[major] — a.txt:1 — x — y\nVerdict: revise\n';
  const writeManifest = (root, backend, nonce, overrides = {}) => {
    const manifest = { schema: FLOW_SCHEMA_VERSION, backend, nonce, fingerprint: 'c'.repeat(64), findings: MANIFEST_FINDINGS, ...overrides };
    writeFileSync(join(root, '.git', `agent-workflow-finding-manifest-${backend}-${nonce}.json`), `${JSON.stringify(manifest)}\n`);
    return manifest;
  };

  it('round-trips manifest → attestation record: {backend, nonce, findingDigest} from the manifest, proposedFixDigest explicit, step context from the chain walk', () => {
    const root = makeRepo();
    adopt(root);
    openRound(root);
    writeManifest(root, 'codex', 'nx7');
    const fix = 'd'.repeat(64);
    const r = run(root, ['consult-attestation', 'plan-a', '--backend', 'codex', '--nonce', 'nx7', '--proposed-fix-digest', fix]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /appended consult-attestation — digest [0-9a-f]{64}/);
    const record = storeOf(root).records.at(-1);
    assert.equal(record.kind, 'consult-attestation');
    assert.equal(record.backend, 'codex');
    assert.equal(record.nonce, 'nx7');
    assert.equal(record.planId, 'plan-a');
    assert.equal(record.stepId, 'step-1');
    assert.equal(record.round, 1);
    assert.equal(record.findingDigest, createHash('sha256').update(MANIFEST_FINDINGS, 'utf8').digest('hex'), 'findingDigest = sha256 of the manifest findings payload — never hand-supplied');
    assert.equal(record.proposedFixDigest, fix);
    assert.equal(record.fingerprint, computeTreeFingerprint(root));
  });

  it('refuses without an open step — a consult binds an open step round', () => {
    const root = makeRepo();
    adopt(root);
    writeManifest(root, 'codex', 'nx7');
    const r = run(root, ['consult-attestation', 'plan-a', '--backend', 'codex', '--nonce', 'nx7', '--proposed-fix-digest', 'd'.repeat(64)]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no open step — a consult-attestation binds an open step's round/);
  });

  it('refuses fail-closed on a MISSING manifest, naming the {backend, nonce} path', () => {
    const root = makeRepo();
    adopt(root);
    openRound(root);
    const r = run(root, ['consult-attestation', 'plan-a', '--backend', 'codex', '--nonce', 'nx7', '--proposed-fix-digest', 'd'.repeat(64)]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no readable finding manifest for \{backend "codex", nonce "nx7"\}/);
  });

  it('refuses a MALFORMED manifest: invalid JSON, a stray key, and an empty findings payload each by name', () => {
    const root = makeRepo();
    adopt(root);
    openRound(root);
    const path = join(root, '.git', 'agent-workflow-finding-manifest-codex-nx7.json');
    const attempt = () => run(root, ['consult-attestation', 'plan-a', '--backend', 'codex', '--nonce', 'nx7', '--proposed-fix-digest', 'd'.repeat(64)]);
    writeFileSync(path, 'not json\n');
    assert.match(attempt().stderr, /not valid JSON/);
    writeManifest(root, 'codex', 'nx7', { extra: true });
    assert.match(attempt().stderr, /unknown field "extra"/);
    writeManifest(root, 'codex', 'nx7', { findings: '' });
    assert.match(attempt().stderr, /findings must be the non-empty captured findings payload/);
  });

  it('refuses a manifest carrying INVALID UTF-8 by name — a lossy decode never enters the findingDigest domain', () => {
    const root = makeRepo();
    adopt(root);
    openRound(root);
    const bytes = Buffer.concat([
      Buffer.from('{"schema":1,"backend":"codex","nonce":"nx7","fingerprint":null,"findings":"x'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('y"}'),
    ]);
    writeFileSync(join(root, '.git', 'agent-workflow-finding-manifest-codex-nx7.json'), bytes);
    const r = run(root, ['consult-attestation', 'plan-a', '--backend', 'codex', '--nonce', 'nx7', '--proposed-fix-digest', 'd'.repeat(64)]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /UTF-8/, 'invalid bytes refuse by name — a U+FFFD-substituted text must never be digested');
  });

  it('refuses a findings string carrying a LONE SURROGATE by name — ill-formed UTF-16 never reaches the findingDigest', () => {
    const root = makeRepo();
    adopt(root);
    openRound(root);
    writeFileSync(join(root, '.git', 'agent-workflow-finding-manifest-codex-nx7.json'), '{"schema":1,"backend":"codex","nonce":"nx7","fingerprint":null,"findings":"x\\ud800y"}\n');
    const r = run(root, ['consult-attestation', 'plan-a', '--backend', 'codex', '--nonce', 'nx7', '--proposed-fix-digest', 'd'.repeat(64)]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /well-formed Unicode/);
  });

  it('a FIFO manifest refuses FAST in a child run — the consult read never blocks (watchdog-proven)', () => {
    const root = makeRepo();
    adopt(root);
    openRound(root);
    assert.equal(spawnSync('mkfifo', [join(root, '.git', 'agent-workflow-finding-manifest-codex-nx7.json')], { encoding: 'utf8' }).status, 0, 'mkfifo fixture');
    const r = spawnSync(process.execPath, [WRITER_TOOL, 'consult-attestation', 'plan-a', '--backend', 'codex', '--nonce', 'nx7', '--proposed-fix-digest', 'd'.repeat(64)], {
      cwd: root, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(r.signal, null, 'the child must refuse, never hang into the watchdog');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a regular file/);
  });

  it('refuses a SYMLINKED manifest by class — an attestation never binds through a link', () => {
    const root = makeRepo();
    adopt(root);
    openRound(root);
    const real = join(root, '.git', 'real-manifest-target.json');
    writeFileSync(real, `${JSON.stringify({ schema: FLOW_SCHEMA_VERSION, backend: 'codex', nonce: 'nx7', fingerprint: 'c'.repeat(64), findings: MANIFEST_FINDINGS })}\n`);
    symlinkSync(real, join(root, '.git', 'agent-workflow-finding-manifest-codex-nx7.json'));
    const r = run(root, ['consult-attestation', 'plan-a', '--backend', 'codex', '--nonce', 'nx7', '--proposed-fix-digest', 'd'.repeat(64)]);
    assert.equal(r.code, 1, 'a link at the derived name must never mint — the wrapper mints regular files only');
    assert.match(r.stderr, /symlink/);
  });

  it('refuses a FOREIGN-identity manifest (bytes declaring another backend at the derived name)', () => {
    const root = makeRepo();
    adopt(root);
    openRound(root);
    writeManifest(root, 'codex', 'nx7', { backend: 'agy' });
    const r = run(root, ['consult-attestation', 'plan-a', '--backend', 'codex', '--nonce', 'nx7', '--proposed-fix-digest', 'd'.repeat(64)]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /foreign-identity manifest never mints/);
  });

  it('usage lanes: an unsafe nonce and a malformed --proposed-fix-digest refuse as usage (exit 2)', () => {
    const root = makeRepo();
    adopt(root);
    openRound(root);
    const bad = run(root, ['consult-attestation', 'plan-a', '--backend', 'codex', '--nonce', '../escape', '--proposed-fix-digest', 'd'.repeat(64)]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /safe nonce grammar/);
    const fix = run(root, ['consult-attestation', 'plan-a', '--backend', 'codex', '--nonce', 'nx7', '--proposed-fix-digest', 'zz']);
    assert.equal(fix.code, 2);
    assert.match(fix.stderr, /--proposed-fix-digest must be a 64-hex/);
  });
});

describe('flow-writer — coverage characterizations (green pins)', () => {
  it('an explicit --down-mark digest of a CLOSED mark refuses at the writer pre-check too', () => {
    const root = makeRepo();
    assert.equal(run(root, ['down-mark', '--backend', 'codex', '--reason', 'x', '--expires-at', '2026-09-01T00:00:00.000Z']).code, 0);
    const mark = storeOf(root).records.at(-1);
    assert.equal(run(root, ['down-mark-up', '--backend', 'codex']).code, 0);
    const r = run(root, ['degrade-justification', '--backend', 'codex', '--down-mark', canonicalFlowDigest(mark)]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already closed by up\/clear/);
  });

  it('a malformed core evidence store fails the justification closed before any resolution', () => {
    const root = makeRepo();
    assert.equal(run(root, ['down-mark', '--backend', 'codex', '--reason', 'x', '--expires-at', '2026-09-01T00:00:00.000Z']).code, 0);
    appendFileSync(join(root, '.git', EVIDENCE_BASENAME), 'not json\n');
    const r = run(root, ['degrade-justification', '--backend', 'codex']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /core evidence store is unreadable or malformed/);
  });

  it('the compose-vs-parse round-trip guard refuses under a drifted parser — the drift contract is real', () => {
    assert.equal(composePlanIdFrontmatter('# body\n', 'x1').startsWith('---\nplanId: x1\n---\n'), true);
    assert.throws(() => composePlanIdFrontmatter('# body\n', 'x1', () => null), /does not round-trip to planId "x1"/);
  });

  it('the CLI entry runs as a child process (--help, exit 0)', () => {
    const r = spawnSync(process.execPath, [WRITER_TOOL, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /the store preflight is the single legality door/);
  });
});

describe('flow-writer — usage lanes (exit 2)', () => {
  it('unknown arm, missing flags, malformed digests, and duplicate flags refuse as usage', () => {
    const root = makeRepo();
    assert.equal(run(root, ['frobnicate']).code, 2);
    assert.match(run(root, ['frobnicate']).stderr, /unknown arm "frobnicate"/);
    assert.equal(run(root, ['park']).code, 2);
    assert.equal(run(root, ['rerun-cause', '--attempt', 'a-1']).code, 2);
    assert.equal(run(root, ['refresh', 'p', '--cause', 'x', '--refreshed-record', 'zz']).code, 2);
    assert.equal(run(root, ['down-mark-up', '--backend', 'b', '--backend', 'c']).code, 2);
    const help = run(root, []);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /the store preflight is the single legality door/);
  });
});

// ── Plan 4 Phase 3: the round machinery (round-open · round-land · freeze · unfreeze ·
// converged) + the internal-attestation arm with the #68 arming predicate. The arm --help usage
// lines ARE the public contract (pinned below); digests are computed FROM real files, never
// hand-supplied; every design cap is enforced at the arm and every cap refusal is self-servable
// (Decision 8 — an over-cap mint rides an explicit --justification, never a human wait-state).

const RECEIPT_BASE = {
  schema: 1, artifact: 'code', fresh: true, backend: 'codex', verdict: 'ship', grounded: true,
  factsHash: null, wrapperVersion: '2.2.0', probe: false, posture: { model: 'gpt-5.2-codex' },
};
const sha256hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const receiptsFile = (root) => join(root, '.git', RECEIPTS_BASENAME);
const lastRound = (root) => storeOf(root).records.findLast((r) => r.kind === CHAIN_KIND && r.purpose === 'round');
const appendReceipt = (root, over = {}) => {
  const receipt = { ...RECEIPT_BASE, fingerprint: computeTreeFingerprint(root), timestamp: now(), ...over };
  appendFileSync(receiptsFile(root), `${JSON.stringify(receipt)}\n`);
  return receipt;
};
const writeRoundManifest = (root, backend, nonce, over = {}) => {
  const manifest = { schema: FLOW_SCHEMA_VERSION, backend, nonce, fingerprint: computeTreeFingerprint(root), findings: 'Verdict: ship\n', ...over };
  const bytes = Buffer.from(JSON.stringify(manifest));
  writeFileSync(join(root, '.git', `agent-workflow-finding-manifest-${backend}-${nonce}.json`), bytes);
  return { manifest, bytes };
};
// Land the CURRENT round's codex dispatch (receipt + manifest at the round's own tree; the
// receipt carries the dispatch nonce — the wrapper stamps AW_REVIEW_NONCE, the matcher requires
// exact equality).
const landCurrentRound = (root, { verdict = 'ship', planId = 'plan-a' } = {}) => {
  const round = storeOf(root).records.findLast((r) => r.kind === CHAIN_KIND && r.purpose === 'round' && r.planId === planId);
  const entry = round.dispatches[0];
  appendReceipt(root, { fingerprint: round.fingerprint, verdict, nonce: entry.dispatchNonce });
  writeRoundManifest(root, entry.backend, entry.dispatchNonce, { fingerprint: round.fingerprint });
  const landed = run(root, ['round-land', planId]);
  assert.equal(landed.code, 0, landed.stderr);
  return lastRound(root);
};
// One full open→arrive→land cycle for backend codex; returns the landed round head. A --step
// matching the open step is legal in-step too, so the helper always names it.
const openAndLandRound = (root, { step = 'step-1', verdict = 'ship' } = {}) => {
  const opened = run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', step]);
  assert.equal(opened.code, 0, opened.stderr);
  return landCurrentRound(root, { verdict });
};

describe('flow-writer — round-open (the pre-dispatch half, #41)', () => {
  it('boundary opener mints round 1 with opensFrom = the prior terminal, one ledger entry per --backend, and the dispatch-line stdout contract', () => {
    const root = makeRepo();
    adopt(root);
    const adoption = storeOf(root).records[0];
    const r = run(root, ['round-open', 'plan-a', '--backend', 'codex', '--backend', 'agy', '--step', 'step-1']);
    assert.equal(r.code, 0, r.stderr);
    const round = lastRound(root);
    assert.equal(round.round, 1);
    assert.equal(round.stepId, 'step-1');
    assert.equal(round.opensFrom, canonicalFlowDigest(adoption));
    assert.deepEqual(round.dispositions, []);
    assert.equal(round.dispatches.length, 2);
    for (const [i, backend] of [['0', 'codex'], ['1', 'agy']].map(([i, b]) => [Number(i), b])) {
      const d = round.dispatches[i];
      assert.equal(d.backend, backend);
      assert.equal(d.dispatchBase, round.base, 'dispatchBase equals the round base — the #42 coverage shape');
      assert.equal(d.receiptWatermark, 0, 'an absent receipts store mints watermark 0');
      assert.match(d.dispatchNonce, /^[0-9a-f]{32}$/);
      assert.equal(d.receiptDigest, null);
      assert.equal(d.findingManifestDigest, null);
      assert.match(r.stdout, new RegExp(`dispatch backend=${backend} nonce=${d.dispatchNonce} watermark=0`), 'the stdout dispatch line is the bridge/receipt-deadline contract');
    }
    assert.match(r.stdout, /dispatch with --nonce [0-9a-f]{32} /, 'the hint names the plain-argument wrapper lane (FLOW-NONCE-DISPATCH-LANE)');
    assert.match(r.stdout, /AW_REVIEW_NONCE/);
    assert.match(r.stdout, /receipt-deadline/);
  });

  it('the watermark is the live receipts-file byte length; an unterminated tail refuses the mint', () => {
    const root = makeRepo();
    adopt(root);
    appendReceipt(root);
    const length = readFileSync(receiptsFile(root)).byteLength;
    const r = run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(lastRound(root).dispatches[0].receiptWatermark, length);
    const root2 = makeRepo();
    adopt(root2);
    appendFileSync(receiptsFile(root2), '{"backend":"codex"');
    const refused = run(root2, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /ends in an unterminated line/);
  });

  it('an in-step round-open (the fingerprint-move lane) opens the NEXT round with opensFrom null — never a revision', () => {
    const root = makeRepo();
    adopt(root);
    const first = openAndLandRound(root);
    const r = run(root, ['round-open', 'plan-a', '--backend', 'codex']);
    assert.equal(r.code, 0, r.stderr);
    const second = lastRound(root);
    assert.equal(second.round, 2);
    assert.equal(second.opensFrom, null);
    const firstHead = storeOf(root).records.findLast((x) => x.purpose === 'round' && x.round === 1);
    assert.equal(canonicalFlowDigest(firstHead), canonicalFlowDigest(first), 'the landed round-1 head stays byte-identical');
  });

  it('round-open refuses while the current round holds a pending unjustified dispatch — a new round would strand it unlandable', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const refused = run(root, ['round-open', 'plan-a', '--backend', 'codex']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /pending dispatch \{backend "codex"/);
    assert.match(refused.stderr, /round-land|degrade/);
    justifyDegrade(root, 'codex', lastRound(root).fingerprint);
    const allowed = run(root, ['round-open', 'plan-a', '--backend', 'codex']);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.equal(lastRound(root).round, 2);
  });

  it('HARD_MAX 3 rounds per cycle: round 4 refuses blind naming Decision 8, mints with --justification, and an in-cap justification refuses as usage', () => {
    const root = makeRepo();
    adopt(root);
    const inCap = run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1', '--justification', 'noise']);
    assert.equal(inCap.code, 2);
    assert.match(inCap.stderr, /rides only an over-cap mint/);
    for (let i = 0; i < 3; i += 1) openAndLandRound(root);
    const blind = run(root, ['round-open', 'plan-a', '--backend', 'codex']);
    assert.equal(blind.code, 1);
    assert.match(blind.stderr, /exceeds HARD_MAX 3 rounds per cycle/);
    assert.match(blind.stderr, /--justification/);
    assert.match(blind.stderr, /never a wait-for-maintainer/);
    const justified = run(root, ['round-open', 'plan-a', '--backend', 'codex', '--justification', 'fresh-eyes consult verdict: continue — new direction recorded']);
    assert.equal(justified.code, 0, justified.stderr);
    assert.equal(lastRound(root).round, 4);
    assert.match(justified.stdout, /justification \(Decision 8, over-cap mint/);
    assert.match(justified.stdout, /fresh-eyes consult verdict: continue/);
  });

  it('a foreign worktree chain refuses round-open by name (#57); boundary without --step and in-step --step mismatch refuse as usage', () => {
    const root = makeRepo();
    adopt(root);
    const wt = join(TMP, `wt-${seq += 1}`);
    sh(['worktree', 'add', '-q', wt], root);
    const foreign = run(wt, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']);
    assert.equal(foreign.code, 1);
    assert.match(foreign.stderr, /a foreign worktree/);
    const noStep = run(root, ['round-open', 'plan-a', '--backend', 'codex']);
    assert.equal(noStep.code, 2);
    assert.match(noStep.stderr, /requires --step/);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const mismatch = run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-9']);
    assert.equal(mismatch.code, 2);
    assert.match(mismatch.stderr, /does not match the open step/);
    const dup = run(root, ['round-open', 'plan-a', '--backend', 'codex', '--backend', 'codex', '--step', 'step-1']);
    assert.equal(dup.code, 2);
    assert.match(dup.stderr, /duplicate --backend/);
  });
});

describe('flow-writer — round-land (the post-arrival half, #42: digests from real files)', () => {
  it('lands an arrived dispatch IN PLACE: receiptDigest = the receipt line\'s canonical digest, findingManifestDigest = sha256 of the manifest bytes; ONE record per round, identity byte-equal', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const opened = lastRound(root);
    const entry = opened.dispatches[0];
    const receipt = appendReceipt(root, { fingerprint: opened.fingerprint, verdict: 'revise', nonce: entry.dispatchNonce });
    const { bytes } = writeRoundManifest(root, 'codex', entry.dispatchNonce, { fingerprint: opened.fingerprint, findings: '[major] — a.txt:1 — x — y\nVerdict: revise\n' });
    const r = run(root, ['round-land', 'plan-a']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /revised chain\/round/);
    assert.match(r.stdout, new RegExp(`landed backend=codex nonce=${entry.dispatchNonce}`));
    const head = lastRound(root);
    assert.equal(head.dispatches[0].receiptDigest, canonicalFlowDigest(receipt), 'the receipt digest is computed FROM the receipts file');
    assert.equal(head.dispatches[0].findingManifestDigest, sha256hex(bytes), 'the manifest digest is computed FROM the manifest bytes');
    for (const field of ['opensFrom', 'base', 'fingerprint', 'commitEpoch', 'cycle', 'round', 'stepId']) {
      assert.deepEqual(head[field], opened[field], `revision identity: ${field} stays byte-equal`);
    }
    const raw = storeOf(root).records.filter((x) => x.kind === CHAIN_KIND && x.purpose === 'round');
    assert.equal(raw.length, 2, 'a landing is a REVISION of the one round record, never a second round');
  });

  it('an ambiguous newer receipt set refuses; a foreign-tree receipt refuses; a foreign backend line never binds (stays pending → nothing to land)', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const round = lastRound(root);
    const nonce = round.dispatches[0].dispatchNonce;
    appendReceipt(root, { backend: 'agy', fingerprint: round.fingerprint, nonce });
    const foreignOnly = run(root, ['round-land', 'plan-a']);
    assert.equal(foreignOnly.code, 1);
    assert.match(foreignOnly.stderr, /nothing to land/);
    appendReceipt(root, { fingerprint: 'ab'.repeat(32), nonce });
    const foreignTree = run(root, ['round-land', 'plan-a']);
    assert.equal(foreignTree.code, 1);
    assert.match(foreignTree.stderr, /a foreign-tree receipt never binds this round/);
    appendReceipt(root, { fingerprint: round.fingerprint, nonce });
    const ambiguous = run(root, ['round-land', 'plan-a']);
    assert.equal(ambiguous.code, 1);
    assert.match(ambiguous.stderr, /an ambiguous newer set never binds a dispatch/);
  });

  it('an arrived receipt with a missing, symlinked, malformed, or foreign-identity manifest refuses the binding by class', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const round = lastRound(root);
    const nonce = round.dispatches[0].dispatchNonce;
    appendReceipt(root, { fingerprint: round.fingerprint, nonce });
    const missing = run(root, ['round-land', 'plan-a']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /finding manifest is missing/);
    const manifestPath = join(root, '.git', `agent-workflow-finding-manifest-codex-${nonce}.json`);
    writeFileSync(manifestPath, 'not json');
    assert.match(run(root, ['round-land', 'plan-a']).stderr, /is malformed/);
    writeRoundManifest(root, 'codex', nonce, { backend: 'agy' });
    assert.match(run(root, ['round-land', 'plan-a']).stderr, /foreign-identity manifest never binds/);
    rmSync(manifestPath);
    const real = join(root, '.git', 'real-round-manifest.json');
    writeFileSync(real, JSON.stringify({ schema: FLOW_SCHEMA_VERSION, backend: 'codex', nonce, fingerprint: round.fingerprint, findings: 'x\n' }));
    symlinkSync(real, manifestPath);
    const linked = run(root, ['round-land', 'plan-a']);
    assert.equal(linked.code, 1);
    assert.match(linked.stderr, /not a regular file/);
  });

  it('dispositions bind delivered findings: the quote must be a SUBSTRING of a landed manifest payload; findingDigest = sha256(quote); a folded proof must resolve', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const round = lastRound(root);
    const nonce = round.dispatches[0].dispatchNonce;
    appendReceipt(root, { fingerprint: round.fingerprint, verdict: 'revise', nonce });
    const finding = '[major] — a.txt:1 — the bug — the fix';
    writeRoundManifest(root, 'codex', nonce, { fingerprint: round.fingerprint, findings: `${finding}\nVerdict: revise\n` });
    assert.equal(run(root, ['round-land', 'plan-a']).code, 0);
    const absent = run(root, ['round-land', 'plan-a', '--dispose', 'rejected', '--finding', 'a finding nobody delivered', '--reason', 'x']);
    assert.equal(absent.code, 1);
    assert.match(absent.stderr, /not a substring of any landed finding-manifest payload/);
    const rejected = run(root, ['round-land', 'plan-a', '--dispose', 'rejected', '--finding', finding, '--reason', 'works as designed — see the header contract']);
    assert.equal(rejected.code, 0, rejected.stderr);
    const entry = lastRound(root).dispositions[0];
    assert.deepEqual(entry, {
      findingDigest: createHash('sha256').update(finding, 'utf8').digest('hex'),
      action: 'rejected', reason: 'works as designed — see the header contract',
    });
    const badProof = run(root, ['round-land', 'plan-a', '--dispose', 'folded', '--finding', finding, '--proof-kind', 'red-proof', '--proof-digest', 'ab'.repeat(32)]);
    assert.equal(badProof.code, 1);
    assert.match(badProof.stderr, /does not resolve to a red-proof/);
    const fix = 'd'.repeat(64);
    assert.equal(run(root, ['consult-attestation', 'plan-a', '--backend', 'codex', '--nonce', nonce, '--proposed-fix-digest', fix]).code, 0);
    const consult = storeOf(root).records.at(-1);
    // The duplicate-findingDigest guard is the record validator's — this second disposition rides
    // a DIFFERENT quote from the same payload.
    const folded = run(root, ['round-land', 'plan-a', '--dispose', 'folded', '--finding', 'Verdict: revise', '--proof-kind', 'consult-attestation', '--proof-digest', canonicalFlowDigest(consult)]);
    assert.equal(folded.code, 0, folded.stderr);
    assert.equal(lastRound(root).dispositions.length, 2);
    assert.equal(lastRound(root).dispositions[1].proofDigest, canonicalFlowDigest(consult));
  });

  it('round-land with no open step refuses; with nothing arrived and no --dispose it refuses as a no-op revision', () => {
    const root = makeRepo();
    adopt(root);
    const noStep = run(root, ['round-land', 'plan-a']);
    assert.equal(noStep.code, 1);
    assert.match(noStep.stderr, /no open step/);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const noop = run(root, ['round-land', 'plan-a']);
    assert.equal(noop.code, 1);
    assert.match(noop.stderr, /nothing to land/);
  });
});

describe('flow-writer — freeze · converged (no premature terminal) · unfreeze (cap 1)', () => {
  it('freeze refuses over an unlanded unjustified dispatch, proceeds once the backend is JUSTIFIED-degraded at the dispatched tree', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const round = lastRound(root);
    const refused = run(root, ['freeze', 'plan-a']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /no landed binding/);
    justifyDegrade(root, 'codex', round.fingerprint);
    const frozen = run(root, ['freeze', 'plan-a']);
    assert.equal(frozen.code, 0, frozen.stderr);
    assert.equal(storeOf(root).records.at(-1).purpose, 'freeze');
  });

  it('a landed non-ship receipt with an EMPTY disposition ledger refuses the terminal; a recorded disposition clears it; an all-ship round converges without dispositions', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const round = lastRound(root);
    const nonce = round.dispatches[0].dispatchNonce;
    appendReceipt(root, { fingerprint: round.fingerprint, verdict: 'revise', nonce });
    const finding = '[minor] — b.txt:2 — nit — polish';
    writeRoundManifest(root, 'codex', nonce, { fingerprint: round.fingerprint, findings: `${finding}\nVerdict: revise\n` });
    assert.equal(run(root, ['round-land', 'plan-a']).code, 0);
    const premature = run(root, ['converged', 'plan-a']);
    assert.equal(premature.code, 1);
    assert.match(premature.stderr, /disposition ledger is EMPTY/);
    assert.equal(run(root, ['round-land', 'plan-a', '--dispose', 'rejected', '--finding', finding, '--reason', 'cosmetic — queued policy covers it']).code, 0);
    const converged = run(root, ['converged', 'plan-a']);
    assert.equal(converged.code, 0, converged.stderr);
    const shipRoot = makeRepo();
    adopt(shipRoot);
    openAndLandRound(shipRoot);
    const clean = run(shipRoot, ['converged', 'plan-a']);
    assert.equal(clean.code, 0, clean.stderr);
    assert.equal(storeOf(shipRoot).records.at(-1).purpose, 'converged');
  });

  it('unfreeze reopens the frozen step; the second unfreeze in a cycle refuses naming the checkpoint and mints with --justification (Decision 8)', () => {
    const root = makeRepo();
    adopt(root);
    openAndLandRound(root);
    assert.equal(run(root, ['freeze', 'plan-a']).code, 0);
    const first = run(root, ['unfreeze', 'plan-a']);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(storeOf(root).records.at(-1).purpose, 'unfreeze');
    assert.equal(run(root, ['freeze', 'plan-a']).code, 0);
    const blind = run(root, ['unfreeze', 'plan-a']);
    assert.equal(blind.code, 1);
    assert.match(blind.stderr, /design checkpoint \(post-freeze cap: 1 unfreeze per cycle/);
    assert.match(blind.stderr, /--justification/);
    const justified = run(root, ['unfreeze', 'plan-a', '--justification', 'post-freeze bug: the landed fix regressed the guard']);
    assert.equal(justified.code, 0, justified.stderr);
    assert.match(justified.stdout, /justification \(Decision 8, over-cap mint/);
    const inCap = run(root, ['converged', 'plan-a']);
    assert.equal(inCap.code, 0, inCap.stderr);
    const boundary = run(root, ['unfreeze', 'plan-a', '--justification', 'reopening the converged terminal']);
    assert.equal(boundary.code, 0, boundary.stderr, 'a boundary unfreeze reopens the just-converged step (with the cycle cap already spent, justified)');
  });

  it('freeze/converged with no open step refuse by name; the terminal surfaces store transition refusals verbatim', () => {
    const root = makeRepo();
    adopt(root);
    for (const arm of ['freeze', 'converged']) {
      const r = run(root, [arm, 'plan-a']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /no open step/);
    }
  });
});

describe('flow-writer — internal-attestation (#28) + the #68 arming predicate', () => {
  it('a fully covered in-flight set mints, binding the open step context and the closed posture object', () => {
    const root = makeRepo();
    adopt(root);
    openAndLandRound(root);
    const r = run(root, ['internal-attestation', 'plan-a', '--lens', 'security', '--lens', 'correctness', '--degraded', 'agy', '--model', 'claude-fable-5', '--effort', 'max', '--authority', 'orchestrator internal sweep']);
    assert.equal(r.code, 0, r.stderr);
    const rec = storeOf(root).records.at(-1);
    assert.equal(rec.kind, 'internal-attestation');
    assert.equal(rec.planId, 'plan-a');
    assert.equal(rec.stepId, 'step-1');
    assert.equal(rec.round, 1);
    assert.deepEqual(rec.lenses, ['security', 'correctness']);
    assert.deepEqual(rec.degraded, ['agy']);
    assert.deepEqual(rec.posture, { model: 'claude-fable-5', effort: 'max', tier: null });
    assert.equal(rec.authority, 'orchestrator internal sweep');
    assert.equal(rec.fingerprint, computeTreeFingerprint(root));
  });

  it('one uncovered in-flight plan refuses BY FILENAME — a refusal, never a relaxation (#68)', () => {
    const root = makeRepo();
    adopt(root);
    openAndLandRound(root);
    planFile(root, 'uncovered.md', '# a plan nobody adopted\n');
    const r = run(root, ['internal-attestation', 'plan-a', '--lens', 'security', '--model', 'm', '--authority', 'a']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /internal-attestation refuses \(#68\)/);
    assert.match(r.stderr, /"uncovered\.md"/);
    assert.match(r.stderr, /never a relaxation/);
  });

  it('without an open step it refuses; without --lens it refuses as usage', () => {
    const root = makeRepo();
    adopt(root);
    const noStep = run(root, ['internal-attestation', 'plan-a', '--lens', 'x', '--model', 'm', '--authority', 'a']);
    assert.equal(noStep.code, 1);
    assert.match(noStep.stderr, /no open step/);
    const noLens = run(root, ['internal-attestation', 'plan-a', '--model', 'm', '--authority', 'a']);
    assert.equal(noLens.code, 2);
    assert.match(noLens.stderr, /at least one --lens/);
  });
});

describe('flow-writer — round machinery fail-closed lanes (coverage top-up)', () => {
  it('an unsafe --backend token never composes a manifest name (the consult arm names it)', () => {
    const root = makeRepo();
    adopt(root);
    openRound(root);
    const r = run(root, ['consult-attestation', 'plan-a', '--backend', 'bad/backend', '--nonce', 'nx7', '--proposed-fix-digest', 'd'.repeat(64)]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no manifest name composes/);
  });

  it('a malformed receipts line refuses round-land — a binding never rides a partially readable store', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    appendFileSync(receiptsFile(root), 'not json\n');
    const r = run(root, ['round-land', 'plan-a']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /malformed line at byte/);
  });

  it('a malformed core evidence store fails the pending-dispatch degrade resolution closed (round-open guard)', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    appendFileSync(join(root, '.git', EVIDENCE_BASENAME), 'not json\n');
    const r = run(root, ['round-open', 'plan-a', '--backend', 'codex']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot resolve degrade coverage/);
  });

  it('a shrunken receipts store and an off-boundary watermark each refuse round-land by name', () => {
    const root = makeRepo();
    adopt(root);
    appendReceipt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const watermark = lastRound(root).dispatches[0].receiptWatermark;
    assert.ok(watermark > 0);
    writeFileSync(receiptsFile(root), '');
    const shrunk = run(root, ['round-land', 'plan-a']);
    assert.equal(shrunk.code, 1);
    assert.match(shrunk.stderr, /shrank below watermark offset/);
    writeFileSync(receiptsFile(root), `${JSON.stringify({ backend: 'agy', pad: 'x'.repeat(watermark) })}\n`);
    const boundary = run(root, ['round-land', 'plan-a']);
    assert.equal(boundary.code, 1);
    assert.match(boundary.stderr, /does not sit on a line boundary/);
  });

  it('a manifest attesting a foreign tree fingerprint refuses the binding', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const round = lastRound(root);
    appendReceipt(root, { fingerprint: round.fingerprint, nonce: round.dispatches[0].dispatchNonce });
    writeRoundManifest(root, 'codex', round.dispatches[0].dispatchNonce, { fingerprint: 'ab'.repeat(32) });
    const r = run(root, ['round-land', 'plan-a']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /a foreign-tree manifest never binds this round/);
  });

  it('a queued disposition lands the closed {debtId, debtDigest} arm; a malformed core store fails the red-proof resolution closed', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const round = lastRound(root);
    appendReceipt(root, { fingerprint: round.fingerprint, verdict: 'revise', nonce: round.dispatches[0].dispatchNonce });
    const finding = '[minor] — c.txt:3 — debt — later';
    writeRoundManifest(root, 'codex', round.dispatches[0].dispatchNonce, { fingerprint: round.fingerprint, findings: `${finding}\nVerdict: revise\n` });
    assert.equal(run(root, ['round-land', 'plan-a']).code, 0);
    appendFileSync(join(root, '.git', EVIDENCE_BASENAME), 'not json\n');
    const broken = run(root, ['round-land', 'plan-a', '--dispose', 'folded', '--finding', finding, '--proof-kind', 'red-proof', '--proof-digest', 'ab'.repeat(32)]);
    assert.equal(broken.code, 1);
    assert.match(broken.stderr, /cannot resolve the red-proof/);
    const queued = run(root, ['round-land', 'plan-a', '--dispose', 'queued', '--finding', finding, '--debt-id', 'DEBT-1', '--debt-digest', 'cd'.repeat(32)]);
    assert.equal(queued.code, 0, queued.stderr);
    assert.deepEqual(lastRound(root).dispositions[0], {
      findingDigest: createHash('sha256').update(finding, 'utf8').digest('hex'),
      action: 'queued', debtId: 'DEBT-1', debtDigest: 'cd'.repeat(32),
    });
  });

  it('a terminal refuses when a landed receipt no longer resolves; an unrecognized verdict refuses at round-land AND at a terminal over a hand-crafted binding', () => {
    const root = makeRepo();
    adopt(root);
    openAndLandRound(root);
    writeFileSync(receiptsFile(root), '');
    const gone = run(root, ['freeze', 'plan-a']);
    assert.equal(gone.code, 1);
    assert.match(gone.stderr, /no longer resolves in the receipts store/);
    const root2 = makeRepo();
    adopt(root2);
    assert.equal(run(root2, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const round = lastRound(root2);
    const receipt = appendReceipt(root2, { fingerprint: round.fingerprint, verdict: 'wat', nonce: round.dispatches[0].dispatchNonce });
    const { bytes } = writeRoundManifest(root2, 'codex', round.dispatches[0].dispatchNonce, { fingerprint: round.fingerprint });
    const landWat = run(root2, ['round-land', 'plan-a']);
    assert.equal(landWat.code, 1, 'an unrecognized verdict is non-attesting and never binds at round-land');
    assert.match(landWat.stderr, /non-attesting receipt \(class "unrecognized-verdict"\)/);
    // The terminal-side floor stays defended against a HAND-CRAFTED binding the writer never minted.
    const entry = round.dispatches[0];
    appendFlowRecord({ cwd: root2, env: {}, record: {
      ...round,
      dispatches: [{ ...entry, receiptDigest: canonicalFlowDigest(receipt), findingManifestDigest: sha256hex(bytes) }],
      timestamp: now(),
    } });
    const unknown = run(root2, ['freeze', 'plan-a']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /unrecognized verdict "wat"/);
  });
});

// ── Round-1 council fold regressions (consult-settled dispositions P4.3-R1a…g) ──────────
// Every red-first: observed red on the pre-fold tree, red-proof declared before its fix.

const DOWN_MARK_EXPIRES = '2027-01-01T00:00:00.000Z';
const justifyDegrade = (root, backend, fingerprint) => {
  const degrade = { schema: EVIDENCE_SCHEMA_VERSION, kind: 'degrade', backend, reason: 'transport failure', fingerprint, timestamp: now() };
  appendFileSync(join(root, '.git', EVIDENCE_BASENAME), `${JSON.stringify(degrade)}\n`);
  if (storeOf(root).records.findLast((r) => r.kind === 'down-mark' && r.backend === backend) == null) {
    assert.equal(run(root, ['down-mark', '--backend', backend, '--reason', 'transport failure', '--expires-at', DOWN_MARK_EXPIRES]).code, 0);
  }
  const j = run(root, ['degrade-justification', '--backend', backend]);
  assert.equal(j.code, 0, j.stderr);
};
const writeFlowConfig = (root) => {
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), `${JSON.stringify({ flow: { schema: 1, debtQueue: 'docs/debt.md', convergenceSummary: 'docs/convergence.md', councilRounds: 3 } })}\n`);
};

describe('flow-writer — R1 folds: degrade exemption is justification-bound (F1/B3)', () => {
  it('R1F1 — a bare core degrade no longer exempts a pending dispatch: the exemption demands a mint-time-valid degrade-justification at the round tree', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const round = lastRound(root);
    const degrade = { schema: EVIDENCE_SCHEMA_VERSION, kind: 'degrade', backend: 'codex', reason: 'transport failure', fingerprint: round.fingerprint, timestamp: now() };
    appendFileSync(join(root, '.git', EVIDENCE_BASENAME), `${JSON.stringify(degrade)}\n`);
    const bare = run(root, ['round-open', 'plan-a', '--backend', 'codex']);
    assert.equal(bare.code, 1, 'a bare core degrade is not base-bound and never exempts alone');
    assert.match(bare.stderr, /degrade-justification/);
    assert.equal(run(root, ['down-mark', '--backend', 'codex', '--reason', 'transport failure', '--expires-at', DOWN_MARK_EXPIRES]).code, 0);
    assert.equal(run(root, ['degrade-justification', '--backend', 'codex']).code, 0);
    const justified = run(root, ['round-open', 'plan-a', '--backend', 'codex']);
    assert.equal(justified.code, 0, justified.stderr);
    assert.equal(lastRound(root).round, 2);
  });

  it('R1B3 — a later justification on the same down-mark never evicts an earlier round\'s exemption (raw mint-time scan, not authoritative selection)', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const round1 = lastRound(root);
    justifyDegrade(root, 'codex', round1.fingerprint);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex']).code, 0, 'round 2 opens at the same tree under the round-1 justification');
    writeFileSync(join(root, 'base.txt'), 'moved for round 3\n');
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex']).code, 0, 'round 2 pending at the OLD tree is still covered by the same justification');
    const round3 = lastRound(root);
    assert.notEqual(round3.fingerprint, round1.fingerprint, 'the tree moved between rounds');
    // The round-3 justification rides the SAME down-mark — its record SUPERSEDES the round-1
    // justification under the {downMark} authoritative key; only a raw mint-time scan keeps
    // rounds 1-2 exempt.
    justifyDegrade(root, 'codex', round3.fingerprint);
    const frozen = run(root, ['freeze', 'plan-a']);
    assert.equal(frozen.code, 0, `the earlier rounds' justifications live in the raw prefix even though the down-mark key superseded them: ${frozen.stderr}`);
  });
});

describe('flow-writer — R1 folds: round-open disposition floor + the redesign valve (F2/F3)', () => {
  it('R1F2 — round-open refuses while the current round holds a landed non-ship receipt with an empty disposition ledger', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const round = lastRound(root);
    appendReceipt(root, { fingerprint: round.fingerprint, verdict: 'revise', nonce: round.dispatches[0].dispatchNonce });
    const finding = '[major] — d.txt:4 — gap — close it';
    writeRoundManifest(root, 'codex', round.dispatches[0].dispatchNonce, { fingerprint: round.fingerprint, findings: `${finding}\nVerdict: revise\n` });
    assert.equal(run(root, ['round-land', 'plan-a']).code, 0);
    const blocked = run(root, ['round-open', 'plan-a', '--backend', 'codex']);
    assert.equal(blocked.code, 1, 'an undispositioned non-ship round would become permanently unterminable');
    assert.match(blocked.stderr, /disposition ledger is EMPTY/);
    assert.equal(run(root, ['round-land', 'plan-a', '--dispose', 'rejected', '--finding', finding, '--reason', 'out of scope for this step']).code, 0);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex']).code, 0);
  });

  it('R1F3 — --new-cycle reopens a converged step in the NEXT cycle; the redesign valve caps at 2 cycles (Decision 8); in-step use refuses as usage', () => {
    const root = makeRepo();
    adopt(root);
    openAndLandRound(root);
    assert.equal(run(root, ['converged', 'plan-a']).code, 0);
    const sameCycle = run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']);
    assert.equal(sameCycle.code, 1);
    assert.match(sameCycle.stderr, /already converged in cycle 1/);
    const c2 = run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1', '--new-cycle']);
    assert.equal(c2.code, 0, c2.stderr);
    const reopened = lastRound(root);
    assert.equal(reopened.cycle, 2);
    assert.equal(reopened.round, 1);
    const inStep = run(root, ['round-open', 'plan-a', '--backend', 'codex', '--new-cycle']);
    assert.equal(inStep.code, 2);
    assert.match(inStep.stderr, /--new-cycle opens at a step boundary only/);
    landCurrentRound(root);
    assert.equal(run(root, ['converged', 'plan-a']).code, 0);
    const c3blind = run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1', '--new-cycle']);
    assert.equal(c3blind.code, 1);
    assert.match(c3blind.stderr, /redesign valve/);
    assert.match(c3blind.stderr, /--justification/);
    const c3 = run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1', '--new-cycle', '--justification', 'consult verdict: a third design cycle is warranted']);
    assert.equal(c3.code, 0, c3.stderr);
    assert.equal(lastRound(root).cycle, 3);
  });
});

describe('flow-writer — R1 folds: only an ATTESTING receipt binds (F4/M4/m7)', () => {
  it('R1F4A — a defective receipt of the dispatched backend refuses the binding naming its class and the justified-degrade recovery', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const round = lastRound(root);
    const { posture, ...postureless } = { ...RECEIPT_BASE, fingerprint: round.fingerprint, timestamp: now(), nonce: round.dispatches[0].dispatchNonce };
    appendFileSync(receiptsFile(root), `${JSON.stringify(postureless)}\n`);
    const r = run(root, ['round-land', 'plan-a']);
    assert.equal(r.code, 1, 'a posture-less receipt is non-attesting and never binds');
    assert.match(r.stderr, /non-attesting/);
    assert.match(r.stderr, /core-evidence degrade/);
  });

  it('R1F4B — plan-artifact and unfresh lines of the dispatched backend never bind (skipped, not refused): the dispatch stays pending', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const round = lastRound(root);
    appendReceipt(root, { fingerprint: round.fingerprint, artifact: 'plan', nonce: round.dispatches[0].dispatchNonce });
    appendReceipt(root, { fingerprint: round.fingerprint, fresh: false, nonce: round.dispatches[0].dispatchNonce });
    const r = run(root, ['round-land', 'plan-a']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /nothing to land/, 'non-code and unfresh lines are not this dispatch\'s answer');
  });

  it('R1M4 — the defective-receipt dead end closes through the justified-degrade lane and a NEW round retries end to end', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const round1 = lastRound(root);
    appendFileSync(receiptsFile(root), `${JSON.stringify({ ...RECEIPT_BASE, fingerprint: round1.fingerprint, timestamp: now(), grounded: false, nonce: round1.dispatches[0].dispatchNonce })}\n`);
    const refused = run(root, ['round-land', 'plan-a']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /non-attesting receipt \(class "ungrounded"\)/);
    justifyDegrade(root, 'codex', round1.fingerprint);
    const retry = run(root, ['round-open', 'plan-a', '--backend', 'codex']);
    assert.equal(retry.code, 0, retry.stderr);
    const round2 = lastRound(root);
    assert.ok(round2.dispatches[0].receiptWatermark > round1.dispatches[0].receiptWatermark, 'the retry round watermarks PAST the defective line');
    appendReceipt(root, { fingerprint: round2.fingerprint, nonce: round2.dispatches[0].dispatchNonce });
    writeRoundManifest(root, 'codex', round2.dispatches[0].dispatchNonce, { fingerprint: round2.fingerprint });
    assert.equal(run(root, ['round-land', 'plan-a']).code, 0);
    const frozen = run(root, ['freeze', 'plan-a']);
    assert.equal(frozen.code, 0, `the defective round-1 dispatch stays exempted through the justified degrade: ${frozen.stderr}`);
  });
});

describe('flow-writer — R1 folds: manifest custody at dispose + terminal move validation (F5/F7/B1/B2/m8)', () => {
  it('R1F5 — a manifest swapped after landing refuses the disposition: the byte digest is re-verified against the ledger', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const round = lastRound(root);
    const nonce = round.dispatches[0].dispatchNonce;
    appendReceipt(root, { fingerprint: round.fingerprint, verdict: 'revise', nonce });
    const finding = '[major] — e.txt:5 — the original finding';
    writeRoundManifest(root, 'codex', nonce, { fingerprint: round.fingerprint, findings: `${finding}\nVerdict: revise\n` });
    assert.equal(run(root, ['round-land', 'plan-a']).code, 0);
    writeRoundManifest(root, 'codex', nonce, { fingerprint: round.fingerprint, findings: `${finding}\nVerdict: revise\nFORGED TAIL\n` });
    const r = run(root, ['round-land', 'plan-a', '--dispose', 'rejected', '--finding', finding, '--reason', 'x']);
    assert.equal(r.code, 1, 'a swapped manifest never carries a disposition, even when the quote still matches');
    assert.match(r.stderr, /findingManifestDigest/);
    rmSync(join(root, '.git', `agent-workflow-finding-manifest-codex-${nonce}.json`));
    const gone = run(root, ['round-land', 'plan-a', '--dispose', 'rejected', '--finding', finding, '--reason', 'x']);
    assert.equal(gone.code, 1, 'a DELETED manifest is the same custody break');
    assert.match(gone.stderr, /no longer cleanly readable/);
  });

  it('R1F7A — a terminal over an arbitrary tree move refuses naming the new-round recovery', () => {
    const root = makeRepo();
    adopt(root);
    openAndLandRound(root);
    writeFileSync(join(root, 'base.txt'), 'unreviewed drift\n');
    const r = run(root, ['freeze', 'plan-a']);
    assert.equal(r.code, 1, 'an unreviewed move never rides a terminal');
    assert.match(r.stderr, /NEW round/);
  });

  it('R1F7B — a declared bookkeeping-delta chain plus refresh carries the terminal across the move (the design lane stays open)', () => {
    const root = makeRepo();
    writeFlowConfig(root);
    adopt(root);
    openAndLandRound(root);
    const fpA = computeTreeFingerprint(root);
    writeFileSync(join(root, 'docs', 'debt.md'), '- DEBT-1 — queued finding\n');
    const minted = mintBookkeepingDelta({ cwd: root, env: {}, path: 'docs/debt.md', fingerprintBefore: fpA, preContent: null, timestamp: now() });
    assert.equal(run(root, ['refresh', 'plan-a', '--cause', 'bookkeeping delta re-attestation', '--refreshed-record', minted.digest]).code, 0);
    const r = run(root, ['freeze', 'plan-a']);
    assert.equal(r.code, 0, `the declared-path delta chain classifies the move current: ${r.stderr}`);
  });

  it('R1B2 — a pre-round delta chain never re-certifies a later identical move: deltas and refreshes must sit AFTER the last round head', () => {
    const root = makeRepo();
    writeFlowConfig(root);
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const round = lastRound(root);
    const fpA = round.fingerprint;
    const debtBytes = '- DEBT-1 — queued finding\n';
    writeFileSync(join(root, 'docs', 'debt.md'), debtBytes);
    const minted = mintBookkeepingDelta({ cwd: root, env: {}, path: 'docs/debt.md', fingerprintBefore: fpA, preContent: null, timestamp: now() });
    assert.equal(run(root, ['refresh', 'plan-a', '--cause', 'bookkeeping delta re-attestation', '--refreshed-record', minted.digest]).code, 0);
    rmSync(join(root, 'docs', 'debt.md'));
    assert.equal(computeTreeFingerprint(root), fpA, 'the tree returned to the round fingerprint');
    appendReceipt(root, { fingerprint: fpA, nonce: round.dispatches[0].dispatchNonce });
    writeRoundManifest(root, 'codex', round.dispatches[0].dispatchNonce, { fingerprint: fpA });
    assert.equal(run(root, ['round-land', 'plan-a']).code, 0, 'the landing revision moves the round head PAST the old delta chain');
    writeFileSync(join(root, 'docs', 'debt.md'), debtBytes);
    const r = run(root, ['freeze', 'plan-a']);
    assert.equal(r.code, 1, 'the pre-head delta chain never re-certifies the later identical move');
    assert.match(r.stderr, /NEW round|after the last round/);
  });

  it('R1m8 — a malformed flow config fails the terminal\'s move classification closed, never silently equality-only', () => {
    const root = makeRepo();
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), '{"flow":{"schema":1,"unknownKey":true}}\n');
    adopt(root);
    openAndLandRound(root);
    writeFileSync(join(root, 'base.txt'), 'moved\n');
    const r = run(root, ['freeze', 'plan-a']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /orchestration config|config/i);
    assert.match(r.stderr, /fail(s)? closed/);
  });
});

describe('flow-writer — R1 folds: completeness re-checked under the append lock (F6/M5/M6)', () => {
  // The concurrent-append hook: lands a crafted round-land revision (binding a revise receipt
  // with an EMPTY disposition ledger) directly into the store the moment the writer's append
  // tries to create its lock — the lock-free pre-check has already passed by then.
  const concurrentLandingDeps = (root) => {
    const round = lastRound(root);
    const entry = round.dispatches[0];
    const receipt = appendReceipt(root, { fingerprint: round.fingerprint, verdict: 'revise' });
    const { bytes } = writeRoundManifest(root, 'codex', entry.dispatchNonce, { fingerprint: round.fingerprint, findings: '[major] — f.txt:6 — landed mid-append\nVerdict: revise\n' });
    const revision = {
      ...round,
      dispatches: [{ ...entry, receiptDigest: canonicalFlowDigest(receipt), findingManifestDigest: sha256hex(bytes) }],
      timestamp: now(),
    };
    let landed = false;
    return {
      openLock: (p) => {
        if (!landed) {
          landed = true;
          appendFileSync(resolveFlowStorePath(root, {}), `${JSON.stringify(revision)}\n`);
        }
        return openSync(p, 'wx');
      },
    };
  };

  it('R1F6 — a revision landing mid-append refuses the terminal: completeness re-runs on the locked snapshot', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    justifyDegrade(root, 'codex', lastRound(root).fingerprint);
    const deps = concurrentLandingDeps(root);
    const r = main(['freeze', 'plan-a'], { cwd: root, env: {}, now, storeDeps: deps });
    assert.equal(r.code, 1, 'the lock-free completeness pass is not the last word — the locked snapshot decides');
    assert.match(r.stderr, /disposition ledger is EMPTY/);
    assert.ok(!storeOf(root).records.some((x) => x.purpose === 'freeze'), 'nothing was written');
  });

  it('R1M6 — the same mid-append landing refuses round-open under the lock (the F2 floor re-checked)', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    justifyDegrade(root, 'codex', lastRound(root).fingerprint);
    const deps = concurrentLandingDeps(root);
    const r = main(['round-open', 'plan-a', '--backend', 'codex'], { cwd: root, env: {}, now, storeDeps: deps });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /disposition ledger is EMPTY/);
    assert.equal(lastRound(root).round, 1, 'no second round landed');
  });

  it('R1M5 — the preflight hook receives a deep-frozen snapshot: a mutating preflight surfaces loudly and the store stays intact', async () => {
    const { appendFlowRecordWithPreflight } = await import('./flow-store.mjs');
    assert.equal(typeof appendFlowRecordWithPreflight, 'function', 'the checked-append seam exists');
    const root = makeRepo();
    adopt(root);
    const before = readFileSync(resolveFlowStorePath(root, {}), 'utf8');
    const record = {
      schema: FLOW_SCHEMA_VERSION, kind: CHAIN_KIND, purpose: 'park', planId: 'plan-a', cycle: 1,
      round: 0, commitEpoch: 0, owner: 'main', base: resolveBase(root), timestamp: now(),
      stepId: null, fingerprint: computeTreeFingerprint(root),
    };
    assert.throws(
      () => appendFlowRecordWithPreflight({ cwd: root, env: {}, record, preflight: (records) => { records.push({ forged: true }); } }),
      /object is not extensible|read only|Cannot add property/,
      'mutating the snapshot throws — the written bytes can never be skewed',
    );
    assert.equal(readFileSync(resolveFlowStorePath(root, {}), 'utf8'), before, 'the store is unchanged after the mutating preflight');
    const ok = appendFlowRecordWithPreflight({ cwd: root, env: {}, record, preflight: (records) => { assert.ok(records.length >= 1); } });
    assert.equal(ok.record.purpose, 'park');
  });
});

// ── Round-2 council fold regressions (consult-settled: nonce-in-receipt · shared custody
// predicate · strict dispose flag matrix) ───────────────────────────────────────────────

describe('flow-writer — R2 folds: the nonce decides the binding (G1)', () => {
  it('R2G1A — a delayed receipt of a degraded dispatch never binds a later round: the nonce decides, not the watermark', () => {
    const root = makeRepo();
    adopt(root);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const round1 = lastRound(root);
    justifyDegrade(root, 'codex', round1.fingerprint);
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex']).code, 0);
    const round2 = lastRound(root);
    appendReceipt(root, { fingerprint: round1.fingerprint, nonce: round1.dispatches[0].dispatchNonce });
    const stale = run(root, ['round-land', 'plan-a']);
    assert.equal(stale.code, 1, 'the DELAYED answer of the degraded round-1 dispatch never binds round 2');
    assert.match(stale.stderr, /nothing to land/);
    appendReceipt(root, { fingerprint: round2.fingerprint, nonce: round2.dispatches[0].dispatchNonce });
    writeRoundManifest(root, 'codex', round2.dispatches[0].dispatchNonce, { fingerprint: round2.fingerprint });
    assert.equal(run(root, ['round-land', 'plan-a']).code, 0);
    const head = lastRound(root);
    assert.equal(head.round, 2);
    assert.notEqual(head.dispatches[0].receiptDigest, null, 'round 2 bound exactly its own answer');
  });

  it('R2G1B — a cross-chain lost receipt never cross-binds: each plan\'s dispatch answers only to its own nonce', () => {
    const root = makeRepo();
    adopt(root);
    adopt(root, 'plan-b');
    assert.equal(run(root, ['round-open', 'plan-a', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const roundA = lastRound(root);
    assert.equal(run(root, ['round-open', 'plan-b', '--backend', 'codex', '--step', 'step-1']).code, 0);
    const roundB = storeOf(root).records.findLast((r) => r.kind === CHAIN_KIND && r.purpose === 'round' && r.planId === 'plan-b');
    appendReceipt(root, { fingerprint: roundB.fingerprint, nonce: roundB.dispatches[0].dispatchNonce });
    writeRoundManifest(root, 'codex', roundB.dispatches[0].dispatchNonce, { fingerprint: roundB.fingerprint });
    const crossed = run(root, ['round-land', 'plan-a']);
    assert.equal(crossed.code, 1, 'plan B\'s receipt never binds plan A\'s dispatch, however alone it sits past the watermark');
    assert.match(crossed.stderr, /nothing to land/);
    assert.equal(run(root, ['round-land', 'plan-b']).code, 0);
    const headA = storeOf(root).records.findLast((r) => r.kind === CHAIN_KIND && r.purpose === 'round' && r.planId === 'plan-a');
    assert.equal(headA.dispatches[0].receiptDigest, null, 'plan A stays pending');
  });
});

describe('flow-writer — R2 folds: forged custody + the dispose flag matrix (G2/G3)', () => {
  it('R2G2 — a forged custody proof never carries a terminal across a move, even with an attesting refresh', () => {
    const root = makeRepo();
    writeFlowConfig(root);
    adopt(root);
    openAndLandRound(root);
    const fpA = computeTreeFingerprint(root);
    writeFileSync(join(root, 'docs', 'debt.md'), '- DEBT-9 — forged custody\n');
    const fpB = computeTreeFingerprint(root);
    const delta = {
      schema: FLOW_SCHEMA_VERSION, kind: 'bookkeeping-delta', fingerprintBefore: fpA, fingerprintAfter: fpB,
      path: 'docs/debt.md', contentDigest: sha256hex(readFileSync(join(root, 'docs', 'debt.md'))),
      custodyProof: { preClass: 'absent', tracked: false, headDigest: null, indexDigest: null, worktreeDigest: null, maskedFingerprint: 'ee'.repeat(32) },
      base: resolveBase(root), timestamp: now(),
    };
    appendFlowRecord({ cwd: root, env: {}, record: delta });
    assert.equal(run(root, ['refresh', 'plan-a', '--cause', 'forged delta re-attestation', '--refreshed-record', canonicalFlowDigest(delta)]).code, 0);
    const r = run(root, ['freeze', 'plan-a']);
    assert.equal(r.code, 1, 'a forged maskedFingerprint never carries a terminal');
    assert.match(r.stderr, /unproven custody/);
  });

  it('R2G3 — every cross-branch --dispose flag refuses as usage naming the stray flag, before any required-value error', () => {
    const root = makeRepo();
    const cases = [
      ['folded', '--debt-id', 'x'], ['folded', '--debt-digest', 'ab'.repeat(32)], ['folded', '--reason', 'x'],
      ['queued', '--proof-kind', 'red-proof'], ['queued', '--proof-digest', 'ab'.repeat(32)], ['queued', '--reason', 'x'],
      ['rejected', '--proof-kind', 'red-proof'], ['rejected', '--proof-digest', 'ab'.repeat(32)], ['rejected', '--debt-id', 'x'], ['rejected', '--debt-digest', 'ab'.repeat(32)],
    ];
    for (const [action, flag, value] of cases) {
      const r = run(root, ['round-land', 'plan-a', '--dispose', action, flag, value]);
      assert.equal(r.code, 2, `${action} + ${flag} must refuse as usage`);
      assert.ok(r.stderr.includes(`${flag} does not ride --dispose ${action}`), `${action} + ${flag}: got ${r.stderr}`);
    }
  });
});

describe('flow-writer — the arm usage lines ARE the public contract (CLI usage test per arm)', () => {
  it('--help pins every round-machinery usage line', () => {
    const r = run(makeRepo(), ['--help']);
    assert.equal(r.code, 0);
    for (const line of [
      'round-open <planId> --backend <name> [--backend <name> ...] [--step <stepId>] [--new-cycle] [--justification <text>]',
      'round-land <planId> [--dispose folded --finding <quote> --proof-kind consult-attestation|red-proof --proof-digest <digest>]',
      'round-land <planId> [--dispose queued --finding <quote> --debt-id <id> --debt-digest <digest>]',
      'round-land <planId> [--dispose rejected --finding <quote> --reason <text>]',
      'freeze <planId>',
      'unfreeze <planId> [--justification <text>]',
      'converged <planId>',
      'internal-attestation <planId> --lens <name> [--lens <name> ...] [--degraded <backend> ...] --model <model> [--effort <effort>] [--tier <tier>] --authority <text>',
    ]) {
      assert.ok(r.stdout.includes(line), `--help must carry the usage line: ${line}`);
    }
    assert.match(r.stdout, /dispatch backend=<b> nonce=<n> watermark=<w>/, 'the round-open stdout grammar is stated in the contract');
  });

  it('round-land usage lanes: a bad --dispose, a dispose flag without --dispose, and an empty --finding refuse as usage', () => {
    const root = makeRepo();
    assert.equal(run(root, ['round-land', 'plan-a', '--dispose', 'shrugged', '--finding', 'x']).code, 2);
    assert.equal(run(root, ['round-land', 'plan-a', '--finding', 'x']).code, 2);
    assert.equal(run(root, ['round-land', 'plan-a', '--dispose', 'rejected', '--finding', '', '--reason', 'r']).code, 2);
  });
});
