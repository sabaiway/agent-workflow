import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Core suite for the finding-scope checker (procedures.md, plan-execution step 5): one case per arm
// of the verdict matrix, accepting AND refusing, plus the two extractors the arms read through. Each
// case reaches the module by DYNAMIC import — a static import of a file that does not exist yet makes
// the suite unresolvable, and an unresolvable suite cannot be OBSERVED red.
const load = () => import('./fold-scope.mjs');

// A plan fixture shaped like the real thing: a wrapped bullet, a fenced example with a decoy bullet
// and heading, a level-3 subheading that must NOT end the section, prose after the bullets, and a
// bullet in the NEXT section — none of the last three is a criterion.
const PLAN = [
  '# Plan: a fixture',
  '',
  '## Goal and boundary',
  '',
  '- this bullet is in Goal, never a criterion.',
  '',
  '## Module ledger',
  '',
  'c1 | create | tools/x.mjs | does a thing | 400 | -',
  '',
  '## Verification',
  '',
  '`node run-gates.mjs --final` -> 14/14 green. This sentence is prose, not a criterion.',
  '',
  '```sh',
  '- a fenced bullet is a quotation, never a criterion',
  '## Verification',
  '```',
  '',
  '- ACCEPT a claim when the criterion literal matches within ONE acceptance bullet of the plan;',
  '  REFUSE when it matches nothing.',
  '- Exit code 0 for every ACCEPT, non-zero for every REFUSE.',
  '',
  '### Acceptance, continued',
  '',
  '-   a bullet whose marker carries extra whitespace is still a criterion.',
  '',
  '~~~',
  '- a tilde-fenced bullet is a quotation too',
  '~~~',
  '',
  'Red-proof: every new module is reached by dynamic import().',
  '',
  '## Phase: Cleanup',
  '',
  '- this bullet is OUTSIDE the acceptance section and is never a criterion.',
  '',
].join('\n');

const row = (title, fields) => [`- **${title}**`, ...fields.map((f) => `  - ${f}`), ''].join('\n');

const COMPLETE = row('A-CHECKER-ADMITS-AN-UNRESOLVED-REFERENCE — queued 2026-08-22.', [
  'invariant: every claimed criterion resolves to an acceptance bullet',
  'origin: agent-workflow-kit/tools/fold-scope.mjs:42 (the extractor)',
  'narrow fix: the found site refuses a claim that resolves to nothing',
  'proof: fold-scope.test.mjs#refuses a claim that matches no acceptance bullet',
  'residual exposure: other callers still pass unchecked text - not live',
]);
// The invariant WRAPS: one physical line loses the tail, refusing a legitimate deferral.
const WRAPPED = ['- **A-WRAPPED-INVARIANT — queued 2026-08-22.**',
  '  - invariant: a field value that wraps across lines is read',
  '    whole, tail included',
  '  - origin: agent-workflow-kit/tools/fold-scope.mjs:94',
  '  - narrow fix: the field parser folds continuation lines',
  '  - proof: fold-scope.test.mjs#a field value continues across wrapped lines',
  '  - residual exposure: a duplicate label still keeps only the first value - not live',
  ''].join('\n');
