import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVICE_FACTS_FILE = 'service-facts.txt';
const SERVICES_DIRECTORY = fileURLToPath(new URL('.', import.meta.url));
const FRAGMENT_EXTENSION = '.json';
const FRAGMENT_KEYS = ['hosts', 'writableDirs', 'excludedCommands', 'passedVariables', 'runReachesHosts'];
const NETWORK_HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const VARIABLE_RE = /^[A-Z][A-Z0-9_]*$/;
const EXCLUDED_COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._-]* \*$/;
const GLOB_RE = /[*?[\]]/;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const FACTS_HEADER = "# generated from the kit's service fragments (agent-workflow-kit/tools/services/); do not edit";
const FACT_GROUPS = [
  ['HOST', 'hosts'], ['RUN_HOST', 'runHosts'], ['WRITABLE_DIR', 'dirEntries'],
  ['EXCLUDED_COMMAND', 'excludedCommands'], ['PASSED_VARIABLE', 'passedVariables'],
];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasTraversal = (path) => path.split(/[\\/]/).includes('..');
const isVariable = (value) => typeof value === 'string' && VARIABLE_RE.test(value);
const isDirectoryEntry = (entry) => {
  if (!isObject(entry) || !(entry.env === null || isVariable(entry.env))) return false;
  const directory = entry.default;
  return typeof directory === 'string'
    && (directory.startsWith('~/') || directory.startsWith('/'))
    && !GLOB_RE.test(directory) && !CONTROL_CHAR_RE.test(directory)
    && !directory.endsWith('/') && !hasTraversal(directory);
};

const refuseSchema = (path, key, reason) => {
  throw new Error(`${path}: ${key} ${reason}`);
};

const validateList = (value, path, key, accepts, identify = (entry) => entry) => {
  if (!Array.isArray(value)) refuseSchema(path, key, 'must be an array');
  const seen = new Set();
  for (const entry of value) {
    if (!accepts(entry)) refuseSchema(path, key, `has an invalid entry ${JSON.stringify(entry)}`);
    const identity = identify(entry);
    if (seen.has(identity)) refuseSchema(path, key, `has a duplicate entry ${JSON.stringify(identity)}`);
    seen.add(identity);
  }
};

const validateFragment = (fragment, path) => {
  if (!isObject(fragment)) refuseSchema(path, 'root', 'must be an object');
  for (const key of Object.keys(fragment)) {
    if (!FRAGMENT_KEYS.includes(key)) refuseSchema(path, key, 'is unknown');
  }
  for (const key of FRAGMENT_KEYS) {
    if (!Object.hasOwn(fragment, key)) refuseSchema(path, key, 'is required');
  }
  validateList(fragment.hosts, path, 'hosts',
    (host) => typeof host === 'string' && NETWORK_HOST_RE.test(host));
  validateList(fragment.writableDirs, path, 'writableDirs', isDirectoryEntry, (entry) => entry.default);
  validateList(fragment.excludedCommands, path, 'excludedCommands',
    (command) => typeof command === 'string' && EXCLUDED_COMMAND_RE.test(command));
  validateList(fragment.passedVariables, path, 'passedVariables',
    (value) => isVariable(value) && value !== 'OPENAI_BASE_URL');
  if (typeof fragment.runReachesHosts !== 'boolean') refuseSchema(path, 'runReachesHosts', 'must be a boolean');
  if (fragment.runReachesHosts && fragment.hosts.some((host) => host.startsWith('*.'))) {
    refuseSchema(path, 'hosts', 'must not contain a wildcard when runReachesHosts is true');
  }
  return fragment;
};

const readFragment = (path, readFile) => {
  const fragment = (() => {
    try {
      return JSON.parse(readFile(path, 'utf8'));
    } catch (error) {
      throw new Error(`${path}: cannot read or parse service fragment: ${error.message}`, { cause: error });
    }
  })();
  return validateFragment(fragment, path);
};

export const loadServiceFragments = (deps = {}) => {
  const servicesDir = deps.servicesDir ?? SERVICES_DIRECTORY;
  const readdir = deps.readdir ?? readdirSync;
  const readFile = deps.readFile ?? readFileSync;
  const entries = (() => {
    try {
      return readdir(servicesDir);
    } catch (error) {
      throw new Error(`${servicesDir}: cannot read services directory: ${error.message}`, { cause: error });
    }
  })();
  return Object.fromEntries(entries.filter((name) => name.endsWith(FRAGMENT_EXTENSION)).sort().map((name) => [
    name.slice(0, -FRAGMENT_EXTENSION.length), readFragment(join(servicesDir, name), readFile),
  ]));
};

const takeUnique = (entries, identify = (entry) => entry) => {
  const seen = new Set();
  return entries.filter((entry) => {
    const identity = identify(entry);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
};

export const mergeServices = (ids, fragments) => {
  const selected = ids.map((id) => {
    if (!Object.hasOwn(fragments, id)) throw new Error(`Unknown service id: ${id}`);
    return fragments[id];
  });
  return {
    hosts: takeUnique(selected.flatMap((fragment) => fragment.hosts)),
    dirEntries: takeUnique(selected.flatMap((fragment) => fragment.writableDirs),
      (entry) => JSON.stringify([entry.env, entry.default]))
      .map((entry) => ({ env: entry.env, default: entry.default })),
    excludedCommands: takeUnique(selected.flatMap((fragment) => fragment.excludedCommands)),
    passedVariables: takeUnique(selected.flatMap((fragment) => fragment.passedVariables)),
    runHosts: takeUnique(selected.filter((fragment) => fragment.runReachesHosts).flatMap((fragment) => fragment.hosts)),
  };
};

export const renderServiceFacts = (merged) => [
  FACTS_HEADER,
  ...FACT_GROUPS.flatMap(([key, field]) => merged[field].map((entry) =>
    `${key}=${field === 'dirEntries' ? `${entry.env ?? ''}:${entry.default}` : entry}`)),
  '',
].join('\n');
