// Shared harness for the agy-review wrapper suites. PORTING TRAP: agy takes the prompt as the
// `-p` ARGV value, NOT stdin — the fake captures the -p value from argv.
import assert from 'node:assert/strict';
import { after } from 'node:test';
import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync,
  existsSync, readdirSync, symlinkSync, cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFile } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
export const WRAPPER = join(HERE, 'agy-review.sh');

const FAKE_ENVELOPE_ENCODER = [
  'const text = require("node:fs").readFileSync(0, "utf8");',
  'const [cid, status, shape] = process.argv.slice(1);',
  'const envelope = { conversation_id: cid, status, response: text, duration_seconds: 1.5, num_turns: 1,',
  '  usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 15 } };',
  'if (shape === "missing") delete envelope.conversation_id;',
  'if (shape === "number") envelope.conversation_id = 42;',
  'process.stdout.write(`${JSON.stringify(envelope)}\\n`);',
].join('\n');

export const FAKE_AGY = [
  '#!/usr/bin/env bash',
  'set -u',
  // --help / --version answer BEFORE any capture file is touched — a probe is never a paid dispatch.
  'case "${1:-}" in',
  '  --help|-h)',
  '    if [[ -n "${AGY_FAKE_HELP_EXIT:-}" ]]; then echo "fake agy: help unavailable" >&2; exit "$AGY_FAKE_HELP_EXIT"; fi',
  '    for f in --output-format --json-schema --disable-slash-commands --effort --mode; do',
  '      if [[ "$f" == "${AGY_FAKE_HELP_OMIT:-}" ]]; then continue; fi',
  '      printf "  %s   fake capability line\\n" "$f"',
  '    done',
  '    if [[ -n "${AGY_FAKE_HELP_EXTRA:-}" ]]; then printf "%s\\n" "$AGY_FAKE_HELP_EXTRA"; fi',
  '    exit 0 ;;',
  '  --version) printf "%s\\n" "${AGY_FAKE_VERSION:-1.1.13}"; exit 0 ;;',
  'esac',
  ': "${AGY_FAKE_ARGV:=/dev/null}"',
  ': "${AGY_FAKE_ENV:=/dev/null}"',
  ': "${AGY_FAKE_PROMPT:=/dev/null}"',
  ': "${AGY_FAKE_SENTINEL:=/dev/null}"',
  'printf invoked > "$AGY_FAKE_SENTINEL"',
  'printf "%s" "$PWD" > "${AGY_FAKE_CWD:-/dev/null}"',
  '{ for a in "$@"; do printf "%s\\n" "$a"; done; } > "$AGY_FAKE_ARGV"',
  '{ echo "FOO_API_KEY=${FOO_API_KEY:-<unset>}"; echo "ANTIGRAVITY_API_KEY=${ANTIGRAVITY_API_KEY:-<unset>}"; } > "$AGY_FAKE_ENV"',
  'prompt=""',
  'prev=""; for a in "$@"; do if [[ "$prev" == "-p" ]]; then prompt="$a"; printf "%s" "$a" > "$AGY_FAKE_PROMPT"; fi; prev="$a"; done',
  'aw_fmt=""',
  'prev=""; for a in "$@"; do if [[ "$prev" == "--output-format" ]]; then aw_fmt="$a"; fi; prev="$a"; done',
  // AGY_FAKE_BAD_TURN scopes the transport-breaking knobs to ONE turn; AGY_FAKE_RAW_STDOUT bypasses
  // the envelope encoder entirely.
  'aw_fake_emit() {',
  '  local body="$1" aw_status="${AGY_FAKE_STATUS:-SUCCESS}" aw_raw=""',
  '  if [[ -n "${AGY_FAKE_RAW_STDOUT+x}" ]]; then aw_raw=1; fi',
  '  if [[ -n "${AGY_FAKE_BAD_TURN:-}" && "$turn" != "${AGY_FAKE_BAD_TURN}" ]]; then aw_status="SUCCESS"; aw_raw=""; fi',
  '  if [[ -n "${AGY_FAKE_STDERR:-}" ]]; then printf "%s\\n" "$AGY_FAKE_STDERR" >&2; fi',
  '  if [[ -n "$aw_raw" ]]; then printf "%s" "$AGY_FAKE_RAW_STDOUT"; return 0; fi',
  '  if [[ "$aw_fmt" != "json" ]]; then printf "%s\\n" "$body"; return 0; fi',
  `  printf "%s\\n" "$body" | node -e '${FAKE_ENVELOPE_ENCODER}' \\`,
  '    "${AGY_FAKE_CONV_ID:-11111111-2222-3333-4444-555555555555}" "$aw_status" "${AGY_FAKE_CONV_SHAPE:-ok}"',
  '}',
  'prev=""; for a in "$@"; do',
  '  if [[ "$prev" == "--add-dir" ]]; then',
  '    printf "%s" "$a" > "${AGY_FAKE_ADDDIR:-/dev/null}"',
  '    stat -c "%a" "$a" > "${AGY_FAKE_ADDDIR_MODE:-/dev/null}" 2>/dev/null || true',
  '    art="$a/precomputed-change-set"',
  '    if [[ -f "$art" ]]; then stat -c "%a" "$art" > "${AGY_FAKE_ARTIFACT_MODE:-/dev/null}" 2>/dev/null || true; cp "$art" "${AGY_FAKE_ARTIFACT_COPY:-/dev/null}" 2>/dev/null || true; fi',
  '  fi; prev="$a"',
  'done',
  'if [[ -n "${AGY_FAKE_SLEEP:-}" ]]; then sleep "$AGY_FAKE_SLEEP"; fi',
  // The fed lane needs a PER-TURN record: each invocation writes prompt/argv to "<file>.<turn>".
  'turn=1',
  'if [[ -n "${AGY_FAKE_TURNS:-}" ]]; then',
  '  if [[ -s "$AGY_FAKE_TURNS" ]]; then turn=$(( $(cat "$AGY_FAKE_TURNS") + 1 )); fi',
  '  printf "%s" "$turn" > "$AGY_FAKE_TURNS"',
  '  printf "%s" "$prompt" > "${AGY_FAKE_PROMPT}.$turn"',
  '  { for a in "$@"; do printf "%s\\n" "$a"; done; } > "${AGY_FAKE_ARGV}.$turn"',
  'fi',
  'if [[ -n "${AGY_FAKE_FAIL_TURN:-}" && "$turn" == "${AGY_FAKE_FAIL_TURN}" ]]; then',
  '  printf "FAKE_TURN_FAILURE\\n" >&2; exit 3',
  'fi',
  // A FEED turn deliberately misbehaves (a premature verdict) so the isolation invariant is proven
  // against the worst case.
  'if [[ -z "${AGY_FAKE_OUTPUT+x}" && "$prompt" == *"--- BEGIN CHANGE-SET PART "* && "$prompt" != *"Requested addresses"* ]]; then',
  '  aw_fake_emit "$(printf "PREMATURE_FEED_CHATTER\\n### Verdict\\nREWORK")"; exit 0',
  'fi',
  // The FINAL turn answers the delivery-proof request honestly: by reading the bodies it was fed.
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
  '  out="$( {',
  '    if [[ "${AGY_FAKE_PROOF_LATE:-}" == "1" ]]; then printf "### Verdict\\nSHIP\\n"; fi',
  '    if [[ "${AGY_FAKE_PROOF_CASE:-}" == "1" ]]; then printf "### Delivery Proof\\n"; else printf "### Delivery proof\\n"; fi',
  '    if [[ "${AGY_FAKE_PROOF_OUTSIDE:-}" == "1" ]]; then',
  '      printf "(nothing here)\\n### Verdict\\nSHIP\\n"',
  '      if (( ${#entries[@]} > 0 )); then printf "%s\\n" "${entries[@]}"; fi',
  '    else',
  '      if (( ${#entries[@]} > 0 )); then printf "%s\\n" "${entries[@]}"; fi',
  '      printf "### Verdict\\nSHIP\\n"',
  '    fi',
  '    if [[ -n "${AGY_FAKE_FINAL_APPEND:-}" ]]; then printf "%s\\n" "$AGY_FAKE_FINAL_APPEND"; fi',
  '  } )"',
  '  aw_fake_emit "$out"',
  '  exit 0',
  'fi',
  'if [[ -z "${AGY_FAKE_OUTPUT+x}" ]]; then aw_fake_emit "$(printf "FAKE_AGY_REVIEW_OUTPUT\\n### Verdict\\nSHIP")"; else aw_fake_emit "$AGY_FAKE_OUTPUT"; fi',
  'exit "${AGY_FAKE_EXIT:-0}"',
  '',
].join('\n');

