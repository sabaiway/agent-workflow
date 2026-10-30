#!/usr/bin/env node
// Standalone move contract: docs/ai/specs/memory/standalone-scripts/.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, lstatSync, readFileSync, realpathSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFamily } from '../references/scripts/family.mjs';
import { KIT_COMMANDS, KIT_COMMAND_PATH } from '../references/scripts/run.mjs';
import { askGit, FLAT_NAMES, retireFlat } from './flat-scripts.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SKILL_ROOT = dirname(dirname(SCRIPT_FILE));
const KIT = posix.dirname(KIT_COMMAND_PATH);
const INSTALLER = KIT_COMMANDS['install-git-hooks'];
const ROTATOR = KIT_COMMANDS['archive-decisions'];
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
// The installer's isManaged, copied (git-hooks has no index to import): a line ending with its marker tail, one carriage return dropped.
const isManaged = (hook) => hook.split('\n').some((line) => line.replace(/\r$/, '').endsWith(':install-git-hooks.mjs'));
const USAGE = 'Usage: kit-folder.mjs --project <target> [--dry-run] [--enforcement]\n';
const DEPLOYED = readFamily(join(SKILL_ROOT, 'references/scripts')).filter((entry) => entry.role === 'deployed');
export const NODE_EVIDENCE_PROBES = Object.freeze([
  'package.json',
  ...FLAT_NAMES.filter((name) => !name.endsWith('.test.mjs') && name !== '_expect-shim.mjs').map((name) => `scripts/${name}`),
  ...DEPLOYED.map((entry) => entry.path).sort().map((path) => `${KIT}/${path}`),
]);
const isAnswered = (result, status) => !result.error && !result.signal && result.status === status;
const describeError = (error) => error.code ?? error.message ?? String(error);
const describeOutcome = (result) => result.error ? describeError(result.error) : result.signal ? `signal ${result.signal}` : `exit ${result.status ?? 'unknown'}`;
const describeKind = (stat) => stat.isSymbolicLink() ? 'a link' : stat.isDirectory() ? 'a directory' : stat.isFile() ? 'a regular file' : 'not a regular file';
const failAt = (path, error) => Object.assign(new Error(`${path}: ${describeError(error)}`), { code: error.code });
const readStat = (path, deps) => {
  try { return (deps.lstat ?? lstatSync)(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw failAt(path, error); }
};
const readBody = (path, deps) => {
  try { return (deps.readFile ?? readFileSync)(path, { flag: READ_FLAGS }); }
  catch (error) { throw failAt(path, error); }
};
const foldersOf = (path) => path.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'));
const assertFolders = (cwd, folders, deps) => {
  for (const path of folders) {
    const stat = readStat(join(cwd, path), deps);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`${path}: ${describeKind(stat)}; a plain directory is required`);
  }
};

const probeEvidence = (cwd, deps) => {
  const wrong = [], folders = new Map();
  const probe = (path, directory) => {
    const stat = readStat(join(cwd, path), deps);
    if (!stat) return false;
    if (!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile())) return true;
    wrong.push(`${path} is ${describeKind(stat)}`);
    return false;
  };
  const plainFolder = (path) => {
    if (!folders.has(path)) folders.set(path, probe(path, true));
    return folders.get(path);
  };
  for (const path of NODE_EVIDENCE_PROBES) {
    if (foldersOf(path).every(plainFolder) && probe(path, false)) return null;
  }
  return `no Node evidence; skipped: ${NODE_EVIDENCE_PROBES.join(', ')}${wrong.length ? `; not evidence: ${wrong.join('; ')}` : ''}`;
};
const pendingLines = (cwd, deps) => ['decisions-archive.md', 'decisions-archive-early.md'].flatMap((name) => {
  const path = `docs/ai/history/${name}`;
  return readStat(join(cwd, path), deps) ? [`${path}: pending ADR move; no Node evidence, so the store was left as it stands`] : [];
});
const readImports = (path, body, paths) => [...String(body).matchAll(IMPORT)]
  .map(([, imported]) => posix.join(posix.dirname(path), imported)).filter((dependency) => paths.has(dependency));
