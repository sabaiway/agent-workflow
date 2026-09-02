// flow-dogfood.integration.test.mjs — the Plan-4 dogfood acceptance (Phase 4.1): a PERMANENT
// hermetic tracked-docs/ai fixture repo driving the REAL flow pipeline end to end through the
// actual CLIs (set-flow → write-plan-id → adoption → --pre-review → round-open → receipts at the
// staged fingerprint → round-land → red→fix→green retry → a NEW round at the moved fingerprint →
// tracked debt write + bookkeeping-delta + refresh → freeze → converged → run-gates --final →
// commit-guard --check), with fixture receipts/manifests standing in for the live bridges. This
// is the tracked-`docs/ai` lane the untracked-docs/ai host repo cannot exercise (Decision 4), and
// the ONLY place the whole store lifecycle runs as one sequence instead of per-arm unit tests.
// Every subprocess runs under a per-fixture isolated git environment (the hide-footprint
// integration pattern) so host config (excludesFile, diff.* cosmetics) can never move a
// fingerprint the pipeline binds. Sibling fixtures: the Decision-8 second-red stop pair and the
// #57 foreign-worktree lane (advisory before the final, never a D10 movement after it).

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, appendFileSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { FLOW_SCHEMA_VERSION, CHAIN_KIND, canonicalFlowDigest } from './flow-record.mjs';
import { EVIDENCE_SCHEMA_VERSION } from './core-evidence.mjs';
import { planWith } from './plan-shape-harness.test.mjs';
import { readShippedRobustnessLiterals } from './robustness-literals.mjs';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const SET_FLOW = join(TOOLS, 'set-flow.mjs');
const FLOW_WRITER = join(TOOLS, 'flow-writer.mjs');
const RUN_GATES = join(TOOLS, 'run-gates.mjs');
const COMMIT_GUARD = join(TOOLS, 'commit-guard.mjs');
const FLOW_CHECK = join(TOOLS, 'flow-check.mjs');

const FLOW_STORE = 'agent-workflow-flow.jsonl';
const RECEIPTS = 'agent-workflow-review-receipts.jsonl';
const EVIDENCE = 'agent-workflow-core-evidence.jsonl';
const PLAN_REL = 'docs/plans/dogfood-plan.md';
const PLAN_ID = 'dogfood-e2e-plan';
const HEX64 = /^[0-9a-f]{64}$/;
const sha256hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Synchronous at module load: `skip` options are evaluated when describe() is CALLED, before any
// before() hook runs — and spawnSync reports ENOENT via `.error`, it never throws.
const gitOk = (() => {
  try { return spawnSync('git', ['--version']).status === 0; } catch { return false; }
})();

const made = [];
after(() => { while (made.length) { try { rmSync(made.pop(), { recursive: true, force: true }); } catch { /* best effort */ } } });

// Isolated per-fixture git environment: every AW_*, GIT_* and XDG_* variable stripped
// class-wide (an enumerated list would leak GIT_CONFIG_COUNT/GIT_CONFIG_KEY_*/
// GIT_CONFIG_PARAMETERS/GIT_TEMPLATE_DIR — inherited config can reorder diffs or redirect
// stores, and diff.orderFile alone would break the restage-invariance this pipeline binds;
// an inherited XDG_CONFIG_HOME keeps the host's git/ignore + git/attributes active PAST the
// HOME redirect), then ONLY the isolated config + identity set added back. `inherited`
// simulates a hostile parent environment — the fixture proves it is overridden, not absent.
const makeEnv = (home, gcfg, inherited = {}) => {
  const env = { ...process.env, ...inherited };
  for (const key of Object.keys(env)) {
    if (key.startsWith('AW_') || key.startsWith('GIT_') || key.startsWith('XDG_')) delete env[key];
  }
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return {
    ...env, HOME: home, GIT_CONFIG_GLOBAL: gcfg, GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1',
    XDG_CONFIG_HOME: join(home, 'xdg'),
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e',
  };
};

// The declared gate matrix: three mechanical gates (the derived --pre-review subset; gate-marker
// leaves an observable run trace in the git dir — outside the fingerprint domain — so "refused
// PRE-GATES" is provable by the trace staying unchanged) + the three canonical checkers the
// final run consumes — coverage-check LAST (the --final declaration rule).
// gate-marker is deliberately FIRST: "refused PRE-GATES" is proven by its trace staying
// unchanged, and a marker declared later would leave earlier gates able to run unobserved.
const MECHANICAL_GATE_IDS = ['gate-marker', 'app-ok', 'noop'];
const GATE_RUNS_TRACE = 'dogfood-gate-runs';
const gatesDeclaration = () => JSON.stringify({
  gates: [
    { id: 'gate-marker', title: 'run marker (side-effect probe)', cmd: `echo ran >> .git/${GATE_RUNS_TRACE}` },
    { id: 'app-ok', title: 'app.txt carries ok', cmd: 'grep -q ok app.txt' },
    { id: 'noop', title: 'trivially green', cmd: 'true' },
    { id: 'review-state', title: 'canonical review-state', cmd: `node "${join(TOOLS, 'review-state.mjs')}" --check` },
    { id: 'flow-check', title: 'canonical flow-check', cmd: `node "${join(TOOLS, 'flow-check.mjs')}" --check` },
    { id: 'coverage-check', title: 'canonical coverage-check', cmd: `node "${join(TOOLS, 'coverage-check.mjs')}" --check` },
  ],
}, null, 2);
const DECLARED_GATE_IDS = [...MECHANICAL_GATE_IDS, 'review-state', 'flow-check', 'coverage-check'];
const gateRunCount = (fx) => {
  const trace = join(fx.root, '.git', GATE_RUNS_TRACE);
  return existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter(Boolean).length : 0;
};
// The executed gate ids, in run order, parsed from the runner's own `── <id> — <title>` headers.
const executedGateIds = (stdout) => [...stdout.matchAll(/^── (\S+) — /gm)].map((m) => m[1]);

