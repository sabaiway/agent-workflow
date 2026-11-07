import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAMILY_DIRS } from '../release/version-sync.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const CHECKOUT_ROOT = resolve(dirname(MODULE_PATH), '..', '..');
const MOUNT_TABLE = '/proc/self/mountinfo';
const MOUNT_POINT_INDEX = 4;
const PROBES = [['user', 'EROFS'], ['root', 'EROFS'], ['copy', 'ok']];
const MOUNT_ESCAPES = { '040': ' ', '011': '\t', '012': '\n', '134': '\\' };
const REMOVE_OPTIONS = { recursive: true, force: true };
const ROOT_PROBE_SCRIPT = [
  "const { writeFileSync, rmSync } = require('node:fs');",
  'const path = process.argv[1];',
  "try { writeFileSync(path, 'probe', { flag: 'wx' }); rmSync(path); console.log('ok'); }",
  'catch (error) { console.log(error.code ?? error.message); }',
].join('\n');
const runCommand = (args) => spawnSync(args[0], args.slice(1), { encoding: 'utf8' });
const reportError = (message) => console.error(`package-seal: ${message}`);

export const planSeal = (root) => FAMILY_DIRS.flatMap((directory) => {
  const path = join(root, directory);
  return [['sudo', 'mount', '--bind', path, path], ['sudo', 'mount', '-o', 'remount,bind,ro', path]];
});

export const planRestore = (root, mountTable) => {
  const paths = new Set(FAMILY_DIRS.map((directory) => join(root, directory)));
  return mountTable.split('\n').flatMap((line) => {
    const field = line.trim().split(/\s+/)[MOUNT_POINT_INDEX];
    const point = field?.replace(/\\(040|011|012|134)/g, (_, code) => MOUNT_ESCAPES[code]);
    return paths.has(point) ? [['sudo', 'umount', point]] : [];
  }).toReversed();
};

export const judgeSealProbes = (dirs, results) => {
  const failures = dirs.flatMap((dir) => PROBES.flatMap(([probe, expected]) => {
    const matches = results.filter((result) => result.dir === dir && result.probe === probe);
    return matches.length === 1 && matches[0].outcome === expected ? []
      : [`${dir}: ${probe} expected ${expected}; received ${matches.length} result(s): ${matches.map((result) => result.outcome).join(', ')}`];
  }));
  return { ok: failures.length === 0, failures };
};

const getCommandFailure = (result) => {
  if (result.error) return `spawn ${result.error.code ?? result.error.message}`;
  if (result.signal) return `signal ${result.signal}`;
  if (result.status !== 0) return `status ${result.status}: ${(result.stderr ?? '').trim()}`;
  return null;
};

const runPlan = (plan, runner) => {
  for (const args of plan) {
    const failure = getCommandFailure(runner(args));
    if (failure) {
      reportError(`${JSON.stringify(args)} failed: ${failure}`);
      return 1;
    }
  }
  return 0;
};

const probeUserWrite = (path) => {
  try {
    writeFileSync(path, 'probe', { flag: 'wx' });
    rmSync(path);
    return 'ok';
  } catch (error) { return error.code ?? error.message; }
};

const probeCopyWrite = (directory) => {
  try {
    const folder = mkdtempSync(join(tmpdir(), 'package-seal-'));
    try {
      const source = readdirSync(directory, { recursive: true }).sort()
        .map((entry) => join(directory, entry)).find((path) => lstatSync(path).isFile());
      if (!source) return 'ENOENT';
      const copy = join(folder, 'copy');
      copyFileSync(source, copy);
      appendFileSync(copy, 'probe');
      return 'ok';
    } finally { rmSync(folder, REMOVE_OPTIONS); }
  } catch (error) { return error.code ?? error.message; }
};

const checkSeal = (runner, root) => {
  const dirs = FAMILY_DIRS.map((directory) => join(root, directory));
  const results = dirs.flatMap((dir) => {
    const probeFile = join(dir, `.package-seal-${process.pid}`);
    const user = probeUserWrite(`${probeFile}-user`);
    const rootResult = runner(['sudo', process.execPath, '-e', ROOT_PROBE_SCRIPT, `${probeFile}-root`]);
    const root = getCommandFailure(rootResult) ?? (rootResult.stdout ?? '').trim();
    return [{ dir, probe: 'user', outcome: user }, { dir, probe: 'root', outcome: root },
      { dir, probe: 'copy', outcome: probeCopyWrite(dir) }];
  });
  const answer = judgeSealProbes(dirs, results);
  for (const failure of answer.failures) reportError(failure);
  return answer.ok ? 0 : 1;
};

export const main = (argv, runner = runCommand, root = CHECKOUT_ROOT) => {
  if (argv.length !== 1 || !['seal', 'check', 'restore'].includes(argv[0])) {
    reportError('usage: node scripts/testing/package-seal.mjs <seal|check|restore>');
    return 2;
  }
  try {
    if (argv[0] === 'seal') return runPlan(planSeal(root), runner);
    if (argv[0] === 'check') return checkSeal(runner, root);
    return runPlan(planRestore(root, readFileSync(MOUNT_TABLE, 'utf8')), runner);
  } catch (error) {
    reportError(error.message);
    return 1;
  }
};

if (process.argv[1] && resolve(process.argv[1]) === MODULE_PATH) process.exitCode = main(process.argv.slice(2));