const INCOMPLETE = row('A-ROW-WITHOUT-ITS-PROOF — queued 2026-08-22.', [
  'invariant: a deferral row carries five fields',
  'origin: agent-workflow-kit/tools/fold-scope.mjs:99',
  'narrow fix: the found site names the missing field',
  'residual exposure: nothing else reads the row - not live',
]);
// Three origins that are NOT a file:line — shapeless, a line number with noise glued on, and zero.
const BAD_ORIGINS = [
  ['the origin of a deferral is a file and a line', 'somewhere in the parser'],
  ['a line number is a number and nothing glued to it', 'fold-scope.mjs:12junk'],
  ['a file has no line zero', 'fold-scope.mjs:0'],
].map(([invariant, origin], index) => row(`A-BAD-ORIGIN-${index} — queued 2026-08-22.`, [
  `invariant: ${invariant}`,
  `origin: ${origin}`,
  'narrow fix: the shape is anchored, not searched for',
  'proof: fold-scope.test.mjs#origin must be a file:line',
  'residual exposure: none - not live',
]));
const LIVE = row('A-ROW-WHOSE-EXPOSURE-IS-LIVE — queued 2026-08-22.', [
  'invariant: a live defect is never queued',
  'origin: agent-workflow-kit/tools/fold-scope.mjs:7',
  'narrow fix: none shipped',
  'proof: none',
  'residual exposure: the shipped checker accepts a wrong verdict - live',
]);
// Shapes that are NOT the two declared dispositions, each of which a looser matcher misreads.
const NEAR_MISSES = [
  ['a hyphenated non-word is not a disposition', 'the reader sees non-live and cannot tell'],
  ['a doubled hyphen is not the declared form', 'the row says not--live, which is neither'],
  ['a spaced hyphen is not the declared form', 'the row says not - live, which is neither'],
  ['a suffixed token is not the declared form', 'the row says not-live-ish, which is neither'],
  ['a prefixed token is not the declared form', 'the row says maybe-not-live, which is neither'],
].map(([invariant, exposure], index) => row(`A-NEAR-MISS-${index} — queued 2026-08-22.`, [
  `invariant: ${invariant}`,
  `origin: agent-workflow-kit/tools/fold-scope.mjs:1${index}`,
  'narrow fix: the found site reads it as undeclared',
  'proof: fold-scope.test.mjs#exposure token boundaries',
  `residual exposure: ${exposure}`,
]));
const MIXED = row('A-ROW-DECLARING-BOTH — queued 2026-08-22.', [
  'invariant: a contradictory disposition fails closed',
  'origin: agent-workflow-kit/tools/fold-scope.mjs:20',
  'narrow fix: the found site reads the contradiction as live',
  'proof: fold-scope.test.mjs#exposure token boundaries',
  'residual exposure: not live in tests but live in production',
]);
const CLOSED = row('A-CLOSED-ROW — DONE 2026-08-22 · repo-only.', [
  'invariant: a closed row is not a live deferral',
  'origin: agent-workflow-kit/tools/fold-scope.mjs:65',
  'narrow fix: the found site refuses a title carrying DONE or CLOSED',
  'proof: fold-scope.test.mjs#a DONE or CLOSED row is refused',
  'residual exposure: the general status grammar is queued - not live',
]);
// The claim only in a PROOF field: whole-block discovery alone calls this pair ambiguous.
const DECOY = row('A-DECOY-ROW — queued 2026-08-22.', [
  'invariant: something else entirely',
  'origin: agent-workflow-kit/tools/fold-scope.mjs:89',
  'narrow fix: none',
  'proof: covered beside every claimed criterion resolves to an acceptance bullet',
  'residual exposure: none - not live',
]);
const QUEUE = ['# Plans queue - series index', '', '> a blockquote line is never a row.', '',
  COMPLETE, WRAPPED, INCOMPLETE, ...BAD_ORIGINS, LIVE, ...NEAR_MISSES, MIXED, CLOSED, DECOY].join('\n');
const OPEN_ROWS = 14; // every row above except CLOSED, whose title says DONE

const IN_ACCEPTANCE = 'Exit code 0 for every ACCEPT';
const WRAPPED_BULLET = 'matches within ONE acceptance bullet of the plan; REFUSE when it matches nothing';
const SPACED_BULLET = 'a bullet whose marker carries extra whitespace is still a criterion';
const DEFERRABLE = 'every claimed criterion resolves to an acceptance bullet';

const decide = async (over) => (await load()).decideFoldScope({ planText: PLAN, queueText: QUEUE, ...over });
const codeOf = async (over) => (await decide(over)).code;
const exposureOf = async (claim) => (await load()).findDebtRow(QUEUE, claim).exposure;

