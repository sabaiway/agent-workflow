// commit-guard.test.mjs — spec-first for the read-only commit guard (strip-the-kit 2.5, D10).
// The guard re-runs NO gate/test subprocess: it recomputes the current tree fingerprint (the
// review-state export), reads the LATEST completed final-run record from the core-evidence store,
// and compares { fingerprint before==after==current · declaration content · evidence hashes ·
// lcov hash } plus the ship receipts (the review-state decision). Integration: a REAL `git commit`
// in a fixture repo is refused per violation class; `--no-verify` stays the stated residual.
//
// The module under test is imported DYNAMICALLY (the authoring pattern): this spec LOADS — and
// fails per fixture — on the pre-implementation tree. D13 rides through every fixture: the final
// record is minted at the STAGED tree (staging moves the fingerprint), then the commit follows
// immediately.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { computeTreeFingerprint, readEvidence, canonicalKindSerialization, isTreeClean, computeWorkingState } from './core-evidence.mjs';
import { quoteReportName } from './review-state.mjs';

const guard = await import('./commit-guard.mjs').catch(() => null);
const { main, decideIndexLag, buildIndexLagRecovery, INDEX_LAG_PATH_CAP } = guard ?? {};
const GUARD_TOOL = fileURLToPath(new URL('./commit-guard.mjs', import.meta.url));

const fixtureEnv = (extra = {}) => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AW_')) delete env[k];
  return { ...env, ...extra };
};

const GATES = { gates: [{ id: 'noop', title: 'noop', cmd: 'true' }] };

// A repo with a committed base, a SOLO review config (the ship arm is exercised separately), a
// declared gates.json, and one staged change ready to commit. The committed base is identical
// everywhere — built once, cloned per test; only the staged change is re-added per clone.
const REPO_TEMPLATE = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'commit-guard-template-'));
  const g = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'probe@example.com');
  g('config', 'user.name', 'probe');
  mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'solo' } }));
  writeFileSync(join(dir, 'docs', 'ai', 'gates.json'), JSON.stringify(GATES));
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  return dir;
})();
after(() => rmSync(REPO_TEMPLATE, { recursive: true, force: true }));

const makeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'commit-guard-'));
  cpSync(REPO_TEMPLATE, root, { recursive: true });
  const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  writeFileSync(join(root, 'change.mjs'), 'export const x = 1;\n');
  g('add', '-A'); // D13: staged FIRST — the final record below binds the STAGED tree
  return { root, g };
};

const storeOf = (root) => join(root, '.git', 'agent-workflow-core-evidence.jsonl');
const sha = (text) => createHash('sha256').update(text).digest('hex');

// Seed a COMPLETED final-run record at the given fingerprint (the D3(a) receipt run-gates --final
// mints — seeded directly here; provenance is run-gates' own suite).
let attemptSeq = 0;
const seedFinal = (root, fingerprint, over = {}) => {
  const { records } = readEvidence(storeOf(root));
  attemptSeq += 1;
  const record = {
    schema: 1,
    kind: 'final',
    status: 'green',
    attempt: `attempt-${attemptSeq}`,
    fingerprintBefore: fingerprint,
    fingerprintAfter: fingerprint,
    declared: GATES.gates.map(({ id, cmd }) => ({ id, cmd })),
    results: [{ id: 'noop', ok: true, code: 0 }],
    evidenceHashes: {
      redProof: sha(canonicalKindSerialization(records, 'red-proof')),
      degrade: sha(canonicalKindSerialization(records, 'degrade')),
    },
    lcovSha256: null,
    integrityFailure: null,
    timestamp: '2026-07-17T00:00:00Z',
    ...over,
  };
  writeFileSync(storeOf(root), `${JSON.stringify(record)}\n`, { flag: 'a' });
  return record;
};
const seedStart = (root, fingerprint, attempt) => {
  const record = { schema: 1, kind: 'final-start', fingerprint, attempt, timestamp: '2026-07-17T00:00:01Z' };
  writeFileSync(storeOf(root), `${JSON.stringify(record)}\n`, { flag: 'a' });
  return record;
};

// A well-formed ATTESTING code receipt (the shape the bridges mint) at the given fingerprint.
const shipReceipt = (fp, backend) => JSON.stringify({
  schema: 1, artifact: 'code', fresh: true, fingerprint: fp, backend, verdict: 'ship',
  grounded: true, factsHash: null, wrapperVersion: '0.0.0', timestamp: '2026-07-17T00:00:00Z', probe: false,
  posture: { model: '<display>' },
});

// The council-config repo shape the ship-arm fixtures share: an in-flight plan + both backends required.
const makeCouncilRepo = () => {
  const { root } = makeRepo();
  writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'council' } }));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'active-plan.md'), '# plan\n');
  const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  g('add', '-A');
  return { root };
};

const installHook = (root) => {
  const hook = join(root, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, `#!/bin/sh\nexec node "${GUARD_TOOL}" --check --cwd "${root}"\n`);
  chmodSync(hook, 0o755);
};

const tryCommit = (root) => spawnSync('git', ['commit', '-qm', 'guarded'], { cwd: root, encoding: 'utf8', env: fixtureEnv() });

