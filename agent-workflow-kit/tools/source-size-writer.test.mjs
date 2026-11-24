import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { stripGitLocationEnv } from './git-env.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixtureRepo } from '../../scripts/testing/fixture-repo.mjs';
import { main } from './source-size-check.mjs';
import { INITIAL_ADOPTION_REASON, SOURCE_SIZE_DEFAULTS, SOURCE_SIZE_GATE_ID, SOURCE_SIZE_WHY } from './source-size-core.mjs';
import { EXPECTED_WORKFLOW_VERSION } from './velocity-profile.mjs';
import { REVISION_13_README } from './source-size/cli-harness.test.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-source-size-writer-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const { NODE_TEST_CONTEXT, ...TEST_ENV } = stripGitLocationEnv(process.env);

const TOOL = fileURLToPath(new URL('./source-size-check.mjs', import.meta.url));
const RAISE_REVIEW_FOCUS = "source-size: REVIEW FOCUS — this write RAISED a recorded size: read each raised entry's reason and judge whether the project's code rules were kept for that file; a reason naming a debt row holds an old file grown outside its story's scope (paste this line into the review dispatch focus).";
const REVISION_12_README = "Source-size practice: declared scope + the recorded ratchet; the limits are the kit's, kept in its code. Authored keys: schema, roots, exclude, extensions, limits (a project's reasoned overrides of a kit limit). Machine keys: baseline, layout — each recorded entry carries a reason, and a recorded size is debt, not permission. Strict JSON — unknown keys refused.";

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: TEST_ENV });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
};

const lines = (n) => 'x\n'.repeat(n);

const AUTHORED = (over = {}) => ({
  _README: 'fixture — the authored half, written by a human',
  schema: 2,
  roots: ['src'],
  exclude: ['src/vendor'],
  extensions: ['.mjs'],
  ...over,
});

let seq = 0;
const project = ({ files = {}, config = AUTHORED(), docsAi = true } = {}) => {
  const cwd = join(TMP, `p${seq += 1}`);
  mkdirSync(cwd, { recursive: true });
  makeFixtureRepo((args) => git(cwd, args), cwd, ['-q', '-b', 'main']);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(cwd, rel, '..'), { recursive: true });
    writeFileSync(join(cwd, rel), body);
  }
  if (docsAi) mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  if (docsAi && config !== null) writeFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), JSON.stringify(config, null, 2));
  git(cwd, ['add', '-A']);
  return cwd;
};

const check = (cwd) => main(['--check', '--cwd', cwd]);
const writeBaseline = (cwd, reason) =>
  main(reason === undefined ? ['--write-baseline', '--cwd', cwd] : ['--write-baseline', '--cwd', cwd, '--reason', reason]);
const overrideFileLimit = (cwd, value, reason) =>
  main(['--override', 'lines-per-file', '--value', String(value), '--reason', reason, '--cwd', cwd]);
const configPath = (cwd) => join(cwd, 'docs', 'ai', 'source-size.json');
const configOf = (cwd) => JSON.parse(readFileSync(configPath(cwd), 'utf8'));
const out = (result) => `${result.stdout}\n${result.stderr}`;
const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
// A schema-1 file and the schema-2 file its move must write, the records carried verbatim.
const SCHEMA1 = (over = {}) => ({ _README: 'fixture — a schema-1 file', schema: 1, defaults: { ...SOURCE_SIZE_DEFAULTS }, roots: ['src'], exclude: [], extensions: ['.mjs'], ...over });
const MOVED = (records) => ({ _README: SCHEMA1()._README, schema: 2, roots: ['src'], exclude: [], extensions: ['.mjs'], ...records });
const RECORDS = { baseline: { 'src/big.mjs': { lines: 441, reason: 'recorded at adoption' } }, aggregate: { src: { lines: 451, reason: 'recorded at adoption' } } };
const DEPLOYED = { 'src/a.mjs': lines(10), 'src/big.mjs': lines(441), 'docs/ai/.workflow-version': `${EXPECTED_WORKFLOW_VERSION}\n` };
const KIT_LIMIT_LINES = ['lines-per-file 400, tolerance 10%', 'bytes-per-line 1000, tolerance 0%', 'entries-per-directory 20, tolerance 10%', 'depth 5, tolerance 0%', 'files-per-root none recorded, tolerance 10%'].map((limit) => `source-size: limit ${limit} — from kit`);
const stated = (result) => [result.code, ...result.stdout.split('\n').slice(0, 5)];
const movedLine = (cwd, schema = 2) => `source-size: ${configPath(cwd)} moved from schema 1 to schema ${schema} in this write; a kit that predates schema ${schema} stops by name until that copy is upgraded.`;
const adopt = (cwd) => main(['--adopt', '--reason', INITIAL_ADOPTION_REASON, '--cwd', cwd]);
const gatesPath = (cwd) => join(cwd, 'docs', 'ai', 'gates.json');

