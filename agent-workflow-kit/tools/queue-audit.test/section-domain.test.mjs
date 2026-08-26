import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Which part of the file an audit covers, and its refusal to guess.
//
// The module is reached by DYNAMIC import: a static import of a file that does not exist yet makes
// the suite unresolvable, and an unresolvable suite cannot be OBSERVED red.
const load = () => import('../queue-audit.mjs');

const rowsOf = async (text, options) => (await load()).auditQueue(text, options).rows;
const classOf = async (text, options) => (await rowsOf(text, options)).map((row) => row.klass);

describe('queue-audit — the section domain', () => {
  const TEXT = [
    '# Plans queue',
    '',
    '## Pending / backlog (newest)',
    '',
    '- **A-ROW — queued 2026-08-26.** Work.',
    '',
    '## Series plans (done)',
    '',
    '- **AN-ARCHIVED-ROW — ✅ DONE 2026-01-01.** Shipped.',
  ].join('\n');

  it('without a section the whole document is audited', async () => {
    assert.deepEqual(await classOf(TEXT), ['live', 'terminal']);
  });

  it('a named section bounds the audit at the next same-or-higher heading', async () => {
    const rows = await rowsOf(TEXT, { section: '## Pending / backlog (newest)' });
    assert.deepEqual(
      rows.map((r) => r.klass),
      ['live'],
    );
  });

  it('a section that does not exist is a named refusal, never an empty pass', async () => {
    const { auditQueue } = await load();
    assert.throws(() => auditQueue(TEXT, { section: '## No Such Heading' }), /## No Such Heading/);
  });

  // Ambiguity refuses on the same footing as absence. Taking the first of two same-named headings
  // would leave every row under the second outside the audit — uncounted by the caps and missing
  // from the report a deletion is driven by, with nothing said about it.
  // spec:queue-audit/S17
  it('an ATX closing run is the SAME heading — `## Pending ##` never hides a second section', async () => {
    // Measured: with raw-text matching, a file carrying `## Pending ##` and `## Pending` reported one
    // live row and exit 0 while a dead row sat under the other spelling.
    const { auditQueue } = await load();
    const twoSpellings = '## Pending ##\n\n- **A-ROW — ✅ DONE 2026-01-01.** dead.\n\n## Pending\n\n- **B-ROW — queued 2026-08-26.** work.\n';
    assert.throws(() => auditQueue(twoSpellings, { section: '## Pending' }), /2 section headings/);
    const closed = '## Pending ##\n\n- **A-ROW — ✅ DONE 2026-01-01.** dead.\n';
    assert.deepEqual(auditQueue(closed, { section: '## Pending' }).rows.map((r) => r.klass), ['terminal'], 'either spelling names the same section');
  });

  // spec:queue-audit/S8
  it('two headings with the SAME name refuse, naming both lines — never the first one silently', async () => {
    const { auditQueue } = await load();
    const twice = [
      '# Plans queue',
      '',
      '## Pending',
      '',
      '- **A-ROW — queued 2026-08-26.** Work.',
      '',
      '## Pending',
      '',
      '- **B-ROW — queued 2026-08-26.** Work the first window never reaches.',
    ].join('\n');
    assert.throws(() => auditQueue(twice, { section: '## Pending' }), (err) => {
      assert.equal(err.exitCode, 2, 'a usage refusal, not a document refusal');
      assert.match(err.message, /2 section headings/);
      assert.match(err.message, /3, 7/, 'both heading lines are named');
      return true;
    });
  });

  // Every line this module prints is a FILE line, frontmatter included — the row manifest already
  // counts that way. A refusal quoting body-relative lines sends a reader to the wrong place in the
  // very file it is refusing.
  it('the duplicate refusal counts FILE lines, so frontmatter does not shift them', async () => {
    const { auditQueue } = await load();
    const withFront = ['---', 'type: state', '---', '## Pending', '', '## Pending', ''].join('\n');
    assert.throws(() => auditQueue(withFront, { section: '## Pending' }), (err) => {
      assert.match(err.message, /lines 4, 6\b/, 'the frontmatter offset is added to both');
      return true;
    });
  });
});
