import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readdirSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(HERE, 'agy.sh');

// Build a sandbox HOME whose ~/.local/bin holds a STUB `agy`. The wrapper prepends
// "$HOME/.local/bin" to PATH, so it resolves our stub instead of the real binary — no network,
// no real subscription CLI, fully hermetic.
const makeSandbox = (stubBody) => {
  const home = mkdtempSync(join(tmpdir(), 'agy-wrapper-test-'));
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, 'agy');
  writeFileSync(stub, stubBody, { mode: 0o755 });
  chmodSync(stub, 0o755);
  return home;
};

const runWrapper = (home, env, prompt = 'hello') =>
  spawnSync('bash', [WRAPPER, prompt], {
    env: { HOME: home, PATH: `${join(home, '.local', 'bin')}:${process.env.PATH}`, ...env },
    encoding: 'utf8',
    timeout: 20000,
  });

describe('agy.sh — hard wall-clock cap (timeout(1))', () => {
  it('kills a hung agy at AGY_HARD_TIMEOUT and reports it (non-zero + actionable guidance)', () => {
    const home = makeSandbox('#!/usr/bin/env bash\nsleep 30\n');
    const started = Date.now();
    const r = runWrapper(home, { AGY_HARD_TIMEOUT: '2s', AGY_TIMEOUT: '2s', AGY_MODEL: '' });
    const elapsed = Date.now() - started;
    rmSync(home, { recursive: true, force: true });
    assert.ok(elapsed < 13000, `wrapper must return well under the kill-after window, took ${elapsed}ms`);
    assert.notEqual(r.status, 0, 'a timed-out run must exit non-zero');
    assert.match(r.stderr, /exceeded the hard cap/, 'must explain the hard-cap kill');
  });

  it('passes a fast agy run through unchanged (exit 0, stdout preserved)', () => {
    const home = makeSandbox('#!/usr/bin/env bash\necho "OK reply"\nexit 0\n');
    const r = runWrapper(home, { AGY_HARD_TIMEOUT: '10s', AGY_TIMEOUT: '10s', AGY_MODEL: '' });
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 0, `expected clean exit, got ${r.status}; stderr=${r.stderr}`);
    assert.match(r.stdout, /OK reply/);
  });

  it('propagates a non-timeout agy failure code verbatim (no false hard-cap message)', () => {
    const home = makeSandbox('#!/usr/bin/env bash\necho "boom" >&2\nexit 3\n');
    const r = runWrapper(home, { AGY_HARD_TIMEOUT: '10s', AGY_TIMEOUT: '10s', AGY_MODEL: '' });
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 3, 'a genuine agy failure code must pass through');
    assert.doesNotMatch(r.stderr, /exceeded the hard cap/, 'must not mislabel a non-timeout failure');
  });
});

// A stub that records (via a SENTINEL file) whether agy was actually invoked, so a
// "guard fires" test can prove the wrapper exited BEFORE spending a run. When the
// argv-byte guard trips, the sentinel must be absent.
const RECORDING_STUB = [
  '#!/usr/bin/env bash',
  'if [[ -n "${AGY_STUB_SENTINEL:-}" ]]; then printf invoked > "$AGY_STUB_SENTINEL"; fi',
  'echo "OK reply"',
  'exit 0',
  '',
].join('\n');

// Run the wrapper with an explicit argv (so a `@file` / `-` prompt form can be passed)
// and optional stdin. AGY_MODEL='' drops --model so the stub argv stays clean.
const runArgs = (home, { args, env = {}, input } = {}) =>
  spawnSync('bash', [WRAPPER, ...args], {
    env: { HOME: home, PATH: `${join(home, '.local', 'bin')}:${process.env.PATH}`, AGY_MODEL: '', ...env },
    encoding: 'utf8',
    timeout: 20000,
    input,
  });