describe('source-size — the config contract the writer honours (D-5)', () => {
  it('config-absent-refuses-with-authoring-content: on an absent config the writer writes schema 3, its first raises taking --reason', () => {
    const cwd = project({ files: { 'src/a.mjs': lines(10) }, config: null });
    assert.deepEqual(stated(writeBaseline(cwd)), [1, ...KIT_LIMIT_LINES], 'a first record is a raise, so it takes --reason');
    assert.equal(existsSync(configPath(cwd)), false, 'a refused write leaves it absent');
    const written = writeBaseline(cwd, 'initial adoption');
    assert.equal(written.code, 0);
    assert.ok(written.stdout.split('\n').includes(`source-size: ${configPath(cwd)} written at schema 3 in this write; a kit that predates schema 3 stops by name until that copy is upgraded.`));
    assert.equal(readFileSync(configPath(cwd), 'utf8'), canonical({ _README: REVISION_13_README, schema: 3, baseline: {}, layout: { roots: { '.': { files: 1, reason: 'initial adoption' } }, directories: {} } }));
  });

  it('config-authored-state-check-refuses-with-mint-command: the AUTHORED→MINTED seam names the exact command', () => {
    const cwd = project({ files: { 'src/a.mjs': lines(10) } });
    const result = check(cwd);
    assert.equal(result.code, 1, out(result));
    assert.match(result.stdout, /AUTHORED but not yet MINTED/);
    assert.ok(
      result.stdout.includes(`node "${TOOL}" --write-baseline --cwd "${cwd}" --reason "${INITIAL_ADOPTION_REASON}"`),
      `the mint command must be paste-ready:\n${result.stdout}`,
    );
  });

  it('writer-requires-docs-ai-deployment: no deployed docs/ai is a refusal naming the init lane, never a mkdir', () => {
    const cwd = project({ files: { 'src/a.mjs': lines(10) }, docsAi: false });
    const result = writeBaseline(cwd, 'initial adoption');
    assert.equal(result.code, 1, out(result));
    assert.match(out(result), /docs\/ai/);
    assert.match(out(result), /init/);
    assert.equal(existsSync(join(cwd, 'docs', 'ai')), false, 'the writer never creates the deployment it was handed');
  });

  it('writer-preserves-authored-keys: the machine writes machine keys and nothing else', () => {
    const authored = AUTHORED();
    const cwd = project({ files: { 'src/a.mjs': lines(10) }, config: authored });
    assert.equal(writeBaseline(cwd, INITIAL_ADOPTION_REASON).code, 0);
    const written = configOf(cwd);
    for (const key of Object.keys(authored)) assert.deepEqual(written[key], key === 'schema' ? 3 : authored[key], `authored key "${key}" was rewritten`);
    assert.deepEqual(Object.keys(written), [...Object.keys(authored), 'baseline'], 'the authored key ORDER survives, baseline lands last');
  });

  it('writer-idempotent-serialization: regenerating an unchanged tree reproduces the file byte for byte', () => {
    const cwd = project({ files: { 'src/a.mjs': lines(10), 'src/big.mjs': lines(441) } });
    assert.equal(writeBaseline(cwd, INITIAL_ADOPTION_REASON).code, 0);
    const first = readFileSync(configPath(cwd));
    assert.equal(writeBaseline(cwd).code, 0, 'an unchanged tree raises nothing, so it needs no reason');
    assert.deepEqual(readFileSync(configPath(cwd)), first, 'the serialization is deterministic');
  });

  it('mint-on-authored-config-succeeds: author, mint, run green — the ratchet is armed on a project that is not this kit', () => {
    const cwd = project({ files: { 'src/a.mjs': lines(10), 'src/big.mjs': lines(441), 'src/vendor/huge.mjs': lines(900) } });
    assert.equal(check(cwd).code, 1, 'an AUTHORED config is not yet a ratchet');
    assert.deepEqual(stated(writeBaseline(cwd, INITIAL_ADOPTION_REASON)), [0, ...KIT_LIMIT_LINES]);
    assert.equal(check(cwd).code, 0, 'the minted record matches the tree it was minted from');
    const minted = configOf(cwd);
    assert.deepEqual(minted.baseline, { 'src/big.mjs': { lines: 441, reason: INITIAL_ADOPTION_REASON } }, 'only the violator is recorded; the excluded path is out of scope');
    assert.deepEqual([minted.schema, Object.hasOwn(minted, 'aggregate')], [3, false]);

    writeFileSync(join(cwd, 'src', 'big.mjs'), lines(442));
    const grown = check(cwd);
    assert.equal(grown.code, 1, `the armed ratchet refuses the next line:\n${grown.stdout}`);
    assert.match(grown.stdout, /src\/big\.mjs: lines 442 exceeds its recorded baseline 441/);
  });
});

