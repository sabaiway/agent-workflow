import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkEpic, EPIC_SECTIONS } from '../epic-shape.mjs';

const load = () => import('../epic-shape-brief.mjs');
const PATH = '/drafts/SYNTHETIC-BRIEF.md';
const ID = 'SYNTHETIC-BRIEF';
const GUARD = 'Judge intent, value, boundaries, ownership and story order. A finding that names a mechanism, a file line or an implementation choice is below this tier\'s altitude and is NOT counted.';
const QUESTIONS = [
  'Intent: Is the intended change clear?',
  'Value: Is the value worth the work?',
  'Boundaries: Are the non-goals and acceptance boundaries clear?',
  'Ownership: Does each story have distinct, declared ownership?',
  'Story order: Do the dependencies express the required order?',
].join('\n') + '\n';
const EPIC_TEXT = `---
type: epic
lastUpdated: 2026-09-10
scope: permanent
staleAfter: 90d
owner: none
maxLines: 60
state: open
---
# Epic: A different document title

## Intent
Make the boundary observable.

## Value
Preserve  the caf\u00e9's purpose.

## Non-goals
No implementation choices.

## Acceptance
The boundaries can be reviewed.

## Specs
docs/ai/specs/kit/example.md

## Stories ledger
- S1 | Establish the boundary | depends-on: none | owns: tools/example.mjs | shared: none | state: planned

## Queue
Row SYNTHETIC-BRIEF in A draft bucket
`;
const EXPECTED_BRIEF = `# Epic review: SYNTHETIC-BRIEF (open)

Judge intent, value, boundaries, ownership and story order. A finding that names a mechanism, a file line or an implementation choice is below this tier's altitude and is NOT counted.

## Intent
Make the boundary observable.

## Value
Preserve  the caf\u00e9's purpose.

## Non-goals
No implementation choices.

## Acceptance
The boundaries can be reviewed.

## Specs
docs/ai/specs/kit/example.md

## Stories ledger
- S1 | Establish the boundary | depends-on: none | owns: tools/example.mjs | shared: none | state: planned

## Queue
Row SYNTHETIC-BRIEF in A draft bucket

Intent: Is the intended change clear?
Value: Is the value worth the work?
Boundaries: Are the non-goals and acceptance boundaries clear?
Ownership: Does each story have distinct, declared ownership?
Story order: Do the dependencies express the required order?
`;
const REVIEW_LINES = [
  '# Findings',
  'Review preamble.',
  '',
  '- [P1] docs/ai/epics/EXAMPLE.md:14 — Intent lacks a clear outcome.',
  '  Its value remains unclear.',
  '',
  '* [P2] `dir/file:12` — Boundaries overlap.',
  '2. Ownership remains unspecified.',
  '- [P1] path/file:20 — Mechanism.',
  '  ```js',
  '  code',
  '  ```',
  '- [P2] path/file:30 — See second.ext:42.',
  'Closing line.',
];
const loadRules = async () => {
  const rules = await load().catch((error) => {
    assert.equal(error.code, 'ERR_MODULE_NOT_FOUND');
    return {};
  });
  assert.equal(typeof rules.renderBrief, 'function', 'the brief module must export renderBrief');
  return rules;
};

