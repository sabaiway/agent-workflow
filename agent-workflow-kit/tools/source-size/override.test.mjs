// override.test.mjs — --override, the one command that changes a kit number for a project: one
// reasoned override written in the same atomic write that regenerates the record, refused while the
// record does not hold, and refused as usage when the argument list or the kit's own numbers decide.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../source-size-check.mjs';
import { INITIAL_ADOPTION_REASON, reasonDefect } from '../source-size-core.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-source-size-override-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const TOOL = fileURLToPath(new URL('../source-size-check.mjs', import.meta.url));
const NL = String.fromCharCode(10);

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
};

const lines = (n) => 'x\n'.repeat(n);
const FILES = { 'src/a.mjs': lines(10), 'src/big.mjs': lines(441) };
const RECORD = {
  baseline: { 'src/big.mjs': { lines: 441, reason: INITIAL_ADOPTION_REASON } },
  aggregate: { src: { lines: 451, reason: INITIAL_ADOPTION_REASON } },
};
const README = 'fixture — the authored half, written by a human';
const CONFIG = (over = {}) => ({ _README: README, schema: 2, roots: ['src'], exclude: [], extensions: ['.mjs'], ...over });
const SCHEMA1 = (over = {}) => ({
  _README: README,
  schema: 1,
  defaults: { maxLines: 400, maxLineBytes: 1000 },
  roots: ['src'],
  exclude: [],
  extensions: ['.mjs'],
  ...over,
});
const WIDE = { 'lines-per-file': { value: 500, tolerance: 7, reason: 'wide' } };

let seq = 0;
const project = ({ files = FILES, config = CONFIG(RECORD) } = {}) => {
  const cwd = join(TMP, `p${seq += 1}`);
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  git(cwd, ['init', '-q', '-b', 'main']);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(cwd, rel, '..'), { recursive: true });
    writeFileSync(join(cwd, rel), body);
  }
  if (config !== null) writeFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), JSON.stringify(config, null, 2));
  git(cwd, ['add', '-A']);
  return cwd;
};

const configPath = (cwd) => join(cwd, 'docs', 'ai', 'source-size.json');
const bytesOf = (cwd) => (existsSync(configPath(cwd)) ? readFileSync(configPath(cwd)) : null);
const configOf = (cwd) => JSON.parse(readFileSync(configPath(cwd), 'utf8'));
const override = (cwd, args) => main(['--override', ...args, '--cwd', cwd]);
const check = (cwd) => main(['--check', '--cwd', cwd]);
const out = (result) => `${result.stdout}${NL}${result.stderr}`;
const LIMIT_PREFIX = 'source-size: limit ';
const bodyLines = (result) => result.stdout.split(NL).filter((line) => !line.startsWith(LIMIT_PREFIX) && !line.startsWith('source-size: NOTE — '));
const limitsOf = (result) => result.stdout.split(NL).filter((line) => line.startsWith(LIMIT_PREFIX));
const KIT_TAIL = [
  `${LIMIT_PREFIX}bytes-per-line 1000, tolerance 0% — from kit`,
  `${LIMIT_PREFIX}entries-per-directory 20, tolerance 10% — from kit`,
  `${LIMIT_PREFIX}depth 5, tolerance 0% — from kit`,
  `${LIMIT_PREFIX}files-per-root none recorded, tolerance 10% — from kit`,
];
const KEYS_AFTER_OVERRIDE = ['_README', 'schema', 'roots', 'exclude', 'extensions', 'limits', 'baseline', 'aggregate'];
const MINT_COMMAND = (cwd) => `node "${TOOL}" --write-baseline --cwd "${cwd}" --reason "${INITIAL_ADOPTION_REASON}"`;
const OUTGROWN_LEAD = /^source-size: --override REFUSED — the record in .* no longer holds for this tree before this change, so that drift takes --write-baseline --reason first/;

const grownProject = () => {
  const cwd = project();
  writeFileSync(join(cwd, 'src', 'a.mjs'), lines(20));
  return cwd;
};

const assertAbsentRefusal = (cwd, result) => {
  assert.equal(result.code, 1, out(result));
  assert.match(result.stdout, /is absent, so the scope of this practice is undeclared/);
  assert.ok(!result.stdout.includes(LIMIT_PREFIX), `an absent config resolves no limit to state:${NL}${result.stdout}`);
  assert.equal(existsSync(configPath(cwd)), false, 'an absent config stays absent');
};

