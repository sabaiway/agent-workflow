import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, appendFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { main, composePlanIdFrontmatter } from './flow-writer.mjs';
import { resolveFlowStorePath, readFlowStore, appendFlowRecord, readPlanFrontmatterId } from './flow-store.mjs';
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
