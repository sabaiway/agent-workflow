import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync,
  existsSync, readdirSync, symlinkSync, cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

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
  'if [[ -n "${CODEX_FAKE_STDERR:-}" ]]; then echo "$CODEX_FAKE_STDERR" >&2; fi',
  ': "${CODEX_FAKE_ARGV:=/dev/null}"',
  ': "${CODEX_FAKE_ENV:=/dev/null}"',
  ': "${CODEX_FAKE_STDIN:=/dev/null}"',
  '{ for a in "$@"; do echo "$a"; done; } >"$CODEX_FAKE_ARGV"',
  '{ echo "HOME=${HOME:-}"; echo "CODEX_HOME=${CODEX_HOME:-}"; echo "XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-}"; echo "OPENAI_API_KEY=${OPENAI_API_KEY:-<unset>}"; echo "OPENAI_BASE_URL=${OPENAI_BASE_URL:-<unset>}"; echo "FOO_API_KEY=${FOO_API_KEY:-<unset>}"; echo "CODEX_REAL_GIT=${CODEX_REAL_GIT:-<unset>}"; } >"$CODEX_FAKE_ENV"',
  'cat >"$CODEX_FAKE_STDIN"',
  'if [[ "${CODEX_FAKE_GIT_PROBE:-}" == "1" ]]; then { echo "realgit_env=${CODEX_REAL_GIT:-unset}"; echo "status=$(git status --short >/dev/null 2>&1; echo $?)"; echo "diff=$(git --no-pager diff >/dev/null 2>&1; echo $?)"; echo "dashC_read=$(git -C . status --short >/dev/null 2>&1; echo $?)"; echo "dashc_read=$(git -c core.pager=cat status --short >/dev/null 2>&1; echo $?)"; echo "bare=$(git >/dev/null 2>&1; echo $?)"; echo "commit=$(git commit -m x >/dev/null 2>&1; echo $?)"; echo "add=$(git add -A >/dev/null 2>&1; echo $?)"; echo "checkout=$(git checkout -- . >/dev/null 2>&1; echo $?)"; echo "unknown=$(git frobnicate >/dev/null 2>&1; echo $?)"; echo "config_read=$(git config user.name >/dev/null 2>&1; echo $?)"; echo "config_list=$(git config --list >/dev/null 2>&1; echo $?)"; echo "config_bare=$(git config >/dev/null 2>&1; echo $?)"; echo "config_write=$(git config user.name HACKED >/dev/null 2>&1; echo $?)"; echo "config_bypass=$(git config --get --add a.b v >/dev/null 2>&1; echo $?)"; echo "symref_write=$(git symbolic-ref HEAD refs/heads/x >/dev/null 2>&1; echo $?)"; echo "reflog_write=$(git reflog expire --all >/dev/null 2>&1; echo $?)"; echo "cdaway=$(cd / && git --version >/dev/null 2>&1; echo $?)"; } > "${CODEX_FAKE_GIT_RESULT:-/dev/null}" 2>&1; fi',
  // Delegation seams: the fake runs BETWEEN the pre-spend reservation and the terminal publication,
  // which is the only moment a fixture can disturb either. TAMPER forges a foreign owner into the
  // reservation; MKDIR plants a directory where an artifact must land; RO_DIR turns the store
  // directory read-only. Each is inert when its variable is unset.
  'if [[ -n "${CODEX_FAKE_TAMPER:-}" ]]; then',
  '  cat >"$CODEX_FAKE_TAMPER" <<EOF',
  '{"schema":1,"kind":"exec-receipt","state":"reserved","backend":"codex","nonce":"${CODEX_FAKE_TAMPER_NONCE:-n1}","owner":"a-foreign-run","contractDigest":"${CODEX_FAKE_TAMPER_DIGEST:-0000000000000000000000000000000000000000000000000000000000000000}","wrapperVersion":"0.0.0","posture":{"model":"m","effort":"e","tier":null},"capS":1,"killGraceS":0,"sessionId":null,"exitStatus":null,"outcome":null,"reportDigest":null,"reportLength":null,"timestamp":"2026-01-01T00:00:00.000Z"}',
  'EOF',
  'fi',
  'if [[ -n "${CODEX_FAKE_MKDIR:-}" ]]; then mkdir -p "$CODEX_FAKE_MKDIR"; fi',
  'if [[ -n "${CODEX_FAKE_RO_DIR:-}" ]]; then chmod 500 "$CODEX_FAKE_RO_DIR"; fi',
  // SNAPSHOT copies a file WHILE the CLI runs — the only way to observe what existed mid-flight.
  // ABSENT is written rather than nothing, so "the file was not there" and "the seam never fired"
  // stay distinguishable.
  'if [[ -n "${CODEX_FAKE_SNAPSHOT_SRC:-}" ]]; then cp "$CODEX_FAKE_SNAPSHOT_SRC" "$CODEX_FAKE_SNAPSHOT_DST" || echo ABSENT >"$CODEX_FAKE_SNAPSHOT_DST"; fi',
  'if [[ -n "${CODEX_FAKE_SLEEP:-}" ]]; then sleep "${CODEX_FAKE_SLEEP}"; fi',
  'out=""',
  'prev=""',
  'for a in "$@"; do',
  '  if [[ "$prev" == "-o" || "$prev" == "--output-last-message" ]]; then out="$a"; fi',
  '  prev="$a"',
  'done',
  'if [[ -n "$out" ]]; then',
  // EMPTY_OUT creates the capture file and writes NOTHING into it — the case that must stay
  // distinguishable from NO_OUT, where the file is never created at all.
  '  if [[ "${CODEX_FAKE_EMPTY_OUT:-}" == "1" ]]; then : >"$out"; elif [[ "${CODEX_FAKE_NO_OUT:-}" != "1" ]]; then echo "${CODEX_FAKE_FINAL:-FAKE_FINAL_MESSAGE}" >"$out"; fi',
  '  if [[ "${CODEX_FAKE_NO_THREAD:-}" != "1" ]]; then',
  '  cat <<EOF',
  '{"type":"thread.started","thread_id":"${CODEX_FAKE_THREAD_ID:-fake-thread-123}"}',
  'EOF',
  '  fi',
  '  cat <<EOF',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"FAKE_FINAL_MESSAGE"}}',
  'EOF',
  // The event seam: verbatim extra stream lines (JSONL items, plain noise, or both) between the
  // opening events and turn.completed — a multi-line value emits multiple lines.
  '  if [[ -n "${CODEX_FAKE_EVENT:-}" ]]; then echo "$CODEX_FAKE_EVENT"; fi',
  // A file-borne twin: a payload too large for the environment (E2BIG) still has to be emittable.
  '  if [[ -n "${CODEX_FAKE_EVENT_FILE:-}" ]]; then cat "$CODEX_FAKE_EVENT_FILE"; fi',
  '  cat <<EOF',
  '{"type":"turn.completed","usage":{}}',
  'EOF',
  'else',
  '  echo "${CODEX_FAKE_FINAL:-FAKE_FINAL_MESSAGE}"',
  'fi',
  'exit "${CODEX_FAKE_EXIT:-0}"',
  '',
].join('\n');

// The sandbox base and the PATH farms are READ-ONLY per invocation, so both are built ONCE and
// shared (a per-test `git init`+commit and a per-call farm rebuild dominate the wall otherwise).
const SHARED_ROOT = mkdtempSync(join(tmpdir(), 'codex-exec-shared-'));
after(() => rmSync(SHARED_ROOT, { recursive: true, force: true }));

const TEMPLATE_ROOT = (() => {
  const root = join(SHARED_ROOT, 'template-root');
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'codex'), FAKE_CODEX, { mode: 0o755 });
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
  return root;
})();

const makeSandbox = () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-exec-test-'));
  cpSync(TEMPLATE_ROOT, root, { recursive: true });
  const bin = join(root, 'bin');
  chmodSync(join(bin, 'codex'), 0o755);
  return { root, bin, repo: join(root, 'repo') };
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

const farms = new Map();
const farmFor = (exclude) => {
  const key = exclude.join('|');
  if (!farms.has(key)) farms.set(key, makePathWithout(SHARED_ROOT, exclude));
  return farms.get(key);
};

// ASYNCHRONOUS on purpose: a blocking dispatch holds the event loop for its whole duration, which
// is what used to pin this file to one core while the rest of the machine idled. Awaiting the child
// lets a `{ concurrency }` describe overlap its tests. Per-test environment rides the CHILD's
// options — `process.env` is never mutated, so overlapping tests cannot read each other's PATH.
const run = ({ repo, bin }, { args = ['-'], input = 'do the thing', env = {}, path, cwd, timeout = 30000 } = {}) => new Promise((settle) => {
  const argvFile = join(repo, '.cap-argv');
  const envFile = join(repo, '.cap-env');
  const stdinFile = join(repo, '.cap-stdin');
  const child = execFile('bash', [WRAPPER, ...args], {
    cwd: cwd || repo,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      PATH: path || `${bin}:${process.env.PATH}`,
      HOME: repo,
      // Keep the wrapper's mktemp working when the suite runs inside an OS sandbox whose /tmp is
      // read-only (only $TMPDIR is writable there).
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      CODEX_FAKE_ARGV: argvFile,
      CODEX_FAKE_ENV: envFile,
      CODEX_FAKE_STDIN: stdinFile,
      ...env,
    },
  }, (error, stdout, stderr) => {
    const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
    settle({
      status: error ? (error.code ?? 1) : 0, signal: error?.signal ?? null, stdout, stderr,
      argv: readIf(argvFile), capEnv: readIf(envFile), capStdin: readIf(stdinFile),
    });
  });
  // The wrapper refuses many inputs BEFORE it reads stdin, so the pipe can already be closed when
  // the prompt is written. The blocking spawn swallowed that; an async one throws EPIPE at the
  // test. A closed pipe is the refusal working — but ONLY EPIPE is: any other write failure is a
  // real fault and must reach the test instead of passing as a green.
  child.stdin.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
  child.stdin.end(input);
});

// runAsync was the async twin kept for the sleep-bound timeout tests, back when run() blocked.
// run() IS that twin now, so the twin is one name pointing at it — two spawn paths could only drift.
const runAsync = run;

describe('codex-exec.sh — quality-first model/effort guard (1.1)', { concurrency: 2 }, () => {
  it('refuses a non-default CODEX_MODEL and never spends a run', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { env: { CODEX_MODEL: 'gpt-5.4-mini' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not the pinned model/);
    assert.equal(r.capStdin, '', 'codex must not be invoked when the guard fires');
  });

  it('refuses a non-default CODEX_EFFORT', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { env: { CODEX_EFFORT: 'high' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not the pinned max effort/);
  });

  it('CODEX_PROBE=1 allows a non-default model and warns loudly', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { env: { CODEX_PROBE: '1', CODEX_MODEL: 'gpt-5.4-mini' } });
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

describe('codex-exec.sh — passthrough guard, two tiers (1.1)', { concurrency: 2 }, () => {
  for (const flag of ALWAYS_BLOCKED) {
    it(`always rejects ${flag[0]} (no probe)`, async () => {
      const sb = makeSandbox();
      const r = await run(sb, { args: ['-', '--', ...flag] });
      rmSync(sb.root, { recursive: true, force: true });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /is not allowed/);
    });
    it(`still rejects ${flag[0]} even under CODEX_PROBE=1`, async () => {
      const sb = makeSandbox();
      const r = await run(sb, { args: ['-', '--', ...flag], env: { CODEX_PROBE: '1' } });
      rmSync(sb.root, { recursive: true, force: true });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /blocked even under CODEX_PROBE=1/);
    });
  }

  for (const flag of PROBE_RELAXABLE) {
    it(`rejects ${flag[0]} for a real run (no probe)`, async () => {
      const sb = makeSandbox();
      const r = await run(sb, { args: ['-', '--', ...flag] });
      rmSync(sb.root, { recursive: true, force: true });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /is not allowed/);
    });
  }

  it('CODEX_PROBE=1 lets a context flag (--add-dir) through and warns', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['-', '--', '--add-dir', '/x'], env: { CODEX_PROBE: '1' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.argv, /--add-dir/);
    assert.match(r.stderr, /THROWAWAY PROBE MODE/);
  });
});

