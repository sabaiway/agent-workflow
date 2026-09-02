import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planWith } from './plan-shape-harness.test.mjs';
import { expandSweepPaths } from './plan-shape-facts.mjs';
import { readShippedRobustnessLiterals } from './robustness-literals.mjs';
import { computeRowCoverage, main, renderBrief, renderCoverage } from './robustness-brief.mjs';

const LIST = readShippedRobustnessLiterals();
const makeRoot = () => mkdtempSync(join(tmpdir(), 'robustness-brief-'));
const write = (root, rel, body) => {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
};
const row = (id, path, responsibility, verb = 'modify') => verb === 'delete'
  ? `${id} | delete | ${path} | ${responsibility} | — | —`
  : `${id} | ${verb} | ${path} | ${responsibility} | n/a | docs/readme.md:1`;
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

  it('computes bounded byte coverage, skips documents, expands sweeps, and names read refusals (spec:robustness-literals/S10)', () => {
    const files = new Map([
      ['src/start.mjs', Buffer.from('ENOENT ')],
      ['src/end.mjs', Buffer.from(' EPERM')],
      ['src/invalid.mjs', Buffer.concat([Buffer.from([0xff]), Buffer.from('EACCES'), Buffer.from([0xfe])])],
      ['src/non-zero.mjs', Buffer.from('non-zero')],
      ['src/flag.mjs', Buffer.from('--no-textconv=value')],
      ['src/path.mjs', Buffer.from('XGIT_EXEC_PATHY')],
      ['src/prefix.mjs', Buffer.from('GIT_DIR')],
      ['src/comment.mjs', Buffer.from('// EEXIST')],
      ['src/state.mjs', Buffer.from('unmerged stage 1')],
      ['data/judged.json', Buffer.from('{"value":"EEXIST"}')],
      ['src/tagged.mjs', Buffer.from('EEXIST')],
      ['src/sweep-a.mjs', Buffer.from('ENOENT')],
      ['src/sweep-b.mjs', Buffer.from('EEXIST')],
    ]);
    const plan = planOf(
      row('Rstart', 'src/start.mjs', 'start'), row('Rend', 'src/end.mjs', 'end'),
      row('Rinvalid', 'src/invalid.mjs', 'invalid bytes'), row('Rnonzero', 'src/non-zero.mjs', 'bounded'),
      row('Rflag', 'src/flag.mjs', 'flag'), row('Rpath', 'src/path.mjs', 'nested PATH'),
      row('Rprefix', 'src/prefix.mjs', 'prefix'), row('Rcomment', 'src/comment.mjs', 'comment'),
      row('Rstate', 'src/state.mjs', 'state prose'), row('Rmd', 'docs/a.md', 'document'),
      row('Rtxt', 'notes/a.txt', 'document'),
      row('Rlist', 'agent-workflow-kit/references/robustness-literals.json', 'shipped list'),
      row('Rjson', 'data/judged.json', 'json'),
      row('Rtagged', 'src/tagged.mjs', 'tagged robust:durable-write,git-location'),
      row('Rdelete', 'src/deleted.mjs', 'delete', 'delete'), row('Rabsent', 'src/absent.mjs', 'absent'),
      row('Rcreate', 'src/new.mjs', 'create absent', 'create'),
      row('Rsweep', 'src/sweep-*.mjs', 'sweep (2 files)'),
    );
    const answer = computeRowCoverage(plan, LIST, {
      expandRowPath: (path) => path === 'src/sweep-*.mjs' ? ['src/sweep-a.mjs', 'src/sweep-b.mjs'] : [],
      readRowFile: (path) => files.has(path) ? { outcome: 'ok', bytes: files.get(path) } : { outcome: 'absent' },
    });
    assert.equal(answer.refusal, null);
    const covered = new Map(answer.rows.map((entry) => [entry.id, entry]));
    for (const id of ['Rstart', 'Rend', 'Rinvalid']) assert.deepEqual(covered.get(id).present, ['spawn-outcome']);
    assert.deepEqual(covered.get('Rnonzero').present, []);
    assert.deepEqual(covered.get('Rflag').present, ['git-read-flags']);
    assert.deepEqual(covered.get('Rpath').present, []);
    assert.deepEqual(covered.get('Rprefix').present, ['git-location']);
    assert.deepEqual(answer.evidence.find((entry) => entry.id === 'Rprefix'), { id: 'Rprefix', classId: 'git-location', literal: 'GIT_' });
    assert.deepEqual(covered.get('Rcomment').present, ['durable-write']);
    assert.deepEqual(covered.get('Rstate').present, []);
    for (const id of ['Rmd', 'Rtxt', 'Rlist']) assert.equal(covered.has(id), false);
    assert.deepEqual(covered.get('Rjson').present, ['durable-write']);
    assert.deepEqual(covered.get('Rtagged'), {
      id: 'Rtagged', path: 'src/tagged.mjs', tagged: ['durable-write', 'git-location'],
      present: ['durable-write'], uncovered: [], absent: false, deleted: false,
    });
    assert.deepEqual(covered.get('Rsweep').uncovered, ['spawn-outcome', 'durable-write']);
    for (const id of ['Rabsent', 'Rcreate']) {
      assert.equal(covered.get(id).absent, true);
      assert.deepEqual(covered.get(id).uncovered, []);
    }
    assert.deepEqual(covered.get('Rdelete'), {
      id: 'Rdelete', path: 'src/deleted.mjs', tagged: [], present: [], uncovered: [], absent: false, deleted: true,
    });
    const badTag = computeRowCoverage(planOf(row('Rtag', 'src/tagged.mjs', 'robust:git-location,')), LIST, {
      expandRowPath: () => [], readRowFile: () => ({ outcome: 'ok', bytes: Buffer.from('GIT_DIR') }),
    }).refusal;
    assert.equal(badTag.id, 'Rtag');
    assert.match(badTag.reason, /empty-class|invalid-class/);
    const rendered = renderCoverage(answer.rows, 'plans/coverage.md').join('\n');
    assert.match(rendered, /\| Rdelete \| src\/deleted\.mjs \| delete \|/u);
    assert.match(rendered, /\| Rabsent \| src\/absent\.mjs \| absent \|/u);
    for (const [readRowFile, expected] of [
      [() => ({ outcome: 'foreign', className: 'directory' }), 'directory'],
      [() => ({ outcome: 'error', code: 'EACCES' }), 'EACCES'],
      [() => ({ outcome: 'over-cap', cap: 1_048_576 }), 'over-cap'],
      [() => ({ outcome: 'ok', bytes: 'text' }), 'ok outcome carried no Buffer'],
      [() => undefined, 'empty read outcome'],
      [() => { throw Object.assign(new Error('boom'), { code: 'EIO' }); }, 'error \\(EIO\\)'],
    ]) {
      const refusal = computeRowCoverage(planOf(row('Rread', 'src/read.mjs', 'read')), LIST, {
        expandRowPath: () => [], readRowFile,
      }).refusal;
      assert.equal(refusal.id, 'Rread');
      assert.equal(refusal.path, 'src/read.mjs');
      assert.match(refusal.outcome, new RegExp(expected));
    }
  });

  it('runs coverage as a fail-closed second CLI mode with escaped rows and 0/1/2 exits (spec:robustness-literals/S11)', () => {
    const root = makeRoot();
    const tool = fileURLToPath(new URL('./robustness-brief.mjs', import.meta.url));
    const controlPath = 'src/control\u0001.mjs';
    write(root, 'docs/readme.md', 'anchor\n');
    write(root, 'plans/uncovered.md', planOf(row('R1', controlPath, 'ordinary row')));
    write(root, 'plans/tagged.md', planOf(row('R1', controlPath, 'robust:durable-write')));
    write(root, 'plans/unknown.md', planOf(row('Rbad', 'src/bad.mjs', 'robust:no-such-class')));
    const readRowFile = () => ({ outcome: 'ok', bytes: Buffer.from('EEXIST') });
    const uncovered = run(root, ['--plan', 'plans/uncovered.md', '--coverage'], { readRowFile });
    assert.equal(uncovered.code, 1);
    assert.match(uncovered.lines.join('\n'), /src\/control\\u0001\.mjs/u);
    assert.ok(uncovered.lines.includes('R1:durable-write:EEXIST'));
    assert.equal(run(root, ['--plan', 'plans/tagged.md', '--coverage'], { readRowFile }).code, 0);
    const refused = run(root, ['--plan', 'plans/tagged.md', '--coverage'], {
      readRowFile: () => ({ outcome: 'foreign', className: 'directory' }),
    });
    assert.equal(refused.code, 2);
    assert.match(refused.lines.join('\n'), /R1.*src\/control\\u0001\.mjs.*directory/u);
    assert.equal(run(root, ['--plan', 'plans/tagged.md', '--row', 'R1', '--coverage']).code, 2);
    assert.equal(run(root, ['--plan', 'plans/tagged.md']).code, 0);
    assert.equal(run(root, ['--plan', 'plans/tagged.md', '--row', 'R1']).code, 0);
    const unknown = run(root, ['--plan', 'plans/unknown.md', '--coverage'], { readRowFile });
    assert.equal(unknown.code, 2);
    assert.match(unknown.lines.join('\n'), /Rbad.*unknown class no-such-class/u);

    write(root, 'src/real.mjs', 'EEXIST\n');
    write(root, 'src/sweep-over.mjs', 'x'.repeat(1024 * 1024 + 1));
    write(root, 'plans/sweep.md', planOf(row('Rsweep', 'src/sweep-*.mjs', 'ordinary row (2 files)')));
    const overCap = run(root, ['--plan', 'plans/sweep.md', '--coverage']);
    assert.equal(overCap.code, 2);
    assert.match(overCap.lines.join('\n'), /Rsweep.*sweep-over\.mjs.*over-cap/u);
    const fifo = join(root, 'src', 'never-open');
    const madeFifo = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    assert.equal(madeFifo.status, 0, madeFifo.stderr);
    assert.equal(expandSweepPaths(root, ['src/*'])['src/*'].includes('src/never-open'), false);
    write(root, 'plans/real.md', planOf(row('Rreal', 'src/real.mjs', 'ordinary row')));
    const runCli = () => spawnSync(process.execPath, [tool, '--plan', 'plans/real.md', '--coverage'], { cwd: root, encoding: 'utf8' });
    const cliUncovered = runCli();
    assert.equal(cliUncovered.status, 1);
    assert.match(cliUncovered.stdout, /^Rreal:durable-write:EEXIST$/mu);
    assert.equal(cliUncovered.stderr, '');
    write(root, 'plans/real.md', planOf(row('Rreal', 'src/real.mjs', 'robust:durable-write')));
    const cliCovered = runCli();
    assert.equal(cliCovered.status, 0);
    assert.equal(cliCovered.stderr, '');
  });
});
