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
  'prompt=""',
  'prev=""; for a in "$@"; do if [[ "$prev" == "-p" ]]; then prompt="$a"; printf "%s" "$a" > "$AGY_FAKE_PROMPT"; fi; prev="$a"; done',
  'prev=""; for a in "$@"; do',
  '  if [[ "$prev" == "--add-dir" ]]; then',
  '    printf "%s" "$a" > "${AGY_FAKE_ADDDIR:-/dev/null}"',
  '    stat -c "%a" "$a" > "${AGY_FAKE_ADDDIR_MODE:-/dev/null}" 2>/dev/null || true',
  '    art="$a/precomputed-change-set"',
  '    if [[ -f "$art" ]]; then stat -c "%a" "$art" > "${AGY_FAKE_ARTIFACT_MODE:-/dev/null}" 2>/dev/null || true; cp "$art" "${AGY_FAKE_ARTIFACT_COPY:-/dev/null}" 2>/dev/null || true; fi',
  '  fi; prev="$a"',
  'done',
  'if [[ -n "${AGY_FAKE_SLEEP:-}" ]]; then sleep "$AGY_FAKE_SLEEP"; fi',
  // ── multi-turn support (the fed lane) ──────────────────────────────────────────────────────────
  // The single-file captures above record the LAST invocation; a chunked feed needs a PER-TURN
  // record, so each invocation also writes prompt/argv to "<file>.<turn>" and bumps a counter file.
  'turn=1',
  'if [[ -n "${AGY_FAKE_TURNS:-}" ]]; then',
  '  if [[ -s "$AGY_FAKE_TURNS" ]]; then turn=$(( $(cat "$AGY_FAKE_TURNS") + 1 )); fi',
  '  printf "%s" "$turn" > "$AGY_FAKE_TURNS"',
  '  printf "%s" "$prompt" > "${AGY_FAKE_PROMPT}.$turn"',
  '  { for a in "$@"; do printf "%s\\n" "$a"; done; } > "${AGY_FAKE_ARGV}.$turn"',
  'fi',
  // agy writes the conversation id into its --log-file; AGY_FAKE_BAD_CONV_LOG=1 writes a log the
  // wrapper cannot parse (the D9 degrade arm).
  'prev=""; for a in "$@"; do',
  '  if [[ "$prev" == "--log-file" ]]; then',
  '    if [[ "${AGY_FAKE_BAD_CONV_LOG:-}" == "1" ]]; then printf "no conversation marker here\\n" > "$a"',
  '    else printf "Starting new conversation %s\\n" "${AGY_FAKE_CONV_ID:-11111111-2222-3333-4444-555555555555}" > "$a"; fi',
  '  fi; prev="$a"',
  'done',
  'if [[ -n "${AGY_FAKE_FAIL_TURN:-}" && "$turn" == "${AGY_FAKE_FAIL_TURN}" ]]; then',
  '  printf "FAKE_TURN_FAILURE\\n" >&2; exit 3',
  'fi',
  // A FEED turn: the model was told to reply OK only. This fake deliberately misbehaves — it emits a
  // PREMATURE verdict — so the isolation invariant (feed output never reaches stdout or the parsed
  // capture) is proven against the worst case, not the polite one.
  'if [[ -z "${AGY_FAKE_OUTPUT+x}" && "$prompt" == *"--- BEGIN CHANGE-SET PART "* && "$prompt" != *"Requested addresses"* ]]; then',
  '  printf "PREMATURE_FEED_CHATTER\\n### Verdict\\nREWORK\\n"; exit 0',
  'fi',
  // The FINAL turn carries the delivery-proof request. The fake answers it the only honest way:
  // by reading the bodies it was actually fed, turn by turn — so a wrapper that never delivered a
  // part cannot be satisfied by this stub either.
  'if [[ -z "${AGY_FAKE_OUTPUT+x}" && "$prompt" == *"Requested addresses"* ]]; then',
  '  req="$(printf "%s" "$prompt" | awk "/^Requested addresses/{f=1; next} f && /^###/{exit} f{print}")"',
  '  entries=()',
  '  mapfile -t _items <<< "$req"',
  '  for _it in "${_items[@]}"; do',
  '    [[ -n "$_it" ]] || continue',
  '    k="$(printf "%s" "$_it" | awk "{print \\$2}")"; l="$(printf "%s" "$_it" | awk "{print \\$4}")"',
  '    src="$k"',
  '    if [[ "${AGY_FAKE_PROOF_DUP:-}" == "1" ]]; then src=1; fi',
  '    if [[ "${AGY_FAKE_PROOF_OMIT:-}" == "$k" ]]; then continue; fi',
  '    body="$(awk -v want="$l" "f && /^--- END CHANGE-SET PART /{exit} f{c++; if (c==want) {print; exit}} /^--- BEGIN CHANGE-SET PART /{f=1}" "${AGY_FAKE_PROMPT}.$src")"',
  '    if [[ "${AGY_FAKE_PROOF_CORRUPT:-}" == "$k" ]]; then body="${body}X"; fi',
  '    entry="$(printf "part %s line %s: %s" "$k" "$l" "$body")"',
  // Shape knobs the grammar must survive (a bullet) or reject (everything else).
  '    if [[ "${AGY_FAKE_PROOF_BULLET:-}" == "1" ]]; then entry="- $entry"; fi',
  '    if [[ "${AGY_FAKE_PROOF_NESTED:-}" == "$k" ]]; then entry="note: I believe $entry"; fi',
  '    if [[ "${AGY_FAKE_PROOF_PAD:-}" == "1" ]]; then entry="$(printf "part %02d line %04d: %s" "$k" "$l" "$body")"; fi',
  '    if [[ "${AGY_FAKE_PROOF_CASE:-}" == "1" ]]; then entry="$(printf "Part %s Line %s: %s" "$k" "$l" "$body")"; fi',
  '    if [[ "${AGY_FAKE_PROOF_HUGE:-}" == "$k" ]]; then entry="$(printf "part %s line 99999999999999999999: %s" "$k" "$body")"; fi',
  '    entries+=("$entry")',
  '    if [[ "${AGY_FAKE_PROOF_TWICE:-}" == "1" ]]; then entries+=("$entry"); fi',
  '  done',
  '  if [[ "${AGY_FAKE_PROOF_EXTRA:-}" == "1" ]]; then entries+=("part 99 line 1: an address nobody asked for"); fi',
  '  if [[ "${AGY_FAKE_PROOF_HUGE_EXTRA:-}" == "1" ]]; then entries+=("part 99999999999999999999 line 1: an invented giant address"); fi',
  '  if [[ "${AGY_FAKE_PROOF_LATE:-}" == "1" ]]; then printf "### Verdict\\nSHIP\\n"; fi',
  '  if [[ "${AGY_FAKE_PROOF_CASE:-}" == "1" ]]; then printf "### Delivery Proof\\n"; else printf "### Delivery proof\\n"; fi',
  '  if [[ "${AGY_FAKE_PROOF_OUTSIDE:-}" == "1" ]]; then',
  '    printf "(nothing here)\\n### Verdict\\nSHIP\\n"',
  '    if (( ${#entries[@]} > 0 )); then printf "%s\\n" "${entries[@]}"; fi',
  '  else',
  '    if (( ${#entries[@]} > 0 )); then printf "%s\\n" "${entries[@]}"; fi',
  '    printf "### Verdict\\nSHIP\\n"',
  '  fi',
  '  exit 0',
  'fi',
  // Unset AGY_FAKE_OUTPUT → a verdict-carrying default (D4: a verdict-less run is a FAILURE, so
  // the success-path tests need one); an EXPLICIT empty value exercises the empty-output failure.
  'if [[ -z "${AGY_FAKE_OUTPUT+x}" ]]; then printf "FAKE_AGY_REVIEW_OUTPUT\\n### Verdict\\nSHIP\\n"; else printf "%s\\n" "$AGY_FAKE_OUTPUT"; fi',
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

// The PATH farms and the sandbox base are READ-ONLY per invocation, so both are built ONCE and
// shared: a per-run farm rebuild (thousands of symlinks) plus a per-test `git init`+commit were
// the suite's dominant wall cost, not the wrapper under test.
const SHARED_ROOT = mkdtempSync(join(tmpdir(), 'agy-review-shared-'));
after(() => rmSync(SHARED_ROOT, { recursive: true, force: true }));
const farms = new Map();
const farmFor = (exclude) => {
  const key = exclude.join('|');
  if (!farms.has(key)) farms.set(key, makePathWithout(SHARED_ROOT, exclude));
  return farms.get(key);
};

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
  return home;
})();

// `clean: true` leaves a pristine committed tree (for the no-diff preflight); the default leaves one
// untracked file so `code` mode has a diff to review.
const makeSandbox = ({ clean = false } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'agy-review-test-'));
  cpSync(TEMPLATE_HOME, home, { recursive: true });
  const bin = join(home, '.local', 'bin');
  chmodSync(join(bin, 'agy'), 0o755);
  const repo = join(home, 'repo');
  const g = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (!clean) writeFileSync(join(repo, 'pending.txt'), 'PENDING_UNTRACKED_BODY\n');
  return { home, bin, repo, g };
};

// Capture files are per-INVOCATION: a second run() on the same sandbox must not inherit the first
// run's turn counter or per-turn prompt files (the fed lane reads them back by turn index).
let runSeq = 0;
const run = (sb, { args, env = {}, cwd } = {}) => {
  const { home, bin, repo } = sb;
  const farm = farmFor(['agy', 'agy-run']);
  const tag = `cap-${++runSeq}`;
  const cap = {
    argv: join(home, `${tag}-argv`), env: join(home, `${tag}-env`), prompt: join(home, `${tag}-prompt`),
    sentinel: join(home, `${tag}-sentinel`), adddir: join(home, `${tag}-adddir`),
    adddirMode: join(home, `${tag}-adddir-mode`), artifactMode: join(home, `${tag}-artifact-mode`),
    artifactCopy: join(home, `${tag}-artifact-copy`), turns: join(home, `${tag}-turns`),
  };
  const r = spawnSync('bash', [WRAPPER, ...args], {
    cwd: cwd || repo,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      HOME: home,
      PATH: `${bin}:${farm}`,
      // Keep the wrapper's mktemp working when the suite runs inside an OS sandbox whose /tmp is
      // read-only (only $TMPDIR is writable there).
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      AGY_FAKE_ARGV: cap.argv, AGY_FAKE_ENV: cap.env, AGY_FAKE_PROMPT: cap.prompt,
      AGY_FAKE_SENTINEL: cap.sentinel, AGY_FAKE_ADDDIR: cap.adddir, AGY_FAKE_ADDDIR_MODE: cap.adddirMode,
      AGY_FAKE_ARTIFACT_MODE: cap.artifactMode, AGY_FAKE_ARTIFACT_COPY: cap.artifactCopy,
      AGY_FAKE_TURNS: cap.turns,
      ...env,
    },
  });
  const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  // Per-turn captures are read EAGERLY: callers rmSync the sandbox before asserting.
  const turns = existsSync(cap.turns) ? Number(readFileSync(cap.turns, 'utf8')) : 0;
  const prompts = [];
  const argvs = [];
  for (let i = 1; i <= turns; i += 1) {
    prompts.push(readIf(`${cap.prompt}.${i}`));
    argvs.push(readIf(`${cap.argv}.${i}`));
  }
  return {
    ...r,
    invoked: existsSync(cap.sentinel),
    argv: readIf(cap.argv), capEnv: readIf(cap.env), prompt: readIf(cap.prompt),
    adddir: readIf(cap.adddir).trim(), adddirMode: readIf(cap.adddirMode).trim(),
    artifactMode: readIf(cap.artifactMode).trim(), artifactCopy: readIf(cap.artifactCopy),
    turns, prompts, argvs,
  };
};

// Async twin of run() for the two sleep-bound timeout tests: spawnSync blocks the event loop
// for the whole deliberate wait, so a concurrent describe could not overlap them. Same spawn
// contract and captures.
const runAsync = (sb, { args, env = {}, cwd } = {}) =>
  new Promise((done) => {
    const { home, bin, repo } = sb;
    const cap = {
      argv: join(home, 'cap-argv'), env: join(home, 'cap-env'), prompt: join(home, 'cap-prompt'),
      sentinel: join(home, 'cap-sentinel'), adddir: join(home, 'cap-adddir'),
      adddirMode: join(home, 'cap-adddir-mode'), artifactMode: join(home, 'cap-artifact-mode'),
      artifactCopy: join(home, 'cap-artifact-copy'),
    };
    const child = execFile('bash', [WRAPPER, ...args], {
      cwd: cwd || repo,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        HOME: home,
        PATH: `${bin}:${farmFor(['agy', 'agy-run'])}`,
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        AGY_FAKE_ARGV: cap.argv, AGY_FAKE_ENV: cap.env, AGY_FAKE_PROMPT: cap.prompt,
        AGY_FAKE_SENTINEL: cap.sentinel, AGY_FAKE_ADDDIR: cap.adddir, AGY_FAKE_ADDDIR_MODE: cap.adddirMode,
        AGY_FAKE_ARTIFACT_MODE: cap.artifactMode, AGY_FAKE_ARTIFACT_COPY: cap.artifactCopy,
        ...env,
      },
    }, (error, stdout, stderr) => {
      const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
      done({
        status: error ? (error.code ?? 1) : 0, stdout, stderr,
        invoked: existsSync(cap.sentinel),
        argv: readIf(cap.argv), capEnv: readIf(cap.env), prompt: readIf(cap.prompt),
        adddir: readIf(cap.adddir).trim(), adddirMode: readIf(cap.adddirMode).trim(),
        artifactMode: readIf(cap.artifactMode).trim(), artifactCopy: readIf(cap.artifactCopy),
      });
    });
    child.stdin.end();
  });

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

  it('plan mode with no --facts keeps the warning and proceeds (unchanged contract)', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'p.md'), '# plan body\n');
    const r = run(sb, { args: ['plan', 'p.md'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /no --facts supplied/);
    assert.equal(r.invoked, true, 'an ungrounded plan review still proceeds (warn, not block)');
    assert.match(r.prompt, /none supplied/, 'the prompt notes the missing facts in-band');
  });
});