describe('extractAcceptance — the `- ` bullets under ## Verification ARE the criteria', () => {
  it('returns exactly the top-level bullets of that section, joining a wrapped one', async () => {
    const { extractAcceptance } = await load();
    const bullets = extractAcceptance(PLAN);
    assert.equal(bullets.length, 3, 'Goal, the prose lines and the Cleanup bullet are not criteria');
    assert.ok(bullets[0].includes(WRAPPED_BULLET), 'a wrapped bullet is ONE criterion, joined');
    assert.ok(!bullets.some((b) => b.includes('never a criterion')), 'bullets outside the section stay out');
    assert.deepEqual(extractAcceptance('# Plan: x\n\n## Goal and boundary\n\n- a bullet\n'), [], 'no ## Verification = no criteria');
    assert.deepEqual(extractAcceptance('## Verification\n\nrun the gates.\n\n## Next steps\n'), [], 'prose with no bullets = no criteria');
    assert.deepEqual(extractAcceptance('## Verification\r\n\r\n- a criterion\r\n'), ['a criterion'], 'CRLF parses identically');
    assert.deepEqual(extractAcceptance(''), []);
  });

  it('fence-aware: a bullet inside a backtick or tilde fence is never a criterion', async () => {
    const { extractAcceptance } = await load();
    assert.ok(!extractAcceptance(PLAN).some((b) => b.includes('quotation')), 'neither fenced decoy bullet became a criterion');
    assert.equal(await codeOf({ cls: 'in-scope', claim: 'a fenced bullet is a quotation' }), 'in-scope-unmatched');
    assert.equal(await codeOf({ cls: 'in-scope', claim: 'a tilde-fenced bullet is a quotation too' }), 'in-scope-unmatched');
    // A backtick in the INFO STRING opens no fence (CommonMark). Had it opened one, `## Cleanup` would
    // be hidden, the section would never end, and `- outside` would become a criterion — a false ACCEPT.
    assert.deepEqual(extractAcceptance('## Verification\n\n```x`y\n## Cleanup\n\n- outside\n'), []);
    // A fence CLOSES the block it interrupts: text past it can never join the bullet before it.
    assert.deepEqual(extractAcceptance('## Verification\n\n- one\n\n```\nx\n```\n  glued\n'), ['one']);
    const split = (await load()).findDebtRow('- **R**\n  - invariant: a\n\n```\nx\n```\n  - proof: b\n', 'a');
    assert.ok(split.missing.includes('proof'), 'a field past a fence belongs to no row above it');
  });

  it('a level-3 heading stays INSIDE the section; a level-1 or level-2 heading ends it', async () => {
    const { extractAcceptance } = await load();
    assert.ok(extractAcceptance(PLAN).some((b) => b.includes(SPACED_BULLET)), 'a ### subheading does not end the section');
    assert.deepEqual(extractAcceptance('## Verification\n\n- kept\n\n# Appendix\n\n- dropped\n'), ['kept'], 'a level-1 heading ends the section');
    // ONE recognizer at both ends: 1-3 spaces is still a heading, 4 is an indented code block.
    assert.deepEqual(extractAcceptance('## Verification\n\n- kept\n\n   ## Next\n\n- dropped\n'), ['kept'], 'a 3-space heading ends the section');
    assert.deepEqual(extractAcceptance('    ## Verification\n\n- outside\n'), [], 'a 4-space line opens no section');
  });

  it('a bullet marker with extra whitespace is still a criterion', async () => {
    assert.equal((await decide({ cls: 'in-scope', claim: SPACED_BULLET })).verdict, 'ACCEPT');
  });

  it('a document the shared block model REFUSES is a loud refusal, never a silent empty read', async () => {
    const r = await decide({ cls: 'in-scope', claim: 'anything', planText: '## Verification\n\n```\n- never closed\n' });
    assert.equal(r.code, 'document-unreadable');
    assert.equal(r.exit, 2);
    assert.ok(r.lines.join('\n').includes('never closed'), 'the refusal carries the block model own message');
    const q = await decide({ cls: 'new-invariant', claim: 'anything', queueText: '```\n- never closed\n' });
    assert.equal(q.code, 'document-unreadable');
  });
});

