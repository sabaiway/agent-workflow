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
  'if [[ "${1:-}" == "login" ]]; then echo "${CODEX_FAKE_LOGIN:-Logged in using ChatGPT}"; exit 0; fi',
  ': "${CODEX_FAKE_ARGV:=/dev/null}"',
  ': "${CODEX_FAKE_ENV:=/dev/null}"',
  ': "${CODEX_FAKE_STDIN:=/dev/null}"',
  '{ for a in "$@"; do echo "$a"; done; } >"$CODEX_FAKE_ARGV"',
  '{ echo "HOME=${HOME:-}"; echo "CODEX_HOME=${CODEX_HOME:-}"; echo "XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-}"; echo "OPENAI_API_KEY=${OPENAI_API_KEY:-<unset>}"; echo "OPENAI_BASE_URL=${OPENAI_BASE_URL:-<unset>}"; echo "FOO_API_KEY=${FOO_API_KEY:-<unset>}"; echo "CODEX_REAL_GIT=${CODEX_REAL_GIT:-<unset>}"; } >"$CODEX_FAKE_ENV"',
  'cat >"$CODEX_FAKE_STDIN"',
  'if [[ "${CODEX_FAKE_GIT_PROBE:-}" == "1" ]]; then { echo "realgit_env=${CODEX_REAL_GIT:-unset}"; echo "status=$(git status --short >/dev/null 2>&1; echo $?)"; echo "diff=$(git --no-pager diff >/dev/null 2>&1; echo $?)"; echo "dashC_read=$(git -C . status --short >/dev/null 2>&1; echo $?)"; echo "dashc_read=$(git -c core.pager=cat status --short >/dev/null 2>&1; echo $?)"; echo "bare=$(git >/dev/null 2>&1; echo $?)"; echo "commit=$(git commit -m x >/dev/null 2>&1; echo $?)"; echo "add=$(git add -A >/dev/null 2>&1; echo $?)"; echo "checkout=$(git checkout -- . >/dev/null 2>&1; echo $?)"; echo "unknown=$(git frobnicate >/dev/null 2>&1; echo $?)"; echo "config_read=$(git config user.name >/dev/null 2>&1; echo $?)"; echo "config_list=$(git config --list >/dev/null 2>&1; echo $?)"; echo "config_bare=$(git config >/dev/null 2>&1; echo $?)"; echo "config_write=$(git config user.name HACKED >/dev/null 2>&1; echo $?)"; echo "config_bypass=$(git config --get --add a.b v >/dev/null 2>&1; echo $?)"; echo "symref_write=$(git symbolic-ref HEAD refs/heads/x >/dev/null 2>&1; echo $?)"; echo "reflog_write=$(git reflog expire --all >/dev/null 2>&1; echo $?)"; } > "${CODEX_FAKE_GIT_RESULT:-/dev/null}" 2>&1; fi',
  'if [[ -n "${CODEX_FAKE_SLEEP:-}" ]]; then sleep "${CODEX_FAKE_SLEEP}"; fi',
  'out=""',
  'prev=""',
  'for a in "$@"; do',
  '  if [[ "$prev" == "-o" || "$prev" == "--output-last-message" ]]; then out="$a"; fi',
  '  prev="$a"',
  'done',
  'if [[ -n "$out" ]]; then',
  '  if [[ "${CODEX_FAKE_NO_OUT:-}" != "1" ]]; then echo "${CODEX_FAKE_FINAL:-FAKE_FINAL_MESSAGE}" >"$out"; fi',
  '  if [[ "${CODEX_FAKE_NO_THREAD:-}" != "1" ]]; then',
  '  cat <<EOF',
  '{"type":"thread.started","thread_id":"${CODEX_FAKE_THREAD_ID:-fake-thread-123}"}',
  'EOF',
  '  fi',
  '  cat <<EOF',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"FAKE_FINAL_MESSAGE"}}',
  '{"type":"turn.completed","usage":{}}',
  'EOF',
  'else',
  '  echo "${CODEX_FAKE_FINAL:-FAKE_FINAL_MESSAGE}"',
  'fi',
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

