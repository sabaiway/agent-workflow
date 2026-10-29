#!/usr/bin/env node
// run.mjs — the stable kit command (spec kit-command): `node scripts/agent-workflow/run.mjs <name> [arguments...]`
// runs the named kit check with every argument unchanged. The names are frozen; the files behind them are the kit's.
// Dependency-free, Node >= 22. No side effects on import.

import { realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const HERE = dirname(__filename);

export const KIT_COMMAND_PATH = 'scripts/agent-workflow/run.mjs';
export const KIT_COMMANDS = Object.freeze({
  'docs-size': 'docs-size/check-docs-size.mjs',
  'archive-changelog': 'archives/archive-changelog.mjs',
  'archive-issues': 'archives/archive-issues.mjs',
  'archive-decisions': 'archives/archive-decisions.mjs',
  'install-git-hooks': 'git-hooks/install-git-hooks.mjs',
});

const NAMES = Object.keys(KIT_COMMANDS);
const PREFIX = '[run]';
const USAGE = `Usage: node ${KIT_COMMAND_PATH} <name> [arguments...]
Runs the named kit check with every argument after the name, unchanged. Names: ${NAMES.join(', ')}.
`;

const isRegularFile = (path) => statSync(path, { throwIfNoEntry: false })?.isFile() === true;

export const main = (argv = process.argv.slice(2), deps = {}) => {
  const { spawn = spawnSync, isFile = isRegularFile, stdout = process.stdout, stderr = process.stderr } = deps;
  const [name, ...args] = argv;
  if (name === undefined) {
    stderr.write(USAGE);
    return 2;
  }
  if (name === '--help' || name === '-h') {
    stdout.write(USAGE);
    return 0;
  }
  if (!Object.hasOwn(KIT_COMMANDS, name)) {
    stderr.write(`${PREFIX} unknown name ${JSON.stringify(name)} — the known names are ${NAMES.join(', ')}\n`);
    return 2;
  }
  const target = KIT_COMMANDS[name];
  const file = join(HERE, ...target.split('/'));
  if (!isFile(file)) {
    stderr.write(`${PREFIX} ${name}: scripts/agent-workflow/${target} is not a file of this deployment\n`);
    return 1;
  }
  const result = spawn(process.execPath, [file, ...args], { stdio: 'inherit' });
  if (result.error) {
    stderr.write(`${PREFIX} ${name}: cannot run the check (${result.error.message})\n`);
    return 1;
  }
  if (result.signal) {
    stderr.write(`${PREFIX} ${name}: the check was killed by ${result.signal}\n`);
    return 1;
  }
  return result.status ?? 1;
};

// Run main() only when executed directly, never on import; compare by REAL path so a symlinked entry still runs.
const isDirectRun = (() => {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(__filename);
  } catch {
    return false;
  }
})();
if (isDirectRun) process.exitCode = main();
