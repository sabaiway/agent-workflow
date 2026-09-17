// core-evidence-red-proof.mjs — the red-proof probe: the test-file safeguards and the N-rerun observation; the contract is the header of core-evidence.mjs.

import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, normalize, sep, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lexicalRepoRelative } from './repo-lex.mjs';
import { GIT_MAX_BUFFER } from './git-env.mjs';
import { splitTestId } from './core-evidence-store-read.mjs';

// ── the probe safeguards (moved verbatim from the retired fold runner) ────────────────────────────

// Node sets NODE_TEST_CONTEXT for any process running UNDER `node --test`; a fresh `node --test`
// that inherits it silently SKIPS running its files. The probe spawns `node --test`, so it strips
// that var (a no-op in normal invocation).
export const childTestEnv = (env, extra = {}) => {
  const out = { ...env, ...extra };
  delete out.NODE_TEST_CONTEXT;
  return out;
};

const PROBE_RESULT_RE = /^(ok|not ok) \d+ - (.*)$/;
const PROBE_FAIL_RE = /^# fail (\d+)$/;
const PROBE_DIRECTIVE_RE = /#\s*(?:skip|todo)\b/i; // a TAP SKIP/TODO directive — the test did NOT run

// parseProbeOutput({ stdout, code, fileArg }) → { resolvable, executed, baselineGreen }. The file
// wrapper is matched by BASENAME (node normalizes the echoed path); a directive-carrying result
// line never counts (some Node lines emit pattern-filtered tests as SKIP — the guard is
// version-agnostic on purpose).
export const parseProbeOutput = ({ stdout, code, fileArg }) => {
  let matched = 0;
  let notOk = 0;
  let failCount = null;
  const wanted = basename(String(fileArg).trim());
  for (const line of String(stdout).split('\n')) {
    const m = PROBE_RESULT_RE.exec(line);
    if (m && !PROBE_DIRECTIVE_RE.test(m[2]) && basename(m[2].trim()) !== wanted) {
      matched += 1;
      if (m[1] === 'not ok') notOk += 1;
    }
    const f = PROBE_FAIL_RE.exec(line.trim());
    if (f) failCount = Number(f[1]);
  }
  const resolvable = matched > 0;
  const fails = (failCount ?? 0) + notOk;
  return { resolvable, executed: matched, baselineGreen: resolvable && code === 0 && fails === 0 };
};

// The shell-free node:test argv. The pattern rides `=`-joined: as a separate token a pattern
// beginning with "-" would parse as an OPTION and silently select no test.
export const defaultBoundArgv = (file, pattern) => ['node', '--test', '--test-reporter', 'tap', `--test-name-pattern=${pattern}`, file];

// containsPath(realRoot, realAbs) → strictly INSIDE. Segment-safe ('/a' never contains '/ab') and
// correct for a repo at the filesystem root.
export const containsPath = (realRoot, realAbs) => realAbs.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);

// resolveTestFile(rootTop, rel, deps?) → { ok: true, abs } | { ok: false, reason } (never throws).
// Repo-relative only; a REGULAR file under no-follow lstat; the RESOLVED real path contained under
// the REAL repo root (a leaf check alone would let a symlinked PARENT directory escape).
export const resolveTestFile = (rootTop, rel, deps = {}) => {
  const lstat = deps.lstat ?? lstatSync;
  const realpath = deps.realpath ?? realpathSync;
  const lex = lexicalRepoRelative(rel);
  if (!lex.ok) return { ok: false, reason: lex.reason };
  const abs = join(rootTop, normalize(rel));
  let st;
  try {
    st = lstat(abs);
  } catch {
    return { ok: false, reason: `file "${rel}" does not exist` };
  }
  if (!st.isFile()) return { ok: false, reason: `"${rel}" is not a regular file (a symlink/directory/device is never followed — fail closed)` };
  let realAbs;
  let realRoot;
  try {
    realAbs = realpath(abs);
    realRoot = realpath(rootTop);
  } catch {
    return { ok: false, reason: `cannot resolve the real path of "${rel}"` };
  }
  if (!containsPath(realRoot, realAbs)) return { ok: false, reason: `"${rel}" resolves outside the repo root (a symlinked parent directory) — fail closed` };
  return { ok: true, abs: realAbs };
};

// sha-256 over the file's BYTES; null on a read failure (the caller reads that as unresolvable).
export const hashFileBytes = (abs) => {
  try {
    return createHash('sha256').update(readFileSync(abs)).digest('hex');
  } catch {
    return null;
  }
};

// The N-rerun probe. The custody hash is taken BEFORE the runs (the content the observation
// attests); the spawn ALWAYS uses the resolver's canonical absolute path — the executed file must
// be the hashed file independent of runner path semantics. A timed-out or signal-killed run is
// neither red nor green — it lands in `timeouts` (quarantine fuel).
export const probeBound = ({ testId, rootTop, env, reruns, timeoutS }) => {
  const { file, pattern } = splitTestId(testId);
  const resolved = resolveTestFile(rootTop, file);
  const fileHash = resolved.ok ? hashFileBytes(resolved.abs) : null;
  let executed = 0;
  let greens = 0;
  let reds = 0;
  let timeouts = 0;
  if (resolved.ok && fileHash != null) {
    for (let i = 0; i < reruns; i += 1) {
      const argv = defaultBoundArgv(resolved.abs, pattern);
      const res = spawnSync(argv[0], argv.slice(1), {
        cwd: rootTop, env: childTestEnv(env), encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, timeout: timeoutS * 1000,
      });
      if ((res.error && res.error.code === 'ETIMEDOUT') || res.signal != null) {
        timeouts += 1;
        continue;
      }
      const p = parseProbeOutput({ stdout: res.stdout ?? '', code: res.error ? 1 : res.status ?? 1, fileArg: file });
      executed = Math.max(executed, p.executed);
      if (!p.resolvable) continue;
      if (p.baselineGreen) greens += 1;
      else reds += 1;
    }
  }
  const entry = { executed, runs: reruns, greens, reds, timeouts, fileHash };
  return { entry, file, resolveReason: resolved.ok ? (fileHash == null ? `cannot read "${file}"` : null) : resolved.reason };
};
