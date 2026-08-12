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
import { SOURCE_SIZE_DEFAULTS, measureFile } from '../tools/source-size-core.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TOOLS_DIR = fileURLToPath(new URL('../tools', import.meta.url));
const IMPORT_RE = /(?:^|\n)\s*(?:import\s[^'"]*?|export\s[^'"]*?from\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

// source-size-core.mjs joins the roots for the reason D-18 split it out at all: the practice has to
// be ASKABLE from surfaces that must not reach a writer (the procedures render, the fill's candidate,
// the advisor's probe), and "the core is pure" is a claim only this walk can keep true as the halves
// behind it move.
const READ_ROOTS = ['flow-store-read.mjs', 'procedures.mjs', 'source-size-core.mjs'];
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

  // ── the source-size practice's own two edges (D-18) ──────────────────────────────────
  // The split exists so that the practice can be asked about from the read surfaces while its WRITER
  // stays out of their reach. Both halves of that claim are pinned here, by name, because the whole
  // arrangement is invisible from either file alone.
  it('core-import-is-write-free: the source-size read core reaches no write-API module, and its writer is not in the read graph', () => {
    const core = resolve(TOOLS_DIR, 'source-size-core.mjs');
    const checker = resolve(TOOLS_DIR, 'source-size-check.mjs');
    assert.ok(edges.has(core), 'the core is a tools module');
    assert.ok((edges.get(core) ?? []).length > 0, 'and the walk really sees its re-export edges');
    const closure = [...closureOf([core])].map(rel);
    assert.deepEqual(closure.filter((r) => WRITE_MODULES.includes(r)), [], `the core reached: ${closure.sort().join(', ')}`);
    assert.equal(closure.includes('source-size-check.mjs'), false, 'the core must never reach its own writer');
    // Non-vacuity from the other side: the CHECKER does reach a writer, so "reaches no write-API
    // module" is a property of the core, not of the walk failing to see anything at all.
    assert.ok([...closureOf([checker])].map(rel).includes('atomic-write.mjs'), 'the checker half really does write');
    // And no read root reaches the checker either — the whole point of splitting it out.
    const readClosure = [...closureOf(READ_ROOTS.map((r) => resolve(TOOLS_DIR, r)))].map(rel);
    assert.equal(readClosure.includes('source-size-check.mjs'), false, `a read root reached the writer: ${readClosure.sort().join(', ')}`);
  });

  it('no-cycle-checker-gatesinit: the checker imports the fill, the fill imports only the core, and neither closure re-enters the other', () => {
    const checker = resolve(TOOLS_DIR, 'source-size-check.mjs');
    const gatesInit = resolve(TOOLS_DIR, 'gates-init.mjs');
    assert.ok(edges.get(checker).map(rel).includes('gates-init.mjs'), 'the adopt verb composes the fill rather than re-implementing it');
    assert.ok(edges.get(gatesInit).map(rel).includes('source-size-core.mjs'), 'the fill asks the practice through its core');
    const fillClosure = [...closureOf([gatesInit])].map(rel);
    assert.equal(fillClosure.includes('source-size-check.mjs'), false, `the fill must not reach the checker: ${fillClosure.sort().join(', ')}`);
  });

  // ── the flow-check tranche's own boundaries (baseline-practices tranche 1) ────────────
  // The split traded ONE 842-line module for a facade over three pure halves. What makes that a
  // decomposition rather than the same coupling spread wider is the DIRECTION of the edges, and no
  // single file can show it — only this walk can.
  it('flow-check-import-boundaries: the facade is the only module that reaches all three halves, and the pure halves never reach the git lane', () => {
    const facade = resolve(TOOLS_DIR, 'flow-check.mjs');
    const cores = resolve(TOOLS_DIR, 'flow-check-cores.mjs');
    const rungs = resolve(TOOLS_DIR, 'flow-check-rungs.mjs');
    const gitLane = resolve(TOOLS_DIR, 'flow-check-git-lane.mjs');
    for (const f of [facade, cores, rungs, gitLane]) assert.ok(edges.has(f), `${rel(f)} must be a tools module`);
    for (const half of [cores, rungs, gitLane]) {
      assert.ok(edges.get(facade).includes(half), `the facade must import ${rel(half)} — it owns the whole public surface`);
    }
    assert.ok(edges.get(cores).includes(rungs), 'the decision cores compose the evidence rungs');
    // One way only: the rungs own the vocabulary both share, so the reverse edge would be a cycle.
    assert.equal([...closureOf([rungs])].includes(cores), false, `the rungs must not re-enter the cores: ${[...closureOf([rungs])].map(rel).sort().join(', ')}`);
    // Purity of the "pure over read-results" claim: base-motion inputs arrive as INJECTED
    // resolvers, so neither pure half may reach the module that spawns git for them.
    for (const half of [cores, rungs]) {
      assert.equal([...closureOf([half])].includes(gitLane), false, `${rel(half)} must not reach the git lane — its inputs are injected, never resolved`);
    }
    // And the git lane stays a leaf, so it can never pull a decision core back into a git spawn.
    const laneClosure = [...closureOf([gitLane])].map(rel).filter((r) => r !== 'flow-check-git-lane.mjs');
    assert.deepEqual(laneClosure.filter((r) => r.startsWith('flow-check')), [], `the git lane must import no flow-check sibling: ${laneClosure.sort().join(', ')}`);
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

// This phase creates no test file of its own — flow-check.test.mjs stays byte-identical, which is
// what keeps its red-proof standing — so the plan's own-rule check lands beside the boundaries test
// that already binds the same three modules.
describe('source-size — the plan keeps its own rule', () => {
  it('phase5-plan-files-within-defaults: every file this plan has created through Phase 5 is within the declared defaults', () => {
    // Cumulative and EXPLICIT (never derived from git state), so an earlier phase's file growing
    // under a later phase's edits is caught here.
    const created = [
      'agent-workflow-kit/tools/source-size-core.mjs',
      'agent-workflow-kit/tools/source-size-check.mjs',
      'agent-workflow-kit/tools/source-size-check.test.mjs',
      'agent-workflow-kit/tools/source-size-core.test.mjs',
      'agent-workflow-kit/tools/source-size-config.test.mjs',
      'agent-workflow-kit/tools/source-size-ratchet.test.mjs',
      'agent-workflow-kit/tools/source-size-refusal.mjs',
      'agent-workflow-kit/tools/source-size-config.mjs',
      'agent-workflow-kit/tools/source-size-scope.mjs',
      'agent-workflow-kit/tools/source-size-gate-cmd.mjs',
      'agent-workflow-kit/tools/source-size-judge.mjs',
      'agent-workflow-kit/tools/source-size-report.mjs',
      'agent-workflow-kit/tools/source-size-aggregate.test.mjs',
      'agent-workflow-kit/tools/source-size-writer.test.mjs',
      'agent-workflow-kit/tools/source-size-practice.test.mjs',
      'agent-workflow-kit/tools/source-size-stop-rendering.test.mjs',
      'agent-workflow-kit/tools/source-size-adopt.test.mjs',
      'agent-workflow-kit/tools/recommendations-source-size.test.mjs',
      // Phase 5 (campaign tranche 1) — the three halves the flow-check facade now composes.
      'agent-workflow-kit/tools/flow-check-cores.mjs',
      'agent-workflow-kit/tools/flow-check-rungs.mjs',
      'agent-workflow-kit/tools/flow-check-git-lane.mjs',
    ];
    for (const path of created) {
      const { lines: count, maxLineBytes } = measureFile(REPO_ROOT, path);
      assert.ok(count <= SOURCE_SIZE_DEFAULTS.maxLines, `${path}: ${count} lines exceeds ${SOURCE_SIZE_DEFAULTS.maxLines}`);
      assert.ok(maxLineBytes <= SOURCE_SIZE_DEFAULTS.maxLineBytes, `${path}: longest line ${maxLineBytes} bytes exceeds ${SOURCE_SIZE_DEFAULTS.maxLineBytes}`);
    }
  });
});
