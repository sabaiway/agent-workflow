import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The manifest a deletion is driven by.
//
// The module is reached by DYNAMIC import: a static import of a file that does not exist yet makes
// the suite unresolvable, and an unresolvable suite cannot be OBSERVED red.
const load = () => import('../queue-audit.mjs');

describe('queue-audit — the report', () => {
  it('every row appears once, with its line, class and title', async () => {
    const { auditQueue, formatReport } = await load();
    const text = ['- **A-ROW — queued 2026-08-26.** Work.', '- **B-ROW — ✅ DONE 2026-08-20.** Shipped.'].join('\n');
    const report = formatReport(auditQueue(text));
    const body = report.split('\n').filter((line) => /^\d+\t/.test(line));
    assert.equal(body.length, 2);
    assert.match(body[0], /^1\tlive\t/);
    assert.match(body[1], /^2\tterminal\t/);
    assert.match(body[1], /B-ROW/);
  });
});
