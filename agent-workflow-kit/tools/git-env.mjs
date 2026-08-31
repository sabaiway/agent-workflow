// git-env.mjs — the kit's git-location leaf: WHICH repository a git spawn will talk to, judged by
// AGREEMENT, never by a variable ban (measured 2026-08-31, git 2.43: an ambient GIT_DIR made three
// consumers judge ANOTHER repository in silence; a killed git read as "not a git work tree", a pass).
// The six-state table, the GIT_* strip, the hermetic env, the ls-files parser. A pure LEAF.

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const GIT_MAX_BUFFER = 256 * 1024 * 1024;
export const GIT_LOCATION_STATES = Object.freeze(['work-tree', 'not-a-repository', 'error', 'redirected', 'no-work-tree', 'env-only']);
const LOCATION_VARIABLES = 'GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR';

// ASCII-case-insensitive prefix (a case-insensitive host honours `git_dir` as GIT_DIR) — an ASCII
// class, never toUpperCase(): Unicode case folding would also strip a foreign `g<dotless-i>t_dir`.
export const stripGitLocationEnv = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => !/^[Gg][Ii][Tt]_/.test(key)));

// The test fixtures' env, never a consumer's: the strip plus every host-reaching knob pinned.
export const hermeticGitEnv = (env, home) => ({
  ...stripGitLocationEnv(env),
  HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', LC_ALL: 'C',
});

// An env naming no PATH (a partial override, a test's `{}`) borrows the process PATH; one naming a PATH is honoured as is.
export const withGitPath = (env) => (env.PATH === undefined && process.env.PATH !== undefined ? { ...env, PATH: process.env.PATH } : env);

// `ls-files -s -z` records: mode, object, stage, TAB, then the path BYTES up to the NUL — undecoded.
export const parseIndexEntries = (buf) => {
  const entries = [];
  for (let start = 0; start < buf.length;) {
    let end = buf.indexOf(0, start);
    if (end === -1) end = buf.length;
    const record = buf.subarray(start, end);
    const tab = record.indexOf(0x09);
    if (tab !== -1) {
      const [mode, sha, stage] = record.subarray(0, tab).toString('utf8').split(' ');
      entries.push({ mode, sha, stage: Number(stage), path: record.subarray(tab + 1) });
    }
    start = end + 1;
  }
  return entries;
};

const NOT_A_REPOSITORY = /not a git repository/u;
const NO_WORK_TREE = /must be run in a work tree/u;