describe('codex-exec.sh — subscription / config isolation (invariant)', { concurrency: 2 }, () => {
  it('clears every *_API_KEY + OPENAI_BASE_URL and passes --ignore-user-config', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { env: {
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

describe('codex-exec.sh — clean output + session capture (1.2)', { concurrency: 2 }, () => {
  it('prints ONLY the final message, not the JSON event stream', async () => {
    const sb = makeSandbox();
    const r = await run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /FAKE_FINAL_MESSAGE/);
    assert.doesNotMatch(r.stdout, /thread\.started/, 'the JSON trace must not leak to stdout');
  });

  it('passes the clean-capture flags to codex', async () => {
    const sb = makeSandbox();
    const r = await run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    for (const f of [/(^|\n)-o(\n|$)/, /(^|\n)--json(\n|$)/, /(^|\n)--color(\n|$)/,
      /hide_agent_reasoning=true/, /model_reasoning_summary=none/]) {
      assert.match(r.argv, f, `expected ${f} among codex argv`);
    }
  });

  it('captures the session id to the default sidecar and stderr', async () => {
    const sb = makeSandbox();
    const r = await run(sb);
    const sidecar = join(sb.repo, '.codex-last-session');
    const got = existsSync(sidecar) ? readFileSync(sidecar, 'utf8').trim() : '';
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(got, 'fake-thread-123');
    assert.match(r.stderr, /session: fake-thread-123/);
  });

  it('honours CODEX_SESSION_FILE and leaves the default sidecar untouched', async () => {
    const sb = makeSandbox();
    const custom = join(sb.repo, 'my-session');
    await run(sb, { env: { CODEX_SESSION_FILE: custom } });
    const customGot = existsSync(custom) ? readFileSync(custom, 'utf8').trim() : '';
    const defaultWritten = existsSync(join(sb.repo, '.codex-last-session'));
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(customGot, 'fake-thread-123');
    assert.equal(defaultWritten, false, 'the default sidecar must not be written when CODEX_SESSION_FILE is set');
  });

  it('falls back to the trace tail when the final-message file is missing', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { env: { CODEX_FAKE_NO_OUT: '1' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /no final-message file/);
    assert.match(r.stdout, /turn\.completed/, 'the trace tail should carry the event stream');
  });

  it('on a codex failure, prints the trace tail to stderr and exits codex code', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { env: { CODEX_FAKE_EXIT: '7' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 7);
    assert.match(r.stderr, /codex exec failed \(exit 7\)/);
    assert.match(r.stderr, /thread\.started/, 'failure should surface the trace tail');
    assert.doesNotMatch(r.stderr, /NESTED-SANDBOX/, 'a plain failure (no bwrap signature) never triggers the hint');
  });

  it('on a NESTED-SANDBOX failure (bwrap/read-only trace) surfaces the stated recovery hint', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { env: { CODEX_FAKE_EXIT: '1', CODEX_FAKE_STDERR: 'bwrap: setting up sandbox: mkdir /newroot: Read-only file system' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /NESTED-SANDBOX/, 'names the failure class');
    assert.match(r.stderr, /excludedCommands|per-run consented bypass/, 'states the recovery route');
    assert.match(r.stderr, /Do NOT blanket-disable/, 'warns against a preemptive blanket');
  });

  it('a NON-nested codex failure does NOT emit the nested-sandbox hint (no false positive)', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { env: { CODEX_FAKE_EXIT: '3', CODEX_FAKE_STDERR: 'model error: rate limited, try again later' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 3);
    assert.doesNotMatch(r.stderr, /NESTED-SANDBOX/, 'a generic failure never triggers the hint');
  });

  it('#6 fold: a mechanism+failure trace whose message contains the letter n (mkdir /newroot) still fires — the old [^\\n]* wrongly excluded n', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { env: { CODEX_FAKE_EXIT: '1', CODEX_FAKE_STDERR: 'bwrap: mkdir /newroot: operation not permitted' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /NESTED-SANDBOX/, 'bwrap (mechanism) + operation not permitted (failure) fire even through n-bearing words');
  });

  it('#6 fold: a LONE mechanism token (a bwrap banner, no failure) does NOT fire — a combination is required', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { env: { CODEX_FAKE_EXIT: '2', CODEX_FAKE_STDERR: 'bwrap version 0.11.0' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.doesNotMatch(r.stderr, /NESTED-SANDBOX/, 'a mechanism token without a permission/read-only failure is not nested-sandbox proof');
  });

  it('#6 fold: a LONE failure token (permission denied, no sandbox mechanism) does NOT fire', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { env: { CODEX_FAKE_EXIT: '2', CODEX_FAKE_STDERR: 'curl: (7) permission denied' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.doesNotMatch(r.stderr, /NESTED-SANDBOX/, 'a permission failure from unrelated code is not nested-sandbox proof');
  });

  // ── the rc == 0 arm: the SURVIVED nested-sandbox failure ──
  // The class the failed-run arm cannot see: the backend hits the nested sandbox, degrades to "I
  // cannot check", and exits 0 — a paid run spent on an ungrounded answer with nothing saying so.
  // Both serialized shapes below were observed on the INSTALLED codex-cli 0.147.0: a finished item
  // carries {"exit_code":2,"status":"failed"}, an in-flight one {"exit_code":null,"status":"in_progress"}.
  const cmdItem = ({ command = '/bin/bash -lc probe', output = '', exitCode = null, status = 'completed', id = 'item_1' }) =>
    JSON.stringify({ type: 'item.completed', item: { id, type: 'command_execution', command, aggregated_output: output, exit_code: exitCode, status } });
  const MECHANISM = 'bwrap: setting up sandbox';
  const FAILURE = 'mkdir /newroot: Read-only file system';
  const SIGNATURE = `${MECHANISM}: ${FAILURE}\n`;

  it('an rc == 0 run whose trace carries a command_execution with a NONZERO exit_code and the signature warns loudly and still prints the answer', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { env: { CODEX_FAKE_EVENT: cmdItem({ output: SIGNATURE, exitCode: 1, status: 'completed' }) } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, 'the warning lane never changes the exit status');
    assert.match(r.stdout, /FAKE_FINAL_MESSAGE/, 'the answer is printed FIRST, on stdout, unchanged');
    assert.match(r.stderr, /NESTED-SANDBOX/, 'names the class');
    assert.match(r.stderr, /UNGROUNDED/, 'names the consequence for the answer above');
    assert.match(r.stderr, /excludedCommands|per-run consented bypass/, 'names the reroute');
  });

  it('an rc == 0 run whose trace carries a command_execution with a null exit_code and an explicitly FAILED status warns', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { env: { CODEX_FAKE_EVENT: cmdItem({ output: SIGNATURE, exitCode: null, status: 'failed' }) } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /NESTED-SANDBOX/, 'the serialized failed status is the second failure proof');
  });

  it('plain non-JSON stderr lines before and after a matching failed command_execution do not suppress the warning', async () => {
    const sb = makeSandbox();
    const r = await run(sb, {
      env: {
        CODEX_FAKE_STDERR: 'ERROR codex_core::session: failed to load skill /x/SKILL.md: missing field description',
        CODEX_FAKE_EVENT: `not json at all\n${cmdItem({ output: SIGNATURE, exitCode: 2, status: 'failed' })}\nstill not json`,
      },
    });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /NESTED-SANDBOX/, 'the merged stream is judged line by line — noise is not evidence and never a stop');
  });

  it('the resume lane warns on an rc == 0 nested-sandbox signature — the lane the incident fired on', async () => {
    const sb = makeSandbox();
    const r = await run(sb, {
      args: ['--resume', 'sess-nested', '-'], input: 'continue',
      env: { CODEX_FAKE_EVENT: cmdItem({ output: SIGNATURE, exitCode: 1, status: 'failed' }) },
    });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /FAKE_FINAL_MESSAGE/);
    assert.match(r.stderr, /NESTED-SANDBOX/, 'the whole point of unifying the capture');
  });

  it('an rc == 0 run with a clean trace warns nothing', async () => {
    const sb = makeSandbox();
    const r = await run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /NESTED-SANDBOX/, 'a clean run must stay silent');
  });

  it('a lone mechanism token and a lone failure token each warn nothing on the rc == 0 lane', async () => {
    for (const output of [`${MECHANISM} version 0.11.0\n`, `curl: (7) ${FAILURE}\n`]) {
      const sb = makeSandbox();
      const r = await run(sb, { env: { CODEX_FAKE_EVENT: cmdItem({ output, exitCode: 1, status: 'failed' }) } });
      rmSync(sb.root, { recursive: true, force: true });
      assert.doesNotMatch(r.stderr, /NESTED-SANDBOX/, `a lone token class is not proof: ${output}`);
    }
  });

  it('nested-sandbox text appearing ONLY inside an agent_message item never warns', async () => {
    const sb = makeSandbox();
    const event = JSON.stringify({ type: 'item.completed', item: { id: 'item_9', type: 'agent_message', text: `I hit ${SIGNATURE}` } });
    const r = await run(sb, { env: { CODEX_FAKE_EVENT: event } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.doesNotMatch(r.stderr, /NESTED-SANDBOX/, 'the model TALKING about a sandbox is not a failed tool call');
  });

  it('a SUCCESSFUL command_execution whose output merely QUOTES both tokens never warns', async () => {
    const sb = makeSandbox();
    // The concrete false positive: codex-exec.sh itself carries both token classes, so any
    // successful grep over it would trip a loose whole-trace rule.
    const r = await run(sb, {
      env: { CODEX_FAKE_EVENT: cmdItem({ command: '/bin/bash -lc grep -n bwrap codex-exec.sh', output: SIGNATURE, exitCode: 0, status: 'completed' }) },
    });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /NESTED-SANDBOX/, 'a command that SUCCEEDED proves nothing failed');
  });

  it('a command_execution with a null exit_code and no proven failed status never warns', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { env: { CODEX_FAKE_EVENT: cmdItem({ output: SIGNATURE, exitCode: null, status: 'in_progress' }) } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.doesNotMatch(r.stderr, /NESTED-SANDBOX/, 'a null exit_code is never failure by itself');
  });

  it('tokens split across two different items never warn', async () => {
    const sb = makeSandbox();
    const split = [
      cmdItem({ id: 'item_1', output: `${MECHANISM} version 0.11.0\n`, exitCode: 1, status: 'failed' }),
      cmdItem({ id: 'item_2', output: `curl: (7) ${FAILURE}\n`, exitCode: 1, status: 'failed' }),
    ].join('\n');
    const r = await run(sb, { env: { CODEX_FAKE_EVENT: split } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.doesNotMatch(r.stderr, /NESTED-SANDBOX/, 'the combination must sit in ONE item — two failures are not one nested sandbox');
  });

  // ── object membership, not substring co-occurrence ──
  // Testing the four fields independently is not enough: position in the line is not membership in
  // the item. The scan walks ONE contiguous chain of raw delimiters instead, and every gap in that
  // chain is inside a JSON string, where a quote is escaped and cannot forge the next delimiter.
  it('a decoy object carrying the type, with the failure fields on a DIFFERENT item, never warns', async () => {
    const sb = makeSandbox();
    const decoy = '{"type":"item.completed","decoy":{"type":"command_execution"},"item":{"type":"agent_message","aggregated_output":"bwrap: operation not permitted","exit_code":0,"status":"failed"}}';
    const r = await run(sb, { env: { CODEX_FAKE_EVENT: decoy } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /NESTED-SANDBOX/, 'the type belongs to the decoy; the failure fields belong to an agent_message');
  });

  it('a decoy carrying BOTH the type and a command, with the failure fields on a DIFFERENT item, never warns', async () => {
    const sb = makeSandbox();
    // Anchoring on a longer literal is not enough: the skip between fields must itself be PROVEN to
    // be one JSON string's content, or the walk leaves the decoy's command and lands in the
    // agent_message's fields.
    const decoy = '{"type":"item.completed","decoy":{"type":"command_execution","command":"x"},"item":{"type":"agent_message","aggregated_output":"bwrap: setting up sandbox: operation not permitted","exit_code":1,"status":"failed"}}';
    const r = await run(sb, { env: { CODEX_FAKE_EVENT: decoy } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /NESTED-SANDBOX/, 'an unvalidated gap lets the walk cross an object boundary');
  });

  it('a genuinely failed item with a ~200KB aggregated_output still warns — and the scan does not hang', async () => {
    const sb = makeSandbox();
    // Two edges at once: the signature sits FIRST, so any early-exit consumer must not lose it, and
    // the field is far larger than a pipe buffer. It also pins the cost: the quadratic bash string
    // spellings of this walk hang the wrapper outright at this size.
    const big = `${SIGNATURE}${'x'.repeat(200000)}`;
    // The payload rides a FILE: 200KB in the environment is E2BIG on a normal host.
    const payload = join(sb.repo, 'big-event.jsonl');
    writeFileSync(payload, `${cmdItem({ output: big, exitCode: 1, status: 'failed' })}\n`);
    // "does not hang" needs a NUMBER or it cannot fail: a shortest-match `#*` cut to the exit_code
    // delimiter costs 17s here (measured), a linear pass costs milliseconds. The cap sits between.
    const r = await run(sb, { env: { CODEX_FAKE_EVENT_FILE: payload }, timeout: 8000 });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /NESTED-SANDBOX/, 'a large output must not silently drop a real signature');
  });

  it('a plain non-JSON log line carrying the same substrings never warns', async () => {
    const sb = makeSandbox();
    const lookalike = `ERROR codex_core: replaying "type":"command_execution","command":"x","aggregated_output":"${SIGNATURE.trim()}","exit_code":1,"status":"failed"`;
    const r = await run(sb, { env: { CODEX_FAKE_EVENT: lookalike } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.doesNotMatch(r.stderr, /NESTED-SANDBOX/, 'prose ABOUT an event is not an event — an event line starts with {');
  });

  it('a FOREIGN "status":"failed" elsewhere on the line never proves a SUCCESSFUL item failed', async () => {
    const sb = makeSandbox();
    const event = `${cmdItem({ output: SIGNATURE, exitCode: 0, status: 'completed' })}{"type":"turn.failed","status":"failed"}`;
    const r = await run(sb, { env: { CODEX_FAKE_EVENT: event } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.doesNotMatch(r.stderr, /NESTED-SANDBOX/, 'the failed status must sit immediately after THIS item exit_code');
  });

  it('an escaped delimiter inside aggregated_output never fools the slice', async () => {
    const sb = makeSandbox();
    const r = await run(sb, {
      env: { CODEX_FAKE_EVENT: cmdItem({ output: `${SIGNATURE}","exit_code":1,"status":"failed"`, exitCode: 0, status: 'completed' }) },
    });
    rmSync(sb.root, { recursive: true, force: true });
    assert.doesNotMatch(r.stderr, /NESTED-SANDBOX/, 'a quote inside a JSON string is escaped, so the raw delimiter cannot occur there');
  });

  it('only the FIRST command_execution item of a line is judged — a second item on the same line is missed (a STATED false negative)', async () => {
    const sb = makeSandbox();
    const glued = `${cmdItem({ id: 'item_1', output: 'all good\n', exitCode: 0, status: 'completed' })}${cmdItem({ id: 'item_2', output: SIGNATURE, exitCode: 1, status: 'failed' })}`;
    const r = await run(sb, { env: { CODEX_FAKE_EVENT: glued } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.doesNotMatch(r.stderr, /NESTED-SANDBOX/, 'under-firing is the deliberate direction on a warning lane; this pins it so it cannot change silently');
  });

  it('a trace of plain non-JSON lines alone carrying both tokens never warns on the rc == 0 arm — while the FAILED arm warns on exactly those bytes', async () => {
    const bytes = `${MECHANISM}: ${FAILURE}`;
    const clean = makeSandbox();
    const ok = await run(clean, { env: { CODEX_FAKE_STDERR: bytes } });
    rmSync(clean.root, { recursive: true, force: true });
    assert.equal(ok.status, 0, ok.stderr);
    assert.doesNotMatch(ok.stderr, /NESTED-SANDBOX/, 'on a COMPLETED run only per-item evidence speaks');
    const failed = makeSandbox();
    const bad = await run(failed, { env: { CODEX_FAKE_STDERR: bytes, CODEX_FAKE_EXIT: '1' } });
    rmSync(failed.root, { recursive: true, force: true });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /NESTED-SANDBOX/, 'the failed-run arm keeps its loose whole-trace rule — that is what makes the dual policy visible');
  });

  it('warns (never silently) when the session sidecar cannot be written', async () => {
    const sb = makeSandbox();
    const blocker = join(sb.repo, 'blocker');
    writeFileSync(blocker, 'x');                  // a regular file …
    const bad = join(blocker, 'session');         // … so this path is unwritable (ENOTDIR)
    const r = await run(sb, { env: { CODEX_SESSION_FILE: bad } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /could not write the session sidecar/);
    assert.match(r.stderr, /session: fake-thread-123/, 'the id must still reach stderr');
  });
});

describe('codex-exec.sh — leaner prompt (1.4)', { concurrency: 2 }, () => {
  it('directive obeys AGENTS.md from context without a read-AGENTS action', async () => {
    const sb = makeSandbox();
    const r = await run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.match(r.capStdin, /Obey EVERY Hard Constraint declared in the project's root AGENTS\.md \(already/);
    assert.doesNotMatch(r.capStdin, /Read the target project's root AGENTS\.md/);
    assert.match(r.capStdin, /do the thing/, 'the task must be appended to the directive');
  });
});

describe('codex-exec.sh — hard timeout (1.3)', { concurrency: 2 }, () => {
  it('kills a hung codex at CODEX_HARD_TIMEOUT and reports it', async () => {
    const sb = makeSandbox();
    const started = Date.now();
    const r = await runAsync(sb, { env: { CODEX_FAKE_SLEEP: '30', CODEX_HARD_TIMEOUT: '2' } });
    const elapsed = Date.now() - started;
    rmSync(sb.root, { recursive: true, force: true });
    assert.ok(elapsed < 18000, `must return well under the kill-after window, took ${elapsed}ms`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /exceeded the hard cap/);
  });

  it('warns and runs uncapped when neither timeout nor gtimeout is on PATH', async () => {
    const sb = makeSandbox();
    const path = `${sb.bin}:${farmFor(['timeout', 'gtimeout'])}`;
    const r = await run(sb, { path });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /WITHOUT a hard wall-clock cap/);
    assert.match(r.stdout, /FAKE_FINAL_MESSAGE/);
  });

  it('resume runs uncapped (and warns) when no timeout binary is on PATH', async () => {
    const sb = makeSandbox();
    const path = `${sb.bin}:${farmFor(['timeout', 'gtimeout'])}`;
    const r = await run(sb, { args: ['--resume', 'sess-1', '-'], input: 'go', path });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /WITHOUT a hard wall-clock cap/);
    assert.match(r.stdout, /FAKE_FINAL_MESSAGE/);
  });
});

describe('codex-exec.sh — preflight (unchanged invariants)', { concurrency: 2 }, () => {
  it('STOPs when there is no root AGENTS.md', async () => {
    const sb = makeSandbox();
    rmSync(join(sb.repo, 'AGENTS.md'));
    const r = await run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no root AGENTS\.md/);
  });
});

describe('codex-exec.sh — resume entrypoint restates every invariant (3.1)', { concurrency: 2 }, () => {
  const RESUME_INVARIANTS = [
    /(^|\n)resume(\n|$)/, /(^|\n)--ignore-user-config(\n|$)/, /(^|\n)gpt-5\.6-sol(\n|$)/,
    /model_reasoning_effort=xhigh/, /sandbox_mode=workspace-write/,
    /approval_policy=never/, /sandbox_workspace_write\.network_access=false/,
  ];

  // `codex exec resume` accepts a NARROWER flag set than `codex exec`, and the difference is not
  // guessable: the hermetic fake accepts any argv, so a flag the real CLI rejects passes every unit
  // test and then fails pre-spend on the first live resume. That happened — `--color never` was
  // added to this lane unprobed and broke it outright. This list is transcribed from
  // `codex exec resume --help` on codex-cli 0.147.0 (probed 2026-08-08); anything the wrapper sends
  // that is not on it fails HERE instead of in front of a user.
  const RESUME_ACCEPTED_FLAGS = new Set([
    '--last', '--all', '-c', '--config', '--enable', '-i', '--image', '--strict-config', '--disable',
    '-m', '--model', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust',
    '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--output-schema', '--json', '-o', '--output-last-message', '-h', '--help',
  ]);

  it('every flag the resume lane sends is one the REAL `codex exec resume` accepts', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['--resume', 'sess-flags', '-'], input: 'go' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    const sent = r.argv.split('\n').filter((a) => a.startsWith('-') && a !== '-');
    assert.ok(sent.length > 0, 'the resume argv must carry flags at all');
    for (const flag of sent) {
      assert.ok(RESUME_ACCEPTED_FLAGS.has(flag),
        `resume sends ${flag}, which \`codex exec resume --help\` does not list — it would exit 2 pre-spend`);
    }
    assert.equal(sent.includes('--color'), false, 'the regression this list exists to prevent');
  });

  it('--resume <id>: composes `exec resume <id>` with the full restated policy', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['--resume', 'sess-xyz', '-'], input: 'continue please' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.argv, /(^|\n)sess-xyz(\n|$)/, 'the session id is passed positionally');
    for (const inv of RESUME_INVARIANTS) assert.match(r.argv, inv, `resume argv must include ${inv}`);
    assert.match(r.stdout, /FAKE_FINAL_MESSAGE/, 'resume prints the final message');
  });

  // The capture unification: resume used to be the odd mode out — no -o, no --json, its event
  // stream nowhere — which is precisely why the lane the nested-sandbox incident fired on had no
  // evidence surface. `codex exec resume` accepts both (live-probed, codex-cli 0.147.0).
  it('resume composes the unified capture — -o and --json, and NOT --color (which it rejects)', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['--resume', 'sess-unified', '-'], input: 'continue please' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.argv, /(^|\n)-o(\n|$)/, 'resume writes the final message through -o');
    assert.match(r.argv, /(^|\n)--json(\n|$)/, 'resume streams the structured events');
    // The evidence surface is shared with a fresh run; the COLOUR flag is not, because
    // `codex exec resume` does not accept it. Sending it exits 2 before the run starts.
    assert.equal(/(^|\n)--color(\n|$)/.test(r.argv), false, 'resume rejects --color — probed on codex-cli 0.147.0');
    assert.match(r.stdout, /FAKE_FINAL_MESSAGE/, 'resume stdout is still the final message');
  });

  it('resume falls back to the trace tail when the final-message file is missing', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['--resume', 'sess-noout', '-'], input: 'go', env: { CODEX_FAKE_NO_OUT: '1' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /no final-message file/, 'the fallback is loud, never silent');
    assert.match(r.stdout, /turn\.completed/, 'the trace tail carries the event stream resume now captures');
  });

  it('--resume-last reads the session id from the sidecar', async () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, '.codex-last-session'), 'sess-from-sidecar\n');
    const r = await run(sb, { args: ['--resume-last', '-'], input: 'continue' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.argv, /(^|\n)sess-from-sidecar(\n|$)/);
  });

  it('--resume-last honours CODEX_SESSION_FILE', async () => {
    const sb = makeSandbox();
    const custom = join(sb.repo, 'mysess');
    writeFileSync(custom, 'sess-custom\n');
    const r = await run(sb, { args: ['--resume-last', '-'], input: 'go', env: { CODEX_SESSION_FILE: custom } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.match(r.argv, /(^|\n)sess-custom(\n|$)/);
  });

  it('--resume-last with no sidecar STOPs (never guesses)', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['--resume-last', '-'], input: 'go' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no session sidecar/);
  });

  it('--resume with no id STOPs', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['--resume', '-'], input: 'go' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--resume needs a <session-id>/);
  });

  it('rejects an empty resumed instruction', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['--resume', 'sess-1', '-'], input: '   \n' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /empty resumed/);
  });

  it('resume takes no passthrough flags', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['--resume', 'sess-1', '-', '--', '--add-dir', '/x'], input: 'go' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /resume modes take no extra flags/);
  });

  it('resume never sets --ephemeral', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['--resume', 'sess-1', '-'], input: 'go' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.doesNotMatch(r.argv, /--ephemeral/);
  });

  it('--resume-last with an EMPTY sidecar STOPs (no blank id)', async () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, '.codex-last-session'), '   \n');
    const r = await run(sb, { args: ['--resume-last', '-'], input: 'go' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /sidecar.*is empty/);
  });

  it('resume still clears every *_API_KEY/OPENAI_BASE_URL and keeps --ignore-user-config', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['--resume', 'sess-1', '-'], input: 'go', env: {
      OPENAI_API_KEY: 'sk-x', OPENAI_BASE_URL: 'http://evil.example', FOO_API_KEY: 'bar',
    } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.capEnv, /^OPENAI_API_KEY=<unset>$/m);
    assert.match(r.capEnv, /^OPENAI_BASE_URL=<unset>$/m);
    assert.match(r.capEnv, /^FOO_API_KEY=<unset>$/m);
    assert.match(r.argv, /(^|\n)--ignore-user-config(\n|$)/);
  });

  it('resume keeps the FULL restated policy plus the tier when set (2.3.0)', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['--resume', 'sess-1', '-'], input: 'go', env: { CODEX_SERVICE_TIER: 'priority' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    for (const inv of RESUME_INVARIANTS) assert.match(r.argv, inv, `resume argv must include ${inv}`);
    assert.match(r.argv, /(^|\n)service_tier=priority(\n|$)/, 'a resume must not silently drop the tier');
  });

  it('resume without the tier carries no service_tier flag (2.3.0)', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['--resume', 'sess-1', '-'], input: 'go' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.argv, /service_tier/);
  });
});

