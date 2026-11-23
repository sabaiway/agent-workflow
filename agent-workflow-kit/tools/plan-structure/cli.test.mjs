import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_ROW as APPROVED_ROW, ledgerOf, LEGACY_ROW, makeTree, planWith, write, writeJson } from '../plan-shape-harness.test.mjs';

const CLI = join(import.meta.dirname, 'cli.mjs');
const PLAN = 'docs/plans/x.md';
const LINK_REFUSALS = ['EPERM', 'EACCES', 'ENOTSUP'];
const BAD_ROW = 'R2 | move | docs/wrong.md | wrong verb | docs/readme.md:1';
const FIRST_ENTRY = 'A2 | modify | docs/first.md | update the file | n/a | docs/readme.md:1';
const SECOND_ENTRY = 'A1 | modify | docs/second.md | update the file | docs/readme.md:1';
const NEW_ENTRY = 'A2 | modify | docs/first.md | update the file | docs/readme.md:1';
const amendedPlan = (approved, ...entries) => planWith({ ledger: [...approved, 'amendments:', ...entries].join('\n') });

const makeRepo = (t) => {
  const root = makeTree('plan-structure-cli');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, 'docs/readme.md', 'text\n');
  return root;
};
const planOf = (approved, ...entries) => planWith({ ledger: [...approved, 'amendments:', ...entries, 'total: 0 → 0 lines'].join('\n') });
const run = (root, argv) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [CLI, ...argv], { cwd: root, env, encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
};
const invoke = (main, cwd, argv) => {
  const output = { stdout: '', stderr: '' };
  const status = main(argv, {
    cwd,
    stdout: (chunk) => { output.stdout += chunk; },
    stderr: (chunk) => { output.stderr += chunk; },
  });
  return { status, ...output };
};
const getLines = (stdout) => stdout.replace(/\n$/, '').split('\n');
const assertFinding = (lines, rowId, code) => {
  const detail = new RegExp(`^:\\d+: ${rowId}: ${code}: \\S`);
  assert.ok(lines.some((line) => line.startsWith(`${PLAN}:`) && detail.test(line.slice(PLAN.length))), lines.join('\n'));
};

