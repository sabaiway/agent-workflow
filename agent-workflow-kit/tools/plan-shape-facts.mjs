import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';
import { classIds, readShippedRobustnessLiterals } from './robustness-literals.mjs';
import { segmentPrefixOf, validateSourceSizeConfig } from './source-size-config.mjs';
import { getLineCount, isSweep, resolveAnchorCandidates, unique } from './plan-shape.mjs';

const SOURCE_SIZE_REL = 'docs/ai/source-size.json';
const PACKAGE_FILE = 'package.json';
const PIN_FILE = 'package-content.test.mjs';
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);
const NEGATED_CLASS = /\[[!^]/;
const UNSUPPORTED_GLOB = /[()\\\u0000-\u001f]/;

const usageError = (message, scope = 'repository') => Object.assign(new Error(message), { exitCode: 2, scope });
const planError = (message) => usageError(message, 'plan');
const toPosix = (path) => path.split(sep).join('/');
const isInside = (root, path) => path === root || path.startsWith(`${root}${sep}`);
const isLexicallySafe = (path) => typeof path === 'string' && path.length > 0 && !isAbsolute(path) &&
  !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..');

const getLstat = (path, fail = usageError) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw fail(`cannot inspect ${path} (${error.message})`);
  }
};

const walkRegularFiles = (root, directory = root) => readdirSync(directory, { withFileTypes: true })
  .sort((left, right) => left.name.localeCompare(right.name))
  .flatMap((entry) => {
    const path = join(directory, entry.name);
    const rel = toPosix(relative(root, path));
    if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) return walkRegularFiles(root, path);
    return entry.isFile() ? [rel] : [];
  });

const getRealpath = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const resolveAbsentLeaf = (root, path) => {
  const rootReal = realpathSync(root);
  const lexical = resolve(root, path);
  if (!isInside(resolve(root), lexical)) return { contained: false, resolved: lexical };
  const findExisting = (candidate, missing) => {
    const real = getLstat(candidate, planError) ? getRealpath(candidate) : null;
    if (real) return join(real, ...missing);
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    return findExisting(parent, [basename(candidate), ...missing]);
  };
  const resolved = findExisting(lexical, []);
  return { contained: isInside(rootReal, resolved), resolved };
};

const readJsonNoFollow = (path, label) => {
  const result = readRegularFileNoFollow(path);
  if (result.outcome === 'absent') return null;
  if (result.outcome !== 'ok') throw usageError(`${label} must be a readable regular file (${result.className ?? result.code ?? result.outcome})`);
  try {
    const parsed = JSON.parse(result.content);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the root is not an object');
    return parsed;
  } catch (error) {
    throw usageError(`${label} is not valid JSON (${error.message})`);
  }
};

const loadPractice = (root) => {
  const parsed = readJsonNoFollow(join(root, SOURCE_SIZE_REL), SOURCE_SIZE_REL);
  if (parsed === null) return { capDeclared: false, cap: null, config: null };
  try {
    const config = validateSourceSizeConfig(parsed);
    return { capDeclared: true, cap: config.defaults.maxLines, config };
  } catch (error) {
    throw usageError(`${SOURCE_SIZE_REL} is malformed (${error.message})`);
  }
};

const loadRobustClasses = (deps) => {
  try {
    return classIds(readShippedRobustnessLiterals(deps));
  } catch (error) {
    throw usageError(`robustness-literals list is unreadable (${error.message})`);
  }
};

const isInScope = (path, config) => Boolean(config &&
  config.roots.some((root) => segmentPrefixOf(root, path)) &&
  !config.exclude.some((excluded) => segmentPrefixOf(excluded, path)) &&
  config.extensions.some((extension) => path.endsWith(extension)));

const expandBraces = (pattern) => {
  const match = /\{([^{}]+)\}/.exec(pattern);
  if (!match) return [pattern];
  return match[1].split(',').flatMap((part) => expandBraces(`${pattern.slice(0, match.index)}${part}${pattern.slice(match.index + match[0].length)}`));
};

const compileGlob = (pattern) => {
  if (UNSUPPORTED_GLOB.test(pattern) || NEGATED_CLASS.test(pattern) || /\{[^}]*$|^[^{]*\}/.test(pattern)) return null;
  try {
    const alternatives = expandBraces(pattern).map((entry) => entry
      .replace(/[.+^$|]/g, '\\$&')
      .replace(/\*\*\//g, '\u0002')
      .replace(/\*\*/g, '\u0001')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\u0002/g, '(?:.*/)?')
      .replace(/\u0001/g, '.*'));
    return new RegExp(`^(?:${alternatives.join('|')})$`);
  } catch {
    return null;
  }
};

