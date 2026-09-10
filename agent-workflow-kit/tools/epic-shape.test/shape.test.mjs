import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getLineCount } from '../plan-shape.mjs';

const load = () => import('../epic-shape.mjs');
const ID = 'EXAMPLE';
const PATH = `docs/ai/epics/${ID}.md`;
const DATE = '2026-09-10';
const LINE_CAP = 60;
const ROW_CAP = 200;
const SECTIONS = Object.freeze([
  '## Intent', '## Value', '## Non-goals', '## Acceptance', '## Specs', '## Stories ledger', '## Queue',
]);
const HEADER = Object.freeze({
  type: 'epic', lastUpdated: DATE, scope: 'permanent', staleAfter: '90d', owner: 'none', maxLines: LINE_CAP, state: 'open',
});
const makeRow = (overrides = {}) => {
  const row = { id: 'S1', name: 'Define the boundary', dependsOn: 'none', owns: 'tools/example.mjs', shared: 'none', state: 'planned', body: '', ...overrides };
  return `- ${row.id} | ${row.name} | depends-on: ${row.dependsOn} | owns: ${row.owns} | shared: ${row.shared} | state: ${row.state}${row.body}`;
};
const makeEpic = (overrides = {}) => {
  const input = {
    header: HEADER, title: '# Epic: Example', preamble: '',
    intent: 'Keep work at concept altitude.', value: 'Make boundaries visible.', nonGoals: 'No implementation choices.',
    acceptance: 'The boundary is checkable.', specs: 'docs/ai/specs/kit/example.md', ledger: makeRow(), queue: `Row ${ID} in Now`,
    ...overrides,
  };
  const bodies = [input.intent, input.value, input.nonGoals, input.acceptance, input.specs, input.ledger, input.queue];
  return ['---', ...Object.entries(input.header).map(([key, value]) => `${key}: ${value}`), '---', '', input.title,
    input.preamble, ...SECTIONS.flatMap((heading, index) => [heading, bodies[index], ''])].join('\n');
};
const loadRules = async () => {
  const rules = await load().catch((error) => {
    assert.equal(error.code, 'ERR_MODULE_NOT_FOUND');
    return {};
  });
  assert.equal(typeof rules.checkEpic, 'function', 'the shape module must export checkEpic');
  return rules;
};
const assertAccepted = (check, text, path = PATH) => assert.deepEqual(check(text, path).findings, [], text);
const assertRefused = (check, text, code, path = PATH) => {
  const { findings } = check(text, path);
  assert.ok(findings.some((finding) => finding.code === code), `${code}: ${JSON.stringify(findings)}\n${text}`);
  for (const finding of findings) {
    assert.ok(Number.isInteger(finding.line) && finding.line > 0);
    assert.equal(typeof finding.message, 'string');
    assert.ok(finding.message.length > 0);
  }
};