describe('agy.sh — argv byte-ceiling guard (AGY_MAX_PROMPT_BYTES)', () => {
  const withSentinel = (home) => join(home, 'sentinel');

  it('fires for an @file prompt over a lowered cap (exit 2; agy never invoked)', () => {
    const home = makeSandbox(RECORDING_STUB);
    const big = join(home, 'big.md');
    writeFileSync(big, 'x'.repeat(500));
    const sentinel = withSentinel(home);
    const r = runArgs(home, { args: [`@${big}`], env: { AGY_MAX_PROMPT_BYTES: '100', AGY_STUB_SENTINEL: sentinel } });
    const invoked = existsSync(sentinel);
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /over AGY_MAX_PROMPT_BYTES=100/);
    assert.equal(invoked, false, 'agy must NOT be invoked when the size guard fires');
  });

  it('fires for a stdin (-) prompt over a lowered cap (exit 2; agy never invoked)', () => {
    const home = makeSandbox(RECORDING_STUB);
    const sentinel = withSentinel(home);
    const r = runArgs(home, { args: ['-'], input: 'y'.repeat(500), env: { AGY_MAX_PROMPT_BYTES: '100', AGY_STUB_SENTINEL: sentinel } });
    const invoked = existsSync(sentinel);
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /over AGY_MAX_PROMPT_BYTES=100/);   // same headline as the @file case
    assert.match(r.stderr, /Argument list too long/);         // plus the guidance line
    assert.equal(invoked, false, 'agy must NOT be invoked when the size guard fires');
  });

  it('passes a normal prompt through unchanged under the default ceiling', () => {
    const home = makeSandbox(RECORDING_STUB);
    const sentinel = withSentinel(home);
    const r = runArgs(home, { args: ['a short prompt'], env: { AGY_STUB_SENTINEL: sentinel } });
    const invoked = existsSync(sentinel);
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OK reply/);
    assert.equal(invoked, true, 'a within-ceiling prompt must reach agy');
  });

  it('an AGY_MAX_PROMPT_BYTES override raises the ceiling so a large prompt passes', () => {
    const home = makeSandbox(RECORDING_STUB);
    const big = join(home, 'big.md');
    writeFileSync(big, 'z'.repeat(500));
    const sentinel = withSentinel(home);
    const r = runArgs(home, { args: [`@${big}`], env: { AGY_MAX_PROMPT_BYTES: '10000', AGY_STUB_SENTINEL: sentinel } });
    const invoked = existsSync(sentinel);
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(invoked, true, 'the raised ceiling must let the large prompt through');
  });

  it('rejects a non-integer AGY_MAX_PROMPT_BYTES (exit 2; agy never invoked)', () => {
    const home = makeSandbox(RECORDING_STUB);
    const sentinel = withSentinel(home);
    const r = runArgs(home, { args: ['hi'], env: { AGY_MAX_PROMPT_BYTES: 'abc', AGY_STUB_SENTINEL: sentinel } });
    const invoked = existsSync(sentinel);
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /not a non-negative integer/);
    assert.equal(invoked, false, 'a malformed ceiling must fail loud before invoking agy');
  });

  it('rejects an AGY_MAX_PROMPT_BYTES raised above the OS single-argv ceiling (exit 2; agy never invoked)', () => {
    const home = makeSandbox(RECORDING_STUB);
    const sentinel = withSentinel(home);
    const r = runArgs(home, { args: ['hi'], env: { AGY_MAX_PROMPT_BYTES: '200000', AGY_STUB_SENTINEL: sentinel } });
    const invoked = existsSync(sentinel);
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /exceeds the OS single-argv ceiling/);
    assert.equal(invoked, false, 'raising the ceiling past the OS limit must fail loud, not pass through to E2BIG');
  });
});

// ── --help (candidate C only — the probe role is not dispatched by any activity
// slot, so this help is authored in the wrapper, NOT manifest-pinned; the lighter
// guard pins pre-preflight reachability + the documented usage forms). ──────────

