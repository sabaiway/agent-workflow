import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, readTagTemplate } from './dispatch-publish.mjs';
import { runGitProcess } from './git-process.mjs';
import { cwdBoundGitEnv } from '../suite-parity.mjs';
import { stripGitLocationEnv } from '../../agent-workflow-kit/tools/git-env.mjs';

const EXIT_CHANGE = 1;
const EXIT_FAILURE = 2;
const WORKFLOW = '.github/workflows/_publish-one.yml';
const COVERED_ROOT_PATHS = ['.gitattributes', '.gitignore', '.npmignore', 'package.json'];
const PACK_SCRIPTS = ['prepack', 'prepare', 'postpack'];
const BUNDLED_KEYS = ['bundleDependencies', 'bundledDependencies'];
const JUDGE_FLAGS = ['--root', '--dir', '--to', '--packed', '--packument', '--github-output'];
const FILENAME_FLAG = '--filename';
const FLAG_PAIR_SIZE = 2;
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

const parseJson = (text, label) => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw fail(EXIT_FAILURE, `${label}: invalid JSON (${error.message})`);
  }
};

export const readPackRecord = (text, label) => {
  const record = parseJson(text, label);
  const entries = record && typeof record === 'object' ? Object.values(record) : [];
  const [entry] = entries;
  if (entries.length !== 1 || !entry || typeof entry !== 'object' || Array.isArray(entry)
    || typeof entry.filename !== 'string' || typeof entry.integrity !== 'string') {
    throw fail(EXIT_FAILURE, `${label}: expected one pack entry with string filename and integrity`);
  }
  return { filename: entry.filename, integrity: entry.integrity };
};

const readText = async (path, reader) => {
  try {
    return await reader(path, 'utf8');
  } catch (error) {
    throw fail(EXIT_FAILURE, `${path}: cannot read (${error.message})`);
  }
};

const createGitReader = (root, runner) => async (args) => {
  try {
    const result = await runner(args, {
      cwd: root, env: { ...cwdBoundGitEnv(stripGitLocationEnv(process.env)), LC_ALL: 'C' },
    });
    if (result?.error || result?.signal || result?.killedByDeadline || result?.status !== 0
      || typeof result.stdout !== 'string') {
      throw new Error(result?.error?.message ?? result?.signal ?? result?.stderr ?? 'unreadable result');
    }
    return result.stdout;
  } catch (error) {
    throw fail(EXIT_FAILURE, `${root}: git ${args.join(' ')} failed (${error.message})`);
  }
};

const readCommit = async (git, to) => {
  const commit = (await git(['rev-parse', '--verify', '--end-of-options', `${to}^{commit}`])).replace(/\n$/, '');
  if (!COMMIT_ID.test(commit)) throw fail(EXIT_FAILURE, `git rev-parse: invalid commit for ${to}: ${commit}`);
  return commit;
};

const checkRoot = async (root, git) => {
  const top = (await git(['rev-parse', '--show-toplevel'])).replace(/\n$/, '');
  try {
    if (!top || realpathSync(resolve(root, top)) !== realpathSync(root)) {
      throw new Error('git top level does not equal root');
    }
  } catch (error) {
    throw fail(EXIT_FAILURE, `${root}: invalid repository root (${error.message})`);
  }
};

const readReleaseTag = async (root, dir, version, reader) => {
  try {
    return readTagTemplate(await readText(join(root, WORKFLOW), reader))(dir, version);
  } catch (error) {
    throw fail(EXIT_FAILURE, error.message);
  }
};

const readOriginTag = async (git, tag, to) => {
  const ref = `refs/tags/${tag}`;
  const peeled = `${ref}^{}`;
  const answer = await git(['ls-remote', 'origin', ref, peeled]);
  const refs = new Map();
  for (const line of answer.replace(/\n$/, '').split('\n').filter(Boolean)) {
    const [commit, name, extra] = line.split('\t');
    if (![ref, peeled].includes(name) || !COMMIT_ID.test(commit) || extra !== undefined || refs.has(name)) {
      throw fail(EXIT_FAILURE, `git ls-remote: invalid tag answer ${line}`);
    }
    refs.set(name, commit);
  }
  if (refs.has(peeled) && !refs.has(ref)) throw fail(EXIT_FAILURE, `git ls-remote: missing ${ref}`);
  const commit = refs.get(peeled) ?? refs.get(ref);
  return { commit, absent: !commit, current: commit === to, annotated: refs.has(peeled) };
};