describe('commit-guard — module + refusal classes (unit --check)', () => {
  it('module exists (authored red-first)', () => {
    assert.ok(guard, 'commit-guard.mjs must exist and load');
  });

  it('NO completed final record at the current fingerprint → refuse naming the recovery', () => {
    const { root } = makeRepo();
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout + r.stderr, /no completed final-run record|run-gates\.mjs --final/);
  });

  it('a green record at a DIFFERENT fingerprint → refuse (the tree moved after the final run)', () => {
    const { root } = makeRepo();
    seedFinal(root, 'a'.repeat(64));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout + r.stderr, /fingerprint/);
  });

  it('a RED completed record never satisfies — and it KILLS an earlier green at the same fingerprint', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    seedFinal(root, fp, { status: 'green', timestamp: 't1' });
    seedFinal(root, fp, { status: 'red', results: [{ id: 'noop', ok: false, code: 1 }], timestamp: 't2' });
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'the LATEST completed attempt at a fingerprint is authoritative');
    assert.match(r.stdout + r.stderr, /red/i);
  });

  it('a DECLARATION edited after the final run → refuse (content mismatch)', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    seedFinal(root, fp);
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [{ id: 'noop', title: 'noop', cmd: 'true || true' }] }));
    // docs/ai is tracked in this fixture — restage so the fingerprint matches the receipt? No:
    // the declaration edit itself MOVES the fingerprint here, which is the honest double refusal;
    // pin the DECLARATION arm by re-minting at the edited tree's fingerprint.
    const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    g('add', '-A');
    seedFinal(root, computeTreeFingerprint(root)); // receipt matches the tree but DECLARED array is stale
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout + r.stderr, /declaration/);
  });

  it('an EVIDENCE-HASH mismatch → refuse (the store moved under the receipt)', () => {
    const { root } = makeRepo();
    const fp0 = computeTreeFingerprint(root);
    seedFinal(root, fp0, { evidenceHashes: { redProof: 'f'.repeat(64), degrade: 'f'.repeat(64) } });
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout + r.stderr, /evidence/);
  });

  it('a MALFORMED evidence store refuses closed (never "no record" by silence)', () => {
    const { root } = makeRepo();
    writeFileSync(storeOf(root), 'not json\n');
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout + r.stderr, /evidence store unavailable/);
    assert.match(r.stdout + r.stderr, /malformed/);
  });

  it('fingerprint before ≠ after on the receipt → refuse (the tree moved UNDER the final run)', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    seedFinal(root, fp, { fingerprintAfter: 'b'.repeat(64) });
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout + r.stderr, /UNDER the final run/);
  });

  it('an UNREADABLE declaration refuses naming the path (never a pass on a vanished gates.json)', () => {
    const { root } = makeRepo();
    rmSync(join(root, 'docs', 'ai', 'gates.json'));
    const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    g('add', '-A'); // the delete moves the fingerprint — re-mint at the CURRENT tree to pin THIS arm
    seedFinal(root, computeTreeFingerprint(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout + r.stderr, /no readable gate declaration/);
  });

  it('a receipt with lcovSha256 and a MATCHING lcov file passes; a vanished lcov refuses', () => {
    const { root } = makeRepo();
    const lcovPath = join(root, '.git', 'agent-workflow-lcov.info');
    writeFileSync(lcovPath, 'TN:\nend_of_record\n');
    const fp = computeTreeFingerprint(root);
    seedFinal(root, fp, { lcovSha256: sha('TN:\nend_of_record\n') });
    const ok = main(['--check', '--cwd', root], { env: fixtureEnv() });
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    rmSync(lcovPath);
    const gone = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(gone.code, 1);
    assert.match(gone.stdout + gone.stderr, /lcov.*moved or vanished/);
  });

  it('a dangling LATER final-start refuses (an attempt started after the green and never completed)', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    seedFinal(root, fp);
    seedStart(root, fp, 'attempt-dangling'); // interrupted / failed-append attempt — no completion
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout + r.stderr, /never completed/);
  });

  it('a completed later attempt CLOSES its start — the latest completion governs again', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    seedFinal(root, fp);
    seedStart(root, fp, 'attempt-two');
    seedFinal(root, fp, { attempt: 'attempt-two' });
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stdout + r.stderr);
  });

  it('a poisoned AW_LCOV_FILE is IGNORED — the guard reads only the fixed git-dir lcov', () => {
    const { root } = makeRepo();
    const outside = mkdtempSync(join(tmpdir(), 'commit-guard-poison-'));
    writeFileSync(join(outside, 'poison.info'), 'POISONED\n');
    writeFileSync(join(root, '.git', 'agent-workflow-lcov.info'), 'TN:\nend_of_record\n');
    seedFinal(root, computeTreeFingerprint(root), { lcovSha256: sha('TN:\nend_of_record\n') });
    const r = main(['--check', '--cwd', root], { env: fixtureEnv({ AW_LCOV_FILE: join(outside, 'poison.info') }) });
    rmSync(outside, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, `the stray override must not reach the guard: ${r.stdout}${r.stderr}`);
  });

  it('a poisoned AW_CORE_EVIDENCE is IGNORED — the guard reads only the fixed git-dir store', () => {
    const { root } = makeRepo();
    const outside = mkdtempSync(join(tmpdir(), 'commit-guard-forge-'));
    const forged = join(outside, 'forged.jsonl');
    const fp = computeTreeFingerprint(root);
    // The FORGED store carries a perfect green receipt; the REAL git-dir store has none.
    const real = storeOf(root);
    seedFinal(root, fp); // build a valid record shape…
    writeFileSync(forged, readFileSync(real));
    rmSync(real); // …then move it wholly into the forgery
    const r = main(['--check', '--cwd', root], { env: fixtureEnv({ AW_CORE_EVIDENCE: forged }) });
    rmSync(outside, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'a forged out-of-repo store must not satisfy the guard');
    assert.match(r.stdout + r.stderr, /no completed final-run record/);
  });

  it('a MISSING/VETOED ship receipt refuses (the review-state decision rides the guard)', () => {
    const { root } = makeCouncilRepo();
    const fp = computeTreeFingerprint(root);
    seedFinal(root, fp);
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout + r.stderr, /no receipt|review/);
  });

  it('a FORGED receipts store via AW_REVIEW_RECEIPTS is IGNORED — the ship arm reads the real git-dir receipts', () => {
    const { root } = makeCouncilRepo();
    const fp = computeTreeFingerprint(root);
    seedFinal(root, fp);
    const outside = mkdtempSync(join(tmpdir(), 'commit-guard-forge-receipts-'));
    const forged = join(outside, 'forged-receipts.jsonl');
    writeFileSync(forged, `${shipReceipt(fp, 'codex')}\n${shipReceipt(fp, 'agy')}\n`);
    const r = main(['--check', '--cwd', root], { env: fixtureEnv({ AW_REVIEW_RECEIPTS: forged }) });
    rmSync(outside, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'forged out-of-repo receipts must never satisfy the ship arm');
    assert.match(r.stdout + r.stderr, /review obligations/);
  });

  it('a FORGED degrade record via AW_CORE_EVIDENCE never exempts a backend — the escape reads the real git-dir store', () => {
    const { root } = makeCouncilRepo();
    const fp = computeTreeFingerprint(root);
    seedFinal(root, fp);
    // ONE real attesting ship receipt (codex) in the REAL git-dir receipts store…
    writeFileSync(join(root, '.git', 'agent-workflow-review-receipts.jsonl'), `${shipReceipt(fp, 'codex')}\n`);
    // …and a FORGED degrade for the other backend in an out-of-repo evidence store.
    const outside = mkdtempSync(join(tmpdir(), 'commit-guard-forge-degrade-'));
    const forged = join(outside, 'forged-evidence.jsonl');
    writeFileSync(forged, `${JSON.stringify({ schema: 1, kind: 'degrade', backend: 'agy', reason: 'forged exemption', fingerprint: fp, timestamp: 't' })}\n`);
    const r = main(['--check', '--cwd', root], { env: fixtureEnv({ AW_CORE_EVIDENCE: forged }) });
    rmSync(outside, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'a forged degrade must never exempt a required backend');
    assert.match(r.stdout + r.stderr, /review obligations/);
  });

  it('everything current → PASS (fingerprint + declaration + evidence hashes + ship arm)', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    seedFinal(root, fp);
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stdout + r.stderr);
  });

  it('usage errors are exit 2 with the reason on stderr (unknown argument; --cwd without a value)', () => {
    const unknown = main(['--check', '--nope'], { env: fixtureEnv() });
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown argument: --nope/);
    const dangling = main(['--check', '--cwd'], { env: fixtureEnv() });
    assert.equal(dangling.code, 2);
    assert.match(dangling.stderr, /--cwd needs a directory/);
  });
});

describe('commit-guard — integration: a REAL git commit is refused per violation class', () => {
  it('no receipt → the commit is refused by the pre-commit hook; with a current green receipt it lands', () => {
    const { root, g } = makeRepo();
    installHook(root);
    const refused = tryCommit(root);
    assert.notEqual(refused.status, 0, 'the hook must refuse an unreceipted commit');
    assert.match(`${refused.stdout}${refused.stderr}`, /final-run record|--final/);
    seedFinal(root, computeTreeFingerprint(root));
    const ok = tryCommit(root);
    assert.equal(ok.status, 0, `a receipted staged tree commits: ${ok.stdout}${ok.stderr}`);
    const log = g('log', '--oneline');
    assert.match(log.stdout, /guarded/);
    rmSync(root, { recursive: true, force: true });
  });

  it('a stale-fingerprint receipt → the commit is refused (edited after the final run)', () => {
    const { root, g } = makeRepo();
    installHook(root);
    seedFinal(root, computeTreeFingerprint(root));
    // STAGED edit after the final run: the index still carries the whole tree, so the earlier
    // index-lag arm passes and this fixture keeps pinning the FINGERPRINT arm specifically.
    writeFileSync(join(root, 'change.mjs'), 'export const x = 2;\n');
    g('add', '-A');
    const refused = tryCommit(root);
    rmSync(root, { recursive: true, force: true });
    assert.notEqual(refused.status, 0);
    assert.match(`${refused.stdout}${refused.stderr}`, /fingerprint/);
  });
});