// A PATH dir mirroring the real one MINUS the named binaries, to exercise the
// missing-binary fallbacks (no-cap when timeout is gone; the codex/git preflight
// 127s) hermetically without a production test backdoor.
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

const run = ({ repo, bin }, { args = ['-'], input = 'do the thing', env = {}, path, cwd } = {}) => {
  const argvFile = join(repo, '.cap-argv');
  const envFile = join(repo, '.cap-env');
  const stdinFile = join(repo, '.cap-stdin');
  const r = spawnSync('bash', [WRAPPER, ...args], {
    cwd: cwd || repo,
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
  ['--full-auto'], ['--dangerously-bypass-approvals-and-sandbox'], ['--dangerously-bypass-hook-trust'],
  ['--oss'], ['--local-provider', 'x'],
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
    const path = `${sb.bin}:${makePathWithout(sb.root, ['timeout', 'gtimeout'])}`;
    const r = run(sb, { path });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /WITHOUT a hard wall-clock cap/);
    assert.match(r.stdout, /FAKE_FINAL_MESSAGE/);
  });

  it('resume runs uncapped (and warns) when no timeout binary is on PATH', () => {
    const sb = makeSandbox();
    const path = `${sb.bin}:${makePathWithout(sb.root, ['timeout', 'gtimeout'])}`;
    const r = run(sb, { args: ['--resume', 'sess-1', '-'], input: 'go', path });
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

describe('codex-exec.sh — resume entrypoint restates every invariant (3.1)', () => {
  const RESUME_INVARIANTS = [
    /(^|\n)resume(\n|$)/, /(^|\n)--ignore-user-config(\n|$)/, /(^|\n)gpt-5\.5(\n|$)/,
    /model_reasoning_effort=xhigh/, /sandbox_mode=workspace-write/,
    /approval_policy=never/, /sandbox_workspace_write\.network_access=false/,
  ];

  it('--resume <id>: composes `exec resume <id>` with the full restated policy', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['--resume', 'sess-xyz', '-'], input: 'continue please' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.argv, /(^|\n)sess-xyz(\n|$)/, 'the session id is passed positionally');
    for (const inv of RESUME_INVARIANTS) assert.match(r.argv, inv, `resume argv must include ${inv}`);
    assert.doesNotMatch(r.argv, /(^|\n)-o(\n|$)/, 'resume rejects -o');
    assert.doesNotMatch(r.argv, /(^|\n)--json(\n|$)/, 'resume rejects --json');
    assert.doesNotMatch(r.argv, /(^|\n)--color(\n|$)/, 'resume rejects --color');
    assert.match(r.stdout, /FAKE_FINAL_MESSAGE/, 'resume prints codex stdout');
  });

  it('--resume-last reads the session id from the sidecar', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, '.codex-last-session'), 'sess-from-sidecar\n');
    const r = run(sb, { args: ['--resume-last', '-'], input: 'continue' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.argv, /(^|\n)sess-from-sidecar(\n|$)/);
  });

  it('--resume-last honours CODEX_SESSION_FILE', () => {
    const sb = makeSandbox();
    const custom = join(sb.repo, 'mysess');
    writeFileSync(custom, 'sess-custom\n');
    const r = run(sb, { args: ['--resume-last', '-'], input: 'go', env: { CODEX_SESSION_FILE: custom } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.match(r.argv, /(^|\n)sess-custom(\n|$)/);
  });

  it('--resume-last with no sidecar STOPs (never guesses)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['--resume-last', '-'], input: 'go' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no session sidecar/);
  });

  it('--resume with no id STOPs', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['--resume', '-'], input: 'go' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--resume needs a <session-id>/);
  });

  it('rejects an empty resumed instruction', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['--resume', 'sess-1', '-'], input: '   \n' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /empty resumed/);
  });

  it('resume takes no passthrough flags', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['--resume', 'sess-1', '-', '--', '--add-dir', '/x'], input: 'go' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /resume modes take no extra flags/);
  });

  it('resume never sets --ephemeral', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['--resume', 'sess-1', '-'], input: 'go' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.doesNotMatch(r.argv, /--ephemeral/);
  });

  it('--resume-last with an EMPTY sidecar STOPs (no blank id)', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, '.codex-last-session'), '   \n');
    const r = run(sb, { args: ['--resume-last', '-'], input: 'go' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /sidecar.*is empty/);
  });

  it('resume still clears every *_API_KEY/OPENAI_BASE_URL and keeps --ignore-user-config', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['--resume', 'sess-1', '-'], input: 'go', env: {
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

describe('codex-exec.sh — enforced git-write boundary shim (3.2)', () => {
  it('passes read-only verbs, blocks writes/unknown/config-writes; no env bypass', () => {
    const sb = makeSandbox();
    const result = join(sb.repo, 'git-probe-result');
    const r = run(sb, { env: { CODEX_FAKE_GIT_PROBE: '1', CODEX_FAKE_GIT_RESULT: result } });
    const probe = existsSync(result) ? readFileSync(result, 'utf8') : '';
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    // The real git path is baked into the shim, NOT exported — codex cannot read it.
    assert.match(probe, /realgit_env=unset/, 'CODEX_REAL_GIT must not be exposed to codex');
    assert.match(probe, /status=0/, 'git status (read) passes through');
    assert.match(probe, /diff=0/, 'git --no-pager diff (read, global option) passes through');
    assert.match(probe, /dashC_read=0/, 'git -C . status (value-taking global option, 2-token skip) passes through');
    assert.match(probe, /dashc_read=0/, 'git -c core.pager=cat status (value-taking -c) passes through');
    assert.match(probe, /bare=1/, 'bare git (empty verb) passes to real git → its own usage code, not the 13 block');
    assert.match(probe, /commit=13/, 'git commit (write) is blocked');
    assert.match(probe, /add=13/, 'git add (write) is blocked');
    assert.match(probe, /checkout=13/, 'git checkout (write) is blocked');
    assert.match(probe, /unknown=13/, 'an unknown verb is blocked by default');
    assert.match(probe, /config_read=0/, 'git config <name> (read) passes through');
    assert.match(probe, /config_list=0/, 'git config --list (read) passes through');
    assert.match(probe, /config_bare=129/, 'bare git config (empty rest) passes through to real git (usage code 129) — not blocked (13), not a set -u crash (1)');
    assert.match(probe, /config_write=13/, 'git config <name> <value> (write) is blocked');
    assert.match(probe, /config_bypass=13/, 'git config --get --add … (write bypass) is blocked');
    assert.match(probe, /symref_write=13/, 'git symbolic-ref (has write modes) is blocked');
    assert.match(probe, /reflog_write=13/, 'git reflog (has write modes) is blocked');
  });

  it('the codex env carries no CODEX_REAL_GIT (bypass vector closed)', () => {
    const sb = makeSandbox();
    const r = run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.match(r.capEnv, /^CODEX_REAL_GIT=<unset>$/m);
  });
});

describe('codex-exec.sh — environment preflight (fail fast, before a run)', () => {
  it('STOPs with 127 when codex is not on PATH', () => {
    const sb = makeSandbox();
    // PATH WITHOUT the fake codex bin and without any real codex.
    const path = makePathWithout(sb.root, ['codex']);
    const r = run(sb, { path });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 127);
    assert.match(r.stderr, /'codex'.*not found on PATH/);
    assert.equal(r.capStdin, '', 'codex must never be invoked');
  });

  it('STOPs with 127 when git is not on PATH', () => {
    const sb = makeSandbox();
    // codex present (sb.bin) but git stripped — exercises the type -P git guard.
    const path = `${sb.bin}:${makePathWithout(sb.root, ['git'])}`;
    const r = run(sb, { path });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 127);
    assert.match(r.stderr, /'git' not found on PATH/);
  });

  it('STOPs (exit 1) when codex is not on a ChatGPT subscription', () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { CODEX_FAKE_LOGIN: 'Logged in using API key' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not on a ChatGPT subscription/);
    assert.equal(r.capStdin, '', 'a wrong login must never spend a run');
  });

  it('STOPs (exit 2) when not inside a git work tree', () => {
    const sb = makeSandbox();
    const nongit = join(sb.root, 'nongit');
    mkdirSync(nongit, { recursive: true });
    writeFileSync(join(nongit, 'AGENTS.md'), '# AGENTS\n'); // present, but the work-tree check fires first
    const r = run(sb, { cwd: nongit });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /must run inside a git working tree/);
  });
});

