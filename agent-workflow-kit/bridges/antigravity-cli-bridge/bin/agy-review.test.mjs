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
const WRAPPER = join(HERE, 'agy-review.sh');

// Hermetic fake `agy`. PORTING TRAP: agy takes the prompt as the `-p` ARGV value, NOT stdin — so the
// fake captures the -p value from argv (a stdin capture would make every prompt assertion vacuous).
// It also records full argv, a couple of env vars, an invocation sentinel, and — for the oversized
// --add-dir escape — the staging dir's perms + the offloaded artifact's perms/contents WHILE they
// still exist (agy-review's trap removes the staging dir on exit). Kept inline so the file is
// standalone (the kit mirror is byte-equality; no shared helper grows that set).
const FAKE_AGY = [
  '#!/usr/bin/env bash',
  'set -u',
  ': "${AGY_FAKE_ARGV:=/dev/null}"',
  ': "${AGY_FAKE_ENV:=/dev/null}"',
  ': "${AGY_FAKE_PROMPT:=/dev/null}"',
  ': "${AGY_FAKE_SENTINEL:=/dev/null}"',
  'printf invoked > "$AGY_FAKE_SENTINEL"',
  '{ for a in "$@"; do printf "%s\\n" "$a"; done; } > "$AGY_FAKE_ARGV"',
  '{ echo "FOO_API_KEY=${FOO_API_KEY:-<unset>}"; echo "ANTIGRAVITY_API_KEY=${ANTIGRAVITY_API_KEY:-<unset>}"; } > "$AGY_FAKE_ENV"',
  'prev=""; for a in "$@"; do [[ "$prev" == "-p" ]] && printf "%s" "$a" > "$AGY_FAKE_PROMPT"; prev="$a"; done',
  'prev=""; for a in "$@"; do',
  '  if [[ "$prev" == "--add-dir" ]]; then',
  '    printf "%s" "$a" > "${AGY_FAKE_ADDDIR:-/dev/null}"',
  '    stat -c "%a" "$a" > "${AGY_FAKE_ADDDIR_MODE:-/dev/null}" 2>/dev/null || true',
  '    art="$a/precomputed-change-set"',
  '    if [[ -f "$art" ]]; then stat -c "%a" "$art" > "${AGY_FAKE_ARTIFACT_MODE:-/dev/null}" 2>/dev/null || true; cp "$art" "${AGY_FAKE_ARTIFACT_COPY:-/dev/null}" 2>/dev/null || true; fi',
  '  fi; prev="$a"',
  'done',
  'if [[ -n "${AGY_FAKE_SLEEP:-}" ]]; then sleep "$AGY_FAKE_SLEEP"; fi',
  'echo "FAKE_AGY_REVIEW_OUTPUT"',
  'exit "${AGY_FAKE_EXIT:-0}"',
  '',
].join('\n');

// A PATH whose entries are symlinks to the real PATH binaries EXCEPT the excluded names. Excluding
// `agy-run` forces agy-review onto its `$HERE/agy.sh` fallback (the repo's CURRENT agy.sh, not a
// possibly-stale installed one), keeping the test hermetic; excluding `agy` ensures the only agy is
// our fake (prepended via $HOME/.local/bin). Ported from codex-review.test.mjs.
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

// `clean: true` leaves a pristine committed tree (for the no-diff preflight); the default leaves one
// untracked file so `code` mode has a diff to review.
const makeSandbox = ({ clean = false } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'agy-review-test-'));
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, 'agy');
  writeFileSync(stub, FAKE_AGY, { mode: 0o755 });
  chmodSync(stub, 0o755);
  const repo = join(home, 'repo');
  mkdirSync(repo);
  const g = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'probe@example.com');
  g('config', 'user.name', 'probe');
  writeFileSync(join(repo, 'base.txt'), 'committed base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  if (!clean) writeFileSync(join(repo, 'pending.txt'), 'PENDING_UNTRACKED_BODY\n');
  return { home, bin, repo, g };
};