const judgeFacts = ({ dir, version, fresh, published, tag, origin, changed, declared }) => {
  const equal = fresh === published;
  const elsewhere = !origin.absent && !origin.current;
  const clean = changed.length === 0 && declared.length === 0;
  const refusal = `${dir} ${version}: fresh ${fresh}, published ${published}; tag ${tag} `
    + `${origin.commit ?? 'absent'}; changed paths: ${changed.join(', ') || 'none'}; `
    + `declared keys: ${declared.join(', ') || 'none'}; bump the version and ship a new release`;
  const table = [
    [origin.annotated && origin.current, EXIT_FAILURE, `annotated tag ${tag} at ${origin.commit}`],
    [equal && elsewhere, 'yes', 'equal integrities, tag at another commit'],
    [equal && (origin.absent || origin.current), 'no', 'equal integrities, repair the absent or current tag'],
    [!equal && origin.current, 'no', 'differing integrities, repair the current lightweight tag'],
    [!equal && elsewhere && clean, 'yes', 'differing integrities, unchanged covered source and no pack declarations'],
    [!equal && elsewhere && !clean, EXIT_CHANGE, refusal],
    [!equal && origin.absent, EXIT_CHANGE, refusal],
  ];
  const [, outcome, line] = table.find(([matches]) => matches);
  if (typeof outcome === 'number') throw fail(outcome, line);
  return { noop: outcome, line };
};

export const judgeShippedChange = async ({ root, dir, to, packed, packument }, deps = {}) => {
  if (typeof dir !== 'string' || !dir || dir === '.' || dir === '..' || dir.startsWith('-') || dir.includes('/')) {
    throw fail(EXIT_FAILURE, `invalid --dir ${dir}: expected one folder segment`);
  }
  const reader = deps.readFile ?? readFileSync;
  const fresh = readPackRecord(await readText(packed, reader), packed).integrity;
  const git = createGitReader(root, deps.git ?? runGitProcess);
  await checkRoot(root, git);
  const target = await readCommit(git, to);
  const label = `${dir}/package.json at ${to}`;
  const manifest = parseJson(await git(['show', `${target}:${dir}/package.json`]), label) ?? {};
  const registry = parseJson(await readText(packument, reader), packument);
  const published = registry?.versions?.[manifest.version]?.dist?.integrity;
  if (typeof published !== 'string') {
    throw fail(EXIT_FAILURE, `${packument}: missing integrity for version ${manifest.version}`);
  }
  const tag = await readReleaseTag(root, dir, manifest.version, reader);
  const origin = await readOriginTag(git, tag, target);
  const declared = [
    ...PACK_SCRIPTS.filter((key) => Object.hasOwn(manifest.scripts ?? {}, key)),
    ...BUNDLED_KEYS.filter((key) => Object.hasOwn(manifest, key)),
  ];
  const needsDiff = fresh !== published && !origin.absent && !origin.current;
  const changed = [];
  if (needsDiff) {
    await git(['fetch', '--no-tags', 'origin', origin.commit]);
    const diff = await git(['--literal-pathspecs', 'diff', '--name-only', '--no-renames', '-z',
      origin.commit, target, '--', dir, ...COVERED_ROOT_PATHS]);
    changed.push(...diff.split('\0').filter(Boolean));
  }
  return judgeFacts({ dir, version: manifest.version, fresh, published, tag, origin, changed, declared });
};

const parseFlags = (args) => {
  const required = args.includes(FILENAME_FLAG) ? [FILENAME_FLAG] : JUDGE_FLAGS;
  const flags = new Map();
  for (const index of args.keys()) {
    if (index % FLAG_PAIR_SIZE !== 0) continue;
    const flag = args[index];
    if (!required.includes(flag)) throw fail(EXIT_FAILURE, `unexpected argument ${flag}`);
    if (flags.has(flag)) throw fail(EXIT_FAILURE, `repeated flag ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw fail(EXIT_FAILURE, `missing value for ${flag}`);
    flags.set(flag, value);
  }
  for (const flag of required) {
    if (!flags.has(flag)) throw fail(EXIT_FAILURE, `missing flag ${flag}`);
  }
  return flags;
};

const escapeCommand = (value) => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

const runCli = async () => {
  try {
    const flags = parseFlags(process.argv.slice(2));
    if (flags.has(FILENAME_FLAG)) {
      const path = flags.get(FILENAME_FLAG);
      console.log(readPackRecord(await readText(path, readFileSync), path).filename);
      return;
    }
    const options = Object.fromEntries(JUDGE_FLAGS.map((flag) => [flag.slice(2), flags.get(flag)]));
    const outcome = await judgeShippedChange(options);
    appendFileSync(options['github-output'], `noop=${outcome.noop}\n`);
    console.log(escapeCommand(outcome.line));
  } catch (error) {
    console.error(`::error::${escapeCommand(error.message)}`);
    process.exitCode = error.exitCode === EXIT_CHANGE ? EXIT_CHANGE : EXIT_FAILURE;
  }
};

const checkDirectRun = () => Boolean(process.argv[1])
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (checkDirectRun()) await runCli();