const assertUnmintedRefusal = (cwd, before, result) => {
  assert.equal(result.code, 1, out(result));
  assert.ok(result.stdout.includes(MINT_COMMAND(cwd)), `the unminted refusal names the mint:${NL}${result.stdout}`);
  assert.doesNotMatch(result.stdout, /--adopt/);
  assert.doesNotMatch(result.stdout, /no longer holds/, 'an unminted config is refused as unminted, never as outgrown');
  assert.deepEqual(bytesOf(cwd), before, 'a refusal writes nothing');
};

const assertOutgrownRefusal = (cwd, before, result) => {
  assert.equal(result.code, 1, out(result));
  assert.match(bodyLines(result)[0], OUTGROWN_LEAD, `the refusal is led by its own line:${NL}${result.stdout}`);
  assert.ok(result.stdout.includes('src: aggregate lines 451 → 461 (raise)'), `the projected drift is listed:${NL}${result.stdout}`);
  assert.ok(result.stdout.includes(`--write-baseline --cwd "${cwd}" --reason`), `the drift's own lane is named:${NL}${result.stdout}`);
  assert.doesNotMatch(result.stdout, /--adopt/);
  assert.deepEqual(bytesOf(cwd), before, 'a refusal writes nothing');
};

describe('spec:source-size/S21 --override writes the override and regenerates the record in one write, or refuses', () => {
  it('a tighten writes the override and records the files it puts over the new value, with the override reason, in the same write', () => {
    const cwd = project();
    const result = override(cwd, ['lines-per-file', '--value', '8', '--reason', 'tighter files']);
    assert.deepEqual(limitsOf(result), [`${LIMIT_PREFIX}lines-per-file 8, tolerance 10% — from override: tighter files`, ...KIT_TAIL], out(result));
    assert.equal(result.code, 0, out(result));
    const written = configOf(cwd);
    assert.deepEqual(written.limits, { 'lines-per-file': { value: 8, tolerance: 10, reason: 'tighter files' } }, 'the left-out tolerance keeps the kit value');
    assert.deepEqual(written.baseline, {
      'src/a.mjs': { lines: 10, reason: 'tighter files' },
      'src/big.mjs': { lines: 441, reason: INITIAL_ADOPTION_REASON },
    }, 'the reason lands only on the raise the new value causes: 10 lines are past the band of 8');
    assert.deepEqual(written.aggregate, RECORD.aggregate, 'an entry the change did not raise keeps its own reason');
    assert.deepEqual(Object.keys(written), KEYS_AFTER_OVERRIDE);
    assert.ok(result.stdout.includes(`source-size: override of lines-per-file written in ${configPath(cwd)} — reason: tighter files`), result.stdout);
    assert.ok(result.stdout.includes('src/a.mjs: lines none → 10 (raise)'), result.stdout);
    assert.match(result.stdout, /^reason: tighter files$/m);
    assert.equal(check(cwd).code, 0, 'the one write left a record that holds under the new value');
  });

  it('a tighten that puts no file over the new value changes no record, and re-applying it writes nothing', () => {
    const cwd = project();
    const result = override(cwd, ['lines-per-file', '--value', '300', '--reason', 'tighter files']);
    assert.equal(result.code, 0, out(result));
    const written = configOf(cwd);
    assert.deepEqual(written.limits, { 'lines-per-file': { value: 300, tolerance: 10, reason: 'tighter files' } });
    assert.deepEqual({ baseline: written.baseline, aggregate: written.aggregate }, RECORD);
    assert.doesNotMatch(result.stdout, /→/, `no record value changed, so no delta is printed:${NL}${result.stdout}`);
    const before = bytesOf(cwd);
    const again = override(cwd, ['lines-per-file', '--value', '300', '--reason', 'tighter files']);
    assert.equal(again.code, 0, out(again));
    assert.deepEqual(bytesOf(cwd), before, 'what the file already holds is not written again');
  });

  it('--kit-default removes the override, regenerating under the kit value, and drops a limits key it leaves empty', () => {
    const cwd = project({
      config: CONFIG({ limits: { ...WIDE, depth: { value: 7, tolerance: 0, reason: 'deeper' } }, baseline: {}, aggregate: RECORD.aggregate }),
    });
    const first = override(cwd, ['depth', '--kit-default', '--reason', 'flat again']);
    assert.ok(limitsOf(first).includes(`${LIMIT_PREFIX}depth 5, tolerance 0% — from kit`), `the removed override's limit states the kit:${NL}${first.stdout}`);
    assert.equal(first.code, 0, out(first));
    assert.deepEqual(configOf(cwd).limits, WIDE, 'only the named override is removed');
    assert.ok(first.stdout.includes(`source-size: depth follows the kit's numbers in ${configPath(cwd)} — reason: flat again`), first.stdout);
    const second = override(cwd, ['lines-per-file', '--kit-default', '--reason', 'back to kit']);
    assert.equal(second.code, 0, out(second));
    const written = configOf(cwd);
    assert.equal(Object.hasOwn(written, 'limits'), false, `an emptied limits key is dropped:${NL}${readFileSync(configPath(cwd), 'utf8')}`);
    assert.deepEqual(written.baseline, { 'src/big.mjs': { lines: 441, reason: 'back to kit' } }, 'the raise the removal causes carries its reason');
    assert.deepEqual(written.aggregate, RECORD.aggregate);
    assert.deepEqual(limitsOf(second), [`${LIMIT_PREFIX}lines-per-file 400, tolerance 10% — from kit`, ...KIT_TAIL], second.stdout);
    assert.equal(check(cwd).code, 0);
  });

  it('an option left out keeps the current resolved value or tolerance — the override one, else the kit one', () => {
    const kit = project();
    const fromKit = override(kit, ['lines-per-file', '--tolerance', '5', '--reason', 'narrow band']);
    assert.equal(fromKit.code, 0, out(fromKit));
    assert.deepEqual(configOf(kit).limits, { 'lines-per-file': { value: 400, tolerance: 5, reason: 'narrow band' } });

    const own = project({ config: CONFIG({ limits: WIDE, baseline: {}, aggregate: RECORD.aggregate }) });
    const valueKept = override(own, ['lines-per-file', '--tolerance', '5', '--reason', 'narrow band']);
    assert.equal(valueKept.code, 0, out(valueKept));
    assert.deepEqual(configOf(own).limits, { 'lines-per-file': { value: 500, tolerance: 5, reason: 'narrow band' } });
    const toleranceKept = override(own, ['lines-per-file', '--value', '450', '--reason', 'a little tighter']);
    assert.equal(toleranceKept.code, 0, out(toleranceKept));
    assert.deepEqual(configOf(own).limits, { 'lines-per-file': { value: 450, tolerance: 5, reason: 'a little tighter' } });

    const perRoot = project();
    const tolerance = override(perRoot, ['files-per-root', '--tolerance', '20', '--reason', 'wider band']);
    assert.equal(tolerance.code, 0, out(tolerance));
    assert.deepEqual(configOf(perRoot).limits, { 'files-per-root': { tolerance: 20, reason: 'wider band' } }, 'files-per-root holds no value');
  });

  it('on a schema-1 config the same write moves it to schema 2, the records carried and a differing default an override', () => {
    const cwd = project({ config: SCHEMA1({ defaults: { maxLines: 300, maxLineBytes: 1000 }, ...RECORD }) });
    const result = override(cwd, ['depth', '--value', '7', '--reason', 'deeper']);
    assert.equal(result.code, 0, out(result));
    const written = configOf(cwd);
    assert.equal(written.schema, 2);
    assert.equal(Object.hasOwn(written, 'defaults'), false, 'the schema-1 key is gone');
    assert.deepEqual(written.limits, {
      'lines-per-file': { value: 300, tolerance: 10, reason: 'carried from schema 1' },
      depth: { value: 7, tolerance: 0, reason: 'deeper' },
    });
    assert.deepEqual(Object.keys(written), ['_README', 'schema', 'limits', 'roots', 'exclude', 'extensions', 'baseline', 'aggregate']);
    assert.equal(written._README, README);
    assert.deepEqual({ baseline: written.baseline, aggregate: written.aggregate }, RECORD);
    assert.ok(result.stdout.includes(`source-size: ${configPath(cwd)} moved from schema 1 to schema 2`), result.stdout);
    assert.ok(result.stdout.includes(`source-size: override of depth written in ${configPath(cwd)} — reason: deeper`), result.stdout);
    assert.equal(check(cwd).code, 0, 'the moved file is a schema-2 record the check judges green');
  });

  it('every line states the written file: a carried override the same write removes, and a --kit-default with none held', () => {
    const moved = project({ config: SCHEMA1({ defaults: { maxLines: 300, maxLineBytes: 1000 }, ...RECORD }) });
    const result = override(moved, ['lines-per-file', '--kit-default', '--reason', 'r']);
    assert.equal(result.code, 0, out(result));
    assert.equal(Object.hasOwn(configOf(moved), 'limits'), false);
    assert.ok(result.stdout.includes(`source-size: ${configPath(moved)} moved from schema 1 to schema 2 in this write.`), result.stdout);
    assert.ok(result.stdout.includes(`source-size: lines-per-file follows the kit's numbers in ${configPath(moved)} — reason: r`), result.stdout);
    assert.doesNotMatch(result.stdout, /carried from schema 1/);
    const none = project();
    const reformatted = override(none, ['depth', '--kit-default', '--reason', 'r']);
    assert.equal(reformatted.code, 0, out(reformatted));
    assert.ok(reformatted.stdout.includes(`source-size: depth follows the kit's numbers in ${configPath(none)} — reason: r`), reformatted.stdout);
    assert.doesNotMatch(reformatted.stdout, /removed/);
  });

  it('an absent config renders the absent refusal: exit 1, no limit line, and it stays absent', () => {
    const cwd = project({ config: null });
    assertAbsentRefusal(cwd, override(cwd, ['depth', '--value', '7', '--reason', 'deeper']));
  });

  it('an unminted config renders the unminted refusal naming --write-baseline with its reason, never --adopt: exit 1, byte-unchanged', () => {
    const authored = project({ config: CONFIG() });
    assertUnmintedRefusal(authored, bytesOf(authored), override(authored, ['depth', '--value', '7', '--reason', 'deeper']));
    const half = project({ config: CONFIG({ baseline: RECORD.baseline }) });
    const before = bytesOf(half);
    const result = override(half, ['depth', '--value', '7', '--reason', 'deeper']);
    assert.equal(result.code, 1, out(result));
    assert.match(result.stdout, /--write-baseline/);
    assert.doesNotMatch(result.stdout, /--adopt/);
    assert.deepEqual(bytesOf(half), before, 'a half-minted config is refused byte-unchanged');
  });

  it('a minted record the tree outgrew is refused before any override, so the reason never lands on drift it did not cause; a warning is no drift', () => {
    const banded = project({ files: { ...FILES, 'src/near.mjs': lines(420) }, config: CONFIG({ baseline: RECORD.baseline, aggregate: { src: { lines: 871, reason: 'r' } } }) });
    const proceeded = override(banded, ['depth', '--value', '7', '--reason', 'deeper']);
    assert.equal(proceeded.code, 0, `a file within its band raises nothing, so the record still holds:${NL}${out(proceeded)}`);
    assert.equal(Object.hasOwn(configOf(banded).baseline, 'src/near.mjs'), false, 'the regeneration records no file within its band');
    const cwd = grownProject();
    assertOutgrownRefusal(cwd, bytesOf(cwd), override(cwd, ['depth', '--value', '7', '--reason', 'deeper']));
    assertOutgrownRefusal(cwd, bytesOf(cwd), override(cwd, ['lines-per-file', '--value', '8', '--reason', 'tighter files']));
  });

  it('the state refusals come absent, then unminted, then outgrown, and the equality stop only after them', () => {
    const equal = ['depth', '--value', '5', '--tolerance', '0', '--reason', 'r'];
    const absent = project({ config: null });
    assertAbsentRefusal(absent, override(absent, equal));
    const authored = project({ config: CONFIG() });
    assertUnmintedRefusal(authored, bytesOf(authored), override(authored, equal));
    const grown = grownProject();
    assertOutgrownRefusal(grown, bytesOf(grown), override(grown, equal));
  });
});

