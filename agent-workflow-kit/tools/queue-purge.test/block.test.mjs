import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const load = () => import('../queue-purge-archive.mjs');
const loadVerbs = () => import('../queue-purge.mjs');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SECTION = '## Pending';
const DATE = '2026-09-10';
const QUEUE = 'docs/plans/queue.md';
const makeInput = () => ({
  date: DATE, section: SECTION, queuePath: QUEUE,
  sectionBytes: Buffer.from('## Pending\nPreamble.\n### Bucket\n- **A-ROW** Body.\n\nBetween.\n- **B-ROW** More.\n'),
  indexEntries: [
    { line: 7, klass: 'live', id: 'A-ROW', title: 'A-ROW' },
    { line: 10, klass: 'live', id: 'B-ROW', title: 'B-ROW' },
  ],
});

describe('queue-purge archive', () => {
  // spec:queue-purge/S1
  it('frames all section bytes and every row, including repeated classes', async () => {
    const { frameBlock, readArchive, judgeIntact } = await load();
    const input = makeInput();
    const archive = readArchive(frameBlock(input));
    assert.equal(judgeIntact(archive), true);
    assert.equal(archive.blocks.length, 1);
    assert.deepEqual(archive.blocks[0].sectionBytes, input.sectionBytes);
    assert.deepEqual(archive.blocks[0].indexEntries, input.indexEntries);
    assert.equal(archive.blocks[0].rowCount, 2);
  });

  // spec:queue-purge/S2
  it('records the ordered fields, one empty line, both lengths and independently checked digests', async () => {
    const { frameBlock, readArchive } = await load();
    const input = makeInput();
    const bytes = frameBlock({ ...input, section: '## Pending ##' });
    const split = bytes.indexOf('\n\n') + Buffer.byteLength('\n\n');
    const index = Buffer.from('7\tlive\tA-ROW\tA-ROW\n10\tlive\tB-ROW\tB-ROW\n');
    const unsealed = [
      'queue-purge: 1', `date: ${DATE}`, 'section: "## Pending"', `queue-path: "${QUEUE}"`,
      `section-bytes: ${input.sectionBytes.length}`, `index-bytes: ${index.length}`,
      `section-sha256: ${digest(input.sectionBytes)}`, 'rows: 2', '', '',
    ].join('\n');
    const seal = digest(Buffer.concat([Buffer.from(unsealed), input.sectionBytes, index]));
    const expected = unsealed.replace('rows: 2', `block-sha256: ${seal}\nrows: 2`);
    assert.equal(bytes.subarray(0, split).toString(), expected);
    assert.deepEqual(bytes.subarray(split), Buffer.concat([input.sectionBytes, index]));
    assert.equal(readArchive(bytes).blocks[0].blockDigest.toString('hex'), seal);
  });

  // spec:queue-purge/S3
  it('slices physical byte offsets for CRLF, multibyte, incomplete UTF-8 and empty or unterminated sections', async () => {
    const { sliceSection, readArchive } = await load();
    const { snapshotQueue } = await loadVerbs();
    const cases = [
      { prefix: '# Queue\r\n', body: '## Pending\r\n- **A-ROW** caf\u00e9.\r\n', tail: '## Next\r\n' },
      { prefix: '# \u03bb\n', body: '## Pending\n- **A-ROW** \u2603\n', tail: '## Next\n' },
      { prefix: '', body: '## Pending\n- **A-ROW** no newline', tail: '' },
      { prefix: '', body: '## Pending\n', tail: '## Next\n' },
      { prefix: '', body: '## Pending', tail: '' },
    ];
    for (const { prefix, body, tail } of cases) {
      const queueBytes = Buffer.from(prefix + body + tail);
      const result = snapshotQueue({ queueBytes, queuePath: QUEUE, section: SECTION, date: DATE });
      assert.equal(result.ok, true);
      assert.deepEqual(readArchive(result.block).blocks[0].sectionBytes, Buffer.from(body));
    }
    const incomplete = Buffer.concat([Buffer.from('## Pending\n- **A-ROW** '), Buffer.from([0xe2, 0x82])]);
    const result = snapshotQueue({ queueBytes: incomplete, queuePath: QUEUE, section: SECTION, date: DATE });
    assert.deepEqual(readArchive(result.block).blocks[0].sectionBytes, incomplete);
    assert.deepEqual(sliceSection(Buffer.from('x\r\n## Pending\r\ny\r\n## Next'), { headingLine: 2, to: 4 }),
      Buffer.from('## Pending\r\ny\r\n'));
  });

  // spec:queue-purge/S8
  it('refuses each broken digest and count, names block and intact offset, and suppresses key comparisons', async () => {
    const { frameBlock, readArchive, judgeIntact } = await load();
    const { checkPurge } = await loadVerbs();
    const first = frameBlock(makeInput());
    const mutations = [
      (text) => text.replace(/block-sha256: ./, 'block-sha256: f'),
      (text) => text.replace(/section-sha256: ./, 'section-sha256: f'),
      (text) => text.replace('rows: 2', 'rows: 3'),
      (text) => text.replace('rows: 2', 'rows: two'),
      (text) => text.replace(/section: "[^"]*"/, 'section: 1'),
    ];
    for (const mutate of mutations) {
      const broken = Buffer.from(mutate(first.toString()));
      assert.notDeepEqual(broken, first);
      const archiveBytes = Buffer.concat([first, broken]);
      const archive = readArchive(archiveBytes);
      assert.equal(judgeIntact(archive), false);
      assert.equal(archive.cause, 'not-intact');
      assert.equal(archive.offset, first.length);
      assert.match(archive.problem, /block 2/);
      const result = checkPurge({ queueBytes: Buffer.from('## Pending\n- **NEW-ROW** Added.\n'),
        section: SECTION, archiveBytes });
      assert.equal(result.ok, false);
      assert.match(result.problems.join('\n'), new RegExp(`offset ${first.length}`));
      assert.doesNotMatch(result.problems.join('\n'), /addition|absence/);
    }
  });

  // spec:queue-purge/S18
  it('seals the index class and header section, even though section bytes remain untouched', async () => {
    const { frameBlock, readArchive, judgeIntact } = await load();
    const bytes = frameBlock(makeInput());
    for (const edited of [bytes.toString().replace('\tlive\t', '\tdead\t'),
      bytes.toString().replace('section: "## Pending"', 'section: "## Changed"')]) {
      const archive = readArchive(Buffer.from(edited));
      assert.equal(judgeIntact(archive), false);
      assert.equal(archive.offset, 0);
      assert.match(archive.problem, /block 1.*offset 0/);
    }
  });
});
