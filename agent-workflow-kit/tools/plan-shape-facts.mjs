import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { readSpecDocument, SPEC_SCHEMA } from '../references/scripts/spec-schema/index.mjs';
import { lstatNoFollowRead, readRegularFileNoFollow } from './fs-read-nofollow.mjs';
import { classIds, readShippedRobustnessLiterals } from './robustness-literals.mjs';
import { KIT_FOLDER_ROOT, segmentPrefixOf, validateSourceSizeConfig } from './source-size-config.mjs';
import { checkPlanStructure, getLineCount, isSweep, parseLedger, PLAN_TITLE_PREFIX, resolveAnchorCandidates, unique } from './plan-shape.mjs';
import { plansInFlight, PLANS_REL } from './plan-files.mjs';
import { listStories } from './claim-relation.mjs';
import { EPICS_REL, readEpicStore } from './epic-store.mjs';
import { sweepSiblings } from './epic-shape-ledger.mjs';
import { PIN_FILE } from './plan-shape-ownership.mjs';
import { NEVER_WALKED } from './repo-lex.mjs';
export { isSweep };

const SOURCE_SIZE_REL = 'docs/ai/source-size.json';
const PACKAGE_FILE = 'package.json';
const NEGATED_CLASS = /\[[!^]/;
const UNSUPPORTED_GLOB = /[()\\\u0000-\u001f]/;
const STORE_REFUSED = 'refused';
const FINDING_SEPARATOR = '; ';
const { storePrefix } = SPEC_SCHEMA;

const usageError = (message, scope = 'repository') => Object.assign(new Error(message), { exitCode: 2, scope });
const planError = (message) => usageError(message, 'plan');
const toPosix = (path) => path.split(sep).join('/');
const isInside = (root, path) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
const isLexicallySafe = (path) => typeof path === 'string' && path.length > 0 && !isAbsolute(path) &&
  !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..');

const remember = (cache, key, read) => {
  if (!cache.has(key)) {
    try {
      cache.set(key, { value: read() });
    } catch (error) {
      cache.set(key, { error });
    }
  }
  const result = cache.get(key);
  if (Object.hasOwn(result, 'error')) throw result.error;
  return result.value;
};

const readOnce = (repo, read, key, ...args) => {
  if (!repo.reads.has(read)) repo.reads.set(read, new Map());
  return remember(repo.reads.get(read), key, () => read(key, ...args));
};

const inspectPath = (repo, path, fail = usageError, read = lstatSync) => {
  try {
    return readOnce(repo, read, path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw fail(`cannot inspect ${path} (${error.message})`);
  }
};

const readEntries = (path) => readdirSync(path, { withFileTypes: true });
const walkRegularFiles = (directory, repo, root) => readRepositoryPath(directory, 'list', (path) => readOnce(repo, readEntries, path))
  .toSorted((left, right) => left.name.localeCompare(right.name))
  .flatMap((entry) => {
    const path = join(directory, entry.name);
    const rel = toPosix(relative(root, path));
    if (entry.isDirectory() && !NEVER_WALKED.includes(entry.name)) return walkRegularFiles(path, repo, root);
    return entry.isFile() ? [rel] : [];
  });

const getRepoRoot = (repo, allowAbsent) => readRepositoryPath(repo.root, 'resolve', (path) => readOnce(repo, realpathSync, path), allowAbsent);
const resolveAbsentLeaf = (repo, path) => {
  const root = getRepoRoot(repo);
  const lexical = resolve(root, path);
  if (!isInside(root, lexical)) return false;
  const findExisting = (candidate, missing) => {
    const real = inspectPath(repo, candidate, planError) ? inspectPath(repo, candidate, planError, realpathSync) : null;
    if (real) return join(real, ...missing);
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    return findExisting(parent, [basename(candidate), ...missing]);
  };
  return isInside(root, findExisting(lexical, []));
};

const probeListedPath = (repo, segments) => {
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || NEVER_WALKED.includes(segment))) return null;
  const root = getRepoRoot(repo);
  if (!segments.slice(0, -1).every((_, index) => inspectPath(repo, join(root, ...segments.slice(0, index + 1)))?.isDirectory())) return null;
  return inspectPath(repo, join(root, ...segments));
};

