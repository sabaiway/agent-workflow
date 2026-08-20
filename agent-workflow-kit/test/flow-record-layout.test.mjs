// flow-record-layout.test.mjs — the STRUCTURAL contract of the flow-record facade and the five
// leaves it composes (baseline-practices tranche 3). Single responsibility: what no single file can
// show — the frozen 29-name public surface, that every facade name IS the leaf's own binding, that
// the facade carries no logic at all, that every module stays inside the declared caps, and that the
// edges run ONE way (facade → legality → shape/identity → vocabulary, the manifest leaf beside
// them). Behaviour is characterized elsewhere: the owning suite (tools/flow-record.test.mjs, 58/58)
// stays BYTE-IDENTICAL across the split and is the bar for "the move changed nothing".
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

const FACADE = 'flow-record.mjs';
const VOCABULARY = 'flow-vocabulary.mjs';
const SHAPE = 'flow-record-shape.mjs';
const IDENTITY = 'flow-record-identity.mjs';
const LEGALITY = 'flow-legality.mjs';
const MANIFEST = 'flow-finding-manifest.mjs';
const LEAVES = [VOCABULARY, SHAPE, IDENTITY, LEGALITY, MANIFEST];

// "Pure form" is the module's own header claim (no fs, no git, no CLI, no side effects on import).
// These are the modules that would falsify it if one ever entered a leaf's closure: the three the
// read-graph suite already names, plus the store's write door and its two mints.
const WRITE_MODULES = [
  'atomic-write.mjs', 'flow-store.mjs', 'orchestration-write.mjs',
  'flow-append.mjs', 'flow-adoption-mint.mjs', 'flow-delta-proof.mjs',
];

// The frozen 29-name surface (plan D1), a LITERAL fixture: 16 runtime modules and 14 test files
// import the record vocabulary through this path, so the list is what a split may never quietly
// widen or narrow.
const FACADE_SURFACE = [
  'ALLOWED_TRANSITIONS', 'CHAIN_KIND', 'CHAIN_PURPOSES', 'DESIGN_SEED_ASSIGNMENT',
  'FINDING_MANIFEST_PREFIX', 'FLOW_KINDS', 'FLOW_SCHEMA_VERSION', 'GLOBAL_KINDS',
  'PLAN_LANE_PURPOSES', 'SAFE_NONCE_RE', 'STEP_SCOPED_PURPOSES', 'SUBSET_ATTEMPT_DIAGNOSIS_FROM',
  'TERMINAL_LANES', 'authoritativeFlowRecords', 'canonicalFlowDigest', 'decodeFindingManifest',
  'findingManifestBasename', 'flowCanonicalSerialization', 'flowProjectionHash', 'flowRecordKey',
  'flowTreeIdentity', 'isTransitionShaped', 'ownerScopedFlowProjection', 'subsetFoldBatchDigest',
  'subsetGateIdsDigest', 'validateChainSequence', 'validateFindingManifest', 'validateFlowRecord',
  'validateSupersessions',
];

// The frozen LAYOUT beside the frozen surface: which module each facade name is re-exported FROM.
// Binding equality alone cannot show PROVENANCE — two modules can hold the same frozen array, and a
// name re-exported from the wrong leaf would compare equal — so the facade's own
// `export { … } from '<module>'` statements are parsed and matched against this map by NAME.
const FACADE_OWNERS = {
  FLOW_SCHEMA_VERSION: VOCABULARY,
  CHAIN_KIND: VOCABULARY,
  CHAIN_PURPOSES: VOCABULARY,
  STEP_SCOPED_PURPOSES: VOCABULARY,
  PLAN_LANE_PURPOSES: VOCABULARY,
  GLOBAL_KINDS: VOCABULARY,
  FLOW_KINDS: VOCABULARY,
  TERMINAL_LANES: VOCABULARY,
  DESIGN_SEED_ASSIGNMENT: VOCABULARY,
  ALLOWED_TRANSITIONS: VOCABULARY,
  SUBSET_ATTEMPT_DIAGNOSIS_FROM: SHAPE,
  validateFlowRecord: SHAPE,
  flowRecordKey: IDENTITY,
  authoritativeFlowRecords: IDENTITY,
  isTransitionShaped: IDENTITY,
  flowTreeIdentity: IDENTITY,
  flowCanonicalSerialization: IDENTITY,
  canonicalFlowDigest: IDENTITY,
  subsetFoldBatchDigest: IDENTITY,
  subsetGateIdsDigest: IDENTITY,
  ownerScopedFlowProjection: IDENTITY,
  flowProjectionHash: IDENTITY,
  validateChainSequence: LEGALITY,
  validateSupersessions: LEGALITY,
  SAFE_NONCE_RE: MANIFEST,
  FINDING_MANIFEST_PREFIX: MANIFEST,
  findingManifestBasename: MANIFEST,
  validateFindingManifest: MANIFEST,
  decodeFindingManifest: MANIFEST,
};