const run = (sb, { args, env = {}, cwd } = {}) => {
  const { home, bin, repo } = sb;
  const farm = makePathWithout(home, ['agy', 'agy-run']);
  const cap = {
    argv: join(home, 'cap-argv'), env: join(home, 'cap-env'), prompt: join(home, 'cap-prompt'),
    sentinel: join(home, 'cap-sentinel'), adddir: join(home, 'cap-adddir'),
    adddirMode: join(home, 'cap-adddir-mode'), artifactMode: join(home, 'cap-artifact-mode'),
    artifactCopy: join(home, 'cap-artifact-copy'),
  };
  const r = spawnSync('bash', [WRAPPER, ...args], {
    cwd: cwd || repo,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      HOME: home,
      PATH: `${bin}:${farm}`,
      AGY_FAKE_ARGV: cap.argv, AGY_FAKE_ENV: cap.env, AGY_FAKE_PROMPT: cap.prompt,
      AGY_FAKE_SENTINEL: cap.sentinel, AGY_FAKE_ADDDIR: cap.adddir, AGY_FAKE_ADDDIR_MODE: cap.adddirMode,
      AGY_FAKE_ARTIFACT_MODE: cap.artifactMode, AGY_FAKE_ARTIFACT_COPY: cap.artifactCopy,
      ...env,
    },
  });
  const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  return {
    ...r,
    invoked: existsSync(cap.sentinel),
    argv: readIf(cap.argv), capEnv: readIf(cap.env), prompt: readIf(cap.prompt),
    adddir: readIf(cap.adddir).trim(), adddirMode: readIf(cap.adddirMode).trim(),
    artifactMode: readIf(cap.artifactMode).trim(), artifactCopy: readIf(cap.artifactCopy),
  };
};

describe('agy-review.sh — model policy advisory (1)', () => {
  it('warns for a non-frontier model but still runs', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_MODEL: 'Gemini 3.5 Flash (Low)' } });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /non-frontier model 'Gemini 3.5 Flash \(Low\)'/);
    assert.equal(r.invoked, true, 'a non-frontier model still runs (advisory, not a gate)');
    assert.match(r.argv, /Gemini 3\.5 Flash \(Low\)/, 'the chosen model reaches agy via --model');
  });

  it('AGY_PROBE=1 silences the advisory', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_MODEL: 'Gemini 3.5 Flash (Low)', AGY_PROBE: '1' } });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /non-frontier model/);
  });

  it('the frontier default (no AGY_MODEL) earns no advisory', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'a tiny fact'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /non-frontier model/);
    assert.match(r.argv, /Gemini 3\.1 Pro \(High\)/, 'the frontier default reaches agy');
  });
});

describe('agy-review.sh — guard + grounding (2, 3)', () => {
  it('the model/cutoff GUARD line is in the captured prompt', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'a tiny fact'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.match(r.prompt, /Do NOT comment on AI model names\/versions or your own knowledge cutoff/);
  });

  it('--facts / --decided / --focus all reach the prompt', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: [
      'code', '--facts', 'GROUNDED_FACT_MARKER', '--decided', 'DECIDED_MARKER', '--focus', 'FOCUS_MARKER',
    ] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.prompt, /Grounded facts — review AGAINST these/);
    assert.match(r.prompt, /GROUNDED_FACT_MARKER/);
    assert.match(r.prompt, /do NOT re-raise these/);
    assert.match(r.prompt, /DECIDED_MARKER/);
    assert.match(r.prompt, /## Focus\nFOCUS_MARKER/);
  });

  it('--facts @file reads the file; --decided @file too', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'facts.md'), 'FILE_FACT_BODY\n');
    writeFileSync(join(sb.repo, 'decided.md'), 'FILE_DECIDED_BODY\n');
    const r = run(sb, { args: ['code', '--facts', '@facts.md', '--decided', '@decided.md'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.prompt, /FILE_FACT_BODY/);
    assert.match(r.prompt, /FILE_DECIDED_BODY/);
  });

  it('merges --focus and trailing focus words into one Focus block, in parse order', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'f', '--focus', 'first', 'second', 'third'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.prompt, /## Focus\nfirst second third/);
  });

  it('warns LOUDLY when --facts is omitted, and proceeds', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /no --facts supplied/);
    assert.equal(r.invoked, true, 'an ungrounded review still proceeds (warn, not block)');
    assert.match(r.prompt, /none supplied/, 'the prompt notes the missing facts in-band');
  });
});

