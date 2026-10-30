// kit-command-gates.mjs — the gate migration's reading of a kit-check gate (spec kit-command): a matched gate over a
// current kit folder is switched to the stable kit command, any other form naming a check is named with its repoint.
// Dependency-free, Node >= 22. No side effects on import.

import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
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

// path token → { name, flat } for the deployed or the flat path of a known name, relative to the project root.
const KNOWN_PATHS = new Map(Object.entries(KIT_COMMANDS).flatMap(([name, target]) => [
  [`${KIT_FOLDER}/${target}`, { name, flat: false }],
  [flatOf(target), { name, flat: true }],
]));

const SAFE_FLAG = /^--[A-Za-z0-9][A-Za-z0-9-]*$/;
const MATCHED = /^node +("[^"]*"|[^\s"]+)((?: +[^\s"]+)*)$/;
const CHECK_FILE = new RegExp(`(?<![A-Za-z0-9._-])(${[...NAME_BY_FILE.keys()].map((file) => file.replaceAll('.', '\\.')).join('|')})(?=$|[\\s"';&|<>()])`, 'g');

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

// Every known name whose target's file name stands whole in the cmd and not as the end of its deployed path, one per occurrence.
const namedChecks = (cmd) => [...cmd.matchAll(CHECK_FILE)].flatMap((found) => {
  const name = NAME_BY_FILE.get(found[1]);
  return cmd.slice(0, found.index).endsWith(`agent-workflow/${posix.dirname(KIT_COMMANDS[name])}/`) ? [] : [name];
});

export const repointsOf = (gate) => namedChecks(gate.cmd).map((name) => ({ id: gate.id, repoint: `${COMMAND} ${name}` }));

// The first path, relative to the project, that keeps the name from being current — the command, its target and
// what the target loads — or null when it is.
const firstStaleKitPath = (projectDir, name) => {
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
  const deployedPaths = new Set(readFamily(TREE).filter((entry) => entry.role === 'deployed').map(({ path }) => path));
  const needed = new Set([fileNameOf(KIT_COMMAND_PATH), KIT_COMMANDS[name]]);
  for (const path of needed) {
    const deployed = `${KIT_FOLDER}/${path}`;
    const folder = dirname(deployed);
    if (!folders.has(folder)) {
      if (!isPlain(folder, 'directory')) return folder;
      folders.add(folder);
    }
    if (!isPlain(deployed, 'file')) return deployed;
    try {
      const source = readFileSync(join(TREE, path));
      if (!deployedPaths.has(path) || !readFileSync(at(deployed)).equals(source)) return deployed;
      for (const found of source.toString('utf8').matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"](\.[^'"\n]+)['"]/g)) needed.add(posix.join(posix.dirname(path), found[1]));
    } catch {
      return deployed;
    }
  }
  return null;
};

const isAbsent = (path) => {
  try { lstatSync(path); } catch (error) { return error.code === 'ENOENT'; }
  return false;
};

export const planKitCommandGates = (gates, projectDir) => {
  const read = gates.map((gate) => {
    const cmd = gate !== null && typeof gate === 'object' && typeof gate.cmd === 'string' ? gate.cmd : '';
    return { gate, match: matchOf(cmd), names: namedChecks(cmd) };
  });
  const namesToCheck = new Set(read.flatMap(({ match, names }) => match ? [match.name, ...names] : names));
  const staleByName = new Map([...namesToCheck].map((name) => [name, firstStaleKitPath(projectDir, name)]));
  const result = { gates: [], switched: [], withheld: [], repoints: [] };
  for (const { gate, match, names } of read) {
    const stale = match ? staleByName.get(match.name) : null;
    if (stale !== null) {
      if (match) result.withheld.push({ id: gate.id, path: stale });
      result.gates.push(gate);
    } else if (match && (!match.flat || isAbsent(join(projectDir, match.token)))) {
      const cmd = [COMMAND, match.name, ...match.args].join(' ');
      result.switched.push({ id: gate.id, cmd, was: gate.cmd });
      result.gates.push({ ...gate, cmd });
    } else {
      for (const name of names) if (staleByName.get(name) === null) result.repoints.push({ id: gate.id, repoint: `${COMMAND} ${name}` });
      result.gates.push(gate);
    }
  }
  return result;
};
