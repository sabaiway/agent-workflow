import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync,
  existsSync, readdirSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(HERE, 'codex-review.sh');

// Same hermetic fake `codex` as codex-exec.test.mjs (kept inline so each bridge
// test file is standalone — no shared helper grows the byte-identical mirror set).
const FAKE_CODEX = [
  '#!/usr/bin/env bash',
  'set -u',
  'if [[ "${1:-}" == "login" ]]; then echo "${CODEX_FAKE_LOGIN:-Logged in using ChatGPT}"; exit 0; fi',
  ': "${CODEX_FAKE_ARGV:=/dev/null}"',
  ': "${CODEX_FAKE_ENV:=/dev/null}"',
  ': "${CODEX_FAKE_STDIN:=/dev/null}"',
  '{ for a in "$@"; do echo "$a"; done; } >"$CODEX_FAKE_ARGV"',
  '{ echo "HOME=${HOME:-}"; echo "CODEX_HOME=${CODEX_HOME:-}"; echo "XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-}"; echo "OPENAI_API_KEY=${OPENAI_API_KEY:-<unset>}"; echo "OPENAI_BASE_URL=${OPENAI_BASE_URL:-<unset>}"; echo "FOO_API_KEY=${FOO_API_KEY:-<unset>}"; } >"$CODEX_FAKE_ENV"',
  'cat >"$CODEX_FAKE_STDIN"',
  // If the prompt points at a precomputed-diff temp file, record its perms + a copy
  // WHILE it still exists (the wrapper trap removes it on exit) for the oversized test.
  'df="$(grep -oE "/[^ ]*codex-review-diff\\.[0-9]+" "$CODEX_FAKE_STDIN" 2>/dev/null | head -1 || true)"',
  'if [[ -n "$df" && -f "$df" ]]; then stat -c "%a" "$df" > "${CODEX_FAKE_DIFF_PERMS:-/dev/null}" 2>/dev/null || true; cp "$df" "${CODEX_FAKE_DIFF_COPY:-/dev/null}" 2>/dev/null || true; fi',
  'if [[ "${CODEX_FAKE_FAIL_ON_SCHEMA:-}" == "1" ]]; then for a in "$@"; do [[ "$a" == "--output-schema" ]] && exit 1; done; fi',
  'if [[ -n "${CODEX_FAKE_SLEEP:-}" ]]; then sleep "${CODEX_FAKE_SLEEP}"; fi',
  'out=""',
  'prev=""',
  'for a in "$@"; do',
  '  if [[ "$prev" == "-o" || "$prev" == "--output-last-message" ]]; then out="$a"; fi',
  '  prev="$a"',
  'done',
  'if [[ -n "$out" && "${CODEX_FAKE_NO_OUT:-}" != "1" ]]; then echo "${CODEX_FAKE_FINAL:-FAKE_FINAL_MESSAGE}" >"$out"; fi',
  'if [[ "${CODEX_FAKE_NO_THREAD:-}" != "1" ]]; then',
  'cat <<EOF',
  '{"type":"thread.started","thread_id":"${CODEX_FAKE_THREAD_ID:-fake-thread-123}"}',
  'EOF',
  'fi',
  'cat <<EOF',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"FAKE_FINAL_MESSAGE"}}',
  '{"type":"turn.completed","usage":{}}',
  'EOF',
  'exit "${CODEX_FAKE_EXIT:-0}"',
  '',
].join('\n');

// `clean: true` leaves a committed, pristine tree (for the no-diff preflight);
// the default leaves one uncommitted untracked file so `code` mode has a diff to
// review (otherwise the new no-diff preflight short-circuits before codex runs).
const makeSandbox = ({ clean = false } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'codex-review-test-'));
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, 'codex');
  writeFileSync(stub, FAKE_CODEX, { mode: 0o755 });
  chmodSync(stub, 0o755);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const g = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'probe@example.com');
  g('config', 'user.name', 'probe');
  writeFileSync(join(repo, 'AGENTS.md'), '# AGENTS\n\nHard Constraints: none (test fixture).\n');
  writeFileSync(join(repo, 'plan.md'), '# Plan\n\nDo a thing in two steps.\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  if (!clean) writeFileSync(join(repo, 'pending.txt'), 'an uncommitted change to review\n');
  return { root, bin, repo };
};

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
      // resolve() so a relative PATH entry still yields an ABSOLUTE symlink target
      // (a relative target would be broken — it resolves against the temp dir, not cwd).
      try { symlinkSync(resolve(d, name), link); } catch { /* dup / race — ignore */ }
    }
  }
  return dir;
};

const run = ({ repo, bin }, { args = ['code'], env = {}, path, cwd } = {}) => {
  const argvFile = join(repo, '.cap-argv');
  const envFile = join(repo, '.cap-env');
  const stdinFile = join(repo, '.cap-stdin');
  const codexHome = join(repo, '..', 'codex-home');
  const r = spawnSync('bash', [WRAPPER, ...args], {
    cwd: cwd || repo,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      PATH: path || `${bin}:${process.env.PATH}`,
      HOME: repo,
      CODEX_HOME: codexHome,
      CODEX_FAKE_ARGV: argvFile,
      CODEX_FAKE_ENV: envFile,
      CODEX_FAKE_STDIN: stdinFile,
      ...env,
    },
  });
  const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  return { ...r, codexHome, argv: readIf(argvFile), capEnv: readIf(envFile), capStdin: readIf(stdinFile) };
};

describe('codex-review.sh — quality-first model/effort guard (1.1)', () => {
  it('refuses a non-default CODEX_MODEL', () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { CODEX_MODEL: 'gpt-5.4-mini' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not the pinned frontier model/);
    assert.equal(r.capStdin, '', 'codex must not be invoked when the guard fires');
  });

  it('refuses a non-default CODEX_EFFORT', () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { CODEX_EFFORT: 'high' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not the pinned max effort/);
  });

  it('CODEX_PROBE=1 relaxes the guard and warns', () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { CODEX_PROBE: '1', CODEX_EFFORT: 'low' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /THROWAWAY PROBE MODE/);
  });
});