describe('codex-exec.sh — enforced git-write boundary shim (3.2)', { concurrency: 2 }, () => {
  it('passes read-only verbs, blocks writes/unknown/config-writes; no env bypass', async () => {
    const sb = makeSandbox();
    const result = join(sb.repo, 'git-probe-result');
    const r = await run(sb, { env: { CODEX_FAKE_GIT_PROBE: '1', CODEX_FAKE_GIT_RESULT: result } });
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

  it('the codex env carries no CODEX_REAL_GIT (bypass vector closed)', async () => {
    const sb = makeSandbox();
    const r = await run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.match(r.capEnv, /^CODEX_REAL_GIT=<unset>$/m);
  });
});

describe('codex-exec.sh — environment preflight (fail fast, before a run)', { concurrency: 2 }, () => {
  it('STOPs with 127 when codex is not on PATH', async () => {
    const sb = makeSandbox();
    // PATH WITHOUT the fake codex bin and without any real codex.
    const path = farmFor(['codex']);
    const r = await run(sb, { path });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 127);
    assert.match(r.stderr, /'codex'.*not found on PATH/);
    assert.equal(r.capStdin, '', 'codex must never be invoked');
  });

  it('STOPs with 127 when git is not on PATH', async () => {
    const sb = makeSandbox();
    // codex present (sb.bin) but git stripped — exercises the type -P git guard.
    const path = `${sb.bin}:${farmFor(['git'])}`;
    const r = await run(sb, { path });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 127);
    assert.match(r.stderr, /'git' not found on PATH/);
  });

  it('STOPs (exit 1) when codex is not on a ChatGPT subscription', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { env: { CODEX_FAKE_LOGIN: 'Logged in using API key' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not on a ChatGPT subscription/);
    assert.equal(r.capStdin, '', 'a wrong login must never spend a run');
  });

  it('STOPs (exit 2) when not inside a git work tree', async () => {
    const sb = makeSandbox();
    const nongit = join(sb.root, 'nongit');
    mkdirSync(nongit, { recursive: true });
    writeFileSync(join(nongit, 'AGENTS.md'), '# AGENTS\n'); // present, but the work-tree check fires first
    const r = await run(sb, { cwd: nongit });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /must run inside a git working tree/);
  });
});

describe('codex-exec.sh — argument & prompt-source dispatch', { concurrency: 2 }, () => {
  it('prints usage and STOPs (exit 2) with no arguments', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: [] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage:/);
  });

  it('STOPs on a stray extra argument without the -- separator', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['-', 'stray'], input: 'go' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unexpected argument 'stray'/);
  });

  it('passes an allowed (non-blocked) passthrough flag through to codex', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['-', '--', '--foobar', 'val'], input: 'go' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.argv, /(^|\n)--foobar(\n|$)/, 'an unguarded flag reaches codex argv');
  });

  it('reads the task from a prompt FILE (not just stdin)', async () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'task.md'), 'PROMPT_FROM_FILE_MARKER\n');
    const r = await run(sb, { args: ['task.md'], input: '' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.capStdin, /PROMPT_FROM_FILE_MARKER/);
  });

  it('STOPs (exit 2) when the prompt path is neither - nor a file', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['no-such-file.md'], input: '' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /'no-such-file\.md' is not a file/);
  });

  it('STOPs on an empty task in normal mode (no "resumed" wording)', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['-'], input: '   \n' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /empty plan\/instruction/);
    assert.doesNotMatch(r.stderr, /resumed/, 'normal mode must not say "resumed"');
  });

  it('--resume-last with no prompt argument STOPs (missing <plan-file>)', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['--resume-last'], input: '' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /missing <plan-file/);
  });
});

describe('codex-exec.sh — session id absent', { concurrency: 2 }, () => {
  it('writes no sidecar and no session line when codex emits no thread id', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { env: { CODEX_FAKE_NO_THREAD: '1' } });
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
  const path = farmFor(['codex', 'agy', 'git']);
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

describe('codex-exec.sh — --help contract (manifest-pinned)', { concurrency: 2 }, () => {
  it('--help and -h exit 0 pre-preflight (no codex, no git, no AGENTS.md)', async () => {
    for (const arg of ['--help', '-h']) {
      const r = runHelp(arg);
      assert.equal(r.status, 0, `${arg}: ${r.stderr}`);
      assert.match(r.stdout, /Usage:/, `${arg} prints the contract to stdout`);
      assert.equal(r.stderr, '', `${arg} prints nothing to stderr`);
    }
  });

  it('Usage set-EQUALS the manifest invocation descriptors (both directions)', async () => {
    const help = runHelp('--help').stdout;
    const got = helpSection(help, 'Usage:').filter((l) => l.startsWith('codex-exec')).map(norm);
    assert.ok(EXEC_CONTRACT.invocations.length > 0, 'manifest invocations must be non-empty');
    setEq(got, EXEC_CONTRACT.invocations.map(norm), 'help Usage ⟷ manifest invocations');
  });

  it('Grounding renders the manifest grounding note verbatim', async () => {
    const help = runHelp('--help').stdout;
    assert.equal(norm(helpSection(help, 'Grounding:').join(' ')), norm(EXEC_CONTRACT.grounding));
  });

  it('Round-2 / resume set-EQUALS the manifest continue descriptors', async () => {
    const help = runHelp('--help').stdout;
    const got = helpSection(help, 'Round-2 / resume:').filter((l) => l.startsWith('codex-exec')).map(norm);
    assert.ok(EXEC_CONTRACT.continue.length > 0, 'manifest continue must be non-empty');
    setEq(got, EXEC_CONTRACT.continue.map(norm), 'help continue ⟷ manifest continue');
  });

  it('the guarded-passthrough TIERS set-EQUAL the manifest tiers (never a flat set)', async () => {
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

  it('Notes renders the manifest contract.notes verbatim (a typed contract key that MUST surface)', async () => {
    const help = runHelp('--help').stdout;
    assert.ok(EXEC_CONTRACT.notes.length > 0, 'manifest notes must be non-empty');
    assert.equal(norm(helpSection(help, 'Notes:').join(' ')), norm(EXEC_CONTRACT.notes.join(' ')));
  });

  it('--help after the -- separator is passthrough payload, never intercepted', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['-', '--', '--help'], input: 'go' });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Usage:/, 'help is keyed on the FIRST argument only');
    assert.match(r.argv, /(^|\n)--help(\n|$)/, 'the payload --help reaches codex argv');
  });
});