// ── code mode fails CLOSED without grounded facts (D4) ───────────────────────────
// An ungrounded CODE receipt records grounded:false, which the kit's review-state gate rejects —
// the run would be paid for and attest nothing. The wrapper refuses BEFORE the spend, keyed on the
// resolved CONTENT (an empty --facts payload refuses identically). Escapes: the explicit
// --ungrounded flag (throwaway opinion) and AGY_PROBE=1 (a probe receipt never attests anyway).
describe('agy-review.sh — code mode fails CLOSED without grounded facts (D4)', () => {
  it('code mode with no --facts exits 2 before any agy invocation', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.invoked, false, 'the refusal must fire before any agy invocation — zero runs spent');
    assert.match(r.stderr, /grounding\.mjs/, 'the refusal names the facts assembler');
    assert.match(r.stderr, /agy-review code --facts @/, 'the refusal prints the exact re-run line');
    const hint = r.stderr.match(/node "([^"]+grounding\.mjs)"/);
    assert.ok(hint, 'the recovery hint resolves and QUOTES a real grounding.mjs path (an install path may carry spaces)');
    assert.ok(existsSync(hint[1]), 'the resolved hint path exists on this layout');
  });

  it('code mode with --facts naming an EMPTY payload exits 2 before any agy invocation', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'empty-facts.md'), '');
    const r = run(sb, { args: ['code', '--facts', '@empty-facts.md'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 2, 'the refusal keys on the CONTENT, not the flag');
    assert.equal(r.invoked, false, 'an empty payload must not spend a run');
    assert.match(r.stderr, /agy-review code --facts @/);
  });

  it('code --ungrounded proceeds and the receipt records grounded:false', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--ungrounded'], env: { AGY_FAKE_OUTPUT: VERDICT_OUTPUT } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.invoked, true, 'the explicit escape lets the run proceed');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].grounded, false, 'an --ungrounded run still records grounded:false');
    assert.equal(receipts[0].factsHash, null);
    assert.match(r.stderr, /no --facts supplied/, 'the escape path stays loud, never silent');
  });

  it('AGY_PROBE=1 code with no --facts proceeds and the receipt records probe:true', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code'], env: { AGY_PROBE: '1', AGY_FAKE_OUTPUT: VERDICT_OUTPUT } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.invoked, true, 'an ungrounded probe is coherent — a probe receipt never attests');
    assert.equal(receipts[0].probe, true);
    assert.equal(receipts[0].grounded, false);
  });

  it('--ungrounded with --facts is a refusal (contradiction)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--ungrounded', '--facts', 'f'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.equal(r.invoked, false);
    assert.match(r.stderr, /--ungrounded contradicts --facts/);
  });

  it('--ungrounded outside code mode is a refusal', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'p.md'), '# p\n');
    const r = run(sb, { args: ['plan', 'p.md', '--ungrounded'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.equal(r.invoked, false);
    assert.match(r.stderr, /--ungrounded is only valid in code mode/);
  });

  it('--ungrounded on a continuation is a refusal', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['--continue', '--ungrounded'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.equal(r.invoked, false);
    assert.match(r.stderr, /--ungrounded is not valid on a continuation/);
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

// ── the repo file map budget (Phase 2) ───────────────────────────────────────────────────────────
// The kit's extracted-helper parity test proves the SHARED emit_repo_file_map bounds the map; it
// cannot prove this REAL wrapper sets the budget. These cases run the wrapper end to end.
const MAP_DIR = 'deeply/nested/fixture/directory/for/the/repo/file/map/budget';
const AGY_MAP_BUDGET_BYTES = 8192;
const MAP_HEADER = '=== repo file map (git ls-files) ===\n';
const untouchedPath = (i) => `${MAP_DIR}/aa-untouched-file-${String(i).padStart(3, '0')}.txt`;
const modifiedPath = (i) => `${MAP_DIR}/zz-modified-file-${String(i).padStart(3, '0')}.txt`;

// A tracked map far past the budget (~200 long paths ≈ 17 KB) whose CHANGED subset is ALSO past it
// (~100 paths ≈ 8.7 KB) — the fixture Invariant B needs: a change touching very many long paths.
const seedOversizedMap = (sb, count = 100) => {
  mkdirSync(join(sb.repo, MAP_DIR), { recursive: true });
  for (let i = 0; i < count; i += 1) {
    writeFileSync(join(sb.repo, untouchedPath(i)), `untouched ${i}\n`);
    writeFileSync(join(sb.repo, modifiedPath(i)), `body ${i} v1\n`);
  }
  sb.g('add', '-A');
  sb.g('commit', '-qm', 'map fixture');
  for (let i = 0; i < count; i += 1) writeFileSync(join(sb.repo, modifiedPath(i)), `body ${i} v2 — changed\n`);
  return count;
};
const mapSectionOf = (prompt) =>
  prompt.slice(prompt.indexOf(MAP_HEADER) + MAP_HEADER.length, prompt.indexOf('\n\n=== git status (porcelain) ==='));

describe('agy-review.sh — repo file map budget (Phase 2)', () => {
  it('agy-review sets the map budget and degrades an over-budget map', () => {
    const sb = makeSandbox();
    const count = seedOversizedMap(sb);
    const r = run(sb, { args: ['code', '--facts', 'f'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    const note = r.prompt.match(new RegExp(`=== repo file map TRUNCATED to the changed-path subset: (\\d+) of (\\d+) tracked paths shown, (\\d+) omitted \\(map budget ${AGY_MAP_BUDGET_BYTES} bytes\\) ===`));
    assert.ok(note, 'the wrapper must set the budget and state the truncation with its counts');
    const [, shown, total, omitted] = note.map(Number);
    assert.ok(total >= 2 * count, 'the fixture map really carries every seeded path');
    assert.equal(shown + omitted, total, 'the stated counts add up — a truncation-with-count, never a silent cut');
    assert.ok(shown < total, 'the map really degraded');
    assert.ok(r.prompt.includes(modifiedPath(0)), 'the degraded map keeps the CHANGED paths');
    assert.ok(!r.prompt.includes(untouchedPath(0)), 'an untouched path is dropped, and it appears nowhere else in the payload');
  });

  it('the degraded changed-path subset itself stays inside the wrapper budget', () => {
    const sb = makeSandbox();
    seedOversizedMap(sb);
    const r = run(sb, { args: ['code', '--facts', 'f'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    const lines = mapSectionOf(r.prompt).split('\n');
    const noteAt = lines.findIndex((l) => l.startsWith('=== repo file map TRUNCATED'));
    assert.notEqual(noteAt, -1, 'the note closes the degraded section');
    const pathBytes = Buffer.byteLength(lines.slice(0, noteAt).join('\n'), 'utf8');
    assert.ok(pathBytes > 0, 'the subset is non-empty');
    assert.ok(pathBytes <= AGY_MAP_BUDGET_BYTES, `the subset (${pathBytes} bytes) must stay inside the ${AGY_MAP_BUDGET_BYTES}-byte budget`);
  });

  it('an ordinary in-budget repo keeps the whole map, unnoted', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'f'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.prompt, /=== repo file map \(git ls-files\) ===\nbase\.txt\n/);
    assert.doesNotMatch(r.prompt, /TRUNCATED/, 'a fitting map is untouched by the bound');
  });
});

// ── the chunked-feed code review with PROVEN delivery (Phase 3) ──────────────────────────────────
// agy takes its prompt as ONE argv, and this host AUTO-DENIES agy's native read_file tool — so an
// over-cap change set can never be FETCHED by the model. It is DELIVERED instead: partitioned into
// under-cap parts, fed over continuation turns, then reviewed in a final turn. Delivery is PROVEN,
// never assumed: the wrapper picks a line from each part's body AFTER assembly and the final answer
// must reproduce every picked line verbatim. Envelope and body are formally separate — only BODIES
// concatenate, and they concatenate to the change set byte-for-byte.
const ARTIFACT_HEADER = '## The change set under review (assembled working-tree diff — repo-complete)';
const SHAPE_HEADER = '\n## Output — Markdown, this exact shape, nothing else';
const FED_CAP = 6000;

// A change set big enough to need several parts under FED_CAP.
const seedFedChangeSet = (sb, { lines = 400, multibyte = false } = {}) => {
  const body = Array.from({ length: lines }, (_, i) =>
    multibyte
      ? `строка ${String(i).padStart(4, '0')} — многобайтовый маркер ${'ю'.repeat(20)}`
      : `unique change-set line ${String(i).padStart(4, '0')} — a distinctive body marker ${'x'.repeat(20)}`).join('\n');
  writeFileSync(join(sb.repo, 'oversized.txt'), `${body}\n`);
};

const inlineArtifactOf = (prompt) => prompt.slice(prompt.indexOf(ARTIFACT_HEADER), prompt.indexOf(SHAPE_HEADER));
const bodyOf = (turnPrompt) => {
  const begin = turnPrompt.match(/--- BEGIN CHANGE-SET PART \d+ OF \d+ ---\n/);
  if (!begin) return null;
  const start = begin.index + begin[0].length;
  return turnPrompt.slice(start, turnPrompt.indexOf('\n--- END CHANGE-SET PART ', start));
};
// The addresses ride ONE PER LINE — that format is what makes a collision with a proof candidate
// constructively impossible, so the parser reads lines, never a delimiter-joined field.
const requestedBlockOf = (finalPrompt) => {
  const start = finalPrompt.indexOf('Requested addresses');
  assert.notEqual(start, -1, 'the final turn states which lines it requires');
  const after = finalPrompt.slice(finalPrompt.indexOf('\n', start) + 1);
  return after.slice(0, after.indexOf('\n###')).split('\n').filter(Boolean);
};
const requestedOf = (finalPrompt) => requestedBlockOf(finalPrompt).map((item) => {
  const [, part, line] = item.match(/^part (\d+) line (\d+)$/);
  return { part: Number(part), line: Number(line) };
});
const fedRun = (sb, extraEnv = {}) =>
  run(sb, { args: ['code', '--facts', 'grounded fact'], env: { AGY_MAX_PROMPT_BYTES: String(FED_CAP), ...extraEnv } });

describe('agy-review.sh — chunked feed: the change set is DELIVERED (Phase 3)', () => {
  it('an over-cap code review feeds every part and the concatenated BODIES reproduce the change set exactly', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const inline = run(sb, { args: ['code', '--facts', 'grounded fact'], env: { AGY_MAX_PROMPT_BYTES: '130000' } });
    const fed = fedRun(sb);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(inline.status, 0, inline.stderr);
    assert.equal(fed.status, 0, fed.stderr);
    assert.ok(fed.turns >= 3, `the fixture must really chunk (got ${fed.turns} turns)`);
    const bodies = fed.prompts.slice(0, -1).map(bodyOf);
    assert.ok(bodies.every((b) => b !== null), 'every turn but the last carries exactly one body');
    assert.equal(bodies.join(''), inlineArtifactOf(inline.prompt), 'the bodies concatenate to the change set byte-for-byte');
  });

  it('no envelope text appears in the reconstructed review artifact', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb);
    rmSync(sb.home, { recursive: true, force: true });
    const reconstructed = fed.prompts.slice(0, -1).map(bodyOf).join('');
    for (const envelope of ['--- BEGIN CHANGE-SET PART', '--- END CHANGE-SET PART', 'Chunked delivery', 'Reply with exactly OK', 'Grounded facts', 'Requested:']) {
      assert.ok(!reconstructed.includes(envelope), `envelope text leaked into the artifact: ${envelope}`);
    }
  });

  it('every fed turn prompt is under AGY_MAX_PROMPT_BYTES', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 0, fed.stderr);
    for (const [i, p] of fed.prompts.entries()) {
      assert.ok(Buffer.byteLength(p, 'utf8') <= FED_CAP, `turn ${i + 1} is ${Buffer.byteLength(p, 'utf8')} bytes, over the ${FED_CAP} ceiling`);
    }
  });

  it('the shape block appears only on the final turn, and every feed turn carries the acknowledge-only instruction', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb);
    rmSync(sb.home, { recursive: true, force: true });
    const feed = fed.prompts.slice(0, -1);
    const final = fed.prompts[fed.prompts.length - 1];
    for (const [i, p] of feed.entries()) {
      assert.ok(!p.includes('## Output — Markdown'), `feed turn ${i + 1} must not carry the output shape`);
      assert.ok(!p.includes('### Verdict'), `feed turn ${i + 1} must not ask for a verdict`);
      assert.match(p, /Reply with exactly OK and NOTHING else/, `feed turn ${i + 1} must be acknowledge-only`);
    }
    assert.match(final, /## Output — Markdown/);
    assert.match(final, /### Delivery proof/);
    assert.ok(final.indexOf('### Delivery proof') < final.indexOf('### Verdict'), 'the proof section is FIRST in the mandated shape');
    assert.ok(bodyOf(final) === null, 'the final turn carries no body — the change set is already delivered');
  });

  // Observed LIVE on the first real over-cap dispatch: the final turn reached for a tool to count
  // lines, headless agy auto-denied it ("no output produced — a tool required the \"command\"
  // permission"), and the whole answer was lost. Every turn must forbid tool use outright — the
  // change set is already IN the conversation, so no tool can add anything.
  it('every turn forbids tool use — a denied tool loses the whole answer on this host', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 0, fed.stderr);
    for (const [i, p] of fed.prompts.entries()) {
      assert.match(p, /do NOT use any tool/i, `turn ${i + 1} must forbid tool use`);
      assert.match(p, /already in this conversation|from THIS CONVERSATION only/i, `turn ${i + 1} must say why no tool is needed`);
    }
  });

  // The delivery verdict must not blame delivery for a run that produced no answer at all: the parts
  // WERE fed, the model was blocked from replying. Reporting it as "the change set never arrived"
  // sends the reader hunting the wrong bug.
  it('a final turn that produced NO answer reports that cause, never a delivery failure', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_FAKE_OUTPUT: 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.' });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 4, fed.stderr);
    assert.match(fed.stderr, /produced no review/i, 'the cause is the empty answer');
    assert.doesNotMatch(fed.stderr, /never received it/, 'never the delivery accusation');
    assert.match(fed.stderr, /SENT every one of/, 'it claims only what it can: the parts were sent');
    assert.doesNotMatch(fed.stderr, /delivery was proven|WAS delivered/, 'retention is exactly what the unanswered proof leaves unknown');
    assert.match(fed.stderr, /CAUSE \(named by agy itself\)/, 'the KNOWN denial signature is recognized, not guessed');
    assert.equal(receipts.length, 0, 'still no receipt — an unanswered review attests nothing');
  });

  it('an answerless final turn with NO recognizable diagnostic reports the cause as unknown', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_FAKE_OUTPUT: 'something the wrapper has never seen before' });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 4, fed.stderr);
    assert.match(fed.stderr, /CAUSE: unknown/, 'an unrecognized failure is never dressed up as a known one');
    assert.doesNotMatch(fed.stderr, /named by agy itself/);
  });

  it('the grounding rides turn 1 only', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_MAX_PROMPT_BYTES: String(FED_CAP) });
    rmSync(sb.home, { recursive: true, force: true });
    assert.match(fed.prompts[0], /## Grounded facts — review AGAINST these/);
    assert.match(fed.prompts[0], /grounded fact/);
    for (const p of fed.prompts.slice(1)) assert.ok(!p.includes('## Grounded facts'), 'the grounding is not re-sent');
  });

  it('a multibyte body is cut at LINE boundaries — every part decodes cleanly and concatenation stays byte-exact', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb, { multibyte: true, lines: 400 });
    const inline = run(sb, { args: ['code', '--facts', 'grounded fact'], env: { AGY_MAX_PROMPT_BYTES: '130000' } });
    const fed = fedRun(sb);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 0, fed.stderr);
    assert.ok(fed.turns >= 3, 'the multibyte fixture really chunks');
    const bodies = fed.prompts.slice(0, -1).map(bodyOf);
    for (const [i, b] of bodies.entries()) {
      assert.equal(Buffer.from(b, 'utf8').toString('utf8'), b, `part ${i + 1} carries no split code point`);
      if (i < bodies.length - 1) assert.ok(b.endsWith('\n'), `part ${i + 1} ends on a line boundary`);
    }
    assert.equal(bodies.join(''), inlineArtifactOf(inline.prompt), 'byte-exact concatenation survives multibyte content');
  });

  // The partitioner's two boundary defects, both caught at review: an invented separator byte on an
  // unterminated last line (an extra part and an extra TURN), and an over-eager refusal for a line
  // that is merely longer than the FIRST part's smaller budget.
  it('an artifact with NO trailing newline yields no extra or empty part, and reassembles byte-exactly', () => {
    const sb = makeSandbox();
    // An untracked file with no final newline: the assembled change set ends without one too.
    writeFileSync(join(sb.repo, 'oversized.txt'), `${Array.from({ length: 400 }, (_, i) => `unique change-set line ${String(i).padStart(4, '0')} — a distinctive body marker ${'x'.repeat(20)}`).join('\n')}`);
    const inline = run(sb, { args: ['code', '--facts', 'grounded fact'], env: { AGY_MAX_PROMPT_BYTES: '130000' } });
    const fed = fedRun(sb);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 0, fed.stderr);
    const bodies = fed.prompts.slice(0, -1).map(bodyOf);
    for (const [i, b] of bodies.entries()) assert.ok(b.length > 0, `part ${i + 1} is non-empty`);
    assert.equal(bodies.join(''), inlineArtifactOf(inline.prompt), 'byte-exact reassembly without a final newline');
    const announced = fed.stderr.match(/feeding the change set in (\d+) part\(s\) over (\d+) subscription turns/);
    assert.equal(Number(announced[1]), bodies.length, 'the announced part count is the count really sent — no phantom part');
    assert.equal(Number(announced[2]), fed.turns, 'and no phantom turn');
  });

  it('a line longer than the FIRST part budget but not the later one is placed, not refused', () => {
    const sb = makeSandbox();
    // Turn 1 carries the grounding too, so its body budget is SMALLER by exactly the grounding size.
    // A fat grounding opens a real window between the two budgets; a line inside that window must be
    // moved to a later part, not made to fail the whole run.
    const facts = `grounded fact ${'g'.repeat(2000)}`;
    // Every filler line must be GLOBALLY UNIQUE — the proof selector rejects a repeated line, so a
    // restarted counter would starve the part of candidates and hide what this case is testing.
    const filler = (from, n) => Array.from({ length: n }, (_, i) => `unique change-set line ${String(from + i).padStart(4, '0')} — a distinctive body marker ${'x'.repeat(20)}`).join('\n');
    const longLine = `unique long marker line ${'y'.repeat(4200)}`;
    writeFileSync(join(sb.repo, 'oversized.txt'), `${filler(0, 20)}\n${longLine}\n${filler(20, 60)}\n`);
    const fed = run(sb, { args: ['code', '--facts', facts], env: { AGY_MAX_PROMPT_BYTES: String(FED_CAP) } });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 0, `a placeable long line must not refuse the run: ${fed.stderr}`);
    const bodies = fed.prompts.slice(0, -1).map(bodyOf);
    assert.ok(bodies.some((b) => b.includes(longLine)), 'the long line rode a part whole');
    assert.ok(!bodies[0].includes(longLine), 'and it was moved OFF the smaller first part');
  });

  it('a line that fits NO part refuses before any turn is spent', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'oversized.txt'), `head\n${'z'.repeat(FED_CAP * 2)}\ntail\n`);
    const fed = fedRun(sb);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 2, fed.stderr);
    assert.equal(fed.invoked, false, 'not one turn is spent');
    assert.match(fed.stderr, /does not fit even an EMPTY fed part/);
  });

  it('feed-turn output never reaches stdout or the parsed capture (a premature verdict is discarded)', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb);
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 0, fed.stderr);
    assert.ok(!fed.stdout.includes('PREMATURE_FEED_CHATTER'), 'a feed turn never publishes to stdout');
    assert.ok(!fed.stdout.includes('REWORK'), 'a feed turn`s premature verdict never reaches the reader');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].verdict, 'SHIP', 'only the FINAL turn is parsed into the receipt');
  });

  it('a non-zero feed turn stops the run, spends no later turn, and writes NO receipt', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_FAKE_FAIL_TURN: '2' });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.notEqual(fed.status, 0, 'a failed feed turn is a failed review');
    assert.equal(fed.turns, 2, 'the run stops at the first failure — no later turn is spent');
    assert.equal(receipts.length, 0, 'a run whose delivery never completed mints nothing');
  });

  // The hard cap is ONE wall-clock budget for the whole review. Handing each of the N+1 calls the
  // full AGY_HARD_TIMEOUT multiplied the stated guarantee by the turn count — a 30m cap could run
  // for hours. Each turn now gets only what is LEFT of a shared deadline.
  it('the hard cap is ONE budget for the whole review, not one per turn', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb, { lines: 150 });
    const fed = run(sb, {
      args: ['code', '--facts', 'grounded fact'],
      env: { AGY_MAX_PROMPT_BYTES: String(FED_CAP), AGY_HARD_TIMEOUT: '600s', AGY_TIMEOUT: '600s', AGY_FAKE_SLEEP: '1' },
    });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 0, fed.stderr);
    const timeouts = fed.argvs.map((argv) => {
      const tokens = argv.split('\n');
      return Number((tokens[tokens.indexOf('--print-timeout') + 1] ?? '').replace(/s$/, ''));
    });
    assert.ok(timeouts.length >= 3, `the fixture must really chunk (got ${timeouts.length} turns)`);
    for (const [i, t] of timeouts.entries()) {
      assert.ok(t > 0 && t <= 600, `turn ${i + 1} asked for ${t}s, outside the shared 600s budget`);
    }
    assert.ok(timeouts[timeouts.length - 1] < timeouts[0], 'the budget SHRINKS across turns — a per-turn cap would keep handing out the full 600s');
    // council R1-M5: agy.sh hands timeout(1) `--kill-after=10s`, so a turn given the FULL remaining
    // time can outlive the shared deadline by that grace when it ignores TERM. Every turn must
    // therefore be handed strictly less than what is left.
    assert.ok(timeouts[0] <= 600 - 10, `turn 1 asked for ${timeouts[0]}s — the SIGKILL grace is not reserved`);
  });

  // council R2-M2: shrinking a turn to 1s does not save the cap — a TERM-ignoring process still runs
  // for the SIGKILL grace on top. Too little budget left is a REFUSAL, never a tiny turn.
  it('a cap smaller than the SIGKILL grace refuses BEFORE spending a single turn', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb, { lines: 150 });
    const fed = run(sb, {
      args: ['code', '--facts', 'grounded fact'],
      env: { AGY_MAX_PROMPT_BYTES: String(FED_CAP), AGY_HARD_TIMEOUT: '5s', AGY_TIMEOUT: '5s' },
    });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 124, fed.stderr);
    assert.equal(fed.turns, 0, 'not one turn is dispatched — the refusal is pre-spend');
    assert.match(fed.stderr, /SIGKILL grace/u, 'the refusal names the real cause');
    assert.equal(receipts.length, 0, 'a refused review mints NO receipt');
  });

  it('the fed lane announces part and turn counts before the first dispatch (D5 quota honesty)', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb);
    rmSync(sb.home, { recursive: true, force: true });
    const announce = fed.stderr.match(/feeding the change set in (\d+) part\(s\) over (\d+) subscription turns/);
    assert.ok(announce, `the cost must be stated before it is spent: ${fed.stderr}`);
    assert.equal(Number(announce[1]) + 1, Number(announce[2]), 'N parts cost N+1 turns');
    assert.equal(Number(announce[2]), fed.turns, 'the announced turn count is the count really spent');
  });

  // The ceiling is a SPENDING guard, so a value the operator sets and the wrapper cannot honour must
  // never be silently ignored. `008000` used to make bash evaluate an invalid octal constant: both
  // range tests errored to false and the ceiling simply stopped existing.
  it('a leading-zero ceiling is canonicalized, not read as octal — and it still refuses', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_REVIEW_MAX_TOTAL_BYTES: '008000' });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 2, fed.stderr);
    assert.equal(fed.invoked, false, 'the ceiling really bound — not one turn was spent');
    assert.match(fed.stderr, /over AGY_REVIEW_MAX_TOTAL_BYTES=8000\b/, 'canonicalized to 8000, and enforced at that value');
    assert.doesNotMatch(fed.stderr, /value too great for base|invalid arithmetic/, 'no octal diagnostic anywhere');
  });

  it('an explicit env ceiling the wrapper cannot honour REFUSES, never silently defaults', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    for (const bad of ['999999999999999999999', '200000000', 'lots']) {
      const fed = fedRun(sb, { AGY_REVIEW_MAX_TOTAL_BYTES: bad });
      assert.equal(fed.status, 2, `${bad}: ${fed.stderr}`);
      assert.equal(fed.invoked, false, `${bad}: no run is spent under an unhonoured ceiling`);
      assert.match(fed.stderr, /not a valid byte ceiling/, `${bad}: the refusal names the cause`);
    }
    rmSync(sb.home, { recursive: true, force: true });
  });

  it('the DEFAULT ceiling still lets an ordinary fed review through', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_REVIEW_MAX_TOTAL_BYTES: '240000' });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 0, fed.stderr);
    assert.equal(receipts[0].delivery, 'fed');
  });

  it('a change set whose total outgoing prompt bytes exceed AGY_REVIEW_MAX_TOTAL_BYTES refuses before the first turn is spent', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_REVIEW_MAX_TOTAL_BYTES: '9000' });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 2, fed.stderr);
    assert.equal(fed.invoked, false, 'not one subscription turn is spent');
    assert.match(fed.stderr, /over AGY_REVIEW_MAX_TOTAL_BYTES=9000/);
    assert.equal(receipts.length, 0);
  });

  it('a fixed overhead that cannot fit refuses rather than emitting an empty body', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_MAX_PROMPT_BYTES: '900' });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 2, fed.stderr);
    assert.equal(fed.invoked, false);
    assert.match(fed.stderr, /leaves no room/);
  });
});