describe('codex-review.sh — clean output + session capture (1.2)', () => {
  it('prints ONLY the final findings, not the JSON event stream', () => {
    const sb = makeSandbox();
    const r = run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /FAKE_FINAL_MESSAGE/);
    assert.doesNotMatch(r.stdout, /thread\.started/);
  });

  it('passes the clean-capture flags and read-only sandbox to codex', () => {
    const sb = makeSandbox();
    const r = run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    for (const f of [/(^|\n)-o(\n|$)/, /(^|\n)--json(\n|$)/, /hide_agent_reasoning=true/,
      /(^|\n)read-only(\n|$)/]) {
      assert.match(r.argv, f, `expected ${f} among codex argv`);
    }
  });

  it('surfaces the session id on STDERR only — never the shared resume sidecar', () => {
    const sb = makeSandbox();
    const r = run(sb);
    const sidecar = join(sb.repo, '.codex-last-session');
    const wrote = existsSync(sidecar);
    rmSync(sb.root, { recursive: true, force: true });
    assert.match(r.stderr, /session: fake-thread-123/);
    assert.equal(wrote, false, 'a review must NOT clobber codex-exec --resume-last target');
  });

  it('on a codex failure, prints the trace tail and exits codex code', () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { CODEX_FAKE_EXIT: '5' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 5);
    assert.match(r.stderr, /codex review failed \(exit 5\)/);
  });
});

describe('codex-review.sh — leaner prompt + read-fence line (1.4 / 1.5)', () => {
  it('code mode: obeys AGENTS.md from context, states the read fence, no read-AGENTS action', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.match(r.capStdin, /already merged into your context/);
    assert.doesNotMatch(r.capStdin, /Also read the project's root AGENTS\.md/);
    assert.match(r.capStdin, /Do not read files outside this git working tree/);
  });

  it('code mode: appends extra focus', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', 'the new reducer'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.match(r.capStdin, /Extra focus: the new reducer/);
  });

  it('plan mode: includes the plan body and a PLAN-specific read fence', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['plan', 'plan.md'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.match(r.capStdin, /Do a thing in two steps/);
    assert.match(r.capStdin, /the plan above plus the in-repo code/);
    assert.doesNotMatch(r.capStdin, /assembled change set/i, 'plan mode must not borrow the code fence');
  });
});

describe('codex-review.sh — best-effort env read-fence (1.5)', () => {
  it('repoints HOME/XDG to a throwaway dir while keeping an absolute CODEX_HOME', () => {
    const sb = makeSandbox();
    const r = run(sb);
    const home = (r.capEnv.match(/^HOME=(.*)$/m) || [])[1];
    const codexHome = (r.capEnv.match(/^CODEX_HOME=(.*)$/m) || [])[1];
    const xdg = (r.capEnv.match(/^XDG_CONFIG_HOME=(.*)$/m) || [])[1];
    rmSync(sb.root, { recursive: true, force: true });
    assert.ok(home && home !== sb.repo, `HOME must be repointed away from the caller's, got ${home}`);
    assert.equal(codexHome, r.codexHome, 'CODEX_HOME must stay the absolute real auth root');
    assert.ok(xdg && xdg.startsWith(home), 'XDG_CONFIG_HOME must live under the fenced HOME');
  });

  it('resolves a literal ~/ in CODEX_HOME against HOME, not $PWD', () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { CODEX_HOME: '~/.codex' } });
    const codexHome = (r.capEnv.match(/^CODEX_HOME=(.*)$/m) || [])[1];
    rmSync(sb.root, { recursive: true, force: true });
    // HOME handed to the wrapper is sb.repo → ~/.codex must expand to <repo>/.codex,
    // never the broken $PWD/~/.codex.
    assert.equal(codexHome, join(sb.repo, '.codex'));
  });
});

describe('codex-review.sh — subscription / config isolation (invariant)', () => {
  it('clears every *_API_KEY + OPENAI_BASE_URL and passes --ignore-user-config', () => {
    const sb = makeSandbox();
    const r = run(sb, { env: {
      OPENAI_API_KEY: 'sk-x', OPENAI_BASE_URL: 'http://evil.example', FOO_API_KEY: 'bar',
    } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.capEnv, /^OPENAI_API_KEY=<unset>$/m);
    assert.match(r.capEnv, /^OPENAI_BASE_URL=<unset>$/m);
    assert.match(r.capEnv, /^FOO_API_KEY=<unset>$/m);
    assert.match(r.argv, /(^|\n)--ignore-user-config(\n|$)/);
  });
});

describe('codex-review.sh — hard timeout (1.3)', () => {
  it('kills a hung review at CODEX_HARD_TIMEOUT and reports it', () => {
    const sb = makeSandbox();
    const started = Date.now();
    const r = run(sb, { env: { CODEX_FAKE_SLEEP: '30', CODEX_HARD_TIMEOUT: '2' } });
    const elapsed = Date.now() - started;
    rmSync(sb.root, { recursive: true, force: true });
    assert.ok(elapsed < 18000, `must return well under the kill-after window, took ${elapsed}ms`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /exceeded the hard cap/);
  });

  it('warns and runs uncapped when neither timeout nor gtimeout is on PATH', () => {
    const sb = makeSandbox();
    const path = `${sb.bin}:${makePathWithout(sb.root, ['timeout', 'gtimeout'])}`;
    const r = run(sb, { path });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /WITHOUT a hard wall-clock cap/);
    assert.match(r.stdout, /FAKE_FINAL_MESSAGE/);
  });
});

