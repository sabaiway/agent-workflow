// read-graph-purity.test.mjs — FLOW-READ-GRAPH-PURITY (flow Plan 4 Phase 2): the read-only
// advisor surface is STRUCTURALLY read-only, not narrated so. Two pins over the static import
// graph of agent-workflow-kit/tools:
//   1. the transitive import closure of the read roots (flow-store-read.mjs — the store's read
//      half — and procedures.mjs — the advisor) reaches NO write-API module: atomic-write.mjs,
//      flow-store.mjs (the append/lock half), orchestration-write.mjs;
//   2. the whole non-test tools module graph is ACYCLIC (the flow/core graph rides inside it) —
//      the R10 rider depends on this: the subset-attempt factory imports the checker predicate
//      from the gates-declaration leaf, which is only sound while no cycle re-enters flow-store.
// Static-text walk (the same relative-import grammar the modules actually use); a parse-level
// false negative would surface as a missing edge, so the roots' presence is asserted too.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = fileURLToPath(new URL('../tools', import.meta.url));
const IMPORT_RE = /(?:^|\n)\s*(?:import\s[^'"]*?|export\s[^'"]*?from\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

const READ_ROOTS = ['flow-store-read.mjs', 'procedures.mjs'];
const WRITE_MODULES = ['atomic-write.mjs', 'flow-store.mjs', 'orchestration-write.mjs'];

const moduleFiles = (() => {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = resolve(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs')) files.push(p);
    }
  };
  walk(TOOLS_DIR);
  return files;
})();

const importsOf = (file) => {
  const deps = [];
  for (const m of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) deps.push(resolve(dirname(file), m[1]));
  return deps;
};

const edges = new Map(moduleFiles.map((f) => [f, importsOf(f)]));
const rel = (f) => relative(TOOLS_DIR, f).split(sep).join('/');

const closureOf = (roots) => {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dep of edges.get(file) ?? []) queue.push(dep);
  }
  return seen;
};

describe('read-graph purity — the advisor surface is structurally read-only (FLOW-READ-GRAPH-PURITY)', () => {
  it('the read roots exist and the walk sees EVERY root\'s imports (the graph is not vacuously empty for any root)', () => {
    for (const root of READ_ROOTS) {
      const abs = resolve(TOOLS_DIR, root);
      assert.ok(edges.has(abs), `read root ${root} must be a tools module`);
      assert.ok((edges.get(abs) ?? []).length > 0, `${root} imports siblings — an empty edge list would mean the import grammar drifted past this walk and its purity check went vacuous`);
    }
  });

  it('the transitive closure of the read roots reaches NO write-API module', () => {
    const closure = closureOf(READ_ROOTS.map((r) => resolve(TOOLS_DIR, r)));
    const reachedWriters = [...closure].map(rel).filter((r) => WRITE_MODULES.includes(r));
    assert.deepEqual(reachedWriters, [], `the read surface must not import the write half — reached: ${reachedWriters.join(', ')}; full closure: ${[...closure].map(rel).sort().join(', ')}`);
  });

  it('the tools module graph is acyclic — no import cycle anywhere (the flow/core graph rides inside)', () => {
    const WHITE = 0;
    const GREY = 1;
    const BLACK = 2;
    const color = new Map();
    const stack = [];
    const cycles = [];
    const dfs = (node) => {
      color.set(node, GREY);
      stack.push(node);
      for (const dep of edges.get(node) ?? []) {
        const c = color.get(dep) ?? WHITE;
        if (c === GREY) cycles.push([...stack.slice(stack.indexOf(dep)), dep].map(rel).join(' -> '));
        else if (c === WHITE && edges.has(dep)) dfs(dep);
      }
      stack.pop();
      color.set(node, BLACK);
    };
    for (const file of moduleFiles) if ((color.get(file) ?? WHITE) === WHITE) dfs(file);
    assert.deepEqual(cycles, [], `import cycles found:\n${cycles.join('\n')}`);
  });
});
