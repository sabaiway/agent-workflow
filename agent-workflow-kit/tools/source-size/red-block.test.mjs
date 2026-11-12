import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { composeRedBlock } from '../../references/scripts/shared/index.mjs';
import { judgeBlock, judgeVerdictLine } from '../checker-verdict/index.mjs';
import { main, runCheck } from '../source-size-check.mjs';
import { SOURCE_SIZE_DEFAULTS, SOURCE_SIZE_WHY, escapeForLine, validateSourceSizeConfig } from '../source-size-core.mjs';
import { SOURCE_SIZE_TOOL_PATH } from '../source-size-gate-cmd.mjs';
import { GROWTH_REASON_PLACEHOLDER, notJudgedLines, schema1MovedLines, statedLimitLines } from '../source-size-report.mjs';
import { configPath, createProject, makeLines, makeMany, readBlock, runCli, runGit } from './cli-harness.test.mjs';

const NAME = 'source-size';
const FAIL = 'source-size: FAIL — ';
const REMEDY = 'source-size: REMEDY — ';
const PREFIX = '[agent-workflow-kit] ';
const WHY = `source-size: WHY — ${SOURCE_SIZE_WHY}`;
const SCOPE_REMEDY = 'fix the tree condition the verdict line names, then re-run';
const CONFIG_REMEDY = 'fix the size config or the git index error the verdict line names, then re-run';
const ERROR_REMEDY = 'fix the cause the stack below names, then re-run';
const RAISE = 'This regeneration RAISES a recorded value, so the reason is REQUIRED — it is recorded in the entry it raises, and it is what the commit message and the CHANGELOG restate.';
const HAND = 'Or record each size by hand under "baseline" — the validator accepts exactly these bytes:';
const WITHHELD = 'Run the regenerator yourself with the working directory set to this project (source-size-check.mjs --write-baseline, plus --reason "<text>" for any raise), or record each size by hand below.';
const FOCUS = 'source-size: REVIEW FOCUS — a recorded size went DOWN or disappeared: check that this is real decomposition and not the same coupling spread across more files (paste this line into the review dispatch focus).';
const AUTHORED = { schema: 2, roots: ['src'], extensions: ['.mjs'] };
const mintConfig = (over = {}) => ({ ...AUTHORED, baseline: {}, aggregate: { src: { lines: 861, reason: 'fixture' } }, ...over });
const makeSchema1Config = () => ({ ...mintConfig({ aggregate: { src: { lines: 1, reason: 'fixture' } } }), schema: 1, defaults: { ...SOURCE_SIZE_DEFAULTS } });
const FILES = { 'src/big.mjs': makeLines(441), 'src/near.mjs': makeLines(420) };
const BIG = 'src/big.mjs: lines 441 exceeds the declared default 400 beyond its band (up to 440)';
const WARNING = 'source-size: WARNING — src/near.mjs: lines 420 is over the limit 400 but within its band (up to 440) — no record is kept; past 440 it stops';
const ENTRY = `  "src/big.mjs": { "lines": 441, "reason": "${GROWTH_REASON_PLACEHOLDER}" }`;
const regenerate = (cwd) => `node "${SOURCE_SIZE_TOOL_PATH}" --write-baseline --cwd "${cwd}" --reason "${GROWTH_REASON_PLACEHOLDER}"`;
const checkLead = (cwd, config, absent = false) => [...statedLimitLines(validateSourceSizeConfig(config)), ...notJudgedLines(cwd, { config: validateSourceSizeConfig(config), absent, layout: absent || Object.hasOwn(config, 'layout') })];
const assertBlock = (result, places, expected, code = 1) => {
  assert.deepEqual([result.code, result.stderr], [code, ''], result.stdout);
  assert.deepEqual(judgeBlock(result.stdout, { name: NAME, places }), [], result.stdout);
  assert.deepEqual(readBlock(result.stdout), expected);
  assert.equal(result.stdout, [FAIL + expected.verdict, ...expected.findings, ...expected.remedies.map((text) => REMEDY + text), ...expected.after].join('\n'));
};
const readThrown = (run) => {
  const errors = [];
  assert.throws(run, (error) => { errors.push(error); return true; });
  assert.ok(errors[0].message.startsWith(PREFIX));
  return errors[0].message.slice(PREFIX.length).replace(/^ /, '\\u0020');
};