describe('codex-review.sh — precomputed diff for code mode (2.1)', () => {
  it('no-diff preflight: a clean tree exits 0 without spending a codex run', () => {
    const sb = makeSandbox({ clean: true });
    const r = run(sb, { args: ['code'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /no uncommitted changes to review/);
    assert.equal(r.capStdin, '', 'codex must NOT be invoked on a clean tree');
  });

  it('assembles repo map, status, staged + unstaged diffs; drops the run-git-yourself directive', () => {
    const sb = makeSandbox();
    const g = (...a) => spawnSync('git', a, { cwd: sb.repo, encoding: 'utf8' });
    writeFileSync(join(sb.repo, 'AGENTS.md'), '# AGENTS\n\nHard Constraints: none.\nan unstaged edit\n');
    writeFileSync(join(sb.repo, 'staged.mjs'), 'export const s = 1\n');
    g('add', 'staged.mjs');
    const r = run(sb, { args: ['code'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    for (const sec of [/repo file map/, /git status/, /staged diff/, /unstaged diff/, /staged\.mjs/]) {
      assert.match(r.capStdin, sec);
    }
    assert.doesNotMatch(r.capStdin, /Run `git status --short`/, 'the old self-discovery directive must be gone');
  });

  it('inlines untracked file CONTENTS, not just the path', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'untra.txt'), 'UNIQUE_UNTRACKED_BODY\n');
    const r = run(sb, { args: ['code'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.match(r.capStdin, /untracked: untra\.txt/);
    assert.match(r.capStdin, /UNIQUE_UNTRACKED_BODY/);
  });

  it('skips binary untracked files (noted; raw bytes not inlined)', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x42]));
    const r = run(sb, { args: ['code'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.match(r.capStdin, /binary, skipped\): blob\.bin/);
  });

  it('handles untracked paths with spaces (NUL-safe)', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'a b c.txt'), 'SPACED_BODY\n');
    const r = run(sb, { args: ['code'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.match(r.capStdin, /untracked: a b c\.txt/);
    assert.match(r.capStdin, /SPACED_BODY/);
  });

  it('does not follow untracked symlinks (no out-of-tree content leak)', () => {
    const sb = makeSandbox();
    const secret = join(sb.root, 'outside-secret.txt');   // OUTSIDE the repo
    writeFileSync(secret, 'TOP_SECRET_LEAK_MARKER\n');
    symlinkSync(secret, join(sb.repo, 'link-to-outside')); // untracked symlink → outside
    const r = run(sb, { args: ['code'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.match(r.capStdin, /untracked \(symlink\): link-to-outside -> /);
    assert.doesNotMatch(r.capStdin, /TOP_SECRET_LEAK_MARKER/, 'symlink target content must never leak');
  });

  it('oversized → git-dir temp file: 600 perms, untruncated, carve-out fence, cleaned up', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'unique.txt'), 'OVERSIZE_UNIQUE_MARKER\n');
    writeFileSync(join(sb.repo, 'big.txt'), 'x'.repeat(5000));
    const perms = join(sb.root, 'cap-perms');
    const copy = join(sb.root, 'cap-diffcopy');
    const r = run(sb, { args: ['code'], env: {
      CODEX_REVIEW_MAX_TOTAL_BYTES: '100', CODEX_FAKE_DIFF_PERMS: perms, CODEX_FAKE_DIFF_COPY: copy,
    } });
    const leftover = readdirSync(join(sb.repo, '.git')).filter((f) => f.startsWith('codex-review-diff.'));
    const gotPerms = existsSync(perms) ? readFileSync(perms, 'utf8').trim() : '';
    const gotCopy = existsSync(copy) ? readFileSync(copy, 'utf8') : '';
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.capStdin, /codex-review-diff\./);
    assert.match(r.capStdin, /with ONE exception/);
    assert.match(r.capStdin, /read it IN FULL/);
    assert.doesNotMatch(r.capStdin, /ASSEMBLED CHANGE SET:/, 'must not also inline the payload');
    assert.equal(gotPerms, '600', 'the diff temp file must be mode 600');
    assert.match(gotCopy, /OVERSIZE_UNIQUE_MARKER/, 'the temp file must hold the full untracked content');
    assert.ok(gotCopy.length > 4000, 'the temp file must be the full untruncated payload');
    assert.deepEqual(leftover, [], 'the diff temp file must be cleaned up on exit');
  });
});

describe('codex-review.sh — optional structured findings (2.2)', () => {
  it('CODEX_REVIEW_SCHEMA=1 passes --output-schema to codex', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code'], env: { CODEX_REVIEW_SCHEMA: '1' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.argv, /(^|\n)--output-schema(\n|$)/);
  });

  it('is OFF by default — no --output-schema', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.doesNotMatch(r.argv, /--output-schema/);
  });

  it('falls back to a raw-text run when the schema run fails (loud; exit 0)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code'], env: { CODEX_REVIEW_SCHEMA: '1', CODEX_FAKE_FAIL_ON_SCHEMA: '1' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /without the schema constraint/);
    assert.doesNotMatch(r.argv, /--output-schema/, 'the fallback run must drop the schema');
    assert.match(r.stdout, /FAKE_FINAL_MESSAGE/);
  });

  it('schema ON makes the directive ask for schema JSON, not one-per-line text', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code'], env: { CODEX_REVIEW_SCHEMA: '1' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.match(r.capStdin, /JSON object matching the provided output schema/);
    assert.doesNotMatch(r.capStdin, /one per line/);
  });

  it('schema OFF (default) asks for one-finding-per-line text', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.match(r.capStdin, /one per line/);
  });
});

