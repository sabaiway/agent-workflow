import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { walkFiles } from '../sync-mirrors.mjs';
import { cwdBoundGitEnv } from '../suite-parity.mjs';
import { GIT_MAX_BUFFER, stripGitLocationEnv } from '../../agent-workflow-kit/tools/git-env.mjs';

const KIT_PACKAGE = 'agent-workflow-kit/package.json';
const MIRROR_ROOT = 'agent-workflow-kit/bridges';
const MANIFEST = 'capability.json';
const SEMVER = /^\d+\.\d+\.\d+$/;
const LINE_BREAKS = /[\r\n]+/g;
const NEXT_VERSION = '<next version>';

const runGit = (args, options) => spawnSync('git', args, options);
const readVersion = (text, label) => {
  const { version } = JSON.parse(text);
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    throw new Error(`${label}: unreadable version in history or manifest`);
  }
  return version;
};

const createGitReader = (root, runner) => (args, input) => {
  const result = runner(args, {
    cwd: root, env: { ...cwdBoundGitEnv(stripGitLocationEnv(process.env)), LC_ALL: 'C' },
    encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, input,
  });
  if (result?.error?.code === 'ENOENT') throw new Error('git is unavailable on PATH');
  if (result?.error || result?.signal || result?.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed reading repository version history (${result?.error?.code ?? result?.signal ?? result?.status ?? 'no result'})`);
  }
  if (typeof result.stdout !== 'string') throw new Error('git returned unreadable repository history');
  return result.stdout;
};

const readTree = (git, revision, path) => new Map(
  git(['ls-tree', '-r', '-z', revision, '--', path]).split('\0').filter(Boolean).map((record) => {
    const tab = record.indexOf('\t');
    const [, type, object] = record.slice(0, tab).split(' ');
    if (tab < 0 || type !== 'blob' || !object) throw new Error(`git returned unreadable history tree for ${path}`);
    return [record.slice(tab + 1), object];
  }),
);

const findBaseline = (root, git, version) => {
  const shallowPath = resolve(root, git(['rev-parse', '--git-path', 'shallow']).replace(/\n$/, ''));
  const shallow = new Set(existsSync(shallowPath) ? readFileSync(shallowPath, 'utf8').trim().split('\n') : []);
  const versions = new Map();
  const readCommitVersion = (revision) => {
    if (!versions.has(revision)) {
      const object = readTree(git, revision, KIT_PACKAGE).get(KIT_PACKAGE);
      versions.set(revision, object ? readVersion(git(['cat-file', 'blob', object]), KIT_PACKAGE) : null);
    }
    return versions.get(revision);
  };
  const commits = git(['log', '--topo-order', '--format=%H %P', 'HEAD']).trim().split('\n').filter(Boolean);
  for (const line of commits) {
    const [revision, parent] = line.trim().split(' ');
    if (readCommitVersion(revision) !== version) continue;
    if (shallow.has(revision)) throw new Error(`shallow history ends before the baseline for kit version ${version}`);
    if (!parent || readCommitVersion(parent) !== version) return revision;
  }
  throw new Error(`no commit sets kit version ${version} in available history${shallow.size ? ' (shallow)' : ''}`);
};

const checkBridge = (root, directory, baseline, git) => {
  const prefix = `${MIRROR_ROOT}/${directory}/`;
  const mirror = readTree(git, baseline, prefix);
  if (mirror.size === 0) return [];
  const manifestObject = mirror.get(`${prefix}${MANIFEST}`);
  if (!manifestObject) throw new Error(`${directory}: baseline ${baseline} has no ${MANIFEST} version`);
  const baselineVersion = readVersion(git(['cat-file', 'blob', manifestObject]), `${directory} baseline ${baseline}`);
  const canonRoot = join(root, directory);
  const currentVersion = readVersion(readFileSync(join(canonRoot, MANIFEST), 'utf8'), directory);
  const files = walkFiles(canonRoot);
  const changed = files.length !== mirror.size || files.some((file) => {
    const object = mirror.get(`${prefix}${file.split(sep).join('/')}`);
    return !object || git(['hash-object', '--stdin'], readFileSync(join(canonRoot, file))).trim() !== object;
  });
  return changed && currentVersion === baselineVersion
    ? [`${directory}: files differ from baseline ${baseline} at version ${currentVersion}; run --bump ${directory}=${NEXT_VERSION}`]
    : [];
};

export const checkBridgeBaselines = (root, dirs, deps = {}) => {
  try {
    const present = dirs.filter((directory) => existsSync(join(root, directory)));
    if (present.length === 0) return [];
    const git = createGitReader(root, deps.git ?? runGit);
    const top = git(['rev-parse', '--show-toplevel']).replace(/\n$/, '');
    if (!top || realpathSync(resolve(root, top)) !== realpathSync(root)) {
      throw new Error(`${root}: repository belongs to an enclosing root`);
    }
    const version = readVersion(git(['show', `HEAD:${KIT_PACKAGE}`]), `HEAD:${KIT_PACKAGE}`);
    const baseline = findBaseline(root, git, version);
    return present.flatMap((directory) => checkBridge(root, directory, baseline, git));
  } catch (error) {
    return [`release baseline: ${String(error?.message ?? error).replace(LINE_BREAKS, ' ')}`];
  }
};
