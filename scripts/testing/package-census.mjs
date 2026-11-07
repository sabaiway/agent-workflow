import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAMILY_DIRS } from '../release/version-sync.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const CHECKOUT_ROOT = resolve(dirname(MODULE_PATH), '..', '..');
const ABSENT = 'absent';
const reportError = (message) => console.error(`package-census: ${message}`);

export const takeCensus = (root, dirs) => {
  const snapshot = Object.create(null);
  const recordPath = (path, allowAbsent = false) => {
    const key = relative(root, path).split(sep).join('/');
    const stats = lstatSync(path, { throwIfNoEntry: false });
    if (!stats) {
      if (!allowAbsent) throw new Error(`Path disappeared during census: ${path}`);
      snapshot[key] = { type: ABSENT };
      return;
    }
    const type = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : stats.isSymbolicLink() ? 'symlink' : 'other';
    snapshot[key] = { type, mode: stats.mode, mtimeMs: stats.mtimeMs,
      content: stats.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : null,
      target: stats.isSymbolicLink() ? readlinkSync(path) : null };
    if (stats.isDirectory()) for (const entry of readdirSync(path).sort()) recordPath(join(path, entry));
  };
  for (const directory of dirs) recordPath(join(root, directory), true);
  return snapshot;
};

export const compareCensus = (before, after) => {
  const beforePaths = new Set(Object.keys(before).filter((path) => before[path].type !== ABSENT));
  const afterPaths = new Set(Object.keys(after).filter((path) => after[path].type !== ABSENT));
  return {
    added: [...afterPaths].filter((path) => !beforePaths.has(path)).sort(),
    removed: [...beforePaths].filter((path) => !afterPaths.has(path)).sort(),
    changed: [...beforePaths].filter((path) => afterPaths.has(path) && JSON.stringify(before[path]) !== JSON.stringify(after[path])).sort(),
  };
};

export const main = (argv) => {
  const separator = argv.indexOf('--');
  const validOptions = separator === 0 || (separator === 2 && argv[0] === '--root' && argv[1]);
  if (!validOptions || separator === argv.length - 1) {
    reportError('usage: node scripts/testing/package-census.mjs [--root <dir>] -- <command...>');
    return 2;
  }
  const root = separator === 2 ? resolve(argv[1]) : CHECKOUT_ROOT;
  const command = argv.slice(separator + 1);
  try {
    const before = takeCensus(root, FAMILY_DIRS);
    const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
    const differences = compareCensus(before, takeCensus(root, FAMILY_DIRS));
    const changes = Object.entries(differences).flatMap(([kind, paths]) => paths.map((path) => `${kind} ${path}`));
    for (const change of changes) reportError(change);
    if (result.error) { reportError(`spawn ${result.error.code ?? result.error.message}`); return 1; }
    if (result.signal) { reportError(`signal ${result.signal}`); return 1; }
    return changes.length ? 1 : result.status;
  } catch (error) {
    reportError(error.message);
    return 1;
  }
};

if (process.argv[1] && resolve(process.argv[1]) === MODULE_PATH) process.exitCode = main(process.argv.slice(2));
