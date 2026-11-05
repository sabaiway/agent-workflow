import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const bridgeRoleSources = (root) => readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.endsWith('-bridge') && existsSync(join(root, entry.name, 'capability.json')))
  .flatMap(({ name }) => {
    const manifest = JSON.parse(readFileSync(join(root, name, 'capability.json'), 'utf8'));
    return manifest.available === false ? [] : Object.entries(manifest.roles ?? {}).map(([role, { source }]) => {
      assert.ok(source, `${name}/capability.json role ${role} has no source`);
      return { bridge: name, source, path: join(root, name, source) };
    });
  })
  .filter(({ path }) => /^#!\s*(\/usr\/bin\/env\s+bash|\/bin\/bash)\b/.test(readFileSync(path, 'utf8').split('\n')[0]));