// ── the index-lag arm (COMMIT-CAPTURE-BLINDNESS) ──────────────────────────────────────
// The gates and the fingerprint describe the WORKING tree; `git commit` takes the INDEX. The
// fingerprint domain is stage-INSENSITIVE for a tracked modification, so a lagging index was
// invisible to every arm. These fixtures pin the arm that closes it.

const gitIn = (dir, ...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });

describe('commit-guard — the index must already carry the verified tree', () => {
  it('an unstaged modification to a tracked file refuses, naming the path', () => {
    const { root } = makeRepo();
    writeFileSync(join(root, 'base.txt'), 'base edited but never staged\n');
    seedFinal(root, computeTreeFingerprint(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'a lagging index must never pass');
    assert.match(r.stdout + r.stderr, /base\.txt/, 'the refusal names the offending path');
    assert.match(r.stdout + r.stderr, /index/i);
  });

  it('a reviewable untracked-not-ignored path refuses, naming the path', () => {
    const { root } = makeRepo();
    writeFileSync(join(root, 'stray.mjs'), 'export const stray = 1;\n');
    seedFinal(root, computeTreeFingerprint(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'an untracked reviewable path is verified but never committed');
    assert.match(r.stdout + r.stderr, /stray\.mjs/);
  });

  it('the refusal names the whole-tree recovery: git add -A, re-run --final, commit the whole tree', () => {
    const { root } = makeRepo();
    writeFileSync(join(root, 'base.txt'), 'lagging\n');
    seedFinal(root, computeTreeFingerprint(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    const out = r.stdout + r.stderr;
    assert.match(out, /git add -A/, 'the recovery is the complete whole-tree stage, never a truncated path list');
    assert.match(out, /--final/, 'and it names the re-run that re-mints the receipt');
  });

  it('the diagnostic path list is capped and states the remainder', () => {
    const { root } = makeRepo();
    assert.equal(typeof INDEX_LAG_PATH_CAP, 'number', 'the cap is a named exported constant');
    const overflow = INDEX_LAG_PATH_CAP + 5;
    for (let i = 0; i < overflow; i += 1) writeFileSync(join(root, `stray-${i}.mjs`), `export const s${i} = 1;\n`);
    seedFinal(root, computeTreeFingerprint(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    const out = r.stdout + r.stderr;
    assert.equal(r.code, 1);
    assert.equal((out.match(/stray-\d+\.mjs/g) ?? []).length, INDEX_LAG_PATH_CAP, 'exactly the cap is listed');
    assert.match(out, new RegExp(`plus ${overflow - INDEX_LAG_PATH_CAP} further path\\(s\\) not listed`), 'the remainder count is stated, never silently dropped');
  });

  it('a path carrying whitespace, a newline, a control character or shell metacharacters renders on ONE quoteReportName-escaped line', () => {
    const { root } = makeRepo();
    const hostile = 'a b\ncd "e" $(f);g.mjs';
    writeFileSync(join(root, hostile), 'export const h = 1;\n');
    seedFinal(root, computeTreeFingerprint(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    const out = r.stdout + r.stderr;
    assert.equal(r.code, 1);
    assert.ok(out.includes(quoteReportName(hostile)), 'the path rides the SHARED renderer, not a second escaper');
    assert.doesNotMatch(out, /\n[^ ]*cd/, 'no filename byte breaks the line apart');
  });

  it('a dirty tracked submodule is recognised distinctly and gets its own recovery, not git add -A', () => {
    const { root, g } = makeRepo();
    const sub = join(root, 'sub');
    mkdirSync(sub);
    gitIn(sub, 'init', '-q');
    gitIn(sub, 'config', 'user.email', 'probe@example.com');
    gitIn(sub, 'config', 'user.name', 'probe');
    writeFileSync(join(sub, 'inner.txt'), 'inner\n');
    gitIn(sub, 'add', '-A');
    gitIn(sub, 'commit', '-qm', 'inner base');
    g('add', 'sub');
    writeFileSync(join(sub, 'inner.txt'), 'inner dirtied, never committed in the submodule\n');
    seedFinal(root, computeTreeFingerprint(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    const out = r.stdout + r.stderr;
    assert.equal(r.code, 1, 'a dirty submodule still means the commit ships less than was verified');
    assert.match(out, /submodule/i, 'it is named as a submodule, not lumped into the plain path list');
    assert.match(out, /sub/, 'the submodule path is named');
    assert.match(out, /gitlink|inside the submodule/i, 'and carries the recovery that actually works there');
  });

  it('a skip-worktree entry whose worktree bytes MOVED is still caught (git diff hides it)', () => {
    const { root, g } = makeRepo();
    g('commit', '-qm', 'base committed');
    g('update-index', '--skip-worktree', 'base.txt');
    writeFileSync(join(root, 'base.txt'), 'edited behind the skip-worktree bit\n');
    const hidden = g('diff', '--name-only');
    seedFinal(root, computeTreeFingerprint(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(hidden.stdout.trim(), '', 'NON-VACUOUS: plain git diff really is blind to this path');
    assert.equal(r.code, 1, 'the commit would take the stale INDEX blob — that is the same capture blindness');
    assert.match(r.stdout + r.stderr, /base\.txt/);
  });

  it('an ABSENT skip-worktree path is a normal sparse checkout and does NOT refuse; an absent assume-unchanged path does', () => {
    const { root, g } = makeRepo();
    g('commit', '-qm', 'base committed');
    g('update-index', '--skip-worktree', 'base.txt');
    rmSync(join(root, 'base.txt'));
    seedFinal(root, computeTreeFingerprint(root));
    const sparse = main(['--check', '--cwd', root], { env: fixtureEnv() });
    assert.equal(sparse.code, 0, `a de-materialised skip-worktree path must never refuse forever: ${sparse.stdout}${sparse.stderr}`);
    g('update-index', '--no-skip-worktree', 'base.txt');
    g('update-index', '--assume-unchanged', 'base.txt');
    seedFinal(root, computeTreeFingerprint(root));
    const assumed = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(assumed.code, 1, 'a MISSING assume-unchanged path is a real divergence from the index');
    assert.match(assumed.stdout + assumed.stderr, /base\.txt/);
  });

  it('an unchanged skip-worktree entry does NOT refuse (the comparison is content-exact, not presence-based)', () => {
    const { root, g } = makeRepo();
    g('commit', '-qm', 'base committed');
    g('update-index', '--skip-worktree', 'base.txt');
    seedFinal(root, computeTreeFingerprint(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, `identical bytes behind the bit are not a lag: ${r.stdout}${r.stderr}`);
  });

  // A flagged entry is compared by TYPE and content, not by a plain file hash: a symlink's stored
  // blob is its target text, and a path that changed kind never matches whatever its bytes say.
  const flaggedRepo = (prepare) => {
    const { root, g } = makeRepo();
    symlinkSync('base.txt', join(root, 'lnk'));
    g('add', '-A');
    g('commit', '-qm', 'base, change and the link committed');
    prepare(root, g);
    seedFinal(root, computeTreeFingerprint(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    return r;
  };

  it('a flagged SYMLINK whose target moved refuses; an unchanged one does not', () => {
    const changed = flaggedRepo((root, g) => {
      g('update-index', '--skip-worktree', 'lnk');
      rmSync(join(root, 'lnk'));
      symlinkSync('change.mjs', join(root, 'lnk'));
    });
    assert.equal(changed.code, 1, 'the stored blob IS the target text — a re-pointed link is a real lag');
    assert.match(changed.stdout + changed.stderr, /lnk/);
    const untouched = flaggedRepo((root, g) => g('update-index', '--skip-worktree', 'lnk'));
    assert.equal(untouched.code, 0, `an unchanged link is not a lag: ${untouched.stdout}${untouched.stderr}`);
  });

  it('a flagged entry that CHANGED KIND refuses (symlink→file, file→special node)', () => {
    const becameFile = flaggedRepo((root, g) => {
      g('update-index', '--skip-worktree', 'lnk');
      rmSync(join(root, 'lnk'));
      writeFileSync(join(root, 'lnk'), 'base.txt');
    });
    assert.equal(becameFile.code, 1, 'identical bytes cannot excuse a kind change — git stores the mode too');
    assert.match(becameFile.stdout + becameFile.stderr, /lnk/);
    const becameFifo = flaggedRepo((root, g) => {
      g('update-index', '--skip-worktree', 'base.txt');
      rmSync(join(root, 'base.txt'));
      const made = spawnSync('mkfifo', [join(root, 'base.txt')], { encoding: 'utf8' });
      assert.equal(made.status, 0, 'NON-VACUOUS: the fixture needs a real FIFO on this host');
    });
    assert.equal(becameFifo.code, 1, 'a tracked path that became a special node can never be committed as itself');
    assert.match(becameFifo.stdout + becameFifo.stderr, /base\.txt/);
  });

  it('a flagged entry whose EXECUTABLE BIT flipped refuses where core.fileMode applies', () => {
    const flipped = flaggedRepo((root, g) => {
      g('config', 'core.fileMode', 'true');
      g('update-index', '--skip-worktree', 'base.txt');
      chmodSync(join(root, 'base.txt'), 0o755);
    });
    assert.equal(flipped.code, 1, 'the mode is part of what the commit would take');
    assert.match(flipped.stdout + flipped.stderr, /base\.txt/);
    const ignoredMode = flaggedRepo((root, g) => {
      g('config', 'core.fileMode', 'false');
      g('update-index', '--skip-worktree', 'base.txt');
      chmodSync(join(root, 'base.txt'), 0o755);
    });
    assert.equal(ignoredMode.code, 0, `core.fileMode=false hosts must not read every exec bit as a lag: ${ignoredMode.stdout}${ignoredMode.stderr}`);
  });

  it('a configured diff.ignoreSubmodules=all can no longer blind the submodule arm', () => {
    const { root, g } = makeRepo();
    const sub = join(root, 'sub');
    mkdirSync(sub);
    gitIn(sub, 'init', '-q');
    gitIn(sub, 'config', 'user.email', 'probe@example.com');
    gitIn(sub, 'config', 'user.name', 'probe');
    writeFileSync(join(sub, 'inner.txt'), 'inner\n');
    gitIn(sub, 'add', '-A');
    gitIn(sub, 'commit', '-qm', 'inner base');
    g('add', 'sub');
    g('config', 'diff.ignoreSubmodules', 'all');
    writeFileSync(join(sub, 'inner.txt'), 'dirtied behind the ignore config\n');
    const blinded = g('diff', '--name-only');
    seedFinal(root, computeTreeFingerprint(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(blinded.stdout.trim(), '', 'NON-VACUOUS: the repo config really does erase it from a plain diff');
    assert.equal(r.code, 1);
    assert.match(r.stdout + r.stderr, /submodule/i);
  });

  const submoduleRepo = () => {
    const { root, g } = makeRepo();
    const sub = join(root, 'sub');
    mkdirSync(sub);
    gitIn(sub, 'init', '-q');
    gitIn(sub, 'config', 'user.email', 'probe@example.com');
    gitIn(sub, 'config', 'user.name', 'probe');
    writeFileSync(join(sub, 'inner.txt'), 'inner\n');
    gitIn(sub, 'add', '-A');
    gitIn(sub, 'commit', '-qm', 'inner base');
    g('add', 'sub');
    g('commit', '-qm', 'gitlink committed');
    return { root, g, sub };
  };

  it('neither index bit can hide a dirty or moved submodule from the arm', () => {
    for (const bit of ['--skip-worktree', '--assume-unchanged']) {
      const { root, g, sub } = submoduleRepo();
      g('update-index', bit, 'sub');
      writeFileSync(join(sub, 'inner.txt'), 'dirtied behind the index bit\n');
      const blinded = g('diff', '--name-only');
      seedFinal(root, computeTreeFingerprint(root));
      const dirty = main(['--check', '--cwd', root], { env: fixtureEnv() });
      assert.equal(blinded.stdout.trim(), '', `NON-VACUOUS: ${bit} really hides it from a plain diff`);
      assert.equal(dirty.code, 1, `${bit} must not hide a dirty submodule`);
      assert.match(dirty.stdout + dirty.stderr, /submodule/i);
      gitIn(sub, 'add', '-A');
      gitIn(sub, 'commit', '-qm', 'moved HEAD');
      seedFinal(root, computeTreeFingerprint(root));
      const moved = main(['--check', '--cwd', root], { env: fixtureEnv() });
      rmSync(root, { recursive: true, force: true });
      assert.equal(moved.code, 1, `${bit} must not hide a MOVED submodule HEAD either`);
      assert.match(moved.stdout + moved.stderr, /sub/);
    }
  });

  it('a config-hidden STAGED gitlink no longer reads as a clean tree (the staged probe forces --ignore-submodules=none)', () => {
    const { root, g, sub } = submoduleRepo();
    g('config', 'diff.ignoreSubmodules', 'all');
    gitIn(sub, 'commit', '--allow-empty', '-qm', 'moved HEAD');
    g('add', 'sub');
    const blinded = g('diff', '--cached', '--name-only');
    const clean = isTreeClean(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(blinded.stdout.trim(), '', 'NON-VACUOUS: the config really does hide the staged gitlink');
    assert.equal(clean, false, 'a staged gitlink is uncommitted work — review-state must not wave it through as clean');
  });

  it('an ABSENT skip-worktree GITLINK is a sparse checkout, not an endless refusal', () => {
    const { root, g } = submoduleRepo();
    g('update-index', '--skip-worktree', 'sub');
    rmSync(join(root, 'sub'), { recursive: true, force: true });
    seedFinal(root, computeTreeFingerprint(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, `materialisation is checked BEFORE the submodule probes: ${r.stdout}${r.stderr}`);
  });

  // No nested-probe tests remain: the reduction removed that surface entirely, so a fixture
  // configuring the submodule's own status/env would now pass for a reason unrelated to what it
  // claims to check. The reduction test above covers the whole class.

  it('under core.symlinks=false a materialised placeholder file matching the stored target is NOT a lag', () => {
    const current = flaggedRepo((root, g) => {
      g('config', 'core.symlinks', 'false');
      g('update-index', '--skip-worktree', 'lnk');
      rmSync(join(root, 'lnk'));
      writeFileSync(join(root, 'lnk'), 'base.txt'); // git's own placeholder: the raw target bytes
    });
    assert.equal(current.code, 0, `a symlink-less host must not refuse forever: ${current.stdout}${current.stderr}`);
    const moved = flaggedRepo((root, g) => {
      g('config', 'core.symlinks', 'false');
      g('update-index', '--skip-worktree', 'lnk');
      rmSync(join(root, 'lnk'));
      writeFileSync(join(root, 'lnk'), 'change.mjs');
    });
    assert.equal(moved.code, 1, 'but a placeholder pointing somewhere else is still a real divergence');
    assert.match(moved.stdout + moved.stderr, /lnk/);
  });

  // The printed recovery must CONVERGE, not merely sound plausible: `git add -A` cannot restage an
  // entry carrying either index bit, so a run-the-recovery-verbatim round trip is the only proof.
  // The recovery is EXECUTED from the plan the guard renders, never reconstructed by the test —
  // otherwise the test quietly proves its own commands work rather than the printed ones.
  const runPrintedRecovery = (root, g) => {
    const state = computeWorkingState(root);
    for (const step of buildIndexLagRecovery(state)) {
      if (step.argv) assert.equal(g(...step.argv).status, 0, `the printed step must run: git ${step.argv.join(' ')}`);
    }
  };

  for (const bits of [['--skip-worktree'], ['--assume-unchanged'], ['--skip-worktree', '--assume-unchanged']]) {
    it(`the PRINTED recovery plan converges for a flagged file (${bits.join(' + ')})`, () => {
      const { root, g } = makeRepo();
      g('commit', '-qm', 'base committed');
      for (const bit of bits) g('update-index', bit, 'base.txt'); // separately: one call applies one bit
      writeFileSync(join(root, 'base.txt'), 'edited behind the index bits\n');
      installHook(root);
      seedFinal(root, computeTreeFingerprint(root));
      const refused = tryCommit(root);
      assert.notEqual(refused.status, 0, 'the lag must be caught first');
      assert.equal(g('add', '-A').status, 0);
      assert.notEqual(tryCommit(root).status, 0, 'NON-VACUOUS: git add -A alone genuinely does NOT restage these entries');
      runPrintedRecovery(root, g);
      seedFinal(root, computeTreeFingerprint(root));
      const landed = tryCommit(root);
      const residual = main(['--check', '--cwd', root], { env: fixtureEnv() });
      rmSync(root, { recursive: true, force: true });
      assert.equal(landed.status, 0, `the printed plan must land the commit: ${landed.stdout}${landed.stderr}`);
      assert.doesNotMatch(residual.stdout + residual.stderr, /does NOT carry/, 'and leave no index-lag refusal behind');
    });
  }

  it('the PRINTED recovery plan converges for a flagged GITLINK too — submodule first, then the bits', () => {
    const { root, g, sub } = submoduleRepo();
    g('update-index', '--skip-worktree', 'sub');
    writeFileSync(join(sub, 'inner.txt'), 'dirtied\n');
    installHook(root);
    seedFinal(root, computeTreeFingerprint(root));
    const refused = tryCommit(root);
    const out = `${refused.stdout}${refused.stderr}`;
    assert.notEqual(refused.status, 0);
    assert.ok(out.indexOf('INSIDE every dirty submodule') < out.indexOf('git update-index'), 'the submodule step precedes the bit-clearing step');
    assert.ok(out.indexOf('git update-index') < out.indexOf('run git add -A from the work-tree root'), 'and the bit-clearing precedes the staging step');
    gitIn(sub, 'add', '-A'); // step 1 is prose — only the operator can act inside the submodule
    gitIn(sub, 'commit', '-qm', 'cleaned inside');
    runPrintedRecovery(root, g);
    seedFinal(root, computeTreeFingerprint(root));
    const landed = tryCommit(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(landed.status, 0, `the composed plan must land: ${landed.stdout}${landed.stderr}`);
  });

  // Driven through an injected runner rather than the filesystem: a JS string cannot carry the
  // invalid bytes through spawnSync argv, so a real-repo fixture would silently create a DIFFERENT
  // file and prove nothing. Here git's raw -z output is the input, which is exactly what the guard
  // parses.
  it('a flagged path whose name is not valid UTF-8 lags instead of reading as a de-materialised sparse path', () => {
    const oid = 'a'.repeat(40);
    const invalidName = Buffer.concat([Buffer.from('bad-'), Buffer.from([0xff, 0xfe]), Buffer.from('.txt')]);
    const ok = (out) => ({ status: 0, stdout: Buffer.isBuffer(out) ? out : Buffer.from(out), stderr: Buffer.from('') });
    const runGit = (args) => {
      if (args[0] === 'rev-parse') return ok('/tmp/fake-root\n');
      if (args[0] === 'diff' && args[1] === '--cached') return ok('');
      if (args[0] === 'diff') return ok('');
      if (args[0] === 'config') return { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('') };
      if (args[0] === 'ls-files' && args[1] === '--others') return ok('');
      if (args[0] === 'ls-files' && args[1] === '-v') return ok(Buffer.concat([Buffer.from('S '), invalidName, Buffer.from([0])]));
      if (args[0] === 'ls-files' && args[1] === '-s') return ok(Buffer.concat([Buffer.from(`100644 ${oid} 0\t`), invalidName, Buffer.from([0])]));
      return ok('');
    };
    // Probed by RAW bytes: the materialised case must lag, and — the data-loss half — a legitimately
    // ABSENT invalid-byte sparse entry must NOT, or the prescribed bit-clear plus git add -A would
    // stage its deletion.
    const present = computeWorkingState('/tmp/fake-root', { runGit, lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, mode: 0o644 }) });
    const sparse = computeWorkingState('/tmp/fake-root', {
      runGit,
      lstat: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    });
    assert.equal(sparse.unstagedPaths.length, 0, 'an absent invalid-byte skip-worktree entry is an ordinary sparse path, never a lag');
    assert.equal(decideIndexLag(sparse), null, 'so nothing is refused and no deletion can be prescribed');
    const state = present;
    const lossy = invalidName.toString('utf8');
    assert.notEqual(Buffer.from(lossy, 'utf8').compare(invalidName), 0, 'NON-VACUOUS: this name genuinely does not survive a UTF-8 round trip');
    assert.ok(state.unstagedPaths.includes(lossy), 'an unprovable name can never be waved through as an absent sparse path');
    const refusal = decideIndexLag(state);
    assert.notEqual(refusal, null);
    // The displayed name is lossy, so the recovery must point at a source that can still yield the
    // exact bytes — and `git status` is not one: the index bit hides the path from it too.
    const text = refusal.lines.join('\n');
    assert.match(text, /LOSSY/, 'the refusal says plainly that the displayed name is not the real one');
    assert.match(text, /by-hand step/, 'and offers no command it cannot make correct');
    assert.doesNotMatch(text, /git status -z/, 'a bit-carrying path is invisible to git status — offering it would dead-end');
    assert.doesNotMatch(text, /update-index[^;]*--stdin/, 'and no pipeline is printed that the ls-files record prefix would break');
    assert.equal(buildIndexLagRecovery(state).some((step) => step.argv?.[0] === 'update-index'), false, 'no executable argv is offered for a name that cannot be addressed exactly');
  });

  // The worst failure the recovery could cause is not a wrong refusal but LOST WORK: in a sparse
  // checkout `git ls-files -v` also lists every de-materialised `S` path, so clearing their bit and
  // running `git add -A` would stage their deletions. The recovery is therefore scoped to the
  // lagging paths only, and this executes the SHOWN plan to prove no deletion is ever staged.
  it('a sparse checkout keeps its de-materialised paths — the printed recovery never stages their deletion', () => {
    const { root, g } = makeRepo();
    writeFileSync(join(root, 'sparse-a.txt'), 'a\n');
    writeFileSync(join(root, 'sparse-b.txt'), 'b\n');
    g('add', '-A');
    g('commit', '-qm', 'base plus two sparse candidates');
    for (const rel of ['sparse-a.txt', 'sparse-b.txt']) {
      g('update-index', '--skip-worktree', rel);
      rmSync(join(root, rel));
    }
    g('update-index', '--skip-worktree', 'base.txt');
    writeFileSync(join(root, 'base.txt'), 'the ONE genuinely lagging flagged path\n');
    seedFinal(root, computeTreeFingerprint(root));
    const refused = main(['--check', '--cwd', root], { env: fixtureEnv() });
    assert.equal(refused.code, 1);
    assert.match(refused.stdout, /base\.txt/, 'only the lagging path is named');
    assert.doesNotMatch(refused.stdout, /sparse-a\.txt/, 'a de-materialised sparse path must never enter the recovery');
    runPrintedRecovery(root, g);
    const staged = g('diff', '--cached', '--name-status');
    const survives = g('ls-files', 'sparse-a.txt', 'sparse-b.txt');
    rmSync(root, { recursive: true, force: true });
    assert.doesNotMatch(staged.stdout, /^D/m, `the printed recovery must never stage a deletion: ${staged.stdout}`);
    assert.match(survives.stdout, /sparse-a\.txt/, 'and the sparse entries stay in the index');
    assert.match(survives.stdout, /sparse-b\.txt/);
  });

  it('the recovery names only the paths it holds, never every git ls-files -v entry', () => {
    const { root, g } = makeRepo();
    g('commit', '-qm', 'base committed');
    const hostile = 'x y\nz "q" $(r).txt';
    writeFileSync(join(root, hostile), 'flagged and hostile\n');
    g('add', '-A');
    g('commit', '-qm', 'hostile committed');
    g('update-index', '--skip-worktree', hostile);
    writeFileSync(join(root, hostile), 'edited behind the bit\n');
    seedFinal(root, computeTreeFingerprint(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    const out = r.stdout + r.stderr;
    assert.equal(r.code, 1);
    assert.match(out, /never every entry git ls-files -v reports/, 'the over-collecting enumeration is explicitly warned against, not offered');
    assert.match(out, /re-run this guard after each pass/, 'the cap is handled by an iteration with a stated completion signal');
    assert.ok(out.includes(quoteReportName(hostile)), 'the diagnostic name stays escaped for DISPLAY');
    assert.doesNotMatch(out, /update-index[^;]*\$\(r\)/, 'but a hostile name is never pasted into a runnable command');
  });

  it('the recovery orders the submodule step FIRST, before git add -A and the final re-run', () => {
    const { root, g, sub } = submoduleRepo();
    writeFileSync(join(sub, 'inner.txt'), 'dirtied\n');
    seedFinal(root, computeTreeFingerprint(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    const out = r.stdout + r.stderr;
    assert.equal(r.code, 1);
    assert.ok(out.indexOf('INSIDE every dirty submodule') < out.indexOf('run git add -A from the work-tree root'), 'staging before the submodule fix would stale the fresh receipt at once');
    assert.match(out, /every dirty submodule named above/, 'each category reserves a budget slot, so "named above" is always a real list');
    assert.doesNotMatch(out, /node agent-workflow-kit\/tools\/run-gates\.mjs/, 'the run-gates path is RESOLVED, never a repo-relative literal a consumer install would not have');
    assert.match(out, /re-run node \/.*run-gates\.mjs --final/, 'it points at the tool sitting beside this one');
  });

  // THE REDUCTION: a flagged gitlink is not proven current at all. Three review rounds each found a
  // new way for a nested probe to answer "clean" wrongly, so the guard stops asking. This refuses
  // even a genuinely clean submodule — acceptable only because the recovery converges, which is
  // what the second half asserts.
  it('a flagged gitlink refuses even when current and clean, and the printed recovery converges', () => {
    const { root, g } = submoduleRepo();
    g('update-index', '--skip-worktree', 'sub');
    installHook(root);
    seedFinal(root, computeTreeFingerprint(root));
    const refused = tryCommit(root);
    assert.notEqual(refused.status, 0, 'the guard no longer claims to prove a flagged submodule current');
    assert.match(`${refused.stdout}${refused.stderr}`, /sub/);
    runPrintedRecovery(root, g);
    seedFinal(root, computeTreeFingerprint(root));
    // Nothing is left to commit here — the submodule really was clean — so convergence is the
    // guard falling silent, not a landed commit.
    const after = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(after.code, 0, `clearing the bit is a converging recovery, not an endless refusal: ${after.stdout}${after.stderr}`);
  });

  it('an UNflagged submodule is unaffected by the reduction — the ordinary probe still judges it', () => {
    const { root } = submoduleRepo();
    seedFinal(root, computeTreeFingerprint(root));
    const clean = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(clean.code, 0, `a clean unflagged submodule must still pass: ${clean.stdout}${clean.stderr}`);
  });

  it('the exec-bit comparison uses the OWNER bit: group-only exec is NOT a lag, owner exec IS', () => {
    const groupOnly = flaggedRepo((root, g) => {
      g('config', 'core.fileMode', 'true');
      g('update-index', '--skip-worktree', 'base.txt');
      chmodSync(join(root, 'base.txt'), 0o664);
    });
    assert.equal(groupOnly.code, 0, `git canonicalises on owner-exec, so 0o664 still matches 100644: ${groupOnly.stdout}${groupOnly.stderr}`);
    const ownerExec = flaggedRepo((root, g) => {
      g('config', 'core.fileMode', 'true');
      g('update-index', '--skip-worktree', 'base.txt');
      chmodSync(join(root, 'base.txt'), 0o744);
    });
    assert.equal(ownerExec.code, 1, 'owner-exec against a 100644 entry is a real mode divergence');
    assert.match(ownerExec.stdout + ownerExec.stderr, /base\.txt/);
  });

  it('core.fileMode false SYNONYMS are honoured (no / off / 0), not just the literal "false"', () => {
    for (const synonym of ['no', 'off', '0']) {
      const r = flaggedRepo((root, g) => {
        g('config', 'core.fileMode', synonym);
        g('update-index', '--skip-worktree', 'base.txt');
        chmodSync(join(root, 'base.txt'), 0o755);
      });
      assert.equal(r.code, 0, `core.fileMode=${synonym} must suppress the mode comparison: ${r.stdout}${r.stderr}`);
    }
  });

  // The tag vocabulary is pinned against the LIVE git rather than assumed — and the fixture matters:
  // asking for BOTH bits in one `update-index` invocation lands only one of them, so the two bits
  // are set in separate calls here. Set that way the entry reports lowercase `s`, which is why the
  // skip test is case-insensitive: skip-worktree still applies, so a de-materialised path stays an
  // ordinary sparse checkout instead of an endless refusal.
  it('the ls-files tag vocabulary is pinned live: S alone, h for assume-unchanged, s for both — and skip-worktree wins the absent-path rule', () => {
    const { root, g } = makeRepo();
    g('commit', '-qm', 'base committed');
    g('update-index', '--skip-worktree', 'base.txt');
    const skipOnly = g('ls-files', '-v', 'base.txt').stdout;
    g('update-index', '--no-skip-worktree', 'base.txt');
    g('update-index', '--assume-unchanged', 'base.txt');
    const assumeOnly = g('ls-files', '-v', 'base.txt').stdout;
    g('update-index', '--skip-worktree', 'base.txt');
    const both = g('ls-files', '-v', 'base.txt').stdout;
    rmSync(join(root, 'base.txt'));
    seedFinal(root, computeTreeFingerprint(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.match(skipOnly, /^S /, 'skip-worktree alone is the uppercase S the sparse-checkout rule keys on');
    assert.match(assumeOnly, /^h /, 'assume-unchanged alone lowercases the cached tag');
    assert.match(both, /^s /, 'BOTH bits lowercase the S — a case-sensitive test would lose skip-worktree here');
    assert.equal(r.code, 0, `skip-worktree still applies, so a de-materialised path stays an ordinary sparse checkout: ${r.stdout}${r.stderr}`);
  });

  it('a non-ENOENT lstat failure never reads as "not materialised" — it lags', () => {
    const { root, g } = makeRepo();
    g('commit', '-qm', 'base committed');
    g('update-index', '--skip-worktree', 'base.txt');
    const denied = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    const state = computeWorkingState(root, { lstat: denied });
    rmSync(root, { recursive: true, force: true });
    assert.ok(state.unstagedPaths.includes('base.txt'), 'an unprovable path can never be waved through as absent');
  });

  it('the overflow message still NAMES a submodule — every non-empty category reserves a slot', () => {
    const { root, g, sub } = submoduleRepo();
    writeFileSync(join(sub, 'inner.txt'), 'dirtied\n');
    for (let i = 0; i < INDEX_LAG_PATH_CAP + 4; i += 1) writeFileSync(join(root, `stray-${i}.mjs`), `export const s${i} = 1;\n`);
    seedFinal(root, computeTreeFingerprint(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    const out = r.stdout + r.stderr;
    assert.equal(r.code, 1);
    assert.match(out, /tracked submodule\(s\) not proven current: "sub"/, 'the submodule clause must carry its own name to be actionable');
    // Whenever the cap hides work — bits or not — the iterate hint must fire, or the operator is
    // sent to --final and commit with unnamed paths still unhandled.
    assert.match(out, /re-run this guard after each pass/, 'a non-zero remainder always arms the iterate-until-silent hint');
    assert.equal((out.match(/"[^"]*"/g) ?? []).length, INDEX_LAG_PATH_CAP, 'the shared budget still holds');
    assert.match(out, /plus \d+ further path\(s\) not listed\./, 'the remainder sits with the lists it counts, before the recovery text');
  });

  it('a flagged symlink whose readlink THROWS counts as lagging (fail-safe, never provably current)', () => {
    const { root, g } = makeRepo();
    symlinkSync('base.txt', join(root, 'lnk'));
    g('add', '-A');
    g('commit', '-qm', 'link committed');
    g('update-index', '--skip-worktree', 'lnk');
    const throwing = () => { throw new Error('EACCES'); };
    const state = computeWorkingState(root, { readlink: throwing });
    rmSync(root, { recursive: true, force: true });
    assert.ok(state.unstagedPaths.includes('lnk'), 'an unreadable link can never be proven to match the index');
    assert.notEqual(decideIndexLag(state), null);
  });

  it('a signal-killed probe (status null) is NOT read as a clean index — the allowlist is 0 or 1', () => {
    const killed = { status: null, signal: 'SIGKILL', stdout: Buffer.from(''), stderr: Buffer.from('') };
    const ok = (out) => ({ status: 0, stdout: Buffer.from(out), stderr: Buffer.from('') });
    const runGit = (args) => {
      if (args[0] === 'rev-parse') return ok('/tmp/fake-root\n');
      if (args[0] === 'diff' && args[1] === '--cached') return killed;
      return ok('');
    };
    const state = computeWorkingState('/tmp/fake-root', { runGit });
    assert.equal(state, null, 'an unusable exit status can never become stagedDirty:false');
    assert.notEqual(decideIndexLag(state), null, 'and the arm refuses on it, fail-closed');
  });

  it('the shared path budget spans BOTH categories — never the cap twice', () => {
    const { root, g } = makeRepo();
    const sub = join(root, 'sub');
    mkdirSync(sub);
    gitIn(sub, 'init', '-q');
    gitIn(sub, 'config', 'user.email', 'probe@example.com');
    gitIn(sub, 'config', 'user.name', 'probe');
    writeFileSync(join(sub, 'inner.txt'), 'inner\n');
    gitIn(sub, 'add', '-A');
    gitIn(sub, 'commit', '-qm', 'inner base');
    g('add', 'sub');
    writeFileSync(join(sub, 'inner.txt'), 'dirtied\n');
    for (let i = 0; i < INDEX_LAG_PATH_CAP + 3; i += 1) writeFileSync(join(root, `stray-${i}.mjs`), `export const s${i} = 1;\n`);
    seedFinal(root, computeTreeFingerprint(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    const out = r.stdout + r.stderr;
    const named = (out.match(/"[^"]*"/g) ?? []).length;
    assert.equal(r.code, 1);
    assert.equal(named, INDEX_LAG_PATH_CAP, 'the cap is ONE budget across every category, not one per category');
    assert.match(out, /plus \d+ further path\(s\) not listed/, 'one remainder count covers everything hidden');
  });

  it('the refusal speaks about the CURRENT working tree, never claiming the gates verified it', () => {
    const { root } = makeRepo();
    writeFileSync(join(root, 'base.txt'), 'lagging\n');
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    const out = r.stdout + r.stderr;
    assert.match(out, /CURRENT working tree/, 'this arm runs before any receipt is read');
    assert.doesNotMatch(out, /gates verified/, 'so it can make no claim about what the gates checked');
  });

  it('an undecidable git probe REFUSES with a named cause (fail-closed)', () => {
    assert.equal(typeof decideIndexLag, 'function', 'the arm exposes a pure decider');
    const refusal = decideIndexLag(null);
    assert.notEqual(refusal, null, 'an undecidable probe never falls through to the fingerprint arm');
    assert.equal(refusal.code, 1);
    assert.match(refusal.lines.join('\n'), /REFUSED/, 'it refuses in the shared voice');
  });

  it('the index-lag refusal precedes the stale-fingerprint refusal', () => {
    const { root } = makeRepo();
    writeFileSync(join(root, 'base.txt'), 'lagging, and NO final record exists either\n');
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    const out = r.stdout + r.stderr;
    assert.match(out, /base\.txt/, 'the index-lag arm answers FIRST — its recovery subsumes the others');
    assert.doesNotMatch(out, /no completed final-run record/, 'the fingerprint arm never speaks over it');
  });

  it('a fully staged tree still passes — the index carries the whole verified domain', () => {
    const { root } = makeRepo();
    seedFinal(root, computeTreeFingerprint(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stdout + r.stderr);
  });

  it('an IGNORED-only difference does NOT refuse', () => {
    const { root } = makeRepo();
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'ignored-scratch.txt\n');
    writeFileSync(join(root, 'ignored-scratch.txt'), 'never reviewable\n');
    seedFinal(root, computeTreeFingerprint(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, `an ignored path is outside the verified domain: ${r.stdout}${r.stderr}`);
  });

  it('a never-committable-only untracked difference does NOT refuse', () => {
    const { root } = makeRepo();
    const fifo = join(root, 'masked.pipe');
    const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    assert.equal(made.status, 0, 'NON-VACUOUS: the fixture needs a real FIFO on this host');
    seedFinal(root, computeTreeFingerprint(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, `the same filter the fingerprint applies: ${r.stdout}${r.stderr}`);
  });

  it('a staged-only tree is NOT clean — isTreeClean keeps its staged term', () => {
    const { root } = makeRepo(); // makeRepo stages change.mjs and leaves the worktree matching the index
    const clean = isTreeClean(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(clean, false, 'a staged change is still uncommitted work — dropping the staged term would bypass review-state');
  });

  // The domain is [staged diff ++ unstaged diff ++ untracked]. Against an OTHERWISE-EMPTY index,
  // staging a tracked modification just moves identical patch bytes from the second buffer to the
  // first and the concatenation cannot change — that is the blindness. (With other files already
  // staged the two buffers re-sort their entries, so the fingerprint may move for a reason that has
  // nothing to do with capture; the guard must not rely on either behaviour.)
  it('staging a lone tracked modification leaves the fingerprint UNCHANGED; staging an untracked file MOVES it', () => {
    const { root, g } = makeRepo();
    g('commit', '-qm', 'empty the index'); // the staged change.mjs lands, so the index is EMPTY
    writeFileSync(join(root, 'base.txt'), 'tracked modification\n');
    const beforeTracked = computeTreeFingerprint(root);
    g('add', 'base.txt');
    const afterTracked = computeTreeFingerprint(root);
    g('commit', '-qm', 'empty the index again');
    writeFileSync(join(root, 'fresh.mjs'), 'export const f = 1;\n');
    const beforeUntracked = computeTreeFingerprint(root);
    g('add', 'fresh.mjs');
    const afterUntracked = computeTreeFingerprint(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(afterTracked, beforeTracked, 'THE defect: the domain cannot see a tracked hunk move into the index');
    assert.notEqual(afterUntracked, beforeUntracked, 'an untracked file becoming a staged addition DOES move it');
  });
});

describe('commit-guard — integration: the index-lag arm against a REAL git commit', () => {
  it('a REAL commit with a lagging index is refused by the pre-commit hook; git add -A plus a fresh final receipt lets a plain git commit land', () => {
    const { root, g } = makeRepo();
    installHook(root);
    writeFileSync(join(root, 'base.txt'), 'verified but never staged\n');
    seedFinal(root, computeTreeFingerprint(root));
    const refused = tryCommit(root);
    assert.notEqual(refused.status, 0, 'the hook must refuse a commit that would ship a strict subset');
    assert.match(`${refused.stdout}${refused.stderr}`, /base\.txt/);
    g('add', '-A');
    seedFinal(root, computeTreeFingerprint(root));
    const ok = tryCommit(root);
    const log = g('log', '--oneline');
    rmSync(root, { recursive: true, force: true });
    assert.equal(ok.status, 0, `the whole-tree recovery lands: ${ok.stdout}${ok.stderr}`);
    assert.match(log.stdout, /guarded/);
  });

  it('git commit --only <path> is REFUSED, and STILL refuses after git add -A plus a fresh receipt', () => {
    const { root, g } = makeRepo();
    installHook(root);
    writeFileSync(join(root, 'base.txt'), 'a second change the pathspec commit would leave behind\n');
    g('add', '-A');
    seedFinal(root, computeTreeFingerprint(root));
    const partial = spawnSync('git', ['commit', '-qm', 'partial', '--only', 'change.mjs'], { cwd: root, encoding: 'utf8', env: fixtureEnv() });
    assert.notEqual(partial.status, 0, 'a pathspec commit builds a temporary index carrying LESS than the verified tree');
    assert.match(`${partial.stdout}${partial.stderr}`, /base\.txt/, 'refused by the index-lag arm naming the left-behind path, NOT by a stale fingerprint');
    g('add', '-A');
    seedFinal(root, computeTreeFingerprint(root));
    const retried = spawnSync('git', ['commit', '-qm', 'partial again', '--only', 'change.mjs'], { cwd: root, encoding: 'utf8', env: fixtureEnv() });
    assert.notEqual(retried.status, 0, 'staging everything does not rescue --only — the whole-tree commit is the recovery');
    assert.match(`${retried.stdout}${retried.stderr}`, /base\.txt/);
    const whole = tryCommit(root);
    const log = g('log', '--oneline');
    rmSync(root, { recursive: true, force: true });
    assert.equal(whole.status, 0, `the whole-tree commit lands: ${whole.stdout}${whole.stderr}`);
    assert.match(log.stdout, /guarded/);
  });

  it('git commit -a with only tracked modifications and no untracked paths PASSES', () => {
    const { root, g } = makeRepo();
    g('commit', '-qm', 'stage the base change');
    installHook(root);
    writeFileSync(join(root, 'base.txt'), 'a tracked modification -a will capture\n');
    seedFinal(root, computeTreeFingerprint(root));
    const auto = spawnSync('git', ['commit', '-qam', 'auto staged'], { cwd: root, encoding: 'utf8', env: fixtureEnv() });
    const log = g('log', '--oneline');
    rmSync(root, { recursive: true, force: true });
    assert.equal(auto.status, 0, `-a captures exactly the verified tracked bytes — refusing it would be a false refusal: ${auto.stdout}${auto.stderr}`);
    assert.match(log.stdout, /auto staged/);
  });

  it('git commit -a with a reviewable untracked path present is REFUSED', () => {
    const { root, g } = makeRepo();
    g('commit', '-qm', 'stage the base change');
    installHook(root);
    writeFileSync(join(root, 'base.txt'), 'tracked modification\n');
    writeFileSync(join(root, 'stray.mjs'), 'export const stray = 1;\n');
    seedFinal(root, computeTreeFingerprint(root));
    const auto = spawnSync('git', ['commit', '-qam', 'auto staged'], { cwd: root, encoding: 'utf8', env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.notEqual(auto.status, 0, '-a never picks up an untracked path, so the commit would ship less than was verified');
    assert.match(`${auto.stdout}${auto.stderr}`, /stray\.mjs/);
  });
});

describe('resolveGitHooksPath — the ONE hooks-path answer consumers read', () => {
  it('answers git’s own hooks dir inside a repo and null outside one', () => {
    const { root } = makeRepo();
    assert.equal(guard.resolveGitHooksPath(root), join(root, '.git', 'hooks'));
    rmSync(root, { recursive: true, force: true });
    const plain = mkdtempSync(join(tmpdir(), 'commit-guard-nogit-'));
    assert.equal(guard.resolveGitHooksPath(plain), null);
    rmSync(plain, { recursive: true, force: true });
  });
});