describe('spec:source-size/S57 check stops put verdict, findings and remedy before limits, notes and warnings', () => {
  it('a minted file stop keeps the empty root, warning and whole hand record in order', () => {
    const config = mintConfig({ roots: ['src', 'empty'], aggregate: { src: { lines: 861, reason: 'fixture' }, empty: { lines: 0, reason: 'fixture' } } });
    const files = { ...FILES, 'src/big.mjs': `${'x'.repeat(1001)}\n${makeLines(440)}` };
    const cwd = createProject({ files, config });
    assertBlock(runCli(cwd, '--check'), ['src/big.mjs', 'src/big.mjs'], {
      verdict: `2 finding(s) against ${escapeForLine(configPath(cwd))}`,
      findings: [BIG, 'src/big.mjs: maxLineBytes 1001 exceeds the declared default 1000 beyond its band (up to 1000)'], remedies: [regenerate(cwd)],
      after: [...checkLead(cwd, config), 'source-size: NOTE — the declared root "empty" matches no tracked file with a declared extension', WARNING, RAISE, HAND, `  "src/big.mjs": { "lines": 441, "maxLineBytes": 1001, "reason": "${GROWTH_REASON_PLACEHOLDER}" }`, WHY],
    });
  });

  it('an absent config stops only on its directory beyond the band', () => {
    const cwd = createProject({ files: makeMany('wide', 23) });
    assertBlock(runCli(cwd, '--check'), ['wide'], {
      verdict: `1 finding(s) under the kit's values (${escapeForLine(configPath(cwd))} is absent)`,
      findings: ['wide: entries 23 exceeds the limit 20 beyond its band (up to 22)'], remedies: [regenerate(cwd)],
      after: [...checkLead(cwd, { schema: 2 }, true), RAISE, WHY],
    });
  });

  it('a withheld command is the remedy and its diagnosis follows the warning', () => {
    for (const [suffix, diagnosis] of [
      ['$', "source-size: no paste-ready command is printed — this project's path does not survive double-quoting, so a rendered command could run somewhere other than the project it names."],
      ['\u2028', "source-size: no paste-ready command is printed — this project's path carries a character that cannot appear in a rendered line, and escaping it would change the path the shell receives."],
    ]) {
      const config = mintConfig();
      const cwd = createProject({ files: FILES, config }, suffix);
      assertBlock(runCli(cwd, '--check'), ['src/big.mjs'], {
        verdict: `1 finding(s) against ${escapeForLine(configPath(cwd))}`, findings: [BIG], remedies: [WITHHELD],
        after: [...checkLead(cwd, config), WARNING, diagnosis, ENTRY, WHY],
      });
    }
  });

  it('a lowered record beside a stop puts REVIEW FOCUS immediately before WHY', () => {
    const config = mintConfig({ baseline: { 'src/near.mjs': { lines: 450, reason: 'fixture' } } });
    const cwd = createProject({ files: FILES, config });
    assertBlock(runCli(cwd, '--check'), ['src/big.mjs'], {
      verdict: `1 finding(s) against ${escapeForLine(configPath(cwd))}`, findings: [BIG], remedies: [regenerate(cwd)],
      after: [...checkLead(cwd, config), 'source-size: WARNING — src/near.mjs: lines 420 is within its band (up to 440), so its record is obsolete — the regeneration removes it', RAISE, HAND, ENTRY, FOCUS, WHY],
    });
  });
});