describe('spec:plan-structure/S7 structure command', () => {
  it('prints the verdict and findings before amendment id, verb and path lines in ledger order', (t) => {
    const root = makeRepo(t);
    const first = 'plan-structure: amendment — A2 | modify | docs/first.md';
    const second = 'plan-structure: amendment — A1 | modify | docs/second.md';
    write(root, PLAN, planOf([LEGACY_ROW], FIRST_ENTRY));
    assert.ok(!getLines(run(root, [PLAN]).stdout).some((line) => line.startsWith(first + ' | ')));
    write(root, PLAN, amendedPlan([APPROVED_ROW], NEW_ENTRY));
    const accepted = run(root, [PLAN]);
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    assert.deepEqual(getLines(accepted.stdout), ['plan-shape: ACCEPT — ' + PLAN, first]);
    write(root, PLAN, amendedPlan([APPROVED_ROW], NEW_ENTRY, SECOND_ENTRY).replaceAll('\n', '\r\n'));
    const crlf = run(root, [PLAN]);
    assert.deepEqual([crlf.status, getLines(crlf.stdout)], [0, ['plan-shape: ACCEPT — ' + PLAN, first, second]], crlf.stdout);
    write(root, PLAN, amendedPlan([APPROVED_ROW, BAD_ROW], NEW_ENTRY, SECOND_ENTRY));
    const refused = run(root, [PLAN]);
    assert.equal(refused.status, 1, refused.stderr || refused.stdout);
    const lines = getLines(refused.stdout);
    assert.equal(lines[0], 'plan-shape: REFUSE — ' + PLAN);
    assertFinding(lines.slice(1, -2), 'R2', 'row-grammar');
    assert.deepEqual(lines.slice(-2), [first, second]);
  });

  it('judges test precedence and the package pin against the ledger without judging entry budgets', async (t) => {
    const { main } = await import('./cli.mjs');
    const root = makeRepo(t);
    const oldEntry = 'A1 | create | src/change.mjs | add the module | 100 | docs/readme.md:1';
    const oldTest = 'R2 | create | test/change.test.mjs | exercise the module | n/a | docs/readme.md:1';
    const pinPath = 'test/package-content.test.mjs';
    const pinRow = 'R3 | modify | ' + pinPath + ' | pin the module | docs/readme.md:1';
    write(root, PLAN, planOf([LEGACY_ROW, oldTest], oldEntry));
    const withoutDeclaration = invoke(main, root, [PLAN]);
    writeJson(root, 'docs/ai/source-size.json', { schema: 2, roots: ['src'], extensions: ['.mjs'] });
    write(root, PLAN, planOf([LEGACY_ROW, oldTest], oldEntry.replace(' | 100 | ', ' | n/a | ')));
    const inScope = invoke(main, root, [PLAN]);
    assert.doesNotMatch(withoutDeclaration.stdout + inScope.stdout, /: (cap-declaration|source-budget|budget-cap): /);

    const entry = 'A1 | create | src/change.mjs | add the module | docs/readme.md:1';
    const testRow = 'R2 | create | test/change.test.mjs | exercise the module | docs/readme.md:1';
    const check = (approved, ...entries) => {
      write(root, PLAN, amendedPlan([APPROVED_ROW, ...approved], ...entries));
      return invoke(main, root, [PLAN]);
    };
    const refuse = (result, code) => {
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assertFinding(getLines(result.stdout), 'A1', code);
    };
    refuse(check([], entry, testRow), 'red-first');
    writeJson(root, 'package.json', { files: ['src/'] });
    write(root, pinPath, 'pin\n');
    refuse(check([testRow], entry), 'package-pin');
    const accepted = check([testRow, pinRow], entry);
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    assert.deepEqual(getLines(accepted.stdout), ['plan-shape: ACCEPT — ' + PLAN, 'plan-structure: amendment — A1 | create | src/change.mjs']);
  });

  it('escapes the entry path and the plan operand before printing the three entry fields', async (t) => {
    const { main } = await import('./cli.mjs');
    const root = makeRepo(t);
    const path = 'docs/control\u0001.md';
    const entry = 'plan-structure: amendment — A2 | modify | docs/control\\u0001.md';
    write(root, PLAN, planOf([LEGACY_ROW], FIRST_ENTRY.replace('docs/first.md', path)));
    const legacy = invoke(main, root, [PLAN]);
    assert.ok(!getLines(legacy.stdout).some((line) => line.startsWith(entry + ' | ')), legacy.stdout);
    write(root, PLAN, amendedPlan([APPROVED_ROW], NEW_ENTRY.replace('docs/first.md', path)));
    const ordinary = invoke(main, root, [PLAN]);
    assert.equal(ordinary.status, 0, ordinary.stderr || ordinary.stdout);
    assert.deepEqual(getLines(ordinary.stdout), ['plan-shape: ACCEPT — ' + PLAN, entry]);
    assert.doesNotMatch(ordinary.stdout.replaceAll('\n', ''), /\p{Cc}/u);
    const operand = 'docs/plans/line\nbreak.md';
    try { write(root, operand, amendedPlan([APPROVED_ROW], NEW_ENTRY.replace('docs/first.md', path))); }
    catch (error) {
      if (![...LINK_REFUSALS, 'EINVAL'].includes(error.code)) throw error;
      t.diagnostic('filesystem refused the LF plan name: ' + error.code);
      return;
    }
    const result = run(root, [operand]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(getLines(result.stdout), ['plan-shape: ACCEPT — docs/plans/line\\u000abreak.md', entry]);
  });

  it('reports an unsupported entry glob as a plan facts finding', async (t) => {
    const { main } = await import('./cli.mjs');
    const root = makeRepo(t);
    const path = 'docs/[a.md';
    write(root, PLAN, amendedPlan([APPROVED_ROW], `A1 | modify | ${path} | update (1 files) | docs/readme.md:1`));
    const result = invoke(main, root, [PLAN]);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const [verdict, finding] = getLines(result.stdout);
    assert.equal(verdict, `plan-shape: REFUSE — ${PLAN}`);
    assert.ok(finding?.startsWith(`${PLAN}:1: facts: `) && finding.includes('unsupported glob') && finding.includes(path), result.stdout);
  });

  it('prints no amendment line for a plan with an entry that the block model refuses', async (t) => {
    const { main } = await import('./cli.mjs');
    const root = makeRepo(t);
    write(root, PLAN, `${amendedPlan([APPROVED_ROW], NEW_ENTRY)}\n\`\`\`\nnever closed\n`);
    const result = invoke(main, root, [PLAN]);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const [verdict, ...rest] = getLines(result.stdout);
    assert.equal(verdict, `plan-shape: REFUSE — ${PLAN}`);
    assert.ok(rest.some((line) => line.startsWith(`${PLAN}:`) && line.includes(': block-model: ')), result.stdout);
    assert.ok(!result.stdout.includes('plan-structure: amendment'), result.stdout);
  });

  it('keeps its verdict when another plan in flight fails structure', async (t) => {
    const { main } = await import('./cli.mjs');
    const root = makeRepo(t);
    const other = 'docs/plans/broken.md';
    write(root, PLAN, amendedPlan([APPROVED_ROW], NEW_ENTRY));
    const before = invoke(main, root, [PLAN]);
    assert.equal(before.status, 0, before.stderr || before.stdout);
    write(root, other, planWith({ ledger: ledgerOf(BAD_ROW) }));
    const after = invoke(main, root, [PLAN]);
    assert.equal(after.status, 0, after.stderr || after.stdout);
    assert.equal(after.stdout, before.stdout);
    assert.ok(!`${after.stdout}${after.stderr}`.includes(other));
  });

  it('exits 2 for wrong arity and names each unreadable operand', (t) => {
    const root = makeRepo(t);
    for (const argv of [[], [PLAN, 'docs/plans/second.md']]) {
      const result = run(root, argv);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /usage/i);
    }
    const invalid = 'docs/plans/invalid.md';
    write(root, invalid, Buffer.from([0xff, 0xfe]));
    const check = (operand) => {
      const result = run(root, [operand]);
      assert.equal(result.status, 2, result.stderr || result.stdout);
      assert.ok(result.stderr.includes(resolve(root, operand)), result.stderr);
    };
    for (const operand of [PLAN, 'docs/plans', invalid]) check(operand);
    write(root, PLAN, planWith());
    const linked = 'docs/plans/linked.md';
    try { symlinkSync(join(root, PLAN), join(root, linked)); }
    catch (error) {
      if (!LINK_REFUSALS.includes(error.code)) throw error;
      t.diagnostic(`sandbox refused symlinkSync: ${error.code}`);
      return;
    }
    check(linked);
  });
});

