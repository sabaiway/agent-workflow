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

const makeSandbox = () => {
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

  it('plan mode: includes the plan body and the read fence', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['plan', 'plan.md'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.match(r.capStdin, /Do a thing in two steps/);
    assert.match(r.capStdin, /Do not read files outside this git working tree/);
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