describe('findDebtRow — the row FOR this invariant, its five fields, and its disposition', () => {
  it('finds the row whose invariant field carries the claim, and reads all five fields', async () => {
    const { findDebtRow, ROW_FIELDS } = await load();
    const found = findDebtRow(QUEUE, DEFERRABLE);
    assert.equal(found.found, true);
    assert.equal(found.matches, 1);
    assert.deepEqual(found.missing, []);
    assert.equal(found.exposure, 'not-live');
    assert.equal(found.claimInInvariant, true);
    assert.equal(found.fields.origin, 'agent-workflow-kit/tools/fold-scope.mjs:42 (the extractor)');
    assert.deepEqual(ROW_FIELDS, ['invariant', 'origin', 'narrow fix', 'proof', 'residual exposure']);
  });

  it('the claim must match within the invariant field, not merely somewhere in the row', async () => {
    const { findDebtRow } = await load();
    // DECOY carries the literal in its `proof` field; whole-block discovery alone would call the pair
    // ambiguous. Preferring the invariant field resolves it to the ONE row that really owns it.
    assert.equal(findDebtRow(QUEUE, DEFERRABLE).fields.invariant, DEFERRABLE);
    assert.equal(await codeOf({ cls: 'new-invariant', claim: DEFERRABLE }), 'new-invariant');
    // A literal that lives ONLY in another field falls back to whole-block discovery and is refused.
    const proofOnly = findDebtRow(QUEUE, 'covered beside every claimed criterion');
    assert.equal(proofOnly.found, true);
    assert.equal(proofOnly.claimInInvariant, false);
    assert.equal(await codeOf({ cls: 'new-invariant', claim: 'covered beside every claimed criterion' }), 'new-invariant-claim-not-invariant');
  });

  it('a field value continues across wrapped lines', async () => {
    const { findDebtRow } = await load();
    const claim = 'a field value that wraps across lines is read whole, tail included';
    assert.equal(findDebtRow(QUEUE, claim).claimInInvariant, true, 'the tail of a wrapped invariant is part of it');
    assert.equal(await codeOf({ cls: 'new-invariant', claim }), 'new-invariant');
  });

  it('origin must be a file:line — the canon requires it', async () => {
    const { findDebtRow } = await load();
    assert.deepEqual(findDebtRow(QUEUE, 'a deferral row carries five fields').missing, ['proof'], 'an absent field is named too');
    const shapeless = 'origin (the canon requires a file:line)';
    for (const claim of ['the origin of a deferral is a file and a line', 'a line number is a number and nothing glued to it', 'a file has no line zero']) {
      assert.deepEqual(findDebtRow(QUEUE, claim).missing, [shapeless], `refused: ${claim}`);
      assert.equal(await codeOf({ cls: 'new-invariant', claim }), 'new-invariant-row-incomplete');
    }
    // Trailing context after the token is fine: the canon asks the row to CARRY a file:line.
    assert.deepEqual(findDebtRow(QUEUE, DEFERRABLE).missing, []);
  });

  it('exposure token boundaries: only the two declared forms count, and a mixed declaration fails closed', async () => {
    assert.equal(await exposureOf('a live defect is never queued'), 'live');
    assert.equal(await exposureOf(DEFERRABLE), 'not-live', 'the plain "- not live" form');
    assert.equal(await exposureOf('a contradictory disposition fails closed'), 'live', 'both declared → live');
    // A malformed NEGATIVE declares nothing, and the `live` inside it declares nothing either.
    for (const claim of [
      'a hyphenated non-word is not a disposition',
      'a doubled hyphen is not the declared form',
      'a spaced hyphen is not the declared form',
      'a suffixed token is not the declared form',
      'a prefixed token is not the declared form',
    ]) {
      assert.equal(await exposureOf(claim), null, `undeclared: ${claim}`);
      assert.equal(await codeOf({ cls: 'new-invariant', claim }), 'new-invariant-exposure-undeclared');
    }
    // A REPEATED label is refused before the row is resolved — value or no value, hidden or not.
    const dup = '- **R**\n  - invariant: a repeated label states a contradiction\n  - origin: a.mjs:1\n  - narrow fix: n\n  - proof: p\n  - residual exposure: not live\n  - residual exposure: live\n';
    const hidden = `${dup.replace('  - residual exposure: live\n', '  - invariant: hidden by its own repeat\n')}- **S**\n  - invariant: hidden by its own repeat\n  - origin: b.mjs:2\n  - narrow fix: n\n  - proof: p\n  - residual exposure: none - not live\n`;
    assert.deepEqual((await load()).findDebtRow(dup, 'a repeated label').duplicates, ['residual exposure']);
    assert.equal(await codeOf({ cls: 'new-invariant', claim: 'a repeated label', queueText: dup }), 'new-invariant-row-duplicate-field');
    assert.equal(await codeOf({ cls: 'new-invariant', claim: 'hidden by its own repeat', queueText: hidden }), 'new-invariant-row-duplicate-field');
    assert.equal(await codeOf({ cls: 'new-invariant', claim: 'a repeated label', queueText: dup.replace('  - residual exposure: live\n', '  - residual exposure:\n  - invariant:\n') }), 'new-invariant-row-duplicate-field');
  });

  it('a DONE or CLOSED row title is reported closed', async () => {
    const { findDebtRow } = await load();
    assert.equal(findDebtRow(QUEUE, 'a closed row is not a live deferral').closed, 'DONE');
    assert.equal(findDebtRow(QUEUE, DEFERRABLE).closed, null);
  });
});