// A PATH whose entries are symlinks to the real PATH binaries EXCEPT the excluded names.
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

// Farms and the sandbox template are read-only per invocation, so both are built ONCE and shared.
const SHARED_ROOT = mkdtempSync(join(tmpdir(), 'agy-review-shared-'));
after(() => rmSync(SHARED_ROOT, { recursive: true, force: true }));
const farms = new Map();
export const farmFor = (exclude) => {
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

// `clean: true` leaves a pristine committed tree; the default leaves one untracked file so `code`
// mode has a diff to review.
export const makeSandbox = ({ clean = false } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'agy-review-test-'));
  cpSync(TEMPLATE_HOME, home, { recursive: true });
  const bin = join(home, '.local', 'bin');
  chmodSync(join(bin, 'agy'), 0o755);
  const repo = join(home, 'repo');
  const g = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (!clean) writeFileSync(join(repo, 'pending.txt'), 'PENDING_UNTRACKED_BODY\n');
  return { home, bin, repo, g };
};

let runSeq = 0;
// Asynchronous on purpose: a blocking spawnSync pinned the whole suite to one core.
export const run = (sb, { args, env = {}, cwd, wrapper } = {}) => new Promise((settle) => {
  const { home, bin, repo } = sb;
  const farm = farmFor(['agy', 'agy-run']);
  const tag = `cap-${++runSeq}`;
  const cap = {
    argv: join(home, `${tag}-argv`), env: join(home, `${tag}-env`), prompt: join(home, `${tag}-prompt`),
    sentinel: join(home, `${tag}-sentinel`), adddir: join(home, `${tag}-adddir`),
    adddirMode: join(home, `${tag}-adddir-mode`), artifactMode: join(home, `${tag}-artifact-mode`),
    artifactCopy: join(home, `${tag}-artifact-copy`), turns: join(home, `${tag}-turns`),
    dispatchCwd: join(home, `${tag}-dispatch-cwd`),
  };
  const child = execFile('bash', [wrapper || WRAPPER, ...args], {
    cwd: cwd || repo,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      HOME: home,
      PATH: `${bin}:${farm}`,
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      AGY_FAKE_ARGV: cap.argv, AGY_FAKE_ENV: cap.env, AGY_FAKE_PROMPT: cap.prompt,
      AGY_FAKE_SENTINEL: cap.sentinel, AGY_FAKE_ADDDIR: cap.adddir, AGY_FAKE_ADDDIR_MODE: cap.adddirMode,
      AGY_FAKE_ARTIFACT_MODE: cap.artifactMode, AGY_FAKE_ARTIFACT_COPY: cap.artifactCopy,
      AGY_FAKE_TURNS: cap.turns, AGY_FAKE_CWD: cap.dispatchCwd,
      ...env,
    },
  }, (error, stdout, stderr) => {
    const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
    const turns = existsSync(cap.turns) ? Number(readFileSync(cap.turns, 'utf8')) : 0;
    const prompts = [];
    const argvs = [];
    for (let i = 1; i <= turns; i += 1) {
      prompts.push(readIf(`${cap.prompt}.${i}`));
      argvs.push(readIf(`${cap.argv}.${i}`));
    }
    settle({
      status: error ? (error.code ?? 1) : 0, signal: error?.signal ?? null, stdout, stderr,
      invoked: existsSync(cap.sentinel),
      argv: readIf(cap.argv), capEnv: readIf(cap.env), prompt: readIf(cap.prompt),
      adddir: readIf(cap.adddir).trim(), adddirMode: readIf(cap.adddirMode).trim(),
      artifactMode: readIf(cap.artifactMode).trim(), artifactCopy: readIf(cap.artifactCopy),
      dispatchCwd: readIf(cap.dispatchCwd).trim(), turns, prompts, argvs,
    });
  });
  // Only EPIPE is a refusal working — any other stdin write failure must reach the test.
  child.stdin.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
  child.stdin.end();
});

