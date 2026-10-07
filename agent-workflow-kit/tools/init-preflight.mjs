import { closeSync, constants, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';

export const AGENT_SESSION_MARKERS = Object.freeze([
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'SANDBOX_RUNTIME',
]);

const OWNER_WRITE_BIT = 0o200;
const PROBE_FLAGS = constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const WRITE_REFUSAL_CODES = new Set(['EROFS', 'EPERM', 'EACCES']);

const throwPathError = (path, error) => {
  throw Object.assign(new Error(`${path}: ${error?.code ?? ''} ${error?.message ?? String(error)}`, {
    cause: error,
  }), { code: error?.code });
};

const readStat = (path, io) => {
  try {
    return io.lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throwPathError(path, error);
  }
};

const openProbe = (path, io) => {
  try {
    return { descriptor: io.openSync(path, PROBE_FLAGS), cause: null };
  } catch (error) {
    if (WRITE_REFUSAL_CODES.has(error?.code)) {
      return { cause: `${path}: a write-open answered ${error.code}` };
    }
    throwPathError(path, error);
  }
};

const probePath = (path, io) => {
  const stat = readStat(path, io);
  if (stat === null) return null;
  if (stat.isCharacterDevice() || stat.isBlockDevice()) {
    return `${path}: a device-node mask`;
  }
  const canProbe = stat.isFile()
    && (stat.mode & OWNER_WRITE_BIT) !== 0
    && typeof io.geteuid === 'function'
    && stat.uid === io.geteuid();
  if (!canProbe) return null;
  const opened = openProbe(path, io);
  if (opened.cause !== null) return opened.cause;
  try {
    return null;
  } finally {
    try {
      io.closeSync(opened.descriptor);
    } catch (error) {
      throwPathError(path, error);
    }
  }
};

export const preflightInit = ({ root = null, home, env = process.env, io = {} }) => {
  for (const marker of AGENT_SESSION_MARKERS) {
    if (typeof env[marker] === 'string' && env[marker].length > 0) {
      return { ok: false, cause: `marker ${marker} is set` };
    }
  }
  const probes = {
    lstat: lstatSync,
    openSync,
    closeSync,
    geteuid: process.geteuid,
    ...io,
  };
  const paths = [join(home, '.claude/settings.json')];
  if (root !== null) {
    paths.push(
      join(root, '.claude/settings.json'),
      join(root, '.claude/settings.local.json'),
      join(root, '.mcp.json'),
      join(root, '.git/config'),
    );
  }
  for (const path of paths) {
    const cause = probePath(path, probes);
    if (cause !== null) return { ok: false, cause };
  }
  return { ok: true, cause: null };
};
