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
const WRAPPER = join(HERE, 'codex-exec.sh');

// A hermetic fake `codex`: answers `login status`, captures argv/env/stdin to the
// files named by CODEX_FAKE_*, honours -o by writing a final-message file, and
// emits a minimal --json event stream (thread.started carries the session id).
// Written with shell double-quotes + a heredoc ONLY (no single-quotes, no
// backslashes) so it survives transport through a JS single-quoted array.
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
  const root = mkdtempSync(join(tmpdir(), 'codex-exec-test-'));
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, 'codex');
  writeFileSync(stub, FAKE_CODEX, { mode: 0o755 });
  chmodSync(stub, 0o755);
  // A git work tree with a root AGENTS.md — the wrapper preflights both.
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const g = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'probe@example.com');
  g('config', 'user.name', 'probe');
  writeFileSync(join(repo, 'AGENTS.md'), '# AGENTS\n\nHard Constraints: none (test fixture).\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  return { root, bin, repo };
};

// A PATH dir mirroring the real one MINUS timeout/gtimeout, to exercise the
// no-cap fallback hermetically without a production test backdoor.
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

const run = ({ repo, bin }, { args = ['-'], input = 'do the thing', env = {}, path } = {}) => {
  const argvFile = join(repo, '.cap-argv');
  const envFile = join(repo, '.cap-env');
  const stdinFile = join(repo, '.cap-stdin');
  const r = spawnSync('bash', [WRAPPER, ...args], {
    cwd: repo,
    input,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      PATH: path || `${bin}:${process.env.PATH}`,
      HOME: repo,
      CODEX_FAKE_ARGV: argvFile,
      CODEX_FAKE_ENV: envFile,
      CODEX_FAKE_STDIN: stdinFile,
      ...env,
    },
  });
  const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  return { ...r, argv: readIf(argvFile), capEnv: readIf(envFile), capStdin: readIf(stdinFile) };
};

describe('codex-exec.sh — quality-first model/effort guard (1.1)', () => {
  it('refuses a non-default CODEX_MODEL and never spends a run', () => {
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

  it('CODEX_PROBE=1 allows a non-default model and warns loudly', () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { CODEX_PROBE: '1', CODEX_MODEL: 'gpt-5.4-mini' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /THROWAWAY PROBE MODE/);
    assert.match(r.argv, /gpt-5\.4-mini/, 'the probe model must reach codex');
  });
});

// Tier 1 — subscription / sandbox / approval / config / provider / model-pin /
// capture flags: rejected ALWAYS, even under CODEX_PROBE=1.
const ALWAYS_BLOCKED = [
  ['-s', 'read-only'], ['--sandbox', 'danger-full-access'], ['-c', 'k=v'], ['--config', 'k=v'],
  ['--full-auto'], ['--dangerously-bypass-approvals-and-sandbox'], ['--oss'], ['--local-provider', 'x'],
  ['-p', 'prof'], ['--profile', 'prof'], ['-m', 'gpt-5.5'], ['--model', 'gpt-5.5'],
  ['-o', '/x'], ['--output-last-message', '/x'], ['--json'], ['--color', 'always'],
  ['--output-schema', '/x'], ['--ephemeral'],
];
// Tier 2 — context/discovery knobs: rejected for real runs, allowed under CODEX_PROBE=1.
const PROBE_RELAXABLE = [
  ['--add-dir', '/x'], ['-C', '/x'], ['--cd', '/x'], ['--skip-git-repo-check'],
  ['--ignore-rules'], ['--enable', 'foo'], ['--disable', 'foo'],
];

describe('codex-exec.sh — passthrough guard, two tiers (1.1)', () => {
  for (const flag of ALWAYS_BLOCKED) {
    it(`always rejects ${flag[0]} (no probe)`, () => {
      const sb = makeSandbox();
      const r = run(sb, { args: ['-', '--', ...flag] });
      rmSync(sb.root, { recursive: true, force: true });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /is not allowed/);
    });
    it(`still rejects ${flag[0]} even under CODEX_PROBE=1`, () => {
      const sb = makeSandbox();
      const r = run(sb, { args: ['-', '--', ...flag], env: { CODEX_PROBE: '1' } });
      rmSync(sb.root, { recursive: true, force: true });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /blocked even under CODEX_PROBE=1/);
    });
  }

  for (const flag of PROBE_RELAXABLE) {
    it(`rejects ${flag[0]} for a real run (no probe)`, () => {
      const sb = makeSandbox();
      const r = run(sb, { args: ['-', '--', ...flag] });
      rmSync(sb.root, { recursive: true, force: true });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /is not allowed/);
    });
  }

  it('CODEX_PROBE=1 lets a context flag (--add-dir) through and warns', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['-', '--', '--add-dir', '/x'], env: { CODEX_PROBE: '1' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.argv, /--add-dir/);
    assert.match(r.stderr, /THROWAWAY PROBE MODE/);
  });
});

