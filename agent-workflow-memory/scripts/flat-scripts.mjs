// Flat retirement contract: docs/ai/specs/memory/standalone-scripts/.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, posix } from 'node:path';
import { readFamily } from '../references/scripts/family.mjs';
import { KIT_COMMAND_PATH } from '../references/scripts/run.mjs';

const KIT = posix.dirname(KIT_COMMAND_PATH);
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
export const FLAT_NAMES = Object.freeze([
  '_expect-shim.mjs', 'archive-caps.mjs', 'archive-caps.test.mjs', 'archive-changelog.mjs', 'archive-changelog.test.mjs',
  'archive-conservation.test.mjs', 'archive-decisions.mjs', 'archive-decisions.test.mjs', 'archive-issues.mjs',
  'archive-issues.test.mjs', 'archiver-structure.test.mjs', 'check-docs-size-cli.test.mjs', 'check-docs-size-ensure.test.mjs',
  'check-docs-size.mjs', 'check-docs-size.test.mjs', 'install-git-hooks-repo-exec.test.mjs', 'install-git-hooks.mjs',
  'install-git-hooks.test.mjs', 'markdown-blocks.mjs', 'markdown-blocks.test.mjs', 'migrate-gates-branches.test.mjs',
  'migrate-gates.mjs', 'migrate-gates.test.mjs', 'spec-schema.mjs', 'spec-schema.test.mjs',
]);
export const FLAT_BODIES = Object.freeze([
  ['_expect-shim.mjs', 'f6aa541f4fae226e8fd56420400649e9f0a308a2a9c69de1b9040e7745209b30'],
  ['archive-caps.mjs', '0792ad611b566ad15f2230c3bd68b534e51f184b45619bf8925dc441bed71665'],
  ['archive-caps.test.mjs', '38652af64cab83c754a00c957dda8b3032e32004f7f419182a9f35edbf3cea0d'],
  ['archive-changelog.mjs', 'ab1e1124edd5c2da37056dee5278a442008045a3d1b08acf7a5a6d617e47c41a'],
  ['archive-changelog.test.mjs', '58785635406a1ad2006ab2c18d00644a1db3efd060395d72516473a5c812d9c3'],
  ['archive-conservation.test.mjs', '9da44e089caf6b55942ae77c6a5ae4644ead8cdb013b44a1bd9d0e2c5f7a9077'],
  ['archive-decisions.mjs', '4425aa899b32ada19e5859b8b438de37edbff2d9d925571beb866ca460e9a868'],
  ['archive-decisions.test.mjs', '52a5170077acd1e7b3568a6387ff0f320efdd452396d4df6c4dd1f95ab2efdcb'],
  ['archive-issues.mjs', 'd1d1a82c158aac9a0ab4b6b89c837f0ee7aa9598ddb55fa70374aec6fcf16588'],
  ['archive-issues.test.mjs', '96eef36bd83259dfc7df6fd1858b60c4afe0fe5b324aa76cb760f0591237f045'],
  ['archiver-structure.test.mjs', '0f0e096579916ec917d393092e3ea8b66904cf78017fab550b4e839c4e578531'],
  ['check-docs-size-cli.test.mjs', '6e43e1e8141697ecbe310fa9328cd2107ad71e140f317d25cc627cd14661ad92'],
  ['check-docs-size-ensure.test.mjs', '3ba3c565a32b9371c59ea7f1ccffd9cbe40b5a3d214ee7d09ab1eafb7502add8'],
  ['check-docs-size.mjs', '22d902c277cd123327c65b2753a319532a934308ebc6188d882490e1dc43272c'],
  ['check-docs-size.test.mjs', '547290e3cbb8da1da7ded60f1ca060eaaeaf444f0e4f196103b892a1b6b93ad5'],
  ['install-git-hooks-repo-exec.test.mjs', 'a1e00887d9ebd4f5ee3c8066ba04a557cdfad1c462b1805f54da61fe51bfed9e'],
  ['install-git-hooks.mjs', '0c4d1eb6bdd6dec492c7be8f3d92751f330b53786bf0e07936b0fe7cf6118395'],
  ['install-git-hooks.test.mjs', '9d9475be5bcef99ba5b233d9d676d78203cff3be834a8525adc8b14d4210247e'],
  ['markdown-blocks.test.mjs', 'd2289da8783ce6df8260e83eb52d62f8dfc1233555b074087997e94117047ffd'],
  ['migrate-gates-branches.test.mjs', '59734b15ddf98762c6db0c048edf374f949f7b92c53ea4fd986d72b7f44e283f'],
  ['migrate-gates.mjs', 'd9c3f9da27397dd94ad866c3cbac72e529ad2e6311ffa15de7478a960800cdfa'],
  ['migrate-gates.test.mjs', '8f99a2f65f1f3db0eb3464a0382c208ca5076388b6df0596cf099d53ab2a1f86'],
  ['spec-schema.test.mjs', '6a602a93e9f9f21f0bc10c50e356de693936d3e204987efbab1a1d7674030498'],
].map(([file, digest]) => Object.freeze({ file, digest })));

