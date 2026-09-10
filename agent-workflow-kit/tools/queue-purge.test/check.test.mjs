import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const load = () => import('../queue-purge.mjs');
const SECTION = '## Work';
const makeRecord = ({ section = SECTION, body = '## Work\nOriginal prose.\n', entries = [] } = {}) => {
  const sectionBytes = Buffer.from(body);
  const index = Buffer.from(entries.map(([line, klass, id, title]) => `${line}\t${klass}\t${id}\t${title}\n`).join(''));
  const hashSection = createHash('sha256').update(sectionBytes).digest('hex');
  const fields = ['queue-purge: 1', 'date: 2026-09-10', `section: ${JSON.stringify(section)}`,
    'queue-path: "original.md"', `section-bytes: ${sectionBytes.length}`, `index-bytes: ${index.length}`,
    `section-sha256: ${hashSection}`, `rows: ${entries.length}`];
  const hashBlock = createHash('sha256').update(fields.join('\n') + '\n\n').update(sectionBytes).update(index).digest('hex');
  fields.splice(fields.length - 1, 0, `block-sha256: ${hashBlock}`);
  return Buffer.concat([Buffer.from(fields.join('\n') + '\n\n'), sectionBytes, index]);
};

describe('queue-purge check', () => {
  // spec:queue-purge/S5
  it('collects additions and unauthorised absences in the section, with current and archived locations', async () => {
    const { checkPurge } = await load();
    const archiveBytes = makeRecord({ entries: [[27, 'live', 'OLD-ROW', 'Original work']] });
    const result = checkPurge({ archiveBytes, section: SECTION, queueBytes: Buffer.from(
      '## Work\n- **NEW-ROW** Added.\n## Elsewhere\n- **OLD-ROW** Moved.\n') });
    assert.equal(result.ok, false);
    assert.equal(result.problems.length, 2);
    assert.match(result.problems.join('\n'), /addition.*NEW-ROW.*line 2.*NEW-ROW/);
    assert.match(result.problems.join('\n'), /absence.*OLD-ROW.*archived line 27.*Original work/);
    const outsideOnly = checkPurge({ archiveBytes: makeRecord(), section: SECTION,
      queueBytes: Buffer.from('## Work\nTrim.\n## Elsewhere\n- **NEW-ROW** Elsewhere.\n- **No key**\n') });
    assert.equal(outsideOnly.ok, true);
  });

  // spec:queue-purge/S6
  it('asks the removal predicate about recorded classes, including unknown, using the last matching block', async () => {
    const { checkPurge } = await load();
    for (const [klass, allowed] of [['live', false], ['terminal', true], ['record', true],
      ['parked', false], ['ambiguous', false], ['future-class', false]]) {
      const archived = makeRecord({ entries: [[81, klass, 'GONE-ROW', 'Archived title']] });
      const archiveBytes = Buffer.concat([
        makeRecord({ entries: [[3, 'live', 'EARLIER-ROW', 'Earlier']] }), archived,
        makeRecord({ section: '## Other', body: '## Other\n', entries: [[9, 'live', 'OTHER-ROW', 'Other']] }),
      ]);
      const result = checkPurge({ archiveBytes, section: '## Work ##', queueBytes: Buffer.from('## Work\nTrim.\n') });
      assert.equal(result.ok, allowed, klass);
      assert.doesNotMatch(result.problems.join('\n'), /EARLIER-ROW|OTHER-ROW/);
      if (!allowed) assert.match(result.problems.join('\n'), /absence.*GONE-ROW.*archived line 81.*Archived title/);
    }
  });

  // spec:queue-purge/S12
  it('accepts trim-only with unchanged keys, without judging row caps or names', async () => {
    const { checkPurge } = await load();
    const body = '## Work\n- **A-ROW** Very long body.\n  More explanation.\n';
    const archiveBytes = makeRecord({ body, entries: [[2, 'live', 'A-ROW', 'A-ROW']] });
    const queueBytes = Buffer.from('## Work\n- **A-ROW** Short.\n');
    assert.deepEqual(checkPurge({ archiveBytes, queueBytes, section: SECTION }), { ok: true, problems: [], notes: [] });
    const stillLong = Buffer.from('## Work\n- **A-ROW** Short.\n' + '  Kept.\n'.repeat(250));
    assert.equal(checkPurge({ archiveBytes, queueBytes: stillLong, section: SECTION }).ok, true);
  });

  // spec:queue-purge/S15
  it('refuses an unchanged section and collects all applicable causes beside it', async () => {
    const { checkPurge } = await load();
    const body = '## Work\n- **No key** Body.\n- **NEW-ROW** Added.\n';
    const archiveBytes = makeRecord({ body, entries: [[8, 'live', 'OLD-ROW', 'Old title'],
      [9, 'live', '<keyless>', 'Unkeyed archived title']] });
    const result = checkPurge({ archiveBytes, queueBytes: Buffer.from(body), section: SECTION });
    assert.equal(result.ok, false);
    assert.equal(result.problems.length, 5);
    const problems = result.problems.join('\n');
    assert.match(problems, /key defect.*line 2.*No key/);
    assert.match(problems, /not moved.*## Work/);
    assert.match(problems, /addition.*NEW-ROW/);
    assert.match(problems, /absence.*OLD-ROW/);
    assert.match(problems, /keyless entry.*archived line 9.*Unkeyed archived title/);
    const empty = '## Work\n';
    const unchanged = checkPurge({ archiveBytes: makeRecord({ body: empty }), queueBytes: Buffer.from(empty), section: SECTION });
    assert.equal(unchanged.problems.length, 1);
    assert.match(unchanged.problems[0], /not moved/);
  });
});