const makeFixture = (tag) => {
  const home = mkdtempSync(join(tmpdir(), `${tag}-home-`));
  const root = mkdtempSync(join(tmpdir(), `${tag}-repo-`));
  made.push(home, root);
  const gcfg = join(home, '.gitconfig');
  writeFileSync(gcfg, '');
  // A deterministic HOSTILE inherited XDG_CONFIG_HOME: its git/ignore would swallow docs/ and
  // app.txt and its git/attributes would rewrite md handling — the isolated env must OVERRIDE
  // it, and the tracked-ness assert below is what proves the neutralization (a leak would make
  // `git add -A` skip docs/, and --error-unmatch would refuse).
  const hostile = join(home, 'xdg-hostile');
  mkdirSync(join(hostile, 'git'), { recursive: true });
  writeFileSync(join(hostile, 'git', 'ignore'), 'docs/\napp.txt\n');
  writeFileSync(join(hostile, 'git', 'attributes'), '*.md -text\n');
  const fx = { root, env: makeEnv(home, gcfg, { XDG_CONFIG_HOME: hostile }) };
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'ai', 'gates.json'), gatesDeclaration());
  writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'council' } }, null, 2));
  writeFileSync(join(root, 'docs', 'debt.md'), '# Debt queue\n');
  writeFileSync(join(root, 'docs', 'convergence.md'), '# Convergence\n');
  writeFileSync(join(root, PLAN_REL), '# Dogfood plan\n\nStep 4.1 exercises the armed flow end to end.\n');
  writeFileSync(join(root, 'app.txt'), 'ok\n');
  git(fx, 'init', '-q', '-b', 'main');
  git(fx, 'add', '-A');
  git(fx, 'commit', '-qm', 'base');
  git(fx, 'ls-files', '--error-unmatch', 'docs/ai/gates.json', 'docs/ai/orchestration.json');
  return fx;
};