export const runAsync = run;

export const RECEIPTS_REL = join('.git', 'agent-workflow-review-receipts.jsonl');
export const readReceipts = (repo) => {
  const p = join(repo, RECEIPTS_REL);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

// The chunked-feed lane: an over-cap change set is DELIVERED over turns and its delivery is PROVEN
// by verbatim line echoes the final answer must reproduce.
export const ARTIFACT_HEADER = '## The change set under review (assembled working-tree diff — repo-complete)';
export const SHAPE_HEADER = '\n## Output — Markdown, this exact shape, nothing else';
export const FED_CAP = 6000;
export const MAX_COUNTABLE_PROOF_ADDRESS = 40;
export const FED_WIDE_CAP = 24000;
export const isAssemblerBanner = (line) =>
  /^=== (repo file map|git status|staged diff|unstaged diff|untracked)/.test(line) && line.endsWith(' ===');

export const seedFedChangeSet = (sb, { lines = 400, multibyte = false } = {}) => {
  const body = Array.from({ length: lines }, (_, i) =>
    multibyte
      ? `line ${String(i).padStart(4, '0')} — multibyte marker ${'\u044e'.repeat(20)}`
      : `unique change-set line ${String(i).padStart(4, '0')} — a distinctive body marker ${'x'.repeat(20)}`).join('\n');
  writeFileSync(join(sb.repo, 'oversized.txt'), `${body}\n`);
};

export const inlineArtifactOf = (prompt) => prompt.slice(prompt.indexOf(ARTIFACT_HEADER), prompt.indexOf(SHAPE_HEADER));
export const bodyOf = (turnPrompt) => {
  const begin = turnPrompt.match(/--- BEGIN CHANGE-SET PART \d+ OF \d+ ---\n/);
  if (!begin) return null;
  const start = begin.index + begin[0].length;
  return turnPrompt.slice(start, turnPrompt.indexOf('\n--- END CHANGE-SET PART ', start));
};
export const requestedBlockOf = (finalPrompt) => {
  const start = finalPrompt.indexOf('Requested addresses');
  assert.notEqual(start, -1, 'the final turn states which lines it requires');
  const after2 = finalPrompt.slice(finalPrompt.indexOf('\n', start) + 1);
  return after2.slice(0, after2.indexOf('\n###')).split('\n').filter(Boolean);
};
export const requestedOf = (finalPrompt) => requestedBlockOf(finalPrompt).map((item) => {
  const [, part, line] = item.match(/^part (\d+) line (\d+)$/);
  return { part: Number(part), line: Number(line) };
});
export const fedRun = (sb, extraEnv = {}) =>
  run(sb, { args: ['code', '--facts', 'grounded fact'], env: { AGY_MAX_PROMPT_BYTES: String(FED_CAP), ...extraEnv } });
