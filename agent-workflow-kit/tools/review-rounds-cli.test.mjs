import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main, normalizeArtifactPath } from './review-rounds-cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'review-rounds-cli.mjs');
const WRAPPER = resolve(HERE, '..', '..', 'codex-cli-bridge', 'bin', 'codex-review.sh');

const extractFunction = (source, name) => {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${name}()`));
  const end = lines.findIndex((line, index) => index > start && line === '}');
  assert.ok(start >= 0 && end > start, `${name} exists in the real wrapper`);
  return lines.slice(start, end + 1).join('\n');
};

const makeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'review-rounds-cli-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'example.md'), '# example\n');
  writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-authoring': { review: ['codex-review'] } }));
  const git = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  return root;
};

const mintWithWrapperHelper = (root, receiptsPath) => {
  const source = readFileSync(WRAPPER, 'utf8');
  const functions = ['refuse_uncarriable_artifact_byte', 'normalize_artifact_path', 'receipt_json_scalar', 'write_review_receipt']
    .map((name) => extractFunction(source, name)).join('\n');
  const script = `set -euo pipefail
${functions}
write_finding_manifest() { return 0; }
posture_json() { printf '{"model":"m"}'; }
AW_RECEIPT_BACKEND=codex
AW_BRIDGE_VERSION=0.0.0
AW_REVIEW_RECEIPTS="$1"
artifact_path="$(normalize_artifact_path "$2")"
write_review_receipt plan true ${'a'.repeat(64)} ship true '' false '' '' "$artifact_path" 7 0
`;
  const run = spawnSync('bash', ['-c', script, 'mint', receiptsPath, join(root, 'docs', 'plans', '..', 'plans', 'example.md')], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
};

describe('the CLI spawns its own read-only git query once', () => {
  it('main runs git rev-parse --show-toplevel exactly once; normalizeArtifactPath given top spawns nothing', () => {
    const root = makeRepo();
    const calls = [];
    const run = (cmd, args, opts) => { calls.push([cmd, ...args].join(' ')); return spawnSync(cmd, args, opts); };
    const receipts = join(root, 'receipts.jsonl');
    writeFileSync(receipts, '');
    const r = main(['--artifact', 'docs/plans/example.md'], { cwd: root, env: { AW_REVIEW_RECEIPTS: receipts }, readinessDeps: { detect: () => [] }, run });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(calls, ['git rev-parse --show-toplevel'], 'the whole run spawns one git query — the receipts path came from the env');
    const never = () => { throw new Error('a git query was spawned'); };
    assert.equal(normalizeArtifactPath('docs/plans/example.md', { cwd: root, top: root, run: never }), 'docs/plans/example.md');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('review-rounds CLI', () => {
  describe('feedback record rounds [spec:feedback-triage/S14]', () => {
    it('groups feedback record plan receipts into one round', () => {
      const root = makeRepo();
      const artifactPath = 'docs/plans/FEEDBACK-2026-09-03-fixture.md';
      const receipts = join(root, 'receipts.jsonl');
      writeFileSync(join(root, artifactPath), '# Feedback: Fixture\n');
      writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'feedback-triage': { review: 'council' } }));
      const receipt = (backend) => ({
        artifact: 'plan', artifactPath, backend, fingerprint: 'f'.repeat(64),
        probe: false, verdict: 'ship', durationS: 1, blocking: 0,
      });
      writeFileSync(receipts, `${JSON.stringify(receipt('codex'))}\n${JSON.stringify(receipt('agy'))}\n`);
      const result = main(['--artifact', artifactPath, '--activity', 'feedback-triage'], {
        cwd: root, env: { AW_REVIEW_RECEIPTS: receipts },
      });
      rmSync(root, { recursive: true, force: true });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.match(/^round /gmu)?.length, 1);
      assert.match(result.stdout, /round 1 \u00b7 codex: ship .* \u00b7 agy: ship /u);
      assert.match(result.stdout, /signal: converged/);
    });
  });

  it('selects a real wrapper-helper receipt under the same normalized artifact path', () => {
    // spec:plan-review-loop/S27
    const root = makeRepo();
    const receipts = join(root, '.git', 'agent-workflow-review-receipts.jsonl');
    mintWithWrapperHelper(root, receipts);
    const artifactArg = join('docs', 'plans', '.', 'example.md');
    const run = spawnSync(process.execPath, [CLI, '--artifact', artifactArg], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, AW_REVIEW_RECEIPTS: receipts },
    });
    const receipt = JSON.parse(readFileSync(receipts, 'utf8'));
    const normalized = normalizeArtifactPath(join(root, artifactArg), { cwd: root });
    rmSync(root, { recursive: true, force: true });

    assert.equal(run.status, 0, run.stderr);
    assert.equal(receipt.artifactPath, normalized, 'shell and JS normalization agree');
    assert.match(run.stdout, /round 1 · codex: ship \(0 blocking, 7s\)/);
    assert.match(run.stdout, /signal: converged/);
  });

  it('returns exit 2 for usage, malformed config, or an unreadable store', () => {
    const root = makeRepo();
    const usage = spawnSync(process.execPath, [CLI, '--artifact'], { cwd: root, encoding: 'utf8' });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /--artifact needs/);

    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), '{ nope');
    const malformed = spawnSync(process.execPath, [CLI, '--artifact', 'docs/plans/example.md'], { cwd: root, encoding: 'utf8' });
    assert.equal(malformed.status, 2);
    assert.match(malformed.stderr, /malformed|JSON/i);

    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-authoring': { review: 'solo' } }));
    const unreadable = spawnSync(process.execPath, [CLI, '--artifact', 'docs/plans/example.md'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, AW_REVIEW_RECEIPTS: root },
    });
    rmSync(root, { recursive: true, force: true });
    assert.equal(unreadable.status, 2);
    assert.match(unreadable.stderr, /receipts store|regular file/i);
  });

  it('a silent slot takes its obligation from readiness; a detector failure is a refusal; --activity selects the slot', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'council' } }));
    const argv = ['--artifact', 'docs/plans/example.md'];
    const silent = main(argv, { cwd: root, readinessDeps: { detect: () => [] } });
    const failed = main(argv, { cwd: root, readinessDeps: { detect: () => { throw new Error('probe broke'); } } });
    const execution = main([...argv, '--activity', 'plan-execution'], { cwd: root });
    const wrongActivity = main([...argv, '--activity', 'routine'], { cwd: root });
    const unknownArgument = main([...argv, '--nope'], { cwd: root });
    rmSync(root, { recursive: true, force: true });

    assert.equal(silent.code, 0, silent.stderr);
    assert.match(silent.stdout, /signal: no receipts for docs\/plans\/example\.md$/);
    assert.equal(failed.code, 2);
    assert.match(failed.stderr, /detection failed/);
    assert.equal(execution.code, 0, execution.stderr);
    assert.match(execution.stdout, /signal: no receipts for/);
    assert.equal(wrongActivity.code, 2);
    assert.match(wrongActivity.stderr, /--activity must be/);
    assert.equal(unknownArgument.code, 2);
    assert.match(unknownArgument.stderr, /unknown argument: --nope/);
  });

  it('outside a git work tree the store cannot be resolved without AW_REVIEW_RECEIPTS', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-rounds-nogit-'));
    writeFileSync(join(root, 'p.md'), '# p\n');
    const r = main(['--artifact', 'p.md'], { cwd: root, env: {}, readinessDeps: { detect: () => [] } });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /cannot be resolved/);
  });
});
