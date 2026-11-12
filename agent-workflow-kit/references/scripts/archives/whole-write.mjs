// The whole-file write (spec rotation-conservation).

import { writeFileSync, renameSync, rmSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

// The fs seams: every file the rotator writes goes through deps.writeFileSync, every rename through
// deps.renameSync, every removal through deps.rmSync, every sync through deps.fsyncSync. onChange fires once a
// project file has changed.
export const fsIo = (deps = {}, onChange = () => {}) => {
  const rename = deps.renameSync ?? renameSync;
  const remove = deps.rmSync ?? rmSync;
  return {
    write: deps.writeFileSync ?? writeFileSync,
    fsync: deps.fsyncSync ?? fsyncSync,
    remove,
    rename: (from, to) => {
      rename(from, to);
      onChange();
    },
    removeFile: (path) => {
      remove(path);
      onChange();
    },
  };
};

const fsyncPath = (io, path, flags = 'r') => {
  const fd = openSync(path, flags);
  try {
    io.fsync(fd);
  } finally {
    closeSync(fd);
  }
};
const DIRECTORY_FSYNC_UNSUPPORTED = ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EISDIR'];

// An interruption leaves the target whole — its old bytes or its new ones: the temporary file, named per run
// so no earlier run's leftover meets the exclusive create, is created exclusively, synced, then renamed over
// the target. A failed write removes it, never a name another writer holds; its name never ends in .md, so no
// reader of the store takes a leftover for a document.
export const writeWhole = (io, path, content) => {
  const temp = `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    io.write(temp, content, { encoding: 'utf8', flag: 'wx' });
    fsyncPath(io, temp, 'r+'); // Windows flushes a file only through a handle open for writing
    io.rename(temp, path);
  } catch (err) {
    if (err?.code !== 'EEXIST') {
      try {
        io.remove(temp, { force: true });
      } catch (cleanupErr) {
        err.message += ` (its temporary file ${temp} was left: ${cleanupErr.message})`;
      }
    }
    throw err;
  }
  try {
    fsyncPath(io, dirname(path));
  } catch (err) {
    if (!DIRECTORY_FSYNC_UNSUPPORTED.includes(err?.code)) throw err; // the rename is complete either way
  }
};