describe('codex-review.sh — environment preflight (fail fast, before a run)', () => {
  it('STOPs with 127 when codex is not on PATH', () => {
    const sb = makeSandbox();
    const path = makePathWithout(sb.root, ['codex']); // no fake codex, no real codex
    const r = run(sb, { args: ['code'], path });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 127);
    assert.match(r.stderr, /'codex'.*not found on PATH/);
    assert.equal(r.capStdin, '', 'codex must never be invoked');
  });

  it('STOPs (exit 1) when codex is not on a ChatGPT subscription', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code'], env: { CODEX_FAKE_LOGIN: 'Logged in using API key' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not on a ChatGPT subscription/);
    assert.equal(r.capStdin, '', 'a wrong login must never spend a run');
  });

  it('STOPs (exit 2) when not inside a git work tree', () => {
    const sb = makeSandbox();
    const nongit = join(sb.root, 'nongit');
    mkdirSync(nongit, { recursive: true });
    writeFileSync(join(nongit, 'AGENTS.md'), '# AGENTS\n');
    const r = run(sb, { args: ['code'], cwd: nongit });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /must run inside a git working tree/);
  });

  it('STOPs (exit 2) when there is no root AGENTS.md', () => {
    const sb = makeSandbox();
    rmSync(join(sb.repo, 'AGENTS.md'));
    const r = run(sb, { args: ['code'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no root AGENTS\.md/);
  });
});

describe('codex-review.sh — CODEX_HOME resolution arms (1.5)', () => {
  it('resolves a bare ~ in CODEX_HOME to HOME', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code'], env: { CODEX_HOME: '~' } });
    const codexHome = (r.capEnv.match(/^CODEX_HOME=(.*)$/m) || [])[1];
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(codexHome, sb.repo, 'bare ~ → the HOME handed to the wrapper');
  });

  it('anchors a relative CODEX_HOME to $PWD', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code'], env: { CODEX_HOME: 'rel/.codex' } });
    const codexHome = (r.capEnv.match(/^CODEX_HOME=(.*)$/m) || [])[1];
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(codexHome, join(sb.repo, 'rel/.codex'), 'a relative path anchors to cwd, never left bare');
  });
});

describe('codex-review.sh — mode dispatch & plan validation', () => {
  it('unknown mode prints usage and STOPs (exit 2)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['bogus'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: .* plan <plan-file> \| code/);
  });

  it('no mode prints usage and STOPs (exit 2)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: [] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage:/);
  });

  it('plan mode: STOPs (exit 2) when the plan file is missing', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['plan', 'nope.md'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /plan file 'nope\.md' not found/);
  });

  it('plan mode: STOPs (exit 2) on unexpected trailing arguments', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['plan', 'plan.md', 'extra', 'junk'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unexpected arguments after plan file: extra junk/);
  });
});

describe('codex-review.sh — assemble & output edge cases', () => {
  it('skips a non-regular untracked path (an embedded git repo dir) without reading it', () => {
    // git enumerates an untracked path as non-regular only as a DIRECTORY: a FIFO /
    // socket / device is not listed by `git ls-files --others` at all, but an embedded
    // git repo surfaces as `nested/` — a directory, so `[[ ! -f ]]` skips it (and a
    // `cat` is never attempted, which is what the branch guards against for FIFOs).
    const sb = makeSandbox();
    const nested = join(sb.repo, 'nested');
    mkdirSync(nested, { recursive: true });
    const g = (...a) => spawnSync('git', a, { cwd: nested, encoding: 'utf8' });
    g('init', '-q');
    writeFileSync(join(nested, 'inner.txt'), 'INNER_SHOULD_NOT_BE_INLINED\n');
    const r = run(sb, { args: ['code'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.capStdin, /non-regular, skipped\): nested\//);
    assert.doesNotMatch(r.capStdin, /INNER_SHOULD_NOT_BE_INLINED/, 'a non-regular path must not be inlined');
  });

  it('appends extra focus on the oversized (temp-file) path too', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'big.txt'), 'x'.repeat(5000));
    const r = run(sb, { args: ['code', 'watch the parser'], env: { CODEX_REVIEW_MAX_TOTAL_BYTES: '100' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.capStdin, /with ONE exception/, 'this is the oversized temp-file path');
    assert.match(r.capStdin, /Extra focus: watch the parser/);
  });

  it('warns and prints the trace tail when codex writes no final-message file', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code'], env: { CODEX_FAKE_NO_OUT: '1' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /no final-message file/);
    assert.match(r.stdout, /turn\.completed/, 'the trace tail carries the event stream');
  });

  it('prints no session line when codex emits no thread id', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code'], env: { CODEX_FAKE_NO_THREAD: '1' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /session:/);
    assert.match(r.stdout, /FAKE_FINAL_MESSAGE/);
  });
});

// ── driving contract: --help ⟷ manifest ⟷ real arg-parsing (drift-guarded) ─────
// The manifest roles.review.contract is the single machine-readable source of the
// driving contract; these suites pin (a) --help renders it verbatim (set-EQUALITY,
// both directions), (b) the wrapper's REAL parser arms equal the declared sets
// (source-level reverse guard), (c) each declared mode is really accepted.
// Helpers are inline — each bridge test file stays standalone (mirror byte-equality).

const MANIFEST = JSON.parse(readFileSync(join(HERE, '..', 'capability.json'), 'utf8'));
const REVIEW_CONTRACT = MANIFEST.roles.review.contract;
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const setEq = (got, want, msg) => assert.deepEqual([...got].sort(), [...want].sort(), msg);

// Run `--help`/-h with PATH stripped of codex/agy/git, from a non-git cwd with no
// AGENTS.md — proving the short-circuit fires BEFORE every preflight.
const runHelp = (arg) => {
  const root = mkdtempSync(join(tmpdir(), 'codex-review-help-'));
  const nongit = join(root, 'nongit');
  mkdirSync(nongit, { recursive: true });
  const path = makePathWithout(root, ['codex', 'agy', 'git']);
  const r = spawnSync('bash', [WRAPPER, arg], {
    cwd: nongit, encoding: 'utf8', timeout: 15000, env: { HOME: root, PATH: path },
  });
  rmSync(root, { recursive: true, force: true });
  return r;
};

