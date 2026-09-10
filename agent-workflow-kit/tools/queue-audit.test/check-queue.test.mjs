import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The gate half: what refuses, what only reports, and the two caps.
//
// The module is reached by DYNAMIC import: a static import of a file that does not exist yet makes
// the suite unresolvable, and an unresolvable suite cannot be OBSERVED red.
const load = () => import('../queue-audit.mjs');

describe('queue-audit — checkQueue', () => {
  const LIVE_ROW = '- **A-ROW — queued 2026-08-26.** Work.';

  it('a terminal row still listed is a refusal that NAMES its line', async () => {
    const { checkQueue } = await load();
    const result = checkQueue([LIVE_ROW, '- **B-ROW — ✅ CLOSED 2026-08-20 (AD-100).** Done.'].join('\n'));
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /:2:/);
  });

  it('an ambiguous row is REPORTED but never a refusal on its own', async () => {
    const { checkQueue } = await load();
    const result = checkQueue('- **SUPERSEDED 2026-08-21 — QUEUED 2026-08-20 — A-ROW.** Body.');
    assert.equal(result.ok, true);
    assert.match(result.notes.join('\n'), /ambiguous/);
  });

  it('too many rows, and an over-long row, each refuse with their own location', async () => {
    const { checkQueue } = await load();
    const many = [LIVE_ROW, LIVE_ROW.replace('A-ROW', 'B-ROW'), LIVE_ROW.replace('A-ROW', 'C-ROW')].join('\n');
    const tooMany = checkQueue(many, { maxRows: 2 });
    assert.equal(tooMany.ok, false);
    assert.match(tooMany.problems.join('\n'), /3 rows/);

    const long = [LIVE_ROW, '  a', '  b', '  c'].join('\n');
    const tooLong = checkQueue(long, { maxRowLines: 2 });
    assert.equal(tooLong.ok, false);
    assert.match(tooLong.problems.join('\n'), /:1:/);
  });

  // spec:queue-audit/S5
  it('the caps count and judge every row that carries work — parked and ambiguous included', async () => {
    const { checkQueue } = await load();
    const parked = ['- **PARKED 2026-08-21 — A-ROW.** Frozen.', '  a', '  b', '  c'].join('\n');
    const overLong = checkQueue(parked, { maxRowLines: 2 });
    assert.equal(overLong.ok, false, 'a frozen row cannot grow past the per-row cap');
    assert.match(overLong.problems.join('\n'), /:1:/);

    const three = [LIVE_ROW, '- **PARKED 2026-08-21 — B-ROW.** Frozen.', '- **SUPERSEDED 2026-08-21 — QUEUED — C-ROW.** Body.'].join('\n');
    const tooMany = checkQueue(three, { maxRows: 2 });
    assert.equal(tooMany.ok, false, 'moving rows into Frozen cannot buy room under the row cap');
    assert.match(tooMany.problems.join('\n'), /3 rows/);
  });

  // spec:queue-audit/S21
  it('range keeps every row and unread-item check while reporting the section in file lines', async () => {
    const { auditQueue } = await load();
    const lines = ['## Before', LIVE_ROW, '## Pending ##', 'Preamble.', LIVE_ROW,
      '### Details', LIVE_ROW, '## After', LIVE_ROW];
    for (const prefix of ['', '---\ntype: queue\n---\n']) {
      const shift = prefix ? 3 : 0;
      const text = prefix + lines.join('\n');
      const { range, ...audit } = auditQueue(text, { range: '## Pending' });
      assert.deepEqual(range, { headingLine: 3 + shift, from: 4 + shift, to: 8 + shift });
      assert.equal(audit.total, 4);
      assert.deepEqual(audit.counts, { live: 4, terminal: 0, parked: 0, record: 0, ambiguous: 0 });
      assert.deepEqual(audit.rows.map((row) => row.line), [2, 5, 7, 9].map((line) => line + shift));
      assert.deepEqual(audit, auditQueue(text));
      assert.deepEqual(text.split('\n').slice(range.from - 1, range.to - 1), lines.slice(3, 7));
      assert.throws(() => auditQueue(text + '\n* item', { range: '## Pending' }), { exitCode: 2 });
    }
    assert.deepEqual(auditQueue('## Empty\n## Next', { range: '## Empty' }).range,
      { headingLine: 1, from: 2, to: 2 });
    for (const ending of ['', '\n', '\r\n']) {
      assert.deepEqual(auditQueue('## Empty' + ending, { range: '## Empty' }).range,
        { headingLine: 1, from: 2, to: 2 });
    }
    assert.deepEqual(auditQueue(lines.join('\n'), { range: '## After' }).range,
      { headingLine: 8, from: 9, to: 10 });
    assert.throws(() => auditQueue(lines.join('\n'), { section: '## Before', range: '## Pending' }),
      { exitCode: 2, message: /(?=.*section)(?=.*range)/ });
    for (const text of ['## Other', '## Pending\n## Pending ##']) {
      assert.throws(() => auditQueue(text, { range: '## Pending' }), { exitCode: 2 });
    }
  });

  // spec:queue-audit/S22
  it('authorisesRemoval admits only terminal and record, and checkQueue refuses those classes', async () => {
    const { authorisesRemoval, checkQueue } = await load();
    for (const klass of ['terminal', 'record']) assert.equal(authorisesRemoval(klass), true);
    for (const klass of ['live', 'parked', 'ambiguous', 'unknown', undefined, null, 1, {}, ['terminal']]) {
      assert.equal(authorisesRemoval(klass), false);
    }
    for (const [status, ok] of [['DONE 2026-09-10', false], ['TALLY 2026-09-10', false],
      ['PARKED 2026-09-10', true], ['DONE 2026-09-10 — QUEUED 2026-09-10', true]]) {
      assert.equal(checkQueue(`- **${status} — A-ROW.** Body.`).ok, ok);
    }
  });

  it('a queue inside its caps with no terminal rows is green', async () => {
    const { checkQueue } = await load();
    const result = checkQueue([LIVE_ROW, '- **B-ROW — queued 2026-08-26.** Work.'].join('\n'), {
      maxRows: 10,
      maxRowLines: 40,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.problems, []);
  });
});