const assertUsage = (cwd, before, args, expected) => {
  const result = override(cwd, args);
  assert.match(result.stderr, expected, `${args.join(' ')}:${NL}${out(result)}`);
  assert.equal(result.code, 2, `${args.join(' ')}: ${out(result)}`);
  assert.equal(result.stdout, '', `a usage error prints no limit line: ${args.join(' ')}`);
  assert.deepEqual(bytesOf(cwd), before, `a usage error writes nothing: ${args.join(' ')}`);
};

const twoLines = ['a', 'b'].join(NL);
const ARGUMENT_USAGE = [
  [['nope', '--value', '7', '--reason', 'r'], /"nope" names no kit limit/],
  [[], /--override needs a value/],
  [['files-per-root', '--value', '7', '--reason', 'r'], /files-per-root takes --tolerance only/],
  [['files-per-root', '--value', '7', '--tolerance', '20', '--reason', 'r'], /files-per-root takes --tolerance only/],
  [['depth', '--reason', 'r'], /--override depth needs --value, --tolerance or --kit-default/],
  ...['x', '0', '-1', '1.5', ''].map((raw) => [['depth', '--value', raw, '--reason', 'r'], /--value must be a positive integer/]),
  ...['101', '-1', 'x', '2.5', ''].map((raw) => [['depth', '--tolerance', raw, '--reason', 'r'], /--tolerance must be an integer percent from 0 to 100/]),
  [['depth', '--kit-default', '--value', '6', '--reason', 'r'], /--kit-default .*takes no --value or --tolerance/],
  [['depth', '--kit-default', '--tolerance', '6', '--reason', 'r'], /--kit-default .*takes no --value or --tolerance/],
  [['depth', '--value', '7'], /--override needs --reason/],
  [['depth', '--kit-default'], /--override needs --reason/],
  ...['', twoLines].map((reason) => [['depth', '--value', '7', '--reason', reason], new RegExp(reasonDefect(reason).split('(')[0])]),
  ...['--check', '--write-baseline', '--adopt'].map((mode) => [['depth', '--value', '7', '--reason', 'r', mode], new RegExp(`exactly ONE mode, got: --override, ${mode}`)]),
];