describe('codex-exec.sh — argument & prompt-source dispatch', () => {
  it('prints usage and STOPs (exit 2) with no arguments', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: [] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage:/);
  });

  it('STOPs on a stray extra argument without the -- separator', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['-', 'stray'], input: 'go' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unexpected argument 'stray'/);
  });

  it('passes an allowed (non-blocked) passthrough flag through to codex', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['-', '--', '--foobar', 'val'], input: 'go' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.argv, /(^|\n)--foobar(\n|$)/, 'an unguarded flag reaches codex argv');
  });

  it('reads the task from a prompt FILE (not just stdin)', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'task.md'), 'PROMPT_FROM_FILE_MARKER\n');
    const r = run(sb, { args: ['task.md'], input: '' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.capStdin, /PROMPT_FROM_FILE_MARKER/);
  });

  it('STOPs (exit 2) when the prompt path is neither - nor a file', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['no-such-file.md'], input: '' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /'no-such-file\.md' is not a file/);
  });

  it('STOPs on an empty task in normal mode (no "resumed" wording)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['-'], input: '   \n' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /empty plan\/instruction/);
    assert.doesNotMatch(r.stderr, /resumed/, 'normal mode must not say "resumed"');
  });

  it('--resume-last with no prompt argument STOPs (missing <plan-file>)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['--resume-last'], input: '' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /missing <plan-file/);
  });
});

