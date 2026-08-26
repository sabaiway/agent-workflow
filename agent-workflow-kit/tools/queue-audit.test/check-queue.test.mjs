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