// 4.3: agy's own denial names the permission rule it wants. The kit SURFACES that fact and never
// applies it — granting read_file would widen a boundary for ALL agy use on the machine to re-arm
// the one lane whose failure mode is undetectable by construction.
describe('agy-review.sh — the agy permission fact is surfaced, never applied', () => {
  const BRIDGE_ROOT = resolve(HERE, '..');

  it('the over-cap path states why the change set is delivered rather than read', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 0, fed.stderr);
    assert.match(fed.stderr, /read_file/, 'the notice names the denied tool');
    assert.match(fed.stderr, /never (grants|writes)/, 'and states that the kit does not grant it');
  });

  it('the bridge docs state the never-applied posture (doc contract)', () => {
    const prompt = readFileSync(join(BRIDGE_ROOT, 'references', 'review-prompt.md'), 'utf8');
    assert.match(prompt, /read_file/, 'the denial is named');
    assert.match(prompt, /never writes it|never applied/i, 'the never-applied posture is stated');
    assert.match(prompt, /dangerously-skip-permissions/, 'and the strictly-worse alternative is named as not offered');
    assert.doesNotMatch(prompt, /grant (the )?read_file permission to (fix|enable)/i, 'the docs never RECOMMEND granting it');
  });

  it('no wrapper or doc surface ever writes an agy permission rule', () => {
    for (const rel of [join('bin', 'agy-review.sh'), join('bin', 'agy.sh')]) {
      const text = readFileSync(join(BRIDGE_ROOT, rel), 'utf8');
      assert.doesNotMatch(text, /--dangerously-skip-permissions/, `${rel} must never pass the blanket-permission flag`);
    }
  });
});

