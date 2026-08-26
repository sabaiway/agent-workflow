import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The markdown the auditor reads through: fences, CRLF, frontmatter, an empty file.
//
// The module is reached by DYNAMIC import: a static import of a file that does not exist yet makes
// the suite unresolvable, and an unresolvable suite cannot be OBSERVED red.
const load = () => import('../queue-audit.mjs');

const rowsOf = async (text, options) => (await load()).auditQueue(text, options).rows;

describe('queue-audit — the block model it reads through', () => {
  it('a bullet inside a fenced sample is never a row', async () => {
    const text = [
      '- **A-ROW — queued 2026-08-26.** Work.',
      '',
      '```',
      '- **DONE 2026-01-01 — a sample row inside a fence.**',
      '```',
    ].join('\n');
    const rows = await rowsOf(text);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].klass, 'live');
  });

  it('CRLF input classifies identically and reports the same line numbers', async () => {
    const lines = ['- **A-ROW — queued 2026-08-26.** Work.', '- **B-ROW — ✅ CLOSED 2026-08-20.** Done.'];
    const lf = await rowsOf(lines.join('\n'));
    const crlf = await rowsOf(lines.join('\r\n'));
    assert.deepEqual(
      crlf.map((r) => [r.line, r.klass]),
      lf.map((r) => [r.line, r.klass]),
    );
  });

  it('rows are reported with 1-based file lines, frontmatter included', async () => {
    const text = ['---', 'type: index', 'maxLines: 400', '---', '', '# Queue', '', '- **A-ROW — queued.** Work.'].join('\n');
    const [row] = await rowsOf(text);
    assert.equal(row.line, 8);
  });

  // spec:queue-audit/S13
  it('a fence CONTINUES a row — its span is counted and a closure past it is not lost', async () => {
    // Measured on the live corpus before this rule: one row reported 65 lines against a physical 93,
    // so the per-row cap could be walked straight past behind a code block, and a `**DONE …:**` two
    // lines below the fence was invisible to the classifier.
    const closed = ['- **A-ROW — a row.** Work.', '  ```', '  code', '  ```', '  **DONE 2026-01-01:** closed after the fence.'].join('\n');
    const [row] = await rowsOf(closed);
    assert.equal(row.lines, 5, 'the row is its PHYSICAL extent, fence included');
    assert.equal(row.klass, 'terminal', 'the closure past the fence decides the row');

    // ...and the fence is still a QUOTATION: a status inside it is code, never a state.
    const quoted = ['- **B-ROW — a row.** Work.', '  ```', '  **DONE 2026-01-01:** quoted, not a status.', '  ```', '  more prose.'].join('\n');
    const [quotedRow] = await rowsOf(quoted);
    assert.equal(quotedRow.lines, 5);
    assert.equal(quotedRow.klass, 'live', 'a marker inside a fence never decides a row');
  });

  // spec:queue-audit/S14
  it('a list item this grammar does not read REFUSES — a domain never looked at is not a green', async () => {
    const { auditQueue } = await load();
    // Measured: a section of dead work written with `*` bullets reported "0 rows" and exit 0.
    // The EMPTY forms count too: an empty `*` still opens a list whose indented content the audit
    // would then never judge.
    for (const item of ['* **A-ROW — ✅ DONE 2026-01-01.** dead.', '+ **A-ROW — ✅ DONE 2026-01-01.** dead.', '-', '*', '+']) {
      assert.throws(() => auditQueue(`## Pending\n\n${item}\n`, { section: '## Pending' }), (err) => {
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /does not read/);
        return true;
      }, `"${item}" must refuse, never vanish`);
    }
    // An INDENTED item is a row's own nested content, not a top-level row.
    const nested = '## Pending\n\n- **A-ROW — queued 2026-08-26.** Work.\n  * a nested point.\n';
    assert.deepEqual((await rowsOf(nested, { section: '## Pending' })).map((r) => r.klass), ['live']);
  });

  // spec:queue-audit/S15
  it('a DOCUMENT-level fence closes a row; only a nested one continues it, and no span crosses it', async () => {
    // Absorbing a column-0 fence charged a one-line row for six. And with the fenced lines elided, a
    // bold opener above a fence and a `:**` below it became adjacent — one claim the document never
    // made — so the row records where the gap was.
    const documentLevel = ['- **A-ROW — a row.** Work.', '', '```', 'a document block', '```', ''].join('\n');
    const [outer] = await rowsOf(documentLevel);
    assert.equal(outer.lines, 2, 'the row is the bullet and the blank line after it, not the block below');

    const straddling = ['- **B-ROW — a row.** Work.', '  **DONE', '  ```', '  code', '  ```', '  2026-01-01:** assembled across a code block.'].join('\n');
    const [split] = await rowsOf(straddling);
    assert.equal(split.klass, 'live', 'a bold span never joins text from both sides of a fence');

    // The TITLE is a bold span too, and it was the one still crossing the gap.
    const titleStraddling = ['- **DONE', '  ```', '  code', '  ```', '  2026-01-01 — A-ROW.** Work.'].join('\n');
    const [titleSplit] = await rowsOf(titleStraddling);
    assert.notEqual(titleSplit.klass, 'terminal', 'a title never closes across a code block either');
  });

  it('an unclosed fence is a LOUD refusal, never a silent empty read', async () => {
    const { auditQueue } = await load();
    assert.throws(() => auditQueue('- **A-ROW.** Work.\n\n```\nunclosed\n'), /never closed/);
  });

  it('an empty queue is not an error', async () => {
    const { auditQueue } = await load();
    assert.deepEqual(auditQueue('').rows, []);
    assert.equal(auditQueue('').counts.live, 0);
  });
});