// The lines of a labelled --help section (header line → the next blank line).
const helpSection = (text, header) => {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim() === header);
  assert.notEqual(i, -1, `--help must carry a "${header}" section`);
  const out = [];
  for (let j = i + 1; j < lines.length; j += 1) {
    if (lines[j].trim() === '') break;
    out.push(lines[j].trim());
  }
  return out;
};

// Source-level parser-arm extractor — the reverse drift guard. Scans ONLY `case`
// statements whose SUBJECT is a CLI-argument variable (allowlisted), skipping
// heredoc bodies (a heredoc may carry non-CLI `case` arms — e.g. codex-exec's
// git-shim). Returns Map(subject → [raw arm label, …]) in source order.
const ARG_SUBJECTS = new Set(['"$mode"', '"${1:-}"', '"$1"', '"$_arg"']);
const extractArgCaseArms = (source) => {
  const arms = new Map();
  const stack = [];
  let heredoc = null;
  for (const raw of source.split('\n')) {
    if (heredoc) {
      if (raw.trim() === heredoc) heredoc = null;
      continue;
    }
    if (raw.trimStart().startsWith('#')) continue; // a comment line may carry a stray ')'
    const hd = raw.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (hd) { heredoc = hd[1]; continue; }
    const cs = raw.match(/^\s*case\s+(\S+)\s+in\b/);
    if (cs) { stack.push(cs[1]); continue; }
    if (/^\s*esac\b/.test(raw)) { stack.pop(); continue; }
    if (stack.length && ARG_SUBJECTS.has(stack[stack.length - 1])) {
      const arm = raw.match(/^\s*([^)(\s][^)(]*)\)/);
      if (arm) {
        const subject = stack[stack.length - 1];
        if (!arms.has(subject)) arms.set(subject, []);
        arms.get(subject).push(arm[1].trim());
      }
    }
  }
  return arms;
};
const splitArms = (labels) => (labels ?? []).flatMap((l) => l.split('|'));

describe('codex-review.sh — --help contract (manifest-pinned)', () => {
  it('--help and -h exit 0 pre-preflight (no codex, no git, no AGENTS.md)', () => {
    for (const arg of ['--help', '-h']) {
      const r = runHelp(arg);
      assert.equal(r.status, 0, `${arg}: ${r.stderr}`);
      assert.match(r.stdout, /Usage:/, `${arg} prints the contract to stdout`);
      assert.equal(r.stderr, '', `${arg} prints nothing to stderr`);
    }
  });

  it('Usage set-EQUALS the manifest invocation descriptors (both directions)', () => {
    const help = runHelp('--help').stdout;
    const got = helpSection(help, 'Usage:').filter((l) => l.startsWith('codex-review')).map(norm);
    assert.ok(REVIEW_CONTRACT.invocations.length > 0, 'manifest invocations must be non-empty');
    setEq(got, REVIEW_CONTRACT.invocations.map(norm), 'help Usage ⟷ manifest invocations');
  });

  it('Grounding renders the manifest grounding note verbatim', () => {
    const help = runHelp('--help').stdout;
    assert.equal(norm(helpSection(help, 'Grounding:').join(' ')), norm(REVIEW_CONTRACT.grounding));
  });

  it('Round-2 / resume set-EQUALS the manifest continue descriptors (empty — one-shot)', () => {
    const help = runHelp('--help').stdout;
    const got = helpSection(help, 'Round-2 / resume:').filter((l) => l.startsWith('codex-review')).map(norm);
    setEq(got, (REVIEW_CONTRACT.continue ?? []).map(norm), 'help continue ⟷ manifest continue');
    assert.deepEqual(REVIEW_CONTRACT.continue, [], 'codex-review is one-shot — no continue descriptor');
  });

  it('Receipt renders the manifest receipt contract verbatim (AD-038 three-way lockstep)', () => {
    const help = runHelp('--help').stdout;
    assert.equal(norm(helpSection(help, 'Receipt:').join(' ')), norm(REVIEW_CONTRACT.receipt));
    assert.match(REVIEW_CONTRACT.receipt, /sha256 over the canonical uncommitted-state payload/, 'the fingerprint definition lives in the manifest contract');
  });
});

describe('codex-review.sh — source-level reverse guard (parser arms ⟷ manifest)', () => {
  const arms = extractArgCaseArms(readFileSync(WRAPPER, 'utf8'));

  it('the real mode arms equal the manifest modes (adding a mode without the manifest fails here)', () => {
    const modes = splitArms(arms.get('"$mode"')).filter((a) => a !== '*');
    assert.ok(MANIFEST.roles.review.modes.length > 0, 'manifest modes must be non-empty');
    setEq(new Set(modes), MANIFEST.roles.review.modes, 'parser mode arms ⟷ manifest modes');
  });

  it('the first-arg entrypoints are exactly --help/-h (no undeclared resume/flag entrypoint)', () => {
    setEq(new Set(splitArms(arms.get('"${1:-}"'))), ['--help', '-h']);
  });

  it('every manifest mode is really accepted (forward guard)', () => {
    const drive = { plan: ['plan', 'plan.md'], code: ['code'] };
    for (const mode of MANIFEST.roles.review.modes) {
      assert.ok(drive[mode], `no test drive for manifest mode "${mode}" — add one`);
      const sb = makeSandbox();
      const r = run(sb, { args: drive[mode] });
      rmSync(sb.root, { recursive: true, force: true });
      assert.equal(r.status, 0, `mode ${mode}: ${r.stderr}`);
    }
  });
});