describe('source-size — a raise is reasoned, a tighten is free (D-3a)', () => {
  it('write-baseline-tighten-needs-no-reason: shrinking is progress', () => {
    const cwd = project({
      files: { 'src/big.mjs': lines(441) },
      config: AUTHORED({ baseline: { 'src/big.mjs': { lines: 500, reason: 'recorded at adoption' } }, aggregate: { src: { lines: 500, reason: 'recorded at adoption' } } }),
    });
    const result = writeBaseline(cwd);
    assert.deepEqual(stated(result), [0, ...KIT_LIMIT_LINES], out(result));
    assert.equal(configOf(cwd).baseline['src/big.mjs'].lines, 441);
    assert.equal(configOf(cwd).baseline['src/big.mjs'].reason, 'recorded at adoption', 'a tighten keeps the reason that was already recorded');
  });

  it('write-baseline-raise-without-reason-refuses: the checker cannot invent the human\'s reason', () => {
    const cwd = project({
      files: { 'src/big.mjs': lines(460) },
      config: AUTHORED({ baseline: { 'src/big.mjs': { lines: 441, reason: 'recorded at adoption' } }, aggregate: { src: { lines: 441, reason: 'recorded at adoption' } } }),
    });
    const result = writeBaseline(cwd);
    assert.deepEqual(stated(result), [1, ...KIT_LIMIT_LINES], out(result));
    assert.match(out(result), /--reason/);
    assert.equal(configOf(cwd).baseline['src/big.mjs'].lines, 441, 'a refused regeneration writes nothing');
  });

  it('ratchet-raise-requires-reason: the reason lands VERBATIM in the entry it raised, and nowhere else', () => {
    const cwd = project({
      files: { 'src/big.mjs': lines(460), 'src/wide.mjs': `${'x'.repeat(1001)}\n` },
      config: AUTHORED({
        baseline: { 'src/big.mjs': { lines: 441, reason: 'recorded at adoption' }, 'src/wide.mjs': { maxLineBytes: 1001, reason: 'recorded at adoption' } },
        aggregate: { src: { lines: 442, reason: 'recorded at adoption' } },
      }),
    });
    assert.deepEqual(stated(writeBaseline(cwd, 'tranche 1: the parser moved here')), [0, ...KIT_LIMIT_LINES]);
    const written = configOf(cwd);
    assert.deepEqual(written.baseline['src/big.mjs'], { lines: 460, reason: 'tranche 1: the parser moved here' });
    assert.deepEqual(written.baseline['src/wide.mjs'], { maxLineBytes: 1001, reason: 'recorded at adoption' }, 'an untouched entry keeps its own reason');
  });

  it('baseline-reasoned-add-for-new-file: a NEW file over the cap is recordable — refusing it would be the forbidden hard stop', () => {
    const cwd = project({
      files: { 'src/a.mjs': lines(10), 'src/new.mjs': lines(900) },
      config: AUTHORED({ baseline: {}, aggregate: { src: { lines: 10, reason: 'recorded at adoption' } } }),
    });
    assert.equal(writeBaseline(cwd).code, 1, 'recording a new violator is a raise');
    assert.equal(writeBaseline(cwd, 'generated table, split scheduled for tranche 4').code, 0);
    assert.deepEqual(configOf(cwd).baseline['src/new.mjs'], { lines: 900, reason: 'generated table, split scheduled for tranche 4' });
    assert.equal(check(cwd).code, 0);
  });

  it('mint-captures-both-dimensions: a file over both caps records both, and a file over one records one', () => {
    const cwd = project({ files: { 'src/both.mjs': `${'x'.repeat(1001)}\n${lines(440)}`, 'src/tall.mjs': lines(441) } });
    assert.deepEqual(stated(writeBaseline(cwd, INITIAL_ADOPTION_REASON)), [0, ...KIT_LIMIT_LINES]);
    const both = { 'src/both.mjs': { lines: 441, maxLineBytes: 1001, reason: INITIAL_ADOPTION_REASON }, 'src/tall.mjs': { lines: 441, reason: INITIAL_ADOPTION_REASON } };
    assert.deepEqual(configOf(cwd).baseline, both);
    assert.equal(check(cwd).code, 0);
  });

  it('regenerator-prints-old-new-delta: the printed delta is the record the commit message carries', () => {
    const cwd = project({
      files: { 'src/big.mjs': lines(460), 'src/small.mjs': lines(10) },
      config: AUTHORED({
        baseline: { 'src/big.mjs': { lines: 441, reason: 'recorded at adoption' }, 'src/gone.mjs': { lines: 900, reason: 'recorded at adoption' } },
        aggregate: { src: { lines: 451, reason: 'recorded at adoption' } },
      }),
    });
    const result = writeBaseline(cwd, 'tranche 1: flow-check split');
    assert.deepEqual(stated(result), [0, ...KIT_LIMIT_LINES], out(result));
    assert.match(result.stdout, /src\/big\.mjs: lines 441 → 460/);
    assert.match(result.stdout, /src\/gone\.mjs: lines 900 → none/);
    assert.match(result.stdout, /src: aggregate lines 451 → none/);
    assert.match(result.stdout, /reason: tranche 1: flow-check split/);
  });

  it('reason-empty-refused and reason-multiline-refused: the string lands in JSON, a commit message and a CHANGELOG', () => {
    const cwd = project({ files: { 'src/big.mjs': lines(441) } });
    for (const [reason, pattern] of [['', /non-empty/], ['first line\nsecond line', /ONE line/], ['x'.repeat(400), /at most 300/]]) {
      const result = writeBaseline(cwd, reason);
      assert.equal(result.code, 2, `a malformed reason is a usage refusal: ${JSON.stringify(reason)}\n${out(result)}`);
      assert.match(out(result), pattern);
    }
    assert.equal(existsSync(configPath(cwd)) && 'baseline' in configOf(cwd), false, 'no refused reason ever reaches the file');
  });
});

