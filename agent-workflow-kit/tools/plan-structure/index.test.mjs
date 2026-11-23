import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { checkPlanStructure, isSweep, parseLedger } from '../plan-shape.mjs';
import { DEFAULT_ROW, ledgerOf, planWith } from '../plan-shape-harness.test.mjs';

const AMENDMENT_LINE = 'amendments:';
const loadDoor = () => import('./index.mjs').catch(() => ({}));
const makeFinding = (line, code, message, rowId = null) => ({ line, code, message, rowId });
const getConcretePaths = (row, facts) => isSweep(row.path) ? facts.expansions?.[row.path] ?? [] : [row.path];
const buildPlan = (lines) => planWith({ ledger: ledgerOf(lines.join('\n')) });
const relate = (relateAmendments, parsed, facts = {}) =>
  relateAmendments({ parsed, facts, makeFinding, isSweep, getConcretePaths });

const ledgerRow = (id, verb, path, responsibility = 'update the file') => {
  const anchor = verb === 'delete' ? '\u2014' : 'docs/readme.md:1';
  return [id, verb, path, responsibility, anchor].join(' | ');
};

it('spec:plan-structure/S1 splits the ledger only on the exact standalone amendment line', async () => {
  const { relateAmendments } = await loadDoor();
  const approved = 'R1 | modify | docs/readme.md | update the guide | docs/readme.md:1';
  const first = 'A1 | modify | docs/first.md | update the file | docs/readme.md:1';
  const second = 'A2 | modify | docs/second.md | update the file | docs/readme.md:1';
  const plan = (...lines) => planWith({ ledger: lines.join('\n') });
  const parsed = parseLedger(plan(approved, AMENDMENT_LINE, '', first, second));
  const split = relate(relateAmendments, parsed);
  assert.deepEqual(split.approved.map((row) => row.id), ['R1']);
  assert.deepEqual(split.entries.map((row) => row.id), ['A1', 'A2']);
  assert.deepEqual(split.amendmentLines, parsed.entries.slice(1).map(({ line }) => line));
  assert.deepEqual(split.findings, []);
  const crlfText = plan(approved, AMENDMENT_LINE, '', first, second).replaceAll('\n', '\r\n');
  const crlf = relate(relateAmendments, parseLedger(crlfText));
  assert.deepEqual([crlf.approved.map((row) => row.id), crlf.entries.map((row) => row.id), crlf.findings], [['R1'], ['A1', 'A2'], []]);
  assert.deepEqual(checkPlanStructure(crlfText, {}).findings, []);
  const spaced = checkPlanStructure(plan(approved, 'amendments: ', first).replaceAll('\n', '\r\n'), {});
  assert.ok(spaced.findings.some(({ code }) => code === 'ledger-line'), JSON.stringify(spaced.findings));

  const proseRow = 'R2 | modify | docs/prose.md | explain amendments: in the guide | docs/readme.md:1';
  const prosePlan = plan(approved, proseRow);
  const whole = relate(relateAmendments, parseLedger(prosePlan));
  assert.deepEqual(whole.approved.map((row) => row.id), ['R1', 'R2']);
  assert.deepEqual(whole.entries, []);
  assert.deepEqual(whole.amendmentLines, []);
  assert.deepEqual(whole.findings, []);
  assert.deepEqual(checkPlanStructure(prosePlan, {}).findings, []);

  for (const lines of [
    [approved, AMENDMENT_LINE, first, AMENDMENT_LINE, second],
    [approved, AMENDMENT_LINE],
    [AMENDMENT_LINE, first],
  ]) {
    const invalid = parseLedger(plan(...lines));
    const amendmentLineNumbers = invalid.entries.filter((entry) => entry.raw === AMENDMENT_LINE).map((entry) => entry.line);
    const findings = relate(relateAmendments, invalid).findings.filter((finding) => finding.code === 'amendment-line');
    assert.ok(findings.length > 0, lines.join('\n'));
    for (const { line } of findings) assert.ok(amendmentLineNumbers.includes(line), `unexpected finding line ${line}`);
  }

  for (const variant of [' amendments:', 'Amendments:', 'amendments: ', 'note amendments: here']) {
    const text = plan(approved, variant, first);
    const { parsed: variantLedger, findings } = checkPlanStructure(text, {});
    const [, variantLine] = variantLedger.entries;
    assert.ok(findings.some(({ code, line }) => code === 'ledger-line' && line === variantLine.line), JSON.stringify(variant));
    assert.deepEqual(relate(relateAmendments, variantLedger).amendmentLines, [], JSON.stringify(variant));
  }
});

