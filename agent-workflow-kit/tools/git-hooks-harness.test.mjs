// The deployed scripts of the git-hook suites, read from the kit mirror's manifest: their write order, by this file's
// own loop over the writers' import reader, and the current installer's import closure. It declares no test.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFamily } from '../references/scripts/family.mjs';
import { KIT_COMMANDS } from '../references/scripts/run.mjs';
import { bundledImportsOf } from './ensure-ops.mjs';

export const GIT_HOOK_BUNDLE = join(import.meta.dirname, '..', 'references', 'scripts');
export const INSTALLER_ENTRY = KIT_COMMANDS['install-git-hooks'];
export const readGitHookBundle = (path) => readFileSync(join(GIT_HOOK_BUNDLE, path));
const importsOf = (path) => bundledImportsOf(path, readGitHookBundle(path));

// Each deployed entry after every deployed entry it imports, the lowest path first among those ready.
export const deployedWriteOrder = () => {
  const rest = readFamily(GIT_HOOK_BUNDLE).filter(({ role }) => role === 'deployed').map(({ path }) => path).sort();
  const order = [];
  while (rest.length > 0) {
    const next = rest.findIndex((path) => importsOf(path).every((dependency) => !rest.includes(dependency)));
    if (next === -1) throw new Error(`the deployed entries import one another in a cycle: ${rest.join(', ')}`);
    order.push(...rest.splice(next, 1));
  }
  return order;
};

export const installerClosure = () => {
  const closure = new Set([INSTALLER_ENTRY]);
  for (const path of closure) for (const dependency of importsOf(path)) closure.add(dependency);
  return closure;
};