describe('codex-exec.sh — subscription / config isolation (invariant)', () => {
  it('clears every *_API_KEY + OPENAI_BASE_URL and passes --ignore-user-config', () => {
    const sb = makeSandbox();
    const r = run(sb, { env: {
      OPENAI_API_KEY: 'sk-should-be-cleared', OPENAI_BASE_URL: 'http://evil.example', FOO_API_KEY: 'bar',
    } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.capEnv, /^OPENAI_API_KEY=<unset>$/m);
    assert.match(r.capEnv, /^OPENAI_BASE_URL=<unset>$/m);
    assert.match(r.capEnv, /^FOO_API_KEY=<unset>$/m);
    assert.match(r.argv, /(^|\n)--ignore-user-config(\n|$)/);
  });
});

describe('codex-exec.sh — clean output + session capture (1.2)', () => {
  it('prints ONLY the final message, not the JSON event stream', () => {
    const sb = makeSandbox();
    const r = run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /FAKE_FINAL_MESSAGE/);
    assert.doesNotMatch(r.stdout, /thread\.started/, 'the JSON trace must not leak to stdout');
  });

  it('passes the clean-capture flags to codex', () => {
    const sb = makeSandbox();
    const r = run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    for (const f of [/(^|\n)-o(\n|$)/, /(^|\n)--json(\n|$)/, /(^|\n)--color(\n|$)/,
      /hide_agent_reasoning=true/, /model_reasoning_summary=none/]) {
      assert.match(r.argv, f, `expected ${f} among codex argv`);
    }
  });

  it('captures the session id to the default sidecar and stderr', () => {
    const sb = makeSandbox();
    const r = run(sb);
    const sidecar = join(sb.repo, '.codex-last-session');
    const got = existsSync(sidecar) ? readFileSync(sidecar, 'utf8').trim() : '';
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(got, 'fake-thread-123');
    assert.match(r.stderr, /session: fake-thread-123/);
  });

  it('honours CODEX_SESSION_FILE and leaves the default sidecar untouched', () => {
    const sb = makeSandbox();
    const custom = join(sb.repo, 'my-session');
    run(sb, { env: { CODEX_SESSION_FILE: custom } });
    const customGot = existsSync(custom) ? readFileSync(custom, 'utf8').trim() : '';
    const defaultWritten = existsSync(join(sb.repo, '.codex-last-session'));
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(customGot, 'fake-thread-123');
    assert.equal(defaultWritten, false, 'the default sidecar must not be written when CODEX_SESSION_FILE is set');
  });

  it('falls back to the trace tail when the final-message file is missing', () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { CODEX_FAKE_NO_OUT: '1' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /no final-message file/);
    assert.match(r.stdout, /turn\.completed/, 'the trace tail should carry the event stream');
  });

  it('on a codex failure, prints the trace tail to stderr and exits codex code', () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { CODEX_FAKE_EXIT: '7' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 7);
    assert.match(r.stderr, /codex exec failed \(exit 7\)/);
    assert.match(r.stderr, /thread\.started/, 'failure should surface the trace tail');
  });

  it('warns (never silently) when the session sidecar cannot be written', () => {
    const sb = makeSandbox();
    const blocker = join(sb.repo, 'blocker');
    writeFileSync(blocker, 'x');                  // a regular file …
    const bad = join(blocker, 'session');         // … so this path is unwritable (ENOTDIR)
    const r = run(sb, { env: { CODEX_SESSION_FILE: bad } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /could not write the session sidecar/);
    assert.match(r.stderr, /session: fake-thread-123/, 'the id must still reach stderr');
  });
});

describe('codex-exec.sh — leaner prompt (1.4)', () => {
  it('directive obeys AGENTS.md from context without a read-AGENTS action', () => {
    const sb = makeSandbox();
    const r = run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.match(r.capStdin, /Obey EVERY Hard Constraint declared in the project's root AGENTS\.md \(already/);
    assert.doesNotMatch(r.capStdin, /Read the target project's root AGENTS\.md/);
    assert.match(r.capStdin, /do the thing/, 'the task must be appended to the directive');
  });
});

describe('codex-exec.sh — hard timeout (1.3)', () => {
  it('kills a hung codex at CODEX_HARD_TIMEOUT and reports it', () => {
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

describe('codex-exec.sh — preflight (unchanged invariants)', () => {
  it('STOPs when there is no root AGENTS.md', () => {
    const sb = makeSandbox();
    rmSync(join(sb.repo, 'AGENTS.md'));
    const r = run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no root AGENTS\.md/);
  });
});