export const askGit = (cwd, args, deps = {}) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key) && key !== 'NODE_TEST_CONTEXT'));
  try { return (deps.git ?? spawnSync)('git', args, { cwd, env, encoding: 'utf8' }) ?? {}; }
  catch (error) { return { error }; }
};
const isAnswered = (result, status) => !result.error && !result.signal && result.status === status;
const describeError = (error) => error.code ?? error.message;
const digestOf = (body) => createHash('sha256').update(String(body).replaceAll('\r\n', '\n')).digest('hex');
const readStat = (path, deps) => {
  try { return (deps.lstat ?? lstatSync)(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const isRegular = (cwd, path, deps) => readStat(join(cwd, path), deps)?.isFile() === true;
const readBody = (path, deps) => (deps.readFile ?? readFileSync)(path, { flag: READ_FLAGS });
const grepLines = (cwd, deps) => {
  const result = askGit(cwd, ['rev-parse', '--is-inside-work-tree'], deps);
  if (isAnswered(result, 0) && String(result.stdout ?? '').trim() === 'true') return [
    `other files naming an old path: git grep -n -F --untracked ${FLAT_NAMES.map((name) => `-e ${name}`).join(' ')} -- . ':!${KIT}'`,
    'git grep lists tracked and untracked files git does not ignore; the hooks dir and ignored files are yours to check',
  ];
  if (isAnswered(result, 128) || isAnswered(result, 0) && String(result.stdout ?? '').trim() === 'false') return ['this project is outside a git work tree; check other files naming an old path by hand'];
  return [`the git work tree could not be confirmed (${result.error ? describeError(result.error) : result.signal ?? result.status ?? 'no result'}); check other files naming an old path by hand`];
};
const suiteLines = (cwd, classified, removed, deps) => (deps.readdir ?? readdirSync)(join(cwd, 'scripts'))
  .filter((name) => name.endsWith('.test.mjs') && !removed.includes(name))
  .filter((name) => (!FLAT_NAMES.includes(name) || classified.get(name) === 'foreign') && isRegular(cwd, `scripts/${name}`, deps))
  .sort().map((name) => `scripts/${name}: a suite of your own; add node --test scripts/${name} to scripts/pre-commit.local to keep it on every commit`);

export const retireFlat = ({ cwd, skillRoot, dryRun = false, placed = [], deps = {} }) => {
  const removed = [], lines = [], classified = new Map();
  const standing = (path) => dryRun && placed.includes(path) || isRegular(cwd, path, deps);
  if (!standing(KIT_COMMAND_PATH)) return { removed, lines };
  const bundle = join(skillRoot, 'references/scripts');
  const byName = new Map(readFamily(bundle).filter((entry) => entry.role === 'deployed').map((entry) => [posix.basename(entry.path), entry.path]));
  for (const name of FLAT_NAMES) {
    const path = `scripts/${name}`, target = join(cwd, path);
    try {
      const stat = readStat(target, deps);
      if (!stat) continue;
      if (!stat.isFile()) {
        lines.push(`${path}: ${stat.isSymbolicLink() ? 'a link' : stat.isDirectory() ? 'a directory' : 'not a regular file'}; left as it stands`);
        continue;
      }
      const digest = digestOf(readBody(target, deps)), replacement = byName.get(name);
      const owned = FLAT_BODIES.some((row) => row.file === name && row.digest === digest)
        || replacement && digest === digestOf(readBody(join(bundle, replacement), deps));
      classified.set(name, owned ? 'kit' : 'foreign');
      if (!owned) { lines.push(`${path}: not the kit's; left as it stands`); continue; }
      if (replacement && !standing(`${KIT}/${replacement}`)) {
        lines.push(`${path}: ${dryRun ? 'would be kept' : 'kept'}; ${KIT}/${replacement} is not placed yet`);
        continue;
      }
      if (!dryRun) {
        try { (deps.unlink ?? unlinkSync)(target); }
        catch (error) {
          if (error.code !== 'ENOENT') lines.push(`${path}: not removed (${describeError(error)}); left for the next run`);
          continue;
        }
      }
      removed.push(name);
      lines.push(`${path}: ${dryRun ? 'would be removed' : 'removed'}; the kit's scripts live in ${KIT}/`);
    } catch (error) { lines.push(`${path}: could not be read or confirmed (${describeError(error)}); left as it stands`); }
  }
  if (removed.length) {
    try { lines.push(...suiteLines(cwd, classified, removed, deps)); }
    catch (error) { lines.push(`scripts/: remaining suites could not be listed (${describeError(error)})`); }
    lines.push(...grepLines(cwd, deps));
  }
  return { removed, lines: lines.map((line) => line.replace(/[\r\n]+/g, ' ')) };
};
