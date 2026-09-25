import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverageDeclarationDefects, validateDeclaration } from '../gates-declaration.mjs';
import { placeEntries } from '../gates-init.mjs';
import { KIT_TOOLS, failAt, makeProject, runVerb } from './harness.test.mjs';

const loaded = await import('../checker-gates.mjs').catch(() => ({}));
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, '..', 'checker-gates.mjs');
const GATES = 'docs/ai/gates.json';
const LF = String.fromCharCode(10);
const IDS = ['control-bytes', 'plan-shape', 'spec-check', 'spec-coverage'];
const PROBED = { git: { kind: 'directory' }, storeRoot: '# Specs\n', scope: '{}\n' };
const COVERAGE_CHECK = join(dirname(KIT_TOOLS['plan-shape']), 'coverage-check.mjs');
const gate = (id, cmd, extra = {}) => ({ id, title: id, cmd, ...extra });
const LINT = gate('lint', 'npm run lint');
const PRODUCER = gate('unit-tests', 'npm test', { lcovProducer: true });
const CHECKER = gate('coverage-check', `node "${COVERAGE_CHECK}" --check`);
const serialize = (declaration) => `${JSON.stringify(declaration, null, 2)}${LF}`;
const bytesOf = (root) => readFileSync(join(root, GATES));
const parsedOf = (root) => JSON.parse(bytesOf(root));
const merge = (...args) => {
  assert.equal(typeof loaded.mergeCheckerGates, 'function', 'checker-gates.mjs mergeCheckerGates is absent');
  return loaded.mergeCheckerGates(...args);
};
// The entries one full --apply writes, read back from its own declaration: the leaf's suite pins
// their bytes, this suite pins where and how they land.
const writtenEntries = async () => {
  const { root } = makeProject({ ...PROBED, gates: [] });
  const run = await runVerb(root, ['--apply']);
  assert.equal(run.code, 0, run.stderr);
  return parsedOf(root).gates;
};

describe('spec:checker-gates/S7 --apply writes exactly the offered entries, add-only and placed', () => {
  it('appends every offered entry after the existing ones, keeping the _README, through one atomic temp and rename', async () => {
    const entries = await writtenEntries();
    assert.deepEqual(entries.map(({ id }) => id), IDS);
    const { root } = makeProject({ ...PROBED, gates: '{ "_README": "keep me", "gates": [{ "id": "lint", "title": "lint", "cmd": "npm run lint" }] }' });
    const run = await runVerb(root, ['--apply']);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(bytesOf(root).toString('utf8'), serialize({ _README: 'keep me', gates: [LINT, ...entries] }));
    assert.doesNotThrow(() => validateDeclaration(parsedOf(root)));
    assert.deepEqual(run.writes.map(([name]) => name), ['writeFile', 'rename']);
    assert.match(run.writes[0][1], /gates\.json\.[^/]+\.tmp$/);
    assert.equal(run.writes[1][2], join(root, GATES));
    assert.deepEqual(run.lines.filter((line) => !line.startsWith('Disclosure')), IDS.map((id) => `${id}: applied`));
  });

  it('places the entries before a trailing canonical coverage checker, as placeEntries does', async () => {
    const entries = await writtenEntries();
    const { root } = makeProject({ ...PROBED, gates: [PRODUCER, CHECKER] });
    const run = await runVerb(root, ['--apply']);
    assert.equal(run.code, 0, run.stderr);
    const written = parsedOf(root).gates;
    assert.deepEqual(written, placeEntries([PRODUCER, CHECKER], entries, root));
    assert.deepEqual(written.map(({ id }) => id), ['unit-tests', ...IDS, 'coverage-check']);
    assert.deepEqual(coverageDeclarationDefects(written, root), []);
  });

  it('writes no _README when the loaded declaration carries none, and re-serializes existing entries', async () => {
    const { root } = makeProject({ ...PROBED, gates: `{\n    "gates": [\n        { "id": "lint", "title": "l\\u0069nt", "cmd": "npm run lint" }\n    ]\n}\n` });
    assert.equal((await runVerb(root, ['--apply', '--only', 'plan-shape'])).code, 0);
    const text = bytesOf(root).toString('utf8');
    assert.deepEqual(Object.keys(JSON.parse(text)), ['gates']);
    assert.equal(text, serialize({ gates: [LINT, (await writtenEntries())[1]] }));
  });
});