describe('agy-review.sh — code-mode precomputed diff (4, 5, 8)', () => {
  it('assembles repo map + status + untracked CONTENTS', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'untra.txt'), 'UNIQUE_UNTRACKED_BODY\n');
    const r = run(sb, { args: ['code', '--facts', 'f'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    for (const sec of [/repo file map/, /git status/, /untracked: untra\.txt/, /UNIQUE_UNTRACKED_BODY/]) {
      assert.match(r.prompt, sec);
    }
  });

  it('skips a binary untracked file (noted; raw bytes not inlined)', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x42]));
    const r = run(sb, { args: ['code', '--facts', 'f'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.match(r.prompt, /binary, skipped\): blob\.bin/);
  });

  it('does not follow an untracked symlink (no out-of-tree leak)', () => {
    const sb = makeSandbox();
    const secret = join(sb.home, 'outside-secret.txt'); // OUTSIDE the repo
    writeFileSync(secret, 'TOP_SECRET_LEAK_MARKER\n');
    symlinkSync(secret, join(sb.repo, 'link-to-outside'));
    const r = run(sb, { args: ['code', '--facts', 'f'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.match(r.prompt, /untracked \(symlink\): link-to-outside -> /);
    assert.doesNotMatch(r.prompt, /TOP_SECRET_LEAK_MARKER/, 'symlink target content must never leak');
  });

  it('handles untracked paths with spaces (NUL-safe)', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'a b c.txt'), 'SPACED_BODY\n');
    const r = run(sb, { args: ['code', '--facts', 'f'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.match(r.prompt, /untracked: a b c\.txt/);
    assert.match(r.prompt, /SPACED_BODY/);
  });

  it('no-diff preflight: a clean tree exits 0 without invoking agy', () => {
    const sb = makeSandbox({ clean: true });
    const r = run(sb, { args: ['code', '--facts', 'f'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /no uncommitted changes to review/);
    assert.equal(r.invoked, false, 'agy must NOT be invoked on a clean tree');
  });

  it('the strict output-shape footer is present in a fresh review', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'f'] });
    rmSync(sb.home, { recursive: true, force: true });
    for (const sec of [/### Verdict/, /### Blocking/, /### Non-blocking/, /### Questions/]) {
      assert.match(r.prompt, sec);
    }
  });
});

describe('agy-review.sh — size ceiling + gated --add-dir escape (6)', () => {
  it('default: oversized prompt exits 2 with guidance, agy not invoked', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'f'], env: { AGY_MAX_PROMPT_BYTES: '50' } });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /over AGY_MAX_PROMPT_BYTES=50/);
    assert.match(r.stderr, /Trim to the relevant hunks/);
    assert.equal(r.invoked, false, 'an oversized prompt must not spend a run by default');
  });

  // A ceiling ABOVE the grounding-only prompt (~1.3 KB) but BELOW the full prompt (a big artifact),
  // so the escape can actually offload the artifact while the grounding still fits inline.
  it('AGY_REVIEW_ALLOW_ADDDIR=1: offloads the artifact to a 0700/0600 staging dir via --add-dir', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'unique.txt'), `OVERSIZE_UNIQUE_MARKER\n${'x'.repeat(8000)}\n`);
    const r = run(sb, { args: ['code', '--facts', 'f'], env: { AGY_MAX_PROMPT_BYTES: '2000', AGY_REVIEW_ALLOW_ADDDIR: '1' } });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.invoked, true, 'the escape hatch lets the run proceed');
    assert.match(r.argv, /--add-dir/, 'agy is given --add-dir');
    assert.ok(r.adddir && !r.adddir.includes('.git'), `--add-dir must NOT point at .git (got ${r.adddir})`);
    assert.ok(r.adddir && r.adddir !== sb.repo, '--add-dir must NOT be the work tree');
    assert.equal(r.adddirMode, '700', 'the staging dir must be mode 0700');
    assert.equal(r.artifactMode, '600', 'the offloaded artifact must be mode 0600');
    assert.match(r.artifactCopy, /OVERSIZE_UNIQUE_MARKER/, 'the artifact file holds the full change set');
    assert.match(r.prompt, /Grounded facts/, 'the -p prompt STILL carries the full grounding inline');
    assert.doesNotMatch(r.prompt, /repo file map/, 'the artifact is offloaded, not inlined into -p');
    assert.match(r.stderr, /RE-ENABLES the Issue-001 stall risk/);
  });

  it('the staging dir is trap-cleaned on exit (no leftover after the run)', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'unique.txt'), `MARKER\n${'x'.repeat(8000)}\n`);
    const r = run(sb, { args: ['code', '--facts', 'f'], env: { AGY_MAX_PROMPT_BYTES: '2000', AGY_REVIEW_ALLOW_ADDDIR: '1' } });
    const stagingPath = r.adddir;
    const stillThere = stagingPath ? existsSync(stagingPath) : false;
    rmSync(sb.home, { recursive: true, force: true });
    assert.ok(stagingPath, 'the escape must have fired (a staging path was captured)');
    assert.equal(stillThere, false, 'the private staging dir must be removed by the EXIT trap');
  });
});