const listFiles = (repo, start = []) => {
  if (start.length && !probeListedPath(repo, start)?.isDirectory()) return [];
  const root = getRepoRoot(repo);
  return readOnce(repo, walkRegularFiles, join(root, ...start), repo, root);
};

const readJsonNoFollow = (repo, path, label) => {
  const result = readOnce(repo, readRegularFileNoFollow, path);
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

const loadPractice = (root, repo) => {
  const parsed = readJsonNoFollow(repo, join(root, SOURCE_SIZE_REL), SOURCE_SIZE_REL);
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
  !segmentPrefixOf(KIT_FOLDER_ROOT, path) &&
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

const sweepStart = (pattern) => {
  const segments = pattern.split('/');
  return segments.slice(0, segments.findIndex(isSweep));
};

const getExpansions = (patterns, list, addPath = () => {}) => {
  const cache = new Map();
  const descriptors = unique(patterns).map((pattern) => {
    const compiled = compileGlob(pattern);
    if (!compiled) throw planError(`unsupported glob in plan path: ${pattern}`);
    return [pattern, { enumerable: true, get: () => remember(cache, pattern, () => {
      const paths = list(pattern).filter((path) => compiled.test(path));
      paths.forEach(addPath);
      return paths;
    }) }];
  });
  return Object.defineProperties({}, Object.fromEntries(descriptors));
};

export const expandPatterns = (repoFiles, patterns) => ({ ...getExpansions(patterns, () => repoFiles) });

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

const findPackage = (path, repo) => {
  const root = getRepoRoot(repo);
  const start = resolve(root, dirname(path));
  const visit = (directory) => {
    if (!isInside(root, directory)) return null;
    const packagePath = join(directory, PACKAGE_FILE);
    if (inspectPath(repo, packagePath)) {
      const relRoot = toPosix(relative(root, directory)) || '.';
      const json = remember(repo.packageCache, relRoot, () => readJsonNoFollow(repo, packagePath, toPosix(relative(root, packagePath))));
      return { root: relRoot, json };
    }
    return directory === root ? null : visit(dirname(directory));
  };
  return visit(start);
};

const getPin = (repo, owner) => {
  const pins = listFiles(repo, owner.root === '.' ? [] : owner.root.split('/')).filter((path) =>
    basename(path) === PIN_FILE && readOnce(repo, findPackage, path, repo)?.root === owner.root);
  if (pins.length > 1) throw usageError(`package ${owner.root} has several ${PIN_FILE} files: ${pins.join(', ')}`);
  return pins[0] ?? null;
};

const describePinSkip = (owner, shipped, pinTest) => {
  if (owner === null) return 'package ownership is unknown';
  if (owner.json.private === true) return `private package ${owner.root}`;
  if (shipped === 'unknown') return `shipping state is unknown for package ${owner.root}`;
  return shipped === true && pinTest === null ? `no ${PIN_FILE} under package ${owner.root}` : null;
};

const describeContract = (path, text) => {
  const { kind, status, structure, errors } = readSpecDocument(text, path.slice(storePrefix.length));
  const resolveTargets = (entries = []) => entries.map(({ target }) => posix.join(posix.dirname(path), target));
  return { kind, status, children: resolveTargets(structure?.children), parts: resolveTargets(structure?.parts), refused: errors.length > 0 };
};

const getPathFacts = (repo, path, practice, withContract) => {
  const safe = isLexicallySafe(path);
  const absolute = () => resolve(getRepoRoot(repo), path);
  const stat = () => safe ? inspectPath(repo, absolute(), planError) : null;
  const read = () => {
    if (!stat()?.isFile()) return null;
    const result = readOnce(repo, readRegularFileNoFollow, absolute());
    if (result.outcome !== 'ok') throw planError(`${path} cannot be read without following it (${result.className ?? result.code ?? result.outcome})`);
    return result;
  };
  const owner = () => !isSweep(path) && facts.contained ? readOnce(repo, findPackage, path, repo) : null;
  const facts = {
    get kind() { return read() ? 'regular' : stat() ? 'other' : 'absent'; },
    get lines() { return getLineCount(read()?.content ?? ''); },
    get recordedLines() { return practice().config?.baseline?.[path]?.lines ?? null; },
    get inScope() { return isInScope(path, practice().config); },
    get shipped() {
      const pkg = owner();
      return pkg ? getShipped(pkg.json, toPosix(relative(join(getRepoRoot(repo), pkg.root), absolute()))) : 'unknown';
    },
    get pinTest() { return facts.shipped === true ? getPin(repo, owner()) : null; },
    get pinSkip() { return describePinSkip(owner(), facts.shipped, facts.pinTest); },
    get contained() { return safe && resolveAbsentLeaf(repo, path); },
    get contract() {
      const document = path.startsWith(storePrefix) && path.endsWith('.md') ? read() : null;
      return document ? describeContract(path, document.content) : undefined;
    },
  };
  if (!withContract) delete facts.contract;
  return facts;
};

const readStoryFacts = (root, repo) => {
  const store = readEpicStore(root, (path) => readOnce(repo, readRegularFileNoFollow, path));
  if (store.outcome === STORE_REFUSED) return { stories: [], landedEpics: [], storeRefusal: `${EPICS_REL}: ${store.reason}` };
  const sweep = sweepSiblings(store.entries, EPICS_REL);
  return {
    stories: sweep.ok ? listStories(sweep.epics) : [],
    landedEpics: sweep.ok ? sweep.landedEpics : [],
    storeRefusal: sweep.ok ? null : sweep.findings.map((finding) => finding.message).join(FINDING_SEPARATOR),
  };
};

export const openRepo = (root, { robustnessDeps } = {}) => ({ root: resolve(root), robustnessDeps, reads: new Map(), packageCache: new Map() });

export const expandSweepPaths = (root, patterns) => {
  const repo = openRepo(root);
  return { ...getExpansions(patterns, (pattern) => listFiles(repo, sweepStart(pattern))) };
};

const readRepositoryPath = (path, action, read, allowAbsent = false) => {
  try {
    return read(path);
  } catch (error) {
    if (allowAbsent && error?.code === 'ENOENT') return null;
    const cause = ['EACCES', 'EPERM'].includes(error?.code) ? error.code : error?.message ?? String(error);
    throw usageError(`cannot ${action} ${error?.path ?? path} (${cause})`);
  }
};

const readFlightPlan = (repo, root, name) => {
  const identity = `${PLANS_REL}/${name}`;
  const { outcome, className, code, content: text } = readOnce(repo, readRegularFileNoFollow, join(root, identity));
  const cause = className ?? code ?? (outcome === 'absent' ? 'ENOENT' : outcome);
  if (outcome !== 'ok') throw usageError(`${identity} must be a readable regular plan file (${cause})`);
  try {
    const { document: { headings: [first] }, rows } = parseLedger(text);
    if (first?.level !== 1 || !first.text.startsWith(PLAN_TITLE_PREFIX)) return null;
    return { identity, text, rows: rows.filter((row) => row.valid) };
  } catch {
    return { identity, text, rows: [] };
  }
};

// A facts failure scoped to the plan's own paths is that plan's listed finding, so the other plans
// are still judged; a repository-level refusal (the practice, a package, its pins) keeps its usage class.
export const judgePlan = (root, { identity, text, rows }, { rules = checkPlanStructure, ...options } = {}) => {
  const paths = [...rows.map((row) => row.path), ...rows.map((row) => row.anchorPath).filter(Boolean)];
  try {
    const result = rules(text, getFacts(root, { paths, ...options }));
    return { identity, text, rows, result, accepted: result.findings.length === 0 };
  } catch (error) {
    if (error?.scope !== 'plan') throw error;
    return { identity, text, rows, accepted: false, result: { findings: [{ line: 1, code: 'facts', message: error.message, rowId: null }], skips: [] } };
  }
};

const readFlight = (root, repo) => {
  if (root === null) return { plans: [] };
  for (const directory of [dirname(PLANS_REL), PLANS_REL]) {
    const status = readRepositoryPath(join(root, directory), 'inspect', (path) => lstatNoFollowRead(path, (target) => readOnce(repo, lstatSync, target)));
    if (status === null) return { plans: [] };
    if (!status.isDirectory()) throw usageError(`${directory} could not be read (${status.isSymbolicLink() ? 'symlink' : 'ENOTDIR'})`);
  }
  const entries = readRepositoryPath(join(root, PLANS_REL), 'list', (path) => readOnce(repo, readEntries, path));
  const names = plansInFlight(root, () => entries);
  const documents = names.map((name) => readFlightPlan(repo, root, name)).filter(Boolean);
  return { plans: documents.map((document) => judgePlan(root, document, { repo })), skipped: names.length - documents.length, repo };
};

export const readPlansInFlight = (root, { robustnessDeps, repo = openRepo(root, { robustnessDeps }) } = {}) =>
  readOnce(repo, readFlight, getRepoRoot(repo, true), repo);

const getFacts = (root, { paths = [], robustnessDeps, repo = openRepo(root, { robustnessDeps }), plan } = {}) => {
  const practice = () => readOnce(repo, loadPractice, getRepoRoot(repo), repo);
  const storyFacts = () => readOnce(repo, readStoryFacts, getRepoRoot(repo), repo);
  const pathFacts = Object.create(null);
  const addPath = (path) => {
    pathFacts[path] ??= getPathFacts(repo, path, practice, plan !== undefined);
  };
  const expansions = getExpansions(paths.filter(isSweep), (pattern) => listFiles(repo, sweepStart(pattern)), addPath);
  paths.forEach(addPath);
  const candidates = (suffix, precedingPaths = []) => {
    if (isLexicallySafe(suffix) && probeListedPath(repo, suffix.split('/'))?.isFile()) return [suffix];
    const above = resolveAnchorCandidates([], suffix, precedingPaths);
    return above.length ? above : resolveAnchorCandidates([], suffix, listFiles(repo));
  };
  const facts = {
    get capDeclared() { return practice().capDeclared; },
    get cap() { return practice().cap; },
    get robustClasses() { return readOnce(repo, loadRobustClasses, repo.robustnessDeps); },
    get pathFacts() { return pathFacts; },
    get expansions() { return expansions; },
    get repoFiles() { return listFiles(repo); },
    get candidates() { return candidates; },
    get stories() { return storyFacts().stories; },
    get landedEpics() { return storyFacts().landedEpics; },
    get storeRefusal() { return storyFacts().storeRefusal; },
    get otherPlanCreates() {
      return readPlansInFlight(root, { repo }).plans.filter(({ identity, accepted }) => accepted && identity !== plan)
        .flatMap(({ rows }) => rows.filter(({ verb, path }) => verb === 'create' && path.startsWith(storePrefix)).map(({ path }) => path));
    },
  };
  if (plan === undefined) delete facts.otherPlanCreates;
  return facts;
};

export const buildFacts = (root, { paths = [], robustnessDeps, repo, plan } = {}) => {
  const facts = { ...getFacts(root, { paths, robustnessDeps, repo, plan }) };
  facts.expansions = { ...facts.expansions };
  facts.pathFacts = Object.fromEntries(Object.entries(facts.pathFacts).map(([path, getters]) => {
    const fact = { ...getters };
    if (fact.contract === undefined) delete fact.contract;
    return [path, fact];
  }));
  return facts;
};