const matchFilesEntry = (entry, ownedPath) => {
  const normalized = entry.replace(/^\.\//, '').replace(/\/$/, '');
  if (normalized === '' || normalized === '.') return { known: true, matches: true };
  if (!isSweep(normalized)) return { known: true, matches: ownedPath === normalized || ownedPath.startsWith(`${normalized}/`) };
  const compiled = compileGlob(normalized);
  return compiled ? { known: true, matches: compiled.test(ownedPath) } : { known: false, matches: false };
};

const getShipped = (packageJson, ownedPath) => {
  if (packageJson.private === true) return false;
  if (!Object.hasOwn(packageJson, 'files')) return true;
  if (!Array.isArray(packageJson.files) || packageJson.files.some((entry) => typeof entry !== 'string')) return 'unknown';
  return packageJson.files.reduce((state, rawEntry) => {
    const excluded = rawEntry.startsWith('!');
    const entry = excluded ? rawEntry.slice(1) : rawEntry;
    const result = matchFilesEntry(entry, ownedPath);
    if (!result.known) return 'unknown';
    return result.matches ? !excluded : state;
  }, false);
};

const findPackage = (root, path, cache) => {
  const start = resolve(root, dirname(path));
  const visit = (directory) => {
    if (!isInside(resolve(root), directory)) return null;
    const packagePath = join(directory, PACKAGE_FILE);
    if (getLstat(packagePath)) {
      const relRoot = toPosix(relative(root, directory)) || '.';
      if (!cache.has(relRoot)) cache.set(relRoot, readJsonNoFollow(packagePath, toPosix(relative(root, packagePath))));
      return { root: relRoot, json: cache.get(relRoot) };
    }
    return directory === resolve(root) ? null : visit(dirname(directory));
  };
  return visit(start);
};

const getPin = (root, owner, repoFiles, cache) => {
  const prefix = owner.root === '.' ? '' : `${owner.root}/`;
  const pins = repoFiles.filter((path) => path.startsWith(prefix) && basename(path) === PIN_FILE &&
    findPackage(root, path, cache)?.root === owner.root);
  if (pins.length > 1) throw usageError(`package ${owner.root} has several ${PIN_FILE} files: ${pins.join(', ')}`);
  return pins[0] ?? null;
};

const describePinSkip = (owner, shipped, pinTest) => {
  if (owner === null) return 'package ownership is unknown';
  if (owner.json.private === true) return `private package ${owner.root}`;
  if (shipped === 'unknown') return `shipping state is unknown for package ${owner.root}`;
  return shipped === true && pinTest === null ? `no ${PIN_FILE} under package ${owner.root}` : null;
};

const describePath = (root, path, practice, repoFiles, packageCache) => {
  const safe = isLexicallySafe(path);
  const containment = safe ? resolveAbsentLeaf(root, path) : { contained: false, resolved: resolve(root, path) };
  const stat = safe ? getLstat(resolve(root, path), planError) : null;
  const read = stat?.isFile() ? readRegularFileNoFollow(resolve(root, path)) : null;
  if (read && read.outcome !== 'ok') throw planError(`${path} cannot be read without following it (${read.className ?? read.code ?? read.outcome})`);
  const kind = stat === null ? 'absent' : stat.isFile() ? 'regular' : 'other';
  const owner = safe && containment.contained && !isSweep(path) ? findPackage(root, path, packageCache) : null;
  const ownedPath = owner ? toPosix(relative(owner.root === '.' ? root : join(root, owner.root), resolve(root, path))) : null;
  const shipped = owner ? getShipped(owner.json, ownedPath) : 'unknown';
  const pinTest = owner && shipped === true ? getPin(root, owner, repoFiles, packageCache) : null;
  return {
    kind,
    lines: read?.outcome === 'ok' ? getLineCount(read.content) : 0,
    recordedLines: practice.config?.baseline?.[path]?.lines ?? null,
    inScope: isInScope(path, practice.config),
    shipped,
    pinTest,
    pinSkip: describePinSkip(owner, shipped, pinTest),
    contained: containment.contained,
  };
};

export const openRepo = (root, { robustnessDeps } = {}) => {
  const repoRoot = realpathSync(root);
  return { repoRoot, repoFiles: walkRegularFiles(repoRoot), practice: loadPractice(repoRoot), robustClasses: loadRobustClasses(robustnessDeps), packageCache: new Map() };
};

export const buildFacts = (root, { paths = [], robustnessDeps, repo = openRepo(root, { robustnessDeps }) } = {}) => {
  const { repoRoot, repoFiles, practice, robustClasses, packageCache } = repo;
  const expansions = Object.fromEntries(paths.filter(isSweep).map((pattern) => {
    const compiled = compileGlob(pattern);
    if (!compiled) throw planError(`unsupported glob in plan path: ${pattern}`);
    return [pattern, repoFiles.filter((path) => compiled.test(path))];
  }));
  const allPaths = unique([...paths, ...Object.values(expansions).flat()]);
  const pathFacts = Object.fromEntries(allPaths.map((path) => [path, describePath(repoRoot, path, practice, repoFiles, packageCache)]));
  const candidates = (suffix, precedingPaths = []) => resolveAnchorCandidates(repoFiles, suffix, precedingPaths);
  return { capDeclared: practice.capDeclared, cap: practice.cap, robustClasses, pathFacts, expansions, repoFiles, candidates };
};
