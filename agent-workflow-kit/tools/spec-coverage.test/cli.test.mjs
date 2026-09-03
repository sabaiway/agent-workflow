import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// argv, the scope file, and the one write this tool owns.
//
// The module is reached by DYNAMIC import: a static import of a file that does not exist yet makes
// the suite unresolvable, and an unresolvable suite cannot be OBSERVED red.
const load = () => import('../spec-coverage-cli.mjs');

const FRONT = [
  '---',
  'type: spec',
  'lastUpdated: 2026-08-26',
  'scope: permanent',
  'staleAfter: 90d',
  'owner: none',
  'maxLines: 150',
  'kind: spec',
  'status: live',
  'revision: 1',
  '---',
].join('\n');

const project = ({ tools = [], covered = [], debt = [] } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'spec-coverage-'));
  mkdirSync(join(root, 'docs', 'ai', 'specs'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  for (const name of tools) writeFileSync(join(root, 'src', name), '// a tool\n');
  if (covered.length) {
    writeFileSync(
      join(root, 'docs', 'ai', 'specs', 'login.md'),
      [
        FRONT, '', '# Spec: login', '', '## Contract', '', '- it promises something.', '',
        '## Scenarios', '', '- S1 it does the thing :: src/login.test.mjs :: spec:login/S1', '',
        '## Out of scope', '', '- everything else.', '', '## Module', '',
        ...covered.map((p) => `- ${p}`), '',
      ].join('\n'),
    );
  }
  writeFileSync(
    join(root, 'docs', 'ai', 'spec-coverage.json'),
    `${JSON.stringify({ schema: 1, roots: ['src'], extensions: ['.mjs'], exclude: [], adopted: debt, settled: [] }, null, 2)}\n`,
  );
  return root;
};

const run = async (argv) => {
  const out = [];
  const err = [];
  const code = (await load()).main(argv, { log: (m) => out.push(String(m)), error: (m) => err.push(String(m)) });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

describe('spec-coverage — the CLI', () => {
  it('--check PASSES when every tool is covered or recorded, and REFUSES when one is neither', async () => {
    const clean = project({ tools: ['login.mjs'], covered: ['src/login.mjs'] });
    assert.equal((await run(['--check', '--root', clean])).code, 0);

    const dirty = project({ tools: ['login.mjs', 'orphan.mjs'], covered: ['src/login.mjs'] });
    const refused = await run(['--check', '--root', dirty]);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /src\/orphan\.mjs: no contract/);
    assert.match(refused.err, /no work is done without a specification/);
  });

  it('a TEST file is never in scope — a contract governs the module, its tests are the evidence', async () => {
    const root = project({ tools: ['login.mjs', 'login.test.mjs'], covered: ['src/login.mjs'] });
    assert.equal((await run(['--check', '--root', root])).code, 0);
    const report = await run(['--report', '--root', root]);
    assert.doesNotMatch(report.out, /login\.test\.mjs/);
  });

  // spec:spec-coverage/S5
  it('--write-debt REFUSES to add a path, and says to write the contract instead', async () => {
    const root = project({ tools: ['login.mjs', 'orphan.mjs'], covered: ['src/login.mjs'] });
    // An uncovered tool outside the baseline cannot be recorded at all: --check refuses it, and the
    // write has nothing it may add.
    const refused = await run(['--check', '--root', root]);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /src\/orphan\.mjs: no contract/);
    const written = await run(['--write-debt', '--reason', 'nothing has been paid here', '--root', root]);
    assert.equal(written.code, 0, 'the write records only what was PAID, and nothing was');
    const onDisk = JSON.parse(readFileSync(join(root, 'docs', 'ai', 'spec-coverage.json'), 'utf8'));
    assert.deepEqual(onDisk.settled, [], 'so the record is untouched and the orphan is still refused');
    assert.equal((await run(['--check', '--root', root])).code, 1);

    // ...and a paid debt IS recorded once its contract exists.
    const paid = project({ tools: ['login.mjs'], covered: ['src/login.mjs'], debt: ['src/login.mjs'] });
    const shrunk = await run(['--write-debt', '--reason', 'the contract was written', '--root', paid]);
    assert.equal(shrunk.code, 0);
    assert.match(shrunk.out, /debt 1 → 0/);
    assert.deepEqual(JSON.parse(readFileSync(join(paid, 'docs', 'ai', 'spec-coverage.json'), 'utf8')).settled, ['src/login.mjs']);
    assert.equal((await run(['--check', '--root', paid])).code, 0);
  });

  // spec:spec-coverage/S6
  it('usage refuses an unknown flag, a missing value, a second mode, an unreadable scope and a reasonless write', async () => {
    const root = project({ tools: ['login.mjs'], covered: ['src/login.mjs'] });
    assert.equal((await run(['--wat'])).code, 2);
    assert.equal((await run([])).code, 2);
    assert.equal((await run(['--check', '--report'])).code, 2);
    assert.equal((await run(['--check', '--root'])).code, 2);
    assert.equal((await run(['--check', '--root', root, '--root', root])).code, 2);
    const reasonless = await run(['--write-debt', '--root', root]);
    assert.equal(reasonless.code, 2);
    assert.match(reasonless.err, /requires --reason/);
    // The reason names what was PAID, not what is accepted: the command records repayment, and a
    // help line describing the old design is a document that lies about the tool beside it.
    assert.match(reasonless.err, /what was paid, and by which contract/);
    assert.match((await run(['--help'])).out, /what was paid, and by which contract/);
    const absent = await run(['--check', '--root', join(root, 'nowhere')]);
    assert.equal(absent.code, 2);
    assert.match(absent.err, /cannot read the coverage scope/);
  });

  it('a MALFORMED scope, an over-long reason and a nested test directory are each refused or skipped by name', async () => {
    const root = project({ tools: ['login.mjs'], covered: ['src/login.mjs'] });
    // A scope file that is not JSON is a usage refusal naming the file — never a silent empty scope,
    // which would report zero tools and pass.
    writeFileSync(join(root, 'docs', 'ai', 'spec-coverage.json'), '{ not json\n');
    const malformed = await run(['--check', '--root', root]);
    assert.equal(malformed.code, 2);
    assert.match(malformed.err, /is not valid JSON/);

    // A reason nobody can read is not a reason: the cap is what stops a ratchet becoming a stamp.
    const capped = project({ tools: ['login.mjs'], covered: ['src/login.mjs'] });
    const tooLong = await run(['--write-debt', '--reason', 'x'.repeat(301), '--root', capped]);
    assert.equal(tooLong.code, 2);
    assert.match(tooLong.err, /at most 300 UTF-8 bytes/);

    // A `<name>.test/` directory holds evidence, not modules, so the walk never descends into it.
    const withTests = project({ tools: ['login.mjs'], covered: ['src/login.mjs'] });
    mkdirSync(join(withTests, 'src', 'login.test'), { recursive: true });
    writeFileSync(join(withTests, 'src', 'login.test', 'judge.test.mjs'), '// evidence\n');
    mkdirSync(join(withTests, 'src', 'nested'), { recursive: true });
    writeFileSync(join(withTests, 'src', 'nested', 'deep.mjs'), '// a real module, one level down\n');
    const walked = await run(['--report', '--root', withTests]);
    assert.doesNotMatch(walked.out, /login\.test/, 'a .test directory is evidence, never a module');
    assert.match(walked.out, /src\/nested\/deep\.mjs\tuncovered/, 'an ordinary subdirectory IS walked');
  });

  // spec:spec-coverage/S9
  it('an UNUSABLE scope, a census of zero and a half-name exclusion each refuse', async () => {
    const scopeOf = (root) => join(root, 'docs', 'ai', 'spec-coverage.json');
    // Each of these used to yield a census of zero and a cheerful PASS — a gate answering about a
    // domain it never looked at.
    for (const bad of [{}, { schema: 2 }, { schema: 1, roots: [], extensions: ['.mjs'], adopted: [] },
      { schema: 1, roots: ['src'], extensions: [], adopted: [] },
      { schema: 1, roots: ['src'], extensions: ['mjs'], adopted: [] },
      { schema: 1, roots: ['src'], extensions: ['.mjs'], exclude: [''], adopted: [] },
      { schema: 1, roots: ['src'], extensions: ['.mjs'], adopted: [42] },
      { schema: 1, roots: ['src'], extensions: ['.mjs'], adopted: [], settled: [''] },
      { schema: 1, roots: ['src'], extensions: ['.mjs'] }]) {
      const root = project({ tools: ['login.mjs'], covered: ['src/login.mjs'] });
      writeFileSync(scopeOf(root), `${JSON.stringify(bad)}\n`);
      const refused = await run(['--check', '--root', root]);
      assert.equal(refused.code, 2, `${JSON.stringify(bad)} must refuse`);
      assert.match(refused.err, /unusable/);
    }

    // Roots that point at nothing this scope would judge are a refusal too, not an empty pass.
    const empty = project({ covered: [] });
    const zero = await run(['--check', '--root', empty]);
    assert.equal(zero.code, 2);
    assert.match(zero.err, /census of zero is not a pass/);

    // An exclusion is a path COMPONENT, so excluding a directory never hides a same-named sibling.
    const sibling = project({ tools: ['login.mjs'], covered: ['src/login.mjs'] });
    mkdirSync(join(sibling, 'src', 'fixtures'), { recursive: true });
    writeFileSync(join(sibling, 'src', 'fixtures', 'inside.mjs'), '// excluded\n');
    writeFileSync(join(sibling, 'src', 'fixtures-escape.mjs'), '// NOT excluded\n');
    const scope = JSON.parse(readFileSync(scopeOf(sibling), 'utf8'));
    writeFileSync(scopeOf(sibling), `${JSON.stringify({ ...scope, exclude: ['src/fixtures'] }, null, 2)}\n`);
    const report = await run(['--report', '--root', sibling]);
    assert.doesNotMatch(report.out, /fixtures\/inside\.mjs/, 'the excluded directory is out of scope');
    assert.match(report.out, /src\/fixtures-escape\.mjs\tuncovered/, 'its same-prefixed sibling is NOT');
  });

  it('--help is answered only as the whole invocation', async () => {
    for (const flag of ['--help', '-h']) assert.equal((await run([flag])).code, 0);
    assert.equal((await run(['--check', '--help'])).code, 2);
  });

  it('keeps the S6 exit partition for an unreadable store, a stray reason and a failed debt write', async () => {
    const root = project({ tools: ['login.mjs'], covered: ['src/login.mjs'] });
    assert.equal((await run(['--check', '--reason', 'stray', '--root', root])).code, 0);
    rmSync(join(root, 'docs', 'ai', 'specs'), { recursive: true });
    assert.equal((await run(['--check', '--root', root])).code, 2);

    const locked = project({ tools: ['login.mjs'], covered: ['src/login.mjs'], debt: ['src/login.mjs'] });
    const scope = join(locked, 'docs', 'ai', 'spec-coverage.json');
    chmodSync(scope, 0o444);
    try {
      await assert.rejects(run(['--write-debt', '--reason', 'the contract was written', '--root', locked]), { code: 'EACCES' });
    } finally {
      chmodSync(scope, 0o644);
    }
  });
});
