import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EPIC_SECTIONS, parseEpic } from '../epic-shape.mjs';
import { auditQueue } from '../queue-audit.mjs';

const load = () => import('../epic-shape-ledger.mjs');
const ROOT = '/project/docs/ai/epics';
const ID = 'BOUNDARY-WORK';
const PATH = `${ROOT}/${ID}.md`;
const OTHER = 'OTHER-WORK';
const OTHER_PATH = `${ROOT}/${OTHER}.md`;
const DATE = '2026-09-10';
const LANDED = `landed ${DATE}`;
const CLAIM = 'tools/owned.mjs';
const EMPTY_QUEUE = '# Queue\n\n## Now\n\n## Later\n';
const makeText = (stories = [{}], { id = ID, state = 'open', result = DATE, intent = 'Keep boundaries explicit.' } = {}) => {
  const ledger = stories.map((story, index) => {
    const fields = { owns: 'none', shared: 'none', dependsOn: 'none', state: 'planned', ...story };
    return `- S${index + 1} | Boundary ${index + 1} | depends-on: ${fields.dependsOn} | owns: ${fields.owns} | shared: ${fields.shared} | state: ${fields.state}`;
  }).join('\n');
  const bodies = [intent, 'Keep parallel work separate.', 'No implementation choices.',
    result === null ? 'The work is observable.' : `Result line: ${result}`, 'docs/ai/specs/kit/example.md', ledger, `Row ${id} in Now`];
  return ['---', 'type: epic', `lastUpdated: ${DATE}`, 'scope: permanent', 'staleAfter: 90d', 'owner: none',
    'maxLines: 60', `state: ${state}`, '---', '# Epic: Boundary work',
    ...EPIC_SECTIONS.flatMap((heading, index) => [heading, bodies[index], ''])].join('\n');
};
const readEpic = (stories, options = {}) => parseEpic(makeText(stories, options), options.path ?? PATH);
const makeQueue = (body) => `${EMPTY_QUEUE}${body}\n`;
const makeClose = (overrides = {}) => ({ epic: makeText([{ state: LANDED }]), path: PATH, queue: EMPTY_QUEUE, entries: [], ...overrides });
const loadRules = async () => {
  const rules = await load().catch((error) => {
    assert.equal(error.code, 'ERR_MODULE_NOT_FOUND');
    return {};
  });
  assert.equal(typeof rules.checkClaims, 'function', 'the ledger module must export checkClaims');
  return rules;
};
const assertAccepted = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.ok(result.findings.every((finding) => finding.severity === 'info'));
};
const assertRefused = (result, code, names = []) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  const findings = result.findings.filter((finding) => finding.code === code && finding.severity === 'error');
  assert.ok(findings.length > 0, `${code}: ${JSON.stringify(result.findings)}`);
  for (const name of names) assert.ok(findings.some((finding) => finding.message.includes(name)), `${name}: ${JSON.stringify(findings)}`);
  for (const finding of result.findings) {
    assert.ok(Number.isInteger(finding.line) && finding.line > 0);
    assert.ok(finding.message.length > 0);
  }
};