describe('codex-exec.sh — source-level reverse guard (parser arms ⟷ manifest)', { concurrency: 2 }, () => {
  const arms = extractArgCaseArms(readFileSync(WRAPPER, 'utf8'));

  it('the first-arg entrypoints are exactly --help/-h + the manifest resume flags', async () => {
    const declared = EXEC_CONTRACT.continue.map(leadingFlag);
    assert.ok(declared.length > 0, 'manifest resume set must be non-empty');
    setEq(new Set(splitArms(arms.get('"${1:-}"'))), new Set(['--help', '-h', ...declared]));
  });

  it('the real passthrough tier arms equal the manifest tiers (git-shim heredoc excluded)', async () => {
    const tierArms = arms.get('"$_arg"') ?? [];
    assert.equal(tierArms.length, 2, 'exactly two passthrough tiers: always-blocked, probe-relaxed');
    setEq(tierArms[0].split('|'), EXEC_CONTRACT.passthrough.blocked, 'tier-1 arm ⟷ manifest blocked');
    setEq(tierArms[1].split('|'), EXEC_CONTRACT.passthrough.probeRelaxed, 'tier-2 arm ⟷ manifest probeRelaxed');
  });

  it('the in-test tier samples cover every manifest tier pattern (behavioural forward guard)', async () => {
    // ALWAYS_BLOCKED / PROBE_RELAXABLE drive the real behaviour suite above; pin them
    // to the manifest so a tier edit cannot leave the behavioural samples stale.
    const sample = (patterns) => patterns.map((p) => p.replace(/\*$/, ''));
    const covered = (flags, patterns) =>
      sample(patterns).every((p) => flags.some(([f]) => f === p || f.startsWith(p)));
    assert.ok(covered(ALWAYS_BLOCKED, EXEC_CONTRACT.passthrough.blocked), 'every blocked pattern has a behavioural sample');
    assert.ok(covered(PROBE_RELAXABLE, EXEC_CONTRACT.passthrough.probeRelaxed), 'every probe pattern has a behavioural sample');
  });
});

// ── mode catalog ⟷ wrapper reality (BRIDGE-MODES-CATALOG) ─────────────────────────
// The kit validator owns the catalog's INTERNAL shape; these arms pin the half only this wrapper's
// source can settle — the execute role's cataloged modes really exist here, every declared contract
// invocation is cataloged, and the env-hook the catalog aims at exec really changes the run.

// The source lines that really EXECUTE: a heredoc body (the --help text) and a comment both carry
// names without carrying logic, so a bare name-grep stays green after the logic is deleted.
const executableLines = (source) => {
  const out = [];
  let heredoc = null;
  for (const raw of source.split('\n')) {
    if (heredoc) {
      if (raw.trim() === heredoc) heredoc = null;
      continue;
    }
    const hd = raw.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (hd) { heredoc = hd[1]; continue; }
    if (raw.trimStart().startsWith('#')) continue;
    out.push(raw);
  }
  return out;
};
const consultsEnv = (source, name) =>
  executableLines(source).some((l) => new RegExp(`\\[\\[[^\\]]*\\$\\{?${name}\\b[^\\]]*(==|!=)`).test(l));
// The optional `@` prefix rides WITH the slot — the catalog declares the whole token a user types.
const SLOT_RE = /@?<[^<>]+>|\[[^[\]]*\]/g;

describe('codex-exec.sh — mode catalog ⟷ wrapper reality (manifest-pinned)', { concurrency: 2 }, () => {
  const source = readFileSync(WRAPPER, 'utf8');
  const catalog = MANIFEST.modeCatalog ?? [];
  const execEntries = catalog.filter((e) => e.role === 'execute');

  it('the execute role is cataloged: one primary plus a continuation per resume flag', async () => {
    const primaries = execEntries.filter((e) => e.kind === 'primary');
    const continuations = execEntries.filter((e) => e.kind === 'continuation');
    assert.equal(primaries.length, 1, 'codex-exec has exactly one primary drive form');
    assert.equal(continuations.length, EXEC_CONTRACT.continue.length, 'one continuation entry per declared resume descriptor');
  });

  it('every execute entry composes BY REFERENCE and every reference resolves', async () => {
    for (const entry of execEntries) {
      assert.ok(
        Array.isArray(entry.invocationRefs) && entry.invocationRefs.length > 0,
        `${entry.key}: a contract-backed entry references at least one contract descriptor`,
      );
      assert.ok(!Object.hasOwn(entry, 'descriptor'), `${entry.key}: a contract-backed entry never restates a literal descriptor`);
      for (const ref of entry.invocationRefs) {
        assert.equal(
          typeof EXEC_CONTRACT[ref.contractField]?.[ref.index], 'string',
          `${entry.key}: ref ${ref.contractField}[${ref.index}] does not resolve into the manifest contract`,
        );
      }
    }
  });

  it('every execute contract invocation is claimed by exactly ONE catalog entry (no uncataloged form)', async () => {
    const claims = execEntries.flatMap((e) => e.invocationRefs.map((r) => `${r.contractField}[${r.index}]`));
    assert.equal(new Set(claims).size, claims.length, 'a contract invocation is claimed at most once');
    const declared = [
      ...EXEC_CONTRACT.invocations.map((_, i) => `invocations[${i}]`),
      ...EXEC_CONTRACT.continue.map((_, i) => `continue[${i}]`),
    ];
    setEq(new Set(claims), declared, 'catalog claims ⟷ declared contract invocations');
  });

  it('every env-hook the catalog aims at an execute mode is a real EXECUTABLE guard, not a mention', async () => {
    const hooks = catalog.filter((e) => e.kind === 'env-hook' && e.parents.some((p) => execEntries.some((x) => x.key === p)));
    assert.ok(hooks.length > 0, 'CODEX_PROBE must be cataloged as an env-hook over codex-exec');
    for (const hook of hooks) {
      assert.ok(
        consultsEnv(source, hook.key),
        `env-hook ${hook.key} is named in the source but never TESTED in an executable condition — a help/comment mention would keep a name-grep green after the logic is deleted`,
      );
    }
  });

  it('the catalog operand slots set-EQUAL the slots its rendered forms really carry (both directions)', async () => {
    for (const entry of execEntries) {
      const forms = entry.invocationRefs.map((r) => EXEC_CONTRACT[r.contractField][r.index]);
      // The DEDUPLICATED UNION over every resolved form: `exec` legitimately spreads its slots across
      // two descriptors, so per-form equality would false-fail a correct catalog.
      const realSlots = new Set(forms.flatMap((f) => f.match(SLOT_RE) ?? []));
      setEq(new Set((entry.operands ?? []).map((o) => o.slot)), realSlots, `${entry.key}: catalog operands ⟷ the slots its forms really carry`);
    }
  });

  it('the catalog claims CODEX_PROBE over the resume modes because the guard really precedes resume parsing', async () => {
    // Verified in source: the quality guard runs BEFORE the resume dispatch, so a resume run is
    // relaxed too — the catalog must say so, and this pins the ORDER the claim rests on.
    const lines = executableLines(source);
    const guardAt = lines.findIndex((l) => /\$\{?CODEX_PROBE/.test(l));
    const resumeAt = lines.findIndex((l) => /^\s*--resume-last\)/.test(l));
    assert.ok(guardAt !== -1 && resumeAt !== -1, 'both the probe guard and the resume arm must exist');
    assert.ok(guardAt < resumeAt, 'the probe guard must precede resume parsing — else the resume parents are a false claim');
    const hook = catalog.find((e) => e.key === 'CODEX_PROBE');
    for (const key of ['exec.resume-last', 'exec.resume']) {
      assert.ok(hook.parents.includes(key), `${key} is relaxed by the hook, so the catalog must declare it a parent`);
    }
  });

  it('CODEX_PROBE really relaxes the guard on EVERY execute parent the catalog claims (behavioural)', async () => {
    // Source ORDER alone is not the claim: a branch bug after resume parsing would keep it green.
    // Drive each claimed parent for real — the guard must stop the dispatch without the hook, and
    // codex must really be reached with it (r.argv is non-empty only on a real invocation).
    const hook = catalog.find((e) => e.key === 'CODEX_PROBE');
    const drive = {
      exec: (sb) => ({ args: ['-'], input: 'do a thing' }),
      'exec.resume-last': (sb) => {
        writeFileSync(join(sb.repo, '.codex-last-session'), 'sess-from-sidecar\n');
        return { args: ['--resume-last', '-'], input: 'continue' };
      },
      'exec.resume': () => ({ args: ['--resume', 'sess-xyz', '-'], input: 'continue' }),
    };
    const execParents = hook.parents.filter((p) => execEntries.some((x) => x.key === p));
    assert.ok(execParents.length > 0, 'CODEX_PROBE must claim at least one execute parent');
    for (const parent of execParents) {
      assert.ok(drive[parent], `no behavioural drive for claimed parent "${parent}" — add one`);

      const guarded = makeSandbox();
      const off = await run(guarded, { ...drive[parent](guarded), env: { CODEX_MODEL: 'not-the-pinned-model' } });
      rmSync(guarded.root, { recursive: true, force: true });
      assert.equal(off.status, 2, `${parent}: the quality guard must refuse an off-pin model without the hook`);
      assert.equal(off.argv, '', `${parent}: the guard must refuse BEFORE spending a run`);

      const probed = makeSandbox();
      const on = await run(probed, { ...drive[parent](probed), env: { CODEX_MODEL: 'not-the-pinned-model', CODEX_PROBE: '1' } });
      rmSync(probed.root, { recursive: true, force: true });
      assert.equal(on.status, 0, `${parent}: CODEX_PROBE=1 must really relax the guard — the catalog claims it does`);
      assert.notEqual(on.argv, '', `${parent}: CODEX_PROBE=1 must really reach codex, not merely exit 0`);
    }
  });
});

// ── bridge settings file + service tier knob (bridges 2.3.0) ─────────────────────
// ${XDG_CONFIG_HOME:-$HOME/.config}/agent-workflow/bridge-settings.conf holds KEY=VALUE
// lines, PARSED (never sourced). Precedence: explicit env (even empty: KEY= disables the
// knob) > file > built-in default. run() sets HOME to the sandbox repo, so the default
// settings path is hermetic per test.

const writeSettings = (sb, text) => {
  const dir = join(sb.repo, '.config', 'agent-workflow');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'bridge-settings.conf');
  writeFileSync(file, text);
  return file;
};
// chmod-based unreadability is void for root (root reads anything) — skip there.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('codex-exec.sh — service tier knob (bridges 2.3.0)', { concurrency: 2 }, () => {
  it('default: no env, no file → NO service_tier flag in codex argv', async () => {
    const sb = makeSandbox();
    const r = await run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.argv, /service_tier/, 'default OFF: the flag must be absent');
    assert.doesNotMatch(r.stderr, /bridge settings/, 'no file → no settings chatter');
  });

  it('env CODEX_SERVICE_TIER=priority → -c service_tier=priority reaches codex argv', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { env: { CODEX_SERVICE_TIER: 'priority' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.argv, /(^|\n)service_tier=priority(\n|$)/);
  });

  it('a file-set tier lands (file wins over the built-in default)', async () => {
    const sb = makeSandbox();
    writeSettings(sb, 'CODEX_SERVICE_TIER=priority\n');
    const r = await run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.argv, /(^|\n)service_tier=priority(\n|$)/);
  });

  it('an EXPLICITLY EMPTY env (CODEX_SERVICE_TIER=) disables a file-set tier for one run', async () => {
    const sb = makeSandbox();
    writeSettings(sb, 'CODEX_SERVICE_TIER=priority\n');
    const r = await run(sb, { env: { CODEX_SERVICE_TIER: '' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.argv, /service_tier/, 'env wins over file — empty means knob off');
  });

  it('an invalid env tier warns and runs on the standard tier (never passed to codex)', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { env: { CODEX_SERVICE_TIER: 'turbo' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /not a supported service tier/);
    assert.doesNotMatch(r.argv, /service_tier/, 'an unvalidated value must never reach codex');
  });

  it('an invalid file tier warns and falls back to the built-in default', async () => {
    const sb = makeSandbox();
    writeSettings(sb, 'CODEX_SERVICE_TIER=turbo\n');
    const r = await run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /invalid value 'turbo'/);
    assert.doesNotMatch(r.argv, /service_tier/);
  });

});