describe('spec:source-size/S22 --override usage errors exit 2, print no limit line and write nothing', () => {
  it('every error the argument list alone decides, on a minted config and on an absent one', () => {
    const minted = project();
    const before = bytesOf(minted);
    const absent = project({ config: null });
    for (const [args, expected] of ARGUMENT_USAGE) {
      assertUsage(minted, before, args, expected);
      assertUsage(absent, null, args, expected);
    }
  });

  it('a filled pair equal to the kit one, on a minted config whose projection raises nothing, names --kit-default', () => {
    const minted = project();
    const before = bytesOf(minted);
    const equality = /--override [a-z-]+ equals the kit's own numbers — pass --kit-default/;
    for (const args of [
      ['depth', '--value', '5', '--tolerance', '0', '--reason', 'r'],
      ['depth', '--value', '5', '--reason', 'r'],
      ['depth', '--tolerance', '0', '--reason', 'r'],
      ['lines-per-file', '--value', '400', '--tolerance', '10', '--reason', 'r'],
      ['lines-per-file', '--value', '400', '--reason', 'r'],
      ['files-per-root', '--tolerance', '10', '--reason', 'r'],
    ]) assertUsage(minted, before, args, equality);

    const own = project({ config: CONFIG({ limits: { 'lines-per-file': { value: 500, tolerance: 10, reason: 'wide' } }, baseline: {}, aggregate: RECORD.aggregate }) });
    assertUsage(own, bytesOf(own), ['lines-per-file', '--value', '400', '--reason', 'r'], equality);
  });

  it('the override options on --check, --write-baseline and --adopt are usage errors too', () => {
    const cwd = project();
    const before = bytesOf(cwd);
    for (const mode of ['--check', '--write-baseline', '--adopt']) {
      for (const option of [['--value', '7'], ['--tolerance', '5'], ['--kit-default']]) {
        const result = main([mode, ...option, '--cwd', cwd]);
        const label = `${mode} ${option.join(' ')}`;
        assert.match(result.stderr, new RegExp(`${option[0]} belongs to --override`), `${label}:${NL}${out(result)}`);
        assert.equal(result.code, 2, label);
        assert.equal(result.stdout, '', `a usage error prints no limit line: ${label}`);
        assert.deepEqual(bytesOf(cwd), before, `a usage error writes nothing: ${label}`);
      }
    }
  });
});