describe('codex-exec.sh — session id absent', () => {
  it('writes no sidecar and no session line when codex emits no thread id', () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { CODEX_FAKE_NO_THREAD: '1' } });
    const wrote = existsSync(join(sb.repo, '.codex-last-session'));
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(wrote, false, 'no thread id → no sidecar');
    assert.doesNotMatch(r.stderr, /session:/, 'no thread id → no session line');
    assert.match(r.stdout, /FAKE_FINAL_MESSAGE/, 'the run still succeeds');
  });
});

// ── driving contract: --help ⟷ manifest ⟷ real arg-parsing (drift-guarded) ─────
// The manifest roles.execute.contract is the single machine-readable source of the
// driving contract; these suites pin (a) --help renders it verbatim (set-EQUALITY,
// both directions, incl. the TIERED guarded-passthrough sets), (b) the wrapper's
// REAL parser arms equal the declared sets (source-level reverse guard — the
// git-shim heredoc's own `case` arms are NOT CLI modes and must be skipped).
// Helpers are inline — each bridge test file stays standalone (mirror byte-equality).

const MANIFEST = JSON.parse(readFileSync(join(HERE, '..', 'capability.json'), 'utf8'));
const EXEC_CONTRACT = MANIFEST.roles.execute.contract;
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const setEq = (got, want, msg) => assert.deepEqual([...got].sort(), [...want].sort(), msg);
const leadingFlag = (descriptor) => {
  const m = norm(descriptor).match(/(^|\s)(--[a-z-]+)/);
  assert.ok(m, `descriptor "${descriptor}" carries no --flag token`);
  return m[2];
};