describe('agy-review.sh — fed lane: turn targeting (D9)', () => {
  it('every turn after the first pins the captured conversation id', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_FAKE_CONV_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 0, fed.stderr);
    assert.match(fed.argvs[0], /(^|\n)--log-file(\n|$)/, 'turn 1 asks agy for its run log');
    assert.ok(!fed.argvs[0].includes('--conversation'), 'turn 1 is fresh');
    for (const argv of fed.argvs.slice(1)) {
      assert.match(argv, /(^|\n)--conversation(\n|$)/);
      assert.match(argv, /(^|\n)aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee(\n|$)/);
    }
  });

  it('an unparseable log degrades to --continue with a stated notice, not silently', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_FAKE_BAD_CONV_LOG: '1' });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 0, fed.stderr);
    assert.match(fed.stderr, /could not capture the conversation id/, 'the degrade is STATED');
    for (const argv of fed.argvs.slice(1)) assert.match(argv, /(^|\n)--continue(\n|$)/);
  });
});

describe('agy-review.sh — fed lane: delivery is PROVEN or the review FAILS (D1, D7)', () => {
  it('a fed review reproducing every selected line writes a fresh code receipt at the tree fingerprint', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb);
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 0, fed.stderr);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].artifact, 'code');
    assert.equal(receipts[0].fresh, true);
    assert.match(receipts[0].fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(receipts[0].delivery, 'fed', 'the receipt declares HOW delivery was established');
  });

  it('a fed review whose output omits a part`s echo exits 4 and writes NO receipt', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_FAKE_PROOF_OMIT: '2' });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 4, fed.stderr);
    assert.match(fed.stderr, /delivery/i, 'the cause names delivery, not a generic missing verdict');
    assert.ok(!/no recognized '### Verdict' section/.test(fed.stderr), 'never the generic verdict-less message');
    assert.equal(receipts.length, 0);
  });

  it('a fed review whose echo differs from the recorded line exits 4 and writes NO receipt', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_FAKE_PROOF_CORRUPT: '2' });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 4, fed.stderr);
    assert.match(fed.stderr, /delivery/i);
    assert.equal(receipts.length, 0);
  });

  it('a fed review echoing one part`s line for two parts exits 4 and writes NO receipt', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_FAKE_PROOF_DUP: '1' });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 4, fed.stderr);
    assert.equal(receipts.length, 0);
  });

  // The proof GRAMMAR, pinned red→green (Test-as-spec). A substring search over the whole answer
  // accepted every shape below except the bullet — which is the one shape that should pass.
  it('an echo placed OUTSIDE the proof section does not count', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_FAKE_PROOF_OUTSIDE: '1' });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 4, fed.stderr);
    assert.equal(receipts.length, 0);
  });

  // The proof comes FIRST so output truncation can never silently drop it. A block that arrives
  // after a verdict is not that shape, so it is not searched for — otherwise the "first" in the
  // contract would be decoration.
  it('a proof block placed AFTER the verdict does not count — the proof must be the first section', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_FAKE_PROOF_LATE: '1' });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 4, fed.stderr);
    assert.equal(receipts.length, 0);
  });

  it('an address echoed TWICE fails — one address, one line', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_FAKE_PROOF_TWICE: '1' });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 4, fed.stderr);
    assert.match(fed.stderr, /more than once/i);
    assert.equal(receipts.length, 0);
  });

  it('an UNREQUESTED address in the proof section fails', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_FAKE_PROOF_EXTRA: '1' });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 4, fed.stderr);
    assert.match(fed.stderr, /was never requested/i);
    assert.equal(receipts.length, 0);
  });

  it('a marker BURIED inside a sentence is not an echo (the anchor is real)', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_FAKE_PROOF_NESTED: '2' });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 4, fed.stderr);
    assert.equal(receipts.length, 0);
  });

  // Numbers arriving from the MODEL are untrusted input. `part 08 line 09` reached bash arithmetic
  // and array indexing as `08`, which bash reads as OCTAL — the wrapper crashed with `value too
  // great for base` instead of the contracted clean refusal, and a safely padded `01` also mismatched
  // the unpadded `1`. Both die at the PARSE boundary now: awk hands bash plain decimals.
  it('a zero-padded proof address is normalized, never an octal crash and never a false refusal', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_FAKE_PROOF_PAD: '1' });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 0, `a padded address must pass, not crash: ${fed.stderr}`);
    assert.doesNotMatch(fed.stderr, /value too great for base/, 'never bash octal arithmetic on model input');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].delivery, 'fed');
  });

  it('a capitalized heading and anchor still count — and the payload keeps its own case', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_FAKE_PROOF_CASE: '1' });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 0, `a capitalization must not fail a real delivery: ${fed.stderr}`);
    assert.equal(receipts.length, 1, 'the review attests');
  });

  it('an absurd proof address never reaches bash arithmetic — no crash, no impersonated address', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_FAKE_PROOF_HUGE: '2' });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 4, fed.stderr);
    assert.doesNotMatch(fed.stderr, /value too great for base|syntax error/, 'an absurd number never reaches bash arithmetic');
    assert.equal(receipts.length, 0);
  });

  // Dropping an out-of-range address made it INVISIBLE: an answer with every correct echo plus one
  // invented giant address then satisfied a grammar whose whole point is that it is closed.
  it('a VALID proof carrying one extra out-of-range address still fails — an invented address is never invisible', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_FAKE_PROOF_HUGE_EXTRA: '1' });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 4, fed.stderr);
    assert.match(fed.stderr, /out of range/, 'the refusal names what was wrong with it');
    assert.equal(receipts.length, 0, 'a closed grammar does not mint a receipt beside an invented address');
  });

  // The candidate cap was 25, so a change set whose first 25 middle-nearest candidates all fail the
  // fixed-string checks earned a false "no usable candidate" refusal while candidate 26 was fine.
  it('a part whose first 25 candidates are unusable still finds the one after them', () => {
    const sb = makeSandbox();
    // Each decoy is a unique WHOLE line (so it survives the cheap prefilter) that also occurs as a
    // SUBSTRING of a longer line — exactly the case the exact occurrence check must reject.
    const decoys = Array.from({ length: 30 }, (_, i) => `decoy candidate ${String(i).padStart(3, '0')} — appears twice as a substring`);
    const echoes = decoys.map((d) => `carrier line wrapping ${d} inside a longer line`);
    const filler = (from, n) => Array.from({ length: n }, (_, i) => `unique change-set line ${String(from + i).padStart(4, '0')} — a distinctive body marker ${'x'.repeat(20)}`);
    const body = [...filler(0, 40), ...decoys, ...filler(40, 40), ...echoes, ...filler(80, 60)];
    writeFileSync(join(sb.repo, 'oversized.txt'), `${body.join('\n')}\n`);
    const fed = fedRun(sb);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 0, `a usable candidate past position 25 must be found: ${fed.stderr}`);
    const final = fed.prompts[fed.prompts.length - 1];
    const bodies = fed.prompts.slice(0, -1).map(bodyOf);
    for (const { part, line } of requestedOf(final)) {
      const chosen = bodies[part - 1].split('\n')[line - 1].trim();
      assert.ok(!decoys.includes(chosen), `a twice-occurring decoy was chosen for part ${part}: ${chosen}`);
    }
  });

  it('a harmless `- ` bullet still counts — the anchor is strict, not brittle', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb, { AGY_FAKE_PROOF_BULLET: '1' });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 0, `a bulleted proof must not be a false refusal: ${fed.stderr}`);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].delivery, 'fed');
  });

  it('the selected lines never appear in any envelope the wrapper sends', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const fed = fedRun(sb);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 0, fed.stderr);
    const final = fed.prompts[fed.prompts.length - 1];
    const bodies = fed.prompts.slice(0, -1).map(bodyOf);
    const requested = requestedOf(final);
    assert.equal(requested.length, bodies.length, 'one requested line per fed part');
    for (const { part, line } of requested) {
      const expected = bodies[part - 1].split('\n')[line - 1];
      assert.ok(expected && expected.trim().length > 0, `part ${part} line ${line} resolves to a real body line`);
      assert.ok(!final.includes(expected), 'the final turn asks for the line by ADDRESS — it never reveals it');
      for (const [i, p] of fed.prompts.entries()) {
        if (i === part - 1) continue;
        const envelope = p.replace(bodies[i] ?? '', '');
        assert.ok(!envelope.includes(expected), `part ${part}'s expected line leaked into turn ${i + 1}'s envelope`);
      }
    }
  });

  // The blocker, both halves. A candidate is only sound if the model CANNOT have seen its text
  // anywhere but the body it is being asked to prove — so it must occur exactly once across the
  // bodies AND nowhere in what the wrapper itself sends, including the request line that names the
  // addresses (which only exists once every address is chosen).
  it('a change-set line that duplicates the wrapper`s own framing is never chosen as a proof', () => {
    const sb = makeSandbox();
    // The change set contains lines copied verbatim out of the envelope the wrapper will send.
    const framing = [
      'This is one piece of ONE change set being delivered to you in order.',
      'Work from THIS CONVERSATION only: do NOT use any tool, do NOT run any command, do NOT read any file.',
      'One line: SHIP / SHIP WITH NITS / REWORK, plus a one-sentence reason.',
    ];
    const filler = Array.from({ length: 400 }, (_, i) => `unique change-set line ${String(i).padStart(4, '0')} — a distinctive body marker ${'x'.repeat(20)}`);
    const woven = filler.flatMap((l, i) => (i % 40 === 20 ? [framing[(i / 40) | 0 % framing.length] ?? framing[0], l] : [l]));
    writeFileSync(join(sb.repo, 'oversized.txt'), `${woven.join('\n')}\n`);
    const fed = fedRun(sb);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 0, fed.stderr);
    const final = fed.prompts[fed.prompts.length - 1];
    const bodies = fed.prompts.slice(0, -1).map(bodyOf);
    for (const { part, line } of requestedOf(final)) {
      const chosen = bodies[part - 1].split('\n')[line - 1].trim();
      assert.ok(!framing.includes(chosen), `a framing line was chosen as part ${part}'s proof: ${chosen}`);
      // The real invariant behind it: the chosen text appears nowhere the model could read it
      // except its own body — not in another body, and not in any envelope.
      const inBodies = bodies.join('\n').split(chosen).length - 1;
      assert.equal(inBodies, 1, `part ${part}'s proof text must occur exactly once across the bodies`);
      for (const [i, p] of fed.prompts.entries()) {
        const envelope = p.replace(bodies[i] ?? '', '');
        assert.ok(!envelope.includes(chosen), `part ${part}'s proof text leaked into turn ${i + 1}'s envelope`);
      }
    }
  });

  it('a change-set line whose text IS a request address is never chosen (the request would reveal it)', () => {
    const sb = makeSandbox();
    // Seed every plausible address form the request line could carry, so a naive selector that
    // filters only against the PRE-request envelope can pick one of them.
    const addresses = Array.from({ length: 60 }, (_, i) => `part ${(i % 6) + 1} line ${i + 3}`);
    const filler = Array.from({ length: 400 }, (_, i) => `unique change-set line ${String(i).padStart(4, '0')} — a distinctive body marker ${'x'.repeat(20)}`);
    const woven = filler.flatMap((l, i) => (i % 7 === 3 && addresses[(i / 7) | 0] ? [addresses[(i / 7) | 0], l] : [l]));
    writeFileSync(join(sb.repo, 'oversized.txt'), `${woven.join('\n')}\n`);
    const fed = fedRun(sb);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(fed.status, 0, fed.stderr);
    const final = fed.prompts[fed.prompts.length - 1];
    const addressBlock = requestedBlockOf(final);
    const bodies = fed.prompts.slice(0, -1).map(bodyOf);
    for (const address of addressBlock) {
      assert.ok(address.length < 24, `every address line must stay under the proof-candidate minimum, got ${address.length}: ${address}`);
    }
    for (const { part, line } of requestedOf(final)) {
      const chosen = bodies[part - 1].split('\n')[line - 1].trim();
      assert.ok(!addressBlock.some((a) => a.includes(chosen)), `part ${part}'s proof text is revealed by an address line: ${chosen}`);
    }
  });

  it('an UNDER-cap single-turn review declares delivery `inline` and still attests', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'f'] });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(receipts[0].delivery, 'inline', 'the single-turn path proves delivery BY CONSTRUCTION and says so');
  });
});

