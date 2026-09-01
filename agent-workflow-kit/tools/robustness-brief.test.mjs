import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planWith } from './plan-shape-harness.test.mjs';
import { readShippedRobustnessLiterals } from './robustness-literals.mjs';
import { main, renderBrief } from './robustness-brief.mjs';

const LIST = readShippedRobustnessLiterals();
const makeRoot = () => mkdtempSync(join(tmpdir(), 'robustness-brief-'));
const write = (root, rel, body) => {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
};
const row = (id, path, responsibility) => `${id} | modify | ${path} | ${responsibility} | n/a | docs/readme.md:1`;
const planOf = (...rows) => planWith({ ledger: `${rows.join('\n')}\ntotal: 0 → 0 lines` });
const run = (root, argv, deps = {}) => main(argv, { cwd: root, readList: () => LIST, ...deps });

describe('robustness brief — rendering and exit contract', () => {
  it('S5 builds the whole escaped per-row block and returns one stated no-tag line (spec:robustness-literals/S5)', () => {
    const controlPath = 'src/control\u0001.mjs';
    const replacementPath = 'src/replacement\uFFFD.mjs';
    const rendered = renderBrief(planOf(
      row('R1', controlPath, 'prove robust:git-location'),
      row('R2', replacementPath, 'prove robust:bytes-not-strings'),
    ), LIST, { row: null, displayPath: 'docs/plans/a\u0002.md' });
    assert.equal(rendered.code, 0);
    const output = rendered.lines.join('\n');
    assert.match(output, /list version 1/);
    assert.match(output, /R1/);
    assert.match(output, /GIT_DIR/);
    assert.match(output, /\\u0001/);
    assert.match(output, /\\u0002/);
    assert.ok(output.includes('\uFFFD'), 'a genuine U+FFFD passes as the printable replacement character');
    for (const line of rendered.lines) assert.doesNotMatch(line, /[\u0000-\u001f\u007f\u2028\u2029]/u);
    const noTags = renderBrief(planOf(row('R1', 'src/plain.mjs', 'ordinary row')), LIST, { row: null, displayPath: 'plain.md' });
    assert.equal(noTags.code, 0);
    assert.equal(noTags.lines.length, 1);
    assert.match(noTags.lines[0], /no robust tags/);
    const refused = renderBrief(planOf(
      row('R1', controlPath, 'ordinary row'), row('R2', controlPath, 'ordinary row'),
    ), LIST, { row: null, displayPath: 'refused\u0003.md' });
    assert.equal(refused.code, 1);
    for (const line of refused.lines) assert.doesNotMatch(line, /[\u0000-\u001f\u007f\u2028\u2029]/u);
  });

  it('returns exit 1 for absent or untagged row selection, tag/class refusal, and structural refusal', () => {
    const root = makeRoot();
    write(root, 'docs/readme.md', 'anchor\n');
    write(root, 'plans/tagged.md', planOf(
      row('R1', 'src/a.mjs', 'prove robust:git-location'),
      row('R2', 'src/b.mjs', 'prove robust:durable-write'),
    ));
    write(root, 'plans/untagged.md', planOf(row('R1', 'src/a.mjs', 'ordinary row')));
    write(root, 'plans/refused.md', planOf(row('R7', 'src/a.mjs', 'prove robust:git-location,')));
    write(root, 'plans/unknown.md', planOf(row('R8', 'src/a.mjs', 'prove robust:no-such-class')));
    const structurallyRefused = planOf(row('R1', 'src/a.mjs', 'prove robust:git-location')).replace('# Plan: example', '# Notes');
    write(root, 'plans/structure.md', structurallyRefused);
    for (const [args, name] of [
      [['--plan', 'plans/tagged.md', '--row', 'R99'], 'R99'],
      [['--plan', 'plans/untagged.md', '--row', 'R1'], 'R1'],
      [['--plan', 'plans/refused.md'], 'R7'],
      [['--plan', 'plans/unknown.md'], 'R8'],
      [['--plan', 'plans/structure.md'], 'title'],
    ]) {
      const result = run(root, args);
      assert.equal(result.code, 1, `${args.join(' ')}: ${result.lines.join('\n')}`);
      assert.match(result.lines.join('\n'), new RegExp(name));
      assert.equal(result.lines.some((line) => /list version/u.test(line)), false, 'a refused brief has no partial header');
    }
    const injected = renderBrief(structurallyRefused, readShippedRobustnessLiterals(), { row: null, displayPath: 'plans/x\ny.md' });
    assert.equal(injected.code, 1);
    assert.ok(injected.lines.some((line) => line.includes('plans/x\\u000ay.md')), 'the LF in the plan name renders escaped inside one line');
    assert.equal(injected.lines.some((line) => line === 'y.md' || line.endsWith('plans/x')), false, 'no line is injected by the LF');
    const selected = run(root, ['--plan', 'plans/tagged.md', '--row', 'R1']);
    assert.equal(selected.code, 0);
    const output = selected.lines.join('\n');
    assert.match(output, /list version 1/u);
    assert.match(output, /^### R1 —/mu);
    assert.match(output, /GIT_DIR/u);
    assert.doesNotMatch(output, /R2/u);
    assert.doesNotMatch(output, /O_NOFOLLOW/u);
  });

  it('returns exit 2 for usage, absent/non-regular/uncontained/over-cap plans and a refused list', () => {
    const root = makeRoot();
    const outside = makeRoot();
    write(root, 'docs/readme.md', 'anchor\n');
    const valid = planOf(row('R1', 'src/a.mjs', 'prove robust:git-location'));
    const outsidePlan = write(outside, 'outside.md', valid);
    mkdirSync(join(root, 'plans'), { recursive: true });
    symlinkSync(outsidePlan, join(root, 'plans/link.md'));
    write(root, 'plans/over.md', 'x'.repeat(1024 * 1024 + 1));
    write(root, 'plans/malformed.md', Buffer.from([0xff]));
    for (const [args, named] of [
      [[], 'absent --plan'],
      [['--bogus'], 'unknown argument'], [['--plan'], 'absent operand'], [['--plan', 'plans/absent.md'], 'absent --plan'], [['--plan', 'plans'], 'non-regular directory'],
      [[ '--plan', outsidePlan], 'uncontained --plan'], [['--plan', '../outside.md'], 'uncontained --plan'], [['--plan', 'plans/link.md'], 'uncontained --plan'], [['--plan', 'plans/over.md'], 'over-cap --plan'],
      [['--plan', 'plans/malformed.md'], 'malformed-utf8'],
    ]) {
      const result = run(root, args);
      assert.equal(result.code, 2, `${args.join(' ')}: ${result.lines.join('\n')}`);
      assert.ok(result.lines[0].includes(named), `${args.join(' ')} names ${named}`);
    }
    const refusedList = main(['--plan', outsidePlan], {
      cwd: outside,
      readList: () => { throw Object.assign(new Error('control — refused list'), { code: 'control' }); },
    });
    assert.equal(refusedList.code, 2);
    assert.match(refusedList.lines.join('\n'), /refused list|control/);
  });

  it('the CLI half prints the brief to stdout at exit 0 and the usage lines to stderr at exit 2', () => {
    const root = makeRoot();
    const tool = fileURLToPath(new URL('./robustness-brief.mjs', import.meta.url));
    write(root, 'docs/readme.md', 'anchor\n');
    write(root, 'plans/tagged.md', planOf(row('R1', 'src/a.mjs', 'prove robust:git-location')));
    const runCli = (args) => spawnSync(process.execPath, [tool, ...args], { cwd: root, encoding: 'utf8' });
    const brief = runCli(['--plan', 'plans/tagged.md']);
    assert.equal(brief.status, 0);
    assert.match(brief.stdout, /list version 1/u);
    assert.match(brief.stdout, /R1/u);
    assert.equal(brief.stderr, '');
    const usage = runCli(['--bogus']);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /unknown argument/u);
    assert.match(usage.stderr, /Usage:/u);
    assert.equal(usage.stdout, '');
  });
});
