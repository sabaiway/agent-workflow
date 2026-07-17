// agy-review-model-screen.test.mjs — the round-2 ordering pin (strip Phase 4, M6): the
// control-byte screen fires IMMEDIATELY after AGY_MODEL resolution — BEFORE the off-frontier
// advisory (or any other interpolation) can echo raw control bytes into stderr/the terminal.
// Colocated separately: both earlier agy spec files are red-proof-frozen. Standalone harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(HERE, 'agy-review.sh');

const FAKE_AGY = '#!/usr/bin/env bash\nset -u\nprintf invoked > "${AGY_FAKE_SENTINEL:-/dev/null}"\nprintf "### Verdict\\nSHIP\\n"\nexit 0\n';

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

describe('agy-review — the control-byte screen precedes EVERY interpolation of AGY_MODEL (M6)', () => {
  it('a control-byte NON-frontier model refuses pre-spend with NO advisory echo and NO raw byte on stderr', () => {
    const home = mkdtempSync(join(tmpdir(), 'agy-model-screen-'));
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'agy'), FAKE_AGY, { mode: 0o755 });
    chmodSync(join(bin, 'agy'), 0o755);
    const repo = join(home, 'repo');
    mkdirSync(repo);
    const g = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 'probe@example.com');
    g('config', 'user.name', 'probe');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    writeFileSync(join(repo, 'pending.txt'), 'PENDING\n');
    const sentinel = join(home, 'cap-sentinel');
    const r = spawnSync('bash', [WRAPPER, 'code', '--facts', 'a tiny fact'], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        HOME: home,
        PATH: `${bin}:${makePathWithout(home, ['agy', 'agy-run'])}`,
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        AGY_FAKE_SENTINEL: sentinel,
        AGY_MODEL: `hostile${String.fromCharCode(27)}model`, // ESC — a terminal-control byte
      },
    });
    const invoked = existsSync(sentinel);
    const receiptsPath = join(repo, '.git', 'agent-workflow-review-receipts.jsonl');
    const receipts = existsSync(receiptsPath) ? readFileSync(receiptsPath, 'utf8').trim() : '';
    rmSync(home, { recursive: true, force: true });
    assert.notEqual(r.status, 0, 'a control-byte model refuses pre-spend');
    assert.equal(invoked, false, 'agy is never invoked');
    assert.equal(receipts, '', 'no receipt is minted');
    assert.match(r.stderr, /control/i, 'named as the control-byte class');
    assert.doesNotMatch(r.stderr, /non-frontier model/, 'the advisory never fires on a value the screen must refuse');
    assert.ok(!r.stderr.includes(String.fromCharCode(27)), 'no raw control byte ever reaches stderr');
  });
});
