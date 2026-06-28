import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync,
  existsSync, readdirSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(HERE, 'codex-review.sh');

// Same hermetic fake `codex` as codex-exec.test.mjs (kept inline so each bridge
// test file is standalone — no shared helper grows the byte-identical mirror set).
const FAKE_CODEX = [
  '#!/usr/bin/env bash',
  'set -u',
  'if [[ "${1:-}" == "login" ]]; then echo "Logged in using ChatGPT"; exit 0; fi',
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
  'cat <<EOF',
  '{"type":"thread.started","thread_id":"${CODEX_FAKE_THREAD_ID:-fake-thread-123}"}',
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

const makePathWithoutTimeout = (root) => {
  const dir = join(root, 'nobin');
  mkdirSync(dir, { recursive: true });
  for (const d of (process.env.PATH || '').split(':').filter(Boolean)) {
    let names;
    try { names = readdirSync(d); } catch { continue; }
    for (const name of names) {
      if (name === 'timeout' || name === 'gtimeout') continue;
      const link = join(dir, name);
      if (existsSync(link)) continue;
      try { symlinkSync(join(d, name), link); } catch { /* dup / race — ignore */ }
    }
  }
  return dir;
};

const run = ({ repo, bin }, { args = ['code'], env = {}, path } = {}) => {
  const argvFile = join(repo, '.cap-argv');
  const envFile = join(repo, '.cap-env');
  const stdinFile = join(repo, '.cap-stdin');
  const codexHome = join(repo, '..', 'codex-home');
  const r = spawnSync('bash', [WRAPPER, ...args], {
    cwd: repo,
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
    const path = `${sb.bin}:${makePathWithoutTimeout(sb.root)}`;
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
