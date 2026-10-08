// bridge-wiring.mjs — the leaf that judges the project sandbox's coverage of ready bridges.
// Contract: bridges/velocity-profile, part bridge-wiring. Dependency-free, Node >= 22.
// No side effects on import.

import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bundledSandboxRecipe, usedBridges } from './bridge-sandbox-recipe.mjs';
import { missingStateDirs, stateDirsOf } from './bridge-state-dirs.mjs';
import { loadConfig } from './orchestration-config.mjs';
import { BACKEND_PRIORITY } from './carriers.mjs';
import { READY } from './detect-backends.mjs';

export const HOST_HONORS_QUALIFIER = 'where the host honors the settings sandbox keys';
export const WIRED = 'wired';
export const UNWIRED = 'not wired';
export const UNCHECKED = 'unchecked';
export const WIRING_ROUTE = 'wire it on the chat yes of /agent-workflow-kit upgrade';
export const WIRING_ROUTE_UNUSED = 'no slot uses it for review — once one does, the chat yes of /agent-workflow-kit upgrade wires it';
export const SANDBOX_ENABLED_CONDITION = `enabled in the project settings — ready means wired ${HOST_HONORS_QUALIFIER}`;
export const SANDBOX_NOT_ENABLED_CONDITION = 'not enabled in the project settings — ready means installed';

const PROJECT_FILE = 'settings.json';
const LOCAL_FILE = 'settings.local.json';
const SETTINGS_DIR = '.claude';
const UTF8 = 'utf8';
const ABSENT = 'ENOENT';
const NOT_REGULAR = 'not a regular file';
const REVIEW = 'review';
const COVERED = 'covered';
const NOT_COVERED = 'not covered';
const ENABLED = 'enabled';
const SANDBOX = 'sandbox';
const SURFACE_KEYS = Object.freeze(['excludedCommands', 'hosts', 'dirs']);

const isPlainObject = (value) => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const assertObject = (value, key) => {
  if (!isPlainObject(value)) throw new Error(`${key} must be a plain JSON object`);
  return value;
};

const sandboxOf = (data, file) => {
  if (data === undefined) return undefined;
  assertObject(data, file);
  if (!Object.hasOwn(data, SANDBOX)) return undefined;
  return assertObject(data.sandbox, `${file}: sandbox`);
};

export const sandboxEnabled = (projectData, localData) => {
  const project = sandboxOf(projectData, PROJECT_FILE);
  const local = sandboxOf(localData, LOCAL_FILE);
  const useLocal = local !== undefined && Object.hasOwn(local, ENABLED);
  const judged = useLocal ? local : project;
  const file = useLocal ? LOCAL_FILE : PROJECT_FILE;
  if (judged === undefined || !Object.hasOwn(judged, ENABLED)) return false;
  if (typeof judged.enabled !== 'boolean') throw new Error(`${file}: enabled must be a boolean`);
  return judged.enabled === true;
};

const readObjectKey = (object, key) => {
  if (!Object.hasOwn(object, key)) return {};
  return assertObject(object[key], key);
};

const readArrayKey = (object, key) => {
  if (!Object.hasOwn(object, key)) return [];
  if (!Array.isArray(object[key])) throw new Error(`${key} must be an array`);
  return object[key];
};

export const sandboxSurfaceDelta = (recipe, sandbox, { home, root }) => {
  const base = sandbox === undefined ? {} : assertObject(sandbox, SANDBOX);
  const exclusions = readArrayKey(base, 'excludedCommands');
  const network = readObjectKey(base, 'network');
  const filesystem = readObjectKey(base, 'filesystem');
  const hosts = readArrayKey(network, 'allowedDomains');
  const allowWrite = readArrayKey(filesystem, 'allowWrite');
  if (allowWrite.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw new Error('allowWrite entries must be non-blank strings');
  }
  return {
    excludedCommands: recipe.excludedCommands.filter((entry) => !exclusions.includes(entry)),
    hosts: recipe.hosts.filter((entry) => !hosts.includes(entry)),
    dirs: missingStateDirs(recipe.dirs, allowWrite, { home, root }),
  };
};

