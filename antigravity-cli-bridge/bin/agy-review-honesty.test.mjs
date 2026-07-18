// agy-review-honesty.test.mjs — the round-1 hardening pins for the D4/D5 arms (strip Phase 4):
// the verdict parse is EXACT (an inexact heading or a token buried mid-line never attests —
// `NOT SHIP` must not read as SHIP), and the empty-AGY_MODEL pre-spend refusal is scoped to the
// ATTESTING branch only (plan / diff / --ungrounded code never attest, so they run and record
// posture.model null). Colocated separately from agy-review.test.mjs — that file is
// red-proof-frozen; this one carries its own minimal standalone harness (the family idiom).

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, readdirSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(HERE, 'agy-review.sh');

const FAKE_AGY = [
  '#!/usr/bin/env bash',
  'set -u',
  'printf invoked > "${AGY_FAKE_SENTINEL:-/dev/null}"',
  'printf "%s\\n" "${AGY_FAKE_OUTPUT:-### Verdict}"',
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
const SHARED_ROOT = mkdtempSync(join(tmpdir(), 'agy-honesty-shared-'));
after(() => rmSync(SHARED_ROOT, { recursive: true, force: true }));
const FARM = makePathWithout(SHARED_ROOT, ['agy', 'agy-run']);

const TEMPLATE_HOME = (() => {
  const home = join(SHARED_ROOT, 'template-home');
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'agy'), FAKE_AGY, { mode: 0o755 });
  const repo = join(home, 'repo');
  mkdirSync(repo);
  const g = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'probe@example.com');
  g('config', 'user.name', 'probe');
  writeFileSync(join(repo, 'base.txt'), 'committed base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  writeFileSync(join(repo, 'pending.txt'), 'PENDING\n');
  writeFileSync(join(repo, 'plan.md'), '# a plan artifact\n');
  return home;
})();

const makeSandbox = () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-honesty-'));
  cpSync(TEMPLATE_HOME, home, { recursive: true });
  const bin = join(home, '.local', 'bin');
  chmodSync(join(bin, 'agy'), 0o755);
  return { home, bin, repo: join(home, 'repo') };
};

const run = (sb, { args, env = {} } = {}) => {
  const sentinel = join(sb.home, 'cap-sentinel');
  const r = spawnSync('bash', [WRAPPER, ...args], {
    cwd: sb.repo,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      HOME: sb.home,
      PATH: `${sb.bin}:${FARM}`,
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      AGY_FAKE_SENTINEL: sentinel,
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

describe('agy-review — the verdict parse is EXACT (M1): a buried token never attests', () => {
  it('`NOT SHIP` on the verdict line is a FAILED run — never a SHIP receipt', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_FAKE_OUTPUT: '### Verdict\nNOT SHIP — blocked.' } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.notEqual(r.status, 0, 'NOT SHIP must never read as SHIP');
    assert.equal(receipts.length, 0);
  });

  it('an INEXACT heading (`### Verdicts`) never parses — the D4 failed-run arm owns it', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_FAKE_OUTPUT: '### Verdicts\nSHIP — but under the wrong heading.' } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.equal(receipts.length, 0);
  });

  it('a WORD-PREFIX (`SHIPPING it`) never matches; punctuation forms (`SHIP.` / `SHIP — …`) do', () => {
    const sb1 = makeSandbox();
    const bad = run(sb1, { args: ['code', '--facts', 'f'], env: { AGY_FAKE_OUTPUT: '### Verdict\nSHIPPING it today.' } });
    const badReceipts = readReceipts(sb1.repo);
    rmSync(sb1.home, { recursive: true, force: true });
    assert.notEqual(bad.status, 0, 'SHIPPING is not in the closed vocabulary');
    assert.equal(badReceipts.length, 0);
    for (const [out, want] of [['### Verdict\nSHIP.', 'SHIP'], ['### Verdict\nSHIP — clean.', 'SHIP'], ['### Verdict\nSHIP WITH NITS — two nits.', 'SHIP WITH NITS']]) {
      const sb = makeSandbox();
      const r = run(sb, { args: ['code', '--facts', 'f'], env: { AGY_FAKE_OUTPUT: out } });
      const receipts = readReceipts(sb.repo);
      rmSync(sb.home, { recursive: true, force: true });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(receipts[0].verdict, want);
    }
  });
});

describe('agy-review — the empty-model refusal is scoped to the ATTESTING branch (M3)', () => {
  it('plan and diff modes with AGY_MODEL= RUN (never attest) and record posture.model null', () => {
    for (const args of [['plan', 'plan.md'], ['diff', 'plan.md']]) {
      const sb = makeSandbox();
      const r = run(sb, { args, env: { AGY_MODEL: '', AGY_FAKE_OUTPUT: '### Verdict\nSHIP — fine.' } });
      const receipts = readReceipts(sb.repo);
      rmSync(sb.home, { recursive: true, force: true });
      assert.equal(r.status, 0, `${args[0]} must run with an emptied model: ${r.stderr}`);
      assert.equal(r.invoked, true);
      assert.deepEqual(receipts[0].posture, { model: null }, 'an unknowable model is recorded null');
    }
  });

  it('code --ungrounded with AGY_MODEL= RUNS (its receipt never attests); grounded code still refuses', () => {
    const sb = makeSandbox();
    const un = run(sb, { args: ['code', '--ungrounded'], env: { AGY_MODEL: '', AGY_FAKE_OUTPUT: '### Verdict\nSHIP — throwaway.' } });
    const unReceipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(un.status, 0, un.stderr);
    assert.deepEqual(unReceipts[0].posture, { model: null });
    const sb2 = makeSandbox();
    const grounded = run(sb2, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_MODEL: '' } });
    rmSync(sb2.home, { recursive: true, force: true });
    assert.notEqual(grounded.status, 0, 'the ATTESTING branch still refuses pre-spend');
    assert.equal(grounded.invoked, false);
  });
});