describe('source-size — what the writer says it did', () => {
  it('writer-regenerates-a-baseline-only-config: no sum is added to the per-file record', () => {
    const cwd = project({
      files: { 'src/a.mjs': lines(10) },
      config: AUTHORED({ baseline: {} }),
    });
    assert.equal(writeBaseline(cwd).code, 0, 'regenerating the existing baseline raises nothing');
    assert.deepEqual(configOf(cwd), { ...AUTHORED(), schema: 3, baseline: {} });
  });

  it('write-refusal-prints-every-delta-not-only-raises: the promised record is the WHOLE old→new, marked', () => {
    const cwd = project({
      files: { 'src/big.mjs': lines(460) },
      config: AUTHORED({
        baseline: { 'src/big.mjs': { lines: 441, reason: 'r' }, 'src/gone.mjs': { lines: 900, reason: 'r' } },
        aggregate: { src: { lines: 460, reason: 'r' } },
      }),
    });
    const result = writeBaseline(cwd);
    assert.deepEqual(stated(result), [1, ...KIT_LIMIT_LINES], out(result));
    assert.match(result.stdout, /src\/big\.mjs: lines 441 → 460 \(raise\)/);
    assert.match(result.stdout, /src\/gone\.mjs: lines 900 → none/, 'a removal riding the same regeneration must not vanish from the record');
    assert.match(result.stdout, /RAISES 1 recorded value/);
  });

  it('writer-canonicalizes-only-the-serialization: authored VALUES and their order survive, the bytes are the writer\'s', () => {
    const handWritten = '{\n    "_README": "four spaces, and an escape: \\u00e9",\n    "schema": 2,\n    "roots": ["src"],\n    "extensions": [".mjs"]\n}';
    const cwd = project({ files: { 'src/a.mjs': lines(10) }, config: null });
    writeFileSync(configPath(cwd), handWritten);
    const minted = writeBaseline(cwd, INITIAL_ADOPTION_REASON);
    assert.equal(minted.code, 0, out(minted));
    assert.ok(!minted.stdout.includes('unchanged'), 'a mint that rewrote the file never reports itself as unchanged');
    assert.ok(minted.stdout.split('\n').includes(`source-size: baseline rewritten — no recorded value changed; ${configPath(cwd)} was re-serialized`), minted.stdout);
    // The exact BYTES, not the parsed values: an implementation that kept the human's four-space
    // indent and the \u00e9 escape would satisfy a values-only assertion, which is precisely the
    // contract this test exists to pin.
    const expected = canonical({ _README: 'four spaces, and an escape: \u00e9', schema: 3, roots: ['src'], extensions: ['.mjs'], baseline: {} });
    assert.equal(readFileSync(configPath(cwd), 'utf8'), expected);
  });

  it('writer-unchanged-writes-nothing: "unchanged" means the file was not touched, not that it was rewritten identically', () => {
    const cwd = project({ files: { 'src/a.mjs': lines(10), 'src/big.mjs': lines(401) } });
    assert.equal(writeBaseline(cwd, INITIAL_ADOPTION_REASON).code, 0);
    const writes = [];
    const deps = {
      writeFile: (...args) => { writes.push('writeFile'); return writeFileSync(...args); },
      rename: (...args) => { writes.push('rename'); return renameSync(...args); },
    };
    const again = main(['--write-baseline', '--cwd', cwd], { deps });
    assert.equal(again.code, 0, out(again));
    assert.match(again.stdout, /unchanged/);
    assert.deepEqual(writes, [], 'an unchanged record is a no-op on disk — no temp write, no rename');
  });

  it('writer-root-named-like-a-prototype-member: a root called "constructor" is recorded like any other', () => {
    // A plain lookup would answer with Object.prototype.constructor — "already recorded" — so the
    // raise goes unnoticed and the entry lands with NO reason, which this tool's own validator then
    // refuses: the writer would produce a config it cannot read back.
    const cwd = project({
      files: { 'constructor/a.mjs': lines(10) },
      config: AUTHORED({ roots: ['constructor'], exclude: [], baseline: {} }),
    });
    const minted = main(['--write-baseline', '--layout', '--reason', INITIAL_ADOPTION_REASON, '--cwd', cwd]);
    assert.equal(minted.code, 0, out(minted));
    assert.deepEqual(configOf(cwd).layout.roots, { constructor: { files: 1, reason: INITIAL_ADOPTION_REASON } });
    assert.deepEqual([configOf(cwd).schema, Object.hasOwn(configOf(cwd), 'aggregate')], [3, false]);
    assert.equal(check(cwd).code, 0, 'the config the writer just wrote must be one it accepts');
  });
});

