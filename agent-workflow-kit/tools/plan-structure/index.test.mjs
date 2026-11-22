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
const buildPlan = (lines, total) => planWith({ ledger: ledgerOf(lines.join('\n'), total) });
const relate = (relateAmendments, parsed, facts = {}) =>
  relateAmendments({ parsed, facts, makeFinding, isSweep, getConcretePaths });

const ledgerRow = (id, verb, path, budget, responsibility = 'update the file') => {
  const anchor = verb === 'delete' ? '\u2014' : 'docs/readme.md:1';
  return [id, verb, path, responsibility, budget, anchor].join(' | ');
};

it('spec:plan-structure/S1 splits the ledger only on the exact standalone amendment line', async () => {
  const { relateAmendments } = await loadDoor();
  const first = ledgerRow('A1', 'modify', 'docs/first.md', 'n/a');
  const second = ledgerRow('A2', 'modify', 'docs/second.md', 'n/a');
  const parsed = parseLedger(buildPlan([DEFAULT_ROW, AMENDMENT_LINE, '', first, second]));
  const [, separator, blank, firstEntry, secondEntry] = parsed.entries;
  const split = relate(relateAmendments, parsed);
  assert.deepEqual(split.approved.map((row) => row.id), ['R1']);
  assert.deepEqual(split.entries.map((row) => row.id), ['A1', 'A2']);
  assert.deepEqual(split.amendmentLines, [separator.line, blank.line, firstEntry.line, secondEntry.line]);
  assert.deepEqual(split.findings, []);
  const crlfText = buildPlan([DEFAULT_ROW, AMENDMENT_LINE, '', first, second]).replaceAll('\n', '\r\n');
  const crlf = relate(relateAmendments, parseLedger(crlfText));
  assert.deepEqual([crlf.approved.map((row) => row.id), crlf.entries.map((row) => row.id), crlf.findings], [['R1'], ['A1', 'A2'], []]);
  assert.deepEqual(checkPlanStructure(crlfText, {}).findings, []);
  const spaced = checkPlanStructure(buildPlan([DEFAULT_ROW, 'amendments: ', first]).replaceAll('\n', '\r\n'), {});
  assert.ok(spaced.findings.some(({ code }) => code === 'ledger-line'), JSON.stringify(spaced.findings));

  const proseRow = ledgerRow('R2', 'modify', 'docs/prose.md', 'n/a', 'explain amendments: in the guide');
  const prosePlan = buildPlan([DEFAULT_ROW, proseRow], 'total: 0 \u2192 0 lines (explain amendments:)');
  const whole = relate(relateAmendments, parseLedger(prosePlan));
  assert.deepEqual(whole.approved.map((row) => row.id), ['R1', 'R2']);
  assert.deepEqual(whole.entries, []);
  assert.deepEqual(whole.amendmentLines, []);
  assert.deepEqual(whole.findings, []);
  assert.deepEqual(checkPlanStructure(prosePlan, {}).findings, []);

  for (const lines of [
    [DEFAULT_ROW, AMENDMENT_LINE, first, AMENDMENT_LINE, second],
    [DEFAULT_ROW, AMENDMENT_LINE],
    [AMENDMENT_LINE, first],
  ]) {
    const invalid = parseLedger(buildPlan(lines));
    const amendmentLineNumbers = invalid.entries.filter((entry) => entry.raw === AMENDMENT_LINE).map((entry) => entry.line);
    const findings = relate(relateAmendments, invalid).findings.filter((finding) => finding.code === 'amendment-line');
    assert.ok(findings.length > 0, lines.join('\n'));
    for (const { line } of findings) assert.ok(amendmentLineNumbers.includes(line), `unexpected finding line ${line}`);
  }

  for (const variant of [' amendments:', 'Amendments:', 'amendments: ', 'note amendments: here']) {
    const text = buildPlan([DEFAULT_ROW, variant, first]);
    const { parsed: variantLedger, findings } = checkPlanStructure(text, {});
    const [, variantLine] = variantLedger.entries;
    assert.ok(findings.some(({ code, line }) => code === 'ledger-line' && line === variantLine.line), JSON.stringify(variant));
    assert.deepEqual(relate(relateAmendments, variantLedger).amendmentLines, [], JSON.stringify(variant));
  }
});

it('spec:plan-structure/S2 refuses glob and contract paths and admits new literal paths', async () => {
  const { relateAmendments } = await loadDoor();
  const judgePath = (path) => {
    const entry = ledgerRow('A1', 'modify', path, 120, 'update (1 files)');
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
    assert.equal(result.budgets.size, 0, path);
  }
});

it('spec:plan-structure/S3 admits only higher integer budgets from a single matching owner for one path', async () => {
  const { relateAmendments } = await loadDoor();
  const path = 'src/a.mjs';
  const sweepPath = 'src/*.mjs';
  const overlappingSweepPath = 'src/[ab].mjs';
  const expansions = {
    [sweepPath]: [path, 'src/b.mjs'],
    [overlappingSweepPath]: [path, 'src/b.mjs'],
  };
  const modify = ledgerRow('R1', 'modify', path, 100);
  const create = ledgerRow('R1', 'create', path, 100);
  const sweep = ledgerRow('R2', 'modify', sweepPath, 100, 'update (2 files)');
  const modifyEntry = ledgerRow('A1', 'modify', path, 120);
  const createEntry = ledgerRow('A1', 'create', path, 150);
  const judgeBudgets = (approved, entries) => {
    const parsed = parseLedger(buildPlan([...approved, AMENDMENT_LINE, ...entries]));
    return relate(relateAmendments, parsed, { expansions }).budgets;
  };

  for (const [label, owner, entry, budget] of [
    ['literal modify', modify, modifyEntry, 120],
    ['literal create', create, createEntry, 150],
    ['modify sweep', sweep, ledgerRow('A1', 'modify', path, 150), 150],
  ]) {
    const budgets = judgeBudgets([owner], [entry]);
    assert.ok(budgets instanceof Map, label);
    assert.equal(budgets.get(path), budget, label);
    assert.equal(budgets.size, 1, label);
  }

  for (const [label, approved, entries] of [
    ['literal and sweep owners', [modify, sweep], [modifyEntry]],
    ['two sweep owners', [sweep, ledgerRow('R3', 'modify', overlappingSweepPath, 100, 'update (2 files)')], [modifyEntry]],
    ['delete entry', [modify], [ledgerRow('A1', 'delete', path, '\u2014')]],
    ['modify over create', [create], [modifyEntry]],
    ['create under a sweep', [sweep], [createEntry]],
    ['entry without an integer budget', [modify], [ledgerRow('A1', 'modify', path, 'n/a')]],
    ['owner without an integer budget', [ledgerRow('R1', 'modify', path, 'n/a')], [modifyEntry]],
    ['equal budget', [modify], [ledgerRow('A1', 'modify', path, 100)]],
    ['smaller budget', [modify], [ledgerRow('A1', 'modify', path, 99)]],
    ['two entries on the path', [modify], [modifyEntry, ledgerRow('A2', 'modify', path, 150)]],
  ]) {
    assert.equal(judgeBudgets(approved, entries).has(path), false, label);
  }
});

it('spec:plan-structure/S4 judges robust tags and reads the class list on demand', async () => {
  const { checkRobustTags } = await loadDoor();
  const facts = { robustClasses: ['a'] };
  const getRow = (responsibility) => parseLedger(buildPlan([
    ledgerRow('R1', 'modify', 'docs/readme.md', 'n/a', responsibility),
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