it('spec:plan-structure/S2 refuses glob and contract paths and admits new literal paths', async () => {
  const { relateAmendments } = await loadDoor();
  const judgePath = (path) => {
    const entry = ledgerRow('A1', 'modify', path, 'update (1 files)');
    return relate(relateAmendments, parseLedger(buildPlan([DEFAULT_ROW, AMENDMENT_LINE, entry])));
  };

  for (const path of [
    'docs/*.md', 'src/a?.mjs', 'src/[ab].mjs', 'src/{a,b}.mjs',
    'docs/ai/specs', 'docs/ai/specs/kit/x.md', 'docs/plans/story.specs', 'docs/plans/story.specs/kit/x.md',
    'Docs/AI/Specs/x.md', 'DOCS/ai/specs', 'docs/plans/Story.SPECS/x.md',
  ]) {
    assert.ok(judgePath(path).findings.some(({ code, rowId }) => code === 'amendment-path' && rowId === 'A1'), path);
  }

  for (const path of ['docs/ai/specs-old/x.md', 'docs/plans/story.md', 'src/missed.mjs']) {
    const result = judgePath(path);
    assert.deepEqual(result.findings, [], path);
    assert.deepEqual(result.entries.map((row) => [row.id, row.path]), [['A1', path]]);
  }
});

it('spec:plan-structure/S4 judges robust tags and reads the class list on demand', async () => {
  const { checkRobustTags } = await loadDoor();
  const facts = { robustClasses: ['a'] };
  const getRow = (responsibility) => parseLedger(buildPlan([
    ledgerRow('R1', 'modify', 'docs/readme.md', responsibility),
  ])).rows[0];
  const judge = (row, rowFacts = facts) => checkRobustTags({ rows: [row], facts: rowFacts, makeFinding });
  const assertRefusal = (row, rowFacts, reason) => {
    assert.deepEqual(judge(row, rowFacts), [makeFinding(row.line, 'robust-class', `R1 robust tag: ${reason}`, 'R1')], row.responsibility);
  };

  for (const [tag, refusal] of [
    ['robust:', 'no-class'],
    ['robust:a,', 'empty-class'],
    ['robust:a,a', 'duplicate-class'],
    ['robust:Not-A-Slug', 'invalid-class'],
    ['robust:a and robust:b', 'multiple-tags'],
  ]) {
    assertRefusal(getRow(`prove ${tag}`), facts, `tag grammar refused ${refusal}`);
  }
  assertRefusal(getRow('prove robust:no-such-class'), facts, 'class no-such-class is not in the shipped list');
  const listed = getRow('prove robust:a');
  const untagged = getRow('ordinary untagged row');
  assert.deepEqual(judge(listed), []);
  assert.deepEqual(judge(untagged), []);
  assertRefusal(listed, {}, 'class a is not in the shipped list');

  const readFailure = new Error('class list read');
  const reads = [];
  const unreadable = {
    get robustClasses() {
      reads.push('robustClasses');
      throw readFailure;
    },
  };
  assert.deepEqual(judge(untagged, unreadable), []);
  assert.deepEqual(reads, []);
  assert.throws(() => judge(getRow('prove robust:'), unreadable), (error) => error === readFailure);
});

it('spec:plan-structure/S5 exports the library surface and imports without output or forbidden dependencies', async () => {
  const door = new URL('./index.mjs', import.meta.url);
  const source = readFileSync(door, 'utf8');
  const specifiers = source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)(['"`])([^'"`\n]+)\1/g);
  for (const [, , specifier] of specifiers) {
    assert.doesNotMatch(specifier, /plan-shape|cli\.mjs$/);
  }

  const exports = await loadDoor();
  assert.deepEqual(Object.keys(exports).sort(), ['AMENDMENT_LINE', 'checkRobustTags', 'relateAmendments']);
  assert.equal(exports.AMENDMENT_LINE, AMENDMENT_LINE);

  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(door.href)})`], {
    env, encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
