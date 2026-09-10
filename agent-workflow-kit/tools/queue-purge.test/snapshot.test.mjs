import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const load = () => import('../queue-purge.mjs');
const loadArchive = () => import('../queue-purge-archive.mjs');
const SECTION = '## Pending';
const OPTIONS = { queuePath: 'queue.md', section: SECTION, date: '2026-09-10' };
const ORIGINAL = Buffer.from('## Pending\n- **A-ROW** Original.\n## Later\n- **B-ROW** Another.\n');

describe('queue-purge snapshot', () => {
  // spec:queue-purge/S4
  it('appends whole blocks, refuses unchanged snapshots and admits a different section', async (t) => {
    const { snapshotQueue } = await load();
    const { appendBlock, readArchive } = await loadArchive();
    const dir = mkdtempSync(join(tmpdir(), 'purge-append-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'archive.txt');
    const first = snapshotQueue({ ...OPTIONS, queueBytes: ORIGINAL });
    assert.equal(first.ok, true);
    appendBlock(path, first.block);
    assert.deepEqual(readFileSync(path), first.block);
    const duplicate = snapshotQueue({ ...OPTIONS, queueBytes: ORIGINAL, archiveBytes: readFileSync(path) });
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.problems.join('\n'), /same section digest.*## Pending/);
    const other = snapshotQueue({ ...OPTIONS, section: '## Later', queueBytes: ORIGINAL, archiveBytes: readFileSync(path) });
    assert.equal(other.ok, true);
    appendBlock(path, other.block);
    assert.equal(snapshotQueue({ ...OPTIONS, queueBytes: ORIGINAL, archiveBytes: readFileSync(path) }).ok, false);
    const moved = snapshotQueue({ ...OPTIONS, queueBytes: Buffer.from(ORIGINAL.toString().replace('Original.', 'Trim.')),
      archiveBytes: readFileSync(path) });
    assert.equal(moved.ok, true);
    appendBlock(path, moved.block);
    assert.deepEqual(readFileSync(path), Buffer.concat([first.block, other.block, moved.block]));
    assert.equal(readArchive(readFileSync(path)).blocks.length, 3);
    assert.deepEqual(readdirSync(dir), ['archive.txt']);
    const alias = join(dir, 'alias.txt');
    symlinkSync(path, alias);
    assert.throws(() => appendBlock(alias, first.block));
    const folder = join(dir, 'folder');
    mkdirSync(folder);
    assert.throws(() => appendBlock(folder, first.block));
    assert.deepEqual(readFileSync(path), Buffer.concat([first.block, other.block, moved.block]));
  });

  // spec:queue-purge/S7
  it('archives keyless rows with notes, refuses them in checks and rejects document-wide duplicated ids', async () => {
    const { snapshotQueue, checkPurge } = await load();
    const { readArchive } = await loadArchive();
    const queueBytes = Buffer.from('## Pending\n- **No key here** Body cites A-ROW.\n## Later\n- **A-ROW** Body.\n');
    const result = snapshotQueue({ ...OPTIONS, queueBytes });
    assert.equal(result.ok, true);
    assert.match(result.notes.join('\n'), /1 keyless/);
    assert.equal(readArchive(result.block).blocks[0].indexEntries[0].id, null);
    const checked = checkPurge({ queueBytes, section: SECTION, archiveBytes: result.block });
    assert.equal(checked.ok, false);
    assert.match(checked.problems.join('\n'), /key defect.*line 2.*No key here/);
    assert.match(checked.problems.join('\n'), /keyless entry.*archived line 2.*No key here/);
    for (const text of [
      '## Pending\n- **A-ROW** Here.\n## Later\n- **A-ROW** There.\n',
      '## Later\n- **A-ROW** First.\n- **A-ROW** Second.\n## Pending\n',
    ]) {
      const args = { ...OPTIONS, queueBytes: Buffer.from(text), archiveBytes: result.block };
      for (const verb of [snapshotQueue, checkPurge]) {
        const refused = verb(args);
        assert.equal(refused.ok, false);
        assert.match(refused.problems.join('\n'), /doubled id A-ROW.*lines 2 (?:and|,) ?[34]/);
      }
    }
    const keyed = snapshotQueue({ ...OPTIONS, queueBytes: ORIGINAL });
    assert.deepEqual(keyed.notes, []);
    for (const text of ['## Pending\n## Later\n* unread\n', '## Pending\n- **A-ROW** Body\n  ## Swallowed\n']) {
      for (const verb of [snapshotQueue, checkPurge]) {
        assert.throws(() => verb({ ...OPTIONS, queueBytes: Buffer.from(text), archiveBytes: keyed.block }),
          (err) => err.exitCode === 2 && /line 3/.test(err.message));
      }
    }
  });

  // spec:queue-purge/S16
  it('refuses an interrupted block tail without falling back, including only independent key defects', async () => {
    const { snapshotQueue, checkPurge } = await load();
    const first = snapshotQueue({ ...OPTIONS, queueBytes: ORIGINAL });
    const nextQueue = Buffer.from(ORIGINAL.toString().replace('Original.', 'Changed.'));
    const next = snapshotQueue({ ...OPTIONS, queueBytes: nextQueue });
    for (const tail of [next.block.subarray(0, 20), next.block.subarray(0, next.block.length - 1), Buffer.from('stray tail')]) {
      const archiveBytes = Buffer.concat([first.block, tail]);
      for (const verb of [snapshotQueue, checkPurge]) {
        const result = verb({ ...OPTIONS, queueBytes: Buffer.from('## Pending\n- **No key** Body.\n'), archiveBytes });
        assert.equal(result.ok, false);
        assert.match(result.problems.join('\n'), new RegExp(`not intact.*block 2.*offset ${first.block.length}`));
        assert.doesNotMatch(result.problems.join('\n'), /addition|absence|not moved|keyless entry/);
        if (verb === checkPurge) assert.match(result.problems.join('\n'), /key defect.*line 2/);
      }
    }
  });
});