// A PATH farm mirroring the real one MINUS the named binaries — so the reachability claim
// ("--help needs no agy/git") holds even on a host that has the real CLIs installed.
// Ported from agy-review.test.mjs (inline: each bridge test file stays standalone).
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

describe('agy.sh — --help (pre-preflight, candidate C)', () => {
  it('--help and -h exit 0 with NO agy on PATH and name the documented usage', () => {
    for (const arg of ['--help', '-h']) {
      // A bare HOME with no ~/.local/bin/agy stub AND a PATH farm stripped of agy/git —
      // the help must not need the CLI even when the host has a real agy installed.
      const home = mkdtempSync(join(tmpdir(), 'agy-help-'));
      const r = spawnSync('bash', [WRAPPER, arg], {
        env: { HOME: home, PATH: makePathWithout(home, ['agy', 'git']) },
        encoding: 'utf8',
        timeout: 15000,
      });
      rmSync(home, { recursive: true, force: true });
      assert.equal(r.status, 0, `${arg}: ${r.stderr}`);
      assert.equal(r.stderr, '', `${arg} prints nothing to stderr`);
      assert.match(r.stdout, /Usage:/);
      assert.match(r.stdout, /agy-run "your prompt"/);
      assert.match(r.stdout, /agy-run @path\/to\/prompt\.md/);
      assert.match(r.stdout, /agy-run <prompt\|-\|@file> -- <extra agy flags\.\.\.>/);
    }
  });

  it('--help after the -- separator is passthrough payload, never intercepted', () => {
    const home = makeSandbox(RECORDING_STUB);
    const sentinel = join(home, 'sentinel');
    const r = runArgs(home, { args: ['prompt', '--', '--help'], env: { AGY_STUB_SENTINEL: sentinel } });
    const invoked = existsSync(sentinel);
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Usage:/, 'help is keyed on the FIRST argument only');
    assert.equal(invoked, true, 'the run must proceed to agy with the payload');
  });
});

// ── bridge settings file (bridges 2.3.0) ─────────────────────────────────────────
// ${XDG_CONFIG_HOME:-$HOME/.config}/agent-workflow/bridge-settings.conf holds KEY=VALUE
// lines, PARSED (never sourced). Precedence: explicit env (even empty: KEY= disables the
// knob) > file > built-in default. agy-run APPLIES only AGY_HARD_TIMEOUT and RECOGNIZES
// the whole registry. HOME is the sandbox home, so the default path is hermetic per test.