it('spec:plan-structure/S11 refuses the retired size field and total line in findings form', (t) => {
  const root = makeRepo(t);
  for (const [ledger, code, fix] of [
    [LEGACY_ROW, 'retired-size-field', /drop.*(?:fifth|size) field/i],
    [APPROVED_ROW + '\ntotal: 0 → 0 lines', 'retired-total-line', /\bdrop\b.*\b(?:it|line|total)\b/i],
  ]) {
    write(root, PLAN, planWith({ ledger }));
    const result = run(root, [PLAN]);
    const [verdict, finding, ...rest] = getLines(result.stdout);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(verdict, 'plan-shape: REFUSE — ' + PLAN);
    assert.ok(finding?.startsWith(PLAN + ':'), result.stdout);
    assert.match(finding.slice(PLAN.length), new RegExp('^:\\d+: (?:R1: )?' + code + ': \\S'), result.stdout);
    assert.match(finding, fix);
    assert.deepEqual(rest, []);
  }
});

it('spec:plan-structure/S8 shares read errors and identity and displays the original operands', async (t) => {
  const { main: checkPlan } = await import('../plan-shape-cli.mjs');
  const root = makeRepo(t);
  const refusedPlan = planWith({ ledger: ledgerOf(`${APPROVED_ROW}\n${BAD_ROW}`) });
  const plans = [[`./${PLAN}`, PLAN, planWith(), 0], ['notes/x.md', 'notes/x.md', refusedPlan, 1]];
  const assertVerdict = (result, operand, status) => {
    assert.equal(result.status, status, result.stderr || result.stdout);
    assert.equal(getLines(result.stdout)[0], `plan-shape: ${status === 0 ? 'ACCEPT' : 'REFUSE'} — ${operand}`);
  };
  const refusals = [['docs/plans/missing.md', 'absent'], ['docs/plans', 'directory']];
  const assertReadError = (result, message) => {
    assert.equal(result.status, 2, result.stderr);
    assert.ok(result.stderr.trimEnd().endsWith(message), result.stderr);
  };
  const readError = (operand, cause) => `${resolve(root, operand)} must be a readable regular plan file (${cause})`;
  for (const [operand, identity, document, status] of plans) {
    write(root, identity, document);
    assertVerdict(invoke(checkPlan, root, ['--check', operand]), operand, status);
  }
  for (const [operand, cause] of refusals) assertReadError(invoke(checkPlan, root, ['--check', operand]), readError(operand, cause));
  const { readPlanDocument } = await import('../plan-shape-facts.mjs');
  assert.equal(typeof readPlanDocument, 'function');
  const { main } = await import('./cli.mjs');
  for (const [operand, cause] of refusals) {
    const message = readError(operand, cause);
    assertReadError(invoke(main, root, [operand]), message);
    assert.throws(() => readPlanDocument(root, operand), { name: 'Error', message });
  }
  for (const [operand, identity, document, status] of plans) {
    const read = readPlanDocument(root, operand);
    assert.equal(read.identity, identity);
    assert.equal(read.text, document);
    assert.deepEqual(read.rows.map((row) => row.id), ['R1']);
    assertVerdict(invoke(main, root, [operand]), operand, status);
  }
});
