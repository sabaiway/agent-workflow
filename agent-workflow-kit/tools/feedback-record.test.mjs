import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = () => import('./feedback-record.mjs');
const HEAD = 'A'.repeat(40);
const ROWS = [
  '| 1 | Alpha \\| beta | `src/a.mjs:1`, `src/b.mjs:2-3` | confirmed | queue ROW-A |',
  '| 2 | Existing work | `src/c.mjs:4` | works-as-designed | already-queued ROW-B |',
  '| 3 | Gamma | `src/d.mjs:5` | corrected | queue ROW-A |',
];
const record = ({ title = 'Fixture report', source = 'field report', head = HEAD, rows = ROWS, notes = null } = {}) => [
  `# Feedback: ${title}`,
  '',
  `Source: ${source}`,
  '',
  `Head: ${head}`,
  '',
  '## Claims',
  '',
  '| # | Claim | Evidence | Verdict | Disposition |',
  '| --- | --- | --- | --- | --- |',
  ...rows,
  ...(notes === null ? [] : ['', '## Notes', notes]),
  '',
].join('\n');
const row = ({ id = 1, claim = 'Claim', evidence = '`src/a.mjs:1`', verdict = 'confirmed', disposition = 'queue ROW-A' } = {}) =>
  `| ${id} | ${claim} | ${evidence} | ${verdict} | ${disposition} |`;

describe('feedback record parsing [spec:feedback-triage/S1]', () => {
  it('accepts the version one record and exposes the closed vocabularies', async () => {
    const { parseRecord, REFUSALS, VERDICTS } = await load();
    assert.deepEqual(VERDICTS, ['confirmed', 'corrected', 'refuted', 'works-as-designed']);
    assert.deepEqual(REFUSALS, ['title', 'source', 'head', 'table', 'row-cells', 'claim-id', 'anchor-grammar', 'anchor-path', 'verdict', 'disposition', 'anchor-absent', 'anchor-unreadable', 'anchor-line']);
    assert.equal(Object.isFrozen(VERDICTS), true);
    assert.equal(Object.isFrozen(REFUSALS), true);
    const parsed = parseRecord(record({ notes: 'Trailing prose is carried only.' }));
    assert.deepEqual([parsed.title, parsed.source, parsed.head, parsed.refusals], ['Fixture report', 'field report', HEAD, []]);
    assert.deepEqual(parseRecord(record({ head: 'b'.repeat(64) })).refusals, [], 'SHA-256 object ids are accepted too');
    assert.equal(parsed.claims.length, 3);
    assert.deepEqual(parsed.claims[0], {
      id: 1,
      claim: 'Alpha | beta',
      anchors: [
        { path: 'src/a.mjs', start: 1, end: 1, line: 11 },
        { path: 'src/b.mjs', start: 2, end: 3, line: 11 },
      ],
      verdict: 'confirmed',
      disposition: 'queue ROW-A',
      line: 11,
    });
    for (const disposition of ['declined: not reproducible', 'folded: corrected shipped copy']) {
      const variant = parseRecord(record({ rows: [row({ disposition })] }));
      assert.deepEqual([variant.refusals, variant.claims[0].disposition], [[], disposition]);
    }
  });

  it('the pure half imports nothing', () => {
    const source = readFileSync(new URL('./feedback-record.mjs', import.meta.url), 'utf8');
    assert.equal(source.match(/^import /gmu), null);
    assert.doesNotMatch(source, /refuseDirectRun|process\.|node:/u);
  });
});

describe('feedback record structural refusals [spec:feedback-triage/S2]', () => {
  it('stops on each malformed structural element with one named refusal', async () => {
    const { parseRecord } = await load();
    const cases = [
      ['title', record({ title: '' })],
      ['source', record({ source: '' })],
      ['head', record({ head: 'not-an-object-id' })],
      ['table', record().replace('## Claims', '## Other')],
      ['table', record().replace('| --- | --- | --- | --- | --- |', '| --- | --- | --- | --- |')],
      ['table', record({ rows: [row(), '', row({ id: 2 })] })],
      ['table', record({ rows: [] })],
    ];
    for (const [name, text] of cases) {
      const parsed = parseRecord(text);
      assert.equal(parsed.refusals.length, 1, name);
      assert.equal(parsed.refusals[0].name, name);
      assert.ok(Number.isInteger(parsed.refusals[0].line), name);
      assert.deepEqual(parsed.claims, [], name);
    }
    const empty = record({ rows: [] });
    const delimiterLine = empty.split('\n').findIndex((line) => line === '| --- | --- | --- | --- | --- |') + 1;
    assert.equal(parseRecord(empty).refusals[0].line, delimiterLine);
  });
});

