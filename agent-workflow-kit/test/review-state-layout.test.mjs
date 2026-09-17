import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as facade from '../tools/review-state.mjs';
import * as plans from '../tools/plan-files.mjs';
import * as lexical from '../tools/repo-lex.mjs';
import * as evidence from '../tools/core-evidence.mjs';
import * as recipes from '../tools/recipes.mjs';

const TOOLS = new URL('../tools/', import.meta.url);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FACADE = fileURLToPath(new URL('review-state.mjs', TOOLS));
const leaves = {
  judge: await import('../tools/review-state-judge.mjs').catch(() => null),
  build: await import('../tools/review-state-build.mjs').catch(() => null),
  flow: await import('../tools/review-state-flow.mjs').catch(() => null),
  render: await import('../tools/review-state-render.mjs').catch(() => null),
  await: await import('../tools/review-state-await.mjs').catch(() => null),
};
const leafNames = Object.keys(leaves);
const getLeafSpecifier = (name) => `./review-state-${name}.mjs`;
const getToolPath = (name) => fileURLToPath(new URL(name, TOOLS));
const readSource = (file) => readFileSync(file, 'utf8');
const source = readSource(FACADE);
const header = source.slice(0, source.search(/^import /m));
const allowed = [
  'node:fs', 'node:path', 'node:url', 'node:child_process', 'node:crypto',
  './detect-backends.mjs', './direct-run.mjs', './recipes.mjs', './orchestration-config.mjs',
  './flow-store.mjs', './flow-record.mjs', './flow-check.mjs', './plan-files.mjs', './repo-lex.mjs',
  './git-env.mjs', './dispatch-store-read.mjs', './held-session.mjs', './core-evidence.mjs',
];
const homes = [
  ['./plan-files.mjs', plans, 'PLANS_REL isScratchPlanName plansInFlight'],
  ['./repo-lex.mjs', lexical, 'shellQuoteArg'],
  ['./core-evidence.mjs', evidence, 'RECEIPTS_BASENAME computeFingerprintPayload computeTreeFingerprint isTreeClean isNeverCommittableStat resolveReceiptsPath readReceipts'],
  ['./recipes.mjs', recipes, 'requiredBackendsForConfiguredRecipe'],
  [getLeafSpecifier('judge'), leaves.judge, 'CLEAN_TREE_PASS LATENT_ARM_NOTICE quoteReportName backendReceiptStatus degradeRecordSet selectHeldSessionDegrades shouldReadHeldSession buildHeldSessionState decideCheck'],
  [getLeafSpecifier('build'), leaves.build, 'countNeverCommittableUntracked buildState'],
  [getLeafSpecifier('flow'), leaves.flow, 'computePlanAdoptionCoverage'],
  [getLeafSpecifier('await'), leaves.await, 'DEFAULT_AWAIT_TIMEOUT_S AWAIT_POLL_MS mainAwait'],
];
const getSpecifiers = (text) => [
  ...text.matchAll(/^\s*(?:import|export)\s+(?:[^;'"`]*?\s+from\s*)?['"]([^'"\n]+)['"]/gm),
  ...text.matchAll(/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g),
].map((match) => match[1]);
const getClosure = (file, seen = new Set()) => {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const specifier of getSpecifiers(readSource(file))) {
    if (!specifier.startsWith('.')) continue;
    const dependency = resolve(dirname(file), specifier);
    if (existsSync(dependency)) getClosure(dependency, seen);
  }
  return seen;
};
const getModules = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  if (entry.name === 'node_modules') return [];
  const file = join(directory, entry.name);
  return entry.isDirectory() ? getModules(file) : entry.name.endsWith('.mjs') ? [file] : [];
});
const getLeafSource = (name) => {
  assert.ok(leaves[name], `absent: review-state-${name}.mjs`);
  return readSource(getToolPath(getLeafSpecifier(name)));
};