// ── review receipts (AD-038) ─────────────────────────────────────────────────────
// The normative fixture (docs: the AD-038 plan Decisions — copied verbatim; field VALUES with
// dynamic content are asserted by shape):
const RECEIPT_FIXTURE = JSON.parse(
  '{"schema":1,"artifact":"code","fresh":true,"fingerprint":"<sha256hex>","backend":"codex","verdict":"revise","grounded":true,"factsHash":null,"wrapperVersion":"2.3.0","timestamp":"2026-07-03T12:00:00Z"}',
);
const RECEIPTS_REL = join('.git', 'agent-workflow-review-receipts.jsonl');
const readReceipts = (repo) => {
  const p = join(repo, RECEIPTS_REL);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

describe('codex-review.sh — review receipts (AD-038)', () => {
  it('a successful code review appends ONE fixture-shaped receipt (text-mode verdict parse)', () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { CODEX_FAKE_FINAL: '[major] — a.txt:1 — x — y\nVerdict: revise' } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(receipts.length, 1, 'exactly one receipt line');
    const receipt = receipts[0];
    assert.deepEqual(Object.keys(receipt), Object.keys(RECEIPT_FIXTURE), 'fixture key set + order');
    assert.equal(receipt.schema, 1);
    assert.equal(receipt.artifact, 'code');
    assert.equal(receipt.fresh, true, 'every codex run is a fresh one-shot');
    assert.match(receipt.fingerprint, /^[0-9a-f]{64}$/, 'a real sha256 hex fingerprint');
    assert.equal(receipt.backend, 'codex');
    assert.equal(receipt.verdict, 'revise', 'the mandated literal verdict line is parsed');
    assert.equal(receipt.grounded, true, 'codex is grounded by construction');
    assert.equal(receipt.factsHash, null, 'native grounding — no separate facts payload');
    assert.equal(receipt.wrapperVersion, MANIFEST.version, 'receipt version ⟷ capability.json version');
    assert.match(receipt.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('the code-mode fingerprint tracks the uncommitted state (same tree → same hash; edit → different)', () => {
    const sb = makeSandbox();
    // Route the fake-codex capture files to /dev/null so the runs themselves leave the repo
    // byte-identical (the default capture files land inside the repo and would change the tree).
    const quiet = { CODEX_FAKE_ARGV: '/dev/null', CODEX_FAKE_ENV: '/dev/null', CODEX_FAKE_STDIN: '/dev/null', CODEX_FAKE_FINAL: 'Verdict: ship' };
    run(sb, { env: quiet });
    run(sb, { env: quiet });
    writeFileSync(join(sb.repo, 'pending.txt'), 'edited after the first two reviews\n');
    run(sb, { env: quiet });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(receipts.length, 3);
    assert.equal(receipts[0].fingerprint, receipts[1].fingerprint, 'an unchanged tree re-fingerprints identically');
    assert.notEqual(receipts[1].fingerprint, receipts[2].fingerprint, 'an edited tree changes the fingerprint');
  });

  it('CODEX_REVIEW_SCHEMA=1 reads the schema verdict field', () => {
    const sb = makeSandbox();
    const r = run(sb, {
      env: { CODEX_REVIEW_SCHEMA: '1', CODEX_FAKE_FINAL: '{"findings":[],"verdict":"ship","notes":"ok"}' },
    });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(receipts[0].verdict, 'ship');
  });

  it('no parseable verdict → recorded as "unknown", never guessed', () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { CODEX_FAKE_FINAL: 'looks fine to me overall' } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(receipts[0].verdict, 'unknown');
  });

  it('plan mode: artifact "plan", fingerprint = the artifact-file sha256', () => {
    const sb = makeSandbox();
    const planBytes = readFileSync(join(sb.repo, 'plan.md'));
    const r = run(sb, { args: ['plan', 'plan.md'], env: { CODEX_FAKE_FINAL: 'Verdict: ship' } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(receipts[0].artifact, 'plan');
    assert.equal(receipts[0].fingerprint, sha256Hex(planBytes), 'plan fingerprint = file sha256');
  });

  it('AW_REVIEW_RECEIPTS overrides the receipt destination', () => {
    const sb = makeSandbox();
    const override = join(sb.root, 'my-receipts.jsonl');
    const r = run(sb, { env: { AW_REVIEW_RECEIPTS: override, CODEX_FAKE_FINAL: 'Verdict: ship' } });
    const inGitDir = readReceipts(sb.repo);
    const atOverride = existsSync(override) ? readFileSync(override, 'utf8') : '';
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(inGitDir.length, 0, 'nothing written to the default path');
    assert.match(atOverride, /"backend":"codex"/);
  });

  it('a receipt write failure warns loudly but never fails the review (fail-safe direction)', () => {
    const sb = makeSandbox();
    const r = run(sb, {
      env: { AW_REVIEW_RECEIPTS: join(sb.repo, 'no-such-dir', 'r.jsonl'), CODEX_FAKE_FINAL: 'Verdict: ship' },
    });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, 'the review run itself succeeds');
    assert.match(r.stderr, /could not append the review receipt/);
    assert.match(r.stdout, /Verdict: ship/, 'the findings still reach stdout');
  });

  it('a failed codex run writes NO receipt (only a successful review attests)', () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { CODEX_FAKE_EXIT: '5' } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.equal(receipts.length, 0);
  });

  it('the clean-tree preflight exits before any receipt is written', () => {
    const sb = makeSandbox({ clean: true });
    const r = run(sb);
    const receipts = readReceipts(sb.repo);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0);
    assert.equal(receipts.length, 0, 'no review ran — no receipt');
  });
});

// ── bridge settings file + service tier knob (bridges 2.3.0) ─────────────────────
// Same contract as codex-exec.test.mjs: KEY=VALUE lines under
// ${XDG_CONFIG_HOME:-$HOME/.config}/agent-workflow/bridge-settings.conf, parsed never
// sourced; explicit env (even empty) > file > built-in default. HOME is the sandbox
// repo, so the default settings path is hermetic per test.

const writeSettings = (sb, text) => {
  const dir = join(sb.repo, '.config', 'agent-workflow');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'bridge-settings.conf');
  writeFileSync(file, text);
  return file;
};
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('codex-review.sh — service tier knob (bridges 2.3.0)', () => {
  it('default: no env, no file → NO service_tier flag in codex argv', () => {
    const sb = makeSandbox();
    const r = run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.argv, /service_tier/, 'default OFF: the flag must be absent');
    assert.doesNotMatch(r.stderr, /bridge settings/, 'no file → no settings chatter');
  });

  it('env CODEX_SERVICE_TIER=priority → -c service_tier=priority reaches codex argv', () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { CODEX_SERVICE_TIER: 'priority' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.argv, /(^|\n)service_tier=priority(\n|$)/);
  });

  it('a file-set tier lands (file wins over the built-in default)', () => {
    const sb = makeSandbox();
    writeSettings(sb, 'CODEX_SERVICE_TIER=priority\n');
    const r = run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.argv, /(^|\n)service_tier=priority(\n|$)/);
  });

  it('an EXPLICITLY EMPTY env (CODEX_SERVICE_TIER=) disables a file-set tier for one run', () => {
    const sb = makeSandbox();
    writeSettings(sb, 'CODEX_SERVICE_TIER=priority\n');
    const r = run(sb, { env: { CODEX_SERVICE_TIER: '' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.argv, /service_tier/, 'env wins over file — empty means knob off');
  });

  it('an invalid env tier warns and reviews on the standard tier (never passed to codex)', () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { CODEX_SERVICE_TIER: 'turbo' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /not a supported service tier/);
    assert.doesNotMatch(r.argv, /service_tier/, 'an unvalidated value must never reach codex');
  });
});

