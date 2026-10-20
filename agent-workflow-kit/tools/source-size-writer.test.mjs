// source-size-writer.test.mjs — the regenerator (--write-baseline) and the config contract it must
// honour. The writer is the ONLY way a recorded size changes, so three properties carry the whole
// practice: a RAISE needs a reason and records it verbatim, a pure TIGHTEN needs none (shrinking is
// progress), and the authored half of the file is never rewritten by a machine. The printed old→new
// delta is the durable record on a deployment whose docs/ai is git-hidden — it is what the commit
// message and the release CHANGELOG restate.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './source-size-check.mjs';
import { INITIAL_ADOPTION_REASON, SOURCE_SIZE_DEFAULTS, SOURCE_SIZE_GATE_ID, SOURCE_SIZE_WHY, measureFile } from './source-size-core.mjs';
import { EXPECTED_WORKFLOW_VERSION } from './velocity-profile.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-source-size-writer-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TOOL = fileURLToPath(new URL('./source-size-check.mjs', import.meta.url));

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
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
  git(cwd, ['init', '-q', '-b', 'main']);
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
const movedLine = (cwd) => `source-size: ${configPath(cwd)} moved from schema 1 to schema 2 in this write.`;
const adopt = (cwd) => main(['--adopt', '--reason', INITIAL_ADOPTION_REASON, '--cwd', cwd]);
const gatesPath = (cwd) => join(cwd, 'docs', 'ai', 'gates.json');

describe('source-size — the config contract the writer honours (D-5)', () => {
  it('config-absent-refuses-with-authoring-content: on an absent config the writer writes schema 2, its first raises taking --reason', async () => {
    const { TEMPLATE_README } = await import('./source-size-report.mjs');
    const cwd = project({ files: { 'src/a.mjs': lines(10) }, config: null });
    assert.deepEqual(stated(writeBaseline(cwd)), [1, ...KIT_LIMIT_LINES], 'a first record is a raise, so it takes --reason');
    assert.equal(existsSync(configPath(cwd)), false, 'a refused write leaves it absent');
    assert.equal(writeBaseline(cwd, 'initial adoption').code, 0);
    assert.equal(readFileSync(configPath(cwd), 'utf8'), canonical({ _README: TEMPLATE_README, schema: 2, baseline: {}, aggregate: { '.': { lines: 0, reason: 'initial adoption' } }, layout: { roots: { '.': { files: 1, reason: 'initial adoption' } }, directories: {} } }));
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
    for (const key of Object.keys(authored)) assert.deepEqual(written[key], authored[key], `authored key "${key}" was rewritten`);
    assert.deepEqual(Object.keys(written), [...Object.keys(authored), 'baseline', 'aggregate'], 'the authored key ORDER survives, machine keys land last');
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
    assert.deepEqual(minted.aggregate, { src: { lines: 451, reason: INITIAL_ADOPTION_REASON } });

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
    assert.match(result.stdout, /src: aggregate lines 451 → 470/);
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
  it('config-half-machine-pair-is-not-minted: a hand-edited half record routes to the mint lane instead of passing', () => {
    const cwd = project({
      files: { 'src/a.mjs': lines(10) },
      config: AUTHORED({ aggregate: { src: { lines: 10, reason: 'r' } } }),
    });
    const refused = check(cwd);
    assert.equal(refused.code, 1, `a machine half nobody's writer produces must not read as MINTED:\n${refused.stdout}`);
    assert.match(refused.stdout, /INCOMPLETE/);
    assert.match(refused.stdout, /--write-baseline --cwd .+ --reason "initial adoption"/);

    assert.equal(writeBaseline(cwd, INITIAL_ADOPTION_REASON).code, 0);
    assert.deepEqual(Object.keys(configOf(cwd)).slice(-2), ['baseline', 'aggregate'], 'the regenerator completes the pair');
    assert.equal(check(cwd).code, 0);
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
    assert.match(minted.stdout, /regenerated/, 'a mint that rewrote the file never reports itself as unchanged');
    // The exact BYTES, not the parsed values: an implementation that kept the human's four-space
    // indent and the \u00e9 escape would satisfy a values-only assertion, which is precisely the
    // contract this test exists to pin.
    const expected = canonical({ _README: 'four spaces, and an escape: \u00e9', schema: 2, roots: ['src'], extensions: ['.mjs'], baseline: {}, aggregate: { src: { lines: 10, reason: INITIAL_ADOPTION_REASON } } });
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
      config: AUTHORED({ roots: ['constructor'], exclude: [] }),
    });
    const minted = writeBaseline(cwd, INITIAL_ADOPTION_REASON);
    assert.equal(minted.code, 0, out(minted));
    assert.deepEqual(configOf(cwd).aggregate, { constructor: { lines: 10, reason: INITIAL_ADOPTION_REASON } });
    assert.equal(check(cwd).code, 0, 'the config the writer just wrote must be one it accepts');
  });
});