describe('decideFoldScope — in-scope: the fold arm', () => {
  it('ACCEPTs when the claim matches within ONE acceptance bullet (exit 0)', async () => {
    const r = await decide({ cls: 'in-scope', claim: IN_ACCEPTANCE });
    assert.equal(r.verdict, 'ACCEPT');
    assert.equal(r.code, 'in-scope');
    assert.equal(r.exit, 0);
    assert.ok(r.lines.join('\n').includes('fold here'), 'the accepted arm names the disposition');
    assert.equal((await decide({ cls: 'in-scope', claim: WRAPPED_BULLET })).verdict, 'ACCEPT', 'a claim spanning a WRAPPED bullet is still ONE bullet');
  });

  it('REFUSEs a claim that matches no acceptance bullet, naming the narrow-fix + queue-row lane (exit 1)', async () => {
    const r = await decide({ cls: 'in-scope', claim: 'the checker mints a receipt a gate reads' });
    assert.equal(r.verdict, 'REFUSE');
    assert.equal(r.code, 'in-scope-unmatched');
    assert.equal(r.exit, 1);
    const out = r.lines.join('\n');
    assert.ok(out.includes('NARROW fix'), 'the refusal names the narrow fix');
    assert.ok(out.includes('new-invariant'), 'and the queue-row lane');
    assert.ok(out.includes('blocking'), 'and the blocking lane when no narrow fix exists');
  });

  it('REFUSEs a claim that spans TWO bullets — a criterion is matched within one', async () => {
    assert.equal(await codeOf({ cls: 'in-scope', claim: 'REFUSE when it matches nothing. Exit code 0 for every ACCEPT' }), 'in-scope-unmatched');
  });
});

describe('decideFoldScope — new-invariant: the deferral arm', () => {
  it('ACCEPTs when the row carries five fields, the invariant is in no bullet, and the exposure is not live (exit 0)', async () => {
    const r = await decide({ cls: 'new-invariant', claim: DEFERRABLE });
    assert.equal(r.verdict, 'ACCEPT');
    assert.equal(r.code, 'new-invariant');
    assert.equal(r.exit, 0);
    const out = r.lines.join('\n');
    assert.ok(out.includes('narrow fix ships'), 'the narrow fix is not deferred');
    assert.ok(out.includes('ONLY the generalization'), 'only the generalization defers');
  });

  it('REFUSEs when the invariant IS an acceptance bullet, routing to the fold arm', async () => {
    const r = await decide({ cls: 'new-invariant', claim: IN_ACCEPTANCE });
    assert.equal(r.code, 'new-invariant-already-accepted');
    assert.equal(r.exit, 1);
    assert.ok(r.lines.join('\n').includes('--class in-scope'), 'already-required work routes to the fold arm');
  });

  it('REFUSEs when no queue row carries the literal, and when several do', async () => {
    const { findDebtRow } = await load();
    const absent = await decide({ cls: 'new-invariant', claim: 'an invariant nobody queued' });
    assert.equal(absent.code, 'new-invariant-row-absent');
    assert.ok(absent.lines.join('\n').includes('residual exposure'), 'the refusal lists the five fields the row owes');
    assert.deepEqual(findDebtRow(QUEUE, 'nothing in the queue says this'), { found: false, matches: 0, fields: {}, missing: (await load()).ROW_FIELDS, duplicates: [], exposure: null, closed: null, claimInInvariant: false });
    const many = await decide({ cls: 'new-invariant', claim: 'queued 2026-08-22' });
    assert.equal(many.code, 'new-invariant-row-ambiguous');
    assert.ok(many.lines.join('\n').includes(`${OPEN_ROWS} queue rows`), 'the refusal counts the rows it saw');
    assert.equal(findDebtRow(QUEUE, '   ').matches, 0, 'an empty claim matches nothing');
  });

  it('REFUSEs an incomplete row, NAMING the missing field', async () => {
    const r = await decide({ cls: 'new-invariant', claim: 'a deferral row carries five fields' });
    assert.equal(r.code, 'new-invariant-row-incomplete');
    assert.ok(r.lines.join('\n').includes('proof'), 'the missing field is named, not merely counted');
  });

  it('a DONE or CLOSED row is refused before its fields are judged', async () => {
    const r = await decide({ cls: 'new-invariant', claim: 'a closed row is not a live deferral' });
    assert.equal(r.code, 'new-invariant-row-closed');
    assert.equal(r.exit, 1);
    assert.ok(r.lines.join('\n').includes('DONE'), 'the refusal quotes the marker it saw');
  });

  it('REFUSEs a LIVE residual exposure, routing to the blocking arm', async () => {
    const r = await decide({ cls: 'new-invariant', claim: 'a live defect is never queued' });
    assert.equal(r.code, 'new-invariant-exposure-live');
    assert.ok(r.lines.join('\n').includes('--class blocking'), 'a live defect routes to blocking');
  });
});

