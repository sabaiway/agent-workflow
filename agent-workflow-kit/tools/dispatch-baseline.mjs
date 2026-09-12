// dispatch-baseline.mjs — snapshotScope, computeBasePayload, computeBaseFingerprint,
// isCleanAgainstBase, runBaseDiff and resolveTreeObject; spec:dispatch-baseline.
// Writes only its own temporary indexes and the blob objects stored by forced adds.
// Head measurements delegate unchanged to core-evidence without a temporary index.
// runBaseDiff returns null for head; callers must use their existing head diff path.

import { mkdtempSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { computeFingerprintPayload, isTreeClean, isNeverCommittableStat } from './core-evidence.mjs';
import { KIT_OWN_PATHS, KNOWN_FOOTPRINT, patternToProbe, isDirPattern, expandGlob, isGlobPattern } from './known-footprint.mjs';
import { GIT_MAX_BUFFER, resolveGitLocation, withGitPath } from './git-env.mjs';

const TEMP_PREFIX = 'aw-dispatch-baseline-';
const INDEX_NAME = 'index';
const HASH_ALGORITHM = 'sha256';
const PAYLOAD_DIFF_ARGS = ['--no-ext-diff', '--no-textconv', '--ignore-submodules=none'];
const SCOPE_EXCLUSIONS = ['/docs/plans/', '/.claude/settings.json', '/.claude/settings.local.json', '/.mcp.json'];
const MISSING_PATH_CODES = ['ENOENT', 'ENOTDIR'];
const ABSENT_HEAD_STATUS = 1;
const splitPaths = (bytes) => {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('git path names are not lossless UTF-8');
  return text.split('\0').filter(Boolean).map((path) => path.replace(/\/$/, ''));
};
const defaultRunGit = (args, cwd, input, env) => spawnSync('git', args, {
  cwd, input, env: withGitPath(env), maxBuffer: GIT_MAX_BUFFER, windowsHide: true,
});
const makeRunner = ({ runGit = defaultRunGit, env = process.env } = {}) => (args, cwd, input, override = env) => {
  try { return runGit(args, cwd, input, override); }
  catch (error) { return { error, status: null, stdout: Buffer.alloc(0) }; }
};
const readGit = (run, args, top, env) => {
  const result = run(args, top, undefined, env);
  if (result == null || result.error || result.signal || result.status !== 0 || result.stdout == null) {
    throw new Error(`git ${args.join(' ')} failed: ${result?.error?.message ?? String(result?.stderr ?? '').trim()}`);
  }
  return Buffer.from(result.stdout);
};
const locateTop = (cwd, run, env) => {
  const location = resolveGitLocation(cwd, { env, spawn: (command, args, options) => run(args, options.cwd, undefined, options.env) });
  if (location.state !== 'work-tree') throw new Error(location.cause ?? 'not inside a git work tree');
  return location.top;
};
const withTemporaryIndex = (env, action) => {
  const directory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  try {
    return action({ ...env, GIT_INDEX_FILE: join(directory, INDEX_NAME), GIT_LITERAL_PATHSPECS: '1' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
const readStat = (path, lstat) => {
  try {
    const stat = lstat(path);
    if (stat == null) throw new Error(`cannot stat ${path}`);
    return stat;
  } catch (error) {
    if (MISSING_PATH_CODES.includes(error.code)) return null;
    throw error;
  }
};
const readTreePaths = (run, top, treeOid, env) => splitPaths(readGit(run, ['ls-tree', '-r', '--name-only', '-z', treeOid], top, env));
const readHeadPaths = (run, top, env) => {
  const head = run(['rev-parse', '--verify', '--quiet', 'HEAD'], top, undefined, env);
  if (head && !head.error && !head.signal && head.status === ABSENT_HEAD_STATUS) return [];
  if (!head || head.error || head.signal || head.status !== 0) throw new Error('cannot resolve HEAD');
  return readTreePaths(run, top, 'HEAD', env);
};
const excludePatterns = (top, paths) => [
  ...SCOPE_EXCLUSIONS,
  ...KNOWN_FOOTPRINT.flatMap(({ pattern }) => isGlobPattern(pattern)
    ? expandGlob(pattern, {
      dir: top,
      readdir: (parent) => paths.filter((path) => dirname(path) === relative(top, parent).split('\\').join('/')).map((path) => basename(path)),
      stat: () => ({ isFile: () => true }),
    })
    : [pattern]),
];
const collectScope = (top, baseTreeOid, run, lstat, env) => withTemporaryIndex(env, (indexEnv) => {
  readGit(run, ['read-tree', '--empty'], top, indexEnv);
  const paths = new Set(splitPaths(readGit(run, ['ls-files', '--others', '--exclude-standard', '-z'], top, indexEnv)));
  for (const pattern of KIT_OWN_PATHS) {
    const probe = patternToProbe(pattern);
    const stat = readStat(join(top, probe), lstat);
    if (stat === null) continue;
    if (isDirPattern(pattern) && stat.isDirectory()) {
      for (const path of splitPaths(readGit(run, ['ls-files', '--others', '-z', '--', probe], top, indexEnv))) paths.add(path);
    } else paths.add(probe.replace(/\/$/, ''));
  }
  for (const path of readHeadPaths(run, top, indexEnv)) paths.add(path);
  if (baseTreeOid !== null) for (const path of readTreePaths(run, top, baseTreeOid, indexEnv)) paths.add(path);
  const exclusions = excludePatterns(top, [...paths]).map((pattern) => ({ probe: patternToProbe(pattern), directory: isDirPattern(pattern) }));
  return [...paths].filter((path) => !path.split('/').includes('node_modules')
    && !exclusions.some(({ probe, directory }) => directory ? path === probe.slice(0, -1) || path.startsWith(probe) : path === probe)).sort();
});

export const snapshotScope = (cwd, { baseTreeOid = null } = {}, io = {}) => {
  try {
    const env = io.env ?? process.env;
    const run = makeRunner(io);
    const top = locateTop(cwd, run, env);
    return { ok: true, paths: collectScope(top, baseTreeOid, run, io.lstat ?? lstatSync, env) };
  } catch (error) {
    return { ok: false, reason: `snapshot scope: ${error.message}` };
  }
};

export const resolveTreeObject = (cwd, oid, io = {}) => {
  try {
    const env = io.env ?? process.env;
    const run = makeRunner(io);
    const top = locateTop(cwd, run, env);
    const type = readGit(run, ['cat-file', '-t', oid], top, env).toString('utf8').trim();
    return type === 'tree' ? { ok: true } : { ok: false, reason: `${oid} names a ${type}, not a tree` };
  } catch (error) {
    return { ok: false, reason: `${oid} is an unresolvable tree object: ${error.message}` };
  }
};

export const runBaseDiff = (cwd, base, args, io = {}) => {
  if (base.kind !== 'checkpoint') return null;
  try {
    const env = io.env ?? process.env;
    const run = makeRunner(io);
    const top = locateTop(cwd, run, env);
    if (!resolveTreeObject(top, base.treeOid, io).ok) return null;
    const scope = snapshotScope(top, { baseTreeOid: base.treeOid }, io);
    if (!scope.ok) return null;
    const basePaths = readTreePaths(run, top, base.treeOid, env);
    const present = [];
    const removed = [];
    for (const path of scope.paths) {
      const stat = readStat(join(top, path), io.lstat ?? lstatSync);
      const baseHoldsPath = basePaths.includes(path);
      const neverCommittable = stat !== null && isNeverCommittableStat(stat);
      const materialized = stat !== null && !neverCommittable && (stat.isFile() || stat.isSymbolicLink());
      if (neverCommittable && baseHoldsPath) throw new Error(`base path ${path} is no longer committable`);
      if (materialized) present.push(path);
      if (!materialized && !neverCommittable && (stat === null || baseHoldsPath)) removed.push(path);
    }
    const excludedBasePaths = basePaths.filter((path) => !scope.paths.includes(path));
    const conflict = present.find((path) => excludedBasePaths.some((excluded) =>
      path.startsWith(`${excluded}/`) || excluded.startsWith(`${path}/`)));
    if (conflict !== undefined) throw new Error(`live path ${conflict} conflicts with an excluded base path`);
    return withTemporaryIndex(env, (indexEnv) => {
      readGit(run, ['read-tree', base.treeOid], top, indexEnv);
      if (removed.length > 0) readGit(run, ['update-index', '--remove', '--', ...removed], top, indexEnv);
      if (present.length > 0) readGit(run, ['add', '-f', '--', ...present], top, indexEnv);
      return readGit(run, ['diff', '--cached', base.treeOid, ...args], top, indexEnv);
    });
  } catch {
    return null;
  }
};

export const computeBasePayload = (cwd, base, io = {}) => base.kind === 'head'
  ? computeFingerprintPayload(cwd, io)
  : runBaseDiff(cwd, base, PAYLOAD_DIFF_ARGS, io);

export const computeBaseFingerprint = (cwd, base, io) => {
  const payload = computeBasePayload(cwd, base, io);
  return payload === null ? null : createHash(HASH_ALGORITHM).update(payload).digest('hex');
};

export const isCleanAgainstBase = (cwd, base, io) => {
  if (base.kind === 'head') return isTreeClean(cwd, io);
  const payload = computeBasePayload(cwd, base, io);
  return payload === null ? null : payload.length === 0;
};
