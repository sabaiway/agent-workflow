import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKER_CLAIM, classifyCheckerClaim } from './checker-claim.mjs';
import { LIBRARY_ONLY_MODULES, libraryOnlyLine } from './direct-run.mjs';
import { escapeForLine } from './source-size-core.mjs';
import { KIT_TOOLS, failAt, makeProject, runVerb } from './checker-gates.test/harness.test.mjs';

const loaded = await import('./checker-gates-read.mjs').catch(() => ({}));
const declaration = await import('./gates-declaration.mjs').catch(() => ({}));
const gaps = await import('./profile-gaps.mjs').catch(() => ({}));
const need = (name) => {
  if (loaded[name] === undefined) throw new Error(`checker-gates-read.mjs ${name} is absent`);
  return loaded[name];
};
const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, 'checker-gates-read.mjs');
const PURITY_TEST = join(HERE, '..', 'test', 'read-graph-purity.test.mjs');
const IMPORT_RE = /(?:^|\n)\s*(?:import\s[^'"]*?|export\s[^'"]*?from\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const WRITE_MODULES_RE = /const WRITE_MODULES = \[([^\]]*)\]/;
const GATES = 'docs/ai/gates.json';
const IDS = ['control-bytes', 'plan-shape', 'spec-check', 'spec-coverage'];
const TITLES = {
  'control-bytes': 'No raw control byte in the work tree',
  'plan-shape': 'Plans in flight keep the structural planning shape',
  'spec-check': 'Feature-spec store structure — the whole store',
  'spec-coverage': 'No work without a specification — every in-scope tool is governed by a contract, or named in the shrink-only debt',
};
const TAILS = { 'control-bytes': '--check', 'plan-shape': '--check --in-flight', 'spec-check': '--all', 'spec-coverage': '--check' };
const PROBED = { git: { kind: 'directory' }, storeRoot: '# Specs\n', scope: '{}\n' };
const COVERAGE_CHECK = join(dirname(KIT_TOOLS['plan-shape']), 'coverage-check.mjs');
const INVALID_UTF8 = Buffer.from([0x7b, 0xa0, 0x7d]);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const cmdOf = (id) => `node "${KIT_TOOLS[id]}" ${TAILS[id]}`;
const gate = (id, cmd, extra = {}) => ({ id, title: id, cmd, ...extra });
const PRODUCER = gate('unit-tests', 'npm test', { lcovProducer: true });
const CHECKER = gate('coverage-check', `node "${COVERAGE_CHECK}" --check`);

const judge = (options, extraDeps = () => ({})) => {
  const { root, base } = makeProject(options);
  const deps = extraDeps(root, base);
  return { root, base, deps, judged: need('judgeCheckerGates')(root, deps) };
};
const candidateOf = (judged, id) => {
  assert.ok(Array.isArray(judged.candidates), `no candidates: ${JSON.stringify(judged)}`);
  return judged.candidates.find((candidate) => candidate.id === id);
};
const bytesOf = (root) => {
  try {
    return readFileSync(join(root, GATES));
  } catch (error) {
    return error.code;
  }
};
const statesOf = (judged) => IDS.map((id) => candidateOf(judged, id).state);
const detectorOf = () => {
  const entry = (gaps.PROFILE_GAPS ?? []).find(({ id }) => id === 'checker-gates-declared');
  assert.ok(entry, 'PROFILE_GAPS carries checker-gates-declared');
  return entry.detect;
};
const claimsOf = () => {
  assert.ok(Array.isArray(declaration.KIT_CHECKER_CLAIMS), 'gates-declaration.mjs KIT_CHECKER_CLAIMS is absent');
  return declaration.KIT_CHECKER_CLAIMS;
};

describe('spec:checker-gates/S1 the candidate table is frozen and pairs with the claim table', () => {
  it('holds exactly the four ids in table order, each a frozen { id, title, probe }', () => {
    const table = need('CHECKER_GATE_CANDIDATES');
    assert.ok(Object.isFrozen(table));
    assert.deepEqual(table.map(({ id }) => id), IDS);
    for (const entry of table) {
      assert.ok(Object.isFrozen(entry), entry.id);
      assert.deepEqual(Reflect.ownKeys(entry).sort(), ['id', 'probe', 'title']);
      assert.equal(entry.title, TITLES[entry.id]);
      assert.equal(typeof entry.probe, 'function');
    }
  });

  it('carries the ids of KIT_CHECKER_CLAIMS in the same order', () => {
    assert.deepEqual(need('CHECKER_GATE_CANDIDATES').map(({ id }) => id), claimsOf().map(({ id }) => id));
  });

  it('renders each offered entry as node, the double-quoted canonical path and its tail, canonical against its own screen', () => {
    const { root, judged } = judge({ ...PROBED, gates: [] });
    assert.deepEqual(statesOf(judged), ['offered', 'offered', 'offered', 'offered']);
    for (const claim of claimsOf()) {
      const candidate = candidateOf(judged, claim.id);
      assert.deepEqual(Object.keys(candidate).sort(), ['entry', 'id', 'state']);
      const entry = JSON.parse(candidate.entry);
      assert.deepEqual(Object.keys(entry), ['id', 'title', 'cmd']);
      assert.deepEqual(entry, { id: claim.id, title: TITLES[claim.id], cmd: cmdOf(claim.id) });
      assert.equal(entry.cmd, `node "${claim.screen.canonical}" ${claim.tail}`);
      assert.equal(classifyCheckerClaim(claim.screen, entry.cmd, root), CHECKER_CLAIM.CANONICAL, claim.id);
    }
  });

  it('answers { declaration, candidates } in table order, the loaded declaration carrying its _README', () => {
    const { judged } = judge({ ...PROBED, gates: [gate('lint', 'npm run lint')] });
    assert.deepEqual(Object.keys(judged).sort(), ['candidates', 'declaration']);
    assert.deepEqual(judged.candidates.map(({ id }) => id), IDS);
    assert.deepEqual(judged.declaration, { readme: 'The fixture declaration.', gates: [gate('lint', 'npm run lint')] });
  });

  it('reaches no write module through its import closure', () => {
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
    const names = [...seen].map((file) => file.slice(HERE.length + 1));
    assert.ok(names.includes('gates-declaration.mjs'), names.join(', '));
    assert.deepEqual(names.filter((name) => writers.includes(name)), []);
  });
});

describe('the read leaf has no CLI', () => {
  it('is library-only: a direct run points at the upgrade command and exits 2', () => {
    assert.equal(LIBRARY_ONLY_MODULES['checker-gates-read.mjs'], '/agent-workflow-kit upgrade');
    const run = spawnSync(process.execPath, [MODULE], { encoding: 'utf8' });
    assert.equal(run.status, 2, run.stderr);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr.trim(), libraryOnlyLine('checker-gates-read.mjs'));
  });
});

describe('spec:checker-gates/S4 a candidate is declared under any id', () => {
  it('counts a canonical claim under another id as declared, with no entry and no detail', () => {
    const { judged } = judge({ ...PROBED, gates: [gate('my-plans', cmdOf('plan-shape'))] });
    assert.deepEqual(candidateOf(judged, 'plan-shape'), { id: 'plan-shape', state: 'declared', entry: null });
    assert.deepEqual(statesOf(judged), ['offered', 'declared', 'offered', 'offered']);
  });

  it('counts a tool-elsewhere copy as declared: a relative repo-copy path', () => {
    const cmd = 'node vendor/tools/spec-check-cli.mjs --all';
    const { root, judged } = judge({ ...PROBED, gates: [gate('store', cmd)], files: { 'vendor/tools/spec-check-cli.mjs': '// a copy\n' } });
    assert.equal(classifyCheckerClaim(claimsOf()[2].screen, cmd, root), CHECKER_CLAIM.ELSEWHERE);
    assert.equal(candidateOf(judged, 'spec-check').state, 'declared');
  });

  it('judges the claim with the tail of the candidate: another tail or a masked one is no claim', () => {
    const gates = [gate('a', `node "${KIT_TOOLS['plan-shape']}" --check`), gate('b', `${cmdOf('spec-check')} --help`)];
    const { judged } = judge({ ...PROBED, gates });
    assert.deepEqual(statesOf(judged), ['offered', 'offered', 'offered', 'offered']);
  });

  it('answers id-taken for a gate carrying the id while not the tool, its cmd the detail', () => {
    const { judged } = judge({ ...PROBED, gates: [gate('control-bytes', 'npm run bytes')] });
    assert.deepEqual(candidateOf(judged, 'control-bytes'), { id: 'control-bytes', state: 'id-taken', entry: null, detail: 'npm run bytes' });
  });

  it('lets declared win over id-taken', () => {
    const { judged } = judge({ ...PROBED, gates: [gate('spec-check', 'echo spec'), gate('mine', cmdOf('spec-check'))] });
    assert.equal(candidateOf(judged, 'spec-check').state, 'declared');
  });

  it('never writes an id-taken candidate', async () => {
    const { root } = makeProject({ ...PROBED, gates: [gate('control-bytes', 'npm run bytes')] });
    const run = await runVerb(root, ['--apply']);
    assert.equal(run.code, 0, run.stderr);
    assert.ok(run.lines.includes('control-bytes: id-taken — npm run bytes'), run.stdout);
    const written = JSON.parse(readFileSync(join(root, GATES), 'utf8')).gates;
    assert.deepEqual(written.map(({ id }) => id), ['control-bytes', 'plan-shape', 'spec-check', 'spec-coverage']);
    assert.deepEqual(written[0], gate('control-bytes', 'npm run bytes'));
  });
});

describe('spec:checker-gates/S5 an unrenderable kit path withholds what would be offered', () => {
  for (const [label, dirOf] of [
    ['a double quote', (base) => join(base, 'kit"tools')],
    ['a line separator', (base) => join(base, `kit${LINE_SEPARATOR}tools`)],
  ]) {
    it(`turns every would-be offer withheld over a path carrying ${label}, the escaped path named once`, () => {
      const { deps, judged } = judge({ ...PROBED, gates: [] }, (root, base) => ({ kitToolsDir: dirOf(base) }));
      assert.deepEqual(statesOf(judged), ['withheld', 'withheld', 'withheld', 'withheld']);
      assert.ok(judged.candidates.every(({ entry }) => entry === null));
      const named = judged.candidates.filter(({ detail }) => detail !== undefined);
      assert.equal(named.length, 1);
      assert.ok(named[0].detail.includes(escapeForLine(deps.kitToolsDir)), named[0].detail);
    });
  }

  it('keeps a declared, id-taken, not-applicable or probe-unreadable candidate in its own state', () => {
    const { judged } = judge(
      { git: { kind: 'directory' }, scope: '{}\n', gates: [gate('control-bytes', 'npm run bytes'), gate('mine', cmdOf('plan-shape'))] },
      (root, base) => ({ kitToolsDir: join(base, 'kit"tools'), ...failAt(root, 'lstatSync', 'docs/ai/spec-coverage.json') }),
    );
    assert.deepEqual(statesOf(judged), ['id-taken', 'declared', 'not-applicable', 'probe-unreadable']);
  });

  it('names the withheld path once at exit 0 and writes nothing, --apply included', async () => {
    const { root, base } = makeProject({ ...PROBED, gates: [] });
    const before = readFileSync(join(root, GATES));
    const kitToolsDir = join(base, 'kit"tools');
    const run = await runVerb(root, ['--apply'], { kitToolsDir });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.writes, []);
    assert.deepEqual(readFileSync(join(root, GATES)), before);
    assert.equal(run.stdout.split(escapeForLine(kitToolsDir)).length, 2, run.stdout);
    assert.ok(run.lines.includes('plan-shape: withheld'), run.stdout);
  });
});