describe('decideFoldScope — blocking, and the fail-closed argument arms', () => {
  it('ACCEPTs blocking, states that the phase does not close, and offers NO arm turning it into a queue', async () => {
    const r = await decide({ cls: 'blocking', claim: 'a claim in no bullet and no row' });
    assert.equal(r.verdict, 'ACCEPT');
    assert.equal(r.code, 'blocking');
    assert.equal(r.exit, 0);
    const out = r.lines.join('\n');
    assert.ok(out.includes('the phase does not close'), 'the consequence is printed');
    assert.ok(!/queue/i.test(out), 'the blocking arm never offers a queue lane');
    assert.ok(!out.includes('new-invariant'), 'nor the deferral class');
    assert.equal((await decide({ cls: 'blocking', claim: IN_ACCEPTANCE })).verdict, 'ACCEPT', 'the arm is the reviewer call, not the plan');
  });

  it('REFUSEs an unknown class and an absent one, with no default arm (exit 2)', async () => {
    for (const cls of ['fold', '', undefined, null]) {
      const r = await decide({ cls, claim: IN_ACCEPTANCE });
      assert.equal(r.verdict, 'REFUSE', `class ${JSON.stringify(cls)} is refused`);
      assert.equal(r.code, 'class-unknown');
      assert.equal(r.exit, 2);
      assert.ok(r.lines.join('\n').includes('no default arm'));
    }
  });

  it('REFUSEs an absent claim — a finding with no named invariant has no scope to decide (exit 2)', async () => {
    for (const claim of ['', '   ', undefined]) {
      const r = await decide({ cls: 'in-scope', claim });
      assert.equal(r.code, 'claim-absent');
      assert.equal(r.exit, 2);
    }
  });

  it('called with nothing at all, refuses instead of throwing', async () => {
    const { decideFoldScope } = await load();
    assert.equal(decideFoldScope().code, 'class-unknown');
    assert.equal(decideFoldScope({ cls: 'in-scope', claim: 'x' }).code, 'in-scope-unmatched', 'absent plan text = no criteria');
  });

  it('every ACCEPT exits 0 and every REFUSE exits non-zero — the CLI contract, at the core', async () => {
    const cases = [
      { cls: 'in-scope', claim: IN_ACCEPTANCE },
      { cls: 'new-invariant', claim: DEFERRABLE },
      { cls: 'blocking', claim: 'anything' },
      { cls: 'in-scope', claim: 'unmatched' },
      { cls: 'new-invariant', claim: 'unmatched' },
      { cls: 'nope', claim: 'x' },
    ];
    for (const c of cases) {
      const r = await decide(c);
      assert.equal(r.exit === 0, r.verdict === 'ACCEPT', `${c.cls}/${c.claim}: exit code follows the verdict`);
      assert.ok(r.lines.length >= 2, 'every verdict prints its reason, never a bare word');
      assert.ok(r.lines[0].startsWith(`fold-scope: ${r.verdict}`), 'the first line carries the verdict');
    }
  });
});