describe('source-size — spec:source-size/S18 the check stops on a schema-1 config and names the move', () => {
  it('check-stops-on-schema-1: verdict, finding and --write-baseline remedy, then limits and WHY, exit 1, the file untouched', () => {
    const cwd = project({ files: { 'src/a.mjs': lines(10) }, config: SCHEMA1({ defaults: { maxLines: 300, maxLineBytes: 1000 }, ...RECORDS }) });
    const before = readFileSync(configPath(cwd));
    const result = check(cwd);
    assert.deepEqual(result.stdout.split('\n'), [`source-size: FAIL — ${configPath(cwd)} is schema 1, which the check no longer judges`, 'docs/ai/source-size.json: --write-baseline moves it off schema 1 (a raise riding it still takes --reason)', `source-size: REMEDY — node "${TOOL}" --write-baseline --cwd "${cwd}"`, 'source-size: limit lines-per-file 300, tolerance 10% — from override: carried from schema 1', ...KIT_LIMIT_LINES.slice(1), `source-size: WHY — ${SOURCE_SIZE_WHY}`], out(result));
    assert.deepEqual([result.code, result.stderr], [1, ''], out(result));
    assert.deepEqual(readFileSync(configPath(cwd)), before, 'the check writes nothing');
  });
});

describe('source-size — spec:source-size/S19 regeneration moves schema 1 onto 3; adoption carries records verbatim', () => {
  it('write-baseline-moves-schema-1: authored keys in their order, differing defaults replaced in place, template renewed, baseline carried, aggregate dropped', async () => {
    const { SCHEMA1_TEMPLATE_README } = await import('./source-size-report.mjs');
    assert.equal(typeof SCHEMA1_TEMPLATE_README, 'string', 'the report keeps the schema-1 template text beside the template');
    const records = { baseline: { 'src/big.mjs': { lines: 441, reason: 'recorded at adoption' } }, aggregate: { src: { lines: 451, reason: 'recorded at adoption' } } };
    const cwd = project({ files: { 'src/a.mjs': lines(10), 'src/big.mjs': lines(441) }, config: { schema: 1, _README: SCHEMA1_TEMPLATE_README, roots: ['src'], defaults: { maxLines: 300, maxLineBytes: 1000 }, extensions: ['.mjs'], exclude: ['src/vendor'], ...records } });
    const moved = writeBaseline(cwd);
    const limits = { 'lines-per-file': { value: 300, tolerance: 10, reason: 'carried from schema 1' } };
    assert.equal(readFileSync(configPath(cwd), 'utf8'), canonical({ schema: 3, _README: REVISION_13_README, roots: ['src'], limits, extensions: ['.mjs'], exclude: ['src/vendor'], baseline: records.baseline }));
    assert.equal(moved.code, 0, `the move needs no reason, because it raises nothing:\n${out(moved)}`);
    assert.ok(moved.stdout.includes(movedLine(cwd, 3)), moved.stdout);
    assert.ok(moved.stdout.includes('source-size: limit lines-per-file 300, tolerance 10% — from override: carried from schema 1'), moved.stdout);
    assert.doesNotMatch(moved.stdout, /\(raise\)|^reason:/m, 'the move raised no record');
  });

  it('write-baseline-moves-schema-1: any other _README verbatim and an equal defaults dropped; a raise riding the move still takes --reason', () => {
    const cwd = project({ files: DEPLOYED, config: SCHEMA1(RECORDS) });
    const moved = writeBaseline(cwd);
    assert.equal(readFileSync(configPath(cwd), 'utf8'), canonical({ ...MOVED({ baseline: RECORDS.baseline }), schema: 3 }));
    assert.equal(moved.code, 0, out(moved));
    assert.ok(moved.stdout.includes(movedLine(cwd, 3)), moved.stdout);
    const authored = project({ files: { 'src/a.mjs': lines(441) }, config: SCHEMA1() });
    const before = readFileSync(configPath(authored));
    const refused = writeBaseline(authored);
    assert.equal(refused.code, 1, out(refused));
    assert.match(refused.stdout, /RAISES 1 recorded value/);
    assert.deepEqual(readFileSync(configPath(authored)), before, 'a refused move writes nothing');
    assert.equal(writeBaseline(authored, INITIAL_ADOPTION_REASON).code, 0);
    assert.deepEqual(configOf(authored), { ...MOVED({ baseline: { 'src/a.mjs': { lines: 441, reason: INITIAL_ADOPTION_REASON } } }), schema: 3 });
  });

  it('adopt-moves-a-minted-schema-1-config-in-its-own-write: a grown tree then stops, no gate declared, the records unchanged', () => {
    const cwd = project({ files: DEPLOYED, config: SCHEMA1(RECORDS) });
    writeFileSync(join(cwd, 'src', 'big.mjs'), lines(442));
    const result = adopt(cwd);
    assert.equal(readFileSync(configPath(cwd), 'utf8'), canonical(MOVED(RECORDS)), 'the move is its own write, nothing regenerated');
    assert.equal(result.code, 1, out(result));
    assert.equal(result.stdout.split('\n')[0], movedLine(cwd));
    assert.match(result.stdout, /src\/big\.mjs: lines 442 exceeds its recorded baseline 441/);
    assert.match(result.stdout, /--adopt STOPPED before declaring/);
    assert.equal(existsSync(gatesPath(cwd)), false, 'no gate was declared over a record the tree outgrew');
  });

  it('adopt-moves-a-minted-schema-1-config-in-its-own-write: a scope stop after the move still prints the move', () => {
    const cwd = project({ files: DEPLOYED, config: SCHEMA1(RECORDS) });
    git(cwd, ['rm', '-q', '--cached', 'src/a.mjs', 'src/big.mjs']);
    const result = adopt(cwd);
    assert.equal(readFileSync(configPath(cwd), 'utf8'), canonical(MOVED(RECORDS)), 'the move was written');
    assert.match(result.stdout.split('\n')[0], /^source-size: FAIL — the declared scope matches ZERO tracked files/);
    assert.deepEqual(result.stdout.split('\n').slice(1), ['source-size: REMEDY — fix the tree condition the verdict line names, then re-run', movedLine(cwd)]);
    assert.deepEqual([result.code, result.stderr], [1, ''], out(result));
  });

  it('adopt-moves-a-minted-schema-1-config-in-its-own-write: the adopted arm moves and converges; an authored one with no --reason writes nothing', () => {
    const gates = JSON.stringify({ gates: [{ id: SOURCE_SIZE_GATE_ID, title: 'Source size', cmd: `node "${TOOL}" --check` }] }, null, 2);
    const cwd = project({ files: { ...DEPLOYED, 'docs/ai/gates.json': gates }, config: SCHEMA1(RECORDS) });
    const result = adopt(cwd);
    assert.equal(readFileSync(configPath(cwd), 'utf8'), canonical(MOVED(RECORDS)), 'the move is its own write, nothing regenerated');
    assert.equal(result.code, 0, out(result));
    assert.equal(result.stdout.split('\n')[0], movedLine(cwd));
    assert.match(result.stdout, /already declared — nothing to declare; --adopt converged/);
    assert.equal(readFileSync(gatesPath(cwd), 'utf8'), gates, 'the declared gate is untouched');
    const authored = project({ files: DEPLOYED, config: SCHEMA1() });
    const before = readFileSync(configPath(authored));
    assert.equal(main(['--adopt', '--cwd', authored]).code, 1, 'a first mint raises, so it needs a reason');
    assert.deepEqual(readFileSync(configPath(authored)), before, 'a refused mint writes nothing, and no separate move ran');
    assert.equal(existsSync(gatesPath(authored)), false);
  });
});