describe('spec:source-size/S58 finding places preserve safe paths and put every other target in the text at .', () => {
  it('file, root and directory places compose, and hostile targets keep their escaped text', async () => {
    const { checkStopBlock } = await import('../source-size-report.mjs');
    assert.equal(typeof checkStopBlock, 'function');
    const cwd = resolve('source-size-fixture');
    const cases = [
      ['src/big.mjs', 'rel', 'src/big.mjs'], ['src', 'root', 'src'], ['src/wide', 'dir', 'src/wide'], ['.', 'root', '.'],
      ...['src/a\tb.mjs', 'src/a\nb.mjs', 'src/a\\b.mjs', 'src/a:b.mjs', ' leading.mjs'].map((target) => [target, 'rel', '.']),
      ['source-size', 'root', '.'],
    ];
    for (const [target, field, place] of cases) {
      const text = field === 'rel' ? 'lines 441 exceeds the declared default 400 beyond its band (up to 440)'
        : field === 'root' ? 'aggregate lines 441 exceeds the recorded budget 440 — splitting a file buys no aggregate headroom'
          : 'entries 23 exceeds the limit 20 beyond its band (up to 22)';
      const finding = { kind: field === 'rel' ? 'over-default' : field === 'root' ? 'aggregate-grew' : 'dir-over', severity: 'stop', [field]: target, dimension: field === 'dir' ? 'entries' : 'lines', actual: field === 'dir' ? 23 : 441, allowed: field === 'dir' ? 20 : 400, ceiling: field === 'dir' ? 22 : 440, recorded: 440 };
      const verdict = { findings: [finding], scope: { files: [], emptyRoots: [], kitFolderRoots: [] }, projected: new Map([[target, { lines: 441 }]]) };
      const parts = checkStopBlock({ cwd, verdict, absent: false });
      const escaped = escapeForLine(target).replace(/^ /, '\\u0020');
      const fallback = place === '.' && target !== '.';
      assert.deepEqual(parts.findings, [{ place, text: fallback ? `${escaped}: ${text}` : text }]);
      const stdout = composeRedBlock({ name: NAME, ...parts, after: [...checkLead(cwd, mintConfig()), ...parts.after] }).join('\n');
      assert.deepEqual(judgeBlock(stdout, { name: NAME, places: [place] }), [], stdout);
      assert.equal(readBlock(stdout).findings[0], `${place}: ${fallback ? `${escaped}: ` : ''}${text}`);
      assert.ok(stdout.includes(escaped));
      if (target.startsWith(' ')) assert.equal(parts.findings[0].text.slice(0, 6), '\\u0020');
    }
  });
});

describe('spec:source-size/S59 thrown stops retain their message and exit class and carry the move after the remedy', () => {
  it('scope stops in all four modes escape a tracked path opening with a space', () => {
    const config = mintConfig({ roots: ['.'], aggregate: { '.': { lines: 1, reason: 'fixture' } } });
    const cwd = createProject({ files: { ' broken.mjs': Buffer.from([0x61, 0xff, 0x0a]) }, config });
    const verdict = readThrown(() => runCheck({ cwd }));
    assert.equal(verdict.slice(0, 6), '\\u0020');
    for (const args of [['--check'], ['--write-baseline'], ['--adopt'], ['--override', 'depth', '--value', '6', '--reason', 'fixture']]) {
      assertBlock(runCli(cwd, ...args), [], { verdict, findings: [], remedies: [SCOPE_REMEDY], after: [] });
    }
  });

  it('a config error keeps its message and exits 2 without findings or WHY', () => {
    const cwd = createProject({ config: { schema: 2, roots: [] } });
    const verdict = readThrown(() => runCheck({ cwd }));
    assertBlock(runCli(cwd, '--check'), [], { verdict, findings: [], remedies: [CONFIG_REMEDY], after: [] }, 2);
  });

  it('a project with no git index keeps its enumeration message and exits 2', (context) => {
    const cwd = mkdtempSync(join(tmpdir(), 'aw-source-size-no-index-'));
    context.after(() => rmSync(cwd, { recursive: true, force: true }));
    mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
    writeFileSync(configPath(cwd), JSON.stringify(mintConfig()));
    const verdict = readThrown(() => runCheck({ cwd }));
    assert.match(verdict, /the git index could not be enumerated/);
    assertBlock(runCli(cwd, '--check'), [], { verdict, findings: [], remedies: [CONFIG_REMEDY], after: [] }, 2);
  });

  it('a scope stop after --adopt moved schema 1 prints the move after its remedy', () => {
    const cwd = createProject({ files: { 'src/a.mjs': makeLines(1) }, config: makeSchema1Config() });
    runGit(cwd, ['rm', '-q', '--cached', 'src/a.mjs']);
    const result = runCli(cwd, '--adopt');
    assert.equal(JSON.parse(readFileSync(configPath(cwd), 'utf8')).schema, 2);
    const verdict = readThrown(() => runCheck({ cwd }));
    assertBlock(result, [], { verdict, findings: [], remedies: [SCOPE_REMEDY], after: schema1MovedLines(cwd) });
  });
});

