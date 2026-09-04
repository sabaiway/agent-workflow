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

  it('every row carries its outermost-first heading lineage with file lines', async () => {
    const text = [
      '---', 'type: state', '---',
      '- **An unheaded row stays visible — ROW-A.** Work.',
      '', '# Plans queue', '', '## Parent bucket', '', '### Child bucket', '',
      '- **A nested row stays visible — ROW-B.** Work.',
    ].join('\n');
    const rows = await rowsOf(text);
    assert.equal(rows[0].line, 4);
    assert.deepEqual(rows[0].buckets, []);
    assert.equal(rows[1].line, 12);
    assert.deepEqual(rows[1].buckets, [
      { level: 1, text: '# Plans queue', line: 6 },
      { level: 2, text: '## Parent bucket', line: 8 },
      { level: 3, text: '### Child bucket', line: 10 },
    ]);
  });

  // ONE rule covers every arm below: a heading token a row SWALLOWS is REFUSED. The tokenizer reads
  // a 1-3-space indented ATX line as a heading while the bullet scan reads the same line as row
  // continuation, and no arithmetic reconciles them — deciding silently was tried twice and produced
  // the same defect twice, each time on a different opener. The corpus writes no such line: zero
  // indented ATX headings in the 850 KB queue and in every plan and reference doc.
  const refuses = async (text, options, line) => {
    const { auditQueue } = await load();
    assert.throws(() => auditQueue(text, options), (err) => {
      assert.equal(err.exitCode, 2);
      assert.match(err.message, new RegExp(`line ${line}`));
      assert.match(err.message, /read differently/);
      return true;
    }, `line ${line} is read two ways and must refuse`);
  };

  // Read raw, this `  ## Details` ended the `--section` early and the dead row after it went
  // UNJUDGED — a gate answering about a domain it never looked at, over the rows a purge is driven
  // by. Dropped, the section ran past the NEXT heading instead. Neither reading is the document's.
  it('a heading inside a row body never ends the section that row lives in', async () => {
    const text = [
      '## Pending',
      '',
      '- **A first row — ROW-A.** Work.',
      '  ## Details',
      '  more body',
      '',
      '- **A dead row — ✅ DONE 2026-01-01.** Shipped.',
    ].join('\n');
    await refuses(text, { section: '## Pending' }, 4);
    await refuses(text, undefined, 4);
  });

  // The lineage half of the same line: dropped, this `  ### Details` gave the NEXT row a bucket the
  // document never opened for it.
  it('an indented heading inside a row body is never a bucket of the next row', async () => {
    const text = [
      '## Bucket',
      '',
      '- **A first row — ROW-A.** Work.',
      '  ### Details',
      '  more body',
      '',
      '- **A second row — ROW-B.** Work.',
    ].join('\n');
    await refuses(text, undefined, 4);
  });

  // The two openers a COLUMN rule had to get right and did not, which is why there is no column
  // rule. One space under a `- ` row: the document ends the list item and opens a section, the
  // bullet scan keeps the row open, and the archived row below was reported as a terminal row still
  // listed — in the manifest a deletion is driven by. A TAB after the bullet: the body column is a
  // tab-stop question this hand-written reader does not answer, and counting characters said 2
  // where the document says 4. Under one rule both are the same line.
  it('a heading indented below its row body column is a refusal, never a silent boundary', async () => {
    const spaced = [
      '## Pending',
      '',
      '- **A-ROW is still open — queued 2026-08-26.** Work.',
      ' ## Series plans (done)',
      '',
      '- **B-ROW shipped long ago — DONE 2026-01-01.** Shipped.',
    ].join('\n');
    await refuses(spaced, { section: '## Pending' }, 4);
    await refuses(spaced, undefined, 4);
    const tabbed = [
      '## Pending',
      '',
      `-${String.fromCharCode(9)}**A-ROW is still open — queued 2026-08-26.** Work.`,
      '  ## Series plans (done)',
      '',
      '- **B-ROW shipped long ago — DONE 2026-01-01.** Shipped.',
    ].join('\n');
    await refuses(tabbed, { section: '## Pending' }, 4);
  });

  // The COMPLEMENT the pair above leaves untested: the rule is "a heading this row SWALLOWS", not
  // "any indented heading". One that sits inside no row is a boundary and a bucket exactly as a
  // column-0 heading is.
  it('an indented heading inside no row is still a boundary and a bucket', async () => {
    const text = [
      '## Bucket',
      '',
      'Prose, not a row.',
      '  ### Details',
      '',
      '- **A-ROW is still open — queued 2026-08-26.** Work.',
    ].join('\n');
    const rows = await rowsOf(text);
    assert.deepEqual(rows[0].buckets.map(({ text: heading }) => heading), ['## Bucket', '  ### Details']);
    assert.deepEqual(await classOf(text, { section: '### Details' }), ['live']);
  });
});