describe('source-size — spec:source-size/S18 the check stops on a schema-1 config and names the move', () => {
  it('check-stops-on-schema-1: the limit lines, then the one line naming --write-baseline, exit 1, the file untouched', () => {
    const cwd = project({ files: { 'src/a.mjs': lines(10) }, config: SCHEMA1({ defaults: { maxLines: 300, maxLineBytes: 1000 }, ...RECORDS }) });
    const before = readFileSync(configPath(cwd));
    const result = check(cwd);
    assert.deepEqual(result.stdout.split('\n'), ['source-size: limit lines-per-file 300, tolerance 10% — from override: carried from schema 1', ...KIT_LIMIT_LINES.slice(1), `source-size: STOPPED — ${configPath(cwd)} is schema 1, which the check no longer judges; --write-baseline moves it to schema 2 in its one write (a raise riding it still takes --reason): node "${TOOL}" --write-baseline --cwd "${cwd}"`, `source-size: WHY — ${SOURCE_SIZE_WHY}`], out(result));
    assert.equal(result.code, 1, out(result));
    assert.deepEqual(readFileSync(configPath(cwd)), before, 'the check writes nothing');
  });
});

describe('source-size — spec:source-size/S19 the writer moves a schema-1 config to schema 2 in its one write', () => {
  it('write-baseline-moves-schema-1: authored keys in their order, defaults replaced in its place by the differing value only, the template _README renewed, both records carried, no raise', async () => {
    const { SCHEMA1_TEMPLATE_README, TEMPLATE_README } = await import('./source-size-report.mjs');
    assert.equal(typeof SCHEMA1_TEMPLATE_README, 'string', 'the report keeps the schema-1 template text beside the template');
    const records = { baseline: { 'src/big.mjs': { lines: 441, reason: 'recorded at adoption' } }, aggregate: { src: { lines: 451, reason: 'recorded at adoption' } } };
    const cwd = project({ files: { 'src/a.mjs': lines(10), 'src/big.mjs': lines(441) }, config: { schema: 1, _README: SCHEMA1_TEMPLATE_README, roots: ['src'], defaults: { maxLines: 300, maxLineBytes: 1000 }, extensions: ['.mjs'], exclude: ['src/vendor'], ...records } });
    const moved = writeBaseline(cwd);
    const limits = { 'lines-per-file': { value: 300, tolerance: 10, reason: 'carried from schema 1' } };
    assert.equal(readFileSync(configPath(cwd), 'utf8'), canonical({ schema: 2, _README: TEMPLATE_README, roots: ['src'], limits, extensions: ['.mjs'], exclude: ['src/vendor'], ...records }));
    assert.equal(moved.code, 0, `the move needs no reason, because it raises nothing:\n${out(moved)}`);
    assert.ok(moved.stdout.includes(movedLine(cwd)), moved.stdout);
    assert.ok(moved.stdout.includes('source-size: limit lines-per-file 300, tolerance 10% — from override: carried from schema 1'), moved.stdout);
    assert.doesNotMatch(moved.stdout, /\(raise\)|^reason:/m, 'the move raised no record');
  });

  it('write-baseline-moves-schema-1: any other _README verbatim and an equal defaults dropped; a raise riding the move still takes --reason', () => {
    const cwd = project({ files: DEPLOYED, config: SCHEMA1(RECORDS) });
    const moved = writeBaseline(cwd);
    assert.equal(readFileSync(configPath(cwd), 'utf8'), canonical(MOVED(RECORDS)));
    assert.equal(moved.code, 0, out(moved));
    assert.ok(moved.stdout.includes(movedLine(cwd)), moved.stdout);
    const authored = project({ files: { 'src/a.mjs': lines(10) }, config: SCHEMA1() });
    const before = readFileSync(configPath(authored));
    const refused = writeBaseline(authored);
    assert.equal(refused.code, 1, out(refused));
    assert.match(refused.stdout, /RAISES 1 recorded value/);
    assert.deepEqual(readFileSync(configPath(authored)), before, 'a refused move writes nothing');
    assert.equal(writeBaseline(authored, INITIAL_ADOPTION_REASON).code, 0);
    assert.deepEqual(configOf(authored), MOVED({ baseline: {}, aggregate: { src: { lines: 10, reason: INITIAL_ADOPTION_REASON } } }));
  });

  it('adopt-moves-a-minted-schema-1-config-in-its-own-write: a grown tree then stops, no gate declared, the records unchanged', () => {
    const cwd = project({ files: DEPLOYED, config: SCHEMA1(RECORDS) });
    writeFileSync(join(cwd, 'src', 'a.mjs'), lines(12));
    const result = adopt(cwd);
    assert.equal(readFileSync(configPath(cwd), 'utf8'), canonical(MOVED(RECORDS)), 'the move is its own write, nothing regenerated');
    assert.equal(result.code, 1, out(result));
    assert.equal(result.stdout.split('\n')[0], movedLine(cwd));
    assert.match(result.stdout, /src: aggregate lines 453 exceeds the recorded budget 451/);
    assert.match(result.stdout, /--adopt STOPPED before declaring/);
    assert.equal(existsSync(gatesPath(cwd)), false, 'no gate was declared over a record the tree outgrew');
  });

  it('adopt-moves-a-minted-schema-1-config-in-its-own-write: a scope stop after the move still prints the move', () => {
    const cwd = project({ files: DEPLOYED, config: SCHEMA1(RECORDS) });
    git(cwd, ['rm', '-q', '--cached', 'src/a.mjs', 'src/big.mjs']);
    const result = adopt(cwd);
    assert.equal(readFileSync(configPath(cwd), 'utf8'), canonical(MOVED(RECORDS)), 'the move was written');
    assert.equal(result.stdout, movedLine(cwd), out(result));
    assert.match(result.stderr, /the declared scope matches ZERO tracked files/);
    assert.equal(result.code, 1, out(result));
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

describe('source-size — the plan keeps its own rule', () => {
  it('phase2-plan-files-within-defaults: every file this plan has created through Phase 2 is within the declared defaults', () => {
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
    ];
    for (const rel of created) {
      const { lines: count, maxLineBytes } = measureFile(REPO_ROOT, rel);
      assert.ok(count <= SOURCE_SIZE_DEFAULTS.maxLines, `${rel}: ${count} lines exceeds ${SOURCE_SIZE_DEFAULTS.maxLines}`);
      assert.ok(maxLineBytes <= SOURCE_SIZE_DEFAULTS.maxLineBytes, `${rel}: longest line ${maxLineBytes} bytes exceeds ${SOURCE_SIZE_DEFAULTS.maxLineBytes}`);
    }
  });
});
