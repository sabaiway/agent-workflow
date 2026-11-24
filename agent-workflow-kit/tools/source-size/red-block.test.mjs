import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { composeRedBlock } from '../../references/scripts/shared/index.mjs';
import { judgeBlock, judgeVerdictLine } from '../checker-verdict/index.mjs';
import { main } from '../source-size-check.mjs';
import { runCheck } from '../source-size-runs.mjs';
import { SOURCE_SIZE_DEFAULTS, SOURCE_SIZE_WHY, escapeForLine, validateSourceSizeConfig } from '../source-size-core.mjs';
import { SOURCE_SIZE_TOOL_PATH } from '../source-size-gate-cmd.mjs';
import { GROWTH_REASON_PLACEHOLDER, notJudgedLines, statedLimitLines } from '../source-size-report.mjs';
import { INITIAL_ADOPTION_REASON } from './index.mjs';
import {
  CODE_RULE_QUESTION_LINES as QUESTIONS, HAND_RECORD_REMEDY_LINES as HAND_REMEDIES, RECORDED_EXCEPTION_ENDING,
  configPath, createProject, makeLines, makeMany, readBlock, runCli, runGit,
} from './cli-harness.test.mjs';

const NAME = 'source-size';
const FAIL = 'source-size: FAIL — ';
const REMEDY = 'source-size: REMEDY — ';
const PREFIX = '[agent-workflow-kit] ';
const WHY = `source-size: WHY — ${SOURCE_SIZE_WHY}`;
const SCOPE_REMEDY = 'fix the tree condition the verdict line names, then re-run';
const CONFIG_REMEDY = 'fix the size config or the git index error the verdict line names, then re-run';
const ERROR_REMEDY = 'fix the cause the stack below names, then re-run';
const RAISE = 'This regeneration RAISES a recorded value, so the reason is REQUIRED — it is recorded in the entry it raises, and it is what the commit message and the CHANGELOG restate.';
const HAND = "Each placeholder below is replaced by that file's own reason; the validator accepts the rest of these bytes as they are:";
const WITHHELD = 'Run the regenerator yourself with the working directory set to this project (source-size-check.mjs --write-baseline, plus --reason "<text>" for any raise).';
const WITHHELD_SHELL = "source-size: no paste-ready command is printed — this project's path does not survive double-quoting, so a rendered command could run somewhere other than the project it names.";
const WITHHELD_LINE = "source-size: no paste-ready command is printed — this project's path carries a character that cannot appear in a rendered line, and escaping it would change the path the shell receives.";
const FOCUS = 'source-size: REVIEW FOCUS — a recorded size went DOWN or disappeared: check that this is real decomposition and not the same coupling spread across more files (paste this line into the review dispatch focus).';
const HAND_FOCUS = "source-size: REVIEW FOCUS — the entries above RAISE a recorded size once recorded by hand: give the review each one's recorded and new value and its reason, read each reason and judge whether the project's code rules were kept for that file; a reason naming a debt row holds an old file grown outside its story's scope (paste this line into the review dispatch focus).";
const AUTHORED = { schema: 2, roots: ['src'], extensions: ['.mjs'] };
const mintConfig = (over = {}) => ({ ...AUTHORED, baseline: {}, aggregate: { src: { lines: 861, reason: 'fixture' } }, ...over });
const makeSchema1Config = () => ({ ...mintConfig({ aggregate: { src: { lines: 1, reason: 'fixture' } } }), schema: 1, defaults: { ...SOURCE_SIZE_DEFAULTS } });
const MINTED = { ...AUTHORED, schema: 3, baseline: {} };
const UNRECORDED_ROOT_CONFIG = { ...MINTED, layout: { roots: {}, directories: {} } };
const ROOT_GROWTH_CONFIG = {
  ...MINTED,
  layout: { roots: { src: { files: 1, reason: 'fixture' } }, directories: {} },
};
const ROOT_GROWTH_FILES = { 'src/a.mjs': 'x', 'src/b.mjs': 'x', 'src/c.mjs': 'x' };
const FILES = { 'src/big.mjs': makeLines(441), 'src/near.mjs': makeLines(420) };
const BIG = 'src/big.mjs: lines 441 exceeds the declared default 400 beyond its band (up to 440)';
const WIDE = 'wide: entries 23 exceeds the limit 20 beyond its band (up to 22)';
const ROOT_GROWTH = 'src: files 3 exceeds its recorded 1 beyond its band (up to 2)';
const UNRECORDED_ROOT = 'src: declared root carries NO recorded files count (1 files measured) — the layout record must mirror the declared roots exactly';
const WARNING = 'source-size: WARNING — src/near.mjs: lines 420 is over the limit 400 but within its band (up to 440) — no record is kept; past 440 it stops';
const OBSOLETE = 'source-size: WARNING — src/near.mjs: lines 420 is within its band (up to 440), so its record is obsolete — the regeneration removes it';
const ENTRY = `  "src/big.mjs": { "lines": 441, "reason": "${GROWTH_REASON_PLACEHOLDER}" }`;
const regenerateCommand = (cwd) => `node "${SOURCE_SIZE_TOOL_PATH}" --write-baseline --cwd "${cwd}"`;
const regenerate = (cwd, reason = GROWTH_REASON_PLACEHOLDER) => `${regenerateCommand(cwd)} --reason "${reason}"`;
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
const assertQuestions = (cwd, finding) => {
  const result = runCli(cwd, '--check');
  assert.deepEqual([result.code, result.stderr], [1, ''], result.stdout);
  const block = readBlock(result.stdout);
  assert.deepEqual(block.remedies.slice(0, QUESTIONS.length), QUESTIONS, result.stdout);
  assert.deepEqual(block.findings, [finding], result.stdout);
};
const assertNoHandRecord = (stdout) => {
  assert.doesNotMatch(stdout, /^  "/m);
  for (const line of [...HAND_REMEDIES, HAND, HAND_FOCUS]) {
    assert.ok(!stdout.includes(line), stdout);
  }
};

describe('spec:source-size/S57 check stops put verdict, findings and remedy before limits, notes and warnings', () => {
  it('a minted file stop keeps the empty root, warning and whole hand record in order', () => {
    const { aggregate, ...config } = mintConfig({ roots: ['src', 'empty'] });
    const files = { ...FILES, 'src/big.mjs': `${'x'.repeat(1001)}\n${makeLines(440)}` };
    const cwd = createProject({ files, config });
    assertBlock(runCli(cwd, '--check'), ['src/big.mjs', 'src/big.mjs'], {
      verdict: `2 finding(s) against ${escapeForLine(configPath(cwd))}`,
      findings: [BIG, 'src/big.mjs: maxLineBytes 1001 exceeds the declared default 1000 beyond its band (up to 1000)'],
      remedies: [...QUESTIONS, ...HAND_REMEDIES, regenerate(cwd)],
      after: [
        ...checkLead(cwd, config),
        'source-size: NOTE — the declared root "empty" matches no tracked file with a declared extension',
        WARNING, RAISE, HAND,
        `  "src/big.mjs": { "lines": 441, "maxLineBytes": 1001, "reason": "${GROWTH_REASON_PLACEHOLDER}" }`,
        HAND_FOCUS, WHY,
      ],
    });
  });

  it('an absent config stops only on its directory beyond the band', () => {
    const cwd = createProject({ files: makeMany('wide', 23) });
    assertBlock(runCli(cwd, '--check'), ['wide'], {
      verdict: `1 finding(s) under the kit's values (${escapeForLine(configPath(cwd))} is absent)`,
      findings: [WIDE],
      remedies: [...QUESTIONS, regenerate(cwd)],
      after: [...checkLead(cwd, { schema: 2 }, true), RAISE, WHY],
    });
  });

  it('the withheld lane ends the remedies and its diagnosis follows the warning', () => {
    for (const [suffix, diagnosis] of [
      ['$', WITHHELD_SHELL],
      ['\u2028', WITHHELD_LINE],
    ]) {
      const { aggregate, ...config } = mintConfig();
      const cwd = createProject({ files: FILES, config }, suffix);
      assertBlock(runCli(cwd, '--check'), ['src/big.mjs'], {
        verdict: `1 finding(s) against ${escapeForLine(configPath(cwd))}`,
        findings: [BIG],
        remedies: [...QUESTIONS, ...HAND_REMEDIES, WITHHELD],
        after: [...checkLead(cwd, config), WARNING, diagnosis, HAND, ENTRY, HAND_FOCUS, WHY],
      });
    }
  });

  it('a lowered record beside a stop puts its REVIEW FOCUS before the hand-record focus and WHY', () => {
    const { aggregate, ...config } = mintConfig({ baseline: { 'src/near.mjs': { lines: 450, reason: 'fixture' } } });
    const cwd = createProject({ files: FILES, config });
    assertBlock(runCli(cwd, '--check'), ['src/big.mjs'], {
      verdict: `1 finding(s) against ${escapeForLine(configPath(cwd))}`,
      findings: [BIG],
      remedies: [...QUESTIONS, ...HAND_REMEDIES, regenerate(cwd)],
      after: [...checkLead(cwd, config), OBSOLETE, RAISE, HAND, ENTRY, FOCUS, HAND_FOCUS, WHY],
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
        : field === 'root' ? 'files 441 exceeds its recorded 400 beyond its band (up to 440)'
          : 'entries 23 exceeds the limit 20 beyond its band (up to 22)';
      const finding = { kind: field === 'rel' ? 'over-default' : field === 'root' ? 'root-grew' : 'dir-over', severity: 'stop', [field]: target, dimension: field === 'dir' ? 'entries' : field === 'root' ? 'files' : 'lines', actual: field === 'dir' ? 23 : 441, allowed: field === 'dir' ? 20 : 400, ceiling: field === 'dir' ? 22 : 440, recorded: 400 };
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

  it('a scope stop after --adopt moved schema 1 prints the move after its remedy', async () => {
    const { schemaMovedLines } = await import('../source-size-report.mjs');
    assert.equal(typeof schemaMovedLines, 'function');
    const cwd = createProject({ files: { 'src/a.mjs': makeLines(1) }, config: makeSchema1Config() });
    runGit(cwd, ['rm', '-q', '--cached', 'src/a.mjs']);
    const result = runCli(cwd, '--adopt');
    assert.equal(JSON.parse(readFileSync(configPath(cwd), 'utf8')).schema, 2);
    const verdict = readThrown(() => runCheck({ cwd }));
    const moved = [`source-size: ${configPath(cwd)} moved from schema 1 to schema 2 in this write; a kit that predates schema 2 stops by name until that copy is upgraded.`];
    assert.deepEqual(schemaMovedLines(cwd, 1, 2), moved);
    assertBlock(result, [], { verdict, findings: [], remedies: [SCOPE_REMEDY], after: moved });
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
    const { schemaMovedLines } = await import('../source-size-report.mjs');
    assert.equal(typeof schemaMovedLines, 'function');
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
    const moved = [`source-size: ${configPath(cwd)} moved from schema 1 to schema 2 in this write; a kit that predates schema 2 stops by name until that copy is upgraded.`];
    assert.deepEqual(schemaMovedLines(cwd, 1, 2), moved);
    assertBlock(result, [], { verdict: 'unexpected error: after the schema-1 move', findings: [], remedies: [ERROR_REMEDY], after: [...error.stack.split('\n'), ...moved] }, 2);
  });
});

describe('spec:source-size/S71 four questions open the remedy where a limit fired', () => {
  it('asks on a minted file stop and skips the questions on schema-1, unminted and thrown stops', () => {
    for (const [config, code, verdictPattern, remedy] of [
      [makeSchema1Config(), 1, /is schema 1, which the check no longer judges$/, regenerateCommand],
      [AUTHORED, 1, /is AUTHORED but not yet MINTED/, (cwd) => regenerate(cwd, INITIAL_ADOPTION_REASON)],
      [{ ...AUTHORED, roots: [] }, 2, /roots/, () => CONFIG_REMEDY],
    ]) {
      const cwd = createProject({ files: FILES, config });
      const result = runCli(cwd, '--check');
      assert.deepEqual([result.code, result.stderr], [code, ''], result.stdout);
      const block = readBlock(result.stdout);
      assert.match(block.verdict, verdictPattern);
      assert.deepEqual(block.remedies, [remedy(cwd)], result.stdout);
      for (const question of QUESTIONS) assert.ok(!result.stdout.includes(question), result.stdout);
    }

    assertQuestions(createProject({ files: FILES, config: MINTED }), BIG);
  });

  it('asks on a directory beyond its band under the kit values', () => {
    assertQuestions(createProject({ files: makeMany('wide', 23) }), WIDE);
  });

  it('asks when a layout root grows past its files band and skips the questions for an unrecorded root alone', () => {
    const cwd = createProject({ files: { 'src/a.mjs': 'x' }, config: UNRECORDED_ROOT_CONFIG });
    assertBlock(runCli(cwd, '--check'), ['src'], {
      verdict: `1 finding(s) against ${escapeForLine(configPath(cwd))}`,
      findings: [UNRECORDED_ROOT],
      remedies: [regenerate(cwd)],
      after: [...checkLead(cwd, UNRECORDED_ROOT_CONFIG), RAISE, WHY],
    });

    assertQuestions(createProject({ files: ROOT_GROWTH_FILES, config: ROOT_GROWTH_CONFIG }), ROOT_GROWTH);
  });

  it('asks when a recorded file grows beyond the size its exception holds', () => {
    const config = { ...MINTED, baseline: { 'src/big.mjs': { lines: 441, reason: 'fixture' } } };
    const cwd = createProject({ files: { 'src/big.mjs': makeLines(442) }, config });
    assertQuestions(cwd, `src/big.mjs: lines 442 exceeds its recorded baseline 441 — ${RECORDED_EXCEPTION_ENDING}`);
  });
});

describe('spec:source-size/S72 each raised file has its own hand record before the regeneration lane', () => {
  for (const [name, suffix] of [
    ['a two-file stop offers hand recording first and prints one entry per file', ''],
    ['a two-file stop keeps the lead, entries and hand focus after the withheld diagnosis', '$'],
  ]) {
    it(name, () => {
      const files = { 'src/big.mjs': FILES['src/big.mjs'], 'src/other.mjs': makeLines(442) };
      const cwd = createProject({ files, config: MINTED }, suffix);
      assertBlock(runCli(cwd, '--check'), ['src/big.mjs', 'src/other.mjs'], {
        verdict: `2 finding(s) against ${escapeForLine(configPath(cwd))}`,
        findings: [BIG, 'src/other.mjs: lines 442 exceeds the declared default 400 beyond its band (up to 440)'],
        remedies: [...QUESTIONS, ...HAND_REMEDIES, suffix === '' ? regenerate(cwd) : WITHHELD],
        after: [
          ...checkLead(cwd, MINTED), suffix === '' ? RAISE : WITHHELD_SHELL, HAND, ENTRY,
          `  "src/other.mjs": { "lines": 442, "reason": "${GROWTH_REASON_PLACEHOLDER}" }`,
          HAND_FOCUS, WHY,
        ],
      });
    });
  }

  it('a withheld directory stop follows the questions with only the regeneration lane', () => {
    const cwd = createProject({ files: makeMany('wide', 23) }, '$');
    assertBlock(runCli(cwd, '--check'), ['wide'], {
      verdict: `1 finding(s) under the kit's values (${escapeForLine(configPath(cwd))} is absent)`,
      findings: [WIDE],
      remedies: [...QUESTIONS, WITHHELD],
      after: [...checkLead(cwd, { schema: 2 }, true), WITHHELD_SHELL, WHY],
    });
  });

  it('a withheld root growth stop follows the questions with only the regeneration lane', () => {
    const cwd = createProject({ files: ROOT_GROWTH_FILES, config: ROOT_GROWTH_CONFIG }, '$');
    assertBlock(runCli(cwd, '--check'), ['src'], {
      verdict: `1 finding(s) against ${escapeForLine(configPath(cwd))}`,
      findings: [ROOT_GROWTH],
      remedies: [...QUESTIONS, WITHHELD],
      after: [...checkLead(cwd, ROOT_GROWTH_CONFIG), WITHHELD_SHELL, WHY],
    });
  });

  it('an unrecorded root with a warning keeps only the withheld regeneration lane', () => {
    const files = { 'src/near.mjs': FILES['src/near.mjs'] };
    const cwd = createProject({ files, config: UNRECORDED_ROOT_CONFIG }, '$');
    assertBlock(runCli(cwd, '--check'), ['src'], {
      verdict: `1 finding(s) against ${escapeForLine(configPath(cwd))}`,
      findings: [UNRECORDED_ROOT],
      remedies: [WITHHELD],
      after: [...checkLead(cwd, UNRECORDED_ROOT_CONFIG), WARNING, WITHHELD_SHELL, WHY],
    });
  });

  it('a withheld tighten warning gives only the regeneration lane', () => {
    const files = { 'src/near.mjs': FILES['src/near.mjs'] };
    const config = { ...MINTED, baseline: { 'src/near.mjs': { lines: 450, reason: 'fixture' } } };
    const cwd = createProject({ files, config }, '$');
    const result = runCli(cwd, '--check');
    assert.deepEqual([result.code, result.stderr], [0, ''], result.stdout);
    const lines = result.stdout.split('\n');
    assert.ok(lines.includes(OBSOLETE), result.stdout);
    assert.ok(lines.includes(FOCUS), result.stdout);
    assertNoHandRecord(result.stdout);
    const tighten = lines.find((line) => line.startsWith('source-size: WARNING —') && line.includes(WITHHELD_SHELL));
    assert.equal(tighten?.slice(tighten.indexOf(WITHHELD_SHELL)), `${WITHHELD_SHELL} ${WITHHELD}`, result.stdout);
  });

  it('a withheld writer refusal for a missing reason gives only the regeneration lane', () => {
    const files = { 'src/big.mjs': FILES['src/big.mjs'] };
    const cwd = createProject({ files, config: MINTED }, '$');
    const result = runCli(cwd, '--write-baseline');
    assert.deepEqual([result.code, result.stderr], [1, ''], result.stdout);
    const lines = result.stdout.split('\n');
    assert.match(lines.find((line) => line.startsWith('source-size: REFUSED — ')) ?? '', /^source-size: REFUSED — this regeneration RAISES 1 recorded value\(s\), and a raise takes a reason/);
    assert.ok(lines.includes('  src/big.mjs: lines none → 441 (raise)'), result.stdout);
    assertNoHandRecord(result.stdout);
    assert.deepEqual(lines.slice(-2), [`${WITHHELD_SHELL} ${WITHHELD}`, WHY]);
  });
});
