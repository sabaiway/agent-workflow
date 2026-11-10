import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { FAULT_POINTS } from './record.mjs';

export const FAULT_POINT_ENV = 'AW_CHECKER_FAULT_POINT';
export const FAULT_ENTRY_ENV = 'AW_CHECKER_FAULT_ENTRY';
export const FAULT_MARKS_ENV = 'AW_CHECKER_FAULT_MARKS';
export const faultPhrase = (point) => `checker-verdict fault at ${point}`;
export const faultEnvironment = ({ point, entry, marks }) => ({
  NODE_OPTIONS: `--import ${import.meta.url}`,
  [FAULT_POINT_ENV]: point,
  [FAULT_ENTRY_ENV]: entry,
  [FAULT_MARKS_ENV]: marks,
});

export const readFaultMarks = (marks) => {
  try {
    return fs.readFileSync(marks, 'utf8').split('\n').filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

const replacements = {
  read: [[fs, 'readFileSync'], [fs, 'readSync'], [fs, 'readFile'], [fs.promises, 'readFile']],
  stat: [[fs, 'existsSync'], [fs, 'statSync'], [fs, 'lstatSync'], [fs, 'fstatSync'], [fs, 'stat'], [fs, 'lstat'], [fs.promises, 'stat'], [fs.promises, 'lstat']],
  list: [[fs, 'readdirSync'], [fs, 'readdir'], [fs.promises, 'readdir']],
  spawn: [[childProcess, 'spawnSync'], [childProcess, 'spawn'], [childProcess, 'execFileSync'], [childProcess, 'execFile'], [childProcess, 'execSync']],
};
const point = process.env[FAULT_POINT_ENV];
const entry = process.argv[1];
const namedEntry = process.env[FAULT_ENTRY_ENV];
const appendMark = fs.appendFileSync;

if (point) {
  if (!FAULT_POINTS.includes(point)) throw new Error(`Unknown fault point: ${point}`);
  if (entry && namedEntry && fs.realpathSync(entry) === fs.realpathSync(namedEntry)) {
    for (const [owner, name] of replacements[point]) {
      const original = owner[name];
      owner[name] = function throwFault(...argumentsList) {
        const caller = new Error().stack.split('\n')[2] ?? '';
        if (caller.includes('node:') || caller.includes(import.meta.url)) return original.apply(this, argumentsList);
        appendMark(process.env[FAULT_MARKS_ENV], `${namedEntry}\n`);
        throw new Error(faultPhrase(point));
      };
    }
    syncBuiltinESMExports();
  }
}