describe('spec:source-size/S73 a write that raises prints the review focus after its reason', () => {
  const assertRaiseReviewFocus = (result, reason) => {
    assert.deepEqual([result.code, result.stderr], [0, ''], out(result));
    const outputLines = result.stdout.split('\n');
    const reasonIndex = outputLines.indexOf(`reason: ${reason}`);
    assert.ok(reasonIndex >= 0, out(result));
    assert.equal(outputLines.filter((line) => line === RAISE_REVIEW_FOCUS).length, 1, out(result));
    assert.equal(outputLines[reasonIndex + 1], RAISE_REVIEW_FOCUS, out(result));
  };

  const assertNoRaiseReviewFocus = (result) => {
    assert.equal(result.code, 0, out(result));
    assert.doesNotMatch(out(result), /^source-size: REVIEW FOCUS — this write RAISED\b/m);
  };

  it('plain --write-baseline focuses a grown file, and emits no raise focus for the unchanged tree or a later tighten', () => {
    const grownPath = 'src/big.mjs';
    const cwd = project({
      files: { [grownPath]: lines(460) },
      config: AUTHORED({ schema: 3, baseline: RECORDS.baseline }),
    });
    const reason = 'the parser moved here';
    const grown = writeBaseline(cwd, reason);
    assert.match(grown.stdout, /src\/big\.mjs: lines 441 → 460 \(raise\)/);

    const unchanged = writeBaseline(cwd);
    assert.match(unchanged.stdout, /baseline unchanged/);
    assertNoRaiseReviewFocus(unchanged);

    writeFileSync(join(cwd, grownPath), lines(441));
    const tightened = writeBaseline(cwd);
    assert.match(tightened.stdout, /src\/big\.mjs: lines 460 → 441/);
    assertNoRaiseReviewFocus(tightened);

    assertRaiseReviewFocus(grown, reason);
  });

  it('--write-baseline --layout focuses a raise when it starts the layout record', () => {
    const cwd = project({
      files: { 'src/a.mjs': lines(10) },
      config: AUTHORED({ schema: 3, baseline: {} }),
    });
    const result = main(['--write-baseline', '--layout', '--reason', INITIAL_ADOPTION_REASON, '--cwd', cwd]);
    assert.deepEqual(configOf(cwd).layout.roots, { src: { files: 1, reason: INITIAL_ADOPTION_REASON } });
    assertRaiseReviewFocus(result, INITIAL_ADOPTION_REASON);
  });

  it('the first write on an absent config focuses its raises', () => {
    const cwd = project({ files: { 'src/a.mjs': lines(10) }, config: null });
    const result = writeBaseline(cwd, INITIAL_ADOPTION_REASON);
    assertRaiseReviewFocus(result, INITIAL_ADOPTION_REASON);
  });

  it('minting an authored config focuses its raises, and re-serialization emits no raise focus', () => {
    const cwd = project({ files: { 'src/big.mjs': lines(441) } });
    const minted = writeBaseline(cwd, INITIAL_ADOPTION_REASON);
    assert.deepEqual(configOf(cwd).baseline, { 'src/big.mjs': { lines: 441, reason: INITIAL_ADOPTION_REASON } });

    const configFile = configPath(cwd);
    writeFileSync(configFile, readFileSync(configFile, 'utf8').trimEnd());
    const reserialized = writeBaseline(cwd, INITIAL_ADOPTION_REASON);
    assert.ok(reserialized.stdout.split('\n').includes(`source-size: baseline rewritten — no recorded value changed; ${configFile} was re-serialized`), out(reserialized));
    assertNoRaiseReviewFocus(reserialized);

    assertRaiseReviewFocus(minted, INITIAL_ADOPTION_REASON);
  });

  it('--override focuses the regeneration when a tighter limit creates a raise', () => {
    const cwd = project({
      files: { 'src/a.mjs': lines(10) },
      config: AUTHORED({ schema: 3, baseline: {} }),
    });
    const reason = 'tighter files';
    const result = overrideFileLimit(cwd, 8, reason);
    assert.match(result.stdout, /src\/a\.mjs: lines none → 10 \(raise\)/);
    assertRaiseReviewFocus(result, reason);
  });
});