const orderFiles = (files) => {
  const remaining = new Map(files.map((file) => [file.path, file])), ordered = [];
  if (remaining.has(INSTALLER)) { ordered.push(remaining.get(INSTALLER)); remaining.delete(INSTALLER); }
  while (remaining.size) {
    const next = [...remaining.keys()].sort().find((path) => remaining.get(path).imports.every((dependency) => !remaining.has(dependency)));
    if (!next) throw new Error(`bundled scripts contain an import cycle: ${[...remaining.keys()].join(', ')}`);
    ordered.push(remaining.get(next)); remaining.delete(next);
  }
  return ordered;
};
const survey = (cwd, skillRoot, enforcement, deps) => {
  const bundle = join(skillRoot, 'references/scripts');
  const entries = readFamily(bundle).filter((entry) => entry.role === 'deployed');
  const paths = new Set(entries.map((entry) => entry.path));
  assertFolders(cwd, new Set(entries.flatMap((entry) => foldersOf(`${KIT}/${entry.path}`))), deps);
  const files = entries.map((entry) => {
    const rel = `${KIT}/${entry.path}`, stat = readStat(join(cwd, rel), deps);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`${rel}: ${describeKind(stat)}; a regular file is required`);
    const body = readBody(join(bundle, entry.path), deps);
    const current = stat && Buffer.from(readBody(join(cwd, rel), deps)).equals(Buffer.from(body));
    return { ...entry, rel, body, present: Boolean(stat), current, imports: readImports(entry.path, body, paths) };
  });
  const isSpec = (file) => ['spec-schema', 'docs-size'].includes(file.module) || file.path === 'run.mjs';
  const family = files.filter((file) => !isSpec(file));
  const flatInstaller = readStat(join(cwd, 'scripts', posix.basename(INSTALLER)), deps);
  const accepted = enforcement || family.some((file) => file.present && !file.seed) || flatInstaller?.isFile() === true;
  const spec = new Set(files.filter(isSpec).map((file) => file.path));
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const path of spec) for (const dependency of byPath.get(path).imports) spec.add(dependency);
  return { accepted, files: files.filter((file) => accepted || spec.has(file.path) || file.seed) };
};

const writeFile = (cwd, file, deps) => {
  const target = join(cwd, file.rel), folders = foldersOf(file.rel);
  assertFolders(cwd, folders, deps);
  (deps.mkdir ?? mkdirSync)(dirname(target), { recursive: true });
  assertFolders(cwd, folders, deps);
  if (!file.present) {
    try { (deps.writeFile ?? writeFileSync)(target, file.body, { flag: 'wx', flush: true }); return 'written'; }
    catch (error) {
      if (error.code !== 'EEXIST') throw markPossibleWrite(target, file.rel, error, deps);
      const stat = readStat(target, deps);
      if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`${file.rel}: EEXIST; not a regular file`);
      if (!Buffer.from(readBody(target, deps)).equals(Buffer.from(file.body))) throw new Error(`${file.rel}: EEXIST; appeared without the bundled body; nothing further written`);
      return 'stood';
    }
  }
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try { (deps.writeFile ?? writeFileSync)(temporary, file.body, { flag: 'wx', flush: true }); }
  catch (error) { throw error.code === 'EEXIST' ? error : markPossibleWrite(temporary, posix.join(posix.dirname(file.rel), posix.basename(temporary)), error, deps); }
  try {
    assertFolders(cwd, folders, deps);
    const stat = readStat(target, deps);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`${file.rel}: became ${describeKind(stat)}; overwrite refused`);
    (deps.rename ?? renameSync)(temporary, target);
  } catch (error) {
    try { (deps.unlink ?? unlinkSync)(temporary); }
    catch (cleanup) {
      if (cleanup.code !== 'ENOENT') throw Object.assign(new Error(`${describeError(error)}; ${temporary}: cleanup failed (${describeError(cleanup)})`), { possiblyWritten: [posix.join(posix.dirname(file.rel), posix.basename(temporary))] });
    }
    throw error;
  }
  return 'written';
};
const markPossibleWrite = (target, rel, error, deps) => {
  try { return Object.assign(error, { possiblyWritten: readStat(target, deps) ? [rel] : [] }); }
  catch (probe) { return Object.assign(new Error(`${describeError(error)}; write outcome could not be confirmed (${probe.message})`), { possiblyWritten: [rel] }); }
};
const fileLine = (file, dryRun) => `${file.rel}: ${dryRun ? 'would be ' : ''}${file.present ? "written over; its body differed from the one this substrate bundles; a customization goes where the memory skill's contracts.md, Reserved names and channels, says" : 'placed from the bundled scripts'}`;
const writeAll = (cwd, files, dryRun, deps, lines, written) => {
  const due = orderFiles(files.filter((file) => !file.current));
  for (const file of due) {
    try {
      const fate = dryRun ? null : writeFile(cwd, file, deps);
      if (fate === 'written') written.push(file.rel);
      lines.push(fate === 'stood' ? `${file.rel}: appeared while placing it; the bundled body stands, nothing written` : fileLine(file, dryRun));
    } catch (error) {
      written.push(...(error.possiblyWritten ?? []));
      throw failAt(file.rel, error);
    }
  }
  lines.push(`${KIT}/: ${files.filter((file) => file.current).length} scripts already current`);
  return due.map((file) => file.rel);
};
const runStore = (cwd, dryRun, deps, lines, wrote) => {
  const command = `${KIT}/${ROTATOR} --ensure-current`;
  if (dryRun) { lines.push(`ADR store: ${command} would run after the writes`); return 0; }
  const result = (() => {
    try { return (deps.spawnSync ?? spawnSync)(process.execPath, [join(cwd, KIT, ROTATOR), '--ensure-current'], { cwd, encoding: 'utf8' }) ?? {}; }
    catch (error) { return { error }; }
  })();
  for (const stream of [result.stdout, result.stderr]) for (const line of String(stream ?? '').split(/\r?\n/).filter(Boolean)) lines.push(`ADR store: ${line}`);
  if (isAnswered(result, 0)) return 0;
  lines.push(`ADR store: ${command}: ${describeOutcome(result)}; store could not be confirmed current, nothing removed`);
  return !wrote && !result.signal && (result.error || result.status === 1) ? 1 : 3;
};

