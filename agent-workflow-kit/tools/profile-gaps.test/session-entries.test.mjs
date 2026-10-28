// session-entries.test.mjs — the import closure of the gap registry (docs/ai/specs/kit/tier/gap-screen/):
// it reaches no write module and, the section reconcile and the region table retired, neither of them.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = resolve(HERE, '..');
const MODULE = join(TOOLS, 'profile-gaps.mjs');
const PURITY_TEST = join(TOOLS, '..', 'test', 'read-graph-purity.test.mjs');
const IMPORT_RE = /(?:^|\n)\s*(?:import\s[^'"]*?|export\s[^'"]*?from\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const WRITE_MODULES_RE = /const WRITE_MODULES = \[([^\]]*)\]/;
const RETIRED = ['lens-region.mjs', 'rules-regions.mjs'];

describe('the import closure of the gap registry', () => {
  it('reaches no write module and neither retired rules-file module', () => {
    const listed = readFileSync(PURITY_TEST, 'utf8').match(WRITE_MODULES_RE);
    assert.ok(listed, 'read-graph-purity.test.mjs declares WRITE_MODULES');
    const writers = [...listed[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
    assert.ok(writers.includes('atomic-write.mjs'), 'the write-module list is not vacuous');
    const seen = new Set();
    const queue = [MODULE];
    while (queue.length > 0) {
      const file = queue.shift();
      if (seen.has(file)) continue;
      seen.add(file);
      for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) queue.push(resolve(dirname(file), match[1]));
    }
    const names = [...seen].map((file) => relative(TOOLS, file));
    assert.ok(names.includes('reference-profile.mjs'), names.join(', '));
    assert.deepEqual(names.filter((name) => writers.includes(name)), []);
    assert.deepEqual(names.filter((name) => RETIRED.includes(name)), []);
  });
});
