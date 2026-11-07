import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAINTENANCE_OFF = 'maintenance.auto=false';
const setMaintenanceOff = (run, dir) => run(['-C', dir, 'config', '--local', 'maintenance.auto', 'false']);

export const makeFixtureRepo = (run, dir, initArgs = []) => {
  run(['init', ...initArgs, dir]);
  run(['-C', dir, 'config', 'maintenance.auto', 'false']);
  return dir;
};

export const cloneFixtureRepo = (run, source, dir, cloneArgs = []) => {
  run(['clone', '-c', MAINTENANCE_OFF, ...cloneArgs, source, dir]);
  return dir;
};

export const addFixtureSubmodule = (run, superDir, url, path, addArgs = []) => {
  run(['-C', superDir, '-c', MAINTENANCE_OFF, 'submodule', 'add', ...addArgs, url, path]);
  const directory = join(superDir, path);
  setMaintenanceOff(run, directory);
  return directory;
};

const getFixtureSubmodules = (superDir, recursive) => {
  const modulesFile = join(superDir, '.gitmodules');
  if (!existsSync(modulesFile)) return [];
  return [...readFileSync(modulesFile, 'utf8').matchAll(/^\s*path\s*=\s*(.*?)\s*$/gm)].flatMap((match) => {
    const directory = join(superDir, match[1]);
    return [directory, ...(recursive && existsSync(join(directory, '.git')) ? getFixtureSubmodules(directory, true) : [])];
  });
};

export const updateFixtureSubmodules = (run, superDir, updateArgs = []) => {
  const recursive = updateArgs.includes('--recursive');
  const initialized = new Set(getFixtureSubmodules(superDir, recursive).filter((directory) => existsSync(join(directory, '.git'))));
  run(['-C', superDir, '-c', MAINTENANCE_OFF, 'submodule', 'update', ...updateArgs]);
  const created = getFixtureSubmodules(superDir, recursive)
    .filter((directory) => !initialized.has(directory) && existsSync(join(directory, '.git')));
  for (const directory of created) setMaintenanceOff(run, directory);
  return created;
};
