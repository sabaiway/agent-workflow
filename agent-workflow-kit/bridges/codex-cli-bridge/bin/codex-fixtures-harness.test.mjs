import { after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOS_NAME = '.test-repos';
const MAINTENANCE_OFF = 'maintenance.auto=false';
const REMOVE_OPTIONS = { recursive: true, force: true };
const stripGitEnv = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => !/^[Gg][Ii][Tt]_/.test(key)));
const isInside = (parent, path) => {
  const suffix = relative(parent, path);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
};
const runGit = (args, cwd, env) => spawnSync('git', args, { cwd, env: stripGitEnv(env), encoding: 'utf8' });

export const makeFixtureRepo = (run, dir, initArgs = []) => {
  run(['init', ...initArgs, dir]);
  run(['-C', dir, 'config', 'maintenance.auto', 'false']);
  return dir;
};

export const cloneFixtureRepo = (run, source, dir, cloneArgs = []) => {
  run(['clone', '-c', MAINTENANCE_OFF, ...cloneArgs, source, dir]);
  return dir;
};

export const resolveTestReposRoot = ({ here = HERE, env = process.env } = {}) => {
  const result = runGit(['rev-parse', '--show-toplevel'], here, env);
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`git rev-parse at ${here}: signal ${result.signal}`);
  if (result.status !== 0) return null;
  const top = realpathSync(result.stdout.replace(/\n$/, ''));
  return { top, root: join(top, REPOS_NAME) };
};

export const judgeTestReposRoot = async ({ here = HERE, env = process.env, tmp = tmpdir() } = {}) => {
  const location = resolveTestReposRoot({ here, env });
  if (!location) return { ok: false, fact: `No git work tree at ${here}` };
  const { top, root } = location;
  const realHere = realpathSync(here);
  const allowed = [join(top, 'codex-cli-bridge', 'bin'), join(top, 'agent-workflow-kit', 'bridges', 'codex-cli-bridge', 'bin')];
  if (!allowed.includes(realHere)) return { ok: false, fact: `Unexpected harness folder ${here}` };
  const versionModule = join(top, 'scripts', 'release', 'version-sync.mjs');
  for (const required of [versionModule, join(top, 'scripts', 'sync-mirrors.mjs')]) {
    if (!existsSync(required)) return { ok: false, fact: `Missing checkout file ${required}` };
  }
  const { FAMILY_DIRS } = await import(pathToFileURL(versionModule).href);
  const realRoot = lstatSync(root, { throwIfNoEntry: false }) ? realpathSync(root) : root;
  for (const directory of FAMILY_DIRS) {
    const familyPath = join(top, directory);
    const familyRoot = existsSync(familyPath) ? realpathSync(familyPath) : familyPath;
    if (isInside(familyRoot, realRoot)) return { ok: false, fact: `Fixture root lies inside family directory ${familyRoot}` };
  }
  const ignored = runGit(['check-ignore', '-q', `${root}${sep}`], top, env);
  if (ignored.error) return { ok: false, fact: `Cannot check ignore for ${root}: ${ignored.error.code ?? ignored.error.message}` };
  if (ignored.signal) return { ok: false, fact: `Cannot check ignore for ${root}: signal ${ignored.signal}` };
  if (ignored.status !== 0) return { ok: false, fact: `Fixture root ${root} is not confirmed ignored: status ${ignored.status}` };
  const realTmp = realpathSync(tmp);
  if (isInside(top, realTmp)) return { ok: false, fact: `Temporary directory ${realTmp} lies inside checkout` };
  return { ok: true, top, root, underSlashTmp: isInside(realpathSync('/tmp'), realRoot) };
};

export const openSuiteScopes = async (name, options = {}) => {
  const judgment = await judgeTestReposRoot(options);
  if (!judgment.ok) throw new Error(judgment.fact);
  mkdirSync(judgment.root, { recursive: true });
  const repos = mkdtempSync(join(judgment.root, `${name}-`));
  const tmp = mkdtempSync(join(realpathSync(options.tmp ?? tmpdir()), `${name}-`));
  after(() => {
    try { rmSync(repos, REMOVE_OPTIONS); }
    finally { rmSync(tmp, REMOVE_OPTIONS); }
  });
  return { repos, tmp, profileSkip: judgment.underSlashTmp ? 'Checkout lies under /tmp, where the exec wrapper takes its fallback' : false };
};
