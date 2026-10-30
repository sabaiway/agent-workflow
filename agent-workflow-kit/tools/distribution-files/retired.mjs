import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, posix } from 'node:path';
import { lstatNoFollow } from '../atomic-write.mjs';
import { stripGitLocationEnv } from '../git-env.mjs';
import { DEPLOYED_SCRIPTS, KIT_SCRIPTS_DIR, SCRIPTS_DIR } from '../node-evidence.mjs';
import { PRIOR_FILES, SCRIPT_PRIORS, digestOf } from '../script-priors.mjs';

const DEPLOYED_BY_NAME = new Map(DEPLOYED_SCRIPTS.map((entry) => [posix.basename(entry.path), entry]));
const COMMAND = DEPLOYED_SCRIPTS.find((entry) => !entry.module);
const normalizeBody = (bytes) => String(bytes).replaceAll('\r\n', '\n');
const flatPath = (name) => `${SCRIPTS_DIR}/${name}`;
const isRegular = (cwd, rel, lstat) => lstatNoFollow(join(cwd, rel), lstat)?.isFile() === true;
const errorCode = (error) => error.code ?? error.message;

export const isRetiredKitScript = (name, bytes, kitRoot, read = readFileSync) => {
  const digest = digestOf(normalizeBody(bytes));
  if (SCRIPT_PRIORS.some((row) => row.file === name && row.digest === digest)) return true;
  const entry = DEPLOYED_BY_NAME.get(name);
  return Boolean(entry && digest === digestOf(normalizeBody(read(join(kitRoot, entry.bundled)))));
};

const keptLine = (name, rel, dryRun) => `${flatPath(name)}: ${dryRun ? 'would be kept' : 'kept'} — ${rel} is not placed yet`;
const removedLine = (name, dryRun) => `${flatPath(name)}: ${dryRun ? 'would be removed' : 'removed'} — the kit's scripts live in ${KIT_SCRIPTS_DIR}/`;
const foreignLine = (name) => `${flatPath(name)}: differs from every body this kit knows it shipped — not the kit's, left as it stands; the kit's checks now run from ${KIT_SCRIPTS_DIR}/`;

export const suiteLines = (cwd, classified, deps = {}) => {
  const lstat = deps.lstat ?? lstatSync;
  return (deps.readdir ?? readdirSync)(join(cwd, SCRIPTS_DIR)).filter((name) => name.endsWith('.test.mjs'))
    .filter((name) => (!PRIOR_FILES.includes(name) || classified.get(name) === 'foreign') && isRegular(cwd, flatPath(name), lstat))
    .sort().map((name) => `${flatPath(name)}: a suite of your own — the kit's hook runs no suite; add node --test ${flatPath(name)} to scripts/pre-commit.local to keep it on every commit`);
};

const askGit = (cwd, args, deps) => {
  const env = Object.fromEntries(Object.entries(stripGitLocationEnv(process.env)).filter(([key]) => key !== 'NODE_TEST_CONTEXT'));
  return (deps.git ?? spawnSync)('git', args, { cwd, env, encoding: 'utf8' }) ?? {};
};
const answered = (result, status) => !result.error && !result.signal && result.status === status;

export const grepLines = (cwd, deps = {}) => {
  const result = askGit(cwd, ['rev-parse', '--is-inside-work-tree'], deps);
  if (answered(result, 0) && String(result.stdout).trim() === 'true') return [
    `other files naming an old path: git grep -n -F --untracked ${PRIOR_FILES.map((name) => `-e ${name}`).join(' ')} -- . ':!${KIT_SCRIPTS_DIR}'`,
    'git grep lists tracked and untracked files git does not ignore; the hooks dir and ignored files are yours to check',
  ];
  if (answered(result, 128) || (answered(result, 0) && String(result.stdout).trim() === 'false')) return ['this project is outside a git work tree; check other files naming an old path by hand'];
  return [`whether this project is in a git work tree could not be confirmed (${result.error ? errorCode(result.error) : result.signal ?? result.status ?? 'no result'}); check other files naming an old path by hand`];
};

export const commitLines = (cwd, removed, deps = {}) => {
  if (!answered(askGit(cwd, ['check-ignore', '-q', KIT_SCRIPTS_DIR], deps), 1)) return [];
  return [`commit ${KIT_SCRIPTS_DIR}/${removed.length ? `, the removed files ${removed.map(flatPath).join(', ')}` : ''} and, as this upgrade changed them, docs/ai/gates.json and package.json as one change; merge it into every branch still committed or installed on`];
};

export const retireScripts = ({ cwd, kitRoot, dryRun = false, deps = {}, placedScripts = [], placements = [] }) => {
  const lstat = deps.lstat ?? lstatSync;
  const read = deps.readFile ?? readFileSync;
  const standing = (rel) => (dryRun && placedScripts.includes(rel)) || isRegular(cwd, rel, lstat);
  const commandStands = standing(COMMAND.deployed);
  const classified = new Map();
  const removed = [];
  const lines = [];
  for (const name of PRIOR_FILES) {
    const rel = flatPath(name);
    const stat = lstatNoFollow(join(cwd, rel), lstat);
    if (stat === null) continue;
    if (!stat.isFile()) {
      lines.push(`${rel}: ${stat.isSymbolicLink() ? 'a symlink' : stat.isDirectory() ? 'a directory' : 'not a regular file'} — left as it stands`);
      continue;
    }
    const owned = (() => {
      try {
        return isRetiredKitScript(name, read(join(cwd, rel)), kitRoot, read);
      } catch (error) {
        lines.push(`${rel}: could not be read (${errorCode(error)}) — left as it stands`);
        return null;
      }
    })();
    if (owned === null) continue;
    classified.set(name, owned ? 'kit' : 'foreign');
    if (!owned) { lines.push(foreignLine(name)); continue; }
    const replacement = DEPLOYED_BY_NAME.get(name);
    const missing = !commandStands ? COMMAND.deployed : replacement && !standing(replacement.deployed) ? replacement.deployed : null;
    if (missing) { lines.push(keptLine(name, missing, dryRun)); continue; }
    if (!dryRun) {
      try {
        (deps.unlink ?? unlinkSync)(join(cwd, rel));
      } catch (error) {
        if (error.code !== 'ENOENT') lines.push(`${rel}: not removed (${errorCode(error)}) — left for the next run`);
        continue;
      }
    }
    removed.push(name);
    lines.push(removedLine(name, dryRun));
  }
  if (removed.length) lines.push(...suiteLines(cwd, classified, deps), ...grepLines(cwd, deps));
  if (removed.length || placements.length) lines.push(...commitLines(cwd, removed, deps));
  return { removed, lines };
};
