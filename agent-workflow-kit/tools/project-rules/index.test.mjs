// The one door of the project-rules module: the index re-exports exactly THEMES, checkRules, ensureRules and
// reconcileMemoryMapRows, and no other kit module reaches a file of this directory past it. Contract: docs/ai/specs/kit/project-rules/index.md.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { load, need } from './rules-harness.test.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const KIT_ROOT = join(HERE, '..', '..');
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"`])([^'"`\n]+)\1/g;

// The specifiers of a source text that name a file of project-rules/ other than its index.
const pastTheDoor = (text) => [...text.matchAll(SPECIFIER)].map((m) => m[2])
  .filter((spec) => spec.includes('project-rules/') && spec.split('project-rules/').pop() !== 'index.mjs');

// Every .mjs file of the kit outside tools/project-rules/, node_modules skipped.
const kitModules = () => {
  const own = join(KIT_ROOT, 'tools', 'project-rules');
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && path !== own) walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(path);
    }
  };
  walk(KIT_ROOT);
  return files;
};

describe('spec:project-rules/S15 the index exports exactly THEMES, checkRules, ensureRules and reconcileMemoryMapRows', () => {
  it('re-exports the very THEMES, checkRules, ensureRules and reconcileMemoryMapRows, and no kit module imports past the index', async () => {
    const reconcileMemoryMapRows = need(await load('./memory-map-row.mjs'), 'reconcileMemoryMapRows');
    const ensureRules = need(await load('./rules-ensure.mjs'), 'ensureRules');
    const index = await load('./index.mjs');
    const THEMES = need(await load('./themes.mjs'), 'THEMES');
    const checkRules = need(await load('./rules-check.mjs'), 'checkRules');
    for (const name of ['THEMES', 'checkRules', 'ensureRules', 'reconcileMemoryMapRows']) need(index, name);
    assert.deepEqual(Object.keys(index).sort(), ['THEMES', 'checkRules', 'ensureRules', 'reconcileMemoryMapRows']);
    assert.equal(index.THEMES, THEMES);
    assert.equal(index.checkRules, checkRules);
    assert.equal(index.ensureRules, ensureRules);
    assert.equal(index.reconcileMemoryMapRows, reconcileMemoryMapRows);

    assert.deepEqual(pastTheDoor("import { x } from '../project-rules/themes.mjs';\nexport * from \"./project-rules/index.mjs\";"),
      ['../project-rules/themes.mjs']);
    const files = kitModules();
    assert.ok(files.length > 0, 'the walk found no kit module');
    const reached = files.flatMap((file) => pastTheDoor(readFileSync(file, 'utf8'))
      .map((spec) => `${relative(KIT_ROOT, file).split(sep).join('/')}: ${spec}`));
    assert.deepEqual(reached, []);
  });
});