const writeSettings = (home, text) => {
  const dir = join(home, '.config', 'agent-workflow');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'bridge-settings.conf');
  writeFileSync(file, text);
  return file;
};
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('agy.sh — bridge settings file (bridges 2.3.0)', () => {
  it('a file-set AGY_HARD_TIMEOUT is effective (killed at the file cap)', () => {
    const home = makeSandbox('#!/usr/bin/env bash\nsleep 5\n');
    writeSettings(home, 'AGY_HARD_TIMEOUT=2s\n');
    const r = runWrapper(home, { AGY_MODEL: '' });
    rmSync(home, { recursive: true, force: true });
    assert.notEqual(r.status, 0, 'the file cap must apply when the env is unset');
    assert.match(r.stderr, /exceeded the hard cap AGY_HARD_TIMEOUT=2s/);
  });

  it('env overrides file: env=2s file=10m → killed at the env cap', () => {
    const home = makeSandbox('#!/usr/bin/env bash\nsleep 5\n');
    writeSettings(home, 'AGY_HARD_TIMEOUT=10m\n');
    const r = runWrapper(home, { AGY_HARD_TIMEOUT: '2s', AGY_TIMEOUT: '2s', AGY_MODEL: '' });
    rmSync(home, { recursive: true, force: true });
    assert.notEqual(r.status, 0, 'the env cap (2s) must win over the file cap (10m)');
    assert.match(r.stderr, /exceeded the hard cap AGY_HARD_TIMEOUT=2s/);
  });

  it('an EXPLICITLY EMPTY env (AGY_HARD_TIMEOUT=) disables the file knob for one run', () => {
    const home = makeSandbox('#!/usr/bin/env bash\nsleep 3\necho "OK reply"\n');
    writeSettings(home, 'AGY_HARD_TIMEOUT=2s\n');
    const r = runWrapper(home, { AGY_HARD_TIMEOUT: '', AGY_MODEL: '' });
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 0, `built-in default must apply (not the 2s file cap): ${r.stderr}`);
    assert.match(r.stdout, /OK reply/);
  });

  it('duplicate key → the LAST occurrence wins (10m then 2s → killed at 2s)', () => {
    const home = makeSandbox('#!/usr/bin/env bash\nsleep 5\n');
    writeSettings(home, 'AGY_HARD_TIMEOUT=10m\nAGY_HARD_TIMEOUT=2s\n');
    const r = runWrapper(home, { AGY_MODEL: '' });
    rmSync(home, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /exceeded the hard cap AGY_HARD_TIMEOUT=2s/);
  });

  it('an invalid duration warns and falls back to the built-in default', () => {
    const home = makeSandbox(RECORDING_STUB);
    writeSettings(home, 'AGY_HARD_TIMEOUT=abc\n');
    const r = runWrapper(home, { AGY_MODEL: '' });
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /invalid value 'abc'/);
    assert.match(r.stdout, /OK reply/);
  });

  it('a bare-integer duration (no unit suffix) is invalid → warn + built-in default', () => {
    const home = makeSandbox(RECORDING_STUB);
    writeSettings(home, 'AGY_HARD_TIMEOUT=90\n');
    const r = runWrapper(home, { AGY_MODEL: '' });
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /invalid value '90'/, 'duration values require a unit suffix (5m/30m/90s)');
    assert.match(r.stdout, /OK reply/);
  });

  it('a ZERO duration is invalid — timeout 0 would silently DISABLE the hard cap', () => {
    const home = makeSandbox(RECORDING_STUB);
    writeSettings(home, 'AGY_HARD_TIMEOUT=0s\n');
    const r = runWrapper(home, { AGY_MODEL: '' });
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /invalid value '0s'/, 'a persistent settings line must never remove the stall guard');
    assert.match(r.stdout, /OK reply/);
  });

  it('a DIRECTORY at the settings path warns loudly and falls back to built-ins (no crash)', () => {
    const home = makeSandbox(RECORDING_STUB);
    mkdirSync(join(home, '.config', 'agent-workflow', 'bridge-settings.conf'), { recursive: true });
    const r = runWrapper(home, { AGY_MODEL: '' });
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 0, `a directory must degrade honestly, not kill the run: ${r.stderr}`);
    assert.match(r.stderr, /unreadable or not a regular file/);
    assert.doesNotMatch(r.stderr, /Is a directory/, 'no raw bash error may leak');
    assert.match(r.stdout, /OK reply/);
  });

  it("another bridge's valid key is skipped silently (and never applied)", () => {
    const home = makeSandbox('#!/usr/bin/env bash\nsleep 3\necho "OK reply"\n');
    writeSettings(home, 'CODEX_SERVICE_TIER=priority\nCODEX_HARD_TIMEOUT=2\n');
    const r = runWrapper(home, { AGY_MODEL: '' });
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 0, `a codex key must not cap an agy run: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /bridge settings/, 'a recognized non-applied key earns NO warning');
    assert.match(r.stdout, /OK reply/);
  });

  it('a truly unknown key warns ONCE naming the file; the run is unaffected', () => {
    const home = makeSandbox(RECORDING_STUB);
    writeSettings(home, 'TOTALLY_UNKNOWN=1\nTOTALLY_UNKNOWN=2\n');
    const r = runWrapper(home, { AGY_MODEL: '' });
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    const warns = r.stderr.match(/unknown key 'TOTALLY_UNKNOWN'/g) ?? [];
    assert.equal(warns.length, 1, `exactly one warning per unknown key, got ${warns.length}`);
    assert.match(r.stderr, /bridge-settings\.conf/, 'the warning must name the settings file');
    assert.match(r.stdout, /OK reply/);
  });

  it('malformed lines warn and are ignored; comments and blank lines are silent', () => {
    const home = makeSandbox(RECORDING_STUB);
    writeSettings(home, '# a comment\n\nNOT A KEY VALUE LINE\n');
    const r = runWrapper(home, { AGY_MODEL: '' });
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    const malformed = r.stderr.match(/malformed line/g) ?? [];
    assert.equal(malformed.length, 1, 'comments/blank lines must NOT count as malformed');
    assert.match(r.stdout, /OK reply/);
  });

  it('an existing-but-unreadable file warns loudly and falls back to built-ins', { skip: isRoot }, () => {
    const home = makeSandbox(RECORDING_STUB);
    const file = writeSettings(home, 'AGY_HARD_TIMEOUT=2s\n');
    chmodSync(file, 0o000);
    const r = runWrapper(home, { AGY_MODEL: '' });
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /unreadable/);
    assert.match(r.stdout, /OK reply/);
  });

  it('a settings line can NEVER execute code (command-substitution payload inert)', () => {
    const home = makeSandbox(RECORDING_STUB);
    const pwned = join(home, 'pwned');
    writeSettings(home, `AGY_HARD_TIMEOUT=$(touch ${pwned})\nEVIL_KEY=\`touch ${pwned}2\`\n`);
    const r = runWrapper(home, { AGY_MODEL: '' });
    const executed = existsSync(pwned) || existsSync(`${pwned}2`);
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(executed, false, 'file content must be parsed, never evaluated');
    assert.match(r.stdout, /OK reply/);
  });

  it('no file → byte-identical behaviour to today (no settings chatter)', () => {
    const home = makeSandbox(RECORDING_STUB);
    const r = runWrapper(home, { AGY_MODEL: '' });
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /bridge settings/);
    assert.match(r.stdout, /OK reply/);
  });
});

