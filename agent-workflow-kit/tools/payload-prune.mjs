// The payload prune both installers take. This file is the canon: the second package ships a
// byte-identical copy that scripts/sync-mirrors.mjs writes, so an edit lands here and the sync carries
// it. What differs between the installers arrives as parameters — the owner record
// { name, prefix, noun, rerun } and the guards { assertContainedRealPath, lstatNoFollow }.
import { lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { resolve, sep } from 'node:path';

// The re-run command of the non-convergence line: the bare command over the installer's default home,
// else the command with the home as a POSIX single-quoted --dir.
export const rerunCommand = (command, home, fromDefault) =>
  (fromDefault ? command : `${command} --dir '${home.replaceAll("'", "'\\''")}'`);

export const readHomeOwner = (home, owner) => {
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
    return lines.slice(1, end).some((line) => line.trimEnd() === `name: ${owner.name}`) ? 'owned' : 'other';
  } catch {
    return 'other';
  }
};

export const assertInstallableHome = (home, owner) => {
  const answer = readHomeOwner(home, owner);
  if (answer === 'other') {
    throw new Error(
      `${owner.prefix} refusing to install into ${home}: it is not empty and holds no ${owner.name} SKILL.md; `
      + `choose a new or empty folder, or an existing ${owner.noun}`,
    );
  }
  return answer;
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

const reportFailure = (say, path, error) => ({ ok: false, line: say(`failed ${path}: ${error.message}`) });

const finishReport = (owner, reports) => {
  const ok = reports.every((report) => report.ok);
  return {
    ok,
    lines: reports.map((report) => report.line),
    nonConvergence: ok ? null : `${owner.prefix} the ${owner.noun} did not converge to the package `
      + `(see the lines above) — fix them, then re-run ${owner.rerun}`,
  };
};

const readTree = (say, root, entry, reports, directoryOnly = false) => {
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
      reports.push(reportFailure(say, path, error));
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
    reports.push(reportFailure(say, entry, error));
  }
  return entries;
};

const planSubtree = (say, carried, installed, plan) => {
  for (const [path, kind] of installed) {
    if (carried.has(path)) {
      const packageKind = carried.get(path);
      if (kind !== packageKind) {
        plan.reports.push({
          ok: false,
          line: say(`kind-mismatch ${path}: the home holds a ${kind}, the package a ${packageKind}`),
        });
      }
    } else if (kind === 'file') {
      plan.orphans.push(path);
    } else if (kind === 'directory') {
      plan.directories.push(path);
    } else {
      plan.reports.push({
        ok: true,
        line: say(`kept ${path} (a ${kind} the package does not carry — yours to remove by hand)`),
      });
    }
  }
};

const removeOrphan = (say, home, path, remove) => {
  const absolute = resolve(home, path);
  try {
    remove.assertContainedRealPath(home, absolute);
    const stat = remove.lstatNoFollow(absolute);
    if (stat === null) {
      return [];
    }
    if (!stat.isFile()) {
      throw new Error('the leaf is no longer a regular file');
    }
    remove.unlinkSync(absolute);
    return [{ ok: true, line: say(`removed ${path} (not in the package)`) }];
  } catch (error) {
    return [reportFailure(say, path, error)];
  }
};

const removeEmptyDirectory = (say, home, path, remove) => {
  const absolute = resolve(home, path);
  try {
    remove.assertContainedRealPath(home, absolute);
    const stat = remove.lstatNoFollow(absolute);
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
    return settled ? { state: settled } : { state: 'failed', report: reportFailure(say, path, error) };
  }
};

// The walk lists a directory before its children: reversed, a child is removed before its parent.
const removeEmptyDirectories = (say, home, directories, remove) => {
  const outcomes = new Map([...directories].reverse().map((path) => [path, removeEmptyDirectory(say, home, path, remove)]));
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
        ? say(`removed ${path} (not in the package)`)
        : say(`kept ${path} (a directory the package does not carry that still holds an entry)`),
    }];
  });
};

export const prunePayload = ({ packageRoot, home, payload, owner }, guards) => {
  const say = (text) => `${owner.prefix} ${text}`;
  const plan = { reports: [], orphans: [], directories: [] };
  for (const entry of new Set(payload)) {
    const path = entry.split(sep).join('/');
    const carried = readTree(say, packageRoot, path, plan.reports, true);
    if (![...carried.values()].includes('file')) {
      continue;
    }
    planSubtree(say, carried, readTree(say, home, path, plan.reports), plan);
  }
  const { reports } = plan;
  if (reports.some((report) => !report.ok)) {
    return finishReport(owner, reports);
  }
  const remove = { ...guards, unlinkSync: guards.unlinkSync ?? unlinkSync, rmdirSync: guards.rmdirSync ?? rmdirSync };
  for (const path of plan.orphans) {
    reports.push(...removeOrphan(say, home, path, remove));
  }
  reports.push(...removeEmptyDirectories(say, home, plan.directories, remove));
  return finishReport(owner, reports);
};