describe('codex-exec.sh — bridge settings file semantics (bridges 2.3.0)', { concurrency: 2 }, () => {
  it('env overrides file: CODEX_HARD_TIMEOUT env=2 file=9999 → killed at the env cap', async () => {
    const sb = makeSandbox();
    writeSettings(sb, 'CODEX_HARD_TIMEOUT=9999\n');
    const r = await runAsync(sb, { env: { CODEX_FAKE_SLEEP: '5', CODEX_HARD_TIMEOUT: '2' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0, 'the env cap (2s) must win over the file cap (9999s)');
    assert.match(r.stderr, /exceeded the hard cap CODEX_HARD_TIMEOUT=2s/);
  });

  it('a file-set CODEX_HARD_TIMEOUT is effective (killed at the file cap)', async () => {
    const sb = makeSandbox();
    writeSettings(sb, 'CODEX_HARD_TIMEOUT=2\n');
    const r = await runAsync(sb, { env: { CODEX_FAKE_SLEEP: '5' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0, 'the file cap must apply when the env is unset');
    assert.match(r.stderr, /exceeded the hard cap CODEX_HARD_TIMEOUT=2s/);
  });

  it("another wrapper's / another bridge's valid key is skipped silently", async () => {
    const sb = makeSandbox();
    writeSettings(sb, 'CODEX_REVIEW_MAX_TOTAL_BYTES=100\nAGY_HARD_TIMEOUT=30m\nAGY_REVIEW_ALLOW_ADDDIR=1\n');
    const r = await run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /bridge settings/, 'a recognized non-applied key earns NO warning');
    assert.match(r.stdout, /FAKE_FINAL_MESSAGE/);
  });

  it('a truly unknown key warns ONCE naming the file; the run is unaffected', async () => {
    const sb = makeSandbox();
    writeSettings(sb, 'TOTALLY_UNKNOWN=1\nTOTALLY_UNKNOWN=2\n');
    const r = await run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    const warns = r.stderr.match(/unknown key 'TOTALLY_UNKNOWN'/g) ?? [];
    assert.equal(warns.length, 1, `exactly one warning per unknown key, got ${warns.length}`);
    assert.match(r.stderr, /bridge-settings\.conf/, 'the warning must name the settings file');
    assert.match(r.stdout, /FAKE_FINAL_MESSAGE/);
  });

  it('duplicate key → the LAST occurrence wins (invalid then valid → applied, no warning)', async () => {
    const sb = makeSandbox();
    writeSettings(sb, 'CODEX_SERVICE_TIER=bogus\nCODEX_SERVICE_TIER=priority\n');
    const r = await run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.argv, /(^|\n)service_tier=priority(\n|$)/);
    assert.doesNotMatch(r.stderr, /invalid value/, 'only the LAST occurrence is the value');
  });

  it('duplicate key → the LAST occurrence wins (valid then invalid → warned + default)', async () => {
    const sb = makeSandbox();
    writeSettings(sb, 'CODEX_SERVICE_TIER=priority\nCODEX_SERVICE_TIER=bogus\n');
    const r = await run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /invalid value 'bogus'/);
    assert.doesNotMatch(r.argv, /service_tier/);
  });

  it('malformed lines warn and are ignored; comments and blank lines are silent', async () => {
    const sb = makeSandbox();
    writeSettings(sb, '# a comment\n\nNOT A KEY VALUE LINE\nCODEX_SERVICE_TIER=priority\n');
    const r = await run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /malformed line/);
    const malformed = r.stderr.match(/malformed line/g) ?? [];
    assert.equal(malformed.length, 1, 'comments/blank lines must NOT count as malformed');
    assert.match(r.argv, /(^|\n)service_tier=priority(\n|$)/, 'valid lines still apply');
  });

  it('an existing-but-unreadable file warns loudly and falls back to built-ins', { skip: isRoot }, async () => {
    const sb = makeSandbox();
    const file = writeSettings(sb, 'CODEX_SERVICE_TIER=priority\n');
    chmodSync(file, 0o000);
    const r = await run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /unreadable/);
    assert.doesNotMatch(r.argv, /service_tier/, 'an unreadable file must yield built-in defaults');
  });

  it('a settings line can NEVER execute code (command-substitution payload inert)', async () => {
    const sb = makeSandbox();
    const pwned = join(sb.repo, 'pwned');
    const pwned2 = join(sb.repo, 'pwned2');
    writeSettings(
      sb,
      `CODEX_SERVICE_TIER=$(touch ${pwned})\nEVIL_KEY=\`touch ${pwned2}\`\n`,
    );
    const r = await run(sb);
    const executed = existsSync(pwned) || existsSync(pwned2);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(executed, false, 'file content must be parsed, never evaluated');
    assert.doesNotMatch(r.argv, /service_tier/, 'the payload value must fail validation');
  });

  it('a DIRECTORY at the settings path warns loudly and falls back to built-ins (no crash)', async () => {
    const sb = makeSandbox();
    mkdirSync(join(sb.repo, '.config', 'agent-workflow', 'bridge-settings.conf'), { recursive: true });
    const r = await run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, `a directory must degrade honestly, not kill the run: ${r.stderr}`);
    assert.match(r.stderr, /unreadable or not a regular file/);
    assert.doesNotMatch(r.stderr, /Is a directory/, 'no raw bash error may leak');
    assert.match(r.stdout, /FAKE_FINAL_MESSAGE/, 'the run must proceed on built-ins');
  });

  it('a FIFO at the settings path warns and falls back (never opened — no pre-timeout hang)', async () => {
    const sb = makeSandbox();
    const dir = join(sb.repo, '.config', 'agent-workflow');
    mkdirSync(dir, { recursive: true });
    const fifo = join(dir, 'bridge-settings.conf');
    const mk = spawnSync('mkfifo', [fifo]);
    if (mk.status !== 0) { rmSync(sb.root, { recursive: true, force: true }); return; } // no mkfifo here — the directory case covers the class
    const r = await run(sb);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /unreadable or not a regular file/);
    assert.match(r.stdout, /FAKE_FINAL_MESSAGE/);
  });

  it('XDG_CONFIG_HOME relocates the settings file', async () => {
    const sb = makeSandbox();
    const xdg = join(sb.root, 'xdg');
    mkdirSync(join(xdg, 'agent-workflow'), { recursive: true });
    writeFileSync(join(xdg, 'agent-workflow', 'bridge-settings.conf'), 'CODEX_SERVICE_TIER=priority\n');
    const r = await run(sb, { env: { XDG_CONFIG_HOME: xdg } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.argv, /(^|\n)service_tier=priority(\n|$)/);
  });
});

// ── settings surface ⟷ manifest (drift guard, D6) ────────────────────────────────
// The manifest `settings` block is the single source: the --help Settings section
// renders this wrapper's applied subset, and the shell constants (registry, applied
// subset, typed validation arms) stay set-equal to the UNION of both bridges' blocks
// (the reader recognizes every family key). The sibling manifest resolves identically
// in the repo layout and in the kit's bridges/ mirror layout.
const SETTINGS_HEADER = 'Settings file (KEY=VALUE, parsed never sourced; env wins over file, file wins over built-in default):';
const SIBLING_MANIFEST = JSON.parse(readFileSync(join(HERE, '..', '..', 'antigravity-cli-bridge', 'capability.json'), 'utf8'));
const ALL_SETTINGS = [...(MANIFEST.settings ?? []), ...(SIBLING_MANIFEST.settings ?? [])];
const SETTINGS_CMD = 'codex-exec';

describe('codex-exec.sh — settings surface ⟷ manifest (D6, manifest-pinned)', { concurrency: 2 }, () => {
  it('--help Settings section keys set-EQUAL the manifest appliesTo subset', async () => {
    const help = runHelp('--help').stdout;
    const section = helpSection(help, SETTINGS_HEADER);
    const got = section.filter((l) => /^[A-Z][A-Z0-9_]+ —/.test(l)).map((l) => l.split(' ')[0]);
    const want = (MANIFEST.settings ?? []).filter((s) => s.appliesTo.includes(SETTINGS_CMD)).map((s) => s.key);
    assert.ok(want.length > 0, 'the manifest must declare settings for this wrapper');
    setEq(got, want, 'help Settings keys ⟷ manifest settings.appliesTo');
    assert.ok(section.some((l) => l.includes('agent-workflow/bridge-settings.conf')), 'the section names the settings file');
  });

  const source = readFileSync(WRAPPER, 'utf8');

  it('aw_settings_known carries exactly the UNION of both bridges settings keys', async () => {
    const m = source.match(/aw_settings_known\(\) \{\n  case " ([^"]+) " in/);
    assert.ok(m, 'aw_settings_known registry case not found');
    assert.ok(ALL_SETTINGS.length >= 5, 'both manifests must contribute settings');
    setEq(m[1].trim().split(/\s+/), ALL_SETTINGS.map((s) => s.key), 'shell registry ⟷ manifest union');
  });

  it('AW_SETTINGS_APPLIED equals the manifest appliesTo subset for this wrapper', async () => {
    const m = source.match(/^AW_SETTINGS_APPLIED="([^"]*)"$/m);
    assert.ok(m, 'AW_SETTINGS_APPLIED not found');
    const want = ALL_SETTINGS.filter((s) => s.appliesTo.includes(SETTINGS_CMD)).map((s) => s.key);
    assert.ok(want.length > 0);
    setEq(m[1].trim().split(/\s+/), want, 'applied subset ⟷ manifest appliesTo');
  });

  it('aw_settings_valid arms carry the manifest typed constants per key', async () => {
    const body = source.match(/aw_settings_valid\(\) \{[\s\S]*?\n\}/);
    assert.ok(body, 'aw_settings_valid not found');
    const armKeys = [...body[0].matchAll(/^    ([A-Z][A-Z0-9_]*)\)/gm)].map((x) => x[1]);
    setEq(armKeys, ALL_SETTINGS.map((s) => s.key), 'validation arms ⟷ manifest keys');
    for (const s of ALL_SETTINGS) {
      const arm = body[0].match(new RegExp(`^    ${s.key}\\) (.*) ;;$`, 'm'));
      assert.ok(arm, `no validation arm for ${s.key}`);
      if (s.kind === 'enum') for (const v of s.values) assert.ok(arm[1].includes(`"${v}"`), `${s.key}: enum value '${v}' not pinned`);
      if (s.kind === 'integer') {
        // Issue-012 refactor: min/max are pinned as the aw_int_in_range helper's positional bounds
        // (`aw_int_in_range "$v" <min> <max>`) — the overflow-safe range check replaced raw arithmetic.
        assert.match(arm[1], new RegExp(`aw_int_in_range "\\$v" ${s.min} ${s.max}\\b`), `${s.key}: min/max ${s.min}/${s.max} not pinned as the aw_int_in_range bounds`);
      }
      if (s.kind === 'boolean') assert.ok(arm[1].includes('"0"') && arm[1].includes('"1"'), `${s.key}: boolean 0/1 not pinned`);
      if (s.kind === 'duration') {
        assert.ok(arm[1].includes('$dur_re'), `${s.key}: duration grammar not pinned`);
        assert.ok(arm[1].includes('$zero_re'), `${s.key}: zero-duration rejection not pinned (timeout 0 disables the cap)`);
      }
    }
  });
});

