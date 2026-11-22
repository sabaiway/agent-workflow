import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_ROW, ledgerOf, makeTree, planWith, write, writeJson } from '../plan-shape-harness.test.mjs';

const CLI = join(import.meta.dirname, 'cli.mjs');
const PLAN = 'docs/plans/x.md';
const LINK_REFUSALS = ['EPERM', 'EACCES', 'ENOTSUP'];
const BAD_ROW = 'R2 | move | docs/wrong.md | wrong verb | n/a | docs/readme.md:1';
const FIRST_ENTRY = 'A2 | modify | docs/first.md | update the file | n/a | docs/readme.md:1';
const SECOND_ENTRY = 'A1 | modify | docs/second.md | update the file | n/a | docs/readme.md:1';

const makeRepo = (t) => {
  const root = makeTree('plan-structure-cli');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, 'docs/readme.md', 'text\n');
  return root;
};
const planOf = (approved, ...entries) => planWith({ ledger: ledgerOf([...approved, 'amendments:', ...entries].join('\n')) });
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
  it('prints the verdict and findings before amendment lines in ledger order', (t) => {
    const root = makeRepo(t);
    const first = 'plan-structure: amendment — A2 | modify | docs/first.md | n/a';
    const second = 'plan-structure: amendment — A1 | modify | docs/second.md | n/a';
    write(root, PLAN, planOf([DEFAULT_ROW], FIRST_ENTRY));
    const accepted = run(root, [PLAN]);
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    assert.deepEqual(getLines(accepted.stdout), [`plan-shape: ACCEPT — ${PLAN}`, first]);
    write(root, PLAN, planOf([DEFAULT_ROW], FIRST_ENTRY, SECOND_ENTRY).replaceAll('\n', '\r\n'));
    const crlf = run(root, [PLAN]);
    assert.deepEqual([crlf.status, getLines(crlf.stdout)], [0, [`plan-shape: ACCEPT — ${PLAN}`, first, second]], crlf.stdout);
    write(root, PLAN, planOf([DEFAULT_ROW, BAD_ROW], FIRST_ENTRY, SECOND_ENTRY));
    const refused = run(root, [PLAN]);
    assert.equal(refused.status, 1, refused.stderr || refused.stdout);
    const lines = getLines(refused.stdout);
    assert.equal(lines[0], `plan-shape: REFUSE — ${PLAN}`);
    assertFinding(lines.slice(1, -2), 'R2', 'row-grammar');
    assert.deepEqual(lines.slice(-2), [first, second]);
  });

  it('judges entry budgets, test precedence and the package pin against the ledger', async (t) => {
    const { main } = await import('./cli.mjs');
    const root = makeRepo(t);
    const entry = 'A1 | create | src/change.mjs | add the module | 100 | docs/readme.md:1';
    const testRow = 'R2 | create | test/change.test.mjs | exercise the module | n/a | docs/readme.md:1';
    const pinPath = 'test/package-content.test.mjs';
    const pinRow = `R3 | modify | ${pinPath} | pin the module | n/a | docs/readme.md:1`;
    const check = (approved, ...entries) => {
      write(root, PLAN, planOf([DEFAULT_ROW, ...approved], ...entries));
      return invoke(main, root, [PLAN]);
    };
    const refuse = (result, code) => {
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assertFinding(getLines(result.stdout), 'A1', code);
    };

    refuse(check([testRow], entry), 'cap-declaration');
    writeJson(root, 'docs/ai/source-size.json', { schema: 2, roots: ['src'], extensions: ['.mjs'] });
    refuse(check([testRow], entry.replace(' | 100 | ', ' | n/a | ')), 'source-budget');
    refuse(check([], entry, testRow), 'red-first');
    writeJson(root, 'package.json', { files: ['src/'] });
    write(root, pinPath, 'pin\n');
    refuse(check([testRow], entry), 'package-pin');
    const accepted = check([testRow, pinRow], entry);
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  });

  it('escapes the entry path and the plan operand before printing', async (t) => {
    const { main } = await import('./cli.mjs');
    const root = makeRepo(t);
    write(root, PLAN, planOf([DEFAULT_ROW], FIRST_ENTRY.replace('first', 'control\u0001')));
    const ordinary = invoke(main, root, [PLAN]);
    const entry = 'plan-structure: amendment — A2 | modify | docs/control\\u0001.md | n/a';
    assert.ok(getLines(ordinary.stdout).includes(entry), ordinary.stdout);
    assert.doesNotMatch(ordinary.stdout.replaceAll('\n', ''), /\p{Cc}/u);
    const operand = 'docs/plans/line\nbreak.md';
    try { write(root, operand, planOf([DEFAULT_ROW], FIRST_ENTRY)); }
    catch (error) {
      if (![...LINK_REFUSALS, 'EINVAL'].includes(error.code)) throw error;
      t.diagnostic(`filesystem refused the LF plan name: ${error.code}`);
      return;
    }
    const result = run(root, [operand]);
    assert.equal(result.status, 0, result.stderr);
    const lines = getLines(result.stdout);
    assert.equal(lines[0], 'plan-shape: ACCEPT — docs/plans/line\\u000abreak.md', result.stderr);
    assert.ok(lines.every((line) => /^(plan-shape|plan-structure):/.test(line)), result.stdout);
  });

  it('reports an unsupported entry glob as a plan facts finding', async (t) => {
    const { main } = await import('./cli.mjs');
    const root = makeRepo(t);
    const path = 'docs/[a.md';
    write(root, PLAN, planOf([DEFAULT_ROW], `A1 | modify | ${path} | update (1 files) | n/a | docs/readme.md:1`));
    const result = invoke(main, root, [PLAN]);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const [verdict, finding] = getLines(result.stdout);
    assert.equal(verdict, `plan-shape: REFUSE — ${PLAN}`);
    assert.ok(finding?.startsWith(`${PLAN}:1: facts: `) && finding.includes('unsupported glob') && finding.includes(path), result.stdout);
  });

  it('prints no amendment line for a plan with an entry that the block model refuses', async (t) => {
    const { main } = await import('./cli.mjs');
    const root = makeRepo(t);
    write(root, PLAN, `${planOf([DEFAULT_ROW], FIRST_ENTRY)}\n\`\`\`\nnever closed\n`);
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
    write(root, PLAN, planOf([DEFAULT_ROW], FIRST_ENTRY));
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

it('spec:plan-structure/S8 shares read errors and identity and displays the original operands', async (t) => {
  const { main: checkPlan } = await import('../plan-shape-cli.mjs');
  const root = makeRepo(t);
  const refusedPlan = planWith({ ledger: ledgerOf(`${DEFAULT_ROW}\n${BAD_ROW}`) });
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