const hookLines = (cwd, dryRun, placed, deps) => {
  const tree = askGit(cwd, ['rev-parse', '--is-inside-work-tree'], deps);
  const hooks = askGit(cwd, ['rev-parse', '--git-path', 'hooks'], deps);
  if (isAnswered(hooks, 128) || isAnswered(tree, 128) || isAnswered(tree, 0) && String(tree.stdout ?? '').trim() === 'false') return [];
  if (!isAnswered(hooks, 0) || !String(hooks.stdout ?? '').trim()) {
    return [`the hooks dir could not be confirmed (${describeOutcome(hooks)})`];
  }
  const path = resolve(cwd, String(hooks.stdout).trim(), 'pre-commit');
  const body = (() => {
    try {
      const stat = readStat(path, deps);
      return stat?.isFile() && !stat.isSymbolicLink() ? String(readBody(path, deps)) : null;
    } catch (error) { return error; }
  })();
  if (body instanceof Error) return [`${path}: could not be read (${describeError(body)}); the hook switch was not judged`];
  if (body === null) return [];
  if (!isManaged(body) || body.split(/\r?\n/).includes(`node ${KIT_COMMAND_PATH} docs-size`)) return [];
  const required = [...new Set([INSTALLER, posix.basename(KIT_COMMAND_PATH), ...Object.values(KIT_COMMANDS)])];
  const absent = required.map((name) => `${KIT}/${name}`).find((rel) => !(dryRun && placed.includes(rel)) && readStat(join(cwd, rel), deps)?.isFile() !== true);
  return [absent ? `hook switch skipped: ${absent} is absent; run once with --enforcement` : `switch the managed hook on your yes: node ${KIT_COMMAND_PATH} install-git-hooks`];
};
const commitLines = (cwd, removed, changed, deps) => {
  if (!changed || !isAnswered(askGit(cwd, ['check-ignore', '-q', KIT], deps), 1)) return [];
  return [`commit ${KIT}/${removed.length ? `, the removed files ${removed.map((name) => `scripts/${name}`).join(', ')}` : ''} and, as this upgrade changed it, package.json as one change; merge it into every branch still committed or installed on`];
};

export const runKitFolder = ({ cwd, skillRoot = SKILL_ROOT, dryRun = false, enforcement = false, deps = {} }) => {
  const lines = [], written = [], removed = [];
  try {
    if (!enforcement) {
      const skip = probeEvidence(cwd, deps);
      if (skip) return { exitCode: 0, lines: [skip, ...pendingLines(cwd, deps), ...hookLines(cwd, dryRun, [], deps)] };
    }
    const { files, accepted } = survey(cwd, skillRoot, enforcement, deps);
    lines.push(`${KIT}/: ${accepted ? 'component accepted' : 'component not accepted; the spec layer and every seed only'}`);
    const placed = writeAll(cwd, files, dryRun, deps, lines, written);
    const storeExit = files.some((file) => file.path === ROTATOR) ? runStore(cwd, dryRun, deps, lines, written.length > 0) : 0;
    if (storeExit) return { exitCode: storeExit, lines };
    const retired = retireFlat({ cwd, skillRoot, dryRun, placed, deps });
    removed.push(...retired.removed);
    lines.push(...retired.lines);
    const placements = files.filter((file) => !file.present && (dryRun || written.includes(file.rel)));
    lines.push(...commitLines(cwd, retired.removed, placements.length > 0 || retired.removed.length > 0, deps));
    lines.push(...hookLines(cwd, dryRun, placed, deps));
    return { exitCode: 0, lines: lines.map((line) => line.replace(/[\r\n]+/g, ' ')) };
  } catch (error) {
    lines.push(String(error.message ?? error).replace(/[\r\n]+/g, ' '));
    if (written.length) lines.push(`writes stopped partway; already written: ${written.join(', ')}; nothing rolled back`);
    return { exitCode: written.length || removed.length ? 3 : 1, lines };
  }
};

export const main = (argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, deps = {} } = {}) => {
  const options = { dryRun: false, enforcement: false };
  const remaining = [...argv];
  while (remaining.length) {
    const flag = remaining.shift();
    if (flag === '--project' && remaining[0] && !remaining[0].startsWith('-') && !options.cwd) options.cwd = resolve(remaining.shift());
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--enforcement') options.enforcement = true;
    else { stderr.write(USAGE); return 2; }
  }
  if (!options.cwd) { stderr.write(USAGE); return 2; }
  const result = runKitFolder({ ...options, deps });
  for (const line of result.lines) stdout.write(`${line}\n`);
  return result.exitCode;
};
// Run main() only when executed directly, never on import; compare by REAL path so a symlinked skill home still runs.
const isDirectRun = (() => {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(SCRIPT_FILE); }
  catch { return false; }
})();
if (isDirectRun) process.exitCode = main();
