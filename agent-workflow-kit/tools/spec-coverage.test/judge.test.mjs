import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The pure rule: who covers what, what refuses, and what the ratchet may do.
//
// The module is reached by DYNAMIC import: a static import of a file that does not exist yet makes
// the suite unresolvable, and an unresolvable suite cannot be OBSERVED red.
const load = () => import('../spec-coverage.mjs');

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

const specDoc = (slug, moduleLines, status = 'live') => ({
  rel: `${slug}.md`,
  text: [
    FRONT.replace('status: live', `status: ${status}`),
    '',
    `# Spec: ${slug}`,
    '',
    '## Contract',
    '',
    '- it promises something.',
    '',
    '## Scenarios',
    '',
    `- S1 it does the thing :: src/${slug}.test.mjs :: spec:${slug}/S1`,
    '',
    '## Out of scope',
    '',
    '- everything else.',
    '',
    '## Module',
    '',
    ...moduleLines,
    '',
  ].join('\n'),
});

describe('spec-coverage — the rule', () => {
  // spec:spec-coverage/S1
  it('a tool no contract covers and no debt names REFUSES, and the refusal names the tool', async () => {
    const { claimsOf, judgeCoverage } = await load();
    const { claims } = claimsOf([specDoc('login', ['- src/login.mjs'])]);
    const judged = judgeCoverage({ tools: ['src/login.mjs', 'src/orphan.mjs'], claims, adopted: [] });
    assert.deepEqual(judged.uncovered, ['src/orphan.mjs']);
    assert.deepEqual(judged.covered, [{ path: 'src/login.mjs', by: 'login.md' }]);

    // ...and ADOPTING it is what makes it pass, visibly, instead of silently.
    const recorded = judgeCoverage({ tools: ['src/login.mjs', 'src/orphan.mjs'], claims, adopted: ['src/orphan.mjs'] });
    assert.deepEqual(recorded.uncovered, []);
    assert.deepEqual(recorded.payable, []);
  });

  // spec:spec-coverage/S2
  it('a dir root covers by PREFIX and a file claim by EQUALITY — and neither reaches a sibling', async () => {
    const { claimsOf, coveredBy } = await load();
    const { claims } = claimsOf([specDoc('manifest', ['- src/manifest/']), specDoc('login', ['- src/login.mjs'])]);
    assert.ok(coveredBy(claims, 'src/manifest/validate.mjs'), 'a dir root covers what is under it');
    assert.ok(coveredBy(claims, 'src/login.mjs'), 'a file claim covers itself');
    // The trailing slash is the whole safety of the prefix test.
    assert.equal(coveredBy(claims, 'src/manifest-validate.mjs'), null, 'a dir root never swallows a same-prefixed sibling');
    assert.equal(coveredBy(claims, 'src/login-cli.mjs'), null, 'a file claim never covers a neighbour');
  });

  // spec:spec-coverage/S3
  it('a debt entry that is already SETTLED refuses — the record must not overstate the debt', async () => {
    const { claimsOf, judgeCoverage } = await load();
    const { claims } = claimsOf([specDoc('login', ['- src/login.mjs'])]);
    const nowCovered = judgeCoverage({ tools: ['src/login.mjs'], claims, adopted: ['src/login.mjs'] });
    assert.deepEqual(nowCovered.payable, ['src/login.mjs'], 'somebody wrote the contract and the record did not move');
    const gone = judgeCoverage({ tools: ['src/login.mjs'], claims, adopted: ['src/deleted.mjs'] });
    assert.deepEqual(gone.payable, ['src/deleted.mjs'], 'the file is gone and the record still owes for it');
  });

  // spec:spec-coverage/S4
  it('a contract whose ## Module cannot be read is a NAMED finding, never a silent skip', async () => {
    const { claimsOf } = await load();
    const broken = { rel: 'broken.md', text: `${FRONT}\n\n# Spec: broken\n\nno sections at all.\n` };
    const { claims, unreadable } = claimsOf([broken, specDoc('login', ['- src/login.mjs'])]);
    assert.equal(unreadable.length, 1);
    assert.equal(unreadable[0].rel, 'broken.md');
    assert.ok(unreadable[0].why, 'the reason travels with the finding');
    assert.deepEqual(claims.map((c) => c.path), ['src/login.mjs'], 'the readable contract still counts');
  });

  // spec:spec-coverage/S7
  it('the debt is ADOPTED minus SETTLED, and a settled claim no contract backs REFUSES', async () => {
    const { claimsOf, judgeCoverage, settleAfter } = await load();
    const { claims } = claimsOf([specDoc('login', ['- src/login.mjs'])]);
    const tools = ['src/login.mjs', 'src/owed.mjs'];

    // Storing the debt directly was the earlier design: a hand could append a path and the check
    // honoured it. There is no such field now — the debt is a subtraction, so the only editable
    // claim is "this one was paid", and that claim is checked against the contracts every run.
    const owed = judgeCoverage({ tools, claims, adopted: ['src/owed.mjs'], settled: [] });
    assert.deepEqual(owed.debt, ['src/owed.mjs']);
    assert.deepEqual(owed.uncovered, []);

    const lying = judgeCoverage({ tools, claims, adopted: ['src/owed.mjs'], settled: ['src/owed.mjs'] });
    assert.deepEqual(lying.falselySettled, ['src/owed.mjs'], 'the record claims a contract the store does not have');
    assert.deepEqual(lying.uncovered, ['src/owed.mjs'], 'and the tool is uncovered again, so it refuses twice over');

    // A path outside the baseline can never be recorded, so a deletion cannot be walked back by
    // re-adding it: the write only ever moves adopted paths into settled.
    const refused = settleAfter(['src/owed.mjs'], [], ['src/never-adopted.mjs']);
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.unknown, ['src/never-adopted.mjs']);
    const paid = settleAfter(['src/owed.mjs'], [], ['src/owed.mjs']);
    assert.deepEqual(paid, { ok: true, settled: ['src/owed.mjs'], added: ['src/owed.mjs'] });
  });

  // spec:spec-coverage/S8
  it('only a LIVE contract covers — a draft and a retired one claim nothing', async () => {
    const { claimsOf } = await load();
    for (const status of ['draft', 'retired']) {
      const { claims } = claimsOf([specDoc('login', ['- src/login.mjs'], status)]);
      assert.deepEqual(claims, [], `a ${status} contract may name a module nobody built, so it covers nothing`);
    }
    const { claims } = claimsOf([specDoc('login', ['- src/login.mjs'], 'live')]);
    assert.deepEqual(claims.map((c) => c.path), ['src/login.mjs']);
  });


});
