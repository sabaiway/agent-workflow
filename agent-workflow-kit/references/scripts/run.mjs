#!/usr/bin/env node
// run.mjs — the stable kit command (spec kit-command): `node scripts/agent-workflow/run.mjs <name> [arguments...]`
// runs the named kit check with every argument unchanged, and `unit-tests` runs the Node test runner with the lcov
// reporter and the kit test reporter. The names are frozen; the files behind them are the kit's.
// Dependency-free, Node >= 22. No side effects on import.

import { realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
export const UNIT_TESTS_NAME = 'unit-tests';
export const UNIT_TESTS_REPORTER = 'test-reporter/reporter.mjs';

const NAMES = [...Object.keys(KIT_COMMANDS), UNIT_TESTS_NAME];
const PREFIX = '[run]';
const USAGE = `Usage: node ${KIT_COMMAND_PATH} <name> [arguments...]
Runs the named kit check with every argument after the name, unchanged; ${UNIT_TESTS_NAME} runs the Node test runner
with the lcov reporter and the kit test reporter over the arguments. Names: ${NAMES.join(', ')}.
`;

const isRegularFile = (path) => statSync(path, { throwIfNoEntry: false })?.isFile() === true;

// The runner's flags for unit-tests: the lcov under the git dir run-gates exports, the kit reporter on stdout.
const unitTestsFlags = (gitDir, reporter) => ['--test', '--experimental-test-coverage', '--test-reporter=lcov',
  `--test-reporter-destination=${gitDir}/agent-workflow-lcov.info`, `--test-reporter=${pathToFileURL(reporter).href}`,
  '--test-reporter-destination=stdout'];

export const main = (argv = process.argv.slice(2), deps = {}) => {
  const { spawn = spawnSync, isFile = isRegularFile, stdout = process.stdout, stderr = process.stderr, env = process.env } = deps;
  const [name, ...args] = argv;
  if (name === undefined) {
    stderr.write(USAGE);
    return 2;
  }
  if (name === '--help' || name === '-h') {
    stdout.write(USAGE);
    return 0;
  }
  const unitTests = name === UNIT_TESTS_NAME;
  if (!unitTests && !Object.hasOwn(KIT_COMMANDS, name)) {
    stderr.write(`${PREFIX} unknown name ${JSON.stringify(name)} — the known names are ${NAMES.join(', ')}\n`);
    return 2;
  }
  const target = unitTests ? UNIT_TESTS_REPORTER : KIT_COMMANDS[name];
  const file = join(HERE, ...target.split('/'));
  if (!isFile(file)) {
    stderr.write(`${PREFIX} ${name}: scripts/agent-workflow/${target} is not a file of this deployment\n`);
    return 1;
  }
  if (unitTests && !env.AW_GIT_DIR) {
    stderr.write(`${PREFIX} ${name}: AW_GIT_DIR is unset or empty — run-gates exports it; the lcov has no destination\n`);
    return 1;
  }
  const runArgs = unitTests ? [...unitTestsFlags(env.AW_GIT_DIR, file), ...args] : [file, ...args];
  const result = spawn(process.execPath, runArgs, { stdio: 'inherit' });
  const what = unitTests ? 'the test runner' : 'the check';
  if (result.error) {
    stderr.write(`${PREFIX} ${name}: cannot run ${what} (${result.error.message})\n`);
    return 1;
  }
  if (result.signal) {
    stderr.write(`${PREFIX} ${name}: ${what} was killed by ${result.signal}\n`);
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