describe('codex-review.sh — bridge settings file semantics (bridges 2.3.0)', () => {
  it('a file-set CODEX_REVIEW_MAX_TOTAL_BYTES is effective (switches to the temp-file path)', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'big.txt'), 'B'.repeat(5000));
    writeSettings(sb, 'CODEX_REVIEW_MAX_TOTAL_BYTES=100\n');
    const r = run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.capStdin, /codex-review-diff\./, 'the tiny file cap must force the temp-file path');
    assert.doesNotMatch(r.capStdin, /ASSEMBLED CHANGE SET:/, 'the payload must not ALSO ride inline');
  });

  it('env overrides file: a large env cap keeps the payload inline', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'big.txt'), 'B'.repeat(5000));
    writeSettings(sb, 'CODEX_REVIEW_MAX_TOTAL_BYTES=100\n');
    const r = run(sb, { env: { CODEX_REVIEW_MAX_TOTAL_BYTES: '5000000' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.capStdin, /ASSEMBLED CHANGE SET:/, 'the env cap (large) must win over the file cap (100)');
    assert.doesNotMatch(r.capStdin, /codex-review-diff\./);
  });

  it('duplicate key → the LAST occurrence wins (100 then 5000000 → inline)', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'big.txt'), 'B'.repeat(5000));
    writeSettings(sb, 'CODEX_REVIEW_MAX_TOTAL_BYTES=100\nCODEX_REVIEW_MAX_TOTAL_BYTES=5000000\n');
    const r = run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.capStdin, /ASSEMBLED CHANGE SET:/);
  });

  it("another wrapper's / another bridge's valid key is skipped silently", () => {
    const sb = makeSandbox();
    writeSettings(sb, 'AGY_HARD_TIMEOUT=30m\nAGY_REVIEW_ALLOW_ADDDIR=1\n');
    const r = run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /bridge settings/, 'a recognized non-applied key earns NO warning');
  });

  it('a truly unknown key warns ONCE naming the file; the review is unaffected', () => {
    const sb = makeSandbox();
    writeSettings(sb, 'TOTALLY_UNKNOWN=1\nTOTALLY_UNKNOWN=2\n');
    const r = run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    const warns = r.stderr.match(/unknown key 'TOTALLY_UNKNOWN'/g) ?? [];
    assert.equal(warns.length, 1, `exactly one warning per unknown key, got ${warns.length}`);
    assert.match(r.stderr, /bridge-settings\.conf/, 'the warning must name the settings file');
  });

  it('malformed lines warn and are ignored; comments and blank lines are silent', () => {
    const sb = makeSandbox();
    writeSettings(sb, '# a comment\n\nNOT A KEY VALUE LINE\nCODEX_SERVICE_TIER=priority\n');
    const r = run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    const malformed = r.stderr.match(/malformed line/g) ?? [];
    assert.equal(malformed.length, 1, 'comments/blank lines must NOT count as malformed');
    assert.match(r.argv, /(^|\n)service_tier=priority(\n|$)/, 'valid lines still apply');
  });

  it('an existing-but-unreadable file warns loudly and falls back to built-ins', { skip: isRoot }, () => {
    // The settings file goes OUTSIDE the repo (XDG_CONFIG_HOME): an unreadable file INSIDE the
    // work tree would fail the review-payload assembly itself (untracked contents are cat'ed),
    // which is pre-existing behaviour unrelated to the settings reader.
    const sb = makeSandbox();
    const xdg = join(sb.root, 'xdg');
    mkdirSync(join(xdg, 'agent-workflow'), { recursive: true });
    const file = join(xdg, 'agent-workflow', 'bridge-settings.conf');
    writeFileSync(file, 'CODEX_SERVICE_TIER=priority\n');
    chmodSync(file, 0o000);
    const r = run(sb, { env: { XDG_CONFIG_HOME: xdg } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /unreadable/);
    assert.doesNotMatch(r.argv, /service_tier/, 'an unreadable file must yield built-in defaults');
  });

  it('a settings line can NEVER execute code (command-substitution payload inert)', () => {
    const sb = makeSandbox();
    const pwned = join(sb.repo, 'pwned');
    const pwned2 = join(sb.repo, 'pwned2');
    writeSettings(
      sb,
      `CODEX_SERVICE_TIER=$(touch ${pwned})\nEVIL_KEY=\`touch ${pwned2}\`\n`,
    );
    const r = run(sb);
    const executed = existsSync(pwned) || existsSync(pwned2);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(executed, false, 'file content must be parsed, never evaluated');
    assert.doesNotMatch(r.argv, /service_tier/, 'the payload value must fail validation');
  });

  it('a DIRECTORY at the settings path warns loudly and falls back to built-ins (no crash)', () => {
    // Outside the repo (XDG) — an unreadable path INSIDE the work tree would fail the
    // review-payload assembly itself (pre-existing behaviour, unrelated to the reader).
    const sb = makeSandbox();
    const xdg = join(sb.root, 'xdg');
    mkdirSync(join(xdg, 'agent-workflow', 'bridge-settings.conf'), { recursive: true });
    const r = run(sb, { env: { XDG_CONFIG_HOME: xdg } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, `a directory must degrade honestly, not kill the run: ${r.stderr}`);
    assert.match(r.stderr, /unreadable or not a regular file/);
    assert.doesNotMatch(r.stderr, /Is a directory/, 'no raw bash error may leak');
  });
});