// The five names a leaf exports that the facade deliberately does not (D3): the shared form bindings
// every validator states its refusals in live in the LOWEST leaf and are exported OFF the public
// surface, so the shape, manifest and legality leaves take them by reference and no copy can drift.
// Pinned EXACTLY, in both directions — the off-surface set may never widen unnoticed either.
const OFF_SURFACE_LEAF_EXPORTS = [
  'flow-vocabulary.mjs#HEX64_RE',
  'flow-vocabulary.mjs#isHex64',
  'flow-vocabulary.mjs#isNonEmptyString',
  'flow-vocabulary.mjs#isPlainObject',
  'flow-vocabulary.mjs#refuse',
];

// The whole import graph of the family, EXACTLY (each list sorted). Not "at least these": an extra
// edge adds coupling and an import-time side-effect channel while every check that only looks for
// the required edges stays green.
const EXPECTED_EDGES = {
  [FACADE]: [MANIFEST, LEGALITY, IDENTITY, SHAPE, VOCABULARY].slice().sort(),
  [LEGALITY]: [IDENTITY, SHAPE, VOCABULARY].slice().sort(),
  [SHAPE]: [VOCABULARY, 'repo-lex.mjs'].slice().sort(),
  [IDENTITY]: [VOCABULARY],
  [MANIFEST]: [VOCABULARY],
  [VOCABULARY]: ['orchestration-config.mjs'],
};

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

describe('the flow record layout — a facade over five leaves, pinned structurally', () => {
  it('facade-surface-frozen: the record module re-exports EXACTLY the 29 declared names', async () => {
    const facade = await loadTool(FACADE);
    assert.deepEqual(Object.keys(facade).sort(), FACADE_SURFACE);
  });

  it('facade-bindings-are-the-leaves: every facade name is the leaf\'s OWN binding, declared by the facade\'s own bytes, and the leaves cover the whole surface', async () => {
    const facade = await loadTool(FACADE);
    // Provenance FIRST, from the facade's own bytes: which leaf each name is declared to come from.
    // Without this a constant re-exported from the wrong module — same value, wrong owner — would
    // satisfy every binding comparison below.
    assert.deepEqual(Object.keys(FACADE_OWNERS).sort(), FACADE_SURFACE, 'the ownership map and the frozen surface must name the same 29');
    assert.deepEqual(parseFacadeOwners(), FACADE_OWNERS, 'the facade must re-export every name from its DECLARED owner leaf');
    const covered = new Set();
    for (const name of LEAVES) {
      const mod = await loadTool(name);
      for (const [key, value] of Object.entries(mod)) {
        if (!FACADE_SURFACE.includes(key)) continue;
        assert.ok(!covered.has(key), `${key} is exported by two owners — a facade name has exactly ONE home`);
        assert.equal(value, facade[key], `${name} exports ${key}, so the facade must re-export THAT binding — a re-implementation would drift silently`);
        covered.add(key);
      }
    }
    assert.deepEqual([...covered].sort(), FACADE_SURFACE, 'the five leaves together must cover the whole facade surface — no name may come from anywhere else');
    // The reverse direction: the ONLY names the leaves export beyond the public surface are the five
    // shared form bindings of D3, and they live on the LOWEST leaf.
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

  it('import-boundaries-one-way: the edges run facade to legality to shape and identity to vocabulary, the manifest leaf sits beside them, and no leaf reaches a write module', () => {
    const edges = toolsGraph();
    const importsOf = (name) => {
      const deps = edges.get(resolve(TOOLS_DIR, name));
      assert.ok(deps != null, `${TOOLS_REL}/${name} must be a tools module`);
      return [...new Set(deps.map(relOf))];
    };

    // EXACTLY these, module by module: the whole import graph of the family is the pin, because the
    // DIRECTION of the edges is what makes this a decomposition rather than the same coupling spread
    // thinner, and no single file can show it.
    for (const [name, expected] of Object.entries(EXPECTED_EDGES)) {
      assert.deepEqual(importsOf(name).sort(), expected, `${name} must import EXACTLY ${expected.join(', ')}`);
    }

    for (const leaf of LEAVES) {
      assert.equal(importsOf(leaf).includes(FACADE), false, `${leaf} must never import the facade — that edge is the cycle read-graph-purity.test.mjs reds`);
    }

    // And the "pure form" claim becomes structural: no leaf's transitive closure holds a module that
    // writes — not the store's own door, not a mint, not the atomic writer underneath them.
    for (const leaf of LEAVES) {
      const closure = closureOf(edges, [resolve(TOOLS_DIR, leaf)]);
      const reached = WRITE_MODULES.filter((w) => closure.has(w));
      assert.deepEqual(reached, [], `${leaf} reaches a write module — full closure: ${[...closure].sort().join(', ')}`);
    }
  });
});
