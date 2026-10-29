// kit-command-gates.mjs — the gate migration's reading of a kit-check gate (spec kit-command): a matched gate over a
// current kit folder is switched to the stable kit command, any other form naming a check is named with its repoint.
// Dependency-free, Node >= 22. No side effects on import.

import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT_COMMANDS, KIT_COMMAND_PATH } from '../run.mjs';
import { readFamily } from '../family.mjs';

const TREE = dirname(dirname(fileURLToPath(import.meta.url)));
const KIT_FOLDER = dirname(KIT_COMMAND_PATH);
const SCRIPTS_FOLDER = dirname(KIT_FOLDER);
const COMMAND = `node ${KIT_COMMAND_PATH}`;

const fileNameOf = (path) => path.slice(path.lastIndexOf('/') + 1);
const NAME_BY_FILE = new Map(Object.entries(KIT_COMMANDS).map(([name, target]) => [fileNameOf(target), name]));
const flatOf = (target) => `${SCRIPTS_FOLDER}/${fileNameOf(target)}`;

// The flat `scripts/<file>` of every known name: the values --kit-script takes.
export const FLAT_KIT_SCRIPTS = Object.freeze(Object.values(KIT_COMMANDS).map(flatOf));

// path token → { name, flat } for the deployed or the flat path of a known name, relative to the project root.
const KNOWN_PATHS = new Map(Object.entries(KIT_COMMANDS).flatMap(([name, target]) => [
  [`${KIT_FOLDER}/${target}`, { name, flat: false }],
  [flatOf(target), { name, flat: true }],
]));

const SAFE_FLAG = /^--[A-Za-z0-9][A-Za-z0-9-]*$/;
const MATCHED = /^node +("[^"]*"|[^\s"]+)((?: +[^\s"]+)*)$/;
const TOKENS = /"[^"]*"|[^\s"]+/g;

const unquoted = (token) => (token.length > 1 && token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token);

// The gate's one kit-check invocation, or null: `node`, one path token of a known name, then only safe `--` flags.
const matchOf = (cmd) => {
  const found = MATCHED.exec(cmd.trim());
  if (!found) return null;
  const token = unquoted(found[1]).replace(/^\.\//, '');
  const known = KNOWN_PATHS.get(token);
  const flags = found[2].split(' ').filter(Boolean);
  if (!known || !flags.every((flag) => SAFE_FLAG.test(flag))) return null;
  return { ...known, token, args: flags };
};

// Every known name a path token of the cmd names by its last path segment, one per token.
const namedChecks = (cmd) => (cmd.match(TOKENS) ?? []).map((token) => NAME_BY_FILE.get(fileNameOf(unquoted(token)))).filter(Boolean);

// The repoint lines of a gate kept untouched over a current kit folder: one per path token naming a kit check.
export const repointsOf = (gate) => namedChecks(gate.cmd).map((name) => ({ id: gate.id, repoint: `${COMMAND} ${name}` }));

// The first path, relative to the project, that keeps the kit folder from being current, or null when it is.
const firstStaleKitPath = (projectDir) => {
  const at = (path) => join(projectDir, ...path.split('/'));
  const isPlain = (path, kind) => {
    try {
      const stat = lstatSync(at(path));
      return kind === 'directory' ? stat.isDirectory() : stat.isFile();
    } catch {
      return false;
    }
  };
  const folders = new Set();
  for (const folder of [SCRIPTS_FOLDER, KIT_FOLDER]) {
    if (!isPlain(folder, 'directory')) return folder;
    folders.add(folder);
  }
  for (const { path } of readFamily(TREE).filter((entry) => entry.role === 'deployed')) {
    const deployed = `${KIT_FOLDER}/${path}`;
    const folder = dirname(deployed);
    if (!folders.has(folder)) {
      if (!isPlain(folder, 'directory')) return folder;
      folders.add(folder);
    }
    if (!isPlain(deployed, 'file')) return deployed;
    try {
      if (!readFileSync(at(deployed)).equals(readFileSync(join(TREE, path)))) return deployed;
    } catch {
      return deployed;
    }
  }
  return null;
};

export const planKitCommandGates = (gates, projectDir, kitScripts = []) => {
  const read = gates.map((gate) => {
    const cmd = gate !== null && typeof gate === 'object' && typeof gate.cmd === 'string' ? gate.cmd : '';
    return { gate, match: matchOf(cmd), names: namedChecks(cmd) };
  });
  const stale = read.some(({ names }) => names.length > 0) ? firstStaleKitPath(projectDir) : null;
  const result = { gates: [], switched: [], withheld: [], repoints: [] };
  for (const { gate, match, names } of read) {
    if (stale !== null) {
      if (match) result.withheld.push({ id: gate.id, path: stale });
      result.gates.push(gate);
    } else if (match && (!match.flat || kitScripts.includes(match.token))) {
      const cmd = [COMMAND, match.name, ...match.args].join(' ');
      result.switched.push({ id: gate.id, cmd, was: gate.cmd });
      result.gates.push({ ...gate, cmd });
    } else {
      if (names.length > 0) result.repoints.push(...repointsOf(gate));
      result.gates.push(gate);
    }
  }
  return result;
};