describe('agy-review.sh — resume / round-2 delta (7)', () => {
  it('--continue takes NO mode, sends a delta (shape + focus + decided), never re-embeds the artifact', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'decided.md'), 'ALREADY_DECIDED_ITEM\n');
    const r = run(sb, { args: ['--continue', '--decided', '@decided.md', '--focus', 'ROUND2_FOCUS'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.argv, /(^|\n)--continue(\n|$)/, 'agy is continued');
    assert.match(r.prompt, /CONTINUE the review you already started/, 'the resume reminder restates posture');
    assert.match(r.prompt, /### Verdict/, 'the delta restates the output shape so round-2 formatting holds');
    assert.match(r.prompt, /ROUND2_FOCUS/);
    assert.match(r.prompt, /ALREADY_DECIDED_ITEM/);
    assert.doesNotMatch(r.prompt, /repo file map/, 'a continuation must NOT re-assemble the artifact');
  });

  it('--continue rejects a mode token and rejects --facts', () => {
    const sb = makeSandbox();
    const r1 = run(sb, { args: ['--continue', 'code'] });
    const r2 = run(sb, { args: ['--continue', '--facts', 'x'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r1.status, 2);
    assert.match(r1.stderr, /takes no positional args/);
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /--facts is not valid on a continuation/);
  });

  it('--conversation <id> threads the id through to agy', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['--conversation', 'conv-xyz', '--focus', 'f'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.argv, /(^|\n)--conversation(\n|$)/);
    assert.match(r.argv, /(^|\n)conv-xyz(\n|$)/);
  });
});

describe('agy-review.sh — delegated guards inherited via agy-run (9, 10)', () => {
  it('hard timeout: a sleeping stub is killed at AGY_HARD_TIMEOUT', () => {
    const sb = makeSandbox();
    const started = Date.now();
    const r = run(sb, { args: ['code', '--facts', 'f'], env: { AGY_FAKE_SLEEP: '30', AGY_HARD_TIMEOUT: '2s', AGY_TIMEOUT: '2s' } });
    const elapsed = Date.now() - started;
    rmSync(sb.home, { recursive: true, force: true });
    assert.ok(elapsed < 20000, `must return well under the kill-after window, took ${elapsed}ms`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /exceeded the hard cap/);
  });

  it('subscription invariant: a stray FOO_API_KEY is unset for the agy subprocess', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'f'], env: { FOO_API_KEY: 'bar', ANTIGRAVITY_API_KEY: 'baz' } });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.capEnv, /^FOO_API_KEY=<unset>$/m);
    assert.match(r.capEnv, /^ANTIGRAVITY_API_KEY=<unset>$/m);
  });
});

describe('agy-review.sh — mode / arg validation (11)', () => {
  it('unknown mode → usage + exit 2', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['bogus'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage:/);
    assert.equal(r.invoked, false);
  });

  it('plan mode with a missing file → exit 2', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['plan', 'nope.md'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /plan file 'nope\.md' not found/);
  });

  it('diff mode inlines the supplied file', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'change.diff'), 'DIFF_FILE_BODY_MARKER\n');
    const r = run(sb, { args: ['diff', 'change.diff', '--facts', 'f'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.prompt, /The diff under review/);
    assert.match(r.prompt, /DIFF_FILE_BODY_MARKER/);
  });

  it('rejects a stray -- passthrough (the wrapper owns the posture)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--', '--add-dir', '.'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /this wrapper OWNS the review posture/);
  });

  it('rejects a value-flag that swallows the NEXT flag as its value (--facts --focus x → exit 2)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', '--focus', 'x'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--facts needs a value/);
    assert.equal(r.invoked, false, 'a misplaced flag must not be spent as bogus grounding');
  });

  it('rejects a value-flag with no value at the end of args (--decided → exit 2)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'f', '--decided'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--decided needs a value/);
  });
});

describe('agy-review.sh — no-env run (12)', () => {
  it('a code review with NO AGY_* env vars runs cleanly (no unbound-var abort under set -u)', () => {
    const sb = makeSandbox();
    // run() sets only HOME/PATH + the AGY_FAKE_* capture vars (not AGY_* config) — so this exercises
    // the all-defaults path.
    const r = run(sb, { args: ['code', '--facts', 'f'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.invoked, true);
  });
});

describe('agy-review.sh — subdir invocation is repo-complete (13)', () => {
  it('from a subdir, assembles a repo-complete change set AND reads a relative --facts path', () => {
    const sb = makeSandbox();
    // a change to a ROOT file (sibling of the subdir we invoke from)
    writeFileSync(join(sb.repo, 'root-change.txt'), 'ROOT_SIBLING_CHANGE\n');
    const sub = join(sb.repo, 'deep', 'nested');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'local-facts.md'), 'SUBDIR_RELATIVE_FACT\n');
    const r = run(sb, { args: ['code', '--facts', '@local-facts.md'], cwd: sub });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.prompt, /ROOT_SIBLING_CHANGE/, 'the root/sibling change must appear (repo-complete via cd to toplevel)');
    assert.match(r.prompt, /SUBDIR_RELATIVE_FACT/, 'a relative --facts path resolves against the invocation cwd, before the cd');
  });
});
