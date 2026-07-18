// codex-review-honesty.test.mjs — the round-1 hardening pins for the D4/D5 arms (strip Phase 4):
// the schema-mode verdict is parsed STRUCTURALLY (a legal multiline JSON parses; a decoy
// "verdict" inside a findings string never substitutes the top-level field; out-of-enum and
// malformed JSON die on the D4 arm), and the control-byte pre-spend screen covers the RAW
// CODEX_SERVICE_TIER BEFORE tier validation (no multiline warning echo, no silent standard-tier
// run). Colocated separately — codex-review.test.mjs is red-proof-frozen; standalone harness.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, readdirSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(HERE, 'codex-review.sh');

const FAKE_CODEX = [
  '#!/usr/bin/env bash',
  'set -u',
  'if [[ "${1:-}" == "login" ]]; then echo "Logged in using ChatGPT"; exit 0; fi',
  'printf invoked > "${CODEX_FAKE_SENTINEL:-/dev/null}"',
  'cat >/dev/null',
  'out=""; prev=""',
  'for a in "$@"; do if [[ "$prev" == "-o" || "$prev" == "--output-last-message" ]]; then out="$a"; fi; prev="$a"; done',
  'if [[ -n "$out" ]]; then if [[ -z "${CODEX_FAKE_FINAL+x}" ]]; then printf "Verdict: ship\\n" >"$out"; else printf "%s\\n" "$CODEX_FAKE_FINAL" >"$out"; fi; fi',
  'echo \'{"type":"thread.started","thread_id":"honesty-fake"}\'',
  'exit 0',
  '',
].join('\n');

const makePathWithout = (root, exclude = []) => {
  const skip = new Set(exclude);
  const dir = mkdtempSync(join(root, 'nobin-'));
  for (const d of (process.env.PATH || '').split(':').filter(Boolean)) {
    let names;
    try { names = readdirSync(d); } catch { continue; }
    for (const name of names) {
      if (skip.has(name)) continue;
      const link = join(dir, name);
      if (existsSync(link)) continue;
      try { symlinkSync(resolve(d, name), link); } catch { /* dup / race — ignore */ }
    }
  }
  return dir;
};

// Farm + sandbox base are READ-ONLY per invocation — built ONCE, shared (a per-run farm rebuild
// plus a per-test `git init`+commit dominate the wall otherwise).
const SHARED_ROOT = mkdtempSync(join(tmpdir(), 'codex-honesty-shared-'));
after(() => rmSync(SHARED_ROOT, { recursive: true, force: true }));
const FARM = makePathWithout(SHARED_ROOT, ['codex']);

const TEMPLATE_ROOT = (() => {
  const root = join(SHARED_ROOT, 'template-root');
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'codex'), FAKE_CODEX, { mode: 0o755 });
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const g = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'probe@example.com');
  g('config', 'user.name', 'probe');
  writeFileSync(join(repo, 'AGENTS.md'), '# Hard Constraints\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  writeFileSync(join(repo, 'pending.txt'), 'PENDING\n');
  return root;
})();

const makeSandbox = () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-honesty-'));
  cpSync(TEMPLATE_ROOT, root, { recursive: true });
  const bin = join(root, 'bin');
  chmodSync(join(bin, 'codex'), 0o755);
  return { root, bin, repo: join(root, 'repo') };
};

const run = (sb, { args = ['code'], env = {} } = {}) => {
  const sentinel = join(sb.root, 'cap-sentinel');
  const r = spawnSync('bash', [WRAPPER, ...args], {
    cwd: sb.repo,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      HOME: sb.repo,
      PATH: `${sb.bin}:${FARM}`,
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      CODEX_HOME: join(sb.root, 'codex-home'),
      CODEX_FAKE_SENTINEL: sentinel,
      ...env,
    },
  });
  return { ...r, invoked: existsSync(sentinel) };
};

const readReceipts = (repo) => {
  const p = join(repo, '.git', 'agent-workflow-review-receipts.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

describe('codex-review — schema-mode verdict is parsed STRUCTURALLY (M2)', () => {
  it('a LEGAL multiline JSON final message (key/value split across lines) parses and attests', () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { CODEX_REVIEW_SCHEMA: '1', CODEX_FAKE_FINAL: '{\n  "verdict":\n  "ship",\n  "findings": []\n}' } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(receipts[0].verdict, 'ship', 'a formatting choice never fails a legal schema payload');
  });

  it('a DECOY "verdict" inside a findings STRING never substitutes the top-level field', () => {
    const sb = makeSandbox();
    const decoy = '{"verdict":"revise","findings":["the text \\"verdict\\": \\"ship\\" appeared in a doc line"]}';
    const r = run(sb, { env: { CODEX_REVIEW_SCHEMA: '1', CODEX_FAKE_FINAL: decoy } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(receipts[0].verdict, 'revise', 'the TOP-LEVEL field is authoritative — a quoted decoy never wins');
  });

  it('an OUT-OF-ENUM top-level verdict dies on the D4 arm (no receipt)', () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { CODEX_REVIEW_SCHEMA: '1', CODEX_FAKE_FINAL: '{"verdict":"maybe","findings":[]}' } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.equal(receipts.length, 0);
  });

  it('MALFORMED JSON in schema mode dies on the D4 arm (no receipt)', () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { CODEX_REVIEW_SCHEMA: '1', CODEX_FAKE_FINAL: '{not json' } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.equal(receipts.length, 0);
  });
});

describe('codex-review — the RAW tier is control-byte-screened BEFORE validation (M4)', () => {
  it('a CODEX_SERVICE_TIER carrying a control byte refuses pre-spend — codex never runs, no warning echo', () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { CODEX_SERVICE_TIER: `priority${String.fromCharCode(1)}` } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.equal(r.invoked, false, 'refused BEFORE any spend');
    assert.equal(receipts.length, 0);
    assert.match(r.stderr, /control/i, 'named as the control-byte class');
    assert.doesNotMatch(r.stderr, /not a supported service tier/, 'the validity warning never echoes a hostile value');
  });
});