describe('codex-exec.sh — dispatch-posture labeling (D5, AD-061)', { concurrency: 2 }, () => {
  const banners = (stderr) => stderr.split('\n').filter((l) => l.startsWith('exec posture: '));

  it('ONE banner line carries the ACTUAL {model, effort, tier, sandbox, session, timeout} on a fresh run', async () => {
    const sb = makeSandbox();
    const r = await run(sb, {});
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    const lines = banners(r.stderr);
    assert.equal(lines.length, 1, 'EXACTLY ONE banner line per run');
    assert.equal(lines[0],
      'exec posture: model=gpt-5.6-sol effort=xhigh tier=standard sandbox=workspace-write session=fresh timeout=3600s');
  });

  it('an ARMED Fast tier rides the banner (tier=priority)', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { env: { CODEX_SERVICE_TIER: 'priority' } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^exec posture: .* tier=priority .*$/m);
  });

  it('a resume banner carries the RESOLVED session id (explicit --resume)', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { args: ['--resume', 'sess-xyz', '-'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    const lines = banners(r.stderr);
    assert.equal(lines.length, 1, 'EXACTLY ONE banner line on resume too');
    assert.match(lines[0], / session=resume:sess-xyz /, 'the banner names the resolved id');
  });

  it('--resume-last resolves the sidecar id into the banner', async () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, '.codex-last-session'), 'sess-from-sidecar\n');
    const r = await run(sb, { args: ['--resume-last', '-'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, / session=resume:sess-from-sidecar /);
  });

  it('a HOSTILE/malformed EXPLICIT session id refuses pre-spend (no codex invocation)', async () => {
    for (const hostile of ['evil;rm -rf /', 'a b', `x${String.fromCharCode(1)}y`]) {
      const sb = makeSandbox();
      const r = await run(sb, { args: ['--resume', hostile, '-'] });
      rmSync(sb.root, { recursive: true, force: true });
      assert.notEqual(r.status, 0, `must refuse: ${JSON.stringify(hostile)}`);
      assert.equal(r.capStdin, '', 'codex is never invoked');
      assert.match(r.stderr, /session id/i, 'named as the session-id class');
    }
  });

  it('a HOSTILE SIDECAR-READ session id refuses pre-spend the same way', async () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, '.codex-last-session'), 'evil$(touch pwned)\n');
    const r = await run(sb, { args: ['--resume-last', '-'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.equal(r.capStdin, '', 'codex is never invoked');
    assert.match(r.stderr, /session id/i);
  });

  it('a FLAG-SHAPED sidecar id (leading dash) refuses at the grammar — never reaches codex as an option', async () => {
    for (const bad of ['--last\n', '-x\n']) {
      const sb = makeSandbox();
      writeFileSync(join(sb.repo, '.codex-last-session'), bad);
      const r = await run(sb, { args: ['--resume-last', '-'] });
      rmSync(sb.root, { recursive: true, force: true });
      assert.notEqual(r.status, 0, `must refuse: ${JSON.stringify(bad)}`);
      assert.equal(r.capStdin, '', 'codex is never invoked');
      assert.match(r.stderr, /session id/i, 'refused at the grammar, never parsed as a codex option');
    }
  });

  it('a sidecar carrying a NUL byte refuses pre-spend — bash would silently repair it into a valid id', async () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, '.codex-last-session'), Buffer.from('sess-\0target\n', 'binary'));
    const r = await run(sb, { args: ['--resume-last', '-'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.equal(r.capStdin, '', 'codex is never invoked');
    assert.match(r.stderr, /NUL/i, 'named as the NUL class — the raw bytes are checked before the shell variable');
  });

  it('a valid id containing the ASCII digit 0 gets no false NUL refusal', async () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, '.codex-last-session'), 'sess-01\n');
    const r = await run(sb, { args: ['--resume-last', '-'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, / session=resume:sess-01 /);
  });

  it('a sidecar id with inner WHITESPACE refuses — never silently repaired into a different id', async () => {
    for (const bad of ['sess bad\n', 'sess\tbad\n']) {
      const sb = makeSandbox();
      writeFileSync(join(sb.repo, '.codex-last-session'), bad);
      const r = await run(sb, { args: ['--resume-last', '-'] });
      rmSync(sb.root, { recursive: true, force: true });
      assert.notEqual(r.status, 0, `must refuse: ${JSON.stringify(bad)}`);
      assert.equal(r.capStdin, '', 'codex is never invoked');
      assert.match(r.stderr, /session id/i, 'the grammar refusal fires — the id is never whitespace-stripped into validity');
    }
  });

  it('a banner field carrying CONTROL BYTES refuses pre-spend (model / effort / tier / timeout / DEL)', async () => {
    const cases = [
      { CODEX_MODEL: `gpt-5.6-sol${String.fromCharCode(1)}` },
      { CODEX_EFFORT: `xhigh${String.fromCharCode(2)}` },
      { CODEX_SERVICE_TIER: `priority${String.fromCharCode(3)}` },
      { CODEX_HARD_TIMEOUT: `3600${String.fromCharCode(4)}` },
      { CODEX_MODEL: `gpt-5.6-sol${String.fromCharCode(127)}` },
    ];
    for (const env of cases) {
      const sb = makeSandbox();
      const r = await run(sb, { env });
      rmSync(sb.root, { recursive: true, force: true });
      assert.notEqual(r.status, 0, `must refuse: ${JSON.stringify(env)}`);
      assert.equal(r.capStdin, '', 'codex is never invoked');
      assert.match(r.stderr, /control/i, 'named as the control-byte class');
    }
  });

  it('timeout honesty: no timeout/gtimeout on PATH → timeout=uncapped, never a fabricated number', async () => {
    const sb = makeSandbox();
    const r = await run(sb, { path: `${sb.bin}:${farmFor(['timeout', 'gtimeout'])}` });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^exec posture: .* timeout=uncapped$/m);
  });

  it('an EXPORTED shell function shadowing timeout never fools the banner (type -P discipline)', async () => {
    const sb = makeSandbox();
    const r = await run(sb, {
      path: `${sb.bin}:${farmFor(['timeout', 'gtimeout'])}`,
      env: { 'BASH_FUNC_timeout%%': '() { return 0; }' },
    });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^exec posture: .* timeout=uncapped$/m, 'a shell function is not a capping binary');
  });

  it('an EXPORTED `type` function faking a path never fools the resolver (builtin type discipline)', async () => {
    const sb = makeSandbox();
    const r = await run(sb, {
      path: `${sb.bin}:${farmFor(['timeout', 'gtimeout'])}`,
      env: { 'BASH_FUNC_type%%': '() { echo /fake/timeout; }' },
    });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^exec posture: .* timeout=uncapped$/m, 'builtin type bypasses an exported type function');
  });

  it('a RELATIVE first PATH git entry + shadowed dirname/basename still bakes an ABSOLUTE real git into the shim', async () => {
    const sb = makeSandbox();
    const realGit = (process.env.PATH || '').split(':').filter(Boolean).map((d) => join(d, 'git')).find((p) => existsSync(p));
    assert.ok(realGit, 'a real git exists on PATH');
    mkdirSync(join(sb.repo, 'relgit'), { recursive: true });
    writeFileSync(join(sb.repo, 'relgit', 'git'), `#!/usr/bin/env bash\nexec ${realGit} "$@"\n`, { mode: 0o755 });
    const gitResult = join(sb.repo, '.cap-git');
    const r = await run(sb, {
      path: `relgit:${sb.bin}:${process.env.PATH}`,
      env: {
        CODEX_FAKE_GIT_PROBE: '1',
        CODEX_FAKE_GIT_RESULT: gitResult,
        'BASH_FUNC_dirname%%': '() { echo /shadowed; }',
        'BASH_FUNC_basename%%': '() { echo shadowed; }',
      },
    });
    const probe = existsSync(gitResult) ? readFileSync(gitResult, 'utf8') : '';
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(probe, /cdaway=0/, 'the shim git works from a different cwd — the embedded path is absolute, shadow-proof');
  });

  it('a RELATIVE PATH entry still yields an ABSOLUTE capping binary (the stub sees an absolute $0)', async () => {
    const sb = makeSandbox();
    mkdirSync(join(sb.repo, 'relbin'), { recursive: true });
    const cap = join(sb.repo, '.stub-argv0');
    writeFileSync(join(sb.repo, 'relbin', 'timeout'), [
      '#!/usr/bin/env bash',
      'echo "$0" >"$TIMEOUT_STUB_CAP"',
      'while [[ "$1" == --* ]]; do shift; done',
      'shift',
      'exec "$@"',
      '',
    ].join('\n'), { mode: 0o755 });
    const r = await run(sb, {
      path: `relbin:${sb.bin}:${farmFor(['timeout', 'gtimeout'])}`,
      env: { TIMEOUT_STUB_CAP: cap },
    });
    const argv0 = existsSync(cap) ? readFileSync(cap, 'utf8').trim() : '';
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^exec posture: .* timeout=3600s$/m, 'the relative-PATH binary still caps the run');
    assert.ok(argv0.startsWith('/'), `the stub must be invoked by ABSOLUTE path, got: ${JSON.stringify(argv0)}`);
  });

  it('an INVALID effective CODEX_HARD_TIMEOUT (env — the closed aw_settings_valid bypass) warns and falls back to the default', async () => {
    for (const bad of ['abc', '0', '999999999']) {
      const sb = makeSandbox();
      const r = await run(sb, { env: { CODEX_HARD_TIMEOUT: bad } });
      rmSync(sb.root, { recursive: true, force: true });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, new RegExp(`invalid value '${bad}' for CODEX_HARD_TIMEOUT`), 'the fallback is loud');
      assert.match(r.stderr, /^exec posture: .* timeout=3600s$/m, 'the banner prints the built-in default, never the bad value');
    }
  });
});

// ── the delegation dispatch identity: nonce seam, reservation, fail-closed receipt ────────────────
// The exec lane's arrival identity (delegation Plan 2, Phase 3). Two halves are load-bearing and
// tested apart: the PRE-SPEND reservation, which is what makes one nonce mean one dispatch, and the
// TERMINAL publication, which is fail-closed where the review lane's receipt only warns.
// A nonce-LESS run is the no-regression pin — every suite above drives one, and none of them may
// see an artifact.

const STORE_BASENAME = 'agent-workflow-delegation.jsonl';
const receiptName = (nonce, backend = 'codex') => `agent-workflow-exec-receipt-${backend.length}-${backend}-${nonce}.json`;
const reportName = (nonce, backend = 'codex') => `agent-workflow-exec-report-${backend.length}-${backend}-${nonce}.txt`;
// The store directory a nonce-less-by-default sandbox resolves to: the git common dir of the repo.
const storeDirOf = (sb) => join(sb.repo, '.git');
const execArtifacts = (dir) => {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.startsWith('agent-workflow-exec-')).sort();
};
const readReceipt = (dir, nonce) => JSON.parse(readFileSync(join(dir, receiptName(nonce)), 'utf8'));

// A dispatch file carrying exactly ONE top-level contract block — the same shape `dispatch open
// --contract` parses, so the digest the wrapper computes here is the digest the ledger recorded.
const CONTRACT_FENCE = '```';
const writeContract = (sb, nonce, over = {}) => {
  const contract = {
    schema: 1,
    nonce,
    stepClass: 'code',
    vehicle: { requested: 'codex-exec', selected: 'codex-exec' },
    scope: 'the bounded sub-task', inputs: 'the files it may touch', acceptance: 'the named tests',
    returnShape: 'a diff plus a report', producerContract: 'wrapper-git',
    deadlineS: 3700,
    retry: { cap: 1, index: 0 },
    ...over,
  };
  const rel = `${nonce}-dispatch.md`;
  writeFileSync(join(sb.repo, rel),
    `# sub-task\n\n${CONTRACT_FENCE}aw-dispatch-contract\n${JSON.stringify(contract, null, 2)}\n${CONTRACT_FENCE}\n`);
  return rel;
};

// run() reads the capture files the PREVIOUS run left behind, so a test proving "the CLI was never
// invoked" has to clear them first — otherwise a stale argv reads as a fresh invocation.
const clearCaptures = (sb) => {
  for (const name of ['.cap-argv', '.cap-env', '.cap-stdin']) rmSync(join(sb.repo, name), { force: true });
};