describe('spec:checker-gates/S6 each declaration state answers by its one name', () => {
  const CASES = [
    ['declaration-absent', 'no file', {}],
    ['declaration-symlink', 'a symlink', { gates: { kind: 'symlink', text: '{ "gates": [] }\n' } }],
    ['declaration-not-regular', 'a directory', { gates: { kind: 'directory' } }],
    ['declaration-unreadable', 'bytes that are not UTF-8', { gates: INVALID_UTF8 }],
    ['declaration-unreadable', 'a failed open', { gates: [] }, (root) => failAt(root, 'open', GATES)],
    ['declaration-malformed', 'not strict JSON', { gates: '{ "gates": [' }],
    ['declaration-invalid', 'a validator refusal', { gates: '{ "gates": [{ "id": "Not Kebab", "title": "t", "cmd": "c" }] }\n' }],
    ['declaration-coverage-defect', 'an inert checker', { gates: [CHECKER] }],
    ['declaration-coverage-defect', 'a misplaced checker', { gates: [PRODUCER, CHECKER, gate('lint', 'npm run lint')] }],
    ['declaration-coverage-defect', 'a doubled checker', { gates: [PRODUCER, CHECKER, { ...CHECKER, id: 'coverage-again' }] }],
  ];
  for (const [name, label, options, extraDeps = () => ({})] of CASES) {
    it(`answers ${name} for ${label} from the derivation, the verb and the detector, nothing written`, async () => {
      const { root, deps, judged } = judge({ ...PROBED, ...options }, extraDeps);
      assert.equal(judged.refusal, name);
      const before = bytesOf(root);
      for (const args of [[], ['--apply']]) {
        const run = await runVerb(root, args, deps);
        assert.equal(run.code, 1, `${args}: ${run.stdout}`);
        assert.equal(run.stdout, '');
        assert.match(run.stderr, new RegExp(`\\b${name}\\b`));
        assert.deepEqual(run.writes, []);
      }
      assert.deepEqual(bytesOf(root), before);
      assert.deepEqual(detectorOf()({ root, deps }), { verdict: 'undecidable', reason: name });
    });
  }

  it('judges the deployment chain first: no-deployment for a symlinked, a regular-file or an unreadable docs/ai', async () => {
    assert.equal(judge({ docsAi: 'symlink' }).judged.refusal, 'no-deployment');
    assert.equal(judge({ docsAi: 'file' }).judged.refusal, 'no-deployment');
    assert.equal(judge({ gates: [] }, (root) => failAt(root, 'lstatSync', 'docs', 'EIO')).judged.refusal, 'no-deployment');
    for (const docsAi of ['absent', 'symlink']) {
      for (const args of [[], ['--apply']]) {
        const run = await runVerb(makeProject({ docsAi }).root, args);
        assert.equal(run.code, 1, run.stdout);
        assert.match(run.stderr, /\bno-deployment\b/);
        assert.deepEqual(run.writes, []);
      }
    }
  });
});