// ── settings surface ⟷ manifest (drift guard, D6) ────────────────────────────────
// agy-run's --help stays candidate-C (not contract-pinned), but its SETTINGS surface
// is manifest-pinned like the other three wrappers: the Settings help section and the
// shell constants (registry / applied subset / typed validation arms) stay set-equal
// to the bridges' capability.json `settings` blocks. The sibling manifest path
// resolves identically in the repo layout and in the kit's bridges/ mirror layout.
const SETTINGS_HEADER = 'Settings file (KEY=VALUE, parsed never sourced; env wins over file, file wins over built-in default):';
const MANIFEST = JSON.parse(readFileSync(join(HERE, '..', 'capability.json'), 'utf8'));
const SIBLING_MANIFEST = JSON.parse(readFileSync(join(HERE, '..', '..', 'codex-cli-bridge', 'capability.json'), 'utf8'));
const ALL_SETTINGS = [...(MANIFEST.settings ?? []), ...(SIBLING_MANIFEST.settings ?? [])];
const SETTINGS_CMD = 'agy-run';
const setEq = (got, want, msg) => assert.deepEqual([...got].sort(), [...want].sort(), msg);
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

describe('agy.sh — settings surface ⟷ manifest (D6, manifest-pinned)', () => {
  const runHelpText = () => {
    const home = mkdtempSync(join(tmpdir(), 'agy-settings-help-'));
    const r = spawnSync('bash', [WRAPPER, '--help'], {
      env: { HOME: home, PATH: makePathWithout(home, ['agy', 'git']) },
      encoding: 'utf8',
      timeout: 15000,
    });
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };

  it('--help Settings section keys set-EQUAL the manifest appliesTo subset', () => {
    const section = helpSection(runHelpText(), SETTINGS_HEADER);
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
