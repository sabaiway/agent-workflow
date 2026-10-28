import { lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { assertContainedRealPath } from './fs-safe.mjs';
import { lstatNoFollowRead } from './fs-read-nofollow.mjs';

const PREFIX = '[agent-workflow-kit]';
const NON_CONVERGENCE = `${PREFIX} the kit home did not converge to the package (see the lines above) `
  + '— fix them, then re-run npx @sabaiway/agent-workflow-kit@latest init';

export const readHomeOwner = (home) => {
  try {
    const stat = lstatSync(home, { throwIfNoEntry: false });
    if (stat === undefined) {
      return 'absent';
    }
    if (!stat.isDirectory()) {
      return 'other';
    }
    if (readdirSync(home).length === 0) {
      return 'empty';
    }
    const skill = resolve(home, 'SKILL.md');
    if (!lstatSync(skill).isFile()) {
      return 'other';
    }
    const lines = readFileSync(skill, 'utf8').split('\n').map((line) => line.replace(/\r$/, ''));
    if (lines[0] !== '---') {
      return 'other';
    }
    const end = lines.findIndex((line, index) => index > 0 && line === '---');
    if (end < 0) {
      return 'other';
    }
    return lines.slice(1, end).some((line) => line.trimEnd() === 'name: agent-workflow-kit') ? 'kit' : 'other';
  } catch {
    return 'other';
  }
};

export const assertInstallableHome = (home) => {
  const owner = readHomeOwner(home);
  if (owner === 'other') {
    throw new Error(
      `${PREFIX} refusing to install into ${home}: it is not empty and holds no agent-workflow-kit SKILL.md; `
      + 'choose a new or empty folder, or an existing kit home',
    );
  }
  return owner;
};

const describeKind = (stat) => {
  if (stat.isSymbolicLink()) {
    return 'symlink';
  }
  if (stat.isDirectory()) {
    return 'directory';
  }
  return stat.isFile() ? 'file' : 'non-regular object';
};

const reportFailure = (path, error) => ({
  ok: false,
  line: `${PREFIX} failed ${path}: ${error.message}`,
});

const finishReport = (reports) => {
  const ok = reports.every((report) => report.ok);
  return {
    ok,
    lines: reports.map((report) => report.line),
    nonConvergence: ok ? null : NON_CONVERGENCE,
  };
};

const readTree = (root, entry, reports, directoryOnly = false) => {
  const entries = new Map();
  const visitEntry = (path, first = false) => {
    try {
      const absolute = resolve(root, path);
      const stat = lstatSync(absolute, { throwIfNoEntry: !first });
      if (!stat || (first && directoryOnly && !stat.isDirectory())) {
        return;
      }
      const kind = describeKind(stat);
      entries.set(path, kind);
      if (kind === 'directory') {
        for (const name of readdirSync(absolute).sort()) {
          visitEntry(`${path}/${name}`);
        }
      }
    } catch (error) {
      reports.push(reportFailure(path, error));
    }
  };
  try {
    const stat = lstatSync(root, { throwIfNoEntry: false });
    if (!stat) {
      return entries;
    }
    if (!stat.isDirectory()) {
      throw new Error(`the root is a ${describeKind(stat)}, not a real directory`);
    }
    visitEntry(entry, true);
  } catch (error) {
    reports.push(reportFailure(entry, error));
  }
  return entries;
};

const planSubtree = (carried, installed, orphans, directories, reports) => {
  for (const [path, kind] of installed) {
    if (carried.has(path)) {
      const packageKind = carried.get(path);
      if (kind !== packageKind) {
        reports.push({
          ok: false,
          line: `${PREFIX} kind-mismatch ${path}: the home holds a ${kind}, the package a ${packageKind}`,
        });
      }
    } else if (kind === 'file') {
      orphans.push(path);
    } else if (kind === 'directory') {
      directories.push(path);
    } else {
      reports.push({
        ok: true,
        line: `${PREFIX} kept ${path} (a ${kind} the package does not carry — yours to remove by hand)`,
      });
    }
  }
};

const removeOrphan = (home, path, remove) => {
  const absolute = resolve(home, path);
  try {
    remove.assertContainedRealPath(home, absolute);
    const stat = remove.lstatNoFollowRead(absolute);
    if (stat === null) {
      return [];
    }
    if (!stat.isFile()) {
      throw new Error('the leaf is no longer a regular file');
    }
    remove.unlinkSync(absolute);
    return [{ ok: true, line: `${PREFIX} removed ${path} (not in the package)` }];
  } catch (error) {
    return [reportFailure(path, error)];
  }
};

const removeEmptyDirectory = (home, path, remove) => {
  const absolute = resolve(home, path);
  try {
    remove.assertContainedRealPath(home, absolute);
    const stat = remove.lstatNoFollowRead(absolute);
    if (stat === null) {
      return { state: 'absent' };
    }
    if (!stat.isDirectory()) {
      throw new Error('the path is no longer a real directory');
    }
    remove.rmdirSync(absolute);
    return { state: 'removed' };
  } catch (error) {
    const settled = { ENOTEMPTY: 'kept', EEXIST: 'kept', ENOENT: 'absent' }[error.code];
    return settled ? { state: settled } : { state: 'failed', report: reportFailure(path, error) };
  }
};

// The walk lists a directory before its children: reversed, a child is removed before its parent.
const removeEmptyDirectories = (home, directories, remove) => {
  const outcomes = new Map([...directories].reverse().map((path) => [path, removeEmptyDirectory(home, path, remove)]));
  const isTop = (path) => !directories.some((other) => path.startsWith(`${other}/`));
  return directories.flatMap((path) => {
    const { state, report } = outcomes.get(path);
    if (state === 'failed') {
      return [report];
    }
    if (!isTop(path) || state === 'absent') {
      return [];
    }
    return [{
      ok: true,
      line: state === 'removed'
        ? `${PREFIX} removed ${path} (not in the package)`
        : `${PREFIX} kept ${path} (a directory the package does not carry that still holds an entry)`,
    }];
  });
};

export const prunePayload = ({ packageRoot, home, payload }, deps = {}) => {
  const reports = [];
  const orphans = [];
  const directories = [];
  for (const entry of new Set(payload)) {
    const path = entry.split(sep).join('/');
    const carried = readTree(packageRoot, path, reports, true);
    if (![...carried.values()].includes('file')) {
      continue;
    }
    const installed = readTree(home, path, reports);
    planSubtree(carried, installed, orphans, directories, reports);
  }
  if (reports.some((report) => !report.ok)) {
    return finishReport(reports);
  }
  const remove = {
    assertContainedRealPath: deps.assertContainedRealPath ?? assertContainedRealPath,
    lstatNoFollowRead: deps.lstatNoFollowRead ?? lstatNoFollowRead,
    unlinkSync: deps.unlinkSync ?? unlinkSync,
    rmdirSync: deps.rmdirSync ?? rmdirSync,
  };
  for (const path of orphans) {
    reports.push(...removeOrphan(home, path, remove));
  }
  reports.push(...removeEmptyDirectories(home, directories, remove));
  return finishReport(reports);
};