// Run `--help`/-h with PATH stripped of codex/agy/git, from a non-git cwd with no
// AGENTS.md — proving the short-circuit fires BEFORE every preflight.
const runHelp = (arg) => {
  const root = mkdtempSync(join(tmpdir(), 'codex-exec-help-'));
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
// heredoc bodies (codex-exec's git-shim heredoc carries its own `case "$verb"`
// git-verb arms that are NOT CLI modes). Returns Map(subject → [raw arm label, …]).
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

describe('codex-exec.sh — --help contract (manifest-pinned)', () => {
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
    const got = helpSection(help, 'Usage:').filter((l) => l.startsWith('codex-exec')).map(norm);
    assert.ok(EXEC_CONTRACT.invocations.length > 0, 'manifest invocations must be non-empty');
    setEq(got, EXEC_CONTRACT.invocations.map(norm), 'help Usage ⟷ manifest invocations');
  });

  it('Grounding renders the manifest grounding note verbatim', () => {
    const help = runHelp('--help').stdout;
    assert.equal(norm(helpSection(help, 'Grounding:').join(' ')), norm(EXEC_CONTRACT.grounding));
  });

  it('Round-2 / resume set-EQUALS the manifest continue descriptors', () => {
    const help = runHelp('--help').stdout;
    const got = helpSection(help, 'Round-2 / resume:').filter((l) => l.startsWith('codex-exec')).map(norm);
    assert.ok(EXEC_CONTRACT.continue.length > 0, 'manifest continue must be non-empty');
    setEq(got, EXEC_CONTRACT.continue.map(norm), 'help continue ⟷ manifest continue');
  });

  it('the guarded-passthrough TIERS set-EQUAL the manifest tiers (never a flat set)', () => {
    const help = runHelp('--help').stdout;
    const section = helpSection(help, "Guarded passthrough after '--':");
    const tier = (prefix) => {
      const line = section.find((l) => l.startsWith(prefix));
      assert.ok(line, `passthrough section must carry a "${prefix}" line`);
      return line.slice(prefix.length).trim().split(/\s+/);
    };
    assert.ok(EXEC_CONTRACT.passthrough.blocked.length > 0, 'manifest blocked tier must be non-empty');
    assert.ok(EXEC_CONTRACT.passthrough.probeRelaxed.length > 0, 'manifest probe tier must be non-empty');
    setEq(tier('blocked always:'), EXEC_CONTRACT.passthrough.blocked, 'help tier-1 ⟷ manifest blocked');
    setEq(tier('relaxed only under CODEX_PROBE=1:'), EXEC_CONTRACT.passthrough.probeRelaxed, 'help tier-2 ⟷ manifest probeRelaxed');
  });

  it('--help after the -- separator is passthrough payload, never intercepted', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['-', '--', '--help'], input: 'go' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Usage:/, 'help is keyed on the FIRST argument only');
    assert.match(r.argv, /(^|\n)--help(\n|$)/, 'the payload --help reaches codex argv');
  });
});

describe('codex-exec.sh — source-level reverse guard (parser arms ⟷ manifest)', () => {
  const arms = extractArgCaseArms(readFileSync(WRAPPER, 'utf8'));

  it('the first-arg entrypoints are exactly --help/-h + the manifest resume flags', () => {
    const declared = EXEC_CONTRACT.continue.map(leadingFlag);
    assert.ok(declared.length > 0, 'manifest resume set must be non-empty');
    setEq(new Set(splitArms(arms.get('"${1:-}"'))), new Set(['--help', '-h', ...declared]));
  });

  it('the real passthrough tier arms equal the manifest tiers (git-shim heredoc excluded)', () => {
    const tierArms = arms.get('"$_arg"') ?? [];
    assert.equal(tierArms.length, 2, 'exactly two passthrough tiers: always-blocked, probe-relaxed');
    setEq(tierArms[0].split('|'), EXEC_CONTRACT.passthrough.blocked, 'tier-1 arm ⟷ manifest blocked');
    setEq(tierArms[1].split('|'), EXEC_CONTRACT.passthrough.probeRelaxed, 'tier-2 arm ⟷ manifest probeRelaxed');
  });

  it('the in-test tier samples cover every manifest tier pattern (behavioural forward guard)', () => {
    // ALWAYS_BLOCKED / PROBE_RELAXABLE drive the real behaviour suite above; pin them
    // to the manifest so a tier edit cannot leave the behavioural samples stale.
    const sample = (patterns) => patterns.map((p) => p.replace(/\*$/, ''));
    const covered = (flags, patterns) =>
      sample(patterns).every((p) => flags.some(([f]) => f === p || f.startsWith(p)));
    assert.ok(covered(ALWAYS_BLOCKED, EXEC_CONTRACT.passthrough.blocked), 'every blocked pattern has a behavioural sample');
    assert.ok(covered(PROBE_RELAXABLE, EXEC_CONTRACT.passthrough.probeRelaxed), 'every probe pattern has a behavioural sample');
  });
});