describe('agy-review.sh — size ceiling + gated --add-dir escape (6)', () => {
  // D2: chunking is CODE-mode only. A plan/diff artifact is an operator-supplied file the operator
  // can split, so those modes keep today's refuse-over-cap behaviour verbatim.
  it('plan mode: an oversized prompt exits 2 with guidance, agy not invoked (chunking is code-only)', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'big-plan.md'), `# plan\n${'a plan line that is long enough to matter\n'.repeat(400)}`);
    const r = run(sb, { args: ['plan', 'big-plan.md', '--facts', 'f'], env: { AGY_MAX_PROMPT_BYTES: '4000' } });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /over AGY_MAX_PROMPT_BYTES=4000/);
    assert.match(r.stderr, /Trim to the relevant hunks/);
    assert.match(r.stderr, /split the plan into focused parts/);
    assert.equal(r.invoked, false, 'an oversized plan must not spend a run');
  });

  // D3: the offload is RETIRED, not removed. The key stays recognized (an existing settings line must
  // never start warning as unknown) but it arms nothing, and setting it says so.
  it('a set AGY_REVIEW_ALLOW_ADDDIR prints the retirement notice and does not pass --add-dir', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const r = run(sb, { args: ['code', '--facts', 'f'], env: { AGY_MAX_PROMPT_BYTES: String(FED_CAP), AGY_REVIEW_ALLOW_ADDDIR: '1' } });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /AGY_REVIEW_ALLOW_ADDDIR is set \(env\) but it is RETIRED/, 'the notice names the retirement AND where the dead value came from');
    assert.match(r.stderr, /unset AGY_REVIEW_ALLOW_ADDDIR in the environment/, 'an env override gets the recovery that actually clears it');
    assert.match(r.stderr, /chunked feed/, 'and names the lane that replaced it');
    assert.ok(!r.argv.includes('--add-dir'), 'the retired knob arms NOTHING');
    assert.match(r.stderr, /feeding the change set in \d+ part\(s\)/, 'the fed lane runs regardless of the retired knob');
  });

  it('the settings registry still recognizes the retired key (an existing line never warns as unknown)', () => {
    const sb = makeSandbox();
    writeSettings(sb, 'AGY_REVIEW_ALLOW_ADDDIR=1\n');
    const r = run(sb, { args: ['code', '--facts', 'f'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /unknown key 'AGY_REVIEW_ALLOW_ADDDIR'/);
  });

  it('the staging dir is trap-cleaned on exit (no leftover after the run)', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    const r = run(sb, { args: ['code', '--facts', 'f'], env: { AGY_MAX_PROMPT_BYTES: String(FED_CAP) } });
    // Turn 1 hands agy `--log-file <staging>/turn1.log`, so the fed lane's own argv names the dir.
    const logFile = r.argvs[0].split('\n')[r.argvs[0].split('\n').indexOf('--log-file') + 1];
    const stagingPath = logFile ? dirname(logFile) : '';
    const stillThere = stagingPath ? existsSync(stagingPath) : false;
    rmSync(sb.home, { recursive: true, force: true });
    assert.ok(stagingPath, 'a staging path was captured from the run');
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

describe('agy-review.sh — delegated guards inherited via agy-run (9, 10)', { concurrency: true }, () => {
  it('hard timeout: a sleeping stub is killed at AGY_HARD_TIMEOUT', async () => {
    const sb = makeSandbox();
    const started = Date.now();
    const r = await runAsync(sb, { args: ['code', '--facts', 'f'], env: { AGY_FAKE_SLEEP: '30', AGY_HARD_TIMEOUT: '2s', AGY_TIMEOUT: '2s' } });
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

// ── driving contract: --help ⟷ manifest ⟷ real arg-parsing (drift-guarded) ─────
// The manifest roles.review.contract is the single machine-readable source of the
// driving contract; these suites pin (a) --help renders it verbatim (set-EQUALITY,
// both directions), (b) the wrapper's REAL parser arms equal the declared sets
// (source-level reverse guard), (c) each declared mode/flag is really accepted and
// the CLOSED grammar really rejects an invented flag. Helpers are inline — each
// bridge test file stays standalone (mirror byte-equality).

const MANIFEST = JSON.parse(readFileSync(join(HERE, '..', 'capability.json'), 'utf8'));
const REVIEW_CONTRACT = MANIFEST.roles.review.contract;
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const setEq = (got, want, msg) => assert.deepEqual([...got].sort(), [...want].sort(), msg);
const leadingFlag = (descriptor) => {
  const m = norm(descriptor).match(/(^|\s)(--[a-z-]+)/);
  assert.ok(m, `descriptor "${descriptor}" carries no --flag token`);
  return m[2];
};

// Run `--help`/-h with PATH stripped of codex/agy/git, from a non-git cwd —
// proving the short-circuit fires BEFORE every preflight.
const runHelp = (arg) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-review-help-'));
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

// The source lines that really EXECUTE: a heredoc body (the --help text) and a comment both carry
// names without carrying logic, so a bare name-grep over the whole source stays green after the
// logic is deleted. Reuses the same heredoc discipline as extractArgCaseArms.
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
// An env var is really CONSULTED when an executable test compares it: [[ "$NAME" == … ]].
const consultsEnv = (source, name) =>
  executableLines(source).some((l) => new RegExp(`\\[\\[[^\\]]*\\$\\{?${name}\\b[^\\]]*(==|!=)`).test(l));
// The operand slots a rendered invocation form really carries: <angle> and [bracket] placeholders.
// The optional `@` prefix rides WITH the slot (`@<facts-file>` is one operand, not a bare
// `<facts-file>` behind a stray character) — the catalog declares the whole token a user types.
const SLOT_RE = /@?<[^<>]+>|\[[^[\]]*\]/g;

describe('agy-review.sh — --help contract (manifest-pinned)', () => {
  it('--help and -h exit 0 pre-preflight (no agy, no git)', () => {
    for (const arg of ['--help', '-h']) {
      const r = runHelp(arg);
      assert.equal(r.status, 0, `${arg}: ${r.stderr}`);
      assert.match(r.stdout, /Usage:/, `${arg} prints the contract to stdout`);
      assert.equal(r.stderr, '', `${arg} prints nothing to stderr`);
    }
  });

  it('Usage set-EQUALS the manifest invocation descriptors (both directions)', () => {
    const help = runHelp('--help').stdout;
    const got = helpSection(help, 'Usage:').filter((l) => l.startsWith('agy-review')).map(norm);
    assert.ok(REVIEW_CONTRACT.invocations.length > 0, 'manifest invocations must be non-empty');
    setEq(got, REVIEW_CONTRACT.invocations.map(norm), 'help Usage ⟷ manifest invocations');
  });

  it('Flags set-EQUALS the manifest flag descriptors (both directions)', () => {
    const help = runHelp('--help').stdout;
    const got = helpSection(help, 'Flags:').filter((l) => l.startsWith('--')).map(norm);
    assert.ok(REVIEW_CONTRACT.flags.length > 0, 'manifest flags must be non-empty');
    setEq(got, REVIEW_CONTRACT.flags.map(norm), 'help Flags ⟷ manifest flags');
  });

  it('Grounding renders the manifest grounding note verbatim', () => {
    const help = runHelp('--help').stdout;
    assert.equal(norm(helpSection(help, 'Grounding:').join(' ')), norm(REVIEW_CONTRACT.grounding));
  });

  it('Notes renders the manifest contract.notes verbatim (a typed contract key that MUST surface)', () => {
    const help = runHelp('--help').stdout;
    assert.ok(REVIEW_CONTRACT.notes.length > 0, 'manifest notes must be non-empty');
    assert.equal(norm(helpSection(help, 'Notes:').join(' ')), norm(REVIEW_CONTRACT.notes.join(' ')));
  });

  it('Round-2 / resume set-EQUALS the manifest continue descriptors', () => {
    const help = runHelp('--help').stdout;
    const got = helpSection(help, 'Round-2 / resume:').filter((l) => l.startsWith('agy-review')).map(norm);
    assert.ok(REVIEW_CONTRACT.continue.length > 0, 'manifest continue must be non-empty');
    setEq(got, REVIEW_CONTRACT.continue.map(norm), 'help continue ⟷ manifest continue');
  });

  it('Receipt renders the manifest receipt contract verbatim (AD-038 three-way lockstep)', () => {
    const help = runHelp('--help').stdout;
    assert.equal(norm(helpSection(help, 'Receipt:').join(' ')), norm(REVIEW_CONTRACT.receipt));
    assert.match(REVIEW_CONTRACT.receipt, /sha256 over the canonical uncommitted-state payload/, 'the fingerprint definition lives in the manifest contract');
    assert.match(REVIEW_CONTRACT.receipt, /fresh:false/, 'the continuation informational-only clause is contractual');
  });
});

describe('agy-review.sh — source-level reverse guard (parser arms ⟷ manifest)', () => {
  const arms = extractArgCaseArms(readFileSync(WRAPPER, 'utf8'));

  it('the real mode arms equal the manifest modes (adding a mode without the manifest fails here)', () => {
    // Deliberately a UNION over every `case "$mode"` in the wrapper (the CLI dispatch AND the
    // emit_artifact renderer): the union can only be conservative — a mode added to EITHER case
    // without the manifest goes red; no renderer-only arm can make a missing manifest entry green.
    const modes = splitArms(arms.get('"$mode"')).filter((a) => a !== '*');
    assert.ok(MANIFEST.roles.review.modes.length > 0, 'manifest modes must be non-empty');
    setEq(new Set(modes), MANIFEST.roles.review.modes, 'parser mode arms ⟷ manifest modes');
  });

  it('the real flag arms equal the manifest flag set (closed grammar; catch-alls excluded)', () => {
    const flagArms = splitArms(arms.get('"$1"')).filter((a) => !['--', '--*', '*'].includes(a));
    const declared = REVIEW_CONTRACT.flags.map(leadingFlag);
    assert.ok(declared.length > 0, 'manifest flag set must be non-empty');
    setEq(new Set(flagArms), new Set(declared), 'parser flag arms ⟷ manifest flags');
  });

  it('the first-arg entrypoints are exactly --help/-h + the manifest continue flags', () => {
    const declared = REVIEW_CONTRACT.continue.map(leadingFlag);
    assert.ok(declared.length > 0, 'manifest continue set must be non-empty');
    setEq(new Set(splitArms(arms.get('"${1:-}"'))), new Set(['--help', '-h', ...declared]));
  });
});

// ── mode catalog ⟷ wrapper reality (BRIDGE-MODES-CATALOG) ─────────────────────────
// The kit validator owns the catalog's INTERNAL shape; these arms pin the half only this wrapper's
// source can settle — the cataloged review modes ARE the real parser arms, every declared contract
// invocation is cataloged, and the env-hook the catalog aims at review is a real env var.
describe('agy-review.sh — mode catalog ⟷ wrapper reality (manifest-pinned)', () => {
  const source = readFileSync(WRAPPER, 'utf8');
  const arms = extractArgCaseArms(source);
  const catalog = MANIFEST.modeCatalog ?? [];
  const reviewEntries = catalog.filter((e) => e.role === 'review');
  const reviewPrimaries = reviewEntries.filter((e) => e.kind === 'primary');

  it('the catalog submodes ARE the wrapper\'s real parser mode arms (both directions)', () => {
    const modes = splitArms(arms.get('"$mode"')).filter((a) => a !== '*');
    assert.ok(reviewPrimaries.length > 0, 'the manifest must catalog its review modes');
    setEq(new Set(reviewPrimaries.map((e) => e.submode)), new Set(modes), 'catalog submodes ⟷ real parser mode arms');
  });

  it('every review entry composes BY REFERENCE and every reference resolves', () => {
    for (const entry of reviewEntries) {
      assert.ok(
        Array.isArray(entry.invocationRefs) && entry.invocationRefs.length > 0,
        `${entry.key}: a contract-backed entry references at least one contract descriptor`,
      );
      assert.ok(!Object.hasOwn(entry, 'descriptor'), `${entry.key}: a contract-backed entry never restates a literal descriptor`);
      for (const ref of entry.invocationRefs) {
        assert.equal(
          typeof REVIEW_CONTRACT[ref.contractField]?.[ref.index], 'string',
          `${entry.key}: ref ${ref.contractField}[${ref.index}] does not resolve into the manifest contract`,
        );
      }
    }
  });

  it('every review contract invocation is claimed by exactly ONE catalog entry (no uncataloged mode)', () => {
    const claims = reviewEntries.flatMap((e) => e.invocationRefs.map((r) => `${r.contractField}[${r.index}]`));
    assert.equal(new Set(claims).size, claims.length, 'a contract invocation is claimed at most once');
    const declared = [
      ...REVIEW_CONTRACT.invocations.map((_, i) => `invocations[${i}]`),
      ...REVIEW_CONTRACT.continue.map((_, i) => `continue[${i}]`),
    ];
    setEq(new Set(claims), declared, 'catalog claims ⟷ declared contract invocations');
  });

  it('every env-hook the catalog aims at a review mode is a real EXECUTABLE guard, not a mention', () => {
    const hooks = catalog.filter((e) => e.kind === 'env-hook' && e.parents.some((p) => reviewPrimaries.some((r) => r.key === p)));
    assert.ok(hooks.length > 0, 'AGY_PROBE must be cataloged as an env-hook over the review modes');
    for (const hook of hooks) {
      assert.ok(
        consultsEnv(source, hook.key),
        `env-hook ${hook.key} is named in the source but never TESTED in an executable condition — a help/comment mention would keep a name-grep green after the logic is deleted`,
      );
    }
  });

  it('the catalog operand slots set-EQUAL the slots its rendered forms really carry (both directions)', () => {
    for (const entry of reviewEntries) {
      const forms = entry.invocationRefs.map((r) => REVIEW_CONTRACT[r.contractField][r.index]);
      // The DEDUPLICATED UNION over every resolved form: a plural-ref entry legitimately spreads its
      // slots across forms, so per-form equality would false-fail a correct catalog.
      const realSlots = new Set(forms.flatMap((f) => f.match(SLOT_RE) ?? []));
      setEq(new Set((entry.operands ?? []).map((o) => o.slot)), realSlots, `${entry.key}: catalog operands ⟷ the slots its forms really carry`);
    }
  });

  it('an entry rendering a LITERAL descriptor is slot-checked too (env-hooks have no role to filter on)', () => {
    // The contract-backed arm above filters by role — and an env-hook HAS no role, so its descriptor
    // was never slot-checked at all. That is exactly how a hardcoded dead path can reach the
    // discovery surface looking ready-to-run. Every literal-descriptor kind is covered here:
    // env-hooks and contract-free primaries.
    const literalEntries = catalog.filter((e) => typeof e.descriptor === 'string');
    assert.ok(literalEntries.length > 0, 'AGY_PROBE must be cataloged with a literal descriptor');
    for (const entry of literalEntries) {
      const realSlots = new Set(entry.descriptor.match(SLOT_RE) ?? []);
      setEq(new Set((entry.operands ?? []).map((o) => o.slot)), realSlots, `${entry.key}: catalog operands ⟷ the slots its descriptor really carries`);
    }
  });

  it('AGY_PROBE really silences the advisory on EVERY review parent the catalog claims (behavioural)', () => {
    // The catalog CLAIMS these modes are modified by the hook; prove it per parent rather than
    // trusting a source scan: the off-frontier advisory fires without it, is silent with it.
    const hook = catalog.find((e) => e.key === 'AGY_PROBE');
    const drive = {
      'review.code': () => ['code', '--facts', 'f'],
      'review.plan': (sb) => { writeFileSync(join(sb.repo, 'p.md'), '# p\n'); return ['plan', 'p.md', '--facts', 'f']; },
      'review.diff': (sb) => { writeFileSync(join(sb.repo, 'c.diff'), 'diff body\n'); return ['diff', 'c.diff', '--facts', 'f']; },
      'review.continue': () => ['--continue'],
      'review.conversation': () => ['--conversation', 'conv-1'],
    };
    assert.ok(hook.parents.length > 0, 'AGY_PROBE must claim at least one parent');
    for (const parent of hook.parents) {
      assert.ok(drive[parent], `no behavioural drive for claimed parent "${parent}" — add one`);
      // Both runs must really REACH agy: asserting the diagnostic text alone would let an early
      // failure that never dispatched pass the probe-on branch (its stderr simply lacks the string).
      const noisy = makeSandbox();
      const off = run(noisy, { args: drive[parent](noisy), env: { AGY_MODEL: 'Some Weak Model' } });
      rmSync(noisy.home, { recursive: true, force: true });
      assert.equal(off.status, 0, `${parent}: ${off.stderr}`);
      assert.equal(off.invoked, true, `${parent}: the control run must reach agy`);
      assert.match(off.stderr, /non-frontier model/, `${parent}: the advisory must fire without the hook`);

      const quiet = makeSandbox();
      const on = run(quiet, { args: drive[parent](quiet), env: { AGY_MODEL: 'Some Weak Model', AGY_PROBE: '1' } });
      rmSync(quiet.home, { recursive: true, force: true });
      assert.equal(on.status, 0, `${parent}: ${on.stderr}`);
      assert.equal(on.invoked, true, `${parent}: AGY_PROBE=1 must still reach agy — silence must come from the hook, not from an early exit`);
      assert.doesNotMatch(on.stderr, /non-frontier model/, `${parent}: AGY_PROBE=1 must really silence it — the catalog claims it does`);
    }
  });
});

describe('agy-review.sh — declared contract is really accepted (forward guard)', () => {
  it('every manifest mode runs green', () => {
    const drive = {
      code: () => ['code', '--facts', 'f'],
      plan: (sb) => { writeFileSync(join(sb.repo, 'p.md'), '# p\n'); return ['plan', 'p.md', '--facts', 'f']; },
      diff: (sb) => { writeFileSync(join(sb.repo, 'c.diff'), 'diff body\n'); return ['diff', 'c.diff', '--facts', 'f']; },
    };
    for (const mode of MANIFEST.roles.review.modes) {
      assert.ok(drive[mode], `no test drive for manifest mode "${mode}" — add one`);
      const sb = makeSandbox();
      const r = run(sb, { args: drive[mode](sb) });
      rmSync(sb.home, { recursive: true, force: true });
      assert.equal(r.status, 0, `mode ${mode}: ${r.stderr}`);
      assert.equal(r.invoked, true, `mode ${mode} must reach agy`);
    }
  });

  it('every manifest flag is accepted in code mode', () => {
    for (const descriptor of REVIEW_CONTRACT.flags) {
      const flag = leadingFlag(descriptor);
      const sb = makeSandbox();
      // D4: code mode refuses without grounded facts, so a non-facts value flag is driven on a
      // grounded run; --ungrounded takes no value, contradicts --facts, and is driven alone.
      const args = flag === '--facts' ? ['code', '--facts', 'f']
        : flag === '--ungrounded' ? ['code', '--ungrounded']
          : ['code', '--facts', 'f', flag, 'f'];
      const r = run(sb, { args });
      rmSync(sb.home, { recursive: true, force: true });
      assert.equal(r.status, 0, `${flag}: ${r.stderr}`);
    }
  });

  it('an invented flag is rejected (closed grammar negative)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'f', '--bogus-flag'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag '--bogus-flag'/);
    assert.equal(r.invoked, false, 'an unknown flag must not spend a run');
  });

  it('--help NOT in first position is an unknown flag, never an intercepted help', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'f', '--help'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 2, 'help is keyed on the FIRST argument only');
    assert.doesNotMatch(r.stdout, /Usage:/);
  });
});

// ── review receipts (AD-038) ─────────────────────────────────────────────────────
// The normative fixture: the AD-038 shape + the D3 self-declaring probe marker (backend/verdict here
// carry this bridge's vocabulary; dynamic values are asserted by shape):
const RECEIPT_FIXTURE = JSON.parse(
  '{"schema":1,"artifact":"code","fresh":true,"fingerprint":"<sha256hex>","backend":"codex","verdict":"revise","grounded":true,"factsHash":null,"wrapperVersion":"2.3.0","timestamp":"2026-07-03T12:00:00Z","probe":false,"posture":{"model":"<display>"},"delivery":"inline"}',
);
const RECEIPTS_REL = join('.git', 'agent-workflow-review-receipts.jsonl');
const readReceipts = (repo) => {
  const p = join(repo, RECEIPTS_REL);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const sha256HexOf = async (buf) => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(buf).digest('hex');
};
const VERDICT_OUTPUT = '### Verdict\nSHIP WITH NITS — solid, two nits.\n### Blocking\nnone\n### Non-blocking\n1. nit\n### Questions\nnone';

describe('agy-review.sh — review receipts (AD-038)', () => {
  it('a fresh grounded code review appends ONE fixture-shaped receipt (verdict verbatim, factsHash real)', async () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_FAKE_OUTPUT: VERDICT_OUTPUT } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(receipts.length, 1, 'exactly one receipt line');
    const receipt = receipts[0];
    assert.deepEqual(Object.keys(receipt), Object.keys(RECEIPT_FIXTURE), 'fixture key set + order');
    assert.equal(receipt.schema, 1);
    assert.equal(receipt.artifact, 'code');
    assert.equal(receipt.fresh, true);
    assert.match(receipt.fingerprint, /^[0-9a-f]{64}$/, 'a real sha256 hex fingerprint');
    assert.equal(receipt.backend, 'agy');
    assert.equal(receipt.verdict, 'SHIP WITH NITS', 'the mandated ### Verdict section is recorded verbatim');
    assert.equal(receipt.grounded, true, '--facts was supplied');
    assert.equal(receipt.factsHash, await sha256HexOf('a tiny fact'), 'sha256 of the facts payload — an empty/changed facts file is visible');
    assert.equal(receipt.wrapperVersion, MANIFEST.version, 'receipt version ⟷ capability.json version');
    assert.match(receipt.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  // The probe marker (BRIDGE-MODES-CATALOG, D3) — the twin of the sibling bridge's arm: an
  // AGY_PROBE=1 review runs with the frontier-model advisory silenced, so its receipt is marked and
  // the kit's review-state gate rejects it. EVERY receipt carries the marker (true or false): it
  // self-declares, so the gate reads the fact rather than inferring it from a version string that
  // bumps in a different release phase. Silence is not a declaration.
  it('AGY_PROBE=1 stamps probe:true — a throwaway probe can never attest a tree (D3)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_PROBE: '1', AGY_FAKE_OUTPUT: VERDICT_OUTPUT } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(receipts[0].probe, true, 'a probe-relaxed run marks its own receipt');
    assert.deepEqual(Object.keys(receipts[0]), Object.keys(RECEIPT_FIXTURE), 'fixture key set + order');
  });

  // Every receipt SELF-DECLARES: the kit's gate reads the marker, never the wrapper version — so
  // the marker must not depend on a version bump landing in the same release phase.
  it('a normal review self-declares probe:false — the receipt states the fact, not a version', () => {
    const sb = makeSandbox();
    run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_FAKE_OUTPUT: VERDICT_OUTPUT } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(receipts[0].probe, false, 'silence is not a declaration — the gate rejects an unmarked receipt');
  });

  it('a probe CONTINUATION is marked too (it is doubly unable to attest — fresh:false AND probe)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['--continue'], env: { AGY_PROBE: '1', AGY_FAKE_OUTPUT: VERDICT_OUTPUT } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(receipts[0].fresh, false);
    assert.equal(receipts[0].probe, true, 'both write paths carry the marker — no unmarked probe lane');
  });

  it('an --ungrounded fresh run records grounded:false + factsHash null (the vacuous-grounding hole stays visible)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--ungrounded'], env: { AGY_FAKE_OUTPUT: VERDICT_OUTPUT } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(receipts[0].grounded, false);
    assert.equal(receipts[0].factsHash, null);
  });

  it('an EMPTY --facts file in code mode refuses pre-spend — no run, no receipt (D4 fail-closed)', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.home, 'empty-facts.md'), '');
    const r = run(sb, { args: ['code', '--facts', `@${join(sb.home, 'empty-facts.md')}`], env: { AGY_FAKE_OUTPUT: VERDICT_OUTPUT } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 2, 'vacuous grounding no longer spends a run');
    assert.equal(r.invoked, false);
    assert.equal(receipts.length, 0, 'no run — no receipt');
  });

  it('parses REWORK and plain SHIP verbatim (an absent section is a FAILED run — the D4 describe owns that arm)', () => {
    for (const [output, want] of [
      ['### Verdict\nREWORK — the contract is violated.', 'REWORK'],
      ['### Verdict\nSHIP — clean.', 'SHIP'],
    ]) {
      const sb = makeSandbox();
      const r = run(sb, { args: ['code', '--facts', 'f'], env: { AGY_FAKE_OUTPUT: output } });
      const receipts = readReceipts(sb.repo);
      rmSync(sb.home, { recursive: true, force: true });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(receipts[0].verdict, want, `verdict for: ${output.slice(0, 30)}`);
    }
  });

  // The wrapper-minted finding manifest (flow-orchestration Phase 4.2, Decision 2/P5/P24-25):
  // nonce-supplied dispatches mint {schema, backend, nonce, fingerprint, findings} beside the
  // receipt, atomic + no-clobber + ORDERED — a failed mint EXCLUDES the receipt append.
  describe('finding manifest (AW_REVIEW_NONCE)', () => {
    const manifestPath = (repo, nonce) => join(repo, '.git', `agent-workflow-finding-manifest-agy-${nonce}.json`);

    it('a nonce-supplied grounded code dispatch mints the {backend, nonce}-named manifest carrying the captured findings + the receipt fingerprint', () => {
      const sb = makeSandbox();
      const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_FAKE_OUTPUT: VERDICT_OUTPUT, AW_REVIEW_NONCE: 'r1-d2' } });
      const receipts = readReceipts(sb.repo);
      const manifest = JSON.parse(readFileSync(manifestPath(sb.repo, 'r1-d2'), 'utf8'));
      rmSync(sb.home, { recursive: true, force: true });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(receipts.length, 1, 'the receipt landed beside the manifest');
      assert.deepEqual(Object.keys(manifest), ['schema', 'backend', 'nonce', 'fingerprint', 'findings'], 'the closed manifest key set, in order');
      assert.equal(manifest.schema, 1);
      assert.equal(manifest.backend, 'agy');
      assert.equal(manifest.nonce, 'r1-d2');
      assert.equal(manifest.fingerprint, receipts[0].fingerprint, 'the manifest binds the SAME reviewed-tree fingerprint as the receipt');
      assert.equal(manifest.findings, `${VERDICT_OUTPUT}\n`, 'findings = the captured review output VERBATIM');
    });

    it('a nonce-less invocation mints NO manifest and keeps the receipt contract byte-exact (Decision 2 both branches)', () => {
      const sb = makeSandbox();
      const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_FAKE_OUTPUT: VERDICT_OUTPUT } });
      const receipts = readReceipts(sb.repo);
      const gitEntries = readdirSync(join(sb.repo, '.git')).filter((n) => n.startsWith('agent-workflow-finding-manifest-'));
      rmSync(sb.home, { recursive: true, force: true });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(gitEntries.length, 0, 'no nonce, no manifest');
      assert.deepEqual(Object.keys(receipts[0]), Object.keys(RECEIPT_FIXTURE), 'the receipt line field set is unchanged');
    });

    it('DIFFERENT bytes at the derived name refuse loudly AND EXCLUDE the receipt append (ordering, behaviorally)', () => {
      const sb = makeSandbox();
      writeFileSync(manifestPath(sb.repo, 'r1-d2'), '{"schema":1,"backend":"agy","nonce":"r1-d2","fingerprint":null,"findings":"other bytes"}\n');
      const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_FAKE_OUTPUT: VERDICT_OUTPUT, AW_REVIEW_NONCE: 'r1-d2' } });
      const receipts = readReceipts(sb.repo);
      const manifest = readFileSync(manifestPath(sb.repo, 'r1-d2'), 'utf8');
      rmSync(sb.home, { recursive: true, force: true });
      assert.equal(r.status, 0, 'the review itself still succeeds (the artifact lane failed loudly)');
      assert.match(r.stderr, /DIFFERENT bytes or is not a regular file — no-clobber refuses loudly/);
      assert.match(r.stderr, /receipt append is EXCLUDED/);
      assert.equal(receipts.length, 0, 'a nonce-supplied dispatch never lands a receipt without its manifest');
      assert.match(manifest, /other bytes/, 'the pre-existing manifest is never clobbered');
    });

    it('a SYMLINK at the derived manifest path refuses and EXCLUDES the receipt — even when its target is byte-identical', () => {
      const sb = makeSandbox();
      assert.equal(run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_FAKE_OUTPUT: VERDICT_OUTPUT, AW_REVIEW_NONCE: 'sym2' } }).status, 0);
      const mPath = manifestPath(sb.repo, 'sym2');
      const target = join(sb.repo, '.git', 'manifest-target-copy.json');
      writeFileSync(target, readFileSync(mPath));
      rmSync(mPath);
      symlinkSync(target, mPath);
      const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_FAKE_OUTPUT: VERDICT_OUTPUT, AW_REVIEW_NONCE: 'sym2' } });
      const receipts = readReceipts(sb.repo);
      rmSync(sb.home, { recursive: true, force: true });
      assert.equal(r.status, 0, 'the review itself still succeeds (the artifact lane failed loudly)');
      assert.match(r.stderr, /receipt append is EXCLUDED/);
      assert.equal(receipts.length, 1, 'the second receipt is EXCLUDED — a symlinked manifest is never read through as the idempotent no-op');
    });

    it('a FIFO at the derived manifest path refuses fast and EXCLUDES the receipt (O_NONBLOCK — no hang; fix characterization)', () => {
      const sb = makeSandbox();
      const mPath = manifestPath(sb.repo, 'fifo2');
      assert.equal(spawnSync('mkfifo', [mPath], { encoding: 'utf8' }).status, 0, 'mkfifo fixture');
      const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_FAKE_OUTPUT: VERDICT_OUTPUT, AW_REVIEW_NONCE: 'fifo2' } });
      const receipts = readReceipts(sb.repo);
      rmSync(sb.home, { recursive: true, force: true });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /receipt append is EXCLUDED/);
      assert.equal(receipts.length, 0, 'a FIFO manifest is never read (fstat-first) and the receipt is excluded');
    });

    it('a BOM-prefixed captured output round-trips VERBATIM into the manifest (U+FEFF preserved)', () => {
      const sb = makeSandbox();
      const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_FAKE_OUTPUT: `\uFEFFpreamble\n${VERDICT_OUTPUT}`, AW_REVIEW_NONCE: 'b2' } });
      const manifest = JSON.parse(readFileSync(manifestPath(sb.repo, 'b2'), 'utf8'));
      rmSync(sb.home, { recursive: true, force: true });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(manifest.findings, `\uFEFFpreamble\n${VERDICT_OUTPUT}\n`, 'the captured output is VERBATIM — a stripped BOM would move the findingDigest');
    });

    it('an unsafe nonce refuses PRE-SPEND (exit 2, agy never runs) — a non-ASCII letter refuses under a UTF-8 locale too', () => {
      const sb = makeSandbox();
      const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AW_REVIEW_NONCE: 'a/b' } });
      rmSync(sb.home, { recursive: true, force: true });
      assert.equal(r.status, 2);
      assert.match(r.stderr, /safe nonce grammar/);
      assert.equal(r.invoked, false, 'the containment refusal fires before any CLI spend');
      // The grammar ENUMERATES the ASCII set (no ranges): a locale-collated [A-Za-z] could admit a
      // non-ASCII letter the kit's JS reader then refuses, breaking correlation after a paid run.
      const utf8 = makeSandbox();
      const r2 = run(utf8, { args: ['code', '--facts', 'a tiny fact'], env: { AW_REVIEW_NONCE: 'ré1', LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' } });
      rmSync(utf8.home, { recursive: true, force: true });
      assert.equal(r2.status, 2, 'a non-ASCII nonce letter refuses whatever the locale collation says');
      assert.match(r2.stderr, /safe nonce grammar/);
    });

    it('a nonce-supplied CONTINUATION mints its manifest with fingerprint null (the receipt identity is null too)', () => {
      const sb = makeSandbox();
      const r = run(sb, { args: ['--continue'], env: { AGY_FAKE_OUTPUT: VERDICT_OUTPUT, AW_REVIEW_NONCE: 'r2-c1' } });
      const receipts = readReceipts(sb.repo);
      const manifest = JSON.parse(readFileSync(manifestPath(sb.repo, 'r2-c1'), 'utf8'));
      rmSync(sb.home, { recursive: true, force: true });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(receipts.length, 1);
      assert.equal(manifest.fingerprint, null, 'a continuation carries no tree identity — the manifest says so honestly');
      assert.equal(manifest.findings, `${VERDICT_OUTPUT}\n`);
    });
  });

  it('a continuation receipt is fresh:false with null identity fields, and the wrapper prints the fresh-run notice', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['--continue', '--decided', 'already folded'], env: { AGY_FAKE_OUTPUT: VERDICT_OUTPUT } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(receipts.length, 1);
    const receipt = receipts[0];
    // A continuation delivers NOTHING (agy holds the original round server-side), so it declares no
    // delivery — the marker is a claim about a change set this receipt does not carry.
    assert.deepEqual(Object.keys(receipt), Object.keys(RECEIPT_FIXTURE).filter((k) => k !== 'delivery'), 'the fixture shape minus the delivery declaration');
    assert.equal(receipt.fresh, false, 'a continuation cannot attest the folded tree');
    assert.equal(receipt.artifact, null);
    assert.equal(receipt.fingerprint, null);
    assert.equal(receipt.grounded, false);
    assert.equal(receipt.factsHash, null);
    assert.equal(receipt.verdict, 'SHIP WITH NITS', 'the round-2 verdict is still recorded (informational)');
    assert.match(r.stderr, /fresh grounded run/, 'the one-line notice names the required fresh run');
    assert.match(r.stderr, /review-state gate/);
  });

  it('plan mode: artifact "plan", fingerprint = the artifact-file sha256', async () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.repo, 'p.md'), '# plan body\n');
    const r = run(sb, { args: ['plan', 'p.md', '--facts', 'f'], env: { AGY_FAKE_OUTPUT: VERDICT_OUTPUT } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(receipts[0].artifact, 'plan');
    assert.equal(receipts[0].fingerprint, await sha256HexOf('# plan body\n'), 'plan fingerprint = file sha256');
  });

  it('plan/diff outside a git work tree: warn + skip the receipt (exit 0) unless AW_REVIEW_RECEIPTS is set', () => {
    const sb = makeSandbox();
    const outside = join(sb.home, 'no-repo');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'p.md'), '# plan outside git\n');

    const skipped = run(sb, { args: ['plan', 'p.md', '--facts', 'f'], cwd: outside, env: { AGY_FAKE_OUTPUT: VERDICT_OUTPUT } });
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.match(skipped.stderr, /not inside a git work tree and AW_REVIEW_RECEIPTS is unset — skipping/);

    const override = join(sb.home, 'receipts-override.jsonl');
    const written = run(sb, {
      args: ['plan', 'p.md', '--facts', 'f'],
      cwd: outside,
      env: { AGY_FAKE_OUTPUT: VERDICT_OUTPUT, AW_REVIEW_RECEIPTS: override },
    });
    const body = existsSync(override) ? readFileSync(override, 'utf8') : '';
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(written.status, 0, written.stderr);
    assert.match(body, /"backend":"agy"/, 'the override path receives the receipt outside a git tree');
    assert.match(body, /"artifact":"plan"/);
  });

  it('a receipt write failure warns loudly but never fails the review (fail-safe direction)', () => {
    const sb = makeSandbox();
    const r = run(sb, {
      args: ['code', '--facts', 'f'],
      env: { AGY_FAKE_OUTPUT: VERDICT_OUTPUT, AW_REVIEW_RECEIPTS: join(sb.home, 'no-such-dir', 'r.jsonl') },
    });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, 'the review run itself succeeds');
    assert.match(r.stderr, /could not append the review receipt/);
    assert.match(r.stdout, /SHIP WITH NITS/, 'the findings still reach stdout');
  });

  it('a failed agy run writes NO receipt (only a successful review attests)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'f'], env: { AGY_FAKE_EXIT: '7' } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.equal(receipts.length, 0);
  });

  it('the clean-tree preflight exits before any receipt is written', () => {
    const sb = makeSandbox({ clean: true });
    const r = run(sb, { args: ['code', '--facts', 'f'] });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0);
    assert.equal(receipts.length, 0, 'no review ran — no receipt');
  });
});