describe('spec:source-size/S60 usage refusals lead with an escaped verdict and only the six help usage lines', () => {
  it('every mode and no mode refuse with the exact usage lines, including an argument with a line break', () => {
    const help = main(['--help']).stdout.split('\n');
    const usage = help.slice(help.indexOf('Usage:'), help.indexOf('Usage:') + 6);
    for (const [args, message] of [
      [[], 'nothing to do — pass one of --check, --write-baseline, --adopt, --override (see --help)'],
      ...['--check', '--write-baseline', '--adopt', '--override'].map((mode) => [[mode, ...(mode === '--override' ? ['depth'] : []), 'bad\nargument'], 'unknown argument: bad\nargument']),
    ]) {
      const result = main(args);
      assert.deepEqual([result.code, result.stderr], [2, '']);
      assert.equal(judgeVerdictLine(result.stdout.split('\n')[0], NAME), true);
      assert.deepEqual(result.stdout.split('\n'), [FAIL + escapeForLine(message), ...usage]);
      assert.doesNotMatch(result.stdout, /^source-size: (?:REMEDY|limit) /m);
    }
  });

  it('--help states the stopped check order and the unexpected-error exit code', () => {
    const help = main(['--help']);
    assert.deepEqual([help.code, help.stderr], [0, '']);
    const text = help.stdout.replace(/\s+/g, ' ');
    assert.ok(text.includes('a --check that stops opens instead with its verdict line, its findings and its remedy, its limits, notes and warnings after them'));
    assert.ok(text.includes('2 usage, config or enumeration error, or an unexpected error'));
  });
});

describe('spec:source-size/S61 the guarded entry renders unexpected errors and appends carried move lines after the stack', () => {
  it('a numeric ctx.cwd reaches the guard in all four modes', async () => {
    const { guardedMain } = await import('../source-size-check.mjs');
    assert.equal(typeof guardedMain, 'function');
    const errors = [];
    assert.throws(() => resolve(42), (error) => { errors.push(error); return true; });
    for (const mode of ['--check', '--write-baseline', '--adopt', '--override']) {
      const result = guardedMain([mode], { cwd: 42 });
      const block = readBlock(result.stdout);
      assertBlock(result, [], { verdict: `unexpected error: ${errors[0].message.split('\n')[0]}`, findings: [], remedies: [ERROR_REMEDY], after: block.after }, 2);
      assert.equal(block.after[0], errors[0].stack.split('\n')[0]);
      assert.ok(block.after.length > 1 && block.after.slice(1).every((line) => /^\s+at /.test(line)), result.stdout);
      assert.doesNotMatch(result.stdout, /source-size: WHY/);
    }
  });

  it('an unexpected error after the on-disk schema-1 move keeps the stack and puts the move last', async () => {
    const { guardedMain } = await import('../source-size-check.mjs');
    assert.equal(typeof guardedMain, 'function');
    const cwd = createProject({ files: { 'src/a.mjs': makeLines(1) }, config: makeSchema1Config() });
    const error = new Error('after the schema-1 move\nsecond line');
    const deps = { get readFile() {
      if (JSON.parse(readFileSync(configPath(cwd), 'utf8')).schema === 2) throw error;
      return readFileSync;
    } };
    const result = guardedMain(['--adopt', '--cwd', cwd], { deps });
    assert.equal(JSON.parse(readFileSync(configPath(cwd), 'utf8')).schema, 2);
    assertBlock(result, [], { verdict: 'unexpected error: after the schema-1 move', findings: [], remedies: [ERROR_REMEDY], after: [...error.stack.split('\n'), ...schema1MovedLines(cwd)] }, 2);
  });
});