const emptyDelta = () => ({ excludedCommands: [], hosts: [], dirs: [] });
const countDelta = (delta) => SURFACE_KEYS.reduce((total, key) => total + delta[key].length, 0);
const unionDeltas = (deltas) => Object.fromEntries(SURFACE_KEYS.map((key) => [
  key, [...new Set(deltas.flatMap((delta) => delta[key]))],
]));

// One non-blocking descriptor for the type check and the read: a FIFO swapped in at the path never blocks.
const readRegular = (path) => {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(NOT_REGULAR);
    return readFileSync(descriptor, UTF8);
  } finally {
    closeSync(descriptor);
  }
};

const readSettings = (root, file) => {
  const path = join(root, SETTINGS_DIR, file);
  const raw = (() => {
    try {
      return readRegular(path);
    } catch (error) {
      if (error?.code === ABSENT) return undefined;
      throw new Error(`${file}: ${error?.message ?? error}`);
    }
  })();
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file}: ${error?.message ?? error}`);
  }
};

const baseEntry = (bridge) => ({
  bridge,
  roles: [],
  used: false,
  state: WIRED,
  review: COVERED,
  missing: emptyDelta(),
  count: 0,
  reason: null,
  route: null,
  reviewRoute: null,
});

const judgeBridge = (bridge, used, sandbox, context, deps) => {
  const roles = used.find((entry) => entry.bridge === bridge)?.roles ?? [];
  const judgedRoles = roles.length === 0 ? [REVIEW] : roles;
  const deltas = new Map([...new Set([...judgedRoles, REVIEW])].map((role) => {
    const recipe = bundledSandboxRecipe([{ bridge, roles: [role] }], deps);
    if (recipe.excludedCommands.length === 0) {
      throw new Error(`bundled manifest ${join(bridge, 'capability.json')} missing or lacking roles.${role}.cmd`);
    }
    const dirs = stateDirsOf(recipe.dirEntries, context);
    return [role, sandboxSurfaceDelta({ ...recipe, dirs }, sandbox, context)];
  }));
  const missing = unionDeltas(judgedRoles.map((role) => deltas.get(role)));
  const count = countDelta(missing);
  const isUsed = roles.length !== 0;
  const reviewMissing = countDelta(deltas.get(REVIEW)) !== 0;
  return {
    ...baseEntry(bridge),
    roles,
    used: isUsed,
    state: count === 0 ? WIRED : UNWIRED,
    review: reviewMissing ? NOT_COVERED : COVERED,
    missing,
    count,
    route: count === 0 ? null : (isUsed ? WIRING_ROUTE : WIRING_ROUTE_UNUSED),
    reviewRoute: reviewMissing ? (roles.includes(REVIEW) ? WIRING_ROUTE : WIRING_ROUTE_UNUSED) : null,
  };
};

export const composeBridgeWiring = ({ root, readiness }, deps = {}) => {
  const ready = BACKEND_PRIORITY.filter((bridge) => readiness.some((row) => row.name === bridge && row.readiness === READY));
  try {
    const project = readSettings(root, PROJECT_FILE);
    const local = readSettings(root, LOCAL_FILE);
    if (!sandboxEnabled(project, local)) {
      return {
        enabled: false,
        reason: null,
        condition: SANDBOX_NOT_ENABLED_CONDITION,
        bridges: ready.map(baseEntry),
      };
    }
    if (deps.preflight) deps.preflight();
    const config = (deps.loadConfig ?? loadConfig)(root).config;
    const used = usedBridges(config, readiness);
    const context = { root, env: deps.env ?? process.env, home: deps.home ?? homedir() };
    const bridges = ready.map((bridge) => judgeBridge(bridge, used, project?.sandbox, context, deps));
    return { enabled: true, reason: null, condition: SANDBOX_ENABLED_CONDITION, bridges };
  } catch (error) {
    const reason = String(error?.message ?? error).replace(/[\r\n]+/g, ' ');
    return {
      enabled: null,
      reason,
      condition: `${UNCHECKED} — ${reason}`,
      bridges: ready.map((bridge) => ({
        ...baseEntry(bridge), state: UNCHECKED, review: UNCHECKED, reason,
      })),
    };
  }
};