describe('epic brief and findings fold', () => {
  it('spec:epic-shape/S13 pins the synthetic brief, path id, guard, sections and five closing questions', async () => {
    const { renderBrief, BRIEF_GUARD } = await loadRules();
    assert.deepEqual(checkEpic(EPIC_TEXT, PATH).findings, []);
    assert.equal(BRIEF_GUARD, GUARD);
    const brief = renderBrief(EPIC_TEXT, PATH);
    assert.equal(brief, EXPECTED_BRIEF);
    assert.ok(brief.startsWith(`# Epic review: ${ID} (open)\n`));
    assert.ok(brief.endsWith(QUESTIONS));
    assert.deepEqual(brief.split('\n').filter((line) => line.startsWith('## ')), EPIC_SECTIONS);
    for (const [text, path, expected] of [
      [EPIC_TEXT, `docs/ai/epics/${ID}.md`, EXPECTED_BRIEF],
      [EPIC_TEXT.replace('state: open', 'state: landed'), PATH, EXPECTED_BRIEF.replace('(open)', '(landed)')],
      [EPIC_TEXT.replaceAll(ID, 'ANOTHER-ID'), '/elsewhere/ANOTHER-ID.md', EXPECTED_BRIEF.replaceAll(ID, 'ANOTHER-ID')],
    ]) assert.equal(renderBrief(text, path), expected);
    for (const text of [EPIC_TEXT.replaceAll('\n', '\r\n'), EPIC_TEXT.replace('Make the boundary observable.', 'Make the boundary observable.  '),
      EPIC_TEXT.trimEnd(), `${EPIC_TEXT}\n\n`]) {
      const rendered = renderBrief(text, PATH);
      assert.equal(typeof rendered, 'string');
      const sectionText = text.slice(text.indexOf('## Intent'));
      assert.ok(rendered.includes(sectionText), 'all section bytes must survive rendering');
      assert.ok(rendered.endsWith(QUESTIONS));
    }
    for (const text of [EPIC_TEXT.replace('maxLines: 60', 'maxLines: 61'), EPIC_TEXT.replace('## Value', '## Surprise'),
      EPIC_TEXT.replace('Make the boundary observable.', 'Use `code`.'), EPIC_TEXT.replace(`Row ${ID}`, 'Row OTHER')]) {
      const refused = renderBrief(text, PATH);
      assert.notEqual(typeof refused, 'string');
      assert.equal(refused.brief, null);
      assert.ok(refused.findings.length > 0);
    }
  });

  it('spec:epic-shape/S14 accounts for entries and outside lines and discards only below-altitude findings', async () => {
    const { readEntries, foldFindings } = await loadRules();
    const text = `${REVIEW_LINES.join('\n')}\n`;
    const parsed = readEntries(text);
    assert.deepEqual(parsed.entries.map((entry) => entry.line), [4, 7, 8, 9, 13]);
    assert.deepEqual(parsed.entries[0].lines, REVIEW_LINES.slice(3, 6));
    assert.deepEqual(parsed.entries[3].lines, REVIEW_LINES.slice(8, 12));
    assert.equal(parsed.entries[3].text, REVIEW_LINES.slice(8, 12).join('\n'));
    assert.deepEqual(parsed.outside, [
      { line: 1, text: '# Findings' }, { line: 2, text: 'Review preamble.' }, { line: 14, text: 'Closing line.' },
    ]);
    const folded = foldFindings(text);
    assert.equal(folded.ok, true);
    assert.deepEqual(folded.findings, []);
    assert.deepEqual(folded.counts, { kept: 3, discarded: 2, outside: 3 });
    assert.deepEqual(folded.kept.map((entry) => entry.line), [4, 7, 8]);
    assert.deepEqual(folded.discarded.map((entry) => entry.form), ['fence', 'citation']);
    assert.deepEqual(folded.discarded.map((entry) => entry.reasonLine), [10, 13]);
    for (const entry of folded.discarded) assert.ok(entry.reason.includes(entry.form));
    assert.deepEqual(folded.outside, parsed.outside);
    for (const entry of [...folded.kept, ...folded.discarded]) {
      assert.equal(entry.text, parsed.entries.find((candidate) => candidate.line === entry.line).text);
    }
    const kept = [
      '- [P1] docs/ai/epics/EXAMPLE.md:14 — Intent is unclear.',
      '- [P1] `docs/ai/epics/EXAMPLE.md:14` — Intent is unclear.',
      '* [P2] (something.ext:123) — The value is unclear.',
      '12. [P2] ``dir/file:123`` — The boundaries overlap.',
      '- [P2] ```dir/file:123``` — The boundaries overlap.',
      '- No citation is required for a concept finding.',
      '- Run npm install and call the parser with --check.',
      '- Intent needs clarity.\n  Citation: dir/file:123',
      '- A lone ` delimiter remains plain text.',
    ];
    for (const entry of kept) {
      const result = foldFindings(entry);
      assert.equal(result.ok, true);
      assert.deepEqual(result.counts, { kept: 1, discarded: 0, outside: 0 }, entry);
    }
    const discarded = [
      ['- dir/file:1 — Also other.ext:2.', 'citation'],
      ['- `dir/file:1` — Also `other.ext:2`.', 'backtick'],
      ['- dir/file:1 — Call `run()`.', 'backtick'],
      ['- `use dir/file:1` — Intent is unclear.', 'backtick'],
      ['- `dir/file:1 extra` — Intent is unclear.', 'backtick'],
      ['- ` dir/file:1 ` — Intent is unclear.', 'backtick'],
      ['- ``dir/file:1 extra`` — Intent is unclear.', 'backtick'],
      ['- `other`dir/file:1` — Keep the earlier span.', 'backtick'],
      ['- No citation.\n  ```\n  code\n  ```', 'fence'],
      ['- ```never closed', 'fence'],
      ['* ~~~never closed', 'fence'],
      ['3. ```never closed', 'fence'],
      ['- dir/file:1 — Boundary.\n  ~~~\n  code\n  ~~~', 'fence'],
      ['- dir/file:1 — Boundary.\n  ```never closed', 'fence'],
      ['- dir/file:1 — Boundary.\n  See other.ext:2.', 'citation'],
      ['- dir/file:1 — `A span\n  continues here`.', 'backtick'],
    ];
    for (const [entry, form] of discarded) {
      const result = foldFindings(entry);
      assert.equal(result.ok, true, 'discarding an entry does not refuse the fold');
      assert.deepEqual(result.counts, { kept: 0, discarded: 1, outside: 0 }, entry);
      assert.equal(result.discarded[0].form, form, entry);
      assert.ok(result.discarded[0].reason.length > 0);
    }
    for (const eol of ['\n', '\r\n']) {
      const input = ['  Outside before an entry.', '- A finding.', '', '\tAn indented continuation.', '* Another finding.',
        'A closing line.', '  Outside after the closing line.'].join(eol);
      const result = readEntries(input);
      assert.deepEqual(result.entries.map((entry) => entry.line), [2, 5]);
      assert.deepEqual(result.outside.map((line) => line.line), [1, 6, 7]);
      assert.equal(result.entries[0].text, ['- A finding.', '', '\tAn indented continuation.'].join(eol) + (eol === '\r\n' ? '\r' : ''));
      const outcome = foldFindings(input);
      assert.deepEqual(outcome.counts, { kept: 2, discarded: 0, outside: 3 });
    }
    for (const input of ['', '\n\n', '# Findings\nOnly outside text.\n']) {
      const result = foldFindings(input);
      assert.equal(result.ok, false);
      assert.equal(result.counts.kept, 0);
      assert.equal(result.counts.discarded, 0);
      assert.equal(result.counts.outside, readEntries(input).outside.length);
      assert.ok(result.findings.some((finding) => finding.code === 'empty-findings'));
    }
  });
});
