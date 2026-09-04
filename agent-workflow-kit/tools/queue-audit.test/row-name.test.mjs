import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../queue-audit.mjs');
const rowOf = (title) => `- **${title}** Body.`;

describe('queue-audit — row names', () => {
  // spec:queue-row-name/S1
  it('cuts the display title at the first bounded id token', async () => {
    const { auditQueue, titleOf } = await load();
    const fixtures = [
      ['A row is unreadable — ROW-IS-UNREADABLE', 'A row is unreadable', 'ROW-IS-UNREADABLE'],
      ['A row is unreadable — id ROW-IS-UNREADABLE', 'A row is unreadable', 'ROW-IS-UNREADABLE'],
      ['A row — its second clause — is unreadable', 'A row — its second clause — is unreadable', null],
      ['ROW-IS-UNREADABLE', '', 'ROW-IS-UNREADABLE'],
      ['[ ] ROW-A: the claim (2026-09-04)', '[ ]', 'ROW-A'],
    ];
    for (const [title, name, id] of fixtures) {
      const direct = titleOf([rowOf(title)]);
      const [row] = auditQueue(rowOf(title)).rows;
      assert.deepEqual([direct.text, direct.name, direct.id], [title, name, id]);
      assert.deepEqual([row.title, row.name, row.id], [title, name, id]);
    }
  });

  // spec:queue-row-name/S2
  it('applies every independent sentence clause and reports each failing file line', async () => {
    const { checkQueue } = await load();
    const text = [
      rowOf('ROW-IS-UNREADABLE'),
      rowOf('A SHOUTED SLUG'),
      rowOf('ROW IS UNREADABLE — ROW-IS-UNREADABLE'),
      rowOf('row is unreadable — ROW-IS-UNREADABLE'),
      rowOf('A plain sentence lives here — ROW-PLAIN'),
    ].join('\n');
    const result = checkQueue(text, { label: 'queue.md' });
    const { rows } = (await load()).auditQueue(text);
    assert.deepEqual(rows.map((row) => row.nameFindings.map(({ cause }) => cause)), [
      ['absent'], ['shouted'], ['shouted', 'restates-the-id'], ['restates-the-id'], [],
    ]);
    for (const line of [1, 2, 3, 4]) assert.match(result.notes.join('\n'), new RegExp(`queue\\.md:${line}:`));
  });

  // An id is a run the row PRESENTS as one. Both halves were walked around at once before this
  // arm: a shouted compound adjective mid-sentence was cut as an id, and a real id carrying an
  // all-digit part or a `---` matched NOTHING, so the whole title came back as the "name".
  it('reads the ids the corpus writes, and never a shouted compound inside a sentence', async () => {
    const { nameOf } = await load();
    const ids = [
      ['UPGRADE-RUN-FEEDBACK-2026-08-18 — a consumer upgrade run', 'UPGRADE-RUN-FEEDBACK-2026-08-18'],
      ['FLOW-CHECK-64-HAS-NO-VALVE-WHEN-IT-MOVED (new, 2026-08-11)', 'FLOW-CHECK-64-HAS-NO-VALVE-WHEN-IT-MOVED'],
      ['AMEND-REACHES-FOR---NO-VERIFY — a red-line flag taken by reflex', 'AMEND-REACHES-FOR---NO-VERIFY'],
      ['TASK-123 — queued 2026-09-04', 'TASK-123'],
    ];
    for (const [title, id] of ids) {
      const row = nameOf(title);
      assert.deepEqual([row.name, row.id], ['', id], `${id} is the id, and the row has no name`);
    }
    // A two-part run whose second part is a bare number is a CROSS-REFERENCE, not an id: this
    // corpus writes `AD-<n>` constantly, and reading it as an id costs three named rows their names.
    const cited = nameOf('AD-131 residuals — the decline path edges');
    assert.deepEqual([cited.name, cited.id], ['AD-131 residuals — the decline path edges', null]);
    // A shouted compound INSIDE a sentence is an adjective. Its row puts the real id outside the
    // bold span, and the contract names that span entire.
    const adjective = nameOf('A stale placed gate hook is refreshed by one apply command — never a HAND-APPLY rm the host classifier can deny');
    assert.equal(adjective.id, null);
    assert.match(adjective.name, /classifier can deny$/u);
  });

  // spec:queue-row-name/S3
  it('takes the name from display text even when the whole title is inline code', async () => {
    const { auditQueue, titleOf } = await load();
    const source = '- **`A quoted sentence lives here — ROW-CODE`** Body.';
    const title = titleOf([source]);
    const [row] = auditQueue(source).rows;
    assert.equal(title.judged, '');
    assert.deepEqual([title.name, row.name, row.id], ['A quoted sentence lives here', 'A quoted sentence lives here', 'ROW-CODE']);
  });

  // spec:queue-row-name/S4
  it('judges parked and ambiguous work, but never terminal rows', async () => {
    const { auditQueue } = await load();
    const rows = auditQueue([
      rowOf('ROW-A — PARKED 2026-09-04 until later.'),
      rowOf('ROW-B — PARKED 2026-09-04 — queued 2026-09-04.'),
      rowOf('ROW-C — DONE 2026-09-04.'),
    ].join('\n')).rows;
    assert.deepEqual(rows.map(({ klass }) => klass), ['parked', 'ambiguous', 'terminal']);
    assert.deepEqual(rows.map((row) => row.nameFindings.map(({ cause }) => cause)), [['absent'], ['absent'], []]);
  });

  // spec:queue-row-name/S5
  it('routes the same findings from notes to problems only when names are required', async () => {
    const { checkQueue } = await load();
    const nameless = rowOf('ROW-A');
    const advisory = checkQueue(nameless, { label: 'queue.md' });
    const required = checkQueue(nameless, { label: 'queue.md', requireNames: true });
    assert.equal(advisory.ok, true);
    assert.equal(required.ok, false);
    assert.equal(advisory.notes[0], required.problems[0]);
    assert.match(advisory.notes[0], /queue\.md:1:.*"".*absent/u);

    const otherRefusals = [rowOf('ROW-T — DONE 2026-09-04.'), rowOf('A plain sentence stays live — ROW-L'), '  detail'].join('\n');
    const options = { label: 'queue.md', maxRowLines: 1 };
    assert.deepEqual(checkQueue(otherRefusals, options), checkQueue(otherRefusals, { ...options, requireNames: true }));
  });

  // The two shape clauses read WORDS, not whitespace tokens, and they ask the words that carry the
  // claim. A dated parenthetical used to supply the one lower-case letter a whole shouted title
  // needed; punctuation used to supply two of the three words the bar asks for.
  it('judges the words that carry the claim, never a byte anywhere in the name', async () => {
    const { nameFindings } = await load();
    const causes = (name, id = null) => nameFindings(name, id).map((finding) => finding.cause);
    assert.deepEqual(causes('THE STEP PROTOCOL CONVERGES BEFORE THE GATE (new, 2026-08-17 — hit live)'), ['shouted']);
    assert.deepEqual(causes('row-is-unreadable'), ['too-few-words'], 'a hyphen-joined run is ONE word');
    assert.deepEqual(causes('fix---the---bug'), ['too-few-words'], 'so is a run of hyphens');
    assert.deepEqual(causes('foo — bar'), ['too-few-words']);
    assert.deepEqual(causes('Fix 2 bugs'), [], 'a number is a word; only the LETTER clause is about letters');
    assert.deepEqual(causes('A row is unreadable'), []);
    // The acronym exemption is for a MIXED-SCRIPT name and is spent only where caseless letter
    // words exist; a name of an acronym and numbers has nothing to excuse it.
    assert.deepEqual(causes('API 123 456'), ['shouted']);
    assert.deepEqual(causes('API GATE 2'), ['shouted']);
  });

  // A name must carry a LETTER. "No cased character" was the wrong signal for a caseless SCRIPT:
  // it exempted a name made of punctuation, digits or emoji from both shape clauses, and the kit's
  // own checkbox row (`[ ]`) walked through the bar on it.
  it('a name of punctuation, digits or emoji names nothing', async () => {
    const { nameFindings } = await load();
    const causes = (name, id = null) => nameFindings(name, id).map((finding) => finding.cause);
    assert.deepEqual(causes('[ ]', 'ROW-A'), ['no-letter']);
    assert.deepEqual(causes('123'), ['no-letter'], 'a digits-only name is not counted for words either — it has no case');
    assert.deepEqual(causes('2026-09-04'), ['no-letter']);
    assert.deepEqual(causes('\uD83D\uDE80'), ['no-letter']);
    // The clause that IS asked of a caseless script, and the one an acronym must not trip.
    assert.deepEqual(causes('\u3053\u308C\u306F API \u3092\u4F7F\u3046\u540D\u524D'), [], 'an acronym in a caseless sentence is not shouting');
  });

  // A row's own STATUS is not its name. Measured on the live corpus: this row passed the bar with
  // its own PARKED declaration as the "name" — the exact class of unreadable row the bar exists
  // for. The fixture is the WHOLE row, because judging the trimmed string is what hid the defect.
  it('a title that opens with its status is named by what follows the status, not by it', async () => {
    const { auditQueue } = await load();
    const row = '- **PARKED 2026-08-21 by AD-105 (no chain is armed here) — QUEUED 2026-08-20 — B — A-PLAN-REVIEW-CANNOT-RIDE-THE-CHAIN.** Body.';
    const [judged] = auditQueue(row).rows;
    assert.equal(judged.name, 'B', 'every leading status segment is dropped before the name is cut');
    assert.deepEqual(judged.nameFindings.map(({ cause }) => cause), ['too-few-words', 'shouted']);
    const only = auditQueue('- **STOPPED 2026-08-20 by maintainer direction. Do NOT open tranche 4.** Body.').rows[0];
    assert.deepEqual(only.nameFindings.map(({ cause }) => cause), ['absent'], 'a title that is only a status has no name at all');
  });

  // The MARKED form is the record writer's own grammar, imported rather than restated, so every id
  // `feedback-record.mjs` may legally emit round-trips through this judge.
  it('an explicitly marked id is exactly what a checked record may hand over', async () => {
    const { nameOf } = await load();
    for (const id of ['FOO', 'TASK-123', '1-TASK', '123', 'ROW-A']) {
      assert.deepEqual(nameOf(`A plain sentence lives here — id ${id}`), { name: 'A plain sentence lives here', id });
    }
    // The marker is read where the row PRESENTS it, never inside a claim: an `id` mid-sentence is
    // part of what the row SAYS, and reading it took a claim's own words for the row's key.
    assert.deepEqual(
      nameOf('Preserve id TASK-123 in output — id ROW-A'),
      { name: 'Preserve id TASK-123 in output', id: 'ROW-A' },
    );
  });

  // The colon form is a LABEL form: nothing carrying a letter may precede it in that segment, or a
  // row that merely CITES a sibling loses its name to the citation.
  it('a colon-labelled id is a label, never a cross-reference inside a sentence', async () => {
    const { nameOf } = await load();
    const cited = 'See also FIRST-TIME-CORRECTNESS: this row waits on it';
    assert.deepEqual(nameOf(cited), { name: cited, id: null });
    assert.deepEqual(nameOf('WORKFLOW-RETRO: the agent analyses the workflow'), { name: '', id: 'WORKFLOW-RETRO' });
    // An identifier boundary before the run, so a longer token is never split into prefix + id,
    // and only WHITESPACE and PUNCTUATION may lead the label — a digits prefix cut a readable
    // sentence down to `123`.
    assert.deepEqual(nameOf('123-ROW-A: the claim'), { name: '123-ROW-A: the claim', id: null });
    const numbered = '123 ROW-A: the claim remains readable';
    assert.deepEqual(nameOf(numbered), { name: numbered, id: null });
  });

  // spec:queue-row-name/S6
  it('accepts lower-case Greek and a caseless script that writes no spaces at all', async () => {
    const { nameFindings } = await load();
    assert.deepEqual(nameFindings('\u03B1\u03C5\u03C4\u03AE \u03B5\u03AF\u03BD\u03B1\u03B9 \u03BC\u03B9\u03B1 \u03C0\u03C1\u03CC\u03C4\u03B1\u03C3\u03B7', null), []);
    // Both shape clauses are asked ONLY of a name that HAS case, so a caseless writing system is
    // never counted — the verdict does not depend on the host's word-segmentation data.
    assert.deepEqual(nameFindings('\u3053\u308C\u306F\u8AAD\u307F\u3084\u3059\u3044\u540D\u524D\u3067\u3059', null), []);
  });
});