function git(fx, ...args) {
  const r = spawnSync('git', args, { cwd: fx.root, env: fx.env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

const runTool = (fx, tool, args) => {
  const r = spawnSync(process.execPath, [tool, ...args], { cwd: fx.root, env: fx.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

const expectOk = (fx, tool, args) => {
  const r = runTool(fx, tool, args);
  assert.equal(r.code, 0, `${args[0] ?? tool}: ${r.stderr || r.stdout}`);
  return r;
};
const expectRefusal = (fx, tool, args, pattern, code = 1) => {
  const r = runTool(fx, tool, args);
  assert.equal(r.code, code, `${args.join(' ')}: ${r.stderr || r.stdout}`);
  assert.match(r.stderr || r.stdout, pattern);
  return r;
};

// Helpers that need the fixture's git run OUT of process under the isolated env — an in-process
// spawn would inherit the HOST git environment and could compute a different fingerprint domain.
const inFixtureModule = (fx, moduleFile, source, extraEnv = {}) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: fx.root, encoding: 'utf8',
    env: { ...fx.env, DOGFOOD_MODULE_URL: pathToFileURL(join(TOOLS, moduleFile)).href, ...extraEnv },
  });
  assert.equal(r.status, 0, `fixture module run: ${r.stderr}`);
  return r.stdout;
};

const fingerprintOf = (fx) => inFixtureModule(fx, 'core-evidence.mjs',
  'const m = await import(process.env.DOGFOOD_MODULE_URL); process.stdout.write(m.computeTreeFingerprint(process.cwd()));');

// The store-level bookkeeping-delta mint (deliberately NO writer arm exists for it — the plan's
// Phase-4 contract): parameters ride the environment so no shell-quoting can distort bytes.
const mintDelta = (fx, { path, fingerprintBefore, preContent }) => JSON.parse(inFixtureModule(fx, 'flow-store.mjs',
  'const m = await import(process.env.DOGFOOD_MODULE_URL);'
  + ' const a = JSON.parse(process.env.DOGFOOD_DELTA);'
  + ' const r = m.mintBookkeepingDelta({ cwd: process.cwd(), path: a.path, fingerprintBefore: a.fingerprintBefore, preContent: a.preContent });'
  + ' process.stdout.write(JSON.stringify({ digest: r.digest, record: r.record }));',
  { DOGFOOD_DELTA: JSON.stringify({ path, fingerprintBefore, preContent }) }));

const storeRecords = (fx) => readFileSync(join(fx.root, '.git', FLOW_STORE), 'utf8')
  .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
const lastRound = (fx) => storeRecords(fx).findLast((r) => r.kind === CHAIN_KIND && r.purpose === 'round');
const subsetAttempts = (fx) => storeRecords(fx).filter((r) => r.kind === 'subset-attempt');
const evidenceRecords = (fx) => readFileSync(join(fx.root, '.git', EVIDENCE), 'utf8')
  .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));

// Fixture receipts/manifests — the bridge-wrapper stand-ins, CONSUMER-RELEVANT wire fidelity
// (stated boundary): per-backend posture shapes (codex {model, effort, tier}, agy {model}), the
// agy UPPERCASE verdict grammar + D8b delivery declaration, seconds-precision timestamps (the
// wrappers write `date -u +%Y-%m-%dT%H:%M:%SZ`), and the dispatch's EXACT nonce (Phase 3 binds
// dispatch identity end to end). Receipt field ORDER is a non-goal — every kit consumer reads
// the receipt by key set and digests it through the sorted-key canonical serialization.
// The wrappers write LITERAL wire schemas (codex-review.sh mint core `schema: 1`; the receipt
// printf `"schema":1`) — two INDEPENDENT wire forms pinned separately, so a reader-side
// FLOW_SCHEMA_VERSION bump fails HERE at the wrapper-compat question instead of auto-adapting;
// only the MANIFEST constant is compared to FLOW_SCHEMA_VERSION (receipts are not flow-schema'd).
const WRAPPER_MANIFEST_SCHEMA = 1;
const WRAPPER_RECEIPT_SCHEMA = 1;
const wireTimestamp = () => new Date().toISOString().replace(/\.\d{3}(?=Z$)/, '');
const appendReceipt = (fx, { backend, nonce, fingerprint, verdict, blocking }) => {
  const receipt = {
    schema: WRAPPER_RECEIPT_SCHEMA, artifact: 'code', fresh: true, backend, verdict: verdict ?? (backend === 'agy' ? 'SHIP' : 'ship'),
    grounded: true, factsHash: null, wrapperVersion: '0.0.0-dogfood', probe: false,
    posture: backend === 'agy' ? { model: 'agy-dogfood-model' } : { model: 'codex-dogfood-model', effort: 'xhigh', tier: null },
    ...(backend === 'agy' ? { delivery: 'inline' } : {}), nonce, fingerprint,
    timestamp: wireTimestamp(), blocking: blocking === undefined ? 0 : blocking,
  };
  appendFileSync(join(fx.root, '.git', RECEIPTS), `${JSON.stringify(receipt)}\n`);
  return receipt;
};

// Manifest BYTES are the digest domain (findingManifestDigest hashes the raw file, never a
// canonical serialization), so the wrapper's exact wire form is reproduced: the printf field
// order {schema, backend, nonce, fingerprint, findings} AND the trailing newline
// (codex-review.sh mint core: `JSON.stringify({...}) + "\n"`); the agy findings payload rides
// its mandated `### Verdict` section form.
const writeManifest = (fx, { backend, nonce, fingerprint, findings: supplied }) => {
  const findings = supplied ?? (backend === 'agy'
    ? '### Verdict\nSHIP\n\n### Blocking\nnone\n'
    : `Verdict: ship\n\nNo blocking findings (${backend} dogfood).\n`);
  const bytes = Buffer.from(`${JSON.stringify({ schema: WRAPPER_MANIFEST_SCHEMA, backend, nonce, fingerprint, findings })}\n`);
  writeFileSync(join(fx.root, '.git', `agent-workflow-finding-manifest-${backend}-${nonce}.json`), bytes);
  return bytes;
};

const roundRecordCount = (fx) => storeRecords(fx).filter((r) => r.kind === CHAIN_KIND && r.purpose === 'round').length;

// Land every pending dispatch of the CURRENT round: receipts + manifests minted AT the round's
// dispatched fingerprint carrying the dispatch nonces, then ONE round-land revision binds both
// (the store grows by exactly one round record — the revision, never a second lifecycle record).
const landCurrentRound = (fx) => {
  const round = lastRound(fx);
  const minted = round.dispatches.filter((e) => e.receiptDigest === null).map((entry) => ({
    entry,
    receipt: appendReceipt(fx, { backend: entry.backend, nonce: entry.dispatchNonce, fingerprint: round.fingerprint }),
    manifestBytes: writeManifest(fx, { backend: entry.backend, nonce: entry.dispatchNonce, fingerprint: round.fingerprint }),
  }));
  const roundsBefore = roundRecordCount(fx);
  const landed = expectOk(fx, FLOW_WRITER, ['round-land', PLAN_ID]);
  assert.equal(roundRecordCount(fx), roundsBefore + 1, 'one round-land invocation = exactly ONE round revision');
  for (const m of minted) assert.match(landed.stdout, new RegExp(`landed backend=${m.entry.backend}`));
  return { round, minted, landed };
};

// ── the gate-silence lane (defect 1): the #65 rung's END-TO-END shapes ───────────────────────────
// An armed chain whose FIRST council round is already landed — every receipt-consuming gate is
// satisfied, so the unanswered-red rung is the only moving part left in the final matrix.
// `seed` stages work BEFORE the round opens, so the round — and every red seeded at its tree —
// sits at a fingerprint that CARRIES BYTES. Without it the round pins the content-free value every
// clean moment of every repository shares, which the #65 rung steps over by name: a red seeded
// there is skipped, and a case built on it goes green while pinning nothing.
const armWithLandedRound = (tag, step, seed = null) => {
  const fx = makeFixture(tag);
  expectOk(fx, SET_FLOW, ['--preset', 'council', '--write']);
  expectOk(fx, FLOW_WRITER, ['write-plan-id', PLAN_REL, '--plan-id', PLAN_ID]);
  git(fx, 'add', '-A');
  git(fx, 'commit', '-qm', 'arm the flow');
  expectOk(fx, FLOW_WRITER, ['adoption', PLAN_REL]);
  if (seed !== null) {
    writeFileSync(join(fx.root, 'app.txt'), seed);
    git(fx, 'add', '-A');
  }
  expectOk(fx, FLOW_WRITER, ['round-open', PLAN_ID, '--backend', 'codex', '--backend', 'agy', '--step', step]);
  landCurrentRound(fx);
  return fx;
};

// The evidence store lives in the git dir — OUTSIDE the fingerprint domain — so seeding the shape a
// real run leaves never moves the tree the assertions bind.
const seedEvidence = (fx, record) => {
  appendFileSync(join(fx.root, '.git', EVIDENCE), `${JSON.stringify(record)}\n`);
  return record;
};
const seedRedFinal = (fx, { fingerprint, attempt }) => {
  const declared = JSON.parse(gatesDeclaration()).gates.map(({ id, cmd }) => ({ id, cmd }));
  return seedEvidence(fx, {
    schema: EVIDENCE_SCHEMA_VERSION, kind: 'final', status: 'red', attempt,
    fingerprintBefore: fingerprint, fingerprintAfter: fingerprint, declared,
    results: declared.map(({ id }, i) => ({ id, ok: i !== 0, code: i === 0 ? 1 : 0 })),
    integrityFailure: null, evidenceHashes: { redProof: '0'.repeat(64), degrade: '0'.repeat(64) },
    lcovSha256: null, timestamp: new Date().toISOString(),
  });
};
const seedDanglingStart = (fx, { fingerprint, attempt }) => seedEvidence(fx, {
  schema: EVIDENCE_SCHEMA_VERSION, kind: 'final-start', fingerprint, attempt, timestamp: new Date().toISOString(),
});

// The decision-altitude answer for a chosen consumer, computed INSIDE the fixture environment.
const flowDecisionRefusals = (fx, consumer) => JSON.parse(inFixtureModule(fx, 'flow-check.mjs',
  'const m = await import(process.env.DOGFOOD_MODULE_URL);'
  + ' process.stdout.write(JSON.stringify(m.computeFlowDecision({ cwd: process.cwd(), consumer: process.env.DOGFOOD_CONSUMER }).refusals));',
  { DOGFOOD_CONSUMER: consumer }));

const DEBT_CLAIM = 'every queued finding binds its row and proof';
const DEBT_BLOCK = `- **DOGFOOD-DEBT — queued.**\n  - invariant: ${DEBT_CLAIM}\n  - origin: app.txt:1\n  - narrow fix: bind this finding\n  - proof: app.txt#red case\n  - residual exposure: general callers remain - not live\n`;
const armRung = (tag, { plan = planWith({ ledger: 'R0 | delete | gone.mjs | cleanup | — | —\ntotal: 0 → 0 lines' }), debt = '# Debt queue\n', backends = ['codex', 'agy'], files = {} } = {}) => {
  const fx = makeFixture(tag);
  expectOk(fx, SET_FLOW, ['--preset', 'council', '--write']);
  writeFileSync(join(fx.root, PLAN_REL), plan);
  writeFileSync(join(fx.root, 'docs', 'debt.md'), debt);
  for (const [path, bytes] of Object.entries(files)) { mkdirSync(dirname(join(fx.root, path)), { recursive: true }); writeFileSync(join(fx.root, path), bytes); }
  expectOk(fx, FLOW_WRITER, ['write-plan-id', PLAN_REL, '--plan-id', PLAN_ID]);
  git(fx, 'add', '-A'); git(fx, 'commit', '-qm', 'arm rung fixture');
  expectOk(fx, FLOW_WRITER, ['adoption', PLAN_REL]);
  expectOk(fx, FLOW_WRITER, ['round-open', PLAN_ID, ...backends.flatMap((backend) => ['--backend', backend]), '--step', '1.1']);
  return fx;
};
const landWith = (fx, overrides = {}) => {
  const round = lastRound(fx);
  for (const entry of round.dispatches.filter((d) => d.receiptDigest === null)) {
    const over = overrides[entry.backend] ?? {};
    appendReceipt(fx, { backend: entry.backend, nonce: entry.dispatchNonce, fingerprint: round.fingerprint, ...over });
    writeManifest(fx, { backend: entry.backend, nonce: entry.dispatchNonce, fingerprint: round.fingerprint, ...over });
  }
  return expectOk(fx, FLOW_WRITER, ['round-land', PLAN_ID]);
};
const attestWalk = (fx, rows, name = 'aw-walk.json') => {
  writeFileSync(join(fx.root, '.git', name), JSON.stringify({ listVersion: readShippedRobustnessLiterals().version, rows }));
  return expectOk(fx, FLOW_WRITER, ['internal-attestation', PLAN_ID, '--lens', 'correctness', '--model', 'm', '--authority', 'dogfood', '--walk', name]);
};

describe('flow dogfood — first-pass quality rungs (real CLIs)', { skip: !gitOk }, () => {
  it('walks coverage from the common dir, never the worktree root, and pins the off-by-one gate (spec:plan-review-loop/S30)', () => {
    const ledger = 'R1 | modify | src/location.mjs | robust:git-location | n/a | src/location.mjs:1\nR2 | modify | src/read.mjs | untagged | n/a | src/read.mjs:1\ntotal: 0 → 0 lines';
    const fx = armRung('aw-dogfood-walk', { plan: planWith({ ledger }), files: { 'src/location.mjs': 'GIT_DIR\n', 'src/read.mjs': '--no-textconv\n' } });
    landWith(fx);
    const common = join(fx.root, '.git');
    const args = ['internal-attestation', PLAN_ID, '--lens', 'correctness', '--model', 'm', '--authority', 'dogfood', '--walk'];
    expectRefusal(fx, FLOW_WRITER, [...args, join(common, 'absolute.json')], /absolute|relative/ , 2);
    expectRefusal(fx, FLOW_WRITER, [...args, '../outside.json'], /\.\.|segment/, 2);
    expectRefusal(fx, FLOW_WRITER, [...args, 'absent.json'], /absent/ , 2);
    mkdirSync(join(common, 'walk-dir')); expectRefusal(fx, FLOW_WRITER, [...args, 'walk-dir'], /non-regular|directory/, 2);
    const bad = [['large.json', 'x'.repeat(65537), /64 KiB|over/], ['utf8.json', Buffer.from([0xff]), /UTF-8/], ['json.json', '{', /JSON/], ['stray.json', JSON.stringify({ listVersion: 1, rows: [], stray: true }), /stray|unknown/], ['checked.json', JSON.stringify({ listVersion: 1, rows: [{ id: 'R1', class: 'git-location', checked: 1 }] }), /checked/], ['version.json', JSON.stringify({ listVersion: 999, rows: [] }), /listVersion/], ['missing.json', JSON.stringify({ listVersion: 1, rows: [{ id: 'R1', class: 'git-location', checked: 'yes' }] }), /R2:git-read-flags/]];
    for (const [name, bytes, pattern] of bad) { writeFileSync(join(common, name), bytes); expectRefusal(fx, FLOW_WRITER, [...args, name], pattern, 2); }
    const walk = JSON.stringify({ listVersion: readShippedRobustnessLiterals().version, rows: [{ id: 'R1', class: 'git-location', checked: 'yes' }, { id: 'R2', class: 'git-read-flags', checked: 'yes' }] });
    writeFileSync(join(fx.root, 'aw-walk.json'), walk);
    expectRefusal(fx, FLOW_WRITER, [...args, 'aw-walk.json'], /absent/, 2);
    writeFileSync(join(common, 'aw-walk.json'), walk);
    expectOk(fx, FLOW_WRITER, [...args, 'aw-walk.json']);
    assert.deepEqual(storeRecords(fx).at(-1).walk.uncovered, [{ id: 'R2', class: 'git-read-flags' }]);
    expectOk(fx, FLOW_WRITER, ['round-open', PLAN_ID, '--backend', 'codex', '--backend', 'agy']); landWith(fx);
    expectRefusal(fx, FLOW_WRITER, ['round-open', PLAN_ID, '--backend', 'codex'], /authoritative walk for round 2/);
    assert.match(expectOk(fx, FLOW_WRITER, ['round-open', PLAN_ID, '--backend', 'codex', '--justification', 'round-2 walk was unavailable']).stdout, /walk lift trail — round-2 walk was unavailable/);
  });

  it('binds queued findings to the resolved row and either proof kind (spec:plan-review-loop/S32)', () => {
    const fx = armRung('aw-dogfood-queued', { debt: DEBT_BLOCK, backends: ['codex'] }); landWith(fx);
    const round = lastRound(fx); const item = 'Verdict: ship'; const testId = 'app.txt#red case';
    const red = seedEvidence(fx, { schema: EVIDENCE_SCHEMA_VERSION, kind: 'red-proof', testId, file: 'app.txt', fileHash: sha256hex(readFileSync(join(fx.root, 'app.txt'))), runs: 1, reds: 1, base: git(fx, 'rev-parse', 'HEAD').trim(), fingerprint: fingerprintOf(fx), timestamp: new Date().toISOString() });
    const queued = expectOk(fx, FLOW_WRITER, ['round-land', PLAN_ID, '--dispose', 'queued', '--finding', item, '--claim', DEBT_CLAIM, '--proof-kind', 'red-proof', '--proof-digest', canonicalFlowDigest(red)]);
    assert.match(queued.stdout, /findingDigest=/); const disposition = lastRound(fx).dispositions.at(-1);
    assert.equal(disposition.debtId, '- **DOGFOOD-DEBT — queued.**'); assert.equal(disposition.debtDigest, sha256hex(Buffer.from(DEBT_BLOCK)));
    const nonce = round.dispatches[0].dispatchNonce; const second = 'No blocking findings (codex dogfood).'; const itemDigest = sha256hex(Buffer.from(second));
    expectOk(fx, FLOW_WRITER, ['consult-attestation', PLAN_ID, '--backend', 'codex', '--nonce', nonce, '--proposed-fix-digest', 'ab'.repeat(32)]);
    const wrongProof = storeRecords(fx).at(-1); expectRefusal(fx, FLOW_WRITER, ['round-land', PLAN_ID, '--dispose', 'queued', '--finding', second, '--claim', DEBT_CLAIM, '--proof-kind', 'consult-attestation', '--proof-digest', canonicalFlowDigest(wrongProof)], /proposedFixDigest does not equal/);
    const proposed = sha256hex(Buffer.from(`${itemDigest}\n${DEBT_CLAIM}`)); expectOk(fx, FLOW_WRITER, ['consult-attestation', PLAN_ID, '--backend', 'codex', '--nonce', nonce, '--proposed-fix-digest', proposed]); const proof = storeRecords(fx).at(-1);
    expectOk(fx, FLOW_WRITER, ['round-land', PLAN_ID, '--dispose', 'queued', '--finding', second, '--claim', DEBT_CLAIM, '--proof-kind', 'consult-attestation', '--proof-digest', canonicalFlowDigest(proof)]);
  });

  it('enforces item cap, escalation, and recorded custody loss without changing folded or rejected (spec:plan-review-loop/S33)', () => {
    const fx = armRung('aw-dogfood-cap', { debt: DEBT_BLOCK });
    const findings = '[blocker] first item\n[major] second item\nVerdict: revise\n'; const agy = '### Verdict\nSHIP\n\n### Blocking\n1. ship-side item\n';
    landWith(fx, { codex: { verdict: 'revise', blocking: 2, findings }, agy: { verdict: 'SHIP', blocking: 0, findings: agy } });
    expectOk(fx, FLOW_WRITER, ['round-land', PLAN_ID, '--dispose', 'rejected', '--finding', '[blocker] first item', '--reason', 'round 1: not a defect on this axis']);
    expectOk(fx, FLOW_WRITER, ['round-land', PLAN_ID, '--dispose', 'rejected', '--finding', '[major] second item', '--reason', 'round 1: not a defect on this axis']);
    attestWalk(fx, []);
    expectOk(fx, FLOW_WRITER, ['round-open', PLAN_ID, '--backend', 'codex', '--backend', 'agy']); landWith(fx, { codex: { verdict: 'revise', blocking: 2, findings }, agy: { verdict: 'SHIP', blocking: 0, findings: agy } }); attestWalk(fx, []);
    const cap = expectRefusal(fx, FLOW_WRITER, ['round-open', PLAN_ID, '--backend', 'codex', '--backend', 'agy'], /\[blocker\] first item[\s\S]*\[major\] second item/);
    assert.match(cap.stderr, new RegExp(sha256hex(Buffer.from('[blocker] first item'))));
    const head = lastRound(fx); expectOk(fx, FLOW_WRITER, ['maintainer-override', PLAN_ID, '--backend', 'codex', '--checkpoint-approved']); const override = storeRecords(fx).at(-1);
    expectOk(fx, FLOW_WRITER, ['round-land', PLAN_ID, '--dispose', 'escalated', '--finding', '[blocker] first item', '--override-digest', canonicalFlowDigest(override)]);
    expectRefusal(fx, FLOW_WRITER, ['round-land', PLAN_ID, '--dispose', 'escalated', '--finding', '1. ship-side item', '--override-digest', canonicalFlowDigest(override)], /the raiser did not veto this receipt/);
    const red = seedEvidence(fx, { schema: EVIDENCE_SCHEMA_VERSION, kind: 'red-proof', testId: 'app.txt#red case', file: 'app.txt', fileHash: sha256hex(readFileSync(join(fx.root, 'app.txt'))), runs: 1, reds: 1, base: head.base, fingerprint: fingerprintOf(fx), timestamp: new Date().toISOString() });
    expectOk(fx, FLOW_WRITER, ['round-land', PLAN_ID, '--dispose', 'folded', '--finding', '[major] second item', '--proof-kind', 'red-proof', '--proof-digest', canonicalFlowDigest(red)]);
    expectOk(fx, FLOW_WRITER, ['round-open', PLAN_ID, '--backend', 'codex', '--backend', 'agy']); landWith(fx);
    const current = lastRound(fx); const lost = current.dispatches.find((d) => d.backend === 'codex'); unlinkSync(join(fx.root, '.git', `agent-workflow-finding-manifest-codex-${lost.dispatchNonce}.json`));
    expectRefusal(fx, FLOW_WRITER, ['round-land', PLAN_ID, '--dispose', 'queued', '--finding', 'Verdict: ship', '--claim', DEBT_CLAIM, '--proof-kind', 'red-proof', '--proof-digest', canonicalFlowDigest(red)], /record custody-lost for the broken carrier before any quote-bearing disposition/);
    const loss = expectOk(fx, FLOW_WRITER, ['round-land', PLAN_ID, '--dispose', 'custody-lost', '--receipt', lost.receiptDigest]); assert.match(loss.stdout, new RegExp(`receiptDigest=${lost.receiptDigest}`));
    expectRefusal(fx, FLOW_WRITER, ['round-land', PLAN_ID, '--dispose', 'custody-lost', '--receipt', lost.receiptDigest], /this receipt already has a custody-lost disposition/);
    const intact = current.dispatches.find((d) => d.backend === 'agy'); expectRefusal(fx, FLOW_WRITER, ['round-land', PLAN_ID, '--dispose', 'custody-lost', '--receipt', intact.receiptDigest], /no loss to record/);
    expectOk(fx, FLOW_WRITER, ['round-land', PLAN_ID, '--dispose', 'rejected', '--finding', 'SHIP', '--reason', 'the raiser did not veto']);
  });
});

describe('flow dogfood — the tracked-docs/ai pipeline end to end (real CLIs, hermetic git)', { skip: !gitOk }, () => {
  it('drives set-flow → adoption → attempts → rounds → delta+refresh → terminals → --final → commit-guard, then the D10 movement refusal', () => {
    assert.equal(WRAPPER_MANIFEST_SCHEMA, FLOW_SCHEMA_VERSION, 'the manifest reader accepts exactly the wrapper wire schema — a reader bump is a wrapper-compat decision, never an auto-adaptation');
    const fx = makeFixture('aw-dogfood');

    // ── arming: preview first (nothing written), then --write seeds the tracked floors ──
    const preview = expectOk(fx, SET_FLOW, ['--preset', 'council']);
    assert.match(preview.stdout, /set-flow — preview \(nothing written\)/);
    assert.match(preview.stdout, /arming floors: PASS/);
    assert.equal('flow' in JSON.parse(readFileSync(join(fx.root, 'docs/ai/orchestration.json'), 'utf8')), false, 'a preview writes nothing');
    const wrote = expectOk(fx, SET_FLOW, ['--preset', 'council', '--write']);
    assert.match(wrote.stdout, /wrote docs\/ai\/orchestration\.json/);
    const flowBlock = JSON.parse(readFileSync(join(fx.root, 'docs/ai/orchestration.json'), 'utf8')).flow;
    assert.equal(flowBlock.debtQueue, 'docs/debt.md', 'the council preset seeds the tracked bookkeeping floors');

    // ── chain identity: write-plan-id, commit the armed config, adopt ──
    expectOk(fx, FLOW_WRITER, ['write-plan-id', PLAN_REL, '--plan-id', PLAN_ID]);
    assert.match(readFileSync(join(fx.root, PLAN_REL), 'utf8'), new RegExp(`^---\\nplanId: ${PLAN_ID}\\n`));
    git(fx, 'add', '-A');
    git(fx, 'commit', '-qm', 'arm the flow');
    expectOk(fx, FLOW_WRITER, ['adoption', PLAN_REL, '--label', 'Dogfood plan']);
    const adoption = storeRecords(fx).find((r) => r.purpose === 'adoption');
    assert.equal(adoption.owner, 'main');
    assert.equal(adoption.planId, PLAN_ID);

    // ── the initial --pre-review: the ADOPTION-context attempt (stepId null), derived subset ──
    const first = expectOk(fx, RUN_GATES, ['--pre-review']);
    assert.match(first.stdout, /pre-review subset attempt #1 recorded \(green\)/);
    assert.deepEqual(executedGateIds(first.stdout), MECHANICAL_GATE_IDS, 'the derived subset is EXACTLY the ordered mechanical set — review-state, flow-check AND coverage-check all excluded');
    const adoptionAttempt = subsetAttempts(fx)[0];
    assert.equal(adoptionAttempt.stepId, null, 'before any round the attempt keys the adoption context');

    // ── round 1: work staged, round-open BEFORE any backend runs, receipts at the EXACT
    //    staged fingerprint carrying the EXACT dispatch nonces ──
    writeFileSync(join(fx.root, 'app.txt'), 'ok work\n');
    git(fx, 'add', '-A');
    const opened = expectOk(fx, FLOW_WRITER, ['round-open', PLAN_ID, '--backend', 'codex', '--backend', 'agy', '--step', '4.1']);
    assert.match(opened.stdout, /dispatch backend=codex nonce=[0-9a-f]{32} watermark=0/);
    assert.match(opened.stdout, /AW_REVIEW_NONCE/, 'the dispatch line hands the nonce lane to the bridge dispatch');
    const round1 = lastRound(fx);
    assert.equal(round1.round, 1);
    assert.equal(round1.fingerprint, fingerprintOf(fx), 'the round binds the staged tree it dispatched');
    assert.deepEqual(round1.dispatches.map((d) => d.receiptWatermark), [0, 0], 'every first-round watermark sits at the empty receipts store');
    assert.equal(new Set(round1.dispatches.map((d) => d.dispatchNonce)).size, 2, 'per-dispatch nonces are unique within the round');
    const r1 = landCurrentRound(fx);
    const r1Revised = lastRound(fx);
    assert.equal(r1Revised.dispatches.filter((e) => e.receiptDigest !== null).length, 2, 'both dispatches landed in one revision');
    const codexEntry = r1Revised.dispatches.find((e) => e.backend === 'codex');
    assert.equal(codexEntry.findingManifestDigest, sha256hex(r1.minted.find((m) => m.entry.backend === 'codex').manifestBytes), 'the manifest digest is computed FROM the file bytes');

    // ── the red→fix→green retry at ONE counting context (the round-1 foldBatch) ──
    writeFileSync(join(fx.root, 'app.txt'), 'red-state\n');
    git(fx, 'add', '-A');
    const red = runTool(fx, RUN_GATES, ['--pre-review']);
    assert.equal(red.code, 1, 'the broken subset exits red');
    assert.match(red.stdout, /attempt #1 recorded \(red\)/);
    const redAttempt = subsetAttempts(fx).at(-1);
    assert.equal(redAttempt.stepId, '4.1');
    assert.notEqual(redAttempt.foldBatch, adoptionAttempt.foldBatch, 'a round context is a fresh budget');
    writeFileSync(join(fx.root, 'app.txt'), 'ok fixed\n');
    git(fx, 'add', '-A');
    const green = expectOk(fx, RUN_GATES, ['--pre-review']);
    assert.match(green.stdout, /attempt #2 recorded \(green\)/);
    assert.equal(subsetAttempts(fx).at(-1).foldBatch, redAttempt.foldBatch, 'the retry consumes the SAME counting context');

    // ── the fold moved the fingerprint: a NEW round (never a rebinding revision) + fresh receipts ──
    const receiptsBytesAtOpen2 = statSync(join(fx.root, '.git', RECEIPTS)).size;
    expectOk(fx, FLOW_WRITER, ['round-open', PLAN_ID, '--backend', 'codex', '--backend', 'agy']);
    const round2 = lastRound(fx);
    assert.equal(round2.round, 2);
    assert.equal(round2.opensFrom, null, 'an in-step round-open opens the NEXT round');
    assert.notEqual(round2.fingerprint, round1.fingerprint, 'a fingerprint move always opens a NEW round');
    assert.deepEqual(round2.dispatches.map((d) => d.receiptWatermark), [receiptsBytesAtOpen2, receiptsBytesAtOpen2], 'second-round watermarks sit at the pre-dispatch receipts-store byte length');
    const round1Nonces = new Set(round1.dispatches.map((d) => d.dispatchNonce));
    assert.equal(round2.dispatches.some((d) => round1Nonces.has(d.dispatchNonce)), false, 'nonce sets are disjoint across rounds — dispatch identity is per-dispatch fresh');
    // Exact-nonce selection, proven HEAD-ON: a DECOY receipt (same backend, the round's own
    // fingerprint, a WRONG nonce) sits past the watermark with BOTH manifests already present —
    // the decoy-nonce one AND the real-dispatch-nonce one — so a nonce-blind land that pairs any
    // post-watermark receipt with any present manifest WOULD bind here; the real matcher keys
    // the dispatch nonce, leaves both dispatches pending, and refuses the no-op revision.
    assert.equal(statSync(join(fx.root, '.git', RECEIPTS)).size, receiptsBytesAtOpen2, 'the decoy is the first post-watermark line');
    const decoyNonce = 'decoy-nonce-never-dispatched';
    appendReceipt(fx, { backend: 'codex', nonce: decoyNonce, fingerprint: round2.fingerprint });
    writeManifest(fx, { backend: 'codex', nonce: decoyNonce, fingerprint: round2.fingerprint });
    writeManifest(fx, { backend: 'codex', nonce: round2.dispatches.find((e) => e.backend === 'codex').dispatchNonce, fingerprint: round2.fingerprint });
    const roundsBeforeDecoy = roundRecordCount(fx);
    const decoyLand = runTool(fx, FLOW_WRITER, ['round-land', PLAN_ID]);
    assert.equal(decoyLand.code, 1, 'a decoy-only store lands nothing');
    assert.match(decoyLand.stderr, /nothing to land — no pending dispatch has an arrived receipt \(2 still pending\)/);
    assert.equal(roundRecordCount(fx), roundsBeforeDecoy, 'a refused land mints NO revision');
    assert.deepEqual(lastRound(fx).dispatches.map((e) => e.receiptDigest), [null, null], 'both dispatches stay pending — exact-nonce selection never binds the decoy');
    const r2 = landCurrentRound(fx);
    const r2Codex = lastRound(fx).dispatches.find((e) => e.backend === 'codex');
    assert.equal(r2Codex.receiptDigest, canonicalFlowDigest(r2.minted.find((m) => m.entry.backend === 'codex').receipt), 'round-land binds the EXACT-nonce receipt, never the decoy past the same watermark');

    // ── the sanctioned post-review move: tracked debt write + store-level delta mint + refresh ──
    const debtPath = join(fx.root, 'docs', 'debt.md');
    const preDebt = readFileSync(debtPath, 'utf8');
    writeFileSync(debtPath, `${preDebt}- queued: dogfood residual note\n`);
    const delta = mintDelta(fx, { path: 'docs/debt.md', fingerprintBefore: round2.fingerprint, preContent: preDebt });
    assert.equal(delta.record.fingerprintBefore, round2.fingerprint);
    assert.notEqual(delta.record.fingerprintAfter, round2.fingerprint);
    expectOk(fx, FLOW_WRITER, ['refresh', PLAN_ID, '--cause', 'bookkeeping delta re-attestation', '--refreshed-record', delta.digest]);
    // RESTAGE the debt write. Load-bearing invariance: for a tracked clean-at-path file whose
    // staged neighbors all sort before it, `git add` moves its diff section from the unstaged
    // blob to the staged tail with byte-identical content — the fingerprint (and therefore the
    // delta chain's reach) survives the restage, and the index carries the verified tree.
    git(fx, 'add', 'docs/debt.md');
    assert.equal(fingerprintOf(fx), delta.record.fingerprintAfter, 'restaging the declared bookkeeping write must not move the fingerprint the delta chain reaches');

    // ── terminals on the completeness-checked step, then the full final matrix ──
    expectOk(fx, FLOW_WRITER, ['freeze', PLAN_ID]);
    expectOk(fx, FLOW_WRITER, ['converged', PLAN_ID]);
    const finalRun = expectOk(fx, RUN_GATES, ['--final']);
    assert.match(finalRun.stdout, /final receipt recorded \(green\)/);
    const finalRecord = evidenceRecords(fx).findLast((r) => r.kind === 'final');
    assert.equal(finalRecord.status, 'green');
    assert.equal(finalRecord.fingerprintBefore, delta.record.fingerprintAfter, 'the final attests the delta-reached tree');
    assert.equal(finalRecord.fingerprintAfter, finalRecord.fingerprintBefore, 'the tree did not move under the final run');
    assert.deepEqual(finalRecord.declared.map((g) => g.id), DECLARED_GATE_IDS, 'the receipt binds the FULL declaration in declaration order');
    assert.deepEqual(finalRecord.results.map(({ id, ok }) => ({ id, ok })), DECLARED_GATE_IDS.map((id) => ({ id, ok: true })), 'all six declared gates ran green, in order');
    assert.match(finalRecord.evidenceHashes.flow ?? '', HEX64, 'the D10 receipt carries the owner-scoped flow projection hash');

    // ── commit-guard PASS names the armed flow + the delta-lifted council receipts ──
    const guardPass = expectOk(fx, COMMIT_GUARD, ['--check']);
    assert.match(guardPass.stdout, /commit-guard: PASS/);
    assert.match(guardPass.stdout, /flow: armed/);
    assert.match(guardPass.stdout, /lifted to CURRENT through an unbroken bookkeeping-delta chain/);

    // ── a FOREIGN worktree's open chain stays advisory: outside the owner projection, it moves
    //    neither the D10 hash nor the guard decision (#57) ──
    const foreignAdoption = {
      schema: FLOW_SCHEMA_VERSION, kind: CHAIN_KIND, purpose: 'adoption', planId: 'plan-foreign', cycle: 1, round: 0,
      commitEpoch: 0, owner: 'worktree:elsewhere', base: null, timestamp: new Date().toISOString(),
      stepId: null, fingerprint: 'f0'.repeat(32), planLabel: 'Foreign', createdAt: new Date().toISOString(), planDigest: 'f1'.repeat(32),
    };
    const foreignRound = {
      schema: FLOW_SCHEMA_VERSION, kind: CHAIN_KIND, purpose: 'round', planId: 'plan-foreign', cycle: 1, round: 1,
      commitEpoch: 0, owner: 'worktree:elsewhere', base: null, timestamp: new Date().toISOString(),
      stepId: 's1', fingerprint: 'f2'.repeat(32), opensFrom: canonicalFlowDigest(foreignAdoption), dispatches: [], dispositions: [],
    };
    appendFileSync(join(fx.root, '.git', FLOW_STORE), `${JSON.stringify(foreignAdoption)}\n${JSON.stringify(foreignRound)}\n`);
    const guardForeign = expectOk(fx, COMMIT_GUARD, ['--check']);
    assert.match(guardForeign.stdout, /commit-guard: PASS/, 'a foreign-worktree append never stales the guard');
    assert.match(guardForeign.stdout, /flow advisory/);
    assert.match(guardForeign.stdout, /foreign worktree/);

    // ── the D10 movement regression, end to end: an OWN-projection append after the final ──
    expectOk(fx, FLOW_WRITER, ['complete', PLAN_ID]);
    const guardMoved = runTool(fx, COMMIT_GUARD, ['--check']);
    assert.equal(guardMoved.code, 1);
    assert.match(guardMoved.stdout, /the flow store moved after the final run/);
    assert.match(guardMoved.stdout, /chain\/complete/, 'the diagnostic hypothesis names the live projection tail');
    assert.match(guardMoved.stdout, /re-run run-gates\.mjs --final/, 'the refusal names the self-servable recovery');
  });
});

describe('flow dogfood — the Decision-8 second-red stop pair (blind third refuses, diagnosed proceeds)', { skip: !gitOk }, () => {
  it('records two reds, refuses the blind third pre-gates, and proceeds with a byte-distinct diagnosis', () => {
    const fx = makeFixture('aw-dogfood-d8');
    expectOk(fx, SET_FLOW, ['--preset', 'council', '--write']);
    expectOk(fx, FLOW_WRITER, ['write-plan-id', PLAN_REL, '--plan-id', PLAN_ID]);
    git(fx, 'add', '-A');
    git(fx, 'commit', '-qm', 'arm the flow');
    expectOk(fx, FLOW_WRITER, ['adoption', PLAN_REL]);
    writeFileSync(join(fx.root, 'app.txt'), 'red-state\n');
    git(fx, 'add', '-A');

    const red1 = runTool(fx, RUN_GATES, ['--pre-review']);
    assert.equal(red1.code, 1);
    assert.match(red1.stdout, /attempt #1 recorded \(red\)/);
    assert.equal(gateRunCount(fx), 1, 'the red run executed the subset (the marker gate ran)');
    const red2 = runTool(fx, RUN_GATES, ['--pre-review']);
    assert.equal(red2.code, 1);
    assert.match(red2.stdout, /attempt #2 recorded \(red\)/);
    assert.match(red2.stdout, /SECOND red/, 'the second red completes, records, and prints the diagnosis rule');
    assert.equal(gateRunCount(fx), 2);

    const blind = runTool(fx, RUN_GATES, ['--pre-review']);
    assert.equal(blind.code, 1);
    assert.match(blind.stderr, /proceeds ONLY with a recorded diagnosis/);
    assert.match(blind.stderr, /no gates were run/);
    assert.equal(gateRunCount(fx), 2, 'the blind third refuses PRE-GATES — the marker gate never ran (the trace is unchanged)');
    assert.equal(subsetAttempts(fx).length, 2, 'a refused run records nothing');

    writeFileSync(join(fx.root, 'app.txt'), 'ok again\n');
    git(fx, 'add', '-A');
    const diagnosed = expectOk(fx, RUN_GATES, ['--pre-review', '--diagnosis', 'the fixture gate grepped stale app bytes']);
    assert.match(diagnosed.stdout, /attempt #3 recorded \(green\)/);
    assert.equal(gateRunCount(fx), 3, 'the diagnosed continuation actually ran the gates');
    assert.equal(subsetAttempts(fx).at(-1).diagnosis, 'the fixture gate grepped stale app bytes', 'the diagnosed continuation is a recorded, self-servable move — never a maintainer wait-state');
  });
});

// FLOW-FINAL-RED-DEADLOCK, end to end: the in-matrix flow-check gate used to demand the completed
// retry that only its OWN run could write, so every --final at an unchanged base minted red N+1.
// This is the case that would have failed on 5a3f070.
describe('flow dogfood — the #65 deadlock has a fixed point (defect 1)', { skip: !gitOk }, () => {
  it('a caused red at the current tree reaches a GREEN final in ONE run, and commit-guard then PASSes', () => {
    // Seeded, so the red sits at a tree that carries bytes — see armWithLandedRound. The tree must
    // then STAY there: the round's receipts bind this fingerprint, and moving it would make the
    // run red on review-state instead of on the rung this case pins.
    const fx = armWithLandedRound('aw-dogfood-deadlock', '1.1', 'ok work\n');
    expectOk(fx, FLOW_WRITER, ['freeze', PLAN_ID]);
    expectOk(fx, FLOW_WRITER, ['converged', PLAN_ID]);
    const fp = fingerprintOf(fx);
    const red = seedRedFinal(fx, { fingerprint: fp, attempt: 'deadlocked-red-1' });
    expectOk(fx, FLOW_WRITER, ['rerun-cause', '--attempt', red.attempt, '--cause', 'the failing gate is fixed; this retry runs on the tree that fix produced']);

    const finalRun = runTool(fx, RUN_GATES, ['--final']);
    assert.equal(finalRun.code, 0, `the deadlock is exactly this failure: every product gate green and the run still red — ${finalRun.stdout}${finalRun.stderr}`);
    const atTree = evidenceRecords(fx).filter((r) => r.kind === 'final' && r.fingerprintBefore === fp);
    assert.equal(atTree.at(-1).status, 'green', 'the NEWEST authoritative final at this tree is GREEN — not merely some older green');
    assert.notEqual(atTree.at(-1).attempt, red.attempt, 'the green closes the RETRY attempt, never the red it answers');
    const guard = runTool(fx, COMMIT_GUARD, ['--check']);
    assert.equal(guard.code, 0, `${guard.stdout}${guard.stderr}`);
    assert.match(guard.stdout, /commit-guard: PASS/);
  });
});

// The D4 residual, stated rather than papered over: an INTERRUPTED final run leaves a dangling
// start, and in that window the gate lane's conjunction holds with no live run behind it. It
// authorizes nothing — the commit boundary refuses twice over, independently.
describe('flow dogfood — the D4 interrupted-run residual, pinned in full (defect 1)', { skip: !gitOk }, () => {
  it('the gate lane PASSes while the commit-guard consumer AND the real guard both refuse', () => {
    const fx = armWithLandedRound('aw-dogfood-d4', '4.1');
    // Round 1 sat at the CLEAN tree, whose fingerprint is the content-free value every clean
    // moment shares — the #65 rung steps over a red minted there, so the red needs a round whose
    // tree carries bytes. Round 2 gives it one; round 3 then moves the tree again, so the red and
    // the guard read different fingerprints exactly as this residual requires.
    writeFileSync(join(fx.root, 'app.txt'), 'the work the red ran against\n');
    git(fx, 'add', '-A');
    expectOk(fx, FLOW_WRITER, ['round-open', PLAN_ID, '--backend', 'codex', '--backend', 'agy']);
    landCurrentRound(fx);
    const redTree = lastRound(fx).fingerprint;
    writeFileSync(join(fx.root, 'app.txt'), 'ok work\n');
    git(fx, 'add', '-A');
    expectOk(fx, FLOW_WRITER, ['round-open', PLAN_ID, '--backend', 'codex', '--backend', 'agy']);
    landCurrentRound(fx);
    expectOk(fx, FLOW_WRITER, ['freeze', PLAN_ID]);
    expectOk(fx, FLOW_WRITER, ['converged', PLAN_ID]);
    const fp = fingerprintOf(fx);
    assert.notEqual(fp, redTree, 'the fold moved the tree — the red and the guard read different fingerprints');
    // The cause is minted BEFORE the final run: a flow append after it would move the D10 projection
    // and the guard would refuse on THAT instead of the residual this case pins.
    expectOk(fx, FLOW_WRITER, ['rerun-cause', '--attempt', 'interrupted-red-1', '--cause', 'the fold landed; the retry runs on the moved tree']);
    expectOk(fx, RUN_GATES, ['--final']);
    // The D4 shape, in order: a caused red the green never answered (it precedes the red), then the
    // start an interrupted run left behind at the current tree.
    seedRedFinal(fx, { fingerprint: redTree, attempt: 'interrupted-red-1' });
    seedDanglingStart(fx, { fingerprint: fp, attempt: 'interrupted-attempt-1' });

    const gate = runTool(fx, FLOW_CHECK, ['--check']);
    assert.equal(gate.code, 0, `the gate lane reads PASS in the residual window (diagnostic only): ${gate.stdout}${gate.stderr}`);
    assert.ok(flowDecisionRefusals(fx, 'commit-guard').some((r) => /#65/.test(r)),
      'the commit-guard consumer keeps the strict completed-retry demand');
    const guard = runTool(fx, COMMIT_GUARD, ['--check']);
    assert.equal(guard.code, 1, `${guard.stdout}${guard.stderr}`);
    assert.match(guard.stdout, /a later final attempt started and never completed/,
      'the guard refuses on the dangling attempt independently, before it ever consults the flow arm');
  });
});