describe('epic ledger', () => {
  it('spec:epic-shape/S5 refuses unknown dependencies and names every story on a cycle', async () => {
    const { checkClaims } = await loadRules();
    for (const dependsOn of ['S2', 'S99']) {
      assertRefused(checkClaims([readEpic([{ dependsOn }])]), 'dependency-id', [PATH, 'S1', dependsOn]);
    }
    const cycles = [
      { rows: [{ dependsOn: 'S1' }], ids: ['S1'] },
      { rows: [{ dependsOn: 'S2' }, { dependsOn: 'S1' }], ids: ['S1', 'S2'] },
      { rows: [{ dependsOn: 'S2' }, { dependsOn: 'S3' }, { dependsOn: 'S1' }], ids: ['S1', 'S2', 'S3'] },
      { rows: [{ dependsOn: 'S2' }, { dependsOn: 'S3' }, { dependsOn: 'S2' }], ids: ['S2', 'S3'] },
    ];
    for (const { rows, ids } of cycles) assertRefused(checkClaims([readEpic(rows)]), 'dependency-cycle', [PATH, ...ids]);
    assertAccepted(checkClaims([readEpic([{}, { dependsOn: 'S1' }, { dependsOn: 'S1, S2' }])]));
    assertRefused(checkClaims([readEpic([{ dependsOn: 'S2' }]), readEpic([{}, {}], { id: OTHER, path: OTHER_PATH })]), 'dependency-id');
  });

  it('spec:epic-shape/S6 checks distinct owners and sweeps only readable epic neighbours with named counts', async () => {
    const { checkClaims, sweepSiblings } = await loadRules();
    const own = readEpic([{ owns: CLAIM }]);
    for (const owns of [CLAIM, 'tools/']) {
      assertRefused(checkClaims([readEpic([{ owns: CLAIM }, { owns, dependsOn: 'S1' }])]), 'owns-overlap', ['S1', 'S2', CLAIM]);
      for (const state of ['planned', 'in-flight']) {
        const other = readEpic([{ owns, state }], { id: OTHER, path: OTHER_PATH });
        assertRefused(checkClaims([own, other]), 'owns-overlap', [PATH, OTHER_PATH, 'S1', CLAIM]);
      }
      for (const other of [readEpic([{ owns, state: LANDED }], { id: OTHER, path: OTHER_PATH }),
        readEpic([{ owns }], { id: OTHER, path: OTHER_PATH, state: 'landed' })]) {
        assertAccepted(checkClaims([own, other]));
      }
    }
    assertAccepted(checkClaims([own, own]));
    const unreadable = makeText([{ owns: CLAIM }], { id: OTHER }).replace('- S1 |', '* S1 |');
    const refused = sweepSiblings([{ name: `${OTHER}.md`, text: unreadable }], ROOT);
    assertRefused(refused, 'ledger-line', [OTHER_PATH]);
    assert.deepEqual(refused.epics, []);
    for (const text of [unreadable.replace('state: open', 'state: landed'),
      makeText([{ owns: CLAIM, dependsOn: 'S99' }], { id: OTHER, state: 'landed' }),
      makeText([{ owns: CLAIM, dependsOn: 'S99' }], { id: OTHER, state: 'landed', intent: '```unclosed' })]) {
      const result = sweepSiblings([{ name: `${OTHER}.md`, text }], ROOT);
      assertAccepted(result);
      assert.deepEqual(result.counts, { epicsRead: 1, skipped: 0 });
      assert.deepEqual(result.epics, []);
      assert.deepEqual(result.findings, []);
      assertAccepted(checkClaims([own, ...result.epics]));
    }
    const entries = [
      { name: `${OTHER}.md`, text: makeText([{ owns: 'other.mjs' }], { id: OTHER }) },
      { name: 'LANDED.md', text: makeText([{}], { id: 'LANDED', state: 'landed' }) },
      { name: 'notes.md', text: '---\ntype: reference\nowner: somebody\n---\n```unclosed' },
      { name: 'plain.md', text: '# Notes\n```unclosed' },
      { name: 'nested.md', outcome: 'non-regular', kind: 'directory' },
      { name: 'readme.txt', text: 'Not an epic.' },
    ];
    const before = structuredClone(entries);
    const sweep = sweepSiblings(entries, ROOT);
    assertAccepted(sweep);
    assert.equal(sweep.root, ROOT);
    assert.deepEqual(sweep.counts, { epicsRead: 2, skipped: 4 });
    assert.deepEqual(sweep.epics.map((epic) => epic.path), [OTHER_PATH]);
    assert.deepEqual(entries, before);
    for (const state of ['', 'done', 'OPEN']) {
      const bad = makeText([{}], { id: OTHER, state });
      assertRefused(sweepSiblings([{ name: `${OTHER}.md`, text: bad }], ROOT), 'sibling-state', [OTHER_PATH]);
    }
    const missing = makeText([{}], { id: OTHER }).replace('state: open\n', '');
    assertRefused(sweepSiblings([{ name: `${OTHER}.md`, text: missing }], ROOT), 'sibling-state', [OTHER_PATH]);
    for (const outcome of [
      { outcome: 'non-regular', kind: 'symlink' }, { outcome: 'non-regular', kind: 'FIFO' },
      { outcome: 'unreadable', reason: 'EACCES' }, { outcome: 'unreadable', reason: 'ENOENT' },
    ]) assertRefused(sweepSiblings([{ name: `${OTHER}.md`, ...outcome }], ROOT), 'sibling-read', [OTHER_PATH]);
    for (const [input, code, name] of [
      [null, 'sibling-read', ROOT],
      ...['---\ntype: epic\nstate: open\n', '---\ntype: reference\nbroken\n---\n',
        '---\ntype: epic\ntype: epic\nstate: open\n---\n', '---\ntype: epic\n# Ambiguous heading\n---\n']
        .map((text) => [[{ name: `${OTHER}.md`, text }], 'sibling-header', OTHER_PATH]),
    ]) {
      const result = sweepSiblings(input, ROOT);
      assertRefused(result, code, [name]);
      assert.equal(result.root, ROOT);
      assert.equal(result.counts.epicsRead, 0);
    }
    const inputs = [own, readEpic([{ owns: CLAIM }], { id: OTHER, path: OTHER_PATH })];
    const original = structuredClone(inputs);
    checkClaims(inputs);
    assert.deepEqual(inputs, original);
  });

  it('spec:epic-shape/S7 cuts path overlap at slash boundaries in either direction', async () => {
    const { checkClaims } = await loadRules();
    for (const pair of [['tools/queue.mjs', 'tools/queue-audit.mjs'], ['tools/queue/', 'tools/queue-audit/a.mjs']]) {
      for (const paths of [pair, [...pair].reverse()]) {
        assertAccepted(checkClaims([readEpic(paths.map((owns) => ({ owns })))]));
      }
    }
    for (const pair of [['tools/queue/', 'tools/queue/a.mjs'], ['tools/queue', 'tools/queue/a.mjs']]) {
      for (const paths of [pair, [...pair].reverse()]) {
        assertRefused(checkClaims([readEpic(paths.map((owns) => ({ owns })))]), 'owns-overlap');
      }
    }
  });

  it('spec:epic-shape/S8 includes co-located tests in source claims and never pairs a story with itself', async () => {
    const { checkClaims } = await loadRules();
    for (const testPath of ['tools/foo.test.mjs', 'tools/foo.test/', 'tools/foo.test/nested/case.mjs']) {
      for (const paths of [['tools/foo.mjs', testPath], [testPath, 'tools/foo.mjs']]) {
        assertRefused(checkClaims([readEpic(paths.map((owns) => ({ owns })))]), 'owns-overlap', paths);
        assertRefused(checkClaims([readEpic([{ owns: paths[0] }]), readEpic([{ owns: paths[1] }], { id: OTHER, path: OTHER_PATH })]), 'owns-overlap');
      }
      assertRefused(checkClaims([readEpic([{ shared: 'tools/foo.mjs' }, { owns: testPath }])]), 'shared-order');
    }
    for (const owns of ['tools/foo.mjs, tools/', 'tools/foo.mjs, tools/foo.test.mjs, tools/foo.test/']) {
      assertAccepted(checkClaims([readEpic([{ owns, shared: 'tools/' }])]));
    }
    assertAccepted(checkClaims([readEpic([{ owns: 'tools/foo.mjs' }, { owns: 'elsewhere/foo.test.mjs' }])]));
  });

  it('spec:epic-shape/S9 binds every forbidden claim form while accepting directory prefixes and none', async () => {
    const { checkClaims } = await loadRules();
    const invalid = ['a*b', 'a?b', 'a[b]', 'a{b}', 'a b', 'a\tb', 'a(b)', 'a`b', 'a|b', 'a:b', 'a#b',
      '/a', 'a//b', 'a//', '.', '..', './a', '../a', 'a/./b', 'a/../b'];
    for (const claim of invalid) {
      for (const field of ['owns', 'shared']) {
        assertRefused(checkClaims([readEpic([{ [field]: claim }])]), 'row-grammar', ['S1']);
      }
    }
    for (const claim of ['none', 'tools/', 'future/does-not-exist.mjs']) {
      for (const field of ['owns', 'shared']) assertAccepted(checkClaims([readEpic([{ [field]: claim }])]));
    }
  });

  it('spec:epic-shape/S10 requires transitive order for shared pairs only within an epic', async () => {
    const { checkClaims } = await loadRules();
    for (const [left, right] of [['owns', 'shared'], ['shared', 'owns'], ['shared', 'shared']]) {
      assertRefused(checkClaims([readEpic([{ [left]: CLAIM }, { [right]: CLAIM }])]), 'shared-order', ['S1', 'S2']);
      for (const middleState of ['planned', LANDED]) {
        const forward = [{ [left]: CLAIM }, { dependsOn: 'S1', state: middleState }, { [right]: CLAIM, dependsOn: 'S2' }];
        const backward = [{ [left]: CLAIM, dependsOn: 'S2' }, { dependsOn: 'S3', state: middleState }, { [right]: CLAIM }];
        for (const rows of [forward, backward]) assertAccepted(checkClaims([readEpic(rows)]));
      }
      assertRefused(checkClaims([readEpic([{}, { [left]: CLAIM, dependsOn: 'S1' }, { [right]: CLAIM, dependsOn: 'S1' }])]), 'shared-order');
      const cross = checkClaims([readEpic([{ [left]: CLAIM }]), readEpic([{ [right]: CLAIM }], { id: OTHER, path: OTHER_PATH })]);
      assertAccepted(cross);
      const collision = cross.findings.find((finding) => finding.code === 'shared-cross-epic');
      assert.equal(collision?.severity, 'info');
      for (const name of [PATH, OTHER_PATH, 'S1', CLAIM]) assert.ok(collision.message.includes(name));
      assertAccepted(checkClaims([readEpic([{ [left]: CLAIM }, { [right]: CLAIM, state: LANDED }])]));
    }
  });

  it('spec:epic-shape/S11 checks the store and full check before the four ordered close conditions', async () => {
    const { judgeClose } = await loadRules();
    const accepted = judgeClose(makeClose());
    assertAccepted(accepted);
    assert.equal(accepted.root, '/project');
    assert.equal(accepted.queuePath, '/project/docs/plans/queue.md');
    const text = makeClose().epic;
    assert.equal(Buffer.from(text).subarray(accepted.stateRange.start, accepted.stateRange.end).toString(), 'open');
    for (const state of ['planned', 'in-flight']) {
      assertRefused(judgeClose(makeClose({ epic: makeText([{ state }, { state: LANDED }]) })), 'close-stories', ['S1']);
    }
    assertRefused(judgeClose(makeClose({ epic: makeText([{ state: LANDED }], { result: null }) })), 'close-result');
    for (const result of ['yesterday', `${DATE} extra`, '2026-02-30']) {
      const refused = judgeClose(makeClose({ epic: makeText([{ state: LANDED }], { result }) }));
      assertRefused(refused, 'result-line');
      assert.equal(refused.stateRange, null);
    }
    assertRefused(judgeClose(makeClose({ epic: makeText([{ state: LANDED }], { state: 'landed' }) })), 'close-state');
    const byId = makeQueue(`- **Keep the boundary readable — id ${ID}** Body.`);
    assert.equal(auditQueue(byId).rows[0].id, ID);
    assertRefused(judgeClose(makeClose({ queue: byId })), 'close-queue', [ID]);
    for (const display of [`Work around (${ID}) today`, `Work around \`${ID}\` today`, `Work around\n  ${ID} today`]) {
      const queue = makeQueue(`- **${display}** Body.`);
      assert.equal(auditQueue(queue).rows[0].id, null);
      assertRefused(judgeClose(makeClose({ queue })), 'close-queue', [ID]);
    }
    assertRefused(judgeClose(makeClose({ queue: `# Queue\n## Frozen\n- **${ID} — DONE**\n## Now\n` })), 'close-queue');
    for (const body of [`- **Some other work** Wait for ${ID}.`, `- **Some other work**\n  Wait for ${ID}.`,
      `- **Some other work**\n  \`\`\`\n  ${ID}\n  \`\`\``,
      ...[`PREFIX-${ID}`, `${ID}-SUFFIX`, `X${ID}`, `${ID}2`, `${ID}_X`].map((title) => `- **${title}**`)]) {
      assertAccepted(judgeClose(makeClose({ queue: makeQueue(body) })));
    }
    const rendered = makeQueue(`- **_${ID}_**`);
    assert.equal(auditQueue(rendered).rows[0].title, ID);
    assertRefused(judgeClose(makeClose({ queue: rendered })), 'close-queue');
    for (const queue of [null, { outcome: 'absent' }, { outcome: 'unreadable', reason: 'EACCES' },
      '# Queue\n```never closed', '# Queue\n* Unread row', '# Queue\n- **Other**\n  ## Hidden heading']) {
      assertRefused(judgeClose(makeClose({ queue })), 'queue-read');
    }
    for (const path of [`/drafts/${ID}.md`, `/other/docs/ai/${ID}.md`, `/project/docs/ai/epics/nested/${ID}.md`]) {
      assertRefused(judgeClose(makeClose({ path })), 'close-path');
    }
    for (const [path, root, queuePath] of [[`docs/ai/epics/${ID}.md`, '.', 'docs/plans/queue.md'],
      [`/docs/ai/epics/${ID}.md`, '/', '/docs/plans/queue.md'], [`/elsewhere/docs/ai/epics/${ID}.md`, '/elsewhere', '/elsewhere/docs/plans/queue.md']]) {
      const result = judgeClose(makeClose({ path }));
      assertAccepted(result);
      assert.equal(result.root, root);
      assert.equal(result.queuePath, queuePath);
    }
    const badShape = judgeClose(makeClose({ epic: makeText([{ state: LANDED }], { intent: 'Use `code`.' }) }));
    assertRefused(badShape, 'altitude');
    assert.equal(badShape.stateRange, null);
    assertRefused(judgeClose(makeClose({ epic: makeText([{ state: LANDED, dependsOn: 'S2' }]) })), 'dependency-id');
    assertRefused(judgeClose(makeClose({ entries: [{ name: `${OTHER}.md`, outcome: 'unreadable', reason: 'EACCES' }] })), 'sibling-read');
    assertAccepted(judgeClose(makeClose({ entries: [{ name: `${ID}.md`, text }] })));
    const all = judgeClose(makeClose({ epic: makeText([{}], { state: 'landed', result: null }), queue: byId }));
    assert.deepEqual(all.findings.map((finding) => finding.code), ['close-stories', 'close-result', 'close-state', 'close-queue']);
    assert.equal(all.stateRange, null);
  });
});