describe('spec:source-size/S74 regeneration replaces the revision-12 _README and absent refusals print revision 13', () => {
  it('regeneration replaces the exact revision-12 template and keeps an _README differing by one byte', () => {
    const customReadme = `${REVISION_12_README.slice(0, -1)}!`;
    const writtenReadmes = [REVISION_12_README, customReadme].map((_README) => {
      const cwd = project({
        files: { 'src/a.mjs': lines(10) },
        config: AUTHORED({ schema: 3, _README, baseline: {} }),
      });
      const result = writeBaseline(cwd);
      assert.equal(result.code, 0, out(result));
      return configOf(cwd)._README;
    });
    assert.deepEqual(writtenReadmes, [REVISION_13_README, customReadme]);
  });

  for (const [mode, run] of [
    ['--adopt', adopt],
    ['--override', (cwd) => overrideFileLimit(cwd, 8, 'tighter files')],
  ]) {
    it(`${mode} on an absent config prints the revision-13 _README in the authoring template`, () => {
      const cwd = project({ files: { 'src/a.mjs': lines(10) }, config: null });
      const result = run(cwd);
      assert.equal(result.code, 1, out(result));
      assert.equal(existsSync(configPath(cwd)), false);
      const templateReadme = result.stdout.split('\n').find((line) => line.startsWith('  "_README": '));
      assert.equal(templateReadme, `  "_README": ${JSON.stringify(REVISION_13_README)},`, out(result));
    });
  }
});