describe('feedback record row refusals [spec:feedback-triage/S3]', () => {
  it('continues after bad rows and names every row defect', async () => {
    const { parseRecord } = await load();
    const badRows = [
      '| 1 | Too | many | `src/a.mjs:1` | confirmed | queue ROW-A |',
      '| 2 | Traversal | `../outside.mjs:1` | confirmed | queue ROW-B |',
      '| 3 | Bad verdict | `src/c.mjs:1` | maybe | queue ROW-C |',
    ];
    const parsed = parseRecord(record({ rows: badRows }));
    assert.deepEqual(parsed.refusals.map(({ name }) => name), ['row-cells', 'anchor-path', 'verdict']);
    assert.deepEqual(parsed.refusals.map(({ line }) => line), [11, 12, 13]);
    const singleRowCases = [
      ['row-cells', '| 1 | Too | many | `src/a.mjs:1` | confirmed | queue ROW-A |'],
      ['claim-id', row({ id: 2 })],
      ['anchor-grammar', row({ evidence: '`src/a b.mjs:1`' })],
      ['anchor-path', row({ evidence: '`src/../a.mjs:1`' })],
      ['verdict', row({ verdict: 'maybe' })],
      ['disposition', row({ disposition: 'queue row-a' })],
      ['anchor-grammar', row({ evidence: '' })],
      ['anchor-grammar', row({ evidence: '`src/a.mjs:5-2`' })],
    ];
    for (const [name, badRow] of singleRowCases) assert.equal(parseRecord(record({ rows: [badRow] })).refusals[0].name, name);
  });
});

describe('feedback anchor judgment [spec:feedback-triage/S4]', () => {
  it('lists all bad anchors and accepts an in-range span', async () => {
    const { judgeAnchors } = await load();
    const claims = [{ line: 7, anchors: [
      { path: 'missing-a', start: 1, end: 1, line: 7 },
      { path: 'missing-b', start: 1, end: 1, line: 7 },
      { path: 'short', start: 2, end: 3, line: 7 },
      { path: 'sealed', start: 1, end: 1, line: 7 },
      { path: 'inside', start: 2, end: 3, line: 7 },
    ] }];
    const findings = judgeAnchors(claims, {
      'missing-a': { kind: 'absent' },
      'missing-b': { kind: 'other' },
      short: { kind: 'regular', lines: 2 },
      sealed: { kind: 'unreadable', reason: 'EACCES' },
      inside: { kind: 'regular', lines: 3 },
    });
    assert.deepEqual(findings.map(({ name, path }) => [name, path]), [
      ['anchor-absent', 'missing-a'], ['anchor-absent', 'missing-b'],
      ['anchor-line', 'short'], ['anchor-unreadable', 'sealed'],
    ]);
    assert.match(findings.at(-1).message, /EACCES/);
    assert.equal(findings.some(({ path }) => path === 'inside'), false);
  });

  it('renders excerpts against the budget and stops the walk at the limit', async () => {
    const { renderExcerpts } = await load();
    const texts = { 'big.txt': Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`).join('\n') };
    const anchors = Array.from({ length: 400 }, () => ({ path: 'big.txt', start: 1, end: 5000 }));
    const rendered = renderExcerpts(anchors, texts, 10000);
    assert.ok(rendered.startsWith('big.txt:1: line 1'));
    assert.ok(Buffer.byteLength(rendered) <= 10000 + Buffer.byteLength('big.txt:5000: line 5000') + 1);
    assert.equal(
      renderExcerpts([{ path: 'big.txt', start: 2, end: 3 }], texts, 10000),
      'big.txt:2: line 2\nbig.txt:3: line 3',
    );
    const reads = { count: 0 };
    const body = 'line 1';
    const accessorTexts = {};
    Object.defineProperty(accessorTexts, 'big.txt', {
      get: () => { reads.count += 1; return body; }, enumerable: true, configurable: true,
    });
    const fitting = Array.from({ length: 400 }, () => ({ path: 'big.txt', start: 1, end: 1 }));
    renderExcerpts(fitting, accessorTexts, 10000);
    assert.equal(reads.count, 1);
  });
});

describe('feedback queue row rendering [spec:feedback-triage/S5]', () => {
  it('deduplicates queued ids and carries all provenance', async () => {
    const { parseRecord, renderRows } = await load();
    const parsed = parseRecord(record({ rows: [...ROWS, row({ id: 4, claim: 'Declined claim', disposition: 'declined: no defect' }), row({ id: 5, claim: 'Folded claim', disposition: 'folded: fixed copy' })] }));
    const rendered = renderRows(parsed, { date: '2026-09-03', recordPath: 'docs/plans/FEEDBACK-fixture.md' });
    assert.equal(rendered.length, 1);
    const text = rendered[0];
    const title = text.split('\n')[0];
    assert.ok(title.includes('ROW-A') && title.includes('Alpha | beta') && !title.includes('Gamma'));
    for (const token of ['ROW-A', 'Alpha | beta', 'Gamma', 'confirmed', 'corrected', 'src/a.mjs:1', 'src/b.mjs:2-3', 'src/d.mjs:5', 'docs/plans/FEEDBACK-fixture.md', HEAD]) assert.ok(text.includes(token), token);
    for (const skipped of ['ROW-B', 'Declined claim', 'Folded claim']) assert.ok(!text.includes(skipped), `${skipped} creates no skeleton row`);
  });
});

describe('feedback queue ratchet [spec:feedback-triage/S6]', () => {
  it('moves by rendered rows or states that the token is absent', async () => {
    const { ratchetLine } = await load();
    assert.equal(ratchetLine('node queue-audit-cli.mjs --check q --max-rows 236 --max-row-lines 190', ['a', 'b']), 'ratchet: queue-audit --max-rows 236 \u2192 238');
    const absent = ratchetLine('node queue-audit-cli.mjs --check q', ['a']);
    assert.ok(absent.includes('--max-rows'));
    assert.doesNotMatch(absent, /\d/u);
  });
});