// ONE rev-parse identity per spawn → ok { line } | not-a-repository | no-work-tree | error (a throw,
// ENOENT, a signal, any other exit, an EMPTY answer). The answer is the stdout minus exactly one
// terminating LF — never a split: a path may carry a newline. LC_ALL=C pins git's own wording.
const probe = (arg, { cwd, env, spawn }) => {
  let r;
  try {
    r = spawn('git', ['rev-parse', arg], { cwd, env: { ...withGitPath(env), LC_ALL: 'C' }, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
  } catch (err) {
    return { kind: 'error', cause: `git threw synchronously (${err?.message ?? err})` };
  }
  if (r == null || typeof r !== 'object') return { kind: 'error', cause: 'the git runner returned no result' };
  if (r.error) return { kind: 'error', cause: `git could not run (${r.error.code ?? r.error.message ?? r.error})` };
  if (r.signal) return { kind: 'error', cause: `git rev-parse ${arg} was killed by ${r.signal}` };
  const stderr = String(r.stderr ?? '').trim();
  if (r.status === 128 && NOT_A_REPOSITORY.test(stderr)) return { kind: 'not-a-repository', cause: stderr };
  if (r.status === 128 && NO_WORK_TREE.test(stderr)) return { kind: 'no-work-tree', cause: stderr };
  if (r.status !== 0) return { kind: 'error', cause: `git rev-parse ${arg} exited ${r.status}${stderr ? ` (${stderr})` : ''}` };
  const line = String(r.stdout ?? '').replace(/\n$/u, '');
  if (line.length === 0) return { kind: 'error', cause: `git rev-parse ${arg} answered nothing` };
  return { kind: 'ok', line };
};

const identity = (cwd, line, realpath) => {
  try { return { ok: true, path: realpath(resolve(cwd, line)) }; } catch (err) { return { ok: false, cause: `${line} cannot be resolved (${err?.code ?? err?.message ?? err})` }; }
};

const located = (state, cause, facts = {}) => ({ state, cause, top: null, gitDir: null, commonDir: null, ...facts });

// resolveGitLocation(cwd, { spawn, env, realpath }) → { state, cause, top, gitDir, commonDir }: the
// REALPATH identity of the git dir, the common dir and the work-tree top, ambient env vs the
// GIT_-stripped discovery from cwd. Only `work-tree` proceeds.
export const resolveGitLocation = (cwd, deps = {}) => {
  const spawn = deps.spawn ?? spawnSync;
  const env = deps.env ?? process.env;
  const realpath = deps.realpath ?? realpathSync;
  const ambient = { cwd, env, spawn };
  const stripped = { cwd, env: stripGitLocationEnv(env), spawn };
  // Precedence (fail closed): the GIT DIR probes decide whether each discovery reaches a repository;
  // the COMMON DIR and TOP probes then owe ok (or no-work-tree for the top) — anything else is error.
  const a = probe('--absolute-git-dir', ambient);
  const s = probe('--absolute-git-dir', stripped);
  if (a.kind === 'error' || a.kind === 'no-work-tree') return located('error', a.cause);
  if (s.kind === 'error' || s.kind === 'no-work-tree') return located('error', `under the GIT_-stripped discovery from ${cwd}: ${s.cause}`);
  if (a.kind === 'not-a-repository' && s.kind === 'not-a-repository') return located('not-a-repository', a.cause);
  if (a.kind === 'not-a-repository') return located('redirected', `the ambient git environment (${LOCATION_VARIABLES}) reaches no repository (${a.cause}) while the discovery from ${cwd} does`);
  if (s.kind === 'not-a-repository') return located('env-only', `the ambient git environment (${LOCATION_VARIABLES}) reaches the git dir ${a.line} while the GIT_-stripped discovery from ${cwd} reaches no repository (${s.cause})`);
  const ids = {};
  const ac = probe('--git-common-dir', ambient);
  const sc = probe('--git-common-dir', stripped);
  if (ac.kind !== 'ok') return located('error', `the common dir under the ambient git environment: ${ac.cause}`);
  if (sc.kind !== 'ok') return located('error', `the common dir under the GIT_-stripped discovery: ${sc.cause}`);
  for (const [name, ax, sx] of [['git dir', a, s], ['common dir', ac, sc]]) {
    const x = identity(cwd, ax.line, realpath);
    const y = identity(cwd, sx.line, realpath);
    if (!x.ok) return located('error', `the ${name} under the ambient git environment: ${x.cause}`);
    if (!y.ok) return located('error', `the ${name} under the GIT_-stripped discovery: ${y.cause}`);
    if (x.path !== y.path) return located('redirected', `the ${name} differs: the ambient git environment (${LOCATION_VARIABLES}) resolves it to ${x.path}, the discovery from ${cwd} to ${y.path}`);
    ids[name] = x.path;
  }
  const at = probe('--show-toplevel', ambient);
  const st = probe('--show-toplevel', stripped);
  if (at.kind === 'error' || at.kind === 'not-a-repository') return located('error', at.cause);
  if (st.kind === 'error' || st.kind === 'not-a-repository') return located('error', `under the GIT_-stripped discovery from ${cwd}: ${st.cause}`);
  if (at.kind === 'no-work-tree' && st.kind === 'no-work-tree') return located('no-work-tree', `the git dir ${ids['git dir']} agrees but git names no work tree (${at.cause})`);
  if (at.kind === 'no-work-tree') return located('redirected', `the ambient git environment (${LOCATION_VARIABLES}) names no work tree (${at.cause}) while the discovery from ${cwd} reaches one`);
  if (st.kind === 'no-work-tree') return located('redirected', `the ambient git environment (${LOCATION_VARIABLES}) reaches a work tree at ${at.line} while the discovery from ${cwd} names none (${st.cause})`);
  const x = identity(cwd, at.line, realpath);
  const y = identity(cwd, st.line, realpath);
  if (!x.ok) return located('error', `the work-tree top under the ambient git environment: ${x.cause}`);
  if (!y.ok) return located('error', `the work-tree top under the GIT_-stripped discovery: ${y.cause}`);
  if (x.path !== y.path) return located('redirected', `the work-tree top differs: the ambient git environment (${LOCATION_VARIABLES}) resolves it to ${x.path}, the discovery from ${cwd} to ${y.path}`);
  return located('work-tree', null, { top: at.line, gitDir: ids['git dir'], commonDir: ids['common dir'] });
};
