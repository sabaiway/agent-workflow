// flow-store-layout.test.mjs — the STRUCTURAL contract of the flow-store facade and the five leaves
// it composes (baseline-practices tranche 2). Single responsibility: what no single file can show —
// the frozen public surface, that every facade name IS the leaf's own binding, that the facade
// carries no logic at all, that every module stays inside the declared caps, and that the edges run
// ONE way (facade → append → pure leaves → flow-record). Behaviour is characterized elsewhere: the
// three owning suites (flow-store.test.mjs, flow-store-races.test.mjs, flow-chain-identity.test.mjs)
// stay BYTE-IDENTICAL across the split and are the bar for "the move changed nothing".
//
// Loading rule for the WHOLE suite: no static `import` of the facade or of a leaf at module top —
// every one is reached by a dynamic import() or a file read INSIDE its own test callback. On an
// unsplit tree the file therefore still LOADS (a missing leaf reds exactly one case instead of
// making every testId unresolvable), which is what lets core-evidence red-proof bind a case here.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_SIZE_DEFAULTS, measureFile } from '../tools/source-size-core.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TOOLS_DIR = fileURLToPath(new URL('../tools', import.meta.url));
const TOOLS_REL = 'agent-workflow-kit/tools';
// The same relative-import grammar read-graph-purity.test.mjs:22 walks the tools graph with.
const IMPORT_RE = /(?:^|\n)\s*(?:import\s[^'"]*?|export\s[^'"]*?from\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

const FACADE = 'flow-store.mjs';
const READ_HALF = 'flow-store-read.mjs';
const PURE_LEAVES = ['flow-chain-state.mjs', 'flow-subset-budget.mjs'];
const APPEND_LEAF = 'flow-append.mjs';
const MINT_LEAVES = ['flow-adoption-mint.mjs', 'flow-delta-proof.mjs'];
const LEAVES = [...PURE_LEAVES, APPEND_LEAF, ...MINT_LEAVES];
const WRITE_LEAVES = [APPEND_LEAF, ...MINT_LEAVES];
const READ_ROOTS = ['flow-store-read.mjs', 'procedures.mjs', 'source-size-core.mjs'];

// The frozen 29-name surface (plan D11), a LITERAL fixture: every consumer of the store imports one
// of these through this path, so the list is what a split may never quietly widen or narrow.
const FACADE_SURFACE = [
  'FLOW_LOCK_POLL_MS', 'FLOW_LOCK_SUFFIX', 'FLOW_LOCK_WAIT_MS', 'FLOW_STORE_BASENAME',
  'FLOW_STORE_STOP', 'SUBSET_ATTEMPT_DIAGNOSIS_REDS', 'SUBSET_ATTEMPT_MAX_REDS',
  'SUBSET_RUN_LOCK_INFIX', 'acquireSubsetRunLock', 'appendFlowRecord',
  'appendFlowRecordWithPreflight', 'appendSubsetAttempt', 'computeMaskedFingerprintPayload',
  'deriveFlowOwner', 'isAuthoritativeReferenceTarget', 'mintAdoption', 'mintBookkeepingDelta',
  'parseFlowStoreText', 'priorChainTerminal', 'probeFlowAppendLock', 'readFlowStore',
  'readPlanFrontmatterId', 'resolveFlowLockPath', 'resolveFlowStorePath', 'resolveRecordReference',
  'subsetAttemptState', 'subsetExhaustionRemedy', 'validateOpenerReference', 'walkChainState',
];

// The frozen LAYOUT beside the frozen surface: which module each facade name is re-exported FROM.
// Binding equality alone cannot show PROVENANCE — two modules can hold the same string constant, and
// a name re-exported from the wrong leaf would compare equal — so the facade's own
// `export { … } from '<module>'` statements are parsed and matched against this map by NAME.
const FACADE_OWNERS = {
  FLOW_STORE_STOP: 'flow-store-read.mjs',
  FLOW_STORE_BASENAME: 'flow-store-read.mjs',
  FLOW_LOCK_SUFFIX: 'flow-store-read.mjs',
  resolveFlowStorePath: 'flow-store-read.mjs',
  resolveFlowLockPath: 'flow-store-read.mjs',
  parseFlowStoreText: 'flow-store-read.mjs',
  readFlowStore: 'flow-store-read.mjs',
  deriveFlowOwner: 'flow-store-read.mjs',
  priorChainTerminal: 'flow-chain-state.mjs',
  walkChainState: 'flow-chain-state.mjs',
  resolveRecordReference: 'flow-chain-state.mjs',
  isAuthoritativeReferenceTarget: 'flow-chain-state.mjs',
  validateOpenerReference: 'flow-chain-state.mjs',
  SUBSET_ATTEMPT_MAX_REDS: 'flow-subset-budget.mjs',
  SUBSET_ATTEMPT_DIAGNOSIS_REDS: 'flow-subset-budget.mjs',
  subsetAttemptState: 'flow-subset-budget.mjs',
  subsetExhaustionRemedy: 'flow-subset-budget.mjs',
  FLOW_LOCK_WAIT_MS: 'flow-append.mjs',
  FLOW_LOCK_POLL_MS: 'flow-append.mjs',
  appendFlowRecord: 'flow-append.mjs',
  appendFlowRecordWithPreflight: 'flow-append.mjs',
  SUBSET_RUN_LOCK_INFIX: 'flow-append.mjs',
  acquireSubsetRunLock: 'flow-append.mjs',
  probeFlowAppendLock: 'flow-append.mjs',
  appendSubsetAttempt: 'flow-append.mjs',
  readPlanFrontmatterId: 'flow-adoption-mint.mjs',
  mintAdoption: 'flow-adoption-mint.mjs',
  computeMaskedFingerprintPayload: 'flow-delta-proof.mjs',
  mintBookkeepingDelta: 'flow-delta-proof.mjs',
};

// The ONE name a leaf exports that the facade deliberately does not: the budget gate crosses to the
// append leaf (D3) and stays off the store's public surface.
const OFF_SURFACE_LEAF_EXPORTS = ['flow-subset-budget.mjs#subsetAttemptGate'];

const loadTool = (name) => import(new URL(`../tools/${name}`, import.meta.url).href);
const readTool = (name) => readFileSync(resolve(TOOLS_DIR, name), 'utf8');

// The facade's own declaration of who owns what, read off its bytes.
const REEXPORT_RE = /export\s*\{([^}]*)\}\s*from\s*'\.\/([^']+)'/g;
const parseFacadeOwners = () => {
  const owners = {};
  for (const statement of readTool(FACADE).matchAll(REEXPORT_RE)) {
    for (const raw of statement[1].split(',')) {
      const name = raw.trim();
      if (name === '') continue;
      assert.equal(name.includes(' as '), false, `the facade must re-export ${name} under its own name — a rename forks the surface`);
      assert.equal(owners[name], undefined, `${name} is re-exported twice by the facade`);
      owners[name] = statement[2];
    }
  }
  return owners;
};