describe('spec:checker-gates/S9 a second --apply, like a first with nothing offered, is a no-op', () => {
  it('changes no byte and calls no write primitive on the second run, every written candidate declared', async () => {
    const { root } = makeProject({ ...PROBED, gates: [LINT] });
    assert.equal((await runVerb(root, ['--apply'])).code, 0);
    const after = bytesOf(root);
    const second = await runVerb(root, ['--apply']);
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(second.writes, []);
    assert.deepEqual(bytesOf(root), after);
    assert.deepEqual(second.lines, IDS.map((id) => `${id}: declared`));
  });

  it('is the same no-op on a first run where every candidate is declared or not-applicable', async () => {
    const [, planShape] = await writtenEntries();
    const { root } = makeProject({ gates: [planShape] });
    const before = bytesOf(root);
    const run = await runVerb(root, ['--apply']);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.writes, []);
    assert.deepEqual(bytesOf(root), before);
    assert.equal(run.lines[1], 'plan-shape: declared');
  });
});

describe('spec:checker-gates/S10 the merge step backstops a coverage defect, and a failed write names its cause', () => {
  it('answers coverage-defect naming the first defect of the merged declaration, and no body', async () => {
    const entries = await writtenEntries();
    const { root } = makeProject({ gates: [] });
    const loaded = { readme: 'r', gates: [CHECKER] };
    const answer = merge(loaded, entries, root);
    assert.equal(answer.refusal, 'coverage-defect');
    assert.equal(answer.detail, coverageDeclarationDefects(placeEntries([CHECKER], entries, root), root)[0].message);
    assert.equal(answer.body, undefined);
    assert.equal(answer.merged, undefined);
  });

  it('answers the merged declaration and its body otherwise', async () => {
    const entries = await writtenEntries();
    const { root } = makeProject({ gates: [] });
    const answer = merge({ gates: [LINT] }, entries.slice(0, 1), root);
    assert.deepEqual(answer.merged, { gates: [LINT, entries[0]] });
    assert.equal(answer.body, serialize({ gates: [LINT, entries[0]] }));
  });

  it('refuses write-failed with the cause when the rename fails, the declaration unchanged and no temp left', async () => {
    const { root } = makeProject({ ...PROBED, gates: [LINT] });
    const before = bytesOf(root);
    const run = await runVerb(root, ['--apply'], failAt(root, 'rename', GATES, 'EIO'));
    assert.equal(run.code, 1, run.stdout);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /\bwrite-failed\b/);
    assert.match(run.stderr, /\bEIO\b/);
    assert.deepEqual(bytesOf(root), before);
    assert.deepEqual(readdirSync(join(root, 'docs', 'ai')).filter((name) => name.endsWith('.tmp')), []);
  });
});

describe('the verb runs as a command', () => {
  it('previews at exit 0 and answers usage at exit 2 when spawned', () => {
    const { root } = makeProject({ ...PROBED, gates: [] });
    const preview = spawnSync(process.execPath, [TOOL, '--cwd', root], { encoding: 'utf8', env: { ...process.env } });
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /^plan-shape: offered$/m);
    const usage = spawnSync(process.execPath, [TOOL, '--bogus'], { encoding: 'utf8', env: { ...process.env } });
    assert.equal(usage.status, 2);
    assert.equal(usage.stdout, '');
    assert.match(usage.stderr, /^usage: /);
  });
});
