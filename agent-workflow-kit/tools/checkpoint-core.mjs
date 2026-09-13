// spec:checkpoint — docs/ai/specs/kit/checkpoint/index.md
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { snapshotScope } from './dispatch-baseline.mjs';
import { isNeverCommittableStat } from './core-evidence.mjs';
import { isThreadTerminalRecord } from './dispatch-record.mjs';
import { GIT_MAX_BUFFER, resolveGitLocation, withGitPath } from './git-env.mjs';

export const CHECKPOINT_REF_PREFIX = 'refs/agent-workflow/checkpoints/';
const ACCEPT = 0;
const REFUSE = 1;
const INCREMENT = 1;
const EMPTY = '';
const SPACE = ' ';
const NEWLINE = '\n';
const UTF8 = 'utf8';
const TEMP_PREFIX = 'aw-checkpoint-';
const INDEX_NAME = 'index';
const LITERAL_PATHSPECS = '1';
const WORK_TREE = 'work-tree';
const MISSING_PATH_CODES = ['ENOENT', 'ENOTDIR'];
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const NAMES = { scope: 'scope', sequence: 'sequence' };
const DISPATCH_KIND = 'dispatch';
const CHECKPOINT_KIND = 'checkpoint';
const LOCATION_ERROR = 'checkpoint requires a git work tree';
const SEQUENCE_ERROR = 'expected contiguous numbered refs on trees';
const STAT_ERROR = 'cannot classify path';
const TYPE_ERROR = 'present path is not a regular file, symlink or directory';
const OID_ERROR = 'git did not return a tree oid';
const GIT = 'git';
const GIT_ARGS = {
  refs: ['for-each-ref', '--format=%(refname) %(objectname)'],
  empty: ['read-tree', '--empty'],
  add: ['add', '-f', '--'],
  tree: ['write-tree'],
};

export const refuse = (reason, code = REFUSE) => ({ ok: false, code, reason });
const defaultRunGit = (args, cwd, input, env) => spawnSync(GIT, args, {
  cwd, input, env: withGitPath(env), maxBuffer: GIT_MAX_BUFFER, windowsHide: true,
});
export const makeRunner = ({ runGit = defaultRunGit, env = process.env } = {}) => (args, cwd, input, override = env) => {
  try { return runGit(args, cwd, input, override); }
  catch (error) { return { error, status: null, stdout: Buffer.alloc(ACCEPT) }; }
};
export const readGitBytes = ({ run, top, env }, args, override = env) => {
  const result = run(args, top, undefined, override);
  if (result == null || result.error || result.signal || result.status !== ACCEPT || result.stdout == null) {
    throw new Error(`${GIT} ${args.join(SPACE)} failed: ${result?.error?.message ?? String(result?.stderr ?? EMPTY).trim()}`);
  }
  return Buffer.from(result.stdout);
};
export const readGit = (context, args, override = context.env) => readGitBytes(context, args, override).toString(UTF8).trimEnd();
export const withRepository = (cwd, io, action) => {
  try {
    const env = io.env ?? process.env;
    const run = makeRunner({ ...io, env });
    const location = resolveGitLocation(cwd, { env,
      spawn: (command, args, options) => run(args, options.cwd, undefined, options.env) });
    if (location.state !== WORK_TREE) return refuse(location.cause ?? LOCATION_ERROR);
    return action({ cwd, top: location.top, env, run, io: { ...io, env, runGit: run } });
  } catch (error) {
    return refuse(error.message);
  }
};
export const readCheckpointRefs = (context, prefix = CHECKPOINT_REF_PREFIX) => {
  const lines = readGit(context, [...GIT_ARGS.refs, prefix]).split(NEWLINE).filter(Boolean);
  return lines.map((line) => {
    const [ref, oid, extra] = line.split(SPACE);
    if (!ref.startsWith(prefix) || !OID_PATTERN.test(oid) || extra !== undefined) {
      throw new Error(`${NAMES.sequence}: ${SEQUENCE_ERROR}`);
    }
    return { ref, oid };
  });
};
export const withTemporaryIndex = (env, action) => {
  const directory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  try {
    return action({ ...env, GIT_INDEX_FILE: join(directory, INDEX_NAME), GIT_LITERAL_PATHSPECS: LITERAL_PATHSPECS });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
export const readScopeStat = (context, path) => {
  try {
    const stat = (context.io.lstat ?? lstatSync)(join(context.top, path));
    if (stat == null) throw new Error(STAT_ERROR);
    return stat;
  } catch (error) {
    if (MISSING_PATH_CODES.includes(error.code)) return null;
    throw new Error(`${NAMES.scope}: ${path}: ${error.message}`);
  }
};
export const writeSnapshot = (context, baseTreeOid) => {
  const scope = snapshotScope(context.top, { baseTreeOid }, context.io);
  if (!scope.ok) return refuse(scope.reason);
  const paths = scope.paths.filter((path) => {
    const stat = readScopeStat(context, path);
    if (stat === null) return false;
    if (isNeverCommittableStat(stat) || !(stat.isFile() || stat.isSymbolicLink() || stat.isDirectory())) {
      throw new Error(`${NAMES.scope}: ${path}: ${TYPE_ERROR}`);
    }
    return stat.isFile() || stat.isSymbolicLink();
  });
  return withTemporaryIndex(context.env, (env) => {
    readGit(context, GIT_ARGS.empty, env);
    for (const path of paths) readGit(context, [...GIT_ARGS.add, path], env);
    const oid = readGit(context, GIT_ARGS.tree, env);
    if (!OID_PATTERN.test(oid)) return refuse(`${NAMES.scope}: ${OID_ERROR}`);
    return { ok: true, oid };
  });
};
export const findOpenCheckpointThread = (records, held) => records.find((record, index) =>
  record.kind === DISPATCH_KIND && record.baseline?.kind === CHECKPOINT_KIND && held.has(record.baseline.treeOid)
  && !records.slice(index + INCREMENT).some((successor) => successor.nonce === record.nonce && isThreadTerminalRecord(successor)));