describe('epic shape', () => {
  it('spec:epic-shape/S1 refuses the three altitude forms and accepts plain mechanism prose', async () => {
    const { checkEpic, judgeAltitude } = await loadRules();
    const forms = [
      ['```js', 'fence'], ['~~~', 'fence'], ['    ```', 'fence'],
      ['Call `run()` now.', 'backtick'], ['Use ``a`b`` here.', 'backtick'], ['```inline```', 'backtick'],
      ['something.ext:123', 'citation'], ['dir/file:123', 'citation'],
      ['See (dir/file:123).', 'citation'], ['See `dir/file:123`.', 'backtick'],
    ];
    for (const [line, form] of forms) {
      assert.deepEqual(judgeAltitude(line), { below: true, form });
    }
    const bodies = ['```js\ncode\n```', '~~~\ncode\n~~~', 'Use `run()`.', 'something.ext:123', 'dir/file:123', '`dir/file:123`'];
    for (const body of bodies) {
      for (const section of ['intent', 'value', 'nonGoals', 'acceptance', 'specs']) {
        assertRefused(checkEpic, makeEpic({ [section]: body }), 'altitude');
      }
      assertRefused(checkEpic, makeEpic({ ledger: makeRow({ body: `\n  ${body.replaceAll('\n', '\n  ')}` }) }), 'altitude');
      assertRefused(checkEpic, makeEpic({ queue: `Row ${ID} in Now\n${body}` }), 'altitude');
    }
    for (const name of ['Use `run()`', 'Read dir/file:123']) {
      assertRefused(checkEpic, makeEpic({ ledger: makeRow({ name }) }), 'altitude');
    }
    assertRefused(checkEpic, makeEpic({ title: '# Epic: `Example`' }), 'altitude');
    for (const line of ['Run npm install and call the parser with --check.', 'tools/example.mjs', 'No language rule: caf\u00e9.',
      'A lone ` character.', 'A lone `` delimiter.', 'Mismatched ` and `` delimiters.', '12:30']) {
      assert.deepEqual(judgeAltitude(line), { below: false, form: null });
      assertAccepted(checkEpic, makeEpic({ intent: line }));
    }
    assertAccepted(checkEpic, makeEpic({ header: { ...HEADER, owner: '`maintainer`' } }));
    assertRefused(checkEpic, makeEpic({ intent: '```\nNever closed.' }), 'markdown');
  });

  it('spec:epic-shape/S2 requires exactly the ordered sections and no body before Intent', async () => {
    const { checkEpic, parseEpic, EPIC_SECTIONS } = await loadRules();
    assert.deepEqual(EPIC_SECTIONS, SECTIONS);
    assert.ok(Object.isFrozen(EPIC_SECTIONS));
    assertAccepted(checkEpic, makeEpic());
    assertAccepted(checkEpic, makeEpic(), '/drafts/EXAMPLE.md');
    for (const heading of ['# Extra', '## Extra', '### Nested', '#### Nested', '##### Nested', '###### Nested', '  ## Extra', '##\tExtra']) {
      assertRefused(checkEpic, makeEpic({ intent: `Intent.\n${heading}\nMore.` }), 'headings');
    }
    for (const heading of SECTIONS) {
      assertRefused(checkEpic, makeEpic().replace(`${heading}\n`, ''), 'headings');
      assertRefused(checkEpic, makeEpic({ intent: `Intent.\n${heading}\nMore.` }), 'headings');
    }
    for (const [index, heading] of SECTIONS.entries()) {
      const next = SECTIONS[index + 1];
      if (!next) continue;
      const swapped = makeEpic().replace(heading, '## Temporary').replace(next, heading).replace('## Temporary', next);
      assertRefused(checkEpic, swapped, 'headings');
    }
    for (const preamble of ['Unbounded prose.', '- Unbounded bullet.', '  Indented prose.']) {
      assertRefused(checkEpic, makeEpic({ preamble }), 'outside-section');
    }
    assertRefused(checkEpic, makeEpic().replace('# Epic: Example', 'Before title.\n# Epic: Example'), 'outside-section');
    for (const title of ['# Plan: Example', '# Epic: ', '## Epic: Example', 'Example']) {
      assertRefused(checkEpic, makeEpic({ title }), 'title');
    }
    const epic = parseEpic(makeEpic(), PATH);
    assert.deepEqual(epic.findings, []);
    assert.equal(epic.id, ID);
    assert.equal(epic.path, PATH);
    assert.equal(epic.title, 'Example');
    assert.deepEqual(epic.sections.map((section) => section.heading), SECTIONS);
    assert.equal(epic.sections[0].text, '## Intent\nKeep work at concept altitude.\n\n');
    assert.deepEqual(epic.rows.map((row) => row.id), ['S1']);
  });

  it('spec:epic-shape/S3 freezes header keys and cap and judges Queue and result lines', async () => {
    const { checkEpic, parseEpic } = await loadRules();
    for (const maxLines of [59, 61, 100, 'sixty', '060']) {
      assertRefused(checkEpic, makeEpic({ header: { ...HEADER, maxLines } }), 'max-lines');
    }
    for (const state of ['done', 'planned', '', 'OPEN', `landed ${DATE}`]) {
      assertRefused(checkEpic, makeEpic({ header: { ...HEADER, state } }), 'header-state');
    }
    for (const state of ['open', 'landed']) assertAccepted(checkEpic, makeEpic({ header: { ...HEADER, state } }));
    for (const absent of Object.keys(HEADER)) {
      const header = Object.fromEntries(Object.entries(HEADER).filter(([key]) => key !== absent));
      assertRefused(checkEpic, makeEpic({ header }), 'frontmatter');
    }
    assertRefused(checkEpic, makeEpic({ header: { ...HEADER, surprise: 'unknown' } }), 'frontmatter');
    assertRefused(checkEpic, makeEpic().replace('state: open', 'state: open\nstate: landed'), 'frontmatter');
    assertRefused(checkEpic, makeEpic().replace('type: epic', 'type: spec'), 'frontmatter');
    assertRefused(checkEpic, makeEpic().replace('owner: none', 'broken header'), 'frontmatter');
    assertRefused(checkEpic, makeEpic().replace(/^---\n[\s\S]*?---\n/, ''), 'frontmatter');
    const capped = makeEpic() + '\n'.repeat(LINE_CAP - getLineCount(makeEpic()));
    assert.equal(getLineCount(capped), LINE_CAP);
    assertAccepted(checkEpic, capped);
    assertRefused(checkEpic, `${capped}\n`, 'line-cap');
    for (const queue of ['', 'Row OTHER in Now', `Row ${ID}`, `Row ${ID} in`, `Row ${ID} in `,
      `- Row ${ID} in Now`, `Row ${ID} in Now\nAnother line.`, `Row ${ID} in Now\nRow ${ID} in Later`]) {
      assertRefused(checkEpic, makeEpic({ queue }), 'queue');
    }
    assertAccepted(checkEpic, makeEpic({ queue: `\nRow ${ID} in A bucket nobody resolves\n` }));
    for (const acceptance of [`Result line: ${DATE}\nResult line: ${DATE}`, 'Result line: yesterday',
      `Result line: ${DATE} deadbeef`, 'Result line: 2026-02-30', 'Result line: 2026-9-10', 'Result line:']) {
      assertRefused(checkEpic, makeEpic({ acceptance }), 'result-line');
    }
    assertAccepted(checkEpic, makeEpic({ acceptance: `  Result line: ${DATE}  ` }));
    assertAccepted(checkEpic, makeEpic({ acceptance: 'The prose mentions Result line: someday.' }));
    for (const eol of ['\n', '\r\n']) {
      const text = makeEpic({ header: { ...HEADER, owner: 'caf\u00e9' }, acceptance: `Result line: ${DATE}` })
        .replace('state: open', 'state:  open  ').replaceAll('\n', eol);
      assertAccepted(checkEpic, text);
      const epic = parseEpic(text, PATH);
      assert.deepEqual(epic.fields, { ...HEADER, owner: 'caf\u00e9', maxLines: String(LINE_CAP) });
      assert.equal(epic.state, 'open');
      assert.equal(epic.result.date, DATE);
      assert.equal(epic.queue.id, ID);
      assert.equal(epic.queue.bucket, 'Now');
      const bytes = Buffer.from(text);
      assert.equal(bytes.subarray(epic.stateRange.start, epic.stateRange.end).toString(), 'open');
      const changed = Buffer.concat([bytes.subarray(0, epic.stateRange.start), Buffer.from('landed'), bytes.subarray(epic.stateRange.end)]);
      assert.equal(changed.toString(), text.replace('state:  open  ', 'state:  landed  '));
    }
  });

  it('spec:epic-shape/S4 binds row grammar, continuation, byte cap, contiguous ids and plan refusal', async () => {
    const { checkEpic, parseStoryRow } = await loadRules();
    const continued = makeRow({ body: '\n  A continuation explains the boundary.\n\n  It remains prose.' });
    assertAccepted(checkEpic, makeEpic({ ledger: continued }));
    const row = parseStoryRow(continued.split('\n'));
    assert.equal(row.valid, true);
    assert.equal(row.id, 'S1');
    assert.deepEqual(row.dependsOn, []);
    assert.deepEqual(row.owns, ['tools/example.mjs']);
    assert.deepEqual(row.shared, []);
    assert.equal(row.state, 'planned');
    assert.match(row.body, /It remains prose/);
    const ordered = [makeRow(), makeRow({ id: 'S2', dependsOn: 'S1', state: 'in-flight' }),
      makeRow({ id: 'S3', dependsOn: 'S1, S2', state: `landed ${DATE}` })].join('\n');
    assertAccepted(checkEpic, makeEpic({ ledger: ordered }));
    assert.deepEqual(parseStoryRow(makeRow({ dependsOn: 'S1, S2' }).split('\n')).dependsOn, ['S1', 'S2']);
    assert.deepEqual(parseStoryRow(makeRow({ shared: 'tools/a.mjs, docs/b.md' }).split('\n')).shared, ['tools/a.mjs', 'docs/b.md']);
    const landed = parseStoryRow(makeRow({ state: `landed ${DATE}` }).split('\n'));
    assert.equal(landed.state, 'landed');
    assert.equal(landed.date, DATE);
    for (const ids of [['S2'], ['S1', 'S3'], ['S1', 'S1'], ['S2', 'S1'], ['S01']]) {
      assertRefused(checkEpic, makeEpic({ ledger: ids.map((id) => makeRow({ id })).join('\n') }), 'story-ids');
    }
    assertRefused(checkEpic, makeEpic({ ledger: '' }), 'empty-ledger');
    for (const ledger of [makeRow().slice(2), `  ${makeRow()}`, makeRow().replace('- ', '* '), `${makeRow()}\nUnattached prose.`]) {
      assertRefused(checkEpic, makeEpic({ ledger }), 'ledger-line');
    }
    const malformed = [
      makeRow({ name: '' }), makeRow({ id: 'S0' }), makeRow({ state: 'done' }), makeRow({ state: 'landed yesterday' }),
      makeRow({ dependsOn: 'OTHER/S1' }), makeRow({ dependsOn: 'S1 S2' }), makeRow({ dependsOn: '' }),
      makeRow().replace('depends-on:', 'depends:'), makeRow().replace(' | owns: tools/example.mjs', ''),
      `${makeRow()} | extra`, makeRow().replace('owns: tools/example.mjs | shared: none', 'shared: none | owns: tools/example.mjs'),
    ];
    for (const ledger of malformed) assertRefused(checkEpic, makeEpic({ ledger }), 'row-grammar');
    const invalidClaims = ['a*b', 'a?b', 'a[b]', 'a{b}', 'a b', 'a\tb', 'a(b)', 'a`b', 'a|b', 'a:b', 'a#b', '/a',
      'a//b', './a', 'a/./b', '../a', 'a/../b', 'a//', '.', '..', '', 'a,', 'none, a'];
    for (const claim of invalidClaims) {
      for (const field of ['owns', 'shared']) {
        assertRefused(checkEpic, makeEpic({ ledger: makeRow({ [field]: claim }) }), 'row-grammar');
      }
    }
    for (const claim of ['none', 'tools/', 'tools/a.mjs, docs/b.md', 'tools/caf\u00e9.mjs']) {
      assertAccepted(checkEpic, makeEpic({ ledger: makeRow({ owns: claim, shared: claim }) }));
    }
    const outside = ['S1', '', 'depends-on: none', 'state: planned'].join(' | ');
    const room = ROW_CAP - Buffer.byteLength(outside);
    const atCap = makeRow({ name: 'x'.repeat(room), owns: `tools/${'a'.repeat(ROW_CAP)}`, shared: `docs/${'b'.repeat(ROW_CAP)}/` });
    assert.equal(parseStoryRow([atCap]).countedBytes, ROW_CAP);
    assertAccepted(checkEpic, makeEpic({ ledger: atCap }));
    for (const ledger of [atCap.replace(' | depends-on:', 'x | depends-on:'), `${atCap}\n  More.`, makeRow({ name: '\u00e9'.repeat(room) })]) {
      assertRefused(checkEpic, makeEpic({ ledger }), 'row-bytes');
    }
    const forbidden = 'docs/plans/temporary.md';
    const placements = [
      { header: { ...HEADER, owner: forbidden } }, { title: `# Epic: ${forbidden}` }, { preamble: forbidden },
      ...['intent', 'value', 'nonGoals', 'acceptance', 'specs'].map((section) => ({ [section]: forbidden })),
      { queue: `Row ${ID} in ${forbidden}` }, { ledger: makeRow({ body: `\n  ${forbidden}` }) },
      ...['name', 'owns', 'shared'].map((field) => ({ ledger: makeRow({ [field]: forbidden }) })),
    ];
    for (const placement of placements) assertRefused(checkEpic, makeEpic(placement), 'plan-path');
    for (const name of ['queue-backup', 'queue.md.backup', 'nested/story']) {
      assertRefused(checkEpic, makeEpic({ intent: `docs/plans/${name}.md` }), 'plan-path');
    }
    assertAccepted(checkEpic, makeEpic({ specs: 'docs/plans/queue.md', ledger: makeRow({ owns: 'docs/plans/queue.md' }) }));
  });
});