// ── bridge settings file (bridges 2.3.0) ─────────────────────────────────────────
// ${XDG_CONFIG_HOME:-$HOME/.config}/agent-workflow/bridge-settings.conf holds KEY=VALUE
// lines, PARSED (never sourced). Precedence: explicit env (even empty: KEY= disables the
// knob) > file > built-in default. agy-review APPLIES AGY_HARD_TIMEOUT +
// AGY_REVIEW_ALLOW_ADDDIR and RECOGNIZES the whole registry. HOME is the sandbox home,
// so the default path is hermetic per test.

const writeSettings = (sb, text) => {
  const dir = join(sb.home, '.config', 'agent-workflow');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'bridge-settings.conf');
  writeFileSync(file, text);
  return file;
};
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('agy-review.sh — bridge settings file (bridges 2.3.0)', { concurrency: true }, () => {
  it('a file-set AGY_REVIEW_ALLOW_ADDDIR=1 arms nothing and states its retirement', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    writeSettings(sb, 'AGY_REVIEW_ALLOW_ADDDIR=1\n');
    const r = run(sb, { args: ['code', '--facts', 'f'], env: { AGY_MAX_PROMPT_BYTES: String(FED_CAP) } });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /AGY_REVIEW_ALLOW_ADDDIR is set \(file\) but it is RETIRED/, 'a FILE-set value is named as such, not as an env override');
    assert.match(r.stderr, /bridge-settings\.mjs --unset/, 'and gets the recovery that actually clears a file line');
    assert.ok(!r.argv.includes('--add-dir'));
  });

  // With the knob DISARMED an over-cap code review is no longer a refusal — it is the fed lane. So
  // "env wins over file" is now proven by which LANE runs, not by which error prints.
  it('env overrides file: AGY_REVIEW_ALLOW_ADDDIR env=0 file=1 → the offload stays disarmed and the fed lane runs', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    writeSettings(sb, 'AGY_REVIEW_ALLOW_ADDDIR=1\n');
    const r = run(sb, { args: ['code', '--facts', 'f'], env: { AGY_MAX_PROMPT_BYTES: String(FED_CAP), AGY_REVIEW_ALLOW_ADDDIR: '0' } });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.argv.includes('--add-dir'), 'the file-set knob is overridden — no offload');
    assert.match(r.stderr, /feeding the change set in \d+ part\(s\)/);
  });

  it('an EXPLICITLY EMPTY env (AGY_REVIEW_ALLOW_ADDDIR=) disables the file knob', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    writeSettings(sb, 'AGY_REVIEW_ALLOW_ADDDIR=1\n');
    const r = run(sb, { args: ['code', '--facts', 'f'], env: { AGY_MAX_PROMPT_BYTES: String(FED_CAP), AGY_REVIEW_ALLOW_ADDDIR: '' } });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, 'env wins over file — empty means knob off (built-in default 0)');
    assert.ok(!r.argv.includes('--add-dir'));
  });

  it('an invalid boolean warns and falls back to the built-in default (the offload stays disarmed)', () => {
    const sb = makeSandbox();
    seedFedChangeSet(sb);
    writeSettings(sb, 'AGY_REVIEW_ALLOW_ADDDIR=yes\n');
    const r = run(sb, { args: ['code', '--facts', 'f'], env: { AGY_MAX_PROMPT_BYTES: String(FED_CAP) } });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /invalid value 'yes'/);
    assert.ok(!r.argv.includes('--add-dir'));
  });

  it('a file-set AGY_HARD_TIMEOUT flows through the agy-run delegation (killed at the file cap)', async () => {
    const sb = makeSandbox();
    writeSettings(sb, 'AGY_HARD_TIMEOUT=2s\n');
    const r = await runAsync(sb, { args: ['code', '--facts', 'f'], env: { AGY_FAKE_SLEEP: '5' } });
    rmSync(sb.home, { recursive: true, force: true });
    assert.notEqual(r.status, 0, 'the file cap must apply end-to-end (reader → agy-run → timeout)');
    assert.match(r.stderr, /exceeded the hard cap AGY_HARD_TIMEOUT=2s/);
  });

  it("another bridge's valid key is skipped silently", () => {
    const sb = makeSandbox();
    writeSettings(sb, 'CODEX_SERVICE_TIER=priority\nCODEX_HARD_TIMEOUT=2\nCODEX_REVIEW_MAX_TOTAL_BYTES=100\n');
    const r = run(sb, { args: ['code', '--facts', 'f'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /bridge settings/, 'a recognized non-applied key earns NO warning');
    assert.equal(r.invoked, true);
  });

  it('a truly unknown key warns ONCE naming the file; the review is unaffected', () => {
    const sb = makeSandbox();
    writeSettings(sb, 'TOTALLY_UNKNOWN=1\nTOTALLY_UNKNOWN=2\n');
    const r = run(sb, { args: ['code', '--facts', 'f'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    const warns = r.stderr.match(/unknown key 'TOTALLY_UNKNOWN'/g) ?? [];
    assert.equal(warns.length, 1, `exactly one warning per unknown key, got ${warns.length}`);
    assert.match(r.stderr, /bridge-settings\.conf/, 'the warning must name the settings file');
    assert.equal(r.invoked, true);
  });

  it('malformed lines warn and are ignored; comments and blank lines are silent', () => {
    const sb = makeSandbox();
    writeSettings(sb, '# a comment\n\nNOT A KEY VALUE LINE\n');
    const r = run(sb, { args: ['code', '--facts', 'f'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    const malformed = r.stderr.match(/malformed line/g) ?? [];
    assert.equal(malformed.length, 1, 'comments/blank lines must NOT count as malformed');
    assert.equal(r.invoked, true);
  });

  it('an existing-but-unreadable file warns loudly and falls back to built-ins', { skip: isRoot }, () => {
    const sb = makeSandbox();
    const file = writeSettings(sb, 'AGY_REVIEW_ALLOW_ADDDIR=1\n');
    chmodSync(file, 0o000);
    const r = run(sb, { args: ['code', '--facts', 'f'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /unreadable/);
    assert.equal(r.invoked, true);
  });

  it('a settings line can NEVER execute code (command-substitution payload inert)', () => {
    const sb = makeSandbox();
    const pwned = join(sb.home, 'pwned');
    writeSettings(sb, `AGY_HARD_TIMEOUT=$(touch ${pwned})\nEVIL_KEY=\`touch ${pwned}2\`\n`);
    const r = run(sb, { args: ['code', '--facts', 'f'] });
    const executed = existsSync(pwned) || existsSync(`${pwned}2`);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(executed, false, 'file content must be parsed, never evaluated');
    assert.equal(r.invoked, true);
  });

  it('no file → byte-identical behaviour to today (no settings chatter)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'f'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /bridge settings/);
    assert.equal(r.invoked, true);
  });

  it('a DIRECTORY at the settings path warns loudly and falls back to built-ins (no crash)', () => {
    const sb = makeSandbox();
    mkdirSync(join(sb.home, '.config', 'agent-workflow', 'bridge-settings.conf'), { recursive: true });
    const r = run(sb, { args: ['code', '--facts', 'f'] });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, `a directory must degrade honestly, not kill the run: ${r.stderr}`);
    assert.match(r.stderr, /unreadable or not a regular file/);
    assert.doesNotMatch(r.stderr, /Is a directory/, 'no raw bash error may leak');
    assert.equal(r.invoked, true);
  });
});

// ── settings surface ⟷ manifest (drift guard, D6) — same contract as the codex bridge ──
const SETTINGS_HEADER = 'Settings file (KEY=VALUE, parsed never sourced; env wins over file, file wins over built-in default):';
const SIBLING_MANIFEST = JSON.parse(readFileSync(join(HERE, '..', '..', 'codex-cli-bridge', 'capability.json'), 'utf8'));
const ALL_SETTINGS = [...(MANIFEST.settings ?? []), ...(SIBLING_MANIFEST.settings ?? [])];
const SETTINGS_CMD = 'agy-review';

describe('agy-review.sh — settings surface ⟷ manifest (D6, manifest-pinned)', () => {
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

// ── strip-the-kit Phase 4: wrapper honesty (D4) + dispatch-posture labeling (D5) ────────────────
describe('agy-review.sh — wrapper honesty: a verdict-less run is a FAILED review (D4)', () => {
  it('a VERDICT-LESS review output: non-zero exit, NO receipt, the stated re-run recovery', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_FAKE_OUTPUT: 'prose without the mandated section' } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.notEqual(r.status, 0, 'a verdict-less review never exits 0');
    assert.equal(receipts.length, 0, 'NO receipt is minted for a failed review');
    assert.match(r.stderr, /### Verdict/, 'the missing section is named');
    assert.match(r.stderr, /re-run/i, 'documented as a failed review — re-run, never fatal');
  });

  it('EMPTY review output is the same failed run (non-zero, no receipt)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_FAKE_OUTPUT: '' } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.equal(receipts.length, 0);
  });

  it('the closed vocabulary still parses (SHIP WITH NITS before SHIP; REWORK) and a recognized run exits 0', () => {
    for (const [out, want] of [[VERDICT_OUTPUT, 'SHIP WITH NITS'], ['### Verdict\nREWORK — reasons.\n', 'REWORK']]) {
      const sb = makeSandbox();
      const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_FAKE_OUTPUT: out } });
      const receipts = readReceipts(sb.repo);
      rmSync(sb.home, { recursive: true, force: true });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(receipts[0].verdict, want);
    }
  });
});

describe('agy-review.sh — dispatch-posture labeling (D5)', () => {
  it('ONE banner line carries the ACTUAL model and the receipt carries the SAME posture (agy has no tier)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'a tiny fact'] });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /review posture: model=Gemini 3\.1 Pro \(High\)/, 'the banner states the actual run posture');
    assert.deepEqual(receipts[0].posture, { model: 'Gemini 3.1 Pro (High)' }, 'banner ↔ receipt parity');
    assert.deepEqual(Object.keys(receipts[0]), Object.keys(RECEIPT_FIXTURE), 'fixture key set + order');
  });

  it('an ATTESTING review with AGY_MODEL explicitly emptied REFUSES pre-spend naming the fix', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_MODEL: '' } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.equal(r.invoked, false, 'refused BEFORE any spend');
    assert.equal(receipts.length, 0);
    assert.match(r.stderr, /AGY_MODEL/, 'the fix is named');
  });

  it('AGY_PROBE=1 with AGY_MODEL emptied still runs (probe exempt; posture model null on the probe receipt)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_MODEL: '', AGY_PROBE: '1' } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(receipts[0].probe, true);
    assert.deepEqual(receipts[0].posture, { model: null }, 'an unknowable model is recorded null, never guessed');
  });

  it('a HOSTILE model string (quotes + backslash) rides the receipt strictly JSON-encoded', () => {
    const hostile = 'we"ird \\ mo"del';
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_MODEL: hostile } });
    const receipts = readReceipts(sb.repo); // JSON.parse throwing here IS the encoding failure
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(receipts[0].posture.model, hostile, 'the exact bytes round-trip through strict encoding');
    assert.match(r.stderr, /review posture: /, 'the banner still renders');
  });

  it('a model string carrying CONTROL BYTES refuses pre-spend (never a broken banner or receipt)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_MODEL: `bad${String.fromCharCode(1)}model` } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.equal(r.invoked, false);
    assert.equal(receipts.length, 0);
    assert.match(r.stderr, /control/i);
  });

  it('the banner appends the RESOLVED hard timeout verbatim — banner-only, never in the receipt (AD-061)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'a tiny fact'] });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^review posture: model=Gemini 3\.1 Pro \(High\) timeout=30m$/m);
    assert.deepEqual(Object.keys(receipts[0].posture), ['model'], 'timeout never enters the receipt posture');
  });

  it('the banner prints the EFFECTIVE hard cap: an env override and a fractional duration ride verbatim', () => {
    for (const [envValue, want] of [['90s', '90s'], ['1.5m', '1\\.5m']]) {
      const sb = makeSandbox();
      const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_HARD_TIMEOUT: envValue } });
      rmSync(sb.home, { recursive: true, force: true });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, new RegExp(`^review posture: .* timeout=${want}$`, 'm'));
    }
  });

  it('AGY_TIMEOUT (soft print-timeout) alone never moves the banner — the hard cap governs (precedence pin)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_TIMEOUT: '5m' } });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^review posture: .* timeout=30m$/m, 'the soft print-timeout is not the banner value');
  });

  it('an INVALID / EMPTY / OVERFLOW effective AGY_HARD_TIMEOUT falls back to the built-in default (loud on invalid)', () => {
    for (const [bad, wantWarn] of [['10x', true], ['', false], ['99999999m', true]]) {
      const sb = makeSandbox();
      const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_HARD_TIMEOUT: bad } });
      rmSync(sb.home, { recursive: true, force: true });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /^review posture: .* timeout=30m$/m, `default must stand for ${JSON.stringify(bad)}`);
      if (wantWarn) assert.match(r.stderr, new RegExp(`invalid value '${bad}' for AGY_HARD_TIMEOUT`));
    }
  });

  it('a timeout value carrying CONTROL BYTES refuses pre-spend (the banner-field screen)', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_HARD_TIMEOUT: `30m${String.fromCharCode(1)}` } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.equal(r.invoked, false);
    assert.equal(receipts.length, 0);
    assert.match(r.stderr, /control/i);
  });

  // The two-stage cap guarantee: the parent preflight fails closed, and the seam
  // (AGY_REQUIRE_TIMEOUT_BIN=1) makes the CHILD's missing-binary lane refuse too — but only a
  // child that HONORS the seam. A stale installed agy-run that never reads it could run uncapped
  // past the parent preflight, so the parent verifies the resolved child carries the seam token
  // and refuses loudly naming the refresh recovery otherwise.
  it('a STALE agy-run child that does not honor the timeout seam refuses fail-closed (never a silently uncapped dispatch)', () => {
    const sb = makeSandbox();
    const staleDir = join(sb.home, 'stale-bin');
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, 'agy-run'), '#!/usr/bin/env bash\nprintf "FAKE_AGY_REVIEW_OUTPUT\\n### Verdict\\nSHIP\\n"\n', { mode: 0o755 });
    const r = run(sb, {
      args: ['code', '--facts', 'a tiny fact'],
      env: { PATH: `${staleDir}:${sb.bin}:${farmFor(['agy-run'])}` },
    });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 127, 'a seam-blind child is a stale bridge install — refuse, never dispatch uncapped');
    assert.match(r.stderr, /does not honor the AGY_REQUIRE_TIMEOUT_BIN seam/);
    assert.equal(receipts.length, 0, 'no dispatch, no receipt');
  });

  // Flow-orchestration Phase 4.2 (#26): the uncapped lane is CLOSED — without a capping binary the
  // preflight refuses by name BEFORE any CLI run (the pre-fix wrapper printed timeout=uncapped and
  // ran anyway). The shadow-proof resolver discipline now surfaces as the REFUSAL, not a banner.
  it('fails CLOSED when no timeout/gtimeout is on PATH — refuses by name, agy never runs', () => {
    const sb = makeSandbox();
    const r = run(sb, {
      args: ['code', '--facts', 'a tiny fact'],
      env: { PATH: `${sb.bin}:${farmFor(['agy', 'agy-run', 'timeout', 'gtimeout'])}` },
    });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 127, 'the hard-timeout preflight is a refusal, never a warned uncapped run');
    assert.match(r.stderr, /hard-timeout preflight fails CLOSED/);
    assert.equal(r.invoked, false, 'agy must NOT be invoked when the preflight refuses');
  });

  it('an EXPORTED shell function shadowing timeout never fools the preflight (type -P discipline)', () => {
    const sb = makeSandbox();
    const r = run(sb, {
      args: ['code', '--facts', 'a tiny fact'],
      env: {
        PATH: `${sb.bin}:${farmFor(['agy', 'agy-run', 'timeout', 'gtimeout'])}`,
        'BASH_FUNC_timeout%%': '() { return 0; }',
      },
    });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 127, 'a shell function is not a capping binary — the preflight still refuses');
    assert.match(r.stderr, /hard-timeout preflight fails CLOSED/);
  });

  it('an EXPORTED `type` function faking a path never fools the resolver (builtin type discipline)', () => {
    const sb = makeSandbox();
    const r = run(sb, {
      args: ['code', '--facts', 'a tiny fact'],
      env: {
        PATH: `${sb.bin}:${farmFor(['agy', 'agy-run', 'timeout', 'gtimeout'])}`,
        'BASH_FUNC_type%%': '() { echo /fake/timeout; }',
      },
    });
    rmSync(sb.home, { recursive: true, force: true });
    assert.equal(r.status, 127, 'builtin type bypasses an exported type function — the preflight still refuses');
    assert.match(r.stderr, /hard-timeout preflight fails CLOSED/);
  });

  it('a DEL (0x7f) byte in a banner field refuses pre-spend like the C0 range', () => {
    const sb = makeSandbox();
    const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_MODEL: `bad${String.fromCharCode(127)}model` } });
    const receipts = readReceipts(sb.repo);
    rmSync(sb.home, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.equal(r.invoked, false);
    assert.equal(receipts.length, 0);
    assert.match(r.stderr, /control/i);
  });

  it('a control byte in AGY_TIMEOUT refuses pre-spawn — agy-review forwards it to the child agy-run', () => {
    for (const c of [1, 127]) {
      const sb = makeSandbox();
      const r = run(sb, { args: ['code', '--facts', 'a tiny fact'], env: { AGY_TIMEOUT: `30m${String.fromCharCode(c)}` } });
      const receipts = readReceipts(sb.repo);
      rmSync(sb.home, { recursive: true, force: true });
      assert.notEqual(r.status, 0, `must refuse control byte ${c}`);
      assert.equal(r.invoked, false, 'refused BEFORE spawning agy-run');
      assert.equal(receipts.length, 0);
      assert.match(r.stderr, /AGY_TIMEOUT/, 'names the offending knob');
    }
  });
});