// The tools import graph, built inside a callback (never at module top — the loading rule above).
const toolsGraph = () => {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = resolve(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs')) files.push(p);
    }
  };
  walk(TOOLS_DIR);
  const edges = new Map();
  for (const f of files) {
    const deps = [];
    for (const m of readFileSync(f, 'utf8').matchAll(IMPORT_RE)) deps.push(resolve(dirname(f), m[1]));
    edges.set(f, deps);
  }
  return edges;
};

const relOf = (f) => relative(TOOLS_DIR, f).split(sep).join('/');

const closureOf = (edges, roots) => {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dep of edges.get(file) ?? []) queue.push(dep);
  }
  return new Set([...seen].map(relOf));
};

describe('the flow store layout — a facade over five leaves, pinned structurally', () => {
  it('facade-surface-frozen: the store re-exports EXACTLY the 29 declared names', async () => {
    const facade = await loadTool(FACADE);
    assert.deepEqual(Object.keys(facade).sort(), FACADE_SURFACE);
  });

  it('facade-bindings-are-the-leaves: every facade name is the leaf module\'s OWN binding, and the leaves cover the whole surface', async () => {
    const facade = await loadTool(FACADE);
    // Provenance FIRST, from the facade's own bytes: which leaf each name is declared to come from.
    // Without this a constant re-exported from the wrong module — same value, wrong owner — would
    // satisfy every binding comparison below.
    assert.deepEqual(Object.keys(FACADE_OWNERS).sort(), FACADE_SURFACE, 'the ownership map and the frozen surface must name the same 29');
    assert.deepEqual(parseFacadeOwners(), FACADE_OWNERS, 'the facade must re-export every name from its DECLARED owner leaf');
    const covered = new Set();
    for (const name of [READ_HALF, ...LEAVES]) {
      const mod = await loadTool(name);
      for (const [key, value] of Object.entries(mod)) {
        if (!FACADE_SURFACE.includes(key)) continue;
        assert.ok(!covered.has(key), `${key} is exported by two owners — a facade name has exactly ONE home`);
        assert.equal(value, facade[key], `${name} exports ${key}, so the facade must re-export THAT binding — a re-implementation would drift silently`);
        covered.add(key);
      }
    }
    assert.deepEqual([...covered].sort(), FACADE_SURFACE, 'the read half and the five leaves together must cover the whole facade surface — no name may come from anywhere else');
    // The reverse direction, over the FIVE NEW leaves only: flow-store-read.mjs keeps its own wider
    // pre-existing surface (flowStoreStop, gitLine and the four no-follow read names it re-exports
    // at flow-store-read.mjs:17-32), which the facade never carried and this case never judges.
    const offSurface = [];
    for (const name of LEAVES) {
      const mod = await loadTool(name);
      for (const key of Object.keys(mod)) if (!FACADE_SURFACE.includes(key)) offSurface.push(`${name}#${key}`);
    }
    assert.deepEqual(offSurface.sort(), OFF_SURFACE_LEAF_EXPORTS);
  });

  it('facade-carries-no-logic: every facade line is blank, a comment, or part of a re-export statement', () => {
    // Statement-level, not line-level: a statement runs from its first non-comment line to the line
    // that ends it, and EVERY statement must be a `export { … } from '<module>'`. A bare `import` is
    // logic too (a facade needs nothing for its own use), and so is `export { … };` without a from —
    // that form re-publishes a name the facade had to bind locally first.
    const RE_EXPORT = /^export\s*\{[^}]*\}\s*from\s*'\.\/[^']+';?$/;
    const offending = [];
    let open = null;
    readTool(FACADE).split('\n').forEach((line, i) => {
      const t = line.trim();
      if (open === null) {
        if (t === '' || t.startsWith('//')) return;
        open = { line: i + 1, text: t };
      } else {
        open.text += ` ${t}`;
      }
      if (!open.text.endsWith(';')) return;
      const statement = open.text.replace(/\s+/g, ' ');
      if (!RE_EXPORT.test(statement)) offending.push(`${open.line}: ${statement.slice(0, 120)}`);
      open = null;
    });
    assert.equal(open === null, true, `the statement opened at line ${open?.line} never terminates — the walk would swallow the rest of the file and go vacuous`);
    assert.deepEqual(offending, [], `${TOOLS_REL}/${FACADE} must be re-exports only — a const, a function body or a bare import means logic stayed behind in the facade`);
  });

  it('leaves-within-caps: the facade and all five leaves are inside the declared source-size defaults', () => {
    for (const name of [FACADE, ...LEAVES]) {
      const path = `${TOOLS_REL}/${name}`;
      const { lines, maxLineBytes } = measureFile(REPO_ROOT, path);
      assert.ok(lines <= SOURCE_SIZE_DEFAULTS.maxLines, `${path}: ${lines} lines exceeds ${SOURCE_SIZE_DEFAULTS.maxLines} — the split exists to keep every module holdable whole`);
      assert.ok(maxLineBytes <= SOURCE_SIZE_DEFAULTS.maxLineBytes, `${path}: longest line ${maxLineBytes} bytes exceeds ${SOURCE_SIZE_DEFAULTS.maxLineBytes}`);
    }
  });

  it('import-boundaries-one-way: the edges run facade → append → pure leaves, and no read root reaches a write leaf', () => {
    const edges = toolsGraph();
    const importsOf = (name) => {
      const deps = edges.get(resolve(TOOLS_DIR, name));
      assert.ok(deps != null, `${TOOLS_REL}/${name} must be a tools module`);
      return [...new Set(deps.map(relOf))];
    };

    // EXACTLY these, not merely at least these: an extra `export {} from './unrelated.mjs'` adds
    // coupling and an import-time side-effect channel while every case that only checks for the
    // required edges stays green.
    const facadeImports = importsOf(FACADE);
    assert.deepEqual(facadeImports.slice().sort(), [READ_HALF, ...LEAVES].slice().sort(), 'the facade imports EXACTLY the read half and the five leaves — it owns the whole public surface and nothing else');

    // The pure leaves are pure over read results: the record vocabulary is their ONLY tools sibling,
    // so nothing they hold can reach git, the lock, or the store's write door.
    for (const pure of PURE_LEAVES) {
      assert.deepEqual(importsOf(pure), ['flow-record.mjs'], `${pure} is PURE — its only tools sibling is the record vocabulary`);
    }

    const appendImports = importsOf(APPEND_LEAF);
    for (const pure of PURE_LEAVES) {
      assert.ok(appendImports.includes(pure), `${APPEND_LEAF} composes ${pure} — shared helpers live in the LOWER module`);
    }
    for (const mint of MINT_LEAVES) {
      assert.equal(appendImports.includes(mint), false, `${APPEND_LEAF} must never import ${mint} — the mints ride DOWN onto the one append door, never the reverse`);
    }

    for (const mint of MINT_LEAVES) {
      const mintImports = importsOf(mint);
      assert.ok(mintImports.includes(APPEND_LEAF), `${mint} mints through the ONE append door`);
      for (const other of MINT_LEAVES) {
        if (other !== mint) assert.equal(mintImports.includes(other), false, `${mint} must not import ${other} — a one-line helper is copied, never imported sideways`);
      }
    }

    for (const leaf of LEAVES) {
      assert.equal(importsOf(leaf).includes(FACADE), false, `${leaf} must never import the facade — that edge is the cycle read-graph-purity.test.mjs reds`);
    }

    // And the read surface stays structurally read-only across the split: the store's three WRITE
    // leaves are new modules read-graph-purity.test.mjs's own WRITE_MODULES list does not name.
    const readClosure = closureOf(edges, READ_ROOTS.map((r) => resolve(TOOLS_DIR, r)));
    const reached = WRITE_LEAVES.filter((w) => readClosure.has(w));
    assert.deepEqual(reached, [], `a read root reaches a write leaf — full closure: ${[...readClosure].sort().join(', ')}`);
  });
});