describe('codex-exec.sh — the nonce seam (D11)', { concurrency: 2 }, () => {
  it('a nonce-LESS run writes NO artifact into the store directory', async () => {
    const sb = makeSandbox();
    const file = writeContract(sb, 'unused');
    const r = await run(sb, { args: [file] });
    const artifacts = execArtifacts(storeDirOf(sb));
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(artifacts, [], 'a nonce-less invocation is byte-unchanged — no reservation, no receipt');
    assert.doesNotMatch(r.stderr, /exec receipt:/, 'and it says nothing about a receipt either');
  });

  it('each of the three D11 argv forms is accepted and reaches the right mode', async () => {
    const cases = [
      { label: 'fresh', args: (f) => ['--nonce', 'nf', f], nonce: 'nf', wantSession: 'fake-thread-123', resume: false },
      { label: 'resume-last', args: (f) => ['--resume-last', '--nonce', 'nl', f], nonce: 'nl', wantSession: 'sess-from-sidecar', resume: true },
      { label: 'resume', args: (f) => ['--resume', 'sess-xyz', '--nonce', 'nr', f], nonce: 'nr', wantSession: 'sess-xyz', resume: true },
    ];
    for (const c of cases) {
      const sb = makeSandbox();
      writeFileSync(join(sb.repo, '.codex-last-session'), 'sess-from-sidecar\n');
      const file = writeContract(sb, c.nonce);
      const r = await run(sb, { args: c.args(file) });
      const receipt = r.status === 0 ? readReceipt(storeDirOf(sb), c.nonce) : null;
      rmSync(sb.root, { recursive: true, force: true });
      assert.equal(r.status, 0, `${c.label}: ${r.stderr}`);
      assert.match(r.argv, /(^|\n)exec(\n|$)/, `${c.label}: codex exec was really reached`);
      assert.equal(/(^|\n)resume(\n|$)/.test(r.argv), c.resume, `${c.label}: the mode selector survived the nonce strip`);
      assert.equal(receipt.state, 'terminal', `${c.label}: the run published its terminal receipt`);
      assert.equal(receipt.nonce, c.nonce);
      assert.equal(receipt.sessionId, c.wantSession, `${c.label}: the session id is the run's own`);
    }
  });

  it('a --nonce AFTER the prompt operand or after -- is payload, never a flag', async () => {
    const sb = makeSandbox();
    const file = writeContract(sb, 'late');
    const passthrough = await run(sb, { args: [file, '--', '--nonce', 'late'] });
    const afterOperand = await run(sb, { args: [file, '--nonce', 'late'] });
    const artifacts = execArtifacts(storeDirOf(sb));
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(passthrough.status, 0, passthrough.stderr);
    assert.match(passthrough.argv, /(^|\n)--nonce(\n|$)/, 'after -- it reaches codex argv as payload');
    assert.deepEqual(artifacts, [], 'and it never minted a dispatch identity');
    assert.equal(afterOperand.status, 2, 'without -- an extra argument is the existing loud refusal');
    assert.match(afterOperand.stderr, /unexpected argument '--nonce'/);
  });

  it('the flag and the environment value are ONE seam: agreeing runs, disagreeing refuses pre-spend', async () => {
    const agree = makeSandbox();
    const agreeFile = writeContract(agree, 'same');
    const ok = await run(agree, { args: ['--nonce', 'same', agreeFile], env: { AW_DISPATCH_NONCE: 'same' } });
    const okState = ok.status === 0 ? readReceipt(storeDirOf(agree), 'same').state : null;
    rmSync(agree.root, { recursive: true, force: true });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(okState, 'terminal');

    const clash = makeSandbox();
    const clashFile = writeContract(clash, 'flagnonce');
    const bad = await run(clash, { args: ['--nonce', 'flagnonce', clashFile], env: { AW_DISPATCH_NONCE: 'envnonce' } });
    const artifacts = execArtifacts(storeDirOf(clash));
    rmSync(clash.root, { recursive: true, force: true });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--nonce disagrees with the AW_DISPATCH_NONCE environment value/);
    assert.equal(bad.argv, '', 'the refusal precedes any spend');
    assert.deepEqual(artifacts, [], 'and it reserves nothing');
  });

  it('a nonce outside the safe grammar refuses pre-spend, from either source', async () => {
    for (const bad of ['a/b', '../x', 'a b', 'x'.repeat(65), '']) {
      const viaFlag = makeSandbox();
      const file = writeContract(viaFlag, 'grammar');
      const f = await run(viaFlag, { args: ['--nonce', bad, file] });
      const flagArtifacts = execArtifacts(storeDirOf(viaFlag));
      rmSync(viaFlag.root, { recursive: true, force: true });
      assert.equal(f.status, 2, `--nonce "${bad}" must refuse`);
      assert.match(f.stderr, /fails the safe nonce grammar/);
      assert.equal(f.argv, '', 'nothing was spent');
      assert.deepEqual(flagArtifacts, [], 'nothing was reserved');

      if (bad === '') continue; // an EMPTY env value is "unset" to the seam, not a bad nonce
      const viaEnv = makeSandbox();
      const e = await run(viaEnv, { args: [writeContract(viaEnv, 'grammar')], env: { AW_DISPATCH_NONCE: bad } });
      rmSync(viaEnv.root, { recursive: true, force: true });
      assert.equal(e.status, 2, `AW_DISPATCH_NONCE "${bad}" must refuse`);
      assert.match(e.stderr, /AW_DISPATCH_NONCE fails the safe nonce grammar/);
    }
  });

  it('a duplicate --nonce refuses, and a --nonce with no value refuses', async () => {
    const sb = makeSandbox();
    const file = writeContract(sb, 'dup');
    const dup = await run(sb, { args: ['--nonce', 'dup', '--nonce', 'other', file] });
    const bare = await run(sb, { args: ['--nonce'] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(dup.status, 2);
    assert.match(dup.stderr, /duplicate --nonce — one dispatch carries one nonce/);
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /--nonce needs a value/);
  });

  it('an accounted dispatch needs a contract FILE: stdin and a header-less file both refuse pre-spend', async () => {
    const sb = makeSandbox();
    const stdin = await run(sb, { args: ['--nonce', 'n1', '-'], input: 'do the thing' });
    writeFileSync(join(sb.repo, 'plain.md'), '# just a plan\n\nno contract block here\n');
    clearCaptures(sb);
    const headerless = await run(sb, { args: ['--nonce', 'n1', 'plain.md'] });
    const artifacts = execArtifacts(storeDirOf(sb));
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(stdin.status, 2);
    assert.match(stdin.stderr, /a nonced dispatch runs a contract FILE, not stdin/);
    assert.equal(headerless.status, 2);
    assert.match(headerless.stderr, /no top-level ```aw-dispatch-contract block found/);
    assert.equal(headerless.argv, '', 'neither refusal spent a run');
    assert.deepEqual(artifacts, [], 'neither refusal reserved a nonce');
  });
});

describe('codex-exec.sh — the pre-spend reservation (D1/D8)', { concurrency: 2 }, () => {
  it('the reservation EXISTS, in state reserved, while the CLI is still running', async () => {
    // The ordering claim needs a mid-flight observation. Asserting it from a SECOND run would prove
    // nothing: by then the first run has finished and left a TERMINAL artifact, so moving the
    // reservation to after the CLI would keep such a test green. The fake copies the receipt while
    // it runs; only a genuinely pre-spend reservation can be `reserved` at that moment.
    const sb = makeSandbox();
    const file = writeContract(sb, 'midflight');
    const snapshot = join(sb.root, 'receipt-during-the-run.json');
    const r = await run(sb, {
      args: ['--nonce', 'midflight', file],
      env: { CODEX_FAKE_SNAPSHOT_SRC: join(storeDirOf(sb), receiptName('midflight')), CODEX_FAKE_SNAPSHOT_DST: snapshot },
    });
    const seen = readFileSync(snapshot, 'utf8');
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(seen.trim(), 'ABSENT', 'the receipt must already exist when the CLI starts');
    assert.equal(JSON.parse(seen).state, 'reserved', 'and it is the RESERVATION — the terminal receipt comes later');
  });

  it('a second dispatch on the same nonce refuses unspent, leaving the first run\'s evidence untouched', async () => {
    const sb = makeSandbox();
    const file = writeContract(sb, 'once');
    const first = await run(sb, { args: ['--nonce', 'once', file] });
    const receiptPath = join(storeDirOf(sb), receiptName('once'));
    const afterFirst = readFileSync(receiptPath, 'utf8');
    clearCaptures(sb);
    const second = await run(sb, { args: ['--nonce', 'once', file] });
    const afterSecond = readFileSync(receiptPath, 'utf8');
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 2, 'one nonce, one dispatch');
    assert.match(second.stderr, /already exists at .* one nonce, one dispatch: refusing PRE-SPEND/);
    assert.equal(second.argv, '', 'the CLI was never invoked — the refusal is PRE-spend, proven by the fake recording nothing');
    assert.equal(afterSecond, afterFirst, 'the first dispatch\'s evidence is byte-untouched');
  });

  it('the dispatch nonce must equal the contract header\'s nonce — a disagreement refuses unspent', async () => {
    // `dispatch open` COPIES the nonce from the header, so a disagreeing --nonce could only reserve
    // an identity no return would ever absorb — after paying for the run.
    const sb = makeSandbox();
    const file = writeContract(sb, 'header');
    const r = await run(sb, { args: ['--nonce', 'other', file] });
    const artifacts = execArtifacts(storeDirOf(sb));
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /the dispatch nonce 'other' does not match the contract header's nonce 'header'/);
    assert.equal(r.argv, '', 'the refusal precedes the spend');
    assert.deepEqual(artifacts, [], 'and precedes the reservation');
  });

  it('a nonce-LESS run of a contract-bearing file never compares nonces — the accounted lane owns that rule', async () => {
    const sb = makeSandbox();
    const file = writeContract(sb, 'header');
    const r = await run(sb, { args: [file] });
    const artifacts = execArtifacts(storeDirOf(sb));
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(artifacts, [], 'an ordinary plan file that happens to carry a contract block still runs unaccounted');
  });

  it('a store directory whose parent name ends in a NEWLINE resolves as the kit resolves it', async () => {
    // `$( )` strips every trailing newline; the kit's own reader strips exactly ONE (git's
    // terminator). Without a sentinel the two sides would resolve different directories here, and the
    // wrapper would write beside a ledger the kit never reads.
    const sb = makeSandbox();
    const weird = join(sb.root, 'ledger\n');
    mkdirSync(weird, { recursive: true });
    const file = writeContract(sb, 'nlstore');
    const r = await run(sb, { args: ['--nonce', 'nlstore', file], env: { AW_DELEGATION_STORE: join(weird, STORE_BASENAME) } });
    const landed = execArtifacts(weird);
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(landed, [receiptName('nlstore'), reportName('nlstore')].sort(),
      'the artifacts land in the directory the kit would compute, newline and all');
  });

  it('an already-taken REPORT name refuses the reservation too — the kit refuses on either name', async () => {
    const sb = makeSandbox();
    const file = writeContract(sb, 'leftover');
    writeFileSync(join(storeDirOf(sb), reportName('leftover')), 'a report from something else\n');
    const r = await run(sb, { args: ['--nonce', 'leftover', file] });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /already exists at .*agent-workflow-exec-report-5-codex-leftover\.txt/);
    assert.equal(r.argv, '', 'nothing was spent');
  });

  it('a NONCED run with no capping binary refuses pre-spend, while a nonce-less one still warns and runs', async () => {
    const sb = makeSandbox();
    const file = writeContract(sb, 'uncapped');
    const path = `${sb.bin}:${farmFor(['timeout', 'gtimeout'])}`;
    const nonced = await run(sb, { args: ['--nonce', 'uncapped', file], path });
    const artifacts = execArtifacts(storeDirOf(sb));
    clearCaptures(sb);
    const plain = await run(sb, { args: [file], path });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(nonced.status, 2, nonced.stderr);
    assert.match(nonced.stderr, /a nonced dispatch refuses to run uncapped/);
    assert.equal(nonced.argv, '', 'the refusal precedes the spend');
    assert.deepEqual(artifacts, [], 'and precedes the reservation');
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stderr, /running codex WITHOUT a hard wall-clock cap/, 'the nonce-less lane is unchanged');
  });

  it('a PREFLIGHT refusal leaves NO reservation (login guard, missing AGENTS.md, off-pin model)', async () => {
    const cases = [
      { label: 'login', env: { CODEX_FAKE_LOGIN: 'Not logged in' } },
      { label: 'model', env: { CODEX_MODEL: 'gpt-5.4-mini' } },
      { label: 'agents', env: {}, drop: true },
    ];
    for (const c of cases) {
      const sb = makeSandbox();
      const file = writeContract(sb, 'preflight');
      if (c.drop) rmSync(join(sb.repo, 'AGENTS.md'), { force: true });
      const r = await run(sb, { args: ['--nonce', 'preflight', file], env: c.env });
      const artifacts = execArtifacts(storeDirOf(sb));
      rmSync(sb.root, { recursive: true, force: true });
      assert.notEqual(r.status, 0, `${c.label}: the preflight must refuse`);
      assert.deepEqual(artifacts, [], `${c.label}: a refused run leaves no reservation`);
    }
  });

  it('the reservation carries everything knowable PRE-SPEND and nulls every terminal-only field', async () => {
    // Proven on the artifact the CLI-blocking refusal leaves behind: a second dispatch is refused
    // pre-spend, so the FIRST run's reservation is the only shape a fixture can observe mid-flight —
    // instead, block the terminal publication and read the surviving reservation.
    const sb = makeSandbox();
    const file = writeContract(sb, 'resv');
    const r = await run(sb, {
      args: ['--nonce', 'resv', file],
      env: { CODEX_FAKE_MKDIR: join(storeDirOf(sb), reportName('resv')) },
    });
    const held = readReceipt(storeDirOf(sb), 'resv');
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 71, r.stderr);
    assert.equal(held.state, 'reserved');
    assert.equal(held.wrapperVersion, MANIFEST.version, 'the receipt stamps the bridge version version-sync bumps');
    assert.deepEqual(held.posture, { model: 'gpt-5.6-sol', effort: 'xhigh', tier: null });
    assert.equal(held.capS, 3600);
    assert.equal(held.killGraceS, 15);
    assert.match(held.contractDigest, /^[0-9a-f]{64}$/);
    for (const field of ['sessionId', 'exitStatus', 'outcome', 'reportDigest', 'reportLength']) {
      assert.equal(held[field], null, `a reservation proves nothing about ${field}`);
    }
  });

  it('the store directory resolves as the kit resolves it: absolute override wins, relative and trailing-separator refuse', async () => {
    const sb = makeSandbox();
    const file = writeContract(sb, 'store');
    const elsewhere = join(sb.root, 'ledger');
    mkdirSync(elsewhere, { recursive: true });
    const ok = await run(sb, { args: ['--nonce', 'store', file], env: { AW_DELEGATION_STORE: join(elsewhere, STORE_BASENAME) } });
    const landed = execArtifacts(elsewhere);
    clearCaptures(sb);
    const rel = await run(sb, { args: ['--nonce', 'store2', writeContract(sb, 'store2')], env: { AW_DELEGATION_STORE: `ledger/${STORE_BASENAME}` } });
    clearCaptures(sb);
    const trailing = await run(sb, { args: ['--nonce', 'store3', writeContract(sb, 'store3')], env: { AW_DELEGATION_STORE: `${elsewhere}/` } });
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(landed, [receiptName('store'), reportName('store')].sort(), 'both artifacts land in the override\'s dirname');
    assert.equal(rel.status, 2);
    assert.match(rel.stderr, /AW_DELEGATION_STORE must be an ABSOLUTE path/);
    assert.equal(trailing.status, 2);
    assert.match(trailing.stderr, /must not end with a path separator/);
  });
});

describe('codex-exec.sh — the fail-closed terminal receipt (D1/D3/3.1.d)', { concurrency: 2 }, () => {
  it('a SUCCESSFUL run publishes a complete report and a terminal receipt that describes it', async () => {
    const sb = makeSandbox();
    const file = writeContract(sb, 'ok');
    const r = await run(sb, { args: ['--nonce', 'ok', file] });
    const dir = storeDirOf(sb);
    const receipt = readReceipt(dir, 'ok');
    const report = readFileSync(join(dir, reportName('ok')));
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(receipt.state, 'terminal');
    assert.equal(receipt.outcome, 'success');
    assert.equal(receipt.exitStatus, 0);
    assert.equal(receipt.reportLength, report.length, 'the receipt describes the bytes on disk');
    assert.equal(receipt.reportDigest, createHash('sha256').update(report).digest('hex'));
    assert.equal(report.toString(), 'FAKE_FINAL_MESSAGE\n', 'the report IS the delegate\'s final message');
    assert.match(r.stderr, /exec receipt: nonce=ok outcome=success exit=0 session=fake-thread-123/);
  });

  it('a FAILED run still publishes a terminal receipt — with its exit status, outcome and session id', async () => {
    const sb = makeSandbox();
    const file = writeContract(sb, 'boom');
    const r = await run(sb, { args: ['--nonce', 'boom', file], env: { CODEX_FAKE_EXIT: '5' } });
    const receipt = readReceipt(storeDirOf(sb), 'boom');
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 5, 'the wrapper still exits with the run\'s own status');
    assert.equal(receipt.state, 'terminal');
    assert.equal(receipt.exitStatus, 5);
    assert.equal(receipt.outcome, 'transport-failure');
    assert.equal(receipt.sessionId, 'fake-thread-123', 'the session id is captured BEFORE outcome branching — a failed run has one too');
    assert.match(r.stderr, /error: codex exec failed \(exit 5\)/, 'the failure diagnostics still print, and BEFORE the receipt line');
    assert.ok(r.stderr.indexOf('codex exec failed') < r.stderr.indexOf('exec receipt:'), 'a publication never swallows the trace tail');
  });

  it('an ABSENT capture and an EXISTING EMPTY one both record zero bytes — and neither is a failed probe', async () => {
    // `mktemp` used to pre-create the capture file, so ENOENT could never occur and "absent" was not
    // a case the publisher could even see. It matters because of what it collides with: once an
    // absent capture is possible, the fail-closed read-error branch has to tell it apart from a
    // genuinely UNREADABLE one (the test below) instead of treating every errno alike.
    // What the two cases here do NOT get is a difference in the RECEIPT: the D2 key set is frozen and
    // has no field for "the delegate wrote nothing at all", so both record the sha256 of no bytes —
    // stated rather than papered over, and the outcome stays D3's (rc 0 + a session id is success).
    const absent = makeSandbox();
    const absentFile = writeContract(absent, 'noout');
    const a = await run(absent, { args: ['--nonce', 'noout', absentFile], env: { CODEX_FAKE_NO_OUT: '1' } });
    const absentReceipt = readReceipt(storeDirOf(absent), 'noout');
    const absentReport = readFileSync(join(storeDirOf(absent), reportName('noout')));
    rmSync(absent.root, { recursive: true, force: true });
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stderr, /codex produced no final-message file/, 'the run says it has no answer rather than printing an empty one');
    assert.equal(absentReport.length, 0);
    assert.equal(absentReceipt.reportLength, 0);
    assert.equal(absentReceipt.reportDigest, createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
      'an absent final message is recorded as the sha256 of NO bytes, never as a failed probe');

    const empty = makeSandbox();
    const emptyFile = writeContract(empty, 'emptyout');
    const e = await run(empty, { args: ['--nonce', 'emptyout', emptyFile], env: { CODEX_FAKE_EMPTY_OUT: '1' } });
    const emptyReceipt = readReceipt(storeDirOf(empty), 'emptyout');
    rmSync(empty.root, { recursive: true, force: true });
    assert.equal(e.status, 0, e.stderr);
    assert.equal(emptyReceipt.reportLength, 0, 'an EXISTING empty capture records zero bytes too');
    assert.equal(emptyReceipt.reportDigest, absentReceipt.reportDigest,
      'DELIBERATE: the frozen D2 key set has no field that separates them, so the receipt does not pretend to');
    assert.match(e.stderr, /codex produced no final-message file/,
      'the existing-but-EMPTY capture takes the same -s fallback — it too has no answer to print');
  });

  it('an UNREADABLE final message is a failed probe — exit 71, never a silent empty report', async () => {
    const sb = makeSandbox();
    const file = writeContract(sb, 'unread');
    // A DIRECTORY at the capture path: readable-as-a-path, unreadable as a file (EISDIR), and
    // distinct from ENOENT — which is exactly the errno split the fold turns on.
    nodeShimWith(sb, 'eisdir.cjs', `
const fs = require('node:fs');
const real = fs.readFileSync;
fs.readFileSync = (target, ...rest) => {
  if (typeof target === 'string' && target.endsWith('final-message.txt')) {
    const err = new Error('EISDIR: injected unreadable capture');
    err.code = 'EISDIR';
    throw err;
  }
  return real(target, ...rest);
};
`);
    const r = await run(sb, { args: ['--nonce', 'unread', file] });
    const receipt = readReceipt(storeDirOf(sb), 'unread');
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 71, r.stderr);
    assert.match(r.stderr, /is a FAILED probe, not an absent one/);
    assert.equal(receipt.state, 'reserved', 'nothing terminal was published over a probe that failed');
  });

  it('a DANGLING SYMLINK at the capture path is a failed probe, never a clean empty report', async () => {
    // The trap the ENOENT split set for itself: readFileSync FOLLOWS the link, so a dangling one
    // reports ENOENT — indistinguishable from "the delegate wrote nothing" — and a corrupt capture
    // would be published as an empty report on a `success` receipt. lstat decides first.
    const sb = makeSandbox();
    const file = writeContract(sb, 'dangle');
    nodeShimWith(sb, 'dangling.cjs', `
const fs = require('node:fs');
const realLstat = fs.lstatSync;
fs.lstatSync = (target, ...rest) => {
  if (typeof target === 'string' && target.endsWith('final-message.txt')) {
    return { isFile: () => false, isSymbolicLink: () => true, isDirectory: () => false };
  }
  return realLstat(target, ...rest);
};
`);
    const r = await run(sb, { args: ['--nonce', 'dangle', file] });
    const receipt = readReceipt(storeDirOf(sb), 'dangle');
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 71, r.stderr);
    assert.match(r.stderr, /is a symlink, not a regular file — a CORRUPT capture is a FAILED probe/);
    assert.equal(receipt.state, 'reserved', 'nothing terminal was published over a corrupt capture');
  });

  it('a run that identified no session records sessionId null with outcome missing-identity', async () => {
    const sb = makeSandbox();
    const file = writeContract(sb, 'anon');
    const r = await run(sb, { args: ['--nonce', 'anon', file], env: { CODEX_FAKE_NO_THREAD: '1' } });
    const receipt = readReceipt(storeDirOf(sb), 'anon');
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(receipt.sessionId, null);
    assert.equal(receipt.outcome, 'missing-identity', 'exit 0 without an identity is never "success"');
  });

  it('a TIMEOUT publishes exitStatus 124 with outcome transport-failure', async () => {
    const sb = makeSandbox();
    const file = writeContract(sb, 'slow');
    const r = await runAsync(sb, {
      args: ['--nonce', 'slow', file],
      env: { CODEX_FAKE_SLEEP: '3', CODEX_HARD_TIMEOUT: '1' },
    });
    const receipt = readReceipt(storeDirOf(sb), 'slow');
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 124, r.stderr);
    assert.equal(receipt.exitStatus, 124);
    assert.equal(receipt.outcome, 'transport-failure', 'the timeout codes are transport-failure like any other nonzero exit');
    assert.match(r.stderr, /exceeded the hard cap/);
  });

  it('a FOREIGN owner refuses with NOTHING published — both artifacts stay byte-unchanged', async () => {
    const sb = makeSandbox();
    const file = writeContract(sb, 'tamper');
    const dir = storeDirOf(sb);
    const r = await run(sb, {
      args: ['--nonce', 'tamper', file],
      env: { CODEX_FAKE_TAMPER: join(dir, receiptName('tamper')), CODEX_FAKE_TAMPER_NONCE: 'tamper' },
    });
    const receipt = readFileSync(join(dir, receiptName('tamper')), 'utf8');
    const reportExists = existsSync(join(dir, reportName('tamper')));
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 70, r.stderr);
    assert.match(r.stderr, /is not this run’s reservation before any publication/);
    assert.match(JSON.parse(receipt).owner, /^a-foreign-run$/, 'the foreign reservation is left exactly as it was found');
    assert.equal(reportExists, false, 'a foreign owner publishes NOTHING — not even the report');
    assert.match(r.stderr, /PARTIALLY EDITED/, 'and the tree is named dirtied, never silently accepted');
  });

  it('a failed REPORT write exits 71 naming the report, and the reservation survives for --no-receipt', async () => {
    const sb = makeSandbox();
    const file = writeContract(sb, 'noreport');
    const dir = storeDirOf(sb);
    const r = await run(sb, {
      args: ['--nonce', 'noreport', file],
      env: { CODEX_FAKE_MKDIR: join(dir, reportName('noreport')) },
    });
    const receipt = readReceipt(dir, 'noreport');
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 71, r.stderr);
    assert.match(r.stderr, /the delegate’s report could not be published/);
    assert.equal(receipt.state, 'reserved', 'no terminal receipt EVER appears without a complete report behind it');
    assert.match(r.stderr, /dispatch return --nonce noreport --no-receipt --exit-status 0 --outcome <o>/);
  });

  it('an UNWRITABLE store directory stops the REPORT lane nonzero and says the tree is dirtied — NOT the review lane\'s warn-only receipt', async () => {
    // Named for the branch it really reaches. Both artifacts live in one directory, so a directory
    // turned read-only stops the FIRST write — the report. The two POST-report branches need a
    // failure injected between the writes, which the two tests below do.
    const sb = makeSandbox();
    const file = writeContract(sb, 'rodir');
    const store = join(sb.root, 'ledger');
    mkdirSync(store, { recursive: true });
    const r = await run(sb, {
      args: ['--nonce', 'rodir', file],
      env: { AW_DELEGATION_STORE: join(store, STORE_BASENAME), CODEX_FAKE_RO_DIR: store },
    });
    chmodSync(store, 0o700);
    const surviving = readReceipt(store, 'rodir');
    rmSync(sb.root, { recursive: true, force: true });
    assert.notEqual(r.status, 0, 'codex-review.sh warns and returns 0 here; the exec lane must not');
    assert.equal(r.status, 71, r.stderr);
    assert.match(r.stderr, /the delegate’s report could not be published/);
    assert.match(r.stderr, /Nothing beyond the reservation was published/);
    assert.match(r.stderr, /the working tree may be PARTIALLY EDITED/);
    assert.equal(surviving.state, 'reserved', 'the reservation survives, so --no-receipt can still absorb the thread');
  });
});

// ── the two POST-report branches ─────────────────────────────────────────────────────────────────
// Reaching them needs a failure BETWEEN the report write and the terminal replace, and no filesystem
// state a fixture can set up does that: both artifacts share one directory, so every such condition
// stops the report first. The failure is injected instead — through a `node` shim on the sandbox
// PATH, the SAME mechanism this suite already uses to exercise missing binaries. It is deliberately
// NOT NODE_OPTIONS: the wrapper CLEARS that for every mint core precisely so an inherited
// `--require` cannot rewrite `fs` under the owner checks and the publication, and a test that leaned
// on it would be testing a hole rather than the behaviour.
const nodeShimWith = (sb, name, body) => {
  const hook = join(sb.root, name);
  writeFileSync(hook, body);
  writeFileSync(join(sb.bin, 'node'), [
    '#!/usr/bin/env bash',
    'set -u',
    `exec ${process.execPath} --require ${hook} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
};

// Let the report rename through, then break the NEXT one — the terminal receipt is the only other
// `.json` rename the publisher performs.
const BREAK_RECEIPT_RENAME = `
const fs = require('node:fs');
const real = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to).endsWith('.json')) {
    const err = new Error('EACCES: injected terminal-receipt failure');
    err.code = 'EACCES';
    throw err;
  }
  return real(from, to);
};
`;

// Let the report rename through, then hand the SECOND owner check a foreign reservation.
const FORGE_SECOND_CLAIM = `
const fs = require('node:fs');
const realRead = fs.readFileSync;
const realRename = fs.renameSync;
let reportPublished = false;
fs.renameSync = (from, to) => {
  const out = realRename(from, to);
  if (String(to).endsWith('.txt')) reportPublished = true;
  return out;
};
fs.readFileSync = (target, ...rest) => {
  const bytes = realRead(target, ...rest);
  if (reportPublished && typeof target === 'string' && target.endsWith('.json')) {
    const held = JSON.parse(String(bytes));
    held.owner = 'a-foreign-run';
    return JSON.stringify(held);
  }
  return bytes;
};
`;

describe('codex-exec.sh — the POST-report failure lanes never claim an untouched tree', { concurrency: 2 }, () => {
  it('a terminal-receipt write that fails AFTER the report exits 71 and says the report IS published', async () => {
    const sb = makeSandbox();
    const file = writeContract(sb, 'postr');
    nodeShimWith(sb, 'break-receipt.cjs', BREAK_RECEIPT_RENAME);
    const dir = storeDirOf(sb);
    const r = await run(sb, { args: ['--nonce', 'postr', file] });
    const receipt = readReceipt(dir, 'postr');
    const report = readFileSync(join(dir, reportName('postr')), 'utf8');
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 71, r.stderr);
    assert.match(r.stderr, /the terminal exec receipt could not be published/);
    assert.match(r.stderr, /The REPORT is published; the terminal receipt was NOT completed/);
    assert.doesNotMatch(r.stderr, /NOTHING was published/, 'the message must not deny bytes that are on disk');
    assert.equal(report, 'FAKE_FINAL_MESSAGE\n', 'the published report is complete and readable');
    assert.equal(receipt.state, 'reserved', 'the replace never happened, so the reservation is what survives here');
  });

  it('a SECOND owner check that fails after the report exits 71 without claiming nothing was published', async () => {
    const sb = makeSandbox();
    const file = writeContract(sb, 'forge');
    nodeShimWith(sb, 'forge-owner.cjs', FORGE_SECOND_CLAIM);
    const dir = storeDirOf(sb);
    const r = await run(sb, { args: ['--nonce', 'forge', file] });
    const reportExists = existsSync(join(dir, reportName('forge')));
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 71, r.stderr);
    assert.match(r.stderr, /is not this run’s reservation immediately before the terminal replace: its owner token belongs to ANOTHER run/);
    assert.match(r.stderr, /The REPORT is published; the terminal receipt was NOT completed/);
    assert.doesNotMatch(r.stderr, /NOTHING was published/, 'after the report is on disk that claim is false');
    assert.equal(reportExists, true, 'and the report really is there — which is what the message says');
  });

  it('an inherited NODE_OPTIONS cannot reach the mint cores — the wrapper clears it', async () => {
    // The regression guard for the hole the two tests above used to lean on: a --require inherited
    // from the caller's environment could rewrite `fs` inside the owner checks and the publication.
    // Here the SAME preload that breaks the receipt rename is handed to the wrapper as NODE_OPTIONS
    // rather than through the PATH shim; the run must be entirely unaffected.
    const sb = makeSandbox();
    const file = writeContract(sb, 'envopt');
    const hook = join(sb.root, 'break-receipt.cjs');
    writeFileSync(hook, BREAK_RECEIPT_RENAME);
    const r = await run(sb, { args: ['--nonce', 'envopt', file], env: { NODE_OPTIONS: `--require=${hook}` } });
    const receipt = readReceipt(storeDirOf(sb), 'envopt');
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(receipt.state, 'terminal', 'the publication completed — the injected failure never reached it');
    assert.equal(receipt.outcome, 'success');
  });

  it('a FIRST owner check that fails is the only lane that may claim NOTHING was published', async () => {
    const sb = makeSandbox();
    const file = writeContract(sb, 'first');
    const dir = storeDirOf(sb);
    const r = await run(sb, {
      args: ['--nonce', 'first', file],
      env: { CODEX_FAKE_TAMPER: join(dir, receiptName('first')), CODEX_FAKE_TAMPER_NONCE: 'first' },
    });
    const reportExists = existsSync(join(dir, reportName('first')));
    rmSync(sb.root, { recursive: true, force: true });
    assert.equal(r.status, 70, r.stderr);
    assert.match(r.stderr, /NOTHING was published — not the report, not the receipt/);
    assert.doesNotMatch(r.stderr, /--no-receipt --exit-status/, 'a foreign reservation is never a --no-receipt source: its posture belongs to another run');
    assert.equal(reportExists, false);
  });
});

describe('codex-exec.sh — the inline node mint cores stay intact', { concurrency: 2 }, () => {
  it('the wrapper parses', async () => {
    // The apostrophe SCANNER this replaced is gone with the class it policed: every mint core now
    // rides a QUOTED heredoc, where an apostrophe is ordinary text. A scanner that had to model
    // shell quoting was a second parser for a problem the quoting choice created — and it had its own
    // blind spot (a JS line beginning `' ` read as a closing quote and ended the scan early).
    const syntax = spawnSync('bash', ['-n', WRAPPER], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  });

  it('every mint core is read by a BUILTIN, run with NODE_OPTIONS cleared, and asserted non-empty', async () => {
    const source = readFileSync(WRAPPER, 'utf8');
    assert.equal((source.match(/^ *IFS= read -r -d '' aw_js <<'AW_JS' \|\| true$/gm) ?? []).length, 4,
      'the four cores: the store-dir resolver, the contract header, the reservation, the terminal publication');
    assert.equal((source.match(/^AW_JS$/gm) ?? []).length, 4, 'each heredoc is terminated');
    assert.equal((source.match(/NODE_OPTIONS= node -e "\$aw_js"/g) ?? []).length, 4, 'every core runs with NODE_OPTIONS cleared');
    assert.equal((source.match(/aw_require_core "\$aw_js"/g) ?? []).length, 4, 'and none runs before it is proven non-empty');
    // The regressions this replaces, both live: a single-quoted -e string truncates on an apostrophe,
    // and a `$(cat …)` substitution turns a missing `cat` into `node -e ""` exiting 0 — a run that
    // publishes nothing and reports success.
    assert.equal((source.match(/node -e '/g) ?? []).length, 0, 'no core may go back to a single-quoted -e string');
    assert.equal((source.match(/node -e "\$\(cat/g) ?? []).length, 0, 'no core may go back to a cat substitution');
  });
});