// ── settings surface ⟷ manifest (drift guard, D6) — same contract as codex-exec ──
const SETTINGS_HEADER = 'Settings file (KEY=VALUE, parsed never sourced; env wins over file, file wins over built-in default):';
const SIBLING_MANIFEST = JSON.parse(readFileSync(join(HERE, '..', '..', 'antigravity-cli-bridge', 'capability.json'), 'utf8'));
const ALL_SETTINGS = [...(MANIFEST.settings ?? []), ...(SIBLING_MANIFEST.settings ?? [])];
const SETTINGS_CMD = 'codex-review';

describe('codex-review.sh — settings surface ⟷ manifest (D6, manifest-pinned)', () => {
  it('--help Settings section keys set-EQUAL the manifest appliesTo subset', () => {
    const help = runHelp('--help').stdout;
    const section = helpSection(help, SETTINGS_HEADER);
    const got = section.filter((l) => /^[A-Z][A-Z0-9_]+ —/.test(l)).map((l) => l.split(' ')[0]);
    const want = (MANIFEST.settings ?? []).filter((s) => s.appliesTo.includes(SETTINGS_CMD)).map((s) => s.key);
    assert.ok(want.length > 0, 'the manifest must declare settings for this wrapper');
    setEq(got, want, 'help Settings keys ⟷ manifest settings.appliesTo');
    assert.ok(section.some((l) => l.includes('agent-workflow/bridge-settings.conf')), 'the section names the settings file');
  });

  const source = readFileSync(WRAPPER, 'utf8');

  it('aw_settings_known carries exactly the UNION of both bridges settings keys', () => {
    const m = source.match(/aw_settings_known\(\) \{\n  case " ([^"]+) " in/);
    assert.ok(m, 'aw_settings_known registry case not found');
    assert.ok(ALL_SETTINGS.length >= 5, 'both manifests must contribute settings');
    setEq(m[1].trim().split(/\s+/), ALL_SETTINGS.map((s) => s.key), 'shell registry ⟷ manifest union');
  });

  it('AW_SETTINGS_APPLIED equals the manifest appliesTo subset for this wrapper', () => {
    const m = source.match(/^AW_SETTINGS_APPLIED="([^"]*)"$/m);
    assert.ok(m, 'AW_SETTINGS_APPLIED not found');
    const want = ALL_SETTINGS.filter((s) => s.appliesTo.includes(SETTINGS_CMD)).map((s) => s.key);
    assert.ok(want.length > 0);
    setEq(m[1].trim().split(/\s+/), want, 'applied subset ⟷ manifest appliesTo');
  });

  it('aw_settings_valid arms carry the manifest typed constants per key', () => {
    const body = source.match(/aw_settings_valid\(\) \{[\s\S]*?\n\}/);
    assert.ok(body, 'aw_settings_valid not found');
    const armKeys = [...body[0].matchAll(/^    ([A-Z][A-Z0-9_]*)\)/gm)].map((x) => x[1]);
    setEq(armKeys, ALL_SETTINGS.map((s) => s.key), 'validation arms ⟷ manifest keys');
    for (const s of ALL_SETTINGS) {
      const arm = body[0].match(new RegExp(`^    ${s.key}\\) (.*) ;;$`, 'm'));
      assert.ok(arm, `no validation arm for ${s.key}`);
      if (s.kind === 'enum') for (const v of s.values) assert.ok(arm[1].includes(`"${v}"`), `${s.key}: enum value '${v}' not pinned`);
      if (s.kind === 'integer') {
        assert.match(arm[1], new RegExp(`>= ${s.min}\\b`), `${s.key}: min ${s.min} not pinned`);
        assert.match(arm[1], new RegExp(`<= ${s.max}\\b`), `${s.key}: max ${s.max} not pinned`);
      }
      if (s.kind === 'boolean') assert.ok(arm[1].includes('"0"') && arm[1].includes('"1"'), `${s.key}: boolean 0/1 not pinned`);
      if (s.kind === 'duration') {
        assert.ok(arm[1].includes('$dur_re'), `${s.key}: duration grammar not pinned`);
        assert.ok(arm[1].includes('$zero_re'), `${s.key}: zero-duration rejection not pinned (timeout 0 disables the cap)`);
      }
    }
  });
});