describe('facade bindings — spec:review-state/S1', () => {
  it('exports exactly the 28 historical names', () => {
    assert.deepEqual(Object.keys(facade).sort(), ['main', ...homes.flatMap(([, , names]) => names.split(' '))].sort());
  });
  for (const [specifier, home, names] of homes) {
    it(`keeps identical bindings from ${specifier}`, () => {
      assert.ok(home, `absent: ${specifier}`);
      const statements = [...source.matchAll(/^(?:import|export)\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gm)];
      for (const name of names.split(' ')) {
        assert.equal(facade[name], home[name], name);
        assert.ok(statements.some(([, bindings, path]) => path === specifier
          && bindings.split(',').some((binding) => binding.trim().split(/\s+as\s+/).at(-1) === name)), name);
      }
    });
  }
  it('defines main in the facade', () => {
    assert.match(source, /^export\s+(?:const|function)\s+main\b/m);
  });
  for (const name of leafNames) {
    it(`${name} defines every export without re-exporting`, () => {
      const text = getLeafSource(name);
      assert.doesNotMatch(text, /\bexport\s*\{/);
      for (const binding of Object.keys(leaves[name])) {
        assert.match(text, new RegExp(`^export\\s+(?:const|let|function|async\\s+function|class)\\s+${binding}\\b`, 'm'));
      }
    });
  }
});

describe('facade delegates decisions — spec:review-state/S2', () => {
  it('declares only the four command-line entries', () => {
    const declarations = [...source.matchAll(/^(?:export\s+)?(?:const|let|var|function|async\s+function|class)\s+(\w+)/gm)];
    assert.deepEqual(declarations.map((match) => match[1]).sort(), ['HELP', 'KNOWN_ARGS', 'emitResult', 'main']);
  });
  it('imports all five leaves and only allowed existing modules', () => {
    const specifiers = getSpecifiers(source);
    const siblings = leafNames.map(getLeafSpecifier);
    assert.deepEqual([...new Set(specifiers.filter((path) => !allowed.includes(path)))].sort(), siblings.sort());
  });
  const state = {
    obligations: { recipe: 'council', source: 'config', perBackend: true }, requiredBackends: ['codex', 'agy'],
    detectionWarning: null, plans: ['active-plan.md'], location: { state: 'work-tree' },
    fingerprint: 'f'.repeat(64), clean: false, heldSession: null, receiptsPath: '/repo/.git/receipts.jsonl',
    receiptCount: 1, malformed: 0, receiptsReadError: null, evidenceUnavailable: false, degradedExempt: [],
    backends: [
      { backend: 'codex', state: 'current', verdict: 'ship', shipClass: true, grounded: true, timestamp: '2026-07-03T12:00:00Z', probeExcluded: 0, markerRejected: 0, unmarkedRejected: 0 },
      { backend: 'agy', state: 'missing', verdict: null, shipClass: false, grounded: null, timestamp: null, probeExcluded: 0, markerRejected: 0, unmarkedRejected: 0 },
    ],
    maskedUntracked: 0, root: '/repo',
  };
  for (const [label, input] of [['dirty', state], ['clean', { ...state, clean: true }], ['no plans', { ...state, plans: [] }]]) {
    it(`returns the judge decision verbatim for ${label}`, () => {
      assert.ok(leaves.judge, 'absent: review-state-judge.mjs');
      const check = leaves.judge.decideCheck(input);
      const result = facade.main(['--check'], { buildState: () => input });
      assert.equal(result.code, check.code);
      assert.equal(result.stdout, `review-state check: ${check.code === 0 ? 'PASS' : 'FAIL'} — ${check.reason}`);
      assert.equal(facade.main(['--json'], { buildState: () => input }).stdout, JSON.stringify({ ...input, check }, null, 2));
    });
  }
});

describe('normative header has one home — spec:review-state/S3', () => {
  const openings = [
    'exit contract (the single home of this list', 'Selection is LATEST-NORMAL-FIRST',
    'The fingerprint is the ONE canonical', 'Phase-2 flow arms (flow-orchestration Plan 3',
    'HUMAN residual (accepted, documented)',
  ];
  it('keeps the header byte count and sha256', () => {
    assert.equal(Buffer.byteLength(header), 8535);
    assert.equal(createHash('sha256').update(header).digest('hex'), '25255899d1b4c00eef387c70cd2495e5f659d88b21126678c07cf2d5caa5705f');
  });
  it('keeps each opening once in the facade and inside its header', () => {
    for (const opening of openings) {
      assert.equal(source.split(opening).length - 1, 1, opening);
      assert.equal(header.split(opening).length - 1, 1, opening);
    }
  });
  for (const name of leafNames) {
    it(`${name} does not repeat a header opening`, () => {
      const text = getLeafSource(name);
      for (const opening of openings) assert.equal(text.includes(opening), false, opening);
    });
  }
});

describe('closed leaf graph — spec:review-state/S4', () => {
  const edges = { judge: [], flow: [], build: ['judge', 'flow'], render: ['judge'], await: ['judge', 'build'] };
  for (const name of leafNames) {
    it(`${name} has only its declared edges and never reaches the facade`, () => {
      const text = getLeafSource(name);
      const specifiers = [...new Set(getSpecifiers(text))];
      const siblings = specifiers.filter((path) => path.startsWith('./review-state-'));
      assert.deepEqual(siblings.sort(), edges[name].map(getLeafSpecifier).sort());
      for (const path of specifiers) assert.ok(siblings.includes(path) || allowed.includes(path), path);
      assert.equal(specifiers.includes('node:child_process'), name === 'build');
      assert.equal(getClosure(getToolPath(getLeafSpecifier(name))).has(FACADE), false);
      assert.doesNotMatch(text, /createRequire|\brequire\s*\(/);
    });
  }
});

describe('side suites retain facade imports and markers — spec:review-state/S10', () => {
  const suites = [
    ['held-session', 'held-session', [2, 3, 9]], ['task-chain', 'task-thread', [4]],
    ['task-execute', 'carriers', [19]], ['roster', 'review-roster', [10]], ['hostile', 'control-bytes', [7]],
  ];
  for (const [name, spec, scenarios] of suites) {
    it(`${name} retains its facade import and scenario bindings`, () => {
      const text = readSource(getToolPath(`review-state-${name}.test.mjs`));
      assert.ok(getSpecifiers(text).includes('./review-state.mjs'));
      for (const scenario of scenarios) assert.ok(text.includes('spec:' + spec + '/S' + scenario));
    });
  }
});

describe('leaves are library-only and private — spec:review-state/S12', () => {
  for (const name of leafNames) {
    it(`${name} has no dispatch or import output`, () => {
      assert.doesNotMatch(getLeafSource(name), /isDirectRun|process\.argv|import\.meta\.main/);
      const url = new URL(getLeafSpecifier(name), TOOLS).href;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`]);
      assert.equal(child.status, 0, child.error?.message ?? child.stderr?.toString());
      assert.equal(child.stdout.toString(), '');
      assert.equal(child.stderr.toString(), '');
    });
    it(`${name} suite never reaches the facade, including through its harness`, () => {
      assert.equal(getClosure(getToolPath(`review-state-${name}.test.mjs`)).has(FACADE), false);
    });
  }
  it('keeps every external consumer on the facade', () => {
    const leafFiles = leafNames.map((name) => getToolPath(getLeafSpecifier(name)));
    const permitted = new Set([FACADE, fileURLToPath(import.meta.url), ...leafFiles,
      ...leafNames.map((name) => getToolPath(`review-state-${name}.test.mjs`))]);
    const filenames = leafFiles.map((file) => basename(file));
    for (const packageName of ['agent-workflow-kit', 'agent-workflow-engine', 'agent-workflow-memory']) {
      for (const file of getModules(join(ROOT, packageName))) {
        if (permitted.has(file)) continue;
        for (const specifier of getSpecifiers(readSource(file))) {
          assert.equal(filenames.includes(basename(specifier)), false, `${file}: ${specifier}`);
        }
      }
    }
  });
});

describe('--json key order (D34)', () => {
  it('preserves the 33 keys in a non-git directory', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'review-state-layout-'));
    try {
      const result = facade.main(['--json'], { cwd, env: {}, detect: () => [] });
      assert.deepEqual(Object.keys(JSON.parse(result.stdout)), [
        'resolved', 'configSource', 'obligations', 'requiredBackends', 'backends', 'plans', 'root', 'rootAnchored',
        'location', 'fingerprint', 'clean', 'receiptsPath', 'receiptCount', 'malformed', 'receiptsReadError', 'base',
        'evidenceStorePath', 'evidenceMalformed', 'evidenceReadError', 'evidenceUnavailable', 'degradedExempt',
        'heldSession', 'maskedUntracked', 'detectionWarning', 'flowPresent', 'flowArmed', 'flowBrokenReason',
        'flowOwner', 'planCoverage', 'attestedPlanIds', 'lensRefusedAttestations', 'soloVetoRows', 'check',
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
